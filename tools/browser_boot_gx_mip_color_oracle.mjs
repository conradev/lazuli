import {
  buildGxMipUploadOraclePacket,
  gxMipUploadOracle,
  gxMipUploadOraclePacketLayout,
} from "./browser_boot_gx_mip_upload_oracle.mjs";
import {
  managedTexturedCoverageXfb,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";

// Nearest mip selection with a deliberately large negative GX LOD bias.
// MODE1's minimum then becomes the deterministic explicit level selector.
// Keeping the maximum at level two preserves one canonical three-level V7
// resource in every case.
const TEXTURE_MODE0 = 0x00010020;
const MAX_LOD_SIXTEENTHS = 2 * 16;
const TEXTURE_WIDTH = 4;
const TEXTURE_HEIGHT = 4;
const MODE1_BYTES = 8 * 4;
const PROBE_X = 2;
const PROBE_Y = 2;
const TEXTURE_LEVELS = Object.freeze([
  Object.freeze({ level: 0, width: 4, height: 4, offset: 0, bytes: 64 }),
  Object.freeze({ level: 1, width: 2, height: 2, offset: 64, bytes: 16 }),
  Object.freeze({ level: 2, width: 1, height: 1, offset: 80, bytes: 4 }),
]);
const TEXTURE_PAYLOAD_BYTES = 84;

const LEVEL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "explicit-mip-0-red",
    level: 0,
    color: Object.freeze([0xe1, 0x23, 0x45, 0xff]),
  }),
  Object.freeze({
    id: "explicit-mip-1-green",
    level: 1,
    color: Object.freeze([0x27, 0xd3, 0x69, 0xff]),
  }),
  Object.freeze({
    id: "explicit-mip-2-blue",
    level: 2,
    color: Object.freeze([0x3b, 0x71, 0xe7, 0xff]),
  }),
]);

function definitionFor(level) {
  if (!Number.isSafeInteger(level)) {
    throw new TypeError("GX mip color level must be an integer");
  }
  const definition = LEVEL_DEFINITIONS[level];
  if (definition === undefined) {
    throw new RangeError("GX mip color level must be 0, 1, or 2");
  }
  return definition;
}

function mode1ForLevel(level) {
  return (
    level * 16 |
    (MAX_LOD_SIXTEENTHS << 8)
  ) >>> 0;
}

function align16(value) {
  return (value + 15) & ~15;
}

export function gxMipColorOraclePacketLayout() {
  const base = gxMipUploadOraclePacketLayout(false);
  const pixelBytes = align16(TEXTURE_PAYLOAD_BYTES);
  const evidenceOffset = base.pixelOffset + pixelBytes;
  const mode1Offset = align16(evidenceOffset + 1);
  return Object.freeze({
    ...base,
    payloadBytes: TEXTURE_PAYLOAD_BYTES,
    pixelBytes,
    evidenceOffset,
    exactOffset: mode1Offset,
    mode1Offset,
    mode1Bytes: MODE1_BYTES,
    packetBytes: mode1Offset + MODE1_BYTES,
  });
}

function solidLevelPixels() {
  const pixels = new Uint8Array(TEXTURE_PAYLOAD_BYTES);
  for (const level of TEXTURE_LEVELS) {
    const color = LEVEL_DEFINITIONS[level.level].color;
    for (
      let offset = level.offset;
      offset < level.offset + level.bytes;
      offset += 4
    ) {
      pixels.set(color, offset);
    }
  }
  return pixels;
}

const TEXTURE_PIXELS = solidLevelPixels();

export function buildGxMipColorOraclePacket(
  level,
  generation = 1,
) {
  const definition = definitionFor(level);
  const base = buildGxMipUploadOraclePacket({ generation });
  const baseLayout = gxMipUploadOraclePacketLayout(false);
  const layout = gxMipColorOraclePacketLayout();
  const packet = new Uint8Array(layout.packetBytes);
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );

  packet.set(base.subarray(0, baseLayout.pixelOffset));
  packet.set(TEXTURE_PIXELS, layout.pixelOffset);
  packet[layout.evidenceOffset] = base[baseLayout.evidenceOffset];
  view.setUint32(0x08, layout.packetBytes, true);
  view.setUint32(0x48, layout.pixelBytes, true);
  view.setUint32(
    layout.drawOffset + 0x34,
    TEXTURE_MODE0,
    true,
  );
  view.setUint32(
    layout.textureOffset + 0x0c,
    TEXTURE_PAYLOAD_BYTES,
    true,
  );
  view.setUint32(
    layout.textureOffset + 0x18,
    TEXTURE_WIDTH,
    true,
  );
  view.setUint32(
    layout.textureOffset + 0x1c,
    TEXTURE_HEIGHT,
    true,
  );
  view.setUint32(
    layout.mode1Offset,
    mode1ForLevel(definition.level),
    true,
  );
  return packet;
}

export const gxMipColorOracleCases = Object.freeze(
  LEVEL_DEFINITIONS.map((definition) =>
    Object.freeze({
      ...definition,
      expectedProbeRgba: definition.color,
      mode0: TEXTURE_MODE0,
      mode1: mode1ForLevel(definition.level),
    }),
  ),
);

export const gxMipColorOracle = Object.freeze({
  packetVersion: gxMipUploadOracle.packetVersion,
  key: gxMipUploadOracle.key,
  width: TEXTURE_WIDTH,
  height: TEXTURE_HEIGHT,
  mipLevelCount: gxMipUploadOracle.mipLevelCount,
  payloadBytes: TEXTURE_PAYLOAD_BYTES,
  paddedPixelBytes: align16(TEXTURE_PAYLOAD_BYTES),
  levels: TEXTURE_LEVELS,
  mode0: TEXTURE_MODE0,
  maximumLodSixteenths: MAX_LOD_SIXTEENTHS,
  probe: Object.freeze({ x: PROBE_X, y: PROBE_Y }),
  xfb: managedTexturedCoverageXfb,
  expectedUpload: Object.freeze({
    resourceIdentities: 1,
    textureWrites: TEXTURE_LEVELS.length,
    textureUploadBytes: TEXTURE_PAYLOAD_BYTES,
    packetPayloadBytes: TEXTURE_PAYLOAD_BYTES,
  }),
});

export const gxMipColorOraclePixels =
  Uint8Array.from(TEXTURE_PIXELS);
