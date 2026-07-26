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

function makeContext(identifier = "GALE01", version = 2) {
  const memory = new ArrayBuffer(0x1800000);
  const view = new DataView(memory);
  const context = {
    Math,
    Number,
    boot: { identifier, version },
    controllerAppliedSequence: 0,
    meleeLastActiveGameplayInput: null,
    serialLastActiveHostPublication: null,
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
    inspectWindWakerGameState() {
      return identifier === "GZLE01" ? { game: "wind" } : null;
    },
    inspectWarioWareGameState() {
      return identifier === "GZWE01" ? { game: "wario" } : null;
    },
    sampleLuigisMansionGameplayInput() {},
    sampleWindWakerGameplayInput() {},
    sampleWarioWareGameplayInput() {},
  };
  vm.createContext(context);
  vm.runInContext([
    "guestU32",
    "guestU8",
    "guestS8",
    "guestU16",
    "guestS32",
    "guestF32",
    "hex32",
    "meleeMappedPointer",
    "inspectMeleePosition",
    "inspectMeleeGameState",
    "sampleMeleeGameplayInput",
    "inspectGuestGameState",
    "sampleGuestGameplayInput",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.melee.js",
  });
  return context;
}

function writeU32(context, address, value) {
  context.view.setUint32(address & 0x1fffffff, value, false);
}

function writeS32(context, address, value) {
  context.view.setInt32(address & 0x1fffffff, value, false);
}

function writeU16(context, address, value) {
  context.view.setUint16(address & 0x1fffffff, value, false);
}

function writeU8(context, address, value) {
  context.view.setUint8(address & 0x1fffffff, value);
}

function writeS8(context, address, value) {
  context.view.setInt8(address & 0x1fffffff, value);
}

function writeF32(context, address, value) {
  context.view.setFloat32(address & 0x1fffffff, value, false);
}

function seedActiveMatch(context) {
  const routing = 0x80479d30;
  const match = 0x8046b6a0;
  const slot = 0x80453080;
  const sceneInfo = 0x803dd9dc;
  const gobj = 0x80400000;
  const fighter = 0x80410000;
  const pad = 0x804c21cc;

  writeU8(context, routing, 2);
  writeU8(context, routing + 3, 2);
  writeU8(context, routing + 0x0c, 0);
  writeU32(context, 0x804d6720, sceneInfo);
  writeU8(context, sceneInfo, 2);
  writeU32(context, sceneInfo + 4, 0x80480530);
  writeU32(context, sceneInfo + 8, 0x80479d98);

  writeU8(context, match, 0);
  writeU8(context, match + 2, 0);
  writeU8(context, match + 4, 0);
  writeU8(context, match + 5, 1);
  writeU8(context, match + 6, 0);
  writeU8(context, match + 7, 0);
  writeU8(context, match + 8, 0);
  writeU8(context, match + 0x0e, 0);
  writeU32(context, match + 0x24, 120);
  writeU8(context, match + 0x3a, 0);
  writeU8(context, match + 0x42, 0);
  writeU8(context, 0x80479d68, 0);

  writeS32(context, slot, 2);
  writeS32(context, slot + 4, 8);
  writeS32(context, slot + 8, 0);
  writeU8(context, slot + 0x0c, 0);
  writeU8(context, slot + 0x46, 0);
  writeU8(context, slot + 0x48, 0);
  writeU8(context, slot + 0x8e, 4);
  writeS32(context, slot + 0xa0, 12);
  writeU32(context, slot + 0xb0, gobj);
  writeS32(context, slot + 0xe90, 2);
  writeS32(context, slot + 0xe90 + 8, 1);

  writeU16(context, gobj, 4);
  writeU8(context, gobj + 2, 8);
  writeU8(context, gobj + 4, 0);
  writeU8(context, gobj + 7, 4);
  writeU32(context, gobj + 0x2c, fighter);

  writeU32(context, fighter, gobj);
  writeS32(context, fighter + 4, 0);
  writeU8(context, fighter + 0x0c, 0);
  writeS32(context, fighter + 0x10, 14);
  writeF32(context, fighter + 0x2c, 1);
  for (const [offset, value] of [[0, 10], [4, 20], [8, 0]]) {
    writeF32(context, fighter + 0xb0 + offset, value);
    writeF32(context, fighter + 0xbc + offset, value);
  }
  writeS32(context, fighter + 0xe0, 0);
  writeF32(context, fighter + 0x80, 0);
  writeF32(context, fighter + 0xc8, 0);
  writeU8(context, fighter + 0x618, 0);
  writeU8(context, fighter + 0x61a, 0);
  for (const offset of [0x620, 0x624, 0x628, 0x62c]) {
    writeF32(context, fighter + offset, 0);
  }
  for (const offset of [0x65c, 0x668, 0x66c]) {
    writeU32(context, fighter + offset, 0);
  }

  writeU32(context, pad, 0);
  writeU32(context, pad + 8, 0);
  writeU8(context, pad + 0x18, 0);
  writeU8(context, pad + 0x19, 0);
  writeF32(context, pad + 0x20, 0);
  writeF32(context, pad + 0x24, 0);
  writeU8(context, pad + 0x41, 0);
  return { fighter, gobj, match, pad, routing, sceneInfo, slot };
}

function applyConsumedLeft(context, fixture) {
  writeU32(context, fixture.pad, 0x00040001);
  writeU32(context, fixture.pad + 8, 0x00040001);
  writeS8(context, fixture.pad + 0x18, -80);
  writeS8(context, fixture.pad + 0x19, 0);
  writeF32(context, fixture.pad + 0x20, -1);
  writeF32(context, fixture.pad + 0x24, 0);
  writeS32(context, fixture.fighter + 0x10, 15);
  writeF32(context, fixture.fighter + 0x620, -1);
  writeF32(context, fixture.fighter + 0x624, 0);
  writeU32(context, fixture.fighter + 0x65c, 0x00040001);
  writeU32(context, fixture.fighter + 0x668, 0x00040001);
  writeS32(context, fixture.slot + 0xa0, 13);
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

test("Melee diagnostics expose exact unpaused retail Rev 2 active-match state", () => {
  const context = makeContext();
  const fixture = seedActiveMatch(context);
  const state = JSON.parse(JSON.stringify(context.inspectMeleeGameState()));

  assert.equal(state.routing.address, "0x80479d30");
  assert.equal(state.routing.currentMode, 2);
  assert.equal(state.routing.currentSceneIndexAddress, "0x80479d33");
  assert.equal(state.routing.currentSceneIndex, 2);
  assert.equal(state.routing.pendingAddress, "0x80479d3c");
  assert.equal(state.routing.pending, 0);
  assert.equal(
    state.routing.currentSceneInfoPointerAddress,
    "0x804d6720",
  );
  assert.equal(state.routing.currentSceneInfo, "0x803dd9dc");
  assert.equal(state.routing.currentSceneClass, 2);
  assert.equal(state.routing.currentSceneLoadData, "0x80480530");
  assert.equal(state.routing.currentSceneLeaveData, "0x80479d98");
  assert.equal(state.routing.exactSceneInfo, true);
  assert.equal(state.routing.versusMatchScene, true);
  assert.equal(state.match.address, "0x8046b6a0");
  assert.equal(state.match.pauseTimer, 0);
  assert.equal(state.match.unpauseTimer, 0);
  assert.equal(state.match.hudEnabled, 1);
  assert.equal(state.match.singlePlayer, 0);
  assert.equal(state.match.frameCount, 120);
  assert.equal(state.match.playerMatchSlotType, 0);
  assert.equal(state.match.playerRespawnTimer, 0);
  assert.equal(state.match.pauseBitsAddress, "0x80479d68");
  assert.equal(state.match.inProgress, true);
  assert.equal(state.playerSlot.address, "0x80453080");
  assert.equal(state.playerSlot.size, 0xe90);
  assert.equal(state.playerSlot.state, 2);
  assert.equal(state.playerSlot.character, 8);
  assert.equal(state.playerSlot.slotType, 0);
  assert.equal(state.playerSlot.subColor, 0);
  assert.equal(state.playerSlot.stocks, 4);
  assert.equal(state.playerSlot.joystickDirectionCount, 12);
  assert.equal(state.playerSlot.playable, true);
  assert.equal(state.hasOpponent, true);
  assert.equal(state.opponents[0].active, true);
  assert.equal(state.fighterLookup.entityPointerAddress, "0x80453130");
  assert.equal(state.fighterLookup.entity, "0x80400000");
  assert.equal(state.fighterLookup.classifier, 4);
  assert.equal(state.fighterLookup.processLink, 8);
  assert.equal(state.fighterLookup.processPriority, 0);
  assert.equal(state.fighterLookup.userDataKind, 4);
  assert.equal(state.fighterLookup.fighterPointerAddress, "0x8040002c");
  assert.equal(state.fighterLookup.fighter, "0x80410000");
  assert.equal(state.fighter.size, 0x23ec);
  assert.equal(state.fighter.gobj, "0x80400000");
  assert.equal(state.fighter.motionId, 14);
  assert.equal(state.fighter.aliveMotion, true);
  assert.deepEqual(state.fighter.position, { x: 10, y: 20, z: 0 });
  assert.equal(state.fighter.input.leftStickXAddress, "0x80410620");
  assert.equal(state.fighter.input.heldInputsAddress, "0x8041065c");
  assert.equal(state.fighter.selfVelocityX, 0);
  assert.equal(state.fighter.positionDeltaX, 0);
  assert.equal(state.fighter.valid, true);
  assert.equal(state.pad.address, "0x804c21cc");
  assert.equal(state.pad.rawStickXAddress, "0x804c21e4");
  assert.equal(state.pad.rawStickX, 0);
  assert.equal(state.pad.errorAddress, "0x804c220d");
  assert.equal(state.controlsEnabled, true);
  assert.equal(state.neutralInput, true);
  assert.equal(state.activeMatch, true);
  assert.equal(state.lastActiveGameplayInput, null);
  assert.equal(fixture.fighter, 0x80410000);
});

test("Melee accepts an exact matching nonzero fighter sub-color", () => {
  const context = makeContext();
  const fixture = seedActiveMatch(context);
  writeU8(context, fixture.slot + 0x46, 3);
  writeU8(context, fixture.fighter + 0x61a, 3);

  const state = context.inspectMeleeGameState();
  assert.equal(state.playerSlot.subColorAddress, "0x804530c6");
  assert.equal(state.playerSlot.subColor, 3);
  assert.equal(state.fighter.subColorAddress, "0x8041061a");
  assert.equal(state.fighter.subColor, 3);
  assert.equal(state.playerSlot.playable, true);
  assert.equal(state.fighter.valid, true);
  assert.equal(state.activeMatch, true);
});

test("Melee retains the first exact-sequence guest-consumed left receipt", () => {
  const context = makeContext();
  const fixture = seedActiveMatch(context);
  applyConsumedLeft(context, fixture);
  publishLeft(context);

  context.sampleGuestGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.inspectMeleeGameState().lastActiveGameplayInput,
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
      matchFrame: 120,
      transformedIndex: 0,
      joystickDirectionCount: 13,
      entity: "0x80400000",
      fighter: "0x80410000",
      motionId: 15,
      position: { x: 10, y: 20, z: 0 },
      pad: {
        buttons: 0x00040001,
        trigger: 0x00040001,
        rawStickX: -80,
        rawStickY: 0,
        normalizedStickX: -1,
        normalizedStickY: 0,
        error: 0,
      },
      fighterInput: {
        leftStickX: -1,
        leftStickY: 0,
        heldInputs: 0x00040001,
        pressedInputs: 0x00040001,
      },
    },
  );

  writeF32(context, fixture.fighter + 0xb0, 9);
  context.sampleMeleeGameplayInput(130);
  assert.equal(context.meleeLastActiveGameplayInput.cycle, 120);
  assert.equal(context.meleeLastActiveGameplayInput.position.x, 10);
});

test("Melee input latch rejects unrelated host, timing, or guest state", () => {
  for (const [overrides, label] of [
    [{ buttons: 0x0100 }, "wrong host input"],
    [{ sequence: 8 }, "unapplied host sequence"],
    [{ scheduledCycle: 110, observedCycle: 105 }, "reversed publication"],
    [{ observedCycle: 121 }, "future observation"],
    [{ appliedSequence: 8 }, "applied sequence mismatch"],
  ]) {
    const context = makeContext();
    const fixture = seedActiveMatch(context);
    applyConsumedLeft(context, fixture);
    publishLeft(context, overrides);
    context.sampleMeleeGameplayInput(120);
    assert.equal(context.meleeLastActiveGameplayInput, null, label);
  }

  const neutralGuest = makeContext();
  seedActiveMatch(neutralGuest);
  publishLeft(neutralGuest);
  neutralGuest.sampleMeleeGameplayInput(120);
  assert.equal(neutralGuest.meleeLastActiveGameplayInput, null);

  for (const [mutate, label] of [
    [
      (context, fixture) => writeU32(context, fixture.pad + 8, 0),
      "missing guest trigger edge",
    ],
    [
      (context, fixture) => writeU32(context, fixture.fighter + 0x65c, 0),
      "pad-only input",
    ],
    [
      (context, fixture) => writeF32(context, fixture.fighter + 0x620, 0),
      "fighter stick mismatch",
    ],
    [
      (context, fixture) => {
        writeF32(context, fixture.pad + 0x20, -0.75);
        writeF32(context, fixture.fighter + 0x620, -0.75);
      },
      "incorrect HSD stick scaling",
    ],
    [
      (context, fixture) => writeF32(
        context,
        fixture.fighter + 0x620,
        -0.75,
      ),
      "HSD-to-Fighter stick-copy mismatch",
    ],
    [
      (context, fixture) => writeU32(context, fixture.fighter + 0x668, 0),
      "missing Fighter press edge",
    ],
    [
      (context, fixture) => writeS8(context, fixture.pad + 0x18, -79),
      "wrong raw stick",
    ],
    [
      (context, fixture) => writeS32(context, fixture.fighter + 0xe0, 1),
      "airborne fighter",
    ],
  ]) {
    const context = makeContext();
    const fixture = seedActiveMatch(context);
    applyConsumedLeft(context, fixture);
    mutate(context, fixture);
    publishLeft(context);
    context.sampleMeleeGameplayInput(120);
    assert.equal(context.meleeLastActiveGameplayInput, null, label);
  }
});

test("Melee active-match gate fails closed on routing, pause, and lifecycle drift", () => {
  assert.equal(makeContext("GALE01", 1).inspectMeleeGameState(), null);
  assert.equal(makeContext("GZLE01", 2).inspectMeleeGameState(), null);

  const wrongScene = makeContext();
  const sceneFixture = seedActiveMatch(wrongScene);
  writeU8(wrongScene, sceneFixture.routing + 3, 1);
  assert.equal(wrongScene.inspectMeleeGameState().routing.versusMatchScene, false);
  assert.equal(wrongScene.inspectMeleeGameState().activeMatch, false);

  const wrongSceneInfo = makeContext();
  seedActiveMatch(wrongSceneInfo);
  writeU32(wrongSceneInfo, 0x804d6720, 0x803dd9c4);
  assert.equal(
    wrongSceneInfo.inspectMeleeGameState().routing.exactSceneInfo,
    false,
  );
  assert.equal(wrongSceneInfo.inspectMeleeGameState().activeMatch, false);

  const paused = makeContext();
  seedActiveMatch(paused);
  writeU8(paused, 0x80479d68, 2);
  assert.equal(paused.inspectMeleeGameState().match.inProgress, false);
  assert.equal(paused.inspectMeleeGameState().activeMatch, false);

  const pauseTransition = makeContext();
  const pauseFixture = seedActiveMatch(pauseTransition);
  writeU8(pauseTransition, pauseFixture.match + 2, 10);
  assert.equal(
    pauseTransition.inspectMeleeGameState().match.inProgress,
    false,
  );
  assert.equal(pauseTransition.inspectMeleeGameState().activeMatch, false);

  const noHud = makeContext();
  const hudFixture = seedActiveMatch(noHud);
  writeU8(noHud, hudFixture.match + 5, 0);
  assert.equal(noHud.inspectMeleeGameState().match.inProgress, false);
  assert.equal(noHud.inspectMeleeGameState().activeMatch, false);

  const ended = makeContext();
  const endedFixture = seedActiveMatch(ended);
  writeU8(ended, endedFixture.match + 0x0e, 1);
  assert.equal(ended.inspectMeleeGameState().activeMatch, false);

  const noOpponent = makeContext();
  const opponentFixture = seedActiveMatch(noOpponent);
  writeS32(noOpponent, opponentFixture.slot + 0xe90, 0);
  assert.equal(noOpponent.inspectMeleeGameState().hasOpponent, false);
  assert.equal(noOpponent.inspectMeleeGameState().activeMatch, false);

  const dead = makeContext();
  const deadFixture = seedActiveMatch(dead);
  writeS32(dead, deadFixture.fighter + 0x10, 3);
  assert.equal(dead.inspectMeleeGameState().fighter.aliveMotion, false);
  assert.equal(dead.inspectMeleeGameState().activeMatch, false);
});

test("Melee fighter lookup and controls fail closed on pointer and pad drift", () => {
  const badTransform = makeContext();
  const transformFixture = seedActiveMatch(badTransform);
  writeU8(badTransform, transformFixture.slot + 0x0c, 2);
  assert.equal(
    badTransform.inspectMeleeGameState().fighterLookup.entityPointerAddress,
    null,
  );
  assert.equal(badTransform.inspectMeleeGameState().activeMatch, false);

  const wrongClassifier = makeContext();
  const classifierFixture = seedActiveMatch(wrongClassifier);
  writeU16(wrongClassifier, classifierFixture.gobj, 3);
  assert.equal(wrongClassifier.inspectMeleeGameState().fighter.valid, false);
  assert.equal(wrongClassifier.inspectMeleeGameState().activeMatch, false);

  const wrongGobjSignature = makeContext();
  const signatureFixture = seedActiveMatch(wrongGobjSignature);
  writeU8(wrongGobjSignature, signatureFixture.gobj + 7, 3);
  assert.equal(
    wrongGobjSignature.inspectMeleeGameState().fighter.valid,
    false,
  );
  assert.equal(wrongGobjSignature.inspectMeleeGameState().activeMatch, false);

  const wrongBackPointer = makeContext();
  const pointerFixture = seedActiveMatch(wrongBackPointer);
  writeU32(wrongBackPointer, pointerFixture.fighter, 0x80420000);
  assert.equal(wrongBackPointer.inspectMeleeGameState().fighter.valid, false);
  assert.equal(wrongBackPointer.inspectMeleeGameState().activeMatch, false);

  const padError = makeContext();
  const padFixture = seedActiveMatch(padError);
  writeU8(padError, padFixture.pad + 0x41, 1);
  assert.equal(padError.inspectMeleeGameState().controlsEnabled, false);
  assert.equal(padError.inspectMeleeGameState().activeMatch, false);

  const nonfinite = makeContext();
  const nonfiniteFixture = seedActiveMatch(nonfinite);
  writeF32(nonfinite, nonfiniteFixture.fighter + 0xb0, Number.NaN);
  assert.equal(nonfinite.inspectMeleeGameState().fighter.valid, false);
  assert.equal(nonfinite.inspectMeleeGameState().activeMatch, false);
});

test("guest diagnostics dispatch Melee only through exact retail identity", () => {
  const melee = makeContext();
  seedActiveMatch(melee);
  assert.equal(melee.inspectGuestGameState().activeMatch, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GMBE8P", 0).inspectGuestGameState())),
    { game: "smb" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GLME01", 0).inspectGuestGameState())),
    { game: "luigi" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZLE01", 0).inspectGuestGameState())),
    { game: "wind" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZWE01", 0).inspectGuestGameState())),
    { game: "wario" },
  );
  assert.equal(makeContext("GALE01", 1).inspectGuestGameState(), null);
  assert.match(
    source,
    /function sampleGuestGameplayInput\(sampleCycle\) \{\s+sampleLuigisMansionGameplayInput\(sampleCycle\);\s+sampleWindWakerGameplayInput\(sampleCycle\);\s+sampleMeleeGameplayInput\(sampleCycle\);\s+sampleWarioWareGameplayInput\(sampleCycle\);/,
  );
});
