// SPDX-License-Identifier: GPL-3.0-only

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

const PLAYER = 0x80400000;
const CONTROLLER = 0x803a4df0;
const STAGE = "sea";
const ROOM = 44;

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function position(x) {
  return { x, y: 0, z: 20 };
}

function windWakerGuestGame({
  currentPosition,
  heading,
  lastActiveGameplayInput = null,
}) {
  return {
    currentStage: {
      address: "0x803c9d3c",
      name: STAGE,
      roomAddress: "0x803c9d46",
      room: ROOM,
    },
    stayRoomAddress: "0x803f6a78",
    stayRoom: ROOM,
    outsetRoom: ROOM,
    stageActive: true,
    eventModeAddress: "0x803c9ea2",
    eventMode: 0,
    eventInactive: true,
    menuPauseAddress: "0x803f7097",
    menuPause: 0,
    pauseTimerAddress: "0x803f72b0",
    pauseTimer: 0,
    menuClosed: true,
    playerLookup: {
      playerPointerAddress: "0x803ca74c",
      player: hex32(PLAYER),
      linkPlayerPointerAddress: "0x803ca754",
      linkPlayer: hex32(PLAYER),
      pointersMatch: true,
    },
    player: {
      address: hex32(PLAYER),
      processNameAddress: hex32(PLAYER + 8),
      processName: 0x00a9,
      profileAddress: hex32(PLAYER + 0x10),
      profile: "0x8038fd8c",
      pauseFlagAddress: hex32(PLAYER + 0x0b),
      pauseFlag: 0,
      valid: true,
      positionAddress: hex32(PLAYER + 0x1f8),
      position: { ...currentPosition },
      headingAddress: hex32(PLAYER + 0x206),
      heading,
      roomAddress: hex32(PLAYER + 0x20a),
      room: ROOM,
    },
    pad: {
      address: hex32(CONTROLLER),
      holdAddress: hex32(CONTROLLER + 0x30),
      hold: 0,
      triggerAddress: hex32(CONTROLLER + 0x32),
      trigger: 0,
      mainStickXAddress: hex32(CONTROLLER),
      mainStickX: 0,
      mainStickYAddress: hex32(CONTROLLER + 4),
      mainStickY: 0,
      mainStickValueAddress: hex32(CONTROLLER + 8),
      mainStickValue: 0,
      errorAddress: hex32(CONTROLLER + 0x34),
      error: 0,
    },
    controlsEnabled: true,
    neutralInput: true,
    controllableOutset: true,
    lastActiveGameplayInput,
  };
}

export function makeWindWakerFirstPlayableReportPair(game) {
  const reports = makeGameFirstPlayableReportPair(game, "left");
  const publication = reports.postReport.controller.lastActiveHostPublication;
  const baselinePosition = position(10);
  const receiptPosition = position(9);
  const postPosition = position(8);
  reports.preReport.guestGame = windWakerGuestGame({
    currentPosition: baselinePosition,
    heading: 0x4000,
  });
  reports.postReport.guestGame = windWakerGuestGame({
    currentPosition: postPosition,
    heading: 0x4100,
    lastActiveGameplayInput: {
      cycle: publication.observedCycle + 900,
      controllerAppliedSequence: publication.sequence,
      hostPublication: { ...publication },
      player: hex32(PLAYER),
      stage: STAGE,
      room: ROOM,
      position: receiptPosition,
      heading: 0x4080,
      pad: {
        hold: 0x8000,
        trigger: 0x8000,
        mainStickX: -1,
        mainStickY: 0,
        mainStickValue: 1,
      },
    },
  });
  return reports;
}
