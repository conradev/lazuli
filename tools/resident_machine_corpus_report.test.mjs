#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateResidentCorpusEvidence } from "./resident_machine_corpus_report.mjs";

const fixture = JSON.parse(await readFile(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "resident_machine_corpus_smoke_report_legacy_fixture.json",
  ),
  "utf8",
));
const trustedLock = JSON.parse(await readFile(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "resident_machine_corpus_evidence_lock_legacy_fixture.json",
  ),
  "utf8",
));
const corpusBytes = await readFile(join(
  dirname(fileURLToPath(import.meta.url)),
  "compatibility/games/corpus.json",
));

function validateComplete(report) {
  return validateResidentCorpusEvidence(report, { requireComplete: true, trustedLock });
}

test("checked-in legacy representative corpus fixture satisfies the complete schema", () => {
  assert.equal(
    validateComplete(structuredClone(fixture)).status,
    "complete",
  );
});

test("trusted lock remains bound to the checked-in compatibility corpus", () => {
  assert.equal(
    createHash("sha256").update(corpusBytes).digest("hex"),
    trustedLock.sourceCorpusSha256,
  );
  const corpus = JSON.parse(corpusBytes);
  assert.deepEqual(
    trustedLock.games,
    corpus.games.map(game => ({
      key: game.key,
      priority: game.priority,
      bytes: game.bytes,
      sha256: game.image.sha256,
    })),
  );
});

test("complete publication requires an external trusted lock and a nonempty selection", () => {
  assert.throws(
    () => validateResidentCorpusEvidence(structuredClone(fixture), { requireComplete: true }),
    /trusted lock/,
  );
  const vacuous = structuredClone(fixture);
  vacuous.corpus.selectedGameKeys = [];
  vacuous.games = [];
  vacuous.summary = {
    requestedGames: 0,
    attemptedGames: 0,
    completeGames: 0,
    failedGames: 0,
  };
  assert.throws(() => validateComplete(vacuous), /at least one game/);
});

test("complete evidence rejects selected-game substitution and reordering", () => {
  const substituted = structuredClone(fixture);
  substituted.corpus.selectedGameKeys[0] = "another-game";
  assert.throws(
    () => validateComplete(substituted),
    /absent from the trusted corpus/,
  );

  const omitted = structuredClone(fixture);
  omitted.corpus.selectedGameKeys.push("another-game");
  omitted.summary.requestedGames += 1;
  assert.throws(
    () => validateComplete(omitted),
    /absent from the trusted corpus/,
  );
});

test("complete evidence rejects renderer, core, and physical-read disagreement", () => {
  for (const mutate of [
    report => { report.games[0].renderer.calls += 1; },
    report => { report.games[0].residentTotals.coldInstalls += 1; },
    report => { report.games[0].transport.after.physicalReadRequests += 1; },
  ]) {
    const report = structuredClone(fixture);
    mutate(report);
    assert.throws(
      () => validateComplete(report),
      /invalid resident corpus evidence/,
    );
  }
});

test("complete evidence rejects every cap, timeout, zero-progress, and fault boundary", () => {
  for (const mutate of [
    report => { report.games[0].warmup.hostCallCapBoundaries = 1; },
    report => { report.games[0].measurement.coldInstallCapBoundaries = 1; },
    report => { report.games[0].measurement.workerTimeoutBoundaries = 1; },
    report => { report.games[0].measurement.zeroProgressCapBoundaries = 1; },
    report => { report.games[0].measurement.rustStopBoundaries = 1; },
    report => { report.games[0].faults.preconditionFailures = 1; },
  ]) {
    const report = structuredClone(fixture);
    mutate(report);
    assert.throws(
      () => validateComplete(report),
      /invalid resident corpus evidence/,
    );
  }
});

test("complete evidence rejects corpus, artifact, policy, and transport metadata rewrites", () => {
  for (const mutate of [
    report => { report.corpus.sourceCorpusSha256 = "0".repeat(64); },
    report => { report.artifacts.schema = "wrong"; },
    report => { report.artifacts.artifacts["browser_machine.wasm"].sha256 = "0".repeat(64); },
    report => { report.policy = {}; },
    report => {
      report.games[0].transport.before.schema = "wrong";
      report.games[0].transport.after.schema = "wrong";
    },
    report => {
      report.games[0].transport.before.gameKey = "wrong";
      report.games[0].transport.after.gameKey = "wrong";
    },
  ]) {
    const report = structuredClone(fixture);
    mutate(report);
    assert.throws(() => validateComplete(report), /invalid resident corpus evidence/);
  }
});

test("complete evidence rejects impossible window arithmetic and policy disagreement", () => {
  for (const mutate of [
    report => { report.games[0].measurement.executedCycles = "0"; },
    report => { report.games[0].measurement.executedInstructions = `1${"0".repeat(400)}`; },
    report => { report.policy.cycleUpperCap = "1000001"; },
    report => { report.games[0].measurement.slices += 1; },
    report => { report.games[0].measurement.outcomeDetails[0] += 1; },
    report => { report.games[0].measurement.instructionOvershoot = "0"; },
    report => { report.games[0].measurement.targetInstructions = "1"; },
    report => { report.games[0].measurement.wallMs = report.policy.windowTimeoutMs + 1; },
    report => { report.games[0].boot.reads = report.policy.maxBootReads + 1; },
    report => { report.games[0].boot.wallMs = report.policy.bootTimeoutMs + 1; },
    report => {
      report.games[0].adapterDiagnostics.before.totalDiReads = 1;
      report.games[0].adapterDiagnostics.after.totalDiReads = 0;
      report.games[0].adapterDiagnostics.after.totalRenderCalls = 1;
    },
  ]) {
    const report = structuredClone(fixture);
    mutate(report);
    assert.throws(() => validateComplete(report), /invalid resident corpus evidence/);
  }
});

test("all-corpus publication binds the exact trusted seven-game order", () => {
  assert.throws(
    () => validateResidentCorpusEvidence(structuredClone(fixture), {
      requireComplete: true,
      requireAll: true,
      trustedLock,
    }),
    /trusted lock/,
  );
});

test("CLI rejects typoed publication flags instead of weakening the gate", () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.execPath, [
    join(directory, "resident_machine_corpus_report.mjs"),
    "--require-complete",
    "--require-al",
    join(directory, "resident_machine_corpus_smoke_report_legacy_fixture.json"),
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option --require-al/);
});

test("CLI publication requires an explicitly supplied external lock", () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.execPath, [
    join(directory, "resident_machine_corpus_report.mjs"),
    "--require-complete",
    join(directory, "resident_machine_corpus_smoke_report_legacy_fixture.json"),
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--lock is required/);
});

test("typed failure evidence admits a joined transport fault and rejects contradiction", () => {
  const report = structuredClone(fixture);
  const complete = report.games[0];
  const transport = structuredClone(complete.transport);
  transport.after.preconditionFailures += 1;
  const failure = {
    status: "failed",
    game: complete.game,
    phase: "transport-finalization",
    error: "typed transport precondition failure",
    boundaryEvidence: {
      boundary: "transport-finalization-failure",
      unobservablePartialRustCounters: true,
    },
    lastAdapterDiagnostics: complete.adapterDiagnostics.after,
    transport,
    renderer: {
      ...complete.renderer,
      relaysSettledBeforeSnapshot: true,
    },
    faults: {
      rustStops: 0,
      hostCallCaps: 0,
      coldInstallCaps: 0,
      workerTimeouts: 0,
      zeroProgressCaps: 0,
      invalidRangeRequests: 0,
      preconditionFailures: 1,
      rendererFailures: 0,
    },
    isolationCompromised: false,
    inputSamples: 0,
  };
  report.status = "failed";
  report.games = [failure];
  report.summary.completeGames = 0;
  report.summary.failedGames = 1;
  assert.equal(
    validateResidentCorpusEvidence(report, { trustedLock }).status,
    "failed",
  );
  failure.faults.preconditionFailures = 0;
  assert.throws(
    () => validateResidentCorpusEvidence(report, { trustedLock }),
    /faults\.preconditionFailures/,
  );
});

test("production corpus execution instantiates the lock-derived packaged Worker URL", async () => {
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "resident_machine_corpus.mjs"),
    "utf8",
  );
  assert.match(source, /const worker = new Worker\(workerUrl, \{ type: "module" \}\)/);
  assert.match(source, /workerUrl: lock\.release\.executionAssets\.worker\.url/);
  assert.match(source, /runGame\(game, renderer, authority\.workerUrl\)/);
});
