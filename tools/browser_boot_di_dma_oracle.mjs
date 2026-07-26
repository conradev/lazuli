// SPDX-License-Identifier: GPL-3.0-only

export const DI_DMA_MEM1_BYTES = 0x01800000;
export const DI_DMA_GRANULE_BYTES = 32;
export const DI_DMA_ADDRESS_MASK = 0x03ffffe0;
export const DI_DMA_LENGTH_MASK = 0xffffffe0;
export const DI_DMA_CONTROL_MASK = 0x00000007;
export const DI_DMA_TRANSFER_START = 0x00000001;
export const DI_DMA_MODE = 0x00000002;
export const DI_DMA_WRITE = 0x00000004;

export const DI_BREAK_REQUEST = 0x00000001;
export const DI_DEVICE_ERROR_MASK = 0x00000002;
export const DI_DEVICE_ERROR_STATUS = 0x00000004;
export const DI_TRANSFER_COMPLETE_MASK = 0x00000008;
export const DI_TRANSFER_COMPLETE_STATUS = 0x00000010;
export const DI_BREAK_MASK = 0x00000020;
export const DI_BREAK_STATUS = 0x00000040;
export const DI_INTERRUPT_MASKS = 0x0000002a;
export const DI_INTERRUPT_STATUSES = 0x00000054;

export const DI_CPU_CYCLES_PER_SECOND = 486_000_000;
export const DI_MINIMUM_COMMAND_LATENCY_CYCLES = 145_800;
export const DI_READ_START_LATENCY_CYCLES = 291_600;
export const DI_BUFFER_TRANSFER_BYTES_PER_SECOND = 32 * 1024 * 1024;
export const DI_DVD_ECC_BLOCK_BYTES = 0x8000;

export const DI_ERROR_NONE = 0x00000000;
export const DI_ERROR_READ = 0x00031100;
export const DI_ERROR_PROTOCOL = 0x00040800;
export const DI_ERROR_INVALID_COMMAND = 0x00052000;
export const DI_ERROR_BLOCK_OUT_OF_BOUNDS = 0x00052100;
export const DI_ERROR_INVALID_FIELD = 0x00052400;

export const DI_INQUIRY_COMPATIBILITY_BYTES = Object.freeze([
  0x00, 0x00, 0x00, 0x02,
  0x20, 0x06, 0x05, 0x26,
  0x41, 0x00, 0x00, 0x00,
]);

export const DI_DMA_AUTHORITY_CLASS = Object.freeze({
  provenHardware: "proven-hardware",
  dolphinCompatibility: "dolphin-compatibility-policy",
  lazuliConservative: "lazuli-conservative-policy",
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const DI_DMA_SOURCES = deepFreeze({
  retainedHardwareObservation: {
    classification: "retained-hardware-observation",
    revision: "d742aa8b4c4d052f7dceaa39022b1fe3996f1781",
    path: "Source/Core/Core/HW/DVD/DVDInterface.cpp",
    symbol: "DVDInterface::RegisterMMIO",
    claim:
      "The GameCube DI DMA address register's top and bottom masks were observed by register readback.",
    limit:
      "No Nintendo DI programming manual or local console-capture vector is present in this tree, so no other outcome is promoted to proven hardware.",
  },
  dolphinInterface: {
    classification: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    revision: "d742aa8b4c4d052f7dceaa39022b1fe3996f1781",
    paths: [
      "Source/Core/Core/HW/DVD/DVDInterface.cpp",
      "Source/Core/Core/HW/DVD/DVDInterface.h",
      "Source/Core/Core/HW/DVD/DVDThread.cpp",
      "Source/Core/Core/HW/Memmap.cpp",
    ],
    symbols: [
      "DVDInterface::RegisterMMIO",
      "DVDInterface::ExecuteReadCommand",
      "DVDInterface::ExecuteCommand",
      "DVDInterface::FinishExecutingCommand",
      "DVDInterface::ScheduleReads",
      "DVDThread::FinishRead",
      "MemoryManager::CopyToEmu",
    ],
  },
  currentLazuli: {
    classification: "current-lazuli-audit",
    path: "crates/ppcwasmjit/examples/browser_boot.rs",
    symbols: [
      "writeDiskStatus",
      "dueDiskTransferPromise",
      "beginDiskCommand",
      "serviceDisk",
    ],
    existingTest: "tools/browser_boot_di.test.mjs",
  },
});

export const DI_DMA_AUTHORITY = deepFreeze({
  provenHardware: {
    classification: DI_DMA_AUTHORITY_CLASS.provenHardware,
    claims: [],
    finding:
      "No DI DMA outcome is established as proven hardware by the primary evidence available in this tree.",
    caveat:
      "The pinned source retains a register-readback observation, but without its primary console capture it remains supporting context rather than a Lazuli hardware proof.",
  },
  dolphinCompatibility: {
    classification: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    claims: [
      "GameCube DMA address writes retain bits 5 through 25; the pinned source says this mask was observed by register readback.",
      "DMA length writes clear the low five bits; control writes retain only TSTART, DMA, and RW.",
      "DI status interrupt bits are sticky W1C, their masks are writable, and the PI level is the OR of each status-and-mask pair.",
      "Read-sector offset is command word 1 multiplied by four; read-disc-ID requests 32 bytes at offset zero.",
      "Disc data is copied only when the asynchronous read completes; TC then advances DIMAR, consumes DILENGTH, and clears TSTART.",
      "Out-of-bounds reads report BlockOOB with DEINT and do not advance DMA registers.",
      "Inquiry writes its 12 compatibility bytes immediately, before delayed TC completion.",
      "Read scheduling has a 600 microsecond start cost and at most 32 MiB/s buffered transfer rate; seek, rotation, and buffer state can add latency.",
    ],
    caveat:
      "These outcomes intentionally match the selected Dolphin revision and are not asserted as exact console timing.",
  },
  lazuliConservative: {
    classification: DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    claims: [
      "Only an equal, nonzero requested length and DMA length is admitted to the certified read path.",
      "A transaction must fit wholly in MEM1; a partial valid prefix is reported but no prefix is committed.",
      "A command start, register rewrite, or control rewrite while BUSY is rejected without replacing the accepted transaction.",
      "Successful disc reads invalidate only an overlapping MEM1 reservation and only when bytes commit at completion.",
      "Successful-read timing must be supplied by an external scheduler and cannot precede the Dolphin buffered lower bound.",
    ],
    caveat:
      "These are bounded, fail-closed emulator policies for unresolved behavior, not claims about undefined physical-bus behavior.",
  },
});

export const DI_DMA_CURRENT_LAZULI_AUDIT = deepFreeze({
  observations: [
    "DI command, address, and length registers currently use generic MMIO storage, so DMA address and length write masks are not applied.",
    "Read-sector command words, DMA base, and length are captured when serviceDisk observes TSTART.",
    "Read data commits only after the host promise is ready, but both read and inquiry currently use a flat 10,000-cycle deadline.",
    "Inquiry immediately writes 32 bytes (12 identifying bytes plus a zero-filled suffix), while pinned Dolphin immediately writes only 12 bytes.",
    "ramPointer requires the entire DMA range, making an end-of-MEM1 request atomic rather than a valid-prefix write.",
    "A successful read clears DILENGTH but does not advance DIMAR.",
    "Disc bounds are delegated to discSource; a missing, short, or failed host read becomes a host exception instead of a DI DEINT result.",
  ],
  existingCoverage: [
    "DI status W1C, masks, and level assertion",
    "delayed non-read command completion",
    "DTK command behavior",
  ],
  missingCoverage: [
    "read DMA register masks",
    "read command latching and BUSY",
    "completion-time memory and reservation effects",
    "disc-range and host-read errors",
  ],
});

export const DI_DMA_UNRESOLVED = deepFreeze([
  {
    id: "exact-hardware-read-timing",
    policy:
      "Require a caller-supplied completion cycle at or after the pinned Dolphin buffered lower bound.",
  },
  {
    id: "busy-retrigger-and-register-rewrite",
    policy: "Reject and preserve the accepted transaction.",
  },
  {
    id: "mismatched-request-and-dma-length",
    policy:
      "Reject; Dolphin clamps the disc read but finishes against DILENGTH, while current Lazuli requires equality.",
  },
  {
    id: "zero-length-read",
    policy:
      "Reject; pinned Dolphin explicitly marks seek behavior for this case as untested.",
  },
  {
    id: "partial-or-invalid-mem1-target",
    policy:
      "Report the valid prefix but reject atomically; do not invent physical-bus suffix behavior.",
  },
  {
    id: "hardware-reservation-effect",
    policy:
      "Apply only Lazuli's conservative external-write invalidation at the actual commit point.",
  },
]);

export const diDmaOracleVectors = deepFreeze([
  {
    id: "register-programming-masks",
    authority: [DI_DMA_AUTHORITY_CLASS.dolphinCompatibility],
    outcomeAuthority: {
      dmaAddress: {
        classification: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
        supportingEvidence: "retained-hardware-observation",
      },
      dmaLength: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      control: DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    },
    input: {
      dmaAddress: 0xffffffff,
      dmaLength: 0xffffffff,
      control: 0xffffffff,
    },
    expected: {
      dmaAddress: DI_DMA_ADDRESS_MASK,
      dmaLength: DI_DMA_LENGTH_MASK,
      control: DI_DMA_CONTROL_MASK,
    },
  },
  {
    id: "read-latched-completion",
    authority: [
      DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    outcomeAuthority: {
      decodeTimingMemoryAndRegisters:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      immutableLatchAndReservation:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    },
    input: {
      cycle: 1000,
      command0: 0xa8000000,
      command1: 0x00000100,
      command2: 0x00000020,
      dmaAddress: 0x00000200,
      dmaLength: 0x00000020,
      discEndOffset: 0x00200000,
    },
    expected: {
      discOffset: 0x00000400,
      completionCycle: 293063,
      dmaAddress: 0x00000220,
      dmaLength: 0,
      status: DI_TRANSFER_COMPLETE_STATUS,
      control: DI_DMA_MODE,
      memoryCommit: "completion",
    },
  },
  {
    id: "host-ready-after-deadline",
    authority: [
      DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    outcomeAuthority: {
      asynchronousHostGate:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      preservedBusyTransaction:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    },
    input: {
      cycle: 2000,
      length: 0x20,
    },
    expected: {
      completionCycle: 294063,
      beforeHostResult: "host-pending",
      remainsBusy: true,
      completionAfterHostResult: true,
    },
  },
  {
    id: "inquiry-immediate-delayed-completion",
    authority: [
      DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    outcomeAuthority: {
      immediateBytesAndDelayedCompletion:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      reservationInvalidation:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    },
    input: {
      cycle: 3000,
      dmaAddress: 0x00000300,
      dmaLength: 0x20,
    },
    expected: {
      immediateWriteBytes: 12,
      preservedSuffixBytes: 20,
      completionCycle: 148800,
      dmaAddress: 0x00000320,
      dmaLength: 0,
      statusAtStart: 0,
      statusAtCompletion: DI_TRANSFER_COMPLETE_STATUS,
    },
  },
  {
    id: "read-disc-id",
    authority: [DI_DMA_AUTHORITY_CLASS.dolphinCompatibility],
    input: {
      cycle: 4000,
      command0: 0xa8000040,
      dmaAddress: 0x00000400,
      dmaLength: 0x20,
      discEndOffset: 0x00200000,
    },
    expected: {
      discOffset: 0,
      transferLength: 0x20,
      completionCycle: 296063,
    },
  },
  {
    id: "disc-range-error",
    authority: [
      DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    outcomeAuthority: {
      errorStatusAndRegisters:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      reservationPreservation:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    },
    input: {
      cycle: 5000,
      command1: 0x000003f8,
      length: 0x40,
      discEndOffset: 0x1000,
    },
    expected: {
      discOffset: 0x0fe0,
      completionCycle: 150800,
      errorCode: DI_ERROR_BLOCK_OUT_OF_BOUNDS,
      status: DI_DEVICE_ERROR_STATUS,
      dmaRegistersAdvance: false,
      memoryWriteBytes: 0,
    },
  },
  {
    id: "short-host-read-error",
    authority: [
      DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    outcomeAuthority: {
      errorStatusAndRegisters:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      reservationPreservation:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    },
    input: {
      cycle: 6000,
      requestedLength: 0x40,
      hostLength: 0x20,
    },
    expected: {
      errorCode: DI_ERROR_READ,
      status: DI_DEVICE_ERROR_STATUS,
      dmaRegistersAdvance: false,
      memoryWriteBytes: 0,
    },
  },
  {
    id: "interrupt-mask-and-w1c",
    authority: [DI_DMA_AUTHORITY_CLASS.dolphinCompatibility],
    input: {
      initialStatus: DI_DEVICE_ERROR_STATUS | DI_TRANSFER_COMPLETE_STATUS,
      firstWrite:
        DI_DEVICE_ERROR_STATUS
        | DI_TRANSFER_COMPLETE_MASK,
      secondWrite:
        DI_TRANSFER_COMPLETE_STATUS
        | DI_TRANSFER_COMPLETE_MASK,
    },
    expected: {
      afterFirstWrite:
        DI_TRANSFER_COMPLETE_STATUS
        | DI_TRANSFER_COMPLETE_MASK,
      firstPiLevel: true,
      afterSecondWrite: DI_TRANSFER_COMPLETE_MASK,
      secondPiLevel: false,
    },
  },
  {
    id: "busy-retrigger-rejected",
    authority: [DI_DMA_AUTHORITY_CLASS.lazuliConservative],
    input: {
      firstCycle: 7000,
      retryCycle: 7010,
      length: 0x20,
    },
    expected: {
      secondTransferAccepted: false,
      reason: "busy",
      acceptedTransactionPreserved: true,
    },
  },
  {
    id: "mem1-valid-prefix-atomic-rejection",
    authority: [DI_DMA_AUTHORITY_CLASS.lazuliConservative],
    outcomeAuthority: {
      validPrefixMeasurement:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
      oracleOutcome:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
      currentLazuliOutcome: "current-lazuli-audit",
      dolphinCopyOutcome:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    },
    input: {
      dmaAddress: 0x017fffe0,
      length: 0x40,
    },
    expected: {
      validPrefixBytes: 0x20,
      fullRangeValid: false,
      oracleOutcome: "model-rejection",
      currentLazuliOutcome: "host-check-rejection",
      dolphinCopyOutcome: "whole-range-no-write",
      memoryWriteBytes: 0,
      reservationInvalidated: false,
    },
  },
  {
    id: "length-mismatch-fail-closed",
    authority: [
      DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    outcomeAuthority: {
      dolphinTransferLength:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      oracleRejection:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    },
    input: {
      requestedLength: 0x40,
      dmaLength: 0x20,
    },
    expected: {
      dolphinTransferLength: 0x20,
      oracleAccepted: false,
      reason: "uncertified-length-mismatch",
    },
  },
  {
    id: "zero-length-and-missing-timing-fail-closed",
    authority: [DI_DMA_AUTHORITY_CLASS.lazuliConservative],
    input: {
      zeroLength: 0,
      validLengthWithoutCompletionCycle: 0x20,
    },
    expected: {
      zeroLengthReason: "uncertified-zero-length",
      missingTimingReason: "completion-cycle-required",
    },
  },
  {
    id: "uncertified-preflight-and-host-failure",
    authority: [
      DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
      DI_DMA_AUTHORITY_CLASS.lazuliConservative,
    ],
    outcomeAuthority: {
      preflightRejections:
        DI_DMA_AUTHORITY_CLASS.lazuliConservative,
      explicitHostFailure:
        DI_DMA_AUTHORITY_CLASS.dolphinCompatibility,
    },
    input: {
      unsupportedCommand0: 0x99000000,
      invalidControl: DI_DMA_TRANSFER_START,
      overlongHostLength: 0x40,
    },
    expected: {
      unsupportedCommandReason: "uncertified-command",
      invalidControlReason: "uncertified-control-mode",
      unknownDiscRangeReason: "disc-range-unknown",
      overlongHostReason: "uncertified-overlong-host-read",
      explicitHostFailureErrorCode: DI_ERROR_READ,
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

function assertMemory(memory) {
  if (!(memory instanceof Uint8Array) || memory.length !== DI_DMA_MEM1_BYTES) {
    throw new RangeError(
      `MEM1 must be a Uint8Array with exactly ${DI_DMA_MEM1_BYTES} bytes`,
    );
  }
}

function assertDiscEndOffset(value) {
  if (
    value !== null
    && (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new RangeError(
      "disc end offset must be null or a non-negative safe integer",
    );
  }
}

export function normalizeDiDmaAddress(value) {
  assertUint32(value, "DI DMA address");
  return value & DI_DMA_ADDRESS_MASK;
}

export function normalizeDiDmaLength(value) {
  assertUint32(value, "DI DMA length");
  return (value & DI_DMA_LENGTH_MASK) >>> 0;
}

export function normalizeDiDmaControl(value) {
  assertUint32(value, "DI DMA control");
  return value & DI_DMA_CONTROL_MASK;
}

export function diBufferedReadLowerBoundCycles(length, discOffset = 0) {
  assertUint32(length, "DI read length");
  if (!Number.isSafeInteger(discOffset) || discOffset < 0) {
    throw new RangeError(
      "DI disc offset must be a non-negative safe integer",
    );
  }
  let remaining = length;
  let offset = discOffset;
  let transferCycles = 0;
  while (remaining !== 0) {
    const offsetInBlock = offset % DI_DVD_ECC_BLOCK_BYTES;
    const bytesToBoundary =
      DI_DVD_ECC_BLOCK_BYTES - offsetInBlock;
    const chunkLength = Math.min(remaining, bytesToBoundary);
    transferCycles += Number(
      BigInt(chunkLength) * BigInt(DI_CPU_CYCLES_PER_SECOND)
        / BigInt(DI_BUFFER_TRANSFER_BYTES_PER_SECOND),
    );
    offset += chunkLength;
    remaining -= chunkLength;
  }
  return DI_READ_START_LATENCY_CYCLES + transferCycles;
}

export function classifyDiDmaLength(requestedLength, dmaLength) {
  assertUint32(requestedLength, "DI requested length");
  assertUint32(dmaLength, "DI DMA length");
  const normalizedDmaLength = normalizeDiDmaLength(dmaLength);
  return Object.freeze({
    requestedLength,
    dmaLength: normalizedDmaLength,
    dolphinTransferLength: Math.min(requestedLength, normalizedDmaLength),
    oracleAccepted:
      requestedLength !== 0
      && requestedLength === normalizedDmaLength,
    reason: requestedLength === 0
      ? "uncertified-zero-length"
      : requestedLength !== normalizedDmaLength
        ? "uncertified-length-mismatch"
        : null,
  });
}

export function classifyDiMem1Range(dmaAddress, length) {
  assertUint32(dmaAddress, "DI DMA address");
  assertUint32(length, "DI DMA range length");
  const address = normalizeDiDmaAddress(dmaAddress);
  const validPrefixBytes = address >= DI_DMA_MEM1_BYTES
    ? 0
    : Math.min(length, DI_DMA_MEM1_BYTES - address);
  return Object.freeze({
    dmaAddress: address,
    length,
    validPrefixBytes,
    invalidSuffixBytes: length - validPrefixBytes,
    fullRangeValid: validPrefixBytes === length,
  });
}

export function createDiDmaOracleState({
  mem1 = new Uint8Array(DI_DMA_MEM1_BYTES),
  discEndOffset = null,
  command0 = 0,
  command1 = 0,
  command2 = 0,
  dmaAddress = 0,
  dmaLength = 0,
  control = 0,
  immediateData = 0,
  status = 0,
  reservationPhysicalGranule = null,
} = {}) {
  assertMemory(mem1);
  assertDiscEndOffset(discEndOffset);
  for (const [name, value] of Object.entries({
    command0,
    command1,
    command2,
    immediateData,
    status,
  })) {
    assertUint32(value, name);
  }
  if (reservationPhysicalGranule !== null) {
    assertUint32(
      reservationPhysicalGranule,
      "reservation physical granule",
    );
    if (
      (reservationPhysicalGranule & (DI_DMA_GRANULE_BYTES - 1)) !== 0
      || reservationPhysicalGranule >= DI_DMA_MEM1_BYTES
    ) {
      throw new RangeError(
        "reservation physical granule must be aligned inside MEM1",
      );
    }
  }

  return {
    mem1,
    discEndOffset,
    registers: {
      status: status & (DI_BREAK_REQUEST | DI_INTERRUPT_MASKS | DI_INTERRUPT_STATUSES),
      command0,
      command1,
      command2,
      dmaAddress: normalizeDiDmaAddress(dmaAddress),
      dmaLength: normalizeDiDmaLength(dmaLength),
      control: normalizeDiDmaControl(control) & ~DI_DMA_TRANSFER_START,
      immediateData,
    },
    reservationPhysicalGranule,
    driveError: DI_ERROR_NONE,
    pending: null,
    lastStarted: null,
    lastCompletion: null,
    lastRejection: null,
    counters: {
      starts: 0,
      completions: 0,
      deviceErrors: 0,
      transferCompletions: 0,
      hostWaits: 0,
      rejections: 0,
      busyRetriggerRejections: 0,
      busyRegisterWriteRejections: 0,
      reservationInvalidations: 0,
    },
  };
}

function reject(state, reason, details = {}) {
  const rejection = Object.freeze({ reason, ...details });
  state.lastRejection = rejection;
  state.counters.rejections += 1;
  return Object.freeze({ accepted: false, ...rejection });
}

export function programDiDmaRegisters(
  state,
  {
    command0 = state.registers.command0,
    command1 = state.registers.command1,
    command2 = state.registers.command2,
    dmaAddress = state.registers.dmaAddress,
    dmaLength = state.registers.dmaLength,
    immediateData = state.registers.immediateData,
  } = {},
) {
  for (const [name, value] of Object.entries({
    command0,
    command1,
    command2,
    dmaAddress,
    dmaLength,
    immediateData,
  })) {
    assertUint32(value, name);
  }
  if (state.pending !== null) {
    state.counters.busyRegisterWriteRejections += 1;
    return reject(state, "busy-register-programming", {
      completionCycle: state.pending.completionCycle,
    });
  }

  state.registers.command0 = command0;
  state.registers.command1 = command1;
  state.registers.command2 = command2;
  state.registers.dmaAddress = normalizeDiDmaAddress(dmaAddress);
  state.registers.dmaLength = normalizeDiDmaLength(dmaLength);
  state.registers.immediateData = immediateData;
  state.lastRejection = null;
  return Object.freeze({
    accepted: true,
    registers: Object.freeze({ ...state.registers }),
  });
}

function invalidateReservationForWrite(state, address, length) {
  const reservation = state.reservationPhysicalGranule;
  if (reservation === null || length === 0) return false;
  const writeEnd = address + length;
  const reservationEnd = reservation + DI_DMA_GRANULE_BYTES;
  if (address >= reservationEnd || reservation >= writeEnd) return false;
  state.reservationPhysicalGranule = null;
  state.counters.reservationInvalidations += 1;
  return true;
}

function commandTransaction(state) {
  const {
    command0,
    command1,
    command2,
    dmaAddress,
    dmaLength,
  } = state.registers;
  const opcode = command0 >>> 24;
  const subcommand = command0 & 0xff;

  if (opcode === 0x12) {
    return {
      kind: "inquiry",
      opcode,
      subcommand,
      command0,
      command1,
      command2,
      discOffset: null,
      transferLength: dmaLength,
      dmaAddress,
      dmaLength,
    };
  }
  if (opcode === 0xa8 && (subcommand === 0 || subcommand === 0x40)) {
    const discId = subcommand === 0x40;
    return {
      kind: discId ? "read-disc-id" : "read-sector",
      opcode,
      subcommand,
      command0,
      command1,
      command2,
      discOffset: discId ? 0 : command1 * 4,
      transferLength: discId ? 0x20 : command2,
      dmaAddress,
      dmaLength,
    };
  }
  return null;
}

function validateCompletionCycle(
  cycle,
  discOffset,
  length,
  completionCycle,
) {
  if (completionCycle === undefined || completionCycle === null) {
    return {
      accepted: false,
      reason: "completion-cycle-required",
      minimumCompletionCycle:
        cycle + diBufferedReadLowerBoundCycles(length, discOffset),
    };
  }
  assertCycle(completionCycle, "DI completion cycle");
  const minimumCompletionCycle =
    cycle + diBufferedReadLowerBoundCycles(length, discOffset);
  if (!Number.isSafeInteger(minimumCompletionCycle)) {
    throw new RangeError("DI completion cycle exceeds safe integer range");
  }
  if (completionCycle < minimumCompletionCycle) {
    return {
      accepted: false,
      reason: "completion-before-buffered-lower-bound",
      minimumCompletionCycle,
    };
  }
  return { accepted: true, completionCycle, minimumCompletionCycle };
}

export function writeDiDmaControl(
  state,
  value,
  cycle,
  { completionCycle = null } = {},
) {
  assertCycle(cycle, "DI control write cycle");
  const control = normalizeDiDmaControl(value);
  if (state.pending !== null) {
    state.counters.busyRetriggerRejections += 1;
    return reject(state, "busy", {
      writtenControl: control,
      completionCycle: state.pending.completionCycle,
    });
  }
  if ((control & DI_DMA_TRANSFER_START) === 0) {
    state.registers.control = control;
    state.lastRejection = null;
    return Object.freeze({ accepted: true, started: false, control });
  }
  if (
    (control & DI_DMA_MODE) === 0
    || (control & DI_DMA_WRITE) !== 0
  ) {
    return reject(state, "uncertified-control-mode", { writtenControl: control });
  }

  const transactionDraft = commandTransaction(state);
  if (transactionDraft === null) {
    return reject(state, "uncertified-command", {
      command0: state.registers.command0,
    });
  }

  if (
    transactionDraft.kind === "inquiry"
    && transactionDraft.dmaLength !== 0x20
  ) {
    return reject(state, "uncertified-inquiry-length", {
      dmaLength: transactionDraft.dmaLength,
    });
  }

  const lengthClassification = classifyDiDmaLength(
    transactionDraft.transferLength,
    transactionDraft.dmaLength,
  );
  if (!lengthClassification.oracleAccepted) {
    return reject(state, lengthClassification.reason, {
      requestedLength: transactionDraft.transferLength,
      dmaLength: transactionDraft.dmaLength,
      dolphinTransferLength: lengthClassification.dolphinTransferLength,
    });
  }

  const range = classifyDiMem1Range(
    transactionDraft.dmaAddress,
    transactionDraft.transferLength,
  );
  if (!range.fullRangeValid) {
    return reject(state, "uncertified-mem1-range", {
      dmaAddress: range.dmaAddress,
      length: range.length,
      validPrefixBytes: range.validPrefixBytes,
      invalidSuffixBytes: range.invalidSuffixBytes,
    });
  }

  let scheduledCompletionCycle;
  let interruptStatus = DI_TRANSFER_COMPLETE_STATUS;
  let errorCode = DI_ERROR_NONE;
  let hostReady = transactionDraft.kind === "inquiry";
  let timingModel;

  if (transactionDraft.kind === "inquiry") {
    scheduledCompletionCycle =
      cycle + DI_MINIMUM_COMMAND_LATENCY_CYCLES;
    timingModel = "dolphin-minimum-command-latency";
  } else {
    if (state.discEndOffset === null) {
      return reject(state, "disc-range-unknown", {
        discOffset: transactionDraft.discOffset,
        transferLength: transactionDraft.transferLength,
      });
    }
    const discEnd =
      transactionDraft.discOffset + transactionDraft.transferLength;
    if (!Number.isSafeInteger(discEnd)) {
      return reject(state, "disc-range-overflow", {
        discOffset: transactionDraft.discOffset,
        transferLength: transactionDraft.transferLength,
      });
    }
    if (discEnd > state.discEndOffset) {
      scheduledCompletionCycle =
        cycle + DI_MINIMUM_COMMAND_LATENCY_CYCLES;
      interruptStatus = DI_DEVICE_ERROR_STATUS;
      errorCode = DI_ERROR_BLOCK_OUT_OF_BOUNDS;
      hostReady = true;
      timingModel = "dolphin-minimum-command-latency";
    } else {
      const timing = validateCompletionCycle(
        cycle,
        transactionDraft.discOffset,
        transactionDraft.transferLength,
        completionCycle,
      );
      if (!timing.accepted) {
        return reject(state, timing.reason, {
          minimumCompletionCycle: timing.minimumCompletionCycle,
        });
      }
      scheduledCompletionCycle = timing.completionCycle;
      timingModel = "external-at-or-after-dolphin-buffered-lower-bound";
    }
  }
  if (!Number.isSafeInteger(scheduledCompletionCycle)) {
    throw new RangeError("DI completion cycle exceeds safe integer range");
  }

  const transaction = Object.freeze({
    ...transactionDraft,
    triggerCycle: cycle,
    completionCycle: scheduledCompletionCycle,
    minimumBufferedCompletionCycle:
      transactionDraft.kind === "inquiry"
        ? null
        : cycle
          + diBufferedReadLowerBoundCycles(
            transactionDraft.transferLength,
            transactionDraft.discOffset,
          ),
    timingModel,
    control,
  });

  let reservationInvalidatedAtStart = false;
  if (transaction.kind === "inquiry") {
    state.mem1.set(
      DI_INQUIRY_COMPATIBILITY_BYTES,
      transaction.dmaAddress,
    );
    reservationInvalidatedAtStart = invalidateReservationForWrite(
      state,
      transaction.dmaAddress,
      DI_INQUIRY_COMPATIBILITY_BYTES.length,
    );
  }

  state.registers.control = control;
  state.driveError = errorCode;
  state.pending = {
    transaction,
    completionCycle: scheduledCompletionCycle,
    interruptStatus,
    errorCode,
    hostReady,
    hostPayload: null,
    hostError: null,
    hostWaitRecorded: false,
    reservationInvalidatedAtStart,
  };
  state.lastStarted = transaction;
  state.lastRejection = null;
  state.counters.starts += 1;
  return Object.freeze({
    accepted: true,
    started: true,
    transaction,
    interruptStatus,
    errorCode,
    reservationInvalidatedAtStart,
  });
}

export function provideDiDmaReadData(state, payload) {
  if (
    state.pending === null
    || state.pending.transaction.kind === "inquiry"
  ) {
    return Object.freeze({ accepted: false, reason: "no-pending-disc-read" });
  }
  if (state.pending.hostReady) {
    return Object.freeze({ accepted: false, reason: "host-result-already-set" });
  }
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError("DI host read payload must be a Uint8Array");
  }

  const expectedLength = state.pending.transaction.transferLength;
  if (payload.length > expectedLength) {
    return Object.freeze({
      accepted: false,
      reason: "uncertified-overlong-host-read",
      expectedLength,
      actualLength: payload.length,
    });
  }
  state.pending.hostReady = true;
  if (payload.length !== expectedLength) {
    state.pending.hostError = Object.freeze({
      reason: "host-length-mismatch",
      mismatch: payload.length === 0 ? "empty" : "short",
      expectedLength,
      actualLength: payload.length,
      errorCode: DI_ERROR_READ,
    });
    return Object.freeze({
      accepted: true,
      complete: false,
      hostError: state.pending.hostError,
    });
  }

  state.pending.hostPayload = new Uint8Array(payload);
  return Object.freeze({
    accepted: true,
    complete: false,
    payloadLength: payload.length,
  });
}

export function provideDiDmaReadError(
  state,
  { reason = "host-read-failed" } = {},
) {
  if (
    state.pending === null
    || state.pending.transaction.kind === "inquiry"
  ) {
    return Object.freeze({ accepted: false, reason: "no-pending-disc-read" });
  }
  if (state.pending.hostReady) {
    return Object.freeze({ accepted: false, reason: "host-result-already-set" });
  }
  if (typeof reason !== "string" || reason.length === 0) {
    throw new TypeError("DI host read error reason must be a non-empty string");
  }
  state.pending.hostReady = true;
  state.pending.hostError = Object.freeze({
    reason,
    expectedLength: state.pending.transaction.transferLength,
    actualLength: null,
    errorCode: DI_ERROR_READ,
  });
  return Object.freeze({
    accepted: true,
    complete: false,
    hostError: state.pending.hostError,
  });
}

export function serviceDiDma(state, observedCycle) {
  assertCycle(observedCycle, "DI service cycle");
  if (state.pending === null) {
    return Object.freeze({ completed: false, reason: "idle" });
  }
  const pending = state.pending;
  if (observedCycle < pending.completionCycle) {
    return Object.freeze({
      completed: false,
      reason: "before-deadline",
      completionCycle: pending.completionCycle,
    });
  }
  if (!pending.hostReady) {
    if (!pending.hostWaitRecorded) {
      pending.hostWaitRecorded = true;
      state.counters.hostWaits += 1;
    }
    return Object.freeze({
      completed: false,
      reason: "host-pending",
      completionCycle: pending.completionCycle,
    });
  }

  const transaction = pending.transaction;
  let interruptStatus = pending.interruptStatus;
  let errorCode = pending.errorCode;
  let memoryWriteBytes = 0;
  let reservationInvalidated =
    pending.reservationInvalidatedAtStart;

  if (pending.hostError !== null) {
    interruptStatus = DI_DEVICE_ERROR_STATUS;
    errorCode = pending.hostError.errorCode;
  } else if (
    interruptStatus === DI_TRANSFER_COMPLETE_STATUS
    && transaction.kind !== "inquiry"
  ) {
    state.mem1.set(pending.hostPayload, transaction.dmaAddress);
    memoryWriteBytes = transaction.transferLength;
    reservationInvalidated = invalidateReservationForWrite(
      state,
      transaction.dmaAddress,
      transaction.transferLength,
    );
  }

  const successful = interruptStatus === DI_TRANSFER_COMPLETE_STATUS;
  if (successful) {
    state.registers.dmaAddress =
      (transaction.dmaAddress + transaction.dmaLength) >>> 0;
    state.registers.dmaLength = 0;
  }
  state.registers.control &= ~DI_DMA_TRANSFER_START;
  state.registers.status |= interruptStatus;
  state.driveError = errorCode;
  state.pending = null;
  state.counters.completions += 1;
  if (successful) {
    state.counters.transferCompletions += 1;
  } else {
    state.counters.deviceErrors += 1;
  }

  const completion = Object.freeze({
    transaction,
    successful,
    interruptStatus,
    errorCode,
    memoryWriteBytes,
    reservationInvalidated,
    completionCycle: transaction.completionCycle,
    servicedAtCycle: observedCycle,
  });
  state.lastCompletion = completion;
  return Object.freeze({ completed: true, ...completion });
}

export function writeDiStatus(state, value) {
  assertUint32(value, "DI status write");
  const current = state.registers.status;
  const statuses =
    (current & DI_INTERRUPT_STATUSES)
    & ~(value & DI_INTERRUPT_STATUSES);
  state.registers.status = (
    statuses
    | (value & DI_INTERRUPT_MASKS)
    | (value & DI_BREAK_REQUEST)
  ) >>> 0;
  return state.registers.status;
}

export function diDmaPiInterruptLevel(state) {
  const status = state.registers.status;
  return (
    (
      (status & DI_DEVICE_ERROR_STATUS) !== 0
      && (status & DI_DEVICE_ERROR_MASK) !== 0
    )
    || (
      (status & DI_TRANSFER_COMPLETE_STATUS) !== 0
      && (status & DI_TRANSFER_COMPLETE_MASK) !== 0
    )
    || (
      (status & DI_BREAK_STATUS) !== 0
      && (status & DI_BREAK_MASK) !== 0
    )
  );
}

export function snapshotDiDmaOracleState(state) {
  return {
    discEndOffset: state.discEndOffset,
    registers: { ...state.registers },
    reservationPhysicalGranule: state.reservationPhysicalGranule,
    driveError: state.driveError,
    pending: state.pending === null
      ? null
      : {
          transaction: { ...state.pending.transaction },
          completionCycle: state.pending.completionCycle,
          interruptStatus: state.pending.interruptStatus,
          errorCode: state.pending.errorCode,
          hostReady: state.pending.hostReady,
          hostPayloadLength: state.pending.hostPayload?.length ?? null,
          hostError: state.pending.hostError,
          hostWaitRecorded: state.pending.hostWaitRecorded,
          reservationInvalidatedAtStart:
            state.pending.reservationInvalidatedAtStart,
        },
    lastStarted:
      state.lastStarted === null ? null : { ...state.lastStarted },
    lastCompletion:
      state.lastCompletion === null ? null : { ...state.lastCompletion },
    lastRejection:
      state.lastRejection === null ? null : { ...state.lastRejection },
    counters: { ...state.counters },
    piInterruptLevel: diDmaPiInterruptLevel(state),
  };
}
