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
    boot: { identifier, version },
    controllerAppliedSequence: 0,
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
  writeU32(context, 0x804d8378, 0);
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
  assert.equal(state.executingEvent, null);
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
  assert.equal(state.controlsEnabled, true);
  assert.equal(state.neutralInput, true);
  assert.equal(state.controllableFoyer, true);
  assert.equal(state.lastActiveGameplayInput, null);
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
