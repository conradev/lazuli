#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";
import {
  deriveGameFirstPlayableTranscriptCore,
  verifyGameFirstPlayableTranscriptCore,
} from "./browser_game_first_playable_transcript_core.mjs";
import {
  projectWarioWareGuestConsumption,
} from "./browser_game_first_playable_warioware.mjs";
import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";
import {
  makeWarioWareFirstPlayableReportPair,
} from "./browser_game_first_playable_warioware_test_fixture.mjs";

test("Wario projector layers guest consumption onto the generic core", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(candidate => candidate.key === "warioware-usa");
  const reports = makeWarioWareFirstPlayableReportPair(game);
  const guestPublication =
    reports.postReport.guestGame.lastActiveGameplayInput.hostPublication;
  reports.postReport.controller.lastActiveHostPublication.pollIndex += 1;
  reports.postReport.controller.lastActiveHostPublication.scheduledCycle += 200;
  reports.postReport.controller.lastActiveHostPublication.observedCycle += 200;

  const transcript = deriveGameFirstPlayableTranscriptCore({
    button: "a",
    corpus,
    gameKey: game.key,
    guestProjector: projectWarioWareGuestConsumption,
    ...reports,
  });
  assert.equal(transcript.input.mode, "guest-consumed");
  assert.equal(
    transcript.input.guestConsumption.kind,
    "warioware-repellion-a-v1",
  );
  assert.equal(transcript.input.guestConsumption.activeMicrogameId, 0x63);
  assert.deepEqual(
    transcript.input.guestConsumption.baseline,
    {
      cycle: reports.preReport.cycles,
      runtime: "0x802ab420",
      gameplayButtonsAddress: "0x802f6580",
      buttons: 0,
      playerObject: "0x802a9000",
      playerObjectResult: 0,
    },
  );
  assert.equal(transcript.input.guestConsumption.buttons, 0x0100);
  assert.deepEqual(
    transcript.input.guestConsumption.hostPublication,
    guestPublication,
  );
  assert.ok(
    transcript.input.publication.pollIndex
      > transcript.input.guestConsumption.hostPublication.pollIndex,
  );
  assert.ok(
    transcript.reports.post.presentation.cycle
      >= transcript.input.guestConsumption.cycle,
  );
  assert.strictEqual(
    verifyGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: projectWarioWareGuestConsumption,
      transcript,
      ...reports,
    }),
    transcript,
  );
});

test("Wario projector fails closed for other corpus games", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(candidate => candidate.key === "luigis-mansion-usa");
  const reports = makeGameFirstPlayableReportPair(game);
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: projectWarioWareGuestConsumption,
      ...reports,
    }),
    /no guest-consumption projector is available/,
  );
});

test("Wario guest-consumption receipt fails closed independently", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(candidate => candidate.key === "warioware-usa");
  const cases = [
    {
      name: "baseline no-card flow",
      mutate({ preReport }) {
        preReport.guestGame.noCardFlowActive = true;
      },
      pattern: /preReport\.guestGame\.noCardFlowActive/,
    },
    {
      name: "baseline wrong microgame",
      mutate({ preReport }) {
        preReport.guestGame.activeMicrogameId = 0x62;
        preReport.guestGame.player0RepellionActive = false;
      },
      pattern: /preReport\.guestGame\.activeMicrogameId/,
    },
    {
      name: "baseline A already active",
      mutate({ preReport }) {
        preReport.guestGame.gameplayButtons = 0x0100;
        preReport.guestGame.aActive = true;
      },
      pattern: /preReport\.guestGame\.gameplayButtons.*A to be inactive/,
    },
    {
      name: "baseline player object absent",
      mutate({ preReport }) {
        preReport.guestGame.playerObject = null;
      },
      pattern: /preReport\.guestGame\.playerObject/,
    },
    {
      name: "baseline player object already resolved",
      mutate({ preReport }) {
        preReport.guestGame.playerObjectResult = 1;
      },
      pattern: /preReport\.guestGame\.playerObjectResult/,
    },
    {
      name: "terminal no-card flow",
      mutate({ postReport }) {
        postReport.guestGame.noCardFlowActive = true;
      },
      pattern: /postReport\.guestGame\.noCardFlowActive/,
    },
    {
      name: "missing guest latch",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput = null;
      },
      pattern: /lastActiveGameplayInput.*expected an object/,
    },
    {
      name: "extended guest latch",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.channel = 0;
      },
      pattern: /lastActiveGameplayInput\.\[keys\]/,
    },
    {
      name: "wrong microgame",
      mutate({ postReport }) {
        postReport.guestGame.activeMicrogameId = 0x62;
      },
      pattern: /guestGame\.activeMicrogameId/,
    },
    {
      name: "wrong guest buttons",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.buttons = 0;
      },
      pattern: /lastActiveGameplayInput\.buttons/,
    },
    {
      name: "unmapped runtime",
      mutate({ postReport }) {
        postReport.guestGame.runtime = null;
      },
      pattern: /guestGame\.runtime/,
    },
    {
      name: "unrelated host publication",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.hostPublication.sequence += 1;
        postReport.guestGame.lastActiveGameplayInput.controllerAppliedSequence += 1;
      },
      pattern: /hostPublication\.sequence/,
    },
    {
      name: "presentation before guest latch",
      mutate({ postReport }) {
        postReport.mmioState.viInterruptModel.lastHostPresentationCycle =
          postReport.guestGame.lastActiveGameplayInput.cycle - 1;
      },
      pattern: /guest input latch cycle/,
    },
  ];

  for (const { mutate, name, pattern } of cases) {
    const reports = makeWarioWareFirstPlayableReportPair(game);
    mutate(reports);
    assert.throws(
      () => deriveGameFirstPlayableTranscriptCore({
        button: "a",
        corpus,
        gameKey: game.key,
        guestProjector: projectWarioWareGuestConsumption,
        ...reports,
      }),
      pattern,
      name,
    );
  }
});
