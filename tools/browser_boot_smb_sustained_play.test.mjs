#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  smbReadyPlayCheckpointReport,
} from "./browser_boot_checkpoint_v3_fixture.mjs";
import {
  deriveTemporalPresentedSurfaceOracle,
} from "./browser_boot_temporal_surface.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V1,
  SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
  SmbSustainedPlayValidationError,
  deriveSmbSustainedPlayOracle,
  verifySmbSustainedPlay,
} from "./browser_boot_smb_sustained_play.mjs";

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

function addPresentedSurfaces(temporal) {
  for (let index = 0; index < temporal.frames.length; index += 1) {
    const frame = temporal.frames[index];
    const selected = frame.selectedXfb;
    frame.presentedSurface = {
      address: selected.address,
      generation: selected.generation,
      row: selected.row,
      presentationSerial: 800 + index,
      surfaceFormat: index % 2 === 0 ? "bgra8unorm" : "rgba8unorm",
      format: "rgba8unorm",
      layout: "top-left-row-major-tight",
      width: frame.presentation.width,
      height: frame.presentation.height,
      scanoutPolicy: frame.presentation.scanoutPolicy,
      fieldStrideBytes: frame.presentation.fieldStrideBytes,
      sourceRowStep: frame.presentation.sourceRowStep,
      fieldHeight: frame.presentation.fieldHeight,
      rowRepeat: frame.presentation.rowRepeat,
      rgbaByteLength: frame.presentation.width * frame.presentation.height * 4,
      rgbaSha256: (100 + index).toString(16).padStart(64, "0"),
      rgbSha256: (200 + index).toString(16).padStart(64, "0"),
      rgb: {
        black: 0,
        white: 0,
        other: frame.presentation.width * frame.presentation.height,
        unique: 4,
      },
    };
  }
  temporal.surfaceOracle = deriveTemporalPresentedSurfaceOracle(temporal.frames);
}

function sustainedReport() {
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
  report.scenario.id = "smb-sustained-play";
  report.scenario.hardCycleLimit = 32_000_000_000;
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
    schema: SMB_SUSTAINED_PLAY_SCHEMA_V1,
    capacity: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    posted: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    pending: 0,
    receipts: Array.from(
      { length: SMB_SUSTAINED_VI_RECEIPT_CAPACITY },
      (_unused, index) => receipt(index),
    ),
    failure: null,
    readyPlayAnchor,
    oracle: null,
  };
  report.sustainedPlay.oracle = deriveSmbSustainedPlayOracle(report);
  return report;
}

function expectFailure(report, path, ordinal = null) {
  assert.throws(
    () => verifySmbSustainedPlay(report),
    error => error instanceof SmbSustainedPlayValidationError
      && error.path === path
      && error.ordinal === ordinal
      && Object.hasOwn(error, "expected")
      && Object.hasOwn(error, "actual")
      && Object.hasOwn(error, "previous"),
  );
}

test("120 drained VI receipts independently prove sustained PLAY", () => {
  const report = sustainedReport();
  const oracle = verifySmbSustainedPlay(report);
  assert.deepEqual(oracle, {
    capacity: 120,
    received: 120,
    drained: 120,
    presented: 120,
    topFields: 60,
    bottomFields: 60,
    strictAlternation: true,
    correctedRows: true,
    stableParityAddresses: true,
    parityAddresses: { top: "0x00392c80", bottom: "0x00307180" },
    advancingCopyIndices: true,
    dimensions: { width: 640, height: 448, allMatch: true },
    playInvariants: true,
    infoTimer: { first: 3599, last: 3480, delta: 119 },
    input: {
      activePolls: 30,
      neutralPolls: 3,
      activeWireStickX: 0x1c,
      neutralWireStickX: 0x80,
      activeGuestStickX: -60,
      neutralGuestStickX: 0,
      gameplayMapping: { currentPlayer: 0, controller: 0 },
      activeWorldTilt: {
        xrot: 512,
        zrot: -1024,
        maxAbs: 1024,
        inputLockFrames: 0,
      },
      neutralWorldTilt: {
        xrot: 0,
        zrot: 0,
        maxAbs: 0,
        inputLockFrames: 0,
      },
    },
    renderer: { failed: 0, inFlight: 0, pendingReceipts: 0 },
    readyPlayAnchorCaptured: true,
    complete: true,
  });
});

test("strict 60/60 alternation permits either first field parity", () => {
  const report = sustainedReport();
  for (const sample of report.sustainedPlay.receipts) {
    const top = sample.presentation.field === "top";
    sample.presentation.field = top ? "bottom" : "top";
    sample.presentation.copyRow = top ? 1 : 0;
    sample.presentation.address = top ? "0x00307180" : "0x00392c80";
  }
  report.sustainedPlay.oracle = deriveSmbSustainedPlayOracle(report);
  const oracle = verifySmbSustainedPlay(report);
  assert.equal(oracle.topFields, 60);
  assert.equal(oracle.bottomFields, 60);
  assert.equal(oracle.strictAlternation, true);
});

test("the oracle names exact field, address, copy, timer, input, and drain failures", () => {
  const cases = [
    [
      report => { report.sustainedPlay.receipts[3].presentation.field = "top"; },
      "$.sustainedPlay.receipts[3].presentation.field",
      4,
    ],
    [
      report => { report.sustainedPlay.receipts[4].presentation.address = "0x00392d80"; },
      "$.sustainedPlay.receipts[4].presentation.address",
      5,
    ],
    [
      report => {
        report.sustainedPlay.receipts[8].presentation.copyIndex =
          report.sustainedPlay.receipts[7].presentation.copyIndex;
      },
      "$.sustainedPlay.receipts[8].presentation.copyIndex",
      9,
    ],
    [
      report => { report.sustainedPlay.receipts[50].gameplay.infoTimer += 1; },
      "$.sustainedPlay.receipts[50].gameplay.infoTimer",
      51,
    ],
    [
      report => { report.scenario.steps[13].active.polls = 2; },
      "$.scenario.steps[13].active.polls",
      null,
    ],
    [
      report => {
        const world = report.scenario.steps[13].guest.activeState.gameplayInput.world;
        world.xrot = 0;
        world.zrot = 0;
      },
      "$.scenario.steps[13].guest.activeState.gameplayInput.world.[xrot,zrot]",
      null,
    ],
    [
      report => {
        report.scenario.steps[13].guest.activeState.gameplayInput.world.inputLockFrames = 1;
      },
      "$.scenario.steps[13].guest.activeState.gameplayInput.world.inputLockFrames",
      null,
    ],
    [
      report => {
        report.scenario.steps[13].guest.neutralState.gameplayInput.world.xrot = 1;
      },
      "$.scenario.steps[13].guest.neutralState.gameplayInput.world.xrot",
      null,
    ],
    [
      report => {
        report.scenario.steps[13].guest.activeState.gameplayInput.controller = 1;
      },
      "$.scenario.steps[13].guest.activeState.gameplayInput.padStatus.address",
      null,
    ],
    [
      report => { report.execution.scheduler.rendererSync.inFlight = 1; },
      "$.execution.scheduler.rendererSync.inFlight",
      null,
    ],
    [
      report => { report.rendering.backend = "canvas2d"; },
      "$.rendering.backend",
      null,
    ],
    [
      report => { report.sustainedPlay.oracle.complete = false; },
      "$.sustainedPlay.oracle.complete",
      null,
    ],
  ];
  for (const [mutate, path, ordinal] of cases) {
    const report = sustainedReport();
    mutate(report);
    expectFailure(report, path, ordinal);
  }
});

test("receipt failures expose expected, actual, and previous values", () => {
  const report = sustainedReport();
  report.sustainedPlay.receipts[12].presentation.copyIndex = 1;
  assert.throws(
    () => verifySmbSustainedPlay(report),
    error => {
      assert.ok(error instanceof SmbSustainedPlayValidationError);
      assert.equal(error.path, "$.sustainedPlay.receipts[12].presentation.copyIndex");
      assert.equal(error.ordinal, 13);
      assert.equal(error.expected, "a value greater than 2011");
      assert.equal(error.actual, 1);
      assert.equal(error.previous, 2011);
      return true;
    },
  );
});

test("a forged ready-play prefix witness cannot hide behind matching step ids", () => {
  const report = sustainedReport();
  report.sustainedPlay.readyPlayAnchor.scenario.steps[0].readyState.gameSubmode = 5;
  expectFailure(
    report,
    "$.sustainedPlay.readyPlayAnchor.scenario.steps[0].readyState.gameSubmode",
  );
});
