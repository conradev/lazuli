#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  executeAxMainBusReference as executeCanonicalAxMainBusReference,
} from "./browser_dsp_ax_main_bus_reference.mjs";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");
const referencePath = new URL(
  "./browser_dsp_ax_main_bus_reference.mjs",
  import.meta.url,
);
const referenceSource = readFileSync(referencePath, "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const parametersStart = source.indexOf("(", start);
  let parametersDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === "(") parametersDepth += 1;
    if (source[index] !== ")") continue;
    parametersDepth -= 1;
    if (parametersDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `unterminated parameters for ${name}`);
  const bodyStart = source.indexOf("{", parametersEnd);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

const runtimeFunctionNames = [
  "hex32",
  "emptyDspAxCommandState",
  "traceDsp",
  "latchDspFirstUnsupported",
  "rejectDspAxCommand",
  "dspAxCommandArity",
  "dspAxAddress",
  "dspAxParseFailure",
  "dspAxMramRange",
  "emptyDspAxVoicePlan",
  "markDspAxVoiceFallback",
  "inspectDspAxZeroSetup",
  "observeDspAxVoiceCommand",
  "finalizeDspAxVoicePlan",
  "dspAxSilentWriteRange",
  "collectDspAxSilentWrites",
  "parseDspAxCommandLists",
  "applyDspAxSilentWrites",
  "dspAxVoiceByteArray",
  "dspAxVoiceExactByteArray",
  "dspAxVoiceReason",
  "dspAxVoiceOutputHash",
  "dspAxVoiceNonZeroSamples",
  "dspAxVoiceRangesOverlap",
  "dspAxVoiceFallback",
  "prepareDspAxVoiceTransaction",
  "applyDspAxVoiceTransaction",
  "beginDspAxCommandList",
  "executeDspAxCommandList",
  "handleDspAxMail",
];

function runtimeContext({
  executeAxMainBusReference = executeCanonicalAxMainBusReference,
  renderAxVoiceReference,
  compressorPosition = 0,
  ucodeHash = 0x07f88145,
} = {}) {
  assert.equal(typeof renderAxVoiceReference, "function");
  const memory = new ArrayBuffer(0x50000);
  const ram = 0x1000;
  const ramSize = 0x30000;
  const invalidations = [];
  const context = {
    aram: new Uint8Array(0x10000),
    bytes: new Uint8Array(memory),
    cycles: 20_000,
    deviceEvents: new Map(),
    dspAxCommandState: null,
    dspAxCompressorPosition: compressorPosition,
    dspCurrentMail: null,
    dspFirstUnsupported: null,
    dspMode: "ax",
    dspScheduledMail: null,
    dspTrace: [],
    dspUcodeHash: ucodeHash,
    executeAxMainBusReference,
    invalidations,
    invalidateDataReservationForExternalWrite(physical, size) {
      invalidations.push([physical, size]);
    },
    pc: 0x80004000,
    pushDspMail() {
      throw new Error("resume mail production is outside this focused harness");
    },
    ram,
    ramPointer(address, size) {
      const physical = (address >>> 0) & 0x3fffffff;
      if (
        !Number.isSafeInteger(size)
        || size < 0
        || physical > ramSize - size
      ) {
        return null;
      }
      return ram + physical;
    },
    ramSize,
    renderAxVoiceReference,
    resetDspMailbox() {
      throw new Error("mailbox reset is outside this focused harness");
    },
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    runtimeFunctionNames.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-ax-main-bus-runtime.js" },
  );
  context.dspAxCommandState = context.emptyDspAxCommandState();
  return context;
}

function splitAddress(address) {
  const value = address >>> 0;
  return [value >>> 16, value & 0xffff];
}

function ramBytes(context, address, size) {
  const pointer = context.ramPointer(address, size);
  assert.notEqual(pointer, null, "fixture address must map into RAM");
  return context.bytes.subarray(pointer, pointer + size);
}

function writeWords(context, address, words) {
  const pointer = context.ramPointer(address, words.length * 2);
  assert.notEqual(pointer, null, "command list must map into RAM");
  for (let index = 0; index < words.length; index += 1) {
    context.view.setUint16(pointer + index * 2, words[index], false);
  }
}

function writeZeroSetup(context, address, delta = 0x7fff) {
  const pointer = context.ramPointer(address, 9 * 3 * 2);
  assert.notEqual(pointer, null);
  for (let descriptor = 0; descriptor < 9; descriptor += 1) {
    context.view.setUint16(pointer + descriptor * 6, 0, false);
    context.view.setUint16(pointer + descriptor * 6 + 2, 0, false);
    context.view.setUint16(pointer + descriptor * 6 + 4, delta, false);
  }
}

function writeMainInput(context, address, samples) {
  assert.equal(samples.length, 160);
  const pointer = context.ramPointer(address, 160 * 4);
  assert.notEqual(pointer, null);
  for (let frame = 0; frame < 160; frame += 1) {
    context.view.setInt32(pointer + frame * 4, samples[frame], false);
  }
}

function writeMainLrs(context, address, { left, right, surround }) {
  for (const samples of [left, right, surround]) {
    assert.equal(samples.length, 160);
  }
  const pointer = context.ramPointer(address, 3 * 160 * 4);
  assert.notEqual(pointer, null);
  for (const [plane, samples] of [left, right, surround].entries()) {
    for (let frame = 0; frame < 160; frame += 1) {
      context.view.setInt32(
        pointer + plane * 160 * 4 + frame * 4,
        samples[frame],
        false,
      );
    }
  }
}

function writeCompressorEntry(
  context,
  tableAddress,
  entryIndex,
  coefficient,
) {
  const address = (
    (tableAddress >>> 0) + entryIndex * 160 * 2
  ) >>> 0;
  const pointer = context.ramPointer(address, 160 * 2);
  assert.notEqual(pointer, null);
  for (let frame = 0; frame < 160; frame += 1) {
    const value = typeof coefficient === "function"
      ? coefficient(frame)
      : coefficient;
    context.view.setUint16(pointer + frame * 2, value, false);
  }
}

function mainBusList({
  setupAddress,
  inputAddress,
  parameterBlockAddress,
  threshold,
  releaseFrames,
  compressorTableAddress,
  surroundAddress,
  lrAddress,
}) {
  return [
    0x0000, ...splitAddress(setupAddress),
    0x0007, ...splitAddress(inputAddress),
    0x0002, ...splitAddress(parameterBlockAddress),
    0x0003,
    0x0012,
    threshold,
    releaseFrames,
    ...splitAddress(compressorTableAddress),
    0x000e,
    ...splitAddress(surroundAddress),
    ...splitAddress(lrAddress),
    0x000f,
  ];
}

function executeList(context, address, words) {
  writeWords(context, address, words);
  context.dspAxCommandState.sizeWords = words.length;
  return context.executeDspAxCommandList(address);
}

function continueWithList(context, address, words) {
  context.dspAxCommandState.phase = "task-wait";
  assert.equal(context.handleDspAxMail(0xcdd10003), true);
  assert.equal(context.dspAxCommandState.phase, "waiting-size");
  assert.equal(
    context.handleDspAxMail(0xbabe0000 | words.length),
    true,
  );
  assert.equal(context.dspAxCommandState.phase, "waiting-address");
  writeWords(context, address, words);
  return context.handleDspAxMail(address);
}

function makeVoiceStub({
  parameterBlockAddress,
  parameterBlockData,
  calls,
  leftDelta = 1_000,
  rightDelta = -1_000,
}) {
  return input => {
    calls.push(input);
    assert.equal(input.ucodeHash, 0x07f88145);
    assert.equal(input.headAddress, parameterBlockAddress);
    assert.ok(input.initialMainLeft instanceof Int32Array);
    assert.ok(input.initialMainRight instanceof Int32Array);
    const left = Int32Array.from(
      input.initialMainLeft,
      value => (value + leftDelta) | 0,
    );
    const right = Int32Array.from(
      input.initialMainRight,
      value => (value + rightDelta) | 0,
    );
    return {
      ok: true,
      output: {
        order: "R,L",
        bytes: new Uint8Array(160 * 2 * 2),
      },
      mainAccumulators: { left, right },
      parameterBlockWrites: [{
        logicalAddress: parameterBlockAddress,
        physicalAddress: (parameterBlockAddress >>> 0) & 0x3fffffff,
        byteLength: parameterBlockData.length,
        data: parameterBlockData,
      }],
    };
  };
}

function writeBigEndianS16(bytes, offset, value) {
  const word = value & 0xffff;
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

function multiplyQ15(sample, coefficient) {
  return Number(
    BigInt.asIntN(32, (BigInt(sample) * BigInt(coefficient)) >> 15n),
  );
}

function expectedMainOutput(samples, coefficient, leftDelta, rightDelta) {
  const output = new Uint8Array(160 * 2 * 2);
  for (let frame = 0; frame < 160; frame += 1) {
    const right = multiplyQ15(
      (samples[frame] + rightDelta) | 0,
      coefficient,
    );
    const left = multiplyQ15(
      (samples[frame] + leftDelta) | 0,
      coefficient,
    );
    writeBigEndianS16(
      output,
      frame * 4,
      Math.max(-0x8000, Math.min(0x7fff, right)),
    );
    writeBigEndianS16(
      output,
      frame * 4 + 2,
      Math.max(-0x8000, Math.min(0x7fff, left)),
    );
  }
  return output;
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

function warioPostmixOutput(input, aux) {
  const main = new Uint8Array(160 * 2 * 2);
  const surround = new Uint8Array(160 * 4);
  for (let frame = 0; frame < 160; frame += 1) {
    const left = (
      ((-input[frame]) | 0) + aux.left[frame]
    ) | 0;
    const right = (input[frame] + aux.right[frame]) | 0;
    writeBigEndianS16(main, frame * 4, clampSigned16(right));
    writeBigEndianS16(main, frame * 4 + 2, clampSigned16(left));
    writeBigEndianS32(surround, frame * 4, aux.surround[frame]);
  }
  return { main, surround };
}

function warioPostmixCommands({
  setupAddress,
  uploadAddress,
  inputAddress,
  auxAddress,
  surroundAddress,
  lrAddress,
}) {
  return [
    0x0000, ...splitAddress(setupAddress),
    0x0006, ...splitAddress(uploadAddress),
    0x0011, ...splitAddress(inputAddress),
    0x0009, ...splitAddress(auxAddress),
    0x000e,
    ...splitAddress(surroundAddress),
    ...splitAddress(lrAddress),
    0x000f,
  ];
}

function mutatingPostEndPadding({
  fakeUploadAddress,
  fakeSurroundAddress,
  fakeLrAddress,
}) {
  const padding = [
    0x0006, ...splitAddress(fakeUploadAddress),
    0x000e,
    ...splitAddress(fakeSurroundAddress),
    ...splitAddress(fakeLrAddress),
    ...Array(10).fill(0xffff),
  ];
  assert.equal(padding.length, 18);
  return padding;
}

function warioFixture({
  executeAxMainBusReference = executeCanonicalAxMainBusReference,
  compressorPosition = 0,
  ucodeHash = 0xe2136399,
  setupAddress = 0x40001000,
  uploadAddress = 0x80002000,
  inputAddress = 0xc0004000,
  auxAddress = 0x40006000,
  surroundAddress = inputAddress,
  lrAddress = 0x80008000,
  fakeUploadAddress = 0xc000a000,
  fakeSurroundAddress = 0x4000b000,
  fakeLrAddress = 0x8000c000,
} = {}) {
  const calls = [];
  const context = runtimeContext({
    executeAxMainBusReference,
    compressorPosition,
    ucodeHash,
    renderAxVoiceReference(input) {
      calls.push(input);
      throw new Error("Wario postmix must not invoke the AX voice model");
    },
  });
  const input = Int32Array.from(
    { length: 160 },
    (_unused, frame) => ((frame - 80) * 1_000_003) | 0,
  );
  input[0] = -0x8000_0000;
  input[1] = 0x7fff_ffff;
  const aux = {
    left: Int32Array.from(
      { length: 160 },
      (_unused, frame) => (frame * 101 - 8_000) | 0,
    ),
    right: Int32Array.from(
      { length: 160 },
      (_unused, frame) => (8_000 - frame * 103) | 0,
    ),
    surround: Int32Array.from(
      { length: 160 },
      (_unused, frame) => (0x1234_0000 + frame * 257) | 0,
    ),
  };
  aux.left[0] = -1;
  aux.right[0] = -1;
  aux.left[1] = -2;
  aux.right[1] = 1;

  writeZeroSetup(context, setupAddress);
  ramBytes(context, uploadAddress, 3 * 160 * 4).fill(0x7a);
  writeMainInput(context, inputAddress, input);
  writeMainLrs(context, auxAddress, aux);
  ramBytes(context, lrAddress, 160 * 2 * 2).fill(0x64);
  ramBytes(context, fakeUploadAddress, 3 * 160 * 4).fill(0xa1);
  ramBytes(context, fakeSurroundAddress, 160 * 4).fill(0xb2);
  ramBytes(context, fakeLrAddress, 160 * 2 * 2).fill(0xc3);

  const commands = warioPostmixCommands({
    setupAddress,
    uploadAddress,
    inputAddress,
    auxAddress,
    surroundAddress,
    lrAddress,
  });
  assert.equal(commands.length, 18);
  const padding = mutatingPostEndPadding({
    fakeUploadAddress,
    fakeSurroundAddress,
    fakeLrAddress,
  });
  return {
    aux,
    auxAddress,
    calls,
    commands,
    compressorPosition,
    context,
    fakeLrAddress,
    fakeSurroundAddress,
    fakeUploadAddress,
    input,
    inputAddress,
    lrAddress,
    padding,
    setupAddress,
    surroundAddress,
    uploadAddress,
    words: [...commands, ...padding],
  };
}

function serializeLrs({ left, right, surround }) {
  const output = new Uint8Array(3 * 160 * 4);
  for (const [plane, samples] of [left, right, surround].entries()) {
    assert.equal(samples.length, 160);
    for (let frame = 0; frame < 160; frame += 1) {
      writeBigEndianS32(
        output,
        plane * 160 * 4 + frame * 4,
        samples[frame],
      );
    }
  }
  return output;
}

function addLrsWrapping(left, right) {
  return {
    left: Int32Array.from(
      left.left,
      (sample, frame) => (sample + right.left[frame]) | 0,
    ),
    right: Int32Array.from(
      left.right,
      (sample, frame) => (sample + right.right[frame]) | 0,
    ),
    surround: Int32Array.from(
      left.surround,
      (sample, frame) => (sample + right.surround[frame]) | 0,
    ),
  };
}

function warioAuxCommands({
  setupAddress,
  auxA,
  auxB,
  uploadAddress,
  inputAddress,
  postmixAddress,
  surroundAddress,
  lrAddress,
}) {
  const commands = [
    0x0000, ...splitAddress(setupAddress),
  ];
  if (auxA !== null) {
    commands.push(
      0x0004,
      ...splitAddress(auxA.writeAddress),
      ...splitAddress(auxA.readAddress),
    );
  }
  if (auxB !== null) {
    commands.push(
      0x0005,
      ...splitAddress(auxB.writeAddress),
      ...splitAddress(auxB.readAddress),
    );
  }
  commands.push(
    0x0006, ...splitAddress(uploadAddress),
    0x0011, ...splitAddress(inputAddress),
    0x0009, ...splitAddress(postmixAddress),
    0x000e,
    ...splitAddress(surroundAddress),
    ...splitAddress(lrAddress),
    0x000f,
  );
  return commands;
}

function patternedLrs(seed) {
  const make = (multiplier, offset) => Int32Array.from(
    { length: 160 },
    (_unused, frame) =>
      (seed + frame * multiplier + offset) | 0,
  );
  return {
    left: make(0x0102_0305, -0x1234_567),
    right: make(-0x000f_0103, 0x1020_3040),
    surround: make(0x0001_0101, -0x3141_5926),
  };
}

function warioAuxFixture({
  executeAxMainBusReference = executeCanonicalAxMainBusReference,
  auxAWriteAddress = 0x80002000,
  auxAReadAddress = 0xc0003000,
  auxBWriteAddress = 0x40004000,
  auxBReadAddress = 0x80005000,
  includeAuxA = true,
  includeAuxB = true,
  setupAddress = 0x40001000,
  uploadAddress = 0xc0006000,
  inputAddress = 0x80007000,
  postmixAddress = 0x40008000,
  surroundAddress = 0xc0009000,
  lrAddress = 0x8000a000,
  ucodeHash = 0xe2136399,
} = {}) {
  const calls = [];
  const context = runtimeContext({
    executeAxMainBusReference,
    ucodeHash,
    renderAxVoiceReference(input) {
      calls.push(input);
      throw new Error("Wario AUX main-bus path must not invoke voice");
    },
  });
  const auxA = patternedLrs(0x1020_3040);
  const auxB = patternedLrs(-0x2030_4050);
  auxA.left[0] = 0x3f80_0000;
  auxA.right[0] = 0x7fff_ffff;
  auxA.surround[0] = -0x8000_0000;
  auxB.left[0] = 1;
  auxB.right[0] = 1;
  auxB.surround[0] = -1;
  const input = Int32Array.from(
    { length: 160 },
    (_unused, frame) => ((frame - 80) * 1_000_003) | 0,
  );
  const postmix = patternedLrs(0x0102_0304);
  writeZeroSetup(context, setupAddress);
  ramBytes(context, auxAWriteAddress, 1_920).fill(0xa4);
  ramBytes(context, auxBWriteAddress, 1_920).fill(0xb5);
  writeMainLrs(context, auxAReadAddress, auxA);
  writeMainLrs(context, auxBReadAddress, auxB);
  ramBytes(context, uploadAddress, 1_920).fill(0xc6);
  writeMainInput(context, inputAddress, input);
  writeMainLrs(context, postmixAddress, postmix);
  ramBytes(context, surroundAddress, 640).fill(0xd7);
  ramBytes(context, lrAddress, 640).fill(0xe8);

  const auxACommand = includeAuxA
    ? {
        writeAddress: auxAWriteAddress >>> 0,
        readAddress: auxAReadAddress >>> 0,
      }
    : null;
  const auxBCommand = includeAuxB
    ? {
        writeAddress: auxBWriteAddress >>> 0,
        readAddress: auxBReadAddress >>> 0,
      }
    : null;
  const words = warioAuxCommands({
    setupAddress,
    auxA: auxACommand,
    auxB: auxBCommand,
    uploadAddress,
    inputAddress,
    postmixAddress,
    surroundAddress,
    lrAddress,
  });
  return {
    auxA,
    auxACommand,
    auxAReadAddress,
    auxAWriteAddress,
    auxB,
    auxBCommand,
    auxBReadAddress,
    auxBWriteAddress,
    calls,
    context,
    input,
    inputAddress,
    lrAddress,
    postmix,
    postmixAddress,
    setupAddress,
    surroundAddress,
    uploadAddress,
    words,
  };
}

function hostAuxSelections(context) {
  return Array.from(
    context.dspAxCommandState.mainBusAuxMixSelections,
    selection => ({ ...selection }),
  );
}

function assertWarioMainBusFallback(
  testFixture,
  {
    reason,
    compressorPosition = testFixture.compressorPosition,
    expectedCalls = 0,
  },
) {
  const {
    calls,
    context,
    lrAddress,
    surroundAddress,
    uploadAddress,
  } = testFixture;
  assert.equal(calls.length, expectedCalls);
  assert.ok(
    ramBytes(context, uploadAddress, 3 * 160 * 4)
      .every(value => value === 0),
  );
  assert.ok(
    ramBytes(context, surroundAddress, 160 * 4)
      .every(value => value === 0),
  );
  assert.ok(
    ramBytes(context, lrAddress, 160 * 2 * 2)
      .every(value => value === 0),
  );
  assert.equal(context.dspAxCompressorPosition, compressorPosition);
  assert.equal(context.dspAxCommandState.voiceMode, "silent-fallback");
  assert.equal(context.dspAxCommandState.voiceRendered, false);
  assert.equal(context.dspAxCommandState.mainBusOnly, true);
  assert.equal(context.dspAxCommandState.voiceReason, reason);
  assert.equal(context.dspAxCommandState.mainBusRendered, false);
  assert.equal(context.deviceEvents.get("dspAxMainBusFallback"), 1);
  assert.equal(context.deviceEvents.get("dspAxVoiceFallback"), undefined);
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), undefined);
  assert.equal(context.deviceEvents.get("dspAxSilentWrite"), 3);
  assert.equal(context.deviceEvents.get("dspAxSilentBytes"), 3_200);
  assert.equal(context.dspFirstUnsupported?.stage, "main-bus");
  assert.equal(context.dspFirstUnsupported?.reason, reason);
}

function fixture({
  executeAxMainBusReference = executeCanonicalAxMainBusReference,
  compressorPosition = 0,
  setupAddress = 0x40001000,
  inputAddress = 0xc0004000,
  parameterBlockAddress = 0x80002000,
  compressorTableAddress = 0x40003000,
  surroundAddress = 0xc0006000,
  lrAddress = 0x80007000,
  threshold = 1_000,
  releaseFrames = 10,
  seedCompressor = true,
} = {}) {
  const parameterBlockData = Uint8Array.from(
    { length: 244 },
    (_unused, index) => (index * 29 + 7) & 0xff,
  );
  const calls = [];
  const context = runtimeContext({
    executeAxMainBusReference,
    compressorPosition,
    renderAxVoiceReference: makeVoiceStub({
      parameterBlockAddress,
      parameterBlockData,
      calls,
    }),
  });
  const samples = Int32Array.from(
    { length: 160 },
    (_unused, frame) => 12_000 + frame * 10,
  );
  writeZeroSetup(context, setupAddress);
  writeMainInput(context, inputAddress, samples);
  if (seedCompressor) {
    writeCompressorEntry(context, compressorTableAddress, 0, 0x4000);
  }
  ramBytes(context, parameterBlockAddress, 244).fill(0x31);
  ramBytes(context, surroundAddress, 640).fill(0x53);
  ramBytes(context, lrAddress, 640).fill(0x64);
  return {
    calls,
    compressorTableAddress,
    context,
    inputAddress,
    lrAddress,
    parameterBlockAddress,
    parameterBlockData,
    releaseFrames,
    samples,
    setupAddress,
    surroundAddress,
    threshold,
    words: mainBusList({
      setupAddress,
      inputAddress,
      parameterBlockAddress,
      threshold,
      releaseFrames,
      compressorTableAddress,
      surroundAddress,
      lrAddress,
    }),
  };
}

function assertAtomicFallback(
  testFixture,
  {
    compressorPosition,
    reason,
    expectedInvalidations,
  },
) {
  const {
    context,
    parameterBlockAddress,
    surroundAddress,
    lrAddress,
  } = testFixture;
  assert.ok(
    ramBytes(context, parameterBlockAddress, 244)
      .every(value => value === 0x31),
    "PB data must remain untouched before the existing silent fallback",
  );
  assert.ok(
    ramBytes(context, surroundAddress, 640).every(value => value === 0),
  );
  assert.ok(ramBytes(context, lrAddress, 640).every(value => value === 0));
  assert.deepEqual(context.invalidations, expectedInvalidations);
  assert.equal(context.dspAxCompressorPosition, compressorPosition);
  assert.equal(context.dspAxCommandState.voiceMode, "silent-fallback");
  assert.equal(context.dspAxCommandState.voiceReason, reason);
  assert.equal(context.dspAxCommandState.voiceParameterBlocks, 0);
  assert.equal(context.dspAxCommandState.voiceOutputBytes, 0);
  assert.equal(context.dspAxCommandState.mainBusRendered, false);
  assert.equal(context.deviceEvents.get("dspAxVoiceFallback"), 1);
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), undefined);
  assert.equal(context.deviceEvents.get("dspAxMainBusWrite"), undefined);
  assert.equal(context.deviceEvents.get("dspAxSilentWrite"), 2);
  assert.equal(context.deviceEvents.get("dspAxSilentBytes"), 1_280);
}

test("canonical AX main-bus model is scoped directly inside the worker", () => {
  assert.doesNotMatch(referenceSource, /<\/script/i);
  assert.match(
    source,
    /include_str!\("\.\.\/\.\.\/\.\.\/tools\/browser_dsp_ax_main_bus_reference\.mjs"\)/,
  );
  assert.match(
    source,
    /fn scoped_reference_runtime\(source: &str, export_name: &str\) -> String/,
  );
  assert.match(
    source,
    /const \{ executeAxMainBusReference \} =\s*__DSP_AX_MAIN_BUS_REFERENCE_RUNTIME__;/,
  );
  assert.doesNotMatch(source, /dspAxMainBusReferenceUrl/);
  assert.doesNotMatch(source, /dsp-ax-main-bus-reference-source/);
  assert.ok(
    source.lastIndexOf(
      '.replace(\n            "__DSP_AX_MAIN_BUS_REFERENCE_RUNTIME__"',
    ) > source.lastIndexOf('.replace("__DMAL_OFFSET__"'),
    "canonical module replacement must follow frontend placeholders",
  );
  assert.match(
    source,
    /"__DSP_AX_MAIN_BUS_REFERENCE_RUNTIME__",\s*&dsp_ax_main_bus_reference_runtime/,
  );
});

test("WarioWare postmix commits exact aliases and ignores its 18-word END tail", () => {
  const testFixture = warioFixture();
  const {
    aux,
    calls,
    context,
    fakeLrAddress,
    fakeSurroundAddress,
    fakeUploadAddress,
    input,
    lrAddress,
    surroundAddress,
    uploadAddress,
    words,
  } = testFixture;
  const expected = warioPostmixOutput(input, aux);
  const fakeUploadBefore = new Uint8Array(
    ramBytes(context, fakeUploadAddress, 3 * 160 * 4),
  );
  const fakeSurroundBefore = new Uint8Array(
    ramBytes(context, fakeSurroundAddress, 160 * 4),
  );
  const fakeLrBefore = new Uint8Array(
    ramBytes(context, fakeLrAddress, 160 * 2 * 2),
  );

  assert.equal(words.length, 36);
  assert.equal(executeList(context, 0xc0000100, words), true);
  assert.equal(calls.length, 0);
  assert.ok(
    ramBytes(context, uploadAddress, 3 * 160 * 4)
      .every(value => value === 0),
    "zero SETUP must upload three exact zero accumulator planes",
  );
  assert.deepEqual(
    ramBytes(context, surroundAddress, 160 * 4),
    expected.surround,
    "the live SET_OPPOSITE source aliases the later surround output",
  );
  assert.deepEqual(
    ramBytes(context, lrAddress, 160 * 2 * 2),
    expected.main,
  );
  assert.deepEqual(
    ramBytes(context, fakeUploadAddress, 3 * 160 * 4),
    fakeUploadBefore,
    "a mutating UPLOAD_LRS encoded after END must remain unreachable",
  );
  assert.deepEqual(
    ramBytes(context, fakeSurroundAddress, 160 * 4),
    fakeSurroundBefore,
  );
  assert.deepEqual(
    ramBytes(context, fakeLrAddress, 160 * 2 * 2),
    fakeLrBefore,
  );
  assert.deepEqual(
    context.invalidations,
    [[0x2000, 1_920], [0x4000, 640], [0x8000, 640]],
    "0x8 upload, 0xC input/output, and 0x8 LR aliases commit physically",
  );

  assert.equal(context.dspAxCommandState.wordCount, 36);
  assert.equal(context.dspAxCommandState.paddingWords, 18);
  assert.equal(context.dspAxCommandState.sizeWords, 36);
  assert.equal(context.dspAxCommandState.listCount, 1);
  assert.equal(context.dspAxCommandState.commandCount, 6);
  assert.deepEqual(
    Array.from(context.dspAxCommandState.commandSample),
    [0x00, 0x06, 0x11, 0x09, 0x0e, 0x0f],
  );
  assert.equal(context.dspAxCommandState.voiceMode, "main-bus-only");
  assert.equal(context.dspAxCommandState.voiceRendered, false);
  assert.equal(context.dspAxCommandState.mainBusOnly, true);
  assert.equal(context.dspAxCommandState.voiceParameterBlocks, 0);
  assert.equal(context.dspAxCommandState.voiceParameterBlockBytes, 0);
  assert.equal(context.dspAxCommandState.voiceOutputBytes, 0);
  assert.equal(context.dspAxCommandState.voiceNonZeroSampleValues, 0);
  assert.equal(context.dspAxCommandState.voiceOutputHash, null);
  assert.equal(context.dspAxCommandState.writeCount, 3);
  assert.equal(context.dspAxCommandState.clearedBytes, 0);
  assert.equal(context.dspAxCommandState.mainBusRendered, true);
  assert.equal(context.dspAxCommandState.mainBusCommands, 4);
  assert.equal(context.dspAxCommandState.mainBusUploadLrsCommands, 1);
  assert.equal(context.dspAxCommandState.mainBusSetLrCommands, 0);
  assert.equal(context.dspAxCommandState.mainBusSetOppositeLrCommands, 1);
  assert.equal(context.dspAxCommandState.mainBusMixAuxACommands, 0);
  assert.equal(context.dspAxCommandState.mainBusMixAuxBCommands, 0);
  assert.equal(context.dspAxCommandState.mainBusAuxMixCommands, 0);
  assert.equal(
    context.dspAxCommandState.mainBusMixAuxBNoWriteCommands,
    1,
  );
  assert.equal(
    context.dspAxCommandState.mainBusAuxReturnReadBytes,
    1_920,
  );
  assert.equal(context.dspAxCommandState.mainBusCompressorCommands, 0);
  assert.equal(context.dspAxCommandState.mainBusWriteCount, 3);
  assert.equal(context.dspAxCommandState.mainBusWriteBytes, 3_200);
  assert.equal(
    context.dspAxCommandState.mainBusCompressorPositionBefore,
    0,
  );
  assert.equal(
    context.dspAxCommandState.mainBusCompressorPositionAfter,
    0,
  );
  assert.equal(
    context.dspAxCommandState.mainBusOutputHash,
    fnv1a([expected.surround, expected.main]),
  );
  assert.equal(
    context.dspAxCommandState.mainBusTransactionHash,
    fnv1a([
      new Uint8Array(1_920),
      expected.surround,
      expected.main,
    ]),
  );
  assert.equal(context.deviceEvents.get("dspAxVoiceRender"), undefined);
  assert.equal(
    context.deviceEvents.get("dspAxVoiceParameterBlockWrite"),
    undefined,
  );
  assert.equal(context.deviceEvents.get("dspAxVoiceDataBytes"), undefined);
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), 1);
  assert.equal(context.deviceEvents.get("dspAxMainBusWrite"), 3);
  assert.equal(context.deviceEvents.get("dspAxMainBusBytes"), 3_200);
  assert.equal(context.deviceEvents.get("dspAxMainBusAuxMix"), undefined);
  assert.equal(
    context.deviceEvents.get("dspAxMainBusAuxReturnBytes"),
    1_920,
  );
  assert.equal(context.deviceEvents.get("dspAxSilentWrite"), 0);
  assert.equal(context.deviceEvents.get("dspAxSilentBytes"), 0);
  assert.equal(context.dspFirstUnsupported, null);
  const commandTrace = context.dspTrace.find(
    entry => entry.event === "ax-command-list",
  );
  assert.equal(commandTrace.mainBusAuxReturnReadBytes, 1_920);
  assert.equal(
    context.dspTrace.filter(
      entry => entry.event === "ax-main-bus-write"
    ).length,
    3,
  );
  assert.equal(
    context.dspTrace.some(entry => entry.event === "ax-voice-write"),
    false,
  );
  assert.ok(
    Object.values(context.dspAxCommandState).every(
      value => !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer),
    ),
    "persistent Wario diagnostics must retain scalar evidence only",
  );
});

test("WarioWare AUXA/AUXB uploads precede returns and commit exact diagnostics", () => {
  const testFixture = warioAuxFixture();
  const {
    auxA,
    auxAWriteAddress,
    auxB,
    auxBWriteAddress,
    calls,
    context,
    input,
    lrAddress,
    postmix,
    surroundAddress,
    uploadAddress,
    words,
  } = testFixture;
  const expectedUpload = serializeLrs(addLrsWrapping(auxA, auxB));
  const expectedOutput = warioPostmixOutput(input, postmix);

  assert.equal(words.length, 28, "the certified list remains short");
  assert.equal(executeList(context, 0xc0000100, words), true);
  assert.equal(calls.length, 0);
  assert.ok(
    ramBytes(context, auxAWriteAddress, 1_920)
      .every(value => value === 0),
    "zero SETUP exposes an exact zero AUXA upload",
  );
  assert.ok(
    ramBytes(context, auxBWriteAddress, 1_920)
      .every(value => value === 0),
    "zero SETUP exposes an exact zero AUXB upload",
  );
  assert.deepEqual(
    ramBytes(context, uploadAddress, 1_920),
    expectedUpload,
    "CMD06 may upload nonzero MAIN after AUX returns",
  );
  const uploadBytes = ramBytes(context, uploadAddress, 1_920);
  const uploadView = new DataView(
    uploadBytes.buffer,
    uploadBytes.byteOffset,
    uploadBytes.byteLength,
  );
  assert.equal(
    uploadView.getInt32(0, false),
    0x3f80_0001,
    "0x3f800000 is a signed integer accumulator value, not float 1.0",
  );
  assert.equal(
    uploadView.getInt32(640, false),
    -0x8000_0000,
    "AUX return addition wraps signed 32-bit at the right plane",
  );
  assert.equal(
    uploadView.getInt32(1_280, false),
    0x7fff_ffff,
    "planar surround addition wraps independently",
  );
  assert.deepEqual(
    ramBytes(context, surroundAddress, 640),
    expectedOutput.surround,
  );
  assert.deepEqual(
    ramBytes(context, lrAddress, 640),
    expectedOutput.main,
  );
  assert.deepEqual(
    context.invalidations,
    [
      [0x2000, 1_920],
      [0x4000, 1_920],
      [0x6000, 1_920],
      [0x9000, 640],
      [0xa000, 640],
    ],
  );

  assert.equal(context.dspAxCommandState.wordCount, 28);
  assert.equal(context.dspAxCommandState.paddingWords, 0);
  assert.equal(context.dspAxCommandState.commandCount, 8);
  assert.deepEqual(
    Array.from(context.dspAxCommandState.commandSample),
    [0x00, 0x04, 0x05, 0x06, 0x11, 0x09, 0x0e, 0x0f],
  );
  assert.equal(context.dspAxCommandState.voiceMode, "main-bus-only");
  assert.equal(context.dspAxCommandState.mainBusCommands, 6);
  assert.equal(context.dspAxCommandState.mainBusMixAuxACommands, 1);
  assert.equal(context.dspAxCommandState.mainBusMixAuxBCommands, 1);
  assert.equal(context.dspAxCommandState.mainBusAuxMixCommands, 2);
  assert.equal(
    context.dspAxCommandState.mainBusMixAuxBNoWriteCommands,
    1,
  );
  assert.equal(context.dspAxCommandState.mainBusAuxUploadCommands, 2);
  assert.equal(context.dspAxCommandState.mainBusAuxUploadWriteBytes, 3_840);
  assert.equal(context.dspAxCommandState.mainBusAuxReturnReadBytes, 5_760);
  assert.deepEqual(
    hostAuxSelections(context),
    [
      {
        bus: "A",
        command: 0x04,
        uploaded: true,
        writeAddress: 0x80002000,
        writePhysical: 0x2000,
        readAddress: 0xc0003000,
        readPhysical: 0x3000,
      },
      {
        bus: "B",
        command: 0x05,
        uploaded: true,
        writeAddress: 0x40004000,
        writePhysical: 0x4000,
        readAddress: 0x80005000,
        readPhysical: 0x5000,
      },
    ],
  );
  assert.equal(context.dspAxCommandState.mainBusUploadLrsCommands, 1);
  assert.equal(context.dspAxCommandState.mainBusWriteCount, 5);
  assert.equal(context.dspAxCommandState.mainBusWriteBytes, 7_040);
  assert.equal(
    context.dspAxCommandState.mainBusOutputHash,
    fnv1a([expectedOutput.surround, expectedOutput.main]),
  );
  assert.equal(
    context.dspAxCommandState.mainBusTransactionHash,
    fnv1a([
      new Uint8Array(1_920),
      new Uint8Array(1_920),
      expectedUpload,
      expectedOutput.surround,
      expectedOutput.main,
    ]),
  );
  assert.equal(context.deviceEvents.get("dspAxMainBusAuxMix"), 2);
  assert.equal(context.deviceEvents.get("dspAxMainBusAuxReturnBytes"), 5_760);
  assert.equal(context.deviceEvents.get("dspAxMainBusAuxUpload"), 2);
  assert.equal(context.deviceEvents.get("dspAxMainBusAuxBytes"), 3_840);
  assert.equal(context.deviceEvents.get("dspAxMainBusWrite"), 5);
  assert.equal(context.deviceEvents.get("dspAxMainBusBytes"), 7_040);
  assert.equal(context.deviceEvents.get("dspAxSilentWrite"), 0);
  assert.equal(context.dspFirstUnsupported, null);
  const commandTrace = context.dspTrace.find(
    entry => entry.event === "ax-command-list",
  );
  assert.equal(commandTrace.mainBusAuxMixCommands, 2);
  assert.equal(commandTrace.mainBusAuxUploadCommands, 2);
  assert.equal(commandTrace.mainBusAuxUploadWriteBytes, 3_840);
  assert.equal(commandTrace.mainBusAuxReturnReadBytes, 5_760);
  assert.equal(commandTrace.mainBusAuxMixSelections.length, 2);
});

test("release diagnostics publish bounded AUX command evidence", () => {
  for (const field of [
    "mainBusMixAuxACommands",
    "mainBusMixAuxBCommands",
    "mainBusAuxMixCommands",
    "mainBusAuxUploadCommands",
    "mainBusAuxUploadWriteBytes",
    "mainBusAuxReturnReadBytes",
  ]) {
    assert.match(
      source,
      new RegExp(`${field}:\\s*dspAxCommandState\\.${field}`),
    );
  }
  assert.match(
    source,
    /mainBusAuxMixSelections:\s*dspAxCommandState\.mainBusAuxMixSelections\.map\(/,
  );
  assert.match(source, /writeAddress: hex32\(selection\.writeAddress\)/);
  assert.match(source, /readAddress: hex32\(selection\.readAddress\)/);
});

test("WarioWare accepts independently optional AUXA and AUXB callbacks", () => {
  for (const variant of [
    {
      name: "AUXA only",
      includeAuxA: true,
      includeAuxB: false,
      expectedBus: "A",
      expectedCode: 0x04,
      expectedReturn: "auxA",
    },
    {
      name: "AUXB only",
      includeAuxA: false,
      includeAuxB: true,
      expectedBus: "B",
      expectedCode: 0x05,
      expectedReturn: "auxB",
    },
  ]) {
    const testFixture = warioAuxFixture(variant);
    const expectedUpload = serializeLrs(
      testFixture[variant.expectedReturn],
    );
    assert.equal(testFixture.words.length, 23, variant.name);
    assert.equal(
      executeList(
        testFixture.context,
        0x0100,
        testFixture.words,
      ),
      true,
      variant.name,
    );
    assert.deepEqual(
      ramBytes(testFixture.context, testFixture.uploadAddress, 1_920),
      expectedUpload,
      variant.name,
    );
    assert.equal(
      testFixture.context.dspAxCommandState.mainBusMixAuxACommands,
      variant.includeAuxA ? 1 : 0,
    );
    assert.equal(
      testFixture.context.dspAxCommandState.mainBusMixAuxBCommands,
      variant.includeAuxB ? 1 : 0,
    );
    assert.equal(
      testFixture.context.dspAxCommandState.mainBusAuxUploadCommands,
      1,
    );
    assert.equal(
      testFixture.context.dspAxCommandState.mainBusAuxMixCommands,
      1,
    );
    assert.equal(
      testFixture.context.dspAxCommandState.mainBusMixAuxBNoWriteCommands,
      1,
    );
    assert.equal(
      testFixture.context.dspAxCommandState.mainBusAuxReturnReadBytes,
      3_840,
    );
    assert.equal(
      testFixture.context.deviceEvents.get("dspAxMainBusAuxReturnBytes"),
      3_840,
    );
    assert.deepEqual(
      Array.from(
        testFixture.context.dspAxCommandState.mainBusAuxMixSelections,
        selection => [selection.bus, selection.command],
      ),
      [[variant.expectedBus, variant.expectedCode]],
    );
    assert.equal(
      testFixture.context.dspAxCommandState.mainBusWriteBytes,
      5_120,
    );
    assert.equal(testFixture.context.dspFirstUnsupported, null);
  }
});

test("WarioWare rejects uncertified AUX topology before either model runs", () => {
  const variants = [
    {
      name: "duplicate AUXA",
      reason: "uncertified-main-bus-only-sequence",
      alter(fixture) {
        const setup = fixture.words.slice(0, 3);
        const auxA = fixture.words.slice(3, 8);
        const auxB = fixture.words.slice(8, 13);
        const tail = fixture.words.slice(13);
        return [...setup, ...auxA, ...auxA, ...auxB, ...tail];
      },
    },
    {
      name: "AUXB before AUXA",
      reason: "uncertified-main-bus-only-sequence",
      alter(fixture) {
        const setup = fixture.words.slice(0, 3);
        const auxA = fixture.words.slice(3, 8);
        const auxB = fixture.words.slice(8, 13);
        const tail = fixture.words.slice(13);
        return [...setup, ...auxB, ...auxA, ...tail];
      },
    },
    {
      name: "wrong ucode hash",
      reason: "unsupported-main-buffer-command",
      fixture: { ucodeHash: 0x07f88145 },
      alter(fixture) {
        return fixture.words;
      },
    },
    {
      name: "nonzero setup",
      reason: "nonzero-setup-buffer",
      prepare(fixture) {
        const pointer = fixture.context.ramPointer(
          fixture.setupAddress,
          2,
        );
        fixture.context.view.setUint16(pointer, 1, false);
      },
      alter(fixture) {
        return fixture.words;
      },
    },
    {
      name: "PB and PROCESS insertion",
      reason: "uncertified-voice-ucode",
      prepare(fixture) {
        ramBytes(fixture.context, 0xb000, 244).fill(0x5a);
      },
      alter(fixture) {
        return [
          ...fixture.words.slice(0, 13),
          0x0002, ...splitAddress(0x8000b000),
          0x0003,
          ...fixture.words.slice(13),
        ];
      },
    },
  ];

  for (const variant of variants) {
    let authorityCalls = 0;
    const fixture = warioAuxFixture({
      ...variant.fixture,
      executeAxMainBusReference(input) {
        authorityCalls += 1;
        return executeCanonicalAxMainBusReference(input);
      },
    });
    variant.prepare?.(fixture);
    assert.equal(
      executeList(fixture.context, 0x0100, variant.alter(fixture)),
      true,
      variant.name,
    );
    assert.equal(authorityCalls, 0, variant.name);
    assert.equal(fixture.calls.length, 0, variant.name);
    assert.equal(
      fixture.context.dspAxCommandState.voiceMode,
      "silent-fallback",
      variant.name,
    );
    assert.equal(
      fixture.context.dspAxCommandState.voiceReason,
      variant.reason,
      variant.name,
    );
    assert.equal(
      fixture.context.deviceEvents.get("dspAxMainBusRender"),
      undefined,
      variant.name,
    );
  }
});

test("WarioWare distinguishes skipped AUX write zero from cached physical zero", () => {
  const skipped = warioAuxFixture({
    includeAuxB: false,
    auxAWriteAddress: 0,
  });
  assert.equal(executeList(skipped.context, 0x0100, skipped.words), true);
  assert.deepEqual(
    ramBytes(skipped.context, skipped.uploadAddress, 1_920),
    serializeLrs(skipped.auxA),
  );
  assert.deepEqual(
    hostAuxSelections(skipped.context),
    [{
      bus: "A",
      command: 0x04,
      uploaded: false,
      writeAddress: 0,
      writePhysical: null,
      readAddress: 0xc0003000,
      readPhysical: 0x3000,
    }],
  );
  assert.equal(
    skipped.context.dspAxCommandState.mainBusAuxUploadCommands,
    0,
  );
  assert.equal(skipped.context.dspAxCommandState.mainBusWriteBytes, 3_200);

  const cachedZero = warioAuxFixture({
    includeAuxB: false,
    auxAWriteAddress: 0x80000000,
    auxAReadAddress: 0,
  });
  assert.equal(
    executeList(cachedZero.context, 0x80000100, cachedZero.words),
    true,
  );
  assert.ok(
    ramBytes(cachedZero.context, cachedZero.uploadAddress, 1_920)
      .every(value => value === 0),
    "the current cached-zero upload must feed the same-command read at zero",
  );
  assert.deepEqual(
    hostAuxSelections(cachedZero.context),
    [{
      bus: "A",
      command: 0x04,
      uploaded: true,
      writeAddress: 0x80000000,
      writePhysical: 0,
      readAddress: 0,
      readPhysical: 0,
    }],
  );
  assert.deepEqual(
    cachedZero.context.invalidations,
    [
      [0, 1_920],
      [0x6000, 1_920],
      [0x9000, 640],
      [0xa000, 640],
    ],
  );
  assert.equal(cachedZero.context.dspFirstUnsupported, null);
});

test("WarioWare AUX prior uploads feed aliases and OOB ranges reject atomically", () => {
  const aliased = warioAuxFixture({
    auxBWriteAddress: 0,
    auxBReadAddress: 0x40002000,
  });
  assert.equal(executeList(aliased.context, 0x0100, aliased.words), true);
  assert.deepEqual(
    ramBytes(aliased.context, aliased.uploadAddress, 1_920),
    serializeLrs(aliased.auxA),
    "the earlier AUXA zero upload replaces the later aliased AUXB return",
  );
  assert.equal(aliased.context.dspFirstUnsupported, null);

  const partial = warioAuxFixture({
    includeAuxB: false,
    auxAWriteAddress: 0x80002000,
    auxAReadAddress: 0xc0002100,
  });
  const expectedPartial = new Uint8Array(1_920);
  expectedPartial.set(
    serializeLrs(partial.auxA).subarray(1_664),
    1_664,
  );
  assert.equal(executeList(partial.context, 0x0100, partial.words), true);
  assert.deepEqual(
    ramBytes(partial.context, partial.uploadAddress, 1_920),
    expectedPartial,
    "a partial return alias sees staged zero bytes and the untouched tail",
  );
  assert.equal(partial.context.dspFirstUnsupported, null);

  for (const variant of [
    {
      name: "upload",
      words(fixture) {
        return warioAuxCommands({
          setupAddress: fixture.setupAddress,
          auxA: {
            writeAddress: 0xc002ff00,
            readAddress: fixture.auxAReadAddress,
          },
          auxB: null,
          uploadAddress: fixture.uploadAddress,
          inputAddress: fixture.inputAddress,
          postmixAddress: fixture.postmixAddress,
          surroundAddress: fixture.surroundAddress,
          lrAddress: fixture.lrAddress,
        });
      },
      reason: "write-out-of-bounds",
    },
    {
      name: "return",
      words(fixture) {
        return warioAuxCommands({
          setupAddress: fixture.setupAddress,
          auxA: {
            writeAddress: fixture.auxAWriteAddress,
            readAddress: 0x8002ff00,
          },
          auxB: null,
          uploadAddress: fixture.uploadAddress,
          inputAddress: fixture.inputAddress,
          postmixAddress: fixture.postmixAddress,
          surroundAddress: fixture.surroundAddress,
          lrAddress: fixture.lrAddress,
        });
      },
      reason: "read-out-of-bounds",
    },
  ]) {
    const fixture = warioAuxFixture({
      includeAuxB: false,
    });
    const words = variant.words(fixture);
    writeWords(fixture.context, 0x0100, words);
    fixture.context.dspAxCommandState.sizeWords = words.length;
    const before = new Uint8Array(fixture.context.bytes);
    assert.equal(
      fixture.context.executeDspAxCommandList(0x0100),
      false,
    );
    assert.deepEqual(
      fixture.context.bytes,
      before,
      `${variant.name} OOB must commit no partial upload or output`,
    );
    assert.deepEqual(fixture.context.invalidations, []);
    assert.equal(fixture.context.dspAxCommandState.phase, "halted");
    assert.equal(fixture.context.dspAxCommandState.reason, variant.reason);
  }
});

test("WarioWare rejects forged AUX evidence before model writes commit", () => {
  const variants = [
    {
      name: "forged AUX selection",
      reason: "invalid-main-bus-aux-telemetry",
      mutate(result) {
        return {
          ...result,
          telemetry: {
            ...result.telemetry,
            auxMixSelections: [
              {
                ...result.telemetry.auxMixSelections[0],
                readPhysicalAddress:
                  result.telemetry.auxMixSelections[0].readPhysicalAddress
                  + 4,
              },
              result.telemetry.auxMixSelections[1],
            ],
          },
        };
      },
    },
    {
      name: "nonzero AUX upload",
      reason: "invalid-main-bus-upload",
      mutate(result) {
        const upload = {
          ...result.uploads[0],
          data: new Uint8Array(1_920).fill(1),
        };
        const writes = [upload, ...result.writes.slice(1)];
        return {
          ...result,
          uploads: [upload, ...result.uploads.slice(1)],
          writes,
          telemetry: {
            ...result.telemetry,
            transactionHash: fnv1a(writes.map(write => write.data)),
          },
        };
      },
    },
    {
      name: "forged AUX upload kind",
      reason: "invalid-main-bus-output-write",
      mutate(result) {
        const upload = {
          ...result.uploads[0],
          kind: "main-lrs-s32-be",
        };
        return {
          ...result,
          uploads: [upload, ...result.uploads.slice(1)],
          writes: [upload, ...result.writes.slice(1)],
        };
      },
    },
    {
      name: "AUX upload aliases live MRAM",
      reason: "invalid-main-bus-upload",
      mutate(result, input) {
        const upload = {
          ...result.uploads[0],
          data: input.mram.subarray(0x2000, 0x2000 + 1_920),
        };
        const writes = [upload, ...result.writes.slice(1)];
        return {
          ...result,
          uploads: [upload, ...result.uploads.slice(1)],
          writes,
          telemetry: {
            ...result.telemetry,
            transactionHash: fnv1a(writes.map(write => write.data)),
          },
        };
      },
    },
    {
      name: "forged transaction hash",
      reason: "invalid-main-bus-transaction-hash",
      mutate(result) {
        return {
          ...result,
          telemetry: {
            ...result.telemetry,
            transactionHash: "0x00000000",
          },
        };
      },
    },
  ];

  for (const variant of variants) {
    const fixture = warioAuxFixture({
      executeAxMainBusReference(input) {
        const result = executeCanonicalAxMainBusReference(input);
        assert.equal(result.ok, true);
        return variant.mutate(result, input);
      },
    });
    assert.equal(
      executeList(fixture.context, 0x0100, fixture.words),
      true,
      variant.name,
    );
    assert.equal(
      fixture.context.dspAxCommandState.voiceReason,
      variant.reason,
      variant.name,
    );
    assert.equal(
      fixture.context.dspAxCommandState.mainBusRendered,
      false,
      variant.name,
    );
    for (const [address, size] of [
      [fixture.auxAWriteAddress, 1_920],
      [fixture.auxBWriteAddress, 1_920],
      [fixture.uploadAddress, 1_920],
      [fixture.surroundAddress, 640],
      [fixture.lrAddress, 640],
    ]) {
      assert.ok(
        ramBytes(fixture.context, address, size)
          .every(value => value === 0),
        `${variant.name} must expose only the established silent fallback`,
      );
    }
    assert.equal(fixture.context.dspAxCommandState.clearedBytes, 7_040);
    assert.equal(fixture.context.deviceEvents.get("dspAxMainBusRender"), undefined);
    assert.equal(fixture.context.deviceEvents.get("dspAxMainBusFallback"), 1);
  }
});

test("WarioWare rejects forged write evidence and compressor drift atomically", () => {
  const variants = [
    {
      name: "forged output hash",
      reason: "invalid-main-bus-output-hash",
      mutate(result) {
        return {
          ...result,
          telemetry: {
            ...result.telemetry,
            outputHash: "0x00000000",
          },
        };
      },
    },
    {
      name: "forged transaction hash",
      reason: "invalid-main-bus-transaction-hash",
      mutate(result) {
        return {
          ...result,
          telemetry: {
            ...result.telemetry,
            transactionHash: "0x00000000",
          },
        };
      },
    },
    {
      name: "forged upload payload",
      reason: "invalid-main-bus-upload",
      mutate(result) {
        const upload = {
          ...result.uploads[0],
          data: new Uint8Array(1_920).fill(0xa5),
        };
        return {
          ...result,
          uploads: [upload],
          writes: [upload, ...result.writes.slice(1)],
          telemetry: {
            ...result.telemetry,
            transactionHash: fnv1a([
              upload.data,
              result.output.surround.bytes,
              result.output.main.bytes,
            ]),
          },
        };
      },
    },
    {
      name: "zero-compressor position drift",
      reason: "invalid-main-bus-state",
      mutate(result) {
        return {
          ...result,
          compressorPosition: 1,
          telemetry: {
            ...result.telemetry,
            compressorPositionAfter: 1,
          },
        };
      },
    },
  ];

  for (const variant of variants) {
    const testFixture = warioFixture({
      executeAxMainBusReference(input) {
        const result = executeCanonicalAxMainBusReference(input);
        assert.equal(result.ok, true);
        return variant.mutate(result);
      },
    });
    assert.equal(
      executeList(testFixture.context, 0x0100, testFixture.words),
      true,
      variant.name,
    );
    assertWarioMainBusFallback(testFixture, {
      reason: variant.reason,
    });
    assert.deepEqual(
      testFixture.context.invalidations,
      [[0x2000, 1_920], [0x4000, 640], [0x8000, 640]],
      `${variant.name} must commit only the established silent fallback`,
    );
  }
});

test("WarioWare upload overlay feeds a later aliased main-bus read", () => {
  const testFixture = warioFixture({
    inputAddress: 0xc0002200,
    surroundAddress: 0x40009000,
  });
  const {
    aux,
    context,
    lrAddress,
    surroundAddress,
    uploadAddress,
    words,
  } = testFixture;
  const expected = warioPostmixOutput(new Int32Array(160), aux);

  assert.equal(executeList(context, 0x0100, words), true);
  assert.ok(
    ramBytes(context, uploadAddress, 3 * 160 * 4)
      .every(value => value === 0),
  );
  assert.deepEqual(
    ramBytes(context, surroundAddress, 160 * 4),
    expected.surround,
  );
  assert.deepEqual(
    ramBytes(context, lrAddress, 160 * 2 * 2),
    expected.main,
    "SET_OPPOSITE_LR must see the preceding zero UPLOAD_LRS overlay",
  );
  assert.deepEqual(
    context.invalidations,
    [[0x2000, 1_920], [0x9000, 640], [0x8000, 640]],
  );
  assert.equal(context.dspAxCommandState.mainBusRendered, true);
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), 1);
  assert.equal(context.dspFirstUnsupported, null);
});

test("WarioWare rejects a hidden voice callback before any model writes", () => {
  const testFixture = warioFixture({
    executeAxMainBusReference(input) {
      try {
        input.processMainBus(null);
      } catch (_error) {
        // A hostile wrapper can swallow the callback failure, but the runtime
        // independently counts invocations against the parsed PROCESS plan.
      }
      return executeCanonicalAxMainBusReference(input);
    },
  });
  assert.equal(
    executeList(testFixture.context, 0x0100, testFixture.words),
    true,
  );
  assert.equal(testFixture.calls.length, 1);
  assertWarioMainBusFallback(testFixture, {
    reason: "invalid-main-bus-process-count",
    expectedCalls: 1,
  });
  assert.deepEqual(
    testFixture.context.invalidations,
    [[0x2000, 1_920], [0x4000, 640], [0x8000, 640]],
  );
});

test("WarioWare uncertified topology and voice promotion fail before models", () => {
  const reordered = warioFixture();
  const reorderedCommands = [
    0x0000, ...splitAddress(reordered.setupAddress),
    0x0006, ...splitAddress(reordered.uploadAddress),
    0x0009, ...splitAddress(reordered.auxAddress),
    0x0011, ...splitAddress(reordered.inputAddress),
    0x000e,
    ...splitAddress(reordered.surroundAddress),
    ...splitAddress(reordered.lrAddress),
    0x000f,
  ];
  assert.equal(reorderedCommands.length, 18);
  const reorderedWords = [...reorderedCommands, ...reordered.padding];
  assert.equal(
    executeList(reordered.context, 0x0100, reorderedWords),
    true,
  );
  assertWarioMainBusFallback(reordered, {
    reason: "uncertified-main-bus-only-sequence",
  });

  const promoted = warioFixture();
  const parameterBlockAddress = 0x8000d000;
  ramBytes(promoted.context, parameterBlockAddress, 244).fill(0xd4);
  const promotedCommands = [
    0x0000, ...splitAddress(promoted.setupAddress),
    0x0006, ...splitAddress(promoted.uploadAddress),
    0x0011, ...splitAddress(promoted.inputAddress),
    0x0009, ...splitAddress(promoted.auxAddress),
    0x0002, ...splitAddress(parameterBlockAddress),
    0x0003,
    0x000e,
    ...splitAddress(promoted.surroundAddress),
    ...splitAddress(promoted.lrAddress),
    0x000f,
  ];
  assert.equal(promotedCommands.length, 22);
  const promotedWords = [
    ...promotedCommands,
    ...Array(14).fill(0xffff),
  ];
  assert.equal(executeList(promoted.context, 0x0100, promotedWords), true);
  assert.equal(promoted.calls.length, 0);
  assert.equal(promoted.context.dspAxCommandState.voiceMode, "silent-fallback");
  assert.equal(promoted.context.dspAxCommandState.voiceRendered, false);
  assert.equal(promoted.context.dspAxCommandState.mainBusOnly, false);
  assert.equal(
    promoted.context.dspAxCommandState.voiceReason,
    "uncertified-voice-ucode",
  );
  assert.ok(
    ramBytes(promoted.context, parameterBlockAddress, 244)
      .every(value => value === 0xd4),
  );
  assert.equal(promoted.context.dspAxCompressorPosition, 0);
  assert.equal(promoted.context.deviceEvents.get("dspAxVoiceFallback"), 1);
  assert.equal(
    promoted.context.deviceEvents.get("dspAxMainBusFallback"),
    undefined,
  );
  assert.equal(promoted.context.deviceEvents.get("dspAxSilentWrite"), 3);
  assert.equal(promoted.context.deviceEvents.get("dspAxSilentBytes"), 3_200);
  assert.equal(promoted.context.dspFirstUnsupported?.stage, "voice");
});

test("F-Zero SET_LR voice/compressor transaction commits exact aliased writes", () => {
  const testFixture = fixture();
  const {
    calls,
    context,
    lrAddress,
    parameterBlockAddress,
    parameterBlockData,
    samples,
    surroundAddress,
    words,
  } = testFixture;
  assert.equal(executeList(context, 0x40000100, words), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mram.length, context.ramSize);
  assert.equal(calls[0].aram, context.aram);
  assert.deepEqual(
    Array.from(calls[0].initialMainLeft),
    Array.from(samples),
  );
  assert.deepEqual(
    Array.from(calls[0].initialMainRight),
    Array.from(samples),
  );

  const expectedSurround = new Uint8Array(640);
  const expectedLr = expectedMainOutput(samples, 0x4000, 1_000, -1_000);
  assert.deepEqual(
    Array.from(ramBytes(context, parameterBlockAddress, 244)),
    Array.from(parameterBlockData),
  );
  assert.deepEqual(
    Array.from(ramBytes(context, surroundAddress, 640)),
    Array.from(expectedSurround),
  );
  assert.deepEqual(
    Array.from(ramBytes(context, lrAddress, 640)),
    Array.from(expectedLr),
  );
  assert.deepEqual(
    context.invalidations,
    [[0x2000, 244], [0x6000, 640], [0x7000, 640]],
    "0x4, 0x8, and 0xC logical aliases must invalidate MEM1 physical ranges",
  );
  assert.deepEqual(
    { ...context.dspScheduledMail },
    { mail: 0xdcd10002, completionCycle: 22_500 },
  );
  assert.equal(context.dspAxCompressorPosition, 10);
  assert.equal(context.dspAxCommandState.voiceMode, "rendered");
  assert.equal(context.dspAxCommandState.voiceReason, null);
  assert.equal(context.dspAxCommandState.voiceParameterBlocks, 1);
  assert.equal(context.dspAxCommandState.voiceParameterBlockBytes, 244);
  assert.equal(context.dspAxCommandState.voiceOutputBytes, 1_280);
  assert.equal(context.dspAxCommandState.writeCount, 3);
  assert.equal(context.dspAxCommandState.clearedBytes, 0);
  assert.equal(context.dspAxCommandState.mainBusRendered, true);
  assert.equal(context.dspAxCommandState.mainBusCommands, 4);
  assert.equal(context.dspAxCommandState.mainBusSetLrCommands, 1);
  assert.equal(context.dspAxCommandState.mainBusSetOppositeLrCommands, 0);
  assert.equal(context.dspAxCommandState.mainBusCompressorCommands, 1);
  assert.equal(
    context.dspAxCommandState.mainBusCompressorPositionBefore,
    0,
  );
  assert.equal(
    context.dspAxCommandState.mainBusCompressorPositionAfter,
    10,
  );
  assert.equal(
    context.dspAxCommandState.mainBusOutputHash,
    fnv1a([expectedSurround, expectedLr]),
  );
  assert.equal(context.deviceEvents.get("dspAxVoiceRender"), 1);
  assert.equal(context.deviceEvents.get("dspAxVoiceParameterBlockWrite"), 1);
  assert.equal(context.deviceEvents.get("dspAxVoiceDataBytes"), 1_524);
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), 1);
  assert.equal(context.deviceEvents.get("dspAxMainBusWrite"), 2);
  assert.equal(context.deviceEvents.get("dspAxMainBusBytes"), 1_280);
  assert.equal(context.deviceEvents.get("dspAxSilentWrite"), 0);
  assert.equal(context.deviceEvents.get("dspAxSilentBytes"), 0);
  assert.equal(context.dspFirstUnsupported, null);
  assert.ok(
    Object.values(context.dspAxCommandState).every(
      value => !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer),
    ),
    "persistent AX diagnostics must not retain PB or sample payload arrays",
  );
});

test("AX task continue preserves compressor position into the release frame", () => {
  const testFixture = fixture();
  const {
    compressorTableAddress,
    context,
    inputAddress,
    words,
  } = testFixture;
  assert.equal(executeList(context, 0x0100, words), true);
  assert.equal(context.dspAxCompressorPosition, 10);

  writeMainInput(context, inputAddress, new Int32Array(160));
  writeCompressorEntry(context, compressorTableAddress, 20, 0x6000);
  const releaseWords = mainBusList({
    ...testFixture,
    threshold: 0xffff,
  });
  assert.equal(continueWithList(context, 0x0800, releaseWords), true);

  assert.equal(context.dspAxCompressorPosition, 9);
  assert.equal(
    context.dspAxCommandState.mainBusCompressorPositionBefore,
    10,
  );
  assert.equal(
    context.dspAxCommandState.mainBusCompressorPositionAfter,
    9,
  );
  assert.equal(context.deviceEvents.get("dspAxTaskContinue"), 1);
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), 2);
  assert.deepEqual(
    { ...context.dspScheduledMail },
    { mail: 0xdcd10002, completionCycle: 22_500 },
  );
});

test("malformed main-bus output falls back before PB or model writes commit", () => {
  const malformedMainBus = input => {
    const result = executeCanonicalAxMainBusReference(input);
    assert.equal(result.ok, true);
    return { ...result, writes: [] };
  };
  const testFixture = fixture({
    executeAxMainBusReference: malformedMainBus,
    compressorPosition: 4,
  });
  assert.equal(executeList(testFixture.context, 0x0100, testFixture.words), true);
  assertAtomicFallback(testFixture, {
    compressorPosition: 4,
    reason: "invalid-main-bus-output",
    expectedInvalidations: [[0x6000, 640], [0x7000, 640]],
  });
});

test("main-bus writes must be the exact fresh bytes certified by output", () => {
  const variants = [
    {
      name: "different fresh bytes",
      data(input, result) {
        return new Uint8Array(result.writes[0].byteLength).fill(0xab);
      },
    },
    {
      name: "MRAM-backed bytes",
      data(input, result) {
        return input.mram.subarray(
          0x1000,
          0x1000 + result.writes[0].byteLength,
        );
      },
    },
  ];

  for (const variant of variants) {
    const mismatchedMainBus = input => {
      const result = executeCanonicalAxMainBusReference(input);
      assert.equal(result.ok, true);
      return {
        ...result,
        writes: [
          {
            ...result.writes[0],
            data: variant.data(input, result),
          },
          result.writes[1],
        ],
      };
    };
    const testFixture = fixture({
      executeAxMainBusReference: mismatchedMainBus,
      compressorPosition: 4,
    });
    assert.equal(
      executeList(testFixture.context, 0x0100, testFixture.words),
      true,
      variant.name,
    );
    assertAtomicFallback(testFixture, {
      compressorPosition: 4,
      reason: "invalid-main-bus-output-write",
      expectedInvalidations: [[0x6000, 640], [0x7000, 640]],
    });
  }
});

test("overlapping surround and R,L outputs commit in authority order", () => {
  const testFixture = fixture({
    surroundAddress: 0x40006000,
    lrAddress: 0xc0006200,
  });
  const {
    context,
    parameterBlockAddress,
    parameterBlockData,
    samples,
    words,
  } = testFixture;
  const expectedLr = expectedMainOutput(samples, 0x4000, 1_000, -1_000);
  const expectedOverlap = new Uint8Array(640);
  expectedOverlap.set(expectedLr.subarray(0, 128), 512);

  assert.equal(executeList(context, 0x0100, words), true);
  assert.deepEqual(
    ramBytes(context, parameterBlockAddress, 244),
    parameterBlockData,
  );
  assert.deepEqual(ramBytes(context, 0x6000, 640), expectedOverlap);
  assert.deepEqual(ramBytes(context, 0x6200, 640), expectedLr);
  assert.deepEqual(
    context.invalidations,
    [[0x2000, 244], [0x6000, 640], [0x6200, 640]],
  );
  assert.equal(context.dspAxCommandState.voiceMode, "rendered");
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), 1);
  assert.equal(context.dspFirstUnsupported, null);
});

test("WarioWare later output wins over an overlapping staged upload", () => {
  const testFixture = warioFixture({
    surroundAddress: 0x40002000,
  });
  const {
    aux,
    context,
    input,
    lrAddress,
    uploadAddress,
    words,
  } = testFixture;
  const expected = warioPostmixOutput(input, aux);

  assert.equal(executeList(context, 0x0100, words), true);
  assert.deepEqual(
    ramBytes(context, uploadAddress, 640),
    expected.surround,
  );
  assert.ok(
    ramBytes(context, uploadAddress + 640, 1_280)
      .every(value => value === 0),
  );
  assert.deepEqual(
    ramBytes(context, lrAddress, 640),
    expected.main,
  );
  assert.deepEqual(
    context.invalidations,
    [[0x2000, 1_920], [0x2000, 640], [0x8000, 640]],
  );
  assert.equal(context.dspAxCommandState.voiceMode, "main-bus-only");
  assert.equal(context.deviceEvents.get("dspAxMainBusRender"), 1);
  assert.equal(context.dspFirstUnsupported, null);
});

test("selected compressor table OOB leaves the persistent scalar atomic", () => {
  const testFixture = fixture({
    compressorPosition: 0,
    compressorTableAddress: 0xc002ffc0,
    seedCompressor: false,
  });
  assert.equal(executeList(testFixture.context, 0x0100, testFixture.words), true);
  assertAtomicFallback(testFixture, {
    compressorPosition: 0,
    reason: "main-bus-mram-range-out-of-bounds",
    expectedInvalidations: [[0x6000, 640], [0x7000, 640]],
  });
});

test("compressor read after aliased PB write is rejected before all commits", () => {
  const testFixture = fixture({
    compressorPosition: 0,
    compressorTableAddress: 0xc0002000,
  });
  const {
    context,
    parameterBlockAddress,
    words,
  } = testFixture;
  ramBytes(context, parameterBlockAddress, 320).fill(0x40);
  // Preserve assertAtomicFallback's PB sentinel while keeping the selected
  // compressor range readable; its coefficient values are immaterial here.
  ramBytes(context, parameterBlockAddress, 244).fill(0x31);
  assert.equal(executeList(context, 0x0100, words), true);
  assertAtomicFallback(testFixture, {
    compressorPosition: 0,
    reason: "main-bus-read-after-write-alias",
    expectedInvalidations: [[0x6000, 640], [0x7000, 640]],
  });
});
