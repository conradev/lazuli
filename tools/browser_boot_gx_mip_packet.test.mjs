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
const rendererSource = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
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
  "gxFramePacketMipLayout",
  "gxFramePacketMipTexture",
  "gxFramePacketEqualMipTexture",
  "packGxFramePacketV7",
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
    TextEncoder,
    TypeError,
    Uint8Array,
    Uint32Array,
  };
  vm.createContext(context);
  vm.runInContext(packetFunctions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.gx-mip-packet.js",
  });
  return context;
}

function copyState() {
  return {
    zMode: 0x010203,
    blendMode: 0x040506,
    pixelControl: 0x070809,
    copyCommand: 0x004000,
    clearRgba: [0x11, 0x22, 0x33, 0x44],
    clearDepth: 0x0a0b0c,
    copyScale: 0x0d0e0f,
    copyFilter: [0x101112, 0x131415],
  };
}

function tevState(requiredMaps = []) {
  const state = new Uint8Array(464);
  const view = new DataView(state.buffer);
  for (let stage = 0; stage < requiredMaps.length; stage += 1) {
    const offset = stage * 16;
    view.setUint32(offset, stage + 1, true);
    view.setUint32(offset + 4, stage + 2, true);
    view.setUint32(offset + 8, (1 << 6) | requiredMaps[stage], true);
    view.setUint32(offset + 12, stage, true);
  }
  view.setUint32(448, requiredMaps.length, true);
  return state;
}

function baseDraw(textures = []) {
  const requiredMaps = [];
  for (let index = 0; index < textures.length; index += 1) {
    if (textures[index] !== null && textures[index] !== undefined) {
      requiredMaps.push(index);
    }
  }
  return {
    topology: 2,
    vertexCount: 3,
    vertices: new Float32Array(3 * 36),
    tevState: tevState(requiredMaps),
    textures,
    pipeline: {
      cullMode: 0,
      scissorWidth: 4,
      scissorHeight: 4,
      viewportHalfWidthBits: 0x43a00000,
    },
  };
}

function actionDraw(textures = []) {
  return {
    ...baseDraw(textures),
    postCullEvidence: Uint8Array.of(3),
  };
}

function exactDraw(textures = [], required = false) {
  const draw = baseDraw(textures);
  draw.exactClipInput = {
    bpGenMode: 0,
    bpScissorTopLeft: (342 << 12) | 342,
    bpScissorBottomRight: ((342 + 639) << 12) | (342 + 527),
    bpScissorOffset: 171 | (171 << 10),
    xfClipDisable: 0,
    viewport: new Float32Array([320, -264, 16777215, 342, 342, 0]),
    clipPositions: new Float32Array([
      0, 0, -0.5, 1,
      2, 0, -0.5, 1,
      0, 1, -0.5, 1,
    ]),
  };
  if (required) draw.exactGeometryRequired = true;
  return draw;
}

function frameWithDraws(draws) {
  return {
    copyToXfb: true,
    index: 31,
    sourceX: 0,
    sourceY: 0,
    width: 4,
    sourceHeight: 4,
    height: 4,
    destination: 0x00110000,
    stride: 16,
    clear: false,
    copyState: copyState(),
    geometry: {
      drawCalls: draws.length,
      vertices: draws.length * 3,
      draws,
    },
  };
}

function sequence(length, seed = 0) {
  return Uint8Array.from(
    { length },
    (_unused, index) => (seed + index * 17) & 0xff,
  );
}

function npotMipTexture(overrides = {}) {
  const mipPixels = sequence(72, 3);
  return {
    key: "npot-5x3",
    address: 0x00123000,
    textureCopyIndex: 17,
    width: 5,
    height: 3,
    mode0: 0x00080051,
    mode1: 0x00002004,
    levelCount: 3,
    wrapS: 1,
    wrapT: 0,
    magFilter: 1,
    minFilter: 2,
    maxAnisotropy: 1,
    pixels: mipPixels.subarray(0, 60),
    mipPixels,
    ...overrides,
  };
}

function twoLevelTexture(overrides = {}) {
  const mipPixels = sequence(28, 0x81);
  return {
    key: "npot-3x2",
    address: 0x00124000,
    textureCopyIndex: 18,
    width: 3,
    height: 2,
    mode0: 0x00000041,
    mode1: 0x00001000,
    levelCount: 2,
    wrapS: 1,
    wrapT: 0,
    magFilter: 0,
    minFilter: 2,
    maxAnisotropy: 0,
    pixels: mipPixels.subarray(0, 24),
    mipPixels,
    ...overrides,
  };
}

function packetBytes(packet) {
  return Array.from(new Uint8Array(packet));
}

function align16(value) {
  return (value + 15) & ~15;
}

test("packs an NPOT decoded mip chain without per-level padding", () => {
  const context = packetContext();
  const texture = npotMipTexture();
  const frame = frameWithDraws([baseDraw([texture])]);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  const drawOffset = view.getUint32(0x1c, true);
  const textureOffset = view.getUint32(0x20, true);
  const pixelOffset = view.getUint32(0x30, true);
  const mode1Offset = packet.byteLength - 32;

  assert.equal(view.getUint16(0x04, true), 7);
  assert.equal(view.getUint16(0x06, true), 160);
  assert.equal(view.getUint16(0x78, true), 176);
  assert.equal(view.getUint16(0x7a, true), 64);
  assert.equal(view.getUint32(textureOffset + 0x0c, true), 72);
  assert.equal(view.getUint32(textureOffset + 0x18, true), 5);
  assert.equal(view.getUint32(textureOffset + 0x1c, true), 3);
  assert.equal(view.getUint32(textureOffset + 0x20, true), 1);
  assert.equal(view.getUint32(textureOffset + 0x24, true), 3);
  assert.equal(view.getUint32(0x48, true), 80);
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset, pixelOffset + 72)),
    Array.from(texture.mipPixels),
  );
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset + 72, pixelOffset + 80)),
    Array(8).fill(0),
  );
  assert.equal(view.getUint32(drawOffset + 0x34, true), texture.mode0);
  assert.equal(view.getUint32(mode1Offset, true), texture.mode1);
  for (let textureMap = 1; textureMap < 8; textureMap += 1) {
    assert.equal(
      view.getUint32(drawOffset + 0x34 + textureMap * 8, true),
      0,
    );
    assert.equal(view.getUint32(mode1Offset + textureMap * 4, true), 0);
  }
});

test("aligns complete texture chains but never their individual mip levels", () => {
  const context = packetContext();
  const first = npotMipTexture();
  const second = twoLevelTexture();
  const frame = frameWithDraws([baseDraw([first, second])]);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  const textureOffset = view.getUint32(0x20, true);
  const pixelOffset = view.getUint32(0x30, true);
  assert.equal(view.getUint32(textureOffset + 0x08, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x0c, true), 72);
  assert.equal(view.getUint32(textureOffset + 64 + 0x08, true), 80);
  assert.equal(view.getUint32(textureOffset + 64 + 0x0c, true), 28);
  assert.equal(view.getUint32(0x48, true), 112);
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset, pixelOffset + 72)),
    Array.from(first.mipPixels),
  );
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset + 80, pixelOffset + 108)),
    Array.from(second.mipPixels),
  );
});

test("orders post-cull evidence, exact chunks, then the fixed MODE1 tail", () => {
  const context = packetContext();
  const texture = npotMipTexture();
  const raw = baseDraw([texture]);
  const action = actionDraw();
  const optional = exactDraw();
  const required = exactDraw([], true);
  required.exactClipInput.clipPositions[0] = 7;
  const frame = frameWithDraws([raw, action, optional, required]);
  const legacy = context.packGxFramePacketV6(2, frame);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const legacyView = new DataView(legacy);
  const bytes = new Uint8Array(packet);
  const drawOffset = view.getUint32(0x1c, true);
  const pixelOffset = view.getUint32(0x30, true);
  const evidenceOffset = pixelOffset + view.getUint32(0x48, true);
  const exactOffset = align16(evidenceOffset + 1);
  const legacyEvidenceOffset =
    legacyView.getUint32(0x30, true) + legacyView.getUint32(0x48, true);
  const legacyExactOffset = align16(legacyEvidenceOffset + 1);
  const exactBytes = legacy.byteLength - legacyExactOffset;
  const mode1Offset = exactOffset + exactBytes;

  assert.deepEqual(
    [0, 1, 2, 3].map(index =>
      view.getUint16(drawOffset + index * 176 + 0x02, true)
    ),
    [0, 1, 2, 6],
  );
  assert.equal(bytes[evidenceOffset], 3);
  assert.deepEqual(
    Array.from(bytes.subarray(exactOffset, mode1Offset)),
    Array.from(new Uint8Array(legacy).subarray(legacyExactOffset)),
  );
  assert.equal(view.getFloat32(exactOffset + 0x30, true), 0);
  assert.equal(view.getFloat32(exactOffset + 96 + 0x30, true), 7);
  assert.equal(view.getUint32(mode1Offset, true), texture.mode1);
  assert.equal(mode1Offset + 4 * 32, packet.byteLength);
});

test("suppresses only the full payload for an acknowledged resident mip texture", () => {
  const context = packetContext();
  const texture = npotMipTexture();
  const frame = frameWithDraws([baseDraw([texture])]);
  const packet = context.packGxFramePacketV7(2, frame, new Set([texture.key]));
  const view = new DataView(packet);
  const textureOffset = view.getUint32(0x20, true);
  assert.equal(view.getUint16(0x04, true), 7);
  assert.equal(view.getUint32(0x48, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x08, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x0c, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x18, true), 5);
  assert.equal(view.getUint32(textureOffset + 0x1c, true), 3);
  assert.equal(view.getUint32(textureOffset + 0x20, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x24, true), 3);
});

test("keeps MODE0 and MODE1 per draw while requiring one payload per key", () => {
  const context = packetContext();
  const first = npotMipTexture();
  const second = npotMipTexture({
    mode0: first.mode0 | 2,
    mode1: first.mode1 | 7,
    wrapS: 3,
  });
  const frame = frameWithDraws([baseDraw([first]), baseDraw([second])]);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const drawOffset = view.getUint32(0x1c, true);
  const mode1Offset = packet.byteLength - 64;
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(drawOffset + 0x34, true), first.mode0);
  assert.equal(view.getUint32(drawOffset + 176 + 0x34, true), second.mode0);
  assert.equal(view.getUint32(mode1Offset, true), first.mode1);
  assert.equal(view.getUint32(mode1Offset + 32, true), second.mode1);
});

test("returns exact canonical v4, v5, and v6 bytes without a derived mip chain", () => {
  const context = packetContext();
  const cases = [
    [frameWithDraws([actionDraw()]), "packGxFramePacketV4", 4],
    [frameWithDraws([exactDraw()]), "packGxFramePacketV5", 5],
    [frameWithDraws([exactDraw([], true)]), "packGxFramePacketV6", 6],
  ];
  for (const [frame, legacyPacker, version] of cases) {
    const expected = context[legacyPacker](2, frame);
    const actual = context.packGxFramePacketV7(2, frame);
    assert.equal(new DataView(actual).getUint16(0x04, true), version);
    assert.deepEqual(packetBytes(actual), packetBytes(expected));
  }

  const inert = npotMipTexture({
    mode1: 0,
    levelCount: 1,
    mipPixels: undefined,
  });
  const inertFrame = frameWithDraws([baseDraw([inert])]);
  assert.deepEqual(
    packetBytes(context.packGxFramePacketV7(2, inertFrame)),
    packetBytes(context.packGxFramePacketV6(2, inertFrame)),
  );
});

test("rejects noncanonical state, mismatched counts, and malformed mip payloads", () => {
  const context = packetContext();
  const reject = (texture, pattern, resident = null) => {
    const frame = frameWithDraws([baseDraw([texture])]);
    assert.throws(
      () => context.packGxFramePacketV7(2, frame, resident),
      pattern,
    );
  };
  reject(
    npotMipTexture({ mode0: 0x000c0051 }),
    /mode0 has noncanonical bits/,
  );
  reject(
    npotMipTexture({ mode1: 0x00012004 }),
    /mode1 has noncanonical bits/,
  );
  reject(
    npotMipTexture({ mode0: (3 << 5) | 1 }),
    /reserved mip mode 3/,
  );
  reject(
    npotMipTexture({ levelCount: 2 }),
    /conflicts with derived count 3/,
  );
  reject(
    npotMipTexture({ levelCount: undefined }),
    /must declare the derived mip count/,
  );
  reject(
    npotMipTexture({ mipPixels: undefined }),
    /mipPixels is required/,
  );
  reject(
    npotMipTexture({ mipPixels: sequence(68) }),
    /must contain 72 decoded mip bytes/,
  );
  reject(
    npotMipTexture({ pixels: sequence(60, 0xfe) }),
    /pixels conflicts with the mipPixels prefix/,
  );
  reject(
    npotMipTexture({ mipPixels: undefined }),
    /mipPixels is required/,
    new Set(["npot-5x3"]),
  );
});

test("rejects conflicting mip count or lower bytes for one first-use key", () => {
  const context = packetContext();
  const first = npotMipTexture();
  const conflictingPixels = Uint8Array.from(first.mipPixels);
  conflictingPixels[71] ^= 0xff;
  const second = npotMipTexture({ mipPixels: conflictingPixels });
  const pixelConflict = frameWithDraws([baseDraw([first]), baseDraw([second])]);
  assert.throws(
    () => context.packGxFramePacketV7(2, pixelConflict),
    /texture key "npot-5x3" has conflicting mip contents/,
  );

  const shorterPixels = first.mipPixels.subarray(0, 68);
  const shorter = npotMipTexture({
    mode1: 0x00001004,
    levelCount: 2,
    mipPixels: shorterPixels,
  });
  const countConflict = frameWithDraws([baseDraw([first]), baseDraw([shorter])]);
  assert.throws(
    () => context.packGxFramePacketV7(2, countConflict),
    /texture key "npot-5x3" has conflicting mip contents/,
  );
});

test("keeps live GX emission explicitly on v6", () => {
  const postStart = source.indexOf("function postGxFrame(");
  const postEnd = source.indexOf("function gxFramePacketInteger(", postStart);
  assert.notEqual(postStart, -1);
  assert.notEqual(postEnd, -1);
  const postSource = source.slice(postStart, postEnd);
  assert.match(postSource, /packet = packGxFramePacketV6\(/);
  assert.doesNotMatch(postSource, /packGxFramePacketV7/);
});

test("fails closed before WebGPU execution until mip upload support lands", () => {
  const submitStart = rendererSource.indexOf("pub fn submit_gx_frame(");
  const submitEnd = rendererSource.indexOf(
    "pub fn copy_texture(",
    submitStart,
  );
  assert.notEqual(submitStart, -1);
  assert.notEqual(submitEnd, -1);
  const submitSource = rendererSource.slice(submitStart, submitEnd);
  const parseOffset = submitSource.indexOf("GxFramePacket::parse(");
  const mipGateOffset = submitSource.indexOf(
    "texture.record.mip_level_count > 1",
  );
  const rendererMutationOffset = submitSource.indexOf("self.begin_segment_inner()");
  assert.ok(parseOffset >= 0);
  assert.ok(mipGateOffset > parseOffset);
  assert.ok(rendererMutationOffset > mipGateOffset);
  assert.match(
    submitSource,
    /LZGX mip transport requires WebGPU mip upload support/,
  );
});
