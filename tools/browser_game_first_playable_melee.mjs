// SPDX-License-Identifier: GPL-3.0-only

import {
  GameFirstPlayableTranscriptError,
} from "./browser_game_first_playable_transcript_core.mjs";

export const MELEE_FIRST_PLAYABLE_GAME_KEY = "melee-usa-rev-2";

const ROUTING_ADDRESS = 0x80479d30;
const CURRENT_SCENE_INFO_POINTER_ADDRESS = 0x804d6720;
const EXPECTED_SCENE_INFO = 0x803dd9dc;
const EXPECTED_SCENE_LOAD_DATA = 0x80480530;
const EXPECTED_SCENE_LEAVE_DATA = 0x80479d98;
const MATCH_ADDRESS = 0x8046b6a0;
const PAUSE_BITS_ADDRESS = 0x80479d68;
const PLAYER_SLOT_ADDRESS = 0x80453080;
const PLAYER_SLOT_SIZE = 0xe90;
const GAME_PAD_ADDRESS = 0x804c21cc;
const FIGHTER_SIZE = 0x23ec;
const WAIT_MOTION_ID = 14;
const GROUND_LOCOMOTION_MOTION_IDS = Object.freeze([
  15, // WalkSlow
  16, // WalkMiddle
  17, // WalkFast
  18, // Turn
  19, // TurnRun
  20, // Dash
  21, // Run
  22, // RunDirect
  23, // RunBrake
]);
const LEFT_HOST_BUTTONS = 0x0001;
const LEFT_GAME_BUTTONS = 0x00040001;
const LEFT_RAW_STICK_X = -80;
const MINIMUM_MOVEMENT_SQUARED = 1e-4;
const HEX_U32_PATTERN = /^0x[0-9a-f]{8}$/;
const VECTOR_FIELDS = Object.freeze(["x", "y", "z"]);
const PUBLICATION_FIELDS = Object.freeze([
  "source",
  "pollIndex",
  "scheduledCycle",
  "observedCycle",
  "buttons",
  "sequence",
]);
const LATCH_FIELDS = Object.freeze([
  "cycle",
  "controllerAppliedSequence",
  "hostPublication",
  "matchFrame",
  "transformedIndex",
  "joystickDirectionCount",
  "entity",
  "fighter",
  "motionId",
  "position",
  "pad",
  "fighterInput",
]);
const LATCH_PAD_FIELDS = Object.freeze([
  "buttons",
  "trigger",
  "rawStickX",
  "rawStickY",
  "normalizedStickX",
  "normalizedStickY",
  "error",
]);
const LATCH_FIGHTER_INPUT_FIELDS = Object.freeze([
  "leftStickX",
  "leftStickY",
  "heldInputs",
  "pressedInputs",
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

function requireArray(value, path, length) {
  if (!Array.isArray(value) || value.length !== length) {
    fail(path, `expected an array of length ${length}`);
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

function requireSafeInteger(value, path) {
  if (!Number.isSafeInteger(value)) {
    fail(path, "expected a safe integer");
  }
  return value;
}

function requireNonNegativeInteger(value, path) {
  const integer = requireSafeInteger(value, path);
  if (integer < 0) fail(path, "expected a non-negative safe integer");
  return integer;
}

function requirePositiveInteger(value, path) {
  const integer = requireNonNegativeInteger(value, path);
  if (integer === 0) fail(path, "expected a positive integer");
  return integer;
}

function requireIntegerRange(value, minimum, maximum, path) {
  const integer = requireSafeInteger(value, path);
  if (integer < minimum || integer > maximum) {
    fail(path, `expected an integer from ${minimum} through ${maximum}`);
  }
  return integer;
}

function requireU32(value, path) {
  return requireIntegerRange(value, 0, 0xffffffff, path);
}

function requireFinite(value, path) {
  if (!Number.isFinite(value)) fail(path, "expected a finite number");
  return value;
}

function requireFiniteRange(value, minimum, maximum, path) {
  const finite = requireFinite(value, path);
  if (finite < minimum || finite > maximum) {
    fail(path, `expected a value from ${minimum} through ${maximum}`);
  }
  return finite;
}

function requireHexU32(value, path) {
  if (typeof value !== "string" || !HEX_U32_PATTERN.test(value)) {
    fail(path, "expected a lowercase eight-digit hexadecimal u32");
  }
  return Number.parseInt(value.slice(2), 16);
}

function requireMappedMem1(value, path, length = 1, aligned = false) {
  const address = requireHexU32(value, path);
  if (
    !Number.isSafeInteger(length)
    || length < 1
    || address < 0x80000000
    || address > 0x81800000 - length
  ) {
    fail(path, "expected a mapped MEM1 address");
  }
  if (aligned && (address & 3) !== 0) {
    fail(path, "expected a four-byte-aligned MEM1 address");
  }
  return address;
}

function hexU32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function requireVector(value, path) {
  const vector = requireExactKeys(value, VECTOR_FIELDS, path);
  return Object.freeze({
    x: requireFinite(vector.x, `${path}.x`),
    y: requireFinite(vector.y, `${path}.y`),
    z: requireFinite(vector.z, `${path}.z`),
  });
}

function requireSameVector(left, right, path) {
  for (const field of VECTOR_FIELDS) {
    requireExact(right[field], left[field], `${path}.${field}`);
  }
}

function projectRouting(guest, guestPath) {
  const path = `${guestPath}.routing`;
  const routing = requireObject(guest.routing, path);
  requireExact(routing.address, hexU32(ROUTING_ADDRESS), `${path}.address`);
  requireExact(
    routing.currentModeAddress,
    hexU32(ROUTING_ADDRESS),
    `${path}.currentModeAddress`,
  );
  requireExact(routing.currentMode, 2, `${path}.currentMode`);
  requireExact(
    routing.currentSceneIndexAddress,
    hexU32(ROUTING_ADDRESS + 3),
    `${path}.currentSceneIndexAddress`,
  );
  requireExact(routing.currentSceneIndex, 2, `${path}.currentSceneIndex`);
  requireExact(
    routing.pendingAddress,
    hexU32(ROUTING_ADDRESS + 0x0c),
    `${path}.pendingAddress`,
  );
  requireExact(routing.pending, 0, `${path}.pending`);
  requireExact(
    routing.currentSceneInfoPointerAddress,
    hexU32(CURRENT_SCENE_INFO_POINTER_ADDRESS),
    `${path}.currentSceneInfoPointerAddress`,
  );
  requireExact(
    routing.currentSceneInfo,
    hexU32(EXPECTED_SCENE_INFO),
    `${path}.currentSceneInfo`,
  );
  requireExact(
    routing.expectedSceneInfo,
    hexU32(EXPECTED_SCENE_INFO),
    `${path}.expectedSceneInfo`,
  );
  requireExact(
    routing.currentSceneClassAddress,
    hexU32(EXPECTED_SCENE_INFO),
    `${path}.currentSceneClassAddress`,
  );
  requireExact(routing.currentSceneClass, 2, `${path}.currentSceneClass`);
  requireExact(
    routing.currentSceneLoadDataAddress,
    hexU32(EXPECTED_SCENE_INFO + 4),
    `${path}.currentSceneLoadDataAddress`,
  );
  requireExact(
    routing.currentSceneLoadData,
    hexU32(EXPECTED_SCENE_LOAD_DATA),
    `${path}.currentSceneLoadData`,
  );
  requireExact(
    routing.currentSceneLeaveDataAddress,
    hexU32(EXPECTED_SCENE_INFO + 8),
    `${path}.currentSceneLeaveDataAddress`,
  );
  requireExact(
    routing.currentSceneLeaveData,
    hexU32(EXPECTED_SCENE_LEAVE_DATA),
    `${path}.currentSceneLeaveData`,
  );
  requireExact(routing.exactSceneInfo, true, `${path}.exactSceneInfo`);
  requireExact(routing.versusMatchScene, true, `${path}.versusMatchScene`);
}

function projectMatch(guest, guestPath) {
  const path = `${guestPath}.match`;
  const match = requireObject(guest.match, path);
  requireExact(match.address, hexU32(MATCH_ADDRESS), `${path}.address`);
  for (const [field, offset, expected] of [
    ["state", 0, 0],
    ["pauseTimer", 2, 0],
    ["unpauseTimer", 4, 0],
    ["hudEnabled", 5, 1],
    ["terminateMatch", 6, 0],
    ["singlePlayer", 7, 0],
    ["matchResult", 8, 0],
    ["matchOver", 0x0e, 0],
    ["playerMatchSlotType", 0x3a, 0],
    ["playerRespawnTimer", 0x42, 0],
  ]) {
    requireExact(
      match[`${field}Address`],
      hexU32(MATCH_ADDRESS + offset),
      `${path}.${field}Address`,
    );
    requireExact(match[field], expected, `${path}.${field}`);
  }
  requireExact(
    match.frameCountAddress,
    hexU32(MATCH_ADDRESS + 0x24),
    `${path}.frameCountAddress`,
  );
  const frameCount = requirePositiveInteger(
    match.frameCount,
    `${path}.frameCount`,
  );
  requireExact(
    match.pauseBitsAddress,
    hexU32(PAUSE_BITS_ADDRESS),
    `${path}.pauseBitsAddress`,
  );
  requireExact(match.pauseBits, 0, `${path}.pauseBits`);
  requireExact(match.inProgress, true, `${path}.inProgress`);
  return frameCount;
}

function projectPlayerSlot(guest, guestPath) {
  const path = `${guestPath}.playerSlot`;
  const slot = requireObject(guest.playerSlot, path);
  requireExact(slot.address, hexU32(PLAYER_SLOT_ADDRESS), `${path}.address`);
  requireExact(slot.size, PLAYER_SLOT_SIZE, `${path}.size`);
  requireExact(
    slot.stateAddress,
    hexU32(PLAYER_SLOT_ADDRESS),
    `${path}.stateAddress`,
  );
  requireExact(slot.state, 2, `${path}.state`);
  requireExact(
    slot.characterAddress,
    hexU32(PLAYER_SLOT_ADDRESS + 4),
    `${path}.characterAddress`,
  );
  const character = requireIntegerRange(
    slot.character,
    0,
    0x19,
    `${path}.character`,
  );
  requireExact(
    slot.slotTypeAddress,
    hexU32(PLAYER_SLOT_ADDRESS + 8),
    `${path}.slotTypeAddress`,
  );
  requireExact(slot.slotType, 0, `${path}.slotType`);
  requireExact(
    slot.transformedIndexAddress,
    hexU32(PLAYER_SLOT_ADDRESS + 0x0c),
    `${path}.transformedIndexAddress`,
  );
  const transformedIndex = requireIntegerRange(
    slot.transformedIndex,
    0,
    1,
    `${path}.transformedIndex`,
  );
  requireExact(
    slot.subColorAddress,
    hexU32(PLAYER_SLOT_ADDRESS + 0x46),
    `${path}.subColorAddress`,
  );
  const subColor = requireIntegerRange(
    slot.subColor,
    0,
    4,
    `${path}.subColor`,
  );
  requireExact(
    slot.playerIdAddress,
    hexU32(PLAYER_SLOT_ADDRESS + 0x48),
    `${path}.playerIdAddress`,
  );
  requireExact(slot.playerId, 0, `${path}.playerId`);
  requireExact(
    slot.stocksAddress,
    hexU32(PLAYER_SLOT_ADDRESS + 0x8e),
    `${path}.stocksAddress`,
  );
  const stocks = requireIntegerRange(slot.stocks, 1, 0x7f, `${path}.stocks`);
  requireExact(
    slot.joystickDirectionCountAddress,
    hexU32(PLAYER_SLOT_ADDRESS + 0xa0 + transformedIndex * 4),
    `${path}.joystickDirectionCountAddress`,
  );
  const joystickDirectionCount = requireNonNegativeInteger(
    slot.joystickDirectionCount,
    `${path}.joystickDirectionCount`,
  );
  requireExact(slot.playable, true, `${path}.playable`);
  return Object.freeze({
    character,
    joystickDirectionCount,
    stocks,
    subColor,
    transformedIndex,
  });
}

function projectOpponents(guest, guestPath) {
  const path = `${guestPath}.opponents`;
  const opponents = requireArray(guest.opponents, path, 3);
  let computedHasOpponent = false;
  for (let index = 0; index < opponents.length; index += 1) {
    const opponentPath = `${path}[${index}]`;
    const opponent = requireObject(opponents[index], opponentPath);
    const slot = index + 1;
    const address = PLAYER_SLOT_ADDRESS + slot * PLAYER_SLOT_SIZE;
    requireExact(opponent.slot, slot, `${opponentPath}.slot`);
    requireExact(
      opponent.address,
      hexU32(address),
      `${opponentPath}.address`,
    );
    requireExact(
      opponent.stateAddress,
      hexU32(address),
      `${opponentPath}.stateAddress`,
    );
    const state = requireSafeInteger(
      opponent.state,
      `${opponentPath}.state`,
    );
    requireExact(
      opponent.slotTypeAddress,
      hexU32(address + 8),
      `${opponentPath}.slotTypeAddress`,
    );
    const slotType = requireSafeInteger(
      opponent.slotType,
      `${opponentPath}.slotType`,
    );
    const active = state === 2 && (slotType === 0 || slotType === 1);
    requireExact(opponent.active, active, `${opponentPath}.active`);
    computedHasOpponent ||= active;
  }
  requireExact(guest.hasOpponent, true, `${guestPath}.hasOpponent`);
  requireExact(computedHasOpponent, true, path);
}

function projectFighterLookup(guest, guestPath, transformedIndex) {
  const path = `${guestPath}.fighterLookup`;
  const lookup = requireObject(guest.fighterLookup, path);
  const entityPointerAddress =
    PLAYER_SLOT_ADDRESS + 0xb0 + transformedIndex * 4;
  requireExact(
    lookup.entityPointerAddress,
    hexU32(entityPointerAddress),
    `${path}.entityPointerAddress`,
  );
  const entity = requireMappedMem1(
    lookup.entity,
    `${path}.entity`,
    0x38,
    true,
  );
  requireExact(
    lookup.classifierAddress,
    hexU32(entity),
    `${path}.classifierAddress`,
  );
  requireExact(lookup.classifier, 4, `${path}.classifier`);
  requireExact(
    lookup.processLinkAddress,
    hexU32(entity + 2),
    `${path}.processLinkAddress`,
  );
  requireExact(lookup.processLink, 8, `${path}.processLink`);
  requireExact(
    lookup.processPriorityAddress,
    hexU32(entity + 4),
    `${path}.processPriorityAddress`,
  );
  requireExact(lookup.processPriority, 0, `${path}.processPriority`);
  requireExact(
    lookup.userDataKindAddress,
    hexU32(entity + 7),
    `${path}.userDataKindAddress`,
  );
  requireExact(lookup.userDataKind, 4, `${path}.userDataKind`);
  requireExact(
    lookup.fighterPointerAddress,
    hexU32(entity + 0x2c),
    `${path}.fighterPointerAddress`,
  );
  const fighter = requireMappedMem1(
    lookup.fighter,
    `${path}.fighter`,
    FIGHTER_SIZE,
    true,
  );
  return Object.freeze({ entity, fighter });
}

function projectFighter(
  guest,
  guestPath,
  lookup,
  playerSlot,
  requireNeutralWait,
) {
  const path = `${guestPath}.fighter`;
  const fighter = requireObject(guest.fighter, path);
  const address = requireMappedMem1(
    fighter.address,
    `${path}.address`,
    FIGHTER_SIZE,
    true,
  );
  requireExact(address, lookup.fighter, `${path}.address`);
  requireExact(fighter.size, FIGHTER_SIZE, `${path}.size`);
  requireExact(
    fighter.gobjAddress,
    hexU32(address),
    `${path}.gobjAddress`,
  );
  requireExact(fighter.gobj, hexU32(lookup.entity), `${path}.gobj`);
  requireExact(
    fighter.kindAddress,
    hexU32(address + 4),
    `${path}.kindAddress`,
  );
  const kind = requireIntegerRange(fighter.kind, 0, 0x20, `${path}.kind`);
  requireExact(
    fighter.playerIdAddress,
    hexU32(address + 0x0c),
    `${path}.playerIdAddress`,
  );
  requireExact(fighter.playerId, 0, `${path}.playerId`);
  requireExact(
    fighter.motionIdAddress,
    hexU32(address + 0x10),
    `${path}.motionIdAddress`,
  );
  const motionId = requireSafeInteger(fighter.motionId, `${path}.motionId`);
  if (motionId <= 10) fail(`${path}.motionId`, "expected a live motion state");
  requireExact(fighter.aliveMotion, true, `${path}.aliveMotion`);
  if (requireNeutralWait) {
    requireExact(motionId, WAIT_MOTION_ID, `${path}.motionId`);
  }
  requireExact(
    fighter.facingDirectionAddress,
    hexU32(address + 0x2c),
    `${path}.facingDirectionAddress`,
  );
  const facingDirection = requireFinite(
    fighter.facingDirection,
    `${path}.facingDirection`,
  );
  if (facingDirection !== -1 && facingDirection !== 1) {
    fail(`${path}.facingDirection`, "expected an exact left or right facing");
  }
  requireExact(
    fighter.positionAddress,
    hexU32(address + 0xb0),
    `${path}.positionAddress`,
  );
  const position = requireVector(fighter.position, `${path}.position`);
  requireExact(
    fighter.previousPositionAddress,
    hexU32(address + 0xbc),
    `${path}.previousPositionAddress`,
  );
  const previousPosition = requireVector(
    fighter.previousPosition,
    `${path}.previousPosition`,
  );
  requireExact(
    fighter.groundOrAirAddress,
    hexU32(address + 0xe0),
    `${path}.groundOrAirAddress`,
  );
  requireExact(fighter.groundOrAir, 0, `${path}.groundOrAir`);
  requireExact(
    fighter.selfVelocityXAddress,
    hexU32(address + 0x80),
    `${path}.selfVelocityXAddress`,
  );
  const selfVelocityX = requireFinite(
    fighter.selfVelocityX,
    `${path}.selfVelocityX`,
  );
  requireExact(
    fighter.positionDeltaXAddress,
    hexU32(address + 0xc8),
    `${path}.positionDeltaXAddress`,
  );
  const positionDeltaX = requireFinite(
    fighter.positionDeltaX,
    `${path}.positionDeltaX`,
  );
  requireExact(
    fighter.padPlayerIdAddress,
    hexU32(address + 0x618),
    `${path}.padPlayerIdAddress`,
  );
  requireExact(fighter.padPlayerId, 0, `${path}.padPlayerId`);
  requireExact(
    fighter.subColorAddress,
    hexU32(address + 0x61a),
    `${path}.subColorAddress`,
  );
  requireExact(
    fighter.subColor,
    playerSlot.subColor,
    `${path}.subColor`,
  );

  const inputPath = `${path}.input`;
  const input = requireObject(fighter.input, inputPath);
  const inputFields = [
    ["leftStickX", 0x620, "finite"],
    ["leftStickY", 0x624, "finite"],
    ["previousLeftStickX", 0x628, "finite"],
    ["previousLeftStickY", 0x62c, "finite"],
    ["heldInputs", 0x65c, "u32"],
    ["pressedInputs", 0x668, "u32"],
    ["releasedInputs", 0x66c, "u32"],
  ];
  const inputValues = {};
  for (const [field, offset, type] of inputFields) {
    requireExact(
      input[`${field}Address`],
      hexU32(address + offset),
      `${inputPath}.${field}Address`,
    );
    inputValues[field] = type === "u32"
      ? requireU32(input[field], `${inputPath}.${field}`)
      : requireFinite(input[field], `${inputPath}.${field}`);
  }
  requireExact(fighter.valid, true, `${path}.valid`);

  if (requireNeutralWait) {
    requireSameVector(position, previousPosition, `${path}.previousPosition`);
    requireExact(selfVelocityX, 0, `${path}.selfVelocityX`);
    requireExact(positionDeltaX, 0, `${path}.positionDeltaX`);
    for (const field of [
      "leftStickX",
      "leftStickY",
      "previousLeftStickX",
      "previousLeftStickY",
      "heldInputs",
      "pressedInputs",
      "releasedInputs",
    ]) {
      requireExact(inputValues[field], 0, `${inputPath}.${field}`);
    }
  }

  return Object.freeze({
    address,
    facingDirection,
    input: Object.freeze(inputValues),
    kind,
    motionId,
    position,
    positionDeltaX,
    previousPosition,
    selfVelocityX,
  });
}

function projectPad(guest, guestPath) {
  const path = `${guestPath}.pad`;
  const pad = requireObject(guest.pad, path);
  requireExact(pad.address, hexU32(GAME_PAD_ADDRESS), `${path}.address`);
  requireExact(
    pad.buttonsAddress,
    hexU32(GAME_PAD_ADDRESS),
    `${path}.buttonsAddress`,
  );
  const buttons = requireU32(pad.buttons, `${path}.buttons`);
  requireExact(
    pad.triggerAddress,
    hexU32(GAME_PAD_ADDRESS + 8),
    `${path}.triggerAddress`,
  );
  const trigger = requireU32(pad.trigger, `${path}.trigger`);
  requireExact(
    pad.rawStickXAddress,
    hexU32(GAME_PAD_ADDRESS + 0x18),
    `${path}.rawStickXAddress`,
  );
  const rawStickX = requireIntegerRange(
    pad.rawStickX,
    -128,
    127,
    `${path}.rawStickX`,
  );
  requireExact(
    pad.rawStickYAddress,
    hexU32(GAME_PAD_ADDRESS + 0x19),
    `${path}.rawStickYAddress`,
  );
  const rawStickY = requireIntegerRange(
    pad.rawStickY,
    -128,
    127,
    `${path}.rawStickY`,
  );
  requireExact(
    pad.normalizedStickXAddress,
    hexU32(GAME_PAD_ADDRESS + 0x20),
    `${path}.normalizedStickXAddress`,
  );
  const normalizedStickX = requireFiniteRange(
    pad.normalizedStickX,
    -1.001,
    1.001,
    `${path}.normalizedStickX`,
  );
  requireExact(
    pad.normalizedStickYAddress,
    hexU32(GAME_PAD_ADDRESS + 0x24),
    `${path}.normalizedStickYAddress`,
  );
  const normalizedStickY = requireFiniteRange(
    pad.normalizedStickY,
    -1.001,
    1.001,
    `${path}.normalizedStickY`,
  );
  requireExact(
    pad.errorAddress,
    hexU32(GAME_PAD_ADDRESS + 0x41),
    `${path}.errorAddress`,
  );
  requireExact(pad.error, 0, `${path}.error`);
  return Object.freeze({
    buttons,
    normalizedStickX,
    normalizedStickY,
    rawStickX,
    rawStickY,
    trigger,
  });
}

function projectMeleeState(report, path, requireNeutralWait) {
  const guestPath = `${path}.guestGame`;
  const guest = requireObject(report.guestGame, guestPath);
  projectRouting(guest, guestPath);
  const frameCount = projectMatch(guest, guestPath);
  const playerSlot = projectPlayerSlot(guest, guestPath);
  projectOpponents(guest, guestPath);
  const lookup = projectFighterLookup(
    guest,
    guestPath,
    playerSlot.transformedIndex,
  );
  const fighter = projectFighter(
    guest,
    guestPath,
    lookup,
    playerSlot,
    requireNeutralWait,
  );
  const pad = projectPad(guest, guestPath);

  requireExact(guest.controlsEnabled, true, `${guestPath}.controlsEnabled`);
  requireExact(guest.activeMatch, true, `${guestPath}.activeMatch`);
  if (typeof guest.neutralInput !== "boolean") {
    fail(`${guestPath}.neutralInput`, "expected a boolean");
  }
  const neutralInput = pad.buttons === 0
    && pad.trigger === 0
    && pad.rawStickX === 0
    && pad.rawStickY === 0
    && pad.normalizedStickX === 0
    && pad.normalizedStickY === 0
    && fighter.input.leftStickX === 0
    && fighter.input.leftStickY === 0
    && fighter.input.heldInputs === 0
    && fighter.input.pressedInputs === 0;
  requireExact(guest.neutralInput, neutralInput, `${guestPath}.neutralInput`);
  if (requireNeutralWait) {
    requireExact(guest.neutralInput, true, `${guestPath}.neutralInput`);
  }

  return Object.freeze({
    fighter,
    frameCount,
    guest,
    lookup,
    pad,
    playerSlot,
  });
}

function projectReceipt(
  latch,
  latchPath,
  baseline,
  post,
  preReport,
  postReport,
  publication,
) {
  const cycle = requireNonNegativeInteger(latch.cycle, `${latchPath}.cycle`);
  if (cycle < preReport.cycles || cycle > postReport.cycles) {
    fail(
      `${latchPath}.cycle`,
      `expected a value from ${preReport.cycles} through ${postReport.cycles}`,
    );
  }
  requireExact(
    latch.transformedIndex,
    baseline.playerSlot.transformedIndex,
    `${latchPath}.transformedIndex`,
  );
  requireExact(
    latch.entity,
    hexU32(baseline.lookup.entity),
    `${latchPath}.entity`,
  );
  requireExact(
    latch.fighter,
    hexU32(baseline.fighter.address),
    `${latchPath}.fighter`,
  );

  const matchFrame = requirePositiveInteger(
    latch.matchFrame,
    `${latchPath}.matchFrame`,
  );
  if (
    matchFrame < baseline.frameCount
    || matchFrame > post.frameCount
  ) {
    fail(
      `${latchPath}.matchFrame`,
      `expected a value from ${baseline.frameCount} through ${post.frameCount}`,
    );
  }

  const joystickDirectionCount = requireNonNegativeInteger(
    latch.joystickDirectionCount,
    `${latchPath}.joystickDirectionCount`,
  );
  const baselineDirectionCount = baseline.playerSlot.joystickDirectionCount;
  if (
    joystickDirectionCount !== baselineDirectionCount
    && joystickDirectionCount !== baselineDirectionCount + 1
  ) {
    fail(
      `${latchPath}.joystickDirectionCount`,
      `expected ${baselineDirectionCount} or ${baselineDirectionCount + 1}`,
    );
  }

  const motionId = requireSafeInteger(
    latch.motionId,
    `${latchPath}.motionId`,
  );
  if (motionId <= 10) {
    fail(`${latchPath}.motionId`, "expected a live fighter motion state");
  }
  if (
    motionId !== WAIT_MOTION_ID
    && !GROUND_LOCOMOTION_MOTION_IDS.includes(motionId)
  ) {
    fail(
      `${latchPath}.motionId`,
      "expected Wait or a grounded controllable locomotion state",
    );
  }
  const position = requireVector(latch.position, `${latchPath}.position`);

  const padPath = `${latchPath}.pad`;
  const pad = requireExactKeys(latch.pad, LATCH_PAD_FIELDS, padPath);
  requireExact(pad.buttons, LEFT_GAME_BUTTONS, `${padPath}.buttons`);
  const padTrigger = requireExact(
    pad.trigger,
    LEFT_GAME_BUTTONS,
    `${padPath}.trigger`,
  );
  requireExact(pad.rawStickX, LEFT_RAW_STICK_X, `${padPath}.rawStickX`);
  requireExact(pad.rawStickY, 0, `${padPath}.rawStickY`);
  requireExact(pad.normalizedStickX, -1, `${padPath}.normalizedStickX`);
  requireExact(pad.normalizedStickY, 0, `${padPath}.normalizedStickY`);
  requireExact(pad.error, 0, `${padPath}.error`);

  const fighterInputPath = `${latchPath}.fighterInput`;
  const fighterInput = requireExactKeys(
    latch.fighterInput,
    LATCH_FIGHTER_INPUT_FIELDS,
    fighterInputPath,
  );
  const leftStickX = requireExact(
    fighterInput.leftStickX,
    -1,
    `${fighterInputPath}.leftStickX`,
  );
  requireExact(
    fighterInput.leftStickY,
    0,
    `${fighterInputPath}.leftStickY`,
  );
  requireExact(
    fighterInput.heldInputs,
    LEFT_GAME_BUTTONS,
    `${fighterInputPath}.heldInputs`,
  );
  const pressedInputs = requireExact(
    fighterInput.pressedInputs,
    LEFT_GAME_BUTTONS,
    `${fighterInputPath}.pressedInputs`,
  );

  const publicationPath = `${latchPath}.hostPublication`;
  const hostPublication = requireExactKeys(
    latch.hostPublication,
    PUBLICATION_FIELDS,
    publicationPath,
  );
  if (
    hostPublication.source !== "periodic"
    && hostPublication.source !== "direct"
  ) {
    fail(`${publicationPath}.source`, "expected periodic or direct");
  }
  const hostPollIndex = requirePositiveInteger(
    hostPublication.pollIndex,
    `${publicationPath}.pollIndex`,
  );
  const hostScheduledCycle = requireNonNegativeInteger(
    hostPublication.scheduledCycle,
    `${publicationPath}.scheduledCycle`,
  );
  const hostObservedCycle = requireNonNegativeInteger(
    hostPublication.observedCycle,
    `${publicationPath}.observedCycle`,
  );
  requireExact(
    hostPublication.buttons,
    LEFT_HOST_BUTTONS,
    `${publicationPath}.buttons`,
  );
  const hostSequence = requirePositiveInteger(
    hostPublication.sequence,
    `${publicationPath}.sequence`,
  );
  if (
    hostScheduledCycle < preReport.cycles
    || hostScheduledCycle > hostObservedCycle
    || hostObservedCycle > cycle
  ) {
    fail(
      publicationPath,
      `expected publication between baseline cycle ${preReport.cycles} and latch cycle ${cycle}`,
    );
  }
  if (hostPollIndex <= preReport.controller.pollIndex) {
    fail(
      `${publicationPath}.pollIndex`,
      `expected a value greater than ${preReport.controller.pollIndex}`,
    );
  }
  const controllerAppliedSequence = requirePositiveInteger(
    latch.controllerAppliedSequence,
    `${latchPath}.controllerAppliedSequence`,
  );
  requireExact(
    controllerAppliedSequence,
    hostSequence,
    `${latchPath}.controllerAppliedSequence`,
  );
  requireExact(
    hostSequence,
    publication.sequence,
    `${publicationPath}.sequence`,
  );
  if (
    hostPollIndex > publication.pollIndex
    || hostScheduledCycle > publication.scheduledCycle
    || hostObservedCycle > publication.observedCycle
  ) {
    fail(
      publicationPath,
      "guest latch publication cannot follow the terminal active publication",
    );
  }

  return Object.freeze({
    controllerAppliedSequence,
    cycle,
    fighterInput: Object.freeze({
      heldInputs: fighterInput.heldInputs,
      leftStickX,
      leftStickY: fighterInput.leftStickY,
      pressedInputs,
    }),
    hostPublication: Object.freeze({
      buttons: hostPublication.buttons,
      observedCycle: hostObservedCycle,
      pollIndex: hostPollIndex,
      scheduledCycle: hostScheduledCycle,
      sequence: hostSequence,
      source: hostPublication.source,
    }),
    joystickDirectionCount,
    matchFrame,
    motionId,
    pad: Object.freeze({
      buttons: pad.buttons,
      error: pad.error,
      normalizedStickX: pad.normalizedStickX,
      normalizedStickY: pad.normalizedStickY,
      rawStickX: pad.rawStickX,
      rawStickY: pad.rawStickY,
      trigger: padTrigger,
    }),
    position,
  });
}

export function projectMeleeGuestConsumption({
  button,
  game,
  postReport,
  preReport,
  publication,
}) {
  if (game.key !== MELEE_FIRST_PLAYABLE_GAME_KEY) return null;
  requireExact(button, "left", "$.button");
  const disc = requireObject(game.disc, "$.game.disc");
  requireExact(disc.identifier, "GALE01", "$.game.disc.identifier");
  requireExact(disc.revision, 2, "$.game.disc.revision");

  const preCycle = requirePositiveInteger(preReport.cycles, "$.preReport.cycles");
  const postCycle = requirePositiveInteger(
    postReport.cycles,
    "$.postReport.cycles",
  );
  if (postCycle <= preCycle) {
    fail("$.postReport.cycles", `expected a value greater than ${preCycle}`);
  }

  const baseline = projectMeleeState(preReport, "$.preReport", true);
  requireExact(
    baseline.guest.lastActiveGameplayInput,
    null,
    "$.preReport.guestGame.lastActiveGameplayInput",
  );
  const post = projectMeleeState(postReport, "$.postReport", false);

  requireExact(
    post.lookup.entity,
    baseline.lookup.entity,
    "$.postReport.guestGame.fighterLookup.entity",
  );
  requireExact(
    post.fighter.address,
    baseline.fighter.address,
    "$.postReport.guestGame.fighter.address",
  );
  for (const [field, path] of [
    ["character", "$.postReport.guestGame.playerSlot.character"],
    [
      "transformedIndex",
      "$.postReport.guestGame.playerSlot.transformedIndex",
    ],
    ["subColor", "$.postReport.guestGame.playerSlot.subColor"],
    ["stocks", "$.postReport.guestGame.playerSlot.stocks"],
  ]) {
    requireExact(
      post.playerSlot[field],
      baseline.playerSlot[field],
      path,
    );
  }
  requireExact(
    post.fighter.kind,
    baseline.fighter.kind,
    "$.postReport.guestGame.fighter.kind",
  );
  if (!GROUND_LOCOMOTION_MOTION_IDS.includes(post.fighter.motionId)) {
    fail(
      "$.postReport.guestGame.fighter.motionId",
      "expected a grounded controllable locomotion state",
    );
  }
  if (post.frameCount <= baseline.frameCount) {
    fail(
      "$.postReport.guestGame.match.frameCount",
      `expected a value greater than ${baseline.frameCount}`,
    );
  }
  requireExact(
    post.playerSlot.joystickDirectionCount,
    baseline.playerSlot.joystickDirectionCount + 1,
    "$.postReport.guestGame.playerSlot.joystickDirectionCount",
  );

  const latchPath = "$.postReport.guestGame.lastActiveGameplayInput";
  const latch = requireExactKeys(
    post.guest.lastActiveGameplayInput,
    LATCH_FIELDS,
    latchPath,
  );
  const receipt = projectReceipt(
    latch,
    latchPath,
    baseline,
    post,
    preReport,
    postReport,
    publication,
  );

  requireExact(
    receipt.position.y,
    baseline.fighter.position.y,
    `${latchPath}.position.y`,
  );
  requireExact(
    receipt.position.z,
    baseline.fighter.position.z,
    `${latchPath}.position.z`,
  );
  if (receipt.position.x > baseline.fighter.position.x) {
    fail(
      `${latchPath}.position.x`,
      "receipt position must not move right of the neutral baseline",
    );
  }
  requireExact(
    post.fighter.position.y,
    receipt.position.y,
    "$.postReport.guestGame.fighter.position.y",
  );
  requireExact(
    post.fighter.position.z,
    receipt.position.z,
    "$.postReport.guestGame.fighter.position.z",
  );
  const baselineLeftwardX =
    baseline.fighter.position.x - post.fighter.position.x;
  const postLatchLeftwardX = receipt.position.x - post.fighter.position.x;
  const horizontalDistanceSquared = baselineLeftwardX * baselineLeftwardX;
  const postLatchHorizontalDistanceSquared =
    postLatchLeftwardX * postLatchLeftwardX;
  if (
    baselineLeftwardX <= 0
    || horizontalDistanceSquared <= MINIMUM_MOVEMENT_SQUARED
  ) {
    fail(
      "$.postReport.guestGame.fighter.position.x",
      "expected strictly leftward X movement from the neutral baseline",
    );
  }
  if (
    postLatchLeftwardX <= 0
    || postLatchHorizontalDistanceSquared <= MINIMUM_MOVEMENT_SQUARED
  ) {
    fail(
      "$.postReport.guestGame.fighter.position.x",
      "expected strictly leftward X movement after the retained receipt",
    );
  }
  requireExact(
    post.fighter.previousPosition.y,
    post.fighter.position.y,
    "$.postReport.guestGame.fighter.previousPosition.y",
  );
  requireExact(
    post.fighter.previousPosition.z,
    post.fighter.position.z,
    "$.postReport.guestGame.fighter.previousPosition.z",
  );
  const terminalFrameLeftwardX =
    post.fighter.previousPosition.x - post.fighter.position.x;
  const terminalFrameHorizontalDistanceSquared =
    terminalFrameLeftwardX * terminalFrameLeftwardX;
  if (
    terminalFrameLeftwardX <= 0
    || terminalFrameHorizontalDistanceSquared <= MINIMUM_MOVEMENT_SQUARED
  ) {
    fail(
      "$.postReport.guestGame.fighter.previousPosition.x",
      "expected a strictly leftward terminal-frame position delta",
    );
  }
  if (post.fighter.selfVelocityX >= 0) {
    fail(
      "$.postReport.guestGame.fighter.selfVelocityX",
      "expected leftward self velocity",
    );
  }
  if (post.fighter.positionDeltaX >= 0) {
    fail(
      "$.postReport.guestGame.fighter.positionDeltaX",
      "expected a leftward Fighter position delta",
    );
  }

  return Object.freeze({
    kind: "melee-active-match-left-v1",
    cycle: receipt.cycle,
    playerSlot: hexU32(PLAYER_SLOT_ADDRESS),
    transformedIndex: baseline.playerSlot.transformedIndex,
    entity: hexU32(post.lookup.entity),
    fighter: hexU32(post.fighter.address),
    baseline: Object.freeze({
      cycle: preCycle,
      joystickDirectionCount:
        baseline.playerSlot.joystickDirectionCount,
      matchFrame: baseline.frameCount,
      motionId: baseline.fighter.motionId,
      position: baseline.fighter.position,
    }),
    receipt: Object.freeze({
      fighterInput: receipt.fighterInput,
      joystickDirectionCount: receipt.joystickDirectionCount,
      matchFrame: receipt.matchFrame,
      motionId: receipt.motionId,
      pad: receipt.pad,
      position: receipt.position,
    }),
    post: Object.freeze({
      cycle: postCycle,
      joystickDirectionCount: post.playerSlot.joystickDirectionCount,
      matchFrame: post.frameCount,
      motionId: post.fighter.motionId,
      position: post.fighter.position,
    }),
    movement: Object.freeze({
      horizontalDistanceSquared,
      postLatchHorizontalDistanceSquared,
      leftwardDistance: baselineLeftwardX,
      postLatchLeftwardDistance: postLatchLeftwardX,
      terminalFrameHorizontalDistanceSquared,
      terminalFrameLeftwardDistance: terminalFrameLeftwardX,
      selfVelocityX: post.fighter.selfVelocityX,
      positionDeltaX: post.fighter.positionDeltaX,
      yDelta: post.fighter.position.y - baseline.fighter.position.y,
      zDelta: post.fighter.position.z - baseline.fighter.position.z,
    }),
    controllerAppliedSequence: receipt.controllerAppliedSequence,
    hostPublication: receipt.hostPublication,
  });
}
