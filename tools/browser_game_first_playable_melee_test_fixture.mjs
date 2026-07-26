// SPDX-License-Identifier: GPL-3.0-only

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

const ROUTING = 0x80479d30;
const SCENE_INFO = 0x803dd9dc;
const MATCH = 0x8046b6a0;
const SLOT = 0x80453080;
const SLOT_SIZE = 0xe90;
const GOBJ = 0x80400000;
const FIGHTER = 0x80410000;
const PAD = 0x804c21cc;

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function position(x) {
  return { x, y: 20, z: 0 };
}

function opponent(slot, state, slotType) {
  const address = SLOT + slot * SLOT_SIZE;
  return {
    slot,
    address: hex32(address),
    stateAddress: hex32(address),
    state,
    slotTypeAddress: hex32(address + 8),
    slotType,
    active: state === 2 && (slotType === 0 || slotType === 1),
  };
}

function fighterInput(address) {
  return {
    leftStickXAddress: hex32(address + 0x620),
    leftStickX: 0,
    leftStickYAddress: hex32(address + 0x624),
    leftStickY: 0,
    previousLeftStickXAddress: hex32(address + 0x628),
    previousLeftStickX: 0,
    previousLeftStickYAddress: hex32(address + 0x62c),
    previousLeftStickY: 0,
    heldInputsAddress: hex32(address + 0x65c),
    heldInputs: 0,
    pressedInputsAddress: hex32(address + 0x668),
    pressedInputs: 0,
    releasedInputsAddress: hex32(address + 0x66c),
    releasedInputs: 0,
  };
}

function meleeGuestGame({
  currentPosition,
  frameCount,
  joystickDirectionCount,
  lastActiveGameplayInput = null,
  motionId,
  positionDeltaX = 0,
  previousPosition = currentPosition,
  selfVelocityX = 0,
  subColor = 0,
}) {
  return {
    routing: {
      address: hex32(ROUTING),
      currentModeAddress: hex32(ROUTING),
      currentMode: 2,
      currentSceneIndexAddress: hex32(ROUTING + 3),
      currentSceneIndex: 2,
      pendingAddress: hex32(ROUTING + 0x0c),
      pending: 0,
      currentSceneInfoPointerAddress: "0x804d6720",
      currentSceneInfo: hex32(SCENE_INFO),
      expectedSceneInfo: hex32(SCENE_INFO),
      currentSceneClassAddress: hex32(SCENE_INFO),
      currentSceneClass: 2,
      currentSceneLoadDataAddress: hex32(SCENE_INFO + 4),
      currentSceneLoadData: "0x80480530",
      currentSceneLeaveDataAddress: hex32(SCENE_INFO + 8),
      currentSceneLeaveData: "0x80479d98",
      exactSceneInfo: true,
      versusMatchScene: true,
    },
    match: {
      address: hex32(MATCH),
      stateAddress: hex32(MATCH),
      state: 0,
      pauseTimerAddress: hex32(MATCH + 2),
      pauseTimer: 0,
      unpauseTimerAddress: hex32(MATCH + 4),
      unpauseTimer: 0,
      hudEnabledAddress: hex32(MATCH + 5),
      hudEnabled: 1,
      terminateMatchAddress: hex32(MATCH + 6),
      terminateMatch: 0,
      singlePlayerAddress: hex32(MATCH + 7),
      singlePlayer: 0,
      matchResultAddress: hex32(MATCH + 8),
      matchResult: 0,
      matchOverAddress: hex32(MATCH + 0x0e),
      matchOver: 0,
      frameCountAddress: hex32(MATCH + 0x24),
      frameCount,
      playerMatchSlotTypeAddress: hex32(MATCH + 0x3a),
      playerMatchSlotType: 0,
      playerRespawnTimerAddress: hex32(MATCH + 0x42),
      playerRespawnTimer: 0,
      pauseBitsAddress: "0x80479d68",
      pauseBits: 0,
      inProgress: true,
    },
    playerSlot: {
      address: hex32(SLOT),
      size: SLOT_SIZE,
      stateAddress: hex32(SLOT),
      state: 2,
      characterAddress: hex32(SLOT + 4),
      character: 8,
      slotTypeAddress: hex32(SLOT + 8),
      slotType: 0,
      transformedIndexAddress: hex32(SLOT + 0x0c),
      transformedIndex: 0,
      subColorAddress: hex32(SLOT + 0x46),
      subColor,
      playerIdAddress: hex32(SLOT + 0x48),
      playerId: 0,
      stocksAddress: hex32(SLOT + 0x8e),
      stocks: 4,
      joystickDirectionCountAddress: hex32(SLOT + 0xa0),
      joystickDirectionCount,
      playable: true,
    },
    opponents: [
      opponent(1, 2, 1),
      opponent(2, 0, 3),
      opponent(3, 0, 3),
    ],
    hasOpponent: true,
    fighterLookup: {
      entityPointerAddress: hex32(SLOT + 0xb0),
      entity: hex32(GOBJ),
      classifierAddress: hex32(GOBJ),
      classifier: 4,
      processLinkAddress: hex32(GOBJ + 2),
      processLink: 8,
      processPriorityAddress: hex32(GOBJ + 4),
      processPriority: 0,
      userDataKindAddress: hex32(GOBJ + 7),
      userDataKind: 4,
      fighterPointerAddress: hex32(GOBJ + 0x2c),
      fighter: hex32(FIGHTER),
    },
    fighter: {
      address: hex32(FIGHTER),
      size: 0x23ec,
      gobjAddress: hex32(FIGHTER),
      gobj: hex32(GOBJ),
      kindAddress: hex32(FIGHTER + 4),
      kind: 0,
      playerIdAddress: hex32(FIGHTER + 0x0c),
      playerId: 0,
      motionIdAddress: hex32(FIGHTER + 0x10),
      motionId,
      aliveMotion: true,
      facingDirectionAddress: hex32(FIGHTER + 0x2c),
      facingDirection: 1,
      positionAddress: hex32(FIGHTER + 0xb0),
      position: { ...currentPosition },
      previousPositionAddress: hex32(FIGHTER + 0xbc),
      previousPosition: { ...previousPosition },
      groundOrAirAddress: hex32(FIGHTER + 0xe0),
      groundOrAir: 0,
      selfVelocityXAddress: hex32(FIGHTER + 0x80),
      selfVelocityX,
      positionDeltaXAddress: hex32(FIGHTER + 0xc8),
      positionDeltaX,
      padPlayerIdAddress: hex32(FIGHTER + 0x618),
      padPlayerId: 0,
      subColorAddress: hex32(FIGHTER + 0x61a),
      subColor,
      input: fighterInput(FIGHTER),
      valid: true,
    },
    pad: {
      address: hex32(PAD),
      buttonsAddress: hex32(PAD),
      buttons: 0,
      triggerAddress: hex32(PAD + 8),
      trigger: 0,
      rawStickXAddress: hex32(PAD + 0x18),
      rawStickX: 0,
      rawStickYAddress: hex32(PAD + 0x19),
      rawStickY: 0,
      normalizedStickXAddress: hex32(PAD + 0x20),
      normalizedStickX: 0,
      normalizedStickYAddress: hex32(PAD + 0x24),
      normalizedStickY: 0,
      errorAddress: hex32(PAD + 0x41),
      error: 0,
    },
    controlsEnabled: true,
    neutralInput: true,
    activeMatch: true,
    lastActiveGameplayInput,
  };
}

export function makeMeleeFirstPlayableReportPair(game) {
  const reports = makeGameFirstPlayableReportPair(game, "left");
  const publication = reports.postReport.controller.lastActiveHostPublication;
  const baselinePosition = position(10);
  const receiptPosition = position(9);
  const postPosition = position(8);
  reports.preReport.guestGame = meleeGuestGame({
    currentPosition: baselinePosition,
    frameCount: 120,
    joystickDirectionCount: 12,
    motionId: 14,
  });
  reports.postReport.guestGame = meleeGuestGame({
    currentPosition: postPosition,
    frameCount: 122,
    joystickDirectionCount: 13,
    motionId: 15,
    positionDeltaX: -0.5,
    previousPosition: position(8.5),
    selfVelocityX: -1,
    lastActiveGameplayInput: {
      cycle: publication.observedCycle + 900,
      controllerAppliedSequence: publication.sequence,
      hostPublication: { ...publication },
      matchFrame: 121,
      transformedIndex: 0,
      joystickDirectionCount: 13,
      entity: hex32(GOBJ),
      fighter: hex32(FIGHTER),
      motionId: 18,
      position: receiptPosition,
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
  });
  return reports;
}
