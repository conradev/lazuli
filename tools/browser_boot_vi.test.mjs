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
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function evaluateFunctions(names, bindings = {}) {
  const context = { ...bindings };
  vm.createContext(context);
  vm.runInContext(names.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.vi.js",
  });
  return context;
}

test("VI framebuffer POFF is shared by top and bottom fields", () => {
  const context = evaluateFunctions(["viXfbAddressFromRaw"]);

  assert.equal(context.viXfbAddressFromRaw(0x00012345, 0x10012345), 0x002468a0);
  assert.equal(context.viXfbAddressFromRaw(0x00012346, 0x10012345), 0x002468c0);
  assert.equal(context.viXfbAddressFromRaw(0x10012346, 0x00012345), 0x00012346);
});

test("VI presentation targets begin at the active lines of each NTSC field", () => {
  const context = evaluateFunctions(["viActiveFieldTargets"]);
  const timing = {
    equ: 6,
    acv: 240,
    oddPrb: 24,
    oddPsb: 3,
    evenPrb: 25,
    evenPsb: 2,
    totalHalfLines: 1050,
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.viActiveFieldTargets(timing))),
    [
      { field: "top", halfLine: 42, registerOffset: 0x201c },
      { field: "bottom", halfLine: 567, registerOffset: 0x2024 },
    ],
  );
});

test("VI single-field mode schedules only TFBL", () => {
  const context = evaluateFunctions(["viActiveFieldTargets"]);
  const timing = {
    singleField: true,
    equ: 6,
    acv: 240,
    oddPrb: 24,
    oddPsb: 3,
    evenPrb: 25,
    evenPsb: 2,
    totalHalfLines: 525,
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.viActiveFieldTargets(timing))),
    [{ field: "top", halfLine: 42, registerOffset: 0x201c }],
  );
});

test("VI single-field timing excludes the unused even field", () => {
  const registers = new Map([
    [0x2000, (240 << 4) | 6],
    [0x2002, 5],
    [0x2004, 429],
    [0x200c, (3 << 16) | 24],
    [0x2010, (2 << 16) | 25],
    [0x206c, 0],
  ]);
  const context = evaluateFunctions(["decodeViTiming"], {
    mmio: 0,
    viClockFrequencies: [27_000_000, 54_000_000],
    viCpuCyclesPerSecond: 486_000_000,
    view: {
      getUint16(address) { return registers.get(address) ?? 0; },
      getUint32(address) { return registers.get(address) ?? 0; },
    },
  });

  const timing = context.decodeViTiming();
  assert.equal(timing.valid, true);
  assert.equal(timing.singleField, true);
  assert.equal(timing.totalHalfLines, timing.oddHalfLines);
  assert.equal(timing.frameCycles, timing.oddFieldCycles);
});

test("XFB selection rejects an unrelated double buffer as a deep row alias", () => {
  const context = evaluateFunctions(["gxXfbCopyRowOffset", "gxResolveXfbCopy"], {
    gxXfbCopies: [{
      index: 12,
      captured: true,
      destination: 0x00307180,
      stride: 0x500,
      height: 448,
    }],
  });

  assert.equal(context.gxXfbCopyRowOffset(context.gxXfbCopies[0], 0x00392c80), 447);
  assert.equal(context.gxResolveXfbCopy(0x00392c80), null);
  assert.equal(context.gxResolveXfbCopy(0x00307680).row, 1);
});

test("VI presentation deadline exists without a configured comparator", () => {
  const timing = {
    displayEnabled: true,
    cyclesPerHalfLine: 10,
    totalHalfLines: 1050,
    equ: 6,
    acv: 240,
    oddPrb: 24,
    oddPsb: 3,
    evenPrb: 25,
    evenPsb: 2,
  };
  const context = evaluateFunctions(
    [
      "viActiveFieldTargets",
      "viCurrentHalfLine",
      "viCycleForHalfLineAfter",
      "nextViPresentationCycleAfter",
    ],
    {
      viTiming: timing,
      viEpochCycle: 0,
      viEpochHalfLine: 0,
    },
  );

  assert.equal(context.nextViPresentationCycleAfter(0), 420);
  assert.equal(context.nextViPresentationCycleAfter(420), 5670);
  assert.match(
    source,
    /viTiming\?\.displayEnabled \? nextViPresentCycle : null/,
  );
});

test("VI single-field presentation repeats once per top-field frame", () => {
  const timing = {
    displayEnabled: true,
    singleField: true,
    cyclesPerHalfLine: 10,
    totalHalfLines: 525,
    equ: 6,
    acv: 240,
    oddPrb: 24,
    oddPsb: 3,
    evenPrb: 25,
    evenPsb: 2,
  };
  const context = evaluateFunctions(
    [
      "viActiveFieldTargets",
      "viCurrentHalfLine",
      "viCycleForHalfLineAfter",
      "nextViPresentationCycleAfter",
    ],
    {
      viTiming: timing,
      viEpochCycle: 0,
      viEpochHalfLine: 0,
    },
  );

  assert.equal(context.nextViPresentationCycleAfter(0), 420);
  assert.equal(context.nextViPresentationCycleAfter(420), 5670);
  assert.equal(context.nextViPresentationCycleAfter(5670), 10920);
});

test("VI dimensions distinguish interlaced and single-field output", () => {
  const context = evaluateFunctions(["decodeViOutputDimensions"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.decodeViOutputDimensions(0x2828, 0, 240))),
    { width: 640, height: 480 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.decodeViOutputDimensions(0x2828, 4, 240))),
    { width: 640, height: 240 },
  );
});

test("VI field service selects a cached XFB independently of comparators", () => {
  const messages = [];
  const frame = {
    index: 12,
    captured: true,
    capturedAtCycle: 300,
    destination: 0x01200000,
    stride: 0x500,
    height: 480,
    displayed: false,
  };
  const context = evaluateFunctions(
    [
      "viActiveFieldTargets",
      "gxXfbCopyRowOffset",
      "gxResolveXfbCopy",
      "postRendererFrame",
      "serviceVideoPresentation",
    ],
    {
      deviceEvents: new Map(),
      gxFramesPresented: 0,
      gxXfbCopies: [frame],
      hex32(value) { return `0x${value.toString(16).padStart(8, "0")}`; },
      nextViPresentCycle: 420,
      nextViPresentationCycleAfter() { return 5670; },
      postMessage(message) { messages.push(message); },
      rendererFrameHighWater: 0,
      rendererFrameSequence: 0,
      rendererFramesInFlight: new Set(),
      traceVi() {},
      viCurrentHalfLine() { return 42; },
      viLastPresentationAddress: 0,
      viLastPresentationCopyIndex: 0,
      viLastPresentationCopyRow: 0,
      viLastPresentationCycle: null,
      viLastPresentationField: null,
      viOutputDimensions() { return { width: 640, height: 480 }; },
      viPresentationCount: 0,
      viTiming: {
        equ: 6,
        acv: 240,
        oddPrb: 24,
        oddPsb: 3,
        evenPrb: 25,
        evenPsb: 2,
        totalHalfLines: 1050,
      },
      viXfbAddress() { return 0x01200000; },
    },
  );

  context.serviceVideoPresentation(420);

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "vi-present",
    frame: {
      field: "top",
      address: 0x01200000,
      width: 640,
      height: 480,
      copyIndex: 12,
      copyRow: 0,
    },
    rendererSequence: 1,
  }]);
  assert.equal(frame.displayed, true);
  assert.equal(frame.capturedAtCycle, 300);
  assert.equal(frame.displayedAtCycle, 420);
  assert.equal(frame.displayedField, "top");
  assert.equal(context.nextViPresentCycle, 5670);
  assert.equal(context.deviceEvents.get("viField"), 1);
  assert.equal(context.viLastPresentationCopyIndex, 12);
  assert.equal(context.viLastPresentationCycle, 420);
  assert.equal(context.viLastPresentationCopyRow, 0);
  assert.deepEqual([...context.rendererFramesInFlight], [1]);

  context.viCurrentHalfLine = () => 567;
  context.viXfbAddress = () => 0x01200500;
  context.serviceVideoPresentation(5670);
  assert.equal(messages.length, 1, "an in-flight presentation must backpressure VI");
  assert.equal(context.nextViPresentCycle, 5670);

  context.rendererFramesInFlight.clear();
  context.serviceVideoPresentation(5670);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "vi-present",
    frame: {
      field: "bottom",
      address: 0x01200500,
      width: 640,
      height: 480,
      copyIndex: 12,
      copyRow: 1,
    },
    rendererSequence: 2,
  });
  assert.deepEqual([...context.rendererFramesInFlight], [2]);
  assert.equal(context.viLastPresentationCopyIndex, 12);
  assert.equal(context.viLastPresentationCopyRow, 1);
});

test("main thread caches XFB copies and presents only on VI messages", async () => {
  const calls = [];
  const workerMessages = [];
  const context = evaluateFunctions(
    [
      "appendRendererOperation",
      "enqueueRendererOperation",
      "handleRendererFrame",
      "handleRendererOperation",
      "handleWorkerMessage",
    ],
    {
      document: { body: { dataset: {} } },
      drainWebGpuRenderer() { return Promise.resolve(); },
      gxClearEfb() {},
      handleRendererError(error) { throw error; },
      output: { textContent: "" },
      rendererHostMetrics: {
        operations: { enqueued: 0, pending: 0, highWater: 0 },
      },
      rendererOperationTail: Promise.resolve(),
      queueGxGeometry(frame) { calls.push(["geometry", frame.index]); },
      runnerStatus: { textContent: "" },
      worker: { postMessage(message) { workerMessages.push(message); } },
      webGpuRenderer: {
        copy_texture() { calls.push(["texture-copy"]); },
        copy_xfb(...args) { calls.push(["xfb-copy", ...args]); },
        present_xfb(...args) {
          calls.push(["vi-present", ...args]);
          return true;
        },
      },
    },
  );
  const frame = {
    index: 7,
    sourceX: 1,
    sourceY: 2,
    width: 640,
    sourceHeight: 528,
    height: 480,
    destination: 0x01200000,
    stride: 0x500,
    clear: true,
    clearColor: [4, 5, 6, 255],
    geometry: { drawCalls: 1, vertices: 3, draws: [] },
  };

  await context.handleWorkerMessage({
    data: { type: "xfb-copy", frame, rendererSequence: 19 },
  });
  assert.deepEqual(calls[0], ["geometry", 7]);
  assert.deepEqual(calls[1], [
    "xfb-copy",
    1,
    2,
    640,
    528,
    640,
    480,
    0x01200000,
    0x500,
    7,
    true,
    4,
    5,
    6,
  ]);
  assert.equal(calls.some(([name]) => name === "vi-present"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(workerMessages)), [{
    type: "renderer-frame-complete",
    rendererSequence: 19,
  }]);

  await context.handleWorkerMessage({
    data: {
      type: "vi-present",
      frame: {
        field: "bottom",
        address: 0x01200500,
        width: 640,
        height: 480,
        copyIndex: 7,
        copyRow: 1,
      },
      rendererSequence: 20,
    },
  });
  assert.deepEqual(calls.at(-1), ["vi-present", 0x01200500, 7, 1, 640, 480]);
  assert.equal(context.document.body.dataset.viField, "bottom");
  assert.equal(context.document.body.dataset.viCopyIndex, "7");
  assert.equal(context.document.body.dataset.viCopyRow, "1");
  assert.equal(context.document.body.dataset.viPresents, "1");
  assert.deepEqual(JSON.parse(JSON.stringify(workerMessages.at(-1))), {
    type: "renderer-frame-complete",
    rendererSequence: 20,
  });
});
