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
  SMB_SUSTAINED_PLAY_SCHEMA_V2,
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

function sustainedReport(schema = SMB_SUSTAINED_PLAY_SCHEMA_V1) {
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

test("legacy v1 receipts remain replayable", () => {
  const report = sustainedReport();
  delete report.rendering.metrics.webgpu.exactRasterEmptyDraws;
  delete report.rendering.metrics.webgpu.exactRequiredRejectedDraws;
  delete report.gxFifo.decoder.droppedVertices;
  delete report.gxFifo.decoder.lightingRejectedVertices;
  delete report.gxFifo.decoder.exactRequiredCaptureMisses;
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

test("v2 independently proves 60 staged and 60 presented field pairs", () => {
  const report = sustainedReport(SMB_SUSTAINED_PLAY_SCHEMA_V2);
  report.rendering.metrics.webgpu.exactRasterEmptyDraws = 17;
  const oracle = verifySmbSustainedPlay(report);
  assert.equal(oracle.received, 120);
  assert.equal(oracle.drained, 120);
  assert.equal(oracle.staged, 60);
  assert.equal(oracle.presented, 60);
  assert.equal(oracle.rejected, 0);
  assert.equal(oracle.completedPairEpochs, 60);
  assert.equal(oracle.topFields, 60);
  assert.equal(oracle.bottomFields, 60);
  assert.equal(oracle.complete, true);
  assert.equal(Object.hasOwn(oracle, "exactRasterEmptyDraws"), false);
});

test("v2 requires clean terminal producer and renderer compatibility telemetry", () => {
  const cases = [
    [
      report => { report.rendering.metrics.scope = "lifetime"; },
      "$.rendering.metrics.scope",
    ],
    [
      report => { report.rendering.metrics.webgpu.exactRasterEmptyDraws = -1; },
      "$.rendering.metrics.webgpu.exactRasterEmptyDraws",
    ],
    [
      report => { report.rendering.metrics.webgpu.exactRasterEmptyDraws = 0.5; },
      "$.rendering.metrics.webgpu.exactRasterEmptyDraws",
    ],
    [
      report => { report.rendering.metrics.webgpu.exactRequiredRejectedDraws = 1; },
      "$.rendering.metrics.webgpu.exactRequiredRejectedDraws",
    ],
    [
      report => { report.gxFifo.decoder.droppedVertices = 1; },
      "$.gxFifo.decoder.droppedVertices",
    ],
    [
      report => { report.gxFifo.decoder.lightingRejectedVertices = 1; },
      "$.gxFifo.decoder.lightingRejectedVertices",
    ],
    [
      report => { report.gxFifo.decoder.vertexDecodeErrors = 1; },
      "$.gxFifo.decoder.vertexDecodeErrors",
    ],
    [
      report => { report.gxFifo.decoder.exactRequiredCaptureMisses = 1; },
      "$.gxFifo.decoder.exactRequiredCaptureMisses",
    ],
    [
      report => { report.gxFifo.decoder.textures.decodeErrors = 1; },
      "$.gxFifo.decoder.textures.decodeErrors",
    ],
    [
      report => { report.gxFifo.decoder.textures.tlutErrors = 1; },
      "$.gxFifo.decoder.textures.tlutErrors",
    ],
  ];
  for (const [mutate, path] of cases) {
    const report = sustainedReport(SMB_SUSTAINED_PLAY_SCHEMA_V2);
    mutate(report);
    expectFailure(report, path);
  }
});

test("v2 rejects untruthful pairing status, epochs, and presentation serials", () => {
  const cases = [
    [
      report => { report.sustainedPlay.receipts[0].accepted = false; },
      "$.sustainedPlay.receipts[0].accepted",
      1,
    ],
    [
      report => { report.sustainedPlay.receipts[0].presented = true; },
      "$.sustainedPlay.receipts[0].presented",
      1,
    ],
    [
      report => {
        report.sustainedPlay.receipts[0].status = "vi-interlaced-frame-ready";
      },
      "$.sustainedPlay.receipts[0].status",
      1,
    ],
    [
      report => {
        report.sustainedPlay.receipts[0].presentation.pairCompleting = true;
      },
      "$.sustainedPlay.receipts[0].presentation.pairCompleting",
      1,
    ],
    [
      report => { report.sustainedPlay.receipts[1].pairEpoch += 1; },
      "$.sustainedPlay.receipts[1].pairEpoch",
      2,
    ],
    [
      report => { report.sustainedPlay.receipts[2].pairEpoch += 1; },
      "$.sustainedPlay.receipts[2].pairEpoch",
      3,
    ],
    [
      report => { report.sustainedPlay.receipts[0].presentationSerial = 1; },
      "$.sustainedPlay.receipts[0].presentationSerial",
      1,
    ],
    [
      report => { report.sustainedPlay.receipts[1].presentationSerial = null; },
      "$.sustainedPlay.receipts[1].presentationSerial",
      2,
    ],
    [
      report => {
        report.sustainedPlay.receipts[3].presentationSerial =
          report.sustainedPlay.receipts[1].presentationSerial;
      },
      "$.sustainedPlay.receipts[3].presentationSerial",
      4,
    ],
    [
      report => { report.sustainedPlay.receipts[0].presentation.mode = "single-field"; },
      "$.sustainedPlay.receipts[0].presentation.mode",
      1,
    ],
  ];
  for (const [mutate, path, ordinal] of cases) {
    const report = sustainedReport(SMB_SUSTAINED_PLAY_SCHEMA_V2);
    mutate(report);
    expectFailure(report, path, ordinal);
  }
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
