#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

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

function workerHarness({ transferMessages = false } = {}) {
  const messages = [];
  const reports = [];
  const transfers = [];
  const context = {
    Number,
    Math,
    rendererBackpressureResume: null,
    rendererBackpressureWaits: 0,
    rendererFailure: null,
    rendererFrameFailures: 0,
    rendererFrameHighWater: 0,
    rendererFrameResultMisses: 0,
    rendererFramesAcknowledged: 0,
    rendererFramesInFlight: new Set(),
    rendererResidentTextureKeys: new Set(),
    rendererFrameSequence: 0,
    runnerSliceMs: 8,
    runnerStopRequested: false,
    runnerYieldDeadline: 0,
    pc: 0x80000000,
    instructions: 0,
    cycles: 0,
    dispatches: 0,
    blocks: { size: 0 },
    hex32(value) { return `0x${value.toString(16).padStart(8, "0")}`; },
    finish(status, details) { reports.push({ status, details }); },
    postMessage(message, transfer = []) {
      transfers.push(transfer);
      messages.push(
        transferMessages ? structuredClone(message, { transfer }) : message,
      );
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "postRendererFrame",
      "postGxFrame",
      "recordRendererFailure",
      "completeRendererFrame",
      "honorRendererBackpressure",
      "finishAfterRendererDrain",
    ]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.worker.js" },
  );
  return { context, messages, reports, transfers };
}

function rendererOperationMetrics() {
  return {
    operations: { enqueued: 0, pending: 0, highWater: 0 },
  };
}

function terminalPublicationHarness() {
  const captures = [];
  const rendererNotifications = [];
  const oldWorker = {
    postMessage(message) { rendererNotifications.push(message); },
  };
  const oldHostMetrics = {
    operations: { enqueued: 7, pending: 0, highWater: 1 },
    wall: { workerStartToLastReportMs: null },
    workerMessages: { gxFrames: 3, drawCalls: 5, receivedArrayBufferBytes: 128 },
  };
  const oldTemporalFrames = [{ ordinal: 1 }];
  const context = {
    Array,
    JSON,
    Math,
    Promise,
    document: { body: { dataset: { renderer: "wgpu-webgpu" } } },
    discStatus: { textContent: "ready" },
    output: { textContent: "RUNNING" },
    performance: { now: () => 175 },
    rendererHostMetrics: oldHostMetrics,
    rendererWorkerStartedAt: 100,
    runnerStatus: { textContent: "running" },
    terminalPublicationSequence: 0,
    temporalSelectedXfbFrames: oldTemporalFrames,
    worker: oldWorker,
    captureRendererTerminal(hostMetrics, temporalFrames) {
      let resolve;
      let reject;
      const pending = new Promise((resolvePending, rejectPending) => {
        resolve = resolvePending;
        reject = rejectPending;
      });
      captures.push({ hostMetrics, temporalFrames, pending, reject, resolve });
      return pending;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "parseWorkerTerminalReport",
      "publishWorkerTerminalReport",
      "handleWorkerMessage",
      "handleWorkerError",
      "handleRendererError",
    ]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.terminal-publication.js" },
  );
  return {
    captures,
    context,
    oldHostMetrics,
    oldTemporalFrames,
    oldWorker,
    rendererNotifications,
  };
}

test("packed renderer copies transfer one exact frame without dropping work", () => {
  const { context, messages, transfers } = workerHarness();
  const packet = new ArrayBuffer(128);
  const frame = {
    index: 7,
    geometry: { drawCalls: 2, vertices: 6 },
  };
  const packCalls = [];
  context.packGxFramePacketV2 = (copyKind, packedFrame, residentTextureKeys) => {
    packCalls.push([copyKind, packedFrame, residentTextureKeys]);
    return packet;
  };

  context.postGxFrame(2, frame);

  assert.deepEqual(packCalls, [[2, frame, context.rendererResidentTextureKeys]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "gx-frame");
  assert.strictEqual(messages[0].packet, packet);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].diagnostics)), {
    copyKind: 2,
    index: 7,
    drawCalls: 2,
    vertices: 6,
  });
  assert.equal(messages[0].rendererSequence, 1);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].length, 1);
  assert.strictEqual(transfers[0][0], packet);
  assert.equal(context.rendererFramesInFlight.size, 1);
  assert.equal(context.rendererFrameHighWater, 1);

  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    residentTextureKeys: ["alpha"],
  });

  assert.equal(context.rendererFramesInFlight.size, 0);
  assert.equal(context.rendererFramesAcknowledged, 1);
  assert.equal(context.rendererFailure, null);
  assert.deepEqual([...context.rendererResidentTextureKeys], ["alpha"]);
});

test("gx-frame transfer detaches only the sender's packet", () => {
  const { context, messages, transfers } = workerHarness({ transferMessages: true });
  const packet = new ArrayBuffer(128);
  new Uint8Array(packet)[0] = 0x4c;
  context.packGxFramePacketV2 = () => packet;

  context.postGxFrame(1, {
    index: 3,
    geometry: { drawCalls: 0, vertices: 0 },
  });

  assert.equal(packet.byteLength, 0);
  assert.strictEqual(transfers[0][0], packet);
  assert.notStrictEqual(messages[0].packet, packet);
  assert.equal(messages[0].packet.byteLength, 128);
  assert.equal(new Uint8Array(messages[0].packet)[0], 0x4c);
});

test("concurrent GX packets do not trust an in-flight residency snapshot", () => {
  const { context } = workerHarness();
  context.rendererResidentTextureKeys = new Set(["resident"]);
  const residencyArguments = [];
  context.packGxFramePacketV2 = (_copyKind, _frame, residentTextureKeys) => {
    residencyArguments.push(residentTextureKeys);
    return new ArrayBuffer(128);
  };
  const frame = { index: 1, geometry: { drawCalls: 0, vertices: 0 } };

  context.postGxFrame(1, frame);
  context.postGxFrame(1, { ...frame, index: 2 });

  assert.strictEqual(residencyArguments[0], context.rendererResidentTextureKeys);
  assert.equal(residencyArguments[1], null);
});

test("renderer failures unblock the worker and remain fatal", () => {
  const { context } = workerHarness();
  let resumed = 0;
  context.rendererBackpressureResume = () => { resumed += 1; };
  const packet = new ArrayBuffer(128);
  context.postRendererFrame("gx-frame", { packet, diagnostics: {} }, [packet]);

  context.completeRendererFrame({
    type: "renderer-frame-failed",
    rendererSequence: 1,
    error: "device lost",
  });

  assert.equal(context.rendererFramesInFlight.size, 0);
  assert.equal(context.rendererFrameFailures, 1);
  assert.equal(context.rendererFailure, "device lost");
  assert.equal(resumed, 1);
});

test("unsequenced device failures remain fatal and preserve their first cause", () => {
  const { context } = workerHarness();

  context.recordRendererFailure("WebGPU device lost (Unknown): adapter reset");
  context.recordRendererFailure("later uncaptured validation error");

  assert.equal(
    context.rendererFailure,
    "WebGPU device lost (Unknown): adapter reset",
  );
});

test("terminal reports wait for an in-flight renderer frame even while stopping", async () => {
  const { context, reports } = workerHarness();
  context.runnerStopRequested = true;
  const packet = new ArrayBuffer(128);
  context.postRendererFrame("gx-frame", { packet, diagnostics: {} }, [packet]);

  const terminal = context.finishAfterRendererDrain("stopped", {
    stage: "terminal-pc",
  });
  await Promise.resolve();
  assert.deepEqual(reports, []);

  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
  });
  await terminal;

  assert.deepEqual(JSON.parse(JSON.stringify(reports)), [{
    status: "stopped",
    details: { stage: "terminal-pc" },
  }]);
});

test("renderer failure replaces a pending terminal report", async () => {
  const { context, reports } = workerHarness();
  const packet = new ArrayBuffer(128);
  context.postRendererFrame("gx-frame", { packet, diagnostics: {} }, [packet]);

  const terminal = context.finishAfterRendererDrain("stopped", {
    stage: "terminal-pc",
  });
  await Promise.resolve();
  context.completeRendererFrame({
    type: "renderer-frame-failed",
    rendererSequence: 1,
    error: "uncaptured WebGPU validation error",
  });

  await assert.rejects(terminal, error => error === Symbol.for("reported"));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].details.stage, "renderer");
  assert.equal(reports[0].details.error, "uncaptured WebGPU validation error");
});

test("the page publishes a terminal report only after one bound renderer capture", async () => {
  const harness = terminalPublicationHarness();
  const pending = harness.context.handleWorkerMessage({
    currentTarget: harness.oldWorker,
    data: {
      type: "finish",
      text: JSON.stringify({
        stage: "scenario-complete",
        status: "paused",
      }),
    },
  });

  assert.equal(harness.context.output.textContent, "CAPTURING");
  assert.equal(harness.captures.length, 1);
  assert.strictEqual(harness.captures[0].hostMetrics, harness.oldHostMetrics);
  assert.strictEqual(harness.captures[0].temporalFrames, harness.oldTemporalFrames);
  assert.equal(harness.oldHostMetrics.wall.workerStartToLastReportMs, 75);

  harness.captures[0].resolve({
    backend: "forged-backend",
    metrics: { scope: "current-worker" },
    selectedXfb: null,
    temporalSelectedXfb: { capacity: 8, frames: [] },
  });
  assert.equal(await pending, true);
  assert.deepEqual(JSON.parse(harness.context.output.textContent), {
    stage: "scenario-complete",
    status: "paused",
    rendering: {
      backend: "wgpu-webgpu",
      metrics: { scope: "current-worker" },
      selectedXfb: null,
      temporalSelectedXfb: { capacity: 8, frames: [] },
    },
  });
  assert.deepEqual(harness.rendererNotifications, []);
});

test("an old terminal capture cannot publish success or failure into a new run", async () => {
  for (const outcome of ["success", "failure"]) {
    const harness = terminalPublicationHarness();
    const pending = harness.context.handleWorkerMessage({
      currentTarget: harness.oldWorker,
      data: {
        type: "finish",
        text: JSON.stringify({ status: "paused" }),
      },
    });
    assert.equal(harness.context.output.textContent, "CAPTURING");
    assert.equal(harness.captures.length, 1);

    harness.context.worker = {};
    harness.context.rendererHostMetrics = { wall: { workerStartToLastReportMs: null } };
    harness.context.temporalSelectedXfbFrames = [];
    harness.context.output.textContent = "STARTING NEW RUN";
    if (outcome === "success") {
      harness.captures[0].resolve({
        metrics: {},
        selectedXfb: null,
        temporalSelectedXfb: {},
      });
    } else {
      harness.captures[0].reject(new Error("old readback failed"));
    }

    assert.equal(await pending, false);
    assert.equal(harness.context.output.textContent, "STARTING NEW RUN");
    assert.deepEqual(harness.rendererNotifications, []);
  }
});

test("a superseded same-worker terminal capture cannot publish success or failure", async () => {
  for (const outcome of ["success", "failure"]) {
    const harness = terminalPublicationHarness();
    const first = harness.context.handleWorkerMessage({
      currentTarget: harness.oldWorker,
      data: {
        type: "finish",
        text: JSON.stringify({ report: "first", status: "paused" }),
      },
    });
    const second = harness.context.handleWorkerMessage({
      currentTarget: harness.oldWorker,
      data: {
        type: "finish",
        text: JSON.stringify({ report: "second", status: "paused" }),
      },
    });
    assert.equal(harness.context.output.textContent, "CAPTURING");
    assert.equal(harness.captures.length, 2);

    if (outcome === "success") {
      harness.captures[0].resolve({
        metrics: { report: "first" },
        selectedXfb: null,
        temporalSelectedXfb: {},
      });
    } else {
      harness.captures[0].reject(new Error("superseded readback failed"));
    }
    assert.equal(await first, false);
    assert.equal(harness.context.output.textContent, "CAPTURING");
    assert.deepEqual(harness.rendererNotifications, []);

    harness.captures[1].resolve({
      metrics: { report: "second" },
      selectedXfb: null,
      temporalSelectedXfb: {},
    });
    assert.equal(await second, true);
    assert.equal(JSON.parse(harness.context.output.textContent).report, "second");
  }
});

test("worker and renderer-capture failures retain page-owned error envelopes", async () => {
  const workerFailure = terminalPublicationHarness();
  const interruptedCapture = workerFailure.context.handleWorkerMessage({
    currentTarget: workerFailure.oldWorker,
    data: {
      type: "finish",
      text: JSON.stringify({ stage: "snapshot", status: "running" }),
    },
  });
  workerFailure.context.handleWorkerError({
    currentTarget: workerFailure.oldWorker,
    message: "guest worker crashed",
  });
  const workerErrorEnvelope = workerFailure.context.output.textContent;
  assert.deepEqual(JSON.parse(workerErrorEnvelope), {
    status: "stopped",
    stage: "worker",
    error: "guest worker crashed",
    rendering: {
      backend: "wgpu-webgpu",
      error: "guest worker crashed",
    },
  });
  workerFailure.captures[0].resolve({
    metrics: {},
    selectedXfb: null,
    temporalSelectedXfb: {},
  });
  assert.equal(await interruptedCapture, false);
  assert.equal(workerFailure.context.output.textContent, workerErrorEnvelope);

  const rendererFailure = terminalPublicationHarness();
  const pending = rendererFailure.context.handleWorkerMessage({
    currentTarget: rendererFailure.oldWorker,
    data: {
      type: "finish",
      text: JSON.stringify({ stage: "scenario-complete", status: "paused" }),
    },
  });
  rendererFailure.captures[0].reject(new Error("readback device lost"));
  assert.equal(await pending, false);
  assert.deepEqual(JSON.parse(rendererFailure.context.output.textContent), {
    status: "stopped",
    stage: "worker",
    error: "WebGPU renderer failed: readback device lost",
    rendering: {
      backend: "wgpu-webgpu",
      error: "readback device lost",
    },
  });
  assert.deepEqual(rendererFailure.rendererNotifications, []);
});

test("main thread acknowledges a frame only after the WebGPU drain resolves", async () => {
  const messages = [];
  let resolveDrain;
  const context = {
    Number,
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      return new Promise(resolve => { resolveDrain = resolve; });
    },
    handleRendererError(error) { throw error; },
    worker: { postMessage(message) { messages.push(message); } },
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation", "handleRendererFrame"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.main.js" },
  );

  const pending = context.handleRendererFrame(
    { rendererSequence: 4 },
    () => {},
  );
  await Promise.resolve();
  assert.deepEqual(messages, []);
  resolveDrain();
  await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "renderer-frame-complete",
    rendererSequence: 4,
  }]);
});

test("temporal XFB readback completes before its VI frame acknowledgement", async () => {
  const calls = [];
  const messages = [];
  let resolveCapture;
  const currentWorker = { postMessage(message) { messages.push(message); } };
  const context = {
    Number,
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      calls.push("drain");
      return Promise.resolve();
    },
    captureTemporalSelectedXfb(message, presented) {
      calls.push(`capture:${message.rendererSequence}:${presented}`);
      return new Promise(resolve => { resolveCapture = resolve; });
    },
    temporalSelectedXfbFrames: [],
    handleRendererError(error) { throw error; },
    worker: currentWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation", "handleRendererFrame"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.temporal-xfb.js" },
  );

  const pending = context.handleRendererFrame({
    type: "vi-present",
    rendererSequence: 9,
    frame: { temporalXfbCapture: { ordinal: 1 } },
  }, () => true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["drain", "capture:9:true"]);
  assert.deepEqual(messages, []);

  resolveCapture();
  await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "renderer-frame-complete",
    rendererSequence: 9,
  }]);
});

test("a replaced worker cannot leak a pending temporal capture into the next run", async () => {
  const messages = [];
  const oldFrames = [];
  const replacementFrames = [];
  let finishCapture;
  const oldWorker = { postMessage(message) { messages.push(message); } };
  const replacementWorker = { postMessage() {} };
  const context = {
    Number,
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() { return Promise.resolve(); },
    captureTemporalSelectedXfb(_message, _presented, frames) {
      return new Promise(resolve => {
        finishCapture = () => {
          frames.push({ ordinal: 1 });
          resolve();
        };
      });
    },
    temporalSelectedXfbFrames: oldFrames,
    handleRendererError(error) { throw error; },
    worker: oldWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation", "handleRendererFrame"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.temporal-worker-replacement.js" },
  );

  const pending = context.handleRendererFrame({
    type: "vi-present",
    rendererSequence: 10,
    frame: { temporalXfbCapture: { ordinal: 1 } },
  }, () => true);
  await new Promise(resolve => setImmediate(resolve));
  context.temporalSelectedXfbFrames = replacementFrames;
  context.worker = replacementWorker;
  finishCapture();

  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: false,
    value: null,
  });
  assert.deepEqual(oldFrames, [{ ordinal: 1 }]);
  assert.deepEqual(replacementFrames, []);
  assert.deepEqual(messages, []);
});

test("deferred WebGPU failures reject the frame instead of acknowledging it", async () => {
  const messages = [];
  const visibleErrors = [];
  const context = {
    Number,
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      return Promise.reject(new Error("WebGPU device lost (Unknown)"));
    },
    handleRendererError(error, notifyWorker) {
      visibleErrors.push([error.message, notifyWorker]);
    },
    worker: { postMessage(message) { messages.push(message); } },
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation", "handleRendererFrame"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    {
    filename: "browser_boot.renderer-sync.main.js",
    },
  );

  await context.handleRendererFrame({ rendererSequence: 5 }, () => {});

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "renderer-frame-failed",
    rendererSequence: 5,
    error: "WebGPU device lost (Unknown)",
  }]);
  assert.deepEqual(visibleErrors, [["WebGPU device lost (Unknown)", false]]);
});

test("malformed GX packets fail synchronously without a drain or acknowledgement", async () => {
  const messages = [];
  const visibleErrors = [];
  const submissions = [];
  let drainCalls = 0;
  const currentWorker = {
    postMessage(message) { messages.push(message); },
  };
  const context = {
    Array,
    ArrayBuffer,
    Number,
    Promise,
    String,
    TypeError,
    Uint8Array,
    document: { body: { dataset: {} } },
    rendererHostMetrics: {
      ...rendererOperationMetrics(),
      workerMessages: { gxFrames: 0, drawCalls: 0, receivedArrayBufferBytes: 0 },
    },
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      drainCalls += 1;
      return Promise.resolve();
    },
    handleRendererError(error, notifyWorker) {
      visibleErrors.push([error.message, notifyWorker]);
    },
    webGpuRenderer: {
      submit_gx_frame(packet) {
        submissions.push(packet);
        throw new Error("invalid LZGX packet magic [00, 00, 00, 00]");
      },
    },
    worker: currentWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "appendRendererOperation",
      "enqueueRendererOperation",
      "submitGxFrame",
      "handleRendererFrame",
      "handleWorkerMessage",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.malformed-gx-frame.js" },
  );

  const result = await context.handleWorkerMessage({
    currentTarget: currentWorker,
    data: {
      type: "gx-frame",
      packet: new ArrayBuffer(128),
      diagnostics: { copyKind: 2, index: 7, drawCalls: 2, vertices: 6 },
      rendererSequence: 23,
    },
  });

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0] instanceof Uint8Array, true);
  assert.equal(drainCalls, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "renderer-frame-failed",
    rendererSequence: 23,
    error: "invalid LZGX packet magic [00, 00, 00, 00]",
  }]);
  assert.deepEqual(visibleErrors, [[
    "invalid LZGX packet magic [00, 00, 00, 00]",
    false,
  ]]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, value: null });
  assert.equal(context.document.body.dataset.xfbCopies, undefined);
});

test("structured GX clears remain serialized before the following GX frame", async () => {
  assert.match(
    source,
    /gxSkippedCopyClears\.push\(gxCopyClearOperation\(frame\)\)/,
  );
  assert.match(
    source,
    /for \(const clear of gxSkippedCopyClears\) \{\s*postMessage\(\{ type: "gx-clear", clear \}\);/,
  );
  assert.match(
    source,
    /else if \(frame\.clear\) \{\s*gxFlushSkippedCopyClears\(\);\s*postMessage\(\{ type: "gx-clear", clear: gxCopyClearOperation\(frame\) \}\);/,
  );
  assert.doesNotMatch(source, /type: "efb-clear"/);

  const calls = [];
  const messages = [];
  let releaseClearDrain;
  let drainCalls = 0;
  const currentWorker = {
    postMessage(message) { messages.push(message); },
  };
  const context = {
    Array,
    ArrayBuffer,
    Number,
    Promise,
    String,
    TypeError,
    Uint8Array,
    document: { body: { dataset: {} } },
    rendererHostMetrics: {
      ...rendererOperationMetrics(),
      workerMessages: { gxFrames: 0, drawCalls: 0, receivedArrayBufferBytes: 0 },
    },
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      drainCalls += 1;
      calls.push(`drain:${drainCalls}`);
      if (drainCalls === 1) {
        return new Promise(resolve => { releaseClearDrain = resolve; });
      }
      return Promise.resolve();
    },
    handleRendererError(error) { throw error; },
    webGpuRenderer: {
      clear_efb(red, green, blue) {
        calls.push(`clear:${red},${green},${blue}`);
      },
      submit_gx_frame() {
        calls.push("gx-frame");
        return [];
      },
    },
    worker: currentWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "appendRendererOperation",
      "enqueueRendererOperation",
      "gxClearEfb",
      "submitGxFrame",
      "handleRendererFrame",
      "handleRendererOperation",
      "handleWorkerMessage",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.efb-clear.js" },
  );

  const copyState = {
    zMode: 0x17,
    blendMode: 0x5a9,
    pixelControl: 3,
    copyCommand: 0x800,
    clearRgba: [4, 5, 6, 0xff],
    clearDepth: 0x123456,
    copyScale: 0x100,
    copyFilter: [0x111111, 0x222222],
  };
  const clear = context.handleWorkerMessage({
    currentTarget: currentWorker,
    data: {
      type: "gx-clear",
      clear: {
        sourceX: 7,
        sourceY: 9,
        sourceWidth: 11,
        sourceHeight: 13,
        copyState,
      },
    },
  });
  const frame = context.handleWorkerMessage({
    currentTarget: currentWorker,
    data: {
      type: "gx-frame",
      packet: new ArrayBuffer(128),
      diagnostics: { copyKind: 1, index: 8, drawCalls: 0, vertices: 0 },
      rendererSequence: 24,
    },
  });
  await Promise.resolve();

  assert.deepEqual(calls, ["clear:4,5,6", "drain:1"]);
  assert.deepEqual(messages, []);
  releaseClearDrain();
  await clear;
  await frame;

  assert.deepEqual(calls, [
    "clear:4,5,6",
    "drain:1",
    "gx-frame",
    "drain:2",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "renderer-frame-complete",
    rendererSequence: 24,
    residentTextureKeys: [],
  }]);
});

test("a replaced worker cannot receive a stale WebGPU frame completion", async () => {
  const oldMessages = [];
  const newMessages = [];
  const visibleErrors = [];
  let resolveDrain;
  const oldWorker = { postMessage(message) { oldMessages.push(message); } };
  const newWorker = { postMessage(message) { newMessages.push(message); } };
  const context = {
    Number,
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      return new Promise(resolve => { resolveDrain = resolve; });
    },
    handleRendererError(error) { visibleErrors.push(error); },
    worker: oldWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation", "handleRendererFrame"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    {
    filename: "browser_boot.renderer-sync.replaced-worker.js",
    },
  );

  const pending = context.handleRendererFrame(
    { rendererSequence: 1 },
    () => {},
    oldWorker,
  );
  await Promise.resolve();
  context.worker = newWorker;
  resolveDrain();
  await pending;

  assert.deepEqual(oldMessages, []);
  assert.deepEqual(newMessages, []);
  assert.deepEqual(visibleErrors, []);
});

test("unawaited VI frames remain serialized behind WebGPU drains", async () => {
  const calls = [];
  const acknowledgements = [];
  let releaseFirstDrain;
  let drainCount = 0;
  const currentWorker = {};
  currentWorker.postMessage = message => { acknowledgements.push(message); };
  const context = {
    Number,
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    worker: currentWorker,
    drainWebGpuRenderer() {
      drainCount += 1;
      if (drainCount === 1) {
        return new Promise(resolve => { releaseFirstDrain = resolve; });
      }
      return Promise.resolve();
    },
    handleRendererError(error) { throw error; },
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation", "handleRendererFrame"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.vi-queue.js" },
  );

  const first = context.handleRendererFrame({ rendererSequence: 1 }, () => {
    calls.push("top");
    return true;
  });
  await Promise.resolve();
  const second = context.handleRendererFrame({ rendererSequence: 2 }, () => {
    calls.push("bottom");
    return true;
  });
  await Promise.resolve();

  assert.deepEqual(calls, ["top"]);
  assert.equal(drainCount, 1);
  releaseFirstDrain();
  await first;
  await second;
  assert.deepEqual(calls, ["top", "bottom"]);
  assert.equal(drainCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(acknowledgements)), [
    { type: "renderer-frame-complete", rendererSequence: 1 },
    { type: "renderer-frame-complete", rendererSequence: 2 },
  ]);
});

test("disc resets wait behind pending WebGPU presentation work", async () => {
  const calls = [];
  let releaseFirstDrain;
  let drainCount = 0;
  const currentWorker = { postMessage() {} };
  const context = {
    Number,
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    worker: currentWorker,
    output: { textContent: "" },
    webGpuRenderer: {
      reset() { calls.push("reset"); },
      reset_diagnostics() {},
    },
    drainWebGpuRenderer() {
      drainCount += 1;
      if (drainCount === 1) {
        return new Promise(resolve => { releaseFirstDrain = resolve; });
      }
      return Promise.resolve();
    },
    handleRendererError(error) { throw error; },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "appendRendererOperation",
      "enqueueRendererOperation",
      "handleRendererFrame",
      "resetPresentation",
    ]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.reset-queue.js" },
  );

  const presentation = context.handleRendererFrame({ rendererSequence: 1 }, () => {
    calls.push("present");
    return true;
  });
  await Promise.resolve();
  const reset = context.resetPresentation();
  await Promise.resolve();

  assert.deepEqual(calls, ["present"]);
  assert.equal(context.output.textContent, "STARTING");
  releaseFirstDrain();
  await presentation;
  await reset;
  assert.deepEqual(calls, ["present", "reset"]);
  assert.equal(drainCount, 2);
});

test("a failed queued operation does not poison later WebGPU work", async () => {
  const calls = [];
  const context = {
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    {
    filename: "browser_boot.renderer-sync.queue-recovery.js",
    },
  );

  const failure = context.enqueueRendererOperation(() => {
    calls.push("failed");
    throw new Error("validation failure");
  });
  await assert.rejects(failure, /validation failure/);
  await context.enqueueRendererOperation(() => { calls.push("recovered"); });

  assert.deepEqual(calls, ["failed", "recovered"]);
});

test("a failed diagnostic operation does not poison or account later work", async () => {
  const calls = [];
  const context = {
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.diagnostic-recovery.js" },
  );

  await assert.rejects(
    context.appendRendererOperation(() => {
      calls.push("diagnostic");
      throw new Error("readback failure");
    }),
    /readback failure/,
  );
  await context.enqueueRendererOperation(() => { calls.push("runtime"); });

  assert.deepEqual(calls, ["diagnostic", "runtime"]);
  assert.deepEqual(context.rendererHostMetrics.operations, {
    enqueued: 1,
    pending: 0,
    highWater: 1,
  });
});

test("renderer operation metrics include queued work and settle after failures", async () => {
  let releaseFirst;
  const context = {
    Promise,
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
  };
  vm.createContext(context);
  vm.runInContext(
    ["appendRendererOperation", "enqueueRendererOperation"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    {
    filename: "browser_boot.renderer-sync.metrics.js",
    },
  );

  const first = context.enqueueRendererOperation(
    () => new Promise(resolve => { releaseFirst = resolve; }),
  );
  const second = context.enqueueRendererOperation(
    () => Promise.reject(new Error("expected failure")),
  );
  await Promise.resolve();
  assert.deepEqual(context.rendererHostMetrics.operations, {
    enqueued: 2,
    pending: 2,
    highWater: 2,
  });

  releaseFirst();
  await first;
  await assert.rejects(second, /expected failure/);
  await Promise.resolve();
  assert.deepEqual(context.rendererHostMetrics.operations, {
    enqueued: 2,
    pending: 0,
    highWater: 2,
  });
});

test("guest execution waits for renderer completion before another block", () => {
  assert.match(
    source,
    /for \(;;\) \{[\s\S]*?while \(rendererFramesInFlight\.size !== 0 \|\| rendererFailure !== null\) \{\s*await honorRendererBackpressure\(\);\s*if \(runnerStopRequested\) break;\s*serviceVideoPresentation\(cycles\);\s*\}[\s\S]*?stage = "compile";/,
  );
  assert.match(source, /postGxFrame\(2, frame\)/);
  assert.match(source, /postGxFrame\(1, frame\)/);
  assert.match(
    source,
    /postRendererFrame\("gx-frame", \{ packet, diagnostics \}, \[packet\]\)/,
  );
  assert.doesNotMatch(source, /postRendererFrame\("(?:xfb|texture)-copy"/);
  assert.match(source, /postRendererFrame\("vi-present", \{/);
  assert.match(source, /await finishAfterRendererDrain\("stopped", \{\s*stage: "terminal-pc"/);
});
