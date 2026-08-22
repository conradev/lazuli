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

function makeContext(identifier = "GM8E01", version = 2) {
  const memory = new ArrayBuffer(0x1800000);
  const view = new DataView(memory);
  const context = {
    Math,
    Number,
    boot: { identifier, version },
    controllerAppliedSequence: 0,
    metroidPrimeLastActiveGameplayInput: null,
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
    inspectMeleeGameState() {
      return identifier === "GALE01" ? { game: "melee" } : null;
    },
    inspectFzeroGameState() {
      return identifier === "GFZE01" ? { game: "fzero" } : null;
    },
    inspectWarioWareGameState() {
      return identifier === "GZWE01" ? { game: "wario" } : null;
    },
    sampleLuigisMansionGameplayInput() {},
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
    "guestS32",
    "guestF32",
    "hex32",
    "metroidPrimeMappedPointer",
    "inspectMetroidPrimeVector",
    "inspectMetroidPrimeStridedVector",
    "metroidPrimeFiniteVector",
    "metroidPrimeDot",
    "inspectMetroidPrimeGameState",
    "sampleMetroidPrimeGameplayInput",
    "inspectGuestGameState",
    "sampleGuestGameplayInput",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.metroid_prime.js",
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

function writeF32(context, address, value) {
  context.view.setFloat32(address & 0x1fffffff, value, false);
}

function writeVector(context, address, values) {
  values.forEach((value, index) => writeF32(context, address + index * 4, value));
}

function writePlayerTransform(context, player, {
  right = [0, 1, 0],
  forward = [-1, 0, 0],
  up = [0, 0, 1],
  position = [10, 20, 30],
} = {}) {
  const columns = [right, forward, up, position];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      writeF32(
        context,
        player + 0x34 + (row * 4 + column) * 4,
        columns[column][row],
      );
    }
  }
}

function seedControllableFrigate(context) {
  const manager = 0x8045b208;
  const player = 0x8046c9e8;
  const world = 0x80410000;
  const cameraManager = 0x80411000;
  const firstPersonCamera = 0x80412000;
  const playerStateRefData = 0x80413000;
  const playerState = 0x80414000;
  const finalInput = manager + 0xb54;

  writeU32(context, 0x80000000, 0x474d3845);
  writeU16(context, 0x80000004, 0x3031);
  writeU8(context, 0x80000006, 0);
  writeU8(context, 0x80000007, 2);

  writeU32(context, manager + 0x84c, player);
  writeU32(context, manager + 0x850, world);
  writeU32(context, manager + 0x870, cameraManager);
  writeU32(context, manager + 0x8b8, playerStateRefData);
  writeS32(context, manager + 0x8cc, 0);
  writeU32(context, manager + 0x8d4, 100);
  writeU32(context, manager + 0x8d8, 200);
  writeU32(context, manager + 0x904, 0);
  writeU32(context, manager + 0xb3c, 2);

  writeU32(context, world + 8, 0x158efe17);
  writeS32(context, world + 0x68, 0);

  writeU16(context, cameraManager, 0x1234);
  writeU32(context, cameraManager + 8, 0);
  writeU32(context, cameraManager + 0x88, firstPersonCamera);
  writeU16(context, firstPersonCamera + 8, 0x1234);
  writeU8(context, firstPersonCamera + 0x180, 0);

  writeU32(context, playerStateRefData, playerState);
  writeU32(context, playerStateRefData + 4, 1);
  writeU8(context, playerState, 0x80);

  writeS32(context, player + 4, 0);
  writeU16(context, player + 8, 1);
  writeU8(context, player + 0x30, 0x80);
  writePlayerTransform(context, player);
  writeVector(context, player + 0x148, [0, 0, 0]);
  writeVector(context, player + 0x154, [0, 0, 0]);
  writeVector(context, player + 0x184, [0, 0, 0]);
  writeU32(context, player + 0x268, 0);
  writeU32(context, player + 0x2bc, 0);
  writeU32(context, player + 0x304, 0);
  writeU32(context, player + 0x308, 0);
  writeU32(context, player + 0x314, 0);
  writeF32(context, player + 0x760, 0);
  writeU8(context, player + 0x770, 0);
  writeU8(context, player + 0x9d6, 0);
  writeF32(context, player + 0xa04, 0);

  writeF32(context, finalInput, 1 / 60);
  writeU32(context, finalInput + 4, 0);
  for (const offset of [8, 0xc, 0x10, 0x14, 0x18, 0x1c, 0x24, 0x28]) {
    writeF32(context, finalInput + offset, 0);
  }
  for (const offset of [0x20, 0x21, 0x22, 0x23, 0x2c, 0x2d, 0x2e]) {
    writeU8(context, finalInput + offset, 0);
  }

  return {
    cameraManager,
    finalInput,
    firstPersonCamera,
    manager,
    player,
    playerState,
    playerStateRefData,
    world,
  };
}

function applyRetainedHostLeft(context, fixture, {
  leftX = -0.75,
  buttons2 = 0x20,
  buttons3 = 0x02,
  angularVelocity = [0, 0, 0],
  torque = [0, 0, 0],
} = {}) {
  writeF32(context, fixture.finalInput + 8, leftX);
  writeU8(context, fixture.finalInput + 0x2c, 0);
  writeU8(context, fixture.finalInput + 0x2d, buttons2);
  writeU8(context, fixture.finalInput + 0x2e, buttons3);
  writeVector(context, fixture.player + 0x154, angularVelocity);
  writeVector(context, fixture.player + 0x184, torque);
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

test("Metroid Prime diagnostics expose exact GM8E01 Rev2 first-playable state", () => {
  const context = makeContext();
  seedControllableFrigate(context);
  const state = JSON.parse(JSON.stringify(context.inspectMetroidPrimeGameState()));

  assert.deepEqual(state.identity, {
    headerAddress: "0x80000000",
    gameCode: "0x474d3845",
    makerCode: 0x3031,
    discNumber: 0,
    revision: 2,
    exact: true,
  });
  assert.equal(state.manager.address, "0x8045b208");
  assert.equal(state.manager.playerPointerAddress, "0x8045ba54");
  assert.equal(state.manager.player, "0x8046c9e8");
  assert.equal(state.manager.worldPointerAddress, "0x8045ba58");
  assert.equal(state.manager.cameraManagerPointerAddress, "0x8045ba78");
  assert.equal(state.manager.playerStateRefDataPointerAddress, "0x8045bac0");
  assert.equal(state.manager.nextAreaAddress, "0x8045bad4");
  assert.equal(state.manager.inputFrameAddress, "0x8045badc");
  assert.equal(state.manager.updateFrameAddress, "0x8045bae0");
  assert.equal(state.manager.gameStateAddress, "0x8045bb0c");
  assert.equal(state.manager.initPhaseAddress, "0x8045bd44");
  assert.equal(state.world.assetIdAddress, "0x80410008");
  assert.equal(state.world.assetId, 0x158efe17);
  assert.equal(state.world.areaAddress, "0x80410068");
  assert.equal(state.world.area, 0);
  assert.equal(state.world.firstArea, true);

  assert.deepEqual(state.camera, {
    manager: "0x80411000",
    currentIdAddress: "0x80411000",
    currentId: 0x1234,
    cinematicCountAddress: "0x80411008",
    cinematicCount: 0,
    firstPersonPointerAddress: "0x80411088",
    firstPerson: "0x80412000",
    firstPersonId: 0x1234,
    flagsAddress: "0x80412180",
    flags: 0,
    disablesInput: false,
    firstPersonActive: true,
    inputEnabled: true,
  });
  assert.equal(state.playerState.refData, "0x80413000");
  assert.equal(state.playerState.refCount, 1);
  assert.equal(state.playerState.address, "0x80414000");
  assert.equal(state.playerState.flags, 0x80);
  assert.equal(state.playerState.alive, true);

  assert.equal(state.player.address, "0x8046c9e8");
  assert.equal(state.player.entityFlagsAddress, "0x8046ca18");
  assert.equal(state.player.entityActive, true);
  assert.deepEqual(state.player.transform.rightAddresses, [
    "0x8046ca1c",
    "0x8046ca2c",
    "0x8046ca3c",
  ]);
  assert.deepEqual(state.player.transform.forwardAddresses, [
    "0x8046ca20",
    "0x8046ca30",
    "0x8046ca40",
  ]);
  assert.deepEqual(state.player.transform.upAddresses, [
    "0x8046ca24",
    "0x8046ca34",
    "0x8046ca44",
  ]);
  assert.deepEqual(state.player.transform.positionAddresses, [
    "0x8046ca28",
    "0x8046ca38",
    "0x8046ca48",
  ]);
  assert.deepEqual(state.player.transform.right, { x: 0, y: 1, z: 0 });
  assert.deepEqual(state.player.transform.forward, { x: -1, y: 0, z: 0 });
  assert.deepEqual(state.player.transform.up, { x: 0, y: 0, z: 1 });
  assert.deepEqual(state.player.transform.position, { x: 10, y: 20, z: 30 });
  assert.equal(state.player.transform.orthonormal, true);
  assert.equal(state.player.velocityAddress, "0x8046cb30");
  assert.equal(state.player.angularVelocityAddress, "0x8046cb3c");
  assert.equal(state.player.torqueAddress, "0x8046cb6c");
  assert.equal(state.player.movementStateAddress, "0x8046cc50");
  assert.equal(state.player.surfaceRestraintAddress, "0x8046cca4");
  assert.equal(state.player.cameraStateAddress, "0x8046ccec");
  assert.equal(state.player.morphStateAddress, "0x8046ccf0");
  assert.equal(state.player.orbitStateAddress, "0x8046ccfc");
  assert.equal(state.player.frozenTimeoutAddress, "0x8046d148");
  assert.equal(state.player.controlsFrozenAddress, "0x8046d158");
  assert.equal(state.player.inputFlagsAddress, "0x8046d3be");
  assert.equal(state.player.deathTimeAddress, "0x8046d3ec");

  assert.equal(state.input.address, "0x8045bd5c");
  assert.equal(state.input.valid, true);
  assert.equal(state.input.neutral, true);
  assert.equal(state.input.hostLeftRetained, false);
  assert.equal(state.lifecycleRunning, true);
  assert.equal(state.controlsEnabled, true);
  assert.equal(state.controllableFrigate, true);
  assert.equal(state.guestConsumedHostLeft, false);
  assert.equal(state.lastActiveGameplayInput, null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.inspectGuestGameState())),
    state,
  );
});

test("Metroid Prime exact identity, lifecycle, camera, transform, and input gates fail closed", () => {
  assert.equal(makeContext("GM8E01", 1).inspectMetroidPrimeGameState(), null);
  assert.equal(makeContext("GM8J01", 2).inspectMetroidPrimeGameState(), null);

  const cases = [
    ["disc-header game code", (context) => writeU32(context, 0x80000000, 0)],
    ["disc-header maker", (context) => writeU16(context, 0x80000004, 0)],
    ["disc-header number", (context) => writeU8(context, 0x80000006, 1)],
    ["disc-header revision", (context) => writeU8(context, 0x80000007, 1)],
    [
      "fixed player relation",
      (context, fixture) => writeU32(context, fixture.manager + 0x84c, 0x8046d000),
    ],
    [
      "default world",
      (context, fixture) => writeU32(context, fixture.world + 8, 0xdeadbeef),
    ],
    [
      "world area",
      (context, fixture) => writeS32(context, fixture.world + 0x68, 1),
    ],
    [
      "manager area",
      (context, fixture) => writeS32(context, fixture.manager + 0x8cc, 1),
    ],
    [
      "player area",
      (context, fixture) => writeS32(context, fixture.player + 4, 1),
    ],
    [
      "initialization phase",
      (context, fixture) => writeU32(context, fixture.manager + 0xb3c, 1),
    ],
    [
      "running state",
      (context, fixture) => writeU32(context, fixture.manager + 0x904, 1),
    ],
    [
      "player-state alive",
      (context, fixture) => writeU8(context, fixture.playerState, 0),
    ],
    [
      "player-state reference",
      (context, fixture) => writeU32(context, fixture.playerStateRefData + 4, 0),
    ],
    [
      "negative player-state reference",
      (context, fixture) =>
        writeU32(context, fixture.playerStateRefData + 4, 0xffffffff),
    ],
    [
      "entity active",
      (context, fixture) => writeU8(context, fixture.player + 0x30, 0),
    ],
    [
      "live unique id",
      (context, fixture) => writeU16(context, fixture.player + 8, 0xffff),
    ],
    [
      "death timer",
      (context, fixture) => writeF32(context, fixture.player + 0xa04, 0.1),
    ],
    [
      "cinematic camera count",
      (context, fixture) => writeU32(context, fixture.cameraManager + 8, 1),
    ],
    [
      "first-person camera id",
      (context, fixture) => writeU16(context, fixture.cameraManager, 0x1235),
    ],
    [
      "invalid current and first-person camera ids",
      (context, fixture) => {
        writeU16(context, fixture.cameraManager, 0xffff);
        writeU16(context, fixture.firstPersonCamera + 8, 0xffff);
      },
    ],
    [
      "camera input disable",
      (context, fixture) => writeU8(context, fixture.firstPersonCamera + 0x180, 0x40),
    ],
    [
      "player camera state",
      (context, fixture) => writeU32(context, fixture.player + 0x304, 1),
    ],
    [
      "morph state",
      (context, fixture) => writeU32(context, fixture.player + 0x308, 1),
    ],
    [
      "orbit state",
      (context, fixture) => writeU32(context, fixture.player + 0x314, 1),
    ],
    [
      "frozen timeout",
      (context, fixture) => writeF32(context, fixture.player + 0x760, 0.1),
    ],
    [
      "landing control freeze",
      (context, fixture) => writeU8(context, fixture.player + 0x770, 1),
    ],
    [
      "player input disable",
      (context, fixture) => writeU8(context, fixture.player + 0x9d6, 0x04),
    ],
    [
      "movement enum",
      (context, fixture) => writeU32(context, fixture.player + 0x268, 5),
    ],
    [
      "surface enum",
      (context, fixture) => writeU32(context, fixture.player + 0x2bc, 8),
    ],
    [
      "row-major transform",
      (context, fixture) => writeF32(context, fixture.player + 0x48, 2),
    ],
    [
      "final-input time",
      (context, fixture) => writeF32(context, fixture.finalInput, 0),
    ],
    [
      "controller zero",
      (context, fixture) => writeU32(context, fixture.finalInput + 4, 1),
    ],
  ];
  for (const [label, mutate] of cases) {
    const context = makeContext();
    const fixture = seedControllableFrigate(context);
    mutate(context, fixture);
    const state = context.inspectMetroidPrimeGameState();
    assert.equal(state.controllableFrigate, false, label);
    assert.equal(state.guestConsumedHostLeft, false, label);
  }
});

test("Metroid Prime latches only the first exact applied host-left receipt", () => {
  const context = makeContext();
  const fixture = seedControllableFrigate(context);
  applyRetainedHostLeft(context, fixture);
  publishLeft(context);

  context.sampleGuestGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.metroidPrimeLastActiveGameplayInput)),
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
      manager: "0x8045b208",
      player: "0x8046c9e8",
      world: "0x80410000",
      worldAssetId: 0x158efe17,
      area: 0,
      inputFrame: 100,
      updateFrame: 200,
      position: { x: 10, y: 20, z: 30 },
      forward: { x: -1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      torque: { x: 0, y: 0, z: 0 },
      input: {
        time: context.view.getFloat32(
          fixture.finalInput & 0x1fffffff,
          false,
        ),
        controllerIndex: 0,
        leftX: -0.75,
        leftY: 0,
        rightX: 0,
        rightY: 0,
        leftTrigger: 0,
        rightTrigger: 0,
        buttons1: 0,
        buttons2: 0x20,
        buttons3: 0x02,
      },
      turn: {
        angularVelocityAlongUp: 0,
        torqueAlongUp: 0,
      },
      lifecycle: {
        gameState: 0,
        initPhase: 2,
        playerStateFlags: 0x80,
        entityFlags: 0x80,
        cameraState: 0,
        morphState: 0,
        orbitState: 0,
        frozenTimeout: 0,
        controlsFrozen: 0,
        playerInputFlags: 0,
        deathTime: 0,
      },
      camera: {
        manager: "0x80411000",
        firstPerson: "0x80412000",
        currentId: 0x1234,
        firstPersonId: 0x1234,
        cinematicCount: 0,
        flags: 0,
      },
    },
  );

  writePlayerTransform(context, fixture.player, {
    position: [99, 98, 97],
  });
  publishLeft(context, { sequence: 8, appliedSequence: 8 });
  context.sampleMetroidPrimeGameplayInput(140);
  assert.equal(context.metroidPrimeLastActiveGameplayInput.cycle, 120);
  assert.equal(
    context.metroidPrimeLastActiveGameplayInput.hostPublication.sequence,
    7,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.inspectMetroidPrimeGameState().lastActiveGameplayInput.position,
    )),
    { x: 10, y: 20, z: 30 },
  );
});

test("Metroid Prime receipt rejects unrelated publications and unconsumed input", () => {
  for (const [overrides, label] of [
    [{ buttons: 0x0003 }, "non-exact host left"],
    [{ sequence: 0, appliedSequence: 0 }, "nonpositive sequence"],
    [{ sequence: 8 }, "unapplied sequence"],
    [{ pollIndex: 0 }, "nonpositive poll index"],
    [{ scheduledCycle: -1 }, "negative scheduled cycle"],
    [{ observedCycle: -1 }, "negative observed cycle"],
    [{ scheduledCycle: 110, observedCycle: 105 }, "reversed publication"],
    [{ observedCycle: 121 }, "future publication"],
    [{ appliedSequence: 8 }, "applied sequence mismatch"],
  ]) {
    const context = makeContext();
    const fixture = seedControllableFrigate(context);
    applyRetainedHostLeft(context, fixture);
    publishLeft(context, overrides);
    context.sampleMetroidPrimeGameplayInput(120);
    assert.equal(context.metroidPrimeLastActiveGameplayInput, null, label);
  }

  for (const [mutate, label] of [
    [
      (context, fixture) =>
        applyRetainedHostLeft(context, fixture, { leftX: -0.49 }),
      "left axis below witness magnitude",
    ],
    [
      (context, fixture) => {
        applyRetainedHostLeft(context, fixture);
        writeF32(context, fixture.finalInput + 0xc, 0.2);
      },
      "cross-axis input",
    ],
    [
      (context, fixture) =>
        applyRetainedHostLeft(context, fixture, { buttons2: 0 }),
      "missing retained D-pad left",
    ],
    [
      (context, fixture) =>
        applyRetainedHostLeft(context, fixture, { buttons3: 0x04 }),
      "wrong retained press edge",
    ],
    [
      (context, fixture) => {
        applyRetainedHostLeft(context, fixture);
        writeU8(context, fixture.firstPersonCamera + 0x180, 0x40);
      },
      "camera-disabled input",
    ],
  ]) {
    const context = makeContext();
    const fixture = seedControllableFrigate(context);
    mutate(context, fixture);
    publishLeft(context);
    context.sampleMetroidPrimeGameplayInput(120);
    assert.equal(context.metroidPrimeLastActiveGameplayInput, null, label);
  }
});
