import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL("./browser_boot_depth24_webgpu_oracle.html", import.meta.url),
  "utf8",
);

test("in-app browser oracle runs canonical GX depth vectors twice through strict WebGPU", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(browserOracle, /runIndex < RUN_COUNT/);
  assert.match(
    browserOracle,
    /caseIndex < depth24OracleCases\.length/,
  );
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /await renderer\.read_presented_xfb_rgba\(\)/);
  assert.match(
    browserOracle,
    /uniformDepth24OracleRgba\(entry\.expected\)/,
  );
  assert.match(browserOracle, /bytesEqual\(actualRgba, expectedRgba\)/);
  assert.match(browserOracle, /bytesEqual\(actualRgba, prior\)/);
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(browserOracle, /runs\.every\(entry => entry\.pass\)/);
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
