// SPDX-License-Identifier: GPL-3.0-only

import {
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  assertCheckpointJsonValue,
  canonicalCheckpointValue,
  checkpointFieldsForSchema,
  checkpointSha256,
  checkpointValidationFailure,
  describeCheckpointValue,
  requireCheckpointNonNegativeInteger,
  requireCheckpointObject,
} from "./browser_boot_checkpoint_core.mjs";
import {
  verifySmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  SMB_TEMPORAL_XFB_CAPACITY,
  projectSmbTemporalSelectedXfb,
} from "./browser_boot_temporal_xfb.mjs";

const SUPER_MONKEY_BALL_READY_TITLE = "Super Monkey Ball (GMBE8P Rev.00)";

export const SUPER_MONKEY_BALL_READY_CHECKPOINT = Object.freeze({
  schema: BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  id: "smb-usa/smb-ready-play/render-every-1/temporal-xfb-8",
  game: Object.freeze({
    identifier: "GMBE8P",
    revision: 0,
    image: Object.freeze({
      algorithm: "sha256",
      format: "ciso",
      sha256: "441a0eadc85afb501e2a3db5af2ee81d4783b96a58f6a2df2605f5c33dcb6202",
    }),
  }),
  run: Object.freeze({
    scenario: "smb-ready-play",
    renderEvery: 1,
    renderer: "wgpu-webgpu",
    temporalXfbCapacity: SMB_TEMPORAL_XFB_CAPACITY,
    cleanRunsRequired: 3,
  }),
});

function requireExactKeys(value, expectedKeys, path) {
  requireCheckpointObject(value, path);
  const actualKeys = Object.keys(value).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== wantedKeys.length
    || actualKeys.some((key, index) => key !== wantedKeys[index])
  ) {
    checkpointValidationFailure(
      `${path}.[keys]`,
      `expected ${describeCheckpointValue(wantedKeys)}, got ${describeCheckpointValue(actualKeys)}`,
    );
  }
  return value;
}

function requireExact(value, expected, path) {
  if (value !== expected) {
    checkpointValidationFailure(
      path,
      `expected ${describeCheckpointValue(expected)}, got ${describeCheckpointValue(value)}`,
    );
  }
  return value;
}

function requirePositiveInteger(value, path) {
  const integer = requireCheckpointNonNegativeInteger(value, path);
  if (integer === 0) checkpointValidationFailure(path, "expected a positive integer");
  return integer;
}

function requireZero(value, path) {
  const integer = requireCheckpointNonNegativeInteger(value, path);
  if (integer !== 0) checkpointValidationFailure(path, `expected 0, got ${integer}`);
  return integer;
}

export function validateSmbReadyCheckpointOptions(
  profile = SUPER_MONKEY_BALL_READY_CHECKPOINT,
  path = "$expected",
) {
  assertCheckpointJsonValue(profile, path);
  requireExactKeys(profile, ["schema", "id", "game", "run"], path);
  requireExact(profile.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA_V3, `${path}.schema`);
  requireExact(
    profile.id,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.id,
    `${path}.id`,
  );

  const game = requireExactKeys(
    profile.game,
    ["identifier", "revision", "image"],
    `${path}.game`,
  );
  requireExact(
    game.identifier,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game.identifier,
    `${path}.game.identifier`,
  );
  requireExact(
    game.revision,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game.revision,
    `${path}.game.revision`,
  );
  const image = requireExactKeys(
    game.image,
    ["algorithm", "format", "sha256"],
    `${path}.game.image`,
  );
  for (const field of ["algorithm", "format", "sha256"]) {
    requireExact(
      image[field],
      SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image[field],
      `${path}.game.image.${field}`,
    );
  }

  const run = requireExactKeys(
    profile.run,
    ["scenario", "renderEvery", "renderer", "temporalXfbCapacity", "cleanRunsRequired"],
    `${path}.run`,
  );
  for (const field of [
    "scenario",
    "renderEvery",
    "renderer",
    "temporalXfbCapacity",
    "cleanRunsRequired",
  ]) {
    requireExact(
      run[field],
      SUPER_MONKEY_BALL_READY_CHECKPOINT.run[field],
      `${path}.run.${field}`,
    );
  }
  return profile;
}
