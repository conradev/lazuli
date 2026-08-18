#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const RESIDENT_CORPUS_EVIDENCE_SCHEMA =
  "lazuli-rust-resident-corpus-evidence-v1";
const RESIDENT_CORPUS_EVIDENCE_LOCK_SCHEMA =
  "lazuli-resident-corpus-evidence-lock-v1";
export const RESIDENT_CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA =
  "lazuli-resident-corpus-evidence-lock-v2";
const RESIDENT_CORPUS_ARTIFACT_SCHEMA =
  "lazuli-resident-corpus-artifacts-v1";
const RESIDENT_TRANSPORT_SCHEMA =
  "lazuli-resident-opaque-transport-v1";
const RESIDENT_PROOF =
  "Generic Rust/Wasm-resident corpus CPU evidence; not visual certification";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ARTIFACT_NAMES = [
  "browser_machine.wasm",
  "resident_dispatcher.wasm",
  "core_run_coordinator.wasm",
  "browser_renderer.js",
  "browser_renderer_bg.wasm",
];
const EXECUTION_ROLES = [
  "core",
  "dispatcher",
  "coordinator",
  "adapter",
  "worker",
  "frontend",
  "rendererJavascript",
  "rendererWasm",
];
const PRODUCTION_SOURCE_PATHS = [
  "tools/resident_machine_corpus.html",
  "tools/resident_machine_corpus.mjs",
  "tools/resident_machine_corpus_report.mjs",
  "tools/resident_machine_corpus_server.py",
];

function fail(location, message) {
  throw new Error(`invalid resident corpus evidence at ${location}: ${message}`);
}

function object(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(location, "expected an object");
  }
  return value;
}

function array(value, location) {
  if (!Array.isArray(value)) fail(location, "expected an array");
  return value;
}

function exact(value, expected, location) {
  if (value !== expected) {
    fail(location, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
}

function nonNegativeInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(location, "expected a non-negative safe integer");
  }
  return value;
}

function positiveInteger(value, location, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(location, `expected a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function positiveNumber(value, location) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(location, "expected a positive finite number");
  }
  return value;
}

function decimal(value, location) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    fail(location, "expected an unsigned decimal string");
  }
  return BigInt(value);
}

function positiveDecimal(value, location, maximum = null) {
  const parsed = decimal(value, location);
  if (parsed === 0n) fail(location, "expected a positive decimal string");
  if (maximum !== null && parsed > maximum) {
    fail(location, `expected a value no greater than ${maximum}`);
  }
  return parsed;
}

function closeNumber(actual, expected, location) {
  positiveNumber(actual, location);
  if (!Number.isFinite(expected)) fail(location, "expected rate overflowed");
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9);
  if (Math.abs(actual - expected) > tolerance) {
    fail(location, `expected ${expected}, got ${actual}`);
  }
}

function exactJson(value, expected, location) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(location, "did not match the trusted lock");
  }
}

function exactKeys(value, expected, location) {
  const actual = Object.keys(object(value, location)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(location, `expected exact keys ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
}

function sha256(value, location) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(location, "expected a lowercase SHA-256 digest");
  }
  return value;
}

function verifyCounterTree(value, location, { requireZero = false } = {}) {
  const counters = object(value, location);
  for (const [name, child] of Object.entries(counters)) {
    const childLocation = `${location}.${name}`;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      verifyCounterTree(child, childLocation, { requireZero });
    } else {
      nonNegativeInteger(child, childLocation);
      if (requireZero) exact(child, 0, childLocation);
    }
  }
  return counters;
}

function verifyPolicy(value) {
  const location = "$.policy";
  const policy = object(value, location);
  exact(policy.transport, "frozen-resident-machine-worker", `${location}.transport`);
  exact(policy.measurementMode, "fixed-instruction-progress", `${location}.measurementMode`);
  const warmupInstructionTarget = positiveDecimal(
    policy.warmupInstructionTarget,
    `${location}.warmupInstructionTarget`,
    1_000_000_000_000n,
  );
  const measurementInstructionTarget = positiveDecimal(
    policy.measurementInstructionTarget,
    `${location}.measurementInstructionTarget`,
    1_000_000_000_000n,
  );
  const cycleUpperCap = positiveDecimal(
    policy.cycleUpperCap,
    `${location}.cycleUpperCap`,
    1_000_000n,
  );
  positiveInteger(policy.blockUpperCap, `${location}.blockUpperCap`, 16_384);
  positiveInteger(policy.maxHostCalls, `${location}.maxHostCalls`, 65_535);
  positiveInteger(policy.maxColdInstalls, `${location}.maxColdInstalls`, 65_535);
  positiveInteger(policy.maxBootReads, `${location}.maxBootReads`, 65_535);
  positiveInteger(policy.bootTimeoutMs, `${location}.bootTimeoutMs`, 600_000);
  positiveInteger(policy.sliceTimeoutMs, `${location}.sliceTimeoutMs`, 600_000);
  positiveInteger(policy.windowTimeoutMs, `${location}.windowTimeoutMs`, 600_000);
  positiveInteger(policy.zeroProgressSliceCap, `${location}.zeroProgressSliceCap`, 65_535);
  if (typeof policy.continueOnFailure !== "boolean") {
    fail(`${location}.continueOnFailure`, "expected a boolean");
  }
  return {
    ...policy,
    warmupInstructionTarget,
    measurementInstructionTarget,
    cycleUpperCap,
  };
}

function verifyWindow(value, location, label, expectedTarget, policy) {
  const window = object(value, location);
  exact(window.label, label, `${location}.label`);
  exact(window.complete, true, `${location}.complete`);
  exact(window.targetReached, true, `${location}.targetReached`);
  const wallMs = positiveNumber(window.wallMs, `${location}.wallMs`);
  if (wallMs > policy.windowTimeoutMs) {
    fail(`${location}.wallMs`, "exceeded the policy window timeout");
  }
  const instructions = positiveDecimal(
    window.executedInstructions,
    `${location}.executedInstructions`,
  );
  const target = positiveDecimal(window.targetInstructions, `${location}.targetInstructions`);
  if (target !== expectedTarget) fail(location, "window target did not match policy");
  const cycles = positiveDecimal(window.executedCycles, `${location}.executedCycles`);
  if (instructions < target) fail(location, "completed window missed its instruction target");
  const overshoot = instructions - target;
  exact(window.instructionOvershoot, overshoot.toString(), `${location}.instructionOvershoot`);
  for (const name of [
    "hostCallCapBoundaries",
    "coldInstallCapBoundaries",
    "workerTimeoutBoundaries",
    "zeroProgressCapBoundaries",
    "rustStopBoundaries",
  ]) {
    exact(window[name], 0, `${location}.${name}`);
  }
  const slices = positiveInteger(window.slices, `${location}.slices`);
  exact(window.rustBoundaries, slices, `${location}.rustBoundaries`);
  exact(window.zeroProgressSlices, 0, `${location}.zeroProgressSlices`);
  exact(window.consecutiveZeroProgressSlices, 0, `${location}.consecutiveZeroProgressSlices`);
  exact(
    window.maximumConsecutiveZeroProgressSlices,
    0,
    `${location}.maximumConsecutiveZeroProgressSlices`,
  );
  const servicedHostCalls = nonNegativeInteger(
    window.servicedHostCalls,
    `${location}.servicedHostCalls`,
  );
  const coldInstalls = nonNegativeInteger(window.coldInstalls, `${location}.coldInstalls`);
  if (servicedHostCalls > slices * policy.maxHostCalls) {
    fail(`${location}.servicedHostCalls`, "exceeded the slice-scaled host-call cap");
  }
  if (coldInstalls > slices * policy.maxColdInstalls) {
    fail(`${location}.coldInstalls`, "exceeded the slice-scaled cold-install cap");
  }
  if (cycles > BigInt(slices) * policy.cycleUpperCap) {
    fail(`${location}.executedCycles`, "exceeded the slice-scaled cycle cap");
  }
  const maximumAuthenticatedInstructions = BigInt(slices)
    * BigInt(policy.blockUpperCap)
    * 65_535n;
  if (instructions > maximumAuthenticatedInstructions) {
    fail(
      `${location}.executedInstructions`,
      "exceeded the slice/block authenticated instruction bound",
    );
  }
  const outcomeDetails = object(window.outcomeDetails, `${location}.outcomeDetails`);
  exactJson(outcomeDetails, { 0: slices }, `${location}.outcomeDetails`);
  const seconds = wallMs / 1_000;
  closeNumber(
    window.cyclesPerSecond,
    Number(cycles) / seconds,
    `${location}.cyclesPerSecond`,
  );
  closeNumber(
    window.instructionsPerSecond,
    Number(instructions) / seconds,
    `${location}.instructionsPerSecond`,
  );
}

function verifyTransport(
  value,
  location,
  gameKey,
  { requireReads = true, requireNoFaults = true } = {},
) {
  const transport = object(value, location);
  exact(transport.snapshotUnavailable, false, `${location}.snapshotUnavailable`);
  const before = object(transport.before, `${location}.before`);
  const after = object(transport.after, `${location}.after`);
  exact(before.schema, RESIDENT_TRANSPORT_SCHEMA, `${location}.before.schema`);
  exact(after.schema, RESIDENT_TRANSPORT_SCHEMA, `${location}.after.schema`);
  exact(before.gameKey, gameKey, `${location}.before.gameKey`);
  exact(after.gameKey, gameKey, `${location}.after.gameKey`);
  for (const name of [
    "physicalReadRequests",
    "physicalReadBytes",
    "invalidRangeRequests",
    "preconditionFailures",
  ]) {
    nonNegativeInteger(before[name], `${location}.before.${name}`);
    nonNegativeInteger(after[name], `${location}.after.${name}`);
    if (after[name] < before[name]) fail(location, `${name} regressed`);
  }
  if (requireReads && after.physicalReadRequests <= before.physicalReadRequests) {
    fail(location, "expected at least one exact physical range read");
  }
  if (requireReads && after.physicalReadBytes <= before.physicalReadBytes) {
    fail(location, "expected positive physical range bytes");
  }
  if (requireNoFaults) {
    exact(
      after.invalidRangeRequests,
      before.invalidRangeRequests,
      `${location}.invalidRangeRequests delta`,
    );
    exact(
      after.preconditionFailures,
      before.preconditionFailures,
      `${location}.preconditionFailures delta`,
    );
  }
}

function verifyIdentity(value, location, expected = null) {
  const game = object(value, location);
  if (typeof game.key !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(game.key)) {
    fail(`${location}.key`, "expected a lowercase kebab-case key");
  }
  if (!Number.isSafeInteger(game.priority) || game.priority <= 0) {
    fail(`${location}.priority`, "expected a positive integer");
  }
  if (!Number.isSafeInteger(game.bytes) || game.bytes <= 0) {
    fail(`${location}.bytes`, "expected a positive integer");
  }
  if (typeof game.sha256 !== "string" || !SHA256_PATTERN.test(game.sha256)) {
    fail(`${location}.sha256`, "expected a lowercase SHA-256");
  }
  if (expected !== null) {
    for (const name of ["key", "priority", "bytes", "sha256"]) {
      exact(game[name], expected[name], `${location}.${name}`);
    }
  }
  return game.key;
}

function verifyProductionRelease(value, location) {
  const release = object(value, location);
  exactKeys(release, [
    "schema",
    "releaseId",
    "manifestBytes",
    "manifestSha256",
    "sourceCommit",
    "executionAssetsSha256",
    "executionAssets",
  ], location);
  exact(release.schema, 4, `${location}.schema`);
  sha256(release.releaseId, `${location}.releaseId`);
  positiveInteger(release.manifestBytes, `${location}.manifestBytes`);
  sha256(release.manifestSha256, `${location}.manifestSha256`);
  if (typeof release.sourceCommit !== "string" || !COMMIT_PATTERN.test(release.sourceCommit)) {
    fail(`${location}.sourceCommit`, "expected a lowercase 40-hex commit");
  }
  sha256(release.executionAssetsSha256, `${location}.executionAssetsSha256`);
  exactKeys(release.executionAssets, EXECUTION_ROLES, `${location}.executionAssets`);
  for (const role of EXECUTION_ROLES) {
    const descriptor = object(
      release.executionAssets[role],
      `${location}.executionAssets.${role}`,
    );
    exactKeys(descriptor, ["url", "bytes", "sha256"], `${location}.executionAssets.${role}`);
    if (typeof descriptor.url !== "string"
        || !descriptor.url.startsWith("/")
        || descriptor.url.startsWith("//")) {
      fail(`${location}.executionAssets.${role}.url`, "expected a same-origin absolute path");
    }
    positiveInteger(descriptor.bytes, `${location}.executionAssets.${role}.bytes`);
    sha256(descriptor.sha256, `${location}.executionAssets.${role}.sha256`);
  }
  return release;
}

function verifyTrustedLock(value, expectedAuthority = null) {
  const location = "trustedLock";
  const lock = object(value, location);
  const production = lock.schema === RESIDENT_CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA;
  if (!production) exact(lock.schema, RESIDENT_CORPUS_EVIDENCE_LOCK_SCHEMA, `${location}.schema`);
  if (production) {
    exactKeys(lock, [
      "schema",
      "release",
      "run",
      "sourceCorpusSha256",
      "games",
      "artifacts",
      "sources",
      "runPolicy",
    ], location);
    verifyProductionRelease(lock.release, `${location}.release`);
    exactKeys(lock.run, ["runId", "selectedGameKeys"], `${location}.run`);
    if (typeof lock.run.runId !== "string" || !UUID_PATTERN.test(lock.run.runId)) {
      fail(`${location}.run.runId`, "expected a UUID");
    }
    if (!Array.isArray(lock.run.selectedGameKeys) || lock.run.selectedGameKeys.length === 0) {
      fail(`${location}.run.selectedGameKeys`, "expected a nonempty array");
    }
    exactKeys(lock.sources, PRODUCTION_SOURCE_PATHS, `${location}.sources`);
    for (const source of PRODUCTION_SOURCE_PATHS) {
      const record = object(lock.sources[source], `${location}.sources.${source}`);
      exactKeys(record, ["bytes", "sha256"], `${location}.sources.${source}`);
      positiveInteger(record.bytes, `${location}.sources.${source}.bytes`);
      sha256(record.sha256, `${location}.sources.${source}.sha256`);
    }
  }
  if (!SHA256_PATTERN.test(lock.sourceCorpusSha256)) {
    fail(`${location}.sourceCorpusSha256`, "expected a lowercase SHA-256");
  }
  const games = array(lock.games, `${location}.games`);
  if (games.length === 0) fail(`${location}.games`, "trusted corpus must not be empty");
  const byKey = new Map();
  for (const [index, game] of games.entries()) {
    const key = verifyIdentity(game, `${location}.games[${index}]`);
    if (byKey.has(key)) fail(`${location}.games`, "duplicate trusted game key");
    byKey.set(key, game);
  }
  const artifacts = object(lock.artifacts, `${location}.artifacts`);
  exact(artifacts.schema, RESIDENT_CORPUS_ARTIFACT_SCHEMA, `${location}.artifacts.schema`);
  const records = object(artifacts.artifacts, `${location}.artifacts.artifacts`);
  exactJson(Object.keys(records).sort(), [...ARTIFACT_NAMES].sort(), `${location}.artifact names`);
  for (const name of ARTIFACT_NAMES) {
    const artifact = object(records[name], `${location}.artifacts.artifacts.${name}`);
    positiveInteger(artifact.bytes, `${location}.artifacts.artifacts.${name}.bytes`);
    if (!SHA256_PATTERN.test(artifact.sha256)) {
      fail(`${location}.artifacts.artifacts.${name}.sha256`, "expected a lowercase SHA-256");
    }
  }
  if (production) {
    const artifactRoles = {
      "browser_machine.wasm": "core",
      "resident_dispatcher.wasm": "dispatcher",
      "core_run_coordinator.wasm": "coordinator",
      "browser_renderer.js": "rendererJavascript",
      "browser_renderer_bg.wasm": "rendererWasm",
    };
    for (const [name, role] of Object.entries(artifactRoles)) {
      const descriptor = lock.release.executionAssets[role];
      exact(records[name].bytes, descriptor.bytes, `${location}.artifacts.${name}.bytes`);
      exact(records[name].sha256, descriptor.sha256, `${location}.artifacts.${name}.sha256`);
    }
    const exactPolicy = {
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
      workerUrl: lock.release.executionAssets.worker.url,
    };
    exactKeys(lock.runPolicy, Object.keys(exactPolicy), `${location}.runPolicy`);
    for (const [field, expected] of Object.entries(exactPolicy)) {
      exact(lock.runPolicy[field], expected, `${location}.runPolicy.${field}`);
    }
    exactJson(lock.run.selectedGameKeys, games.map(game => game.key), `${location}.run.selectedGameKeys`);
    const authority = object(expectedAuthority, "options.expectedAuthority");
    exactKeys(
      authority,
      ["release", "run", "sourceCorpusSha256", "games", "artifacts"],
      "options.expectedAuthority",
    );
    for (const field of ["release", "run", "sourceCorpusSha256", "games", "artifacts"]) {
      exactJson(lock[field], authority[field], `${location}.${field}`);
    }
  }
  return { ...lock, byKey, production };
}

function verifyCompleteGame(value, index, policy, trustedGame) {
  const location = `$.games[${index}]`;
  const report = object(value, location);
  exact(report.status, "complete", `${location}.status`);
  const key = verifyIdentity(report.game, `${location}.game`, trustedGame);
  const boot = object(report.boot, `${location}.boot`);
  exact(boot.status, 3, `${location}.boot.status`);
  const bootReads = positiveInteger(boot.reads, `${location}.boot.reads`);
  if (bootReads > policy.maxBootReads) {
    fail(`${location}.boot.reads`, "exceeded the policy boot-read cap");
  }
  const bootWallMs = positiveNumber(boot.wallMs, `${location}.boot.wallMs`);
  if (bootWallMs > policy.bootTimeoutMs) {
    fail(`${location}.boot.wallMs`, "exceeded the policy boot timeout");
  }
  verifyWindow(
    report.warmup,
    `${location}.warmup`,
    "warmup",
    policy.warmupInstructionTarget,
    policy,
  );
  verifyWindow(
    report.measurement,
    `${location}.measurement`,
    "measurement",
    policy.measurementInstructionTarget,
    policy,
  );
  verifyTransport(report.transport, `${location}.transport`, key);
  exact(report.renderer.resetBeforeGame, true, `${location}.renderer.resetBeforeGame`);
  exact(
    report.renderer.diagnosticsResetBeforeGame,
    true,
    `${location}.renderer.diagnosticsResetBeforeGame`,
  );
  exact(report.renderer.failures, 0, `${location}.renderer.failures`);
  const rendererBefore = verifyCounterTree(
    report.renderer.before,
    `${location}.renderer.before`,
    { requireZero: true },
  );
  const rendererAfter = verifyCounterTree(
    report.renderer.after,
    `${location}.renderer.after`,
  );
  exact(report.inputSamples, 0, `${location}.inputSamples`);
  const diagnostics = object(report.adapterDiagnostics, `${location}.adapterDiagnostics`);
  const beforeDiagnostics = object(
    diagnostics.before,
    `${location}.adapterDiagnostics.before`,
  );
  const afterDiagnostics = object(
    diagnostics.after,
    `${location}.adapterDiagnostics.after`,
  );
  exact(beforeDiagnostics.booted, true, `${location}.adapterDiagnostics.before.booted`);
  exact(afterDiagnostics.booted, true, `${location}.adapterDiagnostics.after.booted`);
  for (const [name, expected] of [["tableSlots", 4096], ["totalControllerRetries", 0]]) {
    exact(beforeDiagnostics[name], expected, `${location}.adapterDiagnostics.before.${name}`);
    exact(afterDiagnostics[name], expected, `${location}.adapterDiagnostics.after.${name}`);
  }
  exact(
    beforeDiagnostics.pendingControllerSample,
    false,
    `${location}.adapterDiagnostics.before.pendingControllerSample`,
  );
  exact(
    afterDiagnostics.pendingControllerSample,
    false,
    `${location}.adapterDiagnostics.after.pendingControllerSample`,
  );
  for (const name of [
    "memoryPages",
    "totalBootReads",
    "totalDiReads",
    "totalRenderCalls",
    "totalColdInstalls",
  ]) {
    nonNegativeInteger(beforeDiagnostics[name], `${location}.adapterDiagnostics.before.${name}`);
    nonNegativeInteger(afterDiagnostics[name], `${location}.adapterDiagnostics.after.${name}`);
    if (afterDiagnostics[name] < beforeDiagnostics[name]) {
      fail(`${location}.adapterDiagnostics.${name}`, "cumulative counter regressed");
    }
  }
  if (beforeDiagnostics.memoryPages === 0 || afterDiagnostics.memoryPages === 0) {
    fail(`${location}.adapterDiagnostics`, "resident memory page count must be positive");
  }
  if (afterDiagnostics.memoryPages < beforeDiagnostics.memoryPages) {
    fail(`${location}.adapterDiagnostics`, "resident memory page count regressed");
  }
  const totals = object(report.residentTotals, `${location}.residentTotals`);
  for (const name of ["bootPhysicalReads", "diPhysicalReads", "coldInstalls", "renderCalls"]) {
    nonNegativeInteger(totals[name], `${location}.residentTotals.${name}`);
  }
  exact(totals.bootPhysicalReads, boot.reads, `${location}.residentTotals.bootPhysicalReads`);
  exact(
    totals.diPhysicalReads,
    diagnostics.after.totalDiReads,
    `${location}.residentTotals.diPhysicalReads`,
  );
  exact(
    totals.coldInstalls,
    diagnostics.after.totalColdInstalls,
    `${location}.residentTotals.coldInstalls`,
  );
  exact(
    totals.renderCalls,
    diagnostics.after.totalRenderCalls,
    `${location}.residentTotals.renderCalls`,
  );
  exact(
    diagnostics.before.totalBootReads,
    boot.reads,
    `${location}.adapterDiagnostics.before.totalBootReads`,
  );
  exact(
    diagnostics.after.totalBootReads,
    boot.reads,
    `${location}.adapterDiagnostics.after.totalBootReads`,
  );
  exact(
    diagnostics.before.totalColdInstalls,
    report.warmup.coldInstalls,
    `${location}.adapterDiagnostics.before.totalColdInstalls`,
  );
  exact(
    diagnostics.after.totalColdInstalls,
    report.warmup.coldInstalls + report.measurement.coldInstalls,
    `${location}.adapterDiagnostics.after.totalColdInstalls`,
  );
  exact(
    report.warmup.servicedHostCalls,
    beforeDiagnostics.totalDiReads + beforeDiagnostics.totalRenderCalls,
    `${location}.warmup.servicedHostCalls`,
  );
  exact(
    report.measurement.servicedHostCalls,
    afterDiagnostics.totalDiReads - beforeDiagnostics.totalDiReads
      + afterDiagnostics.totalRenderCalls - beforeDiagnostics.totalRenderCalls,
    `${location}.measurement.servicedHostCalls`,
  );
  exact(
    report.renderer.calls,
    totals.renderCalls,
    `${location}.renderer.calls`,
  );
  exact(
    report.warmup.servicedHostCalls + report.measurement.servicedHostCalls,
    totals.diPhysicalReads + totals.renderCalls,
    `${location}.residentTotals host-call agreement`,
  );
  exact(
    report.transport.after.physicalReadRequests
      - report.transport.before.physicalReadRequests,
    1 + totals.bootPhysicalReads + totals.diPhysicalReads,
    `${location}.transport physical-read agreement`,
  );
  exact(
    rendererAfter.wasmBridgeCalls,
    report.renderer.calls,
    `${location}.renderer.after.wasmBridgeCalls`,
  );
  if (Object.keys(rendererBefore).length === 0 || Object.keys(rendererAfter).length === 0) {
    fail(`${location}.renderer`, "renderer diagnostics must not be empty");
  }
  const faults = object(report.faults, `${location}.faults`);
  for (const name of [
    "rustStops",
    "hostCallCaps",
    "coldInstallCaps",
    "workerTimeouts",
    "zeroProgressCaps",
    "invalidRangeRequests",
    "preconditionFailures",
    "rendererFailures",
  ]) {
    exact(faults[name], 0, `${location}.faults.${name}`);
  }
  return key;
}

export function validateResidentCorpusEvidence(
  value,
  {
    requireComplete = false,
    requireAll = false,
    trustedLock = null,
    expectedAuthority = null,
    evidenceLockSha256 = null,
  } = {},
) {
  const report = object(value, "$");
  exact(report.schema, RESIDENT_CORPUS_EVIDENCE_SCHEMA, "$.schema");
  exact(report.proof, RESIDENT_PROOF, "$.proof");
  if (!new Set(["complete", "partial", "failed"]).has(report.status)) {
    fail("$.status", "expected complete, partial, or failed");
  }
  if (requireComplete) exact(report.status, "complete", "$.status");
  if (requireAll && !requireComplete) {
    fail("options.requireAll", "requires requireComplete");
  }
  const trusted = trustedLock === null
    ? null
    : verifyTrustedLock(trustedLock, expectedAuthority);
  if (requireComplete && trusted === null) {
    fail("options.trustedLock", "complete publication requires an external trusted lock");
  }
  const environment = object(report.environment, "$.environment");
  exact(environment.crossOriginIsolated, true, "$.environment.crossOriginIsolated");
  if (typeof environment.userAgent !== "string" || environment.userAgent.length === 0) {
    fail("$.environment.userAgent", "expected a nonempty user agent");
  }
  positiveInteger(environment.hardwareConcurrency, "$.environment.hardwareConcurrency");
  const policy = verifyPolicy(report.policy);
  if (trusted?.production) {
    sha256(evidenceLockSha256, "options.evidenceLockSha256");
    const reportLock = object(report.evidenceLock, "$.evidenceLock");
    exactKeys(reportLock, ["schema", "sha256", "runId"], "$.evidenceLock");
    exact(reportLock.schema, trusted.schema, "$.evidenceLock.schema");
    exact(reportLock.sha256, evidenceLockSha256, "$.evidenceLock.sha256");
    exact(reportLock.runId, trusted.run.runId, "$.evidenceLock.runId");
    const expectedPolicy = { ...trusted.runPolicy };
    delete expectedPolicy.workerUrl;
    exactJson(report.policy, expectedPolicy, "$.policy");
  }
  const artifacts = object(report.artifacts, "$.artifacts");
  exact(artifacts.schema, RESIDENT_CORPUS_ARTIFACT_SCHEMA, "$.artifacts.schema");
  const artifactRecords = object(artifacts.artifacts, "$.artifacts.artifacts");
  exactJson(Object.keys(artifactRecords).sort(), [...ARTIFACT_NAMES].sort(), "$.artifact names");
  for (const name of ARTIFACT_NAMES) {
    const artifact = object(artifactRecords[name], `$.artifacts.artifacts.${name}`);
    positiveInteger(artifact.bytes, `$.artifacts.artifacts.${name}.bytes`);
    if (typeof artifact.sha256 !== "string" || !SHA256_PATTERN.test(artifact.sha256)) {
      fail(`$.artifacts.artifacts.${name}.sha256`, "expected a lowercase SHA-256");
    }
  }
  if (trusted !== null) {
    for (const name of ARTIFACT_NAMES) {
      for (const field of ["bytes", "sha256"]) {
        exact(
          artifactRecords[name][field],
          trusted.artifacts.artifacts[name][field],
          `$.artifacts.artifacts.${name}.${field}`,
        );
      }
    }
  }
  const boundary = object(report.capabilityBoundary, "$.capabilityBoundary");
  for (const name of [
    "rawPhysicalRangesOnly",
    "canonicalRendererReceiptsOnly",
    "memoryViewsReacquiredByFrozenAdapterAfterAwait",
  ]) {
    exact(boundary[name], true, `$.capabilityBoundary.${name}`);
  }
  for (const name of [
    "inputSamples",
    "browserSemanticArguments",
    "javascriptDispatchTableSets",
    "javascriptContainerParsers",
  ]) {
    exact(boundary[name], 0, `$.capabilityBoundary.${name}`);
  }

  const games = array(report.games, "$.games");
  const summary = object(report.summary, "$.summary");
  const corpus = object(report.corpus, "$.corpus");
  if (typeof corpus.sourceCorpusSha256 !== "string"
      || !SHA256_PATTERN.test(corpus.sourceCorpusSha256)) {
    fail("$.corpus.sourceCorpusSha256", "expected a lowercase SHA-256");
  }
  if (trusted !== null) {
    exact(
      corpus.sourceCorpusSha256,
      trusted.sourceCorpusSha256,
      "$.corpus.sourceCorpusSha256",
    );
  }
  const selectedGameKeys = array(corpus.selectedGameKeys, "$.corpus.selectedGameKeys");
  if (requireComplete && selectedGameKeys.length === 0) {
    fail("$.corpus.selectedGameKeys", "complete evidence must select at least one game");
  }
  const selectedSet = new Set();
  for (const [index, key] of selectedGameKeys.entries()) {
    if (typeof key !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
      fail(`$.corpus.selectedGameKeys[${index}]`, "expected a lowercase kebab-case key");
    }
    if (selectedSet.has(key)) fail("$.corpus.selectedGameKeys", "duplicate selected game key");
    selectedSet.add(key);
    if (trusted !== null && !trusted.byKey.has(key)) {
      fail(`$.corpus.selectedGameKeys[${index}]`, "game is absent from the trusted corpus");
    }
  }
  if (trusted?.production) {
    exactJson(selectedGameKeys, trusted.run.selectedGameKeys, "$.corpus.selectedGameKeys");
  }
  if (requireAll) {
    exactJson(
      selectedGameKeys,
      trusted.games.map(game => game.key),
      "$.corpus.selectedGameKeys",
    );
  }
  const complete = games.filter(game => game.status === "complete");
  const failed = games.filter(game => game.status === "failed");
  if (complete.length + failed.length !== games.length) {
    fail("$.games", "each game must be complete or failed");
  }
  const keys = [];
  games.forEach((game, index) => {
    const selectedKey = selectedGameKeys[index];
    const trustedGame = trusted?.byKey.get(selectedKey) ?? null;
    if (game.status === "complete") {
      keys.push(verifyCompleteGame(game, index, policy, trustedGame));
    } else {
      const location = `$.games[${index}]`;
      keys.push(verifyIdentity(game.game, `${location}.game`, trustedGame));
      if (typeof game.error !== "string" || game.error.length === 0) {
        fail(`${location}.error`, "expected an exact failure string");
      }
      const boundaryEvidence = object(game.boundaryEvidence, `${location}.boundaryEvidence`);
      if (typeof game.phase !== "string" || game.phase.length === 0) {
        fail(`${location}.phase`, "expected a typed failure phase");
      }
      if (typeof boundaryEvidence.boundary !== "string" || boundaryEvidence.boundary.length === 0) {
        fail(`${location}.boundaryEvidence.boundary`, "expected a typed failure boundary");
      }
      if (typeof boundaryEvidence.unobservablePartialRustCounters !== "boolean") {
        fail(
          `${location}.boundaryEvidence.unobservablePartialRustCounters`,
          "expected an explicit counter-observability marker",
        );
      }
      if (typeof game.isolationCompromised !== "boolean") {
        fail(`${location}.isolationCompromised`, "expected an isolation marker");
      }
      const failureTransport = object(game.transport, `${location}.transport`);
      if (typeof failureTransport.snapshotUnavailable !== "boolean") {
        fail(`${location}.transport.snapshotUnavailable`, "expected an availability marker");
      }
      if (!failureTransport.snapshotUnavailable) {
        verifyTransport(
          failureTransport,
          `${location}.transport`,
          game.game.key,
          { requireReads: false, requireNoFaults: false },
        );
      }
      const failureRenderer = object(game.renderer, `${location}.renderer`);
      for (const name of [
        "resetBeforeGame",
        "diagnosticsResetBeforeGame",
        "relaysSettledBeforeSnapshot",
      ]) {
        if (typeof failureRenderer[name] !== "boolean") {
          fail(`${location}.renderer.${name}`, "expected a boolean");
        }
      }
      nonNegativeInteger(failureRenderer.calls, `${location}.renderer.calls`);
      nonNegativeInteger(failureRenderer.failures, `${location}.renderer.failures`);
      exact(
        game.isolationCompromised,
        !failureRenderer.relaysSettledBeforeSnapshot,
        `${location}.isolationCompromised`,
      );
      if (failureRenderer.before !== null) {
        verifyCounterTree(
          failureRenderer.before,
          `${location}.renderer.before`,
          { requireZero: failureRenderer.diagnosticsResetBeforeGame },
        );
      }
      if (failureRenderer.after !== null) {
        verifyCounterTree(failureRenderer.after, `${location}.renderer.after`);
      }
      const failureFaults = object(game.faults, `${location}.faults`);
      for (const name of [
        "rustStops",
        "hostCallCaps",
        "coldInstallCaps",
        "workerTimeouts",
        "zeroProgressCaps",
        "invalidRangeRequests",
        "preconditionFailures",
        "rendererFailures",
      ]) {
        nonNegativeInteger(failureFaults[name], `${location}.faults.${name}`);
      }
      const boundary = boundaryEvidence.boundary;
      exact(failureFaults.rustStops, boundary === "rust-stop" ? 1 : 0, `${location}.faults.rustStops`);
      exact(
        failureFaults.hostCallCaps,
        boundary === "host-call-cap" ? 1 : 0,
        `${location}.faults.hostCallCaps`,
      );
      exact(
        failureFaults.coldInstallCaps,
        boundary === "cold-install-cap" ? 1 : 0,
        `${location}.faults.coldInstallCaps`,
      );
      exact(
        failureFaults.workerTimeouts,
        new Set(["worker-request-timeout", "window-timeout"]).has(boundary) ? 1 : 0,
        `${location}.faults.workerTimeouts`,
      );
      exact(
        failureFaults.zeroProgressCaps,
        boundary === "zero-progress-slice-cap" ? 1 : 0,
        `${location}.faults.zeroProgressCaps`,
      );
      exact(
        failureFaults.rendererFailures,
        failureRenderer.failures,
        `${location}.faults.rendererFailures`,
      );
      if (!failureTransport.snapshotUnavailable) {
        exact(
          failureFaults.invalidRangeRequests,
          failureTransport.after.invalidRangeRequests
            - failureTransport.before.invalidRangeRequests,
          `${location}.faults.invalidRangeRequests`,
        );
        exact(
          failureFaults.preconditionFailures,
          failureTransport.after.preconditionFailures
            - failureTransport.before.preconditionFailures,
          `${location}.faults.preconditionFailures`,
        );
      }
      exact(game.inputSamples, 0, `${location}.inputSamples`);
    }
  });
  if (new Set(keys).size !== keys.length) fail("$.games", "duplicate game key");
  const compromisedIndex = games.findIndex(game => game.isolationCompromised === true);
  if (compromisedIndex !== -1 && compromisedIndex !== games.length - 1) {
    fail("$.games", "no title may run after renderer isolation is compromised");
  }
  const firstFailedIndex = games.findIndex(game => game.status === "failed");
  if (!policy.continueOnFailure
      && firstFailedIndex !== -1
      && firstFailedIndex !== games.length - 1) {
    fail("$.games", "continueOnFailure=false requires the first failure to be terminal");
  }
  const expectedAttemptedKeys = selectedGameKeys.slice(0, games.length);
  if (JSON.stringify(keys) !== JSON.stringify(expectedAttemptedKeys)) {
    fail("$.games", "game keys must be the exact ordered prefix of corpus.selectedGameKeys");
  }
  if (report.status === "complete" && games.length !== selectedGameKeys.length) {
    fail("$.games", "complete evidence must equal corpus.selectedGameKeys");
  }
  exact(summary.attemptedGames, games.length, "$.summary.attemptedGames");
  exact(summary.completeGames, complete.length, "$.summary.completeGames");
  exact(summary.failedGames, failed.length, "$.summary.failedGames");
  exact(summary.requestedGames, selectedGameKeys.length, "$.summary.requestedGames");
  if (report.status === "complete" && failed.length !== 0) {
    fail("$.status", "complete report contains a failed game");
  }
  if (report.status === "partial" && (complete.length === 0 || failed.length === 0)) {
    fail("$.status", "partial report must contain both complete and failed games");
  }
  if (report.status === "failed" && (complete.length !== 0 || failed.length === 0)) {
    fail("$.status", "failed report must contain at least one failure and no completed game");
  }
  const rendererDiagnostics = verifyCounterTree(
    report.rendererDiagnostics,
    "$.rendererDiagnostics",
  );
  if (games.length !== 0 && games.at(-1).renderer.after !== null) {
    exactJson(
      rendererDiagnostics,
      games.at(-1).renderer.after,
      "$.rendererDiagnostics",
    );
  }
  return report;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const knownFlags = new Set(["--require-complete", "--require-all", "--lock"]);
  for (const argument of arguments_) {
    if (argument.startsWith("--") && !knownFlags.has(argument)) {
      throw new Error(`unknown option ${argument}`);
    }
  }
  for (const flag of knownFlags) {
    if (arguments_.filter(argument => argument === flag).length > 1) {
      throw new Error(`duplicate option ${flag}`);
    }
  }
  const requireComplete = arguments_.includes("--require-complete");
  const requireAll = arguments_.includes("--require-all");
  const lockOptionIndex = arguments_.indexOf("--lock");
  let lockPath = null;
  if (lockOptionIndex !== -1) {
    const value = arguments_[lockOptionIndex + 1];
    if (!value || value.startsWith("--")) throw new Error("--lock requires a path");
    lockPath = path.resolve(value);
  }
  if ((requireComplete || requireAll) && lockPath === null) {
    throw new Error("--lock is required for complete or all-corpus validation");
  }
  const positional = arguments_.filter((argument, index) => (
    !argument.startsWith("--") && index !== lockOptionIndex + 1
  ));
  const pathArgument = positional[0];
  if (!pathArgument) {
    throw new Error(
      "usage: resident_machine_corpus_report.mjs "
      + "[--require-complete] [--require-all] [--lock lock.json] <report.json>",
    );
  }
  if (positional.length !== 1) throw new Error("expected exactly one report path");
  const trustedLock = (requireComplete || requireAll)
    ? JSON.parse(await readFile(lockPath, "utf8"))
    : null;
  const report = validateResidentCorpusEvidence(
    JSON.parse(await readFile(path.resolve(pathArgument), "utf8")),
    { requireComplete, requireAll, trustedLock },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: report.schema,
    status: report.status,
    artifacts: report.artifacts.artifacts,
    summary: report.summary,
    games: report.games.map(game => ({
      key: game.game.key,
      status: game.status,
      bootReads: game.boot?.reads ?? null,
      measuredInstructions: game.measurement?.executedInstructions ?? null,
      measuredCycles: game.measurement?.executedCycles ?? null,
      error: game.error ?? null,
    })),
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
