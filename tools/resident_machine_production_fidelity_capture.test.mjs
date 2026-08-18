// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA,
  canonicalCaptureJson,
  operatorPublicationDue,
  orderCaptureInputs,
  parseCaptureArguments,
  productionFidelityRunFragment,
  selectRetainedPreWitnessMachineEvidence,
  selectCreatedCaptureTarget,
  sustainedWindowReached,
  validateCaptureUrl,
  validateCaptureJournal,
  validateLoopbackCdpEndpoint,
  validateNavigationFrame,
  writePrivateLeafAtomic,
} from "./resident_machine_production_fidelity_capture.mjs";
import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";

function sevenCorpus() {
  return {
    games: Array.from({ length: 7 }, (_value, index) => ({
      key: `game-${index + 1}`,
      priority: index + 1,
      disc: { identifier: `GAME0${index + 1}`, revision: 0 },
    })),
  };
}

function keyedLocks(corpus) {
  return new Map([...corpus.games].reverse().map(game => [game.key, {
    bytes: Buffer.from(`lock-${game.key}`),
    path: `/input/${game.key}.json`,
    lock: {
      run: { gameKey: game.key, runId: "10000000-0000-4000-8000-000000000001" },
      selectedGame: { key: game.key, priority: game.priority },
    },
  }]));
}

function keyedJournals(corpus) {
  return new Map([...corpus.games].reverse().map(game => [
    game.key,
    `/input/${game.key}.jsonl`,
  ]));
}

function keyedCaptureUrls(corpus) {
  return new Map([...corpus.games].reverse().map(game => [
    game.key,
    `http://127.0.0.1:${8100 + game.priority}/tools/resident_machine_first_frame.html?capture=fidelity&game=${game.key}`,
  ]));
}

function reference(name) {
  return { path: `games/01-game-1/${name}`, bytes: 1, sha256: "a".repeat(64) };
}

test("controller orders the exact seven inputs by corpus priority, never caller order", () => {
  const corpus = sevenCorpus();
  const ordered = orderCaptureInputs(
    corpus,
    keyedLocks(corpus),
    keyedJournals(corpus),
    keyedCaptureUrls(corpus),
  );
  assert.deepEqual(ordered.map(input => input.game.key), corpus.games.map(game => game.key));
  assert.deepEqual(ordered.map(input => input.game.priority), [1, 2, 3, 4, 5, 6, 7]);

  const missing = keyedLocks(corpus);
  missing.delete("game-4");
  assert.throws(
    () => orderCaptureInputs(corpus, missing, keyedJournals(corpus), keyedCaptureUrls(corpus)),
    /exact seven-game corpus/,
  );
});

test("CDP attachment creates one dedicated target and accepts only exact loopback capture URLs", () => {
  assert.equal(validateLoopbackCdpEndpoint("http://127.0.0.1:9222").href, "http://127.0.0.1:9222/");
  assert.equal(validateLoopbackCdpEndpoint("http://[::1]:9222/").hostname, "[::1]");
  assert.throws(() => validateLoopbackCdpEndpoint("https://127.0.0.1:9222"), /loopback HTTP/);
  assert.throws(() => validateLoopbackCdpEndpoint("http://192.0.2.10:9222"), /loopback HTTP/);

  const url = "http://127.0.0.1:8001/tools/resident_machine_first_frame.html?capture=fidelity&game=game-1";
  assert.equal(validateCaptureUrl(url, "game-1"), url);
  assert.throws(
    () => validateCaptureUrl(`${url}&extra=1`, "game-1"),
    /only capture=fidelity/,
  );
  assert.throws(
    () => validateCaptureUrl(
      "http://127.0.0.1:8001/tools/resident_machine_first_frame.html?game=game-1&capture=fidelity",
      "game-1",
    ),
    /only capture=fidelity/,
  );
  assert.throws(
    () => validateCaptureUrl(url, "game-2"),
    /only capture=fidelity/,
  );
  assert.throws(
    () => validateCaptureUrl(
      "http://192.0.2.1/tools/resident_machine_first_frame.html?capture=fidelity&game=game-1",
      "game-1",
    ),
    /loopback HTTP/,
  );

  const target = selectCreatedCaptureTarget([
    {
      id: "arbitrary-existing-tab",
      type: "page",
      url,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/arbitrary",
    },
    {
      id: "created-target",
      type: "page",
      url: "about:blank",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/created",
    },
  ], "created-target");
  assert.equal(target.id, "created-target");
  assert.match(target.webSocketDebuggerUrl, /\/created$/);
  assert.throws(
    () => selectCreatedCaptureTarget([{
      id: "created-target",
      type: "page",
      webSocketDebuggerUrl: "ws://example.test/devtools/page/one",
    }], "created-target"),
    /not loopback/,
  );
});

test("verified generic operator policy schedules only at deterministic run boundaries", () => {
  const policy = Object.freeze({
    algorithm: "alternating-neutral-a-v1",
    runBoundaryOrigin: "post-first-frame-report-local-zero",
    runBoundaryInterval: 8,
    maximumPublications: 64,
    startsWith: "neutral",
    neutral: Object.freeze({ buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 }),
    a: Object.freeze({ buttons: 0x0100, stickXyCxy: 0x8080_8080, triggerLrab: 0x00ff_0000 }),
  });
  assert.equal(operatorPublicationDue(policy, 0, 0), true);
  assert.equal(operatorPublicationDue(policy, 1, 1), false);
  assert.equal(operatorPublicationDue(policy, 8, 1), true);
  assert.equal(operatorPublicationDue(policy, 512, 64), false);
  assert.throws(
    () => operatorPublicationDue({ ...policy, runBoundaryOrigin: "boot" }, 0, 0),
    /origin changed/,
  );
  const spelling = canonicalCaptureJson(policy);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(canonicalCaptureJson(policy), spelling);
  }
});

test("witness authority selects the durable retained pre-publication ME, not fresh common state", () => {
  const fresh = Object.freeze({ payload: "fresh-post-publication" });
  const retained = Object.freeze({ payload: "durable-pre-publication" });
  assert.strictEqual(selectRetainedPreWitnessMachineEvidence({
    machineEvidence: fresh,
    artifacts: { preWitnessMachineEvidence: retained },
  }), retained);
  assert.notStrictEqual(
    selectRetainedPreWitnessMachineEvidence({
      machineEvidence: fresh,
      artifacts: { preWitnessMachineEvidence: retained },
    }),
    fresh,
  );
});

test("loader binding rejects URL, frame, and loader drift", () => {
  const binding = { frameId: "frame", loaderId: "loader", url: "http://127.0.0.1/capture" };
  assert.deepEqual(validateNavigationFrame(binding, {
    id: "frame", loaderId: "loader", url: binding.url,
  }), { id: "frame", loaderId: "loader", url: binding.url });
  for (const changed of [
    { id: "other", loaderId: "loader", url: binding.url },
    { id: "frame", loaderId: "other", url: binding.url },
    { id: "frame", loaderId: "loader", url: "about:blank" },
  ]) assert.throws(() => validateNavigationFrame(binding, changed), /drifted/);
});

test("offline sustained-window decision requires both +120 VI fields and +64 presentations", () => {
  const first = { vi: { viFields: "1000" }, gx: { presentedFrames: "400" } };
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "1120" }, gx: { presentedFrames: "464" },
  }), true);
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "1119" }, gx: { presentedFrames: "464" },
  }), false);
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "1120" }, gx: { presentedFrames: "463" },
  }), false);
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "999" }, gx: { presentedFrames: "999" },
  }), false);
});

test("run fragment has only the agreed direct evidence refs and metadata frames", () => {
  const run = {
    key: "game-1",
    runId: "10000000-0000-4000-8000-000000000001",
    capturedAt: "2026-08-18T00:00:00.000Z",
    releaseId: "b".repeat(64),
    executionAssetsSha256: "c".repeat(64),
    evidenceLock: reference("evidence-lock.json"),
    checkpointJournal: reference("checkpoint-journal.jsonl"),
    firstFrameReport: reference("first-frame-report.json"),
    readyMachineEvidence: reference("ready-machine-evidence.json"),
    baselineGameFidelityRecord: reference("baseline-game-fidelity.json"),
    baselineMachineEvidence: reference("baseline-machine-evidence.json"),
    preWitnessMachineEvidence: reference("pre-witness-machine-evidence.json"),
    terminalMachineEvidence: reference("terminal-machine-evidence.json"),
    gameFidelityRecord: reference("terminal-game-fidelity.json"),
    operatorPublications: { algorithm: "alternating-neutral-a-v1", count: 12 },
    frames: {
      firstVisible: reference("first-visible.rgba"),
      baseline: {
        metadata: reference("baseline-readback-metadata.json"),
        rgba: reference("baseline.rgba"),
      },
      later: {
        metadata: reference("accepted-readback-metadata.json"),
        rgba: reference("accepted.rgba"),
      },
    },
  };
  const fragment = productionFidelityRunFragment(run);
  assert.equal(fragment.schema, PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA);
  assert.strictEqual(fragment.run, run);
  assert.deepEqual(Object.keys(fragment), ["schema", "run"]);
  assert.deepEqual(Object.keys(fragment.run.frames.baseline).sort(), ["metadata", "rgba"]);
  assert.equal("presentation" in fragment.run.frames.baseline, false);
  assert.equal("captureLeaves" in fragment, false);
});

test("private atomic leaves are contained, exact, and mode 0600", async () => {
  const root = path.join(tmpdir(), `lazuli-production-capture-${process.pid}-${Date.now()}`);
  await mkdirForTest(root);
  try {
    const bytes = Buffer.from("owned evidence bytes");
    const ref = await writePrivateLeafAtomic(root, "games/01-game-1/leaf.bin", bytes);
    assert.deepEqual(ref, {
      path: "games/01-game-1/leaf.bin",
      bytes: bytes.byteLength,
      sha256: "108ffc7cace43edb617236c93748ef0e4e17d4022330af45a4e04cfa3297ea73",
    });
    assert.deepEqual(await readFile(path.join(root, ref.path)), bytes);
    assert.equal((await stat(path.join(root, ref.path))).mode & 0o777, 0o600);
    await assert.rejects(
      writePrivateLeafAtomic(root, "games/01-game-1/leaf.bin", Buffer.from("replacement")),
      /EEXIST/,
    );
    assert.deepEqual(await readFile(path.join(root, ref.path)), bytes);
    await assert.rejects(
      writePrivateLeafAtomic(root, "../escape.bin", bytes),
      /escaped the output directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller authenticates nested durable checkpoint payloads, never flat wrappers", () => {
  const flat = Buffer.from(`${JSON.stringify({
    runId: "10000000-0000-4000-8000-000000000001",
    gameKey: "game-1",
    kind: "fidelity-terminal",
  })}\n`);
  assert.throws(() => validateCaptureJournal(flat, {
    game: { key: "game-1" },
    lockBytes: Buffer.from("{}"),
    lock: {
      run: {
        runId: "10000000-0000-4000-8000-000000000001",
        gameKey: "game-1",
      },
    },
  }), /journal identity changed/);
});

async function mkdirForTest(directory) {
  await mkdir(directory, { mode: 0o700 });
}

test("CLI requires keyed lock and journal inputs and retains exact key association", () => {
  const corpus = sevenCorpus();
  const argv = [
    "--cdp-endpoint", "http://127.0.0.1:9222",
    "--release", "release.json",
    "--output-directory", "capture-output",
  ];
  for (const game of corpus.games) {
    argv.push("--evidence-lock", `${game.key}=locks/${game.key}.json`);
    argv.push("--checkpoint-journal", `${game.key}=journals/${game.key}.jsonl`);
    argv.push(
      "--capture-url",
      `${game.key}=http://127.0.0.1:${8100 + game.priority}/tools/resident_machine_first_frame.html?capture=fidelity&game=${game.key}`,
    );
  }
  const options = parseCaptureArguments(argv);
  assert.equal(options.evidenceLocks.size, 7);
  assert.equal(options.checkpointJournals.size, 7);
  assert.equal(options.captureUrls.size, 7);
  assert.match(options.evidenceLocks.get("game-7"), /locks\/game-7\.json$/);
  assert.throws(
    () => parseCaptureArguments([...argv, "--operator-sequence", "unbound.json"]),
    /unknown option/,
  );
});

test("controller source is title-blind, attaches only, and decodes machine evidence offline", async () => {
  const sourcePath = fileURLToPath(new URL(
    "./resident_machine_production_fidelity_capture.mjs",
    import.meta.url,
  ));
  const source = await readFile(sourcePath, "utf8");
  const corpus = await readGameCompatibilityCorpus();
  for (const game of corpus.games) assert.doesNotMatch(source, new RegExp(game.key, "g"));
  assert.doesNotMatch(source, /node:child_process|\bexecFile\b|\bspawn\s*\(/);
  assert.doesNotMatch(source, /document\.title|milestone\.id|selectedGame\.key\s*===/);
  assert.doesNotMatch(source, new RegExp(["attes", "tation"].join(""), "i"));
  assert.match(source, /new DevToolsSession\(url, sessionOptions\)/);
  assert.match(source, /Target\.createTarget/);
  assert.match(source, /Target\.closeTarget/);
  assert.match(source, /Page\.navigate/);
  assert.match(source, /validateMachineEvidenceV1Envelope/);
  assert.match(source, /lazuliProductionFidelityCapture/);
  assert.match(source, /lost Rust Baseline before witness publication/);
  assert.match(source, /"operator",\s+undefined,/);
  assert.doesNotMatch(source, /"operator",\s+controller,/);
  for (const method of ["snapshot", "step", "operator", "publishWitness", "finish", "abort"]) {
    assert.match(source, new RegExp(`\\"${method}\\"`));
  }
});
