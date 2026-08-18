// SPDX-License-Identifier: GPL-3.0-only

import initRenderer, {
  WebGpuRenderer,
} from "/resident-artifacts/browser_renderer.js";
import {
  FIDELITY_CHECKPOINT_SCHEMA,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  ResidentFidelityCheckpointClient,
} from "/tools/resident_machine_fidelity_checkpoints.mjs";

const REPORT_SCHEMA = "lazuli-rust-resident-first-visible-xfb-evidence-v1";
const HOST_SCHEMA = "lazuli-resident-corpus-host-v1";
const EVIDENCE_LOCK_SCHEMA = "lazuli-resident-renderer-fidelity-evidence-lock-v2";
const PRODUCTION_EVIDENCE_LOCK_SCHEMA =
  "lazuli-resident-renderer-fidelity-evidence-lock-v3";
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CAPTURE_ORDER = Object.freeze([
  "opaque-request-copied-and-hashed",
  "pre-submit-durable",
  "submit-resident-render-returned",
  "submit-returned-durable",
  "submit-resident-render-resolved",
  "receipt-resolved-durable",
  "first-presented-xfb-transition",
  "renderer-diagnostics-before-capture",
  "renderer-drain-resolved",
  "renderer-health-checked-before-readback",
  "presented-xfb-rgba-readback-resolved",
  "renderer-health-checked-after-readback",
  "renderer-diagnostics-after-capture",
  "opaque-receipt-and-rgba-hashed",
  "opaque-receipt-posted-to-worker",
  "enclosing-resident-run-result-accepted",
]);
const PRODUCTION_CAPTURE_ORDER = Object.freeze([
  ...CAPTURE_ORDER.slice(0, 14),
  "first-frame-renderer-owned-durable",
  ...CAPTURE_ORDER.slice(14),
]);
const PRODUCTION_CAPTURE_STATE_SCHEMA =
  "lazuli-production-fidelity-capture-state-v1";

const resultElement = document.querySelector("#result");
const canvas = document.querySelector("#display");
const parameters = new URL(location.href).searchParams;
let activeFidelityCheckpointClient = null;
let orphanRendererProbeFailure = null;
let pageFidelityCheckpointClient = null;
let pageFidelityCheckpointWorker = null;
let activeProductionCapture = null;
let pageProductionContext = null;

// The feature-gated renderer calls this exact six-u32 hook. It is deliberately total and treats
// all six values as opaque; interpretation belongs to Rust and offline evidence review.
globalThis.__lazuliResidentRenderProbe = function (...words) {
  try {
    if (activeFidelityCheckpointClient === null) {
      throw new Error("renderer probe event arrived without an active fidelity checkpoint run");
    }
    activeFidelityCheckpointClient.rendererProbeEvent(...words);
  } catch (error) {
    try {
      if (activeFidelityCheckpointClient === null) {
        orphanRendererProbeFailure ??= error;
      } else {
        activeFidelityCheckpointClient.noteProbeRelayFailure(error);
      }
    } catch {
      // The Rust probe import is diagnostic and must never receive a JavaScript exception.
    }
  }
};

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = parameters.get(name);
  const value = Number(raw === null ? fallback : raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boundedBigInt(name, fallback, maximum = 1_000_000_000_000n) {
  const raw = parameters.get(name) ?? fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = BigInt(raw);
  if (value > maximum) throw new Error(`${name} exceeds the evidence bound`);
  return value;
}

const productionCaptureRequested = captureFidelityRequested();
const executedCycleUpperCapDefault = productionCaptureRequested
  ? PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP
  : "250000000";
const totalColdInstallMaximum = productionCaptureRequested
  ? PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP
  : 65_535;
const policy = Object.freeze({
  transport: "frozen-resident-machine-worker",
  evidenceMode: "first-renderer-owned-presented-xfb",
  instructionUpperCap: boundedBigInt("instructionCap", "100000000"),
  executedCycleUpperCap: boundedBigInt("executedCycleCap", executedCycleUpperCapDefault),
  sliceCycleUpperCap: BigInt(boundedInteger("sliceCycleCap", 1_000_000, 1, 1_000_000)),
  blockUpperCap: boundedInteger("blockCap", 16_384, 1, 16_384),
  totalHostCallCap: boundedInteger("hostCallCap", 65_535, 1, 65_535),
  totalColdInstallCap: boundedInteger(
    "coldInstallCap",
    totalColdInstallMaximum,
    1,
    totalColdInstallMaximum,
  ),
  maxBootReads: boundedInteger("bootReadCap", 8_192, 1, 65_535),
  bootTimeoutMs: boundedInteger("bootTimeoutMs", 180_000, 1_000, 600_000),
  sliceTimeoutMs: boundedInteger("sliceTimeoutMs", 180_000, 1_000, 600_000),
  runTimeoutMs: boundedInteger("runTimeoutMs", 600_000, 1_000, 1_800_000),
  zeroProgressSliceCap: boundedInteger("zeroProgressSliceCap", 4_096, 1, 65_535),
});

const fidelityCheckpointPolicy = Object.freeze({
  schema: FIDELITY_CHECKPOINT_SCHEMA,
  hook: "globalThis.__lazuliResidentRenderProbe",
  opaqueProbeWords: 6,
  checkpointTimeoutMs: boundedInteger("checkpointTimeoutMs", 10_000, 1_000, 60_000),
  checkpointRecordCap: boundedInteger("checkpointRecordCap", 65_535, 1, 65_535),
  probeEventCap: boundedInteger("probeEventCap", 32_768, 1, 32_768),
  probeEventPerSubmissionCap: 402,
});

function json(value) {
  return JSON.stringify(
    value,
    (_key, item) => typeof item === "bigint" ? item.toString() : item,
    2,
  );
}

function publish(value) {
  globalThis.__residentFirstFrameEvidence = value;
  resultElement.textContent = json(value);
}

function captureFidelityRequested() {
  const values = parameters.getAll("capture");
  if (values.length === 0) return false;
  if (values.length === 1 && values[0] === "fidelity") return true;
  throw new Error("capture must be exactly fidelity when supplied");
}

function requireExactProductionQuery(gameKey) {
  const entries = [...parameters.entries()];
  if (
    entries.length !== 2
    || parameters.getAll("capture").length !== 1
    || parameters.get("capture") !== "fidelity"
    || parameters.getAll("game").length !== 1
    || parameters.get("game") !== gameKey
    || entries.some(([key]) => key !== "capture" && key !== "game")
  ) {
    throw new Error("production capture query must be exactly capture=fidelity and its locked game");
  }
}

function ownedBytes(value, label) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error(`${label} was not bytes`);
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

function canonicalFidelityJson(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFidelityJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalFidelityJson(value[key])}`
  ).join(",")}}`;
}

function decodeCanonicalBase64(value, expectedBytes, label) {
  if (typeof value !== "string") throw new Error(`${label} payload is not base64 text`);
  let decoded;
  try {
    decoded = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  } catch (error) {
    throw new Error(`${label} base64 is invalid: ${String(error)}`);
  }
  if (decoded.byteLength !== expectedBytes || base64(decoded) !== value) {
    throw new Error(`${label} is not canonical padded base64 with ${expectedBytes} bytes`);
  }
  return decoded;
}

async function canonicalArtifact(value) {
  const bytes = new TextEncoder().encode(canonicalFidelityJson(value));
  return Object.freeze({ bytes: bytes.byteLength, sha256: await sha256(bytes) });
}

async function rawArtifact(bytes) {
  const owned = ownedBytes(bytes, "capture artifact");
  if (owned.byteLength === 0) throw new Error("capture artifact was empty");
  return Object.freeze({ bytes: owned.byteLength, sha256: await sha256(owned) });
}

async function opaqueEnvelopeArtifacts(envelope, expectedBytes, label) {
  if (envelope.available !== true) throw new Error(`${label} was unavailable`);
  const opaque = decodeCanonicalBase64(envelope.payload, expectedBytes, label);
  return Object.freeze({
    envelope: await canonicalArtifact(envelope),
    opaque: await rawArtifact(opaque),
  });
}

function copiedRunSummary(value, label, accepted = null) {
  const expected = [
    "accepted",
    "consecutiveZeroProgressSlices",
    "elapsedWallMs",
    "issuedRunCalls",
    "maximumConsecutiveZeroProgressSlices",
    "operatorPublications",
    "reportedColdInstalls",
    "reportedExecutedCycles",
    "reportedExecutedInstructions",
    "reportedHostCalls",
    "schema",
    "wallTimeoutMs",
    "witnessPublications",
    "zeroProgressSlices",
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResidentFirstFrameError(`${label} is not an object`, {
      boundary: "capture-run-summary-error",
    });
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ResidentFirstFrameError(`${label} fields changed`, {
      boundary: "capture-run-summary-error",
    });
  }
  if (value.schema !== "lazuli-resident-cumulative-run-summary-v1") {
    throw new ResidentFirstFrameError(`${label} schema changed`, {
      boundary: "capture-run-summary-error",
    });
  }
  for (const field of ["reportedExecutedCycles", "reportedExecutedInstructions"]) {
    if (typeof value[field] !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value[field])) {
      throw new ResidentFirstFrameError(`${label} ${field} changed`, {
        boundary: "capture-run-summary-error",
      });
    }
  }
  for (const field of expected.filter(field => ![
    "accepted", "reportedExecutedCycles", "reportedExecutedInstructions", "schema",
  ].includes(field))) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new ResidentFirstFrameError(`${label} ${field} changed`, {
        boundary: "capture-run-summary-error",
      });
    }
  }
  if (typeof value.accepted !== "boolean" || (accepted !== null && value.accepted !== accepted)) {
    throw new ResidentFirstFrameError(`${label} Accepted state changed`, {
      boundary: "capture-run-summary-error",
    });
  }
  return Object.freeze(structuredClone(value));
}

function base64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.byteLength;
    const hasThird = index + 2 < bytes.byteLength;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const triplet = first << 16 | second << 8 | third;
    encoded += alphabet[triplet >>> 18 & 0x3f];
    encoded += alphabet[triplet >>> 12 & 0x3f];
    encoded += hasSecond ? alphabet[triplet >>> 6 & 0x3f] : "=";
    encoded += hasThird ? alphabet[triplet & 0x3f] : "=";
  }
  return encoded;
}

function copiedOpaqueEnvelope(value, expectedBytes, label, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResidentFirstFrameError(`${label} is not an object`, {
      boundary: "fidelity-protocol-error",
    });
  }
  const keys = Object.keys(value).sort();
  if (keys.join("\n") !== ["available", "bytes", "encoding", "payload"].join("\n")) {
    throw new ResidentFirstFrameError(`${label} keys changed`, {
      boundary: "fidelity-protocol-error",
    });
  }
  if (value.bytes !== expectedBytes || value.encoding !== "base64") {
    throw new ResidentFirstFrameError(`${label} ABI changed`, {
      boundary: "fidelity-protocol-error",
    });
  }
  if (typeof value.available !== "boolean") {
    throw new ResidentFirstFrameError(`${label} availability changed`, {
      boundary: "fidelity-protocol-error",
    });
  }
  if (!value.available) {
    if (required || value.payload !== null) {
      throw new ResidentFirstFrameError(`${label} omitted required opaque bytes`, {
        boundary: "fidelity-protocol-error",
      });
    }
  } else {
    if (typeof value.payload !== "string") {
      throw new ResidentFirstFrameError(`${label} payload changed`, {
        boundary: "fidelity-protocol-error",
      });
    }
    let decoded;
    try {
      const binary = atob(value.payload);
      decoded = Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch (error) {
      throw new ResidentFirstFrameError(`${label} base64 is invalid: ${String(error)}`, {
        boundary: "fidelity-protocol-error",
      });
    }
    if (decoded.byteLength !== expectedBytes || base64(decoded) !== value.payload) {
      throw new ResidentFirstFrameError(`${label} is not exact canonical padded base64`, {
        boundary: "fidelity-protocol-error",
      });
    }
  }
  return Object.freeze({
    available: value.available,
    bytes: value.bytes,
    encoding: value.encoding,
    payload: value.payload,
  });
}

function u32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ResidentFirstFrameError(`${label} is not a u32`, {
      boundary: "controller-normalization-failure",
    });
  }
  return value >>> 0;
}

function byte(value, label) {
  const normalized = u32(value, label);
  if (normalized > 0xff) {
    throw new ResidentFirstFrameError(`${label} is not a byte`, {
      boundary: "controller-normalization-failure",
    });
  }
  return normalized;
}

function normalizedController(value) {
  const expected = [
    "analogA",
    "analogB",
    "buttons",
    "cStickX",
    "cStickY",
    "stickX",
    "stickY",
    "triggerL",
    "triggerR",
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResidentFirstFrameError("operator controller state is not an object", {
      boundary: "controller-normalization-failure",
    });
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ResidentFirstFrameError("operator controller state keys changed", {
      boundary: "controller-normalization-failure",
    });
  }
  const buttons = u32(value.buttons, "controller buttons");
  if (buttons > 0xffff) {
    throw new ResidentFirstFrameError("controller buttons exceed the normalized u16 range", {
      boundary: "controller-normalization-failure",
    });
  }
  const sticks = [
    byte(value.stickX, "controller stickX"),
    byte(value.stickY, "controller stickY"),
    byte(value.cStickX, "controller cStickX"),
    byte(value.cStickY, "controller cStickY"),
  ];
  const triggers = [
    byte(value.triggerL, "controller triggerL"),
    byte(value.triggerR, "controller triggerR"),
    byte(value.analogA, "controller analogA"),
    byte(value.analogB, "controller analogB"),
  ];
  return Object.freeze({
    buttons,
    stickXyCxy: (sticks[0] | sticks[1] << 8 | sticks[2] << 16 | sticks[3] << 24) >>> 0,
    triggerLrab: (
      triggers[0] | triggers[1] << 8 | triggers[2] << 16 | triggers[3] << 24
    ) >>> 0,
  });
}

function copiedFidelityState(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResidentFirstFrameError(`${label} is not an object`, {
      boundary: "fidelity-protocol-error",
    });
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join("\n")
    !== ["machineEvidence", "phase", "record", "requestedController"].join("\n")
  ) {
    throw new ResidentFirstFrameError(`${label} keys changed`, {
      boundary: "fidelity-protocol-error",
    });
  }
  const phase = u32(value.phase, `${label} phase`);
  if (phase > 6) {
    throw new ResidentFirstFrameError(`${label} phase is unknown`, {
      boundary: "fidelity-protocol-error",
    });
  }
  let requestedController = null;
  if (phase === 1) {
    const requested = value.requestedController;
    if (requested === null || typeof requested !== "object" || Array.isArray(requested)) {
      throw new ResidentFirstFrameError(`${label} Baseline omitted requested controller state`, {
        boundary: "fidelity-protocol-error",
      });
    }
    const requestedKeys = Object.keys(requested).sort();
    if (requestedKeys.join("\n") !== ["buttons", "stickXyCxy", "triggerLrab"].join("\n")) {
      throw new ResidentFirstFrameError(`${label} requested controller keys changed`, {
        boundary: "fidelity-protocol-error",
      });
    }
    requestedController = Object.freeze({
      buttons: u32(requested.buttons, `${label} requested buttons`),
      stickXyCxy: u32(requested.stickXyCxy, `${label} requested sticks`),
      triggerLrab: u32(requested.triggerLrab, `${label} requested triggers`),
    });
    if (requestedController.buttons === 0) {
      throw new ResidentFirstFrameError(`${label} Baseline requested zero buttons`, {
        boundary: "fidelity-protocol-error",
      });
    }
  } else if (value.requestedController !== null) {
    throw new ResidentFirstFrameError(`${label} requested controller outside Baseline`, {
      boundary: "fidelity-protocol-error",
    });
  }
  const required = phase === 1 || phase === 5 || phase === 6;
  const record = copiedOpaqueEnvelope(value.record, 384, `${label} record`, required);
  const machineEvidence = copiedOpaqueEnvelope(
    value.machineEvidence,
    816,
    `${label} machine evidence`,
    required,
  );
  return Object.freeze({
    phase,
    requestedController,
    record,
    machineEvidence,
  });
}

function rendererSnapshot(renderer) {
  return structuredClone(renderer.diagnostics());
}

function readbackMetadata(readback) {
  const metadata = {};
  for (const [key, value] of Object.entries(readback)) {
    if (key !== "rgba") metadata[key] = value;
  }
  return structuredClone(metadata);
}

class ResidentFirstFrameError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = "ResidentFirstFrameError";
    this.evidence = evidence;
  }
}

class ResidentWorkerClient {
  constructor(worker, renderer, checkpoints, captureFidelity = false) {
    this.worker = worker;
    this.renderer = renderer;
    this.checkpoints = checkpoints;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.renderCalls = 0;
    this.renderFailures = 0;
    this.rendererOwnedRgbaReadbacks = 0;
    this.firstTransitionCaptures = 0;
    this.firstFrame = null;
    this.captureFailure = null;
    this.captureFidelity = captureFidelity;
    this.firstFrameRgba = null;
    this.firstFrameOwned = null;
    this.fidelityCaptures = new Map();
    this.fidelityObservation = null;
    this.lastFidelityState = null;
    this.controllerSequence = 0n;
    this.lastRendererRelay = null;
    this.closed = false;
    this.lastDiagnostics = null;
    this.machineSessionId = null;
    this.runSummary = null;
    this.firstFrameReportJson = null;
    this.preWitnessMachineEvidence = null;
    this.terminalState = null;
    worker.addEventListener("message", event => this.handle(event.data ?? {}));
    worker.addEventListener("error", event => {
      this.failAll(new ResidentFirstFrameError(event.message, { boundary: "worker-error" }));
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async captureFirstPresentedXfb(
    message,
    receipt,
    requestOrdinal,
    captureStartedAtMs,
    authenticatedRequest,
    resolvedIdentity,
    presentedAfterReturn,
    presentedByResolution,
  ) {
    this.firstTransitionCaptures += 1;
    if (this.firstTransitionCaptures !== 1 || this.firstFrame !== null) {
      throw new ResidentFirstFrameError("more than one first-presented-XFB transition was captured", {
        boundary: "first-transition-cardinality",
        firstTransitionCaptures: this.firstTransitionCaptures,
      });
    }

    const captureOrder = [
      "opaque-request-copied-and-hashed",
      "pre-submit-durable",
      "submit-resident-render-returned",
      "submit-returned-durable",
      "submit-resident-render-resolved",
      "receipt-resolved-durable",
      "first-presented-xfb-transition",
    ];
    const diagnosticsBefore = rendererSnapshot(this.renderer);
    captureOrder.push("renderer-diagnostics-before-capture");
    await this.renderer.drain();
    captureOrder.push("renderer-drain-resolved");
    this.renderer.check_health();
    captureOrder.push("renderer-health-checked-before-readback");
    const readback = await this.renderer.read_presented_xfb_rgba();
    this.rendererOwnedRgbaReadbacks += 1;
    captureOrder.push("presented-xfb-rgba-readback-resolved");
    this.renderer.check_health();
    captureOrder.push("renderer-health-checked-after-readback");
    const diagnosticsAfter = rendererSnapshot(this.renderer);
    captureOrder.push("renderer-diagnostics-after-capture");

    const metadata = readbackMetadata(readback);
    const rgba = ownedBytes(readback?.rgba, "renderer-owned presented XFB RGBA");
    if (this.captureFidelity) this.firstFrameRgba = rgba.slice();
    const [rgbaSha256, receiptSha256, metadataArtifact] = await Promise.all([
      sha256(rgba),
      sha256(receipt),
      canonicalArtifact(metadata),
    ]);
    captureOrder.push("opaque-receipt-and-rgba-hashed");

    if (this.captureFidelity) {
      const rgbaArtifact = Object.freeze({ bytes: rgba.byteLength, sha256: rgbaSha256 });
      const ack = await this.checkpoints.firstFrameRendererOwned({
        ...resolvedIdentity,
        readbackMetadata: metadataArtifact,
        rgba: rgbaArtifact,
      });
      this.firstFrameOwned = Object.freeze({
        identity: Object.freeze({ ...resolvedIdentity }),
        metadata: Object.freeze(structuredClone(metadata)),
        metadataArtifact,
        rgba: rgba.slice(),
        rgbaArtifact,
        checkpointRecordSha256: ack.recordSha256,
      });
      captureOrder.push("first-frame-renderer-owned-durable");
    }

    this.firstFrame = {
      trigger: {
        relayRequestId: message.id,
        renderCallOrdinal: requestOrdinal,
        requestFlags: message.requestFlags >>> 0,
        sequenceLo: message.sequenceLo >>> 0,
        sequenceHi: message.sequenceHi >>> 0,
        opaqueRequestBytes: authenticatedRequest.bytes,
        opaqueRequestSha256: authenticatedRequest.sha256,
      },
      transition: {
        definition: "false-before-call-to-true-by-resolution",
        beforeCall: false,
        afterReturn: presentedAfterReturn,
        byResolution: presentedByResolution,
      },
      captureOrder,
      captureStartedAtMs,
      captureCompletedAtMs: performance.now(),
      diagnosticsBefore,
      diagnosticsAfter,
      readback: {
        metadata,
        rgbaBytes: rgba.byteLength,
        rgbaSha256,
      },
      receipt: {
        bytes: receipt.byteLength,
        sha256: receiptSha256,
        postedToWorker: false,
      },
      acceptedByRust: false,
      acceptance: null,
    };
  }

  async captureFidelityObservation(message) {
    let id = null;
    try {
      if (!this.captureFidelity) {
        throw new ResidentFirstFrameError("fidelity observation arrived outside capture mode", {
          boundary: "fidelity-protocol-error",
        });
      }
      if (this.fidelityObservation !== null) {
        throw new ResidentFirstFrameError("fidelity observations overlapped", {
          boundary: "fidelity-observation-overlap",
        });
      }
      id = u32(message.id, "fidelity observation relay ID");
      if (id === 0) {
        throw new ResidentFirstFrameError("fidelity observation relay ID is zero", {
          boundary: "fidelity-protocol-error",
        });
      }
      const observationIdentity = Object.freeze({
        relayRequestId: id,
        requestFlags: u32(message.requestFlags, "fidelity observation request flags"),
        sequenceLo: u32(message.sequenceLo, "fidelity observation sequence low"),
        sequenceHi: u32(message.sequenceHi, "fidelity observation sequence high"),
      });
      const relay = this.lastRendererRelay;
      if (
        relay === null
        || relay.relayRequestId !== observationIdentity.relayRequestId
        || relay.requestFlags !== observationIdentity.requestFlags
        || relay.sequenceLo !== observationIdentity.sequenceLo
        || relay.sequenceHi !== observationIdentity.sequenceHi
      ) {
        throw new ResidentFirstFrameError(
          "fidelity observation did not match the exact resolved renderer relay",
          { boundary: "fidelity-renderer-identity-mismatch" },
        );
      }
      const state = copiedFidelityState(message.state, "fidelity observation state");
      if (state.phase !== 1 && state.phase !== 5 && state.phase !== 6) {
        throw new ResidentFirstFrameError(`unexpected fidelity observation phase ${state.phase}`, {
          boundary: "fidelity-protocol-error",
        });
      }
      if (this.fidelityCaptures.has(state.phase)) {
        throw new ResidentFirstFrameError(`fidelity phase ${state.phase} was captured twice`, {
          boundary: "fidelity-observation-cardinality",
        });
      }
      if (state.phase === 6) {
        this.lastFidelityState = state;
        this.captureFailure = "Rust GameFidelityV1 entered Failed";
        this.worker.postMessage({
          type: "resident-fidelity-observation-error",
          id,
          error: this.captureFailure,
        });
        return;
      }

      const capture = (async () => {
        const sameFirstReceipt = state.phase === 1
          && this.firstFrameOwned !== null
          && this.firstFrameOwned.identity.receiptRecordSha256 === relay.receiptRecordSha256
          && this.firstFrameOwned.identity.relayRequestId === relay.relayRequestId
          && this.firstFrameOwned.identity.renderCallOrdinal === relay.renderCallOrdinal;
        let metadata;
        let metadataArtifact;
        let rgba;
        let rgbaArtifact;
        if (sameFirstReceipt) {
          metadata = structuredClone(this.firstFrameOwned.metadata);
          metadataArtifact = this.firstFrameOwned.metadataArtifact;
          rgba = this.firstFrameOwned.rgba.slice();
          rgbaArtifact = this.firstFrameOwned.rgbaArtifact;
        } else {
          await this.renderer.drain();
          this.renderer.check_health();
          const readback = await this.renderer.read_presented_xfb_rgba();
          this.rendererOwnedRgbaReadbacks += 1;
          this.renderer.check_health();
          rgba = ownedBytes(
            readback?.rgba,
            `renderer-owned phase-${state.phase} presented XFB RGBA`,
          );
          metadata = readbackMetadata(readback);
          [metadataArtifact, rgbaArtifact] = await Promise.all([
            canonicalArtifact(metadata),
            rawArtifact(rgba),
          ]);
        }
        const fidelity = await opaqueEnvelopeArtifacts(
          state.record,
          384,
          `phase-${state.phase} GameFidelityV1`,
        );
        const machine = await opaqueEnvelopeArtifacts(
          state.machineEvidence,
          816,
          `phase-${state.phase} MachineEvidenceV1`,
        );
        const kind = state.phase === 1
          ? "fidelity-baseline-owned"
          : "fidelity-accepted-owned";
        const checkpoint = await this.checkpoints.fidelityPhaseOwned(kind, {
          ...relay,
          gameFidelityEnvelope: fidelity.envelope,
          gameFidelityOpaque: fidelity.opaque,
          machineEvidenceEnvelope: machine.envelope,
          machineEvidenceOpaque: machine.opaque,
          readbackMetadata: metadataArtifact,
          rgba: rgbaArtifact,
          ...(state.phase === 1 ? {
            requestedButtons: state.requestedController.buttons,
            requestedStickXyCxy: state.requestedController.stickXyCxy,
            requestedTriggerLrab: state.requestedController.triggerLrab,
          } : {}),
        });
        const owned = Object.freeze({
          identity: Object.freeze({
            ...relay,
          }),
          state,
          readback: Object.freeze({
            metadata,
            rgba,
            metadataArtifact,
            rgbaBytes: rgbaArtifact.bytes,
            rgbaSha256: rgbaArtifact.sha256,
          }),
          sameFirstReceipt,
          checkpointRecordSha256: checkpoint.recordSha256,
        });
        this.fidelityCaptures.set(state.phase, owned);
        this.lastFidelityState = state;
        return owned;
      })();
      this.fidelityObservation = capture;
      await capture;
      this.fidelityObservation = null;
      this.worker.postMessage({ type: "resident-fidelity-observation-ack", id });
    } catch (error) {
      this.fidelityObservation = null;
      this.captureFailure = String(error?.stack ?? error);
      if (!this.closed && id !== null) {
        this.worker.postMessage({
          type: "resident-fidelity-observation-error",
          id,
          error: this.captureFailure,
        });
      }
      this.failAll(error);
    }
  }

  async render(message) {
    this.renderCalls += 1;
    const requestOrdinal = this.renderCalls;
    try {
      const presentedBefore = this.renderer.has_presented_xfb();
      if (presentedBefore && this.firstFrame === null) {
        throw new ResidentFirstFrameError(
          "renderer reported a presented XFB before the first transition was captured",
          { boundary: "presented-xfb-preexisted" },
        );
      }
      const source = ownedBytes(message.source, "opaque resident render request");
      const authenticatedRequest = {
        source,
        bytes: source.byteLength,
        sha256: await sha256(source),
      };
      const checkpointIdentity = {
        relayRequestId: message.id,
        renderCallOrdinal: requestOrdinal,
        requestFlags: message.requestFlags >>> 0,
        sequenceLo: message.sequenceLo >>> 0,
        sequenceHi: message.sequenceHi >>> 0,
        opaqueRequestBytes: authenticatedRequest.bytes,
        opaqueRequestSha256: authenticatedRequest.sha256,
        presentedBefore,
      };
      await this.checkpoints.preSubmit(checkpointIdentity);
      const captureStartedAtMs = performance.now();
      const submission = this.renderer.submit_resident_render(
        authenticatedRequest.source,
        message.requestFlags,
        message.sequenceLo,
        message.sequenceHi,
      );
      if (submission === null || typeof submission?.then !== "function") {
        throw new ResidentFirstFrameError(
          "renderer submit method did not synchronously return a Promise",
          { boundary: "renderer-submit-return-contract" },
        );
      }
      const presentedAfterReturn = this.renderer.has_presented_xfb();
      await this.checkpoints.submitReturned(
        checkpointIdentity,
        presentedAfterReturn,
      );
      const receipt = ownedBytes(await submission, "renderer receipt");
      const presentedAfter = this.renderer.has_presented_xfb();
      const receiptSha256 = await sha256(receipt);
      const receiptAck = await this.checkpoints.receiptResolved(
        checkpointIdentity,
        receipt,
        receiptSha256,
        presentedAfter,
      );
      if (this.captureFidelity) {
        this.lastRendererRelay = Object.freeze({
          ...checkpointIdentity,
          receiptBytes: receipt.byteLength,
          receiptSha256,
          presentedAfterResolution: presentedAfter,
          receiptRecordSha256: receiptAck.recordSha256,
        });
      }
      if (!presentedBefore && presentedAfter) {
        await this.captureFirstPresentedXfb(
          message,
          receipt,
          requestOrdinal,
          captureStartedAtMs,
          authenticatedRequest,
          this.lastRendererRelay,
          presentedAfterReturn,
          presentedAfter,
        );
      }
      if (!this.closed) {
        this.worker.postMessage({
          type: "resident-render-receipt",
          id: message.id,
          receipt,
        }, [receipt.buffer]);
        if (
          this.firstFrame !== null
          && this.firstFrame.trigger.renderCallOrdinal === requestOrdinal
        ) {
          this.firstFrame.receipt.postedToWorker = true;
          this.firstFrame.captureOrder.push("opaque-receipt-posted-to-worker");
        }
      }
    } catch (error) {
      this.renderFailures += 1;
      this.captureFailure = String(error?.stack ?? error);
      if (!this.closed) {
        this.worker.postMessage({
          type: "resident-render-error",
          id: message.id,
          error: this.captureFailure,
        });
      }
    }
  }

  confirmEnclosingRunAccepted(response, sliceOrdinal) {
    if (this.firstFrame === null || this.firstFrame.acceptedByRust) return;
    if (!this.firstFrame.receipt.postedToWorker) {
      throw new ResidentFirstFrameError("enclosing run returned before its receipt was posted", {
        boundary: "receipt-ordering-fault",
      });
    }
    const totalRenderCalls = Number(response.diagnostics?.totalRenderCalls);
    if (
      !Number.isSafeInteger(totalRenderCalls)
      || totalRenderCalls < this.firstFrame.trigger.renderCallOrdinal
    ) {
      throw new ResidentFirstFrameError(
        "worker diagnostics did not confirm Rust acceptance of the captured receipt",
        {
          boundary: "receipt-acceptance-unconfirmed",
          diagnosticsTotalRenderCalls: response.diagnostics?.totalRenderCalls ?? null,
        },
      );
    }
    this.firstFrame.acceptedByRust = true;
    this.firstFrame.acceptance = {
      enclosingWorkerRequestId: response.requestId,
      enclosingSliceOrdinal: sliceOrdinal,
      diagnosticsTotalRenderCalls: totalRenderCalls,
      responseType: response.type,
    };
    this.firstFrame.captureOrder.push("enclosing-resident-run-result-accepted");
  }

  async queryFidelityState(label = "resident fidelity state") {
    if (!this.captureFidelity) {
      throw new ResidentFirstFrameError("game fidelity capture is not enabled", {
        boundary: "fidelity-protocol-error",
      });
    }
    const response = await this.request(
      { type: "resident-fidelity-state" },
      label,
      policy.sliceTimeoutMs,
    );
    if (response.type !== "resident-fidelity-state-result") {
      throw new ResidentFirstFrameError(
        `unexpected fidelity state response ${String(response.type)}`,
        { boundary: "worker-protocol-error" },
      );
    }
    const state = copiedFidelityState(response.state, label);
    this.acceptWorkerAuthority(response, label);
    this.lastFidelityState = state;
    if (state.phase === 6) {
      throw new ResidentFirstFrameError("Rust GameFidelityV1 entered Failed", {
        boundary: "game-fidelity-failed",
        opaqueRecord: state.record,
      });
    }
    return state;
  }

  acceptWorkerAuthority(response, label, accepted = null) {
    if (this.machineSessionId === null) {
      throw new ResidentFirstFrameError(`${label} arrived before capture initialization`, {
        boundary: "capture-session-error",
      });
    }
    if (response.machineSessionId !== this.machineSessionId) {
      throw new ResidentFirstFrameError(`${label} changed the Worker machine session`, {
        boundary: "capture-session-error",
      });
    }
    this.runSummary = copiedRunSummary(response.runSummary, `${label} run summary`, accepted);
    return this.runSummary;
  }

  async publishOperatorController() {
    const response = await this.request({
      type: "resident-controller-operator",
    }, "atomic generic operator controller publication", policy.sliceTimeoutMs);
    if (response.type !== "resident-controller-operator-result") {
      throw new ResidentFirstFrameError(
        `unexpected atomic operator response ${String(response.type)}`,
        { boundary: "worker-protocol-error" },
      );
    }
    const status = u32(response.status, "atomic operator status");
    const state = await this.queryFidelityState("post-operator fidelity state");
    return Object.freeze({
      sequenceLo: u32(response.sequenceLo, "operator sequence low"),
      sequenceHi: u32(response.sequenceHi, "operator sequence high"),
      status,
      phase: state.phase,
    });
  }

  async publishRequestedController() {
    const baseline = this.fidelityCaptures.get(1);
    if (this.firstFrameReportJson === null || baseline === undefined) {
      throw new ResidentFirstFrameError("Rust Baseline was lost before witness publication", {
        boundary: "baseline-lost-before-witness",
      });
    }
    const response = await this.request(
      { type: "resident-controller-witness" },
      "atomic Rust-requested fidelity witness publication",
      policy.sliceTimeoutMs,
    );
    if (response.type !== "resident-controller-witness-result") {
      throw new ResidentFirstFrameError(
        `unexpected atomic witness response ${String(response.type)}`,
        { boundary: "worker-protocol-error" },
      );
    }
    this.acceptWorkerAuthority(response, "atomic witness result");
    const state = await this.queryFidelityState("post-witness fidelity state");
    return Object.freeze({
      sequenceLo: u32(response.sequenceLo, "witness sequence low"),
      sequenceHi: u32(response.sequenceHi, "witness sequence high"),
      buttons: u32(response.buttons, "witness buttons"),
      stickXyCxy: u32(response.stickXyCxy, "witness sticks"),
      triggerLrab: u32(response.triggerLrab, "witness triggers"),
      status: u32(response.status, "witness status"),
      phase: state.phase,
    });
  }

  async captureControllerWitness(message) {
    try {
      if (!this.captureFidelity || this.machineSessionId === null) {
        throw new ResidentFirstFrameError("witness checkpoint arrived outside capture", {
          boundary: "fidelity-protocol-error",
        });
      }
      if (message.machineSessionId !== this.machineSessionId) {
        throw new ResidentFirstFrameError("witness checkpoint changed machine session", {
          boundary: "capture-session-error",
        });
      }
      copiedRunSummary(message.runSummary, "witness checkpoint run summary", false);
      const state = copiedFidelityState(message.state, "witness checkpoint state");
      if (state.phase !== 1 || this.firstFrameReportJson === null) {
        throw new ResidentFirstFrameError("witness checkpoint lacked durable Baseline/report", {
          boundary: "baseline-lost-before-witness",
        });
      }
      const machine = await opaqueEnvelopeArtifacts(
        state.machineEvidence,
        816,
        "pre-witness MachineEvidenceV1",
      );
      await this.checkpoints.controllerWitnessPublished({
        sequenceLo: u32(message.sequenceLo, "witness sequence low"),
        sequenceHi: u32(message.sequenceHi, "witness sequence high"),
        buttons: u32(message.buttons, "witness buttons"),
        stickXyCxy: u32(message.stickXyCxy, "witness sticks"),
        triggerLrab: u32(message.triggerLrab, "witness triggers"),
        status: u32(message.status, "witness status"),
        machineEvidenceEnvelope: machine.envelope,
        machineEvidenceOpaque: machine.opaque,
      });
      this.preWitnessMachineEvidence = state.machineEvidence;
      if (!this.closed) {
        this.worker.postMessage({
          type: "resident-controller-witness-checkpoint-ack",
          requestId: message.requestId,
        });
      }
    } catch (error) {
      this.captureFailure = String(error?.stack ?? error);
      if (!this.closed) {
        this.worker.postMessage({
          type: "resident-controller-witness-checkpoint-error",
          requestId: message.requestId,
          error: this.captureFailure,
        });
      }
      this.failAll(error);
    }
  }

  async stepRun() {
    const response = await this.request(
      { type: "resident-run" },
      "continuous fidelity resident-run",
      policy.sliceTimeoutMs,
    );
    if (response.type !== "resident-run-result") {
      throw new ResidentFirstFrameError(
        `unexpected continuous run response ${String(response.type)}`,
        { boundary: "worker-protocol-error" },
      );
    }
    if (response.result?.boundary === "rust") {
      const reason = u32(response.result.outcome?.reason, "continuous Rust stop reason");
      if (reason !== 0) {
        throw new ResidentFirstFrameError(`continuous Rust run stopped with reason ${reason}`, {
          boundary: "rust-stop",
          reason,
          detail: response.result.outcome?.detail ?? null,
        });
      }
    } else if (response.result?.boundary !== "fidelity") {
      throw new ResidentFirstFrameError(
        `continuous run returned unknown boundary ${String(response.result?.boundary)}`,
        { boundary: "unknown-adapter-boundary" },
      );
    }
    this.acceptWorkerAuthority(
      response,
      "continuous fidelity resident-run result",
      response.result.boundary === "fidelity" ? true : false,
    );
    this.confirmEnclosingRunAccepted(response, this.runSummary.issuedRunCalls);
    return this.queryFidelityState("post-continuous-run fidelity state");
  }

  async bindFirstFrameReport(report) {
    if (this.firstFrameReportJson !== null) {
      throw new ResidentFirstFrameError("first-frame report was already bound", {
        boundary: "first-frame-report-cardinality",
      });
    }
    const reportJson = canonicalFidelityJson(report);
    const reportBytes = new TextEncoder().encode(reportJson);
    const machineEvidence = copiedOpaqueEnvelope(
      report.game?.adapterDiagnostics?.final?.machineEvidence,
      816,
      "first-frame report MachineEvidenceV1",
      true,
    );
    const machine = await opaqueEnvelopeArtifacts(
      machineEvidence,
      816,
      "first-frame report MachineEvidenceV1",
    );
    await this.checkpoints.firstFrameReportBound({
      report: { bytes: reportBytes.byteLength, sha256: await sha256(reportBytes) },
      machineEvidenceEnvelope: machine.envelope,
      machineEvidenceOpaque: machine.opaque,
    });
    this.firstFrameReportJson = reportJson;
    return reportJson;
  }

  captureState(gameKey) {
    if (this.machineSessionId === null || this.firstFrameReportJson === null) {
      throw new ResidentFirstFrameError("production capture is not ready", {
        boundary: "capture-not-ready",
      });
    }
    const baseline = this.fidelityCaptures.get(1) ?? null;
    const accepted = this.fidelityCaptures.get(5) ?? null;
    const current = this.terminalState ?? this.lastFidelityState;
    return Object.freeze({
      schema: PRODUCTION_CAPTURE_STATE_SCHEMA,
      gameKey,
      phase: current?.phase ?? 0,
      machineSessionId: this.machineSessionId,
      runSummary: structuredClone(this.runSummary),
      machineEvidence: current?.machineEvidence ?? null,
      gameFidelity: current?.record ?? null,
      artifacts: Object.freeze({
        readyMachineEvidence: this.readyMachineEvidence,
        firstFrameReportJson: this.firstFrameReportJson,
        firstVisibleRgbaBase64: base64(this.firstFrameOwned.rgba),
        baselineGameFidelityRecord: baseline?.state.record ?? null,
        baselineMachineEvidence: baseline?.state.machineEvidence ?? null,
        baselineMetadata: baseline?.readback.metadata ?? null,
        baselineRgbaBase64: baseline === null ? null : base64(baseline.readback.rgba),
        preWitnessMachineEvidence: this.preWitnessMachineEvidence,
        terminalGameFidelityRecord: this.terminalState?.record ?? null,
        terminalMachineEvidence: this.terminalState?.machineEvidence ?? null,
        acceptedMetadata: accepted?.readback.metadata ?? null,
        acceptedRgbaBase64: accepted === null ? null : base64(accepted.readback.rgba),
      }),
    });
  }

  async finishCapture() {
    const accepted = this.fidelityCaptures.get(5);
    if (accepted === undefined) {
      throw new ResidentFirstFrameError("finish requires durable Accepted ownership", {
        boundary: "accepted-not-owned",
      });
    }
    const state = await this.queryFidelityState("terminal Accepted fidelity state");
    if (
      state.phase !== 5
      || canonicalFidelityJson(state.record) !== canonicalFidelityJson(accepted.state.record)
      || canonicalFidelityJson(state.machineEvidence)
        !== canonicalFidelityJson(accepted.state.machineEvidence)
    ) {
      throw new ResidentFirstFrameError("terminal opaque artifacts changed after Accepted", {
        boundary: "terminal-artifact-drift",
      });
    }
    const fidelity = await opaqueEnvelopeArtifacts(
      state.record,
      384,
      "terminal GameFidelityV1",
    );
    const machine = await opaqueEnvelopeArtifacts(
      state.machineEvidence,
      816,
      "terminal MachineEvidenceV1",
    );
    await this.checkpoints.fidelityTerminal({
      gameFidelityEnvelope: fidelity.envelope,
      gameFidelityOpaque: fidelity.opaque,
      machineEvidenceEnvelope: machine.envelope,
      machineEvidenceOpaque: machine.opaque,
      runSummary: this.runSummary,
    });
    this.terminalState = state;
    const capture = this.captureState(this.gameKey);
    await this.closeMachine();
    return capture;
  }

  async closeMachine() {
    if (this.closed) return;
    const response = await this.request(
      { type: "resident-close" },
      "resident capture close",
      policy.sliceTimeoutMs,
    );
    if (response.type !== "resident-closed") {
      throw new ResidentFirstFrameError("resident capture close protocol changed", {
        boundary: "worker-protocol-error",
      });
    }
    this.closed = true;
    this.worker.terminate();
    this.failAll(new ResidentFirstFrameError("resident fidelity capture closed"));
  }

  handle(message) {
    if (message.type === "resident-render-request") {
      void this.render(message);
      return;
    }
    if (message.type === "resident-fidelity-observation") {
      void this.captureFidelityObservation(message);
      return;
    }
    if (message.type === "resident-controller-witness-checkpoint") {
      void this.captureControllerWitness(message);
      return;
    }
    if (message.diagnostics) this.lastDiagnostics = message.diagnostics;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.type === "resident-error") {
      pending.reject(new ResidentFirstFrameError(String(message.error), {
        boundary: "worker-protocol-error",
      }));
    } else {
      pending.resolve(message);
    }
  }

  request(message, label = message.type, timeoutMs = policy.sliceTimeoutMs) {
    if (this.closed) throw new ResidentFirstFrameError("resident worker is closed");
    const requestId = this.nextRequestId++;
    if (!Number.isSafeInteger(requestId)) throw new Error("worker request id exhausted");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ResidentFirstFrameError(`${label} exceeded ${timeoutMs} ms`, {
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
    this.failAll(new ResidentFirstFrameError("resident first-frame worker closed"));
  }
}

function newRunEvidence() {
  return {
    wallMs: 0,
    slices: 0,
    rustBoundaries: 0,
    rustStopBoundaries: 0,
    instructionCapBoundaries: 0,
    executedCycleCapBoundaries: 0,
    hostCallCapBoundaries: 0,
    coldInstallCapBoundaries: 0,
    workerTimeoutBoundaries: 0,
    zeroProgressCapBoundaries: 0,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    servicedHostCalls: 0,
    coldInstalls: 0,
    executedCycles: 0n,
    executedInstructions: 0n,
    outcomeDetails: Object.create(null),
  };
}

function finalizedRun(run, complete, goalReached) {
  const seconds = run.wallMs / 1_000;
  return Object.freeze({
    ...run,
    complete,
    goalReached,
    executedCycles: run.executedCycles.toString(),
    executedInstructions: run.executedInstructions.toString(),
    instructionUpperCap: policy.instructionUpperCap.toString(),
    executedCycleUpperCap: policy.executedCycleUpperCap.toString(),
    instructionsPerSecond: seconds === 0 ? 0 : Number(run.executedInstructions) / seconds,
    cyclesPerSecond: seconds === 0 ? 0 : Number(run.executedCycles) / seconds,
  });
}

function capFailure(run, boundary, message) {
  run[`${boundary}Boundaries`] += 1;
  throw new ResidentFirstFrameError(message, {
    boundary: boundary.replace(/([A-Z])/g, "-$1").toLowerCase(),
    unobservablePartialRustCounters: false,
  });
}

function observeRustRun(run, result) {
  const hostCallDelta = Number(result.hostCalls ?? 0);
  const coldInstallDelta = Number(result.coldInstalls ?? 0);
  run.slices += 1;
  run.servicedHostCalls += hostCallDelta;
  run.coldInstalls += coldInstallDelta;
  if (result.boundary !== "rust") {
    if (result.boundary === "host-call-cap") {
      run.hostCallCapBoundaries += 1;
    } else if (result.boundary === "cold-install-cap") {
      run.coldInstallCapBoundaries += 1;
    } else {
      throw new ResidentFirstFrameError(
        `unknown adapter boundary ${String(result.boundary)}`,
        { boundary: "unknown-adapter-boundary" },
      );
    }
    throw new ResidentFirstFrameError(
      `${result.boundary} reached; partial Rust counters are not observable`,
      {
        boundary: result.boundary,
        unobservablePartialRustCounters: true,
        hostCalls: hostCallDelta,
        coldInstalls: coldInstallDelta,
      },
    );
  }

  run.rustBoundaries += 1;
  const reason = Number(result.outcome.reason);
  const detail = Number(result.outcome.detail);
  if (reason !== 0) {
    run.rustStopBoundaries += 1;
    throw new ResidentFirstFrameError(
      `Rust resident run stopped with reason ${reason}, detail ${detail}`,
      { boundary: "rust-stop", reason, detail },
    );
  }
  const cycleDelta = BigInt(result.outcome.executedCycles);
  const instructionDelta = BigInt(result.outcome.executedInstructions);
  run.executedCycles += cycleDelta;
  run.executedInstructions += instructionDelta;
  const key = String(detail);
  run.outcomeDetails[key] = (run.outcomeDetails[key] ?? 0) + 1;
  if (
    instructionDelta === 0n
    && cycleDelta === 0n
    && hostCallDelta === 0
    && coldInstallDelta === 0
  ) {
    run.zeroProgressSlices += 1;
    run.consecutiveZeroProgressSlices += 1;
    run.maximumConsecutiveZeroProgressSlices = Math.max(
      run.maximumConsecutiveZeroProgressSlices,
      run.consecutiveZeroProgressSlices,
    );
    if (run.consecutiveZeroProgressSlices >= policy.zeroProgressSliceCap) {
      run.zeroProgressCapBoundaries += 1;
      throw new ResidentFirstFrameError(
        `zero-progress slice cap ${policy.zeroProgressSliceCap} reached`,
        { boundary: "zero-progress-slice-cap", unobservablePartialRustCounters: false },
      );
    }
  } else {
    run.consecutiveZeroProgressSlices = 0;
  }
}

async function runUntilFirstPresentedXfb(client) {
  const run = newRunEvidence();
  const started = performance.now();
  try {
    while (!client.firstFrame?.acceptedByRust) {
      const elapsed = performance.now() - started;
      if (elapsed >= policy.runTimeoutMs) {
        run.workerTimeoutBoundaries += 1;
        throw new ResidentFirstFrameError(
          `first presented XFB run exceeded ${policy.runTimeoutMs} ms`,
          { boundary: "run-timeout", unobservablePartialRustCounters: false },
        );
      }
      if (run.executedInstructions >= policy.instructionUpperCap) {
        capFailure(run, "instructionCap", "instruction upper cap reached before first presented XFB");
      }
      if (run.executedCycles >= policy.executedCycleUpperCap) {
        capFailure(
          run,
          "executedCycleCap",
          "executed-cycle upper cap reached before first presented XFB",
        );
      }
      if (run.servicedHostCalls >= policy.totalHostCallCap) {
        capFailure(run, "hostCallCap", "total host-call cap reached before accepted evidence");
      }
      if (run.coldInstalls >= policy.totalColdInstallCap) {
        capFailure(run, "coldInstallCap", "total cold-install cap reached before accepted evidence");
      }

      const remainingCycles = policy.executedCycleUpperCap - run.executedCycles;
      const requestedCycles = remainingCycles < policy.sliceCycleUpperCap
        ? remainingCycles
        : policy.sliceCycleUpperCap;
      const remainingHostCalls = policy.totalHostCallCap - run.servicedHostCalls;
      const remainingColdInstalls = policy.totalColdInstallCap - run.coldInstalls;
      const remainingWallMs = Math.max(1, Math.ceil(policy.runTimeoutMs - elapsed));
      const requestTimeoutMs = Math.min(policy.sliceTimeoutMs, remainingWallMs);
      const response = await client.request({
        type: "resident-run",
        cycleUpperCap: requestedCycles.toString(),
        blockUpperCap: policy.blockUpperCap,
        maxHostCalls: remainingHostCalls,
        maxColdInstalls: remainingColdInstalls,
      }, "first-presented-XFB resident-run", requestTimeoutMs);
      if (response.type !== "resident-run-result") {
        throw new ResidentFirstFrameError(
          `unexpected resident run response ${String(response.type)}`,
          { boundary: "worker-protocol-error" },
        );
      }
      if (client.captureFidelity) {
        client.acceptWorkerAuthority(
          response,
          "first-presented-XFB resident-run result",
          response.result.boundary === "fidelity" ? true : false,
        );
      }
      observeRustRun(run, response.result);
      client.confirmEnclosingRunAccepted(response, run.slices);
      if (client.captureFidelity) {
        await client.queryFidelityState("post-run-boundary fidelity state");
      }

      if (run.executedInstructions > policy.instructionUpperCap) {
        capFailure(run, "instructionCap", "instruction upper cap was crossed by the last slice");
      }
      if (run.executedCycles > policy.executedCycleUpperCap) {
        capFailure(run, "executedCycleCap", "executed-cycle upper cap was crossed by the last slice");
      }
      if (run.servicedHostCalls > policy.totalHostCallCap) {
        capFailure(run, "hostCallCap", "total host-call cap was crossed by the last slice");
      }
      if (run.coldInstalls > policy.totalColdInstallCap) {
        capFailure(run, "coldInstallCap", "total cold-install cap was crossed by the last slice");
      }
      if (performance.now() - started > policy.runTimeoutMs) {
        run.workerTimeoutBoundaries += 1;
        throw new ResidentFirstFrameError(
          "first presented XFB completed outside the fixed wall-time bound",
          { boundary: "run-timeout", unobservablePartialRustCounters: false },
        );
      }
    }
    run.wallMs = performance.now() - started;
    return finalizedRun(run, true, true);
  } catch (error) {
    run.wallMs = performance.now() - started;
    if (error instanceof ResidentFirstFrameError) {
      if (error.evidence.boundary === "worker-request-timeout") {
        run.workerTimeoutBoundaries += 1;
      }
      error.evidence.partialRun = finalizedRun(
        run,
        false,
        client.firstFrame?.acceptedByRust === true,
      );
    }
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function fetchEvidenceLock() {
  const response = await fetch("/resident-fidelity/evidence-lock.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`fidelity evidence lock returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const lock = JSON.parse(new TextDecoder().decode(bytes));
  if (lock?.schema !== EVIDENCE_LOCK_SCHEMA
      && lock?.schema !== PRODUCTION_EVIDENCE_LOCK_SCHEMA) {
    throw new Error("invalid fidelity evidence lock schema");
  }
  return Object.freeze({ lock, sha256: await sha256(bytes) });
}

function requireEvidenceLockMatchesPage(evidence, hostManifest, artifactManifest, game) {
  const lock = evidence.lock;
  const production = lock.schema === PRODUCTION_EVIDENCE_LOCK_SCHEMA;
  const canonical = value => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  };
  const exact = (actual, expected, label) => {
    if (canonical(actual) !== canonical(expected)) {
      throw new Error(`fidelity evidence lock changed ${label}`);
    }
  };
  exact(lock.selectedGame, production ? {
    key: game.key,
    priority: game.priority,
    bytes: game.bytes,
    image: {
      format: "ciso",
      sha256: game.sha256,
    },
    disc: lock.selectedGame.disc,
  } : {
    key: game.key,
    priority: game.priority,
    bytes: game.bytes,
    sha256: game.sha256,
  }, "selected game");
  exact(lock.corpus.sha256, hostManifest.sourceCorpusSha256, "corpus SHA-256");
  exact(lock.artifacts, artifactManifest.artifacts, "served artifacts");
  const expectedRunPolicy = {
    instructionUpperCap: policy.instructionUpperCap.toString(),
    executedCycleUpperCap: policy.executedCycleUpperCap.toString(),
    sliceCycleUpperCap: policy.sliceCycleUpperCap.toString(),
    blockUpperCap: policy.blockUpperCap,
    totalHostCallCap: policy.totalHostCallCap,
    totalColdInstallCap: policy.totalColdInstallCap,
    maxBootReads: policy.maxBootReads,
    bootTimeoutMs: policy.bootTimeoutMs,
    sliceTimeoutMs: policy.sliceTimeoutMs,
    runTimeoutMs: policy.runTimeoutMs,
    externalWallTimeoutMs: 600_000,
    zeroProgressSliceCap: policy.zeroProgressSliceCap,
  };
  if (production) expectedRunPolicy.workerUrl = lock.release?.executionAssets?.worker?.url;
  exact(lock.runPolicy, expectedRunPolicy, "run policy");
  exact(lock.checkpointPolicy, {
    checkpointTimeoutMs: fidelityCheckpointPolicy.checkpointTimeoutMs,
    checkpointRecordCap: fidelityCheckpointPolicy.checkpointRecordCap,
    probeEventRunCap: fidelityCheckpointPolicy.probeEventCap,
    probeEventPerSubmissionCap: fidelityCheckpointPolicy.probeEventPerSubmissionCap,
    opaqueProbeWords: fidelityCheckpointPolicy.opaqueProbeWords,
    fsyncEveryRecord: true,
  }, "checkpoint policy");
  exact(lock.hostPolicy, {
    transport: hostManifest.transport.kind,
    maxRangeBytes: hostManifest.transport.maxRangeBytes,
    semanticArguments: hostManifest.transport.semanticArguments,
    checkpointBodyCap: 4_096,
  }, "host policy");
  exact(lock.machineEvidence, {
    abiVersion: 1,
    byteLength: 816,
    wordLength: 204,
    tag: "LZME",
    encoding: "base64",
    browserWordInterpretations: 0,
  }, "machine evidence policy");
  if (production) {
    exact(lock.run, { runId: lock.run.runId, gameKey: game.key }, "run identity");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(lock.run.runId)) {
      throw new Error("fidelity evidence lock has an invalid run UUID");
    }
    exact(lock.rendererProbe?.defaultHookImports, 0, "default renderer hook imports");
    exact(lock.rendererProbe?.checkpointProbeEvents, 0, "checkpoint probe events");
  }
  return Object.freeze({
    ...evidence,
    production,
    runId: production ? lock.run.runId : crypto.randomUUID(),
    workerUrl: production
      ? lock.release.executionAssets.worker.url
      : "/web/resident-machine-worker.mjs",
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

function transportDelta(before, after, name) {
  return Number(after?.[name] ?? 0) - Number(before?.[name] ?? 0);
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

function selectOneGame(manifest) {
  const requested = parameters.getAll("game");
  if (requested.length !== 1) throw new Error("exactly one game query is required");
  const game = manifest.games.find(candidate => candidate.key === requested[0]);
  if (!game) throw new Error(`unknown game query ${requested[0]}`);
  return game;
}

function failureCounts(error, client, transportBefore, transportAfter) {
  const boundary = error?.evidence?.boundary;
  return {
    rustStops: boundary === "rust-stop" ? 1 : 0,
    instructionCaps: boundary === "instruction-cap" ? 1 : 0,
    executedCycleCaps: boundary === "executed-cycle-cap" ? 1 : 0,
    hostCallCaps: boundary === "host-call-cap" ? 1 : 0,
    coldInstallCaps: boundary === "cold-install-cap" ? 1 : 0,
    workerTimeouts: new Set(["boot-timeout", "worker-request-timeout", "run-timeout"])
      .has(boundary) ? 1 : 0,
    zeroProgressCaps: boundary === "zero-progress-slice-cap" ? 1 : 0,
    invalidRangeRequests: transportDelta(transportBefore, transportAfter, "invalidRangeRequests"),
    preconditionFailures: transportDelta(transportBefore, transportAfter, "preconditionFailures"),
    rendererFailures: client?.renderFailures ?? 0,
  };
}

async function runGame(game, renderer, checkpoints, workerUrl) {
  let transportBefore = null;
  let rendererBefore = null;
  let worker = null;
  let client = null;
  let bootEvidence = null;
  let phase = "transport-baseline";
  let keepMachineAlive = false;
  const productionCapture = pageProductionContext !== null;
  try {
    transportBefore = await transportSnapshot(game.key);
    phase = "renderer-reset";
    renderer.reset();
    renderer.reset_diagnostics();
    if (renderer.has_presented_xfb()) {
      throw new ResidentFirstFrameError("renderer reset retained a presented XFB", {
        boundary: "renderer-reset-fault",
      });
    }
    rendererBefore = rendererSnapshot(renderer);
    phase = "worker-setup";
    worker = new Worker(workerUrl, { type: "module" });
    client = new ResidentWorkerClient(worker, renderer, checkpoints, productionCapture);
    client.gameKey = game.key;
    phase = "initialization";
    const bootStartedAtMs = performance.now();
    const ready = await client.request({
      type: "resident-init",
      artifacts: {
        core: "/resident-artifacts/browser_machine.wasm",
        dispatcher: "/resident-artifacts/resident_dispatcher.wasm",
        coordinator: "/resident-artifacts/core_run_coordinator.wasm",
      },
      disc: { kind: "http-range", url: game.rangeUrl },
      ...(productionCapture ? {
        captureFidelity: true,
        runPolicy: structuredClone(pageProductionContext.lock.runPolicy),
      } : { maxBootReads: policy.maxBootReads }),
    }, "resident-init/boot", policy.bootTimeoutMs);
    if (ready.type !== "resident-ready") {
      throw new ResidentFirstFrameError(
        `unexpected resident init response ${String(ready.type)}`,
        { boundary: "worker-protocol-error" },
      );
    }
    const bootWallMs = performance.now() - bootStartedAtMs;
    bootEvidence = { ...ready.boot, wallMs: bootWallMs };
    if (productionCapture) {
      if (
        typeof ready.machineSessionId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(ready.machineSessionId)
      ) {
        throw new ResidentFirstFrameError("capture Worker omitted its cryptographic session UUID", {
          boundary: "capture-session-error",
        });
      }
      const readyState = copiedFidelityState(ready.fidelityState, "ready fidelity state");
      if (readyState.phase !== 0 || readyState.machineEvidence.available !== true) {
        throw new ResidentFirstFrameError("capture Worker was not ready in exact Unarmed state", {
          boundary: "capture-ready-state-error",
        });
      }
      if (
        canonicalFidelityJson(ready.diagnostics?.machineEvidence)
        !== canonicalFidelityJson(readyState.machineEvidence)
      ) {
        throw new ResidentFirstFrameError(
          "capture ready diagnostics changed the retained MachineEvidenceV1 snapshot",
          { boundary: "capture-ready-state-error" },
        );
      }
      client.machineSessionId = ready.machineSessionId;
      client.readyMachineEvidence = readyState.machineEvidence;
      client.lastFidelityState = readyState;
      client.runSummary = copiedRunSummary(ready.runSummary, "ready run summary", false);
      if (client.runSummary.issuedRunCalls !== 0) {
        throw new ResidentFirstFrameError("capture Worker ran before ready ownership", {
          boundary: "capture-ready-state-error",
        });
      }
      const readyMachine = await opaqueEnvelopeArtifacts(
        readyState.machineEvidence,
        816,
        "ready MachineEvidenceV1",
      );
      await checkpoints.captureMachineInitialized({
        machineSessionId: client.machineSessionId,
        bootStatus: u32(ready.boot.status, "capture boot status"),
        bootReads: u32(ready.boot.reads, "capture boot reads"),
        machineEvidenceEnvelope: readyMachine.envelope,
        machineEvidenceOpaque: readyMachine.opaque,
        runPolicy: structuredClone(pageProductionContext.lock.runPolicy),
        runSummary: client.runSummary,
      });
    }
    if (bootWallMs > policy.bootTimeoutMs) {
      throw new ResidentFirstFrameError(
        `resident boot completed after the fixed ${policy.bootTimeoutMs} ms deadline`,
        {
          boundary: "boot-timeout",
          bootWallMs,
          unobservablePartialRustCounters: false,
        },
      );
    }
    phase = "first-presented-xfb";
    const run = await runUntilFirstPresentedXfb(client);
    phase = "final-diagnostics";
    const final = await client.request(
      { type: "resident-diagnostics" },
      "final resident diagnostics",
      policy.sliceTimeoutMs,
    );
    if (final.type !== "resident-diagnostics-result") {
      throw new ResidentFirstFrameError(
        `unexpected final diagnostics response ${String(final.type)}`,
        { boundary: "worker-protocol-error" },
      );
    }
    if (
      client.firstTransitionCaptures !== 1
      || client.firstFrame === null
      || client.firstFrame.acceptedByRust !== true
      || client.firstFrame.captureOrder.join("\n")
        !== (productionCapture ? PRODUCTION_CAPTURE_ORDER : CAPTURE_ORDER).join("\n")
    ) {
      throw new ResidentFirstFrameError("first presented XFB evidence was not exactly complete", {
        boundary: "first-frame-incomplete",
        firstTransitionCaptures: client.firstTransitionCaptures,
      });
    }
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
      boot: bootEvidence,
      run,
      firstPresentedXfb: structuredClone(client.firstFrame),
      firstTransitionCaptures: client.firstTransitionCaptures,
      adapterDiagnostics: {
        ready: ready.diagnostics,
        final: final.diagnostics,
      },
      residentTotals: {
        bootPhysicalReads: ready.boot.reads,
        diPhysicalReads: final.diagnostics.totalDiReads,
        coldInstalls: final.diagnostics.totalColdInstalls,
        renderCalls: final.diagnostics.totalRenderCalls,
      },
      transport: {
        before: transportBefore,
        after: transportAfter,
        snapshotUnavailable: false,
      },
      renderer: {
        resetBeforeGame: true,
        diagnosticsResetBeforeGame: true,
        calls: client.renderCalls,
        failures: client.renderFailures,
        before: rendererBefore,
        after: rendererSnapshot(renderer),
      },
      faults: {
        rustStops: run.rustStopBoundaries,
        instructionCaps: run.instructionCapBoundaries,
        executedCycleCaps: run.executedCycleCapBoundaries,
        hostCallCaps: run.hostCallCapBoundaries,
        coldInstallCaps: run.coldInstallCapBoundaries,
        workerTimeouts: run.workerTimeoutBoundaries,
        zeroProgressCaps: run.zeroProgressCapBoundaries,
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
        rendererFailures: client.renderFailures,
      },
      inputSamples: 0,
      fidelityCheckpoints: checkpoints.summary(),
    };
    if (productionCapture) {
      keepMachineAlive = true;
      activeProductionCapture = Object.freeze({ client, game, renderer });
    }
    return report;
  } catch (error) {
    const typedError = error instanceof ResidentFirstFrameError
      ? error
      : new ResidentFirstFrameError(String(error?.stack ?? error), {
          boundary: `${phase}-failure`,
        });
    let transportAfter = transportBefore;
    let snapshotUnavailable = transportBefore === null;
    try {
      transportAfter = await transportSnapshot(game.key);
    } catch {
      snapshotUnavailable = true;
    }
    const stableTransportBefore = transportBefore ?? transportAfter;
    let rendererAfter = null;
    try {
      rendererAfter = rendererSnapshot(renderer);
    } catch {
      // A renderer setup or device failure may make diagnostics unavailable.
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
      error: String(typedError.stack ?? typedError),
      boundaryEvidence: typedError.evidence,
      boot: bootEvidence,
      firstPresentedXfb: client?.firstFrame == null
        ? null
        : structuredClone(client.firstFrame),
      firstTransitionCaptures: client?.firstTransitionCaptures ?? 0,
      captureFailure: client?.captureFailure ?? null,
      lastAdapterDiagnostics: client?.lastDiagnostics ?? null,
      transport: {
        before: stableTransportBefore,
        after: transportAfter,
        snapshotUnavailable,
      },
      renderer: {
        resetBeforeGame: rendererBefore !== null,
        diagnosticsResetBeforeGame: rendererBefore !== null,
        calls: client?.renderCalls ?? 0,
        failures: client?.renderFailures ?? 0,
        before: rendererBefore,
        after: rendererAfter,
      },
      faults: failureCounts(
        typedError,
        client,
        stableTransportBefore,
        transportAfter,
      ),
      inputSamples: 0,
      fidelityCheckpoints: checkpoints.summary(),
    };
  } finally {
    if (!keepMachineAlive) {
      if (client !== null) client.close();
      else if (worker !== null) worker.terminate();
    }
  }
}

function installProductionCaptureApi(client, game) {
  if (globalThis.lazuliProductionFidelityCapture !== undefined) {
    throw new Error("production fidelity capture API was already installed");
  }
  let operationTail = Promise.resolve();
  let terminal = false;
  const serialize = (operation) => {
    if (terminal) return Promise.reject(new Error("production fidelity capture is terminal"));
    const result = operationTail.then(operation);
    operationTail = result;
    return result;
  };
  const state = () => client.captureState(game.key);
  globalThis.lazuliProductionFidelityCapture = Object.freeze({
    snapshot: () => serialize(async () => state()),
    step: () => serialize(async () => {
      await client.stepRun();
      return state();
    }),
    operator: (...arguments_) => serialize(async () => {
      if (arguments_.length !== 0) {
        throw new Error("production fidelity operator derives its state inside the Worker");
      }
      await client.publishOperatorController();
      return state();
    }),
    publishWitness: () => serialize(async () => {
      await client.publishRequestedController();
      return state();
    }),
    finish: () => serialize(async () => {
      const result = await client.finishCapture();
      terminal = true;
      activeFidelityCheckpointClient = null;
      pageFidelityCheckpointClient.close();
      return result;
    }),
    abort: async () => {
      if (terminal) return;
      terminal = true;
      try {
        await client.closeMachine();
      } catch {
        client.close();
      }
      activeFidelityCheckpointClient = null;
      pageFidelityCheckpointClient.close();
    },
  });
}

async function main() {
  publish({ status: "initializing", schema: REPORT_SCHEMA });
  const [hostManifest, artifactManifest, rawEvidenceLock] = await Promise.all([
    fetchJson("/resident-corpus/manifest.json").then(validateHostManifest),
    fetchJson("/resident-artifacts/manifest.json"),
    fetchEvidenceLock(),
  ]);
  const game = selectOneGame(hostManifest);
  const evidenceLock = requireEvidenceLockMatchesPage(
    rawEvidenceLock,
    hostManifest,
    artifactManifest,
    game,
  );
  const captureRequested = productionCaptureRequested;
  if (evidenceLock.production) {
    requireExactProductionQuery(game.key);
    pageProductionContext = Object.freeze({ lock: evidenceLock.lock });
  } else if (captureRequested) {
    throw new Error("continuous fidelity capture requires a production v3 evidence lock");
  }
  const fidelityRunId = evidenceLock.runId;
  pageFidelityCheckpointWorker = new Worker(
    "/tools/resident_machine_fidelity_checkpoint_worker.mjs",
    { type: "module" },
  );
  pageFidelityCheckpointClient = new ResidentFidelityCheckpointClient(
    pageFidelityCheckpointWorker,
    {
      runId: fidelityRunId,
      gameKey: game.key,
      evidenceLockSha256: evidenceLock.sha256,
      timeoutMs: fidelityCheckpointPolicy.checkpointTimeoutMs,
      recordCap: fidelityCheckpointPolicy.checkpointRecordCap,
      probeEventCap: fidelityCheckpointPolicy.probeEventCap,
    },
  );
  activeFidelityCheckpointClient = pageFidelityCheckpointClient;
  if (orphanRendererProbeFailure !== null) {
    pageFidelityCheckpointClient.noteProbeRelayFailure(orphanRendererProbeFailure);
    orphanRendererProbeFailure = null;
  }
  try {
    await initRenderer("/resident-artifacts/browser_renderer_bg.wasm");
    const renderer = await WebGpuRenderer.create(canvas);
    publish({
      status: "running",
      schema: REPORT_SCHEMA,
      currentGame: game.key,
      fidelityRunId,
      phase: "boot-and-first-presented-xfb",
    });
    const gameReport = await runGame(
      game,
      renderer,
      pageFidelityCheckpointClient,
      evidenceLock.workerUrl,
    );
    const finalReport = Object.freeze({
      status: gameReport.status,
      schema: REPORT_SCHEMA,
      proof: "First renderer-owned GPU-completed presented XFB only; not pixel interpretation, visual certification, or playability",
      environment: {
        userAgent: navigator.userAgent,
        crossOriginIsolated,
        hardwareConcurrency: navigator.hardwareConcurrency,
      },
      policy: {
        ...policy,
        instructionUpperCap: policy.instructionUpperCap.toString(),
        executedCycleUpperCap: policy.executedCycleUpperCap.toString(),
        sliceCycleUpperCap: policy.sliceCycleUpperCap.toString(),
      },
      fidelityCheckpointPolicy,
      evidenceLock: {
        schema: evidenceLock.lock.schema,
        sha256: evidenceLock.sha256,
      },
      artifacts: artifactManifest,
      corpus: {
        sourceCorpusSha256: hostManifest.sourceCorpusSha256,
        selectedGameKey: game.key,
      },
      game: gameReport,
      capabilityBoundary: {
        rawPhysicalRangesOnly: true,
        canonicalRendererReceiptsOnly: true,
        rendererOwnedRgbaReadbacks: gameReport.firstPresentedXfb === null
          ? 0
          : (evidenceLock.production
            ? activeProductionCapture.client.rendererOwnedRgbaReadbacks
            : 1),
        rawGuestMemoryReadbacks: 0,
        pixelMeaningInferences: 0,
        inputSamples: 0,
        browserSemanticArguments: 0,
        javascriptDispatchTableSets: 0,
        javascriptContainerParsers: 0,
        rendererProbeWordsInterpreted: 0,
        rawSixU32RendererProbeRelayOnly: true,
        machineEvidenceWordsInterpretedInBrowser: 0,
        opaqueMachineEvidenceTransportOnly: true,
        memoryViewsReacquiredByFrozenAdapterAfterAwait: true,
        ...(evidenceLock.production ? { rendererProbeEventsExpected: 0 } : {}),
      },
      captureOrderContract: evidenceLock.production ? PRODUCTION_CAPTURE_ORDER : CAPTURE_ORDER,
    });
    if (evidenceLock.production) {
      if (finalReport.status !== "complete" || activeProductionCapture === null) {
        throw new Error("production capture did not reach its frozen first-frame prefix");
      }
      await activeProductionCapture.client.bindFirstFrameReport(finalReport);
      installProductionCaptureApi(activeProductionCapture.client, game);
    }
    publish(finalReport);
    return finalReport;
  } finally {
    if (!evidenceLock.production || globalThis.lazuliProductionFidelityCapture === undefined) {
      activeFidelityCheckpointClient = null;
      pageFidelityCheckpointClient.close();
      if (activeProductionCapture !== null) activeProductionCapture.client.close();
    }
  }
}

main().catch(error => publish({
  status: "failed",
  schema: REPORT_SCHEMA,
  error: String(error?.stack ?? error),
  fidelityCheckpointPolicy,
  fidelityCheckpoints: pageFidelityCheckpointClient?.summary() ?? null,
}));
