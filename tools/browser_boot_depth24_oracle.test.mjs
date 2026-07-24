import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPTH24_ALWAYS_FAIL,
  DEPTH24_ALWAYS_PASS,
  DEPTH24_ALWAYS_UPDATE,
  DEPTH24_EARLY_PIXEL_CONTROL,
  DEPTH24_EQUAL_UPDATE,
  buildDepth24OraclePacket,
  depth24OracleCases,
  fullscreenDepth24Triangle,
  uniformDepth24OracleRgba,
} from "./browser_boot_depth24_oracle.mjs";

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

test("depth24 oracle emits deterministic canonical texture-free LZGX v3 packets", () => {
  const draws = [
    {
      vertices: fullscreenDepth24Triangle(100.25, [0, 0, 0, 1]),
      zMode: DEPTH24_ALWAYS_UPDATE,
      alphaTest: DEPTH24_ALWAYS_PASS,
      pixelControl: 0,
    },
    {
      vertices: fullscreenDepth24Triangle(100.75, [1, 1, 1, 1]),
      zMode: DEPTH24_EQUAL_UPDATE,
      alphaTest: DEPTH24_ALWAYS_PASS,
      pixelControl: 0,
    },
  ];
  const packet = buildDepth24OraclePacket(draws, 23);
  assert.deepEqual(
    packet,
    buildDepth24OraclePacket(draws, 23),
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
  assert.equal(u32(packet, 0x40), 6 * 144);
  assert.equal(u32(packet, 0x44), 0);
  assert.equal(u32(packet, 0x48), 0);
  assert.equal(u32(packet, 0x6c), 23);
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
  assert.equal(u32(packet, first + 0x10), DEPTH24_ALWAYS_UPDATE);
  assert.equal(u32(packet, second + 0x04), 3);
  assert.equal(u32(packet, second + 0x08), 3 * 144);
  assert.equal(u32(packet, second + 0x0c), 464);
  assert.equal(u32(packet, second + 0x10), DEPTH24_EQUAL_UPDATE);
  for (const record of [first, second]) {
    for (let map = 0; map < 8; map += 1) {
      assert.equal(u32(packet, record + 0x30 + map * 8), 0xffffffff);
      assert.equal(u32(packet, record + 0x34 + map * 8), 0);
    }
  }

  const vertexOffset = u32(packet, 0x28);
  const firstDepth = f32(packet, vertexOffset + 8);
  const secondDepth = f32(packet, vertexOffset + 3 * 144 + 8);
  assert.equal(firstDepth, 100.25);
  assert.equal(secondDepth, 100.75);
  assert.notEqual(firstDepth, Math.round(firstDepth));
  assert.notEqual(secondDepth, Math.round(secondDepth));
});

test("depth24 oracle brackets canonical truncation and early alpha order", () => {
  assert.deepEqual(
    depth24OracleCases.map(({ name, expected }) => ({ name, expected })),
    [
      {
        name: "100.25 store then 100.75 Equal truncates to white",
        expected: [255, 255, 255, 255],
      },
      {
        name: "100.99 store then 101.01 Equal crosses the integer to black",
        expected: [0, 0, 0, 255],
      },
      {
        name: "early alpha failure commits canonical Z24 before Equal",
        expected: [255, 255, 255, 255],
      },
      {
        name: "exact integer Z24 values compare Equal",
        expected: [255, 255, 255, 255],
      },
      {
        name: "adjacent exact integer Z24 values do not compare Equal",
        expected: [0, 0, 0, 255],
      },
      {
        name: "late alpha failure does not commit canonical Z24",
        expected: [0, 0, 0, 255],
      },
      {
        name: "early Z16 linear bucket commits and compares Equal",
        expected: [255, 255, 255, 255],
      },
      {
        name: "Z16 linear adjacent buckets do not compare Equal",
        expected: [0, 0, 0, 255],
      },
      {
        name: "early Z16 near bucket commits and compares Equal",
        expected: [255, 255, 255, 255],
      },
      {
        name: "Z16 near adjacent buckets do not compare Equal",
        expected: [0, 0, 0, 255],
      },
      {
        name: "early Z16 mid bucket commits and compares Equal",
        expected: [255, 255, 255, 255],
      },
      {
        name: "Z16 mid adjacent buckets do not compare Equal",
        expected: [0, 0, 0, 255],
      },
      {
        name: "early Z16 far bucket commits and compares Equal",
        expected: [255, 255, 255, 255],
      },
      {
        name: "Z16 far adjacent buckets do not compare Equal",
        expected: [0, 0, 0, 255],
      },
    ],
  );
  const early = depth24OracleCases[2].draws[0];
  assert.equal(early.alphaTest, DEPTH24_ALWAYS_FAIL);
  assert.equal(early.pixelControl, DEPTH24_EARLY_PIXEL_CONTROL);
  assert.equal(early.zMode, DEPTH24_ALWAYS_UPDATE);
  assert.equal(depth24OracleCases[2].draws[1].zMode, DEPTH24_EQUAL_UPDATE);
  assert.equal(depth24OracleCases[5].draws[0].pixelControl, 0);

  for (let index = 6; index < depth24OracleCases.length; index += 2) {
    const equal = depth24OracleCases[index];
    const unequal = depth24OracleCases[index + 1];
    assert.equal(equal.draws[0].pixelControl & 7, 2);
    assert.equal(equal.draws[0].pixelControl & DEPTH24_EARLY_PIXEL_CONTROL, 64);
    assert.equal(equal.draws[1].pixelControl & DEPTH24_EARLY_PIXEL_CONTROL, 0);
    assert.equal(unequal.draws[0].pixelControl, equal.draws[1].pixelControl);
    assert.equal(unequal.draws[1].pixelControl, equal.draws[1].pixelControl);
  }
});

test("depth24 oracle expands exact expected XFB pixels", () => {
  const rgba = uniformDepth24OracleRgba([255, 255, 255, 255]);
  assert.equal(rgba.length, 4 * 4 * 4);
  assert.deepEqual(rgba.slice(0, 4), [255, 255, 255, 255]);
  assert.deepEqual(rgba.slice(-4), [255, 255, 255, 255]);
});
