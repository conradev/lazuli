// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  SMB_TEMPORAL_XFB_CAPACITY,
  TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1,
  TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2,
  TemporalXfbValidationError,
  deriveTemporalSelectedXfbOracle,
  projectSmbTemporalSelectedXfb,
  temporalXfbCalibrationVector,
  validateTemporalSelectedXfbFrames,
  verifySmbTemporalSelectedXfb,
} from "./browser_boot_temporal_xfb.mjs";

function digest(index) {
  return (index + 1).toString(16).padStart(64, "0");
}

function makeFrame(index) {
  const generation = 100 + Math.floor(index / 2);
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
    selectedXfb: {
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
      rgbaSha256: digest(index),
      rgbSha256: digest(index),
      rgb: { black: 0, white: 0, other: 4, unique: 4 },
    },
  };
}

function makeFrames() {
  return Array.from({ length: SMB_TEMPORAL_XFB_CAPACITY }, (_unused, index) =>
    makeFrame(index));
}

function makeTemporal(frames = makeFrames()) {
  return {
    capacity: SMB_TEMPORAL_XFB_CAPACITY,
    frames,
    oracle: deriveTemporalSelectedXfbOracle(frames),
  };
}

function makeV2Frame(index) {
  const bottom = index % 2 === 1;
  const generation = 300 + index;
  const row = bottom ? 1 : 0;
  const pixels = 16 * 4;
  const scanout = {
    scanoutPolicy: "bob",
    fieldStrideBytes: 64,
    sourceRowStep: 2,
    fieldHeight: 2,
    rowRepeat: 2,
  };
  return {
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: index + 1,
    rendererSequence: 400 + index,
    presentation: {
      selected: true,
      field: bottom ? "bottom" : "top",
      address: bottom ? "0x00300020" : "0x00300000",
      copyIndex: generation,
      copyRow: row,
      width: 16,
      height: 4,
      pictureConfiguration: 0x0102,
      wordsPerLine: 1,
      standardWordsPerLine: 2,
      activeLines: 2,
      nonInterlaced: false,
      ...scanout,
    },
    selectedXfb: {
      address: bottom ? "0x00300020" : "0x00300000",
      generation,
      row,
      format: "rgba8unorm",
      layout: "top-left-row-major-tight",
      sourceRow: row,
      width: 16,
      height: 4,
      textureWidth: 16,
      textureHeight: 4,
      logicalWidth: 16,
      logicalHeight: 4,
      displayWidth: 16,
      displayHeight: 4,
      ...scanout,
      rgbaByteLength: pixels * 4,
      rgbaSha256: digest(index + 30),
      rgbSha256: digest(index + 50),
      rgb: { black: 0, white: 0, other: pixels, unique: 4 },
    },
  };
}

function makeV2Temporal() {
  const frames = Array.from(
    { length: SMB_TEMPORAL_XFB_CAPACITY },
    (_unused, index) => makeV2Frame(index),
  );
  return {
    scanoutEvidenceVersion: TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2,
    capacity: SMB_TEMPORAL_XFB_CAPACITY,
    frames,
    oracle: deriveTemporalSelectedXfbOracle(frames),
  };
}

function updateOracle(temporal) {
  temporal.oracle = deriveTemporalSelectedXfbOracle(temporal.frames, temporal.capacity);
  return temporal;
}

function expectFailure(temporal, code, pathPattern) {
  assert.throws(
    () => verifySmbTemporalSelectedXfb(temporal),
    error => error instanceof TemporalXfbValidationError
      && error.code === code
      && pathPattern.test(error.path),
  );
}

test("raw temporal frames derive every page oracle field", () => {
  const frames = makeFrames();
  const oracle = deriveTemporalSelectedXfbOracle(frames);
  assert.deepEqual(oracle, {
    captured: 8,
    capacity: 8,
    complete: true,
    distinctRgbaHashes: 8,
    distinctRgbHashes: 8,
    distinctGenerations: 4,
    distinctCopyIndices: 4,
    missingOrUnselectedOrdinals: [],
    mismatchedPresentationOrdinals: [],
    generationRegressions: [],
    copyIndexRegressions: [],
    monochromeOrdinals: [],
    blackOrdinals: [],
    whiteOrdinals: [],
    allFramesMonochrome: false,
    alternatingMonochromePair: false,
    blackWhiteAlternating: false,
    frames: frames.map(frame => ({
      ordinal: frame.ordinal,
      rendererSequence: frame.rendererSequence,
      copyIndex: frame.presentation.copyIndex,
      generation: frame.selectedXfb.generation,
      rgbaSha256: frame.selectedXfb.rgbaSha256,
      rgbSha256: frame.selectedXfb.rgbSha256,
      selected: true,
      matchesPresentation: true,
      monochrome: false,
      allBlack: false,
      allWhite: false,
    })),
  });
  assert.doesNotThrow(() => verifySmbTemporalSelectedXfb(makeTemporal(frames)));
});

test("legacy v1 replay preserves the published bottom-field crop contract", () => {
  const implicit = makeTemporal();
  const bottom = implicit.frames[1];
  bottom.presentation.copyRow = 1;
  bottom.selectedXfb.row = 1;
  bottom.selectedXfb.sourceRow = 1;
  bottom.selectedXfb.height = 1;
  bottom.selectedXfb.rgbaByteLength = 8;
  bottom.selectedXfb.rgb = { black: 0, white: 0, other: 2, unique: 2 };
  updateOracle(implicit);
  assert.equal(
    verifySmbTemporalSelectedXfb(implicit).scanoutEvidenceVersion,
    TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1,
  );

  const explicit = structuredClone(implicit);
  explicit.scanoutEvidenceVersion = TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1;
  assert.doesNotThrow(() => verifySmbTemporalSelectedXfb(explicit));
  assert.deepEqual(
    projectSmbTemporalSelectedXfb(explicit),
    projectSmbTemporalSelectedXfb(implicit),
  );
});

test("v2 binds raw VI geometry to an exact integer-row bob plan", () => {
  const temporal = makeV2Temporal();
  const evidence = verifySmbTemporalSelectedXfb(temporal);
  assert.equal(evidence.scanoutEvidenceVersion, TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2);
  assert.equal(evidence.calibration.schema, "lazuli-temporal-xfb-calibration-vector-v2");
  assert.equal(evidence.calibration.scanoutEvidenceVersion, 2);

  const projected = projectSmbTemporalSelectedXfb(temporal);
  assert.deepEqual(Object.keys(projected), [
    "scanoutEvidenceVersion",
    "capacity",
    "frames",
    "oracle",
  ]);
  assert.deepEqual(
    projected.frames.map(frame => frame.selectedXfb.row),
    [0, 1, 0, 1, 0, 1, 0, 1],
  );
  assert.deepEqual(Object.keys(projected.frames[0].presentation), [
    "selected",
    "field",
    "address",
    "copyIndex",
    "copyRow",
    "width",
    "height",
    "pictureConfiguration",
    "wordsPerLine",
    "standardWordsPerLine",
    "activeLines",
    "nonInterlaced",
    "scanoutPolicy",
    "fieldStrideBytes",
    "sourceRowStep",
    "fieldHeight",
    "rowRepeat",
  ]);
  for (const field of [
    "scanoutPolicy",
    "fieldStrideBytes",
    "sourceRowStep",
    "fieldHeight",
    "rowRepeat",
  ]) {
    assert.equal(
      projected.frames[0].selectedXfb[field],
      projected.frames[0].presentation[field],
    );
  }
});

test("v2 fails closed on scanout plan, raw geometry, and version mismatches", () => {
  const cases = [
    [
      "old cropped height",
      temporal => { temporal.frames[1].selectedXfb.height = 3; },
      /selectedXfb\.height$/,
    ],
    [
      "policy",
      temporal => { temporal.frames[0].presentation.scanoutPolicy = "direct"; },
      /presentation\.scanoutPolicy$/,
    ],
    [
      "selected provenance",
      temporal => { temporal.frames[0].selectedXfb.sourceRowStep = 1; },
      /selectedXfb\.sourceRowStep$/,
    ],
    [
      "last source row",
      temporal => { temporal.frames[1].selectedXfb.logicalHeight = 3; },
      /selectedXfb\.fieldHeight$/,
    ],
    [
      "raw picture configuration",
      temporal => { temporal.frames[0].presentation.pictureConfiguration = 0x0103; },
      /presentation\.standardWordsPerLine$/,
    ],
  ];
  for (const [label, mutate, pathPattern] of cases) {
    const temporal = makeV2Temporal();
    mutate(temporal);
    assert.throws(
      () => verifySmbTemporalSelectedXfb(temporal),
      error => error instanceof TemporalXfbValidationError
        && error.code !== "oracle-mismatch"
        && pathPattern.test(error.path),
      label,
    );
  }

  const unknown = makeV2Temporal();
  unknown.scanoutEvidenceVersion = 3;
  expectFailure(unknown, "envelope", /scanoutEvidenceVersion$/);
  assert.throws(
    () => validateTemporalSelectedXfbFrames(unknown.frames, unknown.capacity, 3),
    error => error instanceof TemporalXfbValidationError
      && /scanoutEvidenceVersion$/.test(error.path),
  );
});

test("checkpoint projection keeps only canonical independently derived evidence", () => {
  const temporal = makeTemporal();
  temporal.hostDiagnostic = "ignored";
  temporal.frames[0].hostTimestamp = 1234;
  temporal.frames[0].presentation.browserOnly = true;
  temporal.frames[0].selectedXfb.gpuLabel = "adapter-dependent";
  temporal.frames[0].selectedXfb.rgb.untrustedBucket = 4;

  const projected = projectSmbTemporalSelectedXfb(temporal);
  assert.deepEqual(Object.keys(projected), ["capacity", "frames", "oracle"]);
  assert.deepEqual(Object.keys(projected.frames[0]), [
    "scenario",
    "step",
    "ordinal",
    "rendererSequence",
    "presentation",
    "selectedXfb",
  ]);
  assert.deepEqual(Object.keys(projected.frames[0].presentation), [
    "selected",
    "field",
    "address",
    "copyIndex",
    "copyRow",
    "width",
    "height",
  ]);
  assert.deepEqual(Object.keys(projected.frames[0].selectedXfb), [
    "address",
    "generation",
    "row",
    "format",
    "layout",
    "sourceRow",
    "width",
    "height",
    "textureWidth",
    "textureHeight",
    "logicalWidth",
    "logicalHeight",
    "displayWidth",
    "displayHeight",
    "rgbaByteLength",
    "rgbaSha256",
    "rgbSha256",
    "rgb",
  ]);
  assert.deepEqual(projected.frames[0].selectedXfb.rgb, {
    black: 0,
    white: 0,
    other: 4,
    unique: 4,
  });
  assert.deepEqual(projected.oracle, deriveTemporalSelectedXfbOracle(projected.frames));
  assert.notEqual(projected.frames[0], temporal.frames[0]);
  assert.notEqual(projected.oracle, temporal.oracle);
});

test("checkpoint projection fails closed before copying unstable temporal evidence", () => {
  const forgedOracle = makeTemporal();
  forgedOracle.oracle.complete = false;
  expectFailure(forgedOracle, "oracle-mismatch", /complete$/);
  assert.throws(
    () => projectSmbTemporalSelectedXfb(forgedOracle),
    error => error instanceof TemporalXfbValidationError
      && error.code === "oracle-mismatch"
      && /complete$/.test(error.path),
  );

  const alternating = makeTemporal();
  for (const [index, frame] of alternating.frames.entries()) {
    const black = index % 2 === 0;
    frame.selectedXfb.rgbaSha256 = black ? "a".repeat(64) : "b".repeat(64);
    frame.selectedXfb.rgbSha256 = black ? "c".repeat(64) : "d".repeat(64);
    frame.selectedXfb.rgb = black
      ? { black: 4, white: 0, other: 0, unique: 1 }
      : { black: 0, white: 4, other: 0, unique: 1 };
  }
  updateOracle(alternating);
  assert.throws(
    () => projectSmbTemporalSelectedXfb(alternating),
    error => error instanceof TemporalXfbValidationError
      && error.code === "exact-black-white-alternation",
  );
});

test("Node recomputation stays in deep parity with the page oracle", () => {
  const browserSource = readFileSync(
    new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
    "utf8",
  );
  const start = browserSource.indexOf("function summarizeTemporalSelectedXfb(");
  assert.notEqual(start, -1);
  const bodyStart = browserSource.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < browserSource.length; index += 1) {
    if (browserSource[index] === "{") depth += 1;
    if (browserSource[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.notEqual(end, -1);
  const context = vm.createContext({
    Set,
    temporalSelectedXfbCapacity: SMB_TEMPORAL_XFB_CAPACITY,
    viScanoutProvenanceEqual: (left, right) => [
      "scanoutPolicy",
      "fieldStrideBytes",
      "sourceRowStep",
      "fieldHeight",
      "rowRepeat",
    ].every(name => left?.[name] === right?.[name]),
  });
  vm.runInContext(browserSource.slice(start, end), context);

  const frames = makeFrames();
  const expected = deriveTemporalSelectedXfbOracle(frames);
  const actual = context.summarizeTemporalSelectedXfb(structuredClone(frames));
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
});

test("raw exact black/white alternation cannot be hidden by a forged stable oracle", () => {
  const stableOracle = makeTemporal().oracle;
  const frames = makeFrames();
  for (const [index, frame] of frames.entries()) {
    const black = index % 2 === 0;
    frame.selectedXfb.rgbaSha256 = black ? "a".repeat(64) : "b".repeat(64);
    frame.selectedXfb.rgbSha256 = black ? "c".repeat(64) : "d".repeat(64);
    frame.selectedXfb.rgb = black
      ? { black: 4, white: 0, other: 0, unique: 1 }
      : { black: 0, white: 4, other: 0, unique: 1 };
  }
  const temporal = {
    capacity: SMB_TEMPORAL_XFB_CAPACITY,
    frames,
    oracle: stableOracle,
  };
  expectFailure(temporal, "exact-black-white-alternation", /^\$\.frames$/);
});

test("other monochrome patterns remain diagnostics instead of invented thresholds", () => {
  const allBlack = makeTemporal();
  for (const frame of allBlack.frames) {
    frame.selectedXfb.rgbaSha256 = "a".repeat(64);
    frame.selectedXfb.rgbSha256 = "b".repeat(64);
    frame.selectedXfb.rgb = { black: 4, white: 0, other: 0, unique: 1 };
    frame.presentation.copyIndex = 100;
    frame.selectedXfb.generation = 100;
  }
  updateOracle(allBlack);
  const allBlackEvidence = verifySmbTemporalSelectedXfb(allBlack);
  assert.equal(allBlackEvidence.oracle.allFramesMonochrome, true);
  assert.equal(allBlackEvidence.oracle.alternatingMonochromePair, false);
  assert.equal(allBlackEvidence.oracle.blackWhiteAlternating, false);
  assert.equal(allBlackEvidence.oracle.distinctGenerations, 1);
  assert.equal(allBlackEvidence.oracle.distinctRgbHashes, 1);

  const arbitraryPair = makeTemporal();
  for (const [index, frame] of arbitraryPair.frames.entries()) {
    frame.selectedXfb.rgbaSha256 = index % 2 === 0 ? "c".repeat(64) : "d".repeat(64);
    frame.selectedXfb.rgbSha256 = index % 2 === 0 ? "e".repeat(64) : "f".repeat(64);
    frame.selectedXfb.rgb = { black: 0, white: 0, other: 4, unique: 1 };
  }
  updateOracle(arbitraryPair);
  const arbitraryEvidence = verifySmbTemporalSelectedXfb(arbitraryPair);
  assert.equal(arbitraryEvidence.oracle.allFramesMonochrome, true);
  assert.equal(arbitraryEvidence.oracle.alternatingMonochromePair, true);
  assert.equal(arbitraryEvidence.oracle.blackWhiteAlternating, false);

  const interruptedBlackWhite = structuredClone(arbitraryPair);
  for (const [index, frame] of interruptedBlackWhite.frames.entries()) {
    const black = index % 2 === 0;
    frame.selectedXfb.rgbSha256 = black ? "1".repeat(64) : "2".repeat(64);
    frame.selectedXfb.rgb = black
      ? { black: 4, white: 0, other: 0, unique: 1 }
      : { black: 0, white: 4, other: 0, unique: 1 };
  }
  interruptedBlackWhite.frames[3].selectedXfb.rgb = {
    black: 0,
    white: 0,
    other: 4,
    unique: 4,
  };
  updateOracle(interruptedBlackWhite);
  assert.equal(
    verifySmbTemporalSelectedXfb(interruptedBlackWhite).oracle.blackWhiteAlternating,
    false,
  );
});

test("page oracle values and shape must deeply match raw-frame recomputation", () => {
  const wrongCount = makeTemporal();
  wrongCount.oracle.distinctGenerations = 1;
  expectFailure(wrongCount, "oracle-mismatch", /distinctGenerations$/);

  const missingField = makeTemporal();
  delete missingField.oracle.blackOrdinals;
  expectFailure(missingField, "oracle-mismatch", /\[keys\]/);

  const extraField = makeTemporal();
  extraField.oracle.untrustedVerdict = "stable";
  expectFailure(extraField, "oracle-mismatch", /\[keys\]/);

  const wrongClassifiedFrame = makeTemporal();
  wrongClassifiedFrame.oracle.frames[4].matchesPresentation = false;
  expectFailure(wrongClassifiedFrame, "oracle-mismatch", /frames\[4\]\.matchesPresentation$/);
});

test("temporal frame envelopes reject malformed structure and provenance", () => {
  const cases = [
    ["scenario", temporal => { temporal.frames[0].scenario = "other"; }, /scenario$/],
    ["ordinal", temporal => { temporal.frames[2].ordinal = 9; }, /ordinal$/],
    [
      "renderer ordering",
      temporal => { temporal.frames[3].rendererSequence = temporal.frames[2].rendererSequence; },
      /rendererSequence$/,
    ],
    ["selection", temporal => { temporal.frames[0].presentation.selected = false; }, /selected$/],
    ["field", temporal => { temporal.frames[0].presentation.field = "both"; }, /field$/],
    ["address syntax", temporal => { temporal.frames[0].presentation.address = "0x300000"; }, /address$/],
    ["zero copy", temporal => { temporal.frames[0].presentation.copyIndex = 0; }, /copyIndex$/],
    ["copy row", temporal => { temporal.frames[0].presentation.copyRow = 2; }, /copyRow$/],
    ["VI dimensions", temporal => { temporal.frames[0].presentation.width = 1025; }, /presentation$/],
    [
      "copy regression",
      temporal => {
        temporal.frames[3].presentation.copyIndex = 99;
        temporal.frames[3].selectedXfb.generation = 99;
      },
      /copyIndex$/,
    ],
    ["selected object", temporal => { temporal.frames[0].selectedXfb = null; }, /selectedXfb$/],
    ["selected address", temporal => { temporal.frames[0].selectedXfb.address = "0x00400000"; }, /address$/],
    ["generation", temporal => { temporal.frames[0].selectedXfb.generation += 1; }, /generation$/],
    ["row", temporal => { temporal.frames[0].selectedXfb.row = 1; }, /row$/],
    ["format", temporal => { temporal.frames[0].selectedXfb.format = "bgra8unorm"; }, /format$/],
    ["layout", temporal => { temporal.frames[0].selectedXfb.layout = "padded"; }, /layout$/],
    ["source row", temporal => { temporal.frames[0].selectedXfb.sourceRow = 1; }, /sourceRow$/],
    ["texture width", temporal => { temporal.frames[0].selectedXfb.textureWidth = 3; }, /width$/],
    ["cropped height", temporal => { temporal.frames[0].selectedXfb.textureHeight = 3; }, /height$/],
    ["display width", temporal => { temporal.frames[0].selectedXfb.displayWidth = 3; }, /displayWidth$/],
    ["byte length", temporal => { temporal.frames[0].selectedXfb.rgbaByteLength = 15; }, /rgbaByteLength$/],
    ["RGBA hash", temporal => { temporal.frames[0].selectedXfb.rgbaSha256 = "ABC"; }, /rgbaSha256$/],
    ["RGB hash", temporal => { temporal.frames[0].selectedXfb.rgbSha256 = "xyz"; }, /rgbSha256$/],
    ["negative count", temporal => { temporal.frames[0].selectedXfb.rgb.black = -1; }, /black$/],
    ["count sum", temporal => { temporal.frames[0].selectedXfb.rgb.other = 3; }, /rgb$/],
    ["zero colors", temporal => { temporal.frames[0].selectedXfb.rgb.unique = 0; }, /unique$/],
    ["too many colors", temporal => { temporal.frames[0].selectedXfb.rgb.unique = 5; }, /unique$/],
    [
      "uniform population",
      temporal => {
        temporal.frames[0].selectedXfb.rgb = { black: 4, white: 0, other: 0, unique: 2 };
      },
      /unique$/,
    ],
    [
      "nonuniform singleton",
      temporal => {
        temporal.frames[0].selectedXfb.rgb = { black: 1, white: 0, other: 3, unique: 1 };
      },
      /unique$/,
    ],
    [
      "populated color buckets",
      temporal => {
        temporal.frames[0].selectedXfb.rgb = { black: 1, white: 1, other: 2, unique: 2 };
      },
      /unique$/,
    ],
  ];
  for (const [label, mutate, pathPattern] of cases) {
    const temporal = makeTemporal();
    mutate(temporal);
    assert.throws(
      () => verifySmbTemporalSelectedXfb(temporal),
      error => error instanceof TemporalXfbValidationError
        && error.code !== "oracle-mismatch"
        && pathPattern.test(error.path),
      label,
    );
  }
});

test("calibration vectors preserve raw extrema without imposing thresholds", () => {
  const temporal = makeTemporal();
  temporal.frames[0].selectedXfb.rgb = { black: 1, white: 0, other: 3, unique: 3 };
  temporal.frames[1].selectedXfb.rgb = { black: 2, white: 0, other: 2, unique: 2 };
  temporal.frames[2].selectedXfb.rgbSha256 = temporal.frames[1].selectedXfb.rgbSha256;
  temporal.frames[3].selectedXfb.rgbSha256 = temporal.frames[1].selectedXfb.rgbSha256;
  updateOracle(temporal);

  const vector = temporalXfbCalibrationVector(temporal);
  assert.equal(vector.schema, "lazuli-temporal-xfb-calibration-vector-v1");
  assert.equal(vector.capacity, 8);
  assert.equal(vector.captured, 8);
  assert.equal(vector.distinctGenerations, 4);
  assert.equal(vector.distinctCopyIndices, 4);
  assert.equal(vector.generationSpan, 3);
  assert.equal(vector.copyIndexSpan, 3);
  assert.equal(vector.minimumOtherPixels, 2);
  assert.deepEqual(vector.minimumOtherCoverage, { numerator: 2, denominator: 4 });
  assert.equal(vector.minimumUniqueRgbColors, 2);
  assert.equal(vector.maximumConsecutiveIdenticalRgbHashes, 3);
  assert.equal(vector.monochromeFrameCount, 0);
  assert.equal(vector.exactBlackWhiteAlternation, false);
  assert.equal(vector.frames.length, 8);
  assert.deepEqual(vector.frames[1].otherCoverage, { numerator: 2, denominator: 4 });
});
