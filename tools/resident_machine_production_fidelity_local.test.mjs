// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalCaptureJson } from "./resident_machine_production_fidelity_capture.mjs";
import {
  PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  PRODUCTION_FIDELITY_EXECUTION_ROLES,
  PRODUCTION_SOURCE_PATHS,
  validateResidentProductionFidelityEvidenceLock,
} from "./resident_machine_fidelity_lock.mjs";
import {
  controlledPerformanceTargetFailure,
  localCapturePlan,
  localProductionFidelityFailure,
  parseLocalProductionFidelityArguments,
  parseServerReadyLine,
  productionCorpusEvidenceAuthority,
  productionCorpusEvidenceLock,
  productionRendererFidelityEvidenceLock,
  requireExactPlainDirectory,
  schemaOrderedLockBytes,
  startManagedProcess,
  validateCleanReleaseCheckout,
  waitForCompletedWatchdogState,
} from "./resident_machine_production_fidelity_local.mjs";

const SHA = "a".repeat(64);
const SOURCE_COMMIT = "b".repeat(40);
const PERFORMANCE_RUN_ID = "10000000-0000-4000-8000-000000000001";

function games() {
  return Array.from({ length: 7 }, (_value, index) => ({
    key: `game-${index + 1}`,
    priority: index + 1,
    file: `game-${index + 1}.ciso`,
    bytes: 1_000 + index,
    image: { format: "ciso", sha256: `${index + 1}`.repeat(64) },
    disc: { identifier: `GAME0${index + 1}`, revision: 0 },
  }));
}

function authority() {
  const executionAssets = Object.fromEntries(PRODUCTION_FIDELITY_EXECUTION_ROLES.map(role => [
    role,
    { url: `/assets/${role}.bin`, bytes: 10, sha256: SHA },
  ]));
  return {
    release: {
      schema: 4,
      releaseId: SHA,
      manifestBytes: 10,
      manifestSha256: SHA,
      sourceCommit: SOURCE_COMMIT,
      executionAssetsSha256: SHA,
      executionAssets,
    },
    run: { runId: PERFORMANCE_RUN_ID, gameKey: "game-1" },
    corpus: {
      workspacePath: "tools/compatibility/games/corpus.json",
      bytes: 10,
      sha256: SHA,
    },
    selectedGame: {
      key: "game-1",
      priority: 1,
      bytes: 1_000,
      image: { format: "ciso", sha256: "1".repeat(64) },
      disc: { identifier: "GAME01", revision: 0 },
    },
    artifacts: {
      "browser_machine.wasm": { bytes: 10, sha256: SHA },
      "resident_dispatcher.wasm": { bytes: 10, sha256: SHA },
      "core_run_coordinator.wasm": { bytes: 10, sha256: SHA },
      "browser_renderer.js": { bytes: 10, sha256: SHA },
      "browser_renderer_bg.wasm": { bytes: 10, sha256: SHA },
    },
    sources: Object.fromEntries(PRODUCTION_SOURCE_PATHS.map(source => [
      source,
      { bytes: 10, sha256: SHA },
    ])),
  };
}

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("managed processes without readiness preserve clean and nonzero exits", async () => {
  for (const code of [0, 7]) {
    const child = fakeChildProcess();
    const managed = startManagedProcess("fake", [String(code)], `fake ${code}`, {
      spawnImpl: () => child,
      firstLine: false,
    });
    assert.equal(managed.firstLinePromise, null);
    assert.doesNotThrow(() => child.emit("exit", code, null));
    assert.deepEqual(await managed.exitPromise, { code, signal: null });
  }
});

test("managed process errors remain handled before delayed observation", async t => {
  const child = fakeChildProcess();
  const managed = startManagedProcess("fake", [], "error fake", {
    spawnImpl: () => child,
    firstLine: false,
  });
  const failure = new Error("spawn failed without readiness");
  const exitPromise = managed.exitPromise;
  const unhandled = [];
  const observeUnhandled = (reason, promise) => unhandled.push({ reason, promise });
  process.on("unhandledRejection", observeUnhandled);
  t.after(() => process.off("unhandledRejection", observeUnhandled));
  assert.equal(managed.firstLinePromise, null);
  assert.doesNotThrow(() => child.emit("error", failure));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(unhandled, []);
  assert.equal(managed.exitPromise, exitPromise);
  await assert.rejects(exitPromise, error => error === failure);
});

test("managed readiness resolves its first complete line", async () => {
  const child = fakeChildProcess();
  const managed = startManagedProcess("fake", [], "ready fake", {
    spawnImpl: () => child,
    firstLine: true,
  });
  child.stdout.emit("data", "http://127.0.0.1:");
  child.stdout.emit("data", "8123/\nignored\n");
  assert.equal(await managed.firstLinePromise, "http://127.0.0.1:8123/");
  child.emit("exit", 0, null);
  assert.deepEqual(await managed.exitPromise, { code: 0, signal: null });
});

test("managed readiness and exit reject the same pre-readiness process error", async () => {
  const child = fakeChildProcess();
  const managed = startManagedProcess("fake", [], "failing fake", {
    spawnImpl: () => child,
    firstLine: true,
  });
  const failure = new Error("spawn failed");
  const readinessFailure = assert.rejects(managed.firstLinePromise, error => error === failure);
  const exitFailure = assert.rejects(managed.exitPromise, error => error === failure);
  assert.doesNotThrow(() => child.emit("error", failure));
  await Promise.all([readinessFailure, exitFailure]);
});

test("managed readiness preserves the exact exit-before-readiness failure", async () => {
  const child = fakeChildProcess();
  const managed = startManagedProcess("fake", [], "early fake", {
    spawnImpl: () => child,
    firstLine: true,
  });
  child.stderr.emit("data", "startup failed");
  const readinessFailure = assert.rejects(
    managed.firstLinePromise,
    /early fake exited before readiness \(code=7, signal=null\): startup failed/,
  );
  assert.doesNotThrow(() => child.emit("exit", 7, null));
  assert.deepEqual(await managed.exitPromise, { code: 7, signal: null });
  await readinessFailure;
});

test("local controller emits canonical production v2 and schema-ordered v3 locks", () => {
  const base = authority();
  const corpusGames = games();
  const performanceAuthority = productionCorpusEvidenceAuthority({
    authority: base,
    runId: PERFORMANCE_RUN_ID,
    games: corpusGames,
  });
  const performanceLock = productionCorpusEvidenceLock({
    authority: base,
    runId: PERFORMANCE_RUN_ID,
    games: corpusGames,
  });
  assert.deepEqual(performanceLock.release, performanceAuthority.release);
  assert.deepEqual(performanceAuthority.sources, base.sources);
  assert.deepEqual(Object.keys(performanceLock.sources), [...PRODUCTION_SOURCE_PATHS]);
  assert.equal(performanceLock.runPolicy.bootTimeoutMs, 120_000);
  assert.equal(performanceLock.runPolicy.sliceTimeoutMs, 120_000);
  assert.equal(performanceLock.runPolicy.windowTimeoutMs, 120_000);
  assert.equal(performanceLock.runPolicy.cycleUpperCap, "1000000");
  assert.equal(performanceLock.runPolicy.maxColdInstalls, 65_535);
  const performanceBytes = Buffer.from(canonicalCaptureJson(performanceLock));
  assert.equal(performanceBytes.toString(), canonicalCaptureJson(JSON.parse(performanceBytes)));

  const fidelityLock = productionRendererFidelityEvidenceLock(base);
  assert.equal(fidelityLock.schema, PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA);
  assert.equal(
    fidelityLock.runPolicy.executedCycleUpperCap,
    PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  );
  assert.equal(
    fidelityLock.runPolicy.totalColdInstallCap,
    PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  );
  assert.equal(validateResidentProductionFidelityEvidenceLock(fidelityLock, base), fidelityLock);
  const staleCycleAuthority = structuredClone(fidelityLock);
  staleCycleAuthority.runPolicy.executedCycleUpperCap = "250000000";
  assert.throws(
    () => validateResidentProductionFidelityEvidenceLock(staleCycleAuthority, base),
    /executedCycleUpperCap/,
  );
  const fidelityBytes = schemaOrderedLockBytes(fidelityLock);
  assert.deepEqual(Object.keys(JSON.parse(fidelityBytes).sources), [...PRODUCTION_SOURCE_PATHS]);
  assert.equal(fidelityBytes.at(-1), "}".charCodeAt(0));
});

test("local capture plan binds port-zero results to exact seven ordered runs", () => {
  const corpusGames = games();
  const planGames = corpusGames.map(game => ({
    key: game.key,
    evidenceLock: `inputs/0${game.priority}-${game.key}/evidence-lock.json`,
    checkpointJournal: `inputs/0${game.priority}-${game.key}/checkpoint-journal.jsonl`,
    captureUrl:
      `http://127.0.0.1:${8_100 + game.priority}/tools/resident_machine_first_frame.html`
      + `?capture=fidelity&game=${game.key}`,
  }));
  const plan = localCapturePlan({
    cdpEndpoint: "http://127.0.0.1:9222/",
    performanceRunId: PERFORMANCE_RUN_ID,
    games: planGames,
  }, corpusGames);
  assert.equal(plan.games.length, 7);
  assert.equal(plan.controlledPerformance.lock, "performance/lock.json");
  assert.equal(canonicalCaptureJson(plan), canonicalCaptureJson(JSON.parse(canonicalCaptureJson(plan))));

  const ready = parseServerReadyLine(JSON.stringify({
    ok: true,
    url: "http://127.0.0.1:8123/",
    selectedGames: ["game-1"],
  }), { label: "game-1 server", expectedGames: ["game-1"] });
  assert.equal(ready.url.port, "8123");
  assert.throws(() => parseServerReadyLine(JSON.stringify({
    ok: true,
    url: "http://127.0.0.1:8123/",
    selectedGames: ["game-2"],
  }), { label: "game-1 server", expectedGames: ["game-1"] }), /selected games changed/);
});

test("local CLI accepts only exact absolute cold-start inputs", () => {
  const values = [
    "--candidate-dist", "/candidate",
    "--repository", "/repository",
    "--corpus", "/repository/tools/compatibility/games/corpus.json",
    "--games", "/games",
    "--capture-root", "/private/capture",
    "--output-directory", "/private/capture/evidence",
    "--chrome", "/Applications/Chrome",
  ];
  const parsed = parseLocalProductionFidelityArguments(values);
  assert.equal(parsed.python, "python3");
  assert.throws(
    () => parseLocalProductionFidelityArguments([...values, "--games", "/other"]),
    /supplied more than once/,
  );
  const relative = [...values];
  relative[relative.indexOf("--games") + 1] = "games";
  assert.throws(() => parseLocalProductionFidelityArguments(relative), /must be an absolute path/);
});

test("release checkout validation binds clean HEAD to the candidate commit", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const replies = new Map([
    ["rev-parse --show-toplevel", directory],
    ["rev-parse --is-shallow-repository", "false"],
    ["rev-parse HEAD", SOURCE_COMMIT],
    ["status --porcelain=v1 --untracked-files=all", ""],
  ]);
  const execFileImpl = async (_command, arguments_) => ({
    stdout: `${replies.get(arguments_.slice(3).join(" "))}\n`,
  });
  const clean = await validateCleanReleaseCheckout({
    repository: directory,
    release: { source: { commit: SOURCE_COMMIT } },
  }, { execFileImpl });
  assert.equal(clean.commit, SOURCE_COMMIT);

  replies.set("status --porcelain=v1 --untracked-files=all", "?? substituted");
  await assert.rejects(validateCleanReleaseCheckout({
    repository: directory,
    release: { source: { commit: SOURCE_COMMIT } },
  }, { execFileImpl }), /exactly clean checkout/);
});

test("authority directories reject a symlinked ancestor", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const real = path.join(directory, "real");
  const leaf = path.join(real, "leaf");
  const alias = path.join(directory, "alias");
  await mkdir(leaf, { recursive: true });
  await symlink(real, alias);
  await assert.rejects(
    requireExactPlainDirectory(path.join(alias, "leaf"), "games root"),
    /must not traverse a symlink component/,
  );
});

test("cleanup failures retain the primary error identity and ordering", () => {
  const primary = new Error("capture failed");
  const firstCleanup = new Error("watchdog teardown failed");
  const secondCleanup = new Error("Chrome teardown failed");
  assert.equal(localProductionFidelityFailure(primary, []), primary);
  const combined = localProductionFidelityFailure(
    primary,
    [firstCleanup, secondCleanup],
  );
  assert.ok(combined instanceof AggregateError);
  assert.deepEqual(combined.errors, [primary, firstCleanup, secondCleanup]);
  const targetClose = controlledPerformanceTargetFailure(primary, firstCleanup);
  assert.ok(targetClose instanceof AggregateError);
  assert.deepEqual(targetClose.errors, [primary, firstCleanup]);
});

test("watchdog completion authenticates durable state after a clean process exit", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-complete-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.json");
  const expectedUrl = "http://127.0.0.1:8123/tools/resident_machine_first_frame.html"
    + "?capture=fidelity&game=game-1";
  await writeFile(statePath, JSON.stringify({
    status: "completed-before-deadline",
    expectedUrl,
  }));
  const managed = {
    label: "exited test watchdog",
    child: { exitCode: 0, signalCode: null },
    exitPromise: Promise.resolve({ code: 0, signal: null }),
  };
  const terminal = await waitForCompletedWatchdogState({
    managed,
    statePath,
    expectedUrl,
    timeoutMs: 100,
  });
  assert.equal(terminal.status, "completed-before-deadline");
});
