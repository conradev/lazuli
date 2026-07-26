#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";
import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import { decodeCompositorPng } from "./browser_boot_compositor_png.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V3,
  SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
  verifySmbSustainedPlay,
  verifySmbSustainedPlayPrefix,
} from "./browser_boot_smb_sustained_play.mjs";
import { DevToolsSession } from "./browser_boot_headless_cdp.mjs";
import {
  PUBLIC_VIEWPORT,
  assignPublicDisc,
  clearPublicViewport,
  configurePublicCompatibilityDebug,
  configurePublicViewport,
  expectedPublicFrameUrl,
  observePublicActiveRelease,
  parsePublicReport,
  publicDelay,
  publicPageTarget,
  publicReleaseState,
  requestPublicSnapshot,
  waitForPublicRelease,
  waitForPublicRunner,
  waitForPublicSnapshot,
} from "./browser_public_cdp.mjs";
import {
  PUBLIC_SMB_SUSTAINED_SCENARIO,
} from "./browser_public_smb_sustained.mjs";
import {
  verifyPublicSmbScreencastReport,
} from "./browser_public_smb_screencast_oracle.mjs";

export const PUBLIC_SMB_SCREENCAST_SCHEMA = "lazuli-public-smb-screencast-v3";
export const PUBLIC_SMB_SCREENCAST_PROTOCOL = "cdp-page-screencast-v1";
export const PUBLIC_SMB_SCREENCAST_FRAMES = 64;
export const PUBLIC_SMB_MIN_WINDOW_VI_RECEIPTS = 64;
export const PUBLIC_SMB_MAX_FRAME_GAP_MS = 5_000;
export const PUBLIC_SMB_MAX_TAIL_SPAN_MS = 180_000;
export const PUBLIC_SMB_MAX_TERMINAL_TAIL_AGE_MS = 5_000;

const PUBLIC_CAPTURE_GEOMETRY = `(() => {
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  const display = frameDocument?.querySelector("#display") ?? null;
  if (
    !(frame instanceof HTMLIFrameElement)
    || frameDocument === null
    || frameWindow === null
    || !(display instanceof frameWindow.HTMLCanvasElement)
  ) {
    return { error: "public iframe has no canvas capture surface" };
  }
  const frameRect = frame.getBoundingClientRect();
  const displayRect = display.getBoundingClientRect();
  const displayStyle = frameWindow.getComputedStyle(display);
  const contentScale = display.width > 0 && display.height > 0
    ? Math.min(displayRect.width / display.width, displayRect.height / display.height)
    : 0;
  const contentWidth = display.width * contentScale;
  const contentHeight = display.height * contentScale;
  const contentLeft = frameRect.left + displayRect.left
    + (displayRect.width - contentWidth) / 2;
  const contentTop = frameRect.top + displayRect.top
    + (displayRect.height - contentHeight) / 2;
  return {
    canvas: {
      bottom: frameRect.top + displayRect.bottom,
      bufferHeight: display.height,
      bufferWidth: display.width,
      content: {
        bottom: contentTop + contentHeight,
        height: contentHeight,
        left: contentLeft,
        right: contentLeft + contentWidth,
        top: contentTop,
        width: contentWidth,
      },
      height: displayRect.height,
      left: frameRect.left + displayRect.left,
      objectFit: displayStyle.objectFit,
      objectPosition: displayStyle.objectPosition,
      right: frameRect.left + displayRect.right,
      top: frameRect.top + displayRect.top,
      width: displayRect.width,
    },
    error: null,
    iframe: {
      bottom: frameRect.bottom,
      height: frameRect.height,
      left: frameRect.left,
      right: frameRect.right,
      top: frameRect.top,
      width: frameRect.width,
    },
    viewport: {
      devicePixelRatio,
      frameDevicePixelRatio: frameWindow.devicePixelRatio,
      frameHeight: frameWindow.innerHeight,
      frameWidth: frameWindow.innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      width: innerWidth,
    },
  };
})()`;

const PNG_LIMITS = Object.freeze({
  expectedHeight: PUBLIC_VIEWPORT.height,
  expectedWidth: PUBLIC_VIEWPORT.width,
  maxChunkBytes: 12 * 1024 * 1024,
  maxChunks: 4096,
  maxCompressedBytes: 12 * 1024 * 1024,
  maxDecodedBytes: 4 * 1024 * 1024,
  maxHeight: PUBLIC_VIEWPORT.height,
  maxPixels: PUBLIC_VIEWPORT.width * PUBLIC_VIEWPORT.height,
  maxPngBytes: 16 * 1024 * 1024,
  maxWidth: PUBLIC_VIEWPORT.width,
});

const BASE64_LIMIT = Math.ceil(PNG_LIMITS.maxPngBytes / 3) * 4;

function captureFailure(detail) {
  const error = new Error(`public SMB passive screencast is invalid: ${detail}`);
  error.name = "PublicSmbScreencastError";
  return error;
}

export function assertCanonicalSmbDiscImage(value) {
  const expected = SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== Object.keys(expected).sort().join("\0")
    || value.algorithm !== expected.algorithm
    || value.format !== expected.format
    || value.sha256 !== expected.sha256
  ) {
    throw captureFailure(
      `disc image must be canonical Super Monkey Ball CISO ${expected.sha256}`,
    );
  }
  return value;
}

function finite(value, name) {
  if (!Number.isFinite(value)) throw captureFailure(`${name} must be finite`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw captureFailure(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw captureFailure(`${name} must be a non-negative safe integer`);
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

function canonicalJsonIdentity(value) {
  const serialized = JSON.stringify(canonicalJson(value));
  return {
    bytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

function decodeBase64Png(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > BASE64_LIMIT
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw captureFailure("Page.screencastFrame returned invalid bounded base64");
  }
  const png = Buffer.from(value, "base64");
  if (png.toString("base64") !== value) {
    throw captureFailure("Page.screencastFrame base64 is not canonical");
  }
  return png;
}

function compactMetadata(metadata) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw captureFailure("Page.screencastFrame metadata must be an object");
  }
  return {
    offsetTop: finite(metadata.offsetTop, "metadata.offsetTop"),
    pageScaleFactor: finite(metadata.pageScaleFactor, "metadata.pageScaleFactor"),
    deviceWidth: finite(metadata.deviceWidth, "metadata.deviceWidth"),
    deviceHeight: finite(metadata.deviceHeight, "metadata.deviceHeight"),
    scrollOffsetX: finite(metadata.scrollOffsetX, "metadata.scrollOffsetX"),
    scrollOffsetY: finite(metadata.scrollOffsetY, "metadata.scrollOffsetY"),
    timestamp: finite(metadata.timestamp, "metadata.timestamp"),
  };
}

function summarizeFrame(event, ordinal) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw captureFailure("Page.screencastFrame payload must be an object");
  }
  const sessionId = positiveInteger(event.sessionId, "sessionId");
  const decoded = decodeCompositorPng(decodeBase64Png(event.data), PNG_LIMITS);
  const { rgba: _discardedRgba, ...png } = decoded;
  return {
    receivedOrdinal: ordinal,
    sessionId,
    metadata: compactMetadata(event.metadata),
    png,
  };
}

export class PublicSmbScreencastCollector {
  constructor(session, {
    capacityFrames = PUBLIC_SMB_SCREENCAST_FRAMES,
    summarize = summarizeFrame,
  } = {}) {
    if (typeof session?.on !== "function" || typeof session?.send !== "function") {
      throw new TypeError("passive screencast collector requires a DevTools session");
    }
    if (typeof summarize !== "function") {
      throw new TypeError("passive screencast collector summarize must be a function");
    }
    this.acknowledgedFrames = 0;
    this.acknowledgements = new Set();
    this.error = null;
    this.frames = [];
    this.lastReceivedAtMs = null;
    this.receivedFrames = 0;
    this.session = session;
    this.capacityFrames = positiveInteger(capacityFrames, "capacityFrames");
    this.summarize = summarize;
    this.terminalTail = null;
    this.window = null;
    this.unsubscribe = session.on(
      "Page.screencastFrame",
      event => this.receive(event),
    );
  }

  receive(event) {
    this.receivedFrames += 1;
    const receivedAtMs = Math.max(Date.now(), this.lastReceivedAtMs ?? 0);
    this.lastReceivedAtMs = receivedAtMs;
    const sessionId = event?.sessionId;
    const acknowledgement = this.session.send("Page.screencastFrameAck", { sessionId })
      .then(() => { this.acknowledgedFrames += 1; })
      .catch(error => {
        if (this.error === null) {
          this.error = captureFailure(
            `Page.screencastFrameAck failed: ${error.message ?? String(error)}`,
          );
        }
      });
    this.acknowledgements.add(acknowledgement);
    acknowledgement.finally(() => this.acknowledgements.delete(acknowledgement));
    if (this.terminalTail !== null) return;
    if (this.error === null) {
      try {
        this.frames.push({
          ...this.summarize(event, this.receivedFrames),
          receivedAtMs,
        });
        if (this.frames.length > this.capacityFrames) this.frames.shift();
      } catch (error) {
        this.error = error;
      }
    }
  }

  tailReady() {
    return this.frames.length === this.capacityFrames;
  }

  beginSustainedWindow({
    snapshotRequestedAtMs,
    observedAtMs,
    observedCycle,
    pendingReceipts,
    postedReceipts,
    receiptPrefix,
  }) {
    this.throwIfFailed();
    if (this.window !== null) {
      throw captureFailure("sustained screenshot window was already started");
    }
    const snapshotRequested = positiveInteger(
      snapshotRequestedAtMs,
      "window.snapshotRequestedAtMs",
    );
    const observed = positiveInteger(observedAtMs, "window.observedAtMs");
    if (snapshotRequested > observed) {
      throw captureFailure(
        "snapshot request cannot postdate sustained window observation",
      );
    }
    const posted = nonNegativeInteger(
      postedReceipts,
      "window.postedReceipts",
    );
    const pending = nonNegativeInteger(
      pendingReceipts,
      "window.pendingReceipts",
    );
    const cycle = positiveInteger(observedCycle, "window.observedCycle");
    if (!Array.isArray(receiptPrefix) || receiptPrefix.length < 2) {
      throw captureFailure(
        "sustained screenshot window requires a nonempty completed VI pair",
      );
    }
    const accepted = receiptPrefix.length;
    if (
      posted
      > SMB_SUSTAINED_VI_RECEIPT_CAPACITY
        - PUBLIC_SMB_MIN_WINDOW_VI_RECEIPTS
    ) {
      throw captureFailure(
        `sustained screenshot window requires at least `
          + `${PUBLIC_SMB_MIN_WINDOW_VI_RECEIPTS} later VI receipts`,
      );
    }
    if (accepted + pending !== posted) {
      throw captureFailure(
        "sustained screenshot window receipts and pending count do not match posted",
      );
    }
    const lastPresented = receiptPrefix
      .filter(receipt => receipt?.presented === true)
      .at(-1) ?? null;
    const lastPresentationSerial = lastPresented?.presentationSerial ?? null;
    if (
      !Number.isSafeInteger(lastPresentationSerial)
      || lastPresentationSerial <= 0
    ) {
      throw captureFailure(
        "sustained screenshot window requires a completed presented VI pair",
      );
    }
    const lastReceipt = receiptPrefix.at(-1);
    const lastReceiptOrdinal = positiveInteger(
      lastReceipt?.ordinal,
      "window.lastReceiptOrdinal",
    );
    const lastRendererSequence = positiveInteger(
      lastReceipt?.rendererSequence,
      "window.lastRendererSequence",
    );
    const receiptPrefixIdentity = canonicalJsonIdentity(receiptPrefix);
    this.frames = [];
    this.terminalTail = null;
    this.window = {
      scenario: PUBLIC_SMB_SUSTAINED_SCENARIO,
      step: "sustained-play-presented",
      snapshotRequestedAtMs: snapshotRequested,
      observedAtMs: observed,
      observedCycle: cycle,
      receivedFramesBeforeWindow: this.receivedFrames,
      postedReceipts: posted,
      pendingReceipts: pending,
      acceptedReceipts: accepted,
      lastPresentationSerial,
      lastReceiptOrdinal,
      lastRendererSequence,
      receiptPrefixBytes: receiptPrefixIdentity.bytes,
      receiptPrefixSha256: receiptPrefixIdentity.sha256,
    };
    return this.window;
  }

  canFinalize(terminalProof) {
    return terminalProof !== null
      && this.window !== null
      && this.terminalTail !== null
      && this.tailReady();
  }

  pinTerminalTail(terminalObservedAtMs) {
    this.throwIfFailed();
    if (this.terminalTail !== null) {
      throw captureFailure("terminal screenshot tail was already pinned");
    }
    if (!this.tailReady()) {
      throw captureFailure(
        `rolling tail contains ${this.frames.length} of ${this.capacityFrames} frames`,
      );
    }
    if (this.window === null) {
      throw captureFailure("sustained screenshot window was never started");
    }
    if (!Number.isSafeInteger(terminalObservedAtMs) || terminalObservedAtMs <= 0) {
      throw captureFailure("terminal observation time must be a positive safe integer");
    }
    let maxMetadataGapMs = 0;
    let maxReceiptGapMs = 0;
    for (let index = 1; index < this.frames.length; index += 1) {
      const metadataGapMs = (this.frames[index].metadata.timestamp
        - this.frames[index - 1].metadata.timestamp) * 1_000;
      const receiptGapMs = this.frames[index].receivedAtMs
        - this.frames[index - 1].receivedAtMs;
      if (!Number.isFinite(metadataGapMs) || metadataGapMs <= 0) {
        throw captureFailure("rolling-tail screencast timestamps must strictly increase");
      }
      if (!Number.isSafeInteger(receiptGapMs) || receiptGapMs < 0) {
        throw captureFailure("rolling-tail receipt times must not move backwards");
      }
      maxMetadataGapMs = Math.max(maxMetadataGapMs, metadataGapMs);
      maxReceiptGapMs = Math.max(maxReceiptGapMs, receiptGapMs);
    }
    const first = this.frames[0];
    const last = this.frames.at(-1);
    if (first.receivedAtMs < this.window.observedAtMs) {
      throw captureFailure(
        "rolling tail contains a frame from before the sustained window",
      );
    }
    if (first.metadata.timestamp * 1_000 < this.window.observedAtMs) {
      throw captureFailure(
        "rolling tail contains a frame captured before the sustained window",
      );
    }
    const metadataSpanMs = (last.metadata.timestamp - first.metadata.timestamp) * 1_000;
    const receiptSpanMs = last.receivedAtMs - first.receivedAtMs;
    const terminalMetadataAgeMs =
      terminalObservedAtMs - last.metadata.timestamp * 1_000;
    const terminalTailAgeMs = terminalObservedAtMs - last.receivedAtMs;
    if (
      maxMetadataGapMs > PUBLIC_SMB_MAX_FRAME_GAP_MS
      || maxReceiptGapMs > PUBLIC_SMB_MAX_FRAME_GAP_MS
      || metadataSpanMs > PUBLIC_SMB_MAX_TAIL_SPAN_MS
      || receiptSpanMs > PUBLIC_SMB_MAX_TAIL_SPAN_MS
      || terminalMetadataAgeMs < 0
      || terminalTailAgeMs < 0
      || terminalMetadataAgeMs > PUBLIC_SMB_MAX_TERMINAL_TAIL_AGE_MS
      || terminalTailAgeMs > PUBLIC_SMB_MAX_TERMINAL_TAIL_AGE_MS
    ) {
      throw captureFailure(
        "rolling tail is too sparse or stale at terminal scenario completion",
      );
    }
    const terminalReceivedOrdinal = this.receivedFrames;
    this.terminalTail = {
      terminalObservedAtMs,
      terminalReceivedOrdinal,
      firstReceivedAtMs: first.receivedAtMs,
      lastReceivedAtMs: last.receivedAtMs,
      metadataSpanMs,
      receiptSpanMs,
      maxMetadataGapMs,
      maxReceiptGapMs,
      terminalMetadataAgeMs,
      terminalTailAgeMs,
      limits: {
        maxFrameGapMs: PUBLIC_SMB_MAX_FRAME_GAP_MS,
        maxTailSpanMs: PUBLIC_SMB_MAX_TAIL_SPAN_MS,
        maxTerminalTailAgeMs: PUBLIC_SMB_MAX_TERMINAL_TAIL_AGE_MS,
      },
    };
    return this.terminalTail;
  }

  throwIfFailed() {
    if (this.error !== null) throw this.error;
  }

  async close() {
    this.unsubscribe();
    while (this.acknowledgements.size !== 0) {
      await Promise.all([...this.acknowledgements]);
    }
    this.throwIfFailed();
  }

  evidence() {
    this.throwIfFailed();
    if (!this.tailReady()) {
      throw captureFailure(
        `rolling tail contains ${this.frames.length} of ${this.capacityFrames} frames`,
      );
    }
    if (this.window === null) {
      throw captureFailure("sustained screenshot window was never started");
    }
    if (this.terminalTail === null) {
      throw captureFailure("terminal screenshot tail was never pinned");
    }
    const lastReceivedOrdinal = this.terminalTail.terminalReceivedOrdinal;
    const firstReceivedOrdinal = lastReceivedOrdinal - this.frames.length + 1;
    return {
      protocol: PUBLIC_SMB_SCREENCAST_PROTOCOL,
      format: "png",
      everyNthFrame: 1,
      width: PUBLIC_VIEWPORT.width,
      height: PUBLIC_VIEWPORT.height,
      selection: "sustained-window-tail",
      capacityFrames: this.capacityFrames,
      firstReceivedOrdinal,
      lastReceivedOrdinal,
      receivedFrames: this.receivedFrames,
      postTerminalFrames: this.receivedFrames - lastReceivedOrdinal,
      acknowledgedFrames: this.acknowledgedFrames,
      frames: this.frames.map((frame, index) => ({
        ...frame,
        selectedOrdinal: index + 1,
      })),
      terminalTail: this.terminalTail,
      window: this.window,
    };
  }
}

export async function stopPublicSmbScreencast(session, collector, started) {
  try {
    if (started) await session.send("Page.stopScreencast");
  } finally {
    await collector.close();
  }
}

function exactRect(rect, width, height) {
  return rect.left === 0
    && rect.top === 0
    && rect.right === width
    && rect.bottom === height
    && rect.width === width
    && rect.height === height;
}

export function captureGeometryReady(geometry) {
  if (geometry?.error !== null) return false;
  const viewport = geometry.viewport;
  if (
    viewport?.width !== PUBLIC_VIEWPORT.width
    || viewport?.height !== PUBLIC_VIEWPORT.height
    || viewport?.frameWidth !== PUBLIC_VIEWPORT.width
    || viewport?.frameHeight !== PUBLIC_VIEWPORT.height
    || viewport?.devicePixelRatio !== 1
    || viewport?.frameDevicePixelRatio !== 1
    || viewport?.scrollX !== 0
    || viewport?.scrollY !== 0
  ) return false;
  if (!exactRect(geometry.iframe, PUBLIC_VIEWPORT.width, PUBLIC_VIEWPORT.height)) return false;
  const canvas = geometry.canvas;
  if (canvas === null || typeof canvas !== "object") return false;
  const content = canvas?.content;
  const epsilon = 0.1;
  return canvas.bufferWidth === 640
    && canvas.bufferHeight === 448
    && canvas.objectFit === "contain"
    && canvas.objectPosition === "50% 50%"
    && Number.isFinite(canvas.left)
    && Number.isFinite(canvas.top)
    && Number.isFinite(canvas.right)
    && Number.isFinite(canvas.bottom)
    && Number.isFinite(canvas.width)
    && Number.isFinite(canvas.height)
    && Math.abs(canvas.right - canvas.left - canvas.width) <= epsilon
    && Math.abs(canvas.bottom - canvas.top - canvas.height) <= epsilon
    && Math.abs(canvas.left - 0) <= epsilon
    && Math.abs(canvas.right - 1024) <= epsilon
    && Math.abs(canvas.top - 0) <= epsilon
    && Math.abs(canvas.bottom - 768) <= epsilon
    && Math.abs(canvas.width - 1024) <= epsilon
    && Math.abs(canvas.height - 768) <= epsilon
    && Number.isFinite(content?.left)
    && Number.isFinite(content?.top)
    && Number.isFinite(content?.right)
    && Number.isFinite(content?.bottom)
    && Number.isFinite(content?.width)
    && Number.isFinite(content?.height)
    && Math.abs(content.right - content.left - content.width) <= epsilon
    && Math.abs(content.bottom - content.top - content.height) <= epsilon
    && Math.abs(content.left - 0) <= epsilon
    && Math.abs(content.right - 1024) <= epsilon
    && Math.abs(content.top - 25.6) <= epsilon
    && Math.abs(content.bottom - 742.4) <= epsilon
    && Math.abs(content.width - 1024) <= epsilon
    && Math.abs(content.height - 716.8) <= epsilon;
}

function compactCaptureState(state, geometry) {
  return {
    topUrl: state.topUrl,
    topReadyState: state.topReadyState,
    frameUrl: state.frameUrl,
    frameReadyState: state.frameReadyState,
    frameHidden: state.frameHidden,
    statusHidden: state.statusHidden,
    surface: state.surface,
    viewportCaptureMode: state.viewportCaptureMode,
    compositorCaptureAvailable: state.compositorCaptureAvailable,
    renderer: state.dataset.renderer ?? null,
    status: state.dataset.status ?? null,
    renderEvery: state.dataset.renderEvery ?? null,
    discStatus: state.discStatus,
    runnerAvailable: state.runnerAvailable,
    geometry,
  };
}

async function observeCaptureState(session) {
  const [state, geometry] = await Promise.all([
    publicReleaseState(session),
    session.evaluate(PUBLIC_CAPTURE_GEOMETRY),
  ]);
  return compactCaptureState(state, geometry);
}

async function waitForCaptureSurface(session, { deadline, expectedFrameUrl, pollMs, publicUrl }) {
  let capture = null;
  while (Date.now() < deadline) {
    capture = await observeCaptureState(session);
    if (
      capture.topUrl === publicUrl
      && capture.frameUrl === expectedFrameUrl
      && capture.renderer === "wgpu-webgpu"
      && capture.status === "running"
      && capture.surface === "release"
      && capture.viewportCaptureMode === "enabled"
      && capture.compositorCaptureAvailable === false
      && captureGeometryReady(capture.geometry)
    ) return capture;
    if (capture.status === "paused" || capture.status === "stopped") {
      throw captureFailure(
        `SMB became ${capture.status} before the public viewport was capturable: ${JSON.stringify(capture)}`,
      );
    }
    await publicDelay(pollMs);
  }
  throw captureFailure(`public viewport did not become capturable: ${JSON.stringify(capture)}`);
}

function terminalInteger(value, path, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw captureFailure(`${path} must be a ${positive ? "positive" : "non-negative"} integer`);
  }
  return value;
}

export function derivePublicSmbTerminalProof(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw captureFailure("terminal report must be an object");
  }
  if (report.status !== "paused" || report.stage !== "scenario-complete") {
    throw captureFailure("terminal report is not paused at scenario-complete");
  }
  if (report.error !== undefined && report.error !== null) {
    throw captureFailure(`terminal report failed: ${JSON.stringify(report.error)}`);
  }
  const rendering = report.rendering;
  if (
    rendering === null
    || typeof rendering !== "object"
    || Array.isArray(rendering)
    || rendering.backend !== "wgpu-webgpu"
    || (rendering.error !== undefined && rendering.error !== null)
  ) {
    throw captureFailure("terminal report does not prove healthy WebGPU rendering");
  }
  const disc = report.disc;
  if (
    disc?.identifier !== "GMBE8P"
    || disc.revision !== 0
    || disc.source?.kind !== "local-file"
  ) {
    throw captureFailure("terminal report does not identify local Super Monkey Ball USA Rev.00");
  }
  const scenario = report.scenario;
  if (
    scenario === null
    || typeof scenario !== "object"
    || Array.isArray(scenario)
    || scenario.id !== PUBLIC_SMB_SUSTAINED_SCENARIO
    || scenario.gameIdentifier !== "GMBE8P"
    || scenario.status !== "complete"
    || scenario.failure !== null
    || scenario.currentStep !== null
    || scenario.startCycle !== 0
    || scenario.hardCycleLimit !== 32_000_000_000
    || !Array.isArray(scenario.steps)
  ) {
    throw captureFailure(
      "terminal report does not prove exact smb-sustained-play completion",
    );
  }
  if (report.sustainedPlay?.schema !== SMB_SUSTAINED_PLAY_SCHEMA_V3) {
    throw captureFailure(
      `terminal report requires ${SMB_SUSTAINED_PLAY_SCHEMA_V3}`,
    );
  }
  let sustainedPlay;
  try {
    sustainedPlay = verifySmbSustainedPlay(report);
  } catch (error) {
    throw captureFailure(
      `terminal sustained-play report failed strict validation: `
        + `${error.message ?? String(error)}`,
    );
  }
  const completedCycle = terminalInteger(
    scenario.completedCycle,
    "scenario.completedCycle",
    { positive: true },
  );
  if (completedCycle >= scenario.hardCycleLimit || report.cycles !== completedCycle) {
    throw captureFailure("terminal report cycle counters disagree with scenario completion");
  }
  const scheduler = report.execution?.scheduler;
  if (scheduler?.renderEvery !== 1) {
    throw captureFailure("terminal report did not retain default renderEvery 1 cadence");
  }
  const serialized = JSON.stringify(report);
  return {
    reportBytes: Buffer.byteLength(serialized),
    reportSha256: createHash("sha256").update(serialized).digest("hex"),
    status: report.status,
    stage: report.stage,
    cycles: completedCycle,
    disc: {
      identifier: disc.identifier,
      revision: disc.revision,
      sourceKind: disc.source.kind,
    },
    scenario: {
      id: scenario.id,
      gameIdentifier: scenario.gameIdentifier,
      status: scenario.status,
      hardCycleLimit: scenario.hardCycleLimit,
      startCycle: scenario.startCycle,
      completedCycle,
      failure: scenario.failure,
      currentStep: scenario.currentStep,
      stepIndex: scenario.stepIndex,
      stepCount: scenario.steps.length,
    },
    gameplayTranscript: report.gameplayTranscript,
    sustainedPlay,
    rendering: {
      backend: rendering.backend,
      error: rendering.error ?? null,
    },
    scheduler: {
      renderEvery: scheduler.renderEvery,
    },
    report,
  };
}

function beginObservedSmbSustainedWindow(
  report,
  collector,
  {
    snapshotRequestedAtMs,
    observedAtMs,
  },
) {
  if (
    collector.window !== null
    || report?.status !== "running"
    || report.scenario?.id !== PUBLIC_SMB_SUSTAINED_SCENARIO
    || report.scenario?.status !== "running"
    || report.scenario?.currentStep !== "sustained-play-presented"
  ) return false;
  let prefix;
  try {
    prefix = verifySmbSustainedPlayPrefix(report);
  } catch (error) {
    throw captureFailure(
      `observed malformed sustained-play screenshot window entry: `
        + `${error.message ?? String(error)}`,
    );
  }
  if (
    prefix.acceptedReceipts < 2
    || prefix.lastPresentationSerial === null
  ) return false;
  const sustained = report.sustainedPlay;
  collector.beginSustainedWindow({
    snapshotRequestedAtMs,
    observedAtMs,
    observedCycle: prefix.observedCycle,
    pendingReceipts: prefix.pendingReceipts,
    postedReceipts: prefix.postedReceipts,
    receiptPrefix: sustained.receipts,
  });
  return true;
}

export async function waitForPublicSmbTerminal(
  session,
  collector,
  {
    deadline,
    delay = publicDelay,
    getState = publicReleaseState,
    now = Date.now,
    pollMs,
    requestSnapshot = requestPublicSnapshot,
    waitSnapshot = waitForPublicSnapshot,
  },
) {
  let state = null;
  while (now() < deadline) {
    collector.throwIfFailed();
    state = await getState(session);
    let report = parsePublicReport(state.result);
    let snapshotRequestedAtMs = null;
    let snapshotObservedAtMs = null;
    const terminal =
      report?.status === "paused"
      || report?.stage === "scenario-complete";
    if (!terminal && state.dataset.status === "running") {
      snapshotRequestedAtMs = now();
      if (await requestSnapshot(session) !== true) {
        throw captureFailure(
          "public SMB cycle runner cannot publish a sustained snapshot",
        );
      }
      const snapshot = await waitSnapshot(session, {
        deadline,
        pollMs,
      });
      state = snapshot.state;
      report = snapshot.report;
      snapshotObservedAtMs = now();
    }
    if (
      (state.dataset.status === "paused"
        || state.dataset.status === "stopped")
      && (report === null || report.status === "running")
    ) {
      await delay(pollMs);
      continue;
    }
    if (
      report?.status === "running"
      && snapshotRequestedAtMs === null
    ) {
      throw captureFailure(
        "running SMB report was not fenced by an active snapshot request",
      );
    }
    beginObservedSmbSustainedWindow(
      report,
      collector,
      {
        snapshotRequestedAtMs,
        observedAtMs: snapshotObservedAtMs,
      },
    );
    if (
      report?.status === "stopped"
      || report?.stage === "scenario-failed"
      || (report?.error !== undefined && report?.error !== null)
      || (report?.scenario?.failure !== undefined && report.scenario.failure !== null)
    ) {
      throw captureFailure(`SMB scenario stopped before completion: ${JSON.stringify(report)}`);
    }
    if (report?.status === "paused" || report?.stage === "scenario-complete") {
      if (collector.window === null) {
        throw captureFailure(
          "sustained play completed before its screenshot window was observed",
        );
      }
      const terminal = derivePublicSmbTerminalProof(report);
      if (
        state.dataset.status !== "paused"
        || state.dataset.renderer !== "wgpu-webgpu"
        || state.surface !== "release"
      ) {
        throw captureFailure("terminal page state does not match scenario-complete report");
      }
      const observedAtMs = now();
      collector.pinTerminalTail(observedAtMs);
      return { state, terminal, observedAtMs };
    }
    await delay(pollMs);
  }
  throw captureFailure(`SMB scenario did not complete before the deadline: ${JSON.stringify(state)}`);
}

function compactFrameIdentity(frame) {
  return {
    frameId: frame.id,
    loaderId: frame.loaderId,
    url: frame.url,
  };
}

async function observePinnedNavigation(
  session,
  navigationLoaderId,
  publicUrl,
  expectedFrameUrl,
) {
  const tree = await session.send("Page.getFrameTree");
  const top = tree.frameTree?.frame;
  if (
    typeof top?.id !== "string"
    || top.id.length === 0
    || top.loaderId !== navigationLoaderId
    || top.url !== publicUrl
  ) {
    throw captureFailure(`top-level navigation loader is not pinned: ${JSON.stringify(top)}`);
  }
  const matchingFrames = (tree.frameTree?.childFrames ?? [])
    .map(child => child?.frame)
    .filter(frame => frame?.url === expectedFrameUrl);
  if (
    matchingFrames.length !== 1
    || typeof matchingFrames[0]?.id !== "string"
    || matchingFrames[0].id.length === 0
    || typeof matchingFrames[0].loaderId !== "string"
    || matchingFrames[0].loaderId.length === 0
  ) {
    throw captureFailure(
      `immutable public iframe loader is not uniquely pinned: ${JSON.stringify(matchingFrames)}`,
    );
  }
  return {
    top: compactFrameIdentity(top),
    iframe: compactFrameIdentity(matchingFrames[0]),
  };
}

export function configuredPublicSmbCaptureUrl(urlValue) {
  const url = new URL(urlValue);
  if (
    url.origin !== "https://gekko.free"
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new Error("--url must use the exact production origin https://gekko.free");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("--url must be the exact public root without query or fragment");
  }
  return url.href;
}

export function parsePublicSmbScreencastArguments(argv) {
  const options = {
    disc: null,
    endpoint: "http://127.0.0.1:9222",
    expectCommit: null,
    expectReleaseId: null,
    output: null,
    pollMs: 100,
    timeoutMs: 3_600_000,
    url: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value after ${argument}`);
      return argv[index];
    };
    switch (argument) {
      case "--disc": options.disc = value(); break;
      case "--endpoint": options.endpoint = value(); break;
      case "--expect-commit": options.expectCommit = value(); break;
      case "--expect-release-id": options.expectReleaseId = value(); break;
      case "--output": options.output = value(); break;
      case "--poll-ms": options.pollMs = Number(value()); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--url": options.url = value(); break;
      default: throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.disc === null) throw new Error("--disc must name the local SMB CISO");
  if (options.url === null) throw new Error("--url must name the public Gekko root");
  if (!/^[0-9a-f]{40}$/.test(options.expectCommit ?? "")) {
    throw new Error("--expect-commit is required and must be a lowercase commit ID");
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectReleaseId ?? "")) {
    throw new Error("--expect-release-id is required and must be a lowercase SHA-256 digest");
  }
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10) {
    throw new Error("--poll-ms must be an integer >= 10");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < options.pollMs) {
    throw new Error("--timeout-ms must be an integer >= --poll-ms");
  }
  options.disc = resolve(options.disc);
  options.publicUrl = configuredPublicSmbCaptureUrl(options.url);
  return options;
}

async function persistEvidence(output, evidence) {
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}

async function collectPublicSmbScreencast(
  session,
  options,
  deadline,
  discImage,
  navigationLoaderId,
) {
  const initialState = await waitForPublicRelease(session, {
    deadline,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
  });
  if (initialState.viewportCaptureMode !== null) {
    throw captureFailure("public root unexpectedly enabled viewport capture mode");
  }
  await configurePublicCompatibilityDebug(session, {
    scenario: PUBLIC_SMB_SUSTAINED_SCENARIO,
    viewportCapture: true,
  });
  const configuredState = await waitForPublicRelease(session, {
    deadline,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
  });
  if (configuredState.viewportCaptureMode !== "enabled") {
    throw captureFailure("compatibility debug control did not enable viewport capture mode");
  }
  const release = await observePublicActiveRelease(session, options);
  const frameUrl = expectedPublicFrameUrl(options.publicUrl, release);
  await waitForPublicRelease(session, {
    deadline,
    expectedFrameUrl: frameUrl,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
  });
  const navigationBefore = await observePinnedNavigation(
    session,
    navigationLoaderId,
    options.publicUrl,
    frameUrl,
  );
  await assignPublicDisc(session, options.disc, {
    deadline,
    label: "Super Monkey Ball CISO",
    pollMs: options.pollMs,
  });
  await waitForPublicRunner(session, {
    deadline,
    pollMs: options.pollMs,
    stoppedLabel: "Super Monkey Ball sustained",
  });
  const before = await waitForCaptureSurface(session, {
    deadline,
    expectedFrameUrl: frameUrl,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
  });

  const collector = new PublicSmbScreencastCollector(session);
  let terminalResult = null;
  let started = false;
  try {
    await session.send("Page.startScreencast", {
      everyNthFrame: 1,
      format: "png",
      maxHeight: PUBLIC_VIEWPORT.height,
      maxWidth: PUBLIC_VIEWPORT.width,
    });
    started = true;
    terminalResult = await waitForPublicSmbTerminal(session, collector, {
      deadline,
      pollMs: options.pollMs,
    });
  } finally {
    await stopPublicSmbScreencast(session, collector, started);
  }
  if (!collector.canFinalize(terminalResult?.terminal ?? null)) {
    throw captureFailure(
      `scenario completed with only ${collector.frames.length} rolling-tail frames`,
    );
  }
  const terminalRelease = await observePublicActiveRelease(session, options, release);
  const navigationAfter = await observePinnedNavigation(
    session,
    navigationLoaderId,
    options.publicUrl,
    frameUrl,
  );
  const after = await observeCaptureState(session);
  const report = {
    schema: PUBLIC_SMB_SCREENCAST_SCHEMA,
    mode: "sustained-public-viewport",
    alignment: "sustained-window-bounded",
    rendererControl: {
      compositorHandshake: false,
      rendererBackpressure: false,
      renderEveryOverride: null,
    },
    publicUrl: options.publicUrl,
    navigation: {
      expectedTopLoaderId: navigationLoaderId,
      expectedFrameUrl: frameUrl,
      before: navigationBefore,
      after: navigationAfter,
    },
    release,
    terminalRelease,
    discImage,
    before,
    after,
    terminal: terminalResult.terminal,
    devtoolsExceptions: session.exceptions,
    screencast: collector.evidence(),
    oracle: null,
    oraclePassed: false,
  };
  let oracleError = null;
  try {
    verifyPublicSmbScreencastReport(report);
  } catch (error) {
    oracleError = error;
  }
  await persistEvidence(options.output, report);
  if (oracleError !== null) throw oracleError;
  return report;
}

export async function runPublicSmbScreencast(options) {
  const discImage = await identifyLocalDiscImage(options.disc);
  assertCanonicalSmbDiscImage(discImage);
  const target = await publicPageTarget(options.endpoint);
  const session = new DevToolsSession(target.webSocketDebuggerUrl);
  await session.connect();
  let viewportConfigured = false;
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("DOM.enable");
    await configurePublicViewport(session);
    viewportConfigured = true;
    const navigation = await session.send("Page.navigate", { url: options.publicUrl });
    if (navigation.errorText !== undefined) {
      throw new Error(`Page.navigate failed: ${navigation.errorText}`);
    }
    if (typeof navigation.loaderId !== "string" || navigation.loaderId.length === 0) {
      throw captureFailure("Page.navigate did not create a top-level document loader");
    }
    return await collectPublicSmbScreencast(
      session,
      options,
      Date.now() + options.timeoutMs,
      discImage,
      navigation.loaderId,
    );
  } finally {
    if (viewportConfigured) await clearPublicViewport(session).catch(() => {});
    session.close();
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parsePublicSmbScreencastArguments(process.argv.slice(2));
  runPublicSmbScreencast(options).catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
