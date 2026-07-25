#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";
import {
  deriveGameFirstPlayableTranscriptCore,
} from "./browser_game_first_playable_transcript_core.mjs";
import {
  deriveGameFirstPlayableTranscript,
  verifyGameFirstPlayableTranscript,
} from "./browser_game_first_playable_transcript.mjs";
import {
  projectLuigisMansionGuestConsumption,
} from "./browser_game_first_playable_luigi.mjs";
import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";
import {
  makeLuigisMansionFirstPlayableReportPair,
} from "./browser_game_first_playable_luigi_test_fixture.mjs";

test("Luigi projector proves a consumed left input changed foyer player state", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(
    candidate => candidate.key === "luigis-mansion-usa",
  );
  const reports = makeLuigisMansionFirstPlayableReportPair(game);
  const transcript = deriveGameFirstPlayableTranscript({
    button: "left",
    corpus,
    gameKey: game.key,
    ...reports,
  });

  assert.equal(
    transcript.input.guestConsumption.kind,
    "luigis-mansion-foyer-left-v1",
  );
  assert.equal(transcript.input.guestConsumption.roomInfo, "0x02000102");
  assert.deepEqual(
    transcript.input.guestConsumption.baseline.position,
    { x: 10, y: 0, z: 20 },
  );
  assert.deepEqual(
    transcript.input.guestConsumption.post.position,
    { x: 12, y: 0, z: 20 },
  );
  assert.equal(transcript.input.guestConsumption.movement.distanceSquared, 4);
  assert.equal(
    transcript.input.guestConsumption.movement.postLatchDistanceSquared,
    1,
  );
  assert.equal(transcript.input.guestConsumption.receipt.held, 0x01000001);
  assert.equal(transcript.input.guestConsumption.receipt.controllerMagnitude, 1);
  assert.ok(
    transcript.reports.post.presentation.cycle
      >= transcript.input.guestConsumption.cycle,
  );
  assert.strictEqual(
    verifyGameFirstPlayableTranscript({
      button: "left",
      corpus,
      gameKey: game.key,
      transcript,
      ...reports,
    }),
    transcript,
  );
});

test("Luigi projector fails closed for other corpus games", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(candidate => candidate.key === "warioware-usa");
  const reports = makeGameFirstPlayableReportPair(game);
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: projectLuigisMansionGuestConsumption,
      ...reports,
    }),
    /no guest-consumption projector is available/,
  );
});

test("Luigi guest-consumption evidence rejects every missing causal link", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(
    candidate => candidate.key === "luigis-mansion-usa",
  );
  const cases = [
    {
      name: "wrong scene",
      mutate({ preReport }) {
        preReport.guestGame.sceneId = 1;
        preReport.guestGame.mainGameScene = false;
      },
      pattern: /preReport\.guestGame\.sceneId/,
    },
    {
      name: "menu open",
      mutate({ preReport }) {
        preReport.guestGame.menuMode = 1;
        preReport.guestGame.menuClosed = false;
      },
      pattern: /preReport\.guestGame\.menuMode/,
    },
    {
      name: "event active",
      mutate({ preReport }) {
        preReport.guestGame.executingEvent = "0x80400000";
        preReport.guestGame.eventInactive = false;
      },
      pattern: /preReport\.guestGame\.executingEvent/,
    },
    {
      name: "wrong map",
      mutate({ preReport }) {
        preReport.guestGame.openMapId = 3;
        preReport.guestGame.mansionOpen = false;
      },
      pattern: /preReport\.guestGame\.openMapId/,
    },
    {
      name: "not the exact foyer",
      mutate({ preReport }) {
        preReport.guestGame.currentRoomInfo = "0x02000103";
        preReport.guestGame.foyerActive = false;
      },
      pattern: /preReport\.guestGame\.currentRoomInfo/,
    },
    {
      name: "wrong player vtable",
      mutate({ preReport }) {
        preReport.guestGame.player.vtable = "0x80359d4c";
        preReport.guestGame.player.valid = false;
      },
      pattern: /preReport\.guestGame\.player\.vtable/,
    },
    {
      name: "controller input lock",
      mutate({ preReport }) {
        preReport.guestGame.controller.inputSource = null;
        preReport.guestGame.controlsEnabled = false;
        preReport.guestGame.controllableFoyer = false;
      },
      pattern: /preReport\.guestGame\.controller\.inputSource/,
    },
    {
      name: "non-neutral baseline",
      mutate({ preReport }) {
        preReport.guestGame.pad.held = 0x01000001;
        preReport.guestGame.pad.mainStickX = -1;
        preReport.guestGame.pad.mainStickValue = 1;
        preReport.guestGame.controller.mainStickMagnitude = 1;
        preReport.guestGame.neutralInput = false;
      },
      pattern: /preReport\.guestGame\.neutralInput/,
    },
    {
      name: "missing receipt",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput = null;
      },
      pattern: /lastActiveGameplayInput.*expected an object/,
    },
    {
      name: "extended receipt",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.channel = 0;
      },
      pattern: /lastActiveGameplayInput\.\[keys\]/,
    },
    {
      name: "D-pad without decoded main stick",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.held = 0x00000001;
      },
      pattern: /lastActiveGameplayInput\.pad\.held/,
    },
    {
      name: "wrong stick direction",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.mainStickX = 1;
      },
      pattern: /lastActiveGameplayInput\.pad\.mainStickX/,
    },
    {
      name: "PlayerController did not consume the stick",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .controller.mainStickMagnitude = 0;
      },
      pattern: /lastActiveGameplayInput\.controller\.mainStickMagnitude/,
    },
    {
      name: "wrong PlayerController source",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.controller.inputSource =
          "0x80410004";
      },
      pattern: /lastActiveGameplayInput\.controller\.inputSource/,
    },
    {
      name: "stale host sequence",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.hostPublication.sequence += 1;
        postReport.guestGame.lastActiveGameplayInput.controllerAppliedSequence += 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.sequence/,
    },
    {
      name: "player object changed",
      mutate({ postReport }) {
        postReport.guestGame.player.address = "0x80401000";
      },
      pattern: /postReport\.guestGame\.player\.(positionAddress|vtableAddress|address)/,
    },
    {
      name: "non-finite player position",
      mutate({ postReport }) {
        postReport.guestGame.currentPlayerPosition.x = Number.NaN;
      },
      pattern: /guestGame\.currentPlayerPosition\.x.*non-finite/,
    },
    {
      name: "unchanged player position",
      mutate({ preReport, postReport }) {
        postReport.guestGame.currentPlayerPosition = {
          ...preReport.guestGame.currentPlayerPosition,
        };
        postReport.guestGame.player.position = {
          ...preReport.guestGame.player.position,
        };
      },
      pattern: /causal player-position change/,
    },
    {
      name: "movement stopped at the receipt",
      mutate({ postReport }) {
        postReport.guestGame.currentPlayerPosition = {
          ...postReport.guestGame.lastActiveGameplayInput.position,
        };
        postReport.guestGame.player.position = {
          ...postReport.guestGame.lastActiveGameplayInput.position,
        };
      },
      pattern: /movement after the retained guest-input receipt/,
    },
    {
      name: "global position diverged from Player",
      mutate({ postReport }) {
        postReport.guestGame.player.position.x += 1;
      },
      pattern: /postReport\.guestGame\.player\.position\.x/,
    },
    {
      name: "presentation before receipt",
      mutate({ postReport }) {
        postReport.mmioState.viInterruptModel.lastHostPresentationCycle =
          postReport.guestGame.lastActiveGameplayInput.cycle - 1;
      },
      pattern: /guest input latch cycle/,
    },
  ];

  for (const { mutate, name, pattern } of cases) {
    const reports = makeLuigisMansionFirstPlayableReportPair(game);
    mutate(reports);
    assert.throws(
      () => deriveGameFirstPlayableTranscript({
        button: "left",
        corpus,
        gameKey: game.key,
        ...reports,
      }),
      pattern,
      name,
    );
  }
});
