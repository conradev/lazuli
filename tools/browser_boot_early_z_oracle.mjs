const HEADER_BYTES = 160;
const DRAW_BYTES = 176;
const TEV_BYTES = 464;
const VERTEX_FLOATS = 36;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const DEPTH24_MAX = 0x00ffffff;
const XFB_DESTINATION = 0x00100000;
const XFB_WIDTH = 4;
const XFB_HEIGHT = 4;
const XFB_STRIDE = XFB_WIDTH * 4;

export const EARLY_Z_ALWAYS_PASS = 0x003f0000;
export const EARLY_Z_ALWAYS_FAIL = 0;
export const EARLY_Z_ALPHA_GREATER_127 =
  127 | (4 << 16) | (7 << 19);
export const EARLY_Z_LESS_UPDATE = 1 | (1 << 1) | (1 << 4);
export const EARLY_Z_LESS_NO_UPDATE = 1 | (1 << 1);
export const EARLY_Z_EQUAL_UPDATE = 1 | (2 << 1) | (1 << 4);
export const EARLY_Z_NOT_EQUAL_UPDATE = 1 | (5 << 1) | (1 << 4);
export const EARLY_Z_PIXEL_CONTROL = 1 << 6;

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
    vertex.depth,
    1,
    ...vertex.rgba,
    0,
    0,
    0,
    0,
    ...new Array(24).fill(0),
  ];
  if (values.length !== VERTEX_FLOATS) {
    throw new Error(`early-Z oracle vertex has ${values.length} floats`);
  }
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(offset + index * 4, values[index], true);
  }
}

export function depth24(fraction) {
  return Math.round(Math.max(0, Math.min(1, fraction)) * DEPTH24_MAX);
}

export function fullscreenTriangle(depth, rgba) {
  return [
    { x: 0, y: 0, depth, rgba },
    { x: 1280, y: 0, depth, rgba },
    { x: 0, y: 1056, depth, rgba },
  ];
}

export function buildEarlyZOraclePacket(draws, generation = 1) {
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
    packet[record] = 2;
    packet[record + 1] = 0;
    putU32(view, record + 0x04, draw.vertices.length);
    putU32(view, record + 0x08, vertexRelativeOffset);
    putU32(view, record + 0x0c, drawIndex * TEV_BYTES);
    putU32(view, record + 0x10, draw.zMode);
    putU32(view, record + 0x14, 1 << 3);
    putU32(view, record + 0x18, draw.alphaTest);
    putU32(view, record + 0x1c, 0);
    putU32(view, record + 0x20, 0);
    putU32(view, record + 0x24, 640);
    putU32(view, record + 0x28, 528);
    for (let map = 0; map < 8; map += 1) {
      putU32(view, record + 0x30 + map * 8, 0xffffffff);
      putU32(view, record + 0x34 + map * 8, 0);
    }
    putU32(view, record + 0x70, draw.pixelControl);
    putU32(view, record + 0x74, 0);
    putU32(view, record + 0x78, draw.zTextureBias ?? 0);
    putU32(view, record + 0x7c, draw.zTextureMode ?? 0);

    writeRasterPassTev(view, tevOffset + drawIndex * TEV_BYTES);
    for (let vertexIndex = 0; vertexIndex < draw.vertices.length; vertexIndex += 1) {
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

function draw(depth, rgba, alphaTest, pixelControl, zMode, extra = {}) {
  return {
    vertices: fullscreenTriangle(depth24(depth), rgba),
    alphaTest,
    pixelControl,
    zMode,
    ...extra,
  };
}

const red = [1, 0, 0, 1];
const green = [0, 1, 0, 1];
const invisible = [0, 1, 0, 0];

export const earlyZOracleCases = [
  {
    name: "early alpha failure commits source depth",
    expected: [0, 0, 0, 255],
    draws: [
      draw(
        0.25,
        invisible,
        EARLY_Z_ALWAYS_FAIL,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
      ),
      draw(
        0.75,
        red,
        EARLY_Z_ALWAYS_PASS,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
      ),
    ],
  },
  {
    name: "late alpha failure leaves depth untouched",
    expected: [255, 0, 0, 255],
    draws: [
      draw(0.25, invisible, EARLY_Z_ALWAYS_FAIL, 0, EARLY_Z_LESS_UPDATE),
      draw(
        0.75,
        red,
        EARLY_Z_ALWAYS_PASS,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
      ),
    ],
  },
  {
    name: "early alpha failure with Z updates disabled leaves depth untouched",
    expected: [255, 0, 0, 255],
    draws: [
      draw(
        0.25,
        invisible,
        EARLY_Z_ALWAYS_FAIL,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_NO_UPDATE,
      ),
      draw(
        0.75,
        red,
        EARLY_Z_ALWAYS_PASS,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
      ),
    ],
  },
  {
    name: "early Z-texture commits raster depth rather than replacement depth",
    expected: [255, 0, 0, 255],
    draws: [
      draw(
        0.75,
        invisible,
        EARLY_Z_ALWAYS_FAIL,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
        { zTextureMode: 2 << 2 },
      ),
      draw(
        0.5,
        red,
        EARLY_Z_ALWAYS_PASS,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
      ),
    ],
  },
  {
    name: "one draw commits each expanded primitive before the next color attempt",
    expected: [0, 0, 0, 255],
    draws: [
      {
        vertices: [
          ...fullscreenTriangle(depth24(0.25), invisible),
          ...fullscreenTriangle(depth24(0.75), red),
        ],
        alphaTest: EARLY_Z_ALPHA_GREATER_127,
        pixelControl: EARLY_Z_PIXEL_CONTROL,
        zMode: EARLY_Z_LESS_UPDATE,
      },
    ],
  },
  {
    name: "paired early-depth commit is invariant for a coplanar Equal probe",
    expected: [0, 255, 0, 255],
    draws: [
      draw(
        0.5,
        red,
        EARLY_Z_ALPHA_GREATER_127,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
      ),
      draw(
        0.5,
        green,
        EARLY_Z_ALWAYS_PASS,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_EQUAL_UPDATE,
      ),
    ],
  },
  {
    name: "early NotEqual alpha failure commits before a later Less draw",
    expected: [0, 0, 0, 255],
    draws: [
      draw(
        0.25,
        invisible,
        EARLY_Z_ALWAYS_FAIL,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_NOT_EQUAL_UPDATE,
      ),
      draw(
        0.75,
        red,
        EARLY_Z_ALWAYS_PASS,
        EARLY_Z_PIXEL_CONTROL,
        EARLY_Z_LESS_UPDATE,
      ),
    ],
  },
];

export const earlyZOracleXfb = {
  destination: XFB_DESTINATION,
  width: XFB_WIDTH,
  height: XFB_HEIGHT,
  stride: XFB_STRIDE,
};
