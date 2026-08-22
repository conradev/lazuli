import { fnv1a64Hex } from "./browser_boot_managed_coverage_oracle.mjs";

// Canonical LZGX v4 packet vectors, independent of the expected-surface model.
const HEADER_BYTES = 160;
const DRAW_BYTES = 176;
const TEXTURE_BYTES = 64;
const TEV_BYTES = 464;
const VERTEX_FLOATS = 36;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const DRAW_OFFSET = HEADER_BYTES;
const TEXTURE_OFFSET = DRAW_OFFSET + DRAW_BYTES;
const TEV_OFFSET = TEXTURE_OFFSET + TEXTURE_BYTES;
const VERTEX_OFFSET = TEV_OFFSET + TEV_BYTES;
const DRAW_FLAG_POST_CULL_EVIDENCE = 1;
const TEXTURE_FLAG_PAYLOAD = 1;
const TEXTURE_REFERENCE_ABSENT = 0xffffffff;
const RASTER_ALWAYS_PASS = 0x003f0000;
const RASTER_BLEND_REPLACE = 1 << 3;
const XFB_DESTINATION = 0x00120000;
const XFB_WIDTH = 4;
const XFB_HEIGHT = 4;
const XFB_STRIDE = XFB_WIDTH * 4;
const GX_SAMPLE_NUMERATOR = 7;
const GX_SAMPLE_DENOMINATOR = 12;
const TEXTURE_WIDTH = 2;
const TEXTURE_HEIGHT = 2;
const TEXTURE_KEY = "lazuli-tx-v1";
const TEXTURE_KEY_BYTES = Uint8Array.from(
  [...TEXTURE_KEY].map((character) => character.charCodeAt(0)),
);
const KEEP_012 = 0x02;
const KEEP_021_TWICE = 0x0f;
const SAMPLER_NEAREST_NO_MIP = 0x00;
const SAMPLER_LINEAR_NO_MIP = 0x90;
const SAMPLER_UNSUPPORTED_MIP = 0x20;

// Deliberately asymmetric in every RGB lane. XFB materialization is opaque,
// so alpha is kept asymmetric in the source vector but expected readback alpha
// remains 255.
export const managedTexturedCoverageTexels = Object.freeze([
  13, 31, 47, 251,
  229, 17, 73, 199,
  61, 211, 29, 157,
  181, 103, 239, 109,
]);

const flatRaster = Object.freeze([1, 1, 1, 1]);
const deadStq = Object.freeze([0, 0, 1]);

function frozenVertex(x, y, w, liveCoordinates) {
  const coordinates = Array.from(
    { length: 8 },
    (_, index) =>
      Object.freeze([...(liveCoordinates[index] ?? deadStq)]),
  );
  return Object.freeze({
    position: Object.freeze([x, y, 0, w]),
    raster0: flatRaster,
    raster1: flatRaster,
    coordinates: Object.freeze(coordinates),
  });
}

const perspectiveVertices = Object.freeze([
  // Packet STQ is post-BP-scale texel space, matching the GX rasterizer
  // contract rather than WebGPU's normalized texture coordinates.
  frozenVertex(0, 0, 1, { 0: [0.2, 0.2, 1] }),
  frozenVertex(0, 8, 4, { 0: [0.2, 1.8, 1] }),
  frozenVertex(8, 0, 0.25, { 0: [1.8, 0.2, 1] }),
]);

const qCoordinates = Object.freeze([
  Object.freeze([0.1, 0.1, 0.5]),
  Object.freeze([1.8, 0.1, 2]),
  Object.freeze([1.8, 1.8, 2]),
  Object.freeze([0.1, 1.8, 0.5]),
]);

const secondCoordinates = Object.freeze([
  Object.freeze([1.6, 0.3, 1]),
  Object.freeze([0.3, 0.3, 1]),
  Object.freeze([0.3, 1.7, 1]),
  Object.freeze([1.6, 1.7, 1]),
]);

function qQuadVertices(secondLiveCoordinate = false) {
  const positions = [
    [0.59, 0],
    [4, 0],
    [4, 4],
    [0.59, 4],
  ];
  return Object.freeze(
    positions.map(([x, y], index) =>
      frozenVertex(x, y, 1, {
        0: qCoordinates[index],
        ...(secondLiveCoordinate ? { 1: secondCoordinates[index] } : {}),
      }),
    ),
  );
}

export const managedTexturedCoverageVectorDefinitions = Object.freeze([
  Object.freeze({
    id: "perspective-nearest-keep012",
    name: "unequal-W perspective nearest sampling with trusted Keep012",
    topology: 2,
    evidence: KEEP_012,
    vertices: perspectiveVertices,
    stages: Object.freeze([Object.freeze({ map: 0, coordinate: 0 })]),
    sampledCoordinate: 0,
    samplerBits: SAMPLER_NEAREST_NO_MIP,
    filter: "nearest",
    managed: true,
    managedTriangles: 1,
    discriminator: "perspective",
  }),
  Object.freeze({
    id: "nonunit-q-linear-keep021",
    name: "non-unit Q linear sampling across x=.590 and a Keep021 seam",
    topology: 0,
    evidence: KEEP_021_TWICE,
    vertices: qQuadVertices(),
    stages: Object.freeze([Object.freeze({ map: 0, coordinate: 0 })]),
    sampledCoordinate: 0,
    samplerBits: SAMPLER_LINEAR_NO_MIP,
    filter: "linear",
    managed: true,
    managedTriangles: 2,
    discriminator: "stq-before-divide",
  }),
  Object.freeze({
    id: "second-live-coordinate-native",
    name: "trusted evidence with a second live coordinate stays native",
    topology: 0,
    evidence: KEEP_021_TWICE,
    vertices: qQuadVertices(true),
    stages: Object.freeze([
      Object.freeze({ map: 0, coordinate: 0 }),
      Object.freeze({ map: 0, coordinate: 1 }),
    ]),
    sampledCoordinate: 1,
    samplerBits: SAMPLER_NEAREST_NO_MIP,
    filter: "nearest",
    managed: false,
    managedTriangles: 0,
    discriminator: "second-live-coordinate",
  }),
  Object.freeze({
    id: "mip-min-filter-native",
    name: "trusted evidence with an unsupported mip min-filter stays native",
    topology: 0,
    evidence: KEEP_021_TWICE,
    vertices: qQuadVertices(),
    stages: Object.freeze([Object.freeze({ map: 0, coordinate: 0 })]),
    sampledCoordinate: 0,
    samplerBits: SAMPLER_UNSUPPORTED_MIP,
    filter: "nearest",
    managed: false,
    managedTriangles: 0,
    discriminator: "unsupported-mip",
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

function writeTexturePassTev(view, offset, stages) {
  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex];
    const stageOffset = offset + stageIndex * 16;
    putU32(
      view,
      stageOffset,
      colorCombiner([15, 15, 15, 8], 0, 1),
    );
    putU32(
      view,
      stageOffset + 4,
      alphaCombiner([7, 7, 7, 4], 0, 1),
    );
    putU32(
      view,
      stageOffset + 8,
      stage.map | (stage.coordinate << 3) | (1 << 6) | (7 << 7),
    );
    putU32(view, stageOffset + 12, 0);
  }
  for (let channel = 0; channel < 4; channel += 1) {
    putU32(view, offset + 384 + channel * 4, channel);
  }
  putU32(view, offset + 448, stages.length);
}

function vertexValues(vertex) {
  const values = [
    ...vertex.position,
    ...vertex.raster0,
    ...vertex.raster1,
    ...vertex.coordinates.flat(),
  ];
  if (values.length !== VERTEX_FLOATS) {
    throw new Error(`managed textured vertex has ${values.length} floats`);
  }
  return values;
}

function writeVertex(view, offset, vertex) {
  const values = vertexValues(vertex);
  for (let component = 0; component < values.length; component += 1) {
    view.setFloat32(offset + component * 4, values[component], true);
  }
}

function definitionFor(id) {
  const definition = managedTexturedCoverageVectorDefinitions.find(
    (entry) => entry.id === id,
  );
  if (definition === undefined) {
    throw new RangeError(`unknown managed textured coverage variant ${id}`);
  }
  return definition;
}

export function managedTexturedCoveragePacketLayout(id) {
  const definition = definitionFor(id);
  const vertexBytes = definition.vertices.length * VERTEX_BYTES;
  const keyOffset = VERTEX_OFFSET + vertexBytes;
  const pixelOffset = align16(keyOffset + TEXTURE_KEY_BYTES.length);
  const evidenceOffset =
    pixelOffset + managedTexturedCoverageTexels.length;
  const packetBytes = align16(evidenceOffset + 1);
  return Object.freeze({
    headerBytes: HEADER_BYTES,
    drawOffset: DRAW_OFFSET,
    drawBytes: DRAW_BYTES,
    textureOffset: TEXTURE_OFFSET,
    textureBytes: TEXTURE_BYTES,
    tevOffset: TEV_OFFSET,
    tevBytes: TEV_BYTES,
    vertexOffset: VERTEX_OFFSET,
    vertexFloats: VERTEX_FLOATS,
    vertexBytes: VERTEX_BYTES,
    vertexCount: definition.vertices.length,
    keyOffset,
    keyBytes: TEXTURE_KEY_BYTES.length,
    pixelOffset,
    pixelBytes: managedTexturedCoverageTexels.length,
    evidenceOffset,
    evidenceBytes: 1,
    evidencePaddedBytes: packetBytes - evidenceOffset,
    packetBytes,
  });
}

export function buildManagedTexturedCoverageOraclePacket(
  id,
  generation = 1,
) {
  const definition = definitionFor(id);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > 0xffffffff
  ) {
    throw new RangeError("managed textured generation must be a u32");
  }
  const layout = managedTexturedCoveragePacketLayout(id);
  const packet = new Uint8Array(layout.packetBytes);
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );

  packet.set([0x4c, 0x5a, 0x47, 0x58], 0);
  putU16(view, 0x04, 4);
  putU16(view, 0x06, HEADER_BYTES);
  putU32(view, 0x08, packet.length);
  putU32(view, 0x10, 2);
  putU32(view, 0x14, 1);
  putU32(view, 0x18, 1);
  putU32(view, 0x1c, DRAW_OFFSET);
  putU32(view, 0x20, TEXTURE_OFFSET);
  putU32(view, 0x24, TEV_OFFSET);
  putU32(view, 0x28, VERTEX_OFFSET);
  putU32(view, 0x2c, layout.keyOffset);
  putU32(view, 0x30, layout.pixelOffset);
  putU32(view, 0x34, DRAW_BYTES);
  putU32(view, 0x38, TEXTURE_BYTES);
  putU32(view, 0x3c, TEV_BYTES);
  putU32(view, 0x40, definition.vertices.length * VERTEX_BYTES);
  putU32(view, 0x44, TEXTURE_KEY_BYTES.length);
  putU32(view, 0x48, managedTexturedCoverageTexels.length);
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
  putU16(view, 0x7a, TEXTURE_BYTES);
  putU32(view, 0x7c, definition.vertices.length);
  putU32(view, 0x80, 0);
  putU32(view, 0x84, 0);
  putU32(view, 0x88, 0);
  putU32(view, 0x8c, 0x4003);
  putU32(view, 0x90, 0);
  putU32(view, 0x94, 256);
  putU32(view, 0x98, (32 << 12) | (32 << 18));
  putU32(view, 0x9c, 0);

  packet[DRAW_OFFSET] = definition.topology;
  packet[DRAW_OFFSET + 1] = 0;
  putU16(
    view,
    DRAW_OFFSET + 0x02,
    DRAW_FLAG_POST_CULL_EVIDENCE,
  );
  putU32(view, DRAW_OFFSET + 0x04, definition.vertices.length);
  putU32(view, DRAW_OFFSET + 0x08, 0);
  putU32(view, DRAW_OFFSET + 0x0c, 0);
  putU32(view, DRAW_OFFSET + 0x10, 0);
  putU32(view, DRAW_OFFSET + 0x14, RASTER_BLEND_REPLACE);
  putU32(view, DRAW_OFFSET + 0x18, RASTER_ALWAYS_PASS);
  putU32(view, DRAW_OFFSET + 0x1c, 0);
  putU32(view, DRAW_OFFSET + 0x20, 0);
  putU32(view, DRAW_OFFSET + 0x24, XFB_WIDTH);
  putU32(view, DRAW_OFFSET + 0x28, XFB_HEIGHT);
  putU32(view, DRAW_OFFSET + 0x30, 0);
  putU32(view, DRAW_OFFSET + 0x34, definition.samplerBits);
  for (let map = 1; map < 8; map += 1) {
    putU32(
      view,
      DRAW_OFFSET + 0x30 + map * 8,
      TEXTURE_REFERENCE_ABSENT,
    );
    putU32(view, DRAW_OFFSET + 0x34 + map * 8, 0);
  }

  putU32(view, TEXTURE_OFFSET + 0x00, 0);
  putU32(view, TEXTURE_OFFSET + 0x04, TEXTURE_KEY_BYTES.length);
  putU32(view, TEXTURE_OFFSET + 0x08, 0);
  putU32(
    view,
    TEXTURE_OFFSET + 0x0c,
    managedTexturedCoverageTexels.length,
  );
  putU32(view, TEXTURE_OFFSET + 0x10, 0);
  putU32(view, TEXTURE_OFFSET + 0x14, 0);
  putU32(view, TEXTURE_OFFSET + 0x18, TEXTURE_WIDTH);
  putU32(view, TEXTURE_OFFSET + 0x1c, TEXTURE_HEIGHT);
  putU32(view, TEXTURE_OFFSET + 0x20, TEXTURE_FLAG_PAYLOAD);

  writeTexturePassTev(view, TEV_OFFSET, definition.stages);
  for (
    let vertexIndex = 0;
    vertexIndex < definition.vertices.length;
    vertexIndex += 1
  ) {
    writeVertex(
      view,
      VERTEX_OFFSET + vertexIndex * VERTEX_BYTES,
      definition.vertices[vertexIndex],
    );
  }
  packet.set(TEXTURE_KEY_BYTES, layout.keyOffset);
  packet.set(managedTexturedCoverageTexels, layout.pixelOffset);
  packet[layout.evidenceOffset] = definition.evidence;
  return packet;
}

export const managedTexturedCoveragePacketFnv1a64 = Object.freeze(
  Object.fromEntries(
    managedTexturedCoverageVectorDefinitions.map(({ id }, index) => [
      id,
      fnv1a64Hex(
        buildManagedTexturedCoverageOraclePacket(id, index + 1),
      ),
    ]),
  ),
);

export const managedTexturedCoverageEvidence = Object.freeze({
  drawFlag: DRAW_FLAG_POST_CULL_EVIDENCE,
  keep012: KEEP_012,
  keep021Twice: KEEP_021_TWICE,
});

export const managedTexturedCoverageSamplers = Object.freeze({
  nearestNoMip: SAMPLER_NEAREST_NO_MIP,
  linearNoMip: SAMPLER_LINEAR_NO_MIP,
  unsupportedMip: SAMPLER_UNSUPPORTED_MIP,
});

export const managedTexturedCoverageXfb = Object.freeze({
  destination: XFB_DESTINATION,
  width: XFB_WIDTH,
  height: XFB_HEIGHT,
  stride: XFB_STRIDE,
});

export const managedTexturedCoverageGeometry = Object.freeze({
  sampleNumerator: GX_SAMPLE_NUMERATOR,
  sampleDenominator: GX_SAMPLE_DENOMINATOR,
  snapSourceX: 0.59,
  snapSourceXBits: 0x3f170a3d,
  snappedSourceX28_4: 9,
  perspectiveW: Object.freeze([1, 4, 0.25]),
  textureKey: TEXTURE_KEY,
  textureWidth: TEXTURE_WIDTH,
  textureHeight: TEXTURE_HEIGHT,
});

export { fnv1a64Hex };
