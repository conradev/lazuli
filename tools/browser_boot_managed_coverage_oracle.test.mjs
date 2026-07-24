import assert from "node:assert/strict";
import test from "node:test";

import {
  EXACT_DEPTH_PACKET_FNV1A64,
  EXACT_DEPTH_RGBA_FNV1A64,
  FORCED_NATIVE_PACKET_FNV1A64,
  FORCED_NATIVE_RGBA_FNV1A64,
  MANAGED_COVERAGE_HASH_GENERATION,
  MANAGED_COVERAGE_PACKET_FNV1A64,
  MANAGED_COVERAGE_RGBA_FNV1A64,
  buildManagedCoverageOraclePacket,
  exactDepthPacketLayout,
  exactDepthPlane,
  fnv1a64Hex,
  managedCoverageEvidenceTail,
  managedCoverageExactGeometry,
  managedCoverageMask,
  managedCoverageOracleCases,
  managedCoverageOracleXfb,
  managedCoveragePacketLayout,
  managedCoverageSnapBucket,
} from "./browser_boot_managed_coverage_oracle.mjs";

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

function f32Bits(value) {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function snap28_4(value) {
  return Math.floor(Math.fround(value) * 16 + 0.5);
}

function correctedNativeX(value) {
  return Math.fround(Math.fround(value) + Math.fround(-1 / 12));
}

test("managed-coverage oracle pins the canonical LZGX v4 evidence-tail packet", () => {
  const packet = buildManagedCoverageOraclePacket(
    "managed",
    MANAGED_COVERAGE_HASH_GENERATION,
  );
  assert.deepEqual(
    packet,
    buildManagedCoverageOraclePacket(
      "managed",
      MANAGED_COVERAGE_HASH_GENERATION,
    ),
  );
  assert.equal(packet.length, managedCoveragePacketLayout.packetBytes);
  assert.deepEqual([...packet.slice(0, 4)], [...Buffer.from("LZGX")]);
  assert.equal(u16(packet, 0x04), 4);
  assert.equal(u16(packet, 0x06), 160);
  assert.equal(u32(packet, 0x08), 1392);
  assert.equal(u32(packet, 0x10), 2);
  assert.equal(u32(packet, 0x14), 1);
  assert.equal(u32(packet, 0x18), 0);
  assert.equal(u32(packet, 0x1c), 160);
  assert.equal(u32(packet, 0x20), 336);
  assert.equal(u32(packet, 0x24), 336);
  assert.equal(u32(packet, 0x28), 800);
  assert.equal(u32(packet, 0x2c), 1376);
  assert.equal(u32(packet, 0x30), 1376);
  assert.equal(u32(packet, 0x34), 176);
  assert.equal(u32(packet, 0x38), 0);
  assert.equal(u32(packet, 0x3c), 464);
  assert.equal(u32(packet, 0x40), 576);
  assert.equal(u32(packet, 0x44), 0);
  assert.equal(u32(packet, 0x48), 0);
  assert.deepEqual(
    [
      u32(packet, 0x4c),
      u32(packet, 0x50),
      u32(packet, 0x54),
      u32(packet, 0x58),
      u32(packet, 0x5c),
      u32(packet, 0x60),
    ],
    [0, 0, 4, 4, 4, 4],
  );
  assert.equal(u32(packet, 0x64), 0x00110000);
  assert.equal(u32(packet, 0x68), 16);
  assert.equal(u32(packet, 0x6c), MANAGED_COVERAGE_HASH_GENERATION);
  assert.equal(u32(packet, 0x70), 0);
  assert.equal(u16(packet, 0x78), 176);
  assert.equal(u16(packet, 0x7a), 64);
  assert.equal(u32(packet, 0x7c), 4);
  assert.equal(u32(packet, 0x80), 0);
  assert.equal(u32(packet, 0x84), 0);
  assert.equal(u32(packet, 0x88), 0);
  assert.equal(u32(packet, 0x8c), 0x4003);
  assert.equal(u32(packet, 0x90), 0);
  assert.equal(u32(packet, 0x94), 256);
  assert.equal(u32(packet, 0x98), 0x00820000);
  assert.equal(u32(packet, 0x9c), 0);

  const draw = managedCoveragePacketLayout.drawOffset;
  assert.equal(packet[draw], 0);
  assert.equal(packet[draw + 1], 0);
  assert.equal(u16(packet, draw + 2), 1);
  assert.equal(u32(packet, draw + 0x04), 4);
  assert.equal(u32(packet, draw + 0x08), 0);
  assert.equal(u32(packet, draw + 0x0c), 0);
  assert.equal(u32(packet, draw + 0x10), 0);
  assert.equal(u32(packet, draw + 0x14), 0x8);
  assert.equal(u32(packet, draw + 0x18), 0x003f0000);
  assert.deepEqual(
    [
      u32(packet, draw + 0x1c),
      u32(packet, draw + 0x20),
      u32(packet, draw + 0x24),
      u32(packet, draw + 0x28),
    ],
    [0, 0, 4, 4],
  );
  for (let map = 0; map < 8; map += 1) {
    assert.equal(u32(packet, draw + 0x30 + map * 8), 0xffffffff);
    assert.equal(u32(packet, draw + 0x34 + map * 8), 0);
  }
  assert.deepEqual(
    [
      u32(packet, draw + 0x70),
      u32(packet, draw + 0x74),
      u32(packet, draw + 0x78),
      u32(packet, draw + 0x7c),
    ],
    [0, 0, 0, 0],
  );

  const tev = managedCoveragePacketLayout.tevOffset;
  assert.equal(u32(packet, tev), 0x0048fffa);
  assert.equal(u32(packet, tev + 4), 0x0048ffd0);
  assert.equal(u32(packet, tev + 8), 0);
  assert.equal(u32(packet, tev + 12), 0);
  assert.deepEqual(
    [0, 1, 2, 3].map((channel) => u32(packet, tev + 384 + channel * 4)),
    [0, 1, 2, 3],
  );
  assert.equal(u32(packet, tev + 448), 1);

  const vertices = [
    [0.59, 0],
    [4, 0],
    [4, 4],
    [0.59, 4],
  ];
  for (let index = 0; index < vertices.length; index += 1) {
    const offset =
      managedCoveragePacketLayout.vertexOffset +
      index * managedCoveragePacketLayout.vertexBytes;
    assert.deepEqual(
      [f32(packet, offset), f32(packet, offset + 4)],
      vertices[index].map(Math.fround),
    );
    assert.deepEqual(
      [2, 3, 4, 5, 6, 7].map((component) =>
        f32(packet, offset + component * 4),
      ),
      [0, 1, 1, 1, 1, 1],
    );
    for (let component = 8; component < 36; component += 1) {
      assert.equal(f32(packet, offset + component * 4), 0);
    }
  }

  assert.equal(managedCoveragePacketLayout.payloadBytes, 1376);
  assert.equal(managedCoveragePacketLayout.evidenceOffset, 1376);
  assert.equal(managedCoveragePacketLayout.evidenceBytes, 1);
  assert.equal(managedCoveragePacketLayout.evidencePaddedBytes, 16);
  assert.equal(
    packet[managedCoveragePacketLayout.evidenceOffset],
    managedCoverageEvidenceTail.keep021Twice,
  );
  assert.equal(managedCoverageEvidenceTail.drawFlag, 1);
  assert.equal(managedCoverageEvidenceTail.keep021Twice, 0x0f);
  assert.deepEqual(
    Array.from(
      packet.slice(managedCoveragePacketLayout.evidenceOffset + 1),
    ),
    new Array(15).fill(0),
  );
});

test("fragment gates ignore evidence and retain raw native fallback for varying depth", () => {
  const managed = buildManagedCoverageOraclePacket(
    "managed",
    MANAGED_COVERAGE_HASH_GENERATION,
  );
  const forcedNative = buildManagedCoverageOraclePacket(
    "forced-native",
    MANAGED_COVERAGE_HASH_GENERATION,
  );
  const offset = managedCoveragePacketLayout.forcedNativeComponentOffset;
  assert.equal(offset, 1240);
  assert.equal(managedCoveragePacketLayout.forcedNativeVertex, 3);
  assert.equal(managedCoveragePacketLayout.forcedNativeComponent, 2);
  assert.equal(f32(managed, offset), 0);
  assert.equal(f32(forcedNative, offset), 1);

  // Both v4 packets carry identical Keep021 evidence for the same raw
  // topology-0/cull-0 quad. The receiver consumes it only after its fragment
  // gates qualify. Varying source depth fails a still-required flatness gate,
  // so the control keeps the untouched raw vertices/topology/cull on the
  // native fallback path even though this vector disables depth testing.
  assert.equal(managed[managedCoveragePacketLayout.drawOffset], 0);
  assert.equal(forcedNative[managedCoveragePacketLayout.drawOffset], 0);
  assert.equal(managed[managedCoveragePacketLayout.drawOffset + 1], 0);
  assert.equal(forcedNative[managedCoveragePacketLayout.drawOffset + 1], 0);
  assert.equal(
    u16(managed, managedCoveragePacketLayout.drawOffset + 2),
    managedCoverageEvidenceTail.drawFlag,
  );
  assert.equal(
    u16(forcedNative, managedCoveragePacketLayout.drawOffset + 2),
    managedCoverageEvidenceTail.drawFlag,
  );
  assert.deepEqual(
    managed.slice(managedCoveragePacketLayout.evidenceOffset),
    forcedNative.slice(managedCoveragePacketLayout.evidenceOffset),
  );

  const byteDifferences = [];
  for (let index = 0; index < managed.length; index += 1) {
    if (managed[index] !== forcedNative[index]) {
      byteDifferences.push([index, managed[index], forcedNative[index]]);
    }
  }
  assert.deepEqual(byteDifferences, [
    [1242, 0, 128],
    [1243, 0, 63],
  ]);
  assert.equal(fnv1a64Hex(managed), MANAGED_COVERAGE_PACKET_FNV1A64);
  assert.equal(fnv1a64Hex(forcedNative), FORCED_NATIVE_PACKET_FNV1A64);
  assert.throws(
    () => buildManagedCoverageOraclePacket("unknown"),
    /unknown managed coverage oracle variant/,
  );
});

test("exact-depth oracle pins the canonical LZGX v5 clip-input packet", () => {
  const packet = buildManagedCoverageOraclePacket(
    "exact-depth",
    MANAGED_COVERAGE_HASH_GENERATION,
  );
  const draw0 = exactDepthPacketLayout.exactDrawOffset;
  const draw1 = exactDepthPacketLayout.equalDrawOffset;
  const exact = exactDepthPacketLayout.exactChunkOffset;

  assert.deepEqual(
    packet,
    buildManagedCoverageOraclePacket(
      "exact-depth",
      MANAGED_COVERAGE_HASH_GENERATION,
    ),
  );
  assert.equal(packet.length, exactDepthPacketLayout.packetBytes);
  assert.deepEqual([...packet.slice(0, 4)], [...Buffer.from("LZGX")]);
  assert.equal(u16(packet, 0x04), 5);
  assert.equal(u16(packet, 0x06), 160);
  assert.equal(u32(packet, 0x08), 2400);
  assert.equal(u32(packet, 0x14), exactDepthPacketLayout.drawCount);
  assert.equal(u32(packet, 0x1c), 160);
  assert.equal(u32(packet, 0x20), 512);
  assert.equal(u32(packet, 0x24), 512);
  assert.equal(u32(packet, 0x28), exactDepthPacketLayout.vertexOffset);
  assert.equal(u32(packet, 0x2c), exactDepthPacketLayout.basePacketBytes);
  assert.equal(u32(packet, 0x30), exactDepthPacketLayout.basePacketBytes);
  assert.equal(u32(packet, 0x34), 352);
  assert.equal(u32(packet, 0x3c), 928);
  assert.equal(u32(packet, 0x40), 864);
  assert.equal(u32(packet, 0x7c), exactDepthPacketLayout.vertexCount);

  assert.equal(packet[draw0], 2);
  assert.equal(packet[draw0 + 1], 0);
  assert.equal(u16(packet, draw0 + 0x02), exactDepthPacketLayout.drawFlag);
  assert.equal(u32(packet, draw0 + 0x04), 3);
  assert.equal(u32(packet, draw0 + 0x08), 0);
  assert.equal(u32(packet, draw0 + 0x0c), 0);
  assert.equal(u32(packet, draw0 + 0x10), 31);
  assert.deepEqual(
    [0x1c, 0x20, 0x24, 0x28].map((offset) => u32(packet, draw0 + offset)),
    [0, 0, 4, 4],
  );
  assert.equal(f32(packet, draw0 + 0xac), exactDepthPlane.viewport[0]);

  assert.equal(packet[draw1], 2);
  assert.equal(packet[draw1 + 1], 0);
  assert.equal(u16(packet, draw1 + 0x02), 0);
  assert.equal(u32(packet, draw1 + 0x04), 3);
  assert.equal(u32(packet, draw1 + 0x08), 432);
  assert.equal(u32(packet, draw1 + 0x0c), 464);
  assert.equal(u32(packet, draw1 + 0x10), 5);
  assert.deepEqual(
    [0x1c, 0x20, 0x24, 0x28].map((offset) => u32(packet, draw1 + offset)),
    [0, 0, 1, 1],
  );

  assert.equal(u32(packet, exact + 0x00), 1);
  assert.equal(u32(packet, exact + 0x04), 0);
  assert.equal(u32(packet, exact + 0x08), (342 << 12) | 342);
  assert.equal(
    u32(packet, exact + 0x0c),
    ((342 + 3) << 12) | (342 + 3),
  );
  assert.equal(u32(packet, exact + 0x10), 171 | (171 << 10));
  assert.equal(u32(packet, exact + 0x14), 0);
  assert.deepEqual(
    Array.from(
      { length: 6 },
      (_unused, index) => f32(packet, exact + 0x18 + index * 4),
    ),
    exactDepthPlane.viewport,
  );

  const expectedClip = exactDepthPlane.sourcePositions.flatMap(
    ([x, y], index) => [
      Math.fround(Math.fround(x) / 320 - 1),
      Math.fround(1 - Math.fround(y) / 264),
      Math.fround(
        (Math.fround(exactDepthPlane.sourceDepths[index]) - 0x00ffffff) /
          0x00ffffff,
      ),
      1,
    ],
  );
  assert.deepEqual(
    Array.from(
      { length: 12 },
      (_unused, index) => f32(packet, exact + 0x30 + index * 4),
    ),
    expectedClip,
  );
  assert.deepEqual(
    Array.from({ length: 6 }, (_unused, index) =>
      f32(
        packet,
        exactDepthPacketLayout.vertexOffset +
          index * managedCoveragePacketLayout.vertexBytes +
          2 * 4,
      ),
    ),
    [
      ...exactDepthPlane.sourceDepths,
      exactDepthPlane.equalDepth,
      exactDepthPlane.equalDepth,
      exactDepthPlane.equalDepth,
    ],
  );
  const projectedDepths = expectedClip
    .filter((_unused, index) => index % 4 === 2)
    .map((clipZ) =>
      Math.fround(
        Math.fround(
          Math.fround(clipZ * Math.fround(1 / 1)) *
            exactDepthPlane.viewport[2],
        ) + exactDepthPlane.viewport[5],
      ),
    );
  assert.deepEqual(projectedDepths, exactDepthPlane.projectedDepths);
  assert.equal(
    exactDepthPacketLayout.exactChunkBytes,
    packet.length - exactDepthPacketLayout.exactChunkOffset,
  );
  assert.equal(fnv1a64Hex(packet), EXACT_DEPTH_PACKET_FNV1A64);
});

test("same-snap bracket isolates exact GX coverage from native correction", () => {
  for (const entry of managedCoverageSnapBucket) {
    assert.equal(f32Bits(entry.sourceX), entry.sourceF32Bits);
    assert.equal(snap28_4(entry.sourceX), entry.snapped28_4);
    assert.equal(correctedNativeX(entry.sourceX), entry.correctedNativeX);
    assert.equal(
      f32Bits(correctedNativeX(entry.sourceX)),
      entry.correctedNativeF32Bits,
    );
    assert.equal(
      correctedNativeX(entry.sourceX) <= 0.5,
      entry.currentNativeCoversPixel0,
    );
  }
  assert.deepEqual(
    managedCoverageSnapBucket.map(({ snapped28_4 }) => snapped28_4),
    [9, 9, 10],
  );
  assert.equal(
    managedCoverageSnapBucket[0].snapped28_4,
    managedCoverageSnapBucket[1].snapped28_4,
    ".575 and .590 deliberately share the exact 28.4 edge",
  );

  assert.equal(
    managedCoverageExactGeometry.sample28_4Numerator -
      managedCoverageExactGeometry.sample28_4Denominator *
        managedCoverageExactGeometry.snappedLeft28_4,
    1,
  );
  assert.equal(managedCoverageExactGeometry.leftEdgeMarginPixels, 1 / 48);
  assert.equal(
    managedCoverageExactGeometry.reorderedTriangleArea28_4,
    -3520,
  );
});

test("managed, retained-native, and exact-depth paths have exact 4x4 RGBA oracles", () => {
  assert.deepEqual(
    managedCoverageOracleCases.map(
      ({ id, expectedMask, expectedManagedCoverage }) => ({
        id,
        expectedMask,
        expectedManagedCoverage,
      }),
    ),
    [
      {
        id: "managed",
        expectedMask: 0xffff,
        expectedManagedCoverage: { draws: 1, triangles: 2 },
      },
      {
        id: "forced-native",
        expectedMask: 0xeeee,
        expectedManagedCoverage: { draws: 0, triangles: 0 },
      },
      {
        id: "exact-depth",
        expectedMask: 0x0001,
        expectedManagedCoverage: { draws: 1, triangles: 1 },
      },
    ],
  );
  assert.deepEqual(managedCoverageOracleXfb, {
    destination: 0x00110000,
    width: 4,
    height: 4,
    stride: 16,
  });

  const managed = managedCoverageOracleCases[0];
  assert.equal(managed.expectedRgba.length, 64);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, row) =>
      managed.expectedRgba.slice(row * 16, row * 16 + 16),
    ),
    Array.from({ length: 4 }, () => new Array(16).fill(255)),
  );

  const forcedNative = managedCoverageOracleCases[1];
  const expectedNativeRow = [
    0, 0, 0, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
  ];
  assert.deepEqual(
    Array.from({ length: 4 }, (_, row) =>
      forcedNative.expectedRgba.slice(row * 16, row * 16 + 16),
    ),
    Array.from({ length: 4 }, () => expectedNativeRow),
  );

  for (const entry of managedCoverageOracleCases) {
    assert.equal(managedCoverageMask(entry.expectedRgba), entry.expectedMask);
    assert.equal(fnv1a64Hex(entry.expectedRgba), entry.expectedRgbaFnv1a64);
  }
  assert.equal(managed.expectedRgbaFnv1a64, MANAGED_COVERAGE_RGBA_FNV1A64);
  assert.equal(
    forcedNative.expectedRgbaFnv1a64,
    FORCED_NATIVE_RGBA_FNV1A64,
  );
  const exactDepth = managedCoverageOracleCases[2];
  assert.deepEqual(exactDepth.expectedRgba.slice(0, 4), [255, 255, 255, 255]);
  assert.deepEqual(
    exactDepth.expectedRgba.slice(4),
    Array.from({ length: 15 }, () => [0, 0, 0, 255]).flat(),
  );
  assert.equal(exactDepth.expectedRgbaFnv1a64, EXACT_DEPTH_RGBA_FNV1A64);
  assert.equal(
    exactDepthPlane.expectedSampleDepth,
    exactDepthPlane.projectedDepths[0] +
      (exactDepthPlane.projectedDepths[1] -
        exactDepthPlane.projectedDepths[0]) *
        ((exactDepthPlane.sampleNumerator / exactDepthPlane.sampleDenominator -
          exactDepthPlane.sourcePositions[0][0]) /
          (exactDepthPlane.sourcePositions[1][0] -
            exactDepthPlane.sourcePositions[0][0])),
  );
  assert.equal(Math.trunc(exactDepthPlane.expectedSampleDepth), 95);
  assert.equal(Math.trunc(exactDepthPlane.sourceDepths[0]), 94);
  assert.throws(() => managedCoverageMask(new Uint8Array(4)), /4x4 RGBA/);
});
