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
    controllerPollIndex: 0,
    controllerSequence: 0,
    controllerScenario: null,
    controllerQueue: [],
    controllerQueueCapacity: 64,
    controllerQueueHighWater: 0,
    controllerQueueCoalesces: 0,
    controllerQueueOverflows: 0,
    controllerState: controllerState(),
    controllerAppliedSequence: 0,
    runnerStopRequested: false,
    runnerPaused: false,
    runnerSnapshotRequested: false,
    statusDataset: {},
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
    pollControllerScenario() { return null; },
    ...overrides,
  };
  vm.createContext(context);
  const declarations = functionNames.map(extractFunction).join("\n\n");
  vm.runInContext(declarations, context, { filename: "browser_boot.si.js" });
  return context;
}

const packetFunctions = [
  "controllerPacketForPoll",
  "postControllerPollAcknowledgement",
];
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
const scenarioPollFunctions = [
  "recordControllerScenarioPoll",
  "pollControllerScenario",
  ...periodicFunctions,
  "processSerialCommand",
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

test("queued click edges survive until separate guest polls consume them", () => {
  const context = makeContext(["enqueueControllerState", ...packetFunctions]);
  context.enqueueControllerState({ sequence: 1, state: controllerState() });
  context.enqueueControllerState({ sequence: 2, state: controllerState(0x0200) });
  context.enqueueControllerState({ sequence: 3, state: controllerState() });

  assert.equal(context.controllerQueueCoalesces, 1);
  assert.equal(context.controllerQueueHighWater, 2);
  assert.deepEqual(
    Array.from(context.controllerQueue, queued => queued.state.buttons),
    [0x0200, 0],
  );

  const pressed = context.controllerPacketForPoll();
  assert.equal(((pressed[0] << 8) | pressed[1]) & ~context.padUseOrigin, 0x0200);
  assert.equal(context.controllerAppliedSequence, 2);
  assert.equal(context.controllerQueue.length, 1);

  const released = context.controllerPacketForPoll();
  assert.equal(((released[0] << 8) | released[1]) & ~context.padUseOrigin, 0);
  assert.equal(context.controllerAppliedSequence, 3);
  assert.equal(context.controllerQueue.length, 0);

  const stable = context.controllerPacketForPoll();
  assert.equal(((stable[0] << 8) | stable[1]) & ~context.padUseOrigin, 0);
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
  const pollMessages = [];
  const context = makeContext(periodicFunctions, {
    postMessage(message) { pollMessages.push(message); },
  });
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
  assert.deepEqual(JSON.parse(JSON.stringify(pollMessages)), [{
    type: "controller-poll",
    buttons: 0x0100,
    sequence: 1,
  }]);
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
  assert.equal(pollMessages.length, 1);

  view.setUint32(0x6438, view.getUint32(0x6438, false) & ~0x20000000, false);
  context.performSerialPoll(300, 300);
  assert.equal(context.controllerQueue.length, 0);
  assert.equal(context.controllerAppliedSequence, 2);
  assert.equal(context.serialLastPublishedChannels, 1);
  assert.equal(pollMessages.length, 1);
});

test("scenario SI publications retain source cycles and exclude backpressure", () => {
  const context = makeContext(scenarioPollFunctions, {
    postMessage() {},
  });
  const press = {
    sequence: 1,
    polls: 0,
    publications: [],
    firstPollIndex: null,
    lastPollIndex: null,
    firstScheduledCycle: null,
    lastScheduledCycle: null,
    firstObservedCycle: null,
    lastObservedCycle: null,
  };
  context.controllerScenario = {
    status: "running",
    pollIndex: 0,
    nextSequence: 3,
    pressPolls: 3,
    pulse: {
      button: 0x0100,
      state: "press",
      pressPolls: 0,
      neutralPolls: 0,
      releaseServiceCycle: null,
    },
    steps: [{
      press,
      release: {
        sequence: 2,
        polls: 0,
        publications: [],
      },
    }],
  };

  context.performSerialPoll(100, 125);
  assert.equal(context.controllerPollIndex, 1);
  assert.equal(press.polls, 1);

  context.performSerialPoll(200, 225);
  assert.equal(context.controllerPollIndex, 1);
  assert.equal(press.polls, 1);

  context.view.setUint8(0x6480, 0x40);
  assert.equal(
    context.processSerialCommand(0, 300, 325),
    context.serialTransferOutcome.success,
  );
  assert.equal(context.controllerPollIndex, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(press.publications)), [
    {
      source: "periodic",
      pollIndex: 1,
      scheduledCycle: 100,
      observedCycle: 125,
      buttons: 0x0100,
      sequence: 1,
    },
    {
      source: "direct",
      pollIndex: 2,
      scheduledCycle: 300,
      observedCycle: 325,
      buttons: 0x0100,
      sequence: 1,
    },
  ]);
});

test("direct 0x40 reads acknowledge the controller state they publish", () => {
  const pollMessages = [];
  const context = makeContext([
    ...packetFunctions,
    "processSerialCommand",
  ], {
    postMessage(message) { pollMessages.push(message); },
  });
  context.controllerQueue.push({ sequence: 7, state: controllerState(0x0100) });
  context.view.setUint8(0x6480, 0x40);

  assert.equal(
    context.processSerialCommand(0),
    context.serialTransferOutcome.success,
  );
  assert.equal(context.controllerAppliedSequence, 7);
  assert.deepEqual(Array.from(context.bytes.slice(0x6480, 0x6488)), [
    0x01, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(pollMessages)), [{
    type: "controller-poll",
    buttons: 0x0100,
    sequence: 7,
  }]);
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

test("Super Monkey Ball snapshots expose PADRead edge state", () => {
  const memory = new ArrayBuffer(0x200000);
  const view = new DataView(memory);
  const context = {
    boot: { identifier: "GMBE8P" },
    ram: 0,
    ramSize: memory.byteLength,
    view,
  };
  vm.createContext(context);
  vm.runInContext([
    "physicalOffset",
    "ramPointer",
    "hex32",
    "inspectPadStatus",
    "inspectSuperMonkeyBallPad0",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.pad-diagnostics.js",
  });

  const base = 0x1f3b70;
  const buttons = [0x0100, 0x0000, 0x0100, 0x0000, 0x0008];
  for (const [index, value] of buttons.entries()) {
    const pointer = base + index * 0x0c;
    view.setUint16(pointer, value, false);
    view.setInt8(pointer + 2, -64 + index);
    view.setInt8(pointer + 3, 63 - index);
    view.setUint8(pointer + 8, value === 0x0100 ? 0xff : 0);
    view.setInt8(pointer + 10, index === 2 ? -1 : 0);
  }

  const snapshot = JSON.parse(JSON.stringify(context.inspectSuperMonkeyBallPad0()));
  assert.equal(snapshot.controllerInfo, "0x801f3b70");
  assert.deepEqual(
    Object.fromEntries(
      ["held", "previous", "pressed", "released", "repeat"]
        .map(name => [name, snapshot[name].buttons]),
    ),
    {
      held: 0x0100,
      previous: 0x0000,
      pressed: 0x0100,
      released: 0x0000,
      repeat: 0x0008,
    },
  );
  assert.deepEqual(
    {
      address: snapshot.pressed.address,
      stickX: snapshot.pressed.stickX,
      stickY: snapshot.pressed.stickY,
      analogA: snapshot.pressed.analogA,
      error: snapshot.pressed.error,
    },
    {
      address: "0x801f3b88",
      stickX: -62,
      stickY: 61,
      analogA: 0xff,
      error: -1,
    },
  );

  context.boot.identifier = "GZWE01";
  assert.equal(context.inspectSuperMonkeyBallPad0(), null);
});

test("Super Monkey Ball snapshots expose the exact READY-to-play gate", () => {
  const memory = new ArrayBuffer(0x400000);
  const view = new DataView(memory);
  const context = {
    boot: { identifier: "GMBE8P" },
    ram: 0,
    ramSize: memory.byteLength,
    view,
  };
  vm.createContext(context);
  vm.runInContext([
    "physicalOffset",
    "ramPointer",
    "guestU32",
    "guestS32",
    "guestS16",
    "hex32",
    "inspectSuperMonkeyBallGameState",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.smb-game-state-diagnostics.js",
  });

  view.setInt32(0x1eec20, 119, false);
  view.setInt16(0x2f1b8c, -1, false);
  view.setInt16(0x2f1b8e, 0x31, false);
  view.setUint32(0x2f1ee0, 0x00000008, false);

  const paused = JSON.parse(JSON.stringify(context.inspectSuperMonkeyBallGameState()));
  assert.deepEqual(paused, {
    modeControl: "0x801eec20",
    gamePauseStatusAddress: "0x802f1ee0",
    gameSubmodeRequestAddress: "0x802f1b8c",
    gameSubmodeAddress: "0x802f1b8e",
    pauseStatus: "0x00000008",
    readyPauseGateActive: true,
    submodeTimer: 119,
    submodeRequest: -1,
    submode: 0x31,
    readyMain: true,
    playRequested: false,
  });

  view.setUint32(0x2f1ee0, 0, false);
  view.setInt16(0x2f1b8c, 0x32, false);
  assert.equal(context.inspectSuperMonkeyBallGameState().readyPauseGateActive, false);
  assert.equal(context.inspectSuperMonkeyBallGameState().playRequested, true);

  context.boot.identifier = "GZWE01";
  assert.equal(context.inspectSuperMonkeyBallGameState(), null);
});
