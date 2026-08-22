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
  projectWindWakerGuestConsumption,
} from "./browser_game_first_playable_wind_waker.mjs";
import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";
import {
  makeWindWakerFirstPlayableReportPair,
} from "./browser_game_first_playable_wind_waker_test_fixture.mjs";

test("Wind Waker projector proves consumed left input moved Outset player", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(
    candidate => candidate.key === "wind-waker-usa",
  );
  const reports = makeWindWakerFirstPlayableReportPair(game);
  const transcript = deriveGameFirstPlayableTranscript({
    button: "left",
    corpus,
    gameKey: game.key,
    ...reports,
  });

  assert.equal(
    transcript.input.guestConsumption.kind,
    "wind-waker-outset-left-v1",
  );
  assert.equal(transcript.input.guestConsumption.stage, "sea");
  assert.equal(transcript.input.guestConsumption.room, 44);
  assert.deepEqual(
    transcript.input.guestConsumption.baseline.position,
    { x: 10, y: 0, z: 20 },
  );
  assert.deepEqual(
    transcript.input.guestConsumption.receipt.position,
    { x: 9, y: 0, z: 20 },
  );
  assert.deepEqual(
    transcript.input.guestConsumption.post.position,
    { x: 8, y: 0, z: 20 },
  );
  assert.equal(
    transcript.input.guestConsumption.movement.planarDistanceSquared,
    4,
  );
  assert.equal(
    transcript.input.guestConsumption.movement.postLatchPlanarDistanceSquared,
    1,
  );
  assert.equal(transcript.input.guestConsumption.movement.headingDelta, 0x100);
  assert.equal(transcript.input.guestConsumption.receipt.hold, 0x8000);
  assert.equal(transcript.input.guestConsumption.receipt.mainStickX, -1);
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

test("Wind Waker projector fails closed for other corpus games", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(candidate => candidate.key === "warioware-usa");
  const reports = makeGameFirstPlayableReportPair(game);
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: projectWindWakerGuestConsumption,
      ...reports,
    }),
    /no guest-consumption projector is available/,
  );
});

test("Wind Waker projector accepts only the modeled left input", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(
    candidate => candidate.key === "wind-waker-usa",
  );
  const reports = makeWindWakerFirstPlayableReportPair(game);
  reports.postReport.headlessCapture.reuse.action.pulses[0].name = "right";
  reports.postReport.controller.lastActiveHostPublication.buttons = 0x0002;
  assert.throws(
    () => deriveGameFirstPlayableTranscript({
      button: "right",
      corpus,
      gameKey: game.key,
      ...reports,
    }),
    /\$\.button/,
  );
});

test("Wind Waker guest movement rejects every missing causal link", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games.find(
    candidate => candidate.key === "wind-waker-usa",
  );
  const cases = [
    {
      name: "wrong stage",
      mutate({ preReport }) {
        preReport.guestGame.currentStage.name = "A_nami";
        preReport.guestGame.stageActive = false;
      },
      pattern: /preReport\.guestGame\.currentStage\.name/,
    },
    {
      name: "drifted stage address",
      mutate({ preReport }) {
        preReport.guestGame.currentStage.address = "0x803c9d40";
      },
      pattern: /preReport\.guestGame\.currentStage\.address/,
    },
    {
      name: "wrong current room",
      mutate({ preReport }) {
        preReport.guestGame.currentStage.room = 43;
        preReport.guestGame.stageActive = false;
      },
      pattern: /preReport\.guestGame\.currentStage\.room/,
    },
    {
      name: "active event",
      mutate({ preReport }) {
        preReport.guestGame.eventMode = 1;
        preReport.guestGame.eventInactive = false;
      },
      pattern: /preReport\.guestGame\.eventMode/,
    },
    {
      name: "menu open",
      mutate({ preReport }) {
        preReport.guestGame.menuPause = 1;
        preReport.guestGame.menuClosed = false;
      },
      pattern: /preReport\.guestGame\.menuPause/,
    },
    {
      name: "mismatched controlled player",
      mutate({ preReport }) {
        preReport.guestGame.playerLookup.linkPlayer = "0x80410000";
        preReport.guestGame.playerLookup.pointersMatch = false;
      },
      pattern: /preReport\.guestGame\.playerLookup\.linkPlayer/,
    },
    {
      name: "unmapped controlled player",
      mutate({ preReport }) {
        preReport.guestGame.playerLookup.player = "0x81800000";
        preReport.guestGame.playerLookup.linkPlayer = "0x81800000";
        preReport.guestGame.player.address = "0x81800000";
      },
      pattern: /preReport\.guestGame\.playerLookup\.player/,
    },
    {
      name: "wrong player process",
      mutate({ preReport }) {
        preReport.guestGame.player.processName = 0x00aa;
        preReport.guestGame.player.valid = false;
      },
      pattern: /preReport\.guestGame\.player\.processName/,
    },
    {
      name: "wrong player profile",
      mutate({ preReport }) {
        preReport.guestGame.player.profile = "0x8038fd90";
        preReport.guestGame.player.valid = false;
      },
      pattern: /preReport\.guestGame\.player\.profile/,
    },
    {
      name: "drifted player position address",
      mutate({ preReport }) {
        preReport.guestGame.player.positionAddress = "0x804001fc";
      },
      pattern: /preReport\.guestGame\.player\.positionAddress/,
    },
    {
      name: "player paused",
      mutate({ preReport }) {
        preReport.guestGame.player.pauseFlag = 1;
        preReport.guestGame.controlsEnabled = false;
        preReport.guestGame.controllableOutset = false;
      },
      pattern: /preReport\.guestGame\.player\.pauseFlag/,
    },
    {
      name: "controller error",
      mutate({ preReport }) {
        preReport.guestGame.pad.error = 1;
        preReport.guestGame.controlsEnabled = false;
        preReport.guestGame.controllableOutset = false;
      },
      pattern: /preReport\.guestGame\.pad\.error/,
    },
    {
      name: "drifted pad hold address",
      mutate({ preReport }) {
        preReport.guestGame.pad.holdAddress = "0x803a4e1e";
      },
      pattern: /preReport\.guestGame\.pad\.holdAddress/,
    },
    {
      name: "non-neutral baseline",
      mutate({ preReport }) {
        preReport.guestGame.pad.hold = 0x8000;
        preReport.guestGame.pad.mainStickX = -1;
        preReport.guestGame.pad.mainStickValue = 1;
        preReport.guestGame.neutralInput = false;
      },
      pattern: /preReport\.guestGame\.neutralInput/,
    },
    {
      name: "inconsistent post neutral predicate",
      mutate({ postReport }) {
        postReport.guestGame.neutralInput = false;
      },
      pattern: /postReport\.guestGame\.neutralInput/,
    },
    {
      name: "baseline already has a receipt",
      mutate({ preReport, postReport }) {
        preReport.guestGame.lastActiveGameplayInput = {
          ...postReport.guestGame.lastActiveGameplayInput,
        };
      },
      pattern: /preReport\.guestGame\.lastActiveGameplayInput/,
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
      name: "wrong guest hold",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.hold = 0;
      },
      pattern: /lastActiveGameplayInput\.pad\.hold/,
    },
    {
      name: "guest hold has an extra button",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.hold = 0x8001;
      },
      pattern: /lastActiveGameplayInput\.pad\.hold/,
    },
    {
      name: "wrong stick direction",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.mainStickX = 1;
      },
      pattern: /lastActiveGameplayInput\.pad\.mainStickX/,
    },
    {
      name: "out-of-range left stick",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.mainStickX = -1.5;
      },
      pattern: /lastActiveGameplayInput\.pad\.mainStickX/,
    },
    {
      name: "vertical stick",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.mainStickY = 0.5;
      },
      pattern: /lastActiveGameplayInput\.pad\.mainStickY/,
    },
    {
      name: "weak stick",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.mainStickValue = 0.25;
      },
      pattern: /lastActiveGameplayInput\.pad\.mainStickValue/,
    },
    {
      name: "out-of-range stick magnitude",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.mainStickValue = 1.5;
      },
      pattern: /lastActiveGameplayInput\.pad\.mainStickValue/,
    },
    {
      name: "receipt from another stage",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.stage = "A_nami";
      },
      pattern: /lastActiveGameplayInput\.stage/,
    },
    {
      name: "receipt from another room",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.room = 43;
      },
      pattern: /lastActiveGameplayInput\.room/,
    },
    {
      name: "receipt from another player",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.player = "0x80401000";
      },
      pattern: /lastActiveGameplayInput\.player/,
    },
    {
      name: "receipt before the baseline",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          preReport.cycles - 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "receipt after the terminal report",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          postReport.cycles + 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "unsupported publication source",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.hostPublication.source =
          "other";
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.source/,
    },
    {
      name: "reversed publication timing",
      mutate({ postReport }) {
        const publication =
          postReport.guestGame.lastActiveGameplayInput.hostPublication;
        publication.scheduledCycle = publication.observedCycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "publication observed after the receipt",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.observedCycle = receipt.cycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "publication did not advance the baseline poll",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.pollIndex = preReport.controller.pollIndex;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.pollIndex/,
    },
    {
      name: "controller did not apply the retained sequence",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .controllerAppliedSequence += 1;
      },
      pattern: /lastActiveGameplayInput\.controllerAppliedSequence/,
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
      name: "receipt publication follows the terminal publication",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.pollIndex =
            postReport.controller.lastActiveHostPublication.pollIndex + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "player object changed",
      mutate({ postReport }) {
        postReport.guestGame.player.address = "0x80401000";
      },
      pattern: /postReport\.guestGame\.player\.(processNameAddress|address)/,
    },
    {
      name: "non-finite player position",
      mutate({ postReport }) {
        postReport.guestGame.player.position.x = Number.NaN;
      },
      pattern: /guestGame\.player\.position\.x.*finite/,
    },
    {
      name: "unchanged player position",
      mutate({ preReport, postReport }) {
        postReport.guestGame.player.position = {
          ...preReport.guestGame.player.position,
        };
      },
      pattern: /causal player-position change/,
    },
    {
      name: "vertical settling only",
      mutate({ preReport, postReport }) {
        postReport.guestGame.player.position = {
          ...preReport.guestGame.player.position,
          y: preReport.guestGame.player.position.y + 1,
        };
      },
      pattern: /causal player-position change/,
    },
    {
      name: "movement below the planar threshold",
      mutate({ preReport, postReport }) {
        postReport.guestGame.player.position = {
          ...preReport.guestGame.player.position,
          x: preReport.guestGame.player.position.x + 0.009,
        };
      },
      pattern: /causal player-position change/,
    },
    {
      name: "overflowing synthetic player displacement",
      mutate({ postReport }) {
        postReport.guestGame.player.position.x = Number.MAX_VALUE;
      },
      pattern: /causal player-position change/,
    },
    {
      name: "movement stopped at the receipt",
      mutate({ postReport }) {
        postReport.guestGame.player.position = {
          ...postReport.guestGame.lastActiveGameplayInput.position,
        };
      },
      pattern: /movement after the retained guest-input receipt/,
    },
    {
      name: "post-receipt movement below the planar threshold",
      mutate({ postReport }) {
        postReport.guestGame.player.position = {
          ...postReport.guestGame.lastActiveGameplayInput.position,
          x: postReport.guestGame.lastActiveGameplayInput.position.x + 0.009,
        };
      },
      pattern: /movement after the retained guest-input receipt/,
    },
    {
      name: "vertical settling after the receipt only",
      mutate({ postReport }) {
        postReport.guestGame.player.position = {
          ...postReport.guestGame.lastActiveGameplayInput.position,
          y: postReport.guestGame.lastActiveGameplayInput.position.y + 1,
        };
      },
      pattern: /movement after the retained guest-input receipt/,
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
    const reports = makeWindWakerFirstPlayableReportPair(game);
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
