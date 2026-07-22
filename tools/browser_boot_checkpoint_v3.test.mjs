// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_BOOT_CHECKPOINT_FIELDS_V3,
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  CheckpointValidationError,
  checkpointFieldsForSchema,
  checkpointSha256,
} from "./browser_boot_checkpoint_core.mjs";
import {
  SUPER_MONKEY_BALL_READY_CHECKPOINT,
  createSmbReadyCheckpointCandidate,
  projectSmbReadyCheckpointReport,
  validateSmbReadyCheckpointOptions,
  validateSmbReadyCheckpointReport,
} from "./browser_boot_checkpoint_v3.mjs";
import {
  smbReadyPlayCheckpointReport,
} from "./browser_boot_checkpoint_v3_fixture.mjs";
import {
  GameplayTranscriptValidationError,
  deriveSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  TemporalXfbValidationError,
  deriveTemporalSelectedXfbOracle,
  projectSmbTemporalSelectedXfb,
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

test("v3 candidate projects exactly the verified transcript and canonical temporal XFB", () => {
  const report = smbReadyPlayCheckpointReport();
  const state = projectSmbReadyCheckpointReport(report);
  const candidate = createSmbReadyCheckpointCandidate(report);
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
  assert.deepEqual(Object.keys(state), [
    "status",
    "stage",
    "title",
    "disc",
    "gameplayTranscript",
    "rendering",
  ]);
  assert.deepEqual(Object.keys(state.disc), ["identifier", "revision"]);
  assert.deepEqual(Object.keys(state.rendering), ["backend", "temporalSelectedXfb"]);
  assert.equal(state.execution, undefined);
  assert.equal(state.headlessCapture, undefined);
  assert.equal(state.gxFifo, undefined);
  assert.deepEqual(
    state.gameplayTranscript,
    deriveSmbReadyPlayGameplayTranscript(report),
  );
  assert.deepEqual(
    state.rendering.temporalSelectedXfb,
    projectSmbTemporalSelectedXfb(report.rendering.temporalSelectedXfb),
  );
  assert.equal(candidate.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA_V3);
  assert.deepEqual(candidate.fields, BROWSER_BOOT_CHECKPOINT_FIELDS_V3);
  assert.equal(candidate.id, SUPER_MONKEY_BALL_READY_CHECKPOINT.id);
  assert.deepEqual(candidate.checkpoint, {
    status: "paused",
    stage: "scenario-complete",
  });
  assert.deepEqual(candidate.run, SUPER_MONKEY_BALL_READY_CHECKPOINT.run);
  assert.equal(candidate.sha256, checkpointSha256(state));
  assert.equal(
    candidate.sha256,
    "b1fda70448f54e03a36231d8c2b5a40d6223ffa23f90072101b0e73d16257010",
  );
  assert.deepEqual(candidate.state, state);
});

test("host diagnostics stay out while verified gameplay and temporal evidence affect v3", () => {
  const report = smbReadyPlayCheckpointReport();
  const digest = createSmbReadyCheckpointCandidate(report).sha256;
  report.runtime = "Another Browser/9.0";
  report.headlessCapture.url = "http://localhost:9999/host-only";
  report.rendering.metrics.webgpu.adapterLabel = "host-only";
  report.scenario.steps[0].readyState.hostDiagnostic = 123;
  report.rendering.temporalSelectedXfb.frames[0].hostTimestamp = 456;
  report.rendering.temporalSelectedXfb.frames[0].selectedXfb.gpuLabel = "host-only";
  assert.equal(createSmbReadyCheckpointCandidate(report).sha256, digest);

  const gameplayChanged = smbReadyPlayCheckpointReport();
  gameplayChanged.scenario.steps[0].readyState.menuSelection += 1;
  gameplayChanged.gameplayTranscript = deriveSmbReadyPlayGameplayTranscript(gameplayChanged);
  assert.notEqual(createSmbReadyCheckpointCandidate(gameplayChanged).sha256, digest);

  const temporalChanged = smbReadyPlayCheckpointReport();
  temporalChanged.rendering.temporalSelectedXfb.frames[0].selectedXfb.rgbSha256 = "f".repeat(64);
  temporalChanged.rendering.temporalSelectedXfb.oracle = deriveTemporalSelectedXfbOracle(
    temporalChanged.rendering.temporalSelectedXfb.frames,
  );
  assert.notEqual(createSmbReadyCheckpointCandidate(temporalChanged).sha256, digest);
});

test("v3 independently rederives the attached gameplay transcript", () => {
  const report = smbReadyPlayCheckpointReport();
  report.gameplayTranscript.steps[0].ready.witness.menuSelection += 1;
  assert.throws(
    () => createSmbReadyCheckpointCandidate(report),
    error => error instanceof GameplayTranscriptValidationError
      && error.code === "transcript-mismatch"
      && /menuSelection$/.test(error.path),
  );
});

test("v3 fails closed on forged temporal oracle evidence", () => {
  const report = smbReadyPlayCheckpointReport();
  report.rendering.temporalSelectedXfb.oracle.complete = false;
  assert.throws(
    () => createSmbReadyCheckpointCandidate(report),
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
