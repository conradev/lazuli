#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECTION_NULL_HASH_GENERATION,
  PROJECTION_NULL_PACKET_FNV1A64,
  PROJECTION_NULL_RGBA_FNV1A64,
  buildProjectionNullOraclePacket,
  fnv1a64Hex,
  projectionNullExactState,
  projectionNullMask,
  projectionNullOracleCase,
  projectionNullOracleXfb,
  projectionNullPacketLayout,
  projectionNullSourceVector,
} from "./browser_boot_projection_null_oracle.mjs";

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

function f32Bits(value) {
  const storage = new ArrayBuffer(4);
  new Float32Array(storage)[0] = value;
  return new Uint32Array(storage)[0] >>> 0;
}

function f32BitPatterns(values) {
  return Array.from(values, f32Bits);
}

test("projection-null oracle pins one canonical LZGX v6 exact-required packet", () => {
  const packet = buildProjectionNullOraclePacket(
    PROJECTION_NULL_HASH_GENERATION,
  );
  const draw = projectionNullPacketLayout.drawOffset;
  const exact = projectionNullPacketLayout.exactChunkOffset;

  assert.deepEqual(
    packet,
    buildProjectionNullOraclePacket(
      PROJECTION_NULL_HASH_GENERATION,
    ),
  );
  assert.equal(packet.length, projectionNullPacketLayout.packetBytes);
  assert.deepEqual([...packet.slice(0, 4)], [...Buffer.from("LZGX")]);
  assert.equal(u16(packet, 0x04), 6);
  assert.equal(u16(packet, 0x06), 160);
  assert.equal(u32(packet, 0x08), 1328);
  assert.equal(u32(packet, 0x10), 2);
  assert.equal(u32(packet, 0x14), 1);
  assert.equal(u32(packet, 0x18), 0);
  assert.equal(u32(packet, 0x1c), 160);
  assert.equal(u32(packet, 0x20), 336);
  assert.equal(u32(packet, 0x24), 336);
  assert.equal(u32(packet, 0x28), 800);
  assert.equal(u32(packet, 0x2c), 1232);
  assert.equal(u32(packet, 0x30), 1232);
  assert.equal(u32(packet, 0x34), 176);
  assert.equal(u32(packet, 0x3c), 464);
  assert.equal(u32(packet, 0x40), 432);
  assert.equal(u32(packet, 0x7c), 3);

  assert.equal(packet[draw], 2);
  assert.equal(packet[draw + 1], 0);
  assert.equal(u16(packet, draw + 0x02), 6);
  assert.equal(u32(packet, draw + 0x04), 3);
  assert.equal(u32(packet, draw + 0x08), 0);
  assert.equal(u32(packet, draw + 0x0c), 0);
  assert.deepEqual(
    [0x1c, 0x20, 0x24, 0x28].map((offset) =>
      u32(packet, draw + offset)
    ),
    [0, 0, 4, 4],
  );
  assert.equal(f32Bits(f32(packet, draw + 0xac)), f32Bits(2));

  assert.equal(u32(packet, exact + 0x00), 1);
  assert.equal(
    u32(packet, exact + 0x04),
    projectionNullExactState.bpGenMode,
  );
  assert.equal(
    u32(packet, exact + 0x08),
    projectionNullExactState.bpScissorTopLeft,
  );
  assert.equal(
    u32(packet, exact + 0x0c),
    projectionNullExactState.bpScissorBottomRight,
  );
  assert.equal(
    u32(packet, exact + 0x10),
    projectionNullExactState.bpScissorOffset,
  );
  assert.equal(
    u32(packet, exact + 0x14),
    projectionNullExactState.xfClipDisable,
  );
  assert.deepEqual(
    Array.from(
      { length: 6 },
      (_unused, index) => u32(packet, exact + 0x18 + index * 4),
    ),
    f32BitPatterns(projectionNullExactState.viewport),
  );
  assert.deepEqual(
    Array.from(
      { length: 12 },
      (_unused, index) => u32(packet, exact + 0x30 + index * 4),
    ),
    [
      0x40000000,
      0x00000000,
      0x00000000,
      0x80000000,
      0xbf800000,
      0xbf800000,
      0xbefffffe,
      0x3f800000,
      0xbf800000,
      0x3f800000,
      0xbefffffe,
      0x3f800000,
    ],
  );
  assert.equal(
    projectionNullPacketLayout.exactChunkBytes,
    packet.length - projectionNullPacketLayout.exactChunkOffset,
  );
  assert.equal(fnv1a64Hex(packet), PROJECTION_NULL_PACKET_FNV1A64);
});

test("native carrier is finite and degenerate while exact geometry is visible", () => {
  const packet = buildProjectionNullOraclePacket();
  const positions = Array.from(
    { length: projectionNullPacketLayout.vertexCount },
    (_unused, vertex) =>
      Array.from(
        { length: 4 },
        (_component, component) =>
          f32(
            packet,
            projectionNullPacketLayout.vertexOffset +
              vertex * projectionNullPacketLayout.vertexBytes +
              component * 4,
          ),
      ),
  );
  assert.deepEqual(positions, projectionNullSourceVector.nativeCarrierPositions);
  assert.ok(positions.flat().every(Number.isFinite));

  const [[x0, y0], [x1, y1], [x2, y2]] = positions;
  const twiceArea =
    x0 * (y1 - y2) +
    x1 * (y2 - y0) +
    x2 * (y0 - y1);
  assert.equal(twiceArea, 0);
  assert.deepEqual(
    projectionNullSourceVector.exactClipPositions.map(
      ([x, y, _z, w]) => [x, y, w],
    ),
    [
      [2, 0, -0],
      [-1, -1, 1],
      [-1, 1, 1],
    ],
  );
  assert.equal(
    projectionNullSourceVector.exactClipPositions[0][0] >
      projectionNullSourceVector.exactClipPositions[0][3],
    true,
    "the W=0 source is removed by exact right-plane clipping",
  );
});

test("projection-null oracle pins the all-white 4x4 readback contract", () => {
  assert.deepEqual(projectionNullOracleXfb, {
    destination: 0x00110000,
    width: 4,
    height: 4,
    stride: 16,
  });
  assert.deepEqual(projectionNullOracleCase.expectedManagedCoverage, {
    draws: 1,
    triangles: 2,
  });
  assert.equal(projectionNullOracleCase.expectedRgba.length, 64);
  assert.ok(
    projectionNullOracleCase.expectedRgba.every((channel) => channel === 255),
  );
  assert.equal(
    projectionNullMask(projectionNullOracleCase.expectedRgba),
    projectionNullOracleCase.expectedMask,
  );
  assert.equal(
    fnv1a64Hex(projectionNullOracleCase.expectedRgba),
    PROJECTION_NULL_RGBA_FNV1A64,
  );
  assert.equal(
    projectionNullOracleCase.expectedRgbaFnv1a64,
    PROJECTION_NULL_RGBA_FNV1A64,
  );
  assert.throws(
    () => projectionNullMask(new Uint8Array(4)),
    /one 4x4 RGBA surface/,
  );
});
