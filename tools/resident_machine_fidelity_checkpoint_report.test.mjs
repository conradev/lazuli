// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalFidelityJson,
  parseFidelityCheckpointJsonl,
  validateFidelityCheckpointJournal,
} from "./resident_machine_fidelity_checkpoint_report.mjs";
import {
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
} from "./resident_machine_fidelity_lock.mjs";

const RUN_ID = "12345678-1234-4234-9234-123456789abc";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const HOST_SHA = "f".repeat(64);
const LOCK_SHA = "e".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const MACHINE_SESSION_ID = "87654321-4321-4321-8321-cba987654321";
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

function captureRunSummary(accepted = false, operatorPublications = 0) {
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
    operatorPublications,
    witnessPublications: accepted ? 1 : 0,
    elapsedWallMs: accepted ? 20 : 0,
    wallTimeoutMs: 10_000,
    accepted,
  };
}

function validateJournal(value, options = {}) {
  return validateFidelityCheckpointJournal(value, {
    evidenceLockSha256: LOCK_SHA,
    expectedHostIdentitySha256: HOST_SHA,
    ...options,
  });
}

function hash(value) {
  return createHash("sha256").update(canonicalFidelityJson(value)).digest("hex");
}

function identity(overrides = {}) {
  return {
    relayRequestId: 1,
    renderCallOrdinal: 1,
    requestFlags: 2,
    sequenceLo: 3,
    sequenceHi: 4,
    opaqueRequestBytes: 5,
    opaqueRequestSha256: SHA_A,
    presentedBefore: false,
    ...overrides,
  };
}

function payload(clientSequence, kind, fields) {
  return {
    schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
    runId: RUN_ID,
    gameKey: "warioware-usa",
    clientSequence,
    kind,
    ...fields,
  };
}

function records(payloads) {
  let previousRecordSha256 = null;
  return payloads.map((entry, index) => {
    const core = {
      schema: "lazuli-resident-renderer-fidelity-durable-record-v1",
      serverSequence: index + 1,
      receivedAtUnixMs: 1_800_000_000_000 + index,
      hostIdentitySha256: HOST_SHA,
      evidenceLockSha256: LOCK_SHA,
      previousRecordSha256,
      payloadSha256: hash(entry),
      payload: entry,
    };
    const record = { ...core, recordSha256: hash(core) };
    previousRecordSha256 = record.recordSha256;
    return record;
  });
}

function fidelityArtifactFields(overrides = {}) {
  return {
    gameFidelityEnvelopeBytes: 512,
    gameFidelityEnvelopeSha256: SHA_A,
    gameFidelityOpaqueBytes: 384,
    gameFidelityOpaqueSha256: SHA_B,
    machineEvidenceEnvelopeBytes: 1_024,
    machineEvidenceEnvelopeSha256: SHA_C,
    machineEvidenceOpaqueBytes: 816,
    machineEvidenceOpaqueSha256: SHA_D,
    ...overrides,
  };
}

function readbackFields() {
  return {
    readbackMetadataBytes: 96,
    readbackMetadataSha256: SHA_C,
    rgbaBytes: 640 * 480 * 4,
    rgbaSha256: SHA_D,
  };
}

class ProductionJournalBuilder {
  constructor() {
    this.payloads = [];
    this.value = [];
  }

  append(kind, fields) {
    this.payloads.push(payload(this.payloads.length + 1, kind, fields));
    this.value = records(this.payloads);
    return this.value.at(-1);
  }
}

function appendResolvedReceipt(builder, submission, receiptSha256 = SHA_B) {
  builder.append("pre-submit", submission);
  builder.append("submit-returned", {
    ...submission,
    returnedPromise: true,
    presentedAfterReturn: false,
  });
  const receiptRecord = builder.append("receipt-resolved", {
    ...submission,
    receiptBytes: 7,
    receiptSha256,
    presentedAfterResolution: true,
  });
  return {
    ...submission,
    receiptBytes: 7,
    receiptSha256,
    presentedAfterResolution: true,
    receiptRecordSha256: receiptRecord.recordSha256,
  };
}

function productionJournal({
  distinctBaselineReceipt = false,
  operatorPublications = 0,
} = {}) {
  const builder = new ProductionJournalBuilder();
  const initialized = builder.append("capture-machine-initialized", {
    machineSessionId: MACHINE_SESSION_ID,
    bootStatus: 3,
    bootReads: 2,
    machineEvidenceEnvelopeBytes: 1_024,
    machineEvidenceEnvelopeSha256: SHA_C,
    machineEvidenceOpaqueBytes: 816,
    machineEvidenceOpaqueSha256: SHA_D,
    runPolicy: CAPTURE_RUN_POLICY,
    runSummary: captureRunSummary(false),
  });
  const firstReceipt = appendResolvedReceipt(builder, identity());
  const firstFrame = builder.append("first-frame-renderer-owned", {
    ...firstReceipt,
    machineSessionId: MACHINE_SESSION_ID,
    ...readbackFields(),
  });
  const baselineReceipt = distinctBaselineReceipt
    ? appendResolvedReceipt(builder, identity({
      relayRequestId: 2,
      renderCallOrdinal: 2,
      sequenceLo: 30,
      sequenceHi: 40,
      opaqueRequestSha256: SHA_C,
    }), SHA_C)
    : firstReceipt;
  const baseline = builder.append("fidelity-baseline-owned", {
    ...baselineReceipt,
    machineSessionId: MACHINE_SESSION_ID,
    phase: 1,
    ...fidelityArtifactFields(),
    ...readbackFields(),
    requestedButtons: 1,
    requestedStickXyCxy: 0x8080_8001,
    requestedTriggerLrab: 0,
  });
  const report = builder.append("first-frame-report-bound", {
    machineSessionId: MACHINE_SESSION_ID,
    reportBytes: 4_096,
    reportSha256: SHA_A,
    machineEvidenceEnvelopeBytes: 1_024,
    machineEvidenceEnvelopeSha256: SHA_C,
    machineEvidenceOpaqueBytes: 816,
    machineEvidenceOpaqueSha256: SHA_D,
    firstFrameRendererRecordSha256: firstFrame.recordSha256,
    baselineRecordSha256: baseline.recordSha256,
  });
  const witness = builder.append("controller-witness-published", {
    machineSessionId: MACHINE_SESSION_ID,
    baselineRecordSha256: baseline.recordSha256,
    firstFrameReportRecordSha256: report.recordSha256,
    sequenceLo: 1,
    sequenceHi: 0,
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
    status: 9,
    machineEvidenceEnvelopeBytes: 1_024,
    machineEvidenceEnvelopeSha256: SHA_C,
    machineEvidenceOpaqueBytes: 816,
    machineEvidenceOpaqueSha256: SHA_D,
  });
  const acceptedReceipt = appendResolvedReceipt(builder, identity({
    relayRequestId: distinctBaselineReceipt ? 3 : 2,
    renderCallOrdinal: distinctBaselineReceipt ? 3 : 2,
    sequenceLo: distinctBaselineReceipt ? 50 : 30,
    sequenceHi: distinctBaselineReceipt ? 60 : 40,
    opaqueRequestSha256: SHA_D,
  }), SHA_D);
  const accepted = builder.append("fidelity-accepted-owned", {
    ...acceptedReceipt,
    machineSessionId: MACHINE_SESSION_ID,
    phase: 5,
    ...fidelityArtifactFields(),
    ...readbackFields(),
    witnessRecordSha256: witness.recordSha256,
  });
  const terminal = builder.append("fidelity-terminal", {
    machineSessionId: MACHINE_SESSION_ID,
    phase: 5,
    baselineRecordSha256: baseline.recordSha256,
    acceptedRecordSha256: accepted.recordSha256,
    ...fidelityArtifactFields(),
    runSummary: captureRunSummary(true, operatorPublications),
  });
  return {
    records: builder.value,
    refs: {
      initialized: initialized.recordSha256,
      firstFrame: firstFrame.recordSha256,
      baseline: baseline.recordSha256,
      report: report.recordSha256,
      witness: witness.recordSha256,
      accepted: accepted.recordSha256,
      terminal: terminal.recordSha256,
    },
  };
}

function rebuiltWithMutation(journal, mutate) {
  const payloads = journal.map(record => structuredClone(record.payload));
  mutate(payloads);
  return records(payloads);
}

function validateProduction(journal) {
  return validateJournal(journal, {
    requireResolved: true,
    probeEventPolicy: "forbidden",
    capturePolicy: "required",
  });
}

test("journal distinguishes synchronous return from receipt resolution", () => {
  const complete = records([
    payload(1, "pre-submit", identity()),
    payload(2, "renderer-probe-event", {
      relayRequestId: 1,
      renderCallOrdinal: 1,
      words: [1, 2, 3, 4, 5, 6],
    }),
    payload(3, "submit-returned", {
      ...identity(),
      returnedPromise: true,
      presentedAfterReturn: false,
    }),
    payload(4, "receipt-resolved", {
      ...identity(),
      receiptBytes: 7,
      receiptSha256: SHA_B,
      presentedAfterResolution: true,
    }),
  ]);
  const summary = validateJournal(complete, { requireResolved: true });
  assert.equal(summary.terminalBoundary, "all-receipts-resolved");
  assert.equal(summary.submissions, 1);
  assert.equal(summary.submitReturns, 1);
  assert.equal(summary.receipts, 1);
  assert.equal(summary.probeEvents, 1);
  assert.equal(summary.probeEventCap, 32_768);
  assert.equal(summary.probeEventPerSubmissionCap, 402);
  assert.equal(summary.maximumProbeEventsPerSubmission, 1);
  assert.equal(summary.rendererProbeWordsInterpreted, 0);

  const synchronousStall = validateJournal(complete.slice(0, 2));
  assert.equal(synchronousStall.terminalBoundary, "submit-method-did-not-return");
  assert.throws(
    () => validateJournal(complete.slice(0, 2), { requireResolved: true }),
    /fully resolved/,
  );

  const notYetObserved = validateJournal(complete.slice(0, 3));
  assert.equal(
    notYetObserved.terminalBoundary,
    "submit-returned-receipt-not-yet-observed",
  );
});

test("production default-off journals require a resolved zero-probe chain", () => {
  const zeroProbe = records([
    payload(1, "pre-submit", identity()),
    payload(2, "submit-returned", {
      ...identity(),
      returnedPromise: true,
      presentedAfterReturn: false,
    }),
    payload(3, "receipt-resolved", {
      ...identity(),
      receiptBytes: 7,
      receiptSha256: SHA_B,
      presentedAfterResolution: true,
    }),
  ]);
  const summary = validateJournal(zeroProbe, {
    requireResolved: true,
    probeEventPolicy: "forbidden",
  });
  assert.equal(summary.terminalBoundary, "all-receipts-resolved");
  assert.equal(summary.probeEvents, 0);
  assert.throws(
    () => validateJournal(zeroProbe, { requireResolved: true }),
    /at least one authenticated renderer probe event/,
  );

  const injected = records([
    zeroProbe[0].payload,
    payload(2, "renderer-probe-event", {
      relayRequestId: 1,
      renderCallOrdinal: 1,
      words: [1, 2, 3, 4, 5, 6],
    }),
    payload(3, "submit-returned", {
      ...identity(),
      returnedPromise: true,
      presentedAfterReturn: false,
    }),
    payload(4, "receipt-resolved", {
      ...identity(),
      receiptBytes: 7,
      receiptSha256: SHA_B,
      presentedAfterResolution: true,
    }),
  ]);
  assert.throws(
    () => validateJournal(injected, {
      requireResolved: true,
      probeEventPolicy: "forbidden",
    }),
    /forbidden by the production default-off renderer lock/,
  );
});

test("journal independently enforces the frozen renderer probe event cap", () => {
  const fixture = records([
    payload(1, "pre-submit", identity()),
    payload(2, "renderer-probe-event", {
      relayRequestId: 1,
      renderCallOrdinal: 1,
      words: [1, 2, 3, 4, 5, 6],
    }),
    payload(3, "renderer-probe-event", {
      relayRequestId: 1,
      renderCallOrdinal: 1,
      words: [7, 8, 9, 10, 11, 12],
    }),
  ]);
  assert.throws(
    () => validateJournal(fixture, { probeEventCap: 1 }),
    /probe event cap exceeded/,
  );
  assert.throws(
    () => validateJournal(fixture, { probeEventCap: 32_769 }),
    /32768/,
  );
});

test("journal rejects more than 402 opaque probe events for one submission", () => {
  const payloads = [payload(1, "pre-submit", identity())];
  for (let index = 0; index < 403; index += 1) {
    payloads.push(payload(index + 2, "renderer-probe-event", {
      relayRequestId: 1,
      renderCallOrdinal: 1,
      words: [0, 0, 0, 0, 0, 0],
    }));
  }
  assert.throws(
    () => validateJournal(records(payloads)),
    /per-submission cap exceeded/,
  );
});

test("journal rejects payload, record, identity, and ordering rewrites", () => {
  const fixture = records([
    payload(1, "pre-submit", identity()),
    payload(2, "submit-returned", {
      ...identity(),
      returnedPromise: true,
      presentedAfterReturn: false,
    }),
  ]);
  for (const mutate of [
    value => { value[0].payload.opaqueRequestBytes += 1; },
    value => { value[1].previousRecordSha256 = SHA_A; },
    value => { value[1].payload.sequenceLo = 99; },
    value => { delete value[1].payload.returnedPromise; },
    value => { value[1].evidenceLockSha256 = SHA_A; },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => validateJournal(changed));
  }
});

test("JSONL parser retains one canonical record per nonempty line", () => {
  const fixture = records([payload(1, "pre-submit", identity())]);
  const text = `${JSON.stringify(fixture[0])}\n\n`;
  assert.deepEqual(parseFidelityCheckpointJsonl(text), fixture);
});

test("production journal accepts one continuous same-receipt Baseline chain", () => {
  const fixture = productionJournal();
  const summary = validateProduction(fixture.records);
  assert.equal(summary.terminalBoundary, "all-receipts-resolved");
  assert.equal(summary.submissions, 2);
  assert.equal(summary.receipts, 2);
  assert.equal(summary.probeEvents, 0);
  assert.deepEqual(summary.capture, {
    policy: "required",
    machineSessionId: MACHINE_SESSION_ID,
    machineInitializationRecordSha256: fixture.refs.initialized,
    firstFrameRendererRecordSha256: fixture.refs.firstFrame,
    baselineRecordSha256: fixture.refs.baseline,
    firstFrameReportRecordSha256: fixture.refs.report,
    witnessRecordSha256: fixture.refs.witness,
    witness: {
      sequenceLo: 1,
      sequenceHi: 0,
      buttons: 1,
      stickXyCxy: 0x8080_8001,
      triggerLrab: 0,
      status: 9,
      machineEvidenceEnvelopeBytes: 1_024,
      machineEvidenceEnvelopeSha256: SHA_C,
      machineEvidenceOpaqueBytes: 816,
      machineEvidenceOpaqueSha256: SHA_D,
    },
    acceptedRecordSha256: fixture.refs.accepted,
    terminalRecordSha256: fixture.refs.terminal,
    runPolicy: CAPTURE_RUN_POLICY,
    initialRunSummary: captureRunSummary(false),
    terminalRunSummary: captureRunSummary(true),
  });
});

test("production journal accepts 65 operator publications and rejects 66", () => {
  assert.equal(PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP, 65);
  const accepted = productionJournal({
    operatorPublications: PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  });
  assert.equal(
    validateProduction(accepted.records).capture.terminalRunSummary.operatorPublications,
    65,
  );
  const rejected = rebuiltWithMutation(accepted.records, payloads => {
    payloads.find(entry => entry.kind === "fidelity-terminal")
      .runSummary.operatorPublications = 66;
  });
  assert.throws(() => validateProduction(rejected), /exceeded frozen cumulative authority/);
});

test("production journal rejects incomplete or over-cap ready boot authority", () => {
  const fixture = productionJournal().records;
  for (const mutate of [
    payload => { payload.bootStatus = 1; },
    payload => { payload.bootReads = CAPTURE_RUN_POLICY.maxBootReads + 1; },
  ]) {
    const changed = rebuiltWithMutation(fixture, payloads => {
      mutate(payloads.find(entry => entry.kind === "capture-machine-initialized"));
    });
    assert.throws(() => validateProduction(changed), /bootStatus|bootReads/);
  }
});

test("production journal accepts a distinct Baseline receipt before report binding", () => {
  const fixture = productionJournal({ distinctBaselineReceipt: true });
  const summary = validateProduction(fixture.records);
  assert.equal(summary.submissions, 3);
  assert.equal(summary.receipts, 3);
  assert.equal(summary.capture.baselineRecordSha256, fixture.refs.baseline);
  const firstOwnerIndex = fixture.records.findIndex(
    record => record.payload.kind === "first-frame-renderer-owned",
  );
  const baselineIndex = fixture.records.findIndex(
    record => record.payload.kind === "fidelity-baseline-owned",
  );
  assert.ok(baselineIndex > firstOwnerIndex + 3);
});

test("production journal rejects session splices and requested-word drift", () => {
  const fixture = productionJournal().records;
  const sessionSplice = rebuiltWithMutation(fixture, payloads => {
    payloads.find(entry => entry.kind === "fidelity-baseline-owned").machineSessionId =
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  });
  assert.throws(() => validateProduction(sessionSplice), /machine session changed/);

  for (const [field, value] of [
    ["buttons", 2],
    ["stickXyCxy", 0x8080_8080],
    ["triggerLrab", 1],
  ]) {
    const drift = rebuiltWithMutation(fixture, payloads => {
      payloads.find(entry => entry.kind === "controller-witness-published")[field] = value;
    });
    assert.throws(
      () => validateProduction(drift),
      /controller witness differed from the durable Rust Baseline request/,
    );
  }
});

test("production journal rejects predecessor, identity, and receipt-digest rewrites", () => {
  const fixture = productionJournal().records;
  const predecessor = structuredClone(fixture);
  const baselineIndex = predecessor.findIndex(
    record => record.payload.kind === "fidelity-baseline-owned",
  );
  predecessor[baselineIndex].previousRecordSha256 = SHA_A;
  assert.throws(() => validateProduction(predecessor), /hash chain changed/);

  const identityRewrite = rebuiltWithMutation(fixture, payloads => {
    payloads.find(entry => entry.kind === "first-frame-renderer-owned").sequenceLo = 99;
  });
  assert.throws(() => validateProduction(identityRewrite), /resolved receipt changed/);

  const receiptRewrite = rebuiltWithMutation(fixture, payloads => {
    payloads.find(entry => entry.kind === "first-frame-renderer-owned").receiptSha256 = SHA_C;
  });
  assert.throws(() => validateProduction(receiptRewrite), /resolved receipt changed/);

  const sameReceiptReadbackRewrite = rebuiltWithMutation(fixture, payloads => {
    payloads.find(entry => entry.kind === "fidelity-baseline-owned").rgbaSha256 = SHA_C;
  });
  assert.throws(
    () => validateProduction(sameReceiptReadbackRewrite),
    /same-receipt Baseline did not reuse/,
  );
});

test("production journal rejects duplicate, reordered, and incomplete capture cardinality", () => {
  const fixture = productionJournal().records;
  const payloads = fixture.map(record => structuredClone(record.payload));
  const firstOwnerIndex = payloads.findIndex(
    entry => entry.kind === "first-frame-renderer-owned",
  );
  payloads.splice(firstOwnerIndex + 1, 0, structuredClone(payloads[firstOwnerIndex]));
  payloads.forEach((entry, index) => { entry.clientSequence = index + 1; });
  assert.throws(
    () => validateProduction(records(payloads)),
    /duplicate first-frame ownership/,
  );

  const reorderedPayloads = fixture.map(record => structuredClone(record.payload));
  const baselineIndex = reorderedPayloads.findIndex(
    entry => entry.kind === "fidelity-baseline-owned",
  );
  const reportIndex = reorderedPayloads.findIndex(
    entry => entry.kind === "first-frame-report-bound",
  );
  [reorderedPayloads[baselineIndex], reorderedPayloads[reportIndex]] =
    [reorderedPayloads[reportIndex], reorderedPayloads[baselineIndex]];
  reorderedPayloads.forEach((entry, index) => { entry.clientSequence = index + 1; });
  assert.throws(() => validateProduction(records(reorderedPayloads)));

  assert.throws(
    () => validateProduction(fixture.slice(0, -1)),
    /required continuous fidelity capture checkpoints are incomplete/,
  );
});

test("production journal rejects missing leaf digests and terminal inequality", () => {
  const fixture = productionJournal().records;
  const missingLeaf = rebuiltWithMutation(fixture, payloads => {
    delete payloads.find(entry => entry.kind === "fidelity-baseline-owned").rgbaSha256;
  });
  assert.throws(() => validateProduction(missingLeaf), /expected exactly/);

  const unequalTerminal = rebuiltWithMutation(fixture, payloads => {
    payloads.find(entry => entry.kind === "fidelity-terminal")
      .gameFidelityOpaqueSha256 = SHA_A;
  });
  assert.throws(
    () => validateProduction(unequalTerminal),
    /differed from the hard Accepted boundary/,
  );
});

test("production journal terminal is final and cannot be followed by any record", () => {
  const fixture = productionJournal().records;
  const payloads = fixture.map(record => structuredClone(record.payload));
  payloads.push(payload(payloads.length + 1, "pre-submit", identity({
    relayRequestId: 99,
    renderCallOrdinal: 99,
  })));
  assert.throws(
    () => validateProduction(records(payloads)),
    /record followed terminal fidelity boundary/,
  );
});
