import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_projection_null_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle recovers one v6 projection-null draw twice", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_projection_null_oracle\.mjs"/,
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
  assert.match(browserOracle, /renderer\.reset\(\)/);
  assert.match(
    browserOracle,
    /buildProjectionNullOraclePacket\(generation\)/,
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
    /bytesEqual\(\s+actualRgba,\s+projectionNullOracleCase\.expectedRgba,/,
  );
  assert.match(browserOracle, /bytesEqual\(actualRgba, referenceRgba\)/);
  assert.match(browserOracle, /projectionNullMask\(actualRgba\)/);
  assert.match(browserOracle, /fnv1a64Hex\(actualRgba\)/);
  assert.match(
    browserOracle,
    /readback\.width === projectionNullOracleXfb\.width/,
  );
  assert.match(
    browserOracle,
    /readback\.height === projectionNullOracleXfb\.height/,
  );
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
    /projectionNullOracleCase\.expectedManagedCoverage\.draws/,
  );
  assert.match(
    browserOracle,
    /projectionNullOracleCase\.expectedManagedCoverage\.triangles/,
  );
  assert.match(
    browserOracle,
    /byteExact &&\s+dimensionsExact &&\s+deterministic &&\s+maskExact &&\s+hashExact &&\s+managedCoverageExact/,
  );
  assert.match(browserOracle, /diagnostics\.managedCoverageDraws === 2/);
  assert.match(browserOracle, /diagnostics\.managedCoverageTriangles === 4/);
  assert.match(browserOracle, /managedCoverageCountersExact,/);
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliProjectionNullOraclePromise/,
  );
  assert.doesNotMatch(browserOracle, /diagnostics\(\)\.[A-Za-z_]/);
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
