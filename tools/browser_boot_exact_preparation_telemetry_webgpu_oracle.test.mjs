#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  OPTIONAL_CLIP_DISABLE_7_PACKET_OPTIONS,
  REQUIRED_CLIP_DISABLE_7_PACKET_OPTIONS,
  REQUIRED_CLIP_DISABLE_7_SUPPRESSED_SURFACE,
  evaluateExactRequiredTelemetryResetLifetime,
  evaluateOptionalClipDisable7NativeRoute,
  evaluateRequiredClipDisable7Suppression,
  evaluateRequiredClipDisable7Telemetry,
  snapshotExactRequiredTelemetry,
} from "./browser_boot_exact_preparation_telemetry_oracle.mjs";
import {
  projectionNullOracleCase,
  projectionNullOracleXfb,
} from "./browser_boot_projection_null_oracle.mjs";

function diagnostics({
  aggregate = 0,
  exactPreparation = 0,
  sampler = 0,
  unsupportedClipDisable6 = 0,
  unsupportedClipDisable7 = 0,
  renderPipelinesCreated = 0,
} = {}) {
  return {
    exactRequiredRejectedDraws: aggregate,
    exactRequiredRejectionReasons: {
      exactPreparation,
      sampler,
    },
    exactRequiredPreparationRejectionReasons: {
      unsupportedClipDisable6,
      unsupportedClipDisable7,
    },
    renderPipelinesCreated,
  };
}

function visibleReadback() {
  return {
    width: projectionNullOracleXfb.width,
    height: projectionNullOracleXfb.height,
    rgba: Uint8Array.from(projectionNullOracleCase.expectedRgba),
  };
}

function suppressedReadback() {
  return {
    width: projectionNullOracleXfb.width,
    height: projectionNullOracleXfb.height,
    rgba: Uint8Array.from(
      REQUIRED_CLIP_DISABLE_7_SUPPRESSED_SURFACE.expectedRgba,
    ),
  };
}

test("packet modes pin clip-disable 7 without changing the default builder contract", () => {
  assert.deepEqual(REQUIRED_CLIP_DISABLE_7_PACKET_OPTIONS, {
    exactClipRequired: true,
    xfClipDisable: 7,
    visibleNativeCarrier: true,
  });
  assert.deepEqual(OPTIONAL_CLIP_DISABLE_7_PACKET_OPTIONS, {
    exactClipRequired: false,
    xfClipDisable: 7,
    visibleNativeCarrier: true,
  });
});

test("required telemetry model accepts one exact-preparation clip-disable-7 rejection", () => {
  const before = diagnostics();
  const after = diagnostics({
    aggregate: 1,
    exactPreparation: 1,
    unsupportedClipDisable7: 1,
  });
  assert.deepEqual(evaluateRequiredClipDisable7Telemetry(before, after), {
    pass: true,
    aggregate: 1,
    reasonSum: 1,
    exactPreparation: 1,
    preparationReasonSum: 1,
    unsupportedClipDisable7: 1,
    reasons: {
      exactPreparation: 1,
      sampler: 0,
    },
    preparationReasons: {
      unsupportedClipDisable6: 0,
      unsupportedClipDisable7: 1,
    },
  });

  for (const invalid of [
    diagnostics({
      aggregate: 1,
      exactPreparation: 1,
      unsupportedClipDisable6: 1,
    }),
    diagnostics({
      aggregate: 2,
      exactPreparation: 1,
      sampler: 1,
      unsupportedClipDisable7: 1,
    }),
    diagnostics({
      aggregate: 1,
      exactPreparation: 1,
      unsupportedClipDisable6: 1,
      unsupportedClipDisable7: 1,
    }),
  ]) {
    assert.equal(
      evaluateRequiredClipDisable7Telemetry(before, invalid).pass,
      false,
    );
  }
});

test("required suppression model requires reset-black pixels and no render pipeline", () => {
  const before = diagnostics();
  const after = diagnostics({
    aggregate: 1,
    exactPreparation: 1,
    unsupportedClipDisable7: 1,
  });
  const valid = evaluateRequiredClipDisable7Suppression(
    before,
    after,
    suppressedReadback(),
  );
  assert.equal(valid.pass, true);
  assert.equal(valid.telemetryPass, true);
  assert.equal(valid.noRendererPipelineCreated, true);
  assert.equal(valid.rendererPipelinesCreated, 0);
  assert.equal(valid.suppressedSurfaceObserved, true);
  assert.equal(valid.actualMask, 0);
  assert.equal(
    valid.actualRgbaFnv1a64,
    REQUIRED_CLIP_DISABLE_7_SUPPRESSED_SURFACE.expectedRgbaFnv1a64,
  );

  const rendered = suppressedReadback();
  rendered.rgba.set(visibleReadback().rgba);
  assert.equal(
    evaluateRequiredClipDisable7Suppression(
      before,
      after,
      rendered,
    ).pass,
    false,
  );
  assert.equal(
    evaluateRequiredClipDisable7Suppression(
      before,
      {
        ...after,
        renderPipelinesCreated: 1,
      },
      suppressedReadback(),
    ).pass,
    false,
  );
});

test("telemetry reset lifetime preserves gameplay reset and clears diagnostics reset", () => {
  const recorded = diagnostics({
    aggregate: 1,
    exactPreparation: 1,
    unsupportedClipDisable7: 1,
    renderPipelinesCreated: 3,
  });
  const valid = evaluateExactRequiredTelemetryResetLifetime(
    recorded,
    structuredClone(recorded),
    diagnostics(),
  );
  assert.equal(valid.pass, true);
  assert.equal(valid.rendererResetPreserved, true);
  assert.equal(valid.diagnosticsResetCleared, true);

  assert.equal(
    evaluateExactRequiredTelemetryResetLifetime(
      recorded,
      diagnostics(),
      diagnostics(),
    ).pass,
    false,
  );
  assert.equal(
    evaluateExactRequiredTelemetryResetLifetime(
      recorded,
      structuredClone(recorded),
      diagnostics({
        aggregate: 1,
        exactPreparation: 1,
        unsupportedClipDisable7: 1,
      }),
    ).pass,
    false,
  );
});

test("optional telemetry model requires zero rejection counters and visible native WebGPU work", () => {
  const valid = evaluateOptionalClipDisable7NativeRoute(
    diagnostics({ renderPipelinesCreated: 1 }),
    visibleReadback(),
  );
  assert.equal(valid.pass, true);
  assert.equal(valid.telemetryZero, true);
  assert.equal(valid.nativeRouteObserved, true);
  assert.equal(valid.aggregate, 0);
  assert.equal(valid.reasonSum, 0);
  assert.equal(valid.preparationReasonSum, 0);
  assert.equal(valid.rendererPipelinesCreated, 1);
  assert.equal(valid.actualMask, projectionNullOracleCase.expectedMask);
  assert.equal(
    valid.actualRgbaFnv1a64,
    projectionNullOracleCase.expectedRgbaFnv1a64,
  );

  assert.equal(
    evaluateOptionalClipDisable7NativeRoute(
      diagnostics({
        aggregate: 1,
        exactPreparation: 1,
        unsupportedClipDisable7: 1,
        renderPipelinesCreated: 1,
      }),
      visibleReadback(),
    ).pass,
    false,
  );
  assert.equal(
    evaluateOptionalClipDisable7NativeRoute(
      diagnostics(),
      visibleReadback(),
    ).pass,
    false,
  );
  const wrongPixels = visibleReadback();
  wrongPixels.rgba[0] = 0;
  assert.equal(
    evaluateOptionalClipDisable7NativeRoute(
      diagnostics({ renderPipelinesCreated: 1 }),
      wrongPixels,
    ).pass,
    false,
  );
});

test("telemetry model rejects missing, malformed, and regressing maps", () => {
  assert.throws(
    () => snapshotExactRequiredTelemetry({
      exactRequiredRejectedDraws: 0,
    }),
    /exactRequiredRejectionReasons must be an object/,
  );
  assert.throws(
    () => snapshotExactRequiredTelemetry({
      ...diagnostics(),
      exactRequiredPreparationRejectionReasons: {
        unsupportedClipDisable7: -1,
      },
    }),
    /must be a non-negative safe integer/,
  );
  assert.throws(
    () => evaluateRequiredClipDisable7Telemetry(
      diagnostics({
        aggregate: 1,
        exactPreparation: 1,
        unsupportedClipDisable7: 1,
      }),
      diagnostics(),
    ),
    /aggregate regressed/,
  );
  assert.throws(
    () => evaluateRequiredClipDisable7Telemetry(
      diagnostics(),
      {
        ...diagnostics({
          aggregate: 1,
          exactPreparation: 1,
          unsupportedClipDisable7: 1,
        }),
        exactRequiredRejectionReasons: {
          exactPreparation: 1,
        },
      },
    ),
    /keys changed/,
  );
});
