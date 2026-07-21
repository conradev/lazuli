// SPDX-License-Identifier: GPL-3.0-only

export const SMB_TEMPORAL_XFB_CAPACITY = 8;

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

function framePath(index, suffix = "") {
  return `$.frames[${index}]${suffix}`;
}

function validateFrame(frame, index, previous) {
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
  if (dimensions.height !== dimensions.textureHeight - sourceRow) {
    fail(
      "envelope",
      `${path}.selectedXfb.height`,
      `expected cropped texture height ${dimensions.textureHeight - sourceRow}, got ${dimensions.height}`,
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
) {
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
    validateFrame(frames[index], index, index === 0 ? null : frames[index - 1]);
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
  const classified = frames.map(frame => {
    const selected = frame.selectedXfb;
    const pixels = selected === null ? 0 : selected.width * selected.height;
    const matchesPresentation = selected !== null
      && selected.address === frame.presentation.address
      && selected.generation === frame.presentation.copyIndex
      && selected.row === frame.presentation.copyRow
      && selected.displayWidth === frame.presentation.width
      && selected.displayHeight === frame.presentation.height;
    return {
      ordinal: frame.ordinal,
      rendererSequence: frame.rendererSequence,
      copyIndex: frame.presentation.copyIndex,
      generation: selected?.generation ?? null,
      rgbaSha256: selected?.rgbaSha256 ?? null,
      rgbSha256: selected?.rgbSha256 ?? null,
      selected: frame.presentation.selected && selected !== null,
      matchesPresentation,
      monochrome: selected !== null && selected.rgb.unique === 1,
      allBlack: selected !== null && selected.rgb.black === pixels,
      allWhite: selected !== null && selected.rgb.white === pixels,
    };
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
  return {
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
    frames: classified,
  };
}

function projectTemporalSelectedXfbFrame(frame) {
  return {
    scenario: frame.scenario,
    step: frame.step,
    ordinal: frame.ordinal,
    rendererSequence: frame.rendererSequence,
    presentation: {
      selected: frame.presentation.selected,
      field: frame.presentation.field,
      address: frame.presentation.address,
      copyIndex: frame.presentation.copyIndex,
      copyRow: frame.presentation.copyRow,
      width: frame.presentation.width,
      height: frame.presentation.height,
    },
    selectedXfb: {
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

export function projectSmbTemporalSelectedXfb(temporal) {
  const { oracle } = verifySmbTemporalSelectedXfb(temporal);
  return {
    capacity: SMB_TEMPORAL_XFB_CAPACITY,
    frames: temporal.frames.map(projectTemporalSelectedXfbFrame),
    oracle,
  };
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
  const capacity = requirePositiveInteger(envelope.capacity, "$.capacity");
  const frames = validateTemporalSelectedXfbFrames(envelope.frames, capacity);
  const oracle = deriveTemporalSelectedXfbOracle(frames, capacity);
  const perFrame = frames.map((frame, index) => {
    const selected = frame.selectedXfb;
    const pixels = selected.width * selected.height;
    return {
      ordinal: frame.ordinal,
      copyIndex: frame.presentation.copyIndex,
      generation: selected.generation,
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
  return {
    schema: "lazuli-temporal-xfb-calibration-vector-v1",
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
}

export function verifySmbTemporalSelectedXfb(temporal) {
  const envelope = requireObject(temporal, "$.");
  requireExact(envelope.capacity, SMB_TEMPORAL_XFB_CAPACITY, "$.capacity");
  const frames = validateTemporalSelectedXfbFrames(
    envelope.frames,
    SMB_TEMPORAL_XFB_CAPACITY,
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
    oracle: derived,
    calibration: temporalXfbCalibrationVector(envelope),
  };
}
