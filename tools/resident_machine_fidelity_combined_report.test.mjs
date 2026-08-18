// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateCombinedResidentFidelityEvidence,
} from "./resident_machine_fidelity_combined_report.mjs";
import { canonicalFidelityJson } from "./resident_machine_fidelity_checkpoint_report.mjs";
import { PRODUCTION_FIRST_FRAME_CAPTURE_ORDER } from "./resident_machine_first_frame_report.mjs";
import {
  expectedFidelityHostIdentitySha256,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  PRODUCTION_SOURCE_PATHS,
  productionFidelityCapturePolicy,
  verifyResidentProductionDefaultOffRenderer,
} from "./resident_machine_fidelity_lock.mjs";
import {
  residentFirstFrameReportFixture,
} from "./resident_machine_first_frame_report.test.mjs";

const RUN_ID = "12345678-1234-4234-9234-123456789abc";
const REQUEST_SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const MACHINE_SESSION_ID = "87654321-4321-4321-8321-cba987654321";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unsignedLeb(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function wasmString(value) {
  const bytes = [...Buffer.from(value)];
  return [...unsignedLeb(bytes.length), ...bytes];
}

function rendererModule(importNames) {
  const typePayload = [1, 0x60, 0, 0];
  const importPayload = [...unsignedLeb(importNames.length)];
  for (const name of importNames) {
    importPayload.push(...wasmString("./browser_renderer_bg.js"), ...wasmString(name), 0, 0);
  }
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, ...unsignedLeb(typePayload.length), ...typePayload,
    2, ...unsignedLeb(importPayload.length), ...importPayload,
  ]);
}

function durableRecords(payloads, evidenceLockSha256, hostIdentitySha256) {
  let previousRecordSha256 = null;
  return payloads.map((payload, index) => {
    const core = {
      schema: "lazuli-resident-renderer-fidelity-durable-record-v1",
      serverSequence: index + 1,
      receivedAtUnixMs: 1_800_000_000_000 + index,
      hostIdentitySha256,
      evidenceLockSha256,
      previousRecordSha256,
      payloadSha256: hash(canonicalFidelityJson(payload)),
      payload,
    };
    const record = {
      ...core,
      recordSha256: hash(canonicalFidelityJson(core)),
    };
    previousRecordSha256 = record.recordSha256;
    return record;
  });
}

function checkpointKindCounts(records) {
  const counts = {};
  for (const record of records) {
    counts[record.payload.kind] = (counts[record.payload.kind] ?? 0) + 1;
  }
  return counts;
}

function payload(sequence, kind, fields) {
  return {
    schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
    runId: RUN_ID,
    gameKey: "warioware-usa",
    clientSequence: sequence,
    kind,
    ...fields,
  };
}

function productionLock(base) {
  const artifactDescriptor = (name, extension) => ({
    url: `/assets/${name}-${base.artifacts[name].sha256}.${extension}`,
    ...base.artifacts[name],
  });
  const adapter = { url: `/assets/adapter-${SHA_B}.mjs`, bytes: 101, sha256: SHA_B };
  const worker = { url: `/assets/worker-${SHA_C}.mjs`, bytes: 102, sha256: SHA_C };
  const frontend = { url: `/assets/frontend-${REQUEST_SHA}.html`, bytes: 103, sha256: REQUEST_SHA };
  const release = {
    schema: 4,
    releaseId: "1".repeat(64),
    manifestBytes: 4_096,
    manifestSha256: "2".repeat(64),
    sourceCommit: "3".repeat(40),
    executionAssetsSha256: "4".repeat(64),
    executionAssets: {
      core: artifactDescriptor("browser_machine.wasm", "wasm"),
      dispatcher: artifactDescriptor("resident_dispatcher.wasm", "wasm"),
      coordinator: artifactDescriptor("core_run_coordinator.wasm", "wasm"),
      adapter,
      worker,
      frontend,
      rendererJavascript: artifactDescriptor("browser_renderer.js", "js"),
      rendererWasm: artifactDescriptor("browser_renderer_bg.wasm", "wasm"),
    },
  };
  const lock = {
    schema: "lazuli-resident-renderer-fidelity-evidence-lock-v3",
    evidenceMode: "continuous-resident-game-fidelity-v1-with-durable-renderer-and-rust-ownership",
    release,
    run: { runId: RUN_ID, gameKey: "warioware-usa" },
    corpus: structuredClone(base.corpus),
    selectedGame: {
      key: base.selectedGame.key,
      priority: base.selectedGame.priority,
      bytes: base.selectedGame.bytes,
      image: { format: "ciso", sha256: base.selectedGame.sha256 },
      disc: { identifier: "GZWE01", revision: 0 },
    },
    artifacts: structuredClone(base.artifacts),
    sources: Object.fromEntries(PRODUCTION_SOURCE_PATHS.map(path => [
      path,
      { bytes: 1, sha256: "5".repeat(64) },
    ])),
    hostPolicy: structuredClone(base.hostPolicy),
    runPolicy: {
      ...structuredClone(base.runPolicy),
      executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
      totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
      workerUrl: worker.url,
    },
    checkpointPolicy: structuredClone(base.checkpointPolicy),
    capturePolicy: productionFidelityCapturePolicy("warioware-usa"),
    rendererProbe: {
      feature: "resident-render-probe",
      featureDefaultOff: true,
      hook: "globalThis.__lazuliResidentRenderProbe",
      defaultHookImports: 0,
      checkpointProbeEvents: 0,
      javascriptWordInterpretations: 0,
    },
    machineEvidence: structuredClone(base.machineEvidence),
  };
  const expectedLockAuthority = Object.fromEntries(
    ["release", "run", "corpus", "selectedGame", "artifacts", "sources"]
      .map(field => [field, structuredClone(lock[field])]),
  );
  return { lock, expectedLockAuthority };
}

function productionRunSummary(runPolicy, accepted) {
  return {
    schema: "lazuli-resident-cumulative-run-summary-v1",
    issuedRunCalls: accepted ? 3 : 0,
    reportedExecutedCycles: accepted ? "3000" : "0",
    reportedExecutedInstructions: accepted ? "1200" : "0",
    reportedHostCalls: accepted ? 6 : 0,
    reportedColdInstalls: 0,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    operatorPublications: 0,
    witnessPublications: accepted ? 1 : 0,
    elapsedWallMs: accepted ? 100 : 0,
    wallTimeoutMs: Math.min(runPolicy.runTimeoutMs, runPolicy.externalWallTimeoutMs),
    accepted,
  };
}

function artifactFields(prefix) {
  return {
    gameFidelityEnvelopeBytes: 512,
    gameFidelityEnvelopeSha256: prefix === "accepted" ? SHA_C : SHA_B,
    gameFidelityOpaqueBytes: 384,
    gameFidelityOpaqueSha256: prefix === "accepted" ? SHA_B : SHA_C,
    machineEvidenceEnvelopeBytes: 1_024,
    machineEvidenceEnvelopeSha256: prefix === "accepted" ? REQUEST_SHA : SHA_B,
    machineEvidenceOpaqueBytes: 816,
    machineEvidenceOpaqueSha256: prefix === "accepted" ? SHA_C : REQUEST_SHA,
  };
}

function receiptFields(identity, receiptRecordSha256) {
  return {
    ...identity,
    receiptBytes: 80,
    receiptSha256: REQUEST_SHA,
    presentedAfterResolution: true,
    receiptRecordSha256,
  };
}

function reportMachineLeaf(report) {
  const envelope = report.game.adapterDiagnostics.final.machineEvidence;
  const envelopeBytes = Buffer.from(canonicalFidelityJson(envelope), "utf8");
  const opaqueBytes = Buffer.from(envelope.payload, "base64");
  return {
    machineEvidenceEnvelopeBytes: envelopeBytes.byteLength,
    machineEvidenceEnvelopeSha256: hash(envelopeBytes),
    machineEvidenceOpaqueBytes: opaqueBytes.byteLength,
    machineEvidenceOpaqueSha256: hash(opaqueBytes),
  };
}

async function productionFixture({
  baselineMode = "same-pre",
  interposeBeforeBinding = false,
  corruptReportMachineLeaf = false,
} = {}) {
  const legacy = await fixture();
  const { lock, expectedLockAuthority } = productionLock(legacy.lock);
  const evidenceLockBytes = Buffer.from(canonicalFidelityJson(lock), "utf8");
  const evidenceLockSha256 = hash(evidenceLockBytes);
  const hostIdentitySha256 = expectedFidelityHostIdentitySha256(
    lock,
    evidenceLockSha256,
    expectedLockAuthority,
  );
  const report = residentFirstFrameReportFixture();
  report.policy.executedCycleUpperCap = PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP;
  report.policy.totalColdInstallCap = PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP;
  report.game.run.executedCycleUpperCap = PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP;
  report.artifacts.artifacts = structuredClone(lock.artifacts);
  report.evidenceLock = { schema: lock.schema, sha256: evidenceLockSha256 };
  report.game.firstPresentedXfb.captureOrder = [...PRODUCTION_FIRST_FRAME_CAPTURE_ORDER];
  report.captureOrderContract = [...PRODUCTION_FIRST_FRAME_CAPTURE_ORDER];
  report.capabilityBoundary.rendererProbeEventsExpected = 0;
  report.game.fidelityCheckpoints.probeEventCount = 0;
  report.game.fidelityCheckpoints.maximumProbeEventsPerSubmission = 0;

  const records = [];
  let previousRecordSha256 = null;
  const add = (kind, fields) => {
    const entry = payload(records.length + 1, kind, fields);
    const core = {
      schema: "lazuli-resident-renderer-fidelity-durable-record-v1",
      serverSequence: records.length + 1,
      receivedAtUnixMs: 1_800_000_000_000 + records.length,
      hostIdentitySha256,
      evidenceLockSha256,
      previousRecordSha256,
      payloadSha256: hash(canonicalFidelityJson(entry)),
      payload: entry,
    };
    const record = { ...core, recordSha256: hash(canonicalFidelityJson(core)) };
    previousRecordSha256 = record.recordSha256;
    records.push(record);
    return record;
  };
  const readyEnvelope = report.game.adapterDiagnostics.ready.machineEvidence;
  const readyEnvelopeBytes = Buffer.from(canonicalFidelityJson(readyEnvelope), "utf8");
  const readyOpaqueBytes = Buffer.from(readyEnvelope.payload, "base64");
  add("capture-machine-initialized", {
    machineSessionId: MACHINE_SESSION_ID,
    bootStatus: 3,
    bootReads: 5,
    machineEvidenceEnvelopeBytes: readyEnvelopeBytes.byteLength,
    machineEvidenceEnvelopeSha256: hash(readyEnvelopeBytes),
    machineEvidenceOpaqueBytes: readyOpaqueBytes.byteLength,
    machineEvidenceOpaqueSha256: hash(readyOpaqueBytes),
    runPolicy: structuredClone(lock.runPolicy),
    runSummary: productionRunSummary(lock.runPolicy, false),
  });

  const firstIdentity = {
    relayRequestId: 1,
    renderCallOrdinal: 1,
    requestFlags: 0,
    sequenceLo: 1,
    sequenceHi: 0,
    opaqueRequestBytes: 128,
    opaqueRequestSha256: REQUEST_SHA,
    presentedBefore: false,
  };
  add("pre-submit", firstIdentity);
  add("submit-returned", {
    ...firstIdentity,
    returnedPromise: true,
    presentedAfterReturn: false,
  });
  const firstReceipt = add("receipt-resolved", {
    ...firstIdentity,
    receiptBytes: 80,
    receiptSha256: REQUEST_SHA,
    presentedAfterResolution: true,
  });
  const metadataBytes = Buffer.from(
    canonicalFidelityJson(report.game.firstPresentedXfb.readback.metadata),
    "utf8",
  );
  const firstOwned = add("first-frame-renderer-owned", {
    ...receiptFields(firstIdentity, firstReceipt.recordSha256),
    machineSessionId: MACHINE_SESSION_ID,
    readbackMetadataBytes: metadataBytes.byteLength,
    readbackMetadataSha256: hash(metadataBytes),
    rgbaBytes: report.game.firstPresentedXfb.readback.rgbaBytes,
    rgbaSha256: report.game.firstPresentedXfb.readback.rgbaSha256,
  });

  let baselineReceipt = firstReceipt;
  let baselineIdentity = firstIdentity;
  let baseline = null;
  const addBaseline = () => {
    const reusesFirstReadback = baselineReceipt === firstReceipt;
    baseline = add("fidelity-baseline-owned", {
      ...receiptFields(baselineIdentity, baselineReceipt.recordSha256),
      machineSessionId: MACHINE_SESSION_ID,
      phase: 1,
      ...artifactFields("baseline"),
      readbackMetadataBytes: metadataBytes.byteLength,
      readbackMetadataSha256: hash(metadataBytes),
      rgbaBytes: reusesFirstReadback ? report.game.firstPresentedXfb.readback.rgbaBytes : 16,
      rgbaSha256: reusesFirstReadback ? report.game.firstPresentedXfb.readback.rgbaSha256 : SHA_B,
      requestedButtons: 1,
      requestedStickXyCxy: 0x8080_8080,
      requestedTriggerLrab: 0x00ff_0000,
    });
  };
  const addDistinctBaselineReceipt = () => {
    baselineIdentity = {
      ...firstIdentity,
      relayRequestId: 2,
      renderCallOrdinal: 2,
      sequenceLo: 2,
    };
    add("pre-submit", baselineIdentity);
    add("submit-returned", {
      ...baselineIdentity,
      returnedPromise: true,
      presentedAfterReturn: true,
    });
    baselineReceipt = add("receipt-resolved", {
      ...baselineIdentity,
      receiptBytes: 80,
      receiptSha256: REQUEST_SHA,
      presentedAfterResolution: true,
    });
    addBaseline();
  };
  if (baselineMode === "same-pre") {
    addBaseline();
  } else if (baselineMode === "distinct-pre") {
    addDistinctBaselineReceipt();
    report.game.renderer.calls = 2;
    report.game.adapterDiagnostics.final.totalRenderCalls = 2;
    report.game.residentTotals.renderCalls = 2;
    report.game.run.servicedHostCalls = 3;
    report.capabilityBoundary.rendererOwnedRgbaReadbacks = 2;
    const finalMachine = Buffer.from(
      report.game.adapterDiagnostics.final.machineEvidence.payload,
      "base64",
    );
    finalMachine.writeBigUInt64LE(2n, 92 * 4);
    finalMachine.writeBigUInt64LE(2n, 94 * 4);
    report.game.adapterDiagnostics.final.machineEvidence.payload = finalMachine.toString("base64");
  } else if (baselineMode !== "distinct-post") {
    throw new Error(`unsupported Baseline fixture mode: ${baselineMode}`);
  }

  const prefixCount = records.length;
  report.game.fidelityCheckpoints = {
    schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
    runId: RUN_ID,
    gameKey: "warioware-usa",
    evidenceLockSha256,
    recordCap: 65_535,
    probeEventCap: 32_768,
    recordCount: prefixCount,
    probeEventCount: 0,
    probeEventPerSubmissionCap: 402,
    maximumProbeEventsPerSubmission: 0,
    probeRelayFailures: 0,
    kindCounts: checkpointKindCounts(records),
    firstRecordSha256: records[0].recordSha256,
    lastRecordSha256: records.at(-1).recordSha256,
    lastServerSequence: prefixCount,
    openSubmission: false,
    submissionReturned: false,
    failure: null,
  };
  const reportBytes = Buffer.from(canonicalFidelityJson(report), "utf8");

  if (interposeBeforeBinding) {
    const interposedIdentity = {
      ...firstIdentity,
      relayRequestId: 99,
      renderCallOrdinal: 99,
      sequenceLo: 99,
    };
    add("pre-submit", interposedIdentity);
    add("submit-returned", {
      ...interposedIdentity,
      returnedPromise: true,
      presentedAfterReturn: true,
    });
    add("receipt-resolved", {
      ...interposedIdentity,
      receiptBytes: 80,
      receiptSha256: REQUEST_SHA,
      presentedAfterResolution: true,
    });
  }
  const boundMachineLeaf = reportMachineLeaf(report);
  if (corruptReportMachineLeaf) boundMachineLeaf.machineEvidenceOpaqueSha256 = SHA_B;
  const reportBound = add("first-frame-report-bound", {
    machineSessionId: MACHINE_SESSION_ID,
    reportBytes: reportBytes.byteLength,
    reportSha256: hash(reportBytes),
    ...boundMachineLeaf,
    firstFrameRendererRecordSha256: firstOwned.recordSha256,
    baselineRecordSha256: baseline?.recordSha256 ?? null,
  });

  if (baselineMode === "distinct-post") addDistinctBaselineReceipt();
  const witness = add("controller-witness-published", {
    machineSessionId: MACHINE_SESSION_ID,
    baselineRecordSha256: baseline.recordSha256,
    firstFrameReportRecordSha256: reportBound.recordSha256,
    sequenceLo: 10,
    sequenceHi: 0,
    buttons: 1,
    stickXyCxy: 0x8080_8080,
    triggerLrab: 0x00ff_0000,
    status: 1,
    ...reportMachineLeaf(report),
  });
  const acceptedIdentity = {
    ...firstIdentity,
    relayRequestId: 3,
    renderCallOrdinal: 3,
    sequenceLo: 3,
  };
  add("pre-submit", acceptedIdentity);
  add("submit-returned", {
    ...acceptedIdentity,
    returnedPromise: true,
    presentedAfterReturn: true,
  });
  const acceptedReceipt = add("receipt-resolved", {
    ...acceptedIdentity,
    receiptBytes: 80,
    receiptSha256: REQUEST_SHA,
    presentedAfterResolution: true,
  });
  const accepted = add("fidelity-accepted-owned", {
    ...receiptFields(acceptedIdentity, acceptedReceipt.recordSha256),
    machineSessionId: MACHINE_SESSION_ID,
    phase: 5,
    ...artifactFields("accepted"),
    readbackMetadataBytes: metadataBytes.byteLength,
    readbackMetadataSha256: hash(metadataBytes),
    rgbaBytes: 16,
    rgbaSha256: SHA_C,
    witnessRecordSha256: witness.recordSha256,
  });
  add("fidelity-terminal", {
    machineSessionId: MACHINE_SESSION_ID,
    phase: 5,
    baselineRecordSha256: baseline.recordSha256,
    acceptedRecordSha256: accepted.recordSha256,
    ...artifactFields("accepted"),
    runSummary: productionRunSummary(lock.runPolicy, true),
  });
  return {
    report,
    reportBytes,
    records,
    lock,
    evidenceLockSha256,
    options: { expectedLockAuthority },
    prefixCount,
  };
}

async function fixture() {
  const lockBytes = await readFile(
    new URL("./resident_machine_fidelity_evidence_lock_legacy_fixture.json", import.meta.url),
  );
  const lock = JSON.parse(lockBytes);
  const evidenceLockSha256 = hash(lockBytes);
  const hostIdentitySha256 = expectedFidelityHostIdentitySha256(lock, evidenceLockSha256);
  const identity = {
    relayRequestId: 1,
    renderCallOrdinal: 1,
    requestFlags: 0,
    sequenceLo: 1,
    sequenceHi: 0,
    opaqueRequestBytes: 128,
    opaqueRequestSha256: REQUEST_SHA,
    presentedBefore: false,
  };
  const records = durableRecords([
    payload(1, "pre-submit", identity),
    payload(2, "renderer-probe-event", {
      relayRequestId: 1,
      renderCallOrdinal: 1,
      words: [1, 1, 0, 128, 0, 0],
    }),
    payload(3, "submit-returned", {
      ...identity,
      returnedPromise: true,
      presentedAfterReturn: false,
    }),
    payload(4, "receipt-resolved", {
      ...identity,
      receiptBytes: 80,
      receiptSha256: REQUEST_SHA,
      presentedAfterResolution: true,
    }),
  ], evidenceLockSha256, hostIdentitySha256);
  const report = residentFirstFrameReportFixture();
  report.artifacts.artifacts = structuredClone(lock.artifacts);
  report.evidenceLock = { schema: lock.schema, sha256: evidenceLockSha256 };
  report.fidelityCheckpointPolicy = {
    schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
    hook: lock.rendererProbe.hook,
    opaqueProbeWords: 6,
    checkpointTimeoutMs: 10_000,
    checkpointRecordCap: 65_535,
    probeEventCap: 32_768,
    probeEventPerSubmissionCap: 402,
  };
  report.capabilityBoundary.rawSixU32RendererProbeRelayOnly = true;
  report.capabilityBoundary.rendererProbeWordsInterpreted = 0;
  report.game.fidelityCheckpoints = {
    schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
    runId: RUN_ID,
    gameKey: "warioware-usa",
    evidenceLockSha256,
    recordCap: 65_535,
    probeEventCap: 32_768,
    recordCount: 4,
    probeEventCount: 1,
    probeEventPerSubmissionCap: 402,
    maximumProbeEventsPerSubmission: 1,
    probeRelayFailures: 0,
    kindCounts: {
      "pre-submit": 1,
      "renderer-probe-event": 1,
      "submit-returned": 1,
      "receipt-resolved": 1,
    },
    firstRecordSha256: records[0].recordSha256,
    lastRecordSha256: records.at(-1).recordSha256,
    lastServerSequence: 4,
    openSubmission: false,
    submissionReturned: false,
    failure: null,
  };
  return { report, records, lock, evidenceLockSha256 };
}

test("combined validator authenticates lock, journal, frame, and Rust receipt acceptance", async () => {
  const evidence = await fixture();
  const summary = validateCombinedResidentFidelityEvidence(evidence);
  assert.equal(summary.ok, true);
  assert.equal(summary.checkpointTerminalBoundary, "all-receipts-resolved");
  assert.equal(summary.probeEvents, 1);
  assert.equal(summary.acceptedByRust, true);
  assert.equal(summary.machineEvidence.device.dspLleValid, true);
  assert.equal(summary.machineEvidence.vi.chronology.presentationStatus, "presented");
  assert.equal(Object.hasOwn(summary.machineEvidence, "boot"), false);
});

test("combined validator rejects a canonical foreign boot snapshot splice", async () => {
  const evidence = await fixture();
  const envelope = evidence.report.game.adapterDiagnostics.final.machineEvidence;
  const bytes = Buffer.from(envelope.payload, "base64");
  bytes.writeUInt32LE(0x475a_4c45, 12 * 4);
  envelope.payload = bytes.toString("base64");
  assert.throws(
    () => validateCombinedResidentFidelityEvidence(evidence),
    /boot identifier did not match/,
  );
});

test("combined validator rejects journal/report correlation rewrites", async () => {
  const evidence = await fixture();
  evidence.report.game.fidelityCheckpoints.lastRecordSha256 = "f".repeat(64);
  assert.throws(
    () => validateCombinedResidentFidelityEvidence(evidence),
    /lastRecordSha256/,
  );
});

function validateProduction(evidence) {
  return validateCombinedResidentFidelityEvidence(evidence, evidence.options);
}

test("production combined authenticates a same-receipt Baseline before report binding", async () => {
  const evidence = await productionFixture({ baselineMode: "same-pre" });
  const summary = validateProduction(evidence);
  assert.equal(summary.ok, true);
  assert.equal(summary.rendererCalls, 1);
  assert.equal(summary.probeEvents, 0);
  assert.equal(evidence.report.capabilityBoundary.rendererOwnedRgbaReadbacks, 1);
  assert.equal(evidence.records[evidence.prefixCount].payload.kind, "first-frame-report-bound");
});

test("production combined rejects the retired 250M cap in either report or lock", async () => {
  const staleReport = await productionFixture({ baselineMode: "same-pre" });
  staleReport.report.policy.executedCycleUpperCap = "250000000";
  staleReport.report.game.run.executedCycleUpperCap = "250000000";
  assert.throws(
    () => validateProduction(staleReport),
    /report\.policy/,
  );

  const staleLock = await productionFixture({ baselineMode: "same-pre" });
  staleLock.lock.runPolicy.executedCycleUpperCap = "250000000";
  assert.throws(
    () => validateProduction(staleLock),
    /runPolicy\.executedCycleUpperCap/,
  );
});

test("production combined requires capture mode and exact receipt-derived readback counts", async () => {
  const forbidden = await productionFixture({ baselineMode: "same-pre" });
  forbidden.lock.capturePolicy.mode = "forbidden";
  assert.throws(() => validateProduction(forbidden), /capturePolicy\.mode/);

  const sameReceipt = await productionFixture({ baselineMode: "same-pre" });
  sameReceipt.report.capabilityBoundary.rendererOwnedRgbaReadbacks = 2;
  assert.throws(
    () => validateProduction(sameReceipt),
    /rendererOwnedRgbaReadbacks/,
  );

  const distinctReceipt = await productionFixture({ baselineMode: "distinct-pre" });
  distinctReceipt.report.capabilityBoundary.rendererOwnedRgbaReadbacks = 1;
  assert.throws(
    () => validateProduction(distinctReceipt),
    /rendererOwnedRgbaReadbacks/,
  );
});

test("production combined authenticates distinct Baseline receipts on either side of binding", async () => {
  const before = await productionFixture({ baselineMode: "distinct-pre" });
  const beforeSummary = validateProduction(before);
  assert.equal(beforeSummary.rendererCalls, 2);
  assert.equal(before.report.capabilityBoundary.rendererOwnedRgbaReadbacks, 2);
  assert.equal(
    before.records[before.prefixCount - 1].payload.kind,
    "fidelity-baseline-owned",
  );

  const after = await productionFixture({ baselineMode: "distinct-post" });
  const afterSummary = validateProduction(after);
  assert.equal(afterSummary.rendererCalls, 1);
  assert.equal(after.report.capabilityBoundary.rendererOwnedRgbaReadbacks, 1);
  assert.equal(after.records[after.prefixCount].payload.kind, "first-frame-report-bound");
  assert.ok(
    after.records.filter(record => record.payload.kind === "pre-submit").length
      > afterSummary.rendererCalls,
    "future renderer calls must not inflate the frozen report count",
  );
});

test("production combined rejects full/future summaries and a truncated or reordered prefix", async () => {
  const future = await productionFixture({ baselineMode: "distinct-post" });
  future.report.game.fidelityCheckpoints.recordCount = future.records.length;
  assert.throws(
    () => validateProduction(future),
    /must leave the next durable record/,
  );

  const truncated = await productionFixture({ baselineMode: "same-pre" });
  truncated.report.game.fidelityCheckpoints.recordCount -= 1;
  truncated.reportBytes = Buffer.from(canonicalFidelityJson(truncated.report), "utf8");
  assert.throws(
    () => validateProduction(truncated),
    /first-frame-report-bound/,
  );

  const reordered = await productionFixture({ baselineMode: "same-pre" });
  [reordered.records[1], reordered.records[2]] = [reordered.records[2], reordered.records[1]];
  assert.throws(() => validateProduction(reordered), /serverSequence|hash chain/);
});

test("production combined requires the exact next report binding and canonical raw report", async () => {
  const interposed = await productionFixture({
    baselineMode: "same-pre",
    interposeBeforeBinding: true,
  });
  assert.throws(
    () => validateProduction(interposed),
    /payload\.kind.*first-frame-report-bound/,
  );

  const missing = await productionFixture({ baselineMode: "same-pre" });
  missing.records.splice(missing.prefixCount, 1);
  assert.throws(() => validateProduction(missing));

  const mutatedRaw = await productionFixture({ baselineMode: "same-pre" });
  mutatedRaw.reportBytes = Buffer.from(mutatedRaw.reportBytes);
  mutatedRaw.reportBytes[0] ^= 1;
  assert.throws(
    () => validateProduction(mutatedRaw),
    /canonical UTF-8 report bytes/,
  );

  const mutatedLeaf = await productionFixture({
    baselineMode: "same-pre",
    corruptReportMachineLeaf: true,
  });
  assert.throws(
    () => validateProduction(mutatedLeaf),
    /machineEvidenceOpaqueSha256/,
  );
});

test("production combined independently rejects a mutated terminal journal", async () => {
  const evidence = await productionFixture({ baselineMode: "distinct-post" });
  const terminal = evidence.records.at(-1);
  terminal.payload.gameFidelityOpaqueSha256 = REQUEST_SHA;
  terminal.payloadSha256 = hash(canonicalFidelityJson(terminal.payload));
  const core = { ...terminal };
  delete core.recordSha256;
  terminal.recordSha256 = hash(canonicalFidelityJson(core));
  assert.throws(
    () => validateProduction(evidence),
    /hard Accepted boundary/,
  );
});

test("production default-off renderer verifier requires exact imports and hook absence", async () => {
  const policy = {
    hook: "globalThis.__lazuliResidentRenderProbe",
    defaultHookImports: 0,
    checkpointProbeEvents: 0,
  };
  const names = Array.from({ length: 329 }, (_, index) => `__wbg_runtime_${index}`);
  assert.equal(
    await verifyResidentProductionDefaultOffRenderer(
      rendererModule(names),
      "const wasm = new URL('/assets/renderer.wasm', import.meta.url);\n",
      policy,
      "/assets/renderer.wasm",
    ),
    329,
  );
  await assert.rejects(
    verifyResidentProductionDefaultOffRenderer(
      rendererModule(names.slice(1)),
      "const wasm = new URL('/assets/renderer.wasm', import.meta.url);\n",
      policy,
      "/assets/renderer.wasm",
    ),
    /import count is not exact/,
  );
  await assert.rejects(
    verifyResidentProductionDefaultOffRenderer(
      rendererModule([
        "__wbg___lazuliResidentRenderProbe_deadbeef",
        ...names.slice(1),
      ]),
      "const wasm = new URL('/assets/renderer.wasm', import.meta.url);\n",
      policy,
      "/assets/renderer.wasm",
    ),
    /unexpectedly imports the probe hook/,
  );
  await assert.rejects(
    verifyResidentProductionDefaultOffRenderer(
      rendererModule(names),
      "const wasm = new URL('/assets/renderer.wasm', import.meta.url);\n"
        + "globalThis.__lazuliResidentRenderProbe(1, 2, 3, 4, 5, 6);\n",
      policy,
      "/assets/renderer.wasm",
    ),
    /unexpectedly calls the probe hook/,
  );
  await assert.rejects(
    verifyResidentProductionDefaultOffRenderer(
      rendererModule(names),
      "const wasm = new URL('/assets/other.wasm', import.meta.url);\n",
      policy,
      "/assets/renderer.wasm",
    ),
    /exactly one locked Wasm dependency URL/,
  );
  await assert.rejects(
    verifyResidentProductionDefaultOffRenderer(
      rendererModule(names),
      "const first = new URL('/assets/renderer.wasm', import.meta.url);\n"
        + "const second = new URL('/assets/other.wasm', import.meta.url);\n",
      policy,
      "/assets/renderer.wasm",
    ),
    /exactly one locked Wasm dependency URL/,
  );
});
