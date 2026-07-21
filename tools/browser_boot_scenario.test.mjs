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
  "normalizeControllerState",
  "controllerStatesEqual",
  "matchControllerScenarioInputRequest",
  "enqueueControllerState",
  "controllerScenarioInteger",
  "registerControllerScenario",
  "createControllerScenario",
  "selectControllerScenario",
  "controllerScenarioCycleLimit",
  "failControllerScenario",
  "createControllerScenarioStateRecord",
  "requestControllerScenarioState",
  "observeControllerScenarioPulse",
  "serviceControllerScenario",
  "recordControllerScenarioPoll",
  "recordControllerScenarioStatePoll",
  "pollControllerScenario",
  "snapshotControllerScenario",
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
    controllerQueueCapacity: 64,
    controllerQueueCoalesces: 0,
    controllerQueueHighWater: 0,
    controllerQueueOverflows: 0,
    controllerScenarioInputExclusive: false,
    controllerSequence: 0,
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
    runnerPaused: false,
    runnerSnapshotRequested: false,
    runnerStopRequested: false,
    statusDataset: {},
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

function fullControllerState(overrides = {}) {
  return {
    buttons: 0,
    stickX: 0x80,
    stickY: 0x80,
    cStickX: 0x80,
    cStickY: 0x80,
    triggerL: 0,
    triggerR: 0,
    analogA: 0,
    analogB: 0,
    ...overrides,
  };
}

test("controller scenarios emit three acknowledged press polls then neutral", () => {
  const sample = {
    phase: "prompt",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const context = scenarioHarness();
  context.registerControllerScenario(definition(sample));
  const scenario = context.selectControllerScenario("test-path", "TEST01", 0);

  assert.equal(context.serviceControllerScenario(scenario, 10), "running");
  assert.equal(scenario.steps.length, 1);
  assert.equal(scenario.steps[0].readyCycle, 10);

  for (let poll = 1; poll <= 3; poll += 1) {
    context.controllerPollIndex = poll;
    assert.equal(
      context.pollControllerScenario(scenario, 0, poll, 1_000 + poll, 2_000 + poll),
      0x0100,
    );
    sample.pad = poll === 1
      ? { held: 0x0100, pressed: 0x0100, released: 0 }
      : { held: 0x0100, pressed: 0, released: 0 };
    context.serviceControllerScenario(scenario, 10 + poll);
  }

  for (let poll = 4; poll <= 6; poll += 1) {
    context.controllerPollIndex = poll;
    assert.equal(
      context.pollControllerScenario(scenario, 0, poll, 1_000 + poll, 2_000 + poll),
      0,
    );
    sample.pad = poll === 5
      ? { held: 0, pressed: 0, released: 0x0100 }
      : poll === 4
        ? { held: 0x0100, pressed: 0, released: 0 }
        : { held: 0, pressed: 0, released: 0 };
    context.serviceControllerScenario(scenario, 10 + poll);
  }

  assert.equal(scenario.stepIndex, 1);
  assert.equal(scenario.pulse, null);
  sample.phase = "play";
  assert.equal(context.serviceControllerScenario(scenario, 20), "complete");

  const snapshot = JSON.parse(JSON.stringify(context.snapshotControllerScenario(scenario)));
  assert.deepEqual(snapshot, {
    id: "test-path",
    gameIdentifier: "TEST01",
    status: "complete",
    hardCycleLimit: 10_000,
    startCycle: 0,
    completedCycle: 20,
    failure: null,
    stepIndex: 2,
    currentStep: null,
    pollIndex: 6,
    lastState: { phase: "play" },
    steps: [
      {
        id: "confirm",
        type: "input",
        button: 0x0100,
        readyCycle: 10,
        readyPollIndex: 0,
        readyState: { phase: "prompt" },
        press: {
          sequence: 1,
          polls: 3,
          publications: [
            {
              source: "periodic",
              pollIndex: 1,
              scheduledCycle: 1_001,
              observedCycle: 2_001,
              buttons: 0x0100,
              sequence: 1,
            },
            {
              source: "periodic",
              pollIndex: 2,
              scheduledCycle: 1_002,
              observedCycle: 2_002,
              buttons: 0x0100,
              sequence: 1,
            },
            {
              source: "periodic",
              pollIndex: 3,
              scheduledCycle: 1_003,
              observedCycle: 2_003,
              buttons: 0x0100,
              sequence: 1,
            },
          ],
          firstPollIndex: 1,
          lastPollIndex: 3,
          firstScheduledCycle: 1_001,
          lastScheduledCycle: 1_003,
          firstObservedCycle: 2_001,
          lastObservedCycle: 2_003,
        },
        release: {
          sequence: 2,
          polls: 3,
          publications: [
            {
              source: "periodic",
              pollIndex: 4,
              scheduledCycle: 1_004,
              observedCycle: 2_004,
              buttons: 0,
              sequence: 2,
            },
            {
              source: "periodic",
              pollIndex: 5,
              scheduledCycle: 1_005,
              observedCycle: 2_005,
              buttons: 0,
              sequence: 2,
            },
            {
              source: "periodic",
              pollIndex: 6,
              scheduledCycle: 1_006,
              observedCycle: 2_006,
              buttons: 0,
              sequence: 2,
            },
          ],
          firstPollIndex: 4,
          lastPollIndex: 6,
          firstScheduledCycle: 1_004,
          lastScheduledCycle: 1_006,
          firstObservedCycle: 2_004,
          lastObservedCycle: 2_006,
        },
        guest: {
          pressedCycle: 11,
          releasedCycle: 15,
          neutralCycle: 16,
        },
        completedCycle: 16,
        completedPollIndex: 6,
      },
      {
        id: "play",
        type: "observe",
        observedCycle: 20,
        observedPollIndex: 6,
        state: { phase: "play" },
      },
    ],
  });
});

test("controller scenarios never retry an unobserved input edge", () => {
  const sample = {
    phase: "prompt",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const context = scenarioHarness();
  const scenario = context.createControllerScenario(definition(sample, {
    maximumNeutralPolls: 4,
  }));
  context.serviceControllerScenario(scenario, 1);

  const buttons = [];
  for (let poll = 1; poll <= 4; poll += 1) {
    context.controllerPollIndex = poll;
    buttons.push(context.pollControllerScenario(scenario, 0, poll, poll, poll));
    context.serviceControllerScenario(scenario, 1 + poll);
  }

  assert.deepEqual(buttons, [0x0100, 0x0100, 0x0100, 0]);
  assert.equal(scenario.status, "running");
  context.serviceControllerScenario(scenario, 6);
  assert.equal(scenario.status, "failed");
  assert.equal(scenario.failure.step, "confirm");
  assert.match(scenario.failure.reason, /guest did not observe pressed within 3 polls/);
  assert.equal(scenario.steps[0].press.polls, 3);
  assert.equal(context.pollControllerScenario(scenario, 0, 5, 5, 5), null);
});

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
  assert.equal(context.serviceControllerScenario(scenario, 1), "running");
  assert.deepEqual(
    Array.from(context.controllerPacketForPoll(0, 2, 3, "direct")),
    [0, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0],
  );
  assert.equal(scenario.pollIndex, 1);
  assert.equal(context.controllerAppliedSequence, 0);
});

test("page-owned full-state phases request, echo, and publish active then neutral", () => {
  const sample = {
    phase: "prompt",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const messages = [];
  const context = scenarioHarness({
    postMessage(message) { messages.push(message); },
  });
  const active = fullControllerState({ stickX: 0x40, stickY: 0xc0 });
  const neutral = fullControllerState();
  const scenario = context.createControllerScenario(definition(sample, {
    steps: [
      {
        id: "steer",
        input: { owner: "page", active, neutral },
        ready: value => value.phase === "prompt",
      },
      {
        id: "play",
        button: null,
        ready: value => value.phase === "play",
      },
    ],
  }));
  context.controllerScenario = scenario;
  context.controllerScenarioInputExclusive = true;

  assert.equal(context.serviceControllerScenario(scenario, 10), "running");
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
    type: "controller-scenario-input",
    scenario: "test-path",
    step: "steer",
    phase: "active",
    requestSequence: 1,
    state: active,
  }]);

  context.enqueueControllerState({ sequence: 1, state: neutral });
  assert.equal(context.controllerSequence, 0, "unowned page input stays excluded");
  context.cycles = 11;
  context.enqueueControllerState({
    type: "controller",
    sequence: 10,
    state: active,
    scenarioInput: {
      scenario: "test-path",
      step: "steer",
      phase: "active",
      requestSequence: 1,
    },
  });

  for (let poll = 1; poll <= 3; poll += 1) {
    const packet = context.controllerPacketForPoll(
      0,
      1_000 + poll,
      2_000 + poll,
      "periodic",
    );
    assert.deepEqual(
      Array.from(packet),
      [0x00, 0x80, 0x40, 0xc0, 0x80, 0x80, 0, 0],
    );
  }
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: "controller-scenario-input",
    scenario: "test-path",
    step: "steer",
    phase: "neutral",
    requestSequence: 2,
    state: neutral,
  });

  context.cycles = 15;
  context.enqueueControllerState({
    type: "controller",
    sequence: 11,
    state: neutral,
    scenarioInput: {
      scenario: "test-path",
      step: "steer",
      phase: "neutral",
      requestSequence: 2,
    },
  });
  for (let poll = 4; poll <= 6; poll += 1) {
    const packet = context.controllerPacketForPoll(
      0,
      1_000 + poll,
      2_000 + poll,
      "periodic",
    );
    assert.deepEqual(
      Array.from(packet),
      [0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0],
    );
  }
  assert.equal(context.serviceControllerScenario(scenario, 20), "running");
  assert.equal(scenario.stepIndex, 1);
  sample.phase = "play";
  assert.equal(context.serviceControllerScenario(scenario, 21), "complete");

  const snapshot = JSON.parse(JSON.stringify(context.snapshotControllerScenario(scenario)));
  assert.deepEqual(snapshot.steps[0], {
    id: "steer",
    type: "state-input",
    owner: "page",
    readyCycle: 10,
    readyPollIndex: 0,
    readyState: { phase: "prompt" },
    active: {
      requestSequence: 1,
      state: active,
      requestedCycle: 10,
      requestedPollIndex: 0,
      receivedCycle: 11,
      sequence: 10,
      polls: 3,
      publications: [1, 2, 3].map(pollIndex => ({
        source: "periodic",
        pollIndex,
        scheduledCycle: 1_000 + pollIndex,
        observedCycle: 2_000 + pollIndex,
        state: active,
        sequence: 10,
      })),
      firstPollIndex: 1,
      lastPollIndex: 3,
      firstScheduledCycle: 1_001,
      lastScheduledCycle: 1_003,
      firstObservedCycle: 2_001,
      lastObservedCycle: 2_003,
    },
    neutral: {
      requestSequence: 2,
      state: neutral,
      requestedCycle: 2_003,
      requestedPollIndex: 3,
      receivedCycle: 15,
      sequence: 11,
      polls: 3,
      publications: [4, 5, 6].map(pollIndex => ({
        source: "periodic",
        pollIndex,
        scheduledCycle: 1_000 + pollIndex,
        observedCycle: 2_000 + pollIndex,
        state: neutral,
        sequence: 11,
      })),
      firstPollIndex: 4,
      lastPollIndex: 6,
      firstScheduledCycle: 1_004,
      lastScheduledCycle: 1_006,
      firstObservedCycle: 2_004,
      lastObservedCycle: 2_006,
    },
    completedCycle: 20,
    completedPollIndex: 6,
  });
});

test("page-owned guest predicates witness active and neutral states after SI", () => {
  const sample = { guestStickX: 0 };
  const context = scenarioHarness({ postMessage() {} });
  const active = fullControllerState({ stickX: 0x40 });
  const neutral = fullControllerState();
  const scenario = context.createControllerScenario(definition(sample, {
    describe: value => ({ guestStickX: value.guestStickX }),
    steps: [{
      id: "steer",
      input: {
        owner: "page",
        active,
        neutral,
        activeObserved: value => value.guestStickX === -64,
        neutralObserved: value => value.guestStickX === 0,
      },
      ready: value => value.guestStickX === 0,
    }],
  }));
  context.controllerScenario = scenario;
  context.controllerScenarioInputExclusive = true;
  context.serviceControllerScenario(scenario, 1);
  context.enqueueControllerState({
    sequence: 10,
    state: active,
    scenarioInput: {
      scenario: "test-path",
      step: "steer",
      phase: "active",
      requestSequence: 1,
    },
  });

  context.controllerPacketForPoll(0, 101, 201, "periodic");
  sample.guestStickX = -64;
  assert.equal(context.serviceControllerScenario(scenario, 2), "running");
  context.controllerPacketForPoll(0, 102, 202, "periodic");
  context.serviceControllerScenario(scenario, 3);
  context.controllerPacketForPoll(0, 103, 203, "periodic");
  context.serviceControllerScenario(scenario, 4);

  context.enqueueControllerState({
    sequence: 11,
    state: neutral,
    scenarioInput: {
      scenario: "test-path",
      step: "steer",
      phase: "neutral",
      requestSequence: 2,
    },
  });
  for (let poll = 4; poll <= 6; poll += 1) {
    context.controllerPacketForPoll(0, 100 + poll, 200 + poll, "periodic");
    assert.equal(context.serviceControllerScenario(scenario, poll + 1), "running");
  }
  assert.equal(scenario.stepIndex, 0, "SI neutral alone is not a guest witness");

  sample.guestStickX = 0;
  assert.equal(context.serviceControllerScenario(scenario, 8), "complete");
  assert.deepEqual(JSON.parse(JSON.stringify(scenario.steps[0].guest)), {
    activeCycle: 2,
    activePollIndex: 1,
    activeState: { guestStickX: -64 },
    neutralCycle: 8,
    neutralPollIndex: 6,
    neutralState: { guestStickX: 0 },
  });
  assert.equal(scenario.steps[0].completedCycle, 8);
  assert.equal(scenario.steps[0].completedPollIndex, 6);
});

test("page-owned state steps reject torn definitions and echoed states", () => {
  const sample = {
    phase: "prompt",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const active = fullControllerState({ stickX: 0x40 });
  const neutral = fullControllerState();
  const context = scenarioHarness({ postMessage() {} });
  assert.throws(
    () => context.registerControllerScenario(definition(sample, {
      steps: [{
        id: "same",
        input: { owner: "page", active: neutral, neutral },
        ready: () => true,
      }],
    })),
    /active and neutral states must differ/,
  );
  assert.throws(
    () => context.registerControllerScenario(definition(sample, {
      steps: [{
        id: "unpaired",
        input: {
          owner: "page",
          active,
          neutral,
          activeObserved: () => true,
        },
        ready: () => true,
      }],
    })),
    /needs paired guest predicates/,
  );

  const scenario = context.createControllerScenario(definition(sample, {
    steps: [{
      id: "steer",
      input: { owner: "page", active, neutral },
      ready: () => true,
    }],
  }));
  context.controllerScenario = scenario;
  context.controllerScenarioInputExclusive = true;
  context.serviceControllerScenario(scenario, 1);
  assert.throws(
    () => context.enqueueControllerState({
      sequence: 1,
      state: { ...active, stickY: 0x40 },
      scenarioInput: {
        scenario: "test-path",
        step: "steer",
        phase: "active",
        requestSequence: 1,
      },
    }),
    /state does not match its request/,
  );
  assert.equal(context.controllerQueue.length, 0);
  assert.equal(scenario.steps[0].active.sequence, null);
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

test("controller scenarios reject stale and torn same-button release edges", () => {
  const sample = {
    phase: "prompt",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const context = scenarioHarness();
  const scenario = context.createControllerScenario(definition(sample));
  context.serviceControllerScenario(scenario, 1);

  sample.pad = { held: 0, pressed: 0x0100, released: 0 };
  context.serviceControllerScenario(scenario, 2);
  assert.equal(scenario.steps[0].guest.pressedCycle, null);

  for (let poll = 1; poll <= 3; poll += 1) {
    context.controllerPollIndex = poll;
    context.pollControllerScenario(scenario, 0, poll, poll + 2, poll + 2);
    sample.pad = poll === 1
      ? { held: 0x0100, pressed: 0x0100, released: 0 }
      : { held: 0x0100, pressed: 0, released: 0 };
    context.serviceControllerScenario(scenario, poll + 2);
  }

  context.controllerPollIndex = 4;
  context.pollControllerScenario(scenario, 0, 4, 6, 6);
  sample.pad = { held: 0x0100, pressed: 0, released: 0 };
  context.serviceControllerScenario(scenario, 6);

  sample.pad = { held: 0, pressed: 0x0100, released: 0x0100 };
  context.serviceControllerScenario(scenario, 7);
  assert.equal(scenario.steps[0].guest.releasedCycle, null);

  sample.pad = { held: 0, pressed: 0, released: 0x0100 };
  context.serviceControllerScenario(scenario, 8);
  assert.equal(scenario.steps[0].guest.releasedCycle, 8);

  for (let poll = 5; poll <= 6; poll += 1) {
    context.controllerPollIndex = poll;
    context.pollControllerScenario(scenario, 0, poll, poll + 4, poll + 4);
    sample.pad = { held: 0, pressed: 0, released: 0 };
    context.serviceControllerScenario(scenario, poll + 4);
  }
  assert.equal(scenario.steps[0].guest.neutralCycle, 9);
  assert.equal(scenario.stepIndex, 1);
});

test("consecutive same-button pulses retain distinct guest edges and sequences", () => {
  const sample = {
    phase: "first",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const context = scenarioHarness();
  const scenario = context.createControllerScenario(definition(sample, {
    steps: [
      { id: "first-a", button: 0x0100, ready: value => value.phase === "first" },
      { id: "second-a", button: 0x0100, ready: value => value.phase === "second" },
    ],
  }));

  function drivePulse(firstPoll, firstCycle) {
    for (let offset = 0; offset < 3; offset += 1) {
      const poll = firstPoll + offset;
      const cycle = firstCycle + offset;
      context.controllerPollIndex = poll;
      assert.equal(
        context.pollControllerScenario(scenario, 0, poll, cycle, cycle),
        0x0100,
      );
      sample.pad = offset === 0
        ? { held: 0x0100, pressed: 0x0100, released: 0 }
        : { held: 0x0100, pressed: 0, released: 0 };
      context.serviceControllerScenario(scenario, cycle);
    }
    for (let offset = 0; offset < 3; offset += 1) {
      const poll = firstPoll + 3 + offset;
      const cycle = firstCycle + 3 + offset;
      context.controllerPollIndex = poll;
      assert.equal(context.pollControllerScenario(scenario, 0, poll, cycle, cycle), 0);
      sample.pad = offset === 0
        ? { held: 0x0100, pressed: 0, released: 0 }
        : offset === 1
          ? { held: 0, pressed: 0, released: 0x0100 }
          : { held: 0, pressed: 0, released: 0 };
      context.serviceControllerScenario(scenario, cycle);
    }
  }

  context.serviceControllerScenario(scenario, 1);
  drivePulse(1, 2);
  assert.equal(scenario.stepIndex, 1);

  sample.phase = "second";
  context.serviceControllerScenario(scenario, 8);
  sample.pad = { held: 0, pressed: 0x0100, released: 0 };
  context.serviceControllerScenario(scenario, 9);
  assert.equal(scenario.steps[1].guest.pressedCycle, null);

  drivePulse(7, 10);
  assert.equal(scenario.status, "complete");
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      scenario.steps.map(step => [step.press.sequence, step.release.sequence])
    )),
    [[1, 2], [3, 4]],
  );
  assert.ok(scenario.steps[1].guest.pressedCycle > scenario.steps[0].guest.neutralCycle);
  assert.ok(scenario.steps[1].guest.releasedCycle > scenario.steps[1].guest.pressedCycle);
  assert.ok(scenario.steps[1].guest.neutralCycle > scenario.steps[1].guest.releasedCycle);
});

test("controller scenarios fail exactly at their guest-cycle cap", () => {
  const sample = {
    phase: "waiting",
    pad: { held: 0, pressed: 0, released: 0 },
  };
  const context = scenarioHarness();
  const scenario = context.createControllerScenario(definition(sample, {
    hardCycleLimit: 25,
  }));
  assert.equal(context.serviceControllerScenario(scenario, 24), "running");
  assert.equal(context.serviceControllerScenario(scenario, 25), "failed");
  assert.equal(scenario.failure.cycle, 25);
  assert.match(scenario.failure.reason, /hard cycle limit reached/);
});

test("browser worker routes successful SI publications through the scenario engine", () => {
  assert.match(
    source,
    /controllerPollIndex \+= 1;[\s\S]*?pollControllerScenario\([\s\S]*?scheduledCycle,[\s\S]*?observedCycle/,
  );
  assert.match(
    source,
    /controllerPacketForPoll\([\s\S]*?channel,[\s\S]*?scheduledCycle,[\s\S]*?observedCycles,[\s\S]*?"periodic"/,
  );
  assert.match(
    source,
    /processSerialCommand\([\s\S]*?transfer\.completionCycle,[\s\S]*?observedCycles/,
  );
  assert.match(source, /scenario: snapshotControllerScenario\(controllerScenario\)/);
  assert.match(source, /stage: failed \? "scenario-failed" : "scenario-complete"/);
  assert.match(
    source,
    /controllerScenarioInputExclusive[\s\S]*?matchControllerScenarioInputRequest\(controllerScenario, message\)/,
  );
  assert.match(source, /const scenarioOwnsInput = scenarioButtons !== null;/);
  assert.match(source, /scenarioOwnsInput \? 0x80 : controllerState\.stickX/);
  assert.match(source, /entry\.release\.polls === 0/);
  assert.match(source, /await finishTerminalControllerScenario\(\);/);
});
