#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  IN_FRUSTUM_CLIP_DISABLE_MODES,
  IN_FRUSTUM_CLIP_DISABLE_VARIANT,
  evaluateInFrustumClipDisable,
  inFrustumClipDisableOracleCase,
} from "./browser_boot_clip_disable_noop_oracle.mjs";

function diagnostics({
  aggregate = 0,
  exactPreparation = 0,
  unsupportedClipDisable7 = 0,
  managedCoverageDraws = 0,
  managedCoverageTriangles = 0,
} = {}) {
  return {
    exactRequiredRejectedDraws: aggregate,
    exactRequiredRejectionReasons: {
      exactPreparation,
    },
    exactRequiredPreparationRejectionReasons: {
      unsupportedClipDisable7,
    },
    managedCoverageDraws,
    managedCoverageTriangles,
  };
}

const exactReadback = () => ({
  width: 4,
  height: 4,
  rgba: Uint8Array.from(inFrustumClipDisableOracleCase.expectedRgba),
});

test("all eight defined modes share one safe exact-WebGPU contract", () => {
  assert.deepEqual(
    IN_FRUSTUM_CLIP_DISABLE_MODES,
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(IN_FRUSTUM_CLIP_DISABLE_VARIANT, "raster0");
  assert.deepEqual(
    inFrustumClipDisableOracleCase.expectedManagedCoverage,
    { draws: 1, triangles: 1 },
  );
  for (const mode of IN_FRUSTUM_CLIP_DISABLE_MODES) {
    const before = diagnostics({
      managedCoverageDraws: mode,
      managedCoverageTriangles: mode,
    });
    const after = diagnostics({
      managedCoverageDraws: mode + 1,
      managedCoverageTriangles: mode + 1,
    });
    const result = evaluateInFrustumClipDisable(
      mode,
      before,
      after,
      exactReadback(),
    );
    assert.equal(result.pass, true);
    assert.equal(result.mode, mode);
    assert.equal(result.telemetryZero, true);
    assert.equal(result.managedCoverageExact, true);
    assert.equal(result.byteExact, true);
    assert.equal(result.hashExact, true);
  }
});

test("the model rejects pixels, fallback telemetry, and native routing", () => {
  const before = diagnostics();
  const exactAfter = diagnostics({
    managedCoverageDraws: 1,
    managedCoverageTriangles: 1,
  });
  const wrongPixels = exactReadback();
  wrongPixels.rgba[0] ^= 1;
  assert.equal(
    evaluateInFrustumClipDisable(
      7,
      before,
      exactAfter,
      wrongPixels,
    ).pass,
    false,
  );
  assert.equal(
    evaluateInFrustumClipDisable(
      7,
      before,
      diagnostics({
        aggregate: 1,
        exactPreparation: 1,
        unsupportedClipDisable7: 1,
        managedCoverageDraws: 1,
        managedCoverageTriangles: 1,
      }),
      exactReadback(),
    ).pass,
    false,
  );
  assert.equal(
    evaluateInFrustumClipDisable(
      7,
      before,
      diagnostics(),
      exactReadback(),
    ).pass,
    false,
  );
});

test("the model rejects malformed or regressing evidence", () => {
  for (const mode of [-1, 8, 1.5, NaN]) {
    assert.throws(
      () =>
        evaluateInFrustumClipDisable(
          mode,
          diagnostics(),
          diagnostics(),
          exactReadback(),
        ),
      /mode must be an integer from 0 through 7/,
    );
  }
  assert.throws(
    () =>
      evaluateInFrustumClipDisable(
        0,
        diagnostics({ aggregate: 1 }),
        diagnostics({ aggregate: 0 }),
        exactReadback(),
      ),
    /aggregate regressed/,
  );
  const changedKeys = diagnostics();
  changedKeys.exactRequiredRejectionReasons.other = 0;
  assert.throws(
    () =>
      evaluateInFrustumClipDisable(
        0,
        diagnostics(),
        changedKeys,
        exactReadback(),
      ),
    /keys changed/,
  );
});
