// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_BOOT_CHECKPOINT_FIELDS_V3,
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  CheckpointValidationError,
} from "./browser_boot_checkpoint_core.mjs";
import {
  SUPER_MONKEY_BALL_READY_CHECKPOINT,
  createSmbReadyCheckpointCandidate,
} from "./browser_boot_checkpoint_v3.mjs";
import {
  CheckpointMismatchError,
  validateCheckpointManifest,
  verifyCheckpointReport,
} from "./browser_boot_checkpoint.mjs";
import {
  smbReadyPlayCheckpointReport,
} from "./browser_boot_checkpoint_v3_fixture.mjs";
import {
  deriveSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  deriveTemporalSelectedXfbOracle,
} from "./browser_boot_temporal_xfb.mjs";

function smbReadyManifest(report = smbReadyPlayCheckpointReport()) {
  return {
    ...createSmbReadyCheckpointCandidate(report),
    consensus: { cleanRuns: 3 },
  };
}

function expectCheckpointFailure(callback, path) {
  assert.throws(
    callback,
    error => error instanceof CheckpointValidationError && error.path === path,
  );
}

test("stored schema v3 manifests validate and verify ready-to-play reports", () => {
  const report = smbReadyPlayCheckpointReport();
  const manifest = smbReadyManifest(report);

  assert.equal(manifest.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA_V3);
  assert.deepEqual(manifest.fields, BROWSER_BOOT_CHECKPOINT_FIELDS_V3);
  assert.equal(manifest.consensus.cleanRuns, 3);
  assert.equal(
    manifest.sha256,
    "cdfe1b4097c11de6419d8ee9d2e9da616ef3f1881086b0bfbcb8c52a709c1f70",
  );
  assert.equal(validateCheckpointManifest(manifest), manifest);
  assert.equal(verifyCheckpointReport(report, manifest).sha256, manifest.sha256);
});

test("schema v3 manifests reproject their transcript and temporal state exactly", () => {
  const manifest = smbReadyManifest();

  const extraState = structuredClone(manifest);
  extraState.state.rendering.temporalSelectedXfb.frames[0].hostTimestamp = 123;
  expectCheckpointFailure(
    () => validateCheckpointManifest(extraState),
    "$manifest.state.rendering.temporalSelectedXfb.frames[0].hostTimestamp",
  );

  const forgedOracle = structuredClone(manifest);
  forgedOracle.state.rendering.temporalSelectedXfb.oracle.complete = false;
  expectCheckpointFailure(
    () => validateCheckpointManifest(forgedOracle),
    "$manifest.state.rendering.temporalSelectedXfb.oracle.complete",
  );

  const malformedTranscript = structuredClone(manifest);
  malformedTranscript.state.gameplayTranscript.steps[0].ready.untrusted = true;
  expectCheckpointFailure(
    () => validateCheckpointManifest(malformedTranscript),
    "$manifest.state.gameplayTranscript.steps[0].ready.[keys]",
  );

  const unknown = structuredClone(manifest);
  unknown.id = "smb-usa/unknown";
  expectCheckpointFailure(
    () => validateCheckpointManifest(unknown),
    "$manifest.id",
  );
});

test("schema v3 report mismatches retain transcript and temporal evidence paths", () => {
  const report = smbReadyPlayCheckpointReport();
  const manifest = smbReadyManifest(report);

  const gameplayChanged = structuredClone(report);
  gameplayChanged.scenario.steps[0].readyState.menuSelection += 1;
  gameplayChanged.gameplayTranscript =
    deriveSmbReadyPlayGameplayTranscript(gameplayChanged);
  assert.throws(
    () => verifyCheckpointReport(gameplayChanged, manifest),
    error => error instanceof CheckpointMismatchError
      && error.path
        === "$state.gameplayTranscript.steps[0].ready.witness.menuSelection",
  );

  const temporalChanged = structuredClone(report);
  temporalChanged.rendering.temporalSelectedXfb.frames[0]
    .selectedXfb.rgbSha256 = "f".repeat(64);
  temporalChanged.rendering.temporalSelectedXfb.oracle =
    deriveTemporalSelectedXfbOracle(
      temporalChanged.rendering.temporalSelectedXfb.frames,
    );
  assert.throws(
    () => verifyCheckpointReport(temporalChanged, manifest),
    error => error instanceof CheckpointMismatchError
      && error.path
        === "$state.rendering.temporalSelectedXfb.frames[0].selectedXfb.rgbSha256",
  );

  assert.deepEqual(
    manifest.run,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.run,
  );
});
