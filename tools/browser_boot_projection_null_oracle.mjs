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
const VERTEX_COUNT = 3;
const DRAW_OFFSET = HEADER_BYTES;
const TEV_OFFSET = DRAW_OFFSET + DRAW_BYTES;
const VERTEX_OFFSET = TEV_OFFSET + TEV_BYTES;
const BASE_PACKET_BYTES = VERTEX_OFFSET + VERTEX_COUNT * VERTEX_BYTES;
const EXACT_CHUNK_BYTES = 48 + VERTEX_COUNT * 4 * 4;
const PACKET_BYTES = BASE_PACKET_BYTES + EXACT_CHUNK_BYTES;
const DRAW_FLAG_EXACT_CLIP_REQUIRED = 6;
const DEPTH24_MAX = 0x00ffffff;
const LEGACY_DEPTH = DEPTH24_MAX / 2;

const freezeRows = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));

export const PROJECTION_NULL_HASH_GENERATION = 31;
export const PROJECTION_NULL_PACKET_FNV1A64 = "0x1bf07ea382313711";
export const PROJECTION_NULL_RGBA_FNV1A64 = "0x84cc4da0e20ecde5";

export const projectionNullPacketLayout = Object.freeze({
  headerBytes: HEADER_BYTES,
  drawOffset: DRAW_OFFSET,
  drawBytes: DRAW_BYTES,
  tevOffset: TEV_OFFSET,
  tevBytes: TEV_BYTES,
  vertexOffset: VERTEX_OFFSET,
  vertexFloats: VERTEX_FLOATS,
  vertexBytes: VERTEX_BYTES,
  vertexCount: VERTEX_COUNT,
  basePacketBytes: BASE_PACKET_BYTES,
  exactChunkOffset: BASE_PACKET_BYTES,
  exactChunkBytes: EXACT_CHUNK_BYTES,
  packetBytes: PACKET_BYTES,
  drawFlag: DRAW_FLAG_EXACT_CLIP_REQUIRED,
});

export const projectionNullSourceVector = Object.freeze({
  projectionType: 0,
  projection: Object.freeze([1, 0, 1, 0, 0.5, 0]),
  viewPositions: freezeRows([
    [2, 0, 0],
    [-1, -1, -1],
    [-1, 1, -1],
  ]),
  legacyProjectedPositions: Object.freeze([
    null,
    Object.freeze([0, 4, LEGACY_DEPTH, 1]),
    Object.freeze([0, 0, LEGACY_DEPTH, 1]),
  ]),
  // The producer uses this finite sentinel only as non-authoritative carrier
  // geometry. LZGX v6 forbids the required draw from reaching that path.
  nativeCarrierPositions: freezeRows([
    [0, 0, 0, 1],
    [0, 4, LEGACY_DEPTH, 1],
    [0, 0, LEGACY_DEPTH, 1],
  ]),
  exactClipPositions: freezeRows([
    [2, 0, 0, -0],
    [-1, -1, -0.4999999403953552, 1],
    [-1, 1, -0.4999999403953552, 1],
  ]),
});

export const projectionNullExactState = Object.freeze({
  bpGenMode: 0,
  bpScissorTopLeft: (342 << 12) | 342,
  bpScissorBottomRight: ((342 + 3) << 12) | (342 + 3),
  bpScissorOffset: 171 | (171 << 10),
  xfClipDisable: 0,
  viewport: Object.freeze([
    2,
    -2,
    DEPTH24_MAX,
    344,
    344,
    DEPTH24_MAX,
  ]),
});

const expectedRgba = Object.freeze(
  new Array(
    rasterCenterOracleXfb.width * rasterCenterOracleXfb.height * 4,
  ).fill(255),
);

export const projectionNullOracleCase = Object.freeze({
  id: "projection-null-required",
  name: "v6 exact-required draw clips a legacy W=0 source",
  expectedMask: 0xffff,
  expectedRgba,
  expectedRgbaFnv1a64: PROJECTION_NULL_RGBA_FNV1A64,
  expectedManagedCoverage: Object.freeze({ draws: 1, triangles: 2 }),
});

export const projectionNullOracleXfb = Object.freeze({
  destination: rasterCenterOracleXfb.destination,
  width: rasterCenterOracleXfb.width,
  height: rasterCenterOracleXfb.height,
  stride: rasterCenterOracleXfb.stride,
});

function projectionNullDraw() {
  return {
    topology: 2,
    vertices: projectionNullSourceVector.nativeCarrierPositions.map(
      ([x, y, depth24]) => ({
        x,
        y,
        depth24,
        rgba: [1, 1, 1, 1],
      }),
    ),
    zMode: 0,
    blendMode: RASTER_BLEND_REPLACE,
    alphaTest: RASTER_ALWAYS_PASS,
    pixelControl: 0,
    scissor: {
      x: 0,
      y: 0,
      width: projectionNullOracleXfb.width,
      height: projectionNullOracleXfb.height,
    },
  };
}

export function buildProjectionNullOraclePacket(
  generation = PROJECTION_NULL_HASH_GENERATION,
) {
  const base = buildRasterCenterOraclePacket(
    [projectionNullDraw()],
    generation,
  );
  if (base.length !== BASE_PACKET_BYTES) {
    throw new Error(
      `projection-null base packet is ${base.length}, expected ${BASE_PACKET_BYTES}`,
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
  view.setUint16(
    DRAW_OFFSET + 0x02,
    DRAW_FLAG_EXACT_CLIP_REQUIRED,
    true,
  );
  view.setFloat32(
    DRAW_OFFSET + 0xac,
    projectionNullExactState.viewport[0],
    true,
  );

  const exact = BASE_PACKET_BYTES;
  view.setUint32(exact + 0x00, 1, true);
  view.setUint32(
    exact + 0x04,
    projectionNullExactState.bpGenMode,
    true,
  );
  view.setUint32(
    exact + 0x08,
    projectionNullExactState.bpScissorTopLeft,
    true,
  );
  view.setUint32(
    exact + 0x0c,
    projectionNullExactState.bpScissorBottomRight,
    true,
  );
  view.setUint32(
    exact + 0x10,
    projectionNullExactState.bpScissorOffset,
    true,
  );
  view.setUint32(
    exact + 0x14,
    projectionNullExactState.xfClipDisable,
    true,
  );
  projectionNullExactState.viewport.forEach((value, index) => {
    view.setFloat32(exact + 0x18 + index * 4, value, true);
  });
  projectionNullSourceVector.exactClipPositions
    .flat()
    .forEach((value, index) => {
      view.setFloat32(exact + 0x30 + index * 4, value, true);
    });
  return packet;
}

export function projectionNullMask(rgba) {
  const expectedBytes =
    projectionNullOracleXfb.width *
    projectionNullOracleXfb.height *
    4;
  if (rgba.length !== expectedBytes) {
    throw new RangeError(
      "projection-null mask requires one 4x4 RGBA surface",
    );
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
