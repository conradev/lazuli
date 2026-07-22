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
  const memory = new ArrayBuffer(0x10000);
  const context = {
    cpu: 0x8000,
    cycles: 1_000,
    deviceEvents: new Map(),
    gxBpLoads: 0,
    gxBpRegisters: new Uint32Array(256),
    mmio: 0,
    msrOffset: 0,
    peFinishCycle: null,
    peFinishSignal: false,
    peFinishInterruptDelivered: false,
    peTokenValue: 0,
    peTokenSignal: false,
    peTokenInterruptDelivered: false,
    view: new DataView(memory),
    interruptDeliveries: 0,
    gxMarkTextureCopyConsumer() {
      assert.fail("unexpected texture consumer in PE test");
    },
    gxPrearmTextureCopyProducer() {
      assert.fail("unexpected texture producer in PE test");
    },
    gxLoadTlut() {
      assert.fail("unexpected TLUT load in PE test");
    },
    physicalLockedCachePointer() {
      return null;
    },
    physicalMmioPointer(address, size) {
      const physical = address >>> 0;
      if (physical < 0x0c000000 || physical + size > 0x0c010000) return null;
      return physical - 0x0c000000;
    },
    physicalRamPointer() {
      return null;
    },
    translateDataRange(address) {
      return address >= 0xc0000000
        ? (address - 0xc0000000) >>> 0
        : address >>> 0;
    },
  };
  context.gxBpRegisters[0xfe] = 0x00ffffff;
  context.raiseException = (registers, vector) => {
    assert.equal(registers, context.cpu);
    assert.equal(vector, 0x0500);
    context.interruptDeliveries += 1;
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "recordGxBpWrite",
      "writePixelEngineControl",
      "servicePixelEngine",
      "readInteger",
      "writeInteger",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.pe.js" },
  );
  return context;
}

function writeBp(context, address, value) {
  context.recordGxBpWrite(((address << 24) | (value & 0x00ffffff)) >>> 0);
}

test("BP token writes share a masked 16-bit latch and only 0x48 asserts it", () => {
  const context = makeContext();

  writeBp(context, 0x47, 0x1234);
  assert.equal(context.peTokenValue, 0x1234);
  assert.equal(context.view.getUint16(0x100e, false), 0x1234);
  assert.equal(context.peTokenSignal, false);
  assert.equal(context.deviceEvents.get("peTokenCommand"), 1);
  assert.equal(context.deviceEvents.get("peToken"), undefined);

  context.gxBpRegisters[0xfe] = 0x00ff0000;
  writeBp(context, 0x48, 0xabcd);
  assert.equal(context.peTokenValue, 0x1234);
  assert.equal(context.peTokenSignal, true);
  assert.equal(context.deviceEvents.get("peToken"), 1);
  context.writePixelEngineControl(0x0004);

  context.gxBpRegisters[0xfe] = 0x0000ff00;
  writeBp(context, 0x48, 0xab00);
  assert.equal(context.peTokenValue, 0xab34);
  assert.equal(context.view.getUint16(0x100e, false), 0xab34);
  assert.equal(context.gxBpRegisters[0xfe], 0x00ffffff);
  assert.equal(context.peTokenSignal, true);
  assert.equal(context.deviceEvents.get("peTokenInterruptCommand"), 2);
  assert.equal(context.deviceEvents.get("peToken"), 2);

  writeBp(context, 0x47, 0xcdef);
  assert.equal(context.peTokenValue, 0xcdef);
  assert.equal(context.peTokenSignal, true);
});

test("PE token status gates PI cause 0x200 and acknowledges with W1C bit 2", () => {
  const context = makeContext();
  const { view } = context;

  view.setUint32(0x3000, 0x00000020, false);
  writeBp(context, 0x48, 0x4567);
  context.servicePixelEngine(context.cycles);
  assert.equal(view.getUint32(0x3000, false), 0x00000020);
  assert.equal(context.interruptDeliveries, 0);

  assert.equal(context.writeInteger(0xcc00100a, 0x0001, 2), 1);
  context.servicePixelEngine(context.cycles);
  assert.equal(view.getUint32(0x3000, false), 0x00000220);
  assert.equal(context.interruptDeliveries, 0);

  view.setUint32(0x3004, 0x00000200, false);
  context.servicePixelEngine(context.cycles);
  assert.equal(context.interruptDeliveries, 0);

  view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);
  context.servicePixelEngine(context.cycles);
  assert.equal(view.getUint32(0x3000, false), 0x00000220);
  assert.equal(context.interruptDeliveries, 1);
  assert.equal(context.deviceEvents.get("peTokenInterrupt"), 1);

  context.servicePixelEngine(context.cycles);
  assert.equal(context.interruptDeliveries, 1);
  writeBp(context, 0x48, 0x89ab);
  context.servicePixelEngine(context.cycles);
  assert.equal(context.interruptDeliveries, 1);
  assert.equal(context.deviceEvents.get("peToken"), 1);

  assert.equal(context.writeInteger(0xcc00100a, 0x0005, 2), 1);
  assert.equal(view.getUint16(0x100a, false), 0x0001);
  assert.equal(context.peTokenSignal, false);
  assert.equal(context.peTokenInterruptDelivered, false);
  assert.equal(context.deviceEvents.get("peTokenAcknowledge"), 1);
  context.servicePixelEngine(context.cycles);
  assert.equal(view.getUint32(0x3000, false), 0x00000020);
  assert.equal(view.getUint16(0x100e, false), 0x89ab);

  const resultPointer = 0x7000;
  assert.equal(context.readInteger(0xcc00100e, resultPointer, 2), 1);
  assert.equal(view.getUint16(resultPointer, true), 0x89ab);
  assert.equal(context.readInteger(0xcc00100a, resultPointer, 2), 1);
  assert.equal(view.getUint16(resultPointer, true), 0x0001);

  writeBp(context, 0x48, 0x1357);
  context.servicePixelEngine(context.cycles);
  assert.equal(context.peTokenSignal, true);
  assert.equal(context.interruptDeliveries, 2);
  assert.equal(context.deviceEvents.get("peToken"), 2);
  assert.equal(context.deviceEvents.get("peTokenInterrupt"), 2);
});

test("PE finish keeps its 200-cycle latency and W1C bit 3 behavior", () => {
  const context = makeContext();
  const { view } = context;

  writeBp(context, 0x45, 0x000002);
  const completionCycle = context.cycles + 200;
  assert.equal(context.peFinishCycle, completionCycle);
  context.writePixelEngineControl(0x0002);
  view.setUint32(0x3004, 0x00000400, false);
  view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);

  context.servicePixelEngine(completionCycle - 1);
  assert.equal(context.peFinishSignal, false);
  assert.equal(view.getUint32(0x3000, false) & 0x00000400, 0);
  assert.equal(context.interruptDeliveries, 0);

  context.servicePixelEngine(completionCycle);
  assert.equal(context.peFinishCycle, null);
  assert.equal(context.peFinishSignal, true);
  assert.equal(view.getUint32(0x3000, false) & 0x00000400, 0x00000400);
  assert.equal(context.interruptDeliveries, 1);
  assert.equal(context.deviceEvents.get("peFinishCommand"), 1);
  assert.equal(context.deviceEvents.get("peFinishInterrupt"), 1);

  context.servicePixelEngine(completionCycle);
  assert.equal(context.interruptDeliveries, 1);
  context.writePixelEngineControl(0x000a);
  assert.equal(view.getUint16(0x100a, false), 0x0002);
  context.servicePixelEngine(completionCycle);
  assert.equal(context.peFinishSignal, false);
  assert.equal(view.getUint32(0x3000, false) & 0x00000400, 0);
  assert.equal(context.deviceEvents.get("peFinishAcknowledge"), 1);
});

test("PE control byte stores retain native subregister semantics", () => {
  const context = makeContext();
  const { view } = context;

  writeBp(context, 0x45, 0x000002);
  writeBp(context, 0x48, 0x2468);
  context.servicePixelEngine(context.cycles + 200);
  assert.equal(context.peFinishSignal, true);
  assert.equal(context.peTokenSignal, true);

  assert.equal(context.writeInteger(0xcc00100b, 0x03, 1), 1);
  assert.equal(view.getUint16(0x100a, false), 0x0003);
  const resultPointer = 0x7000;
  assert.equal(context.readInteger(0xcc00100a, resultPointer, 1), 1);
  assert.equal(view.getUint8(resultPointer), 0);
  assert.equal(context.readInteger(0xcc00100b, resultPointer, 1), 1);
  assert.equal(view.getUint8(resultPointer), 3);

  assert.equal(context.writeInteger(0xcc00100b, 0x07, 1), 1);
  assert.equal(context.peTokenSignal, false);
  assert.equal(context.peFinishSignal, true);
  writeBp(context, 0x48, 0x1357);
  assert.equal(context.writeInteger(0xcc00100b, 0x0b, 1), 1);
  assert.equal(context.peTokenSignal, true);
  assert.equal(context.peFinishSignal, false);

  assert.equal(context.writeInteger(0xcc00100a, 0xff, 1), 1);
  assert.equal(view.getUint16(0x100a, false), 0);
  assert.equal(context.peTokenSignal, true);
});

test("simultaneous token and finish sources share one PE interrupt delivery", () => {
  const context = makeContext();
  const { view } = context;

  writeBp(context, 0x45, 0x000002);
  assert.equal(context.peFinishCycle, context.cycles + 200);
  assert.equal(context.peFinishSignal, false);
  writeBp(context, 0x48, 0x2468);
  context.writePixelEngineControl(0x0003);
  view.setUint32(0x3004, 0x00000600, false);
  view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);

  context.servicePixelEngine(context.peFinishCycle);
  assert.equal(context.peFinishCycle, null);
  assert.equal(context.peFinishSignal, true);
  assert.equal(view.getUint32(0x3000, false) & 0x00000600, 0x00000600);
  assert.equal(context.interruptDeliveries, 1);
  assert.equal(context.deviceEvents.get("peTokenInterrupt"), 1);
  assert.equal(context.deviceEvents.get("peFinishInterrupt"), 1);
  assert.equal(context.deviceEvents.get("peFinish"), 1);

  context.writePixelEngineControl(0x0007);
  context.servicePixelEngine(context.cycles + 200);
  assert.equal(context.peTokenSignal, false);
  assert.equal(context.peFinishSignal, true);
  assert.equal(view.getUint32(0x3000, false) & 0x00000600, 0x00000400);

  writeBp(context, 0x48, 0x1357);
  context.servicePixelEngine(context.cycles + 200);
  assert.equal(context.peTokenSignal, true);
  assert.equal(context.peFinishSignal, true);
  assert.equal(view.getUint32(0x3000, false) & 0x00000600, 0x00000600);
  assert.equal(context.interruptDeliveries, 2);

  context.writePixelEngineControl(0x000b);
  context.servicePixelEngine(context.cycles + 200);
  assert.equal(context.peTokenSignal, true);
  assert.equal(context.peFinishSignal, false);
  assert.equal(view.getUint32(0x3000, false) & 0x00000600, 0x00000200);

  context.writePixelEngineControl(0x0007);
  context.servicePixelEngine(context.cycles + 200);
  assert.equal(context.peTokenSignal, false);
  assert.equal(view.getUint32(0x3000, false) & 0x00000600, 0);
  assert.equal(context.deviceEvents.get("peFinishAcknowledge"), 1);
});

test("PE token state is exposed in browser diagnostics without changing finish fields", () => {
  assert.match(source, /\[0x100a, 0x100e\]\.map/);
  assert.match(source, /\n\s+peFinishCycle,\n\s+peFinishSignal,/);
  assert.match(source, /\n\s+peTokenValue,\n\s+peTokenSignal,\n\s+peTokenInterruptDelivered,/);
});
