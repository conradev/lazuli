#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  validateMachineEvidenceV1Envelope,
  validateMachineEvidenceV1PublicationEnvelope,
  validateMachineEvidenceV1Transition,
} from "./resident_machine_evidence_v1.mjs";

export const FIRST_FRAME_REPORT_SCHEMA =
  "lazuli-rust-resident-first-visible-xfb-evidence-v1";
const FIDELITY_EVIDENCE_LOCK_SCHEMA =
  "lazuli-resident-renderer-fidelity-evidence-lock-v2";
const PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA =
  "lazuli-resident-renderer-fidelity-evidence-lock-v3";
const FIDELITY_CHECKPOINT_SCHEMA =
  "lazuli-resident-renderer-fidelity-checkpoint-v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const UINT32_MAX = 0xffff_ffff;
const EXPECTED_CORPUS_SHA256 =
  "43597e441ab8c38adb18beed8ac34895a8496cac8ac2112ef4cb27c7504f4fc6";

const EXPECTED_ARTIFACTS = Object.freeze({
  "browser_machine.wasm": Object.freeze({
    bytes: 14_945_876,
    sha256: "e7249e3ccf22d5321cc8f90d2f8f1b9a3f695eefe6e3d66cb29c15bfad7d7de0",
  }),
  "browser_renderer.js": Object.freeze({
    bytes: 81_486,
    sha256: "83cb322bb7d02e8062a7bb8804d76c94adc45c193950837f342444d9c6fb327d",
  }),
  "browser_renderer_bg.wasm": Object.freeze({
    bytes: 866_635,
    sha256: "94cdf5ecfc8665af81208bf96dce7f1b1d640526139eb9efa6b7d520e4104b9c",
  }),
  "core_run_coordinator.wasm": Object.freeze({
    bytes: 362,
    sha256: "e0e22adfecbeb4e07b9fdd7c55c35edb3d9512b9e78a87dec52304cf6463a183",
  }),
  "resident_dispatcher.wasm": Object.freeze({
    bytes: 361_408,
    sha256: "a6c963bab8b9591315dbb94ea6ba6085bd57870fdde933894fba6fb4af43abbe",
  }),
});

const EXPECTED_GAMES = Object.freeze({
  "warioware-usa": Object.freeze({
    priority: 1,
    bytes: 889_225_792,
    sha256: "b8c33924afed0fec165afc3fe0d6e8dddfcdef53842fcae180560b3b904b4a81",
  }),
  "luigis-mansion-usa": Object.freeze({
    priority: 2,
    bytes: 199_262_784,
    sha256: "a868fd4bcf4d304aae74fb32ddb067e605d64db35e035c248a630d05a7d8ac4f",
  }),
  "wind-waker-usa": Object.freeze({
    priority: 3,
    bytes: 1_088_455_232,
    sha256: "677726191ba8cc0829e9baa731c14eeff95ba399e1fe40a4f2473e7b8e0c80ac",
  }),
  "melee-usa-rev-2": Object.freeze({
    priority: 4,
    bytes: 1_449_165_376,
    sha256: "b7de482eb955c8a96b6746dfa043b69ae7bf6c7c2a09ac382b9da126faa7055c",
  }),
  "f-zero-gx-usa": Object.freeze({
    priority: 5,
    bytes: 1_438_679_616,
    sha256: "3d45ca0cdd5ed408c4dd417bc0a1691ef48b7d59fab123963bd9e934be6ee91e",
  }),
  "metroid-prime-usa-rev-2": Object.freeze({
    priority: 6,
    bytes: 1_344_307_776,
    sha256: "f168d1da2ab7055c1b7fa4976c69d93c17a59057dfca936871a6539958825ffd",
  }),
  "rogue-leader-usa": Object.freeze({
    priority: 7,
    bytes: 1_400_930_880,
    sha256: "f045960fc62aa885b05cb7eb725436cfbbb17221e38b0f7e8fadb8408e710686",
  }),
});

const EXPECTED_BOOT_BY_GAME_KEY = Object.freeze({
  "warioware-usa": Object.freeze({
    identifier: "GZWE01", revision: 0, discNumber: 0, format: 1,
    logicalBytes: "1459978240",
  }),
  "luigis-mansion-usa": Object.freeze({
    identifier: "GLME01", revision: 0, discNumber: 0, format: 1,
    logicalBytes: "1459978240",
  }),
  "wind-waker-usa": Object.freeze({
    identifier: "GZLE01", revision: 0, discNumber: 0, format: 1,
    logicalBytes: "1459978240",
  }),
  "melee-usa-rev-2": Object.freeze({
    identifier: "GALE01", revision: 2, discNumber: 0, format: 1,
    logicalBytes: "1459978240",
  }),
  "f-zero-gx-usa": Object.freeze({
    identifier: "GFZE01", revision: 0, discNumber: 0, format: 1,
    logicalBytes: "1459978240",
  }),
  "metroid-prime-usa-rev-2": Object.freeze({
    identifier: "GM8E01", revision: 2, discNumber: 0, format: 1,
    logicalBytes: "1459978240",
  }),
  "rogue-leader-usa": Object.freeze({
    identifier: "GSWE64", revision: 0, discNumber: 0, format: 1,
    logicalBytes: "1459978240",
  }),
});

export const FIRST_FRAME_CAPTURE_ORDER = Object.freeze([
  "opaque-request-copied-and-hashed",
  "pre-submit-durable",
  "submit-resident-render-returned",
  "submit-returned-durable",
  "submit-resident-render-resolved",
  "receipt-resolved-durable",
  "first-presented-xfb-transition",
  "renderer-diagnostics-before-capture",
  "renderer-drain-resolved",
  "renderer-health-checked-before-readback",
  "presented-xfb-rgba-readback-resolved",
  "renderer-health-checked-after-readback",
  "renderer-diagnostics-after-capture",
  "opaque-receipt-and-rgba-hashed",
  "opaque-receipt-posted-to-worker",
  "enclosing-resident-run-result-accepted",
]);
export const PRODUCTION_FIRST_FRAME_CAPTURE_ORDER = Object.freeze([
  ...FIRST_FRAME_CAPTURE_ORDER.slice(0, 14),
  "first-frame-renderer-owned-durable",
  ...FIRST_FRAME_CAPTURE_ORDER.slice(14),
]);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function exact(actual, expected, path) {
  if (actual !== expected) {
    fail(path, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function exactKeys(value, expected, path) {
  const keys = Object.keys(object(value, path)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) {
    fail(path, `expected exact keys ${JSON.stringify(wanted)}, got ${JSON.stringify(keys)}`);
  }
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(path, "expected a non-empty trimmed string");
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(path, "expected a lowercase SHA-256 digest");
  }
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, "expected a non-negative integer");
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(path, "expected a positive integer");
  return value;
}

function finiteNonNegative(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(path, "expected a finite non-negative number");
  }
  return value;
}

function derivedRate(value, counter, wallMs, path) {
  const actual = finiteNonNegative(value, path);
  const expected = Number(counter) / (wallMs / 1_000);
  if (!Number.isFinite(expected)) fail(path, "derived rate was not finite");
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9);
  if (Math.abs(actual - expected) > tolerance) {
    fail(path, `did not match exact counter/wall derivation ${expected}`);
  }
  return actual;
}

function positiveDecimal(value, path, maximum = 1_000_000_000_000n) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    fail(path, "expected an unsigned decimal string");
  }
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > maximum) fail(path, `expected 1 through ${maximum}`);
  return parsed;
}

function zeroFields(value, fields, path) {
  const record = object(value, path);
  for (const field of fields) exact(record[field], 0, `${path}.${field}`);
}

const ADAPTER_DIAGNOSTIC_FIELDS = Object.freeze([
  "booted",
  "memoryPages",
  "totalBootReads",
  "totalDiReads",
  "totalRenderCalls",
  "totalColdInstalls",
  "pendingControllerSample",
  "totalControllerRetries",
  "tableSlots",
  "machineEvidence",
]);

function validateAdapterDiagnostics(value, path, expectedBoot) {
  const diagnostics = object(value, path);
  exactKeys(diagnostics, ADAPTER_DIAGNOSTIC_FIELDS, path);
  if (typeof diagnostics.booted !== "boolean") fail(`${path}.booted`, "expected boolean");
  positiveInteger(diagnostics.memoryPages, `${path}.memoryPages`);
  if (diagnostics.memoryPages > 2_048) fail(`${path}.memoryPages`, "exceeded resident ceiling");
  for (const field of [
    "totalBootReads",
    "totalDiReads",
    "totalRenderCalls",
    "totalColdInstalls",
    "totalControllerRetries",
    "tableSlots",
  ]) nonNegativeInteger(diagnostics[field], `${path}.${field}`);
  if (typeof diagnostics.pendingControllerSample !== "boolean") {
    fail(`${path}.pendingControllerSample`, "expected boolean");
  }
  return {
    diagnostics,
    machineEvidence: validateMachineEvidenceV1Envelope(
      diagnostics.machineEvidence,
      { path: `${path}.machineEvidence`, expectedBoot },
    ),
  };
}

function validateExpectedArtifacts(value, path) {
  const records = object(value, path);
  exactKeys(records, Object.keys(EXPECTED_ARTIFACTS), path);
  for (const name of Object.keys(EXPECTED_ARTIFACTS)) {
    const recordPath = `${path}.${name}`;
    const record = object(records[name], recordPath);
    exactKeys(record, ["bytes", "sha256"], recordPath);
    positiveInteger(record.bytes, `${recordPath}.bytes`);
    sha256(record.sha256, `${recordPath}.sha256`);
  }
  return records;
}

function validateArtifacts(value, expectedArtifacts = EXPECTED_ARTIFACTS) {
  validateExpectedArtifacts(expectedArtifacts, "$.validationOptions.expectedArtifacts");
  const manifest = object(value, "$.artifacts");
  exact(manifest.schema, "lazuli-resident-corpus-artifacts-v1", "$.artifacts.schema");
  const records = object(manifest.artifacts, "$.artifacts.artifacts");
  exactKeys(records, Object.keys(expectedArtifacts), "$.artifacts.artifacts");
  for (const [name, expected] of Object.entries(expectedArtifacts)) {
    const record = object(records[name], `$.artifacts.artifacts.${name}`);
    exactKeys(record, ["bytes", "sha256"], `$.artifacts.artifacts.${name}`);
    exact(record.bytes, expected.bytes, `$.artifacts.artifacts.${name}.bytes`);
    exact(record.sha256, expected.sha256, `$.artifacts.artifacts.${name}.sha256`);
  }
}

function validatePolicy(value) {
  const policy = object(value, "$.policy");
  exactKeys(policy, [
    "transport",
    "evidenceMode",
    "instructionUpperCap",
    "executedCycleUpperCap",
    "sliceCycleUpperCap",
    "blockUpperCap",
    "totalHostCallCap",
    "totalColdInstallCap",
    "maxBootReads",
    "bootTimeoutMs",
    "sliceTimeoutMs",
    "runTimeoutMs",
    "zeroProgressSliceCap",
  ], "$.policy");
  exact(policy.transport, "frozen-resident-machine-worker", "$.policy.transport");
  exact(
    policy.evidenceMode,
    "first-renderer-owned-presented-xfb",
    "$.policy.evidenceMode",
  );
  const instructionCap = positiveDecimal(policy.instructionUpperCap, "$.policy.instructionUpperCap");
  const cycleCap = positiveDecimal(policy.executedCycleUpperCap, "$.policy.executedCycleUpperCap");
  const sliceCap = positiveDecimal(policy.sliceCycleUpperCap, "$.policy.sliceCycleUpperCap", 1_000_000n);
  if (sliceCap > cycleCap) fail("$.policy.sliceCycleUpperCap", "cannot exceed total cycle cap");
  const bounded = [
    ["blockUpperCap", 1, 16_384],
    ["totalHostCallCap", 1, 65_535],
    ["totalColdInstallCap", 1, 65_535],
    ["maxBootReads", 1, 65_535],
    ["bootTimeoutMs", 1_000, 600_000],
    ["sliceTimeoutMs", 1_000, 600_000],
    ["runTimeoutMs", 1_000, 1_800_000],
    ["zeroProgressSliceCap", 1, 65_535],
  ];
  for (const [field, minimum, maximum] of bounded) {
    const actual = positiveInteger(policy[field], `$.policy.${field}`);
    if (actual < minimum || actual > maximum) {
      fail(`$.policy.${field}`, `expected ${minimum} through ${maximum}`);
    }
  }
  return { policy, instructionCap, cycleCap };
}

function validateTransport(value, game, bootReads, diReads) {
  const transport = object(value, "$.game.transport");
  exactKeys(transport, ["before", "after", "snapshotUnavailable"], "$.game.transport");
  exact(transport.snapshotUnavailable, false, "$.game.transport.snapshotUnavailable");
  const fields = [
    "gameKey",
    "invalidRangeRequests",
    "physicalReadBytes",
    "physicalReadRequests",
    "preconditionFailures",
    "schema",
  ];
  const before = object(transport.before, "$.game.transport.before");
  const after = object(transport.after, "$.game.transport.after");
  exactKeys(before, fields, "$.game.transport.before");
  exactKeys(after, fields, "$.game.transport.after");
  for (const [name, snapshot] of [["before", before], ["after", after]]) {
    exact(snapshot.schema, "lazuli-resident-opaque-transport-v1", `$.game.transport.${name}.schema`);
    exact(snapshot.gameKey, game.key, `$.game.transport.${name}.gameKey`);
    for (const field of [
      "invalidRangeRequests",
      "physicalReadBytes",
      "physicalReadRequests",
      "preconditionFailures",
    ]) {
      nonNegativeInteger(snapshot[field], `$.game.transport.${name}.${field}`);
      if (after[field] < before[field]) fail(`$.game.transport.${field}`, "counter regressed");
    }
  }
  exact(
    after.physicalReadRequests - before.physicalReadRequests,
    1 + bootReads + diReads,
    "$.game.transport physical-read delta",
  );
  if (after.physicalReadBytes <= before.physicalReadBytes) {
    fail("$.game.transport physical-byte delta", "expected positive raw physical reads");
  }
  exact(after.invalidRangeRequests, before.invalidRangeRequests, "$.game.transport.invalidRangeRequests");
  exact(after.preconditionFailures, before.preconditionFailures, "$.game.transport.preconditionFailures");
}

function validateDiagnosticsDelta(before, after) {
  object(before, "$.game.firstPresentedXfb.diagnosticsBefore");
  object(after, "$.game.firstPresentedXfb.diagnosticsAfter");
  for (const field of ["drainCalls", "checkHealthCalls", "wasmBridgeCalls"]) {
    nonNegativeInteger(before[field], `$.game.firstPresentedXfb.diagnosticsBefore.${field}`);
    nonNegativeInteger(after[field], `$.game.firstPresentedXfb.diagnosticsAfter.${field}`);
  }
  exact(
    after.drainCalls,
    before.drainCalls + 1,
    "$.game.firstPresentedXfb diagnostics drain delta",
  );
  exact(
    after.checkHealthCalls,
    before.checkHealthCalls + 2,
    "$.game.firstPresentedXfb diagnostics health delta",
  );
  exact(
    after.wasmBridgeCalls,
    before.wasmBridgeCalls + 3,
    "$.game.firstPresentedXfb diagnostics bridge delta",
  );
}

function validateFirstFrame(value, rendererCalls, captureOrder) {
  const frame = object(value, "$.game.firstPresentedXfb");
  const trigger = object(frame.trigger, "$.game.firstPresentedXfb.trigger");
  positiveInteger(trigger.relayRequestId, "$.game.firstPresentedXfb.trigger.relayRequestId");
  const ordinal = positiveInteger(
    trigger.renderCallOrdinal,
    "$.game.firstPresentedXfb.trigger.renderCallOrdinal",
  );
  if (ordinal > rendererCalls) fail("$.game.firstPresentedXfb.trigger.renderCallOrdinal", "exceeds relayed calls");
  for (const field of ["requestFlags", "sequenceLo", "sequenceHi"]) {
    const number = nonNegativeInteger(trigger[field], `$.game.firstPresentedXfb.trigger.${field}`);
    if (number > UINT32_MAX) fail(`$.game.firstPresentedXfb.trigger.${field}`, "expected uint32");
  }
  positiveInteger(trigger.opaqueRequestBytes, "$.game.firstPresentedXfb.trigger.opaqueRequestBytes");
  sha256(trigger.opaqueRequestSha256, "$.game.firstPresentedXfb.trigger.opaqueRequestSha256");

  const transition = object(frame.transition, "$.game.firstPresentedXfb.transition");
  exactKeys(
    transition,
    ["definition", "beforeCall", "afterReturn", "byResolution"],
    "$.game.firstPresentedXfb.transition",
  );
  exact(
    transition.definition,
    "false-before-call-to-true-by-resolution",
    "$.game.firstPresentedXfb.transition.definition",
  );
  exact(transition.beforeCall, false, "$.game.firstPresentedXfb.transition.beforeCall");
  if (typeof transition.afterReturn !== "boolean") {
    fail("$.game.firstPresentedXfb.transition.afterReturn", "expected boolean");
  }
  exact(transition.byResolution, true, "$.game.firstPresentedXfb.transition.byResolution");
  const order = array(frame.captureOrder, "$.game.firstPresentedXfb.captureOrder");
  exact(JSON.stringify(order), JSON.stringify(captureOrder), "$.game.firstPresentedXfb.captureOrder");
  const started = finiteNonNegative(
    frame.captureStartedAtMs,
    "$.game.firstPresentedXfb.captureStartedAtMs",
  );
  const completed = finiteNonNegative(
    frame.captureCompletedAtMs,
    "$.game.firstPresentedXfb.captureCompletedAtMs",
  );
  if (completed < started) fail("$.game.firstPresentedXfb.captureCompletedAtMs", "precedes capture start");
  validateDiagnosticsDelta(frame.diagnosticsBefore, frame.diagnosticsAfter);

  const readback = object(frame.readback, "$.game.firstPresentedXfb.readback");
  exactKeys(readback, ["metadata", "rgbaBytes", "rgbaSha256"], "$.game.firstPresentedXfb.readback");
  const metadata = object(readback.metadata, "$.game.firstPresentedXfb.readback.metadata");
  exact(metadata.format, "rgba8unorm", "$.game.firstPresentedXfb.readback.metadata.format");
  exact(
    metadata.layout,
    "top-left-row-major-tight",
    "$.game.firstPresentedXfb.readback.metadata.layout",
  );
  const width = positiveInteger(metadata.width, "$.game.firstPresentedXfb.readback.metadata.width");
  const height = positiveInteger(metadata.height, "$.game.firstPresentedXfb.readback.metadata.height");
  if (width > 16_384 || height > 16_384) fail("$.game.firstPresentedXfb.readback.metadata", "extent exceeds bound");
  exact(metadata.displayWidth, width, "$.game.firstPresentedXfb.readback.metadata.displayWidth");
  exact(metadata.displayHeight, height, "$.game.firstPresentedXfb.readback.metadata.displayHeight");
  positiveInteger(
    metadata.presentationSerial,
    "$.game.firstPresentedXfb.readback.metadata.presentationSerial",
  );
  nonNegativeInteger(metadata.pairEpoch, "$.game.firstPresentedXfb.readback.metadata.pairEpoch");
  if (!new Set(["progressive", "single-field", "interlaced"]).has(metadata.presentationMode)) {
    fail("$.game.firstPresentedXfb.readback.metadata.presentationMode", "unexpected renderer mode");
  }
  if (!new Set(["direct", "weave"]).has(metadata.scanoutPolicy)) {
    fail("$.game.firstPresentedXfb.readback.metadata.scanoutPolicy", "unexpected scanout policy");
  }
  const fields = object(metadata.fields, "$.game.firstPresentedXfb.readback.metadata.fields");
  if (!("top" in fields) && !("bottom" in fields)) {
    fail("$.game.firstPresentedXfb.readback.metadata.fields", "expected renderer field provenance");
  }
  exact(readback.rgbaBytes, width * height * 4, "$.game.firstPresentedXfb.readback.rgbaBytes");
  sha256(readback.rgbaSha256, "$.game.firstPresentedXfb.readback.rgbaSha256");

  const receipt = object(frame.receipt, "$.game.firstPresentedXfb.receipt");
  exactKeys(receipt, ["bytes", "sha256", "postedToWorker"], "$.game.firstPresentedXfb.receipt");
  positiveInteger(receipt.bytes, "$.game.firstPresentedXfb.receipt.bytes");
  sha256(receipt.sha256, "$.game.firstPresentedXfb.receipt.sha256");
  exact(receipt.postedToWorker, true, "$.game.firstPresentedXfb.receipt.postedToWorker");
  exact(frame.acceptedByRust, true, "$.game.firstPresentedXfb.acceptedByRust");
  const acceptance = object(frame.acceptance, "$.game.firstPresentedXfb.acceptance");
  positiveInteger(
    acceptance.enclosingWorkerRequestId,
    "$.game.firstPresentedXfb.acceptance.enclosingWorkerRequestId",
  );
  positiveInteger(
    acceptance.enclosingSliceOrdinal,
    "$.game.firstPresentedXfb.acceptance.enclosingSliceOrdinal",
  );
  const acceptedCalls = positiveInteger(
    acceptance.diagnosticsTotalRenderCalls,
    "$.game.firstPresentedXfb.acceptance.diagnosticsTotalRenderCalls",
  );
  if (acceptedCalls < ordinal || acceptedCalls > rendererCalls) {
    fail("$.game.firstPresentedXfb.acceptance.diagnosticsTotalRenderCalls", "does not cover trigger");
  }
  exact(
    acceptance.responseType,
    "resident-run-result",
    "$.game.firstPresentedXfb.acceptance.responseType",
  );
  return { ordinal, acceptance };
}

function validateTerminalEnvelope(
  report,
  { expectedArtifacts = EXPECTED_ARTIFACTS, expectedEvidenceLock = null } = {},
) {
  exactKeys(report, [
    "status",
    "schema",
    "proof",
    "environment",
    "policy",
    "fidelityCheckpointPolicy",
    "evidenceLock",
    "artifacts",
    "corpus",
    "game",
    "capabilityBoundary",
    "captureOrderContract",
  ], "$");
  exact(report.schema, FIRST_FRAME_REPORT_SCHEMA, "$.schema");
  nonEmptyString(report.proof, "$.proof");
  const environment = object(report.environment, "$.environment");
  exactKeys(environment, [
    "userAgent",
    "crossOriginIsolated",
    "hardwareConcurrency",
  ], "$.environment");
  nonEmptyString(environment.userAgent, "$.environment.userAgent");
  exact(environment.crossOriginIsolated, true, "$.environment.crossOriginIsolated");
  positiveInteger(environment.hardwareConcurrency, "$.environment.hardwareConcurrency");
  const { policy, instructionCap, cycleCap } = validatePolicy(report.policy);
  validateArtifacts(report.artifacts, expectedArtifacts);

  const corpus = object(report.corpus, "$.corpus");
  exactKeys(corpus, ["sourceCorpusSha256", "selectedGameKey"], "$.corpus");
  exact(corpus.sourceCorpusSha256, EXPECTED_CORPUS_SHA256, "$.corpus.sourceCorpusSha256");
  if (typeof corpus.selectedGameKey !== "string" || !KEY_PATTERN.test(corpus.selectedGameKey)) {
    fail("$.corpus.selectedGameKey", "expected a known game key");
  }
  const expectedGame = EXPECTED_GAMES[corpus.selectedGameKey];
  if (!expectedGame) fail("$.corpus.selectedGameKey", "game is outside the frozen corpus");

  const checkpoint = object(report.fidelityCheckpointPolicy, "$.fidelityCheckpointPolicy");
  exactKeys(checkpoint, [
    "schema",
    "hook",
    "opaqueProbeWords",
    "checkpointTimeoutMs",
    "checkpointRecordCap",
    "probeEventCap",
    "probeEventPerSubmissionCap",
  ], "$.fidelityCheckpointPolicy");
  exact(checkpoint.schema, FIDELITY_CHECKPOINT_SCHEMA, "$.fidelityCheckpointPolicy.schema");
  exact(
    checkpoint.hook,
    "globalThis.__lazuliResidentRenderProbe",
    "$.fidelityCheckpointPolicy.hook",
  );
  exact(checkpoint.opaqueProbeWords, 6, "$.fidelityCheckpointPolicy.opaqueProbeWords");
  exact(checkpoint.checkpointTimeoutMs, 10_000, "$.fidelityCheckpointPolicy.checkpointTimeoutMs");
  exact(checkpoint.checkpointRecordCap, 65_535, "$.fidelityCheckpointPolicy.checkpointRecordCap");
  exact(checkpoint.probeEventCap, 32_768, "$.fidelityCheckpointPolicy.probeEventCap");
  exact(
    checkpoint.probeEventPerSubmissionCap,
    402,
    "$.fidelityCheckpointPolicy.probeEventPerSubmissionCap",
  );

  const evidenceLock = object(report.evidenceLock, "$.evidenceLock");
  exactKeys(evidenceLock, ["schema", "sha256"], "$.evidenceLock");
  exact(
    evidenceLock.schema,
    expectedEvidenceLock?.schema ?? FIDELITY_EVIDENCE_LOCK_SCHEMA,
    "$.evidenceLock.schema",
  );
  sha256(evidenceLock.sha256, "$.evidenceLock.sha256");
  if (expectedEvidenceLock !== null) {
    exact(evidenceLock.sha256, expectedEvidenceLock.sha256, "$.evidenceLock.sha256");
  }
  const productionLock = evidenceLock.schema === PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA;
  const captureOrder = productionLock
    ? PRODUCTION_FIRST_FRAME_CAPTURE_ORDER
    : FIRST_FRAME_CAPTURE_ORDER;

  exact(
    JSON.stringify(report.captureOrderContract),
    JSON.stringify(captureOrder),
    "$.captureOrderContract",
  );
  const boundary = object(report.capabilityBoundary, "$.capabilityBoundary");
  for (const field of [
    "rawPhysicalRangesOnly",
    "canonicalRendererReceiptsOnly",
    "memoryViewsReacquiredByFrozenAdapterAfterAwait",
  ]) exact(boundary[field], true, `$.capabilityBoundary.${field}`);
  if (report.game?.firstPresentedXfb === null || !productionLock) {
    exact(
      boundary.rendererOwnedRgbaReadbacks,
      report.game?.firstPresentedXfb === null ? 0 : 1,
      "$.capabilityBoundary.rendererOwnedRgbaReadbacks",
    );
  } else if (!Number.isSafeInteger(boundary.rendererOwnedRgbaReadbacks)
      || boundary.rendererOwnedRgbaReadbacks < 1
      || boundary.rendererOwnedRgbaReadbacks > 2) {
    fail(
      "$.capabilityBoundary.rendererOwnedRgbaReadbacks",
      "expected one or two production prefix-owned readbacks",
    );
  }
  for (const field of [
    "rawGuestMemoryReadbacks",
    "pixelMeaningInferences",
    "inputSamples",
    "browserSemanticArguments",
    "javascriptDispatchTableSets",
    "javascriptContainerParsers",
  ]) exact(boundary[field], 0, `$.capabilityBoundary.${field}`);
  exact(boundary.rendererProbeWordsInterpreted, 0, "$.capabilityBoundary.rendererProbeWordsInterpreted");
  exact(
    boundary.rawSixU32RendererProbeRelayOnly,
    true,
    "$.capabilityBoundary.rawSixU32RendererProbeRelayOnly",
  );
  exact(
    boundary.machineEvidenceWordsInterpretedInBrowser,
    0,
    "$.capabilityBoundary.machineEvidenceWordsInterpretedInBrowser",
  );
  exact(
    boundary.opaqueMachineEvidenceTransportOnly,
    true,
    "$.capabilityBoundary.opaqueMachineEvidenceTransportOnly",
  );
  if (productionLock) {
    exact(
      boundary.rendererProbeEventsExpected,
      0,
      "$.capabilityBoundary.rendererProbeEventsExpected",
    );
    exact(
      report.game?.fidelityCheckpoints?.probeEventCount,
      0,
      "$.game.fidelityCheckpoints.probeEventCount",
    );
  }
  exactKeys(boundary, [
    "rawPhysicalRangesOnly",
    "canonicalRendererReceiptsOnly",
    "rendererOwnedRgbaReadbacks",
    "rawGuestMemoryReadbacks",
    "pixelMeaningInferences",
    "inputSamples",
    "browserSemanticArguments",
    "javascriptDispatchTableSets",
    "javascriptContainerParsers",
    "rendererProbeWordsInterpreted",
    "rawSixU32RendererProbeRelayOnly",
    "machineEvidenceWordsInterpretedInBrowser",
    "opaqueMachineEvidenceTransportOnly",
    "memoryViewsReacquiredByFrozenAdapterAfterAwait",
    ...(productionLock ? ["rendererProbeEventsExpected"] : []),
  ], "$.capabilityBoundary");
  return { policy, instructionCap, cycleCap, corpus, expectedGame, productionLock, captureOrder };
}

function validateCompleteReport(report, options) {
  exact(report.status, "complete", "$.status");
  const { policy, instructionCap, cycleCap, corpus, expectedGame, captureOrder } =
    validateTerminalEnvelope(report, options);

  const result = object(report.game, "$.game");
  exactKeys(result, [
    "status",
    "game",
    "boot",
    "run",
    "firstPresentedXfb",
    "firstTransitionCaptures",
    "adapterDiagnostics",
    "residentTotals",
    "transport",
    "renderer",
    "faults",
    "inputSamples",
    "fidelityCheckpoints",
  ], "$.game");
  exact(result.status, "complete", "$.game.status");
  const game = object(result.game, "$.game.game");
  exactKeys(game, ["key", "priority", "bytes", "sha256"], "$.game.game");
  exact(game.key, corpus.selectedGameKey, "$.game.game.key");
  exact(game.priority, expectedGame.priority, "$.game.game.priority");
  exact(game.bytes, expectedGame.bytes, "$.game.game.bytes");
  exact(game.sha256, expectedGame.sha256, "$.game.game.sha256");
  const expectedBoot = EXPECTED_BOOT_BY_GAME_KEY[game.key];

  const boot = object(result.boot, "$.game.boot");
  exactKeys(boot, ["status", "reads", "wallMs"], "$.game.boot");
  exact(boot.status, 3, "$.game.boot.status");
  const bootReads = positiveInteger(boot.reads, "$.game.boot.reads");
  const bootWallMs = finiteNonNegative(boot.wallMs, "$.game.boot.wallMs");
  if (bootWallMs <= 0 || bootWallMs > policy.bootTimeoutMs) {
    fail("$.game.boot.wallMs", "boot completed outside the fixed wall bound");
  }
  if (bootReads > policy.maxBootReads) fail("$.game.boot.reads", "exceeded boot read cap");

  const run = object(result.run, "$.game.run");
  exactKeys(run, [
    "wallMs",
    "slices",
    "rustBoundaries",
    "rustStopBoundaries",
    "instructionCapBoundaries",
    "executedCycleCapBoundaries",
    "hostCallCapBoundaries",
    "coldInstallCapBoundaries",
    "workerTimeoutBoundaries",
    "zeroProgressCapBoundaries",
    "zeroProgressSlices",
    "consecutiveZeroProgressSlices",
    "maximumConsecutiveZeroProgressSlices",
    "servicedHostCalls",
    "coldInstalls",
    "executedCycles",
    "executedInstructions",
    "outcomeDetails",
    "complete",
    "goalReached",
    "instructionUpperCap",
    "executedCycleUpperCap",
    "instructionsPerSecond",
    "cyclesPerSecond",
  ], "$.game.run");
  exact(run.complete, true, "$.game.run.complete");
  exact(run.goalReached, true, "$.game.run.goalReached");
  const runInstructions = positiveDecimal(run.executedInstructions, "$.game.run.executedInstructions");
  const runCycles = positiveDecimal(run.executedCycles, "$.game.run.executedCycles");
  exact(run.instructionUpperCap, policy.instructionUpperCap, "$.game.run.instructionUpperCap");
  exact(run.executedCycleUpperCap, policy.executedCycleUpperCap, "$.game.run.executedCycleUpperCap");
  if (runInstructions > instructionCap) fail("$.game.run.executedInstructions", "exceeded fixed cap");
  if (runCycles > cycleCap) fail("$.game.run.executedCycles", "exceeded fixed cap");
  const runWallMs = finiteNonNegative(run.wallMs, "$.game.run.wallMs");
  if (runWallMs <= 0 || runWallMs > policy.runTimeoutMs) {
    fail("$.game.run.wallMs", "run completed outside the fixed wall bound");
  }
  const slices = positiveInteger(run.slices, "$.game.run.slices");
  exact(run.rustBoundaries, slices, "$.game.run.rustBoundaries");
  zeroFields(run, [
    "rustStopBoundaries",
    "instructionCapBoundaries",
    "executedCycleCapBoundaries",
    "hostCallCapBoundaries",
    "coldInstallCapBoundaries",
    "workerTimeoutBoundaries",
    "zeroProgressCapBoundaries",
  ], "$.game.run boundary projection");
  const zeroSlices = nonNegativeInteger(run.zeroProgressSlices, "$.game.run.zeroProgressSlices");
  if (zeroSlices > slices) fail("$.game.run.zeroProgressSlices", "exceeds slice count");
  const maximumZero = nonNegativeInteger(
    run.maximumConsecutiveZeroProgressSlices,
    "$.game.run.maximumConsecutiveZeroProgressSlices",
  );
  if (maximumZero >= policy.zeroProgressSliceCap) {
    fail("$.game.run.maximumConsecutiveZeroProgressSlices", "reached zero-progress cap");
  }
  nonNegativeInteger(
    run.consecutiveZeroProgressSlices,
    "$.game.run.consecutiveZeroProgressSlices",
  );
  const hostCalls = positiveInteger(run.servicedHostCalls, "$.game.run.servicedHostCalls");
  const coldInstalls = nonNegativeInteger(run.coldInstalls, "$.game.run.coldInstalls");
  if (hostCalls > policy.totalHostCallCap) fail("$.game.run.servicedHostCalls", "exceeded host cap");
  if (coldInstalls > policy.totalColdInstallCap) fail("$.game.run.coldInstalls", "exceeded cold cap");
  const details = object(run.outcomeDetails, "$.game.run.outcomeDetails");
  exactKeys(details, ["0"], "$.game.run.outcomeDetails");
  exact(details["0"], slices, "$.game.run.outcomeDetails.0");
  derivedRate(
    run.instructionsPerSecond,
    runInstructions,
    runWallMs,
    "$.game.run.instructionsPerSecond",
  );
  derivedRate(run.cyclesPerSecond, runCycles, runWallMs, "$.game.run.cyclesPerSecond");

  exact(result.firstTransitionCaptures, 1, "$.game.firstTransitionCaptures");
  const renderer = object(result.renderer, "$.game.renderer");
  exactKeys(renderer, [
    "resetBeforeGame",
    "diagnosticsResetBeforeGame",
    "calls",
    "failures",
    "before",
    "after",
  ], "$.game.renderer");
  exact(renderer.resetBeforeGame, true, "$.game.renderer.resetBeforeGame");
  exact(renderer.diagnosticsResetBeforeGame, true, "$.game.renderer.diagnosticsResetBeforeGame");
  const rendererCalls = positiveInteger(renderer.calls, "$.game.renderer.calls");
  exact(renderer.failures, 0, "$.game.renderer.failures");
  object(renderer.before, "$.game.renderer.before");
  object(renderer.after, "$.game.renderer.after");
  validateFirstFrame(result.firstPresentedXfb, rendererCalls, captureOrder);

  const diagnostics = object(result.adapterDiagnostics, "$.game.adapterDiagnostics");
  exactKeys(diagnostics, ["ready", "final"], "$.game.adapterDiagnostics");
  const readyValidated = validateAdapterDiagnostics(
    diagnostics.ready,
    "$.game.adapterDiagnostics.ready",
    expectedBoot,
  );
  const finalValidated = validateAdapterDiagnostics(
    diagnostics.final,
    "$.game.adapterDiagnostics.final",
    expectedBoot,
  );
  const ready = readyValidated.diagnostics;
  const final = finalValidated.diagnostics;
  exact(ready.booted, true, "$.game.adapterDiagnostics.ready.booted");
  exact(final.booted, true, "$.game.adapterDiagnostics.final.booted");
  const machineEvidence = validateMachineEvidenceV1Transition(
    ready.machineEvidence,
    final.machineEvidence,
    {
      beforePath: "$.game.adapterDiagnostics.ready.machineEvidence",
      afterPath: "$.game.adapterDiagnostics.final.machineEvidence",
      expectedBoot,
    },
  );
  const publishableMachineEvidence = validateMachineEvidenceV1PublicationEnvelope(
    final.machineEvidence,
    {
      path: "$.game.adapterDiagnostics.final.machineEvidence",
      expectedBoot,
    },
  );
  exact(
    machineEvidence.deltas.canonicalCycle,
    run.executedCycles,
    "$.game machine-evidence canonical-cycle delta",
  );
  exact(
    machineEvidence.deltas.executedCycles,
    run.executedCycles,
    "$.game machine-evidence executed-cycle delta",
  );
  exact(
    machineEvidence.deltas.executedInstructions,
    run.executedInstructions,
    "$.game machine-evidence executed-instruction delta",
  );
  exact(
    machineEvidence.deltas.completedOuterSlices,
    String(slices),
    "$.game machine-evidence outer-slice delta",
  );
  exact(
    machineEvidence.after.gx.renderer.renderRequestsIssued,
    String(rendererCalls),
    "$.game machine-evidence renderer requests",
  );
  exact(
    machineEvidence.after.gx.renderer.renderCompletionsAuthenticated,
    String(rendererCalls),
    "$.game machine-evidence renderer completions",
  );
  exact(
    machineEvidence.after.vi.hasAuthenticatedChronology,
    true,
    "$.game machine-evidence VI chronology",
  );
  exact(
    machineEvidence.after.vi.chronology.presentationStatus,
    "presented",
    "$.game machine-evidence presentation status",
  );
  exact(
    machineEvidence.before.di.rawDiskReads,
    String(ready.totalBootReads),
    "$.game ready machine-evidence raw disk reads",
  );
  exact(
    publishableMachineEvidence.di.rawDiskReads,
    String(final.totalBootReads + final.totalDiReads),
    "$.game final machine-evidence raw disk reads",
  );
  exact(
    publishableMachineEvidence.di.hostReceiptsSucceeded,
    String(final.totalDiReads),
    "$.game final machine-evidence DI host receipts succeeded",
  );
  exact(
    publishableMachineEvidence.di.physicalHostRequestsIssued,
    (
      BigInt(publishableMachineEvidence.di.hostReceiptsSucceeded)
      + BigInt(publishableMachineEvidence.di.physicalHostRequestsCancelled)
    ).toString(),
    "$.game final machine-evidence DI issued/retired host requests",
  );
  exact(
    publishableMachineEvidence.gx.renderer.renderPending,
    0,
    "$.game final machine-evidence renderer pending",
  );
  exact(
    publishableMachineEvidence.gx.renderer.renderHighWater,
    1,
    "$.game final machine-evidence renderer high-water",
  );
  for (const [path, value] of [
    ["gxBytes", machineEvidence.before.gx.gxBytes],
    ["gxDrains", machineEvidence.before.gx.gxDrains],
    ["gxCommands", machineEvidence.before.gx.gxCommands],
    ["gxPrimitives", machineEvidence.before.gx.gxPrimitives],
    ["xfbCopies", machineEvidence.before.gx.xfbCopies],
    ["presentedFrames", machineEvidence.before.gx.presentedFrames],
    [
      "renderer.renderRequestsIssued",
      machineEvidence.before.gx.renderer.renderRequestsIssued,
    ],
    [
      "renderer.renderCompletionsAuthenticated",
      machineEvidence.before.gx.renderer.renderCompletionsAuthenticated,
    ],
  ]) exact(value, "0", `$.game ready machine-evidence ${path}`);
  const totals = object(result.residentTotals, "$.game.residentTotals");
  exactKeys(totals, [
    "bootPhysicalReads",
    "diPhysicalReads",
    "coldInstalls",
    "renderCalls",
  ], "$.game.residentTotals");
  exact(totals.bootPhysicalReads, bootReads, "$.game.residentTotals.bootPhysicalReads");
  const diReads = nonNegativeInteger(totals.diPhysicalReads, "$.game.residentTotals.diPhysicalReads");
  exact(totals.diPhysicalReads, final.totalDiReads, "$.game resident/final DI totals");
  exact(totals.coldInstalls, final.totalColdInstalls, "$.game resident/final cold totals");
  exact(totals.renderCalls, final.totalRenderCalls, "$.game resident/final render totals");
  exact(rendererCalls, totals.renderCalls, "$.game renderer/core render totals");
  exact(ready.totalBootReads, bootReads, "$.game ready boot totals");
  exact(final.totalBootReads, bootReads, "$.game final boot totals");
  const readyDi = nonNegativeInteger(ready.totalDiReads, "$.game.adapterDiagnostics.ready.totalDiReads");
  const readyRender = nonNegativeInteger(
    ready.totalRenderCalls,
    "$.game.adapterDiagnostics.ready.totalRenderCalls",
  );
  const readyCold = nonNegativeInteger(
    ready.totalColdInstalls,
    "$.game.adapterDiagnostics.ready.totalColdInstalls",
  );
  for (const field of [
    "totalBootReads",
    "totalDiReads",
    "totalRenderCalls",
    "totalColdInstalls",
    "totalControllerRetries",
  ]) {
    if (final[field] < ready[field]) {
      fail(`$.game.adapterDiagnostics.final.${field}`, "regressed from ready diagnostics");
    }
  }
  exact(readyDi, 0, "$.game.adapterDiagnostics.ready.totalDiReads");
  exact(readyRender, 0, "$.game.adapterDiagnostics.ready.totalRenderCalls");
  exact(readyCold, 0, "$.game.adapterDiagnostics.ready.totalColdInstalls");
  exact(
    hostCalls,
    (final.totalDiReads - readyDi) + (final.totalRenderCalls - readyRender),
    "$.game run/adapter host totals",
  );
  exact(coldInstalls, final.totalColdInstalls - readyCold, "$.game run/adapter cold totals");
  validateTransport(result.transport, game, bootReads, diReads);
  const faultFields = [
    "rustStops",
    "instructionCaps",
    "executedCycleCaps",
    "hostCallCaps",
    "coldInstallCaps",
    "workerTimeouts",
    "zeroProgressCaps",
    "invalidRangeRequests",
    "preconditionFailures",
    "rendererFailures",
  ];
  exactKeys(result.faults, faultFields, "$.game.faults");
  zeroFields(result.faults, faultFields, "$.game.faults");
  exact(result.inputSamples, 0, "$.game.inputSamples");
  validateCheckpointClientShape(result.fidelityCheckpoints, "$.game.fidelityCheckpoints");
  return machineEvidence.after;
}

function validateCheckpointClientShape(value, path) {
  const checkpoint = object(value, path);
  exactKeys(checkpoint, [
    "schema",
    "runId",
    "gameKey",
    "evidenceLockSha256",
    "recordCap",
    "probeEventCap",
    "recordCount",
    "probeEventCount",
    "probeEventPerSubmissionCap",
    "maximumProbeEventsPerSubmission",
    "probeRelayFailures",
    "kindCounts",
    "firstRecordSha256",
    "lastRecordSha256",
    "lastServerSequence",
    "openSubmission",
    "submissionReturned",
    "failure",
  ], path);
  exact(checkpoint.schema, FIDELITY_CHECKPOINT_SCHEMA, `${path}.schema`);
  return checkpoint;
}

function validateFailedReport(report, options) {
  exact(report.status, "failed", "$.status");
  const { corpus, expectedGame } = validateTerminalEnvelope(report, options);
  const result = object(report.game, "$.game");
  exactKeys(result, [
    "status",
    "game",
    "phase",
    "error",
    "boundaryEvidence",
    "boot",
    "firstPresentedXfb",
    "firstTransitionCaptures",
    "captureFailure",
    "lastAdapterDiagnostics",
    "transport",
    "renderer",
    "faults",
    "inputSamples",
    "fidelityCheckpoints",
  ], "$.game");
  exact(result.status, "failed", "$.game.status");
  const game = object(result.game, "$.game.game");
  exactKeys(game, ["key", "priority", "bytes", "sha256"], "$.game.game");
  exact(game.key, corpus.selectedGameKey, "$.game.game.key");
  exact(game.priority, expectedGame.priority, "$.game.game.priority");
  exact(game.bytes, expectedGame.bytes, "$.game.game.bytes");
  exact(game.sha256, expectedGame.sha256, "$.game.game.sha256");
  const expectedBoot = EXPECTED_BOOT_BY_GAME_KEY[game.key];
  nonEmptyString(result.phase, "$.game.phase");
  nonEmptyString(result.error, "$.game.error");
  object(result.boundaryEvidence, "$.game.boundaryEvidence");
  if (result.boot !== null) {
    const boot = object(result.boot, "$.game.boot");
    exactKeys(boot, ["status", "reads", "wallMs"], "$.game.boot");
  }
  if (result.firstPresentedXfb !== null) {
    object(result.firstPresentedXfb, "$.game.firstPresentedXfb");
  }
  nonNegativeInteger(result.firstTransitionCaptures, "$.game.firstTransitionCaptures");
  if (result.captureFailure !== null) {
    nonEmptyString(result.captureFailure, "$.game.captureFailure");
  }
  let machineEvidence = null;
  if (result.lastAdapterDiagnostics !== null) {
    const validated = validateAdapterDiagnostics(
      result.lastAdapterDiagnostics,
      "$.game.lastAdapterDiagnostics",
      expectedBoot,
    );
    machineEvidence = validated.machineEvidence;
  } else if (result.boot !== null) {
    fail(
      "$.game.lastAdapterDiagnostics",
      "successful boot requires a canonical terminal MachineEvidenceV1 snapshot",
    );
  }
  const transport = object(result.transport, "$.game.transport");
  exactKeys(transport, ["before", "after", "snapshotUnavailable"], "$.game.transport");
  if (typeof transport.snapshotUnavailable !== "boolean") {
    fail("$.game.transport.snapshotUnavailable", "expected boolean");
  }
  const renderer = object(result.renderer, "$.game.renderer");
  exactKeys(renderer, [
    "resetBeforeGame",
    "diagnosticsResetBeforeGame",
    "calls",
    "failures",
    "before",
    "after",
  ], "$.game.renderer");
  nonNegativeInteger(renderer.calls, "$.game.renderer.calls");
  nonNegativeInteger(renderer.failures, "$.game.renderer.failures");
  const faultFields = [
    "rustStops",
    "instructionCaps",
    "executedCycleCaps",
    "hostCallCaps",
    "coldInstallCaps",
    "workerTimeouts",
    "zeroProgressCaps",
    "invalidRangeRequests",
    "preconditionFailures",
    "rendererFailures",
  ];
  exactKeys(result.faults, faultFields, "$.game.faults");
  for (const field of faultFields) nonNegativeInteger(result.faults[field], `$.game.faults.${field}`);
  exact(result.inputSamples, 0, "$.game.inputSamples");
  validateCheckpointClientShape(result.fidelityCheckpoints, "$.game.fidelityCheckpoints");
  return machineEvidence;
}

export function validateResidentFirstFrameReport(value, optionsValue = {}) {
  const optionsObject = object(optionsValue, "$.validationOptions");
  for (const key of Object.keys(optionsObject)) {
    if (key !== "requireComplete"
        && key !== "expectedArtifacts"
        && key !== "expectedEvidenceLock") {
      fail(`$.validationOptions.${key}`, "unknown validation option");
    }
  }
  const requireComplete = optionsObject.requireComplete ?? false;
  const expectedArtifacts = optionsObject.expectedArtifacts ?? EXPECTED_ARTIFACTS;
  const expectedEvidenceLock = optionsObject.expectedEvidenceLock ?? null;
  if (typeof requireComplete !== "boolean") {
    fail("$.validationOptions.requireComplete", "expected boolean");
  }
  validateExpectedArtifacts(expectedArtifacts, "$.validationOptions.expectedArtifacts");
  if (expectedEvidenceLock !== null) {
    exactKeys(
      expectedEvidenceLock,
      ["schema", "sha256"],
      "$.validationOptions.expectedEvidenceLock",
    );
    nonEmptyString(expectedEvidenceLock.schema, "$.validationOptions.expectedEvidenceLock.schema");
    sha256(expectedEvidenceLock.sha256, "$.validationOptions.expectedEvidenceLock.sha256");
  }
  const options = { expectedArtifacts, expectedEvidenceLock };
  const report = object(value, "$");
  exact(report.schema, FIRST_FRAME_REPORT_SCHEMA, "$.schema");
  if (requireComplete && report.status !== "complete") fail("$.status", "expected complete");
  if (report.status === "complete") {
    validateCompleteReport(report, options);
  } else if (report.status === "failed") {
    validateFailedReport(report, options);
  } else if (report.status === "initializing") {
    exactKeys(report, ["status", "schema"], "$");
  } else if (report.status === "running") {
    exactKeys(report, ["status", "schema", "currentGame", "fidelityRunId", "phase"], "$");
    nonEmptyString(report.currentGame, "$.currentGame");
    nonEmptyString(report.fidelityRunId, "$.fidelityRunId");
    nonEmptyString(report.phase, "$.phase");
  } else {
    fail("$.status", "expected initializing, running, complete, or failed");
  }
  return report;
}

async function cli() {
  const arguments_ = process.argv.slice(2);
  const requireComplete = arguments_[0] === "--require-complete";
  const path = requireComplete ? arguments_[1] : arguments_[0];
  if (!path || arguments_.length !== (requireComplete ? 2 : 1)) {
    throw new Error("usage: resident_machine_first_frame_report.mjs [--require-complete] report.json");
  }
  const report = validateResidentFirstFrameReport(
    JSON.parse(await readFile(path, "utf8")),
    { requireComplete },
  );
  const terminalEnvelope = report.status === "complete"
    ? report.game.adapterDiagnostics.final.machineEvidence
    : report.status === "failed"
      ? report.game.lastAdapterDiagnostics?.machineEvidence ?? null
      : null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    publishable: report.status === "complete" && terminalEnvelope !== null,
    schema: report.schema,
    status: report.status,
    game: report.game?.game?.key ?? null,
    machineEvidence: terminalEnvelope === null
      ? null
      : validateMachineEvidenceV1Envelope(terminalEnvelope, {
          path: "$.game.terminalMachineEvidence",
        }),
    firstPresentedXfb: report.game?.firstPresentedXfb === null
      ? null
      : {
          rgbaSha256: report.game?.firstPresentedXfb?.readback?.rgbaSha256,
          receiptSha256: report.game?.firstPresentedXfb?.receipt?.sha256,
          acceptedByRust: report.game?.firstPresentedXfb?.acceptedByRust,
        },
  }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
