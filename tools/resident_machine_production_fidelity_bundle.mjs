#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  releaseAssets,
  rollbackReleaseAssets,
  validateRelease,
  verifyAssetBytes,
} from "../web/release.mjs";
import {
  GAME_COMPATIBILITY_CORPUS_PATH,
  readGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA,
  canonicalCaptureJson,
  productionFidelityRunFragment,
  runProductionFidelityCapture,
  validateCaptureUrl,
  validateLoopbackCdpEndpoint,
  writePrivateLeafAtomic,
} from "./resident_machine_production_fidelity_capture.mjs";
import {
  PRODUCTION_FIDELITY_ATTESTATION_SCHEMA,
  residentReleaseExecutionAssetsSha256,
  validateProductionFidelityAttestationFiles,
} from "./resident_machine_production_fidelity_gate.mjs";

export const PRODUCTION_FIDELITY_CAPTURE_PLAN_SCHEMA =
  "lazuli-resident-production-fidelity-capture-plan-v1";
export const PRODUCTION_FIDELITY_BUNDLE_RESULT_SCHEMA =
  "lazuli-resident-production-fidelity-bundle-result-v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_STEP_CAP = 65_535;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELATIVE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const RUNTIME_DESTINATIONS = Object.freeze({
  core: "runtime/core.wasm",
  dispatcher: "runtime/dispatcher.wasm",
  coordinator: "runtime/coordinator.wasm",
  adapter: "runtime/adapter.mjs",
  worker: "runtime/worker.mjs",
  frontend: "runtime/frontend.html",
  rendererJavascript: "runtime/renderer.js",
  rendererWasm: "runtime/renderer.wasm",
});
const RUN_REFERENCE_PATHS = Object.freeze({
  evidenceLock: "evidence-lock.json",
  checkpointJournal: "checkpoint-journal.jsonl",
  firstFrameReport: "first-frame-report.json",
  readyMachineEvidence: "ready-machine-evidence.json",
  baselineGameFidelityRecord: "baseline-game-fidelity.json",
  baselineMachineEvidence: "baseline-machine-evidence.json",
  preWitnessMachineEvidence: "pre-witness-machine-evidence.json",
  terminalMachineEvidence: "terminal-machine-evidence.json",
  gameFidelityRecord: "terminal-game-fidelity.json",
});

function fail(message) {
  throw new Error(`production fidelity bundle: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has keys ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
  }
  return value;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portableRelative(value, label) {
  if (
    typeof value !== "string"
    || !RELATIVE_PATH_PATTERN.test(value)
    || value.includes("\\")
    || path.isAbsolute(value)
    || value.split("/").some(part => part === "." || part === ".." || part === "")
  ) fail(`${label} must be a portable relative path without dot segments`);
  return value;
}

function containedRelative(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} escaped its trusted root`);
  }
  return relative;
}

async function requirePlainDirectory(directory, label) {
  const absolute = path.resolve(directory);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a non-symlink directory`);
  }
  return realpath(absolute);
}

async function resolveContainedRegularFile(root, relativeValue, label) {
  const relative = portableRelative(relativeValue, label);
  const parts = relative.split("/");
  let candidate = root;
  for (let index = 0; index < parts.length; index += 1) {
    candidate = path.join(candidate, parts[index]);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) fail(`${label} traversed a symlink`);
    if (index + 1 === parts.length) {
      if (!metadata.isFile()) fail(`${label} must name a regular file`);
    } else if (!metadata.isDirectory()) {
      fail(`${label} traversed a non-directory component`);
    }
  }
  const canonical = await realpath(candidate);
  containedRelative(root, canonical, label);
  return canonical;
}

function decodeCanonicalJson(bytes, label) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${label} is not UTF-8: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(`${label} is not JSON: ${error.message}`);
  }
  if (canonicalCaptureJson(value) !== source) {
    fail(`${label} must be recursive-key canonical JSON`);
  }
  return value;
}

function executionAssets(release) {
  const descriptor = value => ({ url: value.url, bytes: value.bytes, sha256: value.sha256 });
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

function validateReference(value, expectedPath, label) {
  exactKeys(value, ["path", "bytes", "sha256"], label);
  if (value.path !== expectedPath) fail(`${label}.path must be ${expectedPath}`);
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 128 * 1024 * 1024) {
    fail(`${label}.bytes is invalid`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    fail(`${label}.sha256 is invalid`);
  }
  return value;
}

function planEntryPath(value, label) {
  return portableRelative(value, label);
}

export function validateProductionFidelityCapturePlan(value, corpusGames) {
  const plan = exactKeys(value, [
    "schema", "cdpEndpoint", "controlledPerformance", "games",
  ], "capture plan");
  if (plan.schema !== PRODUCTION_FIDELITY_CAPTURE_PLAN_SCHEMA) {
    fail(`capture plan schema must be ${PRODUCTION_FIDELITY_CAPTURE_PLAN_SCHEMA}`);
  }
  const cdpEndpoint = validateLoopbackCdpEndpoint(plan.cdpEndpoint, "capture plan CDP endpoint").href;
  const performance = exactKeys(plan.controlledPerformance, [
    "runId", "report", "lock",
  ], "capture plan controlledPerformance");
  if (typeof performance.runId !== "string" || !UUID_PATTERN.test(performance.runId)) {
    fail("capture plan controlledPerformance.runId must be a UUID");
  }
  const controlledPerformance = Object.freeze({
    runId: performance.runId,
    report: planEntryPath(performance.report, "capture plan controlledPerformance.report"),
    lock: planEntryPath(performance.lock, "capture plan controlledPerformance.lock"),
  });
  if (!Array.isArray(corpusGames) || corpusGames.length !== 7) {
    fail("source corpus must contain exactly seven games");
  }
  if (!Array.isArray(plan.games) || plan.games.length !== corpusGames.length) {
    fail("capture plan must contain the exact seven games");
  }
  const games = plan.games.map((entryValue, index) => {
    const entry = exactKeys(entryValue, [
      "key", "evidenceLock", "checkpointJournal", "captureUrl",
    ], `capture plan games[${index}]`);
    const expected = corpusGames[index];
    if (entry.key !== expected.key) {
      fail(`capture plan games[${index}].key must be ${expected.key}`);
    }
    return Object.freeze({
      key: entry.key,
      evidenceLock: planEntryPath(entry.evidenceLock, `capture plan ${entry.key} evidenceLock`),
      checkpointJournal: planEntryPath(
        entry.checkpointJournal,
        `capture plan ${entry.key} checkpointJournal`,
      ),
      captureUrl: validateCaptureUrl(entry.captureUrl, entry.key),
    });
  });
  if (new Set(games.map(game => game.key)).size !== games.length) {
    fail("capture plan repeats a game key");
  }
  return Object.freeze({
    schema: plan.schema,
    cdpEndpoint,
    controlledPerformance,
    games: Object.freeze(games),
  });
}

export async function loadProductionFidelityCapturePlan({
  captureRoot,
  planPath,
  corpusGames,
}) {
  const trustedRoot = await requirePlainDirectory(captureRoot, "capture root");
  if (trustedRoot === path.parse(trustedRoot).root) {
    fail("capture root must not be a filesystem root");
  }
  const realPlan = await resolveContainedRegularFile(trustedRoot, planPath, "capture plan");
  const plan = validateProductionFidelityCapturePlan(
    decodeCanonicalJson(await readFile(realPlan), "capture plan"),
    corpusGames,
  );
  const controlledPerformance = Object.freeze({
    runId: plan.controlledPerformance.runId,
    report: await resolveContainedRegularFile(
      trustedRoot,
      plan.controlledPerformance.report,
      "controlled-performance report",
    ),
    lock: await resolveContainedRegularFile(
      trustedRoot,
      plan.controlledPerformance.lock,
      "controlled-performance lock",
    ),
  });
  const [reportBytes, lockBytes] = await Promise.all([
    readFile(controlledPerformance.report),
    readFile(controlledPerformance.lock),
  ]);
  const games = [];
  for (const game of plan.games) {
    games.push(Object.freeze({
      key: game.key,
      captureUrl: game.captureUrl,
      evidenceLock: await resolveContainedRegularFile(
        trustedRoot,
        game.evidenceLock,
        `${game.key} evidence lock`,
      ),
      checkpointJournal: await resolveContainedRegularFile(
        trustedRoot,
        game.checkpointJournal,
        `${game.key} checkpoint journal`,
      ),
    }));
  }
  return Object.freeze({
    schema: plan.schema,
    cdpEndpoint: plan.cdpEndpoint,
    controlledPerformance: Object.freeze({
      ...controlledPerformance,
      reportBytes,
      lockBytes,
    }),
    games: Object.freeze(games),
    trustedRoot,
    planPath: realPlan,
  });
}

async function readCandidateAsset(distRoot, descriptor, label) {
  if (
    typeof descriptor?.url !== "string"
    || !descriptor.url.startsWith("/")
    || descriptor.url.startsWith("//")
  ) fail(`${label} has an unsafe release URL`);
  const relative = portableRelative(descriptor.url.slice(1), `${label}.url`);
  const source = await resolveContainedRegularFile(distRoot, relative, label);
  const bytes = await readFile(source);
  await verifyAssetBytes(descriptor, bytes);
  return bytes;
}

export async function verifyCandidateDistribution(candidateDist, validateReleaseImpl = validateRelease) {
  const distRoot = await requirePlainDirectory(candidateDist, "candidate distribution");
  const releasePath = await resolveContainedRegularFile(distRoot, "release.json", "release manifest");
  const releaseBytes = await readFile(releasePath);
  let releaseValue;
  try {
    releaseValue = JSON.parse(releaseBytes);
  } catch (error) {
    fail(`release manifest is not JSON: ${error.message}`);
  }
  const release = await validateReleaseImpl(releaseValue);
  for (const [index, descriptor] of [
    ...releaseAssets(release),
    ...rollbackReleaseAssets(release),
  ].entries()) {
    await readCandidateAsset(distRoot, descriptor, `candidate asset ${index}`);
  }
  return Object.freeze({ distRoot, releasePath, releaseBytes, release });
}

async function copyReferencedLeaf({
  captureRoot,
  outputRoot,
  reference,
  expectedPath,
  label,
}) {
  validateReference(reference, expectedPath, label);
  const source = await resolveContainedRegularFile(captureRoot, reference.path, label);
  const bytes = await readFile(source);
  if (bytes.byteLength !== reference.bytes || hashBytes(bytes) !== reference.sha256) {
    fail(`${label} bytes do not match the run-fragment reference`);
  }
  return writePrivateLeafAtomic(outputRoot, expectedPath, bytes);
}

async function copyGameRun(captureRoot, outputRoot, corpusGame, index) {
  const prefix = `games/${String(index + 1).padStart(2, "0")}-${corpusGame.key}`;
  const fragmentPath = `${prefix}/run-fragment.json`;
  const realFragment = await resolveContainedRegularFile(captureRoot, fragmentPath, fragmentPath);
  const fragmentBytes = await readFile(realFragment);
  const fragment = decodeCanonicalJson(fragmentBytes, fragmentPath);
  exactKeys(fragment, ["schema", "run"], fragmentPath);
  if (fragment.schema !== PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA) {
    fail(`${fragmentPath} has the wrong schema`);
  }
  const run = productionFidelityRunFragment(fragment.run).run;
  if (run.key !== corpusGame.key) fail(`${fragmentPath} changed the corpus key`);

  const copied = {};
  for (const [field, filename] of Object.entries(RUN_REFERENCE_PATHS)) {
    copied[field] = await copyReferencedLeaf({
      captureRoot,
      outputRoot,
      reference: run[field],
      expectedPath: `${prefix}/${filename}`,
      label: `${fragmentPath}.${field}`,
    });
  }
  const firstVisible = await copyReferencedLeaf({
    captureRoot,
    outputRoot,
    reference: run.frames.firstVisible,
    expectedPath: `${prefix}/first-visible.rgba`,
    label: `${fragmentPath}.frames.firstVisible`,
  });
  const baselineMetadata = await copyReferencedLeaf({
    captureRoot,
    outputRoot,
    reference: run.frames.baseline.metadata,
    expectedPath: `${prefix}/baseline-readback-metadata.json`,
    label: `${fragmentPath}.frames.baseline.metadata`,
  });
  const baselineRgba = await copyReferencedLeaf({
    captureRoot,
    outputRoot,
    reference: run.frames.baseline.rgba,
    expectedPath: `${prefix}/baseline.rgba`,
    label: `${fragmentPath}.frames.baseline.rgba`,
  });
  const laterMetadata = await copyReferencedLeaf({
    captureRoot,
    outputRoot,
    reference: run.frames.later.metadata,
    expectedPath: `${prefix}/accepted-readback-metadata.json`,
    label: `${fragmentPath}.frames.later.metadata`,
  });
  const laterRgba = await copyReferencedLeaf({
    captureRoot,
    outputRoot,
    reference: run.frames.later.rgba,
    expectedPath: `${prefix}/accepted.rgba`,
    label: `${fragmentPath}.frames.later.rgba`,
  });
  return Object.freeze({
    ...run,
    ...copied,
    frames: Object.freeze({
      firstVisible,
      baseline: Object.freeze({ metadata: baselineMetadata, rgba: baselineRgba }),
      later: Object.freeze({ metadata: laterMetadata, rgba: laterRgba }),
    }),
  });
}

async function makeOutputDirectory(value, repositoryRoot, label) {
  const destination = path.resolve(value);
  const parent = await requirePlainDirectory(path.dirname(destination), `${label} parent`);
  const canonicalDestination = path.join(parent, path.basename(destination));
  const relative = path.relative(repositoryRoot, canonicalDestination);
  if (
    relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    fail(`${label} must be outside the repository`);
  }
  await mkdir(canonicalDestination, { mode: 0o700 });
  const metadata = await lstat(canonicalDestination);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    fail(`${label} was not created as a mode-0700 directory`);
  }
  return canonicalDestination;
}

export async function assembleProductionFidelityBundle({
  candidate,
  captureDirectory,
  capturePlan,
  corpusGames,
  corpusPath,
  outputDirectory,
  repositoryPath,
  now = () => new Date(),
  validateGate = validateProductionFidelityAttestationFiles,
}) {
  const repositoryRoot = await requirePlainDirectory(repositoryPath, "repository");
  const captureRoot = await requirePlainDirectory(captureDirectory, "capture staging directory");
  const candidateDistRoot = await requirePlainDirectory(
    candidate.distRoot,
    "candidate distribution",
  );
  const outputRoot = await makeOutputDirectory(outputDirectory, repositoryRoot, "evidence output");
  const release = candidate.release;
  const runtime = executionAssets(release);
  const runtimeAssets = {};
  for (const [role, destination] of Object.entries(RUNTIME_DESTINATIONS)) {
    const bytes = await readCandidateAsset(candidateDistRoot, runtime[role], `runtime ${role}`);
    runtimeAssets[role] = await writePrivateLeafAtomic(outputRoot, destination, bytes);
  }

  const performanceReportBytes = capturePlan.controlledPerformance.reportBytes;
  const performanceLockBytes = capturePlan.controlledPerformance.lockBytes;
  if (!Buffer.isBuffer(performanceReportBytes) || performanceReportBytes.byteLength === 0) {
    fail("controlled-performance report snapshot is unavailable");
  }
  if (!Buffer.isBuffer(performanceLockBytes) || performanceLockBytes.byteLength === 0) {
    fail("controlled-performance lock snapshot is unavailable");
  }
  const performanceReport = await writePrivateLeafAtomic(
    outputRoot,
    "controlled-performance/report.json",
    performanceReportBytes,
  );
  const performanceLock = await writePrivateLeafAtomic(
    outputRoot,
    "controlled-performance/lock.json",
    performanceLockBytes,
  );

  const games = [];
  for (let index = 0; index < corpusGames.length; index += 1) {
    games.push(await copyGameRun(captureRoot, outputRoot, corpusGames[index], index));
  }
  if (new Set(games.map(game => game.runId)).size !== games.length) {
    fail("captured run IDs are not unique");
  }
  const assetsSha256 = residentReleaseExecutionAssetsSha256(release);
  for (const game of games) {
    if (game.releaseId !== release.releaseId) fail(`${game.key} changed the candidate release ID`);
    if (game.executionAssetsSha256 !== assetsSha256) {
      fail(`${game.key} changed the candidate execution-asset identity`);
    }
  }

  const corpusBytes = await readFile(corpusPath);
  const createdAt = now().toISOString();
  const attestation = Object.freeze({
    schema: PRODUCTION_FIDELITY_ATTESTATION_SCHEMA,
    createdAt,
    corpus: Object.freeze({ sha256: hashBytes(corpusBytes) }),
    release: Object.freeze({
      schema: release.schema,
      releaseId: release.releaseId,
      manifestSha256: hashBytes(candidate.releaseBytes),
      sourceCommit: release.source.commit,
    }),
    controlledPerformance: Object.freeze({
      runId: capturePlan.controlledPerformance.runId,
      releaseId: release.releaseId,
      executionAssetsSha256: assetsSha256,
      runtimeAssets: Object.freeze(runtimeAssets),
      report: performanceReport,
      lock: performanceLock,
    }),
    games: Object.freeze(games),
  });
  const attestationReference = await writePrivateLeafAtomic(
    outputRoot,
    "attestation.json",
    Buffer.from(canonicalCaptureJson(attestation), "utf8"),
  );
  const validation = await validateGate({
    attestationPath: path.join(outputRoot, attestationReference.path),
    releaseManifestPath: candidate.releasePath,
    corpusPath,
    repositoryPath: repositoryRoot,
  });
  if (validation?.ok !== true || validation.releaseId !== release.releaseId) {
    fail("production fidelity gate did not accept the assembled bundle");
  }
  return Object.freeze({
    ok: true,
    schema: PRODUCTION_FIDELITY_BUNDLE_RESULT_SCHEMA,
    releaseId: release.releaseId,
    sourceCommit: release.source.commit,
    attestation: attestationReference,
    outputDirectory: outputRoot,
  });
}

function assertOutsideRepository(candidate, repository, label) {
  const relative = path.relative(repository, path.resolve(candidate));
  if (
    relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    fail(`${label} must be outside the repository`);
  }
}

export async function runProductionFidelityBundle(options, {
  runCapture = runProductionFidelityCapture,
  validateReleaseImpl = validateRelease,
  validateGate = validateProductionFidelityAttestationFiles,
  now = () => new Date(),
} = {}) {
  const repositoryRoot = await requirePlainDirectory(options.repositoryPath, "repository");
  const [candidate, corpus] = await Promise.all([
    verifyCandidateDistribution(options.candidateDist, validateReleaseImpl),
    readGameCompatibilityCorpus(options.corpusPath),
  ]);
  assertOutsideRepository(candidate.distRoot, repositoryRoot, "candidate distribution");
  const corpusGames = [...corpus.games].sort((left, right) => left.priority - right.priority);
  const plan = await loadProductionFidelityCapturePlan({
    captureRoot: options.captureRoot,
    planPath: options.planPath,
    corpusGames,
  });
  assertOutsideRepository(plan.trustedRoot, repositoryRoot, "capture root");
  const captureDirectory = await makeOutputDirectory(
    options.captureDirectory,
    repositoryRoot,
    "capture staging directory",
  );
  await runCapture({
    cdpEndpoint: plan.cdpEndpoint,
    captureUrls: new Map(plan.games.map(game => [game.key, game.captureUrl])),
    corpusPath: options.corpusPath,
    outputDirectory: captureDirectory,
    releasePath: candidate.releasePath,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    stepCap: DEFAULT_STEP_CAP,
    checkpointJournals: new Map(plan.games.map(game => [game.key, game.checkpointJournal])),
    evidenceLocks: new Map(plan.games.map(game => [game.key, game.evidenceLock])),
  });
  return assembleProductionFidelityBundle({
    candidate,
    captureDirectory,
    capturePlan: plan,
    corpusGames,
    corpusPath: options.corpusPath,
    outputDirectory: options.outputDirectory,
    repositoryPath: repositoryRoot,
    now,
    validateGate,
  });
}

function parseArguments(values) {
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
    "capture-root",
    "plan",
    "candidate-dist",
    "capture-directory",
    "output-directory",
    "repository",
    "corpus",
  ]);
  for (const key of parsed.keys()) if (!known.has(key)) fail(`unknown --${key}`);
  for (const required of [
    "capture-root",
    "plan",
    "candidate-dist",
    "capture-directory",
    "output-directory",
    "repository",
  ]) if (!parsed.has(required)) fail(`missing --${required}`);
  return Object.freeze({
    captureRoot: path.resolve(parsed.get("capture-root")),
    planPath: portableRelative(parsed.get("plan"), "--plan"),
    candidateDist: path.resolve(parsed.get("candidate-dist")),
    captureDirectory: path.resolve(parsed.get("capture-directory")),
    outputDirectory: path.resolve(parsed.get("output-directory")),
    repositoryPath: path.resolve(parsed.get("repository")),
    corpusPath: path.resolve(parsed.get("corpus") ?? GAME_COMPATIBILITY_CORPUS_PATH),
  });
}

async function main() {
  const result = await runProductionFidelityBundle(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${canonicalCaptureJson(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
