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

test("runner only rests after its cooperative slice expires", () => {
  const context = {
    runnerRestMs: 2,
    runnerYieldDeadline: 112,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("runnerRestWhenDue"), context, {
    filename: "browser_boot.scheduler.js",
  });

  assert.equal(context.runnerRestWhenDue(111), null);
  assert.equal(context.runnerRestWhenDue(112), 2);
  context.runnerRestMs = 0;
  assert.equal(context.runnerRestWhenDue(113), 0);
});

function createHarness() {
  const messages = [];
  let receive;
  const channel = {
    port1: {
      set onmessage(handler) { receive = handler; },
    },
    port2: {
      postMessage(value) { messages.push(value); },
    },
  };
  const timers = [];
  const context = {
    channel,
    messages,
    timers,
    deliver() { receive?.(); },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
  };
  vm.createContext(context);
  vm.runInContext(
    `${extractFunction("createRunnerYieldScheduler")}; scheduler = createRunnerYieldScheduler(channel);`,
    context,
    { filename: "browser_boot.scheduler.js" },
  );
  return context;
}

test("zero-rest worker yields use a message task instead of a throttled timer", async () => {
  const context = createHarness();
  let completed = false;
  const yielded = context.scheduler(0).then(() => { completed = true; });

  assert.deepEqual(context.messages, [0]);
  assert.deepEqual(context.timers, []);
  assert.equal(completed, false);

  context.deliver();
  await yielded;
  assert.equal(completed, true);
});

test("explicit worker rests retain their requested timer delay", async () => {
  const context = createHarness();
  const yielded = context.scheduler(7);

  assert.deepEqual(context.messages, []);
  assert.equal(context.timers.length, 1);
  assert.equal(context.timers[0].delay, 7);

  context.timers[0].callback();
  await yielded;
});

test("browser execution defaults to an unthrottled cooperative yield", () => {
  assert.match(source, /searchParams\.get\("restMs"\) \?\? 0/);
  assert.match(source, /id="runner-rest-ms"[^>]*value="0"/);
  assert.match(source, /get\("restMs"\) \?\? "0"/);
  assert.doesNotMatch(source, /setTimeout\(resolve, rest\)/);
});

test("browser runner services a queued CP FIFO only when work is pending", () => {
  assert.match(
    source,
    /cpFifoState\.distance !== 0[\s\S]*serviceCommandProcessorFifo\(\);[\s\S]*ensureViSchedule/,
  );
});
