// SPDX-License-Identifier: GPL-3.0-only

import {
  verifySmbTemporalPresentedSurfaces,
} from "./browser_boot_temporal_surface.mjs";
import {
  verifySmbTemporalSelectedXfb,
} from "./browser_boot_temporal_xfb.mjs";
import {
  deriveSmbReadyPlayGameplayTranscript,
  verifySmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";

export const SMB_SUSTAINED_PLAY_SCHEMA_V1 = "lazuli-smb-sustained-play-v1";
export const SMB_SUSTAINED_VI_RECEIPT_CAPACITY = 120;

const HEX_32 = /^0x[0-9a-f]{8}$/;
const READY_PLAY_PREFIX = Object.freeze([
  "memory-card-back",
  "skip-opening-demo",
  "opening-demo-skipped",
  "title-start",
  "title-game-start",
  "select-current-8",
  "select-current-10",
  "select-current-16",
  "select-current-18",
  "select-current-22",
  "ready-main",
  "play-main",
  "post-play-presented",
]);

export class SmbSustainedPlayValidationError extends Error {
  constructor(code, path, ordinal, expected, actual, previous = null) {
    const describe = value => {
      if (value === undefined) return "undefined";
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    super(
      `SMB sustained PLAY ${code} at ${path} (ordinal ${ordinal ?? "n/a"}): `
      + `expected ${describe(expected)}, got ${describe(actual)}, `
      + `previous ${describe(previous)}`,
    );
    this.name = "SmbSustainedPlayValidationError";
    this.code = code;
    this.path = path;
    this.ordinal = ordinal;
    this.expected = expected;
    this.actual = actual;
    this.previous = previous;
  }
}

function fail(code, path, ordinal, expected, actual, previous = null) {
  throw new SmbSustainedPlayValidationError(
    code,
    path,
    ordinal,
    expected,
    actual,
    previous,
  );
}

function requireObject(value, path, ordinal = null) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("envelope", path, ordinal, "an object", value);
  }
  return value;
}

function exact(value, expected, path, ordinal = null, previous = null) {
  if (value !== expected) {
    fail("invariant", path, ordinal, expected, value, previous);
  }
  return value;
}

function nonNegativeInteger(value, path, ordinal = null, previous = null) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("envelope", path, ordinal, "a non-negative safe integer", value, previous);
  }
  return value;
}

function positiveInteger(value, path, ordinal = null, previous = null) {
  const result = nonNegativeInteger(value, path, ordinal, previous);
  if (result === 0) fail("envelope", path, ordinal, "a positive safe integer", value, previous);
  return result;
}

function exactKeys(value, expectedKeys, path, ordinal = null) {
  requireObject(value, path, ordinal);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail("envelope", `${path}.[keys]`, ordinal, expected, actual);
  }
  return value;
}

function validateReceipt(receipt, index, previous, parityAddresses) {
  const ordinal = index + 1;
  const path = `$.sustainedPlay.receipts[${index}]`;
  exactKeys(receipt, [
    "scenario",
    "step",
    "ordinal",
    "capacity",
    "rendererSequence",
    "drained",
    "presented",
    "presentation",
    "gameplay",
  ], path, ordinal);
  exact(receipt.scenario, "smb-sustained-play", `${path}.scenario`, ordinal);
  exact(receipt.step, "sustained-play-presented", `${path}.step`, ordinal);
  exact(receipt.ordinal, ordinal, `${path}.ordinal`, ordinal, previous?.ordinal ?? null);
  exact(
    receipt.capacity,
    SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    `${path}.capacity`,
    ordinal,
  );
  const rendererSequence = positiveInteger(
    receipt.rendererSequence,
    `${path}.rendererSequence`,
    ordinal,
    previous?.rendererSequence ?? null,
  );
  if (previous !== null && rendererSequence <= previous.rendererSequence) {
    fail(
      "ordering",
      `${path}.rendererSequence`,
      ordinal,
      `a value greater than ${previous.rendererSequence}`,
      rendererSequence,
      previous.rendererSequence,
    );
  }
  exact(receipt.drained, true, `${path}.drained`, ordinal);
  exact(receipt.presented, true, `${path}.presented`, ordinal);

  const presentation = exactKeys(receipt.presentation, [
    "field",
    "address",
    "copyIndex",
    "copyRow",
    "width",
    "height",
  ], `${path}.presentation`, ordinal);
  const previousField = previous?.presentation.field ?? null;
  const expectedField = previousField === null
    ? presentation.field
    : previousField === "top" ? "bottom" : "top";
  if (
    (presentation.field !== "top" && presentation.field !== "bottom")
    || presentation.field !== expectedField
  ) {
    fail(
      "invariant",
      `${path}.presentation.field`,
      ordinal,
      previousField === null ? "top or bottom" : expectedField,
      presentation.field,
      previousField,
    );
  }
  const expectedRow = expectedField === "top" ? 0 : 1;
  exact(
    presentation.copyRow,
    expectedRow,
    `${path}.presentation.copyRow`,
    ordinal,
    previous?.presentation.copyRow ?? null,
  );
  exact(
    presentation.width,
    640,
    `${path}.presentation.width`,
    ordinal,
    previous?.presentation.width ?? null,
  );
  exact(
    presentation.height,
    448,
    `${path}.presentation.height`,
    ordinal,
    previous?.presentation.height ?? null,
  );
  if (typeof presentation.address !== "string" || !HEX_32.test(presentation.address)) {
    fail(
      "envelope",
      `${path}.presentation.address`,
      ordinal,
      "a lowercase 32-bit hexadecimal address",
      presentation.address,
      previous?.presentation.address ?? null,
    );
  }
  const parityAddress = parityAddresses[expectedField];
  if (parityAddress === null) {
    const opposite = parityAddresses[expectedField === "top" ? "bottom" : "top"];
    if (opposite !== null && presentation.address === opposite) {
      fail(
        "provenance",
        `${path}.presentation.address`,
        ordinal,
        `an address distinct from ${opposite}`,
        presentation.address,
        opposite,
      );
    }
    parityAddresses[expectedField] = presentation.address;
  } else {
    exact(
      presentation.address,
      parityAddress,
      `${path}.presentation.address`,
      ordinal,
      parityAddress,
    );
  }
  const copyIndex = positiveInteger(
    presentation.copyIndex,
    `${path}.presentation.copyIndex`,
    ordinal,
    previous?.presentation.copyIndex ?? null,
  );
  if (previous !== null && copyIndex <= previous.presentation.copyIndex) {
    fail(
      "ordering",
      `${path}.presentation.copyIndex`,
      ordinal,
      `a value greater than ${previous.presentation.copyIndex}`,
      copyIndex,
      previous.presentation.copyIndex,
    );
  }

  const gameplay = exactKeys(receipt.gameplay, [
    "gameModeRequest",
    "gameMode",
    "gameSubmodeRequest",
    "gameSubmode",
    "infoTimer",
    "attempts",
    "floor",
  ], `${path}.gameplay`, ordinal);
  for (const [field, expected] of [
    ["gameModeRequest", -1],
    ["gameMode", 2],
    ["gameSubmodeRequest", -1],
    ["gameSubmode", 51],
    ["attempts", 1],
    ["floor", 1],
  ]) {
    exact(
      gameplay[field],
      expected,
      `${path}.gameplay.${field}`,
      ordinal,
      previous?.gameplay[field] ?? null,
    );
  }
  if (!Number.isSafeInteger(gameplay.infoTimer)) {
    fail(
      "envelope",
      `${path}.gameplay.infoTimer`,
      ordinal,
      "a safe integer",
      gameplay.infoTimer,
      previous?.gameplay.infoTimer ?? null,
    );
  }
  if (previous !== null) {
    exact(
      gameplay.infoTimer,
      previous.gameplay.infoTimer - 1,
      `${path}.gameplay.infoTimer`,
      ordinal,
      previous.gameplay.infoTimer,
    );
  }
  return receipt;
}

function validateInputWitness(scenario) {
  const path = "$.scenario.steps[13]";
  const input = scenario.steps[13];
  requireObject(input, path);
  exact(input.id, "sustained-main-stick-left", `${path}.id`);
  exact(input.type, "state-input", `${path}.type`);
  exact(input.owner, "page", `${path}.owner`);
  const active = requireObject(input.active, `${path}.active`);
  const neutral = requireObject(input.neutral, `${path}.neutral`);
  const validateControllerState = (state, stickX, statePath) => {
    exactKeys(state, [
      "buttons",
      "stickX",
      "stickY",
      "cStickX",
      "cStickY",
      "triggerL",
      "triggerR",
      "analogA",
      "analogB",
    ], statePath);
    for (const [field, expected] of [
      ["buttons", 0],
      ["stickX", stickX],
      ["stickY", 0x80],
      ["cStickX", 0x80],
      ["cStickY", 0x80],
      ["triggerL", 0],
      ["triggerR", 0],
      ["analogA", 0],
      ["analogB", 0],
    ]) exact(state[field], expected, `${statePath}.${field}`);
  };
  exact(active.polls, 30, `${path}.active.polls`);
  validateControllerState(active.state, 0x1c, `${path}.active.state`);
  exact(active.publications?.length, 30, `${path}.active.publications.length`);
  for (let index = 0; index < active.publications.length; index += 1) {
    validateControllerState(
      active.publications[index].state,
      0x1c,
      `${path}.active.publications[${index}].state`,
    );
  }
  nonNegativeInteger(neutral.polls, `${path}.neutral.polls`);
  if (neutral.polls < 3) {
    fail("invariant", `${path}.neutral.polls`, null, "at least 3", neutral.polls);
  }
  validateControllerState(neutral.state, 0x80, `${path}.neutral.state`);
  exact(
    neutral.publications?.length,
    neutral.polls,
    `${path}.neutral.publications.length`,
  );
  for (let index = 0; index < neutral.publications.length; index += 1) {
    validateControllerState(
      neutral.publications[index].state,
      0x80,
      `${path}.neutral.publications[${index}].state`,
    );
  }
  const validateGuestGameplay = (state, expectedStickX, activeState, statePath) => {
    requireObject(state, statePath);
    exact(state.padStatus?.error, 0, `${statePath}.padStatus.error`);
    exact(state.padStatus?.stickX, expectedStickX, `${statePath}.padStatus.stickX`);
    const gameplay = requireObject(state.gameplayInput, `${statePath}.gameplayInput`);
    const currentPlayer = nonNegativeInteger(
      gameplay.currentPlayer,
      `${statePath}.gameplayInput.currentPlayer`,
    );
    if (currentPlayer >= 4) {
      fail(
        "envelope",
        `${statePath}.gameplayInput.currentPlayer`,
        null,
        "an integer from 0 through 3",
        currentPlayer,
      );
    }
    const controller = nonNegativeInteger(
      gameplay.controller,
      `${statePath}.gameplayInput.controller`,
    );
    if (controller >= 4) {
      fail(
        "envelope",
        `${statePath}.gameplayInput.controller`,
        null,
        "an integer from 0 through 3",
        controller,
      );
    }
    const expectedPadAddress = "0x"
      + (0x801f3b70 + controller * 0x3c).toString(16).padStart(8, "0");
    exact(
      gameplay.padStatus?.address,
      expectedPadAddress,
      `${statePath}.gameplayInput.padStatus.address`,
    );
    exact(
      gameplay.padStatus?.error,
      0,
      `${statePath}.gameplayInput.padStatus.error`,
    );
    exact(
      gameplay.padStatus?.stickX,
      expectedStickX,
      `${statePath}.gameplayInput.padStatus.stickX`,
    );
    exact(
      state.padStatus?.address,
      expectedPadAddress,
      `${statePath}.padStatus.address`,
    );
    const world = requireObject(gameplay.world, `${statePath}.gameplayInput.world`);
    const expectedWorldAddress = "0x"
      + (0x80206bf0 + currentPlayer * 0x40).toString(16).padStart(8, "0");
    exact(world.address, expectedWorldAddress, `${statePath}.gameplayInput.world.address`);
    exact(world.state, 2, `${statePath}.gameplayInput.world.state`);
    exact(world.player, currentPlayer, `${statePath}.gameplayInput.world.player`);
    exact(world.inputLockFrames, 0, `${statePath}.gameplayInput.world.inputLockFrames`);
    for (const axis of ["xrot", "zrot"]) {
      const value = world[axis];
      if (!Number.isSafeInteger(value) || value < -0x8000 || value > 0x7fff) {
        fail(
          "envelope",
          `${statePath}.gameplayInput.world.${axis}`,
          null,
          "a signed 16-bit integer",
          value,
        );
      }
    }
    const maxAbs = Math.max(Math.abs(world.xrot), Math.abs(world.zrot));
    if (activeState) {
      if (maxAbs < 256) {
        fail(
          "invariant",
          `${statePath}.gameplayInput.world.[xrot,zrot]`,
          null,
          "a camera-independent tilt magnitude of at least 256",
          { xrot: world.xrot, zrot: world.zrot, maxAbs },
        );
      }
    } else {
      exact(world.xrot, 0, `${statePath}.gameplayInput.world.xrot`);
      exact(world.zrot, 0, `${statePath}.gameplayInput.world.zrot`);
    }
    return {
      currentPlayer,
      controller,
      worldTilt: {
        xrot: world.xrot,
        zrot: world.zrot,
        maxAbs,
        inputLockFrames: world.inputLockFrames,
      },
    };
  };
  const activeGuest = validateGuestGameplay(
    input.guest?.activeState,
    -60,
    true,
    `${path}.guest.activeState`,
  );
  const neutralGuest = validateGuestGameplay(
    input.guest?.neutralState,
    0,
    false,
    `${path}.guest.neutralState`,
  );
  exact(
    neutralGuest.currentPlayer,
    activeGuest.currentPlayer,
    `${path}.guest.neutralState.gameplayInput.currentPlayer`,
  );
  exact(
    neutralGuest.controller,
    activeGuest.controller,
    `${path}.guest.neutralState.gameplayInput.controller`,
  );
  return {
    activePolls: active.polls,
    neutralPolls: neutral.polls,
    activeWireStickX: active.state.stickX,
    neutralWireStickX: neutral.state.stickX,
    activeGuestStickX: input.guest.activeState.padStatus.stickX,
    neutralGuestStickX: input.guest.neutralState.padStatus.stickX,
    gameplayMapping: {
      currentPlayer: activeGuest.currentPlayer,
      controller: activeGuest.controller,
    },
    activeWorldTilt: activeGuest.worldTilt,
    neutralWorldTilt: neutralGuest.worldTilt,
  };
}

function compareDerived(expected, actual, path = "$.sustainedPlay.oracle") {
  if (expected === null || typeof expected !== "object") {
    exact(actual, expected, path);
    return;
  }
  requireObject(actual, path);
  exactKeys(actual, Object.keys(expected), path);
  for (const [key, value] of Object.entries(expected)) {
    compareDerived(value, actual[key], `${path}.${key}`);
  }
}

function readyPlayAnchorErrorPath(path) {
  if (path === "$report" || path.startsWith("$report.")) {
    return `$.sustainedPlay.readyPlayAnchor${path.slice("$report".length)}`;
  }
  const witness = /^\$\.steps\[(\d+)\]\.(ready|observed)\.witness(.*)$/.exec(path);
  if (witness !== null) {
    const rawState = witness[2] === "ready" ? "readyState" : "state";
    return `$.sustainedPlay.readyPlayAnchor.scenario.steps[${witness[1]}]`
      + `.${rawState}${witness[3]}`;
  }
  return "$.sustainedPlay.readyPlayAnchor";
}

function rethrowReadyPlayValidation(error, fallbackCode, forceAnchor = false) {
  if (typeof error?.path !== "string") throw error;
  const anchorPath = forceAnchor
    || error.path === "$report"
    || error.path.startsWith("$report.");
  const path = anchorPath
    ? readyPlayAnchorErrorPath(error.path)
    : error.path === "$"
      ? "$.gameplayTranscript"
      : error.path.startsWith("$.")
        ? `$.gameplayTranscript${error.path.slice(1)}`
        : "$.gameplayTranscript";
  fail(
    anchorPath ? "ready-play-anchor" : fallbackCode,
    path,
    null,
    anchorPath
      ? "a transcript-valid smb-ready-play checkpoint witness"
      : "the transcript derived from the ready-play anchor",
    error.message,
  );
}

function deriveReadyPlayAnchor(anchor) {
  try {
    return deriveSmbReadyPlayGameplayTranscript(anchor);
  } catch (error) {
    rethrowReadyPlayValidation(error, "ready-play-anchor", true);
  }
}

function verifyReadyPlayLowerLayer(anchor, transcript) {
  try {
    return verifySmbReadyPlayGameplayTranscript(anchor, transcript);
  } catch (error) {
    rethrowReadyPlayValidation(error, "ready-play-transcript");
  }
}

export function deriveSmbSustainedPlayOracle(report) {
  requireObject(report, "$.");
  exact(report.rendering?.backend, "wgpu-webgpu", "$.rendering.backend");
  const scenario = requireObject(report.scenario, "$.scenario");
  exact(scenario.id, "smb-sustained-play", "$.scenario.id");
  if (!Array.isArray(scenario.steps)) {
    fail("envelope", "$.scenario.steps", null, "an array", scenario.steps);
  }
  const expectedSteps = [
    ...READY_PLAY_PREFIX,
    "sustained-main-stick-left",
    "sustained-play-presented",
  ];
  exact(scenario.steps.length, expectedSteps.length, "$.scenario.steps.length");
  for (let index = 0; index < expectedSteps.length; index += 1) {
    exact(
      scenario.steps[index]?.id,
      expectedSteps[index],
      `$.scenario.steps[${index}].id`,
    );
  }
  const input = validateInputWitness(scenario);

  const sustained = requireObject(report.sustainedPlay, "$.sustainedPlay");
  exact(sustained.schema, SMB_SUSTAINED_PLAY_SCHEMA_V1, "$.sustainedPlay.schema");
  const readyPlayAnchor = requireObject(
    sustained.readyPlayAnchor,
    "$.sustainedPlay.readyPlayAnchor",
  );
  deriveReadyPlayAnchor(readyPlayAnchor);
  exact(
    sustained.capacity,
    SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    "$.sustainedPlay.capacity",
  );
  exact(
    sustained.posted,
    SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    "$.sustainedPlay.posted",
  );
  exact(sustained.pending, 0, "$.sustainedPlay.pending");
  exact(sustained.failure, null, "$.sustainedPlay.failure");
  if (!Array.isArray(sustained.receipts)) {
    fail("envelope", "$.sustainedPlay.receipts", null, "an array", sustained.receipts);
  }
  exact(
    sustained.receipts.length,
    SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    "$.sustainedPlay.receipts.length",
  );
  const parityAddresses = { top: null, bottom: null };
  let previous = null;
  for (let index = 0; index < sustained.receipts.length; index += 1) {
    previous = validateReceipt(sustained.receipts[index], index, previous, parityAddresses);
  }
  const first = sustained.receipts[0];
  const last = sustained.receipts.at(-1);
  exact(
    first.gameplay.infoTimer - last.gameplay.infoTimer,
    119,
    "$.sustainedPlay.oracle.infoTimer.delta",
    120,
    first.gameplay.infoTimer,
  );

  const sync = requireObject(
    report.execution?.scheduler?.rendererSync,
    "$.execution.scheduler.rendererSync",
  );
  exact(sync.failed, 0, "$.execution.scheduler.rendererSync.failed");
  exact(sync.inFlight, 0, "$.execution.scheduler.rendererSync.inFlight");
  exact(sync.resultMisses, 0, "$.execution.scheduler.rendererSync.resultMisses");
  exact(sync.acknowledged, sync.posted, "$.execution.scheduler.rendererSync.acknowledged");
  exact(report.rendering?.error ?? null, null, "$.rendering.error");
  exact(report.rendering?.metrics?.operations?.pending, 0, "$.rendering.metrics.operations.pending");
  exact(report.controller?.queueOverflows, 0, "$.controller.queueOverflows");

  return {
    capacity: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    received: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    drained: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    presented: SMB_SUSTAINED_VI_RECEIPT_CAPACITY,
    topFields: 60,
    bottomFields: 60,
    strictAlternation: true,
    correctedRows: true,
    stableParityAddresses: true,
    parityAddresses,
    advancingCopyIndices: true,
    dimensions: { width: 640, height: 448, allMatch: true },
    playInvariants: true,
    infoTimer: {
      first: first.gameplay.infoTimer,
      last: last.gameplay.infoTimer,
      delta: 119,
    },
    input,
    renderer: { failed: 0, inFlight: 0, pendingReceipts: 0 },
    readyPlayAnchorCaptured: true,
    complete: true,
  };
}

export function verifySmbSustainedPlay(report) {
  exact(report?.status, "paused", "$.status");
  exact(report?.stage, "scenario-complete", "$.stage");
  exact(report?.scenario?.status, "complete", "$.scenario.status");
  exact(report?.scenario?.failure, null, "$.scenario.failure");
  exact(report?.scenario?.currentStep, null, "$.scenario.currentStep");
  exact(report?.scenario?.stepIndex, 15, "$.scenario.stepIndex");
  verifySmbTemporalSelectedXfb(report?.rendering?.temporalSelectedXfb);
  verifySmbTemporalPresentedSurfaces(report?.rendering?.temporalSelectedXfb);
  const derived = deriveSmbSustainedPlayOracle(report);
  compareDerived(derived, report.sustainedPlay.oracle);
  verifyReadyPlayLowerLayer(
    report.sustainedPlay.readyPlayAnchor,
    report.gameplayTranscript,
  );
  return derived;
}
