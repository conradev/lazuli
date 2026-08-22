import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManagedTexturedCoverageOraclePacket,
  fnv1a64Hex,
  managedTexturedCoverageEvidence,
  managedTexturedCoverageGeometry,
  managedTexturedCoveragePacketFnv1a64,
  managedTexturedCoveragePacketLayout,
  managedTexturedCoverageSamplers,
  managedTexturedCoverageTexels,
  managedTexturedCoverageVectorDefinitions,
  managedTexturedCoverageXfb,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";

const managedTexturedCoverageVectorCases = Object.freeze(
  managedTexturedCoverageVectorDefinitions.map((definition) =>
    Object.freeze({
      id: definition.id,
      topology: definition.topology,
      evidence: definition.evidence,
      liveTexCoords: Object.freeze([
        ...new Set(
          definition.stages.map((stage) => stage.coordinate),
        ),
      ]),
      samplerBits: definition.samplerBits,
      expectedPath: definition.managed ? "managed" : "native",
    }),
  ),
);

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

test("managed textured vectors emit canonical LZGX v4 texture packets", () => {
  const expectedPacketHashes = {
    "perspective-nearest-keep012": "0x7736c53f81167ac9",
    "nonunit-q-linear-keep021": "0xd56d92cf61d6a66b",
    "second-live-coordinate-native": "0x56857a56f2ad6d5c",
    "mip-min-filter-native": "0x9eff32dc82a12a81",
  };
  assert.deepEqual(
    managedTexturedCoveragePacketFnv1a64,
    expectedPacketHashes,
  );

  for (
    let caseIndex = 0;
    caseIndex < managedTexturedCoverageVectorCases.length;
    caseIndex += 1
  ) {
    const entry = managedTexturedCoverageVectorCases[caseIndex];
    const generation = caseIndex + 1;
    const packet = buildManagedTexturedCoverageOraclePacket(
      entry.id,
      generation,
    );
    const layout = managedTexturedCoveragePacketLayout(entry.id);
    assert.deepEqual(
      packet,
      buildManagedTexturedCoverageOraclePacket(entry.id, generation),
      entry.id,
    );
    assert.equal(fnv1a64Hex(packet), expectedPacketHashes[entry.id]);
    assert.equal(packet.length, layout.packetBytes);
    assert.deepEqual([...packet.slice(0, 4)], [...Buffer.from("LZGX")]);
    assert.equal(u16(packet, 0x04), 4);
    assert.equal(u16(packet, 0x06), 160);
    assert.equal(u32(packet, 0x08), layout.packetBytes);
    assert.equal(u32(packet, 0x10), 2);
    assert.equal(u32(packet, 0x14), 1);
    assert.equal(u32(packet, 0x18), 1);
    assert.equal(u32(packet, 0x1c), layout.drawOffset);
    assert.equal(u32(packet, 0x20), layout.textureOffset);
    assert.equal(u32(packet, 0x24), layout.tevOffset);
    assert.equal(u32(packet, 0x28), layout.vertexOffset);
    assert.equal(u32(packet, 0x2c), layout.keyOffset);
    assert.equal(u32(packet, 0x30), layout.pixelOffset);
    assert.equal(u32(packet, 0x34), 176);
    assert.equal(u32(packet, 0x38), 64);
    assert.equal(u32(packet, 0x3c), 464);
    assert.equal(u32(packet, 0x40), layout.vertexCount * 144);
    assert.equal(u32(packet, 0x44), 12);
    assert.equal(u32(packet, 0x48), 16);
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
    assert.equal(u32(packet, 0x64), managedTexturedCoverageXfb.destination);
    assert.equal(u32(packet, 0x68), managedTexturedCoverageXfb.stride);
    assert.equal(u32(packet, 0x6c), generation);
    assert.equal(u32(packet, 0x70), 0);
    assert.equal(u16(packet, 0x78), 176);
    assert.equal(u16(packet, 0x7a), 64);
    assert.equal(u32(packet, 0x7c), layout.vertexCount);
    assert.equal(u32(packet, 0x8c), 0x4003);
    assert.equal(u32(packet, 0x94), 256);
    assert.equal(u32(packet, 0x98), 0x00820000);

    const draw = layout.drawOffset;
    assert.equal(packet[draw], entry.topology);
    assert.equal(packet[draw + 1], 0);
    assert.equal(
      u16(packet, draw + 2),
      managedTexturedCoverageEvidence.drawFlag,
    );
    assert.equal(u32(packet, draw + 0x04), layout.vertexCount);
    assert.equal(u32(packet, draw + 0x08), 0);
    assert.equal(u32(packet, draw + 0x0c), 0);
    assert.equal(u32(packet, draw + 0x10), 0);
    assert.equal(u32(packet, draw + 0x14), 8);
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
    assert.equal(u32(packet, draw + 0x30), 0);
    assert.equal(u32(packet, draw + 0x34), entry.samplerBits);
    for (let map = 1; map < 8; map += 1) {
      assert.equal(u32(packet, draw + 0x30 + map * 8), 0xffffffff);
      assert.equal(u32(packet, draw + 0x34 + map * 8), 0);
    }
    for (let offset = 0x70; offset < 0xb0; offset += 4) {
      assert.equal(u32(packet, draw + offset), 0);
    }

    const texture = layout.textureOffset;
    assert.deepEqual(
      [
        u32(packet, texture),
        u32(packet, texture + 4),
        u32(packet, texture + 8),
        u32(packet, texture + 12),
        u32(packet, texture + 16),
        u32(packet, texture + 20),
        u32(packet, texture + 24),
        u32(packet, texture + 28),
        u32(packet, texture + 32),
      ],
      [0, 12, 0, 16, 0, 0, 2, 2, 1],
    );
    assert.deepEqual(
      Array.from(packet.slice(texture + 36, texture + 64)),
      new Array(28).fill(0),
    );
    assert.equal(
      new TextDecoder().decode(
        packet.slice(layout.keyOffset, layout.keyOffset + layout.keyBytes),
      ),
      managedTexturedCoverageGeometry.textureKey,
    );
    assert.deepEqual(
      Array.from(
        packet.slice(
          layout.pixelOffset,
          layout.pixelOffset + layout.pixelBytes,
        ),
      ),
      managedTexturedCoverageTexels,
    );
    assert.equal(packet[layout.evidenceOffset], entry.evidence);
    assert.deepEqual(
      Array.from(packet.slice(layout.evidenceOffset + 1)),
      new Array(layout.evidencePaddedBytes - 1).fill(0),
    );
  }
});

test("TEV stages pin one live coordinate and both no-mip filters", () => {
  assert.deepEqual(managedTexturedCoverageSamplers, {
    nearestNoMip: 0,
    linearNoMip: 0x90,
    unsupportedMip: 0x20,
  });
  assert.deepEqual(
    managedTexturedCoverageVectorCases.map(
      ({ id, liveTexCoords, samplerBits, expectedPath }) => ({
        id,
        liveTexCoords,
        samplerBits,
        expectedPath,
      }),
    ),
    [
      {
        id: "perspective-nearest-keep012",
        liveTexCoords: [0],
        samplerBits: 0,
        expectedPath: "managed",
      },
      {
        id: "nonunit-q-linear-keep021",
        liveTexCoords: [0],
        samplerBits: 0x90,
        expectedPath: "managed",
      },
      {
        id: "second-live-coordinate-native",
        liveTexCoords: [0, 1],
        samplerBits: 0,
        expectedPath: "native",
      },
      {
        id: "mip-min-filter-native",
        liveTexCoords: [0],
        samplerBits: 0x20,
        expectedPath: "native",
      },
    ],
  );

  for (const entry of managedTexturedCoverageVectorCases) {
    const packet = buildManagedTexturedCoverageOraclePacket(entry.id);
    const tev = managedTexturedCoveragePacketLayout(entry.id).tevOffset;
    const stageCount = entry.liveTexCoords.length === 2 ? 2 : 1;
    assert.equal(u32(packet, tev + 448), stageCount);
    for (let stage = 0; stage < stageCount; stage += 1) {
      assert.equal(u32(packet, tev + stage * 16), 0x0048fff8);
      assert.equal(u32(packet, tev + stage * 16 + 4), 0x0048ffc0);
      const refs = u32(packet, tev + stage * 16 + 8);
      assert.equal(refs & 7, 0);
      assert.equal((refs >> 3) & 7, entry.liveTexCoords[stage]);
      assert.equal(refs & (1 << 6), 1 << 6);
      assert.equal((refs >> 7) & 7, 7);
      assert.equal(u32(packet, tev + stage * 16 + 12), 0);
    }
    for (let stage = stageCount; stage < 16; stage += 1) {
      assert.deepEqual(
        Array.from(packet.slice(tev + stage * 16, tev + stage * 16 + 16)),
        new Array(16).fill(0),
      );
    }
    assert.deepEqual(
      [0, 1, 2, 3].map((channel) =>
        u32(packet, tev + 384 + channel * 4),
      ),
      [0, 1, 2, 3],
    );
  }
});

test("vertex vectors isolate perspective W, non-unit Q, and x=.590", () => {
  const perspective = buildManagedTexturedCoverageOraclePacket(
    "perspective-nearest-keep012",
  );
  const perspectiveLayout = managedTexturedCoveragePacketLayout(
    "perspective-nearest-keep012",
  );
  assert.equal(perspectiveLayout.vertexCount, 3);
  assert.equal(perspectiveLayout.keyOffset, 1296);
  assert.equal(perspectiveLayout.pixelOffset, 1312);
  assert.equal(perspectiveLayout.evidenceOffset, 1328);
  assert.equal(perspectiveLayout.packetBytes, 1344);
  assert.deepEqual(
    Array.from({ length: 3 }, (_, vertex) =>
      f32(
        perspective,
        perspectiveLayout.vertexOffset + vertex * 144 + 12,
      ),
    ),
    managedTexturedCoverageGeometry.perspectiveW,
  );
  assert.deepEqual(
    Array.from({ length: 3 }, (_, vertex) =>
      [0, 1, 2].map((component) =>
        f32(
          perspective,
          perspectiveLayout.vertexOffset +
            vertex * 144 +
            (12 + component) * 4,
        ),
      ),
    ),
    [
      [Math.fround(0.2), Math.fround(0.2), 1],
      [Math.fround(0.2), Math.fround(1.8), 1],
      [Math.fround(1.8), Math.fround(0.2), 1],
    ],
  );
  assert.equal(
    perspective[perspectiveLayout.evidenceOffset],
    managedTexturedCoverageEvidence.keep012,
  );

  const q = buildManagedTexturedCoverageOraclePacket(
    "nonunit-q-linear-keep021",
  );
  const qLayout = managedTexturedCoveragePacketLayout(
    "nonunit-q-linear-keep021",
  );
  assert.equal(qLayout.vertexCount, 4);
  assert.equal(qLayout.keyOffset, 1440);
  assert.equal(qLayout.pixelOffset, 1456);
  assert.equal(qLayout.evidenceOffset, 1472);
  assert.equal(qLayout.packetBytes, 1488);
  assert.equal(f32(q, qLayout.vertexOffset), Math.fround(0.59));
  assert.equal(
    packetView(q).getUint32(qLayout.vertexOffset, true),
    managedTexturedCoverageGeometry.snapSourceXBits,
  );
  assert.equal(
    Math.floor(f32(q, qLayout.vertexOffset) * 16 + 0.5),
    managedTexturedCoverageGeometry.snappedSourceX28_4,
  );
  assert.deepEqual(
    Array.from({ length: 4 }, (_, vertex) =>
      f32(
        q,
        qLayout.vertexOffset + vertex * 144 + (12 + 2) * 4,
      ),
    ),
    [0.5, 2, 2, 0.5],
  );
  assert.equal(
    q[qLayout.evidenceOffset],
    managedTexturedCoverageEvidence.keep021Twice,
  );
});

test("packet vectors expose canonical XFB metadata and reject invalid ids", () => {
  assert.deepEqual(managedTexturedCoverageXfb, {
    destination: 0x00120000,
    width: 4,
    height: 4,
    stride: 16,
  });
  assert.throws(
    () => buildManagedTexturedCoverageOraclePacket("unknown"),
    /unknown managed textured coverage variant/,
  );
  assert.throws(
    () =>
      buildManagedTexturedCoverageOraclePacket(
        "perspective-nearest-keep012",
        -1,
      ),
    /generation must be a u32/,
  );
});
