#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  discBootMemoryLayout,
} from "../crates/ppcwasmjit/examples/browser_disc_source.mjs";

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

test("direct DOL boot mirrors the apploader low-memory handoff", () => {
  const memory = new ArrayBuffer(0x200);
  const writes = new Map();
  const fstMaxSize = 0x60c0;
  const { bi2Address, fstAddress } = discBootMemoryLayout(fstMaxSize);
  const context = {
    bi2Address,
    boot: {
      audioStreaming: 1,
      discId: 2,
      gameCode: 0x47414d45,
      makerCode: 0x3031,
      streamBufferSize: 10,
      tvMode: 0,
      version: 3,
    },
    bytes: new Uint8Array(memory),
    fstAddress,
    fstMaxSize,
    ram: 0,
    view: new DataView(memory),
    writePhysical32(address, value) {
      writes.set(address, value);
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("initializeLowMemory"), context, {
    filename: "browser_boot.memory.js",
  });

  context.initializeLowMemory();

  assert.equal(writes.get(0x30), 0);
  assert.equal(writes.get(0x34), fstAddress);
  assert.equal(writes.get(0x38), fstAddress);
  assert.equal(writes.get(0x3c), fstMaxSize);
  assert.equal(writes.get(0xf4), bi2Address);
});

test("direct DOL boot preserves adjacent FST and BI2 regions", () => {
  const memory = new ArrayBuffer(0x2400);
  const { bi2Address, fstAddress } = discBootMemoryLayout(0x20);
  const bi2 = Uint8Array.from({ length: 0x2000 }, (_, index) => index & 0xff);
  const fst = Uint8Array.from({ length: 8 }, (_, index) => 0x80 + index);
  const context = {
    bi2,
    bi2Address,
    bytes: new Uint8Array(memory),
    fst,
    fstAddress,
    physicalOffset(address) {
      return 0x40 + address - bi2Address;
    },
    ram: 0,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("loadBootData"), context, {
    filename: "browser_boot.memory.js",
  });

  context.loadBootData();

  assert.deepEqual(
    context.bytes.slice(0x40, 0x2048),
    Uint8Array.from([...bi2, ...fst]),
  );
});

test("embedded and selected discs share the browser disc layout", () => {
  assert.match(
    source,
    /const fallbackBootLayout = discBootMemoryLayout\(__FST_MAX_SIZE__\);/,
  );
  assert.match(source, /bi2Address: fallbackBootLayout\.bi2Address/);
  assert.match(source, /fstAddress: fallbackBootLayout\.fstAddress/);
  assert.doesNotMatch(source, /__(?:BI2|FST)_ADDRESS__/);
});

test("browser power-on exposes the physical reset button as released", () => {
  assert.match(
    source,
    /bytes\.fill\(0, mmio, mmio \+ mmioSize\);\s*\/\/[\s\S]*?view\.setUint32\(mmio \+ 0x3000, 0x00010000, false\);/,
  );
});
