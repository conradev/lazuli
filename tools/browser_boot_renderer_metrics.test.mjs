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

test("GX frame accounting counts each received ArrayBuffer once", () => {
  const context = { ArrayBuffer, Float32Array, Set, Uint8Array };
  vm.createContext(context);
  vm.runInContext(extractFunction("receivedArrayBufferBytes"), context);
  const shared = new ArrayBuffer(64);
  const texture = new ArrayBuffer(32);
  const frame = {
    geometry: {
      draws: [
        {
          vertices: new Float32Array(shared, 0, 8),
          tevState: new Uint8Array(shared, 32, 16),
          textures: [{ pixels: new Uint8Array(texture) }],
        },
        {
          vertices: new Float32Array(shared, 0, 4),
          tevState: new Uint8Array(0),
          textures: [{ pixels: new Uint8Array(texture, 0, 8) }],
        },
      ],
    },
  };

  assert.equal(context.receivedArrayBufferBytes(frame), 96);
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
  };
  const context = {
    Promise,
    rendererHostMetrics: {
      operations: { enqueued: 5, pending: 0, highWater: 1 },
      wall: { workerStartToLastReportMs: 1234.5 },
      workerMessages: { gxFrames: 3, drawCalls: 10, receivedArrayBufferBytes: 4096 },
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
  assert.deepEqual(performance.wasmBridge, { calls: 43, typedArrayBytes: 1000 });
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
    gxFrames: 3,
    receivedArrayBufferBytes: 4096,
  });
  assert.deepEqual(performance.workload, {
    expandedVertexBytes: 2048,
    textureUploadBytes: 400,
    textureWrites: 2,
  });
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
  let release;
  const context = {
    Promise,
    rendererOperationTail: new Promise(resolve => { release = resolve; }),
    snapshotRendererPerformance() {
      calls.push("metrics");
      return { calls: 17 };
    },
    async readSelectedXfb() {
      calls.push("read");
      return { rgbaSha256: "abc" };
    },
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "captureRendererTerminal"]
      .map(extractFunction)
      .join("\n\n"),
    context,
  );

  const pending = context.captureRendererTerminal();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  release();
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    metrics: { calls: 17 },
    selectedXfb: { rgbaSha256: "abc" },
  });
  assert.deepEqual(calls, ["metrics", "read"]);
});

test("headless capture uses one awaited terminal diagnostic", () => {
  assert.match(headlessSource, /return await diagnostics\.captureTerminal\(\);/);
  assert.doesNotMatch(headlessSource, /diagnostics\.capturePerformance\(\)/);
  assert.doesNotMatch(headlessSource, /diagnostics\.captureSelectedXfb\(\)/);
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
