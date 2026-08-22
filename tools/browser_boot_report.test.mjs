#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

test("browser reports expose the CPU-state signature", () => {
  const cpuStateStart = source.indexOf("cpuState: {");
  const cpuStateEnd = source.indexOf("mmioState: {", cpuStateStart);

  assert.notEqual(cpuStateStart, -1, "missing cpuState report");
  assert.notEqual(cpuStateEnd, -1, "missing cpuState report boundary");
  assert.match(
    source.slice(cpuStateStart, cpuStateEnd),
    /signature: hex32\(cpuSignature\(\)\),/,
  );
});
