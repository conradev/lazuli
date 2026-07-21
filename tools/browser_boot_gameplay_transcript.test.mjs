#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  GAMEPLAY_TRANSCRIPT_SCHEMA_V1,
  GameplayTranscriptValidationError,
  SMB_READY_PLAY_GAMEPLAY_PLAN,
  validateGameplayTranscript,
  validateSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
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

test("independent fixture defines and satisfies the strict transcript shape", () => {
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
  assert.deepEqual(
    Object.keys(input.press.publications[0]),
    ["source", "pollIndex", "scheduledCycle", "observedCycle", "buttons", "sequence"],
  );
  assert.deepEqual(Object.keys(transcript.steps[2]), ["id", "type", "observed"]);
  assert.doesNotThrow(() => validateSmbReadyPlayGameplayTranscript(transcript));
});

test("terminal controller state and overflow are hard gates", () => {
  const cases = [
    [transcript => { transcript.controller.appliedSequence = 17; }, "provenance", /appliedSequence$/],
    [transcript => { transcript.controller.lastPolledSequence = 17; }, "provenance", /lastPolledSequence$/],
    [transcript => { transcript.controller.lastPolledButtons = 0x0100; }, "provenance", /lastPolledButtons$/],
    [transcript => { transcript.controller.pendingButtons = 0x0100; }, "provenance", /pendingButtons$/],
    [transcript => { transcript.controller.queuedStates = 1; }, "provenance", /queuedStates$/],
    [transcript => { transcript.controller.queueOverflows = 1; }, "overflow", /queueOverflows$/],
  ];
  for (const [mutate, code, path] of cases) {
    const transcript = gameplayTranscript();
    mutate(transcript);
    expectFailure(
      () => validateSmbReadyPlayGameplayTranscript(transcript),
      code,
      path,
    );
  }
});

test("publication provenance and ordering are independently enforced", () => {
  const cases = [
    [
      transcript => {
        transcript.steps[0].press.publications[1].pollIndex =
          transcript.steps[0].press.publications[0].pollIndex;
      },
      "ordering",
      /pollIndex$/,
    ],
    [
      transcript => { transcript.steps[0].press.publications[1].source = "direct"; },
      "provenance",
      /source$/,
    ],
    [
      transcript => {
        const publication = transcript.steps[0].press.publications[1];
        publication.observedCycle = publication.scheduledCycle - 1;
      },
      "ordering",
      /observedCycle$/,
    ],
    [
      transcript => { transcript.steps[2].observed.witness.flags = 0; },
      "provenance",
      /witness\.flags$/,
    ],
  ];
  for (const [mutate, code, path] of cases) {
    const transcript = gameplayTranscript();
    mutate(transcript);
    expectFailure(
      () => validateSmbReadyPlayGameplayTranscript(transcript),
      code,
      path,
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

test("plans reject ambiguity before transcript validation", () => {
  const duplicate = structuredClone(SMB_READY_PLAY_GAMEPLAY_PLAN);
  duplicate.steps[1].id = duplicate.steps[0].id;
  expectFailure(
    () => validateGameplayTranscript(gameplayTranscript(), duplicate),
    "identity",
    /steps\[1\]\.id$/,
  );

  const extra = structuredClone(SMB_READY_PLAY_GAMEPLAY_PLAN);
  extra.untrusted = true;
  expectFailure(
    () => validateGameplayTranscript(gameplayTranscript(), extra),
    "envelope",
    /\[keys\]$/,
  );

  const nonTerminal = structuredClone(SMB_READY_PLAY_GAMEPLAY_PLAN);
  nonTerminal.steps[nonTerminal.steps.length - 1] = {
    id: "post-play-presented",
    type: "input",
    button: 0x0100,
    witness: structuredClone(nonTerminal.steps.at(-1).witness),
  };
  expectFailure(
    () => validateGameplayTranscript(gameplayTranscript(), nonTerminal),
    "envelope",
    /type$/,
  );
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
