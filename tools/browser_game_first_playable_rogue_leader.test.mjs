#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  readGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  deriveGameFirstPlayableTranscript,
  verifyGameFirstPlayableTranscript,
} from "./browser_game_first_playable_transcript.mjs";
import {
  projectRogueLeaderGuestConsumption,
} from "./browser_game_first_playable_rogue_leader.mjs";
import {
  makeRogueLeaderFirstPlayableReportPair,
} from "./browser_game_first_playable_rogue_leader_test_fixture.mjs";

const CRAFT = 0x7fd80000;
const CRAFT_CONFIG = 0x7fd90000;
const SIMULATION_MANAGER = 0x7fdb0000;

function rogueLeaderGame(corpus) {
  return corpus.games.find(candidate => candidate.key === "rogue-leader-usa");
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
  return projectRogueLeaderGuestConsumption({
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

function pathPattern(report, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${report}\\.guestGame\\.${escaped}`);
}

function driftHexAddress(value, path) {
  const current = getPath(value, path);
  setPath(
    value,
    path,
    hex32(Number.parseInt(current.slice(2), 16) + 4),
  );
}

function assertRejectedCases(game, cases) {
  for (const { mutate, name, pattern = /guestGame|receipt|publication/ } of cases) {
    const reports = makeRogueLeaderFirstPlayableReportPair(game);
    mutate(reports);
    assert.throws(() => project(game, reports), pattern, name);
  }
}

function relocateCraftState(guest, address) {
  guest.playerManager.activeCraft = hex32(address);
  guest.craft.address = hex32(address);
  for (const [path, offset] of [
    ["craft.identity.primaryVtableAddress", 0x80],
    ["craft.identity.interfaceVtableAddress", 0x1a0],
    ["craft.stateAddress", 0x370],
    ["craft.configPointerAddress", 0x37c],
    ["craft.controlPointerAddress", 0x380],
    ["craft.transform.orientation0Address", 0x84],
    ["craft.transform.orientation1Address", 0x90],
    ["craft.transform.orientation2Address", 0x9c],
    ["craft.transform.positionAddress", 0xa8],
    ["craft.transform.velocityAddress", 0xb4],
    ["craft.response.field45cAddress", 0x45c],
    ["craft.response.field460Address", 0x460],
    ["craft.response.field464Address", 0x464],
  ]) {
    setPath(guest, path, hex32(address + offset));
  }
  if (guest.neutralControlBaseline !== null) {
    guest.neutralControlBaseline.craft.address = hex32(address);
  }
}

function relocateCraft(reports, address) {
  relocateCraftState(reports.preReport.guestGame, address);
  relocateCraftState(reports.postReport.guestGame, address);
  reports.postReport.guestGame.lastActiveGameplayInput.craft.address =
    hex32(address);
}

function relocateConfig(reports, address) {
  for (const report of ["preReport", "postReport"]) {
    const guest = reports[report].guestGame;
    guest.craft.config = hex32(address);
    guest.neutralControlBaseline.craft.config = hex32(address);
  }
  reports.postReport.guestGame.lastActiveGameplayInput.craft.config =
    hex32(address);
}

function relocateSimulationState(guest, address) {
  guest.simulation.manager = hex32(address);
  guest.simulation.auxiliaryEnabledAddress = hex32(address + 0xe04);
  guest.simulation.auxiliaryModeAddress = hex32(address + 0xa7c);
}

function relocateSimulation(reports, address) {
  for (const report of ["preReport", "postReport"]) {
    relocateSimulationState(reports[report].guestGame, address);
  }
  reports.postReport.guestGame.lastActiveGameplayInput.simulation.manager =
    hex32(address);
}

function setReceiptResponse(reports, field460, field464) {
  const guest = reports.postReport.guestGame;
  const receipt = guest.lastActiveGameplayInput;
  const baseline = receipt.neutralBaseline.response;
  receipt.response.field460 = field460;
  receipt.response.field464 = field464;
  receipt.responseTransition.field460Delta =
    field460 - baseline.field460;
  receipt.responseTransition.field464Delta =
    field464 - baseline.field464;
  receipt.responseTransition.xChanged =
    Math.abs(receipt.responseTransition.field460Delta) > 0.0001
    || Math.abs(receipt.responseTransition.field464Delta) > 0.0001;
  guest.craft.response.field460 = field460;
  guest.craft.response.field464 = field464;
  guest.craft.response.xActive =
    Math.abs(field460) > 0.0001 || Math.abs(field464) > 0.0001;
}

test("Rogue Leader derives and verifies an exact retained control-response receipt", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const reports = makeRogueLeaderFirstPlayableReportPair(game);
  const transcript = derive(corpus, game, reports);
  const consumption = transcript.input.guestConsumption;

  assert.equal(
    consumption.kind,
    "rogue-leader-xwing-left-control-response-v1",
  );
  assert.equal(consumption.cycle, 1_400);
  assert.equal(consumption.controllerAppliedSequence, 3);
  assert.equal(consumption.hostPublication.scheduledCycle, 1_200);
  assert.equal(consumption.hostPublication.observedCycle, 1_300);
  assert.equal(consumption.hostPublication.buttons, 0x0001);
  assert.equal(consumption.hostPublication.sequence, 3);
  assert.equal(
    consumption.receipt.responseTransition.field460Delta,
    0.25,
  );
  assert.equal(
    consumption.receipt.responseTransition.field464Delta,
    -0.125,
  );
  assert.equal(consumption.receipt.responseTransition.xChanged, true);
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

test("Rogue Leader projector is exact-game, exact-revision, and left-only", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const reports = makeRogueLeaderFirstPlayableReportPair(game);

  assert.equal(
    project({ ...game, key: "f-zero-gx-usa" }, reports),
    null,
  );
  assert.throws(
    () => project(
      { ...game, disc: { ...game.disc, identifier: "GSWP64" } },
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
});

test("Rogue Leader validates fixed and dynamic effective addresses", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const fixedAddressPaths = [
    "identity.headerAddress",
    "level.indexAddress",
    "level.sublevelIndexAddress",
    "playerManager.address",
    "playerManager.activeCraftPointerAddress",
    "playerManager.activeCraftHandleAddress",
    "playerManager.selectedCraftTypeAddress",
    "playerManager.stateAddress",
    "simulation.pointerAddress",
    "input.padAddress",
    "input.rawStickXAddress",
    "input.rawStickYAddress",
    "input.errorAddress",
    "input.normalizedStickXAddress",
    "input.normalizedStickYAddress",
    "input.globalStickXAddress",
    "input.globalStickYAddress",
    "craft.controlInput.stickXIndexAddress",
    "craft.controlInput.stickYIndexAddress",
    "craft.controlInput.stickXAddress",
    "craft.controlInput.stickYAddress",
  ];
  const dynamicRelativePaths = [
    "simulation.auxiliaryEnabledAddress",
    "simulation.auxiliaryModeAddress",
    "craft.identity.primaryVtableAddress",
    "craft.identity.interfaceVtableAddress",
    "craft.stateAddress",
    "craft.configPointerAddress",
    "craft.controlPointerAddress",
    "craft.transform.orientation0Address",
    "craft.transform.orientation1Address",
    "craft.transform.orientation2Address",
    "craft.transform.positionAddress",
    "craft.transform.velocityAddress",
    "craft.response.field45cAddress",
    "craft.response.field460Address",
    "craft.response.field464Address",
  ];
  const cases = [];
  for (const report of ["preReport", "postReport"]) {
    for (const path of [...fixedAddressPaths, ...dynamicRelativePaths]) {
      cases.push({
        name: `${report} rejects drifted ${path}`,
        mutate(reports) {
          driftHexAddress(reports[report].guestGame, path);
        },
        pattern: pathPattern(report, path),
      });
    }
  }
  assertRejectedCases(game, cases);

  for (const [name, mutate] of [
    ["aligned relocated craft", reports => relocateCraft(reports, 0x7fd82000)],
    ["aligned relocated config", reports => relocateConfig(reports, 0x7fd92000)],
    [
      "aligned relocated simulation manager",
      reports => relocateSimulation(reports, 0x7fdb2000),
    ],
  ]) {
    const reports = makeRogueLeaderFirstPlayableReportPair(game);
    mutate(reports);
    assert.doesNotThrow(() => project(game, reports), name);
  }

  assertRejectedCases(game, [
    {
      name: "coherently misaligned craft aliases fail closed",
      mutate(reports) {
        relocateCraft(reports, CRAFT + 2);
      },
      pattern: /playerManager\.activeCraft.*aligned|playerManager\.activeCraft/,
    },
    {
      name: "coherently misaligned config aliases fail closed",
      mutate(reports) {
        relocateConfig(reports, CRAFT_CONFIG + 2);
      },
      pattern: /craft\.config.*aligned|craft\.config/,
    },
    {
      name: "coherently misaligned simulation aliases fail closed",
      mutate(reports) {
        relocateSimulation(reports, SIMULATION_MANAGER + 2);
      },
      pattern: /simulation\.manager.*aligned|simulation\.manager/,
    },
  ]);
});

test("Rogue Leader state and receipt schemas reject extensions", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const stateObjects = [
    "",
    "identity",
    "level",
    "playerManager",
    "simulation",
    "input",
    "craft",
    "craft.identity",
    "craft.controlInput",
    "craft.transform",
    "craft.response",
    "neutralControlBaseline",
    "neutralControlBaseline.level",
    "neutralControlBaseline.craft",
    "neutralControlBaseline.response",
  ];
  const receiptObjects = [
    "lastActiveGameplayInput",
    "lastActiveGameplayInput.hostPublication",
    "lastActiveGameplayInput.level",
    "lastActiveGameplayInput.craft",
    "lastActiveGameplayInput.transform",
    "lastActiveGameplayInput.transform.orientation0",
    "lastActiveGameplayInput.simulation",
    "lastActiveGameplayInput.input",
    "lastActiveGameplayInput.response",
    "lastActiveGameplayInput.neutralBaseline",
    "lastActiveGameplayInput.neutralBaseline.response",
    "lastActiveGameplayInput.responseTransition",
  ];
  const cases = [];
  for (const report of ["preReport", "postReport"]) {
    for (const path of stateObjects) {
      cases.push({
        name: `${report} rejects an extra key at ${path || "guestGame"}`,
        mutate(reports) {
          const target = path === ""
            ? reports[report].guestGame
            : getPath(reports[report].guestGame, path);
          target.unexpected = 1;
        },
        pattern: path === ""
          ? new RegExp(`${report}\\.guestGame\\.\\[keys\\]`)
          : pathPattern(report, `${path}.[keys]`),
      });
    }
  }
  for (const path of receiptObjects) {
    cases.push({
      name: `receipt rejects an extra key at ${path}`,
      mutate({ postReport }) {
        getPath(postReport.guestGame, path).unexpected = 1;
      },
      pattern: pathPattern("postReport", `${path}.[keys]`),
    });
  }
  assertRejectedCases(game, cases);
});

test("Rogue Leader requires a neutral pre-state and exact live X-Wing path", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const cases = [
    {
      name: "pre-state already has a receipt",
      mutate({ preReport, postReport }) {
        preReport.guestGame.lastActiveGameplayInput =
          structuredClone(postReport.guestGame.lastActiveGameplayInput);
      },
      pattern: /preReport\.guestGame\.lastActiveGameplayInput/,
    },
    {
      name: "pre-state claims a matching receipt",
      mutate({ preReport }) {
        preReport.guestGame.receiptLifetimeMatches = true;
      },
      pattern: /preReport\.guestGame\.receiptLifetimeMatches/,
    },
    {
      name: "pre-state claims active flight",
      mutate({ preReport }) {
        preReport.guestGame.activeFlight = true;
      },
      pattern: /preReport\.guestGame\.activeFlight/,
    },
    {
      name: "pre-state claims prior host-left consumption",
      mutate({ preReport }) {
        preReport.guestGame.guestConsumedHostLeft = true;
      },
      pattern: /preReport\.guestGame\.guestConsumedHostLeft/,
    },
    {
      name: "pre input is not neutral",
      mutate({ preReport }) {
        preReport.guestGame.input.neutral = false;
      },
      pattern: /preReport\.guestGame\.input\.neutral/,
    },
    {
      name: "pre shaped control is not neutral",
      mutate({ preReport }) {
        preReport.guestGame.craft.controlInput.neutral = false;
      },
      pattern: /preReport\.guestGame\.craft\.controlInput\.neutral/,
    },
    {
      name: "pre raw X is not neutral",
      mutate({ preReport }) {
        preReport.guestGame.input.rawStickX = -36;
        const normalized = Math.fround(-36 / 72);
        preReport.guestGame.input.normalizedStickX = normalized;
        preReport.guestGame.input.expectedNormalizedStickX = normalized;
        preReport.guestGame.input.globalStickX = normalized;
        preReport.guestGame.craft.controlInput.stickX = -0.5;
        preReport.guestGame.input.neutral = false;
        preReport.guestGame.craft.controlInput.neutral = false;
      },
      pattern: /preReport\.guestGame\.craft\.controlInput\.hostLeftRetained|preReport\.guestGame\.input.*neutral/,
    },
    {
      name: "missing neutral baseline",
      mutate({ preReport }) {
        preReport.guestGame.neutralControlBaseline = null;
      },
      pattern: /preReport\.guestGame\.neutralControlBaseline/,
    },
  ];
  for (const report of ["preReport", "postReport"]) {
    for (const [field, value] of [
      ["identity.exact", false],
      ["playerManager.mapped", false],
      ["craft.mapped", false],
      ["craft.identity.exact", false],
      ["craft.exactControl", false],
      ["craft.controlInput.exactMapping", false],
      ["craft.controlInput.valid", false],
      ["craft.valid", false],
      ["controlsEnabled", false],
      ["liveXwingControlPath", false],
      ["normalCraftState", false],
      ["normalStateTransformValid", false],
    ]) {
      cases.push({
        name: `${report} rejects ${field}`,
        mutate(reports) {
          setPath(reports[report].guestGame, field, value);
        },
        pattern: pathPattern(report, field),
      });
    }
    for (const [field, value] of [
      ["identity.gameCode", "0x47535750"],
      ["identity.makerCode", 0x3031],
      ["identity.discNumber", 1],
      ["identity.revision", 1],
      ["playerManager.selectedCraftType", 1],
      ["craft.identity.primaryVtable", "0x7fdbe500"],
      ["craft.identity.interfaceVtable", "0x7fdbe504"],
      ["craft.identity.type", "y-wing"],
      ["craft.state", 3],
      ["craft.control", "0x7fdf0fa8"],
      ["craft.controlInput.stickXIndex", 1],
      ["craft.controlInput.stickYIndex", 0],
    ]) {
      cases.push({
        name: `${report} rejects invalid ${field}`,
        mutate(reports) {
          setPath(reports[report].guestGame, field, value);
        },
        pattern: field === "craft.state"
          ? pathPattern(report, "normalCraftState")
          : pathPattern(report, field),
      });
    }
  }
  for (const [field, value] of [
    ["receiptLifetimeMatches", false],
    ["activeFlight", false],
    ["guestConsumedHostLeft", false],
  ]) {
    cases.push({
      name: `post-state rejects ${field}=false`,
      mutate({ postReport }) {
        postReport.guestGame[field] = value;
      },
      pattern: pathPattern("postReport", field),
    });
  }
  assertRejectedCases(game, cases);
});

test("Rogue Leader recomputes PAD normalization and shaped-axis coherence", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const cases = [];
  for (const report of ["preReport", "postReport"]) {
    for (const [field, value] of [
      ["input.padMapped", false],
      ["input.error", 1],
      ["input.valuesValid", false],
      ["input.rawNormalizationCoherent", false],
      ["input.globalAxesCoherent", false],
      ["input.shapedControlCoherent", false],
      ["input.pipelineCoherent", false],
    ]) {
      cases.push({
        name: `${report} rejects ${field}`,
        mutate(reports) {
          setPath(reports[report].guestGame, field, value);
        },
        pattern: pathPattern(report, field),
      });
    }
    cases.push(
      {
        name: `${report} rejects non-finite normalized X`,
        mutate(reports) {
          reports[report].guestGame.input.normalizedStickX = Number.NaN;
        },
        pattern: pathPattern(report, "input.normalizedStickX"),
      },
      {
        name: `${report} rejects a forged expected normalized X`,
        mutate(reports) {
          reports[report].guestGame.input.expectedNormalizedStickX = 0.25;
        },
        pattern: pathPattern(report, "input.expectedNormalizedStickX"),
      },
      {
        name: `${report} rejects a global X mismatch`,
        mutate(reports) {
          reports[report].guestGame.input.globalStickX = 0.25;
        },
        pattern: pathPattern(report, "input.globalAxesCoherent"),
      },
      {
        name: `${report} rejects a non-negated global Y`,
        mutate(reports) {
          const input = reports[report].guestGame.input;
          input.rawStickY = -8;
          input.normalizedStickY = Math.fround(-8 / 72);
          input.expectedNormalizedStickY = Math.fround(-8 / 72);
          input.globalStickY = input.normalizedStickY;
        },
        pattern: pathPattern(report, "input.globalAxesCoherent"),
      },
      {
        name: `${report} rejects incoherent shaped X`,
        mutate(reports) {
          reports[report].guestGame.craft.controlInput.stickX = 0.5;
        },
        pattern: pathPattern(report, "craft.controlInput.neutral"),
      },
    );
  }
  cases.push(
    {
      name: "receipt raw X is too weak",
      mutate({ postReport }) {
        const input = postReport.guestGame.lastActiveGameplayInput.input;
        input.rawStickX = -35;
        input.normalizedStickX = Math.fround(-35 / 72);
        input.globalStickX = input.normalizedStickX;
      },
      pattern: /lastActiveGameplayInput\.input/,
    },
    {
      name: "receipt raw X is outside s8",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.rawStickX = -129;
      },
      pattern: /lastActiveGameplayInput\.input\.rawStickX/,
    },
    {
      name: "receipt raw Y is not horizontal",
      mutate({ postReport }) {
        const input = postReport.guestGame.lastActiveGameplayInput.input;
        input.rawStickY = 17;
        input.normalizedStickY = Math.fround(17 / 72);
        input.globalStickY = -input.normalizedStickY;
        input.stickY = -0.1;
      },
      pattern: /lastActiveGameplayInput\.input/,
    },
    {
      name: "receipt normalized X does not equal fround(raw/72)",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .input.normalizedStickX = -1;
      },
      pattern: /lastActiveGameplayInput\.input\.normalizedStickX/,
    },
    {
      name: "receipt normalized Y does not equal fround(raw/72)",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .input.normalizedStickY = 0.25;
      },
      pattern: /lastActiveGameplayInput\.input\.normalizedStickY/,
    },
    {
      name: "receipt global X does not retain normalized X",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.globalStickX = -1;
      },
      pattern: /lastActiveGameplayInput\.input\.globalStickX/,
    },
    {
      name: "receipt global Y is not the normalized-Y negation",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.globalStickY = 0.25;
      },
      pattern: /lastActiveGameplayInput\.input\.globalStickY/,
    },
    {
      name: "receipt shaped X is too weak",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.stickX = -0.49;
      },
      pattern: /lastActiveGameplayInput\.input/,
    },
    {
      name: "receipt shaped X exceeds its range",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.stickX = -1.01;
      },
      pattern: /lastActiveGameplayInput\.input\.stickX/,
    },
    {
      name: "receipt shaped Y is not horizontal",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.stickY = 0.126;
      },
      pattern: /lastActiveGameplayInput\.input/,
    },
  );
  assertRejectedCases(game, cases);

  const negatedY = makeRogueLeaderFirstPlayableReportPair(game);
  const input = negatedY.postReport.guestGame.lastActiveGameplayInput.input;
  input.rawStickY = -8;
  input.normalizedStickY = Math.fround(-8 / 72);
  input.globalStickY = -input.normalizedStickY;
  input.stickY = 0.1;
  assert.doesNotThrow(
    () => project(game, negatedY),
    "a coherent Y-negated horizontal sample remains valid",
  );
});

test("Rogue Leader requires finite orthonormal state and receipt transforms", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const cases = [];
  for (const report of ["preReport", "postReport"]) {
    cases.push(
      {
        name: `${report} rejects a non-finite transform vector`,
        mutate(reports) {
          reports[report].guestGame.craft.transform.position.x = Number.NaN;
        },
        pattern: pathPattern(report, "craft.transform.position.x"),
      },
      {
        name: `${report} recomputes orthonormality`,
        mutate(reports) {
          reports[report].guestGame.craft.transform.orientation0.x = 2;
        },
        pattern: pathPattern(report, "craft.transform.orthonormal"),
      },
      {
        name: `${report} rejects finite=false`,
        mutate(reports) {
          reports[report].guestGame.craft.transform.finite = false;
        },
        pattern: pathPattern(report, "craft.transform.finite"),
      },
      {
        name: `${report} rejects orthonormal=false`,
        mutate(reports) {
          reports[report].guestGame.craft.transform.orthonormal = false;
        },
        pattern: pathPattern(report, "craft.transform.orthonormal"),
      },
      {
        name: `${report} rejects a forged orientation determinant`,
        mutate(reports) {
          reports[report].guestGame.craft.transform.determinant = -1;
        },
        pattern: pathPattern(report, "craft.transform.determinant"),
      },
      {
        name: `${report} rejects rightHanded=false`,
        mutate(reports) {
          reports[report].guestGame.craft.transform.rightHanded = false;
        },
        pattern: pathPattern(report, "craft.transform.rightHanded"),
      },
      {
        name: `${report} rejects a mirrored orthonormal basis`,
        mutate(reports) {
          const transform = reports[report].guestGame.craft.transform;
          transform.orientation2.z = -1;
          transform.determinant = -1;
          transform.rightHanded = false;
        },
        pattern: pathPattern(report, "craft.transform.rightHanded"),
      },
      {
        name: `${report} rejects a non-finite response`,
        mutate(reports) {
          reports[report].guestGame.craft.response.field460 = Infinity;
        },
        pattern: pathPattern(report, "craft.response.field460"),
      },
      {
        name: `${report} rejects response finite=false`,
        mutate(reports) {
          reports[report].guestGame.craft.response.finite = false;
        },
        pattern: pathPattern(report, "craft.response.finite"),
      },
    );
  }
  for (const [path, value] of [
    ["transform.orientation1.y", Number.NaN],
    ["transform.orientation2.z", 2],
    ["transform.orientation2.z", -1],
    ["transform.position.x", Infinity],
    ["transform.velocity.z", Number.NaN],
    ["response.field460", Number.NaN],
    ["neutralBaseline.response.field464", Infinity],
  ]) {
    cases.push({
      name: `receipt rejects invalid ${path}`,
      mutate({ postReport }) {
        setPath(postReport.guestGame.lastActiveGameplayInput, path, value);
      },
      pattern: path === "transform.orientation2.z"
        ? value === -1
          ? /lastActiveGameplayInput\.transform\.orientation2/
          : /lastActiveGameplayInput\.transform\.orientation0/
        : new RegExp(`lastActiveGameplayInput\\.${path.split(".").slice(0, 2).join("\\.")}`),
    });
  }
  assertRejectedCases(game, cases);
});

test("Rogue Leader binds the neutral baseline and receipt to one craft lifetime", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const cases = [];
  const stateLifetime = [
    ["level.index", 1],
    ["level.sublevelIndex", 1],
    ["playerManager.activeCraftHandle", 43],
    ["craft.config", "0x7fd92000"],
    ["craft.control", "0x7fdf0fa8"],
    ["craft.identity.primaryVtable", "0x7fdbe500"],
    ["craft.identity.interfaceVtable", "0x7fdbe504"],
  ];
  for (const [path, value] of stateLifetime) {
    cases.push({
      name: `post-state rejects changed ${path}`,
      mutate({ postReport }) {
        setPath(postReport.guestGame, path, value);
      },
      pattern: path === "playerManager.activeCraftHandle"
        ? /postReport\.guestGame\.craft\.handle/
        : pathPattern("postReport", path),
    });
  }
  const receiptLifetime = [
    ["level.index", 1],
    ["level.sublevelIndex", 1],
    ["craft.address", "0x7fd82000"],
    ["craft.handle", 43],
    ["craft.config", "0x7fd92000"],
    ["craft.control", "0x7fdf0fa8"],
    ["craft.primaryVtable", "0x7fdbe500"],
    ["craft.interfaceVtable", "0x7fdbe504"],
    ["craft.type", "y-wing"],
    ["craft.state", 3],
  ];
  for (const [path, value] of receiptLifetime) {
    cases.push({
      name: `receipt rejects changed ${path}`,
      mutate({ postReport }) {
        setPath(
          postReport.guestGame.lastActiveGameplayInput,
          path,
          value,
        );
      },
      pattern: new RegExp(`lastActiveGameplayInput\\.${path.replaceAll(".", "\\.")}`),
    });
  }
  const retainedBaselineLifetime = [
    ["level.index", 1],
    ["level.sublevelIndex", 1],
    ["craft.address", "0x7fd82000"],
    ["craft.handle", 43],
    ["craft.config", "0x7fd92000"],
    ["craft.control", "0x7fdf0fa8"],
    ["craft.primaryVtable", "0x7fdbe500"],
    ["craft.interfaceVtable", "0x7fdbe504"],
    ["craft.state", 3],
  ];
  for (const [path, value] of retainedBaselineLifetime) {
    cases.push({
      name: `retained baseline rejects changed ${path}`,
      mutate({ postReport }) {
        setPath(postReport.guestGame.neutralControlBaseline, path, value);
      },
      pattern: new RegExp(`neutralControlBaseline\\.${path.replaceAll(".", "\\.")}`),
    });
  }
  cases.push(
    {
      name: "receipt player manager is not exact",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.playerManager =
          "0x7fdefe18";
      },
      pattern: /lastActiveGameplayInput\.playerManager/,
    },
    {
      name: "post baseline cycle differs from receipt baseline",
      mutate({ postReport }) {
        postReport.guestGame.neutralControlBaseline.cycle += 1;
      },
      pattern: /neutralControlBaseline\.cycle|neutralBaseline\.cycle/,
    },
    {
      name: "post baseline sequence differs from receipt baseline",
      mutate({ postReport }) {
        postReport.guestGame.neutralControlBaseline
          .controllerAppliedSequence += 1;
      },
      pattern: /neutralControlBaseline\.controllerAppliedSequence|neutralBaseline/,
    },
    {
      name: "post baseline response differs from receipt baseline",
      mutate({ postReport }) {
        postReport.guestGame.neutralControlBaseline.response.field460 = 0.1;
      },
      pattern: /neutralControlBaseline\.response\.field460|neutralBaseline/,
    },
  );
  assertRejectedCases(game, cases);
});

test("Rogue Leader receipt publication and neutral baseline are exactly chronological", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const cases = [
    {
      name: "missing receipt",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput = null;
      },
      pattern: /lastActiveGameplayInput.*expected an object/,
    },
    {
      name: "receipt predates pre-report",
      mutate({ preReport, postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          preReport.cycles - 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "receipt follows post-report",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.cycle =
          postReport.cycles + 1;
      },
      pattern: /lastActiveGameplayInput\.cycle/,
    },
    {
      name: "publication source is unsupported",
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
          .hostPublication.buttons = 0x0002;
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
      name: "publication did not advance pre-report poll",
      mutate({ preReport, postReport }) {
        const pollIndex = preReport.controller.pollIndex;
        postReport.controller.lastActiveHostPublication.pollIndex = pollIndex;
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.pollIndex = pollIndex;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.pollIndex/,
    },
    {
      name: "publication was scheduled before pre-report",
      mutate({ preReport, postReport }) {
        const scheduledCycle = preReport.cycles - 1;
        postReport.controller.lastActiveHostPublication.scheduledCycle =
          scheduledCycle;
        postReport.guestGame.lastActiveGameplayInput
          .hostPublication.scheduledCycle = scheduledCycle;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.scheduledCycle/,
    },
    {
      name: "publication sequence did not advance pre-report sequence",
      mutate({ preReport, postReport }) {
        const sequence = preReport.controller.appliedSequence;
        postReport.controller.lastActiveHostPublication.sequence = sequence;
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.sequence = sequence;
        receipt.controllerAppliedSequence = sequence;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.sequence/,
    },
    {
      name: "publication timing is reversed",
      mutate({ postReport }) {
        const host = postReport.guestGame.lastActiveGameplayInput
          .hostPublication;
        host.scheduledCycle = host.observedCycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "publication was observed after receipt",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.observedCycle = receipt.cycle + 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication/,
    },
    {
      name: "receipt applied sequence differs from publication",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .controllerAppliedSequence += 1;
      },
      pattern: /lastActiveGameplayInput\.controllerAppliedSequence/,
    },
    {
      name: "receipt publication differs from terminal publication",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.hostPublication.sequence -= 1;
        receipt.controllerAppliedSequence -= 1;
      },
      pattern: /lastActiveGameplayInput\.hostPublication\.sequence/,
    },
    {
      name: "neutral baseline reaches publication observation",
      mutate({ postReport }) {
        const guest = postReport.guestGame;
        const cycle = guest.lastActiveGameplayInput
          .hostPublication.observedCycle;
        guest.neutralControlBaseline.cycle = cycle;
        guest.lastActiveGameplayInput.neutralBaseline.cycle = cycle;
      },
      pattern: /lastActiveGameplayInput\.neutralBaseline/,
    },
    {
      name: "neutral baseline sequence reaches host sequence",
      mutate({ postReport }) {
        const guest = postReport.guestGame;
        const sequence = guest.lastActiveGameplayInput
          .hostPublication.sequence;
        guest.neutralControlBaseline.controllerAppliedSequence = sequence;
        guest.lastActiveGameplayInput.neutralBaseline
          .controllerAppliedSequence = sequence;
      },
      pattern: /lastActiveGameplayInput\.neutralBaseline/,
    },
    {
      name: "neutral baseline predates the retained pre baseline",
      mutate({ preReport, postReport }) {
        const cycle = preReport.guestGame.neutralControlBaseline.cycle - 1;
        postReport.guestGame.neutralControlBaseline.cycle = cycle;
        postReport.guestGame.lastActiveGameplayInput
          .neutralBaseline.cycle = cycle;
      },
      pattern: /neutralBaseline\.cycle|neutralControlBaseline\.cycle/,
    },
    {
      name: "neutral baseline sequence regresses from the pre baseline",
      mutate({ preReport, postReport }) {
        preReport.guestGame.neutralControlBaseline
          .controllerAppliedSequence = 1;
        const sequence = 0;
        postReport.guestGame.neutralControlBaseline
          .controllerAppliedSequence = sequence;
        postReport.guestGame.lastActiveGameplayInput.neutralBaseline
          .controllerAppliedSequence = sequence;
      },
      pattern: /neutralBaseline\.controllerAppliedSequence|neutralControlBaseline/,
    },
  ];
  assertRejectedCases(game, cases);
});

test("Rogue Leader recomputes a magnitude-only X response transition", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);

  const oppositeSign = makeRogueLeaderFirstPlayableReportPair(game);
  setReceiptResponse(oppositeSign, -0.25, 0.125);
  const projected = project(game, oppositeSign);
  assert.equal(projected.receipt.responseTransition.field460Delta, -0.25);
  assert.equal(projected.receipt.responseTransition.field464Delta, 0.125);
  assert.equal(projected.receipt.responseTransition.xChanged, true);

  assertRejectedCases(game, [
    {
      name: "zero response transition is not consumption evidence",
      mutate(reports) {
        setReceiptResponse(reports, 0, 0);
      },
      pattern: /responseTransition.*changed|responseTransition/,
    },
    {
      name: "stale response is not consumption evidence",
      mutate({ postReport }) {
        const receipt = postReport.guestGame.lastActiveGameplayInput;
        receipt.neutralBaseline.response.field460 = receipt.response.field460;
        receipt.neutralBaseline.response.field464 = receipt.response.field464;
        postReport.guestGame.neutralControlBaseline.response.field460 =
          receipt.response.field460;
        postReport.guestGame.neutralControlBaseline.response.field464 =
          receipt.response.field464;
        receipt.responseTransition.field460Delta = 0;
        receipt.responseTransition.field464Delta = 0;
        receipt.responseTransition.xChanged = false;
      },
      pattern: /responseTransition.*changed|responseTransition/,
    },
    {
      name: "forged response delta is rejected",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .responseTransition.field460Delta = 0.5;
      },
      pattern: /responseTransition\.field460Delta/,
    },
    {
      name: "forged second response delta is rejected",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .responseTransition.field464Delta = -0.5;
      },
      pattern: /responseTransition\.field464Delta/,
    },
    {
      name: "xChanged=false contradicts a measured delta",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput
          .responseTransition.xChanged = false;
      },
      pattern: /responseTransition\.xChanged/,
    },
  ]);
});

test("Rogue Leader accepts released current input, auxiliary changes, and no physical delta", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = rogueLeaderGame(corpus);
  const reports = makeRogueLeaderFirstPlayableReportPair(game);

  assert.equal(reports.postReport.guestGame.input.neutral, true);
  assert.equal(
    reports.postReport.guestGame.craft.controlInput.neutral,
    true,
  );
  assert.deepEqual(
    reports.preReport.guestGame.craft.transform.position,
    reports.postReport.guestGame.lastActiveGameplayInput.transform.position,
  );
  assert.deepEqual(
    reports.postReport.guestGame.lastActiveGameplayInput.transform.position,
    reports.postReport.guestGame.craft.transform.position,
  );
  assert.deepEqual(
    reports.preReport.guestGame.craft.transform.orientation0,
    reports.postReport.guestGame.craft.transform.orientation0,
  );

  reports.preReport.guestGame.craft.transform.velocity = { x: 0, y: 0, z: 0 };
  reports.postReport.guestGame.craft.transform.velocity = { x: 0, y: 0, z: 0 };
  reports.postReport.guestGame.lastActiveGameplayInput.transform.velocity =
    { x: 0, y: 0, z: 0 };
  reports.postReport.guestGame.simulation.auxiliaryEnabled = 0;
  reports.postReport.guestGame.simulation.auxiliaryMode = 0;
  reports.postReport.guestGame.simulation.auxiliaryControlMode = false;
  reports.postReport.guestGame.lastActiveGameplayInput
    .simulation.auxiliaryEnabled = 0;
  reports.postReport.guestGame.lastActiveGameplayInput
    .simulation.auxiliaryMode = 0;
  reports.postReport.guestGame.lastActiveGameplayInput.input.buttons = 1;

  const consumption = project(game, reports);
  assert.equal(consumption.cycle, 1_400);
  assert.equal(consumption.post.presentationCycle, 1_900);
  assert.equal(consumption.receipt.input.buttons, 1);
  assert.equal(consumption.receipt.responseTransition.xChanged, true);

  const absentSimulation = makeRogueLeaderFirstPlayableReportPair(game);
  Object.assign(absentSimulation.postReport.guestGame.simulation, {
    manager: null,
    auxiliaryEnabledAddress: null,
    auxiliaryEnabled: null,
    auxiliaryModeAddress: null,
    auxiliaryMode: null,
    auxiliaryControlMode: false,
  });
  Object.assign(
    absentSimulation.postReport.guestGame.lastActiveGameplayInput.simulation,
    {
      manager: null,
      auxiliaryEnabled: null,
      auxiliaryMode: null,
    },
  );
  assert.deepEqual(project(game, absentSimulation).receipt.simulation, {
    manager: null,
    auxiliaryEnabled: null,
    auxiliaryMode: null,
  });

  assertRejectedCases(game, [
    {
      name: "receipt null simulation manager cannot carry live auxiliaries",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.simulation.manager = null;
      },
      pattern: /lastActiveGameplayInput\.simulation\.auxiliaryEnabled/,
    },
    {
      name: "browser presentation predates the retained receipt",
      mutate({ postReport }) {
        postReport.mmioState.viInterruptModel.lastHostPresentationCycle =
          postReport.guestGame.lastActiveGameplayInput.cycle - 1;
      },
      pattern: /lastHostPresentationCycle/,
    },
    {
      name: "receipt button word remains a strict u16",
      mutate({ postReport }) {
        postReport.guestGame.lastActiveGameplayInput.input.buttons = 0x10000;
      },
      pattern: /lastActiveGameplayInput\.input\.buttons/,
    },
  ]);
});
