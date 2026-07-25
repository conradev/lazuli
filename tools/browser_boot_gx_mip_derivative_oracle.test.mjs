import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildGxMipDerivativeOraclePacket,
  buildGxMipDerivativeSequencePacket,
  classifyGxMipDerivativeFingerprint,
  gxMipDerivativeFingerprintCases,
  gxMipDerivativeHardGateCases,
  gxMipDerivativeOracle,
  gxMipDerivativeOracleCases,
  gxMipDerivativeOraclePacketLayout,
  gxMipDerivativeSequenceCases,
  gxMipDerivativeSequencePacketLayout,
  modelGxMipDerivativeLod,
} from "./browser_boot_gx_mip_derivative_oracle.mjs";

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

const softF32 = Math.fround;
const softAdd = (left, right) =>
  softF32(softF32(left) + softF32(right));
const softSubtract = (left, right) =>
  softF32(softF32(left) - softF32(right));
const softMultiply = (left, right) =>
  softF32(softF32(left) * softF32(right));
const softDivide = (left, right) =>
  softF32(softF32(left) / softF32(right));

function softAttributeAtSample(
  sourceX,
  sourceY,
  attributes,
  sampleX,
  sampleY,
) {
  const dx10 = softSubtract(sourceX[1], sourceX[0]);
  const dx20 = softSubtract(sourceX[2], sourceX[0]);
  const dy10 = softSubtract(sourceY[1], sourceY[0]);
  const dy20 = softSubtract(sourceY[2], sourceY[0]);
  const delta20 = softSubtract(attributes[2], attributes[0]);
  const delta10 = softSubtract(attributes[1], attributes[0]);
  const a = softSubtract(
    softMultiply(delta20, dy10),
    softMultiply(delta10, dy20),
  );
  const b = softSubtract(
    softMultiply(dx20, delta10),
    softMultiply(dx10, delta20),
  );
  const c = softSubtract(
    softMultiply(dx20, dy10),
    softMultiply(dx10, dy20),
  );
  const dfdx = softDivide(a, c);
  const dfdy = softDivide(b, c);
  const sampleDx = softSubtract(sampleX, sourceX[0]);
  const sampleDy = softSubtract(sampleY, sourceY[0]);
  return softAdd(
    softAdd(
      attributes[0],
      softMultiply(dfdx, sampleDx),
    ),
    softMultiply(dfdy, sampleDy),
  );
}

function managedQuantizedCoordinate(
  entry,
  triangle,
  pixelX,
  pixelY,
  component,
) {
  const positions = gxMipDerivativeOracle.affinePositions.map(
    ([x, y]) => [softF32(x), softF32(y)],
  );
  const attributes = positions.map(([x, y]) =>
    softF32((
      gxMipDerivativeOracle.baseCoordinateRaw[component] +
      entry.dx[component] * x +
      entry.dy[component] * y
    ) / 128),
  );
  const sourceX = triangle.map(index => positions[index][0]);
  const sourceY = triangle.map(index => positions[index][1]);
  const sourceAttributes = triangle.map(
    index => attributes[index],
  );
  const sampleX = softDivide(
    softAdd(softMultiply(softF32(pixelX), 12), 7),
    12,
  );
  const sampleY = softDivide(
    softAdd(softMultiply(softF32(pixelY), 12), 7),
    12,
  );
  const coordinate = softAttributeAtSample(
    sourceX,
    sourceY,
    sourceAttributes,
    sampleX,
    sampleY,
  );
  return Math.trunc(softMultiply(coordinate, 128));
}

test("builds canonical single-draw V7 derivative packets", () => {
  const layout = gxMipDerivativeOraclePacketLayout();
  for (
    let index = 0;
    index < gxMipDerivativeOracleCases.length;
    index += 1
  ) {
    const entry = gxMipDerivativeOracleCases[index];
    const generation = 0x33000000 + index;
    const packet = buildGxMipDerivativeOraclePacket(
      entry.id,
      generation,
    );
    assert.equal(u16(packet, 0x04), 7);
    assert.equal(u32(packet, 0x08), packet.length);
    assert.equal(u32(packet, 0x14), 1);
    assert.equal(u32(packet, 0x18), 1);
    assert.equal(u32(packet, 0x48), 96);
    assert.equal(u32(packet, 0x6c), generation);
    assert.equal(
      u32(packet, layout.drawOffset + 0x34),
      entry.mode0,
    );
    assert.equal(u32(packet, layout.mode1Offset), entry.mode1);
    assert.equal(
      (entry.mode0 >>> 5) & 3,
      entry.mipMode,
    );
    assert.equal(
      ((entry.mode0 >>> 9) & 0xff) << 24 >> 25,
      entry.biasSixteenths,
    );
    assert.equal(entry.mode1 & 0xff, entry.minLodSixteenths);
    assert.equal(
      (entry.mode1 >>> 8) & 0xff,
      entry.maxLodSixteenths,
    );
    assert.equal(u32(packet, layout.textureOffset + 0x0c), 84);
    assert.equal(u32(packet, layout.textureOffset + 0x18), 4);
    assert.equal(u32(packet, layout.textureOffset + 0x1c), 4);
    assert.equal(u32(packet, layout.textureOffset + 0x24), 3);
    assert.equal(packet[layout.evidenceOffset], 0x0f);
  }
});

test("every MODE1 maximum canonically requires the declared three levels", () => {
  const expectedLevelCount = maxLodSixteenths =>
    Math.ceil(maxLodSixteenths / 16) + 1;
  const vectors = [
    ...gxMipDerivativeOracleCases,
    ...gxMipDerivativeSequenceCases.flatMap(sequence =>
      sequence.order.map(({ state }) => state),
    ),
  ];
  for (const entry of vectors) {
    assert.equal(
      expectedLevelCount(entry.maxLodSixteenths),
      gxMipDerivativeOracle.mipLevelCount,
      `${entry.id} MODE1 maximum must require the full chain`,
    );
  }
  assert.deepEqual(
    gxMipDerivativeHardGateCases
      .filter(entry =>
        ["maximum-clamp", "max-wins-clamp"].includes(
          entry.feature,
        ),
      )
      .map(entry => ({
        id: entry.id,
        maximum: entry.maxLodSixteenths,
      })),
    [
      { id: "maximum-clamp-wide", maximum: 17 },
      { id: "maximum-wins-over-minimum", maximum: 17 },
    ],
  );
  const sequenceA = gxMipDerivativeSequenceCases[0].order.find(
    ({ state }) => state.id === "sequence-a",
  ).state;
  assert.equal(sequenceA.maxLodSixteenths, 32);
  assert.equal(sequenceA.model.selectedLevel, 0);
});

test("writes one managed affine S17.7 plane across both quad triangles", () => {
  const entry = gxMipDerivativeHardGateCases.find(
    candidate => candidate.id === "diagonal-co-component-sum",
  );
  const packet = buildGxMipDerivativeOraclePacket(entry.id);
  const layout = gxMipDerivativeOraclePacketLayout();
  const expectedPositions = gxMipDerivativeOracle.affinePositions;
  const [baseS, baseT] =
    gxMipDerivativeOracle.baseCoordinateRaw;
  for (let vertex = 0; vertex < 4; vertex += 1) {
    const offset = layout.vertexOffset + vertex * 36 * 4;
    const [x, y] = expectedPositions[vertex];
    assert.equal(f32(packet, offset), Math.fround(x));
    assert.equal(f32(packet, offset + 4), Math.fround(y));
    assert.deepEqual(
      [0, 1, 2].map(component =>
        f32(packet, offset + (12 + component) * 4),
      ),
      [
        Math.fround((
          baseS +
          entry.dx[0] * x +
          entry.dy[0] * y
        ) / 128),
        Math.fround((
          baseT +
          entry.dx[1] * x +
          entry.dy[1] * y
        ) / 128),
        1,
      ],
    );
  }
});

test("affine reconstruction quantizes to exact dx/dy on covered and helper lanes", () => {
  // Keep021 post-cull evidence reverses each expanded quad triangle. The
  // helper-lane halo exercises one pixel beyond all four covered edges.
  const triangles = [[0, 2, 1], [0, 3, 2]];
  for (const entry of gxMipDerivativeOracleCases) {
    for (const triangle of triangles) {
      for (let pixelY = -1; pixelY <= 4; pixelY += 1) {
        for (let pixelX = -1; pixelX <= 3; pixelX += 1) {
          for (let component = 0; component < 2; component += 1) {
            const current = managedQuantizedCoordinate(
              entry,
              triangle,
              pixelX,
              pixelY,
              component,
            );
            const nextX = managedQuantizedCoordinate(
              entry,
              triangle,
              pixelX + 1,
              pixelY,
              component,
            );
            const nextY = managedQuantizedCoordinate(
              entry,
              triangle,
              pixelX,
              pixelY + 1,
              component,
            );
            assert.equal(
              nextX - current,
              entry.dx[component],
              `${entry.id} triangle ${triangle} d${component}/dx`,
            );
            assert.equal(
              nextY - current,
              entry.dy[component],
              `${entry.id} triangle ${triangle} d${component}/dy`,
            );
          }
        }
      }
    }
  }
});

test("pins independent wide-margin LOD selections and clamps", () => {
  assert.deepEqual(
    gxMipDerivativeHardGateCases.map(entry => ({
      id: entry.id,
      rhoRaw: entry.model.rhoRaw,
      derivativeLod: entry.model.derivativeLodSixteenths,
      clampedLod: entry.model.clampedLodSixteenths,
      selectedLevel: entry.model.selectedLevel,
    })),
    [
      {
        id: "flat-zero-derivative",
        rhoRaw: 0,
        derivativeLod: 0,
        clampedLod: 0,
        selectedLevel: 0,
      },
      {
        id: "dpdx-wide-level-one",
        rhoRaw: 256,
        derivativeLod: 16,
        clampedLod: 16,
        selectedLevel: 1,
      },
      {
        id: "non-power-trilinear-composition",
        rhoRaw: 194,
        derivativeLod: 9,
        clampedLod: 9,
        selectedLevel: null,
      },
      {
        id: "negative-gradient-absolute",
        rhoRaw: 256,
        derivativeLod: 16,
        clampedLod: 16,
        selectedLevel: 1,
      },
      {
        id: "dpdy-wide-level-two",
        rhoRaw: 512,
        derivativeLod: 32,
        clampedLod: 32,
        selectedLevel: 2,
      },
      {
        id: "edge-co-component-control",
        rhoRaw: 128,
        derivativeLod: 0,
        clampedLod: 0,
        selectedLevel: 0,
      },
      {
        id: "diagonal-co-component-sum",
        rhoRaw: 256,
        derivativeLod: 16,
        clampedLod: 16,
        selectedLevel: 1,
      },
      {
        id: "diagonal-cross-component-control",
        rhoRaw: 128,
        derivativeLod: 0,
        clampedLod: 0,
        selectedLevel: 0,
      },
      {
        id: "positive-signed-bias-wide",
        rhoRaw: 256,
        derivativeLod: 32,
        clampedLod: 32,
        selectedLevel: 2,
      },
      {
        id: "negative-signed-bias-wide",
        rhoRaw: 256,
        derivativeLod: 0,
        clampedLod: 0,
        selectedLevel: 0,
      },
      {
        id: "minimum-clamp-below-minimum",
        rhoRaw: 128,
        derivativeLod: 0,
        clampedLod: 16,
        selectedLevel: 1,
      },
      {
        id: "maximum-clamp-wide",
        rhoRaw: 1024,
        derivativeLod: 48,
        clampedLod: 17,
        selectedLevel: 1,
      },
      {
        id: "maximum-wins-over-minimum",
        rhoRaw: 512,
        derivativeLod: 32,
        clampedLod: 17,
        selectedLevel: 1,
      },
      {
        id: "nearest-threshold-seven-sixteenths",
        rhoRaw: 128,
        derivativeLod: 7,
        clampedLod: 7,
        selectedLevel: 0,
      },
      {
        id: "nearest-threshold-eight-sixteenths",
        rhoRaw: 128,
        derivativeLod: 8,
        clampedLod: 8,
        selectedLevel: 1,
      },
    ],
  );

  const features = new Set(
    gxMipDerivativeHardGateCases.map(entry => entry.feature),
  );
  for (const feature of [
    "flat",
    "dpdx",
    "non-power-trilinear-composition",
    "negative-gradient-absolute",
    "dpdy",
    "edge-component-max",
    "diagonal-component-sum",
    "diagonal-component-control",
    "positive-signed-bias",
    "negative-signed-bias",
    "minimum-clamp",
    "maximum-clamp",
    "max-wins-clamp",
    "nearest-threshold-below",
    "nearest-threshold-at",
  ]) {
    assert.ok(features.has(feature), `missing ${feature}`);
  }
  assert.equal(
    gxMipDerivativeHardGateCases.filter(
      entry => entry.margin === "wide",
    ).length,
    13,
  );
  const nonPower = gxMipDerivativeHardGateCases.find(
    entry => entry.id === "non-power-trilinear-composition",
  );
  assert.equal(nonPower.mipMode, 2);
  assert.deepEqual(nonPower.expectedRgba, [120, 134, 89, 255]);
  assert.equal(
    nonPower.expectedSurfaceFnv1a64,
    "0xf6f231ed387c6285",
  );
  const negative = gxMipDerivativeHardGateCases.find(
    entry => entry.id === "negative-gradient-absolute",
  );
  assert.deepEqual(negative.dx, [-256, 0]);
  assert.deepEqual(negative.model.deltaX, [256, 0]);
  const minimum = gxMipDerivativeHardGateCases.find(
    entry => entry.feature === "minimum-clamp",
  );
  assert.ok(
    minimum.model.derivativeLodSixteenths <
      minimum.model.effectiveMinLodSixteenths,
  );
});

test("keeps 1/16 derivative boundaries as modeled adapter fingerprints", () => {
  assert.deepEqual(
    gxMipDerivativeFingerprintCases.map(entry => ({
      id: entry.id,
      dx: entry.dx,
      lod: entry.model.derivativeLodSixteenths,
      rgba: entry.expectedRgba,
    })),
    [
      {
        id: "adapter-boundary-1-16-below",
        dx: [133, 0],
        lod: 0,
        rgba: [225, 35, 69, 255],
      },
      {
        id: "adapter-boundary-1-16-above",
        dx: [134, 0],
        lod: 1,
        rgba: [213, 46, 71, 255],
      },
    ],
  );
  assert.ok(
    gxMipDerivativeOracle.derivativeBoundary.belowRaw <
      gxMipDerivativeOracle.derivativeBoundary.rhoRaw,
  );
  assert.ok(
    gxMipDerivativeOracle.derivativeBoundary.aboveRaw >
      gxMipDerivativeOracle.derivativeBoundary.rhoRaw,
  );
  assert.match(
    gxMipDerivativeOracle.derivativeLodOracleGap,
    /same-adapter fingerprint/,
  );
  assert.match(
    gxMipDerivativeOracle.derivativeLodOracleGap,
    /not a universal cross-adapter byte-exact requirement/,
  );
});

test("fingerprint buckets must be uniform and plausibly adjacent", () => {
  assert.deepEqual(
    classifyGxMipDerivativeFingerprint([0, 0, 0, 0]),
    {
      uniformBucket: true,
      observedBucket: 0,
      plausibleBucket: true,
    },
  );
  assert.deepEqual(
    classifyGxMipDerivativeFingerprint([1, 1, 1, 1]),
    {
      uniformBucket: true,
      observedBucket: 1,
      plausibleBucket: true,
    },
  );
  assert.deepEqual(
    classifyGxMipDerivativeFingerprint([0, 1, 0, 1]),
    {
      uniformBucket: false,
      observedBucket: null,
      plausibleBucket: false,
    },
    "a mixed boundary result is not an adapter fingerprint",
  );
  assert.deepEqual(
    classifyGxMipDerivativeFingerprint([32, 32]),
    {
      uniformBucket: true,
      observedBucket: 32,
      plausibleBucket: false,
    },
    "an unrelated resident mip cannot pass the boundary fingerprint",
  );
  assert.deepEqual(
    classifyGxMipDerivativeFingerprint([]),
    {
      uniformBucket: false,
      observedBucket: null,
      plausibleBucket: false,
    },
  );
  assert.throws(
    () => classifyGxMipDerivativeFingerprint("0"),
    /must be an array/,
  );
});

test("models edge, diagonal, signed bias, max-wins, and nearest threshold independently", () => {
  assert.deepEqual(
    modelGxMipDerivativeLod({
      dx: [-128, 64],
      dy: [256, -512],
    }).combinedDelta,
    [256, 512],
  );
  assert.deepEqual(
    modelGxMipDerivativeLod({
      dx: [-128, 64],
      dy: [256, -512],
      diagonal: true,
    }).combinedDelta,
    [384, 576],
  );
  assert.equal(
    modelGxMipDerivativeLod({
      dx: [128, 0],
      biasSixteenths: -7,
    }).derivativeLodSixteenths,
    -7,
  );
  assert.deepEqual(
    modelGxMipDerivativeLod({
      dx: [512, 0],
      minLodSixteenths: 32,
      maxLodSixteenths: 17,
    }),
    {
      deltaX: [512, 0],
      deltaY: [0, 0],
      combinedDelta: [512, 0],
      rhoRaw: 512,
      rho: 4,
      effectiveMinLodSixteenths: 17,
      derivativeLodSixteenths: 32,
      clampedLodSixteenths: 17,
      selectedLevel: 1,
      expectedRgba: [39, 211, 105, 255],
    },
  );
  assert.equal(
    modelGxMipDerivativeLod({
      dx: [128, 0],
      biasSixteenths: 7,
    }).selectedLevel,
    0,
  );
  assert.equal(
    modelGxMipDerivativeLod({
      dx: [128, 0],
      biasSixteenths: 8,
    }).selectedLevel,
    1,
  );
});

test("builds canonical A/B/B/A packets in forward and permuted record order", () => {
  const layout = gxMipDerivativeSequencePacketLayout();
  const encodedRecordOrders = [];
  assert.deepEqual(
    {
      packetBytes: layout.packetBytes,
      drawOffset: layout.drawOffset,
      textureOffset: layout.textureOffset,
      tevOffset: layout.tevOffset,
      vertexOffset: layout.vertexOffset,
      keyOffset: layout.keyOffset,
      pixelOffset: layout.pixelOffset,
      evidenceOffset: layout.evidenceOffset,
      mode1Offset: layout.mode1Offset,
    },
    {
      packetBytes: 5344,
      drawOffset: 160,
      textureOffset: 864,
      tevOffset: 928,
      vertexOffset: 2784,
      keyOffset: 5088,
      pixelOffset: 5104,
      evidenceOffset: 5200,
      mode1Offset: 5216,
    },
  );

  for (
    let sequenceIndex = 0;
    sequenceIndex < gxMipDerivativeSequenceCases.length;
    sequenceIndex += 1
  ) {
    const sequence = gxMipDerivativeSequenceCases[sequenceIndex];
    const generation = 0x44000000 + sequenceIndex;
    const packet = buildGxMipDerivativeSequencePacket(
      sequence.id,
      generation,
    );
    assert.equal(u16(packet, 0x04), 7);
    assert.equal(u32(packet, 0x08), layout.packetBytes);
    assert.equal(u32(packet, 0x14), 4);
    assert.equal(u32(packet, 0x18), 1);
    assert.equal(u32(packet, 0x1c), layout.drawOffset);
    assert.equal(u32(packet, 0x20), layout.textureOffset);
    assert.equal(u32(packet, 0x24), layout.tevOffset);
    assert.equal(u32(packet, 0x28), layout.vertexOffset);
    assert.equal(u32(packet, 0x2c), layout.keyOffset);
    assert.equal(u32(packet, 0x30), layout.pixelOffset);
    assert.equal(u32(packet, 0x34), layout.drawBytes);
    assert.equal(u32(packet, 0x38), layout.textureBytes);
    assert.equal(u32(packet, 0x3c), layout.tevBytes);
    assert.equal(u32(packet, 0x40), layout.vertexBytes);
    assert.equal(u32(packet, 0x44), layout.keyBytes);
    assert.equal(u32(packet, 0x48), layout.pixelBytes);
    assert.equal(u32(packet, 0x54), 16);
    assert.equal(u32(packet, 0x58), 4);
    assert.equal(u32(packet, 0x5c), 16);
    assert.equal(u32(packet, 0x60), 4);
    assert.equal(u32(packet, 0x68), 64);
    assert.equal(u32(packet, 0x6c), generation);
    assert.equal(u32(packet, 0x7c), 16);
    assert.deepEqual(
      Array.from(
        packet.subarray(
          layout.pixelOffset,
          layout.pixelOffset + gxMipDerivativeOracle.payloadBytes,
        ),
      ),
      Array.from(
        buildGxMipDerivativeOraclePacket(
          "flat-zero-derivative",
        ).subarray(
          gxMipDerivativeOraclePacketLayout().pixelOffset,
          gxMipDerivativeOraclePacketLayout().pixelOffset +
            gxMipDerivativeOracle.payloadBytes,
        ),
      ),
    );

    const encodedRecords = [];
    for (let draw = 0; draw < 4; draw += 1) {
      const drawOffset =
        layout.drawOffset + draw * layout.drawRecordBytes;
      const { slot, state: expected } = sequence.order[draw];
      const encodedMode0 = u32(packet, drawOffset + 0x34);
      const encodedMode1 = u32(
        packet,
        layout.mode1Offset + draw * 32,
      );
      assert.equal(
        u32(packet, drawOffset + 0x08),
        draw * layout.vertexBytesPerDraw,
      );
      assert.equal(
        u32(packet, drawOffset + 0x0c),
        draw * layout.tevRecordBytes,
      );
      assert.equal(u32(packet, drawOffset + 0x1c), slot * 4);
      assert.equal(u32(packet, drawOffset + 0x20), 0);
      assert.equal(u32(packet, drawOffset + 0x24), 4);
      assert.equal(u32(packet, drawOffset + 0x28), 4);
      assert.equal(encodedMode0, expected.mode0);
      assert.equal(packet[layout.evidenceOffset + draw], 0x0f);
      assert.equal(encodedMode1, expected.mode1);
      encodedRecords.push({
        slot: u32(packet, drawOffset + 0x1c) / 4,
        mode0: encodedMode0,
        mode1: encodedMode1,
      });
      assert.deepEqual(
        Array.from(
          packet.subarray(
            layout.mode1Offset + draw * 32 + 4,
            layout.mode1Offset + (draw + 1) * 32,
          ),
        ),
        Array(28).fill(0),
      );
    }
    encodedRecordOrders.push({
      id: sequence.id,
      records: encodedRecords,
    });
  }

  assert.deepEqual(
    encodedRecordOrders,
    [
      {
        id: "cross-draw-abba",
        records: [
          { slot: 0, mode0: 0x1c020, mode1: 0x2000 },
          { slot: 1, mode0: 0x04020, mode1: 0x2020 },
          { slot: 2, mode0: 0x04020, mode1: 0x2020 },
          { slot: 3, mode0: 0x1c020, mode1: 0x2000 },
        ],
      },
      {
        id: "cross-draw-abba-permuted-records",
        records: [
          { slot: 1, mode0: 0x04020, mode1: 0x2020 },
          { slot: 0, mode0: 0x1c020, mode1: 0x2000 },
          { slot: 3, mode0: 0x1c020, mode1: 0x2000 },
          { slot: 2, mode0: 0x04020, mode1: 0x2020 },
        ],
      },
    ],
    "each draw record must keep its slot, MODE0, and MODE1 tail attached",
  );
  assert.deepEqual(
    gxMipDerivativeSequenceCases.map(sequence => ({
      id: sequence.id,
      order: sequence.order.map(entry => ({
        slot: entry.slot,
        state: entry.state.id,
      })),
      fnv: sequence.expectedSurfaceFnv1a64,
    })),
    [
      {
        id: "cross-draw-abba",
        order: [
          { slot: 0, state: "sequence-a" },
          { slot: 1, state: "sequence-b" },
          { slot: 2, state: "sequence-b" },
          { slot: 3, state: "sequence-a" },
        ],
        fnv: "0xa33bc3041a403225",
      },
      {
        id: "cross-draw-abba-permuted-records",
        order: [
          { slot: 1, state: "sequence-b" },
          { slot: 0, state: "sequence-a" },
          { slot: 3, state: "sequence-a" },
          { slot: 2, state: "sequence-b" },
        ],
        fnv: "0xa33bc3041a403225",
      },
    ],
  );
  assert.deepEqual(
    gxMipDerivativeSequenceCases[0].expectedSurface,
    gxMipDerivativeSequenceCases[1].expectedSurface,
    "permuting draw records must preserve spatial A/B/B/A",
  );
  assert.deepEqual(
    gxMipDerivativeSequenceCases.map(sequence =>
      sequence.order.map(({ state }) => state.id),
    ),
    [
      ["sequence-a", "sequence-b", "sequence-b", "sequence-a"],
      ["sequence-b", "sequence-a", "sequence-a", "sequence-b"],
    ],
    "the second packet must carry literal B/A/A/B record state",
  );
  assert.deepEqual(
    gxMipDerivativeSequenceCases.map(sequence =>
      [...sequence.order]
        .sort((left, right) => left.slot - right.slot)
        .map(({ state }) => state.id),
    ),
    [
      ["sequence-a", "sequence-b", "sequence-b", "sequence-a"],
      ["sequence-a", "sequence-b", "sequence-b", "sequence-a"],
    ],
    "both record orders must retain spatial A/B/B/A",
  );
});

test("reference model stays coupled to the derivative-driven WGSL path", () => {
  const samplerSource = readFileSync(
    new URL("../crates/browser-renderer/src/tev.rs", import.meta.url),
    "utf8",
  );
  assert.match(
    samplerSource,
    /let s17_7 = vec2<i32>\(uv \* 128\.0\);/,
  );
  assert.match(
    samplerSource,
    /let uv_delta_x = abs\(dpdxCoarse\(vec2<f32>\(s17_7\)\)\);/,
  );
  assert.match(
    samplerSource,
    /let uv_delta_y = abs\(dpdyCoarse\(vec2<f32>\(s17_7\)\)\);/,
  );
  assert.match(
    samplerSource,
    /var uv_delta = max\(uv_delta_x, uv_delta_y\);/,
  );
  assert.match(
    samplerSource,
    /uv_delta = uv_delta_x \+ uv_delta_y;/,
  );
  assert.match(
    samplerSource,
    /let rho = max\(uv_delta\.x, uv_delta\.y\) \/ 128\.0;/,
  );
  assert.match(
    samplerSource,
    /let min_lod = min\(i32\(mode1 & 0xffu\), max_lod\);/,
  );
  assert.match(
    samplerSource,
    /let bias_sixteenths = select\(0, signed_bias >> 1u, mip_mode != 0u\);/,
  );
  assert.match(
    samplerSource,
    /i32\(floor\(log2\(rho\) \* 16\.0\)\) \+ bias_sixteenths/,
  );
  assert.match(
    samplerSource,
    /lod = clamp\(lod, min_lod, max_lod\);/,
  );
  assert.match(
    samplerSource,
    /mip_mode == 1u && fractional_lod >= 8u/,
  );
  assert.match(
    samplerSource,
    /if mip_mode == 2u && fractional_lod != 0u/,
  );
  assert.match(
    samplerSource,
    /next \* vec4<u32>\(fractional_lod\)\) >> vec4<u32>\(4u\)/,
  );
  assert.match(
    samplerSource,
    /let sample_x_numerator = floor\(input\.position\.x\) \* 12\.0 \+ 7\.0;/,
  );
  assert.match(
    samplerSource,
    /let reconstructed_stq = vec3<f32>\([\s\S]*s_over_w \* projection,[\s\S]*t_over_w \* projection,/,
  );
});

test("rejects invalid derivative definitions and packet identifiers", () => {
  assert.throws(
    () => modelGxMipDerivativeLod({ dx: [0.5, 0] }),
    /integer S17\.7 delta/,
  );
  assert.throws(
    () => modelGxMipDerivativeLod({ dx: [0, 0, 0] }),
    /must have two components/,
  );
  assert.throws(
    () => modelGxMipDerivativeLod({
      biasSixteenths: -65,
    }),
    /between -64 and 63/,
  );
  assert.throws(
    () => modelGxMipDerivativeLod({
      minLodSixteenths: -1,
    }),
    /unsigned byte/,
  );
  assert.throws(
    () => modelGxMipDerivativeLod({
      mipMode: 0,
    }),
    /must be nearest or linear/,
  );
  assert.throws(
    () => buildGxMipDerivativeOraclePacket("missing"),
    /unknown GX derivative mip oracle vector/,
  );
  assert.throws(
    () => buildGxMipDerivativeSequencePacket("missing"),
    /unknown GX derivative mip sequence/,
  );
  assert.throws(
    () => buildGxMipDerivativeOraclePacket(
      "flat-zero-derivative",
      -1,
    ),
    /must be a u32/,
  );
});
