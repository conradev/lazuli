// SPDX-License-Identifier: GPL-3.0-only

import {
  RawBlobContainer,
  ResidentMachineAdapter,
  openRawHttpContainer,
} from "./resident-machine.mjs";

function ownedBytes(value, label) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error(`${label} did not contain bytes`);
}

export class MainThreadRendererRelay {
  constructor(scope) {
    this.scope = scope;
    this.nextRequest = 1;
    this.pending = new Map();
    this.captureFidelity = false;
    this.lastSettled = null;
    this.lastFidelityPhase = 0;
    this.pendingObservation = null;
    this.pendingNavigationArmCheckpoint = null;
    this.pendingNavigationCheckpoint = null;
    this.pendingWitnessCheckpoint = null;
    this.fidelityPollRequired = false;
    this.captureFault = null;
    this.acceptedBoundary = false;
  }

  configureFidelityCapture(enabled) {
    if (typeof enabled !== "boolean") throw new Error("captureFidelity must be a boolean");
    if (
      this.pending.size !== 0
      || this.pendingObservation !== null
      || this.pendingNavigationArmCheckpoint !== null
      || this.pendingNavigationCheckpoint !== null
      || this.pendingWitnessCheckpoint !== null
      || this.lastSettled !== null
    ) {
      throw new Error("renderer relay fidelity capture cannot change while work is pending");
    }
    this.captureFidelity = enabled;
  }

  assertCaptureAvailable() {
    if (this.captureFault !== null) throw this.captureFault;
  }

  latchCaptureFault(error) {
    if (!this.captureFidelity || this.captureFault !== null) return;
    this.captureFault = error instanceof Error ? error : new Error(String(error));
  }

  assertMachineProgressAvailable() {
    this.assertCaptureAvailable();
    if (this.acceptedBoundary) {
      throw new Error("resident machine reached its accepted fidelity boundary");
    }
  }

  requireFidelityPoll() {
    if (this.captureFidelity) this.fidelityPollRequired = true;
  }

  assertFidelityPollSatisfied(messageType) {
    if (messageType === "resident-close") return;
    this.assertCaptureAvailable();
    if (
      this.captureFidelity
      && this.fidelityPollRequired
      && messageType !== "resident-fidelity-state"
    ) {
      throw new Error("resident fidelity state must be polled after the prior command boundary");
    }
  }

  completeFidelityPoll(state) {
    this.assertCaptureAvailable();
    this.fidelityPollRequired = false;
    if (state.phase === 6) {
      this.captureFault = new Error("Rust GameFidelityV1 entered Failed");
    }
  }

  submit_resident_render(request, requestFlags, sequenceLo, sequenceHi) {
    this.assertCaptureAvailable();
    const id = this.nextRequest++;
    if (!Number.isSafeInteger(id)) throw new Error("renderer relay request id exhausted");
    const source = ownedBytes(request, "resident render request");
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        identity: Object.freeze({
          id,
          requestFlags: requestFlags >>> 0,
          sequenceLo: sequenceLo >>> 0,
          sequenceHi: sequenceHi >>> 0,
        }),
      });
    });
    // A prior renderer receipt can remain unobserved only when Rust rejected its semantic
    // completion. It can never identify this newly issued request.
    this.lastSettled = null;
    this.scope.postMessage({
      type: "resident-render-request",
      id,
      source,
      requestFlags: requestFlags >>> 0,
      sequenceLo: sequenceLo >>> 0,
      sequenceHi: sequenceHi >>> 0,
    }, [source.buffer]);
    return promise;
  }

  settle(message) {
    const id = message.id;
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (message.type === "resident-render-receipt") {
      try {
        const receipt = ownedBytes(message.receipt, "resident renderer receipt");
        if (this.captureFidelity) this.lastSettled = pending.identity;
        pending.resolve(receipt);
      } catch (error) {
        pending.reject(error);
      }
    } else {
      pending.reject(new Error(String(message.error ?? "browser renderer failed")));
    }
    return true;
  }

  async observe_resident_fidelity(state) {
    try {
      this.assertCaptureAvailable();
      if (!this.captureFidelity) return null;
      const identity = this.lastSettled;
      if (identity === null) {
        throw new Error("Rust accepted a render without one settled renderer relay identity");
      }
      this.lastSettled = null;
      const phase = state?.phase;
      if (!Number.isInteger(phase) || phase < 0 || phase > 6) {
        throw new Error(`resident fidelity observation has invalid phase ${String(phase)}`);
      }
      const changed = phase !== this.lastFidelityPhase;
      if (!changed || (phase !== 1 && phase !== 5 && phase !== 6)) return null;
      if (this.pendingObservation !== null) {
        throw new Error("resident fidelity observation overlap");
      }

      const acknowledged = new Promise((resolve, reject) => {
        this.pendingObservation = { id: identity.id, resolve, reject };
      });
      this.scope.postMessage({
        type: "resident-fidelity-observation",
        ...identity,
        state,
      });
      await acknowledged;
      this.lastFidelityPhase = phase;
      if (phase === 5) {
        this.acceptedBoundary = true;
        return "accepted";
      }
      return null;
    } catch (error) {
      this.latchCaptureFault(error);
      throw this.captureFault;
    }
  }

  settleObservation(message) {
    const pending = this.pendingObservation;
    if (pending === null || message.id !== pending.id) return false;
    this.pendingObservation = null;
    if (message.type === "resident-fidelity-observation-ack") {
      pending.resolve();
    } else {
      pending.reject(new Error(String(
        message.error ?? "main thread rejected resident fidelity observation",
      )));
    }
    return true;
  }

  async awaitNavigationCheckpoint(requestId, result) {
    this.assertCaptureAvailable();
    if (!this.captureFidelity) {
      throw new Error("navigation checkpoint requires fidelity capture");
    }
    if (this.pendingNavigationCheckpoint !== null) {
      throw new Error("navigation checkpoint overlap");
    }
    const acknowledged = new Promise((resolve, reject) => {
      this.pendingNavigationCheckpoint = { requestId, resolve, reject };
    });
    this.scope.postMessage({
      type: "resident-controller-navigation-checkpoint",
      requestId,
      ...result,
    });
    try {
      await acknowledged;
    } catch (error) {
      this.latchCaptureFault(error);
      throw this.captureFault;
    }
  }

  async awaitNavigationArmCheckpoint(requestId, result) {
    this.assertCaptureAvailable();
    if (!this.captureFidelity) throw new Error("navigation arm checkpoint requires fidelity capture");
    if (this.pendingNavigationArmCheckpoint !== null) {
      throw new Error("navigation arm checkpoint overlap");
    }
    const acknowledged = new Promise((resolve, reject) => {
      this.pendingNavigationArmCheckpoint = { requestId, resolve, reject };
    });
    this.scope.postMessage({
      type: "resident-controller-navigation-arm-checkpoint",
      requestId,
      ...result,
    });
    try {
      await acknowledged;
    } catch (error) {
      this.latchCaptureFault(error);
      throw this.captureFault;
    }
  }

  settleNavigationArmCheckpoint(message) {
    const pending = this.pendingNavigationArmCheckpoint;
    if (pending === null || message.requestId !== pending.requestId) return false;
    this.pendingNavigationArmCheckpoint = null;
    if (message.type === "resident-controller-navigation-arm-checkpoint-ack") {
      pending.resolve();
    } else {
      pending.reject(new Error(String(
        message.error ?? "main thread rejected the navigation arm checkpoint",
      )));
    }
    return true;
  }

  settleNavigationCheckpoint(message) {
    const pending = this.pendingNavigationCheckpoint;
    if (pending === null || message.requestId !== pending.requestId) return false;
    this.pendingNavigationCheckpoint = null;
    if (message.type === "resident-controller-navigation-checkpoint-ack") {
      pending.resolve();
    } else {
      pending.reject(new Error(String(
        message.error ?? "main thread rejected the navigation checkpoint",
      )));
    }
    return true;
  }

  async awaitWitnessCheckpoint(requestId, result) {
    this.assertCaptureAvailable();
    if (!this.captureFidelity) {
      throw new Error("controller witness checkpoint requires fidelity capture");
    }
    if (this.pendingWitnessCheckpoint !== null) {
      throw new Error("controller witness checkpoint overlap");
    }
    const acknowledged = new Promise((resolve, reject) => {
      this.pendingWitnessCheckpoint = { requestId, resolve, reject };
    });
    this.scope.postMessage({
      type: "resident-controller-witness-checkpoint",
      requestId,
      ...result,
    });
    try {
      await acknowledged;
    } catch (error) {
      this.latchCaptureFault(error);
      throw this.captureFault;
    }
  }

  settleWitnessCheckpoint(message) {
    const pending = this.pendingWitnessCheckpoint;
    if (pending === null || message.requestId !== pending.requestId) return false;
    this.pendingWitnessCheckpoint = null;
    if (message.type === "resident-controller-witness-checkpoint-ack") {
      pending.resolve();
    } else {
      pending.reject(new Error(String(
        message.error ?? "main thread rejected the controller witness checkpoint",
      )));
    }
    return true;
  }

  close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("resident worker closed"));
    }
    this.pending.clear();
    this.lastSettled = null;
    if (this.pendingObservation !== null) {
      this.pendingObservation.reject(new Error("resident worker closed"));
      this.pendingObservation = null;
    }
    if (this.pendingNavigationCheckpoint !== null) {
      this.pendingNavigationCheckpoint.reject(new Error("resident worker closed"));
      this.pendingNavigationCheckpoint = null;
    }
    if (this.pendingNavigationArmCheckpoint !== null) {
      this.pendingNavigationArmCheckpoint.reject(new Error("resident worker closed"));
      this.pendingNavigationArmCheckpoint = null;
    }
    if (this.pendingWitnessCheckpoint !== null) {
      this.pendingWitnessCheckpoint.reject(new Error("resident worker closed"));
      this.pendingWitnessCheckpoint = null;
    }
  }
}

function artifactUrl(scope, value, label) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new Error(`${label} must be a URL`);
  }
  return new URL(value, scope.location.href);
}

async function rawContainerFrom(scope, descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error("resident worker requires a raw disc descriptor");
  }
  if (descriptor.kind === "blob") return new RawBlobContainer(descriptor.blob);
  if (descriptor.kind === "http-range") {
    return openRawHttpContainer(descriptor.url, { baseUrl: scope.location.href });
  }
  throw new Error(`unsupported raw disc transport ${String(descriptor.kind)}`);
}

function serializableRunResult(result) {
  if (result.boundary !== "rust") return result;
  return {
    ...result,
    cycleUpperCap: result.cycleUpperCap.toString(),
    outcome: {
      ...result.outcome,
      executedCycles: result.outcome.executedCycles.toString(),
      executedInstructions: result.outcome.executedInstructions.toString(),
    },
  };
}

const CAPTURE_RUN_POLICY_FIELDS = Object.freeze([
  "instructionUpperCap",
  "executedCycleUpperCap",
  "canonicalCycleUpperCap",
  "sliceCycleUpperCap",
  "blockUpperCap",
  "totalHostCallCap",
  "totalColdInstallCap",
  "maxBootReads",
  "bootTimeoutMs",
  "sliceTimeoutMs",
  "runTimeoutMs",
  "externalWallTimeoutMs",
  "zeroProgressSliceCap",
  "workerUrl",
  "navigationPolicy",
]);
const CAPTURE_OPERATOR_PUBLICATION_CAP = 65;
const CAPTURE_NAVIGATION_SCHEMA = "lazuli-resident-pre-baseline-navigation-v1";
const CAPTURE_NAVIGATION_ALGORITHM = "locked-si-observed-not-before-publication-v1";
const CAPTURE_NAVIGATION_BUTTON_MASK = 0x0000_1f7f;
const CAPTURE_NAVIGATION_POLICY_FIELDS = Object.freeze([
  "schema",
  "gameKey",
  "algorithm",
  "cycleOrigin",
  "controllerEncoding",
  "targetAnchor",
  "receiptSource",
  "periodicSiCycles",
  "maximumReceiptLatencyCycles",
  "maximumPublications",
  "scriptSha256",
  "steps",
]);
const CAPTURE_NAVIGATION_STEP_FIELDS = Object.freeze([
  "minimumCanonicalDelay",
  "buttons",
  "stickXyCxy",
  "triggerLrab",
]);
const CAPTURE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

function exactObjectFields(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} fields changed`);
  }
}

function exactNavigationU32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be an exact u32`);
  }
  return value >>> 0;
}

function exactCaptureNavigationPolicy(value) {
  exactObjectFields(value, CAPTURE_NAVIGATION_POLICY_FIELDS, "capture navigationPolicy");
  if (value.schema !== CAPTURE_NAVIGATION_SCHEMA) {
    throw new Error("capture navigationPolicy schema changed");
  }
  if (typeof value.gameKey !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.gameKey)) {
    throw new Error("capture navigationPolicy gameKey changed");
  }
  if (value.algorithm !== CAPTURE_NAVIGATION_ALGORITHM) {
    throw new Error("capture navigationPolicy algorithm changed");
  }
  if (value.cycleOrigin !== "durable-first-frame-canonical-scheduler-cycle") {
    throw new Error("capture navigationPolicy cycle origin changed");
  }
  if (value.controllerEncoding !== "gamecube-packed-controller-v1") {
    throw new Error("capture navigationPolicy controller encoding changed");
  }
  if (
    value.targetAnchor !== "prior-si-observed-cycle"
    || value.receiptSource !== "periodic"
    || value.periodicSiCycles !== "8108100"
    || value.maximumReceiptLatencyCycles !== "16108100"
  ) {
    throw new Error("capture navigationPolicy SI receipt authority changed");
  }
  if (value.maximumPublications !== CAPTURE_OPERATOR_PUBLICATION_CAP) {
    throw new Error("capture navigationPolicy publication cap changed");
  }
  if (typeof value.scriptSha256 !== "string" || !CAPTURE_SHA256_PATTERN.test(value.scriptSha256)) {
    throw new Error("capture navigationPolicy scriptSha256 changed");
  }
  if (!Array.isArray(value.steps) || value.steps.length > value.maximumPublications) {
    throw new Error("capture navigationPolicy steps exceed the publication cap");
  }
  const steps = value.steps.map((step, index) => {
    const label = `capture navigationPolicy steps[${index}]`;
    exactObjectFields(step, CAPTURE_NAVIGATION_STEP_FIELDS, label);
    if (
      typeof step.minimumCanonicalDelay !== "string"
      || !/^[1-9][0-9]*$/.test(step.minimumCanonicalDelay)
    ) {
      throw new Error(`${label} canonical delay is not a positive decimal string`);
    }
    const buttons = exactNavigationU32(step.buttons, `${label} buttons`);
    if ((buttons & ~CAPTURE_NAVIGATION_BUTTON_MASK) !== 0) {
      throw new Error(`${label} buttons include reserved bits`);
    }
    return Object.freeze({
      minimumCanonicalDelay: step.minimumCanonicalDelay,
      buttons,
      stickXyCxy: exactNavigationU32(step.stickXyCxy, `${label} sticks`),
      triggerLrab: exactNavigationU32(step.triggerLrab, `${label} triggers`),
    });
  });
  if (steps.length !== 0) {
    const terminal = steps.at(-1);
    if (
      terminal.buttons !== 0
      || terminal.stickXyCxy !== 0x8080_8080
      || terminal.triggerLrab !== 0
    ) {
      throw new Error("capture navigationPolicy must terminate in exact neutral state");
    }
  }
  return Object.freeze({
    schema: value.schema,
    gameKey: value.gameKey,
    algorithm: value.algorithm,
    cycleOrigin: value.cycleOrigin,
    controllerEncoding: value.controllerEncoding,
    targetAnchor: value.targetAnchor,
    receiptSource: value.receiptSource,
    periodicSiCycles: value.periodicSiCycles,
    maximumReceiptLatencyCycles: value.maximumReceiptLatencyCycles,
    maximumPublications: value.maximumPublications,
    scriptSha256: value.scriptSha256,
    steps: Object.freeze(steps),
  });
}

function canonicalCaptureJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCaptureJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalCaptureJson(value[key])}`
  ).join(",")}}`;
}

async function verifyCaptureNavigationScript(policy, cryptoAuthority) {
  if (typeof cryptoAuthority?.subtle?.digest !== "function") {
    throw new Error("capture Worker has no cryptographic digest authority");
  }
  const bytes = new TextEncoder().encode(canonicalCaptureJson(policy.steps));
  const digest = new Uint8Array(await cryptoAuthority.subtle.digest("SHA-256", bytes));
  const actual = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== policy.scriptSha256) {
    throw new Error("capture navigationPolicy script SHA-256 changed");
  }
}

function exactCaptureRunPolicy(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture runPolicy must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = [...CAPTURE_RUN_POLICY_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("capture runPolicy fields changed");
  }
  const decimal = (field) => {
    const raw = value[field];
    if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
      throw new Error(`capture runPolicy ${field} must be a positive decimal string`);
    }
    return BigInt(raw);
  };
  const integer = (field) => {
    const raw = value[field];
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new Error(`capture runPolicy ${field} must be a positive safe integer`);
    }
    return raw;
  };
  const policy = Object.freeze({
    instructionUpperCap: decimal("instructionUpperCap"),
    executedCycleUpperCap: decimal("executedCycleUpperCap"),
    canonicalCycleUpperCap: decimal("canonicalCycleUpperCap"),
    sliceCycleUpperCap: decimal("sliceCycleUpperCap"),
    blockUpperCap: integer("blockUpperCap"),
    totalHostCallCap: integer("totalHostCallCap"),
    totalColdInstallCap: integer("totalColdInstallCap"),
    maxBootReads: integer("maxBootReads"),
    bootTimeoutMs: integer("bootTimeoutMs"),
    sliceTimeoutMs: integer("sliceTimeoutMs"),
    runTimeoutMs: integer("runTimeoutMs"),
    externalWallTimeoutMs: integer("externalWallTimeoutMs"),
    zeroProgressSliceCap: integer("zeroProgressSliceCap"),
    workerUrl: value.workerUrl,
    navigationPolicy: exactCaptureNavigationPolicy(value.navigationPolicy),
  });
  if (
    policy.sliceCycleUpperCap > policy.executedCycleUpperCap
    || policy.sliceCycleUpperCap > policy.canonicalCycleUpperCap
  ) {
    throw new Error("capture runPolicy slice cycle cap exceeds a total cycle cap");
  }
  if (typeof policy.workerUrl !== "string" || !policy.workerUrl.startsWith("/")) {
    throw new Error("capture runPolicy workerUrl must be a same-origin absolute path");
  }
  return policy;
}

function nonnegativeResultInteger(value, label) {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} was not a nonnegative safe integer`);
  }
  return result;
}

function nonnegativeResultBigInt(value, label) {
  let result;
  try {
    result = BigInt(value ?? 0);
  } catch {
    throw new Error(`${label} was not an unsigned integer`);
  }
  if (result < 0n) throw new Error(`${label} was not an unsigned integer`);
  return result;
}

function exactResultU32(value, label) {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < 0
    || value > 0xffff_ffff
  ) {
    throw new Error(`${label} was not an exact u32`);
  }
  return value;
}

function exactRustOutcomeIdentity(outcome) {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("reported Rust outcome was not an object");
  }
  const reason = exactResultU32(outcome.reason, "reported Rust outcome reason");
  const detail = exactResultU32(outcome.detail, "reported Rust outcome detail");
  if (reason > 6) {
    throw new Error("reported Rust outcome reason was outside the RunReason ABI");
  }
  if (reason === 0 && detail > 8) {
    throw new Error("reported BudgetExhausted detail was outside the RunOutcomeDetail ABI");
  }
  return Object.freeze({ reason, detail });
}

const SCHEDULER_POINT_FIELDS = Object.freeze([
  "canonicalCycle",
  "executedCycles",
  "executedInstructions",
  "retiredBlocks",
]);
const SCHEDULER_DELTA_FIELDS = Object.freeze([
  "canonicalCycles",
  "executedCycles",
  "executedInstructions",
  "retiredBlocks",
]);

function exactDecimalBigInt(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} was not an unsigned decimal string`);
  }
  return BigInt(value);
}

function exactSchedulerPoint(value, label) {
  exactObjectFields(value, SCHEDULER_POINT_FIELDS, label);
  return Object.freeze(Object.fromEntries(SCHEDULER_POINT_FIELDS.map(field => [
    field,
    exactDecimalBigInt(value[field], `${label} ${field}`),
  ])));
}

function exactSchedulerInterval(value) {
  exactObjectFields(value, ["schema", "start", "end", "delta"], "scheduler interval");
  if (value.schema !== "lazuli-resident-authenticated-scheduler-interval-v1") {
    throw new Error("scheduler interval schema changed");
  }
  const start = exactSchedulerPoint(value.start, "scheduler interval start");
  const end = exactSchedulerPoint(value.end, "scheduler interval end");
  exactObjectFields(value.delta, SCHEDULER_DELTA_FIELDS, "scheduler interval delta");
  const delta = Object.freeze({
    canonicalCycle: exactDecimalBigInt(
      value.delta.canonicalCycles,
      "scheduler interval delta canonicalCycles",
    ),
    executedCycles: exactDecimalBigInt(
      value.delta.executedCycles,
      "scheduler interval delta executedCycles",
    ),
    executedInstructions: exactDecimalBigInt(
      value.delta.executedInstructions,
      "scheduler interval delta executedInstructions",
    ),
    retiredBlocks: exactDecimalBigInt(
      value.delta.retiredBlocks,
      "scheduler interval delta retiredBlocks",
    ),
  });
  for (const field of SCHEDULER_POINT_FIELDS) {
    if (end[field] < start[field] || end[field] - start[field] !== delta[field]) {
      throw new Error(`scheduler interval ${field} chronology changed`);
    }
  }
  return Object.freeze({ start, end, delta });
}

function exactReadyAuthority(value) {
  exactObjectFields(value, ["scheduler", "si"], "ready capture authority");
  exactObjectFields(value.scheduler, SCHEDULER_POINT_FIELDS, "ready scheduler authority");
  const scheduler = Object.freeze(Object.fromEntries(SCHEDULER_POINT_FIELDS.map(field => {
    const raw = value.scheduler[field];
    if (typeof raw !== "bigint" || raw < 0n) {
      throw new Error(`ready scheduler authority ${field} was not a u64`);
    }
    return [field, raw];
  })));
  let si = null;
  if (value.si !== null) {
    exactObjectFields(value.si, [
      "pollIndex", "scheduledCycle", "observedCycle", "appliedSequenceLo",
      "appliedSequenceHi", "packetWord0", "packetWord1", "source", "controllerMode",
      "buttons", "stickXyCxy", "triggerLrab",
    ], "ready SI authority");
    for (const field of ["pollIndex", "scheduledCycle", "observedCycle"]) {
      if (typeof value.si[field] !== "bigint" || value.si[field] < 0n) {
        throw new Error(`ready SI authority ${field} was not a u64`);
      }
    }
    si = Object.freeze({
      pollIndex: value.si.pollIndex,
      scheduledCycle: value.si.scheduledCycle,
      observedCycle: value.si.observedCycle,
      appliedSequenceLo: exactResultU32(value.si.appliedSequenceLo, "ready SI sequenceLo"),
      appliedSequenceHi: exactResultU32(value.si.appliedSequenceHi, "ready SI sequenceHi"),
      packetWord0: exactResultU32(value.si.packetWord0, "ready SI packet word 0"),
      packetWord1: exactResultU32(value.si.packetWord1, "ready SI packet word 1"),
      source: exactResultU32(value.si.source, "ready SI source"),
      controllerMode: exactResultU32(value.si.controllerMode, "ready SI controller mode"),
      buttons: exactResultU32(value.si.buttons, "ready SI buttons"),
      stickXyCxy: exactResultU32(value.si.stickXyCxy, "ready SI sticks"),
      triggerLrab: exactResultU32(value.si.triggerLrab, "ready SI triggers"),
    });
    if (
      si.pollIndex === 0n
      || si.scheduledCycle > si.observedCycle
      || si.observedCycle > scheduler.canonicalCycle
      || si.source > 1
      || si.controllerMode > 7
      || si.buttons > 0xffff
    ) {
      throw new Error("ready SI authority chronology changed");
    }
  }
  return Object.freeze({ scheduler, si });
}

function exactSiAuthority(value) {
  if (value === null) return null;
  exactObjectFields(value, [
    "schema", "pollIndex", "scheduledCycle", "observedCycle", "appliedSequenceLo",
    "appliedSequenceHi", "packetWord0", "packetWord1", "source", "controllerMode",
    "buttons", "stickXyCxy", "triggerLrab",
  ], "SI publication authority");
  if (value.schema !== "lazuli-resident-authenticated-si-publication-v1") {
    throw new Error("SI publication authority schema changed");
  }
  const result = Object.freeze({
    pollIndex: exactDecimalBigInt(value.pollIndex, "SI poll index"),
    scheduledCycle: exactDecimalBigInt(value.scheduledCycle, "SI scheduled cycle"),
    observedCycle: exactDecimalBigInt(value.observedCycle, "SI observed cycle"),
    appliedSequenceLo: exactResultU32(value.appliedSequenceLo, "SI applied sequenceLo"),
    appliedSequenceHi: exactResultU32(value.appliedSequenceHi, "SI applied sequenceHi"),
    packetWord0: exactResultU32(value.packetWord0, "SI packet word 0"),
    packetWord1: exactResultU32(value.packetWord1, "SI packet word 1"),
    source: exactResultU32(value.source, "SI source"),
    controllerMode: exactResultU32(value.controllerMode, "SI controller mode"),
    buttons: exactResultU32(value.buttons, "SI controller buttons"),
    stickXyCxy: exactResultU32(value.stickXyCxy, "SI controller sticks"),
    triggerLrab: exactResultU32(value.triggerLrab, "SI controller triggers"),
  });
  if (
    result.pollIndex === 0n
    || result.scheduledCycle > result.observedCycle
    || result.source > 1
    || result.controllerMode > 7
    || result.buttons > 0xffff
  ) {
    throw new Error("SI publication authority chronology changed");
  }
  return result;
}

function sequenceU64(value) {
  return BigInt(value.sequenceLo) | (BigInt(value.sequenceHi) << 32n);
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
  const word1 = (low[0] << 24 | low[1] << 16 | low[2] << 8 | low[3]) >>> 0;
  return Object.freeze({ word0, word1 });
}

/**
 * Worker-owned, one-machine cumulative execution authority for production fidelity capture.
 * Browser callers may lower a single request, but cannot raise or reset any frozen cap.
 */
export class ResidentCaptureRunLedger {
  constructor(runPolicy, clock = () => performance.now()) {
    if (typeof clock !== "function") throw new Error("capture ledger clock must be a function");
    this.policy = exactCaptureRunPolicy(runPolicy);
    this.clock = clock;
    this.startedAtMs = null;
    this.wallTimeoutMs = Math.min(
      this.policy.runTimeoutMs,
      this.policy.externalWallTimeoutMs,
    );
    this.issuedRunCalls = 0;
    this.authorityOrigin = null;
    this.authorityCurrent = null;
    this.siCurrent = null;
    this.reportedCanonicalCycles = 0n;
    this.reportedExecutedCycles = 0n;
    this.reportedExecutedInstructions = 0n;
    this.reportedRetiredBlocks = 0n;
    this.reportedHostCalls = 0;
    this.reportedColdInstalls = 0;
    this.zeroProgressSlices = 0;
    this.consecutiveZeroProgressSlices = 0;
    this.maximumConsecutiveZeroProgressSlices = 0;
    this.operatorPublications = 0;
    this.witnessPublications = 0;
    this.navigationArmed = false;
    this.navigationRunOrigin = null;
    this.navigationCanonicalOrigin = null;
    this.navigationSiPollIndexOrigin = null;
    this.navigationLastReceiptObservedCanonical = null;
    this.navigationTranscript = [];
    this.pendingNavigationPublication = null;
    this.intermediateAuthority = null;
    this.elapsedWallMs = 0;
    this.accepted = false;
    this.pending = null;
  }

  startAtReady(authority) {
    if (this.startedAtMs !== null) {
      throw new Error("capture ledger resident-ready start was not one-shot");
    }
    const ready = exactReadyAuthority(authority);
    this.authorityOrigin = ready.scheduler;
    this.authorityCurrent = ready.scheduler;
    this.siCurrent = ready.si;
    this.startedAtMs = this.#now();
    return this.summary();
  }

  #now() {
    const value = Number(this.clock());
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("capture ledger monotonic clock returned an invalid value");
    }
    return value;
  }

  #observeWall() {
    if (this.startedAtMs === null) {
      throw new Error("capture ledger was not started at resident-ready");
    }
    const elapsed = Math.max(0, Math.ceil(this.#now() - this.startedAtMs));
    if (elapsed < this.elapsedWallMs) {
      throw new Error("capture ledger monotonic clock regressed");
    }
    this.elapsedWallMs = elapsed;
    if (!this.accepted && elapsed >= this.wallTimeoutMs) {
      throw new Error("capture cumulative wall-time cap exhausted");
    }
  }

  assertProgressAvailable() {
    if (this.accepted) throw new Error("capture ledger reached its Accepted boundary");
    if (this.pending !== null) throw new Error("capture ledger run overlap");
    this.#observeWall();
    if (this.reportedCanonicalCycles >= this.policy.canonicalCycleUpperCap) {
      throw new Error("capture cumulative canonical-cycle cap exhausted");
    }
    if (this.reportedExecutedCycles >= this.policy.executedCycleUpperCap) {
      throw new Error("capture cumulative executed-cycle cap exhausted");
    }
    if (this.reportedExecutedInstructions >= this.policy.instructionUpperCap) {
      throw new Error("capture cumulative instruction cap exhausted");
    }
    if (this.reportedHostCalls >= this.policy.totalHostCallCap) {
      throw new Error("capture cumulative host-call cap exhausted");
    }
    if (this.reportedColdInstalls >= this.policy.totalColdInstallCap) {
      throw new Error("capture cumulative cold-install cap exhausted");
    }
    if (this.consecutiveZeroProgressSlices >= this.policy.zeroProgressSliceCap) {
      throw new Error("capture cumulative zero-progress cap exhausted");
    }
  }

  issue(message) {
    this.assertProgressAvailable();
    if (this.navigationPublicationDue()) {
      throw new Error("capture navigation publication is due before the next run");
    }
    const remainingCanonical = this.policy.canonicalCycleUpperCap - this.reportedCanonicalCycles;
    const remainingExecuted = this.policy.executedCycleUpperCap - this.reportedExecutedCycles;
    const remainingCycles = remainingCanonical < remainingExecuted
      ? remainingCanonical
      : remainingExecuted;
    let maximumCycles = remainingCycles < this.policy.sliceCycleUpperCap
      ? remainingCycles
      : this.policy.sliceCycleUpperCap;
    const requestedCycles = message.cycleUpperCap === undefined
      ? maximumCycles
      : nonnegativeResultBigInt(message.cycleUpperCap, "resident-run cycleUpperCap");
    const requestedBlocks = message.blockUpperCap === undefined
      ? this.policy.blockUpperCap
      : nonnegativeResultInteger(message.blockUpperCap, "resident-run blockUpperCap");
    const remainingHostCalls = this.policy.totalHostCallCap - this.reportedHostCalls;
    const requestedHostCalls = message.maxHostCalls === undefined
      ? remainingHostCalls
      : nonnegativeResultInteger(message.maxHostCalls, "resident-run maxHostCalls");
    const remainingColdInstalls = this.policy.totalColdInstallCap - this.reportedColdInstalls;
    const requestedColdInstalls = message.maxColdInstalls === undefined
      ? remainingColdInstalls
      : nonnegativeResultInteger(message.maxColdInstalls, "resident-run maxColdInstalls");
    if (requestedCycles <= 0n || requestedCycles > maximumCycles) {
      throw new Error("resident-run cycleUpperCap exceeded the frozen remaining slice cap");
    }
    if (requestedBlocks <= 0 || requestedBlocks > this.policy.blockUpperCap) {
      throw new Error("resident-run blockUpperCap exceeded the frozen cap");
    }
    if (requestedHostCalls <= 0 || requestedHostCalls > remainingHostCalls) {
      throw new Error("resident-run maxHostCalls exceeded the frozen remaining cap");
    }
    if (requestedColdInstalls <= 0 || requestedColdInstalls > remainingColdInstalls) {
      throw new Error("resident-run maxColdInstalls exceeded the frozen remaining cap");
    }
    this.issuedRunCalls += 1;
    this.intermediateAuthority = null;
    this.pending = Object.freeze({
      cycleUpperCap: requestedCycles,
      blockUpperCap: requestedBlocks,
      maxHostCalls: requestedHostCalls,
      maxColdInstalls: requestedColdInstalls,
      schedulerStart: this.authorityCurrent,
    });
    return this.pending;
  }

  armNavigation(phase) {
    this.assertProgressAvailable();
    if (this.navigationArmed) throw new Error("capture navigation policy was already armed");
    const script = this.policy.navigationPolicy;
    if (phase !== 0 && !(phase === 1 && script.steps.length === 0)) {
      throw new Error("navigation can be armed only in phase 0, or at Baseline for an empty script");
    }
    this.navigationArmed = true;
    this.navigationRunOrigin = this.issuedRunCalls;
    this.navigationCanonicalOrigin = this.authorityCurrent.canonicalCycle;
    this.navigationSiPollIndexOrigin = this.siCurrent?.pollIndex ?? 0n;
    return this.navigationSnapshot();
  }

  nextNavigationStep() {
    return this.policy.navigationPolicy.steps[this.operatorPublications] ?? null;
  }

  nextNavigationTarget() {
    const step = this.nextNavigationStep();
    if (!this.navigationArmed || step === null || this.pendingNavigationPublication !== null) {
      return null;
    }
    const origin = this.navigationLastReceiptObservedCanonical ?? this.navigationCanonicalOrigin;
    return origin + BigInt(step.minimumCanonicalDelay);
  }

  navigationPublicationDue() {
    const target = this.nextNavigationTarget();
    return target !== null && this.authorityCurrent.canonicalCycle >= target;
  }

  assertNavigationComplete() {
    if (!this.navigationArmed) {
      throw new Error("controller witness requires armed navigation policy");
    }
    if (
      this.operatorPublications !== this.policy.navigationPolicy.steps.length
      || this.pendingNavigationPublication !== null
    ) {
      throw new Error("controller witness requires the complete navigation script");
    }
  }

  recordNavigationPublication(sequence, status) {
    this.assertProgressAvailable();
    if (!this.navigationArmed || this.navigationCanonicalOrigin === null) {
      throw new Error("capture navigation policy was not armed");
    }
    if (this.pendingNavigationPublication !== null) {
      throw new Error("capture navigation publication awaits an SI receipt");
    }
    const stepIndex = this.operatorPublications;
    const controller = this.nextNavigationStep();
    if (controller === null) {
      throw new Error("capture navigation script has no remaining publication");
    }
    const targetCanonicalCycle = this.nextNavigationTarget();
    const publicationCanonicalCycle = this.authorityCurrent.canonicalCycle;
    if (publicationCanonicalCycle < targetCanonicalCycle) {
      throw new Error("navigation controller command arrived before its canonical target");
    }
    const publicationOvershootCycles = publicationCanonicalCycle - targetCanonicalCycle;
    if (publicationOvershootCycles > this.policy.sliceCycleUpperCap) {
      throw new Error("navigation controller command exceeded its bounded publication overshoot");
    }
    const sequenceLo = exactResultU32(sequence?.sequenceLo, "navigation sequenceLo");
    const sequenceHi = exactResultU32(sequence?.sequenceHi, "navigation sequenceHi");
    const publicationStatus = exactResultU32(status, "navigation publication status");
    if (publicationStatus !== 1) {
      throw new Error("locked navigation controller publication was not exactly Queued");
    }
    const publication = Object.freeze({
      stepIndex,
      sequenceLo,
      sequenceHi,
      minimumCanonicalDelay: controller.minimumCanonicalDelay,
      targetCanonicalCycle: targetCanonicalCycle.toString(),
      publicationCanonicalCycle: publicationCanonicalCycle.toString(),
      publicationOvershootCycles: publicationOvershootCycles.toString(),
      buttons: controller.buttons,
      stickXyCxy: controller.stickXyCxy,
      triggerLrab: controller.triggerLrab,
      status: publicationStatus,
      priorSiPollIndex: (this.siCurrent?.pollIndex ?? 0n).toString(),
    });
    this.pendingNavigationPublication = Object.freeze({ publication, receipt: null });
    return publication;
  }

  #observeNavigationReceipt(si, currentCanonicalCycle = this.authorityCurrent.canonicalCycle) {
    const pending = this.pendingNavigationPublication;
    if (pending === null || pending.receipt !== null || si === null) return;
    const publication = pending.publication;
    const applied = sequenceU64({
      sequenceLo: si.appliedSequenceLo,
      sequenceHi: si.appliedSequenceHi,
    });
    const issued = sequenceU64(publication);
    if (applied < issued) return;
    if (applied > issued) {
      throw new Error("SI skipped the pending navigation controller sequence");
    }
    if (si.pollIndex <= BigInt(publication.priorSiPollIndex)) {
      throw new Error("SI receipt did not advance beyond its pre-publication poll index");
    }
    if (si.scheduledCycle < BigInt(publication.publicationCanonicalCycle)) {
      throw new Error("SI receipt was scheduled before its controller publication");
    }
    if (si.observedCycle > currentCanonicalCycle) {
      throw new Error("SI receipt was observed beyond current canonical time");
    }
    if (si.source !== 0) {
      throw new Error("navigation controller receipt was not a periodic SI publication");
    }
    const publicationCycle = BigInt(publication.publicationCanonicalCycle);
    if (
      si.scheduledCycle - publicationCycle > BigInt(this.policy.navigationPolicy.periodicSiCycles)
      || si.observedCycle - publicationCycle
        > BigInt(this.policy.navigationPolicy.maximumReceiptLatencyCycles)
    ) {
      throw new Error("navigation SI receipt exceeded its locked cycle latency");
    }
    const nextStep = this.policy.navigationPolicy.steps[publication.stepIndex + 1] ?? null;
    if (
      nextStep !== null
      && si.observedCycle > publicationCycle + BigInt(nextStep.minimumCanonicalDelay)
    ) {
      throw new Error("navigation SI receipt arrived after the next locked hold interval");
    }
    if (
      si.buttons !== publication.buttons
      || si.stickXyCxy !== publication.stickXyCxy
      || si.triggerLrab !== publication.triggerLrab
    ) {
      throw new Error("SI receipt semantic state does not match the navigation publication");
    }
    const packet = expectedSiPacket(publication, si.controllerMode);
    if (
      si.packetWord0 !== packet.word0
      || si.packetWord1 !== packet.word1
    ) {
      throw new Error("SI receipt packet does not match the locked navigation controller state");
    }
    const receipt = Object.freeze({
      stepIndex: publication.stepIndex,
      sequenceLo: publication.sequenceLo,
      sequenceHi: publication.sequenceHi,
      minimumCanonicalDelay: publication.minimumCanonicalDelay,
      targetCanonicalCycle: publication.targetCanonicalCycle,
      publicationCanonicalCycle: publication.publicationCanonicalCycle,
      publicationOvershootCycles: publication.publicationOvershootCycles,
      buttons: publication.buttons,
      stickXyCxy: publication.stickXyCxy,
      triggerLrab: publication.triggerLrab,
      status: publication.status,
      priorSiPollIndex: publication.priorSiPollIndex,
      siPollIndex: si.pollIndex.toString(),
      siScheduledCycle: si.scheduledCycle.toString(),
      siObservedCycle: si.observedCycle.toString(),
      siAppliedSequenceLo: si.appliedSequenceLo,
      siAppliedSequenceHi: si.appliedSequenceHi,
      siPacketWord0: si.packetWord0,
      siPacketWord1: si.packetWord1,
      siSource: si.source,
      siControllerMode: si.controllerMode,
      siButtons: si.buttons,
      siStickXyCxy: si.stickXyCxy,
      siTriggerLrab: si.triggerLrab,
    });
    this.pendingNavigationPublication = Object.freeze({ publication, receipt });
  }

  pendingNavigationCheckpoint() {
    const receipt = this.pendingNavigationPublication?.receipt ?? null;
    if (receipt === null) return null;
    return Object.freeze({
      navigationStep: receipt,
      navigation: this.navigationSnapshot(true),
      runSummary: this.summary(
        true,
        this.intermediateAuthority?.scheduler.end ?? this.authorityCurrent,
        this.intermediateAuthority?.reportedHostCalls ?? this.reportedHostCalls,
        this.intermediateAuthority?.reportedColdInstalls ?? this.reportedColdInstalls,
      ),
    });
  }

  observeIntermediateAuthority(value) {
    const issued = this.pending;
    if (issued === null) throw new Error("capture ledger received unissued intermediate authority");
    exactObjectFields(
      value,
      ["scheduler", "si", "hostCalls", "coldInstalls"],
      "intermediate capture authority",
    );
    const scheduler = exactSchedulerInterval(value.scheduler);
    for (const field of SCHEDULER_POINT_FIELDS) {
      if (scheduler.start[field] !== issued.schedulerStart[field]) {
        throw new Error(`intermediate scheduler start ${field} changed`);
      }
    }
    if (
      scheduler.delta.canonicalCycle > issued.cycleUpperCap
      || scheduler.delta.retiredBlocks > BigInt(issued.blockUpperCap)
    ) {
      throw new Error("intermediate scheduler authority exceeded the issued run cap");
    }
    const prior = this.intermediateAuthority?.scheduler.end ?? issued.schedulerStart;
    for (const field of SCHEDULER_POINT_FIELDS) {
      if (scheduler.end[field] < prior[field]) {
        throw new Error(`intermediate scheduler ${field} regressed`);
      }
    }
    const si = exactSiAuthority(value.si);
    const hostCalls = nonnegativeResultInteger(value.hostCalls, "intermediate host calls");
    const coldInstalls = nonnegativeResultInteger(
      value.coldInstalls,
      "intermediate cold installs",
    );
    if (hostCalls > issued.maxHostCalls || coldInstalls > issued.maxColdInstalls) {
      throw new Error("intermediate authority exceeded issued host/cold budgets");
    }
    const priorHostCalls = this.intermediateAuthority?.hostCalls ?? 0;
    const priorColdInstalls = this.intermediateAuthority?.coldInstalls ?? 0;
    if (hostCalls < priorHostCalls || coldInstalls < priorColdInstalls) {
      throw new Error("intermediate host/cold authority regressed");
    }
    const priorSi = this.intermediateAuthority?.si ?? this.siCurrent;
    if (priorSi !== null && (si === null || si.pollIndex < priorSi.pollIndex)) {
      throw new Error("intermediate SI authority regressed");
    }
    if (si !== null && si.observedCycle > scheduler.end.canonicalCycle) {
      throw new Error("intermediate SI authority exceeds canonical scheduler time");
    }
    this.intermediateAuthority = Object.freeze({
      scheduler,
      si,
      hostCalls,
      coldInstalls,
      reportedHostCalls: this.reportedHostCalls + hostCalls,
      reportedColdInstalls: this.reportedColdInstalls + coldInstalls,
    });
    this.#observeNavigationReceipt(si, scheduler.end.canonicalCycle);
    return this.pendingNavigationCheckpoint();
  }

  commitNavigationCheckpoint() {
    const pending = this.pendingNavigationPublication;
    if (pending?.receipt === null || pending === null) {
      throw new Error("navigation checkpoint has no authenticated SI receipt");
    }
    this.navigationTranscript.push(pending.receipt);
    this.operatorPublications += 1;
    this.navigationLastReceiptObservedCanonical = BigInt(
      pending.receipt.siObservedCycle,
    );
    this.pendingNavigationPublication = null;
    return pending.receipt;
  }

  navigationSnapshot(projectReceipt = false) {
    if (!this.navigationArmed) return null;
    const receipt = projectReceipt ? this.pendingNavigationPublication?.receipt ?? null : null;
    const transcript = receipt === null
      ? [...this.navigationTranscript]
      : [...this.navigationTranscript, receipt];
    const durableSteps = transcript.length;
    const lastReceiptObserved = receipt === null
      ? this.navigationLastReceiptObservedCanonical
      : BigInt(receipt.siObservedCycle);
    const next = this.policy.navigationPolicy.steps[durableSteps] ?? null;
    const nextTarget = next === null
      ? null
      : (lastReceiptObserved ?? this.navigationCanonicalOrigin)
        + BigInt(next.minimumCanonicalDelay);
    const pending = projectReceipt || this.pendingNavigationPublication === null
      ? null
      : this.pendingNavigationPublication.publication;
    return Object.freeze({
      schema: "lazuli-resident-navigation-runtime-v2",
      scriptSha256: this.policy.navigationPolicy.scriptSha256,
      stepCount: this.policy.navigationPolicy.steps.length,
      durableSteps,
      complete: durableSteps === this.policy.navigationPolicy.steps.length && pending === null,
      runCallOrigin: this.navigationRunOrigin,
      canonicalCycleOrigin: this.navigationCanonicalOrigin.toString(),
      siPollIndexOrigin: this.navigationSiPollIndexOrigin.toString(),
      lastReceiptObservedCanonicalCycle: lastReceiptObserved?.toString() ?? null,
      nextTargetCanonicalCycle: nextTarget?.toString() ?? null,
      pendingPublication: pending,
      transcript: Object.freeze(transcript),
    });
  }

  recordWitnessPublication() {
    this.assertProgressAvailable();
    if (this.witnessPublications !== 0) {
      throw new Error("capture witness publication was not one-shot");
    }
    this.witnessPublications = 1;
    return this.summary();
  }

  accept(result) {
    const issued = this.pending;
    if (issued === null) throw new Error("capture ledger received an unissued run result");
    this.pending = null;
    if (result === null || typeof result !== "object") {
      throw new Error("capture ledger received an invalid run result");
    }
    const scheduler = exactSchedulerInterval(result.scheduler);
    for (const field of SCHEDULER_POINT_FIELDS) {
      if (scheduler.start[field] !== issued.schedulerStart[field]) {
        throw new Error(`resident scheduler start ${field} changed between serialized runs`);
      }
    }
    if (
      scheduler.delta.canonicalCycle > issued.cycleUpperCap
      || scheduler.delta.retiredBlocks > BigInt(issued.blockUpperCap)
    ) {
      throw new Error("resident run exceeded its issued canonical scheduler budget");
    }
    const si = exactSiAuthority(result.si);
    if (si !== null && si.observedCycle > scheduler.end.canonicalCycle) {
      throw new Error("SI publication authority exceeds the scheduler boundary");
    }
    if (this.siCurrent !== null) {
      if (si === null || si.pollIndex < this.siCurrent.pollIndex) {
        throw new Error("SI publication authority regressed between serialized runs");
      }
    }
    if (this.intermediateAuthority !== null) {
      for (const field of SCHEDULER_POINT_FIELDS) {
        if (scheduler.end[field] < this.intermediateAuthority.scheduler.end[field]) {
          throw new Error(`final scheduler ${field} regressed from intermediate authority`);
        }
      }
      const intermediateSi = this.intermediateAuthority.si;
      if (intermediateSi !== null && (si === null || si.pollIndex < intermediateSi.pollIndex)) {
        throw new Error("final SI authority regressed from intermediate authority");
      }
    }
    const hostCalls = nonnegativeResultInteger(result.hostCalls, "reported host calls");
    const coldInstalls = nonnegativeResultInteger(result.coldInstalls, "reported cold installs");
    if (hostCalls > issued.maxHostCalls || coldInstalls > issued.maxColdInstalls) {
      throw new Error("resident run exceeded its issued host/cold budget");
    }
    if (
      this.intermediateAuthority !== null
      && (
        hostCalls < this.intermediateAuthority.hostCalls
        || coldInstalls < this.intermediateAuthority.coldInstalls
      )
    ) {
      throw new Error("final host/cold authority regressed from an intermediate boundary");
    }
    this.reportedHostCalls += hostCalls;
    this.reportedColdInstalls += coldInstalls;

    if (result.boundary === "rust") {
      const { reason, detail } = exactRustOutcomeIdentity(result.outcome);
      if (reason !== 0) {
        throw new Error(
          `capture Rust resident run stopped with reason ${reason}, detail ${detail}`,
        );
      }
      const canonicalRemaining = (
        this.policy.canonicalCycleUpperCap - this.reportedCanonicalCycles
      );
      if (
        issued.cycleUpperCap === canonicalRemaining
        && detail === 1
        && scheduler.delta.canonicalCycle < issued.cycleUpperCap
      ) {
        throw new Error(
          "capture cumulative canonical-cycle cap cannot retire the next block",
        );
      }
    } else if (result.boundary === "adapter-cap") {
      if (result.cap === "cycle") {
        if (scheduler.delta.canonicalCycle !== issued.cycleUpperCap) {
          throw new Error("adapter cycle-cap boundary did not consume the exact issued cap");
        }
      } else if (result.cap === "block") {
        if (scheduler.delta.retiredBlocks !== BigInt(issued.blockUpperCap)) {
          throw new Error("adapter block-cap boundary did not consume the exact issued cap");
        }
      } else {
        throw new Error("adapter-cap boundary named an unknown cap");
      }
    } else if (result.boundary === "fidelity") {
      if (result.phase !== 5) {
        throw new Error("capture ledger received a non-Accepted fidelity boundary");
      }
      this.accepted = true;
    } else if (result.boundary === "host-call-cap" || result.boundary === "cold-install-cap") {
      throw new Error(`capture run exhausted its ${result.boundary}`);
    } else {
      throw new Error(`capture ledger received unknown boundary ${String(result.boundary)}`);
    }

    this.authorityCurrent = scheduler.end;
    this.siCurrent = si;
    this.intermediateAuthority = null;
    this.reportedCanonicalCycles = (
      scheduler.end.canonicalCycle - this.authorityOrigin.canonicalCycle
    );
    this.reportedExecutedCycles = (
      scheduler.end.executedCycles - this.authorityOrigin.executedCycles
    );
    this.reportedExecutedInstructions = (
      scheduler.end.executedInstructions - this.authorityOrigin.executedInstructions
    );
    this.reportedRetiredBlocks = (
      scheduler.end.retiredBlocks - this.authorityOrigin.retiredBlocks
    );
    this.#observeNavigationReceipt(si);
    if (
      scheduler.delta.canonicalCycle === 0n
      && scheduler.delta.executedCycles === 0n
      && scheduler.delta.executedInstructions === 0n
      && scheduler.delta.retiredBlocks === 0n
      && hostCalls === 0
      && coldInstalls === 0
    ) {
      this.zeroProgressSlices += 1;
      this.consecutiveZeroProgressSlices += 1;
      this.maximumConsecutiveZeroProgressSlices = Math.max(
        this.maximumConsecutiveZeroProgressSlices,
        this.consecutiveZeroProgressSlices,
      );
    } else {
      this.consecutiveZeroProgressSlices = 0;
    }

    this.#observeWall();
    if (this.elapsedWallMs >= this.wallTimeoutMs) {
      throw new Error("capture cumulative wall-time cap exhausted");
    }
    if (this.reportedCanonicalCycles > this.policy.canonicalCycleUpperCap) {
      throw new Error("capture cumulative canonical-cycle cap overshot");
    }
    if (this.reportedExecutedCycles > this.policy.executedCycleUpperCap) {
      throw new Error("capture cumulative executed-cycle cap overshot");
    }
    if (this.reportedExecutedInstructions > this.policy.instructionUpperCap) {
      throw new Error("capture cumulative instruction cap overshot");
    }
    if (this.reportedHostCalls > this.policy.totalHostCallCap) {
      throw new Error("capture cumulative host-call cap overshot");
    }
    if (this.reportedColdInstalls > this.policy.totalColdInstallCap) {
      throw new Error("capture cumulative cold-install cap overshot");
    }
    if (!this.accepted) this.assertProgressAvailable();
    return this.summary();
  }

  summary(
    projectReceipt = false,
    authority = this.authorityCurrent,
    reportedHostCalls = this.reportedHostCalls,
    reportedColdInstalls = this.reportedColdInstalls,
  ) {
    if (this.startedAtMs === null) {
      throw new Error("capture ledger was not started at resident-ready");
    }
    const projectedPublication = projectReceipt ? 1 : 0;
    const canonicalCycles = authority.canonicalCycle - this.authorityOrigin.canonicalCycle;
    const executedCycles = authority.executedCycles - this.authorityOrigin.executedCycles;
    const executedInstructions = (
      authority.executedInstructions - this.authorityOrigin.executedInstructions
    );
    const retiredBlocks = authority.retiredBlocks - this.authorityOrigin.retiredBlocks;
    return Object.freeze({
      schema: "lazuli-resident-cumulative-run-summary-v2",
      issuedRunCalls: this.issuedRunCalls,
      canonicalCycle: authority.canonicalCycle.toString(),
      reportedCanonicalCycles: canonicalCycles.toString(),
      reportedExecutedCycles: executedCycles.toString(),
      reportedExecutedInstructions: executedInstructions.toString(),
      reportedRetiredBlocks: retiredBlocks.toString(),
      reportedHostCalls,
      reportedColdInstalls,
      zeroProgressSlices: this.zeroProgressSlices,
      consecutiveZeroProgressSlices: this.consecutiveZeroProgressSlices,
      maximumConsecutiveZeroProgressSlices: this.maximumConsecutiveZeroProgressSlices,
      operatorPublications: this.operatorPublications + projectedPublication,
      witnessPublications: this.witnessPublications,
      elapsedWallMs: this.elapsedWallMs,
      wallTimeoutMs: this.wallTimeoutMs,
      accepted: this.accepted,
    });
  }
}

/**
 * Installs the standalone resident-machine worker protocol on a WorkerGlobalScope.
 *
 * Render messages are intentionally relayed to the page because the current WebGPU renderer is
 * bound to an HtmlCanvasElement. The page should pass the four fields directly to
 * `WebGpuRenderer.submit_resident_render` and return its Uint8Array without inspecting it.
 */
export function installResidentMachineWorker(scope, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("resident worker options must be an object");
  }
  const optionKeys = Reflect.ownKeys(options);
  if (optionKeys.some(key => key !== "adapterFactory")) {
    throw new Error("resident worker options contain an unsupported field");
  }
  const adapterFactory = Object.hasOwn(options, "adapterFactory")
    ? options.adapterFactory
    : ResidentMachineAdapter.create;
  if (typeof adapterFactory !== "function") {
    throw new Error("resident worker adapterFactory must be a function");
  }
  const renderer = new MainThreadRendererRelay(scope);
  let adapter = null;
  let commandTail = Promise.resolve();
  let controllerSequence = 0n;
  let initializedOnce = false;
  let closedForever = false;
  let machineSessionId = null;
  let captureRunLedger = null;

  function nextControllerSequence() {
    if (controllerSequence === 0xffff_ffff_ffff_ffffn) {
      throw new Error("resident controller sequence exhausted");
    }
    controllerSequence += 1n;
    return {
      sequenceLo: Number(controllerSequence & 0xffff_ffffn),
      sequenceHi: Number(controllerSequence >> 32n),
    };
  }

  async function execute(message) {
    const requestId = message.requestId ?? null;
    if (closedForever) {
      if (message.type === "resident-close") {
        scope.postMessage({ type: "resident-closed", requestId });
        return;
      }
      throw new Error("resident worker lifetime is closed");
    }
    if (adapter) renderer.assertFidelityPollSatisfied(message.type);
    switch (message.type) {
      case "resident-init": {
        if (initializedOnce) throw new Error("resident worker initialization is one-shot");
        initializedOnce = true;
        const captureFidelity = message.captureFidelity ?? false;
        if (Object.hasOwn(message, "machineSessionId")) {
          throw new Error("resident-init cannot supply a machineSessionId");
        }
        renderer.configureFidelityCapture(captureFidelity);
        if (captureFidelity) {
          const uuidAuthority = scope.crypto ?? globalThis.crypto;
          if (typeof uuidAuthority?.randomUUID !== "function") {
            throw new Error("capture Worker has no cryptographic UUID authority");
          }
          machineSessionId = uuidAuthority.randomUUID();
          captureRunLedger = new ResidentCaptureRunLedger(
            message.runPolicy,
            () => Number((scope.performance ?? globalThis.performance).now()),
          );
          const digestAuthority = typeof scope.crypto?.subtle?.digest === "function"
            ? scope.crypto
            : globalThis.crypto;
          await verifyCaptureNavigationScript(
            captureRunLedger.policy.navigationPolicy,
            digestAuthority,
          );
          const executingWorker = new URL(scope.location.href);
          const policyWorker = new URL(captureRunLedger.policy.workerUrl, executingWorker);
          if (
            policyWorker.origin !== executingWorker.origin
            || policyWorker.search !== ""
            || policyWorker.hash !== ""
            || policyWorker.href !== executingWorker.href
          ) {
            throw new Error("capture runPolicy workerUrl does not identify this executing Worker");
          }
          if (
            message.maxBootReads !== undefined
            && message.maxBootReads !== captureRunLedger.policy.maxBootReads
          ) {
            throw new Error("resident-init maxBootReads changed the frozen runPolicy");
          }
        }
        const rawContainer = await rawContainerFrom(scope, message.disc);
        adapter = await adapterFactory({
          artifacts: {
            core: artifactUrl(scope, message.artifacts?.core, "core artifact"),
            dispatcher: artifactUrl(scope, message.artifacts?.dispatcher, "dispatcher artifact"),
            coordinator: artifactUrl(scope, message.artifacts?.coordinator, "coordinator artifact"),
          },
          rawContainer,
          renderer,
          iplBytes: message.iplBytes,
          captureFidelity,
        });
        const boot = await adapter.boot({
          maxReads: captureRunLedger?.policy.maxBootReads ?? message.maxBootReads,
        });
        const fidelityState = captureFidelity ? adapter.gameFidelityState() : null;
        const diagnostics = adapter.diagnostics();
        const readyDiagnostics = captureFidelity
          ? Object.freeze({
              ...diagnostics,
              machineEvidence: fidelityState.machineEvidence,
            })
          : diagnostics;
        const readyRunSummary = captureFidelity
          ? captureRunLedger.startAtReady(adapter.captureAuthority())
          : null;
        scope.postMessage({
          type: "resident-ready",
          requestId,
          boot,
          diagnostics: readyDiagnostics,
          ...(captureFidelity ? {
            machineSessionId,
            fidelityState,
            runSummary: readyRunSummary,
            navigation: captureRunLedger.navigationSnapshot(),
          } : {}),
        });
        break;
      }
      case "resident-run": {
        if (!adapter) throw new Error("resident worker is not initialized");
        renderer.assertMachineProgressAvailable();
        const issued = captureRunLedger?.issue(message) ?? null;
        const result = await adapter.runSlice({
          cycleUpperCap: issued?.cycleUpperCap ?? (message.cycleUpperCap === undefined
            ? undefined
            : BigInt(message.cycleUpperCap)),
          blockUpperCap: issued?.blockUpperCap ?? message.blockUpperCap,
          maxHostCalls: issued?.maxHostCalls ?? message.maxHostCalls,
          maxColdInstalls: issued?.maxColdInstalls ?? message.maxColdInstalls,
          ...(captureRunLedger === null ? {} : {
            onAuthority: async authority => {
              const checkpoint = captureRunLedger.observeIntermediateAuthority(authority);
              if (checkpoint !== null) {
                await renderer.awaitNavigationCheckpoint(requestId, {
                  machineSessionId,
                  ...checkpoint,
                });
                captureRunLedger.commitNavigationCheckpoint();
              }
            },
          }),
        });
        let runSummary = captureRunLedger?.accept(result) ?? null;
        if (captureRunLedger !== null) {
          const checkpoint = captureRunLedger.pendingNavigationCheckpoint();
          if (checkpoint !== null) {
            await renderer.awaitNavigationCheckpoint(requestId, {
              machineSessionId,
              ...checkpoint,
            });
            captureRunLedger.commitNavigationCheckpoint();
            runSummary = captureRunLedger.summary();
          }
        }
        if (result.boundary !== "fidelity") renderer.requireFidelityPoll();
        scope.postMessage({
          type: "resident-run-result",
          requestId,
          result: serializableRunResult(result),
          diagnostics: adapter.diagnostics(),
          ...(runSummary === null ? {} : {
            machineSessionId,
            runSummary,
            navigation: captureRunLedger.navigationSnapshot(),
          }),
        });
        break;
      }
      case "resident-input": {
        if (!adapter) throw new Error("resident worker is not initialized");
        renderer.assertMachineProgressAvailable();
        if (renderer.captureFidelity) {
          throw new Error("fidelity capture requires atomic resident controller commands");
        }
        const status = adapter.publishController(
          message.sequenceLo,
          message.sequenceHi,
          message.buttons,
          message.stickXyCxy,
          message.triggerLrab,
        );
        renderer.requireFidelityPoll();
        scope.postMessage({ type: "resident-input-result", requestId, status });
        break;
      }
      case "resident-controller-navigation-arm": {
        if (!adapter) throw new Error("resident worker is not initialized");
        renderer.assertMachineProgressAvailable();
        if (!renderer.captureFidelity) {
          throw new Error("navigation arm requires fidelity capture");
        }
        const messageKeys = Object.keys(message).sort();
        if (JSON.stringify(messageKeys) !== JSON.stringify(["requestId", "type"])) {
          throw new Error("navigation arm cannot supply policy or controller state");
        }
        const state = adapter.gameFidelityState();
        const script = captureRunLedger.policy.navigationPolicy;
        const navigation = captureRunLedger.armNavigation(state.phase);
        const result = {
          machineSessionId,
          runCallOrigin: navigation.runCallOrigin,
          canonicalCycleOrigin: navigation.canonicalCycleOrigin,
          scriptSha256: script.scriptSha256,
          stepCount: script.steps.length,
          navigation,
          runSummary: captureRunLedger.summary(),
        };
        await renderer.awaitNavigationArmCheckpoint(requestId, result);
        scope.postMessage({
          type: "resident-controller-navigation-arm-result",
          requestId,
          ...result,
        });
        break;
      }
      case "resident-controller-navigation": {
        if (!adapter) throw new Error("resident worker is not initialized");
        renderer.assertMachineProgressAvailable();
        if (!renderer.captureFidelity) {
          throw new Error("navigation controller command requires fidelity capture");
        }
        captureRunLedger.assertProgressAvailable();
        if (!captureRunLedger.navigationArmed) {
          throw new Error("capture navigation policy was not armed");
        }
        const state = adapter.gameFidelityState();
        if (state.phase !== 0) {
          throw new Error("navigation controller input is allowed only before Baseline");
        }
        const messageKeys = Object.keys(message).sort();
        if (JSON.stringify(messageKeys) !== JSON.stringify(["requestId", "type"])) {
          throw new Error("navigation controller command cannot supply controller state");
        }
        const controller = captureRunLedger.nextNavigationStep();
        if (controller === null) {
          throw new Error("capture navigation script has no remaining publication");
        }
        if (!captureRunLedger.navigationPublicationDue()) {
          throw new Error("navigation controller command arrived before its canonical target");
        }
        const sequence = nextControllerSequence();
        const status = adapter.publishController(
          sequence.sequenceLo,
          sequence.sequenceHi,
          controller.buttons,
          controller.stickXyCxy,
          controller.triggerLrab,
        );
        if (status !== 1) {
          throw new Error("locked navigation controller publication was not exactly Queued");
        }
        const navigationStep = captureRunLedger.recordNavigationPublication(sequence, status);
        const runSummary = captureRunLedger.summary();
        const navigation = captureRunLedger.navigationSnapshot();
        renderer.requireFidelityPoll();
        const result = {
          machineSessionId,
          navigationStep,
          navigation,
          runSummary,
        };
        scope.postMessage({
          type: "resident-controller-navigation-result",
          requestId,
          ...result,
        });
        break;
      }
      case "resident-controller-witness": {
        if (!adapter) throw new Error("resident worker is not initialized");
        renderer.assertMachineProgressAvailable();
        if (!renderer.captureFidelity) {
          throw new Error("controller witness command requires fidelity capture");
        }
        captureRunLedger.assertProgressAvailable();
        if (captureRunLedger.witnessPublications !== 0) {
          throw new Error("controller witness was already published");
        }
        captureRunLedger.assertNavigationComplete();
        const state = adapter.gameFidelityState();
        if (state.phase !== 1 || state.requestedController === null) {
          throw new Error("controller witness requires exact Rust Baseline state");
        }
        const sequence = nextControllerSequence();
        const requested = state.requestedController;
        const status = adapter.publishController(
          sequence.sequenceLo,
          sequence.sequenceHi,
          requested.buttons,
          requested.stickXyCxy,
          requested.triggerLrab,
        );
        if (status === 0) {
          throw new Error("Rust did not accept the exact controller witness publication");
        }
        captureRunLedger.recordWitnessPublication();
        renderer.requireFidelityPoll();
        const result = {
          ...sequence,
          buttons: requested.buttons,
          stickXyCxy: requested.stickXyCxy,
          triggerLrab: requested.triggerLrab,
          status,
          state,
          machineSessionId,
          runSummary: captureRunLedger.summary(),
          navigation: captureRunLedger.navigationSnapshot(),
        };
        await renderer.awaitWitnessCheckpoint(requestId, result);
        scope.postMessage({
          type: "resident-controller-witness-result",
          requestId,
          ...result,
        });
        break;
      }
      case "resident-diagnostics": {
        if (!adapter) throw new Error("resident worker is not initialized");
        scope.postMessage({
          type: "resident-diagnostics-result",
          requestId,
          diagnostics: adapter.diagnostics(),
        });
        break;
      }
      case "resident-fidelity-state": {
        if (!adapter) throw new Error("resident worker is not initialized");
        const state = adapter.gameFidelityState();
        scope.postMessage({
          type: "resident-fidelity-state-result",
          requestId,
          state,
          ...(captureRunLedger === null ? {} : {
            machineSessionId,
            runSummary: captureRunLedger.summary(),
            navigation: captureRunLedger.navigationSnapshot(),
          }),
        });
        renderer.completeFidelityPoll(state);
        break;
      }
      case "resident-close": {
        closedForever = true;
        if (adapter) adapter.close();
        adapter = null;
        renderer.close();
        scope.postMessage({ type: "resident-closed", requestId });
        break;
      }
      default:
        throw new Error(`unsupported resident worker message ${String(message.type)}`);
    }
  }

  scope.addEventListener("message", event => {
    const message = event.data ?? {};
    if (message.type === "resident-render-receipt" ||
        message.type === "resident-render-error") {
      if (!renderer.settle(message)) {
        scope.postMessage({
          type: "resident-error",
          requestId: message.requestId ?? null,
          error: `unknown renderer relay request ${String(message.id)}`,
        });
      }
      return;
    }
    if (message.type === "resident-fidelity-observation-ack" ||
        message.type === "resident-fidelity-observation-error") {
      if (!renderer.settleObservation(message)) {
        scope.postMessage({
          type: "resident-error",
          requestId: message.requestId ?? null,
          error: `unknown fidelity observation ${String(message.id)}`,
        });
      }
      return;
    }
    if (message.type === "resident-controller-navigation-checkpoint-ack" ||
        message.type === "resident-controller-navigation-checkpoint-error") {
      if (!renderer.settleNavigationCheckpoint(message)) {
        scope.postMessage({
          type: "resident-error",
          requestId: message.requestId ?? null,
          error: `unknown navigation checkpoint ${String(message.requestId)}`,
        });
      }
      return;
    }
    if (message.type === "resident-controller-navigation-arm-checkpoint-ack" ||
        message.type === "resident-controller-navigation-arm-checkpoint-error") {
      if (!renderer.settleNavigationArmCheckpoint(message)) {
        scope.postMessage({
          type: "resident-error",
          requestId: message.requestId ?? null,
          error: `unknown navigation arm checkpoint ${String(message.requestId)}`,
        });
      }
      return;
    }
    if (message.type === "resident-controller-witness-checkpoint-ack" ||
        message.type === "resident-controller-witness-checkpoint-error") {
      if (!renderer.settleWitnessCheckpoint(message)) {
        scope.postMessage({
          type: "resident-error",
          requestId: message.requestId ?? null,
          error: `unknown controller witness checkpoint ${String(message.requestId)}`,
        });
      }
      return;
    }
    if (message.type === "resident-close") {
      // Reject a renderer promise immediately so a queued close cannot sit forever behind the
      // run that is awaiting it. The serialized close command performs final adapter teardown.
      renderer.close();
    }

    commandTail = commandTail.then(
      () => execute(message),
      () => execute(message),
    ).catch(error => {
      renderer.latchCaptureFault(error);
      scope.postMessage({
        type: "resident-error",
        requestId: message.requestId ?? null,
        error: String(error?.stack ?? error),
      });
    });
  });
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  installResidentMachineWorker(globalThis);
}
