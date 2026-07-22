#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function makeContext() {
  const memory = new ArrayBuffer(0x200);
  const context = {
    cpControlBreakpointEnable: 0x0002,
    cpControlLinkEnable: 0x0010,
    cpControlMask: 0x003f,
    cpControlReadEnable: 0x0001,
    cpFifoAddressMask: 0x03ffffe0,
    cpFifoHighWordMask: 0x03ff,
    cpFifoLowWordMask: 0xffe0,
    cpFifoState: {},
    cpStatusBreakpoint: 0x0010,
    cpStatusCommandIdle: 0x0008,
    cpStatusHighWatermark: 0x0001,
    cpStatusLowWatermark: 0x0002,
    cpStatusReadIdle: 0x0004,
    hex32: value => "0x" + (value >>> 0).toString(16).padStart(8, "0"),
    mmio: 0,
    piFifoEndMask: 0x07ffffe0,
    piFifoState: {},
    piFifoWrap: 0x20000000,
    resetGxCommandProcessorDecoder() {},
    resetGxWriteGatherPipe() {},
    serviceCommandProcessorFifo() { return 0; },
    translateDataRange: address => (
      address >= 0xc0000000 ? (address - 0xc0000000) >>> 0 : address >>> 0
    ),
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "resetFifoRegisterState",
      "resetCommandProcessorFifoFromPi",
      "commandProcessorBreakpointLevel",
      "readCommandProcessorStatus",
      "commandProcessorPairValue",
      "writeCommandProcessorPairValue",
      "commandProcessorRegisterRangeOverlaps",
      "readCommandProcessorRegister",
      "writeCommandProcessorRegister",
      "readProcessorInterfaceFifoRegister",
      "writeProcessorInterfaceFifoRegister",
      "snapshotCommandProcessorFifo",
      "snapshotProcessorInterfaceFifo",
      "readInteger",
      "writeInteger",
    ]
      .map(extractFunction)
      .join("\n\n"),
    context,
    { filename: "browser_boot.cp.js" },
  );
  context.resetFifoRegisterState();
  return context;
}

function read16(context, address) {
  const resultPointer = 0x100;
  assert.equal(context.readInteger(address, resultPointer, 2), 1);
  return context.view.getUint16(resultPointer, true);
}

function read32(context, address) {
  const resultPointer = 0x100;
  assert.equal(context.readInteger(address, resultPointer, 4), 1);
  return context.view.getUint32(resultPointer, true);
}

function write16(context, address, value) {
  assert.equal(context.writeInteger(address, value, 2), 1);
}

function write32(context, address, value) {
  assert.equal(context.writeInteger(address, value, 4), 1);
}

function readRejected(context, address, size) {
  const resultPointer = 0x100;
  context.view.setBigUint64(resultPointer, 0x1122334455667788n, true);
  assert.equal(context.readInteger(address, resultPointer, size), 0);
  assert.equal(
    context.view.getBigUint64(resultPointer, true),
    0x1122334455667788n,
    "a rejected modeled-register read must not publish raw MMIO bytes",
  );
}

function writeRejected(context, address, value, size) {
  const before = JSON.stringify({ cp: context.cpFifoState, pi: context.piFifoState });
  assert.equal(context.writeInteger(address, value, size), 0);
  assert.equal(
    JSON.stringify({ cp: context.cpFifoState, pi: context.piFifoState }),
    before,
    "a rejected modeled-register write must not mutate modeled state",
  );
}

function writePair(context, offset, value) {
  write16(context, 0xcc000000 + offset, value & 0xffff);
  write16(context, 0xcc000000 + offset + 2, value >>> 16);
}

test("CP and PI FIFO registers cold-initialize to zero", () => {
  const context = makeContext();

  assert.deepEqual({ ...context.cpFifoState }, {
    control: 0,
    base: 0,
    end: 0,
    highWatermark: 0,
    lowWatermark: 0,
    distance: 0,
    writePointer: 0,
    readPointer: 0,
    breakpoint: 0,
  });
  assert.deepEqual({ ...context.piFifoState }, {
    base: 0,
    end: 0,
    current: 0,
    wrap: false,
  });
  assert.equal(read16(context, 0xcc000000), 0x000c);
  assert.equal(read16(context, 0xcc000002), 0);
  assert.equal(read16(context, 0xcc000004), 0);
  assert.equal(read32(context, 0xcc00300c), 0);
  assert.equal(read32(context, 0xcc003010), 0);
  assert.equal(read32(context, 0xcc003014), 0);

  context.cpFifoState.base = 0x100;
  context.piFifoState.wrap = true;
  context.resetFifoRegisterState();
  assert.equal(context.cpFifoState.base, 0);
  assert.equal(context.cpFifoState.highWatermark, 0);
  assert.equal(context.piFifoState.wrap, false);
});

test("PI FIFO reset is write-only and preserves programmed FIFO registers", () => {
  const context = makeContext();
  Object.assign(context.cpFifoState, {
    control: 0x003f,
    base: 0x00000100,
    end: 0x000001e0,
    highWatermark: 0x00000080,
    lowWatermark: 0x00000020,
    distance: 0x00000060,
    writePointer: 0x00000140,
    readPointer: 0x00000120,
    breakpoint: 0x000001a0,
  });
  Object.assign(context.piFifoState, {
    base: 0x00000200,
    end: 0x04000000,
    current: 0x00000240,
    wrap: true,
  });
  const preservedCp = {
    base: context.cpFifoState.base,
    end: context.cpFifoState.end,
    distance: context.cpFifoState.distance,
    writePointer: context.cpFifoState.writePointer,
    readPointer: context.cpFifoState.readPointer,
    breakpoint: context.cpFifoState.breakpoint,
  };
  const preservedPi = { ...context.piFifoState };

  write32(context, 0xcc003018, 0x00000002);
  assert.equal(context.cpFifoState.control, 0x003f, "bit zero clear is a no-op");
  assert.equal(context.cpFifoState.highWatermark, 0x00000080);
  assert.equal(context.cpFifoState.lowWatermark, 0x00000020);
  assert.equal(read32(context, 0x0c003018), 0, "write-only reset reads as zero");

  write32(context, 0x0c003018, 0x00000003);
  assert.equal(context.cpFifoState.control, 0x0010);
  assert.equal(context.cpFifoState.highWatermark, 0x03ffffe0);
  assert.equal(context.cpFifoState.lowWatermark, 0);
  for (const [name, value] of Object.entries(preservedCp)) {
    assert.equal(context.cpFifoState[name], value, `${name} survives PI reset`);
  }
  assert.deepEqual({ ...context.piFifoState }, preservedPi);
  assert.equal(read32(context, 0xcc003018), 0);
});

test("CP status is read-only, clear reads zero, and control masks to bits 0 through 5", () => {
  const context = makeContext();

  write16(context, 0xcc000002, 0xffff);
  assert.equal(read16(context, 0x0c000002), 0x003f);

  write16(context, 0xcc000000, 0xffff);
  assert.equal(
    read16(context, 0x0c000000),
    0x001c,
    "enabled breakpoint level remains derived from the modeled pointers",
  );
  write16(context, 0xcc000004, 0xffff);
  assert.equal(read16(context, 0x0c000004), 0);

  assert.equal(
    context.view.getUint16(context.mmio, false),
    0,
    "modeled registers must not leak into raw MMIO storage",
  );
});

test("unsupported widths overlapping modeled CP and PI registers fail closed", () => {
  const context = makeContext();

  readRejected(context, 0xcc000000, 1);
  readRejected(context, 0xcc000000, 4);
  writeRejected(context, 0xcc000002, 0xff, 1);
  writeRejected(context, 0xcc000020, 0xffffffff, 4);

  readRejected(context, 0xcc00300c, 1);
  readRejected(context, 0xcc003010, 2);
  writeRejected(context, 0xcc003014, 0xff, 1);
  writeRejected(context, 0xcc00300c, 0xffff, 2);

  readRejected(context, 0xcc003018, 1);
  readRejected(context, 0xcc003018, 2);
  writeRejected(context, 0xcc003018, 1, 1);
  writeRejected(context, 0xcc003018, 1, 2);
  assert.equal(read32(context, 0xcc003018), 0);
});

test("every CP FIFO pair accepts the low word first and masks addresses exactly", () => {
  const context = makeContext();
  const pairs = [
    [0x20, "base"],
    [0x24, "end"],
    [0x28, "highWatermark"],
    [0x2c, "lowWatermark"],
    [0x30, "distance"],
    [0x34, "writePointer"],
    [0x38, "readPointer"],
    [0x3c, "breakpoint"],
  ];

  for (const [offset, name] of pairs) {
    context.cpFifoState[name] = 0;
    write16(context, 0xcc000000 + offset, 0x123f);
    assert.equal(context.cpFifoState[name], 0x1220, `${name} low mask`);
    assert.equal(read16(context, 0x0c000000 + offset), 0x1220);

    write16(context, 0xcc000000 + offset + 2, 0xffff);
    assert.equal(context.cpFifoState[name], 0x03ff1220, `${name} high mask`);
    assert.equal(read16(context, 0x0c000000 + offset + 2), 0x03ff);
  }

  writePair(context, 0x20, 0x03ffffe0);
  writePair(context, 0x24, 0);
  writePair(context, 0x30, 0x02000020);
  assert.equal(context.cpFifoState.base, 0x03ffffe0);
  assert.equal(context.cpFifoState.end, 0);
  assert.equal(
    context.cpFifoState.distance,
    0x02000020,
    "partial pair writes are accepted without transient consistency checks",
  );
});

test("CP watermarks and idle levels use the authoritative distance with strict comparisons", () => {
  const context = makeContext();
  write16(context, 0xcc000002, 0x0001);
  writePair(context, 0x28, 0x00000040);
  writePair(context, 0x2c, 0x00000020);

  writePair(context, 0x30, 0x00000040);
  assert.equal(read16(context, 0xcc000000), 0, "distance equal to high is not high");
  writePair(context, 0x30, 0x00000060);
  assert.equal(read16(context, 0xcc000000), 0x0001);

  writePair(context, 0x30, 0x00000020);
  assert.equal(read16(context, 0xcc000000), 0, "distance equal to low is not low");
  writePair(context, 0x30, 0);
  assert.equal(
    read16(context, 0xcc000000),
    0x000e,
    "empty asserts low, read-idle, and command-idle",
  );
});

test("CP breakpoint level stops commands without making a nonempty FIFO read-idle", () => {
  const context = makeContext();
  write32(context, 0xcc003018, 1);
  writePair(context, 0x30, 0x20);
  writePair(context, 0x38, 0x100);
  writePair(context, 0x3c, 0x100);

  write16(context, 0xcc000002, 0x0003);
  assert.equal(read16(context, 0xcc000000), 0x0018);

  write16(context, 0xcc000002, 0x0001);
  assert.equal(read16(context, 0xcc000000), 0);

  write16(context, 0xcc000002, 0);
  assert.equal(read16(context, 0xcc000000), 0x0008);
  assert.equal(
    read16(context, 0xcc000000) & 0x0004,
    0,
    "read-idle depends only on the authoritative empty distance",
  );
});

test("PI FIFO aliases mask addresses, preserve end semantics, and keep wrap separate", () => {
  const context = makeContext();
  context.cpFifoState.base = 0x00000100;
  context.cpFifoState.end = 0x00000200;
  context.cpFifoState.writePointer = 0x00000300;

  write32(context, 0xcc00300c, 0xffffffff);
  write32(context, 0x0c003010, 0x0123457f);
  write32(context, 0xcc003014, 0x2234567f);

  assert.equal(context.piFifoState.base, 0x03ffffe0);
  assert.equal(context.piFifoState.end, 0x01234560);
  assert.equal(context.piFifoState.current, 0x02345660);
  assert.equal(context.piFifoState.wrap, true);
  assert.equal(read32(context, 0x0c00300c), 0x03ffffe0);
  assert.equal(read32(context, 0xcc003010), 0x01234560);
  assert.equal(read32(context, 0x0c003014), 0x22345660);
  assert.equal(context.cpFifoState.base, 0x00000100);
  assert.equal(context.cpFifoState.end, 0x00000200);
  assert.equal(context.cpFifoState.writePointer, 0x00000300);

  write32(context, 0xcc003010, 0x04000000);
  assert.equal(context.piFifoState.end, 0x04000000);
  assert.equal(
    read32(context, 0x0c003010),
    0x04000000,
    "the legal one-past GX redirect sentinel survives PI end masking",
  );

  write32(context, 0xcc003014, 0x0000043f);
  assert.equal(context.piFifoState.current, 0x00000420);
  assert.equal(context.piFifoState.wrap, false);
  assert.equal(read32(context, 0xcc003014), 0x00000420);

  writePair(context, 0x20, 0x00000500);
  writePair(context, 0x24, 0x00000600);
  writePair(context, 0x34, 0x00000700);
  assert.equal(context.piFifoState.base, 0x03ffffe0);
  assert.equal(context.piFifoState.end, 0x04000000);
  assert.equal(context.piFifoState.current, 0x00000420);
});

test("FIFO diagnostics expose the modeled CP and independent PI state", () => {
  const context = makeContext();
  write32(context, 0xcc003018, 1);
  write16(context, 0xcc000002, 0x0003);
  writePair(context, 0x20, 0x00000100);
  writePair(context, 0x24, 0x000001e0);
  writePair(context, 0x30, 0x00000040);
  writePair(context, 0x38, 0x00000120);
  writePair(context, 0x3c, 0x00000120);
  write32(context, 0xcc00300c, 0x00000200);
  write32(context, 0xcc003010, 0x000002e0);
  write32(context, 0xcc003014, 0x20000240);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.snapshotCommandProcessorFifo())),
    {
      status: "0x0018",
      control: "0x0003",
      base: "0x00000100",
      end: "0x000001e0",
      highWatermark: "0x03ffffe0",
      lowWatermark: "0x00000000",
      distance: "0x00000040",
      writePointer: "0x00000000",
      readPointer: "0x00000120",
      breakpoint: "0x00000120",
      breakpointLevel: true,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.snapshotProcessorInterfaceFifo())),
    {
      base: "0x00000200",
      end: "0x000002e0",
      current: "0x00000240",
      wrap: true,
      currentRegister: "0x20000240",
    },
  );
  assert.match(source, /commandProcessorFifo: snapshotCommandProcessorFifo\(\)/);
  assert.match(source, /processorInterfaceFifo: snapshotProcessorInterfaceFifo\(\)/);
});
