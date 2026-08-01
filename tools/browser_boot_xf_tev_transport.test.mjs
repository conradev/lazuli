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
    gxBpLoads: 0,
    gxCpRegisters,
    gxFifoScratch: new DataView(new ArrayBuffer(4)),
    gxTevColorRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxTevKonstRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxTexgenFallbacks: 0,
    gxTexgenEmbossTransforms: 0,
    gxTexgenNonFiniteTransforms: 0,
    gxTexgenTransforms: 0,
    gxCachedNormal: [0, 0, 0],
    gxCachedTangent: [0, 0, 0],
    gxCachedBinormal: [0, 0, 0],
    gxNormalCacheCommits: 0,
    gxCachedNormalUses: 0,
    gxCachedTangentUses: 0,
    gxCachedBinormalUses: 0,
    gxVertexTransformContextSnapshots: 0,
    gxVertexTransformCacheSnapshots: 0,
    gxVertexTransformCacheMemoHits: 0,
    gxXfRegisters,
    ramPointer(address, length) {
      return address + length <= bytes.byteLength ? address : null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${gxFunctionSources()}\n\n${extractFunction("recordGxBpWrite")}`,
    context,
    {
      filename: "browser_boot.xf-tev-transport.js",
    },
  );
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function luigisMansionMatrixProbeContext() {
  const memory = new ArrayBuffer(0x200);
  const registers = new Uint32Array(32);
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Number,
    Uint32Array,
    boot: {
      identifier: "GLME01",
      discId: 0,
      version: 0,
    },
    cycles: 123456,
    luigisMansionGxLoadTexMtxImmPc: 0x801fa288,
    luigisMansionGxPostTexMtx18Id: 118,
    luigisMansionGxPostTexMtx18Load: null,
    luigisMansionGxTexMtxWordCount: 12,
    registers,
    view: new DataView(memory),
    guestEffectivePointer(address, length) {
      return address + length <= memory.byteLength ? address : null;
    },
    readGpr(index) {
      return registers[index];
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "isUint32",
      "exactLuigisMansionRevisionZero",
      "classifyFloat32Word",
      "observeLuigisMansionGxLoadTexMtxImm",
      "snapshotLuigisMansionGxPostTexMtx18Load",
      "luigisMansionGxLoadTexMtxImmProbeRegionSafe",
      "hex32",
    ].map(extractFunction).join("\n\n"),
    context,
    {
      filename: "browser_boot.luigi-gx-matrix-probe.js",
    },
  );
  return context;
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

function setXfNormalMatrix(context, matrixIndex, matrix) {
  matrix.forEach((value, index) => {
    setXfFloat(context, 0x400 + matrixIndex * 3 + index, value);
  });
}

function setXfLightPosition(context, lightIndex, position) {
  position.forEach((value, component) => {
    setXfFloat(
      context,
      0x603 + lightIndex * 0x10 + 7 + component,
      value,
    );
  });
}

function texgenAttributes(overrides = {}) {
  return {
    position: [0, 0, 0],
    viewPosition: [0, 0, 0],
    normal: null,
    tangent: null,
    binormal: null,
    embossTangent: [0, 0, 0],
    embossBinormal: [0, 0, 0],
    colors: [[0, 0, 0, 0], [0, 0, 0, 0]],
    rawTextureCoords: Array(8).fill(null),
    ...overrides,
  };
}

test("Luigi GX_PTTEXMTX18 probe retains first and first non-finite loads", () => {
  const context = luigisMansionMatrixProbeContext();
  const firstSourceAddress = 0x40;
  const secondSourceAddress = 0x80;
  const nonFiniteSourceAddress = 0xc0;
  const firstWords = Array(12).fill(0);
  const secondWords = Array(12).fill(0x3f800000);
  const nonFiniteWords = [
    0x00000000,
    0x80000000,
    0x3f800000,
    0x00800000,
    0x7f7fffff,
    0xff7fffff,
    0x00000001,
    0x80000001,
    0x7f800000,
    0xff800000,
    0x7fc00001,
    0xff800001,
  ];
  context.registers[4] = 118;
  for (const [address, words] of [
    [firstSourceAddress, firstWords],
    [secondSourceAddress, secondWords],
    [nonFiniteSourceAddress, nonFiniteWords],
  ]) {
    words.forEach((word, index) => {
      context.view.setUint32(address + index * 4, word, false);
    });
  }

  context.registers[3] = firstSourceAddress;
  let probe = context.observeLuigisMansionGxLoadTexMtxImm(0x801fa288);
  assert.equal(probe.observedQualifyingLoadCount, 1);
  assert.equal(probe.firstLoad.ordinal, 1);
  assert.deepEqual(Array.from(probe.firstLoad.rawWords), firstWords);
  assert.equal(probe.firstLoad.allFinite, true);
  assert.equal(probe.firstNonFiniteLoad, null);

  context.cycles += 1;
  context.registers[3] = secondSourceAddress;
  probe = context.observeLuigisMansionGxLoadTexMtxImm(
    0x801fa288,
    probe,
  );
  assert.equal(probe.observedQualifyingLoadCount, 2);
  assert.equal(probe.firstLoad.sourceAddress, firstSourceAddress);
  assert.equal(probe.firstNonFiniteLoad, null);

  context.cycles += 1;
  context.registers[3] = nonFiniteSourceAddress;
  probe = context.observeLuigisMansionGxLoadTexMtxImm(
    0x801fa288,
    probe,
  );
  assert.equal(probe.observedQualifyingLoadCount, 3);
  assert.equal(probe.firstLoad.sourceAddress, firstSourceAddress);
  assert.equal(probe.firstNonFiniteLoad.ordinal, 3);
  assert.deepEqual(
    Array.from(probe.firstNonFiniteLoad.rawWords),
    nonFiniteWords,
  );
  assert.deepEqual(
    Array.from(probe.firstNonFiniteLoad.nonFiniteWordIndices),
    [8, 9, 10, 11],
  );

  const snapshot =
    context.snapshotLuigisMansionGxPostTexMtx18Load(probe);
  assert.deepEqual(plain(snapshot), {
    observedQualifyingLoadCount: 3,
    firstLoad: {
      ordinal: 1,
      cycle: 123456,
      pc: "0x801fa288",
      function: "GXLoadTexMtxImm",
      matrix: "GX_PTTEXMTX18",
      matrixId: 118,
      sourceAddress: "0x00000040",
      wordCount: 12,
      byteOrder: "big-endian",
      rawWords: firstWords.map(word =>
        "0x" + word.toString(16).padStart(8, "0")
      ),
      classifications: Array(12).fill("finite"),
      allFinite: true,
      finiteWordCount: 12,
      nonFiniteWordIndices: [],
    },
    firstNonFiniteLoad: {
      ordinal: 3,
      cycle: 123458,
      pc: "0x801fa288",
      function: "GXLoadTexMtxImm",
      matrix: "GX_PTTEXMTX18",
      matrixId: 118,
      sourceAddress: "0x000000c0",
      wordCount: 12,
      byteOrder: "big-endian",
      rawWords: nonFiniteWords.map(word =>
        "0x" + word.toString(16).padStart(8, "0")
      ),
      classifications: [
        "finite",
        "finite",
        "finite",
        "finite",
        "finite",
        "finite",
        "finite",
        "finite",
        "infinity",
        "infinity",
        "nan",
        "nan",
      ],
      allFinite: false,
      finiteWordCount: 8,
      nonFiniteWordIndices: [8, 9, 10, 11],
    },
  });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /null/);

  context.cycles += 1;
  context.registers[3] = secondSourceAddress;
  context.view.setUint32(secondSourceAddress, 0x7fc00000, false);
  assert.equal(
    context.observeLuigisMansionGxLoadTexMtxImm(
      0x801fa288,
      probe,
    ),
    probe,
    "loads after the first non-finite witness leave bounded state unchanged",
  );
  assert.equal(probe.observedQualifyingLoadCount, 3);
});

test("Luigi matrix probe guards reads and fences regions through non-finite capture", () => {
  const context = luigisMansionMatrixProbeContext();
  for (let index = 0; index < 12; index += 1) {
    context.view.setUint32(0x40 + index * 4, 0x3f800000, false);
    context.view.setUint32(0x80 + index * 4, 0x3f800000, false);
  }
  const otherDisc = {
    identifier: "GZLE01",
    discId: 0,
    version: 0,
  };
  context.registers[3] = 0x40;
  context.registers[4] = 117;
  assert.equal(
    context.observeLuigisMansionGxLoadTexMtxImm(0x801fa288),
    null,
  );
  context.registers[4] = 118;
  assert.equal(
    context.observeLuigisMansionGxLoadTexMtxImm(0x801fa284),
    null,
  );
  assert.equal(
    context.observeLuigisMansionGxLoadTexMtxImm(
      0x801fa288,
      null,
      context.readGpr,
      context.guestEffectivePointer,
      context.view,
      otherDisc,
      1,
    ),
    null,
  );
  context.registers[3] = 0x1f0;
  assert.equal(
    context.observeLuigisMansionGxLoadTexMtxImm(0x801fa288),
    null,
    "an unreadable 48-byte source is not counted",
  );

  const pendingRegion = {
    pcs: [0x801fa200, 0x801fa288, 0x801fa2f0],
  };
  assert.equal(
    context.luigisMansionGxLoadTexMtxImmProbeRegionSafe(
      pendingRegion,
      null,
      context.boot,
    ),
    false,
  );

  context.registers[3] = 0x40;
  let probe = context.observeLuigisMansionGxLoadTexMtxImm(0x801fa288);
  assert.equal(probe.observedQualifyingLoadCount, 1);
  assert.equal(
    context.luigisMansionGxLoadTexMtxImmProbeRegionSafe(
      pendingRegion,
      probe,
      context.boot,
    ),
    false,
    "a benign first load keeps exact-entry fencing active",
  );

  context.view.setUint32(0x80, 0x7f800000, false);
  context.registers[3] = 0x80;
  probe = context.observeLuigisMansionGxLoadTexMtxImm(
    0x801fa288,
    probe,
  );
  assert.equal(probe.observedQualifyingLoadCount, 2);
  assert.equal(probe.firstNonFiniteLoad.ordinal, 2);
  assert.equal(
    context.luigisMansionGxLoadTexMtxImmProbeRegionSafe(
      pendingRegion,
      probe,
      context.boot,
    ),
    true,
    "the fence retires after the first non-finite load is captured",
  );
  assert.equal(
    context.luigisMansionGxLoadTexMtxImmProbeRegionSafe(
      { pcs: [0x801fa200, 0x801fa2f0] },
      null,
      context.boot,
    ),
    true,
  );
  assert.equal(
    context.luigisMansionGxLoadTexMtxImmProbeRegionSafe(
      pendingRegion,
      null,
      otherDisc,
    ),
    true,
  );
});

test("Luigi matrix-probe source guard observes before execution without mutation", () => {
  const observe = extractFunction(
    "observeLuigisMansionGxLoadTexMtxImm",
  );
  assert.match(
    source,
    /luigisMansionGxPostTexMtx18Load =\s+observeLuigisMansionGxLoadTexMtxImm\(pc\);\s+observeWarioWareNextMicrogameSelection\(pc\);\s+applyWarioWareNextMicrogameOverride\(pc\);\s+stage = "compile";/,
  );
  assert.match(
    source,
    /warioWareNextMicrogameOverrideRegionSafe\([\s\S]*?\)\s+&& luigisMansionGxLoadTexMtxImmProbeRegionSafe\(retainedRegion\)\s+&& compiledRegionIsExecutable/,
  );
  assert.match(
    source,
    /gxPostTexMtx18Load: snapshotLuigisMansionGxPostTexMtx18Load\(\)/,
  );
  assert.match(
    observe,
    /memory\.getUint32\(pointer \+ index \* 4, false\)/,
  );
  assert.match(
    extractFunction("classifyFloat32Word"),
    /\(word & 0x7f800000\) !== 0x7f800000/,
  );
  assert.doesNotMatch(
    [
      observe,
      extractFunction("snapshotLuigisMansionGxPostTexMtx18Load"),
    ].join("\n"),
    /set(?:Uint32|Float32)|writeGpr|Number\.NaN|Math\.fround/,
  );
});

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

test("decodes unsigned normals with their distinct GX fixed-point scaling", () => {
  const context = workerContext();
  const decoded8 = context.gxDecodeNormalAttribute(
    new Uint8Array([128, 64, 255]),
    0,
    1,
    0,
    0,
    false,
  );
  assertVector(decoded8.normal, [1, 0.5, 255 / 128]);

  const decoded16 = context.gxDecodeNormalAttribute(
    new Uint8Array([0x80, 0, 0x40, 0, 0xff, 0xff]),
    0,
    1,
    0,
    2,
    false,
  );
  assertVector(decoded16.normal, [1, 0.5, 65535 / 32768]);
});

test("decodes indexed normals and separate NBT indexes from array one", () => {
  const context = workerContext();
  context.gxCpRegisters[0xa1] = 0x40;
  context.gxCpRegisters[0xb1] = 9;
  context.bytes.set([
    64, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 64, 0, 0, 64, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 64,
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
  // GX's NTB stream order is normal, tangent, binormal.
  assertVector(nbt.tangent, [0, 1, 0]);
  assertVector(nbt.binormal, [0, 0, 1]);

  // Normal indexes do not inherit the position attribute's skip sentinel.
  context.gxCpRegisters[0xb1] = 3;
  context.gxCpRegisters[0xa1] = (0x70 - 0xff * 3) >>> 0;
  context.bytes.set([128, 0, 0], 0x70);
  const maximumIndex = context.gxDecodeNormalAttribute(
    new Uint8Array([0xff]),
    0,
    2,
    0,
    0,
    false,
  );
  assert.equal(maximumIndex.skipped, false);
  assertVector(maximumIndex.normal, [1, 0, 0]);
});

test("reuses and commits GX cached normal attributes", () => {
  const context = workerContext();
  context.gxCachedNormal = [1, 2, 3];
  context.gxCachedTangent = [4, 5, 6];
  context.gxCachedBinormal = [7, 8, 9];

  const omittedAttribute = {
    cursor: 0,
    normal: null,
    tangent: null,
    binormal: null,
    skipped: false,
  };
  const omitted = context.gxResolveNormalAttribute(omittedAttribute, false);
  assert.equal(omitted, omittedAttribute);
  assertVector(omitted.normal ?? context.gxCachedNormal, [1, 2, 3]);
  assertVector(omitted.tangent ?? context.gxCachedTangent, [4, 5, 6]);
  assertVector(omitted.binormal ?? context.gxCachedBinormal, [7, 8, 9]);
  assert.equal(context.gxNormalCacheCommits, 0);

  const supplied = context.gxResolveNormalAttribute({
    cursor: 0,
    normal: [10, 11, 12],
    tangent: null,
    binormal: null,
    skipped: false,
  }, true);
  assertVector(supplied.normal, [10, 11, 12]);
  assertVector(supplied.tangent ?? context.gxCachedTangent, [4, 5, 6]);
  assertVector(supplied.binormal ?? context.gxCachedBinormal, [7, 8, 9]);
  assertVector(context.gxCachedNormal, [10, 11, 12]);
  assertVector(context.gxCachedTangent, [4, 5, 6]);
  assertVector(context.gxCachedBinormal, [7, 8, 9]);
  assert.equal(context.gxNormalCacheCommits, 1);
  assert.equal(context.gxCachedNormalUses, 1);
  assert.equal(context.gxCachedTangentUses, 2);
  assert.equal(context.gxCachedBinormalUses, 2);
});

test("a final position-index skip still commits its normal cache", () => {
  const context = workerContext();
  // Indexed-8 XYZ position followed by a direct signed-byte normal.
  context.gxCpRegisters[0x50] = (2 << 9) | (1 << 11);
  context.gxCpRegisters[0x70] = 1 | (4 << 1) | (1 << 10);
  const decoded = context.gxDecodeVertex(
    new Uint8Array([0xff, 64, 0, 0]),
    0,
    0,
    null,
    true,
  );

  assert.equal(decoded.cursor, 4);
  assert.equal(decoded.skipped, true);
  assert.equal(decoded.positionIndexSkipped, true);
  assertVector(context.gxCachedNormal, [1, 0, 0]);
  assert.equal(context.gxNormalCacheCommits, 1);
});

test("a position sentinel consumes trailing attributes after an invalid normal", () => {
  const context = workerContext();
  // Indexed-8 position and normal, then direct RGBA8 color and direct ST u8.
  context.gxCpRegisters[0x50] = (2 << 9) | (2 << 11) | (1 << 13);
  context.gxCpRegisters[0x60] = 1;
  context.gxCpRegisters[0x70] = (
    1
    | (4 << 1)
    | (1 << 10)
    | (5 << 14)
    | (1 << 21)
  );
  context.gxCpRegisters[0xa1] = 0x7ff;
  context.gxCpRegisters[0xb1] = 3;
  const decoded = context.gxDecodeVertex(
    new Uint8Array([0xff, 1, 10, 20, 30, 40, 50, 60]),
    0,
    0,
    null,
    true,
  );

  assert.equal(decoded.cursor, 8);
  assert.equal(decoded.skipped, true);
  assert.equal(decoded.positionIndexSkipped, true);
  assert.equal(context.gxNormalCacheCommits, 0);
});

test("commits only the final primitive normal tuple and preserves absent lanes", () => {
  const context = workerContext();
  context.gxCachedNormal = [-1, -2, -3];
  context.gxCachedTangent = [-4, -5, -6];
  context.gxCachedBinormal = [-7, -8, -9];
  const tuple = (normal, tangent, binormal) => ({
    cursor: 0,
    normal,
    tangent,
    binormal,
    skipped: false,
  });

  context.gxResolveNormalAttribute(
    tuple([1, 2, 3], [4, 5, 6], [7, 8, 9]),
    false,
  );
  assertVector(context.gxCachedNormal, [-1, -2, -3]);
  assertVector(context.gxCachedTangent, [-4, -5, -6]);
  assertVector(context.gxCachedBinormal, [-7, -8, -9]);

  context.gxResolveNormalAttribute(
    tuple([10, 11, 12], [13, 14, 15], [16, 17, 18]),
    true,
  );
  assertVector(context.gxCachedNormal, [10, 11, 12]);
  assertVector(context.gxCachedTangent, [13, 14, 15]);
  assertVector(context.gxCachedBinormal, [16, 17, 18]);

  context.gxResolveNormalAttribute(
    tuple([20, 21, 22], null, null),
    true,
  );
  assertVector(context.gxCachedNormal, [20, 21, 22]);
  assertVector(context.gxCachedTangent, [13, 14, 15]);
  assertVector(context.gxCachedBinormal, [16, 17, 18]);

  const omittedTuple = tuple(null, null, null);
  const omitted = context.gxResolveNormalAttribute(omittedTuple, false);
  assert.equal(omitted, omittedTuple);
  assert.equal(omitted.normal, null);
  assert.equal(omitted.tangent, null);
  assert.equal(omitted.binormal, null);
  assertVector(context.gxCachedNormal, [20, 21, 22]);
  assertVector(context.gxCachedTangent, [13, 14, 15]);
  assertVector(context.gxCachedBinormal, [16, 17, 18]);
  assert.equal(context.gxNormalCacheCommits, 2);

  const capture = extractFunction("recordGxPrimitive");
  assert.match(
    capture,
    /gxDecodeVertex\([\s\S]*?vertexTransformContext,\s*vertex === inputVertexCount - 1\s*\)/,
  );
});

test("keeps cached lighting inputs separate from raw texgen sources", () => {
  const decode = extractFunction("gxDecodeVertex");
  assert.match(
    decode,
    /if \(normalAttribute\.skipped && !positionIndexSkipped\) \{\s*return \{ cursor, skipped: true \};\s*\}\s*if \(!normalAttribute\.skipped\) \{\s*gxResolveNormalAttribute\([\s\S]*?const resolvedNormal = normalAttribute\.normal \?\? gxCachedNormal/,
  );
  assert.match(
    decode,
    /const normal = gxTransformNormal\(\s*resolvedNormal/,
  );
  assert.match(
    decode,
    /const texgenAttributes = \{[\s\S]*?normal: normalAttribute\.normal,[\s\S]*?tangent: normalAttribute\.tangent,[\s\S]*?binormal: normalAttribute\.binormal/,
  );
  assert.match(
    decode,
    /embossTangent: normalAttribute\.tangent \?\? gxCachedTangent,[\s\S]*?embossBinormal: normalAttribute\.binormal \?\? gxCachedBinormal/,
  );
  assert.match(
    decode,
    /const texCoords = gxTransformTexCoords\(\s*texgenAttributes,\s*textureMatrices,\s*positionMatrix,\s*transformContext\s*\)/,
  );
  assert.match(
    decode,
    /rawNormal: normalAttribute\.normal,[\s\S]*?rawTangent: normalAttribute\.tangent,[\s\S]*?rawBinormal: normalAttribute\.binormal/,
  );
  assert.doesNotMatch(
    decode,
    /const texgenAttributes = \{[\s\S]*?normal: resolvedNormal/,
  );
});

test("cached normals make an omitted-normal lit vertex executable", () => {
  const context = workerContext();
  // Direct XYZ position with no normal or color attributes.
  context.gxCpRegisters[0x50] = 1 << 9;
  context.gxCpRegisters[0x70] = 1 | (4 << 1);
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ].forEach((value, index) => setXfFloat(context, 0x400 + index, value));

  context.gxXfRegisters[0x100c] = 0xffffffff;
  context.gxXfRegisters[0x100d] = 0xffffffff;
  const litByLightZero = 2 | (1 << 2) | (2 << 7);
  context.gxXfRegisters[0x100e] = litByLightZero;
  context.gxXfRegisters[0x100f] = litByLightZero;
  context.gxXfRegisters[0x1010] = litByLightZero;
  context.gxXfRegisters[0x1011] = litByLightZero;
  context.gxXfRegisters[0x603] = 0xffffffff;
  setXfFloat(context, 0x603 + 9, 1);

  const sourceBytes = new Uint8Array(12);
  const sourceView = new DataView(sourceBytes.buffer);
  [0, 0, 0].forEach((value, index) => {
    sourceView.setFloat32(index * 4, value, false);
  });

  context.gxCachedNormal = [0, 0, 1];
  const cached = context.gxDecodeVertex(sourceBytes, 0, 0);
  assert.notEqual(cached.skipped, true);
  assertVector(cached.normal, [0, 0, 1]);
  assert.equal(cached.rasterColors.length, 2);

  context.gxCachedNormal = [0, 0, 0];
  const zeroInitialized = context.gxDecodeVertex(sourceBytes, 0, 0);
  assert.notEqual(zeroInitialized.skipped, true);
  assert.ok(
    cached.rasterColors.flat().reduce((sum, value) => sum + value, 0)
      > zeroInitialized.rasterColors.flat().reduce((sum, value) => sum + value, 0),
  );
});

test("accepts invalid-float normal encodings and maximum 16-bit indexes", () => {
  const context = workerContext();
  const direct = new Uint8Array(12);
  const directView = new DataView(direct.buffer);
  [1, -0.5, 0.25].forEach((value, index) => {
    directView.setFloat32(index * 4, value, false);
  });
  for (const format of [5, 6, 7]) {
    const decoded = context.gxDecodeNormalAttribute(
      direct,
      0,
      1,
      0,
      format,
      false,
    );
    assert.equal(decoded.skipped, false);
    assertVector(decoded.normal, [1, -0.5, 0.25]);
  }

  context.gxCpRegisters[0xb1] = 6;
  context.gxCpRegisters[0xa1] = (0x90 - 0xffff * 6) >>> 0;
  context.bytes.set([0x80, 0, 0, 0, 0, 0], 0x90);
  const maximumIndex = context.gxDecodeNormalAttribute(
    new Uint8Array([0xff, 0xff]),
    0,
    3,
    0,
    2,
    false,
  );
  assert.equal(maximumIndex.cursor, 2);
  assert.equal(maximumIndex.skipped, false);
  assertVector(maximumIndex.normal, [1, 0, 0]);
});

test("reports bounded GX normal-cache provenance", () => {
  assert.match(source, /let gxCachedNormal = \[0, 0, 0\];/);
  assert.match(source, /let gxCachedTangent = \[0, 0, 0\];/);
  assert.match(source, /let gxCachedBinormal = \[0, 0, 0\];/);
  assert.match(
    source,
    /normalCache: \{\s*commits: gxNormalCacheCommits,\s*normalUses: gxCachedNormalUses,\s*tangentUses: gxCachedTangentUses,\s*binormalUses: gxCachedBinormalUses,\s*normal: gxCachedNormal\.slice\(\),\s*tangent: gxCachedTangent\.slice\(\),\s*binormal: gxCachedBinormal\.slice\(\),\s*\}/,
  );
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

test("transforms NBT tangent and binormal vectors without normalizing their scale", () => {
  const context = workerContext();
  const matrixIndex = 6;
  const base = 0x400 + 3 * matrixIndex;
  [
    2, 0, 0,
    0, 3, 0,
    0, 0, 4,
  ].forEach((value, index) => setXfFloat(context, base + index, value));

  assertVector(
    context.gxTransformNormalVector([1, 1, 0], matrixIndex),
    [2, 3, 0],
  );
  assertVector(
    context.gxTransformNormalVector([0, 0, 0], matrixIndex),
    [0, 0, 0],
  );
  assert.ok(
    context.gxTransformNormal([0, 0, 0], matrixIndex).every(Number.isNaN),
    "only the lighting normal follows Common::Vec3::Normalized zero semantics",
  );
});

test("orders emboss dependencies before applying each stage's BP scale", () => {
  const context = workerContext();
  context.gxXfRegisters[0x103f] = 3;
  // Stage zero generates projective STQ from position. Stages one and two
  // successively emboss the preceding generated coordinate.
  context.gxXfRegisters[0x1040] = (1 << 1) | (1 << 2);
  context.gxXfRegisters[0x1041] = 1 << 4;
  context.gxXfRegisters[0x1042] = (1 << 4) | (1 << 12);
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  setXfNormalMatrix(context, 0, [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  setXfLightPosition(context, 0, [0, 0, 1]);
  [
    [2, 4],
    [1, 2],
    [3, 1],
  ].forEach(([scaleS, scaleT], texgenIndex) => {
    context.gxBpRegisters[0x30 + texgenIndex * 2] = scaleS;
    context.gxBpRegisters[0x31 + texgenIndex * 2] = scaleT;
  });
  const attributes = texgenAttributes({
    position: [2, 3, 4],
    embossTangent: [0, 0, 1],
    embossBinormal: [0, 0, 2],
  });
  const transformContext = context.gxPrepareVertexTransformContext();

  const result = context.gxTransformTexCoords(
    attributes,
    Array(8).fill(0),
    0,
    transformContext,
  );

  assertVector(result[0], [6, 15, 4]);
  assertVector(result[1], [6, 15, 4]);
  assertVector(result[2], [16, 14, 4]);
  assert.ok(result.slice(3).every(value => value === null));
  assert.equal(context.gxTexgenTransforms, 3);
  assert.equal(context.gxTexgenEmbossTransforms, 2);
  assert.equal(context.gxTexgenNonFiniteTransforms, 0);
  assert.equal(context.gxTexgenFallbacks, 0);
});

test("vertex decode feeds omitted NBT caches into view-space emboss", () => {
  const context = workerContext();
  // Direct XYZ position with no normal, tangent, binormal, color, or texture
  // attributes. The omitted NBT tuple must come from GX's persistent cache.
  context.gxCpRegisters[0x50] = 1 << 9;
  context.gxCpRegisters[0x70] = 1 | (4 << 1);
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  setXfNormalMatrix(context, 0, [
    2, 0, 0,
    0, 3, 0,
    0, 0, 4,
  ]);
  [1, 0, 1, 0, 1, 0].forEach((value, index) => {
    setXfFloat(context, 0x1020 + index, value);
  });
  context.gxXfRegisters[0x1026] = 1;
  [320, 264, 1, 320, 264, 0].forEach((value, index) => {
    setXfFloat(context, 0x101a + index, value);
  });
  context.gxXfRegisters[0x103f] = 1;
  context.gxXfRegisters[0x1040] = (1 << 4) | (7 << 12);
  setXfLightPosition(context, 0, [1, 5, 7]);
  context.gxCachedNormal = [0, 0, 1];
  context.gxCachedTangent = [1, 1, 0];
  context.gxCachedBinormal = [0, 1, 1];

  const sourceBytes = new Uint8Array(12);
  const sourceView = new DataView(sourceBytes.buffer);
  [1, 2, 3].forEach((value, index) => {
    sourceView.setFloat32(index * 4, value, false);
  });
  const transformContext = context.gxPrepareVertexTransformContext();
  const decoded = context.gxDecodeVertex(
    sourceBytes,
    0,
    0,
    transformContext,
  );

  assert.notEqual(decoded.skipped, true);
  assert.equal(decoded.rawTangent, null);
  assert.equal(decoded.rawBinormal, null);
  assertVector(decoded.texCoords[0], [1.8, 5, 0]);
  assert.equal(context.gxCachedTangentUses, 1);
  assert.equal(context.gxCachedBinormalUses, 1);
  assert.equal(context.gxTexgenEmbossTransforms, 1);
  assert.equal(context.gxTexgenFallbacks, 0);
});

test("emboss ignores unrelated texgen matrices and light fields", () => {
  const context = workerContext();
  const lightIndex = 2;
  const postIndex = 62;
  context.gxXfRegisters[0x103f] = 1;
  // Poison every regular-only field while selecting forward-initialized
  // texcoord seven and light two for emboss.
  context.gxXfRegisters[0x1040] = (1 << 1) | (1 << 2) | (1 << 4)
    | (31 << 7) | (7 << 12) | (lightIndex << 15);
  context.gxXfRegisters[0x1012] = 1;
  context.gxXfRegisters[0x1050] = 0x100 | postIndex;
  context.gxXfRegisters[63 * 4] = 0x7fc00000;
  context.gxXfRegisters[0x500 + postIndex * 4] = 0x7fc00000;
  context.gxXfRegisters[0x603 + lightIndex * 0x10 + 1] = 0x7fc00000;
  setXfNormalMatrix(context, 0, [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  setXfLightPosition(context, lightIndex, [0, 0, 1]);
  context.gxBpRegisters[0x30] = 1;
  context.gxBpRegisters[0x31] = 2;
  const attributes = texgenAttributes({
    embossTangent: [1, 0, 1],
    embossBinormal: [0, 2, 1],
  });
  const transformContext = context.gxPrepareVertexTransformContext();

  const result = context.gxTransformTexCoords(
    attributes,
    Array(8).fill(63),
    0,
    transformContext,
  );

  assertVector(result[0], [2, 3, 0]);
  assert.equal(context.gxXfLight(lightIndex), null);
  assert.equal(transformContext.lights[lightIndex], undefined);
  assert.equal(transformContext.texgenRows[63], undefined);
  assert.equal(transformContext.texgenPostRows[postIndex], undefined);
  assertVector(transformContext.embossLightPositions[lightIndex], [0, 0, 1]);
  assert.equal(context.gxTexgenEmbossTransforms, 1);
  assert.equal(context.gxTexgenFallbacks, 0);
});

test("emboss direct and cached paths agree and retain draw-scoped XF state", () => {
  const context = workerContext();
  const lightIndex = 3;
  context.gxXfRegisters[0x103f] = 2;
  context.gxXfRegisters[0x1040] = (1 << 1) | (1 << 2);
  context.gxXfRegisters[0x1041] = (1 << 4) | (lightIndex << 15);
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  setXfNormalMatrix(context, 0, [
    2, 0, 0,
    0, 3, 0,
    0, 0, 4,
  ]);
  setXfLightPosition(context, lightIndex, [4, 6, 3]);
  const attributes = texgenAttributes({
    position: [2, 3, 4],
    viewPosition: [1, 2, 3],
    embossTangent: [1, 0, 0],
    embossBinormal: [0, 1, 0],
  });
  const matrixIndices = Array(8).fill(0);

  const direct = context.gxTransformTexCoords(
    attributes,
    matrixIndices,
    0,
  );
  const transformContext = context.gxPrepareVertexTransformContext();
  const cached = context.gxTransformTexCoords(
    attributes,
    matrixIndices,
    0,
    transformContext,
  );
  assertVector(direct[0], [2, 3, 4]);
  assertVector(direct[1], [3.2, 5.4, 4]);
  assert.deepEqual(plain(cached), plain(direct));

  setXfNormalMatrix(context, 0, [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  setXfLightPosition(context, lightIndex, [1, 2, 5]);
  const reused = context.gxTransformTexCoords(
    attributes,
    matrixIndices,
    0,
    transformContext,
  );
  const changedDirect = context.gxTransformTexCoords(
    attributes,
    matrixIndices,
    0,
  );
  assert.deepEqual(plain(reused), plain(cached));
  assertVector(changedDirect[1], [2, 3, 4]);
});

test("zero normal matrices remain valid for emboss and telemetry exposes gaps", () => {
  const context = workerContext();
  context.gxXfRegisters[0x103f] = 2;
  context.gxXfRegisters[0x1040] = (1 << 4) | (7 << 12);
  // Values four through seven are reserved in the three-bit hardware field.
  context.gxXfRegisters[0x1041] = 4 << 4;
  setXfLightPosition(context, 0, [0, 0, 1]);
  const attributes = texgenAttributes({
    embossTangent: [1, 2, 3],
    embossBinormal: [4, 5, 6],
  });
  const transformContext = context.gxPrepareVertexTransformContext();

  const result = context.gxTransformTexCoords(
    attributes,
    Array(8).fill(0),
    0,
    transformContext,
  );

  assertVector(result[0], [0, 0, 0]);
  assert.equal(result[1], null);
  assert.deepEqual(plain(transformContext.normalMatrices[0]), Array(9).fill(0));
  assert.equal(context.gxTexgenTransforms, 1);
  assert.equal(context.gxTexgenEmbossTransforms, 1);
  assert.equal(context.gxTexgenNonFiniteTransforms, 0);
  assert.equal(context.gxTexgenFallbacks, 1);
  assert.match(source, /let gxTexgenEmbossTransforms = 0;/);
  assert.match(
    source,
    /texgenEmbossTransforms: gxTexgenEmbossTransforms/,
  );
});

test("normal-source projective texgen scales post-transform ST but preserves Q", () => {
  const context = workerContext();
  const matrixIndex = 9;
  const postIndex = 5;
  context.gxXfRegisters[0x103f] = 1;
  // Vec3 output, ABC1 input, transform texgen, source row 1 (normal).
  context.gxXfRegisters[0x1040] = 0x86;
  context.gxXfRegisters[0x1012] = 0;
  setXfMatrixRows(context, 0, matrixIndex, [
    [2, 0, 0, 0],
    [0, 3, 0, 0],
    [0, 0, 4, 1],
  ]);
  setXfMatrixRows(context, 0x500, postIndex, [
    [1, 0, 1, 0],
    [0, 1, -1, 0],
    [0, 0, 2, 1],
  ]);
  const attributes = {
    position: [11, 12, 13],
    normal: [1, 2, 3],
    tangent: [4, 5, 6],
    binormal: [7, 8, 9],
    colors: [[10, 20, 30, 40], [50, 60, 70, 80]],
    rawTextureCoords: [[0.25, 0.75], ...Array(7).fill(null)],
  };

  const unscaled = context.gxTransformTexCoord(attributes, matrixIndex, 0);
  assertVector(unscaled, [2, 6, 13]);
  assert.notDeepEqual(plain(unscaled), [2 / 13, 6 / 13, 1]);
  const unscaledContext = context.gxPrepareVertexTransformContext();
  assertVector(
    context.gxTransformTexCoord(attributes, matrixIndex, 0, unscaledContext),
    unscaled,
  );

  context.gxXfRegisters[0x1012] = 1;
  context.gxXfRegisters[0x1050] = postIndex;
  context.gxBpRegisters[0x30] = 2;
  context.gxBpRegisters[0x31] = 4;
  const scaled = context.gxTransformTexCoord(attributes, matrixIndex, 0);
  const scaledContext = context.gxPrepareVertexTransformContext();
  const cachedScaled = context.gxTransformTexCoord(
    attributes,
    matrixIndex,
    0,
    scaledContext,
  );
  const reusedScaled = context.gxTransformTexCoord(
    attributes,
    matrixIndex,
    0,
    scaledContext,
  );
  // Post-transform STQ is [15, -7, 27]. SU_SSIZE/SU_TSIZE then scale only
  // S/T by their low-16-bit values plus one.
  assertVector(scaled, [45, -35, 27]);
  assertVector(cachedScaled, scaled);
  assertVector(reusedScaled, scaled);
  assert.deepEqual(plain(cachedScaled), plain(scaled));
  assert.deepEqual(plain(reusedScaled), plain(scaled));
  assert.notDeepEqual(plain(scaled), [45 / 27, -35 / 27, 1]);
  assert.ok(context.gxVertexTransformCacheSnapshots >= 9);
  assert.ok(context.gxVertexTransformCacheMemoHits >= 6);
});

test("missing optional texgen sources retain Flipper's AB11 default", () => {
  const context = workerContext();
  context.gxXfRegisters[0x103f] = 1;
  // Vec3 output, ABC1 input, transform texgen, absent source row 1 (normal).
  context.gxXfRegisters[0x1040] = 0x86;
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  const attributes = {
    position: [11, 12, 13],
    normal: null,
    tangent: null,
    binormal: null,
    colors: [[10, 20, 30, 40], [50, 60, 70, 80]],
    rawTextureCoords: Array(8).fill(null),
  };

  const direct = context.gxTransformTexCoord(attributes, 0, 0);
  const transformContext = context.gxPrepareVertexTransformContext();
  const cached = context.gxTransformTexCoord(
    attributes,
    0,
    0,
    transformContext,
  );

  assert.deepEqual(plain(direct), [0, 0, 1]);
  assert.deepEqual(plain(cached), plain(direct));
  assert.equal(context.gxTexgenFallbacks, 0);
});

test("non-finite post texgen values remain transportable WebGPU STQ", () => {
  const context = workerContext();
  const postIndex = 54;
  context.gxXfRegisters[0x103f] = 1;
  // Vec3 output, ABC1 input, transform texgen, source row 0 (position).
  context.gxXfRegisters[0x1040] = 0x06;
  context.gxXfRegisters[0x1012] = 1;
  context.gxXfRegisters[0x1050] = postIndex;
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  setXfMatrixRows(context, 0x500, postIndex, [
    [Number.NaN, 0, 0, 0],
    [0, Number.POSITIVE_INFINITY, 0, 0],
    [0, 0, 1, 0],
  ]);
  const attributes = {
    position: [1, 2, 3],
    normal: null,
    tangent: null,
    binormal: null,
    colors: [[0, 0, 0, 0], [0, 0, 0, 0]],
    rawTextureCoords: Array(8).fill(null),
  };

  assert.equal(context.gxXfMatrixRow(0x500, postIndex), null);
  const direct = context.gxTransformTexCoord(attributes, 0, 0);
  const transformContext = context.gxPrepareVertexTransformContext();
  const cached = context.gxTransformTexCoord(
    attributes,
    0,
    0,
    transformContext,
  );

  for (const result of [direct, cached]) {
    assert.ok(Number.isNaN(result[0]));
    assert.equal(result[1], Number.POSITIVE_INFINITY);
    assert.equal(result[2], 3);
  }
  assert.equal(context.gxTexgenNonFiniteTransforms, 2);
  assert.equal(context.gxTevCoordsValid([direct], 1), false);
  assert.equal(context.gxTevCoordsTransportable([direct], 1), true);
  assert.equal(context.gxTevCoordsTransportable([null], 1), false);
});

test("cached texgen retains the final non-post matrix rows 63 through 65", () => {
  const context = workerContext();
  const matrixIndex = 63;
  context.gxXfRegisters[0x103f] = 1;
  // Vec3 output, ABC1 input, transform texgen, source row 0 (position).
  context.gxXfRegisters[0x1040] = 0x06;
  setXfMatrixRows(context, 0, matrixIndex, [
    [1, 0, 0, 10],
    [0, 1, 0, 20],
    [0, 0, 1, 30],
  ]);
  const attributes = {
    position: [2, 3, 4],
    normal: null,
    tangent: null,
    binormal: null,
    colors: [[0, 0, 0, 0], [0, 0, 0, 0]],
    rawTextureCoords: Array(8).fill(null),
  };

  const direct = context.gxTransformTexCoord(
    attributes,
    matrixIndex,
    0,
  );
  const transformContext = context.gxPrepareVertexTransformContext();
  const cached = context.gxTransformTexCoord(
    attributes,
    matrixIndex,
    0,
    transformContext,
  );
  const reused = context.gxTransformTexCoord(
    attributes,
    matrixIndex,
    0,
    transformContext,
  );

  assert.deepEqual(plain(direct), [12, 23, 34]);
  assert.deepEqual(plain(cached), plain(direct));
  assert.deepEqual(plain(reused), plain(direct));
  assert.deepEqual(
    plain(transformContext.texgenRows.slice(63, 66)),
    [
      [1, 0, 0, 10],
      [0, 1, 0, 20],
      [0, 0, 1, 30],
    ],
  );
  assert.equal(context.gxVertexTransformCacheSnapshots, 3);
  assert.equal(context.gxVertexTransformCacheMemoHits, 3);
});

test("cached dual texgen wraps post matrix 62 through rows 62, 63, and 0", () => {
  const context = workerContext();
  context.gxXfRegisters[0x103f] = 1;
  // Vec3 output, ABC1 input, transform texgen, source row 0 (position).
  context.gxXfRegisters[0x1040] = 0x06;
  context.gxXfRegisters[0x1012] = 1;
  context.gxXfRegisters[0x1050] = 62;
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  setXfMatrixRows(context, 0x500, 62, [
    [1, 0, 0, 10],
    [0, 1, 0, 20],
  ]);
  setXfMatrixRows(context, 0x500, 0, [
    [0, 0, 1, 30],
  ]);
  const attributes = {
    position: [2, 3, 4],
    normal: null,
    tangent: null,
    binormal: null,
    colors: [[0, 0, 0, 0], [0, 0, 0, 0]],
    rawTextureCoords: Array(8).fill(null),
  };

  const direct = context.gxTransformTexCoord(attributes, 0, 0);
  const transformContext = context.gxPrepareVertexTransformContext();
  const cached = context.gxTransformTexCoord(
    attributes,
    0,
    0,
    transformContext,
  );
  const reused = context.gxTransformTexCoord(
    attributes,
    0,
    0,
    transformContext,
  );

  assert.deepEqual(plain(direct), [12, 23, 34]);
  assert.deepEqual(plain(cached), plain(direct));
  assert.deepEqual(plain(reused), plain(direct));
  assert.deepEqual(plain(transformContext.texgenPostRows[62]), [1, 0, 0, 10]);
  assert.deepEqual(plain(transformContext.texgenPostRows[63]), [0, 1, 0, 20]);
  assert.deepEqual(plain(transformContext.texgenPostRows[0]), [0, 0, 1, 30]);
  assert.equal(context.gxVertexTransformCacheSnapshots, 6);
  assert.equal(context.gxVertexTransformCacheMemoHits, 6);
});

test("vertex transform caches retain zero matrices and raw row snapshots", () => {
  const context = workerContext();
  const transformContext = context.gxPrepareVertexTransformContext();

  const zeroPositionMatrix = context.gxVertexTransformPositionMatrix(
    transformContext,
    0,
  );
  assert.deepEqual(plain(zeroPositionMatrix), Array(12).fill(0));
  setXfMatrixRows(context, 0, 0, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  assert.deepEqual(
    plain(context.gxTransformPosition([2, -3, 4], 0, transformContext)),
    [0, 0, 0],
    "the draw snapshot keeps the zero matrix after later XF writes",
  );

  const zeroNormalMatrix = context.gxVertexTransformNormalMatrix(
    transformContext,
    0,
  );
  assert.deepEqual(plain(zeroNormalMatrix), Array(9).fill(0));
  [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ].forEach((value, index) => setXfFloat(context, 0x400 + index, value));
  assert.equal(
    context.gxVertexTransformNormalMatrix(transformContext, 0),
    zeroNormalMatrix,
  );

  const texgenRow = 10;
  context.gxXfRegisters[texgenRow * 4] = 0x7fc00000;
  const cachedTexgenRow = context.gxVertexTransformTexgenRow(
    transformContext,
    texgenRow,
    false,
  );
  assert.ok(Number.isNaN(cachedTexgenRow[0]));
  setXfMatrixRows(context, 0, texgenRow, [[1, 2, 3, 4]]);
  assert.equal(
    context.gxVertexTransformTexgenRow(transformContext, texgenRow, false),
    cachedTexgenRow,
  );

  const postRow = 11;
  context.gxXfRegisters[0x500 + postRow * 4] = 0x7fc00000;
  const cachedPostRow = context.gxVertexTransformTexgenRow(
    transformContext,
    postRow,
    true,
  );
  assert.ok(Number.isNaN(cachedPostRow[0]));
  setXfMatrixRows(context, 0x500, postRow, [[5, 6, 7, 8]]);
  assert.equal(
    context.gxVertexTransformTexgenRow(transformContext, postRow, true),
    cachedPostRow,
  );

  assert.equal(transformContext.positionMatrices[0], zeroPositionMatrix);
  assert.equal(transformContext.normalMatrices[0], zeroNormalMatrix);
  assert.equal(transformContext.texgenRows[texgenRow], cachedTexgenRow);
  assert.equal(transformContext.texgenPostRows[postRow], cachedPostRow);
  assert.equal(context.gxVertexTransformCacheSnapshots, 4);
  assert.equal(context.gxVertexTransformCacheMemoHits, 4);
});

test("BP texture-coordinate scales use low 16 bits and f32 multiplication", () => {
  const context = workerContext();
  const matrixIndex = 12;
  const texgenIndex = 3;
  context.gxXfRegisters[0x103f] = texgenIndex + 1;
  // Vec2 output, AB11 input, transform texgen, source row 8 (texcoord 3).
  context.gxXfRegisters[0x1040 + texgenIndex] = (8 << 7);
  context.gxBpRegisters[0x30 + texgenIndex * 2] = 0xab0002;
  context.gxBpRegisters[0x31 + texgenIndex * 2] = 0xcd0004;
  setXfMatrixRows(context, 0, matrixIndex, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  const rawTextureCoords = Array(8).fill(null);
  rawTextureCoords[3] = [0.1, -0.2];
  const attributes = {
    position: [0, 0, 0],
    normal: null,
    tangent: null,
    binormal: null,
    colors: [[1, 1, 1, 1], [1, 1, 1, 1]],
    rawTextureCoords,
  };

  const result = context.gxTransformTexCoord(
    attributes,
    matrixIndex,
    texgenIndex,
  );
  assert.equal(result[0], Math.fround(Math.fround(0.1) * 3));
  assert.equal(result[1], Math.fround(Math.fround(-0.2) * 5));
  assert.equal(result[2], 1);
  assert.notEqual(result[0], 0.1 * 3);
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
  assert.deepEqual(plain(decoded.position), [1, 2, 3]);
  assert.equal(decoded.positionMatrix, 0);
  assert.equal(decoded.texCoords.length, 8);

  const transformContext = context.gxPrepareVertexTransformContext();
  const prepared = context.gxDecodeVertex(
    sourceBytes,
    0,
    0,
    transformContext,
  );
  const reused = context.gxDecodeVertex(
    sourceBytes,
    0,
    0,
    transformContext,
  );
  assert.deepEqual(plain(prepared), plain(decoded));
  assert.deepEqual(plain(reused), plain(decoded));
  assert.equal(context.gxVertexTransformContextSnapshots, 1);
  assert.equal(context.gxVertexTransformCacheSnapshots, 2);
  assert.equal(context.gxVertexTransformCacheMemoHits, 2);
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

test("BP TEV writes keep konst physical slots and rotate color slots", () => {
  const context = workerContext();
  context.gxBpRegisters[0xfe] = 0x00ffffff;

  const writeBp = (address, value) => {
    context.recordGxBpWrite(
      ((address << 24) | (value & 0x00ffffff)) >>> 0,
    );
  };
  const pair = (first, second, konst) => (
    (konst ? 0x00800000 : 0)
    | ((second & 0x7ff) << 12)
    | (first & 0x7ff)
  );
  const writePair = (slot, color, konst) => {
    writeBp(0xe0 + slot * 2, pair(color[0], color[3], konst));
    writeBp(0xe1 + slot * 2, pair(color[2], color[1], konst));
  };

  const k0 = [0, 0, 226, 88];
  const k1 = [179, 0, 0, 182];
  const k2 = [255, 0, 255, 128];
  const c0 = [-90, 0, -114, 135];
  writePair(0, k0, true);
  writePair(1, k1, true);
  writePair(2, k2, true);
  // Color slot one is GX_TEVREG0; it must rotate to renderer register C0
  // without disturbing the independently stored K1 value.
  writePair(1, c0, false);

  assert.deepEqual(plain(context.gxTevKonstRegisters), [
    k0,
    k1,
    k2,
    [0, 0, 0, 0],
  ]);
  assert.deepEqual(plain(context.gxTevColorRegisters), [
    c0,
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  const packed = context.gxPackTevState([]);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const packedI32 = (offset, count) => Array.from(
    { length: count },
    (_unused, index) => view.getInt32(offset + index * 4, true),
  );
  assert.deepEqual(packedI32(256, 4), c0);
  assert.deepEqual(packedI32(320, 4), k0);
  assert.deepEqual(packedI32(336, 4), k1);
  assert.deepEqual(packedI32(352, 4), k2);
  assert.deepEqual(packedI32(368, 4), [0, 0, 0, 0]);
});

test("worker draw capture routes XF attributes through the TEV transport", () => {
  const capture = extractFunction("recordGxPrimitive");
  assert.match(capture, /gxPackTevState\s*\(/);
  assert.match(
    capture,
    /const inputVertexCount = vertexCount;\s*let sourceVertices = new Float32Array\(inputVertexCount \* 36\)/,
  );
  assert.match(
    capture,
    /if \(decoded\.positionIndexSkipped === true\) \{\s*gxPositionIndexSkips \+= 1;\s*positionIndexSkips \+= 1;\s*continue;/,
  );
  assert.match(capture, /const output = outputVertexCount \* 36/);
  assert.match(
    capture,
    /vertexCount = outputVertexCount;\s*sourceVertices = sourceVertices\.slice\(0, outputVertexCount \* 36\)/,
  );
  assert.doesNotMatch(capture, /const vertices = \[\]/);
  assert.match(capture, /vertices:\s*sourceVertices/);
  assert.match(capture, /const \[raster0, raster1\] = decoded\.rasterColors/);
  assert.match(capture, /rasterColorSets\[0\]\.push\(raster0\)/);
  assert.match(capture, /rasterColorSets\[1\]\.push\(raster1\)/);
  assert.doesNotMatch(capture, /decoded\.colors\s*\[/);
  assert.match(capture, /gxManagedCoverageStateCandidate\s*\(/);
  assert.match(capture, /sourcePositions\.push\(decoded\.position\)/);
  assert.match(capture, /positionMatrixIndices\.push\(decoded\.positionMatrix\)/);
  assert.match(capture, /exactGeometryRequired/);
  assert.match(capture, /gxManagedCoveragePostCullEvidence\s*\(/);
  assert.match(capture, /\{\s*postCullEvidence\s*\}/);
  assert.doesNotMatch(capture, /cullClipPositions/);
  assert.doesNotMatch(capture, /gxTextureForDraw\s*\(/);
});
