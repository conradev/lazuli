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
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

const LOOP_START = 0x80001000;
const TAIL_PC = LOOP_START + 0x2c;

function loopWords(pointerRegister) {
  const divisorRegister = pointerRegister === 3 ? 4 : 3;
  return [
    0x7cc60774, 0x54e0402e, 0x7ce60214, 0x7cc53816,
    0x7c063850, 0x5400f87e, 0x7c003214, 0x5400463e,
    (0x7c0001d6 | (divisorRegister << 11)) >>> 0,
    0x7ce03850,
    (0x38000001 | (pointerRegister << 21) | (pointerRegister << 16)) >>> 0,
    (0x88c00000 | (pointerRegister << 16)) >>> 0,
    0x7cc00775,
    0x4082ffcc,
  ];
}

function decoderContext(words) {
  const instructions = new Map(
    words.map((word, index) => [LOOP_START + index * 4, word >>> 0]),
  );
  const context = {
    probeInstructionWord: address => instructions.get(address >>> 0) ?? null,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("decodeStringHashLoop"), context);
  return context;
}

function mulhwu(lhs, rhs) {
  return Number((BigInt(lhs >>> 0) * BigInt(rhs >>> 0)) >> 32n) >>> 0;
}

function scalarHashStep(hash, byte) {
  let r6 = ((byte << 24) >> 24) >>> 0;
  let r0 = (hash << 8) >>> 0;
  let r7 = (r6 + r0) >>> 0;
  r6 = mulhwu(0x1381, r7);
  r0 = (r7 - r6) >>> 0;
  r0 >>>= 1;
  r0 = (r0 + r6) >>> 0;
  r0 >>>= 24;
  r0 = Math.imul(r0, 0x01ffffd9) >>> 0;
  return (r7 - r0) >>> 0;
}

function scalarHash(initialHash, values) {
  return values.reduce(scalarHashStep, initialHash >>> 0);
}

function fastForwardContext(options = {}) {
  const pointerRegister = options.pointerRegister ?? 3;
  const values = options.values ?? [0];
  const guestBase = options.guestBase ?? 0x80002000;
  const memory = Uint8Array.from(values);
  const registers = new Uint32Array(32);
  const divisorRegister = pointerRegister === 3 ? 4 : 3;
  registers[5] = (options.reciprocal ?? 0x1381) >>> 0;
  registers[divisorRegister] = (options.divisor ?? 0x01ffffd9) >>> 0;
  registers[pointerRegister] = guestBase >>> 0;
  registers[7] = (options.initialHash ?? 0) >>> 0;
  const reads = [];
  const writes = [];
  const expectedWords = loopWords(pointerRegister);
  const liveInstructions = new Map(
    expectedWords.map((word, index) => [LOOP_START + index * 4, word]),
  );
  const tailWords = expectedWords.slice(11);
  const bodyWords = expectedWords.slice();
  if (options.staleTail === true) tailWords[0] = (tailWords[0] ^ 1) >>> 0;
  if (options.staleBody === true) bodyWords[0] = (bodyWords[0] ^ 1) >>> 0;
  const tailBlock = {
    effectiveStart: TAIL_PC,
    effectiveBytes: tailWords.length * 4,
    instructionPageDependencies: [],
    instructionWords: tailWords,
  };
  const bodyBlock = {
    effectiveStart: LOOP_START,
    effectiveBytes: bodyWords.length * 4,
    instructionPageDependencies: [],
    instructionWords: bodyWords,
  };
  const context = {
    accelerations: new Map(),
    cycles: options.cycle ?? 0,
    eventCycle: options.eventCycle ?? null,
    instructions: 0,
    view: new DataView(memory.buffer),
    blockHasInstructionPageDependencies: () => options.instructionDependent === true,
    compiledBlock(address) {
      if (address === TAIL_PC) return tailBlock;
      if (address === LOOP_START && options.bodyAbsent !== true) return bodyBlock;
      return undefined;
    },
    decodeStringHashLoop: () => ({
      divisorRegister,
      expectedWords,
      loopStart: LOOP_START,
      pointerRegister,
    }),
    probeInstructionWord: address => liveInstructions.get(address >>> 0) ?? null,
    nextRuntimeEventCycle() {
      return context.eventCycle;
    },
    readGpr(register) {
      return registers[register] >>> 0;
    },
    writeGpr(register, value) {
      registers[register] = value >>> 0;
      writes.push([register, value >>> 0]);
    },
    resolveDataRange(address, size, write, updateHistory) {
      reads.push({ address, size, write, updateHistory });
      if (options.rejectCommit === true && size > 1) {
        return { kind: "non-contiguous" };
      }
      if (
        options.rejectAddress !== undefined
        && address <= options.rejectAddress
        && options.rejectAddress < address + size
      ) return { kind: "page-fault" };
      const offset = address - guestBase;
      if (offset < 0 || size <= 0 || offset + size > memory.length) {
        return { kind: "page-fault" };
      }
      return {
        kind: "mapped",
        physical: offset,
        translations: [{ source: options.mappingSource ?? "bat" }],
      };
    },
    physicalRamPointer(physical, size) {
      return physical >= 0 && physical + size <= memory.length ? physical : null;
    },
    physicalLockedCachePointer: () => null,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "compiledBlockInstructionWordsAreCurrent",
      "compiledBlockStartsWithInstructionWords",
      "stringHashCompiledBlocksMatch",
      "stringHashDataPointer",
      "stringHashStep",
      "preflightStringHashLoop",
      "hashStringPrefix",
      "loopSkipBudget",
      "fastForwardStringHashLoop",
    ].map(extractFunction).join("\n\n"),
    context,
  );
  return { context, guestBase, memory, pointerRegister, reads, registers, writes };
}

function runCompiledTail(state, xerSo = 0) {
  const pointer = state.registers[state.pointerRegister] >>> 0;
  const byte = state.memory[pointer - state.guestBase];
  const signed = (byte << 24) >> 24;
  state.registers[6] = byte;
  state.registers[0] = signed >>> 0;
  const relation = signed < 0 ? 0b1000 : signed > 0 ? 0b0100 : 0b0010;
  return { branchTaken: byte !== 0, cr0: relation | (xerSo & 1) };
}

test("decoder accepts only the exact r3/r4 hash idioms", () => {
  for (const pointerRegister of [3, 4]) {
    const words = loopWords(pointerRegister);
    const decoded = decoderContext(words).decodeStringHashLoop(TAIL_PC);
    assert.notEqual(decoded, null);
    assert.equal(decoded.divisorRegister, pointerRegister === 3 ? 4 : 3);
    assert.equal(decoded.loopStart, LOOP_START);
    assert.equal(decoded.pointerRegister, pointerRegister);
    assert.deepEqual(Array.from(decoded.expectedWords), words);
    for (let index = 0; index < words.length; index += 1) {
      const changed = words.slice();
      changed[index] = (changed[index] ^ 1) >>> 0;
      assert.equal(
        decoderContext(changed).decodeStringHashLoop(TAIL_PC),
        null,
        `word ${index} must be exact for pointer r${pointerRegister}`,
      );
    }
  }
  const wrongDivisor = loopWords(3);
  wrongDivisor[8] = 0x7c0019d6;
  assert.equal(decoderContext(wrongDivisor).decodeStringHashLoop(TAIL_PC), null);
});

test("compiled blocks retain only their executable staged-word prefix", () => {
  const compilerBuffer = new ArrayBuffer(256);
  const staged = [0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00];
  const context = {
    captureInstructionPageDependencies(_pc, effectiveBytes) {
      assert.equal(effectiveBytes, 8);
      return { dependencies: [], fault: null };
    },
    check(condition, message) {
      if (!condition) throw new Error(message);
    },
    stageInstructionBlock(view, inputPointer) {
      staged.forEach((word, index) =>
        view.setUint32(inputPointer + index * 4, word, true)
      );
      return { fault: null, wordCount: staged.length };
    },
  };
  const compiler = {
    memory: { buffer: compilerBuffer },
    ppcwasmjit_compile(inputPointer, wordCount) {
      assert.equal(wordCount, 4);
      new DataView(compilerBuffer).setUint32(inputPointer, 0, true);
      return 1;
    },
    ppcwasmjit_maximum_executed: () => (5 << 16) | 2,
    ppcwasmjit_output_length: () => 4,
    ppcwasmjit_output_pointer: () => 128,
    ppcwasmjit_pattern: () => 0,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("compileBlock"), context);
  const block = context.compileBlock(compiler, 0, 0x80001000);
  assert.equal(block.effectiveBytes, 8);
  assert.deepEqual(Array.from(block.instructionWords), staged.slice(0, 2));
});

test("validated tail writes r6, r0, and CR0 before branching", () => {
  const words = loopWords(3);
  const load = words[11];
  const extension = words[12];
  assert.equal(load >>> 26, 34);
  assert.equal((load >>> 21) & 31, 6);
  assert.equal((extension >>> 21) & 31, 6);
  assert.equal((extension >>> 16) & 31, 0);
  assert.equal(extension & 1, 1);
  assert.equal(words[13], 0x4082ffcc);
});

test("batched hash and final tail match the scalar instruction sequence", () => {
  const cases = [
    { bytes: [], hash: 0 },
    { bytes: [...Buffer.from("LuigiModel")], hash: 0 },
    { bytes: [0x80, 0xff, 0x7f, 0x81], hash: 0x12345678 },
    { bytes: [0xff, 0xff, 0x01, 0x80], hash: 0xffffffff },
  ];
  for (const pointerRegister of [3, 4]) {
    for (const entry of cases) {
      const state = fastForwardContext({
        pointerRegister,
        values: [...entry.bytes, 0],
        initialHash: entry.hash,
      });
      const oldR0 = state.registers[0];
      const accelerated = state.context.fastForwardStringHashLoop(TAIL_PC, 5 << 16);
      assert.equal(accelerated, entry.bytes.length !== 0);
      assert.equal(state.registers[7], scalarHash(entry.hash, entry.bytes));
      assert.equal(
        state.registers[pointerRegister],
        state.guestBase + entry.bytes.length,
      );
      if (entry.bytes.length !== 0) {
        assert.equal(state.registers[0], oldR0, "batch leaves r0 to the tail");
        assert.equal(state.context.instructions, entry.bytes.length * 14);
        assert.equal(state.context.cycles, entry.bytes.length * 25);
        assert.equal(state.context.accelerations.get("stringHashBytes"), entry.bytes.length);
        assert.equal(state.context.accelerations.get("stringHashRuns"), 1);
      }
      const tail = runCompiledTail(state, 1);
      assert.equal(tail.branchTaken, false);
      assert.equal(state.registers[6], 0);
      assert.equal(state.registers[0], 0);
      assert.equal(tail.cr0, 0b0011);
    }
  }
});

test("hash step matches reciprocal arithmetic for wrap-heavy inputs", () => {
  const { context } = fastForwardContext();
  let random = 0x6d2b79f5;
  for (let index = 0; index < 4096; index += 1) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const byte = random >>> 24;
    const hash = (random ^ Math.imul(index, 0x9e3779b1)) >>> 0;
    assert.equal(context.stringHashStep(hash, byte), scalarHashStep(hash, byte));
  }
});

test("event deadline skips only whole 14-instruction iterations", () => {
  const state = fastForwardContext({
    values: [0x41, 0x42, 0x43, 0x44, 0],
    initialHash: 0x89abcdef,
    cycle: 100,
    eventCycle: 155,
  });
  assert.equal(state.context.fastForwardStringHashLoop(TAIL_PC, 5 << 16), true);
  assert.equal(state.registers[3], state.guestBase + 2);
  assert.equal(state.registers[7], scalarHash(0x89abcdef, [0x41, 0x42]));
  assert.equal(state.context.instructions, 28);
  assert.equal(state.context.cycles, 150);
  assert.deepEqual(state.reads.at(-1), {
    address: state.guestBase,
    size: 2,
    write: false,
    updateHistory: false,
  });
  const tail = runCompiledTail(state);
  assert.equal(tail.branchTaken, true);
  assert.equal(state.registers[6], 0x43);
  assert.equal(state.registers[0], 0x43);
  assert.equal(tail.cr0, 0b0100);
});

test("stale compiled tail or body words reject before reading guest data", () => {
  for (const options of [
    { staleTail: true },
    { staleBody: true },
  ]) {
    const state = fastForwardContext({ ...options, values: [0x41, 0] });
    const before = Array.from(state.registers);
    assert.equal(state.context.fastForwardStringHashLoop(TAIL_PC, 5 << 16), false);
    assert.deepEqual(Array.from(state.registers), before);
    assert.equal(state.reads.length, 0);
    assert.equal(state.writes.length, 0);
  }

  const absentBody = fastForwardContext({ bodyAbsent: true, values: [0x41, 0] });
  assert.equal(
    absentBody.context.fastForwardStringHashLoop(TAIL_PC, 5 << 16),
    true,
    "an absent body executes from the exact live words after the skipped tail",
  );
});

test("hashed-page string data is rejected by a no-history translation", () => {
  const state = fastForwardContext({
    mappingSource: "page",
    values: [0x41, 0],
  });
  const before = Array.from(state.registers);
  assert.equal(state.context.fastForwardStringHashLoop(TAIL_PC, 5 << 16), false);
  assert.deepEqual(Array.from(state.registers), before);
  assert.deepEqual(state.reads, [{
    address: state.guestBase,
    size: 1,
    write: false,
    updateHistory: false,
  }]);
  assert.equal(state.writes.length, 0);
});

test("deadline and preflight failures never mutate guest state", () => {
  const cases = [
    { values: [0x41, 0], cycle: 100, eventCycle: 129 },
    { values: [0x41, 0], reciprocal: 0x1380 },
    { values: [0x41, 0], divisor: 0x01ffffd8 },
    { values: [0x41, 0], instructionDependent: true },
    { values: [0x41, 0], mappingSource: "page" },
    { values: [0x41, 0x42, 0], rejectAddress: 0x80002001 },
    { values: new Array(4096).fill(0x41) },
    { values: [0x41, 0x42, 0], rejectCommit: true },
  ];
  for (const options of cases) {
    const state = fastForwardContext(options);
    const before = Array.from(state.registers);
    assert.equal(state.context.fastForwardStringHashLoop(TAIL_PC, 5 << 16), false);
    assert.deepEqual(Array.from(state.registers), before);
    assert.equal(state.writes.length, 0);
    assert.equal(state.context.instructions, 0);
    assert.equal(state.context.cycles, options.cycle ?? 0);
    assert.equal(state.context.accelerations.size, 0);
    assert.equal(state.reads.some(read => read.updateHistory), false);
  }
});

test("preflight rejects effective-address wrap before commit", () => {
  const state = fastForwardContext({ guestBase: 0xffffffff, values: [0x41] });
  const before = Array.from(state.registers);
  assert.equal(state.context.fastForwardStringHashLoop(TAIL_PC, 5 << 16), false);
  assert.deepEqual(Array.from(state.registers), before);
  assert.equal(state.reads.length, 1);
  assert.equal(state.reads[0].address, 0xffffffff);
  assert.equal(state.reads[0].updateHistory, false);
});

test("the hash load boundary cannot be linked or fused through", () => {
  const context = {
    blockPattern: { none: 0, idleBasic: 2, idleVolatileRead: 3 },
    compiledBlock: () => ({ pattern: 0 }),
    decodeStringHashLoop: pc => pc === TAIL_PC ? {} : null,
    isCacheLineLoop: () => false,
    decodeMemset32ByteLoop: () => null,
    isMusyxAramQueueFullWaitBackedge: () => false,
    isAiSrcInitSampleCounterWaitCandidate: () => false,
    isDspReceiveMailboxWaitCandidate: () => false,
  };
  vm.createContext(context);
  vm.runInContext(
    ["isSemanticIdlePattern", "isRecognizedLoopPc"]
      .map(extractFunction).join("\n\n"),
    context,
  );
  assert.equal(context.isRecognizedLoopPc(TAIL_PC), true);
  assert.equal(context.isRecognizedLoopPc(TAIL_PC + 4), false);
  const fastForward = extractFunction("fastForwardRecognizedLoop");
  assert.ok(
    fastForward.indexOf("fastForwardStringHashLoop") < fastForward.indexOf("fetchWord"),
  );
  assert.match(
    extractFunction("isRecognizedLoopPc"),
    /decodeStringHashLoop\(candidatePc\) !== null/,
  );
});
