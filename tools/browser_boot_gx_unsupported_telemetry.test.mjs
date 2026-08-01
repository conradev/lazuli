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
  assert.fail(`unterminated ${name}`);
}

const telemetryFunctions = [
  "gxSaturatingUnsupportedIncrement",
  "gxRecordUnsupported",
  "snapshotGxUnsupported",
];

function makeTelemetryContext(extra = {}) {
  const context = {
    cycles: 0,
    dispatches: 0,
    gxFirstUnsupportedEvent: null,
    gxUnsupportedAddressCounts: new Uint32Array(256),
    gxUnsupportedCountLimit: 0xffff_ffff,
    gxUnsupportedReasonCounts: new Map(),
    gxUnsupportedReasonLimit: 32,
    gxUnsupportedTotalEvents: 0,
    gxUnsupportedUntrackedReasonEvents: 0,
    Map,
    Number,
    Object,
    Uint32Array,
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(
    telemetryFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-unsupported-telemetry.js" },
  );
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("GX unsupported report has one stable empty schema", () => {
  const context = makeTelemetryContext();
  assert.deepEqual(plain(context.snapshotGxUnsupported()), {
    schema: "lazuli-gx-unsupported-v1",
    totalEvents: 0,
    firstEvent: null,
    reasonCounts: [],
    addressCounts: [],
    reasonKeyLimit: 32,
    countLimit: 0xffff_ffff,
    untrackedReasonEvents: 0,
  });
});

test("GX unsupported recorder retains the first event and sorts bounded counts", () => {
  const context = makeTelemetryContext({ cycles: 41, dispatches: 7 });
  context.gxRecordUnsupported("z-freeze", 0, 1 << 19);
  context.cycles = 52;
  context.dispatches = 9;
  context.gxRecordUnsupported("indirect-tev", 0x12, 0x1234, "stages=2");
  context.gxRecordUnsupported("z-freeze", 0, 1 << 19);

  assert.equal(Object.isFrozen(context.gxFirstUnsupportedEvent), true);
  assert.deepEqual(plain(context.snapshotGxUnsupported()), {
    schema: "lazuli-gx-unsupported-v1",
    totalEvents: 3,
    firstEvent: {
      reason: "z-freeze",
      address: "0x00",
      value: "0x00080000",
      detail: null,
      cycle: 41,
      dispatch: 7,
    },
    reasonCounts: [
      { reason: "indirect-tev", count: 1 },
      { reason: "z-freeze", count: 2 },
    ],
    addressCounts: [
      { address: "0x00", count: 2 },
      { address: "0x12", count: 1 },
    ],
    reasonKeyLimit: 32,
    countLimit: 0xffff_ffff,
    untrackedReasonEvents: 0,
  });

  const mutableSnapshot = context.snapshotGxUnsupported();
  mutableSnapshot.firstEvent.reason = "changed";
  assert.equal(context.snapshotGxUnsupported().firstEvent.reason, "z-freeze");
});

test("GX unsupported reason cardinality, strings, and counters are hard bounded", () => {
  const context = makeTelemetryContext();
  const longReason = "r".repeat(160);
  const longDetail = "d".repeat(160);
  context.gxRecordUnsupported(longReason, 0x55, -1, longDetail);
  for (let index = 1; index < 32; index += 1) {
    context.gxRecordUnsupported(`reason-${index}`, index);
  }
  context.gxRecordUnsupported("overflow-a", 0x55);
  context.gxRecordUnsupported("overflow-b", 0x55);
  let report = context.snapshotGxUnsupported();
  assert.equal(report.reasonCounts.length, 32);
  assert.equal(report.untrackedReasonEvents, 2);
  assert.equal(report.totalEvents, 34);
  assert.equal(report.firstEvent.reason.length, 96);
  assert.equal(report.firstEvent.detail.length, 96);
  assert.equal(report.firstEvent.value, "0xffffffff");
  assert.deepEqual(
    plain(report.addressCounts.find(entry => entry.address === "0x55")),
    { address: "0x55", count: 3 },
  );

  context.gxUnsupportedTotalEvents = 0xffff_ffff;
  context.gxUnsupportedUntrackedReasonEvents = 0xffff_ffff;
  context.gxUnsupportedReasonCounts.set("reason-1", 0xffff_ffff);
  context.gxUnsupportedAddressCounts[1] = 0xffff_ffff;
  context.gxRecordUnsupported("reason-1", 1);
  context.gxRecordUnsupported("still-overflow", 1);
  report = context.snapshotGxUnsupported();
  assert.equal(report.totalEvents, 0xffff_ffff);
  assert.equal(report.untrackedReasonEvents, 0xffff_ffff);
  assert.equal(
    report.reasonCounts.find(entry => entry.reason === "reason-1").count,
    0xffff_ffff,
  );
  assert.equal(
    report.addressCounts.find(entry => entry.address === "0x01").count,
    0xffff_ffff,
  );
});

function makeDecoderContext() {
  const context = makeTelemetryContext({
    bytes: new Uint8Array(64),
    gxBpLoads: 0,
    gxCpLoads: 0,
    gxCpRegisters: new Uint32Array(256),
    gxDecodeRetryAtBufferedBytes: 1,
    gxDecodedCommands: 0,
    gxDeferredDisplayListSegments: [],
    gxDisplayListBytes: 0,
    gxDisplayListErrors: 0,
    gxDisplayLists: 0,
    gxIndexedXfLoads: 0,
    gxPrimitives: 0,
    gxTextureCopyDecoderBarrierStops: 0,
    gxUnknownOpcodes: 0,
    gxVertices: 0,
    gxXfLoads: 0,
    rendererTextureCopyBarrierSequence: null,
    gxVertexSize() { return 0; },
    ramPointer() { return null; },
    recordGxBpWrite() {},
    recordGxIndexedXfWrite() {},
    recordGxPrimitive() {},
    recordGxXfWrite() {},
  });
  vm.runInContext(
    ["gxReadU32", "gxReadU16", "decodeGxCommands"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.gx-unsupported-decoder.js" },
  );
  return context;
}

test("GX decoder reports only commands it actually skips", () => {
  const unknown = makeDecoderContext();
  assert.equal(unknown.decodeGxCommands(Uint8Array.of(0x7f), 0, 1), 1);
  assert.deepEqual(plain(unknown.snapshotGxUnsupported().firstEvent), {
    reason: "unknown-opcode",
    address: null,
    value: "0x0000007f",
    detail: "fifo",
    cycle: 0,
    dispatch: 0,
  });

  const nested = makeDecoderContext();
  const call = Uint8Array.of(
    0x40,
    0x80, 0x00, 0x12, 0x34,
    0x00, 0x00, 0x00, 0x20,
  );
  assert.equal(nested.decodeGxCommands(call, 0, call.length, true), call.length);
  assert.deepEqual(plain(nested.snapshotGxUnsupported().firstEvent), {
    reason: "nested-display-list",
    address: null,
    value: "0x80001234",
    detail: "size=32",
    cycle: 0,
    dispatch: 0,
  });
});

const textureFunctions = [
  "gxTextureRegisters",
  "gxTextureLayout",
  "gxTextureMipCount",
  "gxStrictV7TexturePreflight",
  "gxTextureMipChainLayout",
  "gxTextureImageSource",
  "gxTextureSamplerState",
  "gxDecodeTexture",
];

function makeTextureContext() {
  const context = makeTelemetryContext({
    bytes: new Uint8Array(4096),
    gxBpRegisters: new Uint32Array(256),
    gxMarkTextureCopyConsumer() {},
    gxTextureCopyDestinations: new Map(),
    gxTextureDecodeErrors: 0,
    gxTextureSourceHashComputations: 0,
    gxTextureSourceHashMemoHits: 0,
    gxTlutLoads: 0,
    gxTmem: new Uint8Array(1024 * 1024),
    ramPointer() { return null; },
  });
  vm.runInContext(
    textureFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-unsupported-texture.js" },
  );
  return context;
}

function configureTexture(context, { format = 0, mode0 = 0 } = {}) {
  const registers = context.gxTextureRegisters(0);
  context.gxBpRegisters[registers.image0] = 7 | (7 << 10) | (format << 20);
  context.gxBpRegisters[registers.mode0] = mode0;
  return registers;
}

test("texture telemetry is emitted at strict, TMEM, and TLUT rejection sites", () => {
  const sampler = makeTextureContext();
  configureTexture(sampler, { mode0: 1 << 19 });
  assert.equal(sampler.gxDecodeTexture(0), null);
  assert.deepEqual(plain(sampler.snapshotGxUnsupported().firstEvent), {
    reason: "texture-preflight:unsupported-anisotropy",
    address: "0x80",
    value: "0x00080000",
    detail: null,
    cycle: 0,
    dispatch: 0,
  });

  const preloaded = makeTextureContext();
  const preloadedRegisters = configureTexture(preloaded);
  preloaded.gxBpRegisters[preloadedRegisters.image1] = 0x00201234;
  assert.equal(preloaded.gxDecodeTexture(0), null);
  assert.equal(
    preloaded.snapshotGxUnsupported().firstEvent.reason,
    "preloaded-tmem-texture",
  );
  assert.equal(preloaded.snapshotGxUnsupported().firstEvent.address, "0x8c");

  const tlut = makeTextureContext();
  const tlutRegisters = configureTexture(tlut, { format: 8 });
  tlut.gxBpRegisters[tlutRegisters.tlut] = 3 << 10;
  tlut.ramPointer = () => 0;
  assert.equal(tlut.gxDecodeTexture(0), null);
  assert.deepEqual(plain(tlut.snapshotGxUnsupported().firstEvent), {
    reason: "tlut-format",
    address: "0x98",
    value: "0x00000c00",
    detail: "map=0",
    cycle: 0,
    dispatch: 0,
  });
});

test("draw, copy, bbox, report, and reset anchors preserve consumer gating", () => {
  const primitive = extractFunction("recordGxPrimitive");
  assert.ok(
    primitive.indexOf('gxRecordUnsupported("multisampling"')
      > primitive.indexOf("if (!decodeComplete || vertexCount === 0)"),
  );
  assert.match(
    primitive,
    /const indirectStageCount[\s\S]*const indirectStage = stages\.find\([\s\S]*"indirect-tev"/,
  );
  assert.doesNotMatch(primitive, /indirectStageCount === 0/);

  const bp = extractFunction("recordGxBpWrite");
  assert.ok(
    bp.indexOf('"efb-copy-source-format"')
      > bp.indexOf("if (address !== 0x52) return"),
  );
  assert.match(bp, /sourceFormat >= 4[\s\S]*"efb-copy-source-format"/);
  assert.match(
    bp,
    /!copyToXfb[\s\S]*gxCopyTextureLayout[\s\S]*"efb-copy-target-format"/,
  );
  assert.equal((bp.match(/gxRecordUnsupported\(/g) ?? []).length, 2);

  const read = extractFunction("readInteger");
  assert.match(
    read,
    /physical >= 0x0c001010[\s\S]*physical \+ size <= 0x0c001018[\s\S]*"bounding-box-read"/,
  );
  assert.doesNotMatch(
    extractFunction("resetGxCommandProcessorDecoder"),
    /Unsupported/,
  );
  assert.doesNotMatch(extractFunction("resetGxWriteGatherPipe"), /Unsupported/);
  assert.match(
    extractFunction("finish"),
    /decoder: \{[\s\S]*unsupported: snapshotGxUnsupported\(\)/,
  );
});
