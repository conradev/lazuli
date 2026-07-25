#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

export const GAME_COMPATIBILITY_RUNTIME_SCHEMA =
  "lazuli-game-compatibility-runtime-v1";

const HEX_U32_PATTERN = /^0x[0-9a-f]{8}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LOCAL_DISC_SOURCE_KINDS = new Set([
  "local-file",
  "logical-range-endpoint",
]);
const CRITICAL_EXCEPTION_VECTORS = [
  "0x0200",
  "0x0300",
  "0x0400",
  "0x0600",
  "0x0700",
];
const DEVICE_FAILURE_EVENTS = [
  "diskDeviceError",
  "diskRequestError",
  "dspAxCommandRejected",
  "dspUcodeBootRejected",
  "dspZeldaCommandRejected",
];
const DECODER_FAILURE_COUNTERS = [
  "displayListErrors",
  "droppedVertices",
  "exactRequiredCaptureMisses",
  "legacyProjectionNullVertices",
  "lightingRejectedVertices",
  "texgenFallbacks",
  "unknownOpcodes",
  "vertexDecodeErrors",
];
function oracleFailure(path, message) {
  throw new Error(`invalid game compatibility evidence at ${path}: ${message}`);
}

function requiredObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    oracleFailure(path, "expected an object");
  }
  return value;
}

function requiredArray(value, path) {
  if (!Array.isArray(value)) oracleFailure(path, "expected an array");
  return value;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    oracleFailure(path, "expected a non-empty string");
  }
  return value;
}

function requirePattern(value, pattern, path, description) {
  requiredString(value, path);
  if (!pattern.test(value)) oracleFailure(path, `expected ${description}`);
  return value;
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    oracleFailure(path, "expected a non-negative safe integer");
  }
  return value;
}

function requirePositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    oracleFailure(path, "expected a positive safe integer");
  }
  return value;
}

function requireZero(value, path) {
  if (value !== 0 && value !== undefined) {
    oracleFailure(path, `expected zero or absence, got ${JSON.stringify(value)}`);
  }
}

function requireExact(value, expected, path) {
  if (value !== expected) {
    oracleFailure(path, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireGame(game) {
  requiredObject(game, "$.game");
  requiredString(game.key, "$.game.key");
  const image = requiredObject(game.image, "$.game.image");
  requireExact(image.format, "ciso", "$.game.image.format");
  requirePattern(
    image.sha256,
    SHA256_PATTERN,
    "$.game.image.sha256",
    "a lowercase SHA-256 digest",
  );
  const disc = requiredObject(game.disc, "$.game.disc");
  requirePattern(
    disc.identifier,
    /^[A-Z0-9]{6}$/,
    "$.game.disc.identifier",
    "a six-character uppercase disc identifier",
  );
  requireNonNegativeInteger(disc.revision, "$.game.disc.revision");
  return game;
}

function requireLoopbackDiscEndpoint(value, path) {
  let url;
  try {
    url = new URL(value);
  } catch {
    oracleFailure(path, "expected an absolute loopback URL");
  }
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/disc"
    || url.search !== ""
    || url.hash !== ""
  ) {
    oracleFailure(path, "expected the exact loopback /disc endpoint");
  }
}

function verifyEnvironment(environment, game) {
  requiredObject(environment, "$.environment");
  if (environment.surface !== "local-debug" && environment.surface !== "public-root") {
    oracleFailure("$.environment.surface", "expected local-debug or public-root");
  }
  const dataset = requiredObject(environment.dataset, "$.environment.dataset");
  requireExact(dataset.status, "running", "$.environment.dataset.status");
  requireExact(dataset.renderer, "wgpu-webgpu", "$.environment.dataset.renderer");
  const exceptions = requiredArray(
    environment.devtoolsExceptions,
    "$.environment.devtoolsExceptions",
  );
  if (exceptions.length !== 0) {
    oracleFailure("$.environment.devtoolsExceptions[0]", "expected no DevTools exceptions");
  }
  const discImage = requiredObject(
    environment.discImage,
    "$.environment.discImage",
  );
  requireExact(
    discImage.algorithm,
    "sha256",
    "$.environment.discImage.algorithm",
  );
  requireExact(
    discImage.format,
    game.image.format,
    "$.environment.discImage.format",
  );
  requireExact(
    discImage.sha256,
    game.image.sha256,
    "$.environment.discImage.sha256",
  );
  return environment.surface;
}

function verifyDisc(report, game, surface) {
  const disc = requiredObject(report.disc, "$.report.disc");
  requireExact(
    disc.identifier,
    game.disc.identifier,
    "$.report.disc.identifier",
  );
  requireExact(disc.revision, game.disc.revision, "$.report.disc.revision");
  const source = requiredObject(disc.source, "$.report.disc.source");
  if (!LOCAL_DISC_SOURCE_KINDS.has(source.kind)) {
    oracleFailure(
      "$.report.disc.source.kind",
      "expected a private local-file or loopback logical-range source",
    );
  }
  if (surface === "public-root" && source.kind !== "local-file") {
    oracleFailure(
      "$.report.disc.source.kind",
      "the public root must use a local file upload",
    );
  }
  if (source.kind === "logical-range-endpoint") {
    if (surface !== "local-debug") {
      oracleFailure(
        "$.report.disc.source.kind",
        "logical range sources are local-debug only",
      );
    }
    requireLoopbackDiscEndpoint(source.url, "$.report.disc.source.url");
  }
}

function verifyRendererSync(report) {
  const sync = requiredObject(
    report.execution?.scheduler?.rendererSync,
    "$.report.execution.scheduler.rendererSync",
  );
  const posted = requirePositiveInteger(
    sync.posted,
    "$.report.execution.scheduler.rendererSync.posted",
  );
  requireExact(
    sync.acknowledged,
    posted,
    "$.report.execution.scheduler.rendererSync.acknowledged",
  );
  for (const name of ["failed", "inFlight", "resultMisses"]) {
    requireZero(
      sync[name],
      `$.report.execution.scheduler.rendererSync.${name}`,
    );
  }
  const highWater = requirePositiveInteger(
    sync.highWater,
    "$.report.execution.scheduler.rendererSync.highWater",
  );
  if (highWater > 1) {
    oracleFailure(
      "$.report.execution.scheduler.rendererSync.highWater",
      "expected at most one renderer operation in flight",
    );
  }
}

function verifyDeviceHealth(report) {
  const events = requiredObject(report.deviceEvents, "$.report.deviceEvents");
  requirePositiveInteger(events.diskRead, "$.report.deviceEvents.diskRead");
  requirePositiveInteger(events.serialPoll, "$.report.deviceEvents.serialPoll");
  requirePositiveInteger(events.viField, "$.report.deviceEvents.viField");
  for (const name of DEVICE_FAILURE_EVENTS) {
    requireZero(events[name], `$.report.deviceEvents.${name}`);
  }

  const exceptions = requiredObject(report.exceptions, "$.report.exceptions");
  const counts = requiredObject(exceptions.counts, "$.report.exceptions.counts");
  for (const vector of CRITICAL_EXCEPTION_VECTORS) {
    requireZero(counts[vector], `$.report.exceptions.counts.${vector}`);
  }

  const diskCommands = requiredObject(report.diskCommands, "$.report.diskCommands");
  requireExact(
    diskCommands.lastError,
    "0x00000000",
    "$.report.diskCommands.lastError",
  );
  const controller = requiredObject(report.controller, "$.report.controller");
  requireZero(
    controller.queueOverflows,
    "$.report.controller.queueOverflows",
  );
  requireNonNegativeInteger(
    controller.appliedSequence,
    "$.report.controller.appliedSequence",
  );
  const serial = requiredObject(
    report.serialInterface,
    "$.report.serialInterface",
  );
  requireZero(
    serial.unknownOutputCommands,
    "$.report.serialInterface.unknownOutputCommands",
  );
}

function verifyGx(report) {
  const gx = requiredObject(report.gxFifo, "$.report.gxFifo");
  requirePositiveInteger(gx.bytes, "$.report.gxFifo.bytes");
  const staging = requiredObject(gx.staging, "$.report.gxFifo.staging");
  requirePositiveInteger(staging.drains, "$.report.gxFifo.staging.drains");
  requireZero(staging.emergencyDrains, "$.report.gxFifo.staging.emergencyDrains");
  requireZero(staging.pendingBytes, "$.report.gxFifo.staging.pendingBytes");

  const decoder = requiredObject(gx.decoder, "$.report.gxFifo.decoder");
  for (const name of ["commands", "primitives", "xfbCopyCount", "framesPresented"]) {
    requirePositiveInteger(decoder[name], `$.report.gxFifo.decoder.${name}`);
  }
  for (const name of DECODER_FAILURE_COUNTERS) {
    requireZero(decoder[name], `$.report.gxFifo.decoder.${name}`);
  }
  const maximum = requirePositiveInteger(
    decoder.maximumBufferedBytes,
    "$.report.gxFifo.decoder.maximumBufferedBytes",
  );
  const buffered = requireNonNegativeInteger(
    decoder.bufferedBytes,
    "$.report.gxFifo.decoder.bufferedBytes",
  );
  const watermark = requirePositiveInteger(
    decoder.capacityWatermarkBytes,
    "$.report.gxFifo.decoder.capacityWatermarkBytes",
  );
  const preDecode = requireNonNegativeInteger(
    decoder.preDecodeHighWaterBytes,
    "$.report.gxFifo.decoder.preDecodeHighWaterBytes",
  );
  const retryAt = requirePositiveInteger(
    decoder.retryAtBufferedBytes,
    "$.report.gxFifo.decoder.retryAtBufferedBytes",
  );
  if (
    buffered > maximum
    || watermark < buffered
    || watermark > maximum
    || preDecode < buffered
    || preDecode > watermark
    || retryAt > maximum
    || (buffered > 0 && retryAt <= buffered)
  ) {
    oracleFailure(
      "$.report.gxFifo.decoder",
      "decoder carry is not a bounded incomplete command tail",
    );
  }
  const textures = requiredObject(
    decoder.textures,
    "$.report.gxFifo.decoder.textures",
  );
  for (const name of ["decodeErrors", "tlutErrors"]) {
    requireZero(textures[name], `$.report.gxFifo.decoder.textures.${name}`);
  }
}

function verifyWebGpu(report) {
  const rendering = requiredObject(report.rendering, "$.report.rendering");
  requireExact(rendering.backend, "wgpu-webgpu", "$.report.rendering.backend");
  if (rendering.error !== undefined && rendering.error !== null) {
    oracleFailure("$.report.rendering.error", "expected no renderer error");
  }
  const metrics = requiredObject(
    rendering.metrics,
    "$.report.rendering.metrics",
  );
  requireExact(
    metrics.scope,
    "current-worker",
    "$.report.rendering.metrics.scope",
  );
  const operations = requiredObject(
    metrics.operations,
    "$.report.rendering.metrics.operations",
  );
  requireZero(
    operations.pending,
    "$.report.rendering.metrics.operations.pending",
  );
  const highWater = requirePositiveInteger(
    operations.highWater,
    "$.report.rendering.metrics.operations.highWater",
  );
  if (highWater > 1) {
    oracleFailure(
      "$.report.rendering.metrics.operations.highWater",
      "expected at most one queued WebGPU operation",
    );
  }
  const webgpu = requiredObject(
    metrics.webgpu,
    "$.report.rendering.metrics.webgpu",
  );
  for (const name of [
    "checkHealthCalls",
    "copyXfbCalls",
    "drainCalls",
    "presentXfbCalls",
  ]) {
    requirePositiveInteger(
      webgpu[name],
      `$.report.rendering.metrics.webgpu.${name}`,
    );
  }
  requireZero(
    webgpu.exactRequiredRejectedDraws,
    "$.report.rendering.metrics.webgpu.exactRequiredRejectedDraws",
  );
  const reasons = requiredObject(
    webgpu.exactRequiredRejectionReasons,
    "$.report.rendering.metrics.webgpu.exactRequiredRejectionReasons",
  );
  for (const [name, count] of Object.entries(reasons)) {
    requireZero(
      count,
      `$.report.rendering.metrics.webgpu.exactRequiredRejectionReasons.${name}`,
    );
  }
  return rendering;
}

function verifySelectedXfb(report, rendering) {
  const selected = requiredObject(
    rendering.selectedXfb,
    "$.report.rendering.selectedXfb",
  );
  const vi = requiredObject(
    report.mmioState?.viInterruptModel,
    "$.report.mmioState.viInterruptModel",
  );
  const presentationCount = requirePositiveInteger(
    vi.hostPresentationCount,
    "$.report.mmioState.viInterruptModel.hostPresentationCount",
  );
  const expected = {
    address: requirePattern(
      vi.lastHostPresentationAddress,
      HEX_U32_PATTERN,
      "$.report.mmioState.viInterruptModel.lastHostPresentationAddress",
      "a lowercase 32-bit hexadecimal address",
    ),
    generation: requirePositiveInteger(
      vi.lastHostPresentationCopyIndex,
      "$.report.mmioState.viInterruptModel.lastHostPresentationCopyIndex",
    ),
    row: requireNonNegativeInteger(
      vi.lastHostPresentationCopyRow,
      "$.report.mmioState.viInterruptModel.lastHostPresentationCopyRow",
    ),
    pairEpoch: requirePositiveInteger(
      vi.lastHostPresentationPairEpoch,
      "$.report.mmioState.viInterruptModel.lastHostPresentationPairEpoch",
    ),
    serial: requirePositiveInteger(
      vi.lastHostPresentationSerial,
      "$.report.mmioState.viInterruptModel.lastHostPresentationSerial",
    ),
  };
  if (expected.row > 1) {
    oracleFailure(
      "$.report.mmioState.viInterruptModel.lastHostPresentationCopyRow",
      "expected field row 0 or 1",
    );
  }
  for (const name of ["address", "generation", "row", "pairEpoch"]) {
    requireExact(
      selected[name],
      expected[name],
      `$.report.rendering.selectedXfb.${name}`,
    );
  }
  if (selected.presentationSerial !== undefined) {
    requireExact(
      selected.presentationSerial,
      expected.serial,
      "$.report.rendering.selectedXfb.presentationSerial",
    );
  }

  const width = requirePositiveInteger(
    selected.width,
    "$.report.rendering.selectedXfb.width",
  );
  const height = requirePositiveInteger(
    selected.height,
    "$.report.rendering.selectedXfb.height",
  );
  requireExact(
    selected.format,
    "rgba8unorm",
    "$.report.rendering.selectedXfb.format",
  );
  requireExact(
    selected.layout,
    "top-left-row-major-tight",
    "$.report.rendering.selectedXfb.layout",
  );
  requireExact(
    selected.rgbaByteLength,
    width * height * 4,
    "$.report.rendering.selectedXfb.rgbaByteLength",
  );
  requirePattern(
    selected.rgbaSha256,
    SHA256_PATTERN,
    "$.report.rendering.selectedXfb.rgbaSha256",
    "a lowercase SHA-256 digest",
  );
  requirePattern(
    selected.rgbSha256,
    SHA256_PATTERN,
    "$.report.rendering.selectedXfb.rgbSha256",
    "a lowercase SHA-256 digest",
  );
  const rgb = requiredObject(
    selected.rgb,
    "$.report.rendering.selectedXfb.rgb",
  );
  const black = requireNonNegativeInteger(
    rgb.black,
    "$.report.rendering.selectedXfb.rgb.black",
  );
  const white = requireNonNegativeInteger(
    rgb.white,
    "$.report.rendering.selectedXfb.rgb.white",
  );
  const other = requirePositiveInteger(
    rgb.other,
    "$.report.rendering.selectedXfb.rgb.other",
  );
  if (black + white + other !== width * height) {
    oracleFailure(
      "$.report.rendering.selectedXfb.rgb",
      "RGB populations must cover the complete selected XFB",
    );
  }
  if (requirePositiveInteger(
    rgb.unique,
    "$.report.rendering.selectedXfb.rgb.unique",
  ) < 2) {
    oracleFailure(
      "$.report.rendering.selectedXfb.rgb.unique",
      "expected at least two RGB values",
    );
  }
  return { expected, presentationCount, selected };
}

function progressProjection(report, selected, presentationCount) {
  return Object.freeze({
    controllerAppliedSequence: report.controller.appliedSequence,
    cycles: report.cycles,
    diskReads: report.deviceEvents.diskRead,
    dispatches: report.dispatches,
    gxCommands: report.gxFifo.decoder.commands,
    hostPresentations: presentationCount,
    instructions: report.instructions,
    primitives: report.gxFifo.decoder.primitives,
    rendererPresents: report.rendering.metrics.webgpu.presentXfbCalls,
    rgbSha256: selected.rgbSha256,
    siPolls: report.deviceEvents.serialPoll,
    viFields: report.deviceEvents.viField,
    xfbCopies: report.gxFifo.decoder.xfbCopyCount,
  });
}

export function verifyGameCompatibilitySnapshot({ environment, game, report }) {
  requireGame(game);
  const surface = verifyEnvironment(environment, game);
  requiredObject(report, "$.report");
  requireExact(report.status, "running", "$.report.status");
  requireExact(report.stage, "snapshot", "$.report.stage");
  if (report.error !== undefined && report.error !== null) {
    oracleFailure("$.report.error", "expected no terminal error");
  }
  verifyDisc(report, game, surface);
  for (const name of ["cycles", "dispatches", "instructions"]) {
    requirePositiveInteger(report[name], `$.report.${name}`);
  }
  verifyRendererSync(report);
  verifyDeviceHealth(report);
  verifyGx(report);
  const rendering = verifyWebGpu(report);
  const { presentationCount, selected } = verifySelectedXfb(report, rendering);
  return Object.freeze({
    game: game.key,
    image: game.image.sha256,
    progress: progressProjection(report, selected, presentationCount),
    schema: GAME_COMPATIBILITY_RUNTIME_SCHEMA,
    surface,
  });
}
