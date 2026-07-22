// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  SMB_TEMPORAL_XFB_CAPACITY,
  deriveTemporalSelectedXfbOracle,
  projectSmbTemporalSelectedXfb,
} from "./browser_boot_temporal_xfb.mjs";
import {
  TemporalSurfaceValidationError,
  deriveTemporalPresentedSurfaceFlickerDiagnostics,
  deriveTemporalPresentedSurfaceOracle,
  verifySmbTemporalPresentedSurfaces,
} from "./browser_boot_temporal_surface.mjs";

const browserBootSource = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = browserBootSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = browserBootSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < browserBootSource.length; index += 1) {
    if (browserBootSource[index] === "{") depth += 1;
    if (browserBootSource[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return browserBootSource.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function digest(index) {
  return (index + 1).toString(16).padStart(64, "0");
}

function selectedXfb(index, generation) {
  return {
    address: "0x00300000",
    generation,
    row: 0,
    format: "rgba8unorm",
    layout: "top-left-row-major-tight",
    sourceRow: 0,
    width: 2,
    height: 2,
    textureWidth: 2,
    textureHeight: 2,
    logicalWidth: 2,
    logicalHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    rgbaByteLength: 16,
    rgbaSha256: digest(index + 20),
    rgbSha256: digest(index + 40),
    rgb: { black: 0, white: 0, other: 4, unique: 4 },
  };
}

function frame(index) {
  const generation = 100 + index;
  return {
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: index + 1,
    rendererSequence: 200 + index,
    presentation: {
      selected: true,
      field: index % 2 === 0 ? "top" : "bottom",
      address: "0x00300000",
      copyIndex: generation,
      copyRow: 0,
      width: 2,
      height: 2,
    },
    selectedXfb: selectedXfb(index, generation),
    presentedSurface: {
      address: "0x00300000",
      generation,
      row: 0,
      presentationSerial: 500 + index,
      surfaceFormat: index % 2 === 0 ? "bgra8unorm-srgb" : "rgba8unorm-srgb",
      format: "rgba8unorm",
      layout: "top-left-row-major-tight",
      width: 2,
      height: 2,
      rgbaByteLength: 16,
      rgbaSha256: digest(index),
      rgbSha256: digest(index + 10),
      rgb: { black: 0, white: 0, other: 4, unique: 4 },
    },
  };
}

function temporal() {
  const frames = Array.from(
    { length: SMB_TEMPORAL_XFB_CAPACITY },
    (_unused, index) => frame(index),
  );
  return {
    capacity: SMB_TEMPORAL_XFB_CAPACITY,
    frames,
    oracle: deriveTemporalSelectedXfbOracle(frames),
    surfaceOracle: deriveTemporalPresentedSurfaceOracle(frames),
  };
}

function expectFailure(value, code, pathPattern) {
  assert.throws(
    () => verifySmbTemporalPresentedSurfaces(value),
    error => error instanceof TemporalSurfaceValidationError
      && error.code === code
      && pathPattern.test(error.path),
  );
}

function setSurfaceRgb(sample, label, rgb) {
  sample.presentedSurface.rgbaSha256 = label.repeat(64);
  sample.presentedSurface.rgbSha256 = label.repeat(64);
  sample.presentedSurface.rgb = rgb;
}

test("strict presented-surface evidence binds every swapchain capture to its VI present", () => {
  const value = temporal();
  const { oracle, diagnostics } = verifySmbTemporalPresentedSurfaces(value);
  assert.equal(oracle.complete, true);
  assert.equal(oracle.captured, 8);
  assert.equal(oracle.distinctPresentationSerials, 8);
  assert.deepEqual(oracle.missingOrdinals, []);
  assert.deepEqual(oracle.mismatchedPresentationOrdinals, []);
  assert.deepEqual(oracle.presentationSerialRegressions, []);
  assert.equal(oracle.blackWhiteAlternating, false);
  assert.deepEqual(diagnostics, {
    adjacentExactBlackWhiteTransitions: [],
    singleFrameMonochromeOrdinals: [],
    isolatedExactBlackWhiteOrdinals: [],
  });
  assert.deepEqual(oracle, value.surfaceOracle);
});

test("the browser envelope and strict verifier derive the same surface oracle", () => {
  const context = {
    Set,
    temporalSelectedXfbCapacity: SMB_TEMPORAL_XFB_CAPACITY,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("summarizeTemporalPresentedSurfaces"), context, {
    filename: "browser_boot.temporal-surface.js",
  });
  const value = temporal();
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.summarizeTemporalPresentedSurfaces(value.frames))),
    deriveTemporalPresentedSurfaceOracle(value.frames),
  );
});

test("presentation serials are strictly increasing and the reported oracle is exact", () => {
  const repeated = temporal();
  repeated.frames[3].presentedSurface.presentationSerial =
    repeated.frames[2].presentedSurface.presentationSerial;
  expectFailure(repeated, "ordering", /presentationSerial$/);

  const forged = temporal();
  forged.surfaceOracle.complete = false;
  expectFailure(forged, "oracle-mismatch", /\.complete$/);
});

test("the swapchain oracle detects exact black-white flicker", () => {
  const value = temporal();
  for (const [index, sample] of value.frames.entries()) {
    const black = index % 2 === 0;
    setSurfaceRgb(sample, black ? "a" : "b", black
      ? { black: 4, white: 0, other: 0, unique: 1 }
      : { black: 0, white: 4, other: 0, unique: 1 });
  }
  value.surfaceOracle = deriveTemporalPresentedSurfaceOracle(value.frames);
  expectFailure(value, "exact-black-white-alternation", /^\$\.frames$/);
});

test("isolated exact black and white swapchain frames fail independently", () => {
  for (const [label, rgb] of [
    ["black", { black: 4, white: 0, other: 0, unique: 1 }],
    ["white", { black: 0, white: 4, other: 0, unique: 1 }],
  ]) {
    const value = temporal();
    setSurfaceRgb(value.frames[3], label === "black" ? "a" : "b", rgb);
    const diagnostics = deriveTemporalPresentedSurfaceFlickerDiagnostics(value.frames);
    assert.deepEqual(diagnostics.singleFrameMonochromeOrdinals, [4], label);
    assert.deepEqual(diagnostics.isolatedExactBlackWhiteOrdinals, [4], label);
    assert.deepEqual(diagnostics.adjacentExactBlackWhiteTransitions, [], label);
    // Leave the reported surface oracle forged in its healthy state: raw
    // frame evidence must take precedence over an oracle mismatch.
    expectFailure(value, "isolated-exact-black-white-frame", /^\$\.frames$/);
  }
});

test("an embedded adjacent exact black-white pair fails before monochrome guards", () => {
  const value = temporal();
  setSurfaceRgb(
    value.frames[3],
    "a",
    { black: 4, white: 0, other: 0, unique: 1 },
  );
  setSurfaceRgb(
    value.frames[4],
    "b",
    { black: 0, white: 4, other: 0, unique: 1 },
  );
  const diagnostics = deriveTemporalPresentedSurfaceFlickerDiagnostics(value.frames);
  assert.deepEqual(diagnostics.adjacentExactBlackWhiteTransitions, [{
    fromOrdinal: 4,
    toOrdinal: 5,
    from: "black",
    to: "white",
  }]);
  assert.deepEqual(diagnostics.singleFrameMonochromeOrdinals, []);
  assert.deepEqual(diagnostics.isolatedExactBlackWhiteOrdinals, []);
  value.surfaceOracle = deriveTemporalPresentedSurfaceOracle(value.frames);
  expectFailure(value, "adjacent-exact-black-white-transition", /^\$\.frames$/);
});

test("an isolated non-black-white monochrome frame fails without a color threshold", () => {
  const value = temporal();
  setSurfaceRgb(value.frames[3], "e", {
    black: 0,
    white: 0,
    other: 4,
    unique: 1,
  });
  const diagnostics = deriveTemporalPresentedSurfaceFlickerDiagnostics(value.frames);
  assert.deepEqual(diagnostics.singleFrameMonochromeOrdinals, [4]);
  assert.deepEqual(diagnostics.isolatedExactBlackWhiteOrdinals, []);
  assert.deepEqual(diagnostics.adjacentExactBlackWhiteTransitions, []);
  value.surfaceOracle = deriveTemporalPresentedSurfaceOracle(value.frames);
  expectFailure(value, "monochrome-frame", /^\$\.frames$/);
});

test("selected-XFB checkpoint projection stays byte-stable with surface evidence", () => {
  const withSurface = temporal();
  const withoutSurface = structuredClone(withSurface);
  delete withoutSurface.surfaceOracle;
  for (const sample of withoutSurface.frames) delete sample.presentedSurface;
  assert.equal(
    JSON.stringify(projectSmbTemporalSelectedXfb(withSurface)),
    JSON.stringify(projectSmbTemporalSelectedXfb(withoutSurface)),
  );
});
