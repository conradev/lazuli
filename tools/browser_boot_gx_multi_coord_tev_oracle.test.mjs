import assert from "node:assert/strict";
import test from "node:test";

import {
  modelGxMultiCoordTevSurface,
} from "./browser_boot_gx_multi_coord_tev_oracle.mjs";
import {
  fnv1a64Hex,
} from "./browser_boot_managed_textured_coverage_vectors.mjs";

const cases = [
  {
    id: "coord2-map1-then-coord7-map6",
    expected: "0xafd7d3435fb81ac4",
    predivided: "0x046d54d8a1e874dd",
    swapped: "0xe7f5f44a90ceebdc",
    first: [108, 138, 168, 255],
    last: [248, 98, 38, 255],
  },
  {
    id: "coord7-map6-then-coord2-map1",
    expected: "0x035eeb3e5d1d6be8",
    predivided: "0x92d6ce3938f4fc75",
    swapped: "0xe47066957bdf570e",
    first: [148, 118, 88, 255],
    last: [8, 158, 218, 255],
  },
];

test("models nonconsecutive texture coordinates with post-interpolation Q", () => {
  for (const entry of cases) {
    const rgba = modelGxMultiCoordTevSurface(entry.id);
    const predivided = modelGxMultiCoordTevSurface(
      entry.id,
      { predivideBeforeInterpolation: true },
    );
    const swapped = modelGxMultiCoordTevSurface(
      entry.id,
      { swapCoordinates: true },
    );
    const rawTriangleOrder = modelGxMultiCoordTevSurface(
      entry.id,
      { rawTriangleOrder: true },
    );

    assert.equal(rgba.length, 4 * 4 * 4);
    assert.equal(fnv1a64Hex(rgba), entry.expected);
    assert.equal(fnv1a64Hex(predivided), entry.predivided);
    assert.equal(fnv1a64Hex(swapped), entry.swapped);
    assert.equal(fnv1a64Hex(rawTriangleOrder), "0x0852db856e95b5a5");
    assert.deepEqual(rgba.slice(0, 4), entry.first);
    assert.deepEqual(rgba.slice(-4), entry.last);
    assert.notEqual(fnv1a64Hex(rgba), fnv1a64Hex(predivided));
    assert.notEqual(fnv1a64Hex(rgba), fnv1a64Hex(swapped));
  }

  assert.notEqual(cases[0].expected, cases[1].expected);
  assert.throws(
    () => modelGxMultiCoordTevSurface("missing"),
    /unknown GX multi-coordinate TEV vector/,
  );
});
