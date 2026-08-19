#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateRelease } from "../web/release.mjs";
import {
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
} from "./resident_machine_fidelity_checkpoints.mjs";

export {
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
};

export const FIDELITY_EVIDENCE_LOCK_SCHEMA =
  "lazuli-resident-renderer-fidelity-evidence-lock-v2";
export const PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA =
  "lazuli-resident-renderer-fidelity-evidence-lock-v3";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPECTED_CORPUS_SHA256 =
  "43597e441ab8c38adb18beed8ac34895a8496cac8ac2112ef4cb27c7504f4fc6";
const EXPECTED_GAME = Object.freeze({
  key: "warioware-usa",
  priority: 1,
  bytes: 889_225_792,
  sha256: "b8c33924afed0fec165afc3fe0d6e8dddfcdef53842fcae180560b3b904b4a81",
});
const ARTIFACT_NAMES = Object.freeze([
  "browser_machine.wasm",
  "resident_dispatcher.wasm",
  "core_run_coordinator.wasm",
  "browser_renderer.js",
  "browser_renderer_bg.wasm",
]);
const SOURCE_PATHS = Object.freeze([
  "web/resident-machine.mjs",
  "web/resident-machine-worker.mjs",
  "tools/resident_machine_first_frame.html",
  "tools/resident_machine_first_frame.mjs",
  "tools/resident_machine_evidence_v1.mjs",
  "tools/resident_machine_first_frame_report.mjs",
  "tools/resident_machine_fidelity_checkpoints.mjs",
  "tools/resident_machine_fidelity_checkpoint_worker.mjs",
  "tools/resident_machine_fidelity_checkpoint_report.mjs",
  "tools/resident_machine_fidelity_lock.mjs",
  "tools/resident_machine_fidelity_combined_report.mjs",
  "tools/resident_machine_fidelity_server.py",
  "tools/resident_machine_fidelity_watchdog.py",
  "tools/resident_machine_corpus_server.py",
  "crates/lazuli-abi/src/lib.rs",
]);
export const PRODUCTION_SOURCE_PATHS = Object.freeze([
  ...SOURCE_PATHS.filter(source =>
    source !== "web/resident-machine.mjs"
    && source !== "web/resident-machine-worker.mjs"
  ),
  "tools/resident_machine_game_fidelity_v1.mjs",
  "tools/resident_machine_production_fidelity_capture.mjs",
  "tools/resident_machine_production_fidelity_local.mjs",
  "tools/resident_machine_production_fidelity_bundle.mjs",
  "tools/resident_machine_production_fidelity_gate.mjs",
  "tools/resident_machine_corpus_report.mjs",
  "tools/resident_machine_corpus.html",
  "tools/resident_machine_corpus.mjs",
  "web/release.mjs",
  "tools/browser_boot_headless_cdp.mjs",
  "tools/browser_game_compatibility_corpus.mjs",
  "tools/browser_boot_devtools_socket.mjs",
  "tools/browser_boot_disc_identity.mjs",
]);
export const PRODUCTION_FIDELITY_EXECUTION_ROLES = Object.freeze([
  "core",
  "dispatcher",
  "coordinator",
  "adapter",
  "worker",
  "frontend",
  "rendererJavascript",
  "rendererWasm",
]);
const ARTIFACT_ARGUMENTS = Object.freeze({
  "browser_machine.wasm": "core",
  "resident_dispatcher.wasm": "dispatcher",
  "core_run_coordinator.wasm": "coordinator",
  "browser_renderer.js": "renderer-js",
  "browser_renderer_bg.wasm": "renderer-wasm",
});
const PRODUCTION_EXECUTION_ARGUMENTS = Object.freeze({
  core: "core",
  dispatcher: "dispatcher",
  coordinator: "coordinator",
  adapter: "adapter",
  worker: "worker",
  frontend: "frontend",
  rendererJavascript: "renderer-js",
  rendererWasm: "renderer-wasm",
});
const PRODUCTION_RENDERER_WASM_IMPORTS = 329;
const DEFAULT_PRODUCTION_REPOSITORY = fileURLToPath(new URL("../", import.meta.url));

function fail(location, message) {
  throw new Error(`invalid resident fidelity evidence lock at ${location}: ${message}`);
}

function object(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(location, "expected an object");
  }
  return value;
}

function exactKeys(value, keys, location) {
  object(value, location);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(location, `expected exact keys ${expected.join(", ")}`);
  }
}

function exactOrderedKeys(value, keys, location) {
  object(value, location);
  const actual = Object.keys(value);
  if (JSON.stringify(actual) !== JSON.stringify(keys)) {
    fail(location, `expected exact ordered keys ${keys.join(", ")}`);
  }
}

function exact(value, expected, location) {
  if (value !== expected) fail(location, `expected ${JSON.stringify(expected)}`);
}

function positiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(location, "expected a positive integer");
  return value;
}

function sha256(value, location) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(location, "expected a lowercase SHA-256 digest");
  }
  return value;
}

function exactCanonical(value, expected, location) {
  if (canonicalFidelityLockJson(value) !== canonicalFidelityLockJson(expected)) {
    fail(location, "did not match the expected production authority");
  }
}

function validateFileRecord(value, location) {
  exactKeys(value, ["bytes", "sha256"], location);
  positiveInteger(value.bytes, `${location}.bytes`);
  sha256(value.sha256, `${location}.sha256`);
  return value;
}

export function validateProductionSourceAuthorityRecords(value, expected) {
  exactOrderedKeys(value, PRODUCTION_SOURCE_PATHS, "$.sources");
  exactOrderedKeys(expected, PRODUCTION_SOURCE_PATHS, "$.expectedAuthority.sources");
  for (const source of PRODUCTION_SOURCE_PATHS) {
    validateFileRecord(value[source], `$.sources.${source}`);
    validateFileRecord(expected[source], `$.expectedAuthority.sources.${source}`);
    exactCanonical(value[source], expected[source], `$.sources.${source}`);
  }
  return value;
}

function validateAssetDescriptor(value, location) {
  exactKeys(value, ["url", "bytes", "sha256"], location);
  if (typeof value.url !== "string" || !value.url.startsWith("/") || value.url.startsWith("//")) {
    fail(`${location}.url`, "expected a same-origin absolute path");
  }
  positiveInteger(value.bytes, `${location}.bytes`);
  sha256(value.sha256, `${location}.sha256`);
  return value;
}

export function canonicalFidelityLockJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFidelityLockJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalFidelityLockJson(value[key])}`
  ).join(",")}}`;
}

export function productionFidelityCapturePolicy(gameKey) {
  if (typeof gameKey !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameKey)) {
    throw new Error("production fidelity capture policy requires a lowercase kebab-case game key");
  }
  return {
    mode: "continuous-single-worker-machine-v1",
    pageQuery: {
      allowedKeys: ["capture", "game"],
      requiredValues: { capture: "fidelity", game: gameKey },
      duplicateValuesAllowed: false,
      unknownKeysAllowed: false,
    },
    oneWorkerInitialization: true,
    workerGeneratedMachineSessionId: true,
    captureMachineInitializedBeforeProgress: true,
    cumulativeRunCapsAfterAuthenticatedReady: true,
    cumulativeRunLedger: {
      schema: "lazuli-resident-cumulative-run-summary-v1",
      policySource: "locked-runPolicy",
      startsAt: "resident-ready",
      endsAt: "fidelity-accepted-owned",
      terminalSummaryRequired: true,
      operatorPublicationsBound: true,
      witnessPublicationsRequired: 1,
    },
    minimumViFieldDeltaFromFirstFrame: 120,
    minimumPresentationDeltaFromFirstFrame: 64,
    fidelityStatePollAfterEveryRun: true,
    observationAckAfterDurableOwnership: true,
    witnessCheckpointAckBeforeProgress: true,
    acceptedIsHardMachineProgressBoundary: true,
    terminalStateQueryOnlyAfterAccepted: true,
    terminalOpaqueArtifactsEqualAccepted: true,
    firstFrameReportUsesPreBindingJournalPrefix: true,
    sameReceiptBaselineReusesFirstFrameReadback: true,
    genericOperatorInputBeforeBaseline: true,
    genericOperatorPolicy: {
      algorithm: "alternating-neutral-a-v1",
      runBoundaryOrigin: "post-first-frame-report-local-zero",
      runBoundaryInterval: 8,
      maximumPublications: PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
      startsWith: "neutral",
      neutral: { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 },
      a: { buttons: 0x0100, stickXyCxy: 0x8080_8080, triggerLrab: 0x00ff_0000 },
    },
    rustRequestedWitnessOnly: true,
    artifactDigestPolicy: {
      json: "recursive-key-canonical-utf8",
      opaqueRecords: "decoded-canonical-padded-base64",
      binary: "raw-owned-bytes",
    },
    retainedLeafSchema: {
      controllerSource: "tools/resident_machine_production_fidelity_capture.mjs",
      report: "recursive-key-canonical-utf8",
      envelopes: "recursive-key-canonical-utf8",
      opaqueRecords: "decoded-canonical-padded-base64",
      metadata: "recursive-key-canonical-utf8",
      rgba: "raw-owned-bytes",
    },
    requiredCheckpointCardinality: {
      "capture-machine-initialized": 1,
      "first-frame-renderer-owned": 1,
      "first-frame-report-bound": 1,
      "fidelity-baseline-owned": 1,
      "controller-witness-published": 1,
      "fidelity-accepted-owned": 1,
      "fidelity-terminal": 1,
    },
    requiredCheckpointOrder: [
      ["capture-machine-initialized", "first-frame-renderer-owned"],
      ["capture-machine-initialized", "fidelity-baseline-owned"],
      ["capture-machine-initialized", "first-frame-report-bound"],
      ["first-frame-renderer-owned", "first-frame-report-bound"],
      ["first-frame-renderer-owned", "fidelity-baseline-owned"],
      ["first-frame-report-bound", "controller-witness-published"],
      ["fidelity-baseline-owned", "controller-witness-published"],
      ["controller-witness-published", "fidelity-accepted-owned"],
      ["fidelity-accepted-owned", "fidelity-terminal"],
    ],
  };
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashCanonical(value) {
  return hashBytes(canonicalFidelityLockJson(value));
}

export function validateResidentFidelityEvidenceLock(value) {
  const lock = object(value, "$");
  exactKeys(lock, [
    "schema",
    "evidenceMode",
    "corpus",
    "selectedGame",
    "artifacts",
    "sources",
    "hostPolicy",
    "runPolicy",
    "checkpointPolicy",
    "rendererProbe",
    "machineEvidence",
  ], "$");
  exact(lock.schema, FIDELITY_EVIDENCE_LOCK_SCHEMA, "$.schema");
  exact(
    lock.evidenceMode,
    "first-renderer-owned-presented-xfb-with-durable-probe-checkpoints-and-machine-evidence-v1",
    "$.evidenceMode",
  );

  exactKeys(lock.corpus, ["workspacePath", "bytes", "sha256"], "$.corpus");
  exact(lock.corpus.workspacePath, "tools/compatibility/games/corpus.json", "$.corpus.workspacePath");
  positiveInteger(lock.corpus.bytes, "$.corpus.bytes");
  exact(lock.corpus.sha256, EXPECTED_CORPUS_SHA256, "$.corpus.sha256");

  exactKeys(lock.selectedGame, Object.keys(EXPECTED_GAME), "$.selectedGame");
  for (const [field, expected] of Object.entries(EXPECTED_GAME)) {
    exact(lock.selectedGame[field], expected, `$.selectedGame.${field}`);
  }

  exactKeys(lock.artifacts, ARTIFACT_NAMES, "$.artifacts");
  for (const name of ARTIFACT_NAMES) validateFileRecord(lock.artifacts[name], `$.artifacts.${name}`);
  exactKeys(lock.sources, SOURCE_PATHS, "$.sources");
  for (const source of SOURCE_PATHS) validateFileRecord(lock.sources[source], `$.sources.${source}`);

  exactKeys(lock.hostPolicy, [
    "transport",
    "maxRangeBytes",
    "semanticArguments",
    "checkpointBodyCap",
  ], "$.hostPolicy");
  exact(lock.hostPolicy.transport, "immutable-http-range", "$.hostPolicy.transport");
  exact(lock.hostPolicy.maxRangeBytes, 64 * 1024 * 1024, "$.hostPolicy.maxRangeBytes");
  exact(lock.hostPolicy.semanticArguments, 0, "$.hostPolicy.semanticArguments");
  exact(lock.hostPolicy.checkpointBodyCap, 4_096, "$.hostPolicy.checkpointBodyCap");

  const exactRunPolicy = {
    instructionUpperCap: "100000000",
    executedCycleUpperCap: "250000000",
    sliceCycleUpperCap: "1000000",
    blockUpperCap: 16_384,
    totalHostCallCap: 65_535,
    totalColdInstallCap: 65_535,
    maxBootReads: 8_192,
    bootTimeoutMs: 180_000,
    sliceTimeoutMs: 180_000,
    runTimeoutMs: 600_000,
    externalWallTimeoutMs: 600_000,
    zeroProgressSliceCap: 4_096,
  };
  exactKeys(lock.runPolicy, Object.keys(exactRunPolicy), "$.runPolicy");
  for (const [field, expected] of Object.entries(exactRunPolicy)) {
    exact(lock.runPolicy[field], expected, `$.runPolicy.${field}`);
  }

  const exactCheckpointPolicy = {
    checkpointTimeoutMs: 10_000,
    checkpointRecordCap: 65_535,
    probeEventRunCap: 32_768,
    probeEventPerSubmissionCap: 402,
    opaqueProbeWords: 6,
    fsyncEveryRecord: true,
  };
  exactKeys(lock.checkpointPolicy, Object.keys(exactCheckpointPolicy), "$.checkpointPolicy");
  for (const [field, expected] of Object.entries(exactCheckpointPolicy)) {
    exact(lock.checkpointPolicy[field], expected, `$.checkpointPolicy.${field}`);
  }

  const exactProbe = {
    feature: "resident-render-probe",
    featureDefaultOff: true,
    hook: "globalThis.__lazuliResidentRenderProbe",
    rawFeatureWasmImports: 329,
    servedFeatureWasmImports: 330,
    featureHookImports: 1,
    rawDefaultWasmImports: 328,
    servedDefaultWasmImports: 329,
    defaultHookImports: 0,
    servedHookImportModule: "./browser_renderer_bg.js",
    servedHookImportField: "__wbg___lazuliResidentRenderProbe_718a3217ded92d15",
    servedHookImportKind: "function",
    progressSamplesPerStreamCap: 65,
    terminalQueueSubmitsPerRequestCap: 1,
    wideCountEncoding: "saturating-u32",
    javascriptWordInterpretations: 0,
  };
  exactKeys(lock.rendererProbe, Object.keys(exactProbe), "$.rendererProbe");
  for (const [field, expected] of Object.entries(exactProbe)) {
    exact(lock.rendererProbe[field], expected, `$.rendererProbe.${field}`);
  }

  const exactMachineEvidence = {
    abiVersion: 1,
    byteLength: 816,
    wordLength: 204,
    tag: "LZME",
    encoding: "base64",
    browserWordInterpretations: 0,
  };
  exactKeys(lock.machineEvidence, Object.keys(exactMachineEvidence), "$.machineEvidence");
  for (const [field, expected] of Object.entries(exactMachineEvidence)) {
    exact(lock.machineEvidence[field], expected, `$.machineEvidence.${field}`);
  }
  return lock;
}

export function validateResidentProductionFidelityEvidenceLock(value, expectedAuthority) {
  const lock = object(value, "$" );
  exactKeys(lock, [
    "schema",
    "evidenceMode",
    "release",
    "run",
    "corpus",
    "selectedGame",
    "artifacts",
    "sources",
    "hostPolicy",
    "runPolicy",
    "checkpointPolicy",
    "capturePolicy",
    "rendererProbe",
    "machineEvidence",
  ], "$" );
  exact(lock.schema, PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA, "$.schema");
  exact(
    lock.evidenceMode,
    "continuous-resident-game-fidelity-v1-with-durable-renderer-and-rust-ownership",
    "$.evidenceMode",
  );

  exactKeys(lock.release, [
    "schema",
    "releaseId",
    "manifestBytes",
    "manifestSha256",
    "sourceCommit",
    "executionAssetsSha256",
    "executionAssets",
  ], "$.release");
  exact(lock.release.schema, 4, "$.release.schema");
  sha256(lock.release.releaseId, "$.release.releaseId");
  positiveInteger(lock.release.manifestBytes, "$.release.manifestBytes");
  sha256(lock.release.manifestSha256, "$.release.manifestSha256");
  if (typeof lock.release.sourceCommit !== "string"
      || !COMMIT_PATTERN.test(lock.release.sourceCommit)) {
    fail("$.release.sourceCommit", "expected a lowercase 40-hex commit");
  }
  sha256(lock.release.executionAssetsSha256, "$.release.executionAssetsSha256");
  exactKeys(
    lock.release.executionAssets,
    PRODUCTION_FIDELITY_EXECUTION_ROLES,
    "$.release.executionAssets",
  );
  for (const role of PRODUCTION_FIDELITY_EXECUTION_ROLES) {
    validateAssetDescriptor(
      lock.release.executionAssets[role],
      `$.release.executionAssets.${role}`,
    );
  }

  exactKeys(lock.run, ["runId", "gameKey"], "$.run");
  if (typeof lock.run.runId !== "string" || !UUID_PATTERN.test(lock.run.runId)) {
    fail("$.run.runId", "expected a UUID");
  }
  if (typeof lock.run.gameKey !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lock.run.gameKey)) {
    fail("$.run.gameKey", "expected lowercase kebab-case");
  }

  exactKeys(lock.corpus, ["workspacePath", "bytes", "sha256"], "$.corpus");
  exact(lock.corpus.workspacePath, "tools/compatibility/games/corpus.json", "$.corpus.workspacePath");
  positiveInteger(lock.corpus.bytes, "$.corpus.bytes");
  sha256(lock.corpus.sha256, "$.corpus.sha256");

  exactKeys(lock.selectedGame, ["key", "priority", "bytes", "image", "disc"], "$.selectedGame");
  exact(lock.selectedGame.key, lock.run.gameKey, "$.selectedGame.key");
  positiveInteger(lock.selectedGame.priority, "$.selectedGame.priority");
  positiveInteger(lock.selectedGame.bytes, "$.selectedGame.bytes");
  exactKeys(lock.selectedGame.image, ["format", "sha256"], "$.selectedGame.image");
  exact(lock.selectedGame.image.format, "ciso", "$.selectedGame.image.format");
  sha256(lock.selectedGame.image.sha256, "$.selectedGame.image.sha256");
  exactKeys(lock.selectedGame.disc, ["identifier", "revision"], "$.selectedGame.disc");
  if (typeof lock.selectedGame.disc.identifier !== "string"
      || !/^[A-Z0-9]{6}$/.test(lock.selectedGame.disc.identifier)) {
    fail("$.selectedGame.disc.identifier", "expected an exact six-byte disc identifier");
  }
  if (!Number.isSafeInteger(lock.selectedGame.disc.revision)
      || lock.selectedGame.disc.revision < 0
      || lock.selectedGame.disc.revision > 0xff) {
    fail("$.selectedGame.disc.revision", "expected an unsigned byte");
  }

  exactKeys(lock.artifacts, ARTIFACT_NAMES, "$.artifacts");
  for (const name of ARTIFACT_NAMES) {
    validateFileRecord(lock.artifacts[name], `$.artifacts.${name}`);
  }
  const artifactRoles = {
    "browser_machine.wasm": "core",
    "resident_dispatcher.wasm": "dispatcher",
    "core_run_coordinator.wasm": "coordinator",
    "browser_renderer.js": "rendererJavascript",
    "browser_renderer_bg.wasm": "rendererWasm",
  };
  for (const [name, role] of Object.entries(artifactRoles)) {
    const descriptor = lock.release.executionAssets[role];
    exactCanonical(
      lock.artifacts[name],
      { bytes: descriptor.bytes, sha256: descriptor.sha256 },
      `$.artifacts.${name}`,
    );
  }

  exactOrderedKeys(lock.sources, PRODUCTION_SOURCE_PATHS, "$.sources");
  for (const source of PRODUCTION_SOURCE_PATHS) {
    validateFileRecord(lock.sources[source], `$.sources.${source}`);
  }

  exactKeys(lock.hostPolicy, [
    "transport",
    "maxRangeBytes",
    "semanticArguments",
    "checkpointBodyCap",
  ], "$.hostPolicy");
  exact(lock.hostPolicy.transport, "immutable-http-range", "$.hostPolicy.transport");
  exact(lock.hostPolicy.maxRangeBytes, 64 * 1024 * 1024, "$.hostPolicy.maxRangeBytes");
  exact(lock.hostPolicy.semanticArguments, 0, "$.hostPolicy.semanticArguments");
  exact(lock.hostPolicy.checkpointBodyCap, 4_096, "$.hostPolicy.checkpointBodyCap");

  const exactRunPolicy = {
    instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
    executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
    sliceCycleUpperCap: "1000000",
    blockUpperCap: 16_384,
    totalHostCallCap: 65_535,
    totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
    maxBootReads: 8_192,
    bootTimeoutMs: 180_000,
    sliceTimeoutMs: 180_000,
    runTimeoutMs: 600_000,
    externalWallTimeoutMs: 600_000,
    zeroProgressSliceCap: 4_096,
    workerUrl: lock.release.executionAssets.worker.url,
  };
  exactKeys(lock.runPolicy, Object.keys(exactRunPolicy), "$.runPolicy");
  for (const [field, expected] of Object.entries(exactRunPolicy)) {
    exact(lock.runPolicy[field], expected, `$.runPolicy.${field}`);
  }

  const exactCheckpointPolicy = {
    checkpointTimeoutMs: 10_000,
    checkpointRecordCap: 65_535,
    probeEventRunCap: 32_768,
    probeEventPerSubmissionCap: 402,
    opaqueProbeWords: 6,
    fsyncEveryRecord: true,
  };
  exactKeys(lock.checkpointPolicy, Object.keys(exactCheckpointPolicy), "$.checkpointPolicy");
  for (const [field, expected] of Object.entries(exactCheckpointPolicy)) {
    exact(lock.checkpointPolicy[field], expected, `$.checkpointPolicy.${field}`);
  }

  const exactCapturePolicy = productionFidelityCapturePolicy(lock.run.gameKey);
  exactKeys(lock.capturePolicy, Object.keys(exactCapturePolicy), "$.capturePolicy");
  for (const [field, expected] of Object.entries(exactCapturePolicy)) {
    exactCanonical(lock.capturePolicy[field], expected, `$.capturePolicy.${field}`);
  }

  const exactProbe = {
    feature: "resident-render-probe",
    featureDefaultOff: true,
    hook: "globalThis.__lazuliResidentRenderProbe",
    defaultHookImports: 0,
    checkpointProbeEvents: 0,
    javascriptWordInterpretations: 0,
  };
  exactKeys(lock.rendererProbe, Object.keys(exactProbe), "$.rendererProbe");
  for (const [field, expected] of Object.entries(exactProbe)) {
    exact(lock.rendererProbe[field], expected, `$.rendererProbe.${field}`);
  }

  const exactMachineEvidence = {
    abiVersion: 1,
    byteLength: 816,
    wordLength: 204,
    tag: "LZME",
    encoding: "base64",
    browserWordInterpretations: 0,
  };
  exactKeys(lock.machineEvidence, Object.keys(exactMachineEvidence), "$.machineEvidence");
  for (const [field, expected] of Object.entries(exactMachineEvidence)) {
    exact(lock.machineEvidence[field], expected, `$.machineEvidence.${field}`);
  }

  const authority = object(expectedAuthority, "$.expectedAuthority");
  exactKeys(
    authority,
    ["release", "run", "corpus", "selectedGame", "artifacts", "sources"],
    "$.expectedAuthority",
  );
  exactOrderedKeys(authority.sources, PRODUCTION_SOURCE_PATHS, "$.expectedAuthority.sources");
  for (const source of PRODUCTION_SOURCE_PATHS) {
    validateFileRecord(authority.sources[source], `$.expectedAuthority.sources.${source}`);
  }
  validateProductionSourceAuthorityRecords(lock.sources, authority.sources);
  for (const field of ["release", "run", "corpus", "selectedGame", "artifacts"]) {
    exactCanonical(lock[field], authority[field], `$.${field}`);
  }
  return lock;
}

export function expectedFidelityHostIdentitySha256(
  lockValue,
  evidenceLockSha256,
  expectedAuthority = null,
) {
  const lock = lockValue?.schema === PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA
    ? validateResidentProductionFidelityEvidenceLock(lockValue, expectedAuthority)
    : validateResidentFidelityEvidenceLock(lockValue);
  sha256(evidenceLockSha256, "$.evidenceLockSha256");
  const artifactManifest = `${canonicalFidelityLockJson({
    schema: "lazuli-resident-corpus-artifacts-v1",
    artifacts: lock.artifacts,
  })}\n`;
  const corpusManifest = `${canonicalFidelityLockJson({
    schema: "lazuli-resident-corpus-host-v1",
    sourceCorpusSha256: lock.corpus.sha256,
    games: [{
      key: lock.selectedGame.key,
      priority: lock.selectedGame.priority,
      bytes: lock.selectedGame.bytes,
      sha256: lock.selectedGame.image?.sha256 ?? lock.selectedGame.sha256,
      rangeUrl: `/resident-corpus/games/${lock.selectedGame.key}/disc`,
    }],
    transport: {
      kind: lock.hostPolicy.transport,
      maxRangeBytes: lock.hostPolicy.maxRangeBytes,
      semanticArguments: lock.hostPolicy.semanticArguments,
    },
  })}\n`;
  return hashCanonical({
    artifactManifestSha256: hashBytes(artifactManifest),
    corpusManifestSha256: hashBytes(corpusManifest),
    evidenceLockSha256,
  });
}

async function actualFileRecord(file) {
  const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
  if (!metadata.isFile()) throw new Error(`not a regular file: ${file}`);
  return { bytes: bytes.byteLength, sha256: hashBytes(bytes) };
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("lock verifier arguments must be unique --name value pairs");
    }
    const key = name.slice(2);
    if (parsed.has(key)) throw new Error(`duplicate --${key}`);
    parsed.set(key, value);
  }
  return parsed;
}

export async function verifyResidentFidelityEvidenceLockFiles(
  lockValue,
  { workspace, artifactPaths },
) {
  const lock = validateResidentFidelityEvidenceLock(lockValue);
  const root = path.resolve(workspace);
  const checks = [];
  checks.push([lock.corpus.workspacePath, lock.corpus, path.join(root, lock.corpus.workspacePath)]);
  for (const source of SOURCE_PATHS) checks.push([source, lock.sources[source], path.join(root, source)]);
  for (const name of ARTIFACT_NAMES) checks.push([name, lock.artifacts[name], artifactPaths[name]]);
  for (const [label, expected, file] of checks) {
    if (!file) throw new Error(`missing local path for ${label}`);
    const actual = await actualFileRecord(file);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`${label} does not match the immutable evidence lock`);
    }
  }
  const rendererWasm = await readFile(artifactPaths["browser_renderer_bg.wasm"]);
  const wasmModule = await WebAssembly.compile(rendererWasm);
  const imports = WebAssembly.Module.imports(wasmModule);
  if (imports.length !== lock.rendererProbe.servedFeatureWasmImports) {
    throw new Error("probe renderer Wasm import count does not match the immutable evidence lock");
  }
  const hookImports = imports.filter(entry =>
    entry.module === lock.rendererProbe.servedHookImportModule
    && entry.name === lock.rendererProbe.servedHookImportField
    && entry.kind === lock.rendererProbe.servedHookImportKind
  );
  if (hookImports.length !== lock.rendererProbe.featureHookImports) {
    throw new Error("probe renderer Wasm lacks the exact locked module/field/kind hook import");
  }
  const rendererJs = await readFile(artifactPaths["browser_renderer.js"], "utf8");
  const importField = `${lock.rendererProbe.servedHookImportField}: function(`;
  const globalCall = `${lock.rendererProbe.hook}(`;
  if (rendererJs.split(importField).length !== 2 || rendererJs.split(globalCall).length !== 2) {
    throw new Error("probe renderer glue does not bind the exact locked import to the global hook");
  }
  return checks.length;
}

function productionReleaseExecutionAssets(release) {
  return {
    core: release.runtime.core,
    dispatcher: release.runtime.dispatcher,
    coordinator: release.runtime.coordinator,
    adapter: release.runtime.adapter,
    worker: release.runtime.worker,
    frontend: release.frontend,
    rendererJavascript: release.renderer.javascript,
    rendererWasm: release.renderer.wasm,
  };
}

function gitOutput(repository, arguments_, purpose) {
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    environment.GIT_NO_REPLACE_OBJECTS = "1";
    execFile(
      "git",
      ["--no-replace-objects", "-C", repository, ...arguments_],
      { encoding: null, env: environment, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.from(stderr ?? []).toString("utf8").trim();
          reject(new Error(
            `production source authority could not ${purpose}${detail ? `: ${detail}` : ""}`,
            { cause: error },
          ));
          return;
        }
        resolve(Buffer.from(stdout));
      },
    );
  });
}

function validateProductionSourceTreeEntry(bytes, source) {
  const terminator = bytes.indexOf(0);
  if (terminator !== bytes.byteLength - 1 || bytes.indexOf(0, terminator + 1) !== -1) {
    throw new Error(`production source authority found ambiguous tree entries for ${source}`);
  }
  const separator = bytes.indexOf(0x09);
  if (separator <= 0 || separator >= terminator) {
    throw new Error(`production source authority found a malformed tree entry for ${source}`);
  }
  const header = bytes.subarray(0, separator).toString("ascii");
  if (!/^(?:100644|100755) blob [0-9a-f]{40}$/.test(header)) {
    throw new Error(`production source authority requires a regular blob for ${source}`);
  }
  const sourceBytes = Buffer.from(source, "utf8");
  if (!bytes.subarray(separator + 1, terminator).equals(sourceBytes)) {
    throw new Error(`production source authority tree path is not exact for ${source}`);
  }
}

export async function productionSourceAuthorityFromGit(repository, commit) {
  if (typeof repository !== "string" || repository.length === 0) {
    throw new Error("production source authority requires an exact repository root");
  }
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
    throw new Error("production source authority requires a lowercase 40-hex commit");
  }

  const requestedRoot = await realpath(repository);
  const discoveredRootBytes = await gitOutput(
    requestedRoot,
    ["rev-parse", "--show-toplevel"],
    "resolve the repository root",
  );
  const discoveredRoot = discoveredRootBytes.toString("utf8").trim();
  if (await realpath(discoveredRoot) !== requestedRoot) {
    throw new Error("production source authority requires the exact repository root");
  }
  const shallow = (await gitOutput(
    requestedRoot,
    ["rev-parse", "--is-shallow-repository"],
    "inspect repository history",
  )).toString("utf8").trim();
  if (shallow !== "false") {
    throw new Error("production source authority refuses shallow repository history");
  }
  const resolvedCommit = (await gitOutput(
    requestedRoot,
    ["rev-parse", "--verify", `${commit}^{commit}`],
    "resolve the release commit",
  )).toString("utf8").trim();
  if (resolvedCommit !== commit) {
    throw new Error("production source authority commit did not resolve canonically");
  }
  const commitType = (await gitOutput(
    requestedRoot,
    ["cat-file", "-t", commit],
    "inspect the release commit",
  )).toString("utf8").trim();
  if (commitType !== "commit") {
    throw new Error("production source authority release object is not a commit");
  }

  const entries = [];
  for (const source of PRODUCTION_SOURCE_PATHS) {
    const treeEntry = await gitOutput(
      requestedRoot,
      ["ls-tree", "-z", commit, "--", source],
      `inspect ${source} at the release commit`,
    );
    validateProductionSourceTreeEntry(treeEntry, source);
    const bytes = await gitOutput(
      requestedRoot,
      ["cat-file", "blob", `${commit}:${source}`],
      `read ${source} at the release commit`,
    );
    if (bytes.byteLength === 0) {
      throw new Error(`production source authority found an empty source blob: ${source}`);
    }
    entries.push([source, Object.freeze({
      bytes: bytes.byteLength,
      sha256: hashBytes(bytes),
    })]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export async function productionFidelityLockAuthorityFromFiles({
  releaseManifestPath,
  corpusPath,
  artifactPaths,
  runId,
  gameKey,
  repository = DEFAULT_PRODUCTION_REPOSITORY,
}) {
  if (typeof runId !== "string" || !UUID_PATTERN.test(runId)) {
    throw new Error("production lock authority requires an exact run UUID");
  }
  if (typeof gameKey !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameKey)) {
    throw new Error("production lock authority requires an exact game key");
  }
  const [releaseBytes, corpusBytes] = await Promise.all([
    readFile(releaseManifestPath),
    readFile(corpusPath),
  ]);
  const release = await validateRelease(JSON.parse(releaseBytes));
  const corpus = JSON.parse(corpusBytes);
  if (corpus?.schema !== "lazuli-game-compatibility-corpus-v1"
      || !Array.isArray(corpus.games)) {
    throw new Error("production lock authority has an invalid corpus");
  }
  const matches = corpus.games.filter(game => game?.key === gameKey);
  if (matches.length !== 1) {
    throw new Error("production lock authority game key must occur exactly once in the corpus");
  }
  const game = matches[0];
  const [artifacts, sources] = await Promise.all([
    Object.fromEntries(await Promise.all(ARTIFACT_NAMES.map(async name => [
      name,
      await actualFileRecord(artifactPaths[name]),
    ]))),
    productionSourceAuthorityFromGit(repository, release.source.commit),
  ]);
  const executionAssets = productionReleaseExecutionAssets(release);
  return {
    release: {
      schema: release.schema,
      releaseId: release.releaseId,
      manifestBytes: releaseBytes.byteLength,
      manifestSha256: hashBytes(releaseBytes),
      sourceCommit: release.source.commit,
      executionAssetsSha256: hashCanonical(executionAssets),
      executionAssets,
    },
    run: { runId, gameKey },
    corpus: {
      workspacePath: "tools/compatibility/games/corpus.json",
      bytes: corpusBytes.byteLength,
      sha256: hashBytes(corpusBytes),
    },
    selectedGame: {
      key: game.key,
      priority: game.priority,
      bytes: game.bytes,
      image: game.image,
      disc: game.disc,
    },
    artifacts,
    sources,
  };
}

export async function verifyResidentProductionDefaultOffRenderer(
  rendererWasm,
  rendererJavascript,
  rendererProbe,
  expectedRendererWasmUrl,
) {
  if (rendererProbe?.defaultHookImports !== 0
      || rendererProbe?.checkpointProbeEvents !== 0) {
    throw new Error("production renderer policy is not explicit default-off/zero-probe");
  }
  const wasmModule = await WebAssembly.compile(rendererWasm);
  const imports = WebAssembly.Module.imports(wasmModule);
  if (imports.length !== PRODUCTION_RENDERER_WASM_IMPORTS) {
    throw new Error("default-off production renderer Wasm import count is not exact");
  }
  const probeImports = imports.filter(entry => entry.name.includes("lazuliResidentRenderProbe"));
  if (probeImports.length !== rendererProbe.defaultHookImports) {
    throw new Error("default-off production renderer unexpectedly imports the probe hook");
  }
  if (rendererJavascript.includes("lazuliResidentRenderProbe")
      || rendererJavascript.includes(rendererProbe.hook)) {
    throw new Error("default-off production renderer glue unexpectedly calls the probe hook");
  }
  if (typeof expectedRendererWasmUrl !== "string"
      || !expectedRendererWasmUrl.startsWith("/")
      || !expectedRendererWasmUrl.endsWith(".wasm")) {
    throw new Error("production renderer requires an exact release Wasm dependency URL");
  }
  const wasmTargets = [...rendererJavascript.matchAll(/(["'])([^"']+\.wasm)\1/g)]
    .map(match => match[2]);
  const dependencyTargets = [...rendererJavascript.matchAll(
    /new URL\(\s*(["'])([^"']+\.wasm)\1\s*,\s*import\.meta\.url\s*\)/g,
  )].map(match => match[2]);
  if (wasmTargets.length !== 1
      || wasmTargets[0] !== expectedRendererWasmUrl
      || dependencyTargets.length !== 1
      || dependencyTargets[0] !== expectedRendererWasmUrl) {
    throw new Error("production renderer glue does not name exactly one locked Wasm dependency URL");
  }
  return imports.length;
}

export async function verifyResidentProductionFidelityEvidenceLockFiles(
  lockBytes,
  {
    evidenceLockSha256,
    workspace,
    artifactPaths,
    executionAssetPaths,
    releaseManifestPath,
    expectedAuthority,
  },
) {
  const actualLockSha256 = hashBytes(lockBytes);
  sha256(evidenceLockSha256, "options.evidenceLockSha256");
  if (actualLockSha256 !== evidenceLockSha256) {
    throw new Error("raw production evidence lock SHA-256 does not match the expected digest");
  }
  const lock = validateResidentProductionFidelityEvidenceLock(
    JSON.parse(lockBytes),
    expectedAuthority,
  );
  const root = path.resolve(workspace);
  const checks = [
    [lock.corpus.workspacePath, lock.corpus, path.join(root, lock.corpus.workspacePath)],
  ];
  for (const source of PRODUCTION_SOURCE_PATHS) {
    checks.push([source, lock.sources[source], path.join(root, source)]);
  }
  for (const name of ARTIFACT_NAMES) {
    checks.push([`served artifact ${name}`, lock.artifacts[name], artifactPaths[name]]);
  }
  for (const role of PRODUCTION_FIDELITY_EXECUTION_ROLES) {
    checks.push([
      `packaged execution asset ${role}`,
      lock.release.executionAssets[role],
      executionAssetPaths[role],
    ]);
  }
  for (const [label, expected, file] of checks) {
    if (!file) throw new Error(`missing local path for ${label}`);
    const actual = await actualFileRecord(file);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`${label} does not match the immutable production evidence lock`);
    }
  }

  const releaseBytes = await readFile(releaseManifestPath);
  const release = await validateRelease(JSON.parse(releaseBytes));
  const releaseRecord = { bytes: releaseBytes.byteLength, sha256: hashBytes(releaseBytes) };
  if (releaseRecord.bytes !== lock.release.manifestBytes
      || releaseRecord.sha256 !== lock.release.manifestSha256
      || release.releaseId !== lock.release.releaseId
      || release.source.commit !== lock.release.sourceCommit) {
    throw new Error("raw schema-4 release manifest does not match the production evidence lock");
  }
  const releaseAssets = productionReleaseExecutionAssets(release);
  if (canonicalFidelityLockJson(releaseAssets)
      !== canonicalFidelityLockJson(lock.release.executionAssets)
      || hashCanonical(releaseAssets) !== lock.release.executionAssetsSha256) {
    throw new Error("schema-4 release execution assets do not match the production evidence lock");
  }

  const rendererWasm = await readFile(executionAssetPaths.rendererWasm);
  const rendererJs = await readFile(executionAssetPaths.rendererJavascript, "utf8");
  await verifyResidentProductionDefaultOffRenderer(
    rendererWasm,
    rendererJs,
    lock.rendererProbe,
    lock.release.executionAssets.rendererWasm.url,
  );
  return checks.length + 2;
}

async function cli() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const lockBytes = await readFile(arguments_.get("lock"));
  const parsedLock = JSON.parse(lockBytes);
  const production = parsedLock?.schema === PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA;
  const allowed = new Set([
    "lock",
    "workspace",
    ...Object.values(ARTIFACT_ARGUMENTS),
    ...(production ? ["release", "lock-sha256", "run-id", "game-key", "adapter", "worker", "frontend"] : []),
  ]);
  for (const key of arguments_.keys()) if (!allowed.has(key)) throw new Error(`unknown --${key}`);
  for (const required of allowed) if (!arguments_.has(required)) throw new Error(`missing --${required}`);
  const artifactPaths = Object.fromEntries(ARTIFACT_NAMES.map(name => [
    name,
    arguments_.get(ARTIFACT_ARGUMENTS[name]),
  ]));
  if (production) {
    const workspace = arguments_.get("workspace");
    const executionAssetPaths = Object.fromEntries(
      PRODUCTION_FIDELITY_EXECUTION_ROLES.map(role => [
        role,
        arguments_.get(PRODUCTION_EXECUTION_ARGUMENTS[role]),
      ]),
    );
    const expectedAuthority = await productionFidelityLockAuthorityFromFiles({
      releaseManifestPath: arguments_.get("release"),
      corpusPath: path.join(workspace, "tools/compatibility/games/corpus.json"),
      artifactPaths,
      runId: arguments_.get("run-id"),
      gameKey: arguments_.get("game-key"),
      repository: workspace,
    });
    const verifiedFiles = await verifyResidentProductionFidelityEvidenceLockFiles(lockBytes, {
      evidenceLockSha256: arguments_.get("lock-sha256"),
      workspace,
      artifactPaths,
      executionAssetPaths,
      releaseManifestPath: arguments_.get("release"),
      expectedAuthority,
    });
    const lock = validateResidentProductionFidelityEvidenceLock(parsedLock, expectedAuthority);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA,
      evidenceLockSha256: arguments_.get("lock-sha256"),
      expectedHostIdentitySha256: expectedFidelityHostIdentitySha256(
        lock,
        arguments_.get("lock-sha256"),
        expectedAuthority,
      ),
      verifiedFiles,
      releaseId: lock.release.releaseId,
      runId: lock.run.runId,
      selectedGame: lock.selectedGame.key,
      rendererProbeEventsExpected: 0,
    }, null, 2)}\n`);
    return;
  }
  const lock = validateResidentFidelityEvidenceLock(parsedLock);
  const verifiedFiles = await verifyResidentFidelityEvidenceLockFiles(lock, {
    workspace: arguments_.get("workspace"),
    artifactPaths,
  });
  const evidenceLockSha256 = hashBytes(lockBytes);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: FIDELITY_EVIDENCE_LOCK_SCHEMA,
    evidenceLockSha256,
    expectedHostIdentitySha256: expectedFidelityHostIdentitySha256(lock, evidenceLockSha256),
    verifiedFiles,
    selectedGame: lock.selectedGame.key,
  }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
