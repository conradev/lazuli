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
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
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
];

function packetContext() {
  const packet = {
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
  vm.createContext(packet);
  vm.runInContext(packetFunctions.map(extractFunction).join("\n\n"), packet, {
    filename: "browser_boot.gx-packet-state.js",
  });
  return packet;
}

function tevStateForMap(map = null) {
  const state = new Uint8Array(464);
  if (map === null) return state;
  const view = new DataView(state.buffer);
  view.setUint32(8, (1 << 6) | map, true);
  view.setUint32(448, 1, true);
  return state;
}

function packetFrame(draws) {
  const vertices = draws.reduce(
    (total, draw) => total + draw.vertices.byteLength / 144,
    0,
  );
  return {
    copyToXfb: true,
    index: 23,
    sourceX: 0,
    sourceY: 0,
    width: 640,
    sourceHeight: 448,
    height: 448,
    destination: 0x00392c80,
    stride: 1280,
    clear: false,
    clearColor: [0, 0, 0, 0],
    copyState: {
      zMode: 0,
      blendMode: 0,
      pixelControl: 0,
      copyCommand: 0x4000,
      clearRgba: [0, 0, 0, 0],
      clearDepth: 0,
      copyScale: 0,
      copyFilter: [0, 0],
    },
    geometry: { drawCalls: draws.length, vertices, draws },
  };
}

const gxBpRegisters = new Uint32Array(256);
const gxXfRegisters = new Uint32Array(0x1100);
const gxXfValues = new Float32Array(gxXfRegisters.buffer);
const context = {
  gxBpRegisters,
  gxXfRegisters,
  gxXfFloat(address) {
    return gxXfValues[address];
  },
  Array,
  Number,
  Math,
};
vm.createContext(context);
vm.runInContext(extractFunction("gxDrawPipelineState"), context, {
  filename: "browser_boot.gx-state.js",
});
vm.runInContext(
  [
    extractFunction("gxTransformPosition"),
    extractFunction("gxProjectViewPosition"),
    extractFunction("gxProjectPosition"),
  ].join("\n\n"),
  context,
  {
  filename: "browser_boot.gx-projection.js",
  },
);
vm.runInContext(extractFunction("gxDrawTexCoords"), context, {
  filename: "browser_boot.gx-texcoords.js",
});

function corner(xPlus342, yPlus342) {
  return (xPlus342 << 12) | yPlus342;
}

function offset(xPlus342Div2, yPlus342Div2) {
  return xPlus342Div2 | (yPlus342Div2 << 10);
}

function indirectTevState(genMode = 0) {
  return {
    genMode,
    matrices: Array(9).fill(0),
    imask: 0,
    commands: Array(16).fill(0),
    texScales: [0, 0],
    iref: 0,
  };
}

test("snapshots GX depth, blend, cull, and full-EFB scissor state", () => {
  gxBpRegisters.fill(0);
  gxXfRegisters.fill(0);
  gxBpRegisters[0x00] = 2 << 14;
  gxBpRegisters[0x20] = corner(342, 342);
  gxBpRegisters[0x21] = corner(342 + 639, 342 + 527);
  gxBpRegisters[0x40] = 1 | (6 << 1) | (1 << 4);
  gxBpRegisters[0x41] = 1 | (1 << 3) | (1 << 4) | (5 << 5) | (4 << 8);
  gxBpRegisters[0x42] = 0x131415;
  gxBpRegisters[0x43] = 0x101112;
  gxBpRegisters[0xe8] = 0x1c1d1e;
  gxBpRegisters.set(
    [0x010001, 0x010002, 0x010003, 0x010004, 0x010005],
    0xe9,
  );
  gxBpRegisters.set(
    [0x020001, 0x020002, 0x020003, 0x020004, 0x020005],
    0xee,
  );
  gxBpRegisters[0xf3] = 0x00240000;
  gxBpRegisters[0xf4] = 0x161718;
  gxBpRegisters[0xf5] = 0x191a1b;
  gxBpRegisters[0x59] = offset(171, 171);
  gxXfRegisters[0x101a] = 0x43a00000;

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.gxDrawPipelineState())),
    {
      zMode: 0x1d,
      blendMode: 0x4b9,
      alphaTest: 0x00240000,
      cullMode: 2,
      scissorX: 0,
      scissorY: 0,
      scissorWidth: 640,
      scissorHeight: 528,
      pixelControl: 0x101112,
      constantAlpha: 0x131415,
      zTextureBias: 0x161718,
      zTextureMode: 0x191a1b,
      fogRangeBase: 0x1c1d1e,
      fogRangeK: [0x010001, 0x010002, 0x010003, 0x010004, 0x010005],
      fogWords: [0x020001, 0x020002, 0x020003, 0x020004, 0x020005],
      viewportHalfWidthBits: 0x43a00000,
      indirectTev: indirectTevState(2 << 14),
    },
  );
});

test("applies independent GX X/Y scissor offsets and clips to the EFB", () => {
  gxBpRegisters.fill(0);
  gxXfRegisters.fill(0);
  gxBpRegisters[0x20] = corner(400, 370);
  gxBpRegisters[0x21] = corner(700, 500);
  gxBpRegisters[0x59] = offset(176, 168);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.gxDrawPipelineState())),
    {
      zMode: 0,
      blendMode: 0,
      alphaTest: 0,
      cullMode: 0,
      scissorX: 48,
      scissorY: 34,
      scissorWidth: 301,
      scissorHeight: 131,
      pixelControl: 0,
      constantAlpha: 0,
      zTextureBias: 0,
      zTextureMode: 0,
      fogRangeBase: 0,
      fogRangeK: [0, 0, 0, 0, 0],
      fogWords: [0, 0, 0, 0, 0],
      viewportHalfWidthBits: 0,
      indirectTev: indirectTevState(),
    },
  );

  gxBpRegisters[0x20] = corner(342 + 630, 342 + 520);
  gxBpRegisters[0x21] = corner(342 + 700, 342 + 600);
  gxBpRegisters[0x59] = offset(171, 171);
  const clipped = context.gxDrawPipelineState();
  assert.equal(clipped.scissorWidth, 10);
  assert.equal(clipped.scissorHeight, 8);
});

test("copy commands snapshot complete terminal PE state for LZGX packets", () => {
  const bp = new Uint32Array(256);
  bp[0x40] = 0x010203;
  bp[0x41] = 0x040506;
  bp[0x43] = 0x070809;
  bp[0x49] = 2 | (3 << 10);
  bp[0x4a] = 319 | (239 << 10);
  bp[0x4b] = 0x123400 >>> 5;
  bp[0x4d] = 1280 >>> 5;
  bp[0x4e] = 0x000100;
  bp[0x4f] = 0x004411;
  bp[0x50] = 0x002233;
  bp[0x51] = 0x0a0b0c;
  bp[0x53] = 0x101112;
  bp[0x54] = 0x131415;
  bp[0xfe] = 0x00ffffff;
  const capturedFrames = [];
  const textureCopies = [];
  const memory = new ArrayBuffer(0x4000);
  const copyContext = {
    Array,
    Math,
    Number,
    Set,
    cycles: 100,
    deviceEvents: new Map(),
    gxBpLoads: 0,
    gxBpRegisters: bp,
    gxCollectFrameGeometry: true,
    gxFrameDraws: [],
    gxFrameDrawVertices: 0,
    gxFrameSkippedPrimitives: 0,
    gxFramesSkipped: 0,
    gxDrainSkippedCopyClears() { return []; },
    invalidateGxCopyReservation() {},
    gxSkippedFrameClearColor: null,
    gxSkippedCopyClears: [],
    gxLoadTlut() { assert.fail("unexpected TLUT load"); },
    gxMarkTextureCopyConsumer() { assert.fail("unexpected texture consumer"); },
    gxPrearmTextureCopyProducer() { assert.fail("unexpected texture producer"); },
    gxRecordXfbCopyGeneration() {},
    gxRecordTextureCopyGeneration() {},
    gxShouldCollectNextXfb() { return false; },
    gxTextureCopyConsumers: new Set(),
    gxTextureCopyCount: 0,
    gxTextureCopyFramesPresented: 0,
    gxTextureCopies: textureCopies,
    gxTextureCopyIsBound() { return false; },
    gxUncollectedNonClearingFrames: 0,
    gxXfbCopies: [],
    gxXfbCopyCount: 0,
    gxXfbFramesCaptured: 0,
    mmio: 0,
    peFinishCycle: null,
    peFinishSignal: false,
    peTokenInterruptDelivered: false,
    peTokenSignal: false,
    peTokenValue: 0,
    postGxFrame(copyKind, frame) { capturedFrames.push({ copyKind, frame }); },
    postMessage() { assert.fail("unexpected renderer message"); },
    viXfbAddress() { return 0; },
    view: new DataView(memory),
  };
  vm.createContext(copyContext);
  vm.runInContext(
    extractFunction("recordGxBpWrite"),
    copyContext,
    { filename: "browser_boot.gx-copy-state.js" },
  );

  copyContext.recordGxBpWrite(((0x52 << 24) | 0x000800) >>> 0);

  const expected = {
    zMode: 0x010203,
    blendMode: 0x040506,
    pixelControl: 0x070809,
    copyCommand: 0x000800,
    clearRgba: [0x11, 0x22, 0x33, 0x44],
    clearDepth: 0x0a0b0c,
    copyScale: 0x000100,
    copyFilter: [0x101112, 0x131415],
  };
  assert.equal(capturedFrames.length, 1);
  assert.equal(capturedFrames[0].copyKind, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(capturedFrames[0].frame.copyState)),
    expected,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(textureCopies[0].clearColor)),
    expected.clearRgba,
  );
  assert.equal(JSON.stringify(textureCopies[0]).includes('"copyState"'), false);

  // A legitimate extreme inverse BP scale saturates at the GX/libogc line
  // limit before becoming an LZGX output extent.
  bp[0x4a] = 1023 << 10;
  bp[0x4e] = 1;
  copyContext.gxCollectFrameGeometry = true;
  copyContext.recordGxBpWrite(((0x52 << 24) | 0x004400) >>> 0);
  assert.equal(capturedFrames.length, 2);
  assert.equal(capturedFrames[1].copyKind, 2);
  assert.equal(capturedFrames[1].frame.sourceHeight, 1024);
  assert.equal(capturedFrames[1].frame.height, 1024);

  // Keep the worker's fixed-point line count identical to the Rust consumer.
  // Precomputing 256 / 49 as f64 and multiplying rounds just below 768.
  bp[0x4a] = 147 << 10;
  bp[0x4e] = 49;
  copyContext.gxCollectFrameGeometry = true;
  copyContext.recordGxBpWrite(((0x52 << 24) | 0x004400) >>> 0);
  assert.equal(capturedFrames.length, 3);
  assert.equal(capturedFrames[2].frame.sourceHeight, 148);
  assert.equal(capturedFrames[2].frame.height, 769);
});

test("distinct skipped regional clears retain their source order", () => {
  const clearContext = {
    gxSkippedCopyClears: [],
  };
  vm.createContext(clearContext);
  vm.runInContext(
    ["gxCopyClearOperation", "gxDrainSkippedCopyClears"]
      .map(extractFunction)
      .join("\n\n"),
    clearContext,
    { filename: "browser_boot.gx-skipped-copy-clears.js" },
  );
  for (const frame of [
    {
      sourceX: 4,
      sourceY: 5,
      width: 6,
      sourceHeight: 7,
      copyState: { clearRgba: [1, 2, 3, 4] },
    },
    {
      sourceX: 40,
      sourceY: 50,
      width: 60,
      sourceHeight: 70,
      copyState: { clearRgba: [5, 6, 7, 8] },
    },
  ]) {
    clearContext.gxSkippedCopyClears.push(
      clearContext.gxCopyClearOperation(frame),
    );
  }
  const clears = clearContext.gxDrainSkippedCopyClears();

  assert.deepEqual(JSON.parse(JSON.stringify(clears)), [
    {
      sourceX: 4,
      sourceY: 5,
      sourceWidth: 6,
      sourceHeight: 7,
      copyState: { clearRgba: [1, 2, 3, 4] },
    },
    {
      sourceX: 40,
      sourceY: 50,
      sourceWidth: 60,
      sourceHeight: 70,
      copyState: { clearRgba: [5, 6, 7, 8] },
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(clearContext.gxSkippedCopyClears)), []);
});

test("preserves homogeneous W for WebGPU clipping and interpolation", () => {
  gxBpRegisters.fill(0);
  gxXfRegisters.fill(0);
  gxXfValues[0] = 1;
  gxXfValues[5] = 1;
  gxXfValues[10] = 1;
  gxXfValues[0x1020] = 1;
  gxXfValues[0x1022] = 1;
  gxXfValues[0x1024] = 1;
  gxXfValues[0x101a] = 320;
  gxXfValues[0x101b] = 264;
  gxXfValues[0x101c] = 1;
  gxXfValues[0x101d] = 320;
  gxXfValues[0x101e] = 264;

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.gxProjectPosition([2, 3, -4], 0))),
    [480, 462, -1, 4],
  );
});

test("classifies legacy projection by its exact W and transported f32 image", () => {
  gxBpRegisters.fill(0);
  gxXfRegisters.fill(0);
  gxXfValues[0x1020] = 1;
  gxXfValues[0x1022] = 1;
  gxXfValues[0x101a] = 1;
  gxXfValues[0x101b] = 1;

  assert.equal(context.gxProjectViewPosition([0, 0, 0]), null);
  assert.equal(context.gxProjectViewPosition([0, 0, -0]), null);

  const tinyRepresentableW = context.gxProjectViewPosition([0, 0, -1e-20]);
  assert.notEqual(tinyRepresentableW, null);
  assert.ok(Math.abs(tinyRepresentableW[3]) < 1e-12);
  assert.notEqual(Math.fround(tinyRepresentableW[3]), 0);

  assert.equal(
    context.gxProjectViewPosition([0, 0, -1e-50]),
    null,
    "a nonzero f64 W that becomes zero in the packet cannot use native geometry",
  );
  assert.equal(
    context.gxProjectViewPosition([1e20, 0, -1e-20]),
    null,
    "finite JS projection that overflows its transported f32 is exact-required",
  );
});

test("does not truncate late GX draws with a debug-era frame vertex cap", () => {
  const recordPrimitive = extractFunction("recordGxPrimitive");

  assert.doesNotMatch(source, /gxFrameVertexLimit/);
  assert.doesNotMatch(
    recordPrimitive,
    /gxFrameDrawVertices\s*\+\s*vertexCount[^}]+gxDroppedVertices[^}]+return/,
  );
});

test("does not forward null texcoord placeholders for untextured draws", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.gxDrawTexCoords(null, [null, null, null]))),
    [],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.gxDrawTexCoords(
      { texture: {} },
      [[0, 0.25], [0.5, 0.75]],
    ))),
    [0, 0.25, 0.5, 0.75],
  );
});

test("packs each draw's GX pipeline and f32 vertices into its canonical record", () => {
  const packet = packetContext();
  const vertices = Float32Array.from(
    { length: 36 },
    (_unused, index) => index - 4.5,
  );
  const buffer = packet.packGxFramePacketV4(2, packetFrame([{
    topology: 2,
    vertices,
    tevState: tevStateForMap(),
    textures: [],
    pipeline: {
      zMode: 0x17,
      blendMode: 0x5a9,
      alphaTest: 0x00240000,
      cullMode: 1,
      scissorX: 12,
      scissorY: 34,
      scissorWidth: 456,
      scissorHeight: 321,
      pixelControl: 0x111213,
      constantAlpha: 0x141516,
      zTextureBias: 0x171819,
      zTextureMode: 0x1a1b1c,
      fogRangeBase: 0x1d1e1f,
      fogRangeK: [0x212223, 0x242526, 0x272829, 0x2a2b2c, 0x2d2e2f],
      fogWords: [0x313233, 0x343536, 0x373839, 0x3a3b3c, 0x3d3e3f],
      viewportHalfWidthBits: 0x43a00000,
    },
  }]));
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const draw = 160;

  assert.equal(buffer.byteLength, 944);
  assert.equal(bytes[draw], 2);
  assert.equal(bytes[draw + 1], 1);
  assert.equal(view.getUint32(draw + 0x04, true), 1);
  assert.equal(view.getUint32(draw + 0x08, true), 0);
  assert.equal(view.getUint32(draw + 0x0c, true), 0);
  assert.equal(view.getUint32(draw + 0x10, true), 0x17);
  assert.equal(view.getUint32(draw + 0x14, true), 0x5a9);
  assert.equal(view.getUint32(draw + 0x18, true), 0x00240000);
  assert.equal(view.getUint32(draw + 0x1c, true), 12);
  assert.equal(view.getUint32(draw + 0x20, true), 34);
  assert.equal(view.getUint32(draw + 0x24, true), 456);
  assert.equal(view.getUint32(draw + 0x28, true), 321);
  assert.equal(view.getUint32(draw + 0x2c, true), 0);
  for (let map = 0; map < 8; map += 1) {
    assert.equal(view.getUint32(draw + 0x30 + map * 8, true), 0xffffffff);
    assert.equal(view.getUint32(draw + 0x34 + map * 8, true), 0);
  }
  assert.equal(view.getUint32(draw + 0x70, true), 0x111213);
  assert.equal(view.getUint32(draw + 0x74, true), 0x141516);
  assert.equal(view.getUint32(draw + 0x78, true), 0x171819);
  assert.equal(view.getUint32(draw + 0x7c, true), 0x1a1b1c);
  assert.equal(view.getUint32(draw + 0x80, true), 0x1d1e1f);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      view.getUint32(draw + 0x84 + index * 4, true),
      [0x212223, 0x242526, 0x272829, 0x2a2b2c, 0x2d2e2f][index],
    );
    assert.equal(
      view.getUint32(draw + 0x98 + index * 4, true),
      [0x313233, 0x343536, 0x373839, 0x3a3b3c, 0x3d3e3f][index],
    );
  }
  assert.equal(view.getUint32(draw + 0xac, true), 0x43a00000);
  const vertexOffset = view.getUint32(0x28, true);
  assert.equal(vertexOffset, 800);
  assert.equal(view.getFloat32(vertexOffset, true), -4.5);
  assert.equal(view.getFloat32(vertexOffset + 35 * 4, true), 30.5);
});

test("deduplicates packet textures while retaining each draw's sampler bits", () => {
  const packet = packetContext();
  const pixels = Uint8Array.of(1, 2, 3, 4);
  const texture = {
    renderKey: "shared:7",
    address: 0x10203040,
    textureCopyIndex: 9,
    width: 1,
    height: 1,
    pixels,
  };
  const buffer = packet.packGxFramePacketV4(2, packetFrame([
    {
      topology: 2,
      vertices: new Float32Array(36),
      tevState: tevStateForMap(0),
      textures: [{
        ...texture,
        wrapS: 1,
        wrapT: 2,
        magFilter: 1,
        minFilter: 5,
        maxAnisotropy: 2,
      }],
    },
    {
      topology: 5,
      vertices: new Float32Array(36),
      tevState: tevStateForMap(0),
      textures: [{
        ...texture,
        wrapS: 2,
        wrapT: 3,
        magFilter: 0,
        minFilter: 1,
        maxAnisotropy: 1,
      }],
    },
  ]));
  const view = new DataView(buffer);
  const firstDraw = 160;
  const secondDraw = 336;
  const textureTable = view.getUint32(0x20, true);

  assert.equal(view.getUint32(0x14, true), 2);
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(firstDraw + 0x30, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x34, true), 0x001000b9);
  assert.equal(view.getUint32(secondDraw + 0x30, true), 0);
  assert.equal(view.getUint32(secondDraw + 0x34, true), 0x0008002e);
  assert.equal(view.getUint32(textureTable + 0x0c, true), 4);
  assert.equal(view.getUint32(textureTable + 0x20, true), 1);
  assert.equal(view.getUint32(0x48, true), 16);
});

test("the main thread submits packets without rebuilding a per-draw bridge graph", () => {
  const submit = extractFunction("submitGxFrame");
  assert.match(
    submit,
    /submit_gx_frame\(\s*new Uint8Array\(packet\),\s*preClearWords\s*\)/,
  );
  assert.doesNotMatch(
    submit,
    /begin_segment|push_tev_draw|has_decoded_texture|copy_texture|copy_xfb/,
  );
  assert.doesNotMatch(source, /function queueGxDraw\(/);
});
