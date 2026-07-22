// SPDX-License-Identifier: GPL-3.0-only

import { Buffer } from "node:buffer";

import { decodeCompositorPng } from "./browser_boot_compositor_png.mjs";

export const COMPOSITOR_CAPTURE_PROTOCOL = "lazuli-compositor-capture-v1";
export const COMPOSITOR_CAPTURE_COUNT = 8;
const COMPOSITOR_DEVICE_METRICS = Object.freeze({
  deviceScaleFactor: 1,
  dontSetVisibleSize: false,
  height: 768,
  mobile: false,
  positionX: 0,
  positionY: 0,
  screenHeight: 768,
  screenWidth: 1024,
  width: 1024,
});

const COMPOSITOR_GEOMETRY_OBSERVATION = `(() => {
  const display = document.querySelector("#display");
  const api = globalThis.lazuliCompositorCapture;
  if (!(display instanceof HTMLCanvasElement)) {
    return { error: "#display is not a canvas" };
  }
  const rect = display.getBoundingClientRect();
  const visual = globalThis.visualViewport;
  const insetX = Math.min(1, rect.width / 4);
  const insetY = Math.min(1, rect.height / 4);
  const xs = [rect.left + insetX, rect.left + rect.width / 2, rect.right - insetX];
  const ys = [rect.top + insetY, rect.top + rect.height / 2, rect.bottom - insetY];
  const coverage = [];
  for (const y of ys) {
    for (const x of xs) {
      const topmost = document.elementFromPoint(x, y);
      coverage.push({
        displayTopmost: topmost === display,
        topmostId: topmost?.id ?? null,
        topmostTag: topmost?.tagName?.toLowerCase() ?? null,
        x,
        y,
      });
    }
  }
  return {
    apiAvailable: api !== null
      && typeof api === "object"
      && typeof api.pending === "function"
      && typeof api.acknowledge === "function",
    coverage,
    error: null,
    geometry: {
      canvas: {
        bufferWidth: display.width,
        bufferHeight: display.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        scrollX,
        scrollY,
        visual: visual === null ? null : {
          offsetLeft: visual.offsetLeft,
          offsetTop: visual.offsetTop,
          pageLeft: visual.pageLeft,
          pageTop: visual.pageTop,
          width: visual.width,
          height: visual.height,
          scale: visual.scale,
        },
      },
    },
    mode: document.body?.dataset?.compositorCapture ?? null,
  };
})()`;

export function compositorFailure(detail) {
  const error = new Error(`SMB compositor capture is invalid: ${detail}`);
  error.name = "CompositorCaptureError";
  return error;
}

function compositorObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw compositorFailure(`${path} must be an object`);
  }
  return value;
}

function compositorExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw compositorFailure(
      `${path} keys must be ${canonical.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

function compositorFinite(value, path) {
  if (!Number.isFinite(value)) {
    throw compositorFailure(`${path} must be a finite number`);
  }
  return value;
}

function compositorNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw compositorFailure(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function compositorPositiveInteger(value, path) {
  const integer = compositorNonNegativeInteger(value, path);
  if (integer === 0) throw compositorFailure(`${path} must be positive`);
  return integer;
}

function compositorExact(value, expected, path) {
  if (value !== expected) {
    throw compositorFailure(
      `${path} must be ${JSON.stringify(expected)}; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateCompositorGeometry(geometry, dimensions = null, path = "$.geometry") {
  compositorObject(geometry, path);
  compositorExactKeys(geometry, ["canvas", "viewport"], path);
  const canvas = compositorObject(geometry.canvas, `${path}.canvas`);
  compositorExactKeys(canvas, [
    "bottom",
    "bufferHeight",
    "bufferWidth",
    "height",
    "left",
    "right",
    "top",
    "width",
  ], `${path}.canvas`);
  const bufferWidth = compositorPositiveInteger(
    canvas.bufferWidth,
    `${path}.canvas.bufferWidth`,
  );
  const bufferHeight = compositorPositiveInteger(
    canvas.bufferHeight,
    `${path}.canvas.bufferHeight`,
  );
  const left = compositorFinite(canvas.left, `${path}.canvas.left`);
  const top = compositorFinite(canvas.top, `${path}.canvas.top`);
  const right = compositorFinite(canvas.right, `${path}.canvas.right`);
  const bottom = compositorFinite(canvas.bottom, `${path}.canvas.bottom`);
  const width = compositorFinite(canvas.width, `${path}.canvas.width`);
  const height = compositorFinite(canvas.height, `${path}.canvas.height`);
  if (width <= 0 || height <= 0) {
    throw compositorFailure(`${path}.canvas must have positive CSS dimensions`);
  }
  if (
    Math.abs((right - left) - width) > 0.001
    || Math.abs((bottom - top) - height) > 0.001
  ) {
    throw compositorFailure(`${path}.canvas bounds disagree with its dimensions`);
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw compositorFailure(`${path}.canvas screenshot dimensions must be integer CSS pixels`);
  }
  if (width !== bufferWidth || height !== bufferHeight) {
    throw compositorFailure(
      `${path}.canvas CSS dimensions must be one-to-one with its ${bufferWidth}x${bufferHeight} buffer`,
    );
  }

  const viewport = compositorObject(geometry.viewport, `${path}.viewport`);
  compositorExactKeys(viewport, [
    "devicePixelRatio",
    "height",
    "scrollX",
    "scrollY",
    "visual",
    "width",
  ], `${path}.viewport`);
  compositorExact(viewport.width, 1024, `${path}.viewport.width`);
  compositorExact(viewport.height, 768, `${path}.viewport.height`);
  compositorExact(viewport.devicePixelRatio, 1, `${path}.viewport.devicePixelRatio`);
  compositorExact(viewport.scrollX, 0, `${path}.viewport.scrollX`);
  compositorExact(viewport.scrollY, 0, `${path}.viewport.scrollY`);
  const visual = compositorObject(viewport.visual, `${path}.viewport.visual`);
  compositorExactKeys(visual, [
    "height",
    "offsetLeft",
    "offsetTop",
    "pageLeft",
    "pageTop",
    "scale",
    "width",
  ], `${path}.viewport.visual`);
  compositorExact(visual.width, 1024, `${path}.viewport.visual.width`);
  compositorExact(visual.height, 768, `${path}.viewport.visual.height`);
  compositorExact(visual.offsetLeft, 0, `${path}.viewport.visual.offsetLeft`);
  compositorExact(visual.offsetTop, 0, `${path}.viewport.visual.offsetTop`);
  compositorExact(visual.pageLeft, 0, `${path}.viewport.visual.pageLeft`);
  compositorExact(visual.pageTop, 0, `${path}.viewport.visual.pageTop`);
  compositorExact(visual.scale, 1, `${path}.viewport.visual.scale`);
  if (left < 0 || top < 0 || right > viewport.width || bottom > viewport.height) {
    throw compositorFailure(`${path}.canvas is not entirely inside the viewport`);
  }
  if (
    dimensions !== null
    && (bufferWidth !== dimensions.width || bufferHeight !== dimensions.height)
  ) {
    throw compositorFailure(
      `${path}.canvas buffer ${bufferWidth}x${bufferHeight} does not match presented ${dimensions.width}x${dimensions.height}`,
    );
  }
  return geometry;
}

function compositorLayoutIdentity(geometry) {
  return {
    canvas: {
      bottom: geometry.canvas.bottom,
      height: geometry.canvas.height,
      left: geometry.canvas.left,
      right: geometry.canvas.right,
      top: geometry.canvas.top,
      width: geometry.canvas.width,
    },
    viewport: geometry.viewport,
  };
}

function validateCompositorEnvironment(observation, baselineLayout = null) {
  compositorObject(observation, "$.compositorEnvironment");
  compositorExactKeys(observation, [
    "apiAvailable",
    "coverage",
    "error",
    "geometry",
    "mode",
  ], "$.compositorEnvironment");
  if (observation.error !== null) {
    throw compositorFailure(`page geometry failed: ${String(observation.error)}`);
  }
  compositorExact(observation.apiAvailable, true, "$.compositorEnvironment.apiAvailable");
  compositorExact(observation.mode, "enabled", "$.compositorEnvironment.mode");
  const geometry = validateCompositorGeometry(observation.geometry);
  if (!Array.isArray(observation.coverage) || observation.coverage.length !== 9) {
    throw compositorFailure("$.compositorEnvironment.coverage must contain 9 samples");
  }
  const covered = observation.coverage.find(sample => sample?.displayTopmost !== true);
  if (covered !== undefined) {
    throw compositorFailure(
      `#display is covered at (${covered?.x}, ${covered?.y}) by ${covered?.topmostTag ?? "unknown"}#${covered?.topmostId ?? ""}`,
    );
  }
  const layout = compositorLayoutIdentity(geometry);
  if (
    baselineLayout !== null
    && JSON.stringify(layout) !== JSON.stringify(baselineLayout)
  ) {
    throw compositorFailure("#display geometry changed during compositor capture");
  }
  return { geometry, layout };
}

async function observeCompositorEnvironment(session) {
  return session.evaluate(COMPOSITOR_GEOMETRY_OBSERVATION);
}

function validateCompositorDescriptor(pending, frames, liveGeometry) {
  const path = "$.lazuliCompositorCapture.pending";
  compositorObject(pending, path);
  compositorExactKeys(pending, [
    "address",
    "generation",
    "geometry",
    "height",
    "ordinal",
    "presentationSerial",
    "protocol",
    "rendererSequence",
    "row",
    "scenario",
    "step",
    "token",
    "width",
  ], path);
  compositorExact(pending.protocol, COMPOSITOR_CAPTURE_PROTOCOL, `${path}.protocol`);
  compositorExact(pending.scenario, "smb-ready-play", `${path}.scenario`);
  compositorExact(pending.step, "post-play-presented", `${path}.step`);
  compositorExact(pending.ordinal, frames.length + 1, `${path}.ordinal`);
  if (
    typeof pending.token !== "string"
    || pending.token.length === 0
    || pending.token.length > 512
  ) {
    throw compositorFailure(`${path}.token must be a non-empty bounded string`);
  }
  if (!/^0x[0-9a-f]{8}$/.test(pending.address)) {
    throw compositorFailure(`${path}.address must be lowercase 32-bit hexadecimal`);
  }
  const rendererSequence = compositorPositiveInteger(
    pending.rendererSequence,
    `${path}.rendererSequence`,
  );
  const presentationSerial = compositorPositiveInteger(
    pending.presentationSerial,
    `${path}.presentationSerial`,
  );
  compositorPositiveInteger(pending.generation, `${path}.generation`);
  const row = compositorNonNegativeInteger(pending.row, `${path}.row`);
  if (row > 1) throw compositorFailure(`${path}.row must be 0 or 1`);
  const width = compositorPositiveInteger(pending.width, `${path}.width`);
  const height = compositorPositiveInteger(pending.height, `${path}.height`);
  if (width > 1024 || height > 1024) {
    throw compositorFailure(`${path} dimensions exceed 1024x1024`);
  }
  validateCompositorGeometry(pending.geometry, { height, width }, `${path}.geometry`);
  if (JSON.stringify(pending.geometry) !== JSON.stringify(liveGeometry)) {
    throw compositorFailure(`${path}.geometry does not match the live #display geometry`);
  }
  const previous = frames.at(-1)?.descriptor ?? null;
  if (previous !== null) {
    if (rendererSequence <= previous.rendererSequence) {
      throw compositorFailure(`${path}.rendererSequence is not strictly increasing`);
    }
    if (presentationSerial <= previous.presentationSerial) {
      throw compositorFailure(`${path}.presentationSerial is not strictly increasing`);
    }
    if (frames.some(frame => frame.descriptor.token === pending.token)) {
      throw compositorFailure(`${path}.token was already acknowledged`);
    }
  }
  if (frames.length >= COMPOSITOR_CAPTURE_COUNT) {
    throw compositorFailure(`received more than ${COMPOSITOR_CAPTURE_COUNT} frames`);
  }
  return pending;
}

async function acknowledgeCompositorFrame(session, token, runUrl) {
  const result = await session.evaluate(`(() => {
    const api = globalThis.lazuliCompositorCapture;
    if (
      api === null
      || typeof api !== "object"
      || typeof api.pending !== "function"
      || typeof api.acknowledge !== "function"
    ) {
      return { acknowledged: false, error: "capture API unavailable", pending: null, url: location.href };
    }
    const acknowledged = api.acknowledge(${JSON.stringify(token)});
    return { acknowledged, error: null, pending: api.pending(), url: location.href };
  })()`);
  compositorObject(result, "$.compositorAcknowledge");
  compositorExactKeys(result, [
    "acknowledged",
    "error",
    "pending",
    "url",
  ], "$.compositorAcknowledge");
  compositorExact(result.url, runUrl, "$.compositorAcknowledge.url");
  compositorExact(result.error, null, "$.compositorAcknowledge.error");
  compositorExact(result.acknowledged, true, "$.compositorAcknowledge.acknowledged");
  compositorExact(result.pending, null, "$.compositorAcknowledge.pending");
}

export async function configureCompositorViewport(session) {
  await session.send("Page.bringToFront");
  await session.send(
    "Emulation.setDeviceMetricsOverride",
    COMPOSITOR_DEVICE_METRICS,
  );
}

export async function clearCompositorViewport(session) {
  await session.send("Emulation.clearDeviceMetricsOverride");
}

export async function initializeCompositorCapture(
  session,
  { activeRelease, navigationLoaderId, options, runUrl },
  { observeRelease },
) {
  if (typeof observeRelease !== "function") {
    throw new TypeError("initializeCompositorCapture requires observeRelease");
  }
  const environment = validateCompositorEnvironment(
    await observeCompositorEnvironment(session),
  );
  await observeRelease(session, options, activeRelease);
  return {
    baselineLayout: environment.layout,
    frames: [],
    navigationLoaderId,
    runUrl,
  };
}

export async function capturePendingCompositorFrame(
  session,
  capture,
  pending,
  { activeRelease, navigationLoaderId, options, runUrl },
  dependencies = {},
) {
  const acknowledge = dependencies.acknowledge ?? acknowledgeCompositorFrame;
  const decodePng = dependencies.decodePng ?? decodeCompositorPng;
  const observeEnvironment = dependencies.observeEnvironment
    ?? observeCompositorEnvironment;
  const observeRelease = dependencies.observeRelease;
  if (typeof observeRelease !== "function") {
    throw new TypeError("capturePendingCompositorFrame requires observeRelease");
  }
  const environment = validateCompositorEnvironment(
    await observeEnvironment(session),
    capture.baselineLayout,
  );
  const descriptor = validateCompositorDescriptor(
    pending,
    capture.frames,
    environment.geometry,
  );
  const release = await observeRelease(session, options, activeRelease);
  const canvas = environment.geometry.canvas;
  const clip = {
    height: canvas.height,
    scale: 1,
    width: canvas.width,
    x: canvas.left,
    y: canvas.top,
  };
  const screenshot = await session.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    clip,
    format: "png",
    fromSurface: true,
  });
  compositorObject(screenshot, "$.Page.captureScreenshot");
  compositorExactKeys(screenshot, ["data"], "$.Page.captureScreenshot");
  if (typeof screenshot.data !== "string" || screenshot.data.length === 0) {
    throw compositorFailure("Page.captureScreenshot returned no PNG data");
  }
  const currentFrame = await session.send("Page.getFrameTree");
  const currentLoaderId = currentFrame.frameTree?.frame?.loaderId ?? null;
  compositorExact(
    currentLoaderId,
    navigationLoaderId,
    "$.compositorCapture.loaderId",
  );
  const pngBytes = Buffer.from(screenshot.data, "base64");
  const decoded = decodePng(pngBytes, {
    expectedHeight: canvas.height,
    expectedWidth: canvas.width,
  });
  const { rgba: _canonicalPixels, ...png } = decoded;
  await acknowledge(session, descriptor.token, runUrl);
  const evidence = {
    clip,
    descriptor,
    loaderId: currentLoaderId,
    png,
    releaseCommit: release.commit,
    releaseId: release.releaseId,
    url: runUrl,
  };
  capture.frames.push(evidence);
  return evidence;
}

export function compositorCaptureEvidence(capture) {
  return {
    captureBeyondViewport: false,
    captureComplete: false,
    expectedFrames: COMPOSITOR_CAPTURE_COUNT,
    format: "png",
    frames: capture.frames,
    fromSurface: true,
    loaderId: capture.navigationLoaderId,
    oracle: null,
    oraclePassed: false,
    protocol: COMPOSITOR_CAPTURE_PROTOCOL,
    schemaValid: false,
    target: "#display",
    url: capture.runUrl,
    viewport: capture.baselineLayout.viewport,
  };
}
