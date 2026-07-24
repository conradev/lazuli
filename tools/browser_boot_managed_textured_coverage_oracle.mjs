import {
  buildManagedTexturedCoverageOraclePacket,
  fnv1a64Hex,
  managedTexturedCoverageEvidence,
  managedTexturedCoverageGeometry,
  managedTexturedCoveragePacketFnv1a64,
  managedTexturedCoveragePacketLayout,
  managedTexturedCoverageSamplers,
  managedTexturedCoverageTexels,
  managedTexturedCoverageVectorDefinitions,
  managedTexturedCoverageXfb,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";

export {
  buildManagedTexturedCoverageOraclePacket,
  fnv1a64Hex,
  managedTexturedCoverageEvidence,
  managedTexturedCoverageGeometry,
  managedTexturedCoveragePacketFnv1a64,
  managedTexturedCoveragePacketLayout,
  managedTexturedCoverageSamplers,
  managedTexturedCoverageTexels,
  managedTexturedCoverageVectorDefinitions,
  managedTexturedCoverageXfb,
};

const GX_SAMPLE_NUMERATOR =
  managedTexturedCoverageGeometry.sampleNumerator;
const GX_SAMPLE_DENOMINATOR =
  managedTexturedCoverageGeometry.sampleDenominator;
const KEEP_012 = managedTexturedCoverageEvidence.keep012;
const KEEP_021_TWICE =
  managedTexturedCoverageEvidence.keep021Twice;
const TEXTURE_WIDTH = managedTexturedCoverageGeometry.textureWidth;
const TEXTURE_HEIGHT =
  managedTexturedCoverageGeometry.textureHeight;
const XFB_WIDTH = managedTexturedCoverageXfb.width;
const XFB_HEIGHT = managedTexturedCoverageXfb.height;

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
  const [[x0, y0], [x1, y1], [x2, y2]] = positions.map(([x, y]) => [
    f32(x),
    f32(y),
  ]);
  const [f0, f1, f2] = attributes.map(f32);
  const dx10 = f32Sub(x1, x0);
  const dx20 = f32Sub(x2, x0);
  const dy10 = f32Sub(y1, y0);
  const dy20 = f32Sub(y2, y0);
  const delta20 = f32Sub(f2, f0);
  const delta10 = f32Sub(f1, f0);
  const aLeft = f32Mul(delta20, dy10);
  const aRight = f32Mul(delta10, dy20);
  const a = f32Sub(aLeft, aRight);
  const bLeft = f32Mul(dx20, delta10);
  const bRight = f32Mul(dx10, delta20);
  const b = f32Sub(bLeft, bRight);
  const cLeft = f32Mul(dx20, dy10);
  const cRight = f32Mul(dx10, dy20);
  const c = f32Sub(cLeft, cRight);
  return Object.freeze({
    originX: x0,
    originY: y0,
    originValue: f0,
    dfdx: f32Div(a, c),
    dfdy: f32Div(b, c),
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
  const xTerm = f32Mul(plane.dfdx, dx);
  const yTerm = f32Mul(plane.dfdy, dy);
  const xValue = f32Add(plane.originValue, xTerm);
  return f32Add(xValue, yTerm);
}

function expandedTriangles(definition, applyEvidence) {
  const source =
    definition.topology === 0
      ? [
          [0, 1, 2],
          [0, 2, 3],
        ]
      : [[0, 1, 2]];
  if (!applyEvidence) {
    return source;
  }
  if (definition.evidence === KEEP_012) {
    return source;
  }
  if (definition.evidence === KEEP_021_TWICE) {
    return source.map(([a, b, c]) => [a, c, b]);
  }
  throw new Error("unsupported managed textured evidence");
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

function managedTriangleCovers(definition, triangle, pixelX, pixelY) {
  const points = triangle.map((index) => {
    const [x, y] = definition.vertices[index].position;
    return [snap28_4(x), snap28_4(y)];
  });
  return (
    fixedEdgeCovers(points[0], points[1], pixelX, pixelY) &&
    fixedEdgeCovers(points[1], points[2], pixelX, pixelY) &&
    fixedEdgeCovers(points[2], points[0], pixelX, pixelY)
  );
}

function sourceTriangleCovers(definition, triangle, pixelX, pixelY) {
  const point = [
    pixelX + GX_SAMPLE_NUMERATOR / GX_SAMPLE_DENOMINATOR,
    pixelY + GX_SAMPLE_NUMERATOR / GX_SAMPLE_DENOMINATOR,
  ];
  const positions = triangle.map((index) =>
    definition.vertices[index].position.slice(0, 2),
  );
  const edges = positions.map((a, index) => {
    const b = positions[(index + 1) % 3];
    return (
      (b[0] - a[0]) * (point[1] - a[1]) -
      (b[1] - a[1]) * (point[0] - a[0])
    );
  });
  return (
    edges.every((edge) => edge >= 0) ||
    edges.every((edge) => edge <= 0)
  );
}

function triangleForPixel(definition, pixelX, pixelY) {
  const managed = definition.managed;
  return expandedTriangles(definition, managed).find((triangle) =>
    managed
      ? managedTriangleCovers(
          definition,
          triangle,
          pixelX,
          pixelY,
        )
      : sourceTriangleCovers(
          definition,
          triangle,
          pixelX,
          pixelY,
        ),
  );
}

export function managedTexturedCoveragePerspectiveComponent(
  inverseW,
  componentOverW,
  qOverW,
) {
  const w = f32Div(1, inverseW);
  const q = f32Mul(qOverW, w);
  const projection = q === 0 ? w : f32Div(w, q);
  return f32Mul(componentOverW, projection);
}

function perspectiveStqAtPixel(
  definition,
  triangle,
  coordinate,
  pixelX,
  pixelY,
) {
  const positions = triangle.map((index) =>
    definition.vertices[index].position.slice(0, 2),
  );
  const inverseW = triangle.map((index) =>
    f32Div(1, definition.vertices[index].position[3]),
  );
  const componentsOverW = [0, 1, 2].map((component) => {
    const overW = triangle.map((index, corner) =>
      f32Mul(
        definition.vertices[index].coordinates[coordinate][component],
        inverseW[corner],
      ),
    );
    return samplePlane(
      attributePlane(positions, overW),
      pixelX,
      pixelY,
    );
  });
  const sampledInverseW = samplePlane(
    attributePlane(positions, inverseW),
    pixelX,
    pixelY,
  );
  return [
    managedTexturedCoveragePerspectiveComponent(
      sampledInverseW,
      componentsOverW[0],
      componentsOverW[2],
    ),
    managedTexturedCoveragePerspectiveComponent(
      sampledInverseW,
      componentsOverW[1],
      componentsOverW[2],
    ),
    1,
  ];
}

function affineStqAtPixel(
  definition,
  triangle,
  coordinate,
  pixelX,
  pixelY,
) {
  const positions = triangle.map((index) =>
    definition.vertices[index].position.slice(0, 2),
  );
  return [0, 1, 2].map((component) =>
    samplePlane(
      attributePlane(
        positions,
        triangle.map(
          (index) =>
            definition.vertices[index].coordinates[coordinate][component],
        ),
      ),
      pixelX,
      pixelY,
    ),
  );
}

function predividedUvAtPixel(
  definition,
  triangle,
  coordinate,
  pixelX,
  pixelY,
) {
  const positions = triangle.map((index) =>
    definition.vertices[index].position.slice(0, 2),
  );
  return [0, 1].map((component) =>
    samplePlane(
      attributePlane(
        positions,
        triangle.map((index) => {
          const stq = definition.vertices[index].coordinates[coordinate];
          return f32Div(stq[component], stq[2]);
        }),
      ),
      pixelX,
      pixelY,
    ),
  );
}

function wrapIndex(value, extent, mode) {
  if (mode === 1) return value & (extent - 1);
  if (mode === 2) {
    const reflected = (value & extent) !== 0 ? ~value : value;
    return reflected & (extent - 1);
  }
  return Math.min(extent - 1, Math.max(0, value));
}

function texel(x, y) {
  const offset = (y * TEXTURE_WIDTH + x) * 4;
  return managedTexturedCoverageTexels.slice(offset, offset + 4);
}

function fixedTextureCoordinate(value) {
  return Math.trunc(f32Mul(value, 128));
}

function sampleNearest(u, v, samplerBits) {
  const wrapS = samplerBits & 3;
  const wrapT = (samplerBits >>> 2) & 3;
  const x = wrapIndex(
    fixedTextureCoordinate(u) >> 7,
    TEXTURE_WIDTH,
    wrapS,
  );
  const y = wrapIndex(
    fixedTextureCoordinate(v) >> 7,
    TEXTURE_HEIGHT,
    wrapT,
  );
  return texel(x, y);
}

function sampleLinear(u, v, samplerBits) {
  const wrapS = samplerBits & 3;
  const wrapT = (samplerBits >>> 2) & 3;
  const sourceS = fixedTextureCoordinate(u) - 64;
  const sourceT = fixedTextureCoordinate(v) - 64;
  const x0 = sourceS >> 7;
  const y0 = sourceT >> 7;
  const fractS = sourceS & 0x7f;
  const fractT = sourceT & 0x7f;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const samples = [
    texel(
      wrapIndex(x0, TEXTURE_WIDTH, wrapS),
      wrapIndex(y0, TEXTURE_HEIGHT, wrapT),
    ),
    texel(
      wrapIndex(x1, TEXTURE_WIDTH, wrapS),
      wrapIndex(y0, TEXTURE_HEIGHT, wrapT),
    ),
    texel(
      wrapIndex(x0, TEXTURE_WIDTH, wrapS),
      wrapIndex(y1, TEXTURE_HEIGHT, wrapT),
    ),
    texel(
      wrapIndex(x1, TEXTURE_WIDTH, wrapS),
      wrapIndex(y1, TEXTURE_HEIGHT, wrapT),
    ),
  ];
  const weights = [
    (128 - fractS) * (128 - fractT),
    fractS * (128 - fractT),
    (128 - fractS) * fractT,
    fractS * fractT,
  ];
  return Array.from({ length: 4 }, (_, channel) => (
    samples[0][channel] * weights[0] +
    samples[1][channel] * weights[1] +
    samples[2][channel] * weights[2] +
    samples[3][channel] * weights[3]
  ) >> 14);
}

function sampleTexture(filter, uv, samplerBits) {
  return filter === "linear"
    ? sampleLinear(uv[0], uv[1], samplerBits)
    : sampleNearest(uv[0], uv[1], samplerBits);
}

function expectedSurface(definition, interpolation) {
  const rgba = [];
  for (let y = 0; y < XFB_HEIGHT; y += 1) {
    for (let x = 0; x < XFB_WIDTH; x += 1) {
      const triangle = triangleForPixel(definition, x, y);
      if (triangle === undefined) {
        rgba.push(0, 0, 0, 255);
        continue;
      }
      let uv;
      if (interpolation === "predivided") {
        uv = predividedUvAtPixel(
          definition,
          triangle,
          definition.sampledCoordinate,
          x,
          y,
        );
      } else {
        const stq =
          interpolation === "affine"
            ? affineStqAtPixel(
                definition,
                triangle,
                definition.sampledCoordinate,
                x,
                y,
              )
            : perspectiveStqAtPixel(
                definition,
                triangle,
                definition.sampledCoordinate,
                x,
                y,
              );
        uv = [f32Div(stq[0], stq[2]), f32Div(stq[1], stq[2])];
      }
      const sampled = sampleTexture(
        definition.filter,
        uv,
        definition.samplerBits,
      );
      rgba.push(sampled[0], sampled[1], sampled[2], 255);
    }
  }
  return Object.freeze(rgba);
}

function expectedMask(rgba) {
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

export const managedTexturedCoverageOracleCases = Object.freeze(
  managedTexturedCoverageVectorDefinitions.map((definition) => {
    const expectedRgba = expectedSurface(definition, "perspective");
    const comparisonRgba =
      definition.discriminator === "perspective"
        ? expectedSurface(definition, "affine")
        : definition.discriminator === "stq-before-divide"
          ? expectedSurface(definition, "predivided")
          : null;
    return Object.freeze({
      id: definition.id,
      name: definition.name,
      topology: definition.topology,
      evidence: definition.evidence,
      liveTexCoords: Object.freeze([
        ...new Set(definition.stages.map((stage) => stage.coordinate)),
      ]),
      samplerBits: definition.samplerBits,
      filter: definition.filter,
      expectedPath: definition.managed ? "managed" : "native",
      expectedManagedTriangles: definition.managedTriangles,
      expectedMask: expectedMask(expectedRgba),
      expectedRgba,
      expectedRgbaFnv1a64: fnv1a64Hex(expectedRgba),
      comparisonRgba,
      comparisonRgbaFnv1a64:
        comparisonRgba === null ? null : fnv1a64Hex(comparisonRgba),
    });
  }),
);

const managedDrawsPerRun = managedTexturedCoverageOracleCases.filter(
  (entry) => entry.expectedPath === "managed",
).length;
const managedTrianglesPerRun =
  managedTexturedCoverageOracleCases.reduce(
    (sum, entry) => sum + entry.expectedManagedTriangles,
    0,
  );

export const managedTexturedCoverageExpectedMetrics = Object.freeze({
  perRun: Object.freeze({
    managedCoverageDraws: managedDrawsPerRun,
    managedCoverageTriangles: managedTrianglesPerRun,
  }),
  twoRuns: Object.freeze({
    managedCoverageDraws: managedDrawsPerRun * 2,
    managedCoverageTriangles: managedTrianglesPerRun * 2,
  }),
});

export function managedTexturedCoverageMask(rgba) {
  const expectedBytes = XFB_WIDTH * XFB_HEIGHT * 4;
  if (rgba.length !== expectedBytes) {
    throw new RangeError(
      "managed textured coverage mask requires one 4x4 RGBA surface",
    );
  }
  return expectedMask(rgba);
}
