import {
  fnv1a64Hex,
  projectionNullMask,
  projectionNullOracleCase,
  projectionNullOracleXfb,
  buildProjectionNullOraclePacket,
} from "./browser_boot_projection_null_oracle.mjs";
import {
  snapshotExactRequiredTelemetry,
} from "./browser_boot_exact_preparation_telemetry_oracle.mjs";

const blackRgba = Object.freeze(
  Array.from(
    { length: projectionNullOracleXfb.width * projectionNullOracleXfb.height },
    () => [0, 0, 0, 255],
  ).flat(),
);

export const FACE_CULL_BLACK_RGBA_FNV1A64 = "0x0852db856e95b5a5";

export const faceCullOracleCases = Object.freeze([
  Object.freeze({
    id: "required-back",
    cullMode: 1,
    exactClipRequired: true,
    reverseNativeWinding: false,
    expectedMask: 0,
    expectedRgba: blackRgba,
    expectedRgbaFnv1a64: FACE_CULL_BLACK_RGBA_FNV1A64,
  }),
  Object.freeze({
    id: "required-front",
    cullMode: 2,
    exactClipRequired: true,
    reverseNativeWinding: true,
    expectedMask: 0,
    expectedRgba: blackRgba,
    expectedRgbaFnv1a64: FACE_CULL_BLACK_RGBA_FNV1A64,
  }),
  Object.freeze({
    id: "optional-back",
    cullMode: 1,
    exactClipRequired: false,
    reverseNativeWinding: false,
    expectedMask: projectionNullOracleCase.expectedMask,
    expectedRgba: projectionNullOracleCase.expectedRgba,
    expectedRgbaFnv1a64: projectionNullOracleCase.expectedRgbaFnv1a64,
  }),
  Object.freeze({
    id: "optional-front",
    cullMode: 2,
    exactClipRequired: false,
    reverseNativeWinding: true,
    expectedMask: projectionNullOracleCase.expectedMask,
    expectedRgba: projectionNullOracleCase.expectedRgba,
    expectedRgbaFnv1a64: projectionNullOracleCase.expectedRgbaFnv1a64,
  }),
]);

const sumCounts = (counts) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

function subtractCounts(before, after, name) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key, index) => key !== afterKeys[index])
  ) {
    throw new TypeError(`${name} keys changed`);
  }
  return Object.fromEntries(
    beforeKeys.map((key) => {
      const delta = after[key] - before[key];
      if (!Number.isSafeInteger(delta) || delta < 0) {
        throw new RangeError(`${name}.${key} regressed`);
      }
      return [key, delta];
    }),
  );
}

function caseById(id) {
  const entry = faceCullOracleCases.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new RangeError(`unknown face-cull oracle case ${id}`);
  }
  return entry;
}

export function buildFaceCullOraclePacket(id, generation) {
  const entry = caseById(id);
  return buildProjectionNullOraclePacket(generation, {
    cullMode: entry.cullMode,
    exactClipRequired: entry.exactClipRequired,
    reverseNativeWinding: entry.reverseNativeWinding,
    visibleNativeCarrier: true,
  });
}

export function evaluateFaceCullOracleCase(
  id,
  beforeDiagnostics,
  afterDiagnostics,
  readback,
) {
  const entry = caseById(id);
  const before = snapshotExactRequiredTelemetry(beforeDiagnostics);
  const after = snapshotExactRequiredTelemetry(afterDiagnostics);
  const aggregate = after.aggregate - before.aggregate;
  if (!Number.isSafeInteger(aggregate) || aggregate < 0) {
    throw new RangeError("exact-required rejection aggregate regressed");
  }
  const reasons = subtractCounts(
    before.reasons,
    after.reasons,
    "exact-required rejection reasons",
  );
  const preparationReasons = subtractCounts(
    before.preparationReasons,
    after.preparationReasons,
    "exact-required preparation rejection reasons",
  );
  const renderPipelinesCreated =
    afterDiagnostics.renderPipelinesCreated -
    beforeDiagnostics.renderPipelinesCreated;
  if (
    !Number.isSafeInteger(renderPipelinesCreated) ||
    renderPipelinesCreated < 0
  ) {
    throw new RangeError("render pipeline count regressed");
  }

  const rgba = Array.from(readback.rgba ?? []);
  const dimensionsExact =
    readback.width === projectionNullOracleXfb.width &&
    readback.height === projectionNullOracleXfb.height;
  const byteExact =
    rgba.length === entry.expectedRgba.length &&
    rgba.every((channel, index) => channel === entry.expectedRgba[index]);
  const actualMask = projectionNullMask(rgba);
  const actualRgbaFnv1a64 = fnv1a64Hex(rgba);
  const surfaceExact =
    dimensionsExact &&
    byteExact &&
    actualMask === entry.expectedMask &&
    actualRgbaFnv1a64 === entry.expectedRgbaFnv1a64;
  const reasonSum = sumCounts(reasons);
  const preparationReasonSum = sumCounts(preparationReasons);
  const telemetryExact = entry.exactClipRequired
    ? aggregate === 1 &&
      reasonSum === 1 &&
      reasons.exactPreparation === 1 &&
      preparationReasonSum === 1 &&
      preparationReasons.uncertifiedFaceCull === 1
    : aggregate === 0 &&
      reasonSum === 0 &&
      preparationReasonSum === 0;
  const routeExact = entry.exactClipRequired
    ? renderPipelinesCreated === 0
    : renderPipelinesCreated > 0;

  return {
    id: entry.id,
    cullMode: entry.cullMode,
    exactClipRequired: entry.exactClipRequired,
    pass: telemetryExact && routeExact && surfaceExact,
    telemetryExact,
    routeExact,
    surfaceExact,
    aggregate,
    reasons,
    preparationReasons,
    renderPipelinesCreated,
    expectedMask: entry.expectedMask,
    actualMask,
    expectedRgbaFnv1a64: entry.expectedRgbaFnv1a64,
    actualRgbaFnv1a64,
    dimensionsExact,
    byteExact,
  };
}

export { projectionNullOracleXfb as faceCullOracleXfb };
