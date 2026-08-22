// SPDX-License-Identifier: GPL-3.0-only

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

const MANAGER = 0x8045b208;
const PLAYER = 0x8046c9e8;
const WORLD = 0x80410000;
const CAMERA_MANAGER = 0x80411000;
const FIRST_PERSON_CAMERA = 0x80412000;
const PLAYER_STATE_REF_DATA = 0x80413000;
const PLAYER_STATE = 0x80414000;
const CAMERA_ID = 0x1234;
const WORLD_ASSET_ID = 0x158efe17;

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function vector(x, y, z) {
  return { x, y, z };
}

function orientation(angle) {
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  return {
    right: vector(-sine, cosine, 0),
    forward: vector(-cosine, -sine, 0),
    up: vector(0, 0, 1),
  };
}

function currentInput({
  buttons2 = 0,
  buttons3 = 0,
  leftX = 0,
} = {}) {
  const neutral = leftX === 0 && buttons2 === 0 && buttons3 === 0;
  const hostLeftRetained = leftX >= -1
    && leftX <= -0.5
    && buttons2 === 0x20
    && (buttons3 === 0 || buttons3 === 0x02);
  return {
    address: hex32(MANAGER + 0xb54),
    time: 1 / 60,
    controllerIndex: 0,
    leftX,
    leftY: 0,
    rightX: 0,
    rightY: 0,
    leftTrigger: 0,
    rightTrigger: 0,
    analogEdgeLeftX: 0,
    analogEdgeLeftY: 0,
    analogEdgeRightX: 0,
    analogEdgeRightY: 0,
    previousLeftTrigger: 0,
    previousRightTrigger: 0,
    buttons1: 0,
    buttons2,
    buttons3,
    valid: true,
    neutral,
    hostLeftRetained,
  };
}

function metroidPrimeGuestGame({
  angle,
  inputFrame,
  lastActiveGameplayInput = null,
  updateFrame,
}) {
  const transform = orientation(angle);
  const position = vector(10, 20, 30);
  const velocity = vector(0, 0, 0);
  const angularVelocity = vector(0, 0, 0);
  const torque = vector(0, 0, 0);
  const input = currentInput();
  return {
    identity: {
      headerAddress: "0x80000000",
      gameCode: "0x474d3845",
      makerCode: 0x3031,
      discNumber: 0,
      revision: 2,
      exact: true,
    },
    manager: {
      address: hex32(MANAGER),
      mapped: true,
      playerPointerAddress: hex32(MANAGER + 0x84c),
      player: hex32(PLAYER),
      worldPointerAddress: hex32(MANAGER + 0x850),
      world: hex32(WORLD),
      cameraManagerPointerAddress: hex32(MANAGER + 0x870),
      cameraManager: hex32(CAMERA_MANAGER),
      playerStateRefDataPointerAddress: hex32(MANAGER + 0x8b8),
      nextAreaAddress: hex32(MANAGER + 0x8cc),
      nextArea: 0,
      inputFrameAddress: hex32(MANAGER + 0x8d4),
      inputFrame,
      updateFrameAddress: hex32(MANAGER + 0x8d8),
      updateFrame,
      gameStateAddress: hex32(MANAGER + 0x904),
      gameState: 0,
      initPhaseAddress: hex32(MANAGER + 0xb3c),
      initPhase: 2,
    },
    world: {
      address: hex32(WORLD),
      assetIdAddress: hex32(WORLD + 8),
      assetId: WORLD_ASSET_ID,
      areaAddress: hex32(WORLD + 0x68),
      area: 0,
      firstArea: true,
    },
    camera: {
      manager: hex32(CAMERA_MANAGER),
      currentIdAddress: hex32(CAMERA_MANAGER),
      currentId: CAMERA_ID,
      cinematicCountAddress: hex32(CAMERA_MANAGER + 8),
      cinematicCount: 0,
      firstPersonPointerAddress: hex32(CAMERA_MANAGER + 0x88),
      firstPerson: hex32(FIRST_PERSON_CAMERA),
      firstPersonId: CAMERA_ID,
      flagsAddress: hex32(FIRST_PERSON_CAMERA + 0x180),
      flags: 0,
      disablesInput: false,
      firstPersonActive: true,
      inputEnabled: true,
    },
    playerState: {
      refData: hex32(PLAYER_STATE_REF_DATA),
      refCount: 1,
      address: hex32(PLAYER_STATE),
      flagsAddress: hex32(PLAYER_STATE),
      flags: 0x80,
      alive: true,
    },
    player: {
      expectedAddress: hex32(PLAYER),
      address: hex32(PLAYER),
      valid: true,
      areaAddress: hex32(PLAYER + 4),
      area: 0,
      uniqueIdAddress: hex32(PLAYER + 8),
      uniqueId: 1,
      entityFlagsAddress: hex32(PLAYER + 0x30),
      entityFlags: 0x80,
      entityActive: true,
      transform: {
        address: hex32(PLAYER + 0x34),
        rightAddresses: [
          hex32(PLAYER + 0x34),
          hex32(PLAYER + 0x44),
          hex32(PLAYER + 0x54),
        ],
        right: transform.right,
        forwardAddresses: [
          hex32(PLAYER + 0x38),
          hex32(PLAYER + 0x48),
          hex32(PLAYER + 0x58),
        ],
        forward: transform.forward,
        upAddresses: [
          hex32(PLAYER + 0x3c),
          hex32(PLAYER + 0x4c),
          hex32(PLAYER + 0x5c),
        ],
        up: transform.up,
        positionAddresses: [
          hex32(PLAYER + 0x40),
          hex32(PLAYER + 0x50),
          hex32(PLAYER + 0x60),
        ],
        position,
        orthonormal: true,
      },
      velocityAddress: hex32(PLAYER + 0x148),
      velocity,
      angularVelocityAddress: hex32(PLAYER + 0x154),
      angularVelocity,
      torqueAddress: hex32(PLAYER + 0x184),
      torque,
      movementStateAddress: hex32(PLAYER + 0x268),
      movementState: 0,
      surfaceRestraintAddress: hex32(PLAYER + 0x2bc),
      surfaceRestraint: 0,
      cameraStateAddress: hex32(PLAYER + 0x304),
      cameraState: 0,
      morphStateAddress: hex32(PLAYER + 0x308),
      morphState: 0,
      orbitStateAddress: hex32(PLAYER + 0x314),
      orbitState: 0,
      frozenTimeoutAddress: hex32(PLAYER + 0x760),
      frozenTimeout: 0,
      controlsFrozenAddress: hex32(PLAYER + 0x770),
      controlsFrozen: 0,
      inputFlagsAddress: hex32(PLAYER + 0x9d6),
      inputFlags: 0,
      disablesInput: false,
      deathTimeAddress: hex32(PLAYER + 0xa04),
      deathTime: 0,
    },
    input,
    turn: {
      angularVelocityAlongUp: 0,
      torqueAlongUp: 0,
    },
    lifecycleRunning: true,
    controlsEnabled: true,
    controllableFrigate: true,
    guestConsumedHostLeft: false,
    lastActiveGameplayInput,
  };
}

export function makeMetroidPrimeFirstPlayableReportPair(
  game,
  leftX = -0.75,
) {
  const reports = makeGameFirstPlayableReportPair(game, "left");
  const publication = reports.postReport.controller.lastActiveHostPublication;
  const latchTransform = orientation(0.004);

  reports.preReport.guestGame = metroidPrimeGuestGame({
    angle: 0,
    inputFrame: 100,
    updateFrame: 200,
  });
  reports.postReport.guestGame = metroidPrimeGuestGame({
    angle: 0.01,
    inputFrame: 103,
    updateFrame: 203,
    lastActiveGameplayInput: {
      cycle: publication.observedCycle + 900,
      controllerAppliedSequence: publication.sequence,
      hostPublication: { ...publication },
      manager: hex32(MANAGER),
      player: hex32(PLAYER),
      world: hex32(WORLD),
      worldAssetId: WORLD_ASSET_ID,
      area: 0,
      inputFrame: 101,
      updateFrame: 201,
      position: vector(10, 20, 30),
      forward: latchTransform.forward,
      up: latchTransform.up,
      angularVelocity: vector(0, 0, 0),
      torque: vector(0, 0, 0),
      input: {
        time: 1 / 60,
        controllerIndex: 0,
        leftX,
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
        manager: hex32(CAMERA_MANAGER),
        firstPerson: hex32(FIRST_PERSON_CAMERA),
        currentId: CAMERA_ID,
        firstPersonId: CAMERA_ID,
        cinematicCount: 0,
        flags: 0,
      },
    },
  });
  return reports;
}
