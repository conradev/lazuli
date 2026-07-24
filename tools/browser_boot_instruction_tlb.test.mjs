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

const tlbFunctions = [
  "batAllowsAccess",
  "resolveInstructionEffectiveAddress",
  "instructionTlbSetIndex",
  "lookupInstructionTlb",
  "fillInstructionTlb",
  "resolveInstructionTlbEntry",
  "resolveInstructionPageAddress",
  "captureInstructionPageDependencies",
  "validateInstructionPageDependencies",
  "blockHasInstructionPageDependencies",
  "regionHasInstructionPageDependencies",
  "compiledRegionIsExecutable",
  "invalidateCompiledBlock",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "instructionRangeTouchesTlbSet",
  "invalidateInstructionTranslationSet",
  "invalidateTranslationLookasideBuffer",
  "synchronizeTranslationLookasideBuffer",
];
const missingFunctions = tlbFunctions.filter(name =>
  !source.includes(`function ${name}(`)
);
const runtimeTest = missingFunctions.length === 0 ? test : test.skip;

function createTlbSets() {
  return Array.from(
    { length: 64 },
    () => ({ entries: [null, null], lru: 0 }),
  );
}

function makeContext({
  diagnostics = [],
  ramSize = 0x10_0000,
} = {}) {
  const ram = 0x4_0000;
  const buffer = new ArrayBuffer(ram + ramSize + 0x1_0000);
  const context = {
    accelerations: new Map(diagnostics),
    blocks: new Map(),
    bytes: new Uint8Array(buffer),
    dataTlbSets: createTlbSets(),
    instructionAddressSpaceKey: "current",
    instructionFetchOverride: null,
    instructionMsr: 0x20,
    instructionSdr1: 0,
    instructionSegmentRegisters: Array(16).fill(0),
    instructionTlbSets: createTlbSets(),
    linkingResets: 0,
    mmioSize: 0,
    physicalMmioBase: 0x0c00_0000,
    ram,
    ramSize,
    regionsByPc: new Map(),
    compiledBlock(effectivePc) {
      return context.blocks.get(blockKey(
        context.instructionAddressSpaceKey,
        effectivePc,
      ));
    },
    resolveInstructionFetch(effective, size, updateReferenced) {
      if (context.instructionFetchOverride !== null) {
        return context.instructionFetchOverride(
          effective >>> 0,
          size,
          updateReferenced,
        );
      }
      if (size !== 4 || (effective & 3) !== 0) {
        return { kind: "invalid-range", effective: effective >>> 0 };
      }
      return context.resolveInstructionPageAddress(
        effective,
        context.instructionMsr,
        context.instructionSegmentRegisters,
        context.instructionSdr1,
        updateReferenced,
      );
    },
    resetInstructionLinkingState() {
      context.linkingResets += 1;
    },
    view: new DataView(buffer),
  };
  vm.createContext(context);
  if (missingFunctions.length === 0) {
    vm.runInContext(
      tlbFunctions.map(extractFunction).join("\n\n"),
      context,
      { filename: "browser_boot.instruction-tlb.js" },
    );
  }
  return context;
}

function blockKey(namespace, effectiveStart) {
  return namespace
    + ":"
    + (effectiveStart >>> 0).toString(16).padStart(8, "0");
}

function addBlock(context, id, {
  namespace = "current",
  effectiveStart,
  effectiveBytes = 4,
  physicalStart = null,
  instructionPageDependencies = [],
} = {}) {
  const block = {
    id,
    effectiveStart: effectiveStart >>> 0,
    effectiveBytes,
    instructionAddressSpaceKey: namespace,
    instructionPageDependencies,
    physicalStart,
    physicalBytes: physicalStart === null ? 0 : effectiveBytes,
  };
  context.blocks.set(blockKey(namespace, effectiveStart), block);
  return block;
}

function remainingBlockIds(context) {
  return [...context.blocks.values()].map(block => block.id).sort();
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
    pte0: (0x8000_0000 | (vsid << 7) | api) >>> 0,
  };
}

function writePrimaryPte(context, effective, segment, sdr1, pte1) {
  const vector = pageTableVector(effective, segment, sdr1);
  const pointer = context.ram + vector.primary;
  context.view.setUint32(pointer, vector.pte0, false);
  context.view.setUint32(pointer + 4, pte1 >>> 0, false);
  return pointer;
}

function installHashedMapping(
  context,
  effective,
  pte1,
  segment = 0x0012_3456,
) {
  context.instructionSegmentRegisters[effective >>> 28] = segment;
  return writePrimaryPte(
    context,
    effective,
    segment,
    context.instructionSdr1,
    pte1,
  );
}

test("browser runtime exposes the tlbie set invalidation contract", () => {
  assert.deepEqual(missingFunctions, []);
  assert.match(
    source,
    /user_0_25:\s*\(_ctx,\s*address\)\s*=>\s*invalidateTranslationLookasideBuffer\(address\)/,
  );
  assert.match(
    source,
    /user_0_26:\s*\(\)\s*=>\s*synchronizeTranslationLookasideBuffer\(\)/,
  );
  assert.match(
    source,
    /!validateInstructionPageDependencies\(block\.instructionPageDependencies\)[\s\S]{0,160}invalidateCompiledBlock\(block,\s*"pre-execution-validation"\)/,
    "retained blocks validate their hashed-page dependency before execution",
  );
  assert.match(
    source,
    /const retained = captureInstructionPageDependencies\(pc,\s*effectiveBytes\)[\s\S]{0,320}instructionPageDependencies:\s*retained\.dependencies/,
    "compiled blocks retain the pages fetched while staging their Wasm",
  );
  assert.match(
    source,
    /const region = retainedRegion !== undefined[\s\S]{0,120}compiledRegionIsExecutable\(retainedRegion\)/,
    "linked regions pass the dependency gate before execution",
  );
});

runtimeTest("instruction ranges use MPC750 EA[14..19] set indices across page boundaries", () => {
  const context = makeContext();
  const set = address => (address >>> 12) & 0x3f;

  for (const address of [0x8001_2000, 0x9005_2004, 0x0000_0000, 0xffff_f000]) {
    assert.equal(
      context.instructionTlbSetIndex(address),
      set(address),
    );
    assert.equal(
      context.instructionRangeTouchesTlbSet(address, 4, set(address)),
      true,
    );
  }

  assert.equal(
    context.instructionRangeTouchesTlbSet(0x8001_1ff0, 0x30, 0x11),
    true,
  );
  assert.equal(
    context.instructionRangeTouchesTlbSet(0x8001_1ff0, 0x30, 0x12),
    true,
  );
  assert.equal(
    context.instructionRangeTouchesTlbSet(0x8001_1ff0, 0x30, 0x13),
    false,
  );
  assert.equal(
    context.instructionRangeTouchesTlbSet(0xffff_fff0, 0x20, 0x3f),
    true,
  );
  assert.equal(
    context.instructionRangeTouchesTlbSet(0xffff_fff0, 0x20, 0x00),
    true,
  );
  assert.equal(context.instructionRangeTouchesTlbSet(0x8001_2000, 0, 0x12), false);
});

runtimeTest("the two-way ITLB prefers invalid ways and replaces the touched set's LRU way", () => {
  const context = makeContext();
  const first = 0x8001_2000;
  const second = first + 0x4_0000;
  const third = second + 0x4_0000;
  const vsid = 0x123456;
  const entry = physicalPage => ({
    pte1: physicalPage | 2,
    ptePhysical: physicalPage >>> 1,
    secondary: false,
    slot: 0,
  });

  context.fillInstructionTlb(first, vsid, entry(0x0010_0000));
  context.fillInstructionTlb(second, vsid, entry(0x0020_0000));
  assert.notEqual(context.lookupInstructionTlb(first, vsid, true), null);
  assert.notEqual(context.lookupInstructionTlb(second, vsid), null);

  context.fillInstructionTlb(third, vsid, entry(0x0030_0000));

  assert.notEqual(context.lookupInstructionTlb(first, vsid), null);
  assert.equal(context.lookupInstructionTlb(second, vsid), null);
  assert.notEqual(context.lookupInstructionTlb(third, vsid), null);
  assert.equal(
    context.lookupInstructionTlb(first, vsid ^ 1),
    null,
    "a matching EA page with a different VSID is not a hit",
  );
});

runtimeTest("a page-table fill stores the architecturally updated R bit in the ITLB entry", () => {
  const context = makeContext();
  const effective = 0x8001_2000;
  const segment = 0x0012_3456;
  const segments = Array(16).fill(0);
  const sdr1 = 0;
  segments[effective >>> 28] = segment;
  const ptePointer = writePrimaryPte(
    context,
    effective,
    segment,
    sdr1,
    0x0008_0002,
  );

  const resolved = context.resolveInstructionPageAddress(
    effective,
    0x20,
    segments,
    sdr1,
    true,
  );
  const cached = context.lookupInstructionTlb(
    effective,
    segment & 0x00ff_ffff,
  );

  assert.equal(resolved.kind, "mapped");
  assert.equal(context.view.getUint32(ptePointer + 4, false) & 0x100, 0x100);
  assert.notEqual(cached, null);
  assert.equal(cached.pte1 & 0x100, 0x100);
});

runtimeTest("an evicted compiled-page dependency refills and rejects a changed PTE before execution", () => {
  const context = makeContext();
  const first = 0x8001_2000;
  const second = first + 0x4_0000;
  const third = second + 0x4_0000;
  assert.equal(context.instructionTlbSetIndex(first), 0x12);
  assert.equal(context.instructionTlbSetIndex(second), 0x12);
  assert.equal(context.instructionTlbSetIndex(third), 0x12);

  const firstPte = installHashedMapping(context, first, 0x0008_0002);
  installHashedMapping(context, second, 0x0009_0002);
  installHashedMapping(context, third, 0x000a_0002);
  const firstRetained = context.captureInstructionPageDependencies(first, 4);
  const secondRetained = context.captureInstructionPageDependencies(second, 4);
  assert.equal(firstRetained.fault, null);
  assert.equal(firstRetained.dependencies.length, 1);
  assert.equal(firstRetained.dependencies[0].effective >>> 0, first);
  assert.equal(firstRetained.dependencies[0].physical >>> 0, 0x0008_0000);
  assert.equal(secondRetained.fault, null);
  const firstBlock = addBlock(context, "compiled-first", {
    effectiveStart: first,
    physicalStart: 0x0008_0000,
    instructionPageDependencies: firstRetained.dependencies,
  });
  addBlock(context, "compiled-second", {
    effectiveStart: second,
    physicalStart: 0x0009_0000,
    instructionPageDependencies: secondRetained.dependencies,
  });

  // The page-table edit remains hidden until the old way is replaced.
  context.view.setUint32(firstPte + 4, 0x000b_0002, false);
  const thirdRetained = context.captureInstructionPageDependencies(third, 4);
  assert.equal(thirdRetained.fault, null);
  assert.equal(
    context.lookupInstructionTlb(first, 0x0012_3456),
    null,
    "the third same-set fill replaces the untouched first way",
  );

  const valid = context.validateInstructionPageDependencies(
    firstBlock.instructionPageDependencies,
  );
  assert.equal(valid, false, "the refill observes the changed physical page");
  assert.equal(
    context.invalidateCompiledBlock(firstBlock, "pre-execution-validation"),
    true,
  );
  assert.deepEqual(remainingBlockIds(context), ["compiled-second"]);
  const refilled = context.lookupInstructionTlb(first, 0x0012_3456);
  assert.notEqual(refilled, null);
  assert.equal(refilled.pte1 & 0xffff_f000, 0x000b_0000);
  assert.equal(refilled.pte1 & 0x100, 0x100);
  assert.equal(context.view.getUint32(firstPte + 4, false) & 0x100, 0x100);
  assert.deepEqual(Object.fromEntries(context.accelerations), {
    instructionTranslationDependencyInvalidations: 1,
    instructionTranslationDependencyInvalidatedRegions: 0,
    "instructionTranslationDependencyInvalidationReason:pre-execution-validation": 1,
  });
});

runtimeTest("retained block validation touches its ITLB way before replacement", () => {
  const context = makeContext();
  const first = 0x8001_2000;
  const second = first + 0x4_0000;
  const third = second + 0x4_0000;
  installHashedMapping(context, first, 0x0008_0002);
  installHashedMapping(context, second, 0x0009_0002);
  installHashedMapping(context, third, 0x000a_0002);

  const firstRetained = context.captureInstructionPageDependencies(first, 4);
  context.captureInstructionPageDependencies(second, 4);
  const set = context.instructionTlbSets[0x12];
  assert.equal(context.lookupInstructionTlb(first, 0x0012_3456).way, 0);
  assert.equal(context.lookupInstructionTlb(second, 0x0012_3456).way, 1);
  assert.equal(set.lru, 0);

  assert.equal(
    context.validateInstructionPageDependencies(firstRetained.dependencies),
    true,
  );
  assert.equal(set.lru, 1, "the retained first block touches way zero");
  context.captureInstructionPageDependencies(third, 4);

  assert.notEqual(context.lookupInstructionTlb(first, 0x0012_3456), null);
  assert.equal(context.lookupInstructionTlb(second, 0x0012_3456), null);
  assert.notEqual(context.lookupInstructionTlb(third, 0x0012_3456), null);
});

runtimeTest("real-mode and IBAT blocks retain no hashed-TLB dependency", () => {
  const context = makeContext();
  const effective = 0x8000_2000;
  const cases = [
    {
      name: "real mode",
      resolve: address => context.resolveInstructionEffectiveAddress(address, 0, []),
      physical: effective,
    },
    {
      name: "IBAT",
      resolve: address => context.resolveInstructionEffectiveAddress(
        address,
        0x20,
        [[0x8000_0002, 0x0008_0002]],
      ),
      physical: 0x0008_2000,
    },
  ];

  for (const { name, resolve, physical } of cases) {
    context.instructionFetchOverride = (address, size, updateReferenced) => {
      assert.equal(size, 4);
      assert.equal(updateReferenced, true);
      return resolve(address);
    };
    const retained = context.captureInstructionPageDependencies(effective, 4);
    assert.equal(retained.fault, null, name);
    assert.equal(retained.dependencies.length, 0, name);
    assert.equal(context.validateInstructionPageDependencies(retained.dependencies), true);
    assert.equal(
      context.blockHasInstructionPageDependencies({
        instructionPageDependencies: retained.dependencies,
      }),
      false,
    );
    assert.equal(resolve(effective).physical >>> 0, physical, name);
  }
  assert.equal(
    context.instructionTlbSets.every(set => set.entries.every(entry => entry === null)),
    true,
  );
});

runtimeTest("linked regions conservatively reject every hashed-page member", () => {
  const context = makeContext();
  const hashedPc = 0x8001_2000;
  const plainPc = 0x8001_3000;
  addBlock(context, "hashed", {
    effectiveStart: hashedPc,
    instructionPageDependencies: [{
      effective: hashedPc,
      physical: 0x0008_0000,
    }],
  });
  addBlock(context, "plain", {
    effectiveStart: plainPc,
    instructionPageDependencies: [],
  });
  const region = {
    instructionAddressSpaceKey: "current",
    pcs: [plainPc, hashedPc],
  };
  context.instructionFetchOverride = () => {
    assert.fail("a rejected hashed region must not prevalidate all members");
  };

  assert.equal(context.regionHasInstructionPageDependencies(region), true);
  assert.equal(context.compiledRegionIsExecutable(region), false);
});

runtimeTest("tlbsync preserves TLB residency and compiled code while recording synchronization", () => {
  const context = makeContext({
    diagnostics: [
      ["translationTlbSynchronizations", 3],
      ["unrelatedMetric", 7],
    ],
  });
  const effective = 0x8001_2000;
  const block = addBlock(context, "retained", {
    effectiveStart: effective,
    instructionPageDependencies: [{
      effective,
      physical: 0x0008_0000,
    }],
  });
  const region = {
    id: "retained-region",
    instructionAddressSpaceKey: "current",
    pcs: [effective],
  };
  context.regionsByPc.set(blockKey("current", effective), region);
  context.fillInstructionTlb(effective, 0x0012_3456, {
    pte1: 0x0008_0102,
    ptePhysical: 0x1000,
    secondary: false,
    slot: 0,
  });
  const setIndex = context.instructionTlbSetIndex(effective);
  const instructionEntry = context.instructionTlbSets[setIndex].entries[0];
  const dataEntry = { id: "data-resident" };
  context.dataTlbSets[setIndex].entries[1] = dataEntry;
  context.dataTlbSets[setIndex].lru = 1;

  assert.equal(context.synchronizeTranslationLookasideBuffer(), undefined);

  assert.equal(context.blocks.get(blockKey("current", effective)), block);
  assert.equal(context.regionsByPc.get(blockKey("current", effective)), region);
  assert.equal(context.instructionTlbSets[setIndex].entries[0], instructionEntry);
  assert.equal(context.dataTlbSets[setIndex].entries[1], dataEntry);
  assert.equal(context.instructionTlbSets[setIndex].lru, 1);
  assert.equal(context.dataTlbSets[setIndex].lru, 1);
  assert.equal(context.linkingResets, 0);
  assert.deepEqual(Object.fromEntries(context.accelerations), {
    translationTlbSynchronizations: 4,
    unrelatedMetric: 7,
  });
});

runtimeTest("tlbie set eviction spans retained namespaces and removes every stale region alias", () => {
  const context = makeContext({
    diagnostics: [
      ["instructionTlbInvalidations", 4],
      ["instructionTlbInvalidatedBlocks", 10],
      ["instructionTlbInvalidatedRegions", 2],
    ],
  });
  addBlock(context, "current-hit", {
    effectiveStart: 0x8001_2000,
    physicalStart: 0x0010_0000,
  });
  addBlock(context, "foreign-hit", {
    namespace: "foreign",
    effectiveStart: 0x9001_2000,
    physicalStart: 0x0020_0000,
  });
  addBlock(context, "spanning-hit", {
    namespace: "spanning",
    effectiveStart: 0xa001_1ff0,
    effectiveBytes: 0x40,
    physicalStart: 0x0030_0000,
  });
  addBlock(context, "region-peer", {
    namespace: "foreign",
    effectiveStart: 0x9001_3000,
    physicalStart: 0x0020_1000,
  });
  addBlock(context, "unrelated", {
    effectiveStart: 0x8001_3000,
    physicalStart: 0x0010_1000,
  });
  addBlock(context, "same-physical-other-set", {
    namespace: "alias",
    effectiveStart: 0xb001_3000,
    physicalStart: 0x0010_0000,
  });

  const staleRegion = {
    id: "stale",
    instructionAddressSpaceKey: "foreign",
    pcs: [0x9001_2000, 0x9001_3000],
  };
  const retainedRegion = {
    id: "retained",
    instructionAddressSpaceKey: "current",
    pcs: [0x8001_3000],
  };
  context.regionsByPc.set("foreign:90012000", staleRegion);
  context.regionsByPc.set("foreign:90013000", staleRegion);
  context.regionsByPc.set("current:80013000", retainedRegion);

  assert.equal(context.invalidateInstructionTranslationSet(0xdead_2004), 3);

  assert.deepEqual(remainingBlockIds(context), [
    "region-peer",
    "same-physical-other-set",
    "unrelated",
  ]);
  assert.deepEqual([...context.regionsByPc.keys()], ["current:80013000"]);
  assert.deepEqual([...new Set(context.regionsByPc.values())], [retainedRegion]);
  assert.equal(context.linkingResets, 1);
  assert.deepEqual(Object.fromEntries(context.accelerations), {
    instructionTlbInvalidations: 5,
    instructionTlbInvalidatedBlocks: 13,
    instructionTlbInvalidatedRegions: 3,
  });

  assert.equal(context.invalidateInstructionTranslationSet(0x8003_e000), 0);
  assert.equal(context.linkingResets, 1, "an empty set eviction does not reset linking");
  assert.deepEqual(Object.fromEntries(context.accelerations), {
    instructionTlbInvalidations: 6,
    instructionTlbInvalidatedBlocks: 13,
    instructionTlbInvalidatedRegions: 3,
  });
});

runtimeTest("tlbie clears both ways of the matching instruction and data TLB set only", () => {
  const context = makeContext();
  const effective = 0x8123_4000;
  const setIndex = (effective >>> 12) & 0x3f;
  const otherSet = (setIndex + 1) & 0x3f;
  context.fillInstructionTlb(effective, 0x123456, {
    pte1: 0x0010_0002,
    ptePhysical: 0x1000,
    secondary: false,
    slot: 0,
  });
  context.dataTlbSets[setIndex].entries = [{ id: "d0" }, { id: "d1" }];
  context.dataTlbSets[setIndex].lru = 1;
  context.instructionTlbSets[otherSet].entries[0] = { id: "instruction-retained" };
  context.dataTlbSets[otherSet].entries[0] = { id: "data-retained" };

  context.invalidateTranslationLookasideBuffer(effective);

  assert.deepEqual(context.instructionTlbSets[setIndex], {
    entries: [null, null],
    lru: 0,
  });
  assert.deepEqual(context.dataTlbSets[setIndex], {
    entries: [null, null],
    lru: 0,
  });
  assert.equal(
    context.instructionTlbSets[otherSet].entries[0].id,
    "instruction-retained",
  );
  assert.equal(context.dataTlbSets[otherSet].entries[0].id, "data-retained");
  assert.equal(context.linkingResets, 0);
  assert.deepEqual(Object.fromEntries(context.accelerations), {
    instructionTlbInvalidations: 1,
    instructionTlbInvalidatedBlocks: 0,
    instructionTlbInvalidatedRegions: 0,
    translationTlbInvalidations: 1,
    instructionTlbInvalidatedEntries: 1,
    dataTlbInvalidatedEntries: 2,
  });
});

runtimeTest("tlbie drops stale compiled code and forces a changed PTE through a fresh TLB fill", () => {
  const context = makeContext();
  const effective = 0x8001_2000;
  const segment = 0x0012_3456;
  const segments = Array(16).fill(0);
  const sdr1 = 0;
  segments[effective >>> 28] = segment;
  const ptePointer = writePrimaryPte(
    context,
    effective,
    segment,
    sdr1,
    0x0008_0002,
  );

  const first = context.resolveInstructionPageAddress(
    effective,
    0x20,
    segments,
    sdr1,
    true,
  );
  assert.equal(first.kind, "mapped");
  assert.equal(first.physical >>> 0, 0x0008_0000);
  assert.equal(first.tlbHit, false);
  assert.notEqual(
    context.lookupInstructionTlb(effective, segment & 0x00ff_ffff),
    null,
  );
  addBlock(context, "old-mapping", {
    namespace: "stable-sr-sdr1",
    effectiveStart: effective,
    physicalStart: 0x0008_0000,
  });

  context.view.setUint32(ptePointer + 4, 0x0009_0002, false);
  const stale = context.resolveInstructionPageAddress(
    effective,
    0x20,
    segments,
    sdr1,
    true,
  );
  assert.equal(stale.kind, "mapped");
  assert.equal(stale.physical >>> 0, 0x0008_0000);
  assert.equal(stale.tlbHit, true, "a PTE edit is hidden by the resident ITLB entry");

  context.invalidateTranslationLookasideBuffer(effective);

  assert.deepEqual(remainingBlockIds(context), []);
  assert.equal(
    context.lookupInstructionTlb(effective, segment & 0x00ff_ffff),
    null,
  );
  const fresh = context.resolveInstructionPageAddress(
    effective,
    0x20,
    segments,
    sdr1,
    true,
  );
  assert.equal(fresh.kind, "mapped");
  assert.equal(fresh.physical >>> 0, 0x0009_0000);
  assert.equal(fresh.tlbHit, false);
  assert.equal(context.linkingResets, 1);
});
