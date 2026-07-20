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

test("forwards each draw's GX pipeline snapshot to WebGPU", () => {
  const calls = [];
  const queueContext = {
    Array,
    Float32Array,
    Uint8Array,
    Uint32Array,
    webGpuRenderer: {
      has_decoded_texture() {
        return false;
      },
      push_tev_draw(...arguments_) {
        calls.push(arguments_);
      },
    },
  };
  vm.createContext(queueContext);
  vm.runInContext(extractFunction("queueGxDraw"), queueContext, {
    filename: "browser_boot.gx-queue.js",
  });
  queueContext.queueGxDraw({
    topology: 2,
    vertices: Array(36).fill(1),
    tevState: new Uint8Array(464),
    textures: Array(8).fill(null),
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
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].length, 36);
  assert.equal(calls[0][2].length, 464);
  assert.equal(calls[0][3].length, 8);
  assert.equal(calls[0][4].length, 40);
  assert.equal(calls[0][5].length, 8);
  assert.deepEqual(
    calls[0].slice(-8),
    [0x17, 0x5a9, 0x00240000, 1, 12, 34, 456, 321],
  );
});

test("forwards worker f32 vertex payloads without another main-thread copy", () => {
  const calls = [];
  const queueContext = {
    Array,
    Float32Array,
    Uint8Array,
    Uint32Array,
    webGpuRenderer: {
      has_decoded_texture() {
        return false;
      },
      push_tev_draw(...arguments_) {
        calls.push(arguments_);
      },
    },
  };
  vm.createContext(queueContext);
  vm.runInContext(extractFunction("queueGxDraw"), queueContext, {
    filename: "browser_boot.gx-queue-vertices.js",
  });
  const vertices = new Float32Array(36).fill(0.25);

  queueContext.queueGxDraw({
    topology: 2,
    vertices,
    tevState: new Uint8Array(464),
    textures: Array(8).fill(null),
  });

  assert.strictEqual(calls[0][1], vertices);
});

test("forwards GX texture wrap and filter state to WebGPU", () => {
  const calls = [];
  const queueContext = {
    Array,
    Float32Array,
    Uint8Array,
    Uint32Array,
    webGpuRenderer: {
      has_decoded_texture() {
        return false;
      },
      push_tev_draw(...arguments_) {
        calls.push(arguments_);
      },
    },
  };
  vm.createContext(queueContext);
  vm.runInContext(extractFunction("queueGxDraw"), queueContext, {
    filename: "browser_boot.gx-queue-sampler.js",
  });

  queueContext.queueGxDraw({
    topology: 2,
    vertices: new Float32Array(36),
    tevState: new Uint8Array(464),
    textures: [{
      renderKey: "sampler:7",
      width: 1,
      height: 1,
      wrapS: 1,
      wrapT: 2,
      magFilter: 1,
      minFilter: 5,
      pixels: new Uint8Array([255, 255, 255, 255]),
    }],
  });

  assert.equal(calls[0][4][4], 1 | (2 << 2) | (1 << 4) | (5 << 5));
});

test("omits resident TEV pixels before rebuilding their typed array", () => {
  const calls = [];
  const residentQueries = [];
  const queueContext = {
    Array,
    Float32Array,
    Uint8Array,
    Uint32Array,
    webGpuRenderer: {
      has_decoded_texture(...arguments_) {
        residentQueries.push(arguments_);
        return true;
      },
      push_tev_draw(...arguments_) {
        calls.push(arguments_);
      },
    },
  };
  vm.createContext(queueContext);
  vm.runInContext(extractFunction("queueGxDraw"), queueContext, {
    filename: "browser_boot.gx-queue-cache.js",
  });
  const pixels = {
    byteLength: 4 * 8 * 4,
    get [Symbol.iterator]() {
      throw new Error("resident pixels must not be copied");
    },
  };
  queueContext.queueGxDraw({
    topology: 0,
    vertices: Array(36).fill(0),
    tevState: new Uint8Array(464),
    textures: [{ renderKey: "decoded:7", width: 4, height: 8, pixels }],
  });

  assert.deepEqual(residentQueries, [["decoded:7", 4, 8]]);
  assert.equal(calls[0][5][0].length, 0);
});
