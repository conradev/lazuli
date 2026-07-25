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
  "gxStrictV7TexturePreflight",
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

test("strict V7 preflight rejects raw state that legacy sampler masking would hide", () => {
  const context = pureContext();
  vm.runInContext(extractFunction("gxTextureSamplerState"), context, {
    filename: "browser_boot.gx-v7-sampler-mask.js",
  });
  const canonicalMode0 = (1 << 4) | (6 << 5);
  const canonicalMode1 = 0x30 << 8;

  for (let reservedBit = 0; reservedBit < 32; reservedBit += 1) {
    if ((0x0039ffff & 2 ** reservedBit) !== 0) continue;
    const rawMode0 = canonicalMode0 + 2 ** reservedBit;
    assert.deepEqual(
      plain(context.gxTextureSamplerState(rawMode0, canonicalMode1)),
      plain(context.gxTextureSamplerState(canonicalMode0, canonicalMode1)),
      `legacy MODE0 masking aliases reserved bit ${reservedBit}`,
    );
    assert.deepEqual(
      plain(context.gxStrictV7TexturePreflight(
        rawMode0,
        canonicalMode1,
        6,
        8,
        8,
      )),
      { accepted: false, reason: "noncanonical-mode0-bits" },
    );
  }

  for (let reservedBit = 16; reservedBit < 32; reservedBit += 1) {
    const rawMode1 = canonicalMode1 + 2 ** reservedBit;
    assert.deepEqual(
      plain(context.gxTextureSamplerState(canonicalMode0, rawMode1)),
      plain(context.gxTextureSamplerState(canonicalMode0, canonicalMode1)),
      `legacy MODE1 masking aliases reserved bit ${reservedBit}`,
    );
    assert.deepEqual(
      plain(context.gxStrictV7TexturePreflight(
        canonicalMode0,
        rawMode1,
        6,
        8,
        8,
      )),
      { accepted: false, reason: "noncanonical-mode1-bits" },
    );
  }
});

test("strict V7 preflight remains dormant while the live producer stays byte-stable V6", () => {
  assert.equal(
    source.match(/\bgxStrictV7TexturePreflight\s*\(/g)?.length,
    1,
    "the only preflight occurrence is its declaration until V7 activation",
  );
  const post = extractFunction("postGxFrame");
  assert.match(post, /packGxFramePacketV6\(/);
  assert.doesNotMatch(post, /packGxFramePacketV7|gxStrictV7TexturePreflight/);
  assert.doesNotMatch(
    extractFunction("gxDecodeTexture"),
    /gxStrictV7TexturePreflight/,
  );
});

test("strict V7 preflight fails closed on unknown sampler and mip states", () => {
  const context = pureContext();
  const mode1 = 0x30 << 8;
  const rejected = (mode0, expectedReason) => {
    assert.deepEqual(
      plain(context.gxStrictV7TexturePreflight(mode0, mode1, 6, 8, 8)),
      { accepted: false, reason: expectedReason },
    );
  };

  rejected(3 << 5, "reserved-min-filter");
  rejected(7 << 5, "reserved-min-filter");
  rejected((1 << 5) | (1 << 21), "unsupported-lod-bias-clamp");
  rejected((1 << 5) | (1 << 19), "unsupported-anisotropy");
  rejected((1 << 5) | (2 << 19), "unsupported-anisotropy");
  rejected((1 << 5) | (3 << 19), "reserved-anisotropy");

  assert.deepEqual(
    plain(context.gxStrictV7TexturePreflight(-1, mode1, 6, 8, 8)),
    { accepted: false, reason: "invalid-mode0" },
  );
  assert.deepEqual(
    plain(context.gxStrictV7TexturePreflight(1 << 5, 1.5, 6, 8, 8)),
    { accepted: false, reason: "invalid-mode1" },
  );
  for (const [width, height] of [[0, 8], [8, 0], [1025, 8], [8, 1.5]]) {
    assert.deepEqual(
      plain(context.gxStrictV7TexturePreflight(
        1 << 5,
        mode1,
        6,
        width,
        height,
      )),
      { accepted: false, reason: "invalid-texture-dimensions" },
    );
  }
});

test("strict V7 preflight normalizes effective LOD state like the renderer", () => {
  const context = pureContext();

  for (const minFilter of [1, 2, 5, 6]) {
    const oneLevel = context.gxStrictV7TexturePreflight(
      minFilter << 5,
      0,
      6,
      8,
      8,
    );
    assert.equal(oneLevel.accepted, true);
    assert.equal(oneLevel.classification, "base-only-companion");
    assert.equal(oneLevel.levelCount, 1);
    assert.equal(oneLevel.effectiveLodMinRaw, 0);
    assert.equal(oneLevel.effectiveLodMaxRaw, 0);
  }

  for (const minFilter of [0, 4]) {
    const baseOnly = context.gxStrictV7TexturePreflight(
      (minFilter << 5) | (1 << 8) | (0x81 << 9),
      (0xa0 << 8) | 0xf0,
      6,
      8,
      8,
    );
    assert.equal(baseOnly.classification, "base-only-companion");
    assert.equal(baseOnly.lodBiasRaw, 0x81);
    assert.equal(baseOnly.lodBiasSixteenths, 0);
    assert.equal(baseOnly.effectiveLodMinRaw, 0);
    assert.equal(baseOnly.effectiveLodMaxRaw, 0);
  }

  const residentClamped = context.gxStrictV7TexturePreflight(
    (6 << 5) | (0x81 << 9),
    (0xff << 8) | 0xf0,
    6,
    8,
    8,
  );
  assert.equal(residentClamped.levelCount, 4);
  assert.equal(residentClamped.lodBiasSixteenths, -64);
  assert.equal(residentClamped.effectiveLodMaxRaw, 0x30);
  assert.equal(
    residentClamped.effectiveLodMinRaw,
    0x30,
    "resident max wins when both raw LOD bounds exceed the uploaded chain",
  );
});

test("strict V7 preflight enforces format and power-of-two activation constraints", () => {
  const context = pureContext();
  const mode1 = 0x30 << 8;

  for (const format of [8, 9, 10]) {
    for (const minFilter of [2, 6]) {
      assert.deepEqual(
        plain(context.gxStrictV7TexturePreflight(
          minFilter << 5,
          mode1,
          format,
          8,
          8,
        )),
        { accepted: false, reason: "ci-texture-cannot-use-mip-linear" },
      );
    }
    for (const minFilter of [1, 5]) {
      assert.equal(
        context.gxStrictV7TexturePreflight(
          minFilter << 5,
          mode1,
          format,
          8,
          8,
        ).accepted,
        true,
      );
    }
  }

  for (const [width, height] of [[7, 8], [8, 7], [7, 5]]) {
    assert.deepEqual(
      plain(context.gxStrictV7TexturePreflight(
        1 << 5,
        mode1,
        6,
        width,
        height,
      )),
      { accepted: false, reason: "mipped-texture-must-be-power-of-two" },
    );
  }
  assert.deepEqual(
    plain(context.gxStrictV7TexturePreflight(1, 0, 6, 7, 8)),
    { accepted: false, reason: "wrap-s-requires-power-of-two-width" },
  );
  assert.deepEqual(
    plain(context.gxStrictV7TexturePreflight(2 << 2, 0, 6, 8, 7)),
    { accepted: false, reason: "wrap-t-requires-power-of-two-height" },
  );
  assert.deepEqual(
    plain(context.gxStrictV7TexturePreflight(1 | (1 << 2), 0, 6, 7, 7)),
    { accepted: false, reason: "wrap-s-requires-power-of-two-width" },
    "S is the deterministic first rejection when both wrapped axes are NPOT",
  );
  assert.equal(
    context.gxStrictV7TexturePreflight(1, 0, 6, 8, 7).accepted,
    true,
    "S wrapping constrains width but not a clamp-addressed height",
  );
  assert.equal(
    context.gxStrictV7TexturePreflight(1 << 2, 0, 6, 7, 8).accepted,
    true,
    "T wrapping constrains height but not a clamp-addressed width",
  );
  for (const minFilter of [0, 4]) {
    assert.equal(
      context.gxStrictV7TexturePreflight(
        minFilter << 5,
        0xffff,
        6,
        7,
        5,
      ).classification,
      "base-only-companion",
      `NPOT dimensions remain legal for base-only min mode ${minFilter}`,
    );
  }
  assert.deepEqual(
    plain(context.gxStrictV7TexturePreflight(1 << 5, mode1, 7, 8, 8)),
    { accepted: false, reason: "unsupported-texture-format" },
  );
});

test("strict V7 preflight classifies SMB-relevant state without approximation", () => {
  const context = pureContext();
  const mode0 =
    1
    | (2 << 2)
    | (1 << 4)
    | (6 << 5)
    | (1 << 8)
    | (0x81 << 9);
  const classification = plain(context.gxStrictV7TexturePreflight(
    mode0,
    (0xa0 << 8) | 0x20,
    6,
    1024,
    512,
  ));
  assert.deepEqual(classification, {
    accepted: true,
    classification: "genuine-mip",
    mode0,
    mode1: (0xa0 << 8) | 0x20,
    format: 6,
    width: 1024,
    height: 512,
    levelCount: 11,
    minFilter: 6,
    mipMode: 2,
    magLinear: true,
    minLinear: true,
    diagonalLod: true,
    lodBiasRaw: 0x81,
    lodBiasSixteenths: -64,
    lodMinRaw: 0x20,
    lodMaxRaw: 0xa0,
    effectiveLodMinRaw: 0x20,
    effectiveLodMaxRaw: 0xa0,
    wrapS: 1,
    wrapT: 2,
  });
  assert.deepEqual(
    plain(context.gxStrictV7TexturePreflight(
      mode0,
      (0xa0 << 8) | 0xf0,
      6,
      1024,
      512,
    )),
    {
      ...classification,
      mode1: (0xa0 << 8) | 0xf0,
      lodMinRaw: 0xf0,
      effectiveLodMinRaw: 0xa0,
    },
    "MODE1 max wins deterministically when the raw minimum is larger",
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
