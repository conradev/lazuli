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
  "gxTextureImageSource",
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
    filename: "browser_boot.gx-texture-source.js",
  });
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("GX texture register banks expose IMAGE1, IMAGE2, and IMAGE3 sources", () => {
  const context = pureContext();
  assert.equal(context.gxTextureRegisters(0).image1, 0x8c);
  assert.equal(context.gxTextureRegisters(0).image2, 0x90);
  assert.equal(context.gxTextureRegisters(0).image3, 0x94);
  assert.equal(context.gxTextureRegisters(7).image1, 0xaf);
  assert.equal(context.gxTextureRegisters(7).image2, 0xb3);
  assert.equal(context.gxTextureRegisters(7).image3, 0xb7);
});

test("manually managed TMEM textures reject IMAGE3 before any DRAM access", () => {
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
    gxTextureMipChainLayout(width, height, layout) {
      return {
        levels: [{
          blocksWide: Math.ceil(width / layout.blockWidth),
          blocksHigh: Math.ceil(height / layout.blockHeight),
          encodedBytes: (
            Math.ceil(width / layout.blockWidth)
            * Math.ceil(height / layout.blockHeight)
            * layout.blockBytes
          ),
        }],
      };
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
    filename: "browser_boot.gx-texture-tmem-rejection.js",
  });

  const registers = context.gxTextureRegisters(0);
  gxBpRegisters[registers.image0] = 7 | (7 << 10);
  gxBpRegisters[registers.image1] = 0x00200000 | 0x1234;
  gxBpRegisters[registers.image2] = 0x5678;
  gxBpRegisters[registers.image3] = 0x00abc0;

  assert.deepEqual(
    plain(context.gxTextureImageSource(
      gxBpRegisters[registers.image1],
      gxBpRegisters[registers.image2],
      gxBpRegisters[registers.image3],
    )),
    {
      kind: "preloaded-tmem",
      evenTmemRegister: 0x00201234,
      oddTmemRegister: 0x5678,
    },
  );
  assert.deepEqual(
    plain(context.gxTextureImageSource(0, 0x5678, 0x00abc0)),
    {
      kind: "main-memory",
      address: 0x157800,
    },
  );
  assert.equal(context.gxDecodeTexture(0), null);
  assert.equal(context.gxTextureDecodeErrors, 1);
  assert.equal(markedConsumer, false);
  assert.equal(requestedRam, false);
});

test("texture-copy binding ignores preloaded TMEM IMAGE3 values", () => {
  const gxBpRegisters = new Uint32Array(0x100);
  const context = pureContext({ gxBpRegisters });
  vm.runInContext(extractFunction("gxTextureCopyIsBound"), context, {
    filename: "browser_boot.gx-texture-copy-binding.js",
  });

  const first = context.gxTextureRegisters(0);
  gxBpRegisters[first.image1] = 0x00200000;
  gxBpRegisters[first.image3] = 0x1234;
  assert.equal(context.gxTextureCopyIsBound(0x24680), false);

  const second = context.gxTextureRegisters(1);
  gxBpRegisters[second.image3] = 0x1234;
  assert.equal(context.gxTextureCopyIsBound(0x24680), true);
});

test("IMAGE1 manual-to-main writes arm the current texture-copy address", () => {
  const gxBpRegisters = new Uint32Array(0x100);
  const consumers = [];
  const context = pureContext({
    gxBpRegisters,
    gxBpLoads: 0,
    gxMarkTextureCopyConsumer(address) {
      consumers.push(address);
    },
  });
  vm.runInContext(extractFunction("recordGxBpWrite"), context, {
    filename: "browser_boot.gx-texture-source-write.js",
  });
  const bpWord = (register, value) => register * 0x01000000 + value;

  for (const textureMap of [0, 4]) {
    gxBpRegisters.fill(0);
    gxBpRegisters[0xfe] = 0x00ffffff;
    consumers.length = 0;
    const registers = context.gxTextureRegisters(textureMap);

    gxBpRegisters[registers.image1] = 0x00200000;
    context.recordGxBpWrite(bpWord(registers.image3, 0x1234));
    assert.deepEqual(
      consumers,
      [],
      `map ${textureMap} IMAGE3 cannot arm while IMAGE1 selects TMEM`,
    );

    context.recordGxBpWrite(bpWord(registers.image1, 0));
    assert.deepEqual(
      consumers,
      [0x24680],
      `map ${textureMap} IMAGE1 transition must arm existing IMAGE3`,
    );

    consumers.length = 0;
    context.recordGxBpWrite(bpWord(registers.image1, 0x00200000));
    context.recordGxBpWrite(bpWord(registers.image3, 0x5678));
    assert.deepEqual(
      consumers,
      [],
      `map ${textureMap} preloaded TMEM writes stay outside DRAM consumers`,
    );
  }
});
