// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveCompositorCaptureOracle,
  verifyCompositorCaptureReport,
} from "./browser_boot_headless_compositor_oracle.mjs";

const WIDTH = 640;
const HEIGHT = 448;
const PIXELS = WIDTH * HEIGHT;
const RUN_URL = "https://gekko.free/assets/frontend.html"
  + "?scenario=smb-ready-play&compositorCapture=1&headlessRun=run-1";

function hash(index) {
  return (index + 1).toString(16).padStart(64, "0");
}

function geometry() {
  return {
    canvas: {
      bufferWidth: WIDTH,
      bufferHeight: HEIGHT,
      left: 192,
      top: 160,
      right: 832,
      bottom: 608,
      width: WIDTH,
      height: HEIGHT,
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

function validReport() {
  const release = { commit: "1".repeat(40), releaseId: "2".repeat(64) };
  const frames = [];
  const temporal = [];
  for (let index = 0; index < 8; index += 1) {
    const ordinal = index + 1;
    const frameGeometry = geometry();
    const rgbSha256 = hash(100 + index);
    const rgbaSha256 = hash(200 + index);
    const descriptor = {
      protocol: "lazuli-compositor-capture-v1",
      token: `run-1:${ordinal}:${300 + index}`,
      scenario: "smb-ready-play",
      step: "post-play-presented",
      ordinal,
      rendererSequence: 300 + index,
      presentationSerial: 200 + index,
      address: "0x81234567",
      generation: 100 + index,
      row: index % 2,
      width: WIDTH,
      height: HEIGHT,
      geometry: frameGeometry,
    };
    frames.push({
      clip: { height: HEIGHT, scale: 1, width: WIDTH, x: 192, y: 160 },
      descriptor,
      loaderId: "loader-fresh",
      png: {
        width: WIDTH,
        height: HEIGHT,
        sourceColorType: "rgba8",
        format: "rgba8unorm",
        layout: "top-left-row-major-tight",
        pngByteLength: 10_000 + index,
        pngSha256: hash(300 + index),
        rgbaByteLength: PIXELS * 4,
        rgbaSha256,
        rgbSha256,
        rgb: { black: 0, white: 0, other: PIXELS, unique: 64 + index },
      },
      releaseCommit: release.commit,
      releaseId: release.releaseId,
      url: RUN_URL,
    });
    temporal.push({
      ordinal,
      rendererSequence: descriptor.rendererSequence,
      presentedSurface: {
        address: descriptor.address,
        generation: descriptor.generation,
        row: descriptor.row,
        width: WIDTH,
        height: HEIGHT,
        presentationSerial: descriptor.presentationSerial,
        rgbSha256,
      },
    });
  }
  return {
    rendering: { temporalSelectedXfb: { frames: temporal } },
    headlessCapture: {
      release,
      url: RUN_URL,
      compositor: {
        captureBeyondViewport: false,
        captureComplete: false,
        expectedFrames: 8,
        format: "png",
        frames,
        fromSurface: true,
        loaderId: "loader-fresh",
        oracle: null,
        oraclePassed: false,
        protocol: "lazuli-compositor-capture-v1",
        schemaValid: false,
        target: "#display",
        url: RUN_URL,
        viewport: geometry().viewport,
      },
    },
  };
}

test("eight exact compositor screenshots join terminal surface content", () => {
  const report = validReport();
  const oracle = verifyCompositorCaptureReport(report, { compositorCapture: true });
  assert.deepEqual(oracle, {
    adjacentExactBlackWhiteTransitions: [],
    captured: 8,
    distinctRgbHashes: 8,
    distinctRgbaHashes: 8,
    singleFrameMonochromeOrdinals: [],
    surfaceRgbMismatchOrdinals: [],
  });
  assert.equal(report.headlessCapture.compositor.captureComplete, true);
  assert.equal(report.headlessCapture.compositor.schemaValid, true);
  assert.equal(report.headlessCapture.compositor.oraclePassed, true);
  assert.strictEqual(report.headlessCapture.compositor.oracle, oracle);
  assert.deepEqual(
    deriveCompositorCaptureOracle(
      report.headlessCapture.compositor.frames,
      report.rendering.temporalSelectedXfb.frames,
    ),
    oracle,
  );
});

test("content mismatch persists a failed derived oracle after valid capture schema", () => {
  const report = validReport();
  report.headlessCapture.compositor.frames[3].png.rgbSha256 = hash(999);
  assert.throws(
    () => verifyCompositorCaptureReport(report, { compositorCapture: true }),
    /does not match the presented surface at ordinal 4/,
  );
  assert.equal(report.headlessCapture.compositor.captureComplete, true);
  assert.equal(report.headlessCapture.compositor.schemaValid, true);
  assert.equal(report.headlessCapture.compositor.oraclePassed, false);
  assert.deepEqual(
    report.headlessCapture.compositor.oracle.surfaceRgbMismatchOrdinals,
    [4],
  );
});

test("duplicate and monochrome screenshots fail only the derived oracle", () => {
  const duplicate = validReport();
  const duplicatePng = duplicate.headlessCapture.compositor.frames[0].png;
  const duplicateSurface = duplicate.rendering.temporalSelectedXfb.frames[0].presentedSurface;
  duplicate.headlessCapture.compositor.frames[1].png.rgbSha256 = duplicatePng.rgbSha256;
  duplicate.headlessCapture.compositor.frames[1].png.rgbaSha256 = duplicatePng.rgbaSha256;
  duplicate.rendering.temporalSelectedXfb.frames[1].presentedSurface.rgbSha256
    = duplicateSurface.rgbSha256;
  assert.throws(
    () => verifyCompositorCaptureReport(duplicate, { compositorCapture: true }),
    /expected 8 distinct RGB screenshots, got 7/,
  );
  assert.equal(duplicate.headlessCapture.compositor.captureComplete, true);
  assert.equal(duplicate.headlessCapture.compositor.schemaValid, true);
  assert.equal(duplicate.headlessCapture.compositor.oraclePassed, false);
  assert.equal(duplicate.headlessCapture.compositor.oracle.distinctRgbHashes, 7);
  assert.equal(duplicate.headlessCapture.compositor.oracle.distinctRgbaHashes, 7);

  const monochrome = validReport();
  monochrome.headlessCapture.compositor.frames[3].png.rgb = {
    black: PIXELS,
    white: 0,
    other: 0,
    unique: 1,
  };
  assert.throws(
    () => verifyCompositorCaptureReport(monochrome, { compositorCapture: true }),
    /monochrome screenshot at ordinal 4/,
  );
  assert.equal(monochrome.headlessCapture.compositor.captureComplete, true);
  assert.equal(monochrome.headlessCapture.compositor.schemaValid, true);
  assert.equal(monochrome.headlessCapture.compositor.oraclePassed, false);
  assert.deepEqual(
    monochrome.headlessCapture.compositor.oracle.singleFrameMonochromeOrdinals,
    [4],
  );
});

test("schema, clip, loader, URL, and release corruption fail before oracle trust", () => {
  const corruptions = [
    report => { report.headlessCapture.compositor.frames[0].png.extra = true; },
    report => { report.headlessCapture.compositor.frames[0].png.rgbaByteLength -= 1; },
    report => { report.headlessCapture.compositor.frames[0].png.rgb.other -= 1; },
    report => { report.headlessCapture.compositor.frames[0].clip.x += 1; },
    report => { report.headlessCapture.compositor.frames[0].loaderId = "loader-stale"; },
    report => { report.headlessCapture.compositor.frames[0].url += "&headlessRun=duplicate"; },
    report => { report.headlessCapture.compositor.frames[0].releaseId = "3".repeat(64); },
  ];
  for (const corrupt of corruptions) {
    const report = validReport();
    corrupt(report);
    assert.throws(
      () => verifyCompositorCaptureReport(report, { compositorCapture: true }),
      error => error?.name === "CompositorCaptureError",
    );
    assert.equal(report.headlessCapture.compositor.captureComplete, false);
    assert.equal(report.headlessCapture.compositor.schemaValid, false);
    assert.equal(report.headlessCapture.compositor.oraclePassed, false);
    assert.equal(report.headlessCapture.compositor.oracle, null);
  }
});
