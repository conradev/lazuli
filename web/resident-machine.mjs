// SPDX-License-Identifier: GPL-3.0-only

/**
 * Thin browser capability adapter for the Rust/Wasm-resident Lazuli machine.
 *
 * This module deliberately contains no PPC, MMU, disc-format, scheduler, or device model. It
 * links Rust-authored Wasm modules, copies exact Rust-issued byte ranges around async browser
 * capabilities, and supplies only upper bounds to the generated run coordinator.
 */

export const RESIDENT_MEMORY_INITIAL_PAGES = 720;
export const RESIDENT_MEMORY_MAXIMUM_PAGES = 2048;
export const RESIDENT_CYCLE_UPPER_CAP = 1_000_000n;
export const RESIDENT_BLOCK_UPPER_CAP = 16_384;
export const RESIDENT_CYCLE_ABSOLUTE_MAX = 8_000_000n;
export const RESIDENT_BLOCK_ABSOLUTE_MAX = 131_072;

const COMPILE_REQUEST_BYTES = 84;
const HOST_REQUEST_BYTES = 52;
const RUN_OUTCOME_BYTES = 40;
const GAME_FIDELITY_RECORD_BYTES = 384;
const CAPTURE_AUTHORITY_RECORD_BYTES = 108;
const CAPTURE_AUTHORITY_MAGIC = 0x4c5a_4341;
const RESIDENT_INSTALL_COMMITTED = 0x4c5a_434d;
const RESIDENT_INSTALL_CANCELLED = 0x4c5a_4341;
const RUN_REASON_COMPILE_REQUIRED = 1;
const RUN_REASON_HOST_REQUEST = 2;
const HOST_REQUEST_RENDER_SUBMIT = 1;
const HOST_COMPLETION_OK = 0;
const HOST_COMPLETION_END_OF_FILE = 4;
const HOST_COMPLETION_HOST_ERROR = 6;
const DISC_BOOT_ACCEPTED = 1;
const DISC_BOOT_COMMITTED = 2;
const DISC_BOOT_STATUS_PLANNING = 1;
const DISC_BOOT_STATUS_LOADING = 2;
const DISC_BOOT_STATUS_COMMITTED = 3;
const DISC_BOOT_STATUS_FAILED = 4;
const DISC_BOOT_STATUS_CANCELLED = 5;
const DI_COMPLETION_ACCEPTED = 1;
const DI_LOGICAL_WINDOW_READY = 2;
const DI_DEVICE_READ_FAILED = 3;
const DEFAULT_MAX_BOOT_READS = 8_192;
const DEFAULT_MAX_HOST_CALLS = 64;
const DEFAULT_MAX_COLD_INSTALLS = 64;
const U64_MAX = (1n << 64n) - 1n;

const CORE_IMPORTS = [
  { module: "lazuli", name: "memory", kind: "memory" },
];
const DISPATCHER_IMPORTS = [
  { module: "lazuli", name: "memory", kind: "memory" },
  {
    module: "lazuli",
    name: "validate_instruction_page_dependency",
    kind: "function",
  },
];
const COORDINATOR_IMPORTS = [
  { module: "lazuli", name: "memory", kind: "memory" },
  { module: "lazuli_core", name: "core_begin_slice", kind: "function" },
  { module: "lazuli_core", name: "core_finish_slice", kind: "function" },
  { module: "lazuli_core", name: "core_current_run_outcome", kind: "function" },
  { module: "lazuli_dispatch", name: "run", kind: "function" },
];

const REQUIRED_CORE_FUNCTIONS = [
  "core_abi_version",
  "core_compile_request_bytes",
  "core_host_request_bytes",
  "core_memory_initial_pages",
  "core_memory_maximum_pages",
  "core_machine_evidence_bytes",
  "core_machine_evidence_snapshot",
  "core_game_fidelity_bytes",
  "core_game_fidelity_phase",
  "core_game_fidelity_requested_buttons",
  "core_game_fidelity_requested_stick_xy_cxy",
  "core_game_fidelity_requested_trigger_lrab",
  "core_game_fidelity_snapshot",
  "core_dispatch_slot_capacity",
  "core_ipl_offset",
  "core_ipl_bytes",
  "core_init",
  "core_disc_boot_begin",
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
  "core_input_publish",
  "core_capture_authority_bytes",
  "core_capture_authority_snapshot",
  "core_render_pending_count",
  "core_render_request_ptr",
  "core_render_complete",
  "core_pending_module_bytes",
  "core_pending_compile_request_bytes",
  "begin_resident_block_install",
  "cancel_resident_block_install",
  "commit_resident_block_install",
  "validate_instruction_page_dependency",
  "core_begin_slice",
  "core_finish_slice",
  "core_current_run_outcome",
];

function fail(message) {
  throw new Error(`resident machine adapter: ${message}`);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function exactImports(module, expected, label) {
  const observed = WebAssembly.Module.imports(module);
  check(
    JSON.stringify(observed) === JSON.stringify(expected),
    `${label} crossed the capability boundary: ${JSON.stringify(observed)}`,
  );
}

function asOwnedBytes(value, label) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  fail(`${label} did not return bytes`);
}

async function compileArtifact(source, label, fetchImpl) {
  if (source instanceof WebAssembly.Module) return source;
  let bytes;
  if (typeof source === "string" || source instanceof URL) {
    const response = await fetchImpl(source);
    check(response.ok, `${label} fetch failed with HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else if (typeof Response !== "undefined" && source instanceof Response) {
    check(source.ok, `${label} response failed with HTTP ${source.status}`);
    bytes = new Uint8Array(await source.arrayBuffer());
  } else {
    bytes = asOwnedBytes(source, `${label} artifact`);
  }
  check(bytes.byteLength !== 0, `${label} artifact is empty`);
  return WebAssembly.compile(bytes);
}

function requiredFunction(object, name, owner) {
  const value = object[name];
  check(typeof value === "function", `${owner} is missing function ${name}`);
  return value;
}

function checkedU32(value, label) {
  check(Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff, `${label} is not a u32`);
  return value >>> 0;
}

function checkedPositiveU32(value, label) {
  const checked = checkedU32(value, label);
  check(checked !== 0, `${label} must be nonzero`);
  return checked;
}

function checkedU64(value, label) {
  let checked;
  try {
    checked = BigInt(value);
  } catch {
    fail(`${label} is not a u64`);
  }
  check(checked >= 0n && checked <= U64_MAX, `${label} is not a u64`);
  return checked;
}

function splitU64(value, label) {
  const checked = checkedU64(value, label);
  return [Number(checked & 0xffff_ffffn), Number(checked >> 32n)];
}

function joinU64(lo, hi) {
  return BigInt(lo >>> 0) | (BigInt(hi >>> 0) << 32n);
}

function checkedRange(memory, pointer, length, label) {
  const start = checkedU32(pointer, `${label} pointer`);
  const bytes = checkedU32(length, `${label} length`);
  check(start !== 0, `${label} pointer is null`);
  const end = start + bytes;
  check(Number.isSafeInteger(end) && end <= memory.buffer.byteLength, `${label} is out of memory`);
  return { start, bytes };
}

function copyMemory(memory, pointer, length, label) {
  const range = checkedRange(memory, pointer, length, label);
  return new Uint8Array(memory.buffer, range.start, range.bytes).slice();
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes) {
  let encoded = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.byteLength;
    const hasThird = index + 2 < bytes.byteLength;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const triplet = first << 16 | second << 8 | third;
    encoded += BASE64_ALPHABET[(triplet >>> 18) & 0x3f];
    encoded += BASE64_ALPHABET[(triplet >>> 12) & 0x3f];
    encoded += hasSecond ? BASE64_ALPHABET[(triplet >>> 6) & 0x3f] : "=";
    encoded += hasThird ? BASE64_ALPHABET[triplet & 0x3f] : "=";
  }
  return encoded;
}

function opaqueMachineEvidence(core, memory, byteLength) {
  const bytes = checkedU32(byteLength, "Rust machine evidence byte length");
  if (bytes === 0) {
    return Object.freeze({ available: false, bytes, encoding: "base64", payload: null });
  }
  const pointer = core.core_machine_evidence_snapshot() >>> 0;
  if (pointer === 0) {
    return Object.freeze({ available: false, bytes, encoding: "base64", payload: null });
  }
  // Copy the exact immutable Rust snapshot before any later export can replace it. JavaScript
  // transports these bytes opaquely and never decodes device policy from the record.
  const snapshot = copyMemory(memory, pointer, bytes, "opaque Rust machine evidence");
  return Object.freeze({
    available: true,
    bytes,
    encoding: "base64",
    payload: base64Encode(snapshot),
  });
}

function gameFidelityState(core, memory, byteLength, machineEvidenceBytes) {
  const bytes = checkedU32(byteLength, "Rust game fidelity byte length");
  check(
    bytes === GAME_FIDELITY_RECORD_BYTES,
    `Rust game fidelity byte length is ${bytes}, expected ${GAME_FIDELITY_RECORD_BYTES}`,
  );
  const phase = checkedU32(core.core_game_fidelity_phase(), "Rust game fidelity phase");
  check(phase <= 6, `Rust game fidelity phase ${phase} is unknown`);
  const buttons = checkedU32(
    core.core_game_fidelity_requested_buttons(),
    "Rust requested controller buttons",
  );
  const stickXyCxy = checkedU32(
    core.core_game_fidelity_requested_stick_xy_cxy(),
    "Rust requested controller sticks",
  );
  const triggerLrab = checkedU32(
    core.core_game_fidelity_requested_trigger_lrab(),
    "Rust requested controller triggers",
  );
  const baseline = phase === 1;
  check(
    baseline || (buttons === 0 && stickXyCxy === 0 && triggerLrab === 0),
    "Rust exposed a requested controller state outside Baseline",
  );
  check(!baseline || buttons !== 0, "Rust Baseline omitted its requested controller buttons");

  const pointer = core.core_game_fidelity_snapshot() >>> 0;
  let record;
  if (pointer === 0) {
    record = Object.freeze({ available: false, bytes, encoding: "base64", payload: null });
  } else {
    // The record stays opaque in JavaScript. Copy it immediately because a later explicit
    // snapshot query is allowed to replace Rust's stable snapshot storage.
    const snapshot = copyMemory(memory, pointer, bytes, "opaque Rust game fidelity record");
    record = Object.freeze({
      available: true,
      bytes,
      encoding: "base64",
      payload: base64Encode(snapshot),
    });
  }
  return Object.freeze({
    phase,
    requestedController: baseline
      ? Object.freeze({ buttons, stickXyCxy, triggerLrab })
      : null,
    record,
    machineEvidence: opaqueMachineEvidence(
      core,
      memory,
      machineEvidenceBytes,
    ),
  });
}

function schedulerInterval(start, end) {
  const delta = Object.freeze({
    canonicalCycles: (end.canonicalCycle - start.canonicalCycle).toString(),
    executedCycles: (end.executedCycles - start.executedCycles).toString(),
    executedInstructions: (end.executedInstructions - start.executedInstructions).toString(),
    retiredBlocks: (end.retiredBlocks - start.retiredBlocks).toString(),
  });
  return Object.freeze({
    schema: "lazuli-resident-authenticated-scheduler-interval-v1",
    start: Object.freeze(Object.fromEntries(
      Object.entries(start).map(([field, value]) => [field, value.toString()]),
    )),
    end: Object.freeze(Object.fromEntries(
      Object.entries(end).map(([field, value]) => [field, value.toString()]),
    )),
    delta,
  });
}

function serializedSiAuthority(si) {
  if (si === null) return null;
  return Object.freeze({
    schema: "lazuli-resident-authenticated-si-publication-v1",
    pollIndex: si.pollIndex.toString(),
    scheduledCycle: si.scheduledCycle.toString(),
    observedCycle: si.observedCycle.toString(),
    appliedSequenceLo: si.appliedSequenceLo,
    appliedSequenceHi: si.appliedSequenceHi,
    packetWord0: si.packetWord0,
    packetWord1: si.packetWord1,
    source: si.source,
    controllerMode: si.controllerMode,
    buttons: si.buttons,
    stickXyCxy: si.stickXyCxy,
    triggerLrab: si.triggerLrab,
  });
}

function copyIntoMemory(memory, pointer, capacity, source, label) {
  const bytes = asOwnedBytes(source, label);
  check(bytes.byteLength <= capacity, `${label} exceeded Rust-issued staging capacity`);
  const range = checkedRange(memory, pointer, capacity, `${label} staging`);
  // Construct this view only after the most recent await and consume it synchronously.
  new Uint8Array(memory.buffer, range.start, bytes.byteLength).set(bytes);
  return bytes.byteLength;
}

function words(bytes, expectedLength, label) {
  check(bytes.byteLength === expectedLength, `${label} has ${bytes.byteLength} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from(
    { length: expectedLength / 4 },
    (_unused, index) => view.getUint32(index * 4, true),
  );
}

function copiedDescriptor(core, prefix, index = 0) {
  return [
    core[`${prefix}_request_epoch_lo`](index) >>> 0,
    core[`${prefix}_request_epoch_hi`](index) >>> 0,
    core[`${prefix}_request_id_lo`](index) >>> 0,
    core[`${prefix}_request_id_hi`](index) >>> 0,
    core[`${prefix}_request_container_offset_lo`](index) >>> 0,
    core[`${prefix}_request_container_offset_hi`](index) >>> 0,
    core[`${prefix}_request_length`](index) >>> 0,
  ];
}

function descriptorOffset(descriptor) {
  return joinU64(descriptor[4], descriptor[5]);
}

function descriptorLength(descriptor) {
  return descriptor[6] >>> 0;
}

function sameWords(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderRequestAt(core, memory) {
  check(core.core_render_pending_count() !== 0, "renderer request disappeared before publication");
  const pointer = core.core_render_request_ptr() >>> 0;
  const bytes = copyMemory(memory, pointer, HOST_REQUEST_BYTES, "HostRequest");
  const record = words(bytes, HOST_REQUEST_BYTES, "HostRequest");
  check(record[0] !== 0 && record[1] === HOST_REQUEST_BYTES, "HostRequest header is invalid");
  check(record[5] === HOST_REQUEST_RENDER_SUBMIT, "Rust issued a non-render HostRequest here");
  return { pointer, bytes, record };
}

function completeRender(core, request, status, filledLength) {
  const completion = core.core_render_complete(
    request[0],
    request[1],
    request[2],
    request[3],
    request[4],
    request[5],
    request[6],
    request[7],
    request[8],
    request[9],
    request[10],
    request[11],
    request[12],
    status,
    filledLength,
  ) >>> 0;
  check(completion === 1 || completion === 2, `Rust rejected render completion ${completion}`);
  return completion;
}

/**
 * Relays one exact Rust render request through the additive browser-renderer receipt bridge.
 *
 * The fixed HostRequest is copied before suspension. After the renderer promise settles, both
 * the record pointer and every memory-backed view are reacquired. Receipt bytes remain opaque.
 */
export async function relayResidentRender({ core, memory, renderer, onAccepted = null }) {
  check(renderer && typeof renderer.submit_resident_render === "function", "renderer bridge is missing");
  check(onAccepted === null || typeof onAccepted === "function", "render acceptance observer is invalid");
  const issued = renderRequestAt(core, memory);
  const request = issued.record;
  const source = copyMemory(memory, request[7], request[8], "resident render source");

  let receipt;
  try {
    receipt = asOwnedBytes(
      await renderer.submit_resident_render(source, request[6], request[11], request[12]),
      "renderer receipt",
    );
  } catch (error) {
    const current = renderRequestAt(core, memory);
    check(sameWords(current.record, request), "render request identity changed while renderer failed");
    const failure = completeRender(core, current.record, HOST_COMPLETION_HOST_ERROR, 0);
    check(failure === 2, "Rust reported a semantic commit for a rejected renderer promise");
    throw error;
  }

  const current = renderRequestAt(core, memory);
  check(sameWords(current.record, request), "render request identity changed across await");
  const filled = copyIntoMemory(
    memory,
    current.record[9],
    current.record[10],
    receipt,
    "opaque renderer receipt",
  );
  const completion = completeRender(core, current.record, HOST_COMPLETION_OK, filled);
  if (completion === 1 && onAccepted !== null) await onAccepted();
  return completion;
}

/** Raw immutable Blob transport. The adapter never interprets the contained bytes. */
export class RawBlobContainer {
  constructor(blob) {
    check(typeof Blob !== "undefined" && blob instanceof Blob, "raw Blob source requires a Blob");
    this.blob = blob;
    this.byteLength = BigInt(blob.size);
  }

  async read(containerOffset, length) {
    const offset = checkedU64(containerOffset, "Blob container offset");
    const bytes = checkedPositiveU32(length, "Blob range length");
    const end = offset + BigInt(bytes);
    check(end <= this.byteLength, "Blob range exceeds immutable container size");
    check(end <= BigInt(Number.MAX_SAFE_INTEGER), "Blob range is not exactly representable");
    const result = new Uint8Array(
      await this.blob.slice(Number(offset), Number(end)).arrayBuffer(),
    );
    check(result.byteLength === bytes, "Blob returned a short physical range");
    return result;
  }
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) fail("HTTP source omitted an exact Content-Range");
  const start = BigInt(match[1]);
  const end = BigInt(match[2]);
  const total = BigInt(match[3]);
  check(start <= end && end < total, "HTTP Content-Range is invalid");
  return { start, end, total };
}

/**
 * Opens strict raw HTTP Range transport and freezes its physical size with a one-byte probe.
 * Every later read must echo the same total and exact requested range.
 */
export async function openRawHttpContainer(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  check(typeof fetchImpl === "function", "raw HTTP source requires fetch");
  const href = new URL(url, options.baseUrl ?? globalThis.location?.href).href;
  const probe = await fetchImpl(href, {
    headers: { Range: "bytes=0-0" },
    cache: "no-store",
  });
  check(probe.status === 206, `HTTP range probe returned ${probe.status}, expected 206`);
  const range = parseContentRange(probe.headers.get("content-range"));
  check(range.start === 0n && range.end === 0n, "HTTP range probe returned the wrong byte");
  const probeBytes = new Uint8Array(await probe.arrayBuffer());
  check(probeBytes.byteLength === 1, "HTTP range probe returned the wrong body length");

  const etag = probe.headers.get("etag");
  const strongEtag = etag && !etag.startsWith("W/") ? etag : null;
  const lastModified = probe.headers.get("last-modified");
  const byteLength = range.total;
  return Object.freeze({
    byteLength,
    async read(containerOffset, length) {
      const offset = checkedU64(containerOffset, "HTTP container offset");
      const bytes = checkedPositiveU32(length, "HTTP range length");
      const endExclusive = offset + BigInt(bytes);
      check(endExclusive <= byteLength, "HTTP range exceeds immutable container size");
      const headers = { Range: `bytes=${offset}-${endExclusive - 1n}` };
      if (strongEtag) headers["If-Match"] = strongEtag;
      else if (lastModified) headers["If-Unmodified-Since"] = lastModified;
      const response = await fetchImpl(href, { headers, cache: "no-store" });
      check(response.status === 206, `HTTP range returned ${response.status}, expected 206`);
      const observed = parseContentRange(response.headers.get("content-range"));
      check(
        observed.start === offset && observed.end === endExclusive - 1n && observed.total === byteLength,
        "HTTP source changed or returned a different physical range",
      );
      const result = new Uint8Array(await response.arrayBuffer());
      check(result.byteLength === bytes, "HTTP source returned a short physical range");
      return result;
    },
  });
}

function validateRawContainer(container) {
  check(container && typeof container.read === "function", "raw container is missing read()");
  const byteLength = checkedU64(container.byteLength, "raw container byte length");
  check(byteLength !== 0n, "raw container is empty");
  return byteLength;
}

function readRunOutcome(core, memory, pointer) {
  const bytes = copyMemory(memory, pointer, RUN_OUTCOME_BYTES, "RunOutcome");
  const record = words(bytes, RUN_OUTCOME_BYTES, "RunOutcome");
  check(record[0] === (core.core_abi_version() >>> 0), "RunOutcome ABI version changed");
  check(record[1] === RUN_OUTCOME_BYTES && record[9] === 0, "RunOutcome shape is invalid");
  return Object.freeze({
    reason: record[2],
    detail: record[3],
    executedCycles: joinU64(record[4], record[5]),
    executedInstructions: joinU64(record[6], record[7]),
    requestPointer: record[8],
  });
}

function compileRequestAt(core, memory, pointer) {
  check(core.core_pending_compile_request_bytes() === COMPILE_REQUEST_BYTES, "compile request is not retained");
  const record = words(
    copyMemory(memory, pointer, COMPILE_REQUEST_BYTES, "CompileRequest"),
    COMPILE_REQUEST_BYTES,
    "CompileRequest",
  );
  check(record[0] === (core.core_abi_version() >>> 0) && record[1] === COMPILE_REQUEST_BYTES,
    "CompileRequest header is invalid");
  const modulePointer = record[10];
  const moduleLength = record[11];
  check(moduleLength !== 0 && moduleLength === (core.core_pending_module_bytes() >>> 0),
    "Rust did not retain the exact cold module");
  return {
    identity: record.slice(2, 10),
    moduleBytes: copyMemory(memory, modulePointer, moduleLength, "opaque cold module"),
  };
}

function residentBlockImports(module, core, memory, blocks) {
  const namespace = Object.create(null);
  for (const item of WebAssembly.Module.imports(module)) {
    check(item.module === "lazuli", `cold block imported ${item.module}.${item.name}`);
    if (item.kind === "memory" && item.name === "memory") {
      namespace.memory = memory;
    } else if (item.kind === "table" && item.name === "blocks") {
      namespace.blocks = blocks;
    } else if (item.kind === "function") {
      namespace[item.name] = requiredFunction(core, item.name, "browser machine");
    } else {
      fail(`cold block requested unsupported import ${item.kind} ${item.name}`);
    }
  }
  check(namespace.memory === memory, "cold block omitted shared resident memory");
  check(namespace.blocks === blocks, "cold block omitted the Rust dispatcher table");
  check(namespace.begin_resident_block_install === core.begin_resident_block_install,
    "cold block omitted Rust begin-install authority");
  check(namespace.commit_resident_block_install === core.commit_resident_block_install,
    "cold block omitted Rust commit-install authority");
  return { lazuli: namespace };
}

function cancelColdInstall(core, identity, cause) {
  const status = core.cancel_resident_block_install(...identity) >>> 0;
  check(status === RESIDENT_INSTALL_CANCELLED,
    `exact cold-install cancellation returned 0x${status.toString(16)} after ${cause}`);
}

async function installColdRequest(core, memory, blocks, pointer) {
  // Both the fixed request and module source become owned JS copies before WebAssembly.compile
  // suspends. No Rust pointer or memory-backed view survives the await.
  const request = compileRequestAt(core, memory, pointer);
  let module;
  try {
    module = await WebAssembly.compile(request.moduleBytes);
  } catch (error) {
    cancelColdInstall(core, request.identity, "compile failure");
    throw error;
  }

  let resident;
  try {
    resident = new WebAssembly.Instance(
      module,
      residentBlockImports(module, core, memory, blocks),
    ).exports;
  } catch (error) {
    cancelColdInstall(core, request.identity, "instantiation failure");
    throw error;
  }

  try {
    const install = requiredFunction(resident, "install", "cold block");
    const status = install() >>> 0;
    if (status !== RESIDENT_INSTALL_COMMITTED) {
      cancelColdInstall(core, request.identity, `installer status 0x${status.toString(16)}`);
      fail(`cold block installer returned 0x${status.toString(16)}`);
    }
  } catch (error) {
    // A successful commit consumes the request, so only attempt recovery while Rust still owns it.
    if (core.core_pending_compile_request_bytes() !== 0) {
      cancelColdInstall(core, request.identity, "installer exception");
    }
    throw error;
  }
}

export class ResidentMachineAdapter {
  static async create(options) {
    const artifacts = options?.artifacts;
    check(artifacts, "missing Rust Wasm artifacts");
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    check(typeof fetchImpl === "function" ||
      [artifacts.core, artifacts.dispatcher, artifacts.coordinator].every(
        artifact => artifact instanceof WebAssembly.Module || artifact instanceof ArrayBuffer ||
          ArrayBuffer.isView(artifact),
      ), "artifact URLs require fetch");
    const [coreModule, dispatcherModule, coordinatorModule] = await Promise.all([
      compileArtifact(artifacts.core, "browser machine", fetchImpl),
      compileArtifact(artifacts.dispatcher, "resident dispatcher", fetchImpl),
      compileArtifact(artifacts.coordinator, "run coordinator", fetchImpl),
    ]);
    exactImports(coreModule, CORE_IMPORTS, "browser machine");
    exactImports(dispatcherModule, DISPATCHER_IMPORTS, "resident dispatcher");
    exactImports(coordinatorModule, COORDINATOR_IMPORTS, "run coordinator");

    const memory = new WebAssembly.Memory({
      initial: RESIDENT_MEMORY_INITIAL_PAGES,
      maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
    });
    const core = new WebAssembly.Instance(coreModule, { lazuli: { memory } }).exports;
    for (const name of REQUIRED_CORE_FUNCTIONS) requiredFunction(core, name, "browser machine");
    check(core.core_compile_request_bytes() === COMPILE_REQUEST_BYTES, "CompileRequest ABI changed");
    check(core.core_host_request_bytes() === HOST_REQUEST_BYTES, "HostRequest ABI changed");
    const machineEvidenceBytes = checkedPositiveU32(
      core.core_machine_evidence_bytes(),
      "Rust machine evidence byte length",
    );
    const gameFidelityBytes = checkedPositiveU32(
      core.core_game_fidelity_bytes(),
      "Rust game fidelity byte length",
    );
    const captureAuthorityBytes = checkedPositiveU32(
      core.core_capture_authority_bytes(),
      "Rust capture authority byte length",
    );
    check(
      captureAuthorityBytes === CAPTURE_AUTHORITY_RECORD_BYTES,
      `Rust capture authority byte length is ${captureAuthorityBytes}, expected ${CAPTURE_AUTHORITY_RECORD_BYTES}`,
    );
    check(
      gameFidelityBytes === GAME_FIDELITY_RECORD_BYTES,
      `Rust game fidelity byte length is ${gameFidelityBytes}, expected ${GAME_FIDELITY_RECORD_BYTES}`,
    );
    check(
      options.captureFidelity === undefined || typeof options.captureFidelity === "boolean",
      "captureFidelity must be a boolean",
    );
    check(core.core_memory_initial_pages() === RESIDENT_MEMORY_INITIAL_PAGES,
      "browser machine initial memory changed");
    check(core.core_memory_maximum_pages() === RESIDENT_MEMORY_MAXIMUM_PAGES,
      "browser machine maximum memory changed");

    const dispatcher = new WebAssembly.Instance(dispatcherModule, {
      lazuli: {
        memory,
        validate_instruction_page_dependency: core.validate_instruction_page_dependency,
      },
    }).exports;
    requiredFunction(dispatcher, "run", "resident dispatcher");
    check(dispatcher.blocks instanceof WebAssembly.Table, "resident dispatcher omitted its typed table");
    const slotCapacity = checkedPositiveU32(
      core.core_dispatch_slot_capacity(),
      "Rust dispatch slot capacity",
    );
    check(dispatcher.blocks.length <= slotCapacity, "dispatcher table exceeds Rust slot capacity");
    if (dispatcher.blocks.length < slotCapacity) {
      dispatcher.blocks.grow(slotCapacity - dispatcher.blocks.length);
    }
    check(dispatcher.blocks.length === slotCapacity, "dispatcher table did not reach Rust slot capacity");

    const coordinator = new WebAssembly.Instance(coordinatorModule, {
      lazuli: { memory },
      lazuli_core: {
        core_begin_slice: core.core_begin_slice,
        core_finish_slice: core.core_finish_slice,
        core_current_run_outcome: core.core_current_run_outcome,
      },
      lazuli_dispatch: { run: dispatcher.run },
    }).exports;
    requiredFunction(coordinator, "core_run", "run coordinator");

    if (options.iplBytes !== undefined && options.iplBytes !== null) {
      const ipl = asOwnedBytes(options.iplBytes, "IPL");
      const expected = checkedPositiveU32(core.core_ipl_bytes(), "Rust IPL byte length");
      check(ipl.byteLength === expected, `IPL has ${ipl.byteLength} bytes, expected ${expected}`);
      const offset = checkedU32(core.core_ipl_offset(), "Rust IPL offset");
      copyIntoMemory(memory, offset, expected, ipl, "IPL");
    }
    check(core.core_init() === 1, "browser machine core_init did not acquire one-shot ownership");

    return new ResidentMachineAdapter({
      memory,
      core,
      dispatcher,
      coordinator,
      renderer: options.renderer,
      rawContainer: options.rawContainer,
      machineEvidenceBytes,
      gameFidelityBytes,
      captureAuthorityBytes,
      captureFidelity: options.captureFidelity === true,
    });
  }

  constructor({
    memory,
    core,
    dispatcher,
    coordinator,
    renderer,
    rawContainer,
    machineEvidenceBytes = 0,
    gameFidelityBytes = 0,
    captureAuthorityBytes = CAPTURE_AUTHORITY_RECORD_BYTES,
    captureFidelity = false,
  }) {
    this.memory = memory;
    this.core = core;
    this.dispatcher = dispatcher;
    this.coordinator = coordinator;
    this.renderer = renderer ?? null;
    this.rawContainer = rawContainer ?? null;
    this.machineEvidenceBytes = checkedU32(
      machineEvidenceBytes,
      "Rust machine evidence byte length",
    );
    this.gameFidelityBytes = checkedU32(
      gameFidelityBytes,
      "Rust game fidelity byte length",
    );
    this.captureAuthorityBytes = checkedU32(
      captureAuthorityBytes,
      "Rust capture authority byte length",
    );
    check(
      this.captureAuthorityBytes === CAPTURE_AUTHORITY_RECORD_BYTES,
      "Rust capture authority record ABI changed",
    );
    check(typeof captureFidelity === "boolean", "captureFidelity must be a boolean");
    this.captureFidelity = captureFidelity;
    this.booted = false;
    this.running = false;
    this.closed = false;
    this.totalBootReads = 0;
    this.totalDiReads = 0;
    this.totalRenderCalls = 0;
    this.totalColdInstalls = 0;
    this.pendingControllerSample = null;
    this.totalControllerRetries = 0;
    this.fidelityBoundaryState = null;
  }

  setRawContainer(container) {
    check(!this.running && !this.booted, "cannot replace raw container after boot");
    validateRawContainer(container);
    this.rawContainer = container;
  }

  setRenderer(renderer) {
    check(!this.running, "cannot replace renderer while the machine is running");
    check(renderer && typeof renderer.submit_resident_render === "function", "invalid renderer bridge");
    this.renderer = renderer;
  }

  async boot(options = {}) {
    check(!this.closed && !this.running, "machine is unavailable");
    check(!this.booted, "machine has already booted a disc");
    const container = options.rawContainer ?? this.rawContainer;
    const containerBytes = validateRawContainer(container);
    const maximumReads = checkedPositiveU32(
      options.maxReads ?? DEFAULT_MAX_BOOT_READS,
      "boot host-call cap",
    );
    const [lengthLo, lengthHi] = splitU64(containerBytes, "raw container byte length");
    check(this.core.core_disc_boot_begin(lengthLo, lengthHi) === DISC_BOOT_ACCEPTED,
      "Rust rejected disc boot begin");

    this.running = true;
    let reads = 0;
    try {
      for (;;) {
        const status = this.core.core_disc_boot_status() >>> 0;
        if (status === DISC_BOOT_STATUS_COMMITTED) {
          this.booted = true;
          this.rawContainer = container;
          this.totalBootReads += reads;
          return Object.freeze({ status, reads });
        }
        if (status === DISC_BOOT_STATUS_FAILED) {
          fail(`Rust disc boot failed with fault ${this.core.core_disc_boot_fault() >>> 0}`);
        }
        if (status === DISC_BOOT_STATUS_CANCELLED) fail("Rust disc boot was cancelled");
        check(status === DISC_BOOT_STATUS_PLANNING || status === DISC_BOOT_STATUS_LOADING,
          `Rust disc boot entered status ${status}`);
        check(reads < maximumReads, `disc boot exceeded ${maximumReads} physical reads`);
        const pending = this.core.core_disc_boot_pending_count() >>> 0;
        check(pending !== 0, "active Rust disc boot exposed no physical request");
        const descriptor = copiedDescriptor(this.core, "core_disc_boot", 0);
        const length = descriptorLength(descriptor);
        check(length !== 0, "Rust issued an empty disc-boot range");

        let fetched;
        try {
          fetched = asOwnedBytes(
            await container.read(descriptorOffset(descriptor), length),
            "raw disc-boot range",
          );
        } catch (error) {
          this.core.core_disc_boot_complete(...descriptor, 0);
          throw error;
        }
        reads += 1;
        if (fetched.byteLength !== length) {
          this.core.core_disc_boot_complete(...descriptor, 0);
          fail("raw source returned a short disc-boot range");
        }
        const staging = this.core.core_disc_boot_staging_ptr(...descriptor) >>> 0;
        copyIntoMemory(this.memory, staging, length, fetched, "disc-boot bytes");
        const completion = this.core.core_disc_boot_complete(...descriptor, length) >>> 0;
        check(completion === DISC_BOOT_ACCEPTED || completion === DISC_BOOT_COMMITTED,
          `Rust rejected disc-boot completion ${completion}`);
      }
    } finally {
      this.running = false;
    }
  }

  async #serviceDiReads(maximumCalls) {
    check(this.booted && this.rawContainer, "DI requires one committed Rust disc boot");
    const maximum = checkedPositiveU32(maximumCalls, "DI host-call cap");
    let calls = 0;
    while ((this.core.core_di_pending_count() >>> 0) !== 0 && calls < maximum) {
      const descriptor = copiedDescriptor(this.core, "core_di", 0);
      const length = descriptorLength(descriptor);
      check(length !== 0, "Rust issued an empty DI physical range");
      let fetched;
      try {
        fetched = asOwnedBytes(
          await this.rawContainer.read(descriptorOffset(descriptor), length),
          "raw DI range",
        );
      } catch {
        const completion = this.core.core_di_complete(
          ...descriptor,
          0,
          HOST_COMPLETION_HOST_ERROR,
        ) >>> 0;
        check(completion === DI_DEVICE_READ_FAILED, `Rust rejected failed DI completion ${completion}`);
        calls += 1;
        break;
      }
      calls += 1;
      if (fetched.byteLength !== length) {
        const completion = this.core.core_di_complete(
          ...descriptor,
          0,
          HOST_COMPLETION_END_OF_FILE,
        ) >>> 0;
        check(completion === DI_DEVICE_READ_FAILED, `Rust rejected short DI completion ${completion}`);
        break;
      }
      const staging = this.core.core_di_staging_ptr(...descriptor) >>> 0;
      copyIntoMemory(this.memory, staging, length, fetched, "DI bytes");
      const completion = this.core.core_di_complete(
        ...descriptor,
        length,
        HOST_COMPLETION_OK,
      ) >>> 0;
      check(completion === DI_COMPLETION_ACCEPTED || completion === DI_LOGICAL_WINDOW_READY,
        `Rust rejected DI completion ${completion}`);
    }
    this.totalDiReads += calls;
    return Object.freeze({ calls, pending: this.core.core_di_pending_count() >>> 0 });
  }

  async serviceDiReads(maximumCalls = DEFAULT_MAX_HOST_CALLS) {
    check(!this.closed && !this.running, "machine is unavailable for an independent DI drain");
    this.running = true;
    try {
      return await this.#serviceDiReads(maximumCalls);
    } finally {
      this.running = false;
    }
  }

  async runSlice(options = {}) {
    check(this.booted && !this.closed && !this.running, "machine is not ready to run");
    check(this.fidelityBoundaryState === null, "machine reached its accepted fidelity boundary");
    const requestedCycles = checkedU64(
      options.cycleUpperCap ?? RESIDENT_CYCLE_UPPER_CAP,
      "cycle upper cap",
    );
    check(requestedCycles !== 0n, "cycle upper cap must be nonzero");
    const requestedBlocks = checkedPositiveU32(
      options.blockUpperCap ?? RESIDENT_BLOCK_UPPER_CAP,
      "block upper cap",
    );
    const cycleUpperCap = requestedCycles < RESIDENT_CYCLE_ABSOLUTE_MAX
      ? requestedCycles
      : RESIDENT_CYCLE_ABSOLUTE_MAX;
    const blockUpperCap = Math.min(requestedBlocks, RESIDENT_BLOCK_ABSOLUTE_MAX);
    const maximumHostCalls = checkedPositiveU32(
      options.maxHostCalls ?? DEFAULT_MAX_HOST_CALLS,
      "run host-call cap",
    );
    const maximumColdInstalls = checkedPositiveU32(
      options.maxColdInstalls ?? DEFAULT_MAX_COLD_INSTALLS,
      "run cold-install cap",
    );
    const onAuthority = options.onAuthority ?? null;
    check(
      onAuthority === null || typeof onAuthority === "function",
      "run authority observer must be a function",
    );

    const authorityStart = this.captureAuthority();
    const schedulerStart = authorityStart.scheduler;
    let authorityNow = authorityStart;
    const finish = result => {
      const schedulerEnd = authorityNow.scheduler;
      const canonicalDelta = schedulerEnd.canonicalCycle - schedulerStart.canonicalCycle;
      const blockDelta = schedulerEnd.retiredBlocks - schedulerStart.retiredBlocks;
      check(canonicalDelta <= cycleUpperCap, "resident adapter exceeded its outer cycle cap");
      check(blockDelta <= BigInt(blockUpperCap), "resident adapter exceeded its outer block cap");
      return Object.freeze({
        ...result,
        scheduler: schedulerInterval(schedulerStart, schedulerEnd),
        si: serializedSiAuthority(authorityNow.si),
      });
    };

    this.running = true;
    let hostCalls = 0;
    let coldInstalls = 0;
    try {
      for (;;) {
        const schedulerNow = authorityNow.scheduler;
        const consumedCycles = schedulerNow.canonicalCycle - schedulerStart.canonicalCycle;
        const consumedBlocks = schedulerNow.retiredBlocks - schedulerStart.retiredBlocks;
        check(consumedCycles <= cycleUpperCap, "resident adapter outer cycle cap overshot");
        check(consumedBlocks <= BigInt(blockUpperCap), "resident adapter outer block cap overshot");
        if (consumedCycles === cycleUpperCap || consumedBlocks === BigInt(blockUpperCap)) {
          return finish({
            boundary: "adapter-cap",
            cap: consumedCycles === cycleUpperCap ? "cycle" : "block",
            hostCalls,
            coldInstalls,
          });
        }
        const remainingCycles = cycleUpperCap - consumedCycles;
        const remainingBlocks = Number(BigInt(blockUpperCap) - consumedBlocks);
        this.retryControllerInput();
        if (hostCalls < maximumHostCalls) {
          const di = await this.#serviceDiReads(maximumHostCalls - hostCalls);
          hostCalls += di.calls;
          if (di.pending !== 0) {
            return finish({ boundary: "host-call-cap", hostCalls, coldInstalls });
          }
        }

        const outcomePointer = this.coordinator.core_run(remainingCycles, remainingBlocks) >>> 0;
        const outcome = readRunOutcome(this.core, this.memory, outcomePointer);
        authorityNow = this.captureAuthority();
        const schedulerAfterRun = authorityNow.scheduler;
        check(
          schedulerAfterRun.canonicalCycle - schedulerStart.canonicalCycle <= cycleUpperCap,
          "resident coordinator crossed the outer cycle cap",
        );
        check(
          schedulerAfterRun.retiredBlocks - schedulerStart.retiredBlocks <= BigInt(blockUpperCap),
          "resident coordinator crossed the outer block cap",
        );
        if (onAuthority !== null) {
          await onAuthority(Object.freeze({
            scheduler: schedulerInterval(schedulerStart, schedulerAfterRun),
            si: serializedSiAuthority(authorityNow.si),
            hostCalls,
            coldInstalls,
          }));
        }
        // A DI read published before a new plan can leave the consumed post-install
        // CompileRequired outcome readable. A DI read published while finishing a real segment,
        // however, accompanies authoritative accounting that must be returned. Bypass only the
        // exact provisional tuple whose request pointer and Rust owner were both consumed.
        if ((this.core.core_di_pending_count() >>> 0) !== 0
          && outcome.reason === RUN_REASON_COMPILE_REQUIRED
          && outcome.requestPointer === 0
          && (this.core.core_pending_compile_request_bytes() >>> 0) === 0) {
          if (hostCalls >= maximumHostCalls) {
            return finish({ boundary: "host-call-cap", hostCalls, coldInstalls });
          }
          continue;
        }
        if (outcome.reason === RUN_REASON_COMPILE_REQUIRED) {
          await installColdRequest(
            this.core,
            this.memory,
            this.dispatcher.blocks,
            outcome.requestPointer,
          );
          coldInstalls += 1;
          this.totalColdInstalls += 1;
          if (coldInstalls >= maximumColdInstalls) {
            return finish({ boundary: "cold-install-cap", hostCalls, coldInstalls });
          }
          continue;
        }
        if (outcome.reason === RUN_REASON_HOST_REQUEST) {
          if (hostCalls >= maximumHostCalls) {
            return finish({ boundary: "host-call-cap", hostCalls, coldInstalls });
          }
          check(this.renderer, "Rust issued render work without a renderer bridge");
          let fidelityBoundary = null;
          await relayResidentRender({
            core: this.core,
            memory: this.memory,
            renderer: this.renderer,
            onAccepted: this.captureFidelity
              ? async () => {
                  check(
                    typeof this.renderer.observe_resident_fidelity === "function",
                    "fidelity capture renderer omitted its observation bridge",
                  );
                  const state = this.gameFidelityState();
                  const boundary = await this.renderer.observe_resident_fidelity(state);
                  if (boundary === "accepted") {
                    check(state.phase === 5, "renderer returned an invalid fidelity boundary");
                    this.fidelityBoundaryState = state;
                    fidelityBoundary = state;
                  }
                }
              : null,
          });
          hostCalls += 1;
          this.totalRenderCalls += 1;
          if (fidelityBoundary !== null) {
            return finish({
              boundary: "fidelity",
              phase: fidelityBoundary.phase,
              hostCalls,
              coldInstalls,
            });
          }
          continue;
        }
        this.retryControllerInput();
        return finish({
          boundary: "rust",
          outcome,
          hostCalls,
          coldInstalls,
          cycleUpperCap,
          blockUpperCap,
        });
      }
    } finally {
      this.running = false;
    }
  }

  captureAuthority() {
    check(!this.closed, "machine is closed");
    const pointer = this.core.core_capture_authority_snapshot() >>> 0;
    const snapshot = copyMemory(
      this.memory,
      pointer,
      this.captureAuthorityBytes,
      "Rust capture authority",
    );
    const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
    const word = index => view.getUint32(index * 4, true);
    check(word(0) === CAPTURE_AUTHORITY_MAGIC, "Rust capture authority magic changed");
    check(word(1) === 2, "Rust capture authority version changed");
    check(word(2) === CAPTURE_AUTHORITY_RECORD_BYTES, "Rust capture authority size changed");
    check(word(26) === 0, "Rust capture authority reserved word is nonzero");
    const scheduler = Object.freeze({
      canonicalCycle: joinU64(word(3), word(4)),
      executedCycles: joinU64(word(5), word(6)),
      executedInstructions: joinU64(word(7), word(8)),
      retiredBlocks: joinU64(word(9), word(10)),
    });
    const pollIndex = joinU64(word(11), word(12));
    const si = pollIndex === 0n ? null : Object.freeze({
      pollIndex,
      scheduledCycle: joinU64(word(13), word(14)),
      observedCycle: joinU64(word(15), word(16)),
      appliedSequenceLo: word(17),
      appliedSequenceHi: word(18),
      packetWord0: word(19),
      packetWord1: word(20),
      source: word(21),
      controllerMode: word(22),
      buttons: word(23),
      stickXyCxy: word(24),
      triggerLrab: word(25),
    });
    if (si !== null) {
      check(si.scheduledCycle <= si.observedCycle, "Rust SI authority chronology is invalid");
      check(si.observedCycle <= scheduler.canonicalCycle, "Rust SI authority exceeds scheduler time");
      check(si.source <= 1, "Rust SI authority source is unknown");
      check(si.controllerMode <= 0xff, "Rust SI authority controller mode is invalid");
      check(si.buttons <= 0xffff, "Rust SI authority controller buttons are invalid");
    } else {
      check(
        word(13) === 0 && word(14) === 0 && word(15) === 0 && word(16) === 0 &&
          word(17) === 0 && word(18) === 0 && word(19) === 0 && word(20) === 0 &&
          word(21) === 0 && word(22) === 0 && word(23) === 0 && word(24) === 0 &&
          word(25) === 0,
        "Rust empty SI authority is not pristine",
      );
    }
    return Object.freeze({ scheduler, si });
  }

  publishController(sequenceLo, sequenceHi, buttons, stickXyCxy, triggerLrab) {
    check(!this.closed, "machine is closed");
    check(this.fidelityBoundaryState === null, "machine reached its accepted fidelity boundary");
    const sample = [
      checkedU32(sequenceLo, "controller sequence low"),
      checkedU32(sequenceHi, "controller sequence high"),
      checkedU32(buttons, "controller buttons"),
      checkedU32(stickXyCxy, "controller sticks"),
      checkedU32(triggerLrab, "controller triggers"),
    ];
    if (this.pendingControllerSample && !sameWords(this.pendingControllerSample, sample)) {
      // A rejected Rust publication remains retryable under its original exact sequence. Never
      // silently replace it with a newer browser sample or synthesize another sequence number.
      return 0;
    }
    const status = this.core.core_input_publish(...sample) >>> 0;
    this.pendingControllerSample = status === 0 ? sample : null;
    return status;
  }

  retryControllerInput() {
    if (!this.pendingControllerSample) return null;
    const status = this.core.core_input_publish(...this.pendingControllerSample) >>> 0;
    this.totalControllerRetries += 1;
    if (status !== 0) this.pendingControllerSample = null;
    return status;
  }

  gameFidelityState() {
    check(!this.closed, "machine is closed");
    check(this.captureFidelity, "game fidelity capture is not enabled");
    if (this.fidelityBoundaryState !== null) return this.fidelityBoundaryState;
    return gameFidelityState(
      this.core,
      this.memory,
      this.gameFidelityBytes,
      this.machineEvidenceBytes,
    );
  }

  diagnostics() {
    return Object.freeze({
      booted: this.booted,
      memoryPages: this.memory.buffer.byteLength / 65_536,
      totalBootReads: this.totalBootReads,
      totalDiReads: this.totalDiReads,
      totalRenderCalls: this.totalRenderCalls,
      totalColdInstalls: this.totalColdInstalls,
      pendingControllerSample: this.pendingControllerSample !== null,
      totalControllerRetries: this.totalControllerRetries,
      tableSlots: this.dispatcher.blocks.length,
      machineEvidence: opaqueMachineEvidence(
        this.core,
        this.memory,
        this.machineEvidenceBytes,
      ),
    });
  }

  close() {
    check(!this.running, "cannot close a running machine");
    this.closed = true;
    this.renderer = null;
    this.rawContainer = null;
  }
}
