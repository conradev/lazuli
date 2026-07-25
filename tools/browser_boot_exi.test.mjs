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

const exiFunctions = [
  "hex32",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "exiTransferModeName",
  "exiIplImageStatus",
  "recordExi0Transfer",
  "serviceExi0",
  "serviceExternalInterface",
  "snapshotExternalInterface",
];

function syntheticIpl() {
  return new Uint8Array(2 * 1024 * 1024);
}

function makeContext(exiIplImage = syntheticIpl()) {
  const memory = new ArrayBuffer(0x24000);
  const context = {
    Array,
    ArrayBuffer,
    Math,
    Number,
    Object,
    String,
    Uint8Array,
    bytes: new Uint8Array(memory),
    view: new DataView(memory),
    ram: 0x1000,
    ramSize: 0x10000,
    mmio: 0x12000,
    mmioSize: 0x10000,
    physicalMmioBase: 0x0c000000,
    deviceEvents: new Map(),
    exiIplImageBytes: 2 * 1024 * 1024,
    exiIplImage,
    exiIplSource: { kind: "synthetic-test" },
    exiTransferTraceLimit: 64,
    exiTransferTrace: [],
    exiTransferOutcomes: new Map(),
    exiTransferSequence: 0,
    exiTransferTraceDropped: 0,
    exi0IplCommandAddress: null,
    exi0IplCursor: 0,
    exi0IplAddressSequence: null,
    exi0IplDmaBytes: 0,
    reservationInvalidations: [],
    invalidateDataReservationForExternalWrite(address, length) {
      context.reservationInvalidations.push({ address, length });
    },
  };
  vm.createContext(context);
  vm.runInContext(
    exiFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.exi.js" },
  );
  return context;
}

function selectIplDevice(context) {
  context.view.setUint32(context.mmio + 0x6800, 2 << 7, false);
}

function writeIplAddress(context, sourceOffset, cycle = 1) {
  selectIplDevice(context);
  context.view.setUint32(
    context.mmio + 0x6810,
    (sourceOffset * 64) >>> 0,
    false,
  );
  // TSTART, immediate transfer, write mode, four-byte immediate.
  context.view.setUint32(context.mmio + 0x680c, 0x35, false);
  assert.equal(context.serviceExi0(cycle), true);
}

function readIplDma(context, dmaBase, dmaLength, cycle = 2, mode = 0) {
  selectIplDevice(context);
  context.view.setUint32(context.mmio + 0x6804, dmaBase, false);
  context.view.setUint32(context.mmio + 0x6808, dmaLength, false);
  // TSTART, DMA, caller-selected transfer mode.
  context.view.setUint32(
    context.mmio + 0x680c,
    1 | 2 | (mode << 2),
    false,
  );
  assert.equal(context.serviceExi0(cycle), true);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("EXI0 IPL address command orders and completes a bounded DMA read", () => {
  const image = syntheticIpl();
  // Exercise the Windows-1252 font window near the top of the 2 MiB IPL.
  // This proves command address bits 6..30 are retained instead of truncating
  // the protocol to the low 512 KiB.
  const sourceOffset = 0x1fcf00;
  const payload = Uint8Array.from(
    { length: 64 },
    (_unused, index) => (index * 17 + 3) & 0xff,
  );
  image.set(payload, sourceOffset);
  const context = makeContext(image);

  writeIplAddress(context, sourceOffset, 100);
  assert.equal(context.exi0IplCommandAddress, sourceOffset);
  assert.equal(context.exi0IplCursor, sourceOffset);
  assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);

  const dmaBase = 0x2400;
  readIplDma(context, dmaBase, payload.length, 120);

  assert.deepEqual(
    Array.from(
      context.bytes.subarray(
        context.ram + dmaBase,
        context.ram + dmaBase + payload.length,
      ),
    ),
    Array.from(payload),
  );
  assert.deepEqual(
    context.reservationInvalidations,
    [{ address: dmaBase, length: payload.length }],
  );
  assert.equal(context.exi0IplDmaBytes, payload.length);
  assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);

  const [address, dma] = context.exiTransferTrace;
  assert.equal(address.sequence, 1);
  assert.equal(address.operation, "ipl-address");
  assert.equal(address.outcome, "accepted");
  assert.equal(address.immediate, "0x07f3c000");
  assert.equal(address.commandDirection, "read");
  assert.equal(address.commandAddress, "0x001fcf00");
  assert.equal(address.iplCommandAddressAfter, "0x001fcf00");
  assert.equal(address.iplCursorAfter, "0x001fcf00");
  assert.equal(dma.sequence, 2);
  assert.equal(dma.operation, "ipl-dma-read");
  assert.equal(dma.outcome, "complete");
  assert.equal(dma.addressSequence, address.sequence);
  assert.equal(dma.iplCommandAddressBefore, "0x001fcf00");
  assert.equal(dma.iplCursorBefore, "0x001fcf00");
  assert.equal(dma.iplCursorAfter, "0x001fcf40");
  assert.equal(dma.dmaBase, "0x00002400");
  assert.equal(dma.dmaLength, payload.length);

  const snapshot = plain(context.snapshotExternalInterface());
  assert.deepEqual(snapshot.ipl, {
    configured: true,
    valid: true,
    byteLength: 2 * 1024 * 1024,
    expectedBytes: 2 * 1024 * 1024,
    source: { kind: "synthetic-test" },
    commandAddress: "0x001fcf00",
    cursor: "0x001fcf40",
    addressSequence: 1,
    dmaBytes: payload.length,
  });
  assert.deepEqual(snapshot.transfers.outcomes, {
    accepted: 1,
    complete: 1,
  });
});

test("EXI0 IPL cursor advances across consecutive DMA reads", () => {
  const image = syntheticIpl();
  const sourceOffset = 0x1aff00;
  image.set(
    Uint8Array.from(
      { length: 64 },
      (_unused, index) => (index + 0x40) & 0xff,
    ),
    sourceOffset,
  );
  const context = makeContext(image);

  writeIplAddress(context, sourceOffset, 10);
  readIplDma(context, 0x2000, 32, 20);
  readIplDma(context, 0x2040, 32, 30);

  assert.deepEqual(
    Array.from(
      context.bytes.subarray(context.ram + 0x2000, context.ram + 0x2020),
    ),
    Array.from(image.subarray(sourceOffset, sourceOffset + 32)),
  );
  assert.deepEqual(
    Array.from(
      context.bytes.subarray(context.ram + 0x2040, context.ram + 0x2060),
    ),
    Array.from(image.subarray(sourceOffset + 32, sourceOffset + 64)),
  );
  const firstDma = context.exiTransferTrace[1];
  const secondDma = context.exiTransferTrace[2];
  assert.equal(firstDma.addressSequence, 1);
  assert.equal(secondDma.addressSequence, 1);
  assert.equal(firstDma.iplCursorBefore, "0x001aff00");
  assert.equal(firstDma.iplCursorAfter, "0x001aff20");
  assert.equal(secondDma.iplCursorBefore, "0x001aff20");
  assert.equal(secondDma.iplCursorAfter, "0x001aff40");
  assert.equal(context.exi0IplCommandAddress, sourceOffset);
  assert.equal(context.exi0IplCursor, sourceOffset + 64);
  assert.equal(context.exi0IplDmaBytes, 64);
});

test("EXI0 IPL DMA reports an absent local image without mutating RAM", () => {
  const context = makeContext(null);
  writeIplAddress(context, 0x1aff00);
  const dmaBase = 0x3000;
  context.bytes.fill(0xa5, context.ram + dmaBase, context.ram + dmaBase + 32);

  readIplDma(context, dmaBase, 32);

  assert.deepEqual(
    Array.from(
      context.bytes.subarray(
        context.ram + dmaBase,
        context.ram + dmaBase + 32,
      ),
    ),
    Array(32).fill(0xa5),
  );
  assert.equal(context.exiTransferTrace.at(-1).outcome, "unavailable");
  assert.equal(
    context.exiTransferTrace.at(-1).reason,
    "ipl-image-not-configured",
  );
  assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);
});

test("EXI0 IPL DMA rejects wrong modes and source or RAM range overflow", () => {
  const sourceOverflow = makeContext();
  writeIplAddress(sourceOverflow, sourceOverflow.exiIplImageBytes - 16);
  readIplDma(sourceOverflow, 0x2000, 32);
  assert.equal(
    sourceOverflow.exiTransferTrace.at(-1).reason,
    "ipl-source-out-of-bounds",
  );

  const targetOverflow = makeContext();
  writeIplAddress(targetOverflow, 0x3000);
  readIplDma(targetOverflow, targetOverflow.ramSize - 16, 32);
  assert.equal(
    targetOverflow.exiTransferTrace.at(-1).reason,
    "ram-target-out-of-bounds",
  );

  const wrongMode = makeContext();
  writeIplAddress(wrongMode, 0x3000);
  readIplDma(wrongMode, 0x2000, 32, 2, 1);
  assert.equal(
    wrongMode.exiTransferTrace.at(-1).reason,
    "ipl-dma-requires-read",
  );

  const wrongImageSize = makeContext(new Uint8Array(128));
  writeIplAddress(wrongImageSize, 0);
  readIplDma(wrongImageSize, 0x2000, 32);
  assert.equal(
    wrongImageSize.exiTransferTrace.at(-1).reason,
    "invalid-ipl-image",
  );

  const missingAddressCommand = makeContext();
  readIplDma(missingAddressCommand, 0x2000, 32);
  assert.equal(
    missingAddressCommand.exiTransferTrace.at(-1).reason,
    "ipl-dma-without-address-command",
  );

  const staleAddressAfterRtc = makeContext();
  writeIplAddress(staleAddressAfterRtc, 0x3000);
  staleAddressAfterRtc.view.setUint32(
    staleAddressAfterRtc.mmio + 0x6810,
    0x20000000,
    false,
  );
  staleAddressAfterRtc.view.setUint32(
    staleAddressAfterRtc.mmio + 0x680c,
    0x35,
    false,
  );
  staleAddressAfterRtc.serviceExi0(2);
  assert.equal(staleAddressAfterRtc.exi0IplAddressSequence, null);
  readIplDma(staleAddressAfterRtc, 0x2000, 32, 3);
  assert.equal(
    staleAddressAfterRtc.exiTransferTrace.at(-1).reason,
    "ipl-dma-without-address-command",
  );

  for (const context of [
    sourceOverflow,
    targetOverflow,
    wrongMode,
    wrongImageSize,
    missingAddressCommand,
    staleAddressAfterRtc,
  ]) {
    assert.equal(context.exiTransferTrace.at(-1).outcome, "rejected");
    assert.equal(context.reservationInvalidations.length, 0);
    assert.equal(context.exi0IplDmaBytes, 0);
    assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);
  }
});

test("EXI0 transfer diagnostics retain only the newest bounded window", () => {
  const context = makeContext();
  for (let index = 0; index < 70; index += 1) {
    writeIplAddress(context, index, index);
  }

  assert.equal(context.exiTransferSequence, 70);
  assert.equal(context.exiTransferTrace.length, 64);
  assert.equal(context.exiTransferTraceDropped, 6);
  assert.equal(context.exiTransferTrace[0].sequence, 7);
  assert.equal(context.exiTransferTrace.at(-1).sequence, 70);
  assert.equal(context.exiTransferOutcomes.get("accepted"), 70);
  assert.equal(context.deviceEvents.get("exiChannel0"), 70);
});

test("EXI1 and EXI2 retain the previous bounded no-device completion", () => {
  const context = makeContext();
  context.view.setUint32(context.mmio + 0x6820, 0x80000001, false);
  context.view.setUint32(context.mmio + 0x6834, 0x40000001, false);

  context.serviceExternalInterface(10);

  assert.equal(
    context.view.getUint32(context.mmio + 0x6820, false),
    0x80000000,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6834, false),
    0x40000000,
  );
  assert.equal(context.deviceEvents.get("exiChannel1"), 1);
  assert.equal(context.deviceEvents.get("exiChannel2"), 1);
  assert.equal(context.exiTransferSequence, 0);
});
