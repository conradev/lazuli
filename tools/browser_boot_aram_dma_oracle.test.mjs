// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  ARAM_DMA_ADDRESS_MASK,
  ARAM_DMA_APERTURE_BYTES,
  ARAM_DMA_AUTHORITY,
  ARAM_DMA_AUTHORITY_CLASS,
  ARAM_DMA_BUSY,
  ARAM_DMA_CYCLES_PER_GRANULE,
  ARAM_DMA_DIRECTION_TO_MEM1,
  ARAM_DMA_GRANULE_BYTES,
  ARAM_DMA_INTERNAL_ARAM_BYTES,
  ARAM_DMA_INTERRUPT_MASK,
  ARAM_DMA_INTERRUPT_STATUS,
  ARAM_DMA_LENGTH_MASK,
  ARAM_DMA_MEM1_BYTES,
  aramDmaCompletionCycles,
  aramDmaOracleVectors,
  aramDmaPiInterruptLevel,
  createAramDmaOracleState,
  decodeAramDmaCount,
  normalizeAramDmaAddress,
  normalizeAramDmaCount,
  programAramDmaRegisters,
  serviceAramDma,
  snapshotAramDmaOracleState,
  triggerAramDma,
  writeAramDspControl,
} from "./browser_boot_aram_dma_oracle.mjs";

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

function assertBusy(state, expected) {
  assert.equal(
    (state.registers.dspControl & ARAM_DMA_BUSY) !== 0,
    expected,
  );
}

function assertArint(state, expected) {
  assert.equal(
    (state.registers.dspControl & ARAM_DMA_INTERRUPT_STATUS) !== 0,
    expected,
  );
}

test("ARAM DMA oracle labels hardware, Dolphin, and conservative authority separately", () => {
  assert.deepEqual(ARAM_DMA_AUTHORITY_CLASS, {
    provenHardware: "proven-hardware",
    dolphinCompatibility: "dolphin-compatibility-policy",
    lazuliConservative: "lazuli-conservative-policy",
  });
  assert.equal(
    ARAM_DMA_AUTHORITY.provenHardware.classification,
    ARAM_DMA_AUTHORITY_CLASS.provenHardware,
  );
  assert.equal(
    ARAM_DMA_AUTHORITY.dolphinCompatibility.classification,
    ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility,
  );
  assert.equal(
    ARAM_DMA_AUTHORITY.lazuliConservative.classification,
    ARAM_DMA_AUTHORITY_CLASS.lazuliConservative,
  );
  assert.match(
    ARAM_DMA_AUTHORITY.dolphinCompatibility.caveat,
    /not asserted as new console measurements/,
  );
  assert.match(
    ARAM_DMA_AUTHORITY.lazuliConservative.caveat,
    /not claims about undefined physical-bus behavior/,
  );

  assert.deepEqual(
    aramDmaOracleVectors.map(({ id }) => id),
    [
      "mram-to-aram-immediate",
      "aram-to-mram-immediate",
      "register-programming-masks",
      "internal-aram-wrap",
      "expansion-start-no-op",
      "aperture-address-wrap",
      "zero-length",
      "busy-retrigger-rejected",
      "mem1-valid-prefix",
      "reservation-effects",
      "interrupt-deadline-and-level",
    ],
  );
  assert.equal(aramDmaOracleVectors.length, 11);
  assert.ok(Object.isFrozen(aramDmaOracleVectors));
  assert.ok(
    aramDmaOracleVectors.every(
      (entry) => Object.isFrozen(entry) && Object.isFrozen(entry.expected),
    ),
  );
});

test("vector 1 commits MRAM to ARAM data and registers immediately", () => {
  const { input, expected } = vector("mram-to-aram-immediate");
  const state = createAramDmaOracleState({
    mmAddress: input.mmAddress,
    aramAddress: input.aramAddress,
  });
  const source = pattern(input.countAndDirection, 0x31);
  state.mem1.set(source, input.mmAddress);

  const result = triggerAramDma(
    state,
    input.countAndDirection,
    input.cycle,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.transfer.direction, expected.direction);
  assert.equal(result.transfer.length, expected.length);
  assert.deepEqual(
    bytesAt(state.aram, input.aramAddress, expected.length),
    Array.from(source),
  );
  assert.deepEqual(state.registers, {
    mmAddress: expected.mmAddress,
    aramAddress: expected.aramAddress,
    countAndDirection: expected.countAndDirection,
    dspControl: ARAM_DMA_BUSY,
  });
  assert.equal(state.pending.completionCycle, expected.completionCycle);

  state.mem1.fill(0xee, input.mmAddress, input.mmAddress + expected.length);
  assert.equal(
    serviceAramDma(state, expected.completionCycle).completed,
    true,
  );
  assert.deepEqual(
    bytesAt(state.aram, input.aramAddress, expected.length),
    Array.from(source),
  );
});

test("vector 2 commits ARAM to MRAM data and registers immediately", () => {
  const { input, expected } = vector("aram-to-mram-immediate");
  const state = createAramDmaOracleState({
    mmAddress: input.mmAddress,
    aramAddress: input.aramAddress,
  });
  const source = pattern(expected.length, 0x52);
  state.aram.set(source, input.aramAddress);

  const result = triggerAramDma(
    state,
    input.countAndDirection,
    input.cycle,
  );
  assert.equal(result.accepted, true);
  assert.equal(result.transfer.direction, expected.direction);
  assert.deepEqual(
    bytesAt(state.mem1, input.mmAddress, expected.length),
    Array.from(source),
  );
  assert.deepEqual(state.registers, {
    mmAddress: expected.mmAddress,
    aramAddress: expected.aramAddress,
    countAndDirection: expected.countAndDirection,
    dspControl: ARAM_DMA_BUSY,
  });
  assert.equal(state.pending.completionCycle, expected.completionCycle);

  state.aram.fill(0xdd, input.aramAddress, input.aramAddress + expected.length);
  serviceAramDma(state, expected.completionCycle);
  assert.deepEqual(
    bytesAt(state.mem1, input.mmAddress, expected.length),
    Array.from(source),
  );
});

test("vector 3 applies 32-byte masks inside the 64 MiB aperture", () => {
  const { input, expected } = vector("register-programming-masks");
  assert.equal(ARAM_DMA_GRANULE_BYTES, 32);
  assert.equal(ARAM_DMA_APERTURE_BYTES, 0x04000000);
  assert.equal(ARAM_DMA_ADDRESS_MASK, 0x03ffffe0);
  assert.equal(ARAM_DMA_LENGTH_MASK, 0x03ffffe0);
  assert.equal(ARAM_DMA_DIRECTION_TO_MEM1, 0x80000000);

  const state = createAramDmaOracleState();
  const registers = programAramDmaRegisters(state, input);
  assert.equal(registers.mmAddress, expected.mmAddress);
  assert.equal(registers.aramAddress, expected.aramAddress);
  assert.equal(
    registers.countAndDirection,
    expected.countAndDirection,
  );
  assert.deepEqual(decodeAramDmaCount(input.countAndDirection), {
    countAndDirection: expected.countAndDirection,
    direction: expected.direction,
    length: expected.length,
  });
  assert.equal(normalizeAramDmaAddress(0xffffffff), ARAM_DMA_ADDRESS_MASK);
  assert.equal(
    normalizeAramDmaCount(0xffffffff),
    (ARAM_DMA_DIRECTION_TO_MEM1 | ARAM_DMA_LENGTH_MASK) >>> 0,
  );
});

test("vector 4 wraps an internal-start transfer at 16 MiB in both directions", () => {
  const { input, expected } = vector("internal-aram-wrap");
  const source = pattern(input.length, 0x73);
  const toAram = createAramDmaOracleState({
    mmAddress: 0x100,
    aramAddress: input.aramAddress,
  });
  toAram.mem1.set(source, 0x100);
  triggerAramDma(toAram, input.length, 0);

  assert.deepEqual(
    bytesAt(
      toAram.aram,
      expected.firstChunkAddress,
      expected.firstChunkLength,
    ),
    Array.from(source.subarray(0, 0x20)),
  );
  assert.deepEqual(
    bytesAt(
      toAram.aram,
      expected.secondChunkAddress,
      expected.secondChunkLength,
    ),
    Array.from(source.subarray(0x20)),
  );
  assert.equal(toAram.registers.aramAddress, expected.aramAddress);

  const toMem1 = createAramDmaOracleState({
    mmAddress: 0x200,
    aramAddress: input.aramAddress,
  });
  toMem1.aram.set(source.subarray(0, 0x20), expected.firstChunkAddress);
  toMem1.aram.set(source.subarray(0x20), expected.secondChunkAddress);
  triggerAramDma(
    toMem1,
    (ARAM_DMA_DIRECTION_TO_MEM1 | input.length) >>> 0,
    0,
  );
  assert.deepEqual(
    bytesAt(toMem1.mem1, 0x200, input.length),
    Array.from(source),
  );
  assert.equal(toMem1.registers.aramAddress, expected.aramAddress);
});

test("vector 5 makes an expansion-start transfer a data and reservation no-op", () => {
  const { input, expected } = vector("expansion-start-no-op");
  const mem1Sentinel = pattern(0x20, 0x94);
  const aramSentinel = pattern(0x20, 0xa5);

  for (const direction of input.directions) {
    const state = createAramDmaOracleState({
      mmAddress: 0x100,
      aramAddress: input.aramAddress,
      reservationPhysicalGranule: 0x100,
    });
    state.mem1.set(mem1Sentinel, 0x100);
    state.aram.set(aramSentinel, 0);

    const countAndDirection = (
      (direction === 0 ? 0 : ARAM_DMA_DIRECTION_TO_MEM1) | input.length
    ) >>> 0;
    const result = triggerAramDma(state, countAndDirection, 10);
    assert.equal(result.transfer.effect, expected.dataEffect);
    assert.equal(result.transfer.expansionNoOpBytes, input.length);
    assert.equal(result.transfer.validMem1Bytes, 0);
    assert.deepEqual(
      bytesAt(state.mem1, 0x100, 0x20),
      Array.from(mem1Sentinel),
    );
    assert.deepEqual(
      bytesAt(state.aram, 0, 0x20),
      Array.from(aramSentinel),
    );
    assert.equal(state.reservationPhysicalGranule, 0x100);
  }
});

test("vector 6 masks 0x04000000 to internal ARAM offset zero", () => {
  const { input, expected } = vector("aperture-address-wrap");
  const source = pattern(input.length, 0xb6);
  const state = createAramDmaOracleState({
    mmAddress: 0x100,
    aramAddress: input.aramAddress,
  });
  state.mem1.set(source, 0x100);
  assert.equal(state.registers.aramAddress, expected.programmedAramAddress);

  triggerAramDma(state, input.length, 0);
  assert.deepEqual(
    bytesAt(state.aram, expected.internalTargetAddress, input.length),
    Array.from(source),
  );
});

test("vector 7 gives zero length a same-cycle deadline without data or reservation effects", () => {
  const { input, expected } = vector("zero-length");
  const state = createAramDmaOracleState({
    mmAddress: 0x120,
    aramAddress: 0x220,
    reservationPhysicalGranule: 0x120,
  });
  const mem1Sentinel = pattern(0x20, 0xc7);
  const aramSentinel = pattern(0x20, 0xd8);
  state.mem1.set(mem1Sentinel, 0x120);
  state.aram.set(aramSentinel, 0x220);

  const result = triggerAramDma(
    state,
    input.countAndDirection,
    input.cycle,
  );
  assert.equal(result.transfer.effect, "zero-length");
  assert.equal(result.transfer.completionCycle, expected.completionCycle);
  assert.equal(state.registers.mmAddress, 0x120);
  assert.equal(state.registers.aramAddress, 0x220);
  assert.equal(state.reservationPhysicalGranule, 0x120);
  assert.deepEqual(bytesAt(state.mem1, 0x120, 0x20), Array.from(mem1Sentinel));
  assert.deepEqual(bytesAt(state.aram, 0x220, 0x20), Array.from(aramSentinel));
  assertBusy(state, true);
  assertArint(state, false);

  assert.equal(serviceAramDma(state, input.cycle).completed, true);
  assertBusy(state, false);
  assertArint(state, true);
  assert.equal(state.counters.completions, 1);
  assert.equal(state.counters.interruptAssertions, 1);
});

test("vector 8 rejects a BUSY retrigger without replacing the first transfer", () => {
  const { input, expected } = vector("busy-retrigger-rejected");
  const state = createAramDmaOracleState({
    mmAddress: 0x100,
    aramAddress: 0x200,
  });
  const first = pattern(input.length, 0xe9);
  const possibleSecond = pattern(input.length, 0xfa);
  const untouched = pattern(input.length, 0x0b);
  state.mem1.set(first, 0x100);
  state.mem1.set(possibleSecond, 0x120);
  state.aram.set(untouched, 0x220);

  const accepted = triggerAramDma(state, input.length, input.firstCycle);
  assert.equal(accepted.accepted, true);
  assert.equal(
    accepted.transfer.completionCycle,
    expected.firstCompletionCycle,
  );
  const beforeRetry = snapshotAramDmaOracleState(state);
  const rejected = triggerAramDma(state, input.length, input.retryCycle);
  assert.deepEqual(rejected, {
    accepted: false,
    reason: "busy",
    completionCycle: expected.firstCompletionCycle,
  });
  assert.equal(state.pending.completionCycle, beforeRetry.pending.completionCycle);
  assert.equal(state.registers.mmAddress, beforeRetry.registers.mmAddress);
  assert.equal(state.registers.aramAddress, beforeRetry.registers.aramAddress);
  assert.deepEqual(bytesAt(state.aram, 0x220, input.length), Array.from(untouched));
  assert.equal(state.counters.busyRetriggerRejections, 1);

  assert.equal(
    serviceAramDma(state, expected.firstCompletionCycle - 1).completed,
    false,
  );
  assert.equal(
    serviceAramDma(state, expected.firstCompletionCycle).completed,
    true,
  );
  assert.deepEqual(
    serviceAramDma(state, expected.firstCompletionCycle),
    {
      completed: false,
      reason: "idle",
    },
  );
  assert.equal(state.counters.completions, expected.completions);
});

test("vector 9 models a valid MEM1 prefix with zero source and ignored destination suffixes", () => {
  const { input, expected } = vector("mem1-valid-prefix");
  const validSource = pattern(expected.validPrefixBytes, 0x1c);
  const toAram = createAramDmaOracleState({
    mmAddress: input.mmAddress,
    aramAddress: 0x200,
  });
  toAram.mem1.set(validSource, input.mmAddress);
  toAram.aram.fill(0xff, 0x200, 0x200 + input.length);
  const read = triggerAramDma(toAram, input.length, 0).transfer;
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
  assert.equal(read.validMem1Bytes, expected.validPrefixBytes);
  assert.equal(read.zeroSourceBytes, expected.invalidSourceZeroBytes);

  const aramSource = pattern(input.length, 0x2d);
  const toMem1 = createAramDmaOracleState({
    mmAddress: input.mmAddress,
    aramAddress: 0x300,
    reservationPhysicalGranule: input.mmAddress,
  });
  toMem1.aram.set(aramSource, 0x300);
  const write = triggerAramDma(
    toMem1,
    (ARAM_DMA_DIRECTION_TO_MEM1 | input.length) >>> 0,
    0,
  ).transfer;
  assert.deepEqual(
    bytesAt(toMem1.mem1, input.mmAddress, expected.validPrefixBytes),
    Array.from(aramSource.subarray(0, expected.validPrefixBytes)),
  );
  assert.equal(
    write.ignoredDestinationBytes,
    expected.invalidDestinationIgnoredBytes,
  );
  assert.deepEqual(write.validMem1WriteRange, expected.validWriteRange);
  assert.equal(write.reservationInvalidated, true);
  assert.equal(toMem1.reservationPhysicalGranule, null);
});

test("vector 10 invalidates exactly overlapping ARAM-to-MEM1 writes", () => {
  const { input, expected } = vector("reservation-effects");

  const overlapping = createAramDmaOracleState({
    mmAddress: input.mem1WriteAddress,
    aramAddress: 0x200,
    reservationPhysicalGranule: expected.invalidatedReservationGranule,
  });
  triggerAramDma(
    overlapping,
    (
      ARAM_DMA_DIRECTION_TO_MEM1
      | input.mem1WriteLength
    ) >>> 0,
    0,
  );
  assert.equal(overlapping.lastTransfer.reservationInvalidated, true);
  assert.equal(overlapping.reservationPhysicalGranule, null);

  const adjacent = createAramDmaOracleState({
    mmAddress: input.mem1WriteAddress,
    aramAddress: 0x200,
    reservationPhysicalGranule:
      expected.preservedAdjacentReservationGranule,
  });
  triggerAramDma(
    adjacent,
    (
      ARAM_DMA_DIRECTION_TO_MEM1
      | input.mem1WriteLength
    ) >>> 0,
    0,
  );
  assert.equal(adjacent.lastTransfer.reservationInvalidated, false);
  assert.equal(
    adjacent.reservationPhysicalGranule,
    expected.preservedAdjacentReservationGranule,
  );

  const toAram = createAramDmaOracleState({
    mmAddress: input.mem1WriteAddress,
    aramAddress: 0x200,
    reservationPhysicalGranule: expected.invalidatedReservationGranule,
  });
  triggerAramDma(toAram, input.mem1WriteLength, 0);
  assert.equal(
    toAram.reservationPhysicalGranule,
    expected.invalidatedReservationGranule,
  );

  const zero = createAramDmaOracleState({
    mmAddress: input.mem1WriteAddress,
    aramAddress: 0x200,
    reservationPhysicalGranule: expected.invalidatedReservationGranule,
  });
  triggerAramDma(zero, ARAM_DMA_DIRECTION_TO_MEM1, 0);
  assert.equal(
    zero.reservationPhysicalGranule,
    expected.invalidatedReservationGranule,
  );
});

test("vector 11 delays BUSY completion and ARINT level until the exact deadline", () => {
  const { input, expected } = vector("interrupt-deadline-and-level");
  assert.equal(ARAM_DMA_CYCLES_PER_GRANULE, 246);
  assert.equal(
    aramDmaCompletionCycles(input.length),
    expected.completionCycle - input.cycle,
  );
  const state = createAramDmaOracleState({
    mmAddress: 0x100,
    aramAddress: 0x200,
  });
  triggerAramDma(state, input.length, input.cycle);

  assert.equal(
    serviceAramDma(state, expected.completionCycle - 1).completed,
    false,
  );
  assertBusy(state, expected.beforeDeadline.busy);
  assertArint(state, expected.beforeDeadline.arint);
  assert.equal(aramDmaPiInterruptLevel(state), expected.maskClearPiLevel);

  assert.equal(
    serviceAramDma(state, expected.completionCycle).completed,
    true,
  );
  assertBusy(state, expected.atDeadline.busy);
  assertArint(state, expected.atDeadline.arint);
  assert.equal(aramDmaPiInterruptLevel(state), expected.maskClearPiLevel);

  assert.equal(writeAramDspControl(state, ARAM_DMA_INTERRUPT_MASK), 0x0060);
  assert.equal(aramDmaPiInterruptLevel(state), expected.maskSetPiLevel);
  assert.equal(
    writeAramDspControl(
      state,
      ARAM_DMA_INTERRUPT_MASK | ARAM_DMA_INTERRUPT_STATUS,
    ),
    ARAM_DMA_INTERRUPT_MASK,
  );
  assert.equal(aramDmaPiInterruptLevel(state), expected.writeOneToClearPiLevel);
  assert.equal(
    state.registers.dspControl & ARAM_DMA_INTERRUPT_MASK,
    ARAM_DMA_INTERRUPT_MASK,
  );
  assertArint(state, false);
  assert.equal(state.counters.interruptAssertions, 1);
});

test("ARAM DMA oracle rejects malformed memory and timing inputs", () => {
  assert.equal(ARAM_DMA_MEM1_BYTES, 0x01800000);
  assert.equal(ARAM_DMA_INTERNAL_ARAM_BYTES, 0x01000000);
  assert.throws(
    () => createAramDmaOracleState({ mem1: new Uint8Array(32) }),
    /MEM1 must be a Uint8Array with exactly/,
  );
  assert.throws(
    () =>
      createAramDmaOracleState({
        reservationPhysicalGranule: 0x121,
      }),
    /reservation physical granule must be aligned inside MEM1/,
  );
  assert.throws(
    () => aramDmaCompletionCycles(31),
    /multiple of 32 bytes/,
  );
  const state = createAramDmaOracleState();
  assert.throws(
    () => triggerAramDma(state, 0x20, -1),
    /non-negative safe integer/,
  );
});
