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

function workerHarness() {
  const messages = [];
  const reports = [];
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
    postMessage(message) { messages.push(message); },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "postRendererFrame",
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
  return { context, messages, reports };
}

test("renderer copies are sequenced and acknowledged without dropping work", () => {
  const { context, messages } = workerHarness();
  const frame = { index: 7 };

  context.postRendererFrame("xfb-copy", frame);

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "xfb-copy",
    frame,
    rendererSequence: 1,
  }]);
  assert.equal(context.rendererFramesInFlight.size, 1);
  assert.equal(context.rendererFrameHighWater, 1);

  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
  });

  assert.equal(context.rendererFramesInFlight.size, 0);
  assert.equal(context.rendererFramesAcknowledged, 1);
  assert.equal(context.rendererFailure, null);
});

test("renderer failures unblock the worker and remain fatal", () => {
  const { context } = workerHarness();
  let resumed = 0;
  context.rendererBackpressureResume = () => { resumed += 1; };
  context.postRendererFrame("texture-copy", { index: 3 });

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
  context.postRendererFrame("xfb-copy", { index: 9 });

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
  context.postRendererFrame("xfb-copy", { index: 10 });

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

test("main thread acknowledges a frame only after the WebGPU drain resolves", async () => {
  const messages = [];
  let resolveDrain;
  const context = {
    Number,
    Promise,
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      return new Promise(resolve => { resolveDrain = resolve; });
    },
    handleRendererError(error) { throw error; },
    worker: { postMessage(message) { messages.push(message); } },
  };
  vm.createContext(context);
  vm.runInContext(
    ["enqueueRendererOperation", "handleRendererFrame"]
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

test("deferred WebGPU failures reject the frame instead of acknowledging it", async () => {
  const messages = [];
  const visibleErrors = [];
  const context = {
    Number,
    Promise,
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
    ["enqueueRendererOperation", "handleRendererFrame"]
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
    rendererOperationTail: Promise.resolve(),
    drainWebGpuRenderer() {
      return new Promise(resolve => { resolveDrain = resolve; });
    },
    handleRendererError(error) { visibleErrors.push(error); },
    worker: oldWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    ["enqueueRendererOperation", "handleRendererFrame"]
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
    ["enqueueRendererOperation", "handleRendererFrame"]
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
    rendererOperationTail: Promise.resolve(),
    worker: currentWorker,
    output: { textContent: "" },
    webGpuRenderer: {
      reset() { calls.push("reset"); },
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
    ["enqueueRendererOperation", "handleRendererFrame", "resetPresentation"]
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
    rendererOperationTail: Promise.resolve(),
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("enqueueRendererOperation"), context, {
    filename: "browser_boot.renderer-sync.queue-recovery.js",
  });

  const failure = context.enqueueRendererOperation(() => {
    calls.push("failed");
    throw new Error("validation failure");
  });
  await assert.rejects(failure, /validation failure/);
  await context.enqueueRendererOperation(() => { calls.push("recovered"); });

  assert.deepEqual(calls, ["failed", "recovered"]);
});

test("guest execution waits for renderer completion before another block", () => {
  assert.match(
    source,
    /for \(;;\) \{[\s\S]*?while \(rendererFramesInFlight\.size !== 0 \|\| rendererFailure !== null\) \{\s*await honorRendererBackpressure\(\);\s*if \(runnerStopRequested\) break;\s*serviceVideoPresentation\(cycles\);\s*\}[\s\S]*?stage = "compile";/,
  );
  assert.match(source, /postRendererFrame\("xfb-copy", frame\)/);
  assert.match(source, /postRendererFrame\("texture-copy", frame\)/);
  assert.match(source, /postRendererFrame\("vi-present", \{/);
  assert.match(source, /await finishAfterRendererDrain\("stopped", \{\s*stage: "terminal-pc"/);
});
