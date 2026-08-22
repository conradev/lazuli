const HEADER_BYTES = 160;
const DRAW_BYTES = 176;
const TEV_BYTES = 464;
const VERTEX_FLOATS = 36;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const DEPTH24_MAX = 0x00ffffff;
const XFB_DESTINATION = 0x00110000;
const XFB_WIDTH = 4;
const XFB_HEIGHT = 4;
const XFB_STRIDE = XFB_WIDTH * 4;

export const GX_RASTER_CENTER = 7 / 12;
export const RASTER_ALWAYS_PASS = 0x003f0000;
export const RASTER_ALWAYS_UPDATE = 1 | (7 << 1) | (1 << 4);
export const RASTER_EQUAL_NO_UPDATE = 1 | (2 << 1);
export const RASTER_BLEND_REPLACE = 1 << 3;
export const RASTER_BLEND_ADDITIVE_ONE_ONE =
  1 | (1 << 3) | (1 << 5) | (1 << 8);

const black = [0, 0, 0, 255];
const white = [255, 255, 255, 255];
const red64 = [64, 0, 0, 255];

function putU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function putU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function colorCombiner(args, operation, destination) {
  return (
    (args[0] << 12) |
    (args[1] << 8) |
    (args[2] << 4) |
    args[3] |
    ((operation & 1) << 18) |
    (1 << 19) |
    (((operation >> 1) & 3) << 20) |
    (destination << 22) |
    (operation >= 8 ? 3 << 16 : 0)
  ) >>> 0;
}

function alphaCombiner(args, operation, destination) {
  return (
    (args[0] << 13) |
    (args[1] << 10) |
    (args[2] << 7) |
    (args[3] << 4) |
    ((operation & 1) << 18) |
    (1 << 19) |
    (((operation >> 1) & 3) << 20) |
    (destination << 22) |
    (operation >= 8 ? 3 << 16 : 0)
  ) >>> 0;
}

function writeRasterPassTev(view, offset) {
  putU32(view, offset, colorCombiner([15, 15, 15, 10], 0, 1));
  putU32(view, offset + 4, alphaCombiner([7, 7, 7, 5], 0, 1));
  putU32(view, offset + 8, 0);
  putU32(view, offset + 12, 0);
  for (let channel = 0; channel < 4; channel += 1) {
    putU32(view, offset + 384 + channel * 4, channel);
  }
  putU32(view, offset + 448, 1);
}

function writeVertex(view, offset, vertex) {
  const values = [
    vertex.x,
    vertex.y,
    vertex.depth24,
    1,
    ...vertex.rgba,
    0,
    0,
    0,
    0,
    ...new Array(24).fill(0),
  ];
  if (values.length !== VERTEX_FLOATS) {
    throw new Error(`raster-center oracle vertex has ${values.length} floats`);
  }
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(offset + index * 4, values[index], true);
  }
}

function vertex(x, y, depth24, rgba) {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(depth24) ||
    depth24 < 0 ||
    depth24 > DEPTH24_MAX ||
    !Array.isArray(rgba) ||
    rgba.length !== 4 ||
    rgba.some((channel) => !Number.isFinite(channel))
  ) {
    throw new RangeError("invalid GX raster-center oracle vertex");
  }
  return { x, y, depth24, rgba };
}

function quad(x0, y0, x1, y1, depths, rgba) {
  if (!Array.isArray(depths) || depths.length !== 4) {
    throw new RangeError("GX raster-center quad requires four depths");
  }
  return [
    vertex(x0, y0, depths[0], rgba),
    vertex(x1, y0, depths[1], rgba),
    vertex(x1, y1, depths[2], rgba),
    vertex(x0, y1, depths[3], rgba),
  ];
}

function fullscreenTriangle(depths, rgba) {
  if (!Array.isArray(depths) || depths.length !== 3) {
    throw new RangeError("GX raster-center triangle requires three depths");
  }
  return [
    vertex(0, 0, depths[0], rgba),
    vertex(1280, 0, depths[1], rgba),
    vertex(0, 1056, depths[2], rgba),
  ];
}

function rgbaSurface(changes = []) {
  const pixels = Array.from(
    { length: XFB_WIDTH * XFB_HEIGHT },
    () => [...black],
  );
  for (const { x, y, rgba } of changes) {
    if (x < 0 || x >= XFB_WIDTH || y < 0 || y >= XFB_HEIGHT) {
      throw new RangeError(`oracle pixel (${x}, ${y}) is outside the XFB`);
    }
    pixels[y * XFB_WIDTH + x] = [...rgba];
  }
  return pixels.flat();
}

function uniformSurface(rgba) {
  return Array.from(
    { length: XFB_WIDTH * XFB_HEIGHT },
    () => rgba,
  ).flat();
}

function oracleDraw({
  topology,
  vertices,
  zMode = 0,
  blendMode = RASTER_BLEND_REPLACE,
  scissor = { x: 0, y: 0, width: XFB_WIDTH, height: XFB_HEIGHT },
}) {
  return {
    topology,
    vertices,
    zMode,
    blendMode,
    alphaTest: RASTER_ALWAYS_PASS,
    pixelControl: 0,
    scissor,
  };
}

export function buildRasterCenterOraclePacket(draws, generation = 1) {
  const totalVertices = draws.reduce(
    (count, draw) => count + draw.vertices.length,
    0,
  );
  const drawOffset = HEADER_BYTES;
  const textureOffset = drawOffset + draws.length * DRAW_BYTES;
  const tevOffset = textureOffset;
  const vertexOffset = tevOffset + draws.length * TEV_BYTES;
  const keyOffset = vertexOffset + totalVertices * VERTEX_BYTES;
  const pixelOffset = keyOffset;
  const packet = new Uint8Array(pixelOffset);
  const view = new DataView(packet.buffer);

  packet.set([0x4c, 0x5a, 0x47, 0x58], 0);
  putU16(view, 0x04, 3);
  putU16(view, 0x06, HEADER_BYTES);
  putU32(view, 0x08, packet.length);
  putU32(view, 0x10, 2);
  putU32(view, 0x14, draws.length);
  putU32(view, 0x18, 0);
  putU32(view, 0x1c, drawOffset);
  putU32(view, 0x20, textureOffset);
  putU32(view, 0x24, tevOffset);
  putU32(view, 0x28, vertexOffset);
  putU32(view, 0x2c, keyOffset);
  putU32(view, 0x30, pixelOffset);
  putU32(view, 0x34, draws.length * DRAW_BYTES);
  putU32(view, 0x38, 0);
  putU32(view, 0x3c, draws.length * TEV_BYTES);
  putU32(view, 0x40, totalVertices * VERTEX_BYTES);
  putU32(view, 0x44, 0);
  putU32(view, 0x48, 0);
  putU32(view, 0x4c, 0);
  putU32(view, 0x50, 0);
  putU32(view, 0x54, XFB_WIDTH);
  putU32(view, 0x58, XFB_HEIGHT);
  putU32(view, 0x5c, XFB_WIDTH);
  putU32(view, 0x60, XFB_HEIGHT);
  putU32(view, 0x64, XFB_DESTINATION);
  putU32(view, 0x68, XFB_STRIDE);
  putU32(view, 0x6c, generation);
  putU32(view, 0x70, 0);
  putU16(view, 0x78, DRAW_BYTES);
  putU16(view, 0x7a, 64);
  putU32(view, 0x7c, totalVertices);
  putU32(view, 0x80, 0);
  putU32(view, 0x84, 0);
  putU32(view, 0x88, 0);
  putU32(view, 0x8c, 0x4003);
  putU32(view, 0x90, 0);
  putU32(view, 0x94, 256);
  putU32(view, 0x98, (32 << 12) | (32 << 18));
  putU32(view, 0x9c, 0);

  let vertexRelativeOffset = 0;
  for (let drawIndex = 0; drawIndex < draws.length; drawIndex += 1) {
    const draw = draws[drawIndex];
    const record = drawOffset + drawIndex * DRAW_BYTES;
    packet[record] = draw.topology;
    packet[record + 1] = 0;
    putU32(view, record + 0x04, draw.vertices.length);
    putU32(view, record + 0x08, vertexRelativeOffset);
    putU32(view, record + 0x0c, drawIndex * TEV_BYTES);
    putU32(view, record + 0x10, draw.zMode);
    putU32(view, record + 0x14, draw.blendMode);
    putU32(view, record + 0x18, draw.alphaTest);
    putU32(view, record + 0x1c, draw.scissor.x);
    putU32(view, record + 0x20, draw.scissor.y);
    putU32(view, record + 0x24, draw.scissor.width);
    putU32(view, record + 0x28, draw.scissor.height);
    for (let map = 0; map < 8; map += 1) {
      putU32(view, record + 0x30 + map * 8, 0xffffffff);
      putU32(view, record + 0x34 + map * 8, 0);
    }
    putU32(view, record + 0x70, draw.pixelControl);
    putU32(view, record + 0x74, 0);
    putU32(view, record + 0x78, 0);
    putU32(view, record + 0x7c, 0);

    writeRasterPassTev(view, tevOffset + drawIndex * TEV_BYTES);
    for (
      let vertexIndex = 0;
      vertexIndex < draw.vertices.length;
      vertexIndex += 1
    ) {
      writeVertex(
        view,
        vertexOffset + vertexRelativeOffset + vertexIndex * VERTEX_BYTES,
        draw.vertices[vertexIndex],
      );
    }
    vertexRelativeOffset += draw.vertices.length * VERTEX_BYTES;
  }

  return packet;
}

const coverage = {
  name: "GX 7/12 center covers x=13/24",
  expectedRgba: rgbaSurface([{ x: 0, y: 0, rgba: white }]),
  draws: [
    oracleDraw({
      topology: 0,
      vertices: quad(13 / 24, -1, 1, 1, [0, 0, 0, 0], [1, 1, 1, 1]),
    }),
  ],
};

const centerDepth = {
  name: "GX 7/12 center evaluates 94.25+12x as Equal Z101",
  expectedRgba: rgbaSurface([{ x: 0, y: 0, rgba: white }]),
  draws: [
    oracleDraw({
      topology: 2,
      vertices: fullscreenTriangle(
        // Keep the intended Z101 a quarter unit away from a truncation
        // boundary. The uncorrected WebGPU center still evaluates Z100.
        [94.25, 94.25 + 12 * 1280, 94.25],
        [0, 0, 0, 1],
      ),
      zMode: RASTER_ALWAYS_UPDATE,
    }),
    oracleDraw({
      topology: 2,
      vertices: fullscreenTriangle([101, 101, 101], [1, 1, 1, 1]),
      zMode: RASTER_EQUAL_NO_UPDATE,
      scissor: { x: 0, y: 0, width: 1, height: 1 },
    }),
  ],
};

const additiveSeam = {
  name: "topology-0 additive 012/023 seam shades once",
  expectedRgba: uniformSurface(red64),
  draws: [
    oracleDraw({
      topology: 0,
      vertices: quad(
        -1,
        -1,
        5,
        5,
        [0, 0, 0, 0],
        [64 / 255, 0, 0, 1],
      ),
      blendMode: RASTER_BLEND_ADDITIVE_ONE_ONE,
    }),
  ],
};

const canonicalDiagonal = {
  name: "topology-0 canonical 012/023 diagonal compares Equal Z190",
  expectedRgba: rgbaSurface([{ x: 2, y: 1, rgba: white }]),
  draws: [
    oracleDraw({
      topology: 0,
      vertices: quad(
        0,
        0,
        4,
        4,
        // The shared quarter-unit bias keeps canonical Z190 away from a
        // floating-point boundary without changing the diagonal gradient.
        [0.25, 0.25, 480.25, 0.25],
        [0, 0, 0, 1],
      ),
      zMode: RASTER_ALWAYS_UPDATE,
    }),
    oracleDraw({
      topology: 2,
      vertices: fullscreenTriangle([190, 190, 190], [1, 1, 1, 1]),
      zMode: RASTER_EQUAL_NO_UPDATE,
      scissor: { x: 2, y: 1, width: 1, height: 1 },
    }),
  ],
};

export const rasterCenterOracleCases = [
  coverage,
  centerDepth,
  additiveSeam,
  canonicalDiagonal,
];

export function rasterCenterOraclePixel(rgba, x, y) {
  const offset = (y * XFB_WIDTH + x) * 4;
  return rgba.slice(offset, offset + 4);
}

export const rasterCenterOracleXfb = {
  destination: XFB_DESTINATION,
  width: XFB_WIDTH,
  height: XFB_HEIGHT,
  stride: XFB_STRIDE,
};
