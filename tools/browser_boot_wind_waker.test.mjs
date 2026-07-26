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

function makeContext(identifier = "GZLE01", version = 0) {
  const memory = new ArrayBuffer(0x1800000);
  const view = new DataView(memory);
  const context = {
    Math,
    Number,
    boot: { identifier, version },
    controllerAppliedSequence: 0,
    serialLastActiveHostPublication: null,
    windWakerLastActiveGameplayInput: null,
    view,
    ramPointer(address, length) {
      const physical = address & 0x1fffffff;
      return physical <= memory.byteLength - length ? physical : null;
    },
    inspectSuperMonkeyBallGameState() {
      return identifier === "GMBE8P" ? { game: "smb" } : null;
    },
    inspectLuigisMansionGameState() {
      return identifier === "GLME01" ? { game: "luigi" } : null;
    },
    inspectMeleeGameState() {
      return identifier === "GALE01" && version === 2
        ? { game: "melee" }
        : null;
    },
    inspectWarioWareGameState() {
      return identifier === "GZWE01" ? { game: "wario" } : null;
    },
    sampleLuigisMansionGameplayInput() {},
    sampleMeleeGameplayInput() {},
    sampleWarioWareGameplayInput() {},
  };
  vm.createContext(context);
  vm.runInContext([
    "guestU32",
    "guestU8",
    "guestU16",
    "guestF32",
    "hex32",
    "windWakerMappedPointer",
    "inspectWindWakerPosition",
    "inspectWindWakerGameState",
    "sampleWindWakerGameplayInput",
    "inspectGuestGameState",
    "sampleGuestGameplayInput",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.wind_waker.js",
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

function seedControllableOutset(context) {
  const currentStage = 0x803c9d3c;
  const player = 0x80400000;
  const controller = 0x803a4df0;
  for (const [index, value] of [..."sea"].entries()) {
    writeU8(context, currentStage + index, value.charCodeAt(0));
  }
  writeU8(context, currentStage + 3, 0);
  writeU8(context, currentStage + 0x0a, 44);
  writeU8(context, 0x803f6a78, 44);
  writeU8(context, 0x803c9ea2, 0);
  writeU8(context, 0x803f7097, 0);
  writeU8(context, 0x803f72b0, 0);

  writeU32(context, 0x803ca74c, player);
  writeU32(context, 0x803ca754, player);
  writeU16(context, player + 8, 0x00a9);
  writeU8(context, player + 0x0b, 0);
  writeU32(context, player + 0x10, 0x8038fd8c);
  writeF32(context, player + 0x1f8, -111.5);
  writeF32(context, player + 0x1fc, 250);
  writeF32(context, player + 0x200, 37.25);
  writeU16(context, player + 0x206, 0x4000);
  writeU8(context, player + 0x20a, 44);

  writeF32(context, controller, 0);
  writeF32(context, controller + 4, 0);
  writeF32(context, controller + 8, 0);
  writeU16(context, controller + 0x30, 0);
  writeU16(context, controller + 0x32, 0);
  writeU8(context, controller + 0x34, 0);
  return { controller, currentStage, player };
}

function applyConsumedLeft(context, fixture) {
  writeF32(context, fixture.controller, -1);
  writeF32(context, fixture.controller + 4, 0);
  writeF32(context, fixture.controller + 8, 1);
  writeU16(context, fixture.controller + 0x30, 0x8000);
  writeU16(context, fixture.controller + 0x32, 0x8000);
}

function publishLeft(context, overrides = {}) {
  const {
    appliedSequence = 7,
    ...publicationOverrides
  } = overrides;
  context.controllerAppliedSequence = appliedSequence;
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 42,
    scheduledCycle: 100,
    observedCycle: 105,
    buttons: 0x0001,
    sequence: 7,
    ...publicationOverrides,
  };
}

test("Wind Waker diagnostics expose exact controllable retail Outset state", () => {
  const context = makeContext();
  seedControllableOutset(context);
  const state = JSON.parse(JSON.stringify(context.inspectWindWakerGameState()));

  assert.deepEqual(state.currentStage, {
    address: "0x803c9d3c",
    name: "sea",
    roomAddress: "0x803c9d46",
    room: 44,
  });
  assert.equal(state.stayRoomAddress, "0x803f6a78");
  assert.equal(state.stayRoom, 44);
  assert.equal(state.outsetRoom, 44);
  assert.equal(state.stageActive, true);
  assert.equal(state.eventModeAddress, "0x803c9ea2");
  assert.equal(state.eventMode, 0);
  assert.equal(state.eventInactive, true);
  assert.equal(state.menuPauseAddress, "0x803f7097");
  assert.equal(state.pauseTimerAddress, "0x803f72b0");
  assert.equal(state.menuClosed, true);
  assert.deepEqual(state.playerLookup, {
    playerPointerAddress: "0x803ca74c",
    player: "0x80400000",
    linkPlayerPointerAddress: "0x803ca754",
    linkPlayer: "0x80400000",
    pointersMatch: true,
  });
  assert.equal(state.player.processNameAddress, "0x80400008");
  assert.equal(state.player.processName, 0x00a9);
  assert.equal(state.player.profileAddress, "0x80400010");
  assert.equal(state.player.profile, "0x8038fd8c");
  assert.equal(state.player.pauseFlagAddress, "0x8040000b");
  assert.equal(state.player.valid, true);
  assert.equal(state.player.positionAddress, "0x804001f8");
  assert.deepEqual(state.player.position, { x: -111.5, y: 250, z: 37.25 });
  assert.equal(state.player.headingAddress, "0x80400206");
  assert.equal(state.player.heading, 0x4000);
  assert.equal(state.player.roomAddress, "0x8040020a");
  assert.equal(state.player.room, 44);
  assert.equal(state.pad.address, "0x803a4df0");
  assert.equal(state.pad.holdAddress, "0x803a4e20");
  assert.equal(state.pad.triggerAddress, "0x803a4e22");
  assert.equal(state.pad.errorAddress, "0x803a4e24");
  assert.equal(state.controlsEnabled, true);
  assert.equal(state.neutralInput, true);
  assert.equal(state.controllableOutset, true);
  assert.equal(state.lastActiveGameplayInput, null);
});

test("Wind Waker diagnostics fail closed on revision and retail state drift", () => {
  assert.equal(makeContext("GZLE01", 1).inspectWindWakerGameState(), null);
  assert.equal(makeContext("GZWE01", 0).inspectWindWakerGameState(), null);

  const missingPlayer = makeContext();
  seedControllableOutset(missingPlayer);
  writeU32(missingPlayer, 0x803ca74c, 0);
  assert.equal(missingPlayer.inspectWindWakerGameState().player.valid, false);
  assert.equal(
    missingPlayer.inspectWindWakerGameState().controllableOutset,
    false,
  );

  const mismatchedPointers = makeContext();
  seedControllableOutset(mismatchedPointers);
  writeU32(mismatchedPointers, 0x803ca754, 0x80410000);
  assert.equal(
    mismatchedPointers.inspectWindWakerGameState().playerLookup.pointersMatch,
    false,
  );
  assert.equal(
    mismatchedPointers.inspectWindWakerGameState().controllableOutset,
    false,
  );

  const wrongProfile = makeContext();
  const profileFixture = seedControllableOutset(wrongProfile);
  writeU32(wrongProfile, profileFixture.player + 0x10, 0x8038fd90);
  assert.equal(wrongProfile.inspectWindWakerGameState().player.valid, false);
  assert.equal(wrongProfile.inspectWindWakerGameState().controllableOutset, false);

  const wrongStage = makeContext();
  const stageFixture = seedControllableOutset(wrongStage);
  writeU8(wrongStage, stageFixture.currentStage, "A".charCodeAt(0));
  assert.equal(wrongStage.inspectWindWakerGameState().stageActive, false);
  assert.equal(wrongStage.inspectWindWakerGameState().controllableOutset, false);

  const wrongProcess = makeContext();
  const processFixture = seedControllableOutset(wrongProcess);
  writeU16(wrongProcess, processFixture.player + 8, 0x00aa);
  assert.equal(wrongProcess.inspectWindWakerGameState().player.valid, false);
  assert.equal(wrongProcess.inspectWindWakerGameState().controllableOutset, false);

  const invalidPosition = makeContext();
  const positionFixture = seedControllableOutset(invalidPosition);
  writeF32(invalidPosition, positionFixture.player + 0x1f8, Number.NaN);
  assert.equal(
    invalidPosition.inspectWindWakerGameState().controllableOutset,
    false,
  );

  for (const [address, value, label] of [
    [0x803c9d46, 43, "current stage room"],
    [0x803f6a78, 43, "stay room"],
    [0x8040020a, 43, "player room"],
    [0x803c9ea2, 1, "event mode"],
    [0x803f7097, 1, "menu pause"],
    [0x803f72b0, 1, "pause timer"],
    [0x8040000b, 1, "player pause flag"],
    [0x803a4e24, 1, "controller error"],
  ]) {
    const context = makeContext();
    seedControllableOutset(context);
    writeU8(context, address, value);
    assert.equal(
      context.inspectWindWakerGameState().controllableOutset,
      false,
      label,
    );
  }
});

test("Wind Waker retains the first exact-sequence guest-consumed left receipt", () => {
  const context = makeContext();
  const fixture = seedControllableOutset(context);
  applyConsumedLeft(context, fixture);
  publishLeft(context);

  context.sampleGuestGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.inspectWindWakerGameState().lastActiveGameplayInput,
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
      stage: "sea",
      room: 44,
      position: { x: -111.5, y: 250, z: 37.25 },
      heading: 0x4000,
      pad: {
        hold: 0x8000,
        trigger: 0x8000,
        mainStickX: -1,
        mainStickY: 0,
        mainStickValue: 1,
      },
    },
  );

  writeF32(context, fixture.player + 0x1f8, -120);
  context.sampleWindWakerGameplayInput(130);
  assert.equal(context.windWakerLastActiveGameplayInput.cycle, 120);
  assert.equal(context.windWakerLastActiveGameplayInput.position.x, -111.5);
});

test("Wind Waker input latch rejects unrelated host, timing, or guest state", () => {
  for (const [overrides, label] of [
    [{ buttons: 0x0100 }, "wrong host input"],
    [{ sequence: 8 }, "unapplied host sequence"],
    [{ scheduledCycle: 110, observedCycle: 105 }, "reversed publication"],
    [{ observedCycle: 121 }, "future observation"],
  ]) {
    const context = makeContext();
    const fixture = seedControllableOutset(context);
    applyConsumedLeft(context, fixture);
    publishLeft(context, overrides);
    context.sampleWindWakerGameplayInput(120);
    assert.equal(context.windWakerLastActiveGameplayInput, null, label);
  }

  const neutralGuest = makeContext();
  seedControllableOutset(neutralGuest);
  publishLeft(neutralGuest);
  neutralGuest.sampleWindWakerGameplayInput(120);
  assert.equal(neutralGuest.windWakerLastActiveGameplayInput, null);

  const menuGuest = makeContext();
  const menuFixture = seedControllableOutset(menuGuest);
  applyConsumedLeft(menuGuest, menuFixture);
  writeU8(menuGuest, 0x803f7097, 1);
  publishLeft(menuGuest);
  menuGuest.sampleWindWakerGameplayInput(120);
  assert.equal(menuGuest.windWakerLastActiveGameplayInput, null);

  for (const [hold, label] of [
    [0, "stale analog without guest left"],
    [0x4000, "wrong guest direction"],
    [0x8001, "guest state with an extra button"],
  ]) {
    const staleAnalogGuest = makeContext();
    const staleAnalogFixture = seedControllableOutset(staleAnalogGuest);
    applyConsumedLeft(staleAnalogGuest, staleAnalogFixture);
    writeU16(staleAnalogGuest, staleAnalogFixture.controller + 0x30, hold);
    publishLeft(staleAnalogGuest);
    staleAnalogGuest.sampleWindWakerGameplayInput(120);
    assert.equal(
      staleAnalogGuest.windWakerLastActiveGameplayInput,
      null,
      label,
    );
  }
});

test("guest diagnostics and VI sampling dispatch Wind Waker by exact identity", () => {
  const wind = makeContext();
  seedControllableOutset(wind);
  assert.equal(wind.inspectGuestGameState().controllableOutset, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GMBE8P").inspectGuestGameState())),
    { game: "smb" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GLME01").inspectGuestGameState())),
    { game: "luigi" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZWE01").inspectGuestGameState())),
    { game: "wario" },
  );
  assert.equal(makeContext("GZLE01", 1).inspectGuestGameState(), null);
  assert.match(
    source,
    /function sampleGuestGameplayInput\(sampleCycle\) \{\s+sampleLuigisMansionGameplayInput\(sampleCycle\);\s+sampleWindWakerGameplayInput\(sampleCycle\);\s+sampleMeleeGameplayInput\(sampleCycle\);\s+sampleWarioWareGameplayInput\(sampleCycle\);/,
  );
  assert.match(
    source,
    /if \(scanoutDue\) \{\s+sampleGuestGameplayInput\(scheduledCycle\);/,
  );
  assert.match(source, /guestGame: inspectGuestGameState\(\)/);
});
