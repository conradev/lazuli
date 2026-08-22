import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildGxMipFractionalOraclePacket,
  gxMipFractionalOracle,
  gxMipFractionalOracleCases,
  gxMipFractionalOraclePacketLayout,
  gxMipFractionalOraclePixels,
} from "./browser_boot_gx_mip_fractional_oracle.mjs";

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

function f32(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getFloat32(offset, true);
}

test("builds strict V7 packets with fractional MODE1 minima", () => {
  const layout = gxMipFractionalOraclePacketLayout();
  for (const entry of gxMipFractionalOracleCases) {
    const generation = 0x22000000 + entry.lodSixteenths;
    const packet = buildGxMipFractionalOraclePacket(
      entry.lodSixteenths,
      generation,
    );
    assert.equal(u16(packet, 0x04), 7);
    assert.equal(u32(packet, 0x08), packet.length);
    assert.equal(u32(packet, 0x48), 96);
    assert.equal(u32(packet, 0x6c), generation);
    assert.equal(
      u32(packet, layout.drawOffset + 0x34),
      gxMipFractionalOracle.mode0,
    );
    assert.equal(u32(packet, layout.mode1Offset), entry.mode1);
    assert.equal(entry.mode1 & 0xff, entry.lodSixteenths);
    assert.equal(
      (entry.mode1 >>> 8) & 0xff,
      gxMipFractionalOracle.maximumLodSixteenths,
    );
    assert.equal(u32(packet, layout.textureOffset + 0x0c), 84);
    assert.equal(u32(packet, layout.textureOffset + 0x18), 4);
    assert.equal(u32(packet, layout.textureOffset + 0x1c), 4);
    assert.equal(u32(packet, layout.textureOffset + 0x24), 3);
    assert.deepEqual(
      Array.from(
        packet.subarray(
          layout.pixelOffset,
          layout.pixelOffset + gxMipFractionalOracle.payloadBytes,
        ),
      ),
      Array.from(gxMipFractionalOraclePixels),
    );

    for (let vertex = 0; vertex < 4; vertex += 1) {
      const coordinateOffset =
        layout.vertexOffset + vertex * 36 * 4 + 12 * 4;
      assert.deepEqual(
        [0, 1, 2].map(component =>
          f32(packet, coordinateOffset + component * 4),
        ),
        gxMipFractionalOracle.coordinate,
      );
    }
  }
});

test("pins the GX half-texel bilinear coordinates and 7-bit weights", () => {
  assert.equal(gxMipFractionalOracle.minificationMode, 6);
  assert.deepEqual(gxMipFractionalOracle.fixedCoordinate, [163, 227]);
  assert.deepEqual(
    gxMipFractionalOracle.coordinate,
    [163 / 128, 227 / 128, 1],
  );
  assert.deepEqual(
    gxMipFractionalOracle.bilinearLevels[0],
    {
      level: 0,
      levelFixedCoordinate: [163, 227],
      halfTexelCenteredCoordinate: [99, 163],
      baseCoordinate: [0, 1],
      fraction128ths: [99, 35],
      coordinates: [[0, 1], [1, 1], [0, 2], [1, 2]],
      weights: [2697, 9207, 1015, 3465],
      weightDenominator: 16384,
      rgba: [147, 98, 110, 255],
    },
  );
  assert.deepEqual(
    gxMipFractionalOracle.bilinearLevels[1],
    {
      level: 1,
      levelFixedCoordinate: [81, 113],
      halfTexelCenteredCoordinate: [17, 49],
      baseCoordinate: [0, 0],
      fraction128ths: [17, 49],
      coordinates: [[0, 0], [1, 0], [0, 1], [1, 1]],
      weights: [8769, 1343, 5439, 833],
      weightDenominator: 16384,
      rgba: [188, 67, 139, 255],
    },
  );
  for (const level of gxMipFractionalOracle.bilinearLevels) {
    assert.equal(
      level.weights.reduce((sum, value) => sum + value, 0),
      level.weightDenominator,
    );
    assert.ok(
      level.fraction128ths.every(value => (value & 15) !== 0),
      "both bilinear phases must exercise precision below four bits",
    );
  }
});

test("pins exact 4-bit trilinear blend results and full XFB hashes", () => {
  assert.deepEqual(
    gxMipFractionalOracleCases.map(entry => ({
      lod: entry.lodSixteenths,
      rgba: entry.expectedProbeRgba,
      fnv: entry.expectedRgbaFnv1a64,
    })),
    [
      {
        lod: 0,
        rgba: [147, 98, 110, 255],
        fnv: "0x239cc364ec262745",
      },
      {
        lod: 1,
        rgba: [149, 96, 111, 255],
        fnv: "0xb0c0df75a93ba345",
      },
      {
        lod: 2,
        rgba: [152, 94, 113, 255],
        fnv: "0xcc3cfa4d472c2105",
      },
      {
        lod: 3,
        rgba: [154, 92, 115, 255],
        fnv: "0xcb587b3c9eac9225",
      },
      {
        lod: 4,
        rgba: [157, 90, 117, 255],
        fnv: "0x8f37a2d8f28502e5",
      },
      {
        lod: 5,
        rgba: [159, 88, 119, 255],
        fnv: "0xcd7f69726693f825",
      },
      {
        lod: 6,
        rgba: [162, 86, 120, 255],
        fnv: "0x2e356991756c2c45",
      },
      {
        lod: 7,
        rgba: [164, 84, 122, 255],
        fnv: "0x5ffd834bd257f645",
      },
      {
        lod: 8,
        rgba: [167, 82, 124, 255],
        fnv: "0x7dda7c4a84bb9ba5",
      },
      {
        lod: 9,
        rgba: [170, 80, 126, 255],
        fnv: "0xdc5cb256dcd7a925",
      },
      {
        lod: 10,
        rgba: [172, 78, 128, 255],
        fnv: "0xb0e3475d55260ce5",
      },
      {
        lod: 11,
        rgba: [175, 76, 129, 255],
        fnv: "0xfd068f5aad7db105",
      },
      {
        lod: 12,
        rgba: [177, 74, 131, 255],
        fnv: "0x11f805c0b3a8ffc5",
      },
      {
        lod: 13,
        rgba: [180, 72, 133, 255],
        fnv: "0x69f63c72df46b225",
      },
      {
        lod: 14,
        rgba: [182, 70, 135, 255],
        fnv: "0x5a1387aefc852485",
      },
      {
        lod: 15,
        rgba: [185, 68, 137, 255],
        fnv: "0xe5e8c6681774c1a5",
      },
      {
        lod: 16,
        rgba: [188, 67, 139, 255],
        fnv: "0xc5a50baf0da985e5",
      },
    ],
  );
  assert.deepEqual(
    gxMipFractionalOracleCases.map(entry => entry.lodSixteenths),
    Array.from({ length: 17 }, (_, fraction) => fraction),
  );
  for (const entry of gxMipFractionalOracleCases) {
    assert.equal(entry.expectedRgba.length, 4 * 4 * 4);
    assert.notDeepEqual(
      entry.expectedProbeRgba,
      entry.nearestCoordinateComparisonRgba,
    );
    assert.notEqual(
      entry.expectedRgbaFnv1a64,
      entry.nonUniformCoverageComparisonRgbaFnv1a64,
    );
  }
  assert.equal(gxMipFractionalOracle.coverageMask, 0xffff);
  assert.equal(
    gxMipFractionalOracle.nonUniformCoverageComparisonMask,
    0xeeee,
  );
  assert.deepEqual(
    Object.keys(gxMipFractionalOracle.expectedUpload).sort(),
    [
      "managedCoverageDraws",
      "managedCoverageTriangles",
      "packetPayloadBytes",
      "textureUploadBytes",
      "textureWrites",
    ],
  );
  assert.equal(
    "resourceIdentities" in gxMipFractionalOracle.expectedUpload,
    false,
  );
});

test("reference model stays coupled to the current manual GX sampler", () => {
  const samplerSource = readFileSync(
    new URL("../crates/browser-renderer/src/tev.rs", import.meta.url),
    "utf8",
  );
  assert.match(samplerSource, /let s = level_s - 64;/);
  assert.match(samplerSource, /let fract_s = u32\(s & 0x7f\);/);
  assert.match(samplerSource, /let weight00 = inverse_s \* inverse_t;/);
  assert.match(
    samplerSource,
    /filtered >> vec4<u32>\(14u\)/,
  );
  assert.match(
    samplerSource,
    /next \* vec4<u32>\(fractional_lod\)\) >> vec4<u32>\(4u\)/,
  );
});

test("rejects fractional clamps outside one mip interval", () => {
  assert.throws(
    () => buildGxMipFractionalOraclePacket(0.5),
    /integer number of sixteenths/,
  );
  assert.throws(
    () => buildGxMipFractionalOraclePacket(-1),
    /between 0 and 16/,
  );
  assert.throws(
    () => buildGxMipFractionalOraclePacket(17),
    /between 0 and 16/,
  );
});
