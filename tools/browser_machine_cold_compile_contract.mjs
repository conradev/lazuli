import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const RESIDENT_MEMORY_INITIAL_PAGES = 720;
const RESIDENT_MEMORY_MAXIMUM_PAGES = 2048;

function encodeTwoByteU32(value) {
  if (value < 0x80 || value > 0x3fff) {
    throw new Error(`resident memory limit ${value} is not a two-byte ULEB integer`);
  }
  return [0x80 | (value & 0x7f), value >>> 7];
}

function assertExactResidentMemoryImport(bytes, label) {
  const descriptor = Uint8Array.from([
    0x06, 0x6c, 0x61, 0x7a, 0x75, 0x6c, 0x69,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
    0x02,
    0x01,
    ...encodeTwoByteU32(RESIDENT_MEMORY_INITIAL_PAGES),
    ...encodeTwoByteU32(RESIDENT_MEMORY_MAXIMUM_PAGES),
  ]);
  let matches = 0;
  outer: for (let offset = 0; offset <= bytes.length - descriptor.length; offset += 1) {
    for (let index = 0; index < descriptor.length; index += 1) {
      if (bytes[offset + index] !== descriptor[index]) continue outer;
    }
    matches += 1;
  }
  if (matches !== 1) {
    throw new Error(`${label} has ${matches} exact resident memory descriptors`);
  }
}

const [wasmPath, dispatcherPath, coordinatorPath] = process.argv.slice(2);
if (!wasmPath || !dispatcherPath || !coordinatorPath) {
  process.stderr.write(
    "usage: browser_machine_cold_compile_contract.mjs " +
      "<browser_machine.wasm> <dispatcher.wasm> <core_run_coordinator.wasm>\n",
  );
  process.exit(2);
}

const [bytes, dispatcherBytes, coordinatorBytes] = await Promise.all([
  readFile(wasmPath),
  readFile(dispatcherPath),
  readFile(coordinatorPath),
]);
assertExactResidentMemoryImport(bytes, "core");
assertExactResidentMemoryImport(dispatcherBytes, "dispatcher");
assertExactResidentMemoryImport(coordinatorBytes, "coordinator");
const coreModule = new WebAssembly.Module(bytes);
const memory = new WebAssembly.Memory({
  initial: RESIDENT_MEMORY_INITIAL_PAGES,
  maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
});
// BrowserMachine's mapped MEM1 window starts here. The real reset PC remains in IPL until the
// explicit fixture-only redirect below.
new Uint8Array(memory.buffer, 0x0010_0000, 4).set([0x48, 0x00, 0x00, 0x00]);
const core = new WebAssembly.Instance(coreModule, { lazuli: { memory } }).exports;

// The Rust-generated dispatcher is instantiated before initialization so core_init remains the
// sole authority that clears its fixed directory. Its table is only grown here; the host never
// writes a function into it.
const dispatcherModule = new WebAssembly.Module(dispatcherBytes);
const dispatcher = new WebAssembly.Instance(dispatcherModule, {
  lazuli: {
    memory,
    validate_instruction_page_dependency: core.validate_instruction_page_dependency,
  },
}).exports;
if (!(dispatcher.blocks instanceof WebAssembly.Table)) {
  throw new Error("Rust dispatcher did not export its typed resident-block table");
}
if (dispatcher.blocks.length > 4096) {
  throw new Error(`dispatcher table exceeded Rust slot capacity: ${dispatcher.blocks.length}`);
}
if (dispatcher.blocks.length < 4096) {
  dispatcher.blocks.grow(4096 - dispatcher.blocks.length);
}

// The third Rust-generated module breaks the core<->dispatcher instantiation cycle. Its function
// imports are direct exports of the two already-instantiated Wasm modules; JavaScript supplies no
// CPU/context/fastmem pointer, generation, PC offset, or effective budget.
const coordinatorModule = new WebAssembly.Module(coordinatorBytes);
const coordinatorImports = WebAssembly.Module.imports(coordinatorModule);
const expectedCoordinatorImports = [
  { module: "lazuli", name: "memory", kind: "memory" },
  { module: "lazuli_core", name: "core_begin_slice", kind: "function" },
  { module: "lazuli_core", name: "core_finish_slice", kind: "function" },
  { module: "lazuli_core", name: "core_current_run_outcome", kind: "function" },
  { module: "lazuli_dispatch", name: "run", kind: "function" },
];
if (JSON.stringify(coordinatorImports) !== JSON.stringify(expectedCoordinatorImports)) {
  throw new Error(`coordinator import boundary changed: ${JSON.stringify(coordinatorImports)}`);
}
const coordinator = new WebAssembly.Instance(coordinatorModule, {
  lazuli: { memory },
  lazuli_core: {
    core_begin_slice: core.core_begin_slice,
    core_finish_slice: core.core_finish_slice,
    core_current_run_outcome: core.core_current_run_outcome,
  },
  lazuli_dispatch: { run: dispatcher.run },
}).exports;

if (core.core_compile_request_bytes() !== 84) {
  throw new Error(`unexpected CompileRequest size ${core.core_compile_request_bytes()}`);
}
if (core.core_init() !== 1) {
  throw new Error("browser machine did not initialize for cold compile");
}
// The mapped test core starts at the real IPL reset vector, whose storage is deliberately outside
// the resident JIT backing contract. This native contract fixture redirects the repr(C) CPU's
// first word (PC) to the branch preloaded at guest MEM1 zero; production PC remains Rust-owned.
new DataView(memory.buffer).setUint32(core.core_cpu_ptr(), 0, true);

const pagesBefore = memory.buffer.byteLength / 65536;
const started = performance.now();
const view = new DataView(memory.buffer);
const readOutcome = (pointer) => ({
  abiVersion: view.getUint32(pointer, true),
  byteLength: view.getUint32(pointer + 4, true),
  reason: view.getUint32(pointer + 8, true),
  detail: view.getUint32(pointer + 12, true),
  cycles: view.getBigUint64(pointer + 16, true),
  instructions: view.getBigUint64(pointer + 24, true),
  requestPointer: view.getUint32(pointer + 32, true),
  reserved: view.getUint32(pointer + 36, true),
});
let firstOutcomePointer;
try {
  firstOutcomePointer = coordinator.core_run(1_000_000n, 1);
} catch (error) {
  const evidence = {
    ok: false,
    trap: String(error?.stack ?? error),
    pagesBefore,
    pagesAfter: memory.buffer.byteLength / 65536,
    maximumPages: RESIDENT_MEMORY_MAXIMUM_PAGES,
    elapsedMs: performance.now() - started,
  };
  process.stderr.write(`${JSON.stringify(evidence)}\n`);
  process.exit(1);
}
const elapsedMs = performance.now() - started;
const pagesAfter = memory.buffer.byteLength / 65536;
const firstOutcome = readOutcome(firstOutcomePointer);
if (firstOutcome.abiVersion !== core.core_abi_version() || firstOutcome.byteLength !== 40 ||
    firstOutcome.reason !== 1 || firstOutcome.detail !== 2 || firstOutcome.cycles !== 0n ||
    firstOutcome.instructions !== 0n || firstOutcome.reserved !== 0) {
  throw new Error(`sealed cold-miss outcome mismatch: ${JSON.stringify({
    ...firstOutcome,
    cycles: firstOutcome.cycles.toString(),
    instructions: firstOutcome.instructions.toString(),
  })}`);
}
const requestPointer = firstOutcome.requestPointer;
if (requestPointer === 0 || core.core_last_compile_status() !== 1) {
  throw new Error(
    `Rust cold compile failed without a trap: ptr=${requestPointer} status=${core.core_last_compile_status()}`,
  );
}
if (core.core_pending_compile_request_bytes() !== core.core_compile_request_bytes()) {
  throw new Error("Rust did not retain exactly one host-visible CompileRequest");
}

const requestBytes = core.core_compile_request_bytes();
if (requestPointer < core.core_runtime_base() || requestPointer + requestBytes > memory.buffer.byteLength) {
  throw new Error(`CompileRequest pointer 0x${requestPointer.toString(16)} is outside Rust memory`);
}
const u32 = (offset) => view.getUint32(requestPointer + offset, true);
if (u32(0) !== core.core_abi_version() || u32(4) !== requestBytes) {
  throw new Error("CompileRequest header is not the current fixed ABI");
}
const request = {
  requestId: u32(8),
  tableSlot: u32(12),
  slotNonceLo: u32(16),
  slotNonceHi: u32(20),
  generationLo: u32(24),
  generationHi: u32(28),
  installTokenLo: u32(32),
  installTokenHi: u32(36),
  modulePointer: u32(40),
  moduleBytes: u32(44),
};
if (request.requestId === 0 || request.slotNonceLo === 0 ||
    (request.installTokenLo === 0 && request.installTokenHi === 0) ||
    request.generationLo !== 1 || request.generationHi !== 0) {
  throw new Error(`invalid Rust-issued request identity: ${JSON.stringify(request)}`);
}
if (request.modulePointer === 0 || request.moduleBytes !== core.core_pending_module_bytes() ||
    request.modulePointer + request.moduleBytes > memory.buffer.byteLength) {
  throw new Error(`invalid retained module slice: ${JSON.stringify(request)}`);
}

const moduleBytes = new Uint8Array(memory.buffer, request.modulePointer, request.moduleBytes);
const digest = createHash("sha256").update(moduleBytes).digest();
for (let index = 0; index < 8; index += 1) {
  const rustWord = u32(48 + index * 4);
  const expectedWord = digest.readUInt32BE(index * 4);
  if (rustWord !== expectedWord) {
    throw new Error(`Rust SHA-256 word ${index} did not match its retained module`);
  }
}

const residentModule = new WebAssembly.Module(moduleBytes);
assertExactResidentMemoryImport(moduleBytes, "self-installing block");
const imports = WebAssembly.Module.imports(residentModule);
const exports = WebAssembly.Module.exports(residentModule);
if (imports.some((item) => item.module !== "lazuli") ||
    !imports.some((item) => item.name === "memory" && item.kind === "memory") ||
    !imports.some((item) => item.name === "blocks" && item.kind === "table") ||
    !imports.some((item) => item.name === "begin_resident_block_install" && item.kind === "function") ||
    !imports.some((item) => item.name === "commit_resident_block_install" && item.kind === "function")) {
  throw new Error(`resident block crossed an invalid import boundary: ${JSON.stringify(imports)}`);
}
if (!exports.some((item) => item.name === "run" && item.kind === "function") ||
    !exports.some((item) => item.name === "install" && item.kind === "function")) {
  throw new Error(`resident block is not self-installing: ${JSON.stringify(exports)}`);
}

const rejectedPointer = core.core_prepare_current_pc_compile();
if (rejectedPointer !== 0 || core.core_last_compile_status() !== 2) {
  throw new Error("a second cold compile bypassed the one-pending-request invariant");
}

const resident = new WebAssembly.Instance(residentModule, {
  lazuli: {
    memory,
    begin_resident_block_install: core.begin_resident_block_install,
    commit_resident_block_install: core.commit_resident_block_install,
    blocks: dispatcher.blocks,
  },
}).exports;
const committed = resident.install() >>> 0;
if (committed !== 0x4c5a_434d) {
  throw new Error(`self-installer did not commit through Rust: 0x${committed.toString(16)}`);
}
if (dispatcher.blocks.get(request.tableSlot) !== resident.run) {
  throw new Error("resident module did not install its own typed run function");
}
if (core.core_pending_module_bytes() !== 0 || core.core_pending_compile_request_bytes() !== 0) {
  throw new Error("Rust retained consumed module/request bytes after commit");
}

const slotBase = core.core_dispatch_slot_identity_offset();
const slotStride = core.core_dispatch_slot_identity_bytes() / core.core_dispatch_slot_capacity();
const slotPointer = slotBase + request.tableSlot * slotStride;
const slotU32 = (offset) => view.getUint32(slotPointer + offset, true);
if (slotStride !== 32 || slotU32(0) !== 0x4c5a_534c || slotU32(4) !== 0 ||
    slotU32(8) !== request.generationLo || slotU32(12) !== request.generationHi ||
    slotU32(16) !== request.slotNonceLo || slotU32(20) !== request.slotNonceHi) {
  throw new Error("Rust did not publish the exact READY table-slot identity");
}

const metadataBase = core.core_dispatch_metadata_offset();
const metadataCapacity = core.core_dispatch_entry_capacity();
const metadataStride = core.core_dispatch_metadata_bytes() / metadataCapacity;
const published = [];
for (let index = 0; index < metadataCapacity; index += 1) {
  const pointer = metadataBase + index * metadataStride;
  if (view.getUint32(pointer, true) === 0x4c5a_454e) published.push({ index, pointer });
}
if (metadataStride !== 56 || published.length !== 1) {
  throw new Error(`expected one Rust READY cache record, found ${published.length}`);
}
const record = published[0];
const recordU32 = (offset) => view.getUint32(record.pointer + offset, true);
if (recordU32(4) !== 0 || recordU32(8) !== 0 ||
    recordU32(12) !== request.generationLo || recordU32(16) !== request.generationHi ||
    recordU32(20) !== request.tableSlot || recordU32(24) !== request.slotNonceLo ||
    recordU32(28) !== request.slotNonceHi || recordU32(32) === 0 || recordU32(36) !== 0) {
  throw new Error("Rust READY cache record does not match the committed cold block");
}

const maximumExecuted = recordU32(32);
const expectedInstructions = maximumExecuted & 0xffff;
const expectedCycles = maximumExecuted >>> 16;
const cpuPointer = core.core_cpu_ptr();
const secondOutcomePointer = coordinator.core_run(1_000_000n, 1);
const secondOutcome = readOutcome(secondOutcomePointer);
const executedInstructions = secondOutcome.instructions;
const executedCycles = secondOutcome.cycles;
const executedBlocks = 1;
const dispatchReason = secondOutcome.detail;
if (secondOutcomePointer !== firstOutcomePointer || secondOutcome.reason !== 0 ||
    executedInstructions !== BigInt(expectedInstructions) ||
    executedCycles !== BigInt(expectedCycles) || dispatchReason !== 0 ||
    secondOutcome.requestPointer !== 0 || secondOutcome.reserved !== 0 ||
    view.getUint32(cpuPointer, true) !== 0) {
  throw new Error(`sealed dynamic resident run mismatch: ${JSON.stringify({
    outcomePointer: secondOutcomePointer,
    reason: secondOutcome.reason,
    executedInstructions: executedInstructions.toString(),
    executedCycles: executedCycles.toString(),
    executedBlocks,
    dispatchReason,
    pc: view.getUint32(cpuPointer, true),
  })}`);
}

// A browser compile/instantiate/install failure can cancel only the exact Rust-issued identity.
// Compile the replacement module before cancelling so its later installer models a delayed host
// completion. It must never clear the already committed block or publish its own table entry.
const cancelledPointer = core.core_prepare_current_pc_compile();
if (cancelledPointer === 0 || core.core_last_compile_status() !== 1) {
  throw new Error("Rust did not issue the cancellation fixture request");
}
const cancelledU32 = (offset) => view.getUint32(cancelledPointer + offset, true);
const cancelledRequest = {
  requestId: cancelledU32(8),
  tableSlot: cancelledU32(12),
  slotNonceLo: cancelledU32(16),
  slotNonceHi: cancelledU32(20),
  generationLo: cancelledU32(24),
  generationHi: cancelledU32(28),
  installTokenLo: cancelledU32(32),
  installTokenHi: cancelledU32(36),
  modulePointer: cancelledU32(40),
  moduleBytes: cancelledU32(44),
};
const delayedModule = new WebAssembly.Module(new Uint8Array(
  memory.buffer,
  cancelledRequest.modulePointer,
  cancelledRequest.moduleBytes,
));
const cancel = (identity) => core.cancel_resident_block_install(
  identity.requestId,
  identity.tableSlot,
  identity.slotNonceLo,
  identity.slotNonceHi,
  identity.generationLo,
  identity.generationHi,
  identity.installTokenLo,
  identity.installTokenHi,
) >>> 0;
if (cancel({ ...cancelledRequest, installTokenHi: cancelledRequest.installTokenHi ^ 1 }) !== 1 ||
    core.core_pending_module_bytes() !== cancelledRequest.moduleBytes) {
  throw new Error("a wrong cancellation identity consumed the Rust request");
}
const cancelled = cancel(cancelledRequest);
if (cancelled !== 0x4c5a_4341 || core.core_pending_module_bytes() !== 0 ||
    core.core_pending_compile_request_bytes() !== 0) {
  throw new Error(`exact cancellation failed closed: 0x${cancelled.toString(16)}`);
}
const delayed = new WebAssembly.Instance(delayedModule, {
  lazuli: {
    memory,
    begin_resident_block_install: core.begin_resident_block_install,
    commit_resident_block_install: core.commit_resident_block_install,
    blocks: dispatcher.blocks,
  },
}).exports;
if (delayed.install() !== 0 || dispatcher.blocks.get(cancelledRequest.tableSlot) !== null ||
    dispatcher.blocks.get(request.tableSlot) !== resident.run) {
  throw new Error("a delayed cancelled module changed the typed table");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  coreBytes: bytes.length,
  coordinatorBytes: coordinatorBytes.length,
  coordinatorImports,
  residentMemoryImportContract: {
    initialPages: RESIDENT_MEMORY_INITIAL_PAGES,
    maximumPages: RESIDENT_MEMORY_MAXIMUM_PAGES,
    exactModules: ["core", "dispatcher", "coordinator", "self-installing block"],
  },
  pagesBefore,
  pagesAfter,
  maximumPages: RESIDENT_MEMORY_MAXIMUM_PAGES,
  freePagesAfter: RESIDENT_MEMORY_MAXIMUM_PAGES - pagesAfter,
  freeBytesAfter: (RESIDENT_MEMORY_MAXIMUM_PAGES - pagesAfter) * 65536,
  elapsedMs,
  request,
  committed,
  publishedDirectoryIndex: record.index,
  tableLength: dispatcher.blocks.length,
  pendingModuleBytesAfterInstall: core.core_pending_module_bytes(),
  pendingRequestBytesAfterInstall: core.core_pending_compile_request_bytes(),
  cancellation: {
    status: cancelled,
    delayedInstallStatus: 0,
    tableSlot: cancelledRequest.tableSlot,
  },
  dispatch: {
    instructions: executedInstructions.toString(),
    cycles: executedCycles.toString(),
    blocks: executedBlocks,
    reason: dispatchReason,
    pc: view.getUint32(cpuPointer, true),
    publicArguments: ["cycleUpperCap", "blockUpperCap"],
    semanticHostArguments: 0,
    directWasmCalls: 2,
  },
  sha256: digest.toString("hex"),
  imports,
  exports,
})}\n`);
