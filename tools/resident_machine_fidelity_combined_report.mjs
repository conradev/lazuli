#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalFidelityJson,
  parseFidelityCheckpointJsonl,
  validateFidelityCheckpointJournal,
} from "./resident_machine_fidelity_checkpoint_report.mjs";
import {
  PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA,
  expectedFidelityHostIdentitySha256,
  validateResidentFidelityEvidenceLock,
  validateResidentProductionFidelityEvidenceLock,
} from "./resident_machine_fidelity_lock.mjs";
import {
  validateResidentFirstFrameReport,
} from "./resident_machine_first_frame_report.mjs";
import {
  WARIOWARE_MACHINE_EVIDENCE_BOOT,
  validateMachineEvidenceV1PublicationEnvelope,
} from "./resident_machine_evidence_v1.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(location, message) {
  throw new Error(`invalid combined resident fidelity evidence at ${location}: ${message}`);
}

function object(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(location, "expected an object");
  }
  return value;
}

function exact(actual, expected, location) {
  if (actual !== expected) {
    fail(location, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function exactJson(actual, expected, location) {
  if (canonicalFidelityJson(actual) !== canonicalFidelityJson(expected)) {
    fail(location, "did not match lock");
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactRawBytes(value, location) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(location, "expected raw bytes");
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function positiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(location, "expected a positive integer");
  }
  return value;
}

function kindCounts(records) {
  const counts = Object.create(null);
  for (const record of records) {
    const kind = record.payload.kind;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function validateReportPolicy(report, lock) {
  const policy = object(report.policy, "$.report.policy");
  const production = lock.schema === PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA;
  const expectedRunPolicy = { ...lock.runPolicy };
  delete expectedRunPolicy.workerUrl;
  const actualRunPolicy = {
    instructionUpperCap: policy.instructionUpperCap,
    executedCycleUpperCap: policy.executedCycleUpperCap,
    sliceCycleUpperCap: policy.sliceCycleUpperCap,
    blockUpperCap: policy.blockUpperCap,
    totalHostCallCap: policy.totalHostCallCap,
    totalColdInstallCap: policy.totalColdInstallCap,
    maxBootReads: policy.maxBootReads,
    bootTimeoutMs: policy.bootTimeoutMs,
    sliceTimeoutMs: policy.sliceTimeoutMs,
    runTimeoutMs: policy.runTimeoutMs,
    externalWallTimeoutMs: policy.externalWallTimeoutMs,
    zeroProgressSliceCap: policy.zeroProgressSliceCap,
    ...(production ? {
      canonicalCycleUpperCap: policy.canonicalCycleUpperCap,
      navigationPolicy: policy.navigationPolicy,
    } : {}),
  };
  exactJson(actualRunPolicy, expectedRunPolicy, "$.report.policy");
  if (!production) {
    exact(
      policy.canonicalCycleUpperCap,
      policy.executedCycleUpperCap,
      "$.report.policy.canonicalCycleUpperCap",
    );
    exact(
      Object.hasOwn(policy, "navigationPolicy"),
      false,
      "$.report.policy.navigationPolicy",
    );
  }
  exact(policy.transport, "frozen-resident-machine-worker", "$.report.policy.transport");
  exact(
    policy.evidenceMode,
    "first-renderer-owned-presented-xfb",
    "$.report.policy.evidenceMode",
  );

  const checkpoint = object(report.fidelityCheckpointPolicy, "$.report.fidelityCheckpointPolicy");
  exactJson({
    checkpointTimeoutMs: checkpoint.checkpointTimeoutMs,
    checkpointRecordCap: checkpoint.checkpointRecordCap,
    probeEventRunCap: checkpoint.probeEventCap,
    probeEventPerSubmissionCap: checkpoint.probeEventPerSubmissionCap,
    opaqueProbeWords: checkpoint.opaqueProbeWords,
    fsyncEveryRecord: true,
  }, lock.checkpointPolicy, "$.report.fidelityCheckpointPolicy");
  exact(
    checkpoint.hook,
    lock.rendererProbe.hook,
    "$.report.fidelityCheckpointPolicy.hook",
  );
}

export function validateCombinedResidentFidelityEvidence({
  report: reportValue,
  reportBytes: reportBytesValue,
  records,
  lock: lockValue,
  evidenceLockSha256,
}, optionsValue = {}) {
  if (typeof evidenceLockSha256 !== "string" || !SHA256_PATTERN.test(evidenceLockSha256)) {
    fail("$.evidenceLockSha256", "expected a lowercase SHA-256 digest");
  }
  const options = object(optionsValue, "$.validationOptions");
  for (const key of Object.keys(options)) {
    if (!new Set(["expectedArtifacts", "expectedBoot", "expectedLockAuthority"]).has(key)) {
      fail(`$.validationOptions.${key}`, "unknown validation option");
    }
  }
  const production = lockValue?.schema === PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA;
  const lock = production
    ? validateResidentProductionFidelityEvidenceLock(
        lockValue,
        options.expectedLockAuthority,
      )
    : validateResidentFidelityEvidenceLock(lockValue);
  const lockedGame = production
    ? {
        key: lock.selectedGame.key,
        priority: lock.selectedGame.priority,
        bytes: lock.selectedGame.bytes,
        sha256: lock.selectedGame.image.sha256,
      }
    : lock.selectedGame;
  const report = object(reportValue, "$.report");
  exact(report.status, "complete", "$.report.status");
  exactJson(report.artifacts?.artifacts, lock.artifacts, "$.report.artifacts.artifacts");
  exact(report.artifacts?.schema, "lazuli-resident-corpus-artifacts-v1", "$.report.artifacts.schema");
  exact(report.corpus?.sourceCorpusSha256, lock.corpus.sha256, "$.report.corpus.sourceCorpusSha256");
  exact(report.corpus?.selectedGameKey, lockedGame.key, "$.report.corpus.selectedGameKey");
  exact(report.game?.game?.key, lockedGame.key, "$.report.game.game.key");
  exactJson(report.game?.game, lockedGame, "$.report.game.game");
  exact(report.evidenceLock?.schema, lock.schema, "$.report.evidenceLock.schema");
  exact(report.evidenceLock?.sha256, evidenceLockSha256, "$.report.evidenceLock.sha256");
  validateReportPolicy(report, lock);
  exact(
    report.capabilityBoundary?.rawSixU32RendererProbeRelayOnly,
    true,
    "$.report.capabilityBoundary.rawSixU32RendererProbeRelayOnly",
  );
  exact(
    report.capabilityBoundary?.rendererProbeWordsInterpreted,
    0,
    "$.report.capabilityBoundary.rendererProbeWordsInterpreted",
  );
  exact(
    report.capabilityBoundary?.machineEvidenceWordsInterpretedInBrowser,
    lock.machineEvidence.browserWordInterpretations,
    "$.report.capabilityBoundary.machineEvidenceWordsInterpretedInBrowser",
  );
  exact(
    report.capabilityBoundary?.opaqueMachineEvidenceTransportOnly,
    true,
    "$.report.capabilityBoundary.opaqueMachineEvidenceTransportOnly",
  );

  validateResidentFirstFrameReport(report, {
    requireComplete: true,
    expectedArtifacts: options.expectedArtifacts ?? lock.artifacts,
    expectedEvidenceLock: {
      schema: lock.schema,
      sha256: evidenceLockSha256,
    },
  });
  const machineEvidence = validateMachineEvidenceV1PublicationEnvelope(
    report.game.adapterDiagnostics.final.machineEvidence,
    {
      path: "$.report.game.adapterDiagnostics.final.machineEvidence",
      expectedBoot: options.expectedBoot ?? WARIOWARE_MACHINE_EVIDENCE_BOOT,
    },
  );

  const expectedHostIdentitySha256 = expectedFidelityHostIdentitySha256(
    lock,
    evidenceLockSha256,
    production ? options.expectedLockAuthority : null,
  );
  const journalOptions = {
    requireResolved: true,
    probeEventCap: lock.checkpointPolicy.probeEventRunCap,
    evidenceLockSha256,
    expectedHostIdentitySha256,
    probeEventPolicy: production ? "forbidden" : "required",
  };
  const journal = validateFidelityCheckpointJournal(records, {
    ...journalOptions,
    capturePolicy: production ? "required" : "forbidden",
  });
  exact(journal.gameKey, lockedGame.key, "$.journal.gameKey");
  if (production) exact(journal.runId, lock.run.runId, "$.journal.runId");
  exact(journal.terminalBoundary, "all-receipts-resolved", "$.journal.terminalBoundary");

  const client = object(report.game?.fidelityCheckpoints, "$.report.game.fidelityCheckpoints");
  let frozenRecords = records;
  let frozenJournal = journal;
  if (production) {
    const prefixCount = positiveInteger(
      client.recordCount,
      "$.report.game.fidelityCheckpoints.recordCount",
    );
    if (prefixCount >= records.length) {
      fail(
        "$.report.game.fidelityCheckpoints.recordCount",
        "must leave the next durable record for first-frame report binding",
      );
    }
    frozenRecords = records.slice(0, prefixCount);
    frozenJournal = validateFidelityCheckpointJournal(frozenRecords, {
      ...journalOptions,
      capturePolicy: "allowed",
    });
    exact(frozenJournal.gameKey, lockedGame.key, "$.journalPrefix.gameKey");
    exact(frozenJournal.runId, lock.run.runId, "$.journalPrefix.runId");
    exact(
      frozenJournal.terminalBoundary,
      "all-receipts-resolved",
      "$.journalPrefix.terminalBoundary",
    );
    const firstFrameOwned = frozenRecords.find(
      record => record.payload.kind === "first-frame-renderer-owned",
    )?.payload;
    const baselineOwned = frozenRecords.find(
      record => record.payload.kind === "fidelity-baseline-owned",
    )?.payload;
    const expectedReadbacks = baselineOwned !== undefined
        && baselineOwned.receiptRecordSha256 !== firstFrameOwned?.receiptRecordSha256
      ? 2
      : 1;
    exact(
      report.capabilityBoundary.rendererOwnedRgbaReadbacks,
      expectedReadbacks,
      "$.report.capabilityBoundary.rendererOwnedRgbaReadbacks",
    );

    const reportBytes = exactRawBytes(reportBytesValue, "$.reportBytes");
    const canonicalReportBytes = Buffer.from(canonicalFidelityJson(report), "utf8");
    if (!reportBytes.equals(canonicalReportBytes)) {
      fail("$.reportBytes", "did not equal the canonical UTF-8 report bytes");
    }
    const binding = object(records[prefixCount], `$.journal[${prefixCount}]`);
    const bindingPayload = object(binding.payload, `$.journal[${prefixCount}].payload`);
    exact(
      bindingPayload.kind,
      "first-frame-report-bound",
      `$.journal[${prefixCount}].payload.kind`,
    );
    exact(
      bindingPayload.reportBytes,
      reportBytes.byteLength,
      `$.journal[${prefixCount}].payload.reportBytes`,
    );
    exact(
      bindingPayload.reportSha256,
      sha256Bytes(reportBytes),
      `$.journal[${prefixCount}].payload.reportSha256`,
    );
    exact(
      bindingPayload.firstFrameRendererRecordSha256,
      frozenJournal.capture?.firstFrameRendererRecordSha256,
      `$.journal[${prefixCount}].payload.firstFrameRendererRecordSha256`,
    );
    exact(
      bindingPayload.baselineRecordSha256,
      frozenJournal.capture?.baselineRecordSha256 ?? null,
      `$.journal[${prefixCount}].payload.baselineRecordSha256`,
    );

    const reportMachineEnvelope = report.game.adapterDiagnostics.final.machineEvidence;
    const reportMachineEnvelopeBytes = Buffer.from(
      canonicalFidelityJson(reportMachineEnvelope),
      "utf8",
    );
    const reportMachineOpaqueBytes = Buffer.from(reportMachineEnvelope.payload, "base64");
    for (const [field, expected] of Object.entries({
      machineEvidenceEnvelopeBytes: reportMachineEnvelopeBytes.byteLength,
      machineEvidenceEnvelopeSha256: sha256Bytes(reportMachineEnvelopeBytes),
      machineEvidenceOpaqueBytes: reportMachineOpaqueBytes.byteLength,
      machineEvidenceOpaqueSha256: sha256Bytes(reportMachineOpaqueBytes),
    })) {
      exact(bindingPayload[field], expected, `$.journal[${prefixCount}].payload.${field}`);
    }
  }
  for (const [field, expected] of Object.entries({
    runId: frozenJournal.runId,
    gameKey: frozenJournal.gameKey,
    evidenceLockSha256,
    recordCap: lock.checkpointPolicy.checkpointRecordCap,
    probeEventCap: lock.checkpointPolicy.probeEventRunCap,
    recordCount: frozenJournal.records,
    probeEventCount: frozenJournal.probeEvents,
    probeEventPerSubmissionCap: lock.checkpointPolicy.probeEventPerSubmissionCap,
    maximumProbeEventsPerSubmission: frozenJournal.maximumProbeEventsPerSubmission,
    probeRelayFailures: 0,
    firstRecordSha256: frozenJournal.firstRecordSha256,
    lastRecordSha256: frozenJournal.lastRecordSha256,
    lastServerSequence: frozenJournal.records,
    openSubmission: false,
    submissionReturned: false,
    failure: null,
  })) exact(client[field], expected, `$.report.game.fidelityCheckpoints.${field}`);
  exactJson(
    client.kindCounts,
    kindCounts(frozenRecords),
    "$.report.game.fidelityCheckpoints.kindCounts",
  );

  const rendererCalls = report.game?.renderer?.calls;
  exact(rendererCalls, frozenJournal.submissions, "$.report.game.renderer.calls/submissions");
  exact(rendererCalls, frozenJournal.submitReturns, "$.report.game.renderer.calls/submitReturns");
  exact(rendererCalls, frozenJournal.receipts, "$.report.game.renderer.calls/receipts");
  if (!Number.isSafeInteger(rendererCalls) || rendererCalls <= 0) {
    fail("$.report.game.renderer.calls", "expected at least one fully checkpointed render call");
  }

  const frame = object(report.game?.firstPresentedXfb, "$.report.game.firstPresentedXfb");
  const trigger = object(frame.trigger, "$.report.game.firstPresentedXfb.trigger");
  const matching = frozenRecords
    .map(record => record.payload)
    .filter(payload => payload.renderCallOrdinal === trigger.renderCallOrdinal);
  const pre = matching.find(payload => payload.kind === "pre-submit");
  const returned = matching.find(payload => payload.kind === "submit-returned");
  const receipt = matching.find(payload => payload.kind === "receipt-resolved");
  if (!pre || !returned || !receipt) fail("$.journal", "captured render ordinal lacks all checkpoints");
  for (const [field, expected] of Object.entries({
    relayRequestId: trigger.relayRequestId,
    renderCallOrdinal: trigger.renderCallOrdinal,
    requestFlags: trigger.requestFlags,
    sequenceLo: trigger.sequenceLo,
    sequenceHi: trigger.sequenceHi,
    opaqueRequestBytes: trigger.opaqueRequestBytes,
    opaqueRequestSha256: trigger.opaqueRequestSha256,
    presentedBefore: false,
  })) exact(pre[field], expected, `$.journal.captured.pre-submit.${field}`);
  exact(returned.presentedAfterReturn, frame.transition.afterReturn, "$.frame.transition.afterReturn");
  exact(receipt.presentedAfterResolution, true, "$.journal.captured.presentedAfterResolution");
  exact(receipt.receiptBytes, frame.receipt.bytes, "$.journal.captured.receiptBytes");
  exact(receipt.receiptSha256, frame.receipt.sha256, "$.journal.captured.receiptSha256");
  exact(frame.transition.beforeCall, false, "$.frame.transition.beforeCall");
  exact(frame.transition.byResolution, true, "$.frame.transition.byResolution");
  exact(
    frame.transition.definition,
    "false-before-call-to-true-by-resolution",
    "$.frame.transition.definition",
  );

  return Object.freeze({
    ok: true,
    schema: "lazuli-resident-renderer-fidelity-combined-summary-v1",
    evidenceLockSha256,
    expectedHostIdentitySha256,
    gameKey: lockedGame.key,
    runId: journal.runId,
    checkpointTerminalBoundary: journal.terminalBoundary,
    rendererCalls,
    probeEvents: journal.probeEvents,
    rgbaSha256: frame.readback.rgbaSha256,
    receiptSha256: frame.receipt.sha256,
    acceptedByRust: frame.acceptedByRust,
    machineEvidence,
  });
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("expected unique --evidence-lock, --journal, and --report pairs");
    }
    const key = name.slice(2);
    if (parsed.has(key)) throw new Error(`duplicate --${key}`);
    parsed.set(key, value);
  }
  const expected = ["evidence-lock", "journal", "report"];
  if (parsed.size !== expected.length || expected.some(key => !parsed.has(key))) {
    throw new Error("usage: resident_machine_fidelity_combined_report.mjs --evidence-lock lock.json --journal checkpoints.jsonl --report report.json");
  }
  return parsed;
}

async function cli() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const [lockBytes, journalText, reportText] = await Promise.all([
    readFile(arguments_.get("evidence-lock")),
    readFile(arguments_.get("journal"), "utf8"),
    readFile(arguments_.get("report"), "utf8"),
  ]);
  const summary = validateCombinedResidentFidelityEvidence({
    report: JSON.parse(reportText),
    reportBytes: Buffer.from(reportText, "utf8"),
    records: parseFidelityCheckpointJsonl(journalText),
    lock: JSON.parse(lockBytes),
    evidenceLockSha256: sha256Bytes(lockBytes),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
