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
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
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

const context = { Array, Math };
vm.createContext(context);
vm.runInContext(
  [
    "gxTevAlphaArguments",
    "gxTevRegisterIndex",
    "gxTevColorArgument",
    "gxTevAlphaArgument",
    "gxTevRegular",
    "gxTevClamp",
    "gxTevComparison",
    "gxTevPackedColor",
    "gxTevColorCombiner",
    "gxTevAlphaCombiner",
  ]
    .map(extractFunction)
    .join("\n\n"),
  context,
  { filename: "browser_boot.tev.js" },
);

function dolphinTevRegular(
  a, b, c, d, { bias = 0, subtract = false, scale = 0, clamp = false } = {},
) {
  a &= 0xff;
  b &= 0xff;
  c &= 0xff;
  c += c >> 7;
  d += [0, 128, -128][bias];
  const interpolation = (a << 8) + (b - a) * c;
  let result;
  if (scale === 3) {
    const mixed = interpolation >> 8;
    result = (subtract ? d - mixed : d + mixed) >> 1;
  } else {
    const mixed = (
      (interpolation << scale) + (subtract ? 127 : 128)
    ) >> 8;
    const scaledD = d << scale;
    result = subtract ? scaledD - mixed : scaledD + mixed;
  }
  return clamp
    ? Math.max(0, Math.min(255, result))
    : Math.max(-1024, Math.min(1023, result));
}

function regularCombiner({
  bias = 0, subtract = false, scale = 0, clamp = false,
} = {}) {
  return (bias << 16)
    | (Number(subtract) << 18)
    | (Number(clamp) << 19)
    | (scale << 20);
}

test("TEV register encoding maps R3 before R0, R1, and R2", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(context.gxTevRegisterIndex),
    [3, 0, 1, 2],
  );
});

test("TEV color and alpha inputs read the encoded register", () => {
  const registers = [
    [10, 11, 12, 13],
    [20, 21, 22, 23],
    [30, 31, 32, 33],
    [40, 41, 42, 43],
  ];
  const unusedColor = [0, 0, 0, 0];
  assert.equal(
    context.gxTevColorArgument(
      0, 1, registers, unusedColor, unusedColor, unusedColor,
    ),
    41,
  );
  assert.equal(
    context.gxTevColorArgument(
      3, 0, registers, unusedColor, unusedColor, unusedColor,
    ),
    13,
  );
  assert.equal(
    context.gxTevColorArgument(
      6, 2, registers, unusedColor, unusedColor, unusedColor,
    ),
    32,
  );
  assert.equal(
    context.gxTevAlphaArgument(0, registers, unusedColor, unusedColor, 0),
    43,
  );
  assert.equal(
    context.gxTevAlphaArgument(3, registers, unusedColor, unusedColor, 0),
    33,
  );
});

test("TEV regular combiner matches Dolphin fixed-point controls and edges", () => {
  const lanes = [-1024, -1, 0, 1, 127, 128, 255, 1023];
  for (const bias of [0, 1, 2]) {
    for (const subtract of [false, true]) {
      for (const scale of [0, 1, 2, 3]) {
        for (const clamp of [false, true]) {
          const controls = { bias, subtract, scale, clamp };
          const combiner = regularCombiner(controls);
          for (let index = 0; index < lanes.length; index += 1) {
            const values = [
              lanes[index],
              lanes[(index + 3) % lanes.length],
              lanes[(index + 5) % lanes.length],
              lanes[(index + 7) % lanes.length],
            ];
            assert.equal(
              context.gxTevRegular(...values, combiner),
              dolphinTevRegular(...values, controls),
              `${values.join(",")} bias ${bias} subtract ${subtract} scale ${scale} clamp ${clamp}`,
            );
          }
        }
      }
    }
  }

  const edgeCases = [
    { values: [0, 0, 0, 0], controls: { scale: 1 }, expected: 0 },
    {
      values: [0, 128, 179, -90],
      controls: { scale: 1 },
      expected: 0,
    },
    {
      values: [0, 128, 182, 91],
      controls: { subtract: true },
      expected: 0,
    },
    { values: [0, 1, 128, 0], controls: { scale: 3 }, expected: 0 },
    { values: [0, 0, 0, -1], controls: { scale: 3 }, expected: -1 },
    {
      values: [0, 0, 0, -1],
      controls: { bias: 1, scale: 1 },
      expected: 254,
    },
    {
      values: [-1, 0, 0, 0],
      controls: { clamp: true },
      expected: 255,
    },
  ];
  for (const { values, controls, expected } of edgeCases) {
    assert.equal(
      context.gxTevRegular(
        ...values,
        regularCombiner(controls),
      ),
      expected,
      `${values.join(",")} ${JSON.stringify(controls)}`,
    );
  }
});

test("SMB alpha combiner preserves opaque texels from signed TEV registers", () => {
  const combiner = 0x0008e620;
  const arguments_ = context.gxTevAlphaArguments(combiner);
  const registers = [
    [0, 0, 0, -1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 255],
  ];
  const raster = [0, 0, 0, 255];
  const evaluate = textureAlpha => {
    const texture = [255, 255, 255, textureAlpha];
    const input = argument => context.gxTevAlphaArgument(
      argument, registers, texture, raster, 0,
    );
    return context.gxTevRegular(
      input(arguments_.a),
      input(arguments_.b),
      input(arguments_.c),
      input(arguments_.d),
      combiner,
    );
  };

  assert.equal(evaluate(0), 0);
  assert.equal(evaluate(1), 1);
  assert.equal(evaluate(255), 255);
});

function evaluateMkddThp(y, u, v) {
  const stages = [
    {
      color: 0x00f8e2,
      alpha: 0x04f310,
      texture: [u, u, u, u],
      konstColor: [0, 0, 226],
      konstAlpha: 88,
    },
    {
      color: 0x10f8e0,
      alpha: 0x04f300,
      texture: [v, v, v, v],
      konstColor: [179, 0, 0],
      konstAlpha: 182,
    },
    {
      color: 0x08f8c0,
      alpha: 0x089f80,
      texture: [y, y, y, y],
      konstColor: [255, 255, 255],
      konstAlpha: 255,
    },
    {
      color: 0x0810ef,
      alpha: 0x08fff0,
      texture: [255, 255, 255, 255],
      konstColor: [255, 0, 255],
      konstAlpha: 128,
    },
  ];
  const registers = [
    [-90, 0, -114, 135],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const zeroRaster = [0, 0, 0, 0];
  const trace = [];
  for (const stage of stages) {
    const colorArguments = {
      a: (stage.color >>> 12) & 0xf,
      b: (stage.color >>> 8) & 0xf,
      c: (stage.color >>> 4) & 0xf,
      d: stage.color & 0xf,
    };
    const alphaArguments = context.gxTevAlphaArguments(stage.alpha);
    const colorInput = argument => Array.from(
      { length: 3 },
      (_unused, channel) => context.gxTevColorArgument(
        argument,
        channel,
        registers,
        stage.texture,
        zeroRaster,
        stage.konstColor,
      ),
    );
    const colorA = colorInput(colorArguments.a);
    const colorB = colorInput(colorArguments.b);
    const color = context.gxTevColorCombiner(
      colorA,
      colorB,
      colorInput(colorArguments.c),
      colorInput(colorArguments.d),
      stage.color,
    );
    const alphaInput = argument => context.gxTevAlphaArgument(
      argument,
      registers,
      stage.texture,
      zeroRaster,
      stage.konstAlpha,
    );
    const alpha = context.gxTevAlphaCombiner(
      colorA,
      colorB,
      alphaInput(alphaArguments.a),
      alphaInput(alphaArguments.b),
      alphaInput(alphaArguments.c),
      alphaInput(alphaArguments.d),
      stage.alpha,
    );
    const colorDestination = context.gxTevRegisterIndex(
      (stage.color >>> 22) & 3,
    );
    const alphaDestination = context.gxTevRegisterIndex(
      (stage.alpha >>> 22) & 3,
    );
    registers[colorDestination].splice(0, 3, ...color);
    registers[alphaDestination][3] = alpha;
    trace.push(Array.from(registers[3]));
  }
  return { rgba: Array.from(registers[3]), trace };
}

test("MKDD four-stage THP YUV conversion matches integer goldens", () => {
  const neutral = evaluateMkddThp(16, 128, 128);
  assert.deepEqual(neutral.trace, [
    [-90, 0, 0, 91],
    [0, 0, 0, 0],
    [16, 16, 16, 16],
    [16, 16, 16, 0],
  ]);

  const goldens = [
    [[0, 128, 128], [0, 0, 0, 0]],
    [[255, 128, 128], [255, 255, 255, 0]],
    [[76, 84, 255], [255, 0, 0, 0]],
    [[149, 43, 21], [0, 254, 0, 0]],
    [[29, 255, 107], [0, 0, 253, 0]],
  ];
  for (const [yuv, expected] of goldens) {
    assert.deepEqual(evaluateMkddThp(...yuv).rgba, expected, yuv.join(","));
  }
});

function comparativeCombiner(operation, clamp = true) {
  assert.ok(operation >= 8 && operation <= 15);
  return (3 << 16)
    | ((operation & 1) << 18)
    | (Number(clamp) << 19)
    | (((operation >>> 1) & 3) << 20);
}

test("GX comparative opcodes map to the BP combiner fields", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_unused, index) =>
      comparativeCombiner(8 + index, false)
    ),
    [
      0x030000, 0x070000,
      0x130000, 0x170000,
      0x230000, 0x270000,
      0x330000, 0x370000,
    ],
  );
  assert.equal(comparativeCombiner(8), 0x0b0000);
});

test("TEV color comparative opcodes decode packed and component targets", () => {
  const c = [7, -1, 10];
  const d = [-5, 10, 250];
  const selected = [2, 255, 255];
  const rejected = [0, 10, 250];
  const cases = [
    {
      name: "R8 greater",
      operation: 8,
      a: [-1, 0, 0],
      b: [0, 255, 255],
      expected: selected,
      rejectedA: [0, 0, 0],
      rejectedB: [-1, 255, 255],
    },
    {
      name: "R8 equal",
      operation: 9,
      a: [9, 1, 2],
      b: [9, 3, 4],
      expected: selected,
      rejectedA: [9, 1, 2],
      rejectedB: [10, 1, 2],
    },
    {
      name: "GR16 greater",
      operation: 10,
      a: [0, 2, 0],
      b: [255, 1, 255],
      expected: selected,
      rejectedA: [255, 1, 255],
      rejectedB: [0, 2, 0],
    },
    {
      name: "GR16 equal",
      operation: 11,
      a: [7, 8, 1],
      b: [7, 8, 2],
      expected: selected,
      rejectedA: [7, 8, 1],
      rejectedB: [7, 9, 1],
    },
    {
      name: "BGR24 greater",
      operation: 12,
      a: [0, 0, 2],
      b: [255, 255, 1],
      expected: selected,
      rejectedA: [255, 255, 1],
      rejectedB: [0, 0, 2],
    },
    {
      name: "BGR24 equal",
      operation: 13,
      a: [1, 2, 3],
      b: [1, 2, 3],
      expected: selected,
      rejectedA: [1, 2, 3],
      rejectedB: [1, 2, 4],
    },
    {
      name: "RGB8 greater",
      operation: 14,
      a: [2, 2, 2],
      b: [1, 3, 2],
      expected: [2, 10, 250],
    },
    {
      name: "RGB8 equal",
      operation: 15,
      a: [2, 2, 2],
      b: [1, 3, 2],
      expected: [0, 10, 255],
    },
  ];

  for (const comparison of cases) {
    const combiner = comparativeCombiner(comparison.operation);
    assert.deepEqual(
      Array.from(context.gxTevColorCombiner(
        comparison.a, comparison.b, c, d, combiner,
      )),
      comparison.expected,
      comparison.name,
    );
    if (comparison.rejectedA !== undefined) {
      assert.deepEqual(
        Array.from(context.gxTevColorCombiner(
          comparison.rejectedA, comparison.rejectedB, c, d, combiner,
        )),
        rejected,
        `${comparison.name} rejects a non-match`,
      );
    }
  }
});

test("TEV alpha packed comparisons use color A/B and A8 uses alpha A/B", () => {
  const c = -1;
  const d = 10;
  const cases = [
    { operation: 8, colorA: [-1, 0, 0], colorB: [0, 255, 255], a: 0, b: 255 },
    { operation: 9, colorA: [9, 1, 2], colorB: [9, 3, 4], a: 0, b: 255 },
    { operation: 10, colorA: [0, 2, 0], colorB: [255, 1, 255], a: 0, b: 255 },
    { operation: 11, colorA: [7, 8, 1], colorB: [7, 8, 2], a: 0, b: 255 },
    { operation: 12, colorA: [0, 0, 2], colorB: [255, 255, 1], a: 0, b: 255 },
    { operation: 13, colorA: [1, 2, 3], colorB: [1, 2, 3], a: 0, b: 255 },
    { operation: 14, colorA: [0, 0, 0], colorB: [255, 255, 255], a: -1, b: 0 },
    { operation: 15, colorA: [0, 0, 0], colorB: [255, 255, 255], a: -1, b: 255 },
  ];

  for (const comparison of cases) {
    const combiner = comparativeCombiner(comparison.operation);
    assert.equal(
      context.gxTevAlphaCombiner(
        comparison.colorA,
        comparison.colorB,
        comparison.a,
        comparison.b,
        c,
        d,
        combiner,
      ),
      255,
      `operation ${comparison.operation} selects C`,
    );

    const target = (comparison.operation >>> 1) & 3;
    const rejectedColorB = comparison.colorB.slice();
    let rejectedAlphaB = comparison.b;
    if ((comparison.operation & 1) === 0) {
      assert.equal(
        context.gxTevAlphaCombiner(
          comparison.colorB,
          comparison.colorA,
          comparison.b,
          comparison.a,
          c,
          d,
          combiner,
        ),
        d,
        `operation ${comparison.operation} rejects reversed operands`,
      );
      continue;
    }
    if (target === 3) rejectedAlphaB = (rejectedAlphaB + 1) & 0xff;
    else rejectedColorB[target] = (rejectedColorB[target] + 1) & 0xff;
    assert.equal(
      context.gxTevAlphaCombiner(
        comparison.colorA,
        rejectedColorB,
        comparison.a,
        rejectedAlphaB,
        c,
        d,
        combiner,
      ),
      d,
      `operation ${comparison.operation} rejects a non-match`,
    );
  }
});

test("TEV combiner wrappers preserve regular evaluation and comparative clamp", () => {
  const regular = (2 << 16) | (1 << 18) | (3 << 20);
  const a = [-1, 10, 200];
  const b = [0, 220, 4];
  const c = [0, 64, -1];
  const d = [-1, 12, 900];
  assert.deepEqual(
    Array.from(context.gxTevColorCombiner(a, b, c, d, regular)),
    a.map((value, channel) => context.gxTevRegular(
      value, b[channel], c[channel], d[channel], regular,
    )),
  );
  assert.equal(
    context.gxTevAlphaCombiner(a, b, -1, 0, 255, -1, regular),
    context.gxTevRegular(-1, 0, 255, -1, regular),
  );

  const unclampedR8Greater = comparativeCombiner(8, false);
  assert.equal(
    context.gxTevAlphaCombiner([-1, 0, 0], [0, 0, 0], 0, 0, -1, 10,
      unclampedR8Greater),
    265,
  );
  assert.equal(
    context.gxTevAlphaCombiner([-1, 0, 0], [0, 0, 0], 0, 0, 0, -2000,
      unclampedR8Greater),
    -1024,
  );
});
