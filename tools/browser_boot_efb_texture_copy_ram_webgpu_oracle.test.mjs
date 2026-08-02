import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  buildGxMipUploadOraclePacket,
} from "./browser_boot_gx_mip_upload_oracle.mjs";

const browserOracle = readFileSync(
  new URL(
    "./browser_boot_efb_texture_copy_ram_webgpu_oracle.html",
    import.meta.url,
  ),
  "utf8",
);

function oracleModel() {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(browserOracle)?.[1];
  assert.notEqual(script, undefined, "missing module script");
  const importsRemoved = script.replace(
    /\s*import\s+[\s\S]*?\s+from\s+"[^"]+";\s*/g,
    "\n",
  );
  const invocation = importsRemoved.indexOf(
    "window.__lazuliEfbTextureCopyRamOraclePromise",
  );
  assert.notEqual(invocation, -1, "missing oracle promise");
  const source = `${importsRemoved.slice(0, invocation)}\n`
    + "globalThis.__model = { COPY_CASES, DEPTH_COPY_CASE, V7_COPY_CASE, "
    + "ORACLE_CASES, CLEAR_RGBA, COPY_WIDTH, COPY_HEIGHT, patternPixel, "
    + "depthPatternPixel, logicalOnlySample, postClearSample, clearEverywhereSample, "
    + "copyLayout, encodeExpectedBytes, buildTextureCopyPacket };";
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Error,
    Math,
    Number,
    Object,
    Reflect,
    Set,
    String,
    TypeError,
    Uint8Array,
    buildGxMipUploadOraclePacket,
  };
  vm.createContext(context);
  vm.runInContext(source, context, {
    filename: "browser_boot_efb_texture_copy_ram_webgpu_oracle.inline.mjs",
  });
  return context.__model;
}

test("strict WebGPU oracle flags canonical LZGX v4 texture-copy layouts", () => {
  assert.match(
    browserOracle,
    /from "\.\.\/target\/gekko-web\/browser_renderer\.js"/,
  );
  assert.match(browserOracle, /requireLoopbackOracle\(\)/);
  assert.match(browserOracle, /await WebGpuRenderer\.create\(canvas\)/);
  assert.match(browserOracle, /putU16\(view, 0x04, 4\)/);
  assert.match(
    browserOracle,
    /putU32\(view, 0x0c, TEXTURE_COPY_LAYOUT_V1\)/,
  );
  assert.match(browserOracle, /putU32\(view, 0x10, 1\)/);
  assert.match(browserOracle, /renderer\.submit_gx_frame\(buildTextureCopyPacket/);
  assert.doesNotMatch(browserOracle, /renderer\.copy_texture\(/);
  assert.match(browserOracle, /await renderer\.drain\(\)/);
  assert.match(browserOracle, /layout === "gx-efb-copy-tiled-bytes-v1"/);
  assert.match(
    browserOracle,
    /contextTrace\.requests\.every\(type => type === "webgpu"\)/,
  );
  assert.match(browserOracle, /const noFallback = unexpectedCanvasContexts\.length === 0/);
  assert.doesNotMatch(
    browserOracle,
    /getContext\(\s*["'](?:webgl2?|2d)["']/i,
  );
});

test("independent byte model covers every GX EFB-copy encoder mode", () => {
  const model = oracleModel();
  const formats = Array.from(model.COPY_CASES, entry => entry.copyFormat);
  const encodedTargets = Array.from(model.COPY_CASES, entry => entry.encodedTarget);
  assert.deepEqual(formats, Array.from({ length: 13 }, (_unused, index) => index));
  assert.deepEqual(encodedTargets, [0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9]);

  assert.deepEqual(Array.from(model.patternPixel(0, 0)), [4, 36, 69, 32]);
  const expectedPrefixes = new Map([
    [0, [0x02, 0x35, 0x79, 0xac]],
    [2, [0x20, 0x32, 0x53, 0x75]],
    [3, [32, 4, 60, 32]],
    [4, [0x01, 0x28, 0x21, 0xcf]],
    [5, [0x10, 0x24, 0x12, 0x37]],
    [6, [32, 4, 60, 32]],
    [11, [36, 4, 56, 32]],
    [12, [69, 36, 121, 56]],
  ]);
  for (const entry of model.COPY_CASES) {
    const encoded = model.encodeExpectedBytes(entry, model.patternPixel);
    const logicalOnly = model.encodeExpectedBytes(entry, model.logicalOnlySample);
    const layout = model.copyLayout(entry);
    assert.equal(encoded.bytes.length, layout.denseBytes, entry.id);
    assert.equal(encoded.layout.rowBytes, layout.rowBytes, entry.id);
    assert.equal(encoded.layout.rowCount, layout.rowCount, entry.id);
    assert.notDeepEqual(
      Array.from(encoded.bytes),
      Array.from(logicalOnly.bytes),
      `${entry.id} must distinguish physical padding from zero fill`,
    );
    const prefix = expectedPrefixes.get(entry.copyFormat);
    if (prefix !== undefined) {
      assert.deepEqual(
        Array.from(encoded.bytes.slice(0, prefix.length)),
        prefix,
        `${entry.id} canonical prefix`,
      );
    }
  }
});

test("clear-order case expects pre-clear bytes and preserves padded EFB samples", () => {
  const model = oracleModel();
  const rgba8 = model.COPY_CASES.find(entry => entry.id === "rgba8");
  const source = model.encodeExpectedBytes(rgba8, model.patternPixel).bytes;
  const postClear = model.encodeExpectedBytes(rgba8, model.postClearSample).bytes;
  const clearEverywhere = model.encodeExpectedBytes(
    rgba8,
    model.clearEverywhereSample,
  ).bytes;
  assert.notDeepEqual(Array.from(source), Array.from(postClear));
  assert.notDeepEqual(
    Array.from(postClear),
    Array.from(clearEverywhere),
    "right/bottom tile padding must continue sampling uncleared adjacent EFB pixels",
  );
  assert.match(
    browserOracle,
    /renderer\.submit_gx_frame\(buildTextureCopyPacket\(entry, beforeClear\)\);\s*renderer\.submit_gx_frame\(buildTextureCopyPacket\(entry, afterClear\)\);/,
  );
  assert.match(browserOracle, /copyBeforeTerminalClear/);
  assert.match(browserOracle, /paddedRightBottomSurvivesTerminalClear/);
  assert.match(browserOracle, /metricDelta\.clearEfbCalls === 1/);
});

test("matrix adds an exact Z24 RGBA8 receipt and a genuine-mip LZGX v7 receipt", () => {
  const model = oracleModel();
  assert.equal(model.ORACLE_CASES.length, 15);
  assert.equal(model.DEPTH_COPY_CASE.copyFormat, 6);
  assert.equal(model.DEPTH_COPY_CASE.pixelControl, 3);
  assert.deepEqual(Array.from(model.depthPatternPixel(0, 0)), [0x40, 0, 0, 0xff]);
  const depthBytes = model.encodeExpectedBytes(
    model.DEPTH_COPY_CASE,
    model.depthPatternPixel,
  ).bytes;
  assert.deepEqual(Array.from(depthBytes.slice(0, 4)), [0xff, 0x40, 0xff, 0x40]);
  assert.equal(model.V7_COPY_CASE.packetVersion, 7);
  const v7 = model.buildTextureCopyPacket(model.V7_COPY_CASE, {
    destination: 0x002a0000,
    generation: 321,
    clear: false,
  });
  const v7View = new DataView(v7.buffer, v7.byteOffset, v7.byteLength);
  assert.equal(v7View.getUint16(0x04, true), 7);
  assert.equal(v7View.getUint32(0x0c, true), 1);
  assert.equal(v7View.getUint32(0x10, true), 1);
  assert.equal(v7View.getUint32(0x4c, true), 64);
  assert.equal(v7View.getUint32(0x50, true), 64);
  assert.equal(v7View.getUint32(0x54, true), 5);
  assert.equal(v7View.getUint32(0x58, true), 5);
  assert.equal(v7View.getUint32(0x5c, true), 5);
  assert.equal(v7View.getUint32(0x60, true), 5);
  assert.equal(v7View.getUint32(0x64, true), 0x002a0000);
  assert.equal(v7View.getUint32(0x68, true), 160);
  assert.equal(v7View.getUint32(0x6c, true), 321);
  assert.equal(v7View.getUint32(0x88, true), 1);
  assert.equal(v7View.getUint32(0x8c, true), 12 << 3);
  assert.ok(v7.byteLength > 160, "v7 receipt packet retains its genuine mip draw");
  assert.match(browserOracle, /buildGxMipUploadOraclePacket\(\{/);
  assert.match(browserOracle, /entry\.packetVersion === 7/);
  assert.match(browserOracle, /genuineV7CopyModes: 1/);
  assert.match(browserOracle, /depthCopyModes: 1/);
});

test("receipt contract validates owned exact-length bytes and complete metadata", () => {
  assert.match(browserOracle, /receipt\.bytes\.byteOffset === 0/);
  assert.match(
    browserOracle,
    /receipt\.bytes\.byteLength === receipt\.bytes\.buffer\.byteLength/,
  );
  for (const field of [
    "destination",
    "generation",
    "width",
    "height",
    "copyFormat",
    "baseFormat",
    "stride",
    "rowBytes",
    "rowCount",
    "layout",
  ]) {
    assert.match(browserOracle, new RegExp(`receipt\\?\\.${field}`), field);
  }
  assert.match(browserOracle, /bytesExact = typedBytes && bytesEqual/);
  assert.equal(
    browserOracle.match(/const uniqueReceiptBuffers =/g)?.length,
    2,
  );
  assert.match(
    browserOracle,
    /candidate => candidate\?\.bytes\?\.buffer === receipt\?\.bytes\?\.buffer/,
  );
  assert.match(browserOracle, /ORACLE_CASES\.length/);
  assert.match(browserOracle, /colorCopyModes: COPY_CASES\.length/);
  assert.match(browserOracle, /packetVersions: \[4, 7\]/);
});

test("oracle is tools-only loopback state with no public game route", () => {
  assert.match(browserOracle, /localOnly: true/);
  assert.match(browserOracle, /LOOPBACK_HOSTS\.has\(location\.hostname\)/);
  assert.doesNotMatch(
    browserOracle,
    /\/(?:warioware|smb|super-monkey-ball|games|app(?:\.html)?)(?:["'/?#]|$)/i,
  );
});
