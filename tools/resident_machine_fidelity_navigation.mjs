// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";

export const PRODUCTION_FIDELITY_NAVIGATION_SCHEMA =
  "lazuli-resident-pre-baseline-navigation-v1";
export const PRODUCTION_FIDELITY_NAVIGATION_ALGORITHM =
  "locked-si-observed-not-before-publication-v1";
export const PRODUCTION_FIDELITY_SI_FIELD_CYCLES = "8108100";
export const PRODUCTION_FIDELITY_MAXIMUM_SI_RECEIPT_LATENCY_CYCLES = "16108100";
export const PRODUCTION_FIDELITY_NAVIGATION_PUBLICATION_CAP = 65;
export const WARIO_AUTHENTICATED_REPELLION_CANONICAL_CYCLE_UPPER_BOUND = "27000000000";
export const WARIO_CANONICAL_CYCLE_CAP_MARGIN = "5000000000";

const CONTROLLER_BUTTON_MASK = 0x0000_1f7f;
const CENTERED_STICKS = 0x8080_8080;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GAME_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POLICY_FIELDS = Object.freeze([
  "schema",
  "gameKey",
  "algorithm",
  "cycleOrigin",
  "controllerEncoding",
  "targetAnchor",
  "receiptSource",
  "periodicSiCycles",
  "maximumReceiptLatencyCycles",
  "maximumPublications",
  "scriptSha256",
  "steps",
]);
const STEP_FIELDS = Object.freeze([
  "minimumCanonicalDelay",
  "buttons",
  "stickXyCxy",
  "triggerLrab",
]);

export const PRODUCTION_FIDELITY_GAME_KEYS = Object.freeze([
  "warioware-usa",
  "luigis-mansion-usa",
  "wind-waker-usa",
  "melee-usa-rev-2",
  "f-zero-gx-usa",
  "metroid-prime-usa-rev-2",
  "rogue-leader-usa",
]);

const NEUTRAL = Object.freeze({ buttons: 0, stickXyCxy: CENTERED_STICKS, triggerLrab: 0 });
const A = Object.freeze({ buttons: 0x0100, stickXyCxy: CENTERED_STICKS, triggerLrab: 0x00ff_0000 });
const UP = Object.freeze({ buttons: 0x0008, stickXyCxy: 0x8080_ff80, triggerLrab: 0 });
const START = Object.freeze({ buttons: 0x1000, stickXyCxy: CENTERED_STICKS, triggerLrab: 0 });

function scheduledController(minimumCanonicalDelay, controller) {
  return Object.freeze({ minimumCanonicalDelay, ...controller });
}

// These WarioWare transitions were visually observed through the third microgame, Repellion.
// Each delay is a not-before minimum from the prior Rust-authenticated SI observed cycle (the
// first is from the durable first-frame arm origin). This makes arbitrary calibration times safe
// when they fall between PPC block boundaries: the Worker advances ordinary bounded slices and
// publishes at the first canonical boundary at or after the target. F is the exact 8,108,100-cycle
// SI field period: every state is held for at least 3F and name presses remain at least 6F apart.
// Authenticated manual evidence reached the Repellion vicinity by 26.561B canonical cycles. The
// frozen conservative bound is 27B; the 32B canonical ceiling retains 5B cycles of margin.
const WARIOWARE_USA_STEPS = Object.freeze([
  scheduledController("4000000000", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("40540500", UP),
  scheduledController("24324300", NEUTRAL),
  scheduledController("40540500", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("656756100", START),
  scheduledController("24324300", NEUTRAL),
  scheduledController("105405300", START),
  scheduledController("24324300", NEUTRAL),
  scheduledController("948647700", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("883782900", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("1532430900", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("24324300", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("24324300", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("24324300", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("24324300", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("40540500", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("754053300", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("818918100", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("105405300", A),
  scheduledController("24324300", NEUTRAL),
  scheduledController("2959456500", A),
  scheduledController("24324300", NEUTRAL),
]);

// Other title schedules remain empty until an exploratory run establishes their transitions.
// Adding a step changes the authenticated source and evidence-lock authority for that release.
const PRODUCTION_FIDELITY_NAVIGATION_STEPS = Object.freeze({
  "warioware-usa": WARIOWARE_USA_STEPS,
  ...Object.fromEntries(PRODUCTION_FIDELITY_GAME_KEYS.slice(1).map(gameKey => [
    gameKey,
    Object.freeze([]),
  ])),
});

function exactKeys(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} fields changed`);
  }
}

function exactU32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be an exact u32`);
  }
  return value >>> 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

export function navigationScriptSha256(steps) {
  return createHash("sha256").update(canonicalJson(steps), "utf8").digest("hex");
}

function normalizedSteps(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > PRODUCTION_FIDELITY_NAVIGATION_PUBLICATION_CAP) {
    throw new Error(`${label} exceeds the navigation publication cap`);
  }
  const steps = value.map((step, index) => {
    const stepLabel = `${label}[${index}]`;
    exactKeys(step, STEP_FIELDS, stepLabel);
    if (
      typeof step.minimumCanonicalDelay !== "string"
      || !/^[1-9][0-9]*$/.test(step.minimumCanonicalDelay)
    ) {
      throw new Error(`${stepLabel}.minimumCanonicalDelay must be a positive decimal string`);
    }
    const buttons = exactU32(step.buttons, `${stepLabel}.buttons`);
    if ((buttons & ~CONTROLLER_BUTTON_MASK) !== 0) {
      throw new Error(`${stepLabel}.buttons contains reserved GameCube button bits`);
    }
    return Object.freeze({
      minimumCanonicalDelay: step.minimumCanonicalDelay,
      buttons,
      stickXyCxy: exactU32(step.stickXyCxy, `${stepLabel}.stickXyCxy`),
      triggerLrab: exactU32(step.triggerLrab, `${stepLabel}.triggerLrab`),
    });
  });
  if (steps.length !== 0) {
    const terminal = steps.at(-1);
    if (
      terminal.buttons !== 0
      || terminal.stickXyCxy !== CENTERED_STICKS
      || terminal.triggerLrab !== 0
    ) {
      throw new Error(`${label} must end in an exact neutral controller state`);
    }
  }
  return Object.freeze(steps);
}

export function fidelityNavigationPolicyFromSteps(gameKey, sourceSteps) {
  if (typeof gameKey !== "string" || !GAME_KEY_PATTERN.test(gameKey)) {
    throw new Error("navigation policy gameKey must be lowercase kebab-case");
  }
  const steps = normalizedSteps(sourceSteps, "navigation policy steps");
  return Object.freeze({
    schema: PRODUCTION_FIDELITY_NAVIGATION_SCHEMA,
    gameKey,
    algorithm: PRODUCTION_FIDELITY_NAVIGATION_ALGORITHM,
    cycleOrigin: "durable-first-frame-canonical-scheduler-cycle",
    controllerEncoding: "gamecube-packed-controller-v1",
    targetAnchor: "prior-si-observed-cycle",
    receiptSource: "periodic",
    periodicSiCycles: PRODUCTION_FIDELITY_SI_FIELD_CYCLES,
    maximumReceiptLatencyCycles: PRODUCTION_FIDELITY_MAXIMUM_SI_RECEIPT_LATENCY_CYCLES,
    maximumPublications: PRODUCTION_FIDELITY_NAVIGATION_PUBLICATION_CAP,
    scriptSha256: navigationScriptSha256(steps),
    steps,
  });
}

export function validateFidelityNavigationPolicy(value, expectedGameKey = null) {
  exactKeys(value, POLICY_FIELDS, "navigation policy");
  if (value.schema !== PRODUCTION_FIDELITY_NAVIGATION_SCHEMA) {
    throw new Error("navigation policy schema changed");
  }
  if (typeof value.gameKey !== "string" || !GAME_KEY_PATTERN.test(value.gameKey)) {
    throw new Error("navigation policy gameKey must be lowercase kebab-case");
  }
  if (expectedGameKey !== null && value.gameKey !== expectedGameKey) {
    throw new Error("navigation policy gameKey changed");
  }
  if (value.algorithm !== PRODUCTION_FIDELITY_NAVIGATION_ALGORITHM) {
    throw new Error("navigation policy algorithm changed");
  }
  if (value.cycleOrigin !== "durable-first-frame-canonical-scheduler-cycle") {
    throw new Error("navigation policy cycle origin changed");
  }
  if (value.controllerEncoding !== "gamecube-packed-controller-v1") {
    throw new Error("navigation policy controller encoding changed");
  }
  if (
    value.targetAnchor !== "prior-si-observed-cycle"
    || value.receiptSource !== "periodic"
    || value.periodicSiCycles !== PRODUCTION_FIDELITY_SI_FIELD_CYCLES
    || value.maximumReceiptLatencyCycles
      !== PRODUCTION_FIDELITY_MAXIMUM_SI_RECEIPT_LATENCY_CYCLES
  ) {
    throw new Error("navigation policy SI receipt authority changed");
  }
  if (value.maximumPublications !== PRODUCTION_FIDELITY_NAVIGATION_PUBLICATION_CAP) {
    throw new Error("navigation policy publication cap changed");
  }
  if (typeof value.scriptSha256 !== "string" || !SHA256_PATTERN.test(value.scriptSha256)) {
    throw new Error("navigation policy scriptSha256 must be a lowercase SHA-256 digest");
  }
  const steps = normalizedSteps(value.steps, "navigation policy steps");
  if (value.scriptSha256 !== navigationScriptSha256(steps)) {
    throw new Error("navigation policy script SHA-256 changed");
  }
  return Object.freeze({
    schema: value.schema,
    gameKey: value.gameKey,
    algorithm: value.algorithm,
    cycleOrigin: value.cycleOrigin,
    controllerEncoding: value.controllerEncoding,
    targetAnchor: value.targetAnchor,
    receiptSource: value.receiptSource,
    periodicSiCycles: value.periodicSiCycles,
    maximumReceiptLatencyCycles: value.maximumReceiptLatencyCycles,
    maximumPublications: value.maximumPublications,
    scriptSha256: value.scriptSha256,
    steps,
  });
}

export function productionFidelityNavigationPolicy(gameKey) {
  if (!Object.hasOwn(PRODUCTION_FIDELITY_NAVIGATION_STEPS, gameKey)) {
    throw new Error(`production navigation has no authenticated title ${String(gameKey)}`);
  }
  return fidelityNavigationPolicyFromSteps(
    gameKey,
    PRODUCTION_FIDELITY_NAVIGATION_STEPS[gameKey],
  );
}
