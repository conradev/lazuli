// SPDX-License-Identifier: GPL-3.0-only

import {
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  assertCheckpointJsonValue,
  canonicalCheckpointValue,
  checkpointFieldsForSchema,
  checkpointSha256,
  checkpointValidationFailure,
  describeCheckpointValue,
  requireCheckpointNonNegativeInteger,
  requireCheckpointObject,
} from "./browser_boot_checkpoint_core.mjs";
import {
  verifySmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  SMB_TEMPORAL_XFB_CAPACITY,
  projectSmbTemporalSelectedXfb,
} from "./browser_boot_temporal_xfb.mjs";

const SUPER_MONKEY_BALL_READY_TITLE = "Super Monkey Ball (GMBE8P Rev.00)";

export const SUPER_MONKEY_BALL_READY_CHECKPOINT = Object.freeze({
  schema: BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  id: "smb-usa/smb-ready-play/render-every-1/temporal-xfb-8",
  game: Object.freeze({
    identifier: "GMBE8P",
    revision: 0,
    image: Object.freeze({
      algorithm: "sha256",
      format: "ciso",
      sha256: "441a0eadc85afb501e2a3db5af2ee81d4783b96a58f6a2df2605f5c33dcb6202",
    }),
  }),
  run: Object.freeze({
    scenario: "smb-ready-play",
    renderEvery: 1,
    renderer: "wgpu-webgpu",
    temporalXfbCapacity: SMB_TEMPORAL_XFB_CAPACITY,
    cleanRunsRequired: 3,
  }),
});

function requireExactKeys(value, expectedKeys, path) {
  requireCheckpointObject(value, path);
  const actualKeys = Object.keys(value).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== wantedKeys.length
    || actualKeys.some((key, index) => key !== wantedKeys[index])
  ) {
    checkpointValidationFailure(
      `${path}.[keys]`,
      `expected ${describeCheckpointValue(wantedKeys)}, got ${describeCheckpointValue(actualKeys)}`,
    );
  }
  return value;
}

function requireExact(value, expected, path) {
  if (value !== expected) {
    checkpointValidationFailure(
      path,
      `expected ${describeCheckpointValue(expected)}, got ${describeCheckpointValue(value)}`,
    );
  }
  return value;
}

function requirePositiveInteger(value, path) {
  const integer = requireCheckpointNonNegativeInteger(value, path);
  if (integer === 0) checkpointValidationFailure(path, "expected a positive integer");
  return integer;
}

function requireZero(value, path) {
  const integer = requireCheckpointNonNegativeInteger(value, path);
  if (integer !== 0) checkpointValidationFailure(path, `expected 0, got ${integer}`);
  return integer;
}

export function validateSmbReadyCheckpointOptions(
  profile = SUPER_MONKEY_BALL_READY_CHECKPOINT,
  path = "$expected",
) {
  assertCheckpointJsonValue(profile, path);
  requireExactKeys(profile, ["schema", "id", "game", "run"], path);
  requireExact(profile.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA_V3, `${path}.schema`);
  requireExact(
    profile.id,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.id,
    `${path}.id`,
  );

  const game = requireExactKeys(
    profile.game,
    ["identifier", "revision", "image"],
    `${path}.game`,
  );
  requireExact(
    game.identifier,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game.identifier,
    `${path}.game.identifier`,
  );
  requireExact(
    game.revision,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game.revision,
    `${path}.game.revision`,
  );
  const image = requireExactKeys(
    game.image,
    ["algorithm", "format", "sha256"],
    `${path}.game.image`,
  );
  for (const field of ["algorithm", "format", "sha256"]) {
    requireExact(
      image[field],
      SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image[field],
      `${path}.game.image.${field}`,
    );
  }

  const run = requireExactKeys(
    profile.run,
    ["scenario", "renderEvery", "renderer", "temporalXfbCapacity", "cleanRunsRequired"],
    `${path}.run`,
  );
  for (const field of [
    "scenario",
    "renderEvery",
    "renderer",
    "temporalXfbCapacity",
    "cleanRunsRequired",
  ]) {
    requireExact(
      run[field],
      SUPER_MONKEY_BALL_READY_CHECKPOINT.run[field],
      `${path}.run.${field}`,
    );
  }
  return profile;
}

function validateRendererHealth(report, expected) {
  const scheduler = requireCheckpointObject(
    report.execution?.scheduler,
    "$.execution.scheduler",
  );
  requireExact(
    requirePositiveInteger(
      scheduler.renderEvery,
      "$.execution.scheduler.renderEvery",
    ),
    expected.run.renderEvery,
    "$.execution.scheduler.renderEvery",
  );

  const rendererSync = requireCheckpointObject(
    scheduler.rendererSync,
    "$.execution.scheduler.rendererSync",
  );
  const sync = {};
  for (const field of [
    "posted",
    "acknowledged",
    "failed",
    "inFlight",
    "highWater",
    "resultMisses",
  ]) {
    sync[field] = requireCheckpointNonNegativeInteger(
      rendererSync[field],
      `$.execution.scheduler.rendererSync.${field}`,
    );
  }
  if (sync.posted === 0) {
    checkpointValidationFailure(
      "$.execution.scheduler.rendererSync.posted",
      "expected at least one WebGPU renderer operation",
    );
  }
  for (const field of ["failed", "inFlight", "resultMisses"]) {
    requireZero(sync[field], `$.execution.scheduler.rendererSync.${field}`);
  }
  requireExact(
    sync.acknowledged,
    sync.posted,
    "$.execution.scheduler.rendererSync.acknowledged",
  );
  if (sync.highWater > 1) {
    checkpointValidationFailure(
      "$.execution.scheduler.rendererSync.highWater",
      `expected at most 1, got ${sync.highWater}`,
    );
  }

  const rendering = requireCheckpointObject(report.rendering, "$.rendering");
  requireExact(rendering.backend, expected.run.renderer, "$.rendering.backend");
  if (rendering.error !== undefined && rendering.error !== null) {
    checkpointValidationFailure(
      "$.rendering.error",
      `renderer reported ${describeCheckpointValue(rendering.error)}`,
    );
  }
  const metrics = requireCheckpointObject(rendering.metrics, "$.rendering.metrics");
  requireExact(metrics.scope, "current-worker", "$.rendering.metrics.scope");
  const operations = requireCheckpointObject(
    metrics.operations,
    "$.rendering.metrics.operations",
  );
  requirePositiveInteger(
    operations.enqueued,
    "$.rendering.metrics.operations.enqueued",
  );
  requireZero(operations.pending, "$.rendering.metrics.operations.pending");
  const operationHighWater = requireCheckpointNonNegativeInteger(
    operations.highWater,
    "$.rendering.metrics.operations.highWater",
  );
  if (operationHighWater > 1) {
    checkpointValidationFailure(
      "$.rendering.metrics.operations.highWater",
      `expected at most 1, got ${operationHighWater}`,
    );
  }
  requirePositiveInteger(
    metrics.webgpu?.checkHealthCalls,
    "$.rendering.metrics.webgpu.checkHealthCalls",
  );
  return { rendering, sync };
}

function validateDeviceHealth(report) {
  requireExact(report.diskCommands?.lastError, "0x00000000", "$.diskCommands.lastError");
  requireZero(report.deviceEvents?.diskDeviceError ?? 0, "$.deviceEvents.diskDeviceError");

  const decoder = requireCheckpointObject(report.gxFifo?.decoder, "$.gxFifo.decoder");
  requirePositiveInteger(decoder.xfbCopyCount, "$.gxFifo.decoder.xfbCopyCount");
  for (const [path, value] of [
    ["$.gxFifo.decoder.unknownOpcodes", decoder.unknownOpcodes],
    ["$.gxFifo.decoder.displayListErrors", decoder.displayListErrors],
    ["$.gxFifo.decoder.vertexDecodeErrors", decoder.vertexDecodeErrors],
    ["$.gxFifo.decoder.textures.decodeErrors", decoder.textures?.decodeErrors],
    ["$.gxFifo.decoder.textures.tlutErrors", decoder.textures?.tlutErrors],
    ["$.controller.queueOverflows", report.controller?.queueOverflows],
    ["$.serialInterface.unknownOutputCommands", report.serialInterface?.unknownOutputCommands],
  ]) {
    requireZero(value, path);
  }

  const exceptionCounts = requireCheckpointObject(
    report.exceptions?.counts,
    "$.exceptions.counts",
  );
  for (const vector of ["0x0200", "0x0300", "0x0400", "0x0600", "0x0700"]) {
    requireZero(exceptionCounts[vector] ?? 0, `$.exceptions.counts[${JSON.stringify(vector)}]`);
  }
}

function validateHeadlessCapture(report, expected) {
  const capture = requireCheckpointObject(report.headlessCapture, "$.headlessCapture");
  requireExact(capture.reuse, null, "$.headlessCapture.reuse");
  if (!Array.isArray(capture.devtoolsExceptions)) {
    checkpointValidationFailure("$.headlessCapture.devtoolsExceptions", "expected an array");
  }
  if (capture.devtoolsExceptions.length !== 0) {
    checkpointValidationFailure(
      "$.headlessCapture.devtoolsExceptions[0]",
      `unexpected page exception ${describeCheckpointValue(capture.devtoolsExceptions[0])}`,
    );
  }
  const dataset = requireCheckpointObject(capture.dataset, "$.headlessCapture.dataset");
  requireExact(dataset.renderer, expected.run.renderer, "$.headlessCapture.dataset.renderer");
  if (dataset.renderEvery !== undefined) {
    requireExact(
      dataset.renderEvery,
      String(expected.run.renderEvery),
      "$.headlessCapture.dataset.renderEvery",
    );
  }

  const discImage = requireExactKeys(
    capture.discImage,
    ["algorithm", "format", "sha256"],
    "$.headlessCapture.discImage",
  );
  for (const field of ["algorithm", "format", "sha256"]) {
    requireExact(
      discImage[field],
      expected.game.image[field],
      `$.headlessCapture.discImage.${field}`,
    );
  }
}

function validateTerminalPresentation(report, rendering, temporalSelectedXfb, sync) {
  const lastFrame = temporalSelectedXfb.frames.at(-1);
  requireExact(
    sync.acknowledged,
    lastFrame.rendererSequence,
    "$.execution.scheduler.rendererSync.acknowledged",
  );

  const selected = requireCheckpointObject(
    rendering.selectedXfb,
    "$.rendering.selectedXfb",
  );
  for (const field of [
    "address",
    "generation",
    "row",
    "format",
    "layout",
    "sourceRow",
    "width",
    "height",
    "textureWidth",
    "textureHeight",
    "logicalWidth",
    "logicalHeight",
    "displayWidth",
    "displayHeight",
    "scanoutPolicy",
    "fieldStrideBytes",
    "sourceRowStep",
    "fieldHeight",
    "rowRepeat",
    "rgbaByteLength",
    "rgbaSha256",
    "rgbSha256",
  ]) {
    requireExact(
      selected[field],
      lastFrame.selectedXfb[field],
      `$.rendering.selectedXfb.${field}`,
    );
  }
  const selectedRgb = requireCheckpointObject(selected.rgb, "$.rendering.selectedXfb.rgb");
  for (const field of ["black", "white", "other", "unique"]) {
    requireExact(
      selectedRgb[field],
      lastFrame.selectedXfb.rgb[field],
      `$.rendering.selectedXfb.rgb.${field}`,
    );
  }

  const vi = requireCheckpointObject(
    report.mmioState?.viInterruptModel,
    "$.mmioState.viInterruptModel",
  );
  requirePositiveInteger(
    vi.presentationCount,
    "$.mmioState.viInterruptModel.presentationCount",
  );
  for (const [field, expected] of [
    ["lastPresentationField", lastFrame.presentation.field],
    ["lastPresentationAddress", lastFrame.presentation.address],
    ["lastPresentationCopyIndex", lastFrame.presentation.copyIndex],
    ["lastPresentationCopyRow", lastFrame.presentation.copyRow],
  ]) {
    requireExact(vi[field], expected, `$.mmioState.viInterruptModel.${field}`);
  }
}

function validateCheckpointEvidence(report, expected) {
  validateSmbReadyCheckpointOptions(expected);
  requireCheckpointObject(report, "$");
  assertCheckpointJsonValue(report);
  if (report.error !== undefined && report.error !== null) {
    checkpointValidationFailure(
      "$.error",
      `emulator reported ${describeCheckpointValue(report.error)}`,
    );
  }
  requireExact(report.status, "paused", "$.status");
  requireExact(report.stage, "scenario-complete", "$.stage");
  requireExact(report.title, SUPER_MONKEY_BALL_READY_TITLE, "$.title");

  const disc = requireCheckpointObject(report.disc, "$.disc");
  requireExact(disc.identifier, expected.game.identifier, "$.disc.identifier");
  requireExact(disc.revision, expected.game.revision, "$.disc.revision");

  const scenario = requireCheckpointObject(report.scenario, "$.scenario");
  requireExact(scenario.id, expected.run.scenario, "$.scenario.id");
  requireExact(scenario.status, "complete", "$.scenario.status");
  requireExact(scenario.failure, null, "$.scenario.failure");
  requireExact(scenario.currentStep, null, "$.scenario.currentStep");

  validateDeviceHealth(report);
  const renderer = validateRendererHealth(report, expected);
  validateHeadlessCapture(report, expected);
  requireCheckpointObject(report.gameplayTranscript, "$.gameplayTranscript");
  const gameplayTranscript = verifySmbReadyPlayGameplayTranscript(
    report,
    report.gameplayTranscript,
  );
  const temporalSelectedXfb = projectSmbTemporalSelectedXfb(
    renderer.rendering.temporalSelectedXfb,
  );
  requireExact(
    temporalSelectedXfb.capacity,
    expected.run.temporalXfbCapacity,
    "$.rendering.temporalSelectedXfb.capacity",
  );
  validateTerminalPresentation(
    report,
    renderer.rendering,
    temporalSelectedXfb,
    renderer.sync,
  );
  return { gameplayTranscript, temporalSelectedXfb };
}

export function validateSmbReadyCheckpointReport(
  report,
  expected = SUPER_MONKEY_BALL_READY_CHECKPOINT,
) {
  validateCheckpointEvidence(report, expected);
  return report;
}

export function projectSmbReadyCheckpointReport(
  report,
  expected = SUPER_MONKEY_BALL_READY_CHECKPOINT,
) {
  const evidence = validateCheckpointEvidence(report, expected);
  return {
    status: report.status,
    stage: report.stage,
    title: report.title,
    disc: {
      identifier: report.disc.identifier,
      revision: report.disc.revision,
    },
    gameplayTranscript: canonicalCheckpointValue(evidence.gameplayTranscript),
    rendering: {
      backend: report.rendering.backend,
      temporalSelectedXfb: canonicalCheckpointValue(evidence.temporalSelectedXfb),
    },
  };
}

export function createSmbReadyCheckpointCandidate(
  report,
  expected = SUPER_MONKEY_BALL_READY_CHECKPOINT,
) {
  const state = projectSmbReadyCheckpointReport(report, expected);
  return {
    schema: expected.schema,
    algorithm: "sha256",
    fields: [...checkpointFieldsForSchema(expected.schema)],
    id: expected.id,
    game: {
      title: state.title,
      identifier: state.disc.identifier,
      revision: state.disc.revision,
      image: canonicalCheckpointValue(expected.game.image),
    },
    checkpoint: {
      status: state.status,
      stage: state.stage,
    },
    run: canonicalCheckpointValue(expected.run),
    sha256: checkpointSha256(state),
    state,
  };
}
