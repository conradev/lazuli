import {
  fnv1a64Hex,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";
import {
  buildGxMipColorOraclePacket,
  gxMipColorOracle,
  gxMipColorOracleCases,
  gxMipColorOraclePacketLayout,
} from "./browser_boot_gx_mip_color_oracle.mjs";
import {
  modelGxMipDerivativeLod,
} from "./browser_boot_gx_mip_derivative_oracle.mjs";

const PACKET_VERSION = 4;
const HEADER_BYTES = 160;
const DRAW_BYTES = 176;
const TEXTURE_BYTES = 64;
const TEV_BYTES = 464;
const VERTEX_FLOATS = 36;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const VERTEX_COUNT = 4;
const TEXTURE_REFERENCE_ABSENT = 0xffffffff;
const TEXTURE_FLAG_PAYLOAD = 1;
const DRAW_FLAG_POST_CULL_EVIDENCE = 1;
const KEEP_021_TWICE = 0x0f;
const RASTER_ALWAYS_PASS = 0x003f0000;
const RASTER_BLEND_REPLACE = 1 << 3;
const XFB_DESTINATION = 0x00124000;
const XFB_WIDTH = 4;
const XFB_HEIGHT = 4;
const XFB_STRIDE = XFB_WIDTH * 4;
const GX_SAMPLE_NUMERATOR = 7;
const GX_SAMPLE_DENOMINATOR = 12;
const TEXTURE_WIDTH = 2;
const TEXTURE_HEIGHT = 2;
const TEXTURE_MAP_A = 1;
const TEXTURE_MAP_B = 6;
const TEXTURE_COORD_A = 2;
const TEXTURE_COORD_B = 7;
const SAMPLER_NEAREST_NO_MIP = 0;
const SAMPLER_NEAREST_MIP_NEAREST = 1 << 5;
const MIP_MODE1_ZERO_TO_TWO = 2 * 16 << 8;
const DEAD_STQ = Object.freeze([0, 0, 1]);

const POSITIONS = Object.freeze([
  Object.freeze([0.59, 0]),
  Object.freeze([4, 0]),
  Object.freeze([4, 4]),
  Object.freeze([0.59, 4]),
]);

const COORDINATE_A = Object.freeze([
  Object.freeze([0.1, 0.1, 0.5]),
  Object.freeze([3.6, 0.4, 2]),
  Object.freeze([3.3, 3.6, 2]),
  Object.freeze([0.15, 0.9, 0.5]),
]);

const COORDINATE_B = Object.freeze([
  Object.freeze([3.4, 0.5, 2]),
  Object.freeze([0.125, 0.125, 0.5]),
  Object.freeze([0.2, 0.85, 0.5]),
  Object.freeze([3.1, 3.4, 2]),
]);

const TEXTURES = Object.freeze([
  Object.freeze({
    id: "a",
    map: TEXTURE_MAP_A,
    key: "lazuli-multi-coord-a",
    texels: Object.freeze([
      210, 40, 90, 255,
      32, 220, 70, 255,
      80, 50, 240, 255,
      180, 160, 20, 255,
    ]),
  }),
  Object.freeze({
    id: "b",
    map: TEXTURE_MAP_B,
    key: "lazuli-multi-coord-b",
    texels: Object.freeze([
      15, 100, 200, 255,
      230, 30, 50, 255,
      60, 190, 110, 255,
      140, 75, 225, 255,
    ]),
  }),
]);

const TEXTURE_BY_MAP = new Map(
  TEXTURES.map(texture => [texture.map, texture]),
);

const STAGE_A = Object.freeze({
  texture: "a",
  map: TEXTURE_MAP_A,
  coordinate: TEXTURE_COORD_A,
});
const STAGE_B = Object.freeze({
  texture: "b",
  map: TEXTURE_MAP_B,
  coordinate: TEXTURE_COORD_B,
});
const LEGACY_COORD_2_DEFINITION = Object.freeze({
  id: "legacy-shared-coord2",
  name: "both texture maps share coordinate 2",
  stages: Object.freeze([
    STAGE_A,
    Object.freeze({
      ...STAGE_B,
      coordinate: TEXTURE_COORD_A,
    }),
  ]),
});
const LEGACY_COORD_7_DEFINITION = Object.freeze({
  id: "legacy-shared-coord7",
  name: "both texture maps share coordinate 7",
  stages: Object.freeze([
    Object.freeze({
      ...STAGE_A,
      coordinate: TEXTURE_COORD_B,
    }),
    STAGE_B,
  ]),
});

const CASE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "coord2-map1-then-coord7-map6",
    name:
      "coordinate 2/map 1 then coordinate 7/map 6 with Keep021",
    stages: Object.freeze([STAGE_A, STAGE_B]),
    discriminator: "forward",
  }),
  Object.freeze({
    id: "coord7-map6-then-coord2-map1",
    name:
      "reversed coordinate 7/map 6 then coordinate 2/map 1",
    stages: Object.freeze([STAGE_B, STAGE_A]),
    discriminator: "reversed-stage-negative-control",
  }),
]);

function derivativeCoordinatePlane(
  q,
  dxRaw,
  baseSRaw,
  baseTRaw,
) {
  return Object.freeze(
    POSITIONS.map(([x]) =>
      Object.freeze([
        ((baseSRaw + dxRaw * x) / 128) * q,
        (baseTRaw / 128) * q,
        q,
      ]),
    ),
  );
}

const DERIVATIVE_COORDINATE_A = derivativeCoordinatePlane(
  0.5,
  128,
  4096,
  6144,
);
const DERIVATIVE_COORDINATE_B = derivativeCoordinatePlane(
  2,
  512,
  8192,
  2048,
);
const DERIVATIVE_STAGE_A = Object.freeze({
  texture: "mip-chain",
  map: 0,
  coordinate: TEXTURE_COORD_A,
  dxRaw: 128,
  selectedLevel: 0,
});
const DERIVATIVE_STAGE_B = Object.freeze({
  texture: "mip-chain",
  map: 0,
  coordinate: TEXTURE_COORD_B,
  dxRaw: 512,
  selectedLevel: 2,
});
const DERIVATIVE_CASE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "same-map-coord2-lod0-then-coord7-lod2",
    name:
      "same map coordinate 2 LOD 0 then coordinate 7 LOD 2",
    stages: Object.freeze([
      DERIVATIVE_STAGE_A,
      DERIVATIVE_STAGE_B,
    ]),
    discriminator: "per-coordinate-derivative-forward",
  }),
  Object.freeze({
    id: "same-map-coord7-lod2-then-coord2-lod0",
    name:
      "same map coordinate 7 LOD 2 then coordinate 2 LOD 0",
    stages: Object.freeze([
      DERIVATIVE_STAGE_B,
      DERIVATIVE_STAGE_A,
    ]),
    discriminator:
      "per-coordinate-derivative-reversed-stage-control",
  }),
]);

function align16(value) {
  return (value + 15) & ~15;
}

function putU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function putU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function generationU32(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new RangeError(
      "GX multi-coordinate TEV generation must be a u32",
    );
  }
  return value;
}

function definitionFor(id) {
  const definition = CASE_DEFINITIONS.find(entry => entry.id === id);
  if (definition === undefined) {
    throw new RangeError(
      `unknown GX multi-coordinate TEV vector ${id}`,
    );
  }
  return definition;
}

function derivativeDefinitionFor(id) {
  const definition = DERIVATIVE_CASE_DEFINITIONS.find(
    entry => entry.id === id,
  );
  if (definition === undefined) {
    throw new RangeError(
      `unknown GX multi-coordinate derivative TEV vector ${id}`,
    );
  }
  return definition;
}

function f32(value) {
  return Math.fround(value);
}

function f32Add(left, right) {
  return f32(f32(left) + f32(right));
}

function f32Sub(left, right) {
  return f32(f32(left) - f32(right));
}

function f32Mul(left, right) {
  return f32(f32(left) * f32(right));
}

function f32Div(left, right) {
  return f32(f32(left) / f32(right));
}

function attributePlane(positions, attributes) {
  const [[x0, y0], [x1, y1], [x2, y2]] = positions.map(
    ([x, y]) => [f32(x), f32(y)],
  );
  const [value0, value1, value2] = attributes.map(f32);
  const dx10 = f32Sub(x1, x0);
  const dx20 = f32Sub(x2, x0);
  const dy10 = f32Sub(y1, y0);
  const dy20 = f32Sub(y2, y0);
  const delta20 = f32Sub(value2, value0);
  const delta10 = f32Sub(value1, value0);
  const numeratorX = f32Sub(
    f32Mul(delta20, dy10),
    f32Mul(delta10, dy20),
  );
  const numeratorY = f32Sub(
    f32Mul(dx20, delta10),
    f32Mul(dx10, delta20),
  );
  const denominator = f32Sub(
    f32Mul(dx20, dy10),
    f32Mul(dx10, dy20),
  );
  return Object.freeze({
    originX: x0,
    originY: y0,
    originValue: value0,
    dfdx: f32Div(numeratorX, denominator),
    dfdy: f32Div(numeratorY, denominator),
  });
}

function samplePlane(plane, pixelX, pixelY) {
  const sampleX = f32Div(
    pixelX * GX_SAMPLE_DENOMINATOR + GX_SAMPLE_NUMERATOR,
    GX_SAMPLE_DENOMINATOR,
  );
  const sampleY = f32Div(
    pixelY * GX_SAMPLE_DENOMINATOR + GX_SAMPLE_NUMERATOR,
    GX_SAMPLE_DENOMINATOR,
  );
  const dx = f32Sub(sampleX, plane.originX);
  const dy = f32Sub(sampleY, plane.originY);
  return f32Add(
    f32Add(
      plane.originValue,
      f32Mul(plane.dfdx, dx),
    ),
    f32Mul(plane.dfdy, dy),
  );
}

function snap28_4(value) {
  return Math.floor(f32(value) * 16 + 0.5);
}

function fixedEdgeCovers(a, b, pixelX, pixelY) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const constant = dy * a[0] - dx * a[1];
  const sampleX48 = pixelX * 48 + 28;
  const sampleY48 = pixelY * 48 + 28;
  const edge3 =
    3 * constant + dx * sampleY48 - dy * sampleX48;
  const inclusive = dy < 0 || (dy === 0 && dx > 0);
  return edge3 > 0 || (inclusive && edge3 === 0);
}

const KEEP_021_TRIANGLES = Object.freeze([
  Object.freeze([0, 2, 1]),
  Object.freeze([0, 3, 2]),
]);

const RAW_TRIANGLES = Object.freeze([
  Object.freeze([0, 1, 2]),
  Object.freeze([0, 2, 3]),
]);

function managedTriangleCovers(triangle, pixelX, pixelY) {
  const points = triangle.map(index => {
    const [x, y] = POSITIONS[index];
    return [snap28_4(x), snap28_4(y)];
  });
  return (
    fixedEdgeCovers(points[0], points[1], pixelX, pixelY) &&
    fixedEdgeCovers(points[1], points[2], pixelX, pixelY) &&
    fixedEdgeCovers(points[2], points[0], pixelX, pixelY)
  );
}

function coverageOwners(triangles) {
  const owners = [];
  const coverageCounts = [];
  for (let y = 0; y < XFB_HEIGHT; y += 1) {
    for (let x = 0; x < XFB_WIDTH; x += 1) {
      const covering = triangles
        .map((triangle, index) =>
          managedTriangleCovers(triangle, x, y) ? index : -1,
        )
        .filter(index => index !== -1);
      coverageCounts.push(covering.length);
      owners.push(covering.length === 1 ? covering[0] : -1);
    }
  }
  return Object.freeze({
    owners: Object.freeze(owners),
    coverageCounts: Object.freeze(coverageCounts),
  });
}

const KEEP_021_COVERAGE = coverageOwners(KEEP_021_TRIANGLES);
const RAW_COVERAGE = coverageOwners(RAW_TRIANGLES);

function coordinateValues(coordinate) {
  if (coordinate === TEXTURE_COORD_A) return COORDINATE_A;
  if (coordinate === TEXTURE_COORD_B) return COORDINATE_B;
  throw new RangeError(
    `unsupported GX multi-coordinate TEV coordinate ${coordinate}`,
  );
}

function stqAtPixel(triangle, coordinate, pixelX, pixelY) {
  const positions = triangle.map(index => POSITIONS[index]);
  const values = coordinateValues(coordinate);
  return [0, 1, 2].map(component =>
    samplePlane(
      attributePlane(
        positions,
        triangle.map(index => values[index][component]),
      ),
      pixelX,
      pixelY,
    ),
  );
}

function predividedUvAtPixel(
  triangle,
  coordinate,
  pixelX,
  pixelY,
) {
  const positions = triangle.map(index => POSITIONS[index]);
  const values = coordinateValues(coordinate);
  return [0, 1].map(component =>
    samplePlane(
      attributePlane(
        positions,
        triangle.map(index =>
          f32Div(values[index][component], values[index][2]),
        ),
      ),
      pixelX,
      pixelY,
    ),
  );
}

function texel(texture, x, y) {
  const offset = (y * TEXTURE_WIDTH + x) * 4;
  return texture.texels.slice(offset, offset + 4);
}

function sampleNearest(texture, uv) {
  const x = Math.min(
    TEXTURE_WIDTH - 1,
    Math.max(0, Math.trunc(f32Mul(uv[0], 128)) >> 7),
  );
  const y = Math.min(
    TEXTURE_HEIGHT - 1,
    Math.max(0, Math.trunc(f32Mul(uv[1], 128)) >> 7),
  );
  return texel(texture, x, y);
}

function sampleStage(stage, triangle, pixelX, pixelY, options) {
  const coordinate = options.swapCoordinates
    ? stage.coordinate === TEXTURE_COORD_A
      ? TEXTURE_COORD_B
      : TEXTURE_COORD_A
    : stage.coordinate;
  const stq = stqAtPixel(
    triangle,
    coordinate,
    pixelX,
    pixelY,
  );
  const uv = options.predivideBeforeInterpolation
    ? predividedUvAtPixel(
        triangle,
        coordinate,
        pixelX,
        pixelY,
      )
    : [
        f32Div(stq[0], stq[2]),
        f32Div(stq[1], stq[2]),
      ];
  return sampleNearest(TEXTURE_BY_MAP.get(stage.map), uv);
}

function evaluateTwoStageProgram(
  definition,
  triangle,
  pixelX,
  pixelY,
  options,
) {
  const first = sampleStage(
    definition.stages[0],
    triangle,
    pixelX,
    pixelY,
    options,
  );
  const second = sampleStage(
    definition.stages[1],
    triangle,
    pixelX,
    pixelY,
    options,
  );
  return Object.freeze([
    ...Array.from(
      { length: 3 },
      (_, channel) =>
        Math.max(
          0,
          Math.min(255, first[channel] + 128 - second[channel]),
        ),
    ),
    255,
  ]);
}

export function modelGxMultiCoordTevSurface(
  id,
  options = {},
) {
  return modelGxMultiCoordTevDefinitionSurface(
    definitionFor(id),
    options,
  );
}

function modelGxMultiCoordTevDefinitionSurface(
  definition,
  {
    predivideBeforeInterpolation = false,
    swapCoordinates = false,
    rawTriangleOrder = false,
  } = {},
) {
  const triangles = rawTriangleOrder
    ? RAW_TRIANGLES
    : KEEP_021_TRIANGLES;
  const rgba = [];
  for (let y = 0; y < XFB_HEIGHT; y += 1) {
    for (let x = 0; x < XFB_WIDTH; x += 1) {
      const triangle = triangles.find(candidate =>
        managedTriangleCovers(candidate, x, y),
      );
      if (triangle === undefined) {
        rgba.push(0, 0, 0, 255);
        continue;
      }
      rgba.push(
        ...evaluateTwoStageProgram(
          definition,
          triangle,
          x,
          y,
          {
            predivideBeforeInterpolation,
            swapCoordinates,
          },
        ),
      );
    }
  }
  return Object.freeze(rgba);
}

function derivativeLodForCoordinate(coordinate) {
  const dxRaw =
    coordinate === TEXTURE_COORD_A
      ? DERIVATIVE_STAGE_A.dxRaw
      : coordinate === TEXTURE_COORD_B
        ? DERIVATIVE_STAGE_B.dxRaw
        : null;
  if (dxRaw === null) {
    throw new RangeError(
      "GX multi-coordinate derivative source must be coordinate 2 or 7",
    );
  }
  return modelGxMipDerivativeLod({
    dx: [dxRaw, 0],
    dy: [0, 0],
    mipMode: 1,
    minLodSixteenths: 0,
    maxLodSixteenths: 32,
  });
}

function derivativeTextureColor(coordinate) {
  const lod = derivativeLodForCoordinate(coordinate);
  return Object.freeze({
    lod,
    color: gxMipColorOracleCases[lod.selectedLevel].color,
  });
}

export function modelGxMultiCoordDerivativeTevSurface(
  id,
  { reuseCoordinate = null } = {},
) {
  const definition = derivativeDefinitionFor(id);
  if (
    reuseCoordinate !== null &&
    reuseCoordinate !== TEXTURE_COORD_A &&
    reuseCoordinate !== TEXTURE_COORD_B
  ) {
    throw new RangeError(
      "GX multi-coordinate derivative reuse source must be coordinate 2 or 7",
    );
  }
  const sampled = definition.stages.map(stage =>
    derivativeTextureColor(reuseCoordinate ?? stage.coordinate),
  );
  const rgba = Object.freeze([
    ...Array.from(
      { length: 3 },
      (_, channel) =>
        Math.max(
          0,
          Math.min(
            255,
            sampled[0].color[channel] +
              128 -
              sampled[1].color[channel],
          ),
        ),
    ),
    255,
  ]);
  return Object.freeze({
    rgba,
    surface: Object.freeze(
      Array.from({ length: XFB_WIDTH * XFB_HEIGHT }, () => rgba)
        .flat(),
    ),
    stages: Object.freeze(
      sampled.map((entry, index) =>
        Object.freeze({
          coordinate:
            reuseCoordinate ?? definition.stages[index].coordinate,
          rhoRaw: entry.lod.rhoRaw,
          lodSixteenths: entry.lod.clampedLodSixteenths,
          selectedLevel: entry.lod.selectedLevel,
          color: entry.color,
        }),
      ),
    ),
  });
}

function rgbaMask(rgba) {
  let mask = 0;
  for (let pixel = 0; pixel < rgba.length / 4; pixel += 1) {
    const offset = pixel * 4;
    if (
      rgba[offset] !== 0 ||
      rgba[offset + 1] !== 0 ||
      rgba[offset + 2] !== 0
    ) {
      mask |= 1 << pixel;
    }
  }
  return mask >>> 0;
}

function regularColorCombiner(
  args,
  {
    bias = 0,
    subtract = false,
    clamp = true,
    scale = 0,
    destination = 1,
  } = {},
) {
  return (
    (args[0] << 12) |
    (args[1] << 8) |
    (args[2] << 4) |
    args[3] |
    ((bias & 3) << 16) |
    (Number(subtract) << 18) |
    (Number(clamp) << 19) |
    ((scale & 3) << 20) |
    ((destination & 3) << 22)
  ) >>> 0;
}

function regularAlphaCombiner(
  args,
  {
    bias = 0,
    subtract = false,
    clamp = true,
    scale = 0,
    destination = 1,
  } = {},
) {
  return (
    (args[0] << 13) |
    (args[1] << 10) |
    (args[2] << 7) |
    (args[3] << 4) |
    ((bias & 3) << 16) |
    (Number(subtract) << 18) |
    (Number(clamp) << 19) |
    ((scale & 3) << 20) |
    ((destination & 3) << 22)
  ) >>> 0;
}

const PASS_TEXTURE_COLOR = regularColorCombiner(
  [15, 15, 15, 8],
);
const PASS_TEXTURE_ALPHA = regularAlphaCombiner(
  [7, 7, 7, 4],
);
const SUBTRACT_TEXTURE_FROM_R0_WITH_HALF_BIAS =
  regularColorCombiner(
    [15, 8, 12, 2],
    { bias: 1, subtract: true },
  );
const PRESERVE_R0_ALPHA = regularAlphaCombiner(
  [7, 7, 7, 1],
);

function writeTevState(view, offset, definition) {
  for (
    let stageIndex = 0;
    stageIndex < definition.stages.length;
    stageIndex += 1
  ) {
    const stage = definition.stages[stageIndex];
    const stageOffset = offset + stageIndex * 16;
    putU32(
      view,
      stageOffset,
      stageIndex === 0
        ? PASS_TEXTURE_COLOR
        : SUBTRACT_TEXTURE_FROM_R0_WITH_HALF_BIAS,
    );
    putU32(
      view,
      stageOffset + 4,
      stageIndex === 0
        ? PASS_TEXTURE_ALPHA
        : PRESERVE_R0_ALPHA,
    );
    putU32(
      view,
      stageOffset + 8,
      stage.map |
        (stage.coordinate << 3) |
        (1 << 6) |
        (7 << 7),
    );
    putU32(view, stageOffset + 12, 0);
  }
  for (let channel = 0; channel < 4; channel += 1) {
    putU32(view, offset + 384 + channel * 4, channel);
  }
  putU32(view, offset + 448, definition.stages.length);
}

function writeVertex(view, offset, vertexIndex) {
  const values = [
    POSITIONS[vertexIndex][0],
    POSITIONS[vertexIndex][1],
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
  ];
  for (let coordinate = 0; coordinate < 8; coordinate += 1) {
    values.push(
      ...(coordinate === TEXTURE_COORD_A
        ? COORDINATE_A[vertexIndex]
        : coordinate === TEXTURE_COORD_B
          ? COORDINATE_B[vertexIndex]
          : DEAD_STQ),
    );
  }
  if (values.length !== VERTEX_FLOATS) {
    throw new Error(
      `GX multi-coordinate TEV vertex has ${values.length} floats`,
    );
  }
  for (let component = 0; component < values.length; component += 1) {
    view.setFloat32(offset + component * 4, values[component], true);
  }
}

function writeDerivativeVertex(view, offset, vertexIndex) {
  const values = [
    POSITIONS[vertexIndex][0],
    POSITIONS[vertexIndex][1],
    0,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
    1,
  ];
  for (let coordinate = 0; coordinate < 8; coordinate += 1) {
    values.push(
      ...(coordinate === TEXTURE_COORD_A
        ? DERIVATIVE_COORDINATE_A[vertexIndex]
        : coordinate === TEXTURE_COORD_B
          ? DERIVATIVE_COORDINATE_B[vertexIndex]
          : DEAD_STQ),
    );
  }
  if (values.length !== VERTEX_FLOATS) {
    throw new Error(
      `GX multi-coordinate derivative TEV vertex has ${values.length} floats`,
    );
  }
  for (let component = 0; component < values.length; component += 1) {
    view.setFloat32(offset + component * 4, values[component], true);
  }
}

const TEXTURE_KEY_BYTES = Object.freeze(
  TEXTURES.map(texture =>
    Uint8Array.from(
      [...texture.key].map(character => character.charCodeAt(0)),
    ),
  ),
);

export function gxMultiCoordTevOraclePacketLayout() {
  const drawOffset = HEADER_BYTES;
  const textureOffset = drawOffset + DRAW_BYTES;
  const tevOffset = textureOffset + TEXTURES.length * TEXTURE_BYTES;
  const vertexOffset = tevOffset + TEV_BYTES;
  const keyOffset = vertexOffset + VERTEX_COUNT * VERTEX_BYTES;
  const keyBytes = TEXTURE_KEY_BYTES.reduce(
    (sum, bytes) => sum + bytes.length,
    0,
  );
  const pixelOffset = align16(keyOffset + keyBytes);
  const texturePixelOffsets = Object.freeze(
    TEXTURES.map((texture, index) => index * texture.texels.length),
  );
  const pixelBytes = align16(
    TEXTURES.reduce(
      (sum, texture) => sum + texture.texels.length,
      0,
    ),
  );
  const evidenceOffset = pixelOffset + pixelBytes;
  const packetBytes = align16(evidenceOffset + 1);
  return Object.freeze({
    headerBytes: HEADER_BYTES,
    drawOffset,
    drawBytes: DRAW_BYTES,
    textureOffset,
    textureBytes: TEXTURES.length * TEXTURE_BYTES,
    textureRecordBytes: TEXTURE_BYTES,
    textureCount: TEXTURES.length,
    tevOffset,
    tevBytes: TEV_BYTES,
    vertexOffset,
    vertexBytes: VERTEX_COUNT * VERTEX_BYTES,
    vertexFloats: VERTEX_FLOATS,
    vertexRecordBytes: VERTEX_BYTES,
    vertexCount: VERTEX_COUNT,
    keyOffset,
    keyBytes,
    pixelOffset,
    pixelBytes,
    texturePixelOffsets,
    evidenceOffset,
    evidenceBytes: 1,
    packetBytes,
  });
}

export function buildGxMultiCoordTevOraclePacket(
  id,
  generation = 1,
) {
  const definition = definitionFor(id);
  generation = generationU32(generation);
  const layout = gxMultiCoordTevOraclePacketLayout();
  const packet = new Uint8Array(layout.packetBytes);
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );

  packet.set([0x4c, 0x5a, 0x47, 0x58], 0);
  putU16(view, 0x04, PACKET_VERSION);
  putU16(view, 0x06, HEADER_BYTES);
  putU32(view, 0x08, packet.length);
  putU32(view, 0x10, 2);
  putU32(view, 0x14, 1);
  putU32(view, 0x18, TEXTURES.length);
  putU32(view, 0x1c, layout.drawOffset);
  putU32(view, 0x20, layout.textureOffset);
  putU32(view, 0x24, layout.tevOffset);
  putU32(view, 0x28, layout.vertexOffset);
  putU32(view, 0x2c, layout.keyOffset);
  putU32(view, 0x30, layout.pixelOffset);
  putU32(view, 0x34, layout.drawBytes);
  putU32(view, 0x38, layout.textureBytes);
  putU32(view, 0x3c, layout.tevBytes);
  putU32(view, 0x40, layout.vertexBytes);
  putU32(view, 0x44, layout.keyBytes);
  putU32(view, 0x48, layout.pixelBytes);
  putU32(view, 0x54, XFB_WIDTH);
  putU32(view, 0x58, XFB_HEIGHT);
  putU32(view, 0x5c, XFB_WIDTH);
  putU32(view, 0x60, XFB_HEIGHT);
  putU32(view, 0x64, XFB_DESTINATION);
  putU32(view, 0x68, XFB_STRIDE);
  putU32(view, 0x6c, generation);
  putU16(view, 0x78, DRAW_BYTES);
  putU16(view, 0x7a, TEXTURE_BYTES);
  putU32(view, 0x7c, VERTEX_COUNT);
  putU32(view, 0x8c, 0x4000);
  putU32(view, 0x90, 0x00ffffff);
  putU32(view, 0x94, 256);
  putU32(view, 0x98, (32 << 12) | (32 << 18));

  packet[layout.drawOffset] = 0;
  packet[layout.drawOffset + 1] = 0;
  putU16(
    view,
    layout.drawOffset + 0x02,
    DRAW_FLAG_POST_CULL_EVIDENCE,
  );
  putU32(view, layout.drawOffset + 0x04, VERTEX_COUNT);
  putU32(view, layout.drawOffset + 0x08, 0);
  putU32(view, layout.drawOffset + 0x0c, 0);
  putU32(view, layout.drawOffset + 0x10, 0);
  putU32(
    view,
    layout.drawOffset + 0x14,
    RASTER_BLEND_REPLACE,
  );
  putU32(view, layout.drawOffset + 0x18, RASTER_ALWAYS_PASS);
  putU32(view, layout.drawOffset + 0x24, XFB_WIDTH);
  putU32(view, layout.drawOffset + 0x28, XFB_HEIGHT);
  for (let map = 0; map < 8; map += 1) {
    putU32(
      view,
      layout.drawOffset + 0x30 + map * 8,
      TEXTURE_REFERENCE_ABSENT,
    );
    putU32(view, layout.drawOffset + 0x34 + map * 8, 0);
  }
  putU32(
    view,
    layout.drawOffset + 0x30 + TEXTURE_MAP_A * 8,
    0,
  );
  putU32(
    view,
    layout.drawOffset + 0x34 + TEXTURE_MAP_A * 8,
    SAMPLER_NEAREST_NO_MIP,
  );
  putU32(
    view,
    layout.drawOffset + 0x30 + TEXTURE_MAP_B * 8,
    1,
  );
  putU32(
    view,
    layout.drawOffset + 0x34 + TEXTURE_MAP_B * 8,
    SAMPLER_NEAREST_NO_MIP,
  );

  let keyRelativeOffset = 0;
  for (
    let textureIndex = 0;
    textureIndex < TEXTURES.length;
    textureIndex += 1
  ) {
    const texture = TEXTURES[textureIndex];
    const keyBytes = TEXTURE_KEY_BYTES[textureIndex];
    const recordOffset =
      layout.textureOffset + textureIndex * TEXTURE_BYTES;
    putU32(view, recordOffset + 0x00, keyRelativeOffset);
    putU32(view, recordOffset + 0x04, keyBytes.length);
    putU32(
      view,
      recordOffset + 0x08,
      layout.texturePixelOffsets[textureIndex],
    );
    putU32(view, recordOffset + 0x0c, texture.texels.length);
    putU32(view, recordOffset + 0x18, TEXTURE_WIDTH);
    putU32(view, recordOffset + 0x1c, TEXTURE_HEIGHT);
    putU32(view, recordOffset + 0x20, TEXTURE_FLAG_PAYLOAD);
    packet.set(keyBytes, layout.keyOffset + keyRelativeOffset);
    packet.set(
      texture.texels,
      layout.pixelOffset + layout.texturePixelOffsets[textureIndex],
    );
    keyRelativeOffset += keyBytes.length;
  }

  writeTevState(view, layout.tevOffset, definition);
  for (
    let vertexIndex = 0;
    vertexIndex < VERTEX_COUNT;
    vertexIndex += 1
  ) {
    writeVertex(
      view,
      layout.vertexOffset + vertexIndex * VERTEX_BYTES,
      vertexIndex,
    );
  }
  packet[layout.evidenceOffset] = KEEP_021_TWICE;
  return packet;
}

function gxMultiCoordTevPipelineLayoutPacketLayout(drawCount) {
  const drawOffset = HEADER_BYTES;
  const drawBytes = drawCount * DRAW_BYTES;
  const textureOffset = drawOffset + drawBytes;
  const textureBytes = TEXTURES.length * TEXTURE_BYTES;
  const tevOffset = textureOffset + textureBytes;
  const tevBytes = drawCount * TEV_BYTES;
  const vertexOffset = tevOffset + tevBytes;
  const vertexCount = drawCount * VERTEX_COUNT;
  const vertexBytes = vertexCount * VERTEX_BYTES;
  const keyOffset = vertexOffset + vertexBytes;
  const keyBytes = TEXTURE_KEY_BYTES.reduce(
    (sum, bytes) => sum + bytes.length,
    0,
  );
  const pixelOffset = align16(keyOffset + keyBytes);
  const texturePixelOffsets = Object.freeze(
    TEXTURES.map((texture, index) => index * texture.texels.length),
  );
  const pixelBytes = align16(
    TEXTURES.reduce(
      (sum, texture) => sum + texture.texels.length,
      0,
    ),
  );
  const evidenceOffset = pixelOffset + pixelBytes;
  const evidenceBytes = drawCount;
  const packetBytes = align16(evidenceOffset + evidenceBytes);
  return Object.freeze({
    headerBytes: HEADER_BYTES,
    drawCount,
    drawOffset,
    drawBytes,
    textureOffset,
    textureBytes,
    textureRecordBytes: TEXTURE_BYTES,
    textureCount: TEXTURES.length,
    tevOffset,
    tevBytes,
    vertexOffset,
    vertexBytes,
    vertexFloats: VERTEX_FLOATS,
    vertexRecordBytes: VERTEX_BYTES,
    vertexCount,
    keyOffset,
    keyBytes,
    pixelOffset,
    pixelBytes,
    texturePixelOffsets,
    evidenceOffset,
    evidenceBytes,
    packetBytes,
  });
}

function buildGxMultiCoordTevPipelineLayoutPacket(
  definitions,
  generation,
) {
  generation = generationU32(generation);
  const baseline = buildGxMultiCoordTevOraclePacket(
    CASE_DEFINITIONS[0].id,
    generation,
  );
  const baselineLayout = gxMultiCoordTevOraclePacketLayout();
  const layout = gxMultiCoordTevPipelineLayoutPacketLayout(
    definitions.length,
  );
  const packet = new Uint8Array(layout.packetBytes);
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );

  packet.set(baseline.slice(0, HEADER_BYTES), 0);
  putU32(view, 0x08, packet.length);
  putU32(view, 0x14, definitions.length);
  putU32(view, 0x1c, layout.drawOffset);
  putU32(view, 0x20, layout.textureOffset);
  putU32(view, 0x24, layout.tevOffset);
  putU32(view, 0x28, layout.vertexOffset);
  putU32(view, 0x2c, layout.keyOffset);
  putU32(view, 0x30, layout.pixelOffset);
  putU32(view, 0x34, layout.drawBytes);
  putU32(view, 0x38, layout.textureBytes);
  putU32(view, 0x3c, layout.tevBytes);
  putU32(view, 0x40, layout.vertexBytes);
  putU32(view, 0x44, layout.keyBytes);
  putU32(view, 0x48, layout.pixelBytes);
  putU32(view, 0x7c, layout.vertexCount);

  packet.set(
    baseline.slice(
      baselineLayout.textureOffset,
      baselineLayout.textureOffset + baselineLayout.textureBytes,
    ),
    layout.textureOffset,
  );
  packet.set(
    baseline.slice(
      baselineLayout.keyOffset,
      baselineLayout.keyOffset + baselineLayout.keyBytes,
    ),
    layout.keyOffset,
  );
  packet.set(
    baseline.slice(
      baselineLayout.pixelOffset,
      baselineLayout.pixelOffset + baselineLayout.pixelBytes,
    ),
    layout.pixelOffset,
  );

  for (
    let drawIndex = 0;
    drawIndex < definitions.length;
    drawIndex += 1
  ) {
    const drawOffset = layout.drawOffset + drawIndex * DRAW_BYTES;
    packet.set(
      baseline.slice(
        baselineLayout.drawOffset,
        baselineLayout.drawOffset + DRAW_BYTES,
      ),
      drawOffset,
    );
    putU32(
      view,
      drawOffset + 0x08,
      drawIndex * VERTEX_COUNT * VERTEX_BYTES,
    );
    putU32(view, drawOffset + 0x0c, drawIndex * TEV_BYTES);
    writeTevState(
      view,
      layout.tevOffset + drawIndex * TEV_BYTES,
      definitions[drawIndex],
    );
    for (
      let vertexIndex = 0;
      vertexIndex < VERTEX_COUNT;
      vertexIndex += 1
    ) {
      writeVertex(
        view,
        layout.vertexOffset +
          (drawIndex * VERTEX_COUNT + vertexIndex) *
            VERTEX_BYTES,
        vertexIndex,
      );
    }
    packet[layout.evidenceOffset + drawIndex] =
      KEEP_021_TWICE;
  }
  return packet;
}

export function gxMultiCoordTevPipelineLayoutOraclePacketLayout(
  id,
) {
  const definitions =
    id === "legacy-only"
      ? [LEGACY_COORD_2_DEFINITION]
      : id === "legacy-sidecar-legacy"
        ? [
            LEGACY_COORD_2_DEFINITION,
            CASE_DEFINITIONS[0],
            LEGACY_COORD_7_DEFINITION,
          ]
        : null;
  if (definitions === null) {
    throw new RangeError(
      `unknown GX TEV pipeline-layout vector ${id}`,
    );
  }
  return gxMultiCoordTevPipelineLayoutPacketLayout(
    definitions.length,
  );
}

export function buildGxMultiCoordTevPipelineLayoutOraclePacket(
  id,
  generation = 1,
) {
  const definitions =
    id === "legacy-only"
      ? [LEGACY_COORD_2_DEFINITION]
      : id === "legacy-sidecar-legacy"
        ? [
            LEGACY_COORD_2_DEFINITION,
            CASE_DEFINITIONS[0],
            LEGACY_COORD_7_DEFINITION,
          ]
        : null;
  if (definitions === null) {
    throw new RangeError(
      `unknown GX TEV pipeline-layout vector ${id}`,
    );
  }
  return buildGxMultiCoordTevPipelineLayoutPacket(
    definitions,
    generation,
  );
}

export function buildGxMultiCoordDerivativeTevOraclePacket(
  id,
  generation = 1,
) {
  const definition = derivativeDefinitionFor(id);
  generation = generationU32(generation);
  const packet = buildGxMipColorOraclePacket(0, generation);
  const layout = gxMipColorOraclePacketLayout();
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  packet.fill(0, layout.tevOffset, layout.tevOffset + TEV_BYTES);
  writeTevState(view, layout.tevOffset, definition);
  putU32(view, 0x64, XFB_DESTINATION);
  putU32(
    view,
    layout.drawOffset + 0x34,
    SAMPLER_NEAREST_MIP_NEAREST,
  );
  putU32(view, layout.mode1Offset, MIP_MODE1_ZERO_TO_TWO);
  for (
    let vertexIndex = 0;
    vertexIndex < VERTEX_COUNT;
    vertexIndex += 1
  ) {
    writeDerivativeVertex(
      view,
      layout.vertexOffset + vertexIndex * VERTEX_BYTES,
      vertexIndex,
    );
  }
  return packet;
}

export const gxMultiCoordTevOracleCases = Object.freeze(
  CASE_DEFINITIONS.map((definition, index) => {
    const expectedRgba = modelGxMultiCoordTevSurface(definition.id);
    const predividedRgba = modelGxMultiCoordTevSurface(
      definition.id,
      { predivideBeforeInterpolation: true },
    );
    const swappedCoordinateRgba = modelGxMultiCoordTevSurface(
      definition.id,
      { swapCoordinates: true },
    );
    const rawTriangleOrderRgba = modelGxMultiCoordTevSurface(
      definition.id,
      { rawTriangleOrder: true },
    );
    return Object.freeze({
      id: definition.id,
      name: definition.name,
      discriminator: definition.discriminator,
      packetVersion: PACKET_VERSION,
      stages: definition.stages,
      liveTextureMaps: Object.freeze(
        definition.stages.map(stage => stage.map),
      ),
      liveTextureCoordinates: Object.freeze(
        definition.stages.map(stage => stage.coordinate),
      ),
      expectedPath: "managed",
      expectedManagedTriangles: 2,
      expectedRgba,
      expectedRgbaFnv1a64: fnv1a64Hex(expectedRgba),
      expectedMask: rgbaMask(expectedRgba),
      predividedRgba,
      predividedRgbaFnv1a64: fnv1a64Hex(predividedRgba),
      swappedCoordinateRgba,
      swappedCoordinateRgbaFnv1a64:
        fnv1a64Hex(swappedCoordinateRgba),
      rawTriangleOrderRgba,
      rawTriangleOrderRgbaFnv1a64:
        fnv1a64Hex(rawTriangleOrderRgba),
      packetFnv1a64: fnv1a64Hex(
        buildGxMultiCoordTevOraclePacket(
          definition.id,
          index + 1,
        ),
      ),
    });
  }),
);

export const gxMultiCoordDerivativeTevOracleCases = Object.freeze(
  DERIVATIVE_CASE_DEFINITIONS.map((definition, index) => {
    const model = modelGxMultiCoordDerivativeTevSurface(
      definition.id,
    );
    const reusedCoord2 =
      modelGxMultiCoordDerivativeTevSurface(
        definition.id,
        { reuseCoordinate: TEXTURE_COORD_A },
      );
    const reusedCoord7 =
      modelGxMultiCoordDerivativeTevSurface(
        definition.id,
        { reuseCoordinate: TEXTURE_COORD_B },
      );
    return Object.freeze({
      id: definition.id,
      name: definition.name,
      discriminator: definition.discriminator,
      packetVersion: gxMipColorOracle.packetVersion,
      stages: definition.stages,
      liveTextureMaps: Object.freeze(
        definition.stages.map(stage => stage.map),
      ),
      liveTextureCoordinates: Object.freeze(
        definition.stages.map(stage => stage.coordinate),
      ),
      expectedPath: "managed",
      expectedManagedTriangles: 2,
      expectedRgba: model.surface,
      expectedRgbaFnv1a64: fnv1a64Hex(model.surface),
      expectedMask: rgbaMask(model.surface),
      expectedStageLods: model.stages,
      reusedCoord2Rgba: reusedCoord2.surface,
      reusedCoord2RgbaFnv1a64:
        fnv1a64Hex(reusedCoord2.surface),
      reusedCoord7Rgba: reusedCoord7.surface,
      reusedCoord7RgbaFnv1a64:
        fnv1a64Hex(reusedCoord7.surface),
      packetFnv1a64: fnv1a64Hex(
        buildGxMultiCoordDerivativeTevOraclePacket(
          definition.id,
          index + 1,
        ),
      ),
    });
  }),
);

const LEGACY_COORD_2_EXPECTED_RGBA =
  modelGxMultiCoordTevDefinitionSurface(
    LEGACY_COORD_2_DEFINITION,
  );
const LEGACY_COORD_7_EXPECTED_RGBA =
  modelGxMultiCoordTevDefinitionSurface(
    LEGACY_COORD_7_DEFINITION,
  );

export const gxMultiCoordTevPipelineLayoutCases = Object.freeze([
  Object.freeze({
    id: "legacy-only",
    name: "one exact-managed shared-coordinate legacy draw",
    pipelineLayouts: Object.freeze(["legacy"]),
    drawCount: 1,
    expectedManagedDraws: 1,
    expectedManagedTriangles: 2,
    expectedRgba: LEGACY_COORD_2_EXPECTED_RGBA,
    expectedRgbaFnv1a64:
      fnv1a64Hex(LEGACY_COORD_2_EXPECTED_RGBA),
    packetFnv1a64: fnv1a64Hex(
      buildGxMultiCoordTevPipelineLayoutOraclePacket(
        "legacy-only",
        1,
      ),
    ),
  }),
  Object.freeze({
    id: "legacy-sidecar-legacy",
    name:
      "legacy then sidecar then legacy in one geometry segment",
    pipelineLayouts: Object.freeze([
      "legacy",
      "sidecar",
      "legacy",
    ]),
    drawCount: 3,
    expectedManagedDraws: 3,
    expectedManagedTriangles: 6,
    expectedRgba: LEGACY_COORD_7_EXPECTED_RGBA,
    expectedRgbaFnv1a64:
      fnv1a64Hex(LEGACY_COORD_7_EXPECTED_RGBA),
    packetFnv1a64: fnv1a64Hex(
      buildGxMultiCoordTevPipelineLayoutOraclePacket(
        "legacy-sidecar-legacy",
        1,
      ),
    ),
  }),
]);

export const gxMultiCoordTevCertificationCases = Object.freeze([
  ...gxMultiCoordTevOracleCases,
  ...gxMultiCoordDerivativeTevOracleCases,
]);

export const gxMultiCoordTevCoverageProof = Object.freeze({
  evidence: KEEP_021_TWICE,
  triangles: KEEP_021_TRIANGLES,
  owners: KEEP_021_COVERAGE.owners,
  coverageCounts: KEEP_021_COVERAGE.coverageCounts,
  rawTriangles: RAW_TRIANGLES,
  rawOwners: RAW_COVERAGE.owners,
  rawCoverageCounts: RAW_COVERAGE.coverageCounts,
});

export const gxMultiCoordTevOracle = Object.freeze({
  packetVersion: PACKET_VERSION,
  packetVersions: Object.freeze([
    PACKET_VERSION,
    gxMipColorOracle.packetVersion,
  ]),
  stageCount: 2,
  textureMaps: Object.freeze([TEXTURE_MAP_A, TEXTURE_MAP_B]),
  textureCoordinates: Object.freeze([
    TEXTURE_COORD_A,
    TEXTURE_COORD_B,
  ]),
  positions: POSITIONS,
  coordinateA: COORDINATE_A,
  coordinateB: COORDINATE_B,
  textures: TEXTURES,
  sampleNumerator: GX_SAMPLE_NUMERATOR,
  sampleDenominator: GX_SAMPLE_DENOMINATOR,
  expectedMetrics: Object.freeze({
    perRun: Object.freeze({
      managedCoverageDraws: gxMultiCoordTevOracleCases.length,
      managedCoverageTriangles:
        gxMultiCoordTevOracleCases.length * 2,
    }),
    twoRuns: Object.freeze({
      managedCoverageDraws:
        gxMultiCoordTevOracleCases.length * 2,
      managedCoverageTriangles:
        gxMultiCoordTevOracleCases.length * 4,
    }),
  }),
  certificationExpectedMetrics: Object.freeze({
    perRun: Object.freeze({
      managedCoverageDraws:
        gxMultiCoordTevCertificationCases.length,
      managedCoverageTriangles:
        gxMultiCoordTevCertificationCases.length * 2,
    }),
    twoRuns: Object.freeze({
      managedCoverageDraws:
        gxMultiCoordTevCertificationCases.length * 2,
      managedCoverageTriangles:
        gxMultiCoordTevCertificationCases.length * 4,
    }),
  }),
  derivative: Object.freeze({
    packetVersion: gxMipColorOracle.packetVersion,
    textureMap: 0,
    textureCoordinates: Object.freeze([
      TEXTURE_COORD_A,
      TEXTURE_COORD_B,
    ]),
    coordinateA: DERIVATIVE_COORDINATE_A,
    coordinateB: DERIVATIVE_COORDINATE_B,
    mode0: SAMPLER_NEAREST_MIP_NEAREST,
    mode1: MIP_MODE1_ZERO_TO_TWO,
    expectedLevels: Object.freeze([0, 2]),
    mipLevelCount: gxMipColorOracle.mipLevelCount,
  }),
  xfb: Object.freeze({
    destination: XFB_DESTINATION,
    width: XFB_WIDTH,
    height: XFB_HEIGHT,
    stride: XFB_STRIDE,
  }),
  combiner: Object.freeze({
    passTextureColor: PASS_TEXTURE_COLOR,
    passTextureAlpha: PASS_TEXTURE_ALPHA,
    subtractTextureFromR0WithHalfBias:
      SUBTRACT_TEXTURE_FROM_R0_WITH_HALF_BIAS,
    preserveR0Alpha: PRESERVE_R0_ALPHA,
  }),
});

export function gxMultiCoordTevMask(rgba) {
  if (rgba.length !== XFB_WIDTH * XFB_HEIGHT * 4) {
    throw new RangeError(
      "GX multi-coordinate TEV mask requires one 4x4 RGBA surface",
    );
  }
  return rgbaMask(rgba);
}

export { fnv1a64Hex };
