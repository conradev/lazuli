// SPDX-License-Identifier: GPL-3.0-only

import initBrowserRenderer, { WebGpuRenderer } from "/browser_renderer.js";

const residentReleaseRuntime = __LAZULI_RESIDENT_RELEASE_RUNTIME__;

// Keep this literal in sync with the generic-release build contract. The resident release is
// intentionally disc-agnostic; local files are handed to the Worker as opaque Blobs.
const defaultDiscSourceConfig = false
      ? {
          kind: "logical-range-endpoint",
          logicalSize: 0,
          url: new URL("/disc", location.href).href,
        }
      : false
        ? { kind: "boot-assets" }
        : null;

const POLICY = Object.freeze({
  maxBootReads: 8_192,
  cycleUpperCap: "1000000",
  blockUpperCap: 16_384,
  maxHostCalls: 64,
  maxColdInstalls: 64,
  zeroProgressSliceCap: 4_096,
  bootTimeoutMs: 180_000,
  sliceTimeoutMs: 180_000,
  closeTimeoutMs: 30_000,
  renderTimeoutMs: 180_000,
});

const EXPECTED_RUNTIME_ABI = Object.freeze({
  coreVersion: 1,
  compileRequestBytes: 84,
  hostRequestBytes: 52,
  runOutcomeBytes: 40,
  machineEvidenceBytes: 816,
  gameFidelityBytes: 384,
  memoryInitialPages: 720,
  memoryMaximumPages: 2_048,
});

const RUN_REASON_BUDGET_EXHAUSTED = 0;
const RUN_REASON_COMPILE_REQUIRED = 1;
const RUN_REASON_HOST_REQUEST = 2;
const RUN_REASON_HALTED = 3;
const RUN_REASON_BREAKPOINT = 4;
const RUN_REASON_FAULT = 5;
const RUN_REASON_INVALID_STATE = 6;
const INPUT_REJECTED = 0;
const INPUT_QUEUED = 1;
const INPUT_COALESCED = 2;
const INPUT_EQUIVALENT = 3;
const CONTROLLER_BUTTON_MASK = 0x0000_1f7f;
const LOCAL_IPL_IMAGE_BYTES = 2 * 1024 * 1024;
const CONTROLLER_MINIMUM_PRESS_MS = 250;
const CONTROLLER_MAXIMUM_PULSE_MS = 2_000;

function invariant(condition, message) {
  if (!condition) throw new Error(`resident frontend: ${message}`);
}

function exactObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const observed = Object.keys(exactObject(value, label)).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(observed) === JSON.stringify(wanted), `${label} shape changed`);
}

function validateAsset(asset, label, extension) {
  exactKeys(asset, ["url", "sha256", "bytes"], label);
  invariant(typeof asset.url === "string" && asset.url.startsWith("/assets/"),
    `${label} URL is invalid`);
  invariant(typeof asset.sha256 === "string" && /^[0-9a-f]{64}$/.test(asset.sha256),
    `${label} digest is invalid`);
  invariant(asset.url.includes(`-${asset.sha256}.`) && asset.url.endsWith(extension),
    `${label} URL is not content-addressed`);
  invariant(Number.isSafeInteger(asset.bytes) && asset.bytes > 0, `${label} size is invalid`);
}

function validateRuntime(runtime) {
  exactKeys(runtime, [
    "choice",
    "abi",
    "core",
    "dispatcher",
    "coordinator",
    "adapter",
    "worker",
  ], "resident runtime");
  invariant(runtime.choice === "rust-resident-v1", "runtime choice changed");
  exactKeys(runtime.abi, Object.keys(EXPECTED_RUNTIME_ABI), "resident runtime ABI");
  for (const [name, expected] of Object.entries(EXPECTED_RUNTIME_ABI)) {
    invariant(runtime.abi[name] === expected, `resident runtime ABI ${name} changed`);
  }
  for (const [name, extension] of [
    ["core", ".wasm"],
    ["dispatcher", ".wasm"],
    ["coordinator", ".wasm"],
    ["adapter", ".mjs"],
    ["worker", ".mjs"],
  ]) {
    validateAsset(runtime[name], `resident runtime ${name}`, extension);
  }
  return runtime;
}

function ownedBytes(value, label) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError(`${label} must be bytes`);
}

function checkedU32(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff,
    `${label} must be a u32`);
  return value >>> 0;
}

function checkedPositiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be positive`);
  return value;
}

function checkedDecimal(value, label) {
  invariant(typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value),
    `${label} must be an unsigned decimal string`);
  return BigInt(value);
}

function checkedCounter(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a safe counter`);
  return value;
}

function validateDiagnostics(value) {
  exactKeys(value, [
    "booted",
    "memoryPages",
    "totalBootReads",
    "totalDiReads",
    "totalRenderCalls",
    "totalColdInstalls",
    "pendingControllerSample",
    "totalControllerRetries",
    "tableSlots",
    "machineEvidence",
  ], "resident diagnostics");
  invariant(typeof value.booted === "boolean", "resident booted gauge is invalid");
  invariant(Number.isSafeInteger(value.memoryPages)
    && value.memoryPages >= EXPECTED_RUNTIME_ABI.memoryInitialPages
    && value.memoryPages <= EXPECTED_RUNTIME_ABI.memoryMaximumPages,
  "resident memory page gauge is invalid");
  for (const name of [
    "totalBootReads",
    "totalDiReads",
    "totalRenderCalls",
    "totalColdInstalls",
    "totalControllerRetries",
  ]) {
    checkedCounter(value[name], `resident ${name}`);
  }
  invariant(typeof value.pendingControllerSample === "boolean",
    "resident pending controller gauge is invalid");
  invariant(Number.isSafeInteger(value.tableSlots) && value.tableSlots > 0,
    "resident dispatch table gauge is invalid");
  exactKeys(value.machineEvidence, ["available", "bytes", "encoding", "payload"],
    "opaque machine evidence");
  invariant(typeof value.machineEvidence.available === "boolean",
    "opaque machine evidence availability is invalid");
  invariant(value.machineEvidence.bytes === EXPECTED_RUNTIME_ABI.machineEvidenceBytes,
    "opaque machine evidence byte length changed");
  invariant(value.machineEvidence.encoding === "base64",
    "opaque machine evidence encoding changed");
  if (value.machineEvidence.available) {
    invariant(typeof value.machineEvidence.payload === "string"
      && value.machineEvidence.payload.length
        === Math.ceil(EXPECTED_RUNTIME_ABI.machineEvidenceBytes / 3) * 4
      && /^(?:[A-Za-z0-9+/]{4})*$/.test(value.machineEvidence.payload),
    "opaque machine evidence payload is invalid");
  } else {
    invariant(value.machineEvidence.payload === null,
      "unavailable machine evidence carried a payload");
  }
  return value;
}

function packByteLanes(first, second, third, fourth) {
  return (
    checkedU32(first, "controller byte lane")
    | (checkedU32(second, "controller byte lane") << 8)
    | (checkedU32(third, "controller byte lane") << 16)
    | (checkedU32(fourth, "controller byte lane") << 24)
  ) >>> 0;
}

function sameControllerState(left, right) {
  return left !== null && right !== null
    && left.buttons === right.buttons
    && left.stickX === right.stickX
    && left.stickY === right.stickY
    && left.cStickX === right.cStickX
    && left.cStickY === right.cStickY
    && left.triggerL === right.triggerL
    && left.triggerR === right.triggerR
    && left.analogA === right.analogA
    && left.analogB === right.analogB;
}

function normalizeControllerState(state) {
  exactObject(state, "controller state");
  const byte = (name) => {
    const value = checkedU32(state[name], `controller ${name}`);
    invariant(value <= 0xff, `controller ${name} exceeds one byte`);
    return value;
  };
  const buttons = checkedU32(state.buttons, "controller buttons");
  invariant((buttons & ~CONTROLLER_BUTTON_MASK) === 0, "controller buttons include reserved bits");
  return Object.freeze({
    buttons,
    stickX: byte("stickX"),
    stickY: byte("stickY"),
    cStickX: byte("cStickX"),
    cStickY: byte("cStickY"),
    triggerL: byte("triggerL"),
    triggerR: byte("triggerR"),
    analogA: byte("analogA"),
    analogB: byte("analogB"),
  });
}

function controllerMessage(state, sequence) {
  invariant(typeof sequence === "bigint" && sequence > 0n && sequence <= 0xffff_ffff_ffff_ffffn,
    "controller sequence is invalid");
  const normalized = normalizeControllerState(state);
  return Object.freeze({
    sequence,
    message: {
      type: "resident-input",
      sequenceLo: Number(sequence & 0xffff_ffffn),
      sequenceHi: Number(sequence >> 32n),
      buttons: normalized.buttons,
      stickXyCxy: packByteLanes(
        normalized.stickX,
        normalized.stickY,
        normalized.cStickX,
        normalized.cStickY,
      ),
      triggerLrab: packByteLanes(
        normalized.triggerL,
        normalized.triggerR,
        normalized.analogA,
        normalized.analogB,
      ),
    },
    state: normalized,
  });
}

function timeout(promise, milliseconds, label, onTimeout = () => {}) {
  let timer = null;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new Error(`${label} exceeded ${milliseconds} ms`));
      }
    }, milliseconds);
  });
  return Promise.race([Promise.resolve(promise), expired]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

const cooperativeYield = (() => {
  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.addEventListener("message", () => waiting.shift()?.());
  channel.port1.start();
  return () => new Promise(resolve => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });
})();

class ResidentWorkerClient {
  constructor(worker, renderer, onFatal) {
    this.worker = worker;
    this.renderer = renderer;
    this.onFatal = onFatal;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.renderRelays = new Set();
    this.renderIds = new Set();
    this.closed = false;
    this.closing = false;
    this.lastDiagnostics = null;
    worker.addEventListener("message", event => {
      try {
        this.handleMessage(event.data ?? {});
      } catch (error) {
        this.fail(error);
      }
    });
    worker.addEventListener("error", event => {
      this.fail(new Error(event.message || "resident Worker failed"));
    });
    worker.addEventListener("messageerror", () => {
      this.fail(new Error("resident Worker message could not be decoded"));
    });
  }

  fail(error) {
    if (this.closed) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onFatal(error);
  }

  request(message, expectedType, timeoutMs, transfer = []) {
    invariant(!this.closed && !this.closing, "resident Worker is unavailable");
    const requestId = this.nextRequestId++;
    invariant(Number.isSafeInteger(requestId), "resident Worker request IDs are exhausted");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`${message.type} exceeded ${timeoutMs} ms`);
        reject(error);
        this.onFatal(error);
      }, timeoutMs);
      this.pending.set(requestId, { expectedType, resolve, reject, timer });
      this.worker.postMessage({ ...message, requestId }, transfer);
    });
  }

  async relayRender(message) {
    let id = null;
    let tracked = false;
    try {
      id = checkedPositiveInteger(message.id, "renderer relay ID");
      invariant(!this.renderIds.has(id), "renderer relay ID was reused");
      const source = ownedBytes(message.source, "resident render source");
      const requestFlags = checkedU32(message.requestFlags, "resident render flags");
      const sequenceLo = checkedU32(message.sequenceLo, "resident render sequence low");
      const sequenceHi = checkedU32(message.sequenceHi, "resident render sequence high");
      this.renderIds.add(id);
      tracked = true;
      // `submit_resident_render` copies its Uint8Array synchronously. JavaScript never parses the
      // request or receipt and never chooses renderer work.
      const submission = this.renderer.submit_resident_render(
        source,
        requestFlags,
        sequenceLo,
        sequenceHi,
      );
      const receipt = ownedBytes(await timeout(
        submission,
        POLICY.renderTimeoutMs,
        "resident renderer submission",
      ), "resident renderer receipt");
      this.renderer.check_health();
      if (!this.closed && !this.closing) {
        this.worker.postMessage({
          type: "resident-render-receipt",
          id,
          receipt,
        }, [receipt.buffer]);
      }
    } catch (error) {
      if (tracked && !this.closed && !this.closing) {
        this.worker.postMessage({
          type: "resident-render-error",
          id,
          error: String(error?.stack ?? error),
        });
      }
      this.onFatal(error);
    } finally {
      if (tracked) this.renderIds.delete(id);
    }
  }

  handleMessage(message) {
    if (this.closed) return;
    if (message.type === "resident-render-request") {
      const relay = this.relayRender(message);
      this.renderRelays.add(relay);
      void relay.finally(() => this.renderRelays.delete(relay));
      return;
    }
    if (message.diagnostics !== undefined) {
      this.lastDiagnostics = validateDiagnostics(message.diagnostics);
    }
    const requestId = message.requestId;
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.fail(new Error(`unexpected resident Worker response ${String(message.type)}`));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (message.type === "resident-error") {
      pending.reject(new Error(String(message.error ?? "resident Worker protocol failed")));
      return;
    }
    if (message.type !== pending.expectedType) {
      pending.reject(new Error(
        `expected ${pending.expectedType}, received ${String(message.type)}`,
      ));
      return;
    }
    pending.resolve(message);
  }

  async closeGracefully() {
    if (this.closed) return;
    invariant(!this.closing, "resident Worker close is already pending");
    const requestId = this.nextRequestId++;
    invariant(Number.isSafeInteger(requestId), "resident Worker request IDs are exhausted");
    this.closing = true;
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`resident-close exceeded ${POLICY.closeTimeoutMs} ms`));
      }, POLICY.closeTimeoutMs);
      this.pending.set(requestId, {
        expectedType: "resident-closed",
        resolve,
        reject,
        timer,
      });
      this.worker.postMessage({ type: "resident-close", requestId });
    });
    await closed;
    await timeout(
      Promise.allSettled([...this.renderRelays]),
      POLICY.closeTimeoutMs,
      "resident renderer relay settlement",
    );
    this.finishClose();
  }

  finishClose() {
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("resident Worker closed"));
    }
    this.pending.clear();
  }

  forceClose() {
    this.finishClose();
  }
}

class ResidentInputPublisher {
  constructor(getClient, onFatal) {
    this.getClient = getClient;
    this.onFatal = onFatal;
    this.nextSequence = 1n;
    this.desired = null;
    this.lastState = null;
    this.inFlight = null;
    this.retained = null;
  }

  update(state) {
    const normalized = normalizeControllerState(state);
    if (sameControllerState(normalized, this.lastState)) return false;
    invariant(this.nextSequence <= 0xffff_ffff_ffff_ffffn, "controller sequence exhausted");
    this.lastState = normalized;
    this.desired = controllerMessage(normalized, this.nextSequence++);
    this.pump();
    return true;
  }

  pump() {
    const client = this.getClient();
    if (!client || this.inFlight !== null || this.retained !== null || this.desired === null) return;
    const candidate = this.desired;
    this.inFlight = candidate;
    void client.request(
      candidate.message,
      "resident-input-result",
      POLICY.sliceTimeoutMs,
    ).then(response => {
      const status = checkedU32(response.status, "resident input status");
      invariant([
        INPUT_REJECTED,
        INPUT_QUEUED,
        INPUT_COALESCED,
        INPUT_EQUIVALENT,
      ].includes(status), "resident input status changed");
      if (status === INPUT_REJECTED) {
        // The frozen adapter owns exact retries. Re-sending this sequence after a successful
        // internal retry would be non-monotonic, so wait for its diagnostics gauge to clear.
        this.retained = candidate;
      }
      if (this.desired?.sequence === candidate.sequence && status !== INPUT_REJECTED) {
        this.desired = null;
      }
    }).catch(this.onFatal).finally(() => {
      this.inFlight = null;
      this.pump();
    });
  }

  observeDiagnostics(diagnostics) {
    if (this.retained === null) return;
    if (diagnostics?.pendingControllerSample !== false) return;
    if (this.desired?.sequence === this.retained.sequence) this.desired = null;
    this.retained = null;
    this.pump();
  }
}

function validateBoot(response) {
  const boot = exactObject(response.boot, "resident boot result");
  invariant(boot.status === 3, `resident boot did not commit (status ${String(boot.status)})`);
  invariant(Number.isSafeInteger(boot.reads) && boot.reads > 0 && boot.reads <= POLICY.maxBootReads,
    "resident boot read accounting is invalid");
  const diagnostics = validateDiagnostics(response.diagnostics);
  invariant(diagnostics.booted, "resident ready diagnostics are not booted");
  return boot;
}

function validateRunResult(response) {
  const result = exactObject(response.result, "resident run result");
  invariant(typeof result.boundary === "string", "resident run boundary is invalid");
  const hostCalls = checkedU32(result.hostCalls, "resident host calls");
  const coldInstalls = checkedU32(result.coldInstalls, "resident cold installs");
  invariant(hostCalls <= POLICY.maxHostCalls, "resident host-call accounting exceeded its cap");
  invariant(coldInstalls <= POLICY.maxColdInstalls,
    "resident cold-install accounting exceeded its cap");
  if (result.boundary === "host-call-cap" || result.boundary === "cold-install-cap") {
    invariant(result.boundary !== "host-call-cap" || hostCalls === POLICY.maxHostCalls,
      "resident host-call cap boundary did not reach its cap");
    invariant(result.boundary !== "cold-install-cap" || coldInstalls === POLICY.maxColdInstalls,
      "resident cold-install cap boundary did not reach its cap");
    return Object.freeze({ boundary: result.boundary, hostCalls, coldInstalls });
  }
  invariant(result.boundary === "rust", `unknown resident run boundary ${result.boundary}`);
  const outcome = exactObject(result.outcome, "resident run outcome");
  const reason = checkedU32(outcome.reason, "resident run reason");
  const detail = checkedU32(outcome.detail, "resident run detail");
  const cycles = checkedDecimal(outcome.executedCycles, "resident executed cycles");
  const instructions = checkedDecimal(
    outcome.executedInstructions,
    "resident executed instructions",
  );
  invariant(result.cycleUpperCap === POLICY.cycleUpperCap,
    "resident Worker returned a different cycle upper cap");
  invariant(result.blockUpperCap === POLICY.blockUpperCap,
    "resident Worker returned a different block upper cap");
  invariant(cycles <= BigInt(POLICY.cycleUpperCap),
    "resident executed cycles exceeded the active slice cap");
  invariant(cycles !== 0n || instructions === 0n,
    "resident returned positive instructions with zero cycles");
  return Object.freeze({
    boundary: "rust",
    reason,
    detail,
    cycles,
    instructions,
    hostCalls,
    coldInstalls,
  });
}

class ResidentSession {
  constructor(manager, disc, label, iplBytes) {
    this.manager = manager;
    this.disc = disc;
    this.label = label;
    this.iplBytes = iplBytes;
    this.worker = null;
    this.client = null;
    this.input = new ResidentInputPublisher(
      () => this.state === "running" || this.state === "paused" ? this.client : null,
      error => this.fail(error),
    );
    this.state = "created";
    this.boot = null;
    this.lastDiagnostics = null;
    this.runPromise = null;
    this.pauseWaiters = [];
    this.failure = null;
    this.totals = {
      rustSlices: 0,
      hostCallCapBoundaries: 0,
      coldInstallCapBoundaries: 0,
      hostCalls: 0,
      coldInstalls: 0,
      executedCycles: 0n,
      executedInstructions: 0n,
      zeroProgressSlices: 0,
      maximumConsecutiveZeroProgressSlices: 0,
      consecutiveZeroProgressSlices: 0,
      outcomeDetails: Object.create(null),
    };
  }

  async start() {
    invariant(this.state === "created", "resident session was already started");
    this.state = "booting";
    this.manager.setStatus("loading", "loading", this.label);
    this.worker = new Worker(new URL(residentReleaseRuntime.worker.url, location.href), {
      type: "module",
      name: "lazuli-resident-machine",
    });
    this.client = new ResidentWorkerClient(
      this.worker,
      this.manager.renderer,
      error => this.fail(error),
    );
    const ipl = this.iplBytes === null ? null : this.iplBytes.slice();
    const message = {
      type: "resident-init",
      artifacts: {
        core: residentReleaseRuntime.core.url,
        dispatcher: residentReleaseRuntime.dispatcher.url,
        coordinator: residentReleaseRuntime.coordinator.url,
      },
      disc: this.disc,
      maxBootReads: POLICY.maxBootReads,
      ...(ipl === null ? {} : { iplBytes: ipl }),
    };
    const response = await this.client.request(
      message,
      "resident-ready",
      POLICY.bootTimeoutMs,
      ipl === null ? [] : [ipl.buffer],
    );
    this.boot = validateBoot(response);
    this.lastDiagnostics = response.diagnostics;
    this.state = "running";
    this.manager.setStatus("running", "running", this.label);
    this.input.update(this.manager.controllerState());
    this.runPromise = this.runLoop();
    void this.runPromise.catch(error => this.fail(error));
    return this;
  }

  async runLoop() {
    while (this.state === "running" || this.state === "paused") {
      if (this.state === "paused") {
        await new Promise(resolve => this.pauseWaiters.push(resolve));
        continue;
      }
      const response = await this.client.request({
        type: "resident-run",
        cycleUpperCap: POLICY.cycleUpperCap,
        blockUpperCap: POLICY.blockUpperCap,
        maxHostCalls: POLICY.maxHostCalls,
        maxColdInstalls: POLICY.maxColdInstalls,
      }, "resident-run-result", POLICY.sliceTimeoutMs);
      this.lastDiagnostics = validateDiagnostics(response.diagnostics);
      this.input.observeDiagnostics(this.lastDiagnostics);
      const observed = validateRunResult(response);
      this.totals.hostCalls = checkedCounter(
        this.totals.hostCalls + observed.hostCalls,
        "session host-call total",
      );
      this.totals.coldInstalls = checkedCounter(
        this.totals.coldInstalls + observed.coldInstalls,
        "session cold-install total",
      );
      if (observed.boundary === "host-call-cap") {
        this.totals.hostCallCapBoundaries += 1;
      } else if (observed.boundary === "cold-install-cap") {
        this.totals.coldInstallCapBoundaries += 1;
      } else {
        this.totals.rustSlices += 1;
        this.totals.executedCycles += observed.cycles;
        this.totals.executedInstructions += observed.instructions;
        const key = String(observed.detail);
        this.totals.outcomeDetails[key] = (this.totals.outcomeDetails[key] ?? 0) + 1;
        if (observed.cycles === 0n && observed.instructions === 0n) {
          this.totals.zeroProgressSlices += 1;
          this.totals.consecutiveZeroProgressSlices += 1;
          this.totals.maximumConsecutiveZeroProgressSlices = Math.max(
            this.totals.maximumConsecutiveZeroProgressSlices,
            this.totals.consecutiveZeroProgressSlices,
          );
          invariant(
            this.totals.consecutiveZeroProgressSlices < POLICY.zeroProgressSliceCap,
            `zero-progress slice cap ${POLICY.zeroProgressSliceCap} reached`,
          );
        } else {
          this.totals.consecutiveZeroProgressSlices = 0;
        }
        if (observed.reason === RUN_REASON_BUDGET_EXHAUSTED) {
          // Continue below.
        } else if (
          observed.reason === RUN_REASON_HALTED
          || observed.reason === RUN_REASON_BREAKPOINT
        ) {
          this.state = "stopped";
          this.manager.setStatus("stopped", "stopped", this.label);
          break;
        } else if (
          observed.reason === RUN_REASON_COMPILE_REQUIRED
          || observed.reason === RUN_REASON_HOST_REQUEST
          || observed.reason === RUN_REASON_FAULT
          || observed.reason === RUN_REASON_INVALID_STATE
        ) {
          throw new Error(
            `Rust resident run stopped with reason ${observed.reason}, detail ${observed.detail}`,
          );
        } else {
          throw new Error(`unknown Rust resident run reason ${observed.reason}`);
        }
      }
      await cooperativeYield();
    }
  }

  pause() {
    if (this.state !== "running") return false;
    this.state = "paused";
    this.manager.setStatus("paused", "paused", this.label);
    return true;
  }

  resume() {
    if (this.state !== "paused") return false;
    this.state = "running";
    for (const resolve of this.pauseWaiters.splice(0)) resolve();
    this.manager.setStatus("running", "running", this.label);
    return true;
  }

  fail(error) {
    if (["failed", "stopping", "closed"].includes(this.state)) return;
    this.failure = error;
    this.state = "failed";
    for (const resolve of this.pauseWaiters.splice(0)) resolve();
    this.manager.sessionFailed(this, error);
  }

  async diagnostics() {
    if (this.client && !this.client.closed && !this.client.closing) {
      const response = await this.client.request(
        { type: "resident-diagnostics" },
        "resident-diagnostics-result",
        POLICY.sliceTimeoutMs,
      );
      this.lastDiagnostics = validateDiagnostics(response.diagnostics);
      this.input.observeDiagnostics(this.lastDiagnostics);
    }
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      label: this.label,
      boot: this.boot,
      totals: {
        ...this.totals,
        executedCycles: this.totals.executedCycles.toString(),
        executedInstructions: this.totals.executedInstructions.toString(),
        outcomeDetails: { ...this.totals.outcomeDetails },
      },
      diagnostics: this.lastDiagnostics,
      failure: this.failure === null ? null : String(this.failure?.stack ?? this.failure),
    });
  }

  async close() {
    if (this.state === "closed") return;
    this.state = "stopping";
    for (const resolve of this.pauseWaiters.splice(0)) resolve();
    const client = this.client;
    if (client !== null) {
      try {
        await client.closeGracefully();
      } catch (error) {
        client.forceClose();
        throw error;
      }
    }
    this.state = "closed";
  }

  forceClose() {
    this.client?.forceClose();
    this.state = "closed";
    for (const resolve of this.pauseWaiters.splice(0)) resolve();
  }
}

class ResidentFrontendManager {
  constructor(renderer, elements) {
    this.renderer = renderer;
    this.elements = elements;
    this.session = null;
    this.transition = Promise.resolve();
    this.poisoned = false;
    this.activeDisc = null;
    this.activeLabel = null;
    this.selectedIpl = null;
    this.sampleController = () => neutralControllerState();
  }

  setControllerSampler(sample) {
    this.sampleController = sample;
  }

  controllerState() {
    return normalizeControllerState(this.sampleController());
  }

  publishController() {
    if (this.session?.state === "running" || this.session?.state === "paused") {
      this.session.input.update(this.controllerState());
    }
  }

  setStatus(bodyStatus, runnerText, discText = this.activeLabel ?? "ready") {
    document.body.dataset.status = bodyStatus;
    this.elements.runnerStatus.textContent = runnerText;
    this.elements.discStatus.textContent = discText;
  }

  async resetRenderer() {
    this.renderer.reset();
    await timeout(
      this.renderer.drain(),
      POLICY.renderTimeoutMs,
      "WebGPU renderer reset drain",
    );
    this.renderer.check_health();
    this.renderer.reset_diagnostics();
  }

  activate(disc, label) {
    exactObject(disc, "resident disc descriptor");
    invariant(disc.kind === "blob" || disc.kind === "http-range",
      "resident disc transport is unsupported");
    if (disc.kind === "blob") invariant(disc.blob instanceof Blob, "disc Blob is invalid");
    if (disc.kind === "http-range") {
      const url = new URL(disc.url, location.href);
      invariant(url.protocol === "http:" || url.protocol === "https:",
        "disc URL protocol is unsupported");
      disc = { kind: "http-range", url: url.href };
    }
    const selectedDisc = disc;
    const selectedLabel = String(label);
    const selectedIpl = this.selectedIpl?.image.slice() ?? null;
    this.activeDisc = selectedDisc;
    this.activeLabel = selectedLabel;
    this.transition = this.transition.then(async () => {
      invariant(!this.poisoned, "frontend is poisoned; reload before opening another disc");
      if (this.session !== null) {
        try {
          await this.session.close();
          await timeout(
            this.renderer.drain(),
            POLICY.closeTimeoutMs,
            "old renderer drain",
          );
          this.renderer.check_health();
        } catch (error) {
          this.poison(error);
          throw error;
        }
      }
      await this.resetRenderer();
      const session = new ResidentSession(
        this,
        selectedDisc,
        selectedLabel,
        selectedIpl,
      );
      this.session = session;
      try {
        await session.start();
      } catch (error) {
        session.forceClose();
        this.poison(error);
        throw error;
      }
    }).catch(error => {
      this.publishReport({ status: "failed", error: String(error?.stack ?? error) });
    });
    return this.transition;
  }

  setIpl(decoded, label) {
    invariant(decoded?.image instanceof Uint8Array
      && decoded.image.byteLength === LOCAL_IPL_IMAGE_BYTES, "decoded IPL is invalid");
    this.selectedIpl = { image: decoded.image.slice(), region: decoded.region };
    this.elements.iplStatus.textContent = `local IPL: ${label} (${decoded.region})`;
    this.elements.iplPickerLabel.textContent = `IPL: ${decoded.region}`;
    if (this.activeDisc !== null) return this.activate(this.activeDisc, this.activeLabel);
    return Promise.resolve();
  }

  sessionFailed(session, error) {
    if (this.session !== session) return;
    this.poison(error);
    session.forceClose();
  }

  poison(error) {
    if (this.poisoned) return;
    this.poisoned = true;
    this.setStatus("stopped", "failed", this.activeLabel ?? "no disc");
    this.publishReport({ status: "failed", error: String(error?.stack ?? error) });
  }

  async diagnostics() {
    const session = this.session === null ? null : await this.session.diagnostics();
    const hasPresentedXfb = this.renderer.has_presented_xfb();
    invariant(typeof hasPresentedXfb === "boolean",
      "renderer presentation witness is not boolean");
    const report = Object.freeze({
      schema: "lazuli-resident-frontend-diagnostics-v1",
      status: this.poisoned ? "failed" : session?.state ?? "waiting",
      policy: POLICY,
      runtime: residentReleaseRuntime,
      session,
      renderer: {
        hasPresentedXfb,
        diagnostics: this.renderer.diagnostics(),
        hostDiagnostics: this.renderer.host_diagnostics(),
      },
      capabilityBoundary: {
        rawDiscBytesOnly: true,
        opaqueRendererRequestsAndReceipts: true,
        opaqueMachineEvidence: true,
        javascriptDispatchTableSets: 0,
        javascriptGuestMemoryReads: 0,
      },
    });
    this.publishReport(report);
    return report;
  }

  publishReport(report) {
    this.elements.output.textContent = JSON.stringify(report, null, 2);
  }

  pause() {
    return this.session?.pause() ?? false;
  }

  resume() {
    return this.session?.resume() ?? false;
  }

  async stop() {
    if (this.session === null) return;
    try {
      await this.session.close();
      await timeout(this.renderer.drain(), POLICY.closeTimeoutMs, "renderer stop drain");
      this.renderer.check_health();
      this.setStatus("stopped", "stopped", this.activeLabel);
    } catch (error) {
      this.poison(error);
    }
  }
}

const PAL_IPL_HEADER =
  "(C) 1999-2001 Nintendo.  All rights reserved."
  + "(C) 1999 ArtX Inc.  All rights reserved."
  + "PAL  Revision 1.0  ";

function hasPalIplHeader(image) {
  if (image[PAL_IPL_HEADER.length] !== 0) return false;
  for (let index = 0; index < PAL_IPL_HEADER.length; index += 1) {
    if (image[index] !== PAL_IPL_HEADER.charCodeAt(index)) return false;
  }
  return true;
}

function descrambleRetailIplRange(image, start, end) {
  let accumulator = 0;
  let accumulatorBits = 0;
  let t = 0x2953;
  let u = 0xd9c2;
  let v = 0x3ff1;
  let x = 1;
  let index = start;
  while (index < end) {
    const t0 = t & 1;
    const t1 = (t >>> 1) & 1;
    const u0 = u & 1;
    const u1 = (u >>> 1) & 1;
    const v0 = v & 1;
    x ^= t1 ^ v0;
    x ^= u0 | u1;
    x ^= (t0 ^ u1 ^ v0) & (t0 ^ u0);
    if (t0 === u0) {
      v >>>= 1;
      if (v0 !== 0) v ^= 0xb3d0;
    }
    if (t0 === 0) {
      u >>>= 1;
      if (u0 !== 0) u ^= 0xfb10;
    }
    t >>>= 1;
    if (t0 !== 0) t ^= 0xa740;
    accumulatorBits += 1;
    accumulator = (accumulator * 2 + x) & 0xff;
    if (accumulatorBits === 8) {
      image[index] ^= accumulator;
      index += 1;
      accumulatorBits = 0;
    }
  }
}

function decodeRetailIplImage(input) {
  invariant(input instanceof Uint8Array, "IPL image must be a Uint8Array");
  invariant(input.byteLength === LOCAL_IPL_IMAGE_BYTES, "IPL file must be exactly 2 MiB");
  const image = input.slice();
  invariant(image.indexOf(0) !== -1, "IPL header is not NUL-terminated");
  const region = hasPalIplHeader(image) ? "PAL" : "NTSC";
  const decodedEnd = region === "PAL" ? 0x001a_eee8 : 0x0015_ee40;
  descrambleRetailIplRange(image, 0x100, decodedEnd);
  return Object.freeze({ image, region, decodedBytes: decodedEnd - 0x100 });
}

async function readLocalIplFile(file) {
  invariant(file instanceof Blob, "IPL picker did not provide a file");
  invariant(file.size === LOCAL_IPL_IMAGE_BYTES, "IPL file must be exactly 2 MiB");
  return decodeRetailIplImage(new Uint8Array(await file.arrayBuffer()));
}

function neutralControllerState() {
  return {
    buttons: 0,
    stickX: 0x80,
    stickY: 0x80,
    cStickX: 0x80,
    cStickY: 0x80,
    triggerL: 0,
    triggerR: 0,
    analogA: 0,
    analogB: 0,
  };
}

function axisByte(value, invert = false) {
  const axis = Math.max(-1, Math.min(1, Number(value) || 0));
  return Math.max(0, Math.min(255, Math.round(0x80 + (invert ? -axis : axis) * 0x7f)));
}

function buttonPressed(gamepad, index) {
  return gamepad?.buttons[index]?.pressed === true;
}

function digitalAxisByte(buttons, negativeButton, positiveButton) {
  const negative = (buttons & negativeButton) !== 0;
  const positive = (buttons & positiveButton) !== 0;
  if (negative === positive) return 0x80;
  return negative ? 0x01 : 0xff;
}

function sampleControllerState(gamepad, virtualButtons) {
  let buttons = virtualButtons;
  if (buttonPressed(gamepad, 14)) buttons |= 0x0001;
  if (buttonPressed(gamepad, 15)) buttons |= 0x0002;
  if (buttonPressed(gamepad, 13)) buttons |= 0x0004;
  if (buttonPressed(gamepad, 12)) buttons |= 0x0008;
  if (buttonPressed(gamepad, 10)) buttons |= 0x0010;
  if (buttonPressed(gamepad, 5) || buttonPressed(gamepad, 7)) buttons |= 0x0020;
  if (buttonPressed(gamepad, 4) || buttonPressed(gamepad, 6)) buttons |= 0x0040;
  if (buttonPressed(gamepad, 0)) buttons |= 0x0100;
  if (buttonPressed(gamepad, 1)) buttons |= 0x0200;
  if (buttonPressed(gamepad, 2)) buttons |= 0x0400;
  if (buttonPressed(gamepad, 3)) buttons |= 0x0800;
  if (buttonPressed(gamepad, 9)) buttons |= 0x1000;
  const directions = buttons & 0x000f;
  return {
    buttons,
    stickX: directions & 0x0003
      ? digitalAxisByte(directions, 0x0001, 0x0002)
      : axisByte(gamepad?.axes[0]),
    stickY: directions & 0x000c
      ? digitalAxisByte(directions, 0x0004, 0x0008)
      : axisByte(gamepad?.axes[1], true),
    cStickX: axisByte(gamepad?.axes[2]),
    cStickY: axisByte(gamepad?.axes[3], true),
    triggerL: Math.round((gamepad?.buttons[6]?.value ?? 0) * 0xff),
    triggerR: Math.round((gamepad?.buttons[7]?.value ?? 0) * 0xff),
    analogA: buttons & 0x0100 ? 0xff : 0,
    analogB: buttons & 0x0200 ? 0xff : 0,
  };
}

function installController(manager) {
  let keyboardButtons = 0;
  const pointers = new Map();
  const pulses = new Map();
  const keyboardButtonMap = new Map([
    ["ArrowLeft", 0x0001],
    ["ArrowRight", 0x0002],
    ["ArrowDown", 0x0004],
    ["ArrowUp", 0x0008],
    ["KeyE", 0x0010],
    ["KeyW", 0x0020],
    ["KeyQ", 0x0040],
    ["KeyZ", 0x0100],
    ["KeyX", 0x0200],
    ["KeyA", 0x0400],
    ["KeyS", 0x0800],
    ["Enter", 0x1000],
  ]);

  function pulse(button, duration = CONTROLLER_MINIMUM_PRESS_MS) {
    const milliseconds = Math.min(
      CONTROLLER_MAXIMUM_PULSE_MS,
      Math.max(0, Number(duration) || 0),
    );
    pulses.set(button, performance.now() + milliseconds);
    manager.publishController();
  }

  function activeButtons() {
    const now = performance.now();
    for (const [button, deadline] of pulses) {
      if (deadline <= now) pulses.delete(button);
    }
    let buttons = keyboardButtons;
    for (const active of pointers.values()) buttons |= active.button;
    for (const button of pulses.keys()) buttons |= button;
    return buttons;
  }

  function sample() {
    const gamepad = Array.from(navigator.getGamepads?.() ?? [])
      .find(candidate => candidate?.connected) ?? null;
    return sampleControllerState(gamepad, activeButtons());
  }

  manager.setControllerSampler(sample);

  function releasePointer(event, preserveShortPress = false) {
    const active = pointers.get(event.pointerId);
    if (!active) return;
    pointers.delete(event.pointerId);
    if (preserveShortPress) {
      const elapsed = Number(event.timeStamp) - active.startedAt;
      if (Number.isFinite(elapsed) && elapsed < CONTROLLER_MINIMUM_PRESS_MS) {
        pulse(active.button, CONTROLLER_MINIMUM_PRESS_MS - Math.max(0, elapsed));
      }
    }
    if (active.element.hasPointerCapture?.(event.pointerId)) {
      active.element.releasePointerCapture(event.pointerId);
    }
    manager.publishController();
  }

  function bind(selector, button) {
    const element = document.querySelector(selector);
    invariant(element !== null, `missing controller element ${selector}`);
    element.style.touchAction = "none";
    element.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      pulses.delete(button);
      pointers.set(event.pointerId, {
        button,
        element,
        startedAt: Number(event.timeStamp),
      });
      try {
        element.setPointerCapture(event.pointerId);
      } catch (_error) {
        // Window release listeners cover browsers without pointer capture.
      }
      manager.publishController();
      if (event.pointerType !== "mouse") event.preventDefault();
    });
    element.addEventListener("pointerup", event => releasePointer(event, true));
    element.addEventListener("pointercancel", event => releasePointer(event));
    element.addEventListener("lostpointercapture", event => releasePointer(event));
    element.addEventListener("click", event => {
      if (event.detail === 0) pulse(button);
    });
  }

  bind("#controller-left", 0x0001);
  bind("#controller-right", 0x0002);
  bind("#controller-down", 0x0004);
  bind("#controller-up", 0x0008);
  bind("#controller-a", 0x0100);
  bind("#controller-b", 0x0200);
  bind("#controller-start", 0x1000);
  addEventListener("pointerup", event => releasePointer(event, true));
  addEventListener("pointercancel", event => releasePointer(event));

  function nativeKeyboardAction(target) {
    return target instanceof Element && target.closest(
      "a, button, input, select, summary, textarea, [contenteditable]",
    ) !== null;
  }
  addEventListener("keydown", event => {
    const button = keyboardButtonMap.get(event.code);
    if (button === undefined || nativeKeyboardAction(event.target)) return;
    keyboardButtons |= button;
    manager.publishController();
    event.preventDefault();
  });
  addEventListener("keyup", event => {
    const button = keyboardButtonMap.get(event.code);
    if (button === undefined) return;
    keyboardButtons &= ~button;
    manager.publishController();
    if (!nativeKeyboardAction(event.target)) event.preventDefault();
  });

  function clear() {
    keyboardButtons = 0;
    pointers.clear();
    pulses.clear();
    manager.publishController();
  }
  addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clear();
  });

  globalThis.lazuliController = Object.freeze({
    pulseUp: duration => pulse(0x0008, duration),
    pulseDown: duration => pulse(0x0004, duration),
    pulseLeft: duration => pulse(0x0001, duration),
    pulseRight: duration => pulse(0x0002, duration),
    pulseA: duration => pulse(0x0100, duration),
    pulseB: duration => pulse(0x0200, duration),
    pulseStart: duration => pulse(0x1000, duration),
  });

  function animationFrame() {
    manager.publishController();
    requestAnimationFrame(animationFrame);
  }
  requestAnimationFrame(animationFrame);
}

async function main() {
  validateRuntime(residentReleaseRuntime);
  const elements = {
    canvas: document.querySelector("#display"),
    runnerStatus: document.querySelector("#runner-status"),
    discStatus: document.querySelector("#disc-status"),
    iplStatus: document.querySelector("#ipl-status"),
    iplPickerLabel: document.querySelector("#ipl-picker-label"),
    output: document.querySelector("#result") ?? { textContent: "" },
  };
  for (const [name, element] of Object.entries(elements)) {
    invariant(element !== null, `missing ${name} element`);
  }
  await initBrowserRenderer();
  const renderer = await WebGpuRenderer.create(elements.canvas);
  document.body.dataset.renderer = "wgpu-webgpu";
  const manager = new ResidentFrontendManager(renderer, elements);
  installController(manager);

  globalThis.lazuliCycleRunner = Object.freeze({
    pause: () => manager.pause(),
    resume: () => manager.resume(),
    stop: () => manager.stop(),
    snapshot: () => manager.diagnostics(),
  });
  globalThis.lazuliRendererDiagnostics = Object.freeze({
    capturePerformance: () => ({
      diagnostics: renderer.diagnostics(),
      hostDiagnostics: renderer.host_diagnostics(),
    }),
    captureTerminal: () => manager.diagnostics(),
  });

  const capture = document.querySelector("#capture-diagnostics");
  if (capture !== null) {
    capture.dataset.testid = "diagnostics-capture";
    capture.disabled = false;
    capture.dataset.captureState = "ready";
    capture.addEventListener("click", async () => {
      if (capture.dataset.captureState === "pending") return;
      capture.disabled = true;
      capture.dataset.captureState = "pending";
      try {
        await manager.diagnostics();
        capture.dataset.captureState = "complete";
      } catch (error) {
        capture.dataset.captureState = "failed";
        capture.dataset.failure = String(error?.stack ?? error);
      } finally {
        capture.disabled = false;
      }
    });
  }

  const discInput = document.querySelector("#disc-file");
  invariant(discInput !== null, "missing disc picker");
  discInput.addEventListener("click", event => { event.currentTarget.value = ""; });
  discInput.addEventListener("change", event => {
    const file = event.currentTarget.files?.[0];
    if (file !== undefined) void manager.activate({ kind: "blob", blob: file }, `local: ${file.name}`);
  });

  const iplInput = document.querySelector("#ipl-file");
  invariant(iplInput !== null, "missing IPL picker");
  let iplSelectionSequence = 0;
  iplInput.addEventListener("click", event => { event.currentTarget.value = ""; });
  iplInput.addEventListener("change", async event => {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) return;
    const sequence = ++iplSelectionSequence;
    iplInput.disabled = true;
    elements.iplPickerLabel.textContent = "Reading IPL…";
    elements.iplStatus.textContent = "reading local IPL";
    try {
      const decoded = await readLocalIplFile(file);
      if (sequence === iplSelectionSequence) await manager.setIpl(decoded, file.name);
    } catch (error) {
      if (sequence === iplSelectionSequence) {
        elements.iplPickerLabel.textContent = "IPL rejected";
        elements.iplStatus.textContent = String(error?.message ?? error);
      }
    } finally {
      if (sequence === iplSelectionSequence) iplInput.disabled = false;
    }
  });

  const pause = document.querySelector("#pause-runner");
  pause?.addEventListener("click", () => manager.pause());
  document.querySelector("#resume-runner")?.addEventListener("click", () => manager.resume());
  document.querySelector("#snapshot-runner")?.addEventListener("click", () => {
    void manager.diagnostics();
  });
  document.querySelector("#stop-runner")?.addEventListener("click", () => {
    void manager.stop();
  });
  const discUrl = document.querySelector("#disc-url");
  const loadDiscUrl = () => {
    if (discUrl === null) return;
    try {
      const url = new URL(discUrl.value.trim());
      invariant(url.protocol === "http:" || url.protocol === "https:",
        "disc URL protocol is unsupported");
      void manager.activate({ kind: "http-range", url: url.href }, `network: ${url.host}`);
    } catch (_error) {
      elements.discStatus.textContent = "enter a valid HTTP URL";
      discUrl.focus();
    }
  };
  document.querySelector("#load-disc-url")?.addEventListener("click", loadDiscUrl);
  discUrl?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadDiscUrl();
    }
  });

  if (defaultDiscSourceConfig === null) {
    manager.setStatus("waiting", "waiting", "open a disc");
    manager.publishReport({ status: "waiting", message: "Choose an ISO or CISO to begin." });
  } else if (defaultDiscSourceConfig.kind === "logical-range-endpoint") {
    await manager.activate(
      { kind: "http-range", url: defaultDiscSourceConfig.url },
      "configured disc",
    );
  } else {
    throw new Error("resident frontend does not accept boot assets");
  }
}

main().catch(error => {
  document.body.dataset.status = "stopped";
  document.body.dataset.renderer = "unavailable";
  const runnerStatus = document.querySelector("#runner-status");
  if (runnerStatus !== null) runnerStatus.textContent = "failed";
  const output = document.querySelector("#result");
  if (output !== null) {
    output.textContent = JSON.stringify({
      status: "failed",
      error: String(error?.stack ?? error),
    }, null, 2);
  }
});
