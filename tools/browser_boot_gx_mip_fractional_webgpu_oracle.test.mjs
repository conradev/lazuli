import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_gx_mip_fractional_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle reads exact fractional-mip XFB bytes twice", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_gx_mip_fractional_oracle\.mjs"/,
  );
  assert.equal(
    browserOracle.match(/await WebGpuRenderer\.create\(canvas\)/g)?.length,
    1,
  );
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(\s+buildGxMipFractionalOraclePacket\(/,
  );
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(
    browserOracle,
    /bytesEqual\(\s+actualRgba,\s+entry\.expectedRgba,/,
  );
  assert.match(
    browserOracle,
    /actualRgbaFnv1a64 === entry\.expectedRgbaFnv1a64/,
  );
  assert.match(
    browserOracle,
    /actualRgbaFnv1a64 !==\s+entry\.nonUniformCoverageComparisonRgbaFnv1a64/,
  );
  assert.match(
    browserOracle,
    /actual\.managedCoverageDraws ===\s+expected\.managedCoverageDraws/,
  );
  assert.match(
    browserOracle,
    /actual\.managedCoverageTriangles ===\s+expected\.managedCoverageTriangles/,
  );
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(
    browserOracle,
    /contextTrace\.requests\.filter\(type => type !== "webgpu"\)/,
  );
  assert.match(
    browserOracle,
    /contextTrace\.requests\.every\(type => type === "webgpu"\)/,
  );
  assert.match(browserOracle, /strictWebGpuOnly:/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliGxMipFractionalOraclePromise/,
  );
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
});
