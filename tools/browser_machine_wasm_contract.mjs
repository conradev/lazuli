import { readFile } from "node:fs/promises";

const RESIDENT_MEMORY_INITIAL_PAGES = 720;
const RESIDENT_MEMORY_MAXIMUM_PAGES = 2048;
const WASM_PAGE_BYTES = 64 * 1024;

const [wasmPath] = process.argv.slice(2);
if (!wasmPath) {
  process.stderr.write("usage: browser_machine_wasm_contract.mjs <browser_machine.wasm>\n");
  process.exit(2);
}

const bytes = await readFile(wasmPath);
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
const expectedImports = [{ module: "lazuli", name: "memory", kind: "memory" }];
if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
  throw new Error(`browser machine crossed an unaudited import boundary: ${JSON.stringify(imports)}`);
}
const overbroadMemory = new WebAssembly.Memory({
  initial: RESIDENT_MEMORY_INITIAL_PAGES,
  maximum: RESIDENT_MEMORY_MAXIMUM_PAGES + 1,
});
let overbroadImportRejected = false;
try {
  new WebAssembly.Instance(module, { lazuli: { memory: overbroadMemory } });
} catch (error) {
  overbroadImportRejected = error instanceof WebAssembly.LinkError;
}
if (!overbroadImportRejected) {
  throw new Error("browser machine did not enforce its linked 2048-page resident ceiling");
}

const exported = new Map(WebAssembly.Module.exports(module).map((item) => [item.name, item.kind]));
const requiredFunctions = [
  "core_abi_version",
  "core_compile_request_bytes",
  "core_disc_boot_max_chunk_bytes",
  "core_di_max_chunk_bytes",
  "core_memory_initial_pages",
  "core_memory_maximum_pages",
  "core_memory_bytes",
  "core_machine_evidence_bytes",
  "core_machine_evidence_snapshot",
  "core_resident_allocation_probe",
  "core_dispatch_metadata_offset",
  "core_dispatch_metadata_bytes",
  "core_dispatch_entry_capacity",
  "core_dispatch_slot_identity_offset",
  "core_dispatch_slot_identity_bytes",
  "core_dispatch_slot_capacity",
  "core_dispatch_reserved_end",
  "core_resident_context_bytes",
  "core_resident_stack_scratch_offset",
  "core_resident_stack_scratch_bytes",
  "core_main_ram_offset",
  "core_main_ram_bytes",
  "core_mmio_offset",
  "core_mmio_bytes",
  "core_l2c_offset",
  "core_l2c_bytes",
  "core_machine_reserved_end",
  "core_ipl_offset",
  "core_ipl_bytes",
  "core_aram_offset",
  "core_aram_bytes",
  "core_runtime_base",
  "core_runtime_end",
  "core_init",
  "core_disc_boot_begin",
  "core_disc_boot_cancel",
  "core_disc_boot_status",
  "core_disc_boot_fault",
  "core_disc_boot_pending_count",
  "core_disc_boot_request_epoch_lo",
  "core_disc_boot_request_epoch_hi",
  "core_disc_boot_request_id_lo",
  "core_disc_boot_request_id_hi",
  "core_disc_boot_request_container_offset_lo",
  "core_disc_boot_request_container_offset_hi",
  "core_disc_boot_request_length",
  "core_disc_boot_staging_ptr",
  "core_disc_boot_complete",
  "core_di_pending_count",
  "core_di_request_epoch_lo",
  "core_di_request_epoch_hi",
  "core_di_request_id_lo",
  "core_di_request_id_hi",
  "core_di_request_container_offset_lo",
  "core_di_request_container_offset_hi",
  "core_di_request_length",
  "core_di_staging_ptr",
  "core_di_complete",
  "core_di_resident_payload_bytes",
  "core_di_resident_payload_capacity_bytes",
  "core_input_publish",
  "core_render_pending_count",
  "core_render_request_ptr",
  "core_render_complete",
  "core_address_space_generation_lo",
  "core_address_space_generation_hi",
  "core_context_ptr",
  "core_cpu_ptr",
  "core_fastmem_ptr",
  "core_begin_slice",
  "core_finish_slice",
  "core_current_run_outcome",
  "core_prepare_current_pc_compile",
  "core_last_compile_status",
  "core_pending_module_bytes",
  "core_pending_compile_request_bytes",
  "validate_instruction_page_dependency",
  "begin_resident_block_install",
  "cancel_resident_block_install",
  "commit_resident_block_install",
  ...Array.from({ length: 26 }, (_unused, index) => `user_0_${index + 3}`),
  "user_1_0",
];
for (const name of requiredFunctions) {
  if (exported.get(name) !== "function") {
    throw new Error(`missing integer-only browser-machine function export ${name}`);
  }
}
for (const name of ["core_di_probe_begin_maximum", "core_di_probe_finish_maximum"]) {
  if (exported.has(name)) {
    throw new Error(`production browser machine exposed contract-only DI semantic entry ${name}`);
  }
}

const memory = new WebAssembly.Memory({
  initial: RESIDENT_MEMORY_INITIAL_PAGES,
  maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
});
const instance = new WebAssembly.Instance(module, { lazuli: { memory } });
const core = instance.exports;
const wrongSizeMemory = new WebAssembly.Memory({
  initial: RESIDENT_MEMORY_INITIAL_PAGES + 1,
  maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
});
const wrongSizeCore = new WebAssembly.Instance(module, { lazuli: { memory: wrongSizeMemory } }).exports;
if (wrongSizeCore.core_init() !== 2 || wrongSizeCore.core_address_space_generation_lo() !== 0) {
  throw new Error("core_init did not reject a noncanonical imported-memory size before ownership");
}
const expectedLayout = new Map([
  ["core_abi_version", 1],
  ["core_compile_request_bytes", 84],
  ["core_disc_boot_max_chunk_bytes", 0x00040000],
  ["core_di_max_chunk_bytes", 0x00040000],
  ["core_memory_initial_pages", RESIDENT_MEMORY_INITIAL_PAGES],
  ["core_memory_maximum_pages", RESIDENT_MEMORY_MAXIMUM_PAGES],
  ["core_memory_bytes", RESIDENT_MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES],
  ["core_machine_evidence_bytes", 816],
  ["core_dispatch_metadata_offset", 0x00040000],
  ["core_dispatch_metadata_bytes", 0x00038000],
  ["core_dispatch_entry_capacity", 4096],
  ["core_dispatch_slot_identity_offset", 0x00078000],
  ["core_dispatch_slot_identity_bytes", 0x00020000],
  ["core_dispatch_slot_capacity", 4096],
  ["core_dispatch_reserved_end", 0x000a0000],
  ["core_resident_context_bytes", 0x1000],
  ["core_resident_stack_scratch_offset", 0x0800],
  ["core_resident_stack_scratch_bytes", 0x0800],
  ["core_main_ram_offset", 0x00100000],
  ["core_main_ram_bytes", 0x01800000],
  ["core_mmio_offset", 0x01900000],
  ["core_mmio_bytes", 0x00020000],
  ["core_l2c_offset", 0x01920000],
  ["core_l2c_bytes", 0x00004000],
  ["core_machine_reserved_end", 0x01a00000],
  ["core_ipl_offset", 0x01a00000],
  ["core_ipl_bytes", 0x00200000],
  ["core_aram_offset", 0x01c00000],
  ["core_aram_bytes", 0x01000000],
  ["core_runtime_base", 0x02c00000],
  ["core_runtime_end", RESIDENT_MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES],
]);
for (const [name, expected] of expectedLayout) {
  const actual = core[name]();
  if (actual !== expected) {
    throw new Error(`${name} returned 0x${actual.toString(16)}, expected 0x${expected.toString(16)}`);
  }
}

if (core.core_address_space_generation_lo() !== 0 ||
    core.core_address_space_generation_hi() !== 0 ||
    core.core_context_ptr() !== 0 ||
    core.core_cpu_ptr() !== 0 ||
    core.core_fastmem_ptr() !== 0 ||
    core.core_begin_slice(1n, 1) !== 0 ||
    core.core_finish_slice(1n, 0n, 0n, 0, 2) !== 0 ||
    core.core_current_run_outcome() !== 0 ||
    core.core_prepare_current_pc_compile() !== 0 ||
    core.core_last_compile_status() !== 0 ||
    core.core_pending_module_bytes() !== 0 ||
    core.core_pending_compile_request_bytes() !== 0 ||
    core.core_machine_evidence_snapshot() !== 0 ||
    core.core_resident_allocation_probe(24 * 1024 * 1024) !== 0 ||
    core.core_disc_boot_begin(0, 0) !== 0 ||
    core.core_disc_boot_cancel() !== 0 ||
    core.core_disc_boot_status() !== 0 ||
    core.core_disc_boot_fault() !== 0 ||
    core.core_disc_boot_pending_count() !== 0 ||
    core.core_disc_boot_request_length(0) !== 0 ||
    core.core_disc_boot_staging_ptr(0, 0, 0, 0, 0, 0, 0) !== 0 ||
    core.core_disc_boot_complete(0, 0, 0, 0, 0, 0, 0, 0) !== 0 ||
    core.core_di_pending_count() !== 0 ||
    core.core_di_request_length(0) !== 0 ||
    core.core_di_staging_ptr(0, 0, 0, 0, 0, 0, 0) !== 0 ||
    core.core_di_complete(0, 0, 0, 0, 0, 0, 0, 0, 0) !== 0 ||
    core.core_di_resident_payload_bytes() !== 0 ||
    core.core_di_resident_payload_capacity_bytes() !== 0 ||
    core.core_input_publish(1, 0, 0, 0x80808080, 0) !== 0 ||
    core.cancel_resident_block_install(0, 0, 0, 0, 0, 0, 0, 0) !== 0 ||
    core.validate_instruction_page_dependency(0x80001000, 0x00001000) !== 0) {
  throw new Error("uninitialized browser machine did not fail closed");
}
new Uint8Array(memory.buffer, 0x00040000, 0x00038000).fill(0xa5);
new Uint8Array(memory.buffer, 0x00078000, 0x00020000).fill(0x5a);
const preloadSentinels = new Map([
  [0x00100040, 0x11],
  [0x01920020, 0x22],
  [0x01a00020, 0x33],
  [0x01c00040, 0x44],
]);
for (const [offset, value] of preloadSentinels) {
  new Uint8Array(memory.buffer, offset, 1)[0] = value;
}
if (core.core_init() !== 1) {
  throw new Error("first core_init did not initialize the Rust machine");
}
const pagesAfterInitialization = memory.buffer.byteLength / 65536;
if (new Uint8Array(memory.buffer, 0x00040000, 0x00038000).some((byte) => byte !== 0) ||
    new Uint8Array(memory.buffer, 0x00078000, 0x00020000).some((byte) => byte !== 0)) {
  throw new Error("core_init published Ready before clearing the canonical dispatch directory");
}
for (const [offset, expected] of preloadSentinels) {
  const actual = new Uint8Array(memory.buffer, offset, 1)[0];
  if (actual !== expected) {
    throw new Error(`core_init did not preserve preloaded mapped byte at 0x${offset.toString(16)}`);
  }
}
if (core.core_init() !== 0) {
  throw new Error("second core_init did not preserve one-shot ownership");
}
if (core.core_address_space_generation_lo() !== 1 ||
    core.core_address_space_generation_hi() !== 0) {
  throw new Error("initial instruction address-space generation was not synchronized in Rust");
}
const machineEvidenceBytes = core.core_machine_evidence_bytes();
const firstMachineEvidencePointer = core.core_machine_evidence_snapshot();
if (machineEvidenceBytes !== 816 ||
    firstMachineEvidencePointer === 0 ||
    firstMachineEvidencePointer % 8 !== 0 ||
    firstMachineEvidencePointer + machineEvidenceBytes > memory.buffer.byteLength) {
  throw new Error(
    `invalid Rust-owned machine evidence snapshot: ptr=0x${firstMachineEvidencePointer.toString(16)} ` +
      `bytes=${machineEvidenceBytes}`,
  );
}
const firstMachineEvidence = new Uint8Array(
  memory.buffer,
  firstMachineEvidencePointer,
  machineEvidenceBytes,
).slice();
const centeredControllerSticks = 0x80808080;
const inputResults = {
  equivalent: core.core_input_publish(1, 0, 0, centeredControllerSticks, 0),
  queued: core.core_input_publish(2, 0, 0x0100, centeredControllerSticks, 0),
  coalesced: core.core_input_publish(3, 0, 0x0100, centeredControllerSticks, 0),
  stale: core.core_input_publish(3, 0, 0x0200, centeredControllerSticks, 0),
  reserved: core.core_input_publish(4, 0, 0x0080, centeredControllerSticks, 0),
};
if (inputResults.equivalent !== 3 || inputResults.queued !== 1 ||
    inputResults.coalesced !== 2 || inputResults.stale !== 0 || inputResults.reserved !== 0) {
  throw new Error(`controller publication result contract drifted: ${JSON.stringify(inputResults)}`);
}
const retainedMachineEvidence = new Uint8Array(
  memory.buffer,
  firstMachineEvidencePointer,
  machineEvidenceBytes,
);
if (!retainedMachineEvidence.every((byte, index) => byte === firstMachineEvidence[index])) {
  throw new Error("machine mutation changed the stable snapshot before an explicit snapshot call");
}
const secondMachineEvidencePointer = core.core_machine_evidence_snapshot();
if (secondMachineEvidencePointer !== firstMachineEvidencePointer) {
  throw new Error("machine evidence snapshot pointer was not stable across explicit copies");
}
const secondMachineEvidence = new Uint8Array(
  memory.buffer,
  secondMachineEvidencePointer,
  machineEvidenceBytes,
);
if (secondMachineEvidence.every((byte, index) => byte === firstMachineEvidence[index])) {
  throw new Error("explicit machine evidence snapshot did not publish the newer serial/state");
}
const residentPointers = [
  core.core_context_ptr(),
  core.core_cpu_ptr(),
  core.core_fastmem_ptr(),
];
for (const pointer of residentPointers) {
  if (!Number.isInteger(pointer) || pointer < core.core_runtime_base() ||
      pointer >= memory.buffer.byteLength || pointer % 4 !== 0) {
    throw new Error(`invalid Rust-owned resident pointer 0x${pointer.toString(16)}`);
  }
}
if (new Set(residentPointers).size !== residentPointers.length) {
  throw new Error("resident context, CPU, and fastmem pointers unexpectedly alias");
}
if (core.core_context_ptr() !== residentPointers[0] ||
    core.core_cpu_ptr() !== residentPointers[1] ||
    core.core_fastmem_ptr() !== residentPointers[2]) {
  throw new Error("Rust-owned resident pointers were not stable across calls");
}
if (core.validate_instruction_page_dependency(0x80001000, 0x00001000) !== 0) {
  throw new Error("real-mode dependency was incorrectly accepted after initialization");
}

const context = residentPointers[0];
const scratch = context + core.core_resident_stack_scratch_offset();
const ramBase = core.core_main_ram_offset();
const dataView = new DataView(memory.buffer);

// Raw exports authenticate pointer shape before they authenticate semantic dispatch authority.
// Keep this direct-call vector deliberately outside a run plan: an invalid output must request an
// exit without touching scratch, and even a valid private output must not execute guest semantics.
dataView.setUint32(ramBase + 0x100, 0x11223344, false);
dataView.setUint32(scratch, 0xa5a55a5a, true);
if (core.user_0_5(context, 0x100, context + 16) !== 0 ||
    dataView.getUint32(scratch, true) !== 0xa5a55a5a ||
    dataView.getUint32(context + 4, true) !== 1) {
  throw new Error("resident hook accepted an output outside Rust-owned scratch or failed to exit");
}

// Reset only the adversarial shared exit word so the next direct call proves the independent
// Dispatching-plan gate. Production JavaScript never writes this Rust-owned control record.
dataView.setUint32(context + 4, 0, true);
const rawRead = core.user_0_5(context, 0x100, scratch);
const rawWrite = core.user_0_9(context, 0x104, 0x55667788);
dataView.setUint8(ramBase + 0x108, 0x5a);
dataView.setBigUint64(scratch + 8, 0x0123456789abcdefn, true);
const rawQuantizedRead = core.user_0_11(context, 0x108, 4 << 16, scratch + 8);
dataView.setUint32(scratch + 16, 0x5aa5c33c, true);
const rawLoadReserve = core.user_0_27(context, 0x100, scratch + 16);
const rawStoreConditional = core.user_0_28(context, 0x10c, 0x13579bdf);
const rawHookResults = {
  read: rawRead,
  write: rawWrite,
  quantizedRead: rawQuantizedRead,
  loadReserve: rawLoadReserve,
  storeConditional: rawStoreConditional,
};
if (Object.values(rawHookResults).some((outcome) => outcome !== 0) ||
    dataView.getUint32(scratch, true) !== 0xa5a55a5a ||
    dataView.getBigUint64(scratch + 8, true) !== 0x0123456789abcdefn ||
    dataView.getUint32(scratch + 16, true) !== 0x5aa5c33c ||
    dataView.getUint32(ramBase + 0x104, false) !== 0 ||
    dataView.getUint32(ramBase + 0x10c, false) !== 0 ||
    dataView.getUint32(context + 4, true) !== 1) {
  throw new Error(`raw resident hooks escaped sealed dispatch authority: ${JSON.stringify(rawHookResults)}`);
}
const rawHookFaultPointer = core.core_current_run_outcome();
const rawHookFault = {
  reason: dataView.getUint32(rawHookFaultPointer + 8, true),
  detail: dataView.getUint32(rawHookFaultPointer + 12, true),
};
if (rawHookFaultPointer === 0 || rawHookFault.reason !== 5 || rawHookFault.detail !== 10) {
  throw new Error(`raw resident hook rejection did not publish the exact Rust fault: ${JSON.stringify(rawHookFault)}`);
}

// A legal atomic DI payload is 24 MiB. Exercise a slightly larger Rust-owned allocation and
// prove the browser cannot retain views across allocator-driven WebAssembly memory growth.
const allocationProbeBytes = 24 * 1024 * 1024 + 1;
const growthSentinelOffset = core.core_main_ram_offset() + 0x180;
const bufferBeforeGrowth = memory.buffer;
const staleView = new Uint8Array(bufferBeforeGrowth, growthSentinelOffset, 1);
staleView[0] = 0x6d;
const pagesBeforeAllocationProbe = memory.buffer.byteLength / 65536;
const allocationProbeStatus = core.core_resident_allocation_probe(allocationProbeBytes);
const pagesAfterAllocationProbe = memory.buffer.byteLength / 65536;
if (allocationProbeStatus !== 1 || pagesAfterAllocationProbe <= pagesBeforeAllocationProbe) {
  throw new Error(
    `resident allocation probe failed: status=${allocationProbeStatus} ` +
      `pages=${pagesBeforeAllocationProbe}->${pagesAfterAllocationProbe}`,
  );
}
if (memory.buffer === bufferBeforeGrowth || bufferBeforeGrowth.byteLength !== 0 ||
    staleView.byteLength !== 0) {
  throw new Error("allocator growth left a host view attached to stale Wasm memory");
}
const reacquiredView = new DataView(memory.buffer);
if (reacquiredView.getUint8(growthSentinelOffset) !== 0x6d) {
  throw new Error("reacquired host view did not preserve fixed machine memory after growth");
}

process.stdout.write(`${JSON.stringify({
  abi: core.core_abi_version(),
  bytes: bytes.length,
  imports,
  exports: requiredFunctions.length,
  memoryPages: {
    initial: RESIDENT_MEMORY_INITIAL_PAGES,
    maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
    afterInitialization: pagesAfterInitialization,
    beforeAllocationProbe: pagesBeforeAllocationProbe,
    afterAllocationProbe: pagesAfterAllocationProbe,
  },
  allocationProbeBytes,
  allocationProbeStatus,
  overbroadImportRejected,
  staleViewDetached: staleView.byteLength === 0,
  hostViewReacquired: reacquiredView.getUint8(growthSentinelOffset) === 0x6d,
  generation: core.core_address_space_generation_lo(),
  machineEvidence: {
    bytes: machineEvidenceBytes,
    pointer: firstMachineEvidencePointer,
    stable: secondMachineEvidencePointer === firstMachineEvidencePointer,
  },
  inputResults,
  rawHookResults,
  rawHookFault,
})}\n`);
