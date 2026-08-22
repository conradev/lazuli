import { readFile } from "node:fs/promises";

const INITIAL_PAGES = 720;
const RESIDENT_MAXIMUM_PAGES = 2048;
const LEGACY_MAXIMUM_PAGES = 768;
const PAGE_BYTES = 64 * 1024;
const CISO_HEADER_BYTES = 0x8000;
const DI_BYTES = 24 * 1024 * 1024;
const BOOT_OFFSET = 0x3000;
const FST_OFFSET = 0xf0000;
const TEXT_FILE_OFFSET = 0x100;
const TEXT_TARGET = 0x80010000;
const TEXT_BYTES = 0x90005;
const GAMECUBE_MAGIC = 0xc2339f3d;

const CALL_ACCEPTED = 1;
const CALL_LOGICAL_READY = 2;
const CALL_STALE = 5;
const STATUS_COMMITTED = 3;
const HOST_OK = 0;

const [wasmPath] = process.argv.slice(2);
if (!wasmPath) {
  process.stderr.write(
    "usage: browser_machine_di_runtime_contract.mjs <contract-browser_machine.wasm>\n",
  );
  process.exit(2);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function encodeTwoByteU32(value) {
  check(value >= 0x80 && value <= 0x3fff, `invalid two-byte ULEB value ${value}`);
  return [0x80 | (value & 0x7f), value >>> 7];
}

function patchImportedMemoryMaximum(bytes, maximum) {
  const patched = Uint8Array.from(bytes);
  const descriptor = Uint8Array.from([
    0x06, 0x6c, 0x61, 0x7a, 0x75, 0x6c, 0x69,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
    0x02,
    0x01,
    ...encodeTwoByteU32(INITIAL_PAGES),
    ...encodeTwoByteU32(RESIDENT_MAXIMUM_PAGES),
  ]);
  const matches = [];
  outer: for (let offset = 0; offset <= patched.length - descriptor.length; offset += 1) {
    for (let index = 0; index < descriptor.length; index += 1) {
      if (patched[offset + index] !== descriptor[index]) continue outer;
    }
    matches.push(offset);
  }
  check(matches.length === 1, `expected one imported-memory descriptor, found ${matches.length}`);
  const encoded = encodeTwoByteU32(maximum);
  const maximumOffset = matches[0] + descriptor.length - 2;
  patched[maximumOffset] = encoded[0];
  patched[maximumOffset + 1] = encoded[1];
  return patched;
}

function writeBe32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setUint32(offset, value >>> 0, false);
}

function fixtureIso() {
  const image = new Uint8Array(0x100000);
  image.set(new TextEncoder().encode("GZLE01"), 0);
  image.set([0, 2, 0, 0x20], 6);
  image.set(new TextEncoder().encode("Rust Browser DI Contract\0"), 0x20);
  writeBe32(image, 0x1c, GAMECUBE_MAGIC);
  writeBe32(image, 0x420, BOOT_OFFSET);
  writeBe32(image, 0x424, FST_OFFSET);
  writeBe32(image, 0x428, 13);
  writeBe32(image, 0x42c, 47);
  image.fill(0x41, 0x440, 0x600);
  image.fill(0x82, 0x800, 0xa00);
  image.fill(0xc3, 0xc00, 0xe00);
  writeBe32(image, BOOT_OFFSET + 0x00, TEXT_FILE_OFFSET);
  writeBe32(image, BOOT_OFFSET + 0x48, TEXT_TARGET);
  writeBe32(image, BOOT_OFFSET + 0x90, TEXT_BYTES);
  writeBe32(image, BOOT_OFFSET + 0xe0, TEXT_TARGET);
  for (let index = 0; index < TEXT_BYTES; index += 1) {
    image[BOOT_OFFSET + TEXT_FILE_OFFSET + index] = 1 + (index % 251);
  }
  image.set([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], FST_OFFSET);
  return image;
}

function fixtureCiso(logical, blockBytes) {
  const header = new Uint8Array(CISO_HEADER_BYTES);
  header.set(new TextEncoder().encode("CISO"), 0);
  new DataView(header.buffer).setUint32(4, blockBytes, true);
  const present = [];
  for (let offset = 0, index = 0; offset < logical.length; offset += blockBytes, index += 1) {
    const block = logical.subarray(offset, Math.min(logical.length, offset + blockBytes));
    if (block.some((byte) => byte !== 0)) {
      header[8 + index] = index % 2 === 0 ? 0x02 : 0xff;
      const padded = new Uint8Array(blockBytes);
      padded.set(block);
      present.push(padded);
    }
  }
  const image = new Uint8Array(CISO_HEADER_BYTES + present.length * blockBytes);
  image.set(header);
  let cursor = CISO_HEADER_BYTES;
  for (const block of present) {
    image.set(block, cursor);
    cursor += blockBytes;
  }
  return image;
}

function halves(value) {
  const wide = BigInt(value);
  return [Number(wide & 0xffffffffn), Number((wide >> 32n) & 0xffffffffn)];
}

function joined(lo, hi) {
  return Number(BigInt(lo >>> 0) | (BigInt(hi >>> 0) << 32n));
}

function requestAt(core, prefix, index = 0) {
  return {
    epoch: joined(core[`${prefix}_request_epoch_lo`](index), core[`${prefix}_request_epoch_hi`](index)),
    id: joined(core[`${prefix}_request_id_lo`](index), core[`${prefix}_request_id_hi`](index)),
    containerOffset: joined(
      core[`${prefix}_request_container_offset_lo`](index),
      core[`${prefix}_request_container_offset_hi`](index),
    ),
    length: core[`${prefix}_request_length`](index) >>> 0,
  };
}

function requestArguments(request) {
  const [epochLo, epochHi] = halves(request.epoch);
  const [idLo, idHi] = halves(request.id);
  const [offsetLo, offsetHi] = halves(request.containerOffset);
  return [epochLo, epochHi, idLo, idHi, offsetLo, offsetHi, request.length];
}

function pages(memory) {
  return memory.buffer.byteLength / PAGE_BYTES;
}

async function boot(core, memory, source) {
  const [lo, hi] = halves(source.length);
  check(core.core_disc_boot_begin(lo, hi) === CALL_ACCEPTED, "disc boot begin failed");
  while (core.core_disc_boot_status() !== STATUS_COMMITTED) {
    const count = core.core_disc_boot_pending_count();
    check(count > 0, "disc boot exposed no pending Rust request");
    const requests = Array.from({ length: count }, (_unused, index) =>
      requestAt(core, "core_disc_boot", index));
    for (const request of requests) {
      const end = request.containerOffset + request.length;
      check(end <= source.length, "disc boot requested outside physical container");
      const fetched = await Promise.resolve(source.slice(request.containerOffset, end));
      const args = requestArguments(request);
      const pointer = core.core_disc_boot_staging_ptr(...args);
      check(pointer !== 0, "disc boot staging reauthentication failed");
      new Uint8Array(memory.buffer, pointer, request.length).set(fetched);
      const result = core.core_disc_boot_complete(...args, request.length);
      check(result === CALL_ACCEPTED || result === CALL_LOGICAL_READY, "disc boot completion failed");
      if (result === CALL_LOGICAL_READY) break;
    }
  }
}

function mem1Equals(memory, ramBase, expected) {
  const actual = new Uint8Array(memory.buffer, ramBase, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

async function run(module, maximumPages, expectAllocation, source, logicalIso) {
  const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: maximumPages });
  const core = new WebAssembly.Instance(module, { lazuli: { memory } }).exports;
  check(core.core_init() === 1, `core_init failed at ${maximumPages} pages`);
  await boot(core, memory, source);
  const ramBase = core.core_main_ram_offset();
  const before = new Uint8Array(memory.buffer.slice(ramBase, ramBase + DI_BYTES));
  const bufferBeforeProbe = memory.buffer;
  let beginStatus = 0;
  let beginTrap = null;
  try {
    beginStatus = core.core_di_probe_begin_maximum();
  } catch (error) {
    beginTrap = String(error?.stack ?? error);
  }

  if (!expectAllocation) {
    check(beginTrap === null, "768-page DI allocation failure trapped");
    check(beginStatus === 0, "768-page DI allocation unexpectedly succeeded");
    check(core.core_di_resident_payload_bytes() === 0, "failed allocation retained DI payload");
    check(core.core_di_resident_payload_capacity_bytes() === 0, "failed allocation retained capacity");
    check(core.core_di_pending_count() === 0, "failed allocation published a host request");
    check(core.core_di_probe_finish_maximum() === 0, "failed allocation became serviceable");
    check(core.core_disc_boot_status() === STATUS_COMMITTED, "failed allocation destroyed boot state");
    check(mem1Equals(memory, ramBase, before), "failed allocation mutated MEM1");
    return {
      maximumPages,
      beginStatus,
      beginTrap,
      finalPages: pages(memory),
      payloadBytes: 0,
      requests: 0,
      failedCleanly: true,
    };
  }

  check(beginTrap === null && beginStatus === 1, "2048-page maximum DI allocation failed");
  check(core.core_di_resident_payload_bytes() === DI_BYTES, "DI did not own the full 24 MiB payload");
  check(
    core.core_di_resident_payload_capacity_bytes() >= DI_BYTES,
    "DI payload capacity is shorter than the legal maximum transfer",
  );
  const grewMemory = memory.buffer !== bufferBeforeProbe;
  if (grewMemory) check(bufferBeforeProbe.byteLength === 0, "memory.grow did not detach stale view");

  let requests = 0;
  let maximumRequestBytes = 0;
  let lastRequest = null;
  let duplicateStatus = null;
  while (core.core_di_pending_count() === 1) {
    const request = requestAt(core, "core_di");
    check(request.length > 0 && request.length <= core.core_di_max_chunk_bytes(), "oversized DI host range");
    check(request.containerOffset >= CISO_HEADER_BYTES, "host observed a logical rather than physical CISO range");
    const end = request.containerOffset + request.length;
    check(end <= source.length, "DI requested outside physical CISO container");

    // No Wasm pointer crosses the await. Reacquire under the copied identity afterward.
    const fetched = await Promise.resolve(source.slice(request.containerOffset, end));
    const args = requestArguments(request);
    const pointer = core.core_di_staging_ptr(...args);
    check(pointer !== 0, "DI staging reauthentication failed after await");
    check(pointer + request.length <= memory.buffer.byteLength, "DI staging escaped resident memory");
    new Uint8Array(memory.buffer, pointer, request.length).set(fetched);
    const status = core.core_di_complete(...args, request.length, HOST_OK);
    check(
      status === CALL_ACCEPTED || status === CALL_LOGICAL_READY,
      `authentic DI completion failed with ${status}`,
    );
    check(core.core_di_staging_ptr(...args) === 0, "consumed DI range retained a pointer");
    if (duplicateStatus === null) {
      duplicateStatus = core.core_di_complete(...args, request.length, HOST_OK);
      check(duplicateStatus === CALL_STALE, "duplicate DI completion was not stale");
    }
    lastRequest = request;
    requests += 1;
    maximumRequestBytes = Math.max(maximumRequestBytes, request.length);
  }
  check(requests > 0 && lastRequest !== null, "maximum DI read emitted no physical host work");
  check(core.core_di_resident_payload_bytes() === DI_BYTES, "host receipt released payload before deadline");
  check(mem1Equals(memory, ramBase, before), "host receipt mutated MEM1 before DI deadline service");
  check(core.core_di_probe_finish_maximum() === 1, "exact DI completion deadline did not commit");
  check(core.core_di_resident_payload_bytes() === 0, "completed DI command retained payload");
  check(core.core_di_pending_count() === 0, "completed DI command retained host work");

  const expected = new Uint8Array(DI_BYTES);
  expected.set(logicalIso);
  check(mem1Equals(memory, ramBase, expected), "maximum DI commit did not reproduce logical CISO bytes");
  const lastArgs = requestArguments(lastRequest);
  check(
    core.core_di_complete(...lastArgs, lastRequest.length, HOST_OK) === CALL_STALE,
    "post-commit duplicate DI receipt was not stale",
  );
  check(pages(memory) <= RESIDENT_MAXIMUM_PAGES, "DI exceeded linked resident maximum");
  return {
    maximumPages,
    beginStatus,
    beginTrap,
    initialPages: INITIAL_PAGES,
    finalPages: pages(memory),
    grewMemory,
    payloadBytes: DI_BYTES,
    requests,
    maximumRequestBytes,
    duplicateStatus,
    physicalContainerRangesOnly: true,
    pointerAcrossAwait: false,
    atomicMem1Commit: true,
  };
}

const bytes = await readFile(wasmPath);
const linkedModule = new WebAssembly.Module(bytes);
const legacyModule = new WebAssembly.Module(patchImportedMemoryMaximum(bytes, LEGACY_MAXIMUM_PAGES));
const exported = new Map(WebAssembly.Module.exports(linkedModule).map((item) => [item.name, item.kind]));
for (const name of [
  "core_di_probe_begin_maximum",
  "core_di_probe_finish_maximum",
  "core_di_pending_count",
  "core_di_staging_ptr",
  "core_di_complete",
  "core_di_resident_payload_bytes",
  "core_di_resident_payload_capacity_bytes",
]) {
  check(exported.get(name) === "function", `contract artifact is missing ${name}`);
}

const iso = fixtureIso();
const ciso = fixtureCiso(iso, 0x800);
const legacy = await run(legacyModule, LEGACY_MAXIMUM_PAGES, false, ciso, iso);
const resident = await run(linkedModule, RESIDENT_MAXIMUM_PAGES, true, ciso, iso);
process.stdout.write(`${JSON.stringify({
  wasmBytes: bytes.length,
  contractFeature: "di-contract-probes",
  productionSemanticProbeExport: false,
  legalMaximumTransferBytes: DI_BYTES,
  stagingWindowMaximumBytes: 256 * 1024,
  legacy,
  resident,
})}\n`);
