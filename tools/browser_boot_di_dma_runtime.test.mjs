#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  DI_BUFFER_TRANSFER_BYTES_PER_SECOND,
  DI_CPU_CYCLES_PER_SECOND,
  DI_DEVICE_ERROR_STATUS,
  DI_DMA_ADDRESS_MASK,
  DI_DMA_CONTROL_MASK,
  DI_DMA_LENGTH_MASK,
  DI_DMA_MEM1_BYTES,
  DI_ERROR_BLOCK_OUT_OF_BOUNDS,
  DI_ERROR_READ,
  DI_INQUIRY_COMPATIBILITY_BYTES,
  DI_MINIMUM_COMMAND_LATENCY_CYCLES,
  DI_READ_START_LATENCY_CYCLES,
  DI_TRANSFER_COMPLETE_STATUS,
  diDmaOracleVectors,
} from "./browser_boot_di_dma_oracle.mjs";
import {
  LOGICAL_DISC_SIZE_HEADER,
  openDiscSource,
} from "../crates/ppcwasmjit/examples/browser_disc_source.mjs";

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

function vector(id) {
  const entry = diDmaOracleVectors.find((candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, `missing DI DMA vector ${id}`);
  return entry;
}

function pattern(length, seed = 0x31) {
  return Uint8Array.from(
    { length },
    (_unused, index) => (seed + index * 17) & 0xff,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, reject, resolve };
}

function createContext({
  discSource = null,
  discSize = 0x00200000,
  read = (_offset, length) => Promise.resolve(pattern(length)),
  reservationPhysicalGranule = null,
  scheduler = ({ minimumCompletionCycle }) => minimumCompletionCycle,
} = {}) {
  const mmio = DI_DMA_MEM1_BYTES;
  const cpu = mmio + 0x8000;
  const memory = new ArrayBuffer(mmio + 0x10000);
  const reads = [];
  const dataFaults = [];
  const context = {
    bytes: new Uint8Array(memory),
    cpu,
    cycles: 0,
    deviceEvents: new Map(),
    diBreakRequest: 0x00000001,
    diInterruptMasks: 0x0000002a,
    diInterruptStatuses: 0x00000054,
    diDeviceErrorInterrupt: DI_DEVICE_ERROR_STATUS,
    diTransferInterrupt: DI_TRANSFER_COMPLETE_STATUS,
    diDmaAddressMask: DI_DMA_ADDRESS_MASK,
    diDmaLengthMask: DI_DMA_LENGTH_MASK,
    diDmaControlMask: DI_DMA_CONTROL_MASK,
    diMinimumCommandLatencyCycles: DI_MINIMUM_COMMAND_LATENCY_CYCLES,
    diReadStartLatencyCycles: DI_READ_START_LATENCY_CYCLES,
    diBufferTransferBytesPerSecond:
      DI_BUFFER_TRANSFER_BYTES_PER_SECOND,
    diDvdEccBlockBytes: 0x8000,
    diErrorRead: DI_ERROR_READ,
    diErrorInvalidCommand: 0x00052000,
    diErrorBlockOutOfBounds: DI_ERROR_BLOCK_OUT_OF_BOUNDS,
    diErrorNoAudioBuffer: 0x00052001,
    diErrorInvalidAudioCommand: 0x00052401,
    diInquiryCompatibilityBytes: DI_INQUIRY_COMPATIBILITY_BYTES,
    discSource: discSource ?? {
        size: discSize,
        read(offset, length) {
          reads.push({ offset, length });
          return read(offset, length);
        },
      },
    diskAudioEnabled: false,
    diskAudioBufferLength: 0,
    diskAudioStreaming: false,
    diskAudioStopAtTrackEnd: false,
    diskAudioPosition: 0,
    diskAudioStart: 0,
    diskAudioLength: 0,
    diskAudioNextStart: 0,
    diskAudioNextLength: 0,
    diskCommandCounts: new Map(),
    diskCommandTrace: [],
    diskDmaBusyControlWriteRejections: 0,
    diskDmaBusyRegisterWriteRejections: 0,
    diskDmaControlBeforeStart: 0,
    diskDmaRejectionCounts: new Map(),
    diskDmaRejectionTrace: [],
    diskDmaRejections: 0,
    diskDriveState: 0,
    diskHashedBytes: 0,
    diskLastError: 0,
    diskReadBytes: 0,
    diskReadHash: 0x811c9dc5,
    diskTransfer: null,
    interruptDeliveries: 0,
    mmio,
    msrOffset: 0,
    nextDiskAudioCycle: null,
    piDiskInterruptCause: 0x00000004,
    ram: 0,
    ramSize: DI_DMA_MEM1_BYTES,
    reads,
    dataFaults,
    reservationInvalidations: [],
    reservationPhysicalGranule,
    scheduleDiskReadCompletion: scheduler,
    viCpuCyclesPerSecond: DI_CPU_CYCLES_PER_SECOND,
    view: new DataView(memory),
    serviceDiskAudio() {},
    updateDiskAudioSchedule() {},
    resolveDataRange(effective) {
      return { kind: "mapped", effective, physical: effective };
    },
    recordDataStorageFault(
      mapping,
      effective,
      size,
      write,
      stage,
      reason,
      value,
    ) {
      dataFaults.push({
        mapping,
        effective,
        size,
        write,
        stage,
        reason,
        value,
      });
      return 0;
    },
    raiseException() {
      context.interruptDeliveries += 1;
    },
  };
  context.invalidateDataReservationForExternalWrite = (address, length) => {
    context.reservationInvalidations.push({ address, length });
    const reservation = context.reservationPhysicalGranule;
    if (
      reservation === null
      || length === 0
      || address >= reservation + 32
      || reservation >= address + length
    ) {
      return false;
    }
    context.reservationPhysicalGranule = null;
    return true;
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "recomputeDiskInterruptLevel",
      "writeDiskStatus",
      "recordDiskDmaRejection",
      "diskDmaBusy",
      "writeDiskDmaRegister",
      "writeInteger",
      "dueDiskTransferPromise",
      "diskCommandName",
      "recordDiskCommand",
      "snapshotDiskTransfer",
      "diBufferedReadLowerBoundCycles",
      "rejectDiskDmaStart",
      "beginDiskCommand",
      "serviceDisk",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.di-dma-runtime.js" },
  );
  return context;
}

function program(
  context,
  {
    command0 = 0xa8000000,
    command1 = 0,
    command2 = 0x20,
    dmaAddress = 0x200,
    dmaLength = 0x20,
    control = 3,
    cycle = 0,
  } = {},
) {
  for (const [offset, value] of [
    [0x08, command0],
    [0x0c, command1],
    [0x10, command2],
    [0x14, dmaAddress],
    [0x18, dmaLength],
    [0x1c, control],
  ]) {
    assert.equal(
      context.writeDiskDmaRegister(offset, value, cycle),
      true,
      `DI register 0x${offset.toString(16)} was rejected`,
    );
  }
  context.serviceDisk(cycle);
  return context.diskTransfer;
}

async function settleHost(transfer) {
  assert.notEqual(transfer?.promise, null, "missing DI host promise");
  await transfer.promise;
  await Promise.resolve();
}

test("runtime vector 1 applies exact DI address, length, and control masks", () => {
  const { input, expected } = vector("register-programming-masks");
  const writeIntegerSource = extractFunction("writeInteger");
  assert.match(
    writeIntegerSource,
    /writeDiskDmaRegister\(registerOffset, value, cycles\)/,
  );
  assert.match(
    writeIntegerSource,
    /"disk-interface-register-rejected"/,
  );
  const context = createContext();
  context.writeDiskDmaRegister(0x14, input.dmaAddress, 0);
  context.writeDiskDmaRegister(0x18, input.dmaLength, 0);
  context.writeDiskDmaRegister(0x1c, input.control, 0);

  assert.equal(
    context.view.getUint32(context.mmio + 0x6014, false),
    expected.dmaAddress,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6018, false),
    expected.dmaLength,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x601c, false),
    expected.control,
  );
});

test("actual integer MMIO routing accepts exact DI words and rejects partial overlap", () => {
  const context = createContext();
  assert.equal(
    context.writeInteger(0x0c006014, 0xffff_ffff, 4),
    1,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6014, false),
    DI_DMA_ADDRESS_MASK,
  );

  assert.equal(
    context.writeInteger(0x0c006015, 0xffff, 2),
    0,
  );
  assert.equal(context.dataFaults.length, 1);
  assert.equal(
    context.dataFaults[0].reason,
    "disk-interface-register-rejected",
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6014, false),
    DI_DMA_ADDRESS_MASK,
  );

  const transfer = program(context);
  const before = context.view.getUint32(context.mmio + 0x6014, false);
  assert.equal(
    context.writeInteger(0x0c006014, 0x1234_5600, 4),
    1,
  );
  assert.equal(context.diskTransfer, transfer);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6014, false),
    before,
  );
  assert.equal(context.diskDmaBusyRegisterWriteRejections, 1);
});

test("runtime vector 2 latches one immutable read and commits at its buffered deadline", async () => {
  const { input, expected } = vector("read-latched-completion");
  const payload = pattern(input.command2, 0x42);
  const context = createContext({
    read: async () => payload,
    reservationPhysicalGranule: input.dmaAddress,
  });
  context.bytes.fill(
    0xee,
    input.dmaAddress,
    input.dmaAddress + input.command2,
  );
  const transfer = program(context, {
    ...input,
    dmaLength: input.command2,
    cycle: input.cycle,
    control: 3,
  });

  assert.equal(transfer.transaction.discOffset, expected.discOffset);
  assert.equal(transfer.completionCycle, expected.completionCycle);
  assert.equal(Object.isFrozen(transfer.transaction), true);
  assert.deepEqual(context.reservationInvalidations, []);
  assert.equal(
    context.writeDiskDmaRegister(0x0c, 0x12345678, input.cycle + 1),
    false,
  );
  assert.equal(
    context.writeDiskDmaRegister(0x1c, 0, input.cycle + 2),
    false,
  );
  assert.equal(transfer.transaction.command1, input.command1);
  assert.equal(transfer.transaction.control, 3);

  await settleHost(transfer);
  context.serviceDisk(expected.completionCycle - 1);
  assert.equal(context.diskTransfer, transfer);
  assert.deepEqual(
    Array.from(context.bytes.subarray(
      input.dmaAddress,
      input.dmaAddress + input.command2,
    )),
    new Array(input.command2).fill(0xee),
  );
  context.serviceDisk(expected.completionCycle);

  assert.equal(context.diskTransfer, null);
  assert.deepEqual(
    Array.from(context.bytes.subarray(
      input.dmaAddress,
      input.dmaAddress + input.command2,
    )),
    Array.from(payload),
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6014, false),
    expected.dmaAddress,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6018, false),
    expected.dmaLength,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x601c, false),
    expected.control,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6000, false),
    expected.status,
  );
  assert.equal(context.reservationPhysicalGranule, null);
  assert.deepEqual(context.reservationInvalidations, [{
    address: input.dmaAddress,
    length: input.command2,
  }]);
  assert.equal(context.diskDmaBusyRegisterWriteRejections, 1);
  assert.equal(context.diskDmaBusyControlWriteRejections, 1);
});

test("runtime vector 3 remains BUSY after the deadline until its one host result settles", async () => {
  const { input, expected } = vector("host-ready-after-deadline");
  const host = deferred();
  const context = createContext({ read: () => host.promise });
  const transfer = program(context, {
    command2: input.length,
    dmaLength: input.length,
    cycle: input.cycle,
  });
  await Promise.resolve();

  context.serviceDisk(expected.completionCycle);
  assert.equal(context.diskTransfer, transfer);
  assert.equal(
    context.view.getUint32(context.mmio + 0x601c, false) & 1,
    1,
  );
  assert.equal(context.dueDiskTransferPromise(expected.completionCycle), transfer.promise);
  assert.equal(transfer.waited, true);
  host.resolve(pattern(input.length, 0x53));
  await settleHost(transfer);
  context.serviceDisk(expected.completionCycle);
  assert.equal(context.diskTransfer, null);
  assert.equal(context.deviceEvents.get("diskHostWait"), 1);
});

test("runtime vector 4 writes only Inquiry's 12 bytes immediately and delays TC", () => {
  const { input, expected } = vector(
    "inquiry-immediate-delayed-completion",
  );
  const suffix = pattern(expected.preservedSuffixBytes, 0x64);
  const context = createContext({
    reservationPhysicalGranule: input.dmaAddress,
  });
  context.bytes.set(
    suffix,
    input.dmaAddress + DI_INQUIRY_COMPATIBILITY_BYTES.length,
  );
  const transfer = program(context, {
    command0: 0x12000000,
    command2: 0,
    dmaAddress: input.dmaAddress,
    dmaLength: input.dmaLength,
    cycle: input.cycle,
  });

  assert.equal(transfer.transaction.kind, "inquiry");
  assert.equal(transfer.completionCycle, expected.completionCycle);
  assert.deepEqual(
    Array.from(context.bytes.subarray(
      input.dmaAddress,
      input.dmaAddress + DI_INQUIRY_COMPATIBILITY_BYTES.length,
    )),
    DI_INQUIRY_COMPATIBILITY_BYTES,
  );
  assert.deepEqual(
    Array.from(context.bytes.subarray(
      input.dmaAddress + DI_INQUIRY_COMPATIBILITY_BYTES.length,
      input.dmaAddress + input.dmaLength,
    )),
    Array.from(suffix),
  );
  assert.equal(context.view.getUint32(context.mmio + 0x6000, false), 0);
  assert.deepEqual(context.reservationInvalidations, [{
    address: input.dmaAddress,
    length: DI_INQUIRY_COMPATIBILITY_BYTES.length,
  }]);

  context.serviceDisk(expected.completionCycle);
  assert.equal(context.diskTransfer, null);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6014, false),
    expected.dmaAddress,
  );
  assert.equal(context.view.getUint32(context.mmio + 0x6018, false), 0);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6000, false),
    expected.statusAtCompletion,
  );
});

test("runtime vector 5 reads DiscID from offset zero independent of command word 2", async () => {
  const { input, expected } = vector("read-disc-id");
  const context = createContext();
  const transfer = program(context, {
    command0: input.command0,
    command1: 0x12345678,
    command2: 0x87654321,
    dmaAddress: input.dmaAddress,
    dmaLength: input.dmaLength,
    cycle: input.cycle,
  });
  assert.equal(transfer.transaction.kind, "read-disc-id");
  assert.equal(transfer.transaction.discOffset, expected.discOffset);
  assert.equal(transfer.transaction.transferLength, expected.transferLength);
  assert.equal(transfer.completionCycle, expected.completionCycle);
  await settleHost(transfer);
  assert.deepEqual(context.reads, [{ offset: 0, length: 0x20 }]);
});

test("runtime vectors 6 and 7 turn range and host faults into delayed atomic DEINT", async () => {
  const rangeVector = vector("disc-range-error");
  const rangeAddress = 0x500;
  const range = createContext({
    discSize: rangeVector.input.discEndOffset,
    read() {
      assert.fail("out-of-range DI request reached the host source");
    },
    reservationPhysicalGranule: rangeAddress,
  });
  const rangeSentinel = pattern(rangeVector.input.length, 0x75);
  range.bytes.set(rangeSentinel, rangeAddress);
  const rangeTransfer = program(range, {
    command1: rangeVector.input.command1,
    command2: rangeVector.input.length,
    dmaAddress: rangeAddress,
    dmaLength: rangeVector.input.length,
    cycle: rangeVector.input.cycle,
  });
  assert.equal(rangeTransfer.transaction.discOffset, rangeVector.expected.discOffset);
  assert.equal(rangeTransfer.completionCycle, rangeVector.expected.completionCycle);
  range.serviceDisk(rangeVector.expected.completionCycle);
  assert.equal(range.diskLastError, rangeVector.expected.errorCode);
  assert.equal(
    range.view.getUint32(range.mmio + 0x6000, false),
    rangeVector.expected.status,
  );
  assert.equal(range.view.getUint32(range.mmio + 0x6014, false), rangeAddress);
  assert.equal(
    range.view.getUint32(range.mmio + 0x6018, false),
    rangeVector.input.length,
  );
  assert.deepEqual(
    Array.from(range.bytes.subarray(
      rangeAddress,
      rangeAddress + rangeVector.input.length,
    )),
    Array.from(rangeSentinel),
  );
  assert.equal(range.reservationPhysicalGranule, rangeAddress);
  assert.deepEqual(range.reservationInvalidations, []);

  const shortVector = vector("short-host-read-error");
  const shortAddress = 0x600;
  const short = createContext({
    read: async () => pattern(shortVector.input.hostLength, 0x86),
    reservationPhysicalGranule: shortAddress,
  });
  const shortSentinel = pattern(shortVector.input.requestedLength, 0x97);
  short.bytes.set(shortSentinel, shortAddress);
  const shortTransfer = program(short, {
    command2: shortVector.input.requestedLength,
    dmaAddress: shortAddress,
    dmaLength: shortVector.input.requestedLength,
    cycle: shortVector.input.cycle,
  });
  await settleHost(shortTransfer);
  assert.equal(shortTransfer.interruptStatus, DI_DEVICE_ERROR_STATUS);
  assert.equal(shortTransfer.errorCode, shortVector.expected.errorCode);
  assert.doesNotThrow(() => {
    short.serviceDisk(shortTransfer.completionCycle);
  });
  assert.equal(short.diskLastError, DI_ERROR_READ);
  assert.equal(
    short.view.getUint32(short.mmio + 0x6000, false),
    shortVector.expected.status,
  );
  assert.equal(short.view.getUint32(short.mmio + 0x6014, false), shortAddress);
  assert.equal(
    short.view.getUint32(short.mmio + 0x6018, false),
    shortVector.input.requestedLength,
  );
  assert.deepEqual(
    Array.from(short.bytes.subarray(
      shortAddress,
      shortAddress + shortVector.input.requestedLength,
    )),
    Array.from(shortSentinel),
  );
  assert.equal(short.reservationPhysicalGranule, shortAddress);
  assert.deepEqual(short.reservationInvalidations, []);
});

test("runtime vector 8 preserves level-sensitive DI masks and W1C status", () => {
  const { input, expected } = vector("interrupt-mask-and-w1c");
  const context = createContext();
  context.view.setUint32(context.mmio + 0x6000, input.initialStatus, false);
  context.writeDiskStatus(input.firstWrite);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6000, false),
    expected.afterFirstWrite,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false) & 4,
    4,
  );
  context.writeDiskStatus(input.secondWrite);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6000, false),
    expected.afterSecondWrite,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false) & 4,
    0,
  );
});

test("runtime vectors 9 through 12 reject BUSY rewrites and uncertified preflight atomically", () => {
  const busyVector = vector("busy-retrigger-rejected");
  const busy = createContext();
  const accepted = program(busy, {
    command2: busyVector.input.length,
    dmaLength: busyVector.input.length,
    cycle: busyVector.input.firstCycle,
  });
  const before = [
    busy.view.getUint32(busy.mmio + 0x6008, false),
    busy.view.getUint32(busy.mmio + 0x6014, false),
    busy.view.getUint32(busy.mmio + 0x6018, false),
    busy.view.getUint32(busy.mmio + 0x601c, false),
  ];
  assert.equal(
    busy.writeDiskDmaRegister(0x08, 0x99000000, busyVector.input.retryCycle),
    false,
  );
  assert.equal(
    busy.writeDiskDmaRegister(0x1c, 3, busyVector.input.retryCycle),
    false,
  );
  assert.equal(busy.diskTransfer, accepted);
  assert.deepEqual([
    busy.view.getUint32(busy.mmio + 0x6008, false),
    busy.view.getUint32(busy.mmio + 0x6014, false),
    busy.view.getUint32(busy.mmio + 0x6018, false),
    busy.view.getUint32(busy.mmio + 0x601c, false),
  ], before);

  const prefixVector = vector("mem1-valid-prefix-atomic-rejection");
  const prefix = createContext();
  program(prefix, {
    command2: prefixVector.input.length,
    dmaAddress: prefixVector.input.dmaAddress,
    dmaLength: prefixVector.input.length,
  });
  assert.equal(prefix.diskTransfer, null);
  assert.equal(
    prefix.diskDmaRejectionTrace.at(-1).reason,
    "uncertified-mem1-range",
  );
  assert.equal(
    prefix.diskDmaRejectionTrace.at(-1).validPrefixBytes,
    prefixVector.expected.validPrefixBytes,
  );

  const mismatchVector = vector("length-mismatch-fail-closed");
  const mismatch = createContext();
  mismatch.writeDiskDmaRegister(0x1c, 2, 0);
  program(mismatch, {
    command2: mismatchVector.input.requestedLength,
    dmaLength: mismatchVector.input.dmaLength,
  });
  assert.equal(mismatch.diskTransfer, null);
  assert.equal(
    mismatch.diskDmaRejectionTrace.at(-1).reason,
    mismatchVector.expected.reason,
  );
  assert.equal(mismatch.view.getUint32(mismatch.mmio + 0x601c, false), 2);

  const zeroVector = vector("zero-length-and-missing-timing-fail-closed");
  const zero = createContext();
  program(zero, {
    command2: zeroVector.input.zeroLength,
    dmaLength: zeroVector.input.zeroLength,
  });
  assert.equal(zero.diskTransfer, null);
  assert.equal(
    zero.diskDmaRejectionTrace.at(-1).reason,
    zeroVector.expected.zeroLengthReason,
  );

  const timed = createContext();
  timed.scheduleDiskReadCompletion = null;
  program(timed, {
    command2: zeroVector.input.validLengthWithoutCompletionCycle,
    dmaLength: zeroVector.input.validLengthWithoutCompletionCycle,
  });
  assert.equal(timed.diskTransfer, null);
  assert.equal(
    timed.diskDmaRejectionTrace.at(-1).reason,
    zeroVector.expected.missingTimingReason,
  );
});

test("runtime rejects scheduler results before the buffered lower bound", () => {
  const context = createContext({
    scheduler: ({ minimumCompletionCycle }) => minimumCompletionCycle - 1,
  });
  program(context);
  assert.equal(context.diskTransfer, null);
  assert.equal(
    context.diskDmaRejectionTrace.at(-1).reason,
    "completion-before-buffered-lower-bound",
  );
});

test("a bounded QueryRange source reaches the A8 runtime transaction", async (t) => {
  const priorFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const logicalSize = 0x4000;
  const remote = pattern(logicalSize, 0xa8);
  globalThis.fetch = async url => {
    const request = new URL(url);
    const offset = Number(request.searchParams.get("offset"));
    const length = Number(request.searchParams.get("length"));
    return new Response(remote.slice(offset, offset + length), {
      headers: { [LOGICAL_DISC_SIZE_HEADER]: String(logicalSize) },
    });
  };
  const discSource = await openDiscSource(
    {
      kind: "logical-range-endpoint",
      logicalSize,
      url: "https://example.test/disc",
    },
    { chunkBytes: 0x20 },
  );
  const context = createContext({ discSource });
  const transfer = program(context, {
    command1: 0x100,
    command2: 0x20,
    dmaLength: 0x20,
  });
  assert.notEqual(transfer, null);
  assert.equal(transfer.transaction.discOffset, 0x400);
  await settleHost(transfer);
  context.serviceDisk(transfer.completionCycle);
  assert.equal(context.diskTransfer, null);
  assert.deepEqual(
    Array.from(context.bytes.subarray(0x200, 0x220)),
    Array.from(remote.subarray(0x400, 0x420)),
  );
});

test("preflight rejection preserves the drive error for Request Error", () => {
  const cases = [
    {
      name: "control",
      context: createContext(),
      command: { control: 1 },
      reason: "uncertified-control-mode",
    },
    {
      name: "length",
      context: createContext(),
      command: { command2: 0x40, dmaLength: 0x20 },
      reason: "uncertified-length-mismatch",
    },
    {
      name: "disc range",
      context: createContext({ discSize: null }),
      command: {},
      reason: "disc-range-unknown",
    },
    {
      name: "timing",
      context: createContext({ scheduler: null }),
      command: {},
      reason: "completion-cycle-required",
    },
  ];
  for (const entry of cases) {
    const priorError = 0x00031100;
    entry.context.diskLastError = priorError;
    program(entry.context, entry.command);
    assert.equal(entry.context.diskTransfer, null, entry.name);
    assert.equal(
      entry.context.diskDmaRejectionTrace.at(-1).reason,
      entry.reason,
      entry.name,
    );
    assert.equal(entry.context.diskLastError, priorError, entry.name);

    const requestError = program(entry.context, {
      command0: 0xe0000000,
      command2: 0,
      dmaLength: 0x20,
      control: 1,
    });
    assert.notEqual(requestError, null, entry.name);
    assert.equal(
      entry.context.view.getUint32(entry.context.mmio + 0x6020, false)
        & 0x00ffffff,
      priorError,
      entry.name,
    );
  }
});

test("successful non-DMA TC consumes the latched DI DMA registers", () => {
  const context = createContext();
  const transfer = program(context, {
    command0: 0xab000000,
    command1: 0x100,
    command2: 0,
    dmaAddress: 0x400,
    dmaLength: 0x40,
    control: 1,
    cycle: 100,
  });
  assert.notEqual(transfer, null);
  context.serviceDisk(transfer.completionCycle);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6014, false),
    0x440,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6018, false),
    0,
  );
});

test("runtime vector 13 bounds unsupported inputs and maps host reads to drive errors", async () => {
  const vector13 = vector("uncertified-preflight-and-host-failure");
  const unsupported = createContext();
  program(unsupported, {
    command0: vector13.input.unsupportedCommand0,
  });
  assert.equal(unsupported.diskTransfer, null);
  assert.equal(
    unsupported.diskDmaRejectionTrace.at(-1).reason,
    vector13.expected.unsupportedCommandReason,
  );

  const unknown = createContext({ discSize: null });
  program(unknown);
  assert.equal(unknown.diskTransfer, null);
  assert.equal(
    unknown.diskDmaRejectionTrace.at(-1).reason,
    vector13.expected.unknownDiscRangeReason,
  );

  const invalidControl = createContext();
  program(invalidControl, { control: vector13.input.invalidControl });
  assert.equal(invalidControl.diskTransfer, null);
  assert.equal(
    invalidControl.diskDmaRejectionTrace.at(-1).reason,
    vector13.expected.invalidControlReason,
  );

  const overlong = createContext({
    read: async () => pattern(vector13.input.overlongHostLength),
  });
  const overlongTransfer = program(overlong);
  await settleHost(overlongTransfer);
  assert.match(
    overlongTransfer.hostError,
    new RegExp(vector13.expected.overlongHostReason),
  );
  overlong.serviceDisk(overlongTransfer.completionCycle);
  assert.equal(overlong.diskLastError, DI_ERROR_READ);
  assert.equal(
    overlong.view.getUint32(overlong.mmio + 0x6000, false),
    DI_DEVICE_ERROR_STATUS,
  );

  const hostFailure = createContext({
    read: async () => {
      throw new Error("bounded host fault");
    },
  });
  const transfer = program(hostFailure);
  await settleHost(transfer);
  assert.equal(transfer.errorCode, vector13.expected.explicitHostFailureErrorCode);
  assert.doesNotThrow(() => {
    hostFailure.serviceDisk(transfer.completionCycle);
  });
  assert.equal(hostFailure.diskLastError, DI_ERROR_READ);
  assert.equal(
    hostFailure.view.getUint32(hostFailure.mmio + 0x6000, false),
    DI_DEVICE_ERROR_STATUS,
  );
  assert.equal(hostFailure.deviceEvents.get("diskHostReadError"), 1);
});

test("stale host completions cannot mutate a replaced DI transaction", async () => {
  for (const outcome of ["resolve", "reject"]) {
    const host = deferred();
    const context = createContext({ read: () => host.promise });
    const transfer = program(context);
    const replacement = outcome === "resolve"
      ? null
      : { kind: "replacement" };
    context.diskTransfer = replacement;
    const before = {
      diskLastError: context.diskLastError,
      diskReadBytes: context.diskReadBytes,
      diskReadHash: context.diskReadHash,
      events: Array.from(context.deviceEvents),
      registers: [
        context.view.getUint32(context.mmio + 0x6014, false),
        context.view.getUint32(context.mmio + 0x6018, false),
        context.view.getUint32(context.mmio + 0x601c, false),
      ],
      target: Array.from(context.bytes.subarray(0x200, 0x220)),
    };

    if (outcome === "resolve") {
      host.resolve(pattern(0x20, 0xc4));
    } else {
      host.reject(new Error("stale bounded host fault"));
    }
    await transfer.promise;
    await Promise.resolve();

    assert.equal(context.diskTransfer, replacement, outcome);
    assert.equal(transfer.data, null, outcome);
    assert.equal(transfer.hostError, null, outcome);
    assert.equal(transfer.ready, false, outcome);
    assert.deepEqual({
      diskLastError: context.diskLastError,
      diskReadBytes: context.diskReadBytes,
      diskReadHash: context.diskReadHash,
      events: Array.from(context.deviceEvents),
      registers: [
        context.view.getUint32(context.mmio + 0x6014, false),
        context.view.getUint32(context.mmio + 0x6018, false),
        context.view.getUint32(context.mmio + 0x601c, false),
      ],
      target: Array.from(context.bytes.subarray(0x200, 0x220)),
    }, before, outcome);
  }
});

test("production DI scheduler binding returns the explicit buffered lower bound", () => {
  const binding = source.match(
    /const scheduleDiskReadCompletion =\s+bufferedLowerBoundDiskReadCompletionScheduler;/,
  );
  assert.notEqual(binding, null, "missing production DI scheduler binding");
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction("bufferedLowerBoundDiskReadCompletionScheduler"),
      binding[0],
      "result = scheduleDiskReadCompletion({ minimumCompletionCycle: 0x123456 });",
    ].join("\n"),
    context,
  );
  assert.equal(context.result, 0x123456);
});

test("runtime pending diagnostics never duplicate or serialize the host payload", async () => {
  const beginSource = extractFunction("beginDiskCommand");
  assert.doesNotMatch(
    beginSource,
    /new Uint8Array|Array\.from|(?:data|payload)\.slice\(/,
  );

  const context = createContext();
  const transfer = program(context);
  await settleHost(transfer);
  assert.equal(transfer.data.length, 0x20);
  const snapshot = context.snapshotDiskTransfer();
  assert.equal(snapshot.hostPayloadBytes, 0x20);
  assert.equal(Object.hasOwn(snapshot, "data"), false);
  assert.equal(Object.hasOwn(snapshot, "promise"), false);
  assert.equal(Object.hasOwn(transfer.transaction, "data"), false);
});
