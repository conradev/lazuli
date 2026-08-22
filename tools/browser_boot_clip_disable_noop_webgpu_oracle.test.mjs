#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_clip_disable_noop_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("local WebGPU oracle certifies all safe XF clip-disable modes twice", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_clip_disable_noop_oracle\.mjs"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_varying_raster_oracle\.mjs"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(
    browserOracle,
    /modeIndex < IN_FRUSTUM_CLIP_DISABLE_MODES\.length/,
  );
  assert.match(
    browserOracle,
    /buildVaryingRasterOraclePacket\(\s*IN_FRUSTUM_CLIP_DISABLE_VARIANT,\s*generation,\s*\{ xfClipDisable: mode \},/,
  );
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /renderer\.present_xfb\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(browserOracle, /evaluateInFrustumClipDisable\(/);
  assert.match(
    browserOracle,
    /diagnostics\.exactRequiredRejectedDraws === 0/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageDraws === expectedManagedCoverage/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageTriangles === expectedManagedCoverage/,
  );
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliClipDisableNoopOraclePromise/,
  );
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
