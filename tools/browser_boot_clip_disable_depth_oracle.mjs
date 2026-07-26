import {
  snapshotExactRequiredTelemetry,
} from "./browser_boot_exact_preparation_telemetry_oracle.mjs";
import {
  RASTER_ALWAYS_PASS,
  RASTER_ALWAYS_UPDATE,
  RASTER_BLEND_ADDITIVE_ONE_ONE,
  RASTER_BLEND_REPLACE,
  RASTER_EQUAL_NO_UPDATE,
  buildRasterCenterOraclePacket,
} from "./browser_boot_raster_center_oracle.mjs";
import {
  buildVaryingRasterOraclePacket,
  fnv1a64Hex,
  varyingRasterExactClipPositions,
  varyingRasterExactState,
  varyingRasterOracleCases,
  varyingRasterOracleXfb,
  varyingRasterPacketLayout,
  varyingRasterSourceVector,
} from "./browser_boot_varying_raster_oracle.mjs";

const CLIP_DISABLE_DEFINED_MASK = 0b111;
const DISABLE_CLIPPING_DETECTION = 1 << 0;
const DISABLE_TRIVIAL_REJECTION = 1 << 1;
const DEPTH24_MAX = 0x00ffffff;
const DEPTH24_SEED = 0x00800000;
const EXACT_DRAW_INDEX = 1;
const PROBE_DRAW_COUNT = 3;
const PROBE_SCISSOR_RIGHT = 342 + 2;
const PROBE_SCISSOR_BOTTOM = 342 + 3;
const BLACK = Object.freeze([0, 0, 0, 255]);
const GREEN = Object.freeze([0, 255, 0, 255]);

const freezeRows = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));

const visibleCase = varyingRasterOracleCases.find(
  (entry) => entry.id === "raster0",
);
if (visibleCase === undefined) {
  throw new Error("missing varying-raster depth clip-disable carrier");
}

const blackRgba = Object.freeze(
  Array.from(
    { length: varyingRasterOracleXfb.width * varyingRasterOracleXfb.height },
    () => BLACK,
  ).flat(),
);
const depthProbeRgba = Object.freeze(
  Array.from(
    { length: varyingRasterOracleXfb.height },
    () => [
      ...GREEN,
      ...GREEN,
      ...GREEN,
      ...BLACK,
    ],
  ).flat(),
);

// Pokechu22's GameCube hardware test proves this ordering for mode 1:
// trivial rejection precedes the bit-0 polygon-clip bypass. Nintendo's
// ClipDisable register definition independently assigns bit 1 to disabling
// that trivial rejection.
//
// https://github.com/Pokechu22/hwtests/blob/328faf95cefe9f1d2e8cb0800f4d92c2e21a2a66/gxtest/clipping.cpp#L157-L212
export const CLIP_DISABLE_DEPTH_MODES = Object.freeze(
  Array.from({ length: 8 }, (_unused, mode) => mode),
);
export const CLIP_DISABLE_DEPTH_HASH_GENERATION = 37;
export const CLIP_DISABLE_DEPTH_BLACK_RGBA_FNV1A64 =
  "0x0852db856e95b5a5";
export const CLIP_DISABLE_DEPTH_PROBE_RGBA_FNV1A64 =
  "0x606c0d3fc73b8fa5";

export const clipDisableDepthCases = Object.freeze([
  Object.freeze({
    id: "crossing-near",
    name: "one positive-W endpoint crosses the GX near-depth plane",
    uniformDepthRejection: false,
    exactClipPositions: freezeRows(
      varyingRasterExactClipPositions.map((position, index) => [
        position[0],
        position[1],
        index === 0 ? -1.5 : -1,
        position[3],
      ]),
    ),
  }),
  Object.freeze({
    id: "uniform-near",
    name: "all positive-W endpoints cross the GX near-depth plane",
    uniformDepthRejection: true,
    exactClipPositions: freezeRows(
      varyingRasterExactClipPositions.map((position) => [
        position[0],
        position[1],
        -1.5,
        position[3],
      ]),
    ),
  }),
  Object.freeze({
    id: "uniform-far",
    name: "all positive-W endpoints cross the GX far-depth plane",
    uniformDepthRejection: true,
    exactClipPositions: freezeRows(
      varyingRasterExactClipPositions.map((position) => [
        position[0],
        position[1],
        0.5,
        position[3],
      ]),
    ),
  }),
]);

function exactCase(caseId) {
  const entry = clipDisableDepthCases.find(
    (candidate) => candidate.id === caseId,
  );
  if (entry === undefined) {
    throw new RangeError(`unknown clip-disable depth case ${caseId}`);
  }
  return entry;
}

export function clipDisableDepthExpectation(caseId, mode) {
  const entry = exactCase(caseId);
  if (
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > CLIP_DISABLE_DEFINED_MASK
  ) {
    throw new RangeError("mode must be an integer from 0 through 7");
  }
  const clippingDetectionDisabled =
    (mode & DISABLE_CLIPPING_DETECTION) !== 0;
  const trivialRejectionDisabled =
    (mode & DISABLE_TRIVIAL_REJECTION) !== 0;
  const visible =
    clippingDetectionDisabled &&
    (!entry.uniformDepthRejection || trivialRejectionDisabled);
  return Object.freeze({
    mode,
    clippingDetectionDisabled,
    trivialRejectionDisabled,
    cpolyClippingAccelerationDisabled: (mode & (1 << 2)) !== 0,
    visible,
    expectedRgba: visible ? visibleCase.expectedRgba : blackRgba,
    expectedRgbaFnv1a64: visible
      ? visibleCase.expectedRgbaFnv1a64
      : CLIP_DISABLE_DEPTH_BLACK_RGBA_FNV1A64,
    expectedMask: visible ? 0xffff : 0,
    expectedManagedCoverage: Object.freeze({
      draws: visible ? 1 : 0,
      triangles: visible ? 1 : 0,
    }),
    expectedExactRasterEmptyDraws: visible ? 0 : 1,
    expectedPushTevDrawCalls: 1,
    expectedSubmitGxFrameCalls: 1,
  });
}

export function buildClipDisableDepthOraclePacket(
  caseId,
  mode,
  generation = CLIP_DISABLE_DEPTH_HASH_GENERATION,
) {
  const entry = exactCase(caseId);
  clipDisableDepthExpectation(caseId, mode);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("generation must be a non-negative safe integer");
  }
  const packet = buildVaryingRasterOraclePacket(
    "raster0",
    generation,
    { xfClipDisable: mode },
  );
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  entry.exactClipPositions.flat().forEach((value, index) => {
    view.setFloat32(
      varyingRasterPacketLayout.exactChunkOffset + 0x30 + index * 4,
      value,
      true,
    );
  });
  // One additive pass over reset-black is byte-identical to the canonical
  // carrier. Any accidental native+managed duplicate doubles its unsaturated
  // channels and therefore fails the existing byte/hash contract.
  view.setUint32(
    varyingRasterPacketLayout.drawOffset + 0x14,
    RASTER_BLEND_ADDITIVE_ONE_ONE,
    true,
  );
  return packet;
}

function normalizedRgba(bytes) {
  return bytes.map((byte) => Math.fround(byte / 255));
}

function depthDraw(vertices, zMode, blendMode = RASTER_BLEND_REPLACE) {
  return {
    topology: 2,
    vertices,
    zMode,
    blendMode,
    alphaTest: RASTER_ALWAYS_PASS,
    pixelControl: 0,
    scissor: {
      x: 0,
      y: 0,
      width: varyingRasterOracleXfb.width,
      height: varyingRasterOracleXfb.height,
    },
  };
}

function uniformDepthVertices(depth24, rgba) {
  return varyingRasterSourceVector.screenPositions.map(([x, y]) => ({
    x,
    y,
    depth24,
    rgba,
  }));
}

export const clipDisableDepthProbeCases = Object.freeze([
  Object.freeze({
    id: "crossing-near-depth-write",
    name: "near bypass reconstructs and clamps varying depth to zero",
    mode: 1,
    clampDepth24: 0,
    exactClipPositions: exactCase("crossing-near").exactClipPositions,
  }),
  Object.freeze({
    id: "crossing-far-depth-write",
    name: "far bypass reconstructs and clamps varying depth to Z24 max",
    mode: 1,
    clampDepth24: DEPTH24_MAX,
    exactClipPositions: freezeRows(
      varyingRasterExactClipPositions.map((position, index) => [
        position[0],
        position[1],
        index === 0 ? 0.5 : 0,
        position[3],
      ]),
    ),
  }),
]);

function exactProbeCase(probeId) {
  const entry = clipDisableDepthProbeCases.find(
    (candidate) => candidate.id === probeId,
  );
  if (entry === undefined) {
    throw new RangeError(`unknown clip-disable depth probe ${probeId}`);
  }
  return entry;
}

export function buildClipDisableDepthProbePacket(
  probeId,
  generation = CLIP_DISABLE_DEPTH_HASH_GENERATION,
) {
  const entry = exactProbeCase(probeId);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("generation must be a non-negative safe integer");
  }
  const black = normalizedRgba(BLACK);
  const green = normalizedRgba(GREEN);
  const carrier = varyingRasterSourceVector.screenPositions.map(
    ([x, y], index) => ({
      x,
      y,
      depth24: varyingRasterSourceVector.depth24,
      rgba: normalizedRgba(
        varyingRasterSourceVector.raster0[index],
      ),
    }),
  );
  const base = buildRasterCenterOraclePacket(
    [
      depthDraw(
        uniformDepthVertices(DEPTH24_SEED, black),
        RASTER_ALWAYS_UPDATE,
      ),
      depthDraw(carrier, RASTER_ALWAYS_UPDATE),
      depthDraw(
        [
          { x: 0, y: 0 },
          { x: 1280, y: 0 },
          { x: 0, y: 1056 },
        ].map(({ x, y }) => ({
          x,
          y,
          depth24: entry.clampDepth24,
          rgba: green,
        })),
        RASTER_EQUAL_NO_UPDATE,
      ),
    ],
    generation,
  );
  const exactChunkBytes =
    0x30 + varyingRasterPacketLayout.vertexCount * 4 * 4;
  const packet = new Uint8Array(base.length + exactChunkBytes);
  packet.set(base);
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  const exactDraw =
    varyingRasterPacketLayout.drawOffset +
    EXACT_DRAW_INDEX * varyingRasterPacketLayout.drawBytes;
  const exact = base.length;
  view.setUint16(0x04, 6, true);
  view.setUint32(0x08, packet.length, true);
  view.setUint16(
    exactDraw + 0x02,
    varyingRasterPacketLayout.drawFlag,
    true,
  );
  view.setFloat32(
    exactDraw + 0xac,
    varyingRasterExactState.viewport[0],
    true,
  );
  view.setUint32(exact + 0x00, 1, true);
  view.setUint32(
    exact + 0x04,
    varyingRasterExactState.bpGenMode,
    true,
  );
  view.setUint32(
    exact + 0x08,
    varyingRasterExactState.bpScissorTopLeft,
    true,
  );
  view.setUint32(
    exact + 0x0c,
    (PROBE_SCISSOR_RIGHT << 12) | PROBE_SCISSOR_BOTTOM,
    true,
  );
  view.setUint32(
    exact + 0x10,
    varyingRasterExactState.bpScissorOffset,
    true,
  );
  view.setUint32(exact + 0x14, entry.mode, true);
  varyingRasterExactState.viewport.forEach((value, index) => {
    view.setFloat32(exact + 0x18 + index * 4, value, true);
  });
  entry.exactClipPositions.flat().forEach((value, index) => {
    view.setFloat32(exact + 0x30 + index * 4, value, true);
  });
  return packet;
}

export function clipDisableDepthProbeExpectation(probeId) {
  const entry = exactProbeCase(probeId);
  return Object.freeze({
    id: entry.id,
    name: entry.name,
    mode: entry.mode,
    visible: true,
    clampDepth24: entry.clampDepth24,
    expectedRgba: depthProbeRgba,
    expectedRgbaFnv1a64:
      CLIP_DISABLE_DEPTH_PROBE_RGBA_FNV1A64,
    expectedMask: 0x7777,
    expectedManagedCoverage: Object.freeze({
      draws: 1,
      triangles: 1,
    }),
    expectedExactRasterEmptyDraws: 0,
    expectedPushTevDrawCalls: PROBE_DRAW_COUNT,
    expectedSubmitGxFrameCalls: 1,
  });
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function checkedDelta(before, after, name) {
  const delta =
    nonNegativeInteger(after, `${name}.after`) -
    nonNegativeInteger(before, `${name}.before`);
  if (delta < 0) {
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
    throw new TypeError(`${name} keys changed`);
  }
  const counts = Object.fromEntries(
    beforeKeys.map((key) => [
      key,
      checkedDelta(before[key], after[key], `${name}.${key}`),
    ]),
  );
  return {
    counts,
    sum: Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    ),
  };
}

export function clipDisableDepthMask(rgba) {
  const expectedBytes =
    varyingRasterOracleXfb.width *
    varyingRasterOracleXfb.height *
    4;
  if (rgba.length !== expectedBytes) {
    throw new RangeError(
      "clip-disable depth mask requires one 4x4 RGBA surface",
    );
  }
  let mask = 0;
  for (let pixel = 0; pixel < rgba.length / 4; pixel += 1) {
    const offset = pixel * 4;
    if (
      rgba[offset] !== BLACK[0] ||
      rgba[offset + 1] !== BLACK[1] ||
      rgba[offset + 2] !== BLACK[2] ||
      rgba[offset + 3] !== BLACK[3]
    ) {
      mask |= 1 << pixel;
    }
  }
  return mask >>> 0;
}

function evaluateClipDisableDepthContract(
  caseId,
  mode,
  beforeDiagnostics,
  afterDiagnostics,
  readback,
  expected,
) {
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
  const telemetryZero =
    aggregate === 0 &&
    reasons.sum === 0 &&
    preparationReasons.sum === 0;
  const managedCoverageDelta = {
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
  const width = nonNegativeInteger(readback.width, "readback.width");
  const height = nonNegativeInteger(readback.height, "readback.height");
  const rgba = Array.from(readback.rgba ?? []);
  const dimensionsExact =
    width === varyingRasterOracleXfb.width &&
    height === varyingRasterOracleXfb.height;
  const byteExact =
    rgba.length === expected.expectedRgba.length &&
    rgba.every(
      (channel, index) => channel === expected.expectedRgba[index],
    );
  const actualRgbaFnv1a64 = fnv1a64Hex(rgba);
  const hashExact =
    actualRgbaFnv1a64 === expected.expectedRgbaFnv1a64;
  const actualMask = clipDisableDepthMask(rgba);
  const maskExact = actualMask === expected.expectedMask;
  const managedCoverageExact =
    managedCoverageDelta.draws ===
      expected.expectedManagedCoverage.draws &&
    managedCoverageDelta.triangles ===
      expected.expectedManagedCoverage.triangles;
  const exactRasterEmptyExact =
    exactRasterEmptyDraws === expected.expectedExactRasterEmptyDraws;
  const pushTevDrawCallsExact =
    pushTevDrawCalls === expected.expectedPushTevDrawCalls;
  const submitGxFrameCallsExact =
    submitGxFrameCalls === expected.expectedSubmitGxFrameCalls;

  return {
    pass:
      telemetryZero &&
      dimensionsExact &&
      byteExact &&
      hashExact &&
      maskExact &&
      managedCoverageExact &&
      exactRasterEmptyExact &&
      pushTevDrawCallsExact &&
      submitGxFrameCallsExact,
    caseId,
    mode,
    visible: expected.visible,
    telemetryZero,
    aggregate,
    reasonDelta: reasons.counts,
    preparationReasonDelta: preparationReasons.counts,
    dimensionsExact,
    byteExact,
    hashExact,
    maskExact,
    expectedRgbaFnv1a64: expected.expectedRgbaFnv1a64,
    actualRgbaFnv1a64,
    expectedMask: expected.expectedMask,
    actualMask,
    expectedManagedCoverage: expected.expectedManagedCoverage,
    managedCoverageDelta,
    managedCoverageExact,
    expectedExactRasterEmptyDraws:
      expected.expectedExactRasterEmptyDraws,
    exactRasterEmptyDraws,
    exactRasterEmptyExact,
    expectedPushTevDrawCalls: expected.expectedPushTevDrawCalls,
    pushTevDrawCalls,
    pushTevDrawCallsExact,
    expectedSubmitGxFrameCalls:
      expected.expectedSubmitGxFrameCalls,
    submitGxFrameCalls,
    submitGxFrameCallsExact,
    width,
    height,
  };
}

export function evaluateClipDisableDepth(
  caseId,
  mode,
  beforeDiagnostics,
  afterDiagnostics,
  readback,
) {
  return evaluateClipDisableDepthContract(
    caseId,
    mode,
    beforeDiagnostics,
    afterDiagnostics,
    readback,
    clipDisableDepthExpectation(caseId, mode),
  );
}

export function evaluateClipDisableDepthProbe(
  probeId,
  beforeDiagnostics,
  afterDiagnostics,
  readback,
) {
  const expected = clipDisableDepthProbeExpectation(probeId);
  return evaluateClipDisableDepthContract(
    probeId,
    expected.mode,
    beforeDiagnostics,
    afterDiagnostics,
    readback,
    expected,
  );
}
