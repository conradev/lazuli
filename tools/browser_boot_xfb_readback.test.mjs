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
const rendererLibSource = readFileSync(
  new URL("../crates/browser-renderer/src/lib.rs", import.meta.url),
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
    lastPresentedViProjection: null,
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

function rawPresentedField({
  address,
  generation,
  row,
  surfaceId,
  scanoutPolicy,
  fieldStrideBytes,
  sourceRowStep,
  fieldHeight,
  rowRepeat,
  logicalWidth,
  logicalHeight,
}) {
  return {
    address,
    generation,
    row,
    sourceRow: row,
    surfaceId,
    textureWidth: logicalWidth,
    textureHeight: logicalHeight,
    logicalWidth,
    logicalHeight,
    displayHeight: fieldHeight * rowRepeat,
    scanoutPolicy,
    fieldStrideBytes,
    sourceRowStep,
    fieldHeight,
    rowRepeat,
  };
}

function rawSingleFieldFrame(extra = {}) {
  return {
    pairEpoch: 12,
    presentationMode: "single-field",
    scanoutPolicy: "direct",
    displayWidth: 2,
    displayHeight: 1,
    fields: {
      top: rawPresentedField({
        address: 0x01200000,
        generation: 7,
        row: 0,
        surfaceId: 3,
        scanoutPolicy: "direct",
        fieldStrideBytes: 8,
        sourceRowStep: 1,
        fieldHeight: 1,
        rowRepeat: 1,
        logicalWidth: 2,
        logicalHeight: 1,
      }),
    },
    ...extra,
  };
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
  let rawPresentationSerial = 12;
  const context = evaluate(
    [
      "appendRendererOperation",
      "requireTextureCopyReceiptArray",
      "requireNoTextureCopyReceipts",
      "drainWebGpuRenderer",
      "sha256Hex",
      "presentedXfbRgbBytes",
      "summarizePresentedXfbRgba",
      "viScanoutProvenance",
      "readPresentedFieldProvenance",
      "readPresentedFrameProvenance",
      "presentedFieldRows",
      "summarizePresentedFieldRows",
      "attachPresentedFieldEvidence",
      "legacyPresentedXfbProjection",
      "readSelectedXfb",
      "captureSelectedXfb",
    ],
    {
      rendererOperationTail,
      webGpuRenderer: {
        drain() { calls.push("drain"); return Promise.resolve([]); },
        check_health() { calls.push("health"); },
        has_presented_xfb() { calls.push("has"); return true; },
        read_presented_xfb_rgba() {
          calls.push("read");
          return rawSingleFieldFrame({
            presentationSerial: rawPresentationSerial,
            format: "rgba8unorm",
            layout: "top-left-row-major-tight",
            width: 2,
            height: 1,
            rgba,
          });
        },
      },
    },
  );

  const pending = context.captureSelectedXfb();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  releaseRenderer();
  const capture = await pending;
  assert.deepEqual(calls, ["drain", "health", "has", "read"]);
  assert.deepEqual(context.rendererHostMetrics.operations, {
    enqueued: 0,
    pending: 0,
    highWater: 0,
  });
  assert.equal(capture.fields.top.address, "0x01200000");
  assert.equal(capture.pairEpoch, 12);
  assert.equal(capture.compositionPolicy, "direct");
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
  assert.equal("presentationSerial" in capture, false);
  const pairedCapture = await context.readSelectedXfb(true);
  assert.equal(pairedCapture.presentationSerial, 12);
  for (const invalid of [undefined, 0, Number.MAX_SAFE_INTEGER + 1]) {
    rawPresentationSerial = invalid;
    await assert.rejects(
      context.readSelectedXfb(true),
      /presentation serial is invalid/,
    );
  }
});

test("selected XFB capture reports no image after a renderer reset", async () => {
  let reads = 0;
  const context = evaluate(
    [
      "appendRendererOperation",
      "requireTextureCopyReceiptArray",
      "requireNoTextureCopyReceipts",
      "drainWebGpuRenderer",
      "sha256Hex",
      "presentedXfbRgbBytes",
      "summarizePresentedXfbRgba",
      "readSelectedXfb",
      "captureSelectedXfb",
    ],
    {
      rendererOperationTail: Promise.resolve(),
      webGpuRenderer: {
        drain() { return Promise.resolve([]); },
        check_health() {},
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
      "viScanoutProvenance",
      "readPresentedFieldProvenance",
      "readPresentedFrameProvenance",
      "presentedFieldRows",
      "summarizePresentedFieldRows",
      "attachPresentedFieldEvidence",
      "legacyPresentedXfbProjection",
      "summarizePresentedSurfaceCapture",
      "readPresentedSurface",
    ],
    {
      webGpuRenderer: {
        has_presented_surface() { return true; },
        read_presented_surface_rgba() {
          return rawSingleFieldFrame({
            presentationSerial: 400,
            surfaceFormat: "bgra8unorm-srgb",
            format: "rgba8unorm",
            layout: "top-left-row-major-tight",
            width: 2,
            height: 1,
            rgba,
          });
        },
      },
    },
  );
  const capture = await context.readPresentedSurface();
  assert.equal(capture.fields.top.address, "0x01200000");
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
  const scanout = {
    scanoutPolicy: "bob",
    fieldStrideBytes: 0x0a00,
    sourceRowStep: 2,
    fieldHeight: 224,
    rowRepeat: 2,
  };
  const pairEpoch = 9;
  const topExpected = {
    field: "top",
    address: 0x01200000,
    copyIndex: 70,
    copyRow: 0,
    width: 640,
    height: 448,
    ...scanout,
  };
  const bottomExpected = {
    field: "bottom",
    address: 0x01200500,
    copyIndex: 71,
    copyRow: 1,
    width: 640,
    height: 448,
    ...scanout,
  };
  const topPresented = rawPresentedField({
    address: topExpected.address,
    generation: topExpected.copyIndex,
    row: topExpected.copyRow,
    surfaceId: 5,
    logicalWidth: 640,
    logicalHeight: 448,
    ...scanout,
  });
  const bottomPresented = rawPresentedField({
    address: bottomExpected.address,
    generation: bottomExpected.copyIndex,
    row: bottomExpected.copyRow,
    surfaceId: 6,
    logicalWidth: 640,
    logicalHeight: 448,
    ...scanout,
  });
  const frameProvenance = {
    pairEpoch,
    presentationMode: "interlaced",
    compositionPolicy: "field-pair-weave",
    displayWidth: 640,
    displayHeight: 448,
    fields: {
      top: {
        ...topPresented,
        address: "0x01200000",
      },
      bottom: {
        ...bottomPresented,
        address: "0x01200500",
      },
    },
  };
  const selectedXfb = {
    ...frameProvenance,
    presentationSerial: 90,
    width: 640,
    height: 448,
    rgbaSha256: "abc",
    rgbSha256: "rgb-abc",
    rgb: { black: 0, white: 0, other: 286_720, unique: 4096 },
  };
  const selectedXfbEvidence = { ...selectedXfb };
  const presentedSurface = {
    ...frameProvenance,
    presentationSerial: 90,
    width: 640,
    height: 448,
    rgbaSha256: "surface-abc",
    rgbSha256: "surface-rgb-abc",
    rgb: { black: 0, white: 0, other: 286_720, unique: 4096 },
  };
  let selectedReads = 0;
  let surfaceReads = 0;
  const context = evaluate([
    "viScanoutProvenance",
    "viScanoutProvenanceEqual",
    "expectedViPairField",
    "expectedViPairFields",
    "presentedFieldMatchesExpected",
    "captureTemporalSelectedXfb",
  ], {
    temporalSelectedXfbCapacity: 8,
    temporalSelectedXfbFrames: [],
    async readSelectedXfb(includePresentationSerial) {
      assert.equal(includePresentationSerial, true);
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
      presentationMode: "interlaced",
      pairEpoch,
      pairCompleting: true,
      pairFields: {
        top: topExpected,
        bottom: bottomExpected,
      },
      address: 0x01200500,
      copyIndex: 71,
      copyRow: 1,
      width: 640,
      height: 448,
      pictureConfiguration: 0x2850,
      wordsPerLine: 40,
      standardWordsPerLine: 80,
      activeLines: 224,
      nonInterlaced: false,
      ...scanout,
      temporalXfbCapture: {
        scenario: "smb-ready-play",
        step: "post-play-presented",
        ordinal: 1,
        capacity: 8,
      },
    },
  };
  const presentationResult = {
    accepted: true,
    presented: true,
    status: "vi-interlaced-frame-ready",
    pairEpoch,
    presentationSerial: 90,
  };

  const capture = await context.captureTemporalSelectedXfb(
    message,
    presentationResult,
  );
  assert.equal(selectedReads, 1);
  assert.equal(surfaceReads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(capture)), {
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: 1,
    rendererSequence: 44,
    presentation: {
      selected: true,
      status: "vi-interlaced-frame-ready",
      presentationMode: "interlaced",
      pairEpoch,
      presentationSerial: 90,
      completionField: "bottom",
      compositionPolicy: "field-pair-weave",
      fields: {
        top: {
          ...topExpected,
          address: "0x01200000",
        },
        bottom: {
          ...bottomExpected,
          address: "0x01200500",
        },
      },
      field: "bottom",
      address: "0x01200500",
      copyIndex: 71,
      copyRow: 1,
      width: 640,
      height: 448,
      pictureConfiguration: 0x2850,
      wordsPerLine: 40,
      standardWordsPerLine: 80,
      activeLines: 224,
      nonInterlaced: false,
      ...scanout,
    },
    selectedXfb: selectedXfbEvidence,
    presentedSurface,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.temporalSelectedXfbFrames[0].selectedXfb)),
    selectedXfbEvidence,
  );
  assert.strictEqual(context.temporalSelectedXfbFrames[0].selectedXfb, selectedXfb);
  assert.equal(
    "presentationSerial" in context.temporalSelectedXfbFrames[0].selectedXfb,
    true,
  );
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
    }, presentationResult),
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
    }, presentationResult),
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
    }, presentationResult),
    /invalid temporal selected-XFB capture request/,
  );
  assert.equal(selectedReads, 1, "invalid VI dimensions must fail before another readback");
  assert.equal(surfaceReads, 1, "invalid VI dimensions must fail before another readback");

  const mismatches = [
    [selectedXfb, "presentationSerial", 91],
    [selectedXfb, "pairEpoch", 10],
    [selectedXfb.fields.bottom, "address", "0x01200504"],
    [selectedXfb.fields.bottom, "generation", 72],
    [selectedXfb.fields.bottom, "row", 0],
  ];
  for (const [target, field, invalid] of mismatches) {
    const prior = target[field];
    target[field] = invalid;
    await assert.rejects(
      context.captureTemporalSelectedXfb({
        ...message,
        rendererSequence: 45,
        frame: {
          ...message.frame,
          temporalXfbCapture: { ...message.frame.temporalXfbCapture, ordinal: 2 },
        },
      }, presentationResult),
      /presentation identity does not match/,
    );
    target[field] = prior;
  }
  assert.equal(selectedReads, 1 + mismatches.length);
  assert.equal(surfaceReads, 1 + mismatches.length);
  assert.equal(context.temporalSelectedXfbFrames.length, 1);
});

test("temporal surface capture fails before renderer acknowledgement when unavailable", async () => {
  const context = evaluate([
    "viScanoutProvenance",
    "viScanoutProvenanceEqual",
    "expectedViPairField",
    "expectedViPairFields",
    "presentedFieldMatchesExpected",
    "captureTemporalSelectedXfb",
  ], {
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
        field: "bottom",
        presentationMode: "interlaced",
        pairEpoch: 1,
        pairCompleting: true,
        pairFields: {
          top: {
            field: "top",
            address: 0x01200000,
            copyIndex: 1,
            copyRow: 0,
            width: 640,
            height: 448,
            scanoutPolicy: "bob",
            fieldStrideBytes: 0x0a00,
            sourceRowStep: 2,
            fieldHeight: 224,
            rowRepeat: 2,
          },
          bottom: {
            field: "bottom",
            address: 0x01200500,
            copyIndex: 2,
            copyRow: 1,
            width: 640,
            height: 448,
            scanoutPolicy: "bob",
            fieldStrideBytes: 0x0a00,
            sourceRowStep: 2,
            fieldHeight: 224,
            rowRepeat: 2,
          },
        },
        address: 0x01200500,
        copyIndex: 2,
        copyRow: 1,
        width: 640,
        height: 448,
        pictureConfiguration: 0x2850,
        wordsPerLine: 40,
        standardWordsPerLine: 80,
        activeLines: 224,
        nonInterlaced: false,
        scanoutPolicy: "bob",
        fieldStrideBytes: 0x0a00,
        sourceRowStep: 2,
        fieldHeight: 224,
        rowRepeat: 2,
        temporalXfbCapture: {
          scenario: "smb-ready-play",
          step: "post-play-presented",
          ordinal: 1,
          capacity: 8,
        },
      },
    }, {
      accepted: true,
      presented: true,
      status: "vi-interlaced-frame-ready",
      pairEpoch: 1,
      presentationSerial: 1,
    }),
    /presented-surface capture is unavailable/,
  );
  assert.deepEqual(context.temporalSelectedXfbFrames, []);
});

test("swapchain capture is opt-in and copied in the presentation encoder", () => {
  const bridgeStart = rendererSource.indexOf("pub fn present_xfb");
  const bridgeEnd = rendererSource.indexOf("\n}\n\nimpl WebGpuRenderer", bridgeStart);
  const bridge = rendererSource.slice(bridgeStart, bridgeEnd);
  const start = rendererSource.indexOf("fn present_host_xfb_frame");
  const end = rendererSource.indexOf("\n    fn xfb_present_bind_group", start);
  const present = rendererSource.slice(start, end);
  assert.match(bridge, /capture_surface: bool/);
  assert.match(bridge, /capture_sustained_surface_history: bool/);
  assert.match(present, /capture_surface: bool/);
  assert.match(present, /capture_sustained_surface_history: bool/);
  assert.match(
    present,
    /requested_surface_readback_layout\(\s*capture_surface \|\| capture_sustained_surface_history,/,
  );
  assert.match(present, /let surface_capture = capture_surface\.then/);
  const helperStart = rendererSource.indexOf("fn encode_presented_surface_readback");
  const helperEnd = rendererSource.indexOf(
    "\nasync fn finish_presented_surface_readback",
    helperStart,
  );
  const helper = rendererSource.slice(helperStart, helperEnd);
  assert.match(helper, /wgpu::BufferUsages::COPY_DST \| wgpu::BufferUsages::MAP_READ/);
  assert.match(helper, /encoder\.copy_texture_to_buffer/);
  const allocation = present.indexOf("browser presented surface readback");
  const submit = present.indexOf("self.queue.submit", allocation);
  const browserPresent = present.indexOf("output.present()", submit);
  assert.ok(allocation > present.indexOf("capture_surface.then"));
  assert.ok(allocation < submit && submit < browserPresent);
  for (const field of ["last_presented_xfb", "last_presented_surface"]) {
    assert.doesNotMatch(
      bridge,
      new RegExp(`self\\.${field} = None`),
      `Awaiting and rejected fields must preserve the last complete ${field}`,
    );
  }
  const resetStart = rendererSource.indexOf("pub fn reset(&mut self)");
  const resetEnd = rendererSource.indexOf("pub fn reset_diagnostics", resetStart);
  const reset = rendererSource.slice(resetStart, resetEnd);
  for (const field of [
    "last_presented_xfb",
    "last_presented_surface",
    "sustained_presented_surface_history",
  ]) {
    const resetStatement = field === "sustained_presented_surface_history"
      ? `self.${field}.reset()`
      : `self.${field} = None`;
    assert.ok(
      reset.indexOf(resetStatement) < reset.indexOf("self.ensure_healthy()?"),
      `reset must clear stale ${field} evidence before its fallible health check`,
    );
  }
  assert.match(
    present,
    /last_presented_xfb = Some\(PresentedXfb \{[\s\S]*presentation_serial: next_presentation_serial/,
    "the selected XFB and swapchain capture must share one presentation serial",
  );
  const selectedReadStart = rendererSource.indexOf("pub fn read_presented_xfb_rgba");
  const selectedReadEnd = rendererSource.indexOf("pub fn has_presented_surface", selectedReadStart);
  assert.match(
    rendererSource.slice(selectedReadStart, selectedReadEnd),
    /"presentationSerial"[\s\S]*presented\.presentation_serial/,
  );
  const viPresentStart = source.indexOf("webGpuRenderer.present_xfb(");
  const viPresentEnd = source.indexOf("\n          )", viPresentStart);
  assert.notEqual(viPresentStart, -1);
  assert.notEqual(viPresentEnd, -1);
  assert.match(
    source.slice(viPresentStart, viPresentEnd),
    /frame\.temporalXfbCapture !== undefined/,
  );
  assert.match(
    source.slice(viPresentStart, viPresentEnd),
    /frame\.sustainedPlayReceipt !== undefined/,
  );
});

test("sustained presented-surface history is exact, ordered, and terminal-only", () => {
  assert.match(
    rendererLibSource,
    /const SUSTAINED_PRESENTED_SURFACE_HISTORY_CAPACITY: usize = 60;/,
  );
  const surfaceStart = rendererSource.indexOf("struct PresentedSurface {");
  const sustainedSurfaceStart = rendererSource.indexOf(
    "struct SustainedPresentedSurface {",
    surfaceStart,
  );
  const sustainedSurfaceEnd = rendererSource.indexOf(
    "\nstruct Pipelines",
    sustainedSurfaceStart,
  );
  assert.notEqual(surfaceStart, -1);
  assert.notEqual(sustainedSurfaceStart, -1);
  assert.notEqual(sustainedSurfaceEnd, -1);
  const ordinarySurface = rendererSource.slice(
    surfaceStart,
    sustainedSurfaceStart,
  );
  const sustainedSurface = rendererSource.slice(
    sustainedSurfaceStart,
    sustainedSurfaceEnd,
  );
  assert.doesNotMatch(
    ordinarySurface,
    /ExactRequiredRejectionSnapshot|exact_required_rejection/,
    "ordinary and temporal captures must not retain sustained diagnostics",
  );
  assert.match(sustainedSurface, /surface:\s*PresentedSurface/);
  assert.match(
    sustainedSurface,
    /exact_required_rejection_interval:\s*ExactRequiredRejectionSnapshot/,
  );
  assert.match(
    rendererSource,
    /SustainedPresentedSurfaceHistory<SustainedPresentedSurface>/,
  );
  const terminalStart = source.indexOf("function captureRendererTerminal(");
  const terminalEnd = source.indexOf(
    "\n    const localIplImageBytes",
    terminalStart,
  );
  const terminal = source.slice(terminalStart, terminalEnd);
  assert.match(
    terminal,
    /terminalReport\?\.status === "paused"[\s\S]*terminalReport\?\.stage === "scenario-complete"[\s\S]*terminalReport\?\.scenario\?\.status === "complete"/,
    "live prefix snapshots must not drain an incomplete sustained history",
  );
  assert.ok(
    terminal.indexOf("const sustainedPlayTerminal")
      < terminal.indexOf("readSmbSustainedPresentedSurfaceHistory()"),
  );
  const publishStart = source.indexOf("async function publishWorkerTerminalReport(");
  const publishEnd = source.indexOf("\n    function handleWorkerMessage", publishStart);
  assert.match(
    source.slice(publishStart, publishEnd),
    /captureRendererTerminal\(\s*hostMetrics,\s*temporalFrames,\s*report\s*\)/,
  );
  const stateStart = rendererLibSource.indexOf(
    "pub(crate) enum SustainedPresentedSurfaceHistory",
  );
  const stateEnd = rendererLibSource.indexOf("\n#[cfg(test)]", stateStart);
  const state = rendererLibSource.slice(stateStart, stateEnd);
  assert.match(
    state,
    /Self::Recording\(Vec::with_capacity\(\s*SUSTAINED_PRESENTED_SURFACE_HISTORY_CAPACITY,/,
  );
  assert.match(
    state,
    /captures\.len\(\) < SUSTAINED_PRESENTED_SURFACE_HISTORY_CAPACITY/,
  );
  assert.match(
    state,
    /captures\.len\(\) == SUSTAINED_PRESENTED_SURFACE_HISTORY_CAPACITY/,
  );
  assert.match(state, /\*self = Self::Failed;/);

  const presentStart = rendererSource.indexOf("fn present_host_xfb_frame");
  const presentEnd = rendererSource.indexOf("\n    fn xfb_present_bind_group", presentStart);
  const present = rendererSource.slice(presentStart, presentEnd);
  const request = present.indexOf(
    ".capture_requested(capture_sustained_surface_history)",
  );
  const acquire = present.indexOf("self.surface.get_current_texture()");
  const snapshot = present.indexOf(
    "let exact_required_rejection_snapshot = self.exact_required_rejection_snapshot()",
  );
  const checkedInterval = present.indexOf(".checked_delta_since(", snapshot);
  const capture = present.indexOf("let sustained_surface_capture");
  const label = present.indexOf("browser sustained presented surface readback", capture);
  const push = present.indexOf(".push(capture)", label);
  const submit = present.indexOf("self.queue.submit", push);
  const browserPresent = present.indexOf("output.present()", submit);
  const healthyPresentation = present.indexOf(
    "self.ensure_healthy()?",
    browserPresent,
  );
  const rollingUpdate = present.indexOf(
    "self.last_presented_exact_required_rejection_snapshot =",
    healthyPresentation,
  );
  assert.ok(
    request > -1 && request < acquire,
    "history continuity and overflow must fail before acquiring a presentation surface",
  );
  assert.ok(
    request < snapshot && snapshot < checkedInterval && checkedInterval < acquire,
    "a sustained interval must fail closed before acquiring a presentation surface",
  );
  assert.ok(
    capture > acquire && capture < label && label < push && push < submit && submit < browserPresent,
    "same-submit capture must be enqueued and recorded before presenting",
  );
  assert.ok(
    browserPresent < healthyPresentation && healthyPresentation < rollingUpdate,
    "the rolling baseline must advance only after a healthy completed presentation",
  );
  for (const forbidden of ["BufferMap::new", "QueueDrain::new", "future_to_promise", ".await"]) {
    assert.doesNotMatch(
      present,
      new RegExp(forbidden.replaceAll(".", "\\.")),
      `live presentation must not contain ${forbidden}`,
    );
  }

  const drainStart = rendererSource.indexOf(
    "pub fn drain_sustained_presented_surface_history_rgba",
  );
  const drainEnd = rendererSource.indexOf(
    "\n    #[allow(clippy::too_many_arguments)]\n    pub fn push_tev_draw",
    drainStart,
  );
  const drain = rendererSource.slice(drainStart, drainEnd);
  const take = drain.indexOf("take_complete()");
  const queueDrain = drain.indexOf("QueueDrain::new(&queue).await");
  const orderedLoop = drain.indexOf("for presented in presented");
  const finish = drain.indexOf(
    "finish_presented_surface_readback(presented.surface, &failure_state).await",
  );
  const interval = drain.indexOf(
    "exact_required_rejection_snapshot_object(",
    finish,
  );
  const publishInterval = drain.indexOf(
    '"exactRequiredRejectionInterval"',
    interval,
  );
  assert.ok(take > -1 && take < queueDrain);
  assert.ok(queueDrain < orderedLoop && orderedLoop < finish);
  assert.ok(finish < interval && interval < publishInterval);
  assert.match(drain, /let result = Array::new\(\)/);
  assert.match(drain, /result\.push\(&capture\)/);

  const intervalSerializerStart = rendererSource.indexOf(
    "fn exact_required_rejection_snapshot_object",
  );
  const intervalSerializerEnd = rendererSource.indexOf(
    "\nfn surface_pixel_order",
    intervalSerializerStart,
  );
  const intervalSerializer = rendererSource.slice(
    intervalSerializerStart,
    intervalSerializerEnd,
  );
  for (const key of ["aggregate", "reasons", "preparationReasons"]) {
    assert.match(intervalSerializer, new RegExp(`"${key}"`));
  }
  assert.match(
    intervalSerializer,
    /for reason in ExactRequiredRejectionReason::ALL/,
  );
  assert.match(
    intervalSerializer,
    /for reason in ExactRequiredPreparationRejectionReason::ALL/,
  );

  const finishStart = rendererSource.indexOf("async fn finish_presented_surface_readback");
  const finishEnd = rendererSource.indexOf(
    "\nstruct EncodedXfbReadback",
    finishStart,
  );
  const finishReadback = rendererSource.slice(finishStart, finishEnd);
  assert.match(finishReadback, /"presentationSerial"/);
  assert.match(finishReadback, /set_presented_frame_provenance/);
  assert.match(finishReadback, /"rgba"/);
  assert.match(finishReadback, /Uint8Array::from\(pixels\.as_slice\(\)\)/);

  const resetStart = rendererSource.indexOf("pub fn reset(&mut self)");
  const diagnosticsResetStart = rendererSource.indexOf(
    "pub fn reset_diagnostics(&mut self)",
    resetStart,
  );
  const diagnosticsResetEnd = rendererSource.indexOf(
    "\n    pub fn diagnostics",
    diagnosticsResetStart,
  );
  const reset = rendererSource.slice(resetStart, diagnosticsResetStart);
  const diagnosticsReset = rendererSource.slice(
    diagnosticsResetStart,
    diagnosticsResetEnd,
  );
  assert.match(
    reset,
    /last_presented_exact_required_rejection_snapshot\s*=\s*self\.exact_required_rejection_snapshot\(\)/,
    "gameplay reset must rebase to diagnostics that survive it",
  );
  assert.match(
    diagnosticsReset,
    /exact_required_preparation_rejection_counts[\s\S]*ExactRequiredPreparationRejectionCounts::default\(\)[\s\S]*last_presented_exact_required_rejection_snapshot\s*=\s*ExactRequiredRejectionSnapshot::default\(\)/,
    "diagnostics reset must zero live details and the rolling baseline together",
  );
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

test("temporal XFB oracle distinguishes opposite source fields from host flicker", () => {
  const context = evaluate([
    "viScanoutProvenanceEqual",
    "presentedFieldMatchesExpected",
    "temporalPairedEvidenceMatches",
    "temporalPairedFieldSummary",
    "summarizeTemporalSelectedXfb",
  ], {
    temporalSelectedXfbCapacity: 8,
  });
  const scanout = {
    scanoutPolicy: "bob",
    fieldStrideBytes: 8,
    sourceRowStep: 2,
    fieldHeight: 1,
    rowRepeat: 2,
  };
  const black = { black: 2, white: 0, other: 0, unique: 1 };
  const white = { black: 0, white: 2, other: 0, unique: 1 };
  const mixed = { black: 2, white: 2, other: 0, unique: 2 };
  const frame = ordinal => {
    const topGeneration = 100 + ordinal;
    const bottomGeneration = 200 + ordinal;
    const top = {
      address: "0x01200000",
      copyIndex: topGeneration,
      copyRow: 0,
      ...scanout,
    };
    const bottom = {
      address: "0x01200500",
      copyIndex: bottomGeneration,
      copyRow: 1,
      ...scanout,
    };
    return {
      ordinal,
      rendererSequence: 1000 + ordinal,
      presentation: {
        selected: true,
        presentationMode: "interlaced",
        pairEpoch: ordinal,
        compositionPolicy: "field-pair-weave",
        completionField: "bottom",
        fields: { top, bottom },
        copyIndex: bottomGeneration,
        width: 2,
        height: 2,
      },
      selectedXfb: {
        pairEpoch: ordinal,
        presentationMode: "interlaced",
        compositionPolicy: "field-pair-weave",
        displayWidth: 2,
        displayHeight: 2,
        width: 2,
        height: 2,
        rgbaSha256: `mixed-rgba-${ordinal}`,
        rgbSha256: `mixed-rgb-${ordinal}`,
        rgb: mixed,
        fields: {
          top: {
            address: top.address,
            generation: topGeneration,
            row: 0,
            width: 2,
            height: 1,
            rgbaSha256: "black-rgba",
            rgbSha256: "black-rgb",
            rgb: black,
            ...scanout,
          },
          bottom: {
            address: bottom.address,
            generation: bottomGeneration,
            row: 1,
            width: 2,
            height: 1,
            rgbaSha256: "white-rgba",
            rgbSha256: "white-rgb",
            rgb: white,
            ...scanout,
          },
        },
      },
    };
  };
  const frames = Array.from({ length: 8 }, (_unused, index) => frame(index + 1));

  const oracle = JSON.parse(JSON.stringify(
    context.summarizeTemporalSelectedXfb(frames),
  ));
  assert.equal(oracle.complete, true);
  assert.equal(oracle.distinctRgbaHashes, 8);
  assert.equal(oracle.distinctRgbHashes, 8);
  assert.equal(oracle.distinctPairEpochs, 8);
  assert.equal(oracle.distinctGenerations, 8);
  assert.equal(oracle.distinctCopyIndices, 8);
  assert.deepEqual(oracle.missingOrUnselectedOrdinals, []);
  assert.deepEqual(oracle.mismatchedPresentationOrdinals, []);
  assert.deepEqual(oracle.generationRegressions, []);
  assert.deepEqual(oracle.copyIndexRegressions, []);
  assert.deepEqual(oracle.monochromeOrdinals, []);
  assert.deepEqual(oracle.blackOrdinals, []);
  assert.deepEqual(oracle.whiteOrdinals, []);
  assert.equal(oracle.allFramesMonochrome, false);
  assert.equal(oracle.alternatingMonochromePair, false);
  assert.equal(oracle.blackWhiteAlternating, false);
  assert.deepEqual(
    oracle.sourceBlackWhiteSplitOrdinals,
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});
