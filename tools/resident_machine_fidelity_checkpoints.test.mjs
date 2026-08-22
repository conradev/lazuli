// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIDELITY_CHECKPOINT_ACK_SCHEMA,
  PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  ResidentFidelityCheckpointClient,
  captureNavigationRuntime,
  captureRunSummary as validateCaptureRunSummary,
} from "./resident_machine_fidelity_checkpoints.mjs";
import {
  fidelityNavigationPolicyFromSteps,
  productionFidelityNavigationPolicy,
} from "./resident_machine_fidelity_navigation.mjs";

const RUN_ID = "12345678-1234-4234-9234-123456789abc";
const GAME_KEY = "warioware-usa";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const LOCK_SHA = "c".repeat(64);
const MACHINE_SESSION_ID = "87654321-4321-4321-8321-cba987654321";

const WARIO_NAVIGATION_POLICY = productionFidelityNavigationPolicy(GAME_KEY);
const EMPTY_NAVIGATION_POLICY = fidelityNavigationPolicyFromSteps(GAME_KEY, []);

test("production v2 cumulative authorities are exact", () => {
  assert.equal(PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP, "32000000000");
  assert.equal(typeof PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP, "string");
  assert.equal(PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP, "32000000000");
  assert.equal(typeof PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP, "string");
  assert.equal(PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP, "16000000000");
  assert.equal(typeof PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP, "string");
  assert.equal(PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP, 0x000f_ffff);
  assert.equal(PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP, 65);
});

const CAPTURE_RUN_POLICY = Object.freeze({
  instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  canonicalCycleUpperCap: PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
  sliceCycleUpperCap: "200000000",
  blockUpperCap: 65_535,
  totalHostCallCap: 1_024,
  totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  maxBootReads: 8,
  bootTimeoutMs: 1_000,
  sliceTimeoutMs: 1_000,
  runTimeoutMs: 10_000,
  externalWallTimeoutMs: 10_000,
  zeroProgressSliceCap: 4,
  workerUrl: "/worker.mjs",
  navigationPolicy: WARIO_NAVIGATION_POLICY,
});

function captureRunSummary({
  accepted = false,
  issuedRunCalls = accepted ? 1 : 0,
  canonicalCycle = accepted ? "1" : "0",
  reportedCanonicalCycles = canonicalCycle,
  reportedExecutedCycles = canonicalCycle,
  reportedExecutedInstructions = issuedRunCalls === 0 ? "0" : String(issuedRunCalls),
  reportedRetiredBlocks = issuedRunCalls === 0 ? "0" : String(issuedRunCalls),
  reportedHostCalls = issuedRunCalls,
  reportedColdInstalls = 0,
  zeroProgressSlices = 0,
  consecutiveZeroProgressSlices = 0,
  maximumConsecutiveZeroProgressSlices = 0,
  operatorPublications = 0,
  witnessPublications = 0,
  elapsedWallMs = issuedRunCalls,
} = {}) {
  return {
    schema: "lazuli-resident-cumulative-run-summary-v2",
    issuedRunCalls,
    canonicalCycle,
    reportedCanonicalCycles,
    reportedExecutedCycles,
    reportedExecutedInstructions,
    reportedRetiredBlocks,
    reportedHostCalls,
    reportedColdInstalls,
    zeroProgressSlices,
    consecutiveZeroProgressSlices,
    maximumConsecutiveZeroProgressSlices,
    operatorPublications,
    witnessPublications,
    elapsedWallMs,
    wallTimeoutMs: 10_000,
    accepted,
  };
}

function expectedSiPacket(step, mode) {
  const word0 = (
    ((step.buttons >>> 8) & 0xff) << 24
    | (((step.buttons & 0xff) | 0x80) & 0xff) << 16
    | (step.stickXyCxy & 0xff) << 8
    | ((step.stickXyCxy >>> 8) & 0xff)
  ) >>> 0;
  const cStickX = (step.stickXyCxy >>> 16) & 0xff;
  const cStickY = (step.stickXyCxy >>> 24) & 0xff;
  const triggerL = step.triggerLrab & 0xff;
  const triggerR = (step.triggerLrab >>> 8) & 0xff;
  const analogA = (step.triggerLrab >>> 16) & 0xff;
  const analogB = (step.triggerLrab >>> 24) & 0xff;
  const low = mode === 0 || (mode >= 5 && mode <= 7)
    ? [cStickX, cStickY, (triggerL & 0xf0) | (triggerR >>> 4),
      (analogA & 0xf0) | (analogB >>> 4)]
    : mode === 1
      ? [(cStickX & 0xf0) | (cStickY >>> 4), triggerL, triggerR,
        (analogA & 0xf0) | (analogB >>> 4)]
      : mode === 2
        ? [(cStickX & 0xf0) | (cStickY >>> 4),
          (triggerL & 0xf0) | (triggerR >>> 4), analogA, analogB]
        : mode === 4
          ? [cStickX, cStickY, analogA, analogB]
          : [cStickX, cStickY, triggerL, triggerR];
  return {
    word0,
    word1: (low[0] << 24 | low[1] << 16 | low[2] << 8 | low[3]) >>> 0,
  };
}

function navigationReceipt(policy, index, priorAnchor, priorPollIndex, {
  overshoot = BigInt(index % 3),
} = {}) {
  const step = policy.steps[index];
  const sequence = BigInt(index + 1);
  const target = priorAnchor + BigInt(step.minimumCanonicalDelay);
  const publication = target + overshoot;
  const scheduled = publication + 1n;
  const observed = scheduled + 1n;
  const pollIndex = priorPollIndex + 1n;
  const mode = index % 8;
  const packet = expectedSiPacket(step, mode);
  return Object.freeze({
    stepIndex: index,
    sequenceLo: Number(sequence & 0xffff_ffffn),
    sequenceHi: Number(sequence >> 32n),
    minimumCanonicalDelay: step.minimumCanonicalDelay,
    targetCanonicalCycle: target.toString(),
    publicationCanonicalCycle: publication.toString(),
    publicationOvershootCycles: overshoot.toString(),
    buttons: step.buttons,
    stickXyCxy: step.stickXyCxy,
    triggerLrab: step.triggerLrab,
    status: 1,
    siPollIndex: pollIndex.toString(),
    siScheduledCycle: scheduled.toString(),
    siObservedCycle: observed.toString(),
    siAppliedSequenceLo: Number(sequence & 0xffff_ffffn),
    siAppliedSequenceHi: Number(sequence >> 32n),
    siPacketWord0: packet.word0,
    siPacketWord1: packet.word1,
    siSource: 0,
    priorSiPollIndex: priorPollIndex.toString(),
    siControllerMode: mode,
    siButtons: step.buttons,
    siStickXyCxy: step.stickXyCxy,
    siTriggerLrab: step.triggerLrab,
  });
}

function navigationRuntime(policy, transcript = [], {
  runCallOrigin = 0,
  canonicalCycleOrigin = "0",
  siPollIndexOrigin = "0",
  pendingPublication = null,
} = {}) {
  const priorAnchor = transcript.length === 0
    ? BigInt(canonicalCycleOrigin)
    : BigInt(transcript.at(-1).siObservedCycle);
  const nextStep = policy.steps[transcript.length] ?? null;
  return {
    schema: "lazuli-resident-navigation-runtime-v2",
    scriptSha256: policy.scriptSha256,
    stepCount: policy.steps.length,
    durableSteps: transcript.length,
    complete: transcript.length === policy.steps.length && pendingPublication === null,
    runCallOrigin,
    canonicalCycleOrigin,
    siPollIndexOrigin,
    lastReceiptObservedCanonicalCycle: transcript.length === 0 ? null : priorAnchor.toString(),
    nextTargetCanonicalCycle: nextStep === null
      ? null
      : (priorAnchor + BigInt(nextStep.minimumCanonicalDelay)).toString(),
    pendingPublication,
    transcript: structuredClone(transcript),
  };
}

function runSummaryAtReceipt(receipt, publicationCount, overrides = {}) {
  return captureRunSummary({
    issuedRunCalls: publicationCount,
    canonicalCycle: receipt.siObservedCycle,
    reportedCanonicalCycles: receipt.siObservedCycle,
    reportedExecutedCycles: receipt.siObservedCycle,
    reportedExecutedInstructions: String(publicationCount),
    reportedRetiredBlocks: String(publicationCount * 2),
    reportedHostCalls: publicationCount,
    operatorPublications: publicationCount,
    elapsedWallMs: publicationCount,
    ...overrides,
  });
}

function sequenceSha(sequence) {
  return sequence.toString(16).padStart(64, "0");
}

class FakeWorker extends EventTarget {
  constructor() {
    super();
    this.records = [];
    this.terminated = false;
  }

  postMessage(message) {
    this.records.push(structuredClone(message.payload));
    const serverSequence = this.records.length;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "resident-fidelity-checkpoint-ack",
        requestId: message.requestId,
        ack: {
          schema: FIDELITY_CHECKPOINT_ACK_SCHEMA,
          runId: message.payload.runId,
          gameKey: message.payload.gameKey,
          clientSequence: message.payload.clientSequence,
          serverSequence,
          payloadSha256: SHA_A,
          recordSha256: sequenceSha(serverSequence),
          previousRecordSha256: serverSequence === 1
            ? null
            : sequenceSha(serverSequence - 1),
          evidenceLockSha256: LOCK_SHA,
          durable: true,
        },
      },
    })));
  }

  terminate() {
    this.terminated = true;
  }
}

function identity(overrides = {}) {
  return {
    relayRequestId: 7,
    renderCallOrdinal: 3,
    requestFlags: 4,
    sequenceLo: 5,
    sequenceHi: 6,
    opaqueRequestBytes: 1024,
    opaqueRequestSha256: SHA_A,
    presentedBefore: false,
    ...overrides,
  };
}

function byteArtifact(bytes, sha256 = SHA_A) {
  return { bytes, sha256 };
}

function fidelityArtifacts(overrides = {}) {
  return {
    gameFidelityEnvelope: byteArtifact(512, SHA_A),
    gameFidelityOpaque: byteArtifact(384, SHA_B),
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
    runPolicy: CAPTURE_RUN_POLICY,
    runSummary: captureRunSummary(),
    ...overrides,
  };
}

async function resolveSubmission(client, value, receiptSha256 = SHA_B) {
  await client.preSubmit(value);
  await client.submitReturned(value, false);
  const receipt = Uint8Array.of(9, 8, 7);
  const ack = await client.receiptResolved(value, receipt, receiptSha256, true);
  return {
    ...value,
    receiptBytes: receipt.byteLength,
    receiptSha256,
    presentedAfterResolution: true,
    receiptRecordSha256: ack.recordSha256,
  };
}

function runPolicyFor(navigationPolicy) {
  return Object.freeze({ ...CAPTURE_RUN_POLICY, navigationPolicy });
}

function captureInitialization(runPolicy = CAPTURE_RUN_POLICY) {
  return {
    machineSessionId: MACHINE_SESSION_ID,
    bootStatus: 3,
    bootReads: 2,
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
    runPolicy,
    runSummary: captureRunSummary(),
  };
}

async function initializeThroughFirstFrame(client, runPolicy = CAPTURE_RUN_POLICY) {
  await client.captureMachineInitialized(captureInitialization(runPolicy));
  const firstIdentity = identity();
  const firstReceipt = await resolveSubmission(client, firstIdentity);
  await client.firstFrameRendererOwned({
    ...firstReceipt,
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
  });
  return firstReceipt;
}

async function initializeThroughReport(client, runPolicy = CAPTURE_RUN_POLICY) {
  const firstReceipt = await initializeThroughFirstFrame(client, runPolicy);
  await client.firstFrameReportBound({
    report: byteArtifact(4_096, SHA_A),
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
  });
  return firstReceipt;
}

async function completeCapture(client) {
  const firstReceipt = await initializeThroughReport(client);
  let navigation = navigationRuntime(WARIO_NAVIGATION_POLICY);
  await client.navigationArmed({
    machineSessionId: MACHINE_SESSION_ID,
    navigation,
    runSummary: captureRunSummary(),
  });

  const transcript = [];
  let priorAnchor = 0n;
  let priorPollIndex = 0n;
  for (let index = 0; index < WARIO_NAVIGATION_POLICY.steps.length; index += 1) {
    const receipt = navigationReceipt(
      WARIO_NAVIGATION_POLICY,
      index,
      priorAnchor,
      priorPollIndex,
    );
    transcript.push(receipt);
    navigation = navigationRuntime(WARIO_NAVIGATION_POLICY, transcript);
    await client.navigationStepReceived({
      machineSessionId: MACHINE_SESSION_ID,
      navigationStep: receipt,
      navigation,
      runSummary: runSummaryAtReceipt(receipt, index + 1),
    });
    priorAnchor = BigInt(receipt.siObservedCycle);
    priorPollIndex = BigInt(receipt.siPollIndex);
  }

  const finalReceipt = transcript.at(-1);
  const terminalStep = WARIO_NAVIGATION_POLICY.steps.at(-1);
  const baselineReceipt = await resolveSubmission(client, identity({
    relayRequestId: 8,
    renderCallOrdinal: 4,
    sequenceLo: 7,
  }), SHA_A);
  await client.fidelityPhaseOwned("fidelity-baseline-owned", {
    ...baselineReceipt,
    ...fidelityArtifacts(),
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
    requestedButtons: terminalStep.buttons,
    requestedStickXyCxy: terminalStep.stickXyCxy,
    requestedTriggerLrab: terminalStep.triggerLrab,
  });

  await client.controllerWitnessPublished({
    sequenceLo: 35,
    sequenceHi: 0,
    buttons: terminalStep.buttons,
    stickXyCxy: terminalStep.stickXyCxy,
    triggerLrab: terminalStep.triggerLrab,
    status: 9,
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
    navigation,
    runSummary: runSummaryAtReceipt(finalReceipt, transcript.length, {
      witnessPublications: 1,
    }),
  });

  const acceptedReceipt = await resolveSubmission(client, identity({
    relayRequestId: 9,
    renderCallOrdinal: 5,
    sequenceLo: 8,
  }), SHA_A);
  await client.fidelityPhaseOwned("fidelity-accepted-owned", {
    ...acceptedReceipt,
    ...fidelityArtifacts(),
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
  });
  await client.fidelityTerminal({
    ...fidelityArtifacts(),
    navigation,
    runSummary: runSummaryAtReceipt(finalReceipt, transcript.length, {
      accepted: true,
      witnessPublications: 1,
      issuedRunCalls: transcript.length + 1,
    }),
  });
  return { firstReceipt, baselineReceipt, acceptedReceipt, navigation, transcript };
}

test("durable renderer checkpoints preserve the synchronous-return discriminator", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
    timeoutMs: 10_000,
    recordCap: 16,
    probeEventCap: 8,
  });

  await client.preSubmit(identity());
  client.rendererProbeEvent(1, 2, 3, 4, 5, 6);
  await client.submitReturned(identity(), false);
  await client.receiptResolved(identity(), new Uint8Array([9, 8, 7]), SHA_B, true);

  assert.deepEqual(worker.records.map(record => record.kind), [
    "pre-submit",
    "renderer-probe-event",
    "submit-returned",
    "receipt-resolved",
  ]);
  const returned = worker.records[2];
  assert.equal(returned.returnedPromise, true);
  assert.equal(returned.presentedAfterReturn, false);
  assert.equal(Object.hasOwn(returned, "receiptBytes"), false);
  assert.equal(Object.hasOwn(returned, "receiptSha256"), false);
  const resolved = worker.records[3];
  assert.equal(resolved.receiptBytes, 3);
  assert.equal(resolved.receiptSha256, SHA_B);
  assert.equal(resolved.presentedAfterResolution, true);
  assert.deepEqual(worker.records[1].words, [1, 2, 3, 4, 5, 6]);

  assert.deepEqual(client.summary().kindCounts, {
    "pre-submit": 1,
    "renderer-probe-event": 1,
    "submit-returned": 1,
    "receipt-resolved": 1,
  });
  assert.equal(client.summary().openSubmission, false);
  assert.equal(client.summary().recordCount, 4);
  assert.equal(client.summary().evidenceLockSha256, LOCK_SHA);
  assert.equal(client.summary().probeEventPerSubmissionCap, 402);
  assert.equal(client.summary().maximumProbeEventsPerSubmission, 1);
  client.close();
  assert.equal(worker.terminated, true);
});

test("probe events are six opaque u32s and remain inside the fixed cap", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
    recordCap: 8,
    probeEventCap: 1,
  });
  await client.preSubmit(identity());
  assert.throws(() => client.rendererProbeEvent(1, 2, 3), /exactly six/);
  client.rendererProbeEvent(0, 1, 2, 3, 4, 0xffff_ffff);
  assert.throws(
    () => client.rendererProbeEvent(0, 0, 0, 0, 0, 0),
    /probe event cap 1 reached/,
  );
  client.close();
});

test("request identity cannot drift across return or receipt checkpoints", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  await client.preSubmit(identity());
  await assert.rejects(
    client.submitReturned(identity({ sequenceLo: 99 }), false),
    /identity changed/,
  );
  client.close();
});

test("probe events cannot exceed the frozen Rust per-submission bound", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
    recordCap: 500,
    probeEventCap: 500,
  });
  await client.preSubmit(identity());
  for (let index = 0; index < 402; index += 1) {
    client.rendererProbeEvent(0, 0, 0, 0, 0, 0);
  }
  assert.throws(
    () => client.rendererProbeEvent(0, 0, 0, 0, 0, 0),
    /per-submission cap 402 reached/,
  );
  await Promise.resolve();
  assert.equal(client.summary().maximumProbeEventsPerSubmission, 402);
  client.close();
});

test("checkpoint client journals all 34 Wario SI receipts before neutral Baseline", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  const { navigation, transcript } = await completeCapture(client);
  const kinds = worker.records.map(record => record.kind);
  assert.deepEqual(kinds.slice(0, 7), [
    "capture-machine-initialized",
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "first-frame-renderer-owned",
    "first-frame-report-bound",
    "navigation-armed",
  ]);
  assert.equal(
    kinds.filter(kind => kind === "navigation-step-received").length,
    WARIO_NAVIGATION_POLICY.steps.length,
  );
  assert.deepEqual(kinds.slice(-10), [
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "fidelity-baseline-owned",
    "controller-witness-published",
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "fidelity-accepted-owned",
    "fidelity-terminal",
  ]);
  const firstOwned = worker.records[4];
  const report = worker.records[5];
  const arm = worker.records[6];
  const navigationRecords = worker.records.filter(
    record => record.kind === "navigation-step-received",
  );
  const finalNavigation = navigationRecords.at(-1);
  const baseline = worker.records.find(record => record.kind === "fidelity-baseline-owned");
  const witness = worker.records.find(record => record.kind === "controller-witness-published");
  const accepted = worker.records.find(record => record.kind === "fidelity-accepted-owned");
  const terminal = worker.records.at(-1);
  const terminalStep = WARIO_NAVIGATION_POLICY.steps.at(-1);
  const terminalPacket = expectedSiPacket(terminalStep, finalNavigation.siControllerMode);

  assert.equal(firstOwned.receiptRecordSha256, sequenceSha(4));
  assert.equal(report.firstFrameRendererRecordSha256, sequenceSha(5));
  assert.equal(report.baselineRecordSha256, null);
  assert.equal(arm.firstFrameReportRecordSha256, sequenceSha(6));
  assert.equal(arm.stepCount, 34);
  assert.equal(arm.runCallOrigin, 0);
  assert.equal(arm.canonicalCycleOrigin, "0");
  assert.equal(navigationRecords[0].stepIndex, 0);
  assert.equal(finalNavigation.stepIndex, 33);
  assert.equal(finalNavigation.sequenceLo, 34);
  assert.equal(finalNavigation.sequenceHi, 0);
  assert.equal(finalNavigation.siAppliedSequenceLo, 34);
  assert.equal(finalNavigation.siAppliedSequenceHi, 0);
  assert.equal(finalNavigation.siSource, 0);
  assert.equal(finalNavigation.siControllerMode, 1);
  assert.equal(finalNavigation.siPacketWord0, terminalPacket.word0);
  assert.equal(finalNavigation.siPacketWord1, terminalPacket.word1);
  assert.equal(finalNavigation.buttons, 0);
  assert.equal(finalNavigation.stickXyCxy, 0x8080_8080);
  assert.equal(finalNavigation.triggerLrab, 0);
  assert.equal(finalNavigation.siButtons, 0);
  assert.equal(finalNavigation.siStickXyCxy, 0x8080_8080);
  assert.equal(finalNavigation.siTriggerLrab, 0);
  assert.equal(finalNavigation.runSummary.operatorPublications, 34);
  assert.equal(finalNavigation.runSummary.reportedRetiredBlocks, "68");
  assert.equal(finalNavigation.runSummary.canonicalCycle, finalNavigation.siObservedCycle);
  assert.equal(baseline.receiptRecordSha256, sequenceSha(44));
  assert.equal(baseline.requestedButtons, terminalStep.buttons);
  assert.equal(baseline.requestedStickXyCxy, terminalStep.stickXyCxy);
  assert.equal(baseline.requestedTriggerLrab, terminalStep.triggerLrab);
  assert.equal(witness.baselineRecordSha256, sequenceSha(45));
  assert.equal(witness.firstFrameReportRecordSha256, sequenceSha(6));
  assert.equal(witness.lastNavigationStepRecordSha256, sequenceSha(41));
  assert.equal(witness.navigationStepCount, 34);
  assert.equal(accepted.witnessRecordSha256, sequenceSha(46));
  assert.equal(terminal.acceptedRecordSha256, sequenceSha(50));
  assert.equal(terminal.lastNavigationStepRecordSha256, sequenceSha(41));
  assert.equal(terminal.navigationStepCount, 34);
  assert.equal(terminal.runSummary.operatorPublications, 34);
  assert.equal(terminal.runSummary.witnessPublications, 1);
  assert.equal(terminal.machineSessionId, MACHINE_SESSION_ID);
  assert.equal(navigation.complete, true);
  assert.equal(transcript.length, 34);
  assert.deepEqual(transcript.at(-1), navigation.transcript.at(-1));
  assert.equal(client.summary().navigationStepRecords, 34);
  assert.equal(client.summary().recordCount, 51);
  await assert.rejects(
    client.preSubmit(identity({ relayRequestId: 99 })),
    /terminal record/,
  );
  client.close();
});

test("v2 summaries preserve intermediate host/cold and cumulative retired authority", () => {
  const projected = captureRunSummary({
    issuedRunCalls: 2,
    canonicalCycle: "17",
    reportedCanonicalCycles: "17",
    reportedExecutedCycles: "19",
    reportedExecutedInstructions: "11",
    reportedRetiredBlocks: "65536",
    reportedHostCalls: 7,
    reportedColdInstalls: 3,
    elapsedWallMs: 2,
  });
  const validated = validateCaptureRunSummary(
    projected,
    CAPTURE_RUN_POLICY,
    "intermediate projected summary",
    false,
  );
  assert.equal(validated.schema, "lazuli-resident-cumulative-run-summary-v2");
  assert.equal(validated.canonicalCycle, "17");
  assert.equal(validated.reportedRetiredBlocks, "65536");
  assert.equal(validated.reportedHostCalls, 7);
  assert.equal(validated.reportedColdInstalls, 3);

  assert.throws(() => validateCaptureRunSummary({
    ...projected,
    reportedCanonicalCycles: (BigInt(CAPTURE_RUN_POLICY.canonicalCycleUpperCap) + 1n).toString(),
  }, CAPTURE_RUN_POLICY, "canonical cap", false), /exceeded the frozen cumulative authority/);
  assert.throws(() => validateCaptureRunSummary({
    ...projected,
    reportedRetiredBlocks: "65.5",
  }, CAPTURE_RUN_POLICY, "retired authority", false), /unsigned decimal string/);
  assert.throws(() => validateCaptureRunSummary({
    ...projected,
    reportedHostCalls: CAPTURE_RUN_POLICY.totalHostCallCap + 1,
  }, CAPTURE_RUN_POLICY, "host cap", false), /exceeded the frozen cumulative authority/);
  assert.throws(() => validateCaptureRunSummary({
    ...projected,
    reportedColdInstalls: CAPTURE_RUN_POLICY.totalColdInstallCap + 1,
  }, CAPTURE_RUN_POLICY, "cold cap", false), /exceeded the frozen cumulative authority/);
});

test("navigation rejects early and over-slice publication but accepts bounded unalignment", () => {
  const receipt = navigationReceipt(WARIO_NAVIGATION_POLICY, 0, 0n, 0n, {
    overshoot: 1n,
  });
  const valid = captureNavigationRuntime(
    navigationRuntime(WARIO_NAVIGATION_POLICY, [receipt]),
    CAPTURE_RUN_POLICY,
    "unaligned runtime",
  );
  assert.equal(valid.transcript[0].publicationOvershootCycles, "1");

  const target = BigInt(receipt.targetCanonicalCycle);
  const early = {
    ...receipt,
    publicationCanonicalCycle: (target - 1n).toString(),
    publicationOvershootCycles: "0",
    siScheduledCycle: target.toString(),
    siObservedCycle: (target + 1n).toString(),
  };
  assert.throws(() => captureNavigationRuntime(
    navigationRuntime(WARIO_NAVIGATION_POLICY, [early]),
    CAPTURE_RUN_POLICY,
    "early runtime",
  ), /changed its locked publication/);

  const tooLate = navigationReceipt(WARIO_NAVIGATION_POLICY, 0, 0n, 0n, {
    overshoot: BigInt(CAPTURE_RUN_POLICY.sliceCycleUpperCap) + 1n,
  });
  assert.throws(() => captureNavigationRuntime(
    navigationRuntime(WARIO_NAVIGATION_POLICY, [tooLate]),
    CAPTURE_RUN_POLICY,
    "over-slice runtime",
  ), /changed its locked publication/);
});

test("navigation SI receipts authenticate sequence, source, mode, semantics, packet, and poll", () => {
  const base = navigationReceipt(WARIO_NAVIGATION_POLICY, 0, 0n, 0n, { overshoot: 1n });
  const mutations = [
    ["applied sequence", { siAppliedSequenceLo: base.siAppliedSequenceLo + 1 }],
    ["source", { siSource: 1 }],
    ["mode", { siControllerMode: 8 }],
    ["status", { status: 0 }],
    ["controller semantics", { siButtons: base.siButtons ^ 1 }],
    ["packet", { siPacketWord1: (base.siPacketWord1 ^ 1) >>> 0 }],
    ["poll", { siPollIndex: base.priorSiPollIndex }],
  ];
  for (const [label, mutation] of mutations) {
    assert.throws(() => captureNavigationRuntime(
      navigationRuntime(WARIO_NAVIGATION_POLICY, [{ ...base, ...mutation }]),
      CAPTURE_RUN_POLICY,
      `${label} runtime`,
    ), /changed its locked publication/, label);
  }

  const second = navigationReceipt(
    WARIO_NAVIGATION_POLICY,
    1,
    BigInt(base.siObservedCycle),
    BigInt(base.siPollIndex),
  );
  const repeatedSequence = {
    ...second,
    sequenceLo: base.sequenceLo,
    sequenceHi: base.sequenceHi,
    siAppliedSequenceLo: base.sequenceLo,
    siAppliedSequenceHi: base.sequenceHi,
  };
  assert.throws(() => captureNavigationRuntime(
    navigationRuntime(WARIO_NAVIGATION_POLICY, [base, repeatedSequence]),
    CAPTURE_RUN_POLICY,
    "repeated sequence runtime",
  ), /changed its locked publication/);
});

test("capture initialization requires complete boot within the locked read cap", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  const initialization = captureInitialization();
  await assert.rejects(
    client.captureMachineInitialized({ ...initialization, bootStatus: 1 }),
    /ready boot authority/,
  );
  await assert.rejects(
    client.captureMachineInitialized({ ...initialization, bootReads: 9 }),
    /ready boot authority/,
  );
  assert.equal(worker.records.length, 0);
  await client.captureMachineInitialized(initialization);
  assert.equal(worker.records.length, 1);
  client.close();
});

test("navigation arm requires report binding and Wario Baseline requires all receipts", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  const firstReceipt = await initializeThroughFirstFrame(client);
  const navigation = navigationRuntime(WARIO_NAVIGATION_POLICY);
  const arm = {
    machineSessionId: MACHINE_SESSION_ID,
    navigation,
    runSummary: captureRunSummary(),
  };
  await assert.rejects(client.navigationArmed(arm), /durable first-frame report/);
  await client.firstFrameReportBound({
    report: byteArtifact(4_096, SHA_A),
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
  });
  await assert.rejects(
    client.fidelityPhaseOwned("fidelity-baseline-owned", {
      ...firstReceipt,
      ...fidelityArtifacts(),
      readbackMetadata: byteArtifact(96, SHA_A),
      rgba: byteArtifact(640 * 480 * 4, SHA_B),
      requestedButtons: 0,
      requestedStickXyCxy: 0x8080_8080,
      requestedTriggerLrab: 0,
    }),
    /complete locked navigation transcript/,
  );
  await client.navigationArmed(arm);
  await assert.rejects(
    client.fidelityPhaseOwned("fidelity-baseline-owned", {
      ...firstReceipt,
      ...fidelityArtifacts(),
      readbackMetadata: byteArtifact(96, SHA_A),
      rgba: byteArtifact(640 * 480 * 4, SHA_B),
      requestedButtons: 0,
      requestedStickXyCxy: 0x8080_8080,
      requestedTriggerLrab: 0,
    }),
    /complete locked navigation transcript/,
  );
  assert.equal(worker.records.at(-1).kind, "navigation-armed");
  client.close();
});

test("empty navigation can arm after Baseline without synthetic publications", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  const emptyRunPolicy = runPolicyFor(EMPTY_NAVIGATION_POLICY);
  const receipt = await initializeThroughFirstFrame(client, emptyRunPolicy);
  await assert.rejects(
    client.fidelityPhaseOwned("fidelity-baseline-owned", {
      ...receipt,
      ...fidelityArtifacts(),
      readbackMetadata: byteArtifact(96, SHA_A),
      rgba: byteArtifact(640 * 480 * 4, SHA_A),
      requestedButtons: 0,
      requestedStickXyCxy: 0x8080_8080,
      requestedTriggerLrab: 0,
    }),
    /same-receipt Baseline did not reuse/,
  );
  await client.fidelityPhaseOwned("fidelity-baseline-owned", {
    ...receipt,
    ...fidelityArtifacts(),
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
    requestedButtons: 0,
    requestedStickXyCxy: 0x8080_8080,
    requestedTriggerLrab: 0,
  });
  await client.firstFrameReportBound({
    report: byteArtifact(100),
    machineEvidenceEnvelope: byteArtifact(1_024),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
  });
  const navigation = navigationRuntime(EMPTY_NAVIGATION_POLICY);
  await client.navigationArmed({
    machineSessionId: MACHINE_SESSION_ID,
    navigation,
    runSummary: captureRunSummary(),
  });
  const witness = {
    sequenceLo: 1,
    sequenceHi: 0,
    buttons: 0,
    stickXyCxy: 0x8080_8080,
    triggerLrab: 0,
    status: 9,
    machineEvidenceEnvelope: byteArtifact(1_024),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
    navigation,
    runSummary: captureRunSummary({ witnessPublications: 1 }),
  };
  await assert.rejects(
    client.controllerWitnessPublished({ ...witness, stickXyCxy: 0x8080_8081 }),
    /differed from the durable Rust Baseline request/,
  );
  await client.controllerWitnessPublished(witness);
  const acceptedReceipt = await resolveSubmission(client, identity({
    relayRequestId: 8,
    renderCallOrdinal: 4,
    sequenceLo: 7,
  }), SHA_A);
  await client.fidelityPhaseOwned("fidelity-accepted-owned", {
    ...acceptedReceipt,
    ...fidelityArtifacts(),
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
  });
  await assert.rejects(
    client.fidelityTerminal({
      ...fidelityArtifacts({ gameFidelityOpaque: byteArtifact(384, SHA_A) }),
      navigation,
      runSummary: captureRunSummary({
        accepted: true,
        witnessPublications: 1,
      }),
    }),
    /differ from the hard Accepted boundary/,
  );
  await client.fidelityTerminal({
    ...fidelityArtifacts(),
    navigation,
    runSummary: captureRunSummary({ accepted: true, witnessPublications: 1 }),
  });
  assert.deepEqual(worker.records.map(record => record.kind), [
    "capture-machine-initialized",
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "first-frame-renderer-owned",
    "fidelity-baseline-owned",
    "first-frame-report-bound",
    "navigation-armed",
    "controller-witness-published",
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "fidelity-accepted-owned",
    "fidelity-terminal",
  ]);
  assert.equal(client.summary().navigationStepRecords, 0);
  assert.equal(worker.records[7].stepCount, 0);
  assert.equal(worker.records[8].navigationStepCount, 0);
  assert.equal(worker.records.at(-1).navigationStepCount, 0);
  assert.equal(worker.records.at(-1).lastNavigationStepRecordSha256, null);
  client.close();
});
