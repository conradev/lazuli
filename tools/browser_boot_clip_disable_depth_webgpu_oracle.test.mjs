#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const browserOracle = await readFile(
  new URL(
    "./browser_boot_clip_disable_depth_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("browser oracle executes the complete depth-mode matrix twice", () => {
  assert.match(
    browserOracle,
    /import init, \{\s*WebGpuRenderer,\s*\} from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /CLIP_DISABLE_DEPTH_MODES,\s*buildClipDisableDepthOraclePacket,\s*buildClipDisableDepthProbePacket,\s*clipDisableDepthCases,\s*clipDisableDepthExpectation,\s*clipDisableDepthProbeCases,\s*clipDisableDepthProbeExpectation,\s*evaluateClipDisableDepth,\s*evaluateClipDisableDepthProbe,/,
  );
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(
    browserOracle,
    /for \(const definition of clipDisableDepthCases\) \{\s*for \(const mode of CLIP_DISABLE_DEPTH_MODES\)/,
  );
  assert.match(
    browserOracle,
    /buildClipDisableDepthOraclePacket\(\s*definition\.id,\s*mode,\s*generation,/,
  );
  assert.match(
    browserOracle,
    /evaluateClipDisableDepth\(\s*definition\.id,\s*mode,\s*before,\s*after,\s*surface\.readback,/,
  );
  assert.match(
    browserOracle,
    /for \(const definition of clipDisableDepthProbeCases\)/,
  );
  assert.match(
    browserOracle,
    /buildClipDisableDepthProbePacket\(\s*definition\.id,\s*generation,/,
  );
  assert.match(
    browserOracle,
    /evaluateClipDisableDepthProbe\(\s*definition\.id,\s*before,\s*after,\s*surface\.readback,/,
  );
});

test("every case proves exact routing and exact transport cardinality", () => {
  assert.match(
    browserOracle,
    /const before = renderer\.diagnostics\(\);\s*renderer\.submit_gx_frame/,
  );
  assert.match(
    browserOracle,
    /const surface = await present\(renderer, generation\);\s*const after = renderer\.diagnostics\(\)/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.exactRequiredRejectedDraws === 0/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageDraws ===\s*expectedManagedCoverage/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageTriangles ===\s*expectedManagedTriangles/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.exactRasterEmptyDraws ===\s*expectedExactRasterEmptyDraws/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.pushTevDrawCalls ===\s*expectedPushTevDrawCalls/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.submitGxFrameCalls ===\s*expectedSubmitGxFrameCalls/,
  );
  assert.doesNotMatch(browserOracle, /\bWebGL\b|\bcanvas 2d\b/i);
});

test("browser oracle awaits readback, health, and a stable public promise", () => {
  assert.match(
    browserOracle,
    /await renderer\.drain\(\);\s*const readback = await renderer\.read_presented_xfb_rgba\(\);\s*renderer\.check_health\(\)/,
  );
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliClipDisableDepthOraclePromise =\s*run\(\)\.catch/,
  );
  assert.match(
    browserOracle,
    /document\.body\.dataset\.status = result\.pass \? "pass" : "fail"/,
  );
  assert.match(
    browserOracle,
    /document\.body\.dataset\.status = "error"/,
  );
});
