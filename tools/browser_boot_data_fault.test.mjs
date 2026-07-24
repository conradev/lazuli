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

const dataFaultFunctions = [
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
  "readInteger",
  "writeInteger",
  "signedSix",
  "quantizedStoreValue",
  "readQuantized",
  "writeQuantized",
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
const ram = 0x4_0000;
const ramSize = 0x2_0000;
const mmio = 0x8_0000;
const mmioSize = 0x1_0000;
const lockedCache = 0x9_0000;
const lockedCacheSize = 0x4000;
const outputPointer = 0x3_0000;
const effective = 0x0000_1ff0;

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
    dataFaultFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.data-fault.js" },
  );
  return context;
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

function pageTableVector(address, segment, sdr1 = 0) {
  const vsid = segment & 0x00ff_ffff;
  const pageIndex = (address >>> 12) & 0xffff;
  const api = (address >>> 22) & 0x3f;
  const primaryHash = ((vsid & 0x7ffff) ^ pageIndex) & 0x7ffff;
  const mask = 0x3ff | ((sdr1 & 0x1ff) << 10);
  const base = sdr1 & 0xffff_0000;
  return {
    primary: (base | ((primaryHash & mask) << 6)) >>> 0,
    secondary: (base | (((~primaryHash) & mask) << 6)) >>> 0,
    primaryPte0: (0x8000_0000 | (vsid << 7) | api) >>> 0,
    secondaryPte0: (0x8000_0000 | (vsid << 7) | 0x40 | api) >>> 0,
  };
}

function installPrimaryPte(
  context,
  address,
  segment,
  pte1,
  slot = 0,
  sdr1 = 0,
) {
  const vector = pageTableVector(address, segment, sdr1);
  const pointer = context.ram + vector.primary + slot * 8;
  context.view.setUint32(pointer, vector.primaryPte0, false);
  context.view.setUint32(pointer + 4, pte1 >>> 0, false);
  return { ...vector, pointer };
}

function readPte1(context, pte) {
  return context.view.getUint32(pte.pointer + 4, false);
}

function setFaultSentinels(context, {
  dsisr = 0xdead_beef,
  dar = 0x1234_5678,
} = {}) {
  context.view.setUint32(context.cpu + context.dsisrOffset, dsisr, true);
  context.view.setUint32(context.cpu + context.darOffset, dar, true);
}

function readFaultRegisters(context) {
  return {
    dar: context.view.getUint32(context.cpu + context.darOffset, true),
    dsisr: context.view.getUint32(context.cpu + context.dsisrOffset, true),
  };
}

test("data fault fixture extracts the precise browser DSI contract", () => {
  assert.deepEqual(
    dataFaultFunctions.filter(name => !source.includes(`function ${name}(`)),
    [],
  );
  assert.match(source, /\.replace\("__DSISR_OFFSET__"/);
  assert.match(source, /const dsisrOffset = __DSISR_OFFSET__;/);
  assert.match(
    extractFunction("raiseException"),
    /exception === 0x0300[\s\S]*sample\.dsisr[\s\S]*lastDataStorageFault/,
  );
});

test("DSISR cause masks distinguish page, protection, direct-store, and store", () => {
  const context = makeContext();
  const cases = [
    ["page-fault", 0x4000_0000, 0x4200_0000],
    ["protection", 0x0800_0000, 0x0a00_0000],
    ["direct-store", 0x0400_0000, 0x0600_0000],
    ["mapped", 0, 0x0200_0000],
    ["page-table-unbacked", 0, 0x0200_0000],
    ["unbacked", 0, 0x0200_0000],
    ["device-rejected", 0, 0x0200_0000],
    ["invalid-range", 0, 0x0200_0000],
    ["non-contiguous", 0, 0x0200_0000],
  ];
  for (const [kind, loadCause, storeCause] of cases) {
    assert.equal(
      context.dataStorageCause({ kind }, false),
      loadCause,
      `${kind} load`,
    );
    assert.equal(
      context.dataStorageCause({ kind }, true),
      storeCause,
      `${kind} store`,
    );
  }
});

test("fault recording owns DSISR metadata but leaves JIT-owned DAR untouched", () => {
  const context = makeContext();
  writeRuntimeTranslationState(context);
  setFaultSentinels(context);

  assert.equal(
    context.recordDataStorageFault(
      { kind: "page-fault", effective },
      effective,
      4,
      false,
    ),
    0,
  );
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0x4000_0000,
  });
  assert.equal(context.lastDataStorageFault.kind, "data-storage");
  assert.equal(context.lastDataStorageFault.resolverKind, "page-fault");
  assert.equal(context.lastDataStorageFault.access, "read");

  setFaultSentinels(context);
  assert.equal(
    context.recordDataStorageFault(
      { kind: "unbacked", effective, physical: 0x0003_0000 },
      effective,
      4,
      true,
      "backing",
    ),
    0,
  );
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0x0200_0000,
  });
  assert.equal(context.lastDataStorageFault.resolverKind, "unbacked");
  assert.equal(context.lastDataStorageFault.stage, "backing");
});

test("tagged translation faults drive load/store hook DSISR without touching DAR", () => {
  for (const fault of [
    {
      label: "page",
      segment: 0,
      pte1: null,
      readCause: 0x4000_0000,
      writeCause: 0x4200_0000,
    },
    {
      label: "protection",
      segment: 0x4000_0000,
      pte1: 0x0000_3000,
      readCause: 0x0800_0000,
      writeCause: 0x0a00_0000,
    },
    {
      label: "direct-store",
      segment: 0x8000_0000,
      pte1: null,
      readCause: 0x0400_0000,
      writeCause: 0x0600_0000,
    },
  ]) {
    const readContext = makeContext();
    const readSegments = Array(16).fill(0);
    readSegments[0] = fault.segment;
    writeRuntimeTranslationState(readContext, { segments: readSegments });
    if (fault.pte1 !== null) {
      installPrimaryPte(
        readContext,
        effective,
        fault.segment,
        fault.pte1,
      );
    }
    setFaultSentinels(readContext);
    assert.equal(
      readContext.readInteger(effective, outputPointer, 4),
      0,
      `${fault.label} load hook`,
    );
    assert.deepEqual(readFaultRegisters(readContext), {
      dar: 0x1234_5678,
      dsisr: fault.readCause,
    });
    assert.equal(readContext.lastDataStorageFault.resolverKind, fault.label === "page"
      ? "page-fault"
      : fault.label);

    const writeContext = makeContext();
    const writeSegments = Array(16).fill(0);
    writeSegments[0] = fault.segment;
    writeRuntimeTranslationState(writeContext, { segments: writeSegments });
    if (fault.pte1 !== null) {
      installPrimaryPte(
        writeContext,
        effective,
        fault.segment,
        fault.pte1,
      );
    }
    setFaultSentinels(writeContext);
    assert.equal(
      writeContext.writeInteger(effective, 0xfeed_face, 4),
      0,
      `${fault.label} store hook`,
    );
    assert.deepEqual(readFaultRegisters(writeContext), {
      dar: 0x1234_5678,
      dsisr: fault.writeCause,
    });
  }

  const quantizedContext = makeContext();
  writeRuntimeTranslationState(quantizedContext);
  setFaultSentinels(quantizedContext);
  assert.equal(quantizedContext.readQuantized(effective, 0, outputPointer), 0);
  assert.deepEqual(readFaultRegisters(quantizedContext), {
    dar: 0x1234_5678,
    dsisr: 0x4000_0000,
  });
  setFaultSentinels(quantizedContext);
  assert.equal(quantizedContext.writeQuantized(effective, 0, 1.25), 0);
  assert.deepEqual(readFaultRegisters(quantizedContext), {
    dar: 0x1234_5678,
    dsisr: 0x4200_0000,
  });
});

test("successful RAM hooks preserve DSISR and DAR while committing page history", () => {
  const context = makeContext();
  const segments = Array(16).fill(0);
  const pte = installPrimaryPte(context, effective, segments[0], 0x0000_3002);
  writeRuntimeTranslationState(context, { segments });
  context.view.setUint32(context.ram + 0x3ff0, 0x1122_3344, false);
  setFaultSentinels(context);

  assert.equal(context.readInteger(effective, outputPointer, 4), 1);
  assert.equal(context.view.getUint32(outputPointer, true), 0x1122_3344);
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0xdead_beef,
  });
  assert.equal(readPte1(context, pte), 0x0000_3102);

  assert.equal(context.writeInteger(effective, 0xaabb_ccdd, 4), 1);
  assert.equal(context.view.getUint32(context.ram + 0x3ff0, false), 0xaabb_ccdd);
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0xdead_beef,
  });
  assert.equal(readPte1(context, pte), 0x0000_3182);

  setFaultSentinels(context);
  context.view.setFloat32(context.ram + 0x3ff0, 1.5, false);
  assert.equal(context.readQuantized(effective, 0, outputPointer), 4);
  assert.equal(context.view.getFloat64(outputPointer, true), 1.5);
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0xdead_beef,
  });
  assert.equal(context.writeQuantized(effective, 0, 2.5), 4);
  assert.equal(context.view.getFloat32(context.ram + 0x3ff0, false), 2.5);
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0xdead_beef,
  });
});

test("translated-unbacked and device rejection never masquerade as page faults", () => {
  const unbacked = makeContext();
  const segments = Array(16).fill(0);
  installPrimaryPte(unbacked, effective, segments[0], 0x0003_0002);
  writeRuntimeTranslationState(unbacked, { segments });
  setFaultSentinels(unbacked);
  assert.equal(unbacked.readInteger(effective, outputPointer, 4), 0);
  assert.deepEqual(readFaultRegisters(unbacked), {
    dar: 0x1234_5678,
    dsisr: 0,
  });
  assert.equal(unbacked.lastDataStorageFault.resolverKind, "mapped");
  assert.equal(unbacked.lastDataStorageFault.stage, "physical");
  assert.equal(
    unbacked.lastDataStorageFault.reason,
    "translated-physical-unbacked",
  );

  const device = makeContext();
  writeRuntimeTranslationState(device, { msr: 0 });
  setFaultSentinels(device);
  assert.equal(device.writeInteger(0x0c00_3001, 0xff, 1), 0);
  assert.deepEqual(readFaultRegisters(device), {
    dar: 0x1234_5678,
    dsisr: 0x0200_0000,
  });
  assert.equal(device.lastDataStorageFault.resolverKind, "mapped");
  assert.equal(device.lastDataStorageFault.stage, "device");
  assert.equal(
    device.lastDataStorageFault.reason,
    "processor-interface-register-rejected",
  );
});

test("range protection commits R only on the denied page and hooks report precise DSISR", () => {
  const context = makeContext();
  const segments = Array(16).fill(0);
  segments[0] = 0x4000_0000;
  writeRuntimeTranslationState(context, { segments });
  const first = installPrimaryPte(
    context,
    effective,
    segments[0],
    0x0000_3002,
  );
  const second = installPrimaryPte(
    context,
    effective + 0x10,
    segments[0],
    0x0000_4001,
  );
  setFaultSentinels(context);

  const resolved = context.resolveDataRange(effective, 0x30, true, true);
  assert.equal(resolved.kind, "protection");
  assert.equal(resolved.faultEffective >>> 0, 0x0000_2000);
  assert.equal(readPte1(context, first), 0x0000_3002);
  assert.equal(readPte1(context, second), 0x0000_4101);
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0xdead_beef,
  }, "the tagged resolver itself does not publish a DSI");

  assert.equal(context.translateDataRange(effective, 0x30, true, true), null);
  assert.deepEqual(readFaultRegisters(context), {
    dar: 0x1234_5678,
    dsisr: 0xdead_beef,
  }, "the numeric translation wrapper remains DSISR-pure");
  assert.equal(readPte1(context, first), 0x0000_3002);
  assert.equal(readPte1(context, second), 0x0000_4101);

  const hookContext = makeContext();
  const hookSegments = Array(16).fill(0);
  hookSegments[0] = 0x4000_0000;
  writeRuntimeTranslationState(hookContext, { segments: hookSegments });
  const crossingEffective = 0x0000_1ffc;
  const hookFirst = installPrimaryPte(
    hookContext,
    crossingEffective,
    hookSegments[0],
    0x0000_3002,
  );
  const hookSecond = installPrimaryPte(
    hookContext,
    crossingEffective + 4,
    hookSegments[0],
    0x0000_4001,
  );
  setFaultSentinels(hookContext);
  assert.equal(
    hookContext.writeInteger(
      crossingEffective,
      0x1122_3344_5566_7788n,
      8,
    ),
    0,
  );
  assert.deepEqual(readFaultRegisters(hookContext), {
    dar: 0x1234_5678,
    dsisr: 0x0a00_0000,
  });
  assert.equal(readPte1(hookContext, hookFirst), 0x0000_3002);
  assert.equal(readPte1(hookContext, hookSecond), 0x0000_4101);
});
