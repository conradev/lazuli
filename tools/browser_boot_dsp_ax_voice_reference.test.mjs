#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  AX_FZERO_UCODE_HASH,
  AX_OLD_UCODE_HASH,
  AX_PB_WORD,
  AX_REFERENCE_LIMITS,
  AX_SAMPLE_FORMAT,
  AX_SRC_TYPE,
  axParameterBlockByteLength,
  renderAxVoiceReference,
} from "./browser_dsp_ax_voice_reference.mjs";

const NEW_PB_BYTES = 244;
const OLD_PB_BYTES = 236;

function physicalWord(logicalWord, ucodeHash) {
  if (
    ucodeHash === AX_OLD_UCODE_HASH
    && logicalWord >= AX_PB_WORD.LOW_PASS_FILTER_ON
    && logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_END
  ) {
    throw new Error("the old AX PB layout has no low-pass-filter words");
  }
  if (
    ucodeHash === AX_OLD_UCODE_HASH
    && logicalWord > AX_PB_WORD.LOW_PASS_FILTER_END
  ) {
    return logicalWord - 4;
  }
  return logicalWord;
}

function setWord(mram, physicalAddress, ucodeHash, logicalWord, value) {
  const offset =
    physicalAddress + physicalWord(logicalWord, ucodeHash) * 2;
  mram[offset] = (value >>> 8) & 0xff;
  mram[offset + 1] = value & 0xff;
}

function getWord(mram, physicalAddress, ucodeHash, logicalWord) {
  const offset =
    physicalAddress + physicalWord(logicalWord, ucodeHash) * 2;
  return (mram[offset] << 8) | mram[offset + 1];
}

function applyParameterBlockWrites(mram, writes) {
  const updated = new Uint8Array(mram);
  for (const write of writes) {
    assert.equal(write.data.length, write.byteLength);
    assert.ok(write.physicalAddress <= updated.length - write.byteLength);
    updated.set(write.data, write.physicalAddress);
  }
  return updated;
}

function setAddress(
  mram,
  physicalAddress,
  ucodeHash,
  highWord,
  lowWord,
  value,
) {
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    highWord,
    value >>> 16,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    lowWord,
    value & 0xffff,
  );
}

function writeBaseParameterBlock({
  mram,
  physicalAddress,
  guestAddress,
  ucodeHash,
  nextAddress = 0,
  sampleFormat,
  sourceType = AX_SRC_TYPE.NEAREST,
  sourceRatio = 0x0001_0000,
  sourceFraction = 0,
  sourceLastSamples = [0, 0, 0, 0],
  running = 1,
  isStream = 1,
  looping = 0,
  loopAddress = 0,
  currentAddress,
  endAddress,
  predictorScale = 0,
  yn1 = 0,
  yn2 = 0,
  loopPredictorScale = 0,
  loopYn1 = 0,
  loopYn2 = 0,
  gain = 0,
  volumeEnvelope = 0x7fff,
  volumeEnvelopeDelta = 0,
  mixerControl = ucodeHash === AX_OLD_UCODE_HASH ? 0 : 3,
  mainLeftVolume = 0x8000,
  mainLeftDelta = 0,
  mainRightVolume = 0x8000,
  mainRightDelta = 0,
}) {
  setAddress(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.NEXT_HIGH,
    AX_PB_WORD.NEXT_LOW,
    nextAddress,
  );
  setAddress(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.THIS_HIGH,
    AX_PB_WORD.THIS_LOW,
    guestAddress,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.SRC_TYPE,
    sourceType,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.MIXER_CONTROL,
    mixerControl,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.RUNNING,
    running,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.IS_STREAM,
    isStream,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.MAIN_LEFT_VOLUME,
    mainLeftVolume,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.MAIN_LEFT_DELTA,
    mainLeftDelta,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.MAIN_RIGHT_VOLUME,
    mainRightVolume,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.MAIN_RIGHT_DELTA,
    mainRightDelta,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.VOLUME_ENVELOPE_CURRENT,
    volumeEnvelope,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.VOLUME_ENVELOPE_DELTA,
    volumeEnvelopeDelta,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.SAMPLE_FORMAT,
    sampleFormat,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.LOOPING,
    looping,
  );
  setAddress(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.LOOP_ADDRESS_HIGH,
    AX_PB_WORD.LOOP_ADDRESS_LOW,
    loopAddress,
  );
  setAddress(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.END_ADDRESS_HIGH,
    AX_PB_WORD.END_ADDRESS_LOW,
    endAddress,
  );
  setAddress(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.CURRENT_ADDRESS_HIGH,
    AX_PB_WORD.CURRENT_ADDRESS_LOW,
    currentAddress,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.ADPCM_GAIN,
    gain,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.ADPCM_PREDICTOR_SCALE,
    predictorScale,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.ADPCM_YN1,
    yn1,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.ADPCM_YN2,
    yn2,
  );
  setAddress(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.SRC_RATIO_HIGH,
    AX_PB_WORD.SRC_RATIO_LOW,
    sourceRatio,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.SRC_CURRENT_FRACTION,
    sourceFraction,
  );
  for (let index = 0; index < sourceLastSamples.length; index += 1) {
    setWord(
      mram,
      physicalAddress,
      ucodeHash,
      AX_PB_WORD.SRC_LAST_SAMPLE_0 + index,
      sourceLastSamples[index],
    );
  }
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.ADPCM_LOOP_PREDICTOR_SCALE,
    loopPredictorScale,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.ADPCM_LOOP_YN1,
    loopYn1,
  );
  setWord(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.ADPCM_LOOP_YN2,
    loopYn2,
  );
}

function writePcm16(aram, sampleIndex, sample) {
  const value = sample & 0xffff;
  aram[sampleIndex * 2] = value >>> 8;
  aram[sampleIndex * 2 + 1] = value & 0xff;
}

function signed16(value) {
  const word = value & 0xffff;
  return word < 0x8000 ? word : word - 0x1_0000;
}

function expectedPcmRamp() {
  const expected = [];
  let envelope = 0x4000;
  let rightVolume = 0x4000;
  for (let frame = 0; frame < AX_REFERENCE_LIMITS.frames; frame += 1) {
    const enveloped = (20_000 * signed16(envelope)) >> 15;
    const right = (enveloped * rightVolume) >> 15;
    expected.push(right, enveloped);
    envelope = (envelope + 0x40) & 0xffff;
    rightVolume = (rightVolume + 0x20) & 0xffff;
  }
  return expected;
}

function successfulPcmRampFixture() {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  const physicalAddress = 0x200;
  const guestAddress = 0x8000_0200;
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, 20_000);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
    volumeEnvelope: 0x4000,
    volumeEnvelopeDelta: 0x0040,
    mixerControl: 0x000b,
    mainRightVolume: 0x4000,
    mainRightDelta: 0x0020,
  });
  return { aram, guestAddress, mram, physicalAddress };
}

function constantPcmFixture(sample) {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  const physicalAddress = 0x200;
  const guestAddress = 0x8000_0200;
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, sample);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
    volumeEnvelope: 0x4000,
    mixerControl: 0x0003,
  });
  return { aram, guestAddress, mram };
}

test("AX PB byte sizes pin both Dolphin GameCube layouts", () => {
  assert.equal(axParameterBlockByteLength(AX_OLD_UCODE_HASH), OLD_PB_BYTES);
  assert.equal(
    axParameterBlockByteLength(AX_FZERO_UCODE_HASH),
    NEW_PB_BYTES,
  );
});

test("old-layout DSP ADPCM renders a known 160-frame R/L buffer and writes history", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x200);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_OLD_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.DSP_ADPCM,
    currentAddress: 2,
    endAddress: 0x3ff,
    predictorScale: 0x000c,
  });

  for (let frame = 0; frame < 12; frame += 1) {
    const offset = frame * 8;
    aram[offset] = 0x0c;
    aram.set([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde], offset + 1);
  }

  const originalMram = new Uint8Array(mram);
  const expectedCycle = [
    4095,
    8191,
    12287,
    16383,
    20479,
    24575,
    28671,
    -32767,
    -28672,
    -24576,
    -20480,
    -16384,
    -12288,
    -8192,
  ];
  const expectedMono = Array.from(
    { length: AX_REFERENCE_LIMITS.frames },
    (_unused, index) => expectedCycle[index % expectedCycle.length],
  );
  const expectedInterleaved = expectedMono.flatMap(sample => [
    sample,
    sample,
  ]);

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_OLD_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.output.samples), expectedInterleaved);
  assert.deepEqual(mram, originalMram, "the pure reference mutated input MRAM");
  assert.equal("updatedMram" in result, false);
  assert.equal(result.parameterBlockWrites.length, 1);
  const [parameterBlockWrite] = result.parameterBlockWrites;
  assert.deepEqual(
    {
      logicalAddress: parameterBlockWrite.logicalAddress,
      physicalAddress: parameterBlockWrite.physicalAddress,
      byteLength: parameterBlockWrite.byteLength,
    },
    {
      logicalAddress: guestAddress,
      physicalAddress,
      byteLength: OLD_PB_BYTES,
    },
  );
  assert.equal(parameterBlockWrite.data.length, OLD_PB_BYTES);
  assert.notEqual(parameterBlockWrite.data.buffer, mram.buffer);
  const appliedMram = applyParameterBlockWrites(
    mram,
    result.parameterBlockWrites,
  );
  assert.notDeepEqual(appliedMram, originalMram);
  assert.deepEqual(result.writebacks, [
    {
      address: guestAddress,
      physicalAddress,
      running: 1,
      currentAddress: 184,
      predictorScale: 0x0c,
      yn1: 24_576,
      yn2: 20_480,
      sourceFraction: 0,
      lastSamples: [12_288, 16_384, 20_480, 24_576],
      volumeEnvelope: { current: 0x7fff, delta: 0 },
      mainLeft: { volume: 0x8000, delta: 0, dpop: 24_575 },
      mainRight: { volume: 0x8000, delta: 0, dpop: 24_575 },
      loopCounter: 0,
    },
  ]);
  assert.equal(
    getWord(
      appliedMram,
      physicalAddress,
      AX_OLD_UCODE_HASH,
      AX_PB_WORD.CURRENT_ADDRESS_LOW,
    ),
    184,
  );
  assert.deepEqual(
    {
      parameterBlockLayoutBytes:
        result.telemetry.parameterBlockLayoutBytes,
      parameterBlocks: result.telemetry.parameterBlocks,
      parameterBlockWriteBytes:
        result.telemetry.parameterBlockWriteBytes,
      initialMainBuffers: result.telemetry.initialMainBuffers,
      voicesProcessed: result.telemetry.voicesProcessed,
      adpcmVoices: result.telemetry.adpcmVoices,
      pcm16Voices: result.telemetry.pcm16Voices,
      sourceSampleReads: result.telemetry.sourceSampleReads,
      aramSamplesDecoded: result.telemetry.aramSamplesDecoded,
      frames: result.telemetry.frames,
      outputOrder: result.telemetry.outputOrder,
      outputBytes: result.telemetry.outputBytes,
      nonZeroSampleValues: result.telemetry.nonZeroSampleValues,
      clippedSampleValues: result.telemetry.clippedSampleValues,
      peakAbsoluteSample: result.telemetry.peakAbsoluteSample,
    },
    {
      parameterBlockLayoutBytes: OLD_PB_BYTES,
      parameterBlocks: 1,
      parameterBlockWriteBytes: OLD_PB_BYTES,
      initialMainBuffers: "zero",
      voicesProcessed: 1,
      adpcmVoices: 1,
      pcm16Voices: 0,
      sourceSampleReads: 160,
      aramSamplesDecoded: 160,
      frames: 160,
      outputOrder: "R,L",
      outputBytes: 640,
      nonZeroSampleValues: 320,
      clippedSampleValues: 0,
      peakAbsoluteSample: 32_767,
    },
  );
  assert.equal(result.telemetry.outputHash, "0x7826b591");
});

test("F-Zero-layout PCM16 applies volume ramps and emits exact big-endian R,L", () => {
  const {
    aram,
    guestAddress,
    mram,
    physicalAddress,
  } = successfulPcmRampFixture();
  const originalMram = new Uint8Array(mram);
  const originalAram = new Uint8Array(aram);
  const expected = expectedPcmRamp();

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.output.samples), expected);
  const outputView = new DataView(
    result.output.bytes.buffer,
    result.output.bytes.byteOffset,
    result.output.bytes.byteLength,
  );
  for (let frame = 0; frame < AX_REFERENCE_LIMITS.frames; frame += 1) {
    assert.equal(
      outputView.getInt16(frame * 4, false),
      expected[frame * 2],
      `frame ${frame} right`,
    );
    assert.equal(
      outputView.getInt16(frame * 4 + 2, false),
      expected[frame * 2 + 1],
      `frame ${frame} left`,
    );
  }
  assert.deepEqual(mram, originalMram);
  assert.deepEqual(aram, originalAram);
  assert.equal("updatedMram" in result, false);
  assert.deepEqual(
    result.parameterBlockWrites.map(write => ({
      logicalAddress: write.logicalAddress,
      physicalAddress: write.physicalAddress,
      byteLength: write.byteLength,
      aliasesInput: write.data.buffer === mram.buffer,
    })),
    [{
      logicalAddress: guestAddress,
      physicalAddress,
      byteLength: NEW_PB_BYTES,
      aliasesInput: false,
    }],
  );
  const appliedMram = applyParameterBlockWrites(
    mram,
    result.parameterBlockWrites,
  );
  assert.equal(
    getWord(
      appliedMram,
      physicalAddress,
      AX_FZERO_UCODE_HASH,
      AX_PB_WORD.CURRENT_ADDRESS_LOW,
    ),
    160,
  );
  assert.deepEqual(result.writebacks, [
    {
      address: guestAddress,
      physicalAddress,
      running: 1,
      currentAddress: 160,
      predictorScale: 0,
      yn1: 20_000,
      yn2: 20_000,
      sourceFraction: 0,
      lastSamples: [20_000, 20_000, 20_000, 20_000],
      volumeEnvelope: { current: 0x6800, delta: 0x40 },
      mainLeft: {
        volume: 0x8000,
        delta: 0,
        dpop: expected.at(-1),
      },
      mainRight: {
        volume: 0x5400,
        delta: 0x20,
        dpop: expected.at(-2),
      },
      loopCounter: 0,
    },
  ]);
  assert.equal(result.telemetry.ucodeHash, "0x07f88145");
  assert.equal(result.telemetry.pcm16Voices, 1);
  assert.equal(result.telemetry.nonZeroSampleValues, 320);
  assert.equal(result.telemetry.outputOrder, "R,L");
  assert.equal(result.telemetry.outputHash, "0x76504a96");
  assert.equal(result.telemetry.parameterBlockWriteBytes, NEW_PB_BYTES);
});

test("explicit main accumulators seed exact voice mixing without input mutation", () => {
  const {
    aram,
    guestAddress,
    mram,
  } = successfulPcmRampFixture();
  const initialMainLeft = Int32Array.from(
    { length: AX_REFERENCE_LIMITS.frames },
    (_unused, frame) => 1_000 + frame,
  );
  const initialMainRight = Int32Array.from(
    { length: AX_REFERENCE_LIMITS.frames },
    (_unused, frame) => -2_000 - frame,
  );
  const originalLeft = new Int32Array(initialMainLeft);
  const originalRight = new Int32Array(initialMainRight);
  const originalMram = new Uint8Array(mram);
  const voice = expectedPcmRamp();
  const expectedLeft = Int32Array.from(
    initialMainLeft,
    (sample, frame) => sample + voice[frame * 2 + 1],
  );
  const expectedRight = Int32Array.from(
    initialMainRight,
    (sample, frame) => sample + voice[frame * 2],
  );
  const expectedOutput = [];
  for (let frame = 0; frame < AX_REFERENCE_LIMITS.frames; frame += 1) {
    expectedOutput.push(expectedRight[frame], expectedLeft[frame]);
  }

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    initialMainLeft,
    initialMainRight,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mainAccumulators.frames, AX_REFERENCE_LIMITS.frames);
  assert.deepEqual(result.mainAccumulators.left, expectedLeft);
  assert.deepEqual(result.mainAccumulators.right, expectedRight);
  assert.deepEqual(Array.from(result.output.samples), expectedOutput);
  assert.deepEqual(initialMainLeft, originalLeft);
  assert.deepEqual(initialMainRight, originalRight);
  assert.deepEqual(mram, originalMram);
  assert.notEqual(result.mainAccumulators.left, initialMainLeft);
  assert.notEqual(result.mainAccumulators.right, initialMainRight);
  assert.notEqual(
    result.mainAccumulators.left.buffer,
    result.mainAccumulators.right.buffer,
  );
  assert.equal(result.telemetry.initialMainBuffers, "explicit");
  assert.equal(
    result.telemetry.initialMainBufferContract,
    "optional-int32x160-zero-default",
  );
});

test("main accumulator additions wrap as signed 32-bit before PCM clamping", () => {
  const fixtures = [
    {
      sample: 20_000,
      initial: 0x7fff_fff0,
      mixed: 10_000,
      final: (0x7fff_fff0 + 10_000) | 0,
      output: -0x8000,
    },
    {
      sample: -20_000,
      initial: -0x7fff_fff0,
      mixed: -10_000,
      final: (-0x7fff_fff0 - 10_000) | 0,
      output: 0x7fff,
    },
  ];

  for (const fixture of fixtures) {
    const {
      aram,
      guestAddress,
      mram,
    } = constantPcmFixture(fixture.sample);
    const initialMainLeft = new Int32Array(
      AX_REFERENCE_LIMITS.frames,
    ).fill(fixture.initial);
    const initialMainRight = new Int32Array(
      AX_REFERENCE_LIMITS.frames,
    ).fill(fixture.initial);

    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: guestAddress,
      ucodeHash: AX_FZERO_UCODE_HASH,
      initialMainLeft,
      initialMainRight,
    });

    assert.equal(result.ok, true);
    assert.ok(
      result.mainAccumulators.left.every(
        sample => sample === fixture.final,
      ),
      `left wrap for ${fixture.sample}`,
    );
    assert.ok(
      result.mainAccumulators.right.every(
        sample => sample === fixture.final,
      ),
      `right wrap for ${fixture.sample}`,
    );
    assert.ok(
      result.output.samples.every(sample => sample === fixture.output),
      `PCM clamp for ${fixture.sample}`,
    );
    assert.equal(result.writebacks[0].mainLeft.dpop, fixture.mixed);
    assert.equal(result.writebacks[0].mainRight.dpop, fixture.mixed);
    assert.equal(result.telemetry.clippedSampleValues, 320);
    assert.ok(
      initialMainLeft.every(sample => sample === fixture.initial),
    );
    assert.ok(
      initialMainRight.every(sample => sample === fixture.initial),
    );
  }
});

test("main accumulator results are fresh and inputs validate before rendering", () => {
  const mram = new Uint8Array(0x100);
  const aram = new Uint8Array(1);
  const initial = Int32Array.from(
    { length: AX_REFERENCE_LIMITS.frames },
    (_unused, frame) => frame - 80,
  );
  const input = {
    mram,
    aram,
    headAddress: 0,
    ucodeHash: AX_FZERO_UCODE_HASH,
    initialMainLeft: initial,
    initialMainRight: initial,
  };

  const first = renderAxVoiceReference(input);
  const second = renderAxVoiceReference(input);
  const defaulted = renderAxVoiceReference({
    mram,
    aram,
    headAddress: 0,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.mainAccumulators.left, initial);
  assert.deepEqual(first.mainAccumulators.right, initial);
  assert.notEqual(first.mainAccumulators.left.buffer, initial.buffer);
  assert.notEqual(first.mainAccumulators.right.buffer, initial.buffer);
  assert.notEqual(
    first.mainAccumulators.left.buffer,
    first.mainAccumulators.right.buffer,
  );
  assert.notEqual(
    first.mainAccumulators.left.buffer,
    second.mainAccumulators.left.buffer,
  );
  first.mainAccumulators.left[0] = 123_456;
  assert.equal(initial[0], -80);
  assert.equal(second.mainAccumulators.left[0], -80);
  assert.ok(defaulted.mainAccumulators.left.every(sample => sample === 0));
  assert.ok(defaulted.mainAccumulators.right.every(sample => sample === 0));
  assert.notEqual(
    defaulted.mainAccumulators.left.buffer,
    defaulted.mainAccumulators.right.buffer,
  );
  assert.equal(defaulted.telemetry.initialMainBuffers, "zero");
  assert.deepEqual(mram, new Uint8Array(0x100));
  assert.equal("updatedMram" in first, false);
  assert.deepEqual(first.parameterBlockWrites, []);

  const beforeInvalid = new Uint8Array(mram);
  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialMainLeft: new Uint32Array(AX_REFERENCE_LIMITS.frames),
    }),
    {
      name: "TypeError",
      message: "initialMainLeft must be an Int32Array",
    },
  );
  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialMainRight: new Int32Array(AX_REFERENCE_LIMITS.frames - 1),
    }),
    {
      name: "RangeError",
      message: "initialMainRight must contain exactly 160 samples",
    },
  );
  assert.deepEqual(mram, beforeInvalid);
  assert.deepEqual(initial, Int32Array.from(
    { length: AX_REFERENCE_LIMITS.frames },
    (_unused, frame) => frame - 80,
  ));
});

test("all three explicit PCM16 gain scales render and mask PB predictor state", () => {
  const fixtures = [
    {
      format: AX_SAMPLE_FORMAT.PCM16_GAIN_SCALE_2048,
      gain: 0x0800,
      decoded: 12_000,
      output: 11_999,
    },
    {
      format: AX_SAMPLE_FORMAT.PCM16_GAIN_SCALE_1,
      gain: 1,
      decoded: 12_000,
      output: 11_999,
    },
    {
      format: AX_SAMPLE_FORMAT.PCM16_GAIN_SCALE_65536,
      gain: 0x7fff,
      decoded: 5_999,
      output: 5_998,
    },
  ];

  for (const fixture of fixtures) {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(0x400);
    for (let index = 0; index < 0x200; index += 1) {
      writePcm16(aram, index, 12_000);
    }
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x100,
      guestAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      sampleFormat: fixture.format,
      currentAddress: 0,
      endAddress: 0x1ff,
      predictorScale: 0x0080,
      gain: fixture.gain,
    });

    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
    });

    assert.equal(result.ok, true, `format 0x${fixture.format.toString(16)}`);
    assert.deepEqual(
      Array.from(result.output.samples.slice(0, 2)),
      [fixture.output, fixture.output],
    );
    assert.equal(result.writebacks[0].predictorScale, 0);
    assert.equal(result.writebacks[0].yn1, fixture.decoded);
    assert.equal(result.writebacks[0].yn2, fixture.decoded);
    assert.equal(result.telemetry.pcm16Voices, 1);
  }
});

test("DSP ADPCM uses non-zero coefficients and carried history", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x200);
  const physicalAddress = 0x100;
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.DSP_ADPCM,
    currentAddress: 2,
    endAddress: 0x3ff,
    predictorScale: 0x0010,
    yn1: 1_000,
    yn2: -500,
  });
  setWord(
    mram,
    physicalAddress,
    AX_FZERO_UCODE_HASH,
    AX_PB_WORD.ADPCM_COEFFICIENT_0 + 2,
    0x0800,
  );
  for (let frame = 0; frame < 12; frame += 1) {
    aram[frame * 8] = 0x10;
  }

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.ok(result.output.samples.every(sample => sample === 999));
  assert.equal(result.writebacks[0].yn1, 1_000);
  assert.equal(result.writebacks[0].yn2, 1_000);
  assert.equal(result.writebacks[0].predictorScale, 0x10);
});

test("stream loops restore masked predictor state and non-loops stop cleanly", () => {
  const aram = new Uint8Array(8);
  [1_000, 2_000, 3_000, 4_000].forEach(
    (sample, index) => writePcm16(aram, index, sample),
  );

  const loopingMram = new Uint8Array(0x1000);
  writeBaseParameterBlock({
    mram: loopingMram,
    physicalAddress: 0x100,
    guestAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    looping: 1,
    loopAddress: 0,
    currentAddress: 0,
    endAddress: 3,
    predictorScale: 0x0080,
    loopPredictorScale: 0x0080,
    gain: 0x0800,
  });
  const looping = renderAxVoiceReference({
    mram: loopingMram,
    aram,
    headAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });
  assert.equal(looping.ok, true);
  assert.deepEqual(
    Array.from(looping.output.samples.slice(0, 16)),
    [
      999, 999,
      1_999, 1_999,
      2_999, 2_999,
      3_999, 3_999,
      999, 999,
      1_999, 1_999,
      2_999, 2_999,
      3_999, 3_999,
    ],
  );
  assert.equal(looping.writebacks[0].running, 1);
  assert.equal(looping.writebacks[0].currentAddress, 0);
  assert.equal(looping.writebacks[0].predictorScale, 0);
  assert.equal(looping.writebacks[0].loopCounter, 40);
  assert.equal(looping.telemetry.loops, 40);
  assert.equal(looping.telemetry.aramWrappedReads, 0);

  const oneShotMram = new Uint8Array(0x1000);
  writeBaseParameterBlock({
    mram: oneShotMram,
    physicalAddress: 0x100,
    guestAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    currentAddress: 0,
    endAddress: 3,
    gain: 0x0800,
  });
  const oneShot = renderAxVoiceReference({
    mram: oneShotMram,
    aram,
    headAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });
  assert.equal(oneShot.ok, true);
  assert.deepEqual(
    Array.from(oneShot.output.samples.slice(0, 12)),
    [
      999, 999,
      1_999, 1_999,
      2_999, 2_999,
      3_999, 3_999,
      0, 0,
      0, 0,
    ],
  );
  assert.equal(oneShot.writebacks[0].running, 0);
  assert.equal(oneShot.writebacks[0].currentAddress, 0);
  assert.equal(oneShot.telemetry.sourceSampleReads, 32);
  assert.equal(oneShot.telemetry.aramSamplesDecoded, 4);
  assert.equal(oneShot.telemetry.loops, 0);
});

test("ARAM sample reads wrap through the power-of-two hardware mask", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(8);
  [1_000, 2_000, 3_000, 4_000].forEach(
    (sample, index) => writePcm16(aram, index, sample),
  );
  writeBaseParameterBlock({
    mram,
    physicalAddress: 0x100,
    guestAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    currentAddress: 3,
    endAddress: 0x1ff,
    gain: 0x0800,
  });

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    Array.from(result.output.samples.slice(0, 16)),
    [
      3_999, 3_999,
      999, 999,
      1_999, 1_999,
      2_999, 2_999,
      3_999, 3_999,
      999, 999,
      1_999, 1_999,
      2_999, 2_999,
    ],
  );
  assert.equal(result.writebacks[0].currentAddress, 163);
  assert.equal(result.telemetry.aramWrappedReads, 318);
});

test("a bounded aliased PB chain mixes voices and clamps final output", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, 30_000);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress: 0x100,
    guestAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    nextAddress: 0x4000_0300,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });
  writeBaseParameterBlock({
    mram,
    physicalAddress: 0x300,
    guestAddress: 0x4000_0300,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.ok(
    result.output.samples.every(sample => sample === 0x7fff),
  );
  assert.deepEqual(
    result.writebacks.map(writeback => [
      writeback.physicalAddress,
      writeback.currentAddress,
    ]),
    [[0x100, 160], [0x300, 160]],
  );
  assert.equal(result.telemetry.parameterBlocks, 2);
  assert.equal(result.parameterBlockWrites.length, 2);
  assert.deepEqual(
    result.parameterBlockWrites.map(write => [
      write.logicalAddress,
      write.physicalAddress,
      write.byteLength,
    ]),
    [
      [0x8000_0100, 0x100, NEW_PB_BYTES],
      [0x4000_0300, 0x300, NEW_PB_BYTES],
    ],
  );
  assert.notEqual(
    result.parameterBlockWrites[0].data.buffer,
    result.parameterBlockWrites[1].data.buffer,
  );
  assert.equal(result.telemetry.voicesProcessed, 2);
  assert.equal(result.telemetry.pcm16Voices, 2);
  assert.equal(result.telemetry.clippedSampleValues, 320);
  assert.equal(result.telemetry.peakAbsoluteSample, 0x7fff);
});

test("fractional polyphase requests use the coefficient-free linear fallback", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, (index + 1) * 100);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress: 0x100,
    guestAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    sourceType: AX_SRC_TYPE.POLYPHASE,
    sourceRatio: 0x0000_8000,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.polyphaseFallbackSubframes, 5);
  assert.equal(result.telemetry.sourceSampleReads, 80);
  assert.equal(result.writebacks[0].currentAddress, 80);
  assert.deepEqual(result.writebacks[0].lastSamples, [
    7_700,
    7_800,
    7_900,
    8_000,
  ]);
  assert.deepEqual(
    Array.from(result.output.samples.slice(0, 24)),
    [
      0, 0,
      0, 0,
      0, 0,
      0, 0,
      0, 0,
      0, 0,
      49, 49,
      99, 99,
      149, 149,
      199, 199,
      249, 249,
      299, 299,
    ],
  );
});

test("stopped PB updates and unsupported mixer routes reject before writeback", () => {
  {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(4);
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x100,
      guestAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 1,
      gain: 0x0800,
    });
    setWord(
      mram,
      0x100,
      AX_FZERO_UCODE_HASH,
      AX_PB_WORD.UPDATE_COUNT_0,
      1,
    );
    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      reason: "unsupported-parameter-block-updates",
      parameterBlock: 0x8000_0100,
      millisecond: 0,
      count: 1,
    });
    assert.equal("parameterBlockWrites" in result, false);
  }

  for (const fixture of [
    {
      ucodeHash: AX_OLD_UCODE_HASH,
      mixerControl: 0x0010,
      supportedMask: 0x0008,
    },
    {
      ucodeHash: AX_FZERO_UCODE_HASH,
      mixerControl: 0x0013,
      supportedMask: 0x000b,
    },
  ]) {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(4);
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x100,
      guestAddress: 0x8000_0100,
      ucodeHash: fixture.ucodeHash,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 1,
      gain: 0x0800,
      mixerControl: fixture.mixerControl,
    });
    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: fixture.ucodeHash,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      reason: "unsupported-mixer-control",
      parameterBlock: 0x8000_0100,
      mixerControl: fixture.mixerControl,
      unsupportedBits: 0x0010,
      supportedMask: fixture.supportedMask,
    });
    assert.equal("parameterBlockWrites" in result, false);
    assert.equal("output" in result, false);
  }
});

test("cycles, PB budgets, and invalid formats reject transactionally", () => {
  {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(0x400);
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x100,
      guestAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      nextAddress: 0xc000_0100,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      currentAddress: 0,
      endAddress: 0x1ff,
      gain: 0x0800,
    });
    const before = new Uint8Array(mram);
    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
    });
    assert.deepEqual(result, {
      ok: false,
      error: {
        reason: "parameter-block-cycle",
        address: 0xc000_0100,
        physicalAddress: 0x100,
      },
    });
    assert.equal("parameterBlockWrites" in result, false);
    assert.equal("output" in result, false);
    assert.deepEqual(mram, before);
  }

  {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(0x400);
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x100,
      guestAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      nextAddress: 0x8000_0300,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      currentAddress: 0,
      endAddress: 0x1ff,
      gain: 0x0800,
    });
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x300,
      guestAddress: 0x8000_0300,
      ucodeHash: AX_FZERO_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      currentAddress: 0,
      endAddress: 0x1ff,
      gain: 0x0800,
    });
    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      maximumParameterBlocks: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, "parameter-block-limit");
    assert.equal("parameterBlockWrites" in result, false);
    assert.equal("writebacks" in result, false);
  }

  {
    const {
      aram,
      guestAddress,
      mram,
      physicalAddress,
    } = successfulPcmRampFixture();
    setWord(
      mram,
      physicalAddress,
      AX_FZERO_UCODE_HASH,
      AX_PB_WORD.SAMPLE_FORMAT,
      0x0019,
    );
    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: guestAddress,
      ucodeHash: AX_FZERO_UCODE_HASH,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, "unsupported-sample-format");
    assert.equal("output" in result, false);
  }

});

test("identical inputs produce identical PCM, writeback, and telemetry hashes", () => {
  const {
    aram,
    guestAddress,
    mram,
  } = successfulPcmRampFixture();
  const first = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });
  const second = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.output.samples, second.output.samples);
  assert.deepEqual(first.output.bytes, second.output.bytes);
  assert.deepEqual(first.parameterBlockWrites, second.parameterBlockWrites);
  assert.notEqual(
    first.parameterBlockWrites[0].data.buffer,
    second.parameterBlockWrites[0].data.buffer,
  );
  assert.deepEqual(first.writebacks, second.writebacks);
  assert.deepEqual(first.telemetry, second.telemetry);
});
