#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  AX_MAIN_BUS_COMMAND,
  AX_MAIN_BUS_LIMITS,
  AX_MAIN_BUS_REFERENCE_SCHEMA,
  executeAxMainBusReference,
} from "./browser_dsp_ax_main_bus_reference.mjs";

function writeBigEndianS32(bytes, offset, value) {
  const word = value >>> 0;
  bytes[offset] = word >>> 24;
  bytes[offset + 1] = (word >>> 16) & 0xff;
  bytes[offset + 2] = (word >>> 8) & 0xff;
  bytes[offset + 3] = word & 0xff;
}

function writeBigEndianU16(bytes, offset, value) {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeMainInput(mram, physicalAddress, samples) {
  assert.equal(samples.length, AX_MAIN_BUS_LIMITS.frames);
  for (let frame = 0; frame < samples.length; frame += 1) {
    writeBigEndianS32(mram, physicalAddress + frame * 4, samples[frame]);
  }
}

function writeLrsInput(
  mram,
  physicalAddress,
  { left, right, surround },
) {
  writeMainInput(mram, physicalAddress, left);
  writeMainInput(
    mram,
    physicalAddress + AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes,
    right,
  );
  writeMainInput(
    mram,
    physicalAddress + 2 * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes,
    surround,
  );
}

function writeCompressorEntry(
  mram,
  physicalTableAddress,
  entryIndex,
  coefficient,
) {
  const entryAddress =
    physicalTableAddress
    + entryIndex * AX_MAIN_BUS_LIMITS.compressorEntryBytes;
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    writeBigEndianU16(
      mram,
      entryAddress + frame * 2,
      typeof coefficient === "function"
        ? coefficient(frame)
        : coefficient,
    );
  }
}

function setLr(address) {
  return { code: AX_MAIN_BUS_COMMAND.SET_LR, address };
}

function uploadLrs(address) {
  return { code: AX_MAIN_BUS_COMMAND.UPLOAD_LRS, address };
}

function mixAuxBNoWrite(address) {
  return { code: AX_MAIN_BUS_COMMAND.MIX_AUXB_NOWRITE, address };
}

function processCommand() {
  return { code: AX_MAIN_BUS_COMMAND.PROCESS };
}

function setOppositeLr(address) {
  return { code: AX_MAIN_BUS_COMMAND.SET_OPPOSITE_LR, address };
}

function compressor({
  threshold,
  releaseFrames,
  tableAddress,
}) {
  return {
    code: AX_MAIN_BUS_COMMAND.COMPRESSOR,
    threshold,
    releaseFrames,
    tableAddress,
  };
}

function output(lrAddress, surroundAddress) {
  return {
    code: AX_MAIN_BUS_COMMAND.OUTPUT,
    lrAddress,
    surroundAddress,
  };
}

function clampSigned16(value) {
  return Math.max(-0x8000, Math.min(0x7fff, value));
}

function applyWrites(mram, writes) {
  const updated = new Uint8Array(mram);
  for (const write of writes) {
    assert.equal(write.byteLength, write.data.length);
    assert.ok(write.physicalAddress <= updated.length - write.byteLength);
    updated.set(write.data, write.physicalAddress);
  }
  return updated;
}

function fnv1a(parts) {
  let hash = 0x811c9dc5;
  for (const bytes of parts) {
    for (const value of bytes) {
      hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
    }
  }
  return "0x" + hash.toString(16).padStart(8, "0");
}

function assertExactOwnedResultBuffers(result, mram) {
  const payloads = [
    ...result.uploads.map(upload => upload.data),
    result.output.surround.bytes,
    result.output.main.bytes,
    result.output.surround.samples,
    result.output.main.samples,
  ];
  for (const payload of payloads) {
    assert.ok(ArrayBuffer.isView(payload));
    assert.ok(payload.buffer instanceof ArrayBuffer);
    assert.equal(payload.byteOffset, 0);
    assert.equal(payload.byteLength, payload.buffer.byteLength);
    assert.notEqual(payload.buffer, mram.buffer);
  }
  assert.equal(
    new Set(payloads.map(payload => payload.buffer)).size,
    payloads.length,
    "every independently returned payload owns a distinct exact buffer",
  );
}

function patternedSamples() {
  const samples = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  for (let frame = 0; frame < samples.length; frame += 1) {
    samples[frame] = ((frame * 104_729) % 400_001) - 200_000;
  }
  samples.set([
    0,
    1,
    -1,
    0x7fff,
    0x8000,
    -0x8000,
    -0x8001,
    0x7fff_ffff,
    -0x8000_0000,
    0x1234_5678,
    -0x1234_5678,
  ]);
  return samples;
}

test("pins GameCube AX command IDs and the five-millisecond envelope", () => {
  assert.deepEqual(AX_MAIN_BUS_COMMAND, {
    PROCESS: 0x03,
    UPLOAD_LRS: 0x06,
    SET_LR: 0x07,
    MIX_AUXB_NOWRITE: 0x09,
    OUTPUT: 0x0e,
    SET_OPPOSITE_LR: 0x11,
    COMPRESSOR: 0x12,
  });
  assert.equal(AX_MAIN_BUS_LIMITS.frames, 160);
  assert.equal(AX_MAIN_BUS_LIMITS.samplesPerMillisecond, 32);
  assert.equal(AX_MAIN_BUS_LIMITS.milliseconds, 5);
  assert.equal(AX_MAIN_BUS_LIMITS.compressorEntryBytes, 320);
  assert.equal(AX_MAIN_BUS_LIMITS.attackEntryCount, 11);
  assert.equal(AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes, 640);
  assert.equal(AX_MAIN_BUS_LIMITS.accumulatorLrsBytes, 1_920);
});

test("CMD_SET_LR reads cached big-endian s32 and emits exact R,L s16", () => {
  const mram = new Uint8Array(0x4000);
  const samples = patternedSamples();
  writeMainInput(mram, 0x100, samples);
  const before = new Uint8Array(mram);

  const result = executeAxMainBusReference({
    mram,
    commands: [
      setLr(0x8000_0100),
      output(0x1800, 0xc000_1000),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.compressorPosition, 0);
  assert.deepEqual(mram, before);
  assert.deepEqual(
    result.writes.map(write => ({
      sequence: write.sequence,
      kind: write.kind,
      logicalAddress: write.logicalAddress,
      physicalAddress: write.physicalAddress,
      byteLength: write.byteLength,
      aliasesMram: write.data.buffer === mram.buffer,
    })),
    [
      {
        sequence: 0,
        kind: "surround-s32-be",
        logicalAddress: 0xc000_1000,
        physicalAddress: 0x1000,
        byteLength: 640,
        aliasesMram: false,
      },
      {
        sequence: 1,
        kind: "main-rl-s16-be",
        logicalAddress: 0x1800,
        physicalAddress: 0x1800,
        byteLength: 640,
        aliasesMram: false,
      },
    ],
  );

  const surroundView = new DataView(
    result.output.surround.bytes.buffer,
    result.output.surround.bytes.byteOffset,
    result.output.surround.bytes.byteLength,
  );
  const mainView = new DataView(
    result.output.main.bytes.buffer,
    result.output.main.bytes.byteOffset,
    result.output.main.bytes.byteLength,
  );
  for (let frame = 0; frame < samples.length; frame += 1) {
    const expected = clampSigned16(samples[frame]);
    assert.equal(surroundView.getInt32(frame * 4, false), 0);
    assert.equal(mainView.getInt16(frame * 4, false), expected);
    assert.equal(mainView.getInt16(frame * 4 + 2, false), expected);
    assert.equal(result.output.main.samples[frame * 2], expected);
    assert.equal(result.output.main.samples[frame * 2 + 1], expected);
  }

  assert.equal(result.telemetry.schema, AX_MAIN_BUS_REFERENCE_SCHEMA);
  assert.equal(result.telemetry.initialMainBus, "zero");
  assert.equal(result.telemetry.setLrCommands, 1);
  assert.equal(result.telemetry.setOppositeLrCommands, 0);
  assert.equal(result.telemetry.outputWriteBytes, 1_280);
  assert.equal(result.telemetry.surroundHash, "0x455f9fc5");
  assert.equal(result.telemetry.mainHash, "0x782337c5");
  assert.equal(
    result.telemetry.transactionHash,
    "0x3c9a39c5",
  );
});

test("CMD_SET_OPPOSITE_LR wraps INT32_MIN and honors uncached aliases", () => {
  const mram = new Uint8Array(0x4000);
  const samples = patternedSamples();
  writeMainInput(mram, 0x200, samples);

  const result = executeAxMainBusReference({
    mram,
    commands: [
      setOppositeLr(0xc000_0200),
      output(0x8000_2000, 0x1800),
    ],
  });

  assert.equal(result.ok, true);
  const mainView = new DataView(
    result.output.main.bytes.buffer,
    result.output.main.bytes.byteOffset,
    result.output.main.bytes.byteLength,
  );
  for (let frame = 0; frame < samples.length; frame += 1) {
    const expectedRight = clampSigned16(samples[frame]);
    const expectedLeft = clampSigned16((-samples[frame]) | 0);
    assert.equal(mainView.getInt16(frame * 4, false), expectedRight);
    assert.equal(mainView.getInt16(frame * 4 + 2, false), expectedLeft);
  }
  assert.equal(
    mainView.getInt16(8 * 4, false),
    -0x8000,
    "INT32_MIN remains INT32_MIN when negated as signed 32-bit",
  );
  assert.equal(mainView.getInt16(8 * 4 + 2, false), -0x8000);
  assert.equal(result.telemetry.setLrCommands, 0);
  assert.equal(result.telemetry.setOppositeLrCommands, 1);
  assert.equal(result.telemetry.mainHash, "0x1e4c4b2a");
  assert.equal(
    result.telemetry.transactionHash,
    "0xe2c34d2a",
  );
});

test("PROCESS then UPLOAD_LRS snapshots post-voice accumulators in order", () => {
  const mram = new Uint8Array(0x10_000);
  const initialLeft = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (0x1020_3040 + frame * 0x0102_0304) | 0,
  );
  const initialRight = Int32Array.from(
    initialLeft,
    value => (~value) | 0,
  );
  const initialSurround = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (frame * 0x0011_2233) | 0,
  );
  const voiceLeft = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (0x3141_5926 - frame * 0x0001_0203) | 0,
  );
  const voiceRight = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (-0x2718_2818 + frame * 0x0003_0201) | 0,
  );
  const opposite = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => ((frame * 1_000_003) - 80_000_000) | 0,
  );
  opposite[0] = -0x8000_0000;
  opposite[1] = 0x7fff_ffff;

  const auxLeft = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (frame * 101 - 8_000) | 0,
  );
  const auxRight = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (8_000 - frame * 103) | 0,
  );
  const auxSurround = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (0x1234_0000 + frame * 257) | 0,
  );
  auxLeft[0] = -1;
  auxRight[0] = -1;
  auxLeft[1] = -2;
  auxRight[1] = 1;

  writeMainInput(mram, 0x1000, opposite);
  writeLrsInput(mram, 0x2000, {
    left: auxLeft,
    right: auxRight,
    surround: auxSurround,
  });
  const before = new Uint8Array(mram);
  const processInputs = [];
  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: initialLeft,
      right: initialRight,
      surround: initialSurround,
    },
    processMainBus: ({ left, right }) => {
      processInputs.push({ left, right });
      return {
        left: new Int32Array(voiceLeft),
        right: new Int32Array(voiceRight),
      };
    },
    commands: [
      processCommand(),
      uploadLrs(0x8000_0100),
      setOppositeLr(0xc000_1000),
      mixAuxBNoWrite(0x4000_2000),
      output(0x5000, 0x6000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before, "the authority model must not mutate MRAM");
  assert.equal(processInputs.length, 1);
  assert.deepEqual(processInputs[0].left, initialLeft);
  assert.deepEqual(processInputs[0].right, initialRight);
  assert.notEqual(processInputs[0].left.buffer, initialLeft.buffer);
  assert.notEqual(processInputs[0].right.buffer, initialRight.buffer);
  assert.equal(result.uploads.length, 1);
  assert.equal(result.writes.length, 3);
  assertExactOwnedResultBuffers(result, mram);
  assert.deepEqual(
    result.writes.map(write => ({
      sequence: write.sequence,
      commandIndex: write.commandIndex,
      kind: write.kind,
      physicalAddress: write.physicalAddress,
      byteLength: write.byteLength,
      aliasesMram: write.data.buffer === mram.buffer,
    })),
    [
      {
        sequence: 0,
        commandIndex: 1,
        kind: "main-lrs-s32-be",
        physicalAddress: 0x100,
        byteLength: 1_920,
        aliasesMram: false,
      },
      {
        sequence: 1,
        commandIndex: 4,
        kind: "surround-s32-be",
        physicalAddress: 0x6000,
        byteLength: 640,
        aliasesMram: false,
      },
      {
        sequence: 2,
        commandIndex: 4,
        kind: "main-rl-s16-be",
        physicalAddress: 0x5000,
        byteLength: 640,
        aliasesMram: false,
      },
    ],
  );
  assert.equal(result.writes[0].data, result.uploads[0].data);

  const uploadView = new DataView(result.uploads[0].data.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(uploadView.getInt32(frame * 4, false), voiceLeft[frame]);
    assert.equal(
      uploadView.getInt32(
        AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
        false,
      ),
      voiceRight[frame],
    );
    assert.equal(
      uploadView.getInt32(
        2 * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
        false,
      ),
      initialSurround[frame],
    );
  }
  assert.notEqual(
    uploadView.getInt32(0, false),
    initialLeft[0],
    "the upload snapshots post-PROCESS L/R rather than initial accumulators",
  );

  const mainView = new DataView(result.output.main.bytes.buffer);
  const surroundView = new DataView(result.output.surround.bytes.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    const expectedLeft = (((-opposite[frame]) | 0) + auxLeft[frame]) | 0;
    const expectedRight = (opposite[frame] + auxRight[frame]) | 0;
    assert.equal(
      mainView.getInt16(frame * 4, false),
      clampSigned16(expectedRight),
    );
    assert.equal(
      mainView.getInt16(frame * 4 + 2, false),
      clampSigned16(expectedLeft),
    );
    assert.equal(
      surroundView.getInt32(frame * 4, false),
      auxSurround[frame],
    );
  }
  assert.equal(
    mainView.getInt16(0, false),
    0x7fff,
    "INT32_MIN plus -1 wraps to INT32_MAX before output clamping",
  );
  assert.equal(mainView.getInt16(4, false), -0x8000);
  assert.equal(result.telemetry.uploadLrsCommands, 1);
  assert.equal(result.telemetry.setOppositeLrCommands, 1);
  assert.equal(result.telemetry.mixAuxBNoWriteCommands, 1);
  assert.equal(result.telemetry.processCommands, 1);
  assert.equal(result.telemetry.uploadWriteBytes, 1_920);
  assert.equal(result.telemetry.outputWriteBytes, 1_280);
  assert.equal(result.telemetry.transactionWriteBytes, 3_200);
  assert.equal(
    result.telemetry.outputHash,
    fnv1a([
      result.output.surround.bytes,
      result.output.main.bytes,
    ]),
  );
  assert.equal(
    result.telemetry.transactionHash,
    fnv1a(result.writes.map(write => write.data)),
  );

  const applied = applyWrites(mram, result.writes);
  assert.deepEqual(
    applied.slice(0x100, 0x100 + 1_920),
    result.uploads[0].data,
  );
  assert.deepEqual(
    applied.slice(0x5000, 0x5000 + 640),
    result.output.main.bytes,
  );
  assert.deepEqual(
    applied.slice(0x6000, 0x6000 + 640),
    result.output.surround.bytes,
  );
});

test("WarioWare main-bus-only postmix uploads zero initial accumulators", () => {
  const mram = new Uint8Array(0x10_000);
  const opposite = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => frame * 10_003 - 800_000,
  );
  const aux = {
    left: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(101),
    right: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(-103),
    surround: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(0x1234_5678),
  };
  writeMainInput(mram, 0x1000, opposite);
  writeLrsInput(mram, 0x2000, aux);
  const before = new Uint8Array(mram);
  const result = executeAxMainBusReference({
    mram,
    commands: [
      uploadLrs(0x8000_0100),
      setOppositeLr(0xc000_1000),
      mixAuxBNoWrite(0x4000_2000),
      output(0x5000, 0x6000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  assert.equal(result.telemetry.processCommands, 0);
  assert.equal(result.telemetry.commands, 4);
  assert.equal(result.uploads.length, 1);
  assert.ok(result.uploads[0].data.every(value => value === 0));
  assert.deepEqual(
    result.writes.map(write => [
      write.sequence,
      write.commandIndex,
      write.kind,
    ]),
    [
      [0, 0, "main-lrs-s32-be"],
      [1, 3, "surround-s32-be"],
      [2, 3, "main-rl-s16-be"],
    ],
  );
  const mainView = new DataView(result.output.main.bytes.buffer);
  const surroundView = new DataView(result.output.surround.bytes.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      mainView.getInt16(frame * 4, false),
      clampSigned16((opposite[frame] - 103) | 0),
    );
    assert.equal(
      mainView.getInt16(frame * 4 + 2, false),
      clampSigned16((((-opposite[frame]) | 0) + 101) | 0),
    );
    assert.equal(
      surroundView.getInt32(frame * 4, false),
      aux.surround[frame],
    );
  }
  assert.equal(
    result.telemetry.outputHash,
    fnv1a([
      result.output.surround.bytes,
      result.output.main.bytes,
    ]),
  );
  assert.equal(
    result.telemetry.transactionHash,
    fnv1a(result.writes.map(write => write.data)),
  );
  assert.notEqual(
    result.telemetry.transactionHash,
    result.telemetry.outputHash,
    "the transaction hash includes the 1,920-byte upload",
  );
});

test("staged upload aliases feed later partial SET reads across planes", () => {
  const mram = new Uint8Array(0x8000);
  const initialLeft = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => 10_000 + frame * 17,
  );
  const initialRight = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => -20_000 - frame * 19,
  );
  const initialSurround = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => 30_000 + frame * 23,
  );
  const before = new Uint8Array(mram);
  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: initialLeft,
      right: initialRight,
      surround: initialSurround,
    },
    commands: [
      uploadLrs(0x8000_1000),
      setOppositeLr(0xc000_1200),
      output(0x5000, 0x6000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  const source = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  source.set(initialLeft.subarray(128), 0);
  source.set(initialRight.subarray(0, 128), 32);
  const mainView = new DataView(result.output.main.bytes.buffer);
  const surroundView = new DataView(result.output.surround.bytes.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      mainView.getInt16(frame * 4, false),
      clampSigned16(source[frame]),
    );
    assert.equal(
      mainView.getInt16(frame * 4 + 2, false),
      clampSigned16((-source[frame]) | 0),
    );
    assert.equal(surroundView.getInt32(frame * 4, false), 0);
  }
});

test("partial aliased reads merge staged and MRAM bytes exactly", () => {
  const mram = new Uint8Array(0x8000);
  for (let address = 0x1780; address < 0x1900; address += 1) {
    mram[address] = (address * 37 + 11) & 0xff;
  }
  const initialLeft = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (0x1020_3040 + frame * 0x0101_0101) | 0,
  );
  const initialRight = Int32Array.from(
    initialLeft,
    value => (~value) | 0,
  );
  const initialSurround = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (0x5060_7080 - frame * 0x0001_0203) | 0,
  );
  const before = new Uint8Array(mram);
  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: initialLeft,
      right: initialRight,
      surround: initialSurround,
    },
    commands: [
      uploadLrs(0x8000_1000),
      setLr(0xc000_1602),
      output(0x5000, 0x6000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  const stagedImage = new Uint8Array(mram);
  stagedImage.set(result.uploads[0].data, 0x1000);
  const stagedView = new DataView(stagedImage.buffer);
  const mainView = new DataView(result.output.main.bytes.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    const expected = stagedView.getInt32(0x1602 + frame * 4, false);
    assert.equal(
      mainView.getInt16(frame * 4, false),
      clampSigned16(expected),
    );
    assert.equal(
      mainView.getInt16(frame * 4 + 2, false),
      clampSigned16(expected),
    );
  }
});

test("overlapping staged uploads retain command-order last-write-wins reads", () => {
  const mram = new Uint8Array(0x10_000);
  const firstLeft = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => 1_000 + frame,
  );
  const firstRight = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => 2_000 + frame,
  );
  const firstSurround = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => 3_000 + frame,
  );
  const secondMono = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => -4_000 - frame,
  );
  writeMainInput(mram, 0x5000, secondMono);
  const before = new Uint8Array(mram);
  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: firstLeft,
      right: firstRight,
      surround: firstSurround,
    },
    commands: [
      uploadLrs(0x8000_1000),
      setLr(0x5000),
      uploadLrs(0x4000_1200),
      setLr(0xc000_1100),
      output(0x7000, 0x8000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  assert.equal(result.uploads.length, 2);
  const source = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  source.set(firstLeft.subarray(64, 128), 0);
  source.set(secondMono.subarray(0, 96), 64);
  const mainView = new DataView(result.output.main.bytes.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      mainView.getInt16(frame * 4, false),
      clampSigned16(source[frame]),
    );
    assert.equal(
      mainView.getInt16(frame * 4 + 2, false),
      clampSigned16(source[frame]),
    );
  }
});

test("staged upload aliases feed all three AUX-B return planes", () => {
  const mram = new Uint8Array(0x8000);
  const initialLeft = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => frame - 80,
  );
  const initialRight = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => frame * 2 - 160,
  );
  const initialSurround = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => 1_000 + frame,
  );
  const before = new Uint8Array(mram);
  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: initialLeft,
      right: initialRight,
      surround: initialSurround,
    },
    commands: [
      uploadLrs(0x8000_1000),
      mixAuxBNoWrite(0xc000_1000),
      output(0x5000, 0x6000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  const mainView = new DataView(result.output.main.bytes.buffer);
  const surroundView = new DataView(result.output.surround.bytes.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      mainView.getInt16(frame * 4, false),
      initialRight[frame] * 2,
    );
    assert.equal(
      mainView.getInt16(frame * 4 + 2, false),
      initialLeft[frame] * 2,
    );
    assert.equal(
      surroundView.getInt32(frame * 4, false),
      initialSurround[frame] * 2,
    );
  }
});

test("staged upload aliases feed compressor coefficients", () => {
  const mram = new Uint8Array(0x8000);
  const packedCoefficients = new Int32Array(
    AX_MAIN_BUS_LIMITS.frames,
  ).fill(0x0001_0001);
  const before = new Uint8Array(mram);
  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: packedCoefficients,
      right: packedCoefficients,
      surround: new Int32Array(AX_MAIN_BUS_LIMITS.frames),
    },
    commands: [
      uploadLrs(0x4000_1000),
      compressor({
        threshold: 0,
        releaseFrames: 1,
        tableAddress: 0x8000_1000,
      }),
      output(0x5000, 0x6000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  assert.equal(result.compressorPosition, 1);
  assert.deepEqual(result.output.main.samples, new Int16Array(
    AX_MAIN_BUS_LIMITS.frames * AX_MAIN_BUS_LIMITS.channels,
  ).fill(2));
});

test("final output preserves surround s32 and writes surround before R,L", () => {
  const mram = new Uint8Array(0x3000);
  const left = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const right = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const surround = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    left[frame] = frame % 2 === 0 ? frame * 1_003 : -frame * 2_009;
    right[frame] = frame % 3 === 0 ? -frame * 4_001 : frame * 3_001;
    surround[frame] = (0x1020_3040 + frame * 0x0102_0304) | 0;
  }

  const result = executeAxMainBusReference({
    mram,
    initialMainBus: { left, right, surround },
    commands: [output(0x1000, 0x1000)],
  });

  assert.equal(result.ok, true);
  assert.equal(result.telemetry.initialMainBus, "provided");
  assert.deepEqual(result.output.surround.samples, surround);
  const surroundView = new DataView(
    result.output.surround.bytes.buffer,
    result.output.surround.bytes.byteOffset,
    result.output.surround.bytes.byteLength,
  );
  for (let frame = 0; frame < surround.length; frame += 1) {
    assert.equal(
      surroundView.getInt32(frame * 4, false),
      surround[frame],
    );
  }
  assert.deepEqual(
    result.writes.map(write => [
      write.sequence,
      write.kind,
      write.physicalAddress,
    ]),
    [
      [0, "surround-s32-be", 0x1000],
      [1, "main-rl-s16-be", 0x1000],
    ],
  );
  const applied = applyWrites(mram, result.writes);
  assert.deepEqual(
    applied.slice(0x1000, 0x1000 + 640),
    result.output.main.bytes,
    "the later R,L write wins when the two output ranges overlap",
  );
  assert.equal(result.telemetry.surroundHash, "0x9dd4262e");
  assert.equal(result.telemetry.mainHash, "0x96394b3a");
  assert.equal(
    result.telemetry.transactionHash,
    "0xb5d4a4d1",
  );
});

test("SET before PROCESS contributes its exact accumulators to voice output", () => {
  const mram = new Uint8Array(0x4000);
  const samples = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  for (let frame = 0; frame < samples.length; frame += 1) {
    samples[frame] = frame * 17 - 1_000;
  }
  writeMainInput(mram, 0x200, samples);
  const before = new Uint8Array(mram);
  let callbackInputs = null;
  let callbackOutputs = null;

  const result = executeAxMainBusReference({
    mram,
    commands: [
      setLr(0x8000_0200),
      processCommand(),
      output(0x1800, 0x1000),
    ],
    processMainBus: ({ left, right }) => {
      callbackInputs = { left, right };
      const renderedLeft = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      const renderedRight = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      for (let frame = 0; frame < renderedLeft.length; frame += 1) {
        assert.equal(left[frame], samples[frame]);
        assert.equal(right[frame], samples[frame]);
        renderedLeft[frame] = left[frame] + 1_000;
        renderedRight[frame] = right[frame] - 500;
      }
      callbackOutputs = {
        left: renderedLeft,
        right: renderedRight,
      };
      return callbackOutputs;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  assert.ok(callbackInputs.left instanceof Int32Array);
  assert.ok(callbackInputs.right instanceof Int32Array);
  assert.equal(callbackInputs.left.length, AX_MAIN_BUS_LIMITS.frames);
  assert.equal(callbackInputs.left.byteOffset, 0);
  assert.equal(callbackInputs.left.buffer.byteLength, 640);
  assert.notEqual(callbackInputs.left.buffer, callbackInputs.right.buffer);
  assert.notEqual(callbackInputs.left.buffer, mram.buffer);
  assert.notEqual(callbackInputs.right.buffer, mram.buffer);

  for (let frame = 0; frame < samples.length; frame += 1) {
    assert.equal(
      result.output.main.samples[frame * 2],
      samples[frame] - 500,
      `frame ${frame} right`,
    );
    assert.equal(
      result.output.main.samples[frame * 2 + 1],
      samples[frame] + 1_000,
      `frame ${frame} left`,
    );
  }
  callbackOutputs.left.fill(0x7fff_ffff);
  callbackOutputs.right.fill(-0x8000_0000);
  assert.notEqual(result.output.main.samples[0], -0x8000);
  assert.equal(result.telemetry.processCommands, 1);
  assert.equal(result.telemetry.setLrCommands, 1);
  assert.equal(result.telemetry.mainHash, "0xd3676bc3");
  assert.equal(
    result.telemetry.transactionHash,
    "0x97de6dc3",
  );
});

test("PROCESS before SET is overwritten in exact command order", () => {
  const mram = new Uint8Array(0x4000);
  const setSamples = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  setSamples.fill(777);
  writeMainInput(mram, 0x200, setSamples);
  const initialLeft = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const initialRight = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const initialSurround = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  initialLeft.fill(111);
  initialRight.fill(222);
  initialSurround.fill(333);
  let processCalls = 0;

  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: initialLeft,
      right: initialRight,
      surround: initialSurround,
    },
    commands: [
      processCommand(),
      setLr(0xc000_0200),
      output(0x1800, 0x1000),
    ],
    processMainBus: ({ left, right }) => {
      processCalls += 1;
      assert.ok(left.every(sample => sample === 111));
      assert.ok(right.every(sample => sample === 222));
      const renderedLeft = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      const renderedRight = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      renderedLeft.fill(30_000);
      renderedRight.fill(-30_000);
      return { left: renderedLeft, right: renderedRight };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(processCalls, 1);
  assert.ok(result.output.main.samples.every(sample => sample === 777));
  assert.ok(result.output.surround.samples.every(sample => sample === 0));
  assert.equal(result.telemetry.processCommands, 1);
  assert.equal(result.telemetry.setLrCommands, 1);
  assert.equal(result.telemetry.mainHash, "0x98910ec5");
});

test("PROCESS replaces only L/R and preserves surround", () => {
  const mram = new Uint8Array(0x3000);
  const left = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const right = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const surround = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    left[frame] = frame;
    right[frame] = -frame;
    surround[frame] = (frame * 0x1020_3041) | 0;
  }

  const result = executeAxMainBusReference({
    mram,
    initialMainBus: { left, right, surround },
    commands: [processCommand(), output(0x1000, 0x1800)],
    processMainBus: ({ left: inputLeft, right: inputRight }) => {
      const renderedLeft = new Int32Array(inputLeft);
      const renderedRight = new Int32Array(inputRight);
      for (let frame = 0; frame < renderedLeft.length; frame += 1) {
        renderedLeft[frame] += 2_000;
        renderedRight[frame] -= 3_000;
      }
      return { left: renderedLeft, right: renderedRight };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.output.surround.samples, surround);
  assert.equal(result.telemetry.processCommands, 1);
  assert.equal(result.telemetry.surroundHash, "0xfa4a4a1f");
});

test("PROCESS callback contracts fail closed and permit at most one event", () => {
  const mram = new Uint8Array(0x3000);
  const commands = [processCommand(), output(0x1000, 0x1800)];
  const before = new Uint8Array(mram);
  const initialLeft = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const initialRight = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const initialSurround = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const initialMainBus = {
    left: initialLeft,
    right: initialRight,
    surround: initialSurround,
  };
  const fixtures = [
    {
      name: "missing",
      callback: null,
      reason: "missing-process-callback",
    },
    {
      name: "throw",
      callback: () => {
        throw new TypeError("fixture");
      },
      reason: "process-callback-threw",
      errorType: "TypeError",
    },
    {
      name: "snapshot alias",
      callback: ({ left, right }) => ({ left, right }),
      reason: "invalid-process-result",
    },
    {
      name: "wrong length",
      callback: () => ({
        left: new Int32Array(159),
        right: new Int32Array(160),
      }),
      reason: "invalid-process-result",
    },
    {
      name: "shared output",
      callback: () => {
        const shared = new Int32Array(160);
        return { left: shared, right: shared };
      },
      reason: "invalid-process-result",
    },
    {
      name: "initial input alias",
      callback: () => ({
        left: initialLeft,
        right: new Int32Array(160),
      }),
      reason: "invalid-process-result",
    },
  ];

  for (const fixture of fixtures) {
    const result = executeAxMainBusReference({
      mram,
      initialMainBus,
      commands,
      processMainBus: fixture.callback,
    });
    assert.equal(result.ok, false, fixture.name);
    assert.equal(result.error.reason, fixture.reason, fixture.name);
    if (fixture.errorType !== undefined) {
      assert.equal(result.error.errorType, fixture.errorType, fixture.name);
    }
    assert.equal("writes" in result, false, fixture.name);
    assert.equal("compressorPosition" in result, false, fixture.name);
    assert.deepEqual(mram, before, fixture.name);
  }

  let calls = 0;
  const multiple = executeAxMainBusReference({
    mram,
    commands: [
      processCommand(),
      processCommand(),
      output(0x1000, 0x1800),
    ],
    processMainBus: () => {
      calls += 1;
      return {
        left: new Int32Array(160),
        right: new Int32Array(160),
      };
    },
  });
  assert.deepEqual(multiple, {
    ok: false,
    error: {
      reason: "multiple-process-commands",
      commandIndex: 1,
      code: AX_MAIN_BUS_COMMAND.PROCESS,
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(mram, before);
});

test("compressor persists only its position across attack and release frames", () => {
  const mram = new Uint8Array(0x10_000);
  const inputPhysicalAddress = 0x1000;
  const tablePhysicalAddress = 0x4000;
  const tableGuestAddress = 0x4000_4000;
  writeCompressorEntry(mram, tablePhysicalAddress, 0, 0x4000);
  writeCompressorEntry(mram, tablePhysicalAddress, 2, 0x2000);
  writeCompressorEntry(mram, tablePhysicalAddress, 13, 0x6000);

  const run = ({
    sample,
    threshold,
    compressorPosition = 0,
  }) => {
    const samples = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
    samples.fill(sample);
    writeMainInput(mram, inputPhysicalAddress, samples);
    return executeAxMainBusReference({
      mram,
      compressorPosition,
      commands: [
        setLr(0x4000_1000),
        compressor({
          threshold,
          releaseFrames: 3,
          tableAddress: tableGuestAddress,
        }),
        output(0x4000_9000, 0x4000_8000),
      ],
    });
  };

  const attack = run({ sample: 20_000, threshold: 10_000 });
  assert.equal(attack.ok, true);
  assert.equal(attack.compressorPosition, 3);
  assert.deepEqual(attack.telemetry.compressorSelections, [
    {
      phase: "attack",
      triggered: true,
      threshold: 10_000,
      releaseFrames: 3,
      positionBefore: 0,
      positionAfter: 3,
      entryIndex: 0,
      tableAddress: 0x4000_4000,
    },
  ]);
  assert.ok(attack.output.main.samples.every(sample => sample === 10_000));
  assert.deepEqual(
    attack.writes.map(write => write.physicalAddress),
    [0x8000, 0x9000],
    "0x4 input, compressor-table, and output aliases resolve to MEM1",
  );
  assert.equal(attack.telemetry.mainHash, "0x6add1cc5");

  const release = run({
    sample: 100,
    threshold: 10_000,
    compressorPosition: attack.compressorPosition,
  });
  assert.equal(release.ok, true);
  assert.equal(release.compressorPosition, 2);
  assert.deepEqual(release.telemetry.compressorSelections, [
    {
      phase: "release",
      triggered: false,
      threshold: 10_000,
      releaseFrames: 3,
      positionBefore: 3,
      positionAfter: 2,
      entryIndex: 13,
      tableAddress: 0x4000_5040,
    },
  ]);
  assert.ok(release.output.main.samples.every(sample => sample === 75));
  assert.equal(release.telemetry.mainHash, "0xbbe8eec5");

  const retrigger = run({
    sample: -20_000,
    threshold: 10_000,
    compressorPosition: release.compressorPosition,
  });
  assert.equal(retrigger.ok, true);
  assert.equal(retrigger.compressorPosition, 3);
  assert.equal(
    retrigger.telemetry.compressorSelections[0].entryIndex,
    2,
  );
  assert.equal(
    retrigger.telemetry.compressorSelections[0].tableAddress,
    0x4000_4280,
  );
  assert.ok(
    retrigger.output.main.samples.every(sample => sample === -5_000),
  );
  assert.equal(retrigger.telemetry.mainHash, "0xd222d5c5");

  const bypass = run({ sample: 10_000, threshold: 10_000 });
  assert.equal(bypass.ok, true);
  assert.equal(bypass.compressorPosition, 0);
  assert.deepEqual(bypass.telemetry.compressorSelections, [
    {
      phase: "bypass",
      triggered: false,
      threshold: 10_000,
      releaseFrames: 3,
      positionBefore: 0,
      positionAfter: 0,
      entryIndex: null,
      tableAddress: null,
    },
  ]);
  assert.ok(bypass.output.main.samples.every(sample => sample === 10_000));
  assert.equal(bypass.telemetry.compressorBypassFrames, 1);
});

test("compressor uses signed-64 Q15 arithmetic and INT32_MIN triggers", () => {
  const mram = new Uint8Array(0x5000);
  const left = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const right = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const surround = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  left.fill(1);
  right.fill(-1);
  left[0] = -0x8000_0000;
  right[0] = 0x7fff_ffff;
  writeCompressorEntry(mram, 0x1000, 0, frame =>
    frame === 0 ? 0xffff : 0x8000);

  const result = executeAxMainBusReference({
    mram,
    initialMainBus: { left, right, surround },
    commands: [
      compressor({
        threshold: 0xffff,
        releaseFrames: 0,
        tableAddress: 0x1000,
      }),
      output(0x3000, 0x3800),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.compressorPosition, 0);
  assert.equal(result.telemetry.compressorAttackFrames, 1);
  assert.equal(result.output.main.samples[0], -0x8000);
  assert.equal(result.output.main.samples[1], 0x7fff);
  assert.equal(result.output.main.samples[2], -1);
  assert.equal(result.output.main.samples[3], 1);
  assert.equal(result.telemetry.mainHash, "0x0cc88232");
});

test("late range failures reject atomically without writes or state advance", () => {
  const mram = new Uint8Array(0x4000);
  const samples = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  samples.fill(2_000);
  writeMainInput(mram, 0x100, samples);
  writeCompressorEntry(mram, 0x1000, 0, 0x4000);
  const before = new Uint8Array(mram);

  const result = executeAxMainBusReference({
    mram,
    compressorPosition: 0,
    commands: [
      setLr(0x8000_0100),
      compressor({
        threshold: 100,
        releaseFrames: 3,
        tableAddress: 0x1000,
      }),
      compressor({
        threshold: 100,
        releaseFrames: 3,
        tableAddress: 0x3f00,
      }),
      output(0x2000, 0x2800),
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      reason: "mram-range-out-of-bounds",
      commandIndex: 2,
      code: AX_MAIN_BUS_COMMAND.COMPRESSOR,
      role: "attack-compressor-table",
      address: 0x42c0,
      byteLength: 320,
      mramLength: 0x4000,
    },
  });
  assert.equal("writes" in result, false);
  assert.equal("output" in result, false);
  assert.equal("compressorPosition" in result, false);
  assert.deepEqual(mram, before);
});

test("invalid commands and MRAM ranges fail closed at bounded envelopes", () => {
  const mram = new Uint8Array(0x4000);
  const validOutput = output(0x1000, 0x1800);

  const fixtures = [
    {
      name: "input range",
      commands: [setLr(0x8000_3f00), validOutput],
      reason: "mram-range-out-of-bounds",
    },
    {
      name: "upload range",
      commands: [uploadLrs(0x8000_3f00), validOutput],
      reason: "mram-range-out-of-bounds",
    },
    {
      name: "AUX-B return range",
      commands: [mixAuxBNoWrite(0x8000_3f00), validOutput],
      reason: "mram-range-out-of-bounds",
    },
    {
      name: "output range",
      commands: [output(0x3f00, 0x1000)],
      reason: "mram-range-out-of-bounds",
    },
    {
      name: "output is final",
      commands: [validOutput, setLr(0x100)],
      reason: "output-not-final",
    },
    {
      name: "unsupported",
      commands: [{ code: 0x13 }, validOutput],
      reason: "unsupported-command",
    },
    {
      name: "missing output",
      commands: [setLr(0x100)],
      reason: "missing-output",
    },
    {
      name: "command count",
      commands: Array.from(
        { length: AX_MAIN_BUS_LIMITS.maximumCommands + 1 },
        () => setLr(0x100),
      ),
      reason: "invalid-command-count",
    },
  ];

  for (const fixture of fixtures) {
    const before = new Uint8Array(mram);
    const result = executeAxMainBusReference({
      mram,
      commands: fixture.commands,
    });
    assert.equal(result.ok, false, fixture.name);
    assert.equal(result.error.reason, fixture.reason, fixture.name);
    assert.equal("writes" in result, false, fixture.name);
    assert.deepEqual(mram, before, fixture.name);
  }
});

test("top-level buffers and persistent state are strictly bounded", () => {
  const mram = new Uint8Array(0x2000);
  const commands = [output(0x1000, 0x1400)];

  assert.throws(
    () => executeAxMainBusReference({
      mram,
      commands,
      compressorPosition: -1,
    }),
    /compressorPosition must be an unsigned 16-bit integer/,
  );
  assert.throws(
    () => executeAxMainBusReference({
      mram,
      commands,
      initialMainBus: {
        left: new Int32Array(159),
        right: new Int32Array(160),
        surround: new Int32Array(160),
      },
    }),
    /initialMainBus.left must contain exactly 160 samples/,
  );
  assert.throws(
    () => executeAxMainBusReference({
      mram: new Uint8Array(),
      commands,
    }),
    /mram length must be between 1 and/,
  );
});
