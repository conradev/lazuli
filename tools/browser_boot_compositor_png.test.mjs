// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  CompositorPngValidationError,
  decodeCompositorPng,
} from "./browser_boot_compositor_png.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  assert.equal(typeBytes.length, 4);
  const value = Buffer.from(data);
  const result = Buffer.alloc(12 + value.length);
  result.writeUInt32BE(value.length, 0);
  typeBytes.copy(result, 4);
  value.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, value])), 8 + value.length);
  return result;
}

function ihdr({
  width,
  height,
  bitDepth = 8,
  colorType = 6,
  compressionMethod = 0,
  filterMethod = 0,
  interlaceMethod = 0,
}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = compressionMethod;
  data[11] = filterMethod;
  data[12] = interlaceMethod;
  return chunk("IHDR", data);
}

function paethPredictor(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function encodeScanlines(samples, width, height, bytesPerPixel, filters) {
  assert.equal(samples.length, width * height * bytesPerPixel);
  assert.equal(filters.length, height);
  const rowBytes = width * bytesPerPixel;
  const result = Buffer.alloc((rowBytes + 1) * height);
  const zeroRow = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = filters[y];
    const row = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    const previous = y === 0
      ? zeroRow
      : samples.subarray((y - 1) * rowBytes, y * rowBytes);
    const outputOffset = y * (rowBytes + 1);
    result[outputOffset] = filter;
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
      const up = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) predictor = paethPredictor(left, up, upperLeft);
      result[outputOffset + 1 + index] = (row[index] - predictor) & 0xff;
    }
  }
  return result;
}

function splitBuffer(bytes, cuts) {
  const parts = [];
  let start = 0;
  for (const end of cuts) {
    parts.push(bytes.subarray(start, end));
    start = end;
  }
  parts.push(bytes.subarray(start));
  return parts;
}

function makePng({
  width = 1,
  height = 1,
  bitDepth = 8,
  colorType = 6,
  compressionMethod = 0,
  filterMethod = 0,
  interlaceMethod = 0,
  samples,
  filters = Array.from({ length: height }, () => 0),
  scanlines,
  compressed,
  beforeIdat = [],
  afterIdat = [],
  idatCuts = [],
  includeIend = true,
}) {
  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const source = samples ?? Buffer.alloc(width * height * bytesPerPixel);
  const filtered = scanlines
    ?? encodeScanlines(source, width, height, bytesPerPixel, filters);
  const deflated = compressed ?? deflateSync(filtered);
  const idatChunks = splitBuffer(deflated, idatCuts).map(value => chunk("IDAT", value));
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr({
      width,
      height,
      bitDepth,
      colorType,
      compressionMethod,
      filterMethod,
      interlaceMethod,
    }),
    ...beforeIdat,
    ...idatChunks,
    ...afterIdat,
    ...(includeIend ? [chunk("IEND")] : []),
  ]);
}

function rgbToRgba(rgb) {
  const rgba = Buffer.alloc((rgb.length / 3) * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = 255;
  }
  return rgba;
}

function rgbBytes(rgba) {
  const rgb = Buffer.alloc((rgba.length / 4) * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }
  return rgb;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectFailure(bytes, code, options) {
  assert.throws(
    () => decodeCompositorPng(bytes, options),
    error => error instanceof CompositorPngValidationError && error.code === code,
  );
}

test("decodes every PNG filter for split 8-bit RGB IDAT streams", () => {
  const width = 3;
  const height = 5;
  const rgb = Buffer.from([
    0, 0, 0, 255, 255, 255, 10, 20, 30,
    4, 8, 12, 16, 24, 32, 64, 80, 96,
    100, 90, 80, 70, 60, 50, 40, 30, 20,
    5, 250, 100, 25, 225, 125, 45, 200, 150,
    254, 1, 128, 127, 64, 32, 11, 22, 33,
  ]);
  const base = makePng({
    width,
    height,
    colorType: 2,
    samples: rgb,
    filters: [0, 1, 2, 3, 4],
    beforeIdat: [chunk("tEXt", Buffer.from("source\0test"))],
  });
  const firstIdat = base.indexOf(Buffer.from("IDAT")) - 4;
  const idatLength = base.readUInt32BE(firstIdat);
  const compressed = base.subarray(firstIdat + 8, firstIdat + 8 + idatLength);
  const png = makePng({
    width,
    height,
    colorType: 2,
    samples: rgb,
    filters: [0, 1, 2, 3, 4],
    beforeIdat: [chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255]))],
    afterIdat: [chunk("tIME", Buffer.from([7, 234, 1, 2, 3, 4, 5]))],
    idatCuts: [1, Math.floor(compressed.length / 2)],
  });
  const wrapped = Buffer.concat([Buffer.from([1, 2, 3]), png, Buffer.from([4, 5])]);
  const view = new Uint8Array(wrapped.buffer, wrapped.byteOffset + 3, png.length);
  const decoded = decodeCompositorPng(view, { expectedWidth: width, expectedHeight: height });
  const expectedRgba = rgbToRgba(rgb);

  assert.deepEqual(decoded.rgba, expectedRgba);
  assert.deepEqual({
    width: decoded.width,
    height: decoded.height,
    sourceColorType: decoded.sourceColorType,
    format: decoded.format,
    layout: decoded.layout,
    pngByteLength: decoded.pngByteLength,
    rgbaByteLength: decoded.rgbaByteLength,
  }, {
    width,
    height,
    sourceColorType: "rgb8",
    format: "rgba8unorm",
    layout: "top-left-row-major-tight",
    pngByteLength: png.length,
    rgbaByteLength: width * height * 4,
  });
  assert.equal(decoded.pngSha256, sha256(png));
  assert.equal(decoded.rgbaSha256, sha256(expectedRgba));
  assert.equal(decoded.rgbSha256, sha256(rgb));
  assert.deepEqual(decoded.rgb, { black: 1, white: 1, other: 13, unique: 15 });
});

test("preserves RGBA alpha while RGB evidence intentionally ignores it", () => {
  const rgba = Buffer.from([
    0, 0, 0, 0,
    255, 255, 255, 1,
    12, 34, 56, 78,
    12, 34, 56, 255,
  ]);
  const png = makePng({
    width: 2,
    height: 2,
    colorType: 6,
    samples: rgba,
    filters: [4, 2],
  });
  const decoded = decodeCompositorPng(png);

  assert.equal(decoded.sourceColorType, "rgba8");
  assert.deepEqual(decoded.rgba, rgba);
  assert.equal(decoded.rgbaSha256, sha256(rgba));
  assert.equal(decoded.rgbSha256, sha256(rgbBytes(rgba)));
  assert.deepEqual(decoded.rgb, { black: 1, white: 1, other: 2, unique: 3 });
});

test("rejects corrupt CRCs and malformed chunk ordering", () => {
  const valid = makePng({ samples: Buffer.from([1, 2, 3, 4]) });
  const corruptCrc = Buffer.from(valid);
  corruptCrc[20] ^= 1;
  expectFailure(corruptCrc, "crc");

  const header = ihdr({ width: 1, height: 1 });
  const compressed = deflateSync(Buffer.from([0, 1, 2, 3, 4]));
  const duplicateHeader = Buffer.concat([
    PNG_SIGNATURE,
    header,
    header,
    chunk("IDAT", compressed),
    chunk("IEND"),
  ]);
  expectFailure(duplicateHeader, "ordering");

  const headerNotFirst = Buffer.concat([
    PNG_SIGNATURE,
    chunk("tEXt", Buffer.from("x")),
    header,
    chunk("IDAT", compressed),
    chunk("IEND"),
  ]);
  expectFailure(headerNotFirst, "ordering");

  const separatedIdat = Buffer.concat([
    PNG_SIGNATURE,
    header,
    chunk("IDAT", compressed.subarray(0, 2)),
    chunk("tEXt", Buffer.from("x")),
    chunk("IDAT", compressed.subarray(2)),
    chunk("IEND"),
  ]);
  expectFailure(separatedIdat, "ordering");
});

test("rejects unsupported formats, interlace, and critical chunks", () => {
  expectFailure(makePng({ bitDepth: 16 }), "unsupported-format");
  expectFailure(makePng({ colorType: 3 }), "unsupported-format");
  expectFailure(makePng({ compressionMethod: 1 }), "unsupported-format");
  expectFailure(makePng({ filterMethod: 1 }), "unsupported-format");
  expectFailure(makePng({ interlaceMethod: 1 }), "unsupported-interlace");
  expectFailure(
    makePng({ beforeIdat: [chunk("ABCD", Buffer.from([1]))] }),
    "unsupported-format",
  );
  expectFailure(
    makePng({ colorType: 6, beforeIdat: [chunk("PLTE", Buffer.from([0, 0, 0]))] }),
    "unsupported-format",
  );
});

test("enforces exact dimensions and every configured allocation bound", () => {
  const png = makePng({
    width: 3,
    height: 2,
    samples: Buffer.alloc(3 * 2 * 4, 7),
  });
  expectFailure(makePng({ width: 0, height: 1 }), "dimensions");
  expectFailure(png, "dimensions", { expectedWidth: 2 });
  expectFailure(png, "dimensions", { expectedHeight: 3 });
  expectFailure(png, "limit", { maxWidth: 2 });
  expectFailure(png, "limit", { maxHeight: 1 });
  expectFailure(png, "limit", { maxPixels: 5 });
  expectFailure(png, "limit", { maxDecodedBytes: 23 });
  expectFailure(png, "limit", { maxPngBytes: png.length - 1 });
  expectFailure(png, "limit", { maxChunkBytes: 12 });
  expectFailure(png, "limit", { maxCompressedBytes: 1 });
  expectFailure(png, "limit", { maxChunks: 2 });
  expectFailure(png, "options", { maxWidth: 0 });
  expectFailure(png, "options", { surprising: 1 });

  const rgbaInflationExceedsRgba = makePng({
    width: 4,
    height: 1,
    samples: Buffer.alloc(16),
  });
  expectFailure(rgbaInflationExceedsRgba, "limit", { maxDecodedBytes: 16 });
});

test("rejects truncation, missing IEND, and all bytes after IEND", () => {
  const valid = makePng({ samples: Buffer.from([1, 2, 3, 4]) });
  expectFailure(valid.subarray(0, 7), "signature");
  expectFailure(valid.subarray(0, valid.length - 5), "truncated");
  expectFailure(valid.subarray(0, valid.length - 12), "truncated");

  const declaredPastEnd = Buffer.from(valid);
  declaredPastEnd.writeUInt32BE(1000, 8);
  expectFailure(declaredPastEnd, "truncated");

  expectFailure(Buffer.concat([valid, Buffer.from([0])]), "trailing-data");
});

test("fails closed on zlib and reconstructed-row errors", () => {
  const invalidZlib = makePng({ compressed: Buffer.from([1, 2, 3, 4]) });
  expectFailure(invalidZlib, "decompression");

  const shortRows = makePng({
    width: 1,
    height: 1,
    compressed: deflateSync(Buffer.from([0, 1, 2, 3])),
  });
  expectFailure(shortRows, "scanline");

  const longRows = makePng({
    width: 1,
    height: 1,
    compressed: deflateSync(Buffer.from([0, 1, 2, 3, 4, 5])),
  });
  expectFailure(longRows, "decompression");

  const invalidFilter = makePng({
    width: 1,
    height: 1,
    scanlines: Buffer.from([5, 1, 2, 3, 4]),
  });
  expectFailure(invalidFilter, "scanline");

  const validStream = deflateSync(Buffer.from([0, 1, 2, 3, 4]));
  const trailingCompressedBytes = makePng({
    width: 1,
    height: 1,
    compressed: Buffer.concat([validStream, Buffer.from([9, 8, 7])]),
  });
  expectFailure(trailingCompressedBytes, "decompression");
});
