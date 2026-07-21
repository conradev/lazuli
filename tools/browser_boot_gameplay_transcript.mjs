// SPDX-License-Identifier: GPL-3.0-only

export const GAMEPLAY_TRANSCRIPT_SCHEMA_V1 =
  "lazuli-browser-gameplay-transcript-v1";

const WITNESS_FIELDS = Object.freeze([
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
]);

const SIGNED_SENTINEL_WITNESS_FIELDS = new Set([
  "gameModeRequest",
  "gameSubmodeRequest",
  "selectorRequest",
]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SMB_READY_PLAY_GAMEPLAY_PLAN = deepFreeze({
  game: {
    identifier: "GMBE8P",
    revision: 0,
  },
  scenario: {
    id: "smb-ready-play",
    hardCycleLimit: 30_000_000_000,
    startCycle: 0,
  },
  input: {
    publicationsPerPhase: 3,
    source: "periodic",
  },
  steps: [
    {
      id: "memory-card-back",
      type: "input",
      button: 0x0200,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 0,
        gameSubmode: 6,
        warningState: 2,
      },
    },
    {
      id: "skip-opening-demo",
      type: "input",
      button: 0x1000,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 0,
        gameSubmode: 2,
        demoResourcesReady: 1,
      },
    },
    {
      id: "opening-demo-skipped",
      type: "observe",
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 0,
        gameSubmode: 2,
        flags: 0x2000,
      },
    },
    {
      id: "title-start",
      type: "input",
      button: 0x1000,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 0,
        gameSubmode: 20,
        textBoxState: 10,
      },
    },
    {
      id: "title-game-start",
      type: "input",
      button: 0x0100,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 0,
        gameSubmode: 20,
        flags: 0x2004,
      },
    },
    {
      id: "select-current-8",
      type: "input",
      button: 0x0100,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 1,
        gameSubmode: 32,
        selectorCurrent: 8,
        selectorRequest: -1,
      },
    },
    {
      id: "select-current-10",
      type: "input",
      button: 0x0100,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 1,
        gameSubmode: 32,
        selectorCurrent: 10,
        selectorRequest: -1,
      },
    },
    {
      id: "select-current-16",
      type: "input",
      button: 0x0100,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 1,
        gameSubmode: 32,
        selectorCurrent: 16,
        selectorRequest: -1,
      },
    },
    {
      id: "select-current-18",
      type: "input",
      button: 0x0100,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 1,
        gameSubmode: 32,
        selectorCurrent: 18,
        selectorRequest: -1,
      },
    },
    {
      id: "select-current-22",
      type: "input",
      button: 0x0100,
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 1,
        gameSubmode: 32,
        selectorCurrent: 22,
        selectorRequest: -1,
      },
    },
    {
      id: "ready-main",
      type: "observe",
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 2,
        gameSubmode: 49,
        attempts: 1,
        floor: 1,
      },
    },
    {
      id: "play-main",
      type: "observe",
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 2,
        gameSubmode: 51,
        attempts: 1,
        floor: 1,
      },
    },
    {
      id: "post-play-presented",
      type: "observe",
      witness: {
        pad: { held: 0, pressed: 0, released: 0 },
        gameMode: 2,
        gameSubmode: 51,
        attempts: 1,
        floor: 1,
      },
    },
  ],
});

export class GameplayTranscriptValidationError extends Error {
  constructor(code, path, detail) {
    super(`gameplay transcript ${code} at ${path}: ${detail}`);
    this.name = "GameplayTranscriptValidationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, detail) {
  throw new GameplayTranscriptValidationError(code, path, detail);
}

function describe(value) {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
  } catch {
    return String(value);
  }
}

function childPath(path, key) {
  if (typeof key === "number") return `${path}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

function requireObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("envelope", path, `expected an object, got ${describe(value)}`);
  }
  return value;
}

function requireExactKeys(value, expected, path) {
  requireObject(value, path);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(
      "envelope",
      `${path}.[keys]`,
      `expected ${describe(wanted)}, got ${describe(actual)}`,
    );
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail("envelope", path, `expected a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function requireInteger(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(
      "envelope",
      path,
      `expected a safe integer from ${minimum} through ${maximum}, got ${describe(value)}`,
    );
  }
  return value;
}

function requireExact(value, expected, path, code = "provenance") {
  if (value !== expected) {
    fail(code, path, `expected ${describe(expected)}, got ${describe(value)}`);
  }
  return value;
}

function validatePlannedWitness(witness, path) {
  requireObject(witness, path);
  const keys = Object.keys(witness);
  if (!keys.includes("pad")) {
    fail("envelope", `${path}.pad`, "expected an explicit neutral-pad predicate");
  }
  for (const key of keys) {
    if (!WITNESS_FIELDS.includes(key)) {
      fail("envelope", childPath(path, key), "unsupported gameplay witness field");
    }
  }
  const pad = requireExactKeys(
    witness.pad,
    ["held", "pressed", "released"],
    `${path}.pad`,
  );
  for (const field of ["held", "pressed", "released"]) {
    requireExact(
      requireInteger(pad[field], `${path}.pad.${field}`, 0, 0xffff),
      0,
      `${path}.pad.${field}`,
    );
  }
  for (const field of keys.filter(key => key !== "pad")) {
    const minimum = SIGNED_SENTINEL_WITNESS_FIELDS.has(field) ? -1 : 0;
    const maximum = field === "gameVersion" ? 0xff : 0xffff_ffff;
    requireInteger(witness[field], `${path}.${field}`, minimum, maximum);
  }
  return witness;
}

function validatePlan(plan) {
  requireExactKeys(plan, ["game", "scenario", "input", "steps"], "$plan");
  const game = requireExactKeys(plan.game, ["identifier", "revision"], "$plan.game");
  const identifier = requireString(game.identifier, "$plan.game.identifier");
  if (!/^[A-Z0-9]{6}$/.test(identifier)) {
    fail("envelope", "$plan.game.identifier", "expected a six-character disc identifier");
  }
  requireInteger(game.revision, "$plan.game.revision", 0, 0xff);

  const scenario = requireExactKeys(
    plan.scenario,
    ["id", "hardCycleLimit", "startCycle"],
    "$plan.scenario",
  );
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requireString(scenario.id, "$plan.scenario.id"))) {
    fail("envelope", "$plan.scenario.id", "expected a lowercase kebab-case id");
  }
  const hardCycleLimit = requireInteger(
    scenario.hardCycleLimit,
    "$plan.scenario.hardCycleLimit",
    1,
  );
  const startCycle = requireInteger(scenario.startCycle, "$plan.scenario.startCycle");
  if (startCycle >= hardCycleLimit) {
    fail(
      "ordering",
      "$plan.scenario.startCycle",
      `expected a value below the hard cycle limit ${hardCycleLimit}`,
    );
  }

  const input = requireExactKeys(
    plan.input,
    ["publicationsPerPhase", "source"],
    "$plan.input",
  );
  requireInteger(input.publicationsPerPhase, "$plan.input.publicationsPerPhase", 1);
  requireString(input.source, "$plan.input.source");

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    fail("envelope", "$plan.steps", "expected a non-empty array");
  }
  const ids = new Set();
  for (const [index, step] of plan.steps.entries()) {
    const path = `$plan.steps[${index}]`;
    requireObject(step, path);
    if (step.type === "input") {
      requireExactKeys(step, ["id", "type", "button", "witness"], path);
      requireInteger(step.button, `${path}.button`, 1, 0xffff);
    } else if (step.type === "observe") {
      requireExactKeys(step, ["id", "type", "witness"], path);
    } else {
      fail("envelope", `${path}.type`, `expected "input" or "observe", got ${describe(step.type)}`);
    }
    const id = requireString(step.id, `${path}.id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      fail("envelope", `${path}.id`, "expected a lowercase kebab-case id");
    }
    if (ids.has(id)) fail("identity", `${path}.id`, `duplicate step id ${describe(id)}`);
    ids.add(id);
    validatePlannedWitness(step.witness, `${path}.witness`);
  }
  if (plan.steps.at(-1).type !== "observe") {
    fail("envelope", `$plan.steps[${plan.steps.length - 1}].type`, "expected a terminal observation");
  }
  return plan;
}

function validateWitness(witness, path, revision, expected) {
  requireExactKeys(witness, WITNESS_FIELDS, path);
  const pad = requireExactKeys(
    witness.pad,
    ["held", "pressed", "released"],
    `${path}.pad`,
  );
  for (const field of ["held", "pressed", "released"]) {
    requireInteger(pad[field], `${path}.pad.${field}`, 0, 0xffff);
  }
  for (const field of WITNESS_FIELDS.slice(1)) {
    const minimum = SIGNED_SENTINEL_WITNESS_FIELDS.has(field) ? -1 : 0;
    const maximum = field === "gameVersion" ? 0xff : 0xffff_ffff;
    requireInteger(witness[field], `${path}.${field}`, minimum, maximum);
  }
  requireExact(witness.gameVersion, revision, `${path}.gameVersion`, "identity");
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (field === "pad") {
      for (const [padField, padValue] of Object.entries(expectedValue)) {
        requireExact(witness.pad[padField], padValue, `${path}.pad.${padField}`);
      }
    } else {
      requireExact(witness[field], expectedValue, `${path}.${field}`);
    }
  }
  return witness;
}

function validatePublication(
  publication,
  path,
  expected,
  state,
  transcript,
) {
  requireExactKeys(
    publication,
    ["source", "pollIndex", "scheduledCycle", "observedCycle", "buttons", "sequence"],
    path,
  );
  requireExact(publication.source, expected.source, `${path}.source`);
  const pollIndex = requireInteger(publication.pollIndex, `${path}.pollIndex`, 1);
  const scheduledCycle = requireInteger(publication.scheduledCycle, `${path}.scheduledCycle`);
  const observedCycle = requireInteger(publication.observedCycle, `${path}.observedCycle`);
  requireExact(publication.buttons, expected.buttons, `${path}.buttons`);
  requireExact(publication.sequence, expected.sequence, `${path}.sequence`);
  if (state.polls.has(pollIndex)) {
    fail("ordering", `${path}.pollIndex`, `duplicate publication poll ${pollIndex}`);
  }
  if (pollIndex <= state.lastPublicationPoll) {
    fail(
      "ordering",
      `${path}.pollIndex`,
      `expected a value greater than ${state.lastPublicationPoll}, got ${pollIndex}`,
    );
  }
  if (scheduledCycle < state.lastScheduledCycle) {
    fail(
      "ordering",
      `${path}.scheduledCycle`,
      `expected a value no smaller than ${state.lastScheduledCycle}, got ${scheduledCycle}`,
    );
  }
  if (observedCycle < scheduledCycle) {
    fail(
      "ordering",
      `${path}.observedCycle`,
      `expected a value no smaller than scheduled cycle ${scheduledCycle}, got ${observedCycle}`,
    );
  }
  if (observedCycle < state.lastObservedCycle) {
    fail(
      "ordering",
      `${path}.observedCycle`,
      `expected a value no smaller than ${state.lastObservedCycle}, got ${observedCycle}`,
    );
  }
  if (
    scheduledCycle < transcript.scenario.startCycle
    || observedCycle > transcript.scenario.completedCycle
  ) {
    fail(
      "ordering",
      path,
      `expected publication within scenario cycles ${transcript.scenario.startCycle}`
        + `..${transcript.scenario.completedCycle}`,
    );
  }
  state.polls.add(pollIndex);
  state.lastPublicationPoll = pollIndex;
  state.lastScheduledCycle = scheduledCycle;
  state.lastObservedCycle = observedCycle;
}

function validateInputStep(step, expected, index, state, transcript, plan) {
  const path = `$.steps[${index}]`;
  requireExactKeys(
    step,
    ["id", "type", "button", "ready", "press", "release", "guest", "completed"],
    path,
  );
  requireExact(step.id, expected.id, `${path}.id`, "identity");
  requireExact(step.type, "input", `${path}.type`, "identity");
  requireExact(step.button, expected.button, `${path}.button`, "identity");

  const ready = requireExactKeys(step.ready, ["cycle", "pollIndex", "witness"], `${path}.ready`);
  const readyCycle = requireInteger(ready.cycle, `${path}.ready.cycle`);
  const readyPoll = requireInteger(ready.pollIndex, `${path}.ready.pollIndex`);
  validateWitness(
    ready.witness,
    `${path}.ready.witness`,
    plan.game.revision,
    expected.witness,
  );
  if (readyCycle < state.lastMilestoneCycle || readyPoll < state.lastMilestonePoll) {
    fail(
      "ordering",
      `${path}.ready`,
      `expected a milestone at or after cycle ${state.lastMilestoneCycle}, poll ${state.lastMilestonePoll}`,
    );
  }

  const phases = [
    ["press", step.press, expected.button, state.nextSequence],
    ["release", step.release, 0, state.nextSequence + 1],
  ];
  for (const [name, phase, buttons, sequence] of phases) {
    const phasePath = `${path}.${name}`;
    requireExactKeys(phase, ["sequence", "publications"], phasePath);
    requireExact(phase.sequence, sequence, `${phasePath}.sequence`);
    if (!Array.isArray(phase.publications)) {
      fail("envelope", `${phasePath}.publications`, "expected an array");
    }
    requireExact(
      phase.publications.length,
      plan.input.publicationsPerPhase,
      `${phasePath}.publications.length`,
    );
    for (const [publicationIndex, publication] of phase.publications.entries()) {
      validatePublication(
        publication,
        `${phasePath}.publications[${publicationIndex}]`,
        { source: plan.input.source, buttons, sequence },
        state,
        transcript,
      );
    }
  }
  const firstPress = step.press.publications[0];
  const firstRelease = step.release.publications[0];
  const lastRelease = step.release.publications.at(-1);
  if (firstPress.pollIndex !== readyPoll + 1 || firstPress.scheduledCycle <= readyCycle) {
    fail(
      "ordering",
      `${path}.press.publications[0]`,
      "expected the first press publication in the poll immediately after the ready milestone",
    );
  }
  const pulsePublications = [
    ...step.press.publications,
    ...step.release.publications,
  ];
  for (let publicationIndex = 1; publicationIndex < pulsePublications.length; publicationIndex += 1) {
    const previousPoll = pulsePublications[publicationIndex - 1].pollIndex;
    const poll = pulsePublications[publicationIndex].pollIndex;
    if (poll !== previousPoll + 1) {
      const phaseName = publicationIndex < step.press.publications.length
        ? "press"
        : "release";
      const phaseIndex = phaseName === "press"
        ? publicationIndex
        : publicationIndex - step.press.publications.length;
      fail(
        "ordering",
        `${path}.${phaseName}.publications[${phaseIndex}].pollIndex`,
        `expected the poll immediately after ${previousPoll}, got ${poll}`,
      );
    }
  }

  const guest = requireExactKeys(
    step.guest,
    ["pressedCycle", "releasedCycle", "neutralCycle"],
    `${path}.guest`,
  );
  const pressedCycle = requireInteger(guest.pressedCycle, `${path}.guest.pressedCycle`);
  const releasedCycle = requireInteger(guest.releasedCycle, `${path}.guest.releasedCycle`);
  const neutralCycle = requireInteger(guest.neutralCycle, `${path}.guest.neutralCycle`);
  if (!(pressedCycle < releasedCycle && releasedCycle < neutralCycle)) {
    fail(
      "ordering",
      `${path}.guest`,
      `expected pressed < released < neutral, got ${pressedCycle}, ${releasedCycle}, ${neutralCycle}`,
    );
  }
  if (pressedCycle < firstPress.observedCycle) {
    fail(
      "provenance",
      `${path}.guest.pressedCycle`,
      `expected a value no smaller than the first press observation ${firstPress.observedCycle}`,
    );
  }
  if (pressedCycle >= firstRelease.observedCycle) {
    fail(
      "provenance",
      `${path}.guest.pressedCycle`,
      `expected a value below the first release observation ${firstRelease.observedCycle}`,
    );
  }
  if (releasedCycle < firstRelease.observedCycle) {
    fail(
      "provenance",
      `${path}.guest.releasedCycle`,
      `expected a value no smaller than the first release observation ${firstRelease.observedCycle}`,
    );
  }

  const completed = requireExactKeys(
    step.completed,
    ["cycle", "pollIndex"],
    `${path}.completed`,
  );
  const completedCycle = requireInteger(completed.cycle, `${path}.completed.cycle`);
  const completedPoll = requireInteger(completed.pollIndex, `${path}.completed.pollIndex`);
  requireExact(completedPoll, lastRelease.pollIndex, `${path}.completed.pollIndex`);
  if (neutralCycle > completedCycle || lastRelease.observedCycle > completedCycle) {
    fail(
      "ordering",
      `${path}.completed.cycle`,
      `expected a value at least ${Math.max(neutralCycle, lastRelease.observedCycle)}, got ${completedCycle}`,
    );
  }
  if (
    readyCycle < transcript.scenario.startCycle
    || completedCycle > transcript.scenario.completedCycle
  ) {
    fail(
      "ordering",
      path,
      `expected step within scenario cycles ${transcript.scenario.startCycle}`
        + `..${transcript.scenario.completedCycle}`,
    );
  }
  state.nextSequence += 2;
  state.lastMilestoneCycle = completedCycle;
  state.lastMilestonePoll = completedPoll;
}

function validateObserveStep(step, expected, index, state, transcript, plan) {
  const path = `$.steps[${index}]`;
  requireExactKeys(step, ["id", "type", "observed"], path);
  requireExact(step.id, expected.id, `${path}.id`, "identity");
  requireExact(step.type, "observe", `${path}.type`, "identity");
  const observed = requireExactKeys(
    step.observed,
    ["cycle", "pollIndex", "witness"],
    `${path}.observed`,
  );
  const cycle = requireInteger(observed.cycle, `${path}.observed.cycle`);
  const poll = requireInteger(observed.pollIndex, `${path}.observed.pollIndex`);
  validateWitness(
    observed.witness,
    `${path}.observed.witness`,
    plan.game.revision,
    expected.witness,
  );
  if (cycle < state.lastMilestoneCycle || poll < state.lastMilestonePoll) {
    fail(
      "ordering",
      `${path}.observed`,
      `expected a milestone at or after cycle ${state.lastMilestoneCycle}, poll ${state.lastMilestonePoll}`,
    );
  }
  if (cycle > transcript.scenario.completedCycle) {
    fail(
      "ordering",
      `${path}.observed.cycle`,
      `expected a value no greater than ${transcript.scenario.completedCycle}, got ${cycle}`,
    );
  }
  state.lastMilestoneCycle = cycle;
  state.lastMilestonePoll = poll;
}

export function validateGameplayTranscript(transcript, plan) {
  validatePlan(plan);
  requireExactKeys(
    transcript,
    ["schema", "game", "scenario", "controller", "steps"],
    "$",
  );
  requireExact(transcript.schema, GAMEPLAY_TRANSCRIPT_SCHEMA_V1, "$.schema", "identity");

  const game = requireExactKeys(transcript.game, ["identifier", "revision"], "$.game");
  requireExact(game.identifier, plan.game.identifier, "$.game.identifier", "identity");
  requireExact(game.revision, plan.game.revision, "$.game.revision", "identity");

  const scenario = requireExactKeys(
    transcript.scenario,
    ["id", "status", "hardCycleLimit", "startCycle", "completedCycle"],
    "$.scenario",
  );
  requireExact(scenario.id, plan.scenario.id, "$.scenario.id", "identity");
  requireExact(scenario.status, "complete", "$.scenario.status");
  requireExact(
    scenario.hardCycleLimit,
    plan.scenario.hardCycleLimit,
    "$.scenario.hardCycleLimit",
    "identity",
  );
  requireExact(
    scenario.startCycle,
    plan.scenario.startCycle,
    "$.scenario.startCycle",
    "identity",
  );
  const completedCycle = requireInteger(
    scenario.completedCycle,
    "$.scenario.completedCycle",
  );
  if (completedCycle < scenario.startCycle || completedCycle >= scenario.hardCycleLimit) {
    fail(
      "ordering",
      "$.scenario.completedCycle",
      `expected ${scenario.startCycle} through ${scenario.hardCycleLimit - 1}, got ${completedCycle}`,
    );
  }

  const controller = requireExactKeys(
    transcript.controller,
    [
      "pollIndex",
      "appliedSequence",
      "lastPolledSequence",
      "lastPolledButtons",
      "pendingButtons",
      "queuedStates",
      "queueOverflows",
    ],
    "$.controller",
  );
  const controllerPoll = requireInteger(controller.pollIndex, "$.controller.pollIndex");
  const inputCount = plan.steps.filter(step => step.type === "input").length;
  const finalSequence = inputCount * 2;
  requireExact(
    requireInteger(controller.appliedSequence, "$.controller.appliedSequence"),
    finalSequence,
    "$.controller.appliedSequence",
  );
  requireExact(
    requireInteger(controller.lastPolledSequence, "$.controller.lastPolledSequence"),
    finalSequence,
    "$.controller.lastPolledSequence",
  );
  for (const field of ["lastPolledButtons", "pendingButtons", "queuedStates"]) {
    requireExact(
      requireInteger(controller[field], `$.controller.${field}`),
      0,
      `$.controller.${field}`,
    );
  }
  const queueOverflows = requireInteger(controller.queueOverflows, "$.controller.queueOverflows");
  if (queueOverflows !== 0) {
    fail("overflow", "$.controller.queueOverflows", `expected 0, got ${queueOverflows}`);
  }

  if (!Array.isArray(transcript.steps)) {
    fail("envelope", "$.steps", "expected an array");
  }
  requireExact(transcript.steps.length, plan.steps.length, "$.steps.length", "identity");
  const state = {
    nextSequence: 1,
    lastMilestoneCycle: scenario.startCycle,
    lastMilestonePoll: 0,
    lastPublicationPoll: 0,
    lastScheduledCycle: scenario.startCycle,
    lastObservedCycle: scenario.startCycle,
    polls: new Set(),
  };
  for (const [index, expected] of plan.steps.entries()) {
    if (expected.type === "input") {
      validateInputStep(transcript.steps[index], expected, index, state, transcript, plan);
    } else {
      validateObserveStep(transcript.steps[index], expected, index, state, transcript, plan);
    }
  }
  requireExact(state.nextSequence - 1, finalSequence, "$.controller.appliedSequence");
  const terminal = transcript.steps.at(-1).observed;
  const terminalPath = `$.steps[${transcript.steps.length - 1}].observed`;
  requireExact(terminal.cycle, scenario.completedCycle, `${terminalPath}.cycle`);
  requireExact(terminal.pollIndex, controllerPoll, `${terminalPath}.pollIndex`);
  return transcript;
}

export function validateSmbReadyPlayGameplayTranscript(transcript) {
  return validateGameplayTranscript(transcript, SMB_READY_PLAY_GAMEPLAY_PLAN);
}
