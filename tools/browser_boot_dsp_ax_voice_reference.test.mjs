#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  AX_FZERO_UCODE_HASH,
  AX_MIXER_CONTROL,
  AX_OLD_UCODE_HASH,
  AX_PB_WORD,
  AX_REFERENCE_LIMITS,
  AX_SAMPLE_FORMAT,
  AX_SRC_TYPE,
  axParameterBlockByteLength,
  axParameterBlockDmaByteLength,
  renderAxVoiceReference,
} from "./browser_dsp_ax_voice_reference.mjs";

const NEW_PB_BYTES = 244;
const FZERO_PB_BYTES = 0xec;
const FZERO_DMA_BYTES = 0xd0;
const OLD_PB_BYTES = 0xc0;
const WARIO_UCODE_HASH = 0xe213_6399;

function physicalWord(logicalWord, ucodeHash) {
  if (ucodeHash === AX_OLD_UCODE_HASH) {
    if (
      logicalWord >= AX_PB_WORD.LOW_PASS_FILTER_ON
      && logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_END
    ) {
      throw new Error("the old AX PB layout has no low-pass-filter words");
    }
    if (logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_END) return logicalWord;
    return logicalWord - 4;
  }
  if (ucodeHash === AX_FZERO_UCODE_HASH) {
    if (logicalWord <= AX_PB_WORD.LOW_PASS_FILTER_ON) return logicalWord;
    if (logicalWord === AX_PB_WORD.LOOP_COUNTER) return 103;
    throw new Error("F-Zero does not DMA this semantic AX PB word");
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

function readBigEndianWord(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
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

function writeParameterBlockUpdates({
  mram,
  physicalAddress,
  ucodeHash,
  counts,
  tableAddress,
  updates,
}) {
  assert.equal(counts.length, AX_REFERENCE_LIMITS.milliseconds);
  assert.ok(
    updates.length <= AX_REFERENCE_LIMITS.maximumParameterBlockUpdates,
  );
  for (let index = 0; index < counts.length; index += 1) {
    setWord(
      mram,
      physicalAddress,
      ucodeHash,
      AX_PB_WORD.UPDATE_COUNT_0 + index,
      counts[index],
    );
  }
  setAddress(
    mram,
    physicalAddress,
    ucodeHash,
    AX_PB_WORD.UPDATE_DATA_HIGH,
    AX_PB_WORD.UPDATE_DATA_LOW,
    tableAddress,
  );

  const tablePhysicalAddress = tableAddress & 0x3fff_ffff;
  for (let index = 0; index < updates.length; index += 1) {
    const update = updates[index];
    const offset = tablePhysicalAddress + index * 4;
    mram[offset] = (update.offset >>> 8) & 0xff;
    mram[offset + 1] = update.offset & 0xff;
    mram[offset + 2] = (update.value >>> 8) & 0xff;
    mram[offset + 3] = update.value & 0xff;
  }
}

function signed16(value) {
  const word = value & 0xffff;
  return word < 0x8000 ? word : word - 0x1_0000;
}

const NINE_MIX_ROUTES = Object.freeze([
  {
    name: "main.left",
    bus: "main",
    channel: "left",
    enableBit: AX_MIXER_CONTROL.MAIN_LEFT,
    rampBit: AX_MIXER_CONTROL.MAIN_RAMP,
    volumeWord: AX_PB_WORD.MAIN_LEFT_VOLUME,
    deltaWord: AX_PB_WORD.MAIN_LEFT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_MAIN_LEFT,
  },
  {
    name: "main.right",
    bus: "main",
    channel: "right",
    enableBit: AX_MIXER_CONTROL.MAIN_RIGHT,
    rampBit: AX_MIXER_CONTROL.MAIN_RAMP,
    volumeWord: AX_PB_WORD.MAIN_RIGHT_VOLUME,
    deltaWord: AX_PB_WORD.MAIN_RIGHT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_MAIN_RIGHT,
  },
  {
    name: "main.surround",
    bus: "main",
    channel: "surround",
    enableBit: AX_MIXER_CONTROL.MAIN_SURROUND,
    rampBit: AX_MIXER_CONTROL.MAIN_RAMP,
    volumeWord: AX_PB_WORD.MAIN_SURROUND_VOLUME,
    deltaWord: AX_PB_WORD.MAIN_SURROUND_DELTA,
    dpopWord: AX_PB_WORD.DPOP_MAIN_SURROUND,
  },
  {
    name: "auxA.left",
    bus: "auxA",
    channel: "left",
    enableBit: AX_MIXER_CONTROL.AUXA_LEFT,
    rampBit: AX_MIXER_CONTROL.AUXA_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXA_LEFT_VOLUME,
    deltaWord: AX_PB_WORD.AUXA_LEFT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXA_LEFT,
  },
  {
    name: "auxA.right",
    bus: "auxA",
    channel: "right",
    enableBit: AX_MIXER_CONTROL.AUXA_RIGHT,
    rampBit: AX_MIXER_CONTROL.AUXA_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXA_RIGHT_VOLUME,
    deltaWord: AX_PB_WORD.AUXA_RIGHT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXA_RIGHT,
  },
  {
    name: "auxA.surround",
    bus: "auxA",
    channel: "surround",
    enableBit: AX_MIXER_CONTROL.AUXA_SURROUND,
    rampBit: AX_MIXER_CONTROL.AUXA_SURROUND_RAMP,
    volumeWord: AX_PB_WORD.AUXA_SURROUND_VOLUME,
    deltaWord: AX_PB_WORD.AUXA_SURROUND_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXA_SURROUND,
  },
  {
    name: "auxB.left",
    bus: "auxB",
    channel: "left",
    enableBit: AX_MIXER_CONTROL.AUXB_LEFT,
    rampBit: AX_MIXER_CONTROL.AUXB_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXB_LEFT_VOLUME,
    deltaWord: AX_PB_WORD.AUXB_LEFT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXB_LEFT,
  },
  {
    name: "auxB.right",
    bus: "auxB",
    channel: "right",
    enableBit: AX_MIXER_CONTROL.AUXB_RIGHT,
    rampBit: AX_MIXER_CONTROL.AUXB_LEFT_RIGHT_RAMP,
    volumeWord: AX_PB_WORD.AUXB_RIGHT_VOLUME,
    deltaWord: AX_PB_WORD.AUXB_RIGHT_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXB_RIGHT,
  },
  {
    name: "auxB.surround",
    bus: "auxB",
    channel: "surround",
    enableBit: AX_MIXER_CONTROL.AUXB_SURROUND,
    rampBit: AX_MIXER_CONTROL.AUXB_SURROUND_RAMP,
    volumeWord: AX_PB_WORD.AUXB_SURROUND_VOLUME,
    deltaWord: AX_PB_WORD.AUXB_SURROUND_DELTA,
    dpopWord: AX_PB_WORD.DPOP_AUXB_SURROUND,
  },
]);

function makeInitialAccumulators(valueForPlane = () => 0) {
  const result = { frames: AX_REFERENCE_LIMITS.frames };
  let planeIndex = 0;
  for (const bus of ["main", "auxA", "auxB"]) {
    result[bus] = {};
    for (const channel of ["left", "right", "surround"]) {
      result[bus][channel] = new Int32Array(
        AX_REFERENCE_LIMITS.frames,
      ).fill(valueForPlane(planeIndex, bus, channel));
      planeIndex += 1;
    }
  }
  return result;
}

function collectAccumulatorPlanes(accumulators) {
  return NINE_MIX_ROUTES.map(
    route => accumulators[route.bus][route.channel],
  );
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

test("AX PB byte sizes pin the Melee, F-Zero, and full newer layouts", () => {
  assert.equal(axParameterBlockByteLength(AX_OLD_UCODE_HASH), OLD_PB_BYTES);
  assert.equal(
    axParameterBlockByteLength(AX_FZERO_UCODE_HASH),
    FZERO_PB_BYTES,
  );
  assert.equal(axParameterBlockByteLength(WARIO_UCODE_HASH), NEW_PB_BYTES);
  assert.equal(
    axParameterBlockDmaByteLength(AX_OLD_UCODE_HASH),
    OLD_PB_BYTES,
  );
  assert.equal(
    axParameterBlockDmaByteLength(AX_FZERO_UCODE_HASH),
    FZERO_DMA_BYTES,
  );
  assert.equal(
    axParameterBlockDmaByteLength(WARIO_UCODE_HASH),
    NEW_PB_BYTES,
  );
  assert.equal(FZERO_PB_BYTES * 64, 0x3b00);
  assert.equal(FZERO_PB_BYTES - FZERO_DMA_BYTES, 0x1c);
  assert.equal(AX_REFERENCE_LIMITS.logicalParameterBlockWords, 122);
  assert.equal(AX_REFERENCE_LIMITS.maximumParameterBlockUpdates, 32);
  assert.equal(AX_REFERENCE_LIMITS.parameterBlockUpdateBytes, 128);
  assert.equal(AX_PB_WORD.UPDATE_COUNT_0, 34);
  assert.equal(AX_PB_WORD.UPDATE_COUNT_4, 38);
  assert.equal(AX_PB_WORD.UPDATE_DATA_HIGH, 39);
  assert.equal(AX_PB_WORD.UPDATE_DATA_LOW, 40);
});

test("Melee old-layout AXPBs traverse at the retail 0xc0 stride", () => {
  const mram = new Uint8Array(0x800);
  const aram = new Uint8Array(4);
  const firstPhysical = 0x100;
  const secondPhysical = firstPhysical + OLD_PB_BYTES;
  const firstAddress = 0x8000_0100;
  const secondAddress = 0x8000_01c0;

  for (const [physicalAddress, guestAddress, nextAddress] of [
    [firstPhysical, firstAddress, secondAddress],
    [secondPhysical, secondAddress, 0],
  ]) {
    writeBaseParameterBlock({
      mram,
      physicalAddress,
      guestAddress,
      nextAddress,
      ucodeHash: AX_OLD_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 1,
      gain: 0x0800,
    });
  }

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: firstAddress,
    ucodeHash: AX_OLD_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.parameterBlocks, 2);
  assert.equal(
    result.telemetry.parameterBlockWriteBytes,
    OLD_PB_BYTES * 2,
  );
  assert.deepEqual(
    result.parameterBlockWrites.map(write => ({
      logicalAddress: write.logicalAddress,
      physicalAddress: write.physicalAddress,
      byteLength: write.byteLength,
    })),
    [
      {
        logicalAddress: firstAddress,
        physicalAddress: firstPhysical,
        byteLength: OLD_PB_BYTES,
      },
      {
        logicalAddress: secondAddress,
        physicalAddress: secondPhysical,
        byteLength: OLD_PB_BYTES,
      },
    ],
  );
  const applied = applyParameterBlockWrites(
    mram,
    result.parameterBlockWrites,
  );
  assert.equal(
    getWord(
      applied,
      secondPhysical,
      AX_OLD_UCODE_HASH,
      AX_PB_WORD.THIS_LOW,
    ),
    secondAddress & 0xffff,
  );
});

test("F-Zero AXPBs traverse at the live 0xec retail stride", () => {
  const mram = new Uint8Array(0x170000);
  const aram = new Uint8Array(4);
  const firstPhysical = 0x0016_4d60;
  const secondPhysical = firstPhysical + FZERO_PB_BYTES;
  const firstAddress = 0x8016_4d60;
  const secondAddress = 0x8016_4e4c;

  for (const [physicalAddress, guestAddress, nextAddress] of [
    [firstPhysical, firstAddress, secondAddress],
    [secondPhysical, secondAddress, 0],
  ]) {
    writeBaseParameterBlock({
      mram,
      physicalAddress,
      guestAddress,
      nextAddress,
      ucodeHash: AX_FZERO_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 1,
      gain: 0x0800,
    });
    mram.fill(
      0xa5,
      physicalAddress + FZERO_DMA_BYTES,
      physicalAddress + FZERO_PB_BYTES,
    );
    mram.fill(0x5a, physicalAddress + 94 * 2, physicalAddress + 103 * 2);
  }

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: firstAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.parameterBlocks, 2);
  assert.equal(
    result.telemetry.parameterBlockWriteBytes,
    FZERO_DMA_BYTES * 2,
  );
  assert.deepEqual(
    result.parameterBlockWrites.map(write => [
      write.logicalAddress,
      write.physicalAddress,
      write.byteLength,
    ]),
    [
      [firstAddress, firstPhysical, FZERO_DMA_BYTES],
      [secondAddress, secondPhysical, FZERO_DMA_BYTES],
    ],
  );
  const applied = applyParameterBlockWrites(
    mram,
    result.parameterBlockWrites,
  );
  for (const physicalAddress of [firstPhysical, secondPhysical]) {
    assert.deepEqual(
      applied.subarray(
        physicalAddress + FZERO_DMA_BYTES,
        physicalAddress + FZERO_PB_BYTES,
      ),
      new Uint8Array(FZERO_PB_BYTES - FZERO_DMA_BYTES).fill(0xa5),
    );
    assert.deepEqual(
      applied.subarray(physicalAddress + 94 * 2, physicalAddress + 103 * 2),
      new Uint8Array(9 * 2).fill(0x5a),
    );
  }
});

test("full 244-byte AXPBs still reject a 0xec overlap", () => {
  const mram = new Uint8Array(0x800);
  const aram = new Uint8Array(4);
  const firstPhysical = 0x100;
  const secondPhysical = firstPhysical + FZERO_PB_BYTES;
  const firstAddress = 0x8000_0100;
  const secondAddress = firstAddress + FZERO_PB_BYTES;

  for (const [physicalAddress, guestAddress, nextAddress] of [
    [firstPhysical, firstAddress, secondAddress],
    [secondPhysical, secondAddress, 0],
  ]) {
    writeBaseParameterBlock({
      mram,
      physicalAddress,
      guestAddress,
      nextAddress,
      ucodeHash: WARIO_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 1,
      gain: 0x0800,
    });
  }

  assert.deepEqual(
    renderAxVoiceReference({
      mram,
      aram,
      headAddress: firstAddress,
      ucodeHash: WARIO_UCODE_HASH,
    }),
    {
      ok: false,
      error: {
        reason: "parameter-block-overlap",
        address: secondAddress,
        physicalAddress: secondPhysical,
        conflictingAddress: firstAddress,
        conflictingPhysicalAddress: firstPhysical,
      },
    },
  );
});

test("F-Zero filter enable is physical word 93 and loop counter is 103", () => {
  const mram = new Uint8Array(0x800);
  const aram = new Uint8Array(4);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 1,
    currentAddress: 0,
    endAddress: 1,
    gain: 0x0800,
  });
  setWord(
    mram,
    physicalAddress,
    AX_FZERO_UCODE_HASH,
    AX_PB_WORD.LOW_PASS_FILTER_ON,
    1,
  );

  assert.deepEqual(
    renderAxVoiceReference({
      mram,
      aram,
      headAddress: guestAddress,
      ucodeHash: AX_FZERO_UCODE_HASH,
    }),
    {
      ok: false,
      error: {
        reason: "unsupported-low-pass-filter",
        parameterBlock: guestAddress,
      },
    },
  );
  assert.equal(
    physicalWord(AX_PB_WORD.LOOP_COUNTER, AX_FZERO_UCODE_HASH),
    103,
  );
});

test("newer-GC PB mixer, DPOP, and control bits pin Dolphin word order", () => {
  assert.deepEqual(
    NINE_MIX_ROUTES.map(route => [
      route.name,
      route.volumeWord,
      route.deltaWord,
      route.dpopWord,
    ]),
    [
      ["main.left", 9, 10, 41],
      ["main.right", 11, 12, 44],
      ["main.surround", 23, 24, 47],
      ["auxA.left", 13, 14, 42],
      ["auxA.right", 15, 16, 45],
      ["auxA.surround", 25, 26, 48],
      ["auxB.left", 17, 18, 43],
      ["auxB.right", 19, 20, 46],
      ["auxB.surround", 21, 22, 49],
    ],
  );
  assert.deepEqual(AX_MIXER_CONTROL, {
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

test("old-layout mixer control pins AUX and DPL2 route conversion", () => {
  const routeCases = [
    [0x0000, ["main.left", "main.right"]],
    [0x0001, ["main.left", "main.right", "auxA.left", "auxA.right"]],
    [0x0002, ["main.left", "main.right", "auxB.left", "auxB.right"]],
    [0x0004, ["main.left", "main.right", "main.surround"]],
    [
      0x0005,
      [
        "main.left",
        "main.right",
        "main.surround",
        "auxA.left",
        "auxA.right",
        "auxA.surround",
      ],
    ],
    [
      0x0006,
      [
        "main.left",
        "main.right",
        "main.surround",
        "auxB.left",
        "auxB.right",
        "auxB.surround",
      ],
    ],
    [0x0010, ["main.left", "main.right", "auxB.left", "auxB.right"]],
    [
      0x0011,
      [
        "main.left",
        "main.right",
        "auxA.left",
        "auxA.right",
        "auxA.surround",
        "auxB.left",
        "auxB.right",
      ],
    ],
    [0x0012, ["main.left", "main.right"]],
  ];

  for (const [mixerControl, enabledRoutes] of routeCases) {
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
      ucodeHash: AX_OLD_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      currentAddress: 0,
      endAddress: 0x1ff,
      gain: 0x0800,
      volumeEnvelope: 0x4000,
      mixerControl,
    });
    for (const route of NINE_MIX_ROUTES) {
      setWord(
        mram,
        physicalAddress,
        AX_OLD_UCODE_HASH,
        route.volumeWord,
        0x8000,
      );
    }

    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: guestAddress,
      ucodeHash: AX_OLD_UCODE_HASH,
    });

    assert.equal(result.ok, true, `mixer control 0x${mixerControl.toString(16)}`);
    const expected = new Set(enabledRoutes);
    for (const route of NINE_MIX_ROUTES) {
      const plane = result.accumulators[route.bus][route.channel];
      const active = expected.has(route.name);
      assert.ok(
        plane.every(sample => sample === (active ? 10_000 : 0)),
        `0x${mixerControl.toString(16)} -> ${route.name}`,
      );
    }
  }
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
      byteLength: FZERO_DMA_BYTES,
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
  assert.equal(result.telemetry.parameterBlockWriteBytes, FZERO_DMA_BYTES);
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

test("newer-GC voices mix and ramp nine independent wrapping accumulators", () => {
  const { aram, guestAddress, mram } = constantPcmFixture(20_000);
  const physicalAddress = 0x200;
  const initialAccumulators = makeInitialAccumulators(
    plane => 0x7fff_f000 + plane * 0x100,
  );
  const originalPlanes = collectAccumulatorPlanes(initialAccumulators).map(
    plane => new Int32Array(plane),
  );
  const routes = NINE_MIX_ROUTES.map((route, plane) => ({
    ...route,
    startVolume: 0x1800 + plane * 0x0500,
    delta: plane + 1,
  }));

  setWord(
    mram,
    physicalAddress,
    AX_FZERO_UCODE_HASH,
    AX_PB_WORD.MIXER_CONTROL,
    0x7fff,
  );
  for (const route of routes) {
    setWord(
      mram,
      physicalAddress,
      AX_FZERO_UCODE_HASH,
      route.volumeWord,
      route.startVolume,
    );
    setWord(
      mram,
      physicalAddress,
      AX_FZERO_UCODE_HASH,
      route.deltaWord,
      route.delta,
    );
    setWord(
      mram,
      physicalAddress,
      AX_FZERO_UCODE_HASH,
      route.dpopWord,
      0x7000 + route.delta,
    );
  }

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    initialAccumulators,
  });

  assert.equal(result.ok, true);
  assert.equal(result.accumulators.frames, AX_REFERENCE_LIMITS.frames);
  assert.equal(result.mainAccumulators.frames, AX_REFERENCE_LIMITS.frames);
  assert.strictEqual(
    result.mainAccumulators.left,
    result.accumulators.main.left,
  );
  assert.strictEqual(
    result.mainAccumulators.right,
    result.accumulators.main.right,
  );

  const resultPlanes = collectAccumulatorPlanes(result.accumulators);
  assert.equal(
    new Set(resultPlanes.map(plane => plane.buffer)).size,
    AX_REFERENCE_LIMITS.accumulatorPlanes,
  );
  for (let plane = 0; plane < routes.length; plane += 1) {
    const route = routes[plane];
    const resultPlane = resultPlanes[plane];
    const inputPlane = collectAccumulatorPlanes(initialAccumulators)[plane];
    assert.notEqual(resultPlane.buffer, inputPlane.buffer, route.name);
    assert.deepEqual(inputPlane, originalPlanes[plane], `${route.name} input`);
    for (let frame = 0; frame < AX_REFERENCE_LIMITS.frames; frame += 1) {
      const volume = (route.startVolume + frame * route.delta) & 0xffff;
      const mixed = Math.max(
        -0x8000,
        Math.min(0x7fff, (10_000 * volume) >> 15),
      );
      assert.equal(
        resultPlane[frame],
        (inputPlane[frame] + mixed) | 0,
        `${route.name} frame ${frame}`,
      );
    }
  }

  const appliedMram = applyParameterBlockWrites(
    mram,
    result.parameterBlockWrites,
  );
  for (const route of routes) {
    const lastVolume = (
      route.startVolume
      + (AX_REFERENCE_LIMITS.frames - 1) * route.delta
    ) & 0xffff;
    const expectedDpop = Math.max(
      -0x8000,
      Math.min(0x7fff, (10_000 * lastVolume) >> 15),
    );
    assert.equal(
      getWord(
        appliedMram,
        physicalAddress,
        AX_FZERO_UCODE_HASH,
        route.volumeWord,
      ),
      (route.startVolume + AX_REFERENCE_LIMITS.frames * route.delta)
        & 0xffff,
      `${route.name} volume writeback`,
    );
    assert.equal(
      signed16(getWord(
        appliedMram,
        physicalAddress,
        AX_FZERO_UCODE_HASH,
        route.dpopWord,
      )),
      expectedDpop,
      `${route.name} DPOP writeback`,
    );
  }
  assert.equal(result.telemetry.initialAccumulators, "nested");
  assert.equal(result.telemetry.accumulatorPlanes, 9);
  assert.equal(
    result.telemetry.initialAccumulatorContract,
    "optional-complete-nine-plane-int32x160-zero-default",
  );
});

test("each newer-GC mixer enable bit selects only its exact plane", () => {
  for (const selected of NINE_MIX_ROUTES) {
    const { aram, guestAddress, mram } = constantPcmFixture(20_000);
    const physicalAddress = 0x200;
    setWord(
      mram,
      physicalAddress,
      AX_FZERO_UCODE_HASH,
      AX_PB_WORD.MIXER_CONTROL,
      selected.enableBit
        | AX_MIXER_CONTROL.DPL2_AUXB_SURROUND_INPUT,
    );
    for (let routeIndex = 0; routeIndex < NINE_MIX_ROUTES.length; routeIndex += 1) {
      const route = NINE_MIX_ROUTES[routeIndex];
      setWord(
        mram,
        physicalAddress,
        AX_FZERO_UCODE_HASH,
        route.volumeWord,
        0x8000,
      );
      setWord(
        mram,
        physicalAddress,
        AX_FZERO_UCODE_HASH,
        route.dpopWord,
        0x6000 + routeIndex,
      );
    }

    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: guestAddress,
      ucodeHash: AX_FZERO_UCODE_HASH,
    });

    assert.equal(result.ok, true, selected.name);
    const appliedMram = applyParameterBlockWrites(
      mram,
      result.parameterBlockWrites,
    );
    for (let routeIndex = 0; routeIndex < NINE_MIX_ROUTES.length; routeIndex += 1) {
      const route = NINE_MIX_ROUTES[routeIndex];
      const plane = result.accumulators[route.bus][route.channel];
      const active = route.name === selected.name;
      assert.ok(
        plane.every(sample => sample === (active ? 10_000 : 0)),
        `${selected.name} -> ${route.name}`,
      );
      assert.equal(
        getWord(
          appliedMram,
          physicalAddress,
          AX_FZERO_UCODE_HASH,
          route.dpopWord,
        ),
        active ? 10_000 : 0x6000 + routeIndex,
        `${selected.name} DPOP ${route.name}`,
      );
    }
  }
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

test("nested accumulator inputs require a complete non-aliased nine-plane snapshot", () => {
  const mram = new Uint8Array(0x100);
  const aram = new Uint8Array(1);
  const initialAccumulators = makeInitialAccumulators(
    plane => plane * 1_000 - 4_000,
  );
  const initialPlanes = collectAccumulatorPlanes(initialAccumulators);
  const originals = initialPlanes.map(plane => new Int32Array(plane));
  const input = {
    mram,
    aram,
    headAddress: 0,
    ucodeHash: AX_FZERO_UCODE_HASH,
    initialAccumulators,
  };

  const result = renderAxVoiceReference(input);
  assert.equal(result.ok, true);
  assert.equal(result.accumulators.frames, AX_REFERENCE_LIMITS.frames);
  const outputPlanes = collectAccumulatorPlanes(result.accumulators);
  assert.equal(new Set(outputPlanes.map(plane => plane.buffer)).size, 9);
  for (let plane = 0; plane < outputPlanes.length; plane += 1) {
    assert.deepEqual(outputPlanes[plane], originals[plane]);
    assert.deepEqual(initialPlanes[plane], originals[plane]);
    assert.notEqual(outputPlanes[plane].buffer, initialPlanes[plane].buffer);
    assert.notEqual(outputPlanes[plane].buffer, mram.buffer);
    assert.notEqual(outputPlanes[plane].buffer, aram.buffer);
  }

  const missingBus = makeInitialAccumulators();
  delete missingBus.auxB;
  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialAccumulators: missingBus,
    }),
    {
      name: "TypeError",
      message: "initialAccumulators.auxB is required",
    },
  );

  const missingPlane = makeInitialAccumulators();
  delete missingPlane.auxA.surround;
  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialAccumulators: missingPlane,
    }),
    {
      name: "TypeError",
      message: "initialAccumulators.auxA.surround is required",
    },
  );

  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialAccumulators: {
        ...makeInitialAccumulators(),
        frames: AX_REFERENCE_LIMITS.frames - 1,
      },
    }),
    {
      name: "RangeError",
      message: "initialAccumulators.frames must equal 160",
    },
  );

  const aliased = makeInitialAccumulators();
  aliased.auxB.right = aliased.main.left;
  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialAccumulators: aliased,
    }),
    {
      name: "TypeError",
      message: "initialAccumulators planes must not alias",
    },
  );

  const sharedBacking = makeInitialAccumulators();
  const sharedBuffer = new ArrayBuffer(
    AX_REFERENCE_LIMITS.frames * Int32Array.BYTES_PER_ELEMENT * 2,
  );
  sharedBacking.main.left = new Int32Array(
    sharedBuffer,
    0,
    AX_REFERENCE_LIMITS.frames,
  );
  sharedBacking.main.right = new Int32Array(
    sharedBuffer,
    AX_REFERENCE_LIMITS.frames * Int32Array.BYTES_PER_ELEMENT,
    AX_REFERENCE_LIMITS.frames,
  );
  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialAccumulators: sharedBacking,
    }),
    {
      name: "TypeError",
      message: "initialAccumulators planes must not alias",
    },
  );

  assert.throws(
    () => renderAxVoiceReference({
      ...input,
      initialMainLeft: new Int32Array(AX_REFERENCE_LIMITS.frames),
    }),
    {
      name: "TypeError",
      message:
        "initialAccumulators cannot be combined with legacy main accumulators",
    },
  );
  assert.deepEqual(mram, new Uint8Array(0x100));
  assert.deepEqual(aram, new Uint8Array(1));
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
      [0x8000_0100, 0x100, FZERO_DMA_BYTES],
      [0x4000_0300, 0x300, FZERO_DMA_BYTES],
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

test("PB updates run before the stopped guard and unsupported routes reject", () => {
  {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(0x400);
    for (let index = 0; index < 0x200; index += 1) {
      writePcm16(aram, index, 10_000);
    }
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x100,
      guestAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 0x1ff,
      gain: 0x0800,
    });
    writeParameterBlockUpdates({
      mram,
      physicalAddress: 0x100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      counts: [1, 0, 0, 0, 0],
      tableAddress: 0x8000_0600,
      updates: [{ offset: AX_PB_WORD.RUNNING, value: 1 }],
    });
    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
    });
    assert.equal(result.ok, true);
    assert.equal(result.writebacks[0].running, 1);
    assert.equal(result.telemetry.parameterBlockUpdateTables, 1);
    assert.equal(result.telemetry.parameterBlockUpdateReadBytes, 128);
    assert.equal(result.telemetry.parameterBlockUpdateWordWrites, 1);
    assert.equal(result.telemetry.voiceSubframesProcessed, 5);
    assert.ok(result.telemetry.nonZeroSampleValues > 0);
  }

  for (const fixture of [
    {
      ucodeHash: AX_OLD_UCODE_HASH,
      mixerControl: 0x0020,
      unsupportedBits: 0x0020,
      supportedMask: 0x001f,
    },
    {
      ucodeHash: AX_FZERO_UCODE_HASH,
      mixerControl: 0x8003,
      unsupportedBits: 0x8000,
      supportedMask: 0x7fff,
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
      unsupportedBits: fixture.unsupportedBits,
      supportedMask: fixture.supportedMask,
    });
    assert.equal("parameterBlockWrites" in result, false);
    assert.equal("output" in result, false);
  }
});

test("PB updates change running, routes, and ramps at exact 1 ms boundaries", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, 10_000);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 0,
    mixerControl: 0x8000,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });
  setWord(
    mram,
    physicalAddress,
    AX_FZERO_UCODE_HASH,
    AX_PB_WORD.AUXA_LEFT_VOLUME,
    0x8000,
  );
  writeParameterBlockUpdates({
    mram,
    physicalAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    counts: [4, 2, 3, 1, 2],
    tableAddress: 0xc000_0600,
    updates: [
      { offset: AX_PB_WORD.RUNNING, value: 1 },
      { offset: AX_PB_WORD.MIXER_CONTROL, value: AX_MIXER_CONTROL.MAIN_LEFT },
      { offset: AX_PB_WORD.MAIN_LEFT_VOLUME, value: 0x2000 },
      { offset: AX_PB_WORD.MAIN_LEFT_VOLUME, value: 0x4000 },
      { offset: AX_PB_WORD.MIXER_CONTROL, value: AX_MIXER_CONTROL.MAIN_RIGHT },
      { offset: AX_PB_WORD.MAIN_RIGHT_VOLUME, value: 0x2000 },
      {
        offset: AX_PB_WORD.MIXER_CONTROL,
        value: AX_MIXER_CONTROL.MAIN_LEFT | AX_MIXER_CONTROL.MAIN_RAMP,
      },
      { offset: AX_PB_WORD.MAIN_LEFT_VOLUME, value: 0x2000 },
      { offset: AX_PB_WORD.MAIN_LEFT_DELTA, value: 0x0100 },
      { offset: AX_PB_WORD.RUNNING, value: 0 },
      { offset: AX_PB_WORD.RUNNING, value: 1 },
      { offset: AX_PB_WORD.MIXER_CONTROL, value: AX_MIXER_CONTROL.AUXA_LEFT },
    ],
  });
  const before = new Uint8Array(mram);

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  assert.equal("parameterBlockUpdateTable" in result, false);
  assert.deepEqual(
    Array.from(result.accumulators.main.left.slice(0, 32)),
    new Array(32).fill(4_999),
  );
  assert.deepEqual(
    Array.from(result.accumulators.main.right.slice(32, 64)),
    new Array(32).fill(2_499),
  );
  assert.equal(result.accumulators.main.left[64], 2_499);
  assert.equal(
    result.accumulators.main.left[65],
    (9_999 * 0x2100) >> 15,
  );
  assert.deepEqual(
    Array.from(result.accumulators.main.left.slice(96, 160)),
    new Array(64).fill(0),
  );
  assert.deepEqual(
    Array.from(result.accumulators.auxA.left.slice(128, 160)),
    new Array(32).fill(9_999),
  );
  assert.equal(result.writebacks[0].currentAddress, 128);
  assert.equal(result.writebacks[0].mainLeft.volume, 0x4000);
  assert.equal(result.telemetry.parameterBlockUpdateEntriesVisited, 12);
  assert.equal(result.telemetry.parameterBlockUpdateWordWrites, 12);
  assert.equal(result.telemetry.parameterBlockUpdateOffsetsIgnored, 0);
  assert.equal(result.telemetry.voiceSubframesProcessed, 4);
});

test("F-Zero PB updates stop at the exact 0xd0 DMA boundary", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, 2_000);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: 0xffff,
    sourceType: 0xffff,
    running: 0,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });
  const updates = [
    { offset: 103, value: 0xbeef },
    ...Array.from({ length: 28 }, (_unused, index) => ({
      offset: 104 + index,
      value: 0x1000 + index,
    })),
    { offset: AX_PB_WORD.SAMPLE_FORMAT, value: AX_SAMPLE_FORMAT.PCM16 },
    { offset: AX_PB_WORD.SRC_TYPE, value: AX_SRC_TYPE.NEAREST },
    { offset: AX_PB_WORD.RUNNING, value: 1 },
  ];
  assert.equal(updates.length, 32);
  writeParameterBlockUpdates({
    mram,
    physicalAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    counts: [32, 0, 0, 0, 0],
    tableAddress: 0x8000_0600,
    updates,
  });

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.writebacks[0].running, 1);
  assert.equal(result.telemetry.parameterBlockUpdateEntriesVisited, 32);
  assert.equal(result.telemetry.parameterBlockUpdateWordWrites, 4);
  assert.equal(result.telemetry.parameterBlockUpdateOffsetsIgnored, 28);
  assert.equal(result.telemetry.parameterBlockUpdateReadBytes, 128);
  assert.equal(result.writebacks[0].loopCounter, 0xbeef);
  const write = result.parameterBlockWrites[0].data;
  assert.equal(
    readBigEndianWord(write, 103 * 2),
    0xbeef,
  );
});

test("F-Zero PB updates preserve opaque physical words", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(4);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 0,
    currentAddress: 0,
    endAddress: 1,
    gain: 0x0800,
  });

  // Use literal physical offsets so this fixture does not inherit the
  // production semantic-to-physical mapping under test. Word 100 is opaque;
  // word 103 is the independently retained loop counter.
  mram[physicalAddress + 100 * 2] = 0x24;
  mram[physicalAddress + 100 * 2 + 1] = 0x68;
  mram[physicalAddress + 103 * 2] = 0x13;
  mram[physicalAddress + 103 * 2 + 1] = 0x57;
  writeParameterBlockUpdates({
    mram,
    physicalAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    counts: [1, 0, 0, 0, 0],
    tableAddress: 0x8000_0600,
    updates: [{ offset: 100, value: 0xbeef }],
  });

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.parameterBlockUpdateEntriesVisited, 1);
  assert.equal(result.telemetry.parameterBlockUpdateWordWrites, 1);
  assert.equal(result.telemetry.parameterBlockUpdateOffsetsIgnored, 0);
  assert.equal(result.writebacks[0].loopCounter, 0x1357);
  const write = result.parameterBlockWrites[0].data;
  assert.equal(readBigEndianWord(write, 100 * 2), 0xbeef);
  assert.equal(readBigEndianWord(write, 103 * 2), 0x1357);
});

test("PB update groups skip whole over-capacity slices without partial writes", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(4);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 0,
    currentAddress: 0,
    endAddress: 1,
    gain: 0x0800,
  });
  writeParameterBlockUpdates({
    mram,
    physicalAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    counts: [31, 2, 0, 0, 0],
    tableAddress: 0x600,
    updates: [
      ...Array.from({ length: 31 }, (_unused, index) => ({
        offset: 103,
        value: index,
      })),
      { offset: AX_PB_WORD.RUNNING, value: 1 },
    ],
  });

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.writebacks[0].running, 0);
  assert.equal(result.telemetry.parameterBlockUpdateEntriesVisited, 31);
  assert.equal(result.telemetry.parameterBlockUpdateWordWrites, 31);
  assert.equal(result.telemetry.parameterBlockUpdateSlicesSkipped, 1);
  assert.equal(result.telemetry.voiceSubframesProcessed, 0);
  assert.equal(
    readBigEndianWord(
      result.parameterBlockWrites[0].data,
      103 * 2,
    ),
    30,
  );
});

test("PB count updates resize only later millisecond slices", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, 1_000);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 0,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });
  writeParameterBlockUpdates({
    mram,
    physicalAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
    counts: [1, 1, 0, 0, 0],
    tableAddress: 0x600,
    updates: [
      { offset: AX_PB_WORD.UPDATE_COUNT_0, value: 2 },
      { offset: AX_PB_WORD.MIXER_CONTROL, value: 0x8000 },
      { offset: AX_PB_WORD.RUNNING, value: 1 },
    ],
  });

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.writebacks[0].running, 1);
  assert.equal(result.writebacks[0].currentAddress, 128);
  assert.equal(result.telemetry.parameterBlockUpdateEntriesVisited, 2);
  assert.equal(result.telemetry.parameterBlockUpdateWordWrites, 2);
  assert.equal(result.telemetry.voiceSubframesProcessed, 4);
});

test("PB update table pointers are snapshotted once before all five slices", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  const physicalAddress = 0x100;
  const guestAddress = 0x8000_0100;
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, 1_000);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress,
    guestAddress,
    ucodeHash: WARIO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 0,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });
  writeParameterBlockUpdates({
    mram,
    physicalAddress,
    ucodeHash: WARIO_UCODE_HASH,
    counts: [1, 1, 0, 0, 0],
    tableAddress: 0xc000_0600,
    updates: [
      { offset: AX_PB_WORD.UPDATE_DATA_LOW, value: 0x0700 },
      { offset: AX_PB_WORD.RUNNING, value: 1 },
    ],
  });
  const replacementOffset = 0x700 + 4;
  mram[replacementOffset] = 0;
  mram[replacementOffset + 1] = AX_PB_WORD.MIXER_CONTROL;
  mram[replacementOffset + 2] = 0x80;
  mram[replacementOffset + 3] = 0;

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: guestAddress,
    ucodeHash: WARIO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.writebacks[0].running, 1);
  assert.equal(result.telemetry.parameterBlockUpdateTables, 1);
  assert.equal(result.telemetry.parameterBlockUpdateReadBytes, 128);
  assert.equal(result.telemetry.parameterBlockUpdateEntriesVisited, 2);
  assert.equal(result.telemetry.voiceSubframesProcessed, 4);
  assert.equal(
    readBigEndianWord(
      result.parameterBlockWrites[0].data,
      AX_PB_WORD.UPDATE_DATA_LOW * 2,
    ),
    0x0700,
  );
});

test("old-layout updates translate physical offsets and stop at 0xc0", () => {
  {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(4);
    const physicalAddress = 0x100;
    const guestAddress = 0x8000_0100;
    writeBaseParameterBlock({
      mram,
      physicalAddress,
      guestAddress,
      ucodeHash: AX_OLD_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 1,
      gain: 0x0800,
    });
    writeParameterBlockUpdates({
      mram,
      physicalAddress,
      ucodeHash: AX_OLD_UCODE_HASH,
      counts: [1, 0, 0, 0, 0],
      tableAddress: 0x600,
      updates: [{
        offset: physicalWord(
          AX_PB_WORD.LOOP_COUNTER,
          AX_OLD_UCODE_HASH,
        ),
        value: 0x1234,
      }],
    });

    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: guestAddress,
      ucodeHash: AX_OLD_UCODE_HASH,
    });

    assert.equal(result.ok, true);
    assert.equal(result.writebacks[0].loopCounter, 0x1234);
    assert.equal(result.parameterBlockWrites[0].byteLength, OLD_PB_BYTES);
    assert.equal(
      readBigEndianWord(
        result.parameterBlockWrites[0].data,
        physicalWord(AX_PB_WORD.LOOP_COUNTER, AX_OLD_UCODE_HASH) * 2,
      ),
      0x1234,
    );
  }

  {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(4);
    writeBaseParameterBlock({
      mram,
      physicalAddress: 0x100,
      guestAddress: 0x8000_0100,
      ucodeHash: AX_OLD_UCODE_HASH,
      sampleFormat: AX_SAMPLE_FORMAT.PCM16,
      running: 0,
      currentAddress: 0,
      endAddress: 1,
      gain: 0x0800,
    });
    writeParameterBlockUpdates({
      mram,
      physicalAddress: 0x100,
      ucodeHash: AX_OLD_UCODE_HASH,
      counts: [1, 0, 0, 0, 0],
      tableAddress: 0x600,
      updates: [{ offset: OLD_PB_BYTES / 2, value: 1 }],
    });

    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: AX_OLD_UCODE_HASH,
    });

    assert.equal(result.ok, true);
    assert.equal(result.writebacks[0].running, 0);
    assert.equal(result.telemetry.parameterBlockUpdateWordWrites, 0);
    assert.equal(result.telemetry.parameterBlockUpdateOffsetsIgnored, 1);
  }
});

test("out-of-range PB update tables reject the whole pure transaction", () => {
  const mram = new Uint8Array(0x300);
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
  writeParameterBlockUpdates({
    mram,
    physicalAddress: 0x100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    counts: [0, 0, 0, 0, 0],
    tableAddress: 0x8000_02c0,
    updates: [],
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
      reason: "parameter-block-update-table-out-of-bounds",
      parameterBlock: 0x8000_0100,
      address: 0x8000_02c0,
      length: 128,
      mramLength: 0x300,
    },
  });
  assert.deepEqual(mram, before);
  assert.equal("parameterBlockWrites" in result, false);
  assert.equal("output" in result, false);
});

test("final updated NEXT controls traversal and cycle detection", () => {
  {
    const mram = new Uint8Array(0x1000);
    const aram = new Uint8Array(4);
    for (const [physicalAddress, guestAddress] of [
      [0x100, 0x8000_0100],
      [0x300, 0x8000_0300],
    ]) {
      writeBaseParameterBlock({
        mram,
        physicalAddress,
        guestAddress,
        ucodeHash: AX_FZERO_UCODE_HASH,
        sampleFormat: AX_SAMPLE_FORMAT.PCM16,
        running: 0,
        currentAddress: 0,
        endAddress: 1,
        gain: 0x0800,
      });
    }
    writeParameterBlockUpdates({
      mram,
      physicalAddress: 0x100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      counts: [0, 0, 0, 0, 2],
      tableAddress: 0x700,
      updates: [
        { offset: AX_PB_WORD.NEXT_HIGH, value: 0x8000 },
        { offset: AX_PB_WORD.NEXT_LOW, value: 0x0300 },
      ],
    });

    const result = renderAxVoiceReference({
      mram,
      aram,
      headAddress: 0x8000_0100,
      ucodeHash: AX_FZERO_UCODE_HASH,
    });

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.parameterBlocks, 2);
    assert.equal(result.telemetry.parameterBlockUpdateTables, 2);
    assert.equal(result.telemetry.parameterBlockUpdateReadBytes, 256);
    assert.deepEqual(
      result.parameterBlockWrites.map(write => write.logicalAddress),
      [0x8000_0100, 0x8000_0300],
    );
  }

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
    writeParameterBlockUpdates({
      mram,
      physicalAddress: 0x100,
      ucodeHash: AX_FZERO_UCODE_HASH,
      counts: [2, 0, 0, 0, 0],
      tableAddress: 0x700,
      updates: [
        { offset: AX_PB_WORD.NEXT_HIGH, value: 0xc000 },
        { offset: AX_PB_WORD.NEXT_LOW, value: 0x0100 },
      ],
    });

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
  }
});

test("later update-table reads observe earlier staged PB writeback bytes", () => {
  const mram = new Uint8Array(0x1000);
  const aram = new Uint8Array(0x400);
  for (let index = 0; index < 0x200; index += 1) {
    writePcm16(aram, index, 8);
  }
  writeBaseParameterBlock({
    mram,
    physicalAddress: 0x100,
    guestAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
    nextAddress: 0x8000_0300,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 1,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
    mixerControl: AX_MIXER_CONTROL.MAIN_LEFT,
  });
  setWord(
    mram,
    0x100,
    AX_FZERO_UCODE_HASH,
    AX_PB_WORD.DPOP_AUXA_LEFT,
    1,
  );
  writeBaseParameterBlock({
    mram,
    physicalAddress: 0x300,
    guestAddress: 0x8000_0300,
    ucodeHash: AX_FZERO_UCODE_HASH,
    sampleFormat: AX_SAMPLE_FORMAT.PCM16,
    running: 0,
    currentAddress: 0,
    endAddress: 0x1ff,
    gain: 0x0800,
  });
  for (let index = 0; index < AX_REFERENCE_LIMITS.milliseconds; index += 1) {
    setWord(
      mram,
      0x300,
      AX_FZERO_UCODE_HASH,
      AX_PB_WORD.UPDATE_COUNT_0 + index,
      index === 0 ? 1 : 0,
    );
  }
  setAddress(
    mram,
    0x300,
    AX_FZERO_UCODE_HASH,
    AX_PB_WORD.UPDATE_DATA_HIGH,
    AX_PB_WORD.UPDATE_DATA_LOW,
    0x8000_0152,
  );
  assert.equal(
    getWord(mram, 0x100, AX_FZERO_UCODE_HASH, AX_PB_WORD.DPOP_MAIN_LEFT),
    0,
  );

  const result = renderAxVoiceReference({
    mram,
    aram,
    headAddress: 0x8000_0100,
    ucodeHash: AX_FZERO_UCODE_HASH,
  });

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.parameterBlocks, 2);
  assert.equal(result.telemetry.parameterBlockUpdateTables, 2);
  assert.equal(result.telemetry.parameterBlockUpdateEntriesVisited, 1);
  assert.equal(result.writebacks[0].mainLeft.dpop, 7);
  assert.equal(result.writebacks[1].running, 1);
  assert.equal(result.telemetry.voiceSubframesProcessed, 10);
  assert.equal(
    readBigEndianWord(
      result.parameterBlockWrites[0].data,
      AX_PB_WORD.DPOP_MAIN_LEFT * 2,
    ),
    7,
  );
  assert.equal(
    getWord(mram, 0x100, AX_FZERO_UCODE_HASH, AX_PB_WORD.DPOP_MAIN_LEFT),
    0,
  );
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
