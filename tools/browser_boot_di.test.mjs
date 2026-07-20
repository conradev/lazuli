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
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function makeContext() {
  const memory = new ArrayBuffer(0x10000);
  const context = {
    bytes: new Uint8Array(memory),
    view: new DataView(memory),
    mmio: 0,
    cpu: 0x8000,
    msrOffset: 0,
    cycles: 0,
    cycleLimit: Number.POSITIVE_INFINITY,
    viCpuCyclesPerSecond: 486_000_000,
    viTiming: null,
    nextViCycle: null,
    nextSerialPollCycle: null,
    nextDecrementerCycle: null,
    diskTransfer: null,
    serialTransfer: null,
    peFinishCycle: null,
    dspScheduledMail: null,
    nextDspAudioDmaInterruptCycle: null,
    nextDspAudioDmaCycle: null,
    aramTransfer: null,
    diskReadBytes: 0,
    diskHashedBytes: 0,
    diskReadHash: 0,
    discSource: null,
    deviceEvents: new Map(),
    diBreakRequest: 0x00000001,
    diInterruptMasks: 0x0000002a,
    diInterruptStatuses: 0x00000054,
    diDeviceErrorInterrupt: 0x00000004,
    diTransferInterrupt: 0x00000010,
    diMinimumCommandLatencyCycles: 145800,
    diErrorInvalidCommand: 0x00052000,
    diErrorNoAudioBuffer: 0x00052001,
    diErrorInvalidAudioCommand: 0x00052401,
    piDiskInterruptCause: 0x00000004,
    diskLastError: 0,
    diskDriveState: 0,
    diskAudioEnabled: false,
    diskAudioBufferLength: 0,
    diskAudioStreaming: false,
    diskAudioStopAtTrackEnd: false,
    diskAudioPosition: 0,
    diskAudioStart: 0,
    diskAudioLength: 0,
    diskAudioNextStart: 0,
    diskAudioNextLength: 0,
    nextDiskAudioCycle: null,
    aiSampleCounter: 0,
    aiLastCycle: 0,
    aiInterruptDelivered: false,
    diskCommandCounts: new Map(),
    diskCommandTrace: [],
    interruptDeliveries: 0,
    check(condition, message) {
      assert.ok(condition, message);
    },
    ramPointer() {
      assert.fail("unexpected DI DMA in interrupt register test");
    },
    raiseException() {
      context.interruptDeliveries += 1;
    },
    ensureViSchedule() {},
    nextAudioSampleCycle() {
      return null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "recomputeDiskInterruptLevel",
      "writeDiskStatus",
      "diskCommandName",
      "recordDiskCommand",
      "audioCyclesPerSample",
      "updateAudioSampleCounter",
      "writeAudioControl",
      "diskAudioTiming",
      "updateDiskAudioSchedule",
      "advanceDiskAudioBlock",
      "serviceDiskAudio",
      "beginDiskCommand",
      "serviceDisk",
      "nextRuntimeEventCycle",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.di.js" },
  );
  return context;
}

function runCommand(context, command0, command1 = 0, command2 = 0, cycle = 0) {
  const { view } = context;
  view.setUint32(0x6000, 0, false);
  view.setUint32(0x6008, command0, false);
  view.setUint32(0x600c, command1, false);
  view.setUint32(0x6010, command2, false);
  view.setUint32(0x601c, 1, false);
  context.serviceDisk(cycle);
  assert.notEqual(context.diskTransfer, null, "command was not scheduled");
  const transfer = { ...context.diskTransfer };
  context.serviceDisk(transfer.completionCycle);
  assert.equal(context.diskTransfer, null, "command did not complete");
  assert.equal(view.getUint32(0x601c, false) & 1, 0, "DI TSTART stayed asserted");
  return transfer;
}

test("DI interrupt status is W1C while masks and break request are writable", () => {
  const context = makeContext();
  const { view } = context;

  view.setUint32(0x6000, 0x00000054, false);
  context.writeDiskStatus(0x0000003b);

  assert.equal(view.getUint32(0x6000, false), 0x0000006f);
  assert.equal(view.getUint32(0x3000, false) & 4, 4);

  context.writeDiskStatus(0x0000006e);
  assert.equal(view.getUint32(0x6000, false), 0x0000002a);
  assert.equal(view.getUint32(0x3000, false) & 4, 0);
});

test("DI completion remains level asserted until the guest acknowledges it", () => {
  const context = makeContext();
  const { view } = context;
  view.setUint32(0x6000, 0x0000003a, false);
  view.setUint32(0x3004, 0x00000004, false);
  view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);

  context.serviceDisk(100);
  context.serviceDisk(200);

  assert.equal(view.getUint32(0x6000, false), 0x0000003a);
  assert.equal(view.getUint32(0x3000, false) & 4, 4);
  assert.equal(context.interruptDeliveries, 2);

  context.writeDiskStatus(0x0000003a);
  context.serviceDisk(300);

  assert.equal(view.getUint32(0x6000, false), 0x0000002a);
  assert.equal(view.getUint32(0x3000, false) & 4, 0);
  assert.equal(context.interruptDeliveries, 2);
});

test("DI streaming commands configure, start, query, and stop DTK state", () => {
  const context = makeContext();
  const { view } = context;

  runCommand(context, 0xe401000a, 0, 0, 1000);
  assert.equal(context.diskAudioEnabled, true);
  assert.equal(context.diskAudioBufferLength, 10);
  assert.equal(view.getUint32(0x6000, false) & 0x10, 0x10);

  runCommand(context, 0xe1000000, 0x00004000, 0x00006000, 200000);
  assert.equal(context.diskAudioStreaming, true);
  assert.equal(context.diskAudioPosition, 0x00010000);
  assert.equal(context.diskAudioStart, 0x00010000);
  assert.equal(context.diskAudioLength, 0x00006000);

  runCommand(context, 0xe2000000, 0, 0, 400000);
  assert.equal(view.getUint32(0x6020, false), 1);
  runCommand(context, 0xe2010000, 0, 0, 600000);
  assert.equal(view.getUint32(0x6020, false), 0x00004000);
  runCommand(context, 0xe2020000, 0, 0, 800000);
  assert.equal(view.getUint32(0x6020, false), 0x00004000);
  runCommand(context, 0xe2030000, 0, 0, 1000000);
  assert.equal(view.getUint32(0x6020, false), 0x00006000);

  runCommand(context, 0xe1010000, 0, 0, 1200000);
  assert.equal(context.diskAudioStreaming, false);
  runCommand(context, 0xe4000000, 0, 0, 1400000);
  assert.equal(context.diskAudioEnabled, false);
  assert.equal(context.deviceEvents.get("diskAudioConfig"), 2);
  assert.equal(context.diskCommandCounts.get("audio-status"), 4);
});

test("DTK advances in scheduler-visible GameCube audio batches", () => {
  const context = makeContext();
  const { view } = context;
  view.setUint32(0x6c00, 3, false); // Playing at the GC streaming 48 KHz rate.

  runCommand(context, 0xe401000a, 0, 0, 1000);
  runCommand(context, 0xe1000000, 0x00005ff0, 0x00010000, 200000);

  const timing = context.diskAudioTiming();
  assert.equal(timing.blocksPerBatch, 6);
  assert.equal(timing.cyclesPerBlock, 283248);
  assert.equal(timing.cyclesPerBatch, 1699488);
  assert.equal(context.nextDiskAudioCycle, 1899488);
  assert.equal(context.nextRuntimeEventCycle(false), context.nextDiskAudioCycle);

  context.serviceDisk(context.nextDiskAudioCycle - 1);
  assert.equal(context.diskAudioPosition, 0x00017fc0);
  context.serviceDisk(context.nextDiskAudioCycle);
  assert.equal(context.diskAudioPosition, 0x00018080);
  assert.equal(context.deviceEvents.get("diskAudioBatch"), 1);
  assert.equal(context.deviceEvents.get("diskAudioBlock"), 6);

  runCommand(context, 0xe2010000, 0, 0, 1900000);
  assert.equal(view.getUint32(0x6020, false), 0x00006000);

  view.setUint32(0x6c00, 1, false);
  assert.deepEqual(
    { ...context.diskAudioTiming() },
    { blocksPerBatch: 4, cyclesPerBlock: 424872, cyclesPerBatch: 1699488 },
  );
});

test("DTK applies a queued track at the current track boundary", () => {
  const context = makeContext();
  const { view } = context;
  view.setUint32(0x6c00, 3, false);

  runCommand(context, 0xe401000a, 0, 0, 1000);
  runCommand(context, 0xe1000000, 0x00004000, 0x00000020, 200000);
  const firstBatchCycle = context.nextDiskAudioCycle;
  runCommand(context, 0xe1000000, 0x00008000, 0x00001000, 400000);

  assert.equal(context.nextDiskAudioCycle, firstBatchCycle, "queueing reset DTK cadence");
  context.serviceDisk(firstBatchCycle);

  assert.equal(context.diskAudioStart, 0x00020000);
  assert.equal(context.diskAudioLength, 0x00001000);
  assert.equal(context.diskAudioPosition, 0x000200a0);
  assert.equal(context.diskAudioStreaming, true);
  assert.equal(context.deviceEvents.get("diskAudioTrackBoundary"), 1);
});

test("DTK stop-at-track-end stops on the next boundary and cancels its event", () => {
  const context = makeContext();
  const { view } = context;
  view.setUint32(0x6c00, 3, false);

  runCommand(context, 0xe401000a, 0, 0, 1000);
  runCommand(context, 0xe1000000, 0x00004000, 0x00000020, 200000);
  const firstBatchCycle = context.nextDiskAudioCycle;
  runCommand(context, 0xe1000000, 0, 0, 400000);
  assert.equal(context.diskAudioStopAtTrackEnd, true);

  context.serviceDisk(firstBatchCycle);

  assert.equal(context.diskAudioStreaming, false);
  assert.equal(context.diskAudioStopAtTrackEnd, false);
  assert.equal(context.diskAudioPosition, 0x00010000);
  assert.equal(context.nextDiskAudioCycle, null);
  assert.equal(context.deviceEvents.get("diskAudioBlock"), 1);
  assert.equal(context.deviceEvents.get("diskAudioStoppedAtTrackEnd"), 1);

  runCommand(context, 0xe2000000, 0, 0, 2000000);
  assert.equal(view.getUint32(0x6020, false), 0);
});

test("DTK waits for AI playback and follows pause and resume", () => {
  const context = makeContext();
  const { view } = context;

  runCommand(context, 0xe401000a, 0, 0, 1000);
  runCommand(context, 0xe1000000, 0x00004000, 0x00001000, 200000);
  assert.equal(context.nextDiskAudioCycle, null);

  context.cycles = 300000;
  context.writeAudioControl(3);
  assert.equal(context.nextDiskAudioCycle, 1999488);
  assert.equal(context.nextRuntimeEventCycle(false), 1999488);

  context.cycles = 400000;
  context.writeAudioControl(2);
  assert.equal(context.nextDiskAudioCycle, null);
  context.serviceDisk(3000000);
  assert.equal(context.diskAudioPosition, 0x00010000);
  assert.equal(view.getUint32(0x6c00, false) & 1, 0);
});

test("DTK diagnostics explicitly identify hardware-state-only output", () => {
  assert.match(source, /nextDiskAudioCycle,\n\s+serialTransfer/);
  assert.match(source, /nextCycle: nextDiskAudioCycle,\n\s+\.\.\.diskAudioTiming\(\),/);
  assert.match(source, /output: "hardware-state-only"/);
});

test("DI seek, stop-motor, and request-error commands complete without DMA", () => {
  const context = makeContext();
  const { view } = context;

  const seek = runCommand(context, 0xab000000, 0x01234567, 0, 10);
  assert.equal(seek.offset, 0x048d159c);
  assert.equal(seek.interruptStatus, 0x10);

  runCommand(context, 0xe3000000, 0, 0, 200000);
  assert.equal(context.diskDriveState, 4);
  assert.equal(view.getUint32(0x6020, false), 0);

  runCommand(context, 0xe0000000, 0, 0, 400000);
  assert.equal(view.getUint32(0x6020, false), 0x04000000);
  assert.equal(context.deviceEvents.get("diskSeek"), 1);
  assert.equal(context.deviceEvents.get("diskStopMotor"), 1);
  assert.equal(context.deviceEvents.get("diskRequestError"), 1);
});

test("invalid DI subcommands and unsupported opcodes terminate with DEINT", () => {
  const context = makeContext();
  const { view } = context;
  context.diskAudioEnabled = true;

  const invalidAudio = runCommand(context, 0xe2040000, 0, 0, 1000);
  assert.equal(invalidAudio.interruptStatus, 0x04);
  assert.equal(view.getUint32(0x6000, false) & 0x04, 0x04);
  assert.equal(context.diskLastError, 0x00052401);

  runCommand(context, 0xe0000000, 0, 0, 200000);
  assert.equal(view.getUint32(0x6020, false), 0x00052401);
  assert.equal(context.diskLastError, 0);

  const unsupported = runCommand(context, 0x99000000, 0, 0, 400000);
  assert.equal(unsupported.interruptStatus, 0x04);
  assert.equal(view.getUint32(0x6000, false) & 0x04, 0x04);
  assert.equal(context.diskLastError, 0x00052000);
  assert.equal(context.deviceEvents.get("diskUnsupportedCommand"), 1);
  assert.equal(context.deviceEvents.get("diskDeviceError"), 2);
  assert.equal(context.diskCommandTrace.at(-1).outcome, "device-error");
});
