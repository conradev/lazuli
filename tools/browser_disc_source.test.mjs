#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  CisoDiscSource,
  HttpRangeByteSource,
  openDiscSource,
  parseCisoHeader,
  readDiscBoot,
} from "../crates/ppcwasmjit/examples/browser_disc_source.mjs";

const CISO_HEADER_SIZE = 0x8000;

function writeAscii(bytes, offset, value) {
  bytes.set(new TextEncoder().encode(value), offset);
}

function makeRawDisc() {
  const bytes = new Uint8Array(4 * 1024 * 1024);
  const view = new DataView(bytes.buffer);
  const bootOffset = 0x10000;
  const fstOffset = 0x22000;
  const fstSize = 0x40;
  const fstMaxSize = 0x80;

  writeAscii(bytes, 0, "GMBE8P");
  bytes[6] = 2;
  bytes[7] = 3;
  bytes[8] = 1;
  bytes[9] = 0x20;
  view.setUint32(0x1c, 0xc2339f3d, false);
  writeAscii(bytes, 0x20, "Disc source fixture");
  view.setUint32(0x420, bootOffset, false);
  view.setUint32(0x424, fstOffset, false);
  view.setUint32(0x428, fstSize, false);
  view.setUint32(0x42c, fstMaxSize, false);

  const dol = new DataView(bytes.buffer, bootOffset, 0x120);
  dol.setUint32(0x00, 0x100, false);
  dol.setUint32(0x48, 0x80004000, false);
  dol.setUint32(0x90, 0x20, false);
  dol.setUint32(0xd8, 0x80005000, false);
  dol.setUint32(0xdc, 0x40, false);
  dol.setUint32(0xe0, 0x80004000, false);
  for (let index = 0; index < 0x20; index += 1) {
    bytes[bootOffset + 0x100 + index] = 0x80 + index;
  }
  for (let index = 0; index < fstSize; index += 1) {
    bytes[fstOffset + index] = 0x40 + index;
  }

  return { bytes, bootOffset, fstOffset, fstSize, fstMaxSize };
}

function makeCiso(blockSize, logicalBlocks, present) {
  assert.equal(blockSize & 31, 0, "test CISO blocks must be 32-byte aligned");
  assert.equal(logicalBlocks.length, present.length);
  const header = new Uint8Array(CISO_HEADER_SIZE);
  const headerView = new DataView(header.buffer);
  writeAscii(header, 0, "CISO");
  headerView.setUint32(4, blockSize, true);
  for (let index = 0; index < present.length; index += 1) {
    header[index + 8] = present[index] ? 1 : 0;
  }

  const physicalBlocks = logicalBlocks.filter((_, index) => present[index]);
  const bytes = new Uint8Array(
    CISO_HEADER_SIZE + physicalBlocks.length * blockSize,
  );
  bytes.set(header);
  for (let index = 0; index < physicalBlocks.length; index += 1) {
    assert.equal(physicalBlocks[index].length, blockSize);
    bytes.set(physicalBlocks[index], CISO_HEADER_SIZE + index * blockSize);
  }
  return { bytes, header };
}

test("local File loading parses boot metadata without reading the whole ISO", async () => {
  const fixture = makeRawDisc();
  const file = new File([fixture.bytes], "fixture.iso");
  const source = await openDiscSource({ kind: "file", file });
  const boot = await readDiscBoot(source);

  assert.equal(boot.identifier, "GMBE8P");
  assert.equal(boot.label, "Disc source fixture (GMBE8P Rev.03)");
  assert.equal(boot.discId, 2);
  assert.equal(boot.version, 3);
  assert.equal(boot.audioStreaming, 1);
  assert.equal(boot.streamBufferSize, 0x20);
  assert.equal(boot.makerCode, 0x3850);
  assert.equal(boot.arenaLow, 0x8042e260);
  assert.equal(boot.fstMaxSize, fixture.fstMaxSize);
  assert.equal(boot.fstAddress, 0x817fe840);
  assert.deepEqual(
    boot.dol,
    fixture.bytes.slice(fixture.bootOffset, fixture.bootOffset + 0x120),
  );
  assert.deepEqual(
    boot.fst,
    fixture.bytes.slice(fixture.fstOffset, fixture.fstOffset + fixture.fstSize),
  );

  const description = source.describe();
  assert.equal(description.kind, "local-file");
  assert.equal(description.size, fixture.bytes.length);
  assert.equal(description.reads, 3);
  assert.equal(description.bytesRead, 3 * 64 * 1024);
  assert.ok(description.bytesRead < fixture.bytes.length / 10);
  assert.equal(description.cache.maximumBytes, 8 * 1024 * 1024);
});

test("boot parsing rejects DOL destinations that spill past MEM1", async () => {
  const fixture = makeRawDisc();
  const view = new DataView(fixture.bytes.buffer);
  view.setUint32(fixture.bootOffset + 0x48, 0x817ffff0, false);
  await assert.rejects(
    readDiscBoot(await openDiscSource({
      kind: "file",
      file: new File([fixture.bytes], "bad-target.iso"),
    })),
    /DOL section 0 extends past MEM1/,
  );
});

test("CISO reads synthesize sparse blocks and coalesce adjacent physical blocks", async () => {
  const blockSize = 32;
  const logicalBlocks = [0x10, 0x20, 0x00, 0x40].map((base) =>
    Uint8Array.from({ length: blockSize }, (_, index) => base + index)
  );
  const { bytes, header } = makeCiso(
    blockSize,
    logicalBlocks,
    [true, true, false, true],
  );
  const reads = [];
  const physical = {
    size: bytes.length,
    async read(offset, length) {
      reads.push({ offset, length });
      return bytes.slice(offset, offset + length);
    },
    describe() {
      return { kind: "recording-physical", reads: reads.length };
    },
  };
  const source = new CisoDiscSource(physical, parseCisoHeader(header));

  const actual = await source.read(8, 24 + 32 + 32 + 16);
  const expected = new Uint8Array(24 + 32 + 32 + 16);
  expected.set(logicalBlocks[0].subarray(8), 0);
  expected.set(logicalBlocks[1], 24);
  expected.set(logicalBlocks[3].subarray(0, 16), 24 + 32 + 32);
  assert.deepEqual(actual, expected);
  assert.deepEqual(reads, [
    { offset: CISO_HEADER_SIZE + 8, length: 24 + 32 },
    { offset: CISO_HEADER_SIZE + 2 * blockSize, length: 16 },
  ]);
  assert.equal(source.describe().physicalRuns, 2);
  assert.equal(source.describe().logicalReads, 1);
});

test("openDiscSource recognizes a local CISO and preserves logical zero blocks", async () => {
  const blockSize = 0x800;
  const logicalBlocks = [0x11, 0x00, 0x33].map((value) =>
    new Uint8Array(blockSize).fill(value)
  );
  const { bytes } = makeCiso(
    blockSize,
    logicalBlocks,
    [true, false, true],
  );
  const source = await openDiscSource(
    { kind: "file", file: new Blob([bytes]) },
    { chunkBytes: CISO_HEADER_SIZE, cacheBytes: 2 * CISO_HEADER_SIZE },
  );

  assert.equal(source.describe().format, "ciso");
  assert.equal(source.describe().blockSize, blockSize);
  assert.equal(source.describe().presentBlocks, 2);
  assert.deepEqual(
    await source.read(blockSize - 8, 8 + blockSize + 8),
    Uint8Array.from([
      ...new Uint8Array(8).fill(0x11),
      ...new Uint8Array(blockSize),
      ...new Uint8Array(8).fill(0x33),
    ]),
  );
});

test("HTTP source requests exact ranges, learns size, and reuses cached chunks", async (t) => {
  const priorFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const remote = Uint8Array.from(
    { length: 0x4000 },
    (_, index) => (index * 17) & 0xff,
  );
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const range = options.headers.Range;
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match, `unexpected Range header ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    calls.push({ url: String(url), range, cache: options.cache });
    return new Response(remote.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${remote.length}` },
    });
  };

  const source = await openDiscSource(
    { kind: "http-range", url: "https://example.test/game.iso" },
    { chunkBytes: 0x1000, cacheBytes: 0x2000 },
  );
  assert.deepEqual(await source.read(0x1800, 16), remote.slice(0x1800, 0x1810));
  assert.deepEqual(await source.read(0x1808, 8), remote.slice(0x1808, 0x1810));
  assert.deepEqual(calls, [
    {
      url: "https://example.test/game.iso",
      range: "bytes=0-4095",
      cache: "no-store",
    },
    {
      url: "https://example.test/game.iso",
      range: "bytes=4096-8191",
      cache: "no-store",
    },
  ]);
  assert.equal(source.describe().size, remote.length);
  assert.equal(source.describe().reads, 2);
  assert.equal(source.describe().bytesRead, 0x2000);
  assert.equal(source.describe().cache.hits, 1);
});

test("network cache fetches large ranges in bounded parallel batches", async (t) => {
  const priorFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const remote = new Uint8Array(2 * 1024 * 1024);
  const view = new DataView(remote.buffer);
  view.setUint32(0x1c, 0xc2339f3d, false);
  let active = 0;
  let maximumActive = 0;
  globalThis.fetch = async (_url, options) => {
    const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    const start = Number(startText);
    const end = Number(endText);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    return new Response(remote.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${remote.length}` },
    });
  };

  const source = await openDiscSource({
    kind: "http-range",
    url: "https://example.test/game.iso",
  });
  await source.read(256 * 1024, 1024 * 1024);
  assert.equal(source.describe().cache.chunkBytes, 256 * 1024);
  assert.equal(source.describe().cache.parallelChunks, 4);
  assert.equal(maximumActive, 4);
});

test("HTTP source rejects full responses, mismatched ranges, and short bodies", async (t) => {
  const priorFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  globalThis.fetch = async (url) => {
    const host = new URL(url).host;
    if (host === "no-range.test") return new Response(new Uint8Array(4));
    if (host === "wrong-range.test") {
      return new Response(new Uint8Array(4), {
        status: 206,
        headers: { "Content-Range": "bytes 1-4/32" },
      });
    }
    return new Response(new Uint8Array(3), {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/32" },
    });
  };

  await assert.rejects(
    new HttpRangeByteSource("https://no-range.test/disc.iso").read(0, 4),
    /must support HTTP Range requests; received 200/,
  );
  await assert.rejects(
    new HttpRangeByteSource("https://wrong-range.test/disc.iso").read(0, 4),
    /invalid Content-Range/,
  );
  await assert.rejects(
    new HttpRangeByteSource("https://short-body.test/disc.iso").read(0, 4),
    /returned 3 bytes; expected 4/,
  );
});
