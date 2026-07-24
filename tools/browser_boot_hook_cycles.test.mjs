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
const compilerSource = readFileSync(
  new URL("../crates/ppcwasmjit/src/browser_abi.rs", import.meta.url),
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

const hookFunctions = [
  "regionHookCanContinue",
  "withScopedCycles",
  "withPublishedHookCycles",
  "drainGxFifoStagingForJit",
  "drainGxFifoStagingAtCycle",
  "invokeJitHook",
  "createJitHookProxy",
];

function makeContext() {
  const memory = new ArrayBuffer(256);
  const events = [];
  const context = {
    cycles: 1_000,
    drainFailure: null,
    gxFifoStagingMeta: 0,
    hookCalls: new Map(),
    hookCycleOffset: 8,
    dataRamOrLockedCachePointer(address, size) {
      return address === 0x8000 && size === 1 ? 0 : null;
    },
    regionContinuableHookCalls: 0,
    regionControl: 64,
    regionCyclePrefixOffset: 0,
    regionExitRequestOffset: 4,
    regionRunning: false,
    view: new DataView(memory),
  };
  context.drainGxFifoStaging = () => {
    events.push(["drain", context.cycles]);
    if (context.drainFailure !== null) throw context.drainFailure;
    context.view.setUint32(context.gxFifoStagingMeta, 0, true);
  };
  vm.createContext(context);
  vm.runInContext(
    hookFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.hook_cycles.js" },
  );
  context.events = events;
  return context;
}

function publish(context, { prefix = 0, offset = 0, exit = 0 } = {}) {
  context.view.setUint32(context.regionControl, prefix, true);
  context.view.setUint32(context.regionControl + 4, exit, true);
  context.view.setUint32(context.regionControl + 8, offset, true);
}

test("direct JIT hooks use instruction-start cycles and restore the outer timeline", () => {
  const context = makeContext();
  publish(context, { prefix: 900, offset: 7 });
  const target = {
    user_0_15(...arguments_) {
      context.events.push(["target", context.cycles, ...arguments_]);
      return 42;
    },
    user_0_19() {
      context.events.push(["throw", context.cycles]);
      throw new Error("hook failed");
    },
  };
  const hooks = context.createJitHookProxy(target);

  assert.equal(hooks.user_0_15(64, 1, 2), 42);
  assert.deepEqual(context.events, [
    ["drain", 1_007],
    ["target", 1_007, 64, 1, 2],
  ]);
  assert.equal(context.cycles, 1_000);
  assert.equal(context.hookCalls.get("user_0_15"), 1);

  context.events.length = 0;
  assert.throws(() => hooks.user_0_19(), /hook failed/);
  assert.deepEqual(context.events, [["drain", 1_007], ["throw", 1_007]]);
  assert.equal(context.cycles, 1_000);
});

test("region hooks combine block prefixes with instruction offsets and request exits", () => {
  const context = makeContext();
  context.regionRunning = true;
  publish(context, { prefix: 40, offset: 7 });
  const target = {
    user_0_3(...arguments_) {
      context.events.push(["load", context.cycles, ...arguments_]);
      return 1;
    },
    user_0_15() {
      context.events.push(["generic", context.cycles]);
      return 0;
    },
  };
  const hooks = context.createJitHookProxy(target);

  assert.equal(hooks.user_0_3(64, 0x8000, 0x100), 1);
  assert.deepEqual(context.events, [
    ["drain", 1_047],
    ["load", 1_047, 64, 0x8000, 0x100],
  ]);
  assert.equal(context.regionContinuableHookCalls, 1);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 0);
  assert.equal(context.cycles, 1_000);

  context.events.length = 0;
  publish(context, { prefix: 40, offset: 8 });
  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  assert.equal(hooks.user_0_3(64, 0x8000, 0x100), 1);
  assert.deepEqual(context.events, [
    ["drain", 1_048],
    ["load", 1_048, 64, 0x8000, 0x100],
  ]);
  assert.equal(context.regionContinuableHookCalls, 2);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 1);
  assert.equal(context.cycles, 1_000);

  context.events.length = 0;
  publish(context, { prefix: 40, offset: 9 });
  assert.equal(hooks.user_0_15(), 0);
  assert.deepEqual(context.events, [["drain", 1_049], ["generic", 1_049]]);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 1);
  assert.equal(context.cycles, 1_000);
});

test("exception hooks retain their two-argument ABI while using published cycles", () => {
  const context = makeContext();
  context.cycles = 200;
  context.regionRunning = true;
  publish(context, { prefix: 50, offset: 2 });
  const target = {
    user_1_0(...arguments_) {
      context.events.push(["exception", context.cycles, ...arguments_]);
    },
  };
  const hooks = context.createJitHookProxy(target);

  assert.equal(hooks.user_1_0(0x1234, 0x300), 0);
  assert.deepEqual(context.events, [
    ["drain", 252],
    ["exception", 252, 0x1234, 0x300],
  ]);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 1);
  assert.equal(context.cycles, 200);
});

test("emergency FIFO drains use the current JIT hook timestamp", () => {
  const context = makeContext();
  publish(context, { prefix: 400, offset: 6 });
  context.drainGxFifoStagingForJit();
  assert.deepEqual(context.events, [["drain", 1_006]]);
  assert.equal(context.cycles, 1_000);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 0);

  context.events.length = 0;
  context.regionRunning = true;
  context.drainGxFifoStagingForJit();
  assert.deepEqual(context.events, [["drain", 1_406]]);
  assert.equal(context.cycles, 1_000);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 1);

  publish(context, { prefix: 400, offset: 6 });
  context.drainFailure = new Error("drain failed");
  assert.throws(() => context.drainGxFifoStagingForJit(), /drain failed/);
  assert.equal(context.cycles, 1_000);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 0);
});

test("post-execution FIFO drains use returned aggregate cycles", () => {
  const context = makeContext();
  context.regionRunning = true;
  publish(context, { prefix: 900, offset: 700 });
  context.drainGxFifoStagingAtCycle(1_025);
  assert.deepEqual(context.events, [["drain", 1_025]]);
  assert.equal(context.cycles, 1_000);

  context.drainFailure = new Error("post-block drain failed");
  assert.throws(
    () => context.drainGxFifoStagingAtCycle(1_030),
    /post-block drain failed/,
  );
  assert.equal(context.cycles, 1_000);
});

test("inline BAT barriers drain prior FIFO bytes at their exact cycle", () => {
  for (const [name, label] of [
    ["user_0_17", "ibat"],
    ["user_0_18", "dbat"],
  ]) {
    const context = makeContext();
    context.regionRunning = true;
    publish(context, { prefix: 40, offset: 2 });
    context.view.setUint32(context.gxFifoStagingMeta, 32, true);
    const hooks = context.createJitHookProxy({
      [name]() {
        context.events.push([label, context.cycles]);
      },
    });

    assert.equal(hooks[name](), 0);
    assert.deepEqual(context.events, [
      ["drain", 1_042],
      [label, 1_042],
    ]);
    assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
    assert.equal(context.view.getUint32(context.regionControl + 4, true), 1);
    assert.equal(context.cycles, 1_000);

    assert.equal(context.cycles, 1_000);
  }
});

test("browser execution wires one control record through blocks, regions, and FIFO drains", () => {
  assert.match(source, /const regionCyclePrefixOffset = 0;/);
  assert.match(source, /const regionExitRequestOffset = 4;/);
  assert.match(source, /const hookCycleOffset = 8;/);
  assert.match(source, /lazuli_fifo: \{ flush: drainGxFifoStagingForJit \}/);
  assert.match(compilerSource, /const HOOK_CYCLE_OFFSET: i32 = 8;/);
  assert.match(
    compilerSource,
    /Jit::with_slow_memory_hook_cycle_offset\(HOOK_CYCLE_OFFSET\)/,
  );
  assert.match(
    source,
    /region\.instance\.exports\.run\(\s*regionControl,\s*cpu,\s*fastmem,\s*pcOffset,\s*regionControl,/,
  );
  assert.match(
    source,
    /block\.instance\.exports\.run\(regionControl, cpu, fastmem\)/,
  );
  const controlReset = /view\.setUint32\(regionControl \+ regionCyclePrefixOffset, 0, true\);\s*view\.setUint32\(regionControl \+ regionExitRequestOffset, 0, true\);\s*view\.setUint32\(regionControl \+ hookCycleOffset, 0, true\);/g;
  assert.equal([...source.matchAll(controlReset)].length, 2);

  const observed = source.indexOf("const observedCycles = cycles + executedCycles;");
  const drain = source.indexOf("drainGxFifoStagingAtCycle(observedCycles);", observed);
  const service = source.indexOf("serviceMmio(observedCycles);", drain);
  assert.equal(observed >= 0 && drain > observed && service > drain, true);
});
