// SPDX-License-Identifier: GPL-3.0-only

import {
  COMPOSITOR_CAPTURE_COUNT,
  COMPOSITOR_CAPTURE_PROTOCOL,
  LEGACY_COMPOSITOR_CAPTURE_PROTOCOL,
  compositorFailure,
} from "./browser_boot_headless_compositor.mjs";

const LOWERCASE_COMMIT = /^[0-9a-f]{40}$/;
const LOWERCASE_HEX_32 = /^0x[0-9a-f]{8}$/;
const LOWERCASE_SHA_256 = /^[0-9a-f]{64}$/;

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw compositorFailure(`${path} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    throw compositorFailure(
      `${path} keys must be ${canonical.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

function exact(value, expected, path) {
  if (value !== expected) {
    throw compositorFailure(
      `${path} must be ${JSON.stringify(expected)}; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw compositorFailure(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value, path) {
  const integer = nonNegativeInteger(value, path);
  if (integer === 0) throw compositorFailure(`${path} must be positive`);
  return integer;
}

function captureProtocol(value, path) {
  if (
    value !== COMPOSITOR_CAPTURE_PROTOCOL
    && value !== LEGACY_COMPOSITOR_CAPTURE_PROTOCOL
  ) {
    throw compositorFailure(`${path} must be a supported compositor capture protocol`);
  }
  return value;
}

function validateScanout(value, path, height) {
  const fieldStrideBytes = positiveInteger(value.fieldStrideBytes, `${path}.fieldStrideBytes`);
  const sourceRowStep = positiveInteger(value.sourceRowStep, `${path}.sourceRowStep`);
  const fieldHeight = positiveInteger(value.fieldHeight, `${path}.fieldHeight`);
  const rowRepeat = positiveInteger(value.rowRepeat, `${path}.rowRepeat`);
  if (rowRepeat !== 1 && rowRepeat !== 2) {
    throw compositorFailure(`${path}.rowRepeat must be 1 or 2`);
  }
  exact(value.scanoutPolicy, rowRepeat === 2 ? "bob" : "direct", `${path}.scanoutPolicy`);
  exact(height, fieldHeight * rowRepeat, `${path}.height`);
  if (fieldStrideBytes % sourceRowStep !== 0) {
    throw compositorFailure(`${path}.fieldStrideBytes must be divisible by sourceRowStep`);
  }
}

function finite(value, path) {
  if (!Number.isFinite(value)) {
    throw compositorFailure(`${path} must be a finite number`);
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== "string" || !LOWERCASE_SHA_256.test(value)) {
    throw compositorFailure(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function commit(value, path) {
  if (typeof value !== "string" || !LOWERCASE_COMMIT.test(value)) {
    throw compositorFailure(`${path} must be a lowercase commit ID`);
  }
  return value;
}

function loaderId(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw compositorFailure(`${path} must be a non-empty bounded loader ID`);
  }
  return value;
}

function runUrl(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw compositorFailure(`${path} must be a non-empty URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw compositorFailure(`${path} must be an absolute URL`);
  }
  const captureValues = url.searchParams.getAll("compositorCapture");
  const scenarioValues = url.searchParams.getAll("scenario");
  const runValues = url.searchParams.getAll("headlessRun");
  if (
    captureValues.length !== 1
    || captureValues[0] !== "1"
    || scenarioValues.length !== 1
    || scenarioValues[0] !== "smb-ready-play"
    || runValues.length !== 1
    || runValues[0].length === 0
  ) {
    throw compositorFailure(`${path} is not an exact compositor-capture run URL`);
  }
  return value;
}

function validateRgbCounts(rgb, path, pixelCount) {
  object(rgb, path);
  exactKeys(rgb, ["black", "other", "unique", "white"], path);
  const counts = {};
  for (const field of ["black", "white", "other", "unique"]) {
    counts[field] = nonNegativeInteger(rgb[field], `${path}.${field}`);
  }
  const classified = counts.black + counts.white + counts.other;
  if (!Number.isSafeInteger(classified) || classified !== pixelCount) {
    throw compositorFailure(`${path} must classify exactly ${pixelCount} pixels`);
  }
  const maximumUnique = Math.min(pixelCount, 0x1_00_00_00);
  if (counts.unique === 0 || counts.unique > maximumUnique) {
    throw compositorFailure(`${path}.unique must be from 1 through ${maximumUnique}`);
  }
  const populatedBuckets = Number(counts.black > 0)
    + Number(counts.white > 0)
    + Number(counts.other > 0);
  if (counts.unique < populatedBuckets) {
    throw compositorFailure(
      `${path}.unique must cover all ${populatedBuckets} populated RGB buckets`,
    );
  }
  const uniformPopulation = counts.black === pixelCount
    || counts.white === pixelCount
    || counts.other === pixelCount;
  const exactBlackOrWhite = counts.black === pixelCount || counts.white === pixelCount;
  if ((counts.unique === 1 && !uniformPopulation) || (exactBlackOrWhite && counts.unique !== 1)) {
    throw compositorFailure(`${path}.unique disagrees with the exact RGB populations`);
  }
  return counts;
}

function validateViewport(viewport, path) {
  object(viewport, path);
  exactKeys(viewport, [
    "devicePixelRatio",
    "height",
    "scrollX",
    "scrollY",
    "visual",
    "width",
  ], path);
  exact(viewport.width, 1024, `${path}.width`);
  exact(viewport.height, 768, `${path}.height`);
  exact(viewport.devicePixelRatio, 1, `${path}.devicePixelRatio`);
  exact(viewport.scrollX, 0, `${path}.scrollX`);
  exact(viewport.scrollY, 0, `${path}.scrollY`);
  const visual = object(viewport.visual, `${path}.visual`);
  exactKeys(visual, [
    "height",
    "offsetLeft",
    "offsetTop",
    "pageLeft",
    "pageTop",
    "scale",
    "width",
  ], `${path}.visual`);
  exact(visual.width, 1024, `${path}.visual.width`);
  exact(visual.height, 768, `${path}.visual.height`);
  exact(visual.offsetLeft, 0, `${path}.visual.offsetLeft`);
  exact(visual.offsetTop, 0, `${path}.visual.offsetTop`);
  exact(visual.pageLeft, 0, `${path}.visual.pageLeft`);
  exact(visual.pageTop, 0, `${path}.visual.pageTop`);
  exact(visual.scale, 1, `${path}.visual.scale`);
  return viewport;
}

function validateGeometry(geometry, path, width, height) {
  object(geometry, path);
  exactKeys(geometry, ["canvas", "viewport"], path);
  const canvas = object(geometry.canvas, `${path}.canvas`);
  exactKeys(canvas, [
    "bottom",
    "bufferHeight",
    "bufferWidth",
    "height",
    "left",
    "right",
    "top",
    "width",
  ], `${path}.canvas`);
  exact(canvas.bufferWidth, width, `${path}.canvas.bufferWidth`);
  exact(canvas.bufferHeight, height, `${path}.canvas.bufferHeight`);
  const left = finite(canvas.left, `${path}.canvas.left`);
  const top = finite(canvas.top, `${path}.canvas.top`);
  const right = finite(canvas.right, `${path}.canvas.right`);
  const bottom = finite(canvas.bottom, `${path}.canvas.bottom`);
  exact(canvas.width, width, `${path}.canvas.width`);
  exact(canvas.height, height, `${path}.canvas.height`);
  exact(right - left, width, `${path}.canvas.right`);
  exact(bottom - top, height, `${path}.canvas.bottom`);
  const viewport = validateViewport(geometry.viewport, `${path}.viewport`);
  if (left < 0 || top < 0 || right > viewport.width || bottom > viewport.height) {
    throw compositorFailure(`${path}.canvas is not entirely inside the viewport`);
  }
  return geometry;
}

function validateDescriptor(descriptor, path, index, previous, protocol) {
  object(descriptor, path);
  const keys = [
    "address",
    "generation",
    "geometry",
    "height",
    "ordinal",
    "presentationSerial",
    "protocol",
    "rendererSequence",
    "row",
    "scenario",
    "step",
    "token",
    "width",
  ];
  if (protocol === COMPOSITOR_CAPTURE_PROTOCOL) {
    keys.push(
      "fieldHeight",
      "fieldStrideBytes",
      "rowRepeat",
      "scanoutPolicy",
      "sourceRowStep",
    );
  }
  exactKeys(descriptor, keys, path);
  exact(descriptor.protocol, protocol, `${path}.protocol`);
  exact(descriptor.scenario, "smb-ready-play", `${path}.scenario`);
  exact(descriptor.step, "post-play-presented", `${path}.step`);
  exact(descriptor.ordinal, index + 1, `${path}.ordinal`);
  if (
    typeof descriptor.token !== "string"
    || descriptor.token.length === 0
    || descriptor.token.length > 512
  ) {
    throw compositorFailure(`${path}.token must be a non-empty bounded string`);
  }
  if (typeof descriptor.address !== "string" || !LOWERCASE_HEX_32.test(descriptor.address)) {
    throw compositorFailure(`${path}.address must be lowercase 32-bit hexadecimal`);
  }
  positiveInteger(descriptor.rendererSequence, `${path}.rendererSequence`);
  positiveInteger(descriptor.presentationSerial, `${path}.presentationSerial`);
  positiveInteger(descriptor.generation, `${path}.generation`);
  const row = nonNegativeInteger(descriptor.row, `${path}.row`);
  if (row > 1) throw compositorFailure(`${path}.row must be 0 or 1`);
  const width = positiveInteger(descriptor.width, `${path}.width`);
  const height = positiveInteger(descriptor.height, `${path}.height`);
  if (width > 1024 || height > 1024) {
    throw compositorFailure(`${path} dimensions exceed 1024x1024`);
  }
  if (protocol === COMPOSITOR_CAPTURE_PROTOCOL) validateScanout(descriptor, path, height);
  validateGeometry(descriptor.geometry, `${path}.geometry`, width, height);
  if (previous !== null) {
    if (descriptor.rendererSequence <= previous.rendererSequence) {
      throw compositorFailure(`${path}.rendererSequence is not strictly increasing`);
    }
    if (descriptor.presentationSerial <= previous.presentationSerial) {
      throw compositorFailure(`${path}.presentationSerial is not strictly increasing`);
    }
    if (descriptor.token === previous.token) {
      throw compositorFailure(`${path}.token was already acknowledged`);
    }
  }
  return descriptor;
}

function validateClip(clip, path, geometry) {
  object(clip, path);
  exactKeys(clip, ["height", "scale", "width", "x", "y"], path);
  exact(clip.x, geometry.canvas.left, `${path}.x`);
  exact(clip.y, geometry.canvas.top, `${path}.y`);
  exact(clip.width, geometry.canvas.width, `${path}.width`);
  exact(clip.height, geometry.canvas.height, `${path}.height`);
  exact(clip.scale, 1, `${path}.scale`);
}

function validatePng(png, path, width, height) {
  object(png, path);
  exactKeys(png, [
    "format",
    "height",
    "layout",
    "pngByteLength",
    "pngSha256",
    "rgb",
    "rgbSha256",
    "rgbaByteLength",
    "rgbaSha256",
    "sourceColorType",
    "width",
  ], path);
  exact(png.width, width, `${path}.width`);
  exact(png.height, height, `${path}.height`);
  if (png.sourceColorType !== "rgb8" && png.sourceColorType !== "rgba8") {
    throw compositorFailure(`${path}.sourceColorType must be rgb8 or rgba8`);
  }
  exact(png.format, "rgba8unorm", `${path}.format`);
  exact(png.layout, "top-left-row-major-tight", `${path}.layout`);
  positiveInteger(png.pngByteLength, `${path}.pngByteLength`);
  sha256(png.pngSha256, `${path}.pngSha256`);
  const pixelCount = width * height;
  exact(png.rgbaByteLength, pixelCount * 4, `${path}.rgbaByteLength`);
  sha256(png.rgbaSha256, `${path}.rgbaSha256`);
  sha256(png.rgbSha256, `${path}.rgbSha256`);
  validateRgbCounts(png.rgb, `${path}.rgb`, pixelCount);
  return png;
}

export function deriveCompositorCaptureOracle(frames, temporalFrames) {
  const classified = frames.map((frame, index) => {
    const pixels = frame.png.width * frame.png.height;
    const surface = temporalFrames[index]?.presentedSurface ?? null;
    return {
      ordinal: frame.descriptor.ordinal,
      rgbaSha256: frame.png.rgbaSha256,
      rgbSha256: frame.png.rgbSha256,
      matchesSurfaceRgb: frame.png.rgbSha256 === surface?.rgbSha256,
      monochrome: frame.png.rgb.unique === 1,
      allBlack: frame.png.rgb.black === pixels,
      allWhite: frame.png.rgb.white === pixels,
    };
  });
  const adjacentExactBlackWhiteTransitions = [];
  for (let index = 1; index < classified.length; index += 1) {
    const previous = classified[index - 1];
    const current = classified[index];
    const previousKind = previous.allBlack ? "black" : previous.allWhite ? "white" : null;
    const currentKind = current.allBlack ? "black" : current.allWhite ? "white" : null;
    if (previousKind !== null && currentKind !== null && previousKind !== currentKind) {
      adjacentExactBlackWhiteTransitions.push([previous.ordinal, current.ordinal]);
    }
  }
  return {
    adjacentExactBlackWhiteTransitions,
    captured: classified.length,
    distinctRgbHashes: new Set(classified.map(frame => frame.rgbSha256)).size,
    distinctRgbaHashes: new Set(classified.map(frame => frame.rgbaSha256)).size,
    singleFrameMonochromeOrdinals: classified
      .filter(frame => frame.monochrome)
      .map(frame => frame.ordinal),
    surfaceRgbMismatchOrdinals: classified
      .filter(frame => !frame.matchesSurfaceRgb)
      .map(frame => frame.ordinal),
  };
}

export function verifyCompositorCaptureReport(report, options) {
  if (!options.compositorCapture) return null;
  const compositor = object(
    report.headlessCapture?.compositor,
    "$.headlessCapture.compositor",
  );
  exactKeys(compositor, [
    "captureBeyondViewport",
    "captureComplete",
    "expectedFrames",
    "format",
    "frames",
    "fromSurface",
    "loaderId",
    "oracle",
    "oraclePassed",
    "protocol",
    "schemaValid",
    "target",
    "url",
    "viewport",
  ], "$.headlessCapture.compositor");
  exact(
    compositor.captureBeyondViewport,
    false,
    "$.headlessCapture.compositor.captureBeyondViewport",
  );
  exact(compositor.captureComplete, false, "$.headlessCapture.compositor.captureComplete");
  exact(
    compositor.expectedFrames,
    COMPOSITOR_CAPTURE_COUNT,
    "$.headlessCapture.compositor.expectedFrames",
  );
  exact(compositor.format, "png", "$.headlessCapture.compositor.format");
  exact(compositor.fromSurface, true, "$.headlessCapture.compositor.fromSurface");
  exact(compositor.oracle, null, "$.headlessCapture.compositor.oracle");
  exact(compositor.oraclePassed, false, "$.headlessCapture.compositor.oraclePassed");
  const protocol = captureProtocol(
    compositor.protocol,
    "$.headlessCapture.compositor.protocol",
  );
  exact(compositor.schemaValid, false, "$.headlessCapture.compositor.schemaValid");
  exact(compositor.target, "#display", "$.headlessCapture.compositor.target");
  const expectedLoaderId = loaderId(
    compositor.loaderId,
    "$.headlessCapture.compositor.loaderId",
  );
  const expectedRunUrl = runUrl(
    compositor.url,
    "$.headlessCapture.compositor.url",
  );
  exact(
    expectedRunUrl,
    report.headlessCapture?.url,
    "$.headlessCapture.compositor.url",
  );
  const release = object(report.headlessCapture?.release, "$.headlessCapture.release");
  sha256(release.releaseId, "$.headlessCapture.release.releaseId");
  commit(release.commit, "$.headlessCapture.release.commit");
  const frames = compositor.frames;
  if (!Array.isArray(frames) || frames.length !== COMPOSITOR_CAPTURE_COUNT) {
    throw compositorFailure(
      `expected ${COMPOSITOR_CAPTURE_COUNT} screenshots, got ${frames?.length ?? "invalid"}`,
    );
  }
  const temporal = report.rendering?.temporalSelectedXfb?.frames;
  if (!Array.isArray(temporal) || temporal.length !== COMPOSITOR_CAPTURE_COUNT) {
    throw compositorFailure("terminal temporal XFB evidence does not contain 8 frames");
  }
  if (protocol === COMPOSITOR_CAPTURE_PROTOCOL) {
    exact(
      report.rendering?.temporalSelectedXfb?.scanoutEvidenceVersion,
      2,
      "$.rendering.temporalSelectedXfb.scanoutEvidenceVersion",
    );
  } else {
    const version = report.rendering?.temporalSelectedXfb?.scanoutEvidenceVersion;
    if (version !== undefined && version !== 1) {
      throw compositorFailure(
        "$.rendering.temporalSelectedXfb.scanoutEvidenceVersion must be absent or 1 for v1",
      );
    }
  }
  const validatedFrames = [];
  let baselineGeometry = null;
  const seenTokens = new Set();
  for (let index = 0; index < frames.length; index += 1) {
    const path = `$.headlessCapture.compositor.frames[${index}]`;
    const evidence = object(frames[index], path);
    exactKeys(evidence, [
      "clip",
      "descriptor",
      "loaderId",
      "png",
      "releaseCommit",
      "releaseId",
      "url",
    ], path);
    const descriptor = validateDescriptor(
      evidence.descriptor,
      `${path}.descriptor`,
      index,
      validatedFrames.at(-1)?.descriptor ?? null,
      protocol,
    );
    if (seenTokens.has(descriptor.token)) {
      throw compositorFailure(`${path}.descriptor.token was already acknowledged`);
    }
    seenTokens.add(descriptor.token);
    if (baselineGeometry === null) baselineGeometry = descriptor.geometry;
    else exact(
      JSON.stringify(descriptor.geometry),
      JSON.stringify(baselineGeometry),
      `${path}.descriptor.geometry`,
    );
    exact(
      JSON.stringify(descriptor.geometry.viewport),
      JSON.stringify(compositor.viewport),
      `${path}.descriptor.geometry.viewport`,
    );
    validateClip(evidence.clip, `${path}.clip`, descriptor.geometry);
    loaderId(evidence.loaderId, `${path}.loaderId`);
    exact(evidence.loaderId, expectedLoaderId, `${path}.loaderId`);
    runUrl(evidence.url, `${path}.url`);
    exact(evidence.url, expectedRunUrl, `${path}.url`);
    sha256(evidence.releaseId, `${path}.releaseId`);
    exact(evidence.releaseId, release.releaseId, `${path}.releaseId`);
    commit(evidence.releaseCommit, `${path}.releaseCommit`);
    exact(evidence.releaseCommit, release.commit, `${path}.releaseCommit`);
    validatePng(evidence.png, `${path}.png`, descriptor.width, descriptor.height);
    const terminal = object(temporal[index], `${path}.temporal`);
    const surface = object(terminal.presentedSurface, `${path}.presentedSurface`);
    exact(descriptor.ordinal, terminal.ordinal, `${path}.descriptor.ordinal`);
    exact(
      descriptor.rendererSequence,
      terminal.rendererSequence,
      `${path}.descriptor.rendererSequence`,
    );
    for (const field of ["address", "generation", "row", "width", "height"]) {
      exact(descriptor[field], surface[field], `${path}.descriptor.${field}`);
    }
    if (protocol === COMPOSITOR_CAPTURE_PROTOCOL) {
      for (const field of [
        "fieldHeight",
        "fieldStrideBytes",
        "rowRepeat",
        "scanoutPolicy",
        "sourceRowStep",
      ]) {
        exact(descriptor[field], surface[field], `${path}.descriptor.${field}`);
      }
    }
    exact(
      descriptor.presentationSerial,
      surface.presentationSerial,
      `${path}.descriptor.presentationSerial`,
    );
    sha256(surface.rgbSha256, `${path}.presentedSurface.rgbSha256`);
    validatedFrames.push(evidence);
  }

  const oracle = deriveCompositorCaptureOracle(validatedFrames, temporal);
  compositor.captureComplete = true;
  compositor.schemaValid = true;
  compositor.oracle = oracle;
  if (oracle.surfaceRgbMismatchOrdinals.length !== 0) {
    throw compositorFailure(
      `screenshot RGB does not match the presented surface at ordinal ${oracle.surfaceRgbMismatchOrdinals[0]}`,
    );
  }
  if (oracle.distinctRgbHashes !== COMPOSITOR_CAPTURE_COUNT) {
    throw compositorFailure(
      `expected ${COMPOSITOR_CAPTURE_COUNT} distinct RGB screenshots, got ${oracle.distinctRgbHashes}`,
    );
  }
  if (oracle.distinctRgbaHashes !== COMPOSITOR_CAPTURE_COUNT) {
    throw compositorFailure(
      `expected ${COMPOSITOR_CAPTURE_COUNT} distinct RGBA screenshots, got ${oracle.distinctRgbaHashes}`,
    );
  }
  if (oracle.adjacentExactBlackWhiteTransitions.length !== 0) {
    throw compositorFailure(
      `exact black/white transition at ordinals ${JSON.stringify(oracle.adjacentExactBlackWhiteTransitions[0])}`,
    );
  }
  if (oracle.singleFrameMonochromeOrdinals.length !== 0) {
    throw compositorFailure(
      `monochrome screenshot at ordinal ${oracle.singleFrameMonochromeOrdinals[0]}`,
    );
  }
  compositor.oraclePassed = true;
  return oracle;
}
