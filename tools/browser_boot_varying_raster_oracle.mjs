import {
  RASTER_ALWAYS_PASS,
  RASTER_BLEND_REPLACE,
  buildRasterCenterOraclePacket,
  rasterCenterOracleXfb,
} from "./browser_boot_raster_center_oracle.mjs";
import { fnv1a64Hex } from "./browser_boot_projection_null_oracle.mjs";

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
const SOURCE_DEPTH24 = 256;
const RASTER1_STAGE_REFERENCE = 1 << 7;

const freezeRows = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));

export const VARYING_RASTER_HASH_GENERATION = 31;
export const VARYING_RASTER0_PACKET_FNV1A64 = "0xda99903e2c644b2c";
export const VARYING_RASTER1_PACKET_FNV1A64 = "0xdadfd73d616eb5ac";
export const VARYING_RASTER_SOFTFLOAT_PACKET_FNV1A64 =
  "0x878aba3ca036a1c1";
export const VARYING_RASTER0_RGBA_FNV1A64 = "0x27294576101d9645";
export const VARYING_RASTER1_RGBA_FNV1A64 = "0xc4890a0affbdb2e5";
export const VARYING_RASTER_SOFTFLOAT_RGBA_FNV1A64 =
  "0xde2093466a02486c";

export const varyingRasterPacketLayout = Object.freeze({
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

export const varyingRasterSourceVector = Object.freeze({
  screenPositions: freezeRows([
    [0, 0],
    [12, 0],
    [0, 12],
  ]),
  depth24: SOURCE_DEPTH24,
  raster0: freezeRows([
    [0, 0, 64, 255],
    [144, 0, 64, 255],
    [0, 144, 64, 255],
  ]),
  raster1: freezeRows([
    [255, 255, 128, 255],
    [111, 255, 128, 255],
    [255, 111, 128, 255],
  ]),
});

export const varyingRasterSoftfloatVector = Object.freeze({
  screenPositions: freezeRows([
    [
      272.8811950683594,
      41.4814453125,
    ],
    [
      270.8382873535156,
      39.99629211425781,
    ],
    [
      269.1499328613281,
      42.60606002807617,
    ],
  ]),
  depth24: SOURCE_DEPTH24,
  raster0: freezeRows([
    [242, 0, 0, 255],
    [190, 0, 0, 255],
    [65, 0, 0, 255],
  ]),
  raster1: freezeRows([
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]),
  snapped28_4: freezeRows([
    [4366, 664],
    [4333, 640],
    [4306, 682],
  ]),
  counterexample: Object.freeze({
    pixel: Object.freeze([270, 40]),
    separateXThenYBits: 0x4326ffff,
    separateXThenYByte: 166,
    fusedSetupBits: 0x43270001,
    yFirstBits: 0x43270000,
  }),
});

export const varyingRasterExactState = Object.freeze({
  bpGenMode: 0,
  bpScissorTopLeft: (342 << 12) | 342,
  bpScissorBottomRight: ((342 + 3) << 12) | (342 + 3),
  bpScissorOffset: 171 | (171 << 10),
  xfClipDisable: 0,
  viewport: Object.freeze([
    320,
    -264,
    DEPTH24_MAX,
    662,
    606,
    DEPTH24_MAX,
  ]),
});

export const varyingRasterSoftfloatExactState = Object.freeze({
  ...varyingRasterExactState,
  bpScissorTopLeft: (270 << 12) | 40,
  bpScissorBottomRight: (273 << 12) | 43,
  bpScissorOffset: 0,
  viewport: Object.freeze([320, 256, 256, 0, 0, SOURCE_DEPTH24]),
});

function normalizedRgba(bytes) {
  return bytes.map((byte) => Math.fround(byte / 255));
}

function exactClipPosition([x, y]) {
  return [
    Math.fround(Math.fround(x) / 320 - 1),
    Math.fround(1 - Math.fround(y) / 264),
    Math.fround(
      (Math.fround(SOURCE_DEPTH24) - DEPTH24_MAX) / DEPTH24_MAX,
    ),
    1,
  ];
}

function exactClipPositions(vector) {
  return freezeRows(vector.screenPositions.map(exactClipPosition));
}

export const varyingRasterExactClipPositions =
  exactClipPositions(varyingRasterSourceVector);
export const varyingRasterSoftfloatExactClipPositions =
  freezeRows(
    [
      [218.30494689941406, varyingRasterSoftfloatVector.screenPositions[0][1]],
      [216.67062377929688, varyingRasterSoftfloatVector.screenPositions[1][1]],
      [215.3199462890625, varyingRasterSoftfloatVector.screenPositions[2][1]],
    ].map(([x, y]) => [x, y, 0, 256]),
  );

function expectedSurface(channel) {
  const pixels = [];
  for (let y = 0; y < rasterCenterOracleXfb.height; y += 1) {
    for (let x = 0; x < rasterCenterOracleXfb.width; x += 1) {
      pixels.push(
        ...(channel === 0
          ? [12 * x + 7, 12 * y + 7, 64, 255]
          : [248 - 12 * x, 248 - 12 * y, 128, 255]),
      );
    }
  }
  return Object.freeze(pixels);
}

const raster0ExpectedRgba = expectedSurface(0);
const raster1ExpectedRgba = expectedSurface(1);
const softfloatExpectedRgba = Object.freeze([
  166, 0, 0, 255,
  207, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  145, 0, 0, 255,
  186, 0, 0, 255,
  227, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
]);

export const varyingRasterOracleCases = Object.freeze([
  Object.freeze({
    id: "raster0",
    name: "v6 reconstructs GX raster channel zero at 7/12",
    rasterChannel: 0,
    expectedRgba: raster0ExpectedRgba,
    expectedRgbaFnv1a64: VARYING_RASTER0_RGBA_FNV1A64,
    expectedManagedCoverage: Object.freeze({ draws: 1, triangles: 1 }),
    sourceVector: varyingRasterSourceVector,
    exactState: varyingRasterExactState,
    exactClipPositions: varyingRasterExactClipPositions,
    copySource: Object.freeze({ x: 0, y: 0 }),
  }),
  Object.freeze({
    id: "raster1",
    name: "v6 reconstructs GX raster channel one at 7/12",
    rasterChannel: 1,
    expectedRgba: raster1ExpectedRgba,
    expectedRgbaFnv1a64: VARYING_RASTER1_RGBA_FNV1A64,
    expectedManagedCoverage: Object.freeze({ draws: 1, triangles: 1 }),
    sourceVector: varyingRasterSourceVector,
    exactState: varyingRasterExactState,
    exactClipPositions: varyingRasterExactClipPositions,
    copySource: Object.freeze({ x: 0, y: 0 }),
  }),
  Object.freeze({
    id: "softfloat-boundary",
    name: "v6 preserves a separate-op f32 raster byte boundary",
    rasterChannel: 0,
    expectedRgba: softfloatExpectedRgba,
    expectedRgbaFnv1a64: VARYING_RASTER_SOFTFLOAT_RGBA_FNV1A64,
    expectedManagedCoverage: Object.freeze({ draws: 1, triangles: 1 }),
    sourceVector: varyingRasterSoftfloatVector,
    exactState: varyingRasterSoftfloatExactState,
    exactClipPositions: varyingRasterSoftfloatExactClipPositions,
    copySource: Object.freeze({ x: 270, y: 40 }),
  }),
]);

export const varyingRasterOracleXfb = Object.freeze({
  destination: rasterCenterOracleXfb.destination,
  width: rasterCenterOracleXfb.width,
  height: rasterCenterOracleXfb.height,
  stride: rasterCenterOracleXfb.stride,
});

function varyingRasterDraw(entry) {
  return {
    topology: 2,
    vertices: entry.sourceVector.screenPositions.map(
      ([x, y], index) => ({
        x,
        y,
        depth24: SOURCE_DEPTH24,
        rgba: normalizedRgba(entry.sourceVector.raster0[index]),
      }),
    ),
    zMode: 0,
    blendMode: RASTER_BLEND_REPLACE,
    alphaTest: RASTER_ALWAYS_PASS,
    pixelControl: 0,
    scissor: {
      x: entry.copySource.x,
      y: entry.copySource.y,
      width: varyingRasterOracleXfb.width,
      height: varyingRasterOracleXfb.height,
    },
  };
}

function writeRaster1(view, sourceVector) {
  for (let vertex = 0; vertex < VERTEX_COUNT; vertex += 1) {
    for (let component = 0; component < 4; component += 1) {
      view.setFloat32(
        VERTEX_OFFSET +
          vertex * VERTEX_BYTES +
          (8 + component) * 4,
        Math.fround(
          sourceVector.raster1[vertex][component] / 255,
        ),
        true,
      );
    }
  }
}

export function buildVaryingRasterOraclePacket(
  variant = "raster0",
  generation = VARYING_RASTER_HASH_GENERATION,
  {
    xfClipDisable = varyingRasterExactState.xfClipDisable,
  } = {},
) {
  const entry = varyingRasterOracleCases.find(
    (candidate) => candidate.id === variant,
  );
  if (entry === undefined) {
    throw new RangeError(`unknown varying-raster oracle variant ${variant}`);
  }
  if (
    !Number.isInteger(xfClipDisable) ||
    xfClipDisable < 0 ||
    xfClipDisable > 7
  ) {
    throw new RangeError("xfClipDisable must be an integer from 0 through 7");
  }
  const base = buildRasterCenterOraclePacket(
    [varyingRasterDraw(entry)],
    generation,
  );
  if (base.length !== BASE_PACKET_BYTES) {
    throw new Error(
      `varying-raster base packet is ${base.length}, expected ${BASE_PACKET_BYTES}`,
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
  view.setUint32(0x4c, entry.copySource.x, true);
  view.setUint32(0x50, entry.copySource.y, true);
  view.setFloat32(
    DRAW_OFFSET + 0xac,
    varyingRasterExactState.viewport[0],
    true,
  );
  view.setUint32(
    TEV_OFFSET + 0x08,
    entry.rasterChannel === 1 ? RASTER1_STAGE_REFERENCE : 0,
    true,
  );
  writeRaster1(view, entry.sourceVector);

  const exact = BASE_PACKET_BYTES;
  view.setUint32(exact + 0x00, 1, true);
  view.setUint32(
    exact + 0x04,
    entry.exactState.bpGenMode,
    true,
  );
  view.setUint32(
    exact + 0x08,
    entry.exactState.bpScissorTopLeft,
    true,
  );
  view.setUint32(
    exact + 0x0c,
    entry.exactState.bpScissorBottomRight,
    true,
  );
  view.setUint32(
    exact + 0x10,
    entry.exactState.bpScissorOffset,
    true,
  );
  view.setUint32(
    exact + 0x14,
    xfClipDisable,
    true,
  );
  entry.exactState.viewport.forEach((value, index) => {
    view.setFloat32(exact + 0x18 + index * 4, value, true);
  });
  entry.exactClipPositions.flat().forEach((value, index) => {
    view.setFloat32(exact + 0x30 + index * 4, value, true);
  });
  return packet;
}

export { fnv1a64Hex };
