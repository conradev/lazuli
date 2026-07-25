#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  GAME_COMPATIBILITY_CORPUS_PATH,
  readGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  GAME_FIRST_PLAYABLE_BUTTONS,
  GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
  GameFirstPlayableTranscriptError,
  deriveGameFirstPlayableTranscriptCore,
  gameFirstPlayableButtonMask,
  verifyGameFirstPlayableTranscriptCore,
} from "./browser_game_first_playable_transcript_core.mjs";
import {
  projectLuigisMansionGuestConsumption,
} from "./browser_game_first_playable_luigi.mjs";
import {
  projectWarioWareGuestConsumption,
} from "./browser_game_first_playable_warioware.mjs";

export {
  GAME_FIRST_PLAYABLE_BUTTONS,
  GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
  GameFirstPlayableTranscriptError,
};

function projectSupportedGuestConsumption(options) {
  return projectLuigisMansionGuestConsumption(options)
    ?? projectWarioWareGuestConsumption(options);
}

export function deriveGameFirstPlayableTranscript(options) {
  return deriveGameFirstPlayableTranscriptCore({
    ...options,
    guestProjector: projectSupportedGuestConsumption,
  });
}

export function verifyGameFirstPlayableTranscript(options) {
  return verifyGameFirstPlayableTranscriptCore({
    ...options,
    guestProjector: projectSupportedGuestConsumption,
  });
}

export function parseGameFirstPlayableArguments(argv) {
  const options = {
    button: null,
    corpus: GAME_COMPATIBILITY_CORPUS_PATH,
    gameKey: null,
    output: null,
    post: null,
    pre: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--button", "--corpus", "--game", "--output", "--post", "--pre"].includes(argument)) {
      throw new Error(`unknown argument ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`duplicate argument ${argument}`);
    seen.add(argument);
    index += 1;
    if (index >= argv.length) throw new Error(`missing value after ${argument}`);
    const value = argv[index];
    switch (argument) {
      case "--button": options.button = value; break;
      case "--corpus": options.corpus = resolve(value); break;
      case "--game": options.gameKey = value; break;
      case "--output": options.output = resolve(value); break;
      case "--post": options.post = resolve(value); break;
      case "--pre": options.pre = resolve(value); break;
    }
  }
  for (const [name, value] of [
    ["--button", options.button],
    ["--game", options.gameKey],
    ["--post", options.post],
    ["--pre", options.pre],
  ]) {
    if (value === null) throw new Error(`${name} is required`);
  }
  gameFirstPlayableButtonMask(options.button);
  if (
    options.output === options.pre
    || options.output === options.post
    || options.output === options.corpus
  ) {
    throw new Error("--output must not overwrite an input report or the corpus");
  }
  return options;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label} ${path}: ${error.message ?? String(error)}`);
  }
}

async function persistTranscript(path, transcript) {
  const text = `${JSON.stringify(transcript, null, 2)}\n`;
  if (path === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
  process.stdout.write(`${path}\n`);
}

export async function runGameFirstPlayableTranscriptCli(argv) {
  const options = parseGameFirstPlayableArguments(argv);
  const [corpus, preReport, postReport] = await Promise.all([
    readGameCompatibilityCorpus(options.corpus),
    readJson(options.pre, "pre-input report"),
    readJson(options.post, "post-input report"),
  ]);
  const transcript = deriveGameFirstPlayableTranscript({
    button: options.button,
    corpus,
    gameKey: options.gameKey,
    postReport,
    preReport,
  });
  await persistTranscript(options.output, transcript);
}

if (
  process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runGameFirstPlayableTranscriptCli(process.argv.slice(2)).catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
