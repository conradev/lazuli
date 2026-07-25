import {
  fnv1a64Hex,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";
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
