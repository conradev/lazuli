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
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name}`);
  const start = source.slice(functionStart - 6, functionStart) === "async "
    ? functionStart - 6
    : functionStart;
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

function rendererFrameRuntime(...additionalFunctions) {
  return [
    "appendRendererOperation",
    "enqueueRendererOperation",
    "requireTextureCopyReceiptArray",
    "requireNoTextureCopyReceipts",
    "prepareTextureCopyReceiptTransfer",
    "handleRendererFrame",
    ...additionalFunctions,
  ].map(extractFunction).join("\n\n");
}

function workerHarness({ ramBytes = 512, transferMessages = false } = {}) {
  const messages = [];
  const reports = [];
  const transfers = [];
  const reservationInvalidations = [];
  const bytes = new Uint8Array(ramBytes);
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Error,
    Map,
    Number,
    Math,
    RangeError,
    Set,
    String,
    TypeError,
    Uint8Array,
    Uint32Array,
    bytes,
    performance: { now: () => 0 },
    rendererBackpressureResume: null,
    rendererBackpressureWaits: 0,
    rendererFailure: null,
    rendererFrameFailures: 0,
    rendererFrameHighWater: 0,
    rendererFrameResultMisses: 0,
    rendererFramesAcknowledged: 0,
    rendererFramesInFlight: new Set(),
    rendererTextureCopyExpectations: new Map(),
    rendererTextureCopyBarrierSequence: null,
    rendererTextureCopyBarrierCycle: null,
    rendererTextureCopyBarriers: 0,
    rendererTextureCopyBarrierResumes: 0,
    rendererViFrames: new Map(),
    rendererResidentTextureKeys: new Set(),
    gxTextureCopyDestinations: new Map(),
    gxSkippedCopyClears: [],
    gxFanCompactionFrames: 0,
    gxFanCompactionSourceDraws: 0,
    gxFanCompactionOutputDraws: 0,
    gxFanCompactionExpandedVertices: 0,
    smbSustainedViPending: new Map(),
    rendererFrameSequence: 0,
    runnerSliceMs: 8,
    runnerStopRequested: false,
    runnerYieldDeadline: 0,
    pc: 0x80000000,
    instructions: 0,
    cycles: 0,
    dispatches: 0,
    blocks: { size: 0 },
    // Packet-layout semantics are covered by browser_boot_gx_packet.test.mjs;
    // this harness isolates acknowledgement and transfer ordering.
    gxAttachTextureCopyLayoutV1(packet) { return packet; },
    gxAttachIndirectTevStateV1(packet) { return packet; },
    gxTextureCopyReceiptExpectation(frame) {
      return frame.textureCopyExpectation ?? null;
    },
    resumeGxDecoderAfterTextureCopyReceipt() {},
    invalidateDataReservationForExternalStridedWrite(
      destination,
      rowBytes,
      stride,
      rowCount,
    ) {
      reservationInvalidations.push({ destination, rowBytes, stride, rowCount });
      return true;
    },
    ramPointer(address, size) {
      return Number.isSafeInteger(address)
        && Number.isSafeInteger(size)
        && address >= 0
        && size >= 0
        && address + size <= bytes.byteLength
        ? address
        : null;
    },
    hex32(value) { return `0x${value.toString(16).padStart(8, "0")}`; },
    finish(status, details) { reports.push({ status, details }); },
    postMessage(message, transfer = []) {
      transfers.push(transfer);
      messages.push(
        transferMessages ? structuredClone(message, { transfer }) : message,
      );
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "newWorkerPhaseTiming",
      "newWorkerHostTimings",
      "beginWorkerPhaseTiming",
      "recordWorkerPhaseTiming",
      "postRendererFrame",
      "gxStrictV7RenderKey",
      "gxStrictV7TextureSnapshotClassification",
      "gxPrepareStrictV7Frame",
      "packGxFramePacketForRenderer",
      "gxCompactNativeTriangleFans",
      "gxPackPreClearWords",
      "gxDrainSkippedCopyClears",
      "withScopedCycles",
      "armRendererTextureCopyBarrier",
      "releaseRendererTextureCopyBarrier",
      "postGxFrame",
      "recordRendererFailure",
      "gxPreflightTextureCopyReceipts",
      "gxApplyTextureCopyReceipt",
      "gxPreflightEfbPeekReceipt",
      "gxRetireRendererFrame",
      "completeRendererFrame",
      "gxCommitTextureCopyMaterialization",
      "honorRendererBackpressure",
      "finishAfterRendererDrain",
    ]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.worker.js" },
  );
  context.workerHostTimings = context.newWorkerHostTimings();
  return {
    bytes,
    context,
    messages,
    reports,
    reservationInvalidations,
    transfers,
  };
}

function textureCopyExpectation(overrides = {}) {
  const rowBytes = overrides.rowBytes ?? 4;
  const rowCount = overrides.rowCount ?? 2;
  return Object.freeze({
    kind: "output",
    layout: "gx-efb-copy-tiled-bytes-v1",
    destination: 32,
    generation: 7,
    width: 8,
    height: 4,
    copyFormat: 1,
    baseFormat: 1,
    stride: rowBytes,
    rowBytes,
    rowCount,
    byteLength: rowBytes * rowCount,
    ...overrides,
  });
}

function textureCopyReceipt(expectation, byteValues = null, overrides = {}) {
  const receipt = {
    destination: expectation.destination,
    generation: expectation.generation,
    width: expectation.width,
    height: expectation.height,
    copyFormat: expectation.copyFormat,
    baseFormat: expectation.baseFormat,
    stride: expectation.stride,
    rowBytes: expectation.rowBytes,
    rowCount: expectation.rowCount,
    layout: expectation.layout,
    bytes: Uint8Array.from(
      byteValues ?? Array.from(
        { length: expectation.byteLength },
        (_value, index) => index + 1,
      ),
    ),
  };
  return Object.assign(receipt, overrides);
}

function postTextureCopyFrame(context, expectation) {
  const packet = new ArrayBuffer(160);
  context.packGxFramePacketV6 = () => packet;
  context.postGxFrame(1, {
    index: expectation.generation,
    geometry: { drawCalls: 0, vertices: 0 },
    textureCopyExpectation: expectation,
  });
  return 1;
}

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

function gxBpCommand(value) {
  return Uint8Array.from([
    0x61,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function gxCallDisplayListCommand(address, byteLength) {
  return Uint8Array.from([
    0x40,
    (address >>> 24) & 0xff,
    (address >>> 16) & 0xff,
    (address >>> 8) & 0xff,
    address & 0xff,
    (byteLength >>> 24) & 0xff,
    (byteLength >>> 16) & 0xff,
    (byteLength >>> 8) & 0xff,
    byteLength & 0xff,
  ]);
}

function gxDecodeBarrierHarness(copyCommands) {
  const events = [];
  const barrierSequences = [];
  const bytes = new Uint8Array(4096);
  let nextRendererSequence = 0;
  const context = {
    Array,
    Map,
    Math,
    Number,
    Uint8Array,
    bytes,
    rendererTextureCopyBarrierSequence: null,
    rendererTextureCopyBarrierCycle: null,
    rendererTextureCopyBarriers: 0,
    rendererTextureCopyBarrierResumes: 0,
    gxDecodeBuffer: [],
    gxDeferredDisplayListSegments: [],
    gxTextureCopyDecoderBarrierStops: 0,
    gxTextureCopyDecoderBarrierResumes: 0,
    gxDecodeCapacityWatermarkBytes: 64,
    gxDecodeMaximumBufferedBytes: 4096,
    gxDecodeCapacityWatermarkGrowths: 0,
    gxDecodePreDecodeHighWaterBytes: 0,
    gxDecodeRetryAtBufferedBytes: 1,
    gxDecodeAttempts: 0,
    gxDecodeBlockedSkips: 0,
    gxDecodeCompactions: 0,
    gxUnknownOpcodes: 0,
    gxCpRegisters: new Uint32Array(256),
    gxCpLoads: 0,
    gxXfLoads: 0,
    gxIndexedXfLoads: 0,
    gxDisplayLists: 0,
    gxDisplayListBytes: 0,
    gxDisplayListErrors: 0,
    gxPrimitives: 0,
    gxVertices: 0,
    gxDecodedCommands: 0,
    cycles: 0,
    cpFifoState: { distance: 0 },
    workerHostTimings: { fifoDecode: {} },
    beginWorkerPhaseTiming() { return null; },
    recordWorkerPhaseTiming() {},
    gxReadU16(sourceBytes, offset) {
      return (sourceBytes[offset] << 8) | sourceBytes[offset + 1];
    },
    gxReadU32(sourceBytes, offset) {
      return (
        sourceBytes[offset] * 0x1000000
        + (sourceBytes[offset + 1] << 16)
        + (sourceBytes[offset + 2] << 8)
        + sourceBytes[offset + 3]
      ) >>> 0;
    },
    gxVertexSize() { return 0; },
    recordGxXfWrite() {},
    recordGxIndexedXfWrite() {},
    recordGxPrimitive() {},
    recordGxBpWrite(value) {
      events.push(value >>> 0);
      if (!copyCommands.has(value >>> 0)) return;
      const rendererSequence = ++nextRendererSequence;
      context.armRendererTextureCopyBarrier(rendererSequence);
      barrierSequences.push(rendererSequence);
    },
    ramPointer(address, size) {
      return Number.isSafeInteger(address)
        && Number.isSafeInteger(size)
        && address >= 0
        && size >= 0
        && address + size <= bytes.byteLength
        ? address
        : null;
    },
    serviceCommandProcessorFifo() {
      throw new Error("unexpected CP service in decoder-only harness");
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "armRendererTextureCopyBarrier",
      "releaseRendererTextureCopyBarrier",
      "decodeGxCommands",
      "gxFifoBufferedBytes",
      "gxPreflightDecodeAppend",
      "decodeGxFifo",
      "resumeGxDecoderAfterTextureCopyReceipt",
      "appendGxCommandBytes",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.decode-barrier.js" },
  );
  return { barrierSequences, bytes, context, events };
}

function installSyntheticI8TextureDecoder(context, address, mipChain) {
  const baseLevel = mipChain.levels[0];
  Object.assign(context, {
    gxBpRegisters: Uint32Array.from([
      (baseLevel.width - 1)
        | ((baseLevel.height - 1) << 10)
        | (1 << 20),
      0,
      0,
      0,
      0,
      address >>> 5,
      0,
    ]),
    gxDecodeTextureLevel(pixels, level, _format, _layout, sourceBytes) {
      pixels.fill(sourceBytes[level.encodedOffset]);
    },
    gxMarkTextureCopyConsumer() {},
    gxStrictV7TexturePreflight() { return null; },
    gxTextureCache: new Map(),
    gxTextureCacheHits: 0,
    gxTextureDecodeErrors: 0,
    gxTextureDecodedBytes: 0,
    gxTextureDecodes: 0,
    gxTextureFormatCounts: new Map(),
    gxTextureImageSource() {
      return { kind: "main-memory", address };
    },
    gxTextureLayout() {
      return {
        name: "I8",
        blockWidth: 8,
        blockHeight: 4,
        blockBytes: 32,
      };
    },
    gxTextureMipChainLayout() { return mipChain; },
    gxTexturePaletteHashComputations: 0,
    gxTexturePaletteHashMemoHits: 0,
    gxTextureRegisters() {
      return {
        image0: 0,
        mode0: 1,
        mode1: 2,
        image1: 3,
        image2: 4,
        image3: 5,
        tlut: 6,
      };
    },
    gxTextureSamplerState() { return {}; },
    gxTextureSourceHashComputations: 0,
    gxTextureSourceHashMemoHits: 0,
    gxTlutLoads: 0,
    gxTmem: new Uint8Array(1024),
  });
  vm.runInContext(extractFunction("gxDecodeTexture"), context, {
    filename: "browser_boot.renderer-sync.synthetic-texture.js",
  });
}

function rendererOperationMetrics() {
  return {
    operations: { enqueued: 0, pending: 0, highWater: 0 },
  };
}

function readyViPresentation(pairEpoch = 1, presentationSerial = 1) {
  return {
    accepted: true,
    presented: true,
    status: "vi-interlaced-frame-ready",
    pairEpoch,
    presentationSerial,
  };
}

test("packed texture-copy receipts scatter before acknowledgement and resume", () => {
  const {
    bytes,
    context,
    reservationInvalidations,
  } = workerHarness();
  bytes.fill(0xa5);
  const expectation = textureCopyExpectation({
    destination: 32,
    rowBytes: 4,
    rowCount: 3,
    stride: 4,
    byteLength: 12,
  });
  const materialized = Uint8Array.from({ length: 12 }, (_value, index) => index + 1);
  const resumeSnapshots = [];
  context.rendererBackpressureResume = () => {
    resumeSnapshots.push({
      acknowledged: context.rendererFramesAcknowledged,
      bytes: [...bytes.subarray(32, 44)],
      inFlight: context.rendererFramesInFlight.size,
      materialized: context.gxTextureCopyDestinations.get(32)?.materialized,
    });
  };
  postTextureCopyFrame(context, expectation);

  assert.equal(context.rendererFramesAcknowledged, 0);
  assert.deepEqual([...bytes.subarray(32, 44)], Array(12).fill(0xa5));
  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [textureCopyReceipt(expectation, materialized)],
  });

  assert.equal(context.rendererFailure, null);
  assert.equal(context.rendererFramesAcknowledged, 1);
  assert.deepEqual([...bytes.subarray(32, 44)], [...materialized]);
  assert.deepEqual(reservationInvalidations, [{
    destination: 32,
    rowBytes: 4,
    stride: 4,
    rowCount: 3,
  }]);
  assert.deepEqual(resumeSnapshots, [{
    acknowledged: 1,
    bytes: [...materialized],
    inFlight: 0,
    materialized: true,
  }]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.gxTextureCopyDestinations.get(32))),
    {
      ...expectation,
      format: 1,
      packedStride: 4,
      directCompatible: true,
      materialized: true,
      materializedHash: fnv1a(materialized),
    },
  );
});

test("padded texture-copy stride preserves every RAM gap", () => {
  const { bytes, context } = workerHarness();
  bytes.fill(0xcc);
  const expectation = textureCopyExpectation({
    destination: 10,
    rowBytes: 3,
    rowCount: 3,
    stride: 5,
    byteLength: 9,
  });
  postTextureCopyFrame(context, expectation);
  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [textureCopyReceipt(expectation)],
  });

  assert.deepEqual([...bytes.subarray(10, 23)], [
    1, 2, 3, 0xcc, 0xcc,
    4, 5, 6, 0xcc, 0xcc,
    7, 8, 9,
  ]);
  assert.equal(
    context.gxTextureCopyDestinations.get(10).directCompatible,
    false,
  );
  assert.equal(context.rendererFramesAcknowledged, 1);
});

test("zero and undersized texture-copy strides apply rows in hardware order", () => {
  const cases = [
    {
      name: "zero stride",
      stride: 0,
      expected: [9, 10, 11, 12],
    },
    {
      name: "undersized stride",
      stride: 2,
      expected: [1, 2, 5, 6, 9, 10, 11, 12],
    },
  ];
  for (const candidate of cases) {
    const { bytes, context } = workerHarness();
    bytes.fill(0xee);
    const expectation = textureCopyExpectation({
      destination: 20,
      rowBytes: 4,
      rowCount: 3,
      stride: candidate.stride,
      byteLength: 12,
    });
    postTextureCopyFrame(context, expectation);
    context.completeRendererFrame({
      type: "renderer-frame-complete",
      rendererSequence: 1,
      textureCopyReceipts: [textureCopyReceipt(expectation)],
    });

    assert.deepEqual(
      [...bytes.subarray(20, 20 + candidate.expected.length)],
      candidate.expected,
      candidate.name,
    );
    assert.equal(context.rendererFramesAcknowledged, 1, candidate.name);
    assert.equal(context.rendererFailure, null, candidate.name);
  }
});

test("invalid texture-copy receipts fail-stop before RAM or provenance mutation", () => {
  const standard = textureCopyExpectation();
  const valid = () => textureCopyReceipt(standard);
  const cases = [
    {
      name: "missing receipt property",
      expectation: standard,
      completion: {},
    },
    {
      name: "missing receipt",
      expectation: standard,
      completion: { textureCopyReceipts: [] },
    },
    {
      name: "extra receipt",
      expectation: null,
      completion: { textureCopyReceipts: [valid()] },
    },
    {
      name: "duplicate receipts",
      expectation: standard,
      completion: { textureCopyReceipts: [valid(), valid()] },
    },
    {
      name: "generation mismatch",
      expectation: standard,
      completion: {
        textureCopyReceipts: [textureCopyReceipt(standard, null, {
          generation: standard.generation + 1,
        })],
      },
    },
    {
      name: "layout mismatch",
      expectation: standard,
      completion: {
        textureCopyReceipts: [textureCopyReceipt(standard, null, {
          layout: "linear-rgba8",
        })],
      },
    },
    {
      name: "malformed receipt object",
      expectation: standard,
      completion: { textureCopyReceipts: [null] },
    },
    {
      name: "malformed scalar",
      expectation: standard,
      completion: {
        textureCopyReceipts: [textureCopyReceipt(standard, null, {
          width: String(standard.width),
        })],
      },
    },
    {
      name: "wrong byte type",
      expectation: standard,
      completion: {
        textureCopyReceipts: [textureCopyReceipt(standard, null, {
          bytes: new ArrayBuffer(standard.byteLength),
        })],
      },
    },
    {
      name: "non-owned byte view",
      expectation: standard,
      completion: {
        textureCopyReceipts: [textureCopyReceipt(standard, null, {
          bytes: new Uint8Array(new ArrayBuffer(standard.byteLength + 1), 1),
        })],
      },
    },
    {
      name: "wrong byte length",
      expectation: standard,
      completion: {
        textureCopyReceipts: [textureCopyReceipt(standard, null, {
          bytes: new Uint8Array(standard.byteLength - 1),
        })],
      },
    },
    {
      name: "out of RAM",
      expectation: textureCopyExpectation({
        destination: 508,
        rowBytes: 4,
        rowCount: 2,
        stride: 4,
        byteLength: 8,
      }),
      completion: null,
    },
    {
      name: "wrapping destination",
      expectation: textureCopyExpectation({
        destination: 0xffff_fffe,
        rowBytes: 4,
        rowCount: 1,
        stride: 4,
        byteLength: 4,
      }),
      completion: null,
    },
  ];

  for (const candidate of cases) {
    const {
      bytes,
      context,
      reservationInvalidations,
    } = workerHarness();
    bytes.fill(0x5a);
    const expectation = candidate.expectation;
    if (expectation === null) {
      const packet = new ArrayBuffer(160);
      context.postRendererFrame(
        "gx-frame",
        { packet, diagnostics: {}, textureCopyExpectation: null },
        [packet],
      );
    } else {
      postTextureCopyFrame(context, expectation);
    }
    const provenanceSentinel = { candidate: candidate.name };
    context.gxTextureCopyDestinations.set(4, provenanceSentinel);
    const beforeRam = Uint8Array.from(bytes);
    const beforeProvenance = [...context.gxTextureCopyDestinations];
    const completion = candidate.completion ?? {
      textureCopyReceipts: [textureCopyReceipt(expectation)],
    };

    context.completeRendererFrame({
      type: "renderer-frame-complete",
      rendererSequence: 1,
      ...completion,
    });

    assert.deepEqual([...bytes], [...beforeRam], candidate.name);
    assert.deepEqual(
      [...context.gxTextureCopyDestinations],
      beforeProvenance,
      candidate.name,
    );
    assert.deepEqual(reservationInvalidations, [], candidate.name);
    assert.equal(context.rendererFramesAcknowledged, 0, candidate.name);
    assert.equal(context.rendererFrameFailures, 1, candidate.name);
    assert.equal(context.rendererFramesInFlight.size, 0, candidate.name);
    assert.notEqual(context.rendererFailure, null, candidate.name);
  }
});

test("duplicate renderer completion cannot rewrite acknowledged texture-copy RAM", () => {
  const { bytes, context } = workerHarness();
  const expectation = textureCopyExpectation();
  postTextureCopyFrame(context, expectation);
  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [textureCopyReceipt(expectation)],
  });
  const beforeRam = Uint8Array.from(bytes);
  const beforeProvenance = [...context.gxTextureCopyDestinations];

  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [textureCopyReceipt(expectation, Array(8).fill(0xff))],
  });

  assert.deepEqual([...bytes], [...beforeRam]);
  assert.deepEqual([...context.gxTextureCopyDestinations], beforeProvenance);
  assert.equal(context.rendererFramesAcknowledged, 1);
  assert.equal(context.rendererFrameResultMisses, 1);
  assert.equal(context.rendererFrameFailures, 1);
  assert.match(context.rendererFailure, /unknown or duplicate frame result/);
});

test("GX copy issue and receipt application both invalidate strided reservations", () => {
  const issueContext = {
    Math,
    Number,
    dataReservationGranuleBytes: 32,
    dataReservationPhysicalGranule: 64,
  };
  vm.createContext(issueContext);
  vm.runInContext(
    [
      "invalidateDataReservationForExternalWrite",
      "invalidateDataReservationForExternalStridedWrite",
      "gxTextureLayout",
      "gxCopyTextureLayout",
      "invalidateGxCopyReservation",
    ].map(extractFunction).join("\n\n"),
    issueContext,
    { filename: "browser_boot.renderer-sync.copy-reservation.js" },
  );
  const frame = {
    copyToXfb: false,
    destination: 64,
    sourceX: 0,
    sourceY: 0,
    width: 8,
    sourceHeight: 4,
    stride: 32,
    copyState: { copyCommand: 0x10, pixelControl: 0 },
  };

  assert.equal(issueContext.invalidateGxCopyReservation(frame), true);
  assert.equal(issueContext.dataReservationPhysicalGranule, null);
  issueContext.dataReservationPhysicalGranule = 256;
  assert.equal(issueContext.invalidateGxCopyReservation(frame), false);
  assert.equal(issueContext.dataReservationPhysicalGranule, 256);

  const { context, reservationInvalidations } = workerHarness();
  const expectation = textureCopyExpectation({
    destination: 64,
    rowBytes: 32,
    rowCount: 1,
    stride: 32,
    byteLength: 32,
  });
  postTextureCopyFrame(context, expectation);
  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [textureCopyReceipt(expectation)],
  });
  assert.deepEqual(reservationInvalidations, [{
    destination: 64,
    rowBytes: 32,
    stride: 32,
    rowCount: 1,
  }]);

  const issueCall = source.indexOf("invalidateGxCopyReservation(frame);");
  const generationRecord = source.indexOf(
    "gxRecordTextureCopyGeneration(",
    issueCall,
  );
  assert.ok(issueCall >= 0 && generationRecord > issueCall);
});

test("materialized hash selects the direct surface until CPU RAM mutation", () => {
  const { bytes, context } = workerHarness();
  const expectation = textureCopyExpectation({
    destination: 32,
    generation: 19,
    width: 8,
    height: 4,
    copyFormat: 1,
    baseFormat: 1,
    rowBytes: 32,
    rowCount: 1,
    stride: 32,
    byteLength: 32,
  });
  const materialized = Uint8Array.from(
    { length: 32 },
    (_value, index) => (index * 13 + 5) & 0xff,
  );
  postTextureCopyFrame(context, expectation);
  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [textureCopyReceipt(expectation, materialized)],
  });

  Object.assign(context, {
    gxBpRegisters: Uint32Array.from([
      7 | (3 << 10) | (1 << 20),
      0,
      0,
      0,
      0,
      1,
      0,
    ]),
    gxDecodeTextureLevel(pixels, level, _format, _layout, sourceBytes) {
      pixels.fill(sourceBytes[level.encodedOffset]);
    },
    gxMarkTextureCopyConsumer() {},
    gxStrictV7TexturePreflight() { return null; },
    gxTextureCache: new Map(),
    gxTextureCacheHits: 0,
    gxTextureDecodeErrors: 0,
    gxTextureDecodedBytes: 0,
    gxTextureDecodes: 0,
    gxTextureFormatCounts: new Map(),
    gxTextureImageSource() {
      return { kind: "main-memory", address: 32 };
    },
    gxTextureLayout() {
      return {
        name: "I8",
        blockWidth: 8,
        blockHeight: 4,
        blockBytes: 32,
      };
    },
    gxTextureLowerMipCopyGeneration() { return null; },
    gxTextureMipChainLayout() {
      return {
        levelCount: 1,
        encodedBytes: 32,
        decodedBytes: 128,
        levels: [{
          width: 8,
          height: 4,
          blocksWide: 1,
          blocksHigh: 1,
          encodedOffset: 0,
          encodedBytes: 32,
          decodedOffset: 0,
          decodedBytes: 128,
        }],
      };
    },
    gxTexturePaletteHashComputations: 0,
    gxTexturePaletteHashMemoHits: 0,
    gxTextureRegisters() {
      return {
        image0: 0,
        mode0: 1,
        mode1: 2,
        image1: 3,
        image2: 4,
        image3: 5,
        tlut: 6,
      };
    },
    gxTextureSamplerState() { return {}; },
    gxTextureSourceHashComputations: 0,
    gxTextureSourceHashMemoHits: 0,
    gxTlutLoads: 0,
    gxTmem: new Uint8Array(1024),
  });
  vm.runInContext(extractFunction("gxDecodeTexture"), context, {
    filename: "browser_boot.renderer-sync.direct-provenance.js",
  });

  const direct = context.gxDecodeTexture(0);
  assert.equal(direct.textureCopyIndex, 19);
  assert.match(direct.key, /:19$/);
  assert.equal(
    context.gxTextureCopyDestinations.get(32).materializedHash,
    fnv1a(materialized),
  );

  const oneLevelMipLayout = context.gxTextureMipChainLayout;
  bytes.fill(0x9a, 64, 96);
  context.gxTextureMipChainLayout = () => ({
    levelCount: 2,
    encodedBytes: 64,
    decodedBytes: 160,
    levels: [
      {
        width: 8,
        height: 4,
        blocksWide: 1,
        blocksHigh: 1,
        encodedOffset: 0,
        encodedBytes: 32,
        decodedOffset: 0,
        decodedBytes: 128,
      },
      {
        width: 4,
        height: 2,
        blocksWide: 1,
        blocksHigh: 1,
        encodedOffset: 32,
        encodedBytes: 32,
        decodedOffset: 128,
        decodedBytes: 32,
      },
    ],
  });
  const mipChain = context.gxDecodeTexture(0);
  assert.equal(mipChain.levelCount, 2);
  assert.equal(mipChain.textureCopyIndex, undefined);
  assert.match(mipChain.key, /:ram$/);
  assert.equal(mipChain.mipLevels[0].pixels[0], materialized[0]);
  assert.equal(mipChain.mipLevels[1].pixels[0], 0x9a);
  assert.equal(context.gxTextureCopyDestinations.has(32), true);

  context.gxTextureMipChainLayout = oneLevelMipLayout;

  bytes[32] ^= 0xff;
  const ramFallback = context.gxDecodeTexture(0);
  assert.equal(ramFallback.textureCopyIndex, undefined);
  assert.match(ramFallback.key, /:ram$/);
  assert.equal(context.gxTextureCopyDestinations.has(32), false);
  assert.equal(context.gxTextureDecodeErrors, 0);
});

test("lower-mip receipt commits before the deferred full-chain RAM decode", () => {
  const { bytes, context } = workerHarness();
  bytes.fill(0x31, 32, 64);
  const mipChainLayout = {
    levelCount: 2,
    encodedBytes: 64,
    decodedBytes: 160,
    levels: [
      {
        width: 8,
        height: 4,
        blocksWide: 1,
        blocksHigh: 1,
        encodedOffset: 0,
        encodedBytes: 32,
        decodedOffset: 0,
        decodedBytes: 128,
      },
      {
        width: 4,
        height: 2,
        blocksWide: 1,
        blocksHigh: 1,
        encodedOffset: 32,
        encodedBytes: 32,
        decodedOffset: 128,
        decodedBytes: 32,
      },
    ],
  };
  installSyntheticI8TextureDecoder(context, 32, mipChainLayout);
  let resumedTexture = null;
  context.resumeGxDecoderAfterTextureCopyReceipt = () => {
    resumedTexture = context.gxDecodeTexture(0);
  };
  const expectation = textureCopyExpectation({
    destination: 64,
    generation: 23,
    width: 4,
    height: 2,
    rowBytes: 32,
    rowCount: 1,
    stride: 32,
    byteLength: 32,
  });
  postTextureCopyFrame(context, expectation);

  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [
      textureCopyReceipt(expectation, Array(32).fill(0x9a)),
    ],
  });

  assert.notEqual(resumedTexture, null);
  assert.equal(resumedTexture.levelCount, 2);
  assert.equal(resumedTexture.textureCopyIndex, undefined);
  assert.match(resumedTexture.key, /:ram$/);
  assert.equal(resumedTexture.mipLevels[0].pixels[0], 0x31);
  assert.equal(resumedTexture.mipLevels[1].pixels[0], 0x9a);
  assert.equal(
    resumedTexture.hash,
    "0x" + fnv1a(bytes.subarray(32, 96)).toString(16).padStart(8, "0"),
  );
  assert.equal(context.rendererTextureCopyBarrierSequence, null);
  assert.equal(context.rendererFramesAcknowledged, 1);
});

test("top-level GX suffix remains carried until its texture-copy receipt", () => {
  const copy = 0x5200_0001;
  const suffix = 0xf000_0011;
  const { barrierSequences, context, events } = gxDecodeBarrierHarness(
    new Set([copy]),
  );
  const stream = Uint8Array.from([
    ...gxBpCommand(copy),
    ...gxBpCommand(suffix),
  ]);

  context.appendGxCommandBytes(stream);
  assert.deepEqual(events, [copy]);
  assert.deepEqual(barrierSequences, [1]);
  assert.equal(context.rendererTextureCopyBarrierSequence, 1);
  assert.deepEqual(context.gxDecodeBuffer, [...gxBpCommand(suffix)]);
  assert.equal(context.gxTextureCopyDecoderBarrierStops, 1);

  context.releaseRendererTextureCopyBarrier(1);
  assert.deepEqual(context.gxDecodeBuffer, [...gxBpCommand(suffix)]);
  context.resumeGxDecoderAfterTextureCopyReceipt();

  assert.deepEqual(events, [copy, suffix]);
  assert.deepEqual(context.gxDecodeBuffer, []);
  assert.equal(context.rendererTextureCopyBarrierSequence, null);
  assert.equal(context.gxTextureCopyDecoderBarrierResumes, 1);
});

test("CALL_DL continuation resumes before its enclosing FIFO suffix", () => {
  const copy = 0x5200_0002;
  const displayListSuffix = 0xf100_0021;
  const fifoSuffix = 0xf200_0022;
  const displayListAddress = 0x100;
  const { bytes, context, events } = gxDecodeBarrierHarness(new Set([copy]));
  const displayList = Uint8Array.from([
    ...gxBpCommand(copy),
    ...gxBpCommand(displayListSuffix),
  ]);
  bytes.set(displayList, displayListAddress);
  const fifo = Uint8Array.from([
    ...gxCallDisplayListCommand(displayListAddress, displayList.byteLength),
    ...gxBpCommand(fifoSuffix),
  ]);

  context.appendGxCommandBytes(fifo);
  assert.deepEqual(events, [copy]);
  assert.equal(context.gxDeferredDisplayListSegments.length, 1);
  assert.equal(
    context.gxDeferredDisplayListSegments[0].inDisplayList,
    true,
  );
  assert.deepEqual(
    [...context.gxDeferredDisplayListSegments[0].bytes],
    [...gxBpCommand(displayListSuffix)],
  );
  assert.deepEqual(context.gxDecodeBuffer, [...gxBpCommand(fifoSuffix)]);

  bytes.fill(0, displayListAddress, displayListAddress + displayList.byteLength);
  context.releaseRendererTextureCopyBarrier(1);
  context.resumeGxDecoderAfterTextureCopyReceipt();

  assert.deepEqual(events, [copy, displayListSuffix, fifoSuffix]);
  assert.deepEqual(context.gxDeferredDisplayListSegments, []);
  assert.deepEqual(context.gxDecodeBuffer, []);
  assert.equal(context.gxDisplayListErrors, 0);
});

test("a second deferred texture copy re-arms and pauses both continuations", () => {
  const firstCopy = 0x5200_0003;
  const secondCopy = 0x5200_0004;
  const displayListSuffix = 0xf300_0031;
  const fifoSuffix = 0xf400_0032;
  const displayListAddress = 0x180;
  const { barrierSequences, bytes, context, events } = gxDecodeBarrierHarness(
    new Set([firstCopy, secondCopy]),
  );
  const displayList = Uint8Array.from([
    ...gxBpCommand(firstCopy),
    ...gxBpCommand(secondCopy),
    ...gxBpCommand(displayListSuffix),
  ]);
  bytes.set(displayList, displayListAddress);
  context.appendGxCommandBytes(Uint8Array.from([
    ...gxCallDisplayListCommand(displayListAddress, displayList.byteLength),
    ...gxBpCommand(fifoSuffix),
  ]));

  context.releaseRendererTextureCopyBarrier(1);
  context.resumeGxDecoderAfterTextureCopyReceipt();
  assert.deepEqual(events, [firstCopy, secondCopy]);
  assert.deepEqual(barrierSequences, [1, 2]);
  assert.equal(context.rendererTextureCopyBarrierSequence, 2);
  assert.deepEqual(
    [...context.gxDeferredDisplayListSegments[0].bytes],
    [...gxBpCommand(displayListSuffix)],
  );
  assert.deepEqual(context.gxDecodeBuffer, [...gxBpCommand(fifoSuffix)]);

  context.releaseRendererTextureCopyBarrier(2);
  context.resumeGxDecoderAfterTextureCopyReceipt();
  assert.deepEqual(
    events,
    [firstCopy, secondCopy, displayListSuffix, fifoSuffix],
  );
  assert.deepEqual(context.gxDeferredDisplayListSegments, []);
  assert.deepEqual(context.gxDecodeBuffer, []);
  assert.equal(context.rendererTextureCopyBarriers, 2);
  assert.equal(context.rendererTextureCopyBarrierResumes, 2);
});

test("CP service leaves every FIFO pointer untouched behind the copy barrier", () => {
  const context = {
    Math,
    commandProcessorServiceBudgetBytes: 256 * 1024,
    commandProcessorServiceCalls: 0,
    rendererTextureCopyBarrierSequence: 9,
    cpFifoState: {
      control: 1,
      base: 0x100,
      end: 0x1e0,
      distance: 0x80,
      writePointer: 0x180,
      readPointer: 0x120,
      breakpoint: 0,
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("serviceCommandProcessorFifo"), context, {
    filename: "browser_boot.renderer-sync.blocked-cp.js",
  });
  const before = JSON.parse(JSON.stringify(context.cpFifoState));

  assert.equal(context.serviceCommandProcessorFifo(), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(context.cpFifoState)), before);
  assert.equal(context.commandProcessorServiceCalls, 1);
});

test("PI FIFO reset discards decoder state but preserves the issued receipt barrier", () => {
  const { bytes, context } = workerHarness();
  const expectation = textureCopyExpectation();
  postTextureCopyFrame(context, expectation);
  Object.assign(context, {
    cpControlLinkEnable: 0x10,
    cpFifoAddressMask: 0x03ff_ffe0,
    cpFifoState: {
      control: 3,
      base: 0x100,
      end: 0x1e0,
      highWatermark: 0x80,
      lowWatermark: 0x20,
      distance: 0x40,
      writePointer: 0x180,
      readPointer: 0x140,
      breakpoint: 0,
    },
    piFifoState: { base: 0x100, end: 0x1e0, current: 0x180, wrap: false },
    gxWriteGatherPendingBytes: 11,
    gxWriteGatherDiscardedBytes: 0,
    gxWriteGatherResets: 0,
    gxDecodeBuffer: [1, 2, 3, 4],
    gxDeferredDisplayListSegments: [
      { bytes: new Uint8Array([5, 6]), inDisplayList: true },
      { bytes: new Uint8Array([7, 8, 9]), inDisplayList: true },
    ],
    gxDecodeRetryAtBufferedBytes: 13,
    commandProcessorDecoderDiscardedBytes: 0,
    commandProcessorDecoderResets: 0,
    resetCommandProcessorInterruptState() {},
  });
  const resumeSnapshots = [];
  context.resumeGxDecoderAfterTextureCopyReceipt = () => {
    resumeSnapshots.push({
      carry: [...context.gxDecodeBuffer],
      deferred: context.gxDeferredDisplayListSegments.length,
      barrier: context.rendererTextureCopyBarrierSequence,
    });
  };
  vm.runInContext(
    [
      "resetGxWriteGatherPipe",
      "resetGxCommandProcessorDecoder",
      "resetCommandProcessorFifoFromPi",
      "writeProcessorInterfaceFifoRegister",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.renderer-sync.decoder-reset.js" },
  );

  assert.equal(
    context.writeProcessorInterfaceFifoRegister(0x0c00_3018, 1, 4),
    true,
  );
  assert.deepEqual(context.gxDecodeBuffer, []);
  assert.deepEqual(context.gxDeferredDisplayListSegments, []);
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 1);
  assert.equal(context.commandProcessorDecoderDiscardedBytes, 9);
  assert.equal(context.commandProcessorDecoderResets, 1);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.gxWriteGatherDiscardedBytes, 11);
  assert.equal(context.gxWriteGatherResets, 1);
  assert.equal(context.cpFifoState.control, 0x10);
  assert.equal(context.cpFifoState.highWatermark, 0x03ff_ffe0);
  assert.equal(context.cpFifoState.lowWatermark, 0);
  assert.equal(context.rendererTextureCopyBarrierSequence, 1);
  assert.strictEqual(context.rendererTextureCopyExpectations.get(1), expectation);
  assert.equal(context.rendererFramesInFlight.has(1), true);

  context.completeRendererFrame({
    type: "renderer-frame-complete",
    rendererSequence: 1,
    textureCopyReceipts: [textureCopyReceipt(expectation)],
  });
  assert.deepEqual([...bytes.subarray(32, 40)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(context.rendererTextureCopyBarrierSequence, null);
  assert.equal(context.rendererFramesAcknowledged, 1);
  assert.deepEqual(resumeSnapshots, [{ carry: [], deferred: 0, barrier: null }]);
});

test("renderEvery gates VI host sampling but never GX or XFB execution", () => {
  let nextPairEpoch = 0;
  const context = {
    Array,
    Number,
    runnerRenderEvery: 3,
    viHostPresentationCount: 0,
    viPresentationPairCount: 0,
    viPresentationGatedPairs: 0,
    viPendingFieldPair: null,
    check(condition, message) {
      if (!condition) throw new Error(message);
    },
    allocateViPairEpoch() { return ++nextPairEpoch; },
    cloneViScanoutEntry(entry) { return entry; },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("claimViFieldPair"), context, {
    filename: "browser_boot.renderer-sync.render-every.js",
  });
  const dimensions = {
    width: 640,
    height: 448,
    fieldStrideBytes: 1280,
    sourceRowStep: 1,
    fieldHeight: 448,
    rowRepeat: 1,
    scanoutPolicy: "progressive",
  };
  const scanoutState = { topBase: null, bottomBase: null, picture: null };
  const decisions = Array.from(
    { length: 6 },
    (_unused, index) => {
      const submitToHost = context.claimViFieldPair(
        "top",
        dimensions,
        null,
        1,
        0x1000,
        scanoutState,
      ).submitToHost;
      if (index < 4) context.viHostPresentationCount += 1;
      return submitToHost;
    },
  );

  assert.deepEqual(decisions, [true, true, true, true, false, true]);
  assert.equal(context.viPresentationPairCount, 6);
  assert.equal(context.viPresentationGatedPairs, 1);

  const copyExecution = extractFunction("recordGxBpWrite");
  assert.doesNotMatch(copyExecution, /runnerRenderEvery/);
  assert.doesNotMatch(copyExecution, /gxCollectFrameGeometry/);
  assert.doesNotMatch(copyExecution, /gxShouldCollectNextXfb/);
  assert.match(copyExecution, /postGxFrame\(2, frame\)/);
  assert.match(copyExecution, /postGxFrame\(1, frame\)/);
  assert.equal(
    [...source.matchAll(/\bgxCollectFrameGeometry\b/g)].length,
    0,
  );
  assert.doesNotMatch(source, /(?:const|let) gxCollectFrameGeometry/);
});

test("renderEvery bootstrap remains open until a host frame presents", () => {
  let nextPairEpoch = 0;
  const context = {
    Array,
    Number,
    runnerRenderEvery: 600,
    viHostPresentationCount: 0,
    viPresentationPairCount: 0,
    viPresentationGatedPairs: 0,
    viPendingFieldPair: null,
    check(condition, message) {
      if (!condition) throw new Error(message);
    },
    allocateViPairEpoch() { return ++nextPairEpoch; },
    cloneViScanoutEntry(entry) { return entry; },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("claimViFieldPair"), context, {
    filename: "browser_boot.renderer-sync.render-bootstrap.js",
  });
  const dimensions = {
    width: 640,
    height: 448,
    fieldStrideBytes: 1280,
    sourceRowStep: 1,
    fieldHeight: 448,
    rowRepeat: 1,
    scanoutPolicy: "progressive",
  };
  const scanoutState = { topBase: null, bottomBase: null, picture: null };
  const claim = () => context.claimViFieldPair(
    "top",
    dimensions,
    null,
    1,
    0x1000,
    scanoutState,
  ).submitToHost;

  assert.deepEqual(Array.from({ length: 5 }, claim), [true, true, true, true, true]);
  assert.equal(context.viPresentationPairCount, 5);
  assert.equal(context.viPresentationGatedPairs, 0);

  context.viHostPresentationCount = 4;
  assert.equal(claim(), false);
  assert.equal(context.viPresentationPairCount, 6);
  assert.equal(context.viPresentationGatedPairs, 1);
});

test("JIT FIFO staging forces an immediate renderer-fenced dispatch boundary", () => {
  const memory = new ArrayBuffer(32);
  const view = new DataView(memory);
  const calls = [];
  const context = {
    view,
    regionRunning: true,
    regionControl: 0,
    regionExitRequestOffset: 4,
    withPublishedHookCycles(callback) { return callback(); },
    drainGxFifoStaging() {
      calls.push("drain-staging");
      return "drained";
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("drainGxFifoStagingForJit"), context, {
    filename: "browser_boot.renderer-sync.staging-boundary.js",
  });

  assert.equal(context.drainGxFifoStagingForJit(), "drained");
  assert.deepEqual(calls, ["drain-staging"]);
  assert.equal(view.getUint32(4, true), 1);

  const dispatchStart = source.indexOf(
    "const observedCycles = cycles + executedCycles;",
  );
  const stagingDrain = source.indexOf(
    "drainGxFifoStagingAtCycle(observedCycles);",
    dispatchStart,
  );
  const immediateFence = source.indexOf(
    "await honorRendererBackpressure();",
    stagingDrain,
  );
  const diskService = source.indexOf(
    "const diskWait = dueDiskTransferPromise(observedCycles);",
    immediateFence,
  );
  const mmioService = source.indexOf(
    "serviceMmio(observedCycles);",
    diskService,
  );
  const pcCommit = source.indexOf(
    "instructions += executedInstructions;",
    mmioService,
  );
  assert.ok(
    dispatchStart >= 0
      && dispatchStart < stagingDrain
      && stagingDrain < immediateFence
      && immediateFence < diskService
      && diskService < mmioService
      && mmioService < pcCommit,
  );
  assert.match(
    source.slice(stagingDrain, diskService),
    /if \(rendererFramesInFlight\.size !== 0 \|\| rendererFailure !== null\) \{\s*await honorRendererBackpressure\(\);\s*\}/,
  );
});

test("main drain transfers uniquely owned texture-copy buffers to the worker", async () => {
  const expectation = textureCopyExpectation();
  const rendererBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const rendererReceipt = textureCopyReceipt(expectation, rendererBytes, {
    rendererPrivateField: "must not cross",
  });
  const publications = [];
  let healthChecks = 0;
  const currentWorker = {
    postMessage(message, transfer = []) {
      const transferByteLengths = transfer.map(buffer => buffer.byteLength);
      publications.push({
        message: structuredClone(message, { transfer }),
        transfer,
        transferByteLengths,
      });
    },
  };
  const context = {
    Array,
    ArrayBuffer,
    Number,
    Promise,
    Uint8Array,
    handleRendererError(error) { throw error; },
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    webGpuRenderer: {
      check_health() { healthChecks += 1; },
      drain() { return Promise.resolve([rendererReceipt]); },
    },
    worker: currentWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    rendererFrameRuntime("drainWebGpuRenderer"),
    context,
    { filename: "browser_boot.renderer-sync.receipt-transfer.js" },
  );

  await context.handleRendererFrame(
    { type: "gx-frame", rendererSequence: 41 },
    () => ({ residentTextureKeys: ["resident"] }),
  );

  assert.equal(healthChecks, 1);
  assert.equal(publications.length, 1);
  assert.deepEqual([...publications[0].transferByteLengths], [8]);
  assert.equal(publications[0].transfer[0].byteLength, 0);
  assert.equal(rendererReceipt.bytes.byteLength, 0);
  assert.deepEqual(
    [...publications[0].message.textureCopyReceipts[0].bytes],
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(
    publications[0].message.textureCopyReceipts[0].rendererPrivateField,
    undefined,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify({
      ...publications[0].message,
      textureCopyReceipts: publications[0].message.textureCopyReceipts.map(
        ({ bytes: _bytes, ...receipt }) => receipt,
      ),
    })),
    {
      type: "renderer-frame-complete",
      rendererSequence: 41,
      textureCopyReceipts: [{
        destination: expectation.destination,
        generation: expectation.generation,
        width: expectation.width,
        height: expectation.height,
        copyFormat: expectation.copyFormat,
        baseFormat: expectation.baseFormat,
        stride: expectation.stride,
        rowBytes: expectation.rowBytes,
        rowCount: expectation.rowCount,
        layout: expectation.layout,
      }],
      residentTextureKeys: ["resident"],
    },
  );
});

test("main rejects aliased receipt buffers and sends empty arrays for XFB and VI", async () => {
  const sharedBytes = new Uint8Array(8);
  const expectation = textureCopyExpectation();
  const first = textureCopyReceipt(expectation, null, { bytes: sharedBytes });
  const second = textureCopyReceipt(expectation, null, { bytes: sharedBytes });
  const publications = [];
  const currentWorker = {
    postMessage(message, transfer = []) {
      publications.push({ message, transfer });
    },
  };
  const context = {
    Array,
    ArrayBuffer,
    Number,
    Promise,
    Uint8Array,
    handleRendererError(error) { throw error; },
    rendererHostMetrics: rendererOperationMetrics(),
    rendererOperationTail: Promise.resolve(),
    webGpuRenderer: {
      check_health() {},
      drain() { return Promise.resolve([]); },
    },
    worker: currentWorker,
  };
  vm.createContext(context);
  vm.runInContext(
    rendererFrameRuntime("drainWebGpuRenderer"),
    context,
    { filename: "browser_boot.renderer-sync.empty-receipts.js" },
  );

  assert.throws(
    () => context.prepareTextureCopyReceiptTransfer([first, second]),
    /does not own one unique Uint8Array buffer/,
  );
  await context.handleRendererFrame(
    { type: "gx-frame", rendererSequence: 51, diagnostics: { copyKind: 2 } },
    () => ({ residentTextureKeys: [] }),
  );
  await context.handleRendererFrame(
    { type: "vi-present", rendererSequence: 52, frame: {} },
    () => readyViPresentation(3, 9),
  );

  assert.equal(publications.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      publications.map(publication => publication.message.textureCopyReceipts),
    )),
    [[], []],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      publications.map(publication => publication.transfer),
    )),
    [[], []],
  );
  assert.equal(publications[0].message.rendererSequence, 51);
  assert.equal(publications[1].message.rendererSequence, 52);
  assert.deepEqual(
    JSON.parse(JSON.stringify(publications[1].message.viPresentationResult)),
    readyViPresentation(3, 9),
  );
});
