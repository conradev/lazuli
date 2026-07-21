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
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

const scenarioFunctions = [
  "controllerScenarioInteger",
  "registerControllerScenario",
  "createControllerScenario",
  "selectControllerScenario",
  "controllerScenarioCycleLimit",
  "recordControllerScenarioPoll",
  "pollControllerScenario",
];

function scenarioHarness(overrides = {}) {
  const context = {
    Map,
    Math,
    Number,
    Set,
    TypeError,
    RangeError,
    Error,
    cycles: 0,
    controllerAppliedSequence: 0,
    controllerPollIndex: 0,
    controllerQueue: [],
    controllerScenario: null,
    controllerScenarioDefinitions: new Map(),
    controllerState: {
      buttons: 0,
      stickX: 0x80,
      stickY: 0x80,
      cStickX: 0x80,
      cStickY: 0x80,
      triggerL: 0,
      triggerR: 0,
      analogA: 0,
      analogB: 0,
    },
    padUseOrigin: 0x0080,
    serialControllerModes: [3, 3, 3, 3],
    serialLastPolledButtons: 0,
    serialLastPolledSequence: 0,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(scenarioFunctions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.scenario.js",
  });
  vm.runInContext(extractFunction("controllerPacketForPoll"), context, {
    filename: "browser_boot.controller-packet.js",
  });
  return context;
}

function definition(sample, overrides = {}) {
  return {
    id: "test-path",
    gameIdentifier: "TEST01",
    hardCycleLimit: 10_000,
    maximumNeutralPolls: 8,
    sample: () => sample,
    describe: value => ({ phase: value.phase }),
    steps: [
      {
        id: "confirm",
        button: 0x0100,
        ready: value => value.phase === "prompt",
      },
      {
        id: "play",
        button: null,
        ready: value => value.phase === "play",
      },
    ],
    ...overrides,
  };
}

test("controller scenarios own neutral input between scripted pulses", () => {
  const sample = {
    phase: "waiting",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const context = scenarioHarness();
  const scenario = context.createControllerScenario(definition(sample));
  context.controllerScenario = scenario;
  context.controllerState = {
    buttons: 0xffff,
    stickX: 0x01,
    stickY: 0xff,
    cStickX: 0x02,
    cStickY: 0xfe,
    triggerL: 0xff,
    triggerR: 0xff,
    analogA: 0xff,
    analogB: 0xff,
  };
  assert.deepEqual(
    Array.from(context.controllerPacketForPoll(0, 2, 3, "direct")),
    [0, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0],
  );
  assert.equal(scenario.pollIndex, 1);
  assert.equal(context.controllerAppliedSequence, 0);
});

test("controller scenario selection validates ids, games, and observation steps", () => {
  const sample = { phase: "play", pad: { held: 0, pressed: 0, released: 0 } };
  const context = scenarioHarness();
  assert.equal(context.selectControllerScenario(null, "TEST01"), null);
  assert.equal(context.selectControllerScenario("", "TEST01"), null);
  context.registerControllerScenario(definition(sample));
  assert.throws(
    () => context.selectControllerScenario("test-path", "OTHER"),
    /requires TEST01, got OTHER/,
  );
  assert.throws(
    () => context.registerControllerScenario(definition(sample)),
    /duplicate controller scenario/,
  );
  assert.throws(
    () => context.registerControllerScenario(definition(sample, { id: "Bad Id" })),
    /lowercase kebab-case/,
  );
  assert.throws(
    () => context.createControllerScenario(definition(sample, {
      minimumNeutralPolls: 4,
      maximumNeutralPolls: 3,
    })),
    /maximumNeutralPolls must be >= minimumNeutralPolls/,
  );
  context.registerControllerScenario(definition(sample, {
    id: "versioned-path",
    gameVersion: 7,
  }));
  assert.equal(
    context.selectControllerScenario("versioned-path", "TEST01", 0, 7).status,
    "running",
  );
  assert.throws(
    () => context.selectControllerScenario("versioned-path", "TEST01", 0, 6),
    /requires disc revision 7, got 6/,
  );
  assert.equal(
    context.selectControllerScenario("versioned-path", "OTHER", 0, 7, true),
    null,
  );
  assert.equal(
    context.selectControllerScenario("versioned-path", "TEST01", 0, 6, true),
    null,
  );
  assert.throws(
    () => context.registerControllerScenario(definition(sample, {
      id: "invalid-revision",
      gameVersion: 0x100,
    })),
    /gameVersion exceeds 8 bits/,
  );
});

test("controller scenarios retain their hard guest-cycle budget", () => {
  const context = scenarioHarness();
  const scenario = { hardCycleLimit: 30_000_000_000 };
  assert.equal(context.controllerScenarioCycleLimit(10, null), 10);
  assert.equal(
    context.controllerScenarioCycleLimit(Number.POSITIVE_INFINITY, scenario),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(context.controllerScenarioCycleLimit(10, scenario), 30_000_000_000);
  assert.equal(
    context.controllerScenarioCycleLimit(40_000_000_000, scenario),
    40_000_000_000,
  );
});
