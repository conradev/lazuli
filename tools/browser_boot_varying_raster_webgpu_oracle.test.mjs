import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_varying_raster_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle reconstructs both raster channels and the soft-f32 boundary twice", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_varying_raster_oracle\.mjs"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(browserOracle, /varyingRasterOracleCases\.length/);
  assert.match(
    browserOracle,
    /buildVaryingRasterOraclePacket\(entry\.id, generation\)/,
  );
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /renderer\.present_xfb\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(
    browserOracle,
    /bytesEqual\(actualRgba, entry\.expectedRgba\)/,
  );
  assert.match(browserOracle, /bytesEqual\(actualRgba, prior\)/);
  assert.match(browserOracle, /fnv1a64Hex\(actualRgba\)/);
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(
    browserOracle,
    /diagnosticsAfter\.managedCoverageDraws -\s+diagnosticsBefore\.managedCoverageDraws/,
  );
  assert.match(
    browserOracle,
    /diagnosticsAfter\.managedCoverageTriangles -\s+diagnosticsBefore\.managedCoverageTriangles/,
  );
  assert.match(
    browserOracle,
    /RUN_COUNT \* varyingRasterOracleCases\.length/,
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
    /window\.__lazuliVaryingRasterOraclePromise/,
  );
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
