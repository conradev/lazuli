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
  projectFzeroGuestConsumption,
} from "./browser_game_first_playable_fzero.mjs";
import {
  makeFzeroFirstPlayableReportPair,
} from "./browser_game_first_playable_fzero_test_fixture.mjs";
import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

const RACER_POINTER_OFFSET = 0x227878;

function fzeroGame(corpus) {
  return corpus.games.find(candidate => candidate.key === "f-zero-gx-usa");
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
  return projectFzeroGuestConsumption({
    button,
    game,
    publication: reports.postReport.controller.lastActiveHostPublication,
    ...reports,
  });
}

function hex32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
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
    hex32(Number.parseInt(current.slice(2), 16) + 4),
  );
}

function pathPattern(report, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${report}\\.guestGame\\.${escaped}`);
}

function assertRejectedCases(game, cases) {
  for (const { mutate, name, pattern } of cases) {
    const reports = makeFzeroFirstPlayableReportPair(game);
    mutate(reports);
    assert.throws(
      () => project(game, reports),
      pattern,
      name,
    );
  }
}

function relocateRacer(guest, racer) {
  guest.racerLookup.rawValue = hex32(racer);
  guest.racerLookup.racer = hex32(racer);
  guest.vehicle.address = hex32(racer);
  for (const [field, offset] of [
    ["generalState", 0x000],
    ["entrantId", 0x004],
    ["machineId", 0x006],
    ["position", 0x07c],
    ["previousPosition", 0x088],
    ["worldVelocity", 0x094],
    ["localVelocity", 0x0b8],
    ["worldOrientation", 0x0ec],
    ["speedKph", 0x17c],
    ["energy", 0x184],
    ["crashToRestoreFrameCounter", 0x194],
    ["trackOrientation", 0x1bc],
    ["checkpoint", 0x1cc],
    ["checkpointFraction", 0x1d0],
  ]) {
    guest.vehicle[`${field}Address`] = hex32(racer + offset);
  }
  for (const [field, offset] of [
    ["steerY", 0x1f4],
    ["strafe", 0x1f8],
    ["steerX", 0x1fc],
    ["accelerator", 0x200],
    ["brake", 0x204],
    ["duplicateSteerX", 0x20c],
  ]) {
    guest.vehicle.input[`${field}Address`] = hex32(racer + offset);
  }
  for (const [field, offset] of [
    ["restoreCountdown", 0x214],
    ["controllerSlot", 0x474],
    ["frameCountSinceStartOrRestore", 0x47c],
    ["crashBit", 0x4b3],
    ["generalState2", 0x58f],
    ["restoreCompletionFlag", 0x590],
    ["breakDownCountdown", 0x593],
    ["postRestoreCountdown", 0x5d8],
    ["groundAirFlag", 0x61c],
  ]) {
    guest.vehicle.lifecycle[`${field}Address`] = hex32(racer + offset);
  }
}

test("F-Zero projector proves moving GFZE01 race input with negative left steer", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = fzeroGame(corpus);
  const steerX = -0.75;
  const reports = makeFzeroFirstPlayableReportPair(game, steerX);
  const transcript = derive(corpus, game, reports);
  const consumption = transcript.input.guestConsumption;

  assert.equal(consumption.kind, "fzero-gx-active-race-steer-v1");
  assert.equal(consumption.reference, "0x80010000");
  assert.equal(consumption.racer, "0x80400000");
  assert.equal(consumption.entrantId, 0);
  assert.equal(consumption.machineId, 5);
  assert.deepEqual(consumption.baseline, {
    cycle: reports.preReport.cycles,
    frameCountSinceStartOrRestore: 300,
    position: { x: 10, y: 20, z: 30 },
    previousPosition: { x: 9.5, y: 20, z: 30 },
    worldVelocity: { x: 1, y: 0, z: 0 },
    speedKph: 1234.5,
    checkpoint: 4,
    checkpointFraction: 0.25,
    inputSource: {
      generalState: 0,
      controllerSlot: 0,
      inputProcessingState: 1,
      livePlayer: true,
    },
  });
  assert.deepEqual(consumption.receipt, {
    frameCountSinceStartOrRestore: 301,
    position: { x: 11, y: 20, z: 30 },
    worldVelocity: { x: 1, y: 0, z: 0 },
    input: {
      steerY: 0,
      strafe: 0,
      steerX,
      duplicateSteerX: steerX,
      accelerator: 1,
      brake: 0,
    },
    inputSource: {
      generalState: 0,
      controllerSlot: 0,
      inputProcessingState: 1,
      livePlayer: true,
    },
  });
  assert.deepEqual(consumption.post, {
    cycle: reports.postReport.cycles,
    frameCountSinceStartOrRestore: 303,
    position: { x: 12, y: 20, z: 30 },
    previousPosition: { x: 11.5, y: 20, z: 30 },
    worldVelocity: { x: 1, y: 0, z: 0 },
    speedKph: 1234.5,
    checkpoint: 4,
    checkpointFraction: 0.25,
    inputSource: {
      generalState: 0,
      controllerSlot: 0,
      inputProcessingState: 1,
      livePlayer: true,
    },
  });
  assert.deepEqual(consumption.movement, {
    baselineFrameDistanceSquared: 0.25,
    postFrameDistanceSquared: 0.25,
    windowDistanceSquared: 4,
    postLatchDistanceSquared: 1,
    baselineWorldVelocitySquared: 1,
    latchWorldVelocitySquared: 1,
    postWorldVelocitySquared: 1,
    frameDelta: 3,
    postLatchFrameDelta: 2,
  });
  assert.equal(consumption.hostPublication.buttons, 0x0001);
  assert.equal(
    consumption.hostPublication.sequence,
    reports.postReport.controller.lastActiveHostPublication.sequence,
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

test("F-Zero projector is exact-game, exact-revision, and left-only", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = fzeroGame(corpus);
  const reports = makeFzeroFirstPlayableReportPair(game);

  assert.throws(
    () => project(
      { ...game, disc: { ...game.disc, identifier: "GFZJ01" } },
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
  assert.throws(
    () => project(game, reports, "right"),
    /\$\.button/,
  );

  const other = corpus.games.find(candidate => candidate.key === "warioware-usa");
  const otherReports = makeGameFirstPlayableReportPair(other);
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: other.key,
      guestProjector: projectFzeroGuestConsumption,
      ...otherReports,
    }),
    /no guest-consumption projector is available/,
  );
});

test("F-Zero projection rejects every drifted pointer and field address", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = fzeroGame(corpus);
  const addressPaths = [
    "reference.pointerAddress",
    "racerLookup.pointerAddress",
    "vehicle.generalStateAddress",
    "vehicle.entrantIdAddress",
    "vehicle.machineIdAddress",
    "vehicle.positionAddress",
    "vehicle.previousPositionAddress",
    "vehicle.worldVelocityAddress",
    "vehicle.localVelocityAddress",
    "vehicle.worldOrientationAddress",
    "vehicle.speedKphAddress",
    "vehicle.energyAddress",
    "vehicle.crashToRestoreFrameCounterAddress",
    "vehicle.trackOrientationAddress",
    "vehicle.checkpointAddress",
    "vehicle.checkpointFractionAddress",
    "vehicle.input.steerYAddress",
    "vehicle.input.strafeAddress",
    "vehicle.input.steerXAddress",
    "vehicle.input.acceleratorAddress",
    "vehicle.input.brakeAddress",
    "vehicle.input.duplicateSteerXAddress",
    "vehicle.lifecycle.restoreCountdownAddress",
    "vehicle.lifecycle.controllerSlotAddress",
    "vehicle.lifecycle.frameCountSinceStartOrRestoreAddress",
    "vehicle.lifecycle.crashBitAddress",
    "vehicle.lifecycle.generalState2Address",
    "vehicle.lifecycle.restoreCompletionFlagAddress",
    "vehicle.lifecycle.breakDownCountdownAddress",
    "vehicle.lifecycle.postRestoreCountdownAddress",
    "vehicle.lifecycle.groundAirFlagAddress",
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
      name: "drifted racer pointer offset",
      mutate({ preReport }) {
        preReport.guestGame.racerLookup.pointerOffset = "0x0022787c";
      },
      pattern: /preReport\.guestGame\.racerLookup\.pointerOffset/,
    },
    {
      name: "reference pointer cannot reach its racer-pointer slot",
      mutate({ preReport }) {
        preReport.guestGame.reference.value = "0x817ffffc";
        preReport.guestGame.reference.rawValue = "0x817ffffc";
      },
      pattern: /preReport\.guestGame\.reference\.value/,
    },
    {
      name: "reference raw value disagrees",
      mutate({ preReport }) {
        preReport.guestGame.reference.rawValue = "0x80020000";
      },
      pattern: /preReport\.guestGame\.reference\.rawValue/,
    },
    {
      name: "reference mapped flag is false",
      mutate({ preReport }) {
        preReport.guestGame.reference.mapped = false;
      },
      pattern: /preReport\.guestGame\.reference\.mapped/,
    },
    {
      name: "racer block crosses the end of MEM1",
      mutate({ preReport }) {
        preReport.guestGame.racerLookup.racer = "0x817ffa00";
        preReport.guestGame.racerLookup.rawValue = "0x817ffa00";
      },
      pattern: /preReport\.guestGame\.racerLookup\.racer/,
    },
    {
      name: "racer pointer is unaligned",
      mutate({ preReport }) {
        preReport.guestGame.racerLookup.racer = "0x80400002";
        preReport.guestGame.racerLookup.rawValue = "0x80400002";
      },
      pattern: /preReport\.guestGame\.racerLookup\.racer/,
    },
    {
      name: "racer raw value disagrees",
      mutate({ preReport }) {
        preReport.guestGame.racerLookup.rawValue = "0x80401000";
      },
      pattern: /preReport\.guestGame\.racerLookup\.rawValue/,
    },
    {
      name: "wrong racer block size",
      mutate({ preReport }) {
        preReport.guestGame.racerLookup.blockSize = 0x61c;
      },
      pattern: /preReport\.guestGame\.racerLookup\.blockSize/,
    },
    {
      name: "vehicle address disagrees with racer lookup",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.address = "0x80401000";
      },
      pattern: /preReport\.guestGame\.vehicle\.address/,
    },
    {
      name: "wrong vehicle block size",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.size = 0x61c;
      },
      pattern: /preReport\.guestGame\.vehicle\.size/,
    },
  );
  assertRejectedCases(game, cases);
});

test("F-Zero projection rejects invalid flags, input ranges, and vectors", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = fzeroGame(corpus);
  const cases = [];

  for (const report of ["preReport", "postReport"]) {
    for (const [field, value] of [
      ["raceAllocated", false],
      ["vehicle.valid", false],
      ["vehicleValid", false],
      ["activeRaceCandidate", false],
      ["livePlayerInputPath", false],
      ["defaultLivePlayerInputState", false],
    ]) {
      cases.push({
        name: `${report} rejects ${field}`,
        mutate(reports) {
          setPath(reports[report].guestGame, field, value);
        },
        pattern: pathPattern(report, field),
      });
    }
    for (const [value, label] of [
      [0x00000080, "input-disabled general state"],
      [0x04000000, "AI/replay general state"],
    ]) {
      cases.push({
        name: `${report} rejects ${label}`,
        mutate(reports) {
          reports[report].guestGame.vehicle.generalState = value;
        },
        pattern: pathPattern(report, "vehicle.generalState"),
      });
    }
    cases.push({
      name: `${report} rejects a non-P1 controller slot`,
      mutate(reports) {
        reports[report].guestGame.vehicle.lifecycle.controllerSlot = 1;
      },
      pattern: pathPattern(report, "vehicle.lifecycle.controllerSlot"),
    });
  }
  cases.push(
    {
      name: "receipt input-disabled general state",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.generalState = 0x80;
      },
      pattern: /lastActiveGameplayInput\.generalState/,
    },
    {
      name: "receipt AI or replay general state",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.generalState = 0x04000000;
      },
      pattern: /lastActiveGameplayInput\.generalState/,
    },
    {
      name: "receipt does not select P1",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.controllerSlot = 1;
      },
      pattern: /lastActiveGameplayInput\.controllerSlot/,
    },
  );
  for (const [field, value] of [
    ["steerY", 1.01],
    ["strafe", -1.01],
    ["steerX", 1.01],
    ["duplicateSteerX", -1.01],
  ]) {
    cases.push({
      name: `baseline ${field} outside documented range`,
      mutate({ preReport }) {
        preReport.guestGame.vehicle.input[field] = value;
      },
      pattern: pathPattern("preReport", `vehicle.input.${field}`),
    });
  }
  cases.push(
    {
      name: "baseline duplicate steer disagrees",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.input.duplicateSteerX = 0.25;
      },
      pattern: /preReport\.guestGame\.vehicle\.input\.duplicateSteerX/,
    },
    {
      name: "baseline duplicate predicate is false",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.input.duplicateSteerMatches = false;
      },
      pattern: /preReport\.guestGame\.vehicle\.input\.duplicateSteerMatches/,
    },
    {
      name: "baseline range predicate is false",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.input.documentedRanges = false;
      },
      pattern: /preReport\.guestGame\.vehicle\.input\.documentedRanges/,
    },
    {
      name: "baseline has horizontal steering",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.input.steerX = 0.25;
        preReport.guestGame.vehicle.input.duplicateSteerX = 0.25;
      },
      pattern: /preReport\.guestGame\.vehicle\.input.*neutral baseline/,
    },
    {
      name: "baseline has vertical steering",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.input.steerY = 0.25;
      },
      pattern: /preReport\.guestGame\.vehicle\.input.*neutral baseline/,
    },
    {
      name: "baseline has strafe",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.input.strafe = 0.25;
      },
      pattern: /preReport\.guestGame\.vehicle\.input.*neutral baseline/,
    },
    {
      name: "non-finite speed",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.speedKph = Number.NaN;
      },
      pattern: /preReport\.guestGame\.vehicle\.speedKph.*finite/,
    },
    {
      name: "non-finite accelerator",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.input.accelerator = Infinity;
      },
      pattern: /postReport\.guestGame\.vehicle\.input\.accelerator.*finite/,
    },
    {
      name: "non-finite brake",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.input.brake = Number.NaN;
      },
      pattern: /postReport\.guestGame\.vehicle\.input\.brake.*finite/,
    },
    {
      name: "receipt steering is too weak",
      mutate({ postReport }) {
        const input = postReport.guestGame.lastActiveGameplayInput.input;
        input.steerX = 0.49;
        input.duplicateSteerX = 0.49;
      },
      pattern: /lastActiveGameplayInput\.input\.steerX.*negative left-steering/,
    },
    {
      name: "positive steer cannot witness host-left",
      mutate({ postReport }) {
        const input = postReport.guestGame.lastActiveGameplayInput.input;
        input.steerX = 0.75;
        input.duplicateSteerX = 0.75;
      },
      pattern: /lastActiveGameplayInput\.input\.steerX.*negative left-steering/,
    },
    {
      name: "receipt steering exceeds documented range",
      mutate({ postReport }) {
        const input = postReport.guestGame.lastActiveGameplayInput.input;
        input.steerX = 1.01;
        input.duplicateSteerX = 1.01;
      },
      pattern: /lastActiveGameplayInput\.input\.steerX/,
    },
    {
      name: "receipt duplicate steer disagrees",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .input.duplicateSteerX = -0.5;
      },
      pattern: /lastActiveGameplayInput\.input\.duplicateSteerX/,
    },
    {
      name: "receipt has vertical steering",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.steerY = 0.1;
      },
      pattern: /lastActiveGameplayInput\.input\.steerY/,
    },
    {
      name: "receipt has strafe",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.strafe = 0.1;
      },
      pattern: /lastActiveGameplayInput\.input\.strafe/,
    },
    {
      name: "receipt accelerator is non-finite",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.accelerator =
          Number.NaN;
      },
      pattern: /lastActiveGameplayInput\.input\.accelerator.*finite/,
    },
  );

  const stateVectors = [
    "vehicle.position",
    "vehicle.previousPosition",
    "vehicle.worldVelocity",
    "vehicle.localVelocity",
    "vehicle.worldOrientation",
    "vehicle.trackOrientation",
  ];
  for (const report of ["preReport", "postReport"]) {
    for (const path of stateVectors) {
      cases.push({
        name: `${report} rejects non-finite ${path}`,
        mutate(reports) {
          getPath(reports[report].guestGame, path).x = Number.NaN;
        },
        pattern: pathPattern(report, `${path}.x`),
      });
    }
  }
  for (const path of ["position", "worldVelocity"]) {
    cases.push({
      name: `receipt rejects non-finite ${path}`,
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput[path].x = Number.NaN;
      },
      pattern: new RegExp(`lastActiveGameplayInput\\.${path}\\.x.*finite`),
    });
  }

  assertRejectedCases(game, cases);
});

test("F-Zero projection rejects crash, restore, and missing motion evidence", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = fzeroGame(corpus);
  const stateLifecycle = [
    "vehicle.lifecycle.crashBit",
    "vehicle.lifecycle.restoreCountdown",
    "vehicle.crashToRestoreFrameCounter",
    "vehicle.lifecycle.breakDownCountdown",
    "vehicle.lifecycle.postRestoreCountdown",
  ];
  const cases = [];
  for (const report of ["preReport", "postReport"]) {
    for (const path of stateLifecycle) {
      cases.push({
        name: `${report} rejects active ${path}`,
        mutate(reports) {
          setPath(reports[report].guestGame, path, 1);
        },
        pattern: pathPattern(report, path),
      });
    }
    for (const value of [0, 2, 3, 4, 5]) {
      cases.push({
        name: `${report} rejects input-processing state ${value}`,
        mutate(reports) {
          reports[report].guestGame.vehicle.lifecycle
            .restoreCompletionFlag = value;
        },
        pattern: pathPattern(
          report,
          "vehicle.lifecycle.restoreCompletionFlag",
        ),
      });
    }
  }
  for (const field of [
    "crashBit",
    "restoreCountdown",
    "crashToRestoreFrameCounter",
    "breakDownCountdown",
    "postRestoreCountdown",
  ]) {
    cases.push({
      name: `receipt rejects active ${field}`,
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.lifecycle[field] = 1;
      },
      pattern: new RegExp(`lastActiveGameplayInput\\.lifecycle\\.${field}`),
    });
  }
  for (const value of [0, 2, 3, 4, 5]) {
    cases.push({
      name: `receipt rejects input-processing state ${value}`,
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.lifecycle
          .restoreCompletionFlag = value;
      },
      pattern: /lastActiveGameplayInput\.lifecycle\.restoreCompletionFlag/,
    });
  }
  cases.push(
    {
      name: "baseline per-frame position is static",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.previousPosition = {
          ...preReport.guestGame.vehicle.position,
        };
      },
      pattern: /preReport\.guestGame\.vehicle\.position.*advancing/,
    },
    {
      name: "post per-frame position is static",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.previousPosition = {
          ...postReport.guestGame.vehicle.position,
        };
      },
      pattern: /postReport\.guestGame\.vehicle\.position.*advancing/,
    },
    {
      name: "baseline world velocity is zero",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.worldVelocity = { x: 0, y: 0, z: 0 };
      },
      pattern: /preReport\.guestGame\.vehicle\.worldVelocity.*moving/,
    },
    {
      name: "post world velocity is zero",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.worldVelocity = { x: 0, y: 0, z: 0 };
      },
      pattern: /postReport\.guestGame\.vehicle\.worldVelocity.*moving/,
    },
    {
      name: "receipt world velocity is zero",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.worldVelocity =
          { x: 0, y: 0, z: 0 };
      },
      pattern: /lastActiveGameplayInput\.worldVelocity.*moving/,
    },
    {
      name: "terminal position did not move from baseline",
      mutate({ preReport, postReport }) {
        postReport.guestGame.vehicle.position = {
          ...preReport.guestGame.vehicle.position,
        };
        postReport.guestGame.vehicle.previousPosition = { x: 9.5, y: 20, z: 30 };
      },
      pattern: /postReport\.guestGame\.vehicle\.position.*after the consumed/,
    },
    {
      name: "terminal position did not move after receipt",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput.position;
        postReport.guestGame.vehicle.position = { ...receipt };
        postReport.guestGame.vehicle.previousPosition =
          { x: receipt.x - 0.5, y: receipt.y, z: receipt.z };
      },
      pattern: /postReport\.guestGame\.vehicle\.position.*after the retained/,
    },
    {
      name: "baseline per-frame motion is below threshold",
      mutate({ preReport }) {
        preReport.guestGame.vehicle.previousPosition.x =
          preReport.guestGame.vehicle.position.x - 0.005;
      },
      pattern: /preReport\.guestGame\.vehicle\.position.*advancing/,
    },
    {
      name: "synthetic movement overflows",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.position.x = Number.MAX_VALUE;
      },
      pattern: /postReport\.guestGame\.vehicle\.position/,
    },
  );
  assertRejectedCases(game, cases);
});

test("F-Zero projection rejects lifecycle, identity, and frame discontinuity", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = fzeroGame(corpus);
  const cases = [
    {
      name: "post reference changes coherently",
      mutate({ postReport }) {
        const reference = 0x80020000;
        postReport.guestGame.reference.value = hex32(reference);
        postReport.guestGame.reference.rawValue = hex32(reference);
        postReport.guestGame.racerLookup.pointerAddress =
          hex32(reference + RACER_POINTER_OFFSET);
      },
      pattern: /postReport\.guestGame\.reference\.value/,
    },
    {
      name: "post racer changes coherently",
      mutate({ postReport }) {
        relocateRacer(postReport.guestGame, 0x80420000);
      },
      pattern: /postReport\.guestGame\.vehicle\.address/,
    },
    {
      name: "post entrant changes",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.entrantId = 1;
      },
      pattern: /postReport\.guestGame\.vehicle\.entrantId/,
    },
    {
      name: "post machine changes",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.machineId = 6;
      },
      pattern: /postReport\.guestGame\.vehicle\.machineId/,
    },
    {
      name: "receipt reference changes",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.reference = "0x80020000";
      },
      pattern: /lastActiveGameplayInput\.reference/,
    },
    {
      name: "receipt racer changes",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.racer = "0x80420000";
      },
      pattern: /lastActiveGameplayInput\.racer/,
    },
    {
      name: "receipt entrant changes",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.entrantId = 1;
      },
      pattern: /lastActiveGameplayInput\.entrantId/,
    },
    {
      name: "receipt machine changes",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.machineId = 6;
      },
      pattern: /lastActiveGameplayInput\.machineId/,
    },
    {
      name: "receipt frame predates baseline",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .frameCountSinceStartOrRestore = 299;
      },
      pattern: /lastActiveGameplayInput\.frameCountSinceStartOrRestore/,
    },
    {
      name: "receipt frame reaches terminal frame",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .frameCountSinceStartOrRestore = 303;
      },
      pattern: /postReport\.guestGame\.vehicle\.lifecycle\.frameCount/,
    },
    {
      name: "terminal frame does not advance after receipt",
      mutate({ postReport }) {
        postReport.guestGame.vehicle.lifecycle
          .frameCountSinceStartOrRestore = 301;
      },
      pattern: /postReport\.guestGame\.vehicle\.lifecycle\.frameCount/,
    },
    {
      name: "receipt cycle predates baseline",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          preReport.cycles - 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "receipt cycle follows terminal report",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          postReport.cycles + 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
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
  ];
  assertRejectedCases(game, cases);
});

test("F-Zero retained receipt and publication are exact and chronological", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = fzeroGame(corpus);
  const cases = [
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
      name: "receipt input has an extra key",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.rawSteerX = -80;
      },
      pattern: /lastActiveGameplayInput\.input\.\[keys\]/,
    },
    {
      name: "receipt lifecycle has an extra key",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.lifecycle.generalState = 0;
      },
      pattern: /lastActiveGameplayInput\.lifecycle\.\[keys\]/,
    },
    {
      name: "receipt publication has an extra key",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.channel = 0;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.\[keys\]/,
    },
    {
      name: "unsupported publication source",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.source = "scenario";
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.source/,
    },
    {
      name: "publication is not exact host-left",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.buttons = 0x0003;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.buttons/,
    },
    {
      name: "publication poll is not positive",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.pollIndex = 0;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.pollIndex/,
    },
    {
      name: "publication sequence is not positive",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.sequence = 0;
        receipt.controllerAppliedSequence = 0;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.sequence/,
    },
    {
      name: "publication was scheduled before baseline",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.scheduledCycle = preReport.cycles - 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "publication timing is reversed",
      mutate({ postReport }) {
        const publication =
          postReport.guestGame.lastActiveGameplayInput.hostPublication;
        publication.scheduledCycle = publication.observedCycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "publication is observed after receipt",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.observedCycle = receipt.cycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "publication did not advance baseline poll",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.pollIndex = preReport.controller.pollIndex;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.pollIndex/,
    },
    {
      name: "controller did not apply publication sequence",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .controllerAppliedSequence += 1;
      },
      pattern: /lastActiveGameplayInput\.controllerAppliedSequence/,
    },
    {
      name: "receipt sequence differs from terminal publication",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.sequence -= 1;
        receipt.controllerAppliedSequence -= 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.sequence/,
    },
    {
      name: "receipt poll follows terminal publication",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.pollIndex =
          postReport.controller.lastActiveHostPublication.pollIndex + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "receipt scheduled cycle follows terminal publication",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.scheduledCycle =
          postReport.controller.lastActiveHostPublication.scheduledCycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "receipt observed cycle follows terminal publication",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.observedCycle =
          postReport.controller.lastActiveHostPublication.observedCycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
  ];
  assertRejectedCases(game, cases);
});
