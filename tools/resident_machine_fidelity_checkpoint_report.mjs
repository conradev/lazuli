#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  expectedFidelityHostIdentitySha256,
  validateResidentFidelityEvidenceLock,
} from "./resident_machine_fidelity_lock.mjs";

const CHECKPOINT_SCHEMA = "lazuli-resident-renderer-fidelity-checkpoint-v1";
const RECORD_SCHEMA = "lazuli-resident-renderer-fidelity-durable-record-v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROBE_EVENT_UPPER_CAP = 32_768;
const PROBE_EVENT_PER_SUBMISSION_CAP = 402;
const COMMON_FIELDS = ["schema", "runId", "gameKey", "clientSequence", "kind"];
const RENDER_FIELDS = [
  "relayRequestId",
  "renderCallOrdinal",
  "requestFlags",
  "sequenceLo",
  "sequenceHi",
];
const REQUEST_FIELDS = ["opaqueRequestBytes", "opaqueRequestSha256"];
const RECEIPT_FIELDS = ["receiptBytes", "receiptSha256", "presentedAfterResolution"];
const RECEIPT_ANNOTATION_FIELDS = [
  ...RENDER_FIELDS,
  ...REQUEST_FIELDS,
  "presentedBefore",
  ...RECEIPT_FIELDS,
  "receiptRecordSha256",
];
const FIDELITY_ARTIFACT_FIELDS = [
  "gameFidelityEnvelopeBytes",
  "gameFidelityEnvelopeSha256",
  "gameFidelityOpaqueBytes",
  "gameFidelityOpaqueSha256",
  "machineEvidenceEnvelopeBytes",
  "machineEvidenceEnvelopeSha256",
  "machineEvidenceOpaqueBytes",
  "machineEvidenceOpaqueSha256",
];
const CAPTURE_RUN_POLICY_FIELDS = [
  "instructionUpperCap", "executedCycleUpperCap", "sliceCycleUpperCap", "blockUpperCap",
  "totalHostCallCap", "totalColdInstallCap", "maxBootReads", "bootTimeoutMs",
  "sliceTimeoutMs", "runTimeoutMs", "externalWallTimeoutMs", "zeroProgressSliceCap",
  "workerUrl",
];
const CAPTURE_RUN_SUMMARY_FIELDS = [
  "schema", "issuedRunCalls", "reportedExecutedCycles", "reportedExecutedInstructions",
  "reportedHostCalls", "reportedColdInstalls", "zeroProgressSlices",
  "consecutiveZeroProgressSlices", "maximumConsecutiveZeroProgressSlices",
  "operatorPublications", "witnessPublications", "elapsedWallMs", "wallTimeoutMs",
  "accepted",
];
const RECORD_FIELDS = [
  "schema",
  "serverSequence",
  "receivedAtUnixMs",
  "hostIdentitySha256",
  "evidenceLockSha256",
  "previousRecordSha256",
  "payloadSha256",
  "payload",
  "recordSha256",
];

function fail(path, message) {
  throw new Error(`invalid resident fidelity checkpoint journal at ${path}: ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function exactKeys(value, fields, path) {
  object(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    fail(path, `expected exactly ${expected.join(", ")}`);
  }
}

function positiveInteger(value, path, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(path, `expected an integer from 1 through ${maximum}`);
  }
  return value;
}

function uint32(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail(path, "expected an unsigned 32-bit integer");
  }
  return value;
}

function nonnegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, "expected a nonnegative safe integer");
  return value;
}

function unsignedDecimal(value, path) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail(path, "expected an unsigned decimal string");
  }
  return value;
}

function validateCaptureRunPolicy(value, path) {
  const policy = object(value, path);
  exactKeys(policy, CAPTURE_RUN_POLICY_FIELDS, path);
  for (const field of ["instructionUpperCap", "executedCycleUpperCap", "sliceCycleUpperCap"]) {
    unsignedDecimal(policy[field], `${path}.${field}`);
    if (BigInt(policy[field]) === 0n) fail(`${path}.${field}`, "expected positive");
  }
  for (const field of CAPTURE_RUN_POLICY_FIELDS.filter(field => ![
    "instructionUpperCap", "executedCycleUpperCap", "sliceCycleUpperCap", "workerUrl",
  ].includes(field))) positiveInteger(policy[field], `${path}.${field}`);
  if (typeof policy.workerUrl !== "string" || !policy.workerUrl.startsWith("/")) {
    fail(`${path}.workerUrl`, "expected a same-origin absolute path");
  }
  if (BigInt(policy.sliceCycleUpperCap) > BigInt(policy.executedCycleUpperCap)) {
    fail(`${path}.sliceCycleUpperCap`, "exceeded total cycle cap");
  }
  return policy;
}

function validateCaptureRunSummary(value, policy, path, accepted) {
  const summary = object(value, path);
  exactKeys(summary, CAPTURE_RUN_SUMMARY_FIELDS, path);
  if (summary.schema !== "lazuli-resident-cumulative-run-summary-v1") {
    fail(`${path}.schema`, "unexpected schema");
  }
  unsignedDecimal(summary.reportedExecutedCycles, `${path}.reportedExecutedCycles`);
  unsignedDecimal(summary.reportedExecutedInstructions, `${path}.reportedExecutedInstructions`);
  for (const field of [
    "issuedRunCalls", "reportedHostCalls", "reportedColdInstalls", "zeroProgressSlices",
    "consecutiveZeroProgressSlices", "maximumConsecutiveZeroProgressSlices",
    "operatorPublications", "witnessPublications", "elapsedWallMs",
  ]) nonnegativeInteger(summary[field], `${path}.${field}`);
  positiveInteger(summary.wallTimeoutMs, `${path}.wallTimeoutMs`);
  if (summary.accepted !== accepted) fail(`${path}.accepted`, `expected ${accepted}`);
  const wallTimeout = Math.min(policy.runTimeoutMs, policy.externalWallTimeoutMs);
  if (summary.wallTimeoutMs !== wallTimeout || summary.elapsedWallMs >= wallTimeout) {
    fail(path, "wall authority changed or exhausted");
  }
  if (
    BigInt(summary.reportedExecutedCycles) > BigInt(policy.executedCycleUpperCap)
    || BigInt(summary.reportedExecutedInstructions) > BigInt(policy.instructionUpperCap)
    || summary.reportedHostCalls > policy.totalHostCallCap
    || summary.reportedColdInstalls > policy.totalColdInstallCap
    || summary.consecutiveZeroProgressSlices >= policy.zeroProgressSliceCap
    || summary.maximumConsecutiveZeroProgressSlices >= policy.zeroProgressSliceCap
    || summary.operatorPublications > 64
    || summary.witnessPublications > 1
  ) fail(path, "exceeded frozen cumulative authority");
  return summary;
}

function sha256(value, path) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(path, "expected a lowercase SHA-256 digest");
  }
  return value;
}

export function canonicalFidelityJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalFidelityJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalFidelityJson(value[key])}`
  ).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(canonicalFidelityJson(value)).digest("hex");
}

function validateIdentity(payload, path) {
  const identity = {};
  for (const field of RENDER_FIELDS) {
    identity[field] = ["relayRequestId", "renderCallOrdinal"].includes(field)
      ? positiveInteger(payload[field], `${path}.${field}`)
      : uint32(payload[field], `${path}.${field}`);
  }
  identity.opaqueRequestBytes = positiveInteger(
    payload.opaqueRequestBytes,
    `${path}.opaqueRequestBytes`,
    64 * 1024 * 1024,
  );
  identity.opaqueRequestSha256 = sha256(
    payload.opaqueRequestSha256,
    `${path}.opaqueRequestSha256`,
  );
  if (typeof payload.presentedBefore !== "boolean") {
    fail(`${path}.presentedBefore`, "expected boolean");
  }
  identity.presentedBefore = payload.presentedBefore;
  return identity;
}

function sameIdentity(left, right) {
  return Object.keys(left).every(field => left[field] === right[field]);
}

function validateResolvedReceipt(payload, path) {
  const identity = validateIdentity(payload, path);
  identity.receiptBytes = positiveInteger(
    payload.receiptBytes,
    `${path}.receiptBytes`,
    64 * 1024 * 1024,
  );
  identity.receiptSha256 = sha256(payload.receiptSha256, `${path}.receiptSha256`);
  if (typeof payload.presentedAfterResolution !== "boolean") {
    fail(`${path}.presentedAfterResolution`, "expected boolean");
  }
  identity.presentedAfterResolution = payload.presentedAfterResolution;
  identity.receiptRecordSha256 = sha256(
    payload.receiptRecordSha256,
    `${path}.receiptRecordSha256`,
  );
  return identity;
}

function validateByteArtifact(payload, bytesField, shaField, path, maximum) {
  return {
    bytes: positiveInteger(payload[bytesField], `${path}.${bytesField}`, maximum),
    sha256: sha256(payload[shaField], `${path}.${shaField}`),
  };
}

function validateFidelityArtifacts(payload, path) {
  const gameEnvelope = validateByteArtifact(
    payload,
    "gameFidelityEnvelopeBytes",
    "gameFidelityEnvelopeSha256",
    path,
    16 * 1024,
  );
  const gameOpaque = validateByteArtifact(
    payload,
    "gameFidelityOpaqueBytes",
    "gameFidelityOpaqueSha256",
    path,
    384,
  );
  const machineEnvelope = validateByteArtifact(
    payload,
    "machineEvidenceEnvelopeBytes",
    "machineEvidenceEnvelopeSha256",
    path,
    16 * 1024,
  );
  const machineOpaque = validateByteArtifact(
    payload,
    "machineEvidenceOpaqueBytes",
    "machineEvidenceOpaqueSha256",
    path,
    816,
  );
  if (gameOpaque.bytes !== 384) fail(`${path}.gameFidelityOpaqueBytes`, "expected 384");
  if (machineOpaque.bytes !== 816) fail(`${path}.machineEvidenceOpaqueBytes`, "expected 816");
  return { gameEnvelope, gameOpaque, machineEnvelope, machineOpaque };
}

function validatePayload(payloadValue, path, state) {
  const payload = object(payloadValue, path);
  const common = [...COMMON_FIELDS];
  let identity = null;
  if (payload.kind === "pre-submit") {
    exactKeys(payload, [...common, ...RENDER_FIELDS, ...REQUEST_FIELDS, "presentedBefore"], path);
  } else if (payload.kind === "renderer-probe-event") {
    exactKeys(payload, [...common, "relayRequestId", "renderCallOrdinal", "words"], path);
  } else if (payload.kind === "submit-returned") {
    exactKeys(payload, [
      ...common,
      ...RENDER_FIELDS,
      ...REQUEST_FIELDS,
      "presentedBefore",
      "returnedPromise",
      "presentedAfterReturn",
    ], path);
  } else if (payload.kind === "receipt-resolved") {
    exactKeys(payload, [
      ...common,
      ...RENDER_FIELDS,
      ...REQUEST_FIELDS,
      "presentedBefore",
      "receiptBytes",
      "receiptSha256",
      "presentedAfterResolution",
    ], path);
  } else if (payload.kind === "capture-machine-initialized") {
    exactKeys(payload, [
      ...common,
      "machineSessionId",
      "bootStatus",
      "bootReads",
      "machineEvidenceEnvelopeBytes",
      "machineEvidenceEnvelopeSha256",
      "machineEvidenceOpaqueBytes",
      "machineEvidenceOpaqueSha256",
      "runPolicy",
      "runSummary",
    ], path);
  } else if (payload.kind === "first-frame-renderer-owned") {
    exactKeys(payload, [
      ...common,
      ...RECEIPT_ANNOTATION_FIELDS,
      "machineSessionId",
      "readbackMetadataBytes",
      "readbackMetadataSha256",
      "rgbaBytes",
      "rgbaSha256",
    ], path);
  } else if (payload.kind === "fidelity-baseline-owned") {
    exactKeys(payload, [
      ...common,
      ...RECEIPT_ANNOTATION_FIELDS,
      "machineSessionId",
      "phase",
      ...FIDELITY_ARTIFACT_FIELDS,
      "readbackMetadataBytes",
      "readbackMetadataSha256",
      "rgbaBytes",
      "rgbaSha256",
      "requestedButtons",
      "requestedStickXyCxy",
      "requestedTriggerLrab",
    ], path);
  } else if (payload.kind === "first-frame-report-bound") {
    exactKeys(payload, [
      ...common,
      "machineSessionId",
      "reportBytes",
      "reportSha256",
      "machineEvidenceEnvelopeBytes",
      "machineEvidenceEnvelopeSha256",
      "machineEvidenceOpaqueBytes",
      "machineEvidenceOpaqueSha256",
      "firstFrameRendererRecordSha256",
      "baselineRecordSha256",
    ], path);
  } else if (payload.kind === "controller-witness-published") {
    exactKeys(payload, [
      ...common,
      "machineSessionId",
      "baselineRecordSha256",
      "firstFrameReportRecordSha256",
      "sequenceLo",
      "sequenceHi",
      "buttons",
      "stickXyCxy",
      "triggerLrab",
      "status",
      "machineEvidenceEnvelopeBytes",
      "machineEvidenceEnvelopeSha256",
      "machineEvidenceOpaqueBytes",
      "machineEvidenceOpaqueSha256",
    ], path);
  } else if (payload.kind === "fidelity-accepted-owned") {
    exactKeys(payload, [
      ...common,
      ...RECEIPT_ANNOTATION_FIELDS,
      "machineSessionId",
      "phase",
      ...FIDELITY_ARTIFACT_FIELDS,
      "readbackMetadataBytes",
      "readbackMetadataSha256",
      "rgbaBytes",
      "rgbaSha256",
      "witnessRecordSha256",
    ], path);
  } else if (payload.kind === "fidelity-terminal") {
    exactKeys(payload, [
      ...common,
      "machineSessionId",
      "phase",
      "baselineRecordSha256",
      "acceptedRecordSha256",
      ...FIDELITY_ARTIFACT_FIELDS,
      "runSummary",
    ], path);
  } else {
    fail(`${path}.kind`, "unsupported checkpoint kind");
  }
  if (payload.schema !== CHECKPOINT_SCHEMA) fail(`${path}.schema`, "unexpected schema");
  if (typeof payload.runId !== "string" || !UUID_PATTERN.test(payload.runId)) {
    fail(`${path}.runId`, "expected a UUID");
  }
  if (typeof payload.gameKey !== "string" || !KEY_PATTERN.test(payload.gameKey)) {
    fail(`${path}.gameKey`, "expected lowercase kebab-case");
  }
  positiveInteger(payload.clientSequence, `${path}.clientSequence`, 65_535);

  if (state.runId === null) {
    state.runId = payload.runId;
    state.gameKey = payload.gameKey;
  } else if (payload.runId !== state.runId || payload.gameKey !== state.gameKey) {
    fail(path, "run or game identity changed");
  }
  if (payload.clientSequence !== state.clientSequence + 1) {
    fail(`${path}.clientSequence`, `expected ${state.clientSequence + 1}`);
  }

  if (state.terminalRecordSha256 !== null) fail(path, "record followed terminal fidelity boundary");

  if (payload.kind === "capture-machine-initialized") {
    if (state.capturePolicy === "forbidden") fail(path, "capture annotations are forbidden");
    if (payload.clientSequence !== 1 || state.machineSessionId !== null) {
      fail(path, "capture machine initialization must be the first checkpoint");
    }
    if (typeof payload.machineSessionId !== "string"
        || !UUID_PATTERN.test(payload.machineSessionId)) {
      fail(`${path}.machineSessionId`, "expected a UUID");
    }
    if (payload.bootStatus !== 3) fail(`${path}.bootStatus`, "expected exact complete status 3");
    const bootReads = positiveInteger(payload.bootReads, `${path}.bootReads`, 65_535);
    validateByteArtifact(
      payload,
      "machineEvidenceEnvelopeBytes",
      "machineEvidenceEnvelopeSha256",
      path,
      16 * 1024,
    );
    const readyOpaque = validateByteArtifact(
      payload,
      "machineEvidenceOpaqueBytes",
      "machineEvidenceOpaqueSha256",
      path,
      816,
    );
    if (readyOpaque.bytes !== 816) fail(`${path}.machineEvidenceOpaqueBytes`, "expected 816");
    const runPolicy = validateCaptureRunPolicy(payload.runPolicy, `${path}.runPolicy`);
    if (bootReads > runPolicy.maxBootReads) {
      fail(`${path}.bootReads`, "exceeded the locked ready boot cap");
    }
    const runSummary = validateCaptureRunSummary(
      payload.runSummary,
      runPolicy,
      `${path}.runSummary`,
      false,
    );
    if (
      runSummary.issuedRunCalls !== 0
      || runSummary.reportedExecutedCycles !== "0"
      || runSummary.reportedExecutedInstructions !== "0"
      || runSummary.reportedHostCalls !== 0
      || runSummary.reportedColdInstalls !== 0
      || runSummary.zeroProgressSlices !== 0
      || runSummary.consecutiveZeroProgressSlices !== 0
      || runSummary.maximumConsecutiveZeroProgressSlices !== 0
      || runSummary.operatorPublications !== 0
      || runSummary.witnessPublications !== 0
      || runSummary.elapsedWallMs !== 0
    ) fail(`${path}.runSummary`, "expected pristine ready ledger");
    state.machineSessionId = payload.machineSessionId;
    state.machineInitializationRecordSha256 = state.currentRecordSha256;
    state.runPolicy = structuredClone(runPolicy);
    state.initialRunSummary = structuredClone(runSummary);
  } else if (payload.kind === "pre-submit") {
    identity = validateIdentity(payload, path);
    if (state.openIdentity !== null) fail(path, "encountered an open submission");
    state.openIdentity = identity;
    state.returned = false;
    state.probeEventsThisSubmission = 0;
    state.submissions += 1;
  } else if (payload.kind === "renderer-probe-event") {
    if (state.openIdentity === null) fail(path, "probe event has no open submission");
    positiveInteger(payload.relayRequestId, `${path}.relayRequestId`);
    positiveInteger(payload.renderCallOrdinal, `${path}.renderCallOrdinal`);
    if (
      payload.relayRequestId !== state.openIdentity.relayRequestId
      || payload.renderCallOrdinal !== state.openIdentity.renderCallOrdinal
    ) fail(path, "probe correlation changed");
    if (!Array.isArray(payload.words) || payload.words.length !== 6) {
      fail(`${path}.words`, "expected exactly six opaque u32 values");
    }
    payload.words.forEach((word, index) => uint32(word, `${path}.words[${index}]`));
    state.probeEvents += 1;
    state.probeEventsThisSubmission += 1;
    state.maximumProbeEventsPerSubmission = Math.max(
      state.maximumProbeEventsPerSubmission,
      state.probeEventsThisSubmission,
    );
    if (state.probeEventsThisSubmission > PROBE_EVENT_PER_SUBMISSION_CAP) {
      fail(path, "renderer probe per-submission cap exceeded");
    }
  } else if (payload.kind === "submit-returned") {
    identity = validateIdentity(payload, path);
    if (state.openIdentity === null || state.returned) {
      fail(path, "submit-returned is out of order");
    }
    if (!sameIdentity(identity, state.openIdentity)) fail(path, "request identity changed");
    if (payload.returnedPromise !== true) fail(`${path}.returnedPromise`, "expected true");
    if (typeof payload.presentedAfterReturn !== "boolean") {
      fail(`${path}.presentedAfterReturn`, "expected boolean");
    }
    state.returned = true;
    state.submitReturns += 1;
  } else if (payload.kind === "receipt-resolved") {
    identity = validateIdentity(payload, path);
    if (state.openIdentity === null || !state.returned) {
      fail(path, "receipt-resolved is out of order");
    }
    if (!sameIdentity(identity, state.openIdentity)) fail(path, "request identity changed");
    positiveInteger(payload.receiptBytes, `${path}.receiptBytes`, 64 * 1024 * 1024);
    sha256(payload.receiptSha256, `${path}.receiptSha256`);
    if (typeof payload.presentedAfterResolution !== "boolean") {
      fail(`${path}.presentedAfterResolution`, "expected boolean");
    }
    state.receipts += 1;
    state.openIdentity = null;
    state.returned = false;
    state.lastResolvedReceipt = {
      ...identity,
      receiptBytes: payload.receiptBytes,
      receiptSha256: payload.receiptSha256,
      presentedAfterResolution: payload.presentedAfterResolution,
      receiptRecordSha256: state.currentRecordSha256,
    };
  } else if (payload.kind === "first-frame-renderer-owned") {
    if (state.capturePolicy === "forbidden") fail(path, "capture annotations are forbidden");
    if (payload.machineSessionId !== state.machineSessionId) fail(path, "machine session changed");
    if (state.firstFrameRendererRecordSha256 !== null) fail(path, "duplicate first-frame ownership");
    if (state.openIdentity !== null || state.lastResolvedReceipt === null) {
      fail(path, "first-frame ownership requires a resolved receipt and no open submission");
    }
    identity = validateResolvedReceipt(payload, path);
    if (!sameIdentity(identity, state.lastResolvedReceipt)) fail(path, "resolved receipt changed");
    if (state.currentPreviousRecordSha256 !== identity.receiptRecordSha256) {
      fail(path, "first-frame ownership did not immediately follow its receipt");
    }
    validateByteArtifact(payload, "readbackMetadataBytes", "readbackMetadataSha256", path, 1024 * 1024);
    validateByteArtifact(payload, "rgbaBytes", "rgbaSha256", path, 64 * 1024 * 1024);
    state.firstFrameRendererRecordSha256 = state.currentRecordSha256;
    state.firstFrameReceipt = identity;
    state.firstFrameReadback = {
      readbackMetadataBytes: payload.readbackMetadataBytes,
      readbackMetadataSha256: payload.readbackMetadataSha256,
      rgbaBytes: payload.rgbaBytes,
      rgbaSha256: payload.rgbaSha256,
    };
  } else if (payload.kind === "fidelity-baseline-owned"
      || payload.kind === "fidelity-accepted-owned") {
    if (state.capturePolicy === "forbidden") fail(path, "capture annotations are forbidden");
    if (payload.machineSessionId !== state.machineSessionId) fail(path, "machine session changed");
    if (state.openIdentity !== null || state.lastResolvedReceipt === null) {
      fail(path, "fidelity ownership requires a resolved receipt and no open submission");
    }
    identity = validateResolvedReceipt(payload, path);
    if (!sameIdentity(identity, state.lastResolvedReceipt)) fail(path, "resolved receipt changed");
    const baseline = payload.kind === "fidelity-baseline-owned";
    if (payload.phase !== (baseline ? 1 : 5)) fail(`${path}.phase`, "unexpected phase");
    validateFidelityArtifacts(payload, path);
    validateByteArtifact(payload, "readbackMetadataBytes", "readbackMetadataSha256", path, 1024 * 1024);
    validateByteArtifact(payload, "rgbaBytes", "rgbaSha256", path, 64 * 1024 * 1024);
    if (baseline) {
      if (state.firstFrameRendererRecordSha256 === null || state.baselineRecordSha256 !== null) {
        fail(path, "Baseline ownership cardinality/order changed");
      }
      const allowedPrevious = [identity.receiptRecordSha256];
      if (sameIdentity(identity, state.firstFrameReceipt)) {
        allowedPrevious.push(state.firstFrameRendererRecordSha256);
        const readback = {
          readbackMetadataBytes: payload.readbackMetadataBytes,
          readbackMetadataSha256: payload.readbackMetadataSha256,
          rgbaBytes: payload.rgbaBytes,
          rgbaSha256: payload.rgbaSha256,
        };
        if (canonicalFidelityJson(readback) !== canonicalFidelityJson(state.firstFrameReadback)) {
          fail(path, "same-receipt Baseline did not reuse first-frame renderer ownership");
        }
      }
      if (!allowedPrevious.includes(state.currentPreviousRecordSha256)) {
        fail(path, "Baseline ownership did not immediately annotate its receipt");
      }
      state.baselineRecordSha256 = state.currentRecordSha256;
      state.baselineReceipt = identity;
      state.baselineRequestedController = {
        buttons: uint32(payload.requestedButtons, `${path}.requestedButtons`),
        stickXyCxy: uint32(payload.requestedStickXyCxy, `${path}.requestedStickXyCxy`),
        triggerLrab: uint32(payload.requestedTriggerLrab, `${path}.requestedTriggerLrab`),
      };
    } else {
      if (state.witnessRecordSha256 === null || state.acceptedRecordSha256 !== null) {
        fail(path, "Accepted ownership cardinality/order changed");
      }
      if (payload.witnessRecordSha256 !== state.witnessRecordSha256) {
        fail(`${path}.witnessRecordSha256`, "did not join the controller witness");
      }
      if (state.currentPreviousRecordSha256 !== identity.receiptRecordSha256) {
        fail(path, "Accepted ownership did not immediately annotate its receipt");
      }
      state.acceptedRecordSha256 = state.currentRecordSha256;
      state.acceptedReceipt = identity;
      state.acceptedArtifacts = Object.fromEntries(
        FIDELITY_ARTIFACT_FIELDS.map(field => [field, payload[field]]),
      );
    }
  } else if (payload.kind === "first-frame-report-bound") {
    if (state.capturePolicy === "forbidden") fail(path, "capture annotations are forbidden");
    if (payload.machineSessionId !== state.machineSessionId) fail(path, "machine session changed");
    if (state.openIdentity !== null
        || state.firstFrameRendererRecordSha256 === null
        || state.firstFrameReportRecordSha256 !== null) {
      fail(path, "first-frame report binding cardinality/order changed");
    }
    validateByteArtifact(payload, "reportBytes", "reportSha256", path, 16 * 1024 * 1024);
    validateByteArtifact(
      payload,
      "machineEvidenceEnvelopeBytes",
      "machineEvidenceEnvelopeSha256",
      path,
      16 * 1024,
    );
    const opaque = validateByteArtifact(
      payload,
      "machineEvidenceOpaqueBytes",
      "machineEvidenceOpaqueSha256",
      path,
      816,
    );
    if (opaque.bytes !== 816) fail(`${path}.machineEvidenceOpaqueBytes`, "expected 816");
    if (payload.firstFrameRendererRecordSha256 !== state.firstFrameRendererRecordSha256) {
      fail(`${path}.firstFrameRendererRecordSha256`, "did not join first-frame ownership");
    }
    if (payload.baselineRecordSha256 !== state.baselineRecordSha256) {
      fail(`${path}.baselineRecordSha256`, "did not describe the Baseline prefix state");
    }
    state.firstFrameReportRecordSha256 = state.currentRecordSha256;
  } else if (payload.kind === "controller-witness-published") {
    if (state.capturePolicy === "forbidden") fail(path, "capture annotations are forbidden");
    if (payload.machineSessionId !== state.machineSessionId) fail(path, "machine session changed");
    if (state.openIdentity !== null
        || state.baselineRecordSha256 === null
        || state.firstFrameReportRecordSha256 === null
        || state.witnessRecordSha256 !== null) {
      fail(path, "controller witness cardinality/order changed");
    }
    if (payload.baselineRecordSha256 !== state.baselineRecordSha256
        || payload.firstFrameReportRecordSha256 !== state.firstFrameReportRecordSha256) {
      fail(path, "controller witness authority join changed");
    }
    for (const field of ["sequenceLo", "sequenceHi", "buttons", "stickXyCxy", "triggerLrab"]) {
      uint32(payload[field], `${path}.${field}`);
    }
    if (payload.buttons !== state.baselineRequestedController.buttons
        || payload.stickXyCxy !== state.baselineRequestedController.stickXyCxy
        || payload.triggerLrab !== state.baselineRequestedController.triggerLrab) {
      fail(path, "controller witness differed from the durable Rust Baseline request");
    }
    positiveInteger(payload.status, `${path}.status`, 0xffff_ffff);
    validateByteArtifact(
      payload,
      "machineEvidenceEnvelopeBytes",
      "machineEvidenceEnvelopeSha256",
      path,
      16 * 1024,
    );
    const preWitnessMachine = validateByteArtifact(
      payload,
      "machineEvidenceOpaqueBytes",
      "machineEvidenceOpaqueSha256",
      path,
      816,
    );
    if (preWitnessMachine.bytes !== 816) {
      fail(`${path}.machineEvidenceOpaqueBytes`, "expected 816");
    }
    state.witnessRecordSha256 = state.currentRecordSha256;
    state.witness = {
      sequenceLo: payload.sequenceLo,
      sequenceHi: payload.sequenceHi,
      buttons: payload.buttons,
      stickXyCxy: payload.stickXyCxy,
      triggerLrab: payload.triggerLrab,
      status: payload.status,
      machineEvidenceEnvelopeBytes: payload.machineEvidenceEnvelopeBytes,
      machineEvidenceEnvelopeSha256: payload.machineEvidenceEnvelopeSha256,
      machineEvidenceOpaqueBytes: payload.machineEvidenceOpaqueBytes,
      machineEvidenceOpaqueSha256: payload.machineEvidenceOpaqueSha256,
    };
  } else {
    if (state.capturePolicy === "forbidden") fail(path, "capture annotations are forbidden");
    if (payload.machineSessionId !== state.machineSessionId) fail(path, "machine session changed");
    if (state.openIdentity !== null || payload.phase !== 5
        || state.acceptedRecordSha256 === null) {
      fail(path, "terminal fidelity checkpoint is out of order");
    }
    if (state.terminalRecordSha256 !== null
        || state.currentPreviousRecordSha256 !== state.acceptedRecordSha256) {
      fail(path, "terminal fidelity checkpoint must immediately follow Accepted ownership");
    }
    if (payload.baselineRecordSha256 !== state.baselineRecordSha256
        || payload.acceptedRecordSha256 !== state.acceptedRecordSha256) {
      fail(path, "terminal fidelity authority join changed");
    }
    validateFidelityArtifacts(payload, path);
    for (const field of FIDELITY_ARTIFACT_FIELDS) {
      if (payload[field] !== state.acceptedArtifacts?.[field]) {
        fail(`${path}.${field}`, "differed from the hard Accepted boundary");
      }
    }
    const terminalRunSummary = validateCaptureRunSummary(
      payload.runSummary,
      state.runPolicy,
      `${path}.runSummary`,
      true,
    );
    if (terminalRunSummary.issuedRunCalls <= 0 || terminalRunSummary.witnessPublications !== 1) {
      fail(`${path}.runSummary`, "omitted run/witness authority");
    }
    state.terminalRunSummary = structuredClone(terminalRunSummary);
    state.terminalRecordSha256 = state.currentRecordSha256;
  }
  state.clientSequence = payload.clientSequence;
}

export function validateFidelityCheckpointJournal(
  recordsValue,
  {
    requireResolved = false,
    probeEventCap = PROBE_EVENT_UPPER_CAP,
    evidenceLockSha256,
    expectedHostIdentitySha256,
    probeEventPolicy = "required",
    capturePolicy = "forbidden",
  } = {},
) {
  positiveInteger(probeEventCap, "$.probeEventCap", PROBE_EVENT_UPPER_CAP);
  sha256(evidenceLockSha256, "$.evidenceLockSha256");
  sha256(expectedHostIdentitySha256, "$.expectedHostIdentitySha256");
  if (probeEventPolicy !== "required" && probeEventPolicy !== "forbidden") {
    fail("$.probeEventPolicy", "expected required or forbidden");
  }
  if (!["forbidden", "allowed", "required"].includes(capturePolicy)) {
    fail("$.capturePolicy", "expected forbidden, allowed, or required");
  }
  if (!Array.isArray(recordsValue) || recordsValue.length === 0) {
    fail("$", "expected at least one durable record");
  }
  if (recordsValue.length > 65_535) fail("$", "record cap exceeded");
  const state = {
    runId: null,
    gameKey: null,
    clientSequence: 0,
    openIdentity: null,
    returned: false,
    submissions: 0,
    submitReturns: 0,
    receipts: 0,
    probeEvents: 0,
    probeEventsThisSubmission: 0,
    maximumProbeEventsPerSubmission: 0,
    capturePolicy,
    machineSessionId: null,
    machineInitializationRecordSha256: null,
    runPolicy: null,
    initialRunSummary: null,
    currentRecordSha256: null,
    currentPreviousRecordSha256: null,
    lastResolvedReceipt: null,
    firstFrameRendererRecordSha256: null,
    firstFrameReceipt: null,
    firstFrameReadback: null,
    baselineRecordSha256: null,
    baselineReceipt: null,
    baselineRequestedController: null,
    firstFrameReportRecordSha256: null,
    witnessRecordSha256: null,
    witness: null,
    acceptedRecordSha256: null,
    acceptedReceipt: null,
    acceptedArtifacts: null,
    terminalRecordSha256: null,
    terminalRunSummary: null,
  };
  let previousRecordSha256 = null;
  let hostIdentitySha256 = null;
  let lastReceivedAtUnixMs = 0;
  for (let index = 0; index < recordsValue.length; index += 1) {
    const path = `$[${index}]`;
    const record = object(recordsValue[index], path);
    exactKeys(record, RECORD_FIELDS, path);
    if (record.schema !== RECORD_SCHEMA) fail(`${path}.schema`, "unexpected schema");
    if (record.serverSequence !== index + 1) {
      fail(`${path}.serverSequence`, `expected ${index + 1}`);
    }
    const receivedAt = positiveInteger(record.receivedAtUnixMs, `${path}.receivedAtUnixMs`);
    if (receivedAt < lastReceivedAtUnixMs) fail(`${path}.receivedAtUnixMs`, "regressed");
    lastReceivedAtUnixMs = receivedAt;
    const hostIdentity = sha256(record.hostIdentitySha256, `${path}.hostIdentitySha256`);
    hostIdentitySha256 ??= hostIdentity;
    if (hostIdentity !== hostIdentitySha256) fail(`${path}.hostIdentitySha256`, "changed");
    if (hostIdentity !== expectedHostIdentitySha256) {
      fail(`${path}.hostIdentitySha256`, "did not match immutable evidence lock");
    }
    if (record.evidenceLockSha256 !== evidenceLockSha256) {
      fail(`${path}.evidenceLockSha256`, "did not match immutable evidence lock");
    }
    if (record.previousRecordSha256 !== previousRecordSha256) {
      fail(`${path}.previousRecordSha256`, "hash chain changed");
    }
    const expectedPayloadSha = hash(record.payload);
    if (record.payloadSha256 !== expectedPayloadSha) {
      fail(`${path}.payloadSha256`, "does not authenticate payload");
    }
    sha256(record.recordSha256, `${path}.recordSha256`);
    const core = { ...record };
    delete core.recordSha256;
    if (record.recordSha256 !== hash(core)) {
      fail(`${path}.recordSha256`, "does not authenticate record");
    }
    state.currentRecordSha256 = record.recordSha256;
    state.currentPreviousRecordSha256 = record.previousRecordSha256;
    validatePayload(record.payload, `${path}.payload`, state);
    if (state.probeEvents > probeEventCap) fail(path, "renderer probe event cap exceeded");
    previousRecordSha256 = record.recordSha256;
  }
  const terminalBoundary = state.openIdentity === null
    ? "all-receipts-resolved"
    : state.returned
      ? "submit-returned-receipt-not-yet-observed"
      : "submit-method-did-not-return";
  if (probeEventPolicy === "required" && state.probeEvents === 0) {
    fail("$", "expected at least one authenticated renderer probe event");
  }
  if (probeEventPolicy === "forbidden" && state.probeEvents !== 0) {
    fail("$", "renderer probe events are forbidden by the production default-off renderer lock");
  }
  if (requireResolved && (terminalBoundary !== "all-receipts-resolved" || state.receipts === 0)) {
    fail("$", "expected at least one fully resolved renderer receipt");
  }
  if (capturePolicy === "required" && (
    state.firstFrameRendererRecordSha256 === null
    || state.machineInitializationRecordSha256 === null
    || state.baselineRecordSha256 === null
    || state.firstFrameReportRecordSha256 === null
    || state.witnessRecordSha256 === null
    || state.acceptedRecordSha256 === null
    || state.terminalRecordSha256 === null
  )) {
    fail("$", "required continuous fidelity capture checkpoints are incomplete");
  }
  const summary = {
    schema: "lazuli-resident-renderer-fidelity-checkpoint-summary-v1",
    runId: state.runId,
    gameKey: state.gameKey,
    hostIdentitySha256,
    evidenceLockSha256,
    records: recordsValue.length,
    submissions: state.submissions,
    submitReturns: state.submitReturns,
    receipts: state.receipts,
    probeEvents: state.probeEvents,
    probeEventCap,
    probeEventPerSubmissionCap: PROBE_EVENT_PER_SUBMISSION_CAP,
    maximumProbeEventsPerSubmission: state.maximumProbeEventsPerSubmission,
    terminalBoundary,
    openSubmission: state.openIdentity,
    firstRecordSha256: recordsValue[0].recordSha256,
    lastRecordSha256: previousRecordSha256,
    rendererProbeWordsInterpreted: 0,
  };
  if (capturePolicy !== "forbidden") {
    summary.capture = Object.freeze({
      policy: capturePolicy,
      machineSessionId: state.machineSessionId,
      machineInitializationRecordSha256: state.machineInitializationRecordSha256,
      firstFrameRendererRecordSha256: state.firstFrameRendererRecordSha256,
      baselineRecordSha256: state.baselineRecordSha256,
      firstFrameReportRecordSha256: state.firstFrameReportRecordSha256,
      witnessRecordSha256: state.witnessRecordSha256,
      witness: state.witness,
      acceptedRecordSha256: state.acceptedRecordSha256,
      terminalRecordSha256: state.terminalRecordSha256,
      runPolicy: state.runPolicy,
      initialRunSummary: state.initialRunSummary,
      terminalRunSummary: state.terminalRunSummary,
    });
  }
  return Object.freeze(summary);
}

export function parseFidelityCheckpointJsonl(source) {
  if (typeof source !== "string") fail("$", "expected JSONL text");
  const lines = source.split(/\r?\n/).filter(line => line.length !== 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`$[${index}]`, `invalid JSON: ${error.message ?? String(error)}`);
    }
  });
}

async function cli() {
  const arguments_ = process.argv.slice(2);
  const requireResolvedIndex = arguments_.indexOf("--require-resolved");
  const requireResolved = requireResolvedIndex !== -1;
  if (requireResolved) arguments_.splice(requireResolvedIndex, 1);
  const lockIndex = arguments_.indexOf("--evidence-lock");
  if (lockIndex === -1 || lockIndex + 1 >= arguments_.length) {
    throw new Error(
      "usage: resident_machine_fidelity_checkpoint_report.mjs "
        + "--evidence-lock lock.json [--require-resolved] checkpoints.jsonl",
    );
  }
  const lockPath = arguments_[lockIndex + 1];
  arguments_.splice(lockIndex, 2);
  if (arguments_.length !== 1) throw new Error("expected exactly one checkpoint journal path");
  const path = arguments_[0];
  const lockBytes = await readFile(lockPath);
  const lock = validateResidentFidelityEvidenceLock(JSON.parse(lockBytes));
  const evidenceLockSha256 = createHash("sha256").update(lockBytes).digest("hex");
  const records = parseFidelityCheckpointJsonl(await readFile(path, "utf8"));
  process.stdout.write(`${JSON.stringify(
    validateFidelityCheckpointJournal(records, {
      requireResolved,
      evidenceLockSha256,
      expectedHostIdentitySha256: expectedFidelityHostIdentitySha256(
        lock,
        evidenceLockSha256,
      ),
    }),
    null,
    2,
  )}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
