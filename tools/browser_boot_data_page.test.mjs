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

const dataPageFunctions = [
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
  "translateDataEffectiveAddress",
  "resolveDataEffectiveRange",
  "translateDataEffectiveRange",
  "readSegmentRegisters",
  "readDataBats",
  "translateDataAddress",
  "translateDataRange",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "dataRamPointer",
  "guestEffectivePointer",
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
const msrOffset = 0x20;
const sdr1Offset = 0x180;

function makeContext({ ramSize = physicalRamBytes } = {}) {
  const memory = new SparseMemory();
  const context = {
    bytes: sparseByteProxy(memory),
    cpu,
    dataBatOffsets,
    dataTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    instructionTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
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
    dataPageFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.data-page.js" },
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

function readPte1(context, pte) {
  return context.view.getUint32(pte.pointer + 4, false);
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

test("data page fixture extracts the complete browser walker contract", () => {
  assert.deepEqual(
    dataPageFunctions.filter(name => !source.includes(`function ${name}(`)),
    [],
  );
});

test("DR-off data accesses are untranslated and do not touch BATs or page tables", () => {
  const context = makeContext();
  const effective = 0x9000_1234;
  const segments = Array(16).fill(0x80ff_ffff);
  const bats = [[0x9000_0003, 0x0002_0000]];

  for (const write of [false, true]) {
    context.memory.clearAccesses();
    const resolved = context.resolveDataTranslation(
      effective,
      0,
      bats,
      segments,
      official.sdr1,
      write,
      true,
    );
    assert.equal(resolved.kind, "mapped");
    assert.equal(resolved.source, "real");
    assert.equal(resolved.physical >>> 0, effective);
    assert.equal(context.memory.accesses.length, 0);
    assert.equal(
      context.translateDataEffectiveAddress(
        effective,
        0,
        bats,
        write,
        segments,
        official.sdr1,
        true,
      ),
      effective,
    );
  }
});

test("official hashed-page vector resolves primary and secondary data PTEs", () => {
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
    const pteg = secondary ? official.secondary : official.primary;
    const pte0 = secondary ? official.secondaryPte0 : official.primaryPte0;
    writePte(context, pteg, 5, pte0, 0x0012_3002);
    context.memory.clearAccesses();

    const resolved = context.resolveDataPageAddress(
      official.effective,
      0x10,
      segments,
      official.sdr1,
      false,
      false,
    );
    assert.equal(resolved.kind, "mapped");
    assert.equal(resolved.source, "page");
    assert.equal(resolved.physical >>> 0, 0x0012_301b);
    assert.equal(resolved.secondary, secondary);
    assert.equal(resolved.slot, 5);
    assert.equal(resolved.write, false);
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
  const segments = Array(16).fill(0);
  segments[0] = official.segment;
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
  const primaryWins = precedenceContext.resolveDataPageAddress(
    official.effective,
    0x10,
    segments,
    official.sdr1,
  );
  assert.equal(primaryWins.kind, "mapped");
  assert.equal(primaryWins.secondary, false);
  assert.equal(primaryWins.physical >>> 0, 0x0012_301b);
});

test("data PTE matches require exact V, VSID, H, and API fields", () => {
  for (const [field, pte0] of [
    ["V", official.primaryPte0 & 0x7fff_ffff],
    ["VSID", official.primaryPte0 ^ 0x80],
    ["H", official.primaryPte0 ^ 0x40],
    ["API", official.primaryPte0 ^ 1],
  ]) {
    const context = makeContext();
    const segments = Array(16).fill(0);
    segments[0] = official.segment;
    writePte(context, official.primary, 0, pte0, 0x0012_3002);
    assert.equal(
      context.resolveDataPageAddress(
        official.effective,
        0x10,
        segments,
        official.sdr1,
      ).kind,
      "page-fault",
      `${field} mismatch must not match a data PTE`,
    );
  }
});

test("matching BAT protection has precedence over an otherwise valid page mapping", () => {
  const context = makeContext();
  const effective = 0x9000_1234;
  const segments = Array(16).fill(0);
  segments[effective >>> 28] = 0x00ca_701c;
  const pte = installPrimaryPte(
    context,
    effective,
    segments[effective >>> 28],
    official.sdr1,
    0x0012_3002,
  );
  context.memory.clearAccesses();

  const protectedBat = context.resolveDataTranslation(
    effective,
    0x10,
    [[0x9000_0003, 0x0002_0001]],
    segments,
    official.sdr1,
    true,
    true,
  );
  assert.equal(protectedBat.kind, "protection");
  assert.equal(protectedBat.source, "bat");
  assert.equal(protectedBat.bat, 0);
  assert.equal(
    context.memory.accesses.some(access =>
      access.address >= context.ram + pte.primary
      && access.address < context.ram + pte.primary + 64
    ),
    false,
    "a matching protected BAT must not fall through to the page table",
  );
  assert.equal(readPte1(context, pte), 0x0012_3002);
});

test("Ks, Kp, and PP implement the complete data read/write protection matrix", () => {
  const allowed = {
    0: {
      0: { read: true, write: true },
      1: { read: true, write: true },
      2: { read: true, write: true },
      3: { read: true, write: false },
    },
    1: {
      0: { read: false, write: false },
      1: { read: true, write: false },
      2: { read: true, write: true },
      3: { read: true, write: false },
    },
  };

  for (const userMode of [false, true]) {
    for (const key of [0, 1]) {
      for (let protection = 0; protection < 4; protection += 1) {
        for (const write of [false, true]) {
          const context = makeContext();
          const oppositeKey = key ^ 1;
          const keyBits = userMode
            ? ((oppositeKey ? 0x4000_0000 : 0) | (key ? 0x2000_0000 : 0))
            : ((key ? 0x4000_0000 : 0) | (oppositeKey ? 0x2000_0000 : 0));
          const segment = (keyBits | 0x00ca_701c) >>> 0;
          const segments = Array(16).fill(0);
          segments[0] = segment;
          installPrimaryPte(
            context,
            official.effective,
            segment,
            official.sdr1,
            0x0012_3000 | protection,
          );
          const msr = 0x10 | (userMode ? 0x4000 : 0);
          const resolved = context.resolveDataPageAddress(
            official.effective,
            msr,
            segments,
            official.sdr1,
            write,
            false,
          );
          const expected = allowed[key][protection][write ? "write" : "read"]
            ? "mapped"
            : "protection";
          assert.equal(
            resolved.kind,
            expected,
            `PR=${userMode ? 1 : 0} key=${key} PP=${protection} ${write ? "write" : "read"}`,
          );
          assert.equal(resolved.key, key);
          assert.equal(resolved.protection, protection);
        }
      }
    }
  }
});

test("SR[T] rejects data translation while SR[N] remains executable-data-only", () => {
  const directStoreContext = makeContext();
  const directStoreSegments = Array(16).fill(0);
  directStoreSegments[0] = 0x80ca_701c;
  const directStore = directStoreContext.resolveDataPageAddress(
    official.effective,
    0x10,
    directStoreSegments,
    official.sdr1,
    false,
    true,
  );
  assert.equal(directStore.kind, "direct-store");
  assert.equal(directStore.reason, "direct-store-segment");
  assert.equal(directStoreContext.memory.accesses.length, 0);

  const noExecuteContext = makeContext();
  const noExecuteSegments = Array(16).fill(0);
  noExecuteSegments[0] = 0x10ca_701c;
  const pte = installPrimaryPte(
    noExecuteContext,
    official.effective,
    noExecuteSegments[0],
    official.sdr1,
    0x0012_3002,
  );
  const resolved = noExecuteContext.resolveDataPageAddress(
    official.effective,
    0x10,
    noExecuteSegments,
    official.sdr1,
    false,
    true,
  );
  assert.equal(resolved.kind, "mapped");
  assert.equal(resolved.physical >>> 0, 0x0012_301b);
  assert.equal(
    readPte1(noExecuteContext, pte),
    0x0012_3102,
    "SR[N] must not reject a data access",
  );
});

test("data probes preserve history while real loads, stores, and protection faults update R/C", () => {
  const loadContext = makeContext();
  const loadSegments = Array(16).fill(0);
  loadSegments[0] = 0x00ca_701c;
  const loadPte = installPrimaryPte(
    loadContext,
    official.effective,
    loadSegments[0],
    official.sdr1,
    0x0012_3002,
  );
  assert.equal(
    loadContext.resolveDataPageAddress(
      official.effective,
      0x10,
      loadSegments,
      official.sdr1,
      false,
      false,
    ).kind,
    "mapped",
  );
  assert.equal(readPte1(loadContext, loadPte), 0x0012_3002);
  assert.equal(
    loadContext.translateDataEffectiveAddress(
      official.effective,
      0x10,
      [],
      false,
      loadSegments,
      official.sdr1,
      true,
    ),
    0x0012_301b,
  );
  assert.equal(
    readPte1(loadContext, loadPte),
    0x0012_3102,
    "a real load sets R and leaves C clear",
  );

  const storeContext = makeContext();
  const storeSegments = Array(16).fill(0);
  storeSegments[0] = 0x00ca_701c;
  const storePte = installPrimaryPte(
    storeContext,
    official.effective,
    storeSegments[0],
    official.sdr1,
    0x0012_3002,
  );
  assert.equal(
    storeContext.resolveDataPageAddress(
      official.effective,
      0x10,
      storeSegments,
      official.sdr1,
      true,
      false,
    ).kind,
    "mapped",
  );
  assert.equal(readPte1(storeContext, storePte), 0x0012_3002);
  assert.equal(
    storeContext.resolveDataPageAddress(
      official.effective,
      0x10,
      storeSegments,
      official.sdr1,
      true,
      true,
    ).kind,
    "mapped",
  );
  assert.equal(
    readPte1(storeContext, storePte),
    0x0012_3182,
    "a successful store sets both R and C",
  );

  for (const { protection, write } of [
    { protection: 0, write: false },
    { protection: 1, write: true },
  ]) {
    const context = makeContext();
    const segments = Array(16).fill(0);
    segments[0] = 0x40ca_701c;
    const pte = installPrimaryPte(
      context,
      official.effective,
      segments[0],
      official.sdr1,
      0x0012_3000 | protection,
    );
    assert.equal(
      context.resolveDataPageAddress(
        official.effective,
        0x10,
        segments,
        official.sdr1,
        write,
        false,
      ).kind,
      "protection",
    );
    assert.equal(readPte1(context, pte), 0x0012_3000 | protection);
    assert.equal(
      context.resolveDataPageAddress(
        official.effective,
        0x10,
        segments,
        official.sdr1,
        write,
        true,
      ).kind,
      "protection",
    );
    assert.equal(
      readPte1(context, pte),
      0x0012_3100 | protection,
      "a protected access sets R but never C",
    );
  }
});

function makeTwoPageContext({
  segment = 0x00ca_701c,
  secondPte1 = 0x0012_4002,
  installSecond = true,
} = {}) {
  const context = makeContext();
  const effective = 0x00ff_aff0;
  const segments = Array(16).fill(0);
  segments[0] = segment;
  const first = installPrimaryPte(
    context,
    effective,
    segment,
    official.sdr1,
    0x0012_3002,
  );
  const second = installSecond
    ? installPrimaryPte(
      context,
      effective + 0x10,
      segment,
      official.sdr1,
      secondPte1,
    )
    : null;
  return { context, effective, first, second, segments };
}

test("cross-page range history commits atomically only for contiguous mappings", () => {
  const contiguous = makeTwoPageContext();
  const mapped = contiguous.context.resolveDataEffectiveRange(
    contiguous.effective,
    0x30,
    0x10,
    [],
    contiguous.segments,
    official.sdr1,
    true,
    true,
  );
  assert.equal(mapped.kind, "mapped");
  assert.equal(mapped.physical >>> 0, 0x0012_3ff0);
  assert.equal(mapped.translations.length, 2);
  assert.equal(readPte1(contiguous.context, contiguous.first), 0x0012_3182);
  assert.equal(readPte1(contiguous.context, contiguous.second), 0x0012_4182);

  const nonContiguous = makeTwoPageContext({ secondPte1: 0x0034_5002 });
  const rejected = nonContiguous.context.resolveDataEffectiveRange(
    nonContiguous.effective,
    0x30,
    0x10,
    [],
    nonContiguous.segments,
    official.sdr1,
    true,
    true,
  );
  assert.equal(rejected.kind, "non-contiguous");
  assert.equal(readPte1(nonContiguous.context, nonContiguous.first), 0x0012_3002);
  assert.equal(readPte1(nonContiguous.context, nonContiguous.second), 0x0034_5002);
  assert.equal(
    nonContiguous.context.translateDataEffectiveRange(
      nonContiguous.effective,
      0x30,
      0x10,
      [],
      true,
      nonContiguous.segments,
      official.sdr1,
      true,
    ),
    null,
  );
  assert.equal(readPte1(nonContiguous.context, nonContiguous.first), 0x0012_3002);
  assert.equal(readPte1(nonContiguous.context, nonContiguous.second), 0x0034_5002);
});

test("cross-page protection references only the denied PTE and page misses change no history", () => {
  const protectedRange = makeTwoPageContext({
    segment: 0x40ca_701c,
    secondPte1: 0x0012_4001,
  });
  const protectedResult = protectedRange.context.resolveDataEffectiveRange(
    protectedRange.effective,
    0x30,
    0x10,
    [],
    protectedRange.segments,
    official.sdr1,
    true,
    true,
  );
  assert.equal(protectedResult.kind, "protection");
  assert.equal(protectedResult.faultEffective >>> 0, 0x00ff_b000);
  assert.equal(
    readPte1(protectedRange.context, protectedRange.first),
    0x0012_3002,
    "the preflighted first page must not gain partial history",
  );
  assert.equal(
    readPte1(protectedRange.context, protectedRange.second),
    0x0012_4101,
    "the matching denied PTE gains R but never C",
  );

  const missingRange = makeTwoPageContext({ installSecond: false });
  const missingResult = missingRange.context.resolveDataEffectiveRange(
    missingRange.effective,
    0x30,
    0x10,
    [],
    missingRange.segments,
    official.sdr1,
    true,
    true,
  );
  assert.equal(missingResult.kind, "page-fault");
  assert.equal(missingResult.faultEffective >>> 0, 0x00ff_b000);
  assert.equal(
    readPte1(missingRange.context, missingRange.first),
    0x0012_3002,
    "a later page miss must not commit history to preflighted pages",
  );
});

test("numeric data range wrapper splits at 4 KiB and preserves probe semantics", () => {
  const probe = makeTwoPageContext();
  assert.equal(
    probe.context.translateDataEffectiveRange(
      probe.effective,
      0x30,
      0x10,
      [],
      false,
      probe.segments,
      official.sdr1,
      false,
    ),
    0x0012_3ff0,
  );
  assert.equal(readPte1(probe.context, probe.first), 0x0012_3002);
  assert.equal(readPte1(probe.context, probe.second), 0x0012_4002);

  const actual = makeTwoPageContext();
  assert.equal(
    actual.context.translateDataEffectiveRange(
      actual.effective,
      0x30,
      0x10,
      [],
      false,
      actual.segments,
      official.sdr1,
      true,
    ),
    0x0012_3ff0,
  );
  assert.equal(readPte1(actual.context, actual.first), 0x0012_3102);
  assert.equal(readPte1(actual.context, actual.second), 0x0012_4102);

  assert.equal(
    actual.context.resolveDataEffectiveRange(
      0xffff_fff0,
      0x20,
      0x10,
      [],
      actual.segments,
      official.sdr1,
    ).kind,
    "invalid-range",
  );
});

test("runtime data wrappers read current MSR, DBAT, segment, and SDR1 state", () => {
  const addressContext = makeContext();
  const addressSegments = Array(16).fill(0);
  addressSegments[0] = 0x00ca_701c;
  writeRuntimeTranslationState(addressContext, {
    msr: 0x10,
    sdr1: official.sdr1,
    segments: addressSegments,
  });
  const addressPte = installPrimaryPte(
    addressContext,
    official.effective,
    addressSegments[0],
    official.sdr1,
    0x0012_3002,
  );

  assert.equal(
    addressContext.translateDataAddress(official.effective),
    0x0012_301b,
  );
  assert.equal(
    readPte1(addressContext, addressPte),
    0x0012_3002,
    "runtime wrapper defaults to a non-touching probe",
  );
  assert.equal(
    addressContext.translateDataAddress(official.effective, false, true),
    0x0012_301b,
  );
  assert.equal(readPte1(addressContext, addressPte), 0x0012_3102);
  assert.equal(
    addressContext.translateDataAddress(official.effective, true, true),
    0x0012_301b,
  );
  assert.equal(readPte1(addressContext, addressPte), 0x0012_3182);

  const range = makeTwoPageContext();
  writeRuntimeTranslationState(range.context, {
    msr: 0x10,
    sdr1: official.sdr1,
    segments: range.segments,
  });
  assert.equal(
    range.context.translateDataRange(range.effective, 0x30, true),
    0x0012_3ff0,
  );
  assert.equal(readPte1(range.context, range.first), 0x0012_3002);
  assert.equal(readPte1(range.context, range.second), 0x0012_4002);
  assert.equal(
    range.context.translateDataRange(range.effective, 0x30, true, true),
    0x0012_3ff0,
  );
  assert.equal(readPte1(range.context, range.first), 0x0012_3182);
  assert.equal(readPte1(range.context, range.second), 0x0012_4182);

  writeDataBat(range.context, 0, 0x9000_0003, 0x0002_0002);
  assert.equal(range.context.translateDataAddress(0x9000_1234), 0x0002_1234);
});

test("effective guest probes leave hashed-page history and DTLB state untouched", () => {
  const context = makeContext();
  const effective = 0x7fdb_e4c0;
  const physical = 0x0012_3000;
  const segment = 0x0012_3456;
  const segments = Array(16).fill(0);
  segments[effective >>> 28] = segment;
  writeRuntimeTranslationState(context, {
    msr: 0x10,
    sdr1: official.sdr1,
    segments,
  });
  const installed = installPrimaryPte(
    context,
    effective,
    segment,
    official.sdr1,
    physical | 2,
  );
  const set = context.dataTlbSets[context.dataTlbSetIndex(effective)];
  set.lru = 1;
  context.memory.clearAccesses();

  assert.equal(
    context.guestEffectivePointer(effective, 16),
    context.ram + physical + (effective & 0xfff),
  );
  assert.equal(
    readPte1(context, installed),
    physical | 2,
    "a diagnostic probe must not set referenced or changed",
  );
  assert.deepEqual(
    set.entries,
    [null, null],
    "a diagnostic probe must not fill the DTLB",
  );
  assert.equal(set.lru, 1, "a diagnostic probe must not touch replacement order");
  assert.deepEqual(
    context.memory.accesses.filter(
      access => access.kind === "write32"
        && access.address === installed.pointer + 4,
    ),
    [],
  );
});
