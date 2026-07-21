#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  SMB_READY_PLAY_GAMEPLAY_PLAN,
} from "./browser_boot_gameplay_transcript.mjs";

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
