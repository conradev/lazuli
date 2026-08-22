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

// Exact GMBE8P SDK callsite/helper pair; the decoder remains relocatable and
// the same instruction bodies are shared by every restored corpus DOL.
const WAIT_PC = 0x800d4a54;
const HELPER_PC = 0x800d4778;
const DSP_SEND_MAILBOX = 0xcc005000;
const CALLER_SUFFIX = [0x28030000, 0x4082fff8];
const HELPER_WORDS = [
  0x3c60cc00,
  0xa0035000,
  0x54038ffe,
  0x4e800020,
];

function relativeBranch(address, target, link) {
  const displacement = (target - address) & 0x03fffffc;
  return (0x48000000 | displacement | (link ? 1 : 0)) >>> 0;
}

function instructionWords(waitPc = WAIT_PC, helperPc = HELPER_PC) {
  return new Map([
    [waitPc, relativeBranch(waitPc, helperPc, true)],
    [waitPc + 4, CALLER_SUFFIX[0]],
    [waitPc + 8, CALLER_SUFFIX[1]],
    ...HELPER_WORDS.map((word, index) => [helperPc + index * 4, word]),
  ]);
}

function decoderContext(
  words = instructionWords(),
  helperPc = HELPER_PC,
  helperPattern = 4,
) {
  const blocks = new Map();
  if (helperPattern !== null) blocks.set(helperPc, { pattern: helperPattern });
  const context = {
    blockPattern: { dspSendMailboxStatus: 4 },
    compiledBlock(address) {
      return blocks.get(address >>> 0);
    },
    probeInstructionWord(address) {
      return words.get(address >>> 0) ?? null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "decodeRelativeBranchTarget",
      "instructionWordsMatch",
      "decodeDspSendMailboxWait",
      "isDspSendMailboxWaitCandidate",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-send-wait-decoder.js" },
  );
  return context;
}

test("decoder authenticates the exact caller and helper words", () => {
  const context = decoderContext();
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.decodeDspSendMailboxWait(WAIT_PC))),
    { helperAddress: HELPER_PC },
  );
  assert.equal(context.isDspSendMailboxWaitCandidate(WAIT_PC), true);

  assert.equal(
    decoderContext(instructionWords(), HELPER_PC, null)
      .isDspSendMailboxWaitCandidate(WAIT_PC),
    true,
    "structural recognition remains available before compilation",
  );
  assert.equal(
    decoderContext(instructionWords(), HELPER_PC, 3)
      .isDspSendMailboxWaitCandidate(WAIT_PC),
    true,
    "the dynamic gate, rather than structural decoding, owns JIT freshness",
  );
});

test("decoder preserves the exact relative call graph after relocation", () => {
  const delta = 0x00100000;
  const waitPc = (WAIT_PC + delta) >>> 0;
  const helperPc = (HELPER_PC + delta) >>> 0;
  const context = decoderContext(
    instructionWords(waitPc, helperPc),
    helperPc,
  );
  const decoded = context.decodeDspSendMailboxWait(waitPc);

  assert.notEqual(decoded, null);
  assert.equal(decoded.helperAddress, helperPc);
  assert.equal(context.isDspSendMailboxWaitCandidate(waitPc), true);
});

test("decoder rejects drift in every authenticated caller and helper word", () => {
  for (const [address, word] of instructionWords()) {
    const drifted = instructionWords();
    drifted.set(address, (word ^ 0x00000004) >>> 0);
    assert.equal(
      decoderContext(drifted).decodeDspSendMailboxWait(WAIT_PC),
      null,
      `instruction at 0x${address.toString(16)}`,
    );
  }
});

test("decoder rejects missing, absolute, and unlinked call boundaries", () => {
  const cases = [
    ["missing call", null],
    ["unlinked branch", relativeBranch(WAIT_PC, HELPER_PC, false)],
    [
      "absolute branch",
      (relativeBranch(WAIT_PC, HELPER_PC, true) | 0x00000002) >>> 0,
    ],
  ];
  for (const [name, replacement] of cases) {
    const words = instructionWords();
    if (replacement === null) words.delete(WAIT_PC);
    else words.set(WAIT_PC, replacement);
    assert.equal(
      decoderContext(words).decodeDspSendMailboxWait(WAIT_PC),
      null,
      name,
    );
  }
});

function plain(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function gateContext() {
  const cpu = 0x1000;
  const mmio = 0x2000;
  const pcOffset = 4;
  const msrOffset = 8;
  const context = {
    candidate: true,
    candidatePc: WAIT_PC,
    cpControlReadEnable: 1,
    cpFifoState: { control: 0, distance: 0 },
    cpu,
    cpuPc: WAIT_PC,
    cpuSignatureValue: 0x12345678,
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    dataRange: { kind: "mapped", physical: 0x0c005000 },
    decoded: true,
    dspControl: 0,
    dspExecutionSlices: 0,
    dspLastStopReason: { code: 0, name: "instruction-budget" },
    dspReceiveMailboxHigh: 0x0071,
    dspSendMailboxHigh: 0x8071,
    dspSendMailboxWaitFullServiceLimit: 256,
    dspSendMailboxWaitFullServices: 0,
    dspSendMailboxWaitTrackedPc: WAIT_PC,
    dspSendMailboxWaitTraversalPhase: 0,
    dspSendMailboxWaitWitnessMatches: 0,
    dspSendMailboxWaitWitnessPc: null,
    dspSendMailboxWaitWitnessSignature: null,
    dueRuntimeWork: false,
    mmio,
    msr: 0x00000032,
    msrOffset,
    nextDspExecutionCycle: 200,
    nextEventCycle: 150,
    pcOffset,
    helper: { pattern: 4 },
    helperPc: HELPER_PC,
    helperCurrent: true,
    lr: (WAIT_PC + 4) >>> 0,
    r0: 0x00008000,
    r3: 1,
    blockPattern: { dspSendMailboxStatus: 4 },
    compiledBlock(address) {
      assert.equal(address, context.helperPc);
      return context.helper;
    },
    compiledBlockInstructionWordsAreCurrent(block) {
      assert.equal(block, context.helper);
      return context.helperCurrent;
    },
    cpuSignature() {
      return context.cpuSignatureValue;
    },
    decodeDspSendMailboxWait(address) {
      return context.decoded
        && context.candidate
        && address === context.candidatePc
        ? { helperAddress: context.helperPc }
        : null;
    },
    nextRuntimeEventCycle(includeCycleLimit, coalesceIdleAudio = false) {
      assert.equal(includeCycleLimit, false);
      assert.equal(coalesceIdleAudio, false);
      return context.nextEventCycle;
    },
    resolveDataRange(address, size, write, updateHistory) {
      assert.equal(address, DSP_SEND_MAILBOX);
      assert.equal(size, 2);
      assert.equal(write, false);
      assert.equal(updateHistory, false);
      return context.dataRange;
    },
    readGpr(index) {
      if (index === 0) return context.r0;
      if (index === 3) return context.r3;
      assert.fail(`unexpected GPR read at ${index}`);
    },
    readLr() {
      return context.lr;
    },
    runtimeEventDueAtOrBefore(observedCycles) {
      assert.equal(observedCycles, context.cycles);
      return context.dueRuntimeWork;
    },
    view: {
      getUint16(address, littleEndian) {
        assert.equal(littleEndian, false);
        if (address === mmio + 0x5000) return context.dspSendMailboxHigh;
        if (address === mmio + 0x5004) return context.dspReceiveMailboxHigh;
        if (address === mmio + 0x500a) return context.dspControl;
        assert.fail(`unexpected halfword read at ${address}`);
      },
      getUint32(address, littleEndian) {
        assert.equal(littleEndian, true);
        if (address === cpu + pcOffset) return context.cpuPc;
        if (address === cpu + msrOffset) return context.msr;
        assert.fail(`unexpected CPU read at ${address}`);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "resetDspSendMailboxWaitWitness",
      "clearDspSendMailboxWaitTracking",
      "observeDspSendMailboxWaitFixedPoint",
      "dspSendMailboxWaitWakeCycle",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-send-wait-gate.js" },
  );
  return context;
}

function authenticateFixedPoint(context, expected = { eventCycle: 150, wakeCycle: 150 }) {
  assert.equal(
    context.dspSendMailboxWaitWakeCycle(context.cpuPc),
    null,
    "the initial observation only records the fixed-point witness",
  );
  completeRealTraversal(context);
  assert.equal(
    context.dspSendMailboxWaitWakeCycle(context.cpuPc),
    null,
    "one repeated signature proves only one full traversal",
  );
  completeRealTraversal(context);
  assert.deepEqual(
    plain(context.dspSendMailboxWaitWakeCycle(context.cpuPc)),
    expected,
    "two repeated signatures prove two real full traversals",
  );
}

function completeRealTraversal(context) {
  const caller = context.candidatePc;
  context.cpuPc = context.helperPc;
  assert.equal(context.dspSendMailboxWaitWakeCycle(context.cpuPc), null);
  context.cpuPc = (caller + 4) >>> 0;
  assert.equal(context.dspSendMailboxWaitWakeCycle(context.cpuPc), null);
  context.cpuPc = caller;
}

async function completeRunnerTraversal(context) {
  const caller = context.candidatePc;
  context.cpuPc = context.helperPc;
  context.pc = context.cpuPc;
  assert.equal(
    await context.accelerateDspSendMailboxWait(context.cpuPc),
    false,
  );
  context.cpuPc = (caller + 4) >>> 0;
  context.pc = context.cpuPc;
  assert.equal(
    await context.accelerateDspSendMailboxWait(context.cpuPc),
    false,
  );
  context.cpuPc = caller;
  context.pc = caller;
}

function seedAuthenticatedFixedPoint(context) {
  context.dspSendMailboxWaitWitnessPc = context.cpuPc;
  context.dspSendMailboxWaitWitnessSignature = context.cpuSignatureValue;
  context.dspSendMailboxWaitWitnessMatches = 2;
  context.dspSendMailboxWaitTraversalPhase = 3;
}

test("gate requires two identical CPU fixed-point traversals after recording", () => {
  const context = gateContext();
  authenticateFixedPoint(context);
  assert.equal(context.dspSendMailboxWaitWitnessPc, WAIT_PC);
  assert.equal(
    context.dspSendMailboxWaitWitnessSignature,
    context.cpuSignatureValue,
  );
  assert.equal(context.dspSendMailboxWaitWitnessMatches, 2);

  context.cpuSignatureValue ^= 0x00000001;
  assert.equal(context.dspSendMailboxWaitWakeCycle(WAIT_PC), null);
  assert.equal(context.dspSendMailboxWaitWitnessMatches, 0);
  completeRealTraversal(context);
  assert.equal(context.dspSendMailboxWaitWakeCycle(WAIT_PC), null);
  completeRealTraversal(context);
  assert.notEqual(context.dspSendMailboxWaitWakeCycle(WAIT_PC), null);
});

test("gate chooses the earliest real event and respects the debug cycle cap", () => {
  const context = gateContext();
  context.cycleLimit = 125;
  authenticateFixedPoint(context, { eventCycle: 150, wakeCycle: 125 });

  context.cycleLimit = Number.POSITIVE_INFINITY;
  context.nextEventCycle = context.nextDspExecutionCycle;
  assert.deepEqual(
    plain(context.dspSendMailboxWaitWakeCycle(WAIT_PC)),
    { eventCycle: 200, wakeCycle: 200 },
    "the exact DSP deadline is an allowed event",
  );
});

test("gate rejects unauthenticated CPU, MMIO, DSP, and scheduler state", () => {
  const cases = [
    ["runtime work due now", context => { context.dueRuntimeWork = true; }],
    ["actionable CP FIFO", context => {
      context.cpFifoState = { control: 1, distance: 32 };
    }],
    ["CPU PC mismatch", context => { context.cpuPc += 4; }],
    ["EE enabled", context => { context.msr |= 0x00008000; }],
    ["link register is not the post-call address", context => {
      context.lr = WAIT_PC;
    }],
    ["helper result is not FULL", context => { context.r3 = 0; }],
    ["retained raw mailbox word is not FULL", context => {
      context.r0 = 0;
    }],
    ["send mailbox remapped", context => {
      context.dataRange = { kind: "mapped", physical: 0x00005000 };
    }],
    ["send mailbox faults", context => {
      context.dataRange = { kind: "page-fault" };
    }],
    ["send mailbox no longer full", context => {
      context.dspSendMailboxHigh &= ~0x8000;
    }],
    ["DSP receive mailbox is full", context => {
      context.dspReceiveMailboxHigh |= 0x8000;
    }],
    ["DSP HALT asserted", context => { context.dspControl |= 0x0004; }],
    ["DSP stopped for an unrelated reason", context => {
      context.dspLastStopReason = { code: 1, name: "halted" };
    }],
    ["no DSP deadline", context => { context.nextDspExecutionCycle = null; }],
    ["DSP deadline already due", context => {
      context.nextDspExecutionCycle = context.cycles;
    }],
    ["signature or compiled pattern drift", context => {
      context.candidate = false;
    }],
    ["helper JIT pattern drift", context => {
      context.helper = { pattern: 3 };
    }],
    ["helper instruction dependency drift", context => {
      context.helperCurrent = false;
    }],
    ["no runtime event", context => { context.nextEventCycle = null; }],
    ["runtime event already due", context => {
      context.nextEventCycle = context.cycles;
    }],
    ["scheduler crosses DSP deadline", context => {
      context.nextEventCycle = context.nextDspExecutionCycle + 1;
    }],
    ["debug cap already reached", context => {
      context.cycleLimit = context.cycles;
    }],
  ];

  for (const [name, mutate] of cases) {
    const context = gateContext();
    seedAuthenticatedFixedPoint(context);
    mutate(context);
    assert.equal(
      context.dspSendMailboxWaitWakeCycle(WAIT_PC),
      null,
      name,
    );
  }
});

test("gate admits both live and CPU-mailbox-empty DSP stop boundaries", () => {
  for (const stopReason of [
    { code: 0, name: "instruction-budget" },
    { code: 3, name: "cpu-mailbox-empty" },
  ]) {
    const context = gateContext();
    context.dspLastStopReason = stopReason;
    seedAuthenticatedFixedPoint(context);
    assert.notEqual(
      context.dspSendMailboxWaitWakeCycle(WAIT_PC),
      null,
      stopReason.name,
    );
  }
});

test("queued CP bytes remain latent only while FIFO reads are disabled", () => {
  const context = gateContext();
  seedAuthenticatedFixedPoint(context);
  context.cpFifoState = { control: 0, distance: 32 };
  assert.notEqual(context.dspSendMailboxWaitWakeCycle(WAIT_PC), null);

  context.cpFifoState = { control: 1, distance: 0 };
  assert.notEqual(context.dspSendMailboxWaitWakeCycle(WAIT_PC), null);

  context.cpFifoState = { control: 1, distance: 32 };
  assert.equal(context.dspSendMailboxWaitWakeCycle(WAIT_PC), null);
});

test("changing call sites resets both fixed-point and liveness tracking", () => {
  const context = gateContext();
  seedAuthenticatedFixedPoint(context);
  context.dspSendMailboxWaitFullServices = 17;
  context.dspSendMailboxWaitTrackedPc = WAIT_PC;
  context.cpuPc = (WAIT_PC + 0x100) >>> 0;
  context.candidatePc = context.cpuPc;
  context.helperPc = (HELPER_PC + 0x100) >>> 0;
  context.lr = (context.cpuPc + 4) >>> 0;

  assert.equal(context.dspSendMailboxWaitWakeCycle(context.cpuPc), null);
  assert.equal(context.dspSendMailboxWaitTrackedPc, context.cpuPc);
  assert.equal(context.dspSendMailboxWaitFullServices, 0);
  assert.equal(context.dspSendMailboxWaitWitnessPc, context.cpuPc);
  assert.equal(context.dspSendMailboxWaitWitnessMatches, 0);
});

test("unrelated control flow expires fixed-point and liveness evidence", () => {
  const context = gateContext();
  authenticateFixedPoint(context);
  context.dspSendMailboxWaitFullServices = 17;

  context.cpuPc = 0x80001000;
  assert.equal(context.dspSendMailboxWaitWakeCycle(context.cpuPc), null);
  assert.equal(context.dspSendMailboxWaitTrackedPc, null);
  assert.equal(context.dspSendMailboxWaitFullServices, 0);
  assert.equal(context.dspSendMailboxWaitWitnessPc, null);
  assert.equal(context.dspSendMailboxWaitWitnessMatches, 0);
  assert.equal(context.dspSendMailboxWaitTraversalPhase, 0);

  context.cpuPc = WAIT_PC;
  assert.equal(context.dspSendMailboxWaitWakeCycle(WAIT_PC), null);
  assert.equal(context.dspSendMailboxWaitWitnessPc, WAIT_PC);
  assert.equal(context.dspSendMailboxWaitWitnessMatches, 0);
  assert.equal(context.dspSendMailboxWaitTraversalPhase, 1);
});

test("accelerator awaits disk, services MMIO, then reloads PC and witness", async () => {
  const order = [];
  let deliveredPc = WAIT_PC;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    dspExecutionSlices: 4,
    dspSendMailboxHigh: 0x8071,
    dspSendMailboxWaitFullServices: 7,
    dspSendMailboxWaitTrackedPc: WAIT_PC,
    dspSendMailboxWaitWitnessMatches: 2,
    dspSendMailboxWaitWitnessPc: WAIT_PC,
    dspSendMailboxWaitWitnessSignature: 0x12345678,
    mmio: 0,
    pc: WAIT_PC,
    pcOffset: 4,
    dspSendMailboxWaitWakeCycle() {
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
      context.dspSendMailboxHigh &= ~0x8000;
      deliveredPc = 0x8008de34;
    },
    view: {
      getUint16(address, littleEndian) {
        assert.equal(address, 0x5000);
        assert.equal(littleEndian, false);
        return context.dspSendMailboxHigh;
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
    [
      "resetDspSendMailboxWaitWitness",
      "accelerateDspSendMailboxWait",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-send-wait-accelerator.js" },
  );

  assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), true);
  assert.deepEqual(order, [
    "disk-probe",
    "disk-ready",
    "service-mmio",
    "reload-pc",
  ]);
  assert.equal(context.cycles, 125);
  assert.equal(context.pc, 0x8008de34);
  assert.equal(context.dspSendMailboxWaitWitnessPc, null);
  assert.equal(context.dspSendMailboxWaitWitnessSignature, null);
  assert.equal(context.dspSendMailboxWaitWitnessMatches, 0);
  assert.equal(context.dspSendMailboxWaitFullServices, 0);
  assert.equal(context.accelerations.get("dspSendMailboxWaitCycles"), 25);
  assert.equal(context.accelerations.get("dspSendMailboxWaitJumps"), 1);
});

test("cycle cap advances without service, PC reload, or witness invalidation", async () => {
  let services = 0;
  let reloads = 0;
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    dspExecutionSlices: 4,
    dspSendMailboxWaitFullServices: 7,
    dspSendMailboxWaitWitnessMatches: 2,
    dspSendMailboxWaitWitnessPc: WAIT_PC,
    dspSendMailboxWaitWitnessSignature: 0x12345678,
    mmio: 0,
    pc: WAIT_PC,
    pcOffset: 4,
    dspSendMailboxWaitWakeCycle() {
      return { eventCycle: 150, wakeCycle: 125 };
    },
    dueDiskTransferPromise() {
      assert.fail("no disk event is due at the debug cap");
    },
    serviceMmio() { services += 1; },
    view: {
      getUint16() { assert.fail("FULL must not be sampled without DSP service"); },
      getUint32() {
        reloads += 1;
        return 0;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "resetDspSendMailboxWaitWitness",
      "accelerateDspSendMailboxWait",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-send-wait-cycle-cap.js" },
  );

  assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), true);
  assert.equal(context.cycles, 125);
  assert.equal(context.pc, WAIT_PC);
  assert.equal(services, 0);
  assert.equal(reloads, 0);
  assert.equal(context.dspSendMailboxWaitWitnessPc, WAIT_PC);
  assert.equal(context.dspSendMailboxWaitWitnessSignature, 0x12345678);
  assert.equal(context.dspSendMailboxWaitWitnessMatches, 2);
  assert.equal(context.dspSendMailboxWaitFullServices, 7);
});

test("only serviced DSP slices with send FULL unchanged consume liveness budget", async () => {
  const context = {
    accelerations: new Map(),
    cpu: 0,
    cycles: 100,
    dspExecutionSlices: 4,
    dspSendMailboxHigh: 0x8071,
    dspSendMailboxWaitFullServices: 0,
    dspSendMailboxWaitWitnessMatches: 2,
    dspSendMailboxWaitWitnessPc: WAIT_PC,
    dspSendMailboxWaitWitnessSignature: 1,
    mmio: 0,
    pc: WAIT_PC,
    pcOffset: 4,
    dspSendMailboxWaitWakeCycle() {
      return { eventCycle: context.cycles + 25, wakeCycle: context.cycles + 25 };
    },
    dueDiskTransferPromise() { return null; },
    serviceMmio() {},
    view: {
      getUint16() { return context.dspSendMailboxHigh; },
      getUint32() { return WAIT_PC; },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "resetDspSendMailboxWaitWitness",
      "accelerateDspSendMailboxWait",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-send-wait-liveness.js" },
  );

  assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), true);
  assert.equal(
    context.dspSendMailboxWaitFullServices,
    0,
    "a non-DSP runtime event does not consume the DSP liveness budget",
  );

  context.dspSendMailboxWaitWitnessPc = WAIT_PC;
  context.dspSendMailboxWaitWitnessSignature = 1;
  context.dspSendMailboxWaitWitnessMatches = 2;
  context.serviceMmio = () => { context.dspExecutionSlices += 1; };
  assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), true);
  assert.equal(context.dspSendMailboxWaitFullServices, 1);

  context.dspSendMailboxWaitWitnessPc = WAIT_PC;
  context.dspSendMailboxWaitWitnessSignature = 1;
  context.dspSendMailboxWaitWitnessMatches = 2;
  context.serviceMmio = () => {
    context.dspExecutionSlices += 1;
    context.dspSendMailboxHigh &= ~0x8000;
  };
  assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), true);
  assert.equal(context.dspSendMailboxWaitFullServices, 0);
});

test("256 unchanged-FULL DSP services terminate through an exact multi-PC diagnostic", async () => {
  const context = gateContext();
  Object.assign(context, {
    accelerations: new Map(),
    blocks: new Map(),
    dispatches: 0,
    dueDiskTransferPromise() { return null; },
    async finishQuiescentAfterRendererDrain(status, report) {
      context.terminal = { report, status };
    },
    hex32(value) {
      return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
    },
    instructions: 0,
    pc: WAIT_PC,
    serviceMmio(observedCycles) {
      assert.equal(observedCycles, context.nextDspExecutionCycle);
      context.dspExecutionSlices += 1;
      context.nextDspExecutionCycle += 100;
      context.nextEventCycle = context.nextDspExecutionCycle;
    },
  });
  vm.runInContext(
    [
      "accelerateDspSendMailboxWait",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-send-wait-bounded-liveness.js" },
  );
  context.nextEventCycle = context.nextDspExecutionCycle;

  for (let service = 0; service < 256; service += 1) {
    assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), false);
    await completeRunnerTraversal(context);
    assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), false);
    await completeRunnerTraversal(context);
    assert.equal(
      await context.accelerateDspSendMailboxWait(WAIT_PC),
      true,
      `DSP deadline ${service + 1}`,
    );
  }
  assert.equal(context.dspSendMailboxWaitFullServices, 256);
  assert.equal(context.accelerations.get("dspSendMailboxWaitJumps"), 256);
  assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), false);
  await completeRunnerTraversal(context);
  assert.equal(await context.accelerateDspSendMailboxWait(WAIT_PC), false);
  await completeRunnerTraversal(context);
  await assert.rejects(
    context.accelerateDspSendMailboxWait(WAIT_PC),
    error => error === Symbol.for("reported"),
  );
  assert.equal(
    context.dspExecutionSlices,
    256,
    "the accelerator must not service a 257th unchanged-FULL deadline",
  );
  assert.deepEqual(plain(context.terminal), {
    status: "progress",
    report: {
      stage: "stable-loop",
      reason: "dsp-send-mailbox-full",
      pc: `0x${WAIT_PC.toString(16)}`,
      instructions: 0,
      cycles: context.cycles,
      dispatches: 0,
      compiledBlocks: 0,
      dspSendMailboxWaitFullServices: 256,
    },
  });
});

test("runner fences the call loop and accelerates before compilation", () => {
  assert.match(
    source,
    /dspSendMailboxStatus:\s*4/,
    "browser pattern numbers must match the ppcjit ABI",
  );
  assert.match(
    extractFunction("isRecognizedLoopPc"),
    /isDspSendMailboxWaitCandidate\(candidatePc\)/,
  );
  assert.doesNotMatch(
    extractFunction("isRecognizedLoopPc"),
    /compiledBlock\(candidatePc\)\?\.pattern === blockPattern\.dspSendMailboxStatus/,
    "one-shot status helper calls should remain eligible for region linking",
  );
  const integration = source.indexOf(
    "if (await accelerateDspSendMailboxWait(pc))",
  );
  assert.notEqual(integration, -1);
  const compilation = source.indexOf('stage = "compile"', integration);
  assert.notEqual(compilation, -1);
  assert.ok(integration < compilation);
  assert.match(
    source.slice(integration, compilation),
    /await finishTerminalControllerScenario\(\);\s*continue;/,
  );
});

test("gate and accelerator never synthesize mailbox or CPU state", () => {
  const gate = extractFunction("dspSendMailboxWaitWakeCycle");
  const accelerator = extractFunction("accelerateDspSendMailboxWait");
  assert.ok(
    accelerator.indexOf("dueDiskTransferPromise(cycles)")
      < accelerator.indexOf("serviceMmio(cycles)"),
  );
  assert.ok(
    accelerator.indexOf("serviceMmio(cycles)")
      < accelerator.indexOf("pc = view.getUint32"),
  );
  assert.doesNotMatch(
    `${gate}\n${accelerator}`,
    /view\.setUint(?:8|16|32)|writeGpr|raiseException|8071feed/i,
    "only real MMIO/DSP service may consume the CPU mailbox",
  );
});
