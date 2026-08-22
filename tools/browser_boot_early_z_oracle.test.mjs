import assert from "node:assert/strict";
import test from "node:test";

import {
  EARLY_Z_ALPHA_GREATER_127,
  EARLY_Z_ALWAYS_FAIL,
  EARLY_Z_ALWAYS_PASS,
  EARLY_Z_EQUAL_UPDATE,
  EARLY_Z_LESS_UPDATE,
  EARLY_Z_PIXEL_CONTROL,
  buildEarlyZOraclePacket,
  earlyZOracleCases,
  fullscreenTriangle,
} from "./browser_boot_early_z_oracle.mjs";

function u16(packet, offset) {
  return new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  ).getUint16(offset, true);
}

function u32(packet, offset) {
  return new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  ).getUint32(offset, true);
}

test("early-Z oracle emits a canonical texture-free LZGX v3 packet", () => {
  const draws = [
    {
      vertices: fullscreenTriangle(0x123456, [0, 1, 0, 0]),
      zMode: EARLY_Z_LESS_UPDATE,
      alphaTest: EARLY_Z_ALWAYS_FAIL,
      pixelControl: EARLY_Z_PIXEL_CONTROL,
    },
    {
      vertices: fullscreenTriangle(0xabcdef, [1, 0, 0, 1]),
      zMode: EARLY_Z_LESS_UPDATE,
      alphaTest: EARLY_Z_ALWAYS_PASS,
      pixelControl: EARLY_Z_PIXEL_CONTROL,
    },
  ];
  const packet = buildEarlyZOraclePacket(draws, 7);
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
  assert.equal(u32(packet, 0x40), 6 * 144);
  assert.equal(u32(packet, 0x44), 0);
  assert.equal(u32(packet, 0x48), 0);
  assert.equal(u32(packet, 0x6c), 7);
  assert.equal(u16(packet, 0x78), 176);
  assert.equal(u16(packet, 0x7a), 64);
  assert.equal(u32(packet, 0x7c), 6);
  assert.equal(u32(packet, 0x8c), 0x4003);
  assert.equal(u32(packet, 0x94), 256);

  const first = 160;
  const second = first + 176;
  assert.equal(packet[first], 2);
  assert.equal(u32(packet, first + 0x04), 3);
  assert.equal(u32(packet, first + 0x08), 0);
  assert.equal(u32(packet, first + 0x0c), 0);
  assert.equal(u32(packet, first + 0x10), EARLY_Z_LESS_UPDATE);
  assert.equal(u32(packet, first + 0x18), EARLY_Z_ALWAYS_FAIL);
  assert.equal(u32(packet, first + 0x70), EARLY_Z_PIXEL_CONTROL);
  assert.equal(u32(packet, second + 0x04), 3);
  assert.equal(u32(packet, second + 0x08), 3 * 144);
  assert.equal(u32(packet, second + 0x0c), 464);
  assert.equal(u32(packet, second + 0x18), EARLY_Z_ALWAYS_PASS);
  for (const record of [first, second]) {
    for (let map = 0; map < 8; map += 1) {
      assert.equal(u32(packet, record + 0x30 + map * 8), 0xffffffff);
      assert.equal(u32(packet, record + 0x34 + map * 8), 0);
    }
  }
});

test("early-Z oracle includes the alpha, update, Z-texture, ordering, and compare controls", () => {
  assert.deepEqual(
    earlyZOracleCases.map(({ name, expected }) => ({ name, expected })),
    [
      {
        name: "early alpha failure commits source depth",
        expected: [0, 0, 0, 255],
      },
      {
        name: "late alpha failure leaves depth untouched",
        expected: [255, 0, 0, 255],
      },
      {
        name: "early alpha failure with Z updates disabled leaves depth untouched",
        expected: [255, 0, 0, 255],
      },
      {
        name: "early Z-texture commits raster depth rather than replacement depth",
        expected: [255, 0, 0, 255],
      },
      {
        name: "one draw commits each expanded primitive before the next color attempt",
        expected: [0, 0, 0, 255],
      },
      {
        name: "paired early-depth commit is invariant for a coplanar Equal probe",
        expected: [0, 255, 0, 255],
      },
      {
        name: "early NotEqual alpha failure commits before a later Less draw",
        expected: [0, 0, 0, 255],
      },
    ],
  );
  const ordered = earlyZOracleCases[4].draws[0];
  assert.equal(ordered.vertices.length, 6);
  assert.equal(ordered.alphaTest, EARLY_Z_ALPHA_GREATER_127);
  const invariant = earlyZOracleCases[5];
  assert.equal(invariant.draws[0].alphaTest, EARLY_Z_ALPHA_GREATER_127);
  assert.equal(invariant.draws[1].zMode, EARLY_Z_EQUAL_UPDATE);
});
