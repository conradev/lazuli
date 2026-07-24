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

function workerContext() {
  const gxXfRegisters = new Uint32Array(0x1100);
  const context = {
    Array,
    ArrayBuffer,
    DataView,
    Math,
    Number,
    Uint32Array,
    gxFifoScratch: new DataView(new ArrayBuffer(4)),
    gxXfRegisters,
  };
  vm.createContext(context);
  vm.runInContext([
    "gxXfFloat",
    "gxTransformPosition",
    "gxCullF32",
    "gxCullMul",
    "gxCullDiv",
    "gxCullAdd",
    "gxCullSub",
    "gxTransformNormalVector",
    "gxTransformNormal",
    "gxXfColorU8",
    "gxXfLight",
    "gxDot3",
    "gxVectorSubtract",
    "gxLightNormalize3",
    "gxLightMaxZero",
    "gxLightSafeDivide",
    "gxLightDiffuse",
    "gxLightSpotCosPolynomial",
    "gxLightSpotDistancePolynomial",
    "gxLightPosition",
    "gxChannelLightEnabled",
    "gxLightChannelComponent",
    "gxLightRasterChannels",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.xf-lighting.js",
  });
  return context;
}

function setXfFloat(context, address, value) {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, false);
  context.gxXfRegisters[address] = scratch.getUint32(0, false);
}

function setLight(context, index, {
  color,
  cosAtten = [0, 0, 0],
  distAtten = [0, 0, 0],
  position,
  direction = [0, 0, 0],
}) {
  const base = 0x603 + index * 0x10;
  context.gxXfRegisters[base] = color >>> 0;
  for (let component = 0; component < 3; component += 1) {
    setXfFloat(context, base + 1 + component, cosAtten[component]);
    setXfFloat(context, base + 4 + component, distAtten[component]);
    setXfFloat(context, base + 7 + component, position[component]);
    setXfFloat(context, base + 10 + component, direction[component]);
  }
}

function assertVector(actual, expected, epsilon = 1e-7) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `component ${index}: expected ${expected[index]}, got ${actual[index]}`,
    );
  }
}

function f32Bits(value) {
  const scratch = new DataView(new ArrayBuffer(4));
  scratch.setFloat32(0, value, false);
  return scratch.getUint32(0, false);
}

test("decodes XF colors as raw RRGGBBAA bytes", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100a] = 0x12345678;

  assert.deepEqual(
    Array.from(context.gxXfColorU8(0x100a)),
    [0x12, 0x34, 0x56, 0x78],
  );
});

test("rounds live lighting position and normal transforms at every f32 operation", () => {
  const context = workerContext();
  const onePlusTwoNeg23 = Math.fround(1 + 2 ** -23);
  const oneMinusTwoNeg23 = Math.fround(1 - 2 ** -23);
  [
    onePlusTwoNeg23, -1, 0, 0,
    16777218, 1, -16777216, 0,
    0, 0, 1, 0,
  ].forEach((value, index) => setXfFloat(context, index, value));
  [
    onePlusTwoNeg23, -1, 0,
    0, 1, 0,
    0, 0, 1,
  ].forEach((value, index) => setXfFloat(context, 0x400 + index, value));

  const vector = [oneMinusTwoNeg23, 1, 1];
  const position = context.gxTransformPosition(vector, 0);
  const normal = context.gxTransformNormal(vector, 0);
  assert.equal(f32Bits(position[0]), 0);
  assert.equal(f32Bits(normal[0]), 0);

  const finalOnlyX = Math.fround(
    onePlusTwoNeg23 * oneMinusTwoNeg23 - 1
  );
  const finalOnlyLength = Math.fround(Math.sqrt(Math.fround(
    Math.fround(finalOnlyX * finalOnlyX) + 2
  )));
  const finalOnlyNormalX = Math.fround(finalOnlyX / finalOnlyLength);
  assert.equal(f32Bits(finalOnlyX), 0xa8800000);
  assert.notEqual(f32Bits(finalOnlyNormalX), f32Bits(normal[0]));
});

test("keeps every unlit byte canonical through the normalized f32 ABI", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100e] = 1;
  context.gxXfRegisters[0x1010] = 1;

  for (let value = 0; value <= 255; value += 1) {
    const channels = context.gxLightRasterChannels(
      null,
      null,
      [[value, value, value, value], [0, 0, 0, 0]],
    );
    assert.notEqual(channels, null);
    for (const component of channels[0]) {
      assert.equal(component, Math.fround(value / 255));
    }
  }
});

test("selects no-light RGB and alpha material sources independently", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100c] = 0x20406080;
  context.gxXfRegisters[0x100e] = 1;
  context.gxXfRegisters[0x1010] = 0;

  let channels = context.gxLightRasterChannels(
    [0, 0, 0],
    [0, 0, 1],
    [[255, 128, 64, 32], [0, 0, 0, 0]],
  );
  assertVector(channels[0], [1, 128 / 255, 64 / 255, 128 / 255]);

  context.gxXfRegisters[0x100e] = 0;
  context.gxXfRegisters[0x1010] = 1;
  channels = context.gxLightRasterChannels(
    [0, 0, 0],
    [0, 0, 1],
    [[255, 128, 64, 32], [0, 0, 0, 0]],
  );
  assertVector(channels[0], [32 / 255, 64 / 255, 96 / 255, 32 / 255]);
});

test("adds ambient and masked diffuse light with GX clamping", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100a] = 0x40404040;
  context.gxXfRegisters[0x100c] = 0xffffffff;
  setLight(context, 0, { color: 0x80808080, position: [0, 0, 3] });

  const diffuseClampedWithLight0 = 2 | (1 << 2) | (2 << 7);
  context.gxXfRegisters[0x100e] = diffuseClampedWithLight0;
  context.gxXfRegisters[0x1010] = diffuseClampedWithLight0;

  const lit = context.gxLightRasterChannels(
    [0, 0, 1],
    [0, 0, 1],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(lit[0], Array(4).fill(192 / 255));

  const backFacing = context.gxLightRasterChannels(
    [0, 0, 4],
    [0, 0, 1],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(backFacing[0], Array(4).fill(63 / 255));

  context.gxXfRegisters[0x100e] = 2 | (2 << 7);
  context.gxXfRegisters[0x1010] = 2 | (2 << 7);
  const masked = context.gxLightRasterChannels(
    [0, 0, 1],
    [0, 0, 1],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(masked[0], Array(4).fill(63 / 255));

  context.gxXfRegisters[0x100a] = 0xc8c8c8c8;
  context.gxXfRegisters[0x100e] = diffuseClampedWithLight0;
  context.gxXfRegisters[0x1010] = diffuseClampedWithLight0;
  const saturated = context.gxLightRasterChannels(
    [0, 0, 1],
    [0, 0, 1],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(saturated[0], [1, 1, 1, 1]);
});

test("truncates f32 light accumulation before GX integer material modulation", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100a] = 0x40404040;
  context.gxXfRegisters[0x100c] = 0xffffffff;
  setLight(context, 0, { color: 0x01010101, position: [3, 4, 0] });

  const diffuseSignedWithLight0 = 2 | (1 << 2) | (1 << 7);
  context.gxXfRegisters[0x100e] = diffuseSignedWithLight0;
  context.gxXfRegisters[0x1010] = diffuseSignedWithLight0;
  const channels = context.gxLightRasterChannels(
    [0, 0, 0],
    [1, 0, 0],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );

  // 64 + 1 * 0.6 truncates to 64. GX then uses 64 / 256 for
  // a sub-128 light value, so a full material byte becomes 63.
  assertVector(channels[0], Array(4).fill(63 / 255));
});

test("uses GX's 255/256 material modulation boundary correction", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100c] = 0x03ffffff;
  context.gxXfRegisters[0x100a] = 0x557f8080;
  context.gxXfRegisters[0x100e] = 2;
  context.gxXfRegisters[0x1010] = 2;

  const channels = context.gxLightRasterChannels(
    null,
    null,
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(channels[0], [0, 126 / 255, 128 / 255, 128 / 255]);
});

test("keeps the m=3, light=85 normalized-domain counterexample at zero", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100c] = 0x03030303;
  context.gxXfRegisters[0x100a] = 0x55555555;
  context.gxXfRegisters[0x100e] = 2;
  context.gxXfRegisters[0x1010] = 2;

  const channels = context.gxLightRasterChannels(
    null,
    null,
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  // Dolphin computes (3 * 85) >> 8. Multiplying normalized values would
  // retain a non-zero fraction here and is not TransformColor semantics.
  assertVector(channels[0], [0, 0, 0, 0]);
});

test("implements point and spot attenuation enums with GX SafeDivide", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100a] = 0;
  context.gxXfRegisters[0x100c] = 0xffffffff;
  setLight(context, 0, {
    color: 0x80808080,
    cosAtten: [1, 0, 0],
    distAtten: [0, 0, 0],
    position: [0, 0, 3],
    direction: [0, 0, 1],
  });

  const pointWithLight0 = 2 | (1 << 2) | (1 << 9);
  context.gxXfRegisters[0x100e] = pointWithLight0;
  context.gxXfRegisters[0x1010] = pointWithLight0;
  let channels = context.gxLightRasterChannels(
    [0, 0, 1],
    [0, 0, 1],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(channels[0], Array(4).fill(128 / 255));

  setLight(context, 0, {
    color: 0x80808080,
    cosAtten: [1, 0, 0],
    distAtten: [1, 0, 0],
    position: [0, 0, 3],
    direction: [0, 0, 1],
  });
  const spotClampedWithLight0 = 2 | (1 << 2) | (2 << 7) | (3 << 9);
  context.gxXfRegisters[0x100e] = spotClampedWithLight0;
  context.gxXfRegisters[0x1010] = spotClampedWithLight0;
  channels = context.gxLightRasterChannels(
    [0, 0, 1],
    [0, 0, 1],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(channels[0], Array(4).fill(128 / 255));
});

test("keeps Spot cosine and distance quadratic f32 orders distinct", () => {
  const context = workerContext();
  const value = Math.fround(3.1553611755371094);
  const coefficient = Math.fround(2.335707187652588);
  const coefficients = [0, 0, coefficient];
  const squared = Math.fround(value * value);

  const cosine = context.gxLightSpotCosPolynomial(coefficients, value);
  const distance = context.gxLightSpotDistancePolynomial(
    coefficients,
    value,
    squared,
  );
  assert.equal(f32Bits(cosine), 0x41ba0a43);
  assert.equal(f32Bits(distance), 0x41ba0a44);
});

test("coincident lights ignore, propagate, or clamp NaN diffuse by mode", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100a] = 0x40404040;
  context.gxXfRegisters[0x100c] = 0xffffffff;
  setLight(context, 0, {
    color: 0x80808080,
    cosAtten: [1, 0, 0],
    distAtten: [1, 0, 0],
    position: [0, 0, 0],
  });

  for (const attenuationMode of [0, 1, 2, 3]) {
    const control = 2 | (1 << 2) | (attenuationMode << 9);
    context.gxXfRegisters[0x100e] = control;
    context.gxXfRegisters[0x1010] = control;
    const noneDiffuse = context.gxLightRasterChannels(
      [0, 0, 0],
      [0, 0, 1],
      [[0, 0, 0, 0], [0, 0, 0, 0]],
    );
    assertVector(
      noneDiffuse[0],
      Array(4).fill(192 / 255),
    );

    const signedControl = control | (1 << 7);
    context.gxXfRegisters[0x100e] = signedControl;
    context.gxXfRegisters[0x1010] = signedControl;
    assert.equal(
      context.gxLightRasterChannels(
        [0, 0, 0],
        [0, 0, 1],
        [[0, 0, 0, 0], [0, 0, 0, 0]],
      ),
      null,
    );

    const clampedControl = control | (2 << 7);
    context.gxXfRegisters[0x100e] = clampedControl;
    context.gxXfRegisters[0x1010] = clampedControl;
    const clampedDiffuse = context.gxLightRasterChannels(
      [0, 0, 0],
      [0, 0, 1],
      [[0, 0, 0, 0], [0, 0, 0, 0]],
    );
    assertVector(clampedDiffuse[0], Array(4).fill(63 / 255));
  }
});

test("rejects non-finite selected-light attenuation", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100c] = 0xffffffff;
  setLight(context, 0, {
    color: 0xffffffff,
    cosAtten: [Number.NaN, 0, 0],
    distAtten: [1, 0, 0],
    position: [0, 0, 1],
    direction: [0, 0, 1],
  });
  context.gxXfRegisters[0x100e] = 2 | (1 << 2) | (3 << 9);

  assert.equal(
    context.gxLightRasterChannels(
      [0, 0, 0],
      [0, 0, 1],
      [[0, 0, 0, 0], [0, 0, 0, 0]],
    ),
    null,
  );

});

test("fails closed instead of substituting source colors for invalid lit state", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100c] = 0xffffffff;
  setLight(context, 0, { color: 0xffffffff, position: [0, 0, 1] });
  context.gxXfRegisters[0x100e] = 2 | (1 << 2) | (3 << 7);

  assert.equal(
    context.gxLightRasterChannels(
      [0, 0, 0],
      [0, 0, 1],
      [[255, 0, 0, 255], [0, 0, 0, 0]],
    ),
    null,
  );
  assert.match(
    source,
    /const rasterColors = gxLightRasterChannels\([\s\S]*?if \(rasterColors === null\) \{\s*gxLightingRejectedVertices \+= 1;\s*return \{ cursor, skipped: true \};/,
  );
  assert.match(
    source,
    /!Array\.isArray\(decoded\.rasterColors\)[\s\S]*decodeComplete = false;[\s\S]*const \[raster0, raster1\] = decoded\.rasterColors;/,
  );
  assert.doesNotMatch(
    source,
    /decoded\.rasterColors\?\.\[[01]\][\s\S]*\?\?\s*decoded\.colors/,
  );
});

test("counts each vertex rejected by XF lighting exactly at the fail-closed site", () => {
  assert.match(source, /let gxLightingRejectedVertices = 0;/);
  assert.match(
    source,
    /const rasterColors = gxLightRasterChannels\([\s\S]*?if \(rasterColors === null\) \{\s*gxLightingRejectedVertices \+= 1;\s*return \{ cursor, skipped: true \};/,
  );
  assert.equal(
    source.match(/gxLightingRejectedVertices \+= 1;/g)?.length,
    1,
  );
  assert.match(
    source,
    /lightingRejectedVertices: gxLightingRejectedVertices/,
  );
});

test("keeps raster channels zero and one independent", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100c] = 0xff000040;
  context.gxXfRegisters[0x100d] = 0x00ff0080;
  context.gxXfRegisters[0x100e] = 0;
  context.gxXfRegisters[0x1010] = 1;
  context.gxXfRegisters[0x100f] = 1;
  context.gxXfRegisters[0x1011] = 0;

  const channels = context.gxLightRasterChannels(
    [1, 2, 3],
    [0, 1, 0],
    [[12, 34, 56, 78], [90, 123, 231, 45]],
  );
  assertVector(channels[0], [1, 0, 0, 78 / 255]);
  assertVector(channels[1], [90 / 255, 123 / 255, 231 / 255, 128 / 255]);
});
