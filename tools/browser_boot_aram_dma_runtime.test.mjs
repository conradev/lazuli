#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  ARAM_DMA_BUSY,
  ARAM_DMA_DIRECTION_TO_MEM1,
  ARAM_DMA_INTERNAL_ARAM_BYTES,
  ARAM_DMA_INTERRUPT_STATUS,
  ARAM_DMA_MEM1_BYTES,
  aramDmaOracleVectors,
} from "./browser_boot_aram_dma_oracle.mjs";

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

function vector(id) {
  const entry = aramDmaOracleVectors.find((candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, `missing ARAM DMA vector ${id}`);
  return entry;
}

function pattern(length, seed) {
  return Uint8Array.from(
    { length },
    (_unused, index) => (seed + index * 17) & 0xff,
  );
}

function bytesAt(memory, offset, length) {
  return Array.from(memory.subarray(offset, offset + length));
}

function createContext({
  cycles = 1000,
  reservationPhysicalGranule = null,
} = {}) {
  const mmio = ARAM_DMA_MEM1_BYTES;
  const memory = new ArrayBuffer(mmio + 0x6000);
  const context = {
    aram: new Uint8Array(ARAM_DMA_INTERNAL_ARAM_BYTES),
    aramTransfer: null,
    bytes: new Uint8Array(memory),
    cycles,
    deviceEvents: new Map(),
    mmio,
    ram: 0,
    ramSize: ARAM_DMA_MEM1_BYTES,
    reservationInvalidations: [],
    reservationPhysicalGranule,
    view: new DataView(memory),
  };
  context.invalidateDataReservationForExternalWrite = (address, length) => {
    context.reservationInvalidations.push({ address, length });
    const reservation = context.reservationPhysicalGranule;
    if (reservation === null || length === 0) return false;
    if (address >= reservation + 32 || reservation >= address + length) {
      return false;
    }
    context.reservationPhysicalGranule = null;
    return true;
  };
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction("startAramDma"),
      extractFunction("serviceAramDma"),
    ].join("\n\n"),
    context,
    { filename: "browser_boot.aram-dma-runtime.js" },
  );
  return context;
}

function program(context, mmAddress, aramAddress) {
  context.view.setUint32(context.mmio + 0x5020, mmAddress >>> 0, false);
  context.view.setUint32(context.mmio + 0x5024, aramAddress >>> 0, false);
}

test("runtime aliases ARAM from shared wasm memory and latches metadata without a payload copy", () => {
  const start = extractFunction("startAramDma");
  assert.match(
    source,
    /const aram = new Uint8Array\(memory\.buffer, __ARAM_PTR__, __ARAM_SIZE__\);/,
  );
  assert.doesNotMatch(source, /const aram = new Uint8Array\(0x01000000\);/);
  assert.doesNotMatch(start, /\.slice\(|new Uint8Array|Array\.from/);
  assert.match(start, /bytes\.subarray/);
  assert.match(start, /aram\.subarray/);

  const context = createContext();
  program(context, 0x100, 0x200);
  context.bytes.set(pattern(0x20, 0x11), 0x100);
  assert.equal(context.startAramDma(0x20), true);
  assert.deepEqual(Object.keys(context.aramTransfer).sort(), [
    "aramAddress",
    "completionCycle",
    "direction",
    "length",
    "mmAddress",
  ]);
  assert.equal(context.aram.byteLength, ARAM_DMA_INTERNAL_ARAM_BYTES);
});

test("runtime vectors 1 and 2 commit both directions and registers at trigger time", () => {
  const toAramVector = vector("mram-to-aram-immediate");
  const toAram = createContext({ cycles: toAramVector.input.cycle });
  program(
    toAram,
    toAramVector.input.mmAddress,
    toAramVector.input.aramAddress,
  );
  const mramSource = pattern(toAramVector.expected.length, 0x21);
  toAram.bytes.set(mramSource, toAramVector.input.mmAddress);
  assert.equal(
    toAram.startAramDma(toAramVector.input.countAndDirection),
    true,
  );
  assert.deepEqual(
    bytesAt(
      toAram.aram,
      toAramVector.input.aramAddress,
      toAramVector.expected.length,
    ),
    Array.from(mramSource),
  );
  assert.equal(
    toAram.view.getUint32(toAram.mmio + 0x5020, false),
    toAramVector.expected.mmAddress,
  );
  assert.equal(
    toAram.view.getUint32(toAram.mmio + 0x5024, false),
    toAramVector.expected.aramAddress,
  );
  assert.equal(toAram.view.getUint32(toAram.mmio + 0x5028, false), 0);
  assert.equal(
    toAram.aramTransfer.completionCycle,
    toAramVector.expected.completionCycle,
  );
  toAram.bytes.fill(
    0xee,
    toAramVector.input.mmAddress,
    toAramVector.input.mmAddress + toAramVector.expected.length,
  );
  toAram.serviceAramDma(toAramVector.expected.completionCycle);
  assert.deepEqual(
    bytesAt(
      toAram.aram,
      toAramVector.input.aramAddress,
      toAramVector.expected.length,
    ),
    Array.from(mramSource),
  );

  const toMramVector = vector("aram-to-mram-immediate");
  const toMram = createContext({ cycles: toMramVector.input.cycle });
  program(
    toMram,
    toMramVector.input.mmAddress,
    toMramVector.input.aramAddress,
  );
  const aramSource = pattern(toMramVector.expected.length, 0x32);
  toMram.aram.set(aramSource, toMramVector.input.aramAddress);
  assert.equal(
    toMram.startAramDma(toMramVector.input.countAndDirection),
    true,
  );
  assert.deepEqual(
    bytesAt(
      toMram.bytes,
      toMramVector.input.mmAddress,
      toMramVector.expected.length,
    ),
    Array.from(aramSource),
  );
  assert.equal(
    toMram.view.getUint32(toMram.mmio + 0x5028, false),
    ARAM_DMA_DIRECTION_TO_MEM1,
  );
  toMram.aram.fill(
    0xdd,
    toMramVector.input.aramAddress,
    toMramVector.input.aramAddress + toMramVector.expected.length,
  );
  toMram.serviceAramDma(toMramVector.expected.completionCycle);
  assert.deepEqual(
    bytesAt(
      toMram.bytes,
      toMramVector.input.mmAddress,
      toMramVector.expected.length,
    ),
    Array.from(aramSource),
  );
});

test("runtime vectors 3 and 6 apply register masks and the 64 MiB aperture", () => {
  const maskedVector = vector("register-programming-masks");
  const masked = createContext();
  program(
    masked,
    maskedVector.input.mmAddress,
    maskedVector.input.aramAddress,
  );
  const sourceBytes = pattern(maskedVector.expected.length, 0x43);
  masked.aram.set(sourceBytes, maskedVector.expected.aramAddress);
  assert.equal(
    masked.startAramDma(maskedVector.input.countAndDirection),
    true,
  );
  assert.deepEqual(
    bytesAt(
      masked.bytes,
      maskedVector.expected.mmAddress,
      maskedVector.expected.length,
    ),
    Array.from(sourceBytes),
  );
  assert.equal(
    masked.view.getUint32(masked.mmio + 0x5020, false),
    maskedVector.expected.mmAddress + maskedVector.expected.length,
  );
  assert.equal(
    masked.view.getUint32(masked.mmio + 0x5024, false),
    maskedVector.expected.aramAddress + maskedVector.expected.length,
  );
  assert.equal(
    masked.view.getUint32(masked.mmio + 0x5028, false),
    ARAM_DMA_DIRECTION_TO_MEM1,
  );

  const apertureVector = vector("aperture-address-wrap");
  const aperture = createContext();
  program(aperture, 0x100, apertureVector.input.aramAddress);
  const apertureSource = pattern(apertureVector.input.length, 0x54);
  aperture.bytes.set(apertureSource, 0x100);
  assert.equal(aperture.startAramDma(apertureVector.input.length), true);
  assert.deepEqual(
    bytesAt(
      aperture.aram,
      apertureVector.expected.internalTargetAddress,
      apertureVector.input.length,
    ),
    Array.from(apertureSource),
  );
});

test("runtime vector 4 wraps internal ARAM at 16 MiB in both directions", () => {
  const { input, expected } = vector("internal-aram-wrap");
  const sourceBytes = pattern(input.length, 0x65);
  const toAram = createContext();
  program(toAram, 0x100, input.aramAddress);
  toAram.bytes.set(sourceBytes, 0x100);
  toAram.startAramDma(input.length);
  assert.deepEqual(
    bytesAt(
      toAram.aram,
      expected.firstChunkAddress,
      expected.firstChunkLength,
    ),
    Array.from(sourceBytes.subarray(0, 0x20)),
  );
  assert.deepEqual(
    bytesAt(
      toAram.aram,
      expected.secondChunkAddress,
      expected.secondChunkLength,
    ),
    Array.from(sourceBytes.subarray(0x20)),
  );
  assert.equal(
    toAram.view.getUint32(toAram.mmio + 0x5024, false),
    expected.aramAddress,
  );

  const toMram = createContext();
  program(toMram, 0x200, input.aramAddress);
  toMram.aram.set(
    sourceBytes.subarray(0, 0x20),
    expected.firstChunkAddress,
  );
  toMram.aram.set(sourceBytes.subarray(0x20), expected.secondChunkAddress);
  toMram.startAramDma(
    (ARAM_DMA_DIRECTION_TO_MEM1 | input.length) >>> 0,
  );
  assert.deepEqual(
    bytesAt(toMram.bytes, 0x200, input.length),
    Array.from(sourceBytes),
  );
});

test("runtime vector 5 makes absent expansion space a no-op in both directions", () => {
  const { input, expected } = vector("expansion-start-no-op");
  for (const direction of input.directions) {
    const context = createContext({ reservationPhysicalGranule: 0x100 });
    const mem1Sentinel = pattern(0x20, 0x76);
    const aramSentinel = pattern(0x20, 0x87);
    context.bytes.set(mem1Sentinel, 0x100);
    context.aram.set(aramSentinel, 0);
    program(context, 0x100, input.aramAddress);
    const count = (
      (direction === 0 ? 0 : ARAM_DMA_DIRECTION_TO_MEM1) | input.length
    ) >>> 0;
    context.startAramDma(count);

    assert.deepEqual(
      bytesAt(context.bytes, 0x100, input.length),
      Array.from(mem1Sentinel),
    );
    assert.deepEqual(
      bytesAt(context.aram, 0, input.length),
      Array.from(aramSentinel),
    );
    assert.equal(context.reservationPhysicalGranule, 0x100);
    assert.deepEqual(context.reservationInvalidations, []);
    assert.equal(context.deviceEvents.get("aramDmaExpansionNoOp"), 1);
    assert.equal(
      context.view.getUint32(context.mmio + 0x5024, false),
      input.aramAddress + input.length,
    );
    assert.equal(expected.dataEffect, "expansion-no-op");
  }
});

test("runtime vectors 7 and 8 resolve zero length in-cycle and reject BUSY retriggers", () => {
  const zeroVector = vector("zero-length");
  const zero = createContext({
    cycles: zeroVector.input.cycle,
    reservationPhysicalGranule: 0x120,
  });
  program(zero, 0x120, 0x220);
  assert.equal(
    zero.startAramDma(zeroVector.input.countAndDirection),
    true,
  );
  assert.equal(
    zero.aramTransfer.completionCycle,
    zeroVector.expected.completionCycle,
  );
  assert.equal(
    zero.view.getUint16(zero.mmio + 0x500a, false),
    ARAM_DMA_BUSY,
  );
  assert.equal(zero.serviceAramDma(zeroVector.input.cycle), true);
  assert.equal(zero.aramTransfer, null);
  assert.equal(
    zero.view.getUint16(zero.mmio + 0x500a, false),
    ARAM_DMA_INTERRUPT_STATUS,
  );
  assert.equal(zero.reservationPhysicalGranule, 0x120);
  assert.deepEqual(zero.reservationInvalidations, []);

  const busyVector = vector("busy-retrigger-rejected");
  const busy = createContext({ cycles: busyVector.input.firstCycle });
  program(busy, 0x100, 0x200);
  busy.bytes.set(pattern(0x40, 0x98), 0x100);
  busy.aram.set(pattern(0x20, 0xa9), 0x220);
  assert.equal(busy.startAramDma(busyVector.input.length), true);
  const accepted = busy.aramTransfer;
  const registers = [
    busy.view.getUint32(busy.mmio + 0x5020, false),
    busy.view.getUint32(busy.mmio + 0x5024, false),
    busy.view.getUint32(busy.mmio + 0x5028, false),
  ];
  const untouched = bytesAt(busy.aram, 0x220, 0x20);
  busy.cycles = busyVector.input.retryCycle;
  assert.equal(busy.startAramDma(busyVector.input.length), false);
  assert.equal(busy.aramTransfer, accepted);
  assert.deepEqual(
    [
      busy.view.getUint32(busy.mmio + 0x5020, false),
      busy.view.getUint32(busy.mmio + 0x5024, false),
      busy.view.getUint32(busy.mmio + 0x5028, false),
    ],
    registers,
  );
  assert.deepEqual(bytesAt(busy.aram, 0x220, 0x20), untouched);
  assert.equal(
    busy.deviceEvents.get("aramDmaBusyRetriggerRejected"),
    busyVector.expected.busyRetriggerRejections,
  );
  assert.equal(
    busy.serviceAramDma(busyVector.expected.firstCompletionCycle),
    true,
  );
  assert.equal(busy.deviceEvents.get("aramDmaComplete"), 1);
});

test("runtime vector 9 commits a valid MEM1 prefix and bounds each invalid suffix", () => {
  const { input, expected } = vector("mem1-valid-prefix");
  const validSource = pattern(expected.validPrefixBytes, 0xba);
  const toAram = createContext();
  program(toAram, input.mmAddress, 0x200);
  toAram.bytes.set(validSource, input.mmAddress);
  toAram.aram.fill(0xff, 0x200, 0x200 + input.length);
  toAram.startAramDma(input.length);
  assert.deepEqual(
    bytesAt(toAram.aram, 0x200, expected.validPrefixBytes),
    Array.from(validSource),
  );
  assert.deepEqual(
    bytesAt(
      toAram.aram,
      0x200 + expected.validPrefixBytes,
      expected.invalidSourceZeroBytes,
    ),
    new Array(expected.invalidSourceZeroBytes).fill(0),
  );
  assert.equal(toAram.deviceEvents.get("aramDmaUnmappedRam"), 1);

  const aramSource = pattern(input.length, 0xcb);
  const toMram = createContext({
    reservationPhysicalGranule: input.mmAddress,
  });
  program(toMram, input.mmAddress, 0x300);
  toMram.aram.set(aramSource, 0x300);
  toMram.startAramDma(
    (ARAM_DMA_DIRECTION_TO_MEM1 | input.length) >>> 0,
  );
  assert.deepEqual(
    bytesAt(toMram.bytes, input.mmAddress, expected.validPrefixBytes),
    Array.from(aramSource.subarray(0, expected.validPrefixBytes)),
  );
  assert.deepEqual(
    toMram.reservationInvalidations,
    [expected.validWriteRange],
  );
  assert.equal(toMram.reservationPhysicalGranule, null);
  assert.equal(toMram.deviceEvents.get("aramDmaUnmappedRam"), 1);
});

test("runtime vector 10 invalidates only actual valid ARAM-to-MEM1 writes", () => {
  const { input, expected } = vector("reservation-effects");
  function run(direction, reservation, length = input.mem1WriteLength) {
    const context = createContext({
      reservationPhysicalGranule: reservation,
    });
    program(context, input.mem1WriteAddress, 0x200);
    context.startAramDma(
      ((direction === 0 ? 0 : ARAM_DMA_DIRECTION_TO_MEM1) | length) >>> 0,
    );
    return context;
  }

  const overlapping = run(1, expected.invalidatedReservationGranule);
  assert.equal(overlapping.reservationPhysicalGranule, null);
  assert.deepEqual(overlapping.reservationInvalidations, [{
    address: input.mem1WriteAddress,
    length: input.mem1WriteLength,
  }]);

  const adjacent = run(1, expected.preservedAdjacentReservationGranule);
  assert.equal(
    adjacent.reservationPhysicalGranule,
    expected.preservedAdjacentReservationGranule,
  );
  assert.equal(adjacent.reservationInvalidations.length, 1);

  const toAram = run(0, expected.invalidatedReservationGranule);
  assert.equal(
    toAram.reservationPhysicalGranule,
    expected.invalidatedReservationGranule,
  );
  assert.deepEqual(toAram.reservationInvalidations, []);

  const zero = run(1, expected.invalidatedReservationGranule, 0);
  assert.equal(
    zero.reservationPhysicalGranule,
    expected.invalidatedReservationGranule,
  );
  assert.deepEqual(zero.reservationInvalidations, []);
});
