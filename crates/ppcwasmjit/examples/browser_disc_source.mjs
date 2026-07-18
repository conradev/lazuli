// SPDX-License-Identifier: GPL-3.0-only

const CISO_HEADER_SIZE = 0x8000;
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const NETWORK_CHUNK_BYTES = 256 * 1024;
const DEFAULT_PARALLEL_CHUNKS = 4;
const MEM1_BYTES = 24 * 1024 * 1024;
const MAX_DOL_BYTES = 32 * 1024 * 1024;
// Disc boot normally lets the apploader establish the low-memory arena. The
// browser harness loads the boot DOL directly, so retain Lazuli's IPL-HLE arena
// floor and only move it upward for executables with a larger static layout.
export const GC_IPL_HLE_ARENA_LOW = 0x8042e260;

function checkRange(offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`invalid disc offset ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`invalid disc length ${length}`);
  }
  if (!Number.isSafeInteger(offset + length)) {
    throw new RangeError("disc range exceeds JavaScript's safe integer range");
  }
}

function exactBytes(buffer, length, label) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length !== length) {
    throw new Error(`${label} returned ${bytes.length} bytes; expected ${length}`);
  }
  return bytes;
}

export class BlobByteSource {
  constructor(blob) {
    if (!(blob instanceof Blob)) throw new TypeError("local disc source must be a Blob or File");
    this.blob = blob;
    this.size = blob.size;
    this.kind = "local-file";
    this.reads = 0;
    this.bytesRead = 0;
  }

  async read(offset, length) {
    checkRange(offset, length);
    if (offset + length > this.size) throw new RangeError("local disc read exceeds file size");
    const bytes = new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
    this.reads += 1;
    this.bytesRead += bytes.length;
    return exactBytes(bytes, length, "local disc read");
  }

  describe() {
    return { kind: this.kind, size: this.size, reads: this.reads, bytesRead: this.bytesRead };
  }
}

export class HttpRangeByteSource {
  constructor(url) {
    this.url = new URL(url).href;
    this.size = null;
    this.kind = "http-range";
    this.reads = 0;
    this.bytesRead = 0;
  }

  async read(offset, length) {
    checkRange(offset, length);
    if (length === 0) return new Uint8Array();
    const end = offset + length - 1;
    const response = await fetch(this.url, {
      cache: "no-store",
      headers: { Range: `bytes=${offset}-${end}` },
    });
    if (response.status !== 206) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the useful protocol error if cancellation itself fails.
      }
      throw new Error(
        `network disc must support HTTP Range requests; received ${response.status}`
      );
    }
    const contentRange = response.headers.get("content-range");
    const match = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (match === null || Number(match[1]) !== offset || Number(match[2]) !== end) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the useful protocol error if cancellation itself fails.
      }
      throw new Error(`invalid Content-Range for disc request: ${contentRange ?? "missing"}`);
    }
    if (match[3] !== "*") this.size = Number(match[3]);
    const bytes = exactBytes(await response.arrayBuffer(), length, "HTTP disc range");
    this.reads += 1;
    this.bytesRead += bytes.length;
    return bytes;
  }

  describe() {
    return {
      kind: this.kind,
      url: this.url,
      size: this.size,
      reads: this.reads,
      bytesRead: this.bytesRead,
    };
  }
}

export class QueryRangeByteSource {
  constructor(url) {
    this.url = new URL(url).href;
    this.size = null;
    this.kind = "logical-range-endpoint";
    this.reads = 0;
    this.bytesRead = 0;
  }

  async read(offset, length) {
    checkRange(offset, length);
    const url = new URL(this.url);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(length));
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`disc range endpoint returned ${response.status}`);
    const bytes = exactBytes(await response.arrayBuffer(), length, "disc range endpoint");
    this.reads += 1;
    this.bytesRead += bytes.length;
    return bytes;
  }

  describe() {
    return { kind: this.kind, url: this.url, reads: this.reads, bytesRead: this.bytesRead };
  }
}

export class CachedByteSource {
  constructor(source, options = {}) {
    this.source = source;
    this.size = source.size ?? null;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
    this.maximumChunks = Math.max(1, Math.floor(cacheBytes / this.chunkBytes));
    this.parallelChunks = Math.max(
      1,
      Math.floor(options.parallelChunks ?? DEFAULT_PARALLEL_CHUNKS),
    );
    this.chunks = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  seed(offset, bytes) {
    if (offset % this.chunkBytes !== 0 || bytes.length !== this.chunkBytes) return;
    this.chunks.set(offset / this.chunkBytes, Promise.resolve(bytes.slice()));
  }

  async chunk(index) {
    let pending = this.chunks.get(index);
    if (pending !== undefined) {
      this.hits += 1;
      this.chunks.delete(index);
      this.chunks.set(index, pending);
      return pending;
    }
    this.misses += 1;
    const offset = index * this.chunkBytes;
    const length = this.size === null
      ? this.chunkBytes
      : Math.min(this.chunkBytes, this.size - offset);
    if (length <= 0) throw new RangeError("disc cache read exceeds source size");
    pending = this.source.read(offset, length);
    this.chunks.set(index, pending);
    if (this.chunks.size > this.maximumChunks) {
      this.chunks.delete(this.chunks.keys().next().value);
      this.evictions += 1;
    }
    return pending;
  }

  async read(offset, length) {
    checkRange(offset, length);
    if (this.size !== null && offset + length > this.size) {
      throw new RangeError("cached disc read exceeds source size");
    }
    const output = new Uint8Array(length);
    if (length === 0) return output;
    const firstChunk = Math.floor(offset / this.chunkBytes);
    const lastChunk = Math.floor((offset + length - 1) / this.chunkBytes);
    for (
      let batchStart = firstChunk;
      batchStart <= lastChunk;
      batchStart += this.parallelChunks
    ) {
      const indexes = Array.from(
        { length: Math.min(this.parallelChunks, lastChunk - batchStart + 1) },
        (_unused, index) => batchStart + index,
      );
      const chunks = await Promise.all(indexes.map(index => this.chunk(index)));
      for (let index = 0; index < chunks.length; index += 1) {
        const chunkIndex = indexes[index];
        const chunk = chunks[index];
        const chunkStart = chunkIndex * this.chunkBytes;
        const copyStart = Math.max(offset, chunkStart);
        const copyEnd = Math.min(offset + length, chunkStart + chunk.length);
        if (copyEnd <= copyStart) throw new Error("short cached disc chunk");
        output.set(
          chunk.subarray(copyStart - chunkStart, copyEnd - chunkStart),
          copyStart - offset,
        );
      }
    }
    return output;
  }

  describe() {
    return {
      ...this.source.describe(),
      cache: {
        chunkBytes: this.chunkBytes,
        maximumBytes: this.maximumChunks * this.chunkBytes,
        parallelChunks: this.parallelChunks,
        residentBytes: this.chunks.size * this.chunkBytes,
        hits: this.hits,
        misses: this.misses,
        evictions: this.evictions,
      },
    };
  }
}

export function parseCisoHeader(header) {
  if (header.length !== CISO_HEADER_SIZE) throw new Error("CISO header must be 32 KiB");
  if (String.fromCharCode(...header.subarray(0, 4)) !== "CISO") {
    throw new Error("invalid CISO magic");
  }
  const blockSize = new DataView(header.buffer, header.byteOffset, header.byteLength)
    .getUint32(4, true);
  if (blockSize === 0 || (blockSize & 31) !== 0) throw new Error("invalid CISO block size");
  const physicalOffsets = new Uint32Array(header.length - 8);
  physicalOffsets.fill(0xffffffff);
  let physical = CISO_HEADER_SIZE;
  let presentBlocks = 0;
  for (let index = 0; index < physicalOffsets.length; index += 1) {
    if (header[index + 8] === 0) continue;
    if (physical > 0xffffffff) throw new Error("CISO physical offset exceeds 32 bits");
    physicalOffsets[index] = physical;
    physical += blockSize;
    presentBlocks += 1;
  }
  return { blockSize, physicalOffsets, presentBlocks };
}

export class CisoDiscSource {
  constructor(physical, parsed) {
    this.physical = physical;
    this.blockSize = parsed.blockSize;
    this.physicalOffsets = parsed.physicalOffsets;
    this.presentBlocks = parsed.presentBlocks;
    this.size = this.blockSize * this.physicalOffsets.length;
    this.kind = "ciso";
    this.logicalReads = 0;
    this.logicalBytes = 0;
    this.physicalRuns = 0;
  }

  async read(offset, length) {
    checkRange(offset, length);
    if (offset + length > this.size) throw new RangeError("CISO read exceeds logical image");
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const position = offset + written;
      const block = Math.floor(position / this.blockSize);
      const within = position % this.blockSize;
      const physical = this.physicalOffsets[block];
      let count = Math.min(length - written, this.blockSize - within);
      if (physical === 0xffffffff) {
        written += count;
        continue;
      }

      let nextBlock = block + 1;
      while (
        written + count < length
        && nextBlock < this.physicalOffsets.length
        && this.physicalOffsets[nextBlock] === physical + (nextBlock - block) * this.blockSize
      ) {
        const nextCount = Math.min(length - written - count, this.blockSize);
        count += nextCount;
        if (nextCount < this.blockSize) break;
        nextBlock += 1;
      }
      const data = await this.physical.read(physical + within, count);
      output.set(data, written);
      written += count;
      this.physicalRuns += 1;
    }
    this.logicalReads += 1;
    this.logicalBytes += length;
    return output;
  }

  describe() {
    return {
      ...this.physical.describe(),
      format: this.kind,
      logicalSize: this.size,
      blockSize: this.blockSize,
      presentBlocks: this.presentBlocks,
      logicalReads: this.logicalReads,
      logicalBytes: this.logicalBytes,
      physicalRuns: this.physicalRuns,
    };
  }
}

export async function openDiscSource(config, options = {}) {
  let raw;
  if (config.kind === "file") raw = new BlobByteSource(config.file);
  else if (config.kind === "http-range") raw = new HttpRangeByteSource(config.url);
  else if (config.kind === "logical-range-endpoint") raw = new QueryRangeByteSource(config.url);
  else throw new Error(`unsupported disc source kind ${config.kind}`);

  const chunkBytes = options.chunkBytes ?? (
    config.kind === "file" ? DEFAULT_CHUNK_BYTES : NETWORK_CHUNK_BYTES
  );
  const cached = new CachedByteSource(raw, { ...options, chunkBytes });
  const prefixLength = cached.size === null
    ? cached.chunkBytes
    : Math.min(cached.chunkBytes, cached.size);
  const prefix = await raw.read(0, prefixLength);
  cached.size = raw.size ?? cached.size;
  cached.seed(0, prefix);
  const magic = String.fromCharCode(...prefix.subarray(0, 4));
  if (magic !== "CISO") return cached;
  if (prefix.length < CISO_HEADER_SIZE) throw new Error("truncated CISO header");
  return new CisoDiscSource(cached, parseCisoHeader(prefix.subarray(0, CISO_HEADER_SIZE)));
}

function u32(view, offset) {
  return view.getUint32(offset, false);
}

function ascii(bytes) {
  return String.fromCharCode(...bytes);
}

function canonicalMem1Range(address, size, label) {
  if (!Number.isInteger(address) || !Number.isInteger(size) || size < 0) {
    throw new Error(`invalid ${label} range`);
  }
  if (size === 0) return null;
  let physical;
  if (address >= 0x80000000 && address < 0x81800000) {
    physical = address - 0x80000000;
  } else if (address >= 0xc0000000 && address < 0xc1800000) {
    physical = address - 0xc0000000;
  } else {
    throw new Error(`${label} starts outside MEM1`);
  }
  if (size > MEM1_BYTES - physical) throw new Error(`${label} extends past MEM1`);
  return { start: 0x80000000 + physical, end: 0x80000000 + physical + size };
}

export function inspectDolLayout(dol, options = {}) {
  const bytes = dol instanceof Uint8Array ? dol : new Uint8Array(dol);
  if (bytes.length < 0x100) throw new Error("truncated DOL header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = [];
  let dolSize = 0x100;
  let arenaLow = GC_IPL_HLE_ARENA_LOW;
  for (let index = 0; index < 18; index += 1) {
    const fileOffset = u32(view, index * 4);
    const target = u32(view, 0x48 + index * 4);
    const size = u32(view, 0x90 + index * 4);
    if (size === 0) continue;
    if (fileOffset < 0x100) throw new Error(`invalid DOL section ${index} file offset`);
    const fileEnd = fileOffset + size;
    if (fileEnd > MAX_DOL_BYTES) throw new Error("DOL exceeds the 32 MiB boot limit");
    if (options.headerOnly !== true && fileEnd > bytes.length) {
      throw new Error(`DOL section ${index} extends past the file`);
    }
    const range = canonicalMem1Range(target, size, `DOL section ${index}`);
    sections.push({ fileOffset, index, size, ...range });
    dolSize = Math.max(dolSize, fileEnd);
    arenaLow = Math.max(arenaLow, range.end);
  }
  const bssTarget = u32(view, 0xd8);
  const bssSize = u32(view, 0xdc);
  const bss = canonicalMem1Range(bssTarget, bssSize, "DOL BSS");
  if (bss !== null) arenaLow = Math.max(arenaLow, bss.end);
  const entry = u32(view, 0xe0);
  canonicalMem1Range(entry, 4, "DOL entrypoint");
  return {
    arenaLow: Math.ceil(arenaLow / 32) * 32,
    bss,
    bssSize,
    bssTarget,
    dolSize,
    entry,
    sections,
  };
}

export async function readDiscBoot(source) {
  const header = await source.read(0, 0x440);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (u32(view, 0x1c) !== 0xc2339f3d) throw new Error("disc has no GameCube magic word");
  const bootOffset = u32(view, 0x420);
  const fstOffset = u32(view, 0x424);
  const fstSize = u32(view, 0x428);
  const fstMaxSize = Math.max(fstSize, u32(view, 0x42c));
  if (fstSize > MEM1_BYTES || fstMaxSize > MEM1_BYTES) {
    throw new Error("disc FST exceeds MEM1");
  }
  if (source.size !== null && source.size !== undefined) {
    if (bootOffset > source.size - 0x100) throw new Error("DOL header exceeds disc image");
    if (fstOffset > source.size - fstSize) throw new Error("FST exceeds disc image");
  }
  const dolHeader = await source.read(bootOffset, 0x100);
  const dolSize = inspectDolLayout(dolHeader, { headerOnly: true }).dolSize;
  if (source.size !== null && source.size !== undefined && bootOffset > source.size - dolSize) {
    throw new Error("DOL exceeds disc image");
  }
  const [dol, fst] = await Promise.all([
    source.read(bootOffset, dolSize),
    source.read(fstOffset, fstSize),
  ]);
  const dolLayout = inspectDolLayout(dol);
  const titleEnd = header.indexOf(0, 0x20);
  const title = new TextDecoder().decode(
    header.subarray(0x20, titleEnd < 0 || titleEnd > 0x400 ? 0x400 : titleEnd)
  ).trim();
  const identifier = ascii(header.subarray(0, 6));
  const revision = header[7];
  const label = title === ""
    ? `${identifier} Rev.${String(revision).padStart(2, "0")}`
    : `${title} (${identifier} Rev.${String(revision).padStart(2, "0")})`;
  const fstAddress = 0x817fe8c0 - Math.ceil(fstMaxSize / 32) * 32;
  if (fstAddress < 0x80000000 || fstAddress + fstMaxSize > 0x81800000) {
    throw new Error("disc FST does not fit in MEM1");
  }
  const fstEnd = fstAddress + fstMaxSize;
  const overlapsFst = (start, size) =>
    size !== 0 && start < fstEnd && fstAddress < start + size;
  for (const section of dolLayout.sections) {
    if (overlapsFst(section.start, section.size)) {
      throw new Error(`disc FST overlaps DOL section ${section.index}`);
    }
  }
  if (dolLayout.bss !== null && overlapsFst(dolLayout.bss.start, dolLayout.bssSize)) {
    throw new Error("disc FST overlaps DOL BSS");
  }
  return {
    arenaLow: dolLayout.arenaLow,
    audioStreaming: header[8],
    discId: header[6],
    dol,
    fst,
    fstAddress,
    fstMaxSize,
    gameCode: u32(view, 0),
    identifier,
    label,
    makerCode: view.getUint16(4, false),
    streamBufferSize: header[9],
    tvMode: header[3] === 0x50 ? 1 : 0,
    version: revision,
  };
}
