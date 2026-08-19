#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { Buffer } from "node:buffer";
import { spawn as spawnChild, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DevToolsSession } from "./browser_boot_headless_cdp.mjs";
import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";
import {
  RESIDENT_CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA,
  validateResidentCorpusEvidence,
} from "./resident_machine_corpus_report.mjs";
import {
  PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
  PRODUCTION_SOURCE_PATHS,
  productionFidelityCapturePolicy,
  productionFidelityLockAuthorityFromFiles,
  validateResidentProductionFidelityEvidenceLock,
  verifyResidentProductionFidelityEvidenceLockFiles,
} from "./resident_machine_fidelity_lock.mjs";
import {
  PRODUCTION_FIDELITY_CAPTURE_PLAN_SCHEMA,
  runProductionFidelityBundle,
  validateProductionFidelityCapturePlan,
  verifyCandidateDistribution,
} from "./resident_machine_production_fidelity_bundle.mjs";
import {
  canonicalCaptureJson,
  createDedicatedCaptureTarget,
  runProductionFidelityCapture,
  writePrivateLeafAtomic,
} from "./resident_machine_production_fidelity_capture.mjs";
import {
  validateProductionFidelityAttestationFiles,
} from "./resident_machine_production_fidelity_gate.mjs";

export const LOCAL_PRODUCTION_FIDELITY_RESULT_SCHEMA =
  "lazuli-resident-production-fidelity-local-result-v1";
export const WATCHDOG_COMPLETION_SCHEMA =
  "lazuli-resident-renderer-fidelity-watchdog-completion-v1";
export const WATCHDOG_STATE_SCHEMA =
  "lazuli-resident-renderer-fidelity-watchdog-v1";
export const PRODUCTION_FIDELITY_WALL_DEADLINE_ERROR_CODE =
  "ERR_PRODUCTION_FIDELITY_WALL_DEADLINE";

const EXEC_FILE = promisify(execFile);
const SERVER_START_TIMEOUT_MS = 30 * 60_000;
const CHROME_START_TIMEOUT_MS = 60_000;
const PERFORMANCE_CAPTURE_TIMEOUT_MS = 60 * 60_000;
const CDP_REQUEST_TIMEOUT_MS = 180_000;
const PROCESS_STOP_TIMEOUT_MS = 30_000;
const WATCHDOG_ARM_TIMEOUT_MS = 30_000;
const WATCHDOG_COMPLETE_TIMEOUT_MS = 30_000;
const FIXED_FIDELITY_WALL_MS = 600_000;
const WATCHDOG_STATE_MAX_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_PERFORMANCE_STATUSES = new Set(["complete", "partial", "failed"]);
const WATCHDOG_PATH = fileURLToPath(
  new URL("./resident_machine_fidelity_watchdog.py", import.meta.url),
);
const CORPUS_SERVER_PATH = fileURLToPath(
  new URL("./resident_machine_corpus_server.py", import.meta.url),
);
const FIDELITY_SERVER_PATH = fileURLToPath(
  new URL("./resident_machine_fidelity_server.py", import.meta.url),
);
const WATCHDOG_ARMED_KEYS = Object.freeze([
  "schema",
  "status",
  "startUnixMs",
  "deadlineUnixMs",
  "expectedUrl",
  "browserPid",
  "browserIdentity",
  "serverPid",
  "serverIdentity",
  "cleanupIndependentOfPageMainThread",
]);
const WATCHDOG_IMMUTABLE_KEYS = Object.freeze(
  WATCHDOG_ARMED_KEYS.filter(key => key !== "status"),
);
const WATCHDOG_CLEANUP_KEYS = Object.freeze([
  ...WATCHDOG_ARMED_KEYS,
  "cleanupUnixMs",
  "browserCleanup",
  "serverCleanup",
]);
const WATCHDOG_COMPLETED_KEYS = Object.freeze([
  ...WATCHDOG_ARMED_KEYS,
  "completionUnixMs",
  "completionSha256",
  "browserCleanup",
  "serverCleanup",
]);

function fail(message) {
  throw new Error(`local production fidelity: ${message}`);
}

function exactWatchdogKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(`${label} has an invalid exact field set`);
  }
}

function watchdogInteger(value, label, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value)
    || (positive ? value <= 0 : value < 0)
  ) fail(`${label} must be a ${positive ? "positive" : "nonnegative"} safe integer`);
  return value;
}

function validatedArmedWatchdogShape(value, label) {
  exactWatchdogKeys(value, WATCHDOG_ARMED_KEYS, label);
  if (value.schema !== WATCHDOG_STATE_SCHEMA) fail(`${label} schema changed`);
  if (value.status !== "armed-before-navigation") fail(`${label} status changed`);
  watchdogInteger(value.startUnixMs, `${label} startUnixMs`);
  watchdogInteger(value.deadlineUnixMs, `${label} deadlineUnixMs`);
  if (value.deadlineUnixMs - value.startUnixMs !== FIXED_FIDELITY_WALL_MS) {
    fail(`${label} deadline is not exactly start + ${FIXED_FIDELITY_WALL_MS} ms`);
  }
  if (typeof value.expectedUrl !== "string" || value.expectedUrl.length === 0) {
    fail(`${label} expectedUrl must be a nonempty string`);
  }
  watchdogInteger(value.browserPid, `${label} browserPid`, { positive: true });
  watchdogInteger(value.serverPid, `${label} serverPid`, { positive: true });
  if (typeof value.browserIdentity !== "string" || value.browserIdentity.length === 0) {
    fail(`${label} browserIdentity must be a nonempty string`);
  }
  if (typeof value.serverIdentity !== "string" || value.serverIdentity.length === 0) {
    fail(`${label} serverIdentity must be a nonempty string`);
  }
  if (value.cleanupIndependentOfPageMainThread !== true) {
    fail(`${label} cleanup independence changed`);
  }
  return value;
}

export function validateArmedWatchdogState(value, expected) {
  const label = "watchdog armed state";
  validatedArmedWatchdogShape(value, label);
  for (const key of [
    "startUnixMs",
    "deadlineUnixMs",
    "expectedUrl",
    "browserPid",
    "serverPid",
  ]) {
    if (value[key] !== expected?.[key]) fail(`${label} ${key} changed from controller authority`);
  }
  for (const [key, fragmentKey] of [
    ["browserIdentity", "browserIdentityFragment"],
    ["serverIdentity", "serverIdentityFragment"],
  ]) {
    const fragment = expected?.[fragmentKey];
    if (typeof fragment !== "string" || fragment.length === 0) {
      fail(`${label} ${fragmentKey} authority is invalid`);
    }
    if (!value[key].includes(fragment)) fail(`${label} ${key} changed from controller authority`);
  }
  return Object.freeze(Object.fromEntries(WATCHDOG_ARMED_KEYS.map(key => [key, value[key]])));
}

async function readPrivateWatchdogState(statePath, label) {
  let pathMetadata;
  try {
    pathMetadata = await lstat(statePath);
  } catch (error) {
    fail(`${label} is unreadable: ${error.message}`);
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    fail(`${label} must be a non-symlink regular file`);
  }
  if ((pathMetadata.mode & 0o077) !== 0) fail(`${label} must be owner-only`);
  if (typeof process.getuid === "function" && pathMetadata.uid !== process.getuid()) {
    fail(`${label} must be owned by the controller user`);
  }
  if (pathMetadata.size <= 0 || pathMetadata.size > WATCHDOG_STATE_MAX_BYTES) {
    fail(`${label} has an invalid byte length`);
  }

  let handle;
  try {
    handle = await open(
      statePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    fail(`${label} could not be opened without following links: ${error.message}`);
  }
  let bytes;
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile()
      || (openedMetadata.mode & 0o077) !== 0
      || (
        typeof process.getuid === "function"
        && openedMetadata.uid !== process.getuid()
      )
      || openedMetadata.size <= 0
      || openedMetadata.size > WATCHDOG_STATE_MAX_BYTES
      || openedMetadata.dev !== pathMetadata.dev
      || openedMetadata.ino !== pathMetadata.ino
      || openedMetadata.size !== pathMetadata.size
    ) fail(`${label} changed before it was opened`);
    bytes = await handle.readFile();
    const readMetadata = await handle.stat();
    const currentMetadata = await lstat(statePath);
    if (
      readMetadata.dev !== openedMetadata.dev
      || readMetadata.ino !== openedMetadata.ino
      || readMetadata.size !== openedMetadata.size
      || readMetadata.mtimeMs !== openedMetadata.mtimeMs
      || currentMetadata.isSymbolicLink()
      || !currentMetadata.isFile()
      || (currentMetadata.mode & 0o077) !== 0
      || (
        typeof process.getuid === "function"
        && currentMetadata.uid !== process.getuid()
      )
      || currentMetadata.dev !== openedMetadata.dev
      || currentMetadata.ino !== openedMetadata.ino
      || currentMetadata.size !== openedMetadata.size
      || bytes.byteLength !== openedMetadata.size
    ) fail(`${label} changed while it was read`);
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateCleanWatchdogExit(exit, label) {
  if (
    exit === null
    || typeof exit !== "object"
    || exit.code !== 0
    || exit.signal !== null
  ) {
    fail(
      `${label} did not exit cleanly `
      + `(code=${String(exit?.code)}, signal=${String(exit?.signal)})`,
    );
  }
}

function validateTerminalWatchdogState(
  value,
  {
    armed,
    outcome,
    expectedCompletionSha256 = null,
    exit,
    label,
  },
) {
  validatedArmedWatchdogShape(armed, `${label} armed token`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} durable terminal state must be an object`);
  }
  for (const key of WATCHDOG_IMMUTABLE_KEYS) {
    if (value[key] !== armed[key]) {
      fail(`${label} durable terminal state ${key} changed from the armed state`);
    }
  }
  if (outcome === "complete" && value.status !== "deadline-enforced") {
    if (value.status !== "completed-before-deadline") {
      fail(`${label} durable terminal state did not authenticate completion: ${String(value.status)}`);
    }
    exactWatchdogKeys(value, WATCHDOG_COMPLETED_KEYS, `${label} completed state`);
    watchdogInteger(value.completionUnixMs, `${label} completionUnixMs`);
    if (value.completionUnixMs >= armed.deadlineUnixMs) {
      fail(`${label} completionUnixMs is not before the fixed deadline`);
    }
    if (
      typeof expectedCompletionSha256 !== "string"
      || !SHA256_PATTERN.test(expectedCompletionSha256)
    ) fail(`${label} expected completion SHA-256 authority is invalid`);
    if (value.completionSha256 !== expectedCompletionSha256) {
      fail(`${label} completion SHA-256 changed`);
    }
    if (value.browserCleanup !== "left-running-for-next-capture") {
      fail(`${label} completed browser cleanup changed`);
    }
    if (value.serverCleanup !== "left-running-for-graceful-capture") {
      fail(`${label} completed server cleanup changed`);
    }
    validateCleanWatchdogExit(exit, label);
    return Object.freeze({ ...value });
  }
  if (outcome !== "complete" && outcome !== "failed") fail(`${label} outcome is invalid`);
  if (
    value.status !== "deadline-enforced"
    && (
      outcome !== "failed"
      || value.status !== "controller-terminated-before-completion"
    )
  ) {
    fail(
      `${label} durable terminal state did not authenticate `
      + `${outcome === "complete" ? "completion" : "failure"}: ${String(value.status)}`,
    );
  }
  exactWatchdogKeys(value, WATCHDOG_CLEANUP_KEYS, `${label} failed state`);
  watchdogInteger(value.cleanupUnixMs, `${label} cleanupUnixMs`);
  if (value.status === "deadline-enforced") {
    if (
      value.browserCleanup !== "already-exited"
      && value.browserCleanup !== "sigkill-confirmed-exited"
    ) fail(`${label} deadline browser cleanup was not confirmed`);
    if (
      value.serverCleanup
      !== "left-running-for-journal-recovery-and-graceful-capture"
    ) fail(`${label} deadline server cleanup changed`);
  } else {
    if (value.browserCleanup !== "left-running-for-controller-cleanup") {
      fail(`${label} controller browser cleanup changed`);
    }
    if (value.serverCleanup !== "left-running-for-controller-cleanup") {
      fail(`${label} controller server cleanup changed`);
    }
  }
  validateCleanWatchdogExit(exit, label);
  return Object.freeze({ ...value });
}

export class ProductionFidelityWallDeadlineError extends Error {
  constructor(gameKey, terminal) {
    super(
      `production fidelity fixed ${FIXED_FIDELITY_WALL_MS} ms wall deadline enforced `
      + `for ${gameKey}`,
    );
    this.name = "ProductionFidelityWallDeadlineError";
    this.code = PRODUCTION_FIDELITY_WALL_DEADLINE_ERROR_CODE;
    this.gameKey = gameKey;
    this.startUnixMs = terminal.startUnixMs;
    this.deadlineUnixMs = terminal.deadlineUnixMs;
    this.cleanupUnixMs = terminal.cleanupUnixMs;
    this.browserCleanup = terminal.browserCleanup;
    this.serverCleanup = terminal.serverCleanup;
    this.watchdogState = terminal;
  }
}

export function formatProductionFidelityFailure(failure) {
  const lines = [];
  const seen = new Map();
  const metadataKeys = [
    "code",
    "gameKey",
    "startUnixMs",
    "deadlineUnixMs",
    "cleanupUnixMs",
    "browserCleanup",
    "serverCleanup",
  ];
  const visit = (value, pathLabel) => {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const firstPath = seen.get(value);
      if (firstPath !== undefined) {
        lines.push(`${pathLabel}: [same failure object as ${firstPath}]`);
        return;
      }
      seen.set(value, pathLabel);
    }
    lines.push(`${pathLabel}:`);
    lines.push(String(value?.stack ?? value));
    for (const key of metadataKeys) {
      if (value?.[key] !== undefined) lines.push(`${pathLabel}.${key}: ${String(value[key])}`);
    }
    if (Array.isArray(value?.errors)) {
      for (let index = 0; index < value.errors.length; index += 1) {
        visit(value.errors[index], `${pathLabel}.errors[${index}]`);
      }
    }
    if (value?.cause !== undefined) visit(value.cause, `${pathLabel}.cause`);
  };
  visit(failure, "failure");
  return lines.join("\n");
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function exactSevenGames(corpus) {
  if (!Array.isArray(corpus?.games) || corpus.games.length !== 7) {
    fail("compatibility corpus must contain exactly seven games");
  }
  const games = [...corpus.games].sort((left, right) => left.priority - right.priority);
  for (let index = 0; index < games.length; index += 1) {
    if (games[index].priority !== index + 1) fail("corpus priorities must be exactly 1 through 7");
  }
  if (new Set(games.map(game => game.key)).size !== games.length) {
    fail("compatibility corpus repeats a game key");
  }
  return games;
}

function exactUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(`${label} must be a UUID`);
  return value;
}

function descriptor(value) {
  return Object.freeze({ url: value.url, bytes: value.bytes, sha256: value.sha256 });
}

export function releaseExecutionAssets(release) {
  return Object.freeze({
    core: descriptor(release.runtime.core),
    dispatcher: descriptor(release.runtime.dispatcher),
    coordinator: descriptor(release.runtime.coordinator),
    adapter: descriptor(release.runtime.adapter),
    worker: descriptor(release.runtime.worker),
    frontend: descriptor(release.frontend),
    rendererJavascript: descriptor(release.renderer.javascript),
    rendererWasm: descriptor(release.renderer.wasm),
  });
}

function reportGames(games) {
  return games.map(game => Object.freeze({
    key: game.key,
    priority: game.priority,
    bytes: game.bytes,
    sha256: game.image.sha256,
  }));
}

function artifactManifest(artifacts) {
  return Object.freeze({
    schema: "lazuli-resident-corpus-artifacts-v1",
    artifacts,
  });
}

export function productionCorpusEvidenceAuthority({ authority, runId, games }) {
  const ordered = exactSevenGames({ games });
  return Object.freeze({
    release: authority.release,
    run: Object.freeze({
      runId: exactUuid(runId, "controlled-performance run ID"),
      selectedGameKeys: Object.freeze(ordered.map(game => game.key)),
    }),
    sourceCorpusSha256: authority.corpus.sha256,
    games: Object.freeze(reportGames(ordered)),
    artifacts: artifactManifest(authority.artifacts),
    sources: authority.sources,
  });
}

export function productionCorpusEvidenceLock({ authority, runId, games }) {
  const expected = productionCorpusEvidenceAuthority({ authority, runId, games });
  const sourceKeys = Object.keys(authority.sources);
  if (JSON.stringify(sourceKeys) !== JSON.stringify(PRODUCTION_SOURCE_PATHS)) {
    fail("controlled-performance sources do not equal the production source authority");
  }
  return Object.freeze({
    schema: RESIDENT_CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA,
    ...expected,
    runPolicy: Object.freeze({
      transport: "frozen-resident-machine-worker",
      measurementMode: "fixed-instruction-progress",
      warmupInstructionTarget: "1000000",
      measurementInstructionTarget: "5000000",
      cycleUpperCap: "1000000",
      blockUpperCap: 16_384,
      maxHostCalls: 65_535,
      maxColdInstalls: 65_535,
      maxBootReads: 8_192,
      bootTimeoutMs: 120_000,
      sliceTimeoutMs: 120_000,
      windowTimeoutMs: 120_000,
      zeroProgressSliceCap: 4_096,
      continueOnFailure: true,
      workerUrl: authority.release.executionAssets.worker.url,
    }),
  });
}

export function productionRendererFidelityEvidenceLock(authority) {
  const gameKey = authority.run.gameKey;
  const lock = {
    schema: PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA,
    evidenceMode:
      "continuous-resident-game-fidelity-v1-with-durable-renderer-and-rust-ownership",
    release: authority.release,
    run: authority.run,
    corpus: authority.corpus,
    selectedGame: authority.selectedGame,
    artifacts: authority.artifacts,
    sources: authority.sources,
    hostPolicy: {
      transport: "immutable-http-range",
      maxRangeBytes: 64 * 1024 * 1024,
      semanticArguments: 0,
      checkpointBodyCap: 4_096,
    },
    runPolicy: {
      instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
      executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
      sliceCycleUpperCap: "1000000",
      blockUpperCap: 16_384,
      totalHostCallCap: 65_535,
      totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
      maxBootReads: 8_192,
      bootTimeoutMs: 180_000,
      sliceTimeoutMs: 180_000,
      runTimeoutMs: FIXED_FIDELITY_WALL_MS,
      externalWallTimeoutMs: FIXED_FIDELITY_WALL_MS,
      zeroProgressSliceCap: 4_096,
      workerUrl: authority.release.executionAssets.worker.url,
    },
    checkpointPolicy: {
      checkpointTimeoutMs: 10_000,
      checkpointRecordCap: 65_535,
      probeEventRunCap: 32_768,
      probeEventPerSubmissionCap: 402,
      opaqueProbeWords: 6,
      fsyncEveryRecord: true,
    },
    capturePolicy: productionFidelityCapturePolicy(gameKey),
    rendererProbe: {
      feature: "resident-render-probe",
      featureDefaultOff: true,
      hook: "globalThis.__lazuliResidentRenderProbe",
      defaultHookImports: 0,
      checkpointProbeEvents: 0,
      javascriptWordInterpretations: 0,
    },
    machineEvidence: {
      abiVersion: 1,
      byteLength: 816,
      wordLength: 204,
      tag: "LZME",
      encoding: "base64",
      browserWordInterpretations: 0,
    },
  };
  validateResidentProductionFidelityEvidenceLock(lock, authority);
  return Object.freeze(lock);
}

export function schemaOrderedLockBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function localCapturePlan({ cdpEndpoint, performanceRunId, games }, corpusGames) {
  const plan = {
    schema: PRODUCTION_FIDELITY_CAPTURE_PLAN_SCHEMA,
    cdpEndpoint,
    controlledPerformance: {
      runId: exactUuid(performanceRunId, "controlled-performance run ID"),
      report: "performance/report.json",
      lock: "performance/lock.json",
    },
    games: games.map(game => ({
      key: game.key,
      evidenceLock: game.evidenceLock,
      checkpointJournal: game.checkpointJournal,
      captureUrl: game.captureUrl,
    })),
  };
  validateProductionFidelityCapturePlan(plan, corpusGames);
  return Object.freeze(plan);
}

function safeDescriptorRelative(url, label) {
  if (
    typeof url !== "string"
    || !url.startsWith("/")
    || url.startsWith("//")
    || url.includes("\\")
    || url.split("/").some((part, index) => index > 0 && (part === "" || part === "." || part === ".."))
  ) fail(`${label} has an unsafe release URL`);
  return url.slice(1);
}

async function candidateExecutionPaths(candidate) {
  const descriptors = releaseExecutionAssets(candidate.release);
  const entries = await Promise.all(Object.entries(descriptors).map(async ([role, record]) => {
    const candidatePath = path.join(
      candidate.distRoot,
      safeDescriptorRelative(record.url, `${role} descriptor`),
    );
    const canonical = await realpath(candidatePath);
    const relative = path.relative(candidate.distRoot, canonical);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      fail(`${role} execution asset escaped the candidate distribution`);
    }
    const metadata = await stat(canonical);
    if (!metadata.isFile()) fail(`${role} execution asset is not a regular file`);
    return [role, canonical];
  }));
  return Object.freeze(Object.fromEntries(entries));
}

function artifactPaths(executionPaths) {
  return Object.freeze({
    "browser_machine.wasm": executionPaths.core,
    "resident_dispatcher.wasm": executionPaths.dispatcher,
    "core_run_coordinator.wasm": executionPaths.coordinator,
    "browser_renderer.js": executionPaths.rendererJavascript,
    "browser_renderer_bg.wasm": executionPaths.rendererWasm,
  });
}

async function git(repository, arguments_, purpose, execFileImpl = EXEC_FILE) {
  try {
    const { stdout } = await execFileImpl(
      "git",
      ["--no-replace-objects", "-C", repository, ...arguments_],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(`could not ${purpose}: ${String(error?.stderr ?? error?.message ?? error)}`);
  }
}

export async function validateCleanReleaseCheckout({ repository, release }, {
  execFileImpl = EXEC_FILE,
} = {}) {
  const canonicalRepository = await realpath(repository);
  const topLevel = await git(
    canonicalRepository,
    ["rev-parse", "--show-toplevel"],
    "resolve repository root",
    execFileImpl,
  );
  if (await realpath(topLevel) !== canonicalRepository) fail("repository is not the exact Git root");
  if (await git(
    canonicalRepository,
    ["rev-parse", "--is-shallow-repository"],
    "inspect repository history",
    execFileImpl,
  ) !== "false") fail("production capture refuses shallow repository history");
  const head = await git(
    canonicalRepository,
    ["rev-parse", "HEAD"],
    "resolve checked-out commit",
    execFileImpl,
  );
  if (!COMMIT_PATTERN.test(head) || head !== release.source.commit) {
    fail("checked-out commit does not equal the candidate release source commit");
  }
  const status = await git(
    canonicalRepository,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "inspect repository cleanliness",
    execFileImpl,
  );
  if (status !== "") fail("production capture requires an exactly clean checkout");
  return Object.freeze({ repository: canonicalRepository, commit: head });
}

export async function requireExactPlainDirectory(value, label) {
  const absolute = path.resolve(value);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a non-symlink directory`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) fail(`${label} must not traverse a symlink component`);
  return canonical;
}

async function requirePlainRegularFile(value, label) {
  const absolute = path.resolve(value);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a non-symlink regular file`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) fail(`${label} must not traverse a symlink component`);
  return Object.freeze({ path: canonical, metadata });
}

async function createPrivateRoot(value, repository) {
  const requested = path.resolve(value);
  const parent = await requireExactPlainDirectory(
    path.dirname(requested),
    "capture-root parent",
  );
  const root = path.join(parent, path.basename(requested));
  if (root !== requested) fail("capture root must not traverse a symlink component");
  const relative = path.relative(repository, root);
  if (
    relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) fail("capture root must be outside the repository");
  await mkdir(root, { mode: 0o700 });
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
    fail("capture root must be a freshly created mode-0700 directory");
  }
  return realpath(root);
}

async function requireAbsentDirectChild(root, value, label) {
  const absolute = path.resolve(value);
  if (path.dirname(absolute) !== root) fail(`${label} must be a direct child of capture root`);
  try {
    await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return absolute;
    throw error;
  }
  fail(`${label} must not already exist`);
}

function appendBounded(current, chunk) {
  const combined = current + String(chunk);
  return combined.length <= MAX_PROCESS_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_PROCESS_OUTPUT_BYTES);
}

export function startManagedProcess(command, arguments_, label, {
  spawnImpl = spawnChild,
  firstLine = false,
} = {}) {
  const child = spawnImpl(command, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const managed = {
    label,
    child,
    stdout: "",
    stderr: "",
    firstLinePromise: null,
    exitPromise: null,
  };
  let firstLineBuffer = "";
  let resolveLine = null;
  let rejectLine = null;
  if (firstLine) {
    managed.firstLinePromise = new Promise((resolve, reject) => {
      resolveLine = resolve;
      rejectLine = reject;
    });
  }
  child.stdout?.on("data", chunk => {
    managed.stdout = appendBounded(managed.stdout, chunk);
    if (firstLine && resolveLine !== null) {
      firstLineBuffer += String(chunk);
      const newline = firstLineBuffer.indexOf("\n");
      if (newline !== -1) {
        const line = firstLineBuffer.slice(0, newline);
        const resolve = resolveLine;
        resolveLine = null;
        rejectLine = null;
        resolve(line);
      }
    }
  });
  child.stderr?.on("data", chunk => {
    managed.stderr = appendBounded(managed.stderr, chunk);
  });
  managed.exitPromise = new Promise((resolve, reject) => {
    child.once("error", error => {
      if (rejectLine !== null) {
        const rejectFirst = rejectLine;
        resolveLine = null;
        rejectLine = null;
        rejectFirst(error);
      }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (rejectLine !== null) {
        const rejectFirst = rejectLine;
        resolveLine = null;
        rejectLine = null;
        rejectFirst(new Error(
          `${label} exited before readiness (code=${String(code)}, signal=${String(signal)}): ${managed.stderr}`,
        ));
      }
      resolve(Object.freeze({ code, signal }));
    });
  });
  void managed.exitPromise.catch(() => {});
  return managed;
}

function processAlive(managed) {
  return managed.child.exitCode === null && managed.child.signalCode === null;
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopManagedProcess(managed, signal = "SIGTERM") {
  if (!processAlive(managed)) return managed.exitPromise.catch(() => null);
  managed.child.kill(signal);
  try {
    return await withTimeout(managed.exitPromise, PROCESS_STOP_TIMEOUT_MS, `${managed.label} stop`);
  } catch {
    if (processAlive(managed)) managed.child.kill("SIGKILL");
    return withTimeout(managed.exitPromise, PROCESS_STOP_TIMEOUT_MS, `${managed.label} SIGKILL`);
  }
}

function loopbackServerUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} did not emit a URL`);
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== ""
    || url.port === ""
  ) fail(`${label} URL is not an exact loopback HTTP origin`);
  return url;
}

export function parseServerReadyLine(line, { label, expectedGames }) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(`${label} readiness line is not JSON: ${error.message}`);
  }
  if (value?.ok !== true || !Array.isArray(value.selectedGames)) {
    fail(`${label} readiness document is incomplete`);
  }
  if (JSON.stringify(value.selectedGames) !== JSON.stringify(expectedGames)) {
    fail(`${label} selected games changed`);
  }
  return Object.freeze({ value, url: loopbackServerUrl(value.url, label) });
}

async function startJsonServer(command, arguments_, label, expectedGames, processList, deps) {
  const managed = startManagedProcess(command, arguments_, label, {
    spawnImpl: deps.spawnImpl,
    firstLine: true,
  });
  processList.push(managed);
  try {
    const line = await withTimeout(
      managed.firstLinePromise,
      SERVER_START_TIMEOUT_MS,
      `${label} readiness`,
    );
    return Object.freeze({
      managed,
      ...parseServerReadyLine(line, { label, expectedGames }),
    });
  } catch (error) {
    await stopManagedProcess(managed).catch(() => {});
    throw error;
  }
}

async function waitForJsonFile(file, predicate, timeoutMs, label, managed = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managed !== null && !processAlive(managed)) {
      const exit = await managed.exitPromise.catch(error => ({ error }));
      fail(`${label} process exited early: ${JSON.stringify(exit)} ${managed.stderr}`);
    }
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  fail(`${label} did not become ready before its deadline`);
}

async function startChrome(chromeBinary, profile, processList, deps) {
  const managed = startManagedProcess(chromeBinary, [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], "dedicated Chrome", { spawnImpl: deps.spawnImpl });
  processList.push(managed);
  const activePortPath = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + CHROME_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processAlive(managed)) {
      const exit = await managed.exitPromise.catch(error => ({ error }));
      fail(`dedicated Chrome exited before CDP readiness: ${JSON.stringify(exit)} ${managed.stderr}`);
    }
    try {
      const lines = (await readFile(activePortPath, "utf8")).trim().split("\n");
      if (/^[1-9][0-9]{0,4}$/.test(lines[0] ?? "")) {
        const port = Number(lines[0]);
        if (port <= 65_535) {
          const endpoint = `http://127.0.0.1:${port}/`;
          const response = await deps.fetchImpl(new URL("json/version", endpoint));
          if (response.ok) {
            const version = await response.json();
            if (typeof version.webSocketDebuggerUrl === "string") {
              return Object.freeze({ managed, profile, endpoint });
            }
          }
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof TypeError)) throw error;
    }
    await delay(100);
  }
  fail("dedicated Chrome did not expose its CDP endpoint");
}

function performanceUrl(serverUrl) {
  const url = new URL(serverUrl);
  for (const [name, value] of [
    ["warmupInstructions", "1000000"],
    ["measureInstructions", "5000000"],
    ["cycleCap", "1000000"],
    ["blockCap", "16384"],
    ["hostCallCap", "65535"],
    ["coldInstallCap", "65535"],
    ["bootReadCap", "8192"],
    ["requestTimeoutMs", "120000"],
    ["bootTimeoutMs", "120000"],
    ["sliceTimeoutMs", "120000"],
    ["windowTimeoutMs", "120000"],
    ["zeroProgressSliceCap", "4096"],
    ["continueOnFailure", "1"],
  ]) url.searchParams.set(name, value);
  return url.href;
}

async function captureControlledPerformance(cdpEndpoint, targetUrl, deps) {
  const dedicated = await createDedicatedCaptureTarget(
    cdpEndpoint,
    (url, options) => new deps.DevToolsSessionImpl(url, options),
    deps.fetchImpl,
    CDP_REQUEST_TIMEOUT_MS,
  );
  let page = null;
  let primaryFailure = null;
  try {
    page = new deps.DevToolsSessionImpl(dedicated.target.webSocketDebuggerUrl, {
      requestTimeoutMs: CDP_REQUEST_TIMEOUT_MS,
    });
    await page.connect();
    await page.send("Runtime.enable", {}, CDP_REQUEST_TIMEOUT_MS);
    await page.send("Page.enable", {}, CDP_REQUEST_TIMEOUT_MS);
    const navigation = await page.send("Page.navigate", { url: targetUrl }, CDP_REQUEST_TIMEOUT_MS);
    if (typeof navigation.loaderId !== "string" || navigation.errorText !== undefined) {
      fail("controlled-performance navigation did not create an exact document loader");
    }
    const deadline = Date.now() + PERFORMANCE_CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const observed = await page.evaluate(`(() => ({
        href: location.href,
        evidence: globalThis.__residentCorpusEvidence ?? null,
      }))()`, CDP_REQUEST_TIMEOUT_MS);
      if (observed?.href !== targetUrl) fail("controlled-performance page URL drifted");
      if (TERMINAL_PERFORMANCE_STATUSES.has(observed?.evidence?.status)) {
        return observed.evidence;
      }
      await delay(250);
    }
    fail("controlled-performance page exceeded its aggregate deadline");
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    page?.close();
    let closeFailure = null;
    try {
      const closed = await dedicated.browserSession.send(
        "Target.closeTarget",
        { targetId: dedicated.target.id },
        CDP_REQUEST_TIMEOUT_MS,
      );
      if (closed.success !== true) closeFailure = new Error("controlled-performance target did not close");
    } catch (error) {
      closeFailure = error;
    } finally {
      dedicated.browserSession.close();
    }
    const terminalFailure = controlledPerformanceTargetFailure(
      primaryFailure,
      closeFailure,
    );
    if (terminalFailure !== primaryFailure) throw terminalFailure;
  }
}

function serverArtifactArguments(paths) {
  return [
    "--core", paths.core,
    "--dispatcher", paths.dispatcher,
    "--coordinator", paths.coordinator,
    "--renderer-js", paths.rendererJavascript,
    "--renderer-wasm", paths.rendererWasm,
  ];
}

function serverExecutionArguments(paths) {
  return [
    "--adapter", paths.adapter,
    "--worker", paths.worker,
    "--frontend", paths.frontend,
  ];
}

async function writeOwned(root, relative, bytes) {
  await writePrivateLeafAtomic(root, relative, bytes);
  return path.join(root, relative);
}

function fidelityAuthority(base, runId, game) {
  return Object.freeze({
    release: base.release,
    run: Object.freeze({ runId, gameKey: game.key }),
    corpus: base.corpus,
    selectedGame: Object.freeze({
      key: game.key,
      priority: game.priority,
      bytes: game.bytes,
      image: game.image,
      disc: game.disc,
    }),
    artifacts: base.artifacts,
    sources: base.sources,
  });
}

function captureRelativePrefix(game) {
  return `inputs/${String(game.priority).padStart(2, "0")}-${game.key}`;
}

async function startWatchdog(context, state, deps) {
  const server = state.fidelityServers.get(context.gameKey);
  if (server === undefined) fail(`missing fidelity server for ${context.gameKey}`);
  const prefix = `watchdogs/${String(context.priority).padStart(2, "0")}-${context.gameKey}`;
  const statePath = path.join(state.captureRoot, `${prefix}-state.json`);
  const completionPath = path.join(state.captureRoot, `${prefix}-completion.json`);
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const startUnixMs = Date.now();
  const armedAuthority = Object.freeze({
    startUnixMs,
    deadlineUnixMs: startUnixMs + FIXED_FIDELITY_WALL_MS,
    expectedUrl: context.captureUrl,
    browserPid: state.chrome.managed.child.pid,
    serverPid: server.managed.child.pid,
    browserIdentityFragment: state.chrome.profile,
    serverIdentityFragment: "resident_machine_fidelity_server.py",
  });
  const managed = startManagedProcess(state.python, [
    WATCHDOG_PATH,
    "--state", statePath,
    "--start-unix-ms", String(armedAuthority.startUnixMs),
    "--deadline-unix-ms", String(armedAuthority.deadlineUnixMs),
    "--browser-pid", String(armedAuthority.browserPid),
    "--server-pid", String(armedAuthority.serverPid),
    "--expected-url", armedAuthority.expectedUrl,
    "--browser-identity-fragment", armedAuthority.browserIdentityFragment,
    "--server-identity-fragment", armedAuthority.serverIdentityFragment,
    "--completion", completionPath,
  ], `watchdog ${context.gameKey}`, { spawnImpl: deps.spawnImpl });
  state.watchdogs.add(managed);
  let armed;
  try {
    await waitForJsonFile(
      statePath,
      value => value?.status === "armed-before-navigation"
        && value.expectedUrl === armedAuthority.expectedUrl
        && value.browserPid === armedAuthority.browserPid
        && value.serverPid === armedAuthority.serverPid,
      WATCHDOG_ARM_TIMEOUT_MS,
      `watchdog ${context.gameKey}`,
      managed,
    );
    armed = validateArmedWatchdogState(
      await readPrivateWatchdogState(
        statePath,
        `watchdog ${context.gameKey} armed state`,
      ),
      armedAuthority,
    );
  } catch (error) {
    let cleanupFailure = null;
    try {
      await stopManagedProcess(managed);
    } catch (stopError) {
      cleanupFailure = stopError;
    }
    if (!processAlive(managed)) state.watchdogs.delete(managed);
    if (cleanupFailure !== null) {
      throw new AggregateError(
        [error, cleanupFailure],
        `watchdog ${context.gameKey} failed to arm and exact cleanup also failed`,
      );
    }
    throw error;
  }
  return Object.freeze({ managed, statePath, completionPath, armed });
}

export async function waitForTerminalWatchdogState({
  managed,
  statePath,
  armed,
  outcome,
  expectedCompletionSha256 = null,
  timeoutMs = WATCHDOG_COMPLETE_TIMEOUT_MS,
}) {
  const exit = await withTimeout(
    managed.exitPromise,
    timeoutMs,
    `${managed.label} exit`,
  );
  const terminal = await readPrivateWatchdogState(
    statePath,
    `${managed.label} durable terminal state`,
  );
  return validateTerminalWatchdogState(terminal, {
    armed,
    outcome,
    expectedCompletionSha256,
    exit,
    label: managed.label,
  });
}

export async function waitForCompletedWatchdogState({
  managed,
  statePath,
  armed,
  expectedUrl,
  expectedCompletionSha256,
  timeoutMs = WATCHDOG_COMPLETE_TIMEOUT_MS,
}) {
  if (armed?.expectedUrl !== expectedUrl) {
    fail(`${managed.label} expected URL changed from the armed state`);
  }
  return waitForTerminalWatchdogState({
    managed,
    statePath,
    armed,
    outcome: "complete",
    expectedCompletionSha256,
    timeoutMs,
  });
}

export async function finishWatchdog(context, state) {
  const token = context.lifecycleToken;
  if (token?.managed === undefined) fail(`watchdog token is unavailable for ${context.gameKey}`);
  try {
    if (token.armed === undefined) fail(`watchdog armed token is unavailable for ${context.gameKey}`);
    if (token.armed.expectedUrl !== context.captureUrl) {
      fail(`watchdog token URL changed for ${context.gameKey}`);
    }
    if (context.outcome === "complete") {
      const completion = {
        schema: WATCHDOG_COMPLETION_SCHEMA,
        status: "terminal-journal-validated",
        expectedUrl: context.captureUrl,
      };
      const completionBytes = Buffer.from(canonicalCaptureJson(completion), "utf8");
      await writePrivateLeafAtomic(
        path.dirname(token.completionPath),
        path.basename(token.completionPath),
        completionBytes,
      );
      const terminal = await waitForCompletedWatchdogState({
        managed: token.managed,
        statePath: token.statePath,
        armed: token.armed,
        expectedUrl: context.captureUrl,
        expectedCompletionSha256: hashBytes(completionBytes),
      });
      if (terminal.status === "deadline-enforced") {
        throw new ProductionFidelityWallDeadlineError(context.gameKey, terminal);
      }
      return;
    }
    if (context.outcome !== "failed") fail(`watchdog outcome is invalid for ${context.gameKey}`);
    await stopManagedProcess(token.managed, "SIGTERM");
    const terminal = await waitForTerminalWatchdogState({
      managed: token.managed,
      statePath: token.statePath,
      armed: token.armed,
      outcome: "failed",
    });
    if (terminal.status === "deadline-enforced") {
      throw new ProductionFidelityWallDeadlineError(context.gameKey, terminal);
    }
  } finally {
    if (!processAlive(token.managed)) state.watchdogs.delete(token.managed);
  }
}

export function parseLocalProductionFidelityArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("arguments must be unique --name value pairs");
    }
    const key = name.slice(2);
    if (parsed.has(key)) fail(`--${key} was supplied more than once`);
    parsed.set(key, value);
  }
  const known = new Set([
    "candidate-dist",
    "repository",
    "corpus",
    "games",
    "capture-root",
    "output-directory",
    "chrome",
    "python",
  ]);
  for (const key of parsed.keys()) if (!known.has(key)) fail(`unknown --${key}`);
  for (const required of [
    "candidate-dist",
    "repository",
    "corpus",
    "games",
    "capture-root",
    "output-directory",
    "chrome",
  ]) if (!parsed.has(required)) fail(`missing --${required}`);
  const absolute = name => {
    const value = parsed.get(name);
    if (!path.isAbsolute(value)) fail(`--${name} must be an absolute path`);
    return path.resolve(value);
  };
  return Object.freeze({
    candidateDist: absolute("candidate-dist"),
    repository: absolute("repository"),
    corpusPath: absolute("corpus"),
    gamesRoot: absolute("games"),
    captureRoot: absolute("capture-root"),
    outputDirectory: absolute("output-directory"),
    chromeBinary: absolute("chrome"),
    python: parsed.get("python") ?? "python3",
  });
}

export function localProductionFidelityFailure(primaryFailure, cleanupFailures) {
  if (!Array.isArray(cleanupFailures)) fail("cleanup failures must be an array");
  if (cleanupFailures.length === 0) return primaryFailure;
  return new AggregateError(
    primaryFailure === null
      ? cleanupFailures
      : [primaryFailure, ...cleanupFailures],
    primaryFailure === null
      ? "local production fidelity cleanup failed"
      : "local production fidelity failed and exact-process cleanup also failed",
  );
}

export function controlledPerformanceTargetFailure(primaryFailure, closeFailure) {
  return closeFailure === null
    ? primaryFailure
    : localProductionFidelityFailure(primaryFailure, [closeFailure]);
}

export async function runLocalProductionFidelity(options, dependencies = {}) {
  const deps = Object.freeze({
    DevToolsSessionImpl: dependencies.DevToolsSessionImpl ?? DevToolsSession,
    fetchImpl: dependencies.fetchImpl ?? fetch,
    spawnImpl: dependencies.spawnImpl ?? spawnChild,
    uuid: dependencies.uuid ?? randomUUID,
  });
  const managedProcesses = [];
  const state = {
    captureRoot: null,
    chrome: null,
    fidelityServers: new Map(),
    watchdogs: new Set(),
    python: options.python ?? "python3",
  };
  let primaryFailure = null;
  try {
    const repository = await requireExactPlainDirectory(options.repository, "repository");
    const candidateRoot = await requireExactPlainDirectory(
      options.candidateDist,
      "candidate distribution",
    );
    const candidate = await verifyCandidateDistribution(candidateRoot);
    if (candidate.distRoot !== candidateRoot) fail("candidate distribution path changed");
    await validateCleanReleaseCheckout({ repository, release: candidate.release });
    const expectedCorpusPath = path.join(
      repository,
      "tools/compatibility/games/corpus.json",
    );
    if (path.resolve(options.corpusPath) !== expectedCorpusPath) {
      fail("corpus must be the exact checked-out production corpus path");
    }
    const [corpusFile, gamesRoot, chromeFile] = await Promise.all([
      requirePlainRegularFile(options.corpusPath, "production corpus"),
      requireExactPlainDirectory(options.gamesRoot, "games root"),
      requirePlainRegularFile(options.chromeBinary, "Chrome binary"),
    ]);
    const corpus = await readGameCompatibilityCorpus(corpusFile.path);
    if ((chromeFile.metadata.mode & 0o111) === 0) {
      fail("Chrome binary must be an executable non-symlink regular file");
    }
    const games = exactSevenGames(corpus);
    state.captureRoot = await createPrivateRoot(options.captureRoot, repository);
    const outputDirectory = await requireAbsentDirectChild(
      state.captureRoot,
      options.outputDirectory,
      "output directory",
    );
    const captureDirectory = await requireAbsentDirectChild(
      state.captureRoot,
      path.join(state.captureRoot, "capture"),
      "capture staging directory",
    );
    const executionPaths = await candidateExecutionPaths(candidate);
    const artifacts = artifactPaths(executionPaths);
    const allocatedRunIds = new Set();
    const allocateRunId = label => {
      const runId = exactUuid(deps.uuid(), label);
      if (allocatedRunIds.has(runId)) fail(`${label} repeated a prior generated run ID`);
      allocatedRunIds.add(runId);
      return runId;
    };
    const performanceRunId = allocateRunId("controlled-performance run ID");
    const fidelityRunIds = new Map(games.map(game => [
      game.key,
      allocateRunId(`${game.key} run ID`),
    ]));
    const baseAuthority = await productionFidelityLockAuthorityFromFiles({
      releaseManifestPath: candidate.releasePath,
      corpusPath: corpusFile.path,
      artifactPaths: artifacts,
      runId: fidelityRunIds.get(games[0].key),
      gameKey: games[0].key,
      repository,
    });

    const performanceAuthority = productionCorpusEvidenceAuthority({
      authority: baseAuthority,
      runId: performanceRunId,
      games,
    });
    const performanceLock = productionCorpusEvidenceLock({
      authority: baseAuthority,
      runId: performanceRunId,
      games,
    });
    const performanceLockBytes = Buffer.from(canonicalCaptureJson(performanceLock), "utf8");
    const performanceLockPath = await writeOwned(
      state.captureRoot,
      "performance/lock.json",
      performanceLockBytes,
    );

    const fidelityInputs = [];
    for (const game of games) {
      const runId = fidelityRunIds.get(game.key);
      const authority = fidelityAuthority(baseAuthority, runId, game);
      const lock = productionRendererFidelityEvidenceLock(authority);
      const lockBytes = schemaOrderedLockBytes(lock);
      const prefix = captureRelativePrefix(game);
      const evidenceLock = `${prefix}/evidence-lock.json`;
      const checkpointJournal = `${prefix}/checkpoint-journal.jsonl`;
      const evidenceLockPath = await writeOwned(state.captureRoot, evidenceLock, lockBytes);
      await verifyResidentProductionFidelityEvidenceLockFiles(lockBytes, {
        evidenceLockSha256: hashBytes(lockBytes),
        workspace: repository,
        artifactPaths: artifacts,
        executionAssetPaths: executionPaths,
        releaseManifestPath: candidate.releasePath,
        expectedAuthority: authority,
      });
      fidelityInputs.push(Object.freeze({
        game,
        runId,
        authority,
        lock,
        lockBytes,
        evidenceLock,
        evidenceLockPath,
        checkpointJournal,
        checkpointJournalPath: path.join(state.captureRoot, checkpointJournal),
      }));
    }

    const profile = path.join(state.captureRoot, "chrome-profile");
    state.chrome = await startChrome(chromeFile.path, profile, managedProcesses, deps);

    const performanceServer = await startJsonServer(state.python, [
      CORPUS_SERVER_PATH,
      "--root", repository,
      "--corpus", corpusFile.path,
      "--games", gamesRoot,
      ...serverArtifactArguments(executionPaths),
      "--execution-authority", performanceLockPath,
      ...serverExecutionArguments(executionPaths),
      "--bind", "127.0.0.1",
      "--port", "0",
    ], "controlled-performance server", games.map(game => game.key), managedProcesses, deps);
    let performanceReport;
    try {
      performanceReport = await captureControlledPerformance(
        state.chrome.endpoint,
        performanceUrl(performanceServer.url),
        deps,
      );
      validateResidentCorpusEvidence(performanceReport, {
        requireComplete: true,
        requireAll: true,
        trustedLock: performanceLock,
        expectedAuthority: performanceAuthority,
        evidenceLockSha256: hashBytes(performanceLockBytes),
      });
      await writeOwned(
        state.captureRoot,
        "performance/report.json",
        Buffer.from(canonicalCaptureJson(performanceReport), "utf8"),
      );
    } finally {
      await stopManagedProcess(performanceServer.managed, "SIGINT");
    }

    await Promise.all(fidelityInputs.map(async input => {
      const server = await startJsonServer(state.python, [
        FIDELITY_SERVER_PATH,
        "--evidence-lock", input.evidenceLockPath,
        "--checkpoint-log", input.checkpointJournalPath,
        "--checkpoint-body-cap", "4096",
        "--checkpoint-record-cap", "65535",
        "--checkpoint-probe-event-cap", "32768",
        "--root", repository,
        "--corpus", corpusFile.path,
        "--games", gamesRoot,
        "--game", input.game.key,
        ...serverArtifactArguments(executionPaths),
        ...serverExecutionArguments(executionPaths),
        "--bind", "127.0.0.1",
        "--port", "0",
      ], `fidelity server ${input.game.key}`, [input.game.key], managedProcesses, deps);
      state.fidelityServers.set(input.game.key, server);
    }));

    const captureGames = fidelityInputs.map(input => {
      const server = state.fidelityServers.get(input.game.key);
      const captureUrl = new URL("tools/resident_machine_first_frame.html", server.url);
      captureUrl.search = `?capture=fidelity&game=${encodeURIComponent(input.game.key)}`;
      return Object.freeze({
        key: input.game.key,
        evidenceLock: input.evidenceLock,
        checkpointJournal: input.checkpointJournal,
        captureUrl: captureUrl.href,
      });
    });
    const plan = localCapturePlan({
      cdpEndpoint: state.chrome.endpoint,
      performanceRunId,
      games: captureGames,
    }, games);
    await writeOwned(
      state.captureRoot,
      "plan.json",
      Buffer.from(canonicalCaptureJson(plan), "utf8"),
    );

    const bundle = await runProductionFidelityBundle({
      captureRoot: state.captureRoot,
      planPath: "plan.json",
      candidateDist: candidate.distRoot,
      captureDirectory,
      outputDirectory,
      repositoryPath: repository,
      corpusPath: corpusFile.path,
    }, {
      runCapture: captureOptions => runProductionFidelityCapture(captureOptions, {
        beforeGameNavigation: context => startWatchdog(context, state, deps),
        afterGameCapture: context => finishWatchdog(context, state),
        allowExistingEmptyOutputDirectory: true,
      }),
    });
    const attestationPath = path.join(outputDirectory, "attestation.json");
    const gate = await validateProductionFidelityAttestationFiles({
      attestationPath,
      releaseManifestPath: candidate.releasePath,
      corpusPath: corpusFile.path,
      repositoryPath: repository,
    });
    return Object.freeze({
      schema: LOCAL_PRODUCTION_FIDELITY_RESULT_SCHEMA,
      releaseId: candidate.release.releaseId,
      sourceCommit: candidate.release.source.commit,
      performanceRunId,
      gameRunIds: Object.freeze(Object.fromEntries(
        fidelityInputs.map(input => [input.game.key, input.runId]),
      )),
      captureRoot: state.captureRoot,
      outputDirectory,
      attestationPath,
      bundle,
      gate,
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    for (const watchdog of [...state.watchdogs].reverse()) {
      await stopManagedProcess(watchdog, "SIGTERM").catch(error => cleanupFailures.push(error));
    }
    for (const server of [...state.fidelityServers.values()].reverse()) {
      await stopManagedProcess(server.managed, "SIGINT").catch(error => cleanupFailures.push(error));
    }
    if (state.chrome !== null) {
      await stopManagedProcess(state.chrome.managed, "SIGTERM")
        .catch(error => cleanupFailures.push(error));
    }
    for (const managed of [...managedProcesses].reverse()) {
      if (!processAlive(managed)) continue;
      await stopManagedProcess(managed, "SIGTERM").catch(error => cleanupFailures.push(error));
    }
    const terminalFailure = localProductionFidelityFailure(primaryFailure, cleanupFailures);
    if (terminalFailure !== primaryFailure) throw terminalFailure;
  }
}

async function main() {
  const result = await runLocalProductionFidelity(
    parseLocalProductionFidelityArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${canonicalCaptureJson(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${formatProductionFidelityFailure(error)}\n`);
    process.exitCode = 1;
  });
}
