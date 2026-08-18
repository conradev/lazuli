// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIDELITY_CHECKPOINT_ACK_SCHEMA,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  ResidentFidelityCheckpointClient,
} from "./resident_machine_fidelity_checkpoints.mjs";

const RUN_ID = "12345678-1234-4234-9234-123456789abc";
const GAME_KEY = "warioware-usa";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const LOCK_SHA = "c".repeat(64);
const MACHINE_SESSION_ID = "87654321-4321-4321-8321-cba987654321";

test("production v3 cycle authority is an exact decimal string", () => {
  assert.equal(PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP, "2500000000");
  assert.equal(typeof PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP, "string");
});

const CAPTURE_RUN_POLICY = Object.freeze({
  instructionUpperCap: "100",
  executedCycleUpperCap: "200",
  sliceCycleUpperCap: "10",
  blockUpperCap: 16,
  totalHostCallCap: 20,
  totalColdInstallCap: 20,
  maxBootReads: 8,
  bootTimeoutMs: 1_000,
  sliceTimeoutMs: 1_000,
  runTimeoutMs: 10_000,
  externalWallTimeoutMs: 10_000,
  zeroProgressSliceCap: 4,
  workerUrl: "/worker.mjs",
});

function captureRunSummary({ accepted = false, witnessPublications = 0 } = {}) {
  return {
    schema: "lazuli-resident-cumulative-run-summary-v1",
    issuedRunCalls: accepted ? 2 : 0,
    reportedExecutedCycles: accepted ? "20" : "0",
    reportedExecutedInstructions: accepted ? "40" : "0",
    reportedHostCalls: accepted ? 2 : 0,
    reportedColdInstalls: 0,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    operatorPublications: 0,
    witnessPublications,
    elapsedWallMs: accepted ? 20 : 0,
    wallTimeoutMs: 10_000,
    accepted,
  };
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

async function completeCapture(client, { distinctBaselineReceipt = false } = {}) {
  await client.captureMachineInitialized({
    machineSessionId: MACHINE_SESSION_ID,
    bootStatus: 3,
    bootReads: 2,
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
    runPolicy: CAPTURE_RUN_POLICY,
    runSummary: captureRunSummary(),
  });
  const firstIdentity = identity();
  const firstReceipt = await resolveSubmission(client, firstIdentity);
  await client.firstFrameRendererOwned({
    ...firstReceipt,
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
  });

  const baselineReceipt = distinctBaselineReceipt
    ? await resolveSubmission(client, identity({
      relayRequestId: 8,
      renderCallOrdinal: 4,
      sequenceLo: 7,
    }), SHA_A)
    : firstReceipt;
  await client.fidelityPhaseOwned("fidelity-baseline-owned", {
    ...baselineReceipt,
    ...fidelityArtifacts(),
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
    requestedButtons: 1,
    requestedStickXyCxy: 0x8080_8001,
    requestedTriggerLrab: 0,
  });
  await client.firstFrameReportBound({
    report: byteArtifact(4_096, SHA_A),
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
  });
  await client.controllerWitnessPublished({
    sequenceLo: 1,
    sequenceHi: 0,
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
    status: 9,
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
  });

  const acceptedReceipt = await resolveSubmission(client, identity({
    relayRequestId: distinctBaselineReceipt ? 9 : 8,
    renderCallOrdinal: distinctBaselineReceipt ? 5 : 4,
    sequenceLo: distinctBaselineReceipt ? 8 : 7,
  }), SHA_A);
  await client.fidelityPhaseOwned("fidelity-accepted-owned", {
    ...acceptedReceipt,
    ...fidelityArtifacts(),
    readbackMetadata: byteArtifact(96, SHA_A),
    rgba: byteArtifact(640 * 480 * 4, SHA_B),
  });
  await client.fidelityTerminal({
    ...fidelityArtifacts(),
    runSummary: captureRunSummary({ accepted: true, witnessPublications: 1 }),
  });
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

test("checkpoint client emits the complete same-receipt Baseline capture chain", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  await completeCapture(client);
  assert.deepEqual(worker.records.map(record => record.kind), [
    "capture-machine-initialized",
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "first-frame-renderer-owned",
    "fidelity-baseline-owned",
    "first-frame-report-bound",
    "controller-witness-published",
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "fidelity-accepted-owned",
    "fidelity-terminal",
  ]);
  const firstOwned = worker.records[4];
  const baseline = worker.records[5];
  const report = worker.records[6];
  const witness = worker.records[7];
  const accepted = worker.records[11];
  const terminal = worker.records[12];
  assert.equal(firstOwned.receiptRecordSha256, sequenceSha(4));
  assert.equal(baseline.receiptRecordSha256, sequenceSha(4));
  assert.equal(baseline.requestedStickXyCxy, 0x8080_8001);
  assert.equal(report.firstFrameRendererRecordSha256, sequenceSha(5));
  assert.equal(report.baselineRecordSha256, sequenceSha(6));
  assert.equal(witness.baselineRecordSha256, sequenceSha(6));
  assert.equal(witness.firstFrameReportRecordSha256, sequenceSha(7));
  assert.equal(accepted.witnessRecordSha256, sequenceSha(8));
  assert.equal(terminal.acceptedRecordSha256, sequenceSha(12));
  assert.equal(terminal.machineSessionId, MACHINE_SESSION_ID);
  assert.equal(client.summary().recordCount, 13);
  await assert.rejects(
    client.preSubmit(identity({ relayRequestId: 99 })),
    /terminal record/,
  );
  client.close();
});

test("capture initialization requires complete boot within the locked read cap", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  const initialization = {
    machineSessionId: MACHINE_SESSION_ID,
    bootStatus: 3,
    bootReads: 2,
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
    runPolicy: CAPTURE_RUN_POLICY,
    runSummary: captureRunSummary(),
  };
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

test("checkpoint client permits a distinct resolved Baseline receipt before report binding", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  await completeCapture(client, { distinctBaselineReceipt: true });
  const kinds = worker.records.map(record => record.kind);
  assert.deepEqual(kinds.slice(4, 10), [
    "first-frame-renderer-owned",
    "pre-submit",
    "submit-returned",
    "receipt-resolved",
    "fidelity-baseline-owned",
    "first-frame-report-bound",
  ]);
  assert.notEqual(
    worker.records[4].receiptRecordSha256,
    worker.records[8].receiptRecordSha256,
  );
  assert.equal(worker.records.at(-1).kind, "fidelity-terminal");
  client.close();
});

test("checkpoint client rejects witness word drift and terminal artifact inequality", async () => {
  const worker = new FakeWorker();
  const client = new ResidentFidelityCheckpointClient(worker, {
    runId: RUN_ID,
    gameKey: GAME_KEY,
    evidenceLockSha256: LOCK_SHA,
  });
  await client.captureMachineInitialized({
    machineSessionId: MACHINE_SESSION_ID,
    bootStatus: 3,
    bootReads: 2,
    machineEvidenceEnvelope: byteArtifact(1_024, SHA_A),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
    runPolicy: CAPTURE_RUN_POLICY,
    runSummary: captureRunSummary(),
  });
  const receipt = await resolveSubmission(client, identity());
  await client.firstFrameRendererOwned({
    ...receipt,
    readbackMetadata: byteArtifact(96),
    rgba: byteArtifact(16, SHA_B),
  });
  await assert.rejects(
    client.fidelityPhaseOwned("fidelity-baseline-owned", {
      ...receipt,
      ...fidelityArtifacts(),
      readbackMetadata: byteArtifact(96),
      rgba: byteArtifact(16, SHA_A),
      requestedButtons: 1,
      requestedStickXyCxy: 0x8080_8001,
      requestedTriggerLrab: 0,
    }),
    /same-receipt Baseline did not reuse/,
  );
  await client.fidelityPhaseOwned("fidelity-baseline-owned", {
    ...receipt,
    ...fidelityArtifacts(),
    readbackMetadata: byteArtifact(96),
    rgba: byteArtifact(16, SHA_B),
    requestedButtons: 1,
    requestedStickXyCxy: 0x8080_8001,
    requestedTriggerLrab: 0,
  });
  await client.firstFrameReportBound({
    report: byteArtifact(100),
    machineEvidenceEnvelope: byteArtifact(1_024),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
  });
  const witness = {
    sequenceLo: 1,
    sequenceHi: 0,
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
    status: 9,
    machineEvidenceEnvelope: byteArtifact(1_024),
    machineEvidenceOpaque: byteArtifact(816, SHA_B),
  };
  await assert.rejects(
    client.controllerWitnessPublished({ ...witness, stickXyCxy: 0x8080_8080 }),
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
    readbackMetadata: byteArtifact(96),
    rgba: byteArtifact(16, SHA_B),
  });
  await assert.rejects(
    client.fidelityTerminal(fidelityArtifacts({
      gameFidelityOpaque: byteArtifact(384, SHA_A),
    })),
    /differ from the hard Accepted boundary/,
  );
  await client.fidelityTerminal({
    ...fidelityArtifacts(),
    runSummary: captureRunSummary({ accepted: true, witnessPublications: 1 }),
  });
  client.close();
});
