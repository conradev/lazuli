// SPDX-License-Identifier: GPL-3.0-only

import initRenderer, {
  WebGpuRenderer,
} from "/resident-artifacts/browser_renderer.js";

const REPORT_SCHEMA = "lazuli-rust-resident-corpus-evidence-v1";
const HOST_SCHEMA = "lazuli-resident-corpus-host-v1";
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const resultElement = document.querySelector("#result");
const canvas = document.querySelector("#display");
const parameters = new URL(location.href).searchParams;

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = parameters.get(name);
  const value = Number(raw === null ? fallback : raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function instructionTarget(name, fallback) {
  const raw = parameters.get(name) ?? fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = BigInt(raw);
  if (value > 1_000_000_000_000n) throw new Error(`${name} exceeds the evidence bound`);
  return value;
}

function booleanParameter(name, fallback) {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${name} must be 0 or 1`);
}

const compatibilityRequestTimeoutMs = boundedInteger(
  "requestTimeoutMs",
  120_000,
  1_000,
  600_000,
);
const policy = Object.freeze({
  transport: "frozen-resident-machine-worker",
  measurementMode: "fixed-instruction-progress",
  warmupInstructionTarget: instructionTarget("warmupInstructions", "1000000"),
  measurementInstructionTarget: instructionTarget("measureInstructions", "5000000"),
  cycleUpperCap: BigInt(boundedInteger("cycleCap", 1_000_000, 1, 1_000_000)),
  blockUpperCap: boundedInteger("blockCap", 16_384, 1, 16_384),
  maxHostCalls: boundedInteger("hostCallCap", 65_535, 1, 65_535),
  maxColdInstalls: boundedInteger("coldInstallCap", 65_535, 1, 65_535),
  maxBootReads: boundedInteger("bootReadCap", 8_192, 1, 65_535),
  bootTimeoutMs: boundedInteger(
    "bootTimeoutMs",
    compatibilityRequestTimeoutMs,
    1_000,
    600_000,
  ),
  sliceTimeoutMs: boundedInteger(
    "sliceTimeoutMs",
    compatibilityRequestTimeoutMs,
    1_000,
    600_000,
  ),
  windowTimeoutMs: boundedInteger("windowTimeoutMs", 120_000, 1_000, 600_000),
  zeroProgressSliceCap: boundedInteger("zeroProgressSliceCap", 4_096, 1, 65_535),
  continueOnFailure: booleanParameter("continueOnFailure", true),
});

function json(value) {
  return JSON.stringify(
    value,
    (_key, item) => typeof item === "bigint" ? item.toString() : item,
    2,
  );
}

function publish(value) {
  globalThis.__residentCorpusEvidence = value;
  resultElement.textContent = json(value);
}

function ownedBytes(value, label) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error(`${label} was not bytes`);
}

class ResidentEvidenceError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = "ResidentEvidenceError";
    this.evidence = evidence;
  }
}

class ResidentWorkerClient {
  constructor(worker, renderer) {
    this.worker = worker;
    this.renderer = renderer;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.renderCalls = 0;
    this.renderFailures = 0;
    this.renderRelays = new Set();
    this.closed = false;
    this.lastDiagnostics = null;
    worker.addEventListener("message", event => this.handle(event.data ?? {}));
    worker.addEventListener("error", event => {
      this.failAll(new ResidentEvidenceError(event.message, { boundary: "worker-error" }));
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
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
      ), "renderer receipt");
      if (!this.closed) {
        this.worker.postMessage({
          type: "resident-render-receipt",
          id: message.id,
          receipt,
        }, [receipt.buffer]);
      }
    } catch (error) {
      this.renderFailures += 1;
      if (!this.closed) {
        this.worker.postMessage({
          type: "resident-render-error",
          id: message.id,
          error: String(error?.stack ?? error),
        });
      }
    }
  }

  handle(message) {
    if (message.type === "resident-render-request") {
      if (this.closed) return;
      const relay = this.render(message);
      this.renderRelays.add(relay);
      void relay.finally(() => this.renderRelays.delete(relay));
      return;
    }
    if (message.diagnostics) this.lastDiagnostics = message.diagnostics;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.type === "resident-error") {
      pending.reject(new ResidentEvidenceError(String(message.error), {
        boundary: "worker-protocol-error",
      }));
    } else {
      pending.resolve(message);
    }
  }

  request(message, label = message.type, timeoutMs = policy.sliceTimeoutMs) {
    if (this.closed) throw new ResidentEvidenceError("resident worker is closed");
    const requestId = this.nextRequestId++;
    if (!Number.isSafeInteger(requestId)) throw new Error("worker request id exhausted");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ResidentEvidenceError(`${label} exceeded ${timeoutMs} ms`, {
          boundary: "worker-request-timeout",
          unobservablePartialRustCounters: true,
        }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage({ ...message, requestId });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.failAll(new ResidentEvidenceError("resident evidence worker closed"));
  }

  async waitForRenderRelays(timeoutMs) {
    if (this.renderRelays.size === 0) return true;
    let timer = null;
    const completed = Promise.allSettled([...this.renderRelays]).then(() => true);
    const timedOut = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = await Promise.race([completed, timedOut]);
    if (timer !== null) clearTimeout(timer);
    return settled;
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
    workerTimeoutBoundaries: 0,
    zeroProgressCapBoundaries: 0,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    rustStopBoundaries: 0,
    servicedHostCalls: 0,
    coldInstalls: 0,
    executedCycles: 0n,
    executedInstructions: 0n,
    outcomeDetails: Object.create(null),
  };
}

function finalizeWindow(window, targetInstructions, complete) {
  const seconds = window.wallMs / 1_000;
  return Object.freeze({
    ...window,
    complete,
    executedCycles: window.executedCycles.toString(),
    executedInstructions: window.executedInstructions.toString(),
    targetInstructions: targetInstructions.toString(),
    instructionOvershoot: complete
      ? (window.executedInstructions - targetInstructions).toString()
      : null,
    targetReached: window.executedInstructions >= targetInstructions,
    cyclesPerSecond: seconds === 0 ? 0 : Number(window.executedCycles) / seconds,
    instructionsPerSecond: seconds === 0 ? 0 : Number(window.executedInstructions) / seconds,
  });
}

function observeRun(window, result) {
  window.slices += 1;
  window.servicedHostCalls += Number(result.hostCalls ?? 0);
  window.coldInstalls += Number(result.coldInstalls ?? 0);
  if (result.boundary === "rust") {
    window.rustBoundaries += 1;
    const reason = Number(result.outcome.reason);
    const detail = Number(result.outcome.detail);
    if (reason !== 0) {
      window.rustStopBoundaries += 1;
      throw new ResidentEvidenceError(
        `Rust resident run stopped with reason ${reason}, detail ${detail}`,
        { boundary: "rust-stop", reason, detail },
      );
    }
    const cycleDelta = BigInt(result.outcome.executedCycles);
    const instructionDelta = BigInt(result.outcome.executedInstructions);
    window.executedCycles += cycleDelta;
    window.executedInstructions += instructionDelta;
    const key = String(detail);
    window.outcomeDetails[key] = (window.outcomeDetails[key] ?? 0) + 1;
    if (instructionDelta === 0n) {
      window.zeroProgressSlices += 1;
      window.consecutiveZeroProgressSlices += 1;
      window.maximumConsecutiveZeroProgressSlices = Math.max(
        window.maximumConsecutiveZeroProgressSlices,
        window.consecutiveZeroProgressSlices,
      );
      if (window.consecutiveZeroProgressSlices >= policy.zeroProgressSliceCap) {
        window.zeroProgressCapBoundaries += 1;
        throw new ResidentEvidenceError(
          `zero-progress slice cap ${policy.zeroProgressSliceCap} reached`,
          { boundary: "zero-progress-slice-cap", unobservablePartialRustCounters: false },
        );
      }
    } else {
      window.consecutiveZeroProgressSlices = 0;
    }
    return;
  }
  if (result.boundary === "host-call-cap") {
    window.hostCallCapBoundaries += 1;
  } else if (result.boundary === "cold-install-cap") {
    window.coldInstallCapBoundaries += 1;
  } else {
    throw new ResidentEvidenceError(`unknown adapter boundary ${String(result.boundary)}`, {
      boundary: "unknown-adapter-boundary",
    });
  }
  throw new ResidentEvidenceError(
    `${result.boundary} reached; partial Rust counters are not observable`,
    {
      boundary: result.boundary,
      unobservablePartialRustCounters: true,
      hostCalls: Number(result.hostCalls ?? 0),
      coldInstalls: Number(result.coldInstalls ?? 0),
    },
  );
}

async function runInstructionWindow(client, label, targetInstructions) {
  const window = newWindow(label);
  const started = performance.now();
  const deadline = started + policy.windowTimeoutMs;
  try {
    while (window.executedInstructions < targetInstructions) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        window.workerTimeoutBoundaries += 1;
        throw new ResidentEvidenceError(
          `${label} exceeded ${policy.windowTimeoutMs} ms before reaching its target`,
          { boundary: "window-timeout", unobservablePartialRustCounters: false },
        );
      }
      const requestTimeoutMs = Math.max(
        1,
        Math.min(policy.sliceTimeoutMs, Math.floor(remainingMs)),
      );
      const response = await client.request({
        type: "resident-run",
        cycleUpperCap: policy.cycleUpperCap.toString(),
        blockUpperCap: policy.blockUpperCap,
        maxHostCalls: policy.maxHostCalls,
        maxColdInstalls: policy.maxColdInstalls,
      }, `${label} resident-run`, requestTimeoutMs);
      if (response.type !== "resident-run-result") {
        throw new ResidentEvidenceError(
          `unexpected resident run response ${String(response.type)}`,
          { boundary: "worker-protocol-error" },
        );
      }
      observeRun(window, response.result);
      if (performance.now() > deadline) {
        window.workerTimeoutBoundaries += 1;
        throw new ResidentEvidenceError(
          `${label} completed a slice after its ${policy.windowTimeoutMs} ms deadline`,
          { boundary: "window-timeout", unobservablePartialRustCounters: false },
        );
      }
    }
    window.wallMs = performance.now() - started;
    return finalizeWindow(window, targetInstructions, true);
  } catch (error) {
    window.wallMs = performance.now() - started;
    if (error instanceof ResidentEvidenceError) {
      if (error.evidence.boundary === "worker-request-timeout") {
        window.workerTimeoutBoundaries += 1;
      }
      error.evidence.partialWindow = finalizeWindow(window, targetInstructions, false);
    }
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchProductionAuthority() {
  const response = await fetch("/resident-authority/evidence-lock.json", { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`production evidence lock returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const lock = JSON.parse(new TextDecoder().decode(bytes));
  if (lock?.schema !== "lazuli-resident-corpus-evidence-lock-v2") {
    throw new Error("invalid production corpus evidence lock schema");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, "0"),
  ).join("");
  return Object.freeze({ lock, sha256 });
}

function requireProductionAuthority(authority, hostManifest, artifactManifest, games) {
  if (authority === null) {
    return Object.freeze({
      workerUrl: "/web/resident-machine-worker.mjs",
      evidenceLock: null,
    });
  }
  const canonical = value => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  };
  const exact = (actual, expected, label) => {
    if (canonical(actual) !== canonical(expected)) {
      throw new Error(`production corpus evidence lock changed ${label}`);
    }
  };
  const { lock } = authority;
  exact(lock.sourceCorpusSha256, hostManifest.sourceCorpusSha256, "corpus SHA-256");
  exact(lock.artifacts, artifactManifest, "served artifacts");
  exact(lock.games, games.map(game => ({
    key: game.key,
    priority: game.priority,
    bytes: game.bytes,
    sha256: game.sha256,
  })), "selected games");
  exact(lock.run.selectedGameKeys, games.map(game => game.key), "run selection");
  exact(lock.runPolicy, {
    transport: policy.transport,
    measurementMode: policy.measurementMode,
    warmupInstructionTarget: policy.warmupInstructionTarget.toString(),
    measurementInstructionTarget: policy.measurementInstructionTarget.toString(),
    cycleUpperCap: policy.cycleUpperCap.toString(),
    blockUpperCap: policy.blockUpperCap,
    maxHostCalls: policy.maxHostCalls,
    maxColdInstalls: policy.maxColdInstalls,
    maxBootReads: policy.maxBootReads,
    bootTimeoutMs: policy.bootTimeoutMs,
    sliceTimeoutMs: policy.sliceTimeoutMs,
    windowTimeoutMs: policy.windowTimeoutMs,
    zeroProgressSliceCap: policy.zeroProgressSliceCap,
    continueOnFailure: policy.continueOnFailure,
    workerUrl: lock.release?.executionAssets?.worker?.url,
  }, "run policy");
  if (!SHA256_PATTERN.test(authority.sha256)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(lock.run.runId)) {
    throw new Error("invalid production corpus authority identity");
  }
  return Object.freeze({
    workerUrl: lock.release.executionAssets.worker.url,
    evidenceLock: {
      schema: lock.schema,
      sha256: authority.sha256,
      runId: lock.run.runId,
    },
  });
}

async function transportSnapshot(key) {
  const snapshot = await fetchJson(
    `/resident-corpus/transport.json?game=${encodeURIComponent(key)}`,
  );
  if (snapshot.schema !== "lazuli-resident-opaque-transport-v1" || snapshot.gameKey !== key) {
    throw new Error(`invalid opaque transport snapshot for ${key}`);
  }
  return snapshot;
}

function rendererSnapshot(renderer) {
  return structuredClone(renderer.diagnostics());
}

function transportDelta(before, after, name) {
  return Number(after?.[name] ?? 0) - Number(before?.[name] ?? 0);
}

function completeFaultCounts(warmup, measurement, transportBefore, transportAfter, rendererFailures) {
  return {
    rustStops: warmup.rustStopBoundaries + measurement.rustStopBoundaries,
    hostCallCaps: warmup.hostCallCapBoundaries + measurement.hostCallCapBoundaries,
    coldInstallCaps: warmup.coldInstallCapBoundaries + measurement.coldInstallCapBoundaries,
    workerTimeouts: warmup.workerTimeoutBoundaries + measurement.workerTimeoutBoundaries,
    zeroProgressCaps: warmup.zeroProgressCapBoundaries + measurement.zeroProgressCapBoundaries,
    invalidRangeRequests: transportDelta(
      transportBefore,
      transportAfter,
      "invalidRangeRequests",
    ),
    preconditionFailures: transportDelta(
      transportBefore,
      transportAfter,
      "preconditionFailures",
    ),
    rendererFailures,
  };
}

async function runGame(game, renderer, workerUrl) {
  let transportBefore = null;
  let rendererBefore = null;
  let rendererReset = false;
  let rendererDiagnosticsReset = false;
  let client = null;
  const started = performance.now();
  let phase = "transport-initialization";
  try {
    transportBefore = await transportSnapshot(game.key);
    phase = "renderer-reset";
    renderer.reset();
    rendererReset = true;
    renderer.reset_diagnostics();
    rendererDiagnosticsReset = true;
    rendererBefore = rendererSnapshot(renderer);
    phase = "worker-initialization";
    const worker = new Worker(workerUrl, { type: "module" });
    client = new ResidentWorkerClient(worker, renderer);
    phase = "boot";
    const ready = await client.request({
      type: "resident-init",
      artifacts: {
        core: "/resident-artifacts/browser_machine.wasm",
        dispatcher: "/resident-artifacts/resident_dispatcher.wasm",
        coordinator: "/resident-artifacts/core_run_coordinator.wasm",
      },
      disc: { kind: "http-range", url: game.rangeUrl },
      maxBootReads: policy.maxBootReads,
    }, "resident-init/boot", policy.bootTimeoutMs);
    if (ready.type !== "resident-ready") {
      throw new ResidentEvidenceError(
        `unexpected resident init response ${String(ready.type)}`,
        { boundary: "worker-protocol-error" },
      );
    }
    const bootWallMs = performance.now() - started;
    phase = "warmup";
    const warmup = await runInstructionWindow(
      client,
      phase,
      policy.warmupInstructionTarget,
    );
    const before = await client.request(
      { type: "resident-diagnostics" },
      "pre-measurement diagnostics",
    );
    phase = "measurement";
    const measurement = await runInstructionWindow(
      client,
      phase,
      policy.measurementInstructionTarget,
    );
    const after = await client.request(
      { type: "resident-diagnostics" },
      "post-measurement diagnostics",
    );
    phase = "transport-finalization";
    const transportAfter = await transportSnapshot(game.key);
    const report = {
      status: "complete",
      game: {
        key: game.key,
        priority: game.priority,
        bytes: game.bytes,
        sha256: game.sha256,
      },
      boot: { ...ready.boot, wallMs: bootWallMs },
      warmup,
      measurement,
      adapterDiagnostics: { before: before.diagnostics, after: after.diagnostics },
      residentTotals: {
        bootPhysicalReads: ready.boot.reads,
        diPhysicalReads: after.diagnostics.totalDiReads,
        coldInstalls: after.diagnostics.totalColdInstalls,
        renderCalls: after.diagnostics.totalRenderCalls,
      },
      transport: {
        before: transportBefore,
        after: transportAfter,
        snapshotUnavailable: false,
      },
      renderer: {
        resetBeforeGame: rendererReset,
        diagnosticsResetBeforeGame: rendererDiagnosticsReset,
        calls: client.renderCalls,
        failures: client.renderFailures,
        before: rendererBefore,
        after: rendererSnapshot(renderer),
      },
      faults: completeFaultCounts(
        warmup,
        measurement,
        transportBefore,
        transportAfter,
        client.renderFailures,
      ),
      inputSamples: 0,
    };
    client.close();
    client = null;
    return report;
  } catch (caught) {
    const error = caught instanceof ResidentEvidenceError
      ? caught
      : new ResidentEvidenceError(String(caught?.stack ?? caught), {
        boundary: `${phase}-failure`,
        unobservablePartialRustCounters: true,
      });
    if (typeof error.evidence.unobservablePartialRustCounters !== "boolean") {
      error.evidence.unobservablePartialRustCounters = false;
    }
    const terminalClient = client;
    terminalClient?.close();
    client = null;
    const rendererRelaysSettled = terminalClient === null
      ? true
      : await terminalClient.waitForRenderRelays(policy.sliceTimeoutMs);
    let transportAfter = transportBefore;
    let transportSnapshotUnavailable = transportBefore === null;
    try {
      transportAfter = await transportSnapshot(game.key);
    } catch {
      transportSnapshotUnavailable = true;
    }
    return {
      status: "failed",
      game: {
        key: game.key,
        priority: game.priority,
        bytes: game.bytes,
        sha256: game.sha256,
      },
      phase,
      error: String(error?.stack ?? error),
      boundaryEvidence: error.evidence,
      lastAdapterDiagnostics: terminalClient?.lastDiagnostics ?? null,
      transport: {
        before: transportBefore,
        after: transportAfter,
        snapshotUnavailable: transportSnapshotUnavailable,
      },
      renderer: {
        resetBeforeGame: rendererReset,
        diagnosticsResetBeforeGame: rendererDiagnosticsReset,
        calls: terminalClient?.renderCalls ?? 0,
        failures: terminalClient?.renderFailures ?? 0,
        relaysSettledBeforeSnapshot: rendererRelaysSettled,
        before: rendererBefore,
        after: rendererRelaysSettled && rendererReset ? rendererSnapshot(renderer) : null,
      },
      faults: {
        rustStops: error?.evidence?.boundary === "rust-stop" ? 1 : 0,
        hostCallCaps: error?.evidence?.boundary === "host-call-cap" ? 1 : 0,
        coldInstallCaps: error?.evidence?.boundary === "cold-install-cap" ? 1 : 0,
        workerTimeouts: new Set(["worker-request-timeout", "window-timeout"])
          .has(error?.evidence?.boundary) ? 1 : 0,
        zeroProgressCaps: error?.evidence?.boundary === "zero-progress-slice-cap" ? 1 : 0,
        invalidRangeRequests: transportDelta(
          transportBefore,
          transportAfter,
          "invalidRangeRequests",
        ),
        preconditionFailures: transportDelta(
          transportBefore,
          transportAfter,
          "preconditionFailures",
        ),
        rendererFailures: terminalClient?.renderFailures ?? 0,
      },
      isolationCompromised: !rendererRelaysSettled,
      inputSamples: 0,
    };
  } finally {
    client?.close();
  }
}

function validateHostManifest(manifest) {
  if (manifest?.schema !== HOST_SCHEMA || !Array.isArray(manifest.games)) {
    throw new Error("invalid resident corpus host manifest");
  }
  const seen = new Set();
  for (const game of manifest.games) {
    if (!KEY_PATTERN.test(game.key) || seen.has(game.key)) throw new Error("invalid game key");
    if (!Number.isSafeInteger(game.priority) || game.priority <= 0) {
      throw new Error(`invalid priority for ${game.key}`);
    }
    if (!Number.isSafeInteger(game.bytes) || game.bytes <= 0) {
      throw new Error(`invalid byte length for ${game.key}`);
    }
    if (!SHA256_PATTERN.test(game.sha256)) throw new Error(`invalid SHA-256 for ${game.key}`);
    const rangeUrl = new URL(game.rangeUrl, location.href);
    if (
      rangeUrl.origin !== location.origin
      || rangeUrl.pathname !== `/resident-corpus/games/${game.key}/disc`
      || rangeUrl.search !== ""
      || rangeUrl.hash !== ""
    ) {
      throw new Error(`invalid opaque range URL for ${game.key}`);
    }
    seen.add(game.key);
  }
  return manifest;
}

function selectGames(manifest) {
  const requested = parameters.getAll("game");
  if (requested.length === 0) return manifest.games;
  if (new Set(requested).size !== requested.length) throw new Error("duplicate game query");
  const games = new Map(manifest.games.map(game => [game.key, game]));
  return requested.map(key => {
    const game = games.get(key);
    if (!game) throw new Error(`unknown game query ${key}`);
    return game;
  });
}

async function main() {
  publish({ status: "initializing", schema: REPORT_SCHEMA });
  const [hostManifest, artifactManifest, rawAuthority] = await Promise.all([
    fetchJson("/resident-corpus/manifest.json").then(validateHostManifest),
    fetchJson("/resident-artifacts/manifest.json"),
    fetchProductionAuthority(),
    initRenderer("/resident-artifacts/browser_renderer_bg.wasm"),
  ]);
  const games = selectGames(hostManifest);
  if (games.length === 0) throw new Error("no games selected");
  const authority = requireProductionAuthority(
    rawAuthority,
    hostManifest,
    artifactManifest,
    games,
  );
  const renderer = await WebGpuRenderer.create(canvas);
  const reports = [];
  for (const game of games) {
    publish({
      status: "running",
      schema: REPORT_SCHEMA,
      currentGame: game.key,
      completedGames: reports.map(report => report.game.key),
    });
    const report = await runGame(game, renderer, authority.workerUrl);
    reports.push(report);
    if (report.isolationCompromised
        || (report.status !== "complete" && !policy.continueOnFailure)) break;
  }
  const completeGames = reports.filter(report => report.status === "complete").length;
  const failedGames = reports.length - completeGames;
  const status = failedGames === 0
    ? "complete"
    : completeGames === 0
      ? "failed"
      : "partial";
  const finalReport = Object.freeze({
    status,
    schema: REPORT_SCHEMA,
    proof: "Generic Rust/Wasm-resident corpus CPU evidence; not visual certification",
    environment: {
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
    },
    policy: {
      ...policy,
      warmupInstructionTarget: policy.warmupInstructionTarget.toString(),
      measurementInstructionTarget: policy.measurementInstructionTarget.toString(),
      cycleUpperCap: policy.cycleUpperCap.toString(),
    },
    artifacts: artifactManifest,
    ...(authority.evidenceLock === null ? {} : { evidenceLock: authority.evidenceLock }),
    corpus: {
      sourceCorpusSha256: hostManifest.sourceCorpusSha256,
      selectedGameKeys: games.map(game => game.key),
    },
    games: reports,
    summary: {
      requestedGames: games.length,
      attemptedGames: reports.length,
      completeGames,
      failedGames,
    },
    capabilityBoundary: {
      rawPhysicalRangesOnly: true,
      canonicalRendererReceiptsOnly: true,
      inputSamples: 0,
      browserSemanticArguments: 0,
      javascriptDispatchTableSets: 0,
      javascriptContainerParsers: 0,
      memoryViewsReacquiredByFrozenAdapterAfterAwait: true,
    },
    rendererDiagnostics: rendererSnapshot(renderer),
  });
  publish(finalReport);
  return finalReport;
}

main().catch(error => publish({
  status: "failed",
  schema: REPORT_SCHEMA,
  error: String(error?.stack ?? error),
}));
