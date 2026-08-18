// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const RESIDENT_MEMORY_INITIAL_PAGES = 720;
const RESIDENT_MEMORY_MAXIMUM_PAGES = 2048;
const DISPATCH_METADATA_OFFSET = 0x0004_0000;
const DISPATCH_METADATA_BYTES = 0x0003_8000;
const DISPATCH_SLOT_IDENTITY_OFFSET = 0x0007_8000;
const DISPATCH_SLOT_IDENTITY_BYTES = 0x0002_0000;
const DISPATCH_SLOT_CAPACITY = 4096;
const MACHINE_CONTROL_BYTES = 0x0010_0000;
const CORE_VALIDATOR_IMPORT = "validate_instruction_page_dependency";

const expectedImports = [
  { module: "lazuli", name: "memory", kind: "memory" },
  { module: "lazuli", name: CORE_VALIDATOR_IMPORT, kind: "function" },
];
const expectedExports = [
  { name: "run", kind: "function" },
  { name: "blocks", kind: "table" },
];

// (i32, i32, i32) -> i32, the sole type accepted by the dispatch table.
const exactBlockModuleBytes = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x08, 0x01, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

function instantiate(module, memory) {
  return new WebAssembly.Instance(module, {
    lazuli: {
      memory,
      [CORE_VALIDATOR_IMPORT]() {
        return 0;
      },
    },
  });
}

function assertFilled(bytes, start, length, expected, label) {
  const end = start + length;
  for (let offset = start; offset < end; offset += 1) {
    assert.equal(bytes[offset], expected, `${label} changed at 0x${offset.toString(16)}`);
  }
}

export async function verifyResidentDispatcherWasm(path) {
  const bytes = await readFile(path);
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), expectedImports);
  assert.deepEqual(WebAssembly.Module.exports(module), expectedExports);

  assert.throws(
    () => instantiate(module, new WebAssembly.Memory({
      initial: RESIDENT_MEMORY_INITIAL_PAGES - 1,
      maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
    })),
    WebAssembly.LinkError,
    "dispatcher accepted memory below the canonical 720-page minimum",
  );
  assert.throws(
    () => instantiate(module, new WebAssembly.Memory({
      initial: RESIDENT_MEMORY_INITIAL_PAGES,
      maximum: RESIDENT_MEMORY_MAXIMUM_PAGES + 1,
    })),
    WebAssembly.LinkError,
    "dispatcher accepted memory above the canonical 2048-page ceiling",
  );

  const memory = new WebAssembly.Memory({
    initial: RESIDENT_MEMORY_INITIAL_PAGES,
    maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
  });
  const machineControl = new Uint8Array(memory.buffer, 0, MACHINE_CONTROL_BYTES);
  machineControl.fill(0xa5);
  const instance = instantiate(module, memory);
  const initializedControl = new Uint8Array(memory.buffer, 0, MACHINE_CONTROL_BYTES);

  assertFilled(
    initializedControl,
    0,
    DISPATCH_METADATA_OFFSET,
    0xa5,
    "bytes before canonical dispatch metadata",
  );
  assertFilled(
    initializedControl,
    DISPATCH_METADATA_OFFSET,
    DISPATCH_METADATA_BYTES,
    0,
    "canonical dispatch metadata",
  );
  assert.equal(
    DISPATCH_METADATA_OFFSET + DISPATCH_METADATA_BYTES,
    DISPATCH_SLOT_IDENTITY_OFFSET,
    "canonical metadata and slot directories are not adjacent",
  );
  assertFilled(
    initializedControl,
    DISPATCH_SLOT_IDENTITY_OFFSET,
    DISPATCH_SLOT_IDENTITY_BYTES,
    0,
    "canonical dispatch slot directory",
  );
  const slotIdentityEnd = DISPATCH_SLOT_IDENTITY_OFFSET + DISPATCH_SLOT_IDENTITY_BYTES;
  assertFilled(
    initializedControl,
    slotIdentityEnd,
    MACHINE_CONTROL_BYTES - slotIdentityEnd,
    0xa5,
    "bytes after canonical dispatch slot directory",
  );

  const { run, blocks } = instance.exports;
  assert.equal(typeof run, "function");
  assert.ok(blocks instanceof WebAssembly.Table);
  assert.equal(blocks.length, 1, "production table did not start at its canonical minimum");
  assert.equal(blocks.get(0), null, "production table contained fixture authority");
  assert.deepEqual(
    run(0, 0, 0, 0, DISPATCH_METADATA_OFFSET, 0, 0, 1n, 0),
    [0n, 0n, 0, 0],
    "resident dispatcher run signature or empty-budget result changed",
  );

  const exactBlock = new WebAssembly.Instance(
    new WebAssembly.Module(exactBlockModuleBytes),
  ).exports.f;
  blocks.set(0, exactBlock);
  assert.equal(blocks.get(0), exactBlock, "typed table rejected its canonical block shape");
  assert.throws(
    () => blocks.set(0, run),
    TypeError,
    "typed table accepted a function with the resident dispatcher signature",
  );
  assert.equal(
    blocks.grow(DISPATCH_SLOT_CAPACITY - blocks.length),
    1,
    "typed table reported the wrong previous length while growing",
  );
  assert.equal(blocks.length, DISPATCH_SLOT_CAPACITY);
  assert.throws(
    () => blocks.grow(1),
    RangeError,
    "typed table grew beyond the canonical Rust slot capacity",
  );

  return {
    ok: true,
    bytes: bytes.byteLength,
    imports: expectedImports,
    exports: expectedExports,
    memoryPages: {
      initial: RESIDENT_MEMORY_INITIAL_PAGES,
      maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
    },
    metadata: {
      offset: DISPATCH_METADATA_OFFSET,
      bytes: DISPATCH_METADATA_BYTES,
    },
    slotIdentities: {
      offset: DISPATCH_SLOT_IDENTITY_OFFSET,
      bytes: DISPATCH_SLOT_IDENTITY_BYTES,
      capacity: DISPATCH_SLOT_CAPACITY,
    },
    table: {
      initial: 1,
      maximum: blocks.length,
      element: "(ref null (func (param i32 i32 i32) (result i32)))",
    },
    coreValidatorImport: CORE_VALIDATOR_IMPORT,
  };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write("usage: resident_dispatcher_wasm_contract.mjs <dispatcher.wasm>\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await verifyResidentDispatcherWasm(path))}\n`);
    } catch (error) {
      process.stderr.write(`resident_dispatcher_wasm_contract: ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    }
  }
}
