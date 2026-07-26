import {
  fnv1a64Hex,
  varyingRasterOracleCases,
  varyingRasterOracleXfb,
} from "./browser_boot_varying_raster_oracle.mjs";
import {
  snapshotExactRequiredTelemetry,
} from "./browser_boot_exact_preparation_telemetry_oracle.mjs";

export const IN_FRUSTUM_CLIP_DISABLE_MODES = Object.freeze(
  Array.from({ length: 8 }, (_unused, mode) => mode),
);
export const IN_FRUSTUM_CLIP_DISABLE_VARIANT = "raster0";
export const inFrustumClipDisableOracleCase =
  varyingRasterOracleCases.find(
    (entry) => entry.id === IN_FRUSTUM_CLIP_DISABLE_VARIANT,
  );

if (inFrustumClipDisableOracleCase === undefined) {
  throw new Error("missing varying-raster clip-disable oracle case");
}

const nonNegativeInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
};

function checkedDelta(before, after, name) {
  const delta =
    nonNegativeInteger(after, `${name}.after`) -
    nonNegativeInteger(before, `${name}.before`);
  if (delta < 0) {
    throw new RangeError(`${name} regressed`);
  }
  return delta;
}

function counterMapDelta(before, after, name) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key, index) => key !== afterKeys[index])
  ) {
    throw new TypeError(`${name} keys changed`);
  }
  const counts = Object.fromEntries(
    beforeKeys.map((key) => [
      key,
      checkedDelta(before[key], after[key], `${name}.${key}`),
    ]),
  );
  const sum = Object.values(counts).reduce(
    (total, count) => total + count,
    0,
  );
  return { counts, sum, zero: sum === 0 };
}

function exactReadbackEvidence(readback) {
  if (
    readback === null ||
    typeof readback !== "object" ||
    Array.isArray(readback)
  ) {
    throw new TypeError("readback must be an object");
  }
  const width = nonNegativeInteger(readback.width, "readback.width");
  const height = nonNegativeInteger(readback.height, "readback.height");
  const actualRgba = Array.from(readback.rgba ?? []);
  const expectedRgba = inFrustumClipDisableOracleCase.expectedRgba;
  const dimensionsExact =
    width === varyingRasterOracleXfb.width &&
    height === varyingRasterOracleXfb.height;
  const byteExact =
    actualRgba.length === expectedRgba.length &&
    actualRgba.every(
      (channel, index) => channel === expectedRgba[index],
    );
  const actualRgbaFnv1a64 = fnv1a64Hex(actualRgba);
  const hashExact =
    actualRgbaFnv1a64 ===
    inFrustumClipDisableOracleCase.expectedRgbaFnv1a64;
  return {
    pass: dimensionsExact && byteExact && hashExact,
    dimensionsExact,
    byteExact,
    expectedRgbaFnv1a64:
      inFrustumClipDisableOracleCase.expectedRgbaFnv1a64,
    actualRgbaFnv1a64,
    hashExact,
    width,
    height,
  };
}

export function evaluateInFrustumClipDisable(
  mode,
  beforeDiagnostics,
  afterDiagnostics,
  readback,
) {
  if (!IN_FRUSTUM_CLIP_DISABLE_MODES.includes(mode)) {
    throw new RangeError("mode must be an integer from 0 through 7");
  }
  const before = snapshotExactRequiredTelemetry(beforeDiagnostics);
  const after = snapshotExactRequiredTelemetry(afterDiagnostics);
  const aggregate = checkedDelta(
    before.aggregate,
    after.aggregate,
    "exact required rejection aggregate",
  );
  const reasons = counterMapDelta(
    before.reasons,
    after.reasons,
    "exact required rejection reasons",
  );
  const preparationReasons = counterMapDelta(
    before.preparationReasons,
    after.preparationReasons,
    "exact required preparation rejection reasons",
  );
  const telemetryZero =
    aggregate === 0 && reasons.zero && preparationReasons.zero;

  const managedCoverageDelta = {
    draws: checkedDelta(
      beforeDiagnostics.managedCoverageDraws,
      afterDiagnostics.managedCoverageDraws,
      "managed coverage draws",
    ),
    triangles: checkedDelta(
      beforeDiagnostics.managedCoverageTriangles,
      afterDiagnostics.managedCoverageTriangles,
      "managed coverage triangles",
    ),
  };
  const managedCoverageExact =
    managedCoverageDelta.draws ===
      inFrustumClipDisableOracleCase.expectedManagedCoverage.draws &&
    managedCoverageDelta.triangles ===
      inFrustumClipDisableOracleCase.expectedManagedCoverage.triangles;
  const surface = exactReadbackEvidence(readback);

  return {
    ...surface,
    pass: telemetryZero && managedCoverageExact && surface.pass,
    mode,
    telemetryZero,
    aggregate,
    reasonDelta: reasons.counts,
    reasonSum: reasons.sum,
    preparationReasonDelta: preparationReasons.counts,
    preparationReasonSum: preparationReasons.sum,
    expectedManagedCoverage:
      inFrustumClipDisableOracleCase.expectedManagedCoverage,
    managedCoverageDelta,
    managedCoverageExact,
  };
}
