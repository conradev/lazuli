// SPDX-License-Identifier: GPL-3.0-only

// Pure, deterministic reference for the GameCube AX main-bus commands used by
// F-Zero GX. The command and arithmetic semantics follow Dolphin's AX.cpp.
//
// This deliberately models one bounded 5 ms transaction. It reads only the
// selected MRAM ranges, never clones or mutates MRAM, and returns two ordered
// output writes only after every command and range has been validated. The
// caller persists only compressorPosition between transactions.

export const AX_MAIN_BUS_REFERENCE_SCHEMA =
  "lazuli-ax-gc-main-bus-reference-v1";

export const AX_MAIN_BUS_COMMAND = Object.freeze({
  PROCESS: 0x03,
  SET_LR: 0x07,
  OUTPUT: 0x0e,
  SET_OPPOSITE_LR: 0x11,
  COMPRESSOR: 0x12,
});

export const AX_MAIN_BUS_LIMITS = Object.freeze({
  frames: 160,
  samplesPerMillisecond: 32,
  milliseconds: 5,
  channels: 2,
  maximumCommands: 64,
  maximumMramBytes: 64 * 1024 * 1024,
  attackEntryCount: 11,
  compressorEntryBytes: 160 * 2,
  surroundOutputBytes: 160 * 4,
  mainOutputBytes: 160 * 2 * 2,
});

export const AX_MAIN_BUS_NON_GOALS = Object.freeze([
  "DSP mailbox and AX command-list parsing",
  "voice, AUX, depop, and effect-buffer processing",
  "CMD_SETUP accumulator initialization",
  "AI DMA and host audio output",
]);

const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;
const FNV1A_OFFSET = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

class AxMainBusRejection extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = "AxMainBusRejection";
    this.reason = reason;
    this.details = details;
  }
}

function reject(reason, details = {}) {
  throw new AxMainBusRejection(reason, details);
}

function requireBytes(value, name) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
}

function requireU16(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > U16_MAX) {
    throw new RangeError(`${name} must be an unsigned 16-bit integer`);
  }
  return value;
}

function commandU16(value, name, commandIndex, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > U16_MAX) {
    reject("invalid-command-argument", {
      commandIndex,
      code,
      argument: name,
      value,
    });
  }
  return value;
}

function commandU32(value, name, commandIndex, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) {
    reject("invalid-command-argument", {
      commandIndex,
      code,
      argument: name,
      value,
    });
  }
  return value >>> 0;
}

function cloneInitialBuffer(value, name) {
  if (!(value instanceof Int32Array)) {
    throw new TypeError(`initialMainBus.${name} must be an Int32Array`);
  }
  if (value.length !== AX_MAIN_BUS_LIMITS.frames) {
    throw new RangeError(
      `initialMainBus.${name} must contain exactly `
      + `${AX_MAIN_BUS_LIMITS.frames} samples`,
    );
  }
  return new Int32Array(value);
}

function processOutputBuffer(value, name, forbiddenBuffers, commandIndex) {
  const exactByteLength = AX_MAIN_BUS_LIMITS.frames * Int32Array.BYTES_PER_ELEMENT;
  if (
    !(value instanceof Int32Array)
    || !(value.buffer instanceof ArrayBuffer)
    || value.length !== AX_MAIN_BUS_LIMITS.frames
    || value.byteOffset !== 0
    || value.byteLength !== exactByteLength
    || value.buffer.byteLength !== exactByteLength
  ) {
    reject("invalid-process-result", {
      commandIndex,
      code: AX_MAIN_BUS_COMMAND.PROCESS,
      buffer: name,
      requirement: "fresh-exact-int32x160",
    });
  }
  if (forbiddenBuffers.has(value.buffer)) {
    reject("invalid-process-result", {
      commandIndex,
      code: AX_MAIN_BUS_COMMAND.PROCESS,
      buffer: name,
      requirement: "fresh-nonaliased-buffer",
    });
  }
  return value;
}

function initialBuffers(initialMainBus) {
  if (initialMainBus === undefined || initialMainBus === null) {
    return {
      contract: "zero",
      left: new Int32Array(AX_MAIN_BUS_LIMITS.frames),
      right: new Int32Array(AX_MAIN_BUS_LIMITS.frames),
      surround: new Int32Array(AX_MAIN_BUS_LIMITS.frames),
    };
  }
  if (typeof initialMainBus !== "object") {
    throw new TypeError("initialMainBus must be an object");
  }
  return {
    contract: "provided",
    left: cloneInitialBuffer(initialMainBus.left, "left"),
    right: cloneInitialBuffer(initialMainBus.right, "right"),
    surround: cloneInitialBuffer(initialMainBus.surround, "surround"),
  };
}

function physicalMramRange({
  mram,
  address,
  byteLength,
  commandIndex,
  code,
  role,
}) {
  const logicalAddress = address >>> 0;
  // Dolphin's MemoryManager masks both high address bits before selecting
  // MEM1, so physical, 0x4..., cached 0x8..., and uncached 0xC... aliases all
  // resolve to the same bounded physical range.
  const physicalAddress = (logicalAddress & 0x3fff_ffff) >>> 0;
  if (
    !Number.isSafeInteger(byteLength)
    || byteLength < 0
    || physicalAddress >= mram.length
    || physicalAddress > mram.length - byteLength
  ) {
    reject("mram-range-out-of-bounds", {
      commandIndex,
      code,
      role,
      address: logicalAddress,
      byteLength,
      mramLength: mram.length,
    });
  }
  return physicalAddress;
}

function readBigEndianU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readBigEndianS32(bytes, offset) {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  );
}

function writeBigEndianS16(bytes, offset, value) {
  const word = value & U16_MAX;
  bytes[offset] = word >>> 8;
  bytes[offset + 1] = word & 0xff;
}

function writeBigEndianS32(bytes, offset, value) {
  const word = value >>> 0;
  bytes[offset] = word >>> 24;
  bytes[offset + 1] = (word >>> 16) & 0xff;
  bytes[offset + 2] = (word >>> 8) & 0xff;
  bytes[offset + 3] = word & 0xff;
}

function clampSigned16(value) {
  return Math.max(-0x8000, Math.min(0x7fff, value));
}

function multiplyQ15Signed32(sample, coefficient) {
  // |s32 * u16| stays below 2^47, so Number retains the exact integer.
  // Division by 2^15 plus floor is the exact signed arithmetic shift and
  // avoids allocating 320 BigInts on every five-millisecond compressor frame.
  return Math.floor((sample * coefficient) / 0x8000) | 0;
}

function magnitudeExceedsThreshold(sample, threshold) {
  // Treat INT32_MIN as magnitude 2^31 rather than relying on signed negation.
  return sample === -0x8000_0000 || Math.abs(sample) > threshold;
}

function fnv1a32Parts(parts) {
  let hash = FNV1A_OFFSET;
  for (const bytes of parts) {
    for (const byte of bytes) {
      hash = Math.imul(hash ^ byte, FNV1A_PRIME) >>> 0;
    }
  }
  return hash >>> 0;
}

function hex32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands)) {
    throw new TypeError("commands must be an array");
  }
  if (
    commands.length === 0
    || commands.length > AX_MAIN_BUS_LIMITS.maximumCommands
  ) {
    reject("invalid-command-count", {
      count: commands.length,
      maximum: AX_MAIN_BUS_LIMITS.maximumCommands,
    });
  }

  let outputCount = 0;
  let processCount = 0;
  const normalized = commands.map((command, commandIndex) => {
    if (command === null || typeof command !== "object") {
      reject("invalid-command", { commandIndex });
    }
    const code = commandU16(
      command.code,
      "code",
      commandIndex,
      null,
    );
    switch (code) {
      case AX_MAIN_BUS_COMMAND.PROCESS:
        processCount += 1;
        if (processCount > 1) {
          reject("multiple-process-commands", {
            commandIndex,
            code,
          });
        }
        return Object.freeze({ code });

      case AX_MAIN_BUS_COMMAND.SET_LR:
      case AX_MAIN_BUS_COMMAND.SET_OPPOSITE_LR:
        return Object.freeze({
          code,
          address: commandU32(
            command.address,
            "address",
            commandIndex,
            code,
          ),
        });

      case AX_MAIN_BUS_COMMAND.COMPRESSOR:
        return Object.freeze({
          code,
          threshold: commandU16(
            command.threshold,
            "threshold",
            commandIndex,
            code,
          ),
          releaseFrames: commandU16(
            command.releaseFrames,
            "releaseFrames",
            commandIndex,
            code,
          ),
          tableAddress: commandU32(
            command.tableAddress,
            "tableAddress",
            commandIndex,
            code,
          ),
        });

      case AX_MAIN_BUS_COMMAND.OUTPUT:
        outputCount += 1;
        if (commandIndex !== commands.length - 1) {
          reject("output-not-final", { commandIndex, code });
        }
        return Object.freeze({
          code,
          lrAddress: commandU32(
            command.lrAddress,
            "lrAddress",
            commandIndex,
            code,
          ),
          surroundAddress: commandU32(
            command.surroundAddress,
            "surroundAddress",
            commandIndex,
            code,
          ),
        });

      default:
        reject("unsupported-command", { commandIndex, code });
    }
  });

  if (outputCount === 0) {
    reject("missing-output");
  }
  if (outputCount !== 1) {
    reject("multiple-output-commands", { count: outputCount });
  }
  return Object.freeze(normalized);
}

function runProcessCallback({
  processMainBus,
  commandIndex,
  buffers,
  initialMainBus,
  mram,
}) {
  if (typeof processMainBus !== "function") {
    reject("missing-process-callback", {
      commandIndex,
      code: AX_MAIN_BUS_COMMAND.PROCESS,
    });
  }

  const leftSnapshot = new Int32Array(buffers.left);
  const rightSnapshot = new Int32Array(buffers.right);
  let result;
  try {
    result = processMainBus(Object.freeze({
      left: leftSnapshot,
      right: rightSnapshot,
    }));
  } catch (error) {
    reject("process-callback-threw", {
      commandIndex,
      code: AX_MAIN_BUS_COMMAND.PROCESS,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
  if (result === null || typeof result !== "object") {
    reject("invalid-process-result", {
      commandIndex,
      code: AX_MAIN_BUS_COMMAND.PROCESS,
      requirement: "left-and-right",
    });
  }

  const forbiddenBuffers = new Set([
    mram.buffer,
    buffers.left.buffer,
    buffers.right.buffer,
    buffers.surround.buffer,
    leftSnapshot.buffer,
    rightSnapshot.buffer,
  ]);
  if (initialMainBus !== null && typeof initialMainBus === "object") {
    for (const name of ["left", "right", "surround"]) {
      const buffer = initialMainBus[name]?.buffer;
      if (buffer !== undefined) forbiddenBuffers.add(buffer);
    }
  }
  const resultLeft = processOutputBuffer(
    result.left,
    "left",
    forbiddenBuffers,
    commandIndex,
  );
  forbiddenBuffers.add(resultLeft.buffer);
  const resultRight = processOutputBuffer(
    result.right,
    "right",
    forbiddenBuffers,
    commandIndex,
  );

  // Clone validated callback output once more so later callback-owned
  // mutations cannot change this transaction.
  buffers.left = new Int32Array(resultLeft);
  buffers.right = new Int32Array(resultRight);
}

function validateStaticRanges(mram, commands) {
  for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
    const command = commands[commandIndex];
    switch (command.code) {
      case AX_MAIN_BUS_COMMAND.SET_LR:
      case AX_MAIN_BUS_COMMAND.SET_OPPOSITE_LR:
        physicalMramRange({
          mram,
          address: command.address,
          byteLength: AX_MAIN_BUS_LIMITS.frames * 4,
          commandIndex,
          code: command.code,
          role: "main-input-s32",
        });
        break;

      case AX_MAIN_BUS_COMMAND.OUTPUT:
        physicalMramRange({
          mram,
          address: command.surroundAddress,
          byteLength: AX_MAIN_BUS_LIMITS.surroundOutputBytes,
          commandIndex,
          code: command.code,
          role: "surround-output-s32",
        });
        physicalMramRange({
          mram,
          address: command.lrAddress,
          byteLength: AX_MAIN_BUS_LIMITS.mainOutputBytes,
          commandIndex,
          code: command.code,
          role: "main-output-rl-s16",
        });
        break;
    }
  }
}

function loadMainInput(mram, command, commandIndex, buffers, opposite) {
  const physicalAddress = physicalMramRange({
    mram,
    address: command.address,
    byteLength: AX_MAIN_BUS_LIMITS.frames * 4,
    commandIndex,
    code: command.code,
    role: "main-input-s32",
  });
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    const sample = readBigEndianS32(mram, physicalAddress + frame * 4);
    buffers.left[frame] = opposite ? (-sample) | 0 : sample;
    buffers.right[frame] = sample;
    buffers.surround[frame] = 0;
  }
}

function runCompressor({
  mram,
  command,
  commandIndex,
  buffers,
  compressorPosition,
}) {
  let triggered = false;
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    if (
      magnitudeExceedsThreshold(buffers.left[frame], command.threshold)
      || magnitudeExceedsThreshold(buffers.right[frame], command.threshold)
    ) {
      triggered = true;
      break;
    }
  }

  const positionBefore = compressorPosition;
  let positionAfter = compressorPosition;
  let entryIndex = null;
  let phase = "bypass";
  if (triggered) {
    entryIndex = compressorPosition;
    positionAfter = command.releaseFrames;
    phase = "attack";
  } else if (compressorPosition !== 0) {
    positionAfter = compressorPosition - 1;
    entryIndex =
      AX_MAIN_BUS_LIMITS.attackEntryCount + positionAfter;
    phase = "release";
  }

  if (entryIndex === null) {
    return Object.freeze({
      phase,
      triggered,
      threshold: command.threshold,
      releaseFrames: command.releaseFrames,
      positionBefore,
      positionAfter,
      entryIndex,
      tableAddress: null,
    });
  }

  const tableByteOffset =
    entryIndex * AX_MAIN_BUS_LIMITS.compressorEntryBytes;
  const selectedTableAddress =
    (command.tableAddress + tableByteOffset) >>> 0;
  const physicalAddress = physicalMramRange({
    mram,
    address: selectedTableAddress,
    byteLength: AX_MAIN_BUS_LIMITS.compressorEntryBytes,
    commandIndex,
    code: command.code,
    role: `${phase}-compressor-table`,
  });
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    const coefficient = readBigEndianU16(
      mram,
      physicalAddress + frame * 2,
    );
    buffers.left[frame] = multiplyQ15Signed32(
      buffers.left[frame],
      coefficient,
    );
    buffers.right[frame] = multiplyQ15Signed32(
      buffers.right[frame],
      coefficient,
    );
  }

  return Object.freeze({
    phase,
    triggered,
    threshold: command.threshold,
    releaseFrames: command.releaseFrames,
    positionBefore,
    positionAfter,
    entryIndex,
    tableAddress: selectedTableAddress,
  });
}

function serializeOutput(mram, command, commandIndex, buffers) {
  const surroundPhysicalAddress = physicalMramRange({
    mram,
    address: command.surroundAddress,
    byteLength: AX_MAIN_BUS_LIMITS.surroundOutputBytes,
    commandIndex,
    code: command.code,
    role: "surround-output-s32",
  });
  const lrPhysicalAddress = physicalMramRange({
    mram,
    address: command.lrAddress,
    byteLength: AX_MAIN_BUS_LIMITS.mainOutputBytes,
    commandIndex,
    code: command.code,
    role: "main-output-rl-s16",
  });

  const surroundBytes = new Uint8Array(
    AX_MAIN_BUS_LIMITS.surroundOutputBytes,
  );
  const lrBytes = new Uint8Array(AX_MAIN_BUS_LIMITS.mainOutputBytes);
  const lrSamples = new Int16Array(
    AX_MAIN_BUS_LIMITS.frames * AX_MAIN_BUS_LIMITS.channels,
  );
  let clippedSampleValues = 0;
  let peakAbsoluteSample = 0;
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    writeBigEndianS32(
      surroundBytes,
      frame * 4,
      buffers.surround[frame],
    );

    const unclampedRight = buffers.right[frame];
    const unclampedLeft = buffers.left[frame];
    const right = clampSigned16(unclampedRight);
    const left = clampSigned16(unclampedLeft);
    if (right !== unclampedRight) clippedSampleValues += 1;
    if (left !== unclampedLeft) clippedSampleValues += 1;
    peakAbsoluteSample = Math.max(
      peakAbsoluteSample,
      Math.abs(right),
      Math.abs(left),
    );
    lrSamples[frame * 2] = right;
    lrSamples[frame * 2 + 1] = left;
    writeBigEndianS16(lrBytes, frame * 4, right);
    writeBigEndianS16(lrBytes, frame * 4 + 2, left);
  }

  const writes = Object.freeze([
    Object.freeze({
      sequence: 0,
      kind: "surround-s32-be",
      logicalAddress: command.surroundAddress,
      physicalAddress: surroundPhysicalAddress,
      byteLength: surroundBytes.length,
      data: surroundBytes,
    }),
    Object.freeze({
      sequence: 1,
      kind: "main-rl-s16-be",
      logicalAddress: command.lrAddress,
      physicalAddress: lrPhysicalAddress,
      byteLength: lrBytes.length,
      data: lrBytes,
    }),
  ]);
  return {
    writes,
    output: Object.freeze({
      frames: AX_MAIN_BUS_LIMITS.frames,
      sampleRateHz: 32_000,
      surround: Object.freeze({
        format: "s32-be",
        samples: new Int32Array(buffers.surround),
        bytes: surroundBytes,
      }),
      main: Object.freeze({
        format: "s16-be",
        channels: AX_MAIN_BUS_LIMITS.channels,
        order: "R,L",
        samples: lrSamples,
        bytes: lrBytes,
      }),
    }),
    clippedSampleValues,
    peakAbsoluteSample,
  };
}

function rejectionResult(error) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      reason: error.reason,
      ...error.details,
    }),
  });
}

export function executeAxMainBusReference({
  mram,
  commands,
  compressorPosition = 0,
  initialMainBus = null,
  processMainBus = null,
}) {
  requireBytes(mram, "mram");
  if (
    mram.length === 0
    || mram.length > AX_MAIN_BUS_LIMITS.maximumMramBytes
  ) {
    throw new RangeError(
      "mram length must be between 1 and "
      + `${AX_MAIN_BUS_LIMITS.maximumMramBytes} bytes`,
    );
  }
  const normalizedPosition = requireU16(
    compressorPosition,
    "compressorPosition",
  );
  const buffers = initialBuffers(initialMainBus);

  try {
    const normalizedCommands = normalizeCommands(commands);
    validateStaticRanges(mram, normalizedCommands);

    let position = normalizedPosition;
    let setLrCommands = 0;
    let setOppositeLrCommands = 0;
    let processCommands = 0;
    let outputCommand = null;
    const compressorSelections = [];

    for (
      let commandIndex = 0;
      commandIndex < normalizedCommands.length;
      commandIndex += 1
    ) {
      const command = normalizedCommands[commandIndex];
      switch (command.code) {
        case AX_MAIN_BUS_COMMAND.PROCESS:
          runProcessCallback({
            processMainBus,
            commandIndex,
            buffers,
            initialMainBus,
            mram,
          });
          processCommands += 1;
          break;

        case AX_MAIN_BUS_COMMAND.SET_LR:
          loadMainInput(
            mram,
            command,
            commandIndex,
            buffers,
            false,
          );
          setLrCommands += 1;
          break;

        case AX_MAIN_BUS_COMMAND.SET_OPPOSITE_LR:
          loadMainInput(
            mram,
            command,
            commandIndex,
            buffers,
            true,
          );
          setOppositeLrCommands += 1;
          break;

        case AX_MAIN_BUS_COMMAND.COMPRESSOR: {
          const selection = runCompressor({
            mram,
            command,
            commandIndex,
            buffers,
            compressorPosition: position,
          });
          position = selection.positionAfter;
          compressorSelections.push(selection);
          break;
        }

        case AX_MAIN_BUS_COMMAND.OUTPUT:
          outputCommand = { command, commandIndex };
          break;
      }
    }

    const serialized = serializeOutput(
      mram,
      outputCommand.command,
      outputCommand.commandIndex,
      buffers,
    );
    const surroundHash = fnv1a32Parts([
      serialized.output.surround.bytes,
    ]);
    const mainHash = fnv1a32Parts([serialized.output.main.bytes]);
    const transactionHash = fnv1a32Parts([
      serialized.output.surround.bytes,
      serialized.output.main.bytes,
    ]);
    const compressorAttackFrames = compressorSelections.filter(
      selection => selection.phase === "attack",
    ).length;
    const compressorReleaseFrames = compressorSelections.filter(
      selection => selection.phase === "release",
    ).length;
    const compressorBypassFrames = compressorSelections.filter(
      selection => selection.phase === "bypass",
    ).length;

    return Object.freeze({
      ok: true,
      compressorPosition: position,
      writes: serialized.writes,
      output: serialized.output,
      telemetry: Object.freeze({
        schema: AX_MAIN_BUS_REFERENCE_SCHEMA,
        initialMainBus: buffers.contract,
        commands: normalizedCommands.length,
        processCommands,
        setLrCommands,
        setOppositeLrCommands,
        compressorCommands: compressorSelections.length,
        compressorAttackFrames,
        compressorReleaseFrames,
        compressorBypassFrames,
        compressorPositionBefore: normalizedPosition,
        compressorPositionAfter: position,
        compressorSelections: Object.freeze(compressorSelections),
        frames: AX_MAIN_BUS_LIMITS.frames,
        milliseconds: AX_MAIN_BUS_LIMITS.milliseconds,
        outputOrder: "surround-s32-be;R,L-s16-be",
        outputWriteBytes:
          AX_MAIN_BUS_LIMITS.surroundOutputBytes
          + AX_MAIN_BUS_LIMITS.mainOutputBytes,
        clippedSampleValues: serialized.clippedSampleValues,
        peakAbsoluteSample: serialized.peakAbsoluteSample,
        surroundHash: hex32(surroundHash),
        mainHash: hex32(mainHash),
        transactionHash: hex32(transactionHash),
      }),
    });
  } catch (error) {
    if (error instanceof AxMainBusRejection) {
      return rejectionResult(error);
    }
    throw error;
  }
}
