#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
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
const headlessSource = readFileSync(
  new URL("./browser_boot_headless.mjs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", functionStart);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(functionStart, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

test("GX frames cross the renderer bridge as one exact packet view", () => {
  const submissions = [];
  const context = {
    ArrayBuffer,
    Number,
    String,
    Uint8Array,
    document: { body: { dataset: {} } },
    rendererHostMetrics: {
      workerMessages: { gxFrames: 0, drawCalls: 0, receivedArrayBufferBytes: 0 },
    },
    webGpuRenderer: {
      submit_gx_frame(packet) {
        submissions.push(packet);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("submitGxFrame"), context);

  const xfbPacket = new ArrayBuffer(1920);
  context.submitGxFrame({
    packet: xfbPacket,
    diagnostics: { copyKind: 2, index: 0x11223344, drawCalls: 2, vertices: 3 },
  });
  assert.equal(submissions.length, 1);
  assert.ok(submissions[0] instanceof Uint8Array);
  assert.strictEqual(submissions[0].buffer, xfbPacket);
  assert.equal(submissions[0].byteOffset, 0);
  assert.equal(submissions[0].byteLength, 1920);
  assert.deepEqual(context.rendererHostMetrics.workerMessages, {
    gxFrames: 1,
    drawCalls: 2,
    receivedArrayBufferBytes: 1920,
  });
  assert.deepEqual(context.document.body.dataset, {
    gxDrawCalls: "2",
    gxVertices: "3",
    xfbCopies: String(0x11223344),
  });

  const texturePacket = new ArrayBuffer(128);
  context.submitGxFrame({
    packet: texturePacket,
    diagnostics: { copyKind: 1, index: 7, drawCalls: 0, vertices: 0 },
  });
  assert.equal(submissions.length, 2);
  assert.strictEqual(submissions[1].buffer, texturePacket);
  assert.equal(submissions[1].byteLength, 128);
  assert.deepEqual(context.rendererHostMetrics.workerMessages, {
    gxFrames: 2,
    drawCalls: 2,
    receivedArrayBufferBytes: 2048,
  });
  assert.equal(context.document.body.dataset.gxTextureCopies, "7");

  assert.throws(
    () => context.submitGxFrame({
      packet: new ArrayBuffer(16),
      diagnostics: { copyKind: 3, index: 0, drawCalls: 0, vertices: 0 },
    }),
    /diagnostics are invalid/,
  );
  assert.equal(submissions.length, 2);
  assert.equal(context.rendererHostMetrics.workerMessages.gxFrames, 2);
});

test("renderer performance derives exact bridge and resource totals", async () => {
  const webgpu = {
    beginSegmentCalls: 3,
    bindGroupsCreated: 8,
    buffersCreated: 9,
    checkHealthCalls: 5,
    clearEfbCalls: 2,
    copyTextureCalls: 1,
    copyXfbCalls: 3,
    decodedTextureQueries: 12,
    drainCalls: 5,
    expandedVertexBytes: 2048,
    gxFramePacketBytes: 1920,
    gxFramePacketPayloadBytes: 12,
    presentXfbCalls: 2,
    pushTevDrawCalls: 10,
    queueSubmissions: 6,
    renderPipelinesCreated: 4,
    sourceVertexBytes: 100,
    tevStateBytes: 200,
    textureMetadataBytes: 300,
    texturePixelBytes: 400,
    textureUploadBytes: 400,
    textureWrites: 2,
    texturesCreated: 7,
    submitGxFrameCalls: 1,
    wasmBridgeCalls: 17,
    wasmBridgeTypedArrayBytes: 1920,
  };
  const context = {
    Promise,
    rendererHostMetrics: {
      operations: { enqueued: 5, pending: 0, highWater: 1 },
      wall: { workerStartToLastReportMs: 1234.5 },
      workerMessages: { gxFrames: 1, drawCalls: 10, receivedArrayBufferBytes: 1920 },
    },
    rendererOperationTail: Promise.resolve(),
    webGpuRenderer: { diagnostics: () => webgpu },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "appendRendererOperation",
      "snapshotRendererPerformance",
      "captureRendererPerformance",
    ].map(extractFunction).join("\n\n"),
    context,
  );

  const performance = JSON.parse(JSON.stringify(await context.captureRendererPerformance()));
  assert.equal(performance.scope, "current-worker");
  assert.deepEqual(performance.wasmBridge, { calls: 17, typedArrayBytes: 1920 });
  assert.deepEqual(performance.queue, { drains: 5, submits: 6 });
  assert.deepEqual(performance.resources, {
    bindGroups: 8,
    buffers: 9,
    renderPipelines: 4,
    textures: 7,
  });
  assert.deepEqual(performance.operations, { enqueued: 5, pending: 0, highWater: 1 });
  assert.deepEqual(performance.workerMessages, {
    drawCalls: 10,
    gxFrames: 1,
    receivedArrayBufferBytes: 1920,
  });
  assert.deepEqual(performance.workload, {
    expandedVertexBytes: 2048,
    gxFramePacketBytes: 1920,
    gxFramePacketPayloadBytes: 12,
    textureUploadBytes: 400,
    textureWrites: 2,
  });
  assert.equal(
    performance.wasmBridge.typedArrayBytes,
    performance.workerMessages.receivedArrayBufferBytes,
  );
  assert.deepEqual(performance.wall, { workerStartToLastReportMs: 1234.5 });
  assert.deepEqual(context.rendererHostMetrics.operations, {
    enqueued: 5,
    pending: 0,
    highWater: 1,
  });
});

test("renderer performance waits for queued work without accounting itself", async () => {
  const calls = [];
  let release;
  const context = {
    Promise,
    rendererOperationTail: new Promise(resolve => { release = resolve; }),
    snapshotRendererPerformance() {
      calls.push("metrics");
      return { operations: { enqueued: 9, pending: 0, highWater: 2 } };
    },
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "captureRendererPerformance"]
      .map(extractFunction)
      .join("\n\n"),
    context,
  );

  const pending = context.captureRendererPerformance();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  release();
  assert.deepEqual(
    JSON.parse(JSON.stringify(await pending)),
    { operations: { enqueued: 9, pending: 0, highWater: 2 } },
  );
  assert.deepEqual(calls, ["metrics"]);
});

test("terminal capture snapshots metrics before its serialized XFB readback", async () => {
  const calls = [];
  const originalHostMetrics = { id: "original" };
  const replacementHostMetrics = { id: "replacement" };
  const originalTemporalFrames = [];
  const replacementTemporalFrames = [{
    ordinal: 1,
    presentation: {},
    selectedXfb: null,
  }];
  let release;
  let context;
  context = {
    Promise,
    rendererOperationTail: new Promise(resolve => { release = resolve; }),
    rendererHostMetrics: originalHostMetrics,
    snapshotRendererPerformance(hostMetrics) {
      calls.push(`metrics:${hostMetrics.id}`);
      return { calls: 17 };
    },
    async readSelectedXfb() {
      calls.push("read");
      return { rgbaSha256: "abc" };
    },
    summarizeTemporalSelectedXfb(frames) {
      calls.push("temporal");
      return { captured: frames.length, capacity: 8 };
    },
    summarizeTemporalPresentedSurfaces(frames) {
      calls.push("surface");
      return { captured: frames.length, capacity: 8 };
    },
    temporalSelectedXfbCapacity: 8,
    temporalSelectedXfbFrames: originalTemporalFrames,
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "captureRendererTerminal"]
      .map(extractFunction)
      .join("\n\n"),
    context,
  );

  const pending = context.captureRendererTerminal();
  context.rendererHostMetrics = replacementHostMetrics;
  context.temporalSelectedXfbFrames = replacementTemporalFrames;
  await Promise.resolve();
  assert.deepEqual(calls, []);
  release();
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    metrics: { calls: 17 },
    selectedXfb: { rgbaSha256: "abc" },
    temporalSelectedXfb: {
      scanoutEvidenceVersion: 2,
      capacity: 8,
      frames: [],
      oracle: { captured: 0, capacity: 8 },
      surfaceOracle: { captured: 0, capacity: 8 },
    },
  });
  assert.deepEqual(calls, ["metrics:original", "read", "temporal", "surface"]);
});

test("headless capture consumes page-owned rendering without renderer calls", () => {
  assert.doesNotMatch(headlessSource, /lazuliRendererDiagnostics/);
  assert.doesNotMatch(headlessSource, /captureTerminal\(/);
  assert.doesNotMatch(headlessSource, /capturePerformance\(/);
  assert.doesNotMatch(headlessSource, /captureSelectedXfb\(/);
  assert.match(headlessSource, /verifyPageOwnedRendering\(report, state\);/);
});

test("WebGPU diagnostic readback is excluded from workload counters", () => {
  const start = rendererSource.indexOf("pub fn read_presented_xfb_rgba");
  const end = rendererSource.indexOf("pub fn push_tev_draw", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(rendererSource.slice(start, end), /update_renderer_metrics/);
});

test("draw transport is counted before empty, clipped, and culled exits", () => {
  const start = rendererSource.indexOf("pub fn push_tev_draw");
  const end = rendererSource.indexOf("pub fn copy_efb_to_texture", start);
  const push = rendererSource.slice(start, end);
  const record = push.indexOf("metrics.record_draw_transport");
  assert.notEqual(record, -1);
  for (const exit of [
    "if expanded.is_empty()",
    "let Some(scissor) = clipped_scissor",
    "if pipeline.cull == CullMode::All",
  ]) {
    const position = push.indexOf(exit);
    assert.notEqual(position, -1, `missing ${exit}`);
    assert.ok(record < position, `${exit} precedes transport accounting`);
  }
});
