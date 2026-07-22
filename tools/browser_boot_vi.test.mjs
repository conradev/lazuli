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
    JSON.parse(JSON.stringify(context.decodeViOutputDimensions(0x2850, 0, 240))),
    {
      pictureConfiguration: 0x2850,
      wordsPerLine: 40,
      standardWordsPerLine: 80,
      activeLines: 240,
      nonInterlaced: false,
      width: 640,
      fieldStrideBytes: 2560,
      fieldHeight: 240,
      rowRepeat: 2,
      height: 480,
      scanoutPolicy: "bob",
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.decodeViOutputDimensions(0x2828, 4, 240))),
    {
      pictureConfiguration: 0x2828,
      wordsPerLine: 40,
      standardWordsPerLine: 40,
      activeLines: 240,
      nonInterlaced: true,
      width: 640,
      fieldStrideBytes: 1280,
      fieldHeight: 240,
      rowRepeat: 1,
      height: 240,
      scanoutPolicy: "direct",
    },
  );
});

test("SMB VI geometry produces the exact four-row top and bottom bob oracle", () => {
  const context = evaluateFunctions(["decodeViOutputDimensions"]);
  const scanout = context.decodeViOutputDimensions(0x2850, 0, 2);
  const sourceRowStep = scanout.fieldStrideBytes / 0x500;
  const rows = selectedRow => Array.from(
    { length: scanout.height },
    (_unused, outputRow) => selectedRow
      + Math.floor(outputRow / scanout.rowRepeat) * sourceRowStep,
  );

  assert.equal(scanout.scanoutPolicy, "bob");
  assert.equal(sourceRowStep, 2);
  assert.deepEqual(rows(0), [0, 0, 2, 2]);
  assert.deepEqual(rows(1), [1, 1, 3, 3]);
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
      "claimSmbTemporalXfbCapture",
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
      controllerScenario: null,
      smbTemporalXfbCaptureCapacity: 8,
      smbTemporalXfbCapturesPosted: 0,
      traceVi() {},
      viCurrentHalfLine() { return 42; },
      viLastPresentationAddress: 0,
      viLastPresentationCopyIndex: 0,
      viLastPresentationCopyRow: 0,
      viLastPresentationCycle: null,
      viLastPresentationField: null,
      viOutputDimensions() {
        return {
          pictureConfiguration: 0x2850,
          wordsPerLine: 40,
          standardWordsPerLine: 80,
          activeLines: 240,
          nonInterlaced: false,
          width: 640,
          fieldStrideBytes: 2560,
          fieldHeight: 240,
          rowRepeat: 2,
          height: 480,
          scanoutPolicy: "bob",
        };
      },
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
      pictureConfiguration: 0x2850,
      wordsPerLine: 40,
      standardWordsPerLine: 80,
      activeLines: 240,
      nonInterlaced: false,
      fieldStrideBytes: 2560,
      sourceRowStep: 2,
      fieldHeight: 240,
      rowRepeat: 2,
      scanoutPolicy: "bob",
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
      pictureConfiguration: 0x2850,
      wordsPerLine: 40,
      standardWordsPerLine: 80,
      activeLines: 240,
      nonInterlaced: false,
      fieldStrideBytes: 2560,
      sourceRowStep: 2,
      fieldHeight: 240,
      rowRepeat: 2,
      scanoutPolicy: "bob",
    },
    rendererSequence: 2,
  });
  assert.deepEqual([...context.rendererFramesInFlight], [2]);
  assert.equal(context.viLastPresentationCopyIndex, 12);
  assert.equal(context.viLastPresentationCopyRow, 1);
});

test("main thread submits GX XFB frames before separate VI presentation", async () => {
  const calls = [];
  const workerMessages = [];
  let submittedPacket;
  const context = evaluateFunctions(
    [
      "appendRendererOperation",
      "enqueueRendererOperation",
      "submitGxFrame",
      "handleRendererFrame",
      "handleRendererOperation",
      "handleWorkerMessage",
    ],
    {
      ArrayBuffer,
      Uint8Array,
      document: { body: { dataset: {} } },
      drainWebGpuRenderer() { return Promise.resolve(); },
      gxClearEfb() {},
      handleRendererError(error) { throw error; },
      output: { textContent: "" },
      rendererHostMetrics: {
        operations: { enqueued: 0, pending: 0, highWater: 0 },
        workerMessages: { gxFrames: 0, drawCalls: 0, receivedArrayBufferBytes: 0 },
      },
      rendererOperationTail: Promise.resolve(),
      runnerStatus: { textContent: "" },
      worker: { postMessage(message) { workerMessages.push(message); } },
      webGpuRenderer: {
        submit_gx_frame(packet) {
          submittedPacket = packet;
          calls.push(["gx-frame", packet.byteLength]);
          return ["texture-a"];
        },
        present_xfb(...args) {
          calls.push(["vi-present", ...args]);
          return true;
        },
      },
    },
  );
  const packet = new ArrayBuffer(128);

  await context.handleWorkerMessage({
    data: {
      type: "gx-frame",
      packet,
      diagnostics: { copyKind: 2, index: 7, drawCalls: 1, vertices: 3 },
      rendererSequence: 19,
    },
  });
  assert.deepEqual(calls, [["gx-frame", 128]]);
  assert.equal(submittedPacket instanceof Uint8Array, true);
  assert.equal(submittedPacket.buffer, packet);
  assert.equal(calls.some(([name]) => name === "vi-present"), false);
  assert.deepEqual(context.rendererHostMetrics.workerMessages, {
    gxFrames: 1,
    drawCalls: 1,
    receivedArrayBufferBytes: 128,
  });
  assert.equal(context.document.body.dataset.xfbCopies, "7");
  assert.equal(context.document.body.dataset.gxDrawCalls, "1");
  assert.equal(context.document.body.dataset.gxVertices, "3");
  assert.deepEqual(JSON.parse(JSON.stringify(workerMessages)), [{
    type: "renderer-frame-complete",
    rendererSequence: 19,
    residentTextureKeys: ["texture-a"],
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
        fieldStrideBytes: 2560,
        fieldHeight: 240,
        rowRepeat: 2,
        scanoutPolicy: "bob",
      },
      rendererSequence: 20,
    },
  });
  assert.deepEqual(calls.at(-1), [
    "vi-present",
    0x01200500,
    7,
    1,
    640,
    480,
    false,
  ]);
  assert.deepEqual(calls.map(([name]) => name), ["gx-frame", "vi-present"]);
  assert.equal(context.document.body.dataset.viField, "bottom");
  assert.equal(context.document.body.dataset.viCopyIndex, "7");
  assert.equal(context.document.body.dataset.viCopyRow, "1");
  assert.equal(context.document.body.dataset.viPresents, "1");
  assert.deepEqual(JSON.parse(JSON.stringify(workerMessages.at(-1))), {
    type: "renderer-frame-complete",
    rendererSequence: 20,
  });
});
