#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

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

const fifoFunctions = [
  "gxReadU32",
  "gxReadU16",
  "decodeGxCommands",
  "gxFifoBufferedBytes",
  "gxPreflightDecodeAppend",
  "decodeGxFifo",
  "appendGxFifoBytes",
  "drainGxFifoStaging",
];

function makeContext({
  capacityWatermarkBytes = 16,
  maximumBufferedBytes = 16 * 1024 * 1024,
  recordPrimitivePayload = true,
  vertexSize = 2,
} = {}) {
  const semanticEvents = [];
  const memory = new ArrayBuffer(128);
  const context = {
    beginWorkerPhaseTiming() { return null; },
    bytes: new Uint8Array(memory),
    gxBpLoads: 0,
    gxCpLoads: 0,
    gxCpRegisters: new Uint32Array(256),
    gxDecodeAttempts: 0,
    gxDecodeBlockedSkips: 0,
    gxDecodeBuffer: [],
    gxDecodeCapacityWatermarkBytes: capacityWatermarkBytes,
    gxDecodeCompactions: 0,
    gxDecodeCapacityWatermarkGrowths: 0,
    gxDecodePreDecodeHighWaterBytes: 0,
    gxDecodeMaximumBufferedBytes: maximumBufferedBytes,
    gxDecodeRetryAtBufferedBytes: 1,
    gxDecodedCommands: 0,
    gxDisplayListBytes: 0,
    gxDisplayListErrors: 0,
    gxDisplayLists: 0,
    gxFifoBytes: 0,
    gxFifoHash: 0x811c9dc5,
    gxFifoQuantizedStores: 0,
    gxFifoSample: [],
    gxFifoStagingBytes: 0,
    gxFifoStagingCapacity: 32,
    gxFifoStagingData: 80,
    gxFifoStagingDrains: 0,
    gxFifoStagingMeta: 64,
    gxFifoStagingQuantizedStores: 0,
    gxFifoStagingStores: 0,
    gxFifoStores: 0,
    gxIndexedXfLoads: 0,
    gxPrimitives: 0,
    gxUnknownOpcodes: 0,
    gxVertices: 0,
    gxXfLoads: 0,
    ramPointer() { return null; },
    recordGxBpWrite(word) {
      context.gxBpLoads += 1;
      semanticEvents.push(["bp", word >>> 0]);
    },
    recordGxIndexedXfWrite(opcode, word) {
      semanticEvents.push(["indexed-xf", opcode, word >>> 0]);
    },
    recordGxPrimitive(opcode, primitiveSource, offset, vertices, bytesPerVertex) {
      semanticEvents.push([
        "primitive",
        opcode,
        vertices,
        bytesPerVertex,
        recordPrimitivePayload
          ? Array.from(primitiveSource.slice(
            offset,
            offset + vertices * bytesPerVertex,
          ))
          : vertices * bytesPerVertex,
      ]);
    },
    recordGxXfWrite(address, word) {
      semanticEvents.push(["xf", address, word >>> 0]);
    },
    recordWorkerPhaseTiming() {},
    view: new DataView(memory),
    workerHostTimings: { fifoDecode: {}, fifoStagingDrainInclusive: {} },
    gxVertexSize() { return vertexSize; },
  };
  vm.createContext(context);
  vm.runInContext(
    fifoFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx_fifo.js" },
  );
  context.semanticEvents = semanticEvents;
  return context;
}

function be32(value) {
  return [value >>> 24, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff];
}

function mixedCommandStream() {
  return Uint8Array.from([
    0x00,
    0x08, 0x50, ...be32(0x12345678),
    0x10, ...be32(0x00010010), ...be32(0x11121314), ...be32(0x21222324),
    0x20, ...be32(0x31323334),
    0x40, ...be32(0x80001000), ...be32(0x20),
    0x61, ...be32(0x41424344),
    0x80, 0x00, 0x03, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56,
    0x7f,
  ]);
}

function append(context, chunk) {
  context.appendGxFifoBytes(chunk, chunk.length);
}

function liveBytes(context) {
  return Array.from(context.gxDecodeBuffer);
}

function stagingMetadata(context) {
  return [0, 4, 8].map(offset =>
    context.view.getUint32(context.gxFifoStagingMeta + offset, true));
}

function semanticSnapshot(context) {
  return {
    bpLoads: context.gxBpLoads,
    bytes: context.gxFifoBytes,
    commands: context.gxDecodedCommands,
    cpLoads: context.gxCpLoads,
    cpRegister: context.gxCpRegisters[0x50],
    displayListBytes: context.gxDisplayListBytes,
    displayListErrors: context.gxDisplayListErrors,
    displayLists: context.gxDisplayLists,
    events: context.semanticEvents,
    hash: context.gxFifoHash,
    indexedXfLoads: context.gxIndexedXfLoads,
    liveBytes: liveBytes(context),
    primitives: context.gxPrimitives,
    sample: context.gxFifoSample,
    stores: context.gxFifoStores,
    unknownOpcodes: context.gxUnknownOpcodes,
    vertices: context.gxVertices,
    xfLoads: context.gxXfLoads,
  };
}

function decodeChunks(chunks, options) {
  const context = makeContext(options);
  for (const chunk of chunks) append(context, chunk);
  return { context, snapshot: semanticSnapshot(context) };
}

test("bounded GX FIFO carry is invariant across every split and byte-sized drains", () => {
  const stream = mixedCommandStream();
  const direct = decodeChunks([stream], { capacityWatermarkBytes: stream.length });
  const expected = direct.snapshot;
  assert.deepEqual(expected.liveBytes, []);
  assert.equal(expected.commands, 7);
  assert.equal(expected.unknownOpcodes, 1);
  assert.deepEqual(expected.events, [
    ["xf", 0x10, 0x11121314],
    ["xf", 0x11, 0x21222324],
    ["indexed-xf", 0x20, 0x31323334],
    ["bp", 0x41424344],
    ["primitive", 0x80, 3, 2, [0x51, 0x52, 0x53, 0x54, 0x55, 0x56]],
  ]);
  assert.equal(direct.context.gxDecodeBuffer.length, 0);
  assert.equal(direct.context.gxDecodeAttempts, 1);
  assert.equal(direct.context.gxDecodeCapacityWatermarkGrowths, 0);
  assert.equal(direct.context.gxDecodeCapacityWatermarkBytes, stream.length);
  assert.equal(direct.context.gxDecodePreDecodeHighWaterBytes, stream.length);

  for (let split = 1; split < stream.length; split += 1) {
    const actual = decodeChunks([
      stream.subarray(0, split),
      stream.subarray(split),
    ]).snapshot;
    assert.deepEqual(actual, expected, `two-way split at byte ${split}`);
  }

  const byteChunks = Array.from(stream, (_byte, index) => stream.subarray(index, index + 1));
  assert.deepEqual(decodeChunks(byteChunks).snapshot, expected);

  let offset = 0;
  let state = 0x12345678;
  const randomChunks = [];
  while (offset < stream.length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const size = Math.min(stream.length - offset, 1 + (state % 11));
    randomChunks.push(stream.subarray(offset, offset + size));
    offset += size;
  }
  assert.deepEqual(decodeChunks(randomChunks).snapshot, expected);
});

test("incomplete GX commands have no effects and cache their exact requirement", () => {
  const context = makeContext();
  const xf = Uint8Array.from([
    0x10, ...be32(0x00010020), ...be32(0x01020304), ...be32(0x05060708),
  ]);
  append(context, xf.subarray(0, 4));
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 5);
  assert.equal(context.gxDecodedCommands, 0);
  assert.deepEqual(context.semanticEvents, []);

  append(context, xf.subarray(4, 5));
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 13);
  assert.equal(context.gxDecodedCommands, 0);
  append(context, xf.subarray(5, 12));
  assert.equal(context.gxDecodeAttempts, 2, "payload drains below the requirement are skipped");
  assert.equal(context.gxDecodeBlockedSkips, 1);
  assert.equal(context.gxDecodedCommands, 0);
  append(context, xf.subarray(12));
  assert.equal(context.gxDecodedCommands, 1);
  assert.equal(context.gxXfLoads, 1);
  assert.equal(context.semanticEvents.length, 2);
  assert.equal(context.gxFifoBufferedBytes(), 0);
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 1);
});

test("bounded GX FIFO carry compacts an unread tail without stale bytes", () => {
  const context = makeContext({ capacityWatermarkBytes: 8 });
  append(context, Uint8Array.from([0x61]));
  append(context, Uint8Array.from([
    ...be32(0x12345678),
    0x61, 0xaa, 0xbb,
  ]));
  assert.deepEqual(context.semanticEvents, [["bp", 0x12345678]]);
  assert.deepEqual(liveBytes(context), [0x61, 0xaa, 0xbb]);
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 5);

  append(context, Uint8Array.from([0xcc, 0xdd]));
  assert.equal(context.gxDecodeCompactions, 1);
  assert.equal(context.gxDecodeCapacityWatermarkGrowths, 0);
  assert.equal(context.gxDecodedCommands, 2);
  assert.deepEqual(context.semanticEvents, [
    ["bp", 0x12345678],
    ["bp", 0xaabbccdd],
  ]);
  assert.deepEqual(liveBytes(context), []);
});

test("FIFO carry owns an incomplete command tail", () => {
  const context = makeContext({ capacityWatermarkBytes: 8 });
  const source = Uint8Array.from([0x00, 0x61, 0x12]);
  append(context, source);
  assert.deepEqual(liveBytes(context), [0x61, 0x12]);
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 5);
  source.fill(0xff);

  append(context, Uint8Array.from([0x34, 0x56, 0x78]));
  assert.equal(context.gxDecodeCompactions, 1);
  assert.equal(context.gxDecodeCapacityWatermarkGrowths, 0);
  assert.equal(context.gxDecodedCommands, 2);
  assert.deepEqual(context.semanticEvents, [["bp", 0x12345678]]);
  assert.deepEqual(liveBytes(context), []);
});

test("FIFO carry grows to own a large incomplete tail", () => {
  const context = makeContext({ capacityWatermarkBytes: 8, vertexSize: 2 });
  const source = Uint8Array.from([
    0x80, 0x00, 0x06,
    1, 2, 3, 4, 5, 6, 7,
  ]);
  append(context, source);
  assert.equal(context.gxDecodeCapacityWatermarkGrowths, 1);
  assert.deepEqual(liveBytes(context), Array.from(source));
  source.fill(0xff);

  append(context, Uint8Array.from([8, 9, 10, 11, 12]));
  assert.equal(context.gxDecodeCapacityWatermarkGrowths, 1);
  assert.equal(context.gxDecodedCommands, 1);
  assert.deepEqual(context.semanticEvents, [[
    "primitive", 0x80, 6, 2,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  ]]);
  assert.deepEqual(liveBytes(context), []);
});

test("bounded GX FIFO carry grows beyond one staging batch for a legal primitive", () => {
  const vertices = 0xffff;
  const vertexSize = 5;
  const stream = new Uint8Array(3 + vertices * vertexSize);
  stream.set([0x80, 0xff, 0xff]);
  for (let index = 3; index < stream.length; index += 1) stream[index] = index & 0xff;

  const chunks = [];
  for (let offset = 0; offset < stream.length; offset += 48) {
    chunks.push(stream.subarray(offset, Math.min(stream.length, offset + 48)));
  }
  const { context } = decodeChunks(chunks, {
    capacityWatermarkBytes: 64,
    recordPrimitivePayload: false,
    vertexSize,
  });
  assert.equal(stream.length > 256 * 1024, true);
  assert.equal(context.gxDecodeCapacityWatermarkGrowths > 0, true);
  assert.equal(context.gxDecodePreDecodeHighWaterBytes, stream.length);
  assert.equal(context.gxDecodeAttempts, 2);
  assert.equal(context.gxPrimitives, 1);
  assert.equal(context.gxVertices, vertices);
  assert.equal(context.gxDecodedCommands, 1);
  assert.deepEqual(liveBytes(context), []);
});

test("an incomplete display list cannot poison the top-level retry threshold", () => {
  const context = makeContext();
  context.bytes.set([0x61, 0x12], 16);
  context.ramPointer = (address, size) => address === 0x20 && size === 2 ? 16 : null;
  append(context, Uint8Array.from([
    0x40, ...be32(0x20), ...be32(2),
    0x61, ...be32(0x12345678),
  ]));

  assert.equal(context.gxDisplayLists, 1);
  assert.equal(context.gxDisplayListErrors, 1);
  assert.equal(context.gxDecodedCommands, 2);
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 1);
  assert.deepEqual(context.semanticEvents, [["bp", 0x12345678]]);
  assert.deepEqual(liveBytes(context), []);
});

test("bounded GX FIFO carry fails closed before its configured byte bound", () => {
  const context = makeContext({ capacityWatermarkBytes: 16, maximumBufferedBytes: 128 });
  assert.throws(
    () => append(context, new Uint8Array(129)),
    /GX FIFO decode carry overflow: 129 > 128/,
  );
  assert.equal(context.gxFifoBytes, 0);
  assert.deepEqual(liveBytes(context), []);
});

test("bounded GX FIFO carry overflow leaves retained bytes and diagnostics atomic", () => {
  const context = makeContext({
    capacityWatermarkBytes: 8,
    maximumBufferedBytes: 8,
    vertexSize: 2,
  });
  append(context, Uint8Array.from([0x80, 0x00, 0x04, 1, 2, 3, 4]));
  const before = {
    bytes: context.gxFifoBytes,
    hash: context.gxFifoHash,
    liveBytes: liveBytes(context),
    attempts: context.gxDecodeAttempts,
    blockedSkips: context.gxDecodeBlockedSkips,
    capacityWatermarkBytes: context.gxDecodeCapacityWatermarkBytes,
    capacityWatermarkGrowths: context.gxDecodeCapacityWatermarkGrowths,
    compactions: context.gxDecodeCompactions,
    preDecodeHighWaterBytes: context.gxDecodePreDecodeHighWaterBytes,
    quantizedStores: context.gxFifoQuantizedStores,
    retryAtBufferedBytes: context.gxDecodeRetryAtBufferedBytes,
    sample: [...context.gxFifoSample],
    stores: context.gxFifoStores,
  };
  assert.throws(
    () => append(context, Uint8Array.from([5, 6])),
    /GX FIFO decode carry overflow: 9 > 8/,
  );
  assert.deepEqual({
    bytes: context.gxFifoBytes,
    hash: context.gxFifoHash,
    liveBytes: liveBytes(context),
    attempts: context.gxDecodeAttempts,
    blockedSkips: context.gxDecodeBlockedSkips,
    capacityWatermarkBytes: context.gxDecodeCapacityWatermarkBytes,
    capacityWatermarkGrowths: context.gxDecodeCapacityWatermarkGrowths,
    compactions: context.gxDecodeCompactions,
    preDecodeHighWaterBytes: context.gxDecodePreDecodeHighWaterBytes,
    quantizedStores: context.gxFifoQuantizedStores,
    retryAtBufferedBytes: context.gxDecodeRetryAtBufferedBytes,
    sample: context.gxFifoSample,
    stores: context.gxFifoStores,
  }, before);
});

test("staging drain preserves its pending record when decoder carry rejects it", () => {
  const context = makeContext({
    capacityWatermarkBytes: 8,
    maximumBufferedBytes: 8,
    vertexSize: 2,
  });
  append(context, Uint8Array.from([0x80, 0x00, 0x04, 1, 2, 3, 4]));
  context.bytes.set([5, 6], context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, 2, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 2, true);
  context.view.setUint32(context.gxFifoStagingMeta + 8, 1, true);

  const before = {
    buffer: liveBytes(context),
    bytes: context.gxFifoBytes,
    drains: context.gxFifoStagingDrains,
    hash: context.gxFifoHash,
    pending: stagingMetadata(context),
    stagingBytes: context.gxFifoStagingBytes,
    stagingStores: context.gxFifoStagingStores,
  };
  assert.throws(
    () => context.drainGxFifoStaging(),
    /GX FIFO decode carry overflow: 9 > 8/,
  );
  assert.deepEqual({
    buffer: liveBytes(context),
    bytes: context.gxFifoBytes,
    drains: context.gxFifoStagingDrains,
    hash: context.gxFifoHash,
    pending: stagingMetadata(context),
    stagingBytes: context.gxFifoStagingBytes,
    stagingStores: context.gxFifoStagingStores,
  }, before);
  assert.deepEqual(
    Array.from(context.bytes.subarray(context.gxFifoStagingData, context.gxFifoStagingData + 2)),
    [5, 6],
  );
});

test("FIFO optimization preserves the existing semantic drain boundaries", () => {
  const hookInvocation = source.indexOf("function invokeJitHook(");
  const hookCycleScope = source.indexOf("return withPublishedHookCycles(", hookInvocation);
  const slowHookDrain = source.indexOf("drainGxFifoStaging();", hookCycleScope);
  const slowHookTarget = source.indexOf("hookCalls.set(name", slowHookDrain);
  assert.equal(
    hookInvocation >= 0
      && hookCycleScope > hookInvocation
      && slowHookDrain > hookCycleScope
      && slowHookTarget > slowHookDrain,
    true,
  );

  const execution = source.indexOf("if (executedBlocks === 0)");
  const observedCycles = source.indexOf("const observedCycles = cycles + executedCycles;", execution);
  const executionDrain = source.indexOf("drainGxFifoStagingAtCycle(observedCycles);", observedCycles);
  const mmioService = source.indexOf("serviceMmio(observedCycles);", executionDrain);
  assert.equal(
    execution >= 0
      && observedCycles > execution
      && executionDrain > observedCycles
      && mmioService > executionDrain,
    true,
  );
});
