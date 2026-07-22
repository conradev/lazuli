#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

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

const audioFunctionNames = [
  "dspAudioDmaCyclesPerBlock",
  "dspAudioDmaBlocksLeft",
  "publishDspAudioDmaBlocksLeft",
  "assertDspAudioDmaInterrupt",
  "startDspAudioDma",
  "stopDspAudioDma",
  "resetDspAudioDma",
  "writeDspAudioDmaControl",
  "serviceDspAudioDma",
];

function audioContext() {
  const memory = new ArrayBuffer(0x10000);
  const context = {
    cycles: 1_000,
    deviceEvents: new Map(),
    dspAudioDmaEnableInterruptLatencyCycles: 200,
    dspAudioDmaRemainingBlocks: 0,
    mmio: 0,
    nextDspAudioDmaCycle: null,
    nextDspAudioDmaInterruptCycle: null,
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(audioFunctionNames.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.audio.js",
  });
  return context;
}

test("DSP audio DMA raises its initial AID and exposes zero-based blocks left", () => {
  const context = audioContext();
  const period = context.dspAudioDmaCyclesPerBlock();

  context.writeDspAudioDmaControl(0x8002);
  assert.equal(context.dspAudioDmaRemainingBlocks, 2);
  assert.equal(context.view.getUint16(0x503a, false), 1);
  assert.equal(context.nextDspAudioDmaCycle, context.cycles + period);
  assert.equal(context.nextDspAudioDmaInterruptCycle, context.cycles + 200);

  const firstBlockCycle = context.nextDspAudioDmaCycle;
  context.serviceDspAudioDma(context.nextDspAudioDmaInterruptCycle - 1);
  assert.equal(context.dspAudioDmaRemainingBlocks, 2);
  assert.equal(context.view.getUint16(0x500a, false) & 0x08, 0);

  context.serviceDspAudioDma(context.nextDspAudioDmaInterruptCycle);
  assert.equal(context.dspAudioDmaRemainingBlocks, 2);
  assert.equal(context.view.getUint16(0x500a, false) & 0x08, 0x08);
  assert.equal(context.deviceEvents.get("dspAudioDmaInitialInterrupt"), 1);
  context.view.setUint16(0x500a, 0, false);

  context.serviceDspAudioDma(firstBlockCycle);
  assert.equal(context.dspAudioDmaRemainingBlocks, 1);
  assert.equal(context.view.getUint16(0x503a, false), 0);
  assert.equal(context.view.getUint16(0x500a, false) & 0x08, 0);

  context.serviceDspAudioDma(context.nextDspAudioDmaCycle);
  assert.equal(context.dspAudioDmaRemainingBlocks, 2);
  assert.equal(context.view.getUint16(0x503a, false), 1);
  assert.equal(context.view.getUint16(0x500a, false) & 0x08, 0x08);
  assert.equal(context.deviceEvents.get("dspAudioDmaBlock"), 2);
  assert.equal(context.deviceEvents.get("dspAudioDmaComplete"), 1);
});

test("DSP audio DMA uses AIDFR bit 6 and the 32 kHz period is 1.5x the 48 kHz period", () => {
  const context = audioContext();
  context.view.setUint32(0x6c00, 0, false);
  const period48KHz = context.dspAudioDmaCyclesPerBlock();
  context.view.setUint32(0x6c00, 0x40, false);
  const period32KHz = context.dspAudioDmaCyclesPerBlock();

  assert.ok(period32KHz > period48KHz);
  assert.ok(Math.abs(period32KHz / period48KHz - 1.5) < 0.001);
});

test("clearing DSP audio DMA enable immediately cancels the in-flight timer", () => {
  const context = audioContext();
  context.writeDspAudioDmaControl(0x8002);
  const staleCompletion = context.nextDspAudioDmaCycle + 10_000_000;

  context.writeDspAudioDmaControl(0x0002);
  assert.equal(context.nextDspAudioDmaCycle, null);
  assert.equal(context.nextDspAudioDmaInterruptCycle, null);
  assert.equal(context.dspAudioDmaRemainingBlocks, 0);
  assert.equal(context.view.getUint16(0x503a, false), 0);

  context.serviceDspAudioDma(staleCompletion);
  assert.equal(context.view.getUint16(0x500a, false) & 0x08, 0);
  assert.equal(context.deviceEvents.get("dspAudioDmaInitialInterrupt"), undefined);
  assert.equal(context.deviceEvents.get("dspAudioDmaComplete"), undefined);
});

test("zero-length DSP audio DMA raises only its initial AID", () => {
  const context = audioContext();
  context.writeDspAudioDmaControl(0x8000);

  assert.equal(context.nextDspAudioDmaCycle, null);
  const initialInterruptCycle = context.nextDspAudioDmaInterruptCycle;
  assert.equal(initialInterruptCycle, context.cycles + 200);
  context.cycles += 50;
  context.writeDspAudioDmaControl(0x8000);
  assert.equal(context.nextDspAudioDmaInterruptCycle, initialInterruptCycle);
  context.serviceDspAudioDma(initialInterruptCycle);
  assert.equal(context.view.getUint16(0x500a, false) & 0x08, 0x08);
  assert.equal(context.deviceEvents.get("dspAudioDmaInitialInterrupt"), 1);

  context.view.setUint16(0x500a, 0, false);
  context.serviceDspAudioDma(Number.MAX_SAFE_INTEGER);
  assert.equal(context.view.getUint16(0x500a, false) & 0x08, 0);
  assert.equal(context.deviceEvents.get("dspAudioDmaInitialInterrupt"), 1);
  assert.equal(context.deviceEvents.get("dspAudioDmaComplete"), undefined);
});

test("DSP audio DMA control and blocks-left registers use explicit MMIO hooks", () => {
  const context = audioContext();
  context.physicalLockedCachePointer = () => null;
  context.physicalMmioPointer = () => null;
  context.physicalRamPointer = () => null;
  context.translateDataRange = address => (
    address >= 0xc0000000 ? (address - 0xc0000000) >>> 0 : address >>> 0
  );
  context.readGpr = () => 0;
  context.hex32 = value => `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
  context.lastUnmappedAccess = null;
  context.cpu = 0;
  context.pcOffset = 0;
  context.dispatches = 0;
  vm.runInContext(
    [extractFunction("readInteger"), extractFunction("writeInteger")].join("\n\n"),
    context,
    { filename: "browser_boot.audio-mmio.js" },
  );

  assert.equal(context.writeInteger(0xcc005036, 0x8003, 2), 1);
  assert.equal(context.dspAudioDmaRemainingBlocks, 3);

  const resultPointer = 0x9000;
  assert.equal(context.readInteger(0xcc00503a, resultPointer, 2), 1);
  assert.equal(context.view.getUint16(resultPointer, true), 2);
});

test("DSP audio DMA is a runtime scheduler candidate and is included in reports", () => {
  const context = {
    aramTransfer: null,
    cycleLimit: Number.POSITIVE_INFINITY,
    cycles: 100,
    decrementerPending: false,
    diskTransfer: null,
    nextDiskAudioCycle: null,
    dspScheduledMail: null,
    ensureViSchedule() {},
    nextAudioSampleCycle: () => null,
    nextDecrementerCycle: null,
    nextDspAudioDmaCycle: 125,
    nextDspAudioDmaInterruptCycle: 110,
    nextSerialPollCycle: null,
    nextViCycle: null,
    peFinishCycle: null,
    serialTransfer: null,
    viTiming: null,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("nextRuntimeEventCycle"), context, {
    filename: "browser_boot.audio-scheduler.js",
  });

  assert.equal(context.nextRuntimeEventCycle(), 110);
  assert.match(source, /dspAudioDma: \{/);
  assert.match(source, /nextInterruptCycle: nextDspAudioDmaInterruptCycle/);
  assert.match(source, /nextCycle: nextDspAudioDmaCycle/);
});

test("AID status participates in DSP interrupt masking and W1C acknowledgement", () => {
  const memory = new ArrayBuffer(0x10000);
  let interrupts = 0;
  const context = {
    cpu: 0x8000,
    deviceEvents: new Map(),
    dspScheduledMail: null,
    initializeDspAudioSystem() {},
    mmio: 0,
    msrOffset: 0,
    pushDspMail() {},
    resetDspAudioDma() {},
    resetDspMailbox() {},
    serviceAramDma() {},
    serviceDspAudioDma() {},
    traceDsp() {},
    view: new DataView(memory),
  };
  context.raiseException = registers => {
    interrupts += 1;
    const msr = context.view.getUint32(registers + context.msrOffset, true);
    context.view.setUint32(registers + context.msrOffset, msr & ~0x00008000, true);
  };
  context.view.setUint32(context.cpu, 0x00008000, true);
  context.view.setUint32(0x3004, 0x00000040, false);
  context.view.setUint16(0x500a, 0x0018, false);
  vm.createContext(context);
  vm.runInContext(
    [extractFunction("serviceDsp"), extractFunction("writeDspControl")].join("\n\n"),
    context,
    { filename: "browser_boot.audio-interrupt.js" },
  );

  context.serviceDsp(0);
  context.serviceDsp(0);
  assert.equal(interrupts, 1);
  assert.equal(context.view.getUint32(0x3000, false) & 0x40, 0x40);

  context.writeDspControl(0x0018);
  assert.equal(context.view.getUint16(0x500a, false), 0x0010);
  context.serviceDsp(0);
  assert.equal(context.view.getUint32(0x3000, false) & 0x40, 0);

  context.view.setUint16(0x500a, 0x0018, false);
  context.view.setUint32(context.cpu, 0x00008000, true);
  context.serviceDsp(0);
  assert.equal(interrupts, 2);
});

test("DSP level interrupt re-enters with overlapping sources until every source is acknowledged", () => {
  const memory = new ArrayBuffer(0x10000);
  let interrupts = 0;
  const context = {
    cpu: 0x8000,
    deviceEvents: new Map(),
    dspScheduledMail: null,
    initializeDspAudioSystem() {},
    mmio: 0,
    msrOffset: 0,
    pushDspMail() {},
    resetDspAudioDma() {},
    resetDspMailbox() {},
    serviceAramDma() {},
    serviceDspAudioDma() {},
    traceDsp() {},
    view: new DataView(memory),
  };
  context.raiseException = registers => {
    interrupts += 1;
    const msr = context.view.getUint32(registers + context.msrOffset, true);
    context.view.setUint32(registers + context.msrOffset, msr & ~0x00008000, true);
  };
  vm.createContext(context);
  vm.runInContext(
    [extractFunction("serviceDsp"), extractFunction("writeDspControl")].join("\n\n"),
    context,
    { filename: "browser_boot.audio-level-interrupt.js" },
  );

  // AID (0x08/0x10) and DSP mailbox (0x80/0x100) are both asserted and enabled.
  context.view.setUint32(0x3004, 0x00000040, false);
  context.view.setUint16(0x500a, 0x0198, false);
  context.view.setUint32(context.cpu, 0x00008000, true);
  context.serviceDsp(0);
  assert.equal(interrupts, 1);

  // Returning from the handler with EE restored must re-enter while the level remains high.
  context.view.setUint32(context.cpu, 0x00008000, true);
  context.serviceDsp(0);
  assert.equal(interrupts, 2);

  // Acknowledge only DSP mailbox status; AID continues to hold the interrupt level high.
  context.writeDspControl(0x0190);
  assert.equal(context.view.getUint16(0x500a, false), 0x0118);
  context.view.setUint32(context.cpu, 0x00008000, true);
  context.serviceDsp(0);
  assert.equal(interrupts, 3);
  assert.equal(context.view.getUint32(0x3000, false) & 0x40, 0x40);

  // Once AID is acknowledged too, the PI DSP cause drops and delivery stops.
  context.writeDspControl(0x0118);
  assert.equal(context.view.getUint16(0x500a, false), 0x0110);
  context.view.setUint32(context.cpu, 0x00008000, true);
  context.serviceDsp(0);
  assert.equal(interrupts, 3);
  assert.equal(context.view.getUint32(0x3000, false) & 0x40, 0);
});

test("AX command-list mail schedules the existing DSP completion reply", () => {
  const context = {
    cycles: 10_000,
    deviceEvents: new Map(),
    dspAxCommandListPending: false,
    dspMode: "ax",
    dspRomParameter: null,
    dspScheduledMail: null,
    dspUcodeBooted: true,
    pushDspMail() {},
    resetDspMailbox() {},
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("handleDspCpuMail"), context, {
    filename: "browser_boot.audio-ax.js",
  });

  context.handleDspCpuMail(0xbabe0180);
  assert.equal(context.dspAxCommandListPending, true);
  context.handleDspCpuMail(0x80123460);
  assert.deepEqual(
    { ...context.dspScheduledMail },
    { mail: 0xdcd10002, completionCycle: 12_500 },
  );
  assert.equal(context.deviceEvents.get("dspAxCommandList"), 1);
});
