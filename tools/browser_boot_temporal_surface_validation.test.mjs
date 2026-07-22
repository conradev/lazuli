// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { SMB_TEMPORAL_XFB_CAPACITY } from "./browser_boot_temporal_xfb.mjs";
import {
  TemporalSurfaceValidationError,
  validateTemporalPresentedSurfaceFrames,
} from "./browser_boot_temporal_surface.mjs";

function digest(index) {
  return (index + 1).toString(16).padStart(64, "0");
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

function frames() {
  return Array.from(
    { length: SMB_TEMPORAL_XFB_CAPACITY },
    (_unused, index) => frame(index),
  );
}

function expectFailure(value, pathPattern, capacity = SMB_TEMPORAL_XFB_CAPACITY) {
  assert.throws(
    () => validateTemporalPresentedSurfaceFrames(value, capacity),
    error => error instanceof TemporalSurfaceValidationError
      && pathPattern.test(error.path),
  );
}

test("presented-surface validation accepts ordered canonical WebGPU evidence", () => {
  const value = frames();
  assert.equal(validateTemporalPresentedSurfaceFrames(value), value);
});

test("presented-surface validation fails closed on format, layout, provenance, and counts", () => {
  const cases = [
    [
      "format",
      value => { value[0].presentedSurface.surfaceFormat = "rgb10a2unorm"; },
      /surfaceFormat$/,
    ],
    [
      "canonical layout",
      value => { value[0].presentedSurface.format = "bgra8unorm"; },
      /\.format$/,
    ],
    [
      "address provenance",
      value => { value[0].presentedSurface.address = "0x00300004"; },
      /\.address$/,
    ],
    [
      "generation provenance",
      value => { value[0].presentedSurface.generation += 1; },
      /\.generation$/,
    ],
    [
      "dimensions",
      value => { value[0].presentedSurface.width = 1; },
      /\.width$/,
    ],
    [
      "byte length",
      value => { value[0].presentedSurface.rgbaByteLength = 15; },
      /rgbaByteLength$/,
    ],
    [
      "hash syntax",
      value => { value[0].presentedSurface.rgbSha256 = "ABC"; },
      /rgbSha256$/,
    ],
    [
      "count partition",
      value => { value[0].presentedSurface.rgb.other = 3; },
      /\.rgb$/,
    ],
    [
      "unexpected evidence field",
      value => { value[0].presentedSurface.adapter = "host-dependent"; },
      /presentedSurface$/,
    ],
  ];
  for (const [label, mutate, path] of cases) {
    const value = frames();
    mutate(value);
    assert.throws(
      () => validateTemporalPresentedSurfaceFrames(value),
      error => error instanceof TemporalSurfaceValidationError && path.test(error.path),
      label,
    );
  }
});

test("presented-surface validation rejects incomplete and regressing sequences", () => {
  expectFailure(frames().slice(1), /^\$\.frames$/);

  const rendererRegression = frames();
  rendererRegression[3].rendererSequence = rendererRegression[2].rendererSequence;
  expectFailure(rendererRegression, /rendererSequence$/);

  const presentationRegression = frames();
  presentationRegression[3].presentedSurface.presentationSerial =
    presentationRegression[2].presentedSurface.presentationSerial;
  expectFailure(presentationRegression, /presentationSerial$/);

  expectFailure(frames(), /^\$\.capacity$/, 0);
});
