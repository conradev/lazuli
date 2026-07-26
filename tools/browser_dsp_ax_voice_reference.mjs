// SPDX-License-Identifier: GPL-3.0-only

// Pure, deterministic reference for the narrow AX GameCube voice path needed
// to turn a linked parameter-block list into one 5 ms main L/R PCM buffer.
//
// The layout and arithmetic follow Dolphin's AXStructs.h, AXVoice.h,
// DSPAccelerator.{h,cpp}, and AX.cpp. This module intentionally does not model
// the DSP mailbox/command-list protocol, AUX or surround routing, depop/effect
// buffers, PB updates, ITD/filters, PCM8, DROM polyphase coefficients, AI DMA,
// or a host audio sink. Polyphase SRC requests use Dolphin's coefficient-free
// linear fallback. Main L/R accumulators default to zero and may be supplied as
// exact 160-sample Int32Array snapshots. The reference clones only those
// bounded accumulator inputs and individual parameter blocks; it never clones
// MRAM.

export const AX_REFERENCE_SCHEMA = "lazuli-ax-gc-voice-reference-v1";
export const AX_OLD_UCODE_HASH = 0x4e8a8b21;
export const AX_FZERO_UCODE_HASH = 0x07f88145;
export const AX_INITIAL_MAIN_BUFFER_CONTRACT =
  "optional-int32x160-zero-default";

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

export const AX_REFERENCE_LIMITS = Object.freeze({
  frames: 160,
  samplesPerMillisecond: 32,
  milliseconds: 5,
  channels: 2,
  sampleRateHz: 32_000,
  maximumParameterBlocks: 64,
  hardMaximumParameterBlocks: 1_024,
});

export const AX_REFERENCE_NON_GOALS = Object.freeze([
  "DSP mailbox and AX command-list parsing",
  "AUX, surround, depop, and effect-buffer processing",
  "parameter-block updates",
  "initial-time-delay and low-pass filtering",
  "PCM8 and DROM-coefficient polyphase resampling",
  "non-zero CMD_SETUP accumulator initialization",
  "AI DMA and host audio output",
]);

// Logical u16 word offsets in Dolphin's AXPB. The 0x4e8a8b21 layout omits
// words 93..96 (PBLowPassFilter), moving LOOP_COUNTER and padding four words
// earlier in guest memory.
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

  INITIAL_TIME_DELAY_ON: 27,
  UPDATE_COUNT_0: 34,
  UPDATE_COUNT_4: 38,

  DPOP_MAIN_LEFT: 41,
  DPOP_MAIN_RIGHT: 44,
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

const AX_PB_LOGICAL_WORDS = 122;
const AX_PB_OLD_PHYSICAL_WORDS = AX_PB_LOGICAL_WORDS - 4;
const U32_MAX = 0xffff_ffff;
const MAIN_LEFT = 1;
const MAIN_RIGHT = 2;
const MAIN_LEFT_RAMP = 4;
const MAIN_RIGHT_RAMP = 8;

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

function requireMainAccumulator(value, name) {
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

function cloneMainAccumulator(value) {
  return value === undefined
    ? new Int32Array(AX_REFERENCE_LIMITS.frames)
    : new Int32Array(value);
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

function pbPhysicalWord(logicalWord, oldLayout) {
  if (
    oldLayout
    && logicalWord >= AX_PB_WORD.LOW_PASS_FILTER_ON
    && logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_END
  ) {
    return null;
  }
  if (oldLayout && logicalWord > AX_PB_WORD.LOW_PASS_FILTER_END) {
    return logicalWord - 4;
  }
  return logicalWord;
}

export function axParameterBlockByteLength(ucodeHash) {
  requireU32(ucodeHash, "ucodeHash");
  return (
    pbUsesOldLayout(ucodeHash)
      ? AX_PB_OLD_PHYSICAL_WORDS
      : AX_PB_LOGICAL_WORDS
  ) * 2;
}

function physicalMramAddress(address, length, mramLength) {
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
    reject("parameter-block-out-of-bounds", {
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

function decodeParameterBlock(mram, logicalAddress, physicalAddress, oldLayout) {
  const words = new Uint16Array(AX_PB_LOGICAL_WORDS);
  for (let logicalWord = 0; logicalWord < words.length; logicalWord += 1) {
    const physicalWord = pbPhysicalWord(logicalWord, oldLayout);
    if (physicalWord === null) continue;
    words[logicalWord] = readBigEndianU16(
      mram,
      physicalAddress + physicalWord * 2,
    );
  }
  return {
    logicalAddress: logicalAddress >>> 0,
    physicalAddress,
    words,
  };
}

function parameterBlockWrite(block, oldLayout, parameterBlockBytes) {
  const data = new Uint8Array(parameterBlockBytes);
  for (let logicalWord = 0; logicalWord < block.words.length; logicalWord += 1) {
    const physicalWord = pbPhysicalWord(logicalWord, oldLayout);
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

  for (
    let word = AX_PB_WORD.UPDATE_COUNT_0;
    word <= AX_PB_WORD.UPDATE_COUNT_4;
    word += 1
  ) {
    if (words[word] !== 0) {
      reject("unsupported-parameter-block-updates", {
        parameterBlock: block.logicalAddress,
        millisecond: word - AX_PB_WORD.UPDATE_COUNT_0,
        count: words[word],
      });
    }
  }

  const mixerControl = words[AX_PB_WORD.MIXER_CONTROL];
  const supportedMixerMask = oldLayout ? 0x0008 : 0x000b;
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
  if (!oldLayout && words[AX_PB_WORD.LOW_PASS_FILTER_ON] !== 0) {
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

function collectParameterBlocks({
  mram,
  headAddress,
  oldLayout,
  parameterBlockBytes,
  maximumParameterBlocks,
}) {
  const blocks = [];
  const physicalAddresses = new Set();
  const ranges = [];
  let address = headAddress >>> 0;
  while (address !== 0) {
    if (blocks.length >= maximumParameterBlocks) {
      reject("parameter-block-limit", {
        maximumParameterBlocks,
        nextAddress: address,
      });
    }
    const physicalAddress = physicalMramAddress(
      address,
      parameterBlockBytes,
      mram.length,
    );
    if (physicalAddresses.has(physicalAddress)) {
      reject("parameter-block-cycle", {
        address,
        physicalAddress,
      });
    }
    for (const range of ranges) {
      if (
        physicalAddress < range.end
        && range.start < physicalAddress + parameterBlockBytes
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
    ranges.push({
      address,
      start: physicalAddress,
      end: physicalAddress + parameterBlockBytes,
    });

    const block = decodeParameterBlock(
      mram,
      address,
      physicalAddress,
      oldLayout,
    );
    validateParameterBlock(block, oldLayout);
    blocks.push(block);
    address = blockAddress(
      block.words,
      AX_PB_WORD.NEXT_HIGH,
      AX_PB_WORD.NEXT_LOW,
    );
  }
  return blocks;
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

function mainMixerControl(mixerControl, oldLayout) {
  if (oldLayout) {
    const ramp = (mixerControl & 0x0008) !== 0;
    return MAIN_LEFT
      | MAIN_RIGHT
      | (ramp ? MAIN_LEFT_RAMP | MAIN_RIGHT_RAMP : 0);
  }
  return (
    ((mixerControl & 0x0001) !== 0 ? MAIN_LEFT : 0)
    | ((mixerControl & 0x0002) !== 0 ? MAIN_RIGHT : 0)
    | ((mixerControl & 0x0008) !== 0
      ? MAIN_LEFT_RAMP | MAIN_RIGHT_RAMP
      : 0)
  );
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

function processParameterBlock(block, left, right, oldLayout, context) {
  const { words } = block;
  if (words[AX_PB_WORD.RUNNING] !== 1) return;
  context.voicesProcessed += 1;
  if (words[AX_PB_WORD.SAMPLE_FORMAT] === AX_SAMPLE_FORMAT.DSP_ADPCM) {
    context.adpcmVoices += 1;
  } else {
    context.pcm16Voices += 1;
  }

  const control = mainMixerControl(
    words[AX_PB_WORD.MIXER_CONTROL],
    oldLayout,
  );
  for (
    let millisecond = 0;
    millisecond < AX_REFERENCE_LIMITS.milliseconds;
    millisecond += 1
  ) {
    if (words[AX_PB_WORD.RUNNING] !== 1) break;
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
    if ((control & MAIN_LEFT) !== 0) {
      mixChannel({
        block,
        buffer: left.subarray(offset, offset + samples.length),
        samples,
        volumeWord: AX_PB_WORD.MAIN_LEFT_VOLUME,
        deltaWord: AX_PB_WORD.MAIN_LEFT_DELTA,
        dpopWord: AX_PB_WORD.DPOP_MAIN_LEFT,
        ramp: (control & MAIN_LEFT_RAMP) !== 0,
      });
    }
    if ((control & MAIN_RIGHT) !== 0) {
      mixChannel({
        block,
        buffer: right.subarray(offset, offset + samples.length),
        samples,
        volumeWord: AX_PB_WORD.MAIN_RIGHT_VOLUME,
        deltaWord: AX_PB_WORD.MAIN_RIGHT_DELTA,
        dpopWord: AX_PB_WORD.DPOP_MAIN_RIGHT,
        ramp: (control & MAIN_RIGHT_RAMP) !== 0,
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
  initialMainLeft,
  initialMainRight,
  maximumParameterBlocks = AX_REFERENCE_LIMITS.maximumParameterBlocks,
}) {
  requireBytes(mram, "mram");
  requireBytes(aram, "aram");
  requireMainAccumulator(initialMainLeft, "initialMainLeft");
  requireMainAccumulator(initialMainRight, "initialMainRight");
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
  const parameterBlockBytes = axParameterBlockByteLength(
    normalizedUcodeHash,
  );
  try {
    const blocks = collectParameterBlocks({
      mram,
      headAddress: normalizedHeadAddress,
      oldLayout,
      parameterBlockBytes,
      maximumParameterBlocks,
    });
    const left = cloneMainAccumulator(initialMainLeft);
    const right = cloneMainAccumulator(initialMainRight);
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
      polyphaseFallbackSubframes: 0,
    };

    for (const block of blocks) {
      processParameterBlock(block, left, right, oldLayout, context);
    }

    const rendered = buildOutput(left, right);
    const parameterBlockWrites = Object.freeze(
      blocks.map(block => parameterBlockWrite(
        block,
        oldLayout,
        parameterBlockBytes,
      )),
    );
    const writebacks = Object.freeze(
      blocks.map(parameterBlockWriteback),
    );
    const telemetry = Object.freeze({
      schema: AX_REFERENCE_SCHEMA,
      ucodeHash: hex32(normalizedUcodeHash),
      parameterBlockLayoutBytes: parameterBlockBytes,
      parameterBlocks: blocks.length,
      parameterBlockWriteBytes:
        parameterBlockWrites.length * parameterBlockBytes,
      initialMainBuffers:
        initialMainLeft === undefined && initialMainRight === undefined
          ? "zero"
          : "explicit",
      initialMainBufferContract: AX_INITIAL_MAIN_BUFFER_CONTRACT,
      voicesProcessed: context.voicesProcessed,
      adpcmVoices: context.adpcmVoices,
      pcm16Voices: context.pcm16Voices,
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
      mainAccumulators: Object.freeze({
        frames: AX_REFERENCE_LIMITS.frames,
        left,
        right,
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
