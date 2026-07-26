// SPDX-License-Identifier: GPL-3.0-only

export const ARAM_DMA_MEM1_BYTES = 0x01800000;
export const ARAM_DMA_INTERNAL_ARAM_BYTES = 0x01000000;
export const ARAM_DMA_APERTURE_BYTES = 0x04000000;
export const ARAM_DMA_ADDRESS_MASK = 0x03ffffe0;
export const ARAM_DMA_LENGTH_MASK = 0x03ffffe0;
export const ARAM_DMA_DIRECTION_TO_MEM1 = 0x80000000;
export const ARAM_DMA_GRANULE_BYTES = 32;
export const ARAM_DMA_CYCLES_PER_GRANULE = 246;
export const ARAM_DMA_BUSY = 0x0200;
export const ARAM_DMA_INTERRUPT_STATUS = 0x0020;
export const ARAM_DMA_INTERRUPT_MASK = 0x0040;

export const ARAM_DMA_AUTHORITY_CLASS = Object.freeze({
  provenHardware: "proven-hardware",
  dolphinCompatibility: "dolphin-compatibility-policy",
  lazuliConservative: "lazuli-conservative-policy",
});

export const ARAM_DMA_AUTHORITY = Object.freeze({
  provenHardware: Object.freeze({
    classification: ARAM_DMA_AUTHORITY_CLASS.provenHardware,
    claims: Object.freeze([
      "DMA addresses and byte count use 32-byte granularity inside a 64 MiB aperture.",
      "Direction is count bit 31; BUSY, ARINT status, and ARINT mask are distinct DSP control bits.",
      "ARINT status is level-sensitive through its mask and is write-one-to-clear.",
    ]),
  }),
  dolphinCompatibility: Object.freeze({
    classification: ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    claims: Object.freeze([
      "A 16 MiB internal-ARAM transfer wraps at the internal-ARAM boundary when its starting address is internal.",
      "A transfer whose starting ARAM address is in the absent expansion region has no data effect.",
      "Data and post-incremented registers commit when DMA is triggered; BUSY completion and ARINT are delayed by 246 cycles per 32 bytes.",
    ]),
    caveat:
      "These outcomes intentionally match the selected Dolphin compatibility behavior; they are not asserted as new console measurements.",
  }),
  lazuliConservative: Object.freeze({
    classification: ARAM_DMA_AUTHORITY_CLASS.lazuliConservative,
    claims: Object.freeze([
      "A trigger while BUSY is rejected without replacing the accepted transfer.",
      "A RAM-to-ARAM source outside valid MEM1 reads as zero after its valid prefix; an ARAM-to-RAM destination outside MEM1 is ignored after its valid prefix.",
      "Only bytes actually written into valid MEM1 by ARAM-to-RAM DMA may invalidate a reservation.",
    ]),
    caveat:
      "These are bounded emulator safety policies, not claims about undefined physical-bus behavior.",
  }),
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const aramDmaOracleVectors = deepFreeze([
  {
    id: "mram-to-aram-immediate",
    authority: [ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility],
    input: {
      cycle: 1000,
      mmAddress: 0x00000100,
      aramAddress: 0x00000200,
      countAndDirection: 0x00000040,
    },
    expected: {
      direction: 0,
      length: 0x40,
      mmAddress: 0x00000140,
      aramAddress: 0x00000240,
      countAndDirection: 0,
      completionCycle: 1492,
      laterSourceMutationChangesCommittedData: false,
    },
  },
  {
    id: "aram-to-mram-immediate",
    authority: [ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility],
    input: {
      cycle: 1000,
      mmAddress: 0x00000100,
      aramAddress: 0x00000200,
      countAndDirection: 0x80000040,
    },
    expected: {
      direction: 1,
      length: 0x40,
      mmAddress: 0x00000140,
      aramAddress: 0x00000240,
      countAndDirection: 0x80000000,
      completionCycle: 1492,
      laterSourceMutationChangesCommittedData: false,
    },
  },
  {
    id: "register-programming-masks",
    authority: [ARAM_DMA_AUTHORITY_CLASS.provenHardware],
    input: {
      mmAddress: 0x0000013f,
      aramAddress: 0x0400023f,
      countAndDirection: 0x8400003f,
    },
    expected: {
      mmAddress: 0x00000120,
      aramAddress: 0x00000220,
      countAndDirection: 0x80000020,
      direction: 1,
      length: 0x20,
    },
  },
  {
    id: "internal-aram-wrap",
    authority: [ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility],
    input: {
      aramAddress: 0x00ffffe0,
      length: 0x40,
    },
    expected: {
      firstChunkAddress: 0x00ffffe0,
      firstChunkLength: 0x20,
      secondChunkAddress: 0,
      secondChunkLength: 0x20,
      aramAddress: 0x01000020,
    },
  },
  {
    id: "expansion-start-no-op",
    authority: [ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility],
    input: {
      aramAddress: 0x01000000,
      length: 0x20,
      directions: [0, 1],
    },
    expected: {
      dataEffect: "expansion-no-op",
      preservesMem1: true,
      preservesInternalAram: true,
      preservesReservation: true,
    },
  },
  {
    id: "aperture-address-wrap",
    authority: [ARAM_DMA_AUTHORITY_CLASS.provenHardware],
    input: {
      aramAddress: 0x04000000,
      length: 0x20,
    },
    expected: {
      programmedAramAddress: 0,
      internalTargetAddress: 0,
    },
  },
  {
    id: "zero-length",
    authority: [
      ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      ARAM_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    input: {
      cycle: 1000,
      countAndDirection: 0,
    },
    expected: {
      completionCycle: 1000,
      dataBytes: 0,
      addressesAdvanceBy: 0,
      reservationInvalidated: false,
      sameCycleServiceClearsBusy: true,
      sameCycleServiceAssertsArint: true,
    },
  },
  {
    id: "busy-retrigger-rejected",
    authority: [ARAM_DMA_AUTHORITY_CLASS.lazuliConservative],
    input: {
      firstCycle: 1000,
      retryCycle: 1010,
      length: 0x20,
    },
    expected: {
      firstCompletionCycle: 1246,
      secondTransferAccepted: false,
      completions: 1,
      busyRetriggerRejections: 1,
    },
  },
  {
    id: "mem1-valid-prefix",
    authority: [ARAM_DMA_AUTHORITY_CLASS.lazuliConservative],
    input: {
      mmAddress: 0x017fffe0,
      length: 0x40,
    },
    expected: {
      validPrefixBytes: 0x20,
      invalidSourceZeroBytes: 0x20,
      invalidDestinationIgnoredBytes: 0x20,
      validWriteRange: {
        address: 0x017fffe0,
        length: 0x20,
      },
    },
  },
  {
    id: "reservation-effects",
    authority: [ARAM_DMA_AUTHORITY_CLASS.lazuliConservative],
    input: {
      mem1WriteAddress: 0x00000120,
      mem1WriteLength: 0x20,
    },
    expected: {
      invalidatedReservationGranule: 0x00000120,
      preservedAdjacentReservationGranule: 0x00000140,
      mramToAramPreservesReservation: true,
      zeroLengthPreservesReservation: true,
    },
  },
  {
    id: "interrupt-deadline-and-level",
    authority: [
      ARAM_DMA_AUTHORITY_CLASS.provenHardware,
      ARAM_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    ],
    input: {
      cycle: 1000,
      length: 0x20,
    },
    expected: {
      completionCycle: 1246,
      beforeDeadline: {
        busy: true,
        arint: false,
      },
      atDeadline: {
        busy: false,
        arint: true,
      },
      maskClearPiLevel: false,
      maskSetPiLevel: true,
      writeOneToClearPiLevel: false,
    },
  },
]);

function assertUint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function assertCycle(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertMemory(memory, length, name) {
  if (!(memory instanceof Uint8Array) || memory.length !== length) {
    throw new RangeError(
      `${name} must be a Uint8Array with exactly ${length} bytes`,
    );
  }
}

export function normalizeAramDmaAddress(value) {
  assertUint32(value, "ARAM DMA address");
  return value & ARAM_DMA_ADDRESS_MASK;
}

export function normalizeAramDmaCount(value) {
  assertUint32(value, "ARAM DMA count");
  return (
    (value & ARAM_DMA_DIRECTION_TO_MEM1)
    | (value & ARAM_DMA_LENGTH_MASK)
  ) >>> 0;
}

export function decodeAramDmaCount(value) {
  const countAndDirection = normalizeAramDmaCount(value);
  return Object.freeze({
    countAndDirection,
    direction: countAndDirection >>> 31,
    length: countAndDirection & ARAM_DMA_LENGTH_MASK,
  });
}

export function aramDmaCompletionCycles(length) {
  assertUint32(length, "ARAM DMA length");
  if ((length & (ARAM_DMA_GRANULE_BYTES - 1)) !== 0) {
    throw new RangeError("ARAM DMA length must be a multiple of 32 bytes");
  }
  return (length / ARAM_DMA_GRANULE_BYTES) * ARAM_DMA_CYCLES_PER_GRANULE;
}

export function createAramDmaOracleState({
  mem1 = new Uint8Array(ARAM_DMA_MEM1_BYTES),
  aram = new Uint8Array(ARAM_DMA_INTERNAL_ARAM_BYTES),
  mmAddress = 0,
  aramAddress = 0,
  countAndDirection = 0,
  dspControl = 0,
  reservationPhysicalGranule = null,
} = {}) {
  assertMemory(mem1, ARAM_DMA_MEM1_BYTES, "MEM1");
  assertMemory(aram, ARAM_DMA_INTERNAL_ARAM_BYTES, "internal ARAM");
  assertUint32(dspControl, "DSP control");
  if (reservationPhysicalGranule !== null) {
    assertUint32(
      reservationPhysicalGranule,
      "reservation physical granule",
    );
    if (
      (reservationPhysicalGranule & (ARAM_DMA_GRANULE_BYTES - 1)) !== 0
      || reservationPhysicalGranule >= ARAM_DMA_MEM1_BYTES
    ) {
      throw new RangeError(
        "reservation physical granule must be aligned inside MEM1",
      );
    }
  }

  return {
    mem1,
    aram,
    registers: {
      mmAddress: normalizeAramDmaAddress(mmAddress),
      aramAddress: normalizeAramDmaAddress(aramAddress),
      countAndDirection: normalizeAramDmaCount(countAndDirection),
      dspControl: (dspControl & ~ARAM_DMA_BUSY) & 0xffff,
    },
    reservationPhysicalGranule,
    pending: null,
    lastTransfer: null,
    lastRejection: null,
    counters: {
      starts: 0,
      completions: 0,
      busyRetriggerRejections: 0,
      interruptAssertions: 0,
    },
  };
}

export function programAramDmaRegisters(
  state,
  {
    mmAddress = state.registers.mmAddress,
    aramAddress = state.registers.aramAddress,
    countAndDirection = state.registers.countAndDirection,
  },
) {
  state.registers.mmAddress = normalizeAramDmaAddress(mmAddress);
  state.registers.aramAddress = normalizeAramDmaAddress(aramAddress);
  state.registers.countAndDirection =
    normalizeAramDmaCount(countAndDirection);
  return Object.freeze({ ...state.registers });
}

function validMem1PrefixBytes(mmAddress, length) {
  if (mmAddress >= ARAM_DMA_MEM1_BYTES) return 0;
  return Math.min(length, ARAM_DMA_MEM1_BYTES - mmAddress);
}

function copyMem1ToInternalAram(state, mmAddress, aramAddress, length) {
  let copied = 0;
  while (copied < length) {
    const target =
      (aramAddress + copied) & (ARAM_DMA_INTERNAL_ARAM_BYTES - 1);
    const chunk = Math.min(
      length - copied,
      ARAM_DMA_INTERNAL_ARAM_BYTES - target,
    );
    const source = mmAddress + copied;
    const valid = source >= ARAM_DMA_MEM1_BYTES
      ? 0
      : Math.min(chunk, ARAM_DMA_MEM1_BYTES - source);
    if (valid !== 0) {
      state.aram.set(state.mem1.subarray(source, source + valid), target);
    }
    if (valid !== chunk) {
      state.aram.fill(0, target + valid, target + chunk);
    }
    copied += chunk;
  }
}

function copyInternalAramToMem1(
  state,
  mmAddress,
  aramAddress,
  validBytes,
) {
  let copied = 0;
  while (copied < validBytes) {
    const source =
      (aramAddress + copied) & (ARAM_DMA_INTERNAL_ARAM_BYTES - 1);
    const chunk = Math.min(
      validBytes - copied,
      ARAM_DMA_INTERNAL_ARAM_BYTES - source,
    );
    state.mem1.set(
      state.aram.subarray(source, source + chunk),
      mmAddress + copied,
    );
    copied += chunk;
  }
}

function invalidateReservationForMem1Write(state, address, length) {
  const reservation = state.reservationPhysicalGranule;
  if (reservation === null || length === 0) return false;
  const end = address + length;
  const reservationEnd = reservation + ARAM_DMA_GRANULE_BYTES;
  if (address >= reservationEnd || reservation >= end) return false;
  state.reservationPhysicalGranule = null;
  return true;
}

export function triggerAramDma(state, writtenCountAndDirection, cycle) {
  assertCycle(cycle, "ARAM DMA trigger cycle");
  const decoded = decodeAramDmaCount(writtenCountAndDirection);
  if (
    state.pending !== null
    || (state.registers.dspControl & ARAM_DMA_BUSY) !== 0
  ) {
    state.counters.busyRetriggerRejections += 1;
    state.lastRejection = Object.freeze({
      reason: "busy",
      cycle,
      writtenCountAndDirection: decoded.countAndDirection,
      preservedCompletionCycle: state.pending?.completionCycle ?? null,
    });
    return Object.freeze({
      accepted: false,
      reason: "busy",
      completionCycle: state.pending?.completionCycle ?? null,
    });
  }

  const { direction, length } = decoded;
  const mmAddress = state.registers.mmAddress;
  const aramAddress = state.registers.aramAddress;
  const internalStart = aramAddress < ARAM_DMA_INTERNAL_ARAM_BYTES;
  const validMem1Bytes = validMem1PrefixBytes(mmAddress, length);
  const completionCycle = cycle + aramDmaCompletionCycles(length);
  if (!Number.isSafeInteger(completionCycle)) {
    throw new RangeError("ARAM DMA completion cycle exceeds safe integer range");
  }
  let reservationInvalidated = false;

  if (length !== 0 && internalStart && direction === 0) {
    copyMem1ToInternalAram(state, mmAddress, aramAddress, length);
  } else if (length !== 0 && internalStart) {
    copyInternalAramToMem1(
      state,
      mmAddress,
      aramAddress,
      validMem1Bytes,
    );
    reservationInvalidated = invalidateReservationForMem1Write(
      state,
      mmAddress,
      validMem1Bytes,
    );
  }

  const effect = length === 0
    ? "zero-length"
    : internalStart
      ? "internal-aram"
      : "expansion-no-op";
  const validMem1WriteRange =
    internalStart && direction === 1 && validMem1Bytes !== 0
      ? Object.freeze({
          address: mmAddress,
          length: validMem1Bytes,
        })
      : null;
  const transfer = Object.freeze({
    direction,
    mmAddress,
    aramAddress,
    length,
    triggerCycle: cycle,
    completionCycle,
    effect,
    validMem1Bytes: internalStart ? validMem1Bytes : 0,
    zeroSourceBytes:
      internalStart && direction === 0 ? length - validMem1Bytes : 0,
    ignoredDestinationBytes:
      internalStart && direction === 1 ? length - validMem1Bytes : 0,
    expansionNoOpBytes: internalStart ? 0 : length,
    validMem1WriteRange,
    reservationInvalidated,
  });

  state.registers.mmAddress =
    (mmAddress + length) & ARAM_DMA_ADDRESS_MASK;
  state.registers.aramAddress =
    (aramAddress + length) & ARAM_DMA_ADDRESS_MASK;
  state.registers.countAndDirection =
    direction === 0 ? 0 : ARAM_DMA_DIRECTION_TO_MEM1;
  state.registers.dspControl |= ARAM_DMA_BUSY;
  state.pending = transfer;
  state.lastTransfer = transfer;
  state.lastRejection = null;
  state.counters.starts += 1;

  return Object.freeze({
    accepted: true,
    transfer,
  });
}

export function serviceAramDma(state, observedCycle) {
  assertCycle(observedCycle, "ARAM DMA service cycle");
  if (state.pending === null) {
    return Object.freeze({ completed: false, reason: "idle" });
  }
  if (observedCycle < state.pending.completionCycle) {
    return Object.freeze({
      completed: false,
      reason: "before-deadline",
      completionCycle: state.pending.completionCycle,
    });
  }

  const transfer = state.pending;
  state.pending = null;
  state.registers.dspControl =
    (state.registers.dspControl & ~ARAM_DMA_BUSY)
    | ARAM_DMA_INTERRUPT_STATUS;
  state.counters.completions += 1;
  state.counters.interruptAssertions += 1;
  return Object.freeze({
    completed: true,
    completionCycle: transfer.completionCycle,
    servicedAtCycle: observedCycle,
  });
}

export function writeAramDspControl(state, value) {
  assertUint32(value, "DSP control write");
  const current = state.registers.dspControl & 0xffff;
  const written = value & 0xffff;
  const status =
    (current & ARAM_DMA_INTERRUPT_STATUS)
    & ~(written & ARAM_DMA_INTERRUPT_STATUS);
  state.registers.dspControl = (
    (written & ~(ARAM_DMA_BUSY | ARAM_DMA_INTERRUPT_STATUS))
    | (current & ARAM_DMA_BUSY)
    | status
  ) & 0xffff;
  return state.registers.dspControl;
}

export function aramDmaPiInterruptLevel(state) {
  const control = state.registers.dspControl;
  return (
    (control & ARAM_DMA_INTERRUPT_STATUS) !== 0
    && (control & ARAM_DMA_INTERRUPT_MASK) !== 0
  );
}

export function snapshotAramDmaOracleState(state) {
  return {
    registers: { ...state.registers },
    reservationPhysicalGranule: state.reservationPhysicalGranule,
    pending: state.pending === null ? null : { ...state.pending },
    lastTransfer:
      state.lastTransfer === null ? null : { ...state.lastTransfer },
    lastRejection:
      state.lastRejection === null ? null : { ...state.lastRejection },
    counters: { ...state.counters },
    piInterruptLevel: aramDmaPiInterruptLevel(state),
  };
}
