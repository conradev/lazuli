#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";
import {
  GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
  parseGameFirstPlayableArguments,
} from "./browser_game_first_playable_transcript.mjs";
import {
  makeWarioWareFirstPlayableReportPair,
} from "./browser_game_first_playable_warioware_test_fixture.mjs";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(
  new URL("./browser_game_first_playable_transcript.mjs", import.meta.url),
);

test("CLI arguments require an explicit corpus game, report pair, and button", () => {
  const options = parseGameFirstPlayableArguments([
    "--game",
    "warioware-usa",
    "--pre",
    "pre.json",
    "--post",
    "post.json",
    "--button",
    "a",
    "--output",
    "transcript.json",
  ]);
  assert.equal(options.gameKey, "warioware-usa");
  assert.equal(options.pre, resolve("pre.json"));
  assert.equal(options.post, resolve("post.json"));
  assert.equal(options.output, resolve("transcript.json"));

  assert.throws(
    () => parseGameFirstPlayableArguments([
      "--game", "warioware-usa",
      "--pre", "pre.json",
      "--post", "post.json",
    ]),
    /--button is required/,
  );
  assert.throws(
    () => parseGameFirstPlayableArguments([
      "--game", "warioware-usa",
      "--pre", "pre.json",
      "--post", "post.json",
      "--button", "x",
    ]),
    /unsupported controller button/,
  );
  assert.throws(
    () => parseGameFirstPlayableArguments([
      "--game", "warioware-usa",
      "--pre", "pre.json",
      "--post", "post.json",
      "--button", "a",
      "--output", "pre.json",
    ]),
    /must not overwrite/,
  );
  assert.throws(
    () => parseGameFirstPlayableArguments([
      "--game", "warioware-usa",
      "--pre", "pre.json",
      "--post", "post.json",
      "--button", "a",
      "--corpus", "corpus.json",
      "--output", "corpus.json",
    ]),
    /must not overwrite/,
  );
});

test("CLI wrapper reads reports and atomically writes the derived transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazuli-first-playable-"));
  try {
    const corpus = await readGameCompatibilityCorpus();
    const game = corpus.games.find(
      candidate => candidate.key === "warioware-usa",
    );
    const reports = makeWarioWareFirstPlayableReportPair(game);
    const prePath = join(directory, "pre.json");
    const postPath = join(directory, "post.json");
    const outputPath = join(directory, "transcript.json");
    await Promise.all([
      writeFile(prePath, `${JSON.stringify(reports.preReport)}\n`, "utf8"),
      writeFile(postPath, `${JSON.stringify(reports.postReport)}\n`, "utf8"),
    ]);
    const { stdout } = await execFileAsync(process.execPath, [
      CLI_PATH,
      "--game", game.key,
      "--pre", prePath,
      "--post", postPath,
      "--button", "a",
      "--output", outputPath,
    ]);

    const transcript = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(transcript.schema, GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA);
    assert.equal(transcript.game.key, game.key);
    assert.equal(transcript.input.mode, "guest-consumed");
    assert.equal(
      transcript.input.guestConsumption.kind,
      "warioware-repellion-a-v1",
    );
    assert.equal(stdout, `${outputPath}\n`);

    const rejectedReports = makeWarioWareFirstPlayableReportPair(game);
    rejectedReports.postReport.guestGame.lastActiveGameplayInput = null;
    await Promise.all([
      writeFile(
        prePath,
        `${JSON.stringify(rejectedReports.preReport)}\n`,
        "utf8",
      ),
      writeFile(
        postPath,
        `${JSON.stringify(rejectedReports.postReport)}\n`,
        "utf8",
      ),
    ]);
    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH,
        "--game", game.key,
        "--pre", prePath,
        "--post", postPath,
        "--button", "a",
        "--output", outputPath,
      ]),
      /lastActiveGameplayInput.*expected an object/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(outputPath, "utf8")),
      transcript,
      "rejected evidence must not replace the prior transcript",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
