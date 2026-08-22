// SPDX-License-Identifier: GPL-3.0-only

import {
  SMB_TEMPORAL_XFB_CAPACITY,
  TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1,
  TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2,
  TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3,
  temporalXfbScanoutEvidenceVersion,
} from "./browser_boot_temporal_xfb.mjs";

const LOWERCASE_HEX_32 = /^0x[0-9a-f]{8}$/;
const LOWERCASE_SHA_256 = /^[0-9a-f]{64}$/;
const SURFACE_FORMATS = new Set([
  "rgba8unorm",
  "rgba8unorm-srgb",
  "bgra8unorm",
  "bgra8unorm-srgb",
]);

export class TemporalSurfaceValidationError extends Error {
  constructor(code, path, detail) {
    super(`temporal presented surface ${code} at ${path}: ${detail}`);
    this.name = "TemporalSurfaceValidationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, detail) {
  throw new TemporalSurfaceValidationError(code, path, detail);
}

function describe(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requireObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("envelope", path, `expected an object, got ${describe(value)}`);
  }
  return value;
}

function requireExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    fail(
      "envelope",
      path,
      `expected keys ${canonical.join(", ")}, got ${actual.join(", ")}`,
    );
  }
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("envelope", path, `expected a non-negative safe integer, got ${describe(value)}`);
  }
  return value;
}

function requirePositiveInteger(value, path) {
  const integer = requireNonNegativeInteger(value, path);
  if (integer === 0) fail("envelope", path, "expected a positive integer, got 0");
  return integer;
}

function requireExact(value, expected, path) {
  if (value !== expected) {
    fail("envelope", path, `expected ${describe(expected)}, got ${describe(value)}`);
  }
  return value;
}

function requireHex32(value, path) {
  if (typeof value !== "string" || !LOWERCASE_HEX_32.test(value)) {
    fail("envelope", path, "expected a lowercase 32-bit hexadecimal value");
  }
  return value;
}

function requireSha256(value, path) {
  if (typeof value !== "string" || !LOWERCASE_SHA_256.test(value)) {
    fail("envelope", path, "expected a lowercase SHA-256 digest");
  }
  return value;
}

const VI_SCANOUT_PROVENANCE_FIELDS = [
  "scanoutPolicy",
  "fieldStrideBytes",
  "sourceRowStep",
  "fieldHeight",
  "rowRepeat",
];

function validateScanoutProvenance(value, path, displayHeight) {
  const scanoutPolicy = value.scanoutPolicy;
  if (scanoutPolicy !== "bob" && scanoutPolicy !== "direct") {
    fail(
      "envelope",
      `${path}.scanoutPolicy`,
      `expected "bob" or "direct", got ${describe(scanoutPolicy)}`,
    );
  }
  const fieldStrideBytes = requirePositiveInteger(
    value.fieldStrideBytes,
    `${path}.fieldStrideBytes`,
  );
  const sourceRowStep = requirePositiveInteger(value.sourceRowStep, `${path}.sourceRowStep`);
  const fieldHeight = requirePositiveInteger(value.fieldHeight, `${path}.fieldHeight`);
  const rowRepeat = requirePositiveInteger(value.rowRepeat, `${path}.rowRepeat`);
  if (rowRepeat !== 1 && rowRepeat !== 2) {
    fail("envelope", `${path}.rowRepeat`, `expected 1 or 2, got ${rowRepeat}`);
  }
  const expectedPolicy = rowRepeat === 2 ? "bob" : "direct";
  if (scanoutPolicy !== expectedPolicy) {
    fail(
      "provenance",
      `${path}.scanoutPolicy`,
      `expected ${expectedPolicy} for row repeat ${rowRepeat}, got ${scanoutPolicy}`,
    );
  }
  if (displayHeight !== fieldHeight * rowRepeat) {
    fail(
      "provenance",
      `${path}.fieldHeight`,
      `expected ${displayHeight} display rows from field height ${fieldHeight} and repeat ${rowRepeat}`,
    );
  }
  return { scanoutPolicy, fieldStrideBytes, sourceRowStep, fieldHeight, rowRepeat };
}

function requireMatchingScanoutProvenance(expected, actual, path) {
  for (const field of VI_SCANOUT_PROVENANCE_FIELDS) {
    if (actual[field] !== expected[field]) {
      fail(
        "provenance",
        `${path}.${field}`,
        `expected ${describe(expected[field])}, got ${describe(actual[field])}`,
      );
    }
  }
}

function framePath(index, suffix = "") {
  return `$.frames[${index}]${suffix}`;
}

function validateRgbCounts(rgb, path, pixelCount) {
  requireExactKeys(rgb, ["black", "white", "other", "unique"], path);
  const counts = {};
  for (const field of ["black", "white", "other", "unique"]) {
    counts[field] = requireNonNegativeInteger(rgb[field], `${path}.${field}`);
  }
  const classified = counts.black + counts.white + counts.other;
  if (!Number.isSafeInteger(classified) || classified !== pixelCount) {
    fail("envelope", path, `expected ${pixelCount} classified pixels`);
  }
  const maximumUnique = Math.min(pixelCount, 0x1_00_00_00);
  if (counts.unique === 0 || counts.unique > maximumUnique) {
    fail(
      "envelope",
      `${path}.unique`,
      `expected 1 through ${maximumUnique}, got ${counts.unique}`,
    );
  }
  const populatedBuckets = Number(counts.black > 0)
    + Number(counts.white > 0)
    + Number(counts.other > 0);
  if (counts.unique < populatedBuckets) {
    fail(
      "envelope",
      `${path}.unique`,
      `expected at least ${populatedBuckets} colors for populated RGB buckets`,
    );
  }
  const uniformPopulation = counts.black === pixelCount
    || counts.white === pixelCount
    || counts.other === pixelCount;
  const exactBlackOrWhite = counts.black === pixelCount || counts.white === pixelCount;
  if ((counts.unique === 1 && !uniformPopulation) || (exactBlackOrWhite && counts.unique !== 1)) {
    fail(
      "envelope",
      `${path}.unique`,
      "expected the unique-color count to agree with exact RGB populations",
    );
  }
  return counts;
}

function validateV3PresentationField(value, parity, path, width, height) {
  const field = requireObject(value, path);
  requireExact(field.field, parity, `${path}.field`);
  const address = requireHex32(field.address, `${path}.address`);
  const copyIndex = requirePositiveInteger(field.copyIndex, `${path}.copyIndex`);
  const copyRow = requireNonNegativeInteger(field.copyRow, `${path}.copyRow`);
  if (copyRow > 1) {
    fail("envelope", `${path}.copyRow`, `expected 0 or 1, got ${copyRow}`);
  }
  requireExact(requirePositiveInteger(field.width, `${path}.width`), width, `${path}.width`);
  requireExact(
    requirePositiveInteger(field.height, `${path}.height`),
    height,
    `${path}.height`,
  );
  const scanout = validateScanoutProvenance(field, path, height);
  requireExact(scanout.scanoutPolicy, "bob", `${path}.scanoutPolicy`);
  requireExact(scanout.rowRepeat, 2, `${path}.rowRepeat`);
  return { address, copyIndex, copyRow, ...scanout };
}

function validateV3EvidenceField(value, path, expected, width, height) {
  const field = requireObject(value, path);
  requireExact(requireHex32(field.address, `${path}.address`), expected.address, `${path}.address`);
  requireExact(
    requirePositiveInteger(field.generation, `${path}.generation`),
    expected.copyIndex,
    `${path}.generation`,
  );
  const row = requireNonNegativeInteger(field.row, `${path}.row`);
  if (row > 1) fail("envelope", `${path}.row`, `expected 0 or 1, got ${row}`);
  requireExact(row, expected.copyRow, `${path}.row`);
  const sourceRow = requireNonNegativeInteger(field.sourceRow, `${path}.sourceRow`);
  const textureHeight = requirePositiveInteger(field.textureHeight, `${path}.textureHeight`);
  const logicalHeight = requirePositiveInteger(field.logicalHeight, `${path}.logicalHeight`);
  requirePositiveInteger(field.textureWidth, `${path}.textureWidth`);
  requireExact(
    requirePositiveInteger(field.logicalWidth, `${path}.logicalWidth`),
    width,
    `${path}.logicalWidth`,
  );
  requireExact(
    sourceRow,
    Math.floor(row * textureHeight / logicalHeight),
    `${path}.sourceRow`,
  );
  const scanout = validateScanoutProvenance(field, path, height);
  requireMatchingScanoutProvenance(expected, scanout, path);
  const lastLogicalRow = row + (scanout.fieldHeight - 1) * scanout.sourceRowStep;
  if (lastLogicalRow >= logicalHeight) {
    fail(
      "provenance",
      `${path}.fieldHeight`,
      `last VI source row ${lastLogicalRow} exceeds logical height ${logicalHeight}`,
    );
  }
  const evidenceWidth = requirePositiveInteger(field.width, `${path}.width`);
  const evidenceHeight = requirePositiveInteger(field.height, `${path}.height`);
  requireExact(evidenceWidth, width, `${path}.width`);
  requireExact(evidenceHeight, scanout.fieldHeight, `${path}.height`);
  const pixelCount = evidenceWidth * evidenceHeight;
  requireExact(
    requirePositiveInteger(field.rgbaByteLength, `${path}.rgbaByteLength`),
    pixelCount * 4,
    `${path}.rgbaByteLength`,
  );
  requireSha256(field.rgbaSha256, `${path}.rgbaSha256`);
  requireSha256(field.rgbSha256, `${path}.rgbSha256`);
  validateRgbCounts(requireObject(field.rgb, `${path}.rgb`), `${path}.rgb`, pixelCount);
  return field;
}

function requireV3EvidenceIdentity(value, path, presentation, expectedFields) {
  const evidence = requireObject(value, path);
  requireExact(evidence.pairEpoch, presentation.pairEpoch, `${path}.pairEpoch`);
  requireExact(
    evidence.presentationMode,
    presentation.presentationMode,
    `${path}.presentationMode`,
  );
  requireExact(
    evidence.presentationSerial,
    presentation.presentationSerial,
    `${path}.presentationSerial`,
  );
  requireExact(
    evidence.compositionPolicy,
    presentation.compositionPolicy,
    `${path}.compositionPolicy`,
  );
  const width = requirePositiveInteger(evidence.displayWidth, `${path}.displayWidth`);
  const height = requirePositiveInteger(evidence.displayHeight, `${path}.displayHeight`);
  requireExact(width, presentation.width, `${path}.displayWidth`);
  requireExact(height, presentation.height, `${path}.displayHeight`);
  const fields = requireObject(evidence.fields, `${path}.fields`);
  requireExactKeys(fields, ["top", "bottom"], `${path}.fields`);
  for (const parity of ["top", "bottom"]) {
    validateV3EvidenceField(
      fields[parity],
      `${path}.fields.${parity}`,
      expectedFields[parity],
      width,
      height,
    );
  }
  const completion = fields[presentation.completionField];
  for (const field of [
    "address",
    "generation",
    "row",
    "sourceRow",
    "textureWidth",
    "textureHeight",
    "logicalWidth",
    "logicalHeight",
    "scanoutPolicy",
    "fieldStrideBytes",
    "sourceRowStep",
    "fieldHeight",
    "rowRepeat",
  ]) {
    requireExact(evidence[field], completion[field], `${path}.${field}`);
  }
  requireExact(evidence.format, "rgba8unorm", `${path}.format`);
  requireExact(evidence.layout, "top-left-row-major-tight", `${path}.layout`);
  requireExact(requirePositiveInteger(evidence.width, `${path}.width`), width, `${path}.width`);
  requireExact(
    requirePositiveInteger(evidence.height, `${path}.height`),
    height,
    `${path}.height`,
  );
  const pixelCount = width * height;
  requireExact(
    requirePositiveInteger(evidence.rgbaByteLength, `${path}.rgbaByteLength`),
    pixelCount * 4,
    `${path}.rgbaByteLength`,
  );
  requireSha256(evidence.rgbaSha256, `${path}.rgbaSha256`);
  requireSha256(evidence.rgbSha256, `${path}.rgbSha256`);
  validateRgbCounts(requireObject(evidence.rgb, `${path}.rgb`), `${path}.rgb`, pixelCount);
  return evidence;
}

function validateV3Frame(frame, index, previous) {
  const path = framePath(index);
  requireObject(frame, path);
  requireExact(frame.scenario, "smb-ready-play", `${path}.scenario`);
  requireExact(frame.step, "post-play-presented", `${path}.step`);
  requireExact(frame.ordinal, index + 1, `${path}.ordinal`);
  const rendererSequence = requirePositiveInteger(
    frame.rendererSequence,
    `${path}.rendererSequence`,
  );
  if (previous !== null && rendererSequence <= previous.rendererSequence) {
    fail(
      "ordering",
      `${path}.rendererSequence`,
      `expected a value greater than ${previous.rendererSequence}, got ${rendererSequence}`,
    );
  }
  const presentation = requireObject(frame.presentation, `${path}.presentation`);
  requireExact(presentation.selected, true, `${path}.presentation.selected`);
  requireExact(
    presentation.status,
    "vi-interlaced-frame-ready",
    `${path}.presentation.status`,
  );
  requireExact(
    presentation.presentationMode,
    "interlaced",
    `${path}.presentation.presentationMode`,
  );
  requireExact(
    presentation.compositionPolicy,
    "field-pair-weave",
    `${path}.presentation.compositionPolicy`,
  );
  const pairEpoch = requirePositiveInteger(
    presentation.pairEpoch,
    `${path}.presentation.pairEpoch`,
  );
  if (pairEpoch > 0xffff_ffff) {
    fail("envelope", `${path}.presentation.pairEpoch`, "expected a positive u32");
  }
  const serial = requirePositiveInteger(
    presentation.presentationSerial,
    `${path}.presentation.presentationSerial`,
  );
  if (previous !== null) {
    if (pairEpoch <= previous.presentation.pairEpoch) {
      fail("ordering", `${path}.presentation.pairEpoch`, "pair epoch did not increase");
    }
    if (serial <= previous.presentation.presentationSerial) {
      fail(
        "ordering",
        `${path}.presentation.presentationSerial`,
        "presentation serial did not increase",
      );
    }
  }
  const completionField = presentation.completionField;
  if (completionField !== "top" && completionField !== "bottom") {
    fail(
      "envelope",
      `${path}.presentation.completionField`,
      `expected "top" or "bottom", got ${describe(completionField)}`,
    );
  }
  requireExact(presentation.field, completionField, `${path}.presentation.field`);
  const width = requirePositiveInteger(presentation.width, `${path}.presentation.width`);
  const height = requirePositiveInteger(presentation.height, `${path}.presentation.height`);
  if (width > 1024 || height > 1024) {
    fail("envelope", `${path}.presentation`, "dimensions exceed 1024x1024");
  }
  const presentationFields = requireObject(
    presentation.fields,
    `${path}.presentation.fields`,
  );
  requireExactKeys(presentationFields, ["top", "bottom"], `${path}.presentation.fields`);
  const expectedFields = {};
  for (const parity of ["top", "bottom"]) {
    expectedFields[parity] = validateV3PresentationField(
      presentationFields[parity],
      parity,
      `${path}.presentation.fields.${parity}`,
      width,
      height,
    );
  }
  const completion = expectedFields[completionField];
  requireExact(presentation.address, completion.address, `${path}.presentation.address`);
  requireExact(presentation.copyIndex, completion.copyIndex, `${path}.presentation.copyIndex`);
  requireExact(presentation.copyRow, completion.copyRow, `${path}.presentation.copyRow`);
  const presentationScanout = validateScanoutProvenance(
    presentation,
    `${path}.presentation`,
    height,
  );
  requireMatchingScanoutProvenance(
    completion,
    presentationScanout,
    `${path}.presentation`,
  );

  const selected = requireV3EvidenceIdentity(
    frame.selectedXfb,
    `${path}.selectedXfb`,
    presentation,
    expectedFields,
  );
  const surface = requireV3EvidenceIdentity(
    frame.presentedSurface,
    `${path}.presentedSurface`,
    presentation,
    expectedFields,
  );
  requireExactKeys(surface, [
    "pairEpoch",
    "presentationMode",
    "presentationSerial",
    "compositionPolicy",
    "displayWidth",
    "displayHeight",
    "fields",
    "address",
    "generation",
    "row",
    "sourceRow",
    "textureWidth",
    "textureHeight",
    "logicalWidth",
    "logicalHeight",
    "scanoutPolicy",
    "fieldStrideBytes",
    "sourceRowStep",
    "fieldHeight",
    "rowRepeat",
    "surfaceFormat",
    "format",
    "layout",
    "width",
    "height",
    "rgbaByteLength",
    "rgbaSha256",
    "rgbSha256",
    "rgb",
  ], `${path}.presentedSurface`);
  if (!SURFACE_FORMATS.has(surface.surfaceFormat)) {
    fail(
      "envelope",
      `${path}.presentedSurface.surfaceFormat`,
      `expected RGBA8/BGRA8 WebGPU surface format, got ${describe(surface.surfaceFormat)}`,
    );
  }
  for (const parity of ["top", "bottom"]) {
    for (const field of ["rgbaByteLength", "rgbaSha256", "rgbSha256"]) {
      requireExact(
        surface.fields[parity][field],
        selected.fields[parity][field],
        `${path}.presentedSurface.fields.${parity}.${field}`,
      );
    }
    requireExact(
      JSON.stringify(surface.fields[parity].rgb),
      JSON.stringify(selected.fields[parity].rgb),
      `${path}.presentedSurface.fields.${parity}.rgb`,
    );
  }
  for (const field of ["rgbaByteLength", "rgbaSha256", "rgbSha256"]) {
    requireExact(
      surface[field],
      selected[field],
      `${path}.presentedSurface.${field}`,
    );
  }
  requireExact(
    JSON.stringify(surface.rgb),
    JSON.stringify(selected.rgb),
    `${path}.presentedSurface.rgb`,
  );
}

function validateFrame(
  frame,
  index,
  previous,
  scanoutEvidenceVersion = TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1,
) {
  const path = framePath(index);
  requireObject(frame, path);
  requireExact(frame.scenario, "smb-ready-play", `${path}.scenario`);
  requireExact(frame.step, "post-play-presented", `${path}.step`);
  requireExact(frame.ordinal, index + 1, `${path}.ordinal`);
  const rendererSequence = requirePositiveInteger(
    frame.rendererSequence,
    `${path}.rendererSequence`,
  );
  if (previous !== null && rendererSequence <= previous.rendererSequence) {
    fail(
      "ordering",
      `${path}.rendererSequence`,
      `expected a value greater than ${previous.rendererSequence}, got ${rendererSequence}`,
    );
  }

  const presentation = requireObject(frame.presentation, `${path}.presentation`);
  requireExact(presentation.selected, true, `${path}.presentation.selected`);
  const presentationAddress = requireHex32(
    presentation.address,
    `${path}.presentation.address`,
  );
  const copyIndex = requirePositiveInteger(
    presentation.copyIndex,
    `${path}.presentation.copyIndex`,
  );
  const copyRow = requireNonNegativeInteger(
    presentation.copyRow,
    `${path}.presentation.copyRow`,
  );
  if (copyRow > 1) {
    fail("envelope", `${path}.presentation.copyRow`, `expected 0 or 1, got ${copyRow}`);
  }
  const presentationWidth = requirePositiveInteger(
    presentation.width,
    `${path}.presentation.width`,
  );
  const presentationHeight = requirePositiveInteger(
    presentation.height,
    `${path}.presentation.height`,
  );
  if (presentationWidth > 1024 || presentationHeight > 1024) {
    fail(
      "envelope",
      `${path}.presentation`,
      `expected dimensions no larger than 1024x1024, got ${presentationWidth}x${presentationHeight}`,
    );
  }

  let presentationScanout = null;
  if (scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2) {
    presentationScanout = validateScanoutProvenance(
      presentation,
      `${path}.presentation`,
      presentationHeight,
    );
    const pictureConfiguration = requireNonNegativeInteger(
      presentation.pictureConfiguration,
      `${path}.presentation.pictureConfiguration`,
    );
    if (pictureConfiguration > 0xffff) {
      fail(
        "envelope",
        `${path}.presentation.pictureConfiguration`,
        `expected a 16-bit VI register, got ${pictureConfiguration}`,
      );
    }
    const wordsPerLine = requirePositiveInteger(
      presentation.wordsPerLine,
      `${path}.presentation.wordsPerLine`,
    );
    const standardWordsPerLine = requirePositiveInteger(
      presentation.standardWordsPerLine,
      `${path}.presentation.standardWordsPerLine`,
    );
    const activeLines = requirePositiveInteger(
      presentation.activeLines,
      `${path}.presentation.activeLines`,
    );
    if (typeof presentation.nonInterlaced !== "boolean") {
      fail(
        "envelope",
        `${path}.presentation.nonInterlaced`,
        `expected a boolean, got ${describe(presentation.nonInterlaced)}`,
      );
    }
    for (const [field, actual, expected] of [
      ["wordsPerLine", wordsPerLine, (pictureConfiguration >>> 8) & 0x7f],
      ["standardWordsPerLine", standardWordsPerLine, pictureConfiguration & 0xff],
      ["activeLines", activeLines, presentationScanout.fieldHeight],
      ["width", presentationWidth, wordsPerLine * 16],
      ["fieldStrideBytes", presentationScanout.fieldStrideBytes, standardWordsPerLine * 32],
      ["nonInterlaced", presentation.nonInterlaced, presentationScanout.rowRepeat === 1],
    ]) {
      if (actual !== expected) {
        fail(
          "provenance",
          `${path}.presentation.${field}`,
          `expected ${describe(expected)}, got ${describe(actual)}`,
        );
      }
    }
  }

  const surface = requireObject(frame.presentedSurface, `${path}.presentedSurface`);
  const surfaceKeys = [
    "address",
    "format",
    "generation",
    "height",
    "layout",
    "presentationSerial",
    "rgb",
    "rgbSha256",
    "rgbaByteLength",
    "rgbaSha256",
    "row",
    "surfaceFormat",
    "width",
  ];
  if (scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2) {
    surfaceKeys.push(...VI_SCANOUT_PROVENANCE_FIELDS);
  }
  requireExactKeys(surface, surfaceKeys, `${path}.presentedSurface`);
  const surfaceAddress = requireHex32(surface.address, `${path}.presentedSurface.address`);
  if (surfaceAddress !== presentationAddress) {
    fail(
      "provenance",
      `${path}.presentedSurface.address`,
      `expected presented address ${presentationAddress}, got ${surfaceAddress}`,
    );
  }
  const generation = requirePositiveInteger(
    surface.generation,
    `${path}.presentedSurface.generation`,
  );
  if (generation !== copyIndex) {
    fail(
      "provenance",
      `${path}.presentedSurface.generation`,
      `expected presented copy ${copyIndex}, got ${generation}`,
    );
  }
  const row = requireNonNegativeInteger(surface.row, `${path}.presentedSurface.row`);
  if (row !== copyRow) {
    fail(
      "provenance",
      `${path}.presentedSurface.row`,
      `expected presented row ${copyRow}, got ${row}`,
    );
  }
  const presentationSerial = requirePositiveInteger(
    surface.presentationSerial,
    `${path}.presentedSurface.presentationSerial`,
  );
  if (
    previous !== null
    && presentationSerial <= previous.presentedSurface.presentationSerial
  ) {
    fail(
      "ordering",
      `${path}.presentedSurface.presentationSerial`,
      `expected a value greater than ${previous.presentedSurface.presentationSerial}, got ${presentationSerial}`,
    );
  }
  if (!SURFACE_FORMATS.has(surface.surfaceFormat)) {
    fail(
      "envelope",
      `${path}.presentedSurface.surfaceFormat`,
      `expected RGBA8/BGRA8 WebGPU surface format, got ${describe(surface.surfaceFormat)}`,
    );
  }
  requireExact(surface.format, "rgba8unorm", `${path}.presentedSurface.format`);
  requireExact(
    surface.layout,
    "top-left-row-major-tight",
    `${path}.presentedSurface.layout`,
  );
  const width = requirePositiveInteger(surface.width, `${path}.presentedSurface.width`);
  const height = requirePositiveInteger(surface.height, `${path}.presentedSurface.height`);
  if (width !== presentationWidth || height !== presentationHeight) {
    fail(
      "provenance",
      `${path}.presentedSurface.width`,
      `expected presented dimensions ${presentationWidth}x${presentationHeight}, got ${width}x${height}`,
    );
  }
  if (scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2) {
    const surfaceScanout = validateScanoutProvenance(
      surface,
      `${path}.presentedSurface`,
      height,
    );
    requireMatchingScanoutProvenance(
      presentationScanout,
      surfaceScanout,
      `${path}.presentedSurface`,
    );
    const selected = requireObject(frame.selectedXfb, `${path}.selectedXfb`);
    const selectedScanout = validateScanoutProvenance(
      selected,
      `${path}.selectedXfb`,
      requirePositiveInteger(selected.displayHeight, `${path}.selectedXfb.displayHeight`),
    );
    requireMatchingScanoutProvenance(
      presentationScanout,
      selectedScanout,
      `${path}.selectedXfb`,
    );
    const selectedRow = requireNonNegativeInteger(selected.row, `${path}.selectedXfb.row`);
    const logicalHeight = requirePositiveInteger(
      selected.logicalHeight,
      `${path}.selectedXfb.logicalHeight`,
    );
    const lastLogicalRow = selectedRow
      + (selectedScanout.fieldHeight - 1) * selectedScanout.sourceRowStep;
    if (lastLogicalRow >= logicalHeight) {
      fail(
        "provenance",
        `${path}.selectedXfb.fieldHeight`,
        `last VI source row ${lastLogicalRow} exceeds logical height ${logicalHeight}`,
      );
    }
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) {
    fail("envelope", `${path}.presentedSurface`, "pixel count exceeds the safe integer range");
  }
  const byteLength = requirePositiveInteger(
    surface.rgbaByteLength,
    `${path}.presentedSurface.rgbaByteLength`,
  );
  if (!Number.isSafeInteger(pixelCount * 4) || byteLength !== pixelCount * 4) {
    fail(
      "envelope",
      `${path}.presentedSurface.rgbaByteLength`,
      `expected ${pixelCount * 4} tight RGBA8 bytes, got ${byteLength}`,
    );
  }
  requireSha256(surface.rgbaSha256, `${path}.presentedSurface.rgbaSha256`);
  requireSha256(surface.rgbSha256, `${path}.presentedSurface.rgbSha256`);
  validateRgbCounts(
    requireObject(surface.rgb, `${path}.presentedSurface.rgb`),
    `${path}.presentedSurface.rgb`,
    pixelCount,
  );
}

export function validateTemporalPresentedSurfaceFrames(
  frames,
  capacity = SMB_TEMPORAL_XFB_CAPACITY,
  scanoutEvidenceVersion = TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1,
) {
  if (
    scanoutEvidenceVersion !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1
    && scanoutEvidenceVersion !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2
    && scanoutEvidenceVersion !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3
  ) {
    fail(
      "envelope",
      "$.scanoutEvidenceVersion",
      `expected 1, 2, or 3, got ${describe(scanoutEvidenceVersion)}`,
    );
  }
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    fail("envelope", "$.capacity", `expected a positive safe integer, got ${describe(capacity)}`);
  }
  if (!Array.isArray(frames)) {
    fail("envelope", "$.frames", `expected an array, got ${describe(frames)}`);
  }
  if (frames.length !== capacity) {
    fail("envelope", "$.frames", `expected ${capacity} frames, got ${frames.length}`);
  }
  for (let index = 0; index < frames.length; index += 1) {
    const previous = index === 0 ? null : frames[index - 1];
    if (scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3) {
      validateV3Frame(frames[index], index, previous);
    } else {
      validateFrame(frames[index], index, previous, scanoutEvidenceVersion);
    }
  }
  return frames;
}

export function deriveTemporalPresentedSurfaceOracle(
  frames,
  capacity = SMB_TEMPORAL_XFB_CAPACITY,
) {
  if (!Array.isArray(frames)) {
    fail("envelope", "$.frames", `expected an array, got ${describe(frames)}`);
  }
  const paired = frames.length !== 0
    && frames.every(frame => frame?.presentation?.pairEpoch !== undefined);
  const classified = frames.map(frame => {
    const surface = frame.presentedSurface;
    const pixels = surface === null ? 0 : surface.width * surface.height;
    let matchesPresentation;
    let generation;
    let fields;
    let sourceBlackWhiteSplit;
    if (paired) {
      matchesPresentation = surface !== null
        && surface.pairEpoch === frame.presentation.pairEpoch
        && surface.presentationMode === frame.presentation.presentationMode
        && surface.presentationSerial === frame.presentation.presentationSerial
        && surface.compositionPolicy === frame.presentation.compositionPolicy
        && surface.displayWidth === frame.presentation.width
        && surface.displayHeight === frame.presentation.height
        && ["top", "bottom"].every(parity => {
          const actual = surface.fields?.[parity];
          const expected = frame.presentation.fields?.[parity];
          return actual?.address === expected?.address
            && actual?.generation === expected?.copyIndex
            && actual?.row === expected?.copyRow
            && VI_SCANOUT_PROVENANCE_FIELDS.every(
              field => actual?.[field] === expected?.[field],
            );
        });
      const summarizeField = parity => {
        const field = surface?.fields?.[parity] ?? null;
        const fieldPixels = field === null ? 0 : field.width * field.height;
        return {
          address: field?.address ?? null,
          generation: field?.generation ?? null,
          rgbaSha256: field?.rgbaSha256 ?? null,
          rgbSha256: field?.rgbSha256 ?? null,
          monochrome: field !== null && field.rgb.unique === 1,
          allBlack: field !== null && field.rgb.black === fieldPixels,
          allWhite: field !== null && field.rgb.white === fieldPixels,
        };
      };
      const top = summarizeField("top");
      const bottom = summarizeField("bottom");
      fields = { top, bottom };
      sourceBlackWhiteSplit =
        (top.allBlack && bottom.allWhite)
        || (top.allWhite && bottom.allBlack);
      generation = surface?.fields?.[frame.presentation.completionField]?.generation
        ?? null;
    } else {
      matchesPresentation = surface !== null
        && surface.address === frame.presentation.address
        && surface.generation === frame.presentation.copyIndex
        && surface.row === frame.presentation.copyRow
        && surface.width === frame.presentation.width
        && surface.height === frame.presentation.height
        && VI_SCANOUT_PROVENANCE_FIELDS.every(
          field => surface[field] === frame.presentation[field],
        );
      generation = surface?.generation ?? null;
    }
    const classifiedFrame = {
      ordinal: frame.ordinal,
      rendererSequence: frame.rendererSequence,
      ...(paired ? { pairEpoch: frame.presentation.pairEpoch } : {}),
      presentationSerial: surface?.presentationSerial ?? null,
      copyIndex: frame.presentation.copyIndex,
      generation,
      rgbaSha256: surface?.rgbaSha256 ?? null,
      rgbSha256: surface?.rgbSha256 ?? null,
      captured: surface !== null,
      matchesPresentation,
      monochrome: surface !== null && surface.rgb.unique === 1,
      allBlack: surface !== null && surface.rgb.black === pixels,
      allWhite: surface !== null && surface.rgb.white === pixels,
    };
    if (paired) {
      classifiedFrame.sourceBlackWhiteSplit = sourceBlackWhiteSplit;
      classifiedFrame.fields = fields;
    }
    return classifiedFrame;
  });
  const rgbaHashes = classified
    .map(frame => frame.rgbaSha256)
    .filter(hash => hash !== null);
  const rgbHashes = classified
    .map(frame => frame.rgbSha256)
    .filter(hash => hash !== null);
  const monochrome = classified.filter(frame => frame.monochrome);
  const blackWhite = classified.filter(frame => frame.allBlack || frame.allWhite);
  const adjacentFramesAlternate = (candidates, key) => candidates.length >= 2
    && candidates.every((frame, index) => index === 0
      || frame[key] !== candidates[index - 1][key]);
  const blackAndWhiteAlternate = candidates => candidates.length >= 2
    && candidates.every((frame, index) => index === 0
      || frame.allBlack !== candidates[index - 1].allBlack);
  const oracle = {
    captured: classified.filter(frame => frame.captured).length,
    capacity,
    complete: classified.length === capacity && classified.every(frame => frame.captured),
    distinctRgbaHashes: new Set(rgbaHashes).size,
    distinctRgbHashes: new Set(rgbHashes).size,
    distinctPresentationSerials: new Set(classified
      .map(frame => frame.presentationSerial)
      .filter(serial => serial !== null)).size,
    missingOrdinals: classified.filter(frame => !frame.captured).map(frame => frame.ordinal),
    mismatchedPresentationOrdinals: classified
      .filter(frame => frame.captured && !frame.matchesPresentation)
      .map(frame => frame.ordinal),
    presentationSerialRegressions: classified
      .filter((frame, index) => index !== 0
        && frame.presentationSerial !== null
        && classified[index - 1].presentationSerial !== null
        && frame.presentationSerial <= classified[index - 1].presentationSerial)
      .map(frame => frame.ordinal),
    monochromeOrdinals: monochrome.map(frame => frame.ordinal),
    blackOrdinals: classified.filter(frame => frame.allBlack).map(frame => frame.ordinal),
    whiteOrdinals: classified.filter(frame => frame.allWhite).map(frame => frame.ordinal),
    allFramesMonochrome: classified.length !== 0
      && monochrome.length === classified.length,
    alternatingMonochromePair: monochrome.length === classified.length
      && new Set(rgbHashes).size === 2
      && adjacentFramesAlternate(classified, "rgbSha256"),
    blackWhiteAlternating: blackWhite.length === classified.length
      && blackAndWhiteAlternate(classified),
  };
  if (paired) {
    oracle.distinctPairEpochs = new Set(classified.map(frame => frame.pairEpoch)).size;
    oracle.sourceBlackWhiteSplitOrdinals = classified
      .filter(frame => frame.sourceBlackWhiteSplit)
      .map(frame => frame.ordinal);
  }
  oracle.frames = classified;
  return oracle;
}

function deriveFlickerDiagnosticsFromClassifiedFrames(classified) {
  const exactBlackWhiteKind = frame => {
    if (frame.allBlack) return "black";
    if (frame.allWhite) return "white";
    return null;
  };
  const adjacentExactBlackWhiteTransitions = [];
  for (let index = 1; index < classified.length; index += 1) {
    const previous = classified[index - 1];
    const current = classified[index];
    const from = exactBlackWhiteKind(previous);
    const to = exactBlackWhiteKind(current);
    if (from !== null && to !== null && from !== to) {
      adjacentExactBlackWhiteTransitions.push({
        fromOrdinal: previous.ordinal,
        toOrdinal: current.ordinal,
        from,
        to,
      });
    }
  }
  const singleFrameMonochromeOrdinals = classified
    .filter((frame, index) => frame.monochrome
      && (index === 0 || !classified[index - 1].monochrome)
      && (index === classified.length - 1 || !classified[index + 1].monochrome))
    .map(frame => frame.ordinal);
  const singleFrameMonochrome = new Set(singleFrameMonochromeOrdinals);
  const isolatedExactBlackWhiteOrdinals = classified
    .filter(frame => singleFrameMonochrome.has(frame.ordinal)
      && exactBlackWhiteKind(frame) !== null)
    .map(frame => frame.ordinal);
  return {
    adjacentExactBlackWhiteTransitions,
    singleFrameMonochromeOrdinals,
    isolatedExactBlackWhiteOrdinals,
  };
}

export function deriveTemporalPresentedSurfaceFlickerDiagnostics(
  frames,
  capacity = SMB_TEMPORAL_XFB_CAPACITY,
) {
  const oracle = deriveTemporalPresentedSurfaceOracle(frames, capacity);
  return deriveFlickerDiagnosticsFromClassifiedFrames(oracle.frames);
}

function firstDifference(expected, actual, path = "$.surfaceOracle") {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { actual, expected, path };
    }
    if (expected.length !== actual.length) {
      return { actual: actual.length, expected: expected.length, path: `${path}.length` };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference !== null) return difference;
    }
    return null;
  }
  const expectedObject = expected !== null && typeof expected === "object";
  const actualObject = actual !== null && typeof actual === "object";
  if (!expectedObject || !actualObject) return { actual, expected, path };
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  const keyDifference = firstDifference(expectedKeys, actualKeys, `${path}.[keys]`);
  if (keyDifference !== null) return keyDifference;
  for (const key of expectedKeys) {
    const difference = firstDifference(expected[key], actual[key], `${path}.${key}`);
    if (difference !== null) return difference;
  }
  return null;
}

export function compareTemporalPresentedSurfaceOracle(reported, derived) {
  const difference = firstDifference(derived, reported);
  if (difference !== null) {
    fail(
      "oracle-mismatch",
      difference.path,
      `expected ${describe(difference.expected)}, got ${describe(difference.actual)}`,
    );
  }
  return true;
}

export function verifySmbTemporalPresentedSurfaces(temporal) {
  const envelope = requireObject(temporal, "$.temporalSelectedXfb");
  const scanoutEvidenceVersion = temporalXfbScanoutEvidenceVersion(envelope);
  requireExact(envelope.capacity, SMB_TEMPORAL_XFB_CAPACITY, "$.capacity");
  const frames = validateTemporalPresentedSurfaceFrames(
    envelope.frames,
    SMB_TEMPORAL_XFB_CAPACITY,
    scanoutEvidenceVersion,
  );
  const derived = deriveTemporalPresentedSurfaceOracle(
    frames,
    SMB_TEMPORAL_XFB_CAPACITY,
  );
  const diagnostics = deriveFlickerDiagnosticsFromClassifiedFrames(derived.frames);
  if (derived.blackWhiteAlternating) {
    fail(
      "exact-black-white-alternation",
      "$.frames",
      `captured exact black/white swapchain alternation at ordinals ${derived.frames
        .map(frame => frame.ordinal)
        .join(", ")}`,
    );
  }
  if (diagnostics.adjacentExactBlackWhiteTransitions.length !== 0) {
    fail(
      "adjacent-exact-black-white-transition",
      "$.frames",
      `captured adjacent exact black/white swapchain transition(s): ${diagnostics
        .adjacentExactBlackWhiteTransitions
        .map(transition => `${transition.fromOrdinal}:${transition.from}`
          + `->${transition.toOrdinal}:${transition.to}`)
        .join(", ")}`,
    );
  }
  if (diagnostics.isolatedExactBlackWhiteOrdinals.length !== 0) {
    fail(
      "isolated-exact-black-white-frame",
      "$.frames",
      `captured isolated exact black/white swapchain frame(s) at ordinals ${diagnostics
        .isolatedExactBlackWhiteOrdinals
        .join(", ")}`,
    );
  }
  if (derived.monochromeOrdinals.length !== 0) {
    fail(
      "monochrome-frame",
      "$.frames",
      `captured monochrome swapchain frame(s) at ordinals ${derived.monochromeOrdinals
        .join(", ")}`,
    );
  }
  compareTemporalPresentedSurfaceOracle(envelope.surfaceOracle, derived);
  return { scanoutEvidenceVersion, oracle: derived, diagnostics };
}
