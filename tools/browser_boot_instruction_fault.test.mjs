#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

const intendedFunctions = [
  "resolveInstructionEffectiveAddress",
  "resolveInstructionFetch",
  "fetchInstructionWord",
  "probeInstructionWord",
  "stageInstructionBlock",
  "instructionStorageCause",
  "raiseInstructionFetchFault",
];
const runtimeReady = intendedFunctions.every(name =>
  source.includes(`function ${name}(`)
);
const semanticTest = runtimeReady ? test : test.skip;

function writeInstructionBat(context, index, upper, lower) {
  const [lowerOffset, upperOffset] = context.instructionBatOffsets[index];
  context.view.setUint32(context.cpu + upperOffset, upper >>> 0, true);
  context.view.setUint32(context.cpu + lowerOffset, lower >>> 0, true);
}

function makeFetchContext() {
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
  const context = {
    bytes: new Uint8Array(buffer),
    cpu: 0,
    instructionBatOffsets: [
      [0x40, 0x44],
      [0x48, 0x4c],
      [0x50, 0x54],
      [0x58, 0x5c],
    ],
    instructionTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    dataTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    lockedCache: 0x180000,
    lockedCacheSize: 0x4000,
    msrOffset: 0x20,
    physicalMmioBase: 0x0c000000,
    ram: 0x40000,
    ramSize: 0x40000,
    sdr1Offset: 0x140,
    segmentRegisterOffsets: Array.from(
      { length: 16 },
      (_unused, index) => 0x100 + index * 4,
    ),
    mmioSize: 0x20000,
    view: new DataView(buffer),
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "batAllowsAccess",
      "translateBatAddress",
      "readInstructionBats",
      "normalizePhysicalMemoryAddress",
      "physicalRamPointer",
      "physicalLockedCachePointer",
      "resolveInstructionEffectiveAddress",
      "readSegmentRegisters",
      "resetTranslationLookasideBuffer",
      "initializeTranslationLookasideBuffers",
      "instructionTlbSetIndex",
      "lookupInstructionTlb",
      "fillInstructionTlb",
      "resolveInstructionTlbEntry",
      "resolveInstructionPageAddress",
      "resolveInstructionTranslation",
      "resolveInstructionFetch",
      "fetchInstructionWord",
      "instructionStorageCause",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.instruction-fault-fetch.js" },
  );
  return context;
}

function makeExceptionContext() {
  const buffer = new ArrayBuffer(1024 * 1024);
  const context = {
    cpu: 0,
    ctrOffset: 0x90,
    darOffset: 0x88,
    dispatches: 19,
    exceptionCounts: new Map(),
    exceptionFirstByVector: {},
    exceptionFirstTrace: [],
    exceptionTrace: [],
    fetchWordCalls: 0,
    firstDsi: null,
    gprOffsets: Array.from({ length: 32 }, (_unused, index) => 0xa0 + index * 4),
    lastUnmappedAccess: null,
    lrOffset: 0x8c,
    msrOffset: 0x20,
    namespaceTransitions: [],
    pcOffset: 0x24,
    recentPcs: [0x80000ff0, 0x80000ff4, 0x80000ff8, 0x80000ffc],
    srr0Offset: 0x80,
    srr1Offset: 0x84,
    view: new DataView(buffer),
  };
  context.fetchWord = () => {
    context.fetchWordCalls += 1;
    throw new Error("recursive instruction fetch from exception diagnostics");
  };
  context.hex32 = value =>
    "0x" + (value >>> 0).toString(16).padStart(8, "0");
  context.rebuildDataFastmem = () => {};
  context.synchronizeInstructionAddressSpace = reason => {
    context.namespaceTransitions.push({
      reason,
      msr: context.view.getUint32(context.cpu + context.msrOffset, true),
      pc: context.view.getUint32(context.cpu + context.pcOffset, true),
    });
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "instructionStorageCause",
      "raiseException",
      "raiseInstructionFetchFault",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.instruction-fault-exception.js" },
  );
  return context;
}

test("instruction fetch faults expose a tagged runtime contract", () => {
  assert.deepEqual(
    intendedFunctions.filter(name => !source.includes(`function ${name}(`)),
    [],
    "implement the focused instruction-fault helpers before enabling semantic tests",
  );
});

semanticTest("BAT resolution distinguishes lookup misses, protection, and backing", () => {
  const context = makeFetchContext();
  const effective = 0x90001234;
  const mappedBat = [0x90000003, 0x00020002];
  const protectedBat = [0x90000003, 0x00020000];
  const unbackedBat = [0x90000003, 0x04000002];

  assert.equal(
    context.resolveInstructionEffectiveAddress(effective, 0x20, [mappedBat]).kind,
    "mapped",
  );
  const batMiss = context.resolveInstructionEffectiveAddress(
    0xa0001234,
    0x20,
    [mappedBat],
  );
  assert.equal(batMiss.kind, "bat-miss");
  assert.equal(
    context.instructionStorageCause(batMiss),
    null,
    "a BAT miss remains pending segment/page translation and is not an ISI",
  );
  assert.equal(
    context.resolveInstructionEffectiveAddress(effective, 0x20, [protectedBat]).kind,
    "protection",
    "a matching BAT with PP=0 is not a page-table miss",
  );
  writeInstructionBat(context, 0, ...mappedBat);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(context, index, 0, 0);
  }
  context.view.setUint32(context.cpu + context.msrOffset, 0x20, true);
  const mapped = context.resolveInstructionFetch(effective, 4);
  assert.equal(mapped.kind, "mapped");
  assert.equal(mapped.effective >>> 0, effective);
  assert.equal(mapped.physical >>> 0, 0x00021234);
  assert.equal(mapped.pointer, context.ram + 0x00021234);

  writeInstructionBat(context, 0, ...unbackedBat);
  const unbacked = context.resolveInstructionFetch(effective, 4);
  assert.equal(unbacked.kind, "unbacked");
  assert.equal(unbacked.effective >>> 0, effective);
  assert.equal(unbacked.physical >>> 0, 0x04001234);
  assert.equal(
    context.instructionStorageCause(unbacked),
    null,
    "a translated access to nonexistent physical storage is not an ISI",
  );
});

semanticTest("block staging compiles a valid prefix without probing past its first fault", () => {
  const compilerMemory = new ArrayBuffer(64);
  const compilerView = new DataView(compilerMemory);
  const probes = [];
  const words = new Map([
    [0x80001000, 0x60000000],
    [0x80001004, 0x4e800020],
  ]);
  const context = {
    fetchInstructionWord(effective) {
      const address = effective >>> 0;
      probes.push(address);
      if (words.has(address)) {
        return {
          kind: "mapped",
          effective: address,
          physical: address - 0x80000000,
          pointer: 0,
          word: words.get(address),
        };
      }
      return { kind: "bat-miss", effective: address };
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("stageInstructionBlock"), context, {
    filename: "browser_boot.instruction-fault-stage.js",
  });

  const staged = context.stageInstructionBlock(
    compilerView,
    0,
    0x80001000,
    16,
  );
  assert.equal(staged.wordCount, 2);
  assert.equal(staged.fault.kind, "bat-miss");
  assert.equal(staged.fault.effective >>> 0, 0x80001008);
  assert.deepEqual(probes, [0x80001000, 0x80001004, 0x80001008]);
  assert.equal(compilerView.getUint32(0, true), 0x60000000);
  assert.equal(compilerView.getUint32(4, true), 0x4e800020);
  assert.throws(
    () => context.stageInstructionBlock(compilerView, 0, 0x80001000, 65),
    /between 1 and 64 words/,
  );

  assert.match(
    extractFunction("compileBlock"),
    /ppcwasmjit_compile\(\s*inputPointer,\s*(?:staged\.)?wordCount\s*\)/,
    "the compiler ABI must receive the mapped prefix length, never a hard-coded 64",
  );
});

semanticTest("loop recognizers do not throw while a staged prefix ends at a fetch fault", () => {
  const currentPc = 0x80002000;
  const probes = [];
  const directFetches = [];
  const context = {
    fetchInstructionWord(effective) {
      const address = effective >>> 0;
      probes.push(address);
      return address === currentPc
        ? { kind: "mapped", effective: address, word: 0x60000000 }
        : { kind: "bat-miss", effective: address };
    },
    fetchWord(effective) {
      const address = effective >>> 0;
      directFetches.push(address);
      if (address !== currentPc) throw new Error("recognizer fetched beyond mapped prefix");
      return 0x60000000;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "probeInstructionWord",
      "decodeMemset32ByteLoop",
      "isCacheLineLoop",
      "fastForwardRecognizedLoop",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.instruction-fault-recognizer.js" },
  );

  assert.doesNotThrow(() => context.fastForwardRecognizedLoop(currentPc, 0));
  assert.deepEqual(directFetches, [currentPc]);
  assert.deepEqual(probes, [currentPc, currentPc, currentPc + 4]);
});

semanticTest("a first-word page-table fault enters a low-vector ISI without recursive fetch", () => {
  const context = makeExceptionContext();
  const oldPc = 0x80001000;
  const oldMsr = 0x00008032;
  context.view.setUint32(context.cpu + context.pcOffset, oldPc, true);
  context.view.setUint32(context.cpu + context.msrOffset, oldMsr, true);
  context.view.setUint32(context.cpu + context.srr1Offset, 0, true);

  assert.equal(context.raiseInstructionFetchFault({
    kind: "page-fault",
    effective: oldPc,
  }), true);

  assert.equal(context.fetchWordCalls, 0);
  assert.equal(context.view.getUint32(context.cpu + context.srr0Offset, true), oldPc);
  assert.equal(
    context.view.getUint32(context.cpu + context.srr1Offset, true),
    0x40008032,
  );
  assert.equal(context.view.getUint32(context.cpu + context.msrOffset, true), 0);
  assert.equal(context.view.getUint32(context.cpu + context.pcOffset, true), 0x00000400);
  assert.equal(context.exceptionCounts.get("0x0400"), 1);
  assert.equal(context.exceptionFirstByVector["0x0400"].instruction, null);
  assert.deepEqual(context.namespaceTransitions, [{
    reason: "exception",
    msr: 0,
    pc: oldPc,
  }]);
});

semanticTest("ISI causes preserve IP for high vectors and keep unbacked faults separate", () => {
  const context = makeExceptionContext();
  const oldPc = 0x81234560;
  const oldMsr = 0x00008072;
  context.view.setUint32(context.cpu + context.pcOffset, oldPc, true);
  context.view.setUint32(context.cpu + context.msrOffset, oldMsr, true);

  assert.equal(context.instructionStorageCause({ kind: "bat-miss" }), null);
  assert.equal(context.instructionStorageCause({ kind: "page-fault" }), 0x40000000);
  assert.equal(context.instructionStorageCause({ kind: "guarded" }), 0x10000000);
  assert.equal(context.instructionStorageCause({ kind: "no-execute" }), 0x10000000);
  assert.equal(context.instructionStorageCause({ kind: "protection" }), 0x08000000);
  assert.equal(context.instructionStorageCause({ kind: "unbacked" }), null);

  assert.equal(context.raiseInstructionFetchFault({
    kind: "protection",
    effective: oldPc,
  }), true);
  assert.equal(context.fetchWordCalls, 0);
  assert.equal(context.view.getUint32(context.cpu + context.srr0Offset, true), oldPc);
  assert.equal(
    context.view.getUint32(context.cpu + context.srr1Offset, true),
    0x08008072,
  );
  assert.equal(context.view.getUint32(context.cpu + context.msrOffset, true), 0x40);
  assert.equal(context.view.getUint32(context.cpu + context.pcOffset, true), 0xfff00400);

  const before = {
    pc: context.view.getUint32(context.cpu + context.pcOffset, true),
    srr0: context.view.getUint32(context.cpu + context.srr0Offset, true),
    srr1: context.view.getUint32(context.cpu + context.srr1Offset, true),
    isi: context.exceptionCounts.get("0x0400"),
  };
  assert.equal(context.raiseInstructionFetchFault({
    kind: "unbacked",
    effective: 0xfff00400,
    physical: 0xfff00400,
  }), false);
  assert.deepEqual({
    pc: context.view.getUint32(context.cpu + context.pcOffset, true),
    srr0: context.view.getUint32(context.cpu + context.srr0Offset, true),
    srr1: context.view.getUint32(context.cpu + context.srr1Offset, true),
    isi: context.exceptionCounts.get("0x0400"),
  }, before);
});
