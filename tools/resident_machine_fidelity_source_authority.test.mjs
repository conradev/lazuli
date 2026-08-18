// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  PRODUCTION_SOURCE_PATHS,
  productionSourceAuthorityFromGit,
  validateProductionSourceAuthorityRecords,
  validateResidentFidelityEvidenceLock,
} from "./resident_machine_fidelity_lock.mjs";

const execFileAsync = promisify(execFile);
const CAPTURE_TRANSITIVE_SOURCE_PATHS = Object.freeze([
  "web/release.mjs",
  "tools/browser_boot_headless_cdp.mjs",
  "tools/browser_game_compatibility_corpus.mjs",
  "tools/browser_boot_devtools_socket.mjs",
  "tools/browser_boot_disc_identity.mjs",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function git(repository, ...arguments_) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repository, ...arguments_],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

async function commitAll(repository, message) {
  await git(repository, "add", "--all");
  await git(
    repository,
    "-c",
    "user.name=Lazuli Source Authority Test",
    "-c",
    "user.email=lazuli-source-authority@example.invalid",
    "commit",
    "--quiet",
    "--message",
    message,
  );
  return git(repository, "rev-parse", "HEAD");
}

async function sourceRepository(t) {
  const directory = await mkdtemp(join(tmpdir(), "lazuli-source-authority-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  await mkdir(repository);
  await execFileAsync("git", ["init", "--quiet", repository]);
  const sourceBytes = new Map();
  for (const source of PRODUCTION_SOURCE_PATHS) {
    const bytes = Buffer.from(`committed source: ${source}\n`);
    sourceBytes.set(source, bytes);
    const destination = join(repository, source);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  const commit = await commitAll(repository, "complete production source fixture");
  return { directory, repository, commit, sourceBytes };
}

test("release-commit source authority ignores current-worktree mutation", async t => {
  const fixture = await sourceRepository(t);
  const authority = await productionSourceAuthorityFromGit(
    fixture.repository,
    fixture.commit,
  );
  assert.deepEqual(Object.keys(authority), [...PRODUCTION_SOURCE_PATHS]);
  for (const source of PRODUCTION_SOURCE_PATHS) {
    assert.equal(authority[source].bytes, fixture.sourceBytes.get(source).byteLength);
  }

  await writeFile(
    join(fixture.repository, PRODUCTION_SOURCE_PATHS[0]),
    Buffer.from("uncommitted substitution\n"),
  );
  assert.deepEqual(
    await productionSourceAuthorityFromGit(fixture.repository, fixture.commit),
    authority,
  );
});

test("source authority fails closed on commit, path, and shallow-history ambiguity", async t => {
  const fixture = await sourceRepository(t);
  await assert.rejects(
    productionSourceAuthorityFromGit(fixture.repository, "f".repeat(40)),
    /resolve the release commit/,
  );
  await assert.rejects(
    productionSourceAuthorityFromGit(fixture.repository, fixture.commit.toUpperCase()),
    /lowercase 40-hex commit/,
  );

  const shallow = join(fixture.directory, "shallow");
  await execFileAsync("git", [
    "clone",
    "--quiet",
    "--depth",
    "1",
    pathToFileURL(fixture.repository).href,
    shallow,
  ]);
  await assert.rejects(
    productionSourceAuthorityFromGit(shallow, fixture.commit),
    /refuses shallow repository history/,
  );

  const symlinkSource = PRODUCTION_SOURCE_PATHS[0];
  await unlink(join(fixture.repository, symlinkSource));
  await symlink("untrusted-target", join(fixture.repository, symlinkSource));
  const symlinkCommit = await commitAll(fixture.repository, "replace required source with symlink");
  await assert.rejects(
    productionSourceAuthorityFromGit(fixture.repository, symlinkCommit),
    new RegExp(`requires a regular blob for ${symlinkSource.replaceAll(".", "\\.")}`),
  );
  await unlink(join(fixture.repository, symlinkSource));
  await writeFile(join(fixture.repository, symlinkSource), fixture.sourceBytes.get(symlinkSource));
  await commitAll(fixture.repository, "restore required regular source");

  const missing = PRODUCTION_SOURCE_PATHS.at(-1);
  await unlink(join(fixture.repository, missing));
  const incompleteCommit = await commitAll(fixture.repository, "remove one required source");
  await assert.rejects(
    productionSourceAuthorityFromGit(fixture.repository, incompleteCommit),
    new RegExp(`malformed tree entry for ${missing.replaceAll(".", "\\.")}`),
  );
});

test("v3 source records require exact path order and release-commit byte records", async t => {
  const fixture = await sourceRepository(t);
  assert.deepEqual(
    PRODUCTION_SOURCE_PATHS.slice(-CAPTURE_TRANSITIVE_SOURCE_PATHS.length),
    [...CAPTURE_TRANSITIVE_SOURCE_PATHS],
  );
  const authority = await productionSourceAuthorityFromGit(
    fixture.repository,
    fixture.commit,
  );
  assert.equal(validateProductionSourceAuthorityRecords(authority, authority), authority);

  const wrongHash = structuredClone(authority);
  wrongHash[PRODUCTION_SOURCE_PATHS[0]].sha256 = "f".repeat(64);
  assert.throws(
    () => validateProductionSourceAuthorityRecords(wrongHash, authority),
    /did not match the expected production authority/,
  );

  const reordered = Object.fromEntries(Object.entries(authority).reverse());
  assert.throws(
    () => validateProductionSourceAuthorityRecords(reordered, authority),
    /expected exact ordered keys/,
  );

  const extra = { ...authority, "tools/untrusted-extra.mjs": authority[PRODUCTION_SOURCE_PATHS[0]] };
  assert.throws(
    () => validateProductionSourceAuthorityRecords(extra, authority),
    /expected exact ordered keys/,
  );

  for (const source of CAPTURE_TRANSITIVE_SOURCE_PATHS) {
    await writeFile(
      join(fixture.repository, source),
      Buffer.from(`committed transitive substitution: ${source}\n`),
    );
    const substitutedCommit = await commitAll(
      fixture.repository,
      `substitute transitive dependency ${source}`,
    );
    const substituted = await productionSourceAuthorityFromGit(
      fixture.repository,
      substitutedCommit,
    );
    assert.notDeepEqual(substituted[source], authority[source]);
    assert.throws(
      () => validateProductionSourceAuthorityRecords(substituted, authority),
      new RegExp(`\\$\\.sources\\.${escapeRegExp(source)}`),
    );
    await writeFile(join(fixture.repository, source), fixture.sourceBytes.get(source));
    await commitAll(fixture.repository, `restore transitive dependency ${source}`);
  }
});

test("v2 lock validation retains its existing source-record behavior", async () => {
  const lock = JSON.parse(await readFile(
    new URL("./resident_machine_fidelity_evidence_lock_legacy_fixture.json", import.meta.url),
    "utf8",
  ));
  assert.equal(validateResidentFidelityEvidenceLock(lock), lock);
  const reordered = structuredClone(lock);
  reordered.sources = Object.fromEntries(Object.entries(reordered.sources).reverse());
  assert.equal(validateResidentFidelityEvidenceLock(reordered), reordered);
});
