import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_efb_texture_copy_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

test("local oracle drives canonical color and depth EFB copies through strict WebGPU", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(browserOracle, /requireLoopbackOracle\(\)/);
  assert.match(browserOracle, /LOOPBACK_HOSTS\.has\(location\.hostname\)/);
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /renderer\.copy_texture\(/);
  assert.match(browserOracle, /id: "color-rgb8-to-rgba8"/);
  assert.match(browserOracle, /sourcePlane: entry\.pixelControl === 3/);
  assert.match(browserOracle, /id: "depth-z24-to-rgba8"/);
  assert.match(browserOracle, /expectedSource: Object\.freeze\(\[0x12, 0x34, 0x56, 0xff\]\)/);
  assert.match(browserOracle, /expectedPostClear: Object\.freeze\(\[0xab, 0xcd, 0xef, 0xff\]\)/);
  assert.match(browserOracle, /contextTrace\.requests\.every\(type => type === "webgpu"\)/);
  assert.match(browserOracle, /const strictWebGpu =/);
  assert.match(browserOracle, /const noFallback = unexpectedCanvasContexts\.length === 0/);
  assert.match(browserOracle, /health: "clean"/);
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
});

test("oracle proves copy-before-clear ordering by consuming both cached surfaces", () => {
  assert.match(
    browserOracle,
    /copyTexture\(\s*renderer,\s*entry,\s*sourceAddress,\s*sourceGeneration,\s*true,/,
  );
  assert.match(
    browserOracle,
    /copyTexture\(\s*renderer,\s*entry,\s*postClearAddress,\s*postClearGeneration,\s*false,/,
  );
  assert.match(
    browserOracle,
    /view\.setUint32\(layout\.textureOffset \+ 0x10, address, true\)/,
  );
  assert.match(
    browserOracle,
    /view\.setUint32\(layout\.textureOffset \+ 0x14, generation, true\)/,
  );
  assert.equal(
    browserOracle.match(/await consumeCopiedSurface\(/g)?.length,
    2,
  );
  assert.match(browserOracle, /await renderer\.read_presented_xfb_rgba\(\)/);
  assert.match(browserOracle, /metricDelta\.copyTextureCalls === 2/);
  assert.match(browserOracle, /metricDelta\.textureWrites === 0/);
  assert.match(browserOracle, /metricDelta\.textureUploadBytes === 0/);
  assert.match(browserOracle, /const copyBeforeTerminalClear =/);
  assert.match(browserOracle, /sourceExact[\s\S]*postClearExact[\s\S]*!bytesEqual\(source\.rgba, postClear\.rgba\)/);
  assert.match(browserOracle, /directSurfaceSelected/);
  assert.match(browserOracle, /window\.__lazuliEfbTextureCopyOraclePromise/);
});

test("oracle is a tools-only loopback page with no public game route", () => {
  assert.match(browserOracle, /localOnly: true/);
  assert.doesNotMatch(
    browserOracle,
    /\/(?:warioware|smb|super-monkey-ball|games|app(?:\.html)?)(?:["'/?#]|$)/i,
  );
});
