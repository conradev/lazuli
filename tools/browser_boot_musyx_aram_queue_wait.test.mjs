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

const LOOP_START = 0x800e187c;
const DISABLE_ADDRESS = 0x8009d5ac;
const RESTORE_ADDRESS = 0x8009d5d4;
const RESTORE_CALL = 0x800e19e8;
const BACKEDGE = 0x800e19ec;
const QUEUE_OWNER = 0x80370218;
const QUEUE_ADDRESS = 0x80370499;

const DISABLE_WORDS = [
  0x7c6000a6,
  0x5464045e,
  0x7c800124,
  0x54638ffe,
  0x4e800020,
];
const RESTORE_WORDS = [
  0x2c030000,
  0x7c8000a6,
  0x4182000c,
  0x60858000,
  0x48000008,
  0x5485045e,
  0x7ca00124,
  0x54838ffe,
  0x4e800020,
];

function liveInstructionWords() {
  const words = new Map([
    [LOOP_START, 0x4bfbbd31],
    [LOOP_START + 4, 0x881d0281],
    [LOOP_START + 8, 0x7c7e1b78],
    [LOOP_START + 12, 0x28000010],
    [LOOP_START + 16, 0x4080015c],
    [RESTORE_CALL, 0x4bfbbbed],
    [BACKEDGE, 0x4bfffe90],
  ]);
  DISABLE_WORDS.forEach((word, index) => {
    words.set(DISABLE_ADDRESS + index * 4, word);
  });
  RESTORE_WORDS.forEach((word, index) => {
    words.set(RESTORE_ADDRESS + index * 4, word);
  });
  return words;
}

function decoderContext(words = liveInstructionWords()) {
  const context = {
    probeInstructionWord(address) {
      return words.get(address >>> 0) ?? null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "decodeRelativeBranchTarget",
      "decodeRelativeBgeTarget",
      "instructionWordsMatch",
      "decodeMusyxAramQueueFullWait",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.musyx-aram-queue-decoder.js" },
  );
  return context;
}

test("region exclusion recognizes only the fixed relative backedge candidate", () => {
  const context = {
    word: 0x4bfffe90,
    probeInstructionWord(address) {
      assert.equal(address, BACKEDGE);
      return context.word;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("isMusyxAramQueueFullWaitBackedge"),
    context,
    { filename: "browser_boot.musyx-aram-queue-candidate.js" },
  );

  assert.equal(context.isMusyxAramQueueFullWaitBackedge(BACKEDGE), true);
  context.word = 0x4bfffe91;
  assert.equal(context.isMusyxAramQueueFullWaitBackedge(BACKEDGE), false);
  context.word = null;
  assert.equal(context.isMusyxAramQueueFullWaitBackedge(BACKEDGE), false);
});

test("decoder accepts the exact live MusyX queue-full loop and callees", () => {
  const decoded = decoderContext().decodeMusyxAramQueueFullWait(BACKEDGE);

  assert.notEqual(decoded, null);
  assert.equal(decoded.loopStart, LOOP_START);
  assert.equal(decoded.disableAddress, DISABLE_ADDRESS);
  assert.equal(decoded.restoreAddress, RESTORE_ADDRESS);
  assert.equal(decoded.queueBaseRegister, 29);
  assert.equal(decoded.queueDisplacement, 0x0281);
});

test("decoder is address-independent while preserving relative control flow", () => {
  const delta = 0x00100000;
  const words = new Map();
  const relocated = new Map([
    [LOOP_START, LOOP_START + delta],
    [DISABLE_ADDRESS, DISABLE_ADDRESS + delta],
    [RESTORE_ADDRESS, RESTORE_ADDRESS + delta],
    [RESTORE_CALL, RESTORE_CALL + delta],
    [BACKEDGE, BACKEDGE + delta],
  ]);
  for (const [address, word] of liveInstructionWords()) {
    words.set(relocated.get(address) ?? address + delta, word);
  }
  const decoded = decoderContext(words).decodeMusyxAramQueueFullWait(
    BACKEDGE + delta,
  );

  assert.notEqual(decoded, null);
  assert.equal(decoded.loopStart, LOOP_START + delta);
  assert.equal(decoded.disableAddress, DISABLE_ADDRESS + delta);
  assert.equal(decoded.restoreAddress, RESTORE_ADDRESS + delta);
});

test("decoder rejects every structural signature and callee boundary", () => {
  const cases = [
    ["linked backedge", BACKEDGE, 0x4bfffe91],
    ["disable call", LOOP_START, 0x60000000],
    ["queue load", LOOP_START + 4, 0x881d0280],
    ["saved interrupt state", LOOP_START + 8, 0x7c7f1b78],
    ["queue limit", LOOP_START + 12, 0x2800000f],
    ["full branch", LOOP_START + 16, 0x40800158],
    ["restore call", RESTORE_CALL, 0x60000000],
    ["disable callee", DISABLE_ADDRESS + 4, 0x60000000],
    ["restore callee", RESTORE_ADDRESS + 20, 0x60000000],
  ];

  for (const [name, address, word] of cases) {
    const words = liveInstructionWords();
    words.set(address, word);
    assert.equal(
      decoderContext(words).decodeMusyxAramQueueFullWait(BACKEDGE),
      null,
      name,
    );
  }
});

function wakeContext() {
  const context = {
    aramTransfer: { completionCycle: 200 },
    cpu: 0,
    cpControlReadEnable: 0x0001,
    cpFifoState: { control: 0, distance: 0 },
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    cpuPc: BACKEDGE,
    decodes: 0,
    decodeMusyxAramQueueFullWait() {
      context.decodes += 1;
      return { queueBaseRegister: 29, queueDisplacement: 0x0281 };
    },
    gprs: new Map([
      [3, 0],
      [29, QUEUE_OWNER],
      [30, 1],
    ]),
    guestEffectiveU8() {
      return 16;
    },
    lr: BACKEDGE,
    msr: 0x00008000,
    msrOffset: 0,
    interruptPending: false,
    interruptDeliveryPendingAtCycle(observedCycles) {
      assert.equal(observedCycles, context.cycles);
      return context.interruptPending;
    },
    pcOffset: 4,
    readGpr(index) {
      return context.gprs.get(index);
    },
    readLr() {
      return context.lr;
    },
    nextEvent: 150,
    nextRuntimeEventCycle(includeCycleLimit) {
      assert.equal(includeCycleLimit, false);
      return context.nextEvent;
    },
    view: {
      getUint32(address, littleEndian) {
        assert.equal(littleEndian, true);
        if (address === context.msrOffset) return context.msr;
        if (address === context.pcOffset) return context.cpuPc;
        assert.fail(`unexpected CPU read at ${address}`);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("musyxAramQueueFullWaitWakeCycle"), context, {
    filename: "browser_boot.musyx-aram-queue-gate.js",
  });
  return context;
}

test("queue-full gate accepts only the exact restored future-ARAM wait", () => {
  const context = wakeContext();
  let wait = context.musyxAramQueueFullWaitWakeCycle(BACKEDGE);
  assert.equal(wait.eventCycle, 150);
  assert.equal(wait.wakeCycle, 150);

  context.cycleLimit = 140;
  wait = context.musyxAramQueueFullWaitWakeCycle(BACKEDGE);
  assert.equal(wait.eventCycle, 150);
  assert.equal(wait.wakeCycle, 140);
});

test("queue-full gate rejects signature, queue, EE, transfer, and event boundaries", () => {
  const context = wakeContext();

  context.decodeMusyxAramQueueFullWait = () => null;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  context.decodeMusyxAramQueueFullWait = () => ({
    queueBaseRegister: 29,
    queueDisplacement: 0x0281,
  });

  for (const queueDepth of [null, 15]) {
    context.guestEffectiveU8 = () => queueDepth;
    assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  }
  context.guestEffectiveU8 = () => 16;

  context.msr = 0;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  context.msr = 0x00008000;

  context.aramTransfer = null;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  context.aramTransfer = { completionCycle: context.cycles };
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  context.aramTransfer = { completionCycle: 200 };

  context.nextEvent = null;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  context.nextEvent = context.cycles;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
});

test("queue-full gate rejects every post-restore CPU state boundary", () => {
  const context = wakeContext();
  const cases = [
    ["CPU PC", () => { context.cpuPc = BACKEDGE + 4; }],
    ["link register", () => { context.lr = BACKEDGE - 4; }],
    ["saved enable", () => { context.gprs.set(30, 0); }],
    ["restore return", () => { context.gprs.set(3, 1); }],
  ];

  for (const [name, mutate] of cases) {
    context.cpuPc = BACKEDGE;
    context.lr = BACKEDGE;
    context.gprs.set(30, 1);
    context.gprs.set(3, 0);
    mutate();
    assert.equal(
      context.musyxAramQueueFullWaitWakeCycle(BACKEDGE),
      null,
      name,
    );
  }
});

test("future ARAM and restored EE reject before structural instruction probing", () => {
  const context = wakeContext();

  context.aramTransfer = null;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  assert.equal(context.decodes, 0);

  context.aramTransfer = { completionCycle: context.cycles };
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  assert.equal(context.decodes, 0);

  context.aramTransfer = { completionCycle: 200 };
  context.msr = 0;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  assert.equal(context.decodes, 0);
});

test("due interrupts and actionable CP work reject before structural probing", () => {
  const context = wakeContext();

  context.interruptPending = true;
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  assert.equal(context.decodes, 0);

  context.interruptPending = false;
  context.cpFifoState = { control: context.cpControlReadEnable, distance: 32 };
  assert.equal(context.musyxAramQueueFullWaitWakeCycle(BACKEDGE), null);
  assert.equal(context.decodes, 0);

  context.cpFifoState = { control: 0, distance: 32 };
  assert.notEqual(
    context.musyxAramQueueFullWaitWakeCycle(BACKEDGE),
    null,
    "queued CP bytes are not actionable while reads are disabled",
  );
  context.cpFifoState = {
    control: context.cpControlReadEnable,
    distance: 0,
  };
  assert.notEqual(
    context.musyxAramQueueFullWaitWakeCycle(BACKEDGE),
    null,
    "read enable alone has no untimed work to drain",
  );
});

test("accelerator awaits disk, services MMIO, then resumes at the delivered PC", async () => {
  const order = [];
  let deliveredPc = BACKEDGE;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    lastCpuSignature: 0x12345678,
    lastPc: BACKEDGE,
    msrOffset: 0,
    pc: BACKEDGE,
    pcOffset: 4,
    samePcCount: 200,
    musyxAramQueueFullWaitWakeCycle() {
      return { eventCycle: 150, wakeCycle: 150 };
    },
    dueDiskTransferPromise(observedCycles) {
      assert.equal(observedCycles, 150);
      order.push("disk-probe");
      return Promise.resolve().then(() => {
        order.push("disk-ready");
      });
    },
    serviceMmio(observedCycles) {
      assert.equal(observedCycles, 150);
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
    extractFunction("accelerateMusyxAramQueueFullWait"),
    context,
    { filename: "browser_boot.musyx-aram-queue-accelerator.js" },
  );

  assert.equal(await context.accelerateMusyxAramQueueFullWait(BACKEDGE), true);
  assert.deepEqual(order, [
    "disk-probe",
    "disk-ready",
    "service-mmio",
    "reload-pc",
  ]);
  assert.equal(context.cycles, 150);
  assert.equal(context.pc, 0x00000500);
  assert.equal(context.lastPc, null);
  assert.equal(context.lastCpuSignature, null);
  assert.equal(context.samePcCount, 0);
  assert.equal(context.accelerations.get("musyxAramQueueFullWaitCycles"), 50);
  assert.equal(context.accelerations.get("musyxAramQueueFullWaitJumps"), 1);
});

test("a cycle-limit cap advances without servicing a future device event", async () => {
  let diskProbes = 0;
  let mmioServices = 0;
  let pcReloads = 0;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    lastCpuSignature: 0x12345678,
    lastPc: BACKEDGE,
    pc: BACKEDGE,
    pcOffset: 4,
    samePcCount: 200,
    musyxAramQueueFullWaitWakeCycle() {
      return { eventCycle: 150, wakeCycle: 140 };
    },
    dueDiskTransferPromise() {
      diskProbes += 1;
      return null;
    },
    serviceMmio() {
      mmioServices += 1;
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
    extractFunction("accelerateMusyxAramQueueFullWait"),
    context,
    { filename: "browser_boot.musyx-aram-queue-cycle-limit.js" },
  );

  assert.equal(await context.accelerateMusyxAramQueueFullWait(BACKEDGE), true);
  assert.equal(context.cycles, 140);
  assert.equal(context.pc, BACKEDGE);
  assert.equal(diskProbes, 0);
  assert.equal(mmioServices, 0);
  assert.equal(pcReloads, 0);
  assert.equal(context.accelerations.get("musyxAramQueueFullWaitCycles"), 40);
  assert.equal(context.accelerations.get("musyxAramQueueFullWaitJumps"), 1);
});

test("runner recognizes the wait before compilation and preserves the guest ISR path", () => {
  const integration = source.indexOf(
    "if (await accelerateMusyxAramQueueFullWait(pc))",
  );
  assert.notEqual(integration, -1);
  const compilation = source.indexOf('stage = "compile"', integration);
  assert.notEqual(compilation, -1);
  assert.ok(integration < compilation, "the backedge must not be compiled or executed");
  assert.match(
    source.slice(integration, compilation),
    /await finishTerminalControllerScenario\(\);\s*continue;/,
  );
  assert.match(
    extractFunction("isRecognizedLoopPc"),
    /isMusyxAramQueueFullWaitBackedge\(candidatePc\)/,
    "the backedge candidate cannot be linked into or fused through a region",
  );
  assert.match(
    extractFunction("isMusyxAramQueueFullWaitBackedge"),
    /probeInstructionWord\(candidatePc\) === 0x4bfffe90/,
    "region exclusion probes only the fixed relative backedge word",
  );

  const accelerator = extractFunction("accelerateMusyxAramQueueFullWait");
  assert.ok(
    accelerator.indexOf("serviceMmio(cycles)")
      < accelerator.indexOf("pc = view.getUint32"),
    "MMIO completion and interrupt delivery precede guest execution",
  );
  assert.doesNotMatch(accelerator, /setUint8|writeGpr|queueAddress\s*[+\-]?=/);
  assert.match(
    source,
    /function serviceDsp\(observedCycles\) \{\s*serviceDspAudioDma\(observedCycles\);\s*serviceAramDma\(observedCycles\);[\s\S]*raiseException\(cpu, 0x0500\);/,
    "the normal DSP/ARAM external interrupt remains the only callback path",
  );
});
