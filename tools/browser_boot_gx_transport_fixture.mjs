// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
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
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
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
    if (["'", '"', "`"].includes(character)) {
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

const decoderFunctions = [
  "gxReadU32",
  "gxReadU16",
  "decodeGxCommands",
  "gxFifoBufferedBytes",
  "gxPreflightDecodeAppend",
  "decodeGxFifo",
  "appendGxCommandBytes",
];

const transportFunctions = [
  "commandProcessorBreakpointLevel",
  "commandProcessorFifoSpanBytes",
  "normalizeCommandProcessorFifoDistance",
  "validatedCommandProcessorFifoSpan",
  "advanceCommandProcessorFifoPointer",
  "commandProcessorDistanceToBreakpoint",
  "serviceCommandProcessorFifo",
  "validateProcessorInterfaceFifoWriteState",
  "validateGxWriteGatherBurstState",
  "preflightGxWriteGatherAppend",
  "commitGxWriteGatherBurst",
  "appendGxWriteGatherBytes",
  "resetGxWriteGatherPipe",
  "resetGxCommandProcessorDecoder",
  "appendGxFifoBytes",
  "drainGxFifoStaging",
  "resetCommandProcessorFifoFromPi",
  "commandProcessorPairValue",
  "writeCommandProcessorPairValue",
  "writeCommandProcessorRegister",
  "writeProcessorInterfaceFifoRegister",
];

export function makeContext({
  ramSize = 0x4000,
  realDecoder = false,
  stagingCapacity = 64,
} = {}) {
  const memory = new ArrayBuffer(ramSize + stagingCapacity + 0x40);
  const decodedChunks = [];
  const semanticEvents = [];
  const context = {
    appendGxCommandBytes(chunk) {
      decodedChunks.push(Array.from(chunk));
    },
    beginWorkerPhaseTiming() { return null; },
    bytes: new Uint8Array(memory),
    commandProcessorBreakpointStops: 0,
    commandProcessorDecoderDiscardedBytes: 0,
    commandProcessorDecoderResets: 0,
    commandProcessorDistanceNormalizations: 0,
    commandProcessorLastDistanceNormalization: null,
    commandProcessorMaximumDistance: 0,
    commandProcessorMaximumRawDistance: 0,
    commandProcessorReadBursts: 0,
    commandProcessorReadBytes: 0,
    commandProcessorReadDisabledStops: 0,
    commandProcessorReadWraps: 0,
    commandProcessorServiceBudgetBytes: 256 * 1024,
    commandProcessorServiceCalls: 0,
    cpControlBreakpointEnable: 0x0002,
    cpControlLinkEnable: 0x0010,
    cpControlMask: 0x003f,
    cpControlReadEnable: 0x0001,
    cpFifoAddressMask: 0x03ffffe0,
    cpFifoHighWordMask: 0x03ff,
    cpFifoLowWordMask: 0xffe0,
    cpFifoState: {
      control: 0,
      base: 0,
      end: 0,
      highWatermark: 0,
      lowWatermark: 0,
      distance: 0,
      writePointer: 0,
      readPointer: 0,
      breakpoint: 0,
    },
    gxBpLoads: 0,
    gxCpLoads: 0,
    gxCpRegisters: new Uint32Array(256),
    gxDecodeAttempts: 0,
    gxDecodeBlockedSkips: 0,
    gxDecodeBuffer: [],
    gxDecodeCapacityWatermarkBytes: 16,
    gxDecodeCapacityWatermarkGrowths: 0,
    gxDecodeCompactions: 0,
    gxDecodeMaximumBufferedBytes: 16 * 1024 * 1024,
    gxDecodePreDecodeHighWaterBytes: 0,
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
    gxFifoStagingCapacity: stagingCapacity,
    gxFifoStagingData: ramSize + 16,
    gxFifoStagingDrains: 0,
    gxFifoStagingMeta: ramSize,
    gxFifoStagingQuantizedStores: 0,
    gxFifoStagingStores: 0,
    gxFifoStores: 0,
    gxIndexedXfLoads: 0,
    gxPreflightCalls: 0,
    gxPrimitives: 0,
    gxUnknownOpcodes: 0,
    gxVertices: 0,
    gxXfLoads: 0,
    gxWriteGatherBuffer: new Uint8Array(32),
    gxWriteGatherBurstBytes: 32,
    gxWriteGatherBursts: 0,
    gxWriteGatherBytesCommitted: 0,
    gxWriteGatherDiscardedBytes: 0,
    gxWriteGatherHighWaterBytes: 0,
    gxWriteGatherLastDestination: null,
    gxWriteGatherLinkedBursts: 0,
    gxWriteGatherPendingBytes: 0,
    gxWriteGatherResets: 0,
    gxWriteGatherUnlinkedBursts: 0,
    gxWriteGatherWraps: 0,
    hex32: value => "0x" + (value >>> 0).toString(16).padStart(8, "0"),
    gxPreflightDecodeAppend() { context.gxPreflightCalls += 1; },
    physicalRamPointer(address, size) {
      return address >= 0 && address + size <= ramSize ? address : null;
    },
    piFifoEndMask: 0x07ffffe0,
    piFifoRedirectEnd: 0x04000000,
    piFifoState: { base: 0, end: 0, current: 0, wrap: false },
    piFifoWrap: 0x20000000,
    recordWorkerPhaseTiming() {},
    ramPointer(address, size) {
      return context.physicalRamPointer(address, size);
    },
    recordGxBpWrite(word) {
      context.gxBpLoads += 1;
      semanticEvents.push(["bp", word >>> 0]);
    },
    recordGxIndexedXfWrite(opcode, word) {
      semanticEvents.push(["indexed-xf", opcode, word >>> 0]);
    },
    recordGxPrimitive(opcode, sourceBytes, offset, vertices, vertexSize) {
      semanticEvents.push([
        "primitive",
        opcode,
        vertices,
        vertexSize,
        Array.from(sourceBytes.slice(offset, offset + vertices * vertexSize)),
      ]);
    },
    recordGxXfWrite(address, word) {
      semanticEvents.push(["xf", address, word >>> 0]);
    },
    view: new DataView(memory),
    workerHostTimings: { fifoDecode: {}, fifoStagingDrainInclusive: {} },
    gxVertexSize() { return 2; },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      ...(realDecoder ? decoderFunctions : []),
      ...transportFunctions,
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx_transport.js" },
  );
  context.decodedChunks = decodedChunks;
  context.semanticEvents = semanticEvents;
  return context;
}

export function stageAndDrain(context, values, stores = 1, quantizedStores = 0) {
  context.bytes.set(values, context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, values.length, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, stores, true);
  context.view.setUint32(context.gxFifoStagingMeta + 8, quantizedStores, true);
  context.drainGxFifoStaging();
}

export function configurePi(context, { base = 0x100, end = 0x160, current = base } = {}) {
  Object.assign(context.piFifoState, { base, end, current, wrap: false });
}

export function configureCp(context, {
  base = 0x100,
  end = 0x160,
  pointer = base,
  distance = 0,
  control = 0,
} = {}) {
  Object.assign(context.cpFifoState, {
    base,
    end,
    writePointer: pointer,
    readPointer: pointer,
    distance,
    control,
    breakpoint: 0,
  });
}

export function writeCpPair(context, lowOffset, value) {
  assert.equal(
    context.writeCommandProcessorRegister(
      0x0c000000 + lowOffset,
      value & 0xffff,
      2,
    ),
    true,
  );
  assert.equal(
    context.writeCommandProcessorRegister(
      0x0c000002 + lowOffset,
      value >>> 16,
      2,
    ),
    true,
  );
}

export function append(context, values, stores = 1, quantizedStores = 0) {
  context.appendGxFifoBytes(Uint8Array.from(values), stores, quantizedStores);
}

export function be32(value) {
  return [value >>> 24, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff];
}

