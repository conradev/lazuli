#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

test("local harness derives and publishes the sibling browser DSP artifact", () => {
  assert.match(
    source,
    /let dsp_path = compiler_path\.with_file_name\("browser_dsp\.wasm"\);/,
  );
  assert.match(
    source,
    /copy_browser_asset\(&dsp_path, &dsp_output, "browser DSP"\);/,
  );
  assert.match(
    source,
    /globalThis\.browserDspWasmUrl = .*new URL\("\/browser_dsp\.wasm", location\.href\)\.href/,
  );
});

test("DSP initialization seals the one memory before creating machine views", () => {
  const memory = source.indexOf("const memory = new WebAssembly.Memory({");
  const instantiate = source.indexOf("const { instance: browserDspInstance }", memory);
  const initialize = source.indexOf("browserDsp.browser_dsp_init() === 1", instantiate);
  const grow = source.indexOf("memory.grow(__LEGACY_MEMORY_MAXIMUM_PAGES__", initialize);
  const bytes = source.indexOf("const bytes = new Uint8Array(memory.buffer);", grow);
  const view = source.indexOf("const view = new DataView(memory.buffer);", bytes);
  const aram = source.indexOf(
    "const aram = new Uint8Array(memory.buffer, __ARAM_PTR__, __ARAM_SIZE__);",
    view,
  );
  for (const [label, index] of Object.entries({
    memory,
    instantiate,
    initialize,
    grow,
    bytes,
    view,
    aram,
  })) {
    assert.notEqual(index, -1, `missing ${label} bootstrap step`);
  }
  assert.deepEqual(
    [memory, instantiate, initialize, grow, bytes, view, aram],
    [memory, instantiate, initialize, grow, bytes, view, aram].toSorted((a, b) => a - b),
  );

  const bootstrap = source.slice(memory, view + 48);
  assert.match(
    bootstrap,
    /initial: __LEGACY_MEMORY_INITIAL_PAGES__,\s*maximum: __LEGACY_MEMORY_MAXIMUM_PAGES__,/,
  );
  assert.match(bootstrap, /lazuli: \{ memory \}/);
  assert.match(
    bootstrap,
    /main_ram_write_completed: invalidateDataReservationForExternalWrite/,
  );
  assert.doesNotMatch(bootstrap.slice(0, grow - memory), /new (?:Uint8Array|DataView)\(memory\.buffer/);
  assert.doesNotMatch(source, /new Uint8Array\(0x01000000\)/);
});

test("fulfilled wasm fetch promises release their binary references", () => {
  assert.match(source, /let compilerWasmPromise = fetchBinary/);
  assert.match(source, /let browserDspWasmPromise = fetchBinary/);
  assert.match(
    source,
    /compilerWasmPromise = null;\s*browserDspWasmPromise = null;/,
  );
  assert.match(source, /browserDspWasm = null;/);
  assert.match(source, /compilerWasm = null;/);
});
