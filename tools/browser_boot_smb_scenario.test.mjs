#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.notEqual(match, null, `missing ${name} in browser_boot.rs`);
  const start = match.index;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function definitionHarness(sample) {
  const context = {
    Map,
    Math,
    Number,
    Object,
    Set,
    TypeError,
    RangeError,
    Error,
    controllerScenarioDefinitions: new Map(),
    inspectSuperMonkeyBallScenarioState() { return sample; },
  };
  vm.createContext(context);
  vm.runInContext([
    "controllerScenarioInteger",
    "registerControllerScenario",
    "createControllerScenario",
    "selectControllerScenario",
    "createSuperMonkeyBallControllerScenarioDefinition",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.smb-scenario-definition.js",
  });
  return context;
}

function neutralSample(overrides = {}) {
  return {
    cycle: 0,
    pad: { held: 0, pressed: 0, released: 0 },
    gameModeRequest: -1,
    gameMode: 0,
    gameSubmodeRequest: -1,
    gameSubmode: 0,
    warningState: 0,
    warningDialogPhase: 0xff,
    warningDialogFlags: 0x200,
    submodeTimer: 0,
    difficulty: 0,
    flags: 0,
    titleChoice: 0,
    menuSelection: 0,
    playerCount: 1,
    gameType: 0,
    currentPlayer: 0,
    characterSelection0: 0,
    textBoxState: 10,
    textBoxTimer: 30,
    selectorCurrent: 0,
    selectorRequest: -1,
    selectorChoice: 0,
    characterLocked0: 0,
    infoFlags: 0,
    infoTimer: 0,
    attempts: 0,
    floor: 0,
    pauseStatus: 0,
    inputLockStatus: 0,
    demoSkipTimer: 0,
    demoResourcesReady: 1,
    gameVersion: 0,
    viPresentationCount: 0,
    viLastPresentationCycle: null,
    viLastPresentationCopyIndex: 0,
    gxXfbCopyCount: 0,
    xfbCaptured: null,
    xfbCapturedAtCycle: null,
    xfbDisplayedAtCycle: null,
    rendererFramesAcknowledged: 0,
    rendererFramesInFlight: 0,
    rendererFailed: false,
    ...overrides,
  };
}

test("SMB scenario declares the exact B, Start x2, A x6 route", () => {
  const sample = neutralSample();
  const context = definitionHarness(sample);
  const definition = context.createSuperMonkeyBallControllerScenarioDefinition();
  context.registerControllerScenario(definition);

  assert.equal(definition.id, "smb-ready-play");
  assert.equal(definition.gameIdentifier, "GMBE8P");
  assert.equal(definition.gameVersion, 0);
  assert.equal(definition.hardCycleLimit, 30_000_000_000);
  assert.equal(definition.pressPolls, 3);
  assert.equal(definition.minimumNeutralPolls, 3);
  assert.equal(definition.maximumNeutralPolls, 120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(definition.steps.map(step => [step.id, step.button]))),
    [
      ["memory-card-back", 0x0200],
      ["skip-opening-demo", 0x1000],
      ["opening-demo-skipped", null],
      ["title-start", 0x1000],
      ["title-game-start", 0x0100],
      ["select-current-8", 0x0100],
      ["select-current-10", 0x0100],
      ["select-current-16", 0x0100],
      ["select-current-18", 0x0100],
      ["select-current-22", 0x0100],
      ["ready-main", null],
      ["play-main", null],
      ["post-play-presented", null],
    ],
  );
  assert.equal(
    context.selectControllerScenario("smb-ready-play", "GMBE8P", 0, 0).status,
    "running",
  );
  assert.throws(
    () => context.selectControllerScenario("smb-ready-play", "GZWE01"),
    /requires GMBE8P, got GZWE01/,
  );
  assert.throws(
    () => context.selectControllerScenario("smb-ready-play", "GMBE8P", 0, 1),
    /requires disc revision 0, got 1/,
  );
});

test("SMB title gates wait for stable retail input acceptance", () => {
  const sample = neutralSample({
    gameSubmode: 6,
    warningState: 2,
  });
  const context = definitionHarness(sample);
  const definition = context.createSuperMonkeyBallControllerScenarioDefinition();
  const scenario = context.createControllerScenario(definition);
  const memory = definition.steps[0];
  const skipDemo = definition.steps[1];
  const skippedDemo = definition.steps[2];
  const titleStart = definition.steps[3];
  const gameStart = definition.steps[4];

  assert.equal(memory.ready(sample, scenario), true);
  sample.warningDialogFlags = 0;
  assert.equal(memory.ready(sample, scenario), false);
  sample.warningDialogFlags = 0x200;
  sample.warningDialogPhase = 1;
  assert.equal(memory.ready(sample, scenario), false);
  sample.warningDialogPhase = 0xff;
  sample.cycle = 2_000_000_000;
  assert.match(memory.missed(sample, scenario), /memory-card prompt deadline exceeded/);

  Object.assign(sample, {
    cycle: 3_000_000_000,
    gameSubmode: 2,
    submodeTimer: 2774,
    flags: 0,
    demoSkipTimer: 0,
    demoResourcesReady: 1,
  });
  assert.equal(skipDemo.ready(sample, scenario), false);
  sample.viPresentationCount += 3;
  assert.equal(skipDemo.ready(sample, scenario), true);
  sample.demoResourcesReady = 0;
  assert.equal(skipDemo.ready(sample, scenario), false);
  sample.demoResourcesReady = 1;

  scenario.steps.push({ id: "skip-opening-demo", completedCycle: sample.cycle });
  sample.flags = 0x2000;
  sample.demoSkipTimer = 24;
  assert.equal(skippedDemo.ready(sample, scenario), true);
  sample.demoSkipTimer = 0;
  assert.equal(skippedDemo.ready(sample, scenario), false);
  sample.demoSkipTimer = 24;

  scenario.steps.push({ id: "opening-demo-skipped", observedCycle: 100 });
  Object.assign(sample, {
    cycle: 200,
    gameSubmode: 20,
    warningState: 0,
    flags: 0,
    textBoxState: 10,
    textBoxTimer: 30,
    menuSelection: 99,
  });
  assert.equal(titleStart.ready(sample, scenario), false);
  sample.textBoxTimer = 31;
  assert.equal(titleStart.ready(sample, scenario), false);
  sample.viPresentationCount += 31;
  assert.equal(titleStart.ready(sample, scenario), true);
  sample.cycle = 1_000_000_100;
  assert.equal(titleStart.missed(sample, scenario), false);
  sample.cycle = 1_500_000_100;
  assert.match(titleStart.missed(sample, scenario), /title screen deadline exceeded/);
  sample.cycle = 200;

  scenario.steps.push({ id: "title-start", completedCycle: sample.cycle });
  sample.flags = 4;
  assert.equal(gameStart.ready(sample, scenario), false);
  sample.viPresentationCount += 31;
  assert.equal(gameStart.ready(sample, scenario), true);
  sample.flags = 6;
  assert.equal(gameStart.ready(sample, scenario), false);
});

test("SMB selector gates require the stable canonical route", () => {
  const sample = neutralSample({
    gameMode: 1,
    gameSubmode: 32,
    selectorCurrent: 8,
  });
  const context = definitionHarness(sample);
  const definition = context.createSuperMonkeyBallControllerScenarioDefinition();
  const scenario = context.createControllerScenario(definition);

  for (const [index, current] of [[5, 8], [6, 10], [7, 16], [8, 18], [9, 22]]) {
    const step = definition.steps[index];
    sample.selectorCurrent = current;
    sample.cycle += 1;
    assert.equal(step.ready(sample, scenario), false, `selector ${current} must dwell`);
    sample.viPresentationCount += 31;
    assert.equal(step.ready(sample, scenario), true, `selector ${current} should settle`);
  }

  sample.selectorCurrent = 16;
  sample.playerCount = 0;
  assert.equal(definition.steps[7].ready(sample, scenario), false);
  sample.playerCount = 1;
  sample.gameType = 1;
  assert.equal(definition.steps[7].ready(sample, scenario), false);
  sample.selectorCurrent = 18;
  sample.gameType = 0;
  sample.characterSelection0 = 1;
  assert.equal(definition.steps[8].ready(sample, scenario), false);
  sample.characterSelection0 = 0;
  sample.characterLocked0 = 1;
  assert.equal(definition.steps[8].ready(sample, scenario), false);
  sample.selectorCurrent = 22;
  sample.characterLocked0 = 0;
  sample.difficulty = 1;
  assert.equal(definition.steps[9].ready(sample, scenario), false);

  sample.difficulty = 0;
  sample.viPresentationCount += 30;
  assert.equal(definition.steps[9].ready(sample, scenario), false);
  sample.selectorRequest = 21;
  assert.equal(definition.steps[9].ready(sample, scenario), false);
  sample.selectorRequest = -1;
  assert.equal(definition.steps[9].ready(sample, scenario), false);
  sample.viPresentationCount += 30;
  assert.equal(definition.steps[9].ready(sample, scenario), false);
  sample.viPresentationCount += 1;
  assert.equal(definition.steps[9].ready(sample, scenario), true);
  sample.pauseStatus = 2;
  assert.equal(definition.steps[9].ready(sample, scenario), false);
  sample.pauseStatus = 0;
  sample.selectorCurrent = 8;
  sample.selectorChoice = 1;
  assert.equal(definition.steps[5].ready(sample, scenario), false);
});

test("SMB READY and PLAY gates prove the full countdown", () => {
  const sample = neutralSample({
    cycle: 1_000,
    gameMode: 2,
    gameSubmode: 49,
    submodeTimer: 360,
    infoFlags: 0x108,
    attempts: 1,
    floor: 1,
    viPresentationCount: 10,
  });
  const context = definitionHarness(sample);
  const definition = context.createSuperMonkeyBallControllerScenarioDefinition();
  const ready = definition.steps[10];
  const play = definition.steps[11];
  const scenario = { startCycle: 0, steps: [] };

  assert.equal(ready.ready(sample, scenario), true);
  sample.submodeTimer = 361;
  assert.equal(ready.ready(sample, scenario), false);
  sample.submodeTimer = 359;
  assert.equal(ready.ready(sample, scenario), false);
  sample.submodeTimer = 0;
  sample.pauseStatus = 8;
  assert.equal(ready.ready(sample, scenario), false);

  sample.pauseStatus = 0;
  sample.submodeTimer = 360;
  sample.infoFlags = 0;
  sample.gameSubmode = 50;
  scenario.steps.push({ id: "ready-main", observedCycle: 1_000, state: { ...sample } });
  sample.viPresentationCount = 369;
  assert.equal(play.ready(sample, scenario), false);
  sample.gameSubmode = 51;
  assert.equal(play.ready(sample, scenario), false);
  sample.viPresentationCount = 370;
  assert.equal(play.ready(sample, scenario), true);
  sample.gameSubmodeRequest = 51;
  assert.equal(play.ready(sample, scenario), false);
  sample.gameSubmodeRequest = -1;
  sample.cycle = 4_000_001_000;
  assert.match(play.missed(sample, scenario), /PLAY main deadline exceeded/);
});

test("SMB completion requires a newly captured XFB presented after PLAY", () => {
  const sample = neutralSample({
    cycle: 9_000,
    gameMode: 2,
    gameSubmode: 51,
    gxXfbCopyCount: 18,
    viPresentationCount: 13,
    viLastPresentationCycle: 8_500,
    viLastPresentationCopyIndex: 18,
    xfbCaptured: true,
    xfbCapturedAtCycle: 8_400,
    xfbDisplayedAtCycle: 8_500,
    rendererFramesAcknowledged: 20,
  });
  const context = definitionHarness(sample);
  const definition = context.createSuperMonkeyBallControllerScenarioDefinition();
  const playCycle = 8_000;
  const scenario = {
    startCycle: 0,
    steps: [{
      id: "play-main",
      observedCycle: playCycle,
      state: {
        gxXfbCopyCount: 17,
        viPresentationCount: 12,
        rendererFramesAcknowledged: 19,
      },
    }],
  };
  const presented = definition.steps.at(-1);

  assert.equal(presented.ready(sample, scenario), true);
  sample.gxXfbCopyCount = 17;
  assert.equal(presented.ready(sample, scenario), false);
  sample.gxXfbCopyCount = 18;
  sample.viPresentationCount = 12;
  assert.equal(presented.ready(sample, scenario), false);
  sample.viPresentationCount = 13;
  sample.rendererFramesAcknowledged = 19;
  assert.equal(presented.ready(sample, scenario), false);
  sample.rendererFramesAcknowledged = 20;
  sample.rendererFramesInFlight = 1;
  assert.equal(presented.ready(sample, scenario), false);
  sample.rendererFramesInFlight = 0;
  sample.rendererFailed = true;
  assert.equal(presented.ready(sample, scenario), false);
  sample.rendererFailed = false;
  sample.viLastPresentationCopyIndex = 0;
  assert.equal(presented.ready(sample, scenario), false);
  sample.viLastPresentationCopyIndex = 18;
  sample.xfbCaptured = false;
  assert.equal(presented.ready(sample, scenario), false);
  sample.xfbCaptured = true;
  sample.xfbCapturedAtCycle = playCycle;
  assert.equal(presented.ready(sample, scenario), false);
  sample.xfbCapturedAtCycle = 8_400;
  sample.viLastPresentationCycle = playCycle;
  assert.equal(presented.ready(sample, scenario), false);
  sample.viLastPresentationCycle = 8_500;
  sample.xfbDisplayedAtCycle = playCycle;
  assert.equal(presented.ready(sample, scenario), false);
  sample.cycle = playCycle + 1_000_000_000;
  assert.match(presented.missed(sample, scenario), /post-PLAY presentation deadline exceeded/);
});

test("SMB scenario samples exact guest state and selected XFB provenance", () => {
  const memory = new ArrayBuffer(0x400000);
  const view = new DataView(memory);
  const frame = {
    index: 17,
    captured: true,
    capturedAtCycle: 700,
    displayedAtCycle: 800,
  };
  const context = {
    boot: { identifier: "GMBE8P", version: 0 },
    cycles: 900,
    gxXfbCopies: [frame, { index: 18, captured: false, capturedAtCycle: 850 }],
    gxXfbCopyCount: 17,
    ram: 0,
    ramSize: memory.byteLength,
    view,
    viLastPresentationCopyIndex: 17,
    viLastPresentationCycle: 800,
    viPresentationCount: 12,
    rendererFramesAcknowledged: 44,
    rendererFramesInFlight: new Set(),
    rendererFailure: null,
  };
  vm.createContext(context);
  vm.runInContext([
    "physicalOffset",
    "ramPointer",
    "guestU32",
    "guestU8",
    "guestU16",
    "guestS32",
    "guestS16",
    "inspectSuperMonkeyBallScenarioState",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.smb-scenario-state.js",
  });

  view.setUint16(0x1f3b70, 0x0100, false);
  view.setUint16(0x1f3b88, 0x0100, false);
  view.setUint16(0x1f3b94, 0, false);
  view.setInt16(0x2f1b90, -1, false);
  view.setInt16(0x2f1b92, 2, false);
  view.setInt16(0x2f1b8c, -1, false);
  view.setInt16(0x2f1b8e, 51, false);
  view.setUint8(0x173cc8, 2);
  view.setUint8(0x2ba35c, 0xff);
  view.setUint32(0x2ba318, 0x200, false);
  view.setInt32(0x1eec20, 359, false);
  view.setInt32(0x1eec24, 0, false);
  view.setUint32(0x1eec28, 4, false);
  view.setInt32(0x1eec30, 0, false);
  view.setInt32(0x1eec40, 0, false);
  view.setInt32(0x1eec44, 1, false);
  view.setInt32(0x1eec48, 0, false);
  view.setInt32(0x1eec4c, 0, false);
  view.setInt32(0x206bc0, 0, false);
  view.setInt32(0x292b60, 10, false);
  view.setInt32(0x292b68, 31, false);
  view.setInt32(0x1eeda8, 22, false);
  view.setInt32(0x1eedac, -1, false);
  view.setInt32(0x1eede0, 0, false);
  view.setInt32(0x1eedf0, 0, false);
  view.setUint32(0x1f3a58, 3, false);
  view.setInt16(0x1f3a5c, 42, false);
  view.setInt16(0x1f3a76, 3, false);
  view.setInt16(0x1f3a78, 1, false);
  view.setUint32(0x2f1ee0, 0, false);
  view.setUint32(0x2f1edc, 0, false);
  view.setInt32(0x2f1ba8, 0, false);
  view.setInt32(0x2f1bb0, 1, false);

  const state = JSON.parse(JSON.stringify(context.inspectSuperMonkeyBallScenarioState()));
  assert.deepEqual(state, {
    cycle: 900,
    pad: { held: 0x0100, pressed: 0x0100, released: 0 },
    gameModeRequest: -1,
    gameMode: 2,
    gameSubmodeRequest: -1,
    gameSubmode: 51,
    warningState: 2,
    warningDialogPhase: 0xff,
    warningDialogFlags: 0x200,
    submodeTimer: 359,
    difficulty: 0,
    flags: 4,
    titleChoice: 0,
    menuSelection: 0,
    playerCount: 1,
    gameType: 0,
    currentPlayer: 0,
    characterSelection0: 0,
    textBoxState: 10,
    textBoxTimer: 31,
    selectorCurrent: 22,
    selectorRequest: -1,
    selectorChoice: 0,
    characterLocked0: 0,
    infoFlags: 3,
    infoTimer: 42,
    attempts: 3,
    floor: 1,
    pauseStatus: 0,
    inputLockStatus: 0,
    demoSkipTimer: 0,
    demoResourcesReady: 1,
    gameVersion: 0,
    viPresentationCount: 12,
    viLastPresentationCycle: 800,
    viLastPresentationCopyIndex: 17,
    gxXfbCopyCount: 17,
    xfbCaptured: true,
    xfbCapturedAtCycle: 700,
    xfbDisplayedAtCycle: 800,
    rendererFramesAcknowledged: 44,
    rendererFramesInFlight: 0,
    rendererFailed: false,
  });
  context.viLastPresentationCopyIndex = 99;
  const missing = context.inspectSuperMonkeyBallScenarioState();
  assert.equal(missing.xfbCaptured, null);
  assert.equal(missing.xfbCapturedAtCycle, null);
  assert.equal(missing.xfbDisplayedAtCycle, null);
  context.boot.identifier = "GZWE01";
  assert.equal(context.inspectSuperMonkeyBallScenarioState(), null);
});

test("only the SMB scenario crosses the public runner-search boundary", () => {
  const context = { URLSearchParams };
  vm.createContext(context);
  vm.runInContext(extractFunction("runnerSearchForSurface"), context);

  assert.equal(
    context.runnerSearchForSurface(true, "?cycles=10&scenario=anything"),
    "?cycles=10&scenario=anything",
  );
  assert.equal(context.runnerSearchForSurface(false, "?cycles=10"), "");
  assert.equal(context.runnerSearchForSurface(false, "?scenario=anything"), "");
  assert.equal(
    context.runnerSearchForSurface(false, "?cycles=10&scenario=smb-ready-play&restMs=99"),
    "?scenario=smb-ready-play",
  );
  assert.match(source, /capturedAtCycle: cycles/);
  assert.match(
    source,
    /cycleLimit = controllerScenarioCycleLimit\(cycleLimit, controllerScenario\)/,
  );
  assert.match(
    source,
    /globalThis\.runnerSearch = \$\{JSON\.stringify\([\s\S]*?runnerSearchForSurface\(debugSurface, location\.search\)/,
  );
  assert.match(
    source,
    /globalThis\.runnerScenarioOptional = \$\{JSON\.stringify\(!debugSurface\)\}/,
  );
  assert.match(source, /controllerScenarioInputExclusive = controllerScenario !== null/);
});
