// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const ABI_VERSION = 1;
const WASM_PAGE_BYTES = 64 * 1024;
const MEMORY_INITIAL_PAGES = 688;
const MEMORY_MAXIMUM_PAGES = 720;
const MAIN_RAM_OFFSET = 0x0010_0000;
const MAIN_RAM_BYTES = 0x0180_0000;
const MMIO_OFFSET = 0x0190_0000;
const MMIO_BYTES = 0x0002_0000;
const ARAM_OFFSET = 0x01a0_0000;
const ARAM_BYTES = 0x0100_0000;
const RUNTIME_BASE = 0x02a0_0000;
const RUNTIME_END = MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES;

const expectedImports = [
  { module: "lazuli", name: "memory", kind: "memory" },
  {
    module: "lazuli_dsp",
    name: "main_ram_write_completed",
    kind: "function",
  },
];
const expectedFunctionExports = [
  "browser_dsp_abi_version",
  "browser_dsp_aram_bytes",
  "browser_dsp_aram_offset",
  "browser_dsp_exec",
  "browser_dsp_fault_address",
  "browser_dsp_fault_length",
  "browser_dsp_fault_memory_length",
  "browser_dsp_fault_operation",
  "browser_dsp_init",
  "browser_dsp_main_ram_bytes",
  "browser_dsp_main_ram_offset",
  "browser_dsp_memory_bytes",
  "browser_dsp_memory_initial_pages",
  "browser_dsp_memory_maximum_pages",
  "browser_dsp_mmio_bytes",
  "browser_dsp_mmio_offset",
  "browser_dsp_pc",
  "browser_dsp_runtime_base",
  "browser_dsp_runtime_end",
  "browser_dsp_stop_reason",
];

function readLebU32(bytes, cursor) {
  let value = 0;
  let shift = 0;
  while (true) {
    assert.ok(cursor.offset < bytes.length, "truncated wasm LEB128 value");
    const byte = bytes[cursor.offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
    assert.ok(shift < 35, "oversized wasm u32 LEB128 value");
  }
}

function definedMemoryCount(bytes) {
  assert.deepEqual(
    Array.from(bytes.subarray(0, 8)),
    [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    "invalid wasm header",
  );
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const sectionId = bytes[cursor.offset++];
    const sectionBytes = readLebU32(bytes, cursor);
    const sectionEnd = cursor.offset + sectionBytes;
    assert.ok(sectionEnd <= bytes.length, "truncated wasm section");
    if (sectionId === 5) return readLebU32(bytes, cursor);
    cursor.offset = sectionEnd;
  }
  return 0;
}

function importsFor(memory, completions = []) {
  return {
    lazuli: { memory },
    lazuli_dsp: {
      main_ram_write_completed(address, length) {
        completions.push([address >>> 0, length >>> 0]);
      },
    },
  };
}

function compareImports(left, right) {
  return `${left.module}\u0000${left.name}\u0000${left.kind}`.localeCompare(
    `${right.module}\u0000${right.name}\u0000${right.kind}`,
  );
}

function reservedDigest(memory) {
  return createHash("sha256")
    .update(new Uint8Array(memory.buffer, 0, RUNTIME_BASE))
    .digest("hex");
}

function fillReservedMemory(memory) {
  const words = new Uint32Array(memory.buffer, 0, RUNTIME_BASE / 4);
  for (let index = 0; index < words.length; index++) {
    words[index] = (Math.imul(index, 0x9e37_79b1) ^ 0xa55a_c33c) >>> 0;
  }
}

function writeUcode(memory, words) {
  const view = new DataView(memory.buffer);
  const bootstrap = MAIN_RAM_OFFSET + 0x0100_0000;
  new Uint8Array(memory.buffer, bootstrap, 1024).fill(0);
  for (let index = 0; index < words.length; index++) {
    view.setUint16(bootstrap + index * 2, words[index], false);
  }
  view.setUint16(MMIO_OFFSET + 0x500a, 0x0001, false);
}

export async function verifyBrowserDspWasm(path) {
  const bytes = await readFile(path);
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(
    WebAssembly.Module.imports(module).toSorted(compareImports),
    expectedImports.toSorted(compareImports),
  );
  assert.equal(definedMemoryCount(bytes), 0, "DSP wasm defines a second memory");

  const exports = WebAssembly.Module.exports(module);
  assert.deepEqual(
    exports.filter(entry => entry.kind === "function").map(entry => entry.name).sort(),
    expectedFunctionExports.toSorted(),
  );
  assert.deepEqual(
    exports.filter(entry => entry.kind === "global").map(entry => entry.name).sort(),
    ["__data_end", "__heap_base"],
  );
  assert.equal(exports.some(entry => entry.kind === "memory"), false);

  assert.throws(
    () => new WebAssembly.Instance(
      module,
      importsFor(new WebAssembly.Memory({
        initial: MEMORY_INITIAL_PAGES - 1,
        maximum: MEMORY_MAXIMUM_PAGES,
      })),
    ),
    WebAssembly.LinkError,
    "DSP wasm accepted an undersized machine memory",
  );
  assert.throws(
    () => new WebAssembly.Instance(
      module,
      importsFor(new WebAssembly.Memory({
        initial: MEMORY_INITIAL_PAGES,
        maximum: MEMORY_MAXIMUM_PAGES + 1,
      })),
    ),
    WebAssembly.LinkError,
    "DSP wasm accepted a memory whose maximum exceeds its ABI",
  );
  for (const initial of [MEMORY_INITIAL_PAGES + 1, MEMORY_MAXIMUM_PAGES]) {
    const wrongBootstrapMemory = new WebAssembly.Memory({
      initial,
      maximum: MEMORY_MAXIMUM_PAGES,
    });
    const wrongBootstrap = new WebAssembly.Instance(
      module,
      importsFor(wrongBootstrapMemory),
    ).exports;
    assert.equal(
      wrongBootstrap.browser_dsp_init(),
      2,
      `DSP initialized from unsupported ${initial}-page bootstrap memory`,
    );
    assert.equal(wrongBootstrap.browser_dsp_stop_reason(), 5);
  }

  const memory = new WebAssembly.Memory({
    initial: MEMORY_INITIAL_PAGES,
    maximum: MEMORY_MAXIMUM_PAGES,
  });
  fillReservedMemory(memory);
  const cleanReservedDigest = reservedDigest(memory);
  const completions = [];
  const instance = new WebAssembly.Instance(module, importsFor(memory, completions));
  assert.equal(
    reservedDigest(memory),
    cleanReservedDigest,
    "DSP instantiation mutated machine-owned memory",
  );
  const dsp = instance.exports;
  const dataEnd = dsp.__data_end.value;
  const heapBase = dsp.__heap_base.value;
  assert.ok(RUNTIME_BASE <= dataEnd && dataEnd < heapBase);
  assert.ok(heapBase <= MEMORY_INITIAL_PAGES * WASM_PAGE_BYTES);

  assert.equal(dsp.browser_dsp_abi_version(), ABI_VERSION);
  assert.equal(dsp.browser_dsp_memory_initial_pages(), MEMORY_INITIAL_PAGES);
  assert.equal(dsp.browser_dsp_memory_maximum_pages(), MEMORY_MAXIMUM_PAGES);
  assert.equal(dsp.browser_dsp_memory_bytes(), RUNTIME_END);
  assert.equal(dsp.browser_dsp_main_ram_offset(), MAIN_RAM_OFFSET);
  assert.equal(dsp.browser_dsp_main_ram_bytes(), MAIN_RAM_BYTES);
  assert.equal(dsp.browser_dsp_mmio_offset(), MMIO_OFFSET);
  assert.equal(dsp.browser_dsp_mmio_bytes(), MMIO_BYTES);
  assert.equal(dsp.browser_dsp_aram_offset(), ARAM_OFFSET);
  assert.equal(dsp.browser_dsp_aram_bytes(), ARAM_BYTES);
  assert.equal(dsp.browser_dsp_runtime_base(), RUNTIME_BASE);
  assert.equal(dsp.browser_dsp_runtime_end(), RUNTIME_END);
  assert.equal(dsp.browser_dsp_stop_reason(), 5, "uninitialized stop reason is not explicit");

  assert.equal(memory.buffer.byteLength, MEMORY_INITIAL_PAGES * WASM_PAGE_BYTES);
  assert.equal(dsp.browser_dsp_init(), 1);
  assert.equal(
    reservedDigest(memory),
    cleanReservedDigest,
    "DSP initialization mutated machine-owned memory",
  );
  const allocatedPages = memory.buffer.byteLength / WASM_PAGE_BYTES;
  assert.ok(
    MEMORY_INITIAL_PAGES <= allocatedPages && allocatedPages <= MEMORY_MAXIMUM_PAGES,
    "DSP initialization escaped its memory contract",
  );
  assert.equal(dsp.browser_dsp_exec(1), 0, "DSP executed before host memory sealing");
  assert.equal(dsp.browser_dsp_stop_reason(), 6, "pre-seal execution was not diagnosed");
  memory.grow(MEMORY_MAXIMUM_PAGES - allocatedPages);
  assert.equal(memory.buffer.byteLength, RUNTIME_END, "machine memory was not sealed at maximum");
  assert.equal(dsp.browser_dsp_init(), 0, "DSP bridge allowed a second allocating initialization");

  // Real IROM, rather than a JavaScript synthetic reply, must publish the reset greeting and then
  // sleep waiting for the CPU mailbox. Create the DataView only after sealing memory so it cannot
  // be detached by the allocator's one permitted bootstrap growth.
  const view = new DataView(memory.buffer);
  view.setUint32(MMIO_OFFSET + 0x5000, 0, false);
  view.setUint32(MMIO_OFFSET + 0x5004, 0, false);
  view.setUint16(MMIO_OFFSET + 0x500a, 0x0800, false);
  const greetingInstructions = dsp.browser_dsp_exec(64);
  assert.ok(greetingInstructions > 0 && greetingInstructions <= 64);
  assert.equal(dsp.browser_dsp_stop_reason(), 3, "IROM did not stop on an empty CPU mailbox");
  assert.equal(view.getUint32(MMIO_OFFSET + 0x5004, false), 0x8071_feed);
  assert.ok(dsp.browser_dsp_pc() >= 0x8000 && dsp.browser_dsp_pc() < 0x9000);
  assert.deepEqual(completions, []);

  // A real low-reset program must be able to outlive the runner's first two 64-instruction
  // quanta and publish DSP->CPU FULL only when its mailbox-low store actually executes. This
  // synthetic payload models the timing shape of a retail bootstrap without embedding game data.
  view.setUint32(MMIO_OFFSET + 0x5004, 0, false);
  writeUcode(memory, [
    ...new Array(130).fill(0x0000), // nop beyond two complete execution quanta
    0x16fc, 0x1234, // si @dmbh, payload high and clear stale FULL
    0x16fd, 0x5678, // si @dmbl, payload low and set FULL
    0x0021,         // halt after publishing the mailbox
  ]);
  for (let slice = 1; slice <= 2; slice += 1) {
    assert.equal(dsp.browser_dsp_exec(64), 64, `long bootstrap slice ${slice} was truncated`);
    assert.equal(
      dsp.browser_dsp_stop_reason(),
      0,
      `long bootstrap slice ${slice} did not exhaust its instruction budget`,
    );
    assert.equal(
      view.getUint16(MMIO_OFFSET + 0x5004, false) & 0x8000,
      0,
      `long bootstrap published FULL during slice ${slice}`,
    );
  }
  assert.ok(
    dsp.browser_dsp_exec(64) > 0,
    "long bootstrap did not execute its mailbox-publishing tail",
  );
  assert.equal(dsp.browser_dsp_stop_reason(), 1, "long bootstrap did not halt after publishing");
  assert.equal(
    view.getUint32(MMIO_OFFSET + 0x5004, false),
    0x9234_5678,
    "real DSP mailbox-low execution did not publish FULL and its payload",
  );
  assert.deepEqual(completions, [], "mailbox-only bootstrap emitted a main-RAM receipt");

  // Reset low loads this program directly from MEM1. It writes through the accelerator into the
  // shared ARAM window, then DMEM-DMAs into MEM1 and emits the exact host coherency receipt.
  writeUcode(memory, [
    0x16d1, 0x0002, // si @acfmt, 16-bit raw words
    0x16d8, 0x8000, // si @accah, raw-write flag
    0x16d9, 0x0002, // si @accal, word address 2
    0x16d3, 0xaabb, // si @acdraw, sentinel
    0x0080, 0x1122, // lri $AR0, sentinel
    0x00e0, 0x0003, // sr $AR0, DMEM word 3
    0x16c9, 0x0001, // si @dmac, DSP-to-RAM DMEM DMA
    0x16cd, 0x0003, // si @dspa, DMEM word 3
    0x16ce, 0x0000, // si @dsmah, MEM1 address high
    0x16cf, 0x0040, // si @dsmal, MEM1 address low
    0x16cb, 0x0002, // si @dsm, start two-byte DMA
    0x0021,         // halt after DMA service
  ]);
  assert.ok(dsp.browser_dsp_exec(64) > 0);
  assert.equal(dsp.browser_dsp_stop_reason(), 1, "shared-memory probe did not halt");
  assert.equal(view.getUint16(ARAM_OFFSET + 4, false), 0xaabb, "DSP did not write shared ARAM");
  assert.equal(
    view.getUint16(MAIN_RAM_OFFSET + 0x40, false),
    0x1122,
    "DSP did not write shared MEM1",
  );
  assert.deepEqual(completions, [[0x40, 2]]);

  // The opposite ARAM direction starts with a host sentinel and publishes the raw accelerator
  // read through the DSP mailbox. This catches an accidentally copied or misbased ARAM slice.
  view.setUint8(ARAM_OFFSET + 2, 0x7a);
  writeUcode(memory, [
    0x0092, 0x00ff, // lri $CR, 0xff for short IFX addressing
    0x16d1, 0x0001, // si @acfmt, raw bytes
    0x16d8, 0x0000, // si @accah, address high
    0x16d9, 0x0002, // si @accal, byte address 2
    0x16fc, 0x0000, // si @dmbh, clear previous mailbox status
    0x26d3,         // lrs $ACM0, @acdraw
    0x2efd,         // srs @dmbl, $ACM0 and mark the mailbox full
    0x0021,
  ]);
  assert.ok(dsp.browser_dsp_exec(64) > 0);
  assert.equal(dsp.browser_dsp_stop_reason(), 1, "shared ARAM read probe did not halt");
  assert.equal(view.getUint32(MMIO_OFFSET + 0x5004, false), 0x8000_007a);

  // A final low-reset program makes a checked DSP-to-MEM1 DMA cross the exact MEM1 bound.
  // This validates the public fault codes/getters on the compiled artifact, not only their names.
  writeUcode(memory, [
    0x16c9, 0x0001, // si @dmac, DSP-to-RAM DMEM DMA
    0x16cd, 0x0003, // si @dspa, DMEM word 3
    0x16ce, 0x017f, // si @dsmah, last MEM1 byte
    0x16cf, 0xffff, // si @dsmal, last MEM1 byte
    0x16cb, 0x0004, // si @dsm, start out-of-range DMA
    0x0021,
  ]);
  assert.ok(dsp.browser_dsp_exec(64) > 0);
  assert.equal(dsp.browser_dsp_stop_reason(), 4);
  assert.equal(dsp.browser_dsp_fault_operation(), 2);
  assert.equal(dsp.browser_dsp_fault_address(), MAIN_RAM_BYTES - 1);
  assert.equal(dsp.browser_dsp_fault_length(), 4);
  assert.equal(dsp.browser_dsp_fault_memory_length(), MAIN_RAM_BYTES);
  assert.deepEqual(completions, [[0x40, 2]], "faulting DMA emitted a write receipt");

  return {
    abi: ABI_VERSION,
    bytes: bytes.byteLength,
    dataEnd,
    heapBase,
    initializedPages: allocatedPages,
    sealedPages: MEMORY_MAXIMUM_PAGES,
  };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write("usage: browser_dsp_wasm_contract.mjs <browser_dsp.wasm>\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await verifyBrowserDspWasm(path))}\n`);
    } catch (error) {
      process.stderr.write(`browser_dsp_wasm_contract: ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    }
  }
}
