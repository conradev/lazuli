// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CASE_COUNT,
  CASE_NAMES,
  ENDIAN_TAG,
  ENTRY_BYTES,
  EXPECTED_CASES,
  HEADER_BYTES,
  HEIGHT,
  MAGIC,
  MAILBOX_BYTES,
  MODE_COUNT,
  PIXELS,
  RESULT_COUNT,
  VERSION,
  WIDTH,
  fnv1a64,
  parseMailbox,
} from "./parse-mailbox.mjs";
import { compareMailboxes } from "./compare-mailboxes.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.dirname(directory);
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(fixtureRoot, "oracle-manifest.json"),
    "utf8",
  ),
);
const cSource = fs.readFileSync(
  path.join(fixtureRoot, "source", "main.c"),
  "utf8",
);

function casesFromCSource(source) {
  const constants = new Map(
    Array.from(
      source.matchAll(
        /^#define\s+(F32_[A-Z0-9_]+)\s+(0x[0-9a-f]+)u$/gim,
      ),
      (match) => [match[1], match[2].toLowerCase()],
    ),
  );
  const cases = [];
  const pattern =
    /\{\s*(\d+),\s*"([^"]+)",\s*\{\s*\{([^}]+)\},\s*\{([^}]+)\},\s*\{([^}]+)\},\s*\},\s*\}/g;
  for (const match of source.matchAll(pattern)) {
    const clipBits = match.slice(3, 6).map((row) =>
      row.split(",").map((token) => {
        const name = token.trim();
        const value = constants.get(name);
        assert.notEqual(value, undefined, `unresolved C f32 constant ${name}`);
        return value;
      })
    );
    cases.push({
      id: Number(match[1]),
      name: match[2],
      clipBits,
    });
  }
  return cases;
}

function f32FromHexBits(bits) {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, Number.parseInt(bits.slice(2), 16));
  return view.getFloat32(0);
}

function homogeneousFaceNormal(clipBits) {
  const [a, b, c] = clipBits.map((vertex) =>
    vertex.map(f32FromHexBits)
  );
  const f32 = Math.fround;
  return f32(
    f32(f32(f32(c[3] * a[0]) - f32(a[3] * c[0])) * b[1]) +
      f32(f32(f32(c[0] * a[1]) - f32(a[0] * c[1])) * b[3]) +
      f32(f32(f32(c[1] * a[3]) - f32(a[1] * c[3])) * b[0]),
  );
}

function writeU64(buffer, offset, value) {
  buffer.writeUInt32BE(
    Number((value >> 32n) & 0xffffffffn),
    offset,
  );
  buffer.writeUInt32BE(Number(value & 0xffffffffn), offset + 4);
}

function syntheticMailbox() {
  const bytes = Buffer.alloc(MAILBOX_BYTES);
  MAGIC.copy(bytes, 0);
  bytes.writeUInt32BE(VERSION, 4);
  bytes.writeUInt32BE(ENDIAN_TAG, 8);
  bytes.writeUInt32BE(HEADER_BYTES, 12);
  bytes.writeUInt32BE(ENTRY_BYTES, 16);
  bytes.writeUInt32BE(WIDTH, 20);
  bytes.writeUInt32BE(HEIGHT, 24);
  bytes.writeUInt32BE(CASE_COUNT, 28);
  bytes.writeUInt32BE(MODE_COUNT, 32);
  bytes.writeUInt32BE(RESULT_COUNT, 36);
  bytes.writeUInt32BE(2, 40);
  bytes.writeUInt32BE(MAILBOX_BYTES, 44);

  for (let index = 0; index < RESULT_COUNT; index += 1) {
    const offset = HEADER_BYTES + index * ENTRY_BYTES;
    const caseId = Math.floor(index / MODE_COUNT);
    const mode = index % MODE_COUNT;
    bytes.writeUInt32BE(caseId, offset);
    bytes.writeUInt32BE(mode, offset + 4);
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let component = 0; component < 4; component += 1) {
        bytes.writeUInt32BE(
          Number.parseInt(
            EXPECTED_CASES[caseId].clipBits[vertex][component].slice(2),
            16,
          ),
          offset + 8 + (vertex * 4 + component) * 4,
        );
      }
    }
    for (let pixel = 0; pixel < PIXELS; pixel += 1) {
      bytes.writeUInt32BE(0x000000ff, offset + 136 + pixel * 4);
    }
    const rgba = bytes.subarray(
      offset + 136,
      offset + 136 + PIXELS * 4,
    );
    writeU64(bytes, offset + 56, fnv1a64(rgba));
  }

  writeU64(
    bytes,
    48,
    fnv1a64(bytes.subarray(HEADER_BYTES)),
  );
  return bytes;
}

test("machine-readable manifest pins the C and parser ABI", () => {
  assert.equal(manifest.schema, "lazuli.gx-w-clipdisable-oracle/v1");
  assert.equal(manifest.mailbox.magic, "GXW1");
  assert.equal(manifest.mailbox.headerBytes, HEADER_BYTES);
  assert.equal(manifest.mailbox.entryBytes, ENTRY_BYTES);
  assert.equal(manifest.mailbox.mailboxBytes, MAILBOX_BYTES);
  assert.equal(manifest.surface.width, WIDTH);
  assert.equal(manifest.surface.height, HEIGHT);
  assert.equal(manifest.cases.length, CASE_COUNT);
  assert.equal(manifest.clipDisableModes.length, MODE_COUNT);
  assert.deepEqual(
    manifest.cases.map((entry) => entry.name),
    CASE_NAMES,
  );
  assert.deepEqual(casesFromCSource(cSource), manifest.cases);
  for (const entry of manifest.cases) {
    assert.notEqual(
      homogeneousFaceNormal(entry.clipBits),
      0,
      `${entry.name} must not collapse to a degenerate source triangle`,
    );
  }
});

test("parser verifies every entry and the aggregate mailbox hash", () => {
  const report = parseMailbox(syntheticMailbox());
  assert.equal(report.complete, true);
  assert.equal(report.verified, true);
  assert.equal(report.aggregateHashVerified, true);
  assert.equal(report.entries.length, RESULT_COUNT);
  assert.ok(report.entries.every((entry) => entry.verified));
  assert.ok(
    report.entries.every((entry) => entry.coveredPixels === 0),
  );
});

test("parser finds the mailbox inside a complete MEM1 dump", () => {
  const prefix = Buffer.alloc(0x1700000, 0xa5);
  const memory = Buffer.concat([prefix, syntheticMailbox()]);
  const report = parseMailbox(memory);
  assert.equal(report.mailboxOffset, 0x1700000);
  assert.equal(report.complete, true);
  assert.equal(report.verified, true);
});

test("parser rejects truncated and internally inconsistent observations", () => {
  const bytes = syntheticMailbox();
  assert.throws(
    () => parseMailbox(bytes.subarray(0, HEADER_BYTES)),
    /truncated GXW1 mailbox/,
  );

  const bad = Buffer.from(bytes);
  bad.writeUInt32BE(9, 16);
  assert.throws(
    () => parseMailbox(bad, { offset: 0 }),
    /invalid GXW1 entryBytes/,
  );

  const corrupt = Buffer.from(bytes);
  corrupt[HEADER_BYTES + 136] ^= 0xff;
  const report = parseMailbox(corrupt);
  assert.equal(report.complete, true);
  assert.equal(report.verified, false);
  assert.equal(report.entries[0].verification.rgbaHash, false);
  assert.equal(report.aggregateHashVerified, false);
});

test("parser rejects permutations, duplicates, and altered clip inputs", () => {
  const permuted = syntheticMailbox();
  const first = Buffer.from(
    permuted.subarray(HEADER_BYTES, HEADER_BYTES + ENTRY_BYTES),
  );
  const second = Buffer.from(
    permuted.subarray(
      HEADER_BYTES + ENTRY_BYTES,
      HEADER_BYTES + ENTRY_BYTES * 2,
    ),
  );
  second.copy(permuted, HEADER_BYTES);
  first.copy(permuted, HEADER_BYTES + ENTRY_BYTES);
  writeU64(
    permuted,
    48,
    fnv1a64(permuted.subarray(HEADER_BYTES)),
  );
  assert.throws(
    () => parseMailbox(permuted),
    /entry 0 order mismatch/,
  );

  const duplicated = syntheticMailbox();
  duplicated.copy(
    duplicated,
    HEADER_BYTES + ENTRY_BYTES,
    HEADER_BYTES,
    HEADER_BYTES + ENTRY_BYTES,
  );
  writeU64(
    duplicated,
    48,
    fnv1a64(duplicated.subarray(HEADER_BYTES)),
  );
  assert.throws(
    () => parseMailbox(duplicated),
    /entry 1 order mismatch/,
  );

  const altered = syntheticMailbox();
  altered.writeUInt32BE(0, HEADER_BYTES + 8);
  assert.throws(
    () => parseMailbox(altered),
    /entry 0 clip input mismatch at vertex 0, component 0/,
  );
});

test("hardware/browser comparator is exact down to each RGBA pixel", () => {
  const reference = syntheticMailbox();
  const exact = compareMailboxes(reference, reference);
  assert.equal(exact.pass, true);
  assert.equal(exact.mismatchCount, 0);

  const candidate = Buffer.from(reference);
  candidate[HEADER_BYTES + 136] = 0xff;
  const mismatch = compareMailboxes(reference, candidate);
  assert.equal(mismatch.pass, false);
  assert.equal(mismatch.mismatchCount, 1);
  assert.equal(mismatch.mismatches[0].caseId, 0);
  assert.equal(mismatch.mismatches[0].clipDisable, 0);
  assert.equal(mismatch.mismatches[0].differingPixelCount, 1);
  assert.deepEqual(
    mismatch.mismatches[0].differingPixels[0],
    {
      x: 0,
      y: 0,
      reference: "0x000000ff",
      candidate: "0xff0000ff",
    },
  );
});
