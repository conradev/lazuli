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

function projectWitness(raw, path, eventCycle, revision) {
  requireObject(raw, path);
  requireExact(raw.cycle, eventCycle, `${path}.cycle`);
  const pad = requireObject(raw.pad, `${path}.pad`);
  const witness = {
    pad: {
      held: requireInteger(pad.held, `${path}.pad.held`, 0, 0xffff),
      pressed: requireInteger(pad.pressed, `${path}.pad.pressed`, 0, 0xffff),
      released: requireInteger(pad.released, `${path}.pad.released`, 0, 0xffff),
    },
  };
  for (const field of WITNESS_FIELDS.slice(1)) {
    const minimum = SIGNED_SENTINEL_WITNESS_FIELDS.has(field) ? -1 : 0;
    const maximum = field === "gameVersion" ? 0xff : 0xffff_ffff;
    witness[field] = requireInteger(raw[field], `${path}.${field}`, minimum, maximum);
  }
  requireExact(witness.gameVersion, revision, `${path}.gameVersion`, "identity");
  return witness;
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

function projectPublication(raw, path) {
  requireObject(raw, path);
  return {
    source: requireString(raw.source, `${path}.source`),
    pollIndex: requireInteger(raw.pollIndex, `${path}.pollIndex`, 1),
    scheduledCycle: requireInteger(raw.scheduledCycle, `${path}.scheduledCycle`),
    observedCycle: requireInteger(raw.observedCycle, `${path}.observedCycle`),
    buttons: requireInteger(raw.buttons, `${path}.buttons`, 0, 0xffff),
    sequence: requireInteger(raw.sequence, `${path}.sequence`, 1),
  };
}

function validateRawPhase(phase, path, expectedSequence, expectedButtons, plan) {
  requireObject(phase, path);
  requireExact(phase.sequence, expectedSequence, `${path}.sequence`);
  requireExact(
    phase.polls,
    plan.input.publicationsPerPhase,
    `${path}.polls`,
  );
  if (!Array.isArray(phase.publications)) {
    fail("envelope", `${path}.publications`, "expected an array");
  }
  requireExact(
    phase.publications.length,
    plan.input.publicationsPerPhase,
    `${path}.publications.length`,
  );
  const publications = phase.publications.map((publication, index) =>
    projectPublication(publication, `${path}.publications[${index}]`));
  for (const [index, publication] of publications.entries()) {
    const publicationPath = `${path}.publications[${index}]`;
    requireExact(publication.source, plan.input.source, `${publicationPath}.source`);
    requireExact(publication.sequence, expectedSequence, `${publicationPath}.sequence`);
    requireExact(publication.buttons, expectedButtons, `${publicationPath}.buttons`);
  }
  const first = publications[0];
  const last = publications.at(-1);
  for (const [field, expected] of [
    ["firstPollIndex", first.pollIndex],
    ["lastPollIndex", last.pollIndex],
    ["firstScheduledCycle", first.scheduledCycle],
    ["lastScheduledCycle", last.scheduledCycle],
    ["firstObservedCycle", first.observedCycle],
    ["lastObservedCycle", last.observedCycle],
  ]) {
    requireExact(phase[field], expected, `${path}.${field}`);
  }
  return {
    sequence: expectedSequence,
    publications,
  };
}

function deriveInputStep(raw, expected, index, sequence, plan) {
  const path = `$report.scenario.steps[${index}]`;
  requireObject(raw, path);
  requireExact(raw.id, expected.id, `${path}.id`, "identity");
  requireExact(raw.type, "input", `${path}.type`, "identity");
  requireExact(raw.button, expected.button, `${path}.button`, "identity");
  const readyCycle = requireInteger(raw.readyCycle, `${path}.readyCycle`);
  const readyPollIndex = requireInteger(raw.readyPollIndex, `${path}.readyPollIndex`);
  const press = validateRawPhase(raw.press, `${path}.press`, sequence, expected.button, plan);
  const release = validateRawPhase(raw.release, `${path}.release`, sequence + 1, 0, plan);
  const guest = requireObject(raw.guest, `${path}.guest`);
  return {
    id: expected.id,
    type: "input",
    button: expected.button,
    ready: {
      cycle: readyCycle,
      pollIndex: readyPollIndex,
      witness: projectWitness(
        raw.readyState,
        `${path}.readyState`,
        readyCycle,
        plan.game.revision,
      ),
    },
    press,
    release,
    guest: {
      pressedCycle: requireInteger(guest.pressedCycle, `${path}.guest.pressedCycle`),
      releasedCycle: requireInteger(guest.releasedCycle, `${path}.guest.releasedCycle`),
      neutralCycle: requireInteger(guest.neutralCycle, `${path}.guest.neutralCycle`),
    },
    completed: {
      cycle: requireInteger(raw.completedCycle, `${path}.completedCycle`),
      pollIndex: requireInteger(raw.completedPollIndex, `${path}.completedPollIndex`),
    },
  };
}

function deriveObserveStep(raw, expected, index, plan) {
  const path = `$report.scenario.steps[${index}]`;
  requireObject(raw, path);
  requireExact(raw.id, expected.id, `${path}.id`, "identity");
  requireExact(raw.type, "observe", `${path}.type`, "identity");
  const observedCycle = requireInteger(raw.observedCycle, `${path}.observedCycle`);
  const observedPollIndex = requireInteger(raw.observedPollIndex, `${path}.observedPollIndex`);
  return {
    id: expected.id,
    type: "observe",
    observed: {
      cycle: observedCycle,
      pollIndex: observedPollIndex,
      witness: projectWitness(
        raw.state,
        `${path}.state`,
        observedCycle,
        plan.game.revision,
      ),
    },
  };
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

export function deriveGameplayTranscript(report, plan) {
  validatePlan(plan);
  requireObject(report, "$report");
  requireExact(report.status, "paused", "$report.status");
  requireExact(report.stage, "scenario-complete", "$report.stage");
  const reportCycles = requireInteger(report.cycles, "$report.cycles");

  const disc = requireObject(report.disc, "$report.disc");
  requireExact(disc.identifier, plan.game.identifier, "$report.disc.identifier", "identity");
  requireExact(disc.revision, plan.game.revision, "$report.disc.revision", "identity");

  const scenario = requireObject(report.scenario, "$report.scenario");
  requireExact(scenario.id, plan.scenario.id, "$report.scenario.id", "identity");
  requireExact(
    scenario.gameIdentifier,
    plan.game.identifier,
    "$report.scenario.gameIdentifier",
    "identity",
  );
  requireExact(scenario.status, "complete", "$report.scenario.status");
  requireExact(
    scenario.hardCycleLimit,
    plan.scenario.hardCycleLimit,
    "$report.scenario.hardCycleLimit",
    "identity",
  );
  requireExact(
    scenario.startCycle,
    plan.scenario.startCycle,
    "$report.scenario.startCycle",
    "identity",
  );
  const completedCycle = requireInteger(
    scenario.completedCycle,
    "$report.scenario.completedCycle",
  );
  requireExact(reportCycles, completedCycle, "$report.cycles");
  if (completedCycle >= scenario.hardCycleLimit) {
    fail(
      "ordering",
      "$report.scenario.completedCycle",
      `expected a value below ${scenario.hardCycleLimit}, got ${completedCycle}`,
    );
  }
  requireExact(scenario.failure, null, "$report.scenario.failure");
  requireExact(scenario.currentStep, null, "$report.scenario.currentStep");
  if (!Array.isArray(scenario.steps)) {
    fail("envelope", "$report.scenario.steps", "expected an array");
  }
  requireExact(scenario.steps.length, plan.steps.length, "$report.scenario.steps.length", "identity");
  requireExact(scenario.stepIndex, scenario.steps.length, "$report.scenario.stepIndex");
  const finalRawStep = scenario.steps.at(-1);
  const lastStateDifference = firstDifference(
    finalRawStep?.state,
    scenario.lastState,
    "$report.scenario.lastState",
  );
  if (lastStateDifference !== null) {
    fail(
      "provenance",
      lastStateDifference.path,
      `expected ${describe(lastStateDifference.expected)}, got ${describe(lastStateDifference.actual)}`,
    );
  }

  const controller = requireObject(report.controller, "$report.controller");
  const scenarioPoll = requireInteger(scenario.pollIndex, "$report.scenario.pollIndex");
  const controllerPoll = requireInteger(controller.pollIndex, "$report.controller.pollIndex");
  requireExact(controllerPoll, scenarioPoll, "$report.controller.pollIndex");

  let sequence = 1;
  const steps = plan.steps.map((expected, index) => {
    if (expected.type === "observe") {
      return deriveObserveStep(scenario.steps[index], expected, index, plan);
    }
    const step = deriveInputStep(scenario.steps[index], expected, index, sequence, plan);
    sequence += 2;
    return step;
  });
  const transcript = {
    schema: GAMEPLAY_TRANSCRIPT_SCHEMA_V1,
    game: {
      identifier: plan.game.identifier,
      revision: plan.game.revision,
    },
    scenario: {
      id: plan.scenario.id,
      status: "complete",
      hardCycleLimit: plan.scenario.hardCycleLimit,
      startCycle: plan.scenario.startCycle,
      completedCycle,
    },
    controller: {
      pollIndex: controllerPoll,
      appliedSequence: requireInteger(
        controller.appliedSequence,
        "$report.controller.appliedSequence",
      ),
      lastPolledSequence: requireInteger(
        controller.lastPolledSequence,
        "$report.controller.lastPolledSequence",
      ),
      lastPolledButtons: requireInteger(
        controller.lastPolledButtons,
        "$report.controller.lastPolledButtons",
        0,
        0xffff,
      ),
      pendingButtons: requireInteger(
        controller.pendingButtons,
        "$report.controller.pendingButtons",
        0,
        0xffff,
      ),
      queuedStates: requireInteger(controller.queuedStates, "$report.controller.queuedStates"),
      queueOverflows: requireInteger(
        controller.queueOverflows,
        "$report.controller.queueOverflows",
      ),
    },
    steps,
  };
  validateGameplayTranscript(transcript, plan);
  return transcript;
}

function firstDifference(expected, actual, path = "$") {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { expected, actual, path };
    if (expected.length !== actual.length) {
      return { expected: expected.length, actual: actual.length, path: `${path}.length` };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(
        expected[index],
        actual[index],
        childPath(path, index),
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  const expectedObject = expected !== null && typeof expected === "object";
  const actualObject = actual !== null && typeof actual === "object";
  if (!expectedObject || !actualObject) return { expected, actual, path };
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  const keyDifference = firstDifference(expectedKeys, actualKeys, `${path}.[keys]`);
  if (keyDifference !== null) return keyDifference;
  for (const key of expectedKeys) {
    const difference = firstDifference(
      expected[key],
      actual[key],
      childPath(path, key),
    );
    if (difference !== null) return difference;
  }
  return null;
}

export function verifyGameplayTranscript(report, transcript, plan) {
  validateGameplayTranscript(transcript, plan);
  const derived = deriveGameplayTranscript(report, plan);
  const difference = firstDifference(derived, transcript);
  if (difference !== null) {
    fail(
      "transcript-mismatch",
      difference.path,
      `expected ${describe(difference.expected)}, got ${describe(difference.actual)}`,
    );
  }
  return derived;
}

export function deriveSmbReadyPlayGameplayTranscript(report) {
  return deriveGameplayTranscript(report, SMB_READY_PLAY_GAMEPLAY_PLAN);
}

export function validateSmbReadyPlayGameplayTranscript(transcript) {
  return validateGameplayTranscript(transcript, SMB_READY_PLAY_GAMEPLAY_PLAN);
}

export function verifySmbReadyPlayGameplayTranscript(report, transcript) {
  return verifyGameplayTranscript(report, transcript, SMB_READY_PLAY_GAMEPLAY_PLAN);
}
