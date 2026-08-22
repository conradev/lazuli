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
  projectMeleeGuestConsumption,
} from "./browser_game_first_playable_melee.mjs";
import {
  makeMeleeFirstPlayableReportPair,
} from "./browser_game_first_playable_melee_test_fixture.mjs";
import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

function meleeGame(corpus) {
  return corpus.games.find(
    candidate => candidate.key === "melee-usa-rev-2",
  );
}

function derive(corpus, game, reports) {
  return deriveGameFirstPlayableTranscript({
    button: "left",
    corpus,
    gameKey: game.key,
    ...reports,
  });
}

function relocateTerminalFighter(guest, entity, fighter) {
  const hex32 = value => `0x${value.toString(16).padStart(8, "0")}`;
  const lookup = guest.fighterLookup;
  lookup.entity = hex32(entity);
  lookup.classifierAddress = hex32(entity);
  lookup.processLinkAddress = hex32(entity + 2);
  lookup.processPriorityAddress = hex32(entity + 4);
  lookup.userDataKindAddress = hex32(entity + 7);
  lookup.fighterPointerAddress = hex32(entity + 0x2c);
  lookup.fighter = hex32(fighter);

  const state = guest.fighter;
  state.address = hex32(fighter);
  state.gobjAddress = hex32(fighter);
  state.gobj = hex32(entity);
  for (const [field, offset] of [
    ["kind", 4],
    ["playerId", 0x0c],
    ["motionId", 0x10],
    ["facingDirection", 0x2c],
    ["selfVelocityX", 0x80],
    ["position", 0xb0],
    ["previousPosition", 0xbc],
    ["positionDeltaX", 0xc8],
    ["groundOrAir", 0xe0],
    ["padPlayerId", 0x618],
    ["subColor", 0x61a],
  ]) {
    state[`${field}Address`] = hex32(fighter + offset);
  }
  for (const [field, offset] of [
    ["leftStickX", 0x620],
    ["leftStickY", 0x624],
    ["previousLeftStickX", 0x628],
    ["previousLeftStickY", 0x62c],
    ["heldInputs", 0x65c],
    ["pressedInputs", 0x668],
    ["releasedInputs", 0x66c],
  ]) {
    state.input[`${field}Address`] = hex32(fighter + offset);
  }
}

test("Melee projector proves an exact left edge moved the active-match fighter", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = meleeGame(corpus);
  const reports = makeMeleeFirstPlayableReportPair(game);
  const transcript = derive(corpus, game, reports);
  const consumption = transcript.input.guestConsumption;

  assert.equal(consumption.kind, "melee-active-match-left-v1");
  assert.equal(consumption.playerSlot, "0x80453080");
  assert.equal(consumption.transformedIndex, 0);
  assert.equal(consumption.entity, "0x80400000");
  assert.equal(consumption.fighter, "0x80410000");
  assert.deepEqual(consumption.baseline, {
    cycle: reports.preReport.cycles,
    joystickDirectionCount: 12,
    matchFrame: 120,
    motionId: 14,
    position: { x: 10, y: 20, z: 0 },
  });
  assert.deepEqual(consumption.receipt.position, { x: 9, y: 20, z: 0 });
  assert.equal(consumption.receipt.matchFrame, 121);
  assert.equal(consumption.receipt.joystickDirectionCount, 13);
  assert.equal(consumption.receipt.pad.buttons, 0x00040001);
  assert.equal(consumption.receipt.pad.trigger, 0x00040001);
  assert.equal(consumption.receipt.pad.rawStickX, -80);
  assert.equal(consumption.receipt.pad.normalizedStickX, -1);
  assert.equal(consumption.receipt.fighterInput.leftStickX, -1);
  assert.equal(consumption.receipt.fighterInput.heldInputs, 0x00040001);
  assert.equal(consumption.receipt.fighterInput.pressedInputs, 0x00040001);
  assert.deepEqual(consumption.post.position, { x: 8, y: 20, z: 0 });
  assert.deepEqual(consumption.movement, {
    horizontalDistanceSquared: 4,
    postLatchHorizontalDistanceSquared: 1,
    leftwardDistance: 2,
    postLatchLeftwardDistance: 1,
    terminalFrameHorizontalDistanceSquared: 0.25,
    terminalFrameLeftwardDistance: 0.5,
    selfVelocityX: -1,
    positionDeltaX: -0.5,
    yDelta: 0,
    zDelta: 0,
  });
  assert.ok(
    transcript.reports.post.presentation.cycle >= consumption.cycle,
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

  for (const matchFrame of [120, 122]) {
    const boundaryReports = makeMeleeFirstPlayableReportPair(game);
    boundaryReports.postReport.guestGame
      .lastActiveGameplayInput.matchFrame = matchFrame;
    assert.equal(
      derive(corpus, game, boundaryReports)
        .input.guestConsumption.receipt.matchFrame,
      matchFrame,
    );
  }

  const preIncrementReports = makeMeleeFirstPlayableReportPair(game);
  preIncrementReports.postReport.guestGame
    .lastActiveGameplayInput.joystickDirectionCount = 12;
  assert.equal(
    derive(corpus, game, preIncrementReports)
      .input.guestConsumption.receipt.joystickDirectionCount,
    12,
  );
});

test("Melee projector accepts an exact matching nonzero sub-color", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = meleeGame(corpus);
  const reports = makeMeleeFirstPlayableReportPair(game);
  for (const report of [reports.preReport, reports.postReport]) {
    report.guestGame.playerSlot.subColor = 3;
    report.guestGame.fighter.subColor = 3;
  }
  assert.equal(
    derive(corpus, game, reports).input.guestConsumption.kind,
    "melee-active-match-left-v1",
  );
});

test("Melee projector fails closed for another game, revision, or button", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = meleeGame(corpus);

  const other = corpus.games.find(candidate => candidate.key === "warioware-usa");
  const otherReports = makeGameFirstPlayableReportPair(other);
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: other.key,
      guestProjector: projectMeleeGuestConsumption,
      ...otherReports,
    }),
    /no guest-consumption projector is available/,
  );

  const revisionReports = makeMeleeFirstPlayableReportPair(game);
  assert.throws(
    () => projectMeleeGuestConsumption({
      button: "left",
      game: {
        ...game,
        disc: { ...game.disc, revision: 1 },
      },
      publication:
        revisionReports.postReport.controller.lastActiveHostPublication,
      ...revisionReports,
    }),
    /\$\.game\.disc\.revision/,
  );

  const buttonReports = makeMeleeFirstPlayableReportPair(game);
  buttonReports.postReport.headlessCapture.reuse.action.pulses[0].name = "right";
  buttonReports.postReport.controller.lastActiveHostPublication.buttons = 0x0002;
  assert.throws(
    () => deriveGameFirstPlayableTranscript({
      button: "right",
      corpus,
      gameKey: game.key,
      ...buttonReports,
    }),
    /\$\.button/,
  );
});

test("Melee active-match projection rejects every broken causal link", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = meleeGame(corpus);
  const cases = [
    {
      name: "wrong route mode",
      mutate({ preReport }) {
        preReport.guestGame.routing.currentMode = 1;
        preReport.guestGame.routing.versusMatchScene = false;
      },
      pattern: /preReport\.guestGame\.routing\.currentMode/,
    },
    {
      name: "pending route transition",
      mutate({ preReport }) {
        preReport.guestGame.routing.pending = 1;
        preReport.guestGame.routing.versusMatchScene = false;
      },
      pattern: /preReport\.guestGame\.routing\.pending/,
    },
    {
      name: "wrong scene record",
      mutate({ preReport }) {
        preReport.guestGame.routing.currentSceneInfo = "0x803dd9c4";
        preReport.guestGame.routing.exactSceneInfo = false;
        preReport.guestGame.routing.versusMatchScene = false;
      },
      pattern: /preReport\.guestGame\.routing\.currentSceneInfo/,
    },
    {
      name: "wrong scene load callback",
      mutate({ preReport }) {
        preReport.guestGame.routing.currentSceneLoadData = "0x80480534";
        preReport.guestGame.routing.exactSceneInfo = false;
        preReport.guestGame.routing.versusMatchScene = false;
      },
      pattern: /preReport\.guestGame\.routing\.currentSceneLoadData/,
    },
    {
      name: "match no longer in progress",
      mutate({ preReport }) {
        preReport.guestGame.match.state = 1;
        preReport.guestGame.match.inProgress = false;
        preReport.guestGame.activeMatch = false;
      },
      pattern: /preReport\.guestGame\.match\.state/,
    },
    {
      name: "match HUD disabled",
      mutate({ preReport }) {
        preReport.guestGame.match.hudEnabled = 0;
        preReport.guestGame.match.inProgress = false;
        preReport.guestGame.activeMatch = false;
      },
      pattern: /preReport\.guestGame\.match\.hudEnabled/,
    },
    {
      name: "pause transition active",
      mutate({ preReport }) {
        preReport.guestGame.match.pauseTimer = 1;
        preReport.guestGame.match.inProgress = false;
        preReport.guestGame.activeMatch = false;
      },
      pattern: /preReport\.guestGame\.match\.pauseTimer/,
    },
    {
      name: "actual pause byte active",
      mutate({ preReport }) {
        preReport.guestGame.match.pauseBits = 2;
        preReport.guestGame.match.inProgress = false;
        preReport.guestGame.activeMatch = false;
      },
      pattern: /preReport\.guestGame\.match\.pauseBits/,
    },
    {
      name: "no active opponent",
      mutate({ preReport }) {
        preReport.guestGame.opponents[0].state = 0;
        preReport.guestGame.opponents[0].active = false;
        preReport.guestGame.hasOpponent = false;
        preReport.guestGame.activeMatch = false;
      },
      pattern: /preReport\.guestGame\.hasOpponent|preReport\.guestGame\.opponents/,
    },
    {
      name: "player and fighter sub-color mismatch",
      mutate({ preReport }) {
        preReport.guestGame.playerSlot.subColor = 3;
      },
      pattern: /preReport\.guestGame\.fighter\.subColor/,
    },
    {
      name: "drifted entity pointer slot",
      mutate({ preReport }) {
        preReport.guestGame.fighterLookup.entityPointerAddress = "0x80453134";
      },
      pattern: /preReport\.guestGame\.fighterLookup\.entityPointerAddress/,
    },
    {
      name: "unmapped fighter GObj",
      mutate({ preReport }) {
        preReport.guestGame.fighterLookup.entity = "0x81800000";
      },
      pattern: /preReport\.guestGame\.fighterLookup\.entity/,
    },
    {
      name: "wrong GObj classifier",
      mutate({ preReport }) {
        preReport.guestGame.fighterLookup.classifier = 3;
      },
      pattern: /preReport\.guestGame\.fighterLookup\.classifier/,
    },
    {
      name: "wrong GObj process link",
      mutate({ preReport }) {
        preReport.guestGame.fighterLookup.processLink = 7;
      },
      pattern: /preReport\.guestGame\.fighterLookup\.processLink/,
    },
    {
      name: "wrong Fighter backpointer",
      mutate({ preReport }) {
        preReport.guestGame.fighter.gobj = "0x80400040";
      },
      pattern: /preReport\.guestGame\.fighter\.gobj/,
    },
    {
      name: "Fighter pointer and object disagree",
      mutate({ preReport }) {
        preReport.guestGame.fighterLookup.fighter = "0x80420000";
      },
      pattern: /preReport\.guestGame\.fighter\.address/,
    },
    {
      name: "non-neutral baseline pad",
      mutate({ preReport }) {
        preReport.guestGame.pad.buttons = 0x00040001;
        preReport.guestGame.pad.rawStickX = -80;
        preReport.guestGame.pad.normalizedStickX = -1;
        preReport.guestGame.neutralInput = false;
      },
      pattern: /preReport\.guestGame\.neutralInput/,
    },
    {
      name: "airborne baseline",
      mutate({ preReport }) {
        preReport.guestGame.fighter.groundOrAir = 1;
      },
      pattern: /preReport\.guestGame\.fighter\.groundOrAir/,
    },
    {
      name: "dead baseline motion",
      mutate({ preReport }) {
        preReport.guestGame.fighter.motionId = 3;
        preReport.guestGame.fighter.aliveMotion = false;
      },
      pattern: /preReport\.guestGame\.fighter\.motionId/,
    },
    {
      name: "baseline is not Wait",
      mutate({ preReport }) {
        preReport.guestGame.fighter.motionId = 15;
      },
      pattern: /preReport\.guestGame\.fighter\.motionId/,
    },
    {
      name: "receipt is damage hitstun rather than controllable locomotion",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.motionId = 75;
      },
      pattern: /lastActiveGameplayInput\.motionId/,
    },
    {
      name: "terminal Fighter is in damage hitstun",
      mutate({ postReport }) {
        postReport.guestGame.fighter.motionId = 75;
      },
      pattern: /postReport\.guestGame\.fighter\.motionId/,
    },
    {
      name: "baseline already retained an edge",
      mutate({ preReport, postReport }) {
        preReport.guestGame.lastActiveGameplayInput = {
          ...postReport.guestGame.lastActiveGameplayInput,
        };
      },
      pattern: /preReport\.guestGame\.lastActiveGameplayInput/,
    },
    {
      name: "missing retained edge",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput = null;
      },
      pattern: /lastActiveGameplayInput.*expected an object/,
    },
    {
      name: "stale held pad without trigger edge",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.trigger = 0;
      },
      pattern: /lastActiveGameplayInput\.pad\.trigger/,
    },
    {
      name: "receipt pad omits the exact held-left mask",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.buttons = 0x00040000;
      },
      pattern: /lastActiveGameplayInput\.pad\.buttons/,
    },
    {
      name: "receipt raw X is not the exact retail left value",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.rawStickX = -79;
      },
      pattern: /lastActiveGameplayInput\.pad\.rawStickX/,
    },
    {
      name: "receipt raw input has a vertical component",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.rawStickY = 1;
      },
      pattern: /lastActiveGameplayInput\.pad\.rawStickY/,
    },
    {
      name: "receipt normalized input has a vertical component",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.normalizedStickY = 0.1;
      },
      pattern: /lastActiveGameplayInput\.pad\.normalizedStickY/,
    },
    {
      name: "receipt pad reports an error",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.pad.error = 1;
      },
      pattern: /lastActiveGameplayInput\.pad\.error/,
    },
    {
      name: "stale Fighter input without pressed edge",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .fighterInput.pressedInputs = 0;
      },
      pattern: /lastActiveGameplayInput\.fighterInput\.pressedInputs/,
    },
    {
      name: "Fighter does not hold the exact left mask",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .fighterInput.heldInputs = 0x00040000;
      },
      pattern: /lastActiveGameplayInput\.fighterInput\.heldInputs/,
    },
    {
      name: "wrong normalized pad value",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .pad.normalizedStickX = -0.75;
      },
      pattern: /lastActiveGameplayInput\.pad\.normalizedStickX/,
    },
    {
      name: "pad and Fighter normalized X disagree",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .fighterInput.leftStickX = -0.75;
      },
      pattern: /lastActiveGameplayInput\.fighterInput\.leftStickX/,
    },
    {
      name: "vertical Fighter input",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .fighterInput.leftStickY = 0.1;
      },
      pattern: /lastActiveGameplayInput\.fighterInput\.leftStickY/,
    },
    {
      name: "receipt before baseline cycle",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          preReport.cycles - 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "receipt after terminal cycle",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          postReport.cycles + 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "reversed publication chronology",
      mutate({ postReport }) {
        const publication =
          postReport.guestGame.lastActiveGameplayInput.hostPublication;
        publication.scheduledCycle = publication.observedCycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "publication observed after receipt",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.observedCycle = receipt.cycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "stale host poll",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.pollIndex = preReport.controller.pollIndex;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.pollIndex/,
    },
    {
      name: "stale host sequence",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.hostPublication.sequence -= 1;
        postReport.guestGame.lastActiveGameplayInput.controllerAppliedSequence -= 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.sequence/,
    },
    {
      name: "controller sequence was not applied",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .controllerAppliedSequence += 1;
      },
      pattern: /lastActiveGameplayInput\.controllerAppliedSequence/,
    },
    {
      name: "receipt match frame predates baseline",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.matchFrame = 119;
      },
      pattern: /lastActiveGameplayInput\.matchFrame/,
    },
    {
      name: "receipt match frame follows terminal",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.matchFrame = 123;
      },
      pattern: /lastActiveGameplayInput\.matchFrame/,
    },
    {
      name: "terminal frame did not advance",
      mutate({ postReport }) {
        postReport.guestGame.match.frameCount = 120;
      },
      pattern: /postReport\.guestGame\.match\.frameCount/,
    },
    {
      name: "terminal joystick count did not advance exactly once",
      mutate({ postReport }) {
        postReport.guestGame.playerSlot.joystickDirectionCount = 14;
      },
      pattern: /postReport\.guestGame\.playerSlot\.joystickDirectionCount/,
    },
    {
      name: "receipt joystick count skips an input",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .joystickDirectionCount = 14;
      },
      pattern: /lastActiveGameplayInput\.joystickDirectionCount/,
    },
    {
      name: "transformed player changed",
      mutate({ postReport }) {
        postReport.guestGame.playerSlot.transformedIndex = 1;
        postReport.guestGame.playerSlot.joystickDirectionCountAddress =
          "0x80453124";
        postReport.guestGame.fighterLookup.entityPointerAddress =
          "0x80453134";
      },
      pattern: /postReport\.guestGame\.playerSlot\.transformedIndex/,
    },
    {
      name: "terminal entity and Fighter change coherently",
      mutate({ postReport }) {
        relocateTerminalFighter(
          postReport.guestGame,
          0x80401000,
          0x80420000,
        );
      },
      pattern: /postReport\.guestGame\.fighterLookup\.entity/,
    },
    {
      name: "receipt names another entity",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.entity = "0x80401000";
      },
      pattern: /lastActiveGameplayInput\.entity/,
    },
    {
      name: "receipt names another Fighter",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.fighter = "0x80420000";
      },
      pattern: /lastActiveGameplayInput\.fighter/,
    },
    {
      name: "receipt moved right of baseline",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.position.x = 11;
      },
      pattern: /lastActiveGameplayInput\.position\.x/,
    },
    {
      name: "terminal movement is rightward",
      mutate({ postReport }) {
        postReport.guestGame.fighter.position.x = 11;
      },
      pattern: /postReport\.guestGame\.fighter\.position\.x/,
    },
    {
      name: "only Y movement",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput.position = {
          ...preReport.guestGame.fighter.position,
          y: preReport.guestGame.fighter.position.y + 1,
        };
        postReport.guestGame.fighter.position = {
          ...preReport.guestGame.fighter.position,
          y: preReport.guestGame.fighter.position.y + 2,
        };
      },
      pattern: /lastActiveGameplayInput\.position\.y|fighter\.position\.y/,
    },
    {
      name: "only Z movement",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput.position = {
          ...preReport.guestGame.fighter.position,
          z: preReport.guestGame.fighter.position.z + 1,
        };
        postReport.guestGame.fighter.position = {
          ...preReport.guestGame.fighter.position,
          z: preReport.guestGame.fighter.position.z + 2,
        };
      },
      pattern: /lastActiveGameplayInput\.position\.z|fighter\.position\.z/,
    },
    {
      name: "movement stops at the receipt",
      mutate({ postReport }) {
        postReport.guestGame.fighter.position = {
          ...postReport.guestGame.lastActiveGameplayInput.position,
        };
      },
      pattern: /strictly leftward X movement after the retained receipt/,
    },
    {
      name: "post-receipt movement is absent despite pre-to-receipt movement",
      mutate({ postReport }) {
        const receipt =
          postReport.guestGame.lastActiveGameplayInput.position;
        postReport.guestGame.fighter.position.x = receipt.x;
      },
      pattern: /strictly leftward X movement after the retained receipt/,
    },
    {
      name: "total left movement is below squared threshold",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.position.x = 9.997;
        postReport.guestGame.fighter.position.x = 9.995;
      },
      pattern: /strictly leftward X movement from the neutral baseline/,
    },
    {
      name: "post-receipt movement is below squared threshold",
      mutate({ postReport }) {
        postReport.guestGame.fighter.position.x = 8.995;
      },
      pattern: /strictly leftward X movement after the retained receipt/,
    },
    {
      name: "terminal frame moves right despite leftward endpoints",
      mutate({ postReport }) {
        postReport.guestGame.fighter.previousPosition.x = 7.5;
      },
      pattern: /fighter\.previousPosition\.x/,
    },
    {
      name: "terminal frame changes Y instead of staying horizontal",
      mutate({ postReport }) {
        postReport.guestGame.fighter.previousPosition.y = 19.5;
      },
      pattern: /fighter\.previousPosition\.y/,
    },
    {
      name: "terminal frame movement is below squared threshold",
      mutate({ postReport }) {
        postReport.guestGame.fighter.previousPosition.x = 8.005;
      },
      pattern: /fighter\.previousPosition\.x/,
    },
    {
      name: "terminal self velocity points right",
      mutate({ postReport }) {
        postReport.guestGame.fighter.selfVelocityX = 3;
      },
      pattern: /fighter\.selfVelocityX/,
    },
    {
      name: "terminal Fighter position delta points right",
      mutate({ postReport }) {
        postReport.guestGame.fighter.positionDeltaX = 3;
      },
      pattern: /fighter\.positionDeltaX/,
    },
    {
      name: "presentation predates retained receipt",
      mutate({ postReport }) {
        postReport.mmioState.viInterruptModel.lastHostPresentationCycle =
          postReport.guestGame.lastActiveGameplayInput.cycle - 1;
      },
      pattern: /guest input latch cycle/,
    },
  ];

  for (const { mutate, name, pattern } of cases) {
    const reports = makeMeleeFirstPlayableReportPair(game);
    mutate(reports);
    assert.throws(
      () => derive(corpus, game, reports),
      pattern,
      name,
    );
  }
});
