import {
  RASTER_ALWAYS_PASS,
  RASTER_BLEND_REPLACE,
  buildRasterCenterOraclePacket,
  rasterCenterOracleXfb,
} from "./browser_boot_raster_center_oracle.mjs";

const HEADER_BYTES = 160;
const DRAW_BYTES = 176;
const TEV_BYTES = 464;
const VERTEX_FLOATS = 36;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const VERTEX_COUNT = 4;
const DRAW_OFFSET = HEADER_BYTES;
const TEXTURE_OFFSET = DRAW_OFFSET + DRAW_BYTES;
const TEV_OFFSET = TEXTURE_OFFSET;
const VERTEX_OFFSET = TEV_OFFSET + TEV_BYTES;
const PAYLOAD_BYTES = VERTEX_OFFSET + VERTEX_COUNT * VERTEX_BYTES;
const EVIDENCE_OFFSET = PAYLOAD_BYTES;
const EVIDENCE_BYTES = 1;
const PACKET_BYTES = 1392;
const DRAW_FLAG_POST_CULL_EVIDENCE = 1;
const KEEP_021_TWICE = 0x0f;
const FORCED_NATIVE_VERTEX = 3;
const FORCED_NATIVE_COMPONENT = 2;
const FORCED_NATIVE_COMPONENT_OFFSET =
  VERTEX_OFFSET +
  FORCED_NATIVE_VERTEX * VERTEX_BYTES +
  FORCED_NATIVE_COMPONENT * 4;

export const MANAGED_COVERAGE_HASH_GENERATION = 31;
export const MANAGED_COVERAGE_PACKET_FNV1A64 = "0xd6be3c7263790a3e";
export const FORCED_NATIVE_PACKET_FNV1A64 = "0x3d4b519d11ddeb83";
export const MANAGED_COVERAGE_RGBA_FNV1A64 = "0x84cc4da0e20ecde5";
export const FORCED_NATIVE_RGBA_FNV1A64 = "0x3e1fea1e71205fa5";

export const managedCoveragePacketLayout = Object.freeze({
  headerBytes: HEADER_BYTES,
  drawOffset: DRAW_OFFSET,
  drawBytes: DRAW_BYTES,
  textureOffset: TEXTURE_OFFSET,
  textureBytes: 0,
  tevOffset: TEV_OFFSET,
  tevBytes: TEV_BYTES,
  vertexOffset: VERTEX_OFFSET,
  vertexFloats: VERTEX_FLOATS,
  vertexBytes: VERTEX_BYTES,
  vertexCount: VERTEX_COUNT,
  keyOffset: PAYLOAD_BYTES,
  pixelOffset: PAYLOAD_BYTES,
  payloadBytes: PAYLOAD_BYTES,
  evidenceOffset: EVIDENCE_OFFSET,
  evidenceBytes: EVIDENCE_BYTES,
  evidencePaddedBytes: PACKET_BYTES - EVIDENCE_OFFSET,
  packetBytes: PACKET_BYTES,
  forcedNativeVertex: FORCED_NATIVE_VERTEX,
  forcedNativeComponent: FORCED_NATIVE_COMPONENT,
  forcedNativeComponentOffset: FORCED_NATIVE_COMPONENT_OFFSET,
});

export const managedCoverageEvidenceTail = Object.freeze({
  drawFlag: DRAW_FLAG_POST_CULL_EVIDENCE,
  keep021Twice: KEEP_021_TWICE,
});

export const managedCoverageExactGeometry = Object.freeze({
  sourceLeftX: 0.59,
  sourceRightX: 4,
  sourceTopY: 0,
  sourceBottomY: 4,
  snappedLeft28_4: 9,
  snappedRight28_4: 64,
  snappedTop28_4: 0,
  snappedBottom28_4: 64,
  sampleNumerator: 7,
  sampleDenominator: 12,
  sample28_4Numerator: 28,
  sample28_4Denominator: 3,
  leftEdgeMarginPixels: 1 / 48,
  reorderedTriangleArea28_4: -3520,
});

export const managedCoverageSnapBucket = Object.freeze([
  Object.freeze({
    sourceX: 0.575,
    sourceF32Bits: 0x3f133333,
    snapped28_4: 9,
    correctedNativeX: 0.49166664481163025,
    correctedNativeF32Bits: 0x3efbbbbb,
    currentNativeCoversPixel0: true,
  }),
  Object.freeze({
    sourceX: 0.59,
    sourceF32Bits: 0x3f170a3d,
    snapped28_4: 9,
    correctedNativeX: 0.5066666603088379,
    correctedNativeF32Bits: 0x3f01b4e8,
    currentNativeCoversPixel0: false,
  }),
  Object.freeze({
    sourceX: 0.6,
    sourceF32Bits: 0x3f19999a,
    snapped28_4: 10,
    correctedNativeX: 0.5166667103767395,
    correctedNativeF32Bits: 0x3f044445,
    currentNativeCoversPixel0: false,
  }),
]);

const black = Object.freeze([0, 0, 0, 255]);
const white = Object.freeze([255, 255, 255, 255]);

function expectedSurface(leftColumnCovered) {
  return Array.from(
    { length: rasterCenterOracleXfb.width * rasterCenterOracleXfb.height },
    (_, index) =>
      leftColumnCovered || index % rasterCenterOracleXfb.width !== 0
        ? white
        : black,
  ).flat();
}

const managedExpectedRgba = Object.freeze(expectedSurface(true));
const forcedNativeExpectedRgba = Object.freeze(expectedSurface(false));

export const managedCoverageOracleCases = Object.freeze([
  Object.freeze({
    id: "managed",
    name: "managed exact 28.4 plus 7/12 covers x=.590",
    forceNative: false,
    expectedMask: 0xffff,
    expectedRgba: managedExpectedRgba,
    expectedRgbaFnv1a64: MANAGED_COVERAGE_RGBA_FNV1A64,
  }),
  Object.freeze({
    id: "forced-native",
    name: "varying source depth retains the native x=.590 miss",
    forceNative: true,
    expectedMask: 0xeeee,
    expectedRgba: forcedNativeExpectedRgba,
    expectedRgbaFnv1a64: FORCED_NATIVE_RGBA_FNV1A64,
  }),
]);

function managedCoverageDraw() {
  const vertices = [
    [0.59, 0],
    [4, 0],
    [4, 4],
    [0.59, 4],
  ].map(([x, y]) => ({
    x,
    y,
    depth24: 0,
    rgba: [1, 1, 1, 1],
  }));
  return {
    topology: 0,
    vertices,
    zMode: 0,
    blendMode: RASTER_BLEND_REPLACE,
    alphaTest: RASTER_ALWAYS_PASS,
    pixelControl: 0,
    scissor: {
      x: 0,
      y: 0,
      width: rasterCenterOracleXfb.width,
      height: rasterCenterOracleXfb.height,
    },
  };
}

export function buildManagedCoverageOraclePacket(
  variant = "managed",
  generation = MANAGED_COVERAGE_HASH_GENERATION,
) {
  if (!managedCoverageOracleCases.some((entry) => entry.id === variant)) {
    throw new RangeError(`unknown managed coverage oracle variant ${variant}`);
  }
  const packet = buildRasterCenterOraclePacket(
    [managedCoverageDraw()],
    generation,
  );
  if (packet.length !== PAYLOAD_BYTES) {
    throw new Error(
      `managed coverage payload is ${packet.length}, expected ${PAYLOAD_BYTES}`,
    );
  }
  const extendedPacket = new Uint8Array(PACKET_BYTES);
  extendedPacket.set(packet);
  const view = new DataView(
    extendedPacket.buffer,
    extendedPacket.byteOffset,
    extendedPacket.byteLength,
  );
  view.setUint16(0x04, 4, true);
  view.setUint32(0x08, PACKET_BYTES, true);
  view.setUint16(
    DRAW_OFFSET + 0x02,
    DRAW_FLAG_POST_CULL_EVIDENCE,
    true,
  );
  extendedPacket[EVIDENCE_OFFSET] = KEEP_021_TWICE;
  if (variant === "forced-native") {
    view.setFloat32(FORCED_NATIVE_COMPONENT_OFFSET, 1, true);
  }
  return extendedPacket;
}

export function managedCoverageMask(rgba) {
  const expectedBytes =
    rasterCenterOracleXfb.width * rasterCenterOracleXfb.height * 4;
  if (rgba.length !== expectedBytes) {
    throw new RangeError("managed coverage mask requires one 4x4 RGBA surface");
  }
  let mask = 0;
  for (let pixel = 0; pixel < rgba.length / 4; pixel += 1) {
    const offset = pixel * 4;
    if (
      rgba[offset] === 255 &&
      rgba[offset + 1] === 255 &&
      rgba[offset + 2] === 255 &&
      rgba[offset + 3] === 255
    ) {
      mask |= 1 << pixel;
    }
  }
  return mask >>> 0;
}

export function fnv1a64Hex(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `0x${hash.toString(16).padStart(16, "0")}`;
}

export const managedCoverageOracleXfb = Object.freeze({
  destination: rasterCenterOracleXfb.destination,
  width: rasterCenterOracleXfb.width,
  height: rasterCenterOracleXfb.height,
  stride: rasterCenterOracleXfb.stride,
});
