// SPDX-License-Identifier: GPL-3.0-only

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

function warioWareGuestGame(lastActiveGameplayInput = null) {
  return {
    activeMicrogameId: 0x63,
    player0RepellionActive: true,
    repellionActive: true,
    cardDialogStateAddress: "0x802958ac",
    cardDialogState: 0,
    cardDialogChoiceAddress: "0x802958b4",
    cardDialogChoice: 0,
    noMemoryCardDialog: false,
    noCardFlowActive: false,
    runtime: "0x802ab420",
    gameplayButtonsAddress: "0x802f6580",
    gameplayButtons: 0,
    aActive: false,
    playerObjectPointerAddress: "0x802f6598",
    playerObject: "0x802a9000",
    playerResultAddress: "0x802f6818",
    playerResult: -1,
    playerObjectResultAddress: "0x802aa230",
    playerObjectResult: 0,
    lastActiveGameplayInput,
  };
}

export function makeWarioWareFirstPlayableReportPair(game) {
  const reports = makeGameFirstPlayableReportPair(game);
  const publication = reports.postReport.controller.lastActiveHostPublication;
  reports.preReport.guestGame = warioWareGuestGame();
  reports.postReport.guestGame = warioWareGuestGame({
    cycle: publication.observedCycle + 900,
    buttons: 0x0100,
    controllerAppliedSequence: publication.sequence,
    hostPublication: { ...publication },
    playerObject: "0x802a9000",
    playerObjectResult: 0,
  });
  return reports;
}
