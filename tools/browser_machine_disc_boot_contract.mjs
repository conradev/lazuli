import { readFile } from "node:fs/promises";

const [wasmPath] = process.argv.slice(2);
if (!wasmPath) {
  process.stderr.write("usage: browser_machine_disc_boot_contract.mjs <browser_machine.wasm>\n");
  process.exit(2);
}

const CISO_HEADER_BYTES = 0x8000;
const RESIDENT_MEMORY_INITIAL_PAGES = 720;
const RESIDENT_MEMORY_MAXIMUM_PAGES = 2048;
const DIAGNOSTIC_LEGACY_MAXIMUM_PAGES = 768;
const BOOT_OFFSET = 0x3000;
const FST_OFFSET = 0xf0000;
const TEXT_FILE_OFFSET = 0x100;
const TEXT_TARGET = 0x80010000;
const TEXT_BYTES = 0x90005;
const BSS_TARGET = 0x800c0000;
const BSS_BYTES = 0x201;
const GAMECUBE_MAGIC = 0xc2339f3d;

const CALL_ACCEPTED = 1;
const CALL_COMMITTED = 2;
const STATUS_PLANNING = 1;
const STATUS_COMMITTED = 3;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function encodeTwoByteU32(value) {
  check(value >= 0x80 && value <= 0x3fff, `invalid two-byte ULEB value ${value}`);
  return [0x80 | (value & 0x7f), value >>> 7];
}

function diagnosticMemoryLimit(bytes) {
  const patched = Uint8Array.from(bytes);
  const descriptor = Uint8Array.from([
    0x06, 0x6c, 0x61, 0x7a, 0x75, 0x6c, 0x69,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
    0x02,
    0x01,
    ...encodeTwoByteU32(RESIDENT_MEMORY_INITIAL_PAGES),
    ...encodeTwoByteU32(RESIDENT_MEMORY_MAXIMUM_PAGES),
  ]);
  const matches = [];
  outer: for (let offset = 0; offset <= patched.length - descriptor.length; offset += 1) {
    for (let index = 0; index < descriptor.length; index += 1) {
      if (patched[offset + index] !== descriptor[index]) continue outer;
    }
    matches.push(offset);
  }
  check(matches.length === 1, `expected one resident memory descriptor, found ${matches.length}`);
  const encoded = encodeTwoByteU32(DIAGNOSTIC_LEGACY_MAXIMUM_PAGES);
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
  image.set(new TextEncoder().encode("Rust Browser Boot Slice\0"), 0x20);
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
  writeBe32(image, BOOT_OFFSET + 0xd8, BSS_TARGET);
  writeBe32(image, BOOT_OFFSET + 0xdc, BSS_BYTES);
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
      header[8 + index] = 1;
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

function requestAt(core, index) {
  return {
    epoch: joined(
      core.core_disc_boot_request_epoch_lo(index),
      core.core_disc_boot_request_epoch_hi(index),
    ),
    id: joined(
      core.core_disc_boot_request_id_lo(index),
      core.core_disc_boot_request_id_hi(index),
    ),
    containerOffset: joined(
      core.core_disc_boot_request_container_offset_lo(index),
      core.core_disc_boot_request_container_offset_hi(index),
    ),
    length: core.core_disc_boot_request_length(index) >>> 0,
  };
}

function requestArguments(request) {
  const [epochLo, epochHi] = halves(request.epoch);
  const [idLo, idHi] = halves(request.id);
  const [offsetLo, offsetHi] = halves(request.containerOffset);
  return [epochLo, epochHi, idLo, idHi, offsetLo, offsetHi, request.length];
}

function begin(core, bytes) {
  const [lo, hi] = halves(bytes);
  return core.core_disc_boot_begin(lo, hi);
}

function pages(memory) {
  return memory.buffer.byteLength / 65536;
}

function be32(memory, offset) {
  return new DataView(memory.buffer).getUint32(offset, false);
}

async function runFixture(module, name, source, logicalIso, reverse, maximumPages, gate) {
  const memory = new WebAssembly.Memory({
    initial: RESIDENT_MEMORY_INITIAL_PAGES,
    maximum: maximumPages,
  });
  const core = new WebAssembly.Instance(module, { lazuli: { memory } }).exports;
  const importedPages = pages(memory);
  check(core.core_init() === 1, `${name}: core_init failed`);
  check(
    core.core_memory_initial_pages() === RESIDENT_MEMORY_INITIAL_PAGES
      && core.core_memory_maximum_pages() === RESIDENT_MEMORY_MAXIMUM_PAGES,
    `${name}: linked resident memory exports changed under ${gate} gate`,
  );
  const initialPages = pages(memory);
  let peakPages = initialPages;
  const samplePages = () => {
    peakPages = Math.max(peakPages, pages(memory));
  };

  // Prove epoch rotation before the real run. Only the pointer-free request is retained across
  // cancellation; reauthenticating it against the next epoch must return the null pointer.
  check(begin(core, source.length) === CALL_ACCEPTED, `${name}: stale probe begin failed`);
  const stale = requestAt(core, 0);
  check(core.core_disc_boot_cancel() === 1, `${name}: stale probe cancel failed`);
  check(begin(core, source.length) === CALL_ACCEPTED, `${name}: rotated begin failed`);
  const current = requestAt(core, 0);
  check(stale.epoch !== current.epoch, `${name}: Rust reused a cancelled boot epoch`);
  check(
    core.core_disc_boot_staging_ptr(...requestArguments(stale)) === 0,
    `${name}: stale request reacquired a staging pointer after epoch rotation`,
  );
  check(core.core_disc_boot_cancel() === 1, `${name}: rotated cancel failed`);

  check(begin(core, source.length) === CALL_ACCEPTED, `${name}: boot begin failed`);
  check(core.core_disc_boot_status() === STATUS_PLANNING, `${name}: not planning after begin`);
  const ramBase = core.core_main_ram_offset();
  new Uint8Array(memory.buffer, ramBase, 0x100).fill(0xa5);
  const originalLow = new Uint8Array(memory.buffer.slice(ramBase, ramBase + 0x100));
  let requests = 0;
  let maximumRequestBytes = 0;
  let consecutiveMaximumRequests = 0;
  let maximumConsecutiveMaximumRequests = 0;
  let completed = false;

  while (!completed) {
    const count = core.core_disc_boot_pending_count();
    check(count > 0, `${name}: live boot exposed no exact request`);
    const descriptors = Array.from({ length: count }, (_unused, index) => requestAt(core, index));
    if (reverse) descriptors.reverse();
    for (const request of descriptors) {
      check(request.length <= core.core_disc_boot_max_chunk_bytes(), `${name}: oversized chunk`);
      const end = request.containerOffset + request.length;
      check(end <= source.length, `${name}: request outside container`);

      // This Promise boundary intentionally retains no Wasm pointer. The staging allocation is
      // reacquired under the full descriptor only after the simulated asynchronous fetch settles.
      const fetched = await Promise.resolve(source.slice(request.containerOffset, end));
      samplePages();
      const args = requestArguments(request);
      const stagingPointer = core.core_disc_boot_staging_ptr(...args);
      check(stagingPointer !== 0, `${name}: authentic staging lookup failed`);
      check(
        stagingPointer >= core.core_runtime_base()
          && stagingPointer + request.length <= memory.buffer.byteLength,
        `${name}: staging allocation escaped Rust runtime memory`,
      );
      new Uint8Array(memory.buffer, stagingPointer, request.length).set(fetched);
      let result;
      try {
        result = core.core_disc_boot_complete(...args, request.length);
      } catch (error) {
        throw new Error(
          `${name}: completion ${requests + 1} trapped at ${pages(memory)}/`
            + `${maximumPages} pages (request=${request.length}, `
            + `status=${core.core_disc_boot_status()})`,
          { cause: error },
        );
      }
      samplePages();
      check(
        result === CALL_ACCEPTED || result === CALL_COMMITTED,
        `${name}: exact completion failed with ${result}`,
      );
      check(
        core.core_disc_boot_staging_ptr(...args) === 0,
        `${name}: consumed request retained a staging pointer`,
      );
      requests += 1;
      maximumRequestBytes = Math.max(maximumRequestBytes, request.length);
      if (request.length === core.core_disc_boot_max_chunk_bytes()) {
        consecutiveMaximumRequests += 1;
        maximumConsecutiveMaximumRequests = Math.max(
          maximumConsecutiveMaximumRequests,
          consecutiveMaximumRequests,
        );
      } else {
        consecutiveMaximumRequests = 0;
      }
      if (result === CALL_COMMITTED) {
        completed = true;
        break;
      }
      const currentLow = new Uint8Array(memory.buffer, ramBase, 0x100);
      check(
        currentLow.every((byte, index) => byte === originalLow[index]),
        `${name}: low memory changed before terminal BootCommitRecord`,
      );
    }
  }

  check(core.core_disc_boot_status() === STATUS_COMMITTED, `${name}: terminal status mismatch`);
  check(core.core_disc_boot_fault() === 0, `${name}: successful boot published a fault`);
  check(core.core_disc_boot_pending_count() === 0, `${name}: commit retained requests`);
  check(
    maximumConsecutiveMaximumRequests >= 2,
    `${name}: fixture did not exercise consecutive maximum-size semantic buffers`,
  );
  check(be32(memory, ramBase + 0x00) === 0x475a4c45, `${name}: game code mismatch`);
  check(be32(memory, ramBase + 0x1c) === GAMECUBE_MAGIC, `${name}: DVD magic mismatch`);
  check(be32(memory, ramBase + 0x30) === 0, `${name}: ArenaLo mismatch`);
  check(be32(memory, ramBase + 0x3c) === 47, `${name}: FST max mismatch`);
  const textOffset = ramBase + (TEXT_TARGET - 0x80000000);
  const loadedText = new Uint8Array(memory.buffer, textOffset, TEXT_BYTES);
  check(
    loadedText.every(
      (byte, index) => byte === logicalIso[BOOT_OFFSET + TEXT_FILE_OFFSET + index],
    ),
    `${name}: streamed DOL text mismatch`,
  );
  const bssOffset = ramBase + (BSS_TARGET - 0x80000000);
  check(
    new Uint8Array(memory.buffer, bssOffset, BSS_BYTES).every((byte) => byte === 0),
    `${name}: local BSS zero mismatch`,
  );
  const finalPages = pages(memory);
  samplePages();
  return {
    name,
    gate,
    maximumPages,
    importedPages,
    initialPages,
    peakPages,
    finalPages,
    freePagesAtPeak: maximumPages - peakPages,
    requests,
    maximumRequestBytes,
    maximumConsecutiveMaximumRequests,
    pointerAcrossAsync: false,
    stalePointerAfterRotation: 0,
  };
}

const bytes = await readFile(wasmPath);
const diagnosticBytes = diagnosticMemoryLimit(bytes);
const linkedModule = new WebAssembly.Module(bytes);
const diagnosticModule = new WebAssembly.Module(diagnosticBytes);
const required = [
  "core_memory_initial_pages",
  "core_memory_maximum_pages",
  "core_disc_boot_max_chunk_bytes",
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
];
const exports = new Map(
  WebAssembly.Module.exports(linkedModule).map((item) => [item.name, item.kind]),
);
for (const name of required) {
  check(exports.get(name) === "function", `missing integer-only disc boot export ${name}`);
}

const iso = fixtureIso();
const ciso = fixtureCiso(iso, 0x200);
const diagnosticRaw = await runFixture(
  diagnosticModule,
  "raw-iso",
  iso,
  iso,
  false,
  DIAGNOSTIC_LEGACY_MAXIMUM_PAGES,
  "diagnostic-legacy",
);
const diagnosticCiso = await runFixture(
  diagnosticModule,
  "sparse-ciso",
  ciso,
  iso,
  true,
  DIAGNOSTIC_LEGACY_MAXIMUM_PAGES,
  "diagnostic-legacy",
);
const residentRaw = await runFixture(
  linkedModule,
  "raw-iso",
  iso,
  iso,
  false,
  RESIDENT_MEMORY_MAXIMUM_PAGES,
  "resident-linked",
);
const residentCiso = await runFixture(
  linkedModule,
  "sparse-ciso",
  ciso,
  iso,
  true,
  RESIDENT_MEMORY_MAXIMUM_PAGES,
  "resident-linked",
);
process.stdout.write(`${JSON.stringify({
  wasmBytes: bytes.length,
  linkedMaximumPages: RESIDENT_MEMORY_MAXIMUM_PAGES,
  diagnosticMaximumPages: DIAGNOSTIC_LEGACY_MAXIMUM_PAGES,
  linkedImportMaximumValidated: true,
  diagnosticConstruction: "exact-one lazuli.memory descriptor maximum patched 2048->768",
  diagnostic: { raw: diagnosticRaw, ciso: diagnosticCiso },
  resident: { raw: residentRaw, ciso: residentCiso },
})}\n`);
