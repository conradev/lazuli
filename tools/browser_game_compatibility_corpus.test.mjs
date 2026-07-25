#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GAME_COMPATIBILITY_CORPUS_SCHEMA,
  readGameCompatibilityCorpus,
  validateGameCompatibilityCorpus,
  verifyLocalGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";

function fixtureGame(overrides = {}) {
  return {
    key: "example-game",
    priority: 1,
    file: "Example Game (USA).ciso",
    bytes: 4,
    image: {
      format: "ciso",
      sha256: "a".repeat(64),
    },
    disc: {
      identifier: "GAME01",
      revision: 0,
    },
    milestone: {
      id: "live-gameplay",
      description: "Reach live controllable gameplay.",
      inputWitness: "Movement is consumed and changes guest game state.",
    },
    ...overrides,
  };
}

function fixtureCorpus(games = [fixtureGame()]) {
  return {
    schema: GAME_COMPATIBILITY_CORPUS_SCHEMA,
    renderer: "wgpu-webgpu",
    fallbacks: false,
    publicGameRoutes: false,
    evidence: {
      sustainedViFields: 120,
      viewportFrames: 64,
    },
    games,
  };
}

test("checked-in games corpus defines seven strict-WebGPU local milestones", async () => {
  const corpus = await readGameCompatibilityCorpus();
  assert.equal(corpus.games.length, 7);
  assert.equal(corpus.renderer, "wgpu-webgpu");
  assert.equal(corpus.fallbacks, false);
  assert.equal(corpus.publicGameRoutes, false);
  assert.deepEqual(
    corpus.games.map(game => game.priority),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    new Set(corpus.games.map(game => game.disc.identifier)),
    new Set(["GFZE01", "GZLE01", "GLME01", "GM8E01", "GSWE64", "GALE01", "GZWE01"]),
  );
  for (const game of corpus.games) {
    assert.match(game.file, /\.ciso$/);
    assert.match(game.image.sha256, /^[0-9a-f]{64}$/);
    assert.match(game.milestone.inputWitness, /\bconsumed\b/i);
    assert.match(game.milestone.inputWitness, /\bguest game state\b/i);
  }
});

test("corpus policy rejects rendering fallbacks and public game routes", () => {
  for (const mutate of [
    corpus => { corpus.renderer = "canvas-2d"; },
    corpus => { corpus.fallbacks = true; },
    corpus => { corpus.publicGameRoutes = true; },
    corpus => { corpus.evidence.sustainedViFields = 119; },
    corpus => { corpus.evidence.viewportFrames = 63; },
  ]) {
    const corpus = fixtureCorpus();
    mutate(corpus);
    assert.throws(
      () => validateGameCompatibilityCorpus(corpus),
      /invalid game compatibility corpus/,
    );
  }
});

test("corpus requires exact unique local identities and causal milestones", () => {
  const duplicate = fixtureGame({
    key: "other-game",
    priority: 2,
    file: "Other Game (USA).ciso",
  });
  const cases = [
    corpus => { corpus.games[0].file = "../public/game.ciso"; },
    corpus => { corpus.games[0].image.sha256 = "A".repeat(64); },
    corpus => { corpus.games[0].disc.identifier = "game01"; },
    corpus => { corpus.games[0].milestone.inputWitness = "The title screen animates."; },
    corpus => { corpus.games.push(structuredClone(duplicate)); },
    corpus => {
      corpus.games.push({
        ...structuredClone(duplicate),
        image: { format: "ciso", sha256: "b".repeat(64) },
        disc: { identifier: "OTHR01", revision: 0 },
        priority: 3,
      });
    },
  ];
  const patterns = [
    /basename ending in \.ciso/,
    /lowercase SHA-256/,
    /uppercase disc identifier/,
    /guest consumption/,
    /duplicate "a{64}"/,
    /priorities must be contiguous/,
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const corpus = fixtureCorpus();
    cases[index](corpus);
    assert.throws(
      () => validateGameCompatibilityCorpus(corpus),
      patterns[index],
    );
  }
});

test("local verifier rejects missing, extra, wrong-sized, and wrong-hash images", async () => {
  const corpus = fixtureCorpus();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-game-corpus-"));
  const path = join(directory, corpus.games[0].file);
  const identify = async () => ({
    format: "ciso",
    sha256: corpus.games[0].image.sha256,
  });

  await assert.rejects(
    verifyLocalGameCompatibilityCorpus(corpus, { directory, identify }),
    /does not exactly match/,
  );
  await writeFile(path, Buffer.alloc(3));
  await assert.rejects(
    verifyLocalGameCompatibilityCorpus(corpus, { directory, identify }),
    /size mismatch/,
  );
  await writeFile(path, Buffer.alloc(4));
  await writeFile(join(directory, "Unexpected.ciso"), Buffer.alloc(4));
  await assert.rejects(
    verifyLocalGameCompatibilityCorpus(corpus, { directory, identify }),
    /does not exactly match/,
  );
});

test("local verifier emits priority-ordered private image evidence", async () => {
  const second = fixtureGame({
    key: "second-game",
    priority: 1,
    file: "Second Game.ciso",
    bytes: 6,
    image: { format: "ciso", sha256: "b".repeat(64) },
    disc: { identifier: "SCND01", revision: 2 },
  });
  const first = fixtureGame({
    priority: 2,
  });
  const corpus = fixtureCorpus([first, second]);
  const directory = await mkdtemp(join(tmpdir(), "lazuli-game-corpus-"));
  await writeFile(join(directory, first.file), Buffer.alloc(first.bytes));
  await writeFile(join(directory, second.file), Buffer.alloc(second.bytes));
  const identities = new Map([
    [first.file, first.image],
    [second.file, second.image],
  ]);
  const games = await verifyLocalGameCompatibilityCorpus(corpus, {
    directory,
    identify: async path => identities.get(path.split("/").at(-1)),
  });
  assert.deepEqual(
    games.map(game => game.key),
    ["second-game", "example-game"],
  );
  assert.deepEqual(games[0].disc, { identifier: "SCND01", revision: 2 });
  assert.equal(games[0].image.sha256, "b".repeat(64));
});
