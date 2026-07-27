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

const FIRST_HOT_PC = 0x800ae1a4;
const SECOND_HOT_PC = 0x800ae1e8;
const AISCNT_EFFECTIVE = 0xcc006c08;
const SIGNATURE = [
  0x807e0000,
  0x48000004,
  0x48000004,
  0x801e0000,
  0x7c030040,
  0x4182fff8,
];

function signatureWords(hotPc = FIRST_HOT_PC) {
  return new Map(SIGNATURE.map((word, index) => [
    hotPc - 12 + index * 4,
    word,
  ]));
}

function decoderContext(words = signatureWords()) {
  const context = {
    probeInstructionWord(address) {
      return words.get(address >>> 0) ?? null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("decodeAiSrcInitSampleCounterWait"),
    context,
    { filename: "browser_boot.ai-src-init-decoder.js" },
  );
  return context;
}

test("hot-loop candidate requires the complete three-word poll body", () => {
  const words = signatureWords();
  const context = {
    probeInstructionWord(address) {
      return words.get(address >>> 0) ?? null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("isAiSrcInitSampleCounterWaitCandidate"),
    context,
    { filename: "browser_boot.ai-src-init-candidate.js" },
  );

  assert.equal(
    context.isAiSrcInitSampleCounterWaitCandidate(FIRST_HOT_PC),
    true,
  );
  words.set(FIRST_HOT_PC + 8, 0x4182fff4);
  assert.equal(
    context.isAiSrcInitSampleCounterWaitCandidate(FIRST_HOT_PC),
    false,
  );
  assert.equal(
    context.isAiSrcInitSampleCounterWaitCandidate(SECOND_HOT_PC),
    false,
    "an absent second signature is not accepted by address alone",
  );
});

test("decoder accepts both exact retail signatures and remains relocatable", () => {
  for (const hotPc of [FIRST_HOT_PC, SECOND_HOT_PC, 0x81234100]) {
    const decoded = decoderContext(signatureWords(hotPc))
      .decodeAiSrcInitSampleCounterWait(hotPc);
    assert.notEqual(decoded, null);
    assert.equal(decoded.setupAddress, hotPc - 12);
    assert.equal(decoded.counterAddressRegister, 30);
    assert.equal(decoded.loadedCounterRegister, 0);
    assert.equal(decoded.initialCounterRegister, 3);
  }
});

test("decoder rejects drift in every baseline, padding, and poll word", () => {
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    const words = signatureWords();
    const address = FIRST_HOT_PC - 12 + index * 4;
    words.set(address, (words.get(address) ^ 4) >>> 0);
    assert.equal(
      decoderContext(words).decodeAiSrcInitSampleCounterWait(FIRST_HOT_PC),
      null,
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
    audioControl: 1,
    audioSampleCycle: 150,
    counter: 42,
    cpControlReadEnable: 1,
    cpFifoState: { control: 0, distance: 0 },
    cpu,
    cpuPc: FIRST_HOT_PC,
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    decodes: 0,
    decodeAiSrcInitSampleCounterWait() {
      context.decodes += 1;
      return {
        counterAddressRegister: 30,
        loadedCounterRegister: 0,
        initialCounterRegister: 3,
      };
    },
    dueRuntimeWork: false,
    gprs: new Map([
      [0, 42],
      [3, 42],
      [30, AISCNT_EFFECTIVE],
    ]),
    mmio,
    msr: 0,
    msrOffset,
    nextEventCycle: 150,
    nextAudioSampleCycle() {
      return context.audioSampleCycle;
    },
    nextRuntimeEventCycle(includeCycleLimit) {
      assert.equal(includeCycleLimit, false);
      return context.nextEventCycle;
    },
    pcOffset,
    readGpr(index) {
      return context.gprs.get(index);
    },
    runtimeEventDueAtOrBefore(observedCycles) {
      assert.equal(observedCycles, context.cycles);
      return context.dueRuntimeWork;
    },
    view: {
      getUint32(address, littleEndian) {
        if (address === mmio + 0x6c00) {
          assert.equal(littleEndian, false);
          return context.audioControl;
        }
        if (address === mmio + 0x6c08) {
          assert.equal(littleEndian, false);
          return context.counter;
        }
        if (address === cpu + pcOffset) {
          assert.equal(littleEndian, true);
          return context.cpuPc;
        }
        if (address === cpu + msrOffset) {
          assert.equal(littleEndian, true);
          return context.msr;
        }
        assert.fail(`unexpected read at ${address}`);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("aiSrcInitSampleCounterWaitWakeCycle"),
    context,
    { filename: "browser_boot.ai-src-init-gate.js" },
  );
  return context;
}

test("gate advances to the earliest runtime event without crossing AISCNT", () => {
  const context = gateContext();
  let wait = context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC);
  assert.equal(wait.audioSampleCycle, 150);
  assert.equal(wait.eventCycle, 150);
  assert.equal(wait.wakeCycle, 150);

  context.nextEventCycle = 125;
  wait = context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC);
  assert.equal(wait.audioSampleCycle, 150);
  assert.equal(wait.eventCycle, 125);
  assert.equal(wait.wakeCycle, 125);

  context.cycleLimit = 115;
  wait = context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC);
  assert.equal(wait.eventCycle, 125);
  assert.equal(wait.wakeCycle, 115);
});

test("device, timing, CPU, and untimed-work gates reject before full decode", () => {
  const cases = [
    ["PSTAT clear", context => { context.audioControl = 0; }],
    ["no audio deadline", context => { context.audioSampleCycle = null; }],
    ["audio already due", context => { context.audioSampleCycle = 100; }],
    ["runtime work already due", context => { context.dueRuntimeWork = true; }],
    ["actionable CP FIFO", context => {
      context.cpFifoState = { control: 1, distance: 32 };
    }],
    ["CPU PC mismatch", context => { context.cpuPc = FIRST_HOT_PC + 4; }],
    ["EE enabled", context => { context.msr = 0x00008000; }],
    ["wrong AISCNT address", context => {
      context.gprs.set(30, AISCNT_EFFECTIVE + 4);
    }],
  ];

  for (const [name, mutate] of cases) {
    const context = gateContext();
    mutate(context);
    assert.equal(
      context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
      null,
      name,
    );
    assert.equal(context.decodes, 0, `${name} must precede structural probing`);
  }
});

test("gate requires exact signature and a completed canonical poll witness", () => {
  const context = gateContext();

  context.decodeAiSrcInitSampleCounterWait = () => null;
  assert.equal(
    context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
    null,
  );
  context.decodeAiSrcInitSampleCounterWait = () => ({
    counterAddressRegister: 30,
    loadedCounterRegister: 0,
    initialCounterRegister: 3,
  });

  context.gprs.set(0, 41);
  assert.equal(
    context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
    null,
    "r0 proves at least one real lwz iteration",
  );
  context.gprs.set(0, 42);
  context.gprs.set(3, 41);
  assert.equal(
    context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
    null,
    "r3 retains the SDK baseline counter",
  );
  context.gprs.set(3, 42);
  context.counter = 43;
  assert.equal(
    context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
    null,
    "a changed AISCNT must execute the guest fallthrough",
  );
});

test("gate rejects missing or impossible scheduler ordering", () => {
  const context = gateContext();
  context.nextEventCycle = null;
  assert.equal(
    context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
    null,
  );
  context.nextEventCycle = 151;
  assert.equal(
    context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
    null,
    "the runtime scheduler may not cross the required audio deadline",
  );
});

test("pending PI and decrementer state may remain latched while EE is off", () => {
  const context = gateContext();
  context.decrementerPending = true;
  context.piInterruptPending = true;
  context.interruptDeliveryPendingAtCycle = () => {
    assert.fail("the EE-off wait must not treat latent interrupts as due work");
  };

  assert.notEqual(
    context.aiSrcInitSampleCounterWaitWakeCycle(FIRST_HOT_PC),
    null,
  );
  assert.doesNotMatch(
    extractFunction("aiSrcInitSampleCounterWaitWakeCycle"),
    /interruptDeliveryPendingAtCycle/,
  );
});

test("accelerator awaits DI and services an actual event before reloading PC", async () => {
  const order = [];
  let deliveredPc = FIRST_HOT_PC;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    lastCpuSignature: 0x12345678,
    lastPc: FIRST_HOT_PC,
    pc: FIRST_HOT_PC,
    pcOffset: 4,
    samePcCount: 200,
    aiSrcInitSampleCounterWaitWakeCycle() {
      return {
        audioSampleCycle: 150,
        eventCycle: 125,
        wakeCycle: 125,
      };
    },
    dueDiskTransferPromise(observedCycles) {
      assert.equal(observedCycles, 125);
      order.push("disk-probe");
      return Promise.resolve().then(() => order.push("disk-ready"));
    },
    serviceMmio(observedCycles) {
      assert.equal(observedCycles, 125);
      order.push("service-mmio");
      deliveredPc = 0x00000500;
    },
    view: {
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
    extractFunction("accelerateAiSrcInitSampleCounterWait"),
    context,
    { filename: "browser_boot.ai-src-init-accelerator.js" },
  );

  assert.equal(
    await context.accelerateAiSrcInitSampleCounterWait(FIRST_HOT_PC),
    true,
  );
  assert.deepEqual(order, [
    "disk-probe",
    "disk-ready",
    "service-mmio",
    "reload-pc",
  ]);
  assert.equal(context.cycles, 125);
  assert.equal(context.pc, 0x00000500);
  assert.equal(context.lastPc, null);
  assert.equal(context.lastCpuSignature, null);
  assert.equal(context.samePcCount, 0);
  assert.equal(
    context.accelerations.get("aiSrcInitSampleCounterWaitCycles"),
    25,
  );
  assert.equal(
    context.accelerations.get("aiSrcInitSampleCounterWaitJumps"),
    1,
  );
});

test("cycle-limit cap pauses without pretending a future event is due", async () => {
  let diskProbes = 0;
  let services = 0;
  let pcReloads = 0;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    lastCpuSignature: 1,
    lastPc: FIRST_HOT_PC,
    pc: FIRST_HOT_PC,
    pcOffset: 4,
    samePcCount: 2,
    aiSrcInitSampleCounterWaitWakeCycle() {
      return {
        audioSampleCycle: 150,
        eventCycle: 125,
        wakeCycle: 110,
      };
    },
    dueDiskTransferPromise() {
      diskProbes += 1;
      return null;
    },
    serviceMmio() {
      services += 1;
    },
    view: {
      getUint32() {
        pcReloads += 1;
        return 0x00000500;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("accelerateAiSrcInitSampleCounterWait"),
    context,
    { filename: "browser_boot.ai-src-init-cycle-limit.js" },
  );

  assert.equal(
    await context.accelerateAiSrcInitSampleCounterWait(FIRST_HOT_PC),
    true,
  );
  assert.equal(context.cycles, 110);
  assert.equal(context.pc, FIRST_HOT_PC);
  assert.equal(diskProbes, 0);
  assert.equal(services, 0);
  assert.equal(pcReloads, 0);
});

test("runner excludes the poll from regions and accelerates before compilation", () => {
  const recognized = extractFunction("isRecognizedLoopPc");
  assert.match(
    recognized,
    /isAiSrcInitSampleCounterWaitCandidate\(candidatePc\)/,
  );

  const integration = source.indexOf(
    "if (await accelerateAiSrcInitSampleCounterWait(pc))",
  );
  assert.notEqual(integration, -1);
  const compilation = source.indexOf('stage = "compile"', integration);
  assert.notEqual(compilation, -1);
  assert.ok(integration < compilation);
  assert.match(
    source.slice(integration, compilation),
    /await finishTerminalControllerScenario\(\);\s*continue;/,
  );

  const accelerator = extractFunction("accelerateAiSrcInitSampleCounterWait");
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
    /aiSampleCounter\s*=|setUint32\([^)]*0x6c08|writeGpr/,
    "the guest performs the final load, compare, and fallthrough",
  );
});
