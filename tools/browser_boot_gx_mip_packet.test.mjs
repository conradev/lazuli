#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");
const rendererSource = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
  "utf8",
);
const rendererTevSource = readFileSync(
  new URL("../crates/browser-renderer/src/tev.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.notEqual(match, null, `missing ${name} in browser_boot.rs`);
  const start = match.index;
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

const packetFunctions = [
  "gxFramePacketInteger",
  "gxFramePacketAdd",
  "gxFramePacketMultiply",
  "gxFramePacketAlign16",
  "gxFramePacketBytes",
  "gxFramePacketEqualBytes",
  "gxFramePacketKeyBytes",
  "gxFramePacketSampler",
  "gxSourceTriangleCount",
  "gxSourceTriangleIndex",
  "gxExpandedTriangleIndices",
  "gxFramePacketPostCullEvidence",
  "packGxFramePacketV4",
  "gxFramePacketExactClipInput",
  "packGxFramePacketV5",
  "packGxFramePacketV6",
  "gxTextureMipCount",
  "gxStrictV7TexturePreflight",
  "gxFramePacketMipLayout",
  "gxFramePacketMipTexture",
  "gxFramePacketEqualMipTexture",
  "packGxFramePacketV7",
  "gxStrictV7RenderKey",
  "gxStrictV7TextureSnapshotClassification",
  "gxPrepareStrictV7Frame",
  "packGxFramePacketForRenderer",
];

function packetContext() {
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Float32Array,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RangeError,
    TextEncoder,
    TypeError,
    Uint8Array,
    Uint32Array,
  };
  vm.createContext(context);
  vm.runInContext(packetFunctions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.gx-mip-packet.js",
  });
  return context;
}

function copyState() {
  return {
    zMode: 0x010203,
    blendMode: 0x040506,
    pixelControl: 0x070809,
    copyCommand: 0x004000,
    clearRgba: [0x11, 0x22, 0x33, 0x44],
    clearDepth: 0x0a0b0c,
    copyScale: 0x0d0e0f,
    copyFilter: [0x101112, 0x131415],
  };
}

function tevState(requiredMaps = []) {
  const state = new Uint8Array(464);
  const view = new DataView(state.buffer);
  for (let stage = 0; stage < requiredMaps.length; stage += 1) {
    const offset = stage * 16;
    view.setUint32(offset, stage + 1, true);
    view.setUint32(offset + 4, stage + 2, true);
    view.setUint32(offset + 8, (1 << 6) | requiredMaps[stage], true);
    view.setUint32(offset + 12, stage, true);
  }
  view.setUint32(448, requiredMaps.length, true);
  return state;
}

function baseDraw(textures = []) {
  const requiredMaps = [];
  for (let index = 0; index < textures.length; index += 1) {
    if (textures[index] !== null && textures[index] !== undefined) {
      requiredMaps.push(index);
    }
  }
  return {
    topology: 2,
    vertexCount: 3,
    vertices: new Float32Array(3 * 36),
    tevState: tevState(requiredMaps),
    textures,
    pipeline: {
      cullMode: 0,
      scissorWidth: 4,
      scissorHeight: 4,
      viewportHalfWidthBits: 0x43a00000,
    },
  };
}

function actionDraw(textures = []) {
  return {
    ...baseDraw(textures),
    postCullEvidence: Uint8Array.of(3),
  };
}

function exactDraw(textures = [], required = false) {
  const draw = baseDraw(textures);
  draw.exactClipInput = {
    bpGenMode: 0,
    bpScissorTopLeft: (342 << 12) | 342,
    bpScissorBottomRight: ((342 + 639) << 12) | (342 + 527),
    bpScissorOffset: 171 | (171 << 10),
    xfClipDisable: 0,
    viewport: new Float32Array([320, -264, 16777215, 342, 342, 0]),
    clipPositions: new Float32Array([
      0, 0, -0.5, 1,
      2, 0, -0.5, 1,
      0, 1, -0.5, 1,
    ]),
  };
  if (required) draw.exactGeometryRequired = true;
  return draw;
}

function frameWithDraws(draws) {
  return {
    copyToXfb: true,
    index: 31,
    sourceX: 0,
    sourceY: 0,
    width: 4,
    sourceHeight: 4,
    height: 4,
    destination: 0x00110000,
    stride: 16,
    clear: false,
    copyState: copyState(),
    geometry: {
      drawCalls: draws.length,
      vertices: draws.length * 3,
      draws,
    },
  };
}

function sequence(length, seed = 0) {
  return Uint8Array.from(
    { length },
    (_unused, index) => (seed + index * 17) & 0xff,
  );
}

function npotMipTexture(overrides = {}) {
  const mipPixels = sequence(72, 3);
  return {
    key: "npot-5x3",
    address: 0x00123000,
    textureCopyIndex: 17,
    width: 5,
    height: 3,
    mode0: 0x00080051,
    mode1: 0x00002004,
    levelCount: 3,
    wrapS: 1,
    wrapT: 0,
    magFilter: 1,
    minFilter: 2,
    maxAnisotropy: 1,
    pixels: mipPixels.subarray(0, 60),
    mipPixels,
    ...overrides,
  };
}

function twoLevelTexture(overrides = {}) {
  const mipPixels = sequence(28, 0x81);
  return {
    key: "npot-3x2",
    address: 0x00124000,
    textureCopyIndex: 18,
    width: 3,
    height: 2,
    mode0: 0x00000041,
    mode1: 0x00001000,
    levelCount: 2,
    wrapS: 1,
    wrapT: 0,
    magFilter: 0,
    minFilter: 2,
    maxAnisotropy: 0,
    pixels: mipPixels.subarray(0, 24),
    mipPixels,
    ...overrides,
  };
}

function strictTexture(context, {
  key = "strict-4x4",
  mode0 = 1 << 5,
  mode1 = 0x20 << 8,
  width = 4,
  height = 4,
  format = 6,
  seed = 0x31,
  rawMode0 = mode0,
  rawMode1 = mode1,
  overrides = {},
} = {}) {
  const preflight = context.gxStrictV7TexturePreflight(
    rawMode0,
    rawMode1,
    format,
    width,
    height,
  );
  const levelCount = preflight.accepted ? preflight.levelCount : 3;
  let levelWidth = width;
  let levelHeight = height;
  let decodedBytes = 0;
  for (let level = 0; level < levelCount; level += 1) {
    decodedBytes += levelWidth * levelHeight * 4;
    levelWidth = Math.max(1, Math.floor(levelWidth / 2));
    levelHeight = Math.max(1, Math.floor(levelHeight / 2));
  }
  const mipPixels = sequence(decodedBytes, seed);
  return {
    key,
    address: 0x00125000,
    textureCopyIndex: 19,
    width,
    height,
    format,
    mode0: mode0 & 0x0039ffff,
    mode1: mode1 & 0xffff,
    levelCount,
    wrapS: mode0 & 3,
    wrapT: (mode0 >>> 2) & 3,
    magFilter: (mode0 >>> 4) & 1,
    minFilter: (mode0 >>> 5) & 7,
    maxAnisotropy: (mode0 >>> 19) & 3,
    pixels: mipPixels.subarray(0, width * height * 4),
    mipPixels,
    strictV7Preflight: preflight,
    ...overrides,
  };
}

function packetBytes(packet) {
  return Array.from(new Uint8Array(packet));
}

function align16(value) {
  return (value + 15) & ~15;
}

test("atomically rejects first or last unsafe binding without touching V6 bytes", () => {
  const context = packetContext();
  const good = strictTexture(context);
  const rejected = strictTexture(context, {
    key: "strict-rejected",
    rawMode0: (1 << 5) + 0x80000000,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rejected.strictV7Preflight)), {
    accepted: false,
    reason: "noncanonical-mode0-bits",
  });

  for (const draws of [
    [baseDraw([rejected]), baseDraw([good])],
    [baseDraw([good]), baseDraw([rejected])],
  ]) {
    const frame = frameWithDraws(draws);
    const originalTextures = draws.map(draw => draw.textures);
    const legacy = context.packGxFramePacketV6(2, frame);
    const selected = context.packGxFramePacketForRenderer(2, frame);
    assert.equal(context.gxPrepareStrictV7Frame(frame), null);
    assert.deepEqual(packetBytes(selected), packetBytes(legacy));
    assert.deepEqual(
      draws.map(draw => draw.textures),
      originalTextures,
      "the rejected frame retains every original texture array",
    );
    assert.ok(draws.flatMap(draw => draw.textures).every(texture =>
      !Object.hasOwn(texture, "renderKey")
    ));
  }
});

test("recomputes strict snapshots before accepting forged V7 preflight", () => {
  const context = packetContext();
  const canonical = strictTexture(context, { key: "forged-canonical" });
  const cases = [
    {
      name: "LOD/bias clamp",
      mode0: canonical.mode0 | (1 << 21),
    },
    {
      name: "anisotropy",
      mode0: canonical.mode0 | (1 << 19),
    },
    {
      name: "non-power-of-two mip",
      width: 3,
      pixels: canonical.pixels.subarray(0, 3 * canonical.height * 4),
    },
  ];
  for (const { name, ...changes } of cases) {
    const forged = {
      ...canonical,
      key: `forged-${name}`,
      ...changes,
      strictV7Preflight: {
        ...canonical.strictV7Preflight,
        ...changes,
        accepted: true,
        classification: "genuine-mip",
      },
    };
    assert.equal(forged.strictV7Preflight.accepted, true);
    assert.equal(
      context.gxStrictV7TextureSnapshotClassification(forged),
      null,
      `${name} bypassed canonical recomputation`,
    );
    const frame = frameWithDraws([baseDraw([forged])]);
    assert.equal(context.gxPrepareStrictV7Frame(frame), null);
    assert.deepEqual(
      packetBytes(context.packGxFramePacketForRenderer(2, frame)),
      packetBytes(context.packGxFramePacketV6(2, frame)),
      `${name} did not retain exact V6 fallback bytes`,
    );
  }
});

test("namespaces only genuine V7 chains while preflighting base companions", () => {
  const context = packetContext();
  const mip = strictTexture(context, { key: "mip:key" });
  const companion = strictTexture(context, {
    key: "base:key:with:separators",
    mode0: 0,
    mode1: 0x20 << 8,
    seed: 0x71,
  });
  assert.equal(mip.strictV7Preflight.classification, "genuine-mip");
  assert.equal(
    companion.strictV7Preflight.classification,
    "base-only-companion",
  );
  const frame = frameWithDraws([baseDraw([mip, companion])]);
  const prepared = context.gxPrepareStrictV7Frame(frame);
  assert.notEqual(prepared, null);
  const [preparedMip, preparedCompanion] =
    prepared.geometry.draws[0].textures;
  assert.equal(
    preparedMip.renderKey,
    `${mip.key}~LZGX7:${mip.key.length}`,
  );
  assert.equal("renderKey" in preparedCompanion, false);
  assert.strictEqual(preparedCompanion, companion);
  assert.notEqual(preparedMip.renderKey, companion.key);
  assert.equal("renderKey" in mip, false);
  assert.equal("renderKey" in companion, false);
  assert.notStrictEqual(prepared, frame);
  assert.notStrictEqual(prepared.geometry, frame.geometry);
  assert.notStrictEqual(prepared.geometry.draws[0], frame.geometry.draws[0]);

  const packet = context.packGxFramePacketForRenderer(2, frame);
  assert.equal(new DataView(packet).getUint16(0x04, true), 7);
  assert.equal(
    context.gxStrictV7RenderKey("left:2:right"),
    "left:2:right~LZGX7:12",
  );
  assert.notEqual(
    context.gxStrictV7RenderKey("1:a:b"),
    context.gxStrictV7RenderKey("3:a:b"),
  );
  assert.equal(
    context.gxStrictV7RenderKey("old~LZGX7:3"),
    null,
    "an already-namespaced legacy key cannot alias this generation",
  );
});

test("activates V7 and preserves F-Zero's exact 4x sampler word", () => {
  const context = packetContext();
  const mode0 = 0x0011c0d8;
  const mode1 = 0x5000;
  const texture = strictTexture(context, {
    key: "fzero-anisotropic-city",
    mode0,
    mode1,
    width: 64,
    height: 64,
  });
  assert.equal(texture.strictV7Preflight.accepted, true);
  assert.equal(texture.strictV7Preflight.classification, "genuine-mip");
  assert.equal(texture.strictV7Preflight.maxAnisotropy, 4);

  const packet = context.packGxFramePacketForRenderer(
    2,
    frameWithDraws([baseDraw([texture])]),
  );
  const view = new DataView(packet);
  const drawOffset = view.getUint32(0x1c, true);
  assert.equal(view.getUint16(0x04, true), 7);
  assert.equal(view.getUint32(drawOffset + 0x34, true), mode0);
  assert.equal(view.getUint32(packet.byteLength - 32, true), mode1);
});

test("activates V7 and preserves Rogue Leader's exact diagonal sampler word", () => {
  const context = packetContext();
  const mode0 = 0x0011c1d0;
  const mode1 = 0x5000;
  const texture = strictTexture(context, {
    key: "rogue-diagonal-lod",
    mode0,
    mode1,
    width: 64,
    height: 64,
  });
  assert.equal(texture.strictV7Preflight.accepted, true);
  assert.equal(texture.strictV7Preflight.classification, "genuine-mip");
  assert.equal(texture.strictV7Preflight.diagonalLod, true);
  assert.equal(texture.strictV7Preflight.maxAnisotropy, 4);

  const packet = context.packGxFramePacketForRenderer(
    2,
    frameWithDraws([baseDraw([texture])]),
  );
  const view = new DataView(packet);
  const drawOffset = view.getUint32(0x1c, true);
  assert.equal(view.getUint16(0x04, true), 7);
  assert.equal(view.getUint32(drawOffset + 0x34, true), mode0);
  assert.equal(view.getUint32(packet.byteLength - 32, true), mode1);
});

test("reuses V6 residency for accepted base-only companions inside V7", () => {
  const context = packetContext();
  const mip = strictTexture(context, { key: "mip-resident" });
  const companion = strictTexture(context, {
    key: "base-resident",
    mode0: 0,
    mode1: 0,
    seed: 0x61,
  });
  const companionFrame = frameWithDraws([baseDraw([companion])]);
  assert.equal(
    new DataView(
      context.packGxFramePacketForRenderer(2, companionFrame),
    ).getUint32(0x48, true),
    64,
  );
  assert.equal(
    new DataView(
      context.packGxFramePacketForRenderer(
        2,
        companionFrame,
        new Set([companion.key]),
      ),
    ).getUint32(0x48, true),
    0,
    "the legacy key acknowledges the base-only V6 resource",
  );

  const frame = frameWithDraws([baseDraw([mip, companion])]);
  const prepared = context.gxPrepareStrictV7Frame(frame);
  const mipKey = prepared.geometry.draws[0].textures[0].renderKey;
  const companionKey = prepared.geometry.draws[0].textures[1].key;
  assert.equal(companionKey, companion.key);
  assert.equal("renderKey" in prepared.geometry.draws[0].textures[1], false);

  const companionResident = context.packGxFramePacketForRenderer(
    2,
    frame,
    new Set([companion.key]),
  );
  const companionResidentView = new DataView(companionResident);
  const textureOffset = companionResidentView.getUint32(0x20, true);
  assert.equal(companionResidentView.getUint16(0x04, true), 7);
  assert.equal(companionResidentView.getUint32(0x48, true), 96);
  assert.equal(companionResidentView.getUint32(textureOffset + 0x0c, true), 84);
  assert.equal(
    companionResidentView.getUint32(textureOffset + 64 + 0x0c, true),
    0,
  );

  const mipResident = context.packGxFramePacketForRenderer(
    2,
    frame,
    new Set([mipKey]),
  );
  const mipResidentView = new DataView(mipResident);
  assert.equal(mipResidentView.getUint32(0x48, true), 64);
  assert.equal(mipResidentView.getUint32(textureOffset + 0x0c, true), 0);
  assert.equal(
    mipResidentView.getUint32(textureOffset + 64 + 0x0c, true),
    64,
    "the base companion retains its legacy payload and key",
  );
});

test("checks duplicate image snapshots per draw and retains their sampler words", () => {
  const context = packetContext();
  const first = strictTexture(context, { key: "shared-image" });
  const secondMode0 = (1 << 5) | 1;
  const second = strictTexture(context, {
    key: first.key,
    mode0: secondMode0,
  });
  const frame = frameWithDraws([baseDraw([first]), baseDraw([second])]);
  const packet = context.packGxFramePacketForRenderer(2, frame);
  const view = new DataView(packet);
  const drawOffset = view.getUint32(0x1c, true);
  assert.equal(view.getUint16(0x04, true), 7);
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(drawOffset + 0x34, true), first.mode0);
  assert.equal(view.getUint32(drawOffset + 176 + 0x34, true), second.mode0);

  const rejectedDuplicate = strictTexture(context, {
    key: first.key,
    rawMode0: (1 << 5) + 0x80000000,
  });
  const rejectedFrame = frameWithDraws([
    baseDraw([first]),
    baseDraw([rejectedDuplicate]),
  ]);
  assert.equal(context.gxPrepareStrictV7Frame(rejectedFrame), null);
  assert.deepEqual(
    packetBytes(context.packGxFramePacketForRenderer(2, rejectedFrame)),
    packetBytes(context.packGxFramePacketV6(2, rejectedFrame)),
  );
});

test("keeps no-mip frames byte-identical to the canonical legacy packet", () => {
  const context = packetContext();
  const namespace = context.gxStrictV7RenderKey;
  let namespaceCalls = 0;
  context.gxStrictV7RenderKey = key => {
    namespaceCalls += 1;
    return namespace(key);
  };
  const companion = strictTexture(context, {
    key: "base-only",
    mode0: 0,
    mode1: 0xff << 8,
  });
  const frame = frameWithDraws([exactDraw([companion], true)]);
  assert.equal(context.gxPrepareStrictV7Frame(frame), null);
  const legacy = context.packGxFramePacketV6(2, frame);
  const selected = context.packGxFramePacketForRenderer(2, frame);
  assert.equal(new DataView(selected).getUint16(0x04, true), 6);
  assert.deepEqual(packetBytes(selected), packetBytes(legacy));
  assert.equal(
    namespaceCalls,
    0,
    "legacy/no-mip frames never enter namespace allocation",
  );

  const prepare = extractFunction("gxPrepareStrictV7Frame");
  const legacyReturn = prepare.indexOf("if (!hasGenuineMip) return null;");
  const clonePass = prepare.indexOf("const draws = new Array(");
  assert.ok(legacyReturn >= 0 && clonePass > legacyReturn);
  assert.doesNotMatch(
    prepare.slice(0, legacyReturn),
    /gxStrictV7RenderKey\(|new Array\(|\.slice\(\)|\{\s*\.\.\./,
    "the validation pass allocates no frame, draw, texture, or namespace clone",
  );
});

test("keeps V6 and V7 residency transitions in disjoint cache namespaces", () => {
  const context = packetContext();
  const sharedKey = "layout-transition";
  const companion = strictTexture(context, {
    key: sharedKey,
    mode0: 0,
    mode1: 0,
  });
  const mip = strictTexture(context, { key: sharedKey });
  const v6Frame = frameWithDraws([baseDraw([companion])]);
  const v7Frame = frameWithDraws([baseDraw([mip])]);
  const v7Key = context.gxStrictV7RenderKey(sharedKey);

  const initialV6 = context.packGxFramePacketForRenderer(2, v6Frame);
  assert.notEqual(new DataView(initialV6).getUint16(0x04, true), 7);
  assert.equal(new DataView(initialV6).getUint32(0x48, true), 64);

  const v7AfterV6Ack = context.packGxFramePacketForRenderer(
    2,
    v7Frame,
    new Set([sharedKey]),
  );
  assert.equal(new DataView(v7AfterV6Ack).getUint16(0x04, true), 7);
  assert.equal(
    new DataView(v7AfterV6Ack).getUint32(0x48, true),
    96,
    "a V6 acknowledgement cannot suppress a V7 mip payload",
  );

  const residentV7 = context.packGxFramePacketForRenderer(
    2,
    v7Frame,
    new Set([v7Key]),
  );
  assert.equal(new DataView(residentV7).getUint16(0x04, true), 7);
  assert.equal(new DataView(residentV7).getUint32(0x48, true), 0);

  const v6AfterV7Ack = context.packGxFramePacketForRenderer(
    2,
    v6Frame,
    new Set([v7Key]),
  );
  assert.equal(new DataView(v6AfterV7Ack).getUint32(0x48, true), 64);
  assert.deepEqual(packetBytes(v6AfterV7Ack), packetBytes(initialV6));
});

test("avoids global domain starvation across V6-to-V7-to-V6 cache pressure", () => {
  const capacityMatch = rendererSource.match(
    /const DECODED_TEXTURE_CACHE_CAPACITY: usize = (\d+);/,
  );
  assert.notEqual(capacityMatch, null);
  const capacity = Number(capacityMatch[1]);
  assert.equal(capacity, 128);
  assert.match(
    rendererSource,
    /self\.texture_cache\.len\(\) >= DECODED_TEXTURE_CACHE_CAPACITY[\s\S]*?\.filter\(\|key\| \{[\s\S]*?!protected_keys\.contains\(key\.as_str\(\)\)[\s\S]*?packet_protected_keys[\s\S]*?\.min\(\)[\s\S]*?self\.texture_cache\.remove\(&key\);/,
    "uploads evict the lexicographic minimum outside current draw and packet keys",
  );
  assert.match(
    rendererSource,
    /while self\.texture_cache\.len\(\) > DECODED_TEXTURE_CACHE_CAPACITY \{[\s\S]*?self\.texture_cache\.keys\(\)\.min\(\)[\s\S]*?self\.texture_cache\.remove\(&key\);/,
    "post-frame overflow cleanup removes the global lexicographic minimum",
  );
  assert.match(
    source,
    /const key = \[\s*textureMap,[\s\S]*?\]\.join\(":"\);/,
    "live legacy decoded-image identities begin with a numeric texture-map index",
  );

  const context = packetContext();
  const legacyKey = ordinal =>
    `0:${ordinal}:4:4:6:1:${ordinal}:0:0:0:ram`;
  const lowLegacy = legacyKey(1000);
  const highLegacy = legacyKey(2000);
  const lowV7 = context.gxStrictV7RenderKey(lowLegacy);
  const highV7 = context.gxStrictV7RenderKey(highLegacy);
  assert.ok(lowLegacy < lowV7);
  assert.ok(lowV7 < highLegacy);
  assert.ok(highLegacy < highV7);

  const transition = (staleKey, incomingKey) => {
    // Mirrors push_tev_draw_inner plus submit_gx_frame's final overflow trim.
    const cache = new Set(
      Array.from({ length: capacity }, (_unused, index) =>
        staleKey(1000 + index)
      ),
    );
    const incoming = [];
    const submitFrame = packetKeys => {
      const packetProtected = new Set(packetKeys);
      for (const key of packetKeys) {
        if (cache.has(key)) continue;
        if (cache.size >= capacity) {
          const candidate = [...cache]
            .filter(cached => !packetProtected.has(cached))
            .sort()[0];
          if (candidate !== undefined) cache.delete(candidate);
        }
        cache.add(key);
      }
      while (cache.size > capacity) {
        cache.delete([...cache].sort()[0]);
      }
      return [...cache].sort();
    };
    for (let frame = 0; frame < 32; frame += 1) {
      const key = incomingKey(2000 + frame);
      incoming.push(key);
      const resident = submitFrame([key]);
      assert.equal(resident.length, capacity);
      assert.ok(
        incoming.every(previous => resident.includes(previous)),
        `varying identity ${frame + 1} remains resident on later frames`,
      );
    }
    return { cache, incoming };
  };

  const v6ToV7 = transition(
    legacyKey,
    ordinal => context.gxStrictV7RenderKey(legacyKey(ordinal)),
  );
  assert.equal(
    [...v6ToV7.cache].filter(key => key.includes("~LZGX7:")).length,
    32,
    "V7 identities accumulate instead of churning behind stale V6",
  );
  const v7ToV6 = transition(
    ordinal => context.gxStrictV7RenderKey(legacyKey(ordinal)),
    legacyKey,
  );
  assert.equal(
    [...v7ToV6.cache].filter(key => !key.includes("~LZGX7:")).length,
    32,
    "fallback V6 identities accumulate instead of churning behind stale V7",
  );
  assert.ok(
    v6ToV7.incoming.every(key => v6ToV7.cache.has(key))
      && v7ToV6.incoming.every(key => v7ToV6.cache.has(key)),
    "both varying 32-entry domains remain acknowledged after 160 identities",
  );
});

test("treats an eligible non-V7 result as fatal without a legacy retry", () => {
  const context = packetContext();
  const frame = frameWithDraws([baseDraw([strictTexture(context)])]);
  let legacyCalls = 0;
  let v7Calls = 0;
  context.packGxFramePacketV6 = () => {
    legacyCalls += 1;
    return new ArrayBuffer(160);
  };
  context.packGxFramePacketV7 = () => {
    v7Calls += 1;
    const packet = new ArrayBuffer(160);
    new DataView(packet).setUint16(0x04, 6, true);
    return packet;
  };

  assert.throws(
    () => context.packGxFramePacketForRenderer(2, frame),
    /strict GX mip activation did not produce LZGX v7/,
  );
  assert.equal(v7Calls, 1);
  assert.equal(legacyCalls, 0);
});

test("packs an NPOT decoded mip chain without per-level padding", () => {
  const context = packetContext();
  const texture = npotMipTexture();
  const frame = frameWithDraws([baseDraw([texture])]);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  const drawOffset = view.getUint32(0x1c, true);
  const textureOffset = view.getUint32(0x20, true);
  const pixelOffset = view.getUint32(0x30, true);
  const mode1Offset = packet.byteLength - 32;

  assert.equal(view.getUint16(0x04, true), 7);
  assert.equal(view.getUint16(0x06, true), 160);
  assert.equal(view.getUint16(0x78, true), 176);
  assert.equal(view.getUint16(0x7a, true), 64);
  assert.equal(view.getUint32(textureOffset + 0x0c, true), 72);
  assert.equal(view.getUint32(textureOffset + 0x18, true), 5);
  assert.equal(view.getUint32(textureOffset + 0x1c, true), 3);
  assert.equal(view.getUint32(textureOffset + 0x20, true), 1);
  assert.equal(view.getUint32(textureOffset + 0x24, true), 3);
  assert.equal(view.getUint32(0x48, true), 80);
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset, pixelOffset + 72)),
    Array.from(texture.mipPixels),
  );
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset + 72, pixelOffset + 80)),
    Array(8).fill(0),
  );
  assert.equal(view.getUint32(drawOffset + 0x34, true), texture.mode0);
  assert.equal(view.getUint32(mode1Offset, true), texture.mode1);
  for (let textureMap = 1; textureMap < 8; textureMap += 1) {
    assert.equal(
      view.getUint32(drawOffset + 0x34 + textureMap * 8, true),
      0,
    );
    assert.equal(view.getUint32(mode1Offset + textureMap * 4, true), 0);
  }
});

test("aligns complete texture chains but never their individual mip levels", () => {
  const context = packetContext();
  const first = npotMipTexture();
  const second = twoLevelTexture();
  const frame = frameWithDraws([baseDraw([first, second])]);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const bytes = new Uint8Array(packet);
  const textureOffset = view.getUint32(0x20, true);
  const pixelOffset = view.getUint32(0x30, true);
  assert.equal(view.getUint32(textureOffset + 0x08, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x0c, true), 72);
  assert.equal(view.getUint32(textureOffset + 64 + 0x08, true), 80);
  assert.equal(view.getUint32(textureOffset + 64 + 0x0c, true), 28);
  assert.equal(view.getUint32(0x48, true), 112);
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset, pixelOffset + 72)),
    Array.from(first.mipPixels),
  );
  assert.deepEqual(
    Array.from(bytes.subarray(pixelOffset + 80, pixelOffset + 108)),
    Array.from(second.mipPixels),
  );
});

test("orders post-cull evidence, exact chunks, then the fixed MODE1 tail", () => {
  const context = packetContext();
  const texture = npotMipTexture();
  const raw = baseDraw([texture]);
  const action = actionDraw();
  const optional = exactDraw();
  const required = exactDraw([], true);
  required.exactClipInput.clipPositions[0] = 7;
  const frame = frameWithDraws([raw, action, optional, required]);
  const legacy = context.packGxFramePacketV6(2, frame);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const legacyView = new DataView(legacy);
  const bytes = new Uint8Array(packet);
  const drawOffset = view.getUint32(0x1c, true);
  const pixelOffset = view.getUint32(0x30, true);
  const evidenceOffset = pixelOffset + view.getUint32(0x48, true);
  const exactOffset = align16(evidenceOffset + 1);
  const legacyEvidenceOffset =
    legacyView.getUint32(0x30, true) + legacyView.getUint32(0x48, true);
  const legacyExactOffset = align16(legacyEvidenceOffset + 1);
  const exactBytes = legacy.byteLength - legacyExactOffset;
  const mode1Offset = exactOffset + exactBytes;

  assert.deepEqual(
    [0, 1, 2, 3].map(index =>
      view.getUint16(drawOffset + index * 176 + 0x02, true)
    ),
    [0, 1, 2, 6],
  );
  assert.equal(bytes[evidenceOffset], 3);
  assert.deepEqual(
    Array.from(bytes.subarray(exactOffset, mode1Offset)),
    Array.from(new Uint8Array(legacy).subarray(legacyExactOffset)),
  );
  assert.equal(view.getFloat32(exactOffset + 0x30, true), 0);
  assert.equal(view.getFloat32(exactOffset + 96 + 0x30, true), 7);
  assert.equal(view.getUint32(mode1Offset, true), texture.mode1);
  assert.equal(mode1Offset + 4 * 32, packet.byteLength);
});

test("suppresses only the full payload for an acknowledged resident mip texture", () => {
  const context = packetContext();
  const texture = npotMipTexture();
  const frame = frameWithDraws([baseDraw([texture])]);
  const packet = context.packGxFramePacketV7(2, frame, new Set([texture.key]));
  const view = new DataView(packet);
  const textureOffset = view.getUint32(0x20, true);
  assert.equal(view.getUint16(0x04, true), 7);
  assert.equal(view.getUint32(0x48, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x08, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x0c, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x18, true), 5);
  assert.equal(view.getUint32(textureOffset + 0x1c, true), 3);
  assert.equal(view.getUint32(textureOffset + 0x20, true), 0);
  assert.equal(view.getUint32(textureOffset + 0x24, true), 3);
});

test("keeps MODE0 and MODE1 per draw while requiring one payload per key", () => {
  const context = packetContext();
  const first = npotMipTexture();
  const second = npotMipTexture({
    mode0: first.mode0 | 2,
    mode1: first.mode1 | 7,
    wrapS: 3,
  });
  const frame = frameWithDraws([baseDraw([first]), baseDraw([second])]);
  const packet = context.packGxFramePacketV7(2, frame);
  const view = new DataView(packet);
  const drawOffset = view.getUint32(0x1c, true);
  const mode1Offset = packet.byteLength - 64;
  assert.equal(view.getUint32(0x18, true), 1);
  assert.equal(view.getUint32(drawOffset + 0x34, true), first.mode0);
  assert.equal(view.getUint32(drawOffset + 176 + 0x34, true), second.mode0);
  assert.equal(view.getUint32(mode1Offset, true), first.mode1);
  assert.equal(view.getUint32(mode1Offset + 32, true), second.mode1);
});

test("returns exact canonical v4, v5, and v6 bytes without a derived mip chain", () => {
  const context = packetContext();
  const cases = [
    [frameWithDraws([actionDraw()]), "packGxFramePacketV4", 4],
    [frameWithDraws([exactDraw()]), "packGxFramePacketV5", 5],
    [frameWithDraws([exactDraw([], true)]), "packGxFramePacketV6", 6],
  ];
  for (const [frame, legacyPacker, version] of cases) {
    const expected = context[legacyPacker](2, frame);
    const actual = context.packGxFramePacketV7(2, frame);
    assert.equal(new DataView(actual).getUint16(0x04, true), version);
    assert.deepEqual(packetBytes(actual), packetBytes(expected));
  }

  const inert = npotMipTexture({
    mode1: 0,
    levelCount: 1,
    mipPixels: undefined,
  });
  const inertFrame = frameWithDraws([baseDraw([inert])]);
  assert.deepEqual(
    packetBytes(context.packGxFramePacketV7(2, inertFrame)),
    packetBytes(context.packGxFramePacketV6(2, inertFrame)),
  );
});

test("rejects noncanonical state, mismatched counts, and malformed mip payloads", () => {
  const context = packetContext();
  const reject = (texture, pattern, resident = null) => {
    const frame = frameWithDraws([baseDraw([texture])]);
    assert.throws(
      () => context.packGxFramePacketV7(2, frame, resident),
      pattern,
    );
  };
  reject(
    npotMipTexture({ mode0: 0x000c0051 }),
    /mode0 has noncanonical bits/,
  );
  reject(
    npotMipTexture({ mode1: 0x00012004 }),
    /mode1 has noncanonical bits/,
  );
  reject(
    npotMipTexture({ mode0: (3 << 5) | 1 }),
    /reserved mip mode 3/,
  );
  reject(
    npotMipTexture({ levelCount: 2 }),
    /conflicts with derived count 3/,
  );
  reject(
    npotMipTexture({ levelCount: undefined }),
    /must declare the derived mip count/,
  );
  reject(
    npotMipTexture({ mipPixels: undefined }),
    /mipPixels is required/,
  );
  reject(
    npotMipTexture({ mipPixels: sequence(68) }),
    /must contain 72 decoded mip bytes/,
  );
  reject(
    npotMipTexture({ pixels: sequence(60, 0xfe) }),
    /pixels conflicts with the mipPixels prefix/,
  );
  reject(
    npotMipTexture({ mipPixels: undefined }),
    /mipPixels is required/,
    new Set(["npot-5x3"]),
  );
});

test("rejects conflicting mip count or lower bytes for one first-use key", () => {
  const context = packetContext();
  const first = npotMipTexture();
  const conflictingPixels = Uint8Array.from(first.mipPixels);
  conflictingPixels[71] ^= 0xff;
  const second = npotMipTexture({ mipPixels: conflictingPixels });
  const pixelConflict = frameWithDraws([baseDraw([first]), baseDraw([second])]);
  assert.throws(
    () => context.packGxFramePacketV7(2, pixelConflict),
    /texture key "npot-5x3" has conflicting mip contents/,
  );

  const shorterPixels = first.mipPixels.subarray(0, 68);
  const shorter = npotMipTexture({
    mode1: 0x00001004,
    levelCount: 2,
    mipPixels: shorterPixels,
  });
  const countConflict = frameWithDraws([baseDraw([first]), baseDraw([shorter])]);
  assert.throws(
    () => context.packGxFramePacketV7(2, countConflict),
    /texture key "npot-5x3" has conflicting mip contents/,
  );
});

test("routes live GX emission through one strict atomic V7 selector", () => {
  const postStart = source.indexOf("function postGxFrame(");
  const postEnd = source.indexOf("function gxFramePacketInteger(", postStart);
  assert.notEqual(postStart, -1);
  assert.notEqual(postEnd, -1);
  const postSource = source.slice(postStart, postEnd);
  assert.match(postSource, /packet = packGxFramePacketForRenderer\(/);
  assert.doesNotMatch(postSource, /packGxFramePacketV[67]/);

  const selector = extractFunction("packGxFramePacketForRenderer");
  assert.match(selector, /gxPrepareStrictV7Frame\(frame\)/);
  assert.match(selector, /return packGxFramePacketV6\(/);
  assert.match(selector, /const packet = packGxFramePacketV7\(/);
  assert.match(selector, /getUint16\(0x04, true\) !== 7/);
  assert.doesNotMatch(selector, /\bcatch\b/);
});

test("carries canonical v7 mip resources into strict WebGPU uploads", () => {
  const submitStart = rendererSource.indexOf("pub fn submit_gx_frame(");
  const submitEnd = rendererSource.indexOf(
    "pub fn copy_texture(",
    submitStart,
  );
  assert.notEqual(submitStart, -1);
  assert.notEqual(submitEnd, -1);
  const submitSource = rendererSource.slice(submitStart, submitEnd);
  const parseOffset = submitSource.indexOf("GxFramePacket::parse(");
  const rendererMutationOffset = submitSource.indexOf("self.begin_segment_inner()");
  assert.ok(parseOffset >= 0);
  assert.ok(rendererMutationOffset > parseOffset);
  assert.doesNotMatch(
    submitSource,
    /LZGX mip transport requires WebGPU mip upload support/,
  );
  assert.match(
    submitSource,
    /mip_level_count: texture\.record\.mip_level_count/,
  );
  assert.match(
    submitSource,
    /cached\.width, cached\.height, cached\.mip_level_count/,
  );
  assert.match(
    submitSource,
    /selected\[map\] != SelectedTexture::Decoded[\s\S]*self\.texture_cache\.contains_key\(textures\[map\]\.key\)[\s\S]*continue;/,
  );
  assert.match(
    submitSource,
    /resident\.push\(&JsValue::from_str\(key\)\)/,
  );

  const uploadStart = rendererSource.lastIndexOf("\nfn upload_texture(");
  const uploadEnd = rendererSource.indexOf("\nimpl Pipelines", uploadStart);
  assert.ok(uploadStart >= 0);
  assert.ok(uploadEnd > uploadStart);
  const uploadSource = rendererSource.slice(uploadStart, uploadEnd);
  assert.match(
    uploadSource,
    /let uploads = rgba8_mip_uploads\(width, height, mip_level_count, pixels\.len\(\)\)\?/,
  );
  assert.match(uploadSource, /mip_level_count,/);
  assert.match(uploadSource, /for upload in uploads/);
  assert.match(uploadSource, /mip_level: upload\.mip_level/);
  assert.match(
    uploadSource,
    /&pixels\[upload\.offset\.\.upload\.offset \+ upload\.byte_len\]/,
  );
  assert.match(
    uploadSource,
    /width: upload\.width,[\s\S]*height: upload\.height/,
  );
  assert.match(
    rendererSource,
    /mipmap_filter: match identity\.mipmap_filter \{[\s\S]*TextureMipmapFilter::Nearest => wgpu::MipmapFilterMode::Nearest,[\s\S]*TextureMipmapFilter::Linear => wgpu::MipmapFilterMode::Linear,[\s\S]*lod_min_clamp: f32::from\(identity\.lod_min_sixteenths\) \/ 16\.0,[\s\S]*lod_max_clamp: f32::from\(identity\.lod_max_sixteenths\) \/ 16\.0/,
  );
  assert.match(
    rendererTevSource,
    /textureLoad\(texture, coord, i32\(mip_level\)\)/,
  );
  assert.match(
    rendererSource,
    /metrics\.texture_writes = metrics[\s\S]*saturating_add\(u64::from\(mip_level_count\)\)/,
  );
  assert.match(
    rendererSource,
    /metrics\.texture_upload_bytes = metrics[\s\S]*saturating_add\(pixels\.len\(\) as u64\)/,
  );
});
