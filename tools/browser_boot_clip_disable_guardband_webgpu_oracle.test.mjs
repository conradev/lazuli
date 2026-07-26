#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const browserOracle = await readFile(
  new URL(
    "./browser_boot_clip_disable_guardband_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("browser oracle executes all 160 guardband cases through WebGPU", () => {
  assert.match(
    browserOracle,
    /import init, \{\s*WebGpuRenderer,\s*\} from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /CLIP_DISABLE_GUARDBAND_MODES,\s*CLIP_DISABLE_GUARDBAND_RUN_COUNT,\s*CLIP_DISABLE_GUARDBAND_SCOPE,\s*buildClipDisableGuardbandOraclePacket,\s*clipDisableGuardbandCases,\s*clipDisableGuardbandCertificationMatrix,\s*clipDisableGuardbandOracleXfb,\s*evaluateClipDisableGuardband,/,
  );
  assert.match(browserOracle, /const EXPECTED_MATRIX_ENTRIES = 160/);
  assert.match(
    browserOracle,
    /const matrix = clipDisableGuardbandCertificationMatrix\(\)/,
  );
  assert.match(
    browserOracle,
    /for \(const entry of matrix\) \{[\s\S]*buildClipDisableGuardbandOraclePacket\(\s*entry\.caseId,\s*entry\.mode,\s*entry\.generation,/,
  );
  assert.match(
    browserOracle,
    /evaluateClipDisableGuardband\(\s*entry\.caseId,\s*entry\.mode,\s*before,\s*after,\s*surface\.readback,/,
  );
  assert.match(
    browserOracle,
    /runCount: CLIP_DISABLE_GUARDBAND_RUN_COUNT/,
  );
});

test("every case requires exact readback and aggregate telemetry cardinality", () => {
  assert.match(
    browserOracle,
    /const before = renderer\.diagnostics\(\);\s*renderer\.submit_gx_frame/,
  );
  assert.match(
    browserOracle,
    /const surface = await present\(renderer, entry\.generation\);[\s\S]*const after = renderer\.diagnostics\(\)/,
  );
  assert.match(
    browserOracle,
    /presentationCount === matrix\.length &&\s*readbackCount === matrix\.length/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.exactRequiredRejectedDraws ===\s*expectedExactRequiredRejectedDraws/,
  );
  assert.match(
    browserOracle,
    /exactCounterMap\(\s*diagnostics\.exactRequiredRejectionReasons,\s*expectedRejectionReasons,/,
  );
  assert.match(
    browserOracle,
    /exactCounterMap\(\s*diagnostics\.exactRequiredPreparationRejectionReasons,\s*expectedPreparationRejectionReasons,/,
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
});

test("browser oracle is strict WebGPU, localhost-only, and exposes one promise", () => {
  assert.match(
    browserOracle,
    /const LOOPBACK_HOSTS = new Set\(\[\s*"127\.0\.0\.1",\s*"localhost",\s*"::1",\s*\]\)/,
  );
  assert.match(
    browserOracle,
    /if \(!LOOPBACK_HOSTS\.has\(window\.location\.hostname\)\)/,
  );
  assert.match(browserOracle, /if \(!\("gpu" in navigator\)\)/);
  assert.match(
    browserOracle,
    /await renderer\.drain\(\);\s*const readback = await renderer\.read_presented_xfb_rgba\(\);\s*renderer\.check_health\(\)/,
  );
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /localhostOnly: true/);
  assert.match(
    browserOracle,
    /const RESULT_SCHEMA =\s*"lazuli\.clip-disable-guardband\.webgpu\.v1"/,
  );
  assert.equal(
    (browserOracle.match(/schema: RESULT_SCHEMA/g) ?? []).length,
    2,
  );
  assert.match(
    browserOracle,
    /scope: CLIP_DISABLE_GUARDBAND_SCOPE/,
  );
  assert.match(browserOracle, /health: "clean"/);
  assert.match(browserOracle, /health: "error"/);
  assert.match(
    browserOracle,
    /window\.__lazuliClipDisableGuardbandOraclePromise =\s*run\(\)\.catch/,
  );
  assert.equal(
    (
      browserOracle.match(
        /window\.__lazuliClipDisableGuardbandOraclePromise/g,
      ) ?? []
    ).length,
    1,
  );
  assert.doesNotMatch(browserOracle, /\bWebGL\b|\bcanvas 2d\b/i);
});

test("success and error states remain machine-readable", () => {
  assert.match(
    browserOracle,
    /document\.body\.dataset\.status = result\.pass \? "pass" : "fail"/,
  );
  assert.match(
    browserOracle,
    /document\.body\.dataset\.status = "error"/,
  );
  assert.match(
    browserOracle,
    /<meta name="robots" content="noindex,nofollow">/,
  );
});
