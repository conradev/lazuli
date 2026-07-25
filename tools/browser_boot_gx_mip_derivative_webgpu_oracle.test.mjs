import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_gx_mip_derivative_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("WebGPU oracle hard-gates wide-margin derivative selections twice", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_gx_mip_derivative_oracle\.mjs"/,
  );
  assert.equal(
    browserOracle.match(/await WebGpuRenderer\.create\(canvas\)/g)
      ?.length,
    1,
  );
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(
    browserOracle,
    /buildGxMipDerivativeOraclePacket\(\s+entry\.id,/,
  );
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(packet\)/,
  );
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(
    browserOracle,
    /bytesEqual\(\s+sample\.rgba,\s+entry\.expectedSurface,/,
  );
  assert.match(
    browserOracle,
    /actualRgbaFnv1a64 === entry\.expectedSurfaceFnv1a64/,
  );
  assert.match(
    browserOracle,
    /hardGates\.every\(entry => entry\.pass\)/,
  );
  assert.match(
    browserOracle,
    /palette\.coverageExact &&\s+sample\.acknowledgementExact &&\s+sample\.metricsExact/,
  );
});

test("WebGPU oracle measures upload and managed-coverage work exactly", () => {
  assert.match(
    browserOracle,
    /actual\.gxFramePacketPayloadBytes ===\s+expected\.packetPayloadBytes/,
  );
  assert.match(
    browserOracle,
    /actual\.texturePixelBytes === expected\.packetPayloadBytes/,
  );
  assert.match(
    browserOracle,
    /actual\.textureUploadBytes === expected\.textureUploadBytes/,
  );
  assert.match(
    browserOracle,
    /actual\.textureWrites === expected\.textureWrites/,
  );
  assert.match(
    browserOracle,
    /actual\.managedCoverageDraws ===\s+expected\.managedCoverageDraws/,
  );
  assert.match(
    browserOracle,
    /actual\.managedCoverageTriangles ===\s+expected\.managedCoverageTriangles/,
  );
  assert.match(
    browserOracle,
    /gxMipDerivativeOracle\.expectedSingleDrawMetrics/,
  );
  assert.match(
    browserOracle,
    /gxMipDerivativeOracle\.expectedSequenceMetrics/,
  );
});

test("WebGPU oracle treats 1/16 outcomes as deterministic fingerprints", () => {
  assert.match(
    browserOracle,
    /gxMipDerivativeFingerprintCases/,
  );
  assert.match(
    browserOracle,
    /const modelByteExact = bytesEqual\(/,
  );
  assert.match(
    browserOracle,
    /observed boundary bucket is adapter evidence/,
  );
  assert.match(
    browserOracle,
    /not[\s/]+required to equal the independent model cross-adapter/,
  );
  assert.match(
    browserOracle,
    /fingerprints\.every\(entry => entry\.pass\)/,
  );
  assert.match(
    browserOracle,
    /actualRgbaFnv1a64:\s+entry\.actualRgbaFnv1a64/,
  );
  assert.match(
    browserOracle,
    /observedLodSixteenths: entry\.observedBucket/,
  );
  assert.match(
    browserOracle,
    /classifyGxMipDerivativeFingerprint\(\s+palette\.lods,/,
  );
  assert.match(
    browserOracle,
    /const uniform =\s+pixelsUniform\(sample\.rgba\) && bucket\.uniformBucket/,
  );
  assert.match(
    browserOracle,
    /uniform,\s+observedBucket: bucket\.observedBucket,\s+plausibleBucket: bucket\.plausibleBucket,/,
  );

  const fingerprintPass = browserOracle.slice(
    browserOracle.indexOf(
      "// The observed boundary bucket is adapter evidence.",
    ),
    browserOracle.indexOf("const sequences = []"),
  );
  assert.match(fingerprintPass, /deterministic &&/);
  assert.match(fingerprintPass, /palette\.coverageExact &&/);
  assert.match(fingerprintPass, /uniform &&/);
  assert.match(fingerprintPass, /bucket\.plausibleBucket &&/);
  assert.doesNotMatch(fingerprintPass, /modelByteExact &&/);
});

test("WebGPU oracle proves A/B/B/A state isolation under permuted record order", () => {
  assert.match(
    browserOracle,
    /buildGxMipDerivativeSequencePacket\(\s+entry\.id,/,
  );
  assert.match(
    browserOracle,
    /recordOrder: entry\.order\.map\(\(\{ slot, state \}\) => \(\{/,
  );
  assert.match(
    browserOracle,
    /bytesEqual\(sequences\[0\]\.rgba, sequences\[1\]\.rgba\)/,
  );
  assert.match(
    browserOracle,
    /sequences\[0\]\.actualRgbaFnv1a64 ===\s+sequences\[1\]\.actualRgbaFnv1a64/,
  );
  assert.match(
    browserOracle,
    /sequencePermutationIndependent &&\s+sequences\.every\(entry => entry\.pass\)/,
  );
});

test("WebGPU oracle has no rendering fallback and reports clean health", () => {
  assert.match(
    browserOracle,
    /contextTrace\.requests\.filter\(type => type !== "webgpu"\)/,
  );
  assert.match(
    browserOracle,
    /contextTrace\.requests\.every\(type => type === "webgpu"\)/,
  );
  assert.match(browserOracle, /strictWebGpuOnly:/);
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(browserOracle, /health: "clean"/);
  assert.match(
    browserOracle,
    /window\.__lazuliGxMipDerivativeOraclePromise/,
  );
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
});
