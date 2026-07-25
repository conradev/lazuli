import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_gx_mip_color_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle uploads, explicitly samples, and reads all mip colors", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_gx_mip_color_oracle\.mjs"/,
  );
  assert.equal(
    browserOracle.match(/await WebGpuRenderer\.create\(canvas\)/g)?.length,
    1,
  );
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(\s+buildGxMipColorOraclePacket\(/,
  );
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(
    browserOracle,
    /probePixel\(\s+Array\.from\(readback\.rgba\),/,
  );
  assert.match(
    browserOracle,
    /bytesEqual\(\s+actualProbeRgba,\s+entry\.expectedProbeRgba,/,
  );
  assert.match(
    browserOracle,
    /distinctProbeColors\.size === gxMipColorOracle\.mipLevelCount/,
  );
  assert.match(
    browserOracle,
    /actual\.textureWrites === expected\.textureWrites/,
  );
  assert.match(
    browserOracle,
    /actual\.textureUploadBytes === expected\.textureUploadBytes/,
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
    /window\.__lazuliGxMipColorOraclePromise/,
  );
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
  assert.doesNotMatch(browserOracle, /fallback/i);
});
