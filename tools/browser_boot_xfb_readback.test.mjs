// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);
const rendererSource = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name}`);
  const start = source.slice(functionStart - 6, functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function evaluate(names, values = {}) {
  const context = {
    Array,
    Error,
    Number,
    Object,
    Promise,
    rendererHostMetrics: {
      operations: { enqueued: 0, pending: 0, highWater: 0 },
    },
    Set,
    String,
    Uint8Array,
    crypto: webcrypto,
    ...values,
  };
  vm.createContext(context);
  vm.runInContext(names.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.xfb-readback.js",
  });
  return context;
}

test("presented XFB color statistics classify exact RGB values", () => {
  const context = evaluate(["summarizePresentedXfbRgba"]);
  const pixels = new Uint8Array([
    0, 0, 0, 0,
    255, 255, 255, 255,
    1, 2, 3, 255,
    1, 2, 3, 0,
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.summarizePresentedXfbRgba(pixels, 2, 2))),
    { black: 1, white: 1, other: 2, unique: 3 },
  );
  assert.throws(
    () => context.summarizePresentedXfbRgba(pixels.subarray(0, 12), 2, 2),
    /invalid tight RGBA8 layout/,
  );
});

test("presented XFB SHA-256 covers alpha and every tight RGBA byte", async () => {
  const context = evaluate(["sha256Hex", "presentedXfbRgbBytes"]);
  const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(
    await context.sha256Hex(pixels),
    createHash("sha256").update(pixels).digest("hex"),
  );
  const alphaChanged = pixels.slice();
  alphaChanged[3] = 9;
  assert.notEqual(await context.sha256Hex(alphaChanged), await context.sha256Hex(pixels));
  assert.equal(
    await context.sha256Hex(context.presentedXfbRgbBytes(alphaChanged, 2, 1)),
    await context.sha256Hex(context.presentedXfbRgbBytes(pixels, 2, 1)),
  );
});

test("selected XFB capture waits behind renderer work and returns compact diagnostics", async () => {
  const calls = [];
  let releaseRenderer;
  const rendererOperationTail = new Promise(resolve => { releaseRenderer = resolve; });
  const rgba = new Uint8Array([
    0, 0, 0, 255,
    12, 34, 56, 255,
  ]);
  const context = evaluate(
    [
      "appendRendererOperation",
      "sha256Hex",
      "presentedXfbRgbBytes",
      "summarizePresentedXfbRgba",
      "readSelectedXfb",
      "captureSelectedXfb",
    ],
    {
      rendererOperationTail,
      webGpuRenderer: {
        has_presented_xfb() { calls.push("has"); return true; },
        read_presented_xfb_rgba() {
          calls.push("read");
          return {
            address: 0x01200500,
            generation: 7,
            row: 1,
            format: "rgba8unorm",
            layout: "top-left-row-major-tight",
            sourceRow: 1,
            width: 2,
            height: 1,
            textureWidth: 2,
            textureHeight: 2,
            logicalWidth: 2,
            logicalHeight: 2,
            displayWidth: 640,
            displayHeight: 480,
            rgba,
          };
        },
      },
    },
  );

  const pending = context.captureSelectedXfb();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  releaseRenderer();
  const capture = await pending;
  assert.deepEqual(calls, ["has", "read"]);
  assert.deepEqual(context.rendererHostMetrics.operations, {
    enqueued: 0,
    pending: 0,
    highWater: 0,
  });
  assert.equal(capture.address, "0x01200500");
  assert.equal(capture.rgbaByteLength, 8);
  assert.equal(capture.rgbaSha256, createHash("sha256").update(rgba).digest("hex"));
  assert.equal(
    capture.rgbSha256,
    createHash("sha256").update(new Uint8Array([0, 0, 0, 12, 34, 56])).digest("hex"),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(capture.rgb)), {
    black: 1,
    white: 0,
    other: 1,
    unique: 2,
  });
  assert.equal("rgba" in capture, false);
});

test("selected XFB capture reports no image after a renderer reset", async () => {
  let reads = 0;
  const context = evaluate(
    [
      "appendRendererOperation",
      "sha256Hex",
      "presentedXfbRgbBytes",
      "summarizePresentedXfbRgba",
      "readSelectedXfb",
      "captureSelectedXfb",
    ],
    {
      rendererOperationTail: Promise.resolve(),
      webGpuRenderer: {
        has_presented_xfb() { return false; },
        read_presented_xfb_rgba() { reads += 1; },
      },
    },
  );
  assert.equal(await context.captureSelectedXfb(), null);
  assert.equal(reads, 0);
});

test("presented surface capture returns canonical tight RGBA evidence", async () => {
  const rgba = new Uint8Array([
    0, 0, 0, 255,
    255, 255, 255, 255,
  ]);
  const context = evaluate(
    [
      "sha256Hex",
      "presentedXfbRgbBytes",
      "summarizePresentedXfbRgba",
      "readPresentedSurface",
    ],
    {
      webGpuRenderer: {
        has_presented_surface() { return true; },
        read_presented_surface_rgba() {
          return {
            address: 0x01200500,
            generation: 71,
            row: 1,
            presentationSerial: 400,
            surfaceFormat: "bgra8unorm-srgb",
            format: "rgba8unorm",
            layout: "top-left-row-major-tight",
            width: 2,
            height: 1,
            rgba,
          };
        },
      },
    },
  );
  const capture = await context.readPresentedSurface();
  assert.equal(capture.address, "0x01200500");
  assert.equal(capture.presentationSerial, 400);
  assert.equal(capture.surfaceFormat, "bgra8unorm-srgb");
  assert.equal(capture.rgbaByteLength, 8);
  assert.equal(capture.rgbaSha256, createHash("sha256").update(rgba).digest("hex"));
  assert.deepEqual(JSON.parse(JSON.stringify(capture.rgb)), {
    black: 1,
    white: 1,
    other: 0,
    unique: 2,
  });
  assert.equal("rgba" in capture, false);

  const originalRead = context.webGpuRenderer.read_presented_surface_rgba;
  await assert.rejects(
    async () => {
      context.webGpuRenderer.read_presented_surface_rgba = () => ({
        ...originalRead(),
        surfaceFormat: "rgb10a2unorm",
      });
      await context.readPresentedSurface();
    },
    /unsupported format/,
  );
});

test("temporal selected XFB capture preserves ordered presentation provenance", async () => {
  const selectedXfb = {
    address: "0x01200500",
    generation: 71,
    row: 1,
    width: 640,
    height: 480,
    rgbaSha256: "abc",
    rgbSha256: "rgb-abc",
    displayWidth: 640,
    displayHeight: 480,
    rgb: { black: 0, white: 0, other: 307_200, unique: 4096 },
  };
  const presentedSurface = {
    address: "0x01200500",
    generation: 71,
    row: 1,
    presentationSerial: 90,
    width: 640,
    height: 480,
    rgbaSha256: "surface-abc",
    rgbSha256: "surface-rgb-abc",
    rgb: { black: 0, white: 0, other: 307_200, unique: 4096 },
  };
  let selectedReads = 0;
  let surfaceReads = 0;
  const context = evaluate(["captureTemporalSelectedXfb"], {
    temporalSelectedXfbCapacity: 8,
    temporalSelectedXfbFrames: [],
    async readSelectedXfb() {
      selectedReads += 1;
      return selectedXfb;
    },
    async readPresentedSurface() {
      surfaceReads += 1;
      return presentedSurface;
    },
  });
  const message = {
    type: "vi-present",
    rendererSequence: 44,
    frame: {
      field: "bottom",
      address: 0x01200500,
      copyIndex: 71,
      copyRow: 1,
      width: 640,
      height: 480,
      temporalXfbCapture: {
        scenario: "smb-ready-play",
        step: "post-play-presented",
        ordinal: 1,
        capacity: 8,
      },
    },
  };

  const capture = await context.captureTemporalSelectedXfb(message, true);
  assert.equal(selectedReads, 1);
  assert.equal(surfaceReads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(capture)), {
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: 1,
    rendererSequence: 44,
    presentation: {
      selected: true,
      field: "bottom",
      address: "0x01200500",
      copyIndex: 71,
      copyRow: 1,
      width: 640,
      height: 480,
    },
    selectedXfb,
    presentedSurface,
  });
  assert.strictEqual(context.temporalSelectedXfbFrames[0].selectedXfb, selectedXfb);
  assert.strictEqual(
    context.temporalSelectedXfbFrames[0].presentedSurface,
    presentedSurface,
  );

  await assert.rejects(
    context.captureTemporalSelectedXfb({
      ...message,
      rendererSequence: 45,
      frame: {
        ...message.frame,
        temporalXfbCapture: { ...message.frame.temporalXfbCapture, ordinal: 3 },
      },
    }, true),
    /invalid temporal selected-XFB capture request/,
  );
  assert.equal(selectedReads, 1, "invalid ordering must fail before another readback");
  assert.equal(surfaceReads, 1, "invalid ordering must fail before another readback");
  await assert.rejects(
    context.captureTemporalSelectedXfb({
      ...message,
      type: "gx-frame",
      rendererSequence: 45,
      frame: {
        ...message.frame,
        temporalXfbCapture: { ...message.frame.temporalXfbCapture, ordinal: 2 },
      },
    }, true),
    /invalid temporal selected-XFB capture request/,
  );
  assert.equal(selectedReads, 1, "invalid frame type must fail before another readback");
  assert.equal(surfaceReads, 1, "invalid frame type must fail before another readback");
  await assert.rejects(
    context.captureTemporalSelectedXfb({
      ...message,
      rendererSequence: 45,
      frame: {
        ...message.frame,
        width: Number.NaN,
        temporalXfbCapture: { ...message.frame.temporalXfbCapture, ordinal: 2 },
      },
    }, true),
    /invalid temporal selected-XFB capture request/,
  );
  assert.equal(selectedReads, 1, "invalid VI dimensions must fail before another readback");
  assert.equal(surfaceReads, 1, "invalid VI dimensions must fail before another readback");
});

test("temporal surface capture fails before renderer acknowledgement when unavailable", async () => {
  const context = evaluate(["captureTemporalSelectedXfb"], {
    temporalSelectedXfbCapacity: 8,
    temporalSelectedXfbFrames: [],
    async readSelectedXfb() { return {}; },
    async readPresentedSurface() { return null; },
  });
  await assert.rejects(
    context.captureTemporalSelectedXfb({
      type: "vi-present",
      rendererSequence: 1,
      frame: {
        field: "top",
        address: 0x01200500,
        copyIndex: 1,
        copyRow: 0,
        width: 640,
        height: 480,
        temporalXfbCapture: {
          scenario: "smb-ready-play",
          step: "post-play-presented",
          ordinal: 1,
          capacity: 8,
        },
      },
    }, true),
    /presented-surface capture is unavailable/,
  );
  assert.deepEqual(context.temporalSelectedXfbFrames, []);
});

test("swapchain capture is opt-in and copied in the presentation encoder", () => {
  const start = rendererSource.indexOf("pub fn present_xfb");
  const end = rendererSource.indexOf("\n}\n\nimpl WebGpuRenderer", start);
  const present = rendererSource.slice(start, end);
  assert.match(present, /capture_surface: bool/);
  assert.match(present, /requested_surface_readback_layout\(\s*capture_surface,/);
  assert.match(present, /let surface_capture = capture_plan\.map/);
  const allocation = present.indexOf("browser presented surface readback");
  const copy = present.indexOf("encoder.copy_texture_to_buffer", allocation);
  const submit = present.indexOf("self.queue.submit", copy);
  const browserPresent = present.indexOf("output.present()", submit);
  assert.ok(allocation > present.indexOf("capture_plan.map"));
  assert.ok(allocation < copy && copy < submit && submit < browserPresent);
  assert.ok(
    present.indexOf("self.last_presented_surface = None")
      < present.indexOf("if selected_address == 0"),
    "every attempted presentation clears stale surface evidence",
  );
  const resetStart = rendererSource.indexOf("pub fn reset(&mut self)");
  const resetEnd = rendererSource.indexOf("pub fn reset_diagnostics", resetStart);
  assert.match(
    rendererSource.slice(resetStart, resetEnd),
    /self\.last_presented_surface = None/,
  );
  assert.match(source, /frame\.temporalXfbCapture !== undefined\s*\)\s*,/);
});

test("wgpu WebSurface under-reporting cannot disable the required COPY_SRC usage", () => {
  const start = rendererSource.indexOf("let surface_config = wgpu::SurfaceConfiguration");
  const end = rendererSource.indexOf("surface.configure(&device, &surface_config)", start);
  const configuration = rendererSource.slice(start, end);
  assert.match(configuration, /wgpu 29's WebSurface advertises only RENDER_ATTACHMENT/);
  assert.match(
    configuration,
    /usage: wgpu::TextureUsages::RENDER_ATTACHMENT\s*\|\s*wgpu::TextureUsages::COPY_SRC/,
  );
  assert.doesNotMatch(configuration, /capabilities\.usages/);
  assert.doesNotMatch(rendererSource, /CopySourceUnsupported/);
});

test("temporal selected XFB oracle detects exact monochrome alternation", () => {
  const context = evaluate(["summarizeTemporalSelectedXfb"], {
    temporalSelectedXfbCapacity: 8,
  });
  const frame = (ordinal, rgbaSha256, rgb, generation = 200 + ordinal) => ({
    ordinal,
    rendererSequence: 100 + ordinal,
    presentation: {
      selected: true,
      address: "0x01200000",
      copyIndex: generation,
      copyRow: 0,
      width: 2,
      height: 2,
    },
    selectedXfb: {
      address: "0x01200000",
      generation,
      row: 0,
      width: 2,
      height: 2,
      displayWidth: 2,
      displayHeight: 2,
      rgbaSha256,
      rgbSha256: rgbaSha256,
      rgb,
    },
  });
  const black = { black: 4, white: 0, other: 0, unique: 1 };
  const white = { black: 0, white: 4, other: 0, unique: 1 };
  const alternating = Array.from({ length: 8 }, (_unused, index) =>
    frame(index + 1, index % 2 === 0 ? "black" : "white", index % 2 === 0 ? black : white)
  );

  const oracle = JSON.parse(JSON.stringify(
    context.summarizeTemporalSelectedXfb(alternating),
  ));
  assert.equal(oracle.complete, true);
  assert.equal(oracle.distinctRgbaHashes, 2);
  assert.equal(oracle.distinctRgbHashes, 2);
  assert.equal(oracle.distinctGenerations, 8);
  assert.equal(oracle.distinctCopyIndices, 8);
  assert.deepEqual(oracle.missingOrUnselectedOrdinals, []);
  assert.deepEqual(oracle.mismatchedPresentationOrdinals, []);
  assert.deepEqual(oracle.generationRegressions, []);
  assert.deepEqual(oracle.copyIndexRegressions, []);
  assert.deepEqual(oracle.monochromeOrdinals, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(oracle.blackOrdinals, [1, 3, 5, 7]);
  assert.deepEqual(oracle.whiteOrdinals, [2, 4, 6, 8]);
  assert.equal(oracle.allFramesMonochrome, true);
  assert.equal(oracle.alternatingMonochromePair, true);
  assert.equal(oracle.blackWhiteAlternating, true);

  const alphaOnly = Array.from({ length: 8 }, (_unused, index) => {
    const sample = frame(index + 1, index % 2 === 0 ? "rgba-a" : "rgba-b", black);
    sample.selectedXfb.rgbSha256 = "black-rgb";
    return sample;
  });
  const alphaOnlyOracle = context.summarizeTemporalSelectedXfb(alphaOnly);
  assert.equal(alphaOnlyOracle.distinctRgbaHashes, 2);
  assert.equal(alphaOnlyOracle.distinctRgbHashes, 1);
  assert.equal(alphaOnlyOracle.alternatingMonochromePair, false);
  assert.equal(alphaOnlyOracle.blackWhiteAlternating, false);

  alternating[3] = frame(4, "gameplay", {
    black: 0,
    white: 0,
    other: 4,
    unique: 4,
  });
  alternating[5].presentation.selected = false;
  const mixed = context.summarizeTemporalSelectedXfb(alternating);
  assert.equal(mixed.allFramesMonochrome, false);
  assert.equal(mixed.alternatingMonochromePair, false);
  assert.equal(mixed.blackWhiteAlternating, false);
  assert.deepEqual(Array.from(mixed.missingOrUnselectedOrdinals), [6]);
});
