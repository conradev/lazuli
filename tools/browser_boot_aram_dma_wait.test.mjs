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

const WAIT_PC = 0x8008de24;
const STATUS_ADDRESS = 0x800d3270;
const DISABLE_ADDRESS = 0x800c60bc;
const RESTORE_ADDRESS = 0x800c60e4;
const DSP_CONTROL = 0xcc00500a;

const STATUS_PREFIX = [
  0x7c0802a6,
  0x90010004,
  0x9421fff0,
  0x93e1000c,
];
const STATUS_READ = [
  0x3c80cc00,
  0xa004500a,
  0x541f05ac,
];
const STATUS_SUFFIX = [
  0x80010014,
  0x7fe3fb78,
  0x83e1000c,
  0x38210010,
  0x7c0803a6,
  0x4e800020,
];
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
  0x54848ffe,
  0x4e800020,
];

function relativeBranch(address, target, link) {
  const displacement = (target - address) & 0x03fffffc;
  return (0x48000000 | displacement | (link ? 1 : 0)) >>> 0;
}

function instructionWords() {
  const words = new Map([
    [WAIT_PC, relativeBranch(WAIT_PC, STATUS_ADDRESS, true)],
    [WAIT_PC + 4, 0x28030000],
    [WAIT_PC + 8, 0x4082fff8],
    [STATUS_ADDRESS + 0x10,
      relativeBranch(STATUS_ADDRESS + 0x10, DISABLE_ADDRESS, true)],
    [STATUS_ADDRESS + 0x20,
      relativeBranch(STATUS_ADDRESS + 0x20, RESTORE_ADDRESS, true)],
  ]);
  STATUS_PREFIX.forEach((word, index) => {
    words.set(STATUS_ADDRESS + index * 4, word);
  });
  STATUS_READ.forEach((word, index) => {
    words.set(STATUS_ADDRESS + 0x14 + index * 4, word);
  });
  STATUS_SUFFIX.forEach((word, index) => {
    words.set(STATUS_ADDRESS + 0x24 + index * 4, word);
  });
  DISABLE_WORDS.forEach((word, index) => {
    words.set(DISABLE_ADDRESS + index * 4, word);
  });
  RESTORE_WORDS.forEach((word, index) => {
    words.set(RESTORE_ADDRESS + index * 4, word);
  });
  return words;
}

function decoderContext(words = instructionWords()) {
  const context = {
    probeInstructionWord(address) {
      return words.get(address >>> 0) ?? null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "decodeRelativeBranchTarget",
      "instructionWordsMatch",
      "decodeAramDmaBusyWait",
      "isAramDmaBusyWaitCandidate",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.aram-dma-wait-decoder.js" },
  );
  return context;
}

test("decoder accepts the exact caller, status helper, and interrupt callees", () => {
  const context = decoderContext();
  const decoded = context.decodeAramDmaBusyWait(WAIT_PC);

  assert.notEqual(decoded, null);
  assert.equal(decoded.statusAddress, STATUS_ADDRESS);
  assert.equal(decoded.disableAddress, DISABLE_ADDRESS);
  assert.equal(decoded.restoreAddress, RESTORE_ADDRESS);
  assert.equal(context.isAramDmaBusyWaitCandidate(WAIT_PC), true);
});

test("decoder preserves the exact relative call graph after relocation", () => {
  const delta = 0x00100000;
  const relocated = new Map();
  for (const [address, word] of instructionWords()) {
    relocated.set((address + delta) >>> 0, word);
  }
  const context = decoderContext(relocated);
  const decoded = context.decodeAramDmaBusyWait((WAIT_PC + delta) >>> 0);

  assert.notEqual(decoded, null);
  assert.equal(decoded.statusAddress, STATUS_ADDRESS + delta);
  assert.equal(decoded.disableAddress, DISABLE_ADDRESS + delta);
  assert.equal(decoded.restoreAddress, RESTORE_ADDRESS + delta);
});

test("decoder rejects drift in every authenticated instruction word", () => {
  for (const [address, word] of instructionWords()) {
    const drifted = instructionWords();
    drifted.set(address, (word ^ 0x00000004) >>> 0);
    assert.equal(
      decoderContext(drifted).decodeAramDmaBusyWait(WAIT_PC),
      null,
      `instruction at 0x${address.toString(16)}`,
    );
  }
});

test("decoder rejects missing, absolute, and unlinked call boundaries", () => {
  const cases = [
    ["missing caller", WAIT_PC, null],
    ["unlinked caller", WAIT_PC,
      relativeBranch(WAIT_PC, STATUS_ADDRESS, false)],
    ["absolute caller", WAIT_PC,
      (relativeBranch(WAIT_PC, STATUS_ADDRESS, true) | 2) >>> 0],
    ["missing disable call", STATUS_ADDRESS + 0x10, null],
    ["unlinked disable call", STATUS_ADDRESS + 0x10,
      relativeBranch(STATUS_ADDRESS + 0x10, DISABLE_ADDRESS, false)],
    ["missing restore call", STATUS_ADDRESS + 0x20, null],
    ["unlinked restore call", STATUS_ADDRESS + 0x20,
      relativeBranch(STATUS_ADDRESS + 0x20, RESTORE_ADDRESS, false)],
  ];

  for (const [name, address, replacement] of cases) {
    const words = instructionWords();
    if (replacement === null) words.delete(address);
    else words.set(address, replacement);
    assert.equal(
      decoderContext(words).decodeAramDmaBusyWait(WAIT_PC),
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
    aramDmaBusyWaitNeedsPoll: new Set(),
    aramTransfer: { completionCycle: 200 },
    busyControl: 0x0b50,
    cpControlReadEnable: 0x0001,
    cpFifoState: { control: 0, distance: 0 },
    cpu,
    cpuPc: WAIT_PC,
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    dataRange: { kind: "mapped", physical: 0x0c00500a },
    decoded: true,
    dueRuntimeWork: false,
    interruptPending: false,
    lr: (WAIT_PC + 4) >>> 0,
    mmio,
    msr: 0x00009032,
    msrOffset,
    nextEventCycle: 150,
    pcOffset,
    r3: 0x00000200,
    decodeAramDmaBusyWait(address) {
      assert.equal(address, WAIT_PC);
      return context.decoded
        ? { statusAddress: STATUS_ADDRESS, disableAddress: DISABLE_ADDRESS,
          restoreAddress: RESTORE_ADDRESS }
        : null;
    },
    interruptDeliveryPendingAtCycle(observedCycles) {
      assert.equal(observedCycles, context.cycles);
      return context.interruptPending;
    },
    nextRuntimeEventCycle(includeCycleLimit) {
      assert.equal(includeCycleLimit, false);
      return context.nextEventCycle;
    },
    readGpr(index) {
      assert.equal(index, 3);
      return context.r3;
    },
    readLr() {
      return context.lr;
    },
    resolveDataRange(address, size, write, updateHistory) {
      assert.equal(address, DSP_CONTROL);
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
        assert.equal(address, mmio + 0x500a);
        assert.equal(littleEndian, false);
        return context.busyControl;
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
  vm.runInContext(extractFunction("aramDmaBusyWaitWakeCycle"), context, {
    filename: "browser_boot.aram-dma-wait-gate.js",
  });
  return context;
}

test("gate chooses the earliest real event and respects the debug cycle cap", () => {
  const context = gateContext();
  assert.deepEqual(
    plain(context.aramDmaBusyWaitWakeCycle(WAIT_PC)),
    { eventCycle: 150, wakeCycle: 150 },
  );

  context.cycleLimit = 125;
  assert.deepEqual(
    plain(context.aramDmaBusyWaitWakeCycle(WAIT_PC)),
    { eventCycle: 150, wakeCycle: 125 },
  );

  context.cycleLimit = Number.POSITIVE_INFINITY;
  context.nextEventCycle = context.aramTransfer.completionCycle;
  assert.deepEqual(
    plain(context.aramDmaBusyWaitWakeCycle(WAIT_PC)),
    { eventCycle: 200, wakeCycle: 200 },
    "the authentic ARAM completion deadline is an allowed event",
  );
});

test("gate rejects unauthenticated transfer, CPU, MMIO, and scheduler state", () => {
  const cases = [
    ["no live transfer", context => { context.aramTransfer = null; }],
    ["transfer already due", context => {
      context.aramTransfer = { completionCycle: context.cycles };
    }],
    ["runtime work due", context => { context.dueRuntimeWork = true; }],
    ["interrupt deliverable", context => { context.interruptPending = true; }],
    ["actionable CP FIFO", context => {
      context.cpFifoState = { control: context.cpControlReadEnable, distance: 32 };
    }],
    ["CPU PC mismatch", context => { context.cpuPc += 4; }],
    ["EE clear", context => { context.msr &= ~0x00008000; }],
    ["link register mismatch", context => { context.lr = WAIT_PC; }],
    ["poll result is not busy", context => { context.r3 = 0; }],
    ["DSPCSR remapped", context => {
      context.dataRange = { kind: "mapped", physical: 0x0000500a };
    }],
    ["DSPCSR faults", context => {
      context.dataRange = { kind: "page-fault" };
    }],
    ["DSPCSR busy bit clear", context => { context.busyControl &= ~0x0200; }],
    ["instruction signature drift", context => { context.decoded = false; }],
    ["no future runtime event", context => { context.nextEventCycle = null; }],
    ["runtime event already due", context => {
      context.nextEventCycle = context.cycles;
    }],
    ["event crosses ARAM completion", context => {
      context.nextEventCycle = context.aramTransfer.completionCycle + 1;
    }],
    ["cycle cap already reached", context => {
      context.cycleLimit = context.cycles;
    }],
  ];

  for (const [name, mutate] of cases) {
    const context = gateContext();
    mutate(context);
    assert.equal(context.aramDmaBusyWaitWakeCycle(WAIT_PC), null, name);
  }
});

test("queued CP bytes are allowed only while FIFO reads are disabled", () => {
  const context = gateContext();
  context.cpFifoState = { control: 0, distance: 32 };
  assert.notEqual(context.aramDmaBusyWaitWakeCycle(WAIT_PC), null);

  context.cpFifoState = { control: context.cpControlReadEnable, distance: 0 };
  assert.notEqual(context.aramDmaBusyWaitWakeCycle(WAIT_PC), null);

  context.cpFifoState = {
    control: context.cpControlReadEnable,
    distance: 32,
  };
  assert.equal(context.aramDmaBusyWaitWakeCycle(WAIT_PC), null);
});

test("each serviced event hands one fresh poll back to the guest", () => {
  const context = gateContext();
  context.aramDmaBusyWaitNeedsPoll.add(WAIT_PC);

  assert.equal(context.aramDmaBusyWaitWakeCycle(WAIT_PC), null);
  assert.equal(context.aramDmaBusyWaitNeedsPoll.has(WAIT_PC), false);
  assert.notEqual(
    context.aramDmaBusyWaitWakeCycle(WAIT_PC),
    null,
    "the latch rejects exactly one authenticated runner boundary",
  );
});

test("accelerator awaits disk, services MMIO, and then reloads delivered PC", async () => {
  const order = [];
  let deliveredPc = WAIT_PC;
  const context = {
    accelerations: new Map(),
    aramDmaBusyWaitNeedsPoll: new Set(),
    cpu: 0,
    cycles: 100,
    lastCpuSignature: 0x12345678,
    lastPc: WAIT_PC,
    pc: WAIT_PC,
    pcOffset: 4,
    samePcCount: 20,
    aramDmaBusyWaitWakeCycle(address) {
      assert.equal(address, WAIT_PC);
      return { eventCycle: 150, wakeCycle: 150 };
    },
    dueDiskTransferPromise(observedCycles) {
      assert.equal(observedCycles, 150);
      order.push("disk-probe");
      return Promise.resolve().then(() => order.push("disk-ready"));
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
  vm.runInContext(extractFunction("accelerateAramDmaBusyWait"), context, {
    filename: "browser_boot.aram-dma-wait-accelerator.js",
  });

  assert.equal(await context.accelerateAramDmaBusyWait(WAIT_PC), true);
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
  assert.equal(context.aramDmaBusyWaitNeedsPoll.has(WAIT_PC), true);
  assert.equal(context.accelerations.get("aramDmaBusyWaitCycles"), 50);
  assert.equal(context.accelerations.get("aramDmaBusyWaitJumps"), 1);
});

test("cycle cap advances without servicing or synthesizing a future event", async () => {
  const context = {
    accelerations: new Map(),
    aramDmaBusyWaitNeedsPoll: new Set(),
    cpu: 0,
    cycles: 100,
    lastCpuSignature: 1,
    lastPc: WAIT_PC,
    pc: WAIT_PC,
    pcOffset: 4,
    samePcCount: 20,
    aramDmaBusyWaitWakeCycle() {
      return { eventCycle: 150, wakeCycle: 125 };
    },
    dueDiskTransferPromise() {
      assert.fail("no disk event is due at the cycle cap");
    },
    serviceMmio() {
      assert.fail("no device event is due at the cycle cap");
    },
    view: {
      getUint32() {
        assert.fail("PC must not reload before device service");
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("accelerateAramDmaBusyWait"), context, {
    filename: "browser_boot.aram-dma-wait-cycle-cap.js",
  });

  assert.equal(await context.accelerateAramDmaBusyWait(WAIT_PC), true);
  assert.equal(context.cycles, 125);
  assert.equal(context.pc, WAIT_PC);
  assert.equal(context.lastPc, null);
  assert.equal(context.lastCpuSignature, null);
  assert.equal(context.samePcCount, 0);
  assert.equal(context.aramDmaBusyWaitNeedsPoll.size, 0);
  assert.equal(context.accelerations.get("aramDmaBusyWaitCycles"), 25);
  assert.equal(context.accelerations.get("aramDmaBusyWaitJumps"), 1);
});

test("runner excludes the wait from regions and handles it before compilation", () => {
  assert.match(
    extractFunction("isRecognizedLoopPc"),
    /isAramDmaBusyWaitCandidate\(candidatePc\)/,
  );
  const integration = source.indexOf(
    "if (await accelerateAramDmaBusyWait(pc))",
  );
  assert.notEqual(integration, -1);
  const compilation = source.indexOf('stage = "compile"', integration);
  assert.notEqual(compilation, -1);
  assert.ok(integration < compilation, "the authenticated call must not execute");
  assert.match(
    source.slice(integration, compilation),
    /await finishTerminalControllerScenario\(\);\s*continue;/,
  );

  const accelerator = extractFunction("accelerateAramDmaBusyWait");
  assert.ok(
    accelerator.indexOf("dueDiskTransferPromise(cycles)")
      < accelerator.indexOf("serviceMmio(cycles)"),
  );
  assert.ok(
    accelerator.indexOf("serviceMmio(cycles)")
      < accelerator.indexOf("pc = view.getUint32"),
  );
  assert.ok(
    accelerator.indexOf("serviceMmio(cycles)")
      < accelerator.indexOf("aramDmaBusyWaitNeedsPoll.add(currentPc)"),
  );
  assert.doesNotMatch(
    accelerator,
    /setUint(?:8|16|32)|writeGpr|aramTransfer\s*=(?!=)|raiseException/,
    "the accelerator must not clear DSPCSR, publish results, or raise an ISR",
  );
  assert.doesNotMatch(
    extractFunction("aramDmaBusyWaitWakeCycle"),
    /setUint(?:8|16|32)|writeGpr|aramTransfer\s*=(?!=)|raiseException/,
    "the gate must remain observation-only",
  );

  const service = extractFunction("serviceAramDma");
  assert.match(service, /& ~0x0200/);
  assert.match(service, /aramTransfer = null/);
});
