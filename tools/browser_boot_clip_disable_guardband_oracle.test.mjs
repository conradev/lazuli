// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIP_DISABLE_GUARDBAND_ADJACENT_OUTWARD,
  CLIP_DISABLE_GUARDBAND_MODES,
  CLIP_DISABLE_GUARDBAND_RUN_COUNT,
  CLIP_DISABLE_GUARDBAND_SCOPE,
  clipDisableGuardbandCases,
  clipDisableGuardbandCertificationMatrix,
  clipDisableGuardbandExactState,
  clipDisableGuardbandExpectation,
  clipDisableGuardbandMaskRows,
  clipDisableGuardbandOracleXfb,
  nextDownF32,
} from "./browser_boot_clip_disable_guardband_oracle.mjs";

const f32 = Math.fround;

function float32Bits(value) {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value);
  return view.getUint32(0);
}

function caseById(caseId) {
  const entry = clipDisableGuardbandCases.find(
    (candidate) => candidate.id === caseId,
  );
  assert.notEqual(entry, undefined);
  return entry;
}

function expectedRows(entries) {
  const rows = new Array(16).fill(0);
  for (const [row, mask] of entries) rows[row] = mask;
  return rows;
}

test("guardband boundary uses exact -2W and its adjacent outward f32", () => {
  assert.equal(float32Bits(-2), 0xc0000000);
  assert.equal(float32Bits(nextDownF32(-2)), 0xc0000001);
  assert.equal(float32Bits(CLIP_DISABLE_GUARDBAND_ADJACENT_OUTWARD), 0xc0000001);
  assert.equal(
    CLIP_DISABLE_GUARDBAND_ADJACENT_OUTWARD,
    -2.000000238418579,
  );

  const exactX = caseById("negative-x-exact-boundary");
  const adjacentX = caseById("negative-x-adjacent-outward");
  assert.equal(exactX.exactClipPositions[0][0], -2);
  assert.equal(
    adjacentX.exactClipPositions[0][0],
    CLIP_DISABLE_GUARDBAND_ADJACENT_OUTWARD,
  );

  const exactY = caseById("top-y-exact-boundary");
  const adjacentY = caseById("top-y-adjacent-outward");
  assert.equal(exactY.exactClipPositions[0][1], 2);
  assert.equal(float32Bits(adjacentY.exactClipPositions[0][1]), 0x40000001);
});

test("oracle is explicitly bounded to positive-W, in-EFB unsigned payloads", () => {
  assert.equal(
    CLIP_DISABLE_GUARDBAND_SCOPE,
    "unit-positive-w-in-efb-unsigned",
  );
  assert.deepEqual(clipDisableGuardbandOracleXfb, {
    destination: 0x00110000,
    width: 16,
    height: 16,
    stride: 64,
  });
  assert.deepEqual(clipDisableGuardbandExactState.viewport, [
    2,
    -2,
    0x00ffffff,
    350,
    350,
    0x00ffffff,
  ]);

  for (const entry of clipDisableGuardbandCases) {
    for (const position of entry.exactClipPositions) {
      assert.ok(position[3] > 0, `${entry.id} must keep W positive`);
      const projected = [
        f32(
          f32(
            f32(f32(position[0] / position[3]) * 2) + 350,
          ) - 342,
        ),
        f32(
          f32(
            f32(f32(position[1] / position[3]) * -2) + 350,
          ) - 342,
        ),
      ];
      assert.ok(projected[0] >= 0 && projected[0] <= 16);
      assert.ok(projected[1] >= 0 && projected[1] <= 16);
    }
  }
});

test("f32 projection and the GX 7/12 sample derive the pinned masks", () => {
  const xWide = expectedRows([
    [6, 0x0070],
    [7, 0x0070],
    [8, 0x0070],
  ]);
  const xUniform = expectedRows([
    [6, 0x0030],
    [7, 0x0030],
    [8, 0x0030],
  ]);
  const yWide = expectedRows([
    [4, 0x01c0],
    [5, 0x01c0],
    [6, 0x01c0],
  ]);
  const yUniform = expectedRows([
    [4, 0x01c0],
    [5, 0x01c0],
  ]);
  const fixtures = [
    ["negative-x-inside-guardband", 0, xWide, 9, "0xd142e6c777351b65"],
    ["negative-x-exact-boundary", 7, xWide, 9, "0xd142e6c777351b65"],
    ["negative-x-adjacent-outward", 0, xWide, 9, "0xd142e6c777351b65"],
    ["negative-x-bounded-outside", 0, xWide, 9, "0xd142e6c777351b65"],
    ["negative-x-uniform-same-side", 2, xUniform, 6, "0x114795d883ce7125"],
    ["top-y-inside-guardband", 0, yWide, 9, "0x1c2a04a47a98a2e5"],
    ["top-y-exact-boundary", 7, yWide, 9, "0x1c2a04a47a98a2e5"],
    ["top-y-adjacent-outward", 0, yWide, 9, "0x1c2a04a47a98a2e5"],
    ["top-y-bounded-outside", 0, yWide, 9, "0x1c2a04a47a98a2e5"],
    ["top-y-uniform-same-side", 2, yUniform, 6, "0xafbca7d5c1118b25"],
  ];
  for (const [caseId, mode, rows, pixels, hash] of fixtures) {
    const expected = clipDisableGuardbandExpectation(caseId, mode);
    assert.deepEqual(expected.expectedMaskRows, rows, caseId);
    assert.deepEqual(
      clipDisableGuardbandMaskRows(expected.expectedRgba),
      rows,
      caseId,
    );
    assert.equal(expected.expectedPixelCount, pixels, caseId);
    assert.equal(expected.expectedRgbaFnv1a64, hash, caseId);
  }

  for (const fixture of [
    ["negative-x-adjacent-outward", 1],
    ["negative-x-bounded-outside", 5],
    ["top-y-adjacent-outward", 7],
    ["top-y-bounded-outside", 3],
    ["negative-x-uniform-same-side", 0],
    ["top-y-uniform-same-side", 5],
  ]) {
    const expected = clipDisableGuardbandExpectation(...fixture);
    assert.deepEqual(expected.expectedMaskRows, new Array(16).fill(0));
    assert.equal(expected.expectedPixelCount, 0);
    assert.equal(expected.expectedRgbaFnv1a64, "0x01ebcdb597074b25");
  }
});

test("all eight modes select the intended guardband path and triangle count", () => {
  for (const axis of ["negative-x", "top-y"]) {
    for (const suffix of ["inside-guardband", "exact-boundary"]) {
      for (const mode of CLIP_DISABLE_GUARDBAND_MODES) {
        const expected = clipDisableGuardbandExpectation(
          `${axis}-${suffix}`,
          mode,
        );
        assert.equal(expected.path, "guardband-accepted");
        assert.equal(expected.visible, true);
        assert.deepEqual(expected.expectedManagedCoverage, {
          draws: 1,
          triangles: 2,
        });
      }
    }

    for (const [suffix, managedTriangles] of [
      ["adjacent-outward", 2],
      ["bounded-outside", 3],
    ]) {
      const outward = CLIP_DISABLE_GUARDBAND_MODES.map((mode) =>
        clipDisableGuardbandExpectation(`${axis}-${suffix}`, mode),
      );
      assert.deepEqual(
        outward.map(
          (entry) => entry.expectedManagedCoverage.triangles,
        ),
        [
          managedTriangles,
          0,
          managedTriangles,
          0,
          managedTriangles,
          0,
          managedTriangles,
          0,
        ],
      );
      assert.deepEqual(
        outward.map((entry) => entry.path),
        [
          "guardband-clipped",
          "policy-fail-closed",
          "guardband-clipped",
          "policy-fail-closed",
          "guardband-clipped",
          "policy-fail-closed",
          "guardband-clipped",
          "policy-fail-closed",
        ],
      );
      for (const mode of [1, 3, 5, 7]) {
        assert.deepEqual(outward[mode].expectedRejection, {
          aggregate: 1,
          exactPreparation: 1,
          preparationReason: `unsupportedClipDisable${mode}`,
        });
        assert.equal(outward[mode].expectedExactRasterEmptyDraws, 0);
      }
    }
    assert.deepEqual(
      CLIP_DISABLE_GUARDBAND_MODES.map((mode) =>
        clipDisableGuardbandExpectation(
          `${axis}-adjacent-outward`,
          mode,
        ).expectedGeneratedTriangles,
      ),
      [3, 0, 3, 0, 3, 0, 3, 0],
    );

    const uniform = CLIP_DISABLE_GUARDBAND_MODES.map((mode) =>
      clipDisableGuardbandExpectation(
        `${axis}-uniform-same-side`,
        mode,
      ),
    );
    assert.deepEqual(
      uniform.map((entry) => entry.expectedManagedCoverage.triangles),
      [0, 0, 2, 2, 0, 0, 2, 2],
    );
    assert.deepEqual(
      uniform.map((entry) => entry.expectedExactRasterEmptyDraws),
      [1, 1, 0, 0, 1, 1, 0, 0],
    );
    for (const mode of [2, 3, 6, 7]) {
      assert.equal(uniform[mode].path, "trivial-rejection-bypassed");
      assert.equal(
        uniform[mode].evidence.classification,
        "manual-register-inference",
      );
    }
  }
});

test("two-run certification matrix covers every case and mode twice", () => {
  const matrix = clipDisableGuardbandCertificationMatrix();
  assert.equal(CLIP_DISABLE_GUARDBAND_RUN_COUNT, 2);
  assert.equal(matrix.length, 160);
  assert.deepEqual(
    matrix.map((entry) => entry.generation),
    Array.from({ length: 160 }, (_unused, index) => index + 1),
  );
  for (const entry of clipDisableGuardbandCases) {
    for (const mode of CLIP_DISABLE_GUARDBAND_MODES) {
      assert.equal(
        matrix.filter(
          (candidate) =>
            candidate.caseId === entry.id && candidate.mode === mode,
        ).length,
        2,
      );
    }
  }
});
