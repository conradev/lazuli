// SPDX-License-Identifier: GPL-3.0-only

import {
  GameFirstPlayableTranscriptError,
} from "./browser_game_first_playable_transcript_core.mjs";

export const ROGUE_LEADER_FIRST_PLAYABLE_GAME_KEY = "rogue-leader-usa";

const HEADER = 0x80000000;
const PLAYER_MANAGER = 0x7fdefe14;
const SIMULATION_MANAGER_POINTER = 0x80095dc8;
const PAD0 = 0x7fdee6e8;
const NORMALIZED_PAD0 = 0x7fdee718;
const GLOBAL_AXES = 0x7fde97e0;
const LEVEL_INDEX = 0x7fde822c;
const SUBLEVEL_INDEX = 0x7fde8230;
const CRAFT_CONTROL = 0x7fdf0fa4;
const XWING_PRIMARY_VTABLE = 0x7fdc75b8;
const XWING_INTERFACE_VTABLE = 0x7fdc760c;
const RESPONSE_EPSILON = 0.0001;
const FLOAT_EPSILON = 0.000001;
const HEX_U32_PATTERN = /^0x[0-9a-f]{8}$/;

const GUEST_FIELDS = Object.freeze([
  "identity",
  "level",
  "playerManager",
  "simulation",
  "input",
  "craft",
  "controlsEnabled",
  "liveXwingControlPath",
  "normalCraftState",
  "normalStateTransformValid",
  "hostLeftCorrelated",
  "receiptLifetimeMatches",
  "activeFlight",
  "guestConsumedHostLeft",
  "neutralControlBaseline",
  "lastActiveGameplayInput",
]);
const IDENTITY_FIELDS = Object.freeze([
  "headerAddress",
  "gameCode",
  "makerCode",
  "discNumber",
  "revision",
  "exact",
]);
const LEVEL_FIELDS = Object.freeze([
  "indexAddress",
  "index",
  "sublevelIndexAddress",
  "sublevelIndex",
]);
const PLAYER_MANAGER_FIELDS = Object.freeze([
  "address",
  "mapped",
  "activeCraftPointerAddress",
  "activeCraft",
  "activeCraftHandleAddress",
  "activeCraftHandle",
  "selectedCraftTypeAddress",
  "selectedCraftType",
  "stateAddress",
  "state",
]);
const SIMULATION_FIELDS = Object.freeze([
  "pointerAddress",
  "manager",
  "auxiliaryEnabledAddress",
  "auxiliaryEnabled",
  "auxiliaryModeAddress",
  "auxiliaryMode",
  "auxiliaryControlMode",
]);
const INPUT_FIELDS = Object.freeze([
  "port",
  "padAddress",
  "padMapped",
  "buttons",
  "rawStickXAddress",
  "rawStickX",
  "rawStickYAddress",
  "rawStickY",
  "errorAddress",
  "error",
  "normalizedStickXAddress",
  "normalizedStickX",
  "expectedNormalizedStickX",
  "normalizedStickYAddress",
  "normalizedStickY",
  "expectedNormalizedStickY",
  "globalStickXAddress",
  "globalStickX",
  "globalStickYAddress",
  "globalStickY",
  "valuesValid",
  "rawNormalizationCoherent",
  "globalAxesCoherent",
  "shapedControlCoherent",
  "pipelineCoherent",
  "neutral",
  "hostLeftRetained",
]);
const CRAFT_FIELDS = Object.freeze([
  "address",
  "mapped",
  "identity",
  "stateAddress",
  "state",
  "configPointerAddress",
  "config",
  "controlPointerAddress",
  "control",
  "exactControl",
  "controlInput",
  "transform",
  "response",
  "valid",
]);
const CRAFT_IDENTITY_FIELDS = Object.freeze([
  "primaryVtableAddress",
  "primaryVtable",
  "interfaceVtableAddress",
  "interfaceVtable",
  "type",
  "exact",
]);
const CONTROL_INPUT_FIELDS = Object.freeze([
  "stickXIndexAddress",
  "stickXIndex",
  "stickXAddress",
  "stickX",
  "stickYIndexAddress",
  "stickYIndex",
  "stickYAddress",
  "stickY",
  "exactMapping",
  "valid",
  "neutral",
  "hostLeftRetained",
]);
const TRANSFORM_FIELDS = Object.freeze([
  "orientation0Address",
  "orientation0",
  "orientation1Address",
  "orientation1",
  "orientation2Address",
  "orientation2",
  "positionAddress",
  "position",
  "velocityAddress",
  "velocity",
  "finite",
  "orthonormal",
  "determinant",
  "rightHanded",
]);
const RESPONSE_FIELDS = Object.freeze([
  "field45cAddress",
  "field45c",
  "field460Address",
  "field460",
  "field464Address",
  "field464",
  "finite",
  "xActive",
]);
const VECTOR_FIELDS = Object.freeze(["x", "y", "z"]);
const BASELINE_FIELDS = Object.freeze([
  "cycle",
  "controllerAppliedSequence",
  "level",
  "craft",
  "response",
]);
const BASELINE_CRAFT_FIELDS = Object.freeze([
  "address",
  "handle",
  "config",
  "control",
  "primaryVtable",
  "interfaceVtable",
  "state",
]);
const VALUE_RESPONSE_FIELDS = Object.freeze([
  "field45c",
  "field460",
  "field464",
]);
const RECEIPT_FIELDS = Object.freeze([
  "cycle",
  "controllerAppliedSequence",
  "hostPublication",
  "level",
  "playerManager",
  "craft",
  "transform",
  "simulation",
  "input",
  "response",
  "neutralBaseline",
  "responseTransition",
]);
const RECEIPT_CRAFT_FIELDS = Object.freeze([
  "address",
  "handle",
  "config",
  "control",
  "primaryVtable",
  "interfaceVtable",
  "type",
  "state",
]);
const RECEIPT_TRANSFORM_FIELDS = Object.freeze([
  "orientation0",
  "orientation1",
  "orientation2",
  "position",
  "velocity",
]);
const RECEIPT_SIMULATION_FIELDS = Object.freeze([
  "manager",
  "auxiliaryEnabled",
  "auxiliaryMode",
]);
const RECEIPT_INPUT_FIELDS = Object.freeze([
  "port",
  "buttons",
  "rawStickX",
  "rawStickY",
  "normalizedStickX",
  "normalizedStickY",
  "globalStickX",
  "globalStickY",
  "stickX",
  "stickY",
]);
const RECEIPT_BASELINE_FIELDS = Object.freeze([
  "cycle",
  "controllerAppliedSequence",
  "response",
]);
const RESPONSE_TRANSITION_FIELDS = Object.freeze([
  "field460Delta",
  "field464Delta",
  "xChanged",
]);
const PUBLICATION_FIELDS = Object.freeze([
  "source",
  "pollIndex",
  "scheduledCycle",
  "observedCycle",
  "buttons",
  "sequence",
]);

function fail(path, message) {
  throw new GameFirstPlayableTranscriptError(path, message);
}

function requireObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function requireExactKeys(value, fields, path) {
  requireObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    fail(
      `${path}.[keys]`,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  return value;
}

function requireExact(value, expected, path) {
  if (value !== expected) {
    fail(
      path,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a non-negative safe integer");
  }
  return value;
}

function requirePositiveInteger(value, path) {
  const integer = requireNonNegativeInteger(value, path);
  if (integer === 0) fail(path, "expected a positive integer");
  return integer;
}

function requireUnsigned(value, maximum, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(path, `expected an unsigned integer no greater than ${maximum}`);
  }
  return value;
}

function requireU8(value, path) {
  return requireUnsigned(value, 0xff, path);
}

function requireS8(value, path) {
  if (!Number.isSafeInteger(value) || value < -0x80 || value > 0x7f) {
    fail(path, "expected a signed 8-bit integer");
  }
  return value;
}

function requireU16(value, path) {
  return requireUnsigned(value, 0xffff, path);
}

function requireU32(value, path) {
  return requireUnsigned(value, 0xffffffff, path);
}

function requireS32(value, path) {
  if (
    !Number.isSafeInteger(value)
    || value < -0x80000000
    || value > 0x7fffffff
  ) {
    fail(path, "expected a signed 32-bit integer");
  }
  return value;
}

function requireFinite(value, path) {
  if (!Number.isFinite(value)) fail(path, "expected a finite number");
  return value;
}

function requireRange(value, minimum, maximum, path) {
  const number = requireFinite(value, path);
  if (number < minimum || number > maximum) {
    fail(path, `expected a value from ${minimum} through ${maximum}`);
  }
  return number;
}

function requireHexU32(value, path) {
  if (typeof value !== "string" || !HEX_U32_PATTERN.test(value)) {
    fail(path, "expected a lowercase eight-digit hexadecimal u32");
  }
  return Number.parseInt(value.slice(2), 16);
}

function requireEffectiveAddress(value, path, alignment = 4) {
  const address = requireHexU32(value, path);
  if (
    address === 0
    || !Number.isSafeInteger(alignment)
    || alignment <= 0
    || (alignment & (alignment - 1)) !== 0
    || (address & (alignment - 1)) !== 0
  ) {
    fail(path, `expected a nonzero ${alignment}-byte-aligned effective address`);
  }
  return address;
}

function hexU32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function requireAddress(value, expected, path) {
  requireExact(value, hexU32(expected), path);
  return expected;
}

function requireRelativeAddress(value, base, offset, path) {
  if (base > 0xffffffff - offset) {
    fail(path, "base effective address overflows the relative field");
  }
  return requireAddress(value, base + offset, path);
}

function requireApproximatelyEqual(
  value,
  expected,
  path,
  tolerance = FLOAT_EPSILON,
) {
  if (
    !Number.isFinite(value)
    || !Number.isFinite(expected)
    || Math.abs(value - expected) > tolerance
  ) {
    fail(path, `expected ${expected} within ${tolerance}, got ${value}`);
  }
  return value;
}

function requireVector(value, path) {
  const vector = requireExactKeys(value, VECTOR_FIELDS, path);
  return Object.freeze({
    x: requireFinite(vector.x, `${path}.x`),
    y: requireFinite(vector.y, `${path}.y`),
    z: requireFinite(vector.z, `${path}.z`),
  });
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function determinant(orientation0, orientation1, orientation2) {
  return orientation0.x * (
    orientation1.y * orientation2.z
    - orientation1.z * orientation2.y
  ) - orientation0.y * (
    orientation1.x * orientation2.z
    - orientation1.z * orientation2.x
  ) + orientation0.z * (
    orientation1.x * orientation2.y
    - orientation1.y * orientation2.x
  );
}

function requireOrthonormal(
  orientation0,
  orientation1,
  orientation2,
  path,
) {
  const vectors = [orientation0, orientation1, orientation2];
  for (let index = 0; index < vectors.length; index += 1) {
    if (Math.abs(dot(vectors[index], vectors[index]) - 1) > 0.02) {
      fail(path, "expected approximately unit orientation vectors");
    }
  }
  for (const [left, right] of [[0, 1], [0, 2], [1, 2]]) {
    if (Math.abs(dot(vectors[left], vectors[right])) > 0.02) {
      fail(path, "expected approximately perpendicular orientation vectors");
    }
  }
}

function requireRightHanded(
  orientation0,
  orientation1,
  orientation2,
  path,
) {
  const value = determinant(orientation0, orientation1, orientation2);
  if (!Number.isFinite(value) || value <= 0) {
    fail(path, "expected a right-handed orientation basis");
  }
  return value;
}

function finitePadAxis(value) {
  const minimum = Math.fround(-128 / 72) - FLOAT_EPSILON;
  const maximum = Math.fround(128 / 72) + FLOAT_EPSILON;
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function finiteShapedAxis(value) {
  return Number.isFinite(value) && value >= -1.001 && value <= 1.001;
}

function shapedAxisDirectionCoherent(source, shaped) {
  if (!finitePadAxis(source) || !finiteShapedAxis(shaped)) return false;
  if (Math.abs(source) <= 0.02) return Math.abs(shaped) <= 0.125;
  return Math.sign(source) === Math.sign(shaped);
}

function projectLevel(value, path) {
  const level = requireExactKeys(value, LEVEL_FIELDS, path);
  requireAddress(level.indexAddress, LEVEL_INDEX, `${path}.indexAddress`);
  const index = requireS32(level.index, `${path}.index`);
  requireAddress(
    level.sublevelIndexAddress,
    SUBLEVEL_INDEX,
    `${path}.sublevelIndexAddress`,
  );
  const sublevelIndex = requireS32(
    level.sublevelIndex,
    `${path}.sublevelIndex`,
  );
  return Object.freeze({ index, sublevelIndex });
}

function projectPlayerManager(value, path) {
  const manager = requireExactKeys(value, PLAYER_MANAGER_FIELDS, path);
  requireAddress(manager.address, PLAYER_MANAGER, `${path}.address`);
  requireExact(manager.mapped, true, `${path}.mapped`);
  requireAddress(
    manager.activeCraftPointerAddress,
    PLAYER_MANAGER,
    `${path}.activeCraftPointerAddress`,
  );
  const activeCraft = requireEffectiveAddress(
    manager.activeCraft,
    `${path}.activeCraft`,
  );
  requireAddress(
    manager.activeCraftHandleAddress,
    PLAYER_MANAGER + 4,
    `${path}.activeCraftHandleAddress`,
  );
  const activeCraftHandle = requireS32(
    manager.activeCraftHandle,
    `${path}.activeCraftHandle`,
  );
  requireAddress(
    manager.selectedCraftTypeAddress,
    PLAYER_MANAGER + 8,
    `${path}.selectedCraftTypeAddress`,
  );
  requireExact(
    requireS32(manager.selectedCraftType, `${path}.selectedCraftType`),
    0,
    `${path}.selectedCraftType`,
  );
  requireAddress(
    manager.stateAddress,
    PLAYER_MANAGER + 0x0c,
    `${path}.stateAddress`,
  );
  const state = requireS32(manager.state, `${path}.state`);
  return Object.freeze({ activeCraft, activeCraftHandle, state });
}

function projectSimulation(value, path) {
  const simulation = requireExactKeys(value, SIMULATION_FIELDS, path);
  requireAddress(
    simulation.pointerAddress,
    SIMULATION_MANAGER_POINTER,
    `${path}.pointerAddress`,
  );
  if (simulation.manager === null) {
    requireExact(
      simulation.auxiliaryEnabledAddress,
      null,
      `${path}.auxiliaryEnabledAddress`,
    );
    requireExact(
      simulation.auxiliaryEnabled,
      null,
      `${path}.auxiliaryEnabled`,
    );
    requireExact(
      simulation.auxiliaryModeAddress,
      null,
      `${path}.auxiliaryModeAddress`,
    );
    requireExact(simulation.auxiliaryMode, null, `${path}.auxiliaryMode`);
    requireExact(
      simulation.auxiliaryControlMode,
      false,
      `${path}.auxiliaryControlMode`,
    );
    return Object.freeze({
      manager: null,
      auxiliaryEnabled: null,
      auxiliaryMode: null,
    });
  }

  const manager = requireEffectiveAddress(
    simulation.manager,
    `${path}.manager`,
  );
  requireRelativeAddress(
    simulation.auxiliaryEnabledAddress,
    manager,
    0xe04,
    `${path}.auxiliaryEnabledAddress`,
  );
  const auxiliaryEnabled = requireU8(
    simulation.auxiliaryEnabled,
    `${path}.auxiliaryEnabled`,
  );
  requireRelativeAddress(
    simulation.auxiliaryModeAddress,
    manager,
    0xa7c,
    `${path}.auxiliaryModeAddress`,
  );
  const auxiliaryMode = requireS32(
    simulation.auxiliaryMode,
    `${path}.auxiliaryMode`,
  );
  requireExact(
    simulation.auxiliaryControlMode,
    auxiliaryEnabled !== 0 && auxiliaryMode === 1,
    `${path}.auxiliaryControlMode`,
  );
  return Object.freeze({ manager, auxiliaryEnabled, auxiliaryMode });
}

function projectCurrentInput(value, path, requireNeutral) {
  const input = requireExactKeys(value, INPUT_FIELDS, path);
  requireExact(requireU8(input.port, `${path}.port`), 0, `${path}.port`);
  requireAddress(input.padAddress, PAD0, `${path}.padAddress`);
  requireExact(input.padMapped, true, `${path}.padMapped`);
  const buttons = requireU16(input.buttons, `${path}.buttons`);
  requireAddress(
    input.rawStickXAddress,
    PAD0 + 2,
    `${path}.rawStickXAddress`,
  );
  const rawStickX = requireS8(input.rawStickX, `${path}.rawStickX`);
  requireAddress(
    input.rawStickYAddress,
    PAD0 + 3,
    `${path}.rawStickYAddress`,
  );
  const rawStickY = requireS8(input.rawStickY, `${path}.rawStickY`);
  requireAddress(input.errorAddress, PAD0 + 0x0a, `${path}.errorAddress`);
  requireExact(requireS8(input.error, `${path}.error`), 0, `${path}.error`);

  requireAddress(
    input.normalizedStickXAddress,
    NORMALIZED_PAD0,
    `${path}.normalizedStickXAddress`,
  );
  const normalizedStickX = requireFinite(
    input.normalizedStickX,
    `${path}.normalizedStickX`,
  );
  const expectedNormalizedStickX = requireFinite(
    input.expectedNormalizedStickX,
    `${path}.expectedNormalizedStickX`,
  );
  const recomputedNormalizedStickX = Math.fround(rawStickX / 72);
  requireApproximatelyEqual(
    expectedNormalizedStickX,
    recomputedNormalizedStickX,
    `${path}.expectedNormalizedStickX`,
  );
  requireApproximatelyEqual(
    normalizedStickX,
    recomputedNormalizedStickX,
    `${path}.normalizedStickX`,
  );
  requireAddress(
    input.normalizedStickYAddress,
    NORMALIZED_PAD0 + 4,
    `${path}.normalizedStickYAddress`,
  );
  const normalizedStickY = requireFinite(
    input.normalizedStickY,
    `${path}.normalizedStickY`,
  );
  const expectedNormalizedStickY = requireFinite(
    input.expectedNormalizedStickY,
    `${path}.expectedNormalizedStickY`,
  );
  const recomputedNormalizedStickY = Math.fround(rawStickY / 72);
  requireApproximatelyEqual(
    expectedNormalizedStickY,
    recomputedNormalizedStickY,
    `${path}.expectedNormalizedStickY`,
  );
  requireApproximatelyEqual(
    normalizedStickY,
    recomputedNormalizedStickY,
    `${path}.normalizedStickY`,
  );
  requireAddress(
    input.globalStickXAddress,
    GLOBAL_AXES,
    `${path}.globalStickXAddress`,
  );
  const globalStickX = requireFinite(
    input.globalStickX,
    `${path}.globalStickX`,
  );
  requireAddress(
    input.globalStickYAddress,
    GLOBAL_AXES + 4,
    `${path}.globalStickYAddress`,
  );
  const globalStickY = requireFinite(
    input.globalStickY,
    `${path}.globalStickY`,
  );

  const valuesValid = finitePadAxis(normalizedStickX)
    && finitePadAxis(normalizedStickY)
    && finitePadAxis(globalStickX)
    && finitePadAxis(globalStickY);
  const rawNormalizationCoherent = valuesValid
    && Math.abs(normalizedStickX - recomputedNormalizedStickX)
      <= FLOAT_EPSILON
    && Math.abs(normalizedStickY - recomputedNormalizedStickY)
      <= FLOAT_EPSILON;
  const globalAxesCoherent = rawNormalizationCoherent
    && Math.abs(normalizedStickX - globalStickX) <= FLOAT_EPSILON
    && Math.abs(normalizedStickY + globalStickY) <= FLOAT_EPSILON;
  requireExact(input.valuesValid, valuesValid, `${path}.valuesValid`);
  requireExact(
    input.rawNormalizationCoherent,
    rawNormalizationCoherent,
    `${path}.rawNormalizationCoherent`,
  );
  requireExact(
    input.globalAxesCoherent,
    globalAxesCoherent,
    `${path}.globalAxesCoherent`,
  );

  return Object.freeze({
    buttons,
    rawStickX,
    rawStickY,
    normalizedStickX,
    normalizedStickY,
    globalStickX,
    globalStickY,
    globalAxesCoherent,
    declaredShapedControlCoherent: input.shapedControlCoherent,
    declaredPipelineCoherent: input.pipelineCoherent,
    declaredNeutral: input.neutral,
    declaredHostLeftRetained: input.hostLeftRetained,
    requireNeutral,
  });
}

function projectCraft(value, path, activeCraft, currentInput) {
  const craft = requireExactKeys(value, CRAFT_FIELDS, path);
  requireExact(
    requireEffectiveAddress(craft.address, `${path}.address`),
    activeCraft,
    `${path}.address`,
  );
  requireExact(craft.mapped, true, `${path}.mapped`);

  const identityPath = `${path}.identity`;
  const identity = requireExactKeys(
    craft.identity,
    CRAFT_IDENTITY_FIELDS,
    identityPath,
  );
  requireRelativeAddress(
    identity.primaryVtableAddress,
    activeCraft,
    0x80,
    `${identityPath}.primaryVtableAddress`,
  );
  requireAddress(
    identity.primaryVtable,
    XWING_PRIMARY_VTABLE,
    `${identityPath}.primaryVtable`,
  );
  requireRelativeAddress(
    identity.interfaceVtableAddress,
    activeCraft,
    0x1a0,
    `${identityPath}.interfaceVtableAddress`,
  );
  requireAddress(
    identity.interfaceVtable,
    XWING_INTERFACE_VTABLE,
    `${identityPath}.interfaceVtable`,
  );
  requireExact(identity.type, "x-wing", `${identityPath}.type`);
  requireExact(identity.exact, true, `${identityPath}.exact`);

  requireRelativeAddress(
    craft.stateAddress,
    activeCraft,
    0x370,
    `${path}.stateAddress`,
  );
  const state = requireS32(craft.state, `${path}.state`);
  requireRelativeAddress(
    craft.configPointerAddress,
    activeCraft,
    0x37c,
    `${path}.configPointerAddress`,
  );
  const config = requireEffectiveAddress(craft.config, `${path}.config`);
  requireRelativeAddress(
    craft.controlPointerAddress,
    activeCraft,
    0x380,
    `${path}.controlPointerAddress`,
  );
  requireAddress(craft.control, CRAFT_CONTROL, `${path}.control`);
  requireExact(craft.exactControl, true, `${path}.exactControl`);

  const controlPath = `${path}.controlInput`;
  const control = requireExactKeys(
    craft.controlInput,
    CONTROL_INPUT_FIELDS,
    controlPath,
  );
  requireAddress(
    control.stickXIndexAddress,
    CRAFT_CONTROL + 0x110,
    `${controlPath}.stickXIndexAddress`,
  );
  requireExact(
    requireU32(control.stickXIndex, `${controlPath}.stickXIndex`),
    0,
    `${controlPath}.stickXIndex`,
  );
  requireAddress(
    control.stickXAddress,
    CRAFT_CONTROL + 8,
    `${controlPath}.stickXAddress`,
  );
  const stickX = requireRange(
    control.stickX,
    -1.001,
    1.001,
    `${controlPath}.stickX`,
  );
  requireAddress(
    control.stickYIndexAddress,
    CRAFT_CONTROL + 0x10c,
    `${controlPath}.stickYIndexAddress`,
  );
  requireExact(
    requireU32(control.stickYIndex, `${controlPath}.stickYIndex`),
    1,
    `${controlPath}.stickYIndex`,
  );
  requireAddress(
    control.stickYAddress,
    CRAFT_CONTROL + 0x0c,
    `${controlPath}.stickYAddress`,
  );
  const stickY = requireRange(
    control.stickY,
    -1.001,
    1.001,
    `${controlPath}.stickY`,
  );
  const exactMapping = true;
  const controlValid = finiteShapedAxis(stickX) && finiteShapedAxis(stickY);
  const controlNeutral = controlValid
    && Math.abs(stickX) <= 0.125
    && Math.abs(stickY) <= 0.125;
  const controlHostLeft = controlValid
    && stickX >= -1.001
    && stickX <= -0.5
    && Math.abs(stickY) <= 0.125;
  requireExact(control.exactMapping, exactMapping, `${controlPath}.exactMapping`);
  requireExact(control.valid, controlValid, `${controlPath}.valid`);
  requireExact(control.neutral, controlNeutral, `${controlPath}.neutral`);
  requireExact(
    control.hostLeftRetained,
    controlHostLeft,
    `${controlPath}.hostLeftRetained`,
  );

  const shapedControlCoherent = currentInput.globalAxesCoherent
    && shapedAxisDirectionCoherent(currentInput.globalStickX, stickX)
    && shapedAxisDirectionCoherent(currentInput.globalStickY, stickY);
  const pipelineCoherent = shapedControlCoherent;
  const inputNeutral = pipelineCoherent
    && Math.abs(currentInput.rawStickX) <= 16
    && Math.abs(currentInput.rawStickY) <= 16
    && Math.abs(stickX) <= 0.125
    && Math.abs(stickY) <= 0.125;
  const inputHostLeft = pipelineCoherent
    && currentInput.rawStickX >= -128
    && currentInput.rawStickX <= -36
    && Math.abs(currentInput.rawStickY) <= 16
    && currentInput.normalizedStickX <= -0.5
    && currentInput.globalStickX <= -0.5
    && controlHostLeft
    && Math.abs(stickY) <= 0.125;
  requireExact(
    currentInput.declaredShapedControlCoherent,
    shapedControlCoherent,
    `${path.slice(0, -6)}.input.shapedControlCoherent`,
  );
  requireExact(
    currentInput.declaredPipelineCoherent,
    pipelineCoherent,
    `${path.slice(0, -6)}.input.pipelineCoherent`,
  );
  requireExact(
    currentInput.declaredNeutral,
    inputNeutral,
    `${path.slice(0, -6)}.input.neutral`,
  );
  requireExact(
    currentInput.declaredHostLeftRetained,
    inputHostLeft,
    `${path.slice(0, -6)}.input.hostLeftRetained`,
  );
  if (currentInput.requireNeutral) {
    requireExact(inputNeutral, true, `${path.slice(0, -6)}.input.neutral`);
    requireExact(controlNeutral, true, `${controlPath}.neutral`);
    requireExact(currentInput.buttons, 0, `${path.slice(0, -6)}.input.buttons`);
  }

  const transformPath = `${path}.transform`;
  const transform = requireExactKeys(
    craft.transform,
    TRANSFORM_FIELDS,
    transformPath,
  );
  requireRelativeAddress(
    transform.orientation0Address,
    activeCraft,
    0x84,
    `${transformPath}.orientation0Address`,
  );
  const orientation0 = requireVector(
    transform.orientation0,
    `${transformPath}.orientation0`,
  );
  requireRelativeAddress(
    transform.orientation1Address,
    activeCraft,
    0x90,
    `${transformPath}.orientation1Address`,
  );
  const orientation1 = requireVector(
    transform.orientation1,
    `${transformPath}.orientation1`,
  );
  requireRelativeAddress(
    transform.orientation2Address,
    activeCraft,
    0x9c,
    `${transformPath}.orientation2Address`,
  );
  const orientation2 = requireVector(
    transform.orientation2,
    `${transformPath}.orientation2`,
  );
  requireRelativeAddress(
    transform.positionAddress,
    activeCraft,
    0xa8,
    `${transformPath}.positionAddress`,
  );
  const position = requireVector(
    transform.position,
    `${transformPath}.position`,
  );
  requireRelativeAddress(
    transform.velocityAddress,
    activeCraft,
    0xb4,
    `${transformPath}.velocityAddress`,
  );
  const velocity = requireVector(
    transform.velocity,
    `${transformPath}.velocity`,
  );
  requireOrthonormal(
    orientation0,
    orientation1,
    orientation2,
    `${transformPath}.orthonormal`,
  );
  const orientationDeterminant = requireRightHanded(
    orientation0,
    orientation1,
    orientation2,
    `${transformPath}.rightHanded`,
  );
  requireExact(transform.finite, true, `${transformPath}.finite`);
  requireExact(transform.orthonormal, true, `${transformPath}.orthonormal`);
  requireApproximatelyEqual(
    transform.determinant,
    orientationDeterminant,
    `${transformPath}.determinant`,
  );
  requireExact(
    transform.rightHanded,
    true,
    `${transformPath}.rightHanded`,
  );

  const responsePath = `${path}.response`;
  const response = requireExactKeys(
    craft.response,
    RESPONSE_FIELDS,
    responsePath,
  );
  requireRelativeAddress(
    response.field45cAddress,
    activeCraft,
    0x45c,
    `${responsePath}.field45cAddress`,
  );
  const field45c = requireFinite(
    response.field45c,
    `${responsePath}.field45c`,
  );
  requireRelativeAddress(
    response.field460Address,
    activeCraft,
    0x460,
    `${responsePath}.field460Address`,
  );
  const field460 = requireFinite(
    response.field460,
    `${responsePath}.field460`,
  );
  requireRelativeAddress(
    response.field464Address,
    activeCraft,
    0x464,
    `${responsePath}.field464Address`,
  );
  const field464 = requireFinite(
    response.field464,
    `${responsePath}.field464`,
  );
  const xActive = Math.abs(field460) > RESPONSE_EPSILON
    || Math.abs(field464) > RESPONSE_EPSILON;
  requireExact(response.finite, true, `${responsePath}.finite`);
  requireExact(response.xActive, xActive, `${responsePath}.xActive`);
  requireExact(craft.valid, true, `${path}.valid`);

  return Object.freeze({
    address: activeCraft,
    config,
    state,
    control: CRAFT_CONTROL,
    primaryVtable: XWING_PRIMARY_VTABLE,
    interfaceVtable: XWING_INTERFACE_VTABLE,
    stickX,
    stickY,
    controlNeutral,
    controlHostLeft,
    pipelineCoherent,
    inputNeutral,
    inputHostLeft,
    transform: Object.freeze({
      orientation0,
      orientation1,
      orientation2,
      position,
      velocity,
    }),
    response: Object.freeze({ field45c, field460, field464 }),
  });
}

function projectRogueLeaderState(report, path, requireNeutral) {
  const guestPath = `${path}.guestGame`;
  const guest = requireExactKeys(report.guestGame, GUEST_FIELDS, guestPath);

  const identityPath = `${guestPath}.identity`;
  const identity = requireExactKeys(
    guest.identity,
    IDENTITY_FIELDS,
    identityPath,
  );
  requireAddress(identity.headerAddress, HEADER, `${identityPath}.headerAddress`);
  requireExact(identity.gameCode, "0x47535745", `${identityPath}.gameCode`);
  requireExact(identity.makerCode, 0x3634, `${identityPath}.makerCode`);
  requireExact(identity.discNumber, 0, `${identityPath}.discNumber`);
  requireExact(identity.revision, 0, `${identityPath}.revision`);
  requireExact(identity.exact, true, `${identityPath}.exact`);

  const level = projectLevel(guest.level, `${guestPath}.level`);
  const playerManager = projectPlayerManager(
    guest.playerManager,
    `${guestPath}.playerManager`,
  );
  const simulation = projectSimulation(
    guest.simulation,
    `${guestPath}.simulation`,
  );
  const input = projectCurrentInput(
    guest.input,
    `${guestPath}.input`,
    requireNeutral,
  );
  const craft = projectCraft(
    guest.craft,
    `${guestPath}.craft`,
    playerManager.activeCraft,
    input,
  );

  const controlsEnabled = craft.pipelineCoherent;
  const liveXwingControlPath = controlsEnabled;
  const normalCraftState = liveXwingControlPath && craft.state === 0;
  const normalStateTransformValid = normalCraftState;
  const hostLeftCorrelated = normalStateTransformValid
    && craft.inputHostLeft
    && craft.controlHostLeft
    && (
      Math.abs(craft.response.field460) > RESPONSE_EPSILON
      || Math.abs(craft.response.field464) > RESPONSE_EPSILON
    );
  requireExact(
    guest.controlsEnabled,
    controlsEnabled,
    `${guestPath}.controlsEnabled`,
  );
  requireExact(
    guest.liveXwingControlPath,
    liveXwingControlPath,
    `${guestPath}.liveXwingControlPath`,
  );
  requireExact(
    guest.normalCraftState,
    normalCraftState,
    `${guestPath}.normalCraftState`,
  );
  requireExact(
    guest.normalStateTransformValid,
    normalStateTransformValid,
    `${guestPath}.normalStateTransformValid`,
  );
  requireExact(
    guest.hostLeftCorrelated,
    hostLeftCorrelated,
    `${guestPath}.hostLeftCorrelated`,
  );
  requireExact(
    normalStateTransformValid,
    true,
    `${guestPath}.normalStateTransformValid`,
  );

  return Object.freeze({
    guest,
    level,
    playerManager,
    simulation,
    input,
    craft,
  });
}

function requireSameLifetime(candidate, state, path) {
  requireExact(candidate.level.index, state.level.index, `${path}.level.index`);
  requireExact(
    candidate.level.sublevelIndex,
    state.level.sublevelIndex,
    `${path}.level.sublevelIndex`,
  );
  requireExact(
    candidate.craft.address,
    state.craft.address,
    `${path}.craft.address`,
  );
  requireExact(
    candidate.craft.handle,
    state.playerManager.activeCraftHandle,
    `${path}.craft.handle`,
  );
  requireExact(
    candidate.craft.config,
    state.craft.config,
    `${path}.craft.config`,
  );
  requireExact(
    candidate.craft.control,
    state.craft.control,
    `${path}.craft.control`,
  );
  requireExact(
    candidate.craft.primaryVtable,
    state.craft.primaryVtable,
    `${path}.craft.primaryVtable`,
  );
  requireExact(
    candidate.craft.interfaceVtable,
    state.craft.interfaceVtable,
    `${path}.craft.interfaceVtable`,
  );
}

function projectValueResponse(value, path) {
  const response = requireExactKeys(value, VALUE_RESPONSE_FIELDS, path);
  return Object.freeze({
    field45c: requireFinite(response.field45c, `${path}.field45c`),
    field460: requireFinite(response.field460, `${path}.field460`),
    field464: requireFinite(response.field464, `${path}.field464`),
  });
}

function projectBaseline(value, path, state) {
  const baseline = requireExactKeys(value, BASELINE_FIELDS, path);
  const cycle = requireNonNegativeInteger(baseline.cycle, `${path}.cycle`);
  const controllerAppliedSequence = requireNonNegativeInteger(
    baseline.controllerAppliedSequence,
    `${path}.controllerAppliedSequence`,
  );
  const level = requireExactKeys(baseline.level, ["index", "sublevelIndex"], `${path}.level`);
  const craft = requireExactKeys(
    baseline.craft,
    BASELINE_CRAFT_FIELDS,
    `${path}.craft`,
  );
  const projected = {
    level: {
      index: requireS32(level.index, `${path}.level.index`),
      sublevelIndex: requireS32(
        level.sublevelIndex,
        `${path}.level.sublevelIndex`,
      ),
    },
    craft: {
      address: requireEffectiveAddress(
        craft.address,
        `${path}.craft.address`,
      ),
      handle: requireS32(craft.handle, `${path}.craft.handle`),
      config: requireEffectiveAddress(craft.config, `${path}.craft.config`),
      control: requireEffectiveAddress(craft.control, `${path}.craft.control`),
      primaryVtable: requireEffectiveAddress(
        craft.primaryVtable,
        `${path}.craft.primaryVtable`,
      ),
      interfaceVtable: requireEffectiveAddress(
        craft.interfaceVtable,
        `${path}.craft.interfaceVtable`,
      ),
      state: requireS32(craft.state, `${path}.craft.state`),
    },
  };
  requireExact(
    projected.craft.state,
    0,
    `${path}.craft.state`,
  );
  requireSameLifetime(projected, state, path);
  const response = projectValueResponse(
    baseline.response,
    `${path}.response`,
  );
  return Object.freeze({
    cycle,
    controllerAppliedSequence,
    level: Object.freeze(projected.level),
    craft: Object.freeze(projected.craft),
    response,
  });
}

function projectPublication(value, path, expected, cycle) {
  const publication = requireExactKeys(value, PUBLICATION_FIELDS, path);
  if (publication.source !== "periodic" && publication.source !== "direct") {
    fail(`${path}.source`, "expected periodic or direct");
  }
  const pollIndex = requirePositiveInteger(
    publication.pollIndex,
    `${path}.pollIndex`,
  );
  const scheduledCycle = requireNonNegativeInteger(
    publication.scheduledCycle,
    `${path}.scheduledCycle`,
  );
  const observedCycle = requireNonNegativeInteger(
    publication.observedCycle,
    `${path}.observedCycle`,
  );
  requireExact(
    requireU16(publication.buttons, `${path}.buttons`),
    0x0001,
    `${path}.buttons`,
  );
  const sequence = requirePositiveInteger(
    publication.sequence,
    `${path}.sequence`,
  );
  if (scheduledCycle > observedCycle || observedCycle > cycle) {
    fail(
      path,
      `expected scheduledCycle <= observedCycle <= receipt cycle ${cycle}`,
    );
  }
  for (const field of PUBLICATION_FIELDS) {
    requireExact(publication[field], expected[field], `${path}.${field}`);
  }
  return Object.freeze({
    source: publication.source,
    pollIndex,
    scheduledCycle,
    observedCycle,
    buttons: 0x0001,
    sequence,
  });
}

function projectReceiptTransform(value, path) {
  const transform = requireExactKeys(
    value,
    RECEIPT_TRANSFORM_FIELDS,
    path,
  );
  const orientation0 = requireVector(
    transform.orientation0,
    `${path}.orientation0`,
  );
  const orientation1 = requireVector(
    transform.orientation1,
    `${path}.orientation1`,
  );
  const orientation2 = requireVector(
    transform.orientation2,
    `${path}.orientation2`,
  );
  requireOrthonormal(
    orientation0,
    orientation1,
    orientation2,
    `${path}.orientation0`,
  );
  requireRightHanded(
    orientation0,
    orientation1,
    orientation2,
    `${path}.orientation2`,
  );
  return Object.freeze({
    orientation0,
    orientation1,
    orientation2,
    position: requireVector(transform.position, `${path}.position`),
    velocity: requireVector(transform.velocity, `${path}.velocity`),
  });
}

function projectReceiptInput(value, path) {
  const input = requireExactKeys(value, RECEIPT_INPUT_FIELDS, path);
  requireExact(requireU8(input.port, `${path}.port`), 0, `${path}.port`);
  // The retail receipt copies the contemporaneous PAD button word, but the
  // sampler's host-left proof is the stick pipeline below. Do not invent a
  // button-state condition that the retained receipt does not establish.
  const buttons = requireU16(input.buttons, `${path}.buttons`);
  const rawStickX = requireS8(input.rawStickX, `${path}.rawStickX`);
  const rawStickY = requireS8(input.rawStickY, `${path}.rawStickY`);
  const normalizedStickX = requireFinite(
    input.normalizedStickX,
    `${path}.normalizedStickX`,
  );
  const normalizedStickY = requireFinite(
    input.normalizedStickY,
    `${path}.normalizedStickY`,
  );
  const globalStickX = requireFinite(
    input.globalStickX,
    `${path}.globalStickX`,
  );
  const globalStickY = requireFinite(
    input.globalStickY,
    `${path}.globalStickY`,
  );
  const stickX = requireRange(input.stickX, -1.001, 1.001, `${path}.stickX`);
  const stickY = requireRange(input.stickY, -1.001, 1.001, `${path}.stickY`);
  requireApproximatelyEqual(
    normalizedStickX,
    Math.fround(rawStickX / 72),
    `${path}.normalizedStickX`,
  );
  requireApproximatelyEqual(
    normalizedStickY,
    Math.fround(rawStickY / 72),
    `${path}.normalizedStickY`,
  );
  requireApproximatelyEqual(
    globalStickX,
    normalizedStickX,
    `${path}.globalStickX`,
  );
  requireApproximatelyEqual(
    globalStickY,
    -normalizedStickY,
    `${path}.globalStickY`,
  );
  if (
    rawStickX < -128
    || rawStickX > -36
    || Math.abs(rawStickY) > 16
    || normalizedStickX > -0.5
    || globalStickX > -0.5
    || stickX < -1.001
    || stickX > -0.5
    || Math.abs(stickY) > 0.125
    || !shapedAxisDirectionCoherent(globalStickX, stickX)
    || !shapedAxisDirectionCoherent(globalStickY, stickY)
  ) {
    fail(path, "expected one coherent horizontal host-left input path");
  }
  return Object.freeze({
    port: 0,
    buttons,
    rawStickX,
    rawStickY,
    normalizedStickX,
    normalizedStickY,
    globalStickX,
    globalStickY,
    stickX,
    stickY,
  });
}

function projectReceipt({
  expectedPublication,
  postReport,
  preReport,
  retainedBaseline,
  state,
}) {
  const path = "$.postReport.guestGame.lastActiveGameplayInput";
  const receipt = requireExactKeys(
    state.guest.lastActiveGameplayInput,
    RECEIPT_FIELDS,
    path,
  );
  const cycle = requireNonNegativeInteger(receipt.cycle, `${path}.cycle`);
  if (cycle < preReport.cycles || cycle > postReport.cycles) {
    fail(
      `${path}.cycle`,
      `expected a value from ${preReport.cycles} through ${postReport.cycles}`,
    );
  }
  const hostPublication = projectPublication(
    receipt.hostPublication,
    `${path}.hostPublication`,
    expectedPublication,
    cycle,
  );
  if (hostPublication.scheduledCycle < preReport.cycles) {
    fail(
      `${path}.hostPublication.scheduledCycle`,
      `expected no earlier than pre-report cycle ${preReport.cycles}`,
    );
  }
  if (hostPublication.pollIndex <= preReport.controller.pollIndex) {
    fail(
      `${path}.hostPublication.pollIndex`,
      `expected a value greater than ${preReport.controller.pollIndex}`,
    );
  }
  if (hostPublication.sequence <= preReport.controller.appliedSequence) {
    fail(
      `${path}.hostPublication.sequence`,
      `expected a value greater than ${preReport.controller.appliedSequence}`,
    );
  }
  const controllerAppliedSequence = requirePositiveInteger(
    receipt.controllerAppliedSequence,
    `${path}.controllerAppliedSequence`,
  );
  requireExact(
    controllerAppliedSequence,
    hostPublication.sequence,
    `${path}.controllerAppliedSequence`,
  );

  const level = requireExactKeys(
    receipt.level,
    ["index", "sublevelIndex"],
    `${path}.level`,
  );
  const receiptCraft = requireExactKeys(
    receipt.craft,
    RECEIPT_CRAFT_FIELDS,
    `${path}.craft`,
  );
  const lifetime = {
    level: {
      index: requireS32(level.index, `${path}.level.index`),
      sublevelIndex: requireS32(
        level.sublevelIndex,
        `${path}.level.sublevelIndex`,
      ),
    },
    craft: {
      address: requireEffectiveAddress(
        receiptCraft.address,
        `${path}.craft.address`,
      ),
      handle: requireS32(receiptCraft.handle, `${path}.craft.handle`),
      config: requireEffectiveAddress(
        receiptCraft.config,
        `${path}.craft.config`,
      ),
      control: requireEffectiveAddress(
        receiptCraft.control,
        `${path}.craft.control`,
      ),
      primaryVtable: requireEffectiveAddress(
        receiptCraft.primaryVtable,
        `${path}.craft.primaryVtable`,
      ),
      interfaceVtable: requireEffectiveAddress(
        receiptCraft.interfaceVtable,
        `${path}.craft.interfaceVtable`,
      ),
      state: requireS32(receiptCraft.state, `${path}.craft.state`),
    },
  };
  requireExact(receiptCraft.type, "x-wing", `${path}.craft.type`);
  requireExact(lifetime.craft.state, 0, `${path}.craft.state`);
  requireSameLifetime(lifetime, state, path);
  requireAddress(receipt.playerManager, PLAYER_MANAGER, `${path}.playerManager`);

  const transform = projectReceiptTransform(
    receipt.transform,
    `${path}.transform`,
  );
  const simulation = requireExactKeys(
    receipt.simulation,
    RECEIPT_SIMULATION_FIELDS,
    `${path}.simulation`,
  );
  let receiptSimulation;
  if (simulation.manager === null) {
    requireExact(
      simulation.auxiliaryEnabled,
      null,
      `${path}.simulation.auxiliaryEnabled`,
    );
    requireExact(
      simulation.auxiliaryMode,
      null,
      `${path}.simulation.auxiliaryMode`,
    );
    receiptSimulation = Object.freeze({
      manager: null,
      auxiliaryEnabled: null,
      auxiliaryMode: null,
    });
  } else {
    receiptSimulation = Object.freeze({
      manager: requireEffectiveAddress(
        simulation.manager,
        `${path}.simulation.manager`,
      ),
      auxiliaryEnabled: requireU8(
        simulation.auxiliaryEnabled,
        `${path}.simulation.auxiliaryEnabled`,
      ),
      auxiliaryMode: requireS32(
        simulation.auxiliaryMode,
        `${path}.simulation.auxiliaryMode`,
      ),
    });
  }
  const input = projectReceiptInput(receipt.input, `${path}.input`);
  const response = projectValueResponse(
    receipt.response,
    `${path}.response`,
  );

  const receiptBaseline = requireExactKeys(
    receipt.neutralBaseline,
    RECEIPT_BASELINE_FIELDS,
    `${path}.neutralBaseline`,
  );
  const baselineCycle = requireNonNegativeInteger(
    receiptBaseline.cycle,
    `${path}.neutralBaseline.cycle`,
  );
  const baselineSequence = requireNonNegativeInteger(
    receiptBaseline.controllerAppliedSequence,
    `${path}.neutralBaseline.controllerAppliedSequence`,
  );
  const baselineResponse = projectValueResponse(
    receiptBaseline.response,
    `${path}.neutralBaseline.response`,
  );
  requireExact(
    baselineCycle,
    retainedBaseline.cycle,
    `${path}.neutralBaseline.cycle`,
  );
  requireExact(
    baselineSequence,
    retainedBaseline.controllerAppliedSequence,
    `${path}.neutralBaseline.controllerAppliedSequence`,
  );
  for (const field of VALUE_RESPONSE_FIELDS) {
    requireExact(
      baselineResponse[field],
      retainedBaseline.response[field],
      `${path}.neutralBaseline.response.${field}`,
    );
  }
  if (
    baselineCycle >= hostPublication.observedCycle
    || baselineSequence >= hostPublication.sequence
  ) {
    fail(
      `${path}.neutralBaseline`,
      "expected neutral evidence before the observed publication and sequence",
    );
  }

  const transition = requireExactKeys(
    receipt.responseTransition,
    RESPONSE_TRANSITION_FIELDS,
    `${path}.responseTransition`,
  );
  const field460Delta = response.field460 - baselineResponse.field460;
  const field464Delta = response.field464 - baselineResponse.field464;
  requireExact(
    requireFinite(
      transition.field460Delta,
      `${path}.responseTransition.field460Delta`,
    ),
    field460Delta,
    `${path}.responseTransition.field460Delta`,
  );
  requireExact(
    requireFinite(
      transition.field464Delta,
      `${path}.responseTransition.field464Delta`,
    ),
    field464Delta,
    `${path}.responseTransition.field464Delta`,
  );
  const xChanged = Math.abs(field460Delta) > RESPONSE_EPSILON
    || Math.abs(field464Delta) > RESPONSE_EPSILON;
  requireExact(
    transition.xChanged,
    xChanged,
    `${path}.responseTransition.xChanged`,
  );
  requireExact(xChanged, true, `${path}.responseTransition.xChanged`);

  return Object.freeze({
    cycle,
    controllerAppliedSequence,
    hostPublication,
    level: Object.freeze(lifetime.level),
    craft: Object.freeze(lifetime.craft),
    transform,
    simulation: receiptSimulation,
    input,
    response,
    neutralBaseline: Object.freeze({
      cycle: baselineCycle,
      controllerAppliedSequence: baselineSequence,
      response: baselineResponse,
    }),
    responseTransition: Object.freeze({
      field460Delta,
      field464Delta,
      xChanged,
    }),
  });
}

function requireStateLifetime(state, baseline, path) {
  const candidate = {
    level: state.level,
    craft: {
      address: state.craft.address,
      handle: state.playerManager.activeCraftHandle,
      config: state.craft.config,
      control: state.craft.control,
      primaryVtable: state.craft.primaryVtable,
      interfaceVtable: state.craft.interfaceVtable,
    },
  };
  requireSameLifetime(candidate, baseline, path);
}

function projectedCraftLifetime(state) {
  return Object.freeze({
    address: hexU32(state.craft.address),
    handle: state.playerManager.activeCraftHandle,
    config: hexU32(state.craft.config),
    control: hexU32(state.craft.control),
    primaryVtable: hexU32(state.craft.primaryVtable),
    interfaceVtable: hexU32(state.craft.interfaceVtable),
    type: "x-wing",
    state: state.craft.state,
  });
}

function projectedCurrentInput(state) {
  return Object.freeze({
    buttons: state.input.buttons,
    rawStickX: state.input.rawStickX,
    rawStickY: state.input.rawStickY,
    normalizedStickX: state.input.normalizedStickX,
    normalizedStickY: state.input.normalizedStickY,
    globalStickX: state.input.globalStickX,
    globalStickY: state.input.globalStickY,
    stickX: state.craft.stickX,
    stickY: state.craft.stickY,
    neutral: state.craft.inputNeutral,
  });
}

export function projectRogueLeaderGuestConsumption({
  button,
  game,
  postReport,
  preReport,
  publication,
}) {
  if (game.key !== ROGUE_LEADER_FIRST_PLAYABLE_GAME_KEY) return null;
  requireExact(button, "left", "$.button");
  const disc = requireObject(game.disc, "$.game.disc");
  requireExact(disc.identifier, "GSWE64", "$.game.disc.identifier");
  requireExact(disc.revision, 0, "$.game.disc.revision");

  const baselineState = projectRogueLeaderState(
    preReport,
    "$.preReport",
    true,
  );
  requireExact(
    baselineState.guest.lastActiveGameplayInput,
    null,
    "$.preReport.guestGame.lastActiveGameplayInput",
  );
  requireExact(
    baselineState.guest.receiptLifetimeMatches,
    false,
    "$.preReport.guestGame.receiptLifetimeMatches",
  );
  requireExact(
    baselineState.guest.activeFlight,
    false,
    "$.preReport.guestGame.activeFlight",
  );
  requireExact(
    baselineState.guest.guestConsumedHostLeft,
    false,
    "$.preReport.guestGame.guestConsumedHostLeft",
  );
  const preBaseline = projectBaseline(
    baselineState.guest.neutralControlBaseline,
    "$.preReport.guestGame.neutralControlBaseline",
    baselineState,
  );
  if (preBaseline.cycle > preReport.cycles) {
    fail(
      "$.preReport.guestGame.neutralControlBaseline.cycle",
      `expected no later than pre-report cycle ${preReport.cycles}`,
    );
  }
  if (
    preBaseline.controllerAppliedSequence
      > preReport.controller.appliedSequence
  ) {
    fail(
      "$.preReport.guestGame.neutralControlBaseline.controllerAppliedSequence",
      "expected no later than the pre-report applied sequence",
    );
  }

  const postState = projectRogueLeaderState(
    postReport,
    "$.postReport",
    false,
  );
  requireStateLifetime(
    postState,
    baselineState,
    "$.postReport.guestGame",
  );
  const retainedBaseline = projectBaseline(
    postState.guest.neutralControlBaseline,
    "$.postReport.guestGame.neutralControlBaseline",
    postState,
  );
  if (retainedBaseline.cycle < preBaseline.cycle) {
    fail(
      "$.postReport.guestGame.neutralControlBaseline.cycle",
      `expected no earlier than pre-report neutral cycle ${preBaseline.cycle}`,
    );
  }
  if (
    retainedBaseline.controllerAppliedSequence
      < preBaseline.controllerAppliedSequence
  ) {
    fail(
      "$.postReport.guestGame.neutralControlBaseline.controllerAppliedSequence",
      "expected a nondecreasing neutral-baseline controller sequence",
    );
  }
  const receipt = projectReceipt({
    expectedPublication: publication,
    postReport,
    preReport,
    retainedBaseline,
    state: postState,
  });
  const postPresentationCycle = requireNonNegativeInteger(
    postReport.mmioState.viInterruptModel.lastHostPresentationCycle,
    "$.postReport.mmioState.viInterruptModel.lastHostPresentationCycle",
  );
  if (postPresentationCycle < receipt.cycle) {
    fail(
      "$.postReport.mmioState.viInterruptModel.lastHostPresentationCycle",
      `expected a browser presentation at or after retained receipt cycle ${receipt.cycle}`,
    );
  }
  requireSameLifetime(receipt, baselineState, "$.postReport.guestGame.lastActiveGameplayInput");
  requireExact(
    postState.guest.receiptLifetimeMatches,
    true,
    "$.postReport.guestGame.receiptLifetimeMatches",
  );
  requireExact(
    postState.guest.activeFlight,
    true,
    "$.postReport.guestGame.activeFlight",
  );
  requireExact(
    postState.guest.guestConsumedHostLeft,
    true,
    "$.postReport.guestGame.guestConsumedHostLeft",
  );

  return Object.freeze({
    kind: "rogue-leader-xwing-left-control-response-v1",
    cycle: receipt.cycle,
    level: Object.freeze({ ...postState.level }),
    playerManager: hexU32(PLAYER_MANAGER),
    craft: projectedCraftLifetime(postState),
    baseline: Object.freeze({
      cycle: preReport.cycles,
      neutralControl: Object.freeze({
        cycle: preBaseline.cycle,
        controllerAppliedSequence: preBaseline.controllerAppliedSequence,
        level: preBaseline.level,
        craft: Object.freeze({
          ...preBaseline.craft,
          address: hexU32(preBaseline.craft.address),
          config: hexU32(preBaseline.craft.config),
          control: hexU32(preBaseline.craft.control),
          primaryVtable: hexU32(preBaseline.craft.primaryVtable),
          interfaceVtable: hexU32(preBaseline.craft.interfaceVtable),
          type: "x-wing",
        }),
        response: preBaseline.response,
      }),
      transform: baselineState.craft.transform,
      input: projectedCurrentInput(baselineState),
      response: baselineState.craft.response,
    }),
    receipt: Object.freeze({
      cycle: receipt.cycle,
      level: receipt.level,
      craft: Object.freeze({
        ...receipt.craft,
        address: hexU32(receipt.craft.address),
        config: hexU32(receipt.craft.config),
        control: hexU32(receipt.craft.control),
        primaryVtable: hexU32(receipt.craft.primaryVtable),
        interfaceVtable: hexU32(receipt.craft.interfaceVtable),
        type: "x-wing",
      }),
      transform: receipt.transform,
      simulation: Object.freeze({
        ...receipt.simulation,
        manager: receipt.simulation.manager === null
          ? null
          : hexU32(receipt.simulation.manager),
      }),
      input: receipt.input,
      response: receipt.response,
      neutralBaseline: receipt.neutralBaseline,
      responseTransition: receipt.responseTransition,
    }),
    post: Object.freeze({
      cycle: postReport.cycles,
      presentationCycle: postPresentationCycle,
      transform: postState.craft.transform,
      input: projectedCurrentInput(postState),
      response: postState.craft.response,
      receiptLifetimeMatches: true,
      activeFlight: true,
      guestConsumedHostLeft: true,
    }),
    controllerAppliedSequence: receipt.controllerAppliedSequence,
    hostPublication: receipt.hostPublication,
  });
}
