// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";

import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import {
  validateSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V3,
  verifySmbSustainedPlay,
} from "./browser_boot_smb_sustained_play.mjs";

const REPORT_SCHEMA = "lazuli-public-smb-screencast-v3";
const FRAME_COUNT = 64;
const MIN_WINDOW_VI_RECEIPTS = 64;
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

function exactJson(value, expected, path) {
  if (
    JSON.stringify(canonicalJson(value))
    !== JSON.stringify(canonicalJson(expected))
  ) {
    fail(path, "expected an exact canonical JSON match");
  }
}

function canonicalJsonIdentity(value) {
  const serialized = JSON.stringify(canonicalJson(value));
  return {
    bytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
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
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail(path, "expected the exact https://gekko.free production root URL");
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
  frame.search = "";
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

function frame(value, path, selectedOrdinal, receivedOrdinal, previous) {
  exactKeys(value, [
    "metadata",
    "png",
    "receivedAtMs",
    "receivedOrdinal",
    "selectedOrdinal",
    "sessionId",
  ], path);
  exact(value.selectedOrdinal, selectedOrdinal, `${path}.selectedOrdinal`);
  exact(value.receivedOrdinal, receivedOrdinal, `${path}.receivedOrdinal`);
  const sessionId = positiveInteger(value.sessionId, `${path}.sessionId`);
  // CDP exposes sessionId as the opaque token for Page.screencastFrameAck;
  // Chrome may reuse it across frames. Ordinals plus the independent metadata
  // and receipt clocks establish the strict frame order below.
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

function terminalTailProof(value, path, frames, terminalReceivedOrdinal) {
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
    "terminalReceivedOrdinal",
    "terminalTailAgeMs",
  ], path);
  const terminalObservedAtMs = positiveInteger(
    value.terminalObservedAtMs,
    `${path}.terminalObservedAtMs`,
  );
  exact(
    value.terminalReceivedOrdinal,
    terminalReceivedOrdinal,
    `${path}.terminalReceivedOrdinal`,
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
  const terminalMetadataAgeMs =
    terminalObservedAtMs - frames.at(-1).metadata.timestamp * 1_000;
  const terminalTailAgeMs = terminalObservedAtMs - lastReceivedAtMs;
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
    || terminalMetadataAgeMs < 0
    || terminalTailAgeMs < 0
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
    "report",
    "reportBytes",
    "reportSha256",
    "scenario",
    "scheduler",
    "stage",
    "status",
    "sustainedPlay",
  ], path);
  exact(value.status, "paused", `${path}.status`);
  exact(value.stage, "scenario-complete", `${path}.stage`);
  const cycles = positiveInteger(value.cycles, `${path}.cycles`);
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
  exact(value.scenario.id, "smb-sustained-play", `${path}.scenario.id`);
  exact(value.scenario.gameIdentifier, "GMBE8P", `${path}.scenario.gameIdentifier`);
  exact(value.scenario.status, "complete", `${path}.scenario.status`);
  exact(value.scenario.failure, null, `${path}.scenario.failure`);
  exact(value.scenario.currentStep, null, `${path}.scenario.currentStep`);
  exact(value.scenario.startCycle, 0, `${path}.scenario.startCycle`);
  exact(value.scenario.hardCycleLimit, 32_000_000_000, `${path}.scenario.hardCycleLimit`);
  exact(value.scenario.completedCycle, cycles, `${path}.scenario.completedCycle`);
  if (cycles >= value.scenario.hardCycleLimit) {
    fail(`${path}.scenario.completedCycle`, "scenario reached its hard cycle limit");
  }
  exact(value.scenario.stepCount, 15, `${path}.scenario.stepCount`);
  exact(value.scenario.stepIndex, 15, `${path}.scenario.stepIndex`);

  const report = object(value.report, `${path}.report`);
  if (report.error !== undefined && report.error !== null) {
    fail(`${path}.report.error`, "expected no terminal report error");
  }
  const serialized = JSON.stringify(report);
  exact(
    positiveInteger(value.reportBytes, `${path}.reportBytes`),
    Buffer.byteLength(serialized),
    `${path}.reportBytes`,
  );
  exact(
    hash(value.reportSha256, `${path}.reportSha256`),
    createHash("sha256").update(serialized).digest("hex"),
    `${path}.reportSha256`,
  );
  exact(report.status, value.status, `${path}.report.status`);
  exact(report.stage, value.stage, `${path}.report.stage`);
  exact(report.cycles, value.cycles, `${path}.report.cycles`);
  for (const name of [
    "id",
    "gameIdentifier",
    "status",
    "hardCycleLimit",
    "startCycle",
    "completedCycle",
    "failure",
    "currentStep",
    "stepIndex",
  ]) {
    exact(
      report.scenario?.[name],
      value.scenario[name],
      `${path}.report.scenario.${name}`,
    );
  }
  exact(
    report.scenario?.steps?.length,
    value.scenario.stepCount,
    `${path}.report.scenario.steps.length`,
  );
  exact(
    report.disc?.identifier,
    value.disc.identifier,
    `${path}.report.disc.identifier`,
  );
  exact(
    report.disc?.revision,
    value.disc.revision,
    `${path}.report.disc.revision`,
  );
  exact(
    report.disc?.source?.kind,
    value.disc.sourceKind,
    `${path}.report.disc.source.kind`,
  );
  exact(
    report.sustainedPlay?.schema,
    SMB_SUSTAINED_PLAY_SCHEMA_V3,
    `${path}.report.sustainedPlay.schema`,
  );
  let sustainedPlay;
  try {
    sustainedPlay = verifySmbSustainedPlay(report);
  } catch (error) {
    fail(
      `${path}.report`,
      `strict sustained-play validation failed: ${error.message ?? String(error)}`,
    );
  }
  exactJson(value.sustainedPlay, sustainedPlay, `${path}.sustainedPlay`);
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
    report.sustainedPlay.readyPlayAnchor.cycles,
    `${path}.gameplayTranscript.scenario.completedCycle`,
  );
  exact(
    value.gameplayTranscript.steps.length,
    13,
    `${path}.gameplayTranscript.steps.length`,
  );
  exactJson(
    value.gameplayTranscript,
    report.gameplayTranscript,
    `${path}.gameplayTranscript`,
  );
  exactKeys(value.rendering, ["backend", "error"], `${path}.rendering`);
  exact(value.rendering.backend, "wgpu-webgpu", `${path}.rendering.backend`);
  exact(value.rendering.error, null, `${path}.rendering.error`);
  exact(
    report.rendering?.backend,
    value.rendering.backend,
    `${path}.report.rendering.backend`,
  );
  exact(
    report.rendering?.error ?? null,
    value.rendering.error,
    `${path}.report.rendering.error`,
  );
  exactKeys(value.scheduler, ["renderEvery"], `${path}.scheduler`);
  exact(value.scheduler.renderEvery, 1, `${path}.scheduler.renderEvery`);
  exact(
    report.execution?.scheduler?.renderEvery,
    value.scheduler.renderEvery,
    `${path}.report.execution.scheduler.renderEvery`,
  );
  return report;
}

function sustainedWindowProof(value, path, report, screencast) {
  exactKeys(value, [
    "acceptedReceipts",
    "lastPresentationSerial",
    "lastReceiptOrdinal",
    "lastRendererSequence",
    "observedAtMs",
    "observedCycle",
    "pendingReceipts",
    "postedReceipts",
    "receivedFramesBeforeWindow",
    "receiptPrefixBytes",
    "receiptPrefixSha256",
    "scenario",
    "snapshotRequestedAtMs",
    "step",
  ], path);
  exact(value.scenario, "smb-sustained-play", `${path}.scenario`);
  exact(value.step, "sustained-play-presented", `${path}.step`);
  const observedAtMs = positiveInteger(value.observedAtMs, `${path}.observedAtMs`);
  const snapshotRequestedAtMs = positiveInteger(
    value.snapshotRequestedAtMs,
    `${path}.snapshotRequestedAtMs`,
  );
  if (snapshotRequestedAtMs > observedAtMs) {
    fail(
      `${path}.snapshotRequestedAtMs`,
      "snapshot request cannot postdate window observation",
    );
  }
  const observedCycle = positiveInteger(value.observedCycle, `${path}.observedCycle`);
  const receivedFramesBeforeWindow = nonNegativeInteger(
    value.receivedFramesBeforeWindow,
    `${path}.receivedFramesBeforeWindow`,
  );
  const postedReceipts = nonNegativeInteger(
    value.postedReceipts,
    `${path}.postedReceipts`,
  );
  const acceptedReceipts = nonNegativeInteger(
    value.acceptedReceipts,
    `${path}.acceptedReceipts`,
  );
  const pendingReceipts = nonNegativeInteger(
    value.pendingReceipts,
    `${path}.pendingReceipts`,
  );
  if (
    postedReceipts
      > report.sustainedPlay.capacity - MIN_WINDOW_VI_RECEIPTS
    || acceptedReceipts < 2
    || acceptedReceipts + pendingReceipts !== postedReceipts
  ) {
    fail(
      path,
      `window must leave at least ${MIN_WINDOW_VI_RECEIPTS} sustained VI receipts`,
    );
  }
  if (
    screencast.receivedFrames - receivedFramesBeforeWindow
    < FRAME_COUNT
    || screencast.firstReceivedOrdinal <= receivedFramesBeforeWindow
  ) {
    fail(path, `expected all ${FRAME_COUNT} selected frames after window entry`);
  }
  const receiptPrefix = report.sustainedPlay.receipts.slice(0, acceptedReceipts);
  const lastReceipt = receiptPrefix.at(-1);
  exact(
    positiveInteger(value.lastReceiptOrdinal, `${path}.lastReceiptOrdinal`),
    lastReceipt.ordinal,
    `${path}.lastReceiptOrdinal`,
  );
  exact(
    positiveInteger(value.lastRendererSequence, `${path}.lastRendererSequence`),
    lastReceipt.rendererSequence,
    `${path}.lastRendererSequence`,
  );
  const prefixIdentity = canonicalJsonIdentity(receiptPrefix);
  exact(
    positiveInteger(value.receiptPrefixBytes, `${path}.receiptPrefixBytes`),
    prefixIdentity.bytes,
    `${path}.receiptPrefixBytes`,
  );
  exact(
    hash(value.receiptPrefixSha256, `${path}.receiptPrefixSha256`),
    prefixIdentity.sha256,
    `${path}.receiptPrefixSha256`,
  );
  const expectedPresentationSerial = receiptPrefix
    .filter(receipt => receipt?.presented === true)
    .at(-1)?.presentationSerial ?? null;
  positiveInteger(
    value.lastPresentationSerial,
    `${path}.lastPresentationSerial`,
  );
  exact(
    value.lastPresentationSerial,
    expectedPresentationSerial,
    `${path}.lastPresentationSerial`,
  );
  if (
    report.sustainedPlay.posted - postedReceipts
    < MIN_WINDOW_VI_RECEIPTS
  ) {
    fail(
      `${path}.postedReceipts`,
      `terminal report advanced fewer than ${MIN_WINDOW_VI_RECEIPTS} VI receipts`,
    );
  }
  if (report.cycles <= observedCycle) {
    fail(`${path}.observedCycle`, "terminal report did not advance past window cycle");
  }
  const firstFrame = screencast.frames[0];
  if (
    firstFrame !== undefined
    && firstFrame.receivedAtMs < observedAtMs
  ) {
    fail(`${path}.observedAtMs`, "selected tail begins before window observation");
  }
  if (
    firstFrame !== undefined
    && firstFrame.metadata.timestamp * 1_000 < observedAtMs
  ) {
    fail(
      `${path}.observedAtMs`,
      "selected tail contains a frame captured before window observation",
    );
  }
  if (screencast.terminalTail?.terminalObservedAtMs < observedAtMs) {
    fail(`${path}.observedAtMs`, "terminal observation predates window entry");
  }
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
  exact(report.mode, "sustained-public-viewport", "$.mode");
  exact(report.alignment, "sustained-window-bounded", "$.alignment");
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
  const terminalReport = terminalProof(report.terminal, "$.terminal");
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
    "postTerminalFrames",
    "receivedFrames",
    "selection",
    "terminalTail",
    "width",
    "window",
  ], "$.screencast");
  exact(report.screencast.protocol, "cdp-page-screencast-v1", "$.screencast.protocol");
  exact(report.screencast.format, "png", "$.screencast.format");
  exact(report.screencast.everyNthFrame, 1, "$.screencast.everyNthFrame");
  exact(report.screencast.width, WIDTH, "$.screencast.width");
  exact(report.screencast.height, HEIGHT, "$.screencast.height");
  exact(
    report.screencast.selection,
    "sustained-window-tail",
    "$.screencast.selection",
  );
  exact(report.screencast.capacityFrames, FRAME_COUNT, "$.screencast.capacityFrames");
  const received = positiveInteger(report.screencast.receivedFrames, "$.screencast.receivedFrames");
  if (received < FRAME_COUNT) fail("$.screencast.receivedFrames", `expected at least ${FRAME_COUNT}`);
  exact(
    report.screencast.acknowledgedFrames,
    received,
    "$.screencast.acknowledgedFrames",
  );
  const lastReceivedOrdinal = positiveInteger(
    report.screencast.lastReceivedOrdinal,
    "$.screencast.lastReceivedOrdinal",
  );
  if (lastReceivedOrdinal > received) {
    fail("$.screencast.lastReceivedOrdinal", "terminal ordinal exceeds received frames");
  }
  exact(
    report.screencast.firstReceivedOrdinal,
    lastReceivedOrdinal - FRAME_COUNT + 1,
    "$.screencast.firstReceivedOrdinal",
  );
  exact(
    nonNegativeInteger(
      report.screencast.postTerminalFrames,
      "$.screencast.postTerminalFrames",
    ),
    received - lastReceivedOrdinal,
    "$.screencast.postTerminalFrames",
  );
  if (!Array.isArray(report.screencast.frames) || report.screencast.frames.length !== FRAME_COUNT) {
    fail("$.screencast.frames", `expected exactly ${FRAME_COUNT} summarized frames`);
  }
  sustainedWindowProof(
    report.screencast.window,
    "$.screencast.window",
    terminalReport,
    report.screencast,
  );
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
      report.screencast.firstReceivedOrdinal + index,
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
    if (extreme !== null) {
      previousExtreme = { color: extreme, ordinal: index + 1 };
    }
    previous = validated;
  }
  terminalTailProof(
    report.screencast.terminalTail,
    "$.screencast.terminalTail",
    report.screencast.frames,
    lastReceivedOrdinal,
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
  if (nearBlackOrdinals.length !== 0) {
    fail(
      "$.oracle.nearBlackOrdinals",
      `observed ${nearBlackOrdinals.length} near-black viewport frames`,
    );
  }
  if (nearWhiteOrdinals.length !== 0) {
    fail(
      "$.oracle.nearWhiteOrdinals",
      `observed ${nearWhiteOrdinals.length} near-white viewport frames`,
    );
  }
  if (monochromeOrdinals.length !== 0) {
    fail(
      "$.oracle.monochromeOrdinals",
      `observed ${monochromeOrdinals.length} monochrome viewport frames`,
    );
  }
  if (storedOracle && report.oraclePassed === false) {
    fail("$.oraclePassed", "stored failed diagnostics have no reproducible oracle failure");
  }
  if (pendingOracle) report.oraclePassed = true;
  return report.oracle;
}
