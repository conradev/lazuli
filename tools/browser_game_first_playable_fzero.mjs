// SPDX-License-Identifier: GPL-3.0-only

import {
  GameFirstPlayableTranscriptError,
} from "./browser_game_first_playable_transcript_core.mjs";

export const FZERO_FIRST_PLAYABLE_GAME_KEY = "f-zero-gx-usa";

const REFERENCE_POINTER_ADDRESS = 0x800030c8;
const RACER_POINTER_OFFSET = 0x227878;
const RACER_BLOCK_SIZE = 0x620;
// GFZE01 revision-zero REL 0x83974..0x83a50 selects live player input only
// when both masks are clear and signed racer+0x474 names a controller slot.
const INPUT_DISABLED_MASK = 0x00000080;
const OBJECT_DRIVEN_INPUT_MASK = 0x04000000;
const MINIMUM_MOTION_SQUARED = 1e-4;
const HEX_U32_PATTERN = /^0x[0-9a-f]{8}$/;
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
  "reference",
  "racer",
  "entrantId",
  "machineId",
  "generalState",
  "controllerSlot",
  "frameCountSinceStartOrRestore",
  "position",
  "worldVelocity",
  "input",
  "lifecycle",
]);
const LATCH_INPUT_FIELDS = Object.freeze([
  "steerY",
  "strafe",
  "steerX",
  "duplicateSteerX",
  "accelerator",
  "brake",
]);
const LATCH_LIFECYCLE_FIELDS = Object.freeze([
  "crashBit",
  "restoreCountdown",
  "crashToRestoreFrameCounter",
  "restoreCompletionFlag",
  "breakDownCountdown",
  "postRestoreCountdown",
]);
const VECTOR_FIELDS = Object.freeze(["x", "y", "z"]);

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

function requireVector(value, path) {
  const vector = requireExactKeys(value, VECTOR_FIELDS, path);
  return Object.freeze({
    x: requireFinite(vector.x, `${path}.x`),
    y: requireFinite(vector.y, `${path}.y`),
    z: requireFinite(vector.z, `${path}.z`),
  });
}

function displacementSquared(left, right) {
  const x = right.x - left.x;
  const y = right.y - left.y;
  const z = right.z - left.z;
  return x * x + y * y + z * z;
}

function magnitudeSquared(vector) {
  return vector.x * vector.x
    + vector.y * vector.y
    + vector.z * vector.z;
}

function requireMotion(value, path, label) {
  if (!Number.isFinite(value) || value <= MINIMUM_MOTION_SQUARED) {
    fail(path, `expected ${label}`);
  }
  return value;
}

function projectFzeroInput(input, path, racer) {
  const value = requireObject(input, path);
  requireAddress(
    value.steerYAddress,
    racer + 0x1f4,
    `${path}.steerYAddress`,
  );
  const steerY = requireRange(value.steerY, -1, 1, `${path}.steerY`);
  requireAddress(
    value.strafeAddress,
    racer + 0x1f8,
    `${path}.strafeAddress`,
  );
  const strafe = requireRange(value.strafe, -1, 1, `${path}.strafe`);
  requireAddress(
    value.steerXAddress,
    racer + 0x1fc,
    `${path}.steerXAddress`,
  );
  const steerX = requireRange(value.steerX, -1, 1, `${path}.steerX`);
  requireAddress(
    value.acceleratorAddress,
    racer + 0x200,
    `${path}.acceleratorAddress`,
  );
  const accelerator = requireFinite(
    value.accelerator,
    `${path}.accelerator`,
  );
  requireAddress(
    value.brakeAddress,
    racer + 0x204,
    `${path}.brakeAddress`,
  );
  const brake = requireFinite(value.brake, `${path}.brake`);
  requireAddress(
    value.duplicateSteerXAddress,
    racer + 0x20c,
    `${path}.duplicateSteerXAddress`,
  );
  const duplicateSteerX = requireRange(
    value.duplicateSteerX,
    -1,
    1,
    `${path}.duplicateSteerX`,
  );
  requireExact(
    duplicateSteerX,
    steerX,
    `${path}.duplicateSteerX`,
  );
  requireExact(
    value.duplicateSteerMatches,
    true,
    `${path}.duplicateSteerMatches`,
  );
  requireExact(
    value.documentedRanges,
    true,
    `${path}.documentedRanges`,
  );
  return Object.freeze({
    steerY,
    strafe,
    steerX,
    accelerator,
    brake,
    duplicateSteerX,
  });
}

function projectFzeroLifecycle(lifecycle, path, racer) {
  const value = requireObject(lifecycle, path);
  requireAddress(
    value.restoreCountdownAddress,
    racer + 0x214,
    `${path}.restoreCountdownAddress`,
  );
  const restoreCountdown = requireU16(
    value.restoreCountdown,
    `${path}.restoreCountdown`,
  );
  requireAddress(
    value.controllerSlotAddress,
    racer + 0x474,
    `${path}.controllerSlotAddress`,
  );
  const controllerSlot = requireS8(
    value.controllerSlot,
    `${path}.controllerSlot`,
  );
  requireAddress(
    value.frameCountSinceStartOrRestoreAddress,
    racer + 0x47c,
    `${path}.frameCountSinceStartOrRestoreAddress`,
  );
  const frameCount = requireU32(
    value.frameCountSinceStartOrRestore,
    `${path}.frameCountSinceStartOrRestore`,
  );
  requireAddress(
    value.crashBitAddress,
    racer + 0x4b3,
    `${path}.crashBitAddress`,
  );
  const crashBit = requireU8(value.crashBit, `${path}.crashBit`);
  requireAddress(
    value.generalState2Address,
    racer + 0x58f,
    `${path}.generalState2Address`,
  );
  const generalState2 = requireU8(
    value.generalState2,
    `${path}.generalState2`,
  );
  requireAddress(
    value.restoreCompletionFlagAddress,
    racer + 0x590,
    `${path}.restoreCompletionFlagAddress`,
  );
  const restoreCompletionFlag = requireU8(
    value.restoreCompletionFlag,
    `${path}.restoreCompletionFlag`,
  );
  requireAddress(
    value.breakDownCountdownAddress,
    racer + 0x593,
    `${path}.breakDownCountdownAddress`,
  );
  const breakDownCountdown = requireU8(
    value.breakDownCountdown,
    `${path}.breakDownCountdown`,
  );
  requireAddress(
    value.postRestoreCountdownAddress,
    racer + 0x5d8,
    `${path}.postRestoreCountdownAddress`,
  );
  const postRestoreCountdown = requireU8(
    value.postRestoreCountdown,
    `${path}.postRestoreCountdown`,
  );
  requireAddress(
    value.groundAirFlagAddress,
    racer + 0x61c,
    `${path}.groundAirFlagAddress`,
  );
  const groundAirFlag = requireU8(
    value.groundAirFlag,
    `${path}.groundAirFlag`,
  );
  return Object.freeze({
    restoreCountdown,
    controllerSlot,
    frameCount,
    crashBit,
    generalState2,
    restoreCompletionFlag,
    breakDownCountdown,
    postRestoreCountdown,
    groundAirFlag,
  });
}

function projectFzeroState(report, path, requireNeutralSteering) {
  const guestPath = `${path}.guestGame`;
  const guest = requireObject(report.guestGame, guestPath);

  const referencePath = `${guestPath}.reference`;
  const reference = requireObject(guest.reference, referencePath);
  requireAddress(
    reference.pointerAddress,
    REFERENCE_POINTER_ADDRESS,
    `${referencePath}.pointerAddress`,
  );
  const referenceValue = requireMappedMem1(
    reference.value,
    `${referencePath}.value`,
    RACER_POINTER_OFFSET + 4,
  );
  requireExact(
    reference.rawValue,
    reference.value,
    `${referencePath}.rawValue`,
  );
  requireExact(reference.mapped, true, `${referencePath}.mapped`);

  const lookupPath = `${guestPath}.racerLookup`;
  const lookup = requireObject(guest.racerLookup, lookupPath);
  requireExact(
    lookup.pointerOffset,
    hexU32(RACER_POINTER_OFFSET),
    `${lookupPath}.pointerOffset`,
  );
  requireAddress(
    lookup.pointerAddress,
    referenceValue + RACER_POINTER_OFFSET,
    `${lookupPath}.pointerAddress`,
  );
  const racer = requireMappedMem1(
    lookup.racer,
    `${lookupPath}.racer`,
    RACER_BLOCK_SIZE,
  );
  requireExact(lookup.rawValue, lookup.racer, `${lookupPath}.rawValue`);
  requireExact(
    lookup.blockSize,
    RACER_BLOCK_SIZE,
    `${lookupPath}.blockSize`,
  );
  requireExact(guest.raceAllocated, true, `${guestPath}.raceAllocated`);

  const vehiclePath = `${guestPath}.vehicle`;
  const vehicle = requireObject(guest.vehicle, vehiclePath);
  requireExact(vehicle.address, lookup.racer, `${vehiclePath}.address`);
  requireExact(vehicle.size, RACER_BLOCK_SIZE, `${vehiclePath}.size`);
  requireAddress(
    vehicle.generalStateAddress,
    racer,
    `${vehiclePath}.generalStateAddress`,
  );
  const generalState = requireU32(
    vehicle.generalState,
    `${vehiclePath}.generalState`,
  );
  requireAddress(
    vehicle.entrantIdAddress,
    racer + 4,
    `${vehiclePath}.entrantIdAddress`,
  );
  const entrantId = requireU16(
    vehicle.entrantId,
    `${vehiclePath}.entrantId`,
  );
  requireAddress(
    vehicle.machineIdAddress,
    racer + 6,
    `${vehiclePath}.machineIdAddress`,
  );
  const machineId = requireU16(
    vehicle.machineId,
    `${vehiclePath}.machineId`,
  );
  requireAddress(
    vehicle.positionAddress,
    racer + 0x7c,
    `${vehiclePath}.positionAddress`,
  );
  const position = requireVector(
    vehicle.position,
    `${vehiclePath}.position`,
  );
  requireAddress(
    vehicle.previousPositionAddress,
    racer + 0x88,
    `${vehiclePath}.previousPositionAddress`,
  );
  const previousPosition = requireVector(
    vehicle.previousPosition,
    `${vehiclePath}.previousPosition`,
  );
  requireAddress(
    vehicle.worldVelocityAddress,
    racer + 0x94,
    `${vehiclePath}.worldVelocityAddress`,
  );
  const worldVelocity = requireVector(
    vehicle.worldVelocity,
    `${vehiclePath}.worldVelocity`,
  );
  requireAddress(
    vehicle.localVelocityAddress,
    racer + 0xb8,
    `${vehiclePath}.localVelocityAddress`,
  );
  const localVelocity = requireVector(
    vehicle.localVelocity,
    `${vehiclePath}.localVelocity`,
  );
  requireAddress(
    vehicle.worldOrientationAddress,
    racer + 0xec,
    `${vehiclePath}.worldOrientationAddress`,
  );
  const worldOrientation = requireVector(
    vehicle.worldOrientation,
    `${vehiclePath}.worldOrientation`,
  );
  requireAddress(
    vehicle.speedKphAddress,
    racer + 0x17c,
    `${vehiclePath}.speedKphAddress`,
  );
  const speedKph = requireFinite(
    vehicle.speedKph,
    `${vehiclePath}.speedKph`,
  );
  requireAddress(
    vehicle.energyAddress,
    racer + 0x184,
    `${vehiclePath}.energyAddress`,
  );
  const energy = requireFinite(vehicle.energy, `${vehiclePath}.energy`);
  requireAddress(
    vehicle.crashToRestoreFrameCounterAddress,
    racer + 0x194,
    `${vehiclePath}.crashToRestoreFrameCounterAddress`,
  );
  const crashToRestoreFrameCounter = requireU32(
    vehicle.crashToRestoreFrameCounter,
    `${vehiclePath}.crashToRestoreFrameCounter`,
  );
  requireAddress(
    vehicle.trackOrientationAddress,
    racer + 0x1bc,
    `${vehiclePath}.trackOrientationAddress`,
  );
  const trackOrientation = requireVector(
    vehicle.trackOrientation,
    `${vehiclePath}.trackOrientation`,
  );
  requireAddress(
    vehicle.checkpointAddress,
    racer + 0x1cc,
    `${vehiclePath}.checkpointAddress`,
  );
  const checkpoint = requireS32(
    vehicle.checkpoint,
    `${vehiclePath}.checkpoint`,
  );
  requireAddress(
    vehicle.checkpointFractionAddress,
    racer + 0x1d0,
    `${vehiclePath}.checkpointFractionAddress`,
  );
  const checkpointFraction = requireFinite(
    vehicle.checkpointFraction,
    `${vehiclePath}.checkpointFraction`,
  );

  const input = projectFzeroInput(
    vehicle.input,
    `${vehiclePath}.input`,
    racer,
  );
  const lifecycle = projectFzeroLifecycle(
    vehicle.lifecycle,
    `${vehiclePath}.lifecycle`,
    racer,
  );
  requireExact(vehicle.valid, true, `${vehiclePath}.valid`);
  requireExact(guest.vehicleValid, true, `${guestPath}.vehicleValid`);
  requireExact(
    guest.activeRaceCandidate,
    true,
    `${guestPath}.activeRaceCandidate`,
  );
  if ((generalState & INPUT_DISABLED_MASK) !== 0) {
    fail(
      `${vehiclePath}.generalState`,
      "expected the racer input-disable bit to be clear",
    );
  }
  if ((generalState & OBJECT_DRIVEN_INPUT_MASK) !== 0) {
    fail(
      `${vehiclePath}.generalState`,
      "expected the live player path rather than AI/replay input",
    );
  }
  requireExact(
    lifecycle.controllerSlot,
    0,
    `${vehiclePath}.lifecycle.controllerSlot`,
  );
  requireExact(
    lifecycle.restoreCompletionFlag,
    1,
    `${vehiclePath}.lifecycle.restoreCompletionFlag`,
  );
  requireExact(
    guest.livePlayerInputPath,
    true,
    `${guestPath}.livePlayerInputPath`,
  );
  requireExact(
    guest.defaultLivePlayerInputState,
    true,
    `${guestPath}.defaultLivePlayerInputState`,
  );

  const neutralSteering = input.steerY === 0
    && input.strafe === 0
    && input.steerX === 0
    && input.duplicateSteerX === 0;
  if (requireNeutralSteering && !neutralSteering) {
    fail(`${vehiclePath}.input`, "expected neutral baseline steering");
  }
  requireExact(
    lifecycle.crashBit,
    0,
    `${vehiclePath}.lifecycle.crashBit`,
  );
  requireExact(
    lifecycle.restoreCountdown,
    0,
    `${vehiclePath}.lifecycle.restoreCountdown`,
  );
  requireExact(
    crashToRestoreFrameCounter,
    0,
    `${vehiclePath}.crashToRestoreFrameCounter`,
  );
  requireExact(
    lifecycle.breakDownCountdown,
    0,
    `${vehiclePath}.lifecycle.breakDownCountdown`,
  );
  requireExact(
    lifecycle.postRestoreCountdown,
    0,
    `${vehiclePath}.lifecycle.postRestoreCountdown`,
  );

  const frameMotionSquared = displacementSquared(
    previousPosition,
    position,
  );
  const velocitySquared = magnitudeSquared(worldVelocity);
  requireMotion(
    frameMotionSquared,
    `${vehiclePath}.position`,
    "an advancing per-frame racer position",
  );
  requireMotion(
    velocitySquared,
    `${vehiclePath}.worldVelocity`,
    "a moving racer world velocity",
  );

  return Object.freeze({
    guest,
    referenceValue,
    racer,
    generalState,
    entrantId,
    machineId,
    position,
    previousPosition,
    worldVelocity,
    localVelocity,
    worldOrientation,
    speedKph,
    energy,
    trackOrientation,
    checkpoint,
    checkpointFraction,
    input,
    lifecycle,
    frameMotionSquared,
    velocitySquared,
  });
}

export function projectFzeroGuestConsumption({
  button,
  game,
  postReport,
  preReport,
  publication,
}) {
  if (game.key !== FZERO_FIRST_PLAYABLE_GAME_KEY) return null;
  requireExact(button, "left", "$.button");
  const disc = requireObject(game.disc, "$.game.disc");
  requireExact(disc.identifier, "GFZE01", "$.game.disc.identifier");
  requireExact(disc.revision, 0, "$.game.disc.revision");

  const baseline = projectFzeroState(preReport, "$.preReport", true);
  requireExact(
    baseline.guest.lastActiveGameplayInput,
    null,
    "$.preReport.guestGame.lastActiveGameplayInput",
  );
  const post = projectFzeroState(postReport, "$.postReport", false);
  requireExact(
    post.referenceValue,
    baseline.referenceValue,
    "$.postReport.guestGame.reference.value",
  );
  requireExact(
    post.racer,
    baseline.racer,
    "$.postReport.guestGame.vehicle.address",
  );
  requireExact(
    post.entrantId,
    baseline.entrantId,
    "$.postReport.guestGame.vehicle.entrantId",
  );
  requireExact(
    post.machineId,
    baseline.machineId,
    "$.postReport.guestGame.vehicle.machineId",
  );

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
  requireExact(
    requireMappedMem1(latch.reference, `${latchPath}.reference`),
    baseline.referenceValue,
    `${latchPath}.reference`,
  );
  requireExact(
    requireMappedMem1(
      latch.racer,
      `${latchPath}.racer`,
      RACER_BLOCK_SIZE,
    ),
    baseline.racer,
    `${latchPath}.racer`,
  );
  requireExact(
    requireU16(latch.entrantId, `${latchPath}.entrantId`),
    baseline.entrantId,
    `${latchPath}.entrantId`,
  );
  requireExact(
    requireU16(latch.machineId, `${latchPath}.machineId`),
    baseline.machineId,
    `${latchPath}.machineId`,
  );
  const latchFrame = requireU32(
    latch.frameCountSinceStartOrRestore,
    `${latchPath}.frameCountSinceStartOrRestore`,
  );
  const latchGeneralState = requireU32(
    latch.generalState,
    `${latchPath}.generalState`,
  );
  if ((latchGeneralState & INPUT_DISABLED_MASK) !== 0) {
    fail(
      `${latchPath}.generalState`,
      "expected the racer input-disable bit to be clear",
    );
  }
  if ((latchGeneralState & OBJECT_DRIVEN_INPUT_MASK) !== 0) {
    fail(
      `${latchPath}.generalState`,
      "expected the live player path rather than AI/replay input",
    );
  }
  const latchControllerSlot = requireExact(
    requireS8(latch.controllerSlot, `${latchPath}.controllerSlot`),
    0,
    `${latchPath}.controllerSlot`,
  );
  if (latchFrame < baseline.lifecycle.frameCount) {
    fail(
      `${latchPath}.frameCountSinceStartOrRestore`,
      `expected at least ${baseline.lifecycle.frameCount}`,
    );
  }
  const latchPosition = requireVector(
    latch.position,
    `${latchPath}.position`,
  );
  const latchWorldVelocity = requireVector(
    latch.worldVelocity,
    `${latchPath}.worldVelocity`,
  );
  const latchVelocitySquared = requireMotion(
    magnitudeSquared(latchWorldVelocity),
    `${latchPath}.worldVelocity`,
    "a moving racer world velocity",
  );

  const latchInput = requireExactKeys(
    latch.input,
    LATCH_INPUT_FIELDS,
    `${latchPath}.input`,
  );
  requireExact(latchInput.steerY, 0, `${latchPath}.input.steerY`);
  requireExact(latchInput.strafe, 0, `${latchPath}.input.strafe`);
  const latchSteerX = requireRange(
    latchInput.steerX,
    -1,
    1,
    `${latchPath}.input.steerX`,
  );
  if (latchSteerX > -0.5) {
    fail(
      `${latchPath}.input.steerX`,
      "expected an active negative left-steering deflection",
    );
  }
  requireExact(
    requireRange(
      latchInput.duplicateSteerX,
      -1,
      1,
      `${latchPath}.input.duplicateSteerX`,
    ),
    latchSteerX,
    `${latchPath}.input.duplicateSteerX`,
  );
  const latchAccelerator = requireFinite(
    latchInput.accelerator,
    `${latchPath}.input.accelerator`,
  );
  const latchBrake = requireFinite(
    latchInput.brake,
    `${latchPath}.input.brake`,
  );
  const latchLifecycle = requireExactKeys(
    latch.lifecycle,
    LATCH_LIFECYCLE_FIELDS,
    `${latchPath}.lifecycle`,
  );
  for (const [field, requireInteger] of [
    ["crashBit", requireU8],
    ["restoreCountdown", requireU16],
    ["crashToRestoreFrameCounter", requireU32],
    ["breakDownCountdown", requireU8],
    ["postRestoreCountdown", requireU8],
  ]) {
    requireExact(
      requireInteger(
        latchLifecycle[field],
        `${latchPath}.lifecycle.${field}`,
      ),
      0,
      `${latchPath}.lifecycle.${field}`,
    );
  }
  const latchInputProcessingState = requireU8(
    latchLifecycle.restoreCompletionFlag,
    `${latchPath}.lifecycle.restoreCompletionFlag`,
  );
  requireExact(
    latchInputProcessingState,
    1,
    `${latchPath}.lifecycle.restoreCompletionFlag`,
  );

  const hostPublication = requireExactKeys(
    latch.hostPublication,
    PUBLICATION_FIELDS,
    `${latchPath}.hostPublication`,
  );
  if (
    hostPublication.source !== "periodic"
    && hostPublication.source !== "direct"
  ) {
    fail(`${latchPath}.hostPublication.source`, "expected periodic or direct");
  }
  const hostPollIndex = requirePositiveInteger(
    hostPublication.pollIndex,
    `${latchPath}.hostPublication.pollIndex`,
  );
  const hostScheduledCycle = requireNonNegativeInteger(
    hostPublication.scheduledCycle,
    `${latchPath}.hostPublication.scheduledCycle`,
  );
  const hostObservedCycle = requireNonNegativeInteger(
    hostPublication.observedCycle,
    `${latchPath}.hostPublication.observedCycle`,
  );
  requireExact(
    hostPublication.buttons,
    0x0001,
    `${latchPath}.hostPublication.buttons`,
  );
  const hostSequence = requirePositiveInteger(
    hostPublication.sequence,
    `${latchPath}.hostPublication.sequence`,
  );
  if (
    hostScheduledCycle < preReport.cycles
    || hostScheduledCycle > hostObservedCycle
    || hostObservedCycle > cycle
  ) {
    fail(
      `${latchPath}.hostPublication`,
      `expected publication between baseline cycle ${preReport.cycles} and latch cycle ${cycle}`,
    );
  }
  if (hostPollIndex <= preReport.controller.pollIndex) {
    fail(
      `${latchPath}.hostPublication.pollIndex`,
      `expected a value greater than ${preReport.controller.pollIndex}`,
    );
  }
  requireExact(
    requirePositiveInteger(
      latch.controllerAppliedSequence,
      `${latchPath}.controllerAppliedSequence`,
    ),
    hostSequence,
    `${latchPath}.controllerAppliedSequence`,
  );
  requireExact(
    hostSequence,
    publication.sequence,
    `${latchPath}.hostPublication.sequence`,
  );
  if (
    hostPollIndex > publication.pollIndex
    || hostScheduledCycle > publication.scheduledCycle
    || hostObservedCycle > publication.observedCycle
  ) {
    fail(
      `${latchPath}.hostPublication`,
      "guest latch publication cannot follow the terminal active publication",
    );
  }

  if (post.lifecycle.frameCount <= latchFrame) {
    fail(
      "$.postReport.guestGame.vehicle.lifecycle.frameCountSinceStartOrRestore",
      `expected a value greater than retained latch frame ${latchFrame}`,
    );
  }
  const windowMovementSquared = requireMotion(
    displacementSquared(baseline.position, post.position),
    "$.postReport.guestGame.vehicle.position",
    "racer movement after the consumed steering input",
  );
  const postLatchMovementSquared = requireMotion(
    displacementSquared(latchPosition, post.position),
    "$.postReport.guestGame.vehicle.position",
    "racer movement after the retained guest-input receipt",
  );

  return Object.freeze({
    kind: "fzero-gx-active-race-steer-v1",
    cycle,
    reference: post.guest.reference.value,
    racer: post.guest.vehicle.address,
    entrantId: post.entrantId,
    machineId: post.machineId,
    baseline: Object.freeze({
      cycle: preReport.cycles,
      frameCountSinceStartOrRestore: baseline.lifecycle.frameCount,
      position: baseline.position,
      previousPosition: baseline.previousPosition,
      worldVelocity: baseline.worldVelocity,
      speedKph: baseline.speedKph,
      checkpoint: baseline.checkpoint,
      checkpointFraction: baseline.checkpointFraction,
      inputSource: Object.freeze({
        generalState: baseline.generalState,
        controllerSlot: baseline.lifecycle.controllerSlot,
        inputProcessingState: baseline.lifecycle.restoreCompletionFlag,
        livePlayer: true,
      }),
    }),
    receipt: Object.freeze({
      frameCountSinceStartOrRestore: latchFrame,
      position: latchPosition,
      worldVelocity: latchWorldVelocity,
      input: Object.freeze({
        steerY: latchInput.steerY,
        strafe: latchInput.strafe,
        steerX: latchSteerX,
        duplicateSteerX: latchInput.duplicateSteerX,
        accelerator: latchAccelerator,
        brake: latchBrake,
      }),
      inputSource: Object.freeze({
        generalState: latchGeneralState,
        controllerSlot: latchControllerSlot,
        inputProcessingState: latchInputProcessingState,
        livePlayer: true,
      }),
    }),
    post: Object.freeze({
      cycle: postReport.cycles,
      frameCountSinceStartOrRestore: post.lifecycle.frameCount,
      position: post.position,
      previousPosition: post.previousPosition,
      worldVelocity: post.worldVelocity,
      speedKph: post.speedKph,
      checkpoint: post.checkpoint,
      checkpointFraction: post.checkpointFraction,
      inputSource: Object.freeze({
        generalState: post.generalState,
        controllerSlot: post.lifecycle.controllerSlot,
        inputProcessingState: post.lifecycle.restoreCompletionFlag,
        livePlayer: true,
      }),
    }),
    movement: Object.freeze({
      baselineFrameDistanceSquared: baseline.frameMotionSquared,
      postFrameDistanceSquared: post.frameMotionSquared,
      windowDistanceSquared: windowMovementSquared,
      postLatchDistanceSquared: postLatchMovementSquared,
      baselineWorldVelocitySquared: baseline.velocitySquared,
      latchWorldVelocitySquared: latchVelocitySquared,
      postWorldVelocitySquared: post.velocitySquared,
      frameDelta:
        post.lifecycle.frameCount - baseline.lifecycle.frameCount,
      postLatchFrameDelta: post.lifecycle.frameCount - latchFrame,
    }),
    controllerAppliedSequence: latch.controllerAppliedSequence,
    hostPublication: Object.freeze({
      source: hostPublication.source,
      pollIndex: hostPollIndex,
      scheduledCycle: hostScheduledCycle,
      observedCycle: hostObservedCycle,
      buttons: hostPublication.buttons,
      sequence: hostSequence,
    }),
  });
}
