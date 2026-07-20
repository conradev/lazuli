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
    "gxNormalize3",
    "gxXfColor",
    "gxXfLight",
    "gxDot3",
    "gxVectorSubtract",
    "gxLightDiffuse",
    "gxPolynomial",
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

function setLight(context, index, { color, position }) {
  const base = 0x603 + index * 0x10;
  context.gxXfRegisters[base] = color >>> 0;
  for (let component = 0; component < 3; component += 1) {
    setXfFloat(context, base + 7 + component, position[component]);
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

test("decodes XF colors as raw RRGGBBAA channels", () => {
  const context = workerContext();
  context.gxXfRegisters[0x100a] = 0x12345678;

  assertVector(context.gxXfColor(0x100a), [
    0x12 / 255,
    0x34 / 255,
    0x56 / 255,
    0x78 / 255,
  ]);
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
  assertVector(backFacing[0], Array(4).fill(64 / 255));

  context.gxXfRegisters[0x100e] = 2 | (2 << 7);
  context.gxXfRegisters[0x1010] = 2 | (2 << 7);
  const masked = context.gxLightRasterChannels(
    [0, 0, 1],
    [0, 0, 1],
    [[0, 0, 0, 0], [0, 0, 0, 0]],
  );
  assertVector(masked[0], Array(4).fill(64 / 255));

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
