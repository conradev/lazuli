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

function makeContext() {
  const memory = new ArrayBuffer(0x100);
  const context = {
    cpStatusReadIdle: 0x0004,
    cpStatusCommandIdle: 0x0008,
    gxDecodeBuffer: [],
    gxFifoStagingMeta: 0x40,
    mmio: 0,
    translateDataRange: address => (
      address >= 0xc0000000 ? (address - 0xc0000000) >>> 0 : address >>> 0
    ),
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    ["gxFifoBufferedBytes", "readCommandProcessorStatus", "readInteger"]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.cp.js" },
  );
  return context;
}

function readStatus(context) {
  const resultPointer = 0x80;
  assert.equal(context.readInteger(0xcc000000, resultPointer, 2), 1);
  return context.view.getUint16(resultPointer, true);
}

test("CP_STATUS reports the synchronous FIFO decoder idle", () => {
  const context = makeContext();
  context.view.setUint16(context.mmio, 0x0011, false);

  assert.equal(readStatus(context), 0x001d);
  assert.equal(
    context.view.getUint16(context.mmio, false),
    0x0011,
    "the read-only idle flags must not be persisted into MMIO storage",
  );
});

test("CP_STATUS remains busy while either FIFO buffer holds bytes", () => {
  const context = makeContext();
  context.view.setUint16(context.mmio, 0x0011, false);

  context.gxDecodeBuffer.push(0x61);
  assert.equal(readStatus(context), 0x0011, "decoder bytes are still pending");

  context.gxDecodeBuffer.length = 0;
  context.view.setUint32(context.gxFifoStagingMeta, 5, true);
  assert.equal(readStatus(context), 0x0011, "staged writes are still pending");

  context.view.setUint32(context.gxFifoStagingMeta, 0, true);
  assert.equal(readStatus(context), 0x001d);
});
