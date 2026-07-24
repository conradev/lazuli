// SPDX-License-Identifier: GPL-3.0-only

export const SMB_TEMPORAL_XFB_CAPACITY = 8;
export const TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1 = 1;
export const TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2 = 2;
export const TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3 = 3;

const LOWERCASE_HEX_32 = /^0x[0-9a-f]{8}$/;
const LOWERCASE_SHA_256 = /^[0-9a-f]{64}$/;

export class TemporalXfbValidationError extends Error {
  constructor(code, path, detail) {
    super(`temporal XFB ${code} at ${path}: ${detail}`);
    this.name = "TemporalXfbValidationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, detail) {
  throw new TemporalXfbValidationError(code, path, detail);
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

export function temporalXfbScanoutEvidenceVersion(temporal, path = "$") {
  const envelope = requireObject(temporal, path);
  const version = envelope.scanoutEvidenceVersion
    ?? TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1;
  if (
    version !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1
    && version !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2
    && version !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3
  ) {
    fail(
      "envelope",
      `${path}.scanoutEvidenceVersion`,
      `expected 1, 2, or 3, got ${describe(version)}`,
    );
  }
  return version;
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
  const sourceRowStep = requirePositiveInteger(
    value.sourceRowStep,
    `${path}.sourceRowStep`,
  );
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

function validateRgbEvidence(value, path, pixelCount) {
  const rgb = requireObject(value, path);
  requireExactKeys(rgb, ["black", "white", "other", "unique"], path);
  const counts = {};
  for (const field of ["black", "white", "other", "unique"]) {
    counts[field] = requireNonNegativeInteger(rgb[field], `${path}.${field}`);
  }
  const classifiedPixels = counts.black + counts.white + counts.other;
  if (!Number.isSafeInteger(classifiedPixels) || classifiedPixels !== pixelCount) {
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
  const populatedRgbBuckets = Number(counts.black > 0)
    + Number(counts.white > 0)
    + Number(counts.other > 0);
  if (counts.unique < populatedRgbBuckets) {
    fail(
      "envelope",
      `${path}.unique`,
      `expected at least ${populatedRgbBuckets} colors for the populated RGB buckets, got ${counts.unique}`,
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
      "expected the unique-color count to agree with the exact RGB populations",
    );
  }
  return counts;
}

function validateRawViGeometry(presentation, path, width, height, scanout) {
  const pictureConfiguration = requireNonNegativeInteger(
    presentation.pictureConfiguration,
    `${path}.pictureConfiguration`,
  );
  if (pictureConfiguration > 0xffff) {
    fail(
      "envelope",
      `${path}.pictureConfiguration`,
      `expected a 16-bit VI register, got ${pictureConfiguration}`,
    );
  }
  const wordsPerLine = requirePositiveInteger(
    presentation.wordsPerLine,
    `${path}.wordsPerLine`,
  );
  const standardWordsPerLine = requirePositiveInteger(
    presentation.standardWordsPerLine,
    `${path}.standardWordsPerLine`,
  );
  const activeLines = requirePositiveInteger(
    presentation.activeLines,
    `${path}.activeLines`,
  );
  if (typeof presentation.nonInterlaced !== "boolean") {
    fail(
      "envelope",
      `${path}.nonInterlaced`,
      `expected a boolean, got ${describe(presentation.nonInterlaced)}`,
    );
  }
  for (const [field, actual, expected] of [
    ["wordsPerLine", wordsPerLine, (pictureConfiguration >>> 8) & 0x7f],
    ["standardWordsPerLine", standardWordsPerLine, pictureConfiguration & 0xff],
    ["activeLines", activeLines, scanout.fieldHeight],
    ["width", width, wordsPerLine * 16],
    ["fieldStrideBytes", scanout.fieldStrideBytes, standardWordsPerLine * 32],
    ["nonInterlaced", presentation.nonInterlaced, scanout.rowRepeat === 1],
    ["height", height, scanout.fieldHeight * scanout.rowRepeat],
  ]) {
    if (actual !== expected) {
      fail(
        "provenance",
        `${path}.${field}`,
        `expected ${describe(expected)}, got ${describe(actual)}`,
      );
    }
  }
}

function validateV3PresentationField(value, parity, path, displayWidth, displayHeight) {
  const field = requireObject(value, path);
  requireExact(field.field, parity, `${path}.field`);
  const address = requireHex32(field.address, `${path}.address`);
  const copyIndex = requirePositiveInteger(field.copyIndex, `${path}.copyIndex`);
  const copyRow = requireNonNegativeInteger(field.copyRow, `${path}.copyRow`);
  if (copyRow > 1) {
    fail("envelope", `${path}.copyRow`, `expected 0 or 1, got ${copyRow}`);
  }
  requireExact(
    requirePositiveInteger(field.width, `${path}.width`),
    displayWidth,
    `${path}.width`,
  );
  requireExact(
    requirePositiveInteger(field.height, `${path}.height`),
    displayHeight,
    `${path}.height`,
  );
  const scanout = validateScanoutProvenance(field, path, displayHeight);
  requireExact(scanout.scanoutPolicy, "bob", `${path}.scanoutPolicy`);
  requireExact(scanout.rowRepeat, 2, `${path}.rowRepeat`);
  return { address, copyIndex, copyRow, ...scanout };
}

function validateV3EvidenceField(
  value,
  parity,
  path,
  expected,
  displayWidth,
  displayHeight,
) {
  const field = requireObject(value, path);
  const address = requireHex32(field.address, `${path}.address`);
  if (address !== expected.address) {
    fail(
      "provenance",
      `${path}.address`,
      `expected ${expected.address}, got ${address}`,
    );
  }
  const generation = requirePositiveInteger(field.generation, `${path}.generation`);
  if (generation !== expected.copyIndex) {
    fail(
      "provenance",
      `${path}.generation`,
      `expected copy ${expected.copyIndex}, got ${generation}`,
    );
  }
  const row = requireNonNegativeInteger(field.row, `${path}.row`);
  if (row > 1 || row !== expected.copyRow) {
    fail(
      "provenance",
      `${path}.row`,
      `expected row ${expected.copyRow}, got ${row}`,
    );
  }
  const sourceRow = requireNonNegativeInteger(field.sourceRow, `${path}.sourceRow`);
  const textureWidth = requirePositiveInteger(field.textureWidth, `${path}.textureWidth`);
  const textureHeight = requirePositiveInteger(field.textureHeight, `${path}.textureHeight`);
  const logicalWidth = requirePositiveInteger(field.logicalWidth, `${path}.logicalWidth`);
  const logicalHeight = requirePositiveInteger(field.logicalHeight, `${path}.logicalHeight`);
  requireExact(logicalWidth, displayWidth, `${path}.logicalWidth`);
  const expectedSourceRow = Math.floor(row * textureHeight / logicalHeight);
  if (sourceRow !== expectedSourceRow) {
    fail(
      "provenance",
      `${path}.sourceRow`,
      `expected scaled source row ${expectedSourceRow}, got ${sourceRow}`,
    );
  }
  const scanout = validateScanoutProvenance(field, path, displayHeight);
  requireMatchingScanoutProvenance(expected, scanout, path);
  const lastLogicalRow = row + (scanout.fieldHeight - 1) * scanout.sourceRowStep;
  if (lastLogicalRow >= logicalHeight) {
    fail(
      "provenance",
      `${path}.fieldHeight`,
      `last VI source row ${lastLogicalRow} exceeds logical height ${logicalHeight}`,
    );
  }
  const width = requirePositiveInteger(field.width, `${path}.width`);
  const height = requirePositiveInteger(field.height, `${path}.height`);
  requireExact(width, displayWidth, `${path}.width`);
  requireExact(height, scanout.fieldHeight, `${path}.height`);
  const pixelCount = width * height;
  const rgbaByteLength = requirePositiveInteger(
    field.rgbaByteLength,
    `${path}.rgbaByteLength`,
  );
  requireExact(rgbaByteLength, pixelCount * 4, `${path}.rgbaByteLength`);
  requireSha256(field.rgbaSha256, `${path}.rgbaSha256`);
  requireSha256(field.rgbSha256, `${path}.rgbSha256`);
  validateRgbEvidence(field.rgb, `${path}.rgb`, pixelCount);
  return {
    parity,
    address,
    generation,
    row,
    sourceRow,
    textureWidth,
    textureHeight,
    logicalWidth,
    logicalHeight,
    ...scanout,
  };
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
  const presentationSerial = requirePositiveInteger(
    presentation.presentationSerial,
    `${path}.presentation.presentationSerial`,
  );
  if (previous !== null) {
    if (pairEpoch <= previous.presentation.pairEpoch) {
      fail(
        "ordering",
        `${path}.presentation.pairEpoch`,
        `expected a value greater than ${previous.presentation.pairEpoch}, got ${pairEpoch}`,
      );
    }
    if (presentationSerial <= previous.presentation.presentationSerial) {
      fail(
        "ordering",
        `${path}.presentation.presentationSerial`,
        `expected a value greater than ${previous.presentation.presentationSerial}, got ${presentationSerial}`,
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
    fail(
      "envelope",
      `${path}.presentation`,
      `expected dimensions no larger than 1024x1024, got ${width}x${height}`,
    );
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
  for (const [field, actual, expected] of [
    ["address", requireHex32(presentation.address, `${path}.presentation.address`), completion.address],
    ["copyIndex", requirePositiveInteger(presentation.copyIndex, `${path}.presentation.copyIndex`), completion.copyIndex],
    ["copyRow", requireNonNegativeInteger(presentation.copyRow, `${path}.presentation.copyRow`), completion.copyRow],
  ]) {
    if (actual !== expected) {
      fail(
        "provenance",
        `${path}.presentation.${field}`,
        `expected completion field value ${describe(expected)}, got ${describe(actual)}`,
      );
    }
  }
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
  validateRawViGeometry(
    presentation,
    `${path}.presentation`,
    width,
    height,
    presentationScanout,
  );

  const selected = requireObject(frame.selectedXfb, `${path}.selectedXfb`);
  requireExact(selected.pairEpoch, pairEpoch, `${path}.selectedXfb.pairEpoch`);
  requireExact(
    selected.presentationMode,
    presentation.presentationMode,
    `${path}.selectedXfb.presentationMode`,
  );
  requireExact(
    selected.presentationSerial,
    presentationSerial,
    `${path}.selectedXfb.presentationSerial`,
  );
  requireExact(
    selected.compositionPolicy,
    presentation.compositionPolicy,
    `${path}.selectedXfb.compositionPolicy`,
  );
  const displayWidth = requirePositiveInteger(
    selected.displayWidth,
    `${path}.selectedXfb.displayWidth`,
  );
  const displayHeight = requirePositiveInteger(
    selected.displayHeight,
    `${path}.selectedXfb.displayHeight`,
  );
  requireExact(displayWidth, width, `${path}.selectedXfb.displayWidth`);
  requireExact(displayHeight, height, `${path}.selectedXfb.displayHeight`);
  requireExact(selected.format, "rgba8unorm", `${path}.selectedXfb.format`);
  requireExact(
    selected.layout,
    "top-left-row-major-tight",
    `${path}.selectedXfb.layout`,
  );
  requireExact(
    requirePositiveInteger(selected.width, `${path}.selectedXfb.width`),
    displayWidth,
    `${path}.selectedXfb.width`,
  );
  requireExact(
    requirePositiveInteger(selected.height, `${path}.selectedXfb.height`),
    displayHeight,
    `${path}.selectedXfb.height`,
  );
  const selectedFields = requireObject(selected.fields, `${path}.selectedXfb.fields`);
  requireExactKeys(selectedFields, ["top", "bottom"], `${path}.selectedXfb.fields`);
  for (const parity of ["top", "bottom"]) {
    validateV3EvidenceField(
      selectedFields[parity],
      parity,
      `${path}.selectedXfb.fields.${parity}`,
      expectedFields[parity],
      displayWidth,
      displayHeight,
    );
  }
  const selectedCompletion = selectedFields[completionField];
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
    requireExact(
      selected[field],
      selectedCompletion[field],
      `${path}.selectedXfb.${field}`,
    );
  }
  const pixelCount = displayWidth * displayHeight;
  requireExact(
    requirePositiveInteger(selected.rgbaByteLength, `${path}.selectedXfb.rgbaByteLength`),
    pixelCount * 4,
    `${path}.selectedXfb.rgbaByteLength`,
  );
  requireSha256(selected.rgbaSha256, `${path}.selectedXfb.rgbaSha256`);
  requireSha256(selected.rgbSha256, `${path}.selectedXfb.rgbSha256`);
  validateRgbEvidence(selected.rgb, `${path}.selectedXfb.rgb`, pixelCount);
}

function framePath(index, suffix = "") {
  return `$.frames[${index}]${suffix}`;
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
  const rendererSequence = requireNonNegativeInteger(
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
  if (presentation.field !== "top" && presentation.field !== "bottom") {
    fail(
      "envelope",
      `${path}.presentation.field`,
      `expected "top" or "bottom", got ${describe(presentation.field)}`,
    );
  }
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
  if (previous !== null && copyIndex < previous.presentation.copyIndex) {
    fail(
      "ordering",
      `${path}.presentation.copyIndex`,
      `expected a value no smaller than ${previous.presentation.copyIndex}, got ${copyIndex}`,
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

  const selected = requireObject(frame.selectedXfb, `${path}.selectedXfb`);
  const selectedAddress = requireHex32(selected.address, `${path}.selectedXfb.address`);
  if (selectedAddress !== presentationAddress) {
    fail(
      "provenance",
      `${path}.selectedXfb.address`,
      `expected presented address ${presentationAddress}, got ${selectedAddress}`,
    );
  }
  const generation = requirePositiveInteger(
    selected.generation,
    `${path}.selectedXfb.generation`,
  );
  if (generation !== copyIndex) {
    fail(
      "provenance",
      `${path}.selectedXfb.generation`,
      `expected presented copy ${copyIndex}, got ${generation}`,
    );
  }
  const selectedRow = requireNonNegativeInteger(selected.row, `${path}.selectedXfb.row`);
  if (selectedRow !== copyRow) {
    fail(
      "provenance",
      `${path}.selectedXfb.row`,
      `expected presented row ${copyRow}, got ${selectedRow}`,
    );
  }
  requireExact(selected.format, "rgba8unorm", `${path}.selectedXfb.format`);
  requireExact(
    selected.layout,
    "top-left-row-major-tight",
    `${path}.selectedXfb.layout`,
  );

  const dimensions = {};
  for (const field of [
    "width",
    "height",
    "textureWidth",
    "textureHeight",
    "logicalWidth",
    "logicalHeight",
    "displayWidth",
    "displayHeight",
  ]) {
    dimensions[field] = requirePositiveInteger(
      selected[field],
      `${path}.selectedXfb.${field}`,
    );
  }
  const sourceRow = requireNonNegativeInteger(
    selected.sourceRow,
    `${path}.selectedXfb.sourceRow`,
  );
  const expectedSourceRow = Math.floor(
    selectedRow * dimensions.textureHeight / dimensions.logicalHeight,
  );
  if (sourceRow !== expectedSourceRow) {
    fail(
      "envelope",
      `${path}.selectedXfb.sourceRow`,
      `expected scaled source row ${expectedSourceRow}, got ${sourceRow}`,
    );
  }
  if (dimensions.width !== dimensions.textureWidth) {
    fail(
      "envelope",
      `${path}.selectedXfb.width`,
      `expected texture width ${dimensions.textureWidth}, got ${dimensions.width}`,
    );
  }
  const expectedHeight = scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2
    ? dimensions.displayHeight
    : dimensions.textureHeight - sourceRow;
  if (dimensions.height !== expectedHeight) {
    fail(
      "envelope",
      `${path}.selectedXfb.height`,
      `expected ${expectedHeight} tight scanout rows, got ${dimensions.height}`,
    );
  }
  if (
    dimensions.displayWidth !== presentationWidth
    || dimensions.displayHeight !== presentationHeight
  ) {
    fail(
      "provenance",
      `${path}.selectedXfb.displayWidth`,
      `expected presented dimensions ${presentationWidth}x${presentationHeight}, got ${dimensions.displayWidth}x${dimensions.displayHeight}`,
    );
  }

  if (scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2) {
    const selectedScanout = validateScanoutProvenance(
      selected,
      `${path}.selectedXfb`,
      dimensions.displayHeight,
    );
    requireMatchingScanoutProvenance(
      presentationScanout,
      selectedScanout,
      `${path}.selectedXfb`,
    );
    const lastLogicalRow = selectedRow
      + (selectedScanout.fieldHeight - 1) * selectedScanout.sourceRowStep;
    if (lastLogicalRow >= dimensions.logicalHeight) {
      fail(
        "provenance",
        `${path}.selectedXfb.fieldHeight`,
        `last VI source row ${lastLogicalRow} exceeds logical height ${dimensions.logicalHeight}`,
      );
    }
  }

  const pixelCount = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) {
    fail("envelope", `${path}.selectedXfb`, "pixel count exceeds the safe integer range");
  }
  const rgbaByteLength = requirePositiveInteger(
    selected.rgbaByteLength,
    `${path}.selectedXfb.rgbaByteLength`,
  );
  if (!Number.isSafeInteger(pixelCount * 4) || rgbaByteLength !== pixelCount * 4) {
    fail(
      "envelope",
      `${path}.selectedXfb.rgbaByteLength`,
      `expected ${pixelCount * 4} tight RGBA8 bytes, got ${rgbaByteLength}`,
    );
  }
  requireSha256(selected.rgbaSha256, `${path}.selectedXfb.rgbaSha256`);
  requireSha256(selected.rgbSha256, `${path}.selectedXfb.rgbSha256`);

  const rgb = requireObject(selected.rgb, `${path}.selectedXfb.rgb`);
  const counts = {};
  for (const field of ["black", "white", "other", "unique"]) {
    counts[field] = requireNonNegativeInteger(rgb[field], `${path}.selectedXfb.rgb.${field}`);
  }
  const classifiedPixels = counts.black + counts.white + counts.other;
  if (!Number.isSafeInteger(classifiedPixels) || classifiedPixels !== pixelCount) {
    fail(
      "envelope",
      `${path}.selectedXfb.rgb`,
      `expected ${pixelCount} classified pixels`,
    );
  }
  const maximumUnique = Math.min(pixelCount, 0x1_00_00_00);
  if (counts.unique === 0 || counts.unique > maximumUnique) {
    fail(
      "envelope",
      `${path}.selectedXfb.rgb.unique`,
      `expected 1 through ${maximumUnique}, got ${counts.unique}`,
    );
  }
  const populatedRgbBuckets = Number(counts.black > 0)
    + Number(counts.white > 0)
    + Number(counts.other > 0);
  if (counts.unique < populatedRgbBuckets) {
    fail(
      "envelope",
      `${path}.selectedXfb.rgb.unique`,
      `expected at least ${populatedRgbBuckets} colors for the populated RGB buckets, got ${counts.unique}`,
    );
  }
  const uniformPopulation = counts.black === pixelCount
    || counts.white === pixelCount
    || counts.other === pixelCount;
  const exactBlackOrWhite = counts.black === pixelCount || counts.white === pixelCount;
  if ((counts.unique === 1 && !uniformPopulation) || (exactBlackOrWhite && counts.unique !== 1)) {
    fail(
      "envelope",
      `${path}.selectedXfb.rgb.unique`,
      "expected the unique-color count to agree with the exact RGB populations",
    );
  }
}

export function validateTemporalSelectedXfbFrames(
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

export function deriveTemporalSelectedXfbOracle(
  frames,
  capacity = SMB_TEMPORAL_XFB_CAPACITY,
) {
  if (!Array.isArray(frames)) {
    fail("envelope", "$.frames", `expected an array, got ${describe(frames)}`);
  }
  const paired = frames.length !== 0
    && frames.every(frame => frame?.presentation?.pairEpoch !== undefined);
  const classified = frames.map(frame => {
    const selected = frame.selectedXfb;
    const pixels = selected === null ? 0 : selected.width * selected.height;
    let matchesPresentation;
    let generation;
    let fields;
    let sourceBlackWhiteSplit;
    if (paired) {
      matchesPresentation = selected !== null
        && selected.pairEpoch === frame.presentation.pairEpoch
        && selected.presentationMode === frame.presentation.presentationMode
        && selected.presentationSerial === frame.presentation.presentationSerial
        && selected.compositionPolicy === frame.presentation.compositionPolicy
        && selected.displayWidth === frame.presentation.width
        && selected.displayHeight === frame.presentation.height
        && ["top", "bottom"].every(parity => {
          const actual = selected.fields?.[parity];
          const expected = frame.presentation.fields?.[parity];
          return actual?.address === expected?.address
            && actual?.generation === expected?.copyIndex
            && actual?.row === expected?.copyRow
            && VI_SCANOUT_PROVENANCE_FIELDS.every(
              field => actual?.[field] === expected?.[field],
            );
        });
      const summarizeField = parity => {
        const field = selected?.fields?.[parity] ?? null;
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
      generation = selected?.fields?.[frame.presentation.completionField]?.generation
        ?? null;
    } else {
      matchesPresentation = selected !== null
        && selected.address === frame.presentation.address
        && selected.generation === frame.presentation.copyIndex
        && selected.row === frame.presentation.copyRow
        && selected.displayWidth === frame.presentation.width
        && selected.displayHeight === frame.presentation.height
        && VI_SCANOUT_PROVENANCE_FIELDS.every(
          field => selected[field] === frame.presentation[field],
        );
      generation = selected?.generation ?? null;
      fields = undefined;
      sourceBlackWhiteSplit = undefined;
    }
    const classifiedFrame = {
      ordinal: frame.ordinal,
      rendererSequence: frame.rendererSequence,
      copyIndex: frame.presentation.copyIndex,
      generation,
      rgbaSha256: selected?.rgbaSha256 ?? null,
      rgbSha256: selected?.rgbSha256 ?? null,
      selected: frame.presentation.selected && selected !== null,
      matchesPresentation,
      monochrome: selected !== null && selected.rgb.unique === 1,
      allBlack: selected !== null && selected.rgb.black === pixels,
      allWhite: selected !== null && selected.rgb.white === pixels,
    };
    if (paired) {
      return {
        ordinal: classifiedFrame.ordinal,
        rendererSequence: classifiedFrame.rendererSequence,
        pairEpoch: frame.presentation.pairEpoch,
        copyIndex: classifiedFrame.copyIndex,
        generation: classifiedFrame.generation,
        rgbaSha256: classifiedFrame.rgbaSha256,
        rgbSha256: classifiedFrame.rgbSha256,
        selected: classifiedFrame.selected,
        matchesPresentation: classifiedFrame.matchesPresentation,
        monochrome: classifiedFrame.monochrome,
        allBlack: classifiedFrame.allBlack,
        allWhite: classifiedFrame.allWhite,
        sourceBlackWhiteSplit,
        fields,
      };
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
    captured: classified.length,
    capacity,
    complete: classified.length === capacity,
    distinctRgbaHashes: new Set(rgbaHashes).size,
    distinctRgbHashes: new Set(rgbHashes).size,
    distinctGenerations: new Set(classified
      .map(frame => frame.generation)
      .filter(generation => generation !== null)).size,
    distinctCopyIndices: new Set(classified.map(frame => frame.copyIndex)).size,
    missingOrUnselectedOrdinals: classified
      .filter(frame => !frame.selected)
      .map(frame => frame.ordinal),
    mismatchedPresentationOrdinals: classified
      .filter(frame => frame.selected && !frame.matchesPresentation)
      .map(frame => frame.ordinal),
    generationRegressions: classified
      .filter((frame, index) => index !== 0
        && frame.generation !== null
        && classified[index - 1].generation !== null
        && frame.generation < classified[index - 1].generation)
      .map(frame => frame.ordinal),
    copyIndexRegressions: classified
      .filter((frame, index) => index !== 0
        && frame.copyIndex < classified[index - 1].copyIndex)
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

function projectTemporalSelectedXfbFrame(
  frame,
  scanoutEvidenceVersion = TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1,
) {
  if (scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3) {
    const projectPresentationField = field => ({
      field: field.field,
      address: field.address,
      copyIndex: field.copyIndex,
      copyRow: field.copyRow,
      width: field.width,
      height: field.height,
      scanoutPolicy: field.scanoutPolicy,
      fieldStrideBytes: field.fieldStrideBytes,
      sourceRowStep: field.sourceRowStep,
      fieldHeight: field.fieldHeight,
      rowRepeat: field.rowRepeat,
    });
    const projectEvidenceField = field => ({
      address: field.address,
      generation: field.generation,
      row: field.row,
      sourceRow: field.sourceRow,
      textureWidth: field.textureWidth,
      textureHeight: field.textureHeight,
      logicalWidth: field.logicalWidth,
      logicalHeight: field.logicalHeight,
      scanoutPolicy: field.scanoutPolicy,
      fieldStrideBytes: field.fieldStrideBytes,
      sourceRowStep: field.sourceRowStep,
      fieldHeight: field.fieldHeight,
      rowRepeat: field.rowRepeat,
      width: field.width,
      height: field.height,
      rgbaByteLength: field.rgbaByteLength,
      rgbaSha256: field.rgbaSha256,
      rgbSha256: field.rgbSha256,
      rgb: {
        black: field.rgb.black,
        white: field.rgb.white,
        other: field.rgb.other,
        unique: field.rgb.unique,
      },
    });
    return {
      scenario: frame.scenario,
      step: frame.step,
      ordinal: frame.ordinal,
      rendererSequence: frame.rendererSequence,
      presentation: {
        selected: frame.presentation.selected,
        status: frame.presentation.status,
        presentationMode: frame.presentation.presentationMode,
        pairEpoch: frame.presentation.pairEpoch,
        presentationSerial: frame.presentation.presentationSerial,
        completionField: frame.presentation.completionField,
        compositionPolicy: frame.presentation.compositionPolicy,
        fields: {
          top: projectPresentationField(frame.presentation.fields.top),
          bottom: projectPresentationField(frame.presentation.fields.bottom),
        },
        field: frame.presentation.field,
        address: frame.presentation.address,
        copyIndex: frame.presentation.copyIndex,
        copyRow: frame.presentation.copyRow,
        width: frame.presentation.width,
        height: frame.presentation.height,
        pictureConfiguration: frame.presentation.pictureConfiguration,
        wordsPerLine: frame.presentation.wordsPerLine,
        standardWordsPerLine: frame.presentation.standardWordsPerLine,
        activeLines: frame.presentation.activeLines,
        nonInterlaced: frame.presentation.nonInterlaced,
        scanoutPolicy: frame.presentation.scanoutPolicy,
        fieldStrideBytes: frame.presentation.fieldStrideBytes,
        sourceRowStep: frame.presentation.sourceRowStep,
        fieldHeight: frame.presentation.fieldHeight,
        rowRepeat: frame.presentation.rowRepeat,
      },
      selectedXfb: {
        pairEpoch: frame.selectedXfb.pairEpoch,
        presentationMode: frame.selectedXfb.presentationMode,
        presentationSerial: frame.selectedXfb.presentationSerial,
        compositionPolicy: frame.selectedXfb.compositionPolicy,
        displayWidth: frame.selectedXfb.displayWidth,
        displayHeight: frame.selectedXfb.displayHeight,
        fields: {
          top: projectEvidenceField(frame.selectedXfb.fields.top),
          bottom: projectEvidenceField(frame.selectedXfb.fields.bottom),
        },
        address: frame.selectedXfb.address,
        generation: frame.selectedXfb.generation,
        row: frame.selectedXfb.row,
        sourceRow: frame.selectedXfb.sourceRow,
        textureWidth: frame.selectedXfb.textureWidth,
        textureHeight: frame.selectedXfb.textureHeight,
        logicalWidth: frame.selectedXfb.logicalWidth,
        logicalHeight: frame.selectedXfb.logicalHeight,
        scanoutPolicy: frame.selectedXfb.scanoutPolicy,
        fieldStrideBytes: frame.selectedXfb.fieldStrideBytes,
        sourceRowStep: frame.selectedXfb.sourceRowStep,
        fieldHeight: frame.selectedXfb.fieldHeight,
        rowRepeat: frame.selectedXfb.rowRepeat,
        format: frame.selectedXfb.format,
        layout: frame.selectedXfb.layout,
        width: frame.selectedXfb.width,
        height: frame.selectedXfb.height,
        rgbaByteLength: frame.selectedXfb.rgbaByteLength,
        rgbaSha256: frame.selectedXfb.rgbaSha256,
        rgbSha256: frame.selectedXfb.rgbSha256,
        rgb: {
          black: frame.selectedXfb.rgb.black,
          white: frame.selectedXfb.rgb.white,
          other: frame.selectedXfb.rgb.other,
          unique: frame.selectedXfb.rgb.unique,
        },
      },
    };
  }
  const presentation = {
    selected: frame.presentation.selected,
    field: frame.presentation.field,
    address: frame.presentation.address,
    copyIndex: frame.presentation.copyIndex,
    copyRow: frame.presentation.copyRow,
    width: frame.presentation.width,
    height: frame.presentation.height,
  };
  const selectedXfb = {
    address: frame.selectedXfb.address,
    generation: frame.selectedXfb.generation,
    row: frame.selectedXfb.row,
    format: frame.selectedXfb.format,
    layout: frame.selectedXfb.layout,
    sourceRow: frame.selectedXfb.sourceRow,
    width: frame.selectedXfb.width,
    height: frame.selectedXfb.height,
    textureWidth: frame.selectedXfb.textureWidth,
    textureHeight: frame.selectedXfb.textureHeight,
    logicalWidth: frame.selectedXfb.logicalWidth,
    logicalHeight: frame.selectedXfb.logicalHeight,
    displayWidth: frame.selectedXfb.displayWidth,
    displayHeight: frame.selectedXfb.displayHeight,
  };
  if (scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2) {
    Object.assign(presentation, {
      pictureConfiguration: frame.presentation.pictureConfiguration,
      wordsPerLine: frame.presentation.wordsPerLine,
      standardWordsPerLine: frame.presentation.standardWordsPerLine,
      activeLines: frame.presentation.activeLines,
      nonInterlaced: frame.presentation.nonInterlaced,
      scanoutPolicy: frame.presentation.scanoutPolicy,
      fieldStrideBytes: frame.presentation.fieldStrideBytes,
      sourceRowStep: frame.presentation.sourceRowStep,
      fieldHeight: frame.presentation.fieldHeight,
      rowRepeat: frame.presentation.rowRepeat,
    });
    Object.assign(selectedXfb, {
      scanoutPolicy: frame.selectedXfb.scanoutPolicy,
      fieldStrideBytes: frame.selectedXfb.fieldStrideBytes,
      sourceRowStep: frame.selectedXfb.sourceRowStep,
      fieldHeight: frame.selectedXfb.fieldHeight,
      rowRepeat: frame.selectedXfb.rowRepeat,
    });
  }
  Object.assign(selectedXfb, {
    rgbaByteLength: frame.selectedXfb.rgbaByteLength,
    rgbaSha256: frame.selectedXfb.rgbaSha256,
    rgbSha256: frame.selectedXfb.rgbSha256,
    rgb: {
      black: frame.selectedXfb.rgb.black,
      white: frame.selectedXfb.rgb.white,
      other: frame.selectedXfb.rgb.other,
      unique: frame.selectedXfb.rgb.unique,
    },
  });
  return {
    scenario: frame.scenario,
    step: frame.step,
    ordinal: frame.ordinal,
    rendererSequence: frame.rendererSequence,
    presentation,
    selectedXfb,
  };
}

export function projectSmbTemporalSelectedXfb(temporal) {
  const scanoutEvidenceVersion = temporalXfbScanoutEvidenceVersion(temporal);
  const { oracle } = verifySmbTemporalSelectedXfb(temporal);
  const projection = {
    capacity: SMB_TEMPORAL_XFB_CAPACITY,
    frames: temporal.frames.map(frame => projectTemporalSelectedXfbFrame(
      frame,
      scanoutEvidenceVersion,
    )),
    oracle,
  };
  return scanoutEvidenceVersion !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1
    ? { scanoutEvidenceVersion, ...projection }
    : projection;
}

function firstDifference(expected, actual, path = "$.oracle") {
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

export function compareTemporalSelectedXfbOracle(reported, derived) {
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

function fractionIsLess(left, right) {
  return BigInt(left.numerator) * BigInt(right.denominator)
    < BigInt(right.numerator) * BigInt(left.denominator);
}

export function temporalXfbCalibrationVector(temporal) {
  const envelope = requireObject(temporal, "$.");
  const scanoutEvidenceVersion = temporalXfbScanoutEvidenceVersion(envelope);
  const capacity = requirePositiveInteger(envelope.capacity, "$.capacity");
  const frames = validateTemporalSelectedXfbFrames(
    envelope.frames,
    capacity,
    scanoutEvidenceVersion,
  );
  const oracle = deriveTemporalSelectedXfbOracle(frames, capacity);
  const perFrame = frames.map((frame, index) => {
    const selected = frame.selectedXfb;
    const pixels = selected.width * selected.height;
    const paired = scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3;
    const result = {
      ordinal: frame.ordinal,
      copyIndex: frame.presentation.copyIndex,
      generation: paired
        ? selected.fields[frame.presentation.completionField].generation
        : selected.generation,
      pixelCount: pixels,
      blackPixels: selected.rgb.black,
      whitePixels: selected.rgb.white,
      otherPixels: selected.rgb.other,
      uniqueRgbColors: selected.rgb.unique,
      rgbSha256: selected.rgbSha256,
      otherCoverage: {
        numerator: selected.rgb.other,
        denominator: pixels,
      },
      monochrome: oracle.frames[index].monochrome,
      allBlack: oracle.frames[index].allBlack,
      allWhite: oracle.frames[index].allWhite,
    };
    if (paired) {
      result.pairEpoch = frame.presentation.pairEpoch;
      result.sourceBlackWhiteSplit = oracle.frames[index].sourceBlackWhiteSplit;
    }
    return result;
  });
  let minimumOtherCoverage = perFrame[0].otherCoverage;
  let maximumConsecutiveIdenticalRgbHashes = 0;
  let currentConsecutiveIdenticalRgbHashes = 0;
  let previousRgbHash = null;
  for (const frame of perFrame) {
    if (fractionIsLess(frame.otherCoverage, minimumOtherCoverage)) {
      minimumOtherCoverage = frame.otherCoverage;
    }
    if (frame.rgbSha256 === previousRgbHash) {
      currentConsecutiveIdenticalRgbHashes += 1;
    } else {
      currentConsecutiveIdenticalRgbHashes = 1;
      previousRgbHash = frame.rgbSha256;
    }
    maximumConsecutiveIdenticalRgbHashes = Math.max(
      maximumConsecutiveIdenticalRgbHashes,
      currentConsecutiveIdenticalRgbHashes,
    );
  }
  const generations = perFrame.map(frame => frame.generation);
  const copyIndices = perFrame.map(frame => frame.copyIndex);
  const vector = {
    schema: scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3
      ? "lazuli-temporal-xfb-calibration-vector-v3"
      : scanoutEvidenceVersion === TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2
        ? "lazuli-temporal-xfb-calibration-vector-v2"
        : "lazuli-temporal-xfb-calibration-vector-v1",
    capacity,
    captured: frames.length,
    distinctRgbaHashes: oracle.distinctRgbaHashes,
    distinctRgbHashes: oracle.distinctRgbHashes,
    distinctGenerations: oracle.distinctGenerations,
    distinctCopyIndices: oracle.distinctCopyIndices,
    generationSpan: Math.max(...generations) - Math.min(...generations),
    copyIndexSpan: Math.max(...copyIndices) - Math.min(...copyIndices),
    minimumOtherPixels: Math.min(...perFrame.map(frame => frame.otherPixels)),
    minimumOtherCoverage: { ...minimumOtherCoverage },
    minimumUniqueRgbColors: Math.min(...perFrame.map(frame => frame.uniqueRgbColors)),
    maximumConsecutiveIdenticalRgbHashes,
    monochromeFrameCount: oracle.monochromeOrdinals.length,
    allBlackFrameCount: oracle.blackOrdinals.length,
    allWhiteFrameCount: oracle.whiteOrdinals.length,
    allFramesMonochrome: oracle.allFramesMonochrome,
    alternatingMonochromePair: oracle.alternatingMonochromePair,
    exactBlackWhiteAlternation: oracle.blackWhiteAlternating,
    frames: perFrame,
  };
  if (scanoutEvidenceVersion !== TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V1) {
    vector.scanoutEvidenceVersion = scanoutEvidenceVersion;
  }
  return vector;
}

export function verifySmbTemporalSelectedXfb(temporal) {
  const envelope = requireObject(temporal, "$.");
  const scanoutEvidenceVersion = temporalXfbScanoutEvidenceVersion(envelope);
  requireExact(envelope.capacity, SMB_TEMPORAL_XFB_CAPACITY, "$.capacity");
  const frames = validateTemporalSelectedXfbFrames(
    envelope.frames,
    SMB_TEMPORAL_XFB_CAPACITY,
    scanoutEvidenceVersion,
  );
  const derived = deriveTemporalSelectedXfbOracle(frames, SMB_TEMPORAL_XFB_CAPACITY);
  if (derived.blackWhiteAlternating) {
    fail(
      "exact-black-white-alternation",
      "$.frames",
      `captured exact black/white alternation at ordinals ${derived.frames
        .map(frame => frame.ordinal)
        .join(", ")}`,
    );
  }
  compareTemporalSelectedXfbOracle(envelope.oracle, derived);
  return {
    scanoutEvidenceVersion,
    oracle: derived,
    calibration: temporalXfbCalibrationVector(envelope),
  };
}
