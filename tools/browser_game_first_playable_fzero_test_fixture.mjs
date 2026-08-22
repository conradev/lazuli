// SPDX-License-Identifier: GPL-3.0-only

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

const REFERENCE = 0x80010000;
const RACER_POINTER_OFFSET = 0x227878;
const RACER = 0x80400000;
const RACER_BLOCK_SIZE = 0x620;

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function vector(x, y = 20, z = 30) {
  return { x, y, z };
}

function input(steerX = 0) {
  return {
    steerYAddress: hex32(RACER + 0x1f4),
    steerY: 0,
    strafeAddress: hex32(RACER + 0x1f8),
    strafe: 0,
    steerXAddress: hex32(RACER + 0x1fc),
    steerX,
    acceleratorAddress: hex32(RACER + 0x200),
    accelerator: 1,
    brakeAddress: hex32(RACER + 0x204),
    brake: 0,
    duplicateSteerXAddress: hex32(RACER + 0x20c),
    duplicateSteerX: steerX,
    duplicateSteerMatches: true,
    documentedRanges: true,
  };
}

function lifecycle(frameCountSinceStartOrRestore) {
  return {
    restoreCountdownAddress: hex32(RACER + 0x214),
    restoreCountdown: 0,
    controllerSlotAddress: hex32(RACER + 0x474),
    controllerSlot: 0,
    frameCountSinceStartOrRestoreAddress: hex32(RACER + 0x47c),
    frameCountSinceStartOrRestore,
    crashBitAddress: hex32(RACER + 0x4b3),
    crashBit: 0,
    generalState2Address: hex32(RACER + 0x58f),
    generalState2: 0,
    restoreCompletionFlagAddress: hex32(RACER + 0x590),
    restoreCompletionFlag: 1,
    breakDownCountdownAddress: hex32(RACER + 0x593),
    breakDownCountdown: 0,
    postRestoreCountdownAddress: hex32(RACER + 0x5d8),
    postRestoreCountdown: 0,
    groundAirFlagAddress: hex32(RACER + 0x61c),
    groundAirFlag: 1,
  };
}

function fzeroGuestGame({
  currentPosition,
  frameCountSinceStartOrRestore,
  lastActiveGameplayInput = null,
  previousPosition,
  worldVelocity,
}) {
  return {
    reference: {
      pointerAddress: "0x800030c8",
      value: hex32(REFERENCE),
      rawValue: hex32(REFERENCE),
      mapped: true,
    },
    racerLookup: {
      pointerOffset: hex32(RACER_POINTER_OFFSET),
      pointerAddress: hex32(REFERENCE + RACER_POINTER_OFFSET),
      rawValue: hex32(RACER),
      racer: hex32(RACER),
      blockSize: RACER_BLOCK_SIZE,
    },
    raceAllocated: true,
    vehicle: {
      address: hex32(RACER),
      size: RACER_BLOCK_SIZE,
      generalStateAddress: hex32(RACER),
      generalState: 0,
      entrantIdAddress: hex32(RACER + 4),
      entrantId: 0,
      machineIdAddress: hex32(RACER + 6),
      machineId: 5,
      positionAddress: hex32(RACER + 0x7c),
      position: { ...currentPosition },
      previousPositionAddress: hex32(RACER + 0x88),
      previousPosition: { ...previousPosition },
      worldVelocityAddress: hex32(RACER + 0x94),
      worldVelocity: { ...worldVelocity },
      localVelocityAddress: hex32(RACER + 0xb8),
      localVelocity: vector(0, 0, 1),
      worldOrientationAddress: hex32(RACER + 0xec),
      worldOrientation: vector(0, 0, 1),
      speedKphAddress: hex32(RACER + 0x17c),
      speedKph: 1234.5,
      energyAddress: hex32(RACER + 0x184),
      energy: 500,
      crashToRestoreFrameCounterAddress: hex32(RACER + 0x194),
      crashToRestoreFrameCounter: 0,
      trackOrientationAddress: hex32(RACER + 0x1bc),
      trackOrientation: vector(0, 1, 0),
      checkpointAddress: hex32(RACER + 0x1cc),
      checkpoint: 4,
      checkpointFractionAddress: hex32(RACER + 0x1d0),
      checkpointFraction: 0.25,
      input: input(),
      lifecycle: lifecycle(frameCountSinceStartOrRestore),
      valid: true,
    },
    vehicleValid: true,
    activeRaceCandidate: true,
    livePlayerInputPath: true,
    defaultLivePlayerInputState: true,
    lastActiveGameplayInput,
  };
}

export function makeFzeroFirstPlayableReportPair(game, steerX = -0.75) {
  const reports = makeGameFirstPlayableReportPair(game, "left");
  const publication = reports.postReport.controller.lastActiveHostPublication;
  const baselinePosition = vector(10);
  const receiptPosition = vector(11);
  const postPosition = vector(12);

  reports.preReport.guestGame = fzeroGuestGame({
    currentPosition: baselinePosition,
    previousPosition: vector(9.5),
    worldVelocity: vector(1, 0, 0),
    frameCountSinceStartOrRestore: 300,
  });
  reports.postReport.guestGame = fzeroGuestGame({
    currentPosition: postPosition,
    previousPosition: vector(11.5),
    worldVelocity: vector(1, 0, 0),
    frameCountSinceStartOrRestore: 303,
    lastActiveGameplayInput: {
      cycle: publication.observedCycle + 900,
      controllerAppliedSequence: publication.sequence,
      hostPublication: { ...publication },
      reference: hex32(REFERENCE),
      racer: hex32(RACER),
      entrantId: 0,
      machineId: 5,
      generalState: 0,
      controllerSlot: 0,
      frameCountSinceStartOrRestore: 301,
      position: receiptPosition,
      worldVelocity: vector(1, 0, 0),
      input: {
        steerY: 0,
        strafe: 0,
        steerX,
        duplicateSteerX: steerX,
        accelerator: 1,
        brake: 0,
      },
      lifecycle: {
        crashBit: 0,
        restoreCountdown: 0,
        crashToRestoreFrameCounter: 0,
        restoreCompletionFlag: 1,
        breakDownCountdown: 0,
        postRestoreCountdown: 0,
      },
    },
  });
  return reports;
}
