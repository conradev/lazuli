#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  projectionNullExactState,
  projectionNullSourceVector,
} from "./browser_boot_projection_null_oracle.mjs";

const browserBootSource = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(
    browserBootSource,
  );
  assert.notEqual(match, null, `missing ${name} in browser_boot.rs`);
  const start = match.index;
  const bodyStart = browserBootSource.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < browserBootSource.length; index += 1) {
    if (browserBootSource[index] === "{") depth += 1;
    if (browserBootSource[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return browserBootSource.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function f32Bits(value) {
  const storage = new ArrayBuffer(4);
  new Float32Array(storage)[0] = value;
  return new Uint32Array(storage)[0] >>> 0;
}

function f32BitPatterns(values) {
  return Array.from(values, f32Bits);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("producer makes the projection-null source authoritative for the whole draw", () => {
  const xf = new Float32Array(0x1100);
  xf.set([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
  ], 0);
  xf.set(projectionNullExactState.viewport, 0x101a);
  xf.set(projectionNullSourceVector.projection, 0x1020);
  const xfRegisters = new Uint32Array(xf.buffer);
  xfRegisters[0x1026] = projectionNullSourceVector.projectionType;
  const bpRegisters = new Uint32Array(0x100);
  bpRegisters[0x00] = projectionNullExactState.bpGenMode;
  bpRegisters[0x20] = projectionNullExactState.bpScissorTopLeft;
  bpRegisters[0x21] = projectionNullExactState.bpScissorBottomRight;
  bpRegisters[0x59] = projectionNullExactState.bpScissorOffset;

  const stage = {
    index: 0,
    order: 0,
    textureMap: 0,
    texCoordIndex: 0,
    textureEnabled: false,
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
    gxBpRegisters: bpRegisters,
    gxXfRegisters: xfRegisters,
    gxCpRegisters: new Uint32Array(0x100),
    gxCollectFrameGeometry: true,
    gxSkippedGeometryPrimitives: 0,
    gxSkippedGeometryVertices: 0,
    gxFrameSkippedPrimitives: 0,
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
    gxDrawStateSnapshots: 0,
    gxDrawStateMemoHits: 0,
    gxVertexTransformContextSnapshots: 0,
    gxVertexTransformContextMemoHits: 0,
    gxTevModeCounts: new Map(),
    gxFrameDraws: [],
    gxTevColorRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxTevKonstRegisters: Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    gxPrimitiveSamples: [],
    gxRecentPrimitiveSamples: [],
    statusDataset: {},
    cycles: 11,
    dispatches: 13,
    gxXfFloat(address) {
      return xf[address];
    },
    gxDrawPipelineState() {
      return {
        zMode: 0,
        blendMode: 8,
        alphaTest: 0x003f0000,
        cullMode: 0,
        scissorX: 0,
        scissorY: 0,
        scissorWidth: 4,
        scissorHeight: 4,
        pixelControl: 0,
        viewportHalfWidthBits: f32Bits(2),
      };
    },
    gxTevStageState() {
      return stage;
    },
    gxPrepareVertexTransformContext() {
      context.gxVertexTransformContextSnapshots += 1;
      return {};
    },
    gxManagedCoverageStateCandidate() {
      return false;
    },
    gxManagedCoverageVerticesCandidate() {
      throw new Error("required exact draw consulted optional evidence");
    },
    gxManagedCoveragePostCullEvidence() {
      throw new Error("required exact draw reached post-cull evidence");
    },
    gxTevCoordsValid() {
      return true;
    },
    gxTevTextures() {
      return [];
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
      "gxProjectViewPosition",
      "gxExactNoWrapScissorAxisOffset",
      "gxExactNoWrapViewportState",
      "gxExactNoWrapScreenPosition",
      "gxExactClipVertexIsValid",
      "gxExactClipVertexListIsValid",
      "gxExactClipMask",
      "gxExactClipDifferentSigns",
      "gxExactClipPlaneDistance",
      "gxExactClipVertex",
      "gxExactClipPolygon",
      "gxExactTriangulateClipPolygon",
      "gxCullNormalZ3",
      "gxPostCullActionFromNormal",
      "gxExactPostClipTriangles",
      "gxSourceTriangleCount",
      "gxManagedCoverageExactClipInput",
      "recordGxPrimitive",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.gx-projection-null-oracle.js" },
  );

  const projected = projectionNullSourceVector.viewPositions.map((position) =>
    context.gxProjectViewPosition(position)
  );
  assert.equal(projected[0], null);
  assert.deepEqual(
    plain(projected.slice(1)),
    projectionNullSourceVector.legacyProjectedPositions.slice(1),
  );

  const texCoords = Array.from({ length: 8 }, () => [0, 0, 0]);
  const decoded = projectionNullSourceVector.viewPositions.map(
    (position, index) => ({
      skipped: false,
      projected: projected[index],
      position,
      positionMatrix: 0,
      colors: [[255, 255, 255, 255], [0, 0, 0, 0]],
      rasterColors: [[1, 1, 1, 1], [0, 0, 0, 0]],
      texCoords,
      rawTextureCoords: texCoords.map((coord) => coord.slice(0, 2)),
      normal: [0, 0, 1],
      textureMatrices: new Array(8).fill(0),
    }),
  );
  context.gxDecodeVertex = (_source, start) => ({
    ...decoded[start],
    cursor: start + 1,
  });

  context.recordGxPrimitive(0x90, new Uint8Array(3), 0, 3, 1);

  assert.equal(context.gxFrameDraws.length, 1);
  const draw = context.gxFrameDraws[0];
  assert.equal(draw.exactGeometryRequired, true);
  assert.equal(Object.hasOwn(draw, "postCullEvidence"), false);
  assert.equal(draw.vertexCount, 3);
  assert.deepEqual(
    f32BitPatterns(draw.exactClipInput.clipPositions),
    f32BitPatterns(projectionNullSourceVector.exactClipPositions.flat()),
  );
  const clipped = context.gxExactPostClipTriangles(
    projectionNullSourceVector.exactClipPositions.map((position) =>
      Array.from(position)
    ),
    0,
    projectionNullExactState.viewport[1],
  );
  assert.equal(clipped.length, 2);
  const projectedExact = clipped.map((triangle) =>
    triangle.map((position) =>
      context.gxExactNoWrapScreenPosition(position)
    )
  );
  assert.deepEqual(
    plain(
      projectedExact.map((triangle) =>
        triangle.map(([x, y]) => [x, y])
      ),
    ),
    [
      [[4, 0], [0, 0], [0, 4]],
      [[4, 0], [0, 4], [4, 4]],
    ],
    "exact clipping reconstructs two triangles covering the 4x4 scissor",
  );
  assert.deepEqual(
    Array.from(
      projectedExact.flat(),
      (position) => f32Bits(position[2]),
    ),
    new Array(6).fill(0x4b000000),
    "the clipped quad retains one exact managed depth plane",
  );
  assert.deepEqual(
    Array.from({ length: 3 }, (_unused, vertex) =>
      Array.from(draw.vertices.slice(vertex * 36, vertex * 36 + 4))
    ),
    projectionNullSourceVector.nativeCarrierPositions,
  );
  assert.equal(context.gxLegacyProjectionNullVertices, 1);
  assert.equal(context.gxExactRequiredDraws, 1);
  assert.equal(context.gxExactRequiredVertices, 3);
  assert.equal(context.gxExactRequiredCaptureMisses, 0);
  assert.equal(context.gxDroppedVertices, 0);
});
