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
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
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

function gxFunctionSources() {
  const names = new Set(
    Array.from(
      source.matchAll(/(?:async\s+)?function\s+(gx[A-Za-z0-9_]*)\s*\(/g),
      match => match[1],
    ),
  );
  return [...names].map(extractFunction).join("\n\n");
}

function workerContext() {
  const bytes = new Uint8Array(0x800);
  const gxBpRegisters = new Uint32Array(256);
  const gxCpRegisters = new Uint32Array(256);
  const gxXfRegisters = new Uint32Array(0x1100);
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Float32Array,
    Map,
    Math,
    Number,
    Set,
    Uint8Array,
    Uint32Array,
    bytes,
    gxBpRegisters,
    gxCpRegisters,
    gxFifoScratch: new DataView(new ArrayBuffer(4)),
    gxTevColorRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxTevKonstRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxTexgenFallbacks: 0,
    gxTexgenTransforms: 0,
    gxXfRegisters,
    ramPointer(address, length) {
      return address + length <= bytes.byteLength ? address : null;
    },
  };
  vm.createContext(context);
  vm.runInContext(gxFunctionSources(), context, {
    filename: "browser_boot.xf-tev-transport.js",
  });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertVector(actual, expected, epsilon = 1e-7) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `component ${index}: expected ${expected[index]}, got ${actual[index]}`,
    );
  }
}

function setXfFloat(context, address, value) {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, false);
  context.gxXfRegisters[address] = scratch.getUint32(0, false);
}

function setXfMatrixRows(context, baseAddress, rowIndex, rows) {
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].length; column += 1) {
      setXfFloat(
        context,
        baseAddress + (rowIndex + row) * 4 + column,
        rows[row][column],
      );
    }
  }
}

test("decodes direct signed normals with GX fixed-point scaling", () => {
  const context = workerContext();
  const decoded = context.gxDecodeNormalAttribute(
    new Uint8Array([0xaa, 64, 0xe0, 16]),
    1,
    1,
    0,
    1,
    false,
  );

  assert.equal(decoded.cursor, 4);
  assert.equal(decoded.skipped, false);
  assertVector(decoded.normal, [1, -0.5, 0.25]);
  assert.equal(decoded.tangent, null);
  assert.equal(decoded.binormal, null);

  const decoded16 = context.gxDecodeNormalAttribute(
    new Uint8Array([0x20, 0x00, 0xc0, 0x00, 0x10, 0x00]),
    0,
    1,
    0,
    3,
    false,
  );
  assert.equal(decoded16.cursor, 6);
  assertVector(decoded16.normal, [0.5, -1, 0.25]);
});

test("decodes indexed normals and separate NBT indexes from array one", () => {
  const context = workerContext();
  context.gxCpRegisters[0xa1] = 0x40;
  context.gxCpRegisters[0xb1] = 3;
  context.bytes.set([
    64, 0, 0,
    0, 64, 0,
    0, 0, 64,
  ], 0x40);

  const normal = context.gxDecodeNormalAttribute(
    new Uint8Array([1]),
    0,
    2,
    0,
    1,
    false,
  );
  assert.equal(normal.cursor, 1);
  assertVector(normal.normal, [0, 1, 0]);

  const nbt = context.gxDecodeNormalAttribute(
    new Uint8Array([0, 1, 2]),
    0,
    2,
    1,
    1,
    true,
  );
  assert.equal(nbt.cursor, 3);
  assert.equal(nbt.skipped, false);
  assertVector(nbt.normal, [1, 0, 0]);
  // NBT array order is normal, binormal, tangent.
  assertVector(nbt.binormal, [0, 1, 0]);
  assertVector(nbt.tangent, [0, 0, 1]);
});

test("transforms and normalizes normals with the selected XF normal matrix", () => {
  const context = workerContext();
  const matrixIndex = 6;
  const base = 0x400 + 3 * matrixIndex;
  [
    2, 0, 0,
    0, 3, 0,
    0, 0, 4,
  ].forEach((value, index) => setXfFloat(context, base + index, value));

  const transformed = context.gxTransformNormal([1, 1, 0], matrixIndex);
  const length = Math.hypot(2, 3);
  assertVector(transformed, [2 / length, 3 / length, 0]);
});

test("normal-source projective texgen preserves homogeneous STQ", () => {
  const context = workerContext();
  const matrixIndex = 9;
  context.gxXfRegisters[0x103f] = 1;
  // Vec3 output, ABC1 input, transform texgen, source row 1 (normal).
  context.gxXfRegisters[0x1040] = 0x86;
  context.gxXfRegisters[0x1012] = 0;
  setXfMatrixRows(context, 0, matrixIndex, [
    [2, 0, 0, 0],
    [0, 3, 0, 0],
    [0, 0, 4, 1],
  ]);
  const attributes = {
    position: [11, 12, 13],
    normal: [1, 2, 3],
    tangent: [4, 5, 6],
    binormal: [7, 8, 9],
    colors: [[10, 20, 30, 40], [50, 60, 70, 80]],
    rawTextureCoords: [[0.25, 0.75], ...Array(7).fill(null)],
  };

  const result = context.gxTransformTexCoord(attributes, matrixIndex, 0);
  assertVector(result, [2, 6, 13]);
  assert.notDeepEqual(plain(result), [2 / 13, 6 / 13, 1]);
});

test("vertex decode retains two independent raster color channels", () => {
  const context = workerContext();
  // Direct XYZ position, direct color 0, direct color 1.
  context.gxCpRegisters[0x50] = (1 << 9) | (1 << 13) | (1 << 15);
  context.gxCpRegisters[0x70] = 1 | (4 << 1) | (5 << 14) | (5 << 18);

  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  [1, 0, 1, 0, 1, 0].forEach((value, index) => {
    setXfFloat(context, 0x1020 + index, value);
  });
  context.gxXfRegisters[0x1026] = 1;
  [320, 264, 1, 320, 264, 0].forEach((value, index) => {
    setXfFloat(context, 0x101a + index, value);
  });

  const sourceBytes = new Uint8Array(20);
  const sourceView = new DataView(sourceBytes.buffer);
  [1, 2, 3].forEach((value, index) => {
    sourceView.setFloat32(index * 4, value, false);
  });
  sourceBytes.set([1, 2, 3, 4], 12);
  sourceBytes.set([201, 202, 203, 204], 16);

  const decoded = context.gxDecodeVertex(sourceBytes, 0, 0);
  assert.equal(decoded.cursor, sourceBytes.byteLength);
  assert.deepEqual(plain(decoded.colors), [
    [1, 2, 3, 4],
    [201, 202, 203, 204],
  ]);
  assert.equal(decoded.texCoords.length, 8);
});

test("packs the exact 464-byte WebGPU TEV uniform layout", () => {
  const context = workerContext();
  context.gxTevColorRegisters.splice(0, 4,
    [-1, 0, 1, 1023],
    [-1024, 511, -512, 17],
    [18, 19, 20, 21],
    [22, 23, 24, 25],
  );
  context.gxTevKonstRegisters.splice(0, 4,
    [31, 32, 33, 34],
    [35, 36, 37, 38],
    [39, 40, 41, 42],
    [43, 44, 45, 46],
  );
  [
    [0x09, 0x06],
    [0x03, 0x0c],
    [0x06, 0x09],
    [0x00, 0x0f],
  ].forEach(([rg, ba], table) => {
    context.gxBpRegisters[0xf6 + table * 2] = rg;
    context.gxBpRegisters[0xf7 + table * 2] = ba;
  });
  const stages = [
    {
      colorCombiner: 0xabcdef12,
      alphaCombiner: 0x12345678,
      textureMap: 5,
      texCoordIndex: 6,
      textureEnabled: true,
      colorChannel: 3,
      konstColorSelector: 29,
      konstAlphaSelector: 18,
    },
    {
      colorCombiner: 0x00112233,
      alphaCombiner: 0x00445566,
      textureMap: 7,
      texCoordIndex: 1,
      textureEnabled: false,
      colorChannel: 6,
      konstColorSelector: 4,
      konstAlphaSelector: 31,
    },
  ];

  const packed = context.gxPackTevState(stages);
  assert.ok(packed instanceof Uint8Array);
  assert.equal(packed.byteLength, 464);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const u32 = offset => view.getUint32(offset, true);
  const i32 = offset => view.getInt32(offset, true);

  assert.deepEqual([u32(0), u32(4), u32(8), u32(12)], [
    0xcdef12,
    0x345678,
    5 | (6 << 3) | (1 << 6) | (3 << 7),
    29 | (18 << 5),
  ]);
  assert.deepEqual([u32(16), u32(20), u32(24), u32(28)], [
    0x112233,
    0x445566,
    7 | (1 << 3) | (6 << 7),
    4 | (31 << 5),
  ]);
  assert.ok(packed.subarray(32, 256).every(value => value === 0));

  const expectedColors = context.gxTevColorRegisters.flat();
  const expectedKonst = context.gxTevKonstRegisters.flat();
  assert.deepEqual(
    Array.from({ length: 16 }, (_unused, index) => i32(256 + index * 4)),
    expectedColors,
  );
  assert.deepEqual(
    Array.from({ length: 16 }, (_unused, index) => i32(320 + index * 4)),
    expectedKonst,
  );
  assert.deepEqual(
    Array.from({ length: 16 }, (_unused, index) => u32(384 + index * 4)),
    [
      1, 2, 2, 1,
      3, 0, 0, 3,
      2, 1, 1, 2,
      0, 0, 3, 3,
    ],
  );
  assert.equal(u32(448), 2);
  assert.ok(packed.subarray(452).every(value => value === 0));
});

test("worker draw capture routes XF attributes through the TEV transport", () => {
  const capture = extractFunction("recordGxPrimitive");
  assert.match(capture, /gxPackTevState\s*\(/);
  assert.match(capture, /vertices:\s*new Float32Array\(vertices\)/);
  assert.match(capture, /decoded\.colors\s*\[\s*0\s*\]/);
  assert.match(capture, /decoded\.colors\s*\[\s*1\s*\]/);
  assert.doesNotMatch(capture, /gxTextureForDraw\s*\(/);
});
