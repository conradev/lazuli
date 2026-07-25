import {
  buildManagedTexturedCoverageOraclePacket,
  managedTexturedCoverageGeometry,
  managedTexturedCoveragePacketLayout,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";

const BASE_VECTOR = "mip-min-filter-native";
const PACKET_VERSION = 7;
const DRAW_TEXTURE_MAPS = 8;
const MODE1_BYTES_PER_DRAW = DRAW_TEXTURE_MAPS * 4;
const TEXTURE_FLAG_PAYLOAD = 1;
const TEXTURE_WIDTH = 5;
const TEXTURE_HEIGHT = 3;
const TEXTURE_MIP_LEVEL_COUNT = 3;
// Keep the oracle on the representable non-anisotropic path. The resource
// contract is under test here; dedicated sampler oracles own GX LOD policy.
const TEXTURE_MODE0 = 0x00000051;
const TEXTURE_MODE1 = 0x00002004;
const TEXTURE_LEVELS = Object.freeze([
  Object.freeze({ level: 0, width: 5, height: 3, offset: 0, bytes: 60 }),
  Object.freeze({ level: 1, width: 2, height: 1, offset: 60, bytes: 8 }),
  Object.freeze({ level: 2, width: 1, height: 1, offset: 68, bytes: 4 }),
]);
const TEXTURE_PAYLOAD_BYTES = 72;
const TEXTURE_PIXEL_BYTES = Uint8Array.from(
  { length: TEXTURE_PAYLOAD_BYTES },
  (_unused, index) => (3 + index * 17) & 0xff,
);

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
    throw new RangeError("GX mip upload generation must be a u32");
  }
  return value;
}

export function gxMipUploadOraclePacketLayout(resident = false) {
  if (typeof resident !== "boolean") {
    throw new TypeError("GX mip upload resident state must be boolean");
  }
  const baseLayout =
    managedTexturedCoveragePacketLayout(BASE_VECTOR);
  const pixelBytes = resident ? 0 : align16(TEXTURE_PAYLOAD_BYTES);
  const evidenceBytes = 1;
  const evidenceOffset = baseLayout.pixelOffset + pixelBytes;
  const exactOffset = align16(evidenceOffset + evidenceBytes);
  const mode1Offset = exactOffset;
  const packetBytes = mode1Offset + MODE1_BYTES_PER_DRAW;
  return Object.freeze({
    headerBytes: baseLayout.headerBytes,
    drawOffset: baseLayout.drawOffset,
    textureOffset: baseLayout.textureOffset,
    tevOffset: baseLayout.tevOffset,
    vertexOffset: baseLayout.vertexOffset,
    keyOffset: baseLayout.keyOffset,
    keyBytes: baseLayout.keyBytes,
    pixelOffset: baseLayout.pixelOffset,
    payloadBytes: resident ? 0 : TEXTURE_PAYLOAD_BYTES,
    pixelBytes,
    evidenceOffset,
    evidenceBytes,
    exactOffset,
    mode1Offset,
    mode1Bytes: MODE1_BYTES_PER_DRAW,
    packetBytes,
  });
}

export function buildGxMipUploadOraclePacket({
  generation = 1,
  resident = false,
} = {}) {
  generation = generationU32(generation);
  if (typeof resident !== "boolean") {
    throw new TypeError("GX mip upload resident state must be boolean");
  }

  const base = buildManagedTexturedCoverageOraclePacket(
    BASE_VECTOR,
    generation,
  );
  const baseView = new DataView(
    base.buffer,
    base.byteOffset,
    base.byteLength,
  );
  const baseLayout =
    managedTexturedCoveragePacketLayout(BASE_VECTOR);
  const layout = gxMipUploadOraclePacketLayout(resident);
  const packet = new Uint8Array(layout.packetBytes);
  const view = new DataView(packet.buffer);
  const baseEvidenceOffset =
    baseLayout.pixelOffset + baseView.getUint32(0x48, true);

  packet.set(base.subarray(0, baseLayout.pixelOffset));
  putU16(view, 0x04, PACKET_VERSION);
  putU32(view, 0x08, layout.packetBytes);
  putU32(view, 0x48, layout.pixelBytes);

  putU32(view, layout.drawOffset + 0x34, TEXTURE_MODE0);

  putU32(view, layout.textureOffset + 0x08, 0);
  putU32(view, layout.textureOffset + 0x0c, layout.payloadBytes);
  putU32(view, layout.textureOffset + 0x18, TEXTURE_WIDTH);
  putU32(view, layout.textureOffset + 0x1c, TEXTURE_HEIGHT);
  putU32(
    view,
    layout.textureOffset + 0x20,
    resident ? 0 : TEXTURE_FLAG_PAYLOAD,
  );
  putU32(
    view,
    layout.textureOffset + 0x24,
    TEXTURE_MIP_LEVEL_COUNT,
  );

  if (!resident) {
    packet.set(TEXTURE_PIXEL_BYTES, layout.pixelOffset);
  }
  packet[layout.evidenceOffset] = base[baseEvidenceOffset];
  putU32(view, layout.mode1Offset, TEXTURE_MODE1);
  return packet;
}

export const gxMipUploadOracle = Object.freeze({
  packetVersion: PACKET_VERSION,
  key: managedTexturedCoverageGeometry.textureKey,
  width: TEXTURE_WIDTH,
  height: TEXTURE_HEIGHT,
  mipLevelCount: TEXTURE_MIP_LEVEL_COUNT,
  mode0: TEXTURE_MODE0,
  mode1: TEXTURE_MODE1,
  payloadBytes: TEXTURE_PAYLOAD_BYTES,
  paddedPixelBytes: align16(TEXTURE_PAYLOAD_BYTES),
  levels: TEXTURE_LEVELS,
  expectedFirstUpload: Object.freeze({
    resourceIdentities: 1,
    textureWrites: TEXTURE_MIP_LEVEL_COUNT,
    textureUploadBytes: TEXTURE_PAYLOAD_BYTES,
    packetPayloadBytes: TEXTURE_PAYLOAD_BYTES,
  }),
  expectedResidentUpload: Object.freeze({
    resourceIdentities: 1,
    textureWrites: 0,
    textureUploadBytes: 0,
    packetPayloadBytes: 0,
  }),
});

export const gxMipUploadOraclePixels =
  Uint8Array.from(TEXTURE_PIXEL_BYTES);
