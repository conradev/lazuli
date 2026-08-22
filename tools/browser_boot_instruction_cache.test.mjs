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

const invalidationFunctions = [
  "instructionRangesOverlap",
  "mapInstructionPhysicalRanges",
  "invalidateInstructionCacheRange",
  "invalidateInstructionCacheLine",
  "synchronizeInstructionStream",
];

function makeInvalidationContext(translateInstructionRange) {
  const context = {
    accelerations: new Map(),
    blocks: new Map(),
    instructionAddressSpaceKey: "current",
    instructionDependencyFreeLinkedRegions: new WeakSet(),
    linkingResets: 0,
    regionsByPc: new Map(),
    resetInstructionLinkingState() {
      context.linkingResets += 1;
    },
    translateInstructionRange,
  };
  vm.createContext(context);
  vm.runInContext(
    invalidationFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.instruction-cache.js" },
  );
  return context;
}

function addBlock(context, id, {
  namespace = "current",
  effectiveStart,
  effectiveBytes = 0x20,
  physicalStart = null,
  physicalBytes = physicalStart === null ? 0 : effectiveBytes,
  physicalRanges,
}) {
  const block = {
    id,
    effectiveStart: effectiveStart >>> 0,
    effectiveBytes,
    physicalStart,
    physicalBytes,
    instructionAddressSpaceKey: namespace,
  };
  if (physicalRanges !== undefined) block.physicalRanges = physicalRanges;
  const key = namespace
    + ":"
    + (effectiveStart >>> 0).toString(16).padStart(8, "0");
  context.blocks.set(key, block);
  return block;
}

function remainingBlockIds(context) {
  return [...context.blocks.values()].map(block => block.id).sort();
}

test("instruction range overlap uses half-open byte spans", () => {
  const context = makeInvalidationContext(() => null);

  assert.equal(context.instructionRangesOverlap(0x1000, 0x20, 0x1010, 0x20), true);
  assert.equal(context.instructionRangesOverlap(0x1000, 0x20, 0x1000, 0x20), true);
  assert.equal(context.instructionRangesOverlap(0x1000, 0x20, 0x1020, 0x20), false);
  assert.equal(context.instructionRangesOverlap(0x1020, 0x20, 0x1000, 0x20), false);
  assert.equal(context.instructionRangesOverlap(0x1000, 0, 0x1000, 0x20), false);
  assert.equal(context.instructionRangesOverlap(0xfffffff0, 0x20, 0, 0x10), true);
  assert.equal(context.instructionRangesOverlap(0xfffffff0, 0x10, 0, 0x10), false);
});

test("compiled instruction spans retain noncontiguous physical mappings", () => {
  const context = makeInvalidationContext((effectiveStart, byteCount) => {
    assert.equal(byteCount, 4);
    if (effectiveStart < 0x90020000) {
      return 0x001ffff8 + (effectiveStart - 0x9001fff8);
    }
    return 0x00300000 + (effectiveStart - 0x90020000);
  });

  assert.deepEqual(
    Array.from(
      context.mapInstructionPhysicalRanges(0x9001fff8, 0x10),
      range => ({ ...range }),
    ),
    [
      { start: 0x001ffff8, bytes: 8 },
      { start: 0x00300000, bytes: 8 },
    ],
  );
});

test("icbi evicts noncontiguous physical aliases and wrapped virtual blocks", () => {
  const context = makeInvalidationContext(effectiveStart =>
    effectiveStart === 0x80001000 ? 0x00300000 : null
  );
  addBlock(context, "foreign-noncontiguous", {
    namespace: "foreign",
    effectiveStart: 0x9001fff8,
    effectiveBytes: 0x10,
    physicalRanges: [
      { start: 0x001ffff8, bytes: 8 },
      { start: 0x00300000, bytes: 8 },
    ],
  });
  addBlock(context, "current-wrapped", {
    effectiveStart: 0xfffffff0,
    effectiveBytes: 0x20,
  });
  addBlock(context, "unrelated", {
    effectiveStart: 0x80002000,
    physicalStart: 0x00400000,
  });

  context.invalidateInstructionCacheLine(0x00000004);
  assert.deepEqual(remainingBlockIds(context), [
    "foreign-noncontiguous",
    "unrelated",
  ]);

  context.invalidateInstructionCacheLine(0x80001004);
  assert.deepEqual(remainingBlockIds(context), ["unrelated"]);
});

test("icbi removes virtual overlap and translated physical aliases only", () => {
  const translations = [];
  const context = makeInvalidationContext((effectiveStart, byteCount) => {
    translations.push([effectiveStart, byteCount]);
    return effectiveStart === 0x80001000 && byteCount === 0x20
      ? 0x00200000
      : null;
  });

  addBlock(context, "current-overlap", {
    effectiveStart: 0x80000ff8,
    effectiveBytes: 0x10,
    physicalStart: 0x00300000,
  });
  addBlock(context, "foreign-physical-alias", {
    namespace: "foreign",
    effectiveStart: 0x90000000,
    effectiveBytes: 0x10,
    physicalStart: 0x001ffff8,
    physicalBytes: 0x10,
  });
  addBlock(context, "foreign-same-virtual", {
    namespace: "foreign",
    effectiveStart: 0x80001000,
    physicalStart: 0x00400000,
  });
  addBlock(context, "current-adjacent", {
    effectiveStart: 0x80001020,
    physicalStart: 0x00200020,
  });
  addBlock(context, "unrelated", {
    effectiveStart: 0x80002000,
    physicalStart: 0x00500000,
  });

  context.invalidateInstructionCacheLine(0x80001013);

  assert.deepEqual(translations, [[0x80001000, 0x20]]);
  assert.deepEqual(remainingBlockIds(context), [
    "current-adjacent",
    "foreign-same-virtual",
    "unrelated",
  ]);
});

test("an invalidated member evicts its complete linked region", () => {
  const context = makeInvalidationContext(() => 0x00100000);
  addBlock(context, "invalidated", {
    namespace: "foreign",
    effectiveStart: 0x90001000,
    physicalStart: 0x00100000,
  });
  addBlock(context, "region-peer", {
    namespace: "foreign",
    effectiveStart: 0x90002000,
    physicalStart: 0x00101000,
  });
  addBlock(context, "other-region-block", {
    effectiveStart: 0x80003000,
    physicalStart: 0x00102000,
  });

  const invalidatedRegion = {
    instructionAddressSpaceKey: "foreign",
    pcs: [0x90001000, 0x90002000],
  };
  const retainedRegion = {
    instructionAddressSpaceKey: "current",
    pcs: [0x80003000],
  };
  context.regionsByPc.set("foreign:90001000", invalidatedRegion);
  context.regionsByPc.set("foreign:90002000", invalidatedRegion);
  context.regionsByPc.set("current:80003000", retainedRegion);
  context.instructionDependencyFreeLinkedRegions.add(invalidatedRegion);
  context.instructionDependencyFreeLinkedRegions.add(retainedRegion);

  context.invalidateInstructionCacheLine(0x80001004);

  assert.deepEqual(remainingBlockIds(context), [
    "other-region-block",
    "region-peer",
  ]);
  assert.deepEqual([...context.regionsByPc.values()], [retainedRegion]);
  assert.equal(
    context.instructionDependencyFreeLinkedRegions.has(invalidatedRegion),
    false,
  );
  assert.equal(
    context.instructionDependencyFreeLinkedRegions.has(retainedRegion),
    true,
  );
});

test("an unmapped virtual line still evicts current-namespace code", () => {
  const context = makeInvalidationContext(() => null);
  addBlock(context, "current-unmapped", {
    effectiveStart: 0x81234000,
  });
  addBlock(context, "foreign-unmapped", {
    namespace: "foreign",
    effectiveStart: 0x81234000,
    physicalStart: 0x00100000,
  });
  addBlock(context, "current-unrelated", {
    effectiveStart: 0x81235000,
  });

  context.invalidateInstructionCacheLine(0x8123401f);

  assert.deepEqual(remainingBlockIds(context), [
    "current-unrelated",
    "foreign-unmapped",
  ]);
});

test("batched invalidation translates every icbi line and retains gaps", () => {
  const translations = [];
  const physicalByLine = new Map([
    [0x80001000, 0x00100000],
    [0x80001020, null],
    [0x80001040, 0x00300000],
  ]);
  const context = makeInvalidationContext((effectiveStart, byteCount) => {
    translations.push([effectiveStart, byteCount]);
    return physicalByLine.get(effectiveStart) ?? null;
  });
  addBlock(context, "first-physical-alias", {
    namespace: "first-alias",
    effectiveStart: 0x90000000,
    physicalStart: 0x00100018,
    physicalBytes: 0x10,
  });
  addBlock(context, "last-physical-alias", {
    namespace: "last-alias",
    effectiveStart: 0xa0000000,
    physicalStart: 0x002ffff8,
    physicalBytes: 0x10,
  });
  addBlock(context, "current-middle-line", {
    effectiveStart: 0x80001020,
  });
  addBlock(context, "physical-gap", {
    namespace: "gap",
    effectiveStart: 0xb0000000,
    physicalStart: 0x00200000,
  });
  addBlock(context, "current-after-range", {
    effectiveStart: 0x80001060,
  });

  context.invalidateInstructionCacheRange(0x80001000, 0x60);

  assert.deepEqual(translations, [
    [0x80001000, 0x20],
    [0x80001020, 0x20],
    [0x80001040, 0x20],
  ]);
  assert.deepEqual(remainingBlockIds(context), [
    "current-after-range",
    "physical-gap",
  ]);
});

test("isync preserves compiled blocks and linked regions", () => {
  const context = makeInvalidationContext(() => null);
  addBlock(context, "compiled", {
    effectiveStart: 0x80001000,
    physicalStart: 0x00100000,
  });
  const region = {
    instructionAddressSpaceKey: "current",
    pcs: [0x80001000],
  };
  context.regionsByPc.set("current:80001000", region);

  context.synchronizeInstructionStream();

  assert.deepEqual(remainingBlockIds(context), ["compiled"]);
  assert.deepEqual([...context.regionsByPc.values()], [region]);
  assert.doesNotMatch(
    extractFunction("synchronizeInstructionStream"),
    /invalidateAllCompiledCode|blocks\.clear|regionsByPc\.clear/,
  );
});

test("JIT hooks and compiled block metadata expose selective invalidation", () => {
  assert.match(
    source,
    /user_0_13:\s*\(_ctx,\s*address\)\s*=>\s*invalidateInstructionCacheLine\(address\)/,
  );
  assert.match(
    source,
    /user_0_14:\s*\(\)\s*=>\s*synchronizeInstructionStream\(\)/,
  );

  for (const property of [
    "effectiveStart",
    "effectiveBytes",
    "physicalStart",
    "physicalBytes",
    "physicalRanges",
    "instructionAddressSpaceKey",
  ]) {
    assert.match(source, new RegExp(`block\\.${property}\\s*=`));
  }
});

test("accelerated icbi batches every skipped line through range invalidation", () => {
  const calls = [];
  const writes = [];
  const context = {
    accelerations: new Map(),
    bytes: new Uint8Array(0),
    cpu: 0,
    ctrOffset: 4,
    cycles: 0,
    decodeMemset32ByteLoop: () => null,
    fetchWord: () => 0x7c001fac,
    fastForwardStringHashLoop: () => false,
    gprOffsets: Array.from({ length: 32 }, (_unused, index) => 0x20 + index * 4),
    instructions: 0,
    invalidateInstructionCacheRange: (...arguments_) => calls.push(arguments_),
    isCacheLineLoop: () => true,
    loopSkipBudget: requested => requested,
    physicalLockedCachePointer: () => null,
    physicalRamPointer: () => null,
    readGpr: register => register === 3 ? 0x80001007 : 0,
    translateDataRange: () => null,
    view: {
      getUint32: offset => offset === 4 ? 4 : 0,
      setUint32: (offset, value, littleEndian) => {
        writes.push([offset, value, littleEndian]);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    ["translateCacheLoopRange", "fastForwardRecognizedLoop"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.icbi-acceleration.js" },
  );

  context.fastForwardRecognizedLoop(0x80000100, 0);

  assert.deepEqual(calls, [[0x80001000, 0x60]]);
  assert.equal(context.accelerations.get("icbiCacheLines"), 3);
  assert.equal(context.instructions, 9);
  assert.equal(context.cycles, 18);
  assert.deepEqual(writes, [
    [context.gprOffsets[3], 0x80001067, true],
    [context.ctrOffset, 1, true],
  ]);

  calls.length = 0;
  writes.length = 0;
  context.readGpr = register => register === 3 ? 0xffffffe7 : 0;
  context.fastForwardRecognizedLoop(0x80000100, 0);
  assert.deepEqual(calls, [], "a wrapping accelerated range must execute normally");
  assert.deepEqual(writes, [], "overflow rejection must leave guest loop state intact");

  const fastForward = extractFunction("fastForwardRecognizedLoop");
  assert.match(
    fastForward,
    /cacheInstruction\s*===\s*0x7c001fac[\s\S]*invalidateInstructionCacheRange\(\s*guestRangeStart,\s*byteCount\s*\)/,
  );
});
