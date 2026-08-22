#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
), "utf8");

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

function readHarness({ inFlight = false, completed = null } = {}) {
  const memory = new ArrayBuffer(0x2000);
  const posts = [];
  const faults = [];
  const unsupported = [];
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Number,
    Set,
    Uint32Array,
    completedEfbPeek: completed,
    cycles: 0x123456,
    efbPeekColorReads: 0,
    efbPeekCombinedReads: 0,
    efbPeekDepthReads: 0,
    efbPeekOrderingYields: 0,
    efbPeekOutOfBoundsReads: 0,
    efbPeekRequestSequence: 0,
    efbPeekRequests: 0,
    efbPeekRetries: 0,
    efbPeekYieldRequested: false,
    gxBpRegisters: new Uint32Array(256),
    gxFrameDraws: [],
    gxFrameDrawVertices: 0,
    gxFrameSkippedPrimitives: 0,
    mmio: 0x100,
    pendingEfbPeek: null,
    rendererFramesInFlight: new Set(inFlight ? [41] : []),
    rendererTextureCopyBarrierSequence: null,
    view: new DataView(memory),
    hex32(value) {
      return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
    },
    resolveDataRange(effective) {
      return {
        kind: "mapped",
        effective: effective >>> 0,
        physical: (effective & 0x3fff_ffff) >>> 0,
      };
    },
    recordDataStorageFault(...args) {
      faults.push(args);
      return 0;
    },
    gxRecordUnsupported(...args) { unsupported.push(args); },
    postGxFrame(copyKind, frame) {
      posts.push({ copyKind, frame });
      return 1;
    },
  };
  context.gxBpRegisters[0x43] = 0x41;
  // PE alpha read mode: ReadFF. Its transport value is part of the retry key.
  context.view.setUint16(context.mmio + 0x1008, 2, false);
  vm.createContext(context);
  vm.runInContext(extractFunction("readInteger"), context, {
    filename: "browser_boot.efb-peek.read.js",
  });
  return { context, faults, memory, posts, unsupported };
}

function matchingCompletion(effective, plane, value) {
  const physical = (effective & 0x3fff_ffff) >>> 0;
  return {
    effective: effective >>> 0,
    physical,
    x: (physical & 0x0fff) >>> 2,
    y: (physical >>> 12) & 0x03ff,
    plane,
    pixelControl: 0x41,
    alphaReadMode: 2,
    requestSequence: 1,
    cycle: 0x123456,
    value,
  };
}

test("translated color and depth apertures post one canonical EFB peek terminal", () => {
  for (const expected of [
    { effective: 0xc80f0500, plane: 0 },
    { effective: 0xc84f0500, plane: 1 },
  ]) {
    const { context, faults, posts } = readHarness();
    assert.equal(context.readInteger(expected.effective, 0x20, 4), 2);
    assert.equal(faults.length, 0, "a valid EFB aperture load must not raise DSI");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].copyKind, 3);

    const frame = posts[0].frame;
    assert.equal(frame.sourceX, 320);
    assert.equal(frame.sourceY, 240);
    assert.equal(frame.width, 1);
    assert.equal(frame.sourceHeight, 1);
    assert.equal(frame.height, 1);
    assert.equal(frame.destination, expected.plane);
    assert.equal(frame.copyToXfb, false);
    assert.equal(frame.clear, false);
    assert.equal(frame.geometry.drawCalls, 0);
    assert.equal(frame.geometry.vertices, 0);
    assert.equal(frame.efbPeekExpectation.physical, (
      expected.effective & 0x3fff_ffff
    ) >>> 0);
    assert.equal(frame.efbPeekExpectation.x, 320);
    assert.equal(frame.efbPeekExpectation.y, 240);
    assert.equal(frame.efbPeekExpectation.plane, expected.plane);
    assert.equal(context.efbPeekYieldRequested, true);
    assert.equal(context.efbPeekRequests, 1);
  }
});

test("a matching completed EFB peek retries once and stores its uint32 little-endian", () => {
  const effective = 0xc84f0500;
  const value = 0x12345678;
  const { context, faults, posts } = readHarness({
    completed: matchingCompletion(effective, 1, value),
  });

  assert.equal(context.readInteger(effective, 0x20, 4), 1);
  assert.equal(faults.length, 0);
  assert.equal(posts.length, 0);
  assert.deepEqual(
    Array.from(new Uint8Array(context.view.buffer, 0x20, 4)),
    [0x78, 0x56, 0x34, 0x12],
  );
  assert.equal(context.completedEfbPeek, null);
  assert.equal(context.efbPeekRetries, 1);
  assert.equal(context.efbPeekDepthReads, 1);
});

test("out-of-bounds and combined-plane EFB apertures synchronously read zero", () => {
  for (const expected of [
    { effective: 0xc80f0a00, metric: "efbPeekOutOfBoundsReads" },
    { effective: 0xc88f0500, metric: "efbPeekCombinedReads" },
  ]) {
    const { context, faults, posts } = readHarness();
    context.view.setUint32(0x20, 0xffff_ffff, true);
    assert.equal(context.readInteger(expected.effective, 0x20, 4), 1);
    assert.equal(context.view.getUint32(0x20, true), 0);
    assert.equal(context[expected.metric], 1);
    assert.equal(context.efbPeekYieldRequested, false);
    assert.equal(posts.length, 0);
    assert.equal(faults.length, 0);
  }
});

test("an earlier renderer terminal yields before packaging an EFB peek", () => {
  const { context, faults, posts } = readHarness({ inFlight: true });
  assert.equal(context.readInteger(0xc84f0500, 0x20, 4), 2);
  assert.equal(posts.length, 0);
  assert.equal(faults.length, 0);
  assert.equal(context.pendingEfbPeek, null);
  assert.equal(context.efbPeekOrderingYields, 1);
  assert.equal(context.efbPeekYieldRequested, true);
});

test("a completed receipt for a different EFB load fails before guest memory changes", () => {
  const { context } = readHarness({
    completed: matchingCompletion(0xc84f0500, 1, 0x00abcdef),
  });
  context.view.setUint32(0x20, 0xa5a5a5a5, true);
  assert.throws(
    () => context.readInteger(0xc80f0500, 0x20, 4),
    /completed WebGPU EFB peek does not match retried load/,
  );
  assert.equal(context.view.getUint32(0x20, true), 0xa5a5a5a5);
});

function receiptHarness({ completed = null } = {}) {
  const failures = [];
  const expectation = matchingCompletion(0xc84f0500, 1, 0);
  delete expectation.value;
  const context = {
    Array,
    Number,
    Set,
    completedEfbPeek: completed,
    efbPeekCompletions: 0,
    pendingEfbPeek: expectation,
    rendererBackpressureResume: null,
    rendererEfbPeekExpectations: new Map([[7, expectation]]),
    rendererFailure: null,
    rendererFrameFailures: 0,
    rendererFrameResultMisses: 0,
    rendererFramesAcknowledged: 0,
    rendererFramesInFlight: new Set([7]),
    rendererResidentTextureKeys: new Set(),
    rendererTextureCopyExpectations: new Map([[7, null]]),
    rendererViFrames: new Map(),
    smbSustainedViPending: new Map(),
    gxPreflightTextureCopyReceipts(receipts, expectation) {
      assert.deepEqual(receipts, []);
      assert.equal(expectation, null);
      return null;
    },
    gxApplyTextureCopyReceipt(plan) { assert.equal(plan, null); },
    recordRendererFailure(error) {
      failures.push(String(error));
      if (context.rendererFailure === null) context.rendererFailure = String(error);
    },
  };
  vm.createContext(context);
  vm.runInContext([
    "gxPreflightEfbPeekReceipt",
    "gxRetireRendererFrame",
    "completeRendererFrame",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.efb-peek.receipt.js",
  });
  return { context, expectation, failures };
}

test("mismatched and duplicate EFB peek receipts fail-stop renderer progress", () => {
  {
    const { context, failures } = receiptHarness();
    context.completeRendererFrame({
      type: "renderer-frame-complete",
      rendererSequence: 7,
      textureCopyReceipts: [],
      efbPeekReceipt: { requestSequence: 2, value: 0x123456 },
    });
    assert.match(failures[0], /EFB peek receipt is invalid/);
    assert.equal(context.rendererFramesInFlight.size, 0);
    assert.equal(context.rendererFrameFailures, 1);
    assert.notEqual(context.rendererFailure, null);
  }

  {
    const { context } = receiptHarness();
    const message = {
      type: "renderer-frame-complete",
      rendererSequence: 7,
      textureCopyReceipts: [],
      efbPeekReceipt: { requestSequence: 1, value: 0x654321 },
    };
    context.completeRendererFrame(message);
    assert.equal(context.rendererFramesAcknowledged, 1);
    assert.equal(context.completedEfbPeek.value, 0x654321);
    context.completeRendererFrame(message);
    assert.match(context.rendererFailure, /unknown or duplicate frame result/);
    assert.equal(context.rendererFrameFailures, 1);
    assert.equal(context.rendererFrameResultMisses, 1);
  }
});

function hostHarness(receipts) {
  const calls = [];
  const messages = [];
  const errors = [];
  const activeWorker = {
    postMessage(message) {
      calls.push("ack");
      messages.push(message);
    },
  };
  const context = {
    Array,
    ArrayBuffer,
    Number,
    Promise,
    Uint8Array,
    Uint32Array,
    document: { body: { dataset: {} } },
    rendererHostMetrics: {
      operations: { enqueued: 0, pending: 0, highWater: 0 },
      workerMessages: {
        gxFrames: 0,
        drawCalls: 0,
        receivedArrayBufferBytes: 0,
      },
    },
    rendererOperationTail: Promise.resolve(),
    worker: activeWorker,
    gxValidatePreClearWords(words) { return words; },
    handleRendererError(error, notifyWorker) {
      errors.push([String(error?.message ?? error), notifyWorker]);
    },
    webGpuRenderer: {
      submit_gx_frame(packet, preClears) {
        calls.push("submit");
        assert.equal(packet instanceof Uint8Array, true);
        assert.equal(preClears instanceof Uint32Array, true);
        return ["resident-texture"];
      },
      async drain_efb_peeks() {
        calls.push("drain");
        return receipts;
      },
      check_health() { calls.push("health"); },
    },
  };
  vm.createContext(context);
  vm.runInContext([
    "appendRendererOperation",
    "enqueueRendererOperation",
    "submitGxFrame",
    "handleEfbPeekFrame",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.efb-peek.host.js",
  });
  return { activeWorker, calls, context, errors, messages };
}

test("the page drains one EFB peek receipt before acknowledging its terminal", async () => {
  const { activeWorker, calls, context, errors, messages } = hostHarness([
    { requestSequence: 11, value: 0x00fedcba },
  ]);
  const result = await context.handleEfbPeekFrame({
    type: "gx-peek",
    rendererSequence: 19,
    packet: new ArrayBuffer(16),
    diagnostics: { copyKind: 3, index: 11, drawCalls: 0, vertices: 0 },
    preClearWords: new Uint32Array(),
  }, activeWorker);

  assert.deepEqual(calls, ["submit", "drain", "health", "ack"]);
  assert.deepEqual(errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "renderer-frame-complete",
    rendererSequence: 19,
    textureCopyReceipts: [],
    efbPeekReceipt: { requestSequence: 11, value: 0x00fedcba },
    residentTextureKeys: ["resident-texture"],
  }]);
});

test("the page rejects a non-singleton EFB peek drain without a success ack", async () => {
  const { activeWorker, calls, context, errors, messages } = hostHarness([]);
  const result = await context.handleEfbPeekFrame({
    type: "gx-peek",
    rendererSequence: 20,
    packet: new ArrayBuffer(16),
    diagnostics: { copyKind: 3, index: 12, drawCalls: 0, vertices: 0 },
    preClearWords: new Uint32Array(),
  }, activeWorker);

  assert.deepEqual(calls, ["submit", "drain", "health", "ack"]);
  assert.equal(result.ok, false);
  assert.deepEqual(errors, [[
    "WebGPU EFB peek drain must return exactly one receipt",
    false,
  ]]);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "renderer-frame-failed",
    rendererSequence: 20,
    error: "WebGPU EFB peek drain must return exactly one receipt",
  }]);
});

test("postGxFrame carries a canonical EFB peek through every packet attachment", () => {
  const posts = [];
  const expectation = {
    requestSequence: 11,
    physical: 0x084f0500,
    x: 320,
    y: 240,
    plane: 1,
    pixelControl: 0x41,
    alphaReadMode: 2,
    cycle: 123,
  };
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Map,
    Number,
    RangeError,
    Set,
    Uint8Array,
    Uint32Array,
    beginWorkerPhaseTiming() { return null; },
    recordWorkerPhaseTiming() {},
    workerHostTimings: { gxPacketPacking: {} },
    rendererFramesInFlight: new Set(),
    rendererResidentTextureKeys: new Set(),
    rendererEfbPeekExpectations: new Map(),
    gxSkippedCopyClears: [],
    gxCompactNativeTriangleFans(frame) { return frame; },
    packGxFramePacketForRenderer(copyKind) {
      const packet = new ArrayBuffer(160);
      const view = new DataView(packet);
      view.setUint16(0x04, 4, true);
      view.setUint32(0x08, packet.byteLength, true);
      view.setUint32(0x10, copyKind, true);
      view.setUint32(0x14, 1, true);
      return packet;
    },
    gxPackPreClearWords() { return new Uint32Array(); },
    gxDrainSkippedCopyClears() { context.gxSkippedCopyClears = []; },
    postRendererFrame(type, frame, transfer) {
      posts.push({ type, frame, transfer });
      return 23;
    },
  };
  vm.createContext(context);
  vm.runInContext([
    "gxFramePacketInteger",
    "gxFramePacketAdd",
    "gxFramePacketMultiply",
    "gxFramePacketBytes",
    "gxAttachTextureCopyLayoutV1",
    "gxFramePacketIndirectTevState",
    "gxAttachIndirectTevStateV1",
    "postGxFrame",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.efb-peek.post.js",
  });

  const tevState = new Uint8Array(464);
  new DataView(tevState.buffer).setUint32(448, 1, true);
  const sequence = context.postGxFrame(3, {
    index: 11,
    stride: 2,
    geometry: {
      drawCalls: 1,
      vertices: 3,
      draws: [{
        tevState,
        pipeline: {
          cullMode: 0,
          indirectTev: {
            genMode: 1 << 16,
            xfNumTexGens: 1,
            matrices: Array(9).fill(0),
            imask: 0,
            commands: Array(16).fill(0),
            texScales: [0, 0],
            iref: 0,
          },
        },
      }],
    },
    efbPeekExpectation: expectation,
  });

  assert.equal(sequence, 23);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].type, "gx-peek");
  assert.equal(posts[0].frame.diagnostics.copyKind, 3);
  assert.equal(posts[0].transfer.length, 1);
  const packet = posts[0].frame.packet;
  const packetView = new DataView(packet);
  assert.equal(packet.byteLength, 288);
  assert.equal(packetView.getUint32(0x0c, true), 2);
  assert.equal(packetView.getUint32(0x10, true), 3);
  assert.equal(packetView.getUint32(160, true), 2);
  assert.equal(packetView.getUint32(160 + 0x7c, true), 1);
  assert.equal(context.rendererEfbPeekExpectations.get(23), expectation);
});
