// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RGB_SEEN_BYTES = 1 << 21;

export const DEFAULT_COMPOSITOR_PNG_LIMITS = Object.freeze({
  maxPngBytes: 64 * 1024 * 1024,
  maxChunkBytes: 32 * 1024 * 1024,
  maxCompressedBytes: 48 * 1024 * 1024,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 16 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
  maxChunks: 16384,
});

const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_COMPOSITOR_PNG_LIMITS));
const OPTION_KEYS = new Set([...LIMIT_KEYS, "expectedWidth", "expectedHeight"]);

export class CompositorPngValidationError extends Error {
  constructor(code, detail) {
    super(`compositor PNG ${code}: ${detail}`);
    this.name = "CompositorPngValidationError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new CompositorPngValidationError(code, detail);
}

function describe(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("options", `${name} must be a positive safe integer, got ${describe(value)}`);
  }
  return value;
}

function parseOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("options", `expected an options object, got ${describe(options)}`);
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail("options", `unknown option ${describe(key)}`);
  }

  const parsed = {};
  for (const key of LIMIT_KEYS) {
    parsed[key] = requirePositiveSafeInteger(
      options[key] ?? DEFAULT_COMPOSITOR_PNG_LIMITS[key],
      key,
    );
  }
  for (const key of ["expectedWidth", "expectedHeight"]) {
    parsed[key] = options[key] === undefined
      ? undefined
      : requirePositiveSafeInteger(options[key], key);
  }
  return parsed;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  fail("input", `expected PNG bytes as a Buffer or Uint8Array, got ${describe(value)}`);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0
        ? value >>> 1
        : (value >>> 1) ^ 0xedb88320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isAsciiLetter(byte) {
  return (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
}

function chunkName(bytes, offset) {
  for (let index = 0; index < 4; index += 1) {
    if (!isAsciiLetter(bytes[offset + index])) {
      fail("chunk-type", `chunk type at byte ${offset} is not four ASCII letters`);
    }
  }
  if ((bytes[offset + 2] & 0x20) !== 0) {
    fail(
      "chunk-type",
      `chunk type ${bytes.toString("ascii", offset, offset + 4)} has a lowercase reserved bit`,
    );
  }
  return bytes.toString("ascii", offset, offset + 4);
}

function validateDimensions(width, height, bytesPerPixel, limits) {
  if (width === 0 || height === 0) {
    fail("dimensions", `PNG dimensions must be positive, got ${width}x${height}`);
  }
  if (width > limits.maxWidth || height > limits.maxHeight) {
    fail(
      "limit",
      `PNG dimensions ${width}x${height} exceed ${limits.maxWidth}x${limits.maxHeight}`,
    );
  }
  if (limits.expectedWidth !== undefined && width !== limits.expectedWidth) {
    fail("dimensions", `expected width ${limits.expectedWidth}, got ${width}`);
  }
  if (limits.expectedHeight !== undefined && height !== limits.expectedHeight) {
    fail("dimensions", `expected height ${limits.expectedHeight}, got ${height}`);
  }
  if (width > Math.floor(limits.maxPixels / height)) {
    fail("limit", `PNG pixel count ${width}x${height} exceeds ${limits.maxPixels}`);
  }

  const pixels = width * height;
  if (pixels > Math.floor(limits.maxDecodedBytes / 4)) {
    fail(
      "limit",
      `canonical RGBA length ${pixels * 4} exceeds ${limits.maxDecodedBytes}`,
    );
  }
  const rowBytes = width * bytesPerPixel;
  if (
    rowBytes >= limits.maxDecodedBytes
    || height > Math.floor(limits.maxDecodedBytes / (rowBytes + 1))
  ) {
    fail(
      "limit",
      `inflated scanlines for ${width}x${height} exceed ${limits.maxDecodedBytes}`,
    );
  }

  return {
    pixels,
    rowBytes,
    rgbaByteLength: pixels * 4,
    inflatedByteLength: (rowBytes + 1) * height,
  };
}

function parseIhdr(data, limits) {
  if (data.length !== 13) fail("format", `IHDR length must be 13, got ${data.length}`);
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const compressionMethod = data[10];
  const filterMethod = data[11];
  const interlaceMethod = data[12];

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    fail(
      "unsupported-format",
      `only 8-bit RGB and RGBA are supported, got bit depth ${bitDepth}, color type ${colorType}`,
    );
  }
  if (compressionMethod !== 0) {
    fail("unsupported-format", `unsupported compression method ${compressionMethod}`);
  }
  if (filterMethod !== 0) {
    fail("unsupported-format", `unsupported filter method ${filterMethod}`);
  }
  if (interlaceMethod !== 0) {
    fail("unsupported-interlace", `unsupported interlace method ${interlaceMethod}`);
  }

  const bytesPerPixel = colorType === 2 ? 3 : 4;
  return {
    width,
    height,
    bitDepth,
    colorType,
    bytesPerPixel,
    ...validateDimensions(width, height, bytesPerPixel, limits),
  };
}

function parseChunks(png, limits) {
  if (png.length > limits.maxPngBytes) {
    fail("limit", `PNG length ${png.length} exceeds ${limits.maxPngBytes}`);
  }
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail("signature", "invalid or truncated PNG signature");
  }

  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let ihdr = null;
  let seenIdat = false;
  let idatEnded = false;
  let seenIend = false;
  let seenPlte = false;
  let compressedByteLength = 0;
  const idat = [];

  while (offset < png.length) {
    chunkCount += 1;
    if (chunkCount > limits.maxChunks) {
      fail("limit", `PNG has more than ${limits.maxChunks} chunks`);
    }
    if (png.length - offset < 12) {
      fail("truncated", `incomplete chunk header or CRC at byte ${offset}`);
    }

    const length = png.readUInt32BE(offset);
    if (length > limits.maxChunkBytes) {
      fail("limit", `chunk at byte ${offset} has length ${length}, above ${limits.maxChunkBytes}`);
    }
    const typeOffset = offset + 4;
    const type = chunkName(png, typeOffset);
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > png.length) {
      fail("truncated", `${type} chunk at byte ${offset} extends beyond the PNG`);
    }

    const expectedCrc = png.readUInt32BE(dataEnd);
    const actualCrc = crc32(png, typeOffset, dataEnd);
    if (actualCrc !== expectedCrc) {
      fail(
        "crc",
        `${type} chunk at byte ${offset} has CRC 0x${expectedCrc.toString(16).padStart(8, "0")}, expected 0x${actualCrc.toString(16).padStart(8, "0")}`,
      );
    }

    const data = png.subarray(dataOffset, dataEnd);
    if (type === "IHDR") {
      if (ihdr !== null) fail("ordering", "PNG contains more than one IHDR chunk");
      if (chunkCount !== 1) fail("ordering", "IHDR must be the first PNG chunk");
      ihdr = parseIhdr(data, limits);
    } else {
      if (ihdr === null) fail("ordering", `${type} appears before IHDR`);
      if (type === "IDAT") {
        if (idatEnded) fail("ordering", "IDAT chunks must be consecutive");
        if (compressedByteLength > limits.maxCompressedBytes - length) {
          fail("limit", `combined IDAT length exceeds ${limits.maxCompressedBytes}`);
        }
        seenIdat = true;
        compressedByteLength += length;
        idat.push(data);
      } else {
        if (seenIdat) idatEnded = true;
        if (type === "IEND") {
          if (length !== 0) fail("format", `IEND length must be zero, got ${length}`);
          if (!seenIdat || compressedByteLength === 0) {
            fail("ordering", "IEND appears before a non-empty IDAT stream");
          }
          seenIend = true;
        } else if (type === "PLTE") {
          if (seenPlte) fail("ordering", "PNG contains more than one PLTE chunk");
          if (seenIdat) fail("ordering", "PLTE must appear before IDAT");
          if (ihdr.colorType !== 2) {
            fail("unsupported-format", "PLTE is not permitted for RGBA PNGs");
          }
          if (length === 0 || length % 3 !== 0 || length > 768) {
            fail("format", `invalid PLTE length ${length}`);
          }
          seenPlte = true;
        } else if ((png[typeOffset] & 0x20) === 0) {
          fail("unsupported-format", `unsupported critical chunk ${type}`);
        }
      }
    }

    offset = chunkEnd;
    if (seenIend) {
      if (offset !== png.length) fail("trailing-data", `${png.length - offset} bytes follow IEND`);
      break;
    }
  }

  if (ihdr === null) fail("ordering", "PNG is missing IHDR");
  if (!seenIdat || compressedByteLength === 0) fail("ordering", "PNG is missing IDAT data");
  if (!seenIend) fail("truncated", "PNG is missing IEND");
  return { ihdr, compressed: Buffer.concat(idat, compressedByteLength) };
}

function inflateScanlines(compressed, expectedByteLength) {
  let result;
  try {
    result = inflateSync(compressed, {
      info: true,
      maxOutputLength: expectedByteLength,
    });
  } catch (error) {
    fail("decompression", error instanceof Error ? error.message : String(error));
  }
  if (
    !result
    || !Buffer.isBuffer(result.buffer)
    || !result.engine
    || !Number.isSafeInteger(result.engine.bytesWritten)
  ) {
    fail("decompression", "zlib did not report a bounded complete stream");
  }
  if (result.engine.bytesWritten !== compressed.length) {
    fail(
      "decompression",
      `zlib stream consumed ${result.engine.bytesWritten} of ${compressed.length} IDAT bytes`,
    );
  }
  if (result.buffer.length !== expectedByteLength) {
    fail(
      "scanline",
      `inflated stream has ${result.buffer.length} bytes, expected ${expectedByteLength}`,
    );
  }
  return result.buffer;
}

function paethPredictor(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function reconstructRgba(inflated, ihdr) {
  const {
    width,
    height,
    colorType,
    bytesPerPixel,
    rowBytes,
    rgbaByteLength,
  } = ihdr;
  const rgba = Buffer.allocUnsafe(rgbaByteLength);
  let previous = Buffer.alloc(rowBytes);
  let current = Buffer.allocUnsafe(rowBytes);
  let sourceOffset = 0;
  let rgbaOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    if (filter > 4) fail("scanline", `row ${y} uses unsupported filter ${filter}`);

    for (let index = 0; index < rowBytes; index += 1) {
      const encoded = inflated[sourceOffset + index];
      const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) predictor = paethPredictor(left, up, upperLeft);
      current[index] = (encoded + predictor) & 0xff;
    }
    sourceOffset += rowBytes;

    if (colorType === 6) {
      current.copy(rgba, rgbaOffset);
      rgbaOffset += rowBytes;
    } else {
      for (let index = 0; index < rowBytes; index += 3) {
        rgba[rgbaOffset] = current[index];
        rgba[rgbaOffset + 1] = current[index + 1];
        rgba[rgbaOffset + 2] = current[index + 2];
        rgba[rgbaOffset + 3] = 0xff;
        rgbaOffset += 4;
      }
    }

    const swap = previous;
    previous = current;
    current = swap;
  }
  return rgba;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function summarizeRgba(rgba, width, height) {
  const rgbHash = createHash("sha256");
  const rgbRow = Buffer.allocUnsafe(width * 3);
  const seen = Buffer.alloc(RGB_SEEN_BYTES);
  let black = 0;
  let white = 0;
  let other = 0;
  let unique = 0;

  for (let y = 0; y < height; y += 1) {
    const rgbaRowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const rgbaOffset = rgbaRowOffset + x * 4;
      const rgbOffset = x * 3;
      const red = rgba[rgbaOffset];
      const green = rgba[rgbaOffset + 1];
      const blue = rgba[rgbaOffset + 2];
      rgbRow[rgbOffset] = red;
      rgbRow[rgbOffset + 1] = green;
      rgbRow[rgbOffset + 2] = blue;

      if (red === 0 && green === 0 && blue === 0) black += 1;
      else if (red === 255 && green === 255 && blue === 255) white += 1;
      else other += 1;

      const color = (red << 16) | (green << 8) | blue;
      const byteIndex = color >>> 3;
      const bit = 1 << (color & 7);
      if ((seen[byteIndex] & bit) === 0) {
        seen[byteIndex] |= bit;
        unique += 1;
      }
    }
    rgbHash.update(rgbRow);
  }

  return {
    rgbaSha256: sha256(rgba),
    rgbSha256: rgbHash.digest("hex"),
    rgb: { black, white, other, unique },
  };
}

export function decodeCompositorPng(pngBytes, options = {}) {
  const limits = parseOptions(options);
  const png = asBuffer(pngBytes);
  const { ihdr, compressed } = parseChunks(png, limits);
  const inflated = inflateScanlines(compressed, ihdr.inflatedByteLength);
  const rgba = reconstructRgba(inflated, ihdr);
  const summary = summarizeRgba(rgba, ihdr.width, ihdr.height);

  return {
    width: ihdr.width,
    height: ihdr.height,
    sourceColorType: ihdr.colorType === 2 ? "rgb8" : "rgba8",
    format: "rgba8unorm",
    layout: "top-left-row-major-tight",
    pngByteLength: png.length,
    pngSha256: sha256(png),
    rgbaByteLength: rgba.length,
    ...summary,
    rgba,
  };
}
