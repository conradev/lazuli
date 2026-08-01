#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  buildGxMipActivationOracleFrame,
  buildGxMipActivationOraclePacket,
  buildGxMipActivationOracleTexture,
  gxMipActivationOracle,
} from "./browser_boot_gx_mip_activation_oracle.mjs";

const source = readFileSync(
  new URL(
    "../crates/ppcwasmjit/examples/browser_boot.rs",
    import.meta.url,
  ),
  "utf8",
);

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.notEqual(match, null, `missing ${name} in browser_boot.rs`);
  const start = match.index;
  const bodyStart = source.indexOf("{", start);
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

const packetFunctions = [
  "gxFramePacketInteger",
  "gxFramePacketAdd",
  "gxFramePacketMultiply",
  "gxFramePacketAlign16",
  "gxFramePacketBytes",
  "gxFramePacketEqualBytes",
  "gxFramePacketKeyBytes",
  "gxFramePacketSampler",
  "gxSourceTriangleCount",
  "gxSourceTriangleIndex",
  "gxExpandedTriangleIndices",
  "gxFramePacketPostCullEvidence",
  "packGxFramePacketV4",
  "gxFramePacketExactClipInput",
  "packGxFramePacketV5",
  "packGxFramePacketV6",
  "gxTextureMipCount",
  "gxStrictV7TexturePreflight",
  "gxFramePacketMipLayout",
  "gxFramePacketMipTexture",
  "gxFramePacketEqualMipTexture",
  "packGxFramePacketV7",
  "gxStrictV7RenderKey",
  "gxStrictV7TextureSnapshotClassification",
  "gxPrepareStrictV7Frame",
  "packGxFramePacketForRenderer",
];

function packetContext() {
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Float32Array,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RangeError,
    Set,
    TextEncoder,
    TypeError,
    Uint8Array,
    Uint32Array,
  };
  vm.createContext(context);
  vm.runInContext(
    packetFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-mip-activation.js" },
  );
  return context;
}

const producerFunctions = [
  "gxCullF32",
  "gxCullMul",
  "gxCullAdd",
  "gxCullSub",
  "gxCullDot4Position",
  "gxCullDot4",
  "gxCullTransformState",
  "gxCullPositionMatrix",
  "gxCullViewPosition",
  "gxCullClipPosition",
  "gxCullClipPositionIsInside",
  "gxCullNormalZ3",
  "gxSourceTriangleCount",
  "gxSourceTriangleIndex",
  "gxPostCullActionFromNormal",
  "gxPostCullEvidence",
  "gxTextureRegisters",
  "gxTextureMipCount",
  "gxStrictV7TexturePreflight",
  "gxStrictV7TextureSnapshotClassification",
  "gxManagedCoverageStateCandidate",
  "gxManagedCoverageVerticesCandidate",
  "gxManagedCoveragePostCullEvidence",
  "gxTevSwapTable",
  "gxPackTevState",
  "recordGxPrimitive",
];

function colorCombiner(args, operation, destination) {
  return (
    (args[0] << 12)
    | (args[1] << 8)
    | (args[2] << 4)
    | args[3]
    | ((operation & 1) << 18)
    | (1 << 19)
    | (((operation >> 1) & 3) << 20)
    | (destination << 22)
    | (operation >= 8 ? 3 << 16 : 0)
  ) >>> 0;
}

function alphaCombiner(args, operation, destination) {
  return (
    (args[0] << 13)
    | (args[1] << 10)
    | (args[2] << 7)
    | (args[3] << 4)
    | ((operation & 1) << 18)
    | (1 << 19)
    | (((operation >> 1) & 3) << 20)
    | (destination << 22)
    | (operation >= 8 ? 3 << 16 : 0)
  ) >>> 0;
}

function activationDecodedVertex(index) {
  const screen = [
    [0.59, 0, 0.1, 0.1],
    [4, 0, 1.8, 0.1],
    [4, 4, 1.8, 1.8],
    [0.59, 4, 0.1, 1.8],
  ][index];
  const [x, y, s, t] = screen;
  const texCoords = Array.from(
    { length: 8 },
    (_unused, coordinate) => coordinate === 0
      ? [s, t, 1]
      : [0, 0, 1],
  );
  return {
    skipped: false,
    projected: [x, y, 0, 1],
    // The orthographic producer state maps this raw position back to the
    // projected EFB point above. Keeping both views consistent ensures the
    // cull evidence is derived from the same geometry as the packet vertices.
    position: [(x - 2) / 2, (y - 2) / -2, -0.5],
    positionMatrix: 0,
    rasterColors: [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ],
    texCoords,
    rawTextureCoords: texCoords.map(coord => coord.slice(0, 2)),
    normal: [0, 0, 1],
    textureMatrices: Array(8).fill(0),
  };
}

function producerDraw(strictV7Preflight) {
  const texture = buildGxMipActivationOracleTexture({
    strictV7Preflight,
  });
  const gxBpRegisters = new Uint32Array(0x100);
  const textureRegisters = {
    mode0: 0x80,
    mode1: 0x84,
    image0: 0x88,
  };
  gxBpRegisters[textureRegisters.mode0] = gxMipActivationOracle.mode0;
  gxBpRegisters[textureRegisters.mode1] = gxMipActivationOracle.mode1;
  gxBpRegisters[textureRegisters.image0] =
    ((gxMipActivationOracle.width - 1)
      | ((gxMipActivationOracle.height - 1) << 10)
      | (gxMipActivationOracle.format << 20)) >>> 0;
  gxBpRegisters[0xf6] = 1 << 2;
  gxBpRegisters[0xf7] = 2 | (3 << 2);

  const xf = new Float32Array(0x1100);
  xf.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set([2, -2, 0, 2, 2, 0], 0x101a);
  xf.set([1, 0, 1, 0, 1, 0], 0x1020);
  const gxXfRegisters = new Uint32Array(xf.buffer);
  gxXfRegisters[0x1026] = 1;

  const decodedVertices = Array.from(
    { length: 4 },
    (_unused, index) => activationDecodedVertex(index),
  );
  const stage = {
    index: 0,
    order: 0,
    textureMap: 0,
    texCoordIndex: 0,
    textureEnabled: true,
    colorChannel: 7,
    colorCombiner: colorCombiner([15, 15, 15, 8], 0, 1),
    alphaCombiner: alphaCombiner([7, 7, 7, 4], 0, 1),
    konstColorSelector: 0,
    konstAlphaSelector: 0,
  };
  const pipeline = {
    cullMode: 0,
    zMode: 0,
    blendMode: 1 << 3,
    alphaTest: 0x003f0000,
    scissorX: 0,
    scissorY: 0,
    scissorWidth: gxMipActivationOracle.width,
    scissorHeight: gxMipActivationOracle.height,
    pixelControl: 0,
    constantAlpha: 0,
    zTextureBias: 0,
    zTextureMode: 0,
    fogRangeBase: 0,
    fogRangeK: [0, 0, 0, 0, 0],
    fogWords: [0, 0, 0, 0, 0],
    viewportHalfWidthBits: 0,
  };
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Float32Array,
    Map,
    Math,
    Number,
    Object,
    String,
    Uint8Array,
    Uint32Array,
    gxBpRegisters,
    gxCpRegisters: new Uint32Array(0x100),
    gxXfRegisters,
    gxTevColorRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxTevKonstRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxCollectFrameGeometry: true,
    gxSkippedGeometryPrimitives: 0,
    gxSkippedGeometryVertices: 0,
    gxFrameSkippedPrimitives: 0,
    gxFrameDrawVertices: 0,
    gxVertexDecodeErrors: 0,
    gxDecodedVertices: 0,
    gxProjectedVertices: 0,
    gxDroppedVertices: 0,
    gxLegacyProjectionNullVertices: 0,
    gxExactRequiredDraws: 0,
    gxExactRequiredVertices: 0,
    gxExactRequiredCaptureMisses: 0,
    gxTexturedDraws: 0,
    gxDrawStateSnapshots: 0,
    gxDrawStateMemoHits: 0,
    gxVertexTransformContextSnapshots: 0,
    gxVertexTransformContextMemoHits: 0,
    statusDataset: {},
    gxTevModeCounts: new Map(),
    gxFrameDraws: [],
    gxPrimitiveSamples: [],
    gxRecentPrimitiveSamples: [],
    cycles: 11,
    dispatches: 13,
    gxXfFloat(address) {
      return xf[address];
    },
    gxDrawPipelineState() {
      return pipeline;
    },
    gxTevStageState() {
      return stage;
    },
    gxPrepareVertexTransformContext() {
      context.gxVertexTransformContextSnapshots += 1;
      return {};
    },
    gxDecodeVertex(_source, start) {
      return { ...decodedVertices[start], cursor: start + 1 };
    },
    gxTevCoordsValid(coords, count) {
      return coords.length === count && coords.every(coord =>
        Array.isArray(coord) && coord.length >= 3
      );
    },
    gxTevCoordsTransportable(coords, count) {
      return Array.isArray(coords) && coords.length === count
        && coords.every(coord => Array.isArray(coord) && coord.length >= 3);
    },
    gxTevTextures() {
      const textures = Array(8).fill(null);
      textures[0] = texture;
      return textures;
    },
    gxManagedCoverageExactClipInput() {
      throw new Error("canonical activation draw unexpectedly needed exact clip input");
    },
    gxTextureSummary(value) {
      return value === null ? null : { key: value.key };
    },
    hex32(value) {
      return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    producerFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-mip-activation-producer.js" },
  );
  context.recordGxPrimitive(0x80, new Uint8Array(4), 0, 4, 1);
  assert.equal(context.gxFrameDraws.length, 1);
  return context.gxFrameDraws[0];
}

function packetBytes(packet) {
  if (packet instanceof ArrayBuffer) {
    return new Uint8Array(packet);
  }
  return new Uint8Array(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
}

function textureRecord(packet) {
  const bytes = packetBytes(packet);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const offset = view.getUint32(0x20, true);
  return {
    version: view.getUint16(0x04, true),
    packetBytes: view.getUint32(0x08, true),
    pixelSectionBytes: view.getUint32(0x48, true),
    payloadBytes: view.getUint32(offset + 0x0c, true),
    flags: view.getUint32(offset + 0x20, true),
    levelCount: view.getUint32(offset + 0x24, true),
  };
}

test("committed packets are exact output of the live strict-V7 selector chain", () => {
  const context = packetContext();
  const preflight = context.gxStrictV7TexturePreflight(
    gxMipActivationOracle.mode0,
    gxMipActivationOracle.mode1,
    gxMipActivationOracle.format,
    gxMipActivationOracle.width,
    gxMipActivationOracle.height,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(preflight)), {
    accepted: true,
    classification: "genuine-mip",
    mode0: 0x20,
    mode1: 0x2000,
    format: 6,
    width: 4,
    height: 4,
    levelCount: 3,
    minFilter: 1,
    mipMode: 1,
    maxAnisotropy: 1,
    magLinear: false,
    minLinear: false,
    diagonalLod: false,
    lodBiasRaw: 0,
    lodBiasSixteenths: 0,
    lodMinRaw: 0,
    lodMaxRaw: 32,
    effectiveLodMinRaw: 0,
    effectiveLodMaxRaw: 32,
    wrapS: 0,
    wrapT: 0,
  });
  const liveDraw = producerDraw(preflight);
  assert.deepEqual(Array.from(liveDraw.postCullEvidence), [0x0f]);
  assert.equal(Object.hasOwn(liveDraw, "exactClipInput"), false);
  assert.equal(
    liveDraw.textures[0].strictV7Preflight,
    preflight,
    "recordGxPrimitive retains the authentic decoded texture snapshot",
  );

  const firstFrame = buildGxMipActivationOracleFrame({
    generation: 1,
    draw: liveDraw,
  });
  const prepared = context.gxPrepareStrictV7Frame(firstFrame);
  assert.notEqual(prepared, null);
  assert.equal(
    prepared.geometry.draws[0].textures[0].renderKey,
    gxMipActivationOracle.key,
  );
  assert.equal(
    gxMipActivationOracle.key,
    `${gxMipActivationOracle.legacyKey}`
      + `~LZGX7:${gxMipActivationOracle.legacyKey.length}`,
  );

  const actualFirst = packetBytes(
    context.packGxFramePacketForRenderer(2, firstFrame),
  );
  const fixtureFirst = buildGxMipActivationOraclePacket();
  assert.deepEqual(fixtureFirst, actualFirst);
  assert.deepEqual(textureRecord(actualFirst), {
    version: 7,
    packetBytes: actualFirst.byteLength,
    pixelSectionBytes: 96,
    payloadBytes: 84,
    flags: 1,
    levelCount: 3,
  });

  const residentFrame = buildGxMipActivationOracleFrame({
    generation: 2,
    draw: liveDraw,
  });
  const actualResident = packetBytes(
    context.packGxFramePacketForRenderer(
      2,
      residentFrame,
      new Set([gxMipActivationOracle.key]),
    ),
  );
  const fixtureResident = buildGxMipActivationOraclePacket({
    resident: true,
  });
  assert.deepEqual(fixtureResident, actualResident);
  assert.deepEqual(textureRecord(actualResident), {
    version: 7,
    packetBytes: actualResident.byteLength,
    pixelSectionBytes: 0,
    payloadBytes: 0,
    flags: 0,
    levelCount: 3,
  });
  assert.notDeepEqual(actualFirst, actualResident);
});

test("fixture surface stays local-only and records exact bridge invariants", () => {
  assert.equal(gxMipActivationOracle.legacyKey, "lazuli-tx-v1");
  assert.equal(gxMipActivationOracle.key, "lazuli-tx-v1~LZGX7:12");
  assert.equal(gxMipActivationOracle.payloadBytes, 84);
  assert.equal(gxMipActivationOracle.mipLevelCount, 3);
  assert.deepEqual(gxMipActivationOracle.expectedFirstUpload, {
    resourceIdentities: 1,
    textureWrites: 3,
    textureUploadBytes: 84,
    packetPayloadBytes: 84,
  });
  assert.deepEqual(gxMipActivationOracle.expectedResidentUpload, {
    resourceIdentities: 1,
    textureWrites: 0,
    textureUploadBytes: 0,
    packetPayloadBytes: 0,
  });
  assert.doesNotMatch(source, /browser_boot_gx_mip_activation_oracle/);
});
