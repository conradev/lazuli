// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalCaptureJson } from "./resident_machine_production_fidelity_capture.mjs";
import {
  PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  PRODUCTION_FIDELITY_EXECUTION_ROLES,
  PRODUCTION_SOURCE_PATHS,
  validateResidentProductionFidelityEvidenceLock,
} from "./resident_machine_fidelity_lock.mjs";
import {
  PRODUCTION_FIDELITY_WALL_DEADLINE_ERROR_CODE,
  ProductionFidelityWallDeadlineError,
  WATCHDOG_COMPLETION_SCHEMA,
  WATCHDOG_STATE_SCHEMA,
  controlledPerformanceTargetFailure,
  finishWatchdog,
  formatProductionFidelityFailure,
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
  validateArmedWatchdogState,
  validateCleanReleaseCheckout,
  waitForCompletedWatchdogState,
  waitForTerminalWatchdogState,
} from "./resident_machine_production_fidelity_local.mjs";

const SHA = "a".repeat(64);
const SOURCE_COMMIT = "b".repeat(40);
const PERFORMANCE_RUN_ID = "10000000-0000-4000-8000-000000000001";
const WATCHDOG_START_UNIX_MS = 1_800_000_000_000;
const WATCHDOG_DEADLINE_UNIX_MS = WATCHDOG_START_UNIX_MS + 600_000;
const WATCHDOG_URL = "http://127.0.0.1:8123/tools/resident_machine_first_frame.html"
  + "?capture=fidelity&game=game-1";
const WATCHDOG_BROWSER_IDENTITY = "Chrome --user-data-dir=/private/watchdog-profile";
const WATCHDOG_SERVER_IDENTITY = "python resident_machine_fidelity_server.py --port 0";

function watchdogArmedState(changes = {}) {
  return {
    schema: WATCHDOG_STATE_SCHEMA,
    status: "armed-before-navigation",
    startUnixMs: WATCHDOG_START_UNIX_MS,
    deadlineUnixMs: WATCHDOG_DEADLINE_UNIX_MS,
    expectedUrl: WATCHDOG_URL,
    browserPid: 101,
    browserIdentity: WATCHDOG_BROWSER_IDENTITY,
    serverPid: 202,
    serverIdentity: WATCHDOG_SERVER_IDENTITY,
    cleanupIndependentOfPageMainThread: true,
    ...changes,
  };
}

function watchdogArmedAuthority(changes = {}) {
  return {
    startUnixMs: WATCHDOG_START_UNIX_MS,
    deadlineUnixMs: WATCHDOG_DEADLINE_UNIX_MS,
    expectedUrl: WATCHDOG_URL,
    browserPid: 101,
    serverPid: 202,
    browserIdentityFragment: "/private/watchdog-profile",
    serverIdentityFragment: "resident_machine_fidelity_server.py",
    ...changes,
  };
}

function completedWatchdogState(armed, completionSha256, changes = {}) {
  return {
    ...armed,
    status: "completed-before-deadline",
    completionUnixMs: WATCHDOG_DEADLINE_UNIX_MS - 1,
    completionSha256,
    browserCleanup: "left-running-for-next-capture",
    serverCleanup: "left-running-for-graceful-capture",
    ...changes,
  };
}

function failedWatchdogState(armed, status, changes = {}) {
  const controllerTerminated = status === "controller-terminated-before-completion";
  return {
    ...armed,
    status,
    cleanupUnixMs: WATCHDOG_DEADLINE_UNIX_MS,
    browserCleanup: controllerTerminated
      ? "left-running-for-controller-cleanup"
      : "sigkill-confirmed-exited",
    serverCleanup: controllerTerminated
      ? "left-running-for-controller-cleanup"
      : "left-running-for-journal-recovery-and-graceful-capture",
    ...changes,
  };
}

async function writePrivateWatchdogState(statePath, value, mode = 0o600) {
  await writeFile(statePath, JSON.stringify(value), { mode });
  await chmod(statePath, mode);
}

function exitedWatchdog(exit = { code: 0, signal: null }) {
  return {
    label: "test watchdog",
    child: {
      exitCode: exit.code,
      signalCode: exit.signal,
      kill: () => assert.fail("an exited watchdog must not be signalled"),
    },
    exitPromise: Promise.resolve(exit),
  };
}

function liveWatchdog(onSignal) {
  let resolveExit;
  let rejectExit;
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      Promise.resolve(onSignal(signal)).then(exit => {
        child.exitCode = exit.code;
        child.signalCode = exit.signal;
        resolveExit(exit);
      }, rejectExit);
      return true;
    },
  };
  const exitPromise = new Promise((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  return { label: "live test watchdog", child, exitPromise, signals };
}

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
    fidelityLock.runPolicy.instructionUpperCap,
    PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  );
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
  const staleInstructionAuthority = structuredClone(fidelityLock);
  staleInstructionAuthority.runPolicy.instructionUpperCap = "100000000";
  assert.throws(
    () => validateResidentProductionFidelityEvidenceLock(staleInstructionAuthority, base),
    /instructionUpperCap/,
  );
  const staleOperatorAuthority = structuredClone(fidelityLock);
  staleOperatorAuthority.capturePolicy.genericOperatorPolicy.maximumPublications = 64;
  assert.throws(
    () => validateResidentProductionFidelityEvidenceLock(staleOperatorAuthority, base),
    /genericOperatorPolicy/,
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

test("CLI failure formatting recursively preserves aggregate order and typed deadline details", () => {
  const armed = watchdogArmedState();
  const deadline = new ProductionFidelityWallDeadlineError(
    "game-1",
    failedWatchdogState(armed, "deadline-enforced"),
  );
  const primary = new Error("capture Runtime.evaluate connection closed");
  const targetCleanup = new Error("Target.closeTarget connection closed");
  const nested = new AggregateError(
    [primary, deadline],
    "capture and watchdog lifecycle failed",
  );
  const outer = new AggregateError(
    [nested, targetCleanup, deadline],
    "capture and target cleanup failed",
  );
  const formatted = formatProductionFidelityFailure(outer);
  const primaryIndex = formatted.indexOf("capture Runtime.evaluate connection closed");
  const deadlineIndex = formatted.indexOf("production fidelity fixed 600000 ms wall deadline");
  const cleanupIndex = formatted.indexOf("Target.closeTarget connection closed");
  assert.ok(primaryIndex > 0);
  assert.ok(deadlineIndex > primaryIndex);
  assert.ok(cleanupIndex > deadlineIndex);
  assert.match(
    formatted,
    /failure\.errors\[0\]\.errors\[1\]\.code: ERR_PRODUCTION_FIDELITY_WALL_DEADLINE/,
  );
  assert.match(formatted, /failure\.errors\[0\]\.errors\[1\]\.gameKey: game-1/);
  assert.match(
    formatted,
    /failure\.errors\[2\]: \[same failure object as failure\.errors\[0\]\.errors\[1\]\]/,
  );
});

test("watchdog armed state is exact and bound to controller authority", () => {
  const armedValue = watchdogArmedState();
  const authorityValue = watchdogArmedAuthority();
  const armed = validateArmedWatchdogState(armedValue, authorityValue);
  assert.deepEqual(armed, armedValue);
  assert.equal(Object.isFrozen(armed), true);

  for (const [label, mutate, pattern] of [
    ["extra key", value => { value.extra = true; }, /exact field set/],
    ["schema", value => { value.schema = "stale"; }, /schema changed/],
    ["status", value => { value.status = "deadline-enforced"; }, /status changed/],
    ["deadline", value => { value.deadlineUnixMs += 1; }, /not exactly start/],
    ["URL", value => { value.expectedUrl += "&extra=1"; }, /expectedUrl changed/],
    ["browser PID", value => { value.browserPid += 1; }, /browserPid changed/],
    ["server PID", value => { value.serverPid += 1; }, /serverPid changed/],
    ["browser identity", value => { value.browserIdentity = "Chrome"; }, /browserIdentity changed/],
    ["server identity", value => { value.serverIdentity = "python"; }, /serverIdentity changed/],
    ["cleanup flag", value => {
      value.cleanupIndependentOfPageMainThread = false;
    }, /cleanup independence changed/],
  ]) {
    const changed = watchdogArmedState();
    mutate(changed);
    assert.throws(
      () => validateArmedWatchdogState(changed, authorityValue),
      pattern,
      label,
    );
  }
});

test("watchdog completion authenticates exact state after a clean exit", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-complete-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.json");
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  const completionSha256 = "c".repeat(64);
  await writePrivateWatchdogState(
    statePath,
    completedWatchdogState(armed, completionSha256),
  );
  const terminal = await waitForCompletedWatchdogState({
    managed: exitedWatchdog(),
    statePath,
    armed,
    expectedUrl: WATCHDOG_URL,
    expectedCompletionSha256: completionSha256,
    timeoutMs: 100,
  });
  assert.equal(terminal.status, "completed-before-deadline");
  assert.equal(terminal.completionSha256, completionSha256);
  assert.equal(Object.isFrozen(terminal), true);
});

test("watchdog completion rejects binding, fields, cleanup, and exit drift", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  const completionSha256 = "d".repeat(64);
  const cases = [
    {
      label: "immutable URL",
      state: completedWatchdogState(armed, completionSha256, { expectedUrl: `${WATCHDOG_URL}&x=1` }),
      exit: { code: 0, signal: null },
      pattern: /expectedUrl changed from the armed state/,
    },
    {
      label: "extra field",
      state: completedWatchdogState(armed, completionSha256, { extra: true }),
      exit: { code: 0, signal: null },
      pattern: /exact field set/,
    },
    {
      label: "completion SHA",
      state: completedWatchdogState(armed, "e".repeat(64)),
      exit: { code: 0, signal: null },
      pattern: /completion SHA-256 changed/,
    },
    {
      label: "completion time",
      state: completedWatchdogState(armed, completionSha256, {
        completionUnixMs: WATCHDOG_DEADLINE_UNIX_MS,
      }),
      exit: { code: 0, signal: null },
      pattern: /not before the fixed deadline/,
    },
    {
      label: "cleanup",
      state: completedWatchdogState(armed, completionSha256, {
        browserCleanup: "already-exited",
      }),
      exit: { code: 0, signal: null },
      pattern: /completed browser cleanup changed/,
    },
    {
      label: "nonzero exit",
      state: completedWatchdogState(armed, completionSha256),
      exit: { code: 7, signal: null },
      pattern: /did not exit cleanly.*code=7/,
    },
    {
      label: "signalled exit",
      state: completedWatchdogState(armed, completionSha256),
      exit: { code: null, signal: "SIGTERM" },
      pattern: /did not exit cleanly.*SIGTERM/,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const statePath = path.join(directory, `state-${index}.json`);
    await writePrivateWatchdogState(statePath, entry.state);
    await assert.rejects(waitForCompletedWatchdogState({
      managed: exitedWatchdog(entry.exit),
      statePath,
      armed,
      expectedUrl: WATCHDOG_URL,
      expectedCompletionSha256: completionSha256,
      timeoutMs: 100,
    }), entry.pattern, entry.label);
  }
});

test("watchdog terminal state must be a private non-symlink owner-only file", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-private-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  const completionSha256 = "f".repeat(64);
  const targetPath = path.join(directory, "target.json");
  const symlinkPath = path.join(directory, "state-link.json");
  await writePrivateWatchdogState(
    targetPath,
    completedWatchdogState(armed, completionSha256),
  );
  await symlink(targetPath, symlinkPath);
  await assert.rejects(waitForCompletedWatchdogState({
    managed: exitedWatchdog(),
    statePath: symlinkPath,
    armed,
    expectedUrl: WATCHDOG_URL,
    expectedCompletionSha256: completionSha256,
    timeoutMs: 100,
  }), /non-symlink regular file/);

  const publicPath = path.join(directory, "state-public.json");
  await writePrivateWatchdogState(
    publicPath,
    completedWatchdogState(armed, completionSha256),
    0o640,
  );
  await assert.rejects(waitForCompletedWatchdogState({
    managed: exitedWatchdog(),
    statePath: publicPath,
    armed,
    expectedUrl: WATCHDOG_URL,
    expectedCompletionSha256: completionSha256,
    timeoutMs: 100,
  }), /owner-only/);
});

test("watchdog terminal state rejects malformed JSON and malformed shape", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-malformed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  const malformedJsonPath = path.join(directory, "malformed-json.json");
  await writeFile(malformedJsonPath, "{", { mode: 0o600 });
  await assert.rejects(waitForTerminalWatchdogState({
    managed: exitedWatchdog(),
    statePath: malformedJsonPath,
    armed,
    outcome: "failed",
    timeoutMs: 100,
  }), /not valid JSON/);

  const malformedShapePath = path.join(directory, "malformed-shape.json");
  const malformedShape = failedWatchdogState(armed, "deadline-enforced");
  delete malformedShape.serverPid;
  await writePrivateWatchdogState(malformedShapePath, malformedShape);
  await assert.rejects(waitForTerminalWatchdogState({
    managed: exitedWatchdog(),
    statePath: malformedShapePath,
    armed,
    outcome: "failed",
    timeoutMs: 100,
  }), /serverPid changed from the armed state/);
});

test("failed watchdog SIGTERM authenticates controller termination and removes tracking", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-controller-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.json");
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  await writePrivateWatchdogState(statePath, armed);
  const managed = liveWatchdog(async signal => {
    assert.equal(signal, "SIGTERM");
    await writePrivateWatchdogState(
      statePath,
      failedWatchdogState(armed, "controller-terminated-before-completion"),
    );
    return { code: 0, signal: null };
  });
  const state = { watchdogs: new Set([managed]) };
  await finishWatchdog({
    gameKey: "game-1",
    captureUrl: WATCHDOG_URL,
    outcome: "failed",
    lifecycleToken: {
      managed,
      statePath,
      completionPath: path.join(directory, "completion.json"),
      armed,
    },
  }, state);
  assert.deepEqual(managed.signals, ["SIGTERM"]);
  assert.equal(state.watchdogs.size, 0);
});

test("failed watchdog deadline is typed, authenticated, and removes tracking", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.json");
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  await writePrivateWatchdogState(statePath, armed);
  const deadline = failedWatchdogState(armed, "deadline-enforced");
  const managed = liveWatchdog(async signal => {
    assert.equal(signal, "SIGTERM");
    await writePrivateWatchdogState(statePath, deadline);
    return { code: 0, signal: null };
  });
  const state = { watchdogs: new Set([managed]) };
  await assert.rejects(finishWatchdog({
    gameKey: "game-1",
    captureUrl: WATCHDOG_URL,
    outcome: "failed",
    lifecycleToken: {
      managed,
      statePath,
      completionPath: path.join(directory, "completion.json"),
      armed,
    },
  }, state), error => {
    assert.ok(error instanceof ProductionFidelityWallDeadlineError);
    assert.equal(error.code, PRODUCTION_FIDELITY_WALL_DEADLINE_ERROR_CODE);
    assert.equal(error.gameKey, "game-1");
    assert.equal(error.startUnixMs, WATCHDOG_START_UNIX_MS);
    assert.equal(error.deadlineUnixMs, WATCHDOG_DEADLINE_UNIX_MS);
    assert.equal(error.cleanupUnixMs, deadline.cleanupUnixMs);
    assert.equal(error.browserCleanup, "sigkill-confirmed-exited");
    assert.equal(
      error.serverCleanup,
      "left-running-for-journal-recovery-and-graceful-capture",
    );
    return true;
  });
  assert.deepEqual(managed.signals, ["SIGTERM"]);
  assert.equal(state.watchdogs.size, 0);
});

test("complete watchdog deadline is typed, authenticated, and removes tracking", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-complete-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.json");
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  const deadline = failedWatchdogState(armed, "deadline-enforced");
  await writePrivateWatchdogState(statePath, deadline);
  const managed = exitedWatchdog();
  const state = { watchdogs: new Set([managed]) };
  await assert.rejects(finishWatchdog({
    gameKey: "game-1",
    captureUrl: WATCHDOG_URL,
    outcome: "complete",
    lifecycleToken: {
      managed,
      statePath,
      completionPath: path.join(directory, "completion.json"),
      armed,
    },
  }, state), error => {
    assert.ok(error instanceof ProductionFidelityWallDeadlineError);
    assert.equal(error.code, PRODUCTION_FIDELITY_WALL_DEADLINE_ERROR_CODE);
    assert.equal(error.gameKey, "game-1");
    assert.equal(error.startUnixMs, WATCHDOG_START_UNIX_MS);
    assert.equal(error.deadlineUnixMs, WATCHDOG_DEADLINE_UNIX_MS);
    assert.equal(error.cleanupUnixMs, deadline.cleanupUnixMs);
    assert.equal(error.browserCleanup, "sigkill-confirmed-exited");
    assert.equal(
      error.serverCleanup,
      "left-running-for-journal-recovery-and-graceful-capture",
    );
    assert.equal(error.watchdogState.status, "deadline-enforced");
    return true;
  });
  assert.equal(state.watchdogs.size, 0);
});

test("failed watchdog rejects stale, error, tampered, and incompatible terminal states", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-failed-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  const cases = [
    ["stale armed", armed, { code: null, signal: "SIGTERM" }, /did not authenticate failure/],
    [
      "unconfirmed enforcement",
      { ...failedWatchdogState(armed, "deadline-enforced"), status: "deadline-enforcement-unconfirmed" },
      { code: 1, signal: null },
      /deadline-enforcement-unconfirmed/,
    ],
    [
      "browser exited",
      { ...failedWatchdogState(armed, "deadline-enforced"), status: "browser-exited-before-completion" },
      { code: 1, signal: null },
      /browser-exited-before-completion/,
    ],
    [
      "completion rejected",
      {
        ...failedWatchdogState(armed, "deadline-enforced"),
        status: "completion-rejected-browser-terminated",
      },
      { code: 1, signal: null },
      /completion-rejected-browser-terminated/,
    ],
    [
      "tampered identity",
      failedWatchdogState(armed, "deadline-enforced", { browserIdentity: "different" }),
      { code: 0, signal: null },
      /browserIdentity changed from the armed state/,
    ],
    [
      "unconfirmed cleanup",
      failedWatchdogState(armed, "deadline-enforced", {
        browserCleanup: "sigkill-sent-exit-not-confirmed",
      }),
      { code: 0, signal: null },
      /deadline browser cleanup was not confirmed/,
    ],
    [
      "nonzero deadline exit",
      failedWatchdogState(armed, "deadline-enforced"),
      { code: 1, signal: null },
      /did not exit cleanly.*code=1/,
    ],
    [
      "signalled controller exit",
      failedWatchdogState(armed, "controller-terminated-before-completion"),
      { code: null, signal: "SIGTERM" },
      /did not exit cleanly.*SIGTERM/,
    ],
  ];
  for (const [index, [label, terminal, exit, pattern]] of cases.entries()) {
    const statePath = path.join(directory, `state-${index}.json`);
    await writePrivateWatchdogState(statePath, terminal);
    await assert.rejects(waitForTerminalWatchdogState({
      managed: exitedWatchdog(exit),
      statePath,
      armed,
      outcome: "failed",
      timeoutMs: 100,
    }), pattern, label);
  }
});

test("finish watchdog binds the completion file SHA and removes tracking", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "lazuli-local-watchdog-finish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, "state.json");
  const completionPath = path.join(directory, "completion.json");
  const armed = validateArmedWatchdogState(
    watchdogArmedState(),
    watchdogArmedAuthority(),
  );
  const completion = {
    schema: WATCHDOG_COMPLETION_SCHEMA,
    status: "terminal-journal-validated",
    expectedUrl: WATCHDOG_URL,
  };
  const completionBytes = Buffer.from(canonicalCaptureJson(completion), "utf8");
  const completionSha256 = createHash("sha256").update(completionBytes).digest("hex");
  await writePrivateWatchdogState(
    statePath,
    completedWatchdogState(armed, completionSha256),
  );
  const managed = exitedWatchdog();
  const state = { watchdogs: new Set([managed]) };
  await finishWatchdog({
    gameKey: "game-1",
    captureUrl: WATCHDOG_URL,
    outcome: "complete",
    lifecycleToken: { managed, statePath, completionPath, armed },
  }, state);
  assert.deepEqual(await readFile(completionPath), completionBytes);
  assert.equal(state.watchdogs.size, 0);
});
