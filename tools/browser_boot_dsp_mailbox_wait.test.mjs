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
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name} in browser_boot.rs`);
  const asyncStart = source.lastIndexOf("async ", functionStart);
  const start = asyncStart !== -1
    && source.slice(asyncStart + 6, functionStart) === ""
      ? asyncStart
      : functionStart;
  const bodyStart = source.indexOf("{", functionStart);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

const WAIT_PC = 0x8009bd54;
const DSP_RECV = 0xcc005004;
const SIGNATURE = [
  0xa01e0000,
  0x5405043e,
  0x54000421,
  0x4182fff4,
];

function signatureWords(pc = WAIT_PC) {
  return new Map(SIGNATURE.map((word, index) => [pc + index * 4, word]));
}

function candidateContext(words = signatureWords()) {
  const context = {
    probeInstructionWord(address) {
      return words.get(address >>> 0) ?? null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("isDspReceiveMailboxWaitCandidate"),
    context,
    { filename: "browser_boot.dsp-receive-wait-candidate.js" },
  );
  return context;
}

test("Wario DSP receive wait requires the exact relocatable four-word body", () => {
  assert.equal(
    candidateContext().isDspReceiveMailboxWaitCandidate(WAIT_PC),
    true,
  );
  assert.equal(
    candidateContext(signatureWords(0x81234000))
      .isDspReceiveMailboxWaitCandidate(0x81234000),
    true,
  );
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    const words = signatureWords();
    words.set(WAIT_PC + index * 4, (SIGNATURE[index] ^ 4) >>> 0);
    assert.equal(
      candidateContext(words).isDspReceiveMailboxWaitCandidate(WAIT_PC),
      false,
      `signature word ${index}`,
    );
  }
});

function gateContext() {
  const cpu = 0x1000;
  const mmio = 0x2000;
  const pcOffset = 4;
  const msrOffset = 8;
  const context = {
    candidate: true,
    cpControlReadEnable: 1,
    cpFifoState: { control: 0, distance: 0 },
    cpu,
    cpuPc: WAIT_PC,
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    dataRange: { kind: "mapped", physical: 0x0c005004 },
    dspControl: 0,
    dspExecutedInstructions: 0,
    dspLastStopReason: { code: 0, name: "instruction-budget" },
    dspReceiveMailboxWaitNoProgressServiceLimit: 256,
    dspReceiveMailboxWaitNoProgressServices: 0,
    dspReceiveMailboxWaitTrackedPc: WAIT_PC,
    dueRuntimeWork: false,
    mailboxHigh: 0x0071,
    mmio,
    msr: 0x32,
    msrOffset,
    nextDspExecutionCycle: 200,
    nextEventCycle: 150,
    pcOffset,
    r30: DSP_RECV,
    samePcCount: 2,
    sendMailboxHigh: 0,
    isDspReceiveMailboxWaitCandidate() {
      return context.candidate;
    },
    nextRuntimeEventCycle(includeCycleLimit, coalesceIdleAudio = false) {
      assert.equal(includeCycleLimit, false);
      assert.equal(coalesceIdleAudio, false);
      return context.nextEventCycle;
    },
    readGpr(index) {
      assert.equal(index, 30);
      return context.r30;
    },
    resolveDataRange(address, size, write, updateHistory) {
      assert.equal(address, DSP_RECV);
      assert.equal(size, 2);
      assert.equal(write, false);
      assert.equal(updateHistory, false);
      return context.dataRange;
    },
    runtimeEventDueAtOrBefore(observedCycles) {
      assert.equal(observedCycles, context.cycles);
      return context.dueRuntimeWork;
    },
    view: {
      getUint16(address, littleEndian) {
        assert.equal(littleEndian, false);
        if (address === mmio + 0x5000) return context.sendMailboxHigh;
        if (address === mmio + 0x5004) return context.mailboxHigh;
        if (address === mmio + 0x500a) return context.dspControl;
        assert.fail(`unexpected halfword read at ${address}`);
      },
      getUint32(address, littleEndian) {
        assert.equal(littleEndian, true);
        if (address === cpu + pcOffset) return context.cpuPc;
        if (address === cpu + msrOffset) return context.msr;
        assert.fail(`unexpected read at ${address}`);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "dspReceiveMailboxWaitProducerBlocked",
      "dspReceiveMailboxWaitWakeCycle",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-receive-wait-gate.js" },
  );
  return context;
}

test("gate selects the earliest real event and respects a debug cycle cap", () => {
  const context = gateContext();
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.dspReceiveMailboxWaitWakeCycle(WAIT_PC),
    )),
    { eventCycle: 150, wakeCycle: 150 },
  );

  context.cycleLimit = 125;
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.dspReceiveMailboxWaitWakeCycle(WAIT_PC),
    )),
    { eventCycle: 150, wakeCycle: 125 },
  );
});

test("gate rejects unauthenticated CPU, mailbox, scheduler, and work state", () => {
  const cases = [
    ["one stable witness", context => { context.samePcCount = 1; }],
    ["runtime work due now", context => { context.dueRuntimeWork = true; }],
    ["actionable CP FIFO", context => {
      context.cpFifoState = { control: 1, distance: 32 };
    }],
    ["CPU PC mismatch", context => { context.cpuPc += 4; }],
    ["EE enabled", context => { context.msr |= 0x00008000; }],
    ["wrong receive address", context => { context.r30 += 2; }],
    ["receive address remapped", context => {
      context.dataRange = { kind: "mapped", physical: 0x00005004 };
    }],
    ["receive address faults", context => {
      context.dataRange = { kind: "page-fault" };
    }],
    ["receive mailbox already full", context => { context.mailboxHigh |= 0x8000; }],
    ["no DSP deadline", context => { context.nextDspExecutionCycle = null; }],
    ["DSP deadline already due", context => { context.nextDspExecutionCycle = 100; }],
    ["signature drift", context => { context.candidate = false; }],
    ["no runtime event", context => { context.nextEventCycle = null; }],
    ["scheduler crosses DSP deadline", context => { context.nextEventCycle = 201; }],
    ["bounded DSP no-progress services", context => {
      context.dspReceiveMailboxWaitNoProgressServices = 256;
      context.dspLastStopReason = { code: 3, name: "cpu-mailbox-empty" };
    }],
  ];

  for (const [name, mutate] of cases) {
    const context = gateContext();
    mutate(context);
    assert.equal(
      context.dspReceiveMailboxWaitWakeCycle(WAIT_PC),
      null,
      name,
    );
  }
});

test("producer-blocked state distinguishes mailbox waits and asserted HALT", () => {
  const context = gateContext();
  context.dspLastStopReason = { code: 3, name: "cpu-mailbox-empty" };
  assert.equal(context.dspReceiveMailboxWaitProducerBlocked(), true);
  context.sendMailboxHigh = 0x8000;
  assert.equal(context.dspReceiveMailboxWaitProducerBlocked(), false);
  context.sendMailboxHigh = 0;
  context.mailboxHigh = 0x8000;
  assert.equal(context.dspReceiveMailboxWaitProducerBlocked(), false);
  context.mailboxHigh = 0;
  context.dspLastStopReason = { code: 1, name: "halted" };
  context.dspControl = 0x0004;
  assert.equal(context.dspReceiveMailboxWaitProducerBlocked(), true);
  context.dspControl = 0;
  assert.equal(context.dspReceiveMailboxWaitProducerBlocked(), false);
});

test("latent PI work is allowed only while this exact loop keeps EE clear", () => {
  const context = gateContext();
  context.interruptDeliveryPendingAtCycle = () => {
    assert.fail("latent PI state is not deliverable while EE remains clear");
  };
  assert.notEqual(context.dspReceiveMailboxWaitWakeCycle(WAIT_PC), null);
  assert.doesNotMatch(
    extractFunction("dspReceiveMailboxWaitWakeCycle"),
    /interruptDeliveryPendingAtCycle/,
  );
});

test("accelerator awaits disk work, services the event, and then reloads PC", async () => {
  const order = [];
  let deliveredPc = WAIT_PC;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    dspExecutionSlices: 0,
    dspReceiveMailboxWaitNoProgressServices: 7,
    lastCpuSignature: 0x12345678,
    lastPc: WAIT_PC,
    mmio: 0,
    pc: WAIT_PC,
    pcOffset: 4,
    samePcCount: 2,
    dspReceiveMailboxWaitProducerBlocked() { return false; },
    dspReceiveMailboxWaitWakeCycle() {
      return { eventCycle: 125, wakeCycle: 125 };
    },
    dueDiskTransferPromise(observedCycles) {
      assert.equal(observedCycles, 125);
      order.push("disk-probe");
      return Promise.resolve().then(() => order.push("disk-ready"));
    },
    serviceMmio(observedCycles) {
      assert.equal(observedCycles, 125);
      order.push("service-mmio");
      context.dspExecutionSlices += 1;
      deliveredPc = 0x8009bd64;
    },
    view: {
      getUint16(address, littleEndian) {
        assert.equal(address, 0x5004);
        assert.equal(littleEndian, false);
        return 0x0071;
      },
      getUint32(address, littleEndian) {
        assert.equal(address, 4);
        assert.equal(littleEndian, true);
        order.push("reload-pc");
        return deliveredPc;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("accelerateDspReceiveMailboxWait"),
    context,
    { filename: "browser_boot.dsp-receive-wait-accelerator.js" },
  );

  assert.equal(await context.accelerateDspReceiveMailboxWait(WAIT_PC), true);
  assert.deepEqual(order, [
    "disk-probe",
    "disk-ready",
    "service-mmio",
    "reload-pc",
  ]);
  assert.equal(context.cycles, 125);
  assert.equal(context.pc, 0x8009bd64);
  assert.equal(context.lastPc, null);
  assert.equal(context.lastCpuSignature, null);
  assert.equal(context.samePcCount, 0);
  assert.equal(context.dspReceiveMailboxWaitNoProgressServices, 0);
  assert.equal(context.accelerations.get("dspReceiveMailboxWaitCycles"), 25);
  assert.equal(context.accelerations.get("dspReceiveMailboxWaitJumps"), 1);
});

test("cycle cap advances without pretending the future event was serviced", async () => {
  let services = 0;
  let reloads = 0;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    lastCpuSignature: 1,
    lastPc: WAIT_PC,
    pc: WAIT_PC,
    pcOffset: 4,
    samePcCount: 2,
    dspReceiveMailboxWaitWakeCycle() {
      return { eventCycle: 150, wakeCycle: 125 };
    },
    dueDiskTransferPromise() {
      assert.fail("no device event is due at the cycle cap");
    },
    serviceMmio() { services += 1; },
    view: {
      getUint32() {
        reloads += 1;
        return 0;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("accelerateDspReceiveMailboxWait"),
    context,
    { filename: "browser_boot.dsp-receive-wait-cycle-cap.js" },
  );

  assert.equal(await context.accelerateDspReceiveMailboxWait(WAIT_PC), true);
  assert.equal(context.cycles, 125);
  assert.equal(context.pc, WAIT_PC);
  assert.equal(services, 0);
  assert.equal(reloads, 0);
});

test("event-bounded service repeats across many quanta and stops at observed FULL", async () => {
  const words = signatureWords();
  const cpu = 0x1000;
  const mmio = 0x2000;
  const context = {
    accelerations: new Map(),
    cpControlReadEnable: 1,
    cpFifoState: { control: 0, distance: 0 },
    cpu,
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 0,
    dataRange: { kind: "mapped", physical: 0x0c005004 },
    dspControl: 0,
    dspExecutedInstructions: 0,
    dspExecutionSlices: 0,
    dspLastStopReason: { code: 0, name: "instruction-budget" },
    dspReceiveMailboxWaitNoProgressServiceLimit: 256,
    dspReceiveMailboxWaitNoProgressServices: 0,
    dspReceiveMailboxWaitTrackedPc: WAIT_PC,
    lastCpuSignature: 1,
    lastPc: WAIT_PC,
    mailboxHigh: 0x0071,
    mmio,
    msrOffset: 8,
    nextDspExecutionCycle: 768,
    pc: WAIT_PC,
    pcOffset: 4,
    samePcCount: 2,
    sendMailboxHigh: 0,
    slices: 0,
    dueDiskTransferPromise() { return null; },
    nextRuntimeEventCycle() { return context.nextDspExecutionCycle; },
    probeInstructionWord(address) { return words.get(address >>> 0) ?? null; },
    readGpr(index) { return index === 30 ? DSP_RECV : 0; },
    resolveDataRange() { return context.dataRange; },
    runtimeEventDueAtOrBefore() { return false; },
    serviceMmio(observedCycles) {
      assert.equal(observedCycles, context.nextDspExecutionCycle);
      context.slices += 1;
      context.dspExecutionSlices += 1;
      context.dspExecutedInstructions += 64;
      if (context.slices === 64) context.mailboxHigh |= 0x8000;
      context.nextDspExecutionCycle += 768;
    },
    view: {
      getUint16(address, littleEndian) {
        assert.equal(littleEndian, false);
        if (address === mmio + 0x5000) return context.sendMailboxHigh;
        if (address === mmio + 0x5004) return context.mailboxHigh;
        if (address === mmio + 0x500a) return context.dspControl;
        assert.fail(`unexpected halfword read at ${address}`);
      },
      getUint32(address, littleEndian) {
        assert.equal(littleEndian, true);
        if (address === cpu + 4) return context.pc;
        if (address === cpu + 8) return 0x32;
        assert.fail(`unexpected read at ${address}`);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "isDspReceiveMailboxWaitCandidate",
      "dspReceiveMailboxWaitProducerBlocked",
      "dspReceiveMailboxWaitWakeCycle",
      "accelerateDspReceiveMailboxWait",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-receive-wait-multiquantum.js" },
  );

  for (let slice = 0; slice < 64; slice += 1) {
    context.samePcCount = 2;
    assert.equal(
      await context.accelerateDspReceiveMailboxWait(WAIT_PC),
      true,
      `DSP slice ${slice + 1}`,
    );
  }
  assert.equal(context.slices, 64);
  assert.equal(context.mailboxHigh & 0x8000, 0x8000);
  context.samePcCount = 2;
  assert.equal(
    await context.accelerateDspReceiveMailboxWait(WAIT_PC),
    false,
    "the guest must execute and observe FULL",
  );
  assert.equal(context.accelerations.get("dspReceiveMailboxWaitJumps"), 64);
});

test("bounded CPU-mailbox-empty DSP services return control to stable-loop diagnostics", async () => {
  const context = gateContext();
  Object.assign(context, {
    accelerations: new Map(),
    dspExecutionSlices: 0,
    dspReceiveMailboxWaitNoProgressServiceLimit: 3,
    lastCpuSignature: 1,
    lastPc: WAIT_PC,
    pc: WAIT_PC,
    dueDiskTransferPromise() { return null; },
    serviceMmio(observedCycles) {
      assert.equal(observedCycles, context.nextDspExecutionCycle);
      context.dspExecutionSlices += 1;
      context.dspExecutedInstructions += 4;
      context.dspLastStopReason = { code: 3, name: "cpu-mailbox-empty" };
      context.nextDspExecutionCycle += 100;
      context.nextEventCycle = context.nextDspExecutionCycle;
    },
  });
  vm.runInContext(
    extractFunction("accelerateDspReceiveMailboxWait"),
    context,
    { filename: "browser_boot.dsp-receive-wait-no-progress.js" },
  );
  context.nextEventCycle = context.nextDspExecutionCycle;

  for (let service = 0; service < 3; service += 1) {
    context.samePcCount = 2;
    assert.equal(await context.accelerateDspReceiveMailboxWait(WAIT_PC), true);
  }
  assert.equal(context.dspReceiveMailboxWaitNoProgressServices, 3);
  context.samePcCount = 2;
  assert.equal(await context.accelerateDspReceiveMailboxWait(WAIT_PC), false);
  assert.equal(context.samePcCount, 2, "the ordinary stable witness must resume");
});

test("runner excludes the wait from regions and accelerates before compilation", () => {
  assert.match(
    extractFunction("isRecognizedLoopPc"),
    /isDspReceiveMailboxWaitCandidate\(candidatePc\)/,
  );
  const integration = source.indexOf(
    "if (await accelerateDspReceiveMailboxWait(pc))",
  );
  assert.notEqual(integration, -1);
  const compilation = source.indexOf('stage = "compile"', integration);
  assert.notEqual(compilation, -1);
  assert.ok(integration < compilation);
  assert.match(
    source.slice(integration, compilation),
    /await finishTerminalControllerScenario\(\);\s*continue;/,
  );

  const accelerator = extractFunction("accelerateDspReceiveMailboxWait");
  assert.ok(
    accelerator.indexOf("dueDiskTransferPromise(cycles)")
      < accelerator.indexOf("serviceMmio(cycles)"),
  );
  assert.ok(
    accelerator.indexOf("serviceMmio(cycles)")
      < accelerator.indexOf("pc = view.getUint32"),
  );
  assert.doesNotMatch(
    accelerator,
    /setUint16|setUint32|8071feed/i,
    "only the real DSP may publish the receive mailbox",
  );
});
