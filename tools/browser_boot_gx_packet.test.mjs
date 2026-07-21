#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

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
  "packGxFramePacketV1",
];

function packetContext() {
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Float32Array,
    JSON,
    Map,
    Number,
    Object,
    RangeError,
    TextEncoder,
    TypeError,
    Uint8Array,
  };
  vm.createContext(context);
  vm.runInContext(packetFunctions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.gx-packet.js",
  });
  return context;
}

function emptyTextureFrame() {
  return {
    copyToXfb: false,
    index: 7,
    sourceX: 1,
    sourceY: 2,
    width: 3,
    sourceHeight: 4,
    height: 99,
    destination: 0x00100000,
    stride: 777,
    clear: true,
    clearColor: [0x11, 0x22, 0x33, 0x44],
    geometry: { drawCalls: 0, vertices: 0, draws: [] },
  };
}

function tevState(requiredMaps, seed) {
  const state = new Uint8Array(464);
  const view = new DataView(state.buffer);
  for (let stage = 0; stage < requiredMaps.length; stage += 1) {
    const offset = stage * 16;
    view.setUint32(offset, (seed + stage) & 0x00ffffff, true);
    view.setUint32(offset + 4, (seed * 3 + stage) & 0x00ffffff, true);
    view.setUint32(offset + 8, (1 << 6) | requiredMaps[stage], true);
    view.setUint32(offset + 12, stage, true);
  }
  view.setUint32(448, requiredMaps.length, true);
  return state;
}

function representativeXfbFrame() {
  const alphaPixels = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const betaPixels = Uint8Array.of(0xfa, 0xfb, 0xfc, 0xfd);
  const alpha = {
    key: "alpha",
    address: 0x10203040,
    textureCopyIndex: 9,
    width: 2,
    height: 1,
    wrapS: 1,
    wrapT: 2,
    magFilter: 1,
    minFilter: 5,
    pixels: alphaPixels,
  };
  const beta = {
    key: "ignored",
    renderKey: "β",
    address: 0x50607080,
    textureCopyIndex: 10,
    width: 1,
    height: 1,
    wrapS: 3,
    wrapT: 0,
    magFilter: 0,
    minFilter: 7,
    pixels: betaPixels,
  };
  const repeatedAlpha = {
    ...alpha,
    wrapS: 2,
    wrapT: 3,
    magFilter: 0,
    minFilter: 1,
    pixels: alphaPixels.slice(),
  };
  const firstVertices = Float32Array.from(
    { length: 72 },
    (_unused, index) => (index - 17) / 8,
  );
  const secondVertices = Float32Array.from(
    { length: 36 },
    (_unused, index) => 32 - index * 0.25,
  );
  return {
    copyToXfb: true,
    index: 0x11223344,
    sourceX: 3,
    sourceY: 5,
    width: 320,
    sourceHeight: 240,
    height: 448,
    destination: 0x123400,
    stride: 1280,
    clear: true,
    clearColor: [0x11, 0x22, 0x33, 0x44],
    geometry: {
      drawCalls: 2,
      vertices: 3,
      draws: [
        {
          topology: 2,
          vertexCount: 2,
          vertices: firstVertices,
          tevState: tevState([0, 2], 3),
          textures: [alpha, null, beta],
          pipeline: {
            zMode: 0x01020304,
            blendMode: 0x05060708,
            alphaTest: 0x090a0b0c,
            cullMode: 2,
            scissorX: 11,
            scissorY: 12,
            scissorWidth: 313,
            scissorHeight: 227,
          },
        },
        {
          topology: 5,
          vertexCount: 1,
          vertices: secondVertices,
          tevState: tevState([1], 0xf0),
          textures: [null, repeatedAlpha],
          pipeline: {
            zMode: 0x11121314,
            blendMode: 0x15161718,
            alphaTest: 0x191a1b1c,
            cullMode: 1,
            scissorX: 21,
            scissorY: 22,
            scissorWidth: 299,
            scissorHeight: 218,
          },
        },
      ],
    },
  };
}

function packetBytes(packet) {
  return Buffer.from(new Uint8Array(packet));
}

function digest(packet) {
  return createHash("sha256").update(packetBytes(packet)).digest("hex");
}

function fnv1a64(packet) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new Uint8Array(packet)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

test("packs the exact canonical empty LZGX v1 vector", () => {
  const context = packetContext();
  const packet = context.packGxFramePacketV1(1, emptyTextureFrame());

  assert.equal(packet.byteLength, 128);
  assert.equal(
    packetBytes(packet).toString("hex"),
    "4c5a475801008000800000000000000001000000000000000000000080000000"
      + "8000000080000000800000008000000080000000000000000000000000000000"
      + "0000000000000000000000000100000002000000030000000400000000000000"
      + "0000000000001000000000000700000001000000112233448000400000000000",
  );
  assert.equal(
    digest(packet),
    "32539069280f1de32c9992c5772b7ee8ce86169517b871c658cfa4836cf0bccd",
  );
  assert.equal(fnv1a64(packet), "7fee704bf65b620a");
});

test("packs deterministic first-use texture tables and aligned payload sections", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  const first = context.packGxFramePacketV1(2, frame);
  const second = context.packGxFramePacketV1(2, representativeXfbFrame());
  const bytes = new Uint8Array(first);
  const view = new DataView(first);

  assert.deepEqual([...bytes.subarray(0, 4)], [0x4c, 0x5a, 0x47, 0x58]);
  assert.equal(view.getUint16(0x04, true), 1);
  assert.equal(view.getUint16(0x06, true), 128);
  assert.equal(view.getUint32(0x08, true), 1920);
  assert.equal(view.getUint32(0x10, true), 2);
  assert.equal(view.getUint32(0x14, true), 2);
  assert.equal(view.getUint32(0x18, true), 2);
  assert.equal(view.getUint32(0x1c, true), 128);
  assert.equal(view.getUint32(0x20, true), 384);
  assert.equal(view.getUint32(0x24, true), 512);
  assert.equal(view.getUint32(0x28, true), 1440);
  assert.equal(view.getUint32(0x2c, true), 1872);
  assert.equal(view.getUint32(0x30, true), 1888);
  assert.equal(view.getUint32(0x34, true), 256);
  assert.equal(view.getUint32(0x38, true), 128);
  assert.equal(view.getUint32(0x3c, true), 928);
  assert.equal(view.getUint32(0x40, true), 432);
  assert.equal(view.getUint32(0x44, true), 7);
  assert.equal(view.getUint32(0x48, true), 32);
  assert.equal(view.getUint32(0x4c, true), 3);
  assert.equal(view.getUint32(0x50, true), 5);
  assert.equal(view.getUint32(0x54, true), 320);
  assert.equal(view.getUint32(0x58, true), 240);
  assert.equal(view.getUint32(0x5c, true), 320);
  assert.equal(view.getUint32(0x60, true), 448);
  assert.equal(view.getUint32(0x64, true), 0x123400);
  assert.equal(view.getUint32(0x68, true), 1280);
  assert.equal(view.getUint32(0x6c, true), 0x11223344);
  assert.equal(view.getUint32(0x70, true), 1);
  assert.deepEqual([...bytes.subarray(0x74, 0x78)], [0x11, 0x22, 0x33, 0x44]);
  assert.equal(view.getUint16(0x78, true), 128);
  assert.equal(view.getUint16(0x7a, true), 64);
  assert.equal(view.getUint32(0x7c, true), 3);

  const firstDraw = 128;
  assert.equal(bytes[firstDraw], 2);
  assert.equal(bytes[firstDraw + 1], 2);
  assert.equal(view.getUint32(firstDraw + 0x04, true), 2);
  assert.equal(view.getUint32(firstDraw + 0x08, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x0c, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x30, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x34, true), 0xb9);
  assert.equal(view.getUint32(firstDraw + 0x38, true), 0xffffffff);
  assert.equal(view.getUint32(firstDraw + 0x3c, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x40, true), 1);
  assert.equal(view.getUint32(firstDraw + 0x44, true), 0xe3);

  const secondDraw = 256;
  assert.equal(view.getUint32(secondDraw + 0x04, true), 1);
  assert.equal(view.getUint32(secondDraw + 0x08, true), 288);
  assert.equal(view.getUint32(secondDraw + 0x0c, true), 464);
  assert.equal(view.getUint32(secondDraw + 0x30, true), 0xffffffff);
  assert.equal(view.getUint32(secondDraw + 0x38, true), 0);
  assert.equal(view.getUint32(secondDraw + 0x3c, true), 0x2e);

  const firstTexture = 384;
  assert.equal(view.getUint32(firstTexture + 0x00, true), 0);
  assert.equal(view.getUint32(firstTexture + 0x04, true), 5);
  assert.equal(view.getUint32(firstTexture + 0x08, true), 0);
  assert.equal(view.getUint32(firstTexture + 0x0c, true), 8);
  assert.equal(view.getUint32(firstTexture + 0x10, true), 0x10203040);
  assert.equal(view.getUint32(firstTexture + 0x14, true), 9);
  assert.equal(view.getUint32(firstTexture + 0x18, true), 2);
  assert.equal(view.getUint32(firstTexture + 0x1c, true), 1);
  assert.equal(view.getUint32(firstTexture + 0x20, true), 1);
  const secondTexture = 448;
  assert.equal(view.getUint32(secondTexture + 0x00, true), 5);
  assert.equal(view.getUint32(secondTexture + 0x04, true), 2);
  assert.equal(view.getUint32(secondTexture + 0x08, true), 16);
  assert.equal(view.getUint32(secondTexture + 0x0c, true), 4);
  assert.equal(view.getUint32(secondTexture + 0x10, true), 0x50607080);
  assert.equal(view.getUint32(secondTexture + 0x14, true), 10);
  assert.equal(view.getUint32(secondTexture + 0x18, true), 1);
  assert.equal(view.getUint32(secondTexture + 0x1c, true), 1);
  assert.equal(view.getUint32(secondTexture + 0x20, true), 1);

  assert.equal(view.getUint32(1440, true), 0xc0080000);
  assert.equal(view.getUint32(1440 + 288, true), 0x42000000);

  assert.equal(new TextDecoder().decode(bytes.subarray(1872, 1879)), "alphaβ");
  assert.deepEqual([...bytes.subarray(1879, 1888)], Array(9).fill(0));
  assert.deepEqual([...bytes.subarray(1888, 1896)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...bytes.subarray(1896, 1904)], Array(8).fill(0));
  assert.deepEqual([...bytes.subarray(1904, 1908)], [0xfa, 0xfb, 0xfc, 0xfd]);
  assert.deepEqual([...bytes.subarray(1908, 1920)], Array(12).fill(0));
  assert.deepEqual(packetBytes(first), packetBytes(second));
  assert.equal(
    digest(first),
    "60441ebbaa5c911e3af57da069b76dae8bff1b31be7945b011790444087f770f",
  );
  assert.equal(fnv1a64(first), "699bd0c2be6e8a9f");
});

test("rejects conflicting content for one frame-local texture key", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  frame.geometry.draws[1].textures[1].pixels[0] ^= 0xff;
  assert.throws(
    () => context.packGxFramePacketV1(2, frame),
    /texture key "alpha" has conflicting contents/,
  );

  const metadataConflict = representativeXfbFrame();
  metadataConflict.geometry.draws[1].textures[1].address += 1;
  assert.throws(
    () => context.packGxFramePacketV1(2, metadataConflict),
    /texture key "alpha" has conflicting contents/,
  );
});

test("rejects malformed or non-canonical packet inputs", () => {
  const context = packetContext();
  assert.throws(
    () => context.packGxFramePacketV1(3, emptyTextureFrame()),
    /copyKind must be 1 or 2|copyKind must be an integer/,
  );

  const unsafeGeneration = emptyTextureFrame();
  unsafeGeneration.index = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => context.packGxFramePacketV1(1, unsafeGeneration),
    /frame.index must be an integer/,
  );

  const wrongVertexBytes = representativeXfbFrame();
  wrongVertexBytes.geometry.draws[0].vertices = new Float32Array(35);
  assert.throws(
    () => context.packGxFramePacketV1(2, wrongVertexBytes),
    /144 bytes per vertex/,
  );

  const wrongTevBytes = representativeXfbFrame();
  wrongTevBytes.geometry.draws[0].tevState = new Uint8Array(463);
  assert.throws(
    () => context.packGxFramePacketV1(2, wrongTevBytes),
    /tevState must be 464 bytes/,
  );

  const nonzeroTevPadding = representativeXfbFrame();
  nonzeroTevPadding.geometry.draws[0].tevState[452] = 1;
  assert.throws(
    () => context.packGxFramePacketV1(2, nonzeroTevPadding),
    /tevState has nonzero padding/,
  );

  const nonzeroInactiveStage = representativeXfbFrame();
  nonzeroInactiveStage.geometry.draws[0].tevState[32] = 1;
  assert.throws(
    () => context.packGxFramePacketV1(2, nonzeroInactiveStage),
    /tevState has nonzero inactive stages/,
  );

  const invalidSwapChannel = representativeXfbFrame();
  new DataView(invalidSwapChannel.geometry.draws[0].tevState.buffer)
    .setUint32(384, 4, true);
  assert.throws(
    () => context.packGxFramePacketV1(2, invalidSwapChannel),
    /tevState has invalid swap-table channels/,
  );

  const wrongPixelBytes = representativeXfbFrame();
  wrongPixelBytes.geometry.draws[0].textures[0].pixels = new Uint8Array(7);
  assert.throws(
    () => context.packGxFramePacketV1(2, wrongPixelBytes),
    /pixels must be empty or width \* height \* 4 bytes/,
  );

  const oversizedTexture = representativeXfbFrame();
  oversizedTexture.geometry.draws[0].textures[0].width = 1025;
  oversizedTexture.geometry.draws[1].textures[1].width = 1025;
  assert.throws(
    () => context.packGxFramePacketV1(2, oversizedTexture),
    /width must be an integer from 0 through 1024/,
  );

  const tooManyTextureSlots = representativeXfbFrame();
  tooManyTextureSlots.geometry.draws[0].textures = Array(9).fill(null);
  assert.throws(
    () => context.packGxFramePacketV1(2, tooManyTextureSlots),
    /textures must have at most 8 slots/,
  );

  const zeroSourceWidth = emptyTextureFrame();
  zeroSourceWidth.width = 0;
  assert.throws(
    () => context.packGxFramePacketV1(1, zeroSourceWidth),
    /source dimensions must be nonzero/,
  );

  const missingRequiredTexture = representativeXfbFrame();
  missingRequiredTexture.geometry.draws[0].textures[2] = null;
  assert.throws(
    () => context.packGxFramePacketV1(2, missingRequiredTexture),
    /TEV stage 1 requires missing texture map 2/,
  );

  const malformedKey = representativeXfbFrame();
  malformedKey.geometry.draws[0].textures[0].key = "bad\ud800";
  assert.throws(
    () => context.packGxFramePacketV1(2, malformedKey),
    /unpaired surrogate/,
  );
});

test("canonicalizes NaN vertices to one little-endian f32 encoding", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  frame.geometry.draws[0].vertices[0] = Number.NaN;
  const packet = context.packGxFramePacketV1(2, frame);

  assert.equal(new DataView(packet).getUint32(1440, true), 0x7fc00000);
});

test("encodes a legal resident texture reference without a pixel payload", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  const resident = frame.geometry.draws[0].textures[0];
  resident.pixels = undefined;
  frame.geometry.draws[1].textures[1].pixels = undefined;
  const packet = context.packGxFramePacketV1(2, frame);
  const view = new DataView(packet);

  assert.equal(view.getUint32(384 + 0x08, true), 0);
  assert.equal(view.getUint32(384 + 0x0c, true), 0);
  assert.equal(view.getUint32(384 + 0x20, true), 0);
  assert.equal(view.getUint32(448 + 0x08, true), 0);
  assert.equal(view.getUint32(448 + 0x0c, true), 4);
  assert.equal(view.getUint32(448 + 0x20, true), 1);
});

test("omits acknowledged resident payloads across GX frames", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  const packet = context.packGxFramePacketV1(
    2,
    frame,
    new Set(["alpha", "β"]),
  );
  const view = new DataView(packet);

  assert.equal(packet.byteLength, 1888);
  assert.equal(view.getUint32(0x48, true), 0);
  assert.equal(view.getUint32(384 + 0x0c, true), 0);
  assert.equal(view.getUint32(384 + 0x20, true), 0);
  assert.equal(view.getUint32(448 + 0x0c, true), 0);
  assert.equal(view.getUint32(448 + 0x20, true), 0);
});
