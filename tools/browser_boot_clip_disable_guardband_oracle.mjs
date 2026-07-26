// SPDX-License-Identifier: GPL-3.0-only

import {
  snapshotExactRequiredTelemetry,
} from "./browser_boot_exact_preparation_telemetry_oracle.mjs";
import {
  RASTER_ALWAYS_PASS,
  RASTER_BLEND_ADDITIVE_ONE_ONE,
  buildRasterCenterOraclePacket,
} from "./browser_boot_raster_center_oracle.mjs";

const CLIP_DISABLE_MASK = 0b111;
const DISABLE_CLIPPING_DETECTION = 1 << 0;
const DISABLE_TRIVIAL_REJECTION = 1 << 1;
const DEPTH24_MAX = 0x00ffffff;
const HEADER_BYTES = 160;
const DRAW_BYTES = 176;
const TEV_BYTES = 464;
const VERTEX_FLOATS = 36;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const VERTEX_COUNT = 4;
const DRAW_OFFSET = HEADER_BYTES;
const BASE_PACKET_BYTES =
  HEADER_BYTES +
  DRAW_BYTES +
  TEV_BYTES +
  VERTEX_COUNT * VERTEX_BYTES;
const EXACT_CHUNK_BYTES = 0x30 + VERTEX_COUNT * 4 * 4;
const PACKET_BYTES = BASE_PACKET_BYTES + EXACT_CHUNK_BYTES;
const DRAW_FLAG_EXACT_CLIP_REQUIRED = 6;
const SCISSOR_ORIGIN = 342;
const VIEWPORT_ORIGIN = 350;
const SAMPLE_28_4_THIRDS = 28; // (7 / 12) * 16 * 3
const BLACK = Object.freeze([0, 0, 0, 255]);
// Deliberately unsaturated: a later additive pass can use 128 as a
// duplicate-submission sentinel. This is not hardware colour evidence.
const RED64 = Object.freeze([64, 0, 0, 255]);
const SOURCE_TRIANGLES = Object.freeze([
  Object.freeze([0, 1, 2]),
  Object.freeze([0, 2, 3]),
]);

const f32 = Math.fround;
const freezeRows = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));

export const CLIP_DISABLE_GUARDBAND_MODES = Object.freeze(
  Array.from({ length: 8 }, (_unused, mode) => mode),
);
export const CLIP_DISABLE_GUARDBAND_RUN_COUNT = 2;
export const CLIP_DISABLE_GUARDBAND_SCOPE =
  "unit-positive-w-in-efb-unsigned";

export function nextDownF32(value) {
  const rounded = f32(value);
  if (Number.isNaN(rounded) || rounded === -Infinity) {
    return rounded;
  }
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  if (Object.is(rounded, 0) || Object.is(rounded, -0)) {
    view.setUint32(0, 0x80000001);
    return view.getFloat32(0);
  }
  view.setFloat32(0, rounded);
  const bits = view.getUint32(0);
  view.setUint32(0, rounded > 0 ? bits - 1 : bits + 1);
  return view.getFloat32(0);
}

export const CLIP_DISABLE_GUARDBAND_ADJACENT_OUTWARD =
  nextDownF32(-2);

export const clipDisableGuardbandOracleXfb = Object.freeze({
  destination: 0x00110000,
  width: 16,
  height: 16,
  stride: 64,
});

export const clipDisableGuardbandExactState = Object.freeze({
  bpGenMode: 0,
  bpScissorTopLeft:
    (SCISSOR_ORIGIN << 12) | SCISSOR_ORIGIN,
  bpScissorBottomRight:
    ((SCISSOR_ORIGIN + 15) << 12) | (SCISSOR_ORIGIN + 15),
  bpScissorOffset: 171 | (171 << 10),
  viewport: Object.freeze([
    2,
    -2,
    DEPTH24_MAX,
    VIEWPORT_ORIGIN,
    VIEWPORT_ORIGIN,
    DEPTH24_MAX,
  ]),
});

export const clipDisableGuardbandPacketLayout = Object.freeze({
  headerBytes: HEADER_BYTES,
  drawOffset: DRAW_OFFSET,
  drawBytes: DRAW_BYTES,
  tevBytes: TEV_BYTES,
  vertexOffset: HEADER_BYTES + DRAW_BYTES + TEV_BYTES,
  vertexFloats: VERTEX_FLOATS,
  vertexBytes: VERTEX_BYTES,
  vertexCount: VERTEX_COUNT,
  basePacketBytes: BASE_PACKET_BYTES,
  exactChunkOffset: BASE_PACKET_BYTES,
  exactChunkBytes: EXACT_CHUNK_BYTES,
  packetBytes: PACKET_BYTES,
  drawFlag: DRAW_FLAG_EXACT_CLIP_REQUIRED,
});

function quadPositions(axis, minimum, maximum) {
  const low = f32(minimum);
  const high = f32(maximum);
  if (axis === "x") {
    return freezeRows([
      [low, 0.75, -0.5, 1],
      [high, 0.75, -0.5, 1],
      [high, -0.75, -0.5, 1],
      [low, -0.75, -0.5, 1],
    ]);
  }
  return freezeRows([
    [-0.75, f32(-low), -0.5, 1],
    [0.75, f32(-low), -0.5, 1],
    [0.75, f32(-high), -0.5, 1],
    [-0.75, f32(-high), -0.5, 1],
  ]);
}

const EVIDENCE = Object.freeze({
  inside: Object.freeze({
    classification: "manual",
    basis:
      "Nintendo GX manual §5.3 defines a guardband extending to ±2W.",
  }),
  boundary: Object.freeze({
    classification: "pinned-console-boundary",
    basis:
      "Pokechu22 gxtest/rasterization.cpp probes -2.0 and the adjacent outward f32 value.",
    caveat:
      "The pinned test also moves the opposite edge, so this oracle isolates the boundary geometrically.",
  }),
  inference: Object.freeze({
    classification: "manual-register-inference",
    basis:
      "Uniform same-side behavior follows the documented ClipDisable bit-1 trivial-rejection control.",
    caveat: "Modes 2 and 6 are inferred, not console-measured here.",
  }),
  boundedOutside: Object.freeze({
    classification: "manual-plus-conservative-policy",
    basis:
      "Clip-enabled geometry crosses the documented ±2W plane; bit-0 modes remain fail-closed beyond that bounded admission surface.",
    caveat:
      "The hardware clip-disable maximum is unresolved, so rejection is implementation policy rather than a hardware visibility claim.",
  }),
});

function guardbandCase(id, axis, minimum, maximum, kind, evidence) {
  return Object.freeze({
    id,
    axis,
    kind,
    evidence,
    exactClipPositions: quadPositions(axis, minimum, maximum),
    topology: SOURCE_TRIANGLES,
  });
}

export const clipDisableGuardbandCases = Object.freeze([
  guardbandCase(
    "negative-x-inside-guardband",
    "x",
    -1.75,
    -0.5,
    "inside",
    EVIDENCE.inside,
  ),
  guardbandCase(
    "negative-x-exact-boundary",
    "x",
    -2,
    -0.5,
    "exact-boundary",
    EVIDENCE.boundary,
  ),
  guardbandCase(
    "negative-x-adjacent-outward",
    "x",
    CLIP_DISABLE_GUARDBAND_ADJACENT_OUTWARD,
    -0.5,
    "adjacent-outward",
    EVIDENCE.boundary,
  ),
  guardbandCase(
    "negative-x-bounded-outside",
    "x",
    -2.25,
    -0.5,
    "bounded-outside",
    EVIDENCE.boundedOutside,
  ),
  guardbandCase(
    "negative-x-uniform-same-side",
    "x",
    -1.875,
    -1.125,
    "uniform-same-side",
    EVIDENCE.inference,
  ),
  guardbandCase(
    "top-y-inside-guardband",
    "y",
    -1.75,
    -0.5,
    "inside",
    EVIDENCE.inside,
  ),
  guardbandCase(
    "top-y-exact-boundary",
    "y",
    -2,
    -0.5,
    "exact-boundary",
    EVIDENCE.boundary,
  ),
  guardbandCase(
    "top-y-adjacent-outward",
    "y",
    CLIP_DISABLE_GUARDBAND_ADJACENT_OUTWARD,
    -0.5,
    "adjacent-outward",
    EVIDENCE.boundary,
  ),
  guardbandCase(
    "top-y-bounded-outside",
    "y",
    -2.25,
    -0.5,
    "bounded-outside",
    EVIDENCE.boundedOutside,
  ),
  guardbandCase(
    "top-y-uniform-same-side",
    "y",
    -1.875,
    -1.125,
    "uniform-same-side",
    EVIDENCE.inference,
  ),
]);

function exactCase(caseId) {
  const entry = clipDisableGuardbandCases.find(
    (candidate) => candidate.id === caseId,
  );
  if (entry === undefined) {
    throw new RangeError(`unknown clip-disable guardband case ${caseId}`);
  }
  return entry;
}

function exactMode(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > CLIP_DISABLE_MASK) {
    throw new RangeError("mode must be an integer from 0 through 7");
  }
  return mode;
}

function canonicalClipMask(position) {
  const [x, y, _z, w] = position;
  let mask = 0;
  if (f32(x + w) < 0) mask |= 1;
  if (f32(w - x) < 0) mask |= 2;
  if (f32(y + w) < 0) mask |= 4;
  if (f32(w - y) < 0) mask |= 8;
  return mask;
}

const guardbandPlanes = Object.freeze([
  (position) => f32(position[0] + f32(2 * position[3])),
  (position) => f32(f32(2 * position[3]) - position[0]),
  (position) => f32(position[1] + f32(2 * position[3])),
  (position) => f32(f32(2 * position[3]) - position[1]),
]);

function interpolateClipPosition(
  outside,
  inside,
  outsideDistance,
  insideDistance,
) {
  const denominator = f32(outsideDistance - insideDistance);
  const ratio = f32(outsideDistance / denominator);
  return outside.map((component, index) =>
    f32(
      component +
        f32(ratio * f32(inside[index] - component)),
    ),
  );
}

function clipPolygonToPlane(polygon, planeDistance) {
  if (polygon.length === 0) return [];
  const output = [];
  let previous = polygon.at(-1);
  let previousDistance = planeDistance(previous);
  let previousInside = previousDistance >= 0;
  for (const current of polygon) {
    const currentDistance = planeDistance(current);
    const currentInside = currentDistance >= 0;
    if (currentInside !== previousInside) {
      const outside = currentInside ? previous : current;
      const inside = currentInside ? current : previous;
      const outsideDistance = currentInside
        ? previousDistance
        : currentDistance;
      const insideDistance = currentInside
        ? currentDistance
        : previousDistance;
      output.push(
        interpolateClipPosition(
          outside,
          inside,
          outsideDistance,
          insideDistance,
        ),
      );
    }
    if (currentInside) output.push(current);
    previous = current;
    previousDistance = currentDistance;
    previousInside = currentInside;
  }
  return output;
}

function guardbandClipTriangle(triangle) {
  let polygon = triangle;
  for (const plane of guardbandPlanes) {
    polygon = clipPolygonToPlane(polygon, plane);
  }
  const triangles = [];
  for (let index = 1; index + 1 < polygon.length; index += 1) {
    triangles.push([polygon[0], polygon[index], polygon[index + 1]]);
  }
  return triangles;
}

function deriveTriangles(entry, mode) {
  const trivialRejectionDisabled =
    (mode & DISABLE_TRIVIAL_REJECTION) !== 0;
  const source = SOURCE_TRIANGLES.map((indices) =>
    indices.map((index) => entry.exactClipPositions[index]),
  );
  const surviving = trivialRejectionDisabled
    ? source
    : source.filter(
        (triangle) =>
          triangle
            .map(canonicalClipMask)
            .reduce((mask, value) => mask & value) === 0,
      );
  if (surviving.length === 0) {
    return { path: "trivially-rejected", triangles: [] };
  }
  const outsideGuardband = surviving.some((triangle) =>
    triangle.some((position) =>
      guardbandPlanes.some((plane) => plane(position) < 0),
    ),
  );
  if (
    outsideGuardband &&
    (mode & DISABLE_CLIPPING_DETECTION) !== 0
  ) {
    return { path: "policy-fail-closed", triangles: [] };
  }
  if (outsideGuardband) {
    return {
      path: "guardband-clipped",
      triangles: surviving.flatMap(guardbandClipTriangle),
    };
  }
  return {
    path:
      entry.kind === "uniform-same-side"
        ? "trivial-rejection-bypassed"
        : "guardband-accepted",
    triangles: surviving,
  };
}

function projectToEfb(position) {
  const [scaleX, scaleY, , originX, originY] =
    clipDisableGuardbandExactState.viewport;
  const reciprocalW = f32(1 / position[3]);
  const x = f32(
    f32(
      f32(f32(position[0] * reciprocalW) * scaleX) +
        originX,
    ) - SCISSOR_ORIGIN,
  );
  const y = f32(
    f32(
      f32(f32(position[1] * reciprocalW) * scaleY) +
        originY,
    ) - SCISSOR_ORIGIN,
  );
  return [x, y];
}

function projectTo28_4(position) {
  const [x, y] = projectToEfb(position);
  return [snap28_4(x), snap28_4(y)];
}

function guardbandCarrierVertex(position) {
  const [x, y] = projectToEfb(position);
  return {
    x,
    y,
    depth24: f32(DEPTH24_MAX / 2),
    rgba: RED64.map((channel) => f32(channel / 255)),
  };
}

export function buildClipDisableGuardbandOraclePacket(
  caseId,
  inputMode,
  generation = 1,
) {
  const entry = exactCase(caseId);
  const mode = exactMode(inputMode);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("generation must be a non-negative safe integer");
  }
  const base = buildRasterCenterOraclePacket(
    [
      {
        topology: 0,
        vertices: entry.exactClipPositions.map(guardbandCarrierVertex),
        zMode: 0,
        blendMode: RASTER_BLEND_ADDITIVE_ONE_ONE,
        alphaTest: RASTER_ALWAYS_PASS,
        pixelControl: 0,
        scissor: {
          x: 0,
          y: 0,
          width: clipDisableGuardbandOracleXfb.width,
          height: clipDisableGuardbandOracleXfb.height,
        },
      },
    ],
    generation,
  );
  if (base.length !== BASE_PACKET_BYTES) {
    throw new Error(
      `clip-disable guardband base packet is ${base.length}, expected ${BASE_PACKET_BYTES}`,
    );
  }

  const packet = new Uint8Array(PACKET_BYTES);
  packet.set(base);
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  view.setUint16(0x04, 6, true);
  view.setUint32(0x08, packet.length, true);
  view.setUint32(0x54, clipDisableGuardbandOracleXfb.width, true);
  view.setUint32(0x58, clipDisableGuardbandOracleXfb.height, true);
  view.setUint32(0x5c, clipDisableGuardbandOracleXfb.width, true);
  view.setUint32(0x60, clipDisableGuardbandOracleXfb.height, true);
  view.setUint32(0x64, clipDisableGuardbandOracleXfb.destination, true);
  view.setUint32(0x68, clipDisableGuardbandOracleXfb.stride, true);
  view.setUint16(
    DRAW_OFFSET + 0x02,
    DRAW_FLAG_EXACT_CLIP_REQUIRED,
    true,
  );
  view.setFloat32(
    DRAW_OFFSET + 0xac,
    clipDisableGuardbandExactState.viewport[0],
    true,
  );

  const exact = BASE_PACKET_BYTES;
  view.setUint32(exact + 0x00, 1, true);
  view.setUint32(
    exact + 0x04,
    clipDisableGuardbandExactState.bpGenMode,
    true,
  );
  view.setUint32(
    exact + 0x08,
    clipDisableGuardbandExactState.bpScissorTopLeft,
    true,
  );
  view.setUint32(
    exact + 0x0c,
    clipDisableGuardbandExactState.bpScissorBottomRight,
    true,
  );
  view.setUint32(
    exact + 0x10,
    clipDisableGuardbandExactState.bpScissorOffset,
    true,
  );
  view.setUint32(exact + 0x14, mode, true);
  clipDisableGuardbandExactState.viewport.forEach((value, index) => {
    view.setFloat32(exact + 0x18 + index * 4, value, true);
  });
  entry.exactClipPositions.flat().forEach((value, index) => {
    view.setFloat32(exact + 0x30 + index * 4, value, true);
  });
  return packet;
}

function snap28_4(coordinate) {
  const scaled = f32(coordinate * 16);
  const truncated = Math.trunc(scaled);
  return scaled - truncated >= 0.5
    ? truncated + 1
    : truncated;
}

function signedArea2([a, b, c]) {
  return (
    (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0])
  );
}

function coverageEdges(inputTriangle) {
  const area = signedArea2(inputTriangle);
  if (area === 0) return null;
  const triangle =
    area < 0
      ? inputTriangle
      : [inputTriangle[0], inputTriangle[2], inputTriangle[1]];
  return triangle.map((a, index) => {
    const b = triangle[(index + 1) % 3];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Object.freeze({
      dx,
      dy,
      constant: dy * a[0] - dx * a[1],
      inclusive: dy < 0 || (dy === 0 && dx > 0),
    });
  });
}

function sampleInTriangle(edges, sampleX, sampleY) {
  return edges.every((edge) => {
    const value =
      3 * edge.constant +
      edge.dx * sampleY -
      edge.dy * sampleX;
    return edge.inclusive ? value >= 0 : value > 0;
  });
}

function deriveCoverage(triangles) {
  const projected = triangles
    .map((triangle) =>
      coverageEdges(triangle.map(projectTo28_4)),
    )
    .filter((edges) => edges !== null);
  const rows = Array.from(
    { length: clipDisableGuardbandOracleXfb.height },
    () => 0,
  );
  for (let y = 0; y < clipDisableGuardbandOracleXfb.height; y += 1) {
    for (let x = 0; x < clipDisableGuardbandOracleXfb.width; x += 1) {
      const sample = [
        x * 48 + SAMPLE_28_4_THIRDS,
        y * 48 + SAMPLE_28_4_THIRDS,
      ];
      if (
        projected.some((edges) =>
          sampleInTriangle(edges, sample[0], sample[1]),
        )
      ) {
        rows[y] |= 1 << x;
      }
    }
  }
  return {
    rows,
    managedTriangles: projected.length,
  };
}

function rgbaFromRows(rows) {
  return Object.freeze(
    rows
      .flatMap((mask) =>
        Array.from(
          { length: clipDisableGuardbandOracleXfb.width },
          (_unused, x) => ((mask >>> x) & 1) === 1 ? RED64 : BLACK,
        ),
      )
      .flat(),
  );
}

function fnv1a64Hex(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `0x${hash.toString(16).padStart(16, "0")}`;
}

export function clipDisableGuardbandMaskRows(rgba) {
  const expectedLength =
    clipDisableGuardbandOracleXfb.width *
    clipDisableGuardbandOracleXfb.height *
    4;
  if (rgba.length !== expectedLength) {
    throw new RangeError(
      "clip-disable guardband mask requires one 16x16 RGBA surface",
    );
  }
  return Array.from(
    { length: clipDisableGuardbandOracleXfb.height },
    (_unused, y) => {
      let mask = 0;
      for (let x = 0; x < clipDisableGuardbandOracleXfb.width; x += 1) {
        const offset =
          (y * clipDisableGuardbandOracleXfb.width + x) * 4;
        if (
          rgba[offset] !== BLACK[0] ||
          rgba[offset + 1] !== BLACK[1] ||
          rgba[offset + 2] !== BLACK[2] ||
          rgba[offset + 3] !== BLACK[3]
        ) {
          mask |= 1 << x;
        }
      }
      return mask;
    },
  );
}

const PINNED_BLACK_HASH = "0x01ebcdb597074b25";
const PINNED_VISIBLE_HASH = Object.freeze({
  "negative-x-inside-guardband": "0xd142e6c777351b65",
  "negative-x-exact-boundary": "0xd142e6c777351b65",
  "negative-x-adjacent-outward": "0xd142e6c777351b65",
  "negative-x-bounded-outside": "0xd142e6c777351b65",
  "negative-x-uniform-same-side": "0x114795d883ce7125",
  "top-y-inside-guardband": "0x1c2a04a47a98a2e5",
  "top-y-exact-boundary": "0x1c2a04a47a98a2e5",
  "top-y-adjacent-outward": "0x1c2a04a47a98a2e5",
  "top-y-bounded-outside": "0x1c2a04a47a98a2e5",
  "top-y-uniform-same-side": "0xafbca7d5c1118b25",
});
const expectationCache = new Map();

export function clipDisableGuardbandExpectation(caseId, inputMode) {
  const entry = exactCase(caseId);
  const mode = exactMode(inputMode);
  const cacheKey = `${caseId}:${mode}`;
  if (expectationCache.has(cacheKey)) {
    return expectationCache.get(cacheKey);
  }
  const derived = deriveTriangles(entry, mode);
  const coverage = deriveCoverage(derived.triangles);
  const rows = coverage.rows;
  const rgba = rgbaFromRows(rows);
  const rgbaHash = fnv1a64Hex(rgba);
  const visible = rows.some((mask) => mask !== 0);
  const expectedHash = visible
    ? PINNED_VISIBLE_HASH[caseId]
    : PINNED_BLACK_HASH;
  if (rgbaHash !== expectedHash) {
    throw new Error(
      `${caseId} mode ${mode} geometry hash ${rgbaHash} != ${expectedHash}`,
    );
  }
  const policyRejected = derived.path === "policy-fail-closed";
  const preparationReason = policyRejected
    ? `unsupportedClipDisable${mode}`
    : null;
  const expectation = Object.freeze({
    caseId,
    mode,
    path: derived.path,
    evidence: entry.evidence,
    visible,
    expectedMaskRows: Object.freeze(rows),
    expectedPixelCount: rows.reduce(
      (count, mask) =>
        count + mask.toString(2).replaceAll("0", "").length,
      0,
    ),
    expectedRgba: rgba,
    expectedRgbaFnv1a64: rgbaHash,
    expectedManagedCoverage: Object.freeze({
      draws: visible ? 1 : 0,
      triangles: visible ? coverage.managedTriangles : 0,
    }),
    expectedGeneratedTriangles: derived.triangles.length,
    expectedExactRasterEmptyDraws:
      derived.path === "trivially-rejected" ? 1 : 0,
    expectedPushTevDrawCalls: 1,
    expectedSubmitGxFrameCalls: 1,
    expectedRejection: Object.freeze({
      aggregate: policyRejected ? 1 : 0,
      exactPreparation: policyRejected ? 1 : 0,
      preparationReason,
    }),
  });
  expectationCache.set(cacheKey, expectation);
  return expectation;
}

export function clipDisableGuardbandCertificationMatrix() {
  const matrix = [];
  let generation = 1;
  for (let run = 1; run <= CLIP_DISABLE_GUARDBAND_RUN_COUNT; run += 1) {
    for (const entry of clipDisableGuardbandCases) {
      for (const mode of CLIP_DISABLE_GUARDBAND_MODES) {
        matrix.push(
          Object.freeze({
            generation,
            run,
            caseId: entry.id,
            mode,
            expectation: clipDisableGuardbandExpectation(entry.id, mode),
          }),
        );
        generation += 1;
      }
    }
  }
  return Object.freeze(matrix);
}

function requiredObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function checkedDelta(before, after, name) {
  const delta =
    nonNegativeInteger(after, `after ${name}`) -
    nonNegativeInteger(before, `before ${name}`);
  if (!Number.isSafeInteger(delta) || delta < 0) {
    throw new RangeError(`${name} regressed`);
  }
  return delta;
}

function counterMapDelta(before, after, name) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key, index) => key !== afterKeys[index])
  ) {
    throw new TypeError(`${name} keys changed during one delta`);
  }
  const counts = Object.fromEntries(
    beforeKeys.map((key) => [
      key,
      checkedDelta(before[key], after[key], `${name}.${key}`),
    ]),
  );
  return {
    counts,
    sum: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

export function evaluateClipDisableGuardband(
  caseId,
  mode,
  beforeDiagnostics,
  afterDiagnostics,
  inputReadback,
) {
  const expected = clipDisableGuardbandExpectation(caseId, mode);
  const before = snapshotExactRequiredTelemetry(beforeDiagnostics);
  const after = snapshotExactRequiredTelemetry(afterDiagnostics);
  const aggregate = checkedDelta(
    before.aggregate,
    after.aggregate,
    "exact required rejection aggregate",
  );
  const reasons = counterMapDelta(
    before.reasons,
    after.reasons,
    "exact required rejection reasons",
  );
  const preparationReasons = counterMapDelta(
    before.preparationReasons,
    after.preparationReasons,
    "exact required preparation rejection reasons",
  );
  const expectedRejection = expected.expectedRejection;
  const expectedPreparationReason =
    expectedRejection.preparationReason;
  const rejectionExact =
    aggregate === expectedRejection.aggregate &&
    reasons.sum === expectedRejection.aggregate &&
    (reasons.counts.exactPreparation ?? 0) ===
      expectedRejection.exactPreparation &&
    preparationReasons.sum === expectedRejection.aggregate &&
    (
      expectedPreparationReason === null ||
      (preparationReasons.counts[expectedPreparationReason] ?? 0) === 1
    );

  const managedCoverage = {
    draws: checkedDelta(
      beforeDiagnostics.managedCoverageDraws,
      afterDiagnostics.managedCoverageDraws,
      "managed coverage draws",
    ),
    triangles: checkedDelta(
      beforeDiagnostics.managedCoverageTriangles,
      afterDiagnostics.managedCoverageTriangles,
      "managed coverage triangles",
    ),
  };
  const exactRasterEmptyDraws = checkedDelta(
    beforeDiagnostics.exactRasterEmptyDraws,
    afterDiagnostics.exactRasterEmptyDraws,
    "exact raster-empty draws",
  );
  const pushTevDrawCalls = checkedDelta(
    beforeDiagnostics.pushTevDrawCalls,
    afterDiagnostics.pushTevDrawCalls,
    "transported TEV draws",
  );
  const submitGxFrameCalls = checkedDelta(
    beforeDiagnostics.submitGxFrameCalls,
    afterDiagnostics.submitGxFrameCalls,
    "submitted GX frames",
  );
  const managedCoverageExact =
    managedCoverage.draws === expected.expectedManagedCoverage.draws &&
    managedCoverage.triangles ===
      expected.expectedManagedCoverage.triangles;
  const exactRasterEmptyExact =
    exactRasterEmptyDraws === expected.expectedExactRasterEmptyDraws;
  const pushTevDrawCallsExact =
    pushTevDrawCalls === expected.expectedPushTevDrawCalls;
  const submitGxFrameCallsExact =
    submitGxFrameCalls === expected.expectedSubmitGxFrameCalls;

  const readback = requiredObject(inputReadback, "readback");
  const width = nonNegativeInteger(readback.width, "readback.width");
  const height = nonNegativeInteger(readback.height, "readback.height");
  const rgba = Array.from(readback.rgba ?? []);
  const dimensionsExact =
    width === clipDisableGuardbandOracleXfb.width &&
    height === clipDisableGuardbandOracleXfb.height;
  const byteExact =
    rgba.length === expected.expectedRgba.length &&
    rgba.every(
      (channel, index) => channel === expected.expectedRgba[index],
    );
  const actualMaskRows = clipDisableGuardbandMaskRows(rgba);
  const maskExact = actualMaskRows.every(
    (mask, index) => mask === expected.expectedMaskRows[index],
  );
  const actualRgbaFnv1a64 = fnv1a64Hex(rgba);
  const hashExact =
    actualRgbaFnv1a64 === expected.expectedRgbaFnv1a64;

  return {
    pass:
      rejectionExact &&
      dimensionsExact &&
      byteExact &&
      maskExact &&
      hashExact &&
      managedCoverageExact &&
      exactRasterEmptyExact &&
      pushTevDrawCallsExact &&
      submitGxFrameCallsExact,
    caseId,
    mode,
    path: expected.path,
    rejectionExact,
    aggregate,
    reasonDelta: reasons.counts,
    preparationReasonDelta: preparationReasons.counts,
    dimensionsExact,
    byteExact,
    maskExact,
    expectedMaskRows: expected.expectedMaskRows,
    actualMaskRows,
    hashExact,
    expectedRgbaFnv1a64: expected.expectedRgbaFnv1a64,
    actualRgbaFnv1a64,
    managedCoverageExact,
    managedCoverage,
    exactRasterEmptyExact,
    exactRasterEmptyDraws,
    pushTevDrawCallsExact,
    pushTevDrawCalls,
    submitGxFrameCallsExact,
    submitGxFrameCalls,
  };
}
