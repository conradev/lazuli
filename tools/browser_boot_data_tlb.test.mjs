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

const dataTlbFunctions = [
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
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "invalidateTranslationLookasideBuffer",
  "synchronizeTranslationLookasideBuffer",
];

function createTlbSets() {
  return Array.from(
    { length: 64 },
    () => ({ entries: [null, null], lru: 0 }),
  );
}

function makeContext({ diagnostics = [] } = {}) {
  const ram = 0x4_0000;
  const ramSize = 0x10_0000;
  const buffer = new ArrayBuffer(ram + ramSize + 0x1_0000);
  const context = {
    accelerations: new Map(diagnostics),
    bytes: new Uint8Array(buffer),
    dataTlbSets: createTlbSets(),
    instructionTlbSets: createTlbSets(),
    instructionTlbSetIndex: address => ((address >>> 12) & 0x3f) >>> 0,
    invalidateInstructionTranslationSet: () => 0,
    mmioSize: 0,
    physicalMmioBase: 0x0c00_0000,
    ram,
    ramSize,
    view: new DataView(buffer),
  };
  vm.createContext(context);
  vm.runInContext(
    dataTlbFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.data-tlb.js" },
  );
  return context;
}

function pageTableVector(effective, segment, sdr1 = 0) {
  const vsid = segment & 0x00ff_ffff;
  const pageIndex = (effective >>> 12) & 0xffff;
  const api = (effective >>> 22) & 0x3f;
  const primaryHash = ((vsid & 0x7ffff) ^ pageIndex) & 0x7ffff;
  const mask = 0x3ff | ((sdr1 & 0x1ff) << 10);
  const base = sdr1 & 0xffff_0000;
  return {
    primary: (base | ((primaryHash & mask) << 6)) >>> 0,
    pte0: (0x8000_0000 | (vsid << 7) | api) >>> 0,
  };
}

function writePrimaryPte(
  context,
  effective,
  segment,
  pte1,
  sdr1 = 0,
) {
  const vector = pageTableVector(effective, segment, sdr1);
  const pointer = context.ram + vector.primary;
  context.view.setUint32(pointer, vector.pte0, false);
  context.view.setUint32(pointer + 4, pte1 >>> 0, false);
  return { ...vector, pointer };
}

function readPte1(context, pte) {
  return context.view.getUint32(pte.pointer + 4, false);
}

function resolvePage(context, {
  effective,
  segment,
  msr = 0x10,
  sdr1 = 0,
  write = false,
  updateHistory = false,
}) {
  const segments = Array(16).fill(0);
  segments[effective >>> 28] = segment;
  return context.resolveDataPageAddress(
    effective,
    msr,
    segments,
    sdr1,
    write,
    updateHistory,
  );
}

const first = 0x8001_2000;
const second = first + 0x4_0000;
const third = second + 0x4_0000;
const segment = 0x0012_3456;
const vsid = segment & 0x00ff_ffff;

test("data TLB fixture exposes the complete 64-set, two-way contract", () => {
  assert.deepEqual(
    dataTlbFunctions.filter(name => !source.includes(`function ${name}(`)),
    [],
  );
  const context = makeContext();
  assert.equal(context.dataTlbSets.length, 64);
  assert.ok(context.dataTlbSets.every(set => set.entries.length === 2));
  for (const address of [
    0x0000_0000,
    0x8001_2000,
    0x9005_2004,
    0xffff_f000,
  ]) {
    assert.equal(
      context.dataTlbSetIndex(address),
      (address >>> 12) & 0x3f,
    );
  }
  assert.equal(context.dataTlbSetIndex(first), context.dataTlbSetIndex(second));
  assert.equal(context.dataTlbSetIndex(second), context.dataTlbSetIndex(third));
});

test("DTLB fills invalid ways first and evicts the true LRU exact tag", () => {
  const context = makeContext();
  const entry = physicalPage => ({
    pte0: 0x8000_0000,
    pte1: physicalPage | 2,
    ptePhysical: physicalPage >>> 1,
    ptePointer: context.ram + (physicalPage >>> 1),
    secondary: false,
    slot: 0,
  });
  const set = context.dataTlbSets[context.dataTlbSetIndex(first)];
  set.lru = 1;

  const firstFill = context.fillDataTlb(first, vsid, entry(0x0008_0000));
  const secondFill = context.fillDataTlb(second, vsid, entry(0x0009_0000));
  assert.equal(firstFill.way, 0, "the first invalid way wins over the LRU hint");
  assert.equal(secondFill.way, 1, "the remaining invalid way fills before eviction");
  assert.equal(set.lru, 0);

  assert.equal(context.lookupDataTlb(first, vsid, false).way, 0);
  assert.equal(set.lru, 0, "a non-touching lookup preserves LRU");
  assert.equal(context.lookupDataTlb(first, vsid, true).way, 0);
  assert.equal(set.lru, 1);
  context.fillDataTlb(third, vsid, entry(0x000a_0000));

  assert.notEqual(context.lookupDataTlb(first, vsid), null);
  assert.equal(context.lookupDataTlb(second, vsid), null);
  assert.notEqual(context.lookupDataTlb(third, vsid), null);
  assert.equal(context.lookupDataTlb(first, vsid ^ 1), null);
  assert.equal(
    context.lookupDataTlb(first + 0x4_0000, vsid),
    null,
    "the full effective page tag participates in lookup",
  );
});

test("page probes neither fill nor touch while actual accesses fill and touch", () => {
  const context = makeContext();
  const firstPte = writePrimaryPte(
    context,
    first,
    segment,
    0x0008_0002,
  );
  const secondPte = writePrimaryPte(
    context,
    second,
    segment,
    0x0009_0002,
  );
  const thirdPte = writePrimaryPte(
    context,
    third,
    segment,
    0x000a_0002,
  );
  const set = context.dataTlbSets[context.dataTlbSetIndex(first)];

  const firstProbe = resolvePage(context, { effective: first, segment });
  assert.equal(firstProbe.kind, "mapped");
  assert.equal(firstProbe.tlbHit, false);
  assert.deepEqual(set.entries, [null, null]);
  assert.equal(readPte1(context, firstPte), 0x0008_0002);

  const firstActual = resolvePage(context, {
    effective: first,
    segment,
    updateHistory: true,
  });
  assert.equal(firstActual.kind, "mapped");
  assert.equal(firstActual.tlbHit, false);
  assert.equal(readPte1(context, firstPte), 0x0008_0102);
  assert.notEqual(context.lookupDataTlb(first, vsid), null);

  resolvePage(context, {
    effective: second,
    segment,
    updateHistory: true,
  });
  assert.equal(readPte1(context, secondPte), 0x0009_0102);
  assert.equal(set.lru, 0);

  const hitProbe = resolvePage(context, { effective: first, segment });
  assert.equal(hitProbe.tlbHit, true);
  assert.equal(set.lru, 0, "a resident probe does not touch its way");
  const missProbe = resolvePage(context, { effective: third, segment });
  assert.equal(missProbe.tlbHit, false);
  assert.equal(set.lru, 0);
  assert.equal(readPte1(context, thirdPte), 0x000a_0002);
  assert.equal(context.lookupDataTlb(third, vsid), null);

  const hitActual = resolvePage(context, {
    effective: first,
    segment,
    updateHistory: true,
  });
  assert.equal(hitActual.tlbHit, true);
  assert.equal(set.lru, 1, "an actual resident access touches its way");
});

test("resident V, RPN, PP, and WIMG remain stale until tlbie", () => {
  const context = makeContext();
  const pte = writePrimaryPte(context, first, segment, 0x0008_0042);
  const initial = resolvePage(context, {
    effective: first,
    segment,
    updateHistory: true,
  });
  assert.equal(initial.kind, "mapped");
  assert.equal(initial.physical >>> 0, 0x0008_0000);
  assert.equal(initial.wimg, 8);
  assert.equal(initial.protection, 2);

  context.view.setUint32(pte.pointer, pte.pte0 & 0x7fff_ffff, false);
  context.view.setUint32(pte.pointer + 4, 0x0009_0073, false);
  const stale = resolvePage(context, {
    effective: first,
    segment,
    updateHistory: true,
  });
  assert.equal(stale.kind, "mapped");
  assert.equal(stale.tlbHit, true);
  assert.equal(stale.physical >>> 0, 0x0008_0000);
  assert.equal(stale.wimg, 8);
  assert.equal(stale.protection, 2);

  context.invalidateTranslationLookasideBuffer(first);
  const invalid = resolvePage(context, {
    effective: first,
    segment,
    updateHistory: true,
  });
  assert.equal(invalid.kind, "page-fault", "tlbie exposes the cleared V bit");

  context.view.setUint32(pte.pointer, pte.pte0, false);
  const fresh = resolvePage(context, {
    effective: first,
    segment,
    write: true,
    updateHistory: true,
  });
  assert.equal(fresh.kind, "protection");
  assert.equal(fresh.tlbHit, false);
  assert.equal(fresh.physical >>> 0, 0x0009_0000);
  assert.equal(fresh.wimg, 14);
  assert.equal(fresh.protection, 3);
});

test("current key is reevaluated while VSID and SDR1 select resident identity", () => {
  const context = makeContext();
  const keyedSegment = 0x2012_3456;
  writePrimaryPte(context, first, keyedSegment, 0x0008_0000);
  const supervisor = resolvePage(context, {
    effective: first,
    segment: keyedSegment,
    msr: 0x10,
    updateHistory: true,
  });
  assert.equal(supervisor.kind, "mapped");
  assert.equal(supervisor.key, 0);

  const user = resolvePage(context, {
    effective: first,
    segment: keyedSegment,
    msr: 0x4010,
    updateHistory: true,
  });
  assert.equal(user.kind, "protection");
  assert.equal(user.tlbHit, true);
  assert.equal(user.key, 1);

  const changedSdr1 = resolvePage(context, {
    effective: first,
    segment: keyedSegment,
    msr: 0x10,
    sdr1: 0x0001_0000,
    updateHistory: true,
  });
  assert.equal(changedSdr1.kind, "mapped");
  assert.equal(changedSdr1.tlbHit, true);

  const changedSegment = 0x2012_3457;
  writePrimaryPte(context, first, changedSegment, 0x0009_0002);
  const differentVsid = resolvePage(context, {
    effective: first,
    segment: changedSegment,
    msr: 0x10,
    updateHistory: true,
  });
  assert.equal(differentVsid.kind, "mapped");
  assert.equal(differentVsid.tlbHit, false);
  assert.equal(differentVsid.physical >>> 0, 0x0009_0000);

  const restored = resolvePage(context, {
    effective: first,
    segment: keyedSegment,
    msr: 0x10,
    updateHistory: true,
  });
  assert.equal(restored.kind, "mapped");
  assert.equal(restored.tlbHit, true);
  assert.equal(restored.physical >>> 0, 0x0008_0000);
});

test("resident C=0 store updates cached and backing history without adopting PTE edits", () => {
  const context = makeContext();
  const pte = writePrimaryPte(context, first, segment, 0x0008_0002);
  resolvePage(context, {
    effective: first,
    segment,
    updateHistory: true,
  });
  const before = context.lookupDataTlb(first, vsid);
  assert.equal(before.pte1 >>> 0, 0x0008_0102);

  const externalPte1 = 0x0009_0153;
  context.view.setUint32(pte.pointer + 4, externalPte1, false);
  const stored = resolvePage(context, {
    effective: first,
    segment,
    write: true,
    updateHistory: true,
  });
  assert.equal(stored.kind, "mapped");
  assert.equal(stored.tlbHit, true);
  assert.equal(stored.physical >>> 0, 0x0008_0000);
  assert.equal(stored.protection, 2);
  assert.equal(stored.wimg, 0);
  assert.equal(readPte1(context, pte), 0x0009_01d3);

  const cached = context.lookupDataTlb(first, vsid);
  assert.equal(cached.pte1 >>> 0, 0x0008_0182);
  assert.equal(cached.pte1 & 0xffff_f000, 0x0008_0000);
  assert.equal(cached.pte1 & 3, 2);
  assert.equal((cached.pte1 >>> 3) & 0xf, 0);
});

test("resident R/C bits are not redundantly repaired in the backing PTE", () => {
  const context = makeContext();
  const pte = writePrimaryPte(context, first, segment, 0x0008_0002);
  resolvePage(context, {
    effective: first,
    segment,
    write: true,
    updateHistory: true,
  });
  assert.equal(readPte1(context, pte), 0x0008_0182);
  assert.equal(
    context.lookupDataTlb(first, vsid).pte1 >>> 0,
    0x0008_0182,
  );

  context.view.setUint32(pte.pointer + 4, 0x0008_0002, false);
  const hit = resolvePage(context, {
    effective: first,
    segment,
    write: true,
    updateHistory: true,
  });
  assert.equal(hit.kind, "mapped");
  assert.equal(hit.tlbHit, true);
  assert.equal(
    readPte1(context, pte),
    0x0008_0002,
    "cached R/C suppress a redundant backing-table write",
  );
});

test("a protection fill sets R only and retains the denied translation", () => {
  const context = makeContext();
  const protectedSegment = 0x4012_3456;
  const pte = writePrimaryPte(
    context,
    first,
    protectedSegment,
    0x0008_0001,
  );
  const probe = resolvePage(context, {
    effective: first,
    segment: protectedSegment,
    write: true,
  });
  assert.equal(probe.kind, "protection");
  assert.equal(readPte1(context, pte), 0x0008_0001);
  assert.equal(
    context.lookupDataTlb(first, protectedSegment & 0x00ff_ffff),
    null,
  );

  const denied = resolvePage(context, {
    effective: first,
    segment: protectedSegment,
    write: true,
    updateHistory: true,
  });
  assert.equal(denied.kind, "protection");
  assert.equal(denied.tlbHit, false);
  assert.equal(readPte1(context, pte), 0x0008_0101);
  const cached = context.lookupDataTlb(
    first,
    protectedSegment & 0x00ff_ffff,
  );
  assert.notEqual(cached, null);
  assert.equal(cached.pte1 & 0x180, 0x100);
});

test("range preflight commits DTLB and history only after every page succeeds", () => {
  const crossPage = 0x8001_2ff0;
  const nextPage = crossPage + 0x10;
  const segments = Array(16).fill(0);
  segments[crossPage >>> 28] = segment;

  const failedContext = makeContext();
  const failedFirst = writePrimaryPte(
    failedContext,
    crossPage,
    segment,
    0x0008_0002,
  );
  const failed = failedContext.resolveDataEffectiveRange(
    crossPage,
    0x30,
    0x10,
    [],
    segments,
    0,
    true,
    true,
  );
  assert.equal(failed.kind, "page-fault");
  assert.equal(readPte1(failedContext, failedFirst), 0x0008_0002);
  assert.equal(failedContext.lookupDataTlb(crossPage, vsid), null);

  const mappedContext = makeContext();
  const mappedFirst = writePrimaryPte(
    mappedContext,
    crossPage,
    segment,
    0x0008_0002,
  );
  const mappedSecond = writePrimaryPte(
    mappedContext,
    nextPage,
    segment,
    0x0008_1002,
  );
  const mapped = mappedContext.resolveDataEffectiveRange(
    crossPage,
    0x30,
    0x10,
    [],
    segments,
    0,
    true,
    true,
  );
  assert.equal(mapped.kind, "mapped");
  assert.equal(mapped.physical >>> 0, 0x0008_0ff0);
  assert.equal(readPte1(mappedContext, mappedFirst), 0x0008_0182);
  assert.equal(readPte1(mappedContext, mappedSecond), 0x0008_1182);
  assert.notEqual(mappedContext.lookupDataTlb(crossPage, vsid), null);
  assert.notEqual(mappedContext.lookupDataTlb(nextPage, vsid), null);
});

test("tlbsync preserves residency and tlbie clears both ways of both TLBs", () => {
  const context = makeContext({
    diagnostics: [["translationTlbSynchronizations", 2]],
  });
  const setIndex = context.dataTlbSetIndex(first);
  const otherSet = (setIndex + 1) & 0x3f;
  context.dataTlbSets[setIndex].entries = [{ id: "d0" }, { id: "d1" }];
  context.dataTlbSets[setIndex].lru = 1;
  context.instructionTlbSets[setIndex].entries = [{ id: "i0" }, { id: "i1" }];
  context.instructionTlbSets[setIndex].lru = 1;
  context.dataTlbSets[otherSet].entries[0] = { id: "data-retained" };
  context.instructionTlbSets[otherSet].entries[0] = {
    id: "instruction-retained",
  };

  assert.equal(context.synchronizeTranslationLookasideBuffer(), undefined);
  assert.deepEqual(context.dataTlbSets[setIndex].entries, [
    { id: "d0" },
    { id: "d1" },
  ]);
  assert.deepEqual(context.instructionTlbSets[setIndex].entries, [
    { id: "i0" },
    { id: "i1" },
  ]);
  assert.equal(context.dataTlbSets[setIndex].lru, 1);
  assert.equal(context.instructionTlbSets[setIndex].lru, 1);
  assert.equal(context.accelerations.get("translationTlbSynchronizations"), 3);

  context.invalidateTranslationLookasideBuffer(first);
  assert.deepEqual(context.dataTlbSets[setIndex], {
    entries: [null, null],
    lru: 0,
  });
  assert.deepEqual(context.instructionTlbSets[setIndex], {
    entries: [null, null],
    lru: 0,
  });
  assert.equal(context.dataTlbSets[otherSet].entries[0].id, "data-retained");
  assert.equal(
    context.instructionTlbSets[otherSet].entries[0].id,
    "instruction-retained",
  );
  assert.equal(context.accelerations.get("dataTlbInvalidatedEntries"), 2);
  assert.equal(context.accelerations.get("instructionTlbInvalidatedEntries"), 2);
});
