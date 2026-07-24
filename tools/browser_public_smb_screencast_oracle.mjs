// SPDX-License-Identifier: GPL-3.0-only

import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import {
  validateSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";

const REPORT_SCHEMA = "lazuli-public-smb-screencast-v1";
const FRAME_COUNT = 64;
const WIDTH = 1024;
const HEIGHT = 768;
const PIXELS = WIDTH * HEIGHT;
const MAX_FRAME_GAP_MS = 5_000;
const MAX_TAIL_SPAN_MS = 180_000;
const MAX_TERMINAL_TAIL_AGE_MS = 5_000;
// The native 640x448 surface is letterboxed inside the 1024x768 public viewport;
// 850k still classifies a white surface through the black bars and UI chrome.
const EXTREME_PPM = 850_000;

export class PublicSmbScreencastValidationError extends Error {
  constructor(path, detail) {
    super(`public SMB passive screencast evidence is invalid at ${path}: ${detail}`);
    this.name = "PublicSmbScreencastValidationError";
    this.path = path;
  }
}

function fail(path, detail) {
  throw new PublicSmbScreencastValidationError(path, detail);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(object(value, path)).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    fail(path, `keys must be ${canonical.join(", ")}; got ${actual.join(", ")}`);
  }
  return value;
}

function exact(value, expected, path) {
  if (!Object.is(value, expected)) {
    fail(path, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function finite(value, path) {
  if (!Number.isFinite(value)) fail(path, "expected a finite number");
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a non-negative safe integer");
  }
  return value;
}

function positiveInteger(value, path) {
  const result = nonNegativeInteger(value, path);
  if (result === 0) fail(path, "expected a positive safe integer");
  return result;
}

function boundedString(value, path, maximum = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail(path, `expected a non-empty string no longer than ${maximum}`);
  }
  return value;
}

function hash(value, path, length = 64) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    fail(path, `expected a lowercase ${length * 4}-bit hexadecimal digest`);
  }
  return value;
}

function parsePublicUrl(value, path) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(path, "expected an absolute URL");
  }
  if (
    url.origin !== "https://gekko.free"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.hash !== ""
  ) {
    fail(path, "expected the exact https://gekko.free production root URL");
  }
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 3 || new Set(keys).size !== 3) {
    fail(path, "expected exactly scenario, viewportCapture, and headlessRun");
  }
  exact(url.searchParams.get("scenario"), "smb-ready-play", `${path}.scenario`);
  exact(url.searchParams.get("viewportCapture"), "1", `${path}.viewportCapture`);
  const run = url.searchParams.get("headlessRun");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(run ?? "")) {
    fail(`${path}.headlessRun`, "expected a bounded passive capture identifier");
  }
  for (const required of ["scenario", "viewportCapture", "headlessRun"]) {
    if (url.searchParams.getAll(required).length !== 1) {
      fail(path, `${required} must occur exactly once`);
    }
  }
  return url;
}

function asset(value, path, extension = null) {
  exactKeys(value, ["bytes", "sha256", "url"], path);
  positiveInteger(value.bytes, `${path}.bytes`);
  const digest = hash(value.sha256, `${path}.sha256`);
  boundedString(value.url, `${path}.url`);
  if (
    !value.url.startsWith("/assets/")
    || !value.url.includes(`-${digest}.`)
    || (extension !== null && !value.url.endsWith(extension))
  ) {
    fail(`${path}.url`, "expected a content-addressed release asset URL");
  }
  return value;
}

function releaseIdentity(value, path) {
  exactKeys(value, [
    "backend",
    "commit",
    "frontend",
    "releaseId",
    "renderer",
    "schema",
  ], path);
  exact(value.schema, 2, `${path}.schema`);
  hash(value.commit, `${path}.commit`, 40);
  hash(value.releaseId, `${path}.releaseId`);
  asset(value.frontend, `${path}.frontend`, ".html");
  exactKeys(value.renderer, ["javascript", "wasm"], `${path}.renderer`);
  asset(value.renderer.javascript, `${path}.renderer.javascript`, ".js");
  asset(value.renderer.wasm, `${path}.renderer.wasm`, ".wasm");
  exactKeys(value.backend, ["bytes", "sha256", "url"], `${path}.backend`);
  positiveInteger(value.backend.bytes, `${path}.backend.bytes`);
  hash(value.backend.sha256, `${path}.backend.sha256`);
  exact(value.backend.url, "/ppcwasmjit.wasm", `${path}.backend.url`);
  return value;
}

function fullViewportRect(value, path) {
  exactKeys(value, ["bottom", "height", "left", "right", "top", "width"], path);
  exact(finite(value.left, `${path}.left`), 0, `${path}.left`);
  exact(finite(value.top, `${path}.top`), 0, `${path}.top`);
  exact(finite(value.right, `${path}.right`), WIDTH, `${path}.right`);
  exact(finite(value.bottom, `${path}.bottom`), HEIGHT, `${path}.bottom`);
  exact(finite(value.width, `${path}.width`), WIDTH, `${path}.width`);
  exact(finite(value.height, `${path}.height`), HEIGHT, `${path}.height`);
}

function canvasRect(value, path) {
  const left = finite(value.left, `${path}.left`);
  const top = finite(value.top, `${path}.top`);
  const right = finite(value.right, `${path}.right`);
  const bottom = finite(value.bottom, `${path}.bottom`);
  const width = finite(value.width, `${path}.width`);
  const height = finite(value.height, `${path}.height`);
  const epsilon = 0.1;
  if (
    Math.abs(right - left - width) > epsilon
    || Math.abs(bottom - top - height) > epsilon
    || Math.abs(left - 0) > epsilon
    || Math.abs(right - 1024) > epsilon
    || Math.abs(top - 0) > epsilon
    || Math.abs(bottom - 768) > epsilon
    || Math.abs(width - 1024) > epsilon
    || Math.abs(height - 768) > epsilon
  ) {
    fail(path, "expected the deterministic 1024x768 CSS canvas box");
  }

  const content = value.content;
  exactKeys(content, ["bottom", "height", "left", "right", "top", "width"], `${path}.content`);
  const contentLeft = finite(content.left, `${path}.content.left`);
  const contentTop = finite(content.top, `${path}.content.top`);
  const contentRight = finite(content.right, `${path}.content.right`);
  const contentBottom = finite(content.bottom, `${path}.content.bottom`);
  const contentWidth = finite(content.width, `${path}.content.width`);
  const contentHeight = finite(content.height, `${path}.content.height`);
  if (
    Math.abs(contentRight - contentLeft - contentWidth) > epsilon
    || Math.abs(contentBottom - contentTop - contentHeight) > epsilon
    || Math.abs(contentLeft - 0) > epsilon
    || Math.abs(contentRight - 1024) > epsilon
    || Math.abs(contentTop - 25.6) > epsilon
    || Math.abs(contentBottom - 742.4) > epsilon
    || Math.abs(contentWidth - 1024) > epsilon
    || Math.abs(contentHeight - 716.8) > epsilon
  ) {
    fail(`${path}.content`, "expected deterministic centered 1024x716.8 contained content");
  }
}

function geometry(value, path) {
  exactKeys(value, ["canvas", "error", "iframe", "viewport"], path);
  exact(value.error, null, `${path}.error`);
  fullViewportRect(value.iframe, `${path}.iframe`);
  exactKeys(value.canvas, [
    "bottom",
    "bufferHeight",
    "bufferWidth",
    "content",
    "height",
    "left",
    "objectFit",
    "objectPosition",
    "right",
    "top",
    "width",
  ], `${path}.canvas`);
  exact(value.canvas.bufferWidth, 640, `${path}.canvas.bufferWidth`);
  exact(value.canvas.bufferHeight, 448, `${path}.canvas.bufferHeight`);
  exact(value.canvas.objectFit, "contain", `${path}.canvas.objectFit`);
  exact(value.canvas.objectPosition, "50% 50%", `${path}.canvas.objectPosition`);
  canvasRect(value.canvas, `${path}.canvas`);
  exactKeys(value.viewport, [
    "devicePixelRatio",
    "frameDevicePixelRatio",
    "frameHeight",
    "frameWidth",
    "height",
    "scrollX",
    "scrollY",
    "width",
  ], `${path}.viewport`);
  exact(value.viewport.width, WIDTH, `${path}.viewport.width`);
  exact(value.viewport.height, HEIGHT, `${path}.viewport.height`);
  exact(value.viewport.frameWidth, WIDTH, `${path}.viewport.frameWidth`);
  exact(value.viewport.frameHeight, HEIGHT, `${path}.viewport.frameHeight`);
  exact(value.viewport.devicePixelRatio, 1, `${path}.viewport.devicePixelRatio`);
  exact(value.viewport.frameDevicePixelRatio, 1, `${path}.viewport.frameDevicePixelRatio`);
  exact(value.viewport.scrollX, 0, `${path}.viewport.scrollX`);
  exact(value.viewport.scrollY, 0, `${path}.viewport.scrollY`);
}

function expectedFrameUrl(publicUrl, release) {
  const frame = new URL(release.frontend.url, publicUrl);
  frame.search = publicUrl.search;
  return frame.href;
}

function captureState(value, path, publicUrl, release, expectedStatus) {
  exactKeys(value, [
    "compositorCaptureAvailable",
    "discStatus",
    "frameHidden",
    "frameReadyState",
    "frameUrl",
    "geometry",
    "renderEvery",
    "renderer",
    "runnerAvailable",
    "status",
    "statusHidden",
    "surface",
    "topReadyState",
    "topUrl",
    "viewportCaptureMode",
  ], path);
  exact(value.topUrl, publicUrl.href, `${path}.topUrl`);
  exact(value.topReadyState, "complete", `${path}.topReadyState`);
  exact(value.frameUrl, expectedFrameUrl(publicUrl, release), `${path}.frameUrl`);
  exact(value.frameReadyState, "complete", `${path}.frameReadyState`);
  exact(boolean(value.frameHidden, `${path}.frameHidden`), false, `${path}.frameHidden`);
  exact(boolean(value.statusHidden, `${path}.statusHidden`), true, `${path}.statusHidden`);
  exact(value.surface, "release", `${path}.surface`);
  exact(value.viewportCaptureMode, "enabled", `${path}.viewportCaptureMode`);
  exact(
    boolean(value.compositorCaptureAvailable, `${path}.compositorCaptureAvailable`),
    false,
    `${path}.compositorCaptureAvailable`,
  );
  exact(value.renderer, "wgpu-webgpu", `${path}.renderer`);
  exact(value.status, expectedStatus, `${path}.status`);
  exact(value.renderEvery, null, `${path}.renderEvery`);
  if (typeof value.discStatus !== "string" || !value.discStatus.startsWith("local: ")) {
    fail(`${path}.discStatus`, "expected a local disc label");
  }
  exact(boolean(value.runnerAvailable, `${path}.runnerAvailable`), true, `${path}.runnerAvailable`);
  geometry(value.geometry, `${path}.geometry`);
}

function rgbPopulation(value, path) {
  exactKeys(value, ["black", "other", "unique", "white"], path);
  const black = nonNegativeInteger(value.black, `${path}.black`);
  const white = nonNegativeInteger(value.white, `${path}.white`);
  const other = nonNegativeInteger(value.other, `${path}.other`);
  const unique = positiveInteger(value.unique, `${path}.unique`);
  if (black + white + other !== PIXELS) fail(path, `expected exactly ${PIXELS} pixels`);
  if (unique > PIXELS) fail(`${path}.unique`, "unique colors exceed the pixel count");
  return { black, other, unique, white };
}

function frame(value, path, ordinal, previous) {
  exactKeys(value, ["metadata", "ordinal", "png", "receivedAtMs", "sessionId"], path);
  exact(value.ordinal, ordinal, `${path}.ordinal`);
  const sessionId = positiveInteger(value.sessionId, `${path}.sessionId`);
  if (previous !== null && sessionId <= previous.sessionId) {
    fail(`${path}.sessionId`, "screencast session IDs must increase");
  }
  const receivedAtMs = positiveInteger(value.receivedAtMs, `${path}.receivedAtMs`);
  if (previous !== null && receivedAtMs < previous.receivedAtMs) {
    fail(`${path}.receivedAtMs`, "receipt times must not move backwards");
  }
  exactKeys(value.metadata, [
    "deviceHeight",
    "deviceWidth",
    "offsetTop",
    "pageScaleFactor",
    "scrollOffsetX",
    "scrollOffsetY",
    "timestamp",
  ], `${path}.metadata`);
  exact(value.metadata.deviceWidth, WIDTH, `${path}.metadata.deviceWidth`);
  exact(value.metadata.deviceHeight, HEIGHT, `${path}.metadata.deviceHeight`);
  exact(value.metadata.offsetTop, 0, `${path}.metadata.offsetTop`);
  exact(value.metadata.pageScaleFactor, 1, `${path}.metadata.pageScaleFactor`);
  exact(value.metadata.scrollOffsetX, 0, `${path}.metadata.scrollOffsetX`);
  exact(value.metadata.scrollOffsetY, 0, `${path}.metadata.scrollOffsetY`);
  const timestamp = finite(value.metadata.timestamp, `${path}.metadata.timestamp`);
  if (timestamp <= 0 || (previous !== null && timestamp <= previous.timestamp)) {
    fail(`${path}.metadata.timestamp`, "timestamps must be positive and strictly increasing");
  }

  exactKeys(value.png, [
    "format",
    "height",
    "layout",
    "pngByteLength",
    "pngSha256",
    "rgb",
    "rgbSha256",
    "rgbaByteLength",
    "rgbaSha256",
    "sourceColorType",
    "width",
  ], `${path}.png`);
  exact(value.png.width, WIDTH, `${path}.png.width`);
  exact(value.png.height, HEIGHT, `${path}.png.height`);
  if (value.png.sourceColorType !== "rgb8" && value.png.sourceColorType !== "rgba8") {
    fail(`${path}.png.sourceColorType`, "expected rgb8 or rgba8");
  }
  exact(value.png.format, "rgba8unorm", `${path}.png.format`);
  exact(value.png.layout, "top-left-row-major-tight", `${path}.png.layout`);
  positiveInteger(value.png.pngByteLength, `${path}.png.pngByteLength`);
  exact(value.png.rgbaByteLength, PIXELS * 4, `${path}.png.rgbaByteLength`);
  hash(value.png.pngSha256, `${path}.png.pngSha256`);
  hash(value.png.rgbaSha256, `${path}.png.rgbaSha256`);
  hash(value.png.rgbSha256, `${path}.png.rgbSha256`);
  const rgb = rgbPopulation(value.png.rgb, `${path}.png.rgb`);
  return { receivedAtMs, rgb, sessionId, timestamp };
}

function partsPerMillion(count) {
  return Math.floor((count * 1_000_000) / PIXELS);
}

function frameIdentity(value, path, expectedUrl, expectedLoaderId = null) {
  exactKeys(value, ["frameId", "loaderId", "url"], path);
  boundedString(value.frameId, `${path}.frameId`, 512);
  const loaderId = boundedString(value.loaderId, `${path}.loaderId`, 512);
  if (expectedLoaderId !== null) exact(loaderId, expectedLoaderId, `${path}.loaderId`);
  exact(value.url, expectedUrl, `${path}.url`);
}

function navigationProof(value, path, publicUrl, release) {
  exactKeys(value, [
    "after",
    "before",
    "expectedFrameUrl",
    "expectedTopLoaderId",
  ], path);
  const topLoaderId = boundedString(
    value.expectedTopLoaderId,
    `${path}.expectedTopLoaderId`,
    512,
  );
  const frameUrl = expectedFrameUrl(publicUrl, release);
  exact(value.expectedFrameUrl, frameUrl, `${path}.expectedFrameUrl`);
  for (const phase of ["before", "after"]) {
    exactKeys(value[phase], ["iframe", "top"], `${path}.${phase}`);
    frameIdentity(
      value[phase].top,
      `${path}.${phase}.top`,
      publicUrl.href,
      topLoaderId,
    );
    frameIdentity(
      value[phase].iframe,
      `${path}.${phase}.iframe`,
      value.expectedFrameUrl,
    );
  }
  exact(value.after.top.frameId, value.before.top.frameId, `${path}.after.top.frameId`);
  exact(
    value.after.iframe.frameId,
    value.before.iframe.frameId,
    `${path}.after.iframe.frameId`,
  );
  exact(
    value.after.iframe.loaderId,
    value.before.iframe.loaderId,
    `${path}.after.iframe.loaderId`,
  );
}

function terminalTailProof(value, path, frames) {
  exactKeys(value, [
    "firstReceivedAtMs",
    "lastReceivedAtMs",
    "limits",
    "maxMetadataGapMs",
    "maxReceiptGapMs",
    "metadataSpanMs",
    "receiptSpanMs",
    "terminalMetadataAgeMs",
    "terminalObservedAtMs",
    "terminalTailAgeMs",
  ], path);
  const terminalObservedAtMs = positiveInteger(
    value.terminalObservedAtMs,
    `${path}.terminalObservedAtMs`,
  );
  const firstReceivedAtMs = positiveInteger(
    frames[0].receivedAtMs,
    "$.screencast.frames[0].receivedAtMs",
  );
  const lastReceivedAtMs = positiveInteger(
    frames.at(-1).receivedAtMs,
    `$.screencast.frames[${frames.length - 1}].receivedAtMs`,
  );
  let maxMetadataGapMs = 0;
  let maxReceiptGapMs = 0;
  for (let index = 1; index < frames.length; index += 1) {
    maxMetadataGapMs = Math.max(
      maxMetadataGapMs,
      (frames[index].metadata.timestamp - frames[index - 1].metadata.timestamp) * 1_000,
    );
    maxReceiptGapMs = Math.max(
      maxReceiptGapMs,
      frames[index].receivedAtMs - frames[index - 1].receivedAtMs,
    );
  }
  const metadataSpanMs = (
    frames.at(-1).metadata.timestamp - frames[0].metadata.timestamp
  ) * 1_000;
  const receiptSpanMs = lastReceivedAtMs - firstReceivedAtMs;
  const terminalMetadataAgeMs = Math.abs(
    terminalObservedAtMs - frames.at(-1).metadata.timestamp * 1_000,
  );
  const terminalTailAgeMs = Math.abs(terminalObservedAtMs - lastReceivedAtMs);
  exact(value.firstReceivedAtMs, firstReceivedAtMs, `${path}.firstReceivedAtMs`);
  exact(value.lastReceivedAtMs, lastReceivedAtMs, `${path}.lastReceivedAtMs`);
  exact(value.metadataSpanMs, metadataSpanMs, `${path}.metadataSpanMs`);
  exact(value.receiptSpanMs, receiptSpanMs, `${path}.receiptSpanMs`);
  exact(value.maxMetadataGapMs, maxMetadataGapMs, `${path}.maxMetadataGapMs`);
  exact(value.maxReceiptGapMs, maxReceiptGapMs, `${path}.maxReceiptGapMs`);
  exact(
    value.terminalMetadataAgeMs,
    terminalMetadataAgeMs,
    `${path}.terminalMetadataAgeMs`,
  );
  exact(value.terminalTailAgeMs, terminalTailAgeMs, `${path}.terminalTailAgeMs`);
  exactKeys(value.limits, [
    "maxFrameGapMs",
    "maxTailSpanMs",
    "maxTerminalTailAgeMs",
  ], `${path}.limits`);
  exact(value.limits.maxFrameGapMs, MAX_FRAME_GAP_MS, `${path}.limits.maxFrameGapMs`);
  exact(value.limits.maxTailSpanMs, MAX_TAIL_SPAN_MS, `${path}.limits.maxTailSpanMs`);
  exact(
    value.limits.maxTerminalTailAgeMs,
    MAX_TERMINAL_TAIL_AGE_MS,
    `${path}.limits.maxTerminalTailAgeMs`,
  );
  if (
    maxMetadataGapMs > MAX_FRAME_GAP_MS
    || maxReceiptGapMs > MAX_FRAME_GAP_MS
    || metadataSpanMs > MAX_TAIL_SPAN_MS
    || receiptSpanMs > MAX_TAIL_SPAN_MS
    || terminalMetadataAgeMs > MAX_TERMINAL_TAIL_AGE_MS
    || terminalTailAgeMs > MAX_TERMINAL_TAIL_AGE_MS
  ) {
    fail(path, "rolling tail is too sparse or stale at terminal scenario completion");
  }
}

function terminalProof(value, path) {
  exactKeys(value, [
    "cycles",
    "disc",
    "gameplayTranscript",
    "rendering",
    "reportBytes",
    "reportSha256",
    "scenario",
    "scheduler",
    "stage",
    "status",
  ], path);
  exact(value.status, "paused", `${path}.status`);
  exact(value.stage, "scenario-complete", `${path}.stage`);
  const cycles = positiveInteger(value.cycles, `${path}.cycles`);
  positiveInteger(value.reportBytes, `${path}.reportBytes`);
  hash(value.reportSha256, `${path}.reportSha256`);
  exactKeys(value.disc, ["identifier", "revision", "sourceKind"], `${path}.disc`);
  exact(value.disc.identifier, "GMBE8P", `${path}.disc.identifier`);
  exact(value.disc.revision, 0, `${path}.disc.revision`);
  exact(value.disc.sourceKind, "local-file", `${path}.disc.sourceKind`);
  exactKeys(value.scenario, [
    "completedCycle",
    "currentStep",
    "failure",
    "gameIdentifier",
    "hardCycleLimit",
    "id",
    "startCycle",
    "status",
    "stepCount",
    "stepIndex",
  ], `${path}.scenario`);
  exact(value.scenario.id, "smb-ready-play", `${path}.scenario.id`);
  exact(value.scenario.gameIdentifier, "GMBE8P", `${path}.scenario.gameIdentifier`);
  exact(value.scenario.status, "complete", `${path}.scenario.status`);
  exact(value.scenario.failure, null, `${path}.scenario.failure`);
  exact(value.scenario.currentStep, null, `${path}.scenario.currentStep`);
  exact(value.scenario.startCycle, 0, `${path}.scenario.startCycle`);
  exact(value.scenario.hardCycleLimit, 30_000_000_000, `${path}.scenario.hardCycleLimit`);
  exact(value.scenario.completedCycle, cycles, `${path}.scenario.completedCycle`);
  if (cycles >= value.scenario.hardCycleLimit) {
    fail(`${path}.scenario.completedCycle`, "scenario reached its hard cycle limit");
  }
  const stepCount = positiveInteger(value.scenario.stepCount, `${path}.scenario.stepCount`);
  exact(value.scenario.stepIndex, stepCount, `${path}.scenario.stepIndex`);
  try {
    validateSmbReadyPlayGameplayTranscript(value.gameplayTranscript);
  } catch (error) {
    fail(`${path}.gameplayTranscript`, error.message ?? String(error));
  }
  exact(
    value.gameplayTranscript.game.identifier,
    value.disc.identifier,
    `${path}.gameplayTranscript.game.identifier`,
  );
  exact(
    value.gameplayTranscript.game.revision,
    value.disc.revision,
    `${path}.gameplayTranscript.game.revision`,
  );
  exact(
    value.gameplayTranscript.scenario.completedCycle,
    cycles,
    `${path}.gameplayTranscript.scenario.completedCycle`,
  );
  exact(
    value.gameplayTranscript.steps.length,
    stepCount,
    `${path}.gameplayTranscript.steps.length`,
  );
  exactKeys(value.rendering, ["backend", "error"], `${path}.rendering`);
  exact(value.rendering.backend, "wgpu-webgpu", `${path}.rendering.backend`);
  exact(value.rendering.error, null, `${path}.rendering.error`);
  exactKeys(value.scheduler, ["renderEvery"], `${path}.scheduler`);
  exact(value.scheduler.renderEvery, 1, `${path}.scheduler.renderEvery`);
}

export function verifyPublicSmbScreencastReport(report) {
  exactKeys(report, [
    "after",
    "alignment",
    "before",
    "devtoolsExceptions",
    "discImage",
    "mode",
    "navigation",
    "oracle",
    "oraclePassed",
    "publicUrl",
    "release",
    "rendererControl",
    "schema",
    "screencast",
    "terminal",
    "terminalRelease",
  ], "$");
  exact(report.schema, REPORT_SCHEMA, "$.schema");
  exact(report.mode, "passive-public-viewport", "$.mode");
  exact(report.alignment, "non-serial-aligned", "$.alignment");
  exactKeys(report.rendererControl, [
    "compositorHandshake",
    "renderEveryOverride",
    "rendererBackpressure",
  ], "$.rendererControl");
  exact(report.rendererControl.compositorHandshake, false, "$.rendererControl.compositorHandshake");
  exact(report.rendererControl.rendererBackpressure, false, "$.rendererControl.rendererBackpressure");
  exact(report.rendererControl.renderEveryOverride, null, "$.rendererControl.renderEveryOverride");
  const publicUrl = parsePublicUrl(report.publicUrl, "$.publicUrl");
  releaseIdentity(report.release, "$.release");
  releaseIdentity(report.terminalRelease, "$.terminalRelease");
  navigationProof(report.navigation, "$.navigation", publicUrl, report.release);
  if (JSON.stringify(report.release) !== JSON.stringify(report.terminalRelease)) {
    fail("$.terminalRelease", "active release changed during the screencast");
  }
  exactKeys(report.discImage, ["algorithm", "format", "sha256"], "$.discImage");
  const expectedImage = SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image;
  exact(report.discImage.algorithm, expectedImage.algorithm, "$.discImage.algorithm");
  exact(report.discImage.format, expectedImage.format, "$.discImage.format");
  exact(report.discImage.sha256, expectedImage.sha256, "$.discImage.sha256");
  captureState(report.before, "$.before", publicUrl, report.release, "running");
  captureState(report.after, "$.after", publicUrl, report.release, "paused");
  terminalProof(report.terminal, "$.terminal");
  if (JSON.stringify(report.before.geometry) !== JSON.stringify(report.after.geometry)) {
    fail("$.after.geometry", "public iframe/canvas geometry changed during the screencast");
  }
  if (!Array.isArray(report.devtoolsExceptions) || report.devtoolsExceptions.length !== 0) {
    fail("$.devtoolsExceptions", "expected no DevTools exceptions");
  }

  exactKeys(report.screencast, [
    "acknowledgedFrames",
    "capacityFrames",
    "everyNthFrame",
    "firstReceivedOrdinal",
    "format",
    "frames",
    "height",
    "lastReceivedOrdinal",
    "protocol",
    "receivedFrames",
    "selection",
    "terminalTail",
    "width",
  ], "$.screencast");
  exact(report.screencast.protocol, "cdp-page-screencast-v1", "$.screencast.protocol");
  exact(report.screencast.format, "png", "$.screencast.format");
  exact(report.screencast.everyNthFrame, 1, "$.screencast.everyNthFrame");
  exact(report.screencast.width, WIDTH, "$.screencast.width");
  exact(report.screencast.height, HEIGHT, "$.screencast.height");
  exact(report.screencast.selection, "rolling-tail", "$.screencast.selection");
  exact(report.screencast.capacityFrames, FRAME_COUNT, "$.screencast.capacityFrames");
  const received = positiveInteger(report.screencast.receivedFrames, "$.screencast.receivedFrames");
  if (received < FRAME_COUNT) fail("$.screencast.receivedFrames", `expected at least ${FRAME_COUNT}`);
  exact(
    report.screencast.acknowledgedFrames,
    received,
    "$.screencast.acknowledgedFrames",
  );
  exact(
    report.screencast.firstReceivedOrdinal,
    received - FRAME_COUNT + 1,
    "$.screencast.firstReceivedOrdinal",
  );
  exact(
    report.screencast.lastReceivedOrdinal,
    received,
    "$.screencast.lastReceivedOrdinal",
  );
  if (!Array.isArray(report.screencast.frames) || report.screencast.frames.length !== FRAME_COUNT) {
    fail("$.screencast.frames", `expected exactly ${FRAME_COUNT} summarized frames`);
  }
  boolean(report.oraclePassed, "$.oraclePassed");
  const pendingOracle = report.oracle === null && report.oraclePassed === false;
  const storedOracle = report.oracle !== null;
  if (!pendingOracle && !storedOracle) {
    fail("$.oracle", "null oracle diagnostics require oraclePassed false");
  }
  if (storedOracle) object(report.oracle, "$.oracle");

  const distinctPng = new Set();
  const distinctRgba = new Set();
  const distinctRgb = new Set();
  const nearBlackOrdinals = [];
  const nearWhiteOrdinals = [];
  const monochromeOrdinals = [];
  const oppositeExtremeTransitions = [];
  let previous = null;
  let previousExtreme = null;
  for (let index = 0; index < report.screencast.frames.length; index += 1) {
    const entry = report.screencast.frames[index];
    const validated = frame(
      entry,
      `$.screencast.frames[${index}]`,
      index + 1,
      previous,
    );
    distinctPng.add(entry.png.pngSha256);
    distinctRgba.add(entry.png.rgbaSha256);
    distinctRgb.add(entry.png.rgbSha256);
    const blackPpm = partsPerMillion(validated.rgb.black);
    const whitePpm = partsPerMillion(validated.rgb.white);
    const extreme = blackPpm >= EXTREME_PPM
      ? "black"
      : whitePpm >= EXTREME_PPM
        ? "white"
        : null;
    if (extreme === "black") nearBlackOrdinals.push(index + 1);
    if (extreme === "white") nearWhiteOrdinals.push(index + 1);
    if (validated.rgb.unique === 1) monochromeOrdinals.push(index + 1);
    if (extreme !== null && previousExtreme !== null && extreme !== previousExtreme.color) {
      oppositeExtremeTransitions.push({
        from: previousExtreme.color,
        fromOrdinal: previousExtreme.ordinal,
        to: extreme,
        toOrdinal: index + 1,
      });
    }
    previousExtreme = extreme === null ? null : { color: extreme, ordinal: index + 1 };
    previous = validated;
  }
  terminalTailProof(
    report.screencast.terminalTail,
    "$.screencast.terminalTail",
    report.screencast.frames,
  );

  const oracle = {
    frameCount: FRAME_COUNT,
    distinctPngSha256: distinctPng.size,
    distinctRgbaSha256: distinctRgba.size,
    distinctRgbSha256: distinctRgb.size,
    extremeThresholdPpm: EXTREME_PPM,
    selectedReceivedOrdinals: {
      first: report.screencast.firstReceivedOrdinal,
      last: report.screencast.lastReceivedOrdinal,
    },
    nearBlackOrdinals,
    nearWhiteOrdinals,
    monochromeOrdinals,
    oppositeExtremeTransitions,
  };
  if (pendingOracle) {
    report.oracle = oracle;
  } else if (
    JSON.stringify(canonicalJson(report.oracle))
    !== JSON.stringify(canonicalJson(oracle))
  ) {
    fail("$.oracle", "persisted oracle does not match recomputed evidence");
  }
  if (distinctRgb.size < 4) {
    fail("$.oracle.distinctRgbSha256", `expected at least 4, got ${distinctRgb.size}`);
  }
  if (oppositeExtremeTransitions.length !== 0) {
    fail(
      "$.oracle.oppositeExtremeTransitions",
      `observed ${oppositeExtremeTransitions.length} near-black/near-white transitions`,
    );
  }
  if (storedOracle && report.oraclePassed === false) {
    fail("$.oraclePassed", "stored failed diagnostics have no reproducible oracle failure");
  }
  if (pendingOracle) report.oraclePassed = true;
  return report.oracle;
}
