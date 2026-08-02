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

function mixAuxA(writeAddress, readAddress) {
  return {
    code: AX_MAIN_BUS_COMMAND.MIX_AUXA,
    writeAddress,
    readAddress,
  };
}

function mixAuxB(writeAddress, readAddress) {
  return {
    code: AX_MAIN_BUS_COMMAND.MIX_AUXB,
    writeAddress,
    readAddress,
  };
}

function uploadLrs(address) {
  return { code: AX_MAIN_BUS_COMMAND.UPLOAD_LRS, address };
}

function mixAuxBNoWrite(address) {
  return { code: AX_MAIN_BUS_COMMAND.MIX_AUXB_NOWRITE, address };
}

function mixAuxBLr(writeAddress, readAddress) {
  return {
    code: AX_MAIN_BUS_COMMAND.MIX_AUXB_LR,
    writeAddress,
    readAddress,
  };
}

function processCommand() {
  return { code: AX_MAIN_BUS_COMMAND.PROCESS };
}

const ACCUMULATOR_BUSES = ["main", "auxA", "auxB"];
const ACCUMULATOR_PLANES = ["left", "right", "surround"];

function cloneAccumulatorBuses(accumulators = null, overrides = {}) {
  return {
    frames: AX_MAIN_BUS_LIMITS.frames,
    ...Object.fromEntries(ACCUMULATOR_BUSES.map(bus => [
      bus,
      Object.fromEntries(
        ACCUMULATOR_PLANES.map(plane => [
          plane,
          new Int32Array(
            overrides[bus]?.[plane]
              ?? accumulators?.[bus]?.[plane]
              ?? AX_MAIN_BUS_LIMITS.frames,
          ),
        ]),
      ),
    ])),
  };
}

function accumulatorPlanes(accumulators) {
  return ACCUMULATOR_BUSES.flatMap(
    bus => ACCUMULATOR_PLANES.map(plane => accumulators[bus][plane]),
  );
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
    MIX_AUXA: 0x04,
    MIX_AUXB: 0x05,
    UPLOAD_LRS: 0x06,
    SET_LR: 0x07,
    MIX_AUXB_NOWRITE: 0x09,
    OUTPUT: 0x0e,
    MIX_AUXB_LR: 0x10,
    SET_OPPOSITE_LR: 0x11,
    COMPRESSOR: 0x12,
  });
  assert.equal(AX_MAIN_BUS_LIMITS.frames, 160);
  assert.equal(AX_MAIN_BUS_LIMITS.samplesPerMillisecond, 32);
  assert.equal(AX_MAIN_BUS_LIMITS.milliseconds, 5);
  assert.equal(AX_MAIN_BUS_LIMITS.compressorEntryBytes, 320);
  assert.equal(AX_MAIN_BUS_LIMITS.attackEntryCount, 11);
  assert.equal(AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes, 640);
  assert.equal(AX_MAIN_BUS_LIMITS.accumulatorLrBytes, 1_280);
  assert.equal(AX_MAIN_BUS_LIMITS.accumulatorLrsBytes, 1_920);
});

test("CMD_MIX_AUXA/B upload planar s32-BE and wrap returns into MAIN", () => {
  const mram = new Uint8Array(0x12_000);
  const mainLeft = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const mainRight = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  const mainSurround = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
  mainLeft.fill(0x7fff_ffff);
  mainRight.fill(-0x8000_0000);

  const auxA = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (0x1020_3040 + frame * 0x0102_0304) | 0,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (-0x1020_3040 - frame * 0x0002_0305) | 0,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (0x5060_7080 - frame * 0x0001_0203) | 0,
    ),
  };
  const auxB = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (0x3141_5926 - frame * 65_537) | 0,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (-0x2718_2818 + frame * 131_071) | 0,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (frame * 0x0011_2233) | 0,
    ),
  };
  const returnA = {
    left: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(1),
    right: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(-1),
    surround: new Int32Array(
      AX_MAIN_BUS_LIMITS.frames,
    ).fill(0x3f80_0000),
  };
  const returnB = {
    left: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(-1),
    right: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(1),
    surround: new Int32Array(AX_MAIN_BUS_LIMITS.frames).fill(2),
  };
  writeLrsInput(mram, 0x4000, returnA);
  writeLrsInput(mram, 0x5000, returnB);
  const before = new Uint8Array(mram);

  const result = executeAxMainBusReference({
    mram,
    initialMainBus: {
      left: mainLeft,
      right: mainRight,
      surround: mainSurround,
    },
    initialAuxBuses: { auxA, auxB },
    commands: [
      mixAuxA(0x8000_1000, 0x4000_4000),
      mixAuxB(0xc000_2000, 0x8000_5000),
      output(0x8000, 0x9000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  assert.equal(result.uploads.length, 2);
  assert.deepEqual(
    result.uploads.map(upload => [
      upload.sequence,
      upload.commandIndex,
      upload.kind,
      upload.logicalAddress,
      upload.physicalAddress,
      upload.byteLength,
    ]),
    [
      [0, 0, "aux-a-lrs-s32-be", 0x8000_1000, 0x1000, 1_920],
      [1, 1, "aux-b-lrs-s32-be", 0xc000_2000, 0x2000, 1_920],
    ],
  );
  for (const [uploadIndex, bus] of [[0, auxA], [1, auxB]]) {
    const uploadView = new DataView(result.uploads[uploadIndex].data.buffer);
    for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
      assert.equal(uploadView.getInt32(frame * 4, false), bus.left[frame]);
      assert.equal(
        uploadView.getInt32(
          AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
          false,
        ),
        bus.right[frame],
      );
      assert.equal(
        uploadView.getInt32(
          2 * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
          false,
        ),
        bus.surround[frame],
      );
    }
  }

  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      result.output.main.samples[frame * 2],
      -0x8000,
      "right wraps through INT32_MAX then back to INT32_MIN",
    );
    assert.equal(
      result.output.main.samples[frame * 2 + 1],
      0x7fff,
      "left wraps through INT32_MIN then back to INT32_MAX",
    );
    assert.equal(
      result.output.surround.samples[frame],
      0x3f80_0002,
      "0x3f800000 is an integer accumulator word, not float 1.0",
    );
  }
  assert.equal(result.telemetry.initialAuxBuses, "provided");
  assert.equal(result.telemetry.mixAuxACommands, 1);
  assert.equal(result.telemetry.mixAuxBCommands, 1);
  assert.equal(result.telemetry.auxMixCommands, 2);
  assert.equal(result.telemetry.auxUploadCommands, 2);
  assert.equal(result.telemetry.auxUploadWriteBytes, 3_840);
  assert.equal(result.telemetry.mainUploadWriteBytes, 0);
  assert.equal(result.telemetry.uploadWriteBytes, 3_840);
  assert.equal(result.telemetry.auxReturnReadBytes, 3_840);
  assert.equal(result.telemetry.transactionWriteBytes, 5_120);
  assert.deepEqual(result.telemetry.auxMixSelections, [
    {
      commandIndex: 0,
      code: AX_MAIN_BUS_COMMAND.MIX_AUXA,
      bus: "A",
      uploaded: true,
      writeLogicalAddress: 0x8000_1000,
      writePhysicalAddress: 0x1000,
      writeBytes: 1_920,
      readLogicalAddress: 0x4000_4000,
      readPhysicalAddress: 0x4000,
      readBytes: 1_920,
    },
    {
      commandIndex: 1,
      code: AX_MAIN_BUS_COMMAND.MIX_AUXB,
      bus: "B",
      uploaded: true,
      writeLogicalAddress: 0xc000_2000,
      writePhysicalAddress: 0x2000,
      writeBytes: 1_920,
      readLogicalAddress: 0x8000_5000,
      readPhysicalAddress: 0x5000,
      readBytes: 1_920,
    },
  ]);
  assertExactOwnedResultBuffers(result, mram);
});

test("AUX uploads feed their own exact and partial aliased returns", () => {
  const mram = new Uint8Array(0x10_000);
  for (let address = 0; address < mram.length; address += 1) {
    mram[address] = (address * 37 + 11) & 0xff;
  }
  const auxA = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame * 7 - 500,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 700 - frame * 11,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame * 13 - 900,
    ),
  };
  const auxB = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (0x1020_3040 + frame * 0x0101_0101) | 0,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (-0x2030_4050 - frame * 0x0002_0305) | 0,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (0x5060_7080 - frame * 0x0001_0203) | 0,
    ),
  };
  const before = new Uint8Array(mram);

  const result = executeAxMainBusReference({
    mram,
    initialAuxBuses: { auxA, auxB },
    commands: [
      mixAuxA(0x8000_1000, 0xc000_1000),
      mixAuxB(0x4000_2000, 0x8000_2202),
      output(0x6000, 0x7000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  const stagedImage = applyWrites(mram, result.uploads);
  const stagedView = new DataView(stagedImage.buffer);
  const originalView = new DataView(mram.buffer);
  assert.notEqual(
    stagedView.getInt32(0x2202, false),
    originalView.getInt32(0x2202, false),
    "the partially aliased return starts in the staged AUX-B upload",
  );
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    const returnedLeft = stagedView.getInt32(
      0x2202 + frame * 4,
      false,
    );
    const returnedRight = stagedView.getInt32(
      0x2202
      + AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes
      + frame * 4,
      false,
    );
    const returnedSurround = stagedView.getInt32(
      0x2202
      + 2 * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes
      + frame * 4,
      false,
    );
    assert.equal(
      result.output.main.samples[frame * 2],
      clampSigned16((auxA.right[frame] + returnedRight) | 0),
    );
    assert.equal(
      result.output.main.samples[frame * 2 + 1],
      clampSigned16((auxA.left[frame] + returnedLeft) | 0),
    );
    assert.equal(
      result.output.surround.samples[frame],
      (auxA.surround[frame] + returnedSurround) | 0,
    );
  }
});

test("AUX write address zero skips, while cached physical zero uploads", () => {
  const mram = new Uint8Array(0x10_000);
  const returned = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame - 1_000,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 2_000 - frame * 3,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame * 5 - 3_000,
    ),
  };
  const outgoing = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 4_000 + frame * 7,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => -5_000 - frame * 11,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 6_000 + frame * 13,
    ),
  };
  const zeroAux = {
    left: new Int32Array(AX_MAIN_BUS_LIMITS.frames),
    right: new Int32Array(AX_MAIN_BUS_LIMITS.frames),
    surround: new Int32Array(AX_MAIN_BUS_LIMITS.frames),
  };
  writeLrsInput(mram, 0, returned);
  const before = new Uint8Array(mram);
  const initialAuxBuses = { auxA: outgoing, auxB: zeroAux };

  const skipped = executeAxMainBusReference({
    mram,
    initialAuxBuses,
    commands: [
      mixAuxA(0, 0),
      output(0x5000, 0x6000),
    ],
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.uploads.length, 0);
  assert.equal(skipped.telemetry.auxUploadCommands, 0);
  assert.equal(skipped.telemetry.uploadWriteBytes, 0);
  assert.deepEqual(skipped.telemetry.auxMixSelections, [
    {
      commandIndex: 0,
      code: AX_MAIN_BUS_COMMAND.MIX_AUXA,
      bus: "A",
      uploaded: false,
      writeLogicalAddress: 0,
      writePhysicalAddress: null,
      writeBytes: 0,
      readLogicalAddress: 0,
      readPhysicalAddress: 0,
      readBytes: 1_920,
    },
  ]);

  const aliased = executeAxMainBusReference({
    mram,
    initialAuxBuses,
    commands: [
      mixAuxA(0x8000_0000, 0),
      output(0x5000, 0x6000),
    ],
  });
  assert.equal(aliased.ok, true);
  assert.equal(aliased.uploads.length, 1);
  assert.equal(aliased.uploads[0].logicalAddress, 0x8000_0000);
  assert.equal(aliased.uploads[0].physicalAddress, 0);
  assert.equal(aliased.telemetry.auxUploadCommands, 1);
  assert.equal(aliased.telemetry.uploadWriteBytes, 1_920);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      skipped.output.main.samples[frame * 2],
      returned.right[frame],
    );
    assert.equal(
      skipped.output.main.samples[frame * 2 + 1],
      returned.left[frame],
    );
    assert.equal(
      skipped.output.surround.samples[frame],
      returned.surround[frame],
    );
    assert.equal(
      aliased.output.main.samples[frame * 2],
      outgoing.right[frame],
    );
    assert.equal(
      aliased.output.main.samples[frame * 2 + 1],
      outgoing.left[frame],
    );
    assert.equal(
      aliased.output.surround.samples[frame],
      outgoing.surround[frame],
    );
  }
  assert.deepEqual(mram, before);
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
    processMainBus: accumulators => {
      processInputs.push(accumulators);
      return cloneAccumulatorBuses(accumulators, {
        main: { left: voiceLeft, right: voiceRight },
      });
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
  assert.deepEqual(processInputs[0].main.left, initialLeft);
  assert.deepEqual(processInputs[0].main.right, initialRight);
  assert.notEqual(processInputs[0].main.left.buffer, initialLeft.buffer);
  assert.notEqual(processInputs[0].main.right.buffer, initialRight.buffer);
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
  assert.equal(result.telemetry.auxMixCommands, 0);
  assert.equal(result.telemetry.auxReturnReadBytes, 1_920);
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
  assert.equal(result.telemetry.auxMixCommands, 0);
  assert.equal(result.telemetry.mixAuxBNoWriteCommands, 1);
  assert.equal(result.telemetry.auxReturnReadBytes, 1_920);
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

test("Metroid MIX_AUXB_LR uploads old AUXB, replaces it, and mixes MAIN", () => {
  const mram = new Uint8Array(0x10_000);
  const plane = (base, step) => Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (base + frame * step) | 0,
  );
  const initialMain = {
    left: plane(10_000, 11),
    right: plane(-20_000, -13),
    surround: plane(30_000, 17),
  };
  const initialAuxB = {
    left: plane(40_000, 19),
    right: plane(-50_000, -23),
    surround: plane(60_000, 29),
  };
  const effectReturn = {
    left: plane(70_000, 31),
    right: plane(-80_000, -37),
  };
  const opposite = plane(90_000, 41);
  const postmix = {
    left: plane(1_000, 3),
    right: plane(-2_000, -5),
    surround: plane(3_000, 7),
  };
  writeMainInput(mram, 0x2000, effectReturn.left);
  writeMainInput(
    mram,
    0x2000 + AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes,
    effectReturn.right,
  );
  writeMainInput(mram, 0x4000, opposite);
  writeLrsInput(mram, 0x5000, postmix);
  const before = new Uint8Array(mram);

  const result = executeAxMainBusReference({
    mram,
    initialMainBus: initialMain,
    initialAuxBuses: {
      auxA: {
        left: new Int32Array(160),
        right: new Int32Array(160),
        surround: new Int32Array(160),
      },
      auxB: initialAuxB,
    },
    commands: [
      mixAuxBLr(0x1000, 0x2000),
      uploadLrs(0x3000),
      setOppositeLr(0x4000),
      mixAuxBNoWrite(0x5000),
      output(0x6000, 0x7000),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before, "the authority returns atomic writes");
  assert.deepEqual(
    result.writes.map(write => [
      write.sequence,
      write.commandIndex,
      write.kind,
      write.physicalAddress,
      write.byteLength,
    ]),
    [
      [0, 0, "aux-b-lr-s32-be", 0x1000, 1_280],
      [1, 1, "main-lrs-s32-be", 0x3000, 1_920],
      [2, 4, "surround-s32-be", 0x7000, 640],
      [3, 4, "main-rl-s16-be", 0x6000, 640],
    ],
  );
  const auxUpload = new DataView(result.uploads[0].data.buffer);
  const mainUpload = new DataView(result.uploads[1].data.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(auxUpload.getInt32(frame * 4, false), initialAuxB.left[frame]);
    assert.equal(
      auxUpload.getInt32(
        AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
        false,
      ),
      initialAuxB.right[frame],
    );
    assert.equal(
      mainUpload.getInt32(frame * 4, false),
      (initialMain.left[frame] + effectReturn.left[frame]) | 0,
    );
    assert.equal(
      mainUpload.getInt32(
        AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
        false,
      ),
      (initialMain.right[frame] + effectReturn.right[frame]) | 0,
    );
    assert.equal(
      mainUpload.getInt32(
        2 * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
        false,
      ),
      initialMain.surround[frame],
    );
    assert.equal(
      result.output.main.samples[frame * 2],
      clampSigned16((opposite[frame] + postmix.right[frame]) | 0),
    );
    assert.equal(
      result.output.main.samples[frame * 2 + 1],
      clampSigned16((((-opposite[frame]) | 0) + postmix.left[frame]) | 0),
    );
    assert.equal(result.output.surround.samples[frame], postmix.surround[frame]);
  }
  assert.equal(result.telemetry.mixAuxBLrCommands, 1);
  assert.equal(result.telemetry.auxUploadCommands, 1);
  assert.equal(result.telemetry.auxBLrUploadWriteBytes, 1_280);
  assert.equal(result.telemetry.auxUploadWriteBytes, 1_280);
  assert.equal(result.telemetry.mainUploadWriteBytes, 1_920);
  assert.equal(result.telemetry.uploadWriteBytes, 3_200);
  assert.equal(result.telemetry.auxReturnReadBytes, 3_200);
  assert.equal(result.telemetry.transactionWriteBytes, 4_480);
});

test("full WarioWare 04/05 main-bus body stages three uploads", () => {
  // Runtime owns the surrounding zero SETUP (00) and END (0f). This is the
  // complete authority-model body: 04,05,06,11,09,0e.
  const mram = new Uint8Array(0x12_000);
  const auxAReturn = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame * 101 - 8_000,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 9_000 - frame * 103,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 0x1234_0000 + frame * 257,
    ),
  };
  const auxBReturn = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 5_000 - frame * 107,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame * 109 - 6_000,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => (-0x0123_0000 - frame * 263) | 0,
    ),
  };
  const opposite = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => frame * 10_003 - 800_000,
  );
  const postmix = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame * 3 - 200,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 300 - frame * 5,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => frame * 7 - 400,
    ),
  };
  writeLrsInput(mram, 0x3000, auxAReturn);
  writeLrsInput(mram, 0x4000, auxBReturn);
  writeMainInput(mram, 0x6000, opposite);
  writeLrsInput(mram, 0x7000, postmix);
  const before = new Uint8Array(mram);
  let processCalls = 0;

  const result = executeAxMainBusReference({
    mram,
    processMainBus: () => {
      processCalls += 1;
      throw new Error("WarioWare main-bus-only path must not process voices");
    },
    commands: [
      mixAuxA(0x8000_1000, 0x4000_3000),
      mixAuxB(0xc000_2000, 0x8000_4000),
      uploadLrs(0x4000_5000),
      setOppositeLr(0xc000_6000),
      mixAuxBNoWrite(0x8000_7000),
      output(0xa000, 0x9000),
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(processCalls, 0);
  assert.deepEqual(mram, before);
  assert.deepEqual(
    result.writes.map(write => [
      write.sequence,
      write.commandIndex,
      write.kind,
      write.physicalAddress,
      write.byteLength,
    ]),
    [
      [0, 0, "aux-a-lrs-s32-be", 0x1000, 1_920],
      [1, 1, "aux-b-lrs-s32-be", 0x2000, 1_920],
      [2, 2, "main-lrs-s32-be", 0x5000, 1_920],
      [3, 5, "surround-s32-be", 0x9000, 640],
      [4, 5, "main-rl-s16-be", 0xa000, 640],
    ],
  );
  assert.ok(result.uploads[0].data.every(value => value === 0));
  assert.ok(result.uploads[1].data.every(value => value === 0));
  const mainUploadView = new DataView(result.uploads[2].data.buffer);
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      mainUploadView.getInt32(frame * 4, false),
      (auxAReturn.left[frame] + auxBReturn.left[frame]) | 0,
    );
    assert.equal(
      mainUploadView.getInt32(
        AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
        false,
      ),
      (auxAReturn.right[frame] + auxBReturn.right[frame]) | 0,
    );
    assert.equal(
      mainUploadView.getInt32(
        2 * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
        false,
      ),
      (auxAReturn.surround[frame] + auxBReturn.surround[frame]) | 0,
    );
    assert.equal(
      result.output.main.samples[frame * 2],
      clampSigned16((opposite[frame] + postmix.right[frame]) | 0),
    );
    assert.equal(
      result.output.main.samples[frame * 2 + 1],
      clampSigned16(
        (((-opposite[frame]) | 0) + postmix.left[frame]) | 0,
      ),
    );
    assert.equal(
      result.output.surround.samples[frame],
      postmix.surround[frame],
    );
  }
  assert.equal(result.telemetry.initialAuxBuses, "zero");
  assert.equal(result.telemetry.commands, 6);
  assert.equal(result.telemetry.processCommands, 0);
  assert.equal(result.telemetry.mixAuxACommands, 1);
  assert.equal(result.telemetry.mixAuxBCommands, 1);
  assert.equal(result.telemetry.auxMixCommands, 2);
  assert.equal(result.telemetry.auxUploadCommands, 2);
  assert.equal(result.telemetry.uploadLrsCommands, 1);
  assert.equal(result.telemetry.mixAuxBNoWriteCommands, 1);
  assert.equal(result.telemetry.auxReturnReadBytes, 5_760);
  assert.equal(result.telemetry.auxUploadWriteBytes, 3_840);
  assert.equal(result.telemetry.mainUploadWriteBytes, 1_920);
  assert.equal(result.telemetry.uploadWriteBytes, 5_760);
  assert.equal(result.telemetry.outputWriteBytes, 1_280);
  assert.equal(result.telemetry.transactionWriteBytes, 7_040);
  assert.equal(
    result.telemetry.transactionHash,
    fnv1a(result.writes.map(write => write.data)),
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
    processMainBus: accumulators => {
      callbackInputs = accumulators;
      const { left, right } = accumulators.main;
      const renderedLeft = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      const renderedRight = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      for (let frame = 0; frame < renderedLeft.length; frame += 1) {
        assert.equal(left[frame], samples[frame]);
        assert.equal(right[frame], samples[frame]);
        renderedLeft[frame] = left[frame] + 1_000;
        renderedRight[frame] = right[frame] - 500;
      }
      callbackOutputs = cloneAccumulatorBuses(accumulators, {
        main: { left: renderedLeft, right: renderedRight },
      });
      return callbackOutputs;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before);
  assert.ok(callbackInputs.main.left instanceof Int32Array);
  assert.ok(callbackInputs.main.right instanceof Int32Array);
  assert.equal(callbackInputs.main.left.length, AX_MAIN_BUS_LIMITS.frames);
  assert.equal(callbackInputs.main.left.byteOffset, 0);
  assert.equal(callbackInputs.main.left.buffer.byteLength, 640);
  assert.equal(accumulatorPlanes(callbackInputs).length, 9);
  assert.equal(
    new Set(accumulatorPlanes(callbackInputs).map(plane => plane.buffer)).size,
    9,
  );
  assert.notEqual(callbackInputs.main.left.buffer, mram.buffer);
  assert.notEqual(callbackInputs.main.right.buffer, mram.buffer);

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
  callbackOutputs.main.left.fill(0x7fff_ffff);
  callbackOutputs.main.right.fill(-0x8000_0000);
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
    processMainBus: accumulators => {
      processCalls += 1;
      const { left, right } = accumulators.main;
      assert.ok(left.every(sample => sample === 111));
      assert.ok(right.every(sample => sample === 222));
      const renderedLeft = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      const renderedRight = new Int32Array(AX_MAIN_BUS_LIMITS.frames);
      renderedLeft.fill(30_000);
      renderedRight.fill(-30_000);
      return cloneAccumulatorBuses(accumulators, {
        main: { left: renderedLeft, right: renderedRight },
      });
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

test("PROCESS consumes a complete nine-plane result including surround", () => {
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
    processMainBus: accumulators => {
      const {
        left: inputLeft,
        right: inputRight,
      } = accumulators.main;
      const renderedLeft = new Int32Array(inputLeft);
      const renderedRight = new Int32Array(inputRight);
      const renderedSurround = new Int32Array(
        accumulators.main.surround,
      );
      for (let frame = 0; frame < renderedLeft.length; frame += 1) {
        renderedLeft[frame] += 2_000;
        renderedRight[frame] -= 3_000;
        renderedSurround[frame] = (~renderedSurround[frame]) | 0;
      }
      return cloneAccumulatorBuses(accumulators, {
        main: {
          left: renderedLeft,
          right: renderedRight,
          surround: renderedSurround,
        },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.output.surround.samples,
    Int32Array.from(surround, sample => (~sample) | 0),
  );
  assert.equal(result.telemetry.processCommands, 1);
  assert.equal(result.telemetry.surroundHash, "0xaccccdf3");
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
      callback: accumulators => accumulators,
      reason: "invalid-process-result",
    },
    {
      name: "missing frames",
      callback: () => {
        const result = cloneAccumulatorBuses();
        delete result.frames;
        return result;
      },
      reason: "invalid-process-result",
    },
    {
      name: "partial buses",
      callback: () => ({
        frames: AX_MAIN_BUS_LIMITS.frames,
        main: cloneAccumulatorBuses().main,
      }),
      reason: "invalid-process-result",
    },
    {
      name: "wrong length",
      callback: () => {
        const result = cloneAccumulatorBuses();
        result.auxA.surround = new Int32Array(159);
        return result;
      },
      reason: "invalid-process-result",
    },
    {
      name: "shared output",
      callback: () => {
        const result = cloneAccumulatorBuses();
        result.auxB.left = result.main.right;
        return result;
      },
      reason: "invalid-process-result",
    },
    {
      name: "initial input alias",
      callback: () => {
        const result = cloneAccumulatorBuses();
        result.main.left = initialLeft;
        return result;
      },
      reason: "invalid-process-result",
    },
    {
      name: "MRAM alias",
      callback: () => {
        const result = cloneAccumulatorBuses();
        result.auxB.right = new Int32Array(mram.buffer, 0, 160);
        return result;
      },
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
      return cloneAccumulatorBuses();
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

test("observed Wario 10-command PROCESS+AUX body routes nine planes", () => {
  const observedCommandList = {
    sizeWords: 64,
    paddingWords: 32,
    commandCodes: [
      0x00,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x11,
      0x09,
      0x0e,
      0x0f,
    ],
  };
  assert.equal(observedCommandList.sizeWords, 64);
  assert.equal(observedCommandList.paddingWords, 32);
  assert.equal(observedCommandList.commandCodes.length, 10);
  const commands = [
    processCommand(),
    mixAuxA(0x8000_1000, 0x4000_3000),
    mixAuxB(0xc000_2000, 0x8000_4000),
    uploadLrs(0x4000_5000),
    setOppositeLr(0xc000_6000),
    mixAuxBNoWrite(0x8000_7000),
    output(0xa000, 0x9000),
  ];
  assert.deepEqual(
    commands.map(command => command.code),
    observedCommandList.commandCodes.slice(2, -1),
    "SETUP, PB address, and END stay in the surrounding command parser",
  );

  const mram = new Uint8Array(0x12_000);
  const patternedPlane = (base, step) => Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => (base + frame * step) | 0,
  );
  const voiceResult = cloneAccumulatorBuses(null, {
    main: {
      left: patternedPlane(0x1020_3040, 0x0102_0304),
      right: patternedPlane(-0x1020_3040, -0x0002_0305),
      surround: patternedPlane(0x5060_7080, -0x0001_0203),
    },
    auxA: {
      left: patternedPlane(0x3141_5926, -65_537),
      right: patternedPlane(-0x2718_2818, 131_071),
      surround: patternedPlane(0, 0x0011_2233),
    },
    auxB: {
      left: patternedPlane(-0x1234_5678, 17_003),
      right: patternedPlane(0x2345_6789, -19_009),
      surround: patternedPlane(-0x3456_7890, 23_011),
    },
  });
  const auxAReturn = {
    left: patternedPlane(7_000, 101),
    right: patternedPlane(-8_000, -103),
    surround: patternedPlane(9_000, 107),
  };
  const auxBReturn = {
    left: patternedPlane(-10_000, 109),
    right: patternedPlane(11_000, -113),
    surround: patternedPlane(-12_000, 127),
  };
  voiceResult.main.left[0] = 0x7fff_ffff;
  voiceResult.main.right[0] = -0x8000_0000;
  voiceResult.main.surround[0] = 0x7fff_ffff;
  auxAReturn.left[0] = 1;
  auxAReturn.right[0] = -1;
  auxAReturn.surround[0] = 1;
  auxBReturn.left[0] = -1;
  auxBReturn.right[0] = 1;
  auxBReturn.surround[0] = -1;

  const opposite = patternedPlane(-800_000, 10_003);
  const postmix = {
    left: patternedPlane(-200, 3),
    right: patternedPlane(300, -5),
    surround: patternedPlane(-400, 7),
  };
  opposite[0] = -0x8000_0000;
  postmix.left[0] = -1;
  postmix.right[0] = -1;
  writeLrsInput(mram, 0x3000, auxAReturn);
  writeLrsInput(mram, 0x4000, auxBReturn);
  writeMainInput(mram, 0x6000, opposite);
  writeLrsInput(mram, 0x7000, postmix);
  const before = new Uint8Array(mram);
  let processInput = null;

  const result = executeAxMainBusReference({
    mram,
    commands,
    processMainBus: accumulators => {
      processInput = accumulators;
      return voiceResult;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before, "the transaction stays authority-only");
  assert.equal(processInput.frames, AX_MAIN_BUS_LIMITS.frames);
  assert.equal(accumulatorPlanes(processInput).length, 9);
  assert.equal(
    new Set(accumulatorPlanes(processInput).map(plane => plane.buffer)).size,
    9,
    "all callback input planes own distinct exact buffers",
  );
  for (const plane of accumulatorPlanes(processInput)) {
    assert.equal(plane.length, AX_MAIN_BUS_LIMITS.frames);
    assert.equal(plane.byteOffset, 0);
    assert.equal(plane.byteLength, AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes);
    assert.equal(plane.buffer.byteLength, plane.byteLength);
    assert.ok(plane.every(sample => sample === 0));
  }
  assert.equal(voiceResult.frames, AX_MAIN_BUS_LIMITS.frames);
  assert.equal(
    new Set(accumulatorPlanes(voiceResult).map(plane => plane.buffer)).size,
    9,
    "all supplied voice-result planes own distinct exact buffers",
  );
  for (const plane of accumulatorPlanes(voiceResult)) {
    assert.equal(plane.length, AX_MAIN_BUS_LIMITS.frames);
    assert.equal(plane.byteOffset, 0);
    assert.equal(plane.byteLength, AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes);
    assert.equal(plane.buffer.byteLength, plane.byteLength);
  }

  assert.deepEqual(
    result.writes.map(write => [
      write.sequence,
      write.commandIndex,
      write.kind,
      write.physicalAddress,
      write.byteLength,
    ]),
    [
      [0, 1, "aux-a-lrs-s32-be", 0x1000, 1_920],
      [1, 2, "aux-b-lrs-s32-be", 0x2000, 1_920],
      [2, 3, "main-lrs-s32-be", 0x5000, 1_920],
      [3, 6, "surround-s32-be", 0x9000, 640],
      [4, 6, "main-rl-s16-be", 0xa000, 640],
    ],
  );
  assert.equal(
    result.writes.reduce((total, write) => total + write.byteLength, 0),
    7_040,
  );

  for (const [uploadIndex, bus] of [[0, "auxA"], [1, "auxB"]]) {
    const upload = result.uploads[uploadIndex];
    const view = new DataView(upload.data.buffer);
    assert.equal(upload.byteLength, 1_920);
    for (let channel = 0; channel < ACCUMULATOR_PLANES.length; channel += 1) {
      const plane = voiceResult[bus][ACCUMULATOR_PLANES[channel]];
      for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
        assert.equal(
          view.getInt32(
            channel * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
            false,
          ),
          plane[frame],
        );
      }
    }
  }

  const mainUpload = new DataView(result.uploads[2].data.buffer);
  const returns = [auxAReturn, auxBReturn];
  for (let channel = 0; channel < ACCUMULATOR_PLANES.length; channel += 1) {
    const plane = ACCUMULATOR_PLANES[channel];
    for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
      const expected = (
        (
          (voiceResult.main[plane][frame] + returns[0][plane][frame])
          | 0
        )
        + returns[1][plane][frame]
      ) | 0;
      assert.equal(
        mainUpload.getInt32(
          channel * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes + frame * 4,
          false,
        ),
        expected,
      );
    }
  }
  assert.equal(mainUpload.getInt32(0, false), 0x7fff_ffff);
  assert.equal(
    mainUpload.getInt32(AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes, false),
    -0x8000_0000,
  );
  assert.equal(
    mainUpload.getInt32(2 * AX_MAIN_BUS_LIMITS.accumulatorPlaneBytes, false),
    0x7fff_ffff,
  );

  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    assert.equal(
      result.output.main.samples[frame * 2],
      clampSigned16((opposite[frame] + postmix.right[frame]) | 0),
    );
    assert.equal(
      result.output.main.samples[frame * 2 + 1],
      clampSigned16((((-opposite[frame]) | 0) + postmix.left[frame]) | 0),
    );
    assert.equal(
      result.output.surround.samples[frame],
      postmix.surround[frame],
    );
  }
  assert.equal(result.telemetry.commands, 7);
  assert.equal(result.telemetry.processCommands, 1);
  assert.equal(result.telemetry.auxMixCommands, 2);
  assert.deepEqual(
    result.telemetry.auxMixSelections.map(selection => selection.readBytes),
    [1_920, 1_920],
  );
  assert.equal(result.telemetry.auxUploadWriteBytes, 3_840);
  assert.equal(result.telemetry.auxReturnReadBytes, 5_760);
  assert.equal(result.telemetry.transactionWriteBytes, 7_040);

  const retainedAuxSample = new DataView(
    result.uploads[0].data.buffer,
  ).getInt32(0, false);
  voiceResult.auxA.left.fill(0);
  assert.equal(
    new DataView(result.uploads[0].data.buffer).getInt32(0, false),
    retainedAuxSample,
    "later callback-owned mutations cannot alter staged writes",
  );
});

test("Melee SET_LR and dual-AUX body is a bounded certified topology", () => {
  const mram = new Uint8Array(0x8000);
  const input = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => frame * 17 - 1_000,
  );
  writeMainInput(mram, 0x100, input);
  const before = new Uint8Array(mram);
  let processCalls = 0;

  const result = executeAxMainBusReference({
    mram,
    commands: [
      setLr(0x100),
      processCommand(),
      mixAuxA(0x1000, 0x2000),
      mixAuxB(0x3000, 0x4000),
      output(0x5000, 0x6000),
    ],
    processMainBus: accumulators => {
      processCalls += 1;
      assert.deepEqual(
        Array.from(accumulators.main.left),
        Array.from(input),
      );
      assert.deepEqual(
        Array.from(accumulators.main.right),
        Array.from(input),
      );
      assert.ok(accumulators.main.surround.every(value => value === 0));
      return cloneAccumulatorBuses(accumulators);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(processCalls, 1);
  assert.equal(result.telemetry.commands, 5);
  assert.equal(result.telemetry.processCommands, 1);
  assert.equal(result.telemetry.setLrCommands, 1);
  assert.equal(result.telemetry.mixAuxACommands, 1);
  assert.equal(result.telemetry.mixAuxBCommands, 1);
  assert.equal(result.telemetry.auxMixCommands, 2);
  assert.equal(result.telemetry.auxUploadCommands, 2);
  assert.equal(result.telemetry.auxUploadWriteBytes, 3_840);
  assert.equal(result.telemetry.auxReturnReadBytes, 3_840);
  assert.equal(result.telemetry.transactionWriteBytes, 5_120);
  assert.equal(result.uploads.length, 2);
  assert.equal(result.writes.length, 4);
  assert.deepEqual(mram, before);
});

test("F-Zero SET_LR dual-AUX compressor body is exact and ordered", () => {
  // The surrounding parser owns SETUP, PB address, and END. This authority
  // receives the observed recurring body 07,03,04,05,12,0e.
  const commands = [
    setLr(0x8000_1000),
    processCommand(),
    mixAuxA(0x8000_4000, 0x4000_6000),
    mixAuxB(0xc000_8000, 0x8000_a000),
    compressor({
      threshold: 10_000,
      releaseFrames: 7,
      tableAddress: 0x4000_c000,
    }),
    output(0x8001_0000, 0xc001_1000),
  ];
  assert.deepEqual(
    commands.map(command => command.code),
    [0x07, 0x03, 0x04, 0x05, 0x12, 0x0e],
  );

  const mram = new Uint8Array(0x14_000);
  const input = Int32Array.from(
    { length: AX_MAIN_BUS_LIMITS.frames },
    (_unused, frame) => 3_000 + frame * 2,
  );
  const auxAReturn = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 2_000 + frame * 4,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 1_800 + frame * 6,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 100 + frame * 8,
    ),
  };
  const auxBReturn = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 5_600 + frame * 10,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 6_200 + frame * 12,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => -200 + frame * 14,
    ),
  };
  const outgoingAuxA = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => -7_000 + frame * 22,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 8_000 - frame * 24,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 9_000 + frame * 26,
    ),
  };
  const outgoingAuxB = {
    left: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 11_000 + frame * 28,
    ),
    right: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => -12_000 + frame * 30,
    ),
    surround: Int32Array.from(
      { length: AX_MAIN_BUS_LIMITS.frames },
      (_unused, frame) => 13_000 - frame * 32,
    ),
  };
  writeMainInput(mram, 0x1000, input);
  writeLrsInput(mram, 0x6000, auxAReturn);
  writeLrsInput(mram, 0xa000, auxBReturn);
  writeCompressorEntry(mram, 0xc000, 0, 0x4000);
  const before = new Uint8Array(mram);

  let processInput = null;
  const result = executeAxMainBusReference({
    mram,
    commands,
    processMainBus: accumulators => {
      processInput = accumulators;
      return cloneAccumulatorBuses(accumulators, {
        auxA: outgoingAuxA,
        auxB: outgoingAuxB,
      });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(mram, before, "the authority model must not mutate MRAM");
  assert.deepEqual(processInput.main.left, input);
  assert.deepEqual(processInput.main.right, input);
  assert.ok(processInput.main.surround.every(value => value === 0));
  for (const bus of ["auxA", "auxB"]) {
    for (const plane of ACCUMULATOR_PLANES) {
      assert.ok(processInput[bus][plane].every(value => value === 0));
    }
  }

  const expectedAuxAUpload = new Uint8Array(
    AX_MAIN_BUS_LIMITS.accumulatorLrsBytes,
  );
  const expectedAuxBUpload = new Uint8Array(
    AX_MAIN_BUS_LIMITS.accumulatorLrsBytes,
  );
  writeLrsInput(expectedAuxAUpload, 0, outgoingAuxA);
  writeLrsInput(expectedAuxBUpload, 0, outgoingAuxB);
  assert.equal(result.uploads.length, 2);
  assert.deepEqual(result.uploads[0].data, expectedAuxAUpload);
  assert.deepEqual(result.uploads[1].data, expectedAuxBUpload);
  assert.deepEqual(
    result.uploads.map(upload => [
      upload.sequence,
      upload.commandIndex,
      upload.kind,
      upload.logicalAddress,
      upload.physicalAddress,
      upload.byteLength,
    ]),
    [
      [0, 2, "aux-a-lrs-s32-be", 0x8000_4000, 0x4000, 1_920],
      [1, 3, "aux-b-lrs-s32-be", 0xc000_8000, 0x8000, 1_920],
    ],
  );

  const expectedSurroundBytes = new Uint8Array(
    AX_MAIN_BUS_LIMITS.surroundOutputBytes,
  );
  const expectedMainBytes = new Uint8Array(
    AX_MAIN_BUS_LIMITS.mainOutputBytes,
  );
  for (let frame = 0; frame < AX_MAIN_BUS_LIMITS.frames; frame += 1) {
    const beforeAuxBLeft = input[frame] + auxAReturn.left[frame];
    const beforeAuxBRight = input[frame] + auxAReturn.right[frame];
    assert.ok(beforeAuxBLeft < 10_000);
    assert.ok(beforeAuxBRight < 10_000);

    const mixedLeft = beforeAuxBLeft + auxBReturn.left[frame];
    const mixedRight = beforeAuxBRight + auxBReturn.right[frame];
    assert.ok(mixedLeft > 10_000);
    assert.ok(mixedRight > 10_000);
    const expectedLeft = mixedLeft / 2;
    const expectedRight = mixedRight / 2;
    const expectedSurround = (
      auxAReturn.surround[frame] + auxBReturn.surround[frame]
    ) | 0;
    assert.equal(result.output.main.samples[frame * 2], expectedRight);
    assert.equal(result.output.main.samples[frame * 2 + 1], expectedLeft);
    assert.equal(result.output.surround.samples[frame], expectedSurround);
    writeBigEndianU16(expectedMainBytes, frame * 4, expectedRight);
    writeBigEndianU16(expectedMainBytes, frame * 4 + 2, expectedLeft);
    writeBigEndianS32(expectedSurroundBytes, frame * 4, expectedSurround);
  }
  assert.deepEqual(result.output.main.bytes, expectedMainBytes);
  assert.deepEqual(result.output.surround.bytes, expectedSurroundBytes);

  assert.deepEqual(
    result.writes.map(write => [
      write.sequence,
      write.commandIndex,
      write.kind,
      write.physicalAddress,
      write.byteLength,
    ]),
    [
      [0, 2, "aux-a-lrs-s32-be", 0x4000, 1_920],
      [1, 3, "aux-b-lrs-s32-be", 0x8000, 1_920],
      [2, 5, "surround-s32-be", 0x11_000, 640],
      [3, 5, "main-rl-s16-be", 0x10_000, 640],
    ],
  );
  assert.equal(result.writes[0], result.uploads[0]);
  assert.equal(result.writes[1], result.uploads[1]);
  assert.deepEqual(
    result.writes.map(write => write.data),
    [
      expectedAuxAUpload,
      expectedAuxBUpload,
      expectedSurroundBytes,
      expectedMainBytes,
    ],
  );

  assert.equal(result.compressorPosition, 7);
  assert.deepEqual(result.telemetry, {
    schema: AX_MAIN_BUS_REFERENCE_SCHEMA,
    initialMainBus: "zero",
    initialAuxBuses: "zero",
    commands: 6,
    processCommands: 1,
    uploadLrsCommands: 0,
    mixAuxACommands: 1,
    mixAuxBCommands: 1,
    auxMixCommands: 2,
    auxUploadCommands: 2,
    auxMixSelections: [
      {
        commandIndex: 2,
        code: AX_MAIN_BUS_COMMAND.MIX_AUXA,
        bus: "A",
        uploaded: true,
        writeLogicalAddress: 0x8000_4000,
        writePhysicalAddress: 0x4000,
        writeBytes: 1_920,
        readLogicalAddress: 0x4000_6000,
        readPhysicalAddress: 0x6000,
        readBytes: 1_920,
      },
      {
        commandIndex: 3,
        code: AX_MAIN_BUS_COMMAND.MIX_AUXB,
        bus: "B",
        uploaded: true,
        writeLogicalAddress: 0xc000_8000,
        writePhysicalAddress: 0x8000,
        writeBytes: 1_920,
        readLogicalAddress: 0x8000_a000,
        readPhysicalAddress: 0xa000,
        readBytes: 1_920,
      },
    ],
    auxBLrSelections: [],
    setLrCommands: 1,
    setOppositeLrCommands: 0,
    mixAuxBNoWriteCommands: 0,
    mixAuxBLrCommands: 0,
    compressorCommands: 1,
    compressorAttackFrames: 1,
    compressorReleaseFrames: 0,
    compressorBypassFrames: 0,
    compressorPositionBefore: 0,
    compressorPositionAfter: 7,
    compressorSelections: [{
      phase: "attack",
      triggered: true,
      threshold: 10_000,
      releaseFrames: 7,
      positionBefore: 0,
      positionAfter: 7,
      entryIndex: 0,
      tableAddress: 0x4000_c000,
    }],
    frames: 160,
    milliseconds: 5,
    outputOrder: "surround-s32-be;R,L-s16-be",
    outputWriteBytes: 1_280,
    mainUploadWriteBytes: 0,
    auxUploadWriteBytes: 3_840,
    auxBLrUploadWriteBytes: 0,
    uploadWriteBytes: 3_840,
    auxReturnReadBytes: 3_840,
    transactionWriteBytes: 5_120,
    clippedSampleValues: 0,
    peakAbsoluteSample: 7_090,
    surroundHash: "0xba7c8a52",
    mainHash: "0x23aacb03",
    outputHash: "0xe35b3e8c",
    transactionHash: "0xfcc71215",
  });
  assertExactOwnedResultBuffers(result, mram);
});

test("mutated F-Zero PROCESS+AUX body rejects before effects", () => {
  const mram = Uint8Array.from(
    { length: 0x13_000 },
    (_unused, address) => (address * 17 + 5) & 0xff,
  );
  const before = new Uint8Array(mram);
  const commands = [
    setLr(0x8000_0200),
    processCommand(),
    mixAuxB(0xc000_3000, 0x4000_5000),
    mixAuxA(0x8000_7000, 0xc000_9000),
    compressor({
      threshold: 12_345,
      releaseFrames: 9,
      tableAddress: 0x4000_b000,
    }),
    output(0x8000_d000, 0xc000_e000),
  ];
  const commandCodes = [0x07, 0x03, 0x05, 0x04, 0x12, 0x0e];
  assert.deepEqual(commands.map(command => command.code), commandCodes);
  let processCalls = 0;

  const result = executeAxMainBusReference({
    mram,
    commands,
    compressorPosition: 4,
    processMainBus: () => {
      processCalls += 1;
      return cloneAccumulatorBuses();
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.reason, "unsupported-process-aux-topology");
  assert.equal(result.error.processCommandIndex, 1);
  assert.equal(result.error.auxCommandIndex, 2);
  assert.deepEqual(result.error.commandCodes, commandCodes);
  assert.ok(
    result.error.allowedCommandCodeBodies.some(body =>
      body.length === 6
      && body.every(
        (code, index) => code === [0x07, 0x03, 0x04, 0x05, 0x12, 0x0e][index]
      )
    ),
  );
  assert.equal("writes" in result, false);
  assert.equal("compressorPosition" in result, false);
  assert.equal(processCalls, 0);
  assert.deepEqual(mram, before);
});

test("unobserved PROCESS+AUX topologies reject atomically", () => {
  const mram = new Uint8Array(0x4000);
  const before = new Uint8Array(mram);
  const expectedCommandCodes = [
    0x03,
    0x04,
    0x05,
    0x06,
    0x11,
    0x09,
    0x0e,
  ];
  const fixtures = [
    [
      processCommand(),
      mixAuxA(0, 0x100),
      output(0x1000, 0x1800),
    ],
    [
      processCommand(),
      mixAuxB(0, 0x100),
      mixAuxA(0, 0x800),
      uploadLrs(0x1000),
      setOppositeLr(0x1800),
      mixAuxBNoWrite(0x2000),
      output(0x2800, 0x3000),
    ],
  ];
  let processCalls = 0;

  for (const commands of fixtures) {
    const result = executeAxMainBusReference({
      mram,
      commands,
      processMainBus: () => {
        processCalls += 1;
        return cloneAccumulatorBuses();
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, "unsupported-process-aux-topology");
    assert.deepEqual(
      result.error.commandCodes,
      commands.map(command => command.code),
    );
    assert.deepEqual(result.error.expectedCommandCodes, expectedCommandCodes);
    assert.equal("writes" in result, false);
    assert.deepEqual(mram, before);
  }
  assert.equal(processCalls, 0);
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
      name: "AUX-A upload range",
      commands: [
        mixAuxA(0x8000_3f00, 0x100),
        validOutput,
      ],
      reason: "mram-range-out-of-bounds",
    },
    {
      name: "AUX-A return range after valid upload",
      commands: [
        mixAuxA(0x8000_0100, 0xc000_3f00),
        validOutput,
      ],
      reason: "mram-range-out-of-bounds",
    },
    {
      name: "AUX-B return range",
      commands: [
        mixAuxB(0, 0x4000_3f00),
        validOutput,
      ],
      reason: "mram-range-out-of-bounds",
    },
    {
      name: "AUX-B no-write return range",
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
