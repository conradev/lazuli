import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGxMipUploadOraclePacket,
  gxMipUploadOracle,
  gxMipUploadOraclePacketLayout,
  gxMipUploadOraclePixels,
} from "./browser_boot_gx_mip_upload_oracle.mjs";

function u16(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(offset, true);
}

function u32(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function textureIdentity(packet, layout) {
  const key = new TextDecoder().decode(
    packet.subarray(
      layout.keyOffset,
      layout.keyOffset + layout.keyBytes,
    ),
  );
  return {
    key,
    width: u32(packet, layout.textureOffset + 0x18),
    height: u32(packet, layout.textureOffset + 0x1c),
    mipLevelCount: u32(packet, layout.textureOffset + 0x24),
  };
}

test("builds one canonical NPOT v7 mip resource with tight decoded levels", () => {
  const layout = gxMipUploadOraclePacketLayout(false);
  const packet = buildGxMipUploadOraclePacket({
    generation: 0x12345678,
  });

  assert.deepEqual(Array.from(packet.subarray(0, 4)), [
    0x4c, 0x5a, 0x47, 0x58,
  ]);
  assert.equal(u16(packet, 0x04), 7);
  assert.equal(u16(packet, 0x06), 160);
  assert.equal(u32(packet, 0x08), packet.length);
  assert.equal(u32(packet, 0x14), 1);
  assert.equal(u32(packet, 0x18), 1);
  assert.equal(u32(packet, 0x48), 80);
  assert.equal(u32(packet, 0x6c), 0x12345678);
  assert.deepEqual(textureIdentity(packet, layout), {
    key: gxMipUploadOracle.key,
    width: 5,
    height: 3,
    mipLevelCount: 3,
  });

  assert.equal(u32(packet, layout.drawOffset + 0x30), 0);
  assert.equal(
    u32(packet, layout.drawOffset + 0x34),
    gxMipUploadOracle.mode0,
  );
  for (let map = 1; map < 8; map += 1) {
    assert.equal(
      u32(packet, layout.drawOffset + 0x30 + map * 8),
      0xffffffff,
    );
    assert.equal(
      u32(packet, layout.drawOffset + 0x34 + map * 8),
      0,
    );
  }

  assert.equal(u32(packet, layout.textureOffset + 0x08), 0);
  assert.equal(
    u32(packet, layout.textureOffset + 0x0c),
    gxMipUploadOracle.payloadBytes,
  );
  assert.equal(u32(packet, layout.textureOffset + 0x20), 1);
  assert.deepEqual(
    Array.from(
      packet.subarray(
        layout.pixelOffset,
        layout.pixelOffset + gxMipUploadOracle.payloadBytes,
      ),
    ),
    Array.from(gxMipUploadOraclePixels),
  );
  assert.deepEqual(
    Array.from(
      packet.subarray(
        layout.pixelOffset + gxMipUploadOracle.payloadBytes,
        layout.evidenceOffset,
      ),
    ),
    Array(8).fill(0),
  );
  assert.equal(packet[layout.evidenceOffset], 0x0f);
  assert.deepEqual(
    Array.from(
      packet.subarray(
        layout.evidenceOffset + 1,
        layout.mode1Offset,
      ),
    ),
    Array(layout.mode1Offset - layout.evidenceOffset - 1).fill(0),
  );
  assert.equal(
    u32(packet, layout.mode1Offset),
    gxMipUploadOracle.mode1,
  );
  assert.deepEqual(
    Array.from(
      packet.subarray(layout.mode1Offset + 4, layout.packetBytes),
    ),
    Array(28).fill(0),
  );

  for (const level of gxMipUploadOracle.levels) {
    const actual = packet.subarray(
      layout.pixelOffset + level.offset,
      layout.pixelOffset + level.offset + level.bytes,
    );
    assert.deepEqual(
      Array.from(actual),
      Array.from(
        gxMipUploadOraclePixels.subarray(
          level.offset,
          level.offset + level.bytes,
        ),
      ),
      `level ${level.level} must stay tightly packed`,
    );
  }
});

test("resident resubmit keeps one exact identity and omits all pixel bytes", () => {
  const firstLayout = gxMipUploadOraclePacketLayout(false);
  const first = buildGxMipUploadOraclePacket({
    generation: 9,
  });
  const residentLayout = gxMipUploadOraclePacketLayout(true);
  const resident = buildGxMipUploadOraclePacket({
    generation: 10,
    resident: true,
  });

  assert.deepEqual(
    textureIdentity(resident, residentLayout),
    textureIdentity(first, firstLayout),
  );
  assert.equal(u16(resident, 0x04), 7);
  assert.equal(u32(resident, 0x48), 0);
  assert.equal(u32(resident, residentLayout.textureOffset + 0x08), 0);
  assert.equal(u32(resident, residentLayout.textureOffset + 0x0c), 0);
  assert.equal(u32(resident, residentLayout.textureOffset + 0x20), 0);
  assert.equal(
    u32(resident, residentLayout.drawOffset + 0x34),
    gxMipUploadOracle.mode0,
  );
  assert.equal(
    u32(resident, residentLayout.mode1Offset),
    gxMipUploadOracle.mode1,
  );
  assert.equal(
    resident[residentLayout.evidenceOffset],
    first[firstLayout.evidenceOffset],
  );
  assert.ok(resident.length < first.length);
  assert.deepEqual(
    buildGxMipUploadOraclePacket({
      generation: 10,
      resident: true,
    }),
    resident,
  );
});

test("rejects noncanonical oracle options", () => {
  assert.throws(
    () => buildGxMipUploadOraclePacket({ generation: -1 }),
    /generation must be a u32/,
  );
  assert.throws(
    () => buildGxMipUploadOraclePacket({ generation: 2 ** 32 }),
    /generation must be a u32/,
  );
  assert.throws(
    () => buildGxMipUploadOraclePacket({ resident: 1 }),
    /resident state must be boolean/,
  );
  assert.throws(
    () => gxMipUploadOraclePacketLayout("yes"),
    /resident state must be boolean/,
  );
});
