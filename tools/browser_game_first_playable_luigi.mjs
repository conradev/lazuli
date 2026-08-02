// SPDX-License-Identifier: GPL-3.0-only

import {
  GameFirstPlayableTranscriptError,
} from "./browser_game_first_playable_transcript_core.mjs";

export const LUIGIS_MANSION_FIRST_PLAYABLE_GAME_KEY = "luigis-mansion-usa";
export const LUIGIS_MANSION_FOYER_ROOM_INFO = 0x02000102;

const PLAYER_VTABLE = 0x80359d48;
const PLAYER_OBJECT_TABLE = 0x803d48a0;
const LEFT_GUEST_BUTTONS = 0x01000001;
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
  "roomInfo",
  "position",
  "heading",
  "pad",
  "controller",
]);
const LATCH_PAD_FIELDS = Object.freeze([
  "held",
  "trigger",
  "mainStickX",
  "mainStickY",
  "mainStickValue",
]);
const LATCH_CONTROLLER_FIELDS = Object.freeze([
  "inputSource",
  "mainStickMagnitude",
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

function requireU32(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    fail(path, "expected an unsigned 32-bit integer");
  }
  return value;
}

function requireU16(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    fail(path, "expected an unsigned 16-bit integer");
  }
  return value;
}

function requireU8(value, path) {
  const integer = requireU32(value, path);
  if (integer > 0xff) fail(path, "expected an unsigned 8-bit integer");
  return integer;
}

function requireS16(value, path) {
  if (
    !Number.isSafeInteger(value)
    || value < -0x8000
    || value > 0x7fff
  ) {
    fail(path, "expected a signed 16-bit integer");
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

function displacementSquared(left, right) {
  const x = right.x - left.x;
  const y = right.y - left.y;
  const z = right.z - left.z;
  return x * x + y * y + z * z;
}

function headingDelta(left, right) {
  const direct = Math.abs(right - left);
  return Math.min(direct, 0x10000 - direct);
}

function projectLuigisMansionState(report, path, requireNeutral) {
  const guest = requireObject(report.guestGame, `${path}.guestGame`);
  requireExact(guest.sceneIdAddress, "0x804d80a0", `${path}.guestGame.sceneIdAddress`);
  requireExact(guest.sceneId, 2, `${path}.guestGame.sceneId`);
  requireExact(guest.mainGameScene, true, `${path}.guestGame.mainGameScene`);
  requireExact(guest.menuModeAddress, "0x804d80c4", `${path}.guestGame.menuModeAddress`);
  requireExact(guest.menuMode, 0, `${path}.guestGame.menuMode`);
  requireExact(guest.menuClosed, true, `${path}.guestGame.menuClosed`);
  requireExact(guest.openMapIdAddress, "0x804d80c8", `${path}.guestGame.openMapIdAddress`);
  requireExact(guest.openMapId, 2, `${path}.guestGame.openMapId`);
  requireExact(guest.mansionOpen, true, `${path}.guestGame.mansionOpen`);
  const eventPath = `${path}.guestGame.eventManager`;
  const eventManager = requireObject(guest.eventManager, eventPath);
  requireExact(
    eventManager.slotBasePointerAddress,
    "0x804d8370",
    `${eventPath}.slotBasePointerAddress`,
  );
  requireHexU32(
    eventManager.slotBase,
    `${eventPath}.slotBase`,
  );
  requireExact(
    eventManager.slotCountAddress,
    "0x804d8374",
    `${eventPath}.slotCountAddress`,
  );
  const eventSlotCount = requireS16(
    eventManager.slotCount,
    `${eventPath}.slotCount`,
  );
  requireExact(eventManager.slotStride, 0x58, `${eventPath}.slotStride`);
  requireExact(eventManager.tableValid, true, `${eventPath}.tableValid`);
  if (eventSlotCount < 0) {
    fail(`${eventPath}.slotCount`, "validated event table cannot have negative count");
  }
  if (eventSlotCount > 0) {
    requireMappedMem1(
      eventManager.slotBase,
      `${eventPath}.slotBase`,
      eventSlotCount * eventManager.slotStride,
    );
  }
  requireExact(
    eventManager.iteratorScratchPointerAddress,
    "0x804d8378",
    `${eventPath}.iteratorScratchPointerAddress`,
  );
  if (eventManager.iteratorScratchPointer !== null) {
    requireHexU32(
      eventManager.iteratorScratchPointer,
      `${eventPath}.iteratorScratchPointer`,
    );
  }
  requireExact(
    eventManager.iteratorScratchHasActiveEventSemantics,
    false,
    `${eventPath}.iteratorScratchHasActiveEventSemantics`,
  );
  requireExact(
    eventManager.blockingCountAddress,
    "0x804d837c",
    `${eventPath}.blockingCountAddress`,
  );
  requireU8(eventManager.blockingCount, `${eventPath}.blockingCount`);
  requirePositiveInteger(
    eventManager.activeSlotLimit,
    `${eventPath}.activeSlotLimit`,
  );
  requireExact(eventManager.activeCount, 0, `${eventPath}.activeCount`);
  requireExact(
    eventManager.activeSlotsTruncated,
    false,
    `${eventPath}.activeSlotsTruncated`,
  );
  if (!Array.isArray(eventManager.activeSlots)) {
    fail(`${eventPath}.activeSlots`, "expected an array");
  }
  requireExact(
    eventManager.activeSlots.length,
    0,
    `${eventPath}.activeSlots.length`,
  );
  requireExact(guest.eventInactive, true, `${path}.guestGame.eventInactive`);
  requireExact(guest.gameModeAddress, "0x804d8728", `${path}.guestGame.gameModeAddress`);
  requireExact(guest.gameMode, 2, `${path}.guestGame.gameMode`);
  requireExact(guest.gameplayMode, true, `${path}.guestGame.gameplayMode`);
  requireExact(
    guest.currentRoomInfoAddress,
    "0x803a3cac",
    `${path}.guestGame.currentRoomInfoAddress`,
  );
  requireExact(
    guest.currentRoomInfo,
    hexU32(LUIGIS_MANSION_FOYER_ROOM_INFO),
    `${path}.guestGame.currentRoomInfo`,
  );
  requireExact(guest.foyerActive, true, `${path}.guestGame.foyerActive`);
  requireExact(
    guest.currentPlayerPositionAddress,
    "0x803a3ca0",
    `${path}.guestGame.currentPlayerPositionAddress`,
  );
  const currentPosition = requireVector(
    guest.currentPlayerPosition,
    `${path}.guestGame.currentPlayerPosition`,
  );

  const lookupPath = `${path}.guestGame.playerLookup`;
  const lookup = requireObject(guest.playerLookup, lookupPath);
  requireExact(
    lookup.rootPointerAddress,
    "0x804d8c60",
    `${lookupPath}.rootPointerAddress`,
  );
  const root = requireMappedMem1(lookup.root, `${lookupPath}.root`, 12);
  requireExact(
    lookup.managerPointerAddress,
    hexU32(root + 8),
    `${lookupPath}.managerPointerAddress`,
  );
  const manager = requireMappedMem1(lookup.manager, `${lookupPath}.manager`, 0xe0c);
  requireExact(
    lookup.handleAddress,
    hexU32(manager + 0xe08),
    `${lookupPath}.handleAddress`,
  );
  const handle = requireU32(lookup.handle, `${lookupPath}.handle`);
  const maximumHandle = Math.floor((0x817ffffc - PLAYER_OBJECT_TABLE) / 4);
  if (handle > maximumHandle) {
    fail(`${lookupPath}.handle`, "player object-table handle is outside MEM1");
  }
  requireExact(
    lookup.objectSlotAddress,
    hexU32(PLAYER_OBJECT_TABLE + handle * 4),
    `${lookupPath}.objectSlotAddress`,
  );

  const playerPath = `${path}.guestGame.player`;
  const player = requireObject(guest.player, playerPath);
  const playerAddress = requireMappedMem1(
    player.address,
    `${playerPath}.address`,
    0x1070,
  );
  requireExact(player.vtableAddress, player.address, `${playerPath}.vtableAddress`);
  requireExact(player.vtable, hexU32(PLAYER_VTABLE), `${playerPath}.vtable`);
  requireExact(player.valid, true, `${playerPath}.valid`);
  requireExact(
    player.positionAddress,
    hexU32(playerAddress + 0x44),
    `${playerPath}.positionAddress`,
  );
  const playerPosition = requireVector(player.position, `${playerPath}.position`);
  for (const field of VECTOR_FIELDS) {
    requireExact(
      playerPosition[field],
      currentPosition[field],
      `${playerPath}.position.${field}`,
    );
  }
  requireExact(
    player.headingAddress,
    hexU32(playerAddress + 0x88),
    `${playerPath}.headingAddress`,
  );
  const heading = requireU16(player.heading, `${playerPath}.heading`);
  requireExact(
    player.roomInfoAddress,
    hexU32(playerAddress + 0xb4),
    `${playerPath}.roomInfoAddress`,
  );
  requireExact(
    player.roomInfo,
    hexU32(LUIGIS_MANSION_FOYER_ROOM_INFO),
    `${playerPath}.roomInfo`,
  );
  requireExact(
    player.gamePadPointerAddress,
    hexU32(playerAddress + 0x794),
    `${playerPath}.gamePadPointerAddress`,
  );
  const playerGamePad = requireMappedMem1(
    player.gamePad,
    `${playerPath}.gamePad`,
    0x77,
  );
  requireExact(
    player.controllerPointerAddress,
    hexU32(playerAddress + 0x7d4),
    `${playerPath}.controllerPointerAddress`,
  );
  const playerController = requireMappedMem1(
    player.controller,
    `${playerPath}.controller`,
    0x1e0,
  );

  const inputGatePath = `${path}.guestGame.inputGate`;
  const inputGate = requireObject(guest.inputGate, inputGatePath);
  requireExact(
    inputGate.healthAddress,
    hexU32(playerAddress + 0xfc),
    `${inputGatePath}.healthAddress`,
  );
  const inputGateHealth = requireS16(
    inputGate.health,
    `${inputGatePath}.health`,
  );
  if (inputGateHealth <= 0) {
    fail(`${inputGatePath}.health`, "expected positive player health");
  }
  requireExact(
    inputGate.state1042Address,
    hexU32(playerAddress + 0x1042),
    `${inputGatePath}.state1042Address`,
  );
  requireExact(
    requireU8(inputGate.state1042, `${inputGatePath}.state1042`),
    0,
    `${inputGatePath}.state1042`,
  );
  requireExact(
    inputGate.state1058Address,
    hexU32(playerAddress + 0x1058),
    `${inputGatePath}.state1058Address`,
  );
  requireExact(
    requireU8(inputGate.state1058, `${inputGatePath}.state1058`),
    0,
    `${inputGatePath}.state1058`,
  );
  requireExact(
    inputGate.timer105cAddress,
    hexU32(playerAddress + 0x105c),
    `${inputGatePath}.timer105cAddress`,
  );
  const inputGateTimer105c = requireFinite(
    inputGate.timer105c,
    `${inputGatePath}.timer105c`,
  );
  if (0 < inputGateTimer105c) {
    fail(`${inputGatePath}.timer105c`, "expected a non-positive gate timer");
  }
  requireExact(
    inputGate.state106cAddress,
    hexU32(playerAddress + 0x106c),
    `${inputGatePath}.state106cAddress`,
  );
  requireExact(
    requireFinite(inputGate.state106c, `${inputGatePath}.state106c`),
    0,
    `${inputGatePath}.state106c`,
  );
  requireExact(inputGate.open, true, `${inputGatePath}.open`);

  const padPath = `${path}.guestGame.pad`;
  const pad = requireObject(guest.pad, padPath);
  requireExact(pad.pointerAddress, "0x804d8078", `${padPath}.pointerAddress`);
  const padAddress = requireMappedMem1(pad.address, `${padPath}.address`, 0x77);
  requireExact(padAddress, playerGamePad, `${padPath}.address`);
  requireExact(pad.heldAddress, hexU32(padAddress + 0x18), `${padPath}.heldAddress`);
  const held = requireU32(pad.held, `${padPath}.held`);
  requireExact(
    pad.triggerAddress,
    hexU32(padAddress + 0x1c),
    `${padPath}.triggerAddress`,
  );
  const trigger = requireU32(pad.trigger, `${padPath}.trigger`);
  requireExact(
    pad.mainStickXAddress,
    hexU32(padAddress + 0x44),
    `${padPath}.mainStickXAddress`,
  );
  const mainStickX = requireFinite(pad.mainStickX, `${padPath}.mainStickX`);
  requireExact(
    pad.mainStickYAddress,
    hexU32(padAddress + 0x48),
    `${padPath}.mainStickYAddress`,
  );
  const mainStickY = requireFinite(pad.mainStickY, `${padPath}.mainStickY`);
  requireExact(
    pad.mainStickValueAddress,
    hexU32(padAddress + 0x4c),
    `${padPath}.mainStickValueAddress`,
  );
  const mainStickValue = requireFinite(
    pad.mainStickValue,
    `${padPath}.mainStickValue`,
  );
  requireExact(pad.portAddress, hexU32(padAddress + 0x74), `${padPath}.portAddress`);
  requireExact(pad.port, 0, `${padPath}.port`);
  requireExact(pad.errorAddress, hexU32(padAddress + 0x76), `${padPath}.errorAddress`);
  requireExact(pad.error, 0, `${padPath}.error`);

  const controllerPath = `${path}.guestGame.controller`;
  const controller = requireObject(guest.controller, controllerPath);
  requireExact(controller.address, player.controller, `${controllerPath}.address`);
  requireExact(
    controller.inputSourceAddress,
    hexU32(playerController + 0x1b0),
    `${controllerPath}.inputSourceAddress`,
  );
  requireExact(
    guest.expectedInputSource,
    pad.address,
    `${path}.guestGame.expectedInputSource`,
  );
  requireExact(
    controller.inputSource,
    guest.expectedInputSource,
    `${controllerPath}.inputSource`,
  );
  requireExact(
    controller.mainStickMagnitudeAddress,
    hexU32(playerController + 0x1c0),
    `${controllerPath}.mainStickMagnitudeAddress`,
  );
  const controllerMagnitude = requireFinite(
    controller.mainStickMagnitude,
    `${controllerPath}.mainStickMagnitude`,
  );
  requireExact(
    controller.previousMainStickMagnitudeAddress,
    hexU32(playerController + 0x1dc),
    `${controllerPath}.previousMainStickMagnitudeAddress`,
  );
  const previousControllerMagnitude = requireFinite(
    controller.previousMainStickMagnitude,
    `${controllerPath}.previousMainStickMagnitude`,
  );
  requireExact(
    guest.inputPipelineReady,
    true,
    `${path}.guestGame.inputPipelineReady`,
  );
  requireExact(
    guest.inputGateCoherent,
    true,
    `${path}.guestGame.inputGateCoherent`,
  );
  requireExact(
    guest.controllerAcceptingPad,
    true,
    `${path}.guestGame.controllerAcceptingPad`,
  );
  requireExact(guest.controlsEnabled, true, `${path}.guestGame.controlsEnabled`);
  requireExact(guest.controllableFoyer, true, `${path}.guestGame.controllableFoyer`);
  if (typeof guest.neutralInput !== "boolean") {
    fail(`${path}.guestGame.neutralInput`, "expected a boolean");
  }
  if (requireNeutral) {
    requireExact(guest.neutralInput, true, `${path}.guestGame.neutralInput`);
    requireExact(held, 0, `${padPath}.held`);
    requireExact(trigger, 0, `${padPath}.trigger`);
    requireExact(mainStickX, 0, `${padPath}.mainStickX`);
    requireExact(mainStickY, 0, `${padPath}.mainStickY`);
    requireExact(mainStickValue, 0, `${padPath}.mainStickValue`);
    requireExact(controllerMagnitude, 0, `${controllerPath}.mainStickMagnitude`);
    requireExact(
      previousControllerMagnitude,
      0,
      `${controllerPath}.previousMainStickMagnitude`,
    );
  }

  return Object.freeze({
    guest,
    currentPosition,
    playerAddress,
    playerPosition,
    heading,
    padAddress,
    playerController,
  });
}

export function projectLuigisMansionGuestConsumption({
  button,
  game,
  postReport,
  preReport,
  publication,
}) {
  if (game.key !== LUIGIS_MANSION_FIRST_PLAYABLE_GAME_KEY) return null;
  requireExact(button, "left", "$.button");
  const baseline = projectLuigisMansionState(preReport, "$.preReport", true);
  requireExact(
    baseline.guest.lastActiveGameplayInput,
    null,
    "$.preReport.guestGame.lastActiveGameplayInput",
  );
  const post = projectLuigisMansionState(postReport, "$.postReport", false);
  requireExact(
    post.playerAddress,
    baseline.playerAddress,
    "$.postReport.guestGame.player.address",
  );
  requireExact(
    post.padAddress,
    baseline.padAddress,
    "$.postReport.guestGame.pad.address",
  );
  requireExact(
    post.playerController,
    baseline.playerController,
    "$.postReport.guestGame.controller.address",
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
  requireExact(
    latch.roomInfo,
    hexU32(LUIGIS_MANSION_FOYER_ROOM_INFO),
    `${latchPath}.roomInfo`,
  );
  const latchPosition = requireVector(latch.position, `${latchPath}.position`);
  const latchHeading = requireU16(latch.heading, `${latchPath}.heading`);

  const latchPad = requireExactKeys(latch.pad, LATCH_PAD_FIELDS, `${latchPath}.pad`);
  requireExact(latchPad.held, LEFT_GUEST_BUTTONS, `${latchPath}.pad.held`);
  requireU32(latchPad.trigger, `${latchPath}.pad.trigger`);
  const latchStickX = requireFinite(
    latchPad.mainStickX,
    `${latchPath}.pad.mainStickX`,
  );
  if (latchStickX > -0.5) {
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

  const latchController = requireExactKeys(
    latch.controller,
    LATCH_CONTROLLER_FIELDS,
    `${latchPath}.controller`,
  );
  requireExact(
    latchController.inputSource,
    post.guest.pad.address,
    `${latchPath}.controller.inputSource`,
  );
  const latchMagnitude = requireFinite(
    latchController.mainStickMagnitude,
    `${latchPath}.controller.mainStickMagnitude`,
  );
  if (latchMagnitude < 0.5 || latchMagnitude > 1.001) {
    fail(
      `${latchPath}.controller.mainStickMagnitude`,
      "expected the PlayerController to consume an active stick",
    );
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

  const movementSquared = displacementSquared(
    baseline.currentPosition,
    post.currentPosition,
  );
  if (movementSquared <= MINIMUM_MOVEMENT_SQUARED) {
    fail(
      "$.postReport.guestGame.currentPlayerPosition",
      "expected a causal player-position change after the consumed input",
    );
  }
  const postLatchMovementSquared = displacementSquared(
    latchPosition,
    post.currentPosition,
  );
  if (postLatchMovementSquared <= MINIMUM_MOVEMENT_SQUARED) {
    fail(
      "$.postReport.guestGame.currentPlayerPosition",
      "expected player movement after the retained guest-input receipt",
    );
  }

  return Object.freeze({
    kind: "luigis-mansion-foyer-left-v1",
    cycle,
    roomInfo: hexU32(LUIGIS_MANSION_FOYER_ROOM_INFO),
    player: post.guest.player.address,
    baseline: Object.freeze({
      cycle: preReport.cycles,
      position: baseline.currentPosition,
      heading: baseline.heading,
    }),
    receipt: Object.freeze({
      position: latchPosition,
      heading: latchHeading,
      held: latchPad.held,
      mainStickX: latchStickX,
      mainStickValue: latchStickValue,
      controllerMagnitude: latchMagnitude,
    }),
    post: Object.freeze({
      cycle: postReport.cycles,
      position: post.currentPosition,
      heading: post.heading,
    }),
    movement: Object.freeze({
      distanceSquared: movementSquared,
      postLatchDistanceSquared: postLatchMovementSquared,
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
