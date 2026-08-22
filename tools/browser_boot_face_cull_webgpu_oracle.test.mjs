#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_face_cull_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("in-app browser oracle certifies both strict WebGPU face-cull routes", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_face_cull_oracle\.mjs"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(
    browserOracle,
    /index < faceCullOracleCases\.length/,
  );
  assert.match(browserOracle, /renderer\.reset\(\)/);
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(browserOracle, /evaluateFaceCullOracleCase\(/);
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /cases\.every\(\(entry\) => entry\.pass\)/);
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(browserOracle, /window\.__lazuliFaceCullOraclePromise/);
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
