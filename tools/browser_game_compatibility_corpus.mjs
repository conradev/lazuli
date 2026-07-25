#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";

export const GAME_COMPATIBILITY_CORPUS_SCHEMA =
  "lazuli-game-compatibility-corpus-v1";
export const GAME_COMPATIBILITY_RENDERER = "wgpu-webgpu";
export const GAME_COMPATIBILITY_CORPUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "compatibility/games/corpus.json",
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GAME_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DISC_IDENTIFIER_PATTERN = /^[A-Z0-9]{6}$/;
const CISO_FILE_PATTERN = /^[^/\\\0]+\.ciso$/;

function corpusFailure(path, message) {
  throw new Error(`invalid game compatibility corpus at ${path}: ${message}`);
}

function requiredObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    corpusFailure(path, "expected an object");
  }
  return value;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    corpusFailure(path, "expected a non-empty trimmed string");
  }
  return value;
}

function requiredPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    corpusFailure(path, "expected a positive integer");
  }
  return value;
}

function requiredNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    corpusFailure(path, "expected a non-negative integer");
  }
  return value;
}

function requirePattern(value, pattern, path, description) {
  requiredString(value, path);
  if (!pattern.test(value)) corpusFailure(path, `expected ${description}`);
  return value;
}

function rejectDuplicate(seen, value, path) {
  if (seen.has(value)) corpusFailure(path, `duplicate ${JSON.stringify(value)}`);
  seen.add(value);
}

function validateMilestone(value, path) {
  const milestone = requiredObject(value, path);
  requirePattern(
    milestone.id,
    GAME_KEY_PATTERN,
    `${path}.id`,
    "a lowercase kebab-case milestone ID",
  );
  requiredString(milestone.description, `${path}.description`);
  requiredString(milestone.inputWitness, `${path}.inputWitness`);
  if (!/\bconsumed\b/i.test(milestone.inputWitness)) {
    corpusFailure(
      `${path}.inputWitness`,
      "must require guest consumption of the input",
    );
  }
  if (!/\bguest game state\b/i.test(milestone.inputWitness)) {
    corpusFailure(
      `${path}.inputWitness`,
      "must require a causal guest-state witness",
    );
  }
}

function validateGame(value, index, seen) {
  const path = `$.games[${index}]`;
  const game = requiredObject(value, path);
  const key = requirePattern(
    game.key,
    GAME_KEY_PATTERN,
    `${path}.key`,
    "a lowercase kebab-case game key",
  );
  rejectDuplicate(seen.keys, key, `${path}.key`);

  const priority = requiredPositiveInteger(game.priority, `${path}.priority`);
  rejectDuplicate(seen.priorities, priority, `${path}.priority`);

  const file = requirePattern(
    game.file,
    CISO_FILE_PATTERN,
    `${path}.file`,
    "a basename ending in .ciso",
  );
  if (basename(file) !== file || file.startsWith(".")) {
    corpusFailure(`${path}.file`, "must be a plain non-hidden basename");
  }
  rejectDuplicate(seen.files, file, `${path}.file`);
  requiredPositiveInteger(game.bytes, `${path}.bytes`);

  const image = requiredObject(game.image, `${path}.image`);
  if (image.format !== "ciso") {
    corpusFailure(`${path}.image.format`, "expected ciso");
  }
  const sha256 = requirePattern(
    image.sha256,
    SHA256_PATTERN,
    `${path}.image.sha256`,
    "a lowercase SHA-256 digest",
  );
  rejectDuplicate(seen.sha256, sha256, `${path}.image.sha256`);

  const disc = requiredObject(game.disc, `${path}.disc`);
  const identifier = requirePattern(
    disc.identifier,
    DISC_IDENTIFIER_PATTERN,
    `${path}.disc.identifier`,
    "a six-character uppercase disc identifier",
  );
  rejectDuplicate(seen.identifiers, identifier, `${path}.disc.identifier`);
  requiredNonNegativeInteger(disc.revision, `${path}.disc.revision`);
  if (disc.revision > 0xff) {
    corpusFailure(`${path}.disc.revision`, "expected an unsigned byte");
  }

  validateMilestone(game.milestone, `${path}.milestone`);
}

export function validateGameCompatibilityCorpus(value) {
  const corpus = requiredObject(value, "$");
  if (corpus.schema !== GAME_COMPATIBILITY_CORPUS_SCHEMA) {
    corpusFailure("$.schema", `expected ${GAME_COMPATIBILITY_CORPUS_SCHEMA}`);
  }
  if (corpus.renderer !== GAME_COMPATIBILITY_RENDERER) {
    corpusFailure("$.renderer", `expected ${GAME_COMPATIBILITY_RENDERER}`);
  }
  if (corpus.fallbacks !== false) {
    corpusFailure("$.fallbacks", "fallbacks must be disabled");
  }
  if (corpus.publicGameRoutes !== false) {
    corpusFailure("$.publicGameRoutes", "public game routes must be disabled");
  }

  const evidence = requiredObject(corpus.evidence, "$.evidence");
  if (requiredPositiveInteger(
    evidence.sustainedViFields,
    "$.evidence.sustainedViFields",
  ) < 120) {
    corpusFailure("$.evidence.sustainedViFields", "expected at least 120 fields");
  }
  if (requiredPositiveInteger(
    evidence.viewportFrames,
    "$.evidence.viewportFrames",
  ) < 64) {
    corpusFailure("$.evidence.viewportFrames", "expected at least 64 frames");
  }

  if (!Array.isArray(corpus.games) || corpus.games.length === 0) {
    corpusFailure("$.games", "expected a non-empty array");
  }
  const seen = {
    files: new Set(),
    identifiers: new Set(),
    keys: new Set(),
    priorities: new Set(),
    sha256: new Set(),
  };
  corpus.games.forEach((game, index) => validateGame(game, index, seen));
  const priorities = [...seen.priorities].sort((left, right) => left - right);
  for (let index = 0; index < priorities.length; index += 1) {
    if (priorities[index] !== index + 1) {
      corpusFailure("$.games", "priorities must be contiguous starting at 1");
    }
  }
  return corpus;
}

export async function readGameCompatibilityCorpus(
  path = GAME_COMPATIBILITY_CORPUS_PATH,
) {
  return validateGameCompatibilityCorpus(
    JSON.parse(await readFile(path, "utf8")),
  );
}

export async function verifyLocalGameCompatibilityCorpus(
  corpus,
  {
    directory = resolve("games"),
    identify = identifyLocalDiscImage,
  } = {},
) {
  validateGameCompatibilityCorpus(corpus);
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const actualFiles = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".ciso"))
    .map(entry => entry.name)
    .sort();
  const expectedFiles = corpus.games.map(game => game.file).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `local game corpus does not exactly match the manifest: ${JSON.stringify({
        actual: actualFiles,
        expected: expectedFiles,
      })}`,
    );
  }

  const results = [];
  for (const game of [...corpus.games].sort(
    (left, right) => left.priority - right.priority,
  )) {
    const path = resolve(root, game.file);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== game.bytes) {
      throw new Error(
        `local game image size mismatch for ${game.file}: `
          + `expected ${game.bytes}, got ${metadata.size}`,
      );
    }
    const identity = await identify(path);
    if (
      identity.format !== game.image.format
      || identity.sha256 !== game.image.sha256
    ) {
      throw new Error(
        `local game image identity mismatch for ${game.file}: `
          + `expected ${JSON.stringify(game.image)}, got ${JSON.stringify(identity)}`,
      );
    }
    results.push(Object.freeze({
      bytes: metadata.size,
      disc: game.disc,
      file: game.file,
      image: identity,
      key: game.key,
      milestone: game.milestone.id,
      priority: game.priority,
    }));
  }
  return Object.freeze(results);
}

async function main() {
  const corpus = await readGameCompatibilityCorpus();
  const gamesArgument = process.argv.indexOf("--games");
  if (gamesArgument !== -1 && process.argv[gamesArgument + 1] === undefined) {
    throw new Error("--games requires a directory");
  }
  const directory = gamesArgument === -1
    ? resolve("games")
    : resolve(process.argv[gamesArgument + 1]);
  const games = await verifyLocalGameCompatibilityCorpus(corpus, { directory });
  process.stdout.write(`${JSON.stringify({
    schema: corpus.schema,
    renderer: corpus.renderer,
    fallbacks: corpus.fallbacks,
    publicGameRoutes: corpus.publicGameRoutes,
    games,
  }, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
