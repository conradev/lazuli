// SPDX-License-Identifier: GPL-3.0-only

import {
  smbReadyPlayCheckpointReport,
} from "./browser_boot_checkpoint_v3_fixture.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V1,
  SMB_SUSTAINED_PLAY_SCHEMA_V2,
  SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
  deriveSmbSustainedPlayOracle,
} from "./browser_boot_smb_sustained_play.mjs";
import {
  deriveTemporalPresentedSurfaceOracle,
} from "./browser_boot_temporal_surface.mjs";

function stateRecord(stickX, polls) {
  const state = {
    buttons: 0,
    stickX,
    stickY: 0x80,
    cStickX: 0x80,
    cStickY: 0x80,
    triggerL: 0,
    triggerR: 0,
    analogA: 0,
    analogB: 0,
  };
  return {
    polls,
    state,
    publications: Array.from({ length: polls }, (_unused, index) => ({
      pollIndex: 100 + index,
      state: { ...state },
    })),
  };
}

function guestGameplayState(stickX, xrot, zrot) {
  const padStatus = {
    address: "0x801f3b70",
    error: 0,
    stickX,
  };
  return {
    padStatus: { ...padStatus },
    gameplayInput: {
      currentPlayer: 0,
      controller: 0,
      padStatus: { ...padStatus },
      world: {
        address: "0x80206bf0",
        state: 2,
        player: 0,
        inputLockFrames: 0,
        xrot,
        zrot,
      },
    },
  };
}

function receipt(index) {
  const bottom = index % 2 === 1;
  return {
    scenario: "smb-sustained-play",
    step: "sustained-play-presented",
    ordinal: index + 1,
    capacity: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    rendererSequence: 1000 + index,
    drained: true,
    presented: true,
    presentation: {
      field: bottom ? "bottom" : "top",
      address: bottom ? "0x00307180" : "0x00392c80",
      copyIndex: 2000 + index,
      copyRow: bottom ? 1 : 0,
      width: 640,
      height: 448,
    },
    gameplay: {
      gameModeRequest: -1,
      gameMode: 2,
      gameSubmodeRequest: -1,
      gameSubmode: 51,
      infoTimer: 3599 - index,
      attempts: 1,
      floor: 1,
    },
  };
}

function pairedReceipt(index) {
  const value = receipt(index);
  const pairCompleting = index % 2 === 1;
  return {
    ...value,
    accepted: true,
    presented: pairCompleting,
    status: pairCompleting
      ? "vi-interlaced-frame-ready"
      : "vi-field-pair-awaiting",
    pairEpoch: 500 + Math.floor(index / 2),
    presentationSerial: pairCompleting ? 900 + Math.floor(index / 2) : null,
    presentation: {
      mode: "interlaced",
      pairCompleting,
      ...value.presentation,
    },
  };
}

function addPresentedSurfaces(temporal) {
  for (let index = 0; index < temporal.frames.length; index += 1) {
    const frame = temporal.frames[index];
    const selected = frame.selectedXfb;
    frame.presentedSurface = {
      ...structuredClone(selected),
      surfaceFormat: index % 2 === 0 ? "bgra8unorm" : "rgba8unorm",
    };
  }
  temporal.surfaceOracle = deriveTemporalPresentedSurfaceOracle(temporal.frames);
}

export function smbSustainedPlayReport(
  schema = SMB_SUSTAINED_PLAY_SCHEMA_V1,
) {
  const report = smbReadyPlayCheckpointReport();
  addPresentedSurfaces(report.rendering.temporalSelectedXfb);
  const readyPlayAnchor = structuredClone({
    status: report.status,
    stage: report.stage,
    cycles: report.cycles,
    disc: report.disc,
    scenario: report.scenario,
    controller: report.controller,
  });
  report.cycles += 1_000_000_000;
  report.scenario.id = "smb-sustained-play";
  report.scenario.hardCycleLimit = 32_000_000_000;
  report.scenario.completedCycle = report.cycles;
  report.scenario.steps.push({
    id: "sustained-main-stick-left",
    type: "state-input",
    owner: "page",
    active: stateRecord(0x1c, 30),
    neutral: stateRecord(0x80, 3),
    guest: {
      activeState: guestGameplayState(-60, 512, -1024),
      neutralState: guestGameplayState(0, 0, 0),
    },
  });
  report.scenario.steps.push({
    id: "sustained-play-presented",
    type: "observe",
    observedCycle: report.cycles,
  });
  report.scenario.stepIndex = 15;
  report.scenario.currentStep = null;
  report.scenario.failure = null;
  report.rendering.error = null;
  report.rendering.metrics.operations.pending = 0;
  report.execution.scheduler.rendererSync.inFlight = 0;
  report.execution.scheduler.rendererSync.resultMisses = 0;
  report.sustainedPlay = {
    schema,
    capacity: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    posted: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    pending: 0,
    receipts: Array.from(
      { length: SMB_SUSTAINED_VI_RECEIPT_CAPACITY },
      (_unused, index) => schema === SMB_SUSTAINED_PLAY_SCHEMA_V2
        ? pairedReceipt(index)
        : receipt(index),
    ),
    failure: null,
    readyPlayAnchor,
    oracle: null,
  };
  report.sustainedPlay.oracle = deriveSmbSustainedPlayOracle(report);
  return report;
}
