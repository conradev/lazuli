import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_managed_coverage_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("in-app browser oracle runs v4 managed and raw-fallback coverage twice through strict WebGPU", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_managed_coverage_oracle\.mjs\?v=depth-flatness-control"/,
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
    /caseIndex < managedCoverageOracleCases\.length/,
  );
  assert.match(
    browserOracle,
    /buildManagedCoverageOraclePacket\(entry\.id, generation\)/,
  );
  assert.match(browserOracle, /renderer\.reset\(\)/);
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(browserOracle, /await renderer\.read_presented_xfb_rgba\(\)/);
  assert.match(browserOracle, /bytesEqual\(actualRgba, entry\.expectedRgba\)/);
  assert.match(browserOracle, /bytesEqual\(actualRgba, prior\)/);
  assert.match(browserOracle, /managedCoverageMask\(actualRgba\)/);
  assert.match(browserOracle, /fnv1a64Hex\(actualRgba\)/);
  assert.match(
    browserOracle,
    /readback\.width === managedCoverageOracleXfb\.width/,
  );
  assert.match(
    browserOracle,
    /readback\.height === managedCoverageOracleXfb\.height/,
  );
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(
    browserOracle,
    /byteExact && dimensionsExact && deterministic/,
  );
  assert.match(browserOracle, /const diagnostics = renderer\.diagnostics\(\)/);
  assert.match(browserOracle, /diagnostics\.managedCoverageDraws === 2/);
  assert.match(browserOracle, /diagnostics\.managedCoverageTriangles === 4/);
  assert.match(
    browserOracle,
    /runs\.every\(entry => entry\.pass\) &&\s+managedCoverageCountersExact/,
  );
  assert.match(browserOracle, /managedCoverageCountersExact,/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliManagedCoverageOraclePromise/,
  );
  assert.doesNotMatch(browserOracle, /diagnostics\(\)\.[A-Za-z_]/);
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
