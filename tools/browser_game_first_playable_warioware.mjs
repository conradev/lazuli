// SPDX-License-Identifier: GPL-3.0-only

import {
  GameFirstPlayableTranscriptError,
} from "./browser_game_first_playable_transcript_core.mjs";

export const WARIOWARE_FIRST_PLAYABLE_GAME_KEY = "warioware-usa";
export const WARIOWARE_FIRST_PLAYABLE_REPELLION_ID = 0x63;

const PUBLICATION_FIELDS = Object.freeze([
  "source",
  "pollIndex",
  "scheduledCycle",
  "observedCycle",
  "buttons",
  "sequence",
]);
const GAMEPLAY_INPUT_FIELDS = Object.freeze([
  "cycle",
  "buttons",
  "controllerAppliedSequence",
  "hostPublication",
  "playerObject",
  "playerObjectResult",
]);
const HEX_U32_PATTERN = /^0x[0-9a-f]{8}$/;

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

function requireU16(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    fail(path, "expected an unsigned 16-bit integer");
  }
  return value;
}

function requireHexU32(value, path) {
  if (typeof value !== "string" || !HEX_U32_PATTERN.test(value)) {
    fail(path, "expected a lowercase eight-digit hexadecimal u32");
  }
  return Number.parseInt(value.slice(2), 16);
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

function hexU32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

export function projectWarioWareGuestConsumption({
  button,
  game,
  postReport,
  preReport,
  publication,
}) {
  if (game.key !== WARIOWARE_FIRST_PLAYABLE_GAME_KEY) return null;
  requireExact(button, "a", "$.button");
  const baselinePath = "$.preReport.guestGame";
  const baseline = requireObject(preReport.guestGame, baselinePath);
  requireExact(
    baseline.activeMicrogameId,
    WARIOWARE_FIRST_PLAYABLE_REPELLION_ID,
    `${baselinePath}.activeMicrogameId`,
  );
  requireExact(
    baseline.player0RepellionActive,
    true,
    `${baselinePath}.player0RepellionActive`,
  );
  requireExact(
    baseline.noCardFlowActive,
    false,
    `${baselinePath}.noCardFlowActive`,
  );
  const baselineRuntime = requireHexU32(
    baseline.runtime,
    `${baselinePath}.runtime`,
  );
  if (baselineRuntime < 0x80000000 || baselineRuntime > 0x817b4c04) {
    fail(`${baselinePath}.runtime`, "expected a mapped MEM1 runtime");
  }
  requireExact(
    baseline.gameplayButtonsAddress,
    hexU32(baselineRuntime + 0x4b160),
    `${baselinePath}.gameplayButtonsAddress`,
  );
  const baselineButtons = requireU16(
    baseline.gameplayButtons,
    `${baselinePath}.gameplayButtons`,
  );
  if ((baselineButtons & 0x0100) !== 0) {
    fail(`${baselinePath}.gameplayButtons`, "expected A to be inactive");
  }
  requireExact(baseline.aActive, false, `${baselinePath}.aActive`);
  requireExact(
    baseline.playerObjectPointerAddress,
    hexU32(baselineRuntime + 0x4b178),
    `${baselinePath}.playerObjectPointerAddress`,
  );
  const baselinePlayerObject = requireHexU32(
    baseline.playerObject,
    `${baselinePath}.playerObject`,
  );
  if (
    baselinePlayerObject < 0x80000000
    || baselinePlayerObject > 0x817fedcc
  ) {
    fail(`${baselinePath}.playerObject`, "expected a mapped MEM1 player object");
  }
  requireExact(
    baseline.playerObjectResultAddress,
    hexU32(baselinePlayerObject + 0x1230),
    `${baselinePath}.playerObjectResultAddress`,
  );
  const baselinePlayerObjectResult = requireS32(
    baseline.playerObjectResult,
    `${baselinePath}.playerObjectResult`,
  );
  requireExact(
    baselinePlayerObjectResult,
    0,
    `${baselinePath}.playerObjectResult`,
  );

  const path = "$.postReport.guestGame";
  const guest = requireObject(postReport.guestGame, path);
  requireExact(
    guest.activeMicrogameId,
    WARIOWARE_FIRST_PLAYABLE_REPELLION_ID,
    `${path}.activeMicrogameId`,
  );
  requireExact(
    guest.player0RepellionActive,
    true,
    `${path}.player0RepellionActive`,
  );
  requireExact(guest.noCardFlowActive, false, `${path}.noCardFlowActive`);

  const runtime = requireHexU32(guest.runtime, `${path}.runtime`);
  if (runtime < 0x80000000 || runtime > 0x817b4c04) {
    fail(`${path}.runtime`, "expected a mapped MEM1 runtime");
  }
  requireExact(runtime, baselineRuntime, `${path}.runtime`);
  requireExact(
    guest.gameplayButtonsAddress,
    hexU32(runtime + 0x4b160),
    `${path}.gameplayButtonsAddress`,
  );
  requireExact(
    guest.playerObjectPointerAddress,
    hexU32(runtime + 0x4b178),
    `${path}.playerObjectPointerAddress`,
  );
  requireExact(
    guest.playerResultAddress,
    hexU32(runtime + 0x4b3f8),
    `${path}.playerResultAddress`,
  );

  const playerObject = requireHexU32(
    guest.playerObject,
    `${path}.playerObject`,
  );
  if (playerObject < 0x80000000 || playerObject > 0x817fedcc) {
    fail(`${path}.playerObject`, "expected a mapped MEM1 player object");
  }
  requireExact(playerObject, baselinePlayerObject, `${path}.playerObject`);
  requireExact(
    guest.playerObjectResultAddress,
    hexU32(playerObject + 0x1230),
    `${path}.playerObjectResultAddress`,
  );

  const latchPath = `${path}.lastActiveGameplayInput`;
  const latch = requireExactKeys(
    guest.lastActiveGameplayInput,
    GAMEPLAY_INPUT_FIELDS,
    latchPath,
  );
  const cycle = requireNonNegativeInteger(latch.cycle, `${latchPath}.cycle`);
  if (cycle < preReport.cycles || cycle > postReport.cycles) {
    fail(
      `${latchPath}.cycle`,
      `expected a value from ${preReport.cycles} through ${postReport.cycles}`,
    );
  }
  requireExact(latch.buttons, 0x0100, `${latchPath}.buttons`);
  requireExact(latch.playerObject, guest.playerObject, `${latchPath}.playerObject`);
  const playerObjectResult = requireS32(
    latch.playerObjectResult,
    `${latchPath}.playerObjectResult`,
  );

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
  requireExact(
    hostPublication.buttons,
    0x0100,
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

  return Object.freeze({
    kind: "warioware-repellion-a-v1",
    activeMicrogameId: WARIOWARE_FIRST_PLAYABLE_REPELLION_ID,
    baseline: Object.freeze({
      cycle: preReport.cycles,
      runtime: baseline.runtime,
      gameplayButtonsAddress: baseline.gameplayButtonsAddress,
      buttons: baselineButtons,
      playerObject: baseline.playerObject,
      playerObjectResult: baselinePlayerObjectResult,
    }),
    runtime: guest.runtime,
    gameplayButtonsAddress: guest.gameplayButtonsAddress,
    cycle,
    buttons: latch.buttons,
    controllerAppliedSequence: latch.controllerAppliedSequence,
    hostPublication: Object.freeze({
      source: hostPublication.source,
      pollIndex: hostPollIndex,
      scheduledCycle: hostScheduledCycle,
      observedCycle: hostObservedCycle,
      buttons: hostPublication.buttons,
      sequence: hostSequence,
    }),
    playerObject: latch.playerObject,
    playerObjectResult,
  });
}
