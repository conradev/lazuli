// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_BOOT_CHECKPOINT_FIELDS_V3,
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  CheckpointValidationError,
  checkpointFieldsForSchema,
} from "./browser_boot_checkpoint_core.mjs";
import {
  SUPER_MONKEY_BALL_READY_CHECKPOINT,
  validateSmbReadyCheckpointOptions,
  validateSmbReadyCheckpointReport,
} from "./browser_boot_checkpoint_v3.mjs";
import {
  smbReadyPlayCheckpointReport,
} from "./browser_boot_checkpoint_v3_fixture.mjs";
import {
  GameplayTranscriptValidationError,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  TemporalXfbValidationError,
} from "./browser_boot_temporal_xfb.mjs";

function expectCheckpointFailure(mutate, path) {
  const report = smbReadyPlayCheckpointReport();
  mutate(report);
  assert.throws(
    () => validateSmbReadyCheckpointReport(report),
    error => error instanceof CheckpointValidationError && error.path === path,
  );
}

test("schema v3 defines one deeply frozen explicit SMB ready-to-PLAY profile", () => {
  assert.equal(BROWSER_BOOT_CHECKPOINT_SCHEMA_V3, "lazuli-browser-boot-checkpoint-v3");
  assert.equal(
    SUPER_MONKEY_BALL_READY_CHECKPOINT.id,
    "smb-usa/smb-ready-play/render-every-1/temporal-xfb-8",
  );
  assert.deepEqual(SUPER_MONKEY_BALL_READY_CHECKPOINT, {
    schema: "lazuli-browser-boot-checkpoint-v3",
    id: "smb-usa/smb-ready-play/render-every-1/temporal-xfb-8",
    game: {
      identifier: "GMBE8P",
      revision: 0,
      image: {
        algorithm: "sha256",
        format: "ciso",
        sha256: "441a0eadc85afb501e2a3db5af2ee81d4783b96a58f6a2df2605f5c33dcb6202",
      },
    },
    run: {
      scenario: "smb-ready-play",
      renderEvery: 1,
      renderer: "wgpu-webgpu",
      temporalXfbCapacity: 8,
      cleanRunsRequired: 3,
    },
  });
  for (const value of [
    SUPER_MONKEY_BALL_READY_CHECKPOINT,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.run,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(
    validateSmbReadyCheckpointOptions(),
    SUPER_MONKEY_BALL_READY_CHECKPOINT,
  );
});

test("schema v3 registers only the explicit ready-to-PLAY evidence fields", () => {
  assert.equal(BROWSER_BOOT_CHECKPOINT_SCHEMA, "lazuli-browser-boot-checkpoint-v2");
  assert.deepEqual(BROWSER_BOOT_CHECKPOINT_FIELDS_V3, [
    "/status",
    "/stage",
    "/title",
    "/disc/identifier",
    "/disc/revision",
    "/gameplayTranscript",
    "/rendering/backend",
    "/rendering/temporalSelectedXfb",
  ]);
  assert.deepEqual(
    checkpointFieldsForSchema(BROWSER_BOOT_CHECKPOINT_SCHEMA_V3),
    BROWSER_BOOT_CHECKPOINT_FIELDS_V3,
  );
});

test("fresh ready-to-PLAY reports satisfy every health and provenance gate", () => {
  const report = smbReadyPlayCheckpointReport();
  assert.strictEqual(validateSmbReadyCheckpointReport(report), report);
});

test("v3 independently rederives the attached gameplay transcript", () => {
  const report = smbReadyPlayCheckpointReport();
  report.gameplayTranscript.steps[0].ready.witness.menuSelection += 1;
  assert.throws(
    () => validateSmbReadyCheckpointReport(report),
    error => error instanceof GameplayTranscriptValidationError
      && error.code === "transcript-mismatch"
      && /menuSelection$/.test(error.path),
  );
});

test("v3 fails closed on forged temporal oracle evidence", () => {
  const report = smbReadyPlayCheckpointReport();
  report.rendering.temporalSelectedXfb.oracle.complete = false;
  assert.throws(
    () => validateSmbReadyCheckpointReport(report),
    error => error instanceof TemporalXfbValidationError
      && error.code === "oracle-mismatch"
      && /complete$/.test(error.path),
  );
});

test("v3 gates fresh-disc, scenario, WebGPU, renderer, device, and DevTools health", () => {
  const cases = [
    [report => { report.error = "boom"; }, "$.error"],
    [report => { report.title = "Other Game (GMBE8P Rev.00)"; }, "$.title"],
    [report => { report.scenario.failure = { reason: "boom" }; }, "$.scenario.failure"],
    [report => { report.headlessCapture.discImage.sha256 = "0".repeat(64); }, "$.headlessCapture.discImage.sha256"],
    [report => { report.headlessCapture.discImage.hostPath = "/tmp/game.ciso"; }, "$.headlessCapture.discImage.[keys]"],
    [report => { report.execution.scheduler.renderEvery = 2; }, "$.execution.scheduler.renderEvery"],
    [report => { report.headlessCapture.dataset.renderEvery = "2"; }, "$.headlessCapture.dataset.renderEvery"],
    [report => { report.rendering.backend = "fallback"; }, "$.rendering.backend"],
    [report => { report.execution.scheduler.rendererSync.failed = 1; }, "$.execution.scheduler.rendererSync.failed"],
    [report => { report.rendering.metrics.operations.pending = 1; }, "$.rendering.metrics.operations.pending"],
    [report => { report.rendering.metrics.webgpu.checkHealthCalls = 0; }, "$.rendering.metrics.webgpu.checkHealthCalls"],
    [report => { report.rendering.selectedXfb.rgbaSha256 = "f".repeat(64); }, "$.rendering.selectedXfb.rgbaSha256"],
    [report => { report.mmioState.viInterruptModel.lastPresentationCopyIndex -= 1; }, "$.mmioState.viInterruptModel.lastPresentationCopyIndex"],
    [report => { report.diskCommands.lastError = "0x00000001"; }, "$.diskCommands.lastError"],
    [report => { report.deviceEvents.diskDeviceError = 1; }, "$.deviceEvents.diskDeviceError"],
    [report => { report.gxFifo.decoder.unknownOpcodes = 1; }, "$.gxFifo.decoder.unknownOpcodes"],
    [report => { report.serialInterface.unknownOutputCommands = 1; }, "$.serialInterface.unknownOutputCommands"],
    [report => { report.exceptions.counts["0x0600"] = 1; }, '$.exceptions.counts["0x0600"]'],
    [report => { report.headlessCapture.devtoolsExceptions.push({ text: "boom" }); }, "$.headlessCapture.devtoolsExceptions[0]"],
    [report => { report.headlessCapture.reuse = { previous: {} }; }, "$.headlessCapture.reuse"],
  ];
  for (const [mutate, path] of cases) expectCheckpointFailure(mutate, path);
});

test("v3 profile validation cannot be weakened by callers", () => {
  const cases = [
    [profile => { profile.schema = BROWSER_BOOT_CHECKPOINT_SCHEMA; }, "$expected.schema"],
    [profile => { profile.game.image.format = "iso"; }, "$expected.game.image.format"],
    [profile => { profile.run.scenario = "other"; }, "$expected.run.scenario"],
    [profile => { profile.run.renderEvery = 2; }, "$expected.run.renderEvery"],
    [profile => { profile.run.temporalXfbCapacity = 7; }, "$expected.run.temporalXfbCapacity"],
    [profile => { profile.run.cleanRunsRequired = 2; }, "$expected.run.cleanRunsRequired"],
    [profile => { profile.run.untrusted = true; }, "$expected.run.[keys]"],
  ];
  for (const [mutate, path] of cases) {
    const profile = structuredClone(SUPER_MONKEY_BALL_READY_CHECKPOINT);
    mutate(profile);
    assert.throws(
      () => validateSmbReadyCheckpointOptions(profile),
      error => error instanceof CheckpointValidationError && error.path === path,
    );
  }
});
