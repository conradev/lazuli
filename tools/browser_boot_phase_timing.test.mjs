#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const browserBootSource = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);
const rendererSource = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const functionStart = browserBootSource.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name}`);
  const bodyStart = browserBootSource.indexOf("{", functionStart);
  let depth = 0;
  for (let index = bodyStart; index < browserBootSource.length; index += 1) {
    if (browserBootSource[index] === "{") depth += 1;
    if (browserBootSource[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return browserBootSource.slice(functionStart, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

test("worker phase timing samples exact ordinals without clocking skipped calls", () => {
  const clock = [10, 15, 20, 27];
  const context = {
    Math,
    Number,
    performance: { now: () => clock.shift() },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "newWorkerPhaseTiming",
      "newWorkerHostTimings",
      "beginWorkerPhaseTiming",
      "recordWorkerPhaseTiming",
      "snapshotWorkerHostTimings",
    ].map(extractFunction).join("\n\n"),
    context,
  );

  const timing = context.newWorkerPhaseTiming(4);
  for (let call = 0; call < 8; call += 1) {
    const startedAt = context.beginWorkerPhaseTiming(timing);
    context.recordWorkerPhaseTiming(timing, startedAt);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(timing)), {
    eligibleCalls: 8,
    sampleStride: 4,
    samples: 2,
    totalMs: 12,
    maxMs: 7,
  });
  assert.deepEqual(clock, []);

  const timings = context.newWorkerHostTimings();
  timings.execution = timing;
  const snapshot = JSON.parse(JSON.stringify(
    context.snapshotWorkerHostTimings(timings, timing.eligibleCalls),
  ));
  timing.totalMs = 999;
  assert.equal(snapshot.execution.totalMs, 12);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "execution",
    "fifoDecode",
    "fifoStagingDrainInclusive",
    "gxPacketPacking",
    "rendererBackpressure",
  ]);
});

test("execution sampling keeps its hot ordinal outside timing aggregates", () => {
  const declarationsStart = browserBootSource.indexOf(
    "const workerExecutionTimingSampleStride = 1024;",
  );
  const genericTimingStart = browserBootSource.indexOf(
    "function newWorkerPhaseTiming(",
    declarationsStart,
  );
  assert.notEqual(declarationsStart, -1);
  assert.notEqual(genericTimingStart, -1);
  const clock = [10, 20, 30];
  const context = { performance: { now: () => clock.shift() } };
  vm.createContext(context);
  vm.runInContext(
    [
      browserBootSource.slice(declarationsStart, genericTimingStart),
      extractFunction("beginWorkerExecutionTiming"),
    ].join("\n"),
    context,
  );

  const samples = [];
  for (let call = 0; call < 2049; call += 1) {
    const startedAt = vm.runInContext("beginWorkerExecutionTiming()", context);
    if (startedAt !== null) samples.push(startedAt);
  }
  assert.deepEqual(samples, [10, 20, 30]);
  assert.equal(
    vm.runInContext("workerExecutionTimingEligibleCalls", context),
    2049,
  );
  assert.deepEqual(clock, []);
});

test("hot worker and renderer phases use explicit bounded sampling", () => {
  assert.match(browserBootSource, /const workerExecutionTimingSampleStride = 1024;/);
  assert.match(browserBootSource, /execution: newWorkerPhaseTiming\(1024\)/);
  assert.match(browserBootSource, /fifoDecode: newWorkerPhaseTiming\(1024\)/);
  assert.match(browserBootSource, /fifoStagingDrainInclusive: newWorkerPhaseTiming\(256\)/);
  assert.match(browserBootSource, /gxPacketPacking: newWorkerPhaseTiming\(64\)/);
  assert.match(browserBootSource, /rendererBackpressure: newWorkerPhaseTiming\(1\)/);
  assert.match(
    browserBootSource,
    /const executionStartedAt = beginWorkerExecutionTiming\(\);/,
  );
  assert.doesNotMatch(
    browserBootSource,
    /beginWorkerPhaseTiming\(\s*workerHostTimings\.execution\s*\)/,
  );
  assert.match(
    browserBootSource,
    /if \(executionStartedAt !== null\) \{\s*recordWorkerPhaseTiming\(workerHostTimings\.execution/,
  );
  assert.match(
    browserBootSource,
    /beginWorkerPhaseTiming\(workerHostTimings\.fifoDecode\)/,
  );
  assert.match(rendererSource, /const DRAW_TIMING_SAMPLE_STRIDE: u64 = 1024;/);
  assert.match(rendererSource, /let sample_draw_timing = self\.sample_draw_host_timing\(\);/);
  assert.match(rendererSource, /RendererHostPhase::GxFrameExecution/);
  assert.doesNotMatch(rendererSource, /RendererHostPhase::CommandSubmission/);
});
