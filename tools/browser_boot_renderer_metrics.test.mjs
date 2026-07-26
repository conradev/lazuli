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
const rendererCoreSource = readFileSync(
  new URL("../crates/browser-renderer/src/lib.rs", import.meta.url),
  "utf8",
);
const rendererGeometrySource = readFileSync(
  new URL("../crates/browser-renderer/src/clip/geometry.rs", import.meta.url),
  "utf8",
);
const headlessSource = readFileSync(
  new URL("./browser_boot_headless.mjs", import.meta.url),
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
  const webgpuPhases = {
    drawSampling: { eligibleCalls: 10_000, sampleStride: 1024 },
    packetParse: { samples: 1, totalMs: 1.5, maxMs: 1.5 },
    topologyExpansion: { samples: 10, totalMs: 2.5, maxMs: 0.5 },
    resourcePreparation: { samples: 10, totalMs: 4.5, maxMs: 1.25 },
    gxFrameExecution: { samples: 1, totalMs: 8.5, maxMs: 8.5 },
  };
  const context = {
    Promise,
    rendererHostMetrics: {
      operations: { enqueued: 5, pending: 0, highWater: 1 },
      wall: {
        workerStartToLastReportMs: 1234.5,
        phases: {
          operationQueueWait: {
            eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 3, maxMs: 2,
          },
          operationDispatch: {
            eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 12, maxMs: 4,
          },
          operationTotal: {
            eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 40, maxMs: 15,
          },
          queueDrain: {
            eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 20, maxMs: 7,
          },
        },
      },
      workerMessages: { gxFrames: 1, drawCalls: 10, receivedArrayBufferBytes: 1920 },
    },
    rendererOperationTail: Promise.resolve(),
    webGpuRenderer: {
      diagnostics: () => webgpu,
      host_diagnostics: () => webgpuPhases,
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "appendRendererOperation",
      "snapshotRendererPhaseTiming",
      "snapshotRendererWallPhases",
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
  assert.deepEqual(performance.wall, {
    workerStartToLastReportMs: 1234.5,
    phases: {
      gxFrameExecution: {
        eligibleCalls: 1, sampleStride: 1, samples: 1, totalMs: 8.5, maxMs: 8.5,
      },
      operationDispatch: {
        eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 12, maxMs: 4,
      },
      operationQueueWait: {
        eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 3, maxMs: 2,
      },
      operationTotal: {
        eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 40, maxMs: 15,
      },
      packetParse: {
        eligibleCalls: 1, sampleStride: 1, samples: 1, totalMs: 1.5, maxMs: 1.5,
      },
      queueDrain: {
        eligibleCalls: 5, sampleStride: 64, samples: 5, totalMs: 20, maxMs: 7,
      },
      resourcePreparation: {
        eligibleCalls: 10_000, sampleStride: 1024, samples: 10, totalMs: 4.5, maxMs: 1.25,
      },
      topologyExpansion: {
        eligibleCalls: 10_000, sampleStride: 1024, samples: 10, totalMs: 2.5, maxMs: 0.5,
      },
    },
  });
  context.rendererHostMetrics.wall.phases.operationQueueWait.totalMs = 999;
  webgpuPhases.packetParse.totalMs = 999;
  assert.equal(performance.wall.phases.operationQueueWait.totalMs, 3);
  assert.equal(performance.wall.phases.packetParse.totalMs, 1.5);
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

test("sampled renderer queue and drain phases account exact captured-epoch wall time", async () => {
  const clock = [10, 14, 16, 18, 30, 40];
  let release;
  let healthChecks = 0;
  const context = {
    Math,
    Number,
    Promise,
    performance: { now: () => clock.shift() },
    rendererHostMetrics: { operations: {} },
    rendererOperationTail: new Promise(resolve => { release = resolve; }),
    webGpuRenderer: {
      drain: () => Promise.resolve(),
      check_health: () => { healthChecks += 1; },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "newRendererPhaseTiming",
      "beginRendererPhaseTiming",
      "recordRendererPhaseTiming",
      "newRendererWallPhases",
      "appendRendererOperation",
      "enqueueRendererOperation",
      "drainWebGpuRenderer",
    ].map(extractFunction).join("\n\n"),
    context,
  );

  const oldMetrics = {
    operations: { enqueued: 0, pending: 0, highWater: 0 },
    wall: { phases: context.newRendererWallPhases() },
  };
  const replacementMetrics = {
    operations: { enqueued: 0, pending: 0, highWater: 0 },
    wall: { phases: context.newRendererWallPhases() },
  };
  context.rendererHostMetrics = oldMetrics;
  const pending = context.enqueueRendererOperation(() => "complete");
  context.rendererHostMetrics = replacementMetrics;
  release();
  assert.equal(await pending, "complete");
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(oldMetrics.wall.phases)), {
    operationDispatch: {
      eligibleCalls: 1, sampleStride: 64, samples: 1, totalMs: 2, maxMs: 2,
    },
    operationQueueWait: {
      eligibleCalls: 1, sampleStride: 64, samples: 1, totalMs: 4, maxMs: 4,
    },
    operationTotal: {
      eligibleCalls: 1, sampleStride: 64, samples: 1, totalMs: 8, maxMs: 8,
    },
    queueDrain: {
      eligibleCalls: 0, sampleStride: 64, samples: 0, totalMs: 0, maxMs: 0,
    },
  });
  assert.equal(replacementMetrics.operations.enqueued, 0);
  assert.equal(replacementMetrics.wall.phases.operationTotal.eligibleCalls, 0);

  await context.drainWebGpuRenderer(oldMetrics.wall.phases);
  assert.deepEqual(JSON.parse(JSON.stringify(oldMetrics.wall.phases.queueDrain)), {
    eligibleCalls: 1,
    sampleStride: 64,
    samples: 1,
    totalMs: 10,
    maxMs: 10,
  });
  assert.equal(healthChecks, 1);
  assert.deepEqual(clock, []);
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
      scanoutEvidenceVersion: 3,
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

test("exact authoritative no-ops have distinct renderer compatibility counters", () => {
  for (const field of [
    "exact_raster_empty_draws",
    "exact_required_rejected_draws",
  ]) {
    assert.match(
      rendererCoreSource,
      new RegExp(`pub\\(crate\\) ${field}: u64`),
    );
  }
  for (const [publicField, rustField] of [
    ["exactRasterEmptyDraws", "exact_raster_empty_draws"],
    ["exactRequiredRejectedDraws", "exact_required_rejected_draws"],
  ]) {
    assert.match(
      rendererSource,
      new RegExp(`"${publicField}"[\\s\\S]{0,80}metrics\\.${rustField}`),
    );
  }
  assert.match(
    rendererSource,
    /exact_raster_empty_draws\s*=\s*metrics\.exact_raster_empty_draws\.saturating_add\(1\)/,
  );
  assert.match(
    rendererCoreSource,
    /self\.exact_required_rejected_draws\s*=\s*self\.exact_required_rejected_draws\.saturating_add\(1\)/,
  );
  const classifierStart = rendererSource.indexOf(
    "fn authoritative_noop(&self) -> Option<ExactAuthoritativeNoop>",
  );
  const classifierEnd = rendererSource.indexOf("\n    }\n}", classifierStart);
  assert.notEqual(classifierStart, -1);
  assert.notEqual(classifierEnd, -1);
  const classifier = rendererSource.slice(classifierStart, classifierEnd);
  const rasterEmpty = classifier.indexOf("ExactAuthoritativeNoop::RasterEmpty");
  const requiredRejected = classifier.indexOf(
    "ExactAuthoritativeNoop::RequiredRejected",
  );
  assert.notEqual(rasterEmpty, -1);
  assert.notEqual(requiredRejected, -1);
  assert.ok(
    rasterEmpty < requiredRejected,
    "raster-empty precedence keeps required empty draws out of rejection telemetry",
  );
});

test("required exact no-ops expose one bounded compatibility-reason map", () => {
  const reasonCodes = [
    "exactPreparation",
    "scissor",
    "primitive",
    "earlyDepth",
    "rasterCenter",
    "depthEncoding",
    "tevState",
    "textureCoordinates",
    "sampler",
    "zTexture",
    "fog",
    "fullyCulled",
    "managedPayload",
    "unclassified",
  ];
  assert.match(
    rendererCoreSource,
    /EXACT_REQUIRED_REJECTION_REASON_COUNT: usize = 14/,
  );
  assert.match(
    rendererCoreSource,
    /exact_required_rejection_reasons:\s*\[u64; EXACT_REQUIRED_REJECTION_REASON_COUNT\]/,
  );
  for (const code of reasonCodes) {
    assert.match(
      rendererCoreSource,
      new RegExp(`=> "${code}"`),
      `missing stable exact rejection code ${code}`,
    );
  }
  assert.match(
    rendererSource,
    /for reason in ExactRequiredRejectionReason::ALL[\s\S]*"exactRequiredRejectionReasons"/,
  );
  assert.match(
    rendererCoreSource,
    /fn record_exact_required_rejection[\s\S]*exact_required_rejected_draws[\s\S]*record_exact_required_rejection_reason\(reason\)/,
  );
  assert.match(
    rendererSource,
    /fn record_exact_required_rejection[\s\S]*current\.record_exact_required_rejection\(\s*reason,\s*Some\(\(&mut current_preparation_counts, preparation_reason\)\),\s*\)[\s\S]*current\.record_exact_required_rejection\(reason, None\)/,
  );
});

test("required exact preparation failures expose one bounded subtype map", () => {
  const reasonCodes = [
    "invalidVertexLayout",
    "missingExactClipInput",
    "positionCountMismatch",
    "nonFiniteSourceVertex",
    "cullModeStateMismatch",
    "unsupportedMultisampling",
    "unsupportedZFreeze",
    "nonCanonicalSourceRaster",
    "unsupportedPostClipW",
    "unsupportedPostClipPosition",
    "unsupportedPostClipDepth",
    "clipInvalidComponentCount",
    "unsupportedTopology5",
    "unsupportedTopology6",
    "unsupportedTopology7",
    "unsupportedTopologyOther",
    "clipNoSourceTriangles",
    "clipInvalidCullMode",
    "clipInvalidViewportHeight",
    "clipNonFiniteVertex",
    "clipArithmeticOverflow",
    "projectionInvalidComponentCount",
    "projectionInvalidBpState",
    "projectionInvalidClipDisable",
    "unsupportedClipDisable1",
    "unsupportedClipDisable2",
    "unsupportedClipDisable3",
    "unsupportedClipDisable4",
    "unsupportedClipDisable5",
    "unsupportedClipDisable6",
    "unsupportedClipDisable7",
    "unsupportedClipDisableOther",
    "projectionInvalidViewport",
    "projectionInvalidScissor",
    "projectionNoVisibleScissor",
    "projectionWrappedScissor",
    "projectionNonFiniteVertex",
    "projectionZeroClipW",
    "projectionArithmeticOverflow",
    "invalidPreparedScissor",
  ];
  assert.match(
    rendererCoreSource,
    /EXACT_REQUIRED_PREPARATION_REJECTION_REASON_COUNT: usize = 40/,
  );
  assert.match(
    rendererCoreSource,
    /struct ExactRequiredPreparationRejectionCounts[\s\S]{0,160}counts:\s*\[u64; EXACT_REQUIRED_PREPARATION_REJECTION_REASON_COUNT\]/,
  );
  assert.doesNotMatch(
    rendererCoreSource,
    /exact_required_preparation_rejection_reasons:\s*ExactRequiredPreparationRejectionCounts/,
  );
  assert.match(
    rendererSource,
    /exact_required_preparation_rejection_counts:\s*Cell<ExactRequiredPreparationRejectionCounts>/,
  );
  assert.match(
    rendererSource,
    /reset_diagnostics\(&mut self\)[\s\S]{0,240}exact_required_preparation_rejection_counts[\s\S]{0,120}ExactRequiredPreparationRejectionCounts::default\(\)/,
  );
  assert.match(
    rendererSource,
    /exact_required_preparation_rejection_counts:\s*Cell::new\(\s*ExactRequiredPreparationRejectionCounts::default\(\),\s*\)/,
  );
  for (const code of reasonCodes) {
    assert.match(
      rendererCoreSource,
      new RegExp(`=> "${code}"`),
      `missing stable exact preparation rejection code ${code}`,
    );
  }
  for (const topology of [5, 6, 7]) {
    assert.match(
      rendererGeometrySource,
      new RegExp(
        `GxClipError::UnsupportedTopology\\(${topology}\\)[\\s\\S]{0,100}`
          + `Reason::UnsupportedTopology${topology}`,
      ),
    );
  }
  for (const mode of [1, 2, 3, 4, 5, 6, 7]) {
    assert.match(
      rendererGeometrySource,
      new RegExp(
        `GxExactProjectionError::UnsupportedClipDisable\\(${mode}\\)`
          + `[\\s\\S]{0,100}Reason::UnsupportedClipDisable${mode}`,
      ),
    );
  }
  assert.match(
    rendererSource,
    /preparation_failure:\s*Option<GxExactPreparationFailure>/,
  );
  assert.match(
    rendererSource,
    /Err\(error\)[\s\S]{0,300}preparation_failure:\s*Some\(error\.into\(\)\)/,
  );
  assert.match(
    rendererSource,
    /preparation_failure:\s*Some\(GxExactPreparationFailure::InvalidPreparedScissor\)/,
  );
  assert.match(
    rendererCoreSource,
    /debug_assert_eq!\([\s\S]{0,180}reason == ExactRequiredRejectionReason::ExactPreparation[\s\S]{0,120}preparation_rejection\.is_some\(\)/,
  );
  assert.match(
    rendererSource,
    /for reason in ExactRequiredPreparationRejectionReason::ALL[\s\S]*"exactRequiredPreparationRejectionReasons"/,
  );
  assert.match(
    rendererSource,
    /renderer_metrics_object\(\s*self\.metrics\.get\(\),\s*self\.exact_required_preparation_rejection_counts\.get\(\),\s*\)/,
  );

  const snapshotStart = rendererCoreSource.indexOf(
    "pub(crate) struct ExactRequiredRejectionSnapshot",
  );
  const snapshotEnd = rendererCoreSource.indexOf(
    "\n/// Side-effect-free facts",
    snapshotStart,
  );
  assert.notEqual(snapshotStart, -1);
  assert.notEqual(snapshotEnd, -1);
  const snapshot = rendererCoreSource.slice(snapshotStart, snapshotEnd);
  assert.match(snapshot, /aggregate:\s*u64/);
  assert.match(
    snapshot,
    /reasons:\s*\[u64; EXACT_REQUIRED_REJECTION_REASON_COUNT\]/,
  );
  assert.match(
    snapshot,
    /preparation_reasons:\s*ExactRequiredPreparationRejectionCounts/,
  );
  assert.match(snapshot, /checked_delta_since/);
  assert.equal(snapshot.match(/checked_sub\(/g)?.length, 2);
  assert.match(
    snapshot,
    /delta\.is_coherent\(\)\.then_some\(delta\)/,
  );
  assert.match(
    snapshot,
    /fold\(0, u64::saturating_add\)\s*== self\.aggregate/,
  );
  assert.match(
    snapshot,
    /saturated_total\(\)\s*== self\.reason\(ExactRequiredRejectionReason::ExactPreparation\)/,
  );
  assert.match(
    rendererCoreSource,
    /size_of::<ExactRequiredRejectionSnapshot>\(\),\s*55 \* 8/,
  );
});

test("draw transport is counted before empty, clipped, and culled exits", () => {
  const start = rendererSource.indexOf("pub fn push_tev_draw");
  const end = rendererSource.indexOf("pub fn copy_efb_to_texture", start);
  const push = rendererSource.slice(start, end);
  const record = push.indexOf("metrics.record_draw_transport");
  assert.notEqual(record, -1);
  assert.ok(
    push.indexOf("PreparedExactDraw::authoritative_noop", record)
      < push.indexOf("let expanded = expanded_indices", record),
    "authoritative no-op allocates native topology",
  );
  assert.ok(
    push.indexOf("RendererHostPhase::TopologyExpansion", record)
      < push.indexOf("let expanded = expanded_indices", record),
    "topology expansion begins outside its timing phase",
  );
  for (const exit of [
    "if expanded_vertex_count == 0",
    "PreparedExactDraw::authoritative_noop",
    "required_exact && early_depth != GxEarlyDepthPlan::FixedFunction",
    "let native_scissor = clipped_scissor",
    "required_exact && exact_managed.is_none()",
    "if pipeline.cull == CullMode::All",
  ]) {
    const position = push.indexOf(exit, record);
    assert.notEqual(position, -1, `missing ${exit}`);
    assert.ok(record < position, `${exit} precedes transport accounting`);
  }
});
