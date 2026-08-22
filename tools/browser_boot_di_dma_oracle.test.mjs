// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  DI_BREAK_MASK,
  DI_BREAK_STATUS,
  DI_BUFFER_TRANSFER_BYTES_PER_SECOND,
  DI_CPU_CYCLES_PER_SECOND,
  DI_DEVICE_ERROR_MASK,
  DI_DEVICE_ERROR_STATUS,
  DI_DMA_ADDRESS_MASK,
  DI_DMA_AUTHORITY,
  DI_DMA_AUTHORITY_CLASS,
  DI_DMA_CONTROL_MASK,
  DI_DMA_CURRENT_LAZULI_AUDIT,
  DI_DMA_LENGTH_MASK,
  DI_DMA_MEM1_BYTES,
  DI_DMA_MODE,
  DI_DMA_SOURCES,
  DI_DMA_TRANSFER_START,
  DI_DMA_UNRESOLVED,
  DI_DVD_ECC_BLOCK_BYTES,
  DI_ERROR_BLOCK_OUT_OF_BOUNDS,
  DI_ERROR_NONE,
  DI_ERROR_READ,
  DI_INQUIRY_COMPATIBILITY_BYTES,
  DI_MINIMUM_COMMAND_LATENCY_CYCLES,
  DI_READ_START_LATENCY_CYCLES,
  DI_TRANSFER_COMPLETE_MASK,
  DI_TRANSFER_COMPLETE_STATUS,
  classifyDiDmaLength,
  classifyDiMem1Range,
  createDiDmaOracleState,
  diBufferedReadLowerBoundCycles,
  diDmaOracleVectors,
  diDmaPiInterruptLevel,
  normalizeDiDmaAddress,
  normalizeDiDmaControl,
  normalizeDiDmaLength,
  programDiDmaRegisters,
  provideDiDmaReadData,
  provideDiDmaReadError,
  serviceDiDma,
  snapshotDiDmaOracleState,
  writeDiDmaControl,
  writeDiStatus,
} from "./browser_boot_di_dma_oracle.mjs";

function vector(id) {
  const entry = diDmaOracleVectors.find((candidate) => candidate.id === id);
  assert.notEqual(entry, undefined, `missing DI DMA vector ${id}`);
  return entry;
}

function pattern(length, seed) {
  return Uint8Array.from(
    { length },
    (_unused, index) => (seed + index * 29) & 0xff,
  );
}

function bytesAt(memory, offset, length) {
  return Array.from(memory.subarray(offset, offset + length));
}

function programSectorRead(
  state,
  {
    command1 = 0x100,
    length = 0x20,
    dmaAddress = 0x200,
    dmaLength = length,
  } = {},
) {
  const result = programDiDmaRegisters(state, {
    command0: 0xa8000000,
    command1,
    command2: length,
    dmaAddress,
    dmaLength,
  });
  assert.equal(result.accepted, true);
}

test("DI DMA oracle separates hardware, Dolphin, and conservative authority", () => {
  assert.deepEqual(DI_DMA_AUTHORITY_CLASS, {
    provenHardware: "proven-hardware",
    dolphinCompatibility: "dolphin-compatibility-policy",
    lazuliConservative: "lazuli-conservative-policy",
  });
  assert.equal(
    DI_DMA_AUTHORITY.provenHardware.classification,
    DI_DMA_AUTHORITY_CLASS.provenHardware,
  );
  assert.equal(
    DI_DMA_AUTHORITY.dolphinCompatibility.classification,
    DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
  );
  assert.equal(
    DI_DMA_AUTHORITY.lazuliConservative.classification,
    DI_DMA_AUTHORITY_CLASS.lazuliConservative,
  );
  assert.deepEqual(DI_DMA_AUTHORITY.provenHardware.claims, []);
  assert.match(
    DI_DMA_AUTHORITY.provenHardware.finding,
    /No DI DMA outcome is established as proven hardware/,
  );
  assert.match(
    DI_DMA_AUTHORITY.provenHardware.caveat,
    /without its primary console capture/,
  );
  assert.match(
    DI_DMA_AUTHORITY.dolphinCompatibility.caveat,
    /not asserted as exact console timing/,
  );
  assert.ok(
    DI_DMA_AUTHORITY.dolphinCompatibility.claims.some(
      (claim) => claim.includes("smaller of the requested length"),
    ),
  );
  assert.ok(
    DI_DMA_AUTHORITY.dolphinCompatibility.claims.some(
      (claim) => claim.includes("full latched DILENGTH"),
    ),
  );
  assert.match(
    DI_DMA_AUTHORITY.lazuliConservative.caveat,
    /fail-closed emulator policies/,
  );

  assert.equal(
    DI_DMA_SOURCES.retainedHardwareObservation.revision,
    "d742aa8b4c4d052f7dceaa39022b1fe3996f1781",
  );
  assert.equal(
    DI_DMA_SOURCES.retainedHardwareObservation.classification,
    "retained-hardware-observation",
  );
  assert.match(
    DI_DMA_SOURCES.retainedHardwareObservation.limit,
    /No Nintendo DI programming manual or local console-capture vector/,
  );
  assert.ok(
    DI_DMA_SOURCES.dolphinInterface.symbols.includes(
      "DVDThread::FinishRead",
    ),
  );
  assert.ok(
    DI_DMA_CURRENT_LAZULI_AUDIT.observations.some(
      (claim) => claim.includes("flat 10,000-cycle deadline"),
    ),
  );
  assert.ok(
    DI_DMA_CURRENT_LAZULI_AUDIT.missingCoverage.includes(
      "read command latching and BUSY",
    ),
  );

  assert.deepEqual(
    DI_DMA_UNRESOLVED.map(({ id }) => id),
    [
      "exact-hardware-read-timing",
      "busy-retrigger-and-register-rewrite",
      "zero-length-read",
      "partial-or-invalid-mem1-target",
      "hardware-reservation-effect",
    ],
  );
  assert.deepEqual(
    diDmaOracleVectors.map(({ id }) => id),
    [
      "register-programming-masks",
      "read-latched-completion",
      "host-ready-after-deadline",
      "inquiry-immediate-delayed-completion",
      "read-disc-id",
      "disc-range-error",
      "short-host-read-error",
      "interrupt-mask-and-w1c",
      "busy-retrigger-rejected",
      "mem1-valid-prefix-atomic-rejection",
      "length-mismatch-dolphin-clamp",
      "zero-length-and-missing-timing-fail-closed",
      "uncertified-preflight-and-host-failure",
    ],
  );
  assert.ok(
    diDmaOracleVectors.every(
      ({ authority }) =>
        !authority.includes(DI_DMA_AUTHORITY_CLASS.provenHardware),
    ),
  );
  assert.deepEqual(
    vector("register-programming-masks").outcomeAuthority,
    {
      dmaAddress: {
        classification: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
        supportingEvidence: "retained-hardware-observation",
      },
      dmaLength: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      control: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    },
  );
  assert.equal(
    vector("inquiry-immediate-delayed-completion")
      .outcomeAuthority.reservationInvalidation,
    DI_DMA_AUTHORITY_CLASS.lazuliConservative,
  );
  assert.ok(Object.isFrozen(DI_DMA_SOURCES));
  assert.ok(Object.isFrozen(DI_DMA_UNRESOLVED));
  assert.ok(Object.isFrozen(diDmaOracleVectors));
  assert.ok(
    diDmaOracleVectors.every(
      (entry) => Object.isFrozen(entry) && Object.isFrozen(entry.expected),
    ),
  );
});

test("vector 1 applies the observed GameCube address mask and Dolphin register masks", () => {
  const { input, expected } = vector("register-programming-masks");
  assert.equal(normalizeDiDmaAddress(input.dmaAddress), expected.dmaAddress);
  assert.equal(normalizeDiDmaLength(input.dmaLength), expected.dmaLength);
  assert.equal(normalizeDiDmaControl(input.control), expected.control);
  assert.equal(DI_DMA_ADDRESS_MASK, 0x03ffffe0);
  assert.equal(DI_DMA_LENGTH_MASK, 0xffffffe0);
  assert.equal(DI_DMA_CONTROL_MASK, 7);

  const state = createDiDmaOracleState();
  const programmed = programDiDmaRegisters(state, input);
  assert.equal(programmed.accepted, true);
  assert.equal(state.registers.dmaAddress, expected.dmaAddress);
  assert.equal(state.registers.dmaLength, expected.dmaLength);
});

test("vector 2 latches a sector read and commits data, registers, reservation, and TC at completion", () => {
  const { input, expected } = vector("read-latched-completion");
  assert.equal(DI_CPU_CYCLES_PER_SECOND, 486_000_000);
  assert.equal(DI_BUFFER_TRANSFER_BYTES_PER_SECOND, 32 * 1024 * 1024);
  assert.equal(DI_DVD_ECC_BLOCK_BYTES, 0x8000);
  assert.equal(DI_READ_START_LATENCY_CYCLES, 291_600);
  assert.equal(
    diBufferedReadLowerBoundCycles(
      input.command2,
      input.command1 * 4,
    ),
    expected.completionCycle - input.cycle,
  );
  assert.equal(
    diBufferedReadLowerBoundCycles(0x20, 0x7ff0),
    DI_READ_START_LATENCY_CYCLES + 462,
    "buffered timing floors each ECC-block chunk independently",
  );

  const state = createDiDmaOracleState({
    discEndOffset: input.discEndOffset,
    reservationPhysicalGranule: input.dmaAddress,
  });
  const sentinel = pattern(input.dmaLength, 0x31);
  const payload = pattern(input.dmaLength, 0x52);
  state.mem1.set(sentinel, input.dmaAddress);
  programDiDmaRegisters(state, input);

  const started = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.cycle,
    { completionCycle: expected.completionCycle },
  );
  assert.equal(started.accepted, true);
  assert.equal(started.transaction.kind, "read-sector");
  assert.equal(started.transaction.discOffset, expected.discOffset);
  assert.equal(started.transaction.dmaAddress, input.dmaAddress);
  assert.equal(started.transaction.dmaLength, input.dmaLength);
  assert.ok(Object.isFrozen(started.transaction));
  assert.equal(
    state.registers.control,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
  );
  assert.equal(state.registers.status, 0);
  assert.equal(state.reservationPhysicalGranule, input.dmaAddress);
  assert.deepEqual(
    bytesAt(state.mem1, input.dmaAddress, input.dmaLength),
    Array.from(sentinel),
    "read data must not commit at command start",
  );

  assert.equal(provideDiDmaReadData(state, payload).accepted, true);
  payload.fill(0xee);
  assert.deepEqual(
    bytesAt(state.mem1, input.dmaAddress, input.dmaLength),
    Array.from(sentinel),
  );
  assert.equal(
    serviceDiDma(state, expected.completionCycle - 1).completed,
    false,
  );

  const completed = serviceDiDma(state, expected.completionCycle);
  assert.equal(completed.completed, true);
  assert.equal(completed.successful, true);
  assert.equal(completed.memoryWriteBytes, input.dmaLength);
  assert.equal(completed.reservationInvalidated, true);
  assert.deepEqual(
    bytesAt(state.mem1, input.dmaAddress, input.dmaLength),
    Array.from(pattern(input.dmaLength, 0x52)),
  );
  assert.equal(state.reservationPhysicalGranule, null);
  assert.equal(state.registers.dmaAddress, expected.dmaAddress);
  assert.equal(state.registers.dmaLength, expected.dmaLength);
  assert.equal(state.registers.status, expected.status);
  assert.equal(state.registers.control, expected.control);
  assert.equal(state.driveError, DI_ERROR_NONE);
  assert.equal(diDmaPiInterruptLevel(state), false);
  assert.equal(state.counters.starts, 1);
  assert.equal(state.counters.completions, 1);
  assert.equal(state.counters.transferCompletions, 1);
});

test("vector 3 remains BUSY after the emulated deadline until the host result is ready", () => {
  const { input, expected } = vector("host-ready-after-deadline");
  const state = createDiDmaOracleState({ discEndOffset: 0x200000 });
  programSectorRead(state, { length: input.length });
  const started = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.cycle,
    { completionCycle: expected.completionCycle },
  );
  assert.equal(started.accepted, true);

  const firstWait = serviceDiDma(state, expected.completionCycle);
  assert.deepEqual(firstWait, {
    completed: false,
    reason: expected.beforeHostResult,
    completionCycle: expected.completionCycle,
  });
  assert.notEqual(state.pending, null);
  assert.equal(
    (state.registers.control & DI_DMA_TRANSFER_START) !== 0,
    expected.remainsBusy,
  );
  assert.equal(state.counters.hostWaits, 1);
  serviceDiDma(state, expected.completionCycle + 1);
  assert.equal(state.counters.hostWaits, 1);

  provideDiDmaReadData(state, pattern(input.length, 0x73));
  const completed = serviceDiDma(state, expected.completionCycle + 2);
  assert.equal(completed.completed, expected.completionAfterHostResult);
  assert.equal(
    (state.registers.control & DI_DMA_TRANSFER_START) !== 0,
    false,
  );
});

test("vector 4 makes Inquiry's 12-byte write immediate while delaying register completion and TC", () => {
  const { input, expected } = vector(
    "inquiry-immediate-delayed-completion",
  );
  assert.equal(DI_MINIMUM_COMMAND_LATENCY_CYCLES, 145_800);
  const state = createDiDmaOracleState({
    reservationPhysicalGranule: input.dmaAddress,
  });
  state.mem1.fill(
    0xcc,
    input.dmaAddress,
    input.dmaAddress + input.dmaLength,
  );
  programDiDmaRegisters(state, {
    command0: 0x12000000,
    dmaAddress: input.dmaAddress,
    dmaLength: input.dmaLength,
  });

  const started = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.cycle,
  );
  assert.equal(started.accepted, true);
  assert.equal(started.transaction.kind, "inquiry");
  assert.equal(
    started.transaction.completionCycle,
    expected.completionCycle,
  );
  assert.equal(started.reservationInvalidatedAtStart, true);
  assert.deepEqual(
    bytesAt(
      state.mem1,
      input.dmaAddress,
      expected.immediateWriteBytes,
    ),
    DI_INQUIRY_COMPATIBILITY_BYTES,
  );
  assert.deepEqual(
    bytesAt(
      state.mem1,
      input.dmaAddress + expected.immediateWriteBytes,
      expected.preservedSuffixBytes,
    ),
    new Array(expected.preservedSuffixBytes).fill(0xcc),
  );
  assert.equal(state.registers.status, expected.statusAtStart);
  assert.equal(state.registers.dmaAddress, input.dmaAddress);
  assert.equal(state.registers.dmaLength, input.dmaLength);
  assert.equal(state.reservationPhysicalGranule, null);

  const completed = serviceDiDma(state, expected.completionCycle);
  assert.equal(completed.completed, true);
  assert.equal(completed.memoryWriteBytes, 0);
  assert.equal(completed.reservationInvalidated, true);
  assert.equal(state.registers.dmaAddress, expected.dmaAddress);
  assert.equal(state.registers.dmaLength, expected.dmaLength);
  assert.equal(state.registers.status, expected.statusAtCompletion);
});

test("vector 5 reads the 32-byte disc ID from offset zero regardless of command word 2", () => {
  const { input, expected } = vector("read-disc-id");
  const state = createDiDmaOracleState({
    discEndOffset: input.discEndOffset,
  });
  state.mem1.fill(
    0xcc,
    input.dmaAddress,
    input.dmaAddress + input.dmaLength,
  );
  programDiDmaRegisters(state, {
    command0: input.command0,
    command1: 0x12345678,
    command2: 0,
    dmaAddress: input.dmaAddress,
    dmaLength: input.dmaLength,
  });
  const started = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.cycle,
    { completionCycle: expected.completionCycle },
  );
  assert.equal(started.accepted, true);
  assert.equal(started.transaction.kind, "read-disc-id");
  assert.equal(started.transaction.discOffset, expected.discOffset);
  assert.equal(started.transaction.requestedLength, 0x20);
  assert.equal(started.transaction.transferLength, expected.transferLength);

  const payload = pattern(expected.transferLength, 0x94);
  provideDiDmaReadData(state, payload);
  const completed = serviceDiDma(state, expected.completionCycle);
  assert.equal(completed.successful, true);
  assert.equal(completed.memoryWriteBytes, expected.transferLength);
  assert.deepEqual(
    bytesAt(state.mem1, input.dmaAddress, expected.transferLength),
    Array.from(payload),
  );
  assert.deepEqual(
    bytesAt(
      state.mem1,
      input.dmaAddress + expected.transferLength,
      expected.preservedSuffixBytes,
    ),
    new Array(expected.preservedSuffixBytes).fill(0xcc),
  );
  assert.equal(state.registers.dmaAddress, expected.dmaAddress);
  assert.equal(state.registers.dmaLength, expected.dmaLength);
  assert.equal(state.registers.status, expected.status);
  assert.equal(state.registers.control, expected.control);
});

test("vector 6 turns a disc-range failure into delayed DEINT without memory or DMA-register effects", () => {
  const { input, expected } = vector("disc-range-error");
  const dmaAddress = 0x500;
  const state = createDiDmaOracleState({
    discEndOffset: input.discEndOffset,
    reservationPhysicalGranule: dmaAddress,
  });
  const sentinel = pattern(input.length, 0xb5);
  state.mem1.set(sentinel, dmaAddress);
  programSectorRead(state, {
    command1: input.command1,
    length: input.length,
    dmaAddress,
  });

  const started = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.cycle,
  );
  assert.equal(started.accepted, true);
  assert.equal(started.transaction.discOffset, expected.discOffset);
  assert.equal(started.errorCode, expected.errorCode);
  assert.equal(started.interruptStatus, expected.status);
  assert.equal(
    started.transaction.completionCycle,
    expected.completionCycle,
  );
  assert.equal(state.driveError, expected.errorCode);
  assert.equal(state.registers.status, 0);

  const before = snapshotDiDmaOracleState(state);
  const completed = serviceDiDma(state, expected.completionCycle);
  assert.equal(completed.completed, true);
  assert.equal(completed.successful, false);
  assert.equal(completed.memoryWriteBytes, expected.memoryWriteBytes);
  assert.equal(state.registers.status, expected.status);
  assert.equal(
    state.registers.dmaAddress,
    before.registers.dmaAddress,
  );
  assert.equal(
    state.registers.dmaLength,
    before.registers.dmaLength,
  );
  assert.deepEqual(
    bytesAt(state.mem1, dmaAddress, input.length),
    Array.from(sentinel),
  );
  assert.equal(state.reservationPhysicalGranule, dmaAddress);
});

test("vector 7 maps a short host read to ReadError and preserves the destination transactionally", () => {
  const { input, expected } = vector("short-host-read-error");
  const dmaAddress = 0x600;
  const cycle = input.cycle;
  const completionCycle =
    cycle + diBufferedReadLowerBoundCycles(input.requestedLength);
  const state = createDiDmaOracleState({
    discEndOffset: 0x200000,
    reservationPhysicalGranule: dmaAddress,
  });
  const sentinel = pattern(input.requestedLength, 0xc6);
  state.mem1.set(sentinel, dmaAddress);
  programSectorRead(state, {
    length: input.requestedLength,
    dmaAddress,
  });
  writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    cycle,
    { completionCycle },
  );

  const hostResult = provideDiDmaReadData(
    state,
    pattern(input.hostLength, 0xd7),
  );
  assert.equal(hostResult.accepted, true);
  assert.equal(hostResult.hostError.reason, "host-length-mismatch");
  assert.equal(hostResult.hostError.mismatch, "short");
  assert.equal(hostResult.hostError.errorCode, expected.errorCode);
  const before = snapshotDiDmaOracleState(state);
  const completed = serviceDiDma(state, completionCycle);
  assert.equal(completed.successful, false);
  assert.equal(completed.errorCode, DI_ERROR_READ);
  assert.equal(completed.interruptStatus, expected.status);
  assert.equal(completed.memoryWriteBytes, expected.memoryWriteBytes);
  assert.equal(state.registers.dmaAddress, before.registers.dmaAddress);
  assert.equal(state.registers.dmaLength, before.registers.dmaLength);
  assert.deepEqual(
    bytesAt(state.mem1, dmaAddress, input.requestedLength),
    Array.from(sentinel),
  );
  assert.equal(state.reservationPhysicalGranule, dmaAddress);
  assert.equal(state.counters.deviceErrors, 1);
});

test("vector 8 keeps DI statuses sticky W1C and derives the PI level from matching masks", () => {
  const { input, expected } = vector("interrupt-mask-and-w1c");
  const state = createDiDmaOracleState({
    status: input.initialStatus,
  });
  assert.equal(diDmaPiInterruptLevel(state), false);

  assert.equal(
    writeDiStatus(state, input.firstWrite),
    expected.afterFirstWrite,
  );
  assert.equal(diDmaPiInterruptLevel(state), expected.firstPiLevel);
  assert.equal(
    writeDiStatus(state, input.secondWrite),
    expected.afterSecondWrite,
  );
  assert.equal(diDmaPiInterruptLevel(state), expected.secondPiLevel);

  state.registers.status =
    DI_BREAK_STATUS | DI_BREAK_MASK | DI_DEVICE_ERROR_STATUS;
  assert.equal(diDmaPiInterruptLevel(state), true);
  writeDiStatus(state, DI_BREAK_STATUS | DI_DEVICE_ERROR_MASK);
  assert.equal(
    state.registers.status,
    DI_DEVICE_ERROR_STATUS | DI_DEVICE_ERROR_MASK,
  );
  assert.equal(diDmaPiInterruptLevel(state), true);
  writeDiStatus(state, DI_DEVICE_ERROR_STATUS);
  assert.equal(diDmaPiInterruptLevel(state), false);
});

test("vector 9 rejects retriggers and register rewrites while BUSY without replacing the latch", () => {
  const { input, expected } = vector("busy-retrigger-rejected");
  const state = createDiDmaOracleState({ discEndOffset: 0x200000 });
  programSectorRead(state, { length: input.length });
  const completionCycle =
    input.firstCycle + diBufferedReadLowerBoundCycles(input.length);
  const started = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.firstCycle,
    { completionCycle },
  );
  assert.equal(started.accepted, true);
  const acceptedTransaction = state.pending.transaction;
  const before = snapshotDiDmaOracleState(state);

  const retrigger = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.retryCycle,
    { completionCycle: completionCycle + 1000 },
  );
  assert.equal(retrigger.accepted, expected.secondTransferAccepted);
  assert.equal(retrigger.reason, expected.reason);
  const rewrite = programDiDmaRegisters(state, {
    command0: 0x12000000,
    dmaAddress: 0x800,
    dmaLength: 0x20,
  });
  assert.equal(rewrite.accepted, false);
  assert.equal(rewrite.reason, "busy-register-programming");
  assert.equal(state.pending.transaction, acceptedTransaction);
  assert.deepEqual(state.registers, before.registers);
  assert.equal(state.counters.busyRetriggerRejections, 1);
  assert.equal(state.counters.busyRegisterWriteRejections, 1);

  provideDiDmaReadData(state, pattern(input.length, 0xe8));
  assert.equal(serviceDiDma(state, completionCycle).completed, true);
  assert.equal(state.counters.completions, 1);
});

test("vector 10 reports a valid MEM1 prefix but rejects the entire transfer atomically", () => {
  const { input, expected } = vector(
    "mem1-valid-prefix-atomic-rejection",
  );
  assert.deepEqual(classifyDiMem1Range(input.dmaAddress, input.length), {
    dmaAddress: input.dmaAddress,
    length: input.length,
    validPrefixBytes: expected.validPrefixBytes,
    invalidSuffixBytes: input.length - expected.validPrefixBytes,
    fullRangeValid: expected.fullRangeValid,
  });

  const state = createDiDmaOracleState({
    discEndOffset: 0x200000,
    reservationPhysicalGranule: input.dmaAddress,
  });
  const sentinel = pattern(expected.validPrefixBytes, 0xf9);
  state.mem1.set(sentinel, input.dmaAddress);
  programSectorRead(state, {
    length: input.length,
    dmaAddress: input.dmaAddress,
  });
  const rejected = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    1000,
    {
      completionCycle:
        1000 + diBufferedReadLowerBoundCycles(input.length),
    },
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "uncertified-mem1-range");
  assert.equal(rejected.validPrefixBytes, expected.validPrefixBytes);
  assert.equal(state.pending, null);
  assert.equal(state.registers.control, 0);
  assert.equal(state.registers.status, 0);
  assert.deepEqual(
    bytesAt(state.mem1, input.dmaAddress, expected.validPrefixBytes),
    Array.from(sentinel),
  );
  assert.equal(state.reservationPhysicalGranule, input.dmaAddress);

  const whollyInvalid = classifyDiMem1Range(0x01800000, 0x20);
  assert.equal(whollyInvalid.validPrefixBytes, 0);
  assert.equal(whollyInvalid.fullRangeValid, false);
});

test("vector 11 clamps a mismatched sector read and preserves the untouched suffix", () => {
  const { input, expected } = vector("length-mismatch-dolphin-clamp");
  assert.deepEqual(
    classifyDiDmaLength(input.requestedLength, input.dmaLength),
    {
      requestedLength: input.requestedLength,
      dmaLength: input.dmaLength,
      dolphinTransferLength: expected.dolphinTransferLength,
      oracleAccepted: expected.oracleAccepted,
      reason: expected.reason,
    },
  );

  const state = createDiDmaOracleState({
    discEndOffset: input.discEndOffset,
    reservationPhysicalGranule: input.dmaAddress,
  });
  const sentinel = pattern(input.requestedLength, 0x0a);
  const payload = pattern(expected.dolphinTransferLength, 0x2c);
  state.mem1.set(sentinel, input.dmaAddress);
  programDiDmaRegisters(state, {
    command0: 0xa8000000,
    command1: 0,
    command2: input.requestedLength,
    dmaAddress: input.dmaAddress,
    dmaLength: input.dmaLength,
  });
  const started = writeDiDmaControl(
    state,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    input.cycle,
    { completionCycle: expected.completionCycle },
  );
  assert.equal(started.accepted, expected.oracleAccepted);
  assert.equal(started.transaction.requestedLength, input.requestedLength);
  assert.equal(
    started.transaction.transferLength,
    expected.dolphinTransferLength,
  );
  assert.equal(started.transaction.dmaLength, input.dmaLength);
  assert.equal(
    provideDiDmaReadData(state, payload).payloadLength,
    expected.dolphinTransferLength,
  );

  const completed = serviceDiDma(state, expected.completionCycle);
  assert.equal(completed.successful, true);
  assert.equal(completed.memoryWriteBytes, expected.dolphinTransferLength);
  assert.deepEqual(
    bytesAt(
      state.mem1,
      input.dmaAddress,
      expected.dolphinTransferLength,
    ),
    Array.from(payload),
  );
  assert.deepEqual(
    bytesAt(
      state.mem1,
      input.dmaAddress + expected.dolphinTransferLength,
      expected.preservedSuffixBytes,
    ),
    Array.from(sentinel.subarray(expected.dolphinTransferLength)),
  );
  assert.equal(state.registers.dmaAddress, expected.dmaAddress);
  assert.equal(state.registers.dmaLength, expected.dmaLength);
  assert.equal(state.registers.status, expected.status);
  assert.equal(state.registers.control, expected.control);
  assert.equal(state.reservationPhysicalGranule, null);
});

test("vector 12 rejects zero requested or normalized DMA lengths and invalid timing without mutating BUSY", () => {
  const { input, expected } = vector(
    "zero-length-and-missing-timing-fail-closed",
  );
  const zero = createDiDmaOracleState({ discEndOffset: 0x200000 });
  programSectorRead(zero, {
    length: input.zeroRequestedLength,
    dmaLength: 0x20,
  });
  const zeroRejected = writeDiDmaControl(
    zero,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    1000,
  );
  assert.equal(zeroRejected.accepted, false);
  assert.equal(zeroRejected.reason, expected.zeroRequestedLengthReason);
  assert.equal(zero.pending, null);
  assert.equal(zero.registers.control, 0);

  const zeroDma = createDiDmaOracleState({ discEndOffset: 0x200000 });
  programSectorRead(zeroDma, {
    length: 0x20,
    dmaLength: input.zeroDmaLength,
  });
  const zeroDmaRejected = writeDiDmaControl(
    zeroDma,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    1000,
  );
  assert.equal(zeroDmaRejected.accepted, false);
  assert.equal(zeroDmaRejected.reason, expected.zeroDmaLengthReason);
  assert.equal(zeroDmaRejected.dmaLength, 0);
  assert.equal(zeroDma.pending, null);
  assert.equal(zeroDma.registers.control, 0);

  const untimed = createDiDmaOracleState({ discEndOffset: 0x200000 });
  programSectorRead(untimed, {
    length: input.validLengthWithoutCompletionCycle,
  });
  const missing = writeDiDmaControl(
    untimed,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    2000,
  );
  assert.equal(missing.accepted, false);
  assert.equal(missing.reason, expected.missingTimingReason);
  assert.equal(
    missing.minimumCompletionCycle,
    2000
      + diBufferedReadLowerBoundCycles(
        input.validLengthWithoutCompletionCycle,
      ),
  );
  const early = writeDiDmaControl(
    untimed,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    2000,
    { completionCycle: missing.minimumCompletionCycle - 1 },
  );
  assert.equal(early.accepted, false);
  assert.equal(
    early.reason,
    "completion-before-buffered-lower-bound",
  );
  assert.equal(untimed.pending, null);
  assert.equal(untimed.registers.control, 0);
});

test("vector 13 covers unsupported preflight inputs and maps an explicit host failure to ReadError", () => {
  const { input, expected } = vector(
    "uncertified-preflight-and-host-failure",
  );

  const unsupported = createDiDmaOracleState({
    discEndOffset: 0x200000,
  });
  programDiDmaRegisters(unsupported, {
    command0: input.unsupportedCommand0,
    dmaAddress: 0x200,
    dmaLength: 0x20,
  });
  const unsupportedResult = writeDiDmaControl(
    unsupported,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    0,
  );
  assert.equal(unsupportedResult.accepted, false);
  assert.equal(
    unsupportedResult.reason,
    expected.unsupportedCommandReason,
  );

  const invalidControl = createDiDmaOracleState({
    discEndOffset: 0x200000,
  });
  programSectorRead(invalidControl);
  const invalidControlResult = writeDiDmaControl(
    invalidControl,
    input.invalidControl,
    0,
  );
  assert.equal(invalidControlResult.accepted, false);
  assert.equal(
    invalidControlResult.reason,
    expected.invalidControlReason,
  );

  const unknownRange = createDiDmaOracleState();
  programSectorRead(unknownRange);
  const unknownRangeResult = writeDiDmaControl(
    unknownRange,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    0,
  );
  assert.equal(unknownRangeResult.accepted, false);
  assert.equal(
    unknownRangeResult.reason,
    expected.unknownDiscRangeReason,
  );

  const hostFailure = createDiDmaOracleState({
    discEndOffset: 0x200000,
  });
  programSectorRead(hostFailure);
  const completionCycle = diBufferedReadLowerBoundCycles(0x20, 0x400);
  assert.equal(
    writeDiDmaControl(
      hostFailure,
      DI_DMA_TRANSFER_START | DI_DMA_MODE,
      0,
      { completionCycle },
    ).accepted,
    true,
  );
  const overlong = provideDiDmaReadData(
    hostFailure,
    pattern(input.overlongHostLength, 0x1a),
  );
  assert.equal(overlong.accepted, false);
  assert.equal(overlong.reason, expected.overlongHostReason);
  assert.equal(hostFailure.pending.hostReady, false);

  const failed = provideDiDmaReadError(hostFailure, {
    reason: "disc-source-read-failed",
  });
  assert.equal(failed.accepted, true);
  assert.equal(
    failed.hostError.errorCode,
    expected.explicitHostFailureErrorCode,
  );
  const completed = serviceDiDma(hostFailure, completionCycle);
  assert.equal(completed.successful, false);
  assert.equal(
    completed.errorCode,
    expected.explicitHostFailureErrorCode,
  );
  assert.equal(completed.interruptStatus, DI_DEVICE_ERROR_STATUS);
});

test("DI DMA oracle validates inputs and keeps idle service/control writes deterministic", () => {
  assert.throws(() => normalizeDiDmaAddress(-1), /unsigned 32-bit/);
  assert.throws(
    () => normalizeDiDmaLength(0x1_0000_0000),
    /unsigned 32-bit/,
  );
  assert.throws(
    () => createDiDmaOracleState({ mem1: new Uint8Array(32) }),
    /exactly/,
  );
  assert.throws(
    () => createDiDmaOracleState({ discEndOffset: 1.5 }),
    /disc end offset/,
  );
  assert.throws(
    () => createDiDmaOracleState({ reservationPhysicalGranule: 1 }),
    /aligned inside MEM1/,
  );
  const payloadState = createDiDmaOracleState({
    discEndOffset: 0x200000,
  });
  programSectorRead(payloadState);
  writeDiDmaControl(
    payloadState,
    DI_DMA_TRANSFER_START | DI_DMA_MODE,
    0,
    { completionCycle: diBufferedReadLowerBoundCycles(0x20) },
  );
  assert.throws(
    () => provideDiDmaReadData(payloadState, [1, 2, 3]),
    /Uint8Array/,
  );
  assert.throws(
    () => provideDiDmaReadError(payloadState, { reason: "" }),
    /non-empty string/,
  );

  const state = createDiDmaOracleState();
  assert.deepEqual(serviceDiDma(state, 0), {
    completed: false,
    reason: "idle",
  });
  assert.deepEqual(writeDiDmaControl(state, DI_DMA_MODE, 0), {
    accepted: true,
    started: false,
    control: DI_DMA_MODE,
  });
  assert.equal(state.registers.control, DI_DMA_MODE);
  assert.equal(state.mem1.length, DI_DMA_MEM1_BYTES);
});
