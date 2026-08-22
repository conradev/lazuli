import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGxMultiCoordDerivativeTevOraclePacket,
  buildGxMultiCoordTevPipelineLayoutOraclePacket,
  buildGxMultiCoordTevOraclePacket,
  fnv1a64Hex,
  gxMultiCoordDerivativeTevOracleCases,
  gxMultiCoordTevCoverageProof,
  gxMultiCoordTevCertificationCases,
  gxMultiCoordTevMask,
  gxMultiCoordTevOracle,
  gxMultiCoordTevOracleCases,
  gxMultiCoordTevOraclePacketLayout,
  gxMultiCoordTevPipelineLayoutCases,
  gxMultiCoordTevPipelineLayoutOraclePacketLayout,
  modelGxMultiCoordDerivativeTevSurface,
  modelGxMultiCoordTevSurface,
} from "./browser_boot_gx_multi_coord_tev_oracle.mjs";
import {
  gxMipColorOraclePacketLayout,
} from "./browser_boot_gx_mip_color_oracle.mjs";

function view(bytes) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}

function u16(bytes, offset) {
  return view(bytes).getUint16(offset, true);
}

function u32(bytes, offset) {
  return view(bytes).getUint32(offset, true);
}

function f32(bytes, offset) {
  return view(bytes).getFloat32(offset, true);
}

function pixel(rgba, x, y) {
  const offset = (y * 4 + x) * 4;
  return rgba.slice(offset, offset + 4);
}

test("builds canonical local-only two-map V4 packets", () => {
  const layout = gxMultiCoordTevOraclePacketLayout();
  assert.deepEqual(layout, {
    headerBytes: 160,
    drawOffset: 160,
    drawBytes: 176,
    textureOffset: 336,
    textureBytes: 128,
    textureRecordBytes: 64,
    textureCount: 2,
    tevOffset: 464,
    tevBytes: 464,
    vertexOffset: 928,
    vertexBytes: 576,
    vertexFloats: 36,
    vertexRecordBytes: 144,
    vertexCount: 4,
    keyOffset: 1504,
    keyBytes: 40,
    pixelOffset: 1552,
    pixelBytes: 32,
    texturePixelOffsets: [0, 16],
    evidenceOffset: 1584,
    evidenceBytes: 1,
    packetBytes: 1600,
  });

  for (
    let index = 0;
    index < gxMultiCoordTevOracleCases.length;
    index += 1
  ) {
    const entry = gxMultiCoordTevOracleCases[index];
    const generation = 0x4d000000 + index;
    const packet = buildGxMultiCoordTevOraclePacket(
      entry.id,
      generation,
    );
    assert.deepEqual(
      Array.from(packet.slice(0, 4)),
      [0x4c, 0x5a, 0x47, 0x58],
    );
    assert.equal(u16(packet, 0x04), 4);
    assert.equal(u16(packet, 0x06), 160);
    assert.equal(u32(packet, 0x08), packet.length);
    assert.equal(u32(packet, 0x10), 2);
    assert.equal(u32(packet, 0x14), 1);
    assert.equal(u32(packet, 0x18), 2);
    assert.equal(u32(packet, 0x1c), layout.drawOffset);
    assert.equal(u32(packet, 0x20), layout.textureOffset);
    assert.equal(u32(packet, 0x24), layout.tevOffset);
    assert.equal(u32(packet, 0x28), layout.vertexOffset);
    assert.equal(u32(packet, 0x2c), layout.keyOffset);
    assert.equal(u32(packet, 0x30), layout.pixelOffset);
    assert.equal(u32(packet, 0x6c), generation);
    assert.equal(u32(packet, 0x7c), 4);
    assert.equal(packet[layout.drawOffset], 0);
    assert.equal(u16(packet, layout.drawOffset + 0x02), 1);
    assert.equal(packet[layout.evidenceOffset], 0x0f);
    assert.deepEqual(
      Array.from(packet.slice(layout.evidenceOffset + 1)),
      Array(15).fill(0),
    );
  }
});

test("builds legacy-only and legacy-sidecar-legacy packets with exact segment ordering", () => {
  const legacyLayout =
    gxMultiCoordTevPipelineLayoutOraclePacketLayout(
      "legacy-only",
    );
  assert.equal(legacyLayout.drawCount, 1);
  assert.equal(legacyLayout.drawBytes, 176);
  assert.equal(legacyLayout.tevBytes, 464);
  assert.equal(legacyLayout.vertexCount, 4);
  assert.equal(legacyLayout.evidenceBytes, 1);

  const mixedLayout =
    gxMultiCoordTevPipelineLayoutOraclePacketLayout(
      "legacy-sidecar-legacy",
    );
  assert.deepEqual(mixedLayout, {
    headerBytes: 160,
    drawCount: 3,
    drawOffset: 160,
    drawBytes: 528,
    textureOffset: 688,
    textureBytes: 128,
    textureRecordBytes: 64,
    textureCount: 2,
    tevOffset: 816,
    tevBytes: 1392,
    vertexOffset: 2208,
    vertexBytes: 1728,
    vertexFloats: 36,
    vertexRecordBytes: 144,
    vertexCount: 12,
    keyOffset: 3936,
    keyBytes: 40,
    pixelOffset: 3984,
    pixelBytes: 32,
    texturePixelOffsets: [0, 16],
    evidenceOffset: 4016,
    evidenceBytes: 3,
    packetBytes: 4032,
  });

  const mixed =
    buildGxMultiCoordTevPipelineLayoutOraclePacket(
      "legacy-sidecar-legacy",
      0x4d110001,
    );
  assert.equal(u16(mixed, 0x04), 4);
  assert.equal(u32(mixed, 0x08), mixed.length);
  assert.equal(u32(mixed, 0x14), 3);
  assert.equal(u32(mixed, 0x3c), 3 * 464);
  assert.equal(u32(mixed, 0x40), 12 * 144);
  assert.equal(u32(mixed, 0x7c), 12);
  assert.deepEqual(
    Array.from(
      mixed.slice(
        mixedLayout.evidenceOffset,
        mixedLayout.evidenceOffset +
          mixedLayout.evidenceBytes,
      ),
    ),
    [0x0f, 0x0f, 0x0f],
  );

  const expectedCoordinates = [[2, 2], [2, 7], [7, 7]];
  for (let draw = 0; draw < 3; draw += 1) {
    const drawOffset = mixedLayout.drawOffset + draw * 176;
    assert.equal(u16(mixed, drawOffset + 0x02), 1);
    assert.equal(u32(mixed, drawOffset + 0x04), 4);
    assert.equal(u32(mixed, drawOffset + 0x08), draw * 4 * 144);
    assert.equal(u32(mixed, drawOffset + 0x0c), draw * 464);
    const tevOffset = mixedLayout.tevOffset + draw * 464;
    assert.equal(u32(mixed, tevOffset + 448), 2);
    assert.deepEqual(
      [0, 1].map(stage => {
        const references = u32(
          mixed,
          tevOffset + stage * 16 + 8,
        );
        return {
          map: references & 7,
          coordinate: (references >>> 3) & 7,
        };
      }),
      [
        { map: 1, coordinate: expectedCoordinates[draw][0] },
        { map: 6, coordinate: expectedCoordinates[draw][1] },
      ],
    );
  }

  assert.deepEqual(
    gxMultiCoordTevPipelineLayoutCases.map(entry => ({
      id: entry.id,
      pipelineLayouts: entry.pipelineLayouts,
      draws: entry.expectedManagedDraws,
      triangles: entry.expectedManagedTriangles,
    })),
    [
      {
        id: "legacy-only",
        pipelineLayouts: ["legacy"],
        draws: 1,
        triangles: 2,
      },
      {
        id: "legacy-sidecar-legacy",
        pipelineLayouts: ["legacy", "sidecar", "legacy"],
        draws: 3,
        triangles: 6,
      },
    ],
  );
});

test("binds only maps 1 and 6 to two distinct payload records", () => {
  const layout = gxMultiCoordTevOraclePacketLayout();
  const packet = buildGxMultiCoordTevOraclePacket(
    gxMultiCoordTevOracleCases[0].id,
  );
  const references = Array.from({ length: 8 }, (_, map) => ({
    map,
    texture: u32(packet, layout.drawOffset + 0x30 + map * 8),
    sampler: u32(packet, layout.drawOffset + 0x34 + map * 8),
  }));
  assert.deepEqual(references, [
    { map: 0, texture: 0xffffffff, sampler: 0 },
    { map: 1, texture: 0, sampler: 0 },
    { map: 2, texture: 0xffffffff, sampler: 0 },
    { map: 3, texture: 0xffffffff, sampler: 0 },
    { map: 4, texture: 0xffffffff, sampler: 0 },
    { map: 5, texture: 0xffffffff, sampler: 0 },
    { map: 6, texture: 1, sampler: 0 },
    { map: 7, texture: 0xffffffff, sampler: 0 },
  ]);

  const decoder = new TextDecoder();
  for (
    let index = 0;
    index < gxMultiCoordTevOracle.textures.length;
    index += 1
  ) {
    const texture = gxMultiCoordTevOracle.textures[index];
    const offset =
      layout.textureOffset + index * layout.textureRecordBytes;
    const keyRelativeOffset = u32(packet, offset);
    const keyBytes = u32(packet, offset + 0x04);
    const pixelRelativeOffset = u32(packet, offset + 0x08);
    const pixelBytes = u32(packet, offset + 0x0c);
    assert.equal(
      decoder.decode(
        packet.slice(
          layout.keyOffset + keyRelativeOffset,
          layout.keyOffset + keyRelativeOffset + keyBytes,
        ),
      ),
      texture.key,
    );
    assert.equal(u32(packet, offset + 0x18), 2);
    assert.equal(u32(packet, offset + 0x1c), 2);
    assert.equal(u32(packet, offset + 0x20), 1);
    assert.deepEqual(
      Array.from(
        packet.slice(
          layout.pixelOffset + pixelRelativeOffset,
          layout.pixelOffset + pixelRelativeOffset + pixelBytes,
        ),
      ),
      texture.texels,
    );
  }
});

test("encodes nonconsecutive coordinates 2 and 7 in stage order", () => {
  const layout = gxMultiCoordTevOraclePacketLayout();
  for (const entry of gxMultiCoordTevOracleCases) {
    const packet = buildGxMultiCoordTevOraclePacket(entry.id);
    assert.equal(u32(packet, layout.tevOffset + 448), 2);
    const encodedStages = Array.from({ length: 2 }, (_, stage) => {
      const offset = layout.tevOffset + stage * 16;
      const references = u32(packet, offset + 8);
      return {
        map: references & 7,
        coordinate: (references >>> 3) & 7,
        enabled: (references & (1 << 6)) !== 0,
        raster: (references >>> 7) & 7,
        colorCombiner: u32(packet, offset),
        alphaCombiner: u32(packet, offset + 4),
      };
    });
    assert.deepEqual(
      encodedStages.map(
        ({ map, coordinate, enabled, raster }) => ({
          map,
          coordinate,
          enabled,
          raster,
        }),
      ),
      entry.stages.map(({ map, coordinate }) => ({
        map,
        coordinate,
        enabled: true,
        raster: 7,
      })),
    );
    assert.equal(
      encodedStages[0].colorCombiner,
      gxMultiCoordTevOracle.combiner.passTextureColor,
    );
    assert.equal(
      encodedStages[0].alphaCombiner,
      gxMultiCoordTevOracle.combiner.passTextureAlpha,
    );
    assert.equal(
      encodedStages[1].colorCombiner,
      gxMultiCoordTevOracle.combiner
        .subtractTextureFromR0WithHalfBias,
    );
    assert.equal(
      encodedStages[1].alphaCombiner,
      gxMultiCoordTevOracle.combiner.preserveR0Alpha,
    );
  }
  assert.deepEqual(
    gxMultiCoordTevOracleCases.map(entry => ({
      id: entry.id,
      maps: entry.liveTextureMaps,
      coordinates: entry.liveTextureCoordinates,
    })),
    [
      {
        id: "coord2-map1-then-coord7-map6",
        maps: [1, 6],
        coordinates: [2, 7],
      },
      {
        id: "coord7-map6-then-coord2-map1",
        maps: [6, 1],
        coordinates: [7, 2],
      },
    ],
  );
});

test("writes only coordinate slots 2 and 7 with non-unit Q", () => {
  const layout = gxMultiCoordTevOraclePacketLayout();
  const packet = buildGxMultiCoordTevOraclePacket(
    gxMultiCoordTevOracleCases[0].id,
  );
  for (let vertex = 0; vertex < layout.vertexCount; vertex += 1) {
    const vertexOffset =
      layout.vertexOffset + vertex * layout.vertexRecordBytes;
    assert.deepEqual(
      [f32(packet, vertexOffset), f32(packet, vertexOffset + 4)],
      gxMultiCoordTevOracle.positions[vertex].map(Math.fround),
    );
    for (let coordinate = 0; coordinate < 8; coordinate += 1) {
      const coordinateOffset =
        vertexOffset + (12 + coordinate * 3) * 4;
      const actual = [0, 1, 2].map(component =>
        f32(packet, coordinateOffset + component * 4),
      );
      const expected =
        coordinate === 2
          ? gxMultiCoordTevOracle.coordinateA[vertex]
          : coordinate === 7
            ? gxMultiCoordTevOracle.coordinateB[vertex]
            : [0, 0, 1];
      assert.deepEqual(actual, expected.map(Math.fround));
    }
  }
  assert.deepEqual(
    [
      ...new Set([
        ...gxMultiCoordTevOracle.coordinateA.map(stq => stq[2]),
        ...gxMultiCoordTevOracle.coordinateB.map(stq => stq[2]),
      ]),
    ],
    [0.5, 2],
  );
});

test("reference model gates stage order, map-coordinate pairing, and Q timing", () => {
  const expectedHashes = {
    "coord2-map1-then-coord7-map6": "0xafd7d3435fb81ac4",
    "coord7-map6-then-coord2-map1": "0x035eeb3e5d1d6be8",
  };
  const predividedHashes = {
    "coord2-map1-then-coord7-map6": "0x046d54d8a1e874dd",
    "coord7-map6-then-coord2-map1": "0x92d6ce3938f4fc75",
  };
  const swappedCoordinateHashes = {
    "coord2-map1-then-coord7-map6": "0xe7f5f44a90ceebdc",
    "coord7-map6-then-coord2-map1": "0xe47066957bdf570e",
  };
  const packetHashes = {
    "coord2-map1-then-coord7-map6": "0x12ef30d0ed265234",
    "coord7-map6-then-coord2-map1": "0xdab08d595871d45f",
  };

  for (const entry of gxMultiCoordTevOracleCases) {
    assert.equal(entry.expectedRgbaFnv1a64, expectedHashes[entry.id]);
    assert.equal(
      entry.predividedRgbaFnv1a64,
      predividedHashes[entry.id],
    );
    assert.equal(
      entry.swappedCoordinateRgbaFnv1a64,
      swappedCoordinateHashes[entry.id],
    );
    assert.equal(entry.packetFnv1a64, packetHashes[entry.id]);
    assert.notEqual(
      entry.expectedRgbaFnv1a64,
      entry.predividedRgbaFnv1a64,
      `${entry.id} must divide Q after STQ interpolation`,
    );
    assert.notEqual(
      entry.expectedRgbaFnv1a64,
      entry.swappedCoordinateRgbaFnv1a64,
      `${entry.id} must not broadcast or swap coordinates`,
    );
    assert.equal(entry.expectedMask, 0xffff);
    assert.equal(gxMultiCoordTevMask(entry.expectedRgba), 0xffff);
    assert.equal(
      fnv1a64Hex(
        buildGxMultiCoordTevOraclePacket(
          entry.id,
          gxMultiCoordTevOracleCases.indexOf(entry) + 1,
        ),
      ),
      entry.packetFnv1a64,
    );
  }

  const [forward, reversed] = gxMultiCoordTevOracleCases;
  assert.notEqual(
    forward.expectedRgbaFnv1a64,
    reversed.expectedRgbaFnv1a64,
  );
  const differentPixels = Array.from(
    { length: 16 },
    (_, index) =>
      forward.expectedRgba
        .slice(index * 4, index * 4 + 4)
        .some(
          (value, channel) =>
            value !== reversed.expectedRgba[index * 4 + channel],
        ),
  ).filter(Boolean).length;
  assert.equal(
    differentPixels,
    16,
    "reversing the noncommutative stages must change every pixel",
  );
  assert.deepEqual(pixel(forward.expectedRgba, 0, 0), [
    108, 138, 168, 255,
  ]);
  assert.deepEqual(pixel(reversed.expectedRgba, 0, 0), [
    148, 118, 88, 255,
  ]);
  assert.deepEqual(pixel(forward.expectedRgba, 3, 3), [
    248, 98, 38, 255,
  ]);
  assert.deepEqual(pixel(reversed.expectedRgba, 3, 3), [
    8, 158, 218, 255,
  ]);
});

test("same-map V7 packets keep coordinates 2 and 7 as distinct LOD inputs", () => {
  const layout = gxMipColorOraclePacketLayout();
  for (const entry of gxMultiCoordDerivativeTevOracleCases) {
    const packet =
      buildGxMultiCoordDerivativeTevOraclePacket(entry.id);
    assert.equal(u16(packet, 0x04), 7);
    assert.equal(u32(packet, 0x08), layout.packetBytes);
    assert.equal(u32(packet, 0x18), 1);
    assert.equal(
      u32(packet, 0x64),
      gxMultiCoordTevOracle.xfb.destination,
    );
    assert.equal(
      u32(packet, layout.textureOffset + 0x0c),
      84,
    );
    assert.equal(
      u32(packet, layout.textureOffset + 0x24),
      3,
    );
    assert.equal(u32(packet, layout.drawOffset + 0x30), 0);
    assert.equal(
      u32(packet, layout.drawOffset + 0x34),
      gxMultiCoordTevOracle.derivative.mode0,
    );
    for (let map = 1; map < 8; map += 1) {
      assert.equal(
        u32(packet, layout.drawOffset + 0x30 + map * 8),
        0xffffffff,
      );
    }
    assert.equal(
      u32(packet, layout.mode1Offset),
      gxMultiCoordTevOracle.derivative.mode1,
    );
    assert.equal(u32(packet, layout.tevOffset + 448), 2);
    assert.deepEqual(
      Array.from({ length: 2 }, (_, stage) => {
        const references = u32(
          packet,
          layout.tevOffset + stage * 16 + 8,
        );
        return {
          map: references & 7,
          coordinate: (references >>> 3) & 7,
          enabled: (references & (1 << 6)) !== 0,
        };
      }),
      entry.stages.map(stage => ({
        map: 0,
        coordinate: stage.coordinate,
        enabled: true,
      })),
    );
    assert.equal(packet[layout.evidenceOffset], 0x0f);
  }
});

test("same-map coordinate planes select robust LOD 0 and LOD 2", () => {
  const layout = gxMipColorOraclePacketLayout();
  const packet = buildGxMultiCoordDerivativeTevOraclePacket(
    gxMultiCoordDerivativeTevOracleCases[0].id,
  );
  const expected = [
    { coordinate: 2, q: 0.5, dx: 1, rhoRaw: 128, level: 0 },
    { coordinate: 7, q: 2, dx: 4, rhoRaw: 512, level: 2 },
  ];
  for (const vector of expected) {
    const uv = [0, 1].map(vertex => {
      const offset =
        layout.vertexOffset +
        vertex * 36 * 4 +
        (12 + vector.coordinate * 3) * 4;
      const s = f32(packet, offset);
      const t = f32(packet, offset + 4);
      const q = f32(packet, offset + 8);
      assert.equal(q, vector.q);
      assert.notEqual(q, 1);
      return { s: s / q, t: t / q };
    });
    const deltaX =
      gxMultiCoordTevOracle.positions[1][0] -
      gxMultiCoordTevOracle.positions[0][0];
    assert.ok(
      Math.abs((uv[1].s - uv[0].s) / deltaX - vector.dx) <
        0.00001,
    );
    assert.ok(Math.abs(uv[1].t - uv[0].t) < 0.00001);
    const stage =
      gxMultiCoordDerivativeTevOracleCases[0]
        .expectedStageLods.find(
          candidate => candidate.coordinate === vector.coordinate,
        );
    assert.equal(stage.rhoRaw, vector.rhoRaw);
    assert.equal(stage.selectedLevel, vector.level);
  }
  assert.deepEqual(
    gxMultiCoordTevOracle.derivative.expectedLevels,
    [0, 2],
  );
});

test("same-map derivative model rejects coordinate broadcast and stage reversal", () => {
  const expectedHashes = {
    "same-map-coord2-lod0-then-coord7-lod2":
      "0x4d0731a8af13c765",
    "same-map-coord7-lod2-then-coord2-lod0":
      "0x08c67243bad22c25",
  };
  const packetHashes = {
    "same-map-coord2-lod0-then-coord7-lod2":
      "0x3288b6d7a79cea61",
    "same-map-coord7-lod2-then-coord2-lod0":
      "0xc8330155920d723a",
  };
  for (const entry of gxMultiCoordDerivativeTevOracleCases) {
    assert.equal(entry.expectedRgbaFnv1a64, expectedHashes[entry.id]);
    assert.equal(entry.packetFnv1a64, packetHashes[entry.id]);
    assert.equal(
      entry.reusedCoord2RgbaFnv1a64,
      "0x10c6ca2f7d37fba5",
    );
    assert.equal(
      entry.reusedCoord7RgbaFnv1a64,
      "0x10c6ca2f7d37fba5",
    );
    assert.notEqual(
      entry.expectedRgbaFnv1a64,
      entry.reusedCoord2RgbaFnv1a64,
      "reusing coordinate 2 derivatives for both stages must fail",
    );
    assert.notEqual(
      entry.expectedRgbaFnv1a64,
      entry.reusedCoord7RgbaFnv1a64,
      "reusing coordinate 7 derivatives for both stages must fail",
    );
    assert.equal(entry.expectedMask, 0xffff);
  }
  const [forward, reversed] =
    gxMultiCoordDerivativeTevOracleCases;
  assert.deepEqual(pixel(forward.expectedRgba, 0, 0), [
    255, 50, 0, 255,
  ]);
  assert.deepEqual(pixel(reversed.expectedRgba, 0, 0), [
    0, 206, 255, 255,
  ]);
  assert.notEqual(
    forward.expectedRgbaFnv1a64,
    reversed.expectedRgbaFnv1a64,
  );
  assert.deepEqual(
    modelGxMultiCoordDerivativeTevSurface(
      forward.id,
      { reuseCoordinate: 2 },
    ).rgba,
    [128, 128, 128, 255],
  );
  assert.throws(
    () => modelGxMultiCoordDerivativeTevSurface(
      forward.id,
      { reuseCoordinate: 3 },
    ),
    /reuse source must be coordinate 2 or 7/,
  );
});

test("Keep021 proves one exact owner per pixel across the shared seam", () => {
  assert.equal(gxMultiCoordTevCoverageProof.evidence, 0x0f);
  assert.deepEqual(gxMultiCoordTevCoverageProof.triangles, [
    [0, 2, 1],
    [0, 3, 2],
  ]);
  assert.deepEqual(gxMultiCoordTevCoverageProof.owners, [
    1, 0, 0, 0,
    1, 1, 0, 0,
    1, 1, 1, 0,
    1, 1, 1, 1,
  ]);
  assert.deepEqual(
    gxMultiCoordTevCoverageProof.coverageCounts,
    Array(16).fill(1),
    "Keep021 must leave neither cracks nor double-owned samples",
  );
  assert.deepEqual(gxMultiCoordTevCoverageProof.rawTriangles, [
    [0, 1, 2],
    [0, 2, 3],
  ]);
  assert.deepEqual(
    gxMultiCoordTevCoverageProof.rawCoverageCounts,
    Array(16).fill(0),
    "ignoring Keep021 must fail the fixed-edge winding proof",
  );
  for (const entry of gxMultiCoordTevOracleCases) {
    assert.equal(
      entry.rawTriangleOrderRgbaFnv1a64,
      "0x0852db856e95b5a5",
    );
    assert.notEqual(
      entry.expectedRgbaFnv1a64,
      entry.rawTriangleOrderRgbaFnv1a64,
    );
  }
});

test("model and packet builders reject malformed selectors", () => {
  assert.throws(
    () => modelGxMultiCoordTevSurface("missing"),
    /unknown GX multi-coordinate TEV vector/,
  );
  assert.throws(
    () => buildGxMultiCoordTevOraclePacket(
      gxMultiCoordTevOracleCases[0].id,
      -1,
    ),
    /generation must be a u32/,
  );
  assert.throws(
    () => buildGxMultiCoordTevOraclePacket(
      gxMultiCoordTevOracleCases[0].id,
      0x100000000,
    ),
    /generation must be a u32/,
  );
  assert.throws(
    () => gxMultiCoordTevMask(new Uint8Array(4)),
    /one 4x4 RGBA surface/,
  );
  assert.deepEqual(gxMultiCoordTevOracle.expectedMetrics, {
    perRun: {
      managedCoverageDraws: 2,
      managedCoverageTriangles: 4,
    },
    twoRuns: {
      managedCoverageDraws: 4,
      managedCoverageTriangles: 8,
    },
  });
  assert.equal(gxMultiCoordTevCertificationCases.length, 4);
  assert.deepEqual(
    gxMultiCoordTevOracle.certificationExpectedMetrics,
    {
      perRun: {
        managedCoverageDraws: 4,
        managedCoverageTriangles: 8,
      },
      twoRuns: {
        managedCoverageDraws: 8,
        managedCoverageTriangles: 16,
      },
    },
  );
});
