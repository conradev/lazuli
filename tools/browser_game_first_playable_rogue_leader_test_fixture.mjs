// SPDX-License-Identifier: GPL-3.0-only

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

const PLAYER_MANAGER = 0x7fdefe14;
const CRAFT = 0x7fd80000;
const CRAFT_CONFIG = 0x7fd90000;
const CRAFT_CONTROL = 0x7fdf0fa4;
const PRIMARY_VTABLE = 0x7fdc75b8;
const INTERFACE_VTABLE = 0x7fdc760c;
const SIMULATION_MANAGER = 0x7fdb0000;
const LEVEL_INDEX = 0;
const SUBLEVEL_INDEX = 0;
const CRAFT_HANDLE = 42;

const PRE_CYCLE = 100;
const PRE_BASELINE_CYCLE = 90;
const RETAINED_BASELINE_CYCLE = 110;
const PUBLICATION_SCHEDULED_CYCLE = 120;
const PUBLICATION_OBSERVED_CYCLE = 130;
const RECEIPT_CYCLE = 140;
const POST_CYCLE = 200;

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function vector(x, y, z) {
  return { x, y, z };
}

function transform() {
  return {
    orientation0: vector(1, 0, 0),
    orientation1: vector(0, 1, 0),
    orientation2: vector(0, 0, 1),
    position: vector(10, 20, 30),
    velocity: vector(1, 0, 0),
  };
}

function response(field460 = 0, field464 = 0) {
  return {
    field45c: 0,
    field460,
    field464,
  };
}

function baseline(cycle, controllerAppliedSequence) {
  return {
    cycle,
    controllerAppliedSequence,
    level: {
      index: LEVEL_INDEX,
      sublevelIndex: SUBLEVEL_INDEX,
    },
    craft: {
      address: hex32(CRAFT),
      handle: CRAFT_HANDLE,
      config: hex32(CRAFT_CONFIG),
      control: hex32(CRAFT_CONTROL),
      primaryVtable: hex32(PRIMARY_VTABLE),
      interfaceVtable: hex32(INTERFACE_VTABLE),
      state: 0,
    },
    response: response(),
  };
}

function currentInput() {
  return {
    port: 0,
    padAddress: "0x7fdee6e8",
    padMapped: true,
    buttons: 0,
    rawStickXAddress: "0x7fdee6ea",
    rawStickX: 0,
    rawStickYAddress: "0x7fdee6eb",
    rawStickY: 0,
    errorAddress: "0x7fdee6f2",
    error: 0,
    normalizedStickXAddress: "0x7fdee718",
    normalizedStickX: 0,
    expectedNormalizedStickX: 0,
    normalizedStickYAddress: "0x7fdee71c",
    normalizedStickY: 0,
    expectedNormalizedStickY: 0,
    globalStickXAddress: "0x7fde97e0",
    globalStickX: 0,
    globalStickYAddress: "0x7fde97e4",
    globalStickY: 0,
    valuesValid: true,
    rawNormalizationCoherent: true,
    globalAxesCoherent: true,
    shapedControlCoherent: true,
    pipelineCoherent: true,
    neutral: true,
    hostLeftRetained: false,
  };
}

function craft(field460 = 0, field464 = 0) {
  const currentTransform = transform();
  const xResponseActive = Math.abs(field460) > 0.0001
    || Math.abs(field464) > 0.0001;
  return {
    address: hex32(CRAFT),
    mapped: true,
    identity: {
      primaryVtableAddress: hex32(CRAFT + 0x80),
      primaryVtable: hex32(PRIMARY_VTABLE),
      interfaceVtableAddress: hex32(CRAFT + 0x1a0),
      interfaceVtable: hex32(INTERFACE_VTABLE),
      type: "x-wing",
      exact: true,
    },
    stateAddress: hex32(CRAFT + 0x370),
    state: 0,
    configPointerAddress: hex32(CRAFT + 0x37c),
    config: hex32(CRAFT_CONFIG),
    controlPointerAddress: hex32(CRAFT + 0x380),
    control: hex32(CRAFT_CONTROL),
    exactControl: true,
    controlInput: {
      stickXIndexAddress: hex32(CRAFT_CONTROL + 0x110),
      stickXIndex: 0,
      stickXAddress: hex32(CRAFT_CONTROL + 8),
      stickX: 0,
      stickYIndexAddress: hex32(CRAFT_CONTROL + 0x10c),
      stickYIndex: 1,
      stickYAddress: hex32(CRAFT_CONTROL + 0x0c),
      stickY: 0,
      exactMapping: true,
      valid: true,
      neutral: true,
      hostLeftRetained: false,
    },
    transform: {
      orientation0Address: hex32(CRAFT + 0x84),
      orientation0: currentTransform.orientation0,
      orientation1Address: hex32(CRAFT + 0x90),
      orientation1: currentTransform.orientation1,
      orientation2Address: hex32(CRAFT + 0x9c),
      orientation2: currentTransform.orientation2,
      positionAddress: hex32(CRAFT + 0xa8),
      position: currentTransform.position,
      velocityAddress: hex32(CRAFT + 0xb4),
      velocity: currentTransform.velocity,
      finite: true,
      orthonormal: true,
      determinant: 1,
      rightHanded: true,
    },
    response: {
      field45cAddress: hex32(CRAFT + 0x45c),
      field45c: 0,
      field460Address: hex32(CRAFT + 0x460),
      field460,
      field464Address: hex32(CRAFT + 0x464),
      field464,
      finite: true,
      xActive: xResponseActive,
    },
    valid: true,
  };
}

function rogueLeaderGuestGame({
  activeFlight,
  field460 = 0,
  field464 = 0,
  guestConsumedHostLeft,
  lastActiveGameplayInput,
  neutralControlBaseline,
  receiptLifetimeMatches,
}) {
  return {
    identity: {
      headerAddress: "0x80000000",
      gameCode: "0x47535745",
      makerCode: 0x3634,
      discNumber: 0,
      revision: 0,
      exact: true,
    },
    level: {
      indexAddress: "0x7fde822c",
      index: LEVEL_INDEX,
      sublevelIndexAddress: "0x7fde8230",
      sublevelIndex: SUBLEVEL_INDEX,
    },
    playerManager: {
      address: hex32(PLAYER_MANAGER),
      mapped: true,
      activeCraftPointerAddress: hex32(PLAYER_MANAGER),
      activeCraft: hex32(CRAFT),
      activeCraftHandleAddress: hex32(PLAYER_MANAGER + 4),
      activeCraftHandle: CRAFT_HANDLE,
      selectedCraftTypeAddress: hex32(PLAYER_MANAGER + 8),
      selectedCraftType: 0,
      stateAddress: hex32(PLAYER_MANAGER + 0x0c),
      state: 3,
    },
    simulation: {
      pointerAddress: "0x80095dc8",
      manager: hex32(SIMULATION_MANAGER),
      auxiliaryEnabledAddress: hex32(SIMULATION_MANAGER + 0xe04),
      auxiliaryEnabled: 1,
      auxiliaryModeAddress: hex32(SIMULATION_MANAGER + 0xa7c),
      auxiliaryMode: 1,
      auxiliaryControlMode: true,
    },
    input: currentInput(),
    craft: craft(field460, field464),
    controlsEnabled: true,
    liveXwingControlPath: true,
    normalCraftState: true,
    normalStateTransformValid: true,
    hostLeftCorrelated: false,
    receiptLifetimeMatches,
    activeFlight,
    guestConsumedHostLeft,
    neutralControlBaseline,
    lastActiveGameplayInput,
  };
}

function activeReceipt(publication) {
  const normalizedStickX = Math.fround(-100 / 72);
  const receiptResponse = response(0.25, -0.125);
  const neutralResponse = response();
  return {
    cycle: RECEIPT_CYCLE,
    controllerAppliedSequence: publication.sequence,
    hostPublication: { ...publication },
    level: {
      index: LEVEL_INDEX,
      sublevelIndex: SUBLEVEL_INDEX,
    },
    playerManager: hex32(PLAYER_MANAGER),
    craft: {
      address: hex32(CRAFT),
      handle: CRAFT_HANDLE,
      config: hex32(CRAFT_CONFIG),
      control: hex32(CRAFT_CONTROL),
      primaryVtable: hex32(PRIMARY_VTABLE),
      interfaceVtable: hex32(INTERFACE_VTABLE),
      type: "x-wing",
      state: 0,
    },
    transform: transform(),
    simulation: {
      manager: hex32(SIMULATION_MANAGER),
      auxiliaryEnabled: 1,
      auxiliaryMode: 1,
    },
    input: {
      port: 0,
      buttons: 0,
      rawStickX: -100,
      rawStickY: 0,
      normalizedStickX,
      normalizedStickY: 0,
      globalStickX: normalizedStickX,
      globalStickY: 0,
      stickX: -1,
      stickY: 0,
    },
    response: receiptResponse,
    neutralBaseline: {
      cycle: RETAINED_BASELINE_CYCLE,
      controllerAppliedSequence: publication.sequence - 1,
      response: neutralResponse,
    },
    responseTransition: {
      field460Delta: receiptResponse.field460 - neutralResponse.field460,
      field464Delta: receiptResponse.field464 - neutralResponse.field464,
      xChanged: true,
    },
  };
}

export function makeRogueLeaderFirstPlayableReportPair(game) {
  const reports = makeGameFirstPlayableReportPair(game, "left");
  reports.preReport.cycles = PRE_CYCLE;
  reports.postReport.cycles = POST_CYCLE;
  reports.preReport.mmioState.viInterruptModel.lastHostPresentationCycle = 90;
  reports.postReport.mmioState.viInterruptModel.lastHostPresentationCycle = 190;
  reports.postReport.headlessCapture.reuse.previous.cycles = PRE_CYCLE;
  reports.postReport.headlessCapture.reuse.action.extendCycles =
    POST_CYCLE - PRE_CYCLE;

  const publication = {
    ...reports.postReport.controller.lastActiveHostPublication,
    scheduledCycle: PUBLICATION_SCHEDULED_CYCLE,
    observedCycle: PUBLICATION_OBSERVED_CYCLE,
  };
  reports.postReport.controller.lastActiveHostPublication = publication;

  reports.preReport.guestGame = rogueLeaderGuestGame({
    activeFlight: false,
    guestConsumedHostLeft: false,
    lastActiveGameplayInput: null,
    neutralControlBaseline: baseline(
      PRE_BASELINE_CYCLE,
      reports.preReport.controller.appliedSequence,
    ),
    receiptLifetimeMatches: false,
  });

  reports.postReport.guestGame = rogueLeaderGuestGame({
    activeFlight: true,
    field460: 0.25,
    field464: -0.125,
    guestConsumedHostLeft: true,
    lastActiveGameplayInput: activeReceipt(publication),
    neutralControlBaseline: baseline(
      RETAINED_BASELINE_CYCLE,
      publication.sequence - 1,
    ),
    receiptLifetimeMatches: true,
  });
  return reports;
}
