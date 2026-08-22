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
  PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
} from "./resident_machine_fidelity_checkpoints.mjs";
import {
  fidelityNavigationPolicyFromSteps,
  productionFidelityNavigationPolicy,
} from "./resident_machine_fidelity_navigation.mjs";

const EMPTY_NAVIGATION_POLICY = fidelityNavigationPolicyFromSteps("warioware-usa", []);

const CAPTURE_RUN_POLICY = Object.freeze({
  instructionUpperCap: "100",
  executedCycleUpperCap: "100",
  canonicalCycleUpperCap: "100",
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
  navigationPolicy: EMPTY_NAVIGATION_POLICY,
});

function schedulerPoint({
  canonicalCycle = 0n,
  executedCycles = canonicalCycle,
  executedInstructions = canonicalCycle,
  retiredBlocks = canonicalCycle,
} = {}) {
  return Object.freeze({
    canonicalCycle: BigInt(canonicalCycle),
    executedCycles: BigInt(executedCycles),
    executedInstructions: BigInt(executedInstructions),
    retiredBlocks: BigInt(retiredBlocks),
  });
}

function serializedSchedulerPoint(value) {
  return Object.fromEntries(Object.entries(value).map(([field, raw]) => [field, raw.toString()]));
}

function schedulerInterval(start, {
  canonicalCycles = 0n,
  executedCycles = canonicalCycles,
  executedInstructions = executedCycles,
  retiredBlocks = canonicalCycles === 0n ? 0n : 1n,
} = {}) {
  const delta = {
    canonicalCycle: BigInt(canonicalCycles),
    executedCycles: BigInt(executedCycles),
    executedInstructions: BigInt(executedInstructions),
    retiredBlocks: BigInt(retiredBlocks),
  };
  const end = Object.fromEntries(Object.entries(start).map(([field, value]) => [
    field,
    value + delta[field],
  ]));
  return Object.freeze({
    schema: "lazuli-resident-authenticated-scheduler-interval-v1",
    start: serializedSchedulerPoint(start),
    end: serializedSchedulerPoint(end),
    delta: {
      canonicalCycles: delta.canonicalCycle.toString(),
      executedCycles: delta.executedCycles.toString(),
      executedInstructions: delta.executedInstructions.toString(),
      retiredBlocks: delta.retiredBlocks.toString(),
    },
  });
}

function intervalEnd(interval) {
  return schedulerPoint(Object.fromEntries(
    Object.entries(interval.end).map(([field, value]) => [field, BigInt(value)]),
  ));
}

function expectedSiPacket(controller, mode = 3) {
  const buttons = controller.buttons >>> 0;
  const sticks = controller.stickXyCxy >>> 0;
  const triggers = controller.triggerLrab >>> 0;
  const word0 = (
    ((buttons >>> 8) & 0xff) << 24
    | (((buttons & 0xff) | 0x80) & 0xff) << 16
    | (sticks & 0xff) << 8
    | ((sticks >>> 8) & 0xff)
  ) >>> 0;
  const cStickX = (sticks >>> 16) & 0xff;
  const cStickY = (sticks >>> 24) & 0xff;
  const triggerL = triggers & 0xff;
  const triggerR = (triggers >>> 8) & 0xff;
  const analogA = (triggers >>> 16) & 0xff;
  const analogB = (triggers >>> 24) & 0xff;
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

function siAuthority({
  pollIndex,
  scheduledCycle,
  observedCycle = scheduledCycle,
  sequenceLo,
  sequenceHi = 0,
  controller,
  source = 0,
  controllerMode = 3,
  overrides = {},
}) {
  const packet = expectedSiPacket(controller, controllerMode);
  return {
    schema: "lazuli-resident-authenticated-si-publication-v1",
    pollIndex: BigInt(pollIndex).toString(),
    scheduledCycle: BigInt(scheduledCycle).toString(),
    observedCycle: BigInt(observedCycle).toString(),
    appliedSequenceLo: sequenceLo,
    appliedSequenceHi: sequenceHi,
    packetWord0: packet.word0,
    packetWord1: packet.word1,
    source,
    controllerMode,
    buttons: controller.buttons,
    stickXyCxy: controller.stickXyCxy,
    triggerLrab: controller.triggerLrab,
    ...overrides,
  };
}

function readyAuthority(point = schedulerPoint(), si = null) {
  return {
    scheduler: point,
    si: si === null ? null : {
      pollIndex: BigInt(si.pollIndex),
      scheduledCycle: BigInt(si.scheduledCycle),
      observedCycle: BigInt(si.observedCycle),
      appliedSequenceLo: si.appliedSequenceLo,
      appliedSequenceHi: si.appliedSequenceHi,
      packetWord0: si.packetWord0,
      packetWord1: si.packetWord1,
      source: si.source,
      controllerMode: si.controllerMode,
      buttons: si.buttons,
      stickXyCxy: si.stickXyCxy,
      triggerLrab: si.triggerLrab,
    },
  };
}

function rustResult(start, delta = {}, {
  si = null,
  hostCalls = 0,
  coldInstalls = 0,
  reason = 0,
  detail = 0,
  boundary = "rust",
  cap = undefined,
} = {}) {
  const scheduler = schedulerInterval(start, delta);
  const result = {
    boundary,
    scheduler,
    si,
    hostCalls,
    coldInstalls,
  };
  if (boundary === "rust") {
    result.cycleUpperCap = BigInt(delta.canonicalCycles ?? 0n);
    result.outcome = {
      reason,
      detail,
      executedCycles: BigInt(delta.executedCycles ?? delta.canonicalCycles ?? 0n),
      executedInstructions: BigInt(
        delta.executedInstructions ?? delta.executedCycles ?? delta.canonicalCycles ?? 0n,
      ),
    };
  } else if (boundary === "adapter-cap") {
    result.cap = cap;
  } else if (boundary === "fidelity") {
    result.phase = 5;
  }
  return result;
}

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
  let currentAuthority = schedulerPoint();
  let currentSi = null;
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
    captureAuthority() {
      return readyAuthority(currentAuthority, currentSi);
    },
    async runSlice(options = {}) {
      const delta = {
        canonicalCycles: 1n,
        executedCycles: 1n,
        executedInstructions: 1n,
        retiredBlocks: 1n,
      };
      const scheduler = schedulerInterval(currentAuthority, delta);
      currentAuthority = intervalEnd(scheduler);
      if (runAccepted) {
        await renderer.submit_resident_render(Uint8Array.of(1, 2), 3, 4, 5);
        await renderer.observe_resident_fidelity(fidelityState(5));
        return {
          boundary: "fidelity",
          phase: 5,
          scheduler,
          si: currentSi,
          hostCalls: 1,
          coldInstalls: 0,
        };
      }
      return {
        boundary: "rust",
        cycleUpperCap: options.cycleUpperCap ?? 1n,
        scheduler,
        si: currentSi,
        hostCalls: 0,
        coldInstalls: 0,
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
    setAuthority(nextAuthority, nextSi = currentSi) {
      currentAuthority = nextAuthority;
      currentSi = nextSi;
    },
  };
}

async function initializeCapture(harness, requestId = 1, overrides = {}) {
  harness.scope.receive(captureInitMessage(requestId, overrides));
  return waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-ready" && message.requestId === requestId,
    "resident-ready",
  );
}

async function armNavigation(harness, requestId = 2) {
  harness.scope.receive({ type: "resident-controller-navigation-arm", requestId });
  const checkpoint = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-navigation-arm-checkpoint"
      && message.requestId === requestId,
    "navigation arm checkpoint",
  );
  assert.equal(
    harness.scope.messages.some(({ message }) =>
      message.type === "resident-controller-navigation-arm-result"
      && message.requestId === requestId),
    false,
  );
  harness.scope.receive({
    type: "resident-controller-navigation-arm-checkpoint-ack",
    requestId,
  });
  const result = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-navigation-arm-result"
      && message.requestId === requestId,
    "navigation arm result",
  );
  assert.equal(result.navigation.scriptSha256, checkpoint.navigation.scriptSha256);
  return result;
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

function runLedger(ledger, delta = {}, resultOptions = {}, issueOverrides = {}) {
  const canonicalCycles = BigInt(delta.canonicalCycles ?? 0n);
  const issued = ledger.issue({
    cycleUpperCap: (canonicalCycles === 0n ? 1n : canonicalCycles).toString(),
    ...issueOverrides,
  });
  const result = rustResult(issued.schedulerStart, delta, resultOptions);
  ledger.accept(result);
  return { issued, result, end: intervalEnd(result.scheduler) };
}

function smallNavigationPolicy(steps) {
  return {
    ...CAPTURE_RUN_POLICY,
    navigationPolicy: fidelityNavigationPolicyFromSteps("warioware-usa", steps),
  };
}

test("capture run ledger exposes exact v2 cumulative scheduler authority", () => {
  let now = 10;
  const ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => now);
  assert.throws(() => ledger.summary(), /not started at resident-ready/);
  assert.throws(() => ledger.issue({}), /not started at resident-ready/);
  const origin = schedulerPoint({
    canonicalCycle: 100n,
    executedCycles: 40n,
    executedInstructions: 20n,
    retiredBlocks: 4n,
  });
  now = 5_010;
  ledger.startAtReady(readyAuthority(origin));
  assert.throws(() => ledger.startAtReady(readyAuthority(origin)), /start was not one-shot/);
  assert.deepEqual(ledger.summary(), {
    schema: "lazuli-resident-cumulative-run-summary-v2",
    issuedRunCalls: 0,
    canonicalCycle: "100",
    reportedCanonicalCycles: "0",
    reportedExecutedCycles: "0",
    reportedExecutedInstructions: "0",
    reportedRetiredBlocks: "0",
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

  now = 5_011;
  runLedger(ledger, {
    canonicalCycles: 9n,
    executedCycles: 7n,
    executedInstructions: 5n,
    retiredBlocks: 3n,
  }, { hostCalls: 2, coldInstalls: 1 }, {
    blockUpperCap: 8,
    maxHostCalls: 3,
    maxColdInstalls: 2,
  });
  assert.deepEqual({
    canonicalCycle: ledger.summary().canonicalCycle,
    reportedCanonicalCycles: ledger.summary().reportedCanonicalCycles,
    reportedExecutedCycles: ledger.summary().reportedExecutedCycles,
    reportedExecutedInstructions: ledger.summary().reportedExecutedInstructions,
    reportedRetiredBlocks: ledger.summary().reportedRetiredBlocks,
    reportedHostCalls: ledger.summary().reportedHostCalls,
    reportedColdInstalls: ledger.summary().reportedColdInstalls,
  }, {
    canonicalCycle: "109",
    reportedCanonicalCycles: "9",
    reportedExecutedCycles: "7",
    reportedExecutedInstructions: "5",
    reportedRetiredBlocks: "3",
    reportedHostCalls: 2,
    reportedColdInstalls: 1,
  });

  const terminal = ledger.issue({
    cycleUpperCap: "1",
    maxHostCalls: 6,
    maxColdInstalls: 7,
  });
  now = 5_012;
  ledger.accept(rustResult(terminal.schedulerStart, {
    canonicalCycles: 1n,
    executedCycles: 1n,
    executedInstructions: 1n,
    retiredBlocks: 1n,
  }, {
    boundary: "fidelity",
    hostCalls: 6,
    coldInstalls: 7,
  }));
  assert.equal(ledger.summary().accepted, true);
  assert.equal(ledger.summary().reportedHostCalls, 8);
  assert.equal(ledger.summary().reportedColdInstalls, 8);
  assert.throws(() => ledger.issue({}), /Accepted boundary/);
});

test("capture run ledger enforces canonical slices and accumulates retired blocks", () => {
  const policy = {
    ...CAPTURE_RUN_POLICY,
    canonicalCycleUpperCap: "15",
    executedCycleUpperCap: "100",
    instructionUpperCap: "100",
    sliceCycleUpperCap: "10",
    blockUpperCap: 4,
  };
  let ledger = new ResidentCaptureRunLedger(policy, () => 0);
  ledger.startAtReady(readyAuthority());
  runLedger(ledger, {
    canonicalCycles: 10n,
    executedCycles: 7n,
    executedInstructions: 6n,
    retiredBlocks: 4n,
  }, { detail: 1 }, { blockUpperCap: 4 });
  assert.equal(ledger.summary().reportedCanonicalCycles, "10");
  assert.equal(ledger.summary().reportedRetiredBlocks, "4");
  const tail = ledger.issue({ blockUpperCap: 4 });
  assert.equal(tail.cycleUpperCap, 5n);
  assert.throws(() => ledger.accept(rustResult(tail.schedulerStart, {
    canonicalCycles: 5n,
    executedCycles: 3n,
    executedInstructions: 2n,
    retiredBlocks: 4n,
  }, { detail: 0 })), /canonical-cycle cap exhausted/);
  assert.equal(ledger.summary().reportedCanonicalCycles, "15");
  assert.equal(ledger.summary().reportedRetiredBlocks, "8");

  ledger = new ResidentCaptureRunLedger(policy, () => 0);
  ledger.startAtReady(readyAuthority());
  let issued = ledger.issue({ cycleUpperCap: "5", blockUpperCap: 4 });
  assert.throws(() => ledger.accept(rustResult(issued.schedulerStart, {
    canonicalCycles: 6n,
    retiredBlocks: 1n,
  })), /issued canonical scheduler budget/);

  ledger = new ResidentCaptureRunLedger(policy, () => 0);
  ledger.startAtReady(readyAuthority());
  issued = ledger.issue({ cycleUpperCap: "5", blockUpperCap: 4 });
  assert.throws(() => ledger.accept(rustResult(issued.schedulerStart, {
    canonicalCycles: 5n,
    retiredBlocks: 5n,
  })), /issued canonical scheduler budget/);
});

test("capture run ledger validates Rust outcomes, zero progress, and wall exhaustion", () => {
  const rejectOutcome = (outcome, pattern) => {
    const ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => 0);
    ledger.startAtReady(readyAuthority());
    const issued = ledger.issue({ cycleUpperCap: "1" });
    assert.throws(() => ledger.accept(rustResult(issued.schedulerStart, {}, {
      ...outcome,
    })), pattern);
  };
  rejectOutcome({ reason: "0", detail: 0 }, /reason was not an exact u32/);
  rejectOutcome({ reason: 7, detail: 0 }, /reason was outside the RunReason ABI/);
  rejectOutcome({ reason: 0, detail: "1" }, /detail was not an exact u32/);
  rejectOutcome({ reason: 0, detail: 9 }, /outside the RunOutcomeDetail ABI/);

  let ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => 0);
  ledger.startAtReady(readyAuthority());
  runLedger(ledger);
  assert.equal(ledger.summary().consecutiveZeroProgressSlices, 1);
  assert.throws(() => runLedger(ledger), /zero-progress cap exhausted/);
  assert.equal(ledger.summary().maximumConsecutiveZeroProgressSlices, 2);

  let now = 0;
  ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => now);
  ledger.startAtReady(readyAuthority());
  now = 10_000;
  assert.throws(() => ledger.issue({}), /wall-time cap exhausted/);
});

test("intermediate navigation checkpoints project host and cold authority before commit", () => {
  const a = { buttons: 0x0100, stickXyCxy: 0x8080_8080, triggerLrab: 0x00ff_0000 };
  const neutral = { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 };
  const ledger = new ResidentCaptureRunLedger(smallNavigationPolicy([
    { minimumCanonicalDelay: "5", ...a },
    { minimumCanonicalDelay: "3", ...neutral },
  ]), () => 0);
  ledger.startAtReady(readyAuthority(schedulerPoint({ canonicalCycle: 100n })));
  const armed = ledger.armNavigation(0);
  assert.equal(armed.canonicalCycleOrigin, "100");
  runLedger(ledger, { canonicalCycles: 5n, retiredBlocks: 1n });
  const publication = ledger.recordNavigationPublication({ sequenceLo: 1, sequenceHi: 0 }, 1);
  assert.equal(publication.targetCanonicalCycle, "105");

  const issued = ledger.issue({
    cycleUpperCap: "2",
    maxHostCalls: 4,
    maxColdInstalls: 4,
  });
  const scheduler = schedulerInterval(issued.schedulerStart, {
    canonicalCycles: 2n,
    executedCycles: 1n,
    executedInstructions: 1n,
    retiredBlocks: 1n,
  });
  const si = siAuthority({
    pollIndex: 1n,
    scheduledCycle: 106n,
    observedCycle: 107n,
    sequenceLo: 1,
    controller: a,
    controllerMode: 3,
  });
  const checkpoint = ledger.observeIntermediateAuthority({
    scheduler,
    si,
    hostCalls: 2,
    coldInstalls: 3,
  });
  assert.equal(checkpoint.navigation.durableSteps, 1);
  assert.equal(checkpoint.navigation.pendingPublication, null);
  assert.equal(checkpoint.runSummary.canonicalCycle, "107");
  assert.equal(checkpoint.runSummary.reportedCanonicalCycles, "7");
  assert.equal(checkpoint.runSummary.reportedHostCalls, 2);
  assert.equal(checkpoint.runSummary.reportedColdInstalls, 3);
  assert.equal(checkpoint.runSummary.operatorPublications, 1);
  assert.equal(ledger.summary().canonicalCycle, "105");
  assert.equal(ledger.summary().reportedHostCalls, 0);
  assert.equal(ledger.summary().reportedColdInstalls, 0);
  assert.equal(ledger.summary().operatorPublications, 0);

  ledger.commitNavigationCheckpoint();
  ledger.accept(rustResult(issued.schedulerStart, {
    canonicalCycles: 2n,
    executedCycles: 1n,
    executedInstructions: 1n,
    retiredBlocks: 1n,
  }, { si, hostCalls: 2, coldInstalls: 3 }));
  assert.equal(ledger.summary().canonicalCycle, "107");
  assert.equal(ledger.summary().reportedHostCalls, 2);
  assert.equal(ledger.summary().reportedColdInstalls, 3);
  assert.equal(ledger.summary().operatorPublications, 1);
});

function pendingReceiptHarness() {
  const neutral = { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 };
  const ledger = new ResidentCaptureRunLedger(smallNavigationPolicy([
    { minimumCanonicalDelay: "5", ...neutral },
  ]), () => 0);
  const readySi = siAuthority({
    pollIndex: 1n,
    scheduledCycle: 0n,
    observedCycle: 0n,
    sequenceLo: 0,
    controller: neutral,
  });
  ledger.startAtReady(readyAuthority(schedulerPoint(), readySi));
  ledger.armNavigation(0);
  runLedger(ledger, {
    canonicalCycles: 10n,
    executedCycles: 1n,
    executedInstructions: 1n,
    retiredBlocks: 1n,
  }, { si: readySi });
  const publication = ledger.recordNavigationPublication({ sequenceLo: 1, sequenceHi: 0 }, 1);
  const issued = ledger.issue({ cycleUpperCap: "1" });
  const scheduler = schedulerInterval(issued.schedulerStart, {
    canonicalCycles: 1n,
    executedCycles: 1n,
    executedInstructions: 1n,
    retiredBlocks: 1n,
  });
  const si = siAuthority({
    pollIndex: 2n,
    scheduledCycle: 11n,
    observedCycle: 11n,
    sequenceLo: 1,
    controller: neutral,
  });
  return { ledger, publication, scheduler, si, neutral };
}

test("navigation rejects early input and accepts a bounded unaligned publication", () => {
  const neutral = { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 };
  const ledger = new ResidentCaptureRunLedger(smallNavigationPolicy([
    { minimumCanonicalDelay: "5", ...neutral },
  ]), () => 0);
  ledger.startAtReady(readyAuthority());
  ledger.armNavigation(0);
  assert.throws(
    () => ledger.recordNavigationPublication({ sequenceLo: 1, sequenceHi: 0 }, 1),
    /before its canonical target/,
  );
  runLedger(ledger, {
    canonicalCycles: 10n,
    executedCycles: 1n,
    executedInstructions: 1n,
    retiredBlocks: 1n,
  });
  const publication = ledger.recordNavigationPublication({ sequenceLo: 1, sequenceHi: 0 }, 1);
  assert.equal(publication.targetCanonicalCycle, "5");
  assert.equal(publication.publicationCanonicalCycle, "10");
  assert.equal(publication.publicationOvershootCycles, "5");
  assert.ok(BigInt(publication.publicationOvershootCycles) <= 10n);
});

test("navigation SI receipts authenticate sequence, source, mode, semantics, packet, and poll", () => {
  const cases = [
    {
      name: "skipped sequence",
      mutate: si => ({ ...si, appliedSequenceLo: 2 }),
      pattern: /skipped the pending navigation controller sequence/,
    },
    {
      name: "non-periodic source",
      mutate: si => ({ ...si, source: 1 }),
      pattern: /not a periodic SI publication/,
    },
    {
      name: "invalid controller mode",
      mutate: si => ({ ...si, controllerMode: 8 }),
      pattern: /chronology changed/,
    },
    {
      name: "semantic drift",
      mutate: si => ({ ...si, buttons: 1 }),
      pattern: /semantic state/,
    },
    {
      name: "packet drift",
      mutate: si => ({ ...si, packetWord0: si.packetWord0 ^ 1 }),
      pattern: /packet does not match/,
    },
    {
      name: "stale poll",
      mutate: si => ({ ...si, pollIndex: "1" }),
      pattern: /did not advance/,
    },
    {
      name: "pre-publication schedule",
      mutate: si => ({ ...si, scheduledCycle: "9", observedCycle: "11" }),
      pattern: /scheduled before its controller publication/,
    },
  ];
  for (const { name, mutate, pattern } of cases) {
    const { ledger, scheduler, si } = pendingReceiptHarness();
    assert.throws(() => ledger.observeIntermediateAuthority({
      scheduler,
      si: mutate(si),
      hostCalls: 0,
      coldInstalls: 0,
    }), pattern, name);
  }

  const { ledger, scheduler, si } = pendingReceiptHarness();
  assert.equal(ledger.observeIntermediateAuthority({
    scheduler,
    si: { ...si, appliedSequenceLo: 0 },
    hostCalls: 0,
    coldInstalls: 0,
  }), null, "an older SI sequence must not acknowledge the pending controller");
});

test("all 34 Wario publications end in a durable neutral SI receipt before Baseline", () => {
  const navigationPolicy = productionFidelityNavigationPolicy("warioware-usa");
  assert.equal(navigationPolicy.steps.length, 34);
  const ledger = new ResidentCaptureRunLedger({
    ...CAPTURE_RUN_POLICY,
    instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
    executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
    canonicalCycleUpperCap: PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
    sliceCycleUpperCap: "5000000000",
    blockUpperCap: 100,
    totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
    navigationPolicy,
  }, () => 0);
  ledger.startAtReady(readyAuthority());
  ledger.armNavigation(0);
  let currentSi = null;

  for (let index = 0; index < navigationPolicy.steps.length; index += 1) {
    const target = ledger.nextNavigationTarget();
    const current = BigInt(ledger.summary().canonicalCycle);
    runLedger(ledger, {
      canonicalCycles: target - current,
      executedCycles: target - current,
      executedInstructions: (target - current) / 2n,
      retiredBlocks: 1n,
    }, { si: currentSi });
    const publication = ledger.recordNavigationPublication({
      sequenceLo: index + 1,
      sequenceHi: 0,
    }, 1);
    const issued = ledger.issue({ cycleUpperCap: "1" });
    const receiptCycle = BigInt(publication.publicationCanonicalCycle) + 1n;
    const si = siAuthority({
      pollIndex: BigInt(index + 1),
      scheduledCycle: receiptCycle,
      observedCycle: receiptCycle,
      sequenceLo: index + 1,
      controller: navigationPolicy.steps[index],
      controllerMode: index % 8,
    });
    ledger.accept(rustResult(issued.schedulerStart, {
      canonicalCycles: 1n,
      executedCycles: 1n,
      executedInstructions: 1n,
      retiredBlocks: 1n,
    }, { si }));
    const checkpoint = ledger.pendingNavigationCheckpoint();
    assert.equal(checkpoint.navigationStep.stepIndex, index);
    assert.equal(checkpoint.navigationStep.siAppliedSequenceLo, index + 1);
    assert.equal(checkpoint.navigationStep.siSource, 0);
    assert.equal(checkpoint.navigationStep.siControllerMode, index % 8);
    ledger.commitNavigationCheckpoint();
    currentSi = si;
  }

  const navigation = ledger.navigationSnapshot();
  const terminal = navigation.transcript.at(-1);
  assert.equal(navigation.durableSteps, 34);
  assert.equal(navigation.complete, true);
  assert.equal(navigation.pendingPublication, null);
  assert.equal(navigation.nextTargetCanonicalCycle, null);
  assert.deepEqual({
    buttons: terminal.siButtons,
    stickXyCxy: terminal.siStickXyCxy,
    triggerLrab: terminal.siTriggerLrab,
  }, {
    buttons: 0,
    stickXyCxy: 0x8080_8080,
    triggerLrab: 0,
  });
  assert.equal(ledger.summary().operatorPublications, 34);
  assert.doesNotThrow(() => ledger.assertNavigationComplete());
});

test("empty navigation scripts arm at Baseline but nonempty scripts are phase-zero-only", () => {
  let ledger = new ResidentCaptureRunLedger(CAPTURE_RUN_POLICY, () => 0);
  assert.throws(() => ledger.armNavigation(1), /not started at resident-ready/);
  ledger.startAtReady(readyAuthority());
  assert.throws(() => ledger.assertNavigationComplete(), /requires armed navigation policy/);
  const empty = ledger.armNavigation(1);
  assert.equal(empty.stepCount, 0);
  assert.equal(empty.durableSteps, 0);
  assert.equal(empty.complete, true);
  assert.doesNotThrow(() => ledger.assertNavigationComplete());
  assert.throws(() => ledger.armNavigation(1), /already armed/);

  ledger = new ResidentCaptureRunLedger(smallNavigationPolicy([
    {
      minimumCanonicalDelay: "1",
      buttons: 0,
      stickXyCxy: 0x8080_8080,
      triggerLrab: 0,
    },
  ]), () => 0);
  ledger.startAtReady(readyAuthority());
  assert.throws(() => ledger.armNavigation(1), /only in phase 0/);
  assert.equal(ledger.armNavigation(0).complete, false);
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
  assert.equal(ready.runSummary.schema, "lazuli-resident-cumulative-run-summary-v2");
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

test("locked navigation is Worker-owned, target-gated, and poll-serialized", async () => {
  const neutral = { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 };
  const runPolicy = smallNavigationPolicy([
    { minimumCanonicalDelay: "1", ...neutral },
  ]);
  let harness = workerHarness({ publishStatus: 1 });
  await initializeCapture(harness, 1, { runPolicy });
  let armed = await armNavigation(harness, 2);
  assert.equal(armed.navigation.schema, "lazuli-resident-navigation-runtime-v2");
  assert.equal(armed.navigation.runCallOrigin, 0);
  assert.equal(armed.navigation.canonicalCycleOrigin, "0");
  assert.equal(armed.navigation.durableSteps, 0);

  harness.scope.receive({ type: "resident-controller-navigation", requestId: 3 });
  const early = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 3,
    "early navigation rejection",
  );
  assert.match(early.error, /before its canonical target/);
  assert.deepEqual(harness.publishCalls, []);

  harness = workerHarness({ publishStatus: 1 });
  await initializeCapture(harness, 1, { runPolicy });
  armed = await armNavigation(harness, 2);
  assert.equal(armed.navigation.durableSteps, 0);
  harness.scope.receive({ type: "resident-run", requestId: 4 });
  const run = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-run-result" && message.requestId === 4,
    "navigation target run",
  );
  assert.equal(run.runSummary.canonicalCycle, "1");
  harness.scope.receive({ type: "resident-fidelity-state", requestId: 5 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-fidelity-state-result" && message.requestId === 5,
    "post-run fidelity poll",
  );

  harness.scope.receive({ type: "resident-controller-navigation", requestId: 6 });
  const result = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-controller-navigation-result"
      && message.requestId === 6,
    "locked navigation result",
  );
  assert.deepEqual(harness.publishCalls, [{
    sequenceLo: 1,
    sequenceHi: 0,
    ...neutral,
  }]);
  assert.equal(result.navigationStep.stepIndex, 0);
  assert.equal(result.navigationStep.targetCanonicalCycle, "1");
  assert.equal(result.navigation.pendingPublication.stepIndex, 0);
  assert.equal(result.navigation.durableSteps, 0);
  assert.equal(result.runSummary.operatorPublications, 0);

  harness.scope.receive({ type: "resident-controller-navigation", requestId: 7 });
  const missingPoll = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 7,
    "mandatory navigation poll rejection",
  );
  assert.match(missingPoll.error, /must be polled after the prior command boundary/);
});

test("locked navigation rejects caller words, backpressure, and Baseline crossing", async () => {
  const neutral = { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 };
  const runPolicy = smallNavigationPolicy([
    { minimumCanonicalDelay: "1", ...neutral },
  ]);

  let harness = workerHarness({ publishStatus: 1 });
  await initializeCapture(harness, 1, { runPolicy });
  await armNavigation(harness, 2);
  harness.scope.receive({ type: "resident-run", requestId: 3 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-run-result" && message.requestId === 3,
    "caller-word target run",
  );
  harness.scope.receive({ type: "resident-fidelity-state", requestId: 4 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-fidelity-state-result" && message.requestId === 4,
    "caller-word target poll",
  );
  harness.scope.receive({
    type: "resident-controller-navigation",
    requestId: 5,
    buttons: neutral.buttons,
  });
  let error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 5,
    "caller-supplied navigation rejection",
  );
  assert.match(error.error, /cannot supply controller state/);
  assert.deepEqual(harness.publishCalls, []);

  harness = workerHarness({ publishStatus: 0 });
  const ready = await initializeCapture(harness, 1, { runPolicy });
  await armNavigation(harness, 2);
  harness.scope.receive({ type: "resident-run", requestId: 3 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-run-result" && message.requestId === 3,
    "backpressure target run",
  );
  harness.scope.receive({ type: "resident-fidelity-state", requestId: 4 });
  await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-fidelity-state-result" && message.requestId === 4,
    "backpressure target poll",
  );
  harness.scope.receive({ type: "resident-controller-navigation", requestId: 5 });
  error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 5,
    "backpressured navigation rejection",
  );
  assert.match(error.error, /not exactly Queued/);
  assert.equal(ready.runSummary.operatorPublications, 0);

  harness = workerHarness({ publishStatus: 1 });
  await initializeCapture(harness, 1, { runPolicy });
  await armNavigation(harness, 2);
  harness.setFidelityState(1, neutral);
  harness.scope.receive({ type: "resident-controller-navigation", requestId: 3 });
  error = await waitForWorkerMessage(
    harness.scope,
    message => message.type === "resident-error" && message.requestId === 3,
    "post-Baseline navigation rejection",
  );
  assert.match(error.error, /allowed only before Baseline/);
  assert.deepEqual(harness.publishCalls, []);
});

test("empty navigation can arm at Baseline and has no synthetic controller publication", async () => {
  const harness = workerHarness({ publishStatus: 1 });
  await initializeCapture(harness);
  harness.setFidelityState(1, {
    buttons: 1,
    stickXyCxy: 0x8080_8001,
    triggerLrab: 0,
  });
  const armed = await armNavigation(harness, 2);
  assert.equal(armed.navigation.stepCount, 0);
  assert.equal(armed.navigation.complete, true);
  assert.equal(armed.runSummary.operatorPublications, 0);
  assert.deepEqual(harness.publishCalls, []);
});
test("atomic witness publishes Rust Baseline words once and blocks on durable ACK", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  await armNavigation(harness, 2);

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
    sequenceLo: 1,
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
    sequenceLo: 1,
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
  assert.equal(harness.publishCalls.length, 1);
});

test("witness checkpoint rejection permanently faults capture", async () => {
  const harness = workerHarness();
  await initializeCapture(harness);
  await armNavigation(harness, 20);
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
  await armNavigation(harness, 20);
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
