// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  PRODUCTION_FIDELITY_CAPTURE_PLAN_SCHEMA,
  assembleProductionFidelityBundle,
  loadProductionFidelityCapturePlan,
  validateProductionFidelityCapturePlan,
  verifyCandidateDistribution,
} from "./resident_machine_production_fidelity_bundle.mjs";
import {
  PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA,
  canonicalCaptureJson,
} from "./resident_machine_production_fidelity_capture.mjs";
import { residentReleaseExecutionAssetsSha256 } from
  "./resident_machine_production_fidelity_gate.mjs";

const CORPUS_PATH = new URL("./compatibility/games/corpus.json", import.meta.url);
const COMMIT = "b".repeat(40);
const RELEASE_ID = "a".repeat(64);
const PERFORMANCE_RUN_ID = "99999999-0000-4000-8000-999999999999";
const temporaryDirectories = [];

after(async () => Promise.all(
  temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true })),
));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryRoot(label) {
  const directory = await mkdtemp(path.join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

function reference(relative, bytes) {
  return Object.freeze({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
}

async function writeContained(root, relative, bytes) {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return reference(relative, bytes);
}

function runtimeRelease(records) {
  return {
    schema: 4,
    releaseId: RELEASE_ID,
    source: { commit: COMMIT },
    runtime: {
      core: records.core,
      dispatcher: records.dispatcher,
      coordinator: records.coordinator,
      adapter: records.adapter,
      worker: records.worker,
    },
    frontend: records.frontend,
    renderer: {
      javascript: records.rendererJavascript,
      wasm: records.rendererWasm,
    },
  };
}

async function writeRuntimeCandidate(root) {
  const roles = {
    core: ["assets/core.wasm", "core"],
    dispatcher: ["assets/dispatcher.wasm", "dispatcher"],
    coordinator: ["assets/coordinator.wasm", "coordinator"],
    adapter: ["assets/adapter.mjs", "adapter"],
    worker: ["assets/worker.mjs", "worker"],
    frontend: ["assets/frontend.html", "frontend"],
    rendererJavascript: ["assets/renderer.js", "renderer js"],
    rendererWasm: ["assets/renderer.wasm", "renderer wasm"],
  };
  const records = {};
  for (const [role, [relative, source]] of Object.entries(roles)) {
    const bytes = Buffer.from(`candidate-${source}`);
    await writeContained(root, relative, bytes);
    records[role] = { url: `/${relative}`, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  const release = runtimeRelease(records);
  const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
  const releasePath = path.join(root, "release.json");
  await writeFile(releasePath, releaseBytes);
  return { release, releaseBytes, releasePath, distRoot: root, records };
}

function expectedGameEntries(corpus) {
  return [...corpus.games]
    .sort((left, right) => left.priority - right.priority)
    .map(game => ({
      key: game.key,
      evidenceLock: `inputs/${game.key}/lock.json`,
      checkpointJournal: `inputs/${game.key}/journal.jsonl`,
      captureUrl: `http://127.0.0.1:${8700 + game.priority}/tools/resident_machine_first_frame.html?capture=fidelity&game=${game.key}`,
    }));
}

function capturePlan(corpus) {
  return {
    schema: PRODUCTION_FIDELITY_CAPTURE_PLAN_SCHEMA,
    cdpEndpoint: "http://127.0.0.1:9229/",
    controlledPerformance: {
      runId: PERFORMANCE_RUN_ID,
      report: "performance/report.json",
      lock: "performance/lock.json",
    },
    games: expectedGameEntries(corpus),
  };
}

const LEAF_BYTES = Object.freeze({
  "evidence-lock.json": Buffer.from("lock"),
  "checkpoint-journal.jsonl": Buffer.from("journal\n"),
  "first-frame-report.json": Buffer.from("{}"),
  "ready-machine-evidence.json": Buffer.from("ready"),
  "baseline-game-fidelity.json": Buffer.from("baseline-fidelity"),
  "baseline-machine-evidence.json": Buffer.from("baseline-machine"),
  "pre-witness-machine-evidence.json": Buffer.from("pre-witness"),
  "terminal-machine-evidence.json": Buffer.from("terminal-machine"),
  "terminal-game-fidelity.json": Buffer.from("terminal-fidelity"),
  "first-visible.rgba": Buffer.from([1, 2, 3, 4]),
  "baseline-readback-metadata.json": Buffer.from("baseline-metadata"),
  "baseline.rgba": Buffer.from([5, 6, 7, 8]),
  "accepted-readback-metadata.json": Buffer.from("accepted-metadata"),
  "accepted.rgba": Buffer.from([9, 10, 11, 12]),
});

async function writeRunFragment(captureRoot, game, index, release) {
  const prefix = `games/${String(index + 1).padStart(2, "0")}-${game.key}`;
  const refs = {};
  for (const [filename, bytes] of Object.entries(LEAF_BYTES)) {
    refs[filename] = await writeContained(captureRoot, `${prefix}/${filename}`, bytes);
  }
  const run = {
    key: game.key,
    runId: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    capturedAt: `2026-08-18T0${index}:00:00.000Z`,
    releaseId: release.releaseId,
    executionAssetsSha256: residentReleaseExecutionAssetsSha256(release),
    evidenceLock: refs["evidence-lock.json"],
    checkpointJournal: refs["checkpoint-journal.jsonl"],
    firstFrameReport: refs["first-frame-report.json"],
    readyMachineEvidence: refs["ready-machine-evidence.json"],
    baselineGameFidelityRecord: refs["baseline-game-fidelity.json"],
    baselineMachineEvidence: refs["baseline-machine-evidence.json"],
    preWitnessMachineEvidence: refs["pre-witness-machine-evidence.json"],
    terminalMachineEvidence: refs["terminal-machine-evidence.json"],
    gameFidelityRecord: refs["terminal-game-fidelity.json"],
    operatorPublications: { algorithm: "alternating-neutral-a-v1", count: 0 },
    frames: {
      firstVisible: refs["first-visible.rgba"],
      baseline: {
        metadata: refs["baseline-readback-metadata.json"],
        rgba: refs["baseline.rgba"],
      },
      later: {
        metadata: refs["accepted-readback-metadata.json"],
        rgba: refs["accepted.rgba"],
      },
    },
  };
  const fragment = { schema: PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA, run };
  await writeContained(
    captureRoot,
    `${prefix}/run-fragment.json`,
    Buffer.from(canonicalCaptureJson(fragment)),
  );
  return run;
}

async function assemblyFixture() {
  const root = await temporaryRoot("lazuli-fidelity-bundle-");
  const repository = path.join(root, "repository");
  const candidateRoot = path.join(root, "candidate");
  const captureRoot = path.join(root, "capture");
  const planRoot = path.join(root, "plan");
  await Promise.all([
    mkdir(repository, { mode: 0o700 }),
    mkdir(candidateRoot, { mode: 0o700 }),
    mkdir(captureRoot, { mode: 0o700 }),
    mkdir(planRoot, { mode: 0o700 }),
  ]);
  const corpus = JSON.parse(await readFile(CORPUS_PATH));
  const games = [...corpus.games].sort((left, right) => left.priority - right.priority);
  const candidate = await writeRuntimeCandidate(candidateRoot);
  for (let index = 0; index < games.length; index += 1) {
    await writeRunFragment(captureRoot, games[index], index, candidate.release);
  }
  const performanceReport = path.join(planRoot, "report.json");
  const performanceLock = path.join(planRoot, "lock.json");
  await Promise.all([
    writeFile(performanceReport, "performance-report"),
    writeFile(performanceLock, "performance-lock"),
  ]);
  return {
    root,
    repository,
    candidate,
    captureRoot,
    games,
    output: path.join(root, "evidence"),
    plan: {
      controlledPerformance: {
        runId: PERFORMANCE_RUN_ID,
        report: performanceReport,
        lock: performanceLock,
        reportBytes: Buffer.from("performance-report"),
        lockBytes: Buffer.from("performance-lock"),
      },
    },
  };
}

test("capture plan fixes exact corpus order and loopback-only endpoints", async () => {
  const corpus = JSON.parse(await readFile(CORPUS_PATH));
  const games = [...corpus.games].sort((left, right) => left.priority - right.priority);
  const plan = capturePlan(corpus);
  const validated = validateProductionFidelityCapturePlan(plan, games);
  assert.deepEqual(validated.games.map(game => game.key), games.map(game => game.key));
  assert.throws(() => validateProductionFidelityCapturePlan({
    ...plan,
    games: [plan.games[1], plan.games[0], ...plan.games.slice(2)],
  }, games), /games\[0\]\.key/);
  assert.throws(() => validateProductionFidelityCapturePlan({
    ...plan,
    controlledPerformance: { ...plan.controlledPerformance, report: "../report.json" },
  }, games), /portable relative path/);
  assert.throws(() => validateProductionFidelityCapturePlan({
    ...plan,
    cdpEndpoint: "http://example.com:9229/",
  }, games), /loopback/);
  assert.throws(() => validateProductionFidelityCapturePlan({ ...plan, extra: true }, games),
    /keys/);
});

test("plan loader rejects symlinks and contains every external evidence leaf", async () => {
  const root = await temporaryRoot("lazuli-fidelity-plan-");
  const trusted = path.join(root, "trusted");
  await mkdir(trusted);
  const corpus = JSON.parse(await readFile(CORPUS_PATH));
  const games = [...corpus.games].sort((left, right) => left.priority - right.priority);
  const plan = capturePlan(corpus);
  for (const entry of plan.games) {
    await writeContained(trusted, entry.evidenceLock, Buffer.from("lock"));
    await writeContained(trusted, entry.checkpointJournal, Buffer.from("journal"));
  }
  await writeContained(trusted, plan.controlledPerformance.report, Buffer.from("report"));
  await writeContained(trusted, plan.controlledPerformance.lock, Buffer.from("performance lock"));
  await writeContained(trusted, "plan.json", Buffer.from(canonicalCaptureJson(plan)));
  const loaded = await loadProductionFidelityCapturePlan({
    captureRoot: trusted,
    planPath: "plan.json",
    corpusGames: games,
  });
  assert.equal(loaded.games.length, 7);
  const target = path.join(root, "outside.json");
  await writeFile(target, canonicalCaptureJson(plan));
  await symlink(target, path.join(trusted, "linked-plan.json"));
  await assert.rejects(loadProductionFidelityCapturePlan({
    captureRoot: trusted,
    planPath: "linked-plan.json",
    corpusGames: games,
  }), /symlink/);
});

test("assembler emits one canonical private bundle and invokes the real-gate seam", async () => {
  const fixture = await assemblyFixture();
  let gateCall;
  const result = await assembleProductionFidelityBundle({
    candidate: fixture.candidate,
    captureDirectory: fixture.captureRoot,
    capturePlan: fixture.plan,
    corpusGames: fixture.games,
    corpusPath: fileURLPath(CORPUS_PATH),
    outputDirectory: fixture.output,
    repositoryPath: fixture.repository,
    now: () => new Date("2026-08-18T08:00:00.000Z"),
    validateGate: async options => {
      gateCall = options;
      const bytes = await readFile(options.attestationPath);
      const value = JSON.parse(bytes);
      assert.equal(canonicalCaptureJson(value), bytes.toString("utf8"));
      return { ok: true, releaseId: value.release.releaseId };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.releaseId, RELEASE_ID);
  assert.equal(gateCall.releaseManifestPath, fixture.candidate.releasePath);
  const attestationPath = path.join(fixture.output, "attestation.json");
  const attestation = JSON.parse(await readFile(attestationPath));
  assert.deepEqual(attestation.games.map(game => game.key), fixture.games.map(game => game.key));
  assert.equal(attestation.release.sourceCommit, COMMIT);
  assert.equal(attestation.controlledPerformance.runId, PERFORMANCE_RUN_ID);
  assert.deepEqual(
    Object.keys(attestation.controlledPerformance.runtimeAssets),
    [
      "adapter", "coordinator", "core", "dispatcher", "frontend",
      "rendererJavascript", "rendererWasm", "worker",
    ],
  );
  assert.equal((await lstat(fixture.output)).mode & 0o777, 0o700);
  assert.equal((await lstat(attestationPath)).mode & 0o777, 0o600);
  await assert.rejects(readFile(path.join(
    fixture.output,
    "games/01-warioware-usa/run-fragment.json",
  )), /ENOENT/);
});

test("assembler rejects substituted captured leaves and candidate runtime bytes", async () => {
  const captured = await assemblyFixture();
  await writeFile(
    path.join(captured.captureRoot, "games/01-warioware-usa/first-visible.rgba"),
    Buffer.from("substituted"),
  );
  await assert.rejects(assembleProductionFidelityBundle({
    candidate: captured.candidate,
    captureDirectory: captured.captureRoot,
    capturePlan: captured.plan,
    corpusGames: captured.games,
    corpusPath: fileURLPath(CORPUS_PATH),
    outputDirectory: captured.output,
    repositoryPath: captured.repository,
    validateGate: async () => ({ ok: true, releaseId: RELEASE_ID }),
  }), /do not match the run-fragment reference/);

  const runtime = await assemblyFixture();
  await writeFile(path.join(runtime.candidate.distRoot, "assets/core.wasm"), "substituted");
  await assert.rejects(assembleProductionFidelityBundle({
    candidate: runtime.candidate,
    captureDirectory: runtime.captureRoot,
    capturePlan: runtime.plan,
    corpusGames: runtime.games,
    corpusPath: fileURLPath(CORPUS_PATH),
    outputDirectory: runtime.output,
    repositoryPath: runtime.repository,
    validateGate: async () => ({ ok: true, releaseId: RELEASE_ID }),
  }), /size does not match|hash does not match/);
});

test("candidate distribution verification covers primary and rollback assets", async () => {
  const root = await temporaryRoot("lazuli-candidate-dist-");
  const descriptor = async (relative, content) => {
    const bytes = Buffer.from(content);
    await writeContained(root, relative, bytes);
    return { url: `/${relative}`, bytes: bytes.byteLength, sha256: sha256(bytes) };
  };
  const bootstrap = {
    document: await descriptor("index.html", "document"),
    releaseModule: await descriptor("release.mjs", "release module"),
    serviceWorker: await descriptor("sw.js", "service worker"),
  };
  const runtime = {
    core: await descriptor("assets/core.wasm", "core"),
    dispatcher: await descriptor("assets/dispatcher.wasm", "dispatcher"),
    coordinator: await descriptor("assets/coordinator.wasm", "coordinator"),
    adapter: await descriptor("assets/adapter.mjs", "adapter"),
    worker: await descriptor("assets/worker.mjs", "worker"),
  };
  const release = {
    schema: 4,
    bootstrap,
    runtime,
    frontend: await descriptor("assets/frontend.html", "frontend"),
    renderer: {
      javascript: await descriptor("assets/renderer.js", "renderer js"),
      wasm: await descriptor("assets/renderer.wasm", "renderer wasm"),
    },
    rollback: {
      release: {
        schema: 3,
        frontend: await descriptor("assets/rollback.html", "rollback frontend"),
        renderer: {
          javascript: await descriptor("assets/rollback-renderer.js", "rollback renderer js"),
          wasm: await descriptor("assets/rollback-renderer.wasm", "rollback renderer wasm"),
        },
        dsp: await descriptor("assets/rollback-dsp.wasm", "rollback dsp"),
        backend: {
          chunks: [await descriptor("assets/rollback.wasm.chunk", "rollback chunk")],
        },
      },
    },
  };
  await writeFile(path.join(root, "release.json"), JSON.stringify(release));
  assert.deepEqual((await verifyCandidateDistribution(root, async value => value)).release, release);
  await writeFile(path.join(root, "assets/rollback-dsp.wasm"), "changed");
  await assert.rejects(
    verifyCandidateDistribution(root, async value => value),
    /size does not match|hash does not match/,
  );
});

function fileURLPath(url) {
  return url.pathname;
}
