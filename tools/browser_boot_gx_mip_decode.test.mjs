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

const decodeFunctions = [
  "createWeightedLruCache",
  "gxReadU16",
  "gxTextureRegisters",
  "gxTextureCopyIsBound",
  "gxPrearmTextureCopyProducer",
  "gxTextureLayout",
  "gxCopyTextureLayout",
  "gxTextureCopyDestinationMetadata",
  "gxRecordTextureCopyGeneration",
  "gxTextureMipCount",
  "gxStrictV7TexturePreflight",
  "gxTextureMipChainLayout",
  "gxTextureImageSource",
  "gxExpand3",
  "gxExpand4",
  "gxExpand5",
  "gxExpand6",
  "gxTexturePixel",
  "gxRgb565",
  "gxRgb5a3",
  "gxCmprBlend",
  "gxDecodeCmprBlock",
  "gxTlutColor",
  "gxTextureSamplerState",
  "gxTextureLowerMipCopyGeneration",
  "gxDecodeTextureLevel",
  "gxDecodeTexture",
  "gxTextureSummary",
  "gxTextureBaseOnly",
];

function decodeContext({ byteLength = 0x4000 } = {}) {
  const bytes = new Uint8Array(byteLength);
  const ramRequests = [];
  const consumers = [];
  const context = {
    Array,
    Map,
    Math,
    Number,
    Object,
    String,
    Uint8Array,
    Uint8ClampedArray,
    Uint32Array,
    bytes,
    gxBpRegisters: new Uint32Array(0x100),
    gxTmem: new Uint8Array(1024 * 1024),
    gxTextureCache: null,
    gxTextureCopyDestinations: new Map(),
    gxTextureCopyConsumers: new Map(),
    gxTextureFormatCounts: new Map(),
    gxFrameSkippedPrimitives: 0,
    gxTextureCopyProducerLateArms: 0,
    gxTextureCopyProducerPreArms: 0,
    gxTextureCopyCapturedSurfacesRetained: 0,
    gxCollectFrameGeometry: false,
    gxTextureDecodes: 0,
    gxTextureCacheHits: 0,
    gxTextureSourceHashComputations: 0,
    gxTextureSourceHashMemoHits: 0,
    gxTexturePaletteHashComputations: 0,
    gxTexturePaletteHashMemoHits: 0,
    gxTlutLoads: 0,
    gxTextureDecodedBytes: 0,
    gxTextureDecodeErrors: 0,
    gxMarkTextureCopyConsumer(address) {
      consumers.push(address >>> 0);
    },
    ramPointer(address, length) {
      ramRequests.push({ address, length });
      return address + length <= bytes.byteLength ? address : null;
    },
  };
  vm.createContext(context);
  vm.runInContext(decodeFunctions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.gx-mip-decode.js",
  });
  context.gxTextureCache = context.createWeightedLruCache(
    64,
    16 * 1024 * 1024,
    texture => texture.mipPixels.byteLength,
  );
  return { context, bytes, consumers, ramRequests };
}

function configureTexture(context, {
  textureMap = 0,
  address = 0x100,
  width = 8,
  height = 8,
  format = 0,
  mode0 = 1 << 5,
  mode1 = 0x30 << 8,
  image1 = 0,
  image2 = 0,
  tlut = 0,
} = {}) {
  assert.equal(address & 31, 0, "texture address must be 32-byte aligned");
  const registers = context.gxTextureRegisters(textureMap);
  context.gxBpRegisters[registers.mode0] = mode0;
  context.gxBpRegisters[registers.mode1] = mode1;
  context.gxBpRegisters[registers.image0] =
    (width - 1)
    | ((height - 1) << 10)
    | (format << 20);
  context.gxBpRegisters[registers.image1] = image1;
  context.gxBpRegisters[registers.image2] = image2;
  context.gxBpRegisters[registers.image3] = address >>> 5;
  context.gxBpRegisters[registers.tlut] = tlut;
  return registers;
}

function textureChain(context, {
  width = 8,
  height = 8,
  format = 0,
  mode0 = 1 << 5,
  mode1 = 0x30 << 8,
} = {}) {
  return context.gxTextureMipChainLayout(
    width,
    height,
    context.gxTextureLayout(format),
    mode0,
    mode1,
  );
}

function fillLevelBytes(bytes, address, chain, values) {
  for (const level of chain.levels) {
    bytes.fill(
      values[level.level],
      address + level.encodedOffset,
      address + level.encodedOffset + level.encodedBytes,
    );
  }
}

function rgbaAtStart(level) {
  return Array.from(level.pixels.subarray(0, 4));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("decodes the complete GX mip chain into one allocation with an exact v6 base view", () => {
  const { context, bytes, consumers, ramRequests } = decodeContext();
  const address = 0x100;
  const rawMode0 =
    0xffc00000
    | 2
    | (1 << 2)
    | (1 << 4)
    | (1 << 5)
    | (2 << 19);
  const rawMode1 = 0xabcd0000 | (0x30 << 8) | 0x04;
  configureTexture(context, { address, mode0: rawMode0, mode1: rawMode1 });
  const chain = textureChain(context, { mode0: rawMode0, mode1: rawMode1 });
  fillLevelBytes(bytes, address, chain, [0x11, 0x22, 0x33, 0x44]);

  const texture = context.gxDecodeTexture(0);
  assert.notEqual(texture, null);
  assert.equal(texture.mode0, (rawMode0 & 0x0039ffff) >>> 0);
  assert.equal(texture.mode1, 0x3004);
  assert.deepEqual(plain(texture.strictV7Preflight), {
    accepted: false,
    reason: "noncanonical-mode0-bits",
  });
  assert.equal(texture.levelCount, 4);
  assert.equal(texture.encodedBytes, 128);
  assert.equal(texture.mipPixels.byteLength, 340);
  assert.deepEqual(
    plain(texture.mipLevels.map(level => [
      level.level,
      level.width,
      level.height,
      level.encodedOffset,
      level.decodedOffset,
      level.pixels.byteLength,
    ])),
    [
      [0, 8, 8, 0, 0, 256],
      [1, 4, 4, 32, 256, 64],
      [2, 2, 2, 64, 320, 16],
      [3, 1, 1, 96, 336, 4],
    ],
  );
  assert.strictEqual(texture.pixels, texture.mipLevels[0].pixels);
  assert.strictEqual(texture.pixels.buffer, texture.mipPixels.buffer);
  assert.deepEqual(plain(texture.mipLevels.map(rgbaAtStart)), [
    [17, 17, 17, 17],
    [34, 34, 34, 34],
    [51, 51, 51, 51],
    [68, 68, 68, 68],
  ]);
  assert.deepEqual(consumers, [address, address + 32, address + 64, address + 96]);
  assert.deepEqual(ramRequests, [{ address, length: 128 }]);
  assert.equal(context.gxTextureDecodedBytes, 340);
  assert.equal(context.gxTextureCache.weight, 340);
  assert.equal(context.gxTextureCache.size, 1);
  assert.equal(
    texture.pixels.byteLength,
    texture.width * texture.height * 4,
    "the existing packet-facing pixels view remains base-level sized",
  );
});

test("refreshes raw strict-V7 preflight state on every decoded-image cache hit", () => {
  const { context, bytes } = decodeContext();
  const address = 0x100;
  const mode0 = 1 << 5;
  const mode1 = 0x30 << 8;
  configureTexture(context, { address, mode0, mode1 });
  const chain = textureChain(context, { mode0, mode1 });
  fillLevelBytes(bytes, address, chain, [0x11, 0x22, 0x33, 0x44]);

  const first = context.gxDecodeTexture(0);
  assert.equal(first.strictV7Preflight.accepted, true);
  assert.equal(first.strictV7Preflight.classification, "genuine-mip");

  const registers = context.gxTextureRegisters(0);
  context.gxBpRegisters[registers.mode0] = mode0 | 0x80000000;
  const rejectedMode0 = context.gxDecodeTexture(0);
  assert.equal(rejectedMode0.key, first.key);
  assert.strictEqual(rejectedMode0.mipPixels, first.mipPixels);
  assert.deepEqual(plain(rejectedMode0.strictV7Preflight), {
    accepted: false,
    reason: "noncanonical-mode0-bits",
  });
  assert.equal(
    first.strictV7Preflight.accepted,
    true,
    "the prior draw snapshot remains immutable",
  );

  context.gxBpRegisters[registers.mode0] = mode0;
  context.gxBpRegisters[registers.mode1] = mode1 | 0x80000000;
  const rejectedMode1 = context.gxDecodeTexture(0);
  assert.equal(rejectedMode1.key, first.key);
  assert.strictEqual(rejectedMode1.mipPixels, first.mipPixels);
  assert.deepEqual(plain(rejectedMode1.strictV7Preflight), {
    accepted: false,
    reason: "noncanonical-mode1-bits",
  });
  assert.equal(context.gxTextureDecodes, 1);
  assert.equal(context.gxTextureCacheHits, 2);

  const decodeSource = extractFunction("gxDecodeTexture");
  assert.ok(
    decodeSource.indexOf("gxStrictV7TexturePreflight(")
      < decodeSource.indexOf("gxTextureSamplerState("),
    "raw preflight must run before legacy sampler canonicalization",
  );
});

test("bounds-checks the full encoded chain before decode or cache insertion", () => {
  const address = 0x100;
  const { context, ramRequests } = decodeContext({ byteLength: address + 64 });
  configureTexture(context, { address });

  assert.equal(context.gxDecodeTexture(0), null);
  assert.deepEqual(ramRequests, [{ address, length: 128 }]);
  assert.equal(context.gxTextureDecodeErrors, 1);
  assert.equal(context.gxTextureDecodes, 0);
  assert.equal(context.gxTextureCache.size, 0);
});

test("hashes every encoded level while min-LOD-only changes reuse decoded storage", () => {
  const { context, bytes } = decodeContext();
  const address = 0x100;
  const chain = textureChain(context);
  configureTexture(context, { address });
  fillLevelBytes(bytes, address, chain, [0x11, 0x22, 0x33, 0x44]);

  const first = context.gxDecodeTexture(0);
  bytes[address + chain.levels[1].encodedOffset] = 0x52;
  const changedLowerMip = context.gxDecodeTexture(0);
  assert.notEqual(changedLowerMip.key, first.key);
  assert.deepEqual(rgbaAtStart(changedLowerMip.mipLevels[0]), rgbaAtStart(first.mipLevels[0]));
  assert.notDeepEqual(
    rgbaAtStart(changedLowerMip.mipLevels[1]),
    rgbaAtStart(first.mipLevels[1]),
  );
  assert.equal(context.gxTextureDecodes, 2);
  assert.equal(context.gxTextureCacheHits, 0);

  const registers = context.gxTextureRegisters(0);
  context.gxBpRegisters[registers.mode1] = (0x30 << 8) | 0x0f;
  const changedMinLod = context.gxDecodeTexture(0);
  assert.equal(changedMinLod.key, changedLowerMip.key);
  assert.notStrictEqual(changedMinLod, changedLowerMip);
  assert.strictEqual(changedMinLod.mipPixels, changedLowerMip.mipPixels);
  assert.equal(changedLowerMip.mode1, 0x3000);
  assert.equal(changedMinLod.mode1, 0x300f);
  assert.equal(context.gxTextureDecodes, 2);
  assert.equal(context.gxTextureCacheHits, 1);
});

test("one synchronous GX decode batch memoizes source and palette fingerprints", () => {
  const { context, bytes } = decodeContext();
  const address = 0x100;
  configureTexture(context, { address, format: 8 });
  const chain = textureChain(context, { format: 8 });
  fillLevelBytes(bytes, address, chain, [0x11, 0x22, 0x33, 0x44]);
  context.gxTmem.fill(0x7f, 0, 32);
  const batch = {
    sourceHashes: new Map(),
    paletteHashes: new Map(),
  };

  const first = context.gxDecodeTexture(0, batch);
  const second = context.gxDecodeTexture(0, batch);

  assert.equal(second.key, first.key);
  assert.strictEqual(second.mipPixels, first.mipPixels);
  assert.equal(context.gxTextureSourceHashComputations, 1);
  assert.equal(context.gxTextureSourceHashMemoHits, 1);
  assert.equal(context.gxTexturePaletteHashComputations, 1);
  assert.equal(context.gxTexturePaletteHashMemoHits, 1);
  assert.equal(context.gxTextureDecodes, 1);
  assert.equal(context.gxTextureCacheHits, 1);

  bytes[address + chain.levels[1].encodedOffset] ^= 0xff;
  context.gxTmem[1] ^= 0xff;
  context.gxTlutLoads += 1;
  const nextBatch = {
    sourceHashes: new Map(),
    paletteHashes: new Map(),
  };
  const changed = context.gxDecodeTexture(0, nextBatch);

  assert.notEqual(changed.key, first.key);
  assert.equal(context.gxTextureSourceHashComputations, 2);
  assert.equal(context.gxTexturePaletteHashComputations, 2);
  assert.equal(context.gxTextureDecodes, 2);
});

test("uses one palette identity and TLUT across every paletted mip level", () => {
  const { context, bytes } = decodeContext();
  const address = 0x100;
  configureTexture(context, { address, format: 8 });
  const chain = textureChain(context, { format: 8 });
  fillLevelBytes(bytes, address, chain, [0x11, 0x22, 0x33, 0x44]);
  for (let index = 0; index < 16; index += 1) {
    context.gxTmem[index * 2] = 0x80 + index;
    context.gxTmem[index * 2 + 1] = index * 0x10;
  }

  const first = context.gxDecodeTexture(0);
  assert.deepEqual(plain(first.mipLevels.map(rgbaAtStart)), [
    [16, 16, 16, 129],
    [32, 32, 32, 130],
    [48, 48, 48, 131],
    [64, 64, 64, 132],
  ]);
  assert.equal(first.palette.entries, 16);
  assert.ok(first.mipLevels.every(level => !("palette" in level)));

  context.gxTmem[4 * 2 + 1] = 0xee;
  const changedPalette = context.gxDecodeTexture(0);
  assert.notEqual(changedPalette.key, first.key);
  assert.notEqual(changedPalette.palette.hash, first.palette.hash);
  assert.deepEqual(rgbaAtStart(changedPalette.mipLevels[0]), rgbaAtStart(first.mipLevels[0]));
  assert.deepEqual(rgbaAtStart(changedPalette.mipLevels[3]), [238, 238, 238, 132]);
});

test("certifies only exact EFB-copy dimensions and base formats as direct generations", () => {
  const address = 0x100;
  const encodedTarget = raw => (((raw << 1) & 0xf) | (raw >>> 3)) << 3;
  const producer = decodeContext();
  const frame = {
    sourceX: 636,
    sourceY: 525,
    width: 7,
    sourceHeight: 5,
    stride: 32,
    copyState: {
      copyCommand: encodedTarget(5) | 0x200,
      pixelControl: 0,
    },
  };
  assert.equal(
    producer.context.gxRecordTextureCopyGeneration(address, 7, true, frame),
    true,
  );
  assert.deepEqual(
    plain(producer.context.gxTextureCopyDestinations.get(address)),
    {
      kind: "output",
      generation: 7,
      width: 2,
      height: 1,
      format: 5,
      stride: 32,
      packedStride: 32,
      directCompatible: true,
    },
  );

  configureTexture(producer.context, {
    address,
    width: 2,
    height: 1,
    format: 5,
    mode0: 0,
    mode1: 0,
  });
  assert.equal(producer.context.gxDecodeTexture(0).textureCopyIndex, 7);

  for (const mismatch of [
    { width: 3, height: 1, format: 5 },
    { width: 2, height: 2, format: 5 },
    { width: 2, height: 1, format: 4 },
  ]) {
    const candidate = decodeContext();
    candidate.context.gxTextureCopyDestinations.set(
      address,
      producer.context.gxTextureCopyDestinations.get(address),
    );
    configureTexture(candidate.context, {
      address,
      ...mismatch,
      mode0: 0,
      mode1: 0,
    });
    assert.equal(
      candidate.context.gxDecodeTexture(0),
      null,
      JSON.stringify(mismatch),
    );
    assert.equal(candidate.context.gxTextureDecodeErrors, 1);
    assert.deepEqual(candidate.ramRequests, []);
    assert.deepEqual(candidate.consumers, []);
  }
});

test("retains skipped compatible producers and captured ordered no-ops", () => {
  const { context } = decodeContext();
  const address = 0x100;
  const compatible = {
    sourceX: 0,
    sourceY: 0,
    width: 8,
    sourceHeight: 8,
    stride: 32,
    copyState: { copyCommand: 0, pixelControl: 0 },
  };
  assert.equal(
    context.gxRecordTextureCopyGeneration(address, 7, true, compatible),
    true,
  );
  assert.equal(
    context.gxRecordTextureCopyGeneration(address, 8, false, compatible),
    true,
  );
  assert.deepEqual(plain(context.gxTextureCopyDestinations.get(address)), {
    kind: "output",
    generation: 7,
    width: 8,
    height: 8,
    format: 0,
    stride: 32,
    packedStride: 32,
    directCompatible: true,
  });
  assert.equal(context.gxTextureCopyCapturedSurfacesRetained, 1);

  assert.equal(
    context.gxRecordTextureCopyGeneration(address, 9, true, {
      ...compatible,
      width: 1,
      sourceHeight: 1,
      copyState: { copyCommand: 0x200, pixelControl: 0 },
    }),
    false,
  );
  assert.deepEqual(plain(context.gxTextureCopyDestinations.get(address)), {
    kind: "output",
    generation: 7,
    width: 8,
    height: 8,
    format: 0,
    stride: 32,
    packedStride: 32,
    directCompatible: true,
  });
});

test("reports skipped zero-half and non-overlap copies without evicting prior provenance", () => {
  const { context } = decodeContext();
  const address = 0x100;
  const compatible = {
    sourceX: 0,
    sourceY: 0,
    width: 8,
    sourceHeight: 8,
    stride: 32,
    copyState: { copyCommand: 0, pixelControl: 0 },
  };
  assert.equal(
    context.gxRecordTextureCopyGeneration(address, 7, true, compatible),
    true,
  );
  const prior = plain(context.gxTextureCopyDestinations.get(address));

  assert.equal(
    context.gxRecordTextureCopyGeneration(address, 8, false, {
      ...compatible,
      width: 1,
      sourceHeight: 1,
      copyState: { copyCommand: 0x200, pixelControl: 0 },
    }),
    false,
  );
  assert.deepEqual(
    plain(context.gxTextureCopyDestinations.get(address)),
    prior,
  );

  assert.equal(
    context.gxRecordTextureCopyGeneration(address, 9, false, {
      ...compatible,
      sourceX: 640,
    }),
    false,
  );
  assert.deepEqual(
    plain(context.gxTextureCopyDestinations.get(address)),
    prior,
  );
  assert.equal(context.gxTextureCopyCapturedSurfacesRetained, 2);
});

test("distinguishes direct stride equivalence from valid texture-copy output", () => {
  const { context } = decodeContext();
  const base = {
    sourceX: 0,
    sourceY: 0,
    width: 9,
    sourceHeight: 9,
    stride: 64,
    copyState: { copyCommand: 0, pixelControl: 0 },
  };
  const canonical = plain(context.gxTextureCopyDestinationMetadata(base, 11));
  assert.deepEqual(canonical, {
    kind: "output",
    generation: 11,
    width: 9,
    height: 9,
    format: 0,
    stride: 64,
    packedStride: 64,
    directCompatible: true,
  });
  for (const [label, stride] of [
    ["zero", 0],
    ["undersized-overlap", 32],
    ["padded", 96],
  ]) {
    const metadata = plain(context.gxTextureCopyDestinationMetadata(
      { ...base, stride },
      12,
    ));
    assert.equal(metadata.kind, "output", label);
    assert.equal(metadata.stride, stride, label);
    assert.equal(metadata.packedStride, 64, label);
    assert.equal(metadata.directCompatible, false, label);
  }

  assert.deepEqual(
    plain(context.gxTextureCopyDestinationMetadata({
      ...base,
      sourceX: 636,
      sourceY: 525,
      width: 8,
      sourceHeight: 8,
      stride: 32,
      copyState: { copyCommand: 0x200, pixelControl: 0 },
    }, 13)),
    {
      kind: "output",
      generation: 13,
      width: 2,
      height: 1,
      format: 0,
      stride: 32,
      packedStride: 32,
      directCompatible: true,
    },
  );
});

test("tombstones captured noncanonical strides but retains skipped provenance and clear output", () => {
  const { context, ramRequests } = decodeContext();
  const address = 0x100;
  const canonical = {
    sourceX: 0,
    sourceY: 0,
    width: 8,
    sourceHeight: 8,
    stride: 32,
    copyState: { copyCommand: 0, pixelControl: 0 },
  };
  assert.equal(
    context.gxRecordTextureCopyGeneration(address, 7, true, canonical),
    true,
  );
  const prior = plain(context.gxTextureCopyDestinations.get(address));
  assert.equal(
    context.gxRecordTextureCopyGeneration(
      address,
      8,
      false,
      { ...canonical, stride: 64 },
    ),
    true,
  );
  assert.deepEqual(
    plain(context.gxTextureCopyDestinations.get(address)),
    prior,
  );

  assert.equal(
    context.gxRecordTextureCopyGeneration(
      address,
      9,
      true,
      { ...canonical, stride: 0 },
    ),
    true,
  );
  assert.deepEqual(plain(context.gxTextureCopyDestinations.get(address)), {
    kind: "output",
    generation: 9,
    width: 8,
    height: 8,
    format: 0,
    stride: 0,
    packedStride: 32,
    directCompatible: false,
  });
  configureTexture(context, { address, mode0: 0, mode1: 0 });
  assert.equal(context.gxDecodeTexture(0), null);
  assert.equal(context.gxTextureDecodeErrors, 1);
  assert.deepEqual(ramRequests, []);
});

test("gates skipped post-copy clears on valid output rather than direct compatibility", () => {
  assert.match(
    source,
    /const hasTextureCopyOutput = gxRecordTextureCopyGeneration\([\s\S]*?\);\s*const boundAsTexture/,
  );
  assert.match(
    source,
    /else if \(frame\.clear && hasTextureCopyOutput\) \{\s*gxSkippedCopyClears\.push\(gxCopyClearOperation\(frame\)\);/,
  );
});

test("keys base-only EFB generations and rejects copied mip levels before side effects", () => {
  const address = 0x100;
  const base = decodeContext();
  configureTexture(base.context, { address, mode0: 0, mode1: 0 });
  const chain = textureChain(base.context);
  fillLevelBytes(base.bytes, address, chain, [0x11]);
  base.context.gxTextureCopyDestinations.set(address, {
    kind: "output",
    generation: 7,
    width: 8,
    height: 8,
    format: 0,
    directCompatible: true,
  });
  const generation7 = base.context.gxDecodeTexture(0);
  assert.equal(generation7.textureCopyIndex, 7);
  base.context.gxTextureCopyDestinations.set(address, {
    kind: "output",
    generation: 8,
    width: 8,
    height: 8,
    format: 0,
    directCompatible: true,
  });
  const generation8 = base.context.gxDecodeTexture(0);
  assert.equal(generation8.textureCopyIndex, 8);
  assert.notEqual(generation8.key, generation7.key);

  for (const [label, destination] of [
    ["base", address],
    ["lower", address + 40],
  ]) {
    const rejected = decodeContext();
    configureTexture(rejected.context, { address });
    rejected.context.gxTextureCopyDestinations.set(destination, {
      kind: "output",
      generation: 19,
      width: 8,
      height: 8,
      format: 0,
      directCompatible: true,
    });
    let cacheReads = 0;
    rejected.context.gxTextureCache = {
      get() {
        cacheReads += 1;
        return undefined;
      },
      set() {
        throw new Error(`${label} mip provenance reached cache insertion`);
      },
    };
    assert.equal(rejected.context.gxDecodeTexture(0), null, label);
    assert.equal(rejected.context.gxTextureDecodeErrors, 1, label);
    assert.equal(cacheReads, 0, label);
    assert.deepEqual(rejected.ramRequests, [], label);
    assert.deepEqual(rejected.consumers, [], label);
  }
});

test("generation metadata for lower mip destinations remains diagnosable", () => {
  const address = 0x100;
  const { context } = decodeContext();
  configureTexture(context, { address });
  const mipChain = textureChain(context);
  context.gxTextureCopyDestinations.set(address + 40, {
    kind: "output",
    generation: 19,
    width: 8,
    height: 8,
    format: 0,
    directCompatible: true,
  });
  assert.deepEqual(
    plain(context.gxTextureLowerMipCopyGeneration(address, mipChain)),
    { address: address + 40, generation: 19 },
  );
});

test("recognizes sparse texture-copy destinations throughout the lower encoded span", () => {
  const { context } = decodeContext();
  const address = 0x100;
  configureTexture(context, { address });

  assert.equal(context.gxTextureCopyIsBound(address), true);
  assert.equal(context.gxTextureCopyIsBound(address + 32), true);
  assert.equal(context.gxTextureCopyIsBound(address + 40), true);
  assert.equal(context.gxTextureCopyIsBound(address + 127), true);
  assert.equal(context.gxTextureCopyIsBound(address + 128), false);
});

test("prearms a first lower-mip copy before any texture decode has registered consumers", () => {
  const { context, consumers } = decodeContext();
  const address = 0x100;
  configureTexture(context, { address });

  assert.equal(context.gxTextureDecodes, 0);
  assert.deepEqual(consumers, []);
  assert.equal(context.gxTextureCopyConsumers.size, 0);
  assert.equal(context.gxPrearmTextureCopyProducer(address + 32), true);
  assert.equal(context.gxTextureCopyProducerPreArms, 1);
  assert.equal(context.gxTextureCopyProducerLateArms, 0);
  assert.equal(context.gxCollectFrameGeometry, true);

  context.gxCollectFrameGeometry = false;
  assert.equal(context.gxPrearmTextureCopyProducer(address + 128), false);
  assert.equal(context.gxTextureCopyProducerPreArms, 1);
  assert.equal(context.gxCollectFrameGeometry, false);
});

test("diagnostics and base-only TEV flattening never retain mip pixel backing", () => {
  const { context, bytes } = decodeContext();
  const address = 0x100;
  configureTexture(context, { address });
  const chain = textureChain(context);
  fillLevelBytes(bytes, address, chain, [0x11, 0x22, 0x33, 0x44]);
  const texture = context.gxDecodeTexture(0);

  const summary = context.gxTextureSummary(texture);
  assert.equal("pixels" in summary, false);
  assert.equal("mipPixels" in summary, false);
  assert.ok(summary.mipLevels.every(level => !("pixels" in level)));
  assert.deepEqual(
    plain(summary.mipLevels.map(level => [level.level, level.width, level.height])),
    [[0, 8, 8], [1, 4, 4], [2, 2, 2], [3, 1, 1]],
  );

  const flattenedPixels = new Uint8ClampedArray(texture.pixels);
  const flattened = context.gxTextureBaseOnly(texture, flattenedPixels);
  assert.strictEqual(flattened.pixels, flattenedPixels);
  assert.notStrictEqual(flattened.pixels.buffer, texture.mipPixels.buffer);
  assert.equal(flattened.levelCount, 1);
  assert.equal(flattened.encodedBytes, 32);
  assert.equal((flattened.mode0 >>> 5) & 3, 0);
  assert.equal(flattened.mode1, 0);
  assert.equal(flattened.minFilter, 0);
  assert.equal("mipPixels" in flattened, false);
  assert.equal("mipLevels" in flattened, false);
  assert.equal("pixels" in context.gxTextureSummary(flattened), false);

  const textureCacheDefinition = source.slice(
    source.indexOf("const gxTextureCache ="),
    source.indexOf("const gxTevTextureCache =", source.indexOf("const gxTextureCache =")),
  );
  const tevCacheDefinition = source.slice(
    source.indexOf("const gxTevTextureCache ="),
    source.indexOf("// The index here", source.indexOf("const gxTevTextureCache =")),
  );
  assert.match(textureCacheDefinition, /texture => texture\.mipPixels\.byteLength/);
  assert.match(tevCacheDefinition, /texture => texture\.pixels\.byteLength/);
  assert.match(
    extractFunction("gxTextureForDraw"),
    /\.\.\.gxTextureBaseOnly\(primary\.texture, pixels\)/,
  );
});
