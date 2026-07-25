import {
  buildGxMipColorOraclePacket,
  gxMipColorOracle,
  gxMipColorOracleCases,
  gxMipColorOraclePacketLayout,
  gxMipColorOraclePixels,
} from "./browser_boot_gx_mip_color_oracle.mjs";
import {
  fnv1a64Hex,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";

const PACKET_VERSION = 7;
const VERTEX_FLOATS = 36;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const VERTEX_COUNT = 4;
const COORDINATE_ZERO_FLOAT = 12;
const MODE1_WORDS_PER_DRAW = 8;
const MODE1_BYTES_PER_DRAW = MODE1_WORDS_PER_DRAW * 4;
const EVIDENCE_BYTES_PER_DRAW = 1;
const TEXTURE_PAYLOAD_BYTES = gxMipColorOracle.payloadBytes;
const PADDED_TEXTURE_PIXEL_BYTES =
  gxMipColorOracle.paddedPixelBytes;
const TILE_WIDTH = gxMipColorOracle.xfb.width;
const TILE_HEIGHT = gxMipColorOracle.xfb.height;
const BASE_S_RAW = 4096;
const BASE_T_RAW = 6144;
const MIP_NEAREST = 1;
const MIP_LINEAR = 2;
const DEFAULT_MIN_LOD = 0;
const DEFAULT_MAX_LOD = 2 * 16;
const AFFINE_POSITIONS = Object.freeze([
  Object.freeze([0.59, 0]),
  Object.freeze([4, 0]),
  Object.freeze([4, 4]),
  Object.freeze([0.59, 4]),
]);
const LEVEL_COLORS = Object.freeze(
  gxMipColorOracleCases.map(entry =>
    Object.freeze([...entry.color]),
  ),
);

function align16(value) {
  return (value + 15) & ~15;
}

function generationU32(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new RangeError(
      "GX derivative mip generation must be a u32",
    );
  }
  return value;
}

function rawDerivative(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be an integer S17.7 delta`);
  }
  if (Math.abs(value) > 1 << 20) {
    throw new RangeError(`${field} exceeds the derivative oracle range`);
  }
  return value;
}

function lodClamp(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be an integer number of sixteenths`);
  }
  if (value < 0 || value > 0xff) {
    throw new RangeError(`${field} must fit in an unsigned byte`);
  }
  return value;
}

function lodBias(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      "GX derivative LOD bias must be integer sixteenths",
    );
  }
  if (value < -64 || value > 63) {
    throw new RangeError(
      "GX derivative LOD bias must be between -64 and 63",
    );
  }
  return value;
}

function mipMode(value) {
  if (value !== MIP_NEAREST && value !== MIP_LINEAR) {
    throw new RangeError(
      "GX derivative oracle mip mode must be nearest or linear",
    );
  }
  return value;
}

function canonicalVector(definition) {
  const dx = definition.dx ?? [0, 0];
  const dy = definition.dy ?? [0, 0];
  if (
    !Array.isArray(dx) ||
    !Array.isArray(dy) ||
    dx.length !== 2 ||
    dy.length !== 2
  ) {
    throw new TypeError(
      "GX derivative oracle dx and dy must have two components",
    );
  }
  const biasSixteenths = lodBias(definition.biasSixteenths ?? 0);
  const minLodSixteenths = lodClamp(
    definition.minLodSixteenths ?? DEFAULT_MIN_LOD,
    "GX derivative minimum LOD",
  );
  const maxLodSixteenths = lodClamp(
    definition.maxLodSixteenths ?? DEFAULT_MAX_LOD,
    "GX derivative maximum LOD",
  );
  return Object.freeze({
    ...definition,
    dx: Object.freeze([
      rawDerivative(dx[0], "GX derivative dS/dx"),
      rawDerivative(dx[1], "GX derivative dT/dx"),
    ]),
    dy: Object.freeze([
      rawDerivative(dy[0], "GX derivative dS/dy"),
      rawDerivative(dy[1], "GX derivative dT/dy"),
    ]),
    diagonal: definition.diagonal === true,
    biasSixteenths,
    minLodSixteenths,
    maxLodSixteenths,
    mipMode: mipMode(definition.mipMode ?? MIP_NEAREST),
  });
}

function encodedBiasRaw(biasSixteenths) {
  return (biasSixteenths * 2) & 0xff;
}

function mode0For(vector) {
  return (
    (vector.mipMode << 5) |
    (Number(vector.diagonal) << 8) |
    (encodedBiasRaw(vector.biasSixteenths) << 9)
  ) >>> 0;
}

function mode1For(vector) {
  return (
    vector.minLodSixteenths |
    (vector.maxLodSixteenths << 8)
  ) >>> 0;
}

function blendLevelColors(lodSixteenths) {
  const baseLevel = lodSixteenths >> 4;
  const fraction = lodSixteenths & 15;
  const base = LEVEL_COLORS[baseLevel];
  if (base === undefined) {
    throw new RangeError(
      "GX derivative model selected a nonresident mip level",
    );
  }
  if (fraction === 0) {
    return Object.freeze([...base]);
  }
  const next = LEVEL_COLORS[baseLevel + 1];
  if (next === undefined) {
    throw new RangeError(
      "GX derivative model blended past the resident mip chain",
    );
  }
  return Object.freeze(
    base.map((value, channel) => (
      value * (16 - fraction) +
      next[channel] * fraction
    ) >> 4),
  );
}

function nearestLevel(lodSixteenths) {
  let level = lodSixteenths >> 4;
  if ((lodSixteenths & 15) >= 8) {
    level += 1;
  }
  return level;
}

export function modelGxMipDerivativeLod(definition) {
  const vector = canonicalVector(definition);
  const deltaX = vector.dx.map(Math.abs);
  const deltaY = vector.dy.map(Math.abs);
  const combined = vector.diagonal
    ? [
        deltaX[0] + deltaY[0],
        deltaX[1] + deltaY[1],
      ]
    : [
        Math.max(deltaX[0], deltaY[0]),
        Math.max(deltaX[1], deltaY[1]),
      ];
  const rhoRaw = Math.max(combined[0], combined[1]);
  const effectiveMinLodSixteenths = Math.min(
    vector.minLodSixteenths,
    vector.maxLodSixteenths,
  );
  const derivativeLodSixteenths = rhoRaw === 0
    ? effectiveMinLodSixteenths
    : Math.floor(Math.log2(rhoRaw / 128) * 16) +
      vector.biasSixteenths;
  const clampedLodSixteenths = Math.max(
    effectiveMinLodSixteenths,
    Math.min(vector.maxLodSixteenths, derivativeLodSixteenths),
  );
  const selectedLevel = vector.mipMode === MIP_NEAREST
    ? nearestLevel(clampedLodSixteenths)
    : null;
  const expectedRgba = vector.mipMode === MIP_NEAREST
    ? LEVEL_COLORS[selectedLevel]
    : blendLevelColors(clampedLodSixteenths);
  if (expectedRgba === undefined) {
    throw new RangeError(
      "GX derivative model selected a nonresident mip level",
    );
  }
  return Object.freeze({
    deltaX: Object.freeze(deltaX),
    deltaY: Object.freeze(deltaY),
    combinedDelta: Object.freeze(combined),
    rhoRaw,
    rho: rhoRaw / 128,
    effectiveMinLodSixteenths,
    derivativeLodSixteenths,
    clampedLodSixteenths,
    selectedLevel,
    expectedRgba: Object.freeze([...expectedRgba]),
  });
}

function expectedSolidSurface(rgba, width = TILE_WIDTH) {
  return Object.freeze(
    Array.from(
      { length: width * TILE_HEIGHT },
      () => rgba,
    ).flat(),
  );
}

function completeVector(definition) {
  const vector = canonicalVector(definition);
  const model = modelGxMipDerivativeLod(vector);
  const mode0 = mode0For(vector);
  const mode1 = mode1For(vector);
  const expectedRgba = model.expectedRgba;
  const expectedSurface = expectedSolidSurface(expectedRgba);
  return Object.freeze({
    ...vector,
    model,
    mode0,
    mode1,
    expectedRgba,
    expectedSurface,
    expectedSurfaceFnv1a64: fnv1a64Hex(expectedSurface),
  });
}

const HARD_GATE_DEFINITIONS = Object.freeze([
  {
    id: "flat-zero-derivative",
    feature: "flat",
    margin: "wide",
    dx: [0, 0],
    dy: [0, 0],
  },
  {
    id: "dpdx-wide-level-one",
    feature: "dpdx",
    margin: "wide",
    dx: [256, 0],
    dy: [0, 0],
  },
  {
    id: "non-power-trilinear-composition",
    feature: "non-power-trilinear-composition",
    margin: "wide",
    dx: [194, 0],
    dy: [0, 0],
    mipMode: MIP_LINEAR,
  },
  {
    id: "negative-gradient-absolute",
    feature: "negative-gradient-absolute",
    margin: "wide",
    dx: [-256, 0],
    dy: [0, 0],
  },
  {
    id: "dpdy-wide-level-two",
    feature: "dpdy",
    margin: "wide",
    dx: [0, 0],
    dy: [0, 512],
  },
  {
    id: "edge-co-component-control",
    feature: "edge-component-max",
    margin: "wide",
    dx: [128, 0],
    dy: [128, 0],
  },
  {
    id: "diagonal-co-component-sum",
    feature: "diagonal-component-sum",
    margin: "wide",
    dx: [128, 0],
    dy: [128, 0],
    diagonal: true,
  },
  {
    id: "diagonal-cross-component-control",
    feature: "diagonal-component-control",
    margin: "wide",
    dx: [128, 0],
    dy: [0, 128],
    diagonal: true,
  },
  {
    id: "positive-signed-bias-wide",
    feature: "positive-signed-bias",
    margin: "wide",
    dx: [256, 0],
    biasSixteenths: 16,
  },
  {
    id: "negative-signed-bias-wide",
    feature: "negative-signed-bias",
    margin: "wide",
    dx: [256, 0],
    biasSixteenths: -16,
  },
  {
    id: "minimum-clamp-below-minimum",
    feature: "minimum-clamp",
    margin: "wide",
    dx: [128, 0],
    minLodSixteenths: 16,
  },
  {
    id: "maximum-clamp-wide",
    feature: "maximum-clamp",
    margin: "wide",
    dx: [1024, 0],
    maxLodSixteenths: 17,
  },
  {
    id: "maximum-wins-over-minimum",
    feature: "max-wins-clamp",
    margin: "wide",
    dx: [512, 0],
    minLodSixteenths: 32,
    maxLodSixteenths: 17,
  },
  {
    id: "nearest-threshold-seven-sixteenths",
    feature: "nearest-threshold-below",
    margin: "threshold",
    dx: [128, 0],
    biasSixteenths: 7,
  },
  {
    id: "nearest-threshold-eight-sixteenths",
    feature: "nearest-threshold-at",
    margin: "threshold",
    dx: [128, 0],
    biasSixteenths: 8,
  },
]);

const FINGERPRINT_DEFINITIONS = Object.freeze([
  {
    id: "adapter-boundary-1-16-below",
    feature: "derivative-lod-boundary",
    margin: "adapter-fingerprint",
    dx: [133, 0],
    mipMode: MIP_LINEAR,
    boundarySixteenths: 1,
  },
  {
    id: "adapter-boundary-1-16-above",
    feature: "derivative-lod-boundary",
    margin: "adapter-fingerprint",
    dx: [134, 0],
    mipMode: MIP_LINEAR,
    boundarySixteenths: 1,
  },
]);

export const gxMipDerivativeHardGateCases = Object.freeze(
  HARD_GATE_DEFINITIONS.map(completeVector),
);

export const gxMipDerivativeFingerprintCases = Object.freeze(
  FINGERPRINT_DEFINITIONS.map(completeVector),
);

export const gxMipDerivativeOracleCases = Object.freeze([
  ...gxMipDerivativeHardGateCases,
  ...gxMipDerivativeFingerprintCases,
]);

export function classifyGxMipDerivativeFingerprint(observedLods) {
  if (!Array.isArray(observedLods)) {
    throw new TypeError(
      "GX derivative fingerprint observations must be an array",
    );
  }
  const uniqueLods = [...new Set(observedLods)];
  const uniformBucket =
    observedLods.length > 0 && uniqueLods.length === 1;
  const observedBucket = uniformBucket ? uniqueLods[0] : null;
  const plausibleBucket =
    uniformBucket &&
    (observedBucket === 0 || observedBucket === 1);
  return Object.freeze({
    uniformBucket,
    observedBucket,
    plausibleBucket,
  });
}

function definitionFor(id) {
  const definition = gxMipDerivativeOracleCases.find(
    entry => entry.id === id,
  );
  if (definition === undefined) {
    throw new RangeError(
      `unknown GX derivative mip oracle vector ${id}`,
    );
  }
  return definition;
}

function writeAffineGeometry(
  view,
  vertexOffset,
  vector,
  tileX = 0,
) {
  for (let vertex = 0; vertex < VERTEX_COUNT; vertex += 1) {
    const [localX, y] = AFFINE_POSITIONS[vertex];
    const x = localX + tileX;
    const sourceOffset = vertexOffset + vertex * VERTEX_BYTES;
    view.setFloat32(sourceOffset, x, true);
    view.setFloat32(sourceOffset + 4, y, true);
    const coordinateOffset =
      sourceOffset + COORDINATE_ZERO_FLOAT * 4;
    const sRaw =
      BASE_S_RAW +
      vector.dx[0] * localX +
      vector.dy[0] * y;
    const tRaw =
      BASE_T_RAW +
      vector.dx[1] * localX +
      vector.dy[1] * y;
    view.setFloat32(coordinateOffset, sRaw / 128, true);
    view.setFloat32(coordinateOffset + 4, tRaw / 128, true);
    view.setFloat32(coordinateOffset + 8, 1, true);
  }
}

export function gxMipDerivativeOraclePacketLayout() {
  return gxMipColorOraclePacketLayout();
}

export function buildGxMipDerivativeOraclePacket(
  id,
  generation = 1,
) {
  generation = generationU32(generation);
  const vector = definitionFor(id);
  const packet = buildGxMipColorOraclePacket(0, generation);
  const layout = gxMipDerivativeOraclePacketLayout();
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  view.setUint32(layout.drawOffset + 0x34, vector.mode0, true);
  view.setUint32(layout.mode1Offset, vector.mode1, true);
  writeAffineGeometry(view, layout.vertexOffset, vector);
  return packet;
}

const SEQUENCE_STATE_A = completeVector({
  id: "sequence-a",
  feature: "cross-draw-state-a",
  margin: "wide",
  dx: [256, 0],
  biasSixteenths: -16,
  minLodSixteenths: 0,
  maxLodSixteenths: 32,
});

const SEQUENCE_STATE_B = completeVector({
  id: "sequence-b",
  feature: "cross-draw-state-b",
  margin: "wide",
  dx: [256, 0],
  biasSixteenths: 16,
  minLodSixteenths: 32,
  maxLodSixteenths: 32,
});

const SEQUENCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "cross-draw-abba",
    order: Object.freeze([
      Object.freeze({ slot: 0, state: SEQUENCE_STATE_A }),
      Object.freeze({ slot: 1, state: SEQUENCE_STATE_B }),
      Object.freeze({ slot: 2, state: SEQUENCE_STATE_B }),
      Object.freeze({ slot: 3, state: SEQUENCE_STATE_A }),
    ]),
  }),
  Object.freeze({
    id: "cross-draw-abba-permuted-records",
    order: Object.freeze([
      Object.freeze({ slot: 1, state: SEQUENCE_STATE_B }),
      Object.freeze({ slot: 0, state: SEQUENCE_STATE_A }),
      Object.freeze({ slot: 3, state: SEQUENCE_STATE_A }),
      Object.freeze({ slot: 2, state: SEQUENCE_STATE_B }),
    ]),
  }),
]);

function sequenceFor(id) {
  const sequence = SEQUENCE_DEFINITIONS.find(
    entry => entry.id === id,
  );
  if (sequence === undefined) {
    throw new RangeError(
      `unknown GX derivative mip sequence ${id}`,
    );
  }
  return sequence;
}

function sequenceExpectedSurface(order) {
  const width = order.length * TILE_WIDTH;
  const statesBySlot = Array(order.length);
  for (const { slot, state } of order) {
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      slot >= order.length ||
      statesBySlot[slot] !== undefined
    ) {
      throw new Error("GX derivative sequence slots must be unique");
    }
    statesBySlot[slot] = state;
  }
  const rgba = [];
  for (let y = 0; y < TILE_HEIGHT; y += 1) {
    for (const vector of statesBySlot) {
      for (let x = 0; x < TILE_WIDTH; x += 1) {
        rgba.push(...vector.expectedRgba);
      }
    }
  }
  if (rgba.length !== width * TILE_HEIGHT * 4) {
    throw new Error("GX derivative sequence surface is incomplete");
  }
  return Object.freeze(rgba);
}

export function gxMipDerivativeSequencePacketLayout(
  drawCount = 4,
) {
  if (!Number.isSafeInteger(drawCount) || drawCount < 1) {
    throw new RangeError(
      "GX derivative sequence draw count must be positive",
    );
  }
  const base = gxMipColorOraclePacketLayout();
  const drawRecordBytes = base.textureOffset - base.drawOffset;
  const textureRecordBytes = base.tevOffset - base.textureOffset;
  const tevRecordBytes = base.vertexOffset - base.tevOffset;
  const verticesPerDrawBytes = VERTEX_COUNT * VERTEX_BYTES;
  const headerBytes = base.headerBytes;
  const drawOffset = headerBytes;
  const drawBytes = drawCount * drawRecordBytes;
  const textureOffset = drawOffset + drawBytes;
  const textureBytes = textureRecordBytes;
  const tevOffset = textureOffset + textureBytes;
  const tevBytes = drawCount * tevRecordBytes;
  const vertexOffset = tevOffset + tevBytes;
  const vertexBytes = drawCount * verticesPerDrawBytes;
  const keyOffset = vertexOffset + vertexBytes;
  const keyBytes = base.keyBytes;
  const pixelOffset = align16(keyOffset + keyBytes);
  const pixelBytes = PADDED_TEXTURE_PIXEL_BYTES;
  const evidenceOffset = pixelOffset + pixelBytes;
  const evidenceBytes = drawCount * EVIDENCE_BYTES_PER_DRAW;
  const mode1Offset = align16(evidenceOffset + evidenceBytes);
  const mode1Bytes = drawCount * MODE1_BYTES_PER_DRAW;
  const packetBytes = mode1Offset + mode1Bytes;
  return Object.freeze({
    headerBytes,
    drawOffset,
    drawBytes,
    drawRecordBytes,
    textureOffset,
    textureBytes,
    textureRecordBytes,
    tevOffset,
    tevBytes,
    tevRecordBytes,
    vertexOffset,
    vertexBytes,
    vertexBytesPerDraw: verticesPerDrawBytes,
    keyOffset,
    keyBytes,
    pixelOffset,
    pixelBytes,
    evidenceOffset,
    evidenceBytes,
    mode1Offset,
    mode1Bytes,
    packetBytes,
    drawCount,
  });
}

export function buildGxMipDerivativeSequencePacket(
  id,
  generation = 1,
) {
  generation = generationU32(generation);
  const sequence = sequenceFor(id);
  const base = buildGxMipColorOraclePacket(0, generation);
  const baseLayout = gxMipColorOraclePacketLayout();
  const layout = gxMipDerivativeSequencePacketLayout(
    sequence.order.length,
  );
  const packet = new Uint8Array(layout.packetBytes);
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );

  packet.set(base.subarray(0, baseLayout.headerBytes), 0);
  view.setUint16(0x04, PACKET_VERSION, true);
  view.setUint32(0x08, layout.packetBytes, true);
  view.setUint32(0x14, layout.drawCount, true);
  view.setUint32(0x1c, layout.drawOffset, true);
  view.setUint32(0x20, layout.textureOffset, true);
  view.setUint32(0x24, layout.tevOffset, true);
  view.setUint32(0x28, layout.vertexOffset, true);
  view.setUint32(0x2c, layout.keyOffset, true);
  view.setUint32(0x30, layout.pixelOffset, true);
  view.setUint32(0x34, layout.drawBytes, true);
  view.setUint32(0x38, layout.textureBytes, true);
  view.setUint32(0x3c, layout.tevBytes, true);
  view.setUint32(0x40, layout.vertexBytes, true);
  view.setUint32(0x44, layout.keyBytes, true);
  view.setUint32(0x48, layout.pixelBytes, true);
  view.setUint32(0x54, layout.drawCount * TILE_WIDTH, true);
  view.setUint32(0x58, TILE_HEIGHT, true);
  view.setUint32(0x5c, layout.drawCount * TILE_WIDTH, true);
  view.setUint32(0x60, TILE_HEIGHT, true);
  view.setUint32(
    0x68,
    layout.drawCount * TILE_WIDTH * 4,
    true,
  );
  view.setUint32(0x6c, generation, true);
  view.setUint32(0x7c, layout.drawCount * VERTEX_COUNT, true);

  for (
    let drawIndex = 0;
    drawIndex < sequence.order.length;
    drawIndex += 1
  ) {
    const { slot, state: vector } = sequence.order[drawIndex];
    const drawOffset =
      layout.drawOffset + drawIndex * layout.drawRecordBytes;
    const tevOffset =
      layout.tevOffset + drawIndex * layout.tevRecordBytes;
    const vertexOffset =
      layout.vertexOffset +
      drawIndex * layout.vertexBytesPerDraw;
    packet.set(
      base.subarray(
        baseLayout.drawOffset,
        baseLayout.drawOffset + layout.drawRecordBytes,
      ),
      drawOffset,
    );
    packet.set(
      base.subarray(
        baseLayout.tevOffset,
        baseLayout.tevOffset + layout.tevRecordBytes,
      ),
      tevOffset,
    );
    packet.set(
      base.subarray(
        baseLayout.vertexOffset,
        baseLayout.vertexOffset + layout.vertexBytesPerDraw,
      ),
      vertexOffset,
    );
    view.setUint32(
      drawOffset + 0x08,
      drawIndex * layout.vertexBytesPerDraw,
      true,
    );
    view.setUint32(
      drawOffset + 0x0c,
      drawIndex * layout.tevRecordBytes,
      true,
    );
    view.setUint32(drawOffset + 0x1c, slot * TILE_WIDTH, true);
    view.setUint32(drawOffset + 0x20, 0, true);
    view.setUint32(drawOffset + 0x24, TILE_WIDTH, true);
    view.setUint32(drawOffset + 0x28, TILE_HEIGHT, true);
    view.setUint32(drawOffset + 0x34, vector.mode0, true);
    writeAffineGeometry(
      view,
      vertexOffset,
      vector,
      slot * TILE_WIDTH,
    );
    packet[layout.evidenceOffset + drawIndex] = 0x0f;
    view.setUint32(
      layout.mode1Offset + drawIndex * MODE1_BYTES_PER_DRAW,
      vector.mode1,
      true,
    );
  }

  packet.set(
    base.subarray(
      baseLayout.textureOffset,
      baseLayout.textureOffset + layout.textureRecordBytes,
    ),
    layout.textureOffset,
  );
  packet.set(
    base.subarray(
      baseLayout.keyOffset,
      baseLayout.keyOffset + baseLayout.keyBytes,
    ),
    layout.keyOffset,
  );
  packet.set(
    gxMipColorOraclePixels,
    layout.pixelOffset,
  );
  return packet;
}

export const gxMipDerivativeSequenceCases = Object.freeze(
  SEQUENCE_DEFINITIONS.map(sequence => {
    const expectedSurface = sequenceExpectedSurface(sequence.order);
    return Object.freeze({
      ...sequence,
      width: sequence.order.length * TILE_WIDTH,
      height: TILE_HEIGHT,
      stride: sequence.order.length * TILE_WIDTH * 4,
      expectedSurface,
      expectedSurfaceFnv1a64: fnv1a64Hex(expectedSurface),
    });
  }),
);

const ALL_TRILINEAR_COLORS = Object.freeze(
  Array.from({ length: DEFAULT_MAX_LOD + 1 }, (_, lod) =>
    Object.freeze({
      lodSixteenths: lod,
      rgba: blendLevelColors(lod),
    }),
  ),
);

export const gxMipDerivativeOracle = Object.freeze({
  packetVersion: PACKET_VERSION,
  key: gxMipColorOracle.key,
  textureWidth: gxMipColorOracle.width,
  textureHeight: gxMipColorOracle.height,
  mipLevelCount: gxMipColorOracle.mipLevelCount,
  payloadBytes: TEXTURE_PAYLOAD_BYTES,
  paddedPixelBytes: PADDED_TEXTURE_PIXEL_BYTES,
  levelColors: LEVEL_COLORS,
  affinePositions: AFFINE_POSITIONS,
  baseCoordinateRaw: Object.freeze([BASE_S_RAW, BASE_T_RAW]),
  hardGateFeatures: Object.freeze(
    gxMipDerivativeHardGateCases.map(entry => entry.feature),
  ),
  fingerprintFeatures: Object.freeze(
    gxMipDerivativeFingerprintCases.map(entry => entry.feature),
  ),
  allTrilinearColors: ALL_TRILINEAR_COLORS,
  probe: gxMipColorOracle.probe,
  xfb: gxMipColorOracle.xfb,
  expectedSingleDrawMetrics: Object.freeze({
    packetPayloadBytes: TEXTURE_PAYLOAD_BYTES,
    textureUploadBytes: TEXTURE_PAYLOAD_BYTES,
    textureWrites: gxMipColorOracle.mipLevelCount,
    managedCoverageDraws: 1,
    managedCoverageTriangles: 2,
  }),
  expectedSequenceMetrics: Object.freeze({
    packetPayloadBytes: TEXTURE_PAYLOAD_BYTES,
    textureUploadBytes: TEXTURE_PAYLOAD_BYTES,
    textureWrites: gxMipColorOracle.mipLevelCount,
    managedCoverageDraws: 4,
    managedCoverageTriangles: 8,
  }),
  derivativeBoundary: Object.freeze({
    lodSixteenths: 1,
    rhoRaw: 128 * 2 ** (1 / 16),
    belowRaw: 133,
    aboveRaw: 134,
  }),
  derivativeLodOracleGap:
    "The wide-margin vectors are compatibility gates. Outcomes adjacent to a 1/16 derivative-log2 boundary are a same-adapter fingerprint, not a universal cross-adapter byte-exact requirement.",
});
