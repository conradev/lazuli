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
const packetParserSource = readFileSync(
  new URL("../crates/browser-renderer/src/packet.rs", import.meta.url),
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
  "gxTevResourceDependencies",
  "gxTevTextures",
  "gxSourceTriangleCount",
  "gxSourceTriangleIndex",
  "gxExpandedTriangleIndices",
  "gxFramePacketPostCullEvidence",
  "packGxFramePacketV4",
  "gxAttachTextureCopyLayoutV1",
  "gxFramePacketIndirectTevState",
  "gxAttachIndirectTevStateV1",
  "gxFramePacketExactClipInput",
  "packGxFramePacketV5",
  "packGxFramePacketV6",
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

function copyState(copyCommand) {
  return {
    zMode: 0x010203,
    blendMode: 0x040506,
    pixelControl: 0x070809,
    copyCommand,
    clearRgba: [0x11, 0x22, 0x33, 0x44],
    clearDepth: 0x0a0b0c,
    copyScale: 0x0d0e0f,
    copyFilter: [0x101112, 0x131415],
  };
}

function indirectTevState(
  seed,
  indirectStageCount,
  tevStageCount = 1,
  cullMode = 0,
  xfNumTexGens = 1,
) {
  const word = offset => (seed + offset * 0x010101) & 0x00ffffff;
  return {
    genMode: (
      (word(29) & ~((0x0f << 10) | (3 << 14) | (7 << 16)))
      | ((tevStageCount - 1) << 10)
      | (cullMode << 14)
      | (indirectStageCount << 16)
    ) >>> 0,
    xfNumTexGens,
    matrices: Array.from({ length: 9 }, (_unused, index) => word(index)),
    imask: word(9),
    commands: Array.from(
      { length: 16 },
      (_unused, index) => word(10 + index),
    ),
    texScales: [word(26), word(27)],
    iref: word(28),
  };
}

function zeroIndirectTevState() {
  return {
    genMode: 0,
    xfNumTexGens: 0,
    matrices: Array(9).fill(0),
    imask: 0,
    commands: Array(16).fill(0),
    texScales: Array(2).fill(0),
    iref: 0,
  };
}

function setTevStageCount(draw, stageCount) {
  new DataView(
    draw.tevState.buffer,
    draw.tevState.byteOffset,
    draw.tevState.byteLength,
  ).setUint32(448, stageCount, true);
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
    copyState: copyState(0x000800),
    geometry: { drawCalls: 0, vertices: 0, draws: [] },
  };
}

function evidencedXfbFrame(action = 3) {
  const vertices = new Float32Array(3 * 36);
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
    copyState: {
      ...copyState(0x004000),
      clearRgba: [0, 0, 0, 255],
    },
    geometry: {
      drawCalls: 1,
      vertices: 3,
      draws: [{
        topology: 2,
        vertexCount: 3,
        vertices,
        tevState: new Uint8Array(464),
        textures: [],
        postCullEvidence: Uint8Array.of(action),
        pipeline: {
          cullMode: 0,
          scissorWidth: 4,
          scissorHeight: 4,
        },
      }],
    },
  };
}

function exactClipXfbFrame() {
  const frame = evidencedXfbFrame();
  const draw = frame.geometry.draws[0];
  delete draw.postCullEvidence;
  draw.pipeline.viewportHalfWidthBits = 0x43a00000;
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
  return frame;
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
    maxAnisotropy: 2,
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
    maxAnisotropy: 3,
    pixels: betaPixels,
  };
  const repeatedAlpha = {
    ...alpha,
    wrapS: 2,
    wrapT: 3,
    magFilter: 0,
    minFilter: 1,
    maxAnisotropy: 1,
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
    copyState: copyState(0x004800),
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
            zMode: 0x010203,
            blendMode: 0x040506,
            alphaTest: 0x070809,
            cullMode: 2,
            scissorX: 11,
            scissorY: 12,
            scissorWidth: 313,
            scissorHeight: 227,
            pixelControl: 0x111213,
            constantAlpha: 0x141516,
            zTextureBias: 0x171819,
            zTextureMode: 0x1a1b1c,
            fogRangeBase: 0x1d1e1f,
            fogRangeK: [0x212223, 0x242526, 0x272829, 0x2a2b2c, 0x2d2e2f],
            fogWords: [0x313233, 0x343536, 0x373839, 0x3a3b3c, 0x3d3e3f],
            viewportHalfWidthBits: 0x43a00000,
          },
        },
        {
          topology: 5,
          vertexCount: 1,
          vertices: secondVertices,
          tevState: tevState([1], 0xf0),
          textures: [null, repeatedAlpha],
          pipeline: {
            zMode: 0x111213,
            blendMode: 0x141516,
            alphaTest: 0x171819,
            cullMode: 1,
            scissorX: 21,
            scissorY: 22,
            scissorWidth: 299,
            scissorHeight: 218,
            pixelControl: 0x414243,
            constantAlpha: 0x444546,
            zTextureBias: 0x474849,
            zTextureMode: 0x4a4b4c,
            fogRangeBase: 0x4d4e4f,
            fogRangeK: [0x515253, 0x545556, 0x575859, 0x5a5b5c, 0x5d5e5f],
            fogWords: [0x616263, 0x646566, 0x676869, 0x6a6b6c, 0x6d6e6f],
            viewportHalfWidthBits: 0x43b40000,
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

test("packs the exact canonical empty LZGX v4 vector", () => {
  const context = packetContext();
  const packet = context.packGxFramePacketV4(1, emptyTextureFrame());

  assert.equal(packet.byteLength, 160);
  assert.equal(
    packetBytes(packet).toString("hex"),
    "4c5a47580400a000a000000000000000010000000000000000000000a0000000"
      + "a0000000a0000000a0000000a0000000a0000000000000000000000000000000"
      + "0000000000000000000000000100000002000000030000000400000000000000"
      + "000000000000100000000000070000000100000011223344b000400000000000"
      + "030201000605040009080700000800000c0b0a000f0e0d001211100015141300",
  );
  assert.equal(
    digest(packet),
    "d0bdcbf77a5ef318c3e8ca92c1e3a940bd9a7c331d5d7ee26fff305f8dd82667",
  );
  assert.equal(fnv1a64(packet), "9613a764ac1940e8");
});

test("attaches exact texture-copy layout without changing legacy packet versions", () => {
  const context = packetContext();
  const frame = emptyTextureFrame();
  frame.stride = 0x320;
  const packet = context.packGxFramePacketV4(1, frame);
  const legacy = Buffer.from(packetBytes(packet));
  const attached = context.gxAttachTextureCopyLayoutV1(packet, 1, frame);
  const view = new DataView(attached);

  assert.equal(attached, packet);
  assert.equal(view.getUint16(0x04, true), 4);
  assert.equal(view.getUint32(0x0c, true), 1);
  assert.equal(view.getUint32(0x5c, true), 3);
  assert.equal(view.getUint32(0x60, true), 4);
  assert.equal(view.getUint32(0x68, true), 0x320);
  assert.deepEqual(packetBytes(attached).subarray(0, 0x0c), legacy.subarray(0, 0x0c));
  assert.deepEqual(packetBytes(attached).subarray(0x10, 0x5c), legacy.subarray(0x10, 0x5c));
  assert.deepEqual(packetBytes(attached).subarray(0x6c), legacy.subarray(0x6c));
});

test("texture-copy layout clips before half-scaling and preserves zero stride", () => {
  const context = packetContext();
  const frame = {
    ...emptyTextureFrame(),
    sourceX: 638,
    sourceY: 526,
    width: 4,
    sourceHeight: 4,
    stride: 0,
    copyState: copyState(0x000a00),
  };
  const packet = context.packGxFramePacketV4(1, frame);
  context.gxAttachTextureCopyLayoutV1(packet, 1, frame);
  const view = new DataView(packet);

  assert.equal(view.getUint32(0x5c, true), 1);
  assert.equal(view.getUint32(0x60, true), 1);
  assert.equal(view.getUint32(0x68, true), 0);

  const empty = {
    ...frame,
    sourceX: 639,
    sourceY: 527,
  };
  const emptyPacket = context.packGxFramePacketV4(1, empty);
  const legacyEmpty = Buffer.from(packetBytes(emptyPacket));
  assert.equal(
    context.gxAttachTextureCopyLayoutV1(emptyPacket, 1, empty),
    emptyPacket,
  );
  assert.deepEqual(packetBytes(emptyPacket), legacyEmpty);

  const nonphysicalStride = { ...frame, stride: 1 };
  assert.throws(
    () => context.gxAttachTextureCopyLayoutV1(
      context.packGxFramePacketV4(1, nonphysicalStride),
      1,
      nonphysicalStride,
    ),
    /physical stride must be a shifted 24-bit BP4D value/,
  );
});

test("texture-copy layout leaves XFB packets byte-identical", () => {
  const context = packetContext();
  const frame = evidencedXfbFrame();
  const packet = context.packGxFramePacketV4(2, frame);
  const expected = Buffer.from(packetBytes(packet));

  assert.equal(context.gxAttachTextureCopyLayoutV1(packet, 2, frame), packet);
  assert.deepEqual(packetBytes(packet), expected);
});

test("appends canonical post-cull evidence without rewriting raw draw bytes", () => {
  const context = packetContext();
  const frame = evidencedXfbFrame();
  const packet = context.packGxFramePacketV4(2, frame);
  const bytes = new Uint8Array(packet);
  const view = new DataView(packet);

  assert.equal(packet.byteLength, 1248);
  assert.equal(view.getUint16(0x04, true), 4);
  assert.equal(bytes[160], 2);
  assert.equal(bytes[161], 0);
  assert.equal(view.getUint16(162, true), 1);
  assert.equal(view.getUint32(164, true), 3);
  assert.equal(view.getUint32(0x28, true), 800);
  assert.equal(view.getUint32(0x40, true), 432);
  assert.equal(view.getUint32(0x30, true), 1232);
  assert.equal(view.getUint32(0x48, true), 0);
  assert.equal(bytes[1232], 3);
  assert.deepEqual([...bytes.subarray(1233)], Array(15).fill(0));

  assert.throws(
    () => context.packGxFramePacketV4(2, {
      ...frame,
      geometry: {
        ...frame.geometry,
        draws: [{
          ...frame.geometry.draws[0],
          postCullEvidence: Uint8Array.of(0xff),
        }],
      },
    }),
    /nonzero high padding bits/,
  );
  assert.throws(
    () => context.packGxFramePacketV4(2, {
      ...frame,
      geometry: {
        ...frame.geometry,
        draws: [{
          ...frame.geometry.draws[0],
          postCullEvidence: Uint8Array.of(0),
        }],
      },
    }),
    /conflicts with cull mode 0/,
  );
  assert.throws(
    () => context.packGxFramePacketV4(2, {
      ...frame,
      geometry: {
        ...frame.geometry,
        draws: [{
          ...frame.geometry.draws[0],
          topology: 5,
        }],
      },
    }),
    /requires a nonempty triangle topology/,
  );
});

test("keeps packets without exact clip inputs byte-identical canonical v4", () => {
  const context = packetContext();
  const frame = evidencedXfbFrame();
  const expected = context.packGxFramePacketV4(2, frame);
  const actual = context.packGxFramePacketV5(2, frame);

  assert.equal(new DataView(actual).getUint16(0x04, true), 4);
  assert.deepEqual(packetBytes(actual), packetBytes(expected));
  assert.equal(
    digest(actual),
    "5bc15cc115d3691bf0d02ee68acd75e80dff990f2be4fefcb78aa900cc57f2f9",
  );
});

test("source-only exact clip metadata cannot change live v4 packet bytes", () => {
  const context = packetContext();
  const frame = exactClipXfbFrame();
  const withExact = context.packGxFramePacketV4(2, frame);
  delete frame.geometry.draws[0].exactClipInput;
  const withoutExact = context.packGxFramePacketV4(2, frame);

  assert.deepEqual(packetBytes(withExact), packetBytes(withoutExact));
});

test("appends one exact GX clip-input chunk in canonical LZGX v5 layout", () => {
  const context = packetContext();
  const frame = exactClipXfbFrame();
  const v4 = context.packGxFramePacketV4(2, frame);
  const packet = context.packGxFramePacketV5(2, frame);
  const bytes = new Uint8Array(packet);
  const view = new DataView(packet);
  const exactOffset = 1232;

  assert.equal(v4.byteLength, exactOffset);
  assert.equal(packet.byteLength, 1328);
  assert.equal(view.getUint16(0x04, true), 5);
  assert.equal(view.getUint32(0x08, true), 1328);
  assert.equal(view.getUint16(160 + 0x02, true), 2);
  assert.equal(view.getUint32(exactOffset + 0x00, true), 1);
  assert.equal(view.getUint32(exactOffset + 0x04, true), 0);
  assert.equal(
    view.getUint32(exactOffset + 0x08, true),
    (342 << 12) | 342,
  );
  assert.equal(
    view.getUint32(exactOffset + 0x0c, true),
    ((342 + 639) << 12) | (342 + 527),
  );
  assert.equal(
    view.getUint32(exactOffset + 0x10, true),
    171 | (171 << 10),
  );
  assert.equal(view.getUint32(exactOffset + 0x14, true), 0);
  assert.deepEqual(
    Array.from(
      { length: 6 },
      (_unused, index) => view.getFloat32(exactOffset + 0x18 + index * 4, true),
    ),
    [320, -264, 16777215, 342, 342, 0],
  );
  assert.deepEqual(
    Array.from(
      { length: 12 },
      (_unused, index) => view.getFloat32(exactOffset + 0x30 + index * 4, true),
    ),
    [0, 0, -0.5, 1, 2, 0, -0.5, 1, 0, 1, -0.5, 1],
  );
  const expectedPrefix = new Uint8Array(v4);
  expectedPrefix[0x04] = 5;
  expectedPrefix[0x08] = 0x30;
  expectedPrefix[0x09] = 0x05;
  expectedPrefix[160 + 0x02] = 2;
  assert.deepEqual(bytes.subarray(0, exactOffset), expectedPrefix);
});

test("mixed V5 keeps non-finite native STQ outside the exact sidecar", () => {
  const context = packetContext();
  const frame = exactClipXfbFrame();
  const exactDraw = frame.geometry.draws[0];
  const nativeVertices = new Float32Array(exactDraw.vertices);
  nativeVertices[12] = Number.NaN;
  nativeVertices[13] = Number.POSITIVE_INFINITY;
  const nativeDraw = {
    ...exactDraw,
    vertices: nativeVertices,
  };
  delete nativeDraw.exactClipInput;
  frame.geometry.draws.push(nativeDraw);
  frame.geometry.drawCalls = 2;
  frame.geometry.vertices = 6;

  const packet = context.packGxFramePacketV5(2, frame);
  const view = new DataView(packet);
  const nativeDrawOffset = 160 + 176;
  const vertexOffset = view.getUint32(0x28, true);
  const nativeVertexOffset =
    vertexOffset + view.getUint32(nativeDrawOffset + 0x08, true);

  assert.equal(view.getUint16(0x04, true), 5);
  assert.equal(view.getUint16(160 + 0x02, true), 2);
  assert.equal(view.getUint16(nativeDrawOffset + 0x02, true), 0);
  assert.equal(view.getUint32(nativeVertexOffset + 12 * 4, true), 0x7fc00000);
  assert.equal(view.getUint32(nativeVertexOffset + 13 * 4, true), 0x7f800000);
});

test("places legacy actions before aligned exact chunks in mixed LZGX v5", () => {
  const context = packetContext();
  const actionFrame = evidencedXfbFrame();
  const exactFrame = exactClipXfbFrame();
  const frame = {
    ...exactFrame,
    geometry: {
      drawCalls: 2,
      vertices: 6,
      draws: [
        exactFrame.geometry.draws[0],
        actionFrame.geometry.draws[0],
      ],
    },
  };
  const packet = context.packGxFramePacketV5(2, frame);
  const bytes = new Uint8Array(packet);
  const view = new DataView(packet);

  assert.equal(packet.byteLength, 2416);
  assert.equal(view.getUint16(0x04, true), 5);
  assert.equal(view.getUint16(160 + 0x02, true), 2);
  assert.equal(view.getUint16(160 + 176 + 0x02, true), 1);
  assert.equal(view.getUint32(0x30, true), 2304);
  assert.equal(view.getUint32(0x48, true), 0);
  assert.equal(bytes[2304], 3);
  assert.deepEqual([...bytes.subarray(2305, 2320)], Array(15).fill(0));
  assert.equal(view.getUint32(2320, true), 1);
  assert.deepEqual(
    Array.from(
      { length: 12 },
      (_unused, index) => view.getFloat32(2320 + 0x30 + index * 4, true),
    ),
    [0, 0, -0.5, 1, 2, 0, -0.5, 1, 0, 1, -0.5, 1],
  );
});

test("rejects conflicting or malformed LZGX v5 exact clip inputs", () => {
  const context = packetContext();
  const withExact = (mutate) => {
    const frame = exactClipXfbFrame();
    mutate(frame.geometry.draws[0], frame);
    return frame;
  };
  const reject = (mutate, pattern) => assert.throws(
    () => context.packGxFramePacketV5(2, withExact(mutate)),
    pattern,
  );

  reject(
    (draw) => { draw.postCullEvidence = Uint8Array.of(3); },
    /cannot carry both post-cull and exact-clip evidence/,
  );
  reject(
    (draw) => { draw.exactClipInput = "clip"; },
    /exactClipInput must be an object/,
  );
  reject(
    (draw) => { draw.exactClipInput.clipPositions = []; },
    /clipPositions must be a Float32Array/,
  );
  reject(
    (draw) => { draw.exactClipInput.clipPositions = new Float32Array(8); },
    /four f32 values per source vertex/,
  );
  reject(
    (draw) => { draw.exactClipInput.clipPositions[0] = Number.NaN; },
    /clipPositions must be finite/,
  );
  reject(
    (draw) => { draw.exactClipInput.viewport = new Float32Array(5); },
    /viewport must be a six-f32 Float32Array/,
  );
  reject(
    (draw) => { draw.exactClipInput.viewport[1] = 0; },
    /finite with nonzero X\/Y scales/,
  );
  reject(
    (draw) => { draw.exactClipInput.viewport[0] = 640; },
    /viewport X conflicts with the draw viewport/,
  );
  reject(
    (draw) => { draw.topology = 5; },
    /requires a nonempty triangle topology/,
  );
  reject(
    (draw) => { draw.exactClipInput.bpGenMode = 1 << 14; },
    /BP0 cull mode conflicts with the draw/,
  );
  reject(
    (draw) => { draw.exactClipInput.bpScissorTopLeft = 0x01000000; },
    /bpScissorTopLeft must be an integer/,
  );
  reject(
    (draw) => { draw.exactClipInput.xfClipDisable = 8; },
    /xfClipDisable must be an integer/,
  );
  reject(
    (draw) => { draw.vertices[0] = Number.NaN; },
    /requires finite source vertices/,
  );
});

test("negotiates LZGX v6 without changing canonical v4 or v5 bytes", () => {
  const context = packetContext();
  const legacyFrame = evidencedXfbFrame();
  legacyFrame.geometry.draws[0].exactGeometryRequired = false;
  const legacyV4 = context.packGxFramePacketV4(2, legacyFrame);
  const legacyV6 = context.packGxFramePacketV6(2, legacyFrame);
  assert.equal(new DataView(legacyV6).getUint16(0x04, true), 4);
  assert.deepEqual(packetBytes(legacyV6), packetBytes(legacyV4));

  const optionalFrame = exactClipXfbFrame();
  optionalFrame.geometry.draws[0].exactGeometryRequired = false;
  const optionalV5 = context.packGxFramePacketV5(2, optionalFrame);
  const optionalV6 = context.packGxFramePacketV6(2, optionalFrame);
  assert.equal(new DataView(optionalV6).getUint16(0x04, true), 5);
  assert.deepEqual(packetBytes(optionalV6), packetBytes(optionalV5));
});

test("LZGX v6 ignores decoded mip backing and serializes the exact level-0 view", () => {
  const context = packetContext();
  const frameWithMips = exactClipXfbFrame();
  frameWithMips.geometry.draws[0].exactGeometryRequired = true;
  frameWithMips.geometry.draws[0].tevState = tevState([0], 0);
  const mipPixels = Uint8Array.of(
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12,
  );
  const baseTexture = {
    key: "mip-v6-base",
    address: 0x00123000,
    textureCopyIndex: 17,
    width: 2,
    height: 1,
    wrapS: 1,
    wrapT: 2,
    magFilter: 1,
    minFilter: 5,
    maxAnisotropy: 2,
    pixels: mipPixels.subarray(0, 8),
  };
  frameWithMips.geometry.draws[0].textures = [{
    ...baseTexture,
    levelCount: 2,
    mipPixels,
    mipLevels: [
      { level: 0, width: 2, height: 1, pixels: mipPixels.subarray(0, 8) },
      { level: 1, width: 1, height: 1, pixels: mipPixels.subarray(8, 12) },
    ],
  }];

  const frameWithoutMips = exactClipXfbFrame();
  frameWithoutMips.geometry.draws[0].exactGeometryRequired = true;
  frameWithoutMips.geometry.draws[0].tevState = tevState([0], 0);
  frameWithoutMips.geometry.draws[0].textures = [{
    ...baseTexture,
    pixels: Uint8Array.from(baseTexture.pixels),
  }];

  const withMips = context.packGxFramePacketV6(2, frameWithMips);
  const withoutMips = context.packGxFramePacketV6(2, frameWithoutMips);
  assert.deepEqual(packetBytes(withMips), packetBytes(withoutMips));

  const view = new DataView(withMips);
  const textureOffset = view.getUint32(0x20, true);
  assert.equal(view.getUint16(0x04, true), 6);
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(textureOffset + 0x0c, true), 8);
  assert.equal(view.getUint32(0x48, true), 16);
});

test("marks required exact GX geometry in canonical LZGX v6", () => {
  const context = packetContext();
  const frame = exactClipXfbFrame();
  frame.geometry.draws[0].exactGeometryRequired = true;
  const optional = context.packGxFramePacketV5(2, frame);
  const packet = context.packGxFramePacketV6(2, frame);
  const bytes = new Uint8Array(packet);
  const optionalBytes = new Uint8Array(optional);
  const view = new DataView(packet);
  const exactOffset = 1232;

  assert.equal(packet.byteLength, 1328);
  assert.equal(view.getUint16(0x04, true), 6);
  assert.equal(view.getUint16(160 + 0x02, true), 6);
  assert.deepEqual(
    bytes.subarray(exactOffset),
    optionalBytes.subarray(exactOffset),
  );
  optionalBytes[0x04] = 6;
  optionalBytes[160 + 0x02] = 6;
  assert.deepEqual(bytes, optionalBytes);
  assert.equal(
    digest(packet),
    "639af8e9821bbc074e908375522947529831df955665d057c82e28ecb4e1d3e1",
  );

  const inheritedFrame = exactClipXfbFrame();
  inheritedFrame.geometry.draws[0].exactGeometryRequired = true;
  inheritedFrame.geometry.draws[0] = Object.create(
    inheritedFrame.geometry.draws[0],
  );
  const inherited = context.packGxFramePacketV6(2, inheritedFrame);
  assert.equal(new DataView(inherited).getUint16(0x04, true), 6);
  assert.equal(new DataView(inherited).getUint16(160 + 0x02, true), 6);
});

test("preserves 0, 1, 2, and 6 draw flags and exact-tail order in LZGX v6", () => {
  const context = packetContext();
  const rawFrame = evidencedXfbFrame();
  delete rawFrame.geometry.draws[0].postCullEvidence;
  const actionFrame = evidencedXfbFrame();
  const optionalFrame = exactClipXfbFrame();
  const requiredFrame = exactClipXfbFrame();
  requiredFrame.geometry.draws[0].exactGeometryRequired = true;
  requiredFrame.geometry.draws[0].exactClipInput.clipPositions[0] = 7;
  const frame = {
    ...requiredFrame,
    geometry: {
      drawCalls: 4,
      vertices: 12,
      draws: [
        rawFrame.geometry.draws[0],
        actionFrame.geometry.draws[0],
        optionalFrame.geometry.draws[0],
        requiredFrame.geometry.draws[0],
      ],
    },
  };
  const v4 = context.packGxFramePacketV4(2, frame);
  const packet = context.packGxFramePacketV6(2, frame);
  const view = new DataView(packet);
  const drawTableOffset = view.getUint32(0x1c, true);
  const drawRecordBytes = view.getUint16(0x78, true);
  const flags = Array.from(
    { length: 4 },
    (_unused, index) => view.getUint16(
      drawTableOffset + index * drawRecordBytes + 0x02,
      true,
    ),
  );

  assert.equal(view.getUint16(0x04, true), 6);
  assert.deepEqual(flags, [0, 1, 2, 6]);
  assert.equal(view.getFloat32(v4.byteLength + 0x30, true), 0);
  assert.equal(view.getFloat32(v4.byteLength + 96 + 0x30, true), 7);
});

test("rejects malformed or conflicting exact-required GX metadata", () => {
  const context = packetContext();
  const rejectExact = (required, pattern) => {
    const frame = exactClipXfbFrame();
    frame.geometry.draws[0].exactGeometryRequired = required;
    assert.throws(() => context.packGxFramePacketV6(2, frame), pattern);
  };

  rejectExact(null, /exactGeometryRequired must be a boolean/);
  rejectExact("required", /exactGeometryRequired must be a boolean/);

  const actionFrame = evidencedXfbFrame();
  actionFrame.geometry.draws[0].exactGeometryRequired = true;
  assert.throws(
    () => context.packGxFramePacketV6(2, actionFrame),
    /required exact geometry cannot carry post-cull evidence/,
  );

  const rawFrame = evidencedXfbFrame();
  delete rawFrame.geometry.draws[0].postCullEvidence;
  rawFrame.geometry.draws[0].exactGeometryRequired = true;
  assert.throws(
    () => context.packGxFramePacketV6(2, rawFrame),
    /exactGeometryRequired requires exactClipInput/,
  );
});

test("packs deterministic first-use texture tables and aligned payload sections", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  const first = context.packGxFramePacketV4(2, frame);
  const second = context.packGxFramePacketV4(2, representativeXfbFrame());
  const bytes = new Uint8Array(first);
  const view = new DataView(first);

  assert.deepEqual([...bytes.subarray(0, 4)], [0x4c, 0x5a, 0x47, 0x58]);
  assert.equal(view.getUint16(0x04, true), 4);
  assert.equal(view.getUint16(0x06, true), 160);
  assert.equal(view.getUint32(0x08, true), 2048);
  assert.equal(view.getUint32(0x10, true), 2);
  assert.equal(view.getUint32(0x14, true), 2);
  assert.equal(view.getUint32(0x18, true), 2);
  assert.equal(view.getUint32(0x1c, true), 160);
  assert.equal(view.getUint32(0x20, true), 512);
  assert.equal(view.getUint32(0x24, true), 640);
  assert.equal(view.getUint32(0x28, true), 1568);
  assert.equal(view.getUint32(0x2c, true), 2000);
  assert.equal(view.getUint32(0x30, true), 2016);
  assert.equal(view.getUint32(0x34, true), 352);
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
  assert.equal(view.getUint16(0x78, true), 176);
  assert.equal(view.getUint16(0x7a, true), 64);
  assert.equal(view.getUint32(0x7c, true), 3);
  assert.equal(view.getUint32(0x80, true), 0x010203);
  assert.equal(view.getUint32(0x84, true), 0x040506);
  assert.equal(view.getUint32(0x88, true), 0x070809);
  assert.equal(view.getUint32(0x8c, true), 0x004800);
  assert.equal(view.getUint32(0x90, true), 0x0a0b0c);
  assert.equal(view.getUint32(0x94, true), 0x0d0e0f);
  assert.equal(view.getUint32(0x98, true), 0x101112);
  assert.equal(view.getUint32(0x9c, true), 0x131415);

  const firstDraw = 160;
  assert.equal(bytes[firstDraw], 2);
  assert.equal(bytes[firstDraw + 1], 2);
  assert.equal(view.getUint32(firstDraw + 0x04, true), 2);
  assert.equal(view.getUint32(firstDraw + 0x08, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x0c, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x10, true), 0x010203);
  assert.equal(view.getUint32(firstDraw + 0x14, true), 0x040506);
  assert.equal(view.getUint32(firstDraw + 0x18, true), 0x070809);
  assert.equal(view.getUint32(firstDraw + 0x30, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x34, true), 0x001000b9);
  assert.equal(view.getUint32(firstDraw + 0x38, true), 0xffffffff);
  assert.equal(view.getUint32(firstDraw + 0x3c, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x40, true), 1);
  assert.equal(view.getUint32(firstDraw + 0x44, true), 0x001800e3);
  assert.equal(view.getUint32(firstDraw + 0x70, true), 0x111213);
  assert.equal(view.getUint32(firstDraw + 0x74, true), 0x141516);
  assert.equal(view.getUint32(firstDraw + 0x78, true), 0x171819);
  assert.equal(view.getUint32(firstDraw + 0x7c, true), 0x1a1b1c);
  assert.equal(view.getUint32(firstDraw + 0x80, true), 0x1d1e1f);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      view.getUint32(firstDraw + 0x84 + index * 4, true),
      [0x212223, 0x242526, 0x272829, 0x2a2b2c, 0x2d2e2f][index],
    );
    assert.equal(
      view.getUint32(firstDraw + 0x98 + index * 4, true),
      [0x313233, 0x343536, 0x373839, 0x3a3b3c, 0x3d3e3f][index],
    );
  }
  assert.equal(view.getUint32(firstDraw + 0xac, true), 0x43a00000);

  const secondDraw = 336;
  assert.equal(view.getUint32(secondDraw + 0x04, true), 1);
  assert.equal(view.getUint32(secondDraw + 0x08, true), 288);
  assert.equal(view.getUint32(secondDraw + 0x0c, true), 464);
  assert.equal(view.getUint32(secondDraw + 0x10, true), 0x111213);
  assert.equal(view.getUint32(secondDraw + 0x14, true), 0x141516);
  assert.equal(view.getUint32(secondDraw + 0x18, true), 0x171819);
  assert.equal(view.getUint32(secondDraw + 0x30, true), 0xffffffff);
  assert.equal(view.getUint32(secondDraw + 0x38, true), 0);
  assert.equal(view.getUint32(secondDraw + 0x3c, true), 0x0008002e);
  assert.equal(view.getUint32(secondDraw + 0x70, true), 0x414243);
  assert.equal(view.getUint32(secondDraw + 0xac, true), 0x43b40000);

  const firstTexture = 512;
  assert.equal(view.getUint32(firstTexture + 0x00, true), 0);
  assert.equal(view.getUint32(firstTexture + 0x04, true), 5);
  assert.equal(view.getUint32(firstTexture + 0x08, true), 0);
  assert.equal(view.getUint32(firstTexture + 0x0c, true), 8);
  assert.equal(view.getUint32(firstTexture + 0x10, true), 0x10203040);
  assert.equal(view.getUint32(firstTexture + 0x14, true), 9);
  assert.equal(view.getUint32(firstTexture + 0x18, true), 2);
  assert.equal(view.getUint32(firstTexture + 0x1c, true), 1);
  assert.equal(view.getUint32(firstTexture + 0x20, true), 1);
  const secondTexture = 576;
  assert.equal(view.getUint32(secondTexture + 0x00, true), 5);
  assert.equal(view.getUint32(secondTexture + 0x04, true), 2);
  assert.equal(view.getUint32(secondTexture + 0x08, true), 16);
  assert.equal(view.getUint32(secondTexture + 0x0c, true), 4);
  assert.equal(view.getUint32(secondTexture + 0x10, true), 0x50607080);
  assert.equal(view.getUint32(secondTexture + 0x14, true), 10);
  assert.equal(view.getUint32(secondTexture + 0x18, true), 1);
  assert.equal(view.getUint32(secondTexture + 0x1c, true), 1);
  assert.equal(view.getUint32(secondTexture + 0x20, true), 1);

  assert.equal(view.getUint32(1568, true), 0xc0080000);
  assert.equal(view.getUint32(1568 + 288, true), 0x42000000);

  assert.equal(new TextDecoder().decode(bytes.subarray(2000, 2007)), "alphaβ");
  assert.deepEqual([...bytes.subarray(2007, 2016)], Array(9).fill(0));
  assert.deepEqual([...bytes.subarray(2016, 2024)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...bytes.subarray(2024, 2032)], Array(8).fill(0));
  assert.deepEqual([...bytes.subarray(2032, 2036)], [0xfa, 0xfb, 0xfc, 0xfd]);
  assert.deepEqual([...bytes.subarray(2036, 2048)], Array(12).fill(0));
  assert.deepEqual(packetBytes(first), packetBytes(second));
  assert.equal(
    digest(first),
    "dd6ee1a23d0f0dd23e762b5b7a71de3f2a66360adb04e2fc7f9cc2abf0090916",
  );
  assert.equal(fnv1a64(first), "5241754f97893d94");
});

test("rejects conflicting content for one frame-local texture key", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  frame.geometry.draws[1].textures[1].pixels[0] ^= 0xff;
  assert.throws(
    () => context.packGxFramePacketV4(2, frame),
    /texture key "alpha" has conflicting contents/,
  );

  const metadataConflict = representativeXfbFrame();
  metadataConflict.geometry.draws[1].textures[1].address += 1;
  assert.throws(
    () => context.packGxFramePacketV4(2, metadataConflict),
    /texture key "alpha" has conflicting contents/,
  );
});

test("rejects malformed or non-canonical packet inputs", () => {
  const context = packetContext();

  const exactXfbLimit = representativeXfbFrame();
  exactXfbLimit.width = 1024;
  exactXfbLimit.height = 1024;
  assert.doesNotThrow(() => context.packGxFramePacketV4(2, exactXfbLimit));

  for (const field of ["width", "height"]) {
    const oversizedXfb = representativeXfbFrame();
    oversizedXfb[field] = 1025;
    assert.throws(
      () => context.packGxFramePacketV4(2, oversizedXfb),
      new RegExp(`frame\\.output${field === "width" ? "Width" : "Height"} must be an integer from 0 through 1024`),
    );
  }

  assert.throws(
    () => context.packGxFramePacketV4(3, emptyTextureFrame()),
    /frame\.stride must be an integer from 0 through 2|EFB peek terminal is noncanonical/,
  );

  const unsafeGeneration = emptyTextureFrame();
  unsafeGeneration.index = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => context.packGxFramePacketV4(1, unsafeGeneration),
    /frame.index must be an integer/,
  );

  const oversizedBpWord = emptyTextureFrame();
  oversizedBpWord.copyState.zMode = 0x01000000;
  assert.throws(
    () => context.packGxFramePacketV4(1, oversizedBpWord),
    /copyState.zMode must be an integer from 0 through 16777215/,
  );

  const oversizedFragmentBpWord = representativeXfbFrame();
  oversizedFragmentBpWord.geometry.draws[0].pipeline.fogWords[3] = 0x01000000;
  assert.throws(
    () => context.packGxFramePacketV4(2, oversizedFragmentBpWord),
    /fogWords\[3\] must be an integer from 0 through 16777215/,
  );

  for (const field of ["zMode", "blendMode", "alphaTest"]) {
    const oversizedDrawBpWord = representativeXfbFrame();
    oversizedDrawBpWord.geometry.draws[0].pipeline[field] = 0x01000000;
    assert.throws(
      () => context.packGxFramePacketV4(2, oversizedDrawBpWord),
      new RegExp(`${field} must be an integer from 0 through 16777215`),
    );
  }

  for (const viewportBits of [0x00000000, 0x80000000, 0x7f800000, 0x7fc12345]) {
    const invalidFogViewport = representativeXfbFrame();
    invalidFogViewport.geometry.draws[0].pipeline.fogRangeBase |= 1 << 10;
    invalidFogViewport.geometry.draws[0].pipeline.viewportHalfWidthBits = viewportBits;
    assert.throws(
      () => context.packGxFramePacketV4(2, invalidFogViewport),
      /viewportHalfWidthBits must encode a finite nonzero f32/,
    );
  }

  const malformedFilter = emptyTextureFrame();
  malformedFilter.copyState.copyFilter = [0];
  assert.throws(
    () => context.packGxFramePacketV4(1, malformedFilter),
    /copyState.copyFilter must have two registers/,
  );

  const clearConflict = emptyTextureFrame();
  clearConflict.copyState.copyCommand = 0;
  assert.throws(
    () => context.packGxFramePacketV4(1, clearConflict),
    /clear flag conflicts with copy command/,
  );

  const kindConflict = emptyTextureFrame();
  kindConflict.copyState.copyCommand |= 0x4000;
  assert.throws(
    () => context.packGxFramePacketV4(1, kindConflict),
    /copyKind conflicts with copy command/,
  );

  const wrongVertexBytes = representativeXfbFrame();
  wrongVertexBytes.geometry.draws[0].vertices = new Float32Array(35);
  assert.throws(
    () => context.packGxFramePacketV4(2, wrongVertexBytes),
    /144 bytes per vertex/,
  );

  const wrongTevBytes = representativeXfbFrame();
  wrongTevBytes.geometry.draws[0].tevState = new Uint8Array(463);
  assert.throws(
    () => context.packGxFramePacketV4(2, wrongTevBytes),
    /tevState must be 464 bytes/,
  );

  const nonzeroTevPadding = representativeXfbFrame();
  nonzeroTevPadding.geometry.draws[0].tevState[452] = 1;
  assert.throws(
    () => context.packGxFramePacketV4(2, nonzeroTevPadding),
    /tevState has nonzero padding/,
  );

  const nonzeroInactiveStage = representativeXfbFrame();
  nonzeroInactiveStage.geometry.draws[0].tevState[32] = 1;
  assert.throws(
    () => context.packGxFramePacketV4(2, nonzeroInactiveStage),
    /tevState has nonzero inactive stages/,
  );

  const invalidSwapChannel = representativeXfbFrame();
  new DataView(invalidSwapChannel.geometry.draws[0].tevState.buffer)
    .setUint32(384, 4, true);
  assert.throws(
    () => context.packGxFramePacketV4(2, invalidSwapChannel),
    /tevState has invalid swap-table channels/,
  );

  const wrongPixelBytes = representativeXfbFrame();
  wrongPixelBytes.geometry.draws[0].textures[0].pixels = new Uint8Array(7);
  assert.throws(
    () => context.packGxFramePacketV4(2, wrongPixelBytes),
    /pixels must be empty or width \* height \* 4 bytes/,
  );

  const oversizedTexture = representativeXfbFrame();
  oversizedTexture.geometry.draws[0].textures[0].width = 1025;
  oversizedTexture.geometry.draws[1].textures[1].width = 1025;
  assert.throws(
    () => context.packGxFramePacketV4(2, oversizedTexture),
    /width must be an integer from 0 through 1024/,
  );

  const tooManyTextureSlots = representativeXfbFrame();
  tooManyTextureSlots.geometry.draws[0].textures = Array(9).fill(null);
  assert.throws(
    () => context.packGxFramePacketV4(2, tooManyTextureSlots),
    /textures must have at most 8 slots/,
  );

  const zeroSourceWidth = emptyTextureFrame();
  zeroSourceWidth.width = 0;
  assert.throws(
    () => context.packGxFramePacketV4(1, zeroSourceWidth),
    /source dimensions must be nonzero/,
  );

  const missingRequiredTexture = representativeXfbFrame();
  missingRequiredTexture.geometry.draws[0].textures[2] = null;
  assert.throws(
    () => context.packGxFramePacketV4(2, missingRequiredTexture),
    /TEV stage 1 requires missing texture map 2/,
  );

  const malformedKey = representativeXfbFrame();
  malformedKey.geometry.draws[0].textures[0].key = "bad\ud800";
  assert.throws(
    () => context.packGxFramePacketV4(2, malformedKey),
    /unpaired surrogate/,
  );
});

test("canonicalizes NaN vertices to one little-endian f32 encoding", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  frame.geometry.draws[0].vertices[0] = Number.NaN;
  const packet = context.packGxFramePacketV4(2, frame);

  assert.equal(new DataView(packet).getUint32(1568, true), 0x7fc00000);
});

test("preserves arbitrary viewport bits when fog range adjustment is disabled", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  frame.geometry.draws[0].pipeline.fogRangeBase &= ~(1 << 10);
  frame.geometry.draws[0].pipeline.viewportHalfWidthBits = 0x7fc12345;
  const packet = context.packGxFramePacketV4(2, frame);

  assert.equal(new DataView(packet).getUint32(160 + 0xac, true), 0x7fc12345);
});

test("encodes a legal resident texture reference without a pixel payload", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  const resident = frame.geometry.draws[0].textures[0];
  resident.pixels = undefined;
  frame.geometry.draws[1].textures[1].pixels = undefined;
  const packet = context.packGxFramePacketV4(2, frame);
  const view = new DataView(packet);

  assert.equal(view.getUint32(512 + 0x08, true), 0);
  assert.equal(view.getUint32(512 + 0x0c, true), 0);
  assert.equal(view.getUint32(512 + 0x20, true), 0);
  assert.equal(view.getUint32(576 + 0x08, true), 0);
  assert.equal(view.getUint32(576 + 0x0c, true), 4);
  assert.equal(view.getUint32(576 + 0x20, true), 1);
});

test("omits acknowledged resident payloads across GX frames", () => {
  const context = packetContext();
  const frame = representativeXfbFrame();
  const packet = context.packGxFramePacketV4(
    2,
    frame,
    new Set(["alpha", "β"]),
  );
  const view = new DataView(packet);

  assert.equal(packet.byteLength, 2016);
  assert.equal(view.getUint32(0x48, true), 0);
  assert.equal(view.getUint32(512 + 0x0c, true), 0);
  assert.equal(view.getUint32(512 + 0x20, true), 0);
  assert.equal(view.getUint32(576 + 0x0c, true), 0);
  assert.equal(view.getUint32(576 + 0x20, true), 0);
});

test("uses XF NUMTEXGENS instead of the unrelated BP GEN_MODE low nibble", () => {
  const context = packetContext();
  const stages = [{
    index: 0,
    textureEnabled: true,
    textureMap: 0,
    texCoordIndex: 0,
  }];
  const indirectTev = {
    genMode: 0x10,
    xfNumTexGens: 1,
    commands: Array(16).fill(0),
    iref: 0,
  };

  assert.deepEqual(
    Array.from(
      context.gxTevResourceDependencies(stages, indirectTev),
      dependency => ({
        kind: dependency.kind,
        stageIndex: dependency.stageIndex,
        textureMap: dependency.textureMap,
        requestedTexCoordIndex: dependency.requestedTexCoordIndex,
        texCoordIndex: dependency.texCoordIndex,
      }),
    ),
    [{
      kind: "direct",
      stageIndex: 0,
      textureMap: 0,
      requestedTexCoordIndex: 0,
      texCoordIndex: 0,
    }],
  );
  assert.deepEqual(
    Array.from(
      context.gxTevResourceDependencies(stages, {
        ...indirectTev,
        xfNumTexGens: 0,
      }),
    ),
    [],
  );
  assert.equal(indirectTev.genMode, 0x10, "raw BP GEN_MODE remains unchanged");
});

test("unions direct and active IREF texture and texcoord dependencies", () => {
  const context = packetContext();
  const stages = [
    {
      index: 0,
      textureEnabled: true,
      textureMap: 7,
      texCoordIndex: 6,
    },
    {
      index: 1,
      textureEnabled: false,
      textureMap: 5,
      texCoordIndex: 5,
    },
    {
      index: 2,
      textureEnabled: false,
      textureMap: 4,
      texCoordIndex: 4,
    },
    {
      index: 3,
      textureEnabled: false,
      textureMap: 3,
      texCoordIndex: 3,
    },
  ];
  const commands = Array(16).fill(0);
  commands[0] = 1 << 7; // BT=0, bump S: raw IREF zero is map 0 / coord 0.
  commands[1] = 1 | (1 << 9); // BT=1, matrix 0.
  commands[2] = (6 << 13) | (1 << 20); // Wrap zero + addprev only.
  commands[3] = 2 | (1 << 7); // BT=2 is outside NUMINDSTAGES=2.
  const stageOneReference = 3 | (6 << 3);
  const dependencies = context.gxTevResourceDependencies(stages, {
    genMode: 2 | (2 << 16),
    commands,
    iref: stageOneReference << 6,
  });

  assert.deepEqual(
    Array.from(dependencies, dependency => ({
      kind: dependency.kind,
      stageIndex: dependency.stageIndex,
      indirectStageIndex: dependency.indirectStageIndex ?? null,
      textureMap: dependency.textureMap,
      requestedTexCoordIndex: dependency.requestedTexCoordIndex,
      texCoordIndex: dependency.texCoordIndex,
    })),
    [
      {
        kind: "direct",
        stageIndex: 0,
        indirectStageIndex: null,
        textureMap: 7,
        requestedTexCoordIndex: 6,
        texCoordIndex: 0,
      },
      {
        kind: "indirect",
        stageIndex: 0,
        indirectStageIndex: 0,
        textureMap: 0,
        requestedTexCoordIndex: 0,
        texCoordIndex: 0,
      },
      {
        kind: "command",
        stageIndex: 1,
        indirectStageIndex: null,
        textureMap: null,
        requestedTexCoordIndex: 5,
        texCoordIndex: 0,
      },
      {
        kind: "indirect",
        stageIndex: 1,
        indirectStageIndex: 1,
        textureMap: 3,
        requestedTexCoordIndex: 6,
        texCoordIndex: 0,
      },
      {
        kind: "command",
        stageIndex: 2,
        indirectStageIndex: null,
        textureMap: null,
        requestedTexCoordIndex: 4,
        texCoordIndex: 0,
      },
      {
        kind: "command",
        stageIndex: 3,
        indirectStageIndex: null,
        textureMap: null,
        requestedTexCoordIndex: 3,
        texCoordIndex: 0,
      },
    ],
  );

  assert.deepEqual(
    Array.from(
      context.gxTevResourceDependencies(
        [{ index: 0, textureEnabled: false, textureMap: 0, texCoordIndex: 0 }],
        {
          genMode: 0,
          commands: [(6 << 13) | (1 << 20)],
          iref: 0,
        },
      ),
      dependency => ({
        kind: dependency.kind,
        textureMap: dependency.textureMap,
        texCoordIndex: dependency.texCoordIndex,
      }),
    ),
    [{ kind: "command", textureMap: null, texCoordIndex: null }],
    "NUMTEXGENS=0 synthesizes the base coord without sampling map zero",
  );

  const zeroGeneratorSample = Array(16).fill(0);
  zeroGeneratorSample[0] = 1 << 7;
  assert.deepEqual(
    Array.from(
      context.gxTevResourceDependencies(
        [{ index: 0, textureEnabled: true, textureMap: 4, texCoordIndex: 7 }],
        {
          genMode: 1 << 16,
          commands: zeroGeneratorSample,
          iref: 0,
        },
      ),
      dependency => ({
        kind: dependency.kind,
        textureMap: dependency.textureMap,
        texCoordIndex: dependency.texCoordIndex,
      }),
    ),
    [{ kind: "indirect", textureMap: 0, texCoordIndex: null }],
    "NUMTEXGENS=0 suppresses direct map 4 while retaining indirect IREF map 0",
  );

  const addPrevious = Array(16).fill(0);
  addPrevious[1] = (6 << 13) | (1 << 20);
  assert.deepEqual(
    Array.from(
      context.gxTevResourceDependencies(
        [
          { index: 0, textureEnabled: false, textureMap: 0, texCoordIndex: 7 },
          { index: 1, textureEnabled: false, textureMap: 0, texCoordIndex: 3 },
        ],
        { genMode: 8 | (1 << 10), commands: addPrevious, iref: 0 },
      ),
      dependency => ({
        stageIndex: dependency.stageIndex,
        kind: dependency.kind,
        textureMap: dependency.textureMap,
        texCoordIndex: dependency.texCoordIndex,
      }),
    ),
    [
      { stageIndex: 0, kind: "command", textureMap: null, texCoordIndex: 7 },
      { stageIndex: 1, kind: "command", textureMap: null, texCoordIndex: 3 },
    ],
    "raw-zero reset predecessors remain available to later ADDPREV stages",
  );
});

test("decodes indirect-only IREF maps once in the fixed GX binding slots", () => {
  const context = packetContext();
  const textureHashBatch = { ordinal: 9 };
  const decoded = [];
  context.gxDecodeTexture = (textureMap, batch) => {
    decoded.push({ textureMap, batch });
    return { key: `map-${textureMap}` };
  };
  const stages = [{
    index: 0,
    textureEnabled: true,
    textureMap: 5,
    texCoordIndex: 0,
  }];
  const commands = Array(16).fill(0);
  commands[0] = 1 << 7;
  const textures = context.gxTevTextures(
    stages,
    {
      genMode: 1 | (1 << 16),
      commands,
      iref: 0,
    },
    textureHashBatch,
  );

  assert.deepEqual(decoded.map(call => call.textureMap), [5, 0]);
  assert.ok(decoded.every(call => call.batch === textureHashBatch));
  assert.equal(textures[0].key, "map-0");
  assert.equal(textures[5].key, "map-5");
  assert.equal(textures.filter(Boolean).length, 2);
});

test("packet validation accepts raw IREF zero as an indirect-only map-0 binding", () => {
  const context = packetContext();
  const frame = evidencedXfbFrame();
  const draw = frame.geometry.draws[0];
  setTevStageCount(draw, 1);
  const commands = Array(16).fill(0);
  commands[0] = 1 << 7;
  draw.pipeline.indirectTev = {
    ...zeroIndirectTevState(),
    genMode: 1 << 16,
    commands,
    iref: 0,
  };
  draw.textures = [{
    key: "iref-zero-map-zero",
    width: 1,
    height: 1,
    pixels: Uint8Array.of(9, 8, 7, 6),
  }];

  const packet = context.packGxFramePacketV4(2, frame);
  const view = new DataView(packet);
  const drawOffset = view.getUint32(0x1c, true);
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(drawOffset + 0x30, true), 0);

  draw.textures = [];
  assert.throws(
    () => context.packGxFramePacketV4(2, frame),
    /TEV stage 0 indirect stage 0 requires missing texture map 0/,
  );
});

test("appends fixed indirect TEV BP tails without changing the 464-byte ABI", () => {
  const context = packetContext();
  const frame = evidencedXfbFrame();
  const first = frame.geometry.draws[0];
  const second = {
    ...first,
    vertices: first.vertices.slice(),
    tevState: first.tevState.slice(),
    postCullEvidence: first.postCullEvidence.slice(),
    pipeline: { ...first.pipeline },
  };
  frame.geometry.draws.push(second);
  frame.geometry.drawCalls = 2;
  frame.geometry.vertices = 6;
  setTevStageCount(first, 1);
  setTevStageCount(second, 1);
  first.pipeline.indirectTev = indirectTevState(0x10203, 3);
  first.pipeline.indirectTev.genMode = 0x10 | (3 << 16);
  second.pipeline.indirectTev = indirectTevState(0x40506, 0);
  // Stage zero selects indirect stage one, whose raw IREF entry names map 0.
  // The producer must carry that binding even though direct TEV texturing is
  // disabled in the 464-byte state.
  first.textures = [{
    key: "indirect-map-0",
    width: 1,
    height: 1,
    pixels: Uint8Array.of(1, 2, 3, 4),
  }];

  const base = context.packGxFramePacketV4(2, frame);
  const packet = context.gxAttachIndirectTevStateV1(base, frame);
  const bytes = new Uint8Array(packet);
  const baseBytes = new Uint8Array(base);
  const view = new DataView(packet);
  const baseView = new DataView(base);
  const tailOffset = base.byteLength;

  assert.equal(packet.byteLength, base.byteLength + 2 * 128);
  assert.equal(view.getUint32(0x08, true), packet.byteLength);
  assert.equal(view.getUint32(0x0c, true), 2);
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(0x3c, true), 2 * 464);
  assert.equal(
    view.getUint32(view.getUint32(0x1c, true) + 176 + 0x0c, true),
    464,
  );
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), Array.from(baseBytes.subarray(0, 8)));
  assert.deepEqual(
    Array.from(bytes.subarray(16, base.byteLength)),
    Array.from(baseBytes.subarray(16)),
  );
  const tevOffset = baseView.getUint32(0x24, true);
  assert.deepEqual(
    Array.from(bytes.subarray(tevOffset, tevOffset + 2 * 464)),
    Array.from(baseBytes.subarray(tevOffset, tevOffset + 2 * 464)),
  );

  for (const [drawIndex, expected] of [
    [0, first.pipeline.indirectTev],
    [1, second.pipeline.indirectTev],
  ]) {
    const offset = tailOffset + drawIndex * 128;
    assert.equal(view.getUint32(offset + 0x00, true), 2);
    assert.equal(view.getUint32(offset + 0x04, true), expected.genMode);
    assert.deepEqual(
      Array.from({ length: 9 }, (_unused, index) =>
        view.getUint32(offset + 0x08 + index * 4, true)
      ),
      expected.matrices,
    );
    assert.equal(view.getUint32(offset + 0x2c, true), expected.imask);
    assert.deepEqual(
      Array.from({ length: 16 }, (_unused, index) =>
        view.getUint32(offset + 0x30 + index * 4, true)
      ),
      expected.commands,
    );
    assert.deepEqual(
      [0x70, 0x74].map(offsetInTail =>
        view.getUint32(offset + offsetInTail, true)
      ),
      expected.texScales,
    );
    assert.equal(view.getUint32(offset + 0x78, true), expected.iref);
    assert.equal(
      view.getUint32(offset + 0x7c, true),
      expected.xfNumTexGens,
    );
  }
});

test("indirect TEV packet feature is optional, validated, and composable", () => {
  const context = packetContext();
  const inactive = evidencedXfbFrame();
  inactive.geometry.draws[0].pipeline.indirectTev = {
    ...zeroIndirectTevState(),
    // IREF zero is map zero / coordinate zero, not an absence sentinel. With
    // a nonzero texgen count, neither an indirect count nor a live command,
    // and no live direct stage, the dormant state is inert.
    genMode: 1,
    xfNumTexGens: 1,
  };
  const inactivePacket = context.packGxFramePacketV4(2, inactive);
  assert.equal(
    context.gxAttachIndirectTevStateV1(inactivePacket, inactive),
    inactivePacket,
  );

  const reservedOnly = evidencedXfbFrame();
  setTevStageCount(reservedOnly.geometry.draws[0], 1);
  reservedOnly.geometry.draws[0].pipeline.indirectTev = {
    ...zeroIndirectTevState(),
    genMode: 1,
    xfNumTexGens: 1,
    commands: [0x00e00000, ...Array(15).fill(0)],
  };
  const reservedOnlyPacket = context.packGxFramePacketV4(2, reservedOnly);
  assert.equal(
    context.gxAttachIndirectTevStateV1(reservedOnlyPacket, reservedOnly),
    reservedOnlyPacket,
    "IND_CMD bits 21 through 23 do not activate the transport tail",
  );

  const directGenMode = evidencedXfbFrame();
  const directGenModeDraw = directGenMode.geometry.draws[0];
  setTevStageCount(directGenModeDraw, 1);
  new DataView(
    directGenModeDraw.tevState.buffer,
    directGenModeDraw.tevState.byteOffset,
    directGenModeDraw.tevState.byteLength,
  ).setUint32(8, (1 << 6) | (7 << 3) | 4, true);
  directGenModeDraw.pipeline.indirectTev = zeroIndirectTevState();
  const directGenModeBase = context.packGxFramePacketV4(2, directGenMode);
  const directGenModePacket = context.gxAttachIndirectTevStateV1(
    directGenModeBase,
    directGenMode,
  );
  assert.equal(new DataView(directGenModeBase).getUint32(0x18, true), 0);
  assert.equal(directGenModePacket.byteLength, directGenModeBase.byteLength + 128);
  assert.equal(new DataView(directGenModePacket).getUint32(0x0c, true), 2);

  const zeroTexGensDisabledOrder = evidencedXfbFrame();
  const zeroTexGensDisabledDraw = zeroTexGensDisabledOrder.geometry.draws[0];
  setTevStageCount(zeroTexGensDisabledDraw, 1);
  const zeroTexGensDisabledTev = new DataView(
    zeroTexGensDisabledDraw.tevState.buffer,
    zeroTexGensDisabledDraw.tevState.byteOffset,
    zeroTexGensDisabledDraw.tevState.byteLength,
  );
  zeroTexGensDisabledTev.setUint32(0x00, 8 << 12, true); // TEXC input.
  zeroTexGensDisabledTev.setUint32(0x04, 4 << 13, true); // TEXA input.
  zeroTexGensDisabledTev.setUint32(0x08, 0, true); // Texture order disabled.
  zeroTexGensDisabledDraw.pipeline.indirectTev = zeroIndirectTevState();
  const zeroTexGensDisabledBase = context.packGxFramePacketV4(
    2,
    zeroTexGensDisabledOrder,
  );
  const zeroTexGensDisabledPacket = context.gxAttachIndirectTevStateV1(
    zeroTexGensDisabledBase,
    zeroTexGensDisabledOrder,
  );
  const zeroTexGensDisabledView = new DataView(zeroTexGensDisabledPacket);
  assert.equal(zeroTexGensDisabledView.getUint32(0x18, true), 0);
  assert.equal(
    zeroTexGensDisabledPacket.byteLength,
    zeroTexGensDisabledBase.byteLength + 128,
    "NUMTEXGENS=0 carries GEN_MODE for black TEXC/TEXA with disabled order",
  );
  assert.equal(zeroTexGensDisabledView.getUint32(0x0c, true), 2);
  assert.equal(
    zeroTexGensDisabledView.getUint32(zeroTexGensDisabledBase.byteLength + 0x04, true),
    0,
  );

  const commandOnly = evidencedXfbFrame();
  setTevStageCount(commandOnly.geometry.draws[0], 1);
  commandOnly.geometry.draws[0].pipeline.indirectTev = {
    ...zeroIndirectTevState(),
    genMode: 0,
    commands: Array.from(
      { length: 16 },
      (_unused, index) => index === 0 ? 6 << 13 : 0,
    ),
  };
  const commandOnlyBase = context.packGxFramePacketV4(2, commandOnly);
  const commandOnlyPacket = context.gxAttachIndirectTevStateV1(
    commandOnlyBase,
    commandOnly,
  );
  const commandOnlyView = new DataView(commandOnlyPacket);
  assert.equal(commandOnlyView.getUint32(0x0c, true), 2);
  assert.equal(
    commandOnlyView.getUint32(commandOnlyBase.byteLength + 0x04, true),
    0,
  );
  assert.equal(
    commandOnlyView.getUint32(commandOnlyBase.byteLength + 0x30, true),
    6 << 13,
  );
  assert.equal(commandOnlyView.getUint32(commandOnlyBase.byteLength + 0x78, true), 0);

  const staleCommand = evidencedXfbFrame();
  setTevStageCount(staleCommand.geometry.draws[0], 1);
  staleCommand.geometry.draws[0].pipeline.indirectTev = {
    ...zeroIndirectTevState(),
    genMode: 1,
    xfNumTexGens: 1,
    commands: Array.from(
      { length: 16 },
      (_unused, index) => index === 7 ? 6 << 13 : 0,
    ),
  };
  const staleCommandPacket = context.packGxFramePacketV4(2, staleCommand);
  assert.equal(
    context.gxAttachIndirectTevStateV1(staleCommandPacket, staleCommand),
    staleCommandPacket,
  );

  const malformed = evidencedXfbFrame();
  setTevStageCount(malformed.geometry.draws[0], 1);
  malformed.geometry.draws[0].pipeline.indirectTev = indirectTevState(0, 1);
  malformed.geometry.draws[0].pipeline.indirectTev.commands[7] = 0x01000000;
  const malformedPacket = context.packGxFramePacketV4(2, malformed);
  assert.throws(
    () => context.gxAttachIndirectTevStateV1(malformedPacket, malformed),
    /commands\[7\].*0 through 16777215/,
  );

  for (const [name, mutate, pattern] of [
    [
      "stage count",
      state => { state.genMode |= 1 << 10; },
      /GEN_MODE TEV stage count.*direct TEV state/,
    ],
    [
      "cull mode",
      state => { state.genMode |= 1 << 14; },
      /GEN_MODE cull mode.*draw/,
    ],
  ]) {
    const contradictory = evidencedXfbFrame();
    setTevStageCount(contradictory.geometry.draws[0], 1);
    const state = indirectTevState(0, 1);
    mutate(state);
    contradictory.geometry.draws[0].pipeline.indirectTev = state;
    const contradictoryPacket = context.packGxFramePacketV4(2, contradictory);
    assert.throws(
      () => context.gxAttachIndirectTevStateV1(
        contradictoryPacket,
        contradictory,
      ),
      pattern,
      name,
    );
  }

  const exactMismatch = exactClipXfbFrame();
  setTevStageCount(exactMismatch.geometry.draws[0], 1);
  exactMismatch.geometry.draws[0].pipeline.indirectTev = indirectTevState(0, 1);
  const exactMismatchPacket = context.packGxFramePacketV6(2, exactMismatch);
  assert.throws(
    () => context.gxAttachIndirectTevStateV1(
      exactMismatchPacket,
      exactMismatch,
    ),
    /GEN_MODE conflicts with.*exact-clip BP generation mode/,
  );

  const textureFrame = emptyTextureFrame();
  const draw = evidencedXfbFrame().geometry.draws[0];
  setTevStageCount(draw, 1);
  draw.pipeline.indirectTev = indirectTevState(0x223344, 1);
  textureFrame.stride = 64;
  textureFrame.geometry = {
    drawCalls: 1,
    vertices: 3,
    draws: [draw],
  };
  const base = context.packGxFramePacketV4(1, textureFrame);
  const textureLayout = context.gxAttachTextureCopyLayoutV1(
    base,
    1,
    textureFrame,
  );
  const composed = context.gxAttachIndirectTevStateV1(
    textureLayout,
    textureFrame,
  );
  assert.equal(new DataView(textureLayout).getUint32(0x0c, true), 1);
  assert.equal(new DataView(composed).getUint32(0x0c, true), 3);
  assert.equal(composed.byteLength, textureLayout.byteLength + 128);
});

test("captures every indirect TEV producer register without stale unsupported telemetry", () => {
  const gxBpRegisters = new Uint32Array(256);
  const gxXfRegisters = new Uint32Array(0x1100);
  gxBpRegisters[0x00] = (5 << 16) | (2 << 14);
  for (let index = 0; index < 9; index += 1) {
    gxBpRegisters[0x06 + index] = 0x010000 + index;
  }
  gxBpRegisters[0x0f] = 0x020304;
  for (let index = 0; index < 16; index += 1) {
    gxBpRegisters[0x10 + index] = 0x030000 + index;
  }
  gxBpRegisters[0x25] = 0x040506;
  gxBpRegisters[0x26] = 0x070809;
  gxBpRegisters[0x27] = 0x0a0b0c;
  gxXfRegisters[0x103f] = 6;
  const context = { Array, Math, gxBpRegisters, gxXfRegisters };
  vm.createContext(context);
  vm.runInContext(extractFunction("gxDrawPipelineState"), context);

  const captured = context.gxDrawPipelineState().indirectTev;
  assert.equal(captured.genMode, (5 << 16) | (2 << 14));
  assert.equal(captured.xfNumTexGens, 6);
  assert.equal((captured.genMode >>> 16) & 7, 5);
  assert.deepEqual(
    Array.from(captured.matrices),
    Array.from({ length: 9 }, (_unused, index) => 0x010000 + index),
  );
  assert.equal(captured.imask, 0x020304);
  assert.deepEqual(
    Array.from(captured.commands),
    Array.from({ length: 16 }, (_unused, index) => 0x030000 + index),
  );
  assert.deepEqual(Array.from(captured.texScales), [0x040506, 0x070809]);
  assert.equal(captured.iref, 0x0a0b0c);
  assert.doesNotMatch(
    extractFunction("recordGxPrimitive"),
    /"indirect-tev"/,
  );
  assert.match(
    extractFunction("recordGxPrimitive"),
    /gxTevResourceDependencies\(stages, pipeline\.indirectTev\)/,
  );
  assert.match(
    extractFunction("recordGxPrimitive"),
    /for \(const dependency of tevResourceDependencies\)[\s\S]*?gxTevCoordsTransportable/,
  );
  assert.match(
    extractFunction("recordGxPrimitive"),
    /gxTevTextures\(\s*stages,\s*pipeline\.indirectTev,\s*textureHashBatch/,
  );
});

test("pins the cross-language indirect TEV tail feature ABI", () => {
  assert.match(
    packetParserSource,
    /PACKET_FLAG_INDIRECT_TEV_STATE_V1: u32 = 1 << 1/,
  );
  assert.match(
    packetParserSource,
    /GX_INDIRECT_TEV_TAIL_BYTES_PER_DRAW: u32 = 128/,
  );
  assert.match(
    packetParserSource,
    /INDIRECT_TEV_STATE_ENCODING_BP_WORDS_V1: u32 = 1/,
  );
  assert.match(
    packetParserSource,
    /INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2: u32 = 2/,
  );
  assert.match(
    packetParserSource,
    /pub\(crate\) struct GxIndirectTevState \{[\s\S]*?gen_mode: u32,[\s\S]*?xf_num_tex_gens: u32,[\s\S]*?matrices: \[u32; 9\],[\s\S]*?imask: u32,[\s\S]*?commands: \[u32; 16\],[\s\S]*?tex_scales: \[u32; 2\],[\s\S]*?iref: u32/,
  );
  assert.match(source, /const buffer = new ArrayBuffer\(464\);/);
  assert.match(source, /packet = gxAttachIndirectTevStateV1\(packet, frame\);/);
});
