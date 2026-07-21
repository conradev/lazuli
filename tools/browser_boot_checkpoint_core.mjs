// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";

export const BROWSER_BOOT_CHECKPOINT_SCHEMA = "lazuli-browser-boot-checkpoint-v1";
export const SUPER_MONKEY_BALL_CHECKPOINT = Object.freeze({
  id: "smb-usa/no-input/cycles-1500000000/render-every-1",
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
    cycles: 1_500_000_000,
    renderEvery: 1,
    renderer: "wgpu-webgpu",
    inputs: Object.freeze([]),
    cleanRunsRequired: 3,
  }),
});

// This is deliberately an allowlist. Browser reports contain useful live
// diagnostics such as user-agent strings, URLs, cache residency and host wait
// counts, but those values must never bless or break a guest-state golden.
export const BROWSER_BOOT_CHECKPOINT_FIELDS = Object.freeze([
  "/status",
  "/stage",
  "/title",
  "/disc/identifier",
  "/disc/revision",
  "/limits/cycles",
  "/limits/dispatches",
  "/cycles",
  "/instructions",
  "/dispatches",
  "/pc",
  "/cpuState/pc",
  "/cpuState/msr",
  "/cpuState/lr",
  "/cpuState/ctr",
  "/cpuState/srr0",
  "/cpuState/srr1",
  "/cpuState/gpr",
  "/cpuState/signature",
  "/guestGame",
  "/execution/scheduler/renderEvery",
  "/execution/scheduler/rendererSync/posted",
  "/execution/scheduler/rendererSync/acknowledged",
  "/execution/scheduler/rendererSync/failed",
  "/execution/scheduler/rendererSync/inFlight",
  "/execution/scheduler/rendererSync/highWater",
  "/execution/scheduler/rendererSync/resultMisses",
  "/gxFifo/bytes",
  "/gxFifo/hash",
  "/gxFifo/decoder/commands",
  "/gxFifo/decoder/cpLoads",
  "/gxFifo/decoder/xfLoads",
  "/gxFifo/decoder/indexedXfLoads",
  "/gxFifo/decoder/bpLoads",
  "/gxFifo/decoder/displayLists",
  "/gxFifo/decoder/displayListBytes",
  "/gxFifo/decoder/primitives",
  "/gxFifo/decoder/vertices",
  "/gxFifo/decoder/unknownOpcodes",
  "/gxFifo/decoder/xfbCopyCount",
  "/gxFifo/decoder/textureCopyCount",
  "/diskReads/hashedBytes",
  "/diskReads/hash",
  "/exceptions/counts",
  "/controller/pendingButtons",
  "/controller/lastPolledButtons",
  "/controller/guestPad",
  "/mmioState/viInterruptModel/presentationCount",
  "/mmioState/viInterruptModel/lastPresentationCycle",
  "/mmioState/viInterruptModel/lastPresentationField",
  "/mmioState/viInterruptModel/lastPresentationAddress",
]);

const CHECKPOINT_POINTER_PARTS = BROWSER_BOOT_CHECKPOINT_FIELDS.map(pointer => [
  pointer,
  pointer.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~")),
]);

export class CheckpointValidationError extends Error {
  constructor(path, detail) {
    super(`checkpoint invariant failed at ${path}: ${detail}`);
    this.name = "CheckpointValidationError";
    this.path = path;
  }
}

export function checkpointChildPath(path, key) {
  if (typeof key === "number") return `${path}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

export function checkpointValidationFailure(path, detail) {
  throw new CheckpointValidationError(path, detail);
}

export function requireCheckpointObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    checkpointValidationFailure(path, "expected an object");
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    checkpointValidationFailure(path, "expected a non-empty string");
  }
  return value;
}

export function requireCheckpointNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    checkpointValidationFailure(path, "expected a non-negative safe integer");
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

function requireHex32(value, path) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{8}$/.test(value)) {
    checkpointValidationFailure(path, "expected a lowercase 32-bit hexadecimal value");
  }
  return value;
}

export function validateCheckpointOptions(options, path = "$expected") {
  requireCheckpointObject(options, path);
  requireString(options.id, `${path}.id`);
  const game = requireCheckpointObject(options.game, `${path}.game`);
  requireString(game.identifier, `${path}.game.identifier`);
  requireCheckpointNonNegativeInteger(game.revision, `${path}.game.revision`);
  const image = requireCheckpointObject(game.image, `${path}.game.image`);
  if (image.algorithm !== "sha256") {
    checkpointValidationFailure(
      `${path}.game.image.algorithm`,
      `expected "sha256", got ${describeCheckpointValue(image.algorithm)}`,
    );
  }
  requireString(image.format, `${path}.game.image.format`);
  if (typeof image.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(image.sha256)) {
    checkpointValidationFailure(
      `${path}.game.image.sha256`,
      "expected a lowercase SHA-256 digest",
    );
  }
  const run = requireCheckpointObject(options.run, `${path}.run`);
  requirePositiveInteger(run.cycles, `${path}.run.cycles`);
  requirePositiveInteger(run.renderEvery, `${path}.run.renderEvery`);
  const renderer = requireString(run.renderer, `${path}.run.renderer`);
  if (renderer !== "wgpu-webgpu") {
    checkpointValidationFailure(
      `${path}.run.renderer`,
      `expected "wgpu-webgpu", got ${describeCheckpointValue(renderer)}`,
    );
  }
  if (!Array.isArray(run.inputs)) {
    checkpointValidationFailure(`${path}.run.inputs`, "expected an array");
  }
  assertCheckpointJsonValue(run.inputs, `${path}.run.inputs`);
  const cleanRunsRequired = requirePositiveInteger(
    run.cleanRunsRequired,
    `${path}.run.cleanRunsRequired`,
  );
  if (cleanRunsRequired < 3) {
    checkpointValidationFailure(`${path}.run.cleanRunsRequired`, "expected at least 3");
  }
  return options;
}

export function assertCheckpointJsonValue(value, path = "$", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      checkpointValidationFailure(path, "non-finite numbers are not canonical JSON");
    }
    return;
  }
  if (typeof value !== "object") {
    checkpointValidationFailure(path, `unsupported ${typeof value} value`);
  }
  if (ancestors.has(value)) checkpointValidationFailure(path, "cyclic values are not canonical JSON");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        checkpointValidationFailure(checkpointChildPath(path, index), "sparse array entry");
      }
      assertCheckpointJsonValue(value[index], checkpointChildPath(path, index), ancestors);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertCheckpointJsonValue(child, checkpointChildPath(path, key), ancestors);
    }
  }
  ancestors.delete(value);
}

export function canonicalCheckpointValue(value) {
  if (Array.isArray(value)) return value.map(canonicalCheckpointValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalCheckpointValue(value[key])]),
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalStringify(value) {
  assertCheckpointJsonValue(value);
  return JSON.stringify(canonicalCheckpointValue(value));
}

export function describeCheckpointValue(value) {
  let text;
  try {
    text = canonicalStringify(value);
  } catch {
    text = String(value);
  }
  return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
}

function reportPath(parts, base = "$") {
  return parts.reduce((path, part) => checkpointChildPath(path, part), base);
}

function pointerValue(object, pointer, parts, base = "$") {
  let value = object;
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
      checkpointValidationFailure(reportPath(parts, base), `missing checkpoint field ${pointer}`);
    }
    value = value[part];
  }
  return value;
}

function assignPointer(object, parts, value) {
  let target = object;
  for (const part of parts.slice(0, -1)) {
    target[part] ??= {};
    target = target[part];
  }
  target[parts.at(-1)] = canonicalCheckpointValue(value);
}

export function validateCheckpointReport(report, expected = SUPER_MONKEY_BALL_CHECKPOINT) {
  requireCheckpointObject(report, "$");
  validateCheckpointOptions(expected);
  assertCheckpointJsonValue(report);

  const status = requireString(report.status, "$.status");
  if (status === "stopped" || report.error !== undefined) {
    checkpointValidationFailure(
      report.error === undefined ? "$.status" : "$.error",
      report.error === undefined
        ? "a stopped report is not a compatibility checkpoint"
        : `emulator reported ${describeCheckpointValue(report.error)}`,
    );
  }
  if (status !== "paused") {
    checkpointValidationFailure(
      "$.status",
      `expected \"paused\", got ${describeCheckpointValue(status)}`,
    );
  }
  const stage = requireString(report.stage, "$.stage");
  if (stage !== "cycle-limit") {
    checkpointValidationFailure(
      "$.stage",
      `expected \"cycle-limit\", got ${describeCheckpointValue(stage)}`,
    );
  }
  const pc = requireHex32(report.pc, "$.pc");
  for (const field of ["instructions", "cycles", "dispatches"]) {
    requireCheckpointNonNegativeInteger(report[field], `$.${field}`);
  }

  const disc = requireCheckpointObject(report.disc, "$.disc");
  requireString(report.title, "$.title");
  const discIdentifier = requireString(disc.identifier, "$.disc.identifier");
  const discRevision = requireCheckpointNonNegativeInteger(disc.revision, "$.disc.revision");
  if (discIdentifier !== expected.game.identifier) {
    checkpointValidationFailure(
      "$.disc.identifier",
      `expected ${describeCheckpointValue(expected.game.identifier)}, got ${describeCheckpointValue(discIdentifier)}`,
    );
  }
  if (discRevision !== expected.game.revision) {
    checkpointValidationFailure(
      "$.disc.revision",
      `expected ${expected.game.revision}, got ${discRevision}`,
    );
  }

  const limits = requireCheckpointObject(report.limits, "$.limits");
  const cycleLimit = requireCheckpointNonNegativeInteger(limits.cycles, "$.limits.cycles");
  if (cycleLimit !== expected.run.cycles) {
    checkpointValidationFailure(
      "$.limits.cycles",
      `expected ${expected.run.cycles}, got ${cycleLimit}`,
    );
  }
  if (report.cycles !== cycleLimit) {
    checkpointValidationFailure(
      "$.cycles",
      `expected the configured limit ${cycleLimit}, got ${report.cycles}`,
    );
  }
  if (limits.dispatches !== null) {
    requirePositiveInteger(limits.dispatches, "$.limits.dispatches");
  }

  const cpuState = requireCheckpointObject(report.cpuState, "$.cpuState");
  const cpuPc = requireHex32(cpuState.pc, "$.cpuState.pc");
  for (const field of ["msr", "lr", "ctr", "srr0", "srr1"]) {
    requireHex32(cpuState[field], `$.cpuState.${field}`);
  }
  const gpr = requireCheckpointObject(cpuState.gpr, "$.cpuState.gpr");
  for (let index = 0; index < 32; index += 1) {
    requireHex32(gpr[`r${index}`], `$.cpuState.gpr.r${index}`);
  }
  requireHex32(cpuState.signature, "$.cpuState.signature");
  if (cpuPc !== pc) {
    checkpointValidationFailure("$.cpuState.pc", `expected the report pc ${pc}, got ${cpuPc}`);
  }

  const rendererSync = requireCheckpointObject(
    report.execution?.scheduler?.rendererSync,
    "$.execution.scheduler.rendererSync",
  );
  const values = {};
  for (const field of [
    "posted", "acknowledged", "failed", "inFlight", "highWater", "resultMisses",
  ]) {
    values[field] = requireCheckpointNonNegativeInteger(
      rendererSync[field],
      `$.execution.scheduler.rendererSync.${field}`,
    );
  }
  if (values.posted === 0) {
    checkpointValidationFailure(
      "$.execution.scheduler.rendererSync.posted",
      "expected at least one WebGPU renderer operation",
    );
  }
  for (const field of ["failed", "inFlight", "resultMisses"]) {
    if (values[field] !== 0) {
      checkpointValidationFailure(
        `$.execution.scheduler.rendererSync.${field}`,
        `expected 0, got ${values[field]}`,
      );
    }
  }
  if (values.acknowledged !== values.posted) {
    checkpointValidationFailure(
      "$.execution.scheduler.rendererSync.acknowledged",
      `expected posted (${values.posted}), got ${values.acknowledged}`,
    );
  }
  if (values.highWater > 1) {
    checkpointValidationFailure(
      "$.execution.scheduler.rendererSync.highWater",
      `expected at most 1, got ${values.highWater}`,
    );
  }

  const renderEvery = requirePositiveInteger(
    report.execution?.scheduler?.renderEvery,
    "$.execution.scheduler.renderEvery",
  );
  if (renderEvery !== expected.run.renderEvery) {
    checkpointValidationFailure(
      "$.execution.scheduler.renderEvery",
      `expected ${expected.run.renderEvery}, got ${renderEvery}`,
    );
  }

  const decoder = requireCheckpointObject(report.gxFifo?.decoder, "$.gxFifo.decoder");
  requirePositiveInteger(decoder.xfbCopyCount, "$.gxFifo.decoder.xfbCopyCount");
  if (expected.run.inputs.length === 0) {
    requireZero(report.controller?.pendingButtons, "$.controller.pendingButtons");
    requireZero(report.controller?.lastPolledButtons, "$.controller.lastPolledButtons");
  }
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

  const viInterruptModel = requireCheckpointObject(
    report.mmioState?.viInterruptModel,
    "$.mmioState.viInterruptModel",
  );
  requirePositiveInteger(
    viInterruptModel.presentationCount,
    "$.mmioState.viInterruptModel.presentationCount",
  );

  if (report.diskCommands?.lastError !== "0x00000000") {
    checkpointValidationFailure(
      "$.diskCommands.lastError",
      `expected \"0x00000000\", got ${describeCheckpointValue(report.diskCommands?.lastError)}`,
    );
  }
  const diskDeviceErrors = report.deviceEvents?.diskDeviceError ?? 0;
  requireZero(diskDeviceErrors, "$.deviceEvents.diskDeviceError");

  const exceptionCounts = requireCheckpointObject(report.exceptions?.counts, "$.exceptions.counts");
  for (const vector of ["0x0200", "0x0300", "0x0400", "0x0600", "0x0700"]) {
    requireZero(exceptionCounts[vector] ?? 0, `$.exceptions.counts[${JSON.stringify(vector)}]`);
  }

  const devtoolsExceptions = report.headlessCapture?.devtoolsExceptions;
  if (devtoolsExceptions !== undefined) {
    if (!Array.isArray(devtoolsExceptions)) {
      checkpointValidationFailure("$.headlessCapture.devtoolsExceptions", "expected an array");
    }
    if (devtoolsExceptions.length !== 0) {
      checkpointValidationFailure(
        "$.headlessCapture.devtoolsExceptions[0]",
        `unexpected page exception ${describeCheckpointValue(devtoolsExceptions[0])}`,
      );
    }
  }
  const capturedRenderer = report.headlessCapture?.dataset?.renderer;
  if (capturedRenderer !== undefined && capturedRenderer !== expected.run.renderer) {
    checkpointValidationFailure(
      "$.headlessCapture.dataset.renderer",
      `expected ${describeCheckpointValue(expected.run.renderer)}, got ${describeCheckpointValue(capturedRenderer)}`,
    );
  }
  return report;
}

export function projectCheckpointReport(report, expected = SUPER_MONKEY_BALL_CHECKPOINT) {
  validateCheckpointReport(report, expected);
  const state = {};
  for (const [pointer, parts] of CHECKPOINT_POINTER_PARTS) {
    assignPointer(state, parts, pointerValue(report, pointer, parts));
  }
  return state;
}

export function normalizeCheckpointState(state, base = "$manifest.state") {
  const normalized = {};
  for (const [pointer, parts] of CHECKPOINT_POINTER_PARTS) {
    assignPointer(normalized, parts, pointerValue(state, pointer, parts, base));
  }
  return normalized;
}

export function checkpointSha256(state) {
  return createHash("sha256").update(canonicalStringify(state)).digest("hex");
}

export function checkpointIdentity(expected, state) {
  return {
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
      limits: state.limits,
      cycles: state.cycles,
      pc: state.pc,
    },
    run: {
      ...canonicalCheckpointValue(expected.run),
      cycles: state.limits.cycles,
      renderEvery: state.execution.scheduler.renderEvery,
    },
  };
}

export function createCheckpointCandidate(report, expected = SUPER_MONKEY_BALL_CHECKPOINT) {
  validateCheckpointOptions(expected);
  const state = projectCheckpointReport(report, expected);
  const identity = checkpointIdentity(expected, state);
  return {
    schema: BROWSER_BOOT_CHECKPOINT_SCHEMA,
    algorithm: "sha256",
    fields: [...BROWSER_BOOT_CHECKPOINT_FIELDS],
    ...identity,
    sha256: checkpointSha256(state),
    state,
  };
}
