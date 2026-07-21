// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
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
  BROWSER_BOOT_CHECKPOINT_FIELDS,
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  CheckpointMismatchError,
  CheckpointValidationError,
  SUPER_MONKEY_BALL_CHECKPOINT,
  createCheckpointCandidate,
  createCheckpointManifest,
  readCheckpointManifest,
  validateCheckpointManifest,
  verifyCheckpointReport,
} from "./browser_boot_checkpoint.mjs";
import {
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V1,
  checkpointFieldsForSchema,
} from "./browser_boot_checkpoint_core.mjs";
import {
  reportsForConsensus,
} from "./browser_boot_checkpoint_fixture.mjs";

test("three clean reports bless one host-independent checkpoint manifest", () => {
  const reports = reportsForConsensus();
  const candidates = reports.map(report => createCheckpointCandidate(report));
  assert.equal(new Set(candidates.map(candidate => candidate.sha256)).size, 1);

  const manifest = createCheckpointManifest(reports);
  assert.equal(manifest.consensus.cleanRuns, 3);
  assert.equal(manifest.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA);
  assert.deepEqual(manifest.fields, BROWSER_BOOT_CHECKPOINT_FIELDS);
  assert.equal(manifest.game.identifier, "GMBE8P");
  assert.equal(manifest.id, "smb-usa/no-input/cycles-1500000000/render-every-1");
  assert.deepEqual(manifest.game.image, {
    algorithm: "sha256",
    format: "ciso",
    sha256: "441a0eadc85afb501e2a3db5af2ee81d4783b96a58f6a2df2605f5c33dcb6202",
  });
  assert.equal(manifest.checkpoint.cycles, 1_500_000_000);
  assert.equal(manifest.run.renderEvery, 1);
  assert.equal(manifest.run.renderer, "wgpu-webgpu");
  assert.deepEqual(manifest.run.inputs, []);
  assert.equal(manifest.run.cleanRunsRequired, 3);
  assert.equal(manifest.state.deviceEvents, undefined);
  assert.equal(manifest.state.runtime, undefined);
  assert.equal(manifest.state.headlessCapture, undefined);
  assert.equal(manifest.state.rendering.backend, "wgpu-webgpu");
  assert.equal(manifest.state.rendering.selectedXfb.generation, 142);
  assert.equal(manifest.state.execution.scheduler.rendererSync.waits, undefined);
  assert.equal(verifyCheckpointReport(reports[2], manifest).sha256, manifest.sha256);
  assert.deepEqual(SUPER_MONKEY_BALL_CHECKPOINT.run.inputs, []);
});

test("checkpoint mismatches name the first meaningful state path", () => {
  const reports = reportsForConsensus();
  const manifest = createCheckpointManifest(reports);
  const changedRegister = structuredClone(reports[0]);
  changedRegister.cpuState.gpr.r7 = "0x12345678";
  assert.throws(
    () => verifyCheckpointReport(changedRegister, manifest),
    error => error instanceof CheckpointMismatchError
      && error.path === "$state.cpuState.gpr.r7",
  );

  const changed = structuredClone(reports[0]);
  changed.cpuState.signature = "0x12345678";
  assert.throws(
    () => verifyCheckpointReport(changed, manifest),
    error => {
      assert.ok(error instanceof CheckpointMismatchError);
      assert.equal(error.path, "$state.cpuState.signature");
      assert.match(error.message, /expected "0xcc536b5b", got "0x12345678"/);
      return true;
    },
  );

  const changedPixels = structuredClone(reports[0]);
  changedPixels.rendering.selectedXfb.rgbaSha256 = "1".repeat(64);
  assert.throws(
    () => verifyCheckpointReport(changedPixels, manifest),
    error => error instanceof CheckpointMismatchError
      && error.path === "$state.rendering.selectedXfb.rgbaSha256",
  );
});

test("schema-1 manifests remain verifiable while visual goldens use schema 2", () => {
  const reports = reportsForConsensus();
  const candidate = createCheckpointCandidate(
    reports[0],
    SUPER_MONKEY_BALL_CHECKPOINT,
    BROWSER_BOOT_CHECKPOINT_SCHEMA_V1,
  );
  const manifest = {
    ...candidate,
    consensus: { cleanRuns: 3 },
  };
  assert.deepEqual(
    manifest.fields,
    checkpointFieldsForSchema(BROWSER_BOOT_CHECKPOINT_SCHEMA_V1),
  );
  assert.equal(validateCheckpointManifest(manifest), manifest);
  assert.equal(verifyCheckpointReport(reports[1], manifest).sha256, manifest.sha256);
});

test("goldens require three identical clean reports", () => {
  const reports = reportsForConsensus();
  assert.throws(
    () => createCheckpointManifest(reports.slice(0, 2)),
    /at least 3 clean reports/,
  );

  reports[2].gxFifo.hash = "0x12345678";
  assert.throws(
    () => createCheckpointManifest(reports),
    error => error instanceof CheckpointMismatchError
      && error.path === "$runs[2].state.gxFifo.hash",
  );
});

test("manifest validation protects metadata, field contract, and stored digest", () => {
  const manifest = createCheckpointManifest(reportsForConsensus());
  const missingField = structuredClone(manifest);
  missingField.fields.pop();
  assert.throws(
    () => validateCheckpointManifest(missingField),
    error => error instanceof CheckpointValidationError
      && error.path === `$manifest.fields[${BROWSER_BOOT_CHECKPOINT_FIELDS.length - 1}]`,
  );

  const missingImageAlgorithm = structuredClone(manifest);
  delete missingImageAlgorithm.game.image.algorithm;
  assert.throws(
    () => validateCheckpointManifest(missingImageAlgorithm),
    error => error instanceof CheckpointValidationError
      && error.path === "$manifest.game.image.algorithm",
  );

  const tampered = structuredClone(manifest);
  tampered.state.cpuState.signature = "0x12345678";
  assert.throws(
    () => validateCheckpointManifest(tampered),
    /\$manifest\.sha256: manifest state hashes to/,
  );
});

test("manifest reader validates parsed checkpoint JSON", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazuli-checkpoint-read-"));
  const path = join(directory, "checkpoint.json");
  try {
    const manifest = createCheckpointManifest(reportsForConsensus());
    writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    assert.deepEqual(await readCheckpointManifest(path), manifest);

    writeFileSync(path, "{not-json\n");
    await assert.rejects(
      () => readCheckpointManifest(path),
      /is not valid JSON/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("checkpoint CLI preserves its public path and writes a validated manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazuli-checkpoint-cli-"));
  const output = join(directory, "manifest.json");
  try {
    const inputs = reportsForConsensus().map((report, index) => {
      const path = join(directory, `run-${index + 1}.json`);
      writeFileSync(path, JSON.stringify(report));
      return path;
    });
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./browser_boot_checkpoint.mjs", import.meta.url)),
        ...inputs,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${output}\n`);
    validateCheckpointManifest(JSON.parse(readFileSync(output, "utf8")));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
