// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  installResidentMachineWorker,
  MainThreadRendererRelay,
  ResidentCaptureRunLedger,
} from "../web/resident-machine-worker.mjs";
import {
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
} from "./resident_machine_fidelity_checkpoints.mjs";

const CAPTURE_RUN_POLICY = Object.freeze({
  instructionUpperCap: "100",
  executedCycleUpperCap: "100",
  sliceCycleUpperCap: "10",
  blockUpperCap: 16,
  totalHostCallCap: 8,
  totalColdInstallCap: 8,
  maxBootReads: 4,
  bootTimeoutMs: 1_000,
  sliceTimeoutMs: 1_000,
  runTimeoutMs: 10_000,
  externalWallTimeoutMs: 10_000,
  zeroProgressSliceCap: 2,
  workerUrl: "/worker.mjs",
});

function fakeScope() {
  const messages = [];
  return {
    messages,
    postMessage(message, transfer = []) {
      messages.push({ message, transfer });
    },
  };
}

function fidelityState(phase, requestedController = null) {
  return Object.freeze({
    phase,
    requestedController,
    machineEvidence: Object.freeze({
      available: true,
      bytes: 816,
      encoding: "base64",
      payload: "ready-machine-evidence",
    }),
    record: Object.freeze({
      available: true,
      bytes: 384,
      encoding: "base64",
      payload: "AA==",
    }),
  });
}

class FakeWorkerScope extends EventTarget {
  constructor({
    workerUrl = "http://127.0.0.1:8080/worker.mjs",
    randomUUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    clock = null,
  } = {}) {
    super();
    this.location = new URL(workerUrl);
    this.crypto = Object.freeze({ randomUUID: () => randomUUID });
    if (clock !== null) this.performance = Object.freeze({ now: clock });
    this.messages = [];
  }

  postMessage(message, transfer = []) {
    this.messages.push({ message, transfer });
  }

  receive(message) {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

async function waitForWorkerMessage(scope, predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const entry = scope.messages.find(({ message }) => predicate(message));
    if (entry) return entry.message;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function workerHarness({
  runAccepted = false,
  publishStatus = 9,
  workerUrl,
  randomUUID,
  clock,
  onBoot = null,
} = {}) {
  const scope = new FakeWorkerScope({ workerUrl, randomUUID, clock });
  let phase = 0;
  let requestedController = null;
  let renderer = null;
  const publishCalls = [];
  const adapter = {
    closed: false,
    async boot() {
      onBoot?.();
      return { status: 1, reads: 1 };
    },
    diagnostics() {
      return {
        fake: true,
        machineEvidence: {
          available: true,
          bytes: 816,
          encoding: "base64",
          payload: "newer-diagnostics-snapshot",
        },
      };
    },
    async runSlice() {
      if (runAccepted) {
        await renderer.submit_resident_render(Uint8Array.of(1, 2), 3, 4, 5);
        await renderer.observe_resident_fidelity(fidelityState(5));
        return { boundary: "fidelity", phase: 5, hostCalls: 1, coldInstalls: 0 };
      }
      return {
        boundary: "rust",
        cycleUpperCap: 1n,
        outcome: {
          reason: 0,
          detail: 0,
          executedCycles: 1n,
          executedInstructions: 1n,
        },
      };
    },
    publishController(sequenceLo, sequenceHi, buttons, stickXyCxy, triggerLrab) {
      publishCalls.push({ sequenceLo, sequenceHi, buttons, stickXyCxy, triggerLrab });
      return publishStatus;
    },
    gameFidelityState() {
      return fidelityState(phase, requestedController);
    },
    close() {
      this.closed = true;
    },
  };
  installResidentMachineWorker(scope, {
    adapterFactory: async options => {
      renderer = options.renderer;
      return adapter;
    },
  });
  return {
    scope,
    adapter,
    publishCalls,
    setFidelityState(nextPhase, nextRequestedController = null) {
      phase = nextPhase;
      requestedController = nextRequestedController;
    },
  };
}

async function initializeCapture(harness, requestId = 1) {
  harness.scope.receive(captureInitMessage(requestId));
  return waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-ready" && message.requestId === requestId,
    "resident-ready",
  );
}

function captureInitMessage(requestId = 1, overrides = {}) {
  return {
    type: "resident-init",
    requestId,
    captureFidelity: true,
    runPolicy: CAPTURE_RUN_POLICY,
    disc: { kind: "blob", blob: new Blob([Uint8Array.of(0)]) },
    artifacts: {
      core: "/core.wasm",
      dispatcher: "/dispatcher.wasm",
      coordinator: "/coordinator.wasm",
    },
    ...overrides,
  };
}

async function initializeLegacy(harness, requestId = 1) {
  harness.scope.receive({
    type: "resident-init",
    requestId,
    captureFidelity: false,
    disc: { kind: "blob", blob: new Blob([Uint8Array.of(0)]) },
    artifacts: {
      core: "/core.wasm",
      dispatcher: "/dispatcher.wasm",
      coordinator: "/coordinator.wasm",
    },
  });
  return waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-ready" && message.requestId === requestId,
    "legacy resident-ready",
  );
}

test("capture run ledger is cumulative, stable, and fail-closed at frozen caps", () => {
  let now = 10;
  const ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => now);
  assert.throws(() => ledger.summary(), /not started at resident-ready/);
  assert.throws(() => ledger.issue({}), /not started at resident-ready/);
  now = 5_010;
  ledger.startAtReady();
  assert.throws(() => ledger.startAtReady(), /start was not one-shot/);
  assert.deepEqual(ledger.summary(), {
    schema: "lazuli-resident-cumulative-run-summary-v1",
    issuedRunCalls: 0,
    reportedExecutedCycles: "0",
    reportedExecutedInstructions: "0",
    reportedHostCalls: 0,
    reportedColdInstalls: 0,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    operatorPublications: 0,
    witnessPublications: 0,
    elapsedWallMs: 0,
    wallTimeoutMs: 10_000,
    accepted: false,
  });

  let issued = ledger.issue({
    cycleUpperCap: "9",
    blockUpperCap: 8,
    maxHostCalls: 3,
    maxColdInstalls: 2,
  });
  assert.equal(issued.cycleUpperCap, 9n);
  now = 5_011;
  ledger.accept({
    boundary: "rust",
    hostCalls: 2,
    coldInstalls: 1,
    outcome: { reason: 0, detail: 0, executedCycles: 9n, executedInstructions: 40n },
  });
  assert.throws(
    () => ledger.issue({ cycleUpperCap: "11" }),
    /remaining slice cap/,
  );
  issued = ledger.issue({ cycleUpperCap: "10", maxHostCalls: 6, maxColdInstalls: 7 });
  assert.equal(issued.maxHostCalls, 6);
  now = 5_012;
  ledger.accept({
    boundary: "fidelity",
    phase: 5,
    hostCalls: 6,
    coldInstalls: 7,
  });
  assert.equal(ledger.summary().accepted, true);
  assert.equal(ledger.summary().reportedHostCalls, 8);
  assert.throws(() => ledger.issue({}), /Accepted boundary/);
});

test("capture run ledger supports the v3 cumulative instruction and cold authorities", () => {
  const productionPolicy = {
    ...CAPTURE_RUN_POLICY,
    instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
    executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
    totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  };
  const ledger = new ResidentCaptureRunLedger(productionPolicy, () => 0);
  ledger.startAtReady();
  for (let index = 0; index < 16; index += 1) {
    const issued = ledger.issue({ maxColdInstalls: 65_535 });
    assert.equal(issued.maxColdInstalls, 65_535);
    ledger.accept({
      boundary: "rust",
      coldInstalls: 65_535,
      outcome: { reason: 0, detail: 0, executedCycles: 1n, executedInstructions: 1n },
    });
  }
  const terminal = ledger.issue({});
  assert.equal(terminal.maxColdInstalls, 15);
  ledger.accept({ boundary: "fidelity", phase: 5, coldInstalls: 15 });
  assert.equal(
    ledger.summary().reportedColdInstalls,
    PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  );
  assert.equal(ledger.summary().accepted, true);

  const exhausted = new ResidentCaptureRunLedger(productionPolicy, () => 0);
  exhausted.startAtReady();
  exhausted.issue({});
  assert.throws(() => exhausted.accept({
    boundary: "rust",
    coldInstalls: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
    outcome: { reason: 0, detail: 0, executedCycles: 1n, executedInstructions: 1n },
  }), /cumulative cold-install cap exhausted/);
  assert.equal(
    exhausted.summary().reportedColdInstalls,
    PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  );

  const raisedInstructionAuthority = new ResidentCaptureRunLedger(productionPolicy, () => 0);
  raisedInstructionAuthority.startAtReady();
  raisedInstructionAuthority.issue({});
  raisedInstructionAuthority.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 0,
      executedCycles: 1n,
      executedInstructions: 100_000_001n,
    },
  });
  assert.equal(
    raisedInstructionAuthority.summary().reportedExecutedInstructions,
    "100000001",
  );

  const instructionOvershoot = new ResidentCaptureRunLedger(productionPolicy, () => 0);
  instructionOvershoot.startAtReady();
  instructionOvershoot.issue({});
  assert.throws(() => instructionOvershoot.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 0,
      executedCycles: 1n,
      executedInstructions: BigInt(PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP) + 1n,
    },
  }), /cumulative instruction cap overshot/);
});

test("capture run ledger classifies only a full truncated CycleBudget tail as terminal", () => {
  const ordinarySlicePolicy = {
    ...CAPTURE_RUN_POLICY,
    executedCycleUpperCap: "2500000",
    sliceCycleUpperCap: "1000000",
  };
  let ledger = new ResidentCaptureRunLedger(ordinarySlicePolicy, () => 0);
  ledger.startAtReady();
  assert.equal(ledger.issue({}).cycleUpperCap, 1_000_000n);
  ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 1_000_000n,
      executedInstructions: 1n,
    },
  });
  assert.equal(ledger.summary().reportedExecutedCycles, "1000000");

  const tailPolicy = {
    ...CAPTURE_RUN_POLICY,
    executedCycleUpperCap: "15",
    sliceCycleUpperCap: "10",
  };
  const ledgerAtTail = (overrides = {}) => {
    const ledger = new ResidentCaptureRunLedger({ ...tailPolicy, ...overrides }, () => 0);
    ledger.startAtReady();
    ledger.issue({});
    ledger.accept({
      boundary: "rust",
      outcome: {
        reason: 0,
        detail: 1,
        executedCycles: 10n,
        executedInstructions: 1n,
      },
    });
    return ledger;
  };

  ledger = ledgerAtTail({ instructionUpperCap: "4" });
  assert.equal(ledger.issue({}).cycleUpperCap, 5n);
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 0n,
      executedInstructions: 0n,
    },
  }), /capture cumulative executed-cycle cap cannot retire the next block/);
  assert.equal(ledger.summary().zeroProgressSlices, 0);

  ledger = ledgerAtTail();
  assert.equal(ledger.issue({}).cycleUpperCap, 5n);
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 3n,
      executedInstructions: 2n,
    },
  }), /capture cumulative executed-cycle cap cannot retire the next block/);
  assert.equal(ledger.summary().reportedExecutedCycles, "13");
  assert.equal(ledger.summary().reportedExecutedInstructions, "3");
  assert.equal(ledger.summary().zeroProgressSlices, 0);

  ledger = ledgerAtTail();
  assert.equal(ledger.issue({}).cycleUpperCap, 5n);
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 5n,
      executedInstructions: 2n,
    },
  }), /capture cumulative executed-cycle cap exhausted/);
  assert.equal(ledger.summary().reportedExecutedCycles, "15");
  assert.equal(ledger.summary().reportedExecutedInstructions, "3");

  ledger = ledgerAtTail({ instructionUpperCap: "3" });
  assert.equal(ledger.issue({}).cycleUpperCap, 5n);
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 3n,
      executedInstructions: 2n,
    },
  }), /capture cumulative instruction cap exhausted/);
  assert.equal(ledger.summary().reportedExecutedCycles, "13");
  assert.equal(ledger.summary().reportedExecutedInstructions, "3");

  ledger = ledgerAtTail({ instructionUpperCap: "2" });
  assert.equal(ledger.issue({}).cycleUpperCap, 5n);
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 3n,
      executedInstructions: 2n,
    },
  }), /capture cumulative instruction cap exhausted/);
  assert.equal(ledger.summary().reportedExecutedCycles, "13");
  assert.equal(ledger.summary().reportedExecutedInstructions, "3");

  ledger = ledgerAtTail();
  assert.equal(ledger.issue({ cycleUpperCap: "4" }).cycleUpperCap, 4n);
  ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 0n,
      executedInstructions: 0n,
    },
  });
  assert.equal(ledger.summary().consecutiveZeroProgressSlices, 1);

  ledger = ledgerAtTail();
  assert.equal(ledger.issue({}).cycleUpperCap, 5n);
  ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 0,
      executedCycles: 0n,
      executedInstructions: 0n,
    },
  });
  assert.equal(ledger.summary().consecutiveZeroProgressSlices, 1);
  assert.equal(ledger.issue({}).cycleUpperCap, 5n, "BlockBudget tail was not resumable");

  ledger = ledgerAtTail();
  ledger.issue({});
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 5,
      detail: 0xffff_ffff,
      executedCycles: 0n,
      executedInstructions: 0n,
    },
  }), /Rust resident run stopped with reason 5, detail 4294967295/);
  assert.equal(ledger.summary().zeroProgressSlices, 0);

  const exactSlicePolicy = {
    ...CAPTURE_RUN_POLICY,
    executedCycleUpperCap: "10",
    sliceCycleUpperCap: "10",
  };
  ledger = new ResidentCaptureRunLedger(exactSlicePolicy, () => 0);
  ledger.startAtReady();
  assert.equal(ledger.issue({}).cycleUpperCap, 10n);
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: {
      reason: 0,
      detail: 1,
      executedCycles: 10n,
      executedInstructions: 1n,
    },
  }), /capture cumulative executed-cycle cap exhausted/);
});

test("capture run ledger validates Rust reason/detail before terminal classification", () => {
  const rejectOutcome = (outcome, pattern) => {
    const ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => 0);
    ledger.startAtReady();
    ledger.issue({});
    assert.throws(() => ledger.accept({
      boundary: "rust",
      outcome: {
        executedCycles: 0n,
        executedInstructions: 0n,
        ...outcome,
      },
    }), pattern);
  };

  rejectOutcome({ reason: "0", detail: 0 }, /reason was not an exact u32/);
  rejectOutcome({ reason: 7, detail: 0 }, /reason was outside the RunReason ABI/);
  rejectOutcome({ reason: 0, detail: "1" }, /detail was not an exact u32/);
  rejectOutcome({ reason: 0, detail: 9 }, /outside the RunOutcomeDetail ABI/);
  rejectOutcome({ reason: 5, detail: 0x1_0000_0000 }, /detail was not an exact u32/);
});

test("authenticated host and cold work reset cumulative zero-progress accounting", () => {
  const ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => 0);
  const zeroRustResult = (work = {}) => ({
    boundary: "rust",
    ...work,
    outcome: {
      reason: 0,
      detail: 2,
      executedCycles: 0n,
      executedInstructions: 0n,
    },
  });
  ledger.startAtReady();

  ledger.issue({});
  ledger.accept(zeroRustResult());
  assert.equal(ledger.summary().consecutiveZeroProgressSlices, 1);

  ledger.issue({});
  ledger.accept(zeroRustResult({ hostCalls: 1 }));
  assert.equal(ledger.summary().zeroProgressSlices, 1);
  assert.equal(ledger.summary().consecutiveZeroProgressSlices, 0);

  ledger.issue({});
  ledger.accept(zeroRustResult());
  assert.equal(ledger.summary().consecutiveZeroProgressSlices, 1);

  ledger.issue({});
  ledger.accept(zeroRustResult({ coldInstalls: 1 }));
  assert.equal(ledger.summary().zeroProgressSlices, 2);
  assert.equal(ledger.summary().consecutiveZeroProgressSlices, 0);
  assert.equal(ledger.summary().maximumConsecutiveZeroProgressSlices, 1);
});

test("capture run ledger rejects overshoot, zero progress, and deadline exhaustion", () => {
  let now = 0;
  let ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => now);
  ledger.startAtReady();
  ledger.issue({ cycleUpperCap: "5" });
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: { reason: 0, detail: 0, executedCycles: 6n, executedInstructions: 1n },
  }), /issued cycle budget/);

  ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => now);
  ledger.startAtReady();
  ledger.issue({});
  ledger.accept({
    boundary: "rust",
    outcome: { reason: 0, detail: 1, executedCycles: 0n, executedInstructions: 0n },
  });
  ledger.issue({});
  assert.throws(() => ledger.accept({
    boundary: "rust",
    outcome: { reason: 0, detail: 1, executedCycles: 0n, executedInstructions: 0n },
  }), /zero-progress cap exhausted/);

  now = 0;
  ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => now);
  ledger.startAtReady();
  now = 10_000;
  assert.throws(() => ledger.issue({}), /wall-time cap exhausted/);
});

test("capture Worker starts its wall deadline at resident-ready after boot", async () => {
  let now = 100;
  const harness = workerHarness({
    clock: () => now,
    onBoot: () => { now = 5_100; },
  });
  const ready = await initializeCapture(harness);
  assert.equal(ready.runSummary.elapsedWallMs, 0);

  now = 15_099;
  harness.scope.receive({ type: "resident-run", requestId: 2 });
  const withinDeadline = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-run-result" && message.requestId === 2,
    "resident run inside ready-relative deadline",
  );
  assert.equal(withinDeadline.runSummary.elapsedWallMs, 9_999);
  harness.scope.receive({ type: "resident-fidelity-state", requestId: 22 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-fidelity-state-result" && message.requestId === 22,
    "mandatory fidelity poll after run",
  );

  now = 15_100;
  harness.scope.receive({ type: "resident-run", requestId: 3 });
  const exhausted = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 3,
    "resident run at ready-relative deadline",
  );
  assert.match(exhausted.error, /wall-time cap exhausted/);
});

async function settleAcceptedRender(relay, scope, options = {}) {
  const pending = relay.submit_resident_render(
    Uint8Array.from([1, 2, 3]),
    options.requestFlags ?? 7,
    options.sequenceLo ?? 11,
    options.sequenceHi ?? 13,
  );
  const request = scope.messages.at(-1).message;
  assert.equal(request.type, "resident-render-request");
  assert.equal(relay.settle({
    type: "resident-render-receipt",
    id: request.id,
    receipt: Uint8Array.from([4, 5, 6]),
  }), true);
  assert.deepEqual(await pending, Uint8Array.from([4, 5, 6]));
  return request;
}

test("default worker relay emits no fidelity surface", async () => {
  const scope = fakeScope();
  const relay = new MainThreadRendererRelay(scope);
  await settleAcceptedRender(relay, scope);
  await relay.observe_resident_fidelity(fidelityState(1, {
    buttons: 0x0100,
    stickXyCxy: 0x8080_8080,
    triggerLrab: 0x00ff_0000,
  }));
  assert.deepEqual(scope.messages.map(entry => entry.message.type), [
    "resident-render-request",
  ]);
});

test("Baseline observation blocks until the exact main-thread ACK", async () => {
  const scope = fakeScope();
  const relay = new MainThreadRendererRelay(scope);
  relay.configureFidelityCapture(true);
  const request = await settleAcceptedRender(relay, scope, {
    requestFlags: 17,
    sequenceLo: 19,
    sequenceHi: 23,
  });
  let settled = false;
  const observation = relay.observe_resident_fidelity(fidelityState(1, {
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  })).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const event = scope.messages.at(-1).message;
  assert.deepEqual(event, {
    type: "resident-fidelity-observation",
    id: request.id,
    requestFlags: 17,
    sequenceLo: 19,
    sequenceHi: 23,
    state: fidelityState(1, {
      buttons: 1,
      stickXyCxy: 0x8080_8001,
      triggerLrab: 0,
    }),
  });
  assert.equal(relay.settleObservation({
    type: "resident-fidelity-observation-ack",
    id: request.id + 1,
  }), false);
  assert.equal(settled, false);
  assert.equal(relay.settleObservation({
    type: "resident-fidelity-observation-ack",
    id: request.id,
  }), true);
  await observation;
  assert.equal(settled, true);
});

test("Accepted is edge-triggered and Failed is emitted and fail-closed", async () => {
  const scope = fakeScope();
  const relay = new MainThreadRendererRelay(scope);
  relay.configureFidelityCapture(true);

  let request = await settleAcceptedRender(relay, scope);
  let observation = relay.observe_resident_fidelity(fidelityState(5));
  assert.equal(scope.messages.at(-1).message.state.phase, 5);
  relay.settleObservation({ type: "resident-fidelity-observation-ack", id: request.id });
  await observation;

  const beforeRepeatedPhase = scope.messages.length;
  await settleAcceptedRender(relay, scope);
  await relay.observe_resident_fidelity(fidelityState(5));
  assert.equal(scope.messages.length, beforeRepeatedPhase + 1, "repeated Accepted emitted an event");

  request = await settleAcceptedRender(relay, scope);
  observation = relay.observe_resident_fidelity(fidelityState(6));
  const failure = new Error("readback ownership failed");
  assert.equal(relay.settleObservation({
    type: "resident-fidelity-observation-error",
    id: request.id,
    error: failure.message,
  }), true);
  await assert.rejects(observation, /readback ownership failed/);
  assert.throws(
    () => relay.assertMachineProgressAvailable(),
    /readback ownership failed/,
    "an observation rejection did not permanently close machine progress",
  );
});

test("pre-ACK fidelity invariant failures are latched and cannot be retried", async () => {
  const scope = fakeScope();
  const relay = new MainThreadRendererRelay(scope);
  relay.configureFidelityCapture(true);
  await assert.rejects(
    relay.observe_resident_fidelity(fidelityState(1, {
      buttons: 1,
      stickXyCxy: 0x8080_8001,
      triggerLrab: 0,
    })),
    /without one settled renderer relay identity/,
  );
  assert.throws(
    () => relay.submit_resident_render(Uint8Array.of(1), 0, 0, 0),
    /without one settled renderer relay identity/,
  );
});

test("Accepted ACK is a hard machine-progress boundary", async () => {
  const scope = fakeScope();
  const relay = new MainThreadRendererRelay(scope);
  relay.configureFidelityCapture(true);
  const request = await settleAcceptedRender(relay, scope);
  const observation = relay.observe_resident_fidelity(fidelityState(5));
  relay.settleObservation({ type: "resident-fidelity-observation-ack", id: request.id });
  assert.equal(await observation, "accepted");
  assert.throws(
    () => relay.assertMachineProgressAvailable(),
    /accepted fidelity boundary/,
  );
});

test("closing the relay rejects an unacknowledged fidelity observation", async () => {
  const scope = fakeScope();
  const relay = new MainThreadRendererRelay(scope);
  relay.configureFidelityCapture(true);
  await settleAcceptedRender(relay, scope);
  const observation = relay.observe_resident_fidelity(fidelityState(1, {
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  }));
  relay.close();
  await assert.rejects(observation, /resident worker closed/);
});

test("worker protocol keeps fidelity query and ACK handling outside the serialized deadlock path", async () => {
  const source = await readFile(
    new URL("../web/resident-machine-worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /case "resident-fidelity-state"/);
  assert.match(source, /type: "resident-fidelity-state-result"/);
  assert.match(source, /adapter\.gameFidelityState\(\)/);
  assert.match(
    source,
    /message\.type === "resident-fidelity-observation-ack"[\s\S]*renderer\.settleObservation\(message\)[\s\S]*return;[\s\S]*commandTail = commandTail\.then/,
  );
  assert.doesNotMatch(source, /read_presented_xfb_rgba|projector|guest memory|title policy/i);
});

test("worker adapter injection is exact-keyed and fail-closed", () => {
  const scope = new FakeWorkerScope();
  assert.throws(
    () => installResidentMachineWorker(scope, null),
    /options must be an object/,
  );
  assert.throws(
    () => installResidentMachineWorker(scope, { adapterFactory: null }),
    /adapterFactory must be a function/,
  );
  assert.throws(
    () => installResidentMachineWorker(scope, { adapterFactory() {}, extra: true }),
    /unsupported field/,
  );
});

test("capture ready exposes only the Worker-generated machine session", async () => {
  const machineSessionId = "12345678-1234-4234-9234-123456789abc";
  const harness = workerHarness({ randomUUID: machineSessionId });
  const ready = await initializeCapture(harness);
  assert.equal(ready.machineSessionId, machineSessionId);
  assert.deepEqual(ready.diagnostics.machineEvidence, ready.fidelityState.machineEvidence);
  assert.equal(ready.diagnostics.machineEvidence.payload, "ready-machine-evidence");
  assert.equal(ready.runSummary.schema, "lazuli-resident-cumulative-run-summary-v1");
  assert.equal(ready.runSummary.issuedRunCalls, 0);

  const supplied = workerHarness();
  supplied.scope.receive(captureInitMessage(1, {
    machineSessionId: "87654321-4321-4321-8321-cba987654321",
  }));
  const suppliedError = await waitForWorkerMessage(
    supplied.scope,
    message => message.type === "resident-error" && message.requestId === 1,
    "caller-supplied machine session rejection",
  );
  assert.match(suppliedError.error, /cannot supply a machineSessionId/);
});

test("capture runPolicy worker URL must be the executing Worker with no query drift", async () => {
  for (const workerUrl of ["/other-worker.mjs", "/worker.mjs?substitute=1", "/worker.mjs#old"] ) {
    const harness = workerHarness();
    harness.scope.receive(captureInitMessage(1, {
      runPolicy: { ...CAPTURE_RUN_POLICY, workerUrl },
    }));
    const error = await waitForWorkerMessage(
      harness.scope,
      message => message.type === "resident-error" && message.requestId === 1,
      `worker URL rejection for ${workerUrl}`,
    );
    assert.match(error.error, /does not identify this executing Worker/);
  }
});

test("capture mode rejects raw resident-input before it reaches the adapter", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  harness.scope.receive({
    type: "resident-input",
    requestId: 2,
    sequenceLo: 1,
    sequenceHi: 0,
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  });
  const error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 2,
    "raw input rejection",
  );
  assert.match(error.error, /requires atomic resident controller commands/);
  assert.deepEqual(harness.publishCalls, []);
});

test("legacy resident-input remains available without a capture ledger", async () => {
  const harness = workerHarness();
  await initializeLegacy(harness);
  const packed = {
    buttons: 0x0000_0101,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0x00ff_0000,
  };
  harness.scope.receive({
    type: "resident-input",
    requestId: 2,
    sequenceLo: 1,
    sequenceHi: 0,
    ...packed,
  });
  const result = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-input-result" && message.requestId === 2,
    "legacy input result",
  );
  assert.deepEqual(result, {
    type: "resident-input-result",
    requestId: 2,
    status: 9,
  });
  assert.deepEqual(harness.publishCalls, [{ sequenceLo: 1, sequenceHi: 0, ...packed }]);
});

test("atomic operator input is phase-zero-only and requires the mandatory state poll", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  const packed = {
    buttons: 0,
    stickXyCxy: 0x8080_8080,
    triggerLrab: 0,
  };
  harness.scope.receive({
    type: "resident-controller-operator",
    requestId: 2,
  });
  const result = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-operator-result"
      && message.requestId === 2,
    "operator result",
  );
  assert.deepEqual(result, {
    type: "resident-controller-operator-result",
    requestId: 2,
    sequenceLo: 1,
    sequenceHi: 0,
    ...packed,
    status: 9,
    machineSessionId: result.machineSessionId,
    runSummary: result.runSummary,
  });
  assert.match(result.machineSessionId, /^[0-9a-f]{8}-/i);
  assert.equal(result.runSummary.operatorPublications, 1);
  assert.deepEqual(harness.publishCalls, [{
    sequenceLo: 1,
    sequenceHi: 0,
    ...packed,
  }]);

  harness.scope.receive({
    type: "resident-controller-operator",
    requestId: 3,
  });
  const error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 3,
    "mandatory poll rejection",
  );
  assert.match(error.error, /must be polled after the prior command boundary/);
  assert.equal(harness.publishCalls.length, 1);
});

test("atomic operator derives the exact alternating neutral/A parity", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  const expected = [
    { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 },
    { buttons: 0x0100, stickXyCxy: 0x8080_8080, triggerLrab: 0x00ff_0000 },
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const requestId = 2 + index * 2;
    harness.scope.receive({ type: "resident-controller-operator", requestId });
    const result = await waitForWorkerMessage(
      harness.scope,
      message => message.type === "resident-controller-operator-result"
        && message.requestId === requestId,
      `derived operator ${index}`,
    );
    assert.deepEqual(
      { buttons: result.buttons, stickXyCxy: result.stickXyCxy, triggerLrab: result.triggerLrab },
      expected[index],
    );
    assert.equal(result.runSummary.operatorPublications, index + 1);
    harness.scope.receive({ type: "resident-fidelity-state", requestId: requestId + 1 });
    await waitForWorkerMessage(
      harness.scope,
      message => message.type === "resident-fidelity-state-result"
        && message.requestId === requestId + 1,
      `derived operator ${index} state poll`,
    );
  }
  assert.deepEqual(harness.publishCalls.map(call => ({
    buttons: call.buttons,
    stickXyCxy: call.stickXyCxy,
    triggerLrab: call.triggerLrab,
  })), expected);
});

test("atomic operator rejects caller-supplied state and parity", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  harness.scope.receive({
    type: "resident-controller-operator",
    requestId: 2,
    buttons: 0x0100,
    stickXyCxy: 0x8080_8080,
    triggerLrab: 0x00ff_0000,
  });
  const error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 2,
    "caller-supplied operator rejection",
  );
  assert.match(error.error, /cannot supply controller state/);
  assert.deepEqual(harness.publishCalls, []);
});

test("backpressured atomic operator is rejected and does not increment the ledger", async () => {
  const harness = workerHarness({ publishStatus: 0 });
  const ready = await initializeCapture(harness);
  harness.scope.receive({
    type: "resident-controller-operator",
    requestId: 2,
  });
  const error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 2,
    "backpressured operator rejection",
  );
  assert.match(error.error, /backpressured/);
  harness.scope.receive({ type: "resident-fidelity-state", requestId: 3 });
  const stateError = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 3,
    "backpressured operator terminal fault",
  );
  assert.match(stateError.error, /backpressured/);
  assert.equal(ready.runSummary.operatorPublications, 0);
});

test("atomic operator input cannot cross the Rust Baseline phase", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  harness.setFidelityState(1, {
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  });
  harness.scope.receive({
    type: "resident-controller-operator",
    requestId: 2,
  });
  const error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 2,
    "post-Baseline operator rejection",
  );
  assert.match(error.error, /allowed only before Baseline/);
  assert.deepEqual(harness.publishCalls, []);
});

test("atomic witness publishes Rust Baseline words once and blocks on durable ACK", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  harness.scope.receive({
    type: "resident-controller-operator",
    requestId: 2,
  });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-operator-result"
      && message.requestId === 2,
    "operator result",
  );
  harness.scope.receive({ type: "resident-fidelity-state", requestId: 3 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-fidelity-state-result" && message.requestId === 3,
    "operator state poll",
  );

  const requested = {
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  };
  harness.setFidelityState(1, requested);
  harness.scope.receive({ type: "resident-controller-witness", requestId: 4 });
  const checkpoint = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-witness-checkpoint"
      && message.requestId === 4,
    "witness checkpoint",
  );
  assert.equal(
    harness.scope.messages.some(({ message }) =>
      message.type === "resident-controller-witness-result" && message.requestId === 4),
    false,
  );
  assert.deepEqual(harness.publishCalls.at(-1), {
    sequenceLo: 2,
    sequenceHi: 0,
    ...requested,
  });
  assert.deepEqual({
    sequenceLo: checkpoint.sequenceLo,
    sequenceHi: checkpoint.sequenceHi,
    buttons: checkpoint.buttons,
    stickXyCxy: checkpoint.stickXyCxy,
    triggerLrab: checkpoint.triggerLrab,
    status: checkpoint.status,
  }, {
    sequenceLo: 2,
    sequenceHi: 0,
    ...requested,
    status: 9,
  });

  harness.scope.receive({
    type: "resident-controller-witness-checkpoint-ack",
    requestId: 4,
  });
  const result = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-witness-result" && message.requestId === 4,
    "witness result",
  );
  assert.equal(result.stickXyCxy, 0x8080_8001);

  harness.scope.receive({ type: "resident-fidelity-state", requestId: 5 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-fidelity-state-result" && message.requestId === 5,
    "witness state poll",
  );
  harness.scope.receive({ type: "resident-controller-witness", requestId: 6 });
  const repeated = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 6,
    "one-shot witness rejection",
  );
  assert.match(repeated.error, /already published/);
  assert.equal(harness.publishCalls.length, 2);
});

test("witness checkpoint rejection permanently faults capture", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  harness.setFidelityState(1, {
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  });
  harness.scope.receive({ type: "resident-controller-witness", requestId: 2 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-witness-checkpoint"
      && message.requestId === 2,
    "witness checkpoint",
  );
  harness.scope.receive({
    type: "resident-controller-witness-checkpoint-error",
    requestId: 2,
    error: "durable storage rejected witness",
  });
  const error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 2,
    "witness checkpoint rejection",
  );
  assert.match(error.error, /durable storage rejected witness/);
  assert.equal(
    harness.scope.messages.some(({ message }) =>
      message.type === "resident-controller-witness-result" && message.requestId === 2),
    false,
  );
});

test("close rejects a witness awaiting durable ACK and worker lifetime cannot reinitialize", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  harness.setFidelityState(1, {
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  });
  harness.scope.receive({ type: "resident-controller-witness", requestId: 2 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-witness-checkpoint"
      && message.requestId === 2,
    "witness checkpoint",
  );
  harness.scope.receive({ type: "resident-close", requestId: 3 });
  const witnessError = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 2,
    "pending witness close rejection",
  );
  assert.match(witnessError.error, /resident worker closed/);
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-closed" && message.requestId === 3,
    "resident close",
  );
  assert.equal(harness.adapter.closed, true);

  harness.scope.receive({
    type: "resident-init",
    requestId: 4,
    captureFidelity: true,
    disc: { kind: "blob", blob: new Blob([Uint8Array.of(0)]) },
    artifacts: { core: "/core", dispatcher: "/dispatcher", coordinator: "/coordinator" },
  });
  const reinit = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 4,
    "post-close initialization rejection",
  );
  assert.match(reinit.error, /worker lifetime is closed/);
});

test("Accepted ACK prevents every later run or input command", async () => {
  const harness = workerHarness({ runAccepted: true });
  await initializeCapture(harness);
  harness.scope.receive({ type: "resident-run", requestId: 2 });
  const render = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-render-request",
    "Accepted renderer request",
  );
  harness.scope.receive({
    type: "resident-render-receipt",
    id: render.id,
    receipt: Uint8Array.of(7, 8),
  });
  const observation = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-fidelity-observation" && message.state.phase === 5,
    "Accepted observation",
  );
  harness.scope.receive({
    type: "resident-fidelity-observation-ack",
    id: observation.id,
  });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-run-result" && message.requestId === 2,
    "Accepted run result",
  );

  harness.scope.receive({
    type: "resident-input",
    requestId: 3,
    sequenceLo: 9,
    sequenceHi: 0,
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  });
  const inputError = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 3,
    "post-Accepted input rejection",
  );
  assert.match(inputError.error, /accepted fidelity boundary/);
  harness.scope.receive({ type: "resident-run", requestId: 4 });
  const runError = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 4,
    "post-Accepted run rejection",
  );
  assert.match(runError.error, /accepted fidelity boundary/);
  assert.deepEqual(harness.publishCalls, []);
});
