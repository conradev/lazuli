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
    dspUcodeHash: 0x07f88145,
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

test("overlapping main-bus output plan falls back as one transaction", () => {
  const testFixture = fixture({
    compressorPosition: 3,
    surroundAddress: 0x40006000,
    lrAddress: 0xc0006200,
  });
  assert.equal(executeList(testFixture.context, 0x0100, testFixture.words), true);
  assertAtomicFallback(testFixture, {
    compressorPosition: 3,
    reason: "overlapping-voice-writes",
    expectedInvalidations: [[0x6000, 640], [0x6200, 640]],
  });
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
