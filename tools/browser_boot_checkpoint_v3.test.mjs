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
} from "./browser_boot_checkpoint_v3.mjs";

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
