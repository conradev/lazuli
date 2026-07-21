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
