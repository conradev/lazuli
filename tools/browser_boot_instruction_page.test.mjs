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

const instructionPageFunctions = [
  "batAllowsAccess",
  "resolveInstructionEffectiveAddress",
  "readSegmentRegisters",
  "resetTranslationLookasideBuffer",
  "initializeTranslationLookasideBuffers",
  "instructionTlbSetIndex",
  "lookupInstructionTlb",
  "fillInstructionTlb",
  "resolveInstructionTlbEntry",
  "resolveInstructionPageAddress",
  "resolveInstructionTranslation",
  "translateInstructionEffectiveAddress",
  "translateInstructionEffectiveRange",
  "readInstructionBats",
  "translateInstructionAddress",
  "translateInstructionRange",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "physicalLockedCachePointer",
  "resolveInstructionFetch",
  "fetchInstructionWord",
  "probeInstructionWord",
  "instructionStorageCause",
];

class SparseMemory {
  constructor() {
    this.data = new Map();
    this.accesses = [];
  }

  getUint8(address) {
    return this.data.get(Number(address)) ?? 0;
  }

  setUint8(address, value) {
    this.data.set(Number(address), value & 0xff);
  }

  getUint32(address, littleEndian = false) {
    const base = Number(address);
    this.accesses.push({ kind: "read32", address: base, littleEndian });
    const bytes = Array.from({ length: 4 }, (_unused, index) =>
      this.getUint8(base + index)
    );
    if (littleEndian) bytes.reverse();
    return (
      bytes[0] * 0x1000000
      + (bytes[1] << 16)
      + (bytes[2] << 8)
      + bytes[3]
    ) >>> 0;
  }

  setUint32(address, value, littleEndian = false) {
    const base = Number(address);
    const stored = value >>> 0;
    this.accesses.push({ kind: "write32", address: base, littleEndian });
    const bytes = [
      stored >>> 24,
      stored >>> 16,
      stored >>> 8,
      stored,
    ].map(byte => byte & 0xff);
    if (littleEndian) bytes.reverse();
    bytes.forEach((byte, index) => this.setUint8(base + index, byte));
  }

  clearAccesses() {
    this.accesses.length = 0;
  }
}

function sparseByteProxy(memory) {
  return new Proxy({}, {
    get(target, property) {
      const address = Number(property);
      if (Number.isSafeInteger(address)) return memory.getUint8(address);
      return Reflect.get(target, property);
    },
    set(target, property, value) {
      const address = Number(property);
      if (Number.isSafeInteger(address)) {
        memory.setUint8(address, value);
        return true;
      }
      return Reflect.set(target, property, value);
    },
  });
}

const cpu = 0;
const ram = 0x1_0000_0000;
const physicalRamBytes = 0x1000_0000;
const instructionBatOffsets = [
  [0x40, 0x44],
  [0x48, 0x4c],
  [0x50, 0x54],
  [0x58, 0x5c],
];
const segmentRegisterOffsets = Array.from(
  { length: 16 },
  (_unused, index) => 0x100 + index * 4,
);
const msrOffset = 0x20;
const sdr1Offset = 0x180;

function makeContext({ ramSize = physicalRamBytes } = {}) {
  const memory = new SparseMemory();
  const context = {
    bytes: sparseByteProxy(memory),
    cpu,
    instructionBatOffsets,
    instructionTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    dataTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    lockedCache: 0x2_0000_0000,
    lockedCacheSize: 0,
    memory,
    mmioSize: 0,
    msrOffset,
    physicalMmioBase: 0x0c00_0000,
    ram,
    ramSize,
    sdr1Offset,
    segmentRegisterOffsets,
    view: memory,
  };
  vm.createContext(context);
  vm.runInContext(
    instructionPageFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.instruction-page.js" },
  );
  return context;
}

function writeInstructionBat(context, index, upper, lower) {
  const [lowerOffset, upperOffset] = context.instructionBatOffsets[index];
  context.view.setUint32(context.cpu + upperOffset, upper >>> 0, true);
  context.view.setUint32(context.cpu + lowerOffset, lower >>> 0, true);
}

function writeRuntimeTranslationState(context, {
  msr = 0x20,
  sdr1 = 0,
  segments = Array(16).fill(0),
} = {}) {
  context.view.setUint32(context.cpu + context.msrOffset, msr, true);
  context.view.setUint32(context.cpu + context.sdr1Offset, sdr1, true);
  segments.forEach((value, index) => {
    context.view.setUint32(
      context.cpu + context.segmentRegisterOffsets[index],
      value,
      true,
    );
  });
  for (let index = 0; index < 4; index += 1) {
    writeInstructionBat(context, index, 0, 0);
  }
}

function pageTableVector(effective, segment, sdr1) {
  const vsid = segment & 0x00ff_ffff;
  const pageIndex = (effective >>> 12) & 0xffff;
  const api = (effective >>> 22) & 0x3f;
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

function writePte(context, ptegAddress, slot, pte0, pte1) {
  const pointer = context.ram + ptegAddress + slot * 8;
  context.view.setUint32(pointer, pte0, false);
  context.view.setUint32(pointer + 4, pte1, false);
  return pointer;
}

function installPrimaryPte(context, effective, segment, sdr1, pte1, slot = 0) {
  const vector = pageTableVector(effective, segment, sdr1);
  const pointer = writePte(
    context,
    vector.primary,
    slot,
    vector.primaryPte0,
    pte1,
  );
  return { ...vector, pointer };
}

const official = {
  effective: 0x00ff_a01b,
  primary: 0x0f9f_f980,
  primaryPte0: 0xe538_0e03,
  sdr1: 0x0f98_0007,
  secondary: 0x0f98_0640,
  secondaryPte0: 0xe538_0e43,
  segment: 0x20ca_701c,
};

test("instruction page fixture extracts the complete browser walker contract", () => {
  assert.deepEqual(
    instructionPageFunctions.filter(name => !source.includes(`function ${name}(`)),
    [],
  );
});

test("segment registers retain SR0..SR15 architectural order", () => {
  const context = makeContext();
  const segments = Array.from(
    { length: 16 },
    (_unused, index) => (0x1000_0000 + index * 0x0101_0101) >>> 0,
  );
  writeRuntimeTranslationState(context, { segments });
  assert.deepEqual(Array.from(context.readSegmentRegisters()), segments);
});

test("official hashed-page vector resolves matching primary and secondary PTEs", () => {
  const calculated = pageTableVector(
    official.effective,
    official.segment,
    official.sdr1,
  );
  assert.deepEqual(calculated, {
    primary: official.primary,
    secondary: official.secondary,
    primaryPte0: official.primaryPte0,
    secondaryPte0: official.secondaryPte0,
  });

  for (const secondary of [false, true]) {
    const context = makeContext();
    const segments = Array(16).fill(0);
    segments[0] = official.segment;
    writeRuntimeTranslationState(context, {
      msr: 0x20,
      sdr1: official.sdr1,
      segments,
    });
    const pteg = secondary ? official.secondary : official.primary;
    const pte0 = secondary ? official.secondaryPte0 : official.primaryPte0;
    writePte(context, pteg, 5, pte0, 0x0012_3002);
    context.memory.clearAccesses();

    const resolved = context.resolveInstructionPageAddress(
      official.effective,
      0x20,
      segments,
      official.sdr1,
    );
    assert.equal(resolved.kind, "mapped");
    assert.equal(resolved.physical >>> 0, 0x0012_301b);
    assert.equal(resolved.secondary, secondary);
    assert.equal(resolved.slot, 5);
    const pteReads = context.memory.accesses.filter(access =>
      access.kind === "read32"
      && access.address >= context.ram + pteg
      && access.address < context.ram + pteg + 64
    );
    assert.ok(pteReads.length >= 2, "walker must read the selected physical PTEG");
    assert.ok(
      pteReads.every(access => access.littleEndian === false),
      "PTE0/PTE1 accesses must be big-endian",
    );
  }

  const precedenceContext = makeContext();
  const precedenceSegments = Array(16).fill(0);
  precedenceSegments[0] = official.segment;
  writePte(
    precedenceContext,
    official.primary,
    0,
    official.primaryPte0,
    0x0012_3002,
  );
  writePte(
    precedenceContext,
    official.secondary,
    0,
    official.secondaryPte0,
    0x0045_6002,
  );
  const primaryWins = precedenceContext.resolveInstructionPageAddress(
    official.effective,
    0x20,
    precedenceSegments,
    official.sdr1,
  );
  assert.equal(primaryWins.kind, "mapped");
  assert.equal(primaryWins.secondary, false);
  assert.equal(primaryWins.physical >>> 0, 0x0012_301b);
});

test("PTE matches require exact V, VSID, H, and API fields", () => {
  const context = makeContext();
  const segments = Array(16).fill(0);
  segments[0] = official.segment;
  const primaryMismatches = [
    official.primaryPte0 & 0x7fff_ffff,
    official.primaryPte0 ^ 0x80,
    official.primaryPte0 | 0x40,
    official.primaryPte0 ^ 1,
  ];
  primaryMismatches.forEach((pte0, slot) => {
    writePte(context, official.primary, slot, pte0, 0x0012_3002);
  });
  writePte(
    context,
    official.secondary,
    0,
    official.secondaryPte0 & ~0x40,
    0x0045_6002,
  );

  assert.equal(
    context.resolveInstructionPageAddress(
      official.effective,
      0x20,
      segments,
      official.sdr1,
    ).kind,
    "page-fault",
  );
});

test("BAT translation wins before hashed-page lookup and protection does not fall through", () => {
  const context = makeContext({ ramSize: 0 });
  const segments = Array(16).fill(0x9000_0000);
  const mapped = context.resolveInstructionTranslation(
    0x9000_1234,
    0x20,
    [[0x9000_0003, 0x0002_0002]],
    segments,
    official.sdr1,
  );
  assert.equal(mapped.kind, "mapped");
  assert.equal(mapped.physical >>> 0, 0x0002_1234);

  const protectedBat = context.resolveInstructionTranslation(
    0x9000_1234,
    0x20,
    [[0x9000_0003, 0x0002_0000]],
    segments,
    official.sdr1,
  );
  assert.equal(protectedBat.kind, "protection");
  assert.equal(
    context.memory.accesses.some(access => access.address >= context.ram),
    false,
    "a BAT match must not touch the page table",
  );
});

test("segment T and N attributes reject instruction translation before PTE search", () => {
  const context = makeContext({ ramSize: 0 });
  const segments = Array(16).fill(0);
  segments[0] = 0x80ca_701c;
  const directStore = context.resolveInstructionPageAddress(
    official.effective,
    0x20,
    segments,
    official.sdr1,
  );
  assert.equal(directStore.kind, "no-execute");
  assert.equal(directStore.reason, "direct-store-segment");
  assert.equal(context.instructionStorageCause(directStore), 0x1000_0000);
  segments[0] = 0x10ca_701c;
  const noExecute = context.resolveInstructionPageAddress(
    official.effective,
    0x20,
    segments,
    official.sdr1,
  );
  assert.equal(noExecute.kind, "no-execute");
  assert.equal(noExecute.reason, "segment-no-execute");
  assert.equal(context.instructionStorageCause(noExecute), 0x1000_0000);

  const referencedContext = makeContext();
  const referencedSegments = Array(16).fill(0);
  referencedSegments[0] = 0x10ca_701c;
  const pte = installPrimaryPte(
    referencedContext,
    official.effective,
    referencedSegments[0],
    official.sdr1,
    0x0012_3002,
  );
  assert.equal(
    referencedContext.resolveInstructionPageAddress(
      official.effective,
      0x20,
      referencedSegments,
      official.sdr1,
      true,
    ).kind,
    "no-execute",
  );
  assert.equal(
    referencedContext.view.getUint32(pte.pointer + 4, false),
    0x0012_3002,
    "SR[N] rejects the fetch without setting R",
  );
});

test("Ks and Kp select PP=00 protection while every nonzero PP remains readable", () => {
  const cases = [
    { segment: 0x20ca_701c, msr: 0x20, expected: "mapped" },
    { segment: 0x20ca_701c, msr: 0x4020, expected: "protection" },
    { segment: 0x40ca_701c, msr: 0x20, expected: "protection" },
    { segment: 0x40ca_701c, msr: 0x4020, expected: "mapped" },
  ];
  for (const { segment, msr, expected } of cases) {
    const context = makeContext();
    const segments = Array(16).fill(0);
    segments[0] = segment;
    installPrimaryPte(context, official.effective, segment, official.sdr1, 0x0012_3000);
    assert.equal(
      context.resolveInstructionPageAddress(
        official.effective,
        msr,
        segments,
        official.sdr1,
      ).kind,
      expected,
      `SR=${segment.toString(16)} MSR=${msr.toString(16)}`,
    );
  }

  for (const protection of [1, 2, 3]) {
    const context = makeContext();
    const segments = Array(16).fill(0);
    segments[0] = 0x60ca_701c;
    installPrimaryPte(
      context,
      official.effective,
      segments[0],
      official.sdr1,
      0x0012_3000 | protection,
    );
    for (const msr of [0x20, 0x4020]) {
      assert.equal(
        context.resolveInstructionPageAddress(
          official.effective,
          msr,
          segments,
          official.sdr1,
        ).kind,
        "mapped",
        `PP=${protection} MSR=${msr.toString(16)}`,
      );
    }
  }
});

test("guarded instruction pages are distinguished from protection and page misses", () => {
  const guardedContext = makeContext();
  const segments = Array(16).fill(0);
  segments[0] = 0x00ca_701c;
  installPrimaryPte(
    guardedContext,
    official.effective,
    segments[0],
    official.sdr1,
    0x0012_300a,
  );
  const guarded = guardedContext.resolveInstructionPageAddress(
    official.effective,
    0x20,
    segments,
    official.sdr1,
  );
  assert.equal(guarded.kind, "guarded");
  assert.equal(guarded.physical >>> 0, 0x0012_301b);
  assert.equal(guardedContext.instructionStorageCause(guarded), 0x1000_0000);

  const missContext = makeContext();
  const miss = missContext.resolveInstructionPageAddress(
    official.effective,
    0x20,
    segments,
    official.sdr1,
  );
  assert.equal(miss.kind, "page-fault");
  assert.equal(miss.primaryPteg >>> 0, official.primary);
  assert.equal(miss.secondaryPteg >>> 0, official.secondary);
  assert.equal(missContext.instructionStorageCause(miss), 0x4000_0000);
});

test("unbacked page-table storage and unbacked translated storage remain distinct", () => {
  const fetchEffective = (official.effective & ~0xfff) | 0xffc;
  const segments = Array(16).fill(0);
  segments[0] = 0x00ca_701c;
  const tableContext = makeContext({ ramSize: official.primary });
  const unavailableTable = tableContext.resolveInstructionPageAddress(
    official.effective,
    0x20,
    segments,
    official.sdr1,
  );
  assert.equal(unavailableTable.kind, "page-table-unbacked");
  assert.equal(unavailableTable.physical >>> 0, official.primary);
  assert.equal(unavailableTable.secondary, false);
  assert.equal(tableContext.instructionStorageCause(unavailableTable), null);

  const finalContext = makeContext();
  writeRuntimeTranslationState(finalContext, {
    msr: 0x20,
    sdr1: official.sdr1,
    segments,
  });
  installPrimaryPte(
    finalContext,
    fetchEffective,
    segments[0],
    official.sdr1,
    0x2000_0002,
  );
  const translated = finalContext.resolveInstructionTranslation(
    fetchEffective,
    0x20,
    [],
    segments,
    official.sdr1,
  );
  assert.equal(translated.kind, "mapped");
  assert.equal(translated.physical >>> 0, 0x2000_0ffc);
  const fetch = finalContext.resolveInstructionFetch(fetchEffective);
  assert.equal(fetch.kind, "unbacked");
  assert.equal(fetch.physical >>> 0, 0x2000_0ffc);
  assert.equal(finalContext.instructionStorageCause(fetch), null);
});

test("real fetches set R but never C, including protection; probes have no side effects", () => {
  const fetchEffective = (official.effective & ~0xfff) | 0xffc;
  const mappedContext = makeContext();
  const mappedSegments = Array(16).fill(0);
  mappedSegments[0] = 0x00ca_701c;
  writeRuntimeTranslationState(mappedContext, {
    msr: 0x20,
    sdr1: official.sdr1,
    segments: mappedSegments,
  });
  const mappedPte = installPrimaryPte(
    mappedContext,
    fetchEffective,
    mappedSegments[0],
    official.sdr1,
    0x0012_3002,
  );
  mappedContext.view.setUint32(
    mappedContext.ram + 0x0012_3ffc,
    0x6000_0000,
    false,
  );

  assert.equal(mappedContext.probeInstructionWord(fetchEffective), 0x6000_0000);
  assert.equal(
    mappedContext.view.getUint32(mappedPte.pointer + 4, false),
    0x0012_3002,
    "diagnostic probes must not set R",
  );
  assert.equal(mappedContext.fetchInstructionWord(fetchEffective).kind, "mapped");
  assert.equal(
    mappedContext.view.getUint32(mappedPte.pointer + 4, false),
    0x0012_3102,
    "real fetch sets R (0x100) and leaves C (0x80) clear",
  );

  const protectedContext = makeContext();
  const protectedSegments = Array(16).fill(0);
  protectedSegments[0] = 0x20ca_701c;
  writeRuntimeTranslationState(protectedContext, {
    msr: 0x4020,
    sdr1: official.sdr1,
    segments: protectedSegments,
  });
  const protectedPte = installPrimaryPte(
    protectedContext,
    fetchEffective,
    protectedSegments[0],
    official.sdr1,
    0x0012_3000,
  );
  assert.equal(protectedContext.resolveInstructionFetch(fetchEffective).kind, "protection");
  assert.equal(
    protectedContext.view.getUint32(protectedPte.pointer + 4, false),
    0x0012_3100,
    "a real protected fetch still references the matching PTE without setting C",
  );
});

test("instruction fetch resolution accepts only one aligned instruction word", () => {
  const context = makeContext();
  writeRuntimeTranslationState(context);
  assert.equal(
    context.resolveInstructionFetch(official.effective).kind,
    "invalid-range",
  );
  assert.equal(
    context.resolveInstructionFetch(official.effective & ~3, 8).kind,
    "invalid-range",
  );
});

test("instruction ranges split at 4 KiB pages and require contiguous physical mappings", () => {
  const context = makeContext();
  const segments = Array(16).fill(0);
  segments[0] = 0x00ca_701c;
  const effective = 0x00ff_aff0;
  writeRuntimeTranslationState(context, {
    msr: 0x20,
    sdr1: official.sdr1,
    segments,
  });
  const first = installPrimaryPte(
    context,
    effective,
    segments[0],
    official.sdr1,
    0x0012_3002,
  );
  const second = installPrimaryPte(
    context,
    effective + 0x10,
    segments[0],
    official.sdr1,
    0x0034_5002,
  );

  assert.equal(context.translateInstructionRange(effective, 0x10), 0x0012_3ff0);
  assert.equal(context.translateInstructionRange(effective, 0x30), null);
  assert.equal(
    context.view.getUint32(first.pointer + 4, false) & 0x100,
    0,
    "range probes must not set R",
  );

  context.view.setUint32(second.pointer + 4, 0x0012_4002, false);
  assert.equal(context.translateInstructionRange(effective, 0x30), 0x0012_3ff0);
});
