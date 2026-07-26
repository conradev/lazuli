#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const MAGIC = Buffer.from("GXW1", "ascii");
export const VERSION = 1;
export const ENDIAN_TAG = 0x01020304;
export const HEADER_BYTES = 64;
export const ENTRY_BYTES = 1184;
export const WIDTH = 16;
export const HEIGHT = 16;
export const PIXELS = WIDTH * HEIGHT;
export const CASE_COUNT = 10;
export const MODE_COUNT = 8;
export const RESULT_COUNT = CASE_COUNT * MODE_COUNT;
export const MAILBOX_BYTES = HEADER_BYTES + ENTRY_BYTES * RESULT_COUNT;

const manifest = JSON.parse(
  fs.readFileSync(
    new URL("../oracle-manifest.json", import.meta.url),
    "utf8",
  ),
);
if (
  manifest.schema !== "lazuli.gx-w-clipdisable-oracle/v1" ||
  !Array.isArray(manifest.cases) ||
  manifest.cases.length !== CASE_COUNT
) {
  throw new Error("oracle manifest does not match parser ABI");
}
export const EXPECTED_CASES = Object.freeze(
  manifest.cases.map((entry, caseId) => {
    if (
      entry.id !== caseId ||
      typeof entry.name !== "string" ||
      !Array.isArray(entry.clipBits) ||
      entry.clipBits.length !== 3 ||
      entry.clipBits.some(
        (vertex) =>
          !Array.isArray(vertex) ||
          vertex.length !== 4 ||
          vertex.some((component) => !/^0x[0-9a-f]{8}$/.test(component)),
      )
    ) {
      throw new Error(`invalid oracle manifest case ${caseId}`);
    }
    return Object.freeze({
      id: entry.id,
      name: entry.name,
      clipBits: Object.freeze(
        entry.clipBits.map((vertex) => Object.freeze([...vertex])),
      ),
    });
  }),
);

const ENTRY = Object.freeze({
  caseId: 0,
  clipDisable: 4,
  clipBits: 8,
  rgbaFnvHi: 56,
  rgbaFnvLo: 60,
  coveredPixels: 64,
  unexpectedPixels: 68,
  rowMasks: 72,
  rgba: 136,
});

export const CASE_NAMES = Object.freeze(
  EXPECTED_CASES.map((entry) => entry.name),
);

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function hex64(value) {
  return value.toString(16).padStart(16, "0");
}

export function fnv1a64(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function u64(view, hiOffset, loOffset) {
  return (BigInt(view.getUint32(hiOffset)) << 32n) |
    BigInt(view.getUint32(loOffset));
}

function findMailboxOffset(bytes) {
  let offset = bytes.indexOf(MAGIC);
  while (offset !== -1) {
    if (offset + HEADER_BYTES <= bytes.length) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        HEADER_BYTES,
      );
      if (
        view.getUint32(4) === VERSION &&
        view.getUint32(8) === ENDIAN_TAG &&
        view.getUint32(12) === HEADER_BYTES &&
        view.getUint32(16) === ENTRY_BYTES &&
        view.getUint32(44) === MAILBOX_BYTES
      ) {
        return offset;
      }
    }
    offset = bytes.indexOf(MAGIC, offset + 1);
  }
  throw new Error("GXW1 mailbox not found");
}

function exactRed(rgba) {
  return rgba === 0xff0000ff;
}

function exactBlack(rgba) {
  return rgba === 0x000000ff;
}

function covered(rgba) {
  const red = rgba >>> 24;
  const green = (rgba >>> 16) & 0xff;
  const blue = (rgba >>> 8) & 0xff;
  return red > 127 && green < 64 && blue < 64;
}

export function parseMailbox(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const mailboxOffset = options.offset ?? findMailboxOffset(bytes);
  if (!Number.isSafeInteger(mailboxOffset) || mailboxOffset < 0) {
    throw new TypeError("mailbox offset must be a non-negative safe integer");
  }
  if (mailboxOffset + HEADER_BYTES > bytes.length) {
    throw new Error("truncated GXW1 header");
  }

  const headerView = new DataView(
    bytes.buffer,
    bytes.byteOffset + mailboxOffset,
    HEADER_BYTES,
  );
  const header = {
    magic: bytes
      .subarray(mailboxOffset, mailboxOffset + 4)
      .toString("ascii"),
    version: headerView.getUint32(4),
    endianTag: hex32(headerView.getUint32(8)),
    headerBytes: headerView.getUint32(12),
    entryBytes: headerView.getUint32(16),
    width: headerView.getUint32(20),
    height: headerView.getUint32(24),
    caseCount: headerView.getUint32(28),
    modeCount: headerView.getUint32(32),
    resultCount: headerView.getUint32(36),
    status: headerView.getUint32(40),
    mailboxBytes: headerView.getUint32(44),
    entriesFnv1a64: u64(headerView, 48, 52),
  };

  const expectedHeader = {
    magic: "GXW1",
    version: VERSION,
    endianTag: hex32(ENDIAN_TAG),
    headerBytes: HEADER_BYTES,
    entryBytes: ENTRY_BYTES,
    width: WIDTH,
    height: HEIGHT,
    caseCount: CASE_COUNT,
    modeCount: MODE_COUNT,
    mailboxBytes: MAILBOX_BYTES,
  };
  for (const [field, expected] of Object.entries(expectedHeader)) {
    if (header[field] !== expected) {
      throw new Error(
        `invalid GXW1 ${field}: expected ${expected}, got ${header[field]}`,
      );
    }
  }
  if (mailboxOffset + header.mailboxBytes > bytes.length) {
    throw new Error("truncated GXW1 mailbox");
  }
  if (header.resultCount > RESULT_COUNT) {
    throw new Error(`invalid GXW1 result count ${header.resultCount}`);
  }

  const entries = [];
  for (let index = 0; index < header.resultCount; index += 1) {
    const offset = mailboxOffset + HEADER_BYTES + index * ENTRY_BYTES;
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      ENTRY_BYTES,
    );
    const caseId = view.getUint32(ENTRY.caseId);
    const clipDisable = view.getUint32(ENTRY.clipDisable);
    if (caseId >= CASE_COUNT) {
      throw new Error(`entry ${index} has invalid case id ${caseId}`);
    }
    if (clipDisable >= MODE_COUNT) {
      throw new Error(
        `entry ${index} has invalid ClipDisable ${clipDisable}`,
      );
    }
    const expectedCaseId = Math.floor(index / MODE_COUNT);
    const expectedClipDisable = index % MODE_COUNT;
    if (
      caseId !== expectedCaseId ||
      clipDisable !== expectedClipDisable
    ) {
      throw new Error(
        `entry ${index} order mismatch: expected case ${expectedCaseId}, ` +
          `ClipDisable ${expectedClipDisable}; got case ${caseId}, ` +
          `ClipDisable ${clipDisable}`,
      );
    }

    const clipBits = Array.from({ length: 3 }, (_, vertex) =>
      Array.from({ length: 4 }, (_, component) =>
        hex32(
          view.getUint32(
            ENTRY.clipBits + (vertex * 4 + component) * 4,
          ),
        )
      )
    );
    const expectedClipBits = EXPECTED_CASES[caseId].clipBits;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let component = 0; component < 4; component += 1) {
        if (
          clipBits[vertex][component] !==
          expectedClipBits[vertex][component]
        ) {
          throw new Error(
            `entry ${index} clip input mismatch at vertex ${vertex}, ` +
              `component ${component}: expected ` +
              `${expectedClipBits[vertex][component]}, got ` +
              `${clipBits[vertex][component]}`,
          );
        }
      }
    }
    const rowMasks = Array.from({ length: HEIGHT }, (_, y) =>
      view.getUint32(ENTRY.rowMasks + y * 4)
    );
    const rgba = Array.from({ length: PIXELS }, (_, pixel) =>
      view.getUint32(ENTRY.rgba + pixel * 4)
    );
    const rgbaBytes = bytes.subarray(
      offset + ENTRY.rgba,
      offset + ENTRY.rgba + PIXELS * 4,
    );
    const storedHash = u64(view, ENTRY.rgbaFnvHi, ENTRY.rgbaFnvLo);
    const actualHash = fnv1a64(rgbaBytes);

    const actualRows = new Array(HEIGHT).fill(0);
    let actualCovered = 0;
    let actualUnexpected = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const value = rgba[y * WIDTH + x];
        if (covered(value)) {
          actualRows[y] |= 1 << x;
          actualCovered += 1;
        }
        if (!exactBlack(value) && !exactRed(value)) {
          actualUnexpected += 1;
        }
      }
    }

    const coveredPixels = view.getUint32(ENTRY.coveredPixels);
    const unexpectedPixels = view.getUint32(ENTRY.unexpectedPixels);
    const verification = {
      rgbaHash: storedHash === actualHash,
      coveredPixels: coveredPixels === actualCovered,
      unexpectedPixels: unexpectedPixels === actualUnexpected,
      rowMasks: rowMasks.every((mask, y) => mask === actualRows[y]),
    };

    entries.push({
      index,
      caseId,
      case: CASE_NAMES[caseId],
      clipDisable,
      clipDisableBits: clipDisable.toString(2).padStart(3, "0"),
      clipBits,
      rgbaFnv1a64: hex64(storedHash),
      coveredPixels,
      unexpectedPixels,
      rowMasks: rowMasks.map((mask) =>
        mask.toString(16).padStart(4, "0")
      ),
      ...(options.pixels
        ? { rgba: rgba.map((value) => hex32(value)) }
        : {}),
      verification,
      verified: Object.values(verification).every(Boolean),
    });
  }

  const entriesStart = mailboxOffset + HEADER_BYTES;
  const entriesEnd = entriesStart + RESULT_COUNT * ENTRY_BYTES;
  const actualEntriesHash = fnv1a64(
    bytes.subarray(entriesStart, entriesEnd),
  );
  const complete = header.status === 2 &&
    header.resultCount === RESULT_COUNT;
  const aggregateHashVerified = complete &&
    header.entriesFnv1a64 === actualEntriesHash;
  const verified = entries.every((entry) => entry.verified) &&
    (!complete || aggregateHashVerified);

  return {
    schema: "lazuli.gx-w-clipdisable-oracle/v1",
    mailboxOffset,
    complete,
    verified,
    aggregateHashVerified,
    header: {
      ...header,
      entriesFnv1a64: hex64(header.entriesFnv1a64),
      actualEntriesFnv1a64: hex64(actualEntriesHash),
    },
    entries,
  };
}

function usage() {
  return [
    "usage: node tools/parse-mailbox.mjs [--pixels] [--strict] <capture.bin>",
    "",
    "The input may be the exact 94,784-byte mailbox or a larger MEM1 dump;",
    "the parser searches for and validates the GXW1 header automatically.",
  ].join("\n");
}

function main(argv) {
  const pixels = argv.includes("--pixels");
  const strict = argv.includes("--strict");
  const paths = argv.filter((argument) => !argument.startsWith("--"));
  if (paths.length !== 1) {
    throw new Error(usage());
  }
  const report = parseMailbox(fs.readFileSync(paths[0]), { pixels });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (strict && (!report.complete || !report.verified)) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
