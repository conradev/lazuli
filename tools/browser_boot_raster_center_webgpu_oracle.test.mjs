import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_raster_center_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("in-app browser oracle runs exact GX raster-center vectors twice through strict WebGPU", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(browserOracle, /runIndex < RUN_COUNT/);
  assert.match(
    browserOracle,
    /caseIndex < rasterCenterOracleCases\.length/,
  );
  assert.match(browserOracle, /renderer\.reset\(\)/);
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(browserOracle, /await renderer\.read_presented_xfb_rgba\(\)/);
  assert.match(browserOracle, /const expectedRgba = entry\.expectedRgba/);
  assert.match(browserOracle, /bytesEqual\(actualRgba, expectedRgba\)/);
  assert.match(browserOracle, /bytesEqual\(actualRgba, prior\)/);
  assert.match(
    browserOracle,
    /readback\.width === rasterCenterOracleXfb\.width/,
  );
  assert.match(
    browserOracle,
    /readback\.height === rasterCenterOracleXfb\.height/,
  );
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(
    browserOracle,
    /byteExact && dimensionsExact && deterministic/,
  );
  assert.match(browserOracle, /runs\.every\(entry => entry\.pass\)/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliRasterCenterOraclePromise/,
  );
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
