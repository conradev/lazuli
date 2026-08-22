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
    blockPattern: {
      none: 0,
      idleBasic: 2,
      idleVolatileRead: 3,
      dspSendMailboxStatus: 4,
    },
    blocks: new Map(),
    decodeStringHashLoop: () => null,
    isCacheLineLoop: () => false,
    decodeMemset32ByteLoop: () => null,
    isMusyxAramQueueFullWaitBackedge: () => false,
    isAiSrcInitSampleCounterWaitCandidate: () => false,
    isDspSendMailboxWaitCandidate: () => false,
    isDspReceiveMailboxWaitCandidate: () => false,
    isAramDmaBusyWaitCandidate: () => false,
  };
  context.compiledBlock = pc => context.blocks.get(pc);
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

function stabilityContext() {
  const context = {
    lastCpuSignature: null,
    lastPc: null,
    samePcCount: 0,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "updateStablePcWitness",
      "nextStableWaitEventCycle",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.scheduler-stability.js" },
  );
  return context;
}

function statusPublicationContext() {
  const context = {
    runnerStatusDispatchDeadline: 4_096,
    runnerStatusDispatchStride: 4_096,
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("claimRunnerStatusPublication"),
    context,
    { filename: "browser_boot.scheduler-status-publication.js" },
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
  context.isMusyxAramQueueFullWaitBackedge = pc => pc === 0x6000;
  context.isAiSrcInitSampleCounterWaitCandidate = pc => pc === 0x7000;
  context.decodeStringHashLoop = pc => pc === 0x8000 ? {} : null;
  context.isDspReceiveMailboxWaitCandidate = pc => pc === 0x9000;
  context.isAramDmaBusyWaitCandidate = pc => pc === 0xa000;
  context.isDspSendMailboxWaitCandidate = pc => pc === 0xb000;

  assert.equal(context.isRecognizedLoopPc(0x4000), true);
  assert.equal(context.isRecognizedLoopPc(0x5000), true);
  assert.equal(context.isRecognizedLoopPc(0x6000), true);
  assert.equal(context.isRecognizedLoopPc(0x7000), true);
  assert.equal(context.isRecognizedLoopPc(0x8000), true);
  assert.equal(context.isRecognizedLoopPc(0x9000), true);
  assert.equal(context.isRecognizedLoopPc(0xa000), true);
  assert.equal(context.isRecognizedLoopPc(0xb000), true);
  assert.equal(context.isRecognizedLoopPc(0xc000), false);
});

test("lazy CPU stability witnesses do not hash across changing PCs", () => {
  const context = stabilityContext();
  let hashes = 0;
  const readSignature = () => {
    hashes += 1;
    return 0x12345678;
  };

  for (const pc of [0x1000, 0x2000, 0x3000, 0x1000]) {
    assert.equal(context.updateStablePcWitness(pc, readSignature), 0);
  }
  assert.equal(hashes, 0);
  assert.equal(context.lastPc, 0x1000);
  assert.equal(context.lastCpuSignature, null);
});

test("lazy CPU stability requires a recorded witness and two unchanged intervals", () => {
  const context = stabilityContext();
  let hashes = 0;
  const readSignature = () => {
    hashes += 1;
    return 0x89abcdef;
  };

  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 0);
  assert.equal(hashes, 0, "the first PC observation does not hash");

  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 0);
  assert.equal(hashes, 1, "the first repeat records the witness");
  assert.equal(context.lastCpuSignature, 0x89abcdef);

  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 1);
  assert.equal(
    context.nextStableWaitEventCycle(true, context.samePcCount),
    null,
    "one identical interval is not enough to accelerate",
  );

  context.nextRuntimeEventCycle = includeCycleLimit => {
    assert.equal(includeCycleLimit, false);
    return 50_000;
  };
  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 2);
  assert.equal(
    context.nextStableWaitEventCycle(true, context.samePcCount),
    50_000,
    "a second identical interval may advance to the exact pending event",
  );
  assert.equal(hashes, 3);
});

test("CPU state changes reset the lazy stability witness", () => {
  const context = stabilityContext();
  const signatures = [0x11111111, 0x22222222, 0x22222222, 0x22222222];
  const readSignature = () => signatures.shift();

  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 0);
  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 0);
  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 0);
  assert.equal(
    context.lastCpuSignature,
    0x22222222,
    "the changed state becomes the next conservative witness",
  );
  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 1);
  assert.equal(context.updateStablePcWitness(0x1000, readSignature), 2);
  assert.deepEqual(signatures, []);
});

test("linked multi-block regions below the status deadline publish nothing", () => {
  const context = statusPublicationContext();
  let dispatches = 0;
  for (const executedBlocks of [96, 96, 1_024, 2_048, 831]) {
    dispatches += executedBlocks;
    assert.equal(dispatches < 4_096, true);
    assert.equal(context.claimRunnerStatusPublication(dispatches), false);
  }
  assert.equal(context.runnerStatusDispatchDeadline, 4_096);
});

test("crossing a status deadline publishes exactly once", () => {
  const context = statusPublicationContext();

  assert.equal(context.claimRunnerStatusPublication(4_095), false);
  assert.equal(context.claimRunnerStatusPublication(4_096), true);
  assert.equal(context.runnerStatusDispatchDeadline, 8_192);
  assert.equal(context.claimRunnerStatusPublication(4_096), false);
  assert.equal(context.claimRunnerStatusPublication(8_191), false);
});

test("large dispatch leaps advance the status deadline without catch-up bursts", () => {
  const context = statusPublicationContext();
  const observedDispatches = 10 * 4_096 + 123;

  assert.equal(context.claimRunnerStatusPublication(observedDispatches), true);
  assert.equal(context.runnerStatusDispatchDeadline, 11 * 4_096);
  assert.equal(
    context.claimRunnerStatusPublication(observedDispatches),
    false,
    "the same observation must not replay skipped status publications",
  );
  assert.equal(context.claimRunnerStatusPublication(11 * 4_096), true);
  assert.equal(context.runnerStatusDispatchDeadline, 12 * 4_096);
});

test("runner live status has no bitmask or every-region publication trigger", () => {
  assert.doesNotMatch(source, /executedBlocks\s*>\s*1\s*\|\|/);
  assert.doesNotMatch(source, /dispatches\s*&\s*4095/);
  assert.match(
    source,
    /if \(claimRunnerStatusPublication\(dispatches\)\) \{\s*statusDataset\.dispatches = String\(dispatches\);\s*statusDataset\.cycles = String\(cycles\);\s*statusDataset\.idleJumps = String\(/,
  );
});

test("lazy stability retains the pending event's exact wake cycle", () => {
  const context = stabilityContext();
  context.nextRuntimeEventCycle = () => 1_000;
  const readSignature = () => 0x55aa55aa;
  let cycles = 100;

  for (let execution = 0; execution < 4; execution += 1) {
    cycles += 6;
    context.updateStablePcWitness(0x1000, readSignature);
  }
  const wakeCycle = context.nextStableWaitEventCycle(
    true,
    context.samePcCount,
  );
  assert.equal(wakeCycle, 1_000);
  const skipped = wakeCycle - cycles;
  cycles = wakeCycle;
  assert.equal(skipped, 876);
  assert.equal(cycles, 1_000);
});

test("non-semantic stable boundaries cannot use the generic idle accelerator", () => {
  const context = {
    pendingEventCycle: null,
    nextRuntimeEventCycle(includeCycleLimit) {
      assert.equal(includeCycleLimit, false);
      return context.pendingEventCycle;
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("nextStableWaitEventCycle"), context, {
    filename: "browser_boot.scheduler.js",
  });

  context.pendingEventCycle = 182_519_381;
  assert.equal(
    context.nextStableWaitEventCycle(false, 128),
    null,
    "device waits need their own structurally and dynamically certified path",
  );
  assert.equal(
    context.nextStableWaitEventCycle(true, 1),
    null,
    "semantic idle still requires two unchanged witnesses",
  );
  assert.equal(
    context.nextStableWaitEventCycle(true, 2),
    182_519_381,
    "a certified semantic idle may advance to the pending event",
  );

  context.pendingEventCycle = null;
  assert.equal(
    context.nextStableWaitEventCycle(true, 2),
    null,
    "semantic idle without a device event must keep executing the guest",
  );
});

test("runtime deadlines distinguish future work from work due at the published cycle", () => {
  const context = {
    aramTransfer: null,
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    diskTransfer: null,
    dspScheduledMail: null,
    ensureViSchedule() {},
    nextAudioSampleCycle: () => null,
    nextDecrementerCycle: null,
    nextDiskAudioCycle: null,
    nextDspExecutionCycle: null,
    nextDspAudioDmaCycle: null,
    nextDspAudioDmaInterruptCycle: null,
    nextSerialPollCycle: null,
    nextViBoundaryCycle: null,
    nextViCycle: null,
    nextViPresentCycle: null,
    nextViTimingBoundaryCycle: null,
    peFinishCycle: null,
    serialTransfer: null,
    viTiming: null,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "runtimeEventCycleCandidates",
      "runtimeEventDueAtOrBefore",
      "nextRuntimeEventCycle",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.scheduler-deadline.js" },
  );

  context.aramTransfer = { completionCycle: 101 };
  assert.equal(context.runtimeEventDueAtOrBefore(100), false);
  assert.equal(context.nextRuntimeEventCycle(false), 101);

  context.aramTransfer.completionCycle = 100;
  assert.equal(
    context.runtimeEventDueAtOrBefore(100),
    true,
    "a deadline equal to the hook cycle is already due",
  );
  assert.equal(
    context.nextRuntimeEventCycle(false),
    null,
    "future-event selection must continue to exclude an already-due deadline",
  );

  context.aramTransfer.completionCycle = 99;
  assert.equal(context.runtimeEventDueAtOrBefore(100), true);
  context.aramTransfer = null;
  context.cycleLimit = 90;
  assert.equal(
    context.runtimeEventDueAtOrBefore(100),
    false,
    "the runner's debug cycle limit is not a device-delivery boundary",
  );
});

test("only basic semantic idles project audio deadlines to interrupt-producing work", () => {
  const context = {
    aramTransfer: null,
    blockPattern: { idleBasic: 2, idleVolatileRead: 3 },
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    diskTransfer: null,
    dspScheduledMail: null,
    ensureViSchedule() {},
    nextAudioInterruptCycle: () => 170,
    nextAudioSampleCycle: () => 105,
    nextDecrementerCycle: null,
    nextDiskAudioCycle: null,
    nextDspExecutionCycle: null,
    nextDspAudioDmaCompletionCycle: () => 160,
    nextDspAudioDmaCycle: 110,
    nextDspAudioDmaInterruptCycle: 120,
    nextSerialPollCycle: null,
    nextViBoundaryCycle: null,
    nextViCycle: null,
    nextViPresentCycle: null,
    nextViTimingBoundaryCycle: null,
    peFinishCycle: null,
    serialTransfer: null,
    viTiming: null,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "runtimeEventCycleCandidates",
      "nextRuntimeEventCycle",
      "nextStableWaitEventCycle",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.scheduler-idle-audio.js" },
  );

  assert.equal(
    context.nextRuntimeEventCycle(false),
    105,
    "ordinary scheduling retains per-sample and per-block observability",
  );
  assert.equal(
    context.nextRuntimeEventCycle(false, true),
    120,
    "idle projection retains the DSP initial AID before either completion",
  );
  assert.equal(
    context.nextStableWaitEventCycle(
      true,
      2,
      context.blockPattern.idleVolatileRead === context.blockPattern.idleBasic,
    ),
    105,
    "a volatile-register poll must observe the next raw audio transition",
  );
  assert.equal(
    context.nextStableWaitEventCycle(
      true,
      2,
      context.blockPattern.idleBasic === context.blockPattern.idleBasic,
    ),
    120,
    "a basic self-branch may skip intermediate audio-only transitions",
  );

  context.nextDspExecutionCycle = 108;
  assert.equal(
    context.nextRuntimeEventCycle(false, true),
    108,
    "audio coalescing must retain the interpreter's exact DSP deadline",
  );
  context.nextDspExecutionCycle = null;

  context.nextDspAudioDmaInterruptCycle = null;
  assert.equal(
    context.nextRuntimeEventCycle(false, true),
    160,
    "DSP completion remains visible when its initial AID has fired",
  );
  assert.match(
    source,
    /const coalesceIdleAudio = semanticIdle\s*&& block\.pattern === blockPattern\.idleBasic;/,
    "the runner must never enable audio projection for idleVolatileRead",
  );
  assert.match(
    source,
    /const exactDeviceEventCycle = coalesceIdleAudio\s*\? nextStableWaitEventCycle\(semanticIdle, samePcCount, false\)\s*: null;/,
    "the runner must retain the raw deadline only for a basic idle projection",
  );
});

test("idle acceleration diagnostics preserve aggregates and isolate audio projection", () => {
  const context = {
    accelerations: new Map(),
    blockPattern: { idleBasic: 2, idleVolatileRead: 3 },
    hex32: value => `0x${(value >>> 0).toString(16).padStart(8, "0")}`,
    lastIdleAudioCoalescedJump: null,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("recordIdleToInterruptAcceleration"), context, {
    filename: "browser_boot.scheduler-idle-audio-diagnostics.js",
  });

  context.recordIdleToInterruptAcceleration(
    context.blockPattern.idleVolatileRead,
    0x8000_1000,
    null,
    105,
    5,
  );
  assert.equal(context.accelerations.get("idleToInterruptCycles"), 5);
  assert.equal(context.accelerations.get("idleToInterruptJumps"), 1);
  assert.equal(context.accelerations.get("idleVolatileReadToInterruptCycles"), 5);
  assert.equal(context.accelerations.get("idleVolatileReadToInterruptJumps"), 1);
  assert.equal(context.accelerations.get("idleAudioCoalescedCycles"), undefined);
  assert.equal(context.accelerations.get("idleAudioCoalescedJumps"), undefined);
  assert.equal(context.lastIdleAudioCoalescedJump, null);

  context.recordIdleToInterruptAcceleration(
    context.blockPattern.idleBasic,
    0x8000_2000,
    110,
    170,
    70,
  );
  assert.equal(context.accelerations.get("idleToInterruptCycles"), 75);
  assert.equal(context.accelerations.get("idleToInterruptJumps"), 2);
  assert.equal(context.accelerations.get("idleBasicToInterruptCycles"), 70);
  assert.equal(context.accelerations.get("idleBasicToInterruptJumps"), 1);
  assert.equal(context.accelerations.get("idleAudioCoalescedCycles"), 60);
  assert.equal(context.accelerations.get("idleAudioCoalescedJumps"), 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.lastIdleAudioCoalescedJump)),
    {
      pc: "0x80002000",
      pattern: "idleBasic",
      exactCycle: 110,
      chosenCycle: 170,
      skippedCycles: 70,
    },
  );

  const retainedWitness = context.lastIdleAudioCoalescedJump;
  context.recordIdleToInterruptAcceleration(
    context.blockPattern.idleBasic,
    0x8000_3000,
    200,
    200,
    30,
  );
  assert.equal(context.accelerations.get("idleBasicToInterruptCycles"), 100);
  assert.equal(context.accelerations.get("idleBasicToInterruptJumps"), 2);
  assert.equal(context.accelerations.get("idleAudioCoalescedCycles"), 60);
  assert.equal(context.accelerations.get("idleAudioCoalescedJumps"), 1);
  assert.equal(
    context.lastIdleAudioCoalescedJump,
    retainedWitness,
    "a non-projected idle jump must not replace the bounded coalescing witness",
  );
  assert.match(
    source,
    /idleAcceleration: \{\s*lastAudioCoalescedJump: lastIdleAudioCoalescedJump,\s*\}/,
    "snapshots must publish exactly one retained audio-coalescing witness",
  );
  assert.match(
    source,
    /recordIdleToInterruptAcceleration\(\s*block\.pattern,\s*executedPc,\s*exactDeviceEventCycle,\s*wakeCycle,\s*skipped\s*\)/,
    "a finite debug cycle limit must report only the projection span actually taken",
  );
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
