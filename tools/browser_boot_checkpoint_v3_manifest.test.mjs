// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROWSER_BOOT_CHECKPOINT_FIELDS_V3,
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  CheckpointMismatchError,
  CheckpointValidationError,
  SUPER_MONKEY_BALL_READY_CHECKPOINT,
  createCheckpointManifest,
  validateCheckpointManifest,
  verifyCheckpointReport,
} from "./browser_boot_checkpoint.mjs";
import {
  reportsForConsensus,
} from "./browser_boot_checkpoint_fixture.mjs";
import {
  smbReadyPlayCheckpointReport,
} from "./browser_boot_checkpoint_v3_fixture.mjs";
import {
  deriveSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  deriveTemporalSelectedXfbOracle,
} from "./browser_boot_temporal_xfb.mjs";

function smbReadyReportsForConsensus() {
  return Array.from({ length: 3 }, (_unused, index) => {
    const report = smbReadyPlayCheckpointReport();
    report.headlessCapture.url =
      `http://127.0.0.1:8766/?scenario=smb-ready-play&headlessRun=fixture-${index + 1}`;
    report.runtime = `Fixture Browser/${index + 1}.0`;
    return report;
  });
}

function prettySha256(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(value, null, 2)}\n`)
    .digest("hex");
}

function expectCheckpointFailure(callback, path) {
  assert.throws(
    callback,
    error => error instanceof CheckpointValidationError && error.path === path,
  );
}

test("the public manifest API routes an exact cloned SMB ready profile to schema v3", () => {
  const reports = smbReadyReportsForConsensus();
  const profile = structuredClone(SUPER_MONKEY_BALL_READY_CHECKPOINT);
  const manifest = createCheckpointManifest(reports, profile);

  assert.equal(manifest.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA_V3);
  assert.deepEqual(manifest.fields, BROWSER_BOOT_CHECKPOINT_FIELDS_V3);
  assert.equal(manifest.consensus.cleanRuns, 3);
  assert.equal(
    manifest.sha256,
    "b1fda70448f54e03a36231d8c2b5a40d6223ffa23f90072101b0e73d16257010",
  );
  assert.equal(validateCheckpointManifest(manifest), manifest);
  assert.equal(verifyCheckpointReport(reports[2], manifest).sha256, manifest.sha256);
  assert.equal(JSON.stringify(manifest).includes("headlessRun"), false);
  assert.equal(JSON.stringify(manifest).includes("fixture-1"), false);
});

test("schema v3 manifests reproject their transcript and temporal state exactly", () => {
  const manifest = createCheckpointManifest(
    smbReadyReportsForConsensus(),
    SUPER_MONKEY_BALL_READY_CHECKPOINT,
  );

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
});

test("schema v3 consensus requires three unique fresh headless runs", () => {
  const reports = smbReadyReportsForConsensus();
  expectCheckpointFailure(
    () => createCheckpointManifest(
      reports.slice(0, 2),
      SUPER_MONKEY_BALL_READY_CHECKPOINT,
    ),
    "$runs",
  );

  const missing = smbReadyReportsForConsensus();
  missing[0].headlessCapture.url =
    "http://127.0.0.1:8766/?scenario=smb-ready-play";
  expectCheckpointFailure(
    () => createCheckpointManifest(missing, SUPER_MONKEY_BALL_READY_CHECKPOINT),
    "$runs[0].headlessCapture.url",
  );

  const duplicate = smbReadyReportsForConsensus();
  duplicate[1].headlessCapture.url = duplicate[0].headlessCapture.url;
  expectCheckpointFailure(
    () => createCheckpointManifest(duplicate, SUPER_MONKEY_BALL_READY_CHECKPOINT),
    "$runs[1].headlessCapture.url",
  );

  const reused = smbReadyReportsForConsensus();
  reused[2].headlessCapture.reuse = { previous: {} };
  expectCheckpointFailure(
    () => createCheckpointManifest(reused, SUPER_MONKEY_BALL_READY_CHECKPOINT),
    "$runs[2].headlessCapture.reuse",
  );
});

test("schema v3 report mismatches retain transcript and temporal evidence paths", () => {
  const reports = smbReadyReportsForConsensus();
  const manifest = createCheckpointManifest(
    reports,
    SUPER_MONKEY_BALL_READY_CHECKPOINT,
  );

  const gameplayChanged = structuredClone(reports[0]);
  gameplayChanged.scenario.steps[0].readyState.menuSelection += 1;
  gameplayChanged.gameplayTranscript =
    deriveSmbReadyPlayGameplayTranscript(gameplayChanged);
  assert.throws(
    () => verifyCheckpointReport(gameplayChanged, manifest),
    error => error instanceof CheckpointMismatchError
      && error.path
        === "$state.gameplayTranscript.steps[0].ready.witness.menuSelection",
  );

  const temporalChanged = structuredClone(reports[1]);
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
});

test("unknown schema v3 identities fail closed while the default API stays v2", () => {
  const unknown = structuredClone(SUPER_MONKEY_BALL_READY_CHECKPOINT);
  unknown.id = "smb-usa/unknown";
  expectCheckpointFailure(
    () => createCheckpointManifest(smbReadyReportsForConsensus(), unknown),
    "$expected.id",
  );

  const manifest = createCheckpointManifest(reportsForConsensus());
  assert.equal(manifest.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA);
  assert.equal(
    prettySha256(manifest),
    "24a7dcb057d5890bcce2b11d1c068f82dc0e3564f7e626542a5ba9fa83ad3762",
  );
});

test("the CLI selects schema v3 only for --profile smb-ready-play", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazuli-checkpoint-v3-cli-"));
  const output = join(directory, "manifest.json");
  try {
    const inputs = smbReadyReportsForConsensus().map((report, index) => {
      const path = join(directory, `run-${index + 1}.json`);
      writeFileSync(path, JSON.stringify(report));
      return path;
    });
    const command = fileURLToPath(
      new URL("./browser_boot_checkpoint.mjs", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [command, ...inputs, "--profile", "smb-ready-play", "--output", output],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA_V3);
    assert.equal(validateCheckpointManifest(manifest), manifest);

    const unknown = spawnSync(
      process.execPath,
      [command, ...inputs, "--profile", "unknown"],
      { encoding: "utf8" },
    );
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown checkpoint profile "unknown"/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
