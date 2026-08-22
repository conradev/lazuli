import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_managed_textured_coverage_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle runs managed textured vectors and native controls twice", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_managed_textured_coverage_oracle\.mjs"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(browserOracle, /runIndex < RUN_COUNT/);
  assert.equal(
    browserOracle.match(/renderer\.reset_diagnostics\(\)/g)?.length,
    1,
  );
  assert.ok(
    browserOracle.indexOf("renderer.reset_diagnostics()") <
      browserOracle.indexOf("runIndex < RUN_COUNT"),
  );
  assert.match(
    browserOracle,
    /caseIndex < managedTexturedCoverageOracleCases\.length/,
  );
  assert.match(
    browserOracle,
    /buildManagedTexturedCoverageOraclePacket\(\s+entry\.id,\s+generation,/,
  );
  assert.match(browserOracle, /renderer\.reset\(\)/);
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /renderer\.present_xfb\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(
    browserOracle,
    /bytesEqual\(\s+actualRgba,\s+entry\.expectedRgba,/,
  );
  assert.match(browserOracle, /bytesEqual\(actualRgba, prior\)/);
  assert.match(
    browserOracle,
    /managedTexturedCoverageMask\(actualRgba\)/,
  );
  assert.match(browserOracle, /fnv1a64Hex\(actualRgba\)/);
  assert.match(
    browserOracle,
    /readback\.width === managedTexturedCoverageXfb\.width/,
  );
  assert.match(
    browserOracle,
    /readback\.height === managedTexturedCoverageXfb\.height/,
  );
  assert.match(browserOracle, /entry\.expectedPath === "managed" \? 1 : 0/);
  assert.match(
    browserOracle,
    /managedCoverageTriangles:\s+entry\.expectedManagedTriangles/,
  );
  assert.match(
    browserOracle,
    /const metricDelta = subtractMetrics\(/,
  );
  assert.match(browserOracle, /metricsExact,/);
  assert.match(
    browserOracle,
    /byteExact &&\s+dimensionsExact &&\s+deterministic &&\s+metricsExact/,
  );
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(
    browserOracle,
    /managedTexturedCoverageExpectedMetrics\.twoRuns/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageDraws ===\s+expectedMetrics\.managedCoverageDraws/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageTriangles ===\s+expectedMetrics\.managedCoverageTriangles/,
  );
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliManagedTexturedCoverageOraclePromise/,
  );
  assert.doesNotMatch(browserOracle, /diagnostics\(\)\.[A-Za-z_]/);
  assert.doesNotMatch(browserOracle, /webgl/i);
});
