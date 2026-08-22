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
  projectMetroidPrimeGuestConsumption,
} from "./browser_game_first_playable_metroid_prime.mjs";
import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";
import {
  makeMetroidPrimeFirstPlayableReportPair,
} from "./browser_game_first_playable_metroid_prime_test_fixture.mjs";

function metroidPrimeGame(corpus) {
  return corpus.games.find(
    candidate => candidate.key === "metroid-prime-usa-rev-2",
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

function project(game, reports, button = "left") {
  return projectMetroidPrimeGuestConsumption({
    button,
    game,
    publication: reports.postReport.controller.lastActiveHostPublication,
    ...reports,
  });
}

function getPath(value, path) {
  return path.split(".").reduce((current, field) => current[field], value);
}

function setPath(value, path, replacement) {
  const fields = path.split(".");
  const field = fields.pop();
  const parent = fields.reduce((current, name) => current[name], value);
  parent[field] = replacement;
}

function driftHexAddress(value, path) {
  const current = getPath(value, path);
  setPath(
    value,
    path,
    `0x${(Number.parseInt(current.slice(2), 16) + 4)
      .toString(16)
      .padStart(8, "0")}`,
  );
}

function pathPattern(report, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${report}\\.guestGame\\.${escaped}`);
}

function assertRejectedCases(game, cases) {
  for (const { mutate, name, pattern } of cases) {
    const reports = makeMetroidPrimeFirstPlayableReportPair(game);
    mutate(reports);
    assert.throws(() => project(game, reports), pattern, name);
  }
}

function setPostOrientation(postReport, angle) {
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  postReport.guestGame.player.transform.right = {
    x: -sine,
    y: cosine,
    z: 0,
  };
  postReport.guestGame.player.transform.forward = {
    x: -cosine,
    y: -sine,
    z: 0,
  };
}

function relocateWorld(guest, address) {
  const hex = value => `0x${value.toString(16).padStart(8, "0")}`;
  guest.manager.world = hex(address);
  guest.world.address = hex(address);
  guest.world.assetIdAddress = hex(address + 8);
  guest.world.areaAddress = hex(address + 0x68);
}

function relocateCameraManager(guest, address) {
  const hex = value => `0x${value.toString(16).padStart(8, "0")}`;
  guest.manager.cameraManager = hex(address);
  guest.camera.manager = hex(address);
  guest.camera.currentIdAddress = hex(address);
  guest.camera.cinematicCountAddress = hex(address + 8);
  guest.camera.firstPersonPointerAddress = hex(address + 0x88);
}

function relocateFirstPersonCamera(guest, address) {
  const hex = value => `0x${value.toString(16).padStart(8, "0")}`;
  guest.camera.firstPerson = hex(address);
  guest.camera.flagsAddress = hex(address + 0x180);
}

test("Metroid Prime projector proves retained GM8E01 Rev2 left turn", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = metroidPrimeGame(corpus);
  const reports = makeMetroidPrimeFirstPlayableReportPair(game);
  const transcript = derive(corpus, game, reports);
  const consumption = transcript.input.guestConsumption;

  assert.equal(
    consumption.kind,
    "metroid-prime-frigate-left-turn-v1",
  );
  assert.equal(consumption.manager, "0x8045b208");
  assert.equal(consumption.player, "0x8046c9e8");
  assert.equal(consumption.world, "0x80410000");
  assert.equal(consumption.worldAssetId, 0x158efe17);
  assert.equal(consumption.area, 0);
  assert.deepEqual(consumption.baseline.position, { x: 10, y: 20, z: 30 });
  assert.deepEqual(consumption.receipt.position, { x: 10, y: 20, z: 30 });
  assert.deepEqual(consumption.post.position, { x: 10, y: 20, z: 30 });
  assert.equal(consumption.baseline.input.neutral, true);
  assert.equal(consumption.receipt.input.leftX, -0.75);
  assert.equal(consumption.receipt.input.leftY, 0);
  assert.equal(consumption.receipt.input.rightX, 0);
  assert.equal(consumption.receipt.input.rightY, 0);
  assert.equal(consumption.receipt.input.buttons1, 0);
  assert.equal(consumption.receipt.input.buttons2, 0x20);
  assert.equal(consumption.receipt.input.buttons3, 0x02);
  assert.deepEqual(consumption.receipt.angularVelocity, { x: 0, y: 0, z: 0 });
  assert.deepEqual(consumption.receipt.torque, { x: 0, y: 0, z: 0 });
  assert.equal(consumption.turn.frameDelta, 3);
  assert.equal(consumption.turn.postLatchFrameDelta, 2);
  assert.ok(consumption.turn.forwardDelta > 1e-6);
  assert.ok(consumption.turn.forwardDeltaSquared > 0);
  assert.equal(consumption.hostPublication.buttons, 0x0001);
  assert.deepEqual(
    consumption.hostPublication,
    reports.postReport.controller.lastActiveHostPublication,
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

test("Metroid Prime projector is exact-game, exact-revision, and left-only", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = metroidPrimeGame(corpus);
  const reports = makeMetroidPrimeFirstPlayableReportPair(game);

  assert.throws(
    () => project(
      { ...game, disc: { ...game.disc, identifier: "GM8J01" } },
      reports,
    ),
    /\$\.game\.disc\.identifier/,
  );
  assert.throws(
    () => project(
      { ...game, disc: { ...game.disc, revision: 1 } },
      reports,
    ),
    /\$\.game\.disc\.revision/,
  );
  assert.throws(() => project(game, reports, "right"), /\$\.button/);

  const other = corpus.games.find(candidate => candidate.key === "warioware-usa");
  const otherReports = makeGameFirstPlayableReportPair(other);
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: other.key,
      guestProjector: projectMetroidPrimeGuestConsumption,
      ...otherReports,
    }),
    /no guest-consumption projector is available/,
  );
});

test("Metroid Prime projection locks every fixed Rev2 address schema", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = metroidPrimeGame(corpus);
  const addressPaths = [
    "identity.headerAddress",
    "manager.address",
    "manager.playerPointerAddress",
    "manager.player",
    "manager.worldPointerAddress",
    "manager.cameraManagerPointerAddress",
    "manager.playerStateRefDataPointerAddress",
    "manager.nextAreaAddress",
    "manager.inputFrameAddress",
    "manager.updateFrameAddress",
    "manager.gameStateAddress",
    "manager.initPhaseAddress",
    "world.assetIdAddress",
    "world.areaAddress",
    "camera.currentIdAddress",
    "camera.cinematicCountAddress",
    "camera.firstPersonPointerAddress",
    "camera.flagsAddress",
    "playerState.flagsAddress",
    "player.expectedAddress",
    "player.address",
    "player.areaAddress",
    "player.uniqueIdAddress",
    "player.entityFlagsAddress",
    "player.transform.address",
    "player.transform.rightAddresses.0",
    "player.transform.rightAddresses.1",
    "player.transform.rightAddresses.2",
    "player.transform.forwardAddresses.0",
    "player.transform.forwardAddresses.1",
    "player.transform.forwardAddresses.2",
    "player.transform.upAddresses.0",
    "player.transform.upAddresses.1",
    "player.transform.upAddresses.2",
    "player.transform.positionAddresses.0",
    "player.transform.positionAddresses.1",
    "player.transform.positionAddresses.2",
    "player.velocityAddress",
    "player.angularVelocityAddress",
    "player.torqueAddress",
    "player.movementStateAddress",
    "player.surfaceRestraintAddress",
    "player.cameraStateAddress",
    "player.morphStateAddress",
    "player.orbitStateAddress",
    "player.frozenTimeoutAddress",
    "player.controlsFrozenAddress",
    "player.inputFlagsAddress",
    "player.deathTimeAddress",
    "input.address",
  ];
  const cases = addressPaths.map(path => ({
    name: `drifted ${path}`,
    mutate({ preReport }) {
      driftHexAddress(preReport.guestGame, path);
    },
    pattern: pathPattern("preReport", path),
  }));
  cases.push(
    {
      name: "extended guest schema",
      mutate({ preReport }) {
        preReport.guestGame.channel = 0;
      },
      pattern: /preReport\.guestGame\.\[keys\]/,
    },
    {
      name: "extended identity schema",
      mutate({ preReport }) {
        preReport.guestGame.identity.region = "USA";
      },
      pattern: /preReport\.guestGame\.identity\.\[keys\]/,
    },
    {
      name: "extended vector schema",
      mutate({ preReport }) {
        preReport.guestGame.player.transform.forward.w = 0;
      },
      pattern: /preReport\.guestGame\.player\.transform\.forward\.\[keys\]/,
    },
    {
      name: "extended receipt schema",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.channel = 0;
      },
      pattern: /lastActiveGameplayInput\.\[keys\]/,
    },
    {
      name: "extended receipt input schema",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.previousLeftTrigger = 0;
      },
      pattern: /lastActiveGameplayInput\.input\.\[keys\]/,
    },
  );
  assertRejectedCases(game, cases);
});

test("Metroid Prime projection requires neutral baseline and retained live CFinalInput", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = metroidPrimeGame(corpus);
  const cases = [
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
      name: "baseline left stick is non-neutral",
      mutate({ preReport }) {
        const input = preReport.guestGame.input;
        input.leftX = -0.75;
        input.buttons2 = 0x20;
        input.buttons3 = 0x02;
        input.neutral = false;
        input.hostLeftRetained = true;
        preReport.guestGame.guestConsumedHostLeft = true;
      },
      pattern: /preReport\.guestGame\.input/,
    },
    {
      name: "baseline neutral predicate lies",
      mutate({ preReport }) {
        preReport.guestGame.input.neutral = false;
      },
      pattern: /preReport\.guestGame\.input\.neutral/,
    },
    {
      name: "baseline analog edge is not neutral",
      mutate({ preReport }) {
        preReport.guestGame.input.analogEdgeLeftX = 1;
      },
      pattern: /preReport\.guestGame\.input\.analogEdgeLeftX/,
    },
    {
      name: "missing retained receipt",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput = null;
      },
      pattern: /lastActiveGameplayInput.*expected an object/,
    },
    {
      name: "weak retained left",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.leftX = -0.49;
      },
      pattern: /lastActiveGameplayInput\.input\.leftX/,
    },
    {
      name: "wrong retained direction",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.leftX = 0.75;
      },
      pattern: /lastActiveGameplayInput\.input\.leftX/,
    },
    {
      name: "vertical input mixed into retained left",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.leftY = 0.126;
      },
      pattern: /lastActiveGameplayInput\.input\.leftY/,
    },
    {
      name: "camera input mixed into retained left",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.rightX = 0.126;
      },
      pattern: /lastActiveGameplayInput\.input\.rightX/,
    },
    {
      name: "trigger input mixed into retained left",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.leftTrigger = 0.1;
      },
      pattern: /lastActiveGameplayInput\.input\.leftTrigger/,
    },
    {
      name: "missing left held byte",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.buttons2 = 0;
      },
      pattern: /lastActiveGameplayInput\.input\.buttons2/,
    },
    {
      name: "unrelated retained button",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.buttons1 = 1;
      },
      pattern: /lastActiveGameplayInput\.input\.buttons1/,
    },
    {
      name: "invalid left edge byte",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.buttons3 = 4;
      },
      pattern: /lastActiveGameplayInput\.input\.buttons3/,
    },
    {
      name: "wrong retained controller",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.controllerIndex = 1;
      },
      pattern: /lastActiveGameplayInput\.input\.controllerIndex/,
    },
    {
      name: "non-finite retained input",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.leftX = Number.NaN;
      },
      pattern: /lastActiveGameplayInput\.input\.leftX.*finite/,
    },
  ];
  assertRejectedCases(game, cases);
});

test("Metroid Prime projection preserves world, player, lifecycle, and first-person camera", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = metroidPrimeGame(corpus);
  const cases = [
    {
      name: "coherently relocated world",
      mutate({ postReport }) {
        relocateWorld(postReport.guestGame, 0x80420000);
      },
      pattern: /postReport\.guestGame\.manager\.world/,
    },
    {
      name: "coherently relocated camera manager",
      mutate({ postReport }) {
        relocateCameraManager(postReport.guestGame, 0x80421000);
      },
      pattern: /postReport\.guestGame\.manager\.cameraManager/,
    },
    {
      name: "coherently relocated first-person camera",
      mutate({ postReport }) {
        relocateFirstPersonCamera(postReport.guestGame, 0x80422000);
      },
      pattern: /postReport\.guestGame\.camera\.firstPerson/,
    },
    {
      name: "changed player-state ref data",
      mutate({ postReport }) {
        postReport.guestGame.playerState.refData = "0x80423000";
      },
      pattern: /postReport\.guestGame\.playerState\.refData/,
    },
    {
      name: "changed player-state allocation",
      mutate({ postReport }) {
        postReport.guestGame.playerState.address = "0x80424000";
        postReport.guestGame.playerState.flagsAddress = "0x80424000";
      },
      pattern: /postReport\.guestGame\.playerState\.address/,
    },
    {
      name: "changed player unique ID",
      mutate({ postReport }) {
        postReport.guestGame.player.uniqueId = 2;
      },
      pattern: /postReport\.guestGame\.player\.uniqueId/,
    },
    {
      name: "changed current camera ID",
      mutate({ postReport }) {
        postReport.guestGame.camera.currentId = 0x1235;
        postReport.guestGame.camera.firstPersonId = 0x1235;
      },
      pattern: /postReport\.guestGame\.camera\.currentId/,
    },
    {
      name: "coherent invalid first-person camera ID",
      mutate({ preReport, postReport }) {
        for (const report of [preReport, postReport]) {
          report.guestGame.camera.currentId = 0xffff;
          report.guestGame.camera.firstPersonId = 0xffff;
        }
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.camera.currentId = 0xffff;
        receipt.camera.firstPersonId = 0xffff;
      },
      pattern: /preReport\.guestGame\.camera\.currentId/,
    },
    {
      name: "player-state lifecycle flags changed",
      mutate({ postReport }) {
        postReport.guestGame.playerState.flags = 0x81;
      },
      pattern: /postReport\.guestGame\.playerState\.flags/,
    },
    {
      name: "entity lifecycle flags changed",
      mutate({ postReport }) {
        postReport.guestGame.player.entityFlags = 0x81;
      },
      pattern: /postReport\.guestGame\.player\.entityFlags/,
    },
    {
      name: "first-person camera flags changed",
      mutate({ postReport }) {
        postReport.guestGame.camera.flags = 1;
      },
      pattern: /postReport\.guestGame\.camera\.flags/,
    },
    {
      name: "active cinematic camera",
      mutate({ preReport }) {
        preReport.guestGame.camera.cinematicCount = 1;
      },
      pattern: /preReport\.guestGame\.camera\.cinematicCount/,
    },
    {
      name: "camera disables input",
      mutate({ preReport }) {
        preReport.guestGame.camera.flags = 0x40;
      },
      pattern: /preReport\.guestGame\.camera\.flags/,
    },
    {
      name: "manager not running",
      mutate({ preReport }) {
        preReport.guestGame.manager.gameState = 1;
      },
      pattern: /preReport\.guestGame\.manager\.gameState/,
    },
    {
      name: "manager initialization incomplete",
      mutate({ preReport }) {
        preReport.guestGame.manager.initPhase = 1;
      },
      pattern: /preReport\.guestGame\.manager\.initPhase/,
    },
    {
      name: "player state not alive",
      mutate({ preReport }) {
        preReport.guestGame.playerState.flags = 0;
      },
      pattern: /preReport\.guestGame\.playerState\.flags/,
    },
    {
      name: "negative player-state reference count",
      mutate({ preReport }) {
        preReport.guestGame.playerState.refCount = -1;
      },
      pattern: /preReport\.guestGame\.playerState\.refCount/,
    },
    {
      name: "out-of-range player-state reference count",
      mutate({ preReport }) {
        preReport.guestGame.playerState.refCount = 0x80000000;
      },
      pattern: /preReport\.guestGame\.playerState\.refCount/,
    },
    {
      name: "player entity inactive",
      mutate({ preReport }) {
        preReport.guestGame.player.entityFlags = 0;
      },
      pattern: /preReport\.guestGame\.player\.entityFlags/,
    },
    {
      name: "player camera state changed",
      mutate({ preReport }) {
        preReport.guestGame.player.cameraState = 1;
      },
      pattern: /preReport\.guestGame\.player\.cameraState/,
    },
    {
      name: "player morphed",
      mutate({ preReport }) {
        preReport.guestGame.player.morphState = 1;
      },
      pattern: /preReport\.guestGame\.player\.morphState/,
    },
    {
      name: "player orbiting",
      mutate({ preReport }) {
        preReport.guestGame.player.orbitState = 1;
      },
      pattern: /preReport\.guestGame\.player\.orbitState/,
    },
    {
      name: "player frozen",
      mutate({ preReport }) {
        preReport.guestGame.player.frozenTimeout = 1;
      },
      pattern: /preReport\.guestGame\.player\.frozenTimeout/,
    },
    {
      name: "control freeze byte set",
      mutate({ preReport }) {
        preReport.guestGame.player.controlsFrozen = 1;
      },
      pattern: /preReport\.guestGame\.player\.controlsFrozen/,
    },
    {
      name: "player input disabled",
      mutate({ preReport }) {
        preReport.guestGame.player.inputFlags = 4;
      },
      pattern: /preReport\.guestGame\.player\.inputFlags/,
    },
    {
      name: "player dead",
      mutate({ preReport }) {
        preReport.guestGame.player.deathTime = 1;
      },
      pattern: /preReport\.guestGame\.player\.deathTime/,
    },
    {
      name: "receipt lifecycle changed",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.lifecycle.orbitState = 1;
      },
      pattern: /lastActiveGameplayInput\.lifecycle\.orbitState/,
    },
    {
      name: "receipt camera changed",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.camera.firstPerson =
          "0x80422000";
      },
      pattern: /lastActiveGameplayInput\.camera\.firstPerson/,
    },
    {
      name: "receipt moved to another world",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.world = "0x80420000";
      },
      pattern: /lastActiveGameplayInput\.world/,
    },
    {
      name: "receipt moved to another area",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.area = 1;
      },
      pattern: /lastActiveGameplayInput\.area/,
    },
  ];
  assertRejectedCases(game, cases);
});

test("Metroid Prime projection requires exact publication identity and monotonic receipt", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = metroidPrimeGame(corpus);
  const cases = [
    {
      name: "receipt before baseline",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          preReport.cycles - 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "receipt after post report",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          postReport.cycles + 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "publication source differs from terminal publication",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.hostPublication.source =
          "direct";
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.source/,
    },
    {
      name: "publication poll differs from terminal publication",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.hostPublication.pollIndex += 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.pollIndex/,
    },
    {
      name: "publication cycle differs from terminal publication",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.observedCycle += 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.observedCycle/,
    },
    {
      name: "publication is not left",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.hostPublication.buttons = 2;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.buttons/,
    },
    {
      name: "controller applied another sequence",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .controllerAppliedSequence += 1;
      },
      pattern: /lastActiveGameplayInput\.controllerAppliedSequence/,
    },
    {
      name: "publication does not advance baseline poll",
      mutate({ preReport, postReport }) {
        const publication =
          postReport.guestGame.lastActiveGameplayInput.hostPublication;
        publication.pollIndex = preReport.controller.pollIndex;
        postReport.controller.lastActiveHostPublication.pollIndex =
          preReport.controller.pollIndex;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.pollIndex/,
    },
    {
      name: "publication observed after receipt",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.observedCycle = receipt.cycle + 1;
        postReport.controller.lastActiveHostPublication.observedCycle =
          receipt.cycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "receipt input frame regresses",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.inputFrame = 99;
      },
      pattern: /lastActiveGameplayInput\.updateFrame/,
    },
    {
      name: "receipt update frame regresses",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.updateFrame = 199;
      },
      pattern: /lastActiveGameplayInput\.updateFrame/,
    },
    {
      name: "post update frame does not follow receipt",
      mutate({ postReport }) {
        postReport.guestGame.manager.updateFrame =
          postReport.guestGame.lastActiveGameplayInput.updateFrame;
      },
      pattern: /postReport\.guestGame\.manager\.updateFrame/,
    },
    {
      name: "post input frame regresses from receipt",
      mutate({ postReport }) {
        postReport.guestGame.manager.inputFrame = 100;
      },
      pattern: /postReport\.guestGame\.manager\.updateFrame/,
    },
  ];
  assertRejectedCases(game, cases);

  const reports = makeMetroidPrimeFirstPlayableReportPair(game);
  reports.postReport.mmioState.viInterruptModel.lastHostPresentationCycle =
    reports.postReport.guestGame.lastActiveGameplayInput.cycle - 1;
  assert.throws(
    () => derive(corpus, game, reports),
    /guest input latch cycle/,
    "presentation precedes receipt",
  );
});

test("Metroid Prime projection requires finite orthonormal durable orientation change", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = metroidPrimeGame(corpus);
  const cases = [
    {
      name: "non-finite baseline forward vector",
      mutate({ preReport }) {
        preReport.guestGame.player.transform.forward.x = Number.NaN;
      },
      pattern: /preReport\.guestGame\.player\.transform\.forward\.x.*finite/,
    },
    {
      name: "non-unit baseline forward vector",
      mutate({ preReport }) {
        preReport.guestGame.player.transform.forward = { x: -2, y: 0, z: 0 };
      },
      pattern: /approximately orthonormal/,
    },
    {
      name: "non-perpendicular post transform",
      mutate({ postReport }) {
        postReport.guestGame.player.transform.right = {
          ...postReport.guestGame.player.transform.forward,
        };
      },
      pattern: /approximately orthonormal/,
    },
    {
      name: "inspector orthonormal predicate lies",
      mutate({ postReport }) {
        postReport.guestGame.player.transform.orthonormal = false;
      },
      pattern: /postReport\.guestGame\.player\.transform\.orthonormal/,
    },
    {
      name: "non-unit receipt orientation",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.forward = {
          x: -2,
          y: 0,
          z: 0,
        };
      },
      pattern: /lastActiveGameplayInput\.forward.*orthonormal/,
    },
    {
      name: "unchanged durable orientation",
      mutate({ postReport }) {
        setPostOrientation(postReport, 0);
      },
      pattern: /durable forward-vector delta/,
    },
    {
      name: "orientation change below threshold",
      mutate({ postReport }) {
        setPostOrientation(postReport, 5e-7);
      },
      pattern: /durable forward-vector delta/,
    },
    {
      name: "non-finite receipt angular velocity",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.angularVelocity.z =
          Number.NaN;
      },
      pattern: /lastActiveGameplayInput\.angularVelocity\.z.*finite/,
    },
    {
      name: "receipt turn projection disagrees with vectors",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.turn.torqueAlongUp = 1;
      },
      pattern: /lastActiveGameplayInput\.turn\.torqueAlongUp/,
    },
  ];
  assertRejectedCases(game, cases);
});
