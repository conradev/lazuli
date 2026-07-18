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

function schedulerContext() {
  const context = {
    blockPattern: { none: 0, idleBasic: 2, idleVolatileRead: 3 },
    blocks: new Map(),
    isCacheLineLoop: () => false,
    decodeMemset32ByteLoop: () => null,
  };
  vm.createContext(context);
  vm.runInContext(
    ["isSemanticIdlePattern", "isRecognizedLoopPc"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.scheduler.js" },
  );
  return context;
}

test("semantic idle blocks are excluded from linked regions", () => {
  const context = schedulerContext();
  context.blocks.set(0x1000, { pattern: context.blockPattern.idleBasic });
  context.blocks.set(0x2000, { pattern: context.blockPattern.idleVolatileRead });
  context.blocks.set(0x3000, { pattern: context.blockPattern.none });

  assert.equal(context.isRecognizedLoopPc(0x1000), true);
  assert.equal(context.isRecognizedLoopPc(0x2000), true);
  assert.equal(context.isRecognizedLoopPc(0x3000), false);
});

test("structural loop recognition remains available before compilation", () => {
  const context = schedulerContext();
  context.isCacheLineLoop = pc => pc === 0x4000;
  context.decodeMemset32ByteLoop = pc => pc === 0x5000 ? {} : null;

  assert.equal(context.isRecognizedLoopPc(0x4000), true);
  assert.equal(context.isRecognizedLoopPc(0x5000), true);
  assert.equal(context.isRecognizedLoopPc(0x6000), false);
});

test("runner budgets are unbounded unless the debug URL supplies them", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFunction("readRunnerLimit"), context, {
    filename: "browser_boot.scheduler.js",
  });

  const defaults = new URLSearchParams();
  assert.equal(context.readRunnerLimit(defaults, "dispatches"), Number.POSITIVE_INFINITY);
  assert.equal(context.readRunnerLimit(defaults, "cycles"), Number.POSITIVE_INFINITY);

  const finite = new URLSearchParams("dispatches=350000&cycles=100000000");
  assert.equal(context.readRunnerLimit(finite, "dispatches"), 350000);
  assert.equal(context.readRunnerLimit(finite, "cycles"), 100000000);
});
