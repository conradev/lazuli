#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  SMB_SUSTAINED_PLAY_SCHEMA_V1,
  SMB_SUSTAINED_PLAY_SCHEMA_V2,
  SMB_SUSTAINED_PLAY_SCHEMA_V3,
  SmbSustainedPlayValidationError,
  deriveSmbSustainedPlayOracle,
  verifySmbSustainedPlay,
  verifySmbSustainedPlayPrefix,
} from "./browser_boot_smb_sustained_play.mjs";
import {
  SmbSustainedSurfaceHistoryValidationError,
  deriveSmbSustainedPresentedSurfaceHistoryOracle,
} from "./browser_boot_smb_sustained_surface_history.mjs";
import {
  smbSustainedPlayReport,
} from "./browser_boot_smb_sustained_play_test_fixture.mjs";

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

function syncSurfacePopulations(surface) {
  const fields = [surface.fields.top, surface.fields.bottom];
  for (const name of ["black", "white", "other"]) {
    surface.rgb[name] = fields
      .reduce((sum, field) => sum + field.rgb[name], 0);
  }
  for (const name of ["dark", "light", "other"]) {
    surface.visualRgb[name] = fields
      .reduce((sum, field) => sum + field.visualRgb[name], 0);
  }
}

function sustainedPrefixReport(receipts = 16, pending = 0) {
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V2);
  report.status = "running";
  report.stage = "execute";
  report.scenario.status = "running";
  report.scenario.completedCycle = null;
  report.scenario.stepIndex = 14;
  report.scenario.currentStep = "sustained-play-presented";
  report.scenario.steps = report.scenario.steps.slice(0, 14);
  report.sustainedPlay.receipts =
    report.sustainedPlay.receipts.slice(0, receipts);
  report.sustainedPlay.posted = receipts + pending;
  report.sustainedPlay.pending = pending;
  return report;
}

test("live v2 prefix validates exact partial pairing and chronology", () => {
  const empty = sustainedPrefixReport(0, 0);
  assert.deepEqual(verifySmbSustainedPlayPrefix(empty), {
    acceptedReceipts: 0,
    lastPresentationSerial: null,
    lastReceiptOrdinal: null,
    lastRendererSequence: null,
    observedCycle: empty.cycles,
    pendingReceipts: 0,
    postedReceipts: 0,
  });

  const awaitingPair = sustainedPrefixReport(1, 1);
  assert.deepEqual(verifySmbSustainedPlayPrefix(awaitingPair), {
    acceptedReceipts: 1,
    lastPresentationSerial: null,
    lastReceiptOrdinal: 1,
    lastRendererSequence: 1000,
    observedCycle: awaitingPair.cycles,
    pendingReceipts: 1,
    postedReceipts: 2,
  });

  const report = sustainedPrefixReport(16, 2);
  assert.deepEqual(verifySmbSustainedPlayPrefix(report), {
    acceptedReceipts: 16,
    lastPresentationSerial: 907,
    lastReceiptOrdinal: 16,
    lastRendererSequence: 1015,
    observedCycle: report.cycles,
    pendingReceipts: 2,
    postedReceipts: 18,
  });

  const malformedReceipt = sustainedPrefixReport();
  malformedReceipt.sustainedPlay.receipts[3].presentation.copyIndex = 1;
  assert.throws(
    () => verifySmbSustainedPlayPrefix(malformedReceipt),
    error => error instanceof SmbSustainedPlayValidationError
      && error.path === "$.sustainedPlay.receipts[3].presentation.copyIndex",
  );

  const pendingDrift = sustainedPrefixReport(16, 2);
  pendingDrift.sustainedPlay.posted += 1;
  assert.throws(
    () => verifySmbSustainedPlayPrefix(pendingDrift),
    error => error instanceof SmbSustainedPlayValidationError
      && error.path === "$.sustainedPlay.posted",
  );
});

test("legacy v1 receipts remain replayable", () => {
  const report = smbSustainedPlayReport();
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
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V2);
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

test("v3 binds all 60 retained WebGPU surfaces to exact completed VI pairs", () => {
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V3);
  const oracle = verifySmbSustainedPlay(report);
  const surfaces = report.rendering.sustainedPresentedSurfaces;
  assert.equal(oracle.presented, 60);
  assert.equal(surfaces.frames.length, 60);
  assert.equal(surfaces.oracle.captured, 60);
  assert.equal(surfaces.oracle.distinctPairEpochs, 60);
  assert.equal(surfaces.oracle.distinctPresentationSerials, 60);
  assert.equal(surfaces.oracle.extremeThresholdPpm, 850_000);
  assert.equal(surfaces.oracle.darkChannelMaximum, 8);
  assert.equal(surfaces.oracle.lightChannelMinimum, 247);
  assert.equal(surfaces.oracle.monochromeOrdinals.length, 0);
  assert.equal(surfaces.oracle.nearBlackOrdinals.length, 0);
  assert.equal(surfaces.oracle.nearWhiteOrdinals.length, 0);
  assert.equal(surfaces.oracle.topFieldMonochromeOrdinals.length, 0);
  assert.equal(surfaces.oracle.bottomFieldMonochromeOrdinals.length, 0);
  assert.equal(surfaces.oracle.topFieldNearBlackOrdinals.length, 0);
  assert.equal(surfaces.oracle.topFieldNearWhiteOrdinals.length, 0);
  assert.equal(surfaces.oracle.bottomFieldNearBlackOrdinals.length, 0);
  assert.equal(surfaces.oracle.bottomFieldNearWhiteOrdinals.length, 0);
  assert.equal(surfaces.oracle.sourceBlackWhiteSplitOrdinals.length, 0);
  assert.equal(surfaces.oracle.sourceNearBlackWhiteSplitOrdinals.length, 0);
});

test("v3 rejects missing, mismatched, extreme, split, and static surfaces", () => {
  const expectSurfaceFailure = (mutate, path) => {
    const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V3);
    mutate(report);
    assert.throws(
      () => verifySmbSustainedPlay(report),
      error => error instanceof SmbSustainedSurfaceHistoryValidationError
        && error.path === path,
    );
  };
  expectSurfaceFailure(
    report => { report.rendering.sustainedPresentedSurfaces.frames.pop(); },
    "$.rendering.sustainedPresentedSurfaces.frames",
  );
  expectSurfaceFailure(
    report => {
      report.rendering.sustainedPresentedSurfaces.frames[3]
        .presentedSurface.presentationSerial += 1;
    },
    "$.rendering.sustainedPresentedSurfaces.frames[3]"
      + ".presentedSurface.presentationSerial",
  );
  expectSurfaceFailure(
    report => {
      report.rendering.sustainedPresentedSurfaces.frames[7]
        .presentedSurface.fields.top.generation += 1;
    },
    "$.rendering.sustainedPresentedSurfaces.frames[7]"
      + ".presentedSurface.fields.top.generation",
  );
  expectSurfaceFailure(
    report => {
      report.rendering.sustainedPresentedSurfaces.frames[8]
        .presentedSurface.fields.top.fieldStrideBytes = 1_280;
    },
    "$.rendering.sustainedPresentedSurfaces.frames[8]"
      + ".presentedSurface.fields.top.fieldStrideBytes",
  );
  expectSurfaceFailure(
    report => {
      report.rendering.sustainedPresentedSurfaces.frames[9]
        .presentedSurface.fields.bottom.sourceRowStep = 1;
    },
    "$.rendering.sustainedPresentedSurfaces.frames[9]"
      + ".presentedSurface.fields.bottom.sourceRowStep",
  );
  expectSurfaceFailure(
    report => {
      report.rendering.sustainedPresentedSurfaces.frames[10]
        .presentedSurface.fields.bottom.sourceRow = 0;
    },
    "$.rendering.sustainedPresentedSurfaces.frames[10]"
      + ".presentedSurface.fields.bottom.sourceRow",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const surface = history.frames[10].presentedSurface;
      const top = surface.fields.top;
      const pixels = top.width * top.height;
      const black = Math.ceil(pixels * 0.9);
      top.rgb = {
        black,
        white: 0,
        other: pixels - black,
        unique: 2,
      };
      top.visualRgb = { dark: 0, light: 0, other: pixels };
      syncSurfacePopulations(surface);
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.frames[10]"
      + ".presentedSurface.fields.top.visualRgb.dark",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const surface = history.frames[11].presentedSurface;
      for (const field of Object.values(surface.fields)) {
        const pixels = field.width * field.height;
        field.rgb = { black: pixels, white: 0, other: 0, unique: 1 };
        field.visualRgb = { dark: pixels, light: 0, other: 0 };
      }
      const pixels = surface.width * surface.height;
      surface.rgb.unique = 1;
      syncSurfacePopulations(surface);
      assert.equal(surface.rgb.black, pixels);
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.oracle.monochromeOrdinals",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const surface = history.frames[12].presentedSurface;
      for (const field of Object.values(surface.fields)) {
        const pixels = field.width * field.height;
        const dark = Math.ceil(pixels * 0.85);
        field.visualRgb = { dark, light: 0, other: pixels - dark };
      }
      syncSurfacePopulations(surface);
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.oracle.nearBlackOrdinals",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const { top, bottom } = history.frames[13].presentedSurface.fields;
      const topPixels = top.width * top.height;
      const bottomPixels = bottom.width * bottom.height;
      top.rgb = { black: topPixels, white: 0, other: 0, unique: 1 };
      bottom.rgb = { black: 0, white: bottomPixels, other: 0, unique: 1 };
      top.visualRgb = { dark: topPixels, light: 0, other: 0 };
      bottom.visualRgb = { dark: 0, light: bottomPixels, other: 0 };
      syncSurfacePopulations(history.frames[13].presentedSurface);
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.oracle"
      + ".sourceBlackWhiteSplitOrdinals",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const { top, bottom } = history.frames[14].presentedSurface.fields;
      const topPixels = top.width * top.height;
      const bottomPixels = bottom.width * bottom.height;
      const topDark = Math.ceil(topPixels * 0.85);
      const bottomLight = Math.ceil(bottomPixels * 0.85);
      top.visualRgb = {
        dark: topDark,
        light: top.rgb.white,
        other: topPixels - topDark - top.rgb.white,
      };
      bottom.visualRgb = {
        dark: bottom.rgb.black,
        light: bottomLight,
        other: bottomPixels - bottom.rgb.black - bottomLight,
      };
      syncSurfacePopulations(history.frames[14].presentedSurface);
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.oracle"
      + ".sourceNearBlackWhiteSplitOrdinals",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const top = history.frames[15].presentedSurface.fields.top;
      const pixels = top.width * top.height;
      top.rgb = { black: pixels, white: 0, other: 0, unique: 1 };
      top.visualRgb = { dark: pixels, light: 0, other: 0 };
      syncSurfacePopulations(history.frames[15].presentedSurface);
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.oracle"
      + ".topFieldMonochromeOrdinals",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const bottom = history.frames[16].presentedSurface.fields.bottom;
      const pixels = bottom.width * bottom.height;
      bottom.rgb = { black: 0, white: pixels, other: 0, unique: 1 };
      bottom.visualRgb = { dark: 0, light: pixels, other: 0 };
      syncSurfacePopulations(history.frames[16].presentedSurface);
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.oracle"
      + ".bottomFieldMonochromeOrdinals",
  );
  expectSurfaceFailure(
    report => {
      const history = report.rendering.sustainedPresentedSurfaces;
      const hash = history.frames[0].presentedSurface.rgbSha256;
      for (const frame of history.frames) {
        frame.presentedSurface.rgbSha256 = hash;
      }
      history.oracle =
        deriveSmbSustainedPresentedSurfaceHistoryOracle(history.frames);
    },
    "$.rendering.sustainedPresentedSurfaces.oracle.distinctRgbHashes",
  );
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
    const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V2);
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
    const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V2);
    mutate(report);
    expectFailure(report, path, ordinal);
  }
});

test("strict 60/60 alternation permits either first field parity", () => {
  const report = smbSustainedPlayReport();
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
    const report = smbSustainedPlayReport();
    mutate(report);
    expectFailure(report, path, ordinal);
  }
});

test("receipt failures expose expected, actual, and previous values", () => {
  const report = smbSustainedPlayReport();
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
  const report = smbSustainedPlayReport();
  report.sustainedPlay.readyPlayAnchor.scenario.steps[0].readyState.gameSubmode = 5;
  expectFailure(
    report,
    "$.sustainedPlay.readyPlayAnchor.scenario.steps[0].readyState.gameSubmode",
  );
});
