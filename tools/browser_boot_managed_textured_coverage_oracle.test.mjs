import assert from "node:assert/strict";
import test from "node:test";

import {
  fnv1a64Hex,
  managedTexturedCoverageExpectedMetrics,
  managedTexturedCoverageGeometry,
  managedTexturedCoverageMask,
  managedTexturedCoverageOracleCases,
  managedTexturedCoveragePerspectiveComponent,
} from "./browser_boot_managed_textured_coverage_oracle.mjs";

function pixel(rgba, x, y) {
  const offset = (y * 4 + x) * 4;
  return rgba.slice(offset, offset + 4);
}

function f32FromBits(bits) {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}

function f32Bits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

test("RGBA vectors distinguish perspective and post-interpolation Q division", () => {
  const expectedHashes = {
    "perspective-nearest-keep012": "0x6c2437786a531e65",
    "nonunit-q-linear-keep021": "0xdb0dc4a013c9c6a9",
    "second-live-coordinate-native": "0x219b8880a91f5b09",
    "mip-min-filter-native": "0xae26e4ebfeba919b",
  };
  const comparisonHashes = {
    "perspective-nearest-keep012": "0xd4f54dab94251865",
    "nonunit-q-linear-keep021": "0x0065077998d8c5c4",
  };
  assert.deepEqual(
    Object.fromEntries(
      managedTexturedCoverageOracleCases.map((entry) => [
        entry.id,
        entry.expectedRgbaFnv1a64,
      ]),
    ),
    expectedHashes,
  );

  const perspective = managedTexturedCoverageOracleCases[0];
  assert.equal(
    perspective.comparisonRgbaFnv1a64,
    comparisonHashes[perspective.id],
  );
  assert.notEqual(
    perspective.expectedRgbaFnv1a64,
    perspective.comparisonRgbaFnv1a64,
  );
  assert.deepEqual(pixel(perspective.expectedRgba, 1, 0), [
    229, 17, 73, 255,
  ]);
  assert.deepEqual(pixel(perspective.comparisonRgba, 1, 0), [
    13, 31, 47, 255,
  ]);

  const nonunitQ = managedTexturedCoverageOracleCases[1];
  assert.equal(
    nonunitQ.comparisonRgbaFnv1a64,
    comparisonHashes[nonunitQ.id],
  );
  assert.notEqual(
    nonunitQ.expectedRgbaFnv1a64,
    nonunitQ.comparisonRgbaFnv1a64,
  );
  assert.deepEqual(pixel(nonunitQ.expectedRgba, 1, 1), [
    52, 82, 52, 255,
  ]);
  assert.deepEqual(pixel(nonunitQ.comparisonRgba, 1, 1), [
    25, 77, 42, 255,
  ]);

  for (const entry of managedTexturedCoverageOracleCases) {
    assert.equal(entry.expectedRgba.length, 64);
    assert.equal(
      fnv1a64Hex(entry.expectedRgba),
      entry.expectedRgbaFnv1a64,
    );
    assert.equal(
      managedTexturedCoverageMask(entry.expectedRgba),
      entry.expectedMask,
    );
  }
  assert.deepEqual(
    managedTexturedCoverageOracleCases.map(
      ({ id, expectedMask }) => ({ id, expectedMask }),
    ),
    [
      { id: "perspective-nearest-keep012", expectedMask: 0xffff },
      { id: "nonunit-q-linear-keep021", expectedMask: 0xffff },
      { id: "second-live-coordinate-native", expectedMask: 0xeeee },
      { id: "mip-min-filter-native", expectedMask: 0xeeee },
    ],
  );
});

test("perspective reference preserves Dolphin's float32 operation sequence", () => {
  const inverseW = f32FromBits(0xc15fd03a);
  const componentOverW = f32FromBits(0x38b9ad14);
  const qOverW = f32FromBits(0x3a969549);
  assert.equal(
    f32Bits(
      managedTexturedCoveragePerspectiveComponent(
        inverseW,
        componentOverW,
        qOverW,
      ),
    ),
    0x3d9dd47c,
  );
  assert.equal(
    f32Bits(Math.fround(componentOverW / qOverW)),
    0x3d9dd47b,
    "algebraically simplified division must remain distinguishable",
  );
});

test("managed metric contract counts only eligible trusted triangles", () => {
  assert.deepEqual(
    {
      sampleNumerator:
        managedTexturedCoverageGeometry.sampleNumerator,
      sampleDenominator:
        managedTexturedCoverageGeometry.sampleDenominator,
    },
    {
      sampleNumerator: 7,
      sampleDenominator: 12,
    },
  );
  assert.deepEqual(managedTexturedCoverageExpectedMetrics, {
    perRun: {
      managedCoverageDraws: 2,
      managedCoverageTriangles: 3,
    },
    twoRuns: {
      managedCoverageDraws: 4,
      managedCoverageTriangles: 6,
    },
  });
  assert.throws(
    () => managedTexturedCoverageMask(new Uint8Array(4)),
    /one 4x4 RGBA surface/,
  );
});
