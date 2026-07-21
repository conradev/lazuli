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

test("TEV regular combiner reads A, B, and C as unsigned 8-bit lanes", () => {
  const clampedAdd = 1 << 19;

  assert.equal(context.gxTevRegular(-1, 0, 0, 0, clampedAdd), 255);
  assert.equal(context.gxTevRegular(0, -1, 255, 0, clampedAdd), 255);
  assert.equal(context.gxTevRegular(0, 255, -1, 0, clampedAdd), 255);
  assert.equal(context.gxTevRegular(0, 0, 0, -1, 0), -1);
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
