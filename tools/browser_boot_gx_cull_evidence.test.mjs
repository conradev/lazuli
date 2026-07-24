#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
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

const pureFunctions = [
  "gxCullF32",
  "gxCullMul",
  "gxCullAdd",
  "gxCullSub",
  "gxCullDot4Position",
  "gxCullDot4",
  "gxCullClipPositionIsInside",
  "gxCullNormalZ3",
  "gxCullNormalZ",
  "gxSourceTriangleCount",
  "gxSourceTriangleIndex",
  "gxExpandedTriangleIndices",
  "gxPostCullActionFromNormal",
  "gxPostCullAction",
  "gxPostCullEvidence",
  "gxTextureRegisters",
  "gxTextureSamplerState",
  "gxManagedCoverageStateCandidate",
  "gxManagedCoverageVerticesCandidate",
];

function pureContext() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    Uint8Array,
    gxBpRegisters: new Uint32Array(0x100),
  };
  vm.createContext(context);
  vm.runInContext(pureFunctions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.gx-cull-evidence.js",
  });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function f32Bits(value) {
  const storage = new ArrayBuffer(4);
  new Float32Array(storage)[0] = value;
  return new Uint32Array(storage)[0] >>> 0;
}

function f32BitPatterns(values) {
  return Array.from(values, f32Bits);
}

const front012 = [
  [0, 0, 0, 1],
  [1, 0, 0, 1],
  [0, 1, 0, 1],
];
const back021 = [front012[0], front012[2], front012[1]];

test("post-cull evidence expands every GX triangle topology canonically", () => {
  const context = pureContext();
  assert.deepEqual(plain(context.gxExpandedTriangleIndices(0, 3)), [
    [0, 1, 2],
  ]);
  assert.deepEqual(plain(context.gxExpandedTriangleIndices(0, 4)), [
    [0, 1, 2],
    [0, 2, 3],
  ]);
  assert.equal(context.gxExpandedTriangleIndices(0, 6).length, 2);
  assert.deepEqual(plain(context.gxExpandedTriangleIndices(1, 7)), [
    [0, 1, 2],
    [0, 2, 3],
    [4, 5, 6],
  ]);
  assert.deepEqual(plain(context.gxExpandedTriangleIndices(2, 7)), [
    [0, 1, 2],
    [3, 4, 5],
  ]);
  assert.deepEqual(plain(context.gxExpandedTriangleIndices(3, 5)), [
    [0, 1, 2],
    [1, 3, 2],
    [2, 3, 4],
  ]);
  assert.deepEqual(plain(context.gxExpandedTriangleIndices(4, 5)), [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
  ]);
  for (const topology of [5, 6, 7]) {
    assert.deepEqual(plain(context.gxExpandedTriangleIndices(topology, 8)), []);
  }
});

test("Dolphin-order f32 face decisions encode all raw cull outcomes", () => {
  const context = pureContext();
  assert.equal(context.gxCullNormalZ(front012), 1);
  assert.equal(context.gxCullNormalZ(back021), -1);
  const expected = [
    [2, 3],
    [0, 3],
    [2, 1],
    [0, 1],
  ];
  for (let cullMode = 0; cullMode < 4; cullMode += 1) {
    assert.deepEqual(
      [
        context.gxPostCullAction(front012, cullMode, -1),
        context.gxPostCullAction(back021, cullMode, -1),
      ],
      expected[cullMode],
    );
    assert.deepEqual(
      [
        context.gxPostCullAction(front012, cullMode, 1),
        context.gxPostCullAction(back021, cullMode, 1),
      ],
      expected[cullMode].toReversed(),
      "positive viewport height must invert only the backface/order bit",
    );
  }
  assert.equal(context.gxPostCullAction(front012, 0, 0), null);
  assert.equal(context.gxPostCullAction(front012, 0, Number.NaN), null);
});

test("positive-W zero-mask certification accepts boundaries and rejects one ULP outside", () => {
  const context = pureContext();
  for (const clip of [
    [1, 0, 0, 1],
    [-1, 0, 0, 1],
    [0, 1, 0, 1],
    [0, -1, 0, 1],
    [0, 0, 0, 1],
    [0, 0, -1, 1],
  ]) {
    assert.equal(context.gxCullClipPositionIsInside(clip), true);
  }
  const outside = Math.fround(1 + 2 ** -23);
  const below = Math.fround(-1 - 2 ** -23);
  for (const clip of [
    [outside, 0, 0, 1],
    [-outside, 0, 0, 1],
    [0, outside, 0, 1],
    [0, -outside, 0, 1],
    [0, 0, 2 ** -149, 1],
    [0, 0, below, 1],
    [0, 0, 0, 0],
    [0, 0, 0, -1],
    [0, 0, 0, Number.NaN],
  ]) {
    assert.equal(context.gxCullClipPositionIsInside(clip), false);
  }
  assert.equal(
    context.gxCullClipPositionIsInside([0, 0, 2 ** -80, 2 ** -80]),
    false,
    "a tiny positive Z remains outside even when f32(W * Z) underflows to zero",
  );
});

test("evidence preserves rounded-screen collisions, underflow, and collinear order", () => {
  const context = pureContext();
  const delta = 2 ** -19;
  const positive = [
    [0, 0, 0, 1],
    [3 / 8, 3 / 8, 0, 1],
    [3 / 4, 3 / 4 + delta, 0, 1],
  ];
  const negative = [
    [0, 0, 0, 1],
    [3 / 8, 3 / 8, 0, 1],
    [3 / 4, 3 / 4 - delta, 0, 1],
  ];
  assert.ok(context.gxCullNormalZ(positive) > 0);
  assert.ok(context.gxCullNormalZ(negative) < 0);
  const screen = (clip) => [
    Math.fround(clip[0] / clip[3] + 100),
    Math.fround(-clip[1] / clip[3] + 100),
  ];
  assert.deepEqual(positive.map(screen), negative.map(screen));

  const tiny = Math.fround(2 ** -100);
  const underflow = [
    [-0.5 * tiny, -0.5 * tiny, 0, tiny],
    [0.5 * tiny, -0.5 * tiny, 0, tiny],
    [-0.5 * tiny, 0.5 * tiny, 0, tiny],
  ];
  assert.equal(context.gxCullNormalZ(underflow), 0);
  assert.equal(context.gxPostCullAction(underflow, 0, -264), 3);

  const collinear = [
    [9 / 16, 9 / 16, 0, 1],
    [19 / 32, 37 / 64, 0, 1],
    [5 / 8, 19 / 32, 0, 1],
  ];
  assert.equal(context.gxCullNormalZ(collinear), 0);
  assert.equal(context.gxPostCullAction(collinear, 0, -264), 3);
  const snap = ([x, y]) => [Math.floor(x * 16 + 0.5), Math.floor(y * 16 + 0.5)];
  const [a, b, c] = [collinear[0], collinear[2], collinear[1]].map(snap);
  assert.deepEqual([a, b, c], [[9, 9], [10, 10], [10, 9]]);
  assert.equal(
    (b[0] - a[0]) * (c[1] - a[1])
      - (b[1] - a[1]) * (c[0] - a[0]),
    -1,
  );
});

test("quad evidence packs low bits first and rejects incomplete clip proof", () => {
  const context = pureContext();
  const quad = [
    [0, 0, 0, 1],
    [1, 0, 0, 1],
    [1, -1, 0, 1],
    [0, -1, 0, 1],
  ];
  assert.deepEqual(
    [...context.gxPostCullEvidence(0, 0, quad, -1)],
    [0x0f],
    "both positive-area quad triangles survive in 021 order",
  );
  assert.equal(
    context.gxPostCullEvidence(0, 0, [
      quad[0],
      [Math.fround(1 + 2 ** -23), 0, 0, 1],
      quad[2],
      quad[3],
    ], -1),
    null,
  );
  assert.equal(context.gxPostCullEvidence(5, 0, quad, -1), null);
  assert.equal(context.gxPostCullEvidence(2, 0, [], -1), null);
});

test("producer gates exact cull work to the receiver's current managed subset", () => {
  const context = pureContext();
  const pipeline = {
    cullMode: 0,
    pixelControl: 0,
    zTextureMode: 0,
    fogWords: [0, 0, 0, 0, 0],
    zMode: 0,
  };
  const stage = (texCoordIndex, textureMap) => ({
    textureEnabled: true,
    texCoordIndex,
    textureMap,
  });
  const setTextureMode = (
    textureMap,
    magFilter,
    minFilter,
    maxAnisotropy = 0,
  ) => {
    const { mode0 } = context.gxTextureRegisters(textureMap);
    context.gxBpRegisters[mode0] =
      (magFilter << 4) | (minFilter << 5) | (maxAnisotropy << 19);
  };

  assert.equal(
    context.gxManagedCoverageStateCandidate(2, 3, pipeline, []),
    true,
  );
  for (const override of [
    { cullMode: 3 },
    { pixelControl: 2 },
    { zTextureMode: 1 << 2 },
    { fogWords: [0, 0, 0, 2 << 21, 0] },
    { zMode: 1 | (1 << 4), pixelControl: 1 << 6 },
  ]) {
    assert.equal(
      context.gxManagedCoverageStateCandidate(
        2,
        3,
        { ...pipeline, ...override },
        [],
      ),
      false,
    );
  }

  setTextureMode(0, 1, 4);
  assert.equal(
    context.gxManagedCoverageStateCandidate(0, 4, pipeline, [stage(0, 0)]),
    true,
    "saved SMB min-linear/mag-linear coord0 draws enter the coarse evidence subset",
  );

  setTextureMode(1, 0, 0);
  assert.equal(
    context.gxManagedCoverageStateCandidate(
      0,
      4,
      pipeline,
      [stage(0, 0), stage(0, 1)],
    ),
    true,
    "every unique map may share the one live texcoord",
  );
  setTextureMode(1, 1, 0);
  assert.equal(
    context.gxManagedCoverageStateCandidate(
      0,
      4,
      pipeline,
      [stage(0, 0), stage(0, 1)],
    ),
    false,
    "one mismatched required map rejects the draw",
  );
  setTextureMode(1, 0, 0);

  for (const [name, magFilter, minFilter] of [
    ["nearest min with linear mag", 1, 0],
    ["linear min with nearest mag", 0, 4],
    ["mipmapped min mode", 0, 1],
  ]) {
    setTextureMode(0, magFilter, minFilter);
    assert.equal(
      context.gxManagedCoverageStateCandidate(0, 4, pipeline, [stage(0, 0)]),
      false,
      name,
    );
  }
  setTextureMode(0, 1, 4, 1);
  assert.equal(
    context.gxManagedCoverageStateCandidate(0, 4, pipeline, [stage(0, 0)]),
    false,
    "anisotropic sampling exceeds the managed sampler contract",
  );
  setTextureMode(0, 1, 4);
  assert.equal(
    context.gxManagedCoverageStateCandidate(
      0,
      4,
      pipeline,
      [stage(0, 0), stage(1, 0)],
    ),
    false,
    "two live texcoords exceed the producer subset",
  );
  assert.equal(
    context.gxManagedCoverageStateCandidate(5, 3, pipeline, []),
    false,
  );
});

test("texture sampling state is a complete per-draw snapshot outside decode identity", () => {
  const context = pureContext();
  const mode0 =
    2
    | (1 << 2)
    | (1 << 4)
    | (4 << 5)
    | (3 << 19);
  assert.deepEqual(
    { ...context.gxTextureSamplerState(mode0) },
    {
      wrapS: 2,
      wrapT: 1,
      magFilter: 1,
      minFilter: 4,
      maxAnisotropy: 3,
    },
  );
  assert.match(
    source,
    /const sampler = gxTextureSamplerState\(mode0\)/,
  );
  assert.match(
    source,
    /return \{ \.\.\.cached, \.\.\.sampler \}/,
    "cache hits must snapshot current mode0 without mutating earlier draws",
  );
  assert.match(
    source,
    /maxAnisotropy << 19/,
    "LZGX v4 must carry the anisotropy certificate to the receiver",
  );
});

test("saved-SMB-shaped textured quad keeps only depth and raster flatness gates", () => {
  const context = pureContext();
  const positions = [
    [96, 64],
    [544, 64],
    [544, 464],
    [96, 464],
  ];
  const liveStq = [
    [0, 0, 1],
    [2, 0, 1.5],
    [2, 2, 2],
    [0, 2, 0.75],
  ];
  const savedSmbVertices = positions.flatMap(([x, y], vertex) => [
    x,
    y,
    0x123456,
    [0.5, 1, 2, 4][vertex],
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    ...liveStq[vertex],
    ...Array.from(
      { length: 7 },
      (_unused, coord) => [
        vertex + coord / 8,
        vertex * 2 - coord / 16,
        1 + vertex + coord / 4,
      ],
    ).flat(),
  ]);
  assert.equal(savedSmbVertices.length, 4 * 36);
  assert.equal(
    context.gxManagedCoverageVerticesCandidate(0, savedSmbVertices),
    true,
    "varying W, live STQ, and unused STQ do not defeat producer evidence",
  );

  const varyingRaster = savedSmbVertices.slice();
  varyingRaster[2 * 36 + 4] = 0.5;
  assert.equal(
    context.gxManagedCoverageVerticesCandidate(0, varyingRaster),
    false,
  );

  const varyingDepth = savedSmbVertices.slice();
  varyingDepth[2 * 36 + 2] += 1;
  assert.equal(
    context.gxManagedCoverageVerticesCandidate(0, varyingDepth),
    false,
  );

  const invalidW = savedSmbVertices.slice();
  invalidW[3] = 0;
  assert.equal(context.gxManagedCoverageVerticesCandidate(0, invalidW), false);
});

test("draw capture gates cull-source collection with the actual textured stages", () => {
  assert.match(
    source,
    /const collectCullSources = gxManagedCoverageStateCandidate\(\s*topology,\s*vertexCount,\s*pipeline,\s*texturedStages\s*\)/,
  );
  assert.match(
    source,
    /const cullPositions = collectCullSources \? \[\] : null;\s*const cullMatrixIndices = collectCullSources \? \[\] : null;/,
  );
  assert.doesNotMatch(
    source,
    /gxManagedCoverageStateCandidate\([\s\S]{0,180}texturedStages\.length/,
  );
});

test("canonical cull clip transform rounds every scalar operation to f32", () => {
  const xf = new Float32Array(0x1100);
  xf.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set([1, 0, 1, 0, 1, 0], 0x1020);
  const registers = new Uint32Array(xf.buffer);
  registers[0x1026] = 0;
  const context = {
    Array,
    Math,
    Number,
    gxXfRegisters: registers,
    gxXfFloat(address) {
      return xf[address];
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
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
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-cull-transform.js" },
  );
  assert.deepEqual(
    plain(context.gxCullClipPosition([0.5, -0.25, -1], 0)),
    [0.5, -0.25, -1, 1],
  );
  registers[0x1026] = 1;
  assert.deepEqual(
    plain(context.gxCullClipPosition([0.5, -0.25, -1], 0)),
    [0.5, -0.25, -1, 1],
  );
});

test("one per-draw cull state reuses exact position matrices", () => {
  const xf = new Float32Array(0x1100);
  xf.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set([1, 0, 1, 0, 1, 0], 0x1020);
  const registers = new Uint32Array(xf.buffer);
  registers[0x1026] = 1;
  let reads = 0;
  const context = {
    Array,
    Math,
    Number,
    gxXfRegisters: registers,
    gxXfFloat(address) {
      reads += 1;
      return xf[address];
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
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
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-cull-cache.js" },
  );
  const state = context.gxCullTransformState();
  assert.equal(reads, 6, "projection is read once per draw");
  context.gxCullClipPosition([1, 2, 3], 0, state);
  assert.equal(reads, 18, "the first matrix use reads twelve scalars");
  context.gxCullClipPosition([4, 5, 6], 0, state);
  assert.equal(reads, 18, "later vertices reuse the cached matrix");
});

test("canonical cull transform uses non-fused left-associated f32 dot products", () => {
  const xf = new Float32Array(0x1100);
  const onePlusTwoNeg23 = 1 + 2 ** -23;
  const oneMinusTwoNeg23 = 1 - 2 ** -23;
  xf.set([
    // The exact first product is 1 - 2^-46. Scalar f32 multiplication rounds
    // it to 1 before adding -1; a fused multiply-add would retain the residue.
    onePlusTwoNeg23, -1, 0, 0,
    // The first product rounds to 2^24. Left-associated addition rounds the
    // following +1 tie back to 2^24 before subtracting 2^24; reassociation
    // would instead produce 1.
    16777218, 1, -16777216, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set([1, 0, 1, 0, 1, 0], 0x1020);
  const registers = new Uint32Array(xf.buffer);
  registers[0x1026] = 1;
  const context = {
    Array,
    Math,
    Number,
    gxXfRegisters: registers,
    gxXfFloat(address) {
      return xf[address];
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
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
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-cull-association.js" },
  );

  assert.deepEqual(
    f32BitPatterns(context.gxCullViewPosition([oneMinusTwoNeg23, 1, 1], 0)),
    [0x00000000, 0x00000000, 0x3f800000],
    "expected bits independently pin product rounding and left-to-right accumulation",
  );
  assert.deepEqual(
    f32BitPatterns(context.gxCullClipPosition([oneMinusTwoNeg23, 1, 1], 0)),
    [0x00000000, 0x00000000, 0x3f800000, 0x3f800000],
  );
});
