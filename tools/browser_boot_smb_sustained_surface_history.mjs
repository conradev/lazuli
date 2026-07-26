// SPDX-License-Identifier: GPL-3.0-only

export const SMB_SUSTAINED_PRESENTED_SURFACE_SCHEMA_V1 =
  "lazuli-smb-sustained-presented-surfaces-v1";
export const SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY = 60;
export const SMB_SUSTAINED_PRESENTED_SURFACE_EXTREME_PPM = 850_000;
export const SMB_SUSTAINED_PRESENTED_SURFACE_DARK_CHANNEL_MAXIMUM = 8;
export const SMB_SUSTAINED_PRESENTED_SURFACE_LIGHT_CHANNEL_MINIMUM = 247;

const HEX_32 = /^0x[0-9a-f]{8}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const SURFACE_FORMATS = new Set([
  "rgba8unorm",
  "rgba8unorm-srgb",
  "bgra8unorm",
  "bgra8unorm-srgb",
]);
const SURFACE_KEYS = [
  "compositionPolicy",
  "displayHeight",
  "displayWidth",
  "fields",
  "format",
  "height",
  "layout",
  "pairEpoch",
  "presentationMode",
  "presentationSerial",
  "rgb",
  "rgbSha256",
  "rgbaByteLength",
  "rgbaSha256",
  "surfaceFormat",
  "visualRgb",
  "width",
];
const FIELD_KEYS = [
  "address",
  "fieldHeight",
  "fieldStrideBytes",
  "generation",
  "height",
  "logicalHeight",
  "logicalWidth",
  "rgb",
  "rgbSha256",
  "rgbaByteLength",
  "rgbaSha256",
  "row",
  "rowRepeat",
  "scanoutPolicy",
  "sourceRow",
  "sourceRowStep",
  "surfaceId",
  "textureHeight",
  "textureWidth",
  "visualRgb",
  "width",
];

export class SmbSustainedSurfaceHistoryValidationError extends Error {
  constructor(code, path, expected, actual) {
    super(
      `SMB sustained surface history ${code} at ${path}: `
      + `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    this.name = "SmbSustainedSurfaceHistoryValidationError";
    this.code = code;
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

function fail(code, path, expected, actual) {
  throw new SmbSustainedSurfaceHistoryValidationError(
    code,
    path,
    expected,
    actual,
  );
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("envelope", path, "an object", value);
  }
  return value;
}

function exact(value, expected, path) {
  if (!Object.is(value, expected)) {
    fail("invariant", path, expected, value);
  }
  return value;
}

function exactKeys(value, keys, path) {
  object(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail("envelope", `${path}.[keys]`, expected, actual);
  }
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("envelope", path, "a positive safe integer", value);
  }
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("envelope", path, "a non-negative safe integer", value);
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== "string" || !SHA_256.test(value)) {
    fail("envelope", path, "a lowercase SHA-256 digest", value);
  }
  return value;
}

function rgbCounts(value, pixels, path) {
  exactKeys(value, ["black", "other", "unique", "white"], path);
  const black = nonNegativeInteger(value.black, `${path}.black`);
  const white = nonNegativeInteger(value.white, `${path}.white`);
  const other = nonNegativeInteger(value.other, `${path}.other`);
  const unique = positiveInteger(value.unique, `${path}.unique`);
  exact(black + white + other, pixels, `${path}.[population]`);
  if (unique > pixels) {
    fail("envelope", `${path}.unique`, `at most ${pixels}`, unique);
  }
  return { black, white, other, unique };
}

function visualRgbCounts(value, pixels, path) {
  exactKeys(value, ["dark", "light", "other"], path);
  const dark = nonNegativeInteger(value.dark, `${path}.dark`);
  const light = nonNegativeInteger(value.light, `${path}.light`);
  const other = nonNegativeInteger(value.other, `${path}.other`);
  exact(dark + light + other, pixels, `${path}.[population]`);
  return { dark, light, other };
}

function isNearExtreme(count, pixels) {
  return count * 1_000_000
    >= pixels * SMB_SUSTAINED_PRESENTED_SURFACE_EXTREME_PPM;
}

function validateField(field, expected, path) {
  exactKeys(field, FIELD_KEYS, path);
  if (typeof field.address !== "string" || !HEX_32.test(field.address)) {
    fail("envelope", `${path}.address`, "a lowercase 32-bit address", field.address);
  }
  exact(field.address, expected.address, `${path}.address`);
  exact(
    positiveInteger(field.generation, `${path}.generation`),
    expected.copyIndex,
    `${path}.generation`,
  );
  exact(nonNegativeInteger(field.row, `${path}.row`), expected.copyRow, `${path}.row`);
  exact(field.scanoutPolicy, "bob", `${path}.scanoutPolicy`);
  exact(positiveInteger(field.rowRepeat, `${path}.rowRepeat`), 2, `${path}.rowRepeat`);
  const fieldHeight = positiveInteger(field.fieldHeight, `${path}.fieldHeight`);
  exact(fieldHeight * field.rowRepeat, expected.height, `${path}.fieldHeight`);
  exact(
    positiveInteger(field.fieldStrideBytes, `${path}.fieldStrideBytes`),
    expected.width * 4,
    `${path}.fieldStrideBytes`,
  );
  const sourceRowStep = exact(
    positiveInteger(field.sourceRowStep, `${path}.sourceRowStep`),
    2,
    `${path}.sourceRowStep`,
  );
  exact(
    positiveInteger(field.logicalWidth, `${path}.logicalWidth`),
    expected.width,
    `${path}.logicalWidth`,
  );
  const logicalHeight = exact(
    positiveInteger(field.logicalHeight, `${path}.logicalHeight`),
    expected.height,
    `${path}.logicalHeight`,
  );
  const lastLogicalRow = field.row + (fieldHeight - 1) * sourceRowStep;
  if (lastLogicalRow >= logicalHeight) {
    fail(
      "provenance",
      `${path}.logicalHeight`,
      `greater than final source row ${lastLogicalRow}`,
      logicalHeight,
    );
  }
  exact(
    positiveInteger(field.textureWidth, `${path}.textureWidth`),
    expected.width,
    `${path}.textureWidth`,
  );
  exact(
    positiveInteger(field.textureHeight, `${path}.textureHeight`),
    expected.height,
    `${path}.textureHeight`,
  );
  exact(
    nonNegativeInteger(field.sourceRow, `${path}.sourceRow`),
    expected.copyRow,
    `${path}.sourceRow`,
  );
  positiveInteger(field.surfaceId, `${path}.surfaceId`);
  exact(positiveInteger(field.width, `${path}.width`), expected.width, `${path}.width`);
  exact(positiveInteger(field.height, `${path}.height`), fieldHeight, `${path}.height`);
  const pixels = field.width * field.height;
  exact(
    positiveInteger(field.rgbaByteLength, `${path}.rgbaByteLength`),
    pixels * 4,
    `${path}.rgbaByteLength`,
  );
  sha256(field.rgbaSha256, `${path}.rgbaSha256`);
  sha256(field.rgbSha256, `${path}.rgbSha256`);
  const rgb = rgbCounts(field.rgb, pixels, `${path}.rgb`);
  const visualRgb = visualRgbCounts(
    field.visualRgb,
    pixels,
    `${path}.visualRgb`,
  );
  if (visualRgb.dark < rgb.black) {
    fail(
      "invariant",
      `${path}.visualRgb.dark`,
      `at least exact-black population ${rgb.black}`,
      visualRgb.dark,
    );
  }
  if (visualRgb.light < rgb.white) {
    fail(
      "invariant",
      `${path}.visualRgb.light`,
      `at least exact-white population ${rgb.white}`,
      visualRgb.light,
    );
  }
  return {
    ...rgb,
    dark: visualRgb.dark,
    light: visualRgb.light,
    visualOther: visualRgb.other,
    pixels,
  };
}

function validateSurface(surface, frameIndex, receipts, previous) {
  const ordinal = frameIndex + 1;
  const path = `$.rendering.sustainedPresentedSurfaces.frames[${frameIndex}]`;
  const firstReceipt = receipts[frameIndex * 2];
  const completionReceipt = receipts[frameIndex * 2 + 1];
  if (firstReceipt === undefined || completionReceipt === undefined) {
    fail("binding", path, "two paired sustained VI receipts", {
      firstReceipt,
      completionReceipt,
    });
  }
  const expectedFields = {
    [firstReceipt.presentation.field]: firstReceipt.presentation,
    [completionReceipt.presentation.field]: completionReceipt.presentation,
  };
  exact(
    Object.keys(expectedFields).sort().join(","),
    "bottom,top",
    `${path}.presentedSurface.fields.[receipt-parities]`,
  );

  exactKeys(surface, SURFACE_KEYS, `${path}.presentedSurface`);
  exact(
    positiveInteger(surface.pairEpoch, `${path}.presentedSurface.pairEpoch`),
    completionReceipt.pairEpoch,
    `${path}.presentedSurface.pairEpoch`,
  );
  if (surface.pairEpoch > 0xffff_ffff) {
    fail(
      "envelope",
      `${path}.presentedSurface.pairEpoch`,
      "a positive u32",
      surface.pairEpoch,
    );
  }
  exact(
    positiveInteger(
      surface.presentationSerial,
      `${path}.presentedSurface.presentationSerial`,
    ),
    completionReceipt.presentationSerial,
    `${path}.presentedSurface.presentationSerial`,
  );
  if (previous !== null) {
    exact(
      surface.pairEpoch,
      previous.pairEpoch + 1,
      `${path}.presentedSurface.pairEpoch`,
    );
    exact(
      surface.presentationSerial,
      previous.presentationSerial + 1,
      `${path}.presentedSurface.presentationSerial`,
    );
  }
  exact(surface.presentationMode, "interlaced", `${path}.presentedSurface.presentationMode`);
  exact(
    surface.compositionPolicy,
    "field-pair-weave",
    `${path}.presentedSurface.compositionPolicy`,
  );
  exact(
    positiveInteger(surface.displayWidth, `${path}.presentedSurface.displayWidth`),
    completionReceipt.presentation.width,
    `${path}.presentedSurface.displayWidth`,
  );
  exact(
    positiveInteger(surface.displayHeight, `${path}.presentedSurface.displayHeight`),
    completionReceipt.presentation.height,
    `${path}.presentedSurface.displayHeight`,
  );
  exact(surface.format, "rgba8unorm", `${path}.presentedSurface.format`);
  exact(
    surface.layout,
    "top-left-row-major-tight",
    `${path}.presentedSurface.layout`,
  );
  if (!SURFACE_FORMATS.has(surface.surfaceFormat)) {
    fail(
      "envelope",
      `${path}.presentedSurface.surfaceFormat`,
      [...SURFACE_FORMATS],
      surface.surfaceFormat,
    );
  }
  exact(
    positiveInteger(surface.width, `${path}.presentedSurface.width`),
    surface.displayWidth,
    `${path}.presentedSurface.width`,
  );
  exact(
    positiveInteger(surface.height, `${path}.presentedSurface.height`),
    surface.displayHeight,
    `${path}.presentedSurface.height`,
  );
  const pixels = surface.width * surface.height;
  exact(
    positiveInteger(
      surface.rgbaByteLength,
      `${path}.presentedSurface.rgbaByteLength`,
    ),
    pixels * 4,
    `${path}.presentedSurface.rgbaByteLength`,
  );
  sha256(surface.rgbaSha256, `${path}.presentedSurface.rgbaSha256`);
  sha256(surface.rgbSha256, `${path}.presentedSurface.rgbSha256`);
  const rgb = rgbCounts(surface.rgb, pixels, `${path}.presentedSurface.rgb`);
  const visualRgb = visualRgbCounts(
    surface.visualRgb,
    pixels,
    `${path}.presentedSurface.visualRgb`,
  );

  exactKeys(surface.fields, ["bottom", "top"], `${path}.presentedSurface.fields`);
  const top = validateField(
    surface.fields.top,
    expectedFields.top,
    `${path}.presentedSurface.fields.top`,
  );
  const bottom = validateField(
    surface.fields.bottom,
    expectedFields.bottom,
    `${path}.presentedSurface.fields.bottom`,
  );
  if (visualRgb.dark < rgb.black) {
    fail(
      "invariant",
      `${path}.presentedSurface.visualRgb.dark`,
      `at least exact-black population ${rgb.black}`,
      visualRgb.dark,
    );
  }
  if (visualRgb.light < rgb.white) {
    fail(
      "invariant",
      `${path}.presentedSurface.visualRgb.light`,
      `at least exact-white population ${rgb.white}`,
      visualRgb.light,
    );
  }
  exact(
    surface.fields.top.fieldStrideBytes,
    surface.fields.bottom.fieldStrideBytes,
    `${path}.presentedSurface.fields.bottom.fieldStrideBytes`,
  );
  exact(
    surface.fields.top.sourceRowStep,
    surface.fields.bottom.sourceRowStep,
    `${path}.presentedSurface.fields.bottom.sourceRowStep`,
  );
  for (const name of ["black", "white", "other"]) {
    exact(
      rgb[name],
      top[name] + bottom[name],
      `${path}.presentedSurface.rgb.${name}`,
    );
  }
  for (const [name, fieldName] of [
    ["dark", "dark"],
    ["light", "light"],
    ["other", "visualOther"],
  ]) {
    exact(
      visualRgb[name],
      top[fieldName] + bottom[fieldName],
      `${path}.presentedSurface.visualRgb.${name}`,
    );
  }
  return {
    ordinal,
    pairEpoch: surface.pairEpoch,
    presentationSerial: surface.presentationSerial,
    rgbaSha256: surface.rgbaSha256,
    rgbSha256: surface.rgbSha256,
    monochrome: rgb.unique === 1,
    allBlack: rgb.black === pixels,
    allWhite: rgb.white === pixels,
    nearBlack: isNearExtreme(visualRgb.dark, pixels),
    nearWhite: isNearExtreme(visualRgb.light, pixels),
    sourceBlackWhiteSplit:
      (top.black === top.pixels && bottom.white === bottom.pixels)
      || (top.white === top.pixels && bottom.black === bottom.pixels),
    sourceNearBlackWhiteSplit:
      (isNearExtreme(top.dark, top.pixels)
        && isNearExtreme(bottom.light, bottom.pixels))
      || (isNearExtreme(top.light, top.pixels)
        && isNearExtreme(bottom.dark, bottom.pixels)),
    fields: {
      top: {
        address: surface.fields.top.address,
        generation: surface.fields.top.generation,
        rgbaSha256: surface.fields.top.rgbaSha256,
        rgbSha256: surface.fields.top.rgbSha256,
        monochrome: top.unique === 1,
        allBlack: top.black === top.pixels,
        allWhite: top.white === top.pixels,
        nearBlack: isNearExtreme(top.dark, top.pixels),
        nearWhite: isNearExtreme(top.light, top.pixels),
      },
      bottom: {
        address: surface.fields.bottom.address,
        generation: surface.fields.bottom.generation,
        rgbaSha256: surface.fields.bottom.rgbaSha256,
        rgbSha256: surface.fields.bottom.rgbSha256,
        monochrome: bottom.unique === 1,
        allBlack: bottom.black === bottom.pixels,
        allWhite: bottom.white === bottom.pixels,
        nearBlack: isNearExtreme(bottom.dark, bottom.pixels),
        nearWhite: isNearExtreme(bottom.light, bottom.pixels),
      },
    },
  };
}

export function deriveSmbSustainedPresentedSurfaceHistoryOracle(frames) {
  if (!Array.isArray(frames)) {
    fail("envelope", "$.rendering.sustainedPresentedSurfaces.frames", "an array", frames);
  }
  const classified = frames.map(frame => {
    const surface = frame.presentedSurface;
    const pixels = surface.width * surface.height;
    const summarizeField = parity => {
      const field = surface.fields[parity];
      const fieldPixels = field.width * field.height;
      return {
        address: field.address,
        generation: field.generation,
        rgbaSha256: field.rgbaSha256,
        rgbSha256: field.rgbSha256,
        monochrome: field.rgb.unique === 1,
        allBlack: field.rgb.black === fieldPixels,
        allWhite: field.rgb.white === fieldPixels,
        nearBlack: isNearExtreme(field.visualRgb.dark, fieldPixels),
        nearWhite: isNearExtreme(field.visualRgb.light, fieldPixels),
      };
    };
    const top = summarizeField("top");
    const bottom = summarizeField("bottom");
    return {
      ordinal: frame.ordinal,
      pairEpoch: surface.pairEpoch,
      presentationSerial: surface.presentationSerial,
      rgbaSha256: surface.rgbaSha256,
      rgbSha256: surface.rgbSha256,
      monochrome: surface.rgb.unique === 1,
      allBlack: surface.rgb.black === pixels,
      allWhite: surface.rgb.white === pixels,
      nearBlack: isNearExtreme(surface.visualRgb.dark, pixels),
      nearWhite: isNearExtreme(surface.visualRgb.light, pixels),
      sourceBlackWhiteSplit:
        (top.allBlack && bottom.allWhite)
        || (top.allWhite && bottom.allBlack),
      sourceNearBlackWhiteSplit:
        (top.nearBlack && bottom.nearWhite)
        || (top.nearWhite && bottom.nearBlack),
      fields: { top, bottom },
    };
  });
  const monochrome = classified.filter(frame => frame.monochrome);
  const blackWhite = classified.filter(frame => frame.allBlack || frame.allWhite);
  const nearBlackWhite = classified.filter(frame => frame.nearBlack || frame.nearWhite);
  const blackWhiteTransitions = classified
    .slice(1)
    .filter((frame, index) => {
      const previous = classified[index];
      return (previous.allBlack && frame.allWhite)
        || (previous.allWhite && frame.allBlack);
    })
    .map(frame => frame.ordinal);
  const nearBlackWhiteTransitions = classified
    .slice(1)
    .filter((frame, index) => {
      const previous = classified[index];
      return (previous.nearBlack && frame.nearWhite)
        || (previous.nearWhite && frame.nearBlack);
    })
    .map(frame => frame.ordinal);
  return {
    capacity: SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY,
    captured: classified.length,
    complete: classified.length === SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY,
    extremeThresholdPpm: SMB_SUSTAINED_PRESENTED_SURFACE_EXTREME_PPM,
    darkChannelMaximum:
      SMB_SUSTAINED_PRESENTED_SURFACE_DARK_CHANNEL_MAXIMUM,
    lightChannelMinimum:
      SMB_SUSTAINED_PRESENTED_SURFACE_LIGHT_CHANNEL_MINIMUM,
    distinctPairEpochs: new Set(classified.map(frame => frame.pairEpoch)).size,
    distinctPresentationSerials:
      new Set(classified.map(frame => frame.presentationSerial)).size,
    distinctRgbaHashes:
      new Set(classified.map(frame => frame.rgbaSha256)).size,
    distinctRgbHashes:
      new Set(classified.map(frame => frame.rgbSha256)).size,
    pairEpochRegressions: classified
      .filter((frame, index) => index !== 0
        && frame.pairEpoch <= classified[index - 1].pairEpoch)
      .map(frame => frame.ordinal),
    presentationSerialRegressions: classified
      .filter((frame, index) => index !== 0
        && frame.presentationSerial <= classified[index - 1].presentationSerial)
      .map(frame => frame.ordinal),
    monochromeOrdinals: monochrome.map(frame => frame.ordinal),
    blackOrdinals: classified.filter(frame => frame.allBlack)
      .map(frame => frame.ordinal),
    whiteOrdinals: classified.filter(frame => frame.allWhite)
      .map(frame => frame.ordinal),
    nearBlackOrdinals: classified.filter(frame => frame.nearBlack)
      .map(frame => frame.ordinal),
    nearWhiteOrdinals: classified.filter(frame => frame.nearWhite)
      .map(frame => frame.ordinal),
    topFieldMonochromeOrdinals: classified
      .filter(frame => frame.fields.top.monochrome)
      .map(frame => frame.ordinal),
    bottomFieldMonochromeOrdinals: classified
      .filter(frame => frame.fields.bottom.monochrome)
      .map(frame => frame.ordinal),
    topFieldNearBlackOrdinals: classified
      .filter(frame => frame.fields.top.nearBlack)
      .map(frame => frame.ordinal),
    topFieldNearWhiteOrdinals: classified
      .filter(frame => frame.fields.top.nearWhite)
      .map(frame => frame.ordinal),
    bottomFieldNearBlackOrdinals: classified
      .filter(frame => frame.fields.bottom.nearBlack)
      .map(frame => frame.ordinal),
    bottomFieldNearWhiteOrdinals: classified
      .filter(frame => frame.fields.bottom.nearWhite)
      .map(frame => frame.ordinal),
    blackWhiteTransitionOrdinals: blackWhiteTransitions,
    blackWhiteAlternating: blackWhite.length === classified.length
      && blackWhiteTransitions.length === Math.max(0, classified.length - 1),
    nearBlackWhiteTransitionOrdinals: nearBlackWhiteTransitions,
    nearBlackWhiteAlternating: nearBlackWhite.length === classified.length
      && nearBlackWhiteTransitions.length === Math.max(0, classified.length - 1),
    sourceBlackWhiteSplitOrdinals: classified
      .filter(frame => frame.sourceBlackWhiteSplit)
      .map(frame => frame.ordinal),
    sourceNearBlackWhiteSplitOrdinals: classified
      .filter(frame => frame.sourceNearBlackWhiteSplit)
      .map(frame => frame.ordinal),
    frames: classified,
  };
}

function firstDifference(expected, actual, path) {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path, expected, actual };
    }
    if (expected.length !== actual.length) {
      return {
        path: `${path}.length`,
        expected: expected.length,
        actual: actual.length,
      };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(
        expected[index],
        actual[index],
        `${path}[${index}]`,
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  const expectedObject = expected !== null && typeof expected === "object";
  const actualObject = actual !== null && typeof actual === "object";
  if (!expectedObject || !actualObject) return { path, expected, actual };
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  const keys = firstDifference(expectedKeys, actualKeys, `${path}.[keys]`);
  if (keys !== null) return keys;
  for (const key of expectedKeys) {
    const difference = firstDifference(
      expected[key],
      actual[key],
      `${path}.${key}`,
    );
    if (difference !== null) return difference;
  }
  return null;
}

export function verifySmbSustainedPresentedSurfaceHistory(history, receipts) {
  exactKeys(
    history,
    ["capacity", "frames", "oracle", "schema"],
    "$.rendering.sustainedPresentedSurfaces",
  );
  exact(
    history.schema,
    SMB_SUSTAINED_PRESENTED_SURFACE_SCHEMA_V1,
    "$.rendering.sustainedPresentedSurfaces.schema",
  );
  exact(
    history.capacity,
    SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY,
    "$.rendering.sustainedPresentedSurfaces.capacity",
  );
  if (!Array.isArray(receipts) || receipts.length !== 120) {
    fail("binding", "$.sustainedPlay.receipts", "exactly 120 receipts", receipts);
  }
  if (
    !Array.isArray(history.frames)
    || history.frames.length !== SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY
  ) {
    fail(
      "envelope",
      "$.rendering.sustainedPresentedSurfaces.frames",
      `exactly ${SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY} frames`,
      history.frames,
    );
  }
  let previous = null;
  for (let index = 0; index < history.frames.length; index += 1) {
    const path = `$.rendering.sustainedPresentedSurfaces.frames[${index}]`;
    const frame = exactKeys(
      history.frames[index],
      ["ordinal", "presentedSurface"],
      path,
    );
    exact(frame.ordinal, index + 1, `${path}.ordinal`);
    previous = validateSurface(
      frame.presentedSurface,
      index,
      receipts,
      previous,
    );
  }
  const derived = deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
  const difference = firstDifference(
    derived,
    history.oracle,
    "$.rendering.sustainedPresentedSurfaces.oracle",
  );
  if (difference !== null) {
    fail("oracle-mismatch", difference.path, difference.expected, difference.actual);
  }
  for (const [path, values] of [
    ["pairEpochRegressions", derived.pairEpochRegressions],
    ["presentationSerialRegressions", derived.presentationSerialRegressions],
    ["monochromeOrdinals", derived.monochromeOrdinals],
    ["nearBlackOrdinals", derived.nearBlackOrdinals],
    ["nearWhiteOrdinals", derived.nearWhiteOrdinals],
    ["sourceBlackWhiteSplitOrdinals", derived.sourceBlackWhiteSplitOrdinals],
    [
      "sourceNearBlackWhiteSplitOrdinals",
      derived.sourceNearBlackWhiteSplitOrdinals,
    ],
    ["topFieldMonochromeOrdinals", derived.topFieldMonochromeOrdinals],
    ["bottomFieldMonochromeOrdinals", derived.bottomFieldMonochromeOrdinals],
    ["topFieldNearBlackOrdinals", derived.topFieldNearBlackOrdinals],
    ["topFieldNearWhiteOrdinals", derived.topFieldNearWhiteOrdinals],
    ["bottomFieldNearBlackOrdinals", derived.bottomFieldNearBlackOrdinals],
    ["bottomFieldNearWhiteOrdinals", derived.bottomFieldNearWhiteOrdinals],
    ["blackWhiteTransitionOrdinals", derived.blackWhiteTransitionOrdinals],
    [
      "nearBlackWhiteTransitionOrdinals",
      derived.nearBlackWhiteTransitionOrdinals,
    ],
  ]) {
    if (values.length !== 0) {
      fail(
        "flicker",
        `$.rendering.sustainedPresentedSurfaces.oracle.${path}`,
        [],
        values,
      );
    }
  }
  exact(
    derived.complete,
    true,
    "$.rendering.sustainedPresentedSurfaces.oracle.complete",
  );
  exact(
    derived.distinctPairEpochs,
    SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY,
    "$.rendering.sustainedPresentedSurfaces.oracle.distinctPairEpochs",
  );
  exact(
    derived.distinctPresentationSerials,
    SMB_SUSTAINED_PRESENTED_SURFACE_CAPACITY,
    "$.rendering.sustainedPresentedSurfaces.oracle.distinctPresentationSerials",
  );
  if (derived.distinctRgbHashes < 2) {
    fail(
      "flicker",
      "$.rendering.sustainedPresentedSurfaces.oracle.distinctRgbHashes",
      "at least 2",
      derived.distinctRgbHashes,
    );
  }
  return derived;
}
