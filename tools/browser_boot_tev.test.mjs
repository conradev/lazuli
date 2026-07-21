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

const context = { Array };
vm.createContext(context);
vm.runInContext(
  ["gxTevRegisterIndex", "gxTevColorArgument", "gxTevAlphaArgument"]
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
