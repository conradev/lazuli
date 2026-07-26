// SPDX-License-Identifier: GPL-3.0-only

import {
  GameFirstPlayableTranscriptError,
} from "./browser_game_first_playable_transcript_core.mjs";

export const METROID_PRIME_FIRST_PLAYABLE_GAME_KEY =
  "metroid-prime-usa-rev-2";

const MANAGER = 0x8045b208;
const PLAYER = 0x8046c9e8;
const WORLD_ASSET_ID = 0x158efe17;
const MINIMUM_FORWARD_DELTA = 1e-6;
const HEX_U32_PATTERN = /^0x[0-9a-f]{8}$/;
const VECTOR_FIELDS = Object.freeze(["x", "y", "z"]);
const GUEST_FIELDS = Object.freeze([
  "identity",
  "manager",
  "world",
  "camera",
  "playerState",
  "player",
  "input",
  "turn",
  "lifecycleRunning",
  "controlsEnabled",
  "controllableFrigate",
  "guestConsumedHostLeft",
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
const MANAGER_FIELDS = Object.freeze([
  "address",
  "mapped",
  "playerPointerAddress",
  "player",
  "worldPointerAddress",
  "world",
  "cameraManagerPointerAddress",
  "cameraManager",
  "playerStateRefDataPointerAddress",
  "nextAreaAddress",
  "nextArea",
  "inputFrameAddress",
  "inputFrame",
  "updateFrameAddress",
  "updateFrame",
  "gameStateAddress",
  "gameState",
  "initPhaseAddress",
  "initPhase",
]);
const WORLD_FIELDS = Object.freeze([
  "address",
  "assetIdAddress",
  "assetId",
  "areaAddress",
  "area",
  "firstArea",
]);
const CAMERA_FIELDS = Object.freeze([
  "manager",
  "currentIdAddress",
  "currentId",
  "cinematicCountAddress",
  "cinematicCount",
  "firstPersonPointerAddress",
  "firstPerson",
  "firstPersonId",
  "flagsAddress",
  "flags",
  "disablesInput",
  "firstPersonActive",
  "inputEnabled",
]);
const PLAYER_STATE_FIELDS = Object.freeze([
  "refData",
  "refCount",
  "address",
  "flagsAddress",
  "flags",
  "alive",
]);
const PLAYER_FIELDS = Object.freeze([
  "expectedAddress",
  "address",
  "valid",
  "areaAddress",
  "area",
  "uniqueIdAddress",
  "uniqueId",
  "entityFlagsAddress",
  "entityFlags",
  "entityActive",
  "transform",
  "velocityAddress",
  "velocity",
  "angularVelocityAddress",
  "angularVelocity",
  "torqueAddress",
  "torque",
  "movementStateAddress",
  "movementState",
  "surfaceRestraintAddress",
  "surfaceRestraint",
  "cameraStateAddress",
  "cameraState",
  "morphStateAddress",
  "morphState",
  "orbitStateAddress",
  "orbitState",
  "frozenTimeoutAddress",
  "frozenTimeout",
  "controlsFrozenAddress",
  "controlsFrozen",
  "inputFlagsAddress",
  "inputFlags",
  "disablesInput",
  "deathTimeAddress",
  "deathTime",
]);
const TRANSFORM_FIELDS = Object.freeze([
  "address",
  "rightAddresses",
  "right",
  "forwardAddresses",
  "forward",
  "upAddresses",
  "up",
  "positionAddresses",
  "position",
  "orthonormal",
]);
const INPUT_FIELDS = Object.freeze([
  "address",
  "time",
  "controllerIndex",
  "leftX",
  "leftY",
  "rightX",
  "rightY",
  "leftTrigger",
  "rightTrigger",
  "analogEdgeLeftX",
  "analogEdgeLeftY",
  "analogEdgeRightX",
  "analogEdgeRightY",
  "previousLeftTrigger",
  "previousRightTrigger",
  "buttons1",
  "buttons2",
  "buttons3",
  "valid",
  "neutral",
  "hostLeftRetained",
]);
const TURN_FIELDS = Object.freeze([
  "angularVelocityAlongUp",
  "torqueAlongUp",
]);
const LATCH_FIELDS = Object.freeze([
  "cycle",
  "controllerAppliedSequence",
  "hostPublication",
  "manager",
  "player",
  "world",
  "worldAssetId",
  "area",
  "inputFrame",
  "updateFrame",
  "position",
  "forward",
  "up",
  "angularVelocity",
  "torque",
  "input",
  "turn",
  "lifecycle",
  "camera",
]);
const LATCH_INPUT_FIELDS = Object.freeze([
  "time",
  "controllerIndex",
  "leftX",
  "leftY",
  "rightX",
  "rightY",
  "leftTrigger",
  "rightTrigger",
  "buttons1",
  "buttons2",
  "buttons3",
]);
const LATCH_LIFECYCLE_FIELDS = Object.freeze([
  "gameState",
  "initPhase",
  "playerStateFlags",
  "entityFlags",
  "cameraState",
  "morphState",
  "orbitState",
  "frozenTimeout",
  "controlsFrozen",
  "playerInputFlags",
  "deathTime",
]);
const LATCH_CAMERA_FIELDS = Object.freeze([
  "manager",
  "firstPerson",
  "currentId",
  "firstPersonId",
  "cinematicCount",
  "flags",
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

function requireMappedMem1(value, path, length = 1) {
  const address = requireHexU32(value, path);
  if (
    !Number.isSafeInteger(length)
    || length < 1
    || address < 0x80000000
    || address > 0x81800000 - length
    || (address & 3) !== 0
  ) {
    fail(path, "expected an aligned mapped MEM1 address");
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

function requireAddressArray(value, expected, path) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail(path, `expected ${expected.length} exact addresses`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    requireAddress(value[index], expected[index], `${path}.${index}`);
  }
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

function magnitudeSquared(vector) {
  return dot(vector, vector);
}

function vectorDeltaSquared(left, right) {
  const x = right.x - left.x;
  const y = right.y - left.y;
  const z = right.z - left.z;
  return x * x + y * y + z * z;
}

function requireApproximatelyEqual(value, expected, path, tolerance = 1e-5) {
  if (
    !Number.isFinite(value)
    || !Number.isFinite(expected)
    || Math.abs(value - expected) > tolerance
  ) {
    fail(path, `expected ${expected} within ${tolerance}, got ${value}`);
  }
  return value;
}

function requireUnitPair(forward, up, path) {
  const forwardLengthSquared = magnitudeSquared(forward);
  const upLengthSquared = magnitudeSquared(up);
  const perpendicular = dot(forward, up);
  if (
    forwardLengthSquared < 0.9
    || forwardLengthSquared > 1.1
    || upLengthSquared < 0.9
    || upLengthSquared > 1.1
    || Math.abs(perpendicular) > 0.1
  ) {
    fail(path, "expected finite approximately orthonormal forward/up vectors");
  }
}

function requireOrthonormalTransform(right, forward, up, path) {
  requireUnitPair(forward, up, path);
  const rightLengthSquared = magnitudeSquared(right);
  if (
    rightLengthSquared < 0.9
    || rightLengthSquared > 1.1
    || Math.abs(dot(right, forward)) > 0.1
    || Math.abs(dot(right, up)) > 0.1
  ) {
    fail(path, "expected a finite approximately orthonormal transform");
  }
}

function projectCurrentInput(value, path, requireNeutral) {
  const input = requireExactKeys(value, INPUT_FIELDS, path);
  requireAddress(input.address, MANAGER + 0xb54, `${path}.address`);
  const time = requireRange(input.time, Number.MIN_VALUE, 1, `${path}.time`);
  const controllerIndex = requireU32(
    input.controllerIndex,
    `${path}.controllerIndex`,
  );
  requireExact(controllerIndex, 0, `${path}.controllerIndex`);
  const axes = Object.fromEntries(
    ["leftX", "leftY", "rightX", "rightY"].map(field => [
      field,
      requireRange(input[field], -1, 1, `${path}.${field}`),
    ]),
  );
  const triggers = Object.fromEntries(
    [
      "leftTrigger",
      "rightTrigger",
      "previousLeftTrigger",
      "previousRightTrigger",
    ].map(field => [
      field,
      requireRange(input[field], 0, 1, `${path}.${field}`),
    ]),
  );
  for (const field of [
    "analogEdgeLeftX",
    "analogEdgeLeftY",
    "analogEdgeRightX",
    "analogEdgeRightY",
  ]) {
    const edge = requireU8(input[field], `${path}.${field}`);
    if (edge !== 0 && edge !== 1) {
      fail(`${path}.${field}`, "expected an edge byte of zero or one");
    }
  }
  const edges = Object.fromEntries(
    [
      "analogEdgeLeftX",
      "analogEdgeLeftY",
      "analogEdgeRightX",
      "analogEdgeRightY",
    ].map(field => [field, input[field]]),
  );
  const buttons1 = requireU8(input.buttons1, `${path}.buttons1`);
  const buttons2 = requireU8(input.buttons2, `${path}.buttons2`);
  const buttons3 = requireU8(input.buttons3, `${path}.buttons3`);
  requireExact(input.valid, true, `${path}.valid`);

  const neutral = axes.leftX === 0
    && axes.leftY === 0
    && axes.rightX === 0
    && axes.rightY === 0
    && triggers.leftTrigger === 0
    && triggers.rightTrigger === 0
    && buttons1 === 0
    && buttons2 === 0
    && buttons3 === 0;
  const hostLeftRetained = axes.leftX >= -1
    && axes.leftX <= -0.5
    && Math.abs(axes.leftY) <= 0.125
    && Math.abs(axes.rightX) <= 0.125
    && Math.abs(axes.rightY) <= 0.125
    && triggers.leftTrigger === 0
    && triggers.rightTrigger === 0
    && triggers.previousLeftTrigger === 0
    && triggers.previousRightTrigger === 0
    && buttons1 === 0
    && buttons2 === 0x20
    && (buttons3 === 0 || buttons3 === 0x02);
  requireExact(input.neutral, neutral, `${path}.neutral`);
  requireExact(
    input.hostLeftRetained,
    hostLeftRetained,
    `${path}.hostLeftRetained`,
  );
  if (requireNeutral) {
    requireExact(neutral, true, path);
    for (const [field, value] of [
      ...Object.entries(axes),
      ...Object.entries(triggers),
      ...Object.entries(edges),
      ["buttons1", buttons1],
      ["buttons2", buttons2],
      ["buttons3", buttons3],
    ]) {
      requireExact(value, 0, `${path}.${field}`);
    }
  }
  return Object.freeze({
    time,
    controllerIndex,
    ...axes,
    ...triggers,
    buttons1,
    buttons2,
    buttons3,
    neutral,
    hostLeftRetained,
  });
}

function projectMetroidPrimeState(report, path, requireNeutral) {
  const guestPath = `${path}.guestGame`;
  const guest = requireExactKeys(report.guestGame, GUEST_FIELDS, guestPath);

  const identityPath = `${guestPath}.identity`;
  const identity = requireExactKeys(
    guest.identity,
    IDENTITY_FIELDS,
    identityPath,
  );
  requireExact(identity.headerAddress, "0x80000000", `${identityPath}.headerAddress`);
  requireExact(identity.gameCode, "0x474d3845", `${identityPath}.gameCode`);
  requireExact(identity.makerCode, 0x3031, `${identityPath}.makerCode`);
  requireExact(identity.discNumber, 0, `${identityPath}.discNumber`);
  requireExact(identity.revision, 2, `${identityPath}.revision`);
  requireExact(identity.exact, true, `${identityPath}.exact`);

  const managerPath = `${guestPath}.manager`;
  const manager = requireExactKeys(
    guest.manager,
    MANAGER_FIELDS,
    managerPath,
  );
  requireAddress(manager.address, MANAGER, `${managerPath}.address`);
  requireExact(manager.mapped, true, `${managerPath}.mapped`);
  requireAddress(
    manager.playerPointerAddress,
    MANAGER + 0x84c,
    `${managerPath}.playerPointerAddress`,
  );
  requireAddress(manager.player, PLAYER, `${managerPath}.player`);
  requireAddress(
    manager.worldPointerAddress,
    MANAGER + 0x850,
    `${managerPath}.worldPointerAddress`,
  );
  const worldAddress = requireMappedMem1(
    manager.world,
    `${managerPath}.world`,
    0x6c,
  );
  requireAddress(
    manager.cameraManagerPointerAddress,
    MANAGER + 0x870,
    `${managerPath}.cameraManagerPointerAddress`,
  );
  const cameraManager = requireMappedMem1(
    manager.cameraManager,
    `${managerPath}.cameraManager`,
    0x3cc,
  );
  requireAddress(
    manager.playerStateRefDataPointerAddress,
    MANAGER + 0x8b8,
    `${managerPath}.playerStateRefDataPointerAddress`,
  );
  requireAddress(
    manager.nextAreaAddress,
    MANAGER + 0x8cc,
    `${managerPath}.nextAreaAddress`,
  );
  requireExact(
    requireS32(manager.nextArea, `${managerPath}.nextArea`),
    0,
    `${managerPath}.nextArea`,
  );
  requireAddress(
    manager.inputFrameAddress,
    MANAGER + 0x8d4,
    `${managerPath}.inputFrameAddress`,
  );
  const inputFrame = requireU32(
    manager.inputFrame,
    `${managerPath}.inputFrame`,
  );
  requireAddress(
    manager.updateFrameAddress,
    MANAGER + 0x8d8,
    `${managerPath}.updateFrameAddress`,
  );
  const updateFrame = requireU32(
    manager.updateFrame,
    `${managerPath}.updateFrame`,
  );
  requireAddress(
    manager.gameStateAddress,
    MANAGER + 0x904,
    `${managerPath}.gameStateAddress`,
  );
  requireExact(
    requireU32(manager.gameState, `${managerPath}.gameState`),
    0,
    `${managerPath}.gameState`,
  );
  requireAddress(
    manager.initPhaseAddress,
    MANAGER + 0xb3c,
    `${managerPath}.initPhaseAddress`,
  );
  requireExact(
    requireU32(manager.initPhase, `${managerPath}.initPhase`),
    2,
    `${managerPath}.initPhase`,
  );

  const worldPath = `${guestPath}.world`;
  const world = requireExactKeys(guest.world, WORLD_FIELDS, worldPath);
  requireExact(
    requireMappedMem1(world.address, `${worldPath}.address`, 0x6c),
    worldAddress,
    `${worldPath}.address`,
  );
  requireAddress(
    world.assetIdAddress,
    worldAddress + 8,
    `${worldPath}.assetIdAddress`,
  );
  requireExact(
    requireU32(world.assetId, `${worldPath}.assetId`),
    WORLD_ASSET_ID,
    `${worldPath}.assetId`,
  );
  requireAddress(
    world.areaAddress,
    worldAddress + 0x68,
    `${worldPath}.areaAddress`,
  );
  requireExact(
    requireS32(world.area, `${worldPath}.area`),
    0,
    `${worldPath}.area`,
  );
  requireExact(world.firstArea, true, `${worldPath}.firstArea`);

  const cameraPath = `${guestPath}.camera`;
  const camera = requireExactKeys(guest.camera, CAMERA_FIELDS, cameraPath);
  requireExact(
    requireMappedMem1(camera.manager, `${cameraPath}.manager`, 0x3cc),
    cameraManager,
    `${cameraPath}.manager`,
  );
  requireAddress(
    camera.currentIdAddress,
    cameraManager,
    `${cameraPath}.currentIdAddress`,
  );
  const cameraId = requireU16(camera.currentId, `${cameraPath}.currentId`);
  if (cameraId === 0xffff) {
    fail(`${cameraPath}.currentId`, "expected a live first-person camera ID");
  }
  requireAddress(
    camera.cinematicCountAddress,
    cameraManager + 8,
    `${cameraPath}.cinematicCountAddress`,
  );
  requireExact(
    requireU32(camera.cinematicCount, `${cameraPath}.cinematicCount`),
    0,
    `${cameraPath}.cinematicCount`,
  );
  requireAddress(
    camera.firstPersonPointerAddress,
    cameraManager + 0x88,
    `${cameraPath}.firstPersonPointerAddress`,
  );
  const firstPersonCamera = requireMappedMem1(
    camera.firstPerson,
    `${cameraPath}.firstPerson`,
    0x198,
  );
  requireExact(
    requireU16(camera.firstPersonId, `${cameraPath}.firstPersonId`),
    cameraId,
    `${cameraPath}.firstPersonId`,
  );
  requireAddress(
    camera.flagsAddress,
    firstPersonCamera + 0x180,
    `${cameraPath}.flagsAddress`,
  );
  const cameraFlags = requireU8(camera.flags, `${cameraPath}.flags`);
  if ((cameraFlags & 0x40) !== 0) {
    fail(`${cameraPath}.flags`, "expected the camera input-disable bit clear");
  }
  requireExact(camera.disablesInput, false, `${cameraPath}.disablesInput`);
  requireExact(camera.firstPersonActive, true, `${cameraPath}.firstPersonActive`);
  requireExact(camera.inputEnabled, true, `${cameraPath}.inputEnabled`);

  const playerStatePath = `${guestPath}.playerState`;
  const playerState = requireExactKeys(
    guest.playerState,
    PLAYER_STATE_FIELDS,
    playerStatePath,
  );
  const playerStateRefData = requireMappedMem1(
    playerState.refData,
    `${playerStatePath}.refData`,
    8,
  );
  const playerStateRefCount = requireS32(
    playerState.refCount,
    `${playerStatePath}.refCount`,
  );
  if (playerStateRefCount <= 0) {
    fail(`${playerStatePath}.refCount`, "expected a positive signed reference count");
  }
  const playerStateAddress = requireMappedMem1(
    playerState.address,
    `${playerStatePath}.address`,
    0x198,
  );
  requireExact(
    playerState.flagsAddress,
    playerState.address,
    `${playerStatePath}.flagsAddress`,
  );
  const playerStateFlags = requireU8(
    playerState.flags,
    `${playerStatePath}.flags`,
  );
  if ((playerStateFlags & 0x80) === 0) {
    fail(`${playerStatePath}.flags`, "expected the player-state alive bit");
  }
  requireExact(playerState.alive, true, `${playerStatePath}.alive`);

  const playerPath = `${guestPath}.player`;
  const player = requireExactKeys(guest.player, PLAYER_FIELDS, playerPath);
  requireAddress(player.expectedAddress, PLAYER, `${playerPath}.expectedAddress`);
  requireAddress(player.address, PLAYER, `${playerPath}.address`);
  requireExact(player.valid, true, `${playerPath}.valid`);
  requireAddress(player.areaAddress, PLAYER + 4, `${playerPath}.areaAddress`);
  requireExact(
    requireS32(player.area, `${playerPath}.area`),
    0,
    `${playerPath}.area`,
  );
  requireAddress(
    player.uniqueIdAddress,
    PLAYER + 8,
    `${playerPath}.uniqueIdAddress`,
  );
  const playerUniqueId = requireU16(
    player.uniqueId,
    `${playerPath}.uniqueId`,
  );
  if (playerUniqueId === 0xffff) {
    fail(`${playerPath}.uniqueId`, "expected a live player unique ID");
  }
  requireAddress(
    player.entityFlagsAddress,
    PLAYER + 0x30,
    `${playerPath}.entityFlagsAddress`,
  );
  const entityFlags = requireU8(
    player.entityFlags,
    `${playerPath}.entityFlags`,
  );
  if ((entityFlags & 0xf0) !== 0x80) {
    fail(`${playerPath}.entityFlags`, "expected an active player entity");
  }
  requireExact(player.entityActive, true, `${playerPath}.entityActive`);

  const transformPath = `${playerPath}.transform`;
  const transform = requireExactKeys(
    player.transform,
    TRANSFORM_FIELDS,
    transformPath,
  );
  requireAddress(transform.address, PLAYER + 0x34, `${transformPath}.address`);
  requireAddressArray(
    transform.rightAddresses,
    [PLAYER + 0x34, PLAYER + 0x44, PLAYER + 0x54],
    `${transformPath}.rightAddresses`,
  );
  requireAddressArray(
    transform.forwardAddresses,
    [PLAYER + 0x38, PLAYER + 0x48, PLAYER + 0x58],
    `${transformPath}.forwardAddresses`,
  );
  requireAddressArray(
    transform.upAddresses,
    [PLAYER + 0x3c, PLAYER + 0x4c, PLAYER + 0x5c],
    `${transformPath}.upAddresses`,
  );
  requireAddressArray(
    transform.positionAddresses,
    [PLAYER + 0x40, PLAYER + 0x50, PLAYER + 0x60],
    `${transformPath}.positionAddresses`,
  );
  const right = requireVector(transform.right, `${transformPath}.right`);
  const forward = requireVector(transform.forward, `${transformPath}.forward`);
  const up = requireVector(transform.up, `${transformPath}.up`);
  const position = requireVector(transform.position, `${transformPath}.position`);
  requireOrthonormalTransform(right, forward, up, transformPath);
  requireExact(transform.orthonormal, true, `${transformPath}.orthonormal`);

  requireAddress(
    player.velocityAddress,
    PLAYER + 0x148,
    `${playerPath}.velocityAddress`,
  );
  const velocity = requireVector(player.velocity, `${playerPath}.velocity`);
  requireAddress(
    player.angularVelocityAddress,
    PLAYER + 0x154,
    `${playerPath}.angularVelocityAddress`,
  );
  const angularVelocity = requireVector(
    player.angularVelocity,
    `${playerPath}.angularVelocity`,
  );
  requireAddress(
    player.torqueAddress,
    PLAYER + 0x184,
    `${playerPath}.torqueAddress`,
  );
  const torque = requireVector(player.torque, `${playerPath}.torque`);
  requireAddress(
    player.movementStateAddress,
    PLAYER + 0x268,
    `${playerPath}.movementStateAddress`,
  );
  requireRange(
    requireU32(player.movementState, `${playerPath}.movementState`),
    0,
    4,
    `${playerPath}.movementState`,
  );
  requireAddress(
    player.surfaceRestraintAddress,
    PLAYER + 0x2bc,
    `${playerPath}.surfaceRestraintAddress`,
  );
  requireRange(
    requireU32(player.surfaceRestraint, `${playerPath}.surfaceRestraint`),
    0,
    7,
    `${playerPath}.surfaceRestraint`,
  );
  for (const [field, offset] of [
    ["cameraState", 0x304],
    ["morphState", 0x308],
    ["orbitState", 0x314],
  ]) {
    requireAddress(
      player[`${field}Address`],
      PLAYER + offset,
      `${playerPath}.${field}Address`,
    );
    requireExact(
      requireU32(player[field], `${playerPath}.${field}`),
      0,
      `${playerPath}.${field}`,
    );
  }
  requireAddress(
    player.frozenTimeoutAddress,
    PLAYER + 0x760,
    `${playerPath}.frozenTimeoutAddress`,
  );
  const frozenTimeout = requireFinite(
    player.frozenTimeout,
    `${playerPath}.frozenTimeout`,
  );
  if (frozenTimeout > 0) {
    fail(`${playerPath}.frozenTimeout`, "expected unfrozen controls");
  }
  requireAddress(
    player.controlsFrozenAddress,
    PLAYER + 0x770,
    `${playerPath}.controlsFrozenAddress`,
  );
  requireExact(
    requireU8(player.controlsFrozen, `${playerPath}.controlsFrozen`),
    0,
    `${playerPath}.controlsFrozen`,
  );
  requireAddress(
    player.inputFlagsAddress,
    PLAYER + 0x9d6,
    `${playerPath}.inputFlagsAddress`,
  );
  const playerInputFlags = requireU8(
    player.inputFlags,
    `${playerPath}.inputFlags`,
  );
  if ((playerInputFlags & 0x04) !== 0) {
    fail(`${playerPath}.inputFlags`, "expected the player input-disable bit clear");
  }
  requireExact(player.disablesInput, false, `${playerPath}.disablesInput`);
  requireAddress(
    player.deathTimeAddress,
    PLAYER + 0xa04,
    `${playerPath}.deathTimeAddress`,
  );
  requireExact(
    requireFinite(player.deathTime, `${playerPath}.deathTime`),
    0,
    `${playerPath}.deathTime`,
  );

  const input = projectCurrentInput(
    guest.input,
    `${guestPath}.input`,
    requireNeutral,
  );
  const turnPath = `${guestPath}.turn`;
  const turn = requireExactKeys(guest.turn, TURN_FIELDS, turnPath);
  const angularVelocityAlongUp = requireFinite(
    turn.angularVelocityAlongUp,
    `${turnPath}.angularVelocityAlongUp`,
  );
  const torqueAlongUp = requireFinite(
    turn.torqueAlongUp,
    `${turnPath}.torqueAlongUp`,
  );
  requireApproximatelyEqual(
    angularVelocityAlongUp,
    dot(angularVelocity, up),
    `${turnPath}.angularVelocityAlongUp`,
  );
  requireApproximatelyEqual(
    torqueAlongUp,
    dot(torque, up),
    `${turnPath}.torqueAlongUp`,
  );

  requireExact(
    guest.lifecycleRunning,
    true,
    `${guestPath}.lifecycleRunning`,
  );
  requireExact(guest.controlsEnabled, true, `${guestPath}.controlsEnabled`);
  requireExact(
    guest.controllableFrigate,
    true,
    `${guestPath}.controllableFrigate`,
  );
  requireExact(
    guest.guestConsumedHostLeft,
    input.hostLeftRetained,
    `${guestPath}.guestConsumedHostLeft`,
  );

  return Object.freeze({
    guest,
    worldAddress,
    cameraManager,
    firstPersonCamera,
    playerStateRefData,
    playerStateAddress,
    playerStateFlags,
    playerUniqueId,
    entityFlags,
    cameraId,
    cameraFlags,
    inputFrame,
    updateFrame,
    right,
    forward,
    up,
    position,
    velocity,
    angularVelocity,
    torque,
    input,
  });
}

function projectLatchInput(value, path) {
  const input = requireExactKeys(value, LATCH_INPUT_FIELDS, path);
  const time = requireRange(input.time, Number.MIN_VALUE, 1, `${path}.time`);
  requireExact(
    requireU32(input.controllerIndex, `${path}.controllerIndex`),
    0,
    `${path}.controllerIndex`,
  );
  const leftX = requireRange(input.leftX, -1, -0.5, `${path}.leftX`);
  const leftY = requireRange(input.leftY, -0.125, 0.125, `${path}.leftY`);
  const rightX = requireRange(input.rightX, -0.125, 0.125, `${path}.rightX`);
  const rightY = requireRange(input.rightY, -0.125, 0.125, `${path}.rightY`);
  requireExact(
    requireRange(input.leftTrigger, 0, 1, `${path}.leftTrigger`),
    0,
    `${path}.leftTrigger`,
  );
  requireExact(
    requireRange(input.rightTrigger, 0, 1, `${path}.rightTrigger`),
    0,
    `${path}.rightTrigger`,
  );
  requireExact(requireU8(input.buttons1, `${path}.buttons1`), 0, `${path}.buttons1`);
  requireExact(
    requireU8(input.buttons2, `${path}.buttons2`),
    0x20,
    `${path}.buttons2`,
  );
  const buttons3 = requireU8(input.buttons3, `${path}.buttons3`);
  if (buttons3 !== 0 && buttons3 !== 0x02) {
    fail(`${path}.buttons3`, "expected the left edge or its retained held state");
  }
  return Object.freeze({
    time,
    controllerIndex: input.controllerIndex,
    leftX,
    leftY,
    rightX,
    rightY,
    leftTrigger: input.leftTrigger,
    rightTrigger: input.rightTrigger,
    buttons1: input.buttons1,
    buttons2: input.buttons2,
    buttons3,
  });
}

function projectLatchLifecycle(value, path) {
  const lifecycle = requireExactKeys(value, LATCH_LIFECYCLE_FIELDS, path);
  requireExact(
    requireU32(lifecycle.gameState, `${path}.gameState`),
    0,
    `${path}.gameState`,
  );
  requireExact(
    requireU32(lifecycle.initPhase, `${path}.initPhase`),
    2,
    `${path}.initPhase`,
  );
  const playerStateFlags = requireU8(
    lifecycle.playerStateFlags,
    `${path}.playerStateFlags`,
  );
  if ((playerStateFlags & 0x80) === 0) {
    fail(`${path}.playerStateFlags`, "expected the player-state alive bit");
  }
  const entityFlags = requireU8(lifecycle.entityFlags, `${path}.entityFlags`);
  if ((entityFlags & 0xf0) !== 0x80) {
    fail(`${path}.entityFlags`, "expected an active player entity");
  }
  for (const field of ["cameraState", "morphState", "orbitState"]) {
    requireExact(
      requireU32(lifecycle[field], `${path}.${field}`),
      0,
      `${path}.${field}`,
    );
  }
  const frozenTimeout = requireFinite(
    lifecycle.frozenTimeout,
    `${path}.frozenTimeout`,
  );
  if (frozenTimeout > 0) {
    fail(`${path}.frozenTimeout`, "expected unfrozen controls");
  }
  requireExact(
    requireU8(lifecycle.controlsFrozen, `${path}.controlsFrozen`),
    0,
    `${path}.controlsFrozen`,
  );
  const playerInputFlags = requireU8(
    lifecycle.playerInputFlags,
    `${path}.playerInputFlags`,
  );
  if ((playerInputFlags & 0x04) !== 0) {
    fail(`${path}.playerInputFlags`, "expected the input-disable bit clear");
  }
  requireExact(
    requireFinite(lifecycle.deathTime, `${path}.deathTime`),
    0,
    `${path}.deathTime`,
  );
  return Object.freeze({
    playerStateFlags,
    entityFlags,
    frozenTimeout,
    playerInputFlags,
  });
}

function projectLatchCamera(value, path, baseline) {
  const camera = requireExactKeys(value, LATCH_CAMERA_FIELDS, path);
  requireExact(camera.manager, hexU32(baseline.cameraManager), `${path}.manager`);
  requireExact(
    camera.firstPerson,
    hexU32(baseline.firstPersonCamera),
    `${path}.firstPerson`,
  );
  const currentId = requireU16(camera.currentId, `${path}.currentId`);
  if (currentId === 0xffff) {
    fail(`${path}.currentId`, "expected a live first-person camera ID");
  }
  requireExact(currentId, baseline.cameraId, `${path}.currentId`);
  requireExact(
    requireU16(camera.firstPersonId, `${path}.firstPersonId`),
    currentId,
    `${path}.firstPersonId`,
  );
  requireExact(
    requireU32(camera.cinematicCount, `${path}.cinematicCount`),
    0,
    `${path}.cinematicCount`,
  );
  const flags = requireU8(camera.flags, `${path}.flags`);
  if ((flags & 0x40) !== 0) {
    fail(`${path}.flags`, "expected the camera input-disable bit clear");
  }
  return Object.freeze({ currentId, flags });
}

function projectPublication(value, path, publication, preReport, cycle) {
  const host = requireExactKeys(value, PUBLICATION_FIELDS, path);
  const terminal = requireExactKeys(
    publication,
    PUBLICATION_FIELDS,
    "$.publication",
  );
  if (host.source !== "periodic" && host.source !== "direct") {
    fail(`${path}.source`, "expected periodic or direct");
  }
  const pollIndex = requirePositiveInteger(host.pollIndex, `${path}.pollIndex`);
  const scheduledCycle = requireNonNegativeInteger(
    host.scheduledCycle,
    `${path}.scheduledCycle`,
  );
  const observedCycle = requireNonNegativeInteger(
    host.observedCycle,
    `${path}.observedCycle`,
  );
  requireExact(host.buttons, 0x0001, `${path}.buttons`);
  const sequence = requirePositiveInteger(host.sequence, `${path}.sequence`);
  if (
    scheduledCycle < preReport.cycles
    || scheduledCycle > observedCycle
    || observedCycle > cycle
  ) {
    fail(
      path,
      `expected publication between baseline cycle ${preReport.cycles} and latch cycle ${cycle}`,
    );
  }
  if (pollIndex <= preReport.controller.pollIndex) {
    fail(
      `${path}.pollIndex`,
      `expected a value greater than ${preReport.controller.pollIndex}`,
    );
  }
  for (const field of PUBLICATION_FIELDS) {
    requireExact(host[field], terminal[field], `${path}.${field}`);
  }
  return Object.freeze({
    source: host.source,
    pollIndex,
    scheduledCycle,
    observedCycle,
    buttons: host.buttons,
    sequence,
  });
}

function requireStableState(post, baseline) {
  for (const [path, postValue, baselineValue] of [
    ["$.postReport.guestGame.manager.world", post.worldAddress, baseline.worldAddress],
    [
      "$.postReport.guestGame.manager.cameraManager",
      post.cameraManager,
      baseline.cameraManager,
    ],
    [
      "$.postReport.guestGame.camera.firstPerson",
      post.firstPersonCamera,
      baseline.firstPersonCamera,
    ],
    [
      "$.postReport.guestGame.playerState.refData",
      post.playerStateRefData,
      baseline.playerStateRefData,
    ],
    [
      "$.postReport.guestGame.playerState.address",
      post.playerStateAddress,
      baseline.playerStateAddress,
    ],
    [
      "$.postReport.guestGame.player.uniqueId",
      post.playerUniqueId,
      baseline.playerUniqueId,
    ],
    [
      "$.postReport.guestGame.camera.currentId",
      post.cameraId,
      baseline.cameraId,
    ],
    [
      "$.postReport.guestGame.playerState.flags",
      post.playerStateFlags,
      baseline.playerStateFlags,
    ],
    [
      "$.postReport.guestGame.player.entityFlags",
      post.entityFlags,
      baseline.entityFlags,
    ],
    [
      "$.postReport.guestGame.camera.flags",
      post.cameraFlags,
      baseline.cameraFlags,
    ],
  ]) {
    requireExact(postValue, baselineValue, path);
  }
}

export function projectMetroidPrimeGuestConsumption({
  button,
  game,
  postReport,
  preReport,
  publication,
}) {
  if (game.key !== METROID_PRIME_FIRST_PLAYABLE_GAME_KEY) return null;
  requireExact(button, "left", "$.button");
  const disc = requireObject(game.disc, "$.game.disc");
  requireExact(disc.identifier, "GM8E01", "$.game.disc.identifier");
  requireExact(disc.revision, 2, "$.game.disc.revision");

  const baseline = projectMetroidPrimeState(
    preReport,
    "$.preReport",
    true,
  );
  requireExact(
    baseline.guest.lastActiveGameplayInput,
    null,
    "$.preReport.guestGame.lastActiveGameplayInput",
  );
  const post = projectMetroidPrimeState(postReport, "$.postReport", false);
  requireStableState(post, baseline);

  const latchPath = "$.postReport.guestGame.lastActiveGameplayInput";
  const latch = requireExactKeys(
    post.guest.lastActiveGameplayInput,
    LATCH_FIELDS,
    latchPath,
  );
  const cycle = requireNonNegativeInteger(latch.cycle, `${latchPath}.cycle`);
  if (cycle < preReport.cycles || cycle > postReport.cycles) {
    fail(
      `${latchPath}.cycle`,
      `expected a value from ${preReport.cycles} through ${postReport.cycles}`,
    );
  }
  requireExact(latch.manager, hexU32(MANAGER), `${latchPath}.manager`);
  requireExact(latch.player, hexU32(PLAYER), `${latchPath}.player`);
  requireExact(
    latch.world,
    hexU32(baseline.worldAddress),
    `${latchPath}.world`,
  );
  requireExact(
    requireU32(latch.worldAssetId, `${latchPath}.worldAssetId`),
    WORLD_ASSET_ID,
    `${latchPath}.worldAssetId`,
  );
  requireExact(
    requireS32(latch.area, `${latchPath}.area`),
    0,
    `${latchPath}.area`,
  );
  const latchInputFrame = requireU32(
    latch.inputFrame,
    `${latchPath}.inputFrame`,
  );
  const latchUpdateFrame = requireU32(
    latch.updateFrame,
    `${latchPath}.updateFrame`,
  );
  if (
    latchInputFrame < baseline.inputFrame
    || latchUpdateFrame < baseline.updateFrame
  ) {
    fail(
      `${latchPath}.updateFrame`,
      "expected monotonic input/update frames at the retained receipt",
    );
  }
  const latchPosition = requireVector(
    latch.position,
    `${latchPath}.position`,
  );
  const latchForward = requireVector(
    latch.forward,
    `${latchPath}.forward`,
  );
  const latchUp = requireVector(latch.up, `${latchPath}.up`);
  requireUnitPair(latchForward, latchUp, `${latchPath}.forward`);
  const latchAngularVelocity = requireVector(
    latch.angularVelocity,
    `${latchPath}.angularVelocity`,
  );
  const latchTorque = requireVector(latch.torque, `${latchPath}.torque`);
  const latchInput = projectLatchInput(latch.input, `${latchPath}.input`);

  const turnPath = `${latchPath}.turn`;
  const latchTurn = requireExactKeys(latch.turn, TURN_FIELDS, turnPath);
  const latchAngularVelocityAlongUp = requireFinite(
    latchTurn.angularVelocityAlongUp,
    `${turnPath}.angularVelocityAlongUp`,
  );
  const latchTorqueAlongUp = requireFinite(
    latchTurn.torqueAlongUp,
    `${turnPath}.torqueAlongUp`,
  );
  requireApproximatelyEqual(
    latchAngularVelocityAlongUp,
    dot(latchAngularVelocity, latchUp),
    `${turnPath}.angularVelocityAlongUp`,
  );
  requireApproximatelyEqual(
    latchTorqueAlongUp,
    dot(latchTorque, latchUp),
    `${turnPath}.torqueAlongUp`,
  );
  const latchLifecycle = projectLatchLifecycle(
    latch.lifecycle,
    `${latchPath}.lifecycle`,
  );
  const latchCamera = projectLatchCamera(
    latch.camera,
    `${latchPath}.camera`,
    baseline,
  );
  requireExact(
    latchLifecycle.playerStateFlags,
    baseline.playerStateFlags,
    `${latchPath}.lifecycle.playerStateFlags`,
  );
  requireExact(
    latchLifecycle.entityFlags,
    baseline.entityFlags,
    `${latchPath}.lifecycle.entityFlags`,
  );
  requireExact(
    latchCamera.flags,
    baseline.cameraFlags,
    `${latchPath}.camera.flags`,
  );

  const hostPublication = projectPublication(
    latch.hostPublication,
    `${latchPath}.hostPublication`,
    publication,
    preReport,
    cycle,
  );
  requireExact(
    requirePositiveInteger(
      latch.controllerAppliedSequence,
      `${latchPath}.controllerAppliedSequence`,
    ),
    hostPublication.sequence,
    `${latchPath}.controllerAppliedSequence`,
  );

  if (post.inputFrame < latchInputFrame || post.updateFrame <= latchUpdateFrame) {
    fail(
      "$.postReport.guestGame.manager.updateFrame",
      `expected an update frame after retained receipt ${latchUpdateFrame}`,
    );
  }
  if (post.updateFrame <= baseline.updateFrame) {
    fail(
      "$.postReport.guestGame.manager.updateFrame",
      `expected an update frame after baseline ${baseline.updateFrame}`,
    );
  }
  const forwardDeltaSquared = vectorDeltaSquared(
    baseline.forward,
    post.forward,
  );
  const forwardDelta = Math.sqrt(forwardDeltaSquared);
  if (!Number.isFinite(forwardDelta) || forwardDelta <= MINIMUM_FORWARD_DELTA) {
    fail(
      "$.postReport.guestGame.player.transform.forward",
      `expected a durable forward-vector delta greater than ${MINIMUM_FORWARD_DELTA}`,
    );
  }

  return Object.freeze({
    kind: "metroid-prime-frigate-left-turn-v1",
    cycle,
    manager: hexU32(MANAGER),
    player: hexU32(PLAYER),
    world: hexU32(post.worldAddress),
    worldAssetId: WORLD_ASSET_ID,
    area: 0,
    baseline: Object.freeze({
      cycle: preReport.cycles,
      inputFrame: baseline.inputFrame,
      updateFrame: baseline.updateFrame,
      position: baseline.position,
      forward: baseline.forward,
      up: baseline.up,
      input: Object.freeze({
        time: baseline.input.time,
        controllerIndex: baseline.input.controllerIndex,
        leftX: baseline.input.leftX,
        leftY: baseline.input.leftY,
        rightX: baseline.input.rightX,
        rightY: baseline.input.rightY,
        leftTrigger: baseline.input.leftTrigger,
        rightTrigger: baseline.input.rightTrigger,
        buttons1: baseline.input.buttons1,
        buttons2: baseline.input.buttons2,
        buttons3: baseline.input.buttons3,
        neutral: baseline.input.neutral,
      }),
    }),
    receipt: Object.freeze({
      inputFrame: latchInputFrame,
      updateFrame: latchUpdateFrame,
      position: latchPosition,
      forward: latchForward,
      up: latchUp,
      angularVelocity: latchAngularVelocity,
      torque: latchTorque,
      input: latchInput,
      turn: Object.freeze({
        angularVelocityAlongUp: latchAngularVelocityAlongUp,
        torqueAlongUp: latchTorqueAlongUp,
      }),
    }),
    post: Object.freeze({
      cycle: postReport.cycles,
      inputFrame: post.inputFrame,
      updateFrame: post.updateFrame,
      position: post.position,
      forward: post.forward,
      up: post.up,
      angularVelocity: post.angularVelocity,
      torque: post.torque,
    }),
    turn: Object.freeze({
      frameDelta: post.updateFrame - baseline.updateFrame,
      postLatchFrameDelta: post.updateFrame - latchUpdateFrame,
      forwardDelta,
      forwardDeltaSquared,
    }),
    controllerAppliedSequence: latch.controllerAppliedSequence,
    hostPublication,
  });
}
