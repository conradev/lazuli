#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.notEqual(match, null, `missing ${name} in browser_boot.rs`);
  const start = match.index;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

const pureFunctions = [
  "gxTextureRegisters",
  "gxTextureLayout",
  "gxTextureMipCount",
  "gxTextureMipChainLayout",
];

function pureContext(extra = {}) {
  const context = {
    Array,
    Math,
    Number,
    Object,
    Uint32Array,
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(pureFunctions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.gx-mip-layout.js",
  });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("GX texture register banks expose MODE0 and MODE1 state", () => {
  const context = pureContext();
  assert.equal(context.gxTextureRegisters(0).mode0, 0x80);
  assert.equal(context.gxTextureRegisters(0).mode1, 0x84);
  assert.equal(context.gxTextureRegisters(7).mode0, 0xa3);
  assert.equal(context.gxTextureRegisters(7).mode1, 0xa7);
});

test("GX MODE1 max LOD rounds up partial levels and clamps to texture extent", () => {
  const context = pureContext();
  const pointMipMode = 1 << 5;
  const count = maxLodRaw =>
    context.gxTextureMipCount(1024, 1024, pointMipMode, maxLodRaw << 8);

  assert.equal(count(0), 1);
  assert.equal(count(1), 2);
  assert.equal(count(0x0f), 2);
  assert.equal(count(0x10), 2);
  assert.equal(count(0x11), 3);
  assert.equal(count(0xa0), 11);
  assert.equal(
    context.gxTextureMipCount(8, 8, pointMipMode, 0xff << 8),
    4,
    "MODE1 cannot request levels below the theoretical 1x1 level",
  );
  assert.equal(
    context.gxTextureMipCount(1024, 1024, pointMipMode, 0xff),
    1,
    "MODE1 min LOD does not change the encoded chain length",
  );
});

test("GX MODE0 selects base-only, MODE1-backed, or reserved mip layout", () => {
  const context = pureContext();
  const staleMode1 = 0xa0 << 8;
  assert.equal(
    context.gxTextureMipCount(1024, 1024, 0, staleMode1),
    1,
    "mip mode none ignores stale MODE1 state",
  );
  assert.equal(
    context.gxTextureMipCount(1024, 1024, 1 << 5, staleMode1),
    11,
    "point mip mode uses MODE1",
  );
  assert.equal(
    context.gxTextureMipCount(1024, 1024, 2 << 5, staleMode1),
    11,
    "linear mip mode uses MODE1",
  );
  assert.equal(
    context.gxTextureMipCount(1024, 1024, 3 << 5, staleMode1),
    null,
    "reserved mip mode has no decodable chain",
  );
  assert.equal(
    context.gxTextureMipChainLayout(
      8,
      8,
      context.gxTextureLayout(0),
      3 << 5,
      staleMode1,
    ),
    null,
  );
});

test("GX 8x8 mip chains use per-format block-rounded encoded spans", () => {
  const context = pureContext();
  const expected = new Map([
    [0, [32, 32, 32, 32]],
    [1, [64, 32, 32, 32]],
    [2, [64, 32, 32, 32]],
    [3, [128, 32, 32, 32]],
    [4, [128, 32, 32, 32]],
    [5, [128, 32, 32, 32]],
    [6, [256, 64, 64, 64]],
    [8, [32, 32, 32, 32]],
    [9, [64, 32, 32, 32]],
    [10, [128, 32, 32, 32]],
    [14, [32, 32, 32, 32]],
  ]);

  for (const [format, encodedBytes] of expected) {
    const layout = context.gxTextureMipChainLayout(
      8,
      8,
      context.gxTextureLayout(format),
      1 << 5,
      0x30 << 8,
    );
    assert.equal(layout.levelCount, 4, `format ${format} level count`);
    assert.deepEqual(
      plain(layout.levels.map(level => level.encodedBytes)),
      encodedBytes,
      `format ${format} encoded sizes`,
    );
    assert.deepEqual(
      plain(layout.levels.map(level => level.encodedOffset)),
      encodedBytes.map((_size, index) =>
        encodedBytes.slice(0, index).reduce((total, size) => total + size, 0)
      ),
      `format ${format} encoded offsets`,
    );
    assert.equal(
      layout.encodedBytes,
      encodedBytes.reduce((total, size) => total + size, 0),
      `format ${format} encoded total`,
    );
    assert.deepEqual(
      plain(layout.levels.map(level => level.decodedBytes)),
      [256, 64, 16, 4],
      `format ${format} decoded RGBA level sizes`,
    );
    assert.deepEqual(
      plain(layout.levels.map(level => level.decodedOffset)),
      [0, 256, 320, 336],
      `format ${format} decoded RGBA offsets`,
    );
    assert.equal(layout.decodedBytes, 340, `format ${format} decoded RGBA total`);
  }
});

test("GX NPOT mip dimensions floor each axis independently through 1x1", () => {
  const context = pureContext();
  const layout = context.gxTextureMipChainLayout(
    7,
    5,
    context.gxTextureLayout(0),
    2 << 5,
    0xff << 8,
  );
  assert.deepEqual(
    plain(layout.levels.map(level => [level.width, level.height])),
    [[7, 5], [3, 2], [1, 1]],
  );
  assert.deepEqual(
    plain(layout.levels.map(level => [
      level.blocksWide,
      level.blocksHigh,
      level.encodedOffset,
      level.encodedBytes,
    ])),
    [[1, 1, 0, 32], [1, 1, 32, 32], [1, 1, 64, 32]],
  );
  assert.equal(layout.encodedBytes, 96);
  assert.equal(layout.decodedBytes, (7 * 5 + 3 * 2 + 1) * 4);
});

test("reserved GX mip mode rejects decode before consumer or DRAM access", () => {
  let markedConsumer = false;
  let requestedRam = false;
  const gxBpRegisters = new Uint32Array(0x100);
  const context = pureContext({
    Uint8ClampedArray,
    gxBpRegisters,
    gxTextureDecodeErrors: 0,
    gxTextureSamplerState() {
      return {};
    },
    gxMarkTextureCopyConsumer() {
      markedConsumer = true;
    },
    ramPointer() {
      requestedRam = true;
      return 0;
    },
  });
  vm.runInContext(extractFunction("gxDecodeTexture"), context, {
    filename: "browser_boot.gx-mip-mode-rejection.js",
  });

  const registers = context.gxTextureRegisters(0);
  gxBpRegisters[registers.mode0] = 3 << 5;
  gxBpRegisters[registers.mode1] = 0xa0 << 8;
  gxBpRegisters[registers.image0] = 7 | (7 << 10);
  gxBpRegisters[registers.image3] = 0x1234;

  assert.equal(context.gxDecodeTexture(0), null);
  assert.equal(context.gxTextureDecodeErrors, 1);
  assert.equal(markedConsumer, false);
  assert.equal(requestedRam, false);
});
