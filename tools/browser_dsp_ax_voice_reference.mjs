// SPDX-License-Identifier: GPL-3.0-only

// Pure, deterministic reference for the AX GameCube voice path needed to mix a
// linked parameter-block list into the nine 5 ms MAIN/AUXA/AUXB L/R/surround
// signed-32 accumulator planes.
//
// The layout and arithmetic follow Dolphin's AXStructs.h, AXVoice.h,
// DSPAccelerator.{h,cpp}, and AX.cpp. This module intentionally does not model
// the DSP mailbox/command-list protocol, effect-buffer processing, ITD/filters,
// PCM8, DROM polyphase coefficients, AI DMA, or a host audio sink.
// Polyphase SRC requests use Dolphin's coefficient-free linear fallback. All
// nine accumulators default to zero and may be supplied as exact, independent
// 160-sample Int32Array snapshots. The reference clones only those bounded
// accumulator inputs, individual parameter blocks, and fixed 128-byte update
// tables; it never clones all of MRAM.

export const AX_REFERENCE_SCHEMA = "lazuli-ax-gc-voice-reference-v6";
export const AX_OLD_UCODE_HASH = 0x4e8a8b21;
export const AX_FZERO_UCODE_HASH = 0x07f88145;
export const AX_INITIAL_MAIN_BUFFER_CONTRACT =
  "optional-int32x160-zero-default";
export const AX_INITIAL_ACCUMULATOR_CONTRACT =
  "optional-complete-nine-plane-int32x160-zero-default";

export const AX_SAMPLE_FORMAT = Object.freeze({
  DSP_ADPCM: 0x0000,
  PCM16: 0x000a,
  PCM16_GAIN_SCALE_2048: 0x000a,
  PCM16_GAIN_SCALE_1: 0x001a,
  PCM16_GAIN_SCALE_65536: 0x002a,
});

export const AX_SRC_TYPE = Object.freeze({
  POLYPHASE: 0,
  LINEAR: 1,
  NEAREST: 2,
});

// Raw newer-GameCube AXPB::mixer_control bits. 0x4000 selects the AUXB
// surround input in DPL2 mode on the DSP. Like Dolphin HLE, this reference
// accepts it but it has no observable effect while ITD is unsupported.
export const AX_MIXER_CONTROL = Object.freeze({
  MAIN_LEFT: 0x0001,
  MAIN_RIGHT: 0x0002,
  MAIN_SURROUND: 0x0004,
  MAIN_RAMP: 0x0008,
  AUXA_LEFT: 0x0010,
  AUXA_RIGHT: 0x0020,
  AUXA_LEFT_RIGHT_RAMP: 0x0040,
  AUXA_SURROUND: 0x0080,
  AUXA_SURROUND_RAMP: 0x0100,
  AUXB_LEFT: 0x0200,
  AUXB_RIGHT: 0x0400,
  AUXB_LEFT_RIGHT_RAMP: 0x0800,
  AUXB_SURROUND: 0x1000,
  AUXB_SURROUND_RAMP: 0x2000,
  DPL2_AUXB_SURROUND_INPUT: 0x4000,
});

export const AX_REFERENCE_LIMITS = Object.freeze({
  frames: 160,
  samplesPerMillisecond: 32,
  milliseconds: 5,
  channels: 2,
  accumulatorPlanes: 9,
  sampleRateHz: 32_000,
  maximumParameterBlocks: 64,
  hardMaximumParameterBlocks: 1_024,
  logicalParameterBlockWords: 122,
  maximumParameterBlockUpdates: 32,
  parameterBlockUpdateBytes: 128,
});

export const AX_REFERENCE_NON_GOALS = Object.freeze([
  "DSP mailbox and AX command-list parsing",
  "effect-buffer processing",
  "initial-time-delay and low-pass filtering",
  "PCM8 and DROM-coefficient polyphase resampling",
  "AI DMA and host audio output",
]);

// Logical u16 word offsets in Dolphin's semantic AXPB. Melee's 0x4e8a8b21
// and F-Zero's 0x07f88145 layouts are three distinct physical ABIs. Melee
// omits words 93..96 (PBLowPassFilter), moves LOOP_COUNTER four words earlier,
// and transfers its complete 0xc0-byte record. F-Zero has a ten-word
// intermediate filter area at physical words 93..102, LOOP_COUNTER at 103,
// and a 0xec-byte CPU record whose final 0x1c bytes are outside its exact
// 0xd0-byte DSP DMA. The full newer layout uses the four-word LPF,
// LOOP_COUNTER at 97, and transfers its complete 0xf4-byte record.
export const AX_PB_WORD = Object.freeze({
  NEXT_HIGH: 0,
  NEXT_LOW: 1,
  THIS_HIGH: 2,
  THIS_LOW: 3,
  SRC_TYPE: 4,
  COEFFICIENT_SELECT: 5,
  MIXER_CONTROL: 6,
  RUNNING: 7,
  IS_STREAM: 8,

  MAIN_LEFT_VOLUME: 9,
  MAIN_LEFT_DELTA: 10,
  MAIN_RIGHT_VOLUME: 11,
  MAIN_RIGHT_DELTA: 12,
  AUXA_LEFT_VOLUME: 13,
  AUXA_LEFT_DELTA: 14,
  AUXA_RIGHT_VOLUME: 15,
  AUXA_RIGHT_DELTA: 16,
  AUXB_LEFT_VOLUME: 17,
  AUXB_LEFT_DELTA: 18,
  AUXB_RIGHT_VOLUME: 19,
  AUXB_RIGHT_DELTA: 20,
  AUXB_SURROUND_VOLUME: 21,
  AUXB_SURROUND_DELTA: 22,
  MAIN_SURROUND_VOLUME: 23,
  MAIN_SURROUND_DELTA: 24,
  AUXA_SURROUND_VOLUME: 25,
  AUXA_SURROUND_DELTA: 26,

  INITIAL_TIME_DELAY_ON: 27,
  UPDATE_COUNT_0: 34,
  UPDATE_COUNT_4: 38,
  UPDATE_DATA_HIGH: 39,
  UPDATE_DATA_LOW: 40,

  DPOP_MAIN_LEFT: 41,
  DPOP_AUXA_LEFT: 42,
  DPOP_AUXB_LEFT: 43,
  DPOP_MAIN_RIGHT: 44,
  DPOP_AUXA_RIGHT: 45,
  DPOP_AUXB_RIGHT: 46,
  DPOP_MAIN_SURROUND: 47,
  DPOP_AUXA_SURROUND: 48,
  DPOP_AUXB_SURROUND: 49,
  VOLUME_ENVELOPE_CURRENT: 50,
  VOLUME_ENVELOPE_DELTA: 51,

  LOOPING: 55,
  SAMPLE_FORMAT: 56,
  LOOP_ADDRESS_HIGH: 57,
  LOOP_ADDRESS_LOW: 58,
  END_ADDRESS_HIGH: 59,
  END_ADDRESS_LOW: 60,
  CURRENT_ADDRESS_HIGH: 61,
  CURRENT_ADDRESS_LOW: 62,

  ADPCM_COEFFICIENT_0: 63,
  ADPCM_COEFFICIENT_15: 78,
  ADPCM_GAIN: 79,
  ADPCM_PREDICTOR_SCALE: 80,
  ADPCM_YN1: 81,
  ADPCM_YN2: 82,

  SRC_RATIO_HIGH: 83,
  SRC_RATIO_LOW: 84,
  SRC_CURRENT_FRACTION: 85,
  SRC_LAST_SAMPLE_0: 86,
  SRC_LAST_SAMPLE_3: 89,

  ADPCM_LOOP_PREDICTOR_SCALE: 90,
  ADPCM_LOOP_YN1: 91,
  ADPCM_LOOP_YN2: 92,
  LOW_PASS_FILTER_ON: 93,
  LOW_PASS_FILTER_END: 96,
  LOOP_COUNTER: 97,
});

const AX_PB_LOGICAL_WORDS =
  AX_REFERENCE_LIMITS.logicalParameterBlockWords;
const AX_PB_OLD_PHYSICAL_WORDS = 0xc0 / 2;
// F-Zero's retail AXRNA 1.02 code links and indexes 64 records at +0xec,
// while ucode 0x07f88145 programs DSBL=0xd0 for both PB DMA directions.
const AX_PB_FZERO_LAYOUT_WORDS = 0xec / 2;
const AX_PB_FZERO_DMA_WORDS = 0xd0 / 2;
const U32_MAX = 0xffff_ffff;
const ACCUMULATOR_BUSES = Object.freeze(["main", "auxA", "auxB"]);
const ACCUMULATOR_CHANNELS = Object.freeze([
  "left",
  "right",
  "surround",
]);

// Dolphin AXPB::mixer stores these word pairs in an order that intentionally
// differs from both the PBDpop structure and the processing order.
const MIX_ROUTES = Object.freeze([
  Object.freeze({
    key: "main.left",
    bus: "main",
    channel: "left",
    enableBit: AX_MIXER_CONTROL.MAIN_LEFT,
    rampBit: AX_MIXER_CONTROL.MAIN_RAMP,
    volumeWord: AX_PB_WORD.MAIN_LEFT_VOLUME,
    deltaWord: AX_PB_WORD.MAIN_LEFT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_MAIN_LEFT,
  }),
  Object.freeze({
    key: "main.right",
    bus: "main",
    channel: "right",
    enableBit: AX_MIXER_CONTROL.MAIN_RIGHT,
    rampBit: AX_MIXER_CONTROL.MAIN_RAMP,
    volumeWord: AX_PB_WORD.MAIN_RIGHT_VOLUME,
    deltaWord: AX_PB_WORD.MAIN_RIGHT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_MAIN_RIGHT,
  }),
  Object.freeze({
    key: "main.surround",
    bus: "main",
    channel: "surround",
    enableBit: AX_MIXER_CONTROL.MAIN_SURROUND,
    rampBit: AX_MIXER_CONTROL.MAIN_RAMP,
    volumeWord: AX_PB_WORD.MAIN_SURROUND_VOLUME,
    deltaWord: AX_PB_WORD.MAIN_SURROUND_DELTA,
    dpopWord: AX_PB_WORD.DPOP_MAIN_SURROUND,
  }),
  Object.freeze({
    key: "auxA.left",
    bus: "auxA",
    channel: "left",
    enableBit: AX_MIXER_CONTROL.AUXA_LEFT,
    rampBit: AX_MIXER_CONTROL.AUXA_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXA_LEFT_VOLUME,
    deltaWord: AX_PB_WORD.AUXA_LEFT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXA_LEFT,
  }),
  Object.freeze({
    key: "auxA.right",
    bus: "auxA",
    channel: "right",
    enableBit: AX_MIXER_CONTROL.AUXA_RIGHT,
    rampBit: AX_MIXER_CONTROL.AUXA_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXA_RIGHT_VOLUME,
    deltaWord: AX_PB_WORD.AUXA_RIGHT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXA_RIGHT,
  }),
  Object.freeze({
    key: "auxA.surround",
    bus: "auxA",
    channel: "surround",
    enableBit: AX_MIXER_CONTROL.AUXA_SURROUND,
    rampBit: AX_MIXER_CONTROL.AUXA_SURROUND_RAMP,
    volumeWord: AX_PB_WORD.AUXA_SURROUND_VOLUME,
    deltaWord: AX_PB_WORD.AUXA_SURROUND_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXA_SURROUND,
  }),
  Object.freeze({
    key: "auxB.left",
    bus: "auxB",
    channel: "left",
    enableBit: AX_MIXER_CONTROL.AUXB_LEFT,
    rampBit: AX_MIXER_CONTROL.AUXB_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXB_LEFT_VOLUME,
    deltaWord: AX_PB_WORD.AUXB_LEFT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXB_LEFT,
  }),
  Object.freeze({
    key: "auxB.right",
    bus: "auxB",
    channel: "right",
    enableBit: AX_MIXER_CONTROL.AUXB_RIGHT,
    rampBit: AX_MIXER_CONTROL.AUXB_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXB_RIGHT_VOLUME,
    deltaWord: AX_PB_WORD.AUXB_RIGHT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXB_RIGHT,
  }),
  Object.freeze({
    key: "auxB.surround",
    bus: "auxB",
    channel: "surround",
    enableBit: AX_MIXER_CONTROL.AUXB_SURROUND,
    rampBit: AX_MIXER_CONTROL.AUXB_SURROUND_RAMP,
    volumeWord: AX_PB_WORD.AUXB_SURROUND_VOLUME,
    deltaWord: AX_PB_WORD.AUXB_SURROUND_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXB_SURROUND,
  }),
]);

class AxReferenceRejection extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = "AxReferenceRejection";
    this.reason = reason;
    this.details = details;
  }
}

function reject(reason, details = {}) {
  throw new AxReferenceRejection(reason, details);
}

function requireBytes(value, name) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array`);
  }
}

function requireAccumulator(value, name) {
  if (value === undefined) return;
  if (!(value instanceof Int32Array)) {
    throw new TypeError(`${name} must be an Int32Array`);
  }
  if (value.length !== AX_REFERENCE_LIMITS.frames) {
    throw new RangeError(
      `${name} must contain exactly ${AX_REFERENCE_LIMITS.frames} samples`,
    );
  }
}

function cloneAccumulator(value) {
  return value === undefined
    ? new Int32Array(AX_REFERENCE_LIMITS.frames)
    : new Int32Array(value);
}

function requireAccumulatorBus(value, name) {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${name} must be an object`);
  }
  for (const channel of ACCUMULATOR_CHANNELS) {
    if (!Object.hasOwn(value, channel)) {
      throw new TypeError(`${name}.${channel} is required`);
    }
    requireAccumulator(value[channel], `${name}.${channel}`);
  }
}

function requireInitialAccumulators(
  initialAccumulators,
  initialMainLeft,
  initialMainRight,
) {
  if (initialAccumulators === undefined) {
    requireAccumulator(initialMainLeft, "initialMainLeft");
    requireAccumulator(initialMainRight, "initialMainRight");
    return;
  }
  if (initialMainLeft !== undefined || initialMainRight !== undefined) {
    throw new TypeError(
      "initialAccumulators cannot be combined with legacy main accumulators",
    );
  }
  if (initialAccumulators === null || typeof initialAccumulators !== "object") {
    throw new TypeError("initialAccumulators must be an object");
  }
  if (!Object.hasOwn(initialAccumulators, "frames")) {
    throw new TypeError("initialAccumulators.frames is required");
  }
  if (initialAccumulators.frames !== AX_REFERENCE_LIMITS.frames) {
    throw new RangeError(
      `initialAccumulators.frames must equal ${AX_REFERENCE_LIMITS.frames}`,
    );
  }

  const planes = [];
  for (const bus of ACCUMULATOR_BUSES) {
    if (!Object.hasOwn(initialAccumulators, bus)) {
      throw new TypeError(`initialAccumulators.${bus} is required`);
    }
    const value = initialAccumulators[bus];
    requireAccumulatorBus(value, `initialAccumulators.${bus}`);
    for (const channel of ACCUMULATOR_CHANNELS) {
      const plane = value[channel];
      for (const previous of planes) {
        if (plane.buffer === previous) {
          throw new TypeError(
            "initialAccumulators planes must not alias",
          );
        }
      }
      planes.push(plane.buffer);
    }
  }
}

function cloneAccumulators({
  initialAccumulators,
  initialMainLeft,
  initialMainRight,
}) {
  const nested = initialAccumulators !== undefined;
  const result = { frames: AX_REFERENCE_LIMITS.frames };
  for (const bus of ACCUMULATOR_BUSES) {
    const channels = {};
    for (const channel of ACCUMULATOR_CHANNELS) {
      let source;
      if (nested) {
        source = initialAccumulators[bus][channel];
      } else if (bus === "main" && channel === "left") {
        source = initialMainLeft;
      } else if (bus === "main" && channel === "right") {
        source = initialMainRight;
      }
      channels[channel] = cloneAccumulator(source);
    }
    result[bus] = Object.freeze(channels);
  }
  return Object.freeze(result);
}

function requireU32(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return value >>> 0;
}

function toSigned16(value) {
  const word = value & 0xffff;
  return word < 0x8000 ? word : word - 0x1_0000;
}

function toSigned32(value) {
  return value | 0;
}

function clampSigned16(value) {
  return Math.max(-0x8000, Math.min(0x7fff, value));
}

function clampAdpcm(value) {
  return Math.max(-0x7fff, Math.min(0x7fff, value));
}

function shiftSigned32(value, bits) {
  return toSigned32(value) >> bits;
}

function joinWords(high, low) {
  return ((high * 0x1_0000) + low) >>> 0;
}

function splitHigh(value) {
  return (value >>> 16) & 0xffff;
}

function splitLow(value) {
  return value & 0xffff;
}

function pbUsesOldLayout(ucodeHash) {
  return (ucodeHash >>> 0) === AX_OLD_UCODE_HASH;
}

function pbLayoutWords(ucodeHash) {
  const hash = ucodeHash >>> 0;
  if (hash === AX_OLD_UCODE_HASH) return AX_PB_OLD_PHYSICAL_WORDS;
  if (hash === AX_FZERO_UCODE_HASH) return AX_PB_FZERO_LAYOUT_WORDS;
  return AX_PB_LOGICAL_WORDS;
}

function pbDmaWords(ucodeHash) {
  return (ucodeHash >>> 0) === AX_FZERO_UCODE_HASH
    ? AX_PB_FZERO_DMA_WORDS
    : pbLayoutWords(ucodeHash);
}

function pbPhysicalWord(logicalWord, ucodeHash) {
  const hash = ucodeHash >>> 0;
  if (hash === AX_OLD_UCODE_HASH) {
    if (
      logicalWord >= AX_PB_WORD.LOW_PASS_FILTER_ON
      && logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_END
    ) {
      return null;
    }
    if (logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_END) {
      return logicalWord;
    }
    const physicalWord = logicalWord - 4;
    return physicalWord < AX_PB_OLD_PHYSICAL_WORDS
      ? physicalWord
      : null;
  }
  if (hash === AX_FZERO_UCODE_HASH) {
    if (logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_ON) {
      return logicalWord;
    }
    if (logicalWord === AX_PB_WORD.LOOP_COUNTER) return 103;
    return null;
  }
  return logicalWord;
}

function pbLogicalWord(physicalWord, ucodeHash) {
  const hash = ucodeHash >>> 0;
  if (hash === AX_OLD_UCODE_HASH) {
    return physicalWord < AX_PB_WORD.LOW_PASS_FILTER_ON
      ? physicalWord
      : physicalWord + 4;
  }
  if (hash === AX_FZERO_UCODE_HASH) {
    if (physicalWord <= AX_PB_WORD.LOW_PASS_FILTER_ON) {
      return physicalWord;
    }
    return physicalWord === 103 ? AX_PB_WORD.LOOP_COUNTER : null;
  }
  return physicalWord;
}

export function axParameterBlockByteLength(ucodeHash) {
  requireU32(ucodeHash, "ucodeHash");
  return pbLayoutWords(ucodeHash) * 2;
}

export function axParameterBlockDmaByteLength(ucodeHash) {
  requireU32(ucodeHash, "ucodeHash");
  return pbDmaWords(ucodeHash) * 2;
}

function physicalMramAddress(
  address,
  length,
  mramLength,
  rejectionReason = "parameter-block-out-of-bounds",
  rejectionDetails = {},
) {
  const logical = address >>> 0;
  // Dolphin masks both high address bits before selecting MEM1, so physical,
  // 0x4..., cached 0x8..., and uncached 0xC... pointers alias exactly.
  const physical = (logical & 0x3fff_ffff) >>> 0;
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || physical >= mramLength
    || physical > mramLength - length
  ) {
    reject(rejectionReason, {
      ...rejectionDetails,
      address: logical,
      length,
      mramLength,
    });
  }
  return physical;
}

function readBigEndianU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function writeBigEndianU16(bytes, offset, value) {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function decodeParameterBlock(
  mram,
  logicalAddress,
  physicalAddress,
  ucodeHash,
  parameterBlockDmaBytes,
) {
  const physicalData = new Uint8Array(
    mram.subarray(
      physicalAddress,
      physicalAddress + parameterBlockDmaBytes,
    ),
  );
  const words = new Uint16Array(AX_PB_LOGICAL_WORDS);
  for (let logicalWord = 0; logicalWord < words.length; logicalWord += 1) {
    const physicalWord = pbPhysicalWord(logicalWord, ucodeHash);
    if (physicalWord === null) continue;
    words[logicalWord] = readBigEndianU16(
      physicalData,
      physicalWord * 2,
    );
  }
  return {
    logicalAddress: logicalAddress >>> 0,
    physicalAddress,
    physicalData,
    words,
  };
}

function readStagedMramBytes(
  mram,
  physicalAddress,
  byteLength,
  stagedWrites,
) {
  const bytes = new Uint8Array(
    mram.subarray(physicalAddress, physicalAddress + byteLength),
  );
  const readEnd = physicalAddress + byteLength;
  for (const write of stagedWrites) {
    const writeEnd = write.physicalAddress + write.byteLength;
    const overlapStart = Math.max(physicalAddress, write.physicalAddress);
    const overlapEnd = Math.min(readEnd, writeEnd);
    if (overlapStart >= overlapEnd) continue;
    bytes.set(
      write.data.subarray(
        overlapStart - write.physicalAddress,
        overlapEnd - write.physicalAddress,
      ),
      overlapStart - physicalAddress,
    );
  }
  return bytes;
}

function loadParameterBlockUpdates({
  block,
  context,
  mram,
  stagedWrites,
}) {
  const { words } = block;
  const logicalAddress = blockAddress(
    words,
    AX_PB_WORD.UPDATE_DATA_HIGH,
    AX_PB_WORD.UPDATE_DATA_LOW,
  );
  const byteLength = AX_REFERENCE_LIMITS.parameterBlockUpdateBytes;
  const physicalAddress = physicalMramAddress(
    logicalAddress,
    byteLength,
    mram.length,
    "parameter-block-update-table-out-of-bounds",
    { parameterBlock: block.logicalAddress },
  );
  const bytes = readStagedMramBytes(
    mram,
    physicalAddress,
    byteLength,
    stagedWrites,
  );
  const updates = new Uint16Array(
    AX_REFERENCE_LIMITS.maximumParameterBlockUpdates * 2,
  );
  for (let index = 0; index < updates.length; index += 1) {
    updates[index] = readBigEndianU16(bytes, index * 2);
  }
  context.parameterBlockUpdateTables += 1;
  context.parameterBlockUpdateReadBytes += byteLength;
  return updates;
}

function applyParameterBlockUpdates(
  block,
  millisecond,
  updates,
  context,
) {
  const { words } = block;
  let startIndex = 0;
  for (let index = 0; index < millisecond; index += 1) {
    startIndex += words[AX_PB_WORD.UPDATE_COUNT_0 + index];
  }

  const count = words[AX_PB_WORD.UPDATE_COUNT_0 + millisecond];
  const maximumUpdates = AX_REFERENCE_LIMITS.maximumParameterBlockUpdates;
  if (
    startIndex >= maximumUpdates
    || count > maximumUpdates - startIndex
  ) {
    if (count !== 0) context.parameterBlockUpdateSlicesSkipped += 1;
    return;
  }
  if (count === 0) return;

  const endIndex = startIndex + count;
  for (let index = startIndex; index < endIndex; index += 1) {
    const updateOffset = updates[index * 2];
    const updateValue = updates[index * 2 + 1];
    context.parameterBlockUpdateEntriesVisited += 1;
    if (updateOffset >= context.parameterBlockDmaWords) {
      context.parameterBlockUpdateOffsetsIgnored += 1;
      continue;
    }
    writeBigEndianU16(block.physicalData, updateOffset * 2, updateValue);
    const logicalWord = pbLogicalWord(updateOffset, context.ucodeHash);
    if (logicalWord !== null) words[logicalWord] = updateValue;
    context.parameterBlockUpdateWordWrites += 1;
  }
}

function parameterBlockWrite(block, ucodeHash) {
  const data = new Uint8Array(block.physicalData);
  for (let logicalWord = 0; logicalWord < block.words.length; logicalWord += 1) {
    const physicalWord = pbPhysicalWord(logicalWord, ucodeHash);
    if (physicalWord === null) continue;
    writeBigEndianU16(
      data,
      physicalWord * 2,
      block.words[logicalWord],
    );
  }
  return Object.freeze({
    logicalAddress: block.logicalAddress,
    physicalAddress: block.physicalAddress,
    byteLength: data.length,
    data,
  });
}

function blockAddress(words, highWord, lowWord) {
  return joinWords(words[highWord], words[lowWord]);
}

function isPcm16Format(format) {
  return format === AX_SAMPLE_FORMAT.PCM16_GAIN_SCALE_2048
    || format === AX_SAMPLE_FORMAT.PCM16_GAIN_SCALE_1
    || format === AX_SAMPLE_FORMAT.PCM16_GAIN_SCALE_65536;
}

function validateParameterBlock(block, oldLayout) {
  const { words } = block;

  const mixerControl = words[AX_PB_WORD.MIXER_CONTROL];
  // The old ucode uses bits 0..4 for its compact non-DPL2/DPL2 routing
  // scheme. Newer GC ucodes use bits 0..14; bit 14 is the known DPL2 AUXB
  // input selector and bit 15 remains unsupported.
  const supportedMixerMask = oldLayout ? 0x001f : 0x7fff;
  const unsupportedMixerBits = mixerControl & ~supportedMixerMask;
  if (unsupportedMixerBits !== 0) {
    reject("unsupported-mixer-control", {
      parameterBlock: block.logicalAddress,
      mixerControl,
      unsupportedBits: unsupportedMixerBits & 0xffff,
      supportedMask: supportedMixerMask,
    });
  }

  if (words[AX_PB_WORD.RUNNING] !== 1) return;

  if (words[AX_PB_WORD.INITIAL_TIME_DELAY_ON] !== 0) {
    reject("unsupported-initial-time-delay", {
      parameterBlock: block.logicalAddress,
    });
  }
  if (words[AX_PB_WORD.LOW_PASS_FILTER_ON] !== 0) {
    reject("unsupported-low-pass-filter", {
      parameterBlock: block.logicalAddress,
    });
  }

  const format = words[AX_PB_WORD.SAMPLE_FORMAT];
  if (
    format !== AX_SAMPLE_FORMAT.DSP_ADPCM
    && !isPcm16Format(format)
  ) {
    reject("unsupported-sample-format", {
      parameterBlock: block.logicalAddress,
      sampleFormat: format,
    });
  }

  const sourceType = words[AX_PB_WORD.SRC_TYPE];
  if (
    sourceType !== AX_SRC_TYPE.POLYPHASE
    && sourceType !== AX_SRC_TYPE.LINEAR
    && sourceType !== AX_SRC_TYPE.NEAREST
  ) {
    reject("unsupported-source-type", {
      parameterBlock: block.logicalAddress,
      sourceType,
    });
  }
  if (sourceType !== AX_SRC_TYPE.NEAREST) {
    const ratio = blockAddress(
      words,
      AX_PB_WORD.SRC_RATIO_HIGH,
      AX_PB_WORD.SRC_RATIO_LOW,
    );
    if (ratio === 0 || ratio > 0x0004_0000) {
      reject("invalid-source-ratio", {
        parameterBlock: block.logicalAddress,
        ratio,
      });
    }
  }
}

function readAramByte(context, address, parameterBlock) {
  if (!Number.isSafeInteger(address) || address < 0) {
    reject("invalid-aram-address", {
      parameterBlock,
      aramAddress: address,
    });
  }
  const logicalAddress = address >>> 0;
  const physicalAddress = logicalAddress & context.aramMask;
  if (physicalAddress !== logicalAddress) {
    context.aramWrappedReads += 1;
  }
  return context.aram[physicalAddress];
}

function acceleratorFromParameterBlock(block) {
  const { words } = block;
  return {
    startAddress: blockAddress(
      words,
      AX_PB_WORD.LOOP_ADDRESS_HIGH,
      AX_PB_WORD.LOOP_ADDRESS_LOW,
    ) & 0x3fff_ffff,
    endAddress: blockAddress(
      words,
      AX_PB_WORD.END_ADDRESS_HIGH,
      AX_PB_WORD.END_ADDRESS_LOW,
    ) & 0x3fff_ffff,
    currentAddress: blockAddress(
      words,
      AX_PB_WORD.CURRENT_ADDRESS_HIGH,
      AX_PB_WORD.CURRENT_ADDRESS_LOW,
    ) & 0xbfff_ffff,
    sampleFormat: words[AX_PB_WORD.SAMPLE_FORMAT],
    gain: toSigned16(words[AX_PB_WORD.ADPCM_GAIN]),
    predictorScale:
      words[AX_PB_WORD.ADPCM_PREDICTOR_SCALE] & 0x007f,
    yn1: toSigned16(words[AX_PB_WORD.ADPCM_YN1]),
    yn2: toSigned16(words[AX_PB_WORD.ADPCM_YN2]),
    readsStopped: false,
  };
}

function finishSampleRead(block, accelerator, stepSize, context) {
  if (
    accelerator.currentAddress
    === (accelerator.endAddress + stepSize - 1) >>> 0
  ) {
    accelerator.currentAddress = accelerator.startAddress;
    accelerator.readsStopped = true;
    const { words } = block;
    if (words[AX_PB_WORD.LOOPING] !== 0) {
      accelerator.predictorScale =
        words[AX_PB_WORD.ADPCM_LOOP_PREDICTOR_SCALE] & 0x007f;
      if (words[AX_PB_WORD.IS_STREAM] !== 1) {
        accelerator.yn1 = toSigned16(words[AX_PB_WORD.ADPCM_LOOP_YN1]);
        accelerator.yn2 = toSigned16(words[AX_PB_WORD.ADPCM_LOOP_YN2]);
      }
      accelerator.readsStopped = false;
      if (words[AX_PB_WORD.IS_STREAM] === 1) {
        words[AX_PB_WORD.LOOP_COUNTER] =
          (words[AX_PB_WORD.LOOP_COUNTER] + 1) & 0xffff;
      }
      context.loops += 1;
    } else {
      words[AX_PB_WORD.RUNNING] = 0;
    }
  }
  accelerator.currentAddress &= 0xbfff_ffff;
}

function readAdpcmSample(block, accelerator, context) {
  const { words } = block;
  const byteAddress = accelerator.currentAddress >>> 1;
  const packed = readAramByte(
    context,
    byteAddress,
    block.logicalAddress,
  );
  let nibble = (accelerator.currentAddress & 1) === 0
    ? packed >>> 4
    : packed & 0x0f;
  if (nibble >= 8) nibble -= 16;

  const coefficient = ((accelerator.predictorScale >>> 4) & 7) * 2;
  const coefficient1 = toSigned16(
    words[AX_PB_WORD.ADPCM_COEFFICIENT_0 + coefficient],
  );
  const coefficient2 = toSigned16(
    words[AX_PB_WORD.ADPCM_COEFFICIENT_0 + coefficient + 1],
  );
  const prediction = shiftSigned32(
    toSigned32(
      0x400
      + coefficient1 * accelerator.yn1
      + coefficient2 * accelerator.yn2,
    ),
    11,
  );
  const scale = 1 << (accelerator.predictorScale & 0x0f);
  const sample = clampAdpcm(scale * nibble + prediction);

  accelerator.yn2 = accelerator.yn1;
  accelerator.yn1 = sample;
  accelerator.currentAddress = (accelerator.currentAddress + 1) >>> 0;
  let stepSize = 2;

  if (
    (accelerator.endAddress & 0x0f) === 0
    && accelerator.currentAddress === accelerator.endAddress
  ) {
    accelerator.currentAddress = (accelerator.startAddress + 1) >>> 0;
  } else if (
    (accelerator.endAddress & 0x0f) === 1
    && accelerator.currentAddress === (accelerator.endAddress - 1) >>> 0
  ) {
    accelerator.currentAddress = accelerator.startAddress;
  } else if ((accelerator.currentAddress & 0x0f) === 0) {
    accelerator.predictorScale = readAramByte(
      context,
      (accelerator.currentAddress & ~0x0f) >>> 1,
      block.logicalAddress,
    );
    accelerator.currentAddress = (accelerator.currentAddress + 2) >>> 0;
    stepSize += 2;
  }

  finishSampleRead(block, accelerator, stepSize, context);
  return sample;
}

function readPcm16Sample(block, accelerator, context) {
  const { words } = block;
  const byteAddress = accelerator.currentAddress * 2;
  const high = readAramByte(context, byteAddress, block.logicalAddress);
  const low = readAramByte(context, byteAddress + 1, block.logicalAddress);
  const rawSample = toSigned16((high << 8) | low);
  const coefficient = ((accelerator.predictorScale >>> 4) & 7) * 2;
  const coefficient1 = toSigned16(
    words[AX_PB_WORD.ADPCM_COEFFICIENT_0 + coefficient],
  );
  const coefficient2 = toSigned16(
    words[AX_PB_WORD.ADPCM_COEFFICIENT_0 + coefficient + 1],
  );
  const gainScale = (accelerator.sampleFormat >>> 4) & 3;
  const gainShift = gainScale === 0
    ? 11
    : gainScale === 1
      ? 0
      : gainScale === 2
        ? 16
        : null;
  if (gainShift === null) {
    reject("invalid-pcm-gain-scale", {
      parameterBlock: block.logicalAddress,
      sampleFormat: accelerator.sampleFormat,
    });
  }

  const sample = toSigned16(toSigned32(
    shiftSigned32(accelerator.gain * rawSample, gainShift)
    + shiftSigned32(coefficient1 * accelerator.yn1, gainShift)
    + shiftSigned32(coefficient2 * accelerator.yn2, gainShift),
  ));
  accelerator.yn2 = accelerator.yn1;
  accelerator.yn1 = sample;
  accelerator.currentAddress = (accelerator.currentAddress + 1) >>> 0;
  finishSampleRead(block, accelerator, 2, context);
  return sample;
}

function readAcceleratorSample(block, accelerator, context) {
  context.sourceSampleReads += 1;
  if (accelerator.readsStopped) return 0;
  context.aramSamplesDecoded += 1;
  if (accelerator.sampleFormat === AX_SAMPLE_FORMAT.DSP_ADPCM) {
    return readAdpcmSample(block, accelerator, context);
  }
  return readPcm16Sample(block, accelerator, context);
}

function writeAcceleratorToParameterBlock(block, accelerator) {
  const { words } = block;
  words[AX_PB_WORD.CURRENT_ADDRESS_HIGH] =
    splitHigh(accelerator.currentAddress);
  words[AX_PB_WORD.CURRENT_ADDRESS_LOW] =
    splitLow(accelerator.currentAddress);
  words[AX_PB_WORD.ADPCM_PREDICTOR_SCALE] =
    accelerator.predictorScale & 0xffff;
  words[AX_PB_WORD.ADPCM_YN1] = accelerator.yn1 & 0xffff;
  words[AX_PB_WORD.ADPCM_YN2] = accelerator.yn2 & 0xffff;
}

function resampleNearest(block, count, context) {
  const accelerator = acceleratorFromParameterBlock(block);
  const output = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    output[index] = readAcceleratorSample(block, accelerator, context);
  }
  writeAcceleratorToParameterBlock(block, accelerator);
  for (let index = 0; index < 4; index += 1) {
    block.words[AX_PB_WORD.SRC_LAST_SAMPLE_0 + index] =
      output[count - 4 + index] & 0xffff;
  }
  return output;
}

function resampleLinear(block, count, context) {
  const { words } = block;
  const accelerator = acceleratorFromParameterBlock(block);
  const output = new Int16Array(count);
  const temporary = new Int16Array(4);
  let temporaryIndex = 0;
  for (let index = 0; index < 4; index += 1) {
    temporary[temporaryIndex++ & 3] = toSigned16(
      words[AX_PB_WORD.SRC_LAST_SAMPLE_0 + index],
    );
  }

  const ratio = blockAddress(
    words,
    AX_PB_WORD.SRC_RATIO_HIGH,
    AX_PB_WORD.SRC_RATIO_LOW,
  );
  let currentPosition = words[AX_PB_WORD.SRC_CURRENT_FRACTION];
  for (let outputIndex = 0; outputIndex < count; outputIndex += 1) {
    currentPosition += ratio;
    while (currentPosition >= 0x1_0000) {
      temporary[temporaryIndex++ & 3] = readAcceleratorSample(
        block,
        accelerator,
        context,
      );
      currentPosition -= 0x1_0000;
    }

    const fraction = currentPosition & 0xffff;
    if (fraction !== 0) {
      const inverse = (-fraction) & 0xffff;
      const sample0 = temporary[temporaryIndex++ & 3];
      const sample1 = temporary[temporaryIndex++ & 3];
      output[outputIndex] = shiftSigned32(
        sample0 * inverse + sample1 * fraction,
        16,
      );
      temporaryIndex += 2;
    } else {
      output[outputIndex] = temporary[temporaryIndex++ & 3];
      temporaryIndex += 3;
    }
  }

  for (let index = 3; index >= 0; index -= 1) {
    words[AX_PB_WORD.SRC_LAST_SAMPLE_0 + index] =
      temporary[--temporaryIndex & 3] & 0xffff;
  }
  words[AX_PB_WORD.SRC_CURRENT_FRACTION] =
    currentPosition & 0xffff;
  writeAcceleratorToParameterBlock(block, accelerator);
  return output;
}

function sourceSamples(block, count, context) {
  const sourceType = block.words[AX_PB_WORD.SRC_TYPE];
  if (sourceType === AX_SRC_TYPE.NEAREST) {
    return resampleNearest(block, count, context);
  }
  if (sourceType === AX_SRC_TYPE.POLYPHASE) {
    context.polyphaseFallbackSubframes += 1;
  }
  return resampleLinear(block, count, context);
}

function mixerRoutes(mixerControl, oldLayout) {
  if (!oldLayout) {
    return MIX_ROUTES.map(route => Object.freeze({
      route,
      enabled: (mixerControl & route.enableBit) !== 0,
      ramp: (mixerControl & route.rampBit) !== 0,
    }));
  }

  const enabled = new Set(["main.left", "main.right"]);
  const dpl2 = (mixerControl & 0x0010) !== 0;
  if (dpl2) {
    if ((mixerControl & 0x0006) === 0) {
      enabled.add("auxB.left");
      enabled.add("auxB.right");
    }
    if ((mixerControl & 0x0007) === 1) {
      enabled.add("auxA.left");
      enabled.add("auxA.right");
      enabled.add("auxA.surround");
    }
  } else {
    if ((mixerControl & 0x0001) !== 0) {
      enabled.add("auxA.left");
      enabled.add("auxA.right");
    }
    if ((mixerControl & 0x0002) !== 0) {
      enabled.add("auxB.left");
      enabled.add("auxB.right");
    }
    if ((mixerControl & 0x0004) !== 0) {
      enabled.add("main.surround");
      if (enabled.has("auxA.left")) enabled.add("auxA.surround");
      if (enabled.has("auxB.left")) enabled.add("auxB.surround");
    }
  }
  const ramp = (mixerControl & 0x0008) !== 0;
  return MIX_ROUTES.map(route => Object.freeze({
    route,
    enabled: enabled.has(route.key),
    ramp,
  }));
}

function mixChannel({
  block,
  buffer,
  samples,
  volumeWord,
  deltaWord,
  dpopWord,
  ramp,
}) {
  const { words } = block;
  let volume = words[volumeWord];
  const delta = ramp ? words[deltaWord] : 0;
  let dpop = toSigned16(words[dpopWord]);
  for (let index = 0; index < samples.length; index += 1) {
    const mixed = clampSigned16(shiftSigned32(samples[index] * volume, 15));
    buffer[index] = toSigned32(buffer[index] + mixed);
    volume = (volume + delta) & 0xffff;
    dpop = mixed;
  }
  words[volumeWord] = volume;
  words[dpopWord] = dpop & 0xffff;
}

function processParameterBlock(
  block,
  updates,
  accumulators,
  oldLayout,
  context,
) {
  const { words } = block;
  let voiceProcessed = false;
  let usedAdpcm = false;
  let usedPcm16 = false;
  for (
    let millisecond = 0;
    millisecond < AX_REFERENCE_LIMITS.milliseconds;
    millisecond += 1
  ) {
    applyParameterBlockUpdates(
      block,
      millisecond,
      updates,
      context,
    );
    validateParameterBlock(block, oldLayout);
    if (words[AX_PB_WORD.RUNNING] !== 1) continue;
    if (!voiceProcessed) {
      voiceProcessed = true;
      context.voicesProcessed += 1;
    }
    if (words[AX_PB_WORD.SAMPLE_FORMAT] === AX_SAMPLE_FORMAT.DSP_ADPCM) {
      if (!usedAdpcm) {
        usedAdpcm = true;
        context.adpcmVoices += 1;
      }
    } else if (!usedPcm16) {
      usedPcm16 = true;
      context.pcm16Voices += 1;
    }
    context.voiceSubframesProcessed += 1;

    const samples = sourceSamples(
      block,
      AX_REFERENCE_LIMITS.samplesPerMillisecond,
      context,
    );

    let envelope = toSigned16(
      words[AX_PB_WORD.VOLUME_ENVELOPE_CURRENT],
    );
    const envelopeDelta = toSigned16(
      words[AX_PB_WORD.VOLUME_ENVELOPE_DELTA],
    );
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = clampSigned16(
        shiftSigned32(samples[index] * envelope, 15),
      );
      envelope = toSigned16(envelope + envelopeDelta);
    }
    words[AX_PB_WORD.VOLUME_ENVELOPE_CURRENT] = envelope & 0xffff;

    const offset =
      millisecond * AX_REFERENCE_LIMITS.samplesPerMillisecond;
    const routes = mixerRoutes(
      words[AX_PB_WORD.MIXER_CONTROL],
      oldLayout,
    );
    for (const { route, enabled, ramp } of routes) {
      if (!enabled) continue;
      const plane = accumulators[route.bus][route.channel];
      mixChannel({
        block,
        buffer: plane.subarray(offset, offset + samples.length),
        samples,
        volumeWord: route.volumeWord,
        deltaWord: route.deltaWord,
        dpopWord: route.dpopWord,
        ramp,
      });
    }
  }
}

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (const value of bytes) {
    hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hex32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function buildOutput(left, right) {
  const sampleValues = new Int16Array(
    AX_REFERENCE_LIMITS.frames * AX_REFERENCE_LIMITS.channels,
  );
  const bytes = new Uint8Array(sampleValues.length * 2);
  let clippedSampleValues = 0;
  let nonZeroSampleValues = 0;
  let peakAbsoluteSample = 0;
  for (let frame = 0; frame < AX_REFERENCE_LIMITS.frames; frame += 1) {
    if (left[frame] < -0x8000 || left[frame] > 0x7fff) {
      clippedSampleValues += 1;
    }
    if (right[frame] < -0x8000 || right[frame] > 0x7fff) {
      clippedSampleValues += 1;
    }
    const leftSample = clampSigned16(left[frame]);
    const rightSample = clampSigned16(right[frame]);
    const rightIndex = frame * 2;
    const leftIndex = rightIndex + 1;
    sampleValues[rightIndex] = rightSample;
    sampleValues[leftIndex] = leftSample;
    writeBigEndianU16(bytes, rightIndex * 2, rightSample & 0xffff);
    writeBigEndianU16(bytes, leftIndex * 2, leftSample & 0xffff);
    if (rightSample !== 0) nonZeroSampleValues += 1;
    if (leftSample !== 0) nonZeroSampleValues += 1;
    peakAbsoluteSample = Math.max(
      peakAbsoluteSample,
      Math.abs(rightSample),
      Math.abs(leftSample),
    );
  }
  return {
    sampleValues,
    bytes,
    clippedSampleValues,
    nonZeroSampleValues,
    peakAbsoluteSample,
    hash: fnv1a(bytes),
  };
}

function parameterBlockWriteback(block) {
  const { words } = block;
  return Object.freeze({
    address: block.logicalAddress,
    physicalAddress: block.physicalAddress,
    running: words[AX_PB_WORD.RUNNING],
    currentAddress: blockAddress(
      words,
      AX_PB_WORD.CURRENT_ADDRESS_HIGH,
      AX_PB_WORD.CURRENT_ADDRESS_LOW,
    ),
    predictorScale: words[AX_PB_WORD.ADPCM_PREDICTOR_SCALE],
    yn1: toSigned16(words[AX_PB_WORD.ADPCM_YN1]),
    yn2: toSigned16(words[AX_PB_WORD.ADPCM_YN2]),
    sourceFraction: words[AX_PB_WORD.SRC_CURRENT_FRACTION],
    lastSamples: Object.freeze(
      Array.from(
        { length: 4 },
        (_unused, index) => toSigned16(
          words[AX_PB_WORD.SRC_LAST_SAMPLE_0 + index],
        ),
      ),
    ),
    volumeEnvelope: Object.freeze({
      current: toSigned16(words[AX_PB_WORD.VOLUME_ENVELOPE_CURRENT]),
      delta: toSigned16(words[AX_PB_WORD.VOLUME_ENVELOPE_DELTA]),
    }),
    mainLeft: Object.freeze({
      volume: words[AX_PB_WORD.MAIN_LEFT_VOLUME],
      delta: words[AX_PB_WORD.MAIN_LEFT_DELTA],
      dpop: toSigned16(words[AX_PB_WORD.DPOP_MAIN_LEFT]),
    }),
    mainRight: Object.freeze({
      volume: words[AX_PB_WORD.MAIN_RIGHT_VOLUME],
      delta: words[AX_PB_WORD.MAIN_RIGHT_DELTA],
      dpop: toSigned16(words[AX_PB_WORD.DPOP_MAIN_RIGHT]),
    }),
    loopCounter: words[AX_PB_WORD.LOOP_COUNTER],
  });
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

export function renderAxVoiceReference({
  mram,
  aram,
  headAddress,
  ucodeHash,
  initialAccumulators,
  initialMainLeft,
  initialMainRight,
  maximumParameterBlocks = AX_REFERENCE_LIMITS.maximumParameterBlocks,
}) {
  requireBytes(mram, "mram");
  requireBytes(aram, "aram");
  requireInitialAccumulators(
    initialAccumulators,
    initialMainLeft,
    initialMainRight,
  );
  if (
    aram.length === 0
    || !Number.isInteger(Math.log2(aram.length))
  ) {
    throw new RangeError("aram length must be a non-zero power of two");
  }
  const normalizedHeadAddress = requireU32(headAddress, "headAddress");
  const normalizedUcodeHash = requireU32(ucodeHash, "ucodeHash");
  if (
    !Number.isSafeInteger(maximumParameterBlocks)
    || maximumParameterBlocks <= 0
    || maximumParameterBlocks
      > AX_REFERENCE_LIMITS.hardMaximumParameterBlocks
  ) {
    throw new RangeError(
      "maximumParameterBlocks must be a positive bounded integer",
    );
  }

  const oldLayout = pbUsesOldLayout(normalizedUcodeHash);
  const parameterBlockLayoutBytes = axParameterBlockByteLength(
    normalizedUcodeHash,
  );
  const parameterBlockDmaBytes = axParameterBlockDmaByteLength(
    normalizedUcodeHash,
  );
  try {
    const accumulators = cloneAccumulators({
      initialAccumulators,
      initialMainLeft,
      initialMainRight,
    });
    const context = {
      aram,
      aramMask: aram.length - 1,
      aramWrappedReads: 0,
      sourceSampleReads: 0,
      aramSamplesDecoded: 0,
      loops: 0,
      voicesProcessed: 0,
      adpcmVoices: 0,
      pcm16Voices: 0,
      voiceSubframesProcessed: 0,
      polyphaseFallbackSubframes: 0,
      parameterBlockUpdateTables: 0,
      parameterBlockUpdateReadBytes: 0,
      parameterBlockUpdateEntriesVisited: 0,
      parameterBlockUpdateWordWrites: 0,
      parameterBlockUpdateOffsetsIgnored: 0,
      parameterBlockUpdateSlicesSkipped: 0,
      parameterBlockDmaWords: parameterBlockDmaBytes / 2,
      ucodeHash: normalizedUcodeHash,
    };

    const blocks = [];
    const parameterBlockWritesMutable = [];
    const physicalAddresses = new Set();
    const parameterBlockRanges = [];
    let address = normalizedHeadAddress;
    while (address !== 0) {
      if (blocks.length >= maximumParameterBlocks) {
        reject("parameter-block-limit", {
          maximumParameterBlocks,
          nextAddress: address,
        });
      }
      const physicalAddress = physicalMramAddress(
        address,
        parameterBlockDmaBytes,
        mram.length,
      );
      if (physicalAddresses.has(physicalAddress)) {
        reject("parameter-block-cycle", {
          address,
          physicalAddress,
        });
      }
      for (const range of parameterBlockRanges) {
        if (
          physicalAddress < range.end
          && range.start < physicalAddress + parameterBlockDmaBytes
        ) {
          reject("parameter-block-overlap", {
            address,
            physicalAddress,
            conflictingAddress: range.address,
            conflictingPhysicalAddress: range.start,
          });
        }
      }
      physicalAddresses.add(physicalAddress);
      parameterBlockRanges.push({
        address,
        start: physicalAddress,
        end: physicalAddress + parameterBlockDmaBytes,
      });

      const block = decodeParameterBlock(
        mram,
        address,
        physicalAddress,
        normalizedUcodeHash,
        parameterBlockDmaBytes,
      );
      const updates = loadParameterBlockUpdates({
        block,
        context,
        mram,
        stagedWrites: parameterBlockWritesMutable,
      });
      processParameterBlock(
        block,
        updates,
        accumulators,
        oldLayout,
        context,
      );
      blocks.push(block);
      parameterBlockWritesMutable.push(parameterBlockWrite(
        block,
        normalizedUcodeHash,
      ));
      address = blockAddress(
        block.words,
        AX_PB_WORD.NEXT_HIGH,
        AX_PB_WORD.NEXT_LOW,
      );
    }

    const rendered = buildOutput(
      accumulators.main.left,
      accumulators.main.right,
    );
    const parameterBlockWrites = Object.freeze(
      parameterBlockWritesMutable,
    );
    const writebacks = Object.freeze(
      blocks.map(parameterBlockWriteback),
    );
    const telemetry = Object.freeze({
      schema: AX_REFERENCE_SCHEMA,
      ucodeHash: hex32(normalizedUcodeHash),
      parameterBlockLayoutBytes,
      parameterBlocks: blocks.length,
      parameterBlockWriteBytes:
        parameterBlockWrites.reduce(
          (total, write) => total + write.byteLength,
          0,
        ),
      initialMainBuffers:
        initialAccumulators === undefined
          && initialMainLeft === undefined
          && initialMainRight === undefined
          ? "zero"
          : "explicit",
      initialMainBufferContract: AX_INITIAL_MAIN_BUFFER_CONTRACT,
      initialAccumulators: initialAccumulators !== undefined
        ? "nested"
        : initialMainLeft !== undefined || initialMainRight !== undefined
          ? "legacy-main"
          : "zero",
      initialAccumulatorContract: AX_INITIAL_ACCUMULATOR_CONTRACT,
      accumulatorPlanes: AX_REFERENCE_LIMITS.accumulatorPlanes,
      voicesProcessed: context.voicesProcessed,
      adpcmVoices: context.adpcmVoices,
      pcm16Voices: context.pcm16Voices,
      voiceSubframesProcessed: context.voiceSubframesProcessed,
      parameterBlockUpdateTables:
        context.parameterBlockUpdateTables,
      parameterBlockUpdateReadBytes:
        context.parameterBlockUpdateReadBytes,
      parameterBlockUpdateEntriesVisited:
        context.parameterBlockUpdateEntriesVisited,
      parameterBlockUpdateWordWrites:
        context.parameterBlockUpdateWordWrites,
      parameterBlockUpdateOffsetsIgnored:
        context.parameterBlockUpdateOffsetsIgnored,
      parameterBlockUpdateSlicesSkipped:
        context.parameterBlockUpdateSlicesSkipped,
      sourceSampleReads: context.sourceSampleReads,
      aramSamplesDecoded: context.aramSamplesDecoded,
      aramWrappedReads: context.aramWrappedReads,
      loops: context.loops,
      polyphaseFallbackSubframes:
        context.polyphaseFallbackSubframes,
      sampleRateHz: AX_REFERENCE_LIMITS.sampleRateHz,
      frames: AX_REFERENCE_LIMITS.frames,
      channels: AX_REFERENCE_LIMITS.channels,
      outputOrder: "R,L",
      outputBytes: rendered.bytes.length,
      nonZeroSampleValues: rendered.nonZeroSampleValues,
      clippedSampleValues: rendered.clippedSampleValues,
      peakAbsoluteSample: rendered.peakAbsoluteSample,
      outputHash: hex32(rendered.hash),
    });

    return Object.freeze({
      ok: true,
      accumulators,
      mainAccumulators: Object.freeze({
        frames: AX_REFERENCE_LIMITS.frames,
        left: accumulators.main.left,
        right: accumulators.main.right,
      }),
      output: Object.freeze({
        sampleRateHz: AX_REFERENCE_LIMITS.sampleRateHz,
        frames: AX_REFERENCE_LIMITS.frames,
        channels: AX_REFERENCE_LIMITS.channels,
        order: "R,L",
        samples: rendered.sampleValues,
        bytes: rendered.bytes,
      }),
      parameterBlockWrites,
      writebacks,
      telemetry,
    });
  } catch (error) {
    if (error instanceof AxReferenceRejection) {
      return rejectionResult(error);
    }
    throw error;
  }
}
