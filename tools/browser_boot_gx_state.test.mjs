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
  "packGxFramePacketV1",
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
  [extractFunction("gxTransformPosition"), extractFunction("gxProjectPosition")].join("\n\n"),
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

test("snapshots GX depth, blend, cull, and full-EFB scissor state", () => {
  gxBpRegisters.fill(0);
  gxBpRegisters[0x00] = 2 << 14;
  gxBpRegisters[0x20] = corner(342, 342);
  gxBpRegisters[0x21] = corner(342 + 639, 342 + 527);
  gxBpRegisters[0x40] = 1 | (6 << 1) | (1 << 4);
  gxBpRegisters[0x41] = 1 | (1 << 3) | (1 << 4) | (5 << 5) | (4 << 8);
  gxBpRegisters[0xf3] = 0x00240000;
  gxBpRegisters[0x59] = offset(171, 171);

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
    },
  );
});

test("applies independent GX X/Y scissor offsets and clips to the EFB", () => {
  gxBpRegisters.fill(0);
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
    },
  );

  gxBpRegisters[0x20] = corner(342 + 630, 342 + 520);
  gxBpRegisters[0x21] = corner(342 + 700, 342 + 600);
  gxBpRegisters[0x59] = offset(171, 171);
  const clipped = context.gxDrawPipelineState();
  assert.equal(clipped.scissorWidth, 10);
  assert.equal(clipped.scissorHeight, 8);
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
  const buffer = packet.packGxFramePacketV1(2, packetFrame([{
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
    },
  }]));
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const draw = 128;

  assert.equal(buffer.byteLength, 864);
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
  for (let map = 0; map < 8; map += 1) {
    assert.equal(view.getUint32(draw + 0x30 + map * 8, true), 0xffffffff);
    assert.equal(view.getUint32(draw + 0x34 + map * 8, true), 0);
  }
  const vertexOffset = view.getUint32(0x28, true);
  assert.equal(vertexOffset, 720);
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
  const buffer = packet.packGxFramePacketV1(2, packetFrame([
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
      }],
    },
  ]));
  const view = new DataView(buffer);
  const firstDraw = 128;
  const secondDraw = 256;
  const textureTable = view.getUint32(0x20, true);

  assert.equal(view.getUint32(0x14, true), 2);
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(firstDraw + 0x30, true), 0);
  assert.equal(view.getUint32(firstDraw + 0x34, true), 0xb9);
  assert.equal(view.getUint32(secondDraw + 0x30, true), 0);
  assert.equal(view.getUint32(secondDraw + 0x34, true), 0x2e);
  assert.equal(view.getUint32(textureTable + 0x0c, true), 4);
  assert.equal(view.getUint32(textureTable + 0x20, true), 1);
  assert.equal(view.getUint32(0x48, true), 16);
});

test("the main thread submits packets without rebuilding a per-draw bridge graph", () => {
  const submit = extractFunction("submitGxFrame");
  assert.match(submit, /submit_gx_frame\(new Uint8Array\(packet\)\)/);
  assert.doesNotMatch(
    submit,
    /begin_segment|push_tev_draw|has_decoded_texture|copy_texture|copy_xfb/,
  );
  assert.doesNotMatch(source, /function queueGxDraw\(/);
});
