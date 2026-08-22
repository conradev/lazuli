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

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

const reservationFunctions = [
  "batAllowsAccess",
  "resolveDataEffectiveAddress",
  "dataPageAllowsAccess",
  "dataTlbSetIndex",
  "lookupDataTlb",
  "fillDataTlb",
  "resolveDataTlbEntry",
  "commitDataPageHistory",
  "resolveDataPageAddress",
  "resolveDataTranslation",
  "resolveDataEffectiveRange",
  "readSegmentRegisters",
  "readDataBats",
  "resolveDataRange",
  "dataStorageCause",
  "recordDataStorageFault",
  "translateDataRange",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "physicalMmioPointer",
  "physicalLockedCachePointer",
  "dataReservationGranule",
  "invalidateDataReservationForExternalWrite",
  "invalidateDataReservationForExternalStridedWrite",
  "gxTextureLayout",
  "gxCopyTextureLayout",
  "invalidateGxCopyReservation",
  "resolveDataReservationTranslation",
  "resolveDataReservationBacking",
  "resolveDataReservationAccess",
  "loadReserveInteger",
  "storeConditionalInteger",
  "writeInteger",
];

const cpu = 0;
const msrOffset = 0x20;
const dsisrOffset = 0x24;
const darOffset = 0x28;
const pcOffset = 0x2c;
const sdr1Offset = 0x30;
const dataBatOffsets = [
  [0x40, 0x44],
  [0x48, 0x4c],
  [0x50, 0x54],
  [0x58, 0x5c],
];
const segmentRegisterOffsets = Array.from(
  { length: 16 },
  (_unused, index) => 0x100 + index * 4,
);
const outputPointer = 0x3_0000;
const ram = 0x4_0000;
const ramSize = 0x2_0000;
const mmio = 0x8_0000;
const mmioSize = 0x1_0000;
const lockedCache = 0x9_0000;
const lockedCacheSize = 0x4000;

function makeContext() {
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const context = {
    aiLastCycle: 0,
    aiSampleCounter: 0,
    appendGxFifo() {},
    bytes: new Uint8Array(buffer),
    commandProcessorRegisterRangeOverlaps: () => false,
    consumeDspMail() {},
    cpu,
    cycles: 0,
    darOffset,
    dataBatOffsets,
    dataReservationGranuleBytes: 32,
    dataTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    deviceEvents: new Map(),
    dispatches: 7,
    dsisrOffset,
    dspAudioDmaBlocksLeft: () => 0,
    gxFifoScratch: new DataView(new ArrayBuffer(8)),
    gxFifoQuantizedStores: 0,
    hex32: value => "0x" + (value >>> 0).toString(16).padStart(8, "0"),
    lastDataStorageFault: null,
    lastUnmappedAccess: null,
    lockedCache,
    lockedCacheReadBytes: 0,
    lockedCacheReads: 0,
    lockedCacheSize,
    lockedCacheWriteBytes: 0,
    lockedCacheWrites: 0,
    mmio,
    mmioSize,
    msrOffset,
    pcOffset,
    physicalMmioBase: 0x0c00_0000,
    publishDspAudioDmaBlocksLeft() {},
    ram,
    ramSize,
    readCommandProcessorRegister: () => null,
    readGpr: () => 0,
    readProcessorInterfaceFifoRegister: () => null,
    recomputeSerialInterruptLevel() {},
    segmentRegisterOffsets,
    sdr1Offset,
    startAramDma() {},
    updateAudioSampleCounter() {},
    viScheduleDirty: false,
    view: new DataView(buffer),
    writeAudioControl() {},
    writeCommandProcessorRegister: () => false,
    writeDiskStatus() {},
    writeDspAudioDmaControl() {},
    writeDspControl() {},
    writeDspMailboxHigh() {},
    writeDspMailboxLow() {},
    writePixelEngineControl() {},
    writeProcessorInterfaceFifoRegister: () => false,
    writeProcessorInterfaceInterruptCause() {},
    writeSerialControl() {},
    writeSerialStatus() {},
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "let dataReservationPhysicalGranule = null;",
      ...reservationFunctions.map(extractFunction),
    ].join("\n\n"),
    context,
    { filename: "browser_boot.data-reservation.js" },
  );
  return context;
}

function reservation(context) {
  return vm.runInContext("dataReservationPhysicalGranule", context);
}

function writeDataBat(context, index, upper, lower) {
  const [lowerOffset, upperOffset] = context.dataBatOffsets[index];
  context.view.setUint32(context.cpu + upperOffset, upper >>> 0, true);
  context.view.setUint32(context.cpu + lowerOffset, lower >>> 0, true);
}

function writeRuntimeTranslationState(context, {
  msr = 0x10,
  sdr1 = 0,
  segments = Array(16).fill(0),
} = {}) {
  context.view.setUint32(context.cpu + context.msrOffset, msr, true);
  context.view.setUint32(context.cpu + context.sdr1Offset, sdr1, true);
  context.view.setUint32(context.cpu + context.pcOffset, 0x8000_1234, true);
  segments.forEach((value, index) => {
    context.view.setUint32(
      context.cpu + context.segmentRegisterOffsets[index],
      value,
      true,
    );
  });
  for (let index = 0; index < 4; index += 1) {
    writeDataBat(context, index, 0, 0);
  }
}

function installRamAliases(context) {
  writeDataBat(context, 0, 0x8000_1fff, 0x0000_0002);
  writeDataBat(context, 1, 0xc000_1fff, 0x0000_0002);
}

function pageTableVector(address, segment, sdr1 = 0) {
  const vsid = segment & 0x00ff_ffff;
  const pageIndex = (address >>> 12) & 0xffff;
  const api = (address >>> 22) & 0x3f;
  const primaryHash = ((vsid & 0x7ffff) ^ pageIndex) & 0x7ffff;
  const mask = 0x3ff | ((sdr1 & 0x1ff) << 10);
  const base = sdr1 & 0xffff_0000;
  return {
    primary: (base | ((primaryHash & mask) << 6)) >>> 0,
    primaryPte0: (0x8000_0000 | (vsid << 7) | api) >>> 0,
  };
}

function installPrimaryPte(context, address, segment, pte1, sdr1 = 0) {
  const vector = pageTableVector(address, segment, sdr1);
  const pointer = context.ram + vector.primary;
  context.view.setUint32(pointer, vector.primaryPte0, false);
  context.view.setUint32(pointer + 4, pte1 >>> 0, false);
  return { ...vector, pointer };
}

function readPte1(context, pte) {
  return context.view.getUint32(pte.pointer + 4, false);
}

test("browser hook ABI exposes reservation operations and external invalidators", () => {
  assert.match(
    source,
    /user_0_27:\s*\(_ctx,\s*address,\s*pointer\)\s*=>\s*loadReserveInteger\(address,\s*pointer\)/,
  );
  assert.match(
    source,
    /user_0_28:\s*\(_ctx,\s*address,\s*value\)\s*=>\s*storeConditionalInteger\(address,\s*value\)/,
  );

  const continuation = extractFunction("regionHookCanContinue");
  assert.match(continuation, /case "user_0_27"/);
  assert.match(continuation, /Number\(result\) !== 1/);
  assert.match(continuation, /case "user_0_28"/);
  assert.match(continuation, /Number\(result\) !== 2/);

  for (const name of [
    "serviceLockedCacheDma",
    "startAramDma",
    "serviceExi0",
    "beginDiskCommand",
    "serviceDisk",
    "recordGxBpWrite",
  ]) {
    assert.match(
      extractFunction(name),
      /invalidate[A-Za-z]*Reservation/,
      `${name} must invalidate an overlapping external physical write`,
    );
  }

  for (const name of [
    "writeInteger",
    "writeQuantized",
    "commitGxWriteGatherBurst",
    "fastForwardRecognizedLoop",
  ]) {
    assert.doesNotMatch(
      extractFunction(name),
      /invalidateDataReservationForExternalWrite/,
      `${name} is a same-CPU store path`,
    );
  }
});

test("physical aliases and nonspecific conditional stores share one reservation", () => {
  const context = makeContext();
  writeRuntimeTranslationState(context);
  installRamAliases(context);

  context.view.setUint32(context.ram + 0x100, 0x1122_3344, false);
  assert.equal(context.loadReserveInteger(0x8000_0100, outputPointer), 1);
  assert.equal(context.view.getUint32(outputPointer, true), 0x1122_3344);
  assert.equal(reservation(context), 0x100);

  context.view.setUint32(context.ram + 0x220, 0x5566_7788, false);
  assert.equal(context.loadReserveInteger(0xc000_0220, outputPointer), 1);
  assert.equal(context.view.getUint32(outputPointer, true), 0x5566_7788);
  assert.equal(reservation(context), 0x220, "a successful lwarx replaces");

  assert.equal(context.loadReserveInteger(0xa000_0100, outputPointer), 0);
  assert.equal(reservation(context), 0x220, "a faulting lwarx preserves");
  assert.equal(context.loadReserveInteger(0xc000_0221, outputPointer), 0);
  assert.equal(reservation(context), 0x220, "defensive alignment preserves");

  assert.equal(
    context.storeConditionalInteger(0x8000_0340, 0xaabb_ccdd),
    2,
    "MPC750 stwcx. accepts any live reservation at a different EA",
  );
  assert.equal(
    context.view.getUint32(context.ram + 0x340, false),
    0xaabb_ccdd,
  );
  assert.equal(reservation(context), null);
});

test("faults preserve while completed conditional stores clear reservation state", () => {
  const context = makeContext();
  writeRuntimeTranslationState(context);
  installRamAliases(context);
  writeDataBat(context, 2, 0xa000_1fff, 0x0000_0001);
  context.view.setUint32(context.ram + 0x120, 0x1234_5678, false);

  assert.equal(context.loadReserveInteger(0x8000_0120, outputPointer), 1);
  assert.equal(context.storeConditionalInteger(0xa000_0400, 1), 0);
  assert.equal(reservation(context), 0x120, "protection fault preserves");
  assert.equal(context.storeConditionalInteger(0x8000_0401, 1), 0);
  assert.equal(reservation(context), 0x120, "alignment fault preserves");

  assert.equal(
    context.invalidateDataReservationForExternalWrite(0x140, 32),
    false,
  );
  assert.equal(reservation(context), 0x120, "disjoint external write preserves");

  assert.equal(context.writeInteger(0x8000_0124, 0xfeed_face, 4), 1);
  assert.equal(reservation(context), 0x120, "same-CPU store preserves");
  assert.equal(context.storeConditionalInteger(0xc000_0500, 0xcafe_babe), 2);
  assert.equal(reservation(context), null, "stored stwcx. clears");

  assert.equal(context.loadReserveInteger(0x8000_0120, outputPointer), 1);
  assert.equal(
    context.invalidateDataReservationForExternalWrite(0x13f, 2),
    true,
  );
  const before = context.view.getUint32(context.ram + 0x540, false);
  assert.equal(context.storeConditionalInteger(0xc000_0540, 0xdead_beef), 1);
  assert.equal(context.view.getUint32(context.ram + 0x540, false), before);
  assert.equal(reservation(context), null, "completed failed stwcx. stays clear");
});

test("GX XFB rows and EFB texture copies invalidate exact physical footprints", () => {
  const context = makeContext();
  writeRuntimeTranslationState(context);
  installRamAliases(context);

  context.view.setUint32(context.ram + 0x1060, 0x1234_5678, false);
  assert.equal(context.loadReserveInteger(0x8000_1060, outputPointer), 1);
  assert.equal(
    context.invalidateGxCopyReservation({
      copyToXfb: true,
      destination: 0x1000,
      width: 32,
      height: 2,
      stride: 128,
      copyState: { copyCommand: 0x4000, pixelControl: 0 },
    }),
    false,
    "an XFB stride gap does not overlap either written row",
  );
  assert.equal(reservation(context), 0x1060);

  assert.equal(
    context.invalidateGxCopyReservation({
      copyToXfb: false,
      destination: 0x1060,
      width: 8,
      sourceHeight: 8,
      stride: 32,
      copyState: { copyCommand: 0, pixelControl: 0 },
    }),
    true,
    "one R4 EFB texture block writes exactly 32 destination bytes",
  );
  assert.equal(reservation(context), null);

  context.view.setUint32(context.ram + 0x1020, 0x0102_0304, false);
  assert.equal(context.loadReserveInteger(0x8000_1020, outputPointer), 1);
  const stridedR4Copy = {
    copyToXfb: false,
    destination: 0x1000,
    width: 8,
    sourceHeight: 16,
    stride: 64,
    copyState: { copyCommand: 0, pixelControl: 0 },
  };
  assert.equal(
    context.invalidateGxCopyReservation(stridedR4Copy),
    false,
    "the 32-byte gap between two R4 block rows remains untouched",
  );
  assert.equal(reservation(context), 0x1020);

  context.view.setUint32(context.ram + 0x1040, 0x0506_0708, false);
  assert.equal(context.loadReserveInteger(0xc000_1040, outputPointer), 1);
  assert.equal(
    context.invalidateGxCopyReservation(stridedR4Copy),
    true,
    "the later R4 block row begins at the programmed destination stride",
  );
  assert.equal(reservation(context), null);

  context.view.setUint32(context.ram + 0x1020, 0xaabb_ccdd, false);
  assert.equal(context.loadReserveInteger(0xc000_1020, outputPointer), 1);
  assert.equal(
    context.invalidateGxCopyReservation({
      copyToXfb: true,
      destination: 0x1000,
      width: 32,
      height: 2,
      stride: 128,
      copyState: { copyCommand: 0x4000, pixelControl: 0 },
    }),
    true,
  );
  assert.equal(reservation(context), null);
});

test("EFB copy layout keeps RGB5A3 and all shared depth tile modes distinct", () => {
  const context = makeContext();
  const encodedTarget = raw => (((raw << 1) & 0xf) | (raw >>> 3)) << 3;

  assert.equal(context.gxCopyTextureLayout(encodedTarget(4), 0).name, "RGB565");
  assert.equal(context.gxCopyTextureLayout(encodedTarget(5), 0).name, "RGB5A3");
  assert.equal(context.gxCopyTextureLayout(encodedTarget(2), 3).name, "IA4");
  assert.equal(context.gxCopyTextureLayout(encodedTarget(5), 3).name, "RGB5A3");
  assert.equal(context.gxCopyTextureLayout(encodedTarget(13), 3), null);

  const writes = [];
  context.invalidateDataReservationForExternalStridedWrite = (...args) => {
    writes.push(args);
    return false;
  };
  const clippedHalf = {
    copyToXfb: false,
    destination: 0x1000,
    sourceX: 638,
    sourceY: 526,
    width: 4,
    sourceHeight: 4,
    stride: 64,
    copyState: { copyCommand: 0x200, pixelControl: 0 },
  };
  assert.equal(context.invalidateGxCopyReservation(clippedHalf), false);
  assert.deepEqual(writes, [[0x1000, 32, 64, 1]]);

  writes.length = 0;
  assert.equal(
    context.invalidateGxCopyReservation({
      ...clippedHalf,
      sourceX: 639,
      sourceY: 527,
    }),
    false,
  );
  assert.deepEqual(writes, []);
});

test("zero-stride GX copies repeatedly invalidate only their bounded base row", () => {
  const context = makeContext();
  writeRuntimeTranslationState(context);
  installRamAliases(context);

  context.view.setUint32(context.ram + 0x1060, 0x1234_5678, false);
  assert.equal(context.loadReserveInteger(0x8000_1060, outputPointer), 1);
  assert.equal(
    context.invalidateGxCopyReservation({
      copyToXfb: true,
      destination: 0x1000,
      width: 16,
      height: 3,
      stride: 0,
      copyState: { copyCommand: 0x4000, pixelControl: 0 },
    }),
    false,
    "repeated zero-stride rows preserve a disjoint reservation",
  );
  assert.equal(reservation(context), 0x1060);

  assert.equal(
    context.invalidateGxCopyReservation({
      copyToXfb: true,
      destination: 0x1060,
      width: 16,
      height: 1,
      stride: 0,
      copyState: { copyCommand: 0x4000, pixelControl: 0 },
    }),
    true,
    "a single zero-stride row still invalidates its exact footprint",
  );
  assert.equal(reservation(context), null);

  context.view.setUint32(context.ram + 0x1020, 0xaabb_ccdd, false);
  assert.equal(context.loadReserveInteger(0x8000_1020, outputPointer), 1);
  assert.equal(
    context.invalidateGxCopyReservation({
      copyToXfb: false,
      destination: 0x1000,
      width: 8,
      sourceHeight: 16,
      stride: 0,
      copyState: { copyCommand: 0, pixelControl: 0 },
    }),
    false,
    "repeated zero-stride texture blocks do not widen their destination",
  );
  assert.equal(reservation(context), 0x1020);
});

test("reservation-less SC stops after write translation and page history", () => {
  const effective = 0x0000_1ff0;
  const segments = Array(16).fill(0);
  const unbacked = makeContext();
  writeRuntimeTranslationState(unbacked, { segments });
  const unbackedPte = installPrimaryPte(
    unbacked,
    effective,
    segments[0],
    0x0003_0002,
  );
  unbacked.view.setUint32(
    unbacked.cpu + unbacked.dsisrOffset,
    0xdead_beef,
    true,
  );

  assert.equal(unbacked.storeConditionalInteger(effective, 0x1122_3344), 1);
  assert.equal(readPte1(unbacked, unbackedPte), 0x0003_0182);
  assert.equal(unbacked.lastDataStorageFault, null);
  assert.equal(unbacked.lastUnmappedAccess, null);
  assert.equal(
    unbacked.view.getUint32(unbacked.cpu + unbacked.dsisrOffset, true),
    0xdead_beef,
  );

  const device = makeContext();
  writeRuntimeTranslationState(device, { msr: 0 });
  const devicePointer = device.mmio + 0x100;
  device.view.setUint32(devicePointer, 0x5566_7788, false);
  device.view.setUint32(
    device.cpu + device.dsisrOffset,
    0xdead_beef,
    true,
  );

  assert.equal(
    device.storeConditionalInteger(0x0c00_0100, 0xaabb_ccdd),
    1,
  );
  assert.equal(device.view.getUint32(devicePointer, false), 0x5566_7788);
  assert.equal(device.lastDataStorageFault, null);
  assert.equal(device.lastUnmappedAccess, null);
  assert.equal(
    device.view.getUint32(device.cpu + device.dsisrOffset, true),
    0xdead_beef,
  );
});

test("live-reservation SC validates backing and preserves on resulting faults", () => {
  const effective = 0x0000_1ff0;
  const segments = Array(16).fill(0);
  const unbacked = makeContext();
  writeRuntimeTranslationState(unbacked);
  installRamAliases(unbacked);
  unbacked.view.setUint32(unbacked.ram + 0x120, 0x1234_5678, false);
  assert.equal(
    unbacked.loadReserveInteger(0x8000_0120, outputPointer),
    1,
  );

  writeRuntimeTranslationState(unbacked, { segments });
  const unbackedPte = installPrimaryPte(
    unbacked,
    effective,
    segments[0],
    0x0003_0002,
  );
  assert.equal(unbacked.storeConditionalInteger(effective, 0x1122_3344), 0);
  assert.equal(readPte1(unbacked, unbackedPte), 0x0003_0182);
  assert.equal(unbacked.lastDataStorageFault.stage, "physical");
  assert.equal(
    unbacked.lastDataStorageFault.reason,
    "translated-physical-unbacked",
  );
  assert.equal(reservation(unbacked), 0x120);

  const device = makeContext();
  writeRuntimeTranslationState(device);
  installRamAliases(device);
  device.view.setUint32(device.ram + 0x120, 0x1234_5678, false);
  assert.equal(device.loadReserveInteger(0xc000_0120, outputPointer), 1);
  writeRuntimeTranslationState(device, { msr: 0 });
  const devicePointer = device.mmio + 0x100;
  device.view.setUint32(devicePointer, 0x5566_7788, false);

  assert.equal(
    device.storeConditionalInteger(0x0c00_0100, 0xaabb_ccdd),
    0,
  );
  assert.equal(device.view.getUint32(devicePointer, false), 0x5566_7788);
  assert.equal(device.lastDataStorageFault.stage, "device");
  assert.equal(
    device.lastDataStorageFault.reason,
    "reservation-device-rejected",
  );
  assert.equal(reservation(device), 0x120);
});

test("failed conditional stores still preflight page protection and R/C history", () => {
  const context = makeContext();
  const effective = 0x0000_1ff0;
  const segments = Array(16).fill(0);
  writeRuntimeTranslationState(context, { segments });
  const writable = installPrimaryPte(
    context,
    effective,
    segments[0],
    0x0000_3002,
  );

  assert.equal(context.storeConditionalInteger(effective, 0x1122_3344), 1);
  assert.equal(readPte1(context, writable), 0x0000_3182);
  assert.equal(
    context.view.getUint32(context.ram + 0x3ff0, false),
    0,
    "a missing reservation performs no store",
  );

  const protectedContext = makeContext();
  writeRuntimeTranslationState(protectedContext);
  installRamAliases(protectedContext);
  protectedContext.view.setUint32(
    protectedContext.ram + 0x120,
    0x1234_5678,
    false,
  );
  assert.equal(
    protectedContext.loadReserveInteger(0x8000_0120, outputPointer),
    1,
  );

  writeRuntimeTranslationState(protectedContext, { segments });
  const protectedPte = installPrimaryPte(
    protectedContext,
    effective,
    segments[0],
    0x0000_3003,
  );
  assert.equal(
    protectedContext.storeConditionalInteger(effective, 0xaabb_ccdd),
    0,
  );
  assert.equal(readPte1(protectedContext, protectedPte), 0x0000_3103);
  assert.equal(
    reservation(protectedContext),
    0x120,
    "a protection fault preserves the live reservation",
  );
});

function makeHookContext(name, result) {
  const buffer = new ArrayBuffer(0x1000);
  const context = {
    cycles: 100,
    dataRamOrLockedCachePointer: () => 0x800,
    drainGxFifoStaging() {},
    gxFifoStagingMeta: 0x200,
    hookCalls: new Map(),
    hookCycleOffset: 8,
    regionContinuableHookCalls: 0,
    regionControl: 0x300,
    regionCyclePrefixOffset: 0,
    regionExitRequestOffset: 4,
    regionRunning: true,
    view: new DataView(buffer),
  };
  let observedCycles = null;
  context.target = {
    [name]() {
      observedCycles = context.cycles;
      return result;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction("regionHookCanContinue"),
      extractFunction("withScopedCycles"),
      extractFunction("withPublishedHookCycles"),
      extractFunction("invokeJitHook"),
    ].join("\n\n"),
    context,
    { filename: "browser_boot.data-reservation-hook.js" },
  );
  context.view.setUint32(
    context.regionControl + context.regionCyclePrefixOffset,
    7,
    true,
  );
  context.view.setUint32(
    context.regionControl + context.hookCycleOffset,
    5,
    true,
  );
  return { context, observedCycles: () => observedCycles };
}

test("reservation hooks publish cycles and continue linked regions by status", () => {
  for (const [name, result] of [
    ["user_0_27", 1],
    ["user_0_28", 1],
    ["user_0_28", 2],
  ]) {
    const fixture = makeHookContext(name, result);
    assert.equal(
      fixture.context.invokeJitHook(
        fixture.context.target,
        name,
        [0, 0x8000_0100, outputPointer],
      ),
      result,
    );
    assert.equal(fixture.observedCycles(), 112);
    assert.equal(fixture.context.cycles, 100, "hook cycle scope restores");
    assert.equal(fixture.context.regionContinuableHookCalls, 1);
    assert.equal(
      fixture.context.view.getUint32(
        fixture.context.regionControl
          + fixture.context.regionExitRequestOffset,
        true,
      ),
      0,
    );
  }

  const fault = makeHookContext("user_0_28", 0);
  assert.equal(
    fault.context.invokeJitHook(
      fault.context.target,
      "user_0_28",
      [0, 0x8000_0100, 1],
    ),
    0,
  );
  assert.equal(fault.observedCycles(), 112);
  assert.equal(fault.context.regionContinuableHookCalls, 0);
  assert.equal(
    fault.context.view.getUint32(
      fault.context.regionControl + fault.context.regionExitRequestOffset,
      true,
    ),
    1,
  );
});
