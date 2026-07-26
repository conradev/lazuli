#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  VARYING_RASTER0_PACKET_FNV1A64,
  VARYING_RASTER0_RGBA_FNV1A64,
  VARYING_RASTER1_PACKET_FNV1A64,
  VARYING_RASTER1_RGBA_FNV1A64,
  VARYING_RASTER_HASH_GENERATION,
  VARYING_RASTER_SOFTFLOAT_PACKET_FNV1A64,
  VARYING_RASTER_SOFTFLOAT_RGBA_FNV1A64,
  buildVaryingRasterOraclePacket,
  fnv1a64Hex,
  varyingRasterExactClipPositions,
  varyingRasterExactState,
  varyingRasterOracleCases,
  varyingRasterOracleXfb,
  varyingRasterPacketLayout,
  varyingRasterSoftfloatExactClipPositions,
  varyingRasterSoftfloatExactState,
  varyingRasterSoftfloatVector,
  varyingRasterSourceVector,
} from "./browser_boot_varying_raster_oracle.mjs";

function view(bytes) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}

function f32(bytes, offset) {
  return view(bytes).getFloat32(offset, true);
}

function f32Bits(value) {
  const bytes = new ArrayBuffer(4);
  const bits = new DataView(bytes);
  bits.setFloat32(0, value, true);
  return bits.getUint32(0, true);
}

test("varying-raster oracle pins three canonical v6 exact-required packets", () => {
  const raster0 = buildVaryingRasterOraclePacket(
    "raster0",
    VARYING_RASTER_HASH_GENERATION,
  );
  const raster1 = buildVaryingRasterOraclePacket(
    "raster1",
    VARYING_RASTER_HASH_GENERATION,
  );
  const softfloat = buildVaryingRasterOraclePacket(
    "softfloat-boundary",
    VARYING_RASTER_HASH_GENERATION,
  );
  const raster0View = view(raster0);
  const raster1View = view(raster1);
  const draw = varyingRasterPacketLayout.drawOffset;
  const exact = varyingRasterPacketLayout.exactChunkOffset;

  assert.equal(raster0.length, varyingRasterPacketLayout.packetBytes);
  assert.equal(raster1.length, varyingRasterPacketLayout.packetBytes);
  assert.equal(softfloat.length, varyingRasterPacketLayout.packetBytes);
  assert.deepEqual([...raster0.slice(0, 4)], [...Buffer.from("LZGX")]);
  assert.deepEqual([...raster1.slice(0, 4)], [...Buffer.from("LZGX")]);
  assert.equal(raster0View.getUint16(0x04, true), 6);
  assert.equal(raster1View.getUint16(0x04, true), 6);
  assert.equal(raster0View.getUint32(0x08, true), 1328);
  assert.equal(raster1View.getUint32(0x08, true), 1328);
  assert.equal(raster0View.getUint32(0x14, true), 1);
  assert.equal(raster0View.getUint32(0x18, true), 0);
  assert.equal(raster0View.getUint32(0x28, true), 800);
  assert.equal(raster0View.getUint32(0x2c, true), 1232);
  assert.equal(raster0View.getUint32(0x30, true), 1232);
  assert.equal(raster0View.getUint32(0x40, true), 432);
  assert.equal(raster0[draw], 2);
  assert.equal(raster0View.getUint16(draw + 0x02, true), 6);
  assert.equal(raster1View.getUint16(draw + 0x02, true), 6);
  assert.equal(raster0View.getUint32(draw + 0x04, true), 3);
  assert.equal(raster0View.getUint32(varyingRasterPacketLayout.tevOffset + 8, true), 0);
  assert.equal(
    raster1View.getUint32(varyingRasterPacketLayout.tevOffset + 8, true),
    1 << 7,
  );
  assert.equal(raster0View.getUint32(exact + 0x00, true), 1);
  assert.equal(
    raster0View.getUint32(exact + 0x04, true),
    varyingRasterExactState.bpGenMode,
  );
  assert.equal(
    raster0View.getUint32(exact + 0x08, true),
    varyingRasterExactState.bpScissorTopLeft,
  );
  assert.equal(
    raster0View.getUint32(exact + 0x0c, true),
    varyingRasterExactState.bpScissorBottomRight,
  );
  assert.equal(
    raster0View.getUint32(exact + 0x10, true),
    varyingRasterExactState.bpScissorOffset,
  );
  assert.equal(
    raster0View.getUint32(exact + 0x14, true),
    varyingRasterExactState.xfClipDisable,
  );
  assert.equal(
    varyingRasterPacketLayout.exactChunkBytes,
    raster0.length - varyingRasterPacketLayout.exactChunkOffset,
  );
  assert.equal(
    fnv1a64Hex(raster0),
    VARYING_RASTER0_PACKET_FNV1A64,
  );
  assert.equal(
    fnv1a64Hex(raster1),
    VARYING_RASTER1_PACKET_FNV1A64,
  );
  assert.equal(
    fnv1a64Hex(softfloat),
    VARYING_RASTER_SOFTFLOAT_PACKET_FNV1A64,
  );
  assert.equal(view(softfloat).getUint32(0x4c, true), 270);
  assert.equal(view(softfloat).getUint32(0x50, true), 40);
  assert.notDeepEqual(raster0, raster1);
  assert.notDeepEqual(raster0, softfloat);
  assert.deepEqual(
    raster0,
    buildVaryingRasterOraclePacket(
      "raster0",
      VARYING_RASTER_HASH_GENERATION,
    ),
  );
});

test("exact clip positions project back to the three source screen points", () => {
  function project(positions, state) {
    const [width, height, depthScale, xOrigin, yOrigin, zOrigin] =
      state.viewport;
    const offsetX = (state.bpScissorOffset & 0x1ff) * 2;
    const offsetY = ((state.bpScissorOffset >> 10) & 0x1ff) * 2;
    return positions.map(([x, y, z, w]) => {
      const inverseW = Math.fround(1 / w);
      return [
        Math.fround(
          Math.fround(
            Math.fround(Math.fround(x * inverseW) * width) +
              xOrigin,
          ) - offsetX,
        ),
        Math.fround(
          Math.fround(
            Math.fround(Math.fround(y * inverseW) * height) +
              yOrigin,
          ) - offsetY,
        ),
        Math.fround(
          Math.fround(
            Math.fround(z * inverseW) * depthScale,
          ) + zOrigin,
        ),
        w,
      ];
    });
  }
  const projected = project(
    varyingRasterExactClipPositions,
    varyingRasterExactState,
  );
  assert.deepEqual(
    projected.map(([x, y]) => [x, y]),
    varyingRasterSourceVector.screenPositions,
  );
  assert.ok(
    projected.every(
      (position) =>
        position.every(Number.isFinite) && position[3] === 1,
    ),
  );
  const softfloatProjected = project(
    varyingRasterSoftfloatExactClipPositions,
    varyingRasterSoftfloatExactState,
  );
  assert.deepEqual(
    softfloatProjected.map(([x, y]) => [x, y]),
    varyingRasterSoftfloatVector.screenPositions,
  );
  assert.equal(
    varyingRasterSoftfloatExactState.bpScissorTopLeft,
    (270 << 12) | 40,
  );
  assert.equal(
    varyingRasterSoftfloatExactState.bpScissorBottomRight,
    (273 << 12) | 43,
  );
  assert.equal(varyingRasterSoftfloatExactState.bpScissorOffset, 0);
  assert.deepEqual(varyingRasterSoftfloatExactState.viewport, [
    320, 256, 256, 0, 0, 256,
  ]);
  assert.deepEqual(
    varyingRasterSoftfloatExactClipPositions.map(([x, , , w]) => [
      f32Bits(x),
      w,
    ]),
    [
      [0x435a4e11, 256],
      [0x4358abae, 256],
      [0x435751e8, 256],
    ],
  );
});

test("varying-raster packets can isolate every defined XF clip-disable mode", () => {
  const exact = varyingRasterPacketLayout.exactChunkOffset;
  const canonical = buildVaryingRasterOraclePacket(
    "raster0",
    VARYING_RASTER_HASH_GENERATION,
  );
  for (let xfClipDisable = 0; xfClipDisable <= 7; xfClipDisable += 1) {
    const packet = buildVaryingRasterOraclePacket(
      "raster0",
      VARYING_RASTER_HASH_GENERATION,
      { xfClipDisable },
    );
    assert.equal(
      view(packet).getUint32(exact + 0x14, true),
      xfClipDisable,
    );
    const restored = packet.slice();
    view(restored).setUint32(
      exact + 0x14,
      varyingRasterExactState.xfClipDisable,
      true,
    );
    assert.deepEqual(
      restored,
      canonical,
      `mode ${xfClipDisable} changes only XF 0x1005`,
    );
  }
  assert.deepEqual(
    buildVaryingRasterOraclePacket(
      "raster0",
      VARYING_RASTER_HASH_GENERATION,
      {},
    ),
    canonical,
  );
  for (const xfClipDisable of [-1, 8, 1.5, NaN]) {
    assert.throws(
      () =>
        buildVaryingRasterOraclePacket(
          "raster0",
          VARYING_RASTER_HASH_GENERATION,
          { xfClipDisable },
        ),
      /xfClipDisable must be an integer from 0 through 7/,
    );
  }
});

test("both GX raster channels and the soft-f32 byte boundary are pixel exact", () => {
  assert.deepEqual(varyingRasterOracleXfb, {
    destination: 0x00110000,
    width: 4,
    height: 4,
    stride: 16,
  });
  const [raster0, raster1, softfloat] = varyingRasterOracleCases;
  assert.deepEqual(
    raster0.expectedManagedCoverage,
    { draws: 1, triangles: 1 },
  );
  assert.deepEqual(
    raster1.expectedManagedCoverage,
    { draws: 1, triangles: 1 },
  );
  assert.deepEqual(
    softfloat.expectedManagedCoverage,
    { draws: 1, triangles: 1 },
  );
  assert.deepEqual(raster0.expectedRgba.slice(0, 4), [7, 7, 64, 255]);
  assert.deepEqual(raster0.expectedRgba.slice(60), [43, 43, 64, 255]);
  assert.deepEqual(raster1.expectedRgba.slice(0, 4), [248, 248, 128, 255]);
  assert.deepEqual(raster1.expectedRgba.slice(60), [212, 212, 128, 255]);
  assert.equal(
    fnv1a64Hex(raster0.expectedRgba),
    VARYING_RASTER0_RGBA_FNV1A64,
  );
  assert.equal(
    fnv1a64Hex(raster1.expectedRgba),
    VARYING_RASTER1_RGBA_FNV1A64,
  );
  assert.deepEqual(softfloat.expectedRgba.slice(0, 8), [
    166, 0, 0, 255,
    207, 0, 0, 255,
  ]);
  assert.equal(
    fnv1a64Hex(softfloat.expectedRgba),
    VARYING_RASTER_SOFTFLOAT_RGBA_FNV1A64,
  );
  assert.deepEqual(varyingRasterSoftfloatVector.counterexample, {
    pixel: [270, 40],
    separateXThenYBits: 0x4326ffff,
    separateXThenYByte: 166,
    fusedSetupBits: 0x43270001,
    yFirstBits: 0x43270000,
  });
  assert.deepEqual(varyingRasterSoftfloatVector.snapped28_4, [
    [4366, 664],
    [4333, 640],
    [4306, 682],
  ]);
  assert.notDeepEqual(raster0.expectedRgba, raster1.expectedRgba);
  assert.notDeepEqual(raster0.expectedRgba, softfloat.expectedRgba);
  assert.throws(
    () => buildVaryingRasterOraclePacket("unknown"),
    /unknown varying-raster oracle variant/,
  );
});
