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
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function createLleContext({ outcomes = [], onExec = null } = {}) {
  const memory = new ArrayBuffer(0x10000);
  const calls = [];
  let activeOutcome = null;
  let outcomeIndex = 0;
  const context = {
    browserDsp: {
      browser_dsp_exec(budget) {
        calls.push(["exec", budget]);
        activeOutcome = outcomes[outcomeIndex] ?? {};
        outcomeIndex += 1;
        onExec?.(context, budget, activeOutcome);
        return activeOutcome.executed ?? budget;
      },
      browser_dsp_stop_reason() {
        calls.push(["stop-reason"]);
        return activeOutcome?.stopCode ?? 0;
      },
      browser_dsp_pc() {
        calls.push(["pc"]);
        return activeOutcome?.pc ?? 0x0042;
      },
      browser_dsp_fault_operation() {
        calls.push(["fault-operation"]);
        return activeOutcome?.fault?.operation ?? 0;
      },
      browser_dsp_fault_address() {
        calls.push(["fault-address"]);
        return activeOutcome?.fault?.address ?? 0;
      },
      browser_dsp_fault_length() {
        calls.push(["fault-length"]);
        return activeOutcome?.fault?.length ?? 0;
      },
      browser_dsp_fault_memory_length() {
        calls.push(["fault-memory-length"]);
        return activeOutcome?.fault?.memoryLength ?? 0;
      },
    },
    calls,
    check(condition, message) {
      if (!condition) throw new Error(message);
    },
    deviceEvents: new Map(),
    dspBudgetedInstructions: 0,
    dspCpuCyclesPerInstruction: 12,
    dspCpuMailboxConsumedByDsp: 0,
    dspExecutedInstructions: 0,
    dspExecutionQuantumCpuCycles: 768,
    dspExecutionSlices: 0,
    dspInterruptAssertions: 0,
    dspLastExecutionCycle: null,
    dspLastFault: null,
    dspLastServiceCycle: 0,
    dspLastStopReason: { code: 0, name: "instruction-budget" },
    dspMailboxProduced: 0,
    dspMinimumExecutionInstructions: 64,
    dspPendingCpuCycles: 0,
    dspStopReasonCounts: new Map(),
    hex32(value) {
      return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
    },
    mmio: 0,
    nextDspExecutionCycle: 768,
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    ["dspStopReasonName", "serviceDspInterpreter"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.dsp-lle.js" },
  );
  return context;
}

function createMailboxContext() {
  const memory = new ArrayBuffer(0x10000);
  const context = {
    check(condition, message) {
      if (!condition) throw new Error(message);
    },
    deviceEvents: new Map(),
    dspCpuMailboxCommits: 0,
    dspCpuMailboxHighWrites: 0,
    dspMailboxConsumes: 0,
    dspMailboxReads: 0,
    lockedCacheReads: 0,
    lockedCacheReadBytes: 0,
    mmio: 0,
    physicalLockedCachePointer() {
      return null;
    },
    physicalMmioPointer(physical, size) {
      const offset = physical - 0x0c000000;
      return offset >= 0 && offset + size <= 0x10000 ? offset : null;
    },
    physicalRamPointer() {
      return null;
    },
    translateDataRange(address) {
      return address >>> 0;
    },
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "dspRegisterRangeOffset",
      "writeDspSendMailbox",
      "finishDspReceiveMailboxRead",
      "readInteger",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-mailbox.js" },
  );
  return context;
}

test("the browser schedules one DSP instruction per twelve CPU cycles in 64-instruction quanta", () => {
  assert.match(source, /const dspCpuCyclesPerInstruction = 12;/);
  assert.match(source, /const dspMinimumExecutionInstructions = 64;/);
  assert.match(
    source,
    /const dspExecutionQuantumCpuCycles =\s*dspCpuCyclesPerInstruction \* dspMinimumExecutionInstructions;/,
  );
  assert.match(source, /let dspLastServiceCycle = 0;/);
  assert.match(source, /let dspPendingCpuCycles = 0;/);
  assert.match(
    source,
    /let nextDspExecutionCycle = dspExecutionQuantumCpuCycles;/,
  );
});

test("the DSP threshold is exact and repeated service at one cycle is idempotent", () => {
  const context = createLleContext();

  assert.equal(context.serviceDspInterpreter(767), false);
  assert.deepEqual(context.calls, []);
  assert.equal(context.dspPendingCpuCycles, 767);
  assert.equal(context.nextDspExecutionCycle, 768);

  assert.equal(context.serviceDspInterpreter(768), true);
  assert.deepEqual(context.calls, [
    ["exec", 64],
    ["stop-reason"],
    ["pc"],
  ]);
  assert.equal(context.dspPendingCpuCycles, 0);
  assert.equal(context.nextDspExecutionCycle, 1_536);
  assert.equal(context.dspExecutionSlices, 1);
  assert.equal(context.dspBudgetedInstructions, 64);
  assert.equal(context.dspExecutedInstructions, 64);

  assert.equal(context.serviceDspInterpreter(768), false);
  assert.equal(context.calls.length, 3, "same-cycle service re-entered wasm");
  assert.equal(context.dspPendingCpuCycles, 0);
  assert.equal(context.nextDspExecutionCycle, 1_536);
});

test("an overshot deadline budgets every complete instruction and retains only the CPU remainder", () => {
  const context = createLleContext();

  assert.equal(context.serviceDspInterpreter(1_000), true);
  assert.deepEqual(context.calls, [
    ["exec", 83],
    ["stop-reason"],
    ["pc"],
  ]);
  assert.equal(context.dspPendingCpuCycles, 4);
  assert.equal(context.nextDspExecutionCycle, 1_764);
  assert.equal(context.dspBudgetedInstructions, 83);
  assert.equal(context.dspExecutedInstructions, 83);
  assert.equal(context.dspLastExecutionCycle, 1_000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.dspLastStopReason)),
    { code: 0, name: "instruction-budget" },
  );
  assert.equal(context.dspStopReasonCounts.get("instruction-budget"), 1);
});

test("an early mailbox or halt stop drops the supplied budget instead of replaying elapsed time", () => {
  const context = createLleContext({
    outcomes: [{ executed: 7, stopCode: 1, pc: 0x1234 }],
  });

  assert.equal(context.serviceDspInterpreter(1_000), true);
  assert.equal(context.dspBudgetedInstructions, 83);
  assert.equal(context.dspExecutedInstructions, 7);
  assert.equal(context.dspPendingCpuCycles, 4);
  assert.equal(context.nextDspExecutionCycle, 1_764);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.dspLastStopReason)),
    { code: 1, name: "halted" },
  );

  assert.equal(context.serviceDspInterpreter(1_000), false);
  assert.deepEqual(context.calls, [
    ["exec", 83],
    ["stop-reason"],
    ["pc"],
  ]);
});

for (const [stopCode, stopName] of [
  [4, "bus-fault"],
  [5, "not-initialized"],
  [6, "memory-not-sealed"],
]) {
  test(`DSP stop code ${stopCode} (${stopName}) is fatal`, () => {
    const fault = {
      operation: 2,
      address: 0x1020_3040,
      length: 32,
      memoryLength: 16,
    };
    const context = createLleContext({
      outcomes: [{ executed: 0, stopCode, pc: 0x0246, fault }],
    });

    assert.throws(
      () => context.serviceDspInterpreter(768),
      new RegExp(`reason=${stopName} code=${stopCode} pc=0x0246`),
    );
    assert.deepEqual(context.calls.slice(0, 3), [
      ["exec", 64],
      ["stop-reason"],
      ["pc"],
    ]);
    assert.equal(context.dspExecutionSlices, 1);
    assert.deepEqual(
      JSON.parse(JSON.stringify(context.dspLastStopReason)),
      { code: stopCode, name: stopName },
    );
    if (stopCode === 4) {
      assert.deepEqual(context.calls.slice(3), [
        ["fault-operation"],
        ["fault-address"],
        ["fault-length"],
        ["fault-memory-length"],
      ]);
      assert.deepEqual(
        JSON.parse(JSON.stringify(context.dspLastFault)),
        { ...fault, pc: 0x0246 },
      );
    } else {
      assert.equal(context.calls.length, 3);
      assert.equal(context.dspLastFault, null);
    }
  });
}

test("the first interpreter slice observes RESET_HIGH and transition telemetry comes from shared MMIO", () => {
  let controlSeenByDsp = null;
  const context = createLleContext({
    onExec(current) {
      controlSeenByDsp = current.view.getUint16(current.mmio + 0x500a, false);
      current.view.setUint16(current.mmio + 0x5000, 0x1234, false);
      current.view.setUint16(current.mmio + 0x5004, 0x9234, false);
      current.view.setUint16(
        current.mmio + 0x500a,
        controlSeenByDsp | 0x0080,
        false,
      );
    },
  });
  context.view.setUint16(0x5000, 0x9234, false);
  context.view.setUint16(0x5004, 0x1234, false);
  context.view.setUint16(0x500a, 0x0800, false);

  context.serviceDspInterpreter(768);

  assert.equal(controlSeenByDsp, 0x0800);
  assert.equal(context.dspCpuMailboxConsumedByDsp, 1);
  assert.equal(context.dspMailboxProduced, 1);
  assert.equal(context.dspInterruptAssertions, 1);
  assert.match(
    source,
    /view\.setUint16\(mmio \+ 0x500a, 0x0800, false\);/,
    "browser startup must assert native RESET_HIGH before timed execution",
  );
});

test("DSP control word and byte writes preserve DMAState and apply W1C per written lane", () => {
  const memory = new ArrayBuffer(0x10000);
  const context = {
    mmio: 0,
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    ["writeDspControl", "writeDspControlRegister"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    {
    filename: "browser_boot.dsp-control.js",
    },
  );

  context.view.setUint16(0x500a, 0x02a8, false);
  context.writeDspControl(0xffff);
  assert.equal(
    context.view.getUint16(0x500a, false),
    0x0f57,
    "software changed DMAState, retained W1C status, or lost a writable bit",
  );

  context.view.setUint16(0x500a, 0x0aa8, false);
  context.writeDspControl(0x0801);
  assert.equal(
    context.view.getUint16(0x500a, false),
    0x0aa9,
    "host cleared RESET before the interpreter could observe it",
  );

  context.view.setUint16(0x500a, 0x0aa8, false);
  assert.equal(context.writeDspControlRegister(0x0c00500a, 0x00, 1), true);
  assert.equal(
    context.view.getUint16(0x500a, false),
    0x02a8,
    "a high-byte write changed low-byte statuses or hardware DMAState",
  );

  context.view.setUint16(0x500a, 0x0aa8, false);
  assert.equal(context.writeDspControlRegister(0x0c00500b, 0x01, 1), true);
  assert.equal(
    context.view.getUint16(0x500a, false),
    0x0aa9,
    "a low-byte write cleared W1C statuses that were not acknowledged",
  );

  context.view.setUint16(0x500a, 0x0aa8, false);
  assert.equal(context.writeDspControlRegister(0x0c00500b, 0xa9, 1), true);
  assert.equal(
    context.view.getUint16(0x500a, false),
    0x0a01,
    "a low-byte write did not acknowledge only its written W1C bits",
  );
  assert.equal(context.writeDspControlRegister(0x0c005009, 0, 4), false);
  assert.match(
    extractFunction("writeInteger"),
    /physical < 0x0c00500c[\s\S]*writeDspControlRegister\(physical, value, size\)/,
    "partial DSPCSR writes bypass the range-aware control hook",
  );
});

test("a DSP interrupt asserted by wasm reaches PI in the same service boundary", () => {
  const context = createLleContext({
    onExec(current) {
      const control = current.view.getUint16(current.mmio + 0x500a, false);
      current.view.setUint16(current.mmio + 0x500a, control | 0x0180, false);
    },
  });
  Object.assign(context, {
    cpu: 0x8000,
    msrOffset: 0,
    raiseException() {
      assert.fail("masked DSP interrupt was delivered to the CPU");
    },
    serviceAramDma() {},
    serviceDspAudioDma() {},
  });
  context.view.setUint16(0x500a, 0x0800, false);
  vm.runInContext(extractFunction("serviceDsp"), context, {
    filename: "browser_boot.dsp-pi-order.js",
  });

  assert.equal(context.view.getUint32(0x3000, false) & 0x40, 0);
  context.serviceDsp(768);
  assert.equal(
    context.view.getUint32(0x3000, false) & 0x40,
    0x40,
    "PI recomputation ran before the interpreter's CSR write",
  );
  assert.match(
    extractFunction("serviceDsp"),
    /serviceDspInterpreter\(observedCycles\);[\s\S]*const control = view\.getUint16/,
  );
});

test("send-mailbox byte, halfword, and word writes set FULL only when they overlap the low half", () => {
  const cases = [
    { offset: 0, size: 1, value: 0x56, full: false, highOnly: true },
    { offset: 2, size: 1, value: 0x78, full: true, highOnly: false },
    { offset: 0, size: 2, value: 0x5678, full: false, highOnly: true },
    { offset: 1, size: 2, value: 0x5678, full: true, highOnly: false },
    { offset: 2, size: 2, value: 0x5678, full: true, highOnly: false },
    { offset: 0, size: 4, value: 0x12345678, full: true, highOnly: false },
  ];

  for (const entry of cases) {
    const context = createMailboxContext();
    context.view.setUint32(0x5000, 0x1234abcd, false);
    assert.equal(
      context.writeDspSendMailbox(
        0x0c005000 + entry.offset,
        entry.value,
        entry.size,
      ),
      true,
    );
    assert.equal(
      (context.view.getUint16(0x5000, false) & 0x8000) !== 0,
      entry.full,
      `offset=${entry.offset} size=${entry.size}`,
    );
    assert.equal(context.dspCpuMailboxCommits, entry.highOnly ? 0 : 1);
    assert.equal(context.dspCpuMailboxHighWrites, entry.highOnly ? 1 : 0);
  }

  const occupied = createMailboxContext();
  occupied.view.setUint32(0x5000, 0x9234abcd, false);
  occupied.writeDspSendMailbox(0x0c005000, 0x4567, 2);
  assert.equal(
    occupied.view.getUint16(0x5000, false),
    0xc567,
    "a high-only write cleared an already-full CPU mailbox",
  );
});

test("receive-mailbox reads return pre-clear bytes and low-half overlap consumes FULL", () => {
  const cases = [
    { offset: 0, size: 1, expected: 0x92, consumed: false },
    { offset: 1, size: 1, expected: 0x34, consumed: false },
    { offset: 2, size: 1, expected: 0x56, consumed: true },
    { offset: 0, size: 2, expected: 0x9234, consumed: false },
    { offset: 1, size: 2, expected: 0x3456, consumed: true },
    { offset: 2, size: 2, expected: 0x5678, consumed: true },
    { offset: 0, size: 4, expected: 0x92345678, consumed: true },
  ];

  for (const entry of cases) {
    const context = createMailboxContext();
    const resultPointer = 0x100;
    context.view.setUint32(0x5004, 0x92345678, false);
    assert.equal(
      context.readInteger(
        0x0c005004 + entry.offset,
        resultPointer,
        entry.size,
      ),
      1,
    );
    const returned = entry.size === 1
      ? context.view.getUint8(resultPointer)
      : entry.size === 2
        ? context.view.getUint16(resultPointer, true)
        : context.view.getUint32(resultPointer, true);
    assert.equal(returned, entry.expected, `offset=${entry.offset} size=${entry.size}`);
    assert.equal(
      (context.view.getUint16(0x5004, false) & 0x8000) === 0,
      entry.consumed,
      `offset=${entry.offset} size=${entry.size}`,
    );
    assert.equal(context.dspMailboxReads, 1);
    assert.equal(context.dspMailboxConsumes, entry.consumed ? 1 : 0);
  }

  const empty = createMailboxContext();
  const resultPointer = 0x100;
  empty.view.setUint32(0x5004, 0x12345678, false);
  assert.equal(empty.readInteger(0x0c005006, resultPointer, 2), 1);
  assert.equal(empty.view.getUint16(resultPointer, true), 0x5678);
  assert.equal(empty.dspMailboxReads, 1);
  assert.equal(empty.dspMailboxConsumes, 0);
  assert.equal(empty.deviceEvents.has("dspMailboxConsume"), false);
});

test("the browser runtime contains no synthetic DSP greeting or HLE reply path", () => {
  assert.doesNotMatch(source, /function pushDspMail\(/);
  assert.doesNotMatch(source, /function handleDspCpuMail\(/);
  assert.doesNotMatch(source, /function initializeDspAudioSystem\(/);
  assert.doesNotMatch(source, /function resetDspMailbox\(/);
  assert.doesNotMatch(source, /0x8071feed|0x80544348|0x88881111|0xdcd1000[0-9a-f]/i);
});

test("compatibility reports expose raw LLE execution and mailbox telemetry", () => {
  assert.match(
    source,
    /audioCompatibility: \{\s*dspLle: \{\s*backend: "lle-wasm",/,
  );
  for (const field of [
    "slices",
    "budgetedInstructions",
    "executedInstructions",
    "pendingCpuCycles",
    "lastServiceCycle",
    "nextExecutionCycle",
    "lastExecutionCycle",
    "lastStopReason",
    "stopReasonCounts",
    "pc",
    "fault",
    "cpuMailboxWrites",
    "cpuMailboxReads",
    "dspMailboxWrites",
    "dspMailboxReads",
    "cpuMailboxHighWrites",
    "mailboxReadAccesses",
    "dspInterruptAssertions",
  ]) {
    assert.match(source, new RegExp(`\\b${field}:?\\b`), `missing dspLle.${field}`);
  }
  assert.match(source, /browserDsp\.browser_dsp_exec\(budget\)/);
  assert.match(source, /browserDsp\.browser_dsp_stop_reason\(\)/);
  assert.match(source, /browserDsp\.browser_dsp_pc\(\)/);
  assert.match(
    extractFunction("finishTerminalControllerScenario"),
    /if \(dspLastServiceCycle !== cycles\) return;/,
    "terminal compatibility evidence can publish before DSP catches CPU time",
  );
});
