import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGxMipColorOraclePacket,
  gxMipColorOracle,
  gxMipColorOracleCases,
  gxMipColorOraclePacketLayout,
  gxMipColorOraclePixels,
} from "./browser_boot_gx_mip_color_oracle.mjs";

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

test("builds three canonical V7 explicit-mip selection packets", () => {
  const layout = gxMipColorOraclePacketLayout();

  for (const entry of gxMipColorOracleCases) {
    const packet = buildGxMipColorOraclePacket(
      entry.level,
      0x11223340 + entry.level,
    );

    assert.equal(u16(packet, 0x04), 7);
    assert.equal(u32(packet, 0x08), packet.length);
    assert.equal(u32(packet, 0x48), 96);
    assert.equal(u32(packet, 0x6c), 0x11223340 + entry.level);
    assert.equal(
      u32(packet, layout.drawOffset + 0x34),
      gxMipColorOracle.mode0,
    );
    assert.equal(
      u32(packet, layout.mode1Offset),
      entry.mode1,
    );
    assert.equal(entry.mode1 & 0xff, entry.level * 16);
    assert.equal(
      (entry.mode1 >>> 8) & 0xff,
      gxMipColorOracle.maximumLodSixteenths,
    );
    assert.equal(u32(packet, layout.textureOffset + 0x0c), 84);
    assert.equal(u32(packet, layout.textureOffset + 0x18), 4);
    assert.equal(u32(packet, layout.textureOffset + 0x1c), 4);
    assert.equal(u32(packet, layout.textureOffset + 0x24), 3);
    assert.deepEqual(
      Array.from(
        packet.subarray(
          layout.pixelOffset,
          layout.pixelOffset + gxMipColorOracle.payloadBytes,
        ),
      ),
      Array.from(gxMipColorOraclePixels),
    );
    assert.deepEqual(
      Array.from(
        packet.subarray(
          layout.pixelOffset + gxMipColorOracle.payloadBytes,
          layout.evidenceOffset,
        ),
      ),
      Array(12).fill(0),
    );
    assert.equal(packet[layout.evidenceOffset], 0x0f);
  }
});

test("pins one solid and distinct RGBA color in every mip level", () => {
  const colors = new Set();
  for (const entry of gxMipColorOracleCases) {
    const layout = gxMipColorOracle.levels[entry.level];
    const levelPixels = gxMipColorOraclePixels.subarray(
      layout.offset,
      layout.offset + layout.bytes,
    );
    for (let offset = 0; offset < levelPixels.length; offset += 4) {
      assert.deepEqual(
        Array.from(levelPixels.subarray(offset, offset + 4)),
        entry.color,
      );
    }
    colors.add(entry.color.join(","));
  }
  assert.equal(colors.size, gxMipColorOracle.mipLevelCount);
});

test("uses a nearest-mip negative-bias selector with a stable probe", () => {
  assert.equal((gxMipColorOracle.mode0 >>> 5) & 7, 1);
  assert.equal((gxMipColorOracle.mode0 >>> 9) & 0xff, 0x80);
  assert.deepEqual(gxMipColorOracle.probe, { x: 2, y: 2 });
  assert.ok(gxMipColorOracle.probe.x < gxMipColorOracle.xfb.width);
  assert.ok(gxMipColorOracle.probe.y < gxMipColorOracle.xfb.height);
});

test("rejects levels outside the three-level oracle chain", () => {
  assert.throws(
    () => buildGxMipColorOraclePacket(0.5),
    /level must be an integer/,
  );
  assert.throws(
    () => buildGxMipColorOraclePacket(-1),
    /level must be 0, 1, or 2/,
  );
  assert.throws(
    () => buildGxMipColorOraclePacket(3),
    /level must be 0, 1, or 2/,
  );
});
