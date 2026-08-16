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
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  if (source.slice(start - 6, start) === "async ") start -= 6;
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
  "finishAfterRendererDrain",
  "finishQuiescentAfterRendererDrain",
  "requestRunnerSnapshot",
  "publishRunnerSnapshot",
];

function makeContext() {
  const memory = new ArrayBuffer(256);
  const events = [];
  const context = {
    blocks: new Map(),
    check(condition, message) {
      if (!condition) throw new Error(message);
    },
    cycles: 1_000,
    drainFailure: null,
    drainProducedLinkedBurst: false,
    dispatches: 300,
    finish(status, details) {
      context.finishedDetails.push(details);
      events.push([
        "finish",
        status,
        details.stage,
        context.view.getUint32(context.gxFifoStagingMeta, true),
      ]);
    },
    gxFifoStagingCapacity: 64,
    gxFifoStagingMeta: 0,
    gxWriteGatherBurstBytes: 32,
    gxWriteGatherPendingBytes: 0,
    hex32: value => "0x" + (value >>> 0).toString(16).padStart(8, "0"),
    hookCalls: new Map(),
    hookCycleOffset: 8,
    async honorRendererBackpressure(waitWhileStopping) {
      events.push([
        "renderer",
        waitWhileStopping,
        context.view.getUint32(context.gxFifoStagingMeta, true),
      ]);
    },
    instructions: 200,
    pc: 0x8000_1000,
    dataRamOrLockedCachePointer(address, size) {
      return address === 0x8000 && size === 1 ? 0 : null;
    },
    regionContinuableHookCalls: 0,
    regionControl: 64,
    regionCyclePrefixOffset: 0,
    regionExitRequestOffset: 4,
    regionRunning: false,
    runnerPaused: false,
    runnerSnapshotRequested: true,
    runnerSnapshotRequestId: null,
    statusDataset: {},
    view: new DataView(memory),
    finishedDetails: [],
  };
  context.drainGxFifoStaging = () => {
    const pendingBytes = context.view.getUint32(context.gxFifoStagingMeta, true);
    events.push(["drain", context.cycles]);
    if (context.drainFailure !== null) throw context.drainFailure;
    context.view.setUint32(context.gxFifoStagingMeta, 0, true);
    return pendingBytes !== 0 && context.drainProducedLinkedBurst;
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
  context.drainProducedLinkedBurst = true;
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

test("slow hooks force partial drains, continue after unlinked bursts, and exit after linked bursts", () => {
  const context = makeContext();
  context.regionRunning = true;
  const hooks = context.createJitHookProxy({
    user_0_3() {
      context.events.push(["load", context.cycles]);
      return 1;
    },
  });

  publish(context, { prefix: 60, offset: 4 });
  context.view.setUint32(context.gxFifoStagingMeta, 31, true);
  assert.equal(hooks.user_0_3(64, 0x8000, 0x100), 1);
  assert.deepEqual(context.events, [
    ["drain", 1_064],
    ["load", 1_064],
  ]);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 0);

  context.events.length = 0;
  publish(context, { prefix: 60, offset: 5 });
  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  assert.equal(hooks.user_0_3(64, 0x8000, 0x100), 1);
  assert.deepEqual(context.events, [
    ["drain", 1_065],
    ["load", 1_065],
  ]);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 0);

  context.events.length = 0;
  publish(context, { prefix: 60, offset: 6 });
  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  context.drainProducedLinkedBurst = true;
  assert.equal(hooks.user_0_3(64, 0x8000, 0x100), 1);
  assert.deepEqual(context.events, [
    ["drain", 1_066],
    ["load", 1_066],
  ]);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 1);
  assert.equal(context.cycles, 1_000);
});

test("MSR hooks honor continuation classification and FIFO-drain exits", () => {
  const context = makeContext();
  context.regionRunning = true;
  let hookResult = 1;
  const hooks = context.createJitHookProxy({
    user_0_16() {
      context.events.push(["msr", context.cycles, hookResult]);
      return hookResult;
    },
  });

  publish(context, { prefix: 20, offset: 3 });
  assert.equal(hooks.user_0_16(), 1);
  assert.deepEqual(context.events, [
    ["drain", 1_023],
    ["msr", 1_023, 1],
  ]);
  assert.equal(context.regionContinuableHookCalls, 1);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 0);

  context.events.length = 0;
  hookResult = 0;
  publish(context, { prefix: 20, offset: 4 });
  assert.equal(hooks.user_0_16(), 0);
  assert.deepEqual(context.events, [
    ["drain", 1_024],
    ["msr", 1_024, 0],
  ]);
  assert.equal(context.regionContinuableHookCalls, 1);
  assert.equal(context.view.getUint32(context.regionControl + 4, true), 1);

  context.events.length = 0;
  hookResult = 1;
  publish(context, { prefix: 20, offset: 5 });
  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  context.drainProducedLinkedBurst = true;
  assert.equal(hooks.user_0_16(), 1);
  assert.deepEqual(context.events, [
    ["drain", 1_025],
    ["msr", 1_025, 1],
  ]);
  assert.equal(context.regionContinuableHookCalls, 2);
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
  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  context.drainGxFifoStagingAtCycle(1_025);
  assert.deepEqual(context.events, [["drain", 1_025]]);
  assert.equal(context.cycles, 1_000);

  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  context.drainFailure = new Error("post-block drain failed");
  assert.throws(
    () => context.drainGxFifoStagingAtCycle(1_030),
    /post-block drain failed/,
  );
  assert.equal(context.cycles, 1_000);
});

test("quiescent reports drain staging before renderer receipts and publication", async () => {
  const context = makeContext();
  context.view.setUint32(context.gxFifoStagingMeta, 31, true);

  await context.finishQuiescentAfterRendererDrain("paused", {
    stage: "cycle-limit",
  });

  assert.deepEqual(context.events, [
    ["drain", 1_000],
    ["renderer", true, 0],
    ["finish", "paused", "cycle-limit", 0],
  ]);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.cycles, 1_000);
});

test("a quiescent drain failure is attempted once before nonquiescent error reporting", async () => {
  const context = makeContext();
  context.view.setUint32(context.gxFifoStagingMeta, 31, true);
  context.drainFailure = new Error("synthetic quiescence failure");

  await assert.rejects(
    context.finishQuiescentAfterRendererDrain("paused", {
      stage: "cycle-limit",
    }),
    /synthetic quiescence failure/,
  );
  assert.deepEqual(context.events, [["drain", 1_000]]);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 31);

  context.drainFailure = null;
  await context.finishAfterRendererDrain("stopped", { stage: "execute" });
  assert.deepEqual(context.events, [
    ["drain", 1_000],
    ["renderer", true, 31],
    ["finish", "stopped", "execute", 31],
  ]);
  assert.equal(
    context.events.filter(([event]) => event === "drain").length,
    1,
  );
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 31);
});

test("snapshot publication force-drains a deferred partial suffix", () => {
  const context = makeContext();
  context.view.setUint32(context.gxFifoStagingMeta, 31, true);

  assert.equal(context.drainGxFifoStagingAtCycle(1_025), false);
  assert.deepEqual(context.events, []);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 31);

  context.cycles = 1_025;
  context.publishRunnerSnapshot();
  assert.deepEqual(context.events, [
    ["drain", 1_025],
    ["finish", "running", "snapshot", 0],
  ]);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.runnerSnapshotRequested, false);
  assert.equal(context.runnerSnapshotRequestId, null);
  assert.equal("diagnosticsRequestId" in context.finishedDetails[0], false);
  assert.equal(context.statusDataset.status, "running");
  assert.equal(context.cycles, 1_025);

  const linked = makeContext();
  linked.view.setUint32(linked.gxFifoStagingMeta, 32, true);
  linked.drainProducedLinkedBurst = true;
  assert.throws(
    () => linked.publishRunnerSnapshot(),
    /snapshot staging drain unexpectedly produced a linked FIFO burst/,
  );
  assert.deepEqual(linked.events, [["drain", 1_000]]);
});

test("public snapshot identity survives an overlapping debug request and is echoed once", () => {
  const context = makeContext();
  context.runnerSnapshotRequested = false;

  context.requestRunnerSnapshot(41);
  context.requestRunnerSnapshot();
  context.requestRunnerSnapshot(42);
  assert.equal(context.runnerSnapshotRequested, true);
  assert.equal(context.runnerSnapshotRequestId, 41);

  context.publishRunnerSnapshot();
  assert.equal(context.finishedDetails[0].stage, "snapshot");
  assert.equal(context.finishedDetails[0].diagnosticsRequestId, 41);
  assert.equal(context.runnerSnapshotRequested, false);
  assert.equal(context.runnerSnapshotRequestId, null);

  context.requestRunnerSnapshot();
  context.publishRunnerSnapshot();
  assert.equal("diagnosticsRequestId" in context.finishedDetails[1], false);
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

test("coherent runner boundaries quiesce while fault reports remain nonquiescent", () => {
  assert.match(
    source,
    /if \(reachedLimit !== null\) \{\s*runnerPaused = true;\s*await finishQuiescentAfterRendererDrain\("paused", \{\s*stage: reachedLimit,/,
  );
  assert.equal(
    [...source.matchAll(/await finishQuiescentAfterRendererDrain\(/g)].length,
    8,
    "two operator stops, scenario, limit, first DSI, terminal PC, and both stable-loop diagnostics quiesce",
  );
  assert.equal(
    [...source.matchAll(/await finishAfterRendererDrain\("stopped", \{/g)].length,
    4,
    "compile, instruction-fetch, execute, and outer fault reports do not redrain",
  );
  assert.match(
    source,
    /if \(rendererFailure !== null\) \{\s*finish\("stopped", \{\s*stage: "renderer",/,
  );
});
