import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_gx_mip_activation_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle proves the live strict-V7 activation and residency bridge", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_gx_mip_activation_oracle\.mjs"/,
  );
  assert.equal(
    browserOracle.match(/await WebGpuRenderer\.create\(canvas\)/g)?.length,
    1,
  );
  assert.match(
    browserOracle,
    /buildGxMipActivationOraclePacket\(\{ resident: false \}\)/,
  );
  assert.match(
    browserOracle,
    /buildGxMipActivationOraclePacket\(\{ resident: true \}\)/,
  );
  assert.equal(
    browserOracle.match(/renderer\.submit_gx_frame\(/g)?.length,
    2,
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
    /keys\[0\] === gxMipActivationOracle\.key/,
  );
  assert.match(
    browserOracle,
    /`\$\{gxMipActivationOracle\.legacyKey\}`\s*\+\s*gxMipActivationOracle\.keySuffix/,
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
    /diagnostics\.submitGxFrameCalls === 2/,
  );
  assert.match(browserOracle, /diagnostics\.drainCalls === 2/);
  assert.match(browserOracle, /diagnostics\.checkHealthCalls === 2/);
  assert.match(
    browserOracle,
    /diagnostics\.exactRequiredRejectedDraws === 0/,
  );
  assert.match(
    browserOracle,
    /exactRequiredRejectionReasons,[\s\S]*every\(value => value === 0\)/,
  );
  assert.match(
    browserOracle,
    /contextTrace\.requests\.filter\(type => type !== "webgpu"\)/,
  );
  assert.match(
    browserOracle,
    /contextTrace\.requests\.every\(type => type === "webgpu"\)/,
  );
  assert.match(browserOracle, /strictWebGpuOnly:/);
  assert.match(browserOracle, /diagnosticsClean/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliGxMipActivationOraclePromise/,
  );
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
  assert.doesNotMatch(browserOracle, /fallback/i);
  assert.doesNotMatch(
    browserOracle,
    /\/(?:warioware|smb|super-monkey-ball|games|app(?:\.html)?)(?:["'/?#]|$)/i,
  );
});
