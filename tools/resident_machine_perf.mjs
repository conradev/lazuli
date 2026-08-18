// SPDX-License-Identifier: GPL-3.0-only

import initRenderer, {
  WebGpuRenderer,
} from "/resident-artifacts/browser_renderer.js";

const resultElement = document.querySelector("#result");
const canvas = document.querySelector("#display");
const parameters = new URL(location.href).searchParams;

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(parameters.get(name) ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

const warmupMs = boundedInteger("warmupMs", 5_000, 0, 120_000);
const measureMs = boundedInteger("measureMs", 15_000, 1_000, 120_000);
const cycleUpperCap = BigInt(boundedInteger("cycleCap", 1_000_000, 1, 1_000_000));
const blockUpperCap = boundedInteger("blockCap", 16_384, 1, 16_384);
const maxHostCalls = boundedInteger("hostCallCap", 64, 1, 65_535);
const maxColdInstalls = boundedInteger("coldInstallCap", 64, 1, 65_535);

function optionalInstructionTarget(name) {
  const raw = parameters.get(name);
  if (raw === null) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive base-10 integer`);
  }
  const target = BigInt(raw);
  if (target > 1_000_000_000_000n) {
    throw new Error(`${name} must be no greater than 1000000000000`);
  }
  return target;
}

const warmupInstructionTarget = optionalInstructionTarget("warmupInstructions");
const measurementInstructionTarget = optionalInstructionTarget("measureInstructions");
if ((warmupInstructionTarget === null) !== (measurementInstructionTarget === null)) {
  throw new Error("warmupInstructions and measureInstructions must be supplied together");
}
const instructionProgressMode = warmupInstructionTarget !== null;

function json(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function publish(value) {
  globalThis.__residentPerf = value;
  resultElement.textContent = json(value);
}

function ownedBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("renderer receipt was not bytes");
}

class ResidentWorkerClient {
  constructor(worker, renderer) {
    this.worker = worker;
    this.renderer = renderer;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.renderCalls = 0;
    this.renderFailures = 0;
    worker.addEventListener("message", event => this.handle(event.data ?? {}));
    worker.addEventListener("error", event => this.failAll(new Error(event.message)));
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async render(message) {
    this.renderCalls += 1;
    try {
      const receipt = ownedBytes(await this.renderer.submit_resident_render(
        message.source,
        message.requestFlags,
        message.sequenceLo,
        message.sequenceHi,
      ));
      this.worker.postMessage({
        type: "resident-render-receipt",
        id: message.id,
        receipt,
      }, [receipt.buffer]);
    } catch (error) {
      this.renderFailures += 1;
      this.worker.postMessage({
        type: "resident-render-error",
        id: message.id,
        error: String(error?.stack ?? error),
      });
    }
  }

  handle(message) {
    if (message.type === "resident-render-request") {
      void this.render(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === "resident-error") {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message);
    }
  }

  request(message) {
    const requestId = this.nextRequestId++;
    if (!Number.isSafeInteger(requestId)) throw new Error("worker request id exhausted");
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...message, requestId });
    });
  }

  close() {
    this.worker.terminate();
    this.failAll(new Error("resident throughput worker closed"));
  }
}

function newWindow(label) {
  return {
    label,
    wallMs: 0,
    slices: 0,
    rustBoundaries: 0,
    hostCallCapBoundaries: 0,
    coldInstallCapBoundaries: 0,
    servicedHostCalls: 0,
    coldInstalls: 0,
    executedCycles: 0n,
    executedInstructions: 0n,
    outcomeDetails: Object.create(null),
  };
}

function observeRun(window, result) {
  window.slices += 1;
  if (result.boundary === "rust") {
    window.rustBoundaries += 1;
    window.servicedHostCalls += Number(result.hostCalls);
    window.coldInstalls += Number(result.coldInstalls);
    const reason = Number(result.outcome.reason);
    const detail = Number(result.outcome.detail);
    if (reason !== 0) {
      throw new Error(`Rust resident run stopped with reason ${reason}, detail ${detail}`);
    }
    const key = String(detail);
    window.outcomeDetails[key] = (window.outcomeDetails[key] ?? 0) + 1;
    window.executedCycles += BigInt(result.outcome.executedCycles);
    window.executedInstructions += BigInt(result.outcome.executedInstructions);
  } else if (result.boundary === "host-call-cap") {
    window.hostCallCapBoundaries += 1;
    throw new Error(
      "measurement reached the adapter host-call cap; partial Rust counters are not observable",
    );
  } else if (result.boundary === "cold-install-cap") {
    window.coldInstallCapBoundaries += 1;
    throw new Error(
      "measurement reached the adapter cold-install cap; partial Rust counters are not observable",
    );
  } else {
    throw new Error(`unknown adapter boundary ${String(result.boundary)}`);
  }
}

function finalizeWindow(window, targetInstructions = null) {
  const seconds = window.wallMs / 1_000;
  const instructionOvershoot = targetInstructions === null
    ? null
    : window.executedInstructions - targetInstructions;
  return Object.freeze({
    ...window,
    executedCycles: window.executedCycles.toString(),
    executedInstructions: window.executedInstructions.toString(),
    targetInstructions: targetInstructions?.toString() ?? null,
    instructionOvershoot: instructionOvershoot?.toString() ?? null,
    cyclesPerSecond: seconds === 0 ? 0 : Number(window.executedCycles) / seconds,
    instructionsPerSecond: seconds === 0 ? 0 : Number(window.executedInstructions) / seconds,
    slicesPerSecond: seconds === 0 ? 0 : window.slices / seconds,
  });
}

async function runWindow(client, label, durationMs) {
  const window = newWindow(label);
  const started = performance.now();
  const deadline = started + durationMs;
  do {
    const response = await client.request({
      type: "resident-run",
      cycleUpperCap: cycleUpperCap.toString(),
      blockUpperCap,
      maxHostCalls,
      maxColdInstalls,
    });
    if (response.type !== "resident-run-result") {
      throw new Error(`unexpected resident run response ${String(response.type)}`);
    }
    observeRun(window, response.result);
  } while (performance.now() < deadline);
  window.wallMs = performance.now() - started;
  return finalizeWindow(window);
}

async function runInstructionWindow(client, label, targetInstructions) {
  const window = newWindow(label);
  const started = performance.now();
  do {
    const response = await client.request({
      type: "resident-run",
      cycleUpperCap: cycleUpperCap.toString(),
      blockUpperCap,
      maxHostCalls,
      maxColdInstalls,
    });
    if (response.type !== "resident-run-result") {
      throw new Error(`unexpected resident run response ${String(response.type)}`);
    }
    observeRun(window, response.result);
  } while (window.executedInstructions < targetInstructions);
  window.wallMs = performance.now() - started;
  return finalizeWindow(window, targetInstructions);
}

async function main() {
  publish({ status: "initializing", schema: "lazuli-rust-resident-throughput-v1" });
  const [manifest] = await Promise.all([
    fetch("/resident-artifacts/manifest.json", { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`artifact manifest returned HTTP ${response.status}`);
      return response.json();
    }),
    initRenderer("/resident-artifacts/browser_renderer_bg.wasm"),
  ]);
  const renderer = await WebGpuRenderer.create(canvas);
  const worker = new Worker("/web/resident-machine-worker.mjs", { type: "module" });
  const client = new ResidentWorkerClient(worker, renderer);
  try {
    const initializedAt = performance.now();
    const ready = await client.request({
      type: "resident-init",
      artifacts: {
        core: "/resident-artifacts/browser_machine.wasm",
        dispatcher: "/resident-artifacts/resident_dispatcher.wasm",
        coordinator: "/resident-artifacts/core_run_coordinator.wasm",
      },
      disc: { kind: "http-range", url: "/disc" },
    });
    if (ready.type !== "resident-ready") {
      throw new Error(`unexpected resident init response ${String(ready.type)}`);
    }
    const bootWallMs = performance.now() - initializedAt;
    const warmup = instructionProgressMode
      ? await runInstructionWindow(client, "warmup", warmupInstructionTarget)
      : warmupMs === 0
        ? finalizeWindow({ ...newWindow("warmup"), wallMs: 0 })
        : await runWindow(client, "warmup", warmupMs);
    const before = await client.request({ type: "resident-diagnostics" });
    const measurement = instructionProgressMode
      ? await runInstructionWindow(client, "measurement", measurementInstructionTarget)
      : await runWindow(client, "measurement", measureMs);
    const after = await client.request({ type: "resident-diagnostics" });
    const report = Object.freeze({
      status: "complete",
      schema: "lazuli-rust-resident-throughput-v1",
      proof: "Rust/Wasm-resident Rogue Leader CPU throughput; not visual certification",
      environment: {
        userAgent: navigator.userAgent,
        crossOriginIsolated,
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
      policy: {
        transport: "frozen-resident-machine-worker",
        measurementMode: instructionProgressMode ? "fixed-instruction-progress" : "wall-window",
        warmupMs,
        measureMs,
        warmupInstructionTarget: warmupInstructionTarget?.toString() ?? null,
        measurementInstructionTarget: measurementInstructionTarget?.toString() ?? null,
        cycleUpperCap: cycleUpperCap.toString(),
        blockUpperCap,
        maxHostCalls,
        maxColdInstalls,
      },
      artifacts: manifest,
      boot: { ...ready.boot, wallMs: bootWallMs },
      warmup,
      measurement,
      adapterDiagnostics: { before: before.diagnostics, after: after.diagnostics },
      renderer: {
        calls: client.renderCalls,
        failures: client.renderFailures,
        diagnostics: renderer.diagnostics(),
      },
      browserSemanticArguments: 0,
      javascriptDispatchTableSets: 0,
      workloadDiagnostics: {
        pc: null,
        pcReason: "frozen worker protocol does not expose core_cpu_ptr; not used as policy input",
      },
    });
    publish(report);
    return report;
  } finally {
    client.close();
  }
}

main().catch(error => publish({
  status: "failed",
  schema: "lazuli-rust-resident-throughput-v1",
  error: String(error?.stack ?? error),
}));
