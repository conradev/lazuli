// SPDX-License-Identifier: GPL-3.0-only

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

const ROOT = 0x803a8000;
const MANAGER = 0x803a9000;
const HANDLE = 4;
const PLAYER = 0x80400000;
const PAD = 0x80410000;
const CONTROLLER = 0x80420000;
const ROOM_INFO = 0x02000102;

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function position(x) {
  return { x, y: 0, z: 20 };
}

function luigisMansionGuestGame({
  currentPosition,
  heading,
  lastActiveGameplayInput = null,
}) {
  return {
    sceneIdAddress: "0x804d80a0",
    sceneId: 2,
    mainGameScene: true,
    menuModeAddress: "0x804d80c4",
    menuMode: 0,
    menuClosed: true,
    openMapIdAddress: "0x804d80c8",
    openMapId: 2,
    mansionOpen: true,
    executingEventAddress: "0x804d8378",
    executingEvent: null,
    eventInactive: true,
    gameModeAddress: "0x804d8728",
    gameMode: 2,
    gameplayMode: true,
    currentRoomInfoAddress: "0x803a3cac",
    currentRoomInfo: hex32(ROOM_INFO),
    foyerActive: true,
    currentPlayerPositionAddress: "0x803a3ca0",
    currentPlayerPosition: { ...currentPosition },
    playerLookup: {
      rootPointerAddress: "0x804d8c60",
      root: hex32(ROOT),
      managerPointerAddress: hex32(ROOT + 8),
      manager: hex32(MANAGER),
      handleAddress: hex32(MANAGER + 0xe08),
      handle: HANDLE,
      objectSlotAddress: hex32(0x803d48a0 + HANDLE * 4),
    },
    player: {
      address: hex32(PLAYER),
      vtableAddress: hex32(PLAYER),
      vtable: "0x80359d48",
      valid: true,
      positionAddress: hex32(PLAYER + 0x44),
      position: { ...currentPosition },
      headingAddress: hex32(PLAYER + 0x88),
      heading,
      roomInfoAddress: hex32(PLAYER + 0xb4),
      roomInfo: hex32(ROOM_INFO),
      gamePadPointerAddress: hex32(PLAYER + 0x794),
      gamePad: hex32(PAD),
      controllerPointerAddress: hex32(PLAYER + 0x7d4),
      controller: hex32(CONTROLLER),
    },
    pad: {
      pointerAddress: "0x804d8078",
      address: hex32(PAD),
      heldAddress: hex32(PAD + 0x18),
      held: 0,
      triggerAddress: hex32(PAD + 0x1c),
      trigger: 0,
      mainStickXAddress: hex32(PAD + 0x44),
      mainStickX: 0,
      mainStickYAddress: hex32(PAD + 0x48),
      mainStickY: 0,
      mainStickValueAddress: hex32(PAD + 0x4c),
      mainStickValue: 0,
      portAddress: hex32(PAD + 0x74),
      port: 0,
      errorAddress: hex32(PAD + 0x76),
      error: 0,
    },
    controller: {
      address: hex32(CONTROLLER),
      inputSourceAddress: hex32(CONTROLLER + 0x1b0),
      inputSource: hex32(PAD),
      mainStickMagnitudeAddress: hex32(CONTROLLER + 0x1c0),
      mainStickMagnitude: 0,
      previousMainStickMagnitudeAddress: hex32(CONTROLLER + 0x1dc),
      previousMainStickMagnitude: 0,
    },
    controlsEnabled: true,
    neutralInput: true,
    controllableFoyer: true,
    lastActiveGameplayInput,
  };
}

export function makeLuigisMansionFirstPlayableReportPair(game) {
  const reports = makeGameFirstPlayableReportPair(game, "left");
  const publication = reports.postReport.controller.lastActiveHostPublication;
  const baselinePosition = position(10);
  const receiptPosition = position(11);
  const postPosition = position(12);
  reports.preReport.guestGame = luigisMansionGuestGame({
    currentPosition: baselinePosition,
    heading: 0x1000,
  });
  reports.postReport.guestGame = luigisMansionGuestGame({
    currentPosition: postPosition,
    heading: 0x1100,
    lastActiveGameplayInput: {
      cycle: publication.observedCycle + 900,
      controllerAppliedSequence: publication.sequence,
      hostPublication: { ...publication },
      player: hex32(PLAYER),
      roomInfo: hex32(ROOM_INFO),
      position: receiptPosition,
      heading: 0x1080,
      pad: {
        held: 0x01000001,
        trigger: 0x01000001,
        mainStickX: -1,
        mainStickY: 0,
        mainStickValue: 1,
      },
      controller: {
        inputSource: hex32(PAD),
        mainStickMagnitude: 1,
      },
    },
  });
  return reports;
}
