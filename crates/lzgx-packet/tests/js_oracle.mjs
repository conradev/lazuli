#!/usr/bin/env node
// Transitional byte oracle for the pre-Rust LZGX producer. Runtime code must
// not import this file; the Rust tests use it only to pin migration parity.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.notEqual(match, null, `missing ${name} in browser_boot.rs`);
  const start = match.index;
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

const functions = [
  "gxFramePacketInteger",
  "gxFramePacketAdd",
  "gxFramePacketMultiply",
  "gxFramePacketAlign16",
  "gxFramePacketBytes",
  "gxFramePacketEqualBytes",
  "gxFramePacketKeyBytes",
  "gxFramePacketSampler",
  "gxTevResourceDependencies",
  "gxSourceTriangleCount",
  "gxFramePacketPostCullEvidence",
  "packGxFramePacketV4",
  "gxAttachTextureCopyLayoutV1",
  "gxFramePacketIndirectTevState",
  "gxAttachIndirectTevStateV1",
  "gxFramePacketExactClipInput",
  "packGxFramePacketV5",
  "packGxFramePacketV6",
  "gxFramePacketMipLayout",
  "gxFramePacketMipTexture",
  "gxFramePacketEqualMipTexture",
  "packGxFramePacketV7",
];
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
vm.runInContext(functions.map(extractFunction).join("\n\n"), context, {
  filename: "browser_boot.lzgx-oracle.js",
});

function copyState(copyCommand, overrides = {}) {
  return {
    zMode: 0x010203,
    blendMode: 0x040506,
    pixelControl: 0x070809,
    copyCommand,
    clearRgba: [0x11, 0x22, 0x33, 0x44],
    clearDepth: 0x0a0b0c,
    copyScale: 0x0d0e0f,
    copyFilter: [0x101112, 0x131415],
    ...overrides,
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

function draw(textures = []) {
  return {
    topology: 2,
    vertexCount: 3,
    vertices: new Float32Array(3 * 36),
    tevState: tevState(textures.map((_texture, index) => index)),
    textures,
    pipeline: {
      cullMode: 0,
      scissorWidth: 4,
      scissorHeight: 4,
      viewportHalfWidthBits: 0x43a00000,
    },
  };
}

function xfbFrame(draws = []) {
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
    copyState: copyState(0x004000),
    geometry: {
      drawCalls: draws.length,
      vertices: draws.length * 3,
      draws,
    },
  };
}

function exactDraw() {
  const value = draw();
  value.exactGeometryRequired = true;
  value.exactClipInput = {
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
  return value;
}

const emptyTexture = {
  copyToXfb: false,
  index: 7,
  sourceX: 1,
  sourceY: 2,
  width: 3,
  sourceHeight: 4,
  height: 99,
  destination: 0x00100000,
  stride: 32,
  clear: true,
  clearColor: [0x11, 0x22, 0x33, 0x44],
  copyState: copyState(0x000800),
  geometry: { drawCalls: 0, vertices: 0, draws: [] },
};
const texture = {
  key: "tex-one",
  address: 0x00123000,
  textureCopyIndex: 9,
  width: 1,
  height: 1,
  wrapS: 1,
  wrapT: 0,
  magFilter: 1,
  minFilter: 0,
  maxAnisotropy: 0,
  pixels: Uint8Array.of(1, 2, 3, 4),
};

const indirectDraw = draw();
new DataView(indirectDraw.tevState.buffer).setUint32(448, 1, true);
const commands = Array(16).fill(0);
commands[0] = 1 << 7;
indirectDraw.pipeline.indirectTev = {
  genMode: 1 << 16,
  xfNumTexGens: 0,
  matrices: Array(9).fill(0),
  imask: 0,
  commands,
  texScales: [0, 0],
  iref: 0,
};
indirectDraw.textures = [{
  key: "iref-zero-map-zero",
  width: 1,
  height: 1,
  pixels: Uint8Array.of(9, 8, 7, 6),
}];

const mipPixels = Uint8Array.from(
  { length: 72 },
  (_unused, index) => (3 + index * 17) & 0xff,
);
const mipTexture = {
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
};
const peek = {
  copyToXfb: false,
  index: 11,
  sourceX: 320,
  sourceY: 240,
  width: 1,
  sourceHeight: 1,
  height: 1,
  destination: 0,
  stride: 2,
  clear: false,
  copyState: copyState(0, {
    zMode: 0,
    blendMode: 0,
    pixelControl: 0,
    clearRgba: [0, 0, 0, 0],
    clearDepth: 0,
    copyScale: 0,
    copyFilter: [0, 0],
  }),
  geometry: { drawCalls: 0, vertices: 0, draws: [] },
};
const action = draw();
action.postCullEvidence = Uint8Array.of(3);

const indirectFrame = xfbFrame([indirectDraw]);
const fixtures = {
  empty_terminal: context.packGxFramePacketV4(1, emptyTexture),
  one_draw_texture: context.packGxFramePacketV4(2, xfbFrame([draw([texture])])),
  exact_clip_v6: context.packGxFramePacketV6(2, xfbFrame([exactDraw()])),
  indirect_tev: context.gxAttachIndirectTevStateV1(
    context.packGxFramePacketV4(2, indirectFrame),
    indirectFrame,
  ),
  mip_v7: context.packGxFramePacketV7(2, xfbFrame([draw([mipTexture])])),
  texture_copy: context.gxAttachTextureCopyLayoutV1(
    context.packGxFramePacketV4(1, emptyTexture),
    1,
    emptyTexture,
  ),
  xfb: context.packGxFramePacketV4(2, xfbFrame([action])),
  efb_peek: context.packGxFramePacketV4(3, peek),
};

for (const [name, packet] of Object.entries(fixtures)) {
  console.log(`${name}=${Buffer.from(new Uint8Array(packet)).toString("hex")}`);
}
