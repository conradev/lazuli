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
    filename: "browser_boot.vi-pair.js",
  });
  return context;
}

function interlacedFrame(field, pairEpoch, extra = {}) {
  const bottom = field === "bottom";
  return {
    field,
    presentationMode: "interlaced",
    pairEpoch,
    pairCompleting: bottom,
    address: bottom ? 0x01200500 : 0x01200000,
    width: 640,
    height: 480,
    copyIndex: bottom ? 8 : 7,
    copyRow: bottom ? 1 : 0,
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
    ...extra,
  };
}

test("VI bridge consumes exact Awaiting and Ready field-pair results", async () => {
  const calls = [];
  const workerMessages = [];
  let temporalCaptures = 0;
  let compositorCaptures = 0;
  const results = [
    {
      accepted: true,
      presented: false,
      status: "vi-field-pair-awaiting",
      pairEpoch: 17,
      presentationSerial: null,
    },
    {
      accepted: true,
      presented: true,
      status: "vi-interlaced-frame-ready",
      pairEpoch: 17,
      presentationSerial: 9,
    },
  ];
  const context = evaluateFunctions(
    [
      "appendRendererOperation",
      "enqueueRendererOperation",
      "validateViPresentationResult",
      "handleRendererFrame",
      "handleWorkerMessage",
    ],
    {
      captureSmbSustainedViReceipt() {
        throw new Error("unexpected sustained receipt");
      },
      async captureTemporalSelectedXfb() {
        temporalCaptures += 1;
        return { presentedSurface: { presentationSerial: 9 } };
      },
      compositorCaptureEnabled: true,
      document: { body: { dataset: {} } },
      drainWebGpuRenderer() { return Promise.resolve(); },
      handleRendererError(error) { throw error; },
      rendererHostMetrics: {
        operations: { enqueued: 0, pending: 0, highWater: 0 },
      },
      rendererOperationTail: Promise.resolve(),
      temporalSelectedXfbFrames: [],
      async waitForCompositorCapture() {
        compositorCaptures += 1;
      },
      worker: { postMessage(message) { workerMessages.push(message); } },
      webGpuRenderer: {
        present_xfb(...args) {
          calls.push(args);
          return results.shift();
        },
      },
    },
  );

  await context.handleWorkerMessage({
    data: {
      type: "vi-present",
      rendererSequence: 31,
      frame: interlacedFrame("top", 17),
    },
  });
  assert.equal(context.document.body.dataset.viFields, "1");
  assert.equal(context.document.body.dataset.viPresents, undefined);
  assert.equal(temporalCaptures, 0);
  assert.equal(compositorCaptures, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(workerMessages)), [{
    type: "renderer-frame-complete",
    rendererSequence: 31,
    viPresentationResult: {
      accepted: true,
      presented: false,
      status: "vi-field-pair-awaiting",
      pairEpoch: 17,
      presentationSerial: null,
    },
  }]);

  await context.handleWorkerMessage({
    data: {
      type: "vi-present",
      rendererSequence: 32,
      frame: interlacedFrame("bottom", 17, {
        temporalXfbCapture: {
          scenario: "smb-ready-play",
          step: "post-play-presented",
          ordinal: 1,
          capacity: 8,
        },
      }),
    },
  });

  assert.deepEqual(calls, [
    [
      0x01200000,
      7,
      0,
      "interlaced",
      "top",
      17,
      640,
      480,
      2560,
      240,
      2,
      false,
      false,
    ],
    [
      0x01200500,
      8,
      1,
      "interlaced",
      "bottom",
      17,
      640,
      480,
      2560,
      240,
      2,
      true,
      false,
    ],
  ]);
  assert.equal(context.document.body.dataset.viFields, "2");
  assert.equal(context.document.body.dataset.viPresents, "1");
  assert.equal(context.document.body.dataset.viPairEpoch, "17");
  assert.equal(context.document.body.dataset.viResult, "vi-interlaced-frame-ready");
  assert.equal(context.document.body.dataset.viPresentationSerial, "9");
  assert.equal(temporalCaptures, 1);
  assert.equal(compositorCaptures, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(workerMessages.at(-1))), {
    type: "renderer-frame-complete",
    rendererSequence: 32,
    viPresentationResult: {
      accepted: true,
      presented: true,
      status: "vi-interlaced-frame-ready",
      pairEpoch: 17,
      presentationSerial: 9,
    },
  });
});

test("sustained VI receipts distinguish drained fields from host presents", () => {
  const context = evaluateFunctions(["captureSmbSustainedViReceipt"]);
  const gameplay = {
    gameModeRequest: -1,
    gameMode: 2,
    gameSubmodeRequest: -1,
    gameSubmode: 51,
    infoTimer: 3599,
    attempts: 1,
    floor: 1,
  };
  const request = {
    scenario: "smb-sustained-play",
    step: "sustained-play-presented",
    ordinal: 1,
    capacity: 120,
    gameplay,
  };
  const awaiting = context.captureSmbSustainedViReceipt({
    type: "vi-present",
    rendererSequence: 41,
    frame: interlacedFrame("top", 23, { sustainedPlayReceipt: request }),
  }, {
    accepted: true,
    presented: false,
    status: "vi-field-pair-awaiting",
    pairEpoch: 23,
    presentationSerial: null,
  });
  assert.equal(awaiting.drained, true);
  assert.equal(awaiting.accepted, true);
  assert.equal(awaiting.presented, false);
  assert.equal(awaiting.status, "vi-field-pair-awaiting");
  assert.equal(awaiting.pairEpoch, 23);
  assert.equal(awaiting.presentationSerial, null);

  const ready = context.captureSmbSustainedViReceipt({
    type: "vi-present",
    rendererSequence: 42,
    frame: interlacedFrame("bottom", 23, {
      sustainedPlayReceipt: { ...request, ordinal: 2, gameplay: { ...gameplay, infoTimer: 3598 } },
    }),
  }, {
    accepted: true,
    presented: true,
    status: "vi-interlaced-frame-ready",
    pairEpoch: 23,
    presentationSerial: 11,
  });
  assert.equal(ready.drained, true);
  assert.equal(ready.accepted, true);
  assert.equal(ready.presented, true);
  assert.equal(ready.status, "vi-interlaced-frame-ready");
  assert.equal(ready.pairEpoch, 23);
  assert.equal(ready.presentationSerial, 11);
});

test("VI worker pairs either starting parity under one positive epoch", () => {
  const trace = [];
  const context = evaluateFunctions(
    ["resetViFieldPairing", "allocateViPairEpoch", "claimViFieldPair"],
    {
      check(condition, message) {
        if (!condition) throw new Error(message);
      },
      cloneViScanoutEntry(entry) {
        return entry === null ? null : { ...entry };
      },
      traceVi(...args) { trace.push(args); },
      viNextPairEpoch: 1,
      viPendingFieldPair: null,
      viScanoutActive: {
        topBase: null,
        bottomBase: null,
        picture: null,
      },
    },
  );
  const interlaced = {
    width: 640,
    height: 480,
    fieldStrideBytes: 2560,
    fieldHeight: 240,
    rowRepeat: 2,
    scanoutPolicy: "bob",
  };
  const single = {
    width: 640,
    height: 240,
    fieldStrideBytes: 1280,
    fieldHeight: 240,
    rowRepeat: 1,
    scanoutPolicy: "direct",
  };
  const claim = (field, dimensions = interlaced) => context.claimViFieldPair(
    field,
    dimensions,
    {
      frame: { index: field === "top" ? 7 : 8, stride: 1280 },
      row: field === "top" ? 0 : 1,
    },
    dimensions.rowRepeat,
    field === "top" ? 0x01200000 : 0x01200500,
    {
      topBase: null,
      bottomBase: null,
      picture: null,
    },
  );
  const summary = outcome => ({
    presentationMode: outcome.presentationMode,
    pairEpoch: outcome.pairEpoch,
    pairCompleting: outcome.pairCompleting,
  });

  const firstTop = claim("top");
  assert.deepEqual(
    summary(firstTop),
    {
      presentationMode: "interlaced",
      pairEpoch: 1,
      pairCompleting: false,
    },
  );
  const firstBottom = claim("bottom");
  assert.deepEqual(
    summary(firstBottom),
    {
      presentationMode: "interlaced",
      pairEpoch: 1,
      pairCompleting: true,
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(firstBottom.fields)), {
    top: {
      field: "top",
      address: 0x01200000,
      copyIndex: 7,
      copyRow: 0,
      width: 640,
      height: 480,
      fieldStrideBytes: 2560,
      sourceRowStep: 2,
      fieldHeight: 240,
      rowRepeat: 2,
      scanoutPolicy: "bob",
      scanoutProvenance: {
        base: null,
        picture: null,
      },
    },
    bottom: {
      field: "bottom",
      address: 0x01200500,
      copyIndex: 8,
      copyRow: 1,
      width: 640,
      height: 480,
      fieldStrideBytes: 2560,
      sourceRowStep: 2,
      fieldHeight: 240,
      rowRepeat: 2,
      scanoutPolicy: "bob",
      scanoutProvenance: {
        base: null,
        picture: null,
      },
    },
  });
  assert.deepEqual(
    summary(claim("top", single)),
    {
      presentationMode: "single-field",
      pairEpoch: 2,
      pairCompleting: true,
    },
  );

  assert.deepEqual(
    summary(claim("bottom")),
    {
      presentationMode: "interlaced",
      pairEpoch: 3,
      pairCompleting: false,
    },
  );
  assert.deepEqual(
    summary(claim("top")),
    {
      presentationMode: "interlaced",
      pairEpoch: 3,
      pairCompleting: true,
    },
  );

  claim("top");
  assert.deepEqual(
    summary(claim("top")),
    {
      presentationMode: "interlaced",
      pairEpoch: 5,
      pairCompleting: false,
    },
  );
  assert.deepEqual(
    summary(claim("bottom")),
    {
      presentationMode: "interlaced",
      pairEpoch: 5,
      pairCompleting: true,
    },
  );

  claim("top");
  context.resetViFieldPairing("timing-reschedule", 900);
  assert.deepEqual(JSON.parse(JSON.stringify(trace)), [[
    "field-pair-reset",
    900,
    { reason: "timing-reschedule", pairEpoch: 6, field: "top" },
  ]]);
  assert.deepEqual(
    summary(claim("bottom")),
    {
      presentationMode: "interlaced",
      pairEpoch: 7,
      pairCompleting: false,
    },
  );
  assert.deepEqual(
    summary(claim("top")),
    {
      presentationMode: "interlaced",
      pairEpoch: 7,
      pairCompleting: true,
    },
  );
});

test("VI browser protocol resets ownership across timing changes", () => {
  const service = extractFunction("serviceVideoPresentation");
  const schedule = extractFunction("ensureViSchedule");
  const host = extractFunction("handleWorkerMessage");

  assert.match(service, /presentationMode/);
  assert.match(service, /pairEpoch/);
  assert.match(service, /pairCompleting/);
  assert.match(service, /fieldPair\.pairCompleting[\s\S]*?claimSmbTemporalXfbCapture/);
  assert.match(schedule, /resetViFieldPairing\("timing-invalid", observedCycles\)/);
  assert.match(schedule, /resetViFieldPairing\("timing-reschedule", observedCycles\)/);
  assert.match(host, /frame\.presentationMode/);
  assert.match(host, /frame\.pairEpoch/);
  assert.match(
    host,
    /present_xfb\(\s*frame\.address,\s*frame\.copyIndex,\s*frame\.copyRow,\s*frame\.presentationMode,\s*frame\.field,\s*frame\.pairEpoch,\s*frame\.width,\s*frame\.height,\s*frame\.fieldStrideBytes,\s*frame\.fieldHeight,\s*frame\.rowRepeat,\s*frame\.temporalXfbCapture !== undefined,\s*frame\.sustainedPlayReceipt !== undefined\s*\)/,
  );
});
