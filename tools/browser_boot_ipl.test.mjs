#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

test("bundled IPL font image is pinned, sparse, and route-free", () => {
  const japanese = readFileSync(
    new URL("../resources/ipl/font_japanese.bin", import.meta.url),
  );
  const western = readFileSync(
    new URL("../resources/ipl/font_western.bin", import.meta.url),
  );
  const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

  assert.equal(japanese.byteLength, 259_626);
  assert.equal(
    sha256(japanese),
    "38f9f59d505bc4e2d86b0196706195f33ad72b7fe9d029cf263072cde19d044f",
  );
  assert.equal(western.byteLength, 6_478);
  assert.equal(
    sha256(western),
    "4ad991be2b0aa305f09b90a79fc50f57833b30b008890b5ef1336cc3d9d0bae0",
  );
  assert.equal(japanese.subarray(0, 4).toString("ascii"), "Yay0");
  assert.equal(western.subarray(0, 4).toString("ascii"), "Yay0");

  assert.match(
    source,
    /const IPL_FONT_JAPANESE_OFFSET: usize = 0x1a_ff00;/,
  );
  assert.match(
    source,
    /const IPL_FONT_WESTERN_OFFSET: usize = 0x1f_cf00;/,
  );
  const bundledImage = extractFunction("createBundledExiIplImage");
  assert.match(bundledImage, /new Uint8Array\(exiIplImageBytes\)/);
  assert.match(bundledImage, /decode\("__IPL_FONT_JAPANESE__"\)/);
  assert.match(bundledImage, /decode\("__IPL_FONT_WESTERN__"\)/);
  assert.doesNotMatch(
    bundledImage,
    /\bfetch\b|new URL|localStorage|sessionStorage|\bcaches\b/,
  );
});
