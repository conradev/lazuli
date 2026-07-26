#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  renderAxVoiceReference as renderCanonicalAxVoiceReference,
} from "./browser_dsp_ax_voice_reference.mjs";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");
const referencePath = new URL(
  "./browser_dsp_ax_voice_reference.mjs",
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
  "dspAxVoiceReason",
  "dspAxVoiceOutputHash",
  "dspAxVoiceNonZeroSamples",
  "dspAxVoiceRangesOverlap",
  "dspAxVoiceFallback",
  "prepareDspAxVoiceTransaction",
  "applyDspAxVoiceTransaction",
  "executeDspAxCommandList",
];

function runtimeContext(renderAxVoiceReference) {
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
    dspFirstUnsupported: null,
    dspMode: "ax",
    dspScheduledMail: null,
    dspTrace: [],
    dspUcodeHash: 0x4e8a8b21,
    invalidations,
    invalidateDataReservationForExternalWrite(physical, size) {
      invalidations.push([physical, size]);
    },
    pc: 0x80004000,
    ram,
    ramPointer(address, size) {
      const logical = address >>> 0;
      const physical = logical < ramSize
        ? logical
        : logical >= 0x80000000 && logical < 0x80000000 + ramSize
          ? logical - 0x80000000
          : logical >= 0xc0000000 && logical < 0xc0000000 + ramSize
            ? logical - 0xc0000000
            : null;
      if (
        physical === null
        || !Number.isSafeInteger(size)
        || size < 0
        || physical + size > ramSize
      ) {
        return null;
      }
      return ram + physical;
    },
    ramSize,
    renderAxVoiceReference,
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    runtimeFunctionNames.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-ax-voice-runtime.js" },
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

function voiceList({
  setupAddress,
  parameterBlockAddress,
  surroundAddress,
  lrAddress,
}) {
  return [
    0x0000, ...splitAddress(setupAddress),
    0x0002, ...splitAddress(parameterBlockAddress),
    0x0003,
    0x000a,
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

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (const value of bytes) {
    hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  }
  return "0x" + hash.toString(16).padStart(8, "0");
}

test("canonical AX voice model is scoped directly inside the worker", () => {
  assert.doesNotMatch(referenceSource, /<\/script/i);
  assert.match(
    source,
    /include_str!\("\.\.\/\.\.\/\.\.\/tools\/browser_dsp_ax_voice_reference\.mjs"\)/,
  );
  assert.match(
    source,
    /fn scoped_reference_runtime\(source: &str, export_name: &str\) -> String/,
  );
  assert.match(
    source,
    /const \{ renderAxVoiceReference \} =\s*__DSP_AX_VOICE_REFERENCE_RUNTIME__;/,
  );
  assert.doesNotMatch(source, /dspAxVoiceReferenceUrl/);
  assert.doesNotMatch(source, /dsp-ax-voice-reference-source/);
  assert.ok(
    source.lastIndexOf('.replace(\n            "__DSP_AX_VOICE_REFERENCE_RUNTIME__"')
      > source.lastIndexOf('.replace("__DMAL_OFFSET__"'),
    "canonical module replacement must be the final template replacement",
  );
  assert.match(
    source,
    /"__DSP_AX_VOICE_REFERENCE_RUNTIME__",\s*&dsp_ax_voice_reference_runtime/,
  );
});

test("exact zero-setup AX voice work commits PB and R,L output atomically", () => {
  const listAddress = 0x0100;
  const setupAddress = 0x1000;
  const parameterBlockAddress = 0x80002000;
  const surroundAddress = 0x6000;
  const lrAddress = 0x7000;
  const parameterBlockData = Uint8Array.from(
    { length: 236 },
    (_unused, index) => (index * 17 + 3) & 0xff,
  );
  const outputBytes = Uint8Array.from(
    { length: 640 },
    (_unused, index) => (index % 29 === 0 ? (index + 1) & 0xff : 0),
  );
  const calls = [];
  const context = runtimeContext(input => {
    calls.push(input);
    return {
      ok: true,
      output: { order: "R,L", bytes: outputBytes },
      parameterBlockWrites: [{
        logicalAddress: parameterBlockAddress,
        physicalAddress: 0x2000,
        byteLength: parameterBlockData.length,
        data: parameterBlockData,
      }],
    };
  });
  writeZeroSetup(context, setupAddress);
  ramBytes(context, parameterBlockAddress, 236).fill(0x31);
  ramBytes(context, surroundAddress, 640).fill(0x53);
  ramBytes(context, lrAddress, 640).fill(0x64);

  const words = voiceList({
    setupAddress,
    parameterBlockAddress,
    surroundAddress,
    lrAddress,
  });
  assert.equal(executeList(context, listAddress, words), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mram.length, context.ramSize);
  assert.equal(calls[0].aram, context.aram);
  assert.equal(calls[0].headAddress, parameterBlockAddress);
  assert.equal(calls[0].ucodeHash, 0x4e8a8b21);
  assert.deepEqual(
    Array.from(ramBytes(context, parameterBlockAddress, 236)),
    Array.from(parameterBlockData),
  );
  assert.ok(
    ramBytes(context, surroundAddress, 640).every(value => value === 0),
  );
  assert.deepEqual(
    Array.from(ramBytes(context, lrAddress, 640)),
    Array.from(outputBytes),
  );
  assert.deepEqual(
    context.invalidations,
    [
      [0x2000, 236],
      [0x6000, 640],
      [0x7000, 640],
    ],
  );
  assert.deepEqual(
    { ...context.dspScheduledMail },
    { mail: 0xdcd10002, completionCycle: 22_500 },
  );
  assert.equal(context.dspAxCommandState.voiceMode, "rendered");
  assert.equal(context.dspAxCommandState.voiceReason, null);
  assert.equal(context.dspAxCommandState.voiceParameterBlocks, 1);
  assert.equal(context.dspAxCommandState.voiceParameterBlockBytes, 236);
  assert.equal(context.dspAxCommandState.voiceOutputBytes, 640);
  assert.equal(
    context.dspAxCommandState.voiceOutputHash,
    fnv1a(outputBytes),
  );
  assert.equal(context.dspAxCommandState.writeCount, 3);
  assert.equal(context.dspAxCommandState.clearedBytes, 640);
  assert.equal(context.deviceEvents.get("dspAxVoiceRender"), 1);
  assert.equal(context.deviceEvents.get("dspAxVoiceParameterBlockWrite"), 1);
  assert.equal(context.deviceEvents.get("dspAxVoiceDataBytes"), 876);
  assert.equal(context.deviceEvents.get("dspAxSilentWrite"), 1);
  assert.equal(context.deviceEvents.get("dspAxSilentBytes"), 640);
  assert.equal(context.dspFirstUnsupported, null);
  assert.ok(
    Object.values(context.dspAxCommandState).every(
      value => !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer),
    ),
    "persistent AX diagnostics must not retain PB or sample payloads",
  );
});

test("AUX effect returns force atomic silence before PB writeback", () => {
  let modelCalls = 0;
  const context = runtimeContext(() => {
    modelCalls += 1;
    throw new Error("AUX fallback must not enter the voice model");
  });
  const setupAddress = 0x1000;
  const parameterBlockAddress = 0x2000;
  const auxUploadAddress = 0x4000;
  const auxReturnAddress = 0x5000;
  const surroundAddress = 0x7000;
  const lrAddress = 0x8000;
  writeZeroSetup(context, setupAddress);
  ramBytes(context, parameterBlockAddress, 236).fill(0x21);
  ramBytes(context, auxUploadAddress, 1920).fill(0x22);
  ramBytes(context, auxReturnAddress, 1920).fill(0x7a);
  ramBytes(context, surroundAddress, 640).fill(0x23);
  ramBytes(context, lrAddress, 640).fill(0x24);

  executeList(context, 0x0100, [
    0x0000, ...splitAddress(setupAddress),
    0x0004,
    ...splitAddress(auxUploadAddress),
    ...splitAddress(auxReturnAddress),
    0x0002, ...splitAddress(parameterBlockAddress),
    0x0003,
    0x000e,
    ...splitAddress(surroundAddress),
    ...splitAddress(lrAddress),
    0x000f,
  ]);

  assert.equal(modelCalls, 0);
  assert.ok(
    ramBytes(context, parameterBlockAddress, 236)
      .every(value => value === 0x21),
  );
  assert.ok(
    ramBytes(context, auxUploadAddress, 1920)
      .every(value => value === 0),
  );
  assert.ok(
    ramBytes(context, auxReturnAddress, 1920)
      .every(value => value === 0x7a),
  );
  assert.ok(
    ramBytes(context, surroundAddress, 640).every(value => value === 0),
  );
  assert.ok(ramBytes(context, lrAddress, 640).every(value => value === 0));
  assert.deepEqual(
    context.invalidations,
    [[0x4000, 1920], [0x7000, 640], [0x8000, 640]],
  );
  assert.equal(context.dspAxCommandState.voiceMode, "silent-fallback");
  assert.equal(
    context.dspAxCommandState.voiceReason,
    "unsupported-main-buffer-command",
  );
  assert.equal(context.dspAxCommandState.voiceCommand, 0x04);
  assert.deepEqual(
    {
      stage: context.dspFirstUnsupported.stage,
      reason: context.dspFirstUnsupported.reason,
      code: context.dspFirstUnsupported.code,
    },
    {
      stage: "voice",
      reason: "unsupported-main-buffer-command",
      code: 0x04,
    },
  );
});

test("runtime accepts the canonical model's bounded empty-PB transaction", () => {
  const context = runtimeContext(renderCanonicalAxVoiceReference);
  const setupAddress = 0x1000;
  const surroundAddress = 0x6000;
  const lrAddress = 0x7000;
  writeZeroSetup(context, setupAddress);
  ramBytes(context, surroundAddress, 640).fill(0x81);
  ramBytes(context, lrAddress, 640).fill(0x82);

  executeList(
    context,
    0x0100,
    voiceList({
      setupAddress,
      parameterBlockAddress: 0,
      surroundAddress,
      lrAddress,
    }),
  );

  assert.equal(context.dspAxCommandState.voiceMode, "rendered");
  assert.equal(context.dspAxCommandState.voiceParameterBlocks, 0);
  assert.equal(context.dspAxCommandState.voiceParameterBlockBytes, 0);
  assert.equal(context.dspAxCommandState.voiceOutputBytes, 640);
  assert.equal(context.dspAxCommandState.voiceNonZeroSampleValues, 0);
  assert.ok(
    ramBytes(context, surroundAddress, 640).every(value => value === 0),
  );
  assert.ok(ramBytes(context, lrAddress, 640).every(value => value === 0));
  assert.deepEqual(
    context.invalidations,
    [[0x6000, 640], [0x7000, 640]],
  );
  assert.equal(context.dspFirstUnsupported, null);
});

test("invalid model writeback falls back before any PB data or reservation commits", () => {
  const listAddress = 0x0100;
  const setupAddress = 0x1000;
  const parameterBlockAddress = 0x2000;
  const secondParameterBlockAddress = 0x3000;
  const surroundAddress = 0x6000;
  const lrAddress = 0x7000;
  const context = runtimeContext(() => ({
    ok: true,
    output: { order: "R,L", bytes: new Uint8Array(640).fill(0x7a) },
    parameterBlockWrites: [
      {
        logicalAddress: parameterBlockAddress,
        physicalAddress: parameterBlockAddress,
        byteLength: 236,
        data: new Uint8Array(236).fill(0x91),
      },
      {
        logicalAddress: secondParameterBlockAddress,
        physicalAddress: 0x3004,
        byteLength: 236,
        data: new Uint8Array(236).fill(0x92),
      },
    ],
  }));
  writeZeroSetup(context, setupAddress);
  ramBytes(context, parameterBlockAddress, 236).fill(0x21);
  ramBytes(context, secondParameterBlockAddress, 236).fill(0x22);
  ramBytes(context, surroundAddress, 640).fill(0x23);
  ramBytes(context, lrAddress, 640).fill(0x24);

  executeList(
    context,
    listAddress,
    voiceList({
      setupAddress,
      parameterBlockAddress,
      surroundAddress,
      lrAddress,
    }),
  );

  assert.ok(
    ramBytes(context, parameterBlockAddress, 236)
      .every(value => value === 0x21),
  );
  assert.ok(
    ramBytes(context, secondParameterBlockAddress, 236)
      .every(value => value === 0x22),
  );
  assert.ok(
    ramBytes(context, surroundAddress, 640).every(value => value === 0),
  );
  assert.ok(ramBytes(context, lrAddress, 640).every(value => value === 0));
  assert.deepEqual(
    context.invalidations,
    [[0x6000, 640], [0x7000, 640]],
  );
  assert.equal(context.dspAxCommandState.voiceMode, "silent-fallback");
  assert.equal(
    context.dspAxCommandState.voiceReason,
    "parameter-block-alias-mismatch",
  );
  assert.equal(context.dspAxCommandState.voiceParameterBlocks, 0);
  assert.equal(context.dspAxCommandState.voiceOutputBytes, 0);
  assert.equal(context.deviceEvents.get("dspAxVoiceFallback"), 1);
  assert.deepEqual(
    { ...context.dspFirstUnsupported },
    {
      instructionCycle: 20_000,
      dispatchPc: 0x80004000,
      stage: "voice",
      mode: "ax",
      reason: "parameter-block-alias-mismatch",
      ucodeHash: 0x4e8a8b21,
      code: null,
    },
  );
});

test("nonzero setup state never enters the voice model and keeps silent output", () => {
  let modelCalls = 0;
  const context = runtimeContext(() => {
    modelCalls += 1;
    throw new Error("must not run");
  });
  const setupAddress = 0x1000;
  const pointer = context.ramPointer(setupAddress, 54);
  context.view.setUint16(pointer, 1, false);
  const surroundAddress = 0x6000;
  const lrAddress = 0x7000;
  ramBytes(context, surroundAddress, 640).fill(0xa1);
  ramBytes(context, lrAddress, 640).fill(0xa2);

  executeList(
    context,
    0x0100,
    voiceList({
      setupAddress,
      parameterBlockAddress: 0x2000,
      surroundAddress,
      lrAddress,
    }),
  );

  assert.equal(modelCalls, 0);
  assert.equal(context.dspAxCommandState.voiceMode, "silent-fallback");
  assert.equal(
    context.dspAxCommandState.voiceReason,
    "nonzero-setup-buffer",
  );
  assert.equal(context.dspAxCommandState.voiceCommand, 0x00);
  assert.ok(ramBytes(context, lrAddress, 640).every(value => value === 0));
  assert.deepEqual(
    {
      stage: context.dspFirstUnsupported.stage,
      reason: context.dspFirstUnsupported.reason,
      code: context.dspFirstUnsupported.code,
    },
    { stage: "voice", reason: "nonzero-setup-buffer", code: 0x00 },
  );
});
