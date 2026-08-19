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
]);
const CAPTURE_OPERATOR_PUBLICATION_CAP = 65;
const CAPTURE_OPERATOR_NEUTRAL = Object.freeze({
  buttons: 0,
  stickXyCxy: 0x8080_8080,
  triggerLrab: 0,
});
const CAPTURE_OPERATOR_A = Object.freeze({
  buttons: 0x0100,
  stickXyCxy: 0x8080_8080,
  triggerLrab: 0x00ff_0000,
});

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
  });
  if (policy.sliceCycleUpperCap > policy.executedCycleUpperCap) {
    throw new Error("capture runPolicy slice cycle cap exceeds its total cycle cap");
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
    this.reportedExecutedCycles = 0n;
    this.reportedExecutedInstructions = 0n;
    this.reportedHostCalls = 0;
    this.reportedColdInstalls = 0;
    this.zeroProgressSlices = 0;
    this.consecutiveZeroProgressSlices = 0;
    this.maximumConsecutiveZeroProgressSlices = 0;
    this.operatorPublications = 0;
    this.witnessPublications = 0;
    this.elapsedWallMs = 0;
    this.accepted = false;
    this.pending = null;
  }

  startAtReady() {
    if (this.startedAtMs !== null) {
      throw new Error("capture ledger resident-ready start was not one-shot");
    }
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
    const remainingCycles = this.policy.executedCycleUpperCap - this.reportedExecutedCycles;
    const maximumCycles = remainingCycles < this.policy.sliceCycleUpperCap
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
    this.pending = Object.freeze({
      cycleUpperCap: requestedCycles,
      blockUpperCap: requestedBlocks,
      maxHostCalls: requestedHostCalls,
      maxColdInstalls: requestedColdInstalls,
    });
    return this.pending;
  }

  recordOperatorPublication() {
    this.assertProgressAvailable();
    this.assertOperatorPublicationAvailable();
    this.operatorPublications += 1;
    return this.summary();
  }

  assertOperatorPublicationAvailable() {
    if (this.operatorPublications >= CAPTURE_OPERATOR_PUBLICATION_CAP) {
      throw new Error("capture operator publication cap exhausted");
    }
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
    const remainingIssuedCycleAuthority = (
      this.policy.executedCycleUpperCap - this.reportedExecutedCycles
    );
    const issuedFullTruncatedCycleTail = (
      remainingIssuedCycleAuthority < this.policy.sliceCycleUpperCap
      && issued.cycleUpperCap === remainingIssuedCycleAuthority
    );
    this.pending = null;
    if (result === null || typeof result !== "object") {
      throw new Error("capture ledger received an invalid run result");
    }
    const hostCalls = nonnegativeResultInteger(result.hostCalls, "reported host calls");
    const coldInstalls = nonnegativeResultInteger(result.coldInstalls, "reported cold installs");
    if (hostCalls > issued.maxHostCalls || coldInstalls > issued.maxColdInstalls) {
      throw new Error("resident run exceeded its issued host/cold budget");
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
      const cycles = nonnegativeResultBigInt(
        result.outcome?.executedCycles,
        "reported executed cycles",
      );
      const instructions = nonnegativeResultBigInt(
        result.outcome?.executedInstructions,
        "reported executed instructions",
      );
      if (cycles > issued.cycleUpperCap) {
        throw new Error("resident run exceeded its issued cycle budget");
      }
      this.reportedExecutedCycles += cycles;
      this.reportedExecutedInstructions += instructions;
      if (issuedFullTruncatedCycleTail && detail === 1) {
        this.assertProgressAvailable();
        throw new Error(
          "capture cumulative executed-cycle cap cannot retire the next block",
        );
      }
      if (
        cycles === 0n
        && instructions === 0n
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

    this.#observeWall();
    if (this.elapsedWallMs >= this.wallTimeoutMs) {
      throw new Error("capture cumulative wall-time cap exhausted");
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

  summary() {
    if (this.startedAtMs === null) {
      throw new Error("capture ledger was not started at resident-ready");
    }
    return Object.freeze({
      schema: "lazuli-resident-cumulative-run-summary-v1",
      issuedRunCalls: this.issuedRunCalls,
      reportedExecutedCycles: this.reportedExecutedCycles.toString(),
      reportedExecutedInstructions: this.reportedExecutedInstructions.toString(),
      reportedHostCalls: this.reportedHostCalls,
      reportedColdInstalls: this.reportedColdInstalls,
      zeroProgressSlices: this.zeroProgressSlices,
      consecutiveZeroProgressSlices: this.consecutiveZeroProgressSlices,
      maximumConsecutiveZeroProgressSlices: this.maximumConsecutiveZeroProgressSlices,
      operatorPublications: this.operatorPublications,
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
  let witnessPublished = false;
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
          const cryptoAuthority = scope.crypto ?? globalThis.crypto;
          if (typeof cryptoAuthority?.randomUUID !== "function") {
            throw new Error("capture Worker has no cryptographic UUID authority");
          }
          machineSessionId = cryptoAuthority.randomUUID();
          captureRunLedger = new ResidentCaptureRunLedger(
            message.runPolicy,
            () => Number((scope.performance ?? globalThis.performance).now()),
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
        const readyRunSummary = captureFidelity ? captureRunLedger.startAtReady() : null;
        scope.postMessage({
          type: "resident-ready",
          requestId,
          boot,
          diagnostics: readyDiagnostics,
          ...(captureFidelity ? {
            machineSessionId,
            fidelityState,
            runSummary: readyRunSummary,
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
        });
        const runSummary = captureRunLedger?.accept(result) ?? null;
        if (result.boundary !== "fidelity") renderer.requireFidelityPoll();
        scope.postMessage({
          type: "resident-run-result",
          requestId,
          result: serializableRunResult(result),
          diagnostics: adapter.diagnostics(),
          ...(runSummary === null ? {} : { machineSessionId, runSummary }),
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
      case "resident-controller-operator": {
        if (!adapter) throw new Error("resident worker is not initialized");
        renderer.assertMachineProgressAvailable();
        if (!renderer.captureFidelity) {
          throw new Error("operator controller command requires fidelity capture");
        }
        captureRunLedger.assertProgressAvailable();
        const state = adapter.gameFidelityState();
        if (state.phase !== 0) {
          throw new Error("operator controller input is allowed only before Baseline");
        }
        const messageKeys = Object.keys(message).sort();
        if (JSON.stringify(messageKeys) !== JSON.stringify(["requestId", "type"])) {
          throw new Error("operator controller command cannot supply controller state");
        }
        captureRunLedger.assertOperatorPublicationAvailable();
        const controller = captureRunLedger.operatorPublications % 2 === 0
          ? CAPTURE_OPERATOR_NEUTRAL
          : CAPTURE_OPERATOR_A;
        const sequence = nextControllerSequence();
        const status = adapter.publishController(
          sequence.sequenceLo,
          sequence.sequenceHi,
          controller.buttons,
          controller.stickXyCxy,
          controller.triggerLrab,
        );
        if (status === 0) {
          throw new Error("generic operator controller publication was backpressured");
        }
        const runSummary = captureRunLedger.recordOperatorPublication();
        renderer.requireFidelityPoll();
        scope.postMessage({
          type: "resident-controller-operator-result",
          requestId,
          ...sequence,
          ...controller,
          status,
          machineSessionId,
          runSummary,
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
        if (witnessPublished) throw new Error("controller witness was already published");
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
        witnessPublished = true;
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
