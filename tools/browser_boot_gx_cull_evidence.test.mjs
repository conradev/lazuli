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
  "gxCullDiv",
  "gxCullAdd",
  "gxCullSub",
  "gxCullDot4Position",
  "gxCullDot4",
  "gxExactClipVertexIsValid",
  "gxExactClipVertexListIsValid",
  "gxExactClipMask",
  "gxExactClipDifferentSigns",
  "gxExactClipPlaneDistance",
  "gxExactClipVertex",
  "gxExactClipPolygon",
  "gxExactTriangulateClipPolygon",
  "gxExactPostClipTriangles",
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

function recoveryDecodedVertex(index, projected) {
  const raster0 = [index / 4, 0.25, 0.5, 1];
  const raster1 = [0.75, index / 8, 0.125, 1];
  const texCoords = Array.from({ length: 8 }, (_unused, coord) => [
    index + coord + 0.25,
    index + coord + 0.5,
    index + coord + 0.75,
  ]);
  return {
    skipped: false,
    projected,
    position: [index + 0.125, index + 0.25, -index - 1],
    positionMatrix: index + 3,
    colors: [[255, 255, 255, 255], [255, 255, 255, 255]],
    rasterColors: [raster0, raster1],
    texCoords,
    rawTextureCoords: texCoords.map(coord => coord.slice(0, 2)),
    normal: [0, 0, 1],
    textureMatrices: Array.from({ length: 8 }, (_unused, matrix) => matrix),
  };
}

function recoveryContext({
  decodedVertices,
  exactResult = { tag: "exact-input" },
  collectCullSources = false,
  postCullResult = null,
  textureEnabled = false,
} = {}) {
  const exactCalls = [];
  const postCullCalls = [];
  const textureCalls = [];
  const stage = {
    index: 0,
    order: 0,
    textureMap: 0,
    texCoordIndex: 0,
    textureEnabled,
    colorChannel: 0,
    colorCombiner: 0,
    alphaCombiner: 0,
    konstColorSelector: 0,
    konstAlphaSelector: 0,
  };
  const context = {
    Array,
    Float32Array,
    Map,
    Math,
    Number,
    Object,
    String,
    Uint8Array,
    Uint32Array,
    gxCollectFrameGeometry: true,
    gxSkippedGeometryPrimitives: 0,
    gxSkippedGeometryVertices: 0,
    gxFrameSkippedPrimitives: 0,
    gxBpRegisters: new Uint32Array(0x100),
    gxCpRegisters: new Uint32Array(0x100),
    gxFrameDrawVertices: 0,
    gxVertexDecodeErrors: 0,
    gxDecodedVertices: 0,
    gxProjectedVertices: 0,
    gxDroppedVertices: 0,
    gxLegacyProjectionNullVertices: 0,
    gxExactRequiredDraws: 0,
    gxExactRequiredVertices: 0,
    gxExactRequiredCaptureMisses: 0,
    gxTexturedDraws: 0,
    statusDataset: {},
    gxTevModeCounts: new Map(),
    gxFrameDraws: [],
    gxTevColorRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxTevKonstRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxPrimitiveSamples: [],
    gxRecentPrimitiveSamples: [],
    cycles: 11,
    dispatches: 13,
    gxDrawPipelineState() {
      return { cullMode: 1 };
    },
    gxTevStageState() {
      return stage;
    },
    gxManagedCoverageStateCandidate() {
      return collectCullSources;
    },
    gxDecodeVertex(_source, start) {
      const decoded = decodedVertices[start];
      return { ...decoded, cursor: start + 1 };
    },
    gxTevCoordsValid() {
      return true;
    },
    gxTevTextures() {
      textureCalls.push(true);
      return [];
    },
    gxManagedCoverageVerticesCandidate() {
      if (!collectCullSources) {
        throw new Error("required recovery consulted optional vertex evidence");
      }
      return true;
    },
    gxManagedCoveragePostCullEvidence(...args) {
      postCullCalls.push(args);
      return postCullResult;
    },
    gxManagedCoverageExactClipInput(...args) {
      exactCalls.push(args);
      return exactResult;
    },
    gxXfFloat() {
      return 264;
    },
    gxPackTevState() {
      return new Uint8Array(464);
    },
    gxTextureSummary(texture) {
      return texture;
    },
    hex32(value) {
      return "0x" + (value >>> 0).toString(16).padStart(8, "0");
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("recordGxPrimitive"), context, {
    filename: "browser_boot.gx-projection-recovery.js",
  });
  return { context, exactCalls, postCullCalls, textureCalls };
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

test("exact GX clip masks preserve all six Dolphin plane decisions", () => {
  const context = pureContext();
  const outside = Math.fround(1 + 2 ** -23);
  assert.equal(context.gxExactClipMask([1, 0, 0, 1]), 0);
  assert.equal(context.gxExactClipMask([-1, 0, 0, 1]), 0);
  assert.equal(context.gxExactClipMask([0, 1, 0, 1]), 0);
  assert.equal(context.gxExactClipMask([0, -1, 0, 1]), 0);
  assert.equal(context.gxExactClipMask([0, 0, 0, 1]), 0);
  assert.equal(context.gxExactClipMask([0, 0, -1, 1]), 0);
  assert.equal(context.gxExactClipMask([outside, 0, 0, 1]), 0x01);
  assert.equal(context.gxExactClipMask([-outside, 0, 0, 1]), 0x02);
  assert.equal(context.gxExactClipMask([0, outside, 0, 1]), 0x04);
  assert.equal(context.gxExactClipMask([0, -outside, 0, 1]), 0x08);
  assert.equal(context.gxExactClipMask([0, 0, 2 ** -149, 1]), 0x10);
  assert.equal(context.gxExactClipMask([0, 0, -outside, 1]), 0x20);
  assert.equal(context.gxExactClipMask([0, 0, 0, -1]), 0x2f);
  assert.equal(context.gxExactClipMask([0, 0, 0, 0]), 0);
  assert.equal(
    context.gxExactClipMask([0, 0, 2 ** -80, 2 ** -80]),
    0,
    "the exact W*Z mask retains f32 underflow instead of the conservative certificate",
  );
  assert.equal(context.gxExactClipMask([Number.NaN, 0, 0, 1]), null);
  assert.equal(context.gxExactClipMask([1e39, 0, 0, 1]), null);
  assert.equal(context.gxExactClipMask(new Array(4)), null);
  const sparsePayload = [0, 0, 0, 1];
  sparsePayload.length = 5;
  assert.equal(context.gxExactClipMask(sparsePayload), null);
});

test("ordered f32 clipping interpolates payloads and fans one outside vertex", () => {
  const context = pureContext();
  const triangle = [
    [0, 0, -0.5, 1, 0],
    [2, 0, -0.5, 1, 2],
    [0, 1, -0.5, 1, 4],
  ];
  const polygon = context.gxExactClipPolygon(triangle, 0x01);
  assert.deepEqual(plain(polygon), [
    [0, 0, -0.5, 1, 0],
    [1, 0, -0.5, 1, 1],
    [1, 0.5, -0.5, 1, 3],
    [0, 1, -0.5, 1, 4],
  ]);
  assert.deepEqual(
    plain(context.gxExactTriangulateClipPolygon(polygon)),
    [
      [polygon[0], polygon[1], polygon[2]],
      [polygon[0], polygon[2], polygon[3]],
    ].map(plain),
  );

  const interpolated = context.gxExactClipVertex(
    0.17358385026454926,
    [0, 0, 0, 1, 18364432],
    [0, 0, 0, 1, -8323480.5],
  );
  assert.equal(
    f32Bits(interpolated[4]),
    0x4b518802,
    "OUT + f32((IN - OUT) * T) must not collapse into one late-f64 expression",
  );
  assert.equal(
    f32Bits(
      Math.fround(
        18364432
        + (-8323480.5 - 18364432) * Math.fround(0.17358385026454926),
      ),
    ),
    0x4b518801,
  );
});

test("ordered polygon walk clips every plane and preserves boundary transitions", () => {
  const context = pureContext();
  const insideA = [0, 0, -0.5, 1];
  const insideB = [0, 0.5, -0.5, 1];
  const cases = [
    [0x01, [2, 0, -0.5, 1], [-1, 0, 0, 1]],
    [0x02, [-2, 0, -0.5, 1], [1, 0, 0, 1]],
    [0x04, [0, 2, -0.5, 1], [0, -1, 0, 1]],
    [0x08, [0, -2, -0.5, 1], [0, 1, 0, 1]],
    [0x10, [0, 0, -0.5, -1], [0, 0, 0, 1]],
    [0x20, [0, 0, -2, 1], [0, 0, 1, 1]],
  ];
  for (const [bit, outside, plane] of cases) {
    const polygon = context.gxExactClipPolygon(
      [insideA, outside, insideB],
      bit,
    );
    assert.equal(polygon.length, 4, `plane bit ${bit.toString(16)}`);
    const distances = polygon.map(vertex =>
      context.gxExactClipPlaneDistance(vertex, plane)
    );
    assert.equal(
      distances.filter(distance => Object.is(distance, 0)).length,
      2,
      `plane bit ${bit.toString(16)} emits both boundary intersections`,
    );
    assert.ok(distances.every(distance => distance >= 0));
  }

  assert.equal(
    context.gxExactClipPolygon(
      [
        [0, 0, -0.5, 1],
        [2, 0, -0.5, 1],
        [2, 1, -0.5, 1],
      ],
      0x01,
    ).length,
    3,
    "two outside vertices reduce to one triangle",
  );

  const multiPlane = context.gxExactClipPolygon(
    [
      [0, 0, -0.5, 1],
      [2, 2, -0.5, 1],
      [0, 0.5, -0.5, 1],
    ],
    0x01 | 0x04,
  );
  assert.deepEqual(plain(multiPlane), [
    [0, 0, -0.5, 1],
    [1, 1, -0.5, 1],
    [1, 1, -0.5, 1],
    [0.6666666269302368, 1, -0.5, 1],
    [0, 0.5, -0.5, 1],
  ]);
  assert.equal(f32Bits(multiPlane[3][0]), 0x3f2aaaaa);
  assert.equal(
    context.gxExactTriangulateClipPolygon(multiPlane).length,
    3,
    "the literal GX transition rule retains its on-plane duplicate fan vertex",
  );
});

test("exact triangle processing rejects, culls, reorders, and clips in GX order", () => {
  const context = pureContext();
  const front = [
    [0, 0, -0.5, 1, 0],
    [2, 0, -0.5, 1, 2],
    [0, 1, -0.5, 1, 4],
  ];
  const back = [front[0], front[2], front[1]];
  const frontTriangles = context.gxExactPostClipTriangles(front, 0, -264);
  assert.equal(frontTriangles.length, 2);
  assert.deepEqual(
    plain(context.gxExactPostClipTriangles(back, 0, -264)),
    plain(frontTriangles),
    "backfaces reorder 021 before the ordered plane walk",
  );
  assert.equal(
    context.gxExactPostClipTriangles(front, 1, -264).length,
    0,
    "GX back-cull mode rejects the front-facing source triangle",
  );
  assert.equal(
    context.gxExactPostClipTriangles(
      [
        [2, 0, -0.5, 1],
        [2, 1, -0.5, 1],
        [2, -1, -0.5, 1],
      ],
      0,
      -264,
    ).length,
    0,
    "the per-vertex mask AND trivially rejects before culling",
  );

  const mixedPositiveZ = [
    [0, 0, -0.5, 1],
    [1, 0, 0.25, 1],
    [0, 1, -0.5, 1],
  ];
  assert.deepEqual(
    plain(context.gxExactPostClipTriangles(mixedPositiveZ, 0, -264)),
    [mixedPositiveZ],
    "Dolphin's +Z mask deliberately walks the W >= 0 polygon plane",
  );
  assert.equal(
    context.gxExactPostClipTriangles(
      mixedPositiveZ.map(vertex => [vertex[0], vertex[1], 0.25, 1]),
      0,
      -264,
    ).length,
    0,
    "three positive-Z masks still trigger the earlier trivial reject",
  );
  assert.equal(context.gxExactPostClipTriangles(null, 0, -264), null);
  assert.equal(context.gxExactClipPolygon(front, 0x40), null);
  assert.equal(
    context.gxExactPostClipTriangles([front[0], , front[2]], 0, -264),
    null,
  );
  assert.equal(
    context.gxExactClipPolygon([front[0], , front[2]], 0),
    null,
  );
  assert.equal(
    context.gxExactPostClipTriangles(front, 0, 1e-300),
    null,
    "viewport height is certified after conversion to f32",
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
  const mode1 = 0xabcd1234;
  assert.deepEqual(
    { ...context.gxTextureSamplerState(mode0, mode1) },
    {
      mode0: (mode0 & 0x0039ffff) >>> 0,
      mode1: 0x1234,
      wrapS: 2,
      wrapT: 1,
      magFilter: 1,
      minFilter: 4,
      maxAnisotropy: 3,
    },
  );
  assert.match(
    source,
    /const sampler = gxTextureSamplerState\(mode0, mode1\)/,
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

test("draw capture keeps raw position provenance independent of managed eligibility", () => {
  const capture = extractFunction("recordGxPrimitive");
  assert.match(
    capture,
    /const collectCullSources = gxManagedCoverageStateCandidate\(\s*topology,\s*vertexCount,\s*pipeline,\s*texturedStages\s*\)/,
  );
  assert.match(
    capture,
    /const sourcePositions = \[\];\s*const positionMatrixIndices = \[\];/,
  );
  assert.match(
    capture,
    /sourcePositions\.push\(decoded\.position\);\s*positionMatrixIndices\.push\(decoded\.positionMatrix\);/,
  );
  assert.doesNotMatch(
    capture,
    /if \(collectCullSources\)[\s\S]{0,160}sourcePositions\.push/,
  );
  assert.doesNotMatch(
    capture,
    /gxManagedCoverageStateCandidate\([\s\S]{0,180}texturedStages\.length/,
  );
});

test("projection-null recovery emits one required draw with canonical source payload", () => {
  const decodedVertices = [
    recoveryDecodedVertex(0, [10, 20, 30, 2]),
    recoveryDecodedVertex(1, null),
    recoveryDecodedVertex(2, [50, 60, 70, 4]),
  ];
  const { context, exactCalls, postCullCalls } = recoveryContext({
    decodedVertices,
  });

  context.recordGxPrimitive(0x90, new Uint8Array(3), 0, 3, 1);

  assert.equal(context.gxFrameDraws.length, 1);
  const draw = context.gxFrameDraws[0];
  assert.equal(draw.exactGeometryRequired, true);
  assert.deepEqual(plain(draw.exactClipInput), { tag: "exact-input" });
  assert.equal(Object.hasOwn(draw, "postCullEvidence"), false);
  assert.equal(postCullCalls.length, 0);
  assert.equal(exactCalls.length, 1);
  assert.equal(exactCalls[0][0], 2);
  assert.equal(exactCalls[0][1], 1);
  assert.deepEqual(
    plain(exactCalls[0][2]),
    decodedVertices.map(vertex => vertex.position),
  );
  assert.deepEqual(
    plain(exactCalls[0][3]),
    decodedVertices.map(vertex => vertex.positionMatrix),
  );

  const recovered = Array.from(draw.vertices.slice(36, 72));
  const expected = Array.from(Float32Array.from([
    0, 0, 0, 1,
    ...decodedVertices[1].rasterColors[0],
    ...decodedVertices[1].rasterColors[1],
    ...decodedVertices[1].texCoords.flat(),
  ]));
  assert.deepEqual(recovered, expected);
  assert.equal(context.gxDecodedVertices, 3);
  assert.equal(context.gxProjectedVertices, 2);
  assert.equal(context.gxDroppedVertices, 0);
  assert.equal(context.gxLegacyProjectionNullVertices, 1);
  assert.equal(context.gxExactRequiredDraws, 1);
  assert.equal(context.gxExactRequiredVertices, 3);
  assert.equal(context.gxExactRequiredCaptureMisses, 0);
  assert.equal(context.gxFrameDrawVertices, 3);
});

test("required capture failure suppresses draw and all committed-draw telemetry", () => {
  const decodedVertices = [
    recoveryDecodedVertex(0, [10, 20, 30, 2]),
    recoveryDecodedVertex(1, null),
    recoveryDecodedVertex(2, [50, 60, 70, 4]),
  ];
  const { context, exactCalls, postCullCalls, textureCalls } = recoveryContext({
    decodedVertices,
    exactResult: null,
    textureEnabled: true,
  });

  context.recordGxPrimitive(0x90, new Uint8Array(3), 0, 3, 1);

  assert.equal(exactCalls.length, 1);
  assert.equal(postCullCalls.length, 0);
  assert.equal(textureCalls.length, 0);
  assert.equal(context.gxFrameDraws.length, 0);
  assert.equal(context.gxFrameDrawVertices, 0);
  assert.equal(context.gxTexturedDraws, 0);
  assert.equal(context.gxTevModeCounts.size, 0);
  assert.equal(context.gxLegacyProjectionNullVertices, 1);
  assert.equal(context.gxExactRequiredDraws, 0);
  assert.equal(context.gxExactRequiredVertices, 0);
  assert.equal(context.gxExactRequiredCaptureMisses, 1);
  assert.equal(context.gxDroppedVertices, 1);
});

test("required recovery rejects nonfinite transported source attributes", () => {
  const decodedVertices = [
    recoveryDecodedVertex(0, [10, 20, 30, 2]),
    recoveryDecodedVertex(1, null),
    recoveryDecodedVertex(2, [50, 60, 70, 4]),
  ];
  decodedVertices[1].texCoords[7][2] = Number.MAX_VALUE;
  const { context, exactCalls, postCullCalls } = recoveryContext({
    decodedVertices,
  });

  context.recordGxPrimitive(0x90, new Uint8Array(3), 0, 3, 1);

  assert.equal(exactCalls.length, 1);
  assert.equal(postCullCalls.length, 0);
  assert.equal(context.gxFrameDraws.length, 0);
  assert.equal(context.gxFrameDrawVertices, 0);
  assert.equal(context.gxExactRequiredCaptureMisses, 1);
  assert.equal(context.gxDroppedVertices, 1);
});

test("a later skipped vertex drops an earlier unrecovered projection-null vertex", () => {
  const decodedVertices = [
    recoveryDecodedVertex(0, null),
    { skipped: true },
    recoveryDecodedVertex(2, [50, 60, 70, 4]),
  ];
  const { context, exactCalls, postCullCalls, textureCalls } = recoveryContext({
    decodedVertices,
    textureEnabled: true,
  });

  context.recordGxPrimitive(0x90, new Uint8Array(3), 0, 3, 1);

  assert.equal(exactCalls.length, 0);
  assert.equal(postCullCalls.length, 0);
  assert.equal(textureCalls.length, 0);
  assert.equal(context.gxFrameDraws.length, 0);
  assert.equal(context.gxFrameDrawVertices, 0);
  assert.equal(context.gxDecodedVertices, 2);
  assert.equal(context.gxProjectedVertices, 1);
  assert.equal(context.gxLegacyProjectionNullVertices, 1);
  assert.equal(context.gxDroppedVertices, 2);
  assert.equal(context.gxExactRequiredCaptureMisses, 0);
  assert.equal(context.gxTexturedDraws, 0);
  assert.equal(context.gxTevModeCounts.size, 0);
});

test("all-projected draws preserve post-cull and optional exact behavior", () => {
  const decodedVertices = [
    recoveryDecodedVertex(0, [10, 20, 30, 2]),
    recoveryDecodedVertex(1, [20, 30, 40, 3]),
    recoveryDecodedVertex(2, [50, 60, 70, 4]),
  ];
  const postCullEvidence = Uint8Array.of(3);
  const evidenced = recoveryContext({
    decodedVertices,
    collectCullSources: true,
    postCullResult: postCullEvidence,
  });
  evidenced.context.recordGxPrimitive(0x90, new Uint8Array(3), 0, 3, 1);
  const evidencedDraw = evidenced.context.gxFrameDraws[0];
  assert.strictEqual(evidencedDraw.postCullEvidence, postCullEvidence);
  assert.equal(Object.hasOwn(evidencedDraw, "exactClipInput"), false);
  assert.equal(Object.hasOwn(evidencedDraw, "exactGeometryRequired"), false);
  assert.equal(evidenced.exactCalls.length, 0);

  const optional = recoveryContext({
    decodedVertices,
    collectCullSources: true,
    postCullResult: null,
  });
  optional.context.recordGxPrimitive(0x90, new Uint8Array(3), 0, 3, 1);
  const optionalDraw = optional.context.gxFrameDraws[0];
  assert.deepEqual(plain(optionalDraw.exactClipInput), { tag: "exact-input" });
  assert.equal(Object.hasOwn(optionalDraw, "postCullEvidence"), false);
  assert.equal(Object.hasOwn(optionalDraw, "exactGeometryRequired"), false);
  assert.equal(optional.postCullCalls.length, 1);
  assert.equal(optional.exactCalls.length, 1);
});

test("projection recovery and lighting rejection counters are exposed in decoder telemetry", () => {
  for (const counter of [
    "gxLightingRejectedVertices",
    "gxLegacyProjectionNullVertices",
    "gxExactRequiredDraws",
    "gxExactRequiredVertices",
    "gxExactRequiredCaptureMisses",
  ]) {
    assert.match(source, new RegExp(`let ${counter} = 0;`));
  }
  for (const [field, counter] of [
    ["lightingRejectedVertices", "gxLightingRejectedVertices"],
    ["legacyProjectionNullVertices", "gxLegacyProjectionNullVertices"],
    ["exactRequiredDraws", "gxExactRequiredDraws"],
    ["exactRequiredVertices", "gxExactRequiredVertices"],
    ["exactRequiredCaptureMisses", "gxExactRequiredCaptureMisses"],
  ]) {
    assert.match(source, new RegExp(`${field}: ${counter}`));
  }
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

test("exact projection and viewport model pins scalar f32 operation order", () => {
  const xf = new Float32Array(0x1100);
  xf.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set([
    1.0000001192092896,
    -0.3333333432674408,
    0.75,
    0.125,
    1.25,
    -0.5,
  ], 0x1020);
  xf.set([320, -264, 16777215, 342, 342, 0], 0x101a);
  const registers = new Uint32Array(xf.buffer);
  registers[0x1026] = 0;
  const bp = new Uint32Array(0x100);
  bp[0x20] = (342 << 12) | 342;
  bp[0x21] = ((342 + 639) << 12) | (342 + 527);
  bp[0x59] = 171 | (171 << 10);
  const context = {
    Array,
    Math,
    Number,
    gxBpRegisters: bp,
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
      "gxCullDiv",
      "gxCullAdd",
      "gxCullSub",
      "gxCullDot4Position",
      "gxCullDot4",
      "gxCullTransformState",
      "gxCullPositionMatrix",
      "gxCullViewPosition",
      "gxExactClipViewPosition",
      "gxExactClipPosition",
      "gxExactNoWrapScissorAxisOffset",
      "gxExactNoWrapViewportState",
      "gxExactNoWrapScreenPosition",
      "gxExactNoWrapProjectPosition",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-exact-projection.js" },
  );

  const transformState = context.gxCullTransformState();
  const viewportState = context.gxExactNoWrapViewportState();
  const position = [0.9999999403953552, -1.25, -3.5];
  const clip = context.gxExactClipPosition(position, 0, transformState);
  assert.deepEqual(
    f32BitPatterns(clip),
    [0x400aaaab, 0xbfb00000, 0xc09bffff, 0x40600000],
    "perspective Z includes Dolphin's f32 depth contraction",
  );
  assert.deepEqual(
    f32BitPatterns(
      context.gxExactNoWrapProjectPosition(
        position,
        0,
        transformState,
        viewportState,
      ),
    ),
    [0x43461860, 0x42cf6db8, 0xcbb24923, 0x40600000],
    "divide, viewport multiply/add, and raw BP59 offset each round to f32",
  );
  assert.deepEqual(
    { ...viewportState },
    {
      viewport: [320, -264, 16777215, 342, 342, 0],
      scissorOffsetX: 342,
      scissorOffsetY: 342,
    },
  );
  assert.equal(
    context.gxExactNoWrapScreenPosition([0, 0, 0, 0], viewportState),
    null,
  );
  assert.equal(context.gxExactClipPosition(null, 0, transformState), null);
  assert.equal(
    context.gxExactClipPosition(position, 0, {
      projection: transformState.projection,
      projectionType: 0,
    }),
    null,
  );
  assert.equal(
    context.gxExactClipViewPosition(position, {
      projectionType: 0,
    }),
    null,
  );
  assert.equal(
    context.gxExactNoWrapScreenPosition(clip, {
      viewport: viewportState.viewport,
      scissorOffsetX: 1024,
      scissorOffsetY: 342,
    }),
    null,
  );

  const onePlusTwoNeg23 = 1 + 2 ** -23;
  const oneMinusTwoNeg23 = 1 - 2 ** -23;
  const cancellation = context.gxExactClipViewPosition(
    [oneMinusTwoNeg23, 0, 1],
    {
      projection: [onePlusTwoNeg23, -1, 1, 0, 1, 0],
      projectionType: 0,
    },
  );
  assert.deepEqual(
    f32BitPatterns(cancellation),
    [0x00000000, 0x00000000, 0x3f7ffffe, 0xbf800000],
    "each perspective product rounds before the cancellation add",
  );
  assert.notEqual(
    f32Bits(onePlusTwoNeg23 * oneMinusTwoNeg23 - 1),
    0,
    "late-f64 projection would retain the cancellation residue",
  );
  assert.deepEqual(
    f32BitPatterns(
      context.gxExactClipViewPosition(
        [0.5, -0.25, 0.75],
        {
          projection: [2, 0.25, -3, 0.5, 4, -1],
          projectionType: 1,
        },
      ),
    ),
    [0x3fa00000, 0x3fa00000, 0x40000000, 0x3f800000],
    "orthographic projection does not contract Z",
  );

  bp[0x59] |= (1 << 9) | (1 << 19);
  assert.deepEqual(
    { ...context.gxExactNoWrapViewportState() },
    { ...viewportState },
    "hardware ignores the top bit of each BP59 offset field",
  );
  bp[0x20] = 0;
  bp[0x21] = (0x7ff << 12) | 0x7ff;
  assert.equal(
    context.gxExactNoWrapViewportState(),
    null,
    "a wrapped multi-rectangle scissor stays outside the first managed subset",
  );

  assert.doesNotMatch(
    extractFunction("gxDecodeVertex"),
    /\bgxExact/,
    "live vertex decode remains unchanged while exact inputs are captured beside it",
  );
  assert.match(
    extractFunction("recordGxPrimitive"),
    /if \(exactGeometryRequired\)[\s\S]*gxManagedCoverageExactClipInput\([\s\S]*exactGeometryRequired: true/,
    "projection recovery makes exact geometry authoritative for the whole draw",
  );
  assert.match(
    extractFunction("recordGxPrimitive"),
    /!exactGeometryRequired[\s\S]*gxManagedCoveragePostCullEvidence\([\s\S]*!exactGeometryRequired[\s\S]*postCullEvidence === null[\s\S]*gxManagedCoverageExactClipInput\(/,
    "ordinary draws preserve the optional post-cull then exact-input path",
  );
  assert.match(
    extractFunction("postGxFrame"),
    /packGxFramePacketV6\(/,
    "live transport negotiates v6 only for frames carrying required exact geometry",
  );
  assert.doesNotMatch(
    extractFunction("postGxFrame"),
    /packGxFramePacketV[45]\(/,
  );
});

test("exact input capture snapshots raw GX state and homogeneous f32 positions", () => {
  const xf = new Float32Array(0x1100);
  xf.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set([
    1.0000001192092896,
    -0.3333333432674408,
    0.75,
    0.125,
    1.25,
    -0.5,
  ], 0x1020);
  xf.set([320, -264, 16777215, 342, 342, 0], 0x101a);
  const registers = new Uint32Array(xf.buffer);
  registers.set([
    0x43a00000,
    0xc3840000,
    0x4b7fffff,
    0x80000000,
    0x00000001,
    0x80000001,
  ], 0x101a);
  registers[0x1005] = 7;
  registers[0x1026] = 0;
  const bp = new Uint32Array(0x100);
  bp[0x00] = (0x00c3b2a1 & ~(3 << 14)) | (2 << 14);
  bp[0x20] = 0x00fedcba;
  bp[0x21] = 0x00123456;
  bp[0x59] = 0x00c0ffee;
  let xfFloatReads = 0;
  const context = {
    Array,
    Float32Array,
    Math,
    Number,
    Uint32Array,
    gxBpRegisters: bp,
    gxXfRegisters: registers,
    gxXfFloat(address) {
      xfFloatReads += 1;
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
      "gxCullTransformState",
      "gxCullPositionMatrix",
      "gxCullViewPosition",
      "gxExactClipViewPosition",
      "gxExactClipPosition",
      "gxSourceTriangleCount",
      "gxManagedCoverageExactClipInput",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-exact-input.js" },
  );

  const positions = [
    [0.9999999403953552, -1.25, -3.5],
    [0, 0, -1],
    [0.25, 0.5, -2],
  ];
  const input = context.gxManagedCoverageExactClipInput(
    2,
    2,
    positions,
    [0, 0, 0],
  );
  assert.notEqual(input, null);
  assert.equal(input.bpGenMode, bp[0x00]);
  assert.equal(input.bpScissorTopLeft, bp[0x20]);
  assert.equal(input.bpScissorBottomRight, bp[0x21]);
  assert.equal(input.bpScissorOffset, bp[0x59]);
  assert.equal(input.xfClipDisable, 7);
  assert.deepEqual(
    f32BitPatterns(input.viewport),
    Array.from(registers.slice(0x101a, 0x1020)),
    "viewport words are copied without a numeric re-encoding step",
  );
  assert.deepEqual(
    f32BitPatterns(input.clipPositions.slice(0, 4)),
    [0x400aaaab, 0xbfb00000, 0xc09bffff, 0x40600000],
  );
  assert.equal(input.clipPositions.length, positions.length * 4);
  assert.equal(
    xfFloatReads,
    18,
    "one projection snapshot and one cached position matrix serve the whole draw",
  );

  const stripPositions = [
    [10, 1, -1],
    [20, 2, -2],
    [30, 3, -4],
    [40, 4, -8],
  ];
  const stripInput = context.gxManagedCoverageExactClipInput(
    3,
    2,
    stripPositions,
    [0, 0, 0, 0],
  );
  const stripExpected = stripPositions.flatMap(position =>
    context.gxExactClipPosition(position, 0)
  );
  assert.deepEqual(
    f32BitPatterns(stripInput.clipPositions),
    f32BitPatterns(stripExpected),
    "triangle strips retain all original source vertices without expansion or reordering",
  );
  assert.deepEqual(
    Array.from({ length: 4 }, (_unused, vertex) =>
      stripInput.clipPositions[vertex * 4 + 3]
    ),
    [1, 2, 4, 8],
  );

  bp[0x20] = 0;
  registers[0x101a] = f32Bits(640);
  positions[0][0] = 99;
  assert.notEqual(input.bpScissorTopLeft, bp[0x20]);
  assert.equal(f32BitPatterns(input.viewport)[0], f32Bits(320));
  assert.deepEqual(
    f32BitPatterns(input.clipPositions.slice(0, 4)),
    [0x400aaaab, 0xbfb00000, 0xc09bffff, 0x40600000],
    "later register and source mutations cannot stale a captured draw",
  );
});

test("exact input capture rejects incomplete or noncanonical GX state", () => {
  const xf = new Float32Array(0x1100);
  xf.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set([320, -264, 16777215, 342, 342, 0], 0x101a);
  xf.set([1, 0, 1, 0, 1, 0], 0x1020);
  const registers = new Uint32Array(xf.buffer);
  registers[0x1026] = 0;
  const bp = new Uint32Array(0x100);
  bp[0x00] = 1 << 14;
  const context = {
    Array,
    Float32Array,
    Math,
    Number,
    Uint32Array,
    gxBpRegisters: bp,
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
      "gxCullTransformState",
      "gxCullPositionMatrix",
      "gxCullViewPosition",
      "gxExactClipViewPosition",
      "gxExactClipPosition",
      "gxSourceTriangleCount",
      "gxManagedCoverageExactClipInput",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-exact-input-invalid.js" },
  );
  const positions = [[0, 0, -1], [1, 0, -1], [0, 1, -1]];
  const matrices = [0, 0, 0];
  const capture = () =>
    context.gxManagedCoverageExactClipInput(2, 1, positions, matrices);

  assert.notEqual(capture(), null);
  assert.equal(
    context.gxManagedCoverageExactClipInput(2, 1, positions, [0, 0]),
    null,
  );
  assert.equal(
    context.gxManagedCoverageExactClipInput(2, 2, positions, matrices),
    null,
  );
  assert.equal(
    context.gxManagedCoverageExactClipInput(2, 1, positions.slice(0, 2), [0, 0]),
    null,
  );
  registers[0x1005] = 8;
  assert.equal(capture(), null);
  registers[0x1005] = 0;
  registers[0x101a] = 0;
  assert.equal(capture(), null);
  registers[0x101a] = f32Bits(320);
  registers[0x101b] = 0x7fc00000;
  assert.equal(capture(), null);
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
