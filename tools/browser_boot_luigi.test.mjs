#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function makeContext(identifier = "GLME01", version = 0) {
  const memory = new ArrayBuffer(0x1800000);
  const view = new DataView(memory);
  const context = {
    Math,
    Number,
    boot: { identifier, discId: 0, version },
    controllerAppliedSequence: 0,
    luigisMansionGxPostTexMtx18Load: null,
    luigisMansionLastActiveGameplayInput: null,
    serialLastActiveHostPublication: null,
    view,
    ramPointer(address, length) {
      const physical = address & 0x1fffffff;
      return physical <= memory.byteLength - length ? physical : null;
    },
    inspectSuperMonkeyBallGameState() {
      return identifier === "GMBE8P" ? { game: "smb" } : null;
    },
    inspectWindWakerGameState() {
      return identifier === "GZLE01" ? { game: "wind" } : null;
    },
    inspectMeleeGameState() {
      return identifier === "GALE01" && version === 2
        ? { game: "melee" }
        : null;
    },
    inspectFzeroGameState() {
      return identifier === "GFZE01" && version === 0
        ? { game: "fzero" }
        : null;
    },
    inspectWarioWareGameState() {
      return identifier === "GZWE01" ? { game: "wario" } : null;
    },
    sampleWindWakerGameplayInput() {},
    sampleMeleeGameplayInput() {},
    sampleFzeroGameplayInput() {},
    sampleWarioWareGameplayInput() {},
  };
  vm.createContext(context);
  vm.runInContext([
    "guestU32",
    "guestU8",
    "guestU16",
    "guestF32",
    "guestS16",
    "hex32",
    "snapshotLuigisMansionGxPostTexMtx18Load",
    "luigisMansionMappedPointer",
    "inspectLuigisMansionPosition",
    "inspectLuigisMansionGameState",
    "sampleLuigisMansionGameplayInput",
    "inspectGuestGameState",
    "sampleGuestGameplayInput",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.luigi.js",
  });
  return context;
}

function writeU32(context, address, value) {
  context.view.setUint32(address & 0x1fffffff, value, false);
}

function writeU16(context, address, value) {
  context.view.setUint16(address & 0x1fffffff, value, false);
}

function writeU8(context, address, value) {
  context.view.setUint8(address & 0x1fffffff, value);
}

function writeF32(context, address, value) {
  context.view.setFloat32(address & 0x1fffffff, value, false);
}

function seedControllableFoyer(context) {
  const root = 0x803a8000;
  const manager = 0x803a9000;
  const handle = 4;
  const player = 0x80400000;
  const pad = 0x80410000;
  const controller = 0x80420000;
  const roomInfo = 0x02000102;

  writeU32(context, 0x804d80a0, 2);
  writeU32(context, 0x804d80c4, 0);
  writeU32(context, 0x804d80c8, 2);
  writeU32(context, 0x804d8370, 0);
  writeU16(context, 0x804d8374, 0);
  // The retail event loop leaves this iteration scratch pointer stale.
  writeU32(context, 0x804d8378, 0x80430000);
  writeU8(context, 0x804d837c, 0);
  writeU32(context, 0x804d8728, 2);
  writeU32(context, 0x803a3cac, roomInfo);
  for (const [offset, value] of [[0, 10], [4, 0], [8, 20]]) {
    writeF32(context, 0x803a3ca0 + offset, value);
    writeF32(context, player + 0x44 + offset, value);
  }

  writeU32(context, 0x804d8c60, root);
  writeU32(context, root + 8, manager);
  writeU32(context, manager + 0xe08, handle);
  writeU32(context, 0x803d48a0 + handle * 4, player);
  writeU32(context, player, 0x80359d48);
  writeU16(context, player + 0x88, 0x1000);
  writeU32(context, player + 0xb4, roomInfo);
  writeU32(context, player + 0x794, pad);
  writeU32(context, player + 0x7d4, controller);
  writeU16(context, player + 0xfc, 100);
  writeU8(context, player + 0x1042, 0);
  writeU8(context, player + 0x1058, 0);
  writeF32(context, player + 0x105c, 0);
  writeF32(context, player + 0x106c, 0);

  writeU32(context, 0x804d8078, pad);
  writeU32(context, pad + 0x18, 0);
  writeU32(context, pad + 0x1c, 0);
  writeF32(context, pad + 0x44, 0);
  writeF32(context, pad + 0x48, 0);
  writeF32(context, pad + 0x4c, 0);
  writeU16(context, pad + 0x74, 0);
  context.view.setUint8((pad + 0x76) & 0x1fffffff, 0);

  writeU32(context, controller + 0x1b0, pad);
  writeF32(context, controller + 0x1c0, 0);
  writeF32(context, controller + 0x1dc, 0);
  return { controller, handle, manager, pad, player, root, roomInfo };
}

test("Luigi diagnostics expose the exact controllable retail foyer state", () => {
  const context = makeContext();
  const fixture = seedControllableFoyer(context);
  const state = JSON.parse(JSON.stringify(
    context.inspectLuigisMansionGameState(),
  ));

  assert.equal(state.sceneIdAddress, "0x804d80a0");
  assert.equal(state.sceneId, 2);
  assert.equal(state.openMapId, 2);
  assert.equal(state.gameMode, 2);
  assert.deepEqual(state.eventManager, {
    slotBasePointerAddress: "0x804d8370",
    slotBase: "0x00000000",
    slotCountAddress: "0x804d8374",
    slotCount: 0,
    slotStride: 0x58,
    tableValid: true,
    iteratorScratchPointerAddress: "0x804d8378",
    iteratorScratchPointer: "0x80430000",
    iteratorScratchHasActiveEventSemantics: false,
    blockingCountAddress: "0x804d837c",
    blockingCount: 0,
    activeSlotLimit: 16,
    activeCount: 0,
    activeSlotsTruncated: false,
    activeSlots: [],
  });
  assert.equal(state.eventInactive, true);
  assert.equal(state.currentRoomInfo, "0x02000102");
  assert.deepEqual(state.currentPlayerPosition, { x: 10, y: 0, z: 20 });
  assert.deepEqual(state.playerLookup, {
    rootPointerAddress: "0x804d8c60",
    root: "0x803a8000",
    managerPointerAddress: "0x803a8008",
    manager: "0x803a9000",
    handleAddress: "0x803a9e08",
    handle: fixture.handle,
    objectSlotAddress: "0x803d48b0",
  });
  assert.equal(state.player.address, "0x80400000");
  assert.equal(state.player.vtable, "0x80359d48");
  assert.equal(state.player.roomInfo, "0x02000102");
  assert.equal(state.player.gamePad, "0x80410000");
  assert.equal(state.player.controller, "0x80420000");
  assert.equal(state.pad.held, 0);
  assert.equal(state.pad.mainStickX, 0);
  assert.equal(state.pad.mainStickValue, 0);
  assert.equal(state.controller.inputSource, "0x80410000");
  assert.equal(state.controller.mainStickMagnitude, 0);
  assert.deepEqual(state.inputGate, {
    healthAddress: "0x804000fc",
    health: 100,
    state1042Address: "0x80401042",
    state1042: 0,
    state1058Address: "0x80401058",
    state1058: 0,
    timer105cAddress: "0x8040105c",
    timer105c: 0,
    state106cAddress: "0x8040106c",
    state106c: 0,
    open: true,
  });
  assert.equal(state.expectedInputSource, "0x80410000");
  assert.equal(state.inputGateCoherent, true);
  assert.equal(state.inputPipelineReady, true);
  assert.equal(state.controllerAcceptingPad, true);
  assert.equal(state.controlsEnabled, true);
  assert.equal(state.neutralInput, true);
  assert.equal(state.controllableFoyer, true);
  assert.equal(state.gxPostTexMtx18Load, null);
  assert.equal(state.lastActiveGameplayInput, null);
});

test("Luigi event activity comes from validated slot flags, not stale iterator scratch", () => {
  const context = makeContext();
  seedControllableFoyer(context);
  const slot = 0x80430000;
  writeU32(context, 0x804d8370, slot);
  writeU16(context, 0x804d8374, 1);
  writeU32(context, 0x804d8378, slot);
  writeU8(context, 0x804d837c, 1);
  writeU32(context, slot, 0x101);
  writeU16(context, slot + 0x38, 7);
  writeU32(context, slot + 0x3c, 123);

  const active = JSON.parse(JSON.stringify(
    context.inspectLuigisMansionGameState(),
  ));
  assert.equal(active.eventInactive, false);
  assert.equal(active.controllableFoyer, false);
  assert.equal(active.eventManager.tableValid, true);
  assert.equal(active.eventManager.activeCount, 1);
  assert.deepEqual(active.eventManager.activeSlots, [{
    index: 0,
    address: "0x80430000",
    flagsAddress: "0x80430000",
    flags: 0x101,
    idAddress: "0x80430038",
    id: 7,
    tickAddress: "0x8043003c",
    tick: 123,
  }]);

  // Cleanup clears active bit zero and sets ended bit three, but does not
  // clear the event loop's scratch pointer.
  writeU32(context, slot, 0x108);
  writeU8(context, 0x804d837c, 0);
  const ended = JSON.parse(JSON.stringify(
    context.inspectLuigisMansionGameState(),
  ));
  assert.equal(ended.eventManager.iteratorScratchPointer, "0x80430000");
  assert.equal(
    ended.eventManager.iteratorScratchHasActiveEventSemantics,
    false,
  );
  assert.equal(ended.eventManager.activeCount, 0);
  assert.deepEqual(ended.eventManager.activeSlots, []);
  assert.equal(ended.eventInactive, true);
  assert.equal(ended.controllableFoyer, true);

  writeU16(context, 0x804d8374, 17);
  for (let index = 0; index < 17; index += 1) {
    writeU32(context, slot + index * 0x58, 1);
  }
  const bounded = context.inspectLuigisMansionGameState().eventManager;
  assert.equal(bounded.activeCount, 17);
  assert.equal(bounded.activeSlots.length, 16);
  assert.equal(bounded.activeSlotsTruncated, true);

  writeU32(context, 0x804d8370, 0x817fffd0);
  writeU16(context, 0x804d8374, 2);
  const invalid = context.inspectLuigisMansionGameState();
  assert.equal(invalid.eventManager.tableValid, false);
  assert.equal(invalid.eventManager.activeCount, null);
  assert.equal(invalid.eventManager.activeSlotsTruncated, null);
  assert.equal(invalid.eventInactive, false);
  assert.equal(invalid.controllableFoyer, false);
});

test("Luigi controller acceptance follows all five retail player input gates", () => {
  const cases = [
    {
      name: "state106c",
      mutate(context, fixture) {
        writeF32(context, fixture.player + 0x106c, 1);
      },
    },
    {
      name: "health",
      mutate(context, fixture) {
        writeU16(context, fixture.player + 0xfc, 0);
      },
    },
    {
      name: "state1042",
      mutate(context, fixture) {
        writeU8(context, fixture.player + 0x1042, 1);
      },
    },
    {
      name: "state1058",
      mutate(context, fixture) {
        writeU8(context, fixture.player + 0x1058, 1);
      },
    },
    {
      name: "timer105c",
      mutate(context, fixture) {
        writeF32(context, fixture.player + 0x105c, 1);
      },
    },
  ];

  for (const { mutate, name } of cases) {
    const context = makeContext();
    const fixture = seedControllableFoyer(context);
    mutate(context, fixture);
    writeU32(context, fixture.controller + 0x1b0, 0);
    const state = context.inspectLuigisMansionGameState();
    assert.equal(state.inputPipelineReady, true, name);
    assert.equal(state.inputGate.open, false, name);
    assert.equal(state.expectedInputSource, null, name);
    assert.equal(state.controller.inputSource, null, name);
    assert.equal(state.inputGateCoherent, true, name);
    assert.equal(state.controllerAcceptingPad, false, name);
    assert.equal(state.controlsEnabled, false, name);
    assert.equal(state.controllableFoyer, false, name);
  }

  const mismatch = makeContext();
  const mismatchFixture = seedControllableFoyer(mismatch);
  writeU8(mismatch, mismatchFixture.player + 0x1042, 1);
  const mismatchState = mismatch.inspectLuigisMansionGameState();
  assert.equal(mismatchState.expectedInputSource, null);
  assert.equal(mismatchState.controller.inputSource, "0x80410000");
  assert.equal(mismatchState.inputGateCoherent, false);
  assert.equal(mismatchState.controllerAcceptingPad, false);

  const nonPositiveTimer = makeContext();
  const nonPositiveFixture = seedControllableFoyer(nonPositiveTimer);
  writeF32(nonPositiveTimer, nonPositiveFixture.player + 0x105c, -1);
  assert.equal(
    nonPositiveTimer.inspectLuigisMansionGameState().controllerAcceptingPad,
    true,
  );
});

test("Luigi diagnostics expose opening archive, timeline, and audio cadence state", () => {
  const context = makeContext();
  const timeline = 0x80430000;
  const animation = 0x80431000;
  const duration = 0x80432000;
  const rate = 0x80432004;
  const loaderFile = 0x80433000;

  writeU32(context, 0x804d8d18, 4);
  writeU8(context, 0x804d8cf0, 1);
  writeU8(context, 0x804d8ce8, 0);
  writeU8(context, 0x804d8ce9, 0);
  writeU32(context, 0x804d8ce0, timeline);
  writeF32(context, timeline, 123.5);
  writeF32(context, timeline + 4, 122.5);
  writeU32(context, timeline + 8, 4);
  writeU32(context, timeline + 0x0c, 3);
  writeU32(context, timeline + 0x24, animation);
  writeU32(context, animation + 0x20c, duration);
  writeU32(context, animation + 0x210, rate);
  writeU16(context, duration, 1800);
  writeF32(context, rate, 1);

  writeU32(context, 0x8039ce38, 1);
  writeU32(context, 0x8039ce40, loaderFile);
  writeU32(context, loaderFile + 0x0c, 0);
  writeU32(context, loaderFile + 0x1c, 797152);
  writeU32(context, loaderFile + 0x20, 797152);
  writeU32(context, loaderFile + 0x30, 0x4d4b5bb8);
  writeU32(context, loaderFile + 0x34, 0x000c29e0);
  writeU32(context, loaderFile + 0x74, 0x801137fc);
  writeU8(context, 0x804d8028, 0);
  writeU32(context, 0x804d80ac, 0);
  writeU32(context, 0x804d9364, 6);
  writeU8(context, 0x804d9382, 1);

  const opening = JSON.parse(JSON.stringify(
    context.inspectLuigisMansionGameState().opening,
  ));
  assert.deepEqual(opening, {
    archiveStateAddress: "0x804d8d18",
    archiveState: 4,
    drawReadyAddress: "0x804d8cf0",
    drawReady: 1,
    stateAddress: "0x804d8d18",
    state: 4,
    finishedAddress: "0x804d8ce8",
    finished: 0,
    skippedAddress: "0x804d8ce9",
    skipped: 0,
    loaderActiveCountAddress: "0x8039ce38",
    loaderActiveCount: 1,
    loaderCurrentFileAddress: "0x8039ce40",
    loaderCurrentFile: {
      address: "0x80433000",
      commandState: 0,
      currentTransfer: 797152,
      transferred: 797152,
      fileOffset: "0x4d4b5bb8",
      fileLength: 797152,
      callback: "0x801137fc",
    },
    fatalArchiveDvdFlagAddress: "0x804d8028",
    fatalArchiveDvdFlag: 0,
    driveErrorAddress: "0x804d80ac",
    driveError: 0,
    audioSubframesRemainingAddress: "0x804d9364",
    audioSubframesRemaining: 6,
    audioDspStatusAddress: "0x804d9382",
    audioDspStatus: 1,
    timeline: {
      pointerAddress: "0x804d8ce0",
      address: "0x80430000",
      time: 123.5,
      previousTime: 122.5,
      flags: "0x00000004",
      activeEvents: 3,
      animation: "0x80431000",
      duration: 1800,
      rate: 1,
    },
  });
});

test("Luigi diagnostics fail closed on revision, pointer, vtable, and room mismatches", () => {
  assert.equal(makeContext("GLME01", 1).inspectLuigisMansionGameState(), null);
  assert.equal(makeContext("GZLE01", 0).inspectLuigisMansionGameState(), null);

  const missingRoot = makeContext();
  const missingState = missingRoot.inspectLuigisMansionGameState();
  assert.equal(missingState.player.address, null);
  assert.equal(missingState.controllableFoyer, false);

  const wrongVtable = makeContext();
  const wrongVtableFixture = seedControllableFoyer(wrongVtable);
  writeU32(wrongVtable, wrongVtableFixture.player, 0x80359d4c);
  assert.equal(wrongVtable.inspectLuigisMansionGameState().player.valid, false);
  assert.equal(
    wrongVtable.inspectLuigisMansionGameState().controllableFoyer,
    false,
  );

  const wrongRoom = makeContext();
  seedControllableFoyer(wrongRoom);
  writeU32(wrongRoom, 0x803a3cac, 0x02000103);
  assert.equal(wrongRoom.inspectLuigisMansionGameState().foyerActive, false);
  assert.equal(wrongRoom.inspectLuigisMansionGameState().controllableFoyer, false);
});

test("Luigi retains the first exact-sequence guest-consumed left receipt", () => {
  const context = makeContext();
  const fixture = seedControllableFoyer(context);
  writeU32(context, fixture.pad + 0x18, 0x01000001);
  writeU32(context, fixture.pad + 0x1c, 0x01000001);
  writeF32(context, fixture.pad + 0x44, -1);
  writeF32(context, fixture.pad + 0x48, 0);
  writeF32(context, fixture.pad + 0x4c, 1);
  writeF32(context, fixture.controller + 0x1c0, 1);
  writeF32(context, 0x803a3ca0, 11);
  writeU16(context, fixture.player + 0x88, 0x1080);
  context.controllerAppliedSequence = 7;
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 42,
    scheduledCycle: 100,
    observedCycle: 105,
    buttons: 0x0001,
    sequence: 7,
  };

  context.sampleLuigisMansionGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.inspectLuigisMansionGameState().lastActiveGameplayInput,
    )),
    {
      cycle: 120,
      controllerAppliedSequence: 7,
      hostPublication: {
        source: "periodic",
        pollIndex: 42,
        scheduledCycle: 100,
        observedCycle: 105,
        buttons: 0x0001,
        sequence: 7,
      },
      player: "0x80400000",
      roomInfo: "0x02000102",
      position: { x: 11, y: 0, z: 20 },
      heading: 0x1080,
      pad: {
        held: 0x01000001,
        trigger: 0x01000001,
        mainStickX: -1,
        mainStickY: 0,
        mainStickValue: 1,
      },
      controller: {
        inputSource: "0x80410000",
        mainStickMagnitude: 1,
      },
    },
  );

  writeF32(context, 0x803a3ca0, 12);
  context.sampleLuigisMansionGameplayInput(130);
  assert.equal(context.luigisMansionLastActiveGameplayInput.cycle, 120);
  assert.equal(context.luigisMansionLastActiveGameplayInput.position.x, 11);
});

test("Luigi input latch rejects unrelated host or guest state", () => {
  const wrongHost = makeContext();
  const hostFixture = seedControllableFoyer(wrongHost);
  writeU32(wrongHost, hostFixture.pad + 0x18, 0x01000001);
  writeF32(wrongHost, hostFixture.pad + 0x44, -1);
  writeF32(wrongHost, hostFixture.pad + 0x4c, 1);
  writeF32(wrongHost, hostFixture.controller + 0x1c0, 1);
  wrongHost.controllerAppliedSequence = 2;
  wrongHost.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 2,
    scheduledCycle: 10,
    observedCycle: 10,
    buttons: 0x0100,
    sequence: 2,
  };
  wrongHost.sampleLuigisMansionGameplayInput(20);
  assert.equal(wrongHost.luigisMansionLastActiveGameplayInput, null);

  const wrongGuest = makeContext();
  seedControllableFoyer(wrongGuest);
  wrongGuest.controllerAppliedSequence = 2;
  wrongGuest.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 2,
    scheduledCycle: 10,
    observedCycle: 10,
    buttons: 0x0001,
    sequence: 2,
  };
  wrongGuest.sampleLuigisMansionGameplayInput(20);
  assert.equal(wrongGuest.luigisMansionLastActiveGameplayInput, null);
});

test("guest diagnostics and VI sampling dispatch through exact retail identity", () => {
  const luigi = makeContext();
  seedControllableFoyer(luigi);
  assert.notEqual(luigi.inspectGuestGameState(), null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GMBE8P").inspectGuestGameState())),
    { game: "smb" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZWE01").inspectGuestGameState())),
    { game: "wario" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZLE01").inspectGuestGameState())),
    { game: "wind" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GFZE01").inspectGuestGameState())),
    { game: "fzero" },
  );
  assert.match(
    source,
    /function sampleGuestGameplayInput\(sampleCycle\) \{\s+sampleLuigisMansionGameplayInput\(sampleCycle\);\s+sampleWindWakerGameplayInput\(sampleCycle\);\s+sampleMeleeGameplayInput\(sampleCycle\);\s+sampleFzeroGameplayInput\(sampleCycle\);\s+sampleWarioWareGameplayInput\(sampleCycle\);/,
  );
  assert.match(
    source,
    /if \(scanoutDue\) \{\s+sampleGuestGameplayInput\(scheduledCycle\);/,
  );
  assert.match(source, /guestGame: inspectGuestGameState\(\)/);
});
