import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_gx_multi_coord_tev_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("strict WebGPU oracle certifies two live coordinates and TEV order twice", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(
    browserOracle,
    /from "\.\/browser_boot_gx_multi_coord_tev_oracle\.mjs"/,
  );
  assert.equal(
    browserOracle.match(/await WebGpuRenderer\.create\(canvas\)/g)
      ?.length,
    1,
  );
  assert.match(browserOracle, /const RUN_COUNT = 2/);
  assert.match(browserOracle, /runIndex < RUN_COUNT/);
  assert.match(
    browserOracle,
    /caseIndex < gxMultiCoordTevCertificationCases\.length/,
  );
  assert.match(
    browserOracle,
    /buildGxMultiCoordTevOraclePacket\(\s+entry\.id,\s+generation,/,
  );
  assert.match(
    browserOracle,
    /buildGxMultiCoordDerivativeTevOraclePacket\(\s+entry\.id,\s+generation,/,
  );
  assert.match(
    browserOracle,
    /const packet = buildCertificationPacket\(\s+entry,\s+generation,/,
  );
  assert.match(browserOracle, /renderer\.reset\(\)/);
  assert.match(browserOracle, /renderer\.submit_gx_frame\(packet\)/);
  assert.match(browserOracle, /renderer\.present_xfb\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(browserOracle, /renderer\.check_health\(\)/);
  assert.match(
    browserOracle,
    /await renderer\.read_presented_xfb_rgba\(\)/,
  );
  assert.match(
    browserOracle,
    /bytesEqual\(\s+actualRgba,\s+entry\.expectedRgba,/,
  );
  assert.match(browserOracle, /bytesEqual\(actualRgba, prior\)/);
  assert.match(
    browserOracle,
    /gxMultiCoordTevMask\(actualRgba\)/,
  );
  assert.match(browserOracle, /fnv1a64Hex\(actualRgba\)/);
  assert.match(
    browserOracle,
    /readback\.width ===\s+gxMultiCoordTevOracle\.xfb\.width/,
  );
  assert.match(
    browserOracle,
    /readback\.height ===\s+gxMultiCoordTevOracle\.xfb\.height/,
  );
});

test("WebGPU result gates managed metrics, ordering, and exact diagnostics", () => {
  assert.match(
    browserOracle,
    /managedCoverageDraws:\s+1/,
  );
  assert.match(
    browserOracle,
    /managedCoverageTriangles:\s+entry\.expectedManagedTriangles/,
  );
  assert.match(
    browserOracle,
    /const metricDelta = subtractMetrics\(/,
  );
  assert.match(browserOracle, /metricsExact,/);
  assert.match(
    browserOracle,
    /byteExact &&\s+dimensionsExact &&\s+deterministic &&\s+metricsExact/,
  );
  assert.match(
    browserOracle,
    /cases\[0\]\.actualRgbaFnv1a64 !==\s+cases\[1\]\.actualRgbaFnv1a64/,
  );
  assert.match(
    browserOracle,
    /cases\[2\]\.actualRgbaFnv1a64 !==\s+cases\[3\]\.actualRgbaFnv1a64/,
  );
  assert.match(browserOracle, /stageOrderDistinct,/);
  assert.match(
    browserOracle,
    /certificationExpectedMetrics\.twoRuns/,
  );
  assert.match(
    browserOracle,
    /entry\.actualRgbaFnv1a64 !==\s+entry\.reusedCoord2RgbaFnv1a64/,
  );
  assert.match(
    browserOracle,
    /entry\.actualRgbaFnv1a64 !==\s+entry\.reusedCoord7RgbaFnv1a64/,
  );
  assert.match(browserOracle, /derivativeCoordinatesDistinct/);
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageDraws ===\s+expectedMetrics\.managedCoverageDraws/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.managedCoverageTriangles ===\s+expectedMetrics\.managedCoverageTriangles/,
  );
  assert.match(
    browserOracle,
    /diagnostics\.exactRequiredRejectedDraws === 0/,
  );
  assert.match(
    browserOracle,
    /exactRequiredRejectionReasons,[\s\S]*every\(value => value === 0\)/,
  );
  assert.match(browserOracle, /managedCoverageCountersExact/);
  assert.match(browserOracle, /diagnosticsClean/);
  assert.match(browserOracle, /packetContractExact/);
  assert.match(browserOracle, /strictWebGpu: true/);
  assert.match(browserOracle, /health: "clean"/);
});

test("WebGPU result certifies legacy-only and legacy-sidecar-legacy pipeline layouts", () => {
  assert.match(
    browserOracle,
    /buildGxMultiCoordTevPipelineLayoutOraclePacket/,
  );
  assert.match(
    browserOracle,
    /gxMultiCoordTevPipelineLayoutCases/,
  );
  assert.match(
    browserOracle,
    /caseIndex < gxMultiCoordTevPipelineLayoutCases\.length/,
  );
  assert.match(
    browserOracle,
    /buildGxMultiCoordTevPipelineLayoutOraclePacket\(\s+entry\.id,\s+generation,/,
  );
  assert.match(
    browserOracle,
    /const packetDrawCount = new DataView\([\s\S]*?\.getUint32\(0x14, true\)/,
  );
  assert.match(
    browserOracle,
    /oneUnflushedGeometrySegment:\s+entry\.id !== "legacy-sidecar-legacy" \|\|\s+packetDrawCount === 3/,
  );
  assert.match(
    browserOracle,
    /pipelineLayoutsExact[\s\S]*entry\.oneSubmit &&\s+entry\.oneUnflushedGeometrySegment/,
  );
  assert.match(
    browserOracle,
    /packetContractExact &&\s+pipelineLayoutsExact &&\s+runs\.every/,
  );
});

test("oracle requests only WebGPU and remains a local tool page", () => {
  assert.match(
    browserOracle,
    /contextTrace\.requests\.filter\(type => type !== "webgpu"\)/,
  );
  assert.match(
    browserOracle,
    /contextTrace\.requests\.every\(type => type === "webgpu"\)/,
  );
  assert.match(browserOracle, /strictWebGpuOnly:/);
  assert.match(
    browserOracle,
    /window\.__lazuliGxMultiCoordTevOraclePromise/,
  );
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
  assert.doesNotMatch(browserOracle, /<a\b|href=|location\.|fetch\(/i);
});
