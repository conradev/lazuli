import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_gx_mip_upload_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle measures first NPOT mip upload and resident resubmit", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_gx_mip_upload_oracle\.mjs"/,
  );
  assert.equal(
    browserOracle.match(/await WebGpuRenderer\.create\(canvas\)/g)?.length,
    1,
  );
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(\s+buildGxMipUploadOraclePacket\(\{\s+generation: 1,\s+resident: false,/,
  );
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(\s+buildGxMipUploadOraclePacket\(\{\s+generation: 2,\s+resident: true,/,
  );
  assert.equal(
    browserOracle.match(/await renderer\.drain\(\)/g)?.length,
    2,
  );
  assert.equal(
    browserOracle.match(/renderer\.check_health\(\)/g)?.length,
    2,
  );
  assert.match(
    browserOracle,
    /actual\.textureWrites === expected\.textureWrites/,
  );
  assert.match(
    browserOracle,
    /actual\.textureUploadBytes === expected\.textureUploadBytes/,
  );
  assert.match(
    browserOracle,
    /actual\.gxFramePacketPayloadBytes ===\s+expected\.packetPayloadBytes/,
  );
  assert.match(
    browserOracle,
    /keys\.length === expected\.resourceIdentities &&\s+keys\[0\] === gxMipUploadOracle\.key/,
  );
  assert.match(
    browserOracle,
    /contextTrace\.requests\.filter\(type => type !== "webgpu"\)/,
  );
  assert.match(
    browserOracle,
    /contextTrace\.requests\.every\(type => type === "webgpu"\)/,
  );
  assert.match(browserOracle, /diagnostics\.drainCalls === 2/);
  assert.match(browserOracle, /diagnostics\.checkHealthCalls === 2/);
  assert.match(browserOracle, /strictWebGpuOnly:/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliGxMipUploadOraclePromise/,
  );
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
  assert.doesNotMatch(browserOracle, /fallback/i);
});
