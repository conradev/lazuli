import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL("./browser_boot_early_z_webgpu_oracle.html", import.meta.url),
  "utf8",
);

test("in-app browser oracle runs every vector through the rebuilt strict WebGPU renderer", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /for \(let index = 0; index < earlyZOracleCases\.length/);
  assert.match(browserOracle, /renderer\.submit_gx_frame\(/);
  assert.match(browserOracle, /await renderer\.read_presented_xfb_rgba\(\)/);
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(browserOracle, /cases\.every\(entry => entry\.pass\)/);
  assert.doesNotMatch(browserOracle, /fallback|webgl/i);
});
