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
    filename: "browser_boot.vi-mmio.js",
  });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryFixture() {
  const bytes = new Uint8Array(0x8000);
  return {
    bytes,
    mmio: 0,
    view: new DataView(bytes.buffer),
  };
}

function compactTiming(overrides = {}) {
  return {
    valid: true,
    displayEnabled: true,
    singleField: false,
    cyclesPerSample: 4,
    cyclesPerHalfLine: 20,
    hlw: 5,
    oddHalfLines: 6,
    evenHalfLines: 6,
    totalHalfLines: 12,
    equ: 1,
    acv: 1,
    oddPrb: 1,
    oddPsb: 0,
    evenPrb: 1,
    evenPsb: 0,
    ...overrides,
  };
}

test("VI beam reads HCT and VCT from the exact published cycle", () => {
  const memory = memoryFixture();
  const context = evaluateFunctions(
    [
      "viRegisterAccess",
      "viBeamPositionAtCycle",
      "readVideoInterfaceRegister",
    ],
    {
      ...memory,
      synchronizeVideoInterfaceAtCycle() {},
      viTiming: compactTiming(),
      viEpochCycle: 100,
      viEpochHalfLine: 0,
      viBeamEnabled: true,
      viFrozenBeam: { halfLine: 0, sample: 0 },
    },
  );

  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(100)),
    { halfLine: 0, vct: 1, hct: 1, sample: 0 },
  );
  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(103)),
    { halfLine: 0, vct: 1, hct: 1, sample: 0 },
  );
  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(104)),
    { halfLine: 0, vct: 1, hct: 2, sample: 1 },
  );
  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(119)),
    { halfLine: 0, vct: 1, hct: 5, sample: 4 },
  );
  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(120)),
    { halfLine: 1, vct: 1, hct: 6, sample: 0 },
  );
  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(139)),
    { halfLine: 1, vct: 1, hct: 10, sample: 4 },
  );
  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(140)),
    { halfLine: 2, vct: 2, hct: 1, sample: 0 },
  );
  assert.deepEqual(
    plain(context.viBeamPositionAtCycle(340)),
    { halfLine: 0, vct: 1, hct: 1, sample: 0 },
  );

  assert.deepEqual(
    plain(context.readVideoInterfaceRegister(0x0c00202c, 2, 132)),
    { handled: true, value: 1 },
  );
  assert.deepEqual(
    plain(context.readVideoInterfaceRegister(0x0c00202e, 2, 132)),
    { handled: true, value: 9 },
  );
  assert.deepEqual(
    plain(context.readVideoInterfaceRegister(0x0c003000, 2, 132)),
    { handled: false, value: null },
  );
});

test("VI comparators target exact horizontal samples with ten-bit coordinates", () => {
  const memory = memoryFixture();
  const target = (2 << 16) | 3;
  memory.view.setUint32(0x2030, target, false);
  const context = evaluateFunctions(
    [
      "viComparatorTarget",
      "viCycleForRasterSampleAfter",
      "nextViComparatorCycle",
    ],
    {
      ...memory,
      viEpochCycle: 100,
      viEpochHalfLine: 0,
      viInterruptOffsets: [0x2030, 0x2034, 0x2038, 0x203c],
      viTiming: compactTiming(),
    },
  );

  assert.deepEqual(plain(context.viComparatorTarget(target)), {
    hct: 3,
    vct: 2,
    targetSample: 12,
    halfLine: 2,
    sample: 2,
  });
  assert.equal(context.nextViComparatorCycle(100), 148);
  assert.equal(context.nextViComparatorCycle(147), 148);
  assert.equal(
    context.nextViComparatorCycle(148),
    388,
    "an already-observed match must schedule the next frame",
  );

  assert.equal(context.viComparatorTarget(2 << 16), null);
  assert.equal(context.viComparatorTarget(3), null);
  assert.equal(context.viComparatorTarget((2 << 16) | 11), null);
  assert.deepEqual(
    plain(context.viComparatorTarget(target | 0x0400)),
    plain(context.viComparatorTarget(target)),
    "reserved coordinate bit 10 must not alter the raster target",
  );

  context.viTiming = compactTiming({ totalHalfLines: 11 });
  assert.equal(context.viComparatorTarget((6 << 16) | 6), null);
  assert.equal(context.viComparatorTarget((6 << 16) | 5).targetSample, 54);
});

test("VI DCR disable preserves exact sub-sample phase and reset starts clean", () => {
  const memory = memoryFixture();
  memory.view.setUint16(0x2000, (1 << 4) | 1, false);
  memory.view.setUint16(0x2002, 1, false);
  memory.view.setUint32(0x2004, 5, false);
  memory.view.setUint32(0x200c, 1, false);
  memory.view.setUint32(0x2010, 1, false);
  memory.view.setUint16(0x206c, 0, false);
  for (const [index, offset] of [0x2030, 0x2034, 0x2038, 0x203c].entries()) {
    memory.view.setUint32(offset, 0x9001_0001 + index, false);
  }
  memory.view.setUint32(0x3000, 0x0000_0101, false);

  const context = evaluateFunctions(
    [
      "viRegisterAccess",
      "viBeamPositionAtCycle",
      "writeViDisplayControl",
      "writeViInterruptHalf",
      "recordViScanoutWrite",
      "captureViPendingRegisters",
      "writeViHalfword",
      "writeVideoInterfaceRegister",
      "decodeViTiming",
      "resetViFieldPairing",
      "ensureViSchedule",
    ],
    {
      ...memory,
      check(condition, message) {
        if (!condition) throw new Error(message);
      },
      currentViComparatorSignature() { return "comparators"; },
      hex32(value) {
        return "0x" + (value >>> 0).toString(16).padStart(8, "0");
      },
      nextViComparatorCycle(cycle) { return cycle + 40; },
      nextViPresentationCycleAfter(cycle) { return cycle + 60; },
      nextViSerialPollCycle(cycle) { return cycle + 80; },
      nextViTimingBoundaryCycleAfter(cycle) { return cycle + 50; },
      synchronizeVideoInterfaceAtCycle() {},
      traceVi() {},
      updateViInterruptLevel() {},
      viActiveAcv: 1,
      viActiveEvenVBlank: 1,
      viActiveOddVBlank: 1,
      viBeamEnabled: true,
      viClockFrequencies: [100, 200],
      viComparatorSignature: "comparators",
      viCpuCyclesPerSecond: 200,
      viEpochCycle: 100,
      viEpochHalfLine: 0,
      viFrozenBeam: { halfLine: 0, sample: 0, sampleCycle: 0 },
      viInterruptAcknowledgements: [0, 0, 0, 0],
      viInterruptOffsets: [0x2030, 0x2034, 0x2038, 0x203c],
      viPendingAcv: null,
      viPendingEvenVBlank: null,
      viPendingFieldPair: { pairEpoch: 9, field: "top" },
      viPendingOddVBlank: null,
      viScanoutActive: {
        topBase: { value: 1 },
        bottomBase: { value: 2 },
        picture: { value: 3 },
      },
      viScanoutBoundarySnapshots: [],
      viScanoutPending: {
        topBase: null,
        bottomBase: null,
        picture: null,
      },
      viScanoutWriteSerial: 0,
      viScheduleDirty: false,
      viSerialPollSignature: 0,
      viTiming: compactTiming(),
      viTimingReschedules: 0,
      viTimingSignature: null,
      nextSerialPollCycle: 180,
      nextViBoundaryCycle: 160,
      nextViCycle: 140,
      nextViPresentCycle: 160,
      nextViTimingBoundaryCycle: 150,
    },
  );
  context.viTimingSignature = context.decodeViTiming().signature;

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002002, 0, 2, 133),
    true,
  );
  assert.equal(context.viBeamEnabled, false);
  assert.deepEqual(plain(context.viFrozenBeam), {
    halfLine: 1,
    sample: 3,
    sampleCycle: 1,
  });
  assert.deepEqual(plain(context.viBeamPositionAtCycle(10_000)), {
    halfLine: 1,
    vct: 1,
    hct: 9,
    sample: 3,
  });
  assert.equal(context.nextViCycle, null);
  assert.equal(context.nextViPresentCycle, null);
  assert.equal(context.nextViBoundaryCycle, null);
  assert.equal(context.viPendingFieldPair, null);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002002, 1, 2, 500),
    true,
  );
  assert.equal(context.viBeamEnabled, true);
  assert.deepEqual(plain(context.viBeamPositionAtCycle(500)), {
    halfLine: 1,
    vct: 1,
    hct: 9,
    sample: 3,
  });
  assert.deepEqual(plain(context.viBeamPositionAtCycle(502)), {
    halfLine: 1,
    vct: 1,
    hct: 9,
    sample: 3,
  });
  assert.deepEqual(plain(context.viBeamPositionAtCycle(503)), {
    halfLine: 1,
    vct: 1,
    hct: 10,
    sample: 4,
  });
  assert.deepEqual(plain(context.viBeamPositionAtCycle(507)), {
    halfLine: 2,
    vct: 2,
    hct: 1,
    sample: 0,
  });
  assert.equal(context.nextViCycle, 540);
  assert.equal(context.nextViPresentCycle, 560);
  assert.equal(context.nextViBoundaryCycle, 560);

  context.viPendingFieldPair = { pairEpoch: 10, field: "bottom" };
  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002002, 3, 2, 600),
    true,
  );
  assert.equal(memory.view.getUint16(0x2002, false), 1);
  assert.equal(context.viBeamEnabled, true);
  assert.deepEqual(plain(context.viBeamPositionAtCycle(600)), {
    halfLine: 0,
    vct: 1,
    hct: 1,
    sample: 0,
  });
  for (const offset of [0x2030, 0x2034, 0x2038, 0x203c]) {
    assert.equal(memory.view.getUint32(offset, false), 0);
  }
  assert.equal(memory.view.getUint32(0x3000, false), 1);
  assert.equal(context.viPendingFieldPair, null);
  assert.equal(context.viScanoutActive.topBase, null);
  assert.equal(context.viScanoutActive.bottomBase, null);
  assert.equal(context.viScanoutActive.picture, null);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002002, 2, 2, 700),
    true,
  );
  assert.equal(memory.view.getUint16(0x2002, false), 0);
  assert.equal(context.viBeamEnabled, false);
  assert.deepEqual(plain(context.viBeamPositionAtCycle(50_000)), {
    halfLine: 0,
    vct: 1,
    hct: 1,
    sample: 0,
  });
  assert.equal(context.nextViCycle, null);
  assert.equal(context.nextViPresentCycle, null);
  assert.equal(context.nextViBoundaryCycle, null);
});

test("VI comparator status is sticky, clear-by-zero, and mask-qualified at PI", () => {
  const memory = memoryFixture();
  const target = (2 << 16) | 3;
  memory.view.setUint32(0x2030, target, false);
  memory.view.setUint32(0x3004, 0x0000_0100, false);
  const context = evaluateFunctions(
    [
      "viRegisterAccess",
      "viBeamPositionAtCycle",
      "viComparatorTarget",
      "viCycleForRasterSampleAfter",
      "nextViComparatorCycle",
      "serviceViComparatorEvent",
      "updateViInterruptLevel",
      "writeViInterruptHalf",
      "recordViScanoutWrite",
      "captureViPendingRegisters",
      "writeViHalfword",
      "writeVideoInterfaceRegister",
    ],
    {
      ...memory,
      cpu: 0x7000,
      deviceEvents: new Map(),
      ensureViSchedule() {},
      hex32(value) {
        return "0x" + (value >>> 0).toString(16).padStart(8, "0");
      },
      msrOffset: 0,
      raiseException() {
        throw new Error("masked VI fixture must not deliver an exception");
      },
      synchronizeVideoInterfaceAtCycle() {},
      traceVi() {},
      viBeamEnabled: true,
      viComparatorMatches: [0, 0, 0, 0],
      viComparatorSignature: null,
      viEpochCycle: 100,
      viEpochHalfLine: 0,
      viFrozenBeam: { halfLine: 0, sample: 0 },
      viInterruptAcknowledgements: [0, 0, 0, 0],
      viInterruptOffsets: [0x2030, 0x2034, 0x2038, 0x203c],
      viLastEventCycle: null,
      viLastEventInterval: null,
      viMissedHalfLines: 0,
      viPiDeliveries: 0,
      viScanoutPending: {
        topBase: null,
        bottomBase: null,
        picture: null,
      },
      viScanoutWriteSerial: 0,
      viScheduleDirty: false,
      viStatusAssertions: [0, 0, 0, 0],
      viTiming: compactTiming(),
      nextViCycle: 148,
    },
  );

  assert.equal(memory.view.getUint32(0x2030, false), target);
  context.serviceViComparatorEvent(148, 148);
  assert.equal(memory.view.getUint32(0x2030, false), 0x8002_0003);
  assert.equal(context.viComparatorMatches[0], 1);
  assert.equal(context.viStatusAssertions[0], 1);
  assert.equal(context.nextViCycle, 388);

  context.updateViInterruptLevel(148, false);
  assert.equal(
    memory.view.getUint32(0x3000, false) & 0x100,
    0,
    "a match asserts status even when its local interrupt mask is clear",
  );

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002030, 0x9002_0004, 4, 149),
    true,
  );
  assert.equal(memory.view.getUint32(0x2030, false), 0x9002_0004);
  assert.equal(memory.view.getUint32(0x3000, false) & 0x100, 0x100);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002032, 5, 2, 150),
    true,
  );
  assert.equal(memory.view.getUint32(0x2030, false), 0x9002_0005);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002030, 0x8002, 2, 151),
    true,
  );
  assert.equal(memory.view.getUint32(0x2030, false), 0x8002_0005);
  assert.equal(memory.view.getUint32(0x3000, false) & 0x100, 0);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002030, 0x9002, 2, 152),
    true,
  );
  assert.equal(memory.view.getUint32(0x2030, false), 0x9002_0005);
  assert.equal(memory.view.getUint32(0x3000, false) & 0x100, 0x100);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002030, 0x1003, 2, 153),
    true,
  );
  assert.equal(memory.view.getUint32(0x2030, false), 0x1003_0005);
  assert.equal(context.viInterruptAcknowledgements[0], 1);
  assert.equal(memory.view.getUint32(0x3000, false) & 0x100, 0);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002030, 0x9003, 2, 154),
    true,
  );
  assert.equal(
    memory.view.getUint32(0x2030, false),
    0x1003_0005,
    "software cannot fabricate sticky comparator status by writing one",
  );

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002032, 0x0403, 2, 155),
    true,
  );
  assert.equal(context.viComparatorTarget(
    memory.view.getUint32(0x2030, false),
  ).hct, 3);

  context.nextViCycle = 188;
  context.serviceViComparatorEvent(188, 188);
  assert.equal(
    (memory.view.getUint32(0x2030, false) & 0x8000_0000) >>> 0,
    0x8000_0000,
  );
  context.updateViInterruptLevel(188, false);
  assert.equal(memory.view.getUint32(0x3000, false) & 0x100, 0x100);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002030, 0x1004_0004, 4, 189),
    true,
  );
  assert.equal(memory.view.getUint32(0x2030, false), 0x1004_0004);
  assert.equal(context.viInterruptAcknowledgements[0], 2);
  assert.equal(memory.view.getUint32(0x3000, false) & 0x100, 0);
});

test("VI scanout registers are guest-visible immediately and latch at field boundaries", () => {
  const memory = memoryFixture();
  const oldTop = 0x0012_0000;
  const oldBottom = 0x0012_0500;
  const oldPicture = 0x2850;
  const newTop = 0x0014_0000;
  const newBottom = 0x0014_0500;
  const newPicture = 0x3048;
  memory.view.setUint16(0x2000, (2 << 4) | 1, false);
  memory.view.setUint16(0x2002, 1, false);
  memory.view.setUint32(0x200c, 0x0001_0001, false);
  memory.view.setUint32(0x2010, 0x0001_0001, false);
  memory.view.setUint32(0x201c, oldTop, false);
  memory.view.setUint32(0x2024, oldBottom, false);
  memory.view.setUint16(0x2048, oldPicture, false);

  const context = evaluateFunctions(
    [
      "viRegisterAccess",
      "readVideoInterfaceRegister",
      "writeViInterruptHalf",
      "recordViScanoutWrite",
      "captureViPendingRegisters",
      "writeViHalfword",
      "writeVideoInterfaceRegister",
      "programmedViScanoutEntry",
      "cloneViScanoutEntry",
      "viScanoutStateSnapshot",
      "latchViScanoutBoundary",
    ],
    {
      ...memory,
      check(condition, message) {
        if (!condition) throw new Error(message);
      },
      ensureViSchedule() {},
      synchronizeVideoInterfaceAtCycle() {},
      traceVi() {},
      updateViInterruptLevel() {},
      viActiveAcv: null,
      viActiveEvenVBlank: null,
      viActiveOddVBlank: null,
      viComparatorSignature: null,
      viInterruptAcknowledgements: [0, 0, 0, 0],
      viInterruptOffsets: [0x2030, 0x2034, 0x2038, 0x203c],
      viPendingAcv: null,
      viPendingEvenVBlank: null,
      viPendingOddVBlank: null,
      viScanoutActive: {
        topBase: null,
        bottomBase: null,
        picture: null,
      },
      viScanoutLatchSerial: 0,
      viScanoutPending: {
        topBase: null,
        bottomBase: null,
        picture: null,
      },
      viScanoutWriteSerial: 0,
      viScheduleDirty: false,
    },
  );

  context.latchViScanoutBoundary("top", 100);
  const initial = context.latchViScanoutBoundary("bottom", 101);
  assert.equal(initial.topBase.value, oldTop);
  assert.equal(initial.bottomBase.value, oldBottom);
  assert.equal(initial.picture.value, oldPicture);
  assert.equal(initial.picture.activeLines, 2);

  assert.equal(
    context.writeVideoInterfaceRegister(0x0c00201c, newTop, 4, 110),
    true,
  );
  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002024, newBottom, 4, 120),
    true,
  );
  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002048, newPicture, 2, 130),
    true,
  );
  assert.equal(
    context.writeVideoInterfaceRegister(0x0c002000, (3 << 4) | 1, 2, 140),
    true,
  );

  assert.deepEqual(
    plain(context.readVideoInterfaceRegister(0x0c00201c, 4, 150)),
    { handled: true, value: newTop },
  );
  assert.deepEqual(
    plain(context.readVideoInterfaceRegister(0x0c002024, 4, 150)),
    { handled: true, value: newBottom },
  );
  assert.deepEqual(
    plain(context.readVideoInterfaceRegister(0x0c002048, 2, 150)),
    { handled: true, value: newPicture },
  );
  assert.equal(context.viScanoutActive.topBase.value, oldTop);
  assert.equal(context.viScanoutActive.bottomBase.value, oldBottom);
  assert.equal(context.viScanoutActive.picture.value, oldPicture);
  assert.equal(context.viScanoutActive.picture.activeLines, 2);

  const bottom = context.latchViScanoutBoundary("bottom", 200);
  assert.equal(bottom.topBase.value, oldTop);
  assert.equal(bottom.bottomBase.value, newBottom);
  assert.equal(bottom.bottomBase.field, "bottom");
  assert.equal(bottom.bottomBase.writeCycle, 120);
  assert.equal(bottom.bottomBase.writeSerial, 2);
  assert.equal(bottom.bottomBase.latchedAtCycle, 200);
  assert.equal(bottom.picture.value, oldPicture);
  assert.equal(bottom.picture.activeLines, 2);

  const top = context.latchViScanoutBoundary("top", 300);
  assert.equal(top.topBase.value, newTop);
  assert.equal(top.topBase.field, "top");
  assert.equal(top.topBase.writeCycle, 110);
  assert.equal(top.topBase.writeSerial, 1);
  assert.equal(top.topBase.latchedAtCycle, 300);
  assert.equal(top.bottomBase.value, newBottom);
  assert.equal(top.picture.value, newPicture);
  assert.equal(top.picture.field, "top");
  assert.equal(top.picture.writeCycle, 130);
  assert.equal(top.picture.writeSerial, 3);
  assert.equal(top.picture.latchedAtCycle, 300);
  assert.equal(top.picture.activeLines, 3);
  assert.equal(top.topBase.latchSerial + 1, top.picture.latchSerial);
});

test("VI BFBL retains its sampled shared POFF across queued buffer generations", () => {
  const memory = memoryFixture();
  const oldTop = 0x00f8_2580;
  const currentTopRaw = 0x1008_03ad;
  const currentBottomRaw = 0x0008_03d3;
  const currentTop = 0x0100_75a0;
  const currentBottom = 0x0100_7a60;
  const stride = 0x04c0;
  const picture = {
    value: 0x2850,
    writeCycle: 80,
    writeSerial: 1,
    field: "top",
    latchedAtCycle: 100,
    latchSerial: 2,
    displayControl: 1,
    activeLines: 240,
  };
  const oldTopEntry = {
    value: oldTop,
    writeCycle: 70,
    writeSerial: 1,
    field: "top",
    latchedAtCycle: 100,
    latchSerial: 1,
  };
  memory.view.setUint32(0x201c, currentTopRaw, false);
  memory.view.setUint32(0x2024, currentBottomRaw, false);

  const lowFrame = {
    index: 223,
    captured: true,
    destination: oldTop,
    stride,
    width: 640,
    height: 480,
  };
  const highFrame = {
    index: 224,
    captured: true,
    destination: currentTop,
    stride,
    width: 640,
    height: 480,
  };
  const context = evaluateFunctions(
    [
      "programmedViScanoutEntry",
      "cloneViScanoutEntry",
      "viScanoutStateSnapshot",
      "latchViScanoutBoundary",
      "viXfbAddressFromRaw",
      "viActiveXfbAddress",
      "gxXfbCopyRowOffset",
      "gxResolveXfbCopy",
      "allocateViPairEpoch",
      "claimViFieldPair",
    ],
    {
      ...memory,
      check(condition, message) {
        if (!condition) throw new Error(message);
      },
      gxXfbCopyDestinations: new Map([
        [lowFrame.destination, lowFrame],
        [highFrame.destination, highFrame],
      ]),
      hex32(value) {
        return "0x" + (value >>> 0).toString(16).padStart(8, "0");
      },
      traceVi() {},
      viActiveAcv: 240,
      viActiveOddVBlank: 0,
      viNextPairEpoch: 1,
      viPendingFieldPair: null,
      viScanoutActive: {
        topBase: oldTopEntry,
        bottomBase: null,
        picture,
      },
      viScanoutBoundarySnapshots: [],
      viScanoutLatchSerial: 2,
      viScanoutPending: {
        topBase: null,
        bottomBase: null,
        picture: null,
      },
    },
  );

  context.viScanoutBoundarySnapshots.push({
    scheduledCycle: 200,
    field: "bottom",
    snapshot: context.latchViScanoutBoundary("bottom", 200),
  });
  const queuedBottom = context.viScanoutBoundarySnapshots[0].snapshot;
  assert.equal(queuedBottom.topBase.value, oldTop);
  assert.equal(queuedBottom.bottomBase.value, currentBottomRaw);
  assert.equal(queuedBottom.bottomBase.pageOffsetRaw, currentTopRaw);
  assert.equal(
    context.viActiveXfbAddress("bottom", queuedBottom),
    currentBottom,
    "BFBL must decode with the live shared POFF sampled at its own boundary",
  );

  const resolvedBottom = context.gxResolveXfbCopy(currentBottom);
  assert.equal(highFrame.destination, currentTop);
  assert.equal(currentBottom - highFrame.destination, stride);
  assert.equal(resolvedBottom.frame.index, 224);
  assert.notEqual(resolvedBottom.frame.index, 0);
  assert.equal(resolvedBottom.row, 1);

  memory.view.setUint32(0x201c, 0x00f9_0000, false);
  memory.view.setUint32(0x2024, 0x00f9_04c0, false);
  context.latchViScanoutBoundary("bottom", 300);
  assert.equal(queuedBottom.bottomBase.value, currentBottomRaw);
  assert.equal(queuedBottom.bottomBase.pageOffsetRaw, currentTopRaw);
  assert.equal(context.viActiveXfbAddress("bottom", queuedBottom), currentBottom);

  const dimensions = {
    width: 640,
    height: 480,
    fieldStrideBytes: stride * 2,
    fieldHeight: 240,
    rowRepeat: 2,
    scanoutPolicy: "bob",
  };
  const topState = {
    topBase: oldTopEntry,
    bottomBase: null,
    picture,
  };
  const top = context.claimViFieldPair(
    "top",
    dimensions,
    context.gxResolveXfbCopy(oldTop),
    2,
    oldTop,
    topState,
  );
  assert.equal(top.pairCompleting, false);
  assert.equal(top.fields.top.copyIndex, 223);

  const bottom = context.claimViFieldPair(
    "bottom",
    dimensions,
    resolvedBottom,
    2,
    currentBottom,
    queuedBottom,
  );
  assert.equal(bottom.pairCompleting, true);
  assert.equal(bottom.pairEpoch, top.pairEpoch);
  assert.equal(bottom.fields.top.address, oldTop);
  assert.equal(bottom.fields.top.copyIndex, 223);
  assert.equal(bottom.fields.bottom.address, currentBottom);
  assert.equal(bottom.fields.bottom.copyIndex, 224);
  assert.equal(bottom.fields.bottom.copyRow, 1);
  assert.equal(
    bottom.fields.bottom.scanoutProvenance.base.pageOffsetRaw,
    currentTopRaw,
  );
});

test("VI drains a due field boundary before applying a same-cycle MMIO write", () => {
  function makeBoundaryFixture() {
    const memory = memoryFixture();
    memory.view.setUint16(0x2000, (1 << 4) | 1, false);
    memory.view.setUint16(0x2002, 1, false);
    memory.view.setUint32(0x200c, 1, false);
    memory.view.setUint32(0x2010, 1, false);
    memory.view.setUint32(0x201c, 0x0012_0000, false);
    memory.view.setUint32(0x2024, 0x0012_0500, false);
    memory.view.setUint16(0x2048, 0x2850, false);
    const context = evaluateFunctions(
      [
        "viRegisterAccess",
        "viBeamPositionAtCycle",
        "synchronizeVideoInterfaceAtCycle",
        "writeViInterruptHalf",
        "recordViScanoutWrite",
        "captureViPendingRegisters",
        "writeViHalfword",
        "writeVideoInterfaceRegister",
        "viActiveFieldTargets",
        "programmedViScanoutEntry",
        "cloneViScanoutEntry",
        "viScanoutStateSnapshot",
        "latchViScanoutBoundary",
        "viCurrentHalfLine",
        "viCycleForHalfLineAfter",
        "nextViPresentationCycleAfter",
        "nextViDueEventCycle",
        "serviceViDueEvents",
      ],
      {
        ...memory,
        check(condition, message) {
          if (!condition) throw new Error(message);
        },
        ensureViSchedule() {},
        serviceViComparatorEvent() {},
        latchViTimingBoundary() {},
        sampleWarioWareGameplayInput() {},
        nextViTimingBoundaryCycleAfter() { return null; },
        viTimingFieldTargets() { return []; },
        traceVi() {},
        updateViInterruptLevel() {},
        viActiveAcv: 1,
        viActiveEvenVBlank: 1,
        viActiveOddVBlank: 1,
        viBeamEnabled: true,
        viComparatorSignature: null,
        viEpochCycle: 100,
        viEpochHalfLine: 0,
        viFrozenBeam: { halfLine: 0, sample: 0 },
        viInterruptAcknowledgements: [0, 0, 0, 0],
        viInterruptOffsets: [0x2030, 0x2034, 0x2038, 0x203c],
        viPendingAcv: null,
        viPendingEvenVBlank: null,
        viPendingOddVBlank: null,
        viScanoutActive: {
          topBase: null,
          bottomBase: null,
          picture: null,
        },
        viScanoutBoundarySnapshots: [],
        viScanoutLatchSerial: 0,
        viScanoutPending: {
          topBase: null,
          bottomBase: null,
          picture: null,
        },
        viScanoutWriteSerial: 0,
        viScheduleDirty: false,
        viTiming: compactTiming(),
        nextViBoundaryCycle: 180,
        nextViCycle: null,
        nextViPresentCycle: 180,
        nextViTimingBoundaryCycle: null,
      },
    );
    return { context, memory };
  }

  const atBoundary = makeBoundaryFixture();
  assert.equal(
    atBoundary.context.writeVideoInterfaceRegister(
      0x0c00201c,
      0x0014_0000,
      4,
      180,
    ),
    true,
  );
  assert.equal(atBoundary.context.viScanoutBoundarySnapshots.length, 1);
  assert.equal(
    atBoundary.context.viScanoutBoundarySnapshots[0].snapshot.topBase.value,
    0x0012_0000,
  );
  assert.equal(
    atBoundary.context.viScanoutActive.topBase.value,
    0x0012_0000,
  );
  assert.equal(
    atBoundary.context.viScanoutPending.topBase.value,
    0x0014_0000,
  );
  assert.equal(
    atBoundary.context.viScanoutPending.topBase.writeCycle,
    180,
  );

  const beforeBoundary = makeBoundaryFixture();
  assert.equal(
    beforeBoundary.context.writeVideoInterfaceRegister(
      0x0c00201c,
      0x0014_0000,
      4,
      179,
    ),
    true,
  );
  assert.equal(beforeBoundary.context.viScanoutBoundarySnapshots.length, 0);
  beforeBoundary.context.synchronizeVideoInterfaceAtCycle(180);
  assert.equal(beforeBoundary.context.viScanoutBoundarySnapshots.length, 1);
  assert.equal(
    beforeBoundary.context.viScanoutBoundarySnapshots[0].snapshot.topBase.value,
    0x0014_0000,
  );
  assert.equal(
    beforeBoundary.context.viScanoutBoundarySnapshots[0]
      .snapshot.topBase.writeCycle,
    179,
  );
});

test("VI drains delayed raster events globally by cycle with stable ties", () => {
  const timeline = [];
  let activeLines = 1;
  const context = evaluateFunctions(
    ["nextViDueEventCycle", "serviceViDueEvents"],
    {
      ensureViSchedule(cycle) {
        timeline.push(`ensure:${cycle}`);
        context.viScheduleDirty = false;
      },
      latchViScanoutBoundary(field, cycle) {
        timeline.push(`scanout:${cycle}:${field}`);
        return { picture: { activeLines } };
      },
      latchViTimingBoundary(field, cycle) {
        timeline.push(`timing:${cycle}:${field}`);
        activeLines += 1;
        context.viScheduleDirty = true;
      },
      nextViComparatorCycle() { return null; },
      nextViPresentationCycleAfter() { return null; },
      nextViTimingBoundaryCycleAfter() { return null; },
      serviceViComparatorEvent(cycle) {
        timeline.push(`comparator:${cycle}`);
        context.nextViCycle = null;
      },
      sampleWarioWareGameplayInput() {},
      viActiveFieldTargets() {
        return [{ field: "top", halfLine: 0 }];
      },
      viCurrentHalfLine() {
        return 0;
      },
      viTiming: compactTiming(),
      viTimingFieldTargets() {
        return [{ field: "top", halfLine: 0 }];
      },
      viScanoutBoundarySnapshots: [],
      viScheduleDirty: false,
      nextViBoundaryCycle: 180,
      nextViCycle: 240,
      nextViPresentCycle: 180,
      nextViTimingBoundaryCycle: 220,
    },
  );

  context.serviceViDueEvents(250);
  assert.deepEqual(timeline, [
    "scanout:180:top",
    "timing:220:top",
    "ensure:220",
    "comparator:240",
  ]);
  assert.equal(context.viScanoutBoundarySnapshots.length, 1);
  assert.equal(
    context.viScanoutBoundarySnapshots[0].snapshot.picture.activeLines,
    1,
    "the 180 scanout must own geometry from before the 220 promotion",
  );

  timeline.length = 0;
  context.nextViBoundaryCycle = 300;
  context.nextViCycle = 300;
  context.nextViPresentCycle = 300;
  context.nextViTimingBoundaryCycle = 300;
  context.serviceViDueEvents(300);
  assert.deepEqual(timeline, [
    "comparator:300",
    "timing:300:top",
    "scanout:300:top",
    "ensure:300",
  ]);
  assert.equal(
    context.viScanoutBoundarySnapshots[1].snapshot.picture.activeLines,
    3,
    "a tied scanout must observe the timing promotion after the comparator",
  );
});

test("VI complete field pairs retain coherent base and picture provenance", () => {
  const picture = {
    value: 0x2850,
    writeCycle: 90,
    writeSerial: 3,
    field: "top",
    latchedAtCycle: 100,
    latchSerial: 6,
    displayControl: 1,
    activeLines: 240,
  };
  const context = evaluateFunctions(
    [
      "cloneViScanoutEntry",
      "allocateViPairEpoch",
      "claimViFieldPair",
    ],
    {
      check(condition, message) {
        if (!condition) throw new Error(message);
      },
      viNextPairEpoch: 1,
      viPendingFieldPair: null,
      viScanoutActive: {
        topBase: {
          value: 0x0012_0000,
          writeCycle: 80,
          writeSerial: 1,
          field: "top",
          latchedAtCycle: 100,
          latchSerial: 5,
        },
        bottomBase: {
          value: 0x0012_0500,
          writeCycle: 85,
          writeSerial: 2,
          field: "bottom",
          latchedAtCycle: 200,
          latchSerial: 7,
        },
        picture,
      },
    },
  );
  const dimensions = {
    width: 640,
    height: 480,
    fieldStrideBytes: 2560,
    fieldHeight: 240,
    rowRepeat: 2,
    scanoutPolicy: "bob",
  };
  const frame = {
    index: 4,
    stride: 1280,
    width: 640,
    height: 480,
  };

  const top = context.claimViFieldPair(
    "top",
    dimensions,
    { frame, row: 0 },
    2,
    0x0012_0000,
    context.viScanoutActive,
  );
  assert.equal(top.pairCompleting, false);
  assert.equal(top.fields.top.scanoutProvenance.base.latchSerial, 5);
  assert.equal(top.fields.top.scanoutProvenance.picture.latchSerial, 6);

  context.viScanoutActive.bottomBase = {
    ...context.viScanoutActive.bottomBase,
    value: 0x0014_0500,
    writeCycle: 150,
    writeSerial: 4,
    latchedAtCycle: 200,
    latchSerial: 8,
  };
  const bottom = context.claimViFieldPair(
    "bottom",
    dimensions,
    { frame, row: 1 },
    2,
    0x0014_0500,
    context.viScanoutActive,
  );
  assert.equal(bottom.pairCompleting, true);
  assert.deepEqual(Object.keys(bottom.fields).sort(), ["bottom", "top"]);
  assert.equal(bottom.fields.top.scanoutProvenance.base.latchSerial, 5);
  assert.equal(bottom.fields.bottom.scanoutProvenance.base.latchSerial, 8);
  assert.equal(bottom.fields.top.scanoutProvenance.picture.latchSerial, 6);
  assert.equal(bottom.fields.bottom.scanoutProvenance.picture.latchSerial, 6);
  assert.notEqual(
    bottom.fields.top.scanoutProvenance.picture,
    bottom.fields.bottom.scanoutProvenance.picture,
    "each field owns an immutable provenance snapshot",
  );

  context.viScanoutActive.picture = {
    ...picture,
    value: 0x3048,
    latchedAtCycle: 300,
    latchSerial: 9,
  };
  const nextTop = context.claimViFieldPair(
    "top",
    dimensions,
    { frame, row: 0 },
    2,
    0x0012_0000,
    context.viScanoutActive,
  );
  assert.equal(nextTop.pairCompleting, false);

  context.viScanoutActive.picture = {
    ...context.viScanoutActive.picture,
    latchedAtCycle: 400,
    latchSerial: 10,
  };
  const mismatchedBottom = context.claimViFieldPair(
    "bottom",
    dimensions,
    { frame, row: 1 },
    2,
    0x0014_0500,
    context.viScanoutActive,
  );
  assert.equal(
    mismatchedBottom.pairCompleting,
    false,
    "fields from different picture latch epochs cannot complete one pair",
  );
  assert.deepEqual(Object.keys(mismatchedBottom.fields), ["bottom"]);
});
