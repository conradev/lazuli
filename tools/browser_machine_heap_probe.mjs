import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const WASM_PAGE_BYTES = 64 * 1024;
const RESIDENT_MEMORY_INITIAL_PAGES = 720;
const RESIDENT_MEMORY_MAXIMUM_PAGES = 2048;
const MAIN_RAM_OFFSET = 0x0010_0000;
const DI_SHAPED_ALLOCATION_BYTES = 24 * 1024 * 1024 + 1;

function usage() {
  process.stderr.write(
    "usage: browser_machine_heap_probe.mjs <browser_machine.wasm> " +
      "[--maximum-pages=<pages>] [--scenario=branch|max64]\n",
  );
  process.exit(2);
}

const [wasmPath, ...options] = process.argv.slice(2);
if (!wasmPath) usage();

let maximumPages = RESIDENT_MEMORY_MAXIMUM_PAGES;
let scenario = "branch";
for (const option of options) {
  if (option.startsWith("--maximum-pages=")) {
    maximumPages = Number.parseInt(option.slice("--maximum-pages=".length), 10);
  } else if (option.startsWith("--scenario=")) {
    scenario = option.slice("--scenario=".length);
  } else {
    usage();
  }
}
if (!Number.isInteger(maximumPages) ||
    maximumPages < RESIDENT_MEMORY_INITIAL_PAGES || maximumPages > 0x3fff) {
  throw new Error(`invalid two-byte Wasm maximum page count ${maximumPages}`);
}
if (scenario !== "branch" && scenario !== "max64") {
  throw new Error(`unknown scenario ${scenario}`);
}

function encodeTwoByteU32(value) {
  if (value < 0x80 || value > 0x3fff) {
    throw new Error(`value ${value} is not a two-byte unsigned LEB128 integer`);
  }
  return [0x80 | (value & 0x7f), value >>> 7];
}

function findSequence(haystack, needle) {
  const matches = [];
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    matches.push(offset);
  }
  if (matches.length !== 1) {
    throw new Error(`expected one imported-memory descriptor, found ${matches.length}`);
  }
  return matches[0];
}

function patchImportedMemoryMaximum(bytes, maximum) {
  // Diagnostic only: this changes the import's growth ceiling without pretending that the
  // module's linked ABI constants changed. Production always uses RESIDENT_MEMORY_MAXIMUM_PAGES.
  const patched = Uint8Array.from(bytes);
  const descriptor = Uint8Array.from([
    0x06, 0x6c, 0x61, 0x7a, 0x75, 0x6c, 0x69, // "lazuli"
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, // "memory"
    0x02, // memory import
    0x01, // minimum and maximum limits
    ...encodeTwoByteU32(RESIDENT_MEMORY_INITIAL_PAGES),
    ...encodeTwoByteU32(RESIDENT_MEMORY_MAXIMUM_PAGES),
  ]);
  const offset = findSequence(patched, descriptor);
  const encodedMaximum = encodeTwoByteU32(maximum);
  patched[offset + descriptor.length - 2] = encodedMaximum[0];
  patched[offset + descriptor.length - 1] = encodedMaximum[1];
  return patched;
}

function pages(memory) {
  return memory.buffer.byteLength / WASM_PAGE_BYTES;
}

function preloadScenario(memory, selectedScenario) {
  const view = new DataView(memory.buffer);
  const instructions = selectedScenario === "max64"
    ? [...Array.from({ length: 63 }, () => 0x3863_0001), 0x4800_0000]
    : [0x4800_0000];
  for (let index = 0; index < instructions.length; index += 1) {
    view.setUint32(MAIN_RAM_OFFSET + index * 4, instructions[index], false);
  }
  return instructions.length;
}

const originalBytes = await readFile(wasmPath);
const bytes = maximumPages === RESIDENT_MEMORY_MAXIMUM_PAGES
  ? originalBytes
  : patchImportedMemoryMaximum(originalBytes, maximumPages);
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
if (JSON.stringify(imports) !== JSON.stringify([{ module: "lazuli", name: "memory", kind: "memory" }])) {
  throw new Error(`unexpected browser-machine imports: ${JSON.stringify(imports)}`);
}
const memory = new WebAssembly.Memory({
  initial: RESIDENT_MEMORY_INITIAL_PAGES,
  maximum: maximumPages,
});
const instructionCount = preloadScenario(memory, scenario);
const core = new WebAssembly.Instance(module, { lazuli: { memory } }).exports;
for (const name of [
  "core_init",
  "core_prepare_current_pc_compile",
  "core_last_compile_status",
  "core_pending_module_bytes",
  "core_compile_request_bytes",
  "core_resident_allocation_probe",
]) {
  if (typeof core[name] !== "function") throw new Error(`missing ${name} export`);
}

const initialPages = pages(memory);
const initStarted = performance.now();
let initStatus = 0;
let initTrap = null;
try {
  initStatus = core.core_init();
} catch (error) {
  initTrap = String(error?.stack ?? error);
}
const initElapsedMs = performance.now() - initStarted;
const initializedPages = pages(memory);
if (initTrap !== null || initStatus !== 1) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    scenario,
    instructionCount,
    maximumPages,
    initialPages,
    initializedPages,
    completedPages: initializedPages,
    runtimeHighWaterBytes: initializedPages * WASM_PAGE_BYTES - 0x02c0_0000,
    initStatus,
    initElapsedMs,
    initTrap,
  })}\n`);
  process.exit(1);
}
const initializedBuffer = memory.buffer;
const residentView = new DataView(initializedBuffer);
const resetPc = residentView.getUint32(core.core_cpu_ptr(), true);
// This diagnostic redirects the repr(C) CPU to preloaded real-mode MEM1. Production keeps the PC
// Rust-owned; the redirect only makes a deterministic cold block available to the heap probe.
residentView.setUint32(core.core_cpu_ptr(), 0, true);
const residentPc = residentView.getUint32(core.core_cpu_ptr(), true);
const residentInstructionBytes = Array.from(new Uint8Array(memory.buffer, MAIN_RAM_OFFSET, 4));
let requestPointer = 0;
let trap = null;
const compileStarted = performance.now();
try {
  requestPointer = core.core_prepare_current_pc_compile();
} catch (error) {
  trap = String(error?.stack ?? error);
}
const compileElapsedMs = performance.now() - compileStarted;
const compiledPages = pages(memory);
const compileStatus = core.core_last_compile_status();
const moduleBytes = core.core_pending_module_bytes();
const requestBytes = core.core_compile_request_bytes();
const compileGrewMemory = memory.buffer !== initializedBuffer;
if (compileGrewMemory && initializedBuffer.byteLength !== 0) {
  throw new Error("cold compile grew memory without detaching the stale host view");
}

let sourcePointer = 0;
let sourceBytes = 0;
let sourceMagic = null;
if (requestPointer !== 0 && requestBytes === 84) {
  // Never retain the pre-call view: Rust allocation may have called memory.grow.
  const request = new DataView(memory.buffer, requestPointer, requestBytes);
  sourcePointer = request.getUint32(40, true);
  sourceBytes = request.getUint32(44, true);
  if (sourcePointer !== 0 && sourceBytes >= 4) {
    sourceMagic = Array.from(new Uint8Array(memory.buffer, sourcePointer, 4));
  }
}

const allocationBuffer = memory.buffer;
const allocationView = new Uint8Array(allocationBuffer, MAIN_RAM_OFFSET, 1);
const allocationProbeStatus = core.core_resident_allocation_probe(DI_SHAPED_ALLOCATION_BYTES);
const completedPages = pages(memory);
const allocationGrewMemory = memory.buffer !== allocationBuffer;
if (allocationGrewMemory && allocationView.byteLength !== 0) {
  throw new Error("resident allocation grew memory without detaching the stale host view");
}
// Reacquire even when this engine happened to satisfy the allocation without growth.
const reacquiredView = new Uint8Array(memory.buffer, MAIN_RAM_OFFSET, 1);

const ok = initStatus === 1 && trap === null && compileStatus === 1 && requestPointer !== 0 &&
  requestBytes === 84 && sourceBytes === moduleBytes &&
  JSON.stringify(sourceMagic) === JSON.stringify([0x00, 0x61, 0x73, 0x6d]) &&
  allocationProbeStatus === 1 && reacquiredView.byteLength === 1;
process.stdout.write(`${JSON.stringify({
  ok,
  scenario,
  instructionCount,
  maximumPages,
  initialPages,
  initializedPages,
  compiledPages,
  completedPages,
  runtimeBytesAtInitialization: initializedPages * WASM_PAGE_BYTES - 0x02c0_0000,
  runtimeHighWaterBytes: completedPages * WASM_PAGE_BYTES - 0x02c0_0000,
  remainingPagesAfterInitialization: maximumPages - initializedPages,
  remainingPagesAfterCompile: maximumPages - compiledPages,
  remainingPagesAfterAllocation: maximumPages - completedPages,
  initStatus,
  initTrap,
  resetPc,
  residentPc,
  residentInstructionBytes,
  initElapsedMs,
  compileElapsedMs,
  compileGrewMemory,
  compileStatus,
  requestPointer,
  requestBytes,
  moduleBytes,
  sourcePointer,
  sourceBytes,
  sourceMagic,
  trap,
  allocationProbeBytes: DI_SHAPED_ALLOCATION_BYTES,
  allocationProbeStatus,
  allocationGrewMemory,
  staleAllocationViewDetached: allocationGrewMemory ? allocationView.byteLength === 0 : null,
  hostViewReacquired: reacquiredView.byteLength === 1,
})}\n`);
if (!ok) process.exitCode = 1;
