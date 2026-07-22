// SPDX-License-Identifier: GPL-3.0-only

import { SMB_TEMPORAL_XFB_CAPACITY } from "./browser_boot_temporal_xfb.mjs";

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

function validateFrame(frame, index, previous) {
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

  const surface = requireObject(frame.presentedSurface, `${path}.presentedSurface`);
  requireExactKeys(surface, [
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
  ], `${path}.presentedSurface`);
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
