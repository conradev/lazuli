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

const mmuFunctions = [
  "batAllowsAccess",
  "translateBatAddress",
  "translateDataEffectiveAddress",
  "translateDataEffectiveRange",
  "readDataBats",
  "translateDataAddress",
  "translateDataRange",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "physicalMmioPointer",
  "dataRamPointer",
  "dataFastmemPointer",
  "physicalLockedCachePointer",
  "dataRamOrLockedCachePointer",
  "initializeBatRegisters",
  "initializeMemoryManagement",
  "rebuildDataFastmem",
  "msrChanged",
  "dataBatChanged",
  "cacheInstructionUsesStoreAccess",
  "translateCacheLoopRange",
];

const defaultInstructionBats = [
  [0x80001fff, 0x00000002],
  [0x00000000, 0x00000000],
  [0x00000000, 0x00000000],
  [0xfff0001f, 0xfff00001],
];
const defaultDataBats = [
  [0x80001fff, 0x00000002],
  [0xc0001fff, 0x0000002a],
  [0x00000000, 0x00000000],
  [0xfff0001f, 0xfff00001],
];

function makeContext() {
  const buffer = new ArrayBuffer(1024 * 1024);
  const context = {
    __FASTMEM_LUT_COUNT__: 1 << 15,
    __FASTMEM_PAGE_SHIFT__: 17,
    cpu: 0,
    dataBatOffsets: [
      [0x40, 0x44],
      [0x48, 0x4c],
      [0x50, 0x54],
      [0x58, 0x5c],
    ],
    defaultDataBats,
    defaultInstructionBats,
    dataFastmemTranslationSignature: null,
    fastmem: 0x1000,
    instructionBatOffsets: [
      [0x80, 0x84],
      [0x88, 0x8c],
      [0x90, 0x94],
      [0x98, 0x9c],
    ],
    lockedCache: 0xc0000,
    lockedCacheSize: 0x4000,
    mmio: 0x90000,
    mmioSize: 0x20000,
    msrOffset: 0x20,
    physicalMmioBase: 0x0c000000,
    ram: 0x40000,
    ramSize: 0x40000,
    view: new DataView(buffer),
  };
  vm.createContext(context);
  vm.runInContext(
    mmuFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.mmu.js" },
  );
  context.initializeMemoryManagement();
  context.rebuildDataFastmem();
  return context;
}

function fastmemEntry(context, address) {
  const index = (address >>> context.__FASTMEM_PAGE_SHIFT__) >>> 0;
  return context.view.getUint32(context.fastmem + index * 4, true);
}

test("power-on BATs map the GameCube cached, uncached, and MMIO aliases", () => {
  const context = makeContext();

  assert.equal(context.view.getUint32(context.msrOffset, true), 0x30);
  for (let index = 0; index < 4; index += 1) {
    const [instructionLower, instructionUpper] = context.instructionBatOffsets[index];
    assert.equal(
      context.view.getUint32(instructionUpper, true),
      defaultInstructionBats[index][0] >>> 0,
    );
    assert.equal(
      context.view.getUint32(instructionLower, true),
      defaultInstructionBats[index][1] >>> 0,
    );
    const [dataLower, dataUpper] = context.dataBatOffsets[index];
    assert.equal(
      context.view.getUint32(dataUpper, true),
      defaultDataBats[index][0] >>> 0,
    );
    assert.equal(
      context.view.getUint32(dataLower, true),
      defaultDataBats[index][1] >>> 0,
    );
  }

  assert.equal(context.translateDataAddress(0x80001234), 0x00001234);
  assert.equal(context.translateDataAddress(0xc0001234), 0x00001234);
  assert.equal(context.translateDataAddress(0xcc008000), 0x0c008000);
  assert.equal(context.translateDataAddress(0x00001234), null);
  assert.equal(context.physicalRamPointer(0x1234, 4), context.ram + 0x1234);
  assert.equal(
    context.physicalMmioPointer(0x0c008000, 4),
    context.mmio + 0x8000,
  );
});

test("physical normalization rejects aliases and boundaries independently of BATs", () => {
  const context = makeContext();
  const ram = context.normalizePhysicalMemoryAddress(
    context.ramSize - 4,
    4,
    context.ramSize,
    context.mmioSize,
  );
  assert.equal(ram.kind, "ram");
  assert.equal(ram.offset, context.ramSize - 4);

  const mmio = context.normalizePhysicalMemoryAddress(
    0x0c001234,
    4,
    context.ramSize,
    context.mmioSize,
  );
  assert.equal(mmio.kind, "mmio");
  assert.equal(mmio.offset, 0x1234);
  assert.equal(
    context.normalizePhysicalMemoryAddress(
      0x80000000,
      4,
      context.ramSize,
      context.mmioSize,
    ),
    null,
  );
  assert.equal(
    context.normalizePhysicalMemoryAddress(
      context.ramSize - 2,
      4,
      context.ramSize,
      context.mmioSize,
    ),
    null,
  );
});

test("DR-off mode exposes physical RAM and MMIO without effective aliases", () => {
  const context = makeContext();
  context.view.setUint32(context.msrOffset, 0x20, true);
  context.msrChanged();

  assert.equal(context.translateDataAddress(0x00001234), 0x00001234);
  assert.equal(context.translateDataAddress(0x0c001234), 0x0c001234);
  assert.equal(context.dataRamPointer(0x00001234, 4), context.ram + 0x1234);
  assert.equal(context.dataRamPointer(0x80001234, 4), null);
  assert.equal(fastmemEntry(context, 0x00000000), context.ram);
  assert.equal(fastmemEntry(context, 0x80000000), 0);
  assert.equal(fastmemEntry(context, 0xc0000000), 0);
});

test("DBAT changes invalidate old fastmem entries and install remaps in place", () => {
  const context = makeContext();
  assert.equal(fastmemEntry(context, 0x80000000), context.ram);
  assert.equal(fastmemEntry(context, 0xc0000000), context.ram);

  for (const [lowerOffset, upperOffset] of context.dataBatOffsets) {
    context.view.setUint32(lowerOffset, 0, true);
    context.view.setUint32(upperOffset, 0, true);
  }
  const [lowerOffset, upperOffset] = context.dataBatOffsets[0];
  context.view.setUint32(lowerOffset, 0x00020002, true);
  context.view.setUint32(upperOffset, 0x90000002, true);
  context.dataBatChanged();

  assert.equal(context.translateDataAddress(0x90001234), 0x00021234);
  assert.equal(context.translateDataAddress(0x80001234), null);
  assert.equal(fastmemEntry(context, 0x90000000), context.ram + 0x20000);
  assert.equal(fastmemEntry(context, 0x80000000), 0);
  assert.equal(fastmemEntry(context, 0xc0000000), 0);

  context.view.setUint32(upperOffset, 0, true);
  context.dataBatChanged();
  assert.equal(context.translateDataAddress(0x90001234), null);
  assert.equal(fastmemEntry(context, 0x90000000), 0);
});

test("fastmem rebuilds only when data-translation state changes", () => {
  const context = makeContext();
  const [lowerOffset, upperOffset] = context.dataBatOffsets[0];
  for (const [lower, upper] of context.dataBatOffsets) {
    context.view.setUint32(lower, 0, true);
    context.view.setUint32(upper, 0, true);
  }
  context.view.setUint32(lowerOffset, 0x00000002, true);
  context.view.setUint32(upperOffset, 0x90000002, true);
  context.dataBatChanged();
  assert.equal(fastmemEntry(context, 0x90000000), context.ram);

  const page = context.fastmem + (0x90000000 >>> context.__FASTMEM_PAGE_SHIFT__) * 4;
  context.view.setUint32(page, 0x12345678, true);
  context.view.setUint32(context.msrOffset, 0x8030, true);
  context.msrChanged();
  assert.equal(context.view.getUint32(page, true), 0x12345678);

  context.dataBatChanged();
  assert.equal(context.view.getUint32(page, true), 0x12345678);

  context.view.setUint32(context.msrOffset, 0xc030, true);
  context.msrChanged();
  assert.equal(fastmemEntry(context, 0x90000000), 0);

  context.view.setUint32(upperOffset, 0x90000001, true);
  context.dataBatChanged();
  assert.equal(fastmemEntry(context, 0x90000000), context.ram);

  context.view.setUint32(context.msrOffset, 0x8020, true);
  context.msrChanged();
  assert.equal(fastmemEntry(context, 0x90000000), 0);
});

test("BAT validity follows supervisor and user mode independently", () => {
  const context = makeContext();
  const supervisorBat = [0x90000002, 0x00000002];
  const userBat = [0x90000001, 0x00000002];
  const bothBat = [0x90000003, 0x00000002];

  assert.equal(
    context.translateDataEffectiveAddress(0x90001234, 0x10, [supervisorBat], false),
    0x1234,
  );
  assert.equal(
    context.translateDataEffectiveAddress(0x90001234, 0x4010, [supervisorBat], false),
    null,
  );
  assert.equal(
    context.translateDataEffectiveAddress(0x90001234, 0x10, [userBat], false),
    null,
  );
  assert.equal(
    context.translateDataEffectiveAddress(0x90001234, 0x4010, [userBat], false),
    0x1234,
  );
  assert.equal(
    context.translateDataEffectiveAddress(0x90001234, 0x10, [bothBat], false),
    0x1234,
  );
  assert.equal(
    context.translateDataEffectiveAddress(0x90001234, 0x4010, [bothBat], false),
    0x1234,
  );
});

test("BATL PP enforces no-access, read-only, and read-write slow paths", () => {
  const context = makeContext();
  const upper = 0x90000003;
  for (const protection of [0, 1, 2, 3]) {
    const bats = [[upper, protection]];
    const readable = protection !== 0;
    const writable = protection === 2;
    assert.equal(
      context.translateDataEffectiveAddress(0x90001234, 0x10, bats, false),
      readable ? 0x1234 : null,
      `PP=${protection} read`,
    );
    assert.equal(
      context.translateDataEffectiveAddress(0x90001234, 0x10, bats, true),
      writable ? 0x1234 : null,
      `PP=${protection} write`,
    );
    assert.equal(
      context.dataFastmemPointer(0x90000000, 0x10, bats, 0x40000, 0x80000),
      writable ? 0x80000 : null,
      `PP=${protection} shared fastmem`,
    );
  }

  for (const [lowerOffset, upperOffset] of context.dataBatOffsets) {
    context.view.setUint32(lowerOffset, 0, true);
    context.view.setUint32(upperOffset, 0, true);
  }
  const [lowerOffset, upperOffset] = context.dataBatOffsets[0];
  context.view.setUint32(upperOffset, 0x90000002, true);
  context.view.setUint32(lowerOffset, 0x00000001, true);
  context.dataBatChanged();
  assert.equal(context.translateDataAddress(0x90000000, false), 0);
  assert.equal(context.translateDataAddress(0x90000000, true), null);
  assert.equal(fastmemEntry(context, 0x90000000), 0);

  context.view.setUint32(lowerOffset, 0x00000002, true);
  context.dataBatChanged();
  assert.equal(fastmemEntry(context, 0x90000000), context.ram);
});

test("locked cache is reachable only through a translated physical mapping", () => {
  const context = makeContext();
  for (const [lowerOffset, upperOffset] of context.dataBatOffsets) {
    context.view.setUint32(lowerOffset, 0, true);
    context.view.setUint32(upperOffset, 0, true);
  }
  const [lowerOffset, upperOffset] = context.dataBatOffsets[0];
  context.view.setUint32(lowerOffset, 0xe0000001, true);
  context.view.setUint32(upperOffset, 0x90000002, true);

  assert.equal(context.translateDataRange(0x90000010, 4, false), 0xe0000010);
  assert.equal(
    context.dataRamOrLockedCachePointer(0x90000010, 4, false),
    context.lockedCache + 0x10,
  );
  assert.equal(context.dataRamOrLockedCachePointer(0x90000010, 4, true), null);
  assert.equal(context.dataRamOrLockedCachePointer(0xe0000010, 4, false), null);

  context.view.setUint32(lowerOffset, 0xe0000002, true);
  assert.equal(
    context.dataRamOrLockedCachePointer(0x90000010, 4, true),
    context.lockedCache + 0x10,
  );

  context.view.setUint32(upperOffset, 0, true);
  assert.equal(context.dataRamOrLockedCachePointer(0x90000010, 4, false), null);

  context.view.setUint32(context.msrOffset, 0x20, true);
  assert.equal(
    context.dataRamOrLockedCachePointer(0xe0000010, 4, true),
    context.lockedCache + 0x10,
  );
});

test("translated ranges require contiguous physical BATs and permissions", () => {
  const context = makeContext();
  const first = [0x90000002, 0x00000002];
  const secondReadWrite = [0x90020002, 0x00020002];
  const secondReadOnly = [0x90020002, 0x00020001];
  const secondDiscontiguous = [0x90020002, 0x00040002];

  assert.equal(
    context.translateDataEffectiveRange(
      0x9001fff0,
      0x40,
      0x10,
      [first, secondReadWrite],
      true,
    ),
    0x0001fff0,
  );
  assert.equal(
    context.translateDataEffectiveRange(
      0x9001fff0,
      0x40,
      0x10,
      [first, secondReadOnly],
      false,
    ),
    0x0001fff0,
  );
  assert.equal(
    context.translateDataEffectiveRange(
      0x9001fff0,
      0x40,
      0x10,
      [first, secondReadOnly],
      true,
    ),
    null,
  );
  assert.equal(
    context.translateDataEffectiveRange(
      0x9001fff0,
      0x40,
      0x10,
      [first, secondDiscontiguous],
      false,
    ),
    null,
  );
});

test("cache-loop acceleration uses load/store translation while icbi stays virtual", () => {
  const context = makeContext();
  const calls = [];
  context.translateDataRange = (...arguments_) => {
    calls.push(arguments_);
    return 0x12340000;
  };

  for (const instruction of [0x7c0018ac, 0x7c00186c]) {
    assert.equal(context.translateCacheLoopRange(instruction, 0x80001000, 0x60), 0x12340000);
    assert.deepEqual(calls.pop(), [0x80001000, 0x60, false]);
  }
  for (const instruction of [0x7c001bac, 0x7c001fec]) {
    assert.equal(context.translateCacheLoopRange(instruction, 0x80001000, 0x60), 0x12340000);
    assert.deepEqual(calls.pop(), [0x80001000, 0x60, true]);
  }
  assert.equal(context.translateCacheLoopRange(0x7c001fac, 0x80001000, 0x60), 0x80001000);
  assert.equal(calls.length, 0);

  const fastForward = extractFunction("fastForwardRecognizedLoop");
  assert.match(fastForward, /translateCacheLoopRange\(/);
  assert.match(fastForward, /translateDataRange\(guestStart, byteCount, true\)/);
  assert.doesNotMatch(extractFunction("translateCacheLoopRange"), /translateDataRange[\s\S]*0x7c001fac/);
});

test("MSR and DBAT generic hooks rebuild mappings without delivering interrupts", () => {
  assert.match(source, /user_0_16:\s*\(\) => msrChanged\(\)/);
  assert.match(source, /user_0_18:\s*\(\) => dataBatChanged\(\)/);
  assert.doesNotMatch(extractFunction("msrChanged"), /raiseException|serviceMmio/);
  assert.match(extractFunction("msrChanged"), /rebuildDataFastmem\(\)/);
  assert.match(extractFunction("dataBatChanged"), /rebuildDataFastmem\(\)/);
  assert.match(
    source,
    /initializeMemoryManagement\(\);\s*rebuildDataFastmem\(\);/,
  );
  assert.match(
    extractFunction("raiseException"),
    /\(oldMsr \^ exceptionMsr\) & 0x4010.*rebuildDataFastmem\(\)/s,
  );
  assert.match(
    extractFunction("readInteger"),
    /translateDataRange\(logical, size, false\)/,
  );
  assert.match(
    extractFunction("writeInteger"),
    /translateDataRange\(logical, size, true\)/,
  );
});
