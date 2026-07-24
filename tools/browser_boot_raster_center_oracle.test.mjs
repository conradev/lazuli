import assert from "node:assert/strict";
import test from "node:test";

import {
  GX_RASTER_CENTER,
  RASTER_ALWAYS_PASS,
  RASTER_ALWAYS_UPDATE,
  RASTER_BLEND_ADDITIVE_ONE_ONE,
  RASTER_BLEND_REPLACE,
  RASTER_EQUAL_NO_UPDATE,
  buildRasterCenterOraclePacket,
  rasterCenterOracleCases,
  rasterCenterOraclePixel,
  rasterCenterOracleXfb,
} from "./browser_boot_raster_center_oracle.mjs";

function packetView(packet) {
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
}

function u16(packet, offset) {
  return packetView(packet).getUint16(offset, true);
}

function u32(packet, offset) {
  return packetView(packet).getUint32(offset, true);
}

function f32(packet, offset) {
  return packetView(packet).getFloat32(offset, true);
}

test("raster-center oracle emits deterministic canonical texture-free LZGX v3", () => {
  const diagonal = rasterCenterOracleCases[3];
  const packet = buildRasterCenterOraclePacket(diagonal.draws, 29);
  assert.deepEqual(
    packet,
    buildRasterCenterOraclePacket(diagonal.draws, 29),
    "the same oracle vector must be byte-for-byte reproducible",
  );
  assert.deepEqual([...packet.slice(0, 4)], [...Buffer.from("LZGX")]);
  assert.equal(u16(packet, 0x04), 3);
  assert.equal(u16(packet, 0x06), 160);
  assert.equal(u32(packet, 0x08), packet.length);
  assert.equal(u32(packet, 0x10), 2);
  assert.equal(u32(packet, 0x14), 2);
  assert.equal(u32(packet, 0x18), 0);
  assert.equal(u32(packet, 0x34), 2 * 176);
  assert.equal(u32(packet, 0x38), 0);
  assert.equal(u32(packet, 0x3c), 2 * 464);
  assert.equal(u32(packet, 0x40), 7 * 144);
  assert.equal(u32(packet, 0x44), 0);
  assert.equal(u32(packet, 0x48), 0);
  assert.equal(u32(packet, 0x54), 4);
  assert.equal(u32(packet, 0x58), 4);
  assert.equal(u32(packet, 0x5c), 4);
  assert.equal(u32(packet, 0x60), 4);
  assert.equal(u32(packet, 0x64), rasterCenterOracleXfb.destination);
  assert.equal(u32(packet, 0x68), rasterCenterOracleXfb.stride);
  assert.equal(u32(packet, 0x6c), 29);
  assert.equal(u16(packet, 0x78), 176);
  assert.equal(u16(packet, 0x7a), 64);
  assert.equal(u32(packet, 0x7c), 7);
  assert.equal(u32(packet, 0x8c), 0x4003);
  assert.equal(u32(packet, 0x94), 256);

  const writer = 160;
  const probe = writer + 176;
  assert.equal(packet[writer], 0);
  assert.equal(packet[writer + 1], 0);
  assert.equal(u32(packet, writer + 0x04), 4);
  assert.equal(u32(packet, writer + 0x08), 0);
  assert.equal(u32(packet, writer + 0x0c), 0);
  assert.equal(u32(packet, writer + 0x10), RASTER_ALWAYS_UPDATE);
  assert.equal(u32(packet, writer + 0x14), RASTER_BLEND_REPLACE);
  assert.equal(u32(packet, writer + 0x18), RASTER_ALWAYS_PASS);
  assert.deepEqual(
    [
      u32(packet, writer + 0x1c),
      u32(packet, writer + 0x20),
      u32(packet, writer + 0x24),
      u32(packet, writer + 0x28),
    ],
    [0, 0, 4, 4],
  );
  assert.equal(packet[probe], 2);
  assert.equal(u32(packet, probe + 0x04), 3);
  assert.equal(u32(packet, probe + 0x08), 4 * 144);
  assert.equal(u32(packet, probe + 0x0c), 464);
  assert.equal(u32(packet, probe + 0x10), RASTER_EQUAL_NO_UPDATE);
  assert.deepEqual(
    [
      u32(packet, probe + 0x1c),
      u32(packet, probe + 0x20),
      u32(packet, probe + 0x24),
      u32(packet, probe + 0x28),
    ],
    [2, 1, 1, 1],
  );

  for (const record of [writer, probe]) {
    for (let map = 0; map < 8; map += 1) {
      assert.equal(u32(packet, record + 0x30 + map * 8), 0xffffffff);
      assert.equal(u32(packet, record + 0x34 + map * 8), 0);
    }
    assert.equal(u32(packet, record + 0x70), 0);
    assert.equal(u32(packet, record + 0x74), 0);
    assert.equal(u32(packet, record + 0x78), 0);
    assert.equal(u32(packet, record + 0x7c), 0);
  }

  const vertexOffset = u32(packet, 0x28);
  const expectedWriter = [
    [0, 0, 0.25],
    [4, 0, 0.25],
    [4, 4, 480.25],
    [0, 4, 0.25],
  ];
  for (let index = 0; index < expectedWriter.length; index += 1) {
    const offset = vertexOffset + index * 144;
    assert.deepEqual(
      [f32(packet, offset), f32(packet, offset + 4), f32(packet, offset + 8)],
      expectedWriter[index],
    );
    assert.equal(f32(packet, offset + 12), 1);
  }
  for (let index = 4; index < 7; index += 1) {
    assert.equal(f32(packet, vertexOffset + index * 144 + 8), 190);
  }
});

test("raster-center vectors pin coverage interpolation seams and quad expansion", () => {
  assert.equal(GX_RASTER_CENTER, 7 / 12);
  assert.deepEqual(
    rasterCenterOracleCases.map(({ name }) => name),
    [
      "GX 7/12 center covers x=13/24",
      "GX 7/12 center evaluates 94.25+12x as Equal Z101",
      "topology-0 additive 012/023 seam shades once",
      "topology-0 canonical 012/023 diagonal compares Equal Z190",
    ],
  );

  const coverage = rasterCenterOracleCases[0];
  assert.equal(coverage.draws.length, 1);
  assert.equal(coverage.draws[0].topology, 0);
  assert.deepEqual(
    coverage.draws[0].vertices.map(({ x, y }) => [x, y]),
    [
      [13 / 24, -1],
      [1, -1],
      [1, 1],
      [13 / 24, 1],
    ],
  );
  assert.deepEqual(rasterCenterOraclePixel(coverage.expectedRgba, 0, 0), [
    255, 255, 255, 255,
  ]);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      if (x !== 0 || y !== 0) {
        assert.deepEqual(
          rasterCenterOraclePixel(coverage.expectedRgba, x, y),
          [0, 0, 0, 255],
        );
      }
    }
  }

  const centerDepth = rasterCenterOracleCases[1];
  assert.equal(centerDepth.draws[0].topology, 2);
  assert.deepEqual(
    centerDepth.draws[0].vertices.map(({ x, depth24 }) => [x, depth24]),
    [
      [0, 94.25],
      [1280, 94.25 + 12 * 1280],
      [0, 94.25],
    ],
  );
  assert.equal(
    Math.trunc(94.25 + 12 * GX_RASTER_CENTER),
    101,
    "the GX source-space sample must truncate to Z101",
  );
  assert.equal(
    Math.trunc(94.25 + 12 * 0.5),
    100,
    "the uncorrected WebGPU sample must truncate to the adjacent Z100",
  );
  assert.equal(centerDepth.draws[0].zMode, RASTER_ALWAYS_UPDATE);
  assert.equal(centerDepth.draws[1].zMode, RASTER_EQUAL_NO_UPDATE);
  assert.deepEqual(centerDepth.draws[1].scissor, {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  assert.deepEqual(rasterCenterOraclePixel(centerDepth.expectedRgba, 0, 0), [
    255, 255, 255, 255,
  ]);

  const seam = rasterCenterOracleCases[2];
  assert.equal(seam.draws.length, 1);
  assert.equal(seam.draws[0].topology, 0);
  assert.equal(seam.draws[0].vertices.length, 4);
  assert.equal(
    seam.draws[0].blendMode,
    RASTER_BLEND_ADDITIVE_ONE_ONE,
  );
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      assert.deepEqual(
        rasterCenterOraclePixel(seam.expectedRgba, x, y),
        [64, 0, 0, 255],
      );
    }
    assert.deepEqual(
      rasterCenterOraclePixel(seam.expectedRgba, y, y),
      [64, 0, 0, 255],
      "the 012/023 diagonal must be neither a zero-fill crack nor a 128 overlap",
    );
  }

  const diagonal = rasterCenterOracleCases[3];
  assert.equal(diagonal.draws[0].topology, 0);
  assert.deepEqual(
    diagonal.draws[0].vertices.map(({ depth24 }) => depth24),
    [0.25, 0.25, 480.25, 0.25],
  );
  assert.equal(
    Math.trunc(0.25 + (120 * (12 + 7)) / 12),
    190,
    `pixel (2,1) truncates 0.25+min(x,y)*120 at original y=1+${GX_RASTER_CENTER}`,
  );
  assert.equal(
    Math.trunc(0.25 + 120 * 1.5),
    180,
    "the uncorrected WebGPU sample must remain ten depth units away",
  );
  assert.deepEqual(diagonal.draws[1].scissor, {
    x: 2,
    y: 1,
    width: 1,
    height: 1,
  });
  assert.deepEqual(rasterCenterOraclePixel(diagonal.expectedRgba, 2, 1), [
    255, 255, 255, 255,
  ]);
  assert.equal(diagonal.expectedRgba.length, 4 * 4 * 4);
});

test("every raster-center case has an exact 4x4 packet and 64-byte oracle", () => {
  for (let index = 0; index < rasterCenterOracleCases.length; index += 1) {
    const entry = rasterCenterOracleCases[index];
    const generation = index + 1;
    const packet = buildRasterCenterOraclePacket(entry.draws, generation);
    assert.deepEqual(
      packet,
      buildRasterCenterOraclePacket(entry.draws, generation),
      entry.name,
    );
    assert.equal(u32(packet, 0x14), entry.draws.length);
    assert.equal(
      u32(packet, 0x7c),
      entry.draws.reduce((sum, draw) => sum + draw.vertices.length, 0),
    );
    assert.equal(entry.expectedRgba.length, 64);
  }
});
