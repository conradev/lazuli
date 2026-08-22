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
  PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  PRODUCTION_SOURCE_PATHS,
  productionFidelityCapturePolicy,
  verifyResidentProductionDefaultOffRenderer,
} from "./resident_machine_fidelity_lock.mjs";
import {
  productionFidelityNavigationPolicy,
} from "./resident_machine_fidelity_navigation.mjs";
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

function reverseObjectEntries(value) {
  return Object.fromEntries(Object.entries(value).reverse());
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

function applyFirstFrameSourceContract(report, runPolicy = null) {
  if (runPolicy === null) {
    report.policy.canonicalCycleUpperCap = report.policy.executedCycleUpperCap;
    report.policy.externalWallTimeoutMs = report.policy.runTimeoutMs;
  } else {
    const exactRunPolicy = structuredClone(runPolicy);
    delete exactRunPolicy.workerUrl;
    report.policy = {
      transport: "frozen-resident-machine-worker",
      evidenceMode: "first-renderer-owned-presented-xfb",
      ...exactRunPolicy,
    };
  }
  report.game.run.adapterCapBoundaries = 0;
  report.game.run.canonicalCycleCapBoundaries = 0;
  report.game.run.canonicalCycles = report.game.run.executedCycles;
  report.game.run.instructionUpperCap = report.policy.instructionUpperCap;
  report.game.run.executedCycleUpperCap = report.policy.executedCycleUpperCap;
  report.game.run.canonicalCycleUpperCap = report.policy.canonicalCycleUpperCap;
  report.game.run.slices = report.game.run.rustBoundaries + 1;
  report.game.faults.canonicalCycleCaps = 0;
  return report;
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
      instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
      executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
      canonicalCycleUpperCap: PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
      sliceCycleUpperCap: "8000000",
      blockUpperCap: 131_072,
      totalHostCallCap: 65_535,
      totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
      maxBootReads: 8_192,
      bootTimeoutMs: 180_000,
      sliceTimeoutMs: 180_000,
      runTimeoutMs: 7_200_000,
      externalWallTimeoutMs: 7_200_000,
      zeroProgressSliceCap: 4_096,
      workerUrl: worker.url,
      navigationPolicy: productionFidelityNavigationPolicy("warioware-usa"),
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

function productionRunSummary(runPolicy, {
  accepted = false,
  issuedRunCalls = 0,
  canonicalCycle = "0",
  operatorPublications = 0,
  witnessPublications = 0,
} = {}) {
  return {
    schema: "lazuli-resident-cumulative-run-summary-v2",
    issuedRunCalls,
    canonicalCycle,
    reportedCanonicalCycles: canonicalCycle,
    reportedExecutedCycles: canonicalCycle,
    reportedExecutedInstructions: canonicalCycle,
    reportedRetiredBlocks: String(issuedRunCalls),
    reportedHostCalls: issuedRunCalls,
    reportedColdInstalls: 0,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    operatorPublications,
    witnessPublications,
    elapsedWallMs: issuedRunCalls * 100,
    wallTimeoutMs: Math.min(runPolicy.runTimeoutMs, runPolicy.externalWallTimeoutMs),
    accepted,
  };
}

function expectedSiPacket(step) {
  return {
    word0: (
      ((step.buttons >>> 8) & 0xff) << 24
      | (((step.buttons & 0xff) | 0x80) & 0xff) << 16
      | (step.stickXyCxy & 0xff) << 8
      | ((step.stickXyCxy >>> 8) & 0xff)
    ) >>> 0,
    word1: (
      ((step.stickXyCxy >>> 16) & 0xff) << 24
      | ((step.stickXyCxy >>> 24) & 0xff) << 16
      | (step.triggerLrab & 0xff) << 8
      | ((step.triggerLrab >>> 8) & 0xff)
    ) >>> 0,
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
  const report = applyFirstFrameSourceContract(
    residentFirstFrameReportFixture(),
    lock.runPolicy,
  );
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
    runSummary: productionRunSummary(lock.runPolicy),
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

  let baselineReceipt;
  let baselineIdentity;
  let baseline = null;
  const addBaseline = () => {
    baseline = add("fidelity-baseline-owned", {
      ...receiptFields(baselineIdentity, baselineReceipt.recordSha256),
      machineSessionId: MACHINE_SESSION_ID,
      phase: 1,
      ...artifactFields("baseline"),
      readbackMetadataBytes: metadataBytes.byteLength,
      readbackMetadataSha256: hash(metadataBytes),
      rgbaBytes: 16,
      rgbaSha256: SHA_B,
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
    navigationStepRecords: 0,
    navigationArmRecordSha256: null,
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

  const navigationPolicy = lock.runPolicy.navigationPolicy;
  const navigationRunCallOrigin = report.game.run.slices;
  const navigationCanonicalCycleOrigin = report.game.run.canonicalCycles;
  const navigationArm = add("navigation-armed", {
    machineSessionId: MACHINE_SESSION_ID,
    firstFrameReportRecordSha256: reportBound.recordSha256,
    scriptSha256: navigationPolicy.scriptSha256,
    runCallOrigin: navigationRunCallOrigin,
    canonicalCycleOrigin: navigationCanonicalCycleOrigin,
    siPollIndexOrigin: "0",
    stepCount: navigationPolicy.steps.length,
    runSummary: productionRunSummary(lock.runPolicy, {
      issuedRunCalls: navigationRunCallOrigin,
      canonicalCycle: navigationCanonicalCycleOrigin,
    }),
  });
  const navigationRecords = [];
  let priorObservedCycle = BigInt(navigationCanonicalCycleOrigin);
  navigationPolicy.steps.forEach((step, stepIndex) => {
    const targetCycle = priorObservedCycle + BigInt(step.minimumCanonicalDelay);
    const publicationCycle = targetCycle + BigInt(stepIndex + 1);
    const scheduledCycle = publicationCycle + 1n;
    const observedCycle = scheduledCycle + 1n;
    const packet = expectedSiPacket(step);
    navigationRecords.push(add("navigation-step-received", {
      machineSessionId: MACHINE_SESSION_ID,
      firstFrameReportRecordSha256: reportBound.recordSha256,
      navigationArmRecordSha256: navigationArm.recordSha256,
      scriptSha256: navigationPolicy.scriptSha256,
      runCallOrigin: navigationRunCallOrigin,
      canonicalCycleOrigin: navigationCanonicalCycleOrigin,
      stepIndex,
      sequenceLo: stepIndex + 1,
      sequenceHi: 0,
      minimumCanonicalDelay: step.minimumCanonicalDelay,
      targetCanonicalCycle: targetCycle.toString(),
      publicationCanonicalCycle: publicationCycle.toString(),
      publicationOvershootCycles: String(stepIndex + 1),
      buttons: step.buttons,
      stickXyCxy: step.stickXyCxy,
      triggerLrab: step.triggerLrab,
      status: 1,
      siPollIndex: String(stepIndex + 1),
      siScheduledCycle: scheduledCycle.toString(),
      siObservedCycle: observedCycle.toString(),
      siAppliedSequenceLo: stepIndex + 1,
      siAppliedSequenceHi: 0,
      siPacketWord0: packet.word0,
      siPacketWord1: packet.word1,
      siSource: 0,
      priorSiPollIndex: String(stepIndex),
      siControllerMode: 3,
      siButtons: step.buttons,
      siStickXyCxy: step.stickXyCxy,
      siTriggerLrab: step.triggerLrab,
      runSummary: productionRunSummary(lock.runPolicy, {
        issuedRunCalls: navigationRunCallOrigin + stepIndex + 1,
        canonicalCycle: observedCycle.toString(),
        operatorPublications: stepIndex + 1,
      }),
    }));
    priorObservedCycle = observedCycle;
  });
  addDistinctBaselineReceipt();
  const lastNavigationStepRecordSha256 = navigationRecords.at(-1)?.recordSha256 ?? null;
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
    navigationScriptSha256: navigationPolicy.scriptSha256,
    navigationStepCount: navigationRecords.length,
    navigationArmRecordSha256: navigationArm.recordSha256,
    lastNavigationStepRecordSha256,
    runSummary: productionRunSummary(lock.runPolicy, {
      issuedRunCalls: navigationRunCallOrigin + navigationRecords.length + 1,
      canonicalCycle: priorObservedCycle.toString(),
      operatorPublications: navigationRecords.length,
      witnessPublications: 1,
    }),
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
    runSummary: productionRunSummary(lock.runPolicy, {
      accepted: true,
      issuedRunCalls: navigationRunCallOrigin + navigationRecords.length + 3,
      canonicalCycle: (priorObservedCycle + 100n).toString(),
      operatorPublications: navigationRecords.length,
      witnessPublications: 1,
    }),
    navigationScriptSha256: navigationPolicy.scriptSha256,
    navigationStepCount: navigationRecords.length,
    navigationArmRecordSha256: navigationArm.recordSha256,
    lastNavigationStepRecordSha256,
  });
  return {
    report,
    reportBytes,
    records,
    lock,
    evidenceLockSha256,
    options: { expectedLockAuthority },
    prefixCount,
    navigationRecordCount: navigationRecords.length,
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
  const report = applyFirstFrameSourceContract(residentFirstFrameReportFixture());
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
    navigationStepRecords: 0,
    navigationArmRecordSha256: null,
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

test("production combined authenticates locked navigation before the Baseline", async () => {
  const evidence = await productionFixture();
  const summary = validateProduction(evidence);
  assert.equal(summary.ok, true);
  assert.equal(summary.rendererCalls, 1);
  assert.equal(summary.probeEvents, 0);
  assert.equal(evidence.report.capabilityBoundary.rendererOwnedRgbaReadbacks, 1);
  assert.equal(evidence.records[evidence.prefixCount].payload.kind, "first-frame-report-bound");
  assert.equal(evidence.navigationRecordCount, 34);
  assert.equal(
    evidence.records.filter(record => record.payload.kind === "navigation-armed").length,
    1,
  );
  assert.equal(
    evidence.records.filter(record => record.payload.kind === "navigation-step-received").length,
    evidence.navigationRecordCount,
  );
  assert.ok(
    evidence.records.findIndex(record => record.payload.kind === "fidelity-baseline-owned")
      > evidence.records.findLastIndex(record => record.payload.kind === "navigation-step-received"),
  );
});

test("production combined canonical equality ignores object insertion order", async () => {
  const evidence = await productionFixture();
  evidence.lock.artifacts = reverseObjectEntries(evidence.lock.artifacts);
  evidence.lock.runPolicy = reverseObjectEntries(evidence.lock.runPolicy);
  evidence.lock.checkpointPolicy = reverseObjectEntries(evidence.lock.checkpointPolicy);
  evidence.options.expectedLockAuthority = reverseObjectEntries(
    evidence.options.expectedLockAuthority,
  );
  evidence.report.artifacts.artifacts = reverseObjectEntries(
    evidence.report.artifacts.artifacts,
  );
  evidence.report.game.game = reverseObjectEntries(evidence.report.game.game);
  evidence.report.game.fidelityCheckpoints.kindCounts = reverseObjectEntries(
    evidence.report.game.fidelityCheckpoints.kindCounts,
  );

  assert.equal(evidence.reportBytes.toString("utf8"), canonicalFidelityJson(evidence.report));
  assert.equal(validateProduction(evidence).ok, true);
});

test("combined canonical equality preserves keys, values, types, and array order", async () => {
  const expected = {
    nested: { alpha: 1, beta: true },
    lanes: ["left", "right"],
  };
  assert.equal(
    canonicalFidelityJson({ lanes: ["left", "right"], nested: { beta: true, alpha: 1 } }),
    canonicalFidelityJson(expected),
  );
  for (const mutated of [
    { ...expected, extra: 0 },
    { ...expected, nested: { alpha: 2, beta: true } },
    { ...expected, nested: { alpha: "1", beta: true } },
    { ...expected, lanes: ["right", "left"] },
  ]) {
    assert.notEqual(canonicalFidelityJson(mutated), canonicalFidelityJson(expected));
  }

  for (const mutate of [
    counts => { counts.unexpected = 0; },
    counts => { counts["pre-submit"] = 2; },
    counts => { counts["pre-submit"] = "1"; },
  ]) {
    const evidence = await fixture();
    mutate(evidence.report.game.fidelityCheckpoints.kindCounts);
    assert.throws(
      () => validateCombinedResidentFidelityEvidence(evidence),
      /fidelityCheckpoints\.kindCounts.*did not match lock/,
    );
  }
});

test("production combined still requires canonical report bytes and lock authority", async () => {
  const noncanonicalReport = await productionFixture();
  noncanonicalReport.reportBytes = Buffer.from(JSON.stringify(noncanonicalReport.report), "utf8");
  assert.notEqual(
    noncanonicalReport.reportBytes.toString("utf8"),
    canonicalFidelityJson(noncanonicalReport.report),
  );
  assert.throws(
    () => validateProduction(noncanonicalReport),
    /canonical UTF-8 report bytes/,
  );

  const foreignAuthority = await productionFixture();
  foreignAuthority.options.expectedLockAuthority.artifacts["browser_machine.wasm"].bytes += 1;
  assert.throws(
    () => validateProduction(foreignAuthority),
    /did not match the expected production authority/,
  );
});

test("production combined rejects retired cumulative caps in either report or lock", async () => {
  const staleInstructionReport = await productionFixture();
  staleInstructionReport.report.policy.instructionUpperCap = "100000000";
  staleInstructionReport.report.game.run.instructionUpperCap = "100000000";
  assert.throws(
    () => validateProduction(staleInstructionReport),
    /report\.policy|instructionUpperCap/,
  );

  const staleInstructionLock = await productionFixture();
  staleInstructionLock.lock.runPolicy.instructionUpperCap = "100000000";
  assert.throws(
    () => validateProduction(staleInstructionLock),
    /runPolicy\.instructionUpperCap/,
  );

  const staleReport = await productionFixture();
  staleReport.report.policy.executedCycleUpperCap = "250000000";
  staleReport.report.game.run.executedCycleUpperCap = "250000000";
  assert.throws(
    () => validateProduction(staleReport),
    /report\.policy/,
  );

  const staleLock = await productionFixture();
  staleLock.lock.runPolicy.executedCycleUpperCap = "250000000";
  assert.throws(
    () => validateProduction(staleLock),
    /runPolicy\.executedCycleUpperCap/,
  );
});

test("production combined requires capture mode and exact receipt-derived readback counts", async () => {
  const forbidden = await productionFixture();
  forbidden.lock.capturePolicy.mode = "forbidden";
  assert.throws(() => validateProduction(forbidden), /capturePolicy\.mode/);

  const wrongReadbackCount = await productionFixture();
  wrongReadbackCount.report.capabilityBoundary.rendererOwnedRgbaReadbacks = 2;
  assert.throws(
    () => validateProduction(wrongReadbackCount),
    /rendererOwnedRgbaReadbacks/,
  );
});

test("production combined excludes post-binding navigation and Baseline from the report prefix", async () => {
  const evidence = await productionFixture();
  const summary = validateProduction(evidence);
  assert.equal(summary.rendererCalls, 1);
  assert.equal(evidence.report.capabilityBoundary.rendererOwnedRgbaReadbacks, 1);
  assert.equal(evidence.records[evidence.prefixCount].payload.kind, "first-frame-report-bound");
  assert.ok(
    evidence.records.filter(record => record.payload.kind === "pre-submit").length
      > summary.rendererCalls,
    "future renderer calls must not inflate the frozen report count",
  );
  assert.equal(
    evidence.report.game.fidelityCheckpoints.kindCounts["navigation-step-received"],
    undefined,
  );
});

test("production combined rejects full/future summaries and a truncated or reordered prefix", async () => {
  const future = await productionFixture();
  future.report.game.fidelityCheckpoints.recordCount = future.records.length;
  assert.throws(
    () => validateProduction(future),
    /must leave the next durable record/,
  );

  const truncated = await productionFixture();
  truncated.report.game.fidelityCheckpoints.recordCount -= 1;
  truncated.reportBytes = Buffer.from(canonicalFidelityJson(truncated.report), "utf8");
  assert.throws(
    () => validateProduction(truncated),
    /first-frame-report-bound/,
  );

  const reordered = await productionFixture();
  [reordered.records[1], reordered.records[2]] = [reordered.records[2], reordered.records[1]];
  assert.throws(() => validateProduction(reordered), /serverSequence|hash chain/);
});

test("production combined requires the exact next report binding and canonical raw report", async () => {
  const interposed = await productionFixture({
    interposeBeforeBinding: true,
  });
  assert.throws(
    () => validateProduction(interposed),
    /payload\.kind.*first-frame-report-bound/,
  );

  const missing = await productionFixture();
  missing.records.splice(missing.prefixCount, 1);
  assert.throws(() => validateProduction(missing));

  const mutatedRaw = await productionFixture();
  mutatedRaw.reportBytes = Buffer.from(mutatedRaw.reportBytes);
  mutatedRaw.reportBytes[0] ^= 1;
  assert.throws(
    () => validateProduction(mutatedRaw),
    /canonical UTF-8 report bytes/,
  );

  const mutatedLeaf = await productionFixture({
    corruptReportMachineLeaf: true,
  });
  assert.throws(
    () => validateProduction(mutatedLeaf),
    /machineEvidenceOpaqueSha256/,
  );
});

test("production combined independently rejects a mutated terminal journal", async () => {
  const evidence = await productionFixture();
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
