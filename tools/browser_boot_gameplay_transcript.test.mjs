#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GAMEPLAY_TRANSCRIPT_SCHEMA_V1,
  GameplayTranscriptValidationError,
  SMB_READY_PLAY_GAMEPLAY_PLAN,
  deriveGameplayTranscript,
  deriveSmbReadyPlayGameplayTranscript,
  validateGameplayTranscript,
  validateSmbReadyPlayGameplayTranscript,
  verifyGameplayTranscript,
  verifySmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  gameplayReport,
  gameplayReportsForConsensus,
  gameplayTranscript,
} from "./browser_boot_gameplay_transcript_fixture.mjs";

const WITNESS_KEYS = [
  "pad",
  "gameModeRequest",
  "gameMode",
  "gameSubmodeRequest",
  "gameSubmode",
  "warningState",
  "warningDialogPhase",
  "warningDialogFlags",
  "submodeTimer",
  "difficulty",
  "flags",
  "titleChoice",
  "menuSelection",
  "playerCount",
  "gameType",
  "currentPlayer",
  "characterSelection0",
  "textBoxState",
  "textBoxTimer",
  "selectorCurrent",
  "selectorRequest",
  "selectorChoice",
  "characterLocked0",
  "infoFlags",
  "infoTimer",
  "attempts",
  "floor",
  "pauseStatus",
  "inputLockStatus",
  "demoSkipTimer",
  "demoResourcesReady",
  "gameVersion",
].sort();

function expectFailure(callback, code, pathPattern) {
  assert.throws(
    callback,
    error => error instanceof GameplayTranscriptValidationError
      && error.code === code
      && pathPattern.test(error.path),
  );
}

test("SMB plan is deeply frozen data with the exact retail route", () => {
  assert.equal(Object.isFrozen(SMB_READY_PLAY_GAMEPLAY_PLAN), true);
  assert.equal(Object.isFrozen(SMB_READY_PLAY_GAMEPLAY_PLAN.steps), true);
  assert.equal(SMB_READY_PLAY_GAMEPLAY_PLAN.game.identifier, "GMBE8P");
  assert.equal(SMB_READY_PLAY_GAMEPLAY_PLAN.game.revision, 0);
  assert.equal(SMB_READY_PLAY_GAMEPLAY_PLAN.scenario.id, "smb-ready-play");
  assert.equal(SMB_READY_PLAY_GAMEPLAY_PLAN.scenario.hardCycleLimit, 30_000_000_000);
  assert.deepEqual(
    SMB_READY_PLAY_GAMEPLAY_PLAN.steps.map(step => [step.id, step.type, step.button ?? null]),
    [
      ["memory-card-back", "input", 0x0200],
      ["skip-opening-demo", "input", 0x1000],
      ["opening-demo-skipped", "observe", null],
      ["title-start", "input", 0x1000],
      ["title-game-start", "input", 0x0100],
      ["select-current-8", "input", 0x0100],
      ["select-current-10", "input", 0x0100],
      ["select-current-16", "input", 0x0100],
      ["select-current-18", "input", 0x0100],
      ["select-current-22", "input", 0x0100],
      ["ready-main", "observe", null],
      ["play-main", "observe", null],
      ["post-play-presented", "observe", null],
    ],
  );
});

test("independent fixture defines the strict shape and derivation matches it", () => {
  const transcript = gameplayTranscript();
  assert.equal(transcript.schema, GAMEPLAY_TRANSCRIPT_SCHEMA_V1);
  assert.deepEqual(Object.keys(transcript), ["schema", "game", "scenario", "controller", "steps"]);
  assert.deepEqual(Object.keys(transcript.game), ["identifier", "revision"]);
  assert.deepEqual(
    Object.keys(transcript.scenario),
    ["id", "status", "hardCycleLimit", "startCycle", "completedCycle"],
  );
  assert.deepEqual(
    Object.keys(transcript.controller),
    [
      "pollIndex",
      "appliedSequence",
      "lastPolledSequence",
      "lastPolledButtons",
      "pendingButtons",
      "queuedStates",
      "queueOverflows",
    ],
  );
  assert.equal(transcript.steps.length, 13);
  const input = transcript.steps[0];
  assert.deepEqual(
    Object.keys(input),
    ["id", "type", "button", "ready", "press", "release", "guest", "completed"],
  );
  assert.deepEqual(Object.keys(input.ready), ["cycle", "pollIndex", "witness"]);
  assert.deepEqual(Object.keys(input.ready.witness).sort(), WITNESS_KEYS);
  assert.deepEqual(Object.keys(input.ready.witness.pad), ["held", "pressed", "released"]);
  assert.equal(Object.hasOwn(input.ready.witness, "cycle"), false);
  assert.equal(Object.hasOwn(input.ready.witness, "viPresentationCount"), false);
  assert.deepEqual(Object.keys(input.press), ["sequence", "publications"]);
  assert.equal(Object.hasOwn(input.press, "polls"), false);
  assert.equal(Object.hasOwn(input.press, "firstPollIndex"), false);
  assert.deepEqual(
    Object.keys(input.press.publications[0]),
    ["source", "pollIndex", "scheduledCycle", "observedCycle", "buttons", "sequence"],
  );
  assert.deepEqual(
    Object.keys(transcript.steps[2]),
    ["id", "type", "observed"],
  );
  assert.doesNotThrow(() => validateSmbReadyPlayGameplayTranscript(transcript));
  assert.deepEqual(
    deriveSmbReadyPlayGameplayTranscript(gameplayReport()),
    transcript,
  );
});

test("host diagnostics and object insertion order do not affect derivation", () => {
  const reports = gameplayReportsForConsensus();
  const expected = gameplayTranscript();
  for (const report of reports) {
    assert.deepEqual(deriveSmbReadyPlayGameplayTranscript(report), expected);
  }

  const reordered = gameplayReport();
  reordered.scenario.steps[0].readyState = Object.fromEntries(
    Object.entries(reordered.scenario.steps[0].readyState).reverse(),
  );
  reordered.scenario.steps[0].press.publications[0] = Object.fromEntries(
    Object.entries(reordered.scenario.steps[0].press.publications[0]).reverse(),
  );
  const reversedTopLevel = Object.fromEntries(Object.entries(reordered).reverse());
  assert.deepEqual(deriveSmbReadyPlayGameplayTranscript(reversedTopLevel), expected);
});

test("guest witnesses and valid event timing remain transcript evidence", () => {
  const report = gameplayReport();
  const original = gameplayTranscript();
  report.scenario.steps[0].readyState.menuSelection += 1;
  const changedWitness = deriveSmbReadyPlayGameplayTranscript(report);
  assert.notDeepEqual(changedWitness, original);

  const delayed = gameplayReport();
  delayed.scenario.steps[0].readyCycle += 1;
  delayed.scenario.steps[0].readyState.cycle += 1;
  assert.notDeepEqual(deriveSmbReadyPlayGameplayTranscript(delayed), original);
});

test("stable per-step witness predicates are independently enforced", () => {
  const cases = [
    transcript => { transcript.steps[0].ready.witness.pad.pressed = 0x0200; },
    transcript => { transcript.steps[0].ready.witness.gameSubmode = 5; },
    transcript => { transcript.steps[2].observed.witness.flags = 0; },
    transcript => { transcript.steps[4].ready.witness.flags = 0x2000; },
    transcript => { transcript.steps[6].ready.witness.selectorCurrent = 8; },
    transcript => { transcript.steps[10].observed.witness.gameSubmode = 48; },
    transcript => { transcript.steps[11].observed.witness.floor = 0; },
  ];
  for (const mutate of cases) {
    const transcript = gameplayTranscript();
    mutate(transcript);
    expectFailure(
      () => validateSmbReadyPlayGameplayTranscript(transcript),
      "provenance",
      /witness/,
    );
  }
});

test("terminal, identity, and overflow hard gates fail at their source", () => {
  const cases = [
    ["status", report => { report.status = "running"; }, "provenance", /\$report\.status$/],
    ["stage", report => { report.stage = "cycle-limit"; }, "provenance", /\$report\.stage$/],
    ["disc", report => { report.disc.identifier = "GZLE01"; }, "identity", /disc\.identifier$/],
    ["revision", report => { report.disc.revision = 1; }, "identity", /disc\.revision$/],
    [
      "scenario game",
      report => { report.scenario.gameIdentifier = "GZLE01"; },
      "identity",
      /scenario\.gameIdentifier$/,
    ],
    ["scenario status", report => { report.scenario.status = "failed"; }, "provenance", /scenario\.status$/],
    [
      "failure",
      report => { report.scenario.failure = { reason: "boom" }; },
      "provenance",
      /scenario\.failure$/,
    ],
    ["current step", report => { report.scenario.currentStep = "done"; }, "provenance", /currentStep$/],
    ["terminal cycle", report => { report.cycles -= 1; }, "provenance", /\$report\.cycles$/],
    ["poll parity", report => { report.controller.pollIndex -= 1; }, "provenance", /controller\.pollIndex$/],
    [
      "applied sequence",
      report => { report.controller.appliedSequence = 17; },
      "provenance",
      /appliedSequence$/,
    ],
    [
      "last sequence",
      report => { report.controller.lastPolledSequence = 17; },
      "provenance",
      /lastPolledSequence$/,
    ],
    [
      "held terminal",
      report => { report.controller.lastPolledButtons = 0x0100; },
      "provenance",
      /lastPolledButtons$/,
    ],
    [
      "pending terminal",
      report => { report.controller.pendingButtons = 0x0100; },
      "provenance",
      /pendingButtons$/,
    ],
    ["queued terminal", report => { report.controller.queuedStates = 1; }, "provenance", /queuedStates$/],
    ["overflow", report => { report.controller.queueOverflows = 1; }, "overflow", /queueOverflows$/],
  ];
  for (const [name, mutate, code, path] of cases) {
    const report = gameplayReport();
    mutate(report);
    assert.throws(
      () => deriveSmbReadyPlayGameplayTranscript(report),
      error => error instanceof GameplayTranscriptValidationError
        && error.code === code
        && path.test(error.path),
      name,
    );
  }
});

test("redundant scenario aggregates must agree with publication arrays", () => {
  const cases = [
    report => { report.scenario.steps[0].press.polls = 2; },
    report => { report.scenario.steps[0].release.firstPollIndex += 1; },
    report => { report.scenario.steps[0].press.lastScheduledCycle += 1; },
    report => { report.scenario.steps[0].release.firstObservedCycle += 1; },
    report => { report.scenario.stepIndex -= 1; },
    report => { report.scenario.lastState.floor += 1; },
  ];
  for (const mutate of cases) {
    const report = gameplayReport();
    mutate(report);
    expectFailure(
      () => deriveSmbReadyPlayGameplayTranscript(report),
      "provenance",
      /scenario|press|release/,
    );
  }
});

test("publication provenance and global ordering are independently enforced", () => {
  const cases = [
    [
      "duplicate poll",
      report => {
        const publications = report.scenario.steps[0].press.publications;
        publications[1].pollIndex = publications[0].pollIndex;
      },
      "ordering",
      /pollIndex$/,
    ],
    [
      "source",
      report => { report.scenario.steps[0].press.publications[1].source = "direct"; },
      "provenance",
      /source$/,
    ],
    [
      "buttons",
      report => { report.scenario.steps[0].press.publications[1].buttons = 0; },
      "provenance",
      /buttons$/,
    ],
    [
      "sequence",
      report => { report.scenario.steps[0].press.publications[1].sequence = 2; },
      "provenance",
      /sequence$/,
    ],
    [
      "observed before scheduled",
      report => {
        const publication = report.scenario.steps[0].press.publications[1];
        publication.observedCycle = publication.scheduledCycle - 1;
      },
      "ordering",
      /observedCycle$/,
    ],
    [
      "scheduled regression",
      report => {
        const publications = report.scenario.steps[0].press.publications;
        publications[1].scheduledCycle = publications[0].scheduledCycle - 1;
      },
      "ordering",
      /scheduledCycle$/,
    ],
    [
      "missing pulse poll",
      report => {
        const step = report.scenario.steps[0];
        const publications = [...step.press.publications, ...step.release.publications];
        for (const publication of publications.slice(1)) publication.pollIndex += 1;
        step.press.lastPollIndex += 1;
        step.release.firstPollIndex += 1;
        step.release.lastPollIndex += 1;
        step.completedPollIndex += 1;
      },
      "ordering",
      /pollIndex$/,
    ],
  ];
  for (const [name, mutate, code, path] of cases) {
    const report = gameplayReport();
    mutate(report);
    assert.throws(
      () => deriveSmbReadyPlayGameplayTranscript(report),
      error => error instanceof GameplayTranscriptValidationError
        && error.code === code
        && path.test(error.path),
      name,
    );
  }
});

test("guest edges, completion, and terminal observation retain chronology", () => {
  const cases = [
    [
      transcript => { transcript.steps[0].guest.releasedCycle = transcript.steps[0].guest.pressedCycle; },
      "ordering",
    ],
    [
      transcript => { transcript.steps[0].guest.neutralCycle = transcript.steps[0].guest.releasedCycle; },
      "ordering",
    ],
    [
      transcript => { transcript.steps[0].completed.cycle = transcript.steps[0].guest.neutralCycle - 1; },
      "ordering",
    ],
    [transcript => { transcript.steps[0].completed.pollIndex -= 1; }, "provenance"],
    [transcript => { transcript.steps.at(-1).observed.cycle -= 1; }, "provenance"],
    [transcript => { transcript.steps.at(-1).observed.pollIndex -= 1; }, "provenance"],
  ];
  for (const [mutate, code] of cases) {
    const transcript = gameplayTranscript();
    mutate(transcript);
    expectFailure(
      () => validateSmbReadyPlayGameplayTranscript(transcript),
      code,
      /guest|completed|observed/,
    );
  }
});

test("plans reject ambiguity before report projection", () => {
  const duplicate = structuredClone(SMB_READY_PLAY_GAMEPLAY_PLAN);
  duplicate.steps[1].id = duplicate.steps[0].id;
  expectFailure(() => deriveGameplayTranscript(gameplayReport(), duplicate), "identity", /steps\[1\]\.id$/);

  const extra = structuredClone(SMB_READY_PLAY_GAMEPLAY_PLAN);
  extra.untrusted = true;
  expectFailure(() => deriveGameplayTranscript(gameplayReport(), extra), "envelope", /\[keys\]$/);

  const nonTerminal = structuredClone(SMB_READY_PLAY_GAMEPLAY_PLAN);
  nonTerminal.steps[nonTerminal.steps.length - 1] = {
    id: "post-play-presented",
    type: "input",
    button: 0x0100,
    witness: structuredClone(nonTerminal.steps.at(-1).witness),
  };
  expectFailure(() => deriveGameplayTranscript(gameplayReport(), nonTerminal), "envelope", /type$/);
});

test("attached transcript objects and witnesses reject extra or missing fields", () => {
  const cases = [
    transcript => { transcript.untrusted = true; },
    transcript => { transcript.steps[0].ready.witness.rendererFramesAcknowledged = 10; },
    transcript => { delete transcript.steps[0].ready.witness.menuSelection; },
    transcript => { transcript.steps[0].press.publications[0].hostDelayMs = 12; },
  ];
  for (const mutate of cases) {
    const transcript = gameplayTranscript();
    mutate(transcript);
    expectFailure(
      () => validateGameplayTranscript(transcript, SMB_READY_PLAY_GAMEPLAY_PLAN),
      "envelope",
      /\[keys\]$/,
    );
  }
});

test("verification rejects a valid forged attachment after independent derivation", () => {
  const report = gameplayReport();
  const transcript = gameplayTranscript();
  transcript.steps[0].ready.witness.menuSelection += 1;
  assert.doesNotThrow(() => validateSmbReadyPlayGameplayTranscript(transcript));
  expectFailure(
    () => verifySmbReadyPlayGameplayTranscript(report, transcript),
    "transcript-mismatch",
    /menuSelection$/,
  );

  const clean = gameplayTranscript();
  assert.deepEqual(
    verifyGameplayTranscript(report, clean, SMB_READY_PLAY_GAMEPLAY_PLAN),
    clean,
  );
});

test("the saved clean SMB report satisfies the pure transcript contract when available", t => {
  const path = "/private/tmp/lazuli-smb-temporal-run-1-complete.json";
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("saved local SMB evidence is not present");
      return;
    }
    throw error;
  }
  const transcript = deriveSmbReadyPlayGameplayTranscript(report);
  assert.equal(transcript.steps.length, 13);
  assert.equal(transcript.steps.filter(step => step.type === "input").length, 9);
  assert.equal(
    transcript.steps.flatMap(step => step.type === "input"
      ? [...step.press.publications, ...step.release.publications]
      : []).length,
    54,
  );
  assert.equal(transcript.controller.pollIndex, 2093);
  assert.equal(transcript.controller.appliedSequence, 18);
  assert.equal(transcript.controller.lastPolledSequence, 18);
});
