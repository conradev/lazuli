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

function controllerState(buttons = 0) {
  return {
    buttons,
    stickX: 0x80,
    stickY: 0x80,
    cStickX: 0x80,
    cStickY: 0x80,
    triggerL: 0,
    triggerR: 0,
    analogA: (buttons & 0x0100) !== 0 ? 0xff : 0,
    analogB: (buttons & 0x0200) !== 0 ? 0xff : 0,
  };
}

function makeContext(functionNames, overrides = {}) {
  const memory = new ArrayBuffer(0x10000);
  const bytes = new Uint8Array(memory);
  const view = new DataView(memory);
  const context = {
    Array,
    BigInt,
    Math,
    Number,
    Object,
    String,
    bytes,
    view,
    mmio: 0,
    cpu: 0xf000,
    msrOffset: 0,
    cycles: 0,
    controllerQueue: [],
    controllerState: controllerState(),
    controllerAppliedSequence: 0,
    serialLastPolledButtons: 0,
    serialLastPolledSequence: 0,
    serialLastPollSignature: null,
    serialLastRespondedChannels: 0,
    serialLastPublishedChannels: 0,
    serialLastUpdatedChannels: 0,
    serialLastEnabledChannels: 0,
    serialControllerModes: [3, 3, 3, 3],
    serialControllerRumble: [false, false, false, false],
    serialOutputCommandsByChannel: [0, 0, 0, 0],
    serialUnknownOutputCommands: 0,
    serialNoResponseByChannel: [0, 0, 0, 0],
    serialPeriodicNoResponseByChannel: [0, 0, 0, 0],
    serialNoResponseAcknowledgedByChannel: [0, 0, 0, 0],
    serialTransferInterruptAcknowledgements: 0,
    serialLastTransfer: null,
    serialTransfer: null,
    serialPollCatchUpBatches: 0,
    serialPollCatchUpPolls: 0,
    serialPollMaxBatch: 0,
    serialPollMaxLateness: 0,
    serialPollTrace: [],
    serialInterruptLevelActive: false,
    serialInterruptLevelChanges: 0,
    serialInterruptLevelReason: null,
    nextSerialPollCycle: null,
    viTiming: null,
    viEpochCycle: 0,
    viEpochHalfLine: 0,
    viSiPollHalfLines: 15,
    deviceEvents: new Map(),
    padUseOrigin: 0x0080,
    piSerialInterruptCause: 0x00000008,
    siTransferStart: 0x00000001,
    siReadStatusInterruptMask: 0x08000000,
    siReadStatusInterrupt: 0x10000000,
    siCommunicationError: 0x20000000,
    siTransferInterruptMask: 0x40000000,
    siTransferInterrupt: 0x80000000,
    siStatusInputReadyMask: 0x20202020,
    siStatusErrorWriteOneToClear: 0x0f0f0f0f,
    siStatusWriteStatusMask: 0x10101010,
    siStatusWrite: 0x80000000,
    serialTransferOutcome: Object.freeze({
      success: 0,
      noResponse: 1,
      protocolError: 2,
    }),
    serialTransferOutcomeNames: Object.freeze([
      "success",
      "no-response",
      "protocol-error",
    ]),
    check(condition, message) {
      assert.ok(condition, message);
    },
    raiseException() {
      assert.fail("unexpected SI exception delivery in register test");
    },
    pollSerialController() {},
    ...overrides,
  };
  vm.createContext(context);
  const declarations = functionNames.map(extractFunction).join("\n\n");
  vm.runInContext(declarations, context, { filename: "browser_boot.si.js" });
  return context;
}

const packetFunctions = ["controllerPacketForPoll"];
const levelFunctions = [
  "recomputeSerialInterruptLevel",
  "serialNoResponseBit",
  "processSerialOutputCommand",
  "writeSerialStatus",
  "writeSerialControl",
];
const periodicFunctions = [
  ...packetFunctions,
  "recomputeSerialInterruptLevel",
  "serialNoResponseBit",
  "performSerialPoll",
];

test("controller packets use PAD_USE_ORIGIN and exact mode packing", () => {
  const context = makeContext(packetFunctions);
  context.controllerState = {
    buttons: 0,
    stickX: 0x80,
    stickY: 0x80,
    cStickX: 0xab,
    cStickY: 0xcd,
    triggerL: 0xef,
    triggerR: 0x12,
    analogA: 0x34,
    analogB: 0x56,
  };
  const expectedLow = new Map([
    [0, [0xab, 0xcd, 0xe1, 0x35]],
    [1, [0xac, 0xef, 0x12, 0x35]],
    [2, [0xac, 0xe1, 0x34, 0x56]],
    [3, [0xab, 0xcd, 0xef, 0x12]],
    [4, [0xab, 0xcd, 0x34, 0x56]],
    [5, [0xab, 0xcd, 0xe1, 0x35]],
    [6, [0xab, 0xcd, 0xe1, 0x35]],
    [7, [0xab, 0xcd, 0xe1, 0x35]],
  ]);
  for (const [mode, low] of expectedLow) {
    context.serialControllerModes[0] = mode;
    assert.deepEqual(
      Array.from(context.controllerPacketForPoll(0)),
      [0x00, 0x80, 0x80, 0x80, ...low],
      `mode ${mode}`,
    );
  }
});

test("RDSTINT is derived, W1C-reasserted, and PI-mask-correct", () => {
  const context = makeContext(levelFunctions);
  const { view } = context;
  view.setUint32(0x3000, 0x00010000, false);
  view.setUint32(0x6438, 0x20200000, false);
  view.setUint32(0x6434, context.siReadStatusInterruptMask, false);
  assert.equal(context.recomputeSerialInterruptLevel("seed"), true);
  assert.equal(view.getUint32(0x6434, false) & 0x10000000, 0x10000000);
  assert.equal(view.getUint32(0x3000, false) & 8, 8);

  context.writeSerialControl(
    context.siReadStatusInterruptMask | context.siReadStatusInterrupt,
  );
  assert.equal(view.getUint32(0x6434, false) & 0x10000000, 0x10000000);
  assert.equal(view.getUint32(0x3000, false) & 8, 8);

  view.setUint32(0x6438, 0x00200000, false);
  context.recomputeSerialInterruptLevel("one-remains");
  assert.equal(view.getUint32(0x6434, false) & 0x10000000, 0x10000000);
  view.setUint32(0x6438, 0, false);
  context.recomputeSerialInterruptLevel("last-cleared");
  assert.equal(view.getUint32(0x6434, false) & 0x10000000, 0);
  assert.equal(view.getUint32(0x3000, false) & 8, 0);
  assert.equal(view.getUint32(0x3000, false) & 0x00010000, 0x00010000);
});

test("COMERR is read-only and TCINT is write-one-to-clear", () => {
  const context = makeContext(levelFunctions);
  const { view } = context;
  view.setUint32(
    0x6434,
    context.siCommunicationError
      | context.siTransferInterruptMask
      | context.siTransferInterrupt,
    false,
  );
  context.writeSerialControl(
    context.siTransferInterruptMask | context.siTransferInterrupt,
  );
  const control = view.getUint32(0x6434, false);
  assert.equal(control & context.siCommunicationError, context.siCommunicationError);
  assert.equal(control & context.siTransferInterrupt, 0);
  assert.equal(control & context.siTransferInterruptMask, context.siTransferInterruptMask);
  assert.equal(context.serialTransferInterruptAcknowledgements, 1);
});

test("SISR selectively clears errors and dispatches WR to all OUT ports", () => {
  const context = makeContext(levelFunctions);
  const { view } = context;
  const noResponse0 = 0x08000000;
  const noResponse1 = 0x00080000;
  view.setUint32(
    0x6438,
    0x20000000 | 0x10101010 | noResponse0 | noResponse1,
    false,
  );
  view.setUint32(0x6430, 0, false);
  view.setUint32(0x6400, 0x00400201, false);
  context.writeSerialStatus(context.siStatusWrite | noResponse1);

  const status = view.getUint32(0x6438, false);
  assert.equal(status & 0x20000000, 0x20000000);
  assert.equal(status & noResponse0, noResponse0);
  assert.equal(status & noResponse1, 0);
  assert.equal(status & 0x10101010, 0);
  assert.deepEqual(Array.from(context.serialOutputCommandsByChannel), [1, 1, 1, 1]);
  assert.equal(context.serialControllerModes[0], 2);
  assert.equal(context.serialControllerRumble[0], true);
});

test("periodic polling ignores EN and backpressures an unread RDST mailbox", () => {
  const context = makeContext(periodicFunctions);
  const { bytes, view } = context;
  context.controllerQueue.push(
    { sequence: 1, state: controllerState(0x0100) },
    { sequence: 2, state: controllerState(0) },
  );
  view.setUint32(0x6430, 0, false);
  view.setUint32(0x6404, 0x40000000, false);

  context.performSerialPoll(100, 100);
  const firstPacket = Array.from(bytes.slice(0x6404, 0x640c));
  assert.equal(context.controllerQueue.length, 1);
  assert.equal(context.controllerAppliedSequence, 1);
  assert.equal(view.getUint32(0x6438, false), 0x20080808);
  assert.equal(view.getUint32(0x6404, false) & 0xc0000000, 0x40000000);
  assert.equal(context.serialLastEnabledChannels, 0);
  assert.equal(context.serialLastRespondedChannels, 1);
  assert.equal(context.serialLastPublishedChannels, 1);
  assert.equal(context.serialLastUpdatedChannels, 4);
  for (const offset of [0x6410, 0x641c, 0x6428]) {
    assert.equal(
      (view.getUint32(offset, false) & 0xc0000000) >>> 0,
      0xc0000000,
    );
  }

  context.performSerialPoll(200, 200);
  assert.equal(context.controllerQueue.length, 1);
  assert.deepEqual(Array.from(bytes.slice(0x6404, 0x640c)), firstPacket);
  assert.equal(context.deviceEvents.get("serialPollBackpressured"), 1);

  view.setUint32(0x6438, view.getUint32(0x6438, false) & ~0x20000000, false);
  context.performSerialPoll(300, 300);
  assert.equal(context.controllerQueue.length, 0);
  assert.equal(context.controllerAppliedSequence, 2);
  assert.equal(context.serialLastPublishedChannels, 1);
});

test("absent direct transfers mutate only COMCSR and the exact NOREP bit", () => {
  const context = makeContext([
    ...packetFunctions,
    "recomputeSerialInterruptLevel",
    "serialNoResponseBit",
    "processSerialCommand",
    "serviceSerial",
  ]);
  const { bytes, view } = context;
  bytes.fill(0xa5, 0x6480, 0x6500);
  for (const offset of [0x6404, 0x6408, 0x6410, 0x6414, 0x641c, 0x6420]) {
    view.setUint32(offset, 0x11223344 ^ offset, false);
  }
  const bufferBefore = Array.from(bytes.slice(0x6480, 0x6500));
  const inputBefore = Array.from(bytes.slice(0x6404, 0x6424));
  context.controllerQueue.push({ sequence: 1, state: controllerState(0x0100) });
  context.serialTransfer = { channel: 2, completionCycle: 100 };
  view.setUint32(0x6434, context.siTransferStart, false);

  context.serviceSerial(100);
  assert.deepEqual(Array.from(bytes.slice(0x6480, 0x6500)), bufferBefore);
  assert.deepEqual(Array.from(bytes.slice(0x6404, 0x6424)), inputBefore);
  assert.equal(context.controllerQueue.length, 1);
  const control = view.getUint32(0x6434, false);
  assert.equal(control & context.siTransferStart, 0);
  assert.equal(control & context.siCommunicationError, context.siCommunicationError);
  assert.equal(
    (control & context.siTransferInterrupt) >>> 0,
    context.siTransferInterrupt,
  );
  assert.equal(view.getUint32(0x6438, false), 0x00000800);
});

test("SI cadence is stateful across X changes and field boundaries", () => {
  const context = makeContext([
    "viCurrentHalfLine",
    "viCycleForHalfLineAfter",
    "nextStatefulSerialPollCycle",
  ]);
  const { view } = context;
  context.viTiming = {
    displayEnabled: true,
    cyclesPerHalfLine: 1,
    oddHalfLines: 525,
    totalHalfLines: 1050,
  };
  view.setUint32(0x6430, 246 << 16, false);
  const sequence = [16];
  for (let index = 0; index < 4; index += 1) {
    sequence.push(context.nextStatefulSerialPollCycle(sequence.at(-1)));
  }
  assert.deepEqual(sequence, [16, 508, 541, 1033, 1066]);
  assert.deepEqual(sequence.slice(0, 4).map(value => value % 1050), [16, 508, 541, 1033]);

  view.setUint32(0x6430, 100 << 16, false);
  assert.equal(context.nextStatefulSerialPollCycle(16), 216);
  assert.equal(context.nextStatefulSerialPollCycle(508), 541);
  assert.equal(context.nextStatefulSerialPollCycle(541), 741);
  view.setUint32(0x6430, 0, false);
  assert.equal(context.nextStatefulSerialPollCycle(16), 541);
  view.setUint32(0x6430, 255 << 16, false);
  assert.equal(context.nextStatefulSerialPollCycle(16), 526);
  assert.equal(context.nextStatefulSerialPollCycle(526), 541);
  assert.equal(context.nextStatefulSerialPollCycle(541), 1066);
});
