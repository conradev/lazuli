// SPDX-License-Identifier: GPL-3.0-only

import {
  GameFirstPlayableTranscriptError,
} from "./browser_game_first_playable_transcript_core.mjs";

export const WIND_WAKER_FIRST_PLAYABLE_GAME_KEY = "wind-waker-usa";
export const WIND_WAKER_OUTSET_STAGE = "sea";
export const WIND_WAKER_OUTSET_ROOM = 44;

const PLAYER_PROFILE = 0x8038fd8c;
const PLAYER_PROCESS_NAME = 0x00a9;
const LEFT_GUEST_HOLD = 0x8000;
const MINIMUM_MOVEMENT_SQUARED = 1e-4;
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
  "player",
  "stage",
  "room",
  "position",
  "heading",
  "pad",
]);
const LATCH_PAD_FIELDS = Object.freeze([
  "hold",
  "trigger",
  "mainStickX",
  "mainStickY",
  "mainStickValue",
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

function requireU16(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    fail(path, "expected an unsigned 16-bit integer");
  }
  return value;
}

function requireFinite(value, path) {
  if (!Number.isFinite(value)) fail(path, "expected a finite number");
  return value;
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
  ) {
    fail(path, "expected a mapped MEM1 address");
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

function planarDisplacementSquared(left, right) {
  const x = right.x - left.x;
  const z = right.z - left.z;
  return x * x + z * z;
}

function headingDelta(left, right) {
  const direct = Math.abs(right - left);
  return Math.min(direct, 0x10000 - direct);
}

function projectWindWakerState(report, path, requireNeutral) {
  const guestPath = `${path}.guestGame`;
  const guest = requireObject(report.guestGame, guestPath);

  const stagePath = `${guestPath}.currentStage`;
  const stage = requireObject(guest.currentStage, stagePath);
  requireExact(stage.address, "0x803c9d3c", `${stagePath}.address`);
  requireExact(stage.name, WIND_WAKER_OUTSET_STAGE, `${stagePath}.name`);
  requireExact(stage.roomAddress, "0x803c9d46", `${stagePath}.roomAddress`);
  requireExact(stage.room, WIND_WAKER_OUTSET_ROOM, `${stagePath}.room`);
  requireExact(
    guest.stayRoomAddress,
    "0x803f6a78",
    `${guestPath}.stayRoomAddress`,
  );
  requireExact(guest.stayRoom, WIND_WAKER_OUTSET_ROOM, `${guestPath}.stayRoom`);
  requireExact(
    guest.outsetRoom,
    WIND_WAKER_OUTSET_ROOM,
    `${guestPath}.outsetRoom`,
  );
  requireExact(guest.stageActive, true, `${guestPath}.stageActive`);

  requireExact(
    guest.eventModeAddress,
    "0x803c9ea2",
    `${guestPath}.eventModeAddress`,
  );
  requireExact(guest.eventMode, 0, `${guestPath}.eventMode`);
  requireExact(guest.eventInactive, true, `${guestPath}.eventInactive`);
  requireExact(
    guest.menuPauseAddress,
    "0x803f7097",
    `${guestPath}.menuPauseAddress`,
  );
  requireExact(guest.menuPause, 0, `${guestPath}.menuPause`);
  requireExact(
    guest.pauseTimerAddress,
    "0x803f72b0",
    `${guestPath}.pauseTimerAddress`,
  );
  requireExact(guest.pauseTimer, 0, `${guestPath}.pauseTimer`);
  requireExact(guest.menuClosed, true, `${guestPath}.menuClosed`);

  const lookupPath = `${guestPath}.playerLookup`;
  const lookup = requireObject(guest.playerLookup, lookupPath);
  requireExact(
    lookup.playerPointerAddress,
    "0x803ca74c",
    `${lookupPath}.playerPointerAddress`,
  );
  const lookupPlayer = requireMappedMem1(
    lookup.player,
    `${lookupPath}.player`,
    0x4c28,
  );
  requireExact(
    lookup.linkPlayerPointerAddress,
    "0x803ca754",
    `${lookupPath}.linkPlayerPointerAddress`,
  );
  const linkPlayer = requireMappedMem1(
    lookup.linkPlayer,
    `${lookupPath}.linkPlayer`,
    0x4c28,
  );
  requireExact(linkPlayer, lookupPlayer, `${lookupPath}.linkPlayer`);
  requireExact(lookup.pointersMatch, true, `${lookupPath}.pointersMatch`);

  const playerPath = `${guestPath}.player`;
  const player = requireObject(guest.player, playerPath);
  const playerAddress = requireMappedMem1(
    player.address,
    `${playerPath}.address`,
    0x4c28,
  );
  requireExact(playerAddress, lookupPlayer, `${playerPath}.address`);
  requireExact(
    player.processNameAddress,
    hexU32(playerAddress + 8),
    `${playerPath}.processNameAddress`,
  );
  requireExact(
    player.processName,
    PLAYER_PROCESS_NAME,
    `${playerPath}.processName`,
  );
  requireExact(
    player.profileAddress,
    hexU32(playerAddress + 0x10),
    `${playerPath}.profileAddress`,
  );
  requireExact(
    player.profile,
    hexU32(PLAYER_PROFILE),
    `${playerPath}.profile`,
  );
  requireExact(
    player.pauseFlagAddress,
    hexU32(playerAddress + 0x0b),
    `${playerPath}.pauseFlagAddress`,
  );
  requireExact(player.pauseFlag, 0, `${playerPath}.pauseFlag`);
  requireExact(player.valid, true, `${playerPath}.valid`);
  requireExact(
    player.positionAddress,
    hexU32(playerAddress + 0x1f8),
    `${playerPath}.positionAddress`,
  );
  const position = requireVector(player.position, `${playerPath}.position`);
  requireExact(
    player.headingAddress,
    hexU32(playerAddress + 0x206),
    `${playerPath}.headingAddress`,
  );
  const heading = requireU16(player.heading, `${playerPath}.heading`);
  requireExact(
    player.roomAddress,
    hexU32(playerAddress + 0x20a),
    `${playerPath}.roomAddress`,
  );
  requireExact(player.room, WIND_WAKER_OUTSET_ROOM, `${playerPath}.room`);

  const padPath = `${guestPath}.pad`;
  const pad = requireObject(guest.pad, padPath);
  requireExact(pad.address, "0x803a4df0", `${padPath}.address`);
  requireExact(pad.holdAddress, "0x803a4e20", `${padPath}.holdAddress`);
  const hold = requireU16(pad.hold, `${padPath}.hold`);
  requireExact(
    pad.triggerAddress,
    "0x803a4e22",
    `${padPath}.triggerAddress`,
  );
  const trigger = requireU16(pad.trigger, `${padPath}.trigger`);
  requireExact(
    pad.mainStickXAddress,
    "0x803a4df0",
    `${padPath}.mainStickXAddress`,
  );
  const mainStickX = requireFinite(pad.mainStickX, `${padPath}.mainStickX`);
  requireExact(
    pad.mainStickYAddress,
    "0x803a4df4",
    `${padPath}.mainStickYAddress`,
  );
  const mainStickY = requireFinite(pad.mainStickY, `${padPath}.mainStickY`);
  requireExact(
    pad.mainStickValueAddress,
    "0x803a4df8",
    `${padPath}.mainStickValueAddress`,
  );
  const mainStickValue = requireFinite(
    pad.mainStickValue,
    `${padPath}.mainStickValue`,
  );
  requireExact(pad.errorAddress, "0x803a4e24", `${padPath}.errorAddress`);
  requireExact(pad.error, 0, `${padPath}.error`);

  requireExact(guest.controlsEnabled, true, `${guestPath}.controlsEnabled`);
  requireExact(
    guest.controllableOutset,
    true,
    `${guestPath}.controllableOutset`,
  );
  if (typeof guest.neutralInput !== "boolean") {
    fail(`${guestPath}.neutralInput`, "expected a boolean");
  }
  const neutralInput = hold === 0
    && trigger === 0
    && mainStickX === 0
    && mainStickY === 0
    && mainStickValue === 0;
  requireExact(
    guest.neutralInput,
    neutralInput,
    `${guestPath}.neutralInput`,
  );
  if (requireNeutral) {
    requireExact(guest.neutralInput, true, `${guestPath}.neutralInput`);
    requireExact(hold, 0, `${padPath}.hold`);
    requireExact(trigger, 0, `${padPath}.trigger`);
    requireExact(mainStickX, 0, `${padPath}.mainStickX`);
    requireExact(mainStickY, 0, `${padPath}.mainStickY`);
    requireExact(mainStickValue, 0, `${padPath}.mainStickValue`);
  }

  return Object.freeze({
    guest,
    heading,
    playerAddress,
    position,
  });
}

export function projectWindWakerGuestConsumption({
  button,
  game,
  postReport,
  preReport,
  publication,
}) {
  if (game.key !== WIND_WAKER_FIRST_PLAYABLE_GAME_KEY) return null;
  requireExact(button, "left", "$.button");
  const baseline = projectWindWakerState(preReport, "$.preReport", true);
  requireExact(
    baseline.guest.lastActiveGameplayInput,
    null,
    "$.preReport.guestGame.lastActiveGameplayInput",
  );
  const post = projectWindWakerState(postReport, "$.postReport", false);
  requireExact(
    post.playerAddress,
    baseline.playerAddress,
    "$.postReport.guestGame.player.address",
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
  requireExact(latch.player, post.guest.player.address, `${latchPath}.player`);
  requireExact(latch.stage, WIND_WAKER_OUTSET_STAGE, `${latchPath}.stage`);
  requireExact(latch.room, WIND_WAKER_OUTSET_ROOM, `${latchPath}.room`);
  const latchPosition = requireVector(latch.position, `${latchPath}.position`);
  const latchHeading = requireU16(latch.heading, `${latchPath}.heading`);

  const latchPad = requireExactKeys(latch.pad, LATCH_PAD_FIELDS, `${latchPath}.pad`);
  requireExact(latchPad.hold, LEFT_GUEST_HOLD, `${latchPath}.pad.hold`);
  requireU16(latchPad.trigger, `${latchPath}.pad.trigger`);
  const latchStickX = requireFinite(
    latchPad.mainStickX,
    `${latchPath}.pad.mainStickX`,
  );
  if (latchStickX < -1.001 || latchStickX > -0.5) {
    fail(`${latchPath}.pad.mainStickX`, "expected a decoded left deflection");
  }
  const latchStickY = requireFinite(
    latchPad.mainStickY,
    `${latchPath}.pad.mainStickY`,
  );
  if (Math.abs(latchStickY) > 0.125) {
    fail(`${latchPath}.pad.mainStickY`, "expected a horizontal deflection");
  }
  const latchStickValue = requireFinite(
    latchPad.mainStickValue,
    `${latchPath}.pad.mainStickValue`,
  );
  if (latchStickValue < 0.5 || latchStickValue > 1.001) {
    fail(`${latchPath}.pad.mainStickValue`, "expected an active normalized stick");
  }

  const hostPublication = requireExactKeys(
    latch.hostPublication,
    PUBLICATION_FIELDS,
    `${latchPath}.hostPublication`,
  );
  if (hostPublication.source !== "periodic" && hostPublication.source !== "direct") {
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
  requireExact(hostPublication.buttons, 0x0001, `${latchPath}.hostPublication.buttons`);
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
  requireExact(hostSequence, publication.sequence, `${latchPath}.hostPublication.sequence`);
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

  const planarMovementSquared = planarDisplacementSquared(
    baseline.position,
    post.position,
  );
  if (
    !Number.isFinite(planarMovementSquared)
    || planarMovementSquared <= MINIMUM_MOVEMENT_SQUARED
  ) {
    fail(
      "$.postReport.guestGame.player.position",
      "expected a causal player-position change after the consumed input",
    );
  }
  const postLatchPlanarMovementSquared = planarDisplacementSquared(
    latchPosition,
    post.position,
  );
  if (
    !Number.isFinite(postLatchPlanarMovementSquared)
    || postLatchPlanarMovementSquared <= MINIMUM_MOVEMENT_SQUARED
  ) {
    fail(
      "$.postReport.guestGame.player.position",
      "expected player movement after the retained guest-input receipt",
    );
  }

  return Object.freeze({
    kind: "wind-waker-outset-left-v1",
    cycle,
    stage: WIND_WAKER_OUTSET_STAGE,
    room: WIND_WAKER_OUTSET_ROOM,
    player: post.guest.player.address,
    baseline: Object.freeze({
      cycle: preReport.cycles,
      position: baseline.position,
      heading: baseline.heading,
    }),
    receipt: Object.freeze({
      position: latchPosition,
      heading: latchHeading,
      hold: latchPad.hold,
      mainStickX: latchStickX,
      mainStickY: latchStickY,
      mainStickValue: latchStickValue,
    }),
    post: Object.freeze({
      cycle: postReport.cycles,
      position: post.position,
      heading: post.heading,
    }),
    movement: Object.freeze({
      planarDistanceSquared: planarMovementSquared,
      postLatchPlanarDistanceSquared: postLatchPlanarMovementSquared,
      headingDelta: headingDelta(baseline.heading, post.heading),
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
