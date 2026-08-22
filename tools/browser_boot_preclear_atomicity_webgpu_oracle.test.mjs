#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_preclear_atomicity_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("strict WebGPU oracle rejects a late-invalid frame before its pre-clear mutates EFB", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /view\.setUint32\(0x60, HEIGHT - 1, true\)/);
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(\s*invalidExecutionPacket\(\),\s*magentaPreClear\(\),/,
  );
  assert.match(browserOracle, /renderer\.copy_xfb\(/);
  assert.match(browserOracle, /renderer\.present_xfb\(/);
  assert.match(
    browserOracle,
    /const atomicityReadback = await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(
    browserOracle,
    /const atomicityRgba = Array\.from\(atomicityReadback\.rgba\)/,
  );
  assert.match(browserOracle, /const rejectedBeforeEfbMutation = isUniform\(/);
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /health: "clean"/);
  assert.doesNotMatch(browserOracle, /webgl|fallback/i);
});

test("strict WebGPU oracle preserves distinct pre-clears and the terminal clear in one submission", () => {
  assert.match(
    browserOracle,
    /buildRasterCenterOraclePacket\(\s*\[\],\s*STRIPED_GENERATION,\s*\)/,
  );
  assert.match(browserOracle, /function distinctPreClears\(\)/);
  assert.match(browserOracle, /\.\.\.RED/);
  assert.match(browserOracle, /0x00111111/);
  assert.match(browserOracle, /\.\.\.GREEN/);
  assert.match(browserOracle, /0x00222222/);
  assert.match(browserOracle, /packet\.set\(BLUE, 0x74\)/);
  assert.match(browserOracle, /view\.setUint32\(0x90, 0x00333333, true\)/);
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(\s*terminalClearPacket\(\),\s*distinctPreClears\(\),/,
  );
  assert.match(browserOracle, /distinctPreClearsPreserved/);
  assert.match(browserOracle, /terminalClearPreserved/);
  assert.match(browserOracle, /expectedStripedRgba/);
  assert.match(browserOracle, /diagnostics: renderer\.diagnostics\(\)/);
});
