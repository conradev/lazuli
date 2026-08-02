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
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function fusionFixture(sourcePcCount) {
  const sourcePcs = Array.from(
    { length: sourcePcCount },
    (_unused, index) => 0x8000_1000 + index * 4,
  );
  const nextPc = 0x8100_0000;
  const key = `${sourcePcs[0].toString(16)}>${nextPc.toString(16)}`;
  const linked = [];
  const budgets = Object.freeze({
    cycles: 123_456,
    dispatches: 7_890,
    cycleLimit: 999_999,
    dispatchLimit: 888_888,
    regionCycleBudget: 4_321,
    regionBlockBudget: 4_096,
  });
  const context = {
    ...budgets,
    accelerations: new Map(),
    blockHasInstructionPageDependencies: () => false,
    compiledBlock: () => ({}),
    compiledRegion: () => undefined,
    instructionRegionKey: pc => pc,
    isRecognizedLoopPc: () => false,
    maximumFusedRegionBlocks: 256,
    regionFusionHitThreshold: 8,
    regionFusionHits: new Map([[key, 7]]),
    regionsByPc: new Map(),
    linkCompiledRegion: async (_compiler, _inputPointer, pcs) => {
      linked.push([...pcs]);
      return { pcs: [...pcs] };
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("maybeFuseRegionExit"), context);
  return { budgets, context, linked, nextPc, sourceRegion: { pcs: sourcePcs } };
}

function assertBudgets(context, expected) {
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(context[name], value, `${name} changed during fusion policy`);
  }
}

test("fusion accepts a region ending at exactly 256 PCs", async () => {
  const fixture = fusionFixture(255);
  const pending = fixture.context.maybeFuseRegionExit(
    {}, 0x1000, fixture.sourceRegion, fixture.nextPc,
  );
  assert.ok(pending instanceof Promise);
  await pending;

  assert.equal(fixture.linked.length, 1);
  assert.equal(fixture.linked[0].length, 256);
  assert.equal(fixture.linked[0].at(-1), fixture.nextPc);
  assert.equal(fixture.context.regionsByPc.size, 256);
  assert.equal(fixture.context.accelerations.get("wasmRegionFusions"), 1);
  assert.equal(fixture.context.accelerations.get("wasmFusedRegionBlocks"), 256);
  assert.equal(fixture.context.accelerations.get("wasmLargestRegionBlocks"), 256);
  assert.equal(
    fixture.context.accelerations.get("wasmRegionFusionLimitHits"), undefined,
  );
  assertBudgets(fixture.context, fixture.budgets);
});

test("fusion rejects 257 PCs without perturbing counters or budgets", () => {
  const fixture = fusionFixture(256);
  assert.equal(
    fixture.context.maybeFuseRegionExit(
      {}, 0x1000, fixture.sourceRegion, fixture.nextPc,
    ),
    null,
  );
  assert.equal(fixture.linked.length, 0);
  assert.equal(fixture.context.regionsByPc.size, 0);
  assert.equal(fixture.context.accelerations.get("wasmRegionFusionLimitHits"), 1);
  assert.equal(fixture.context.accelerations.get("wasmRegionFusions"), undefined);
  assert.equal(fixture.context.accelerations.get("wasmFusedRegionBlocks"), undefined);
  assert.equal(fixture.context.accelerations.get("wasmLargestRegionBlocks"), undefined);
  assertBudgets(fixture.context, fixture.budgets);
});

test("expanded fusion retains independent execution budgets", () => {
  assert.match(source, /const maximumFusedRegionBlocks = 256;/);
  assert.match(
    source,
    /const regionCycleBudget = eventCycle === null\s*\? 0x7fffffff\s*: Math\.min\(0x7fffffff, eventCycle - cycles\);/,
  );
  assert.match(
    source,
    /const regionBlockBudget = Math\.min\(4096, dispatchLimit - dispatches\);/,
  );
  assert.match(source, /Math\.max\(64, maximumFusedRegionBlocks \* 2\)/);
});
