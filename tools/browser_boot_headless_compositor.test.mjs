// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  capturePendingCompositorFrame,
  clearCompositorViewport,
  compositorCaptureEvidence,
  configureCompositorViewport,
  initializeCompositorCapture,
} from "./browser_boot_headless_compositor.mjs";

function compositorGeometry({
  bufferHeight = 448,
  bufferWidth = 640,
  height = bufferHeight,
  width = bufferWidth,
} = {}) {
  const left = (1024 - width) / 2;
  const top = (768 - height) / 2;
  return {
    canvas: {
      bufferWidth,
      bufferHeight,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    },
    viewport: {
      width: 1024,
      height: 768,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      visual: {
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        width: 1024,
        height: 768,
        scale: 1,
      },
    },
  };
}

function compositorEnvironment(geometry = compositorGeometry()) {
  return {
    apiAvailable: true,
    coverage: Array.from({ length: 9 }, (_, index) => ({
      displayTopmost: true,
      topmostId: "display",
      topmostTag: "canvas",
      x: index,
      y: index,
    })),
    error: null,
    geometry,
    mode: "enabled",
  };
}

function descriptor(geometry = compositorGeometry()) {
  return {
    protocol: "lazuli-compositor-capture-v1",
    token: "run-1:1:42",
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: 1,
    rendererSequence: 41,
    presentationSerial: 42,
    address: "0x81234567",
    generation: 17,
    row: 0,
    width: geometry.canvas.bufferWidth,
    height: geometry.canvas.bufferHeight,
    geometry,
  };
}

test("compositor viewport commands are exact and reversible", async () => {
  const calls = [];
  const session = {
    async send(method, params = {}) {
      calls.push({ method, params });
      return {};
    },
  };
  await configureCompositorViewport(session);
  await clearCompositorViewport(session);
  assert.deepEqual(calls, [
    { method: "Page.bringToFront", params: {} },
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        deviceScaleFactor: 1,
        dontSetVisibleSize: false,
        height: 768,
        mobile: false,
        positionX: 0,
        positionY: 0,
        screenHeight: 768,
        screenWidth: 1024,
        width: 1024,
      },
    },
    { method: "Emulation.clearDeviceMetricsOverride", params: {} },
  ]);
});

test("pending compositor frames use an exact pinned CDP canvas screenshot", async () => {
  const calls = [];
  const geometry = compositorGeometry();
  const release = { commit: "1".repeat(40), releaseId: "2".repeat(64) };
  const options = {
    expectCommit: release.commit,
    expectReleaseId: release.releaseId,
  };
  const runUrl = "https://gekko.free/assets/frontend.html"
    + "?scenario=smb-ready-play&compositorCapture=1&headlessRun=run-1";
  let releaseObservations = 0;
  const observeRelease = async (_session, actualOptions, expected) => {
    releaseObservations += 1;
    assert.strictEqual(expected, release);
    assert.strictEqual(actualOptions, options);
    return release;
  };
  const session = {
    async evaluate() {
      return compositorEnvironment(geometry);
    },
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("strict-png-fixture").toString("base64") };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { loaderId: "loader-fresh" } } };
      }
      assert.fail(`unexpected CDP method ${method}`);
    },
  };
  const context = {
    activeRelease: release,
    navigationLoaderId: "loader-fresh",
    options,
    runUrl,
  };
  const capture = await initializeCompositorCapture(
    session,
    context,
    { observeRelease },
  );
  assert.equal(capture.baselineLayout, null);
  assert.strictEqual(capture.viewport, geometry.viewport);
  let acknowledged = null;
  const pending = {
    ...descriptor(geometry),
    protocol: "lazuli-compositor-capture-v2",
    scanoutPolicy: "bob",
    fieldStrideBytes: 0x0a00,
    sourceRowStep: 2,
    fieldHeight: 224,
    rowRepeat: 2,
  };
  const evidence = await capturePendingCompositorFrame(
    session,
    capture,
    pending,
    context,
    {
      async acknowledge(_session, token, url) {
        acknowledged = { token, url };
      },
      decodePng(bytes, dimensions) {
        assert.equal(bytes.toString(), "strict-png-fixture");
        assert.deepEqual(dimensions, { expectedHeight: 448, expectedWidth: 640 });
        return {
          width: 640,
          height: 448,
          sourceColorType: "rgba8",
          format: "rgba8unorm",
          layout: "top-left-row-major-tight",
          pngByteLength: bytes.length,
          pngSha256: "3".repeat(64),
          rgbaByteLength: 640 * 448 * 4,
          rgbaSha256: "4".repeat(64),
          rgbSha256: "5".repeat(64),
          rgb: { black: 0, white: 0, other: 640 * 448, unique: 32 },
          rgba: Buffer.alloc(4),
        };
      },
      observeRelease,
    },
  );
  assert.deepEqual(calls, [
    {
      method: "Page.captureScreenshot",
      params: {
        captureBeyondViewport: false,
        clip: { height: 448, scale: 1, width: 640, x: 192, y: 160 },
        format: "png",
        fromSurface: true,
      },
    },
    { method: "Page.getFrameTree", params: {} },
  ]);
  assert.deepEqual(acknowledged, { token: pending.token, url: runUrl });
  assert.equal(releaseObservations, 2);
  assert.equal(capture.frames.length, 1);
  assert.deepEqual(capture.baselineLayout, {
    canvas: {
      bottom: 608,
      height: 448,
      left: 192,
      right: 832,
      top: 160,
      width: 640,
    },
    viewport: geometry.viewport,
  });
  assert.strictEqual(evidence.descriptor, pending);
  assert.equal(evidence.loaderId, "loader-fresh");
  assert.equal(evidence.releaseId, release.releaseId);
  assert.equal(evidence.releaseCommit, release.commit);
  assert.equal(Object.hasOwn(evidence.png, "rgba"), false);
  assert.equal(Object.hasOwn(evidence, "data"), false);

  assert.deepEqual(compositorCaptureEvidence(capture), {
    captureBeyondViewport: false,
    captureComplete: false,
    expectedFrames: 8,
    format: "png",
    frames: capture.frames,
    fromSurface: true,
    loaderId: "loader-fresh",
    oracle: null,
    oraclePassed: false,
    protocol: "lazuli-compositor-capture-v2",
    schemaValid: false,
    target: "#display",
    url: runUrl,
    viewport: geometry.viewport,
  });
});

test("first pending frame pins guest geometry after the pre-boot shell", async () => {
  const shellGeometry = compositorGeometry({ bufferHeight: 480, height: 480 });
  const guestGeometry = compositorGeometry();
  let liveGeometry = shellGeometry;
  const release = { commit: "1".repeat(40), releaseId: "2".repeat(64) };
  const context = {
    activeRelease: release,
    navigationLoaderId: "loader",
    options: {},
    runUrl: "https://gekko.free/assets/frontend.html"
      + "?scenario=smb-ready-play&compositorCapture=1&headlessRun=run-1",
  };
  const session = {
    async evaluate() {
      return compositorEnvironment(liveGeometry);
    },
    async send(method) {
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("png").toString("base64") };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { loaderId: "loader" } } };
      }
      assert.fail(`unexpected CDP method ${method}`);
    },
  };
  const observeRelease = async () => release;
  const capture = await initializeCompositorCapture(
    session,
    context,
    { observeRelease },
  );
  assert.equal(capture.baselineLayout, null);

  liveGeometry = guestGeometry;
  await capturePendingCompositorFrame(
    session,
    capture,
    descriptor(guestGeometry),
    context,
    {
      async acknowledge() {},
      decodePng() {
        return {
          width: 640,
          height: 448,
          sourceColorType: "rgba8",
          format: "rgba8unorm",
          layout: "top-left-row-major-tight",
          pngByteLength: 3,
          pngSha256: "3".repeat(64),
          rgbaByteLength: 640 * 448 * 4,
          rgbaSha256: "4".repeat(64),
          rgbSha256: "5".repeat(64),
          rgb: { black: 0, white: 0, other: 640 * 448, unique: 32 },
          rgba: Buffer.alloc(4),
        };
      },
      observeRelease,
    },
  );
  assert.deepEqual(capture.baselineLayout, {
    canvas: {
      bottom: 608,
      height: 448,
      left: 192,
      right: 832,
      top: 160,
      width: 640,
    },
    viewport: guestGeometry.viewport,
  });

  liveGeometry = compositorGeometry({
    bufferHeight: 224,
    bufferWidth: 320,
    height: 224,
    width: 320,
  });
  await assert.rejects(
    capturePendingCompositorFrame(
      session,
      capture,
      { ...descriptor(liveGeometry), ordinal: 2, rendererSequence: 42, presentationSerial: 43 },
      context,
      { observeRelease },
    ),
    /geometry changed during compositor capture/,
  );
});

test("transport rejects scaled geometry and invalid live provenance", async () => {
  const scaled = compositorGeometry({ height: 576, width: 768 });
  await assert.rejects(
    initializeCompositorCapture(
      { async evaluate() { return compositorEnvironment(scaled); } },
      {
        activeRelease: {},
        navigationLoaderId: "loader",
        options: {},
        runUrl: "https://example.test/",
      },
      { async observeRelease() { return {}; } },
    ),
    /CSS dimensions must be one-to-one/,
  );

  const geometry = compositorGeometry();
  const capture = {
    baselineLayout: {
      canvas: {
        bottom: geometry.canvas.bottom,
        height: geometry.canvas.height,
        left: geometry.canvas.left,
        right: geometry.canvas.right,
        top: geometry.canvas.top,
        width: geometry.canvas.width,
      },
      viewport: geometry.viewport,
    },
    frames: [],
  };
  await assert.rejects(
    capturePendingCompositorFrame(
      { async evaluate() { return compositorEnvironment(geometry); } },
      capture,
      { ...descriptor(geometry), generation: 0 },
      {
        activeRelease: {},
        navigationLoaderId: "loader",
        options: {},
        runUrl: "https://example.test/",
      },
      { async observeRelease() { return {}; } },
    ),
    /generation must be positive/,
  );
});
