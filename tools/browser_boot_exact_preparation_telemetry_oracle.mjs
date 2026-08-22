import {
  fnv1a64Hex,
  projectionNullMask,
  projectionNullOracleCase,
  projectionNullOracleXfb,
} from "./browser_boot_projection_null_oracle.mjs";

export const REQUIRED_CLIP_DISABLE_7_PACKET_OPTIONS = Object.freeze({
  exactClipRequired: true,
  xfClipDisable: 7,
  visibleNativeCarrier: true,
});

export const OPTIONAL_CLIP_DISABLE_7_PACKET_OPTIONS = Object.freeze({
  exactClipRequired: false,
  xfClipDisable: 7,
  visibleNativeCarrier: true,
});

const suppressedRgba = Object.freeze(
  Array.from(
    { length: projectionNullOracleXfb.width * projectionNullOracleXfb.height },
    () => [0, 0, 0, 255],
  ).flat(),
);

export const REQUIRED_CLIP_DISABLE_7_SUPPRESSED_SURFACE = Object.freeze({
  expectedMask: 0,
  expectedRgba: suppressedRgba,
  expectedRgbaFnv1a64: "0x0852db856e95b5a5",
});

const requiredObject = (value, name) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
};

const nonNegativeInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
};

function boundedCounts(value, name) {
  const source = requiredObject(value, name);
  const entries = Object.entries(source);
  if (entries.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return Object.fromEntries(
    entries.map(([key, count]) => [
      key,
      nonNegativeInteger(count, `${name}.${key}`),
    ]),
  );
}

function exactKeys(left, right, name) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    throw new TypeError(`${name} keys changed during one telemetry delta`);
  }
  return leftKeys;
}

function subtractCounts(before, after, name) {
  const keys = exactKeys(before, after, name);
  return Object.fromEntries(
    keys.map((key) => {
      const delta = after[key] - before[key];
      if (!Number.isSafeInteger(delta) || delta < 0) {
        throw new RangeError(`${name}.${key} regressed`);
      }
      return [key, delta];
    }),
  );
}

const sumCounts = (counts) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

function countMapsEqual(left, right, name) {
  return exactKeys(left, right, name).every(
    (key) => left[key] === right[key],
  );
}

function exactReadbackEvidence(readback, expected, name) {
  const surface = requiredObject(readback, name);
  const width = nonNegativeInteger(surface.width, `${name}.width`);
  const height = nonNegativeInteger(surface.height, `${name}.height`);
  const rgba = Array.from(surface.rgba ?? []);
  const dimensionsExact =
    width === projectionNullOracleXfb.width &&
    height === projectionNullOracleXfb.height;
  const byteExact =
    rgba.length === expected.expectedRgba.length &&
    rgba.every(
      (channel, index) => channel === expected.expectedRgba[index],
    );
  const actualMask = projectionNullMask(rgba);
  const actualRgbaFnv1a64 = fnv1a64Hex(rgba);
  const maskExact = actualMask === expected.expectedMask;
  const hashExact =
    actualRgbaFnv1a64 === expected.expectedRgbaFnv1a64;
  return {
    pass: dimensionsExact && byteExact && maskExact && hashExact,
    dimensionsExact,
    byteExact,
    expectedMask: expected.expectedMask,
    actualMask,
    maskExact,
    expectedRgbaFnv1a64: expected.expectedRgbaFnv1a64,
    actualRgbaFnv1a64,
    hashExact,
    width,
    height,
  };
}

export function snapshotExactRequiredTelemetry(diagnostics) {
  const source = requiredObject(diagnostics, "diagnostics");
  return {
    aggregate: nonNegativeInteger(
      source.exactRequiredRejectedDraws,
      "diagnostics.exactRequiredRejectedDraws",
    ),
    reasons: boundedCounts(
      source.exactRequiredRejectionReasons,
      "diagnostics.exactRequiredRejectionReasons",
    ),
    preparationReasons: boundedCounts(
      source.exactRequiredPreparationRejectionReasons,
      "diagnostics.exactRequiredPreparationRejectionReasons",
    ),
  };
}

export function evaluateRequiredClipDisable7Telemetry(
  beforeDiagnostics,
  afterDiagnostics,
) {
  const before = snapshotExactRequiredTelemetry(beforeDiagnostics);
  const after = snapshotExactRequiredTelemetry(afterDiagnostics);
  const aggregate = after.aggregate - before.aggregate;
  if (!Number.isSafeInteger(aggregate) || aggregate < 0) {
    throw new RangeError("required rejection aggregate regressed");
  }
  const reasons = subtractCounts(
    before.reasons,
    after.reasons,
    "required rejection reasons",
  );
  const preparationReasons = subtractCounts(
    before.preparationReasons,
    after.preparationReasons,
    "required preparation rejection reasons",
  );
  const reasonSum = sumCounts(reasons);
  const preparationReasonSum = sumCounts(preparationReasons);
  const exactPreparation = reasons.exactPreparation;
  const unsupportedClipDisable7 =
    preparationReasons.unsupportedClipDisable7;
  const pass =
    aggregate === 1 &&
    reasonSum === 1 &&
    exactPreparation === 1 &&
    preparationReasonSum === 1 &&
    unsupportedClipDisable7 === 1;
  return {
    pass,
    aggregate,
    reasonSum,
    exactPreparation,
    preparationReasonSum,
    unsupportedClipDisable7,
    reasons,
    preparationReasons,
  };
}

export function evaluateRequiredClipDisable7Suppression(
  beforeDiagnostics,
  afterDiagnostics,
  readback,
) {
  const telemetry = evaluateRequiredClipDisable7Telemetry(
    beforeDiagnostics,
    afterDiagnostics,
  );
  const beforePipelines = nonNegativeInteger(
    beforeDiagnostics.renderPipelinesCreated,
    "beforeDiagnostics.renderPipelinesCreated",
  );
  const afterPipelines = nonNegativeInteger(
    afterDiagnostics.renderPipelinesCreated,
    "afterDiagnostics.renderPipelinesCreated",
  );
  const rendererPipelinesCreated = afterPipelines - beforePipelines;
  if (
    !Number.isSafeInteger(rendererPipelinesCreated) ||
    rendererPipelinesCreated < 0
  ) {
    throw new RangeError("required renderer pipeline count regressed");
  }
  const surface = exactReadbackEvidence(
    readback,
    REQUIRED_CLIP_DISABLE_7_SUPPRESSED_SURFACE,
    "requiredReadback",
  );
  const noRendererPipelineCreated = rendererPipelinesCreated === 0;
  return {
    ...telemetry,
    ...surface,
    pass:
      telemetry.pass &&
      noRendererPipelineCreated &&
      surface.pass,
    telemetryPass: telemetry.pass,
    noRendererPipelineCreated,
    rendererPipelinesCreated,
    suppressedSurfaceObserved: surface.pass,
  };
}

export function evaluateExactRequiredTelemetryResetLifetime(
  recordedDiagnostics,
  afterRendererResetDiagnostics,
  afterDiagnosticsResetDiagnostics,
) {
  const recorded = snapshotExactRequiredTelemetry(recordedDiagnostics);
  const afterRendererReset = snapshotExactRequiredTelemetry(
    afterRendererResetDiagnostics,
  );
  const afterDiagnosticsReset = snapshotExactRequiredTelemetry(
    afterDiagnosticsResetDiagnostics,
  );
  const rendererResetPreserved =
    recorded.aggregate === afterRendererReset.aggregate &&
    countMapsEqual(
      recorded.reasons,
      afterRendererReset.reasons,
      "renderer-reset required rejection reasons",
    ) &&
    countMapsEqual(
      recorded.preparationReasons,
      afterRendererReset.preparationReasons,
      "renderer-reset required preparation rejection reasons",
    );
  exactKeys(
    recorded.reasons,
    afterDiagnosticsReset.reasons,
    "diagnostics-reset required rejection reasons",
  );
  exactKeys(
    recorded.preparationReasons,
    afterDiagnosticsReset.preparationReasons,
    "diagnostics-reset required preparation rejection reasons",
  );
  const diagnosticsResetCleared =
    afterDiagnosticsReset.aggregate === 0 &&
    sumCounts(afterDiagnosticsReset.reasons) === 0 &&
    sumCounts(afterDiagnosticsReset.preparationReasons) === 0;
  return {
    pass: rendererResetPreserved && diagnosticsResetCleared,
    rendererResetPreserved,
    diagnosticsResetCleared,
    recorded,
    afterRendererReset,
    afterDiagnosticsReset,
  };
}

export function evaluateOptionalClipDisable7NativeRoute(
  diagnostics,
  readback,
) {
  const telemetry = snapshotExactRequiredTelemetry(diagnostics);
  const rendererPipelinesCreated = nonNegativeInteger(
    diagnostics.renderPipelinesCreated,
    "diagnostics.renderPipelinesCreated",
  );
  const surface = exactReadbackEvidence(
    readback,
    projectionNullOracleCase,
    "readback",
  );
  const reasonSum = sumCounts(telemetry.reasons);
  const preparationReasonSum = sumCounts(telemetry.preparationReasons);
  const telemetryZero =
    telemetry.aggregate === 0 &&
    reasonSum === 0 &&
    preparationReasonSum === 0;
  const nativeRouteObserved =
    rendererPipelinesCreated > 0 &&
    surface.pass;
  return {
    ...surface,
    pass: telemetryZero && nativeRouteObserved,
    telemetryZero,
    nativeRouteObserved,
    aggregate: telemetry.aggregate,
    reasonSum,
    preparationReasonSum,
    rendererPipelinesCreated,
  };
}
