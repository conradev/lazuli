// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V1,
  SUPER_MONKEY_BALL_CHECKPOINT,
  createCheckpointCandidate,
} from "./browser_boot_checkpoint_core.mjs";
import { checkpointReport } from "./browser_boot_checkpoint_fixture.mjs";
import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "lazuli-disc-identity-"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("local CISO identity streams the complete container into SHA-256", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "renamed-game.bin");
    const bytes = Buffer.alloc(256 * 1024 + 37);
    bytes.write("CISO", 0, "ascii");
    for (let index = 4; index < bytes.length; index += 1) bytes[index] = index % 251;
    writeFileSync(path, bytes);

    const identity = await identifyLocalDiscImage(path);
    assert.deepEqual(identity, {
      algorithm: "sha256",
      format: "ciso",
      sha256: sha256(bytes),
    });
    assert.equal(Object.isFrozen(identity), true);
    assert.deepEqual(Object.keys(identity), ["algorithm", "format", "sha256"]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("raw GameCube ISO identity is detected by content instead of its path", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "game.ciso");
    const bytes = Buffer.alloc(96 * 1024, 0x5a);
    bytes.writeUInt32BE(0xc233_9f3d, 0x1c);
    writeFileSync(path, bytes);

    assert.deepEqual(await identifyLocalDiscImage(path), {
      algorithm: "sha256",
      format: "iso",
      sha256: sha256(bytes),
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("unknown and unreadable local images fail closed", async () => {
  const directory = temporaryDirectory();
  try {
    const unknown = join(directory, "unknown.ciso");
    writeFileSync(unknown, Buffer.alloc(0x20, 0xff));
    await assert.rejects(
      () => identifyLocalDiscImage(unknown),
      /unsupported --disc image format/,
    );
    await assert.rejects(
      () => identifyLocalDiscImage(join(directory, "missing.ciso")),
      /ENOENT/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the headless CLI rejects unknown content before contacting Chrome", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "unknown.ciso");
    writeFileSync(path, Buffer.alloc(0x20, 0xff));
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./browser_boot_headless.mjs", import.meta.url)),
      "--url",
      "http://127.0.0.1:8766/",
      "--endpoint",
      "http://127.0.0.1:1/",
      "--disc",
      path,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported --disc image format/);
    assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("disc evidence leaves checkpoint v1 and v2 defaults and hashes unchanged", () => {
  const report = checkpointReport();
  report.headlessCapture.discImage = {
    algorithm: "sha256",
    format: "ciso",
    sha256: "a".repeat(64),
  };
  assert.equal(BROWSER_BOOT_CHECKPOINT_SCHEMA, "lazuli-browser-boot-checkpoint-v2");
  assert.deepEqual(SUPER_MONKEY_BALL_CHECKPOINT.game.image, {
    algorithm: "sha256",
    format: "ciso",
    sha256: "441a0eadc85afb501e2a3db5af2ee81d4783b96a58f6a2df2605f5c33dcb6202",
  });
  assert.equal(
    createCheckpointCandidate(
      report,
      SUPER_MONKEY_BALL_CHECKPOINT,
      BROWSER_BOOT_CHECKPOINT_SCHEMA_V1,
    ).sha256,
    "1122c179bd0e259c3170082bd8e24b39145f57b3bff1cf725084d2877918198f",
  );
  assert.equal(
    createCheckpointCandidate(report).sha256,
    "4b0bbb7796319d5a87072aaa9ca8e38ad938947a6d7a20e6cbed2e3260f9d0b1",
  );
});

test("identity implementation uses a stream instead of buffering the image", () => {
  const source = readFileSync(
    new URL("./browser_boot_disc_identity.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /createReadStream\(path\)/);
  assert.match(source, /for await \(const chunk of createReadStream\(path\)\)/);
  assert.doesNotMatch(source, /readFile/);
});
