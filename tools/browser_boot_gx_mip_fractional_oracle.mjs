import {
  buildGxMipColorOraclePacket,
  gxMipColorOracle,
  gxMipColorOraclePacketLayout,
} from "./browser_boot_gx_mip_color_oracle.mjs";
import {
  fnv1a64Hex,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";

const TEXTURE_MODE0 = 0x000000d0;
const TEXTURE_WIDTH = 4;
const TEXTURE_HEIGHT = 4;
const MIP_LEVEL_COUNT = 3;
const MAXIMUM_LOD_SIXTEENTHS = 2 * 16;
const TEXTURE_COORDINATE = Object.freeze([163 / 128, 227 / 128, 1]);
const FIXED_COORDINATE = Object.freeze([163, 227]);
const VERTEX_COUNT = 4;
const VERTEX_FLOATS = 36;
const COORDINATE_ZERO_FLOAT = 12;
const FRACTIONAL_LOD_CASES = Object.freeze(
  Array.from({ length: 17 }, (_, fraction) => fraction),
);
const COVERAGE_MASK = 0xffff;
const NON_UNIFORM_COVERAGE_COMPARISON_MASK = 0xeeee;

const LEVELS = Object.freeze([
  Object.freeze({
    level: 0,
    width: 4,
    height: 4,
    offset: 0,
    pixels: Object.freeze([
      17, 31, 47, 255, 83, 19, 211, 255,
      149, 97, 29, 255, 233, 151, 67, 255,
      41, 173, 59, 255, 227, 43, 101, 255,
      73, 239, 181, 255, 197, 89, 223, 255,
      113, 61, 241, 255, 29, 199, 137, 255,
      251, 127, 71, 255, 97, 229, 17, 255,
      181, 149, 83, 255, 53, 107, 197, 255,
      211, 37, 151, 255, 127, 251, 109, 255,
    ]),
  }),
  Object.freeze({
    level: 1,
    width: 2,
    height: 2,
    offset: 64,
    pixels: Object.freeze([
      239, 23, 71, 255, 61, 211, 193, 255,
      137, 89, 251, 255, 203, 157, 37, 255,
    ]),
  }),
  Object.freeze({
    level: 2,
    width: 1,
    height: 1,
    offset: 80,
    pixels: Object.freeze([109, 173, 227, 255]),
  }),
]);

const TEXTURE_PIXELS = Uint8Array.from(
  LEVELS.flatMap(level => level.pixels),
);

function fractionSixteenths(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      "GX fractional mip LOD must be an integer number of sixteenths",
    );
  }
  if (value < 0 || value > 16) {
    throw new RangeError(
      "GX fractional mip LOD must be between 0 and 16",
    );
  }
  return value;
}

function mode1ForFraction(value) {
  return (value | (MAXIMUM_LOD_SIXTEENTHS << 8)) >>> 0;
}

function clampIndex(value, extent) {
  return Math.min(extent - 1, Math.max(0, value));
}

function texel(level, x, y) {
  const offset = (y * level.width + x) * 4;
  return level.pixels.slice(offset, offset + 4);
}

function bilinearEvidence(levelIndex) {
  const level = LEVELS[levelIndex];
  const levelS = FIXED_COORDINATE[0] >> levelIndex;
  const levelT = FIXED_COORDINATE[1] >> levelIndex;
  const sourceS = levelS - 64;
  const sourceT = levelT - 64;
  const imageS0 = sourceS >> 7;
  const imageT0 = sourceT >> 7;
  const imageS1 = imageS0 + 1;
  const imageT1 = imageT0 + 1;
  const fractS = sourceS & 0x7f;
  const fractT = sourceT & 0x7f;
  const weights = Object.freeze([
    (128 - fractS) * (128 - fractT),
    fractS * (128 - fractT),
    (128 - fractS) * fractT,
    fractS * fractT,
  ]);
  const coordinates = Object.freeze([
    Object.freeze([
      clampIndex(imageS0, level.width),
      clampIndex(imageT0, level.height),
    ]),
    Object.freeze([
      clampIndex(imageS1, level.width),
      clampIndex(imageT0, level.height),
    ]),
    Object.freeze([
      clampIndex(imageS0, level.width),
      clampIndex(imageT1, level.height),
    ]),
    Object.freeze([
      clampIndex(imageS1, level.width),
      clampIndex(imageT1, level.height),
    ]),
  ]);
  const samples = coordinates.map(([x, y]) => texel(level, x, y));
  const rgba = Object.freeze(
    Array.from({ length: 4 }, (_, channel) => (
      samples[0][channel] * weights[0] +
      samples[1][channel] * weights[1] +
      samples[2][channel] * weights[2] +
      samples[3][channel] * weights[3]
    ) >> 14),
  );
  return Object.freeze({
    level: levelIndex,
    levelFixedCoordinate: Object.freeze([levelS, levelT]),
    halfTexelCenteredCoordinate: Object.freeze([sourceS, sourceT]),
    baseCoordinate: Object.freeze([imageS0, imageT0]),
    fraction128ths: Object.freeze([fractS, fractT]),
    coordinates,
    weights,
    weightDenominator: 128 * 128,
    rgba,
  });
}

const BILINEAR_LEVELS = Object.freeze([
  bilinearEvidence(0),
  bilinearEvidence(1),
]);

function nearestLevel(levelIndex) {
  const level = LEVELS[levelIndex];
  const x = clampIndex(
    (FIXED_COORDINATE[0] >> levelIndex) >> 7,
    level.width,
  );
  const y = clampIndex(
    (FIXED_COORDINATE[1] >> levelIndex) >> 7,
    level.height,
  );
  return Object.freeze(texel(level, x, y));
}

const NEAREST_LEVELS = Object.freeze([
  nearestLevel(0),
  nearestLevel(1),
]);

function blendLevels(
  fraction,
  levels = BILINEAR_LEVELS.map(entry => entry.rgba),
) {
  const baseLevel = fraction >> 4;
  const fractional = fraction & 15;
  const base = levels[baseLevel];
  if (fractional === 0) {
    return Object.freeze([...base]);
  }
  const next = levels[baseLevel + 1];
  return Object.freeze(
    base.map((value, channel) => (
      value * (16 - fractional) +
      next[channel] * fractional
    ) >> 4),
  );
}

function expectedSurface(
  sample,
  coverageMask = COVERAGE_MASK,
) {
  const rgba = [];
  for (
    let pixel = 0;
    pixel < gxMipColorOracle.xfb.width * gxMipColorOracle.xfb.height;
    pixel += 1
  ) {
    if ((coverageMask & (1 << pixel)) !== 0) {
      rgba.push(sample[0], sample[1], sample[2], 255);
    } else {
      rgba.push(0, 0, 0, 255);
    }
  }
  return Object.freeze(rgba);
}

function caseId(fraction) {
  if (fraction === 0) return "bilinear-level-0";
  if (fraction === 16) return "bilinear-level-1";
  return `trilinear-${fraction}-sixteenths`;
}

export function gxMipFractionalOraclePacketLayout() {
  return gxMipColorOraclePacketLayout();
}

export function buildGxMipFractionalOraclePacket(
  lodSixteenths,
  generation = 1,
) {
  lodSixteenths = fractionSixteenths(lodSixteenths);
  const packet = buildGxMipColorOraclePacket(0, generation);
  const layout = gxMipFractionalOraclePacketLayout();
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );

  packet.set(TEXTURE_PIXELS, layout.pixelOffset);
  view.setUint32(layout.drawOffset + 0x34, TEXTURE_MODE0, true);
  view.setUint32(
    layout.mode1Offset,
    mode1ForFraction(lodSixteenths),
    true,
  );
  for (let vertex = 0; vertex < VERTEX_COUNT; vertex += 1) {
    const coordinateOffset =
      layout.vertexOffset +
      vertex * VERTEX_FLOATS * 4 +
      COORDINATE_ZERO_FLOAT * 4;
    for (
      let component = 0;
      component < TEXTURE_COORDINATE.length;
      component += 1
    ) {
      view.setFloat32(
        coordinateOffset + component * 4,
        TEXTURE_COORDINATE[component],
        true,
      );
    }
  }
  return packet;
}

export const gxMipFractionalOracleCases = Object.freeze(
  FRACTIONAL_LOD_CASES.map((fraction) => {
    const expectedProbeRgba = blendLevels(fraction);
    const expectedRgba = expectedSurface(expectedProbeRgba);
    const nonUniformCoverageComparisonRgba = expectedSurface(
      expectedProbeRgba,
      NON_UNIFORM_COVERAGE_COMPARISON_MASK,
    );
    const nearestCoordinateComparisonRgba = blendLevels(
      fraction,
      NEAREST_LEVELS,
    );
    return Object.freeze({
      id: caseId(fraction),
      lodSixteenths: fraction,
      mode0: TEXTURE_MODE0,
      mode1: mode1ForFraction(fraction),
      baseMipLevel: fraction >> 4,
      mipFractionSixteenths: fraction & 15,
      expectedProbeRgba,
      nearestCoordinateComparisonRgba,
      expectedRgba,
      expectedRgbaFnv1a64: fnv1a64Hex(expectedRgba),
      nonUniformCoverageComparisonRgbaFnv1a64:
        fnv1a64Hex(nonUniformCoverageComparisonRgba),
    });
  }),
);

export const gxMipFractionalOracle = Object.freeze({
  packetVersion: gxMipColorOracle.packetVersion,
  key: gxMipColorOracle.key,
  width: TEXTURE_WIDTH,
  height: TEXTURE_HEIGHT,
  mipLevelCount: MIP_LEVEL_COUNT,
  payloadBytes: TEXTURE_PIXELS.length,
  mode0: TEXTURE_MODE0,
  minificationMode: (TEXTURE_MODE0 >>> 5) & 7,
  coordinate: TEXTURE_COORDINATE,
  fixedCoordinate: FIXED_COORDINATE,
  lodSixteenths: FRACTIONAL_LOD_CASES,
  maximumLodSixteenths: MAXIMUM_LOD_SIXTEENTHS,
  coverageMask: COVERAGE_MASK,
  nonUniformCoverageComparisonMask:
    NON_UNIFORM_COVERAGE_COMPARISON_MASK,
  probe: gxMipColorOracle.probe,
  xfb: gxMipColorOracle.xfb,
  levels: LEVELS.map(({ level, width, height, offset, pixels }) =>
    Object.freeze({
      level,
      width,
      height,
      offset,
      bytes: pixels.length,
    }),
  ),
  bilinearLevels: BILINEAR_LEVELS,
  expectedUpload: Object.freeze({
    textureWrites: gxMipColorOracle.expectedUpload.textureWrites,
    textureUploadBytes:
      gxMipColorOracle.expectedUpload.textureUploadBytes,
    packetPayloadBytes:
      gxMipColorOracle.expectedUpload.packetPayloadBytes,
    managedCoverageDraws: 1,
    managedCoverageTriangles: 2,
  }),
  limitation:
    "Constant coordinates and MODE1 minima isolate exact blend arithmetic; nonzero derivative LOD generation is intentionally outside this oracle.",
});

export const gxMipFractionalOraclePixels =
  Uint8Array.from(TEXTURE_PIXELS);
