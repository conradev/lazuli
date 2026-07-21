#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BROWSER_BOOT_CHECKPOINT_FIELDS,
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  CheckpointValidationError,
  SUPER_MONKEY_BALL_CHECKPOINT,
  assertCheckpointJsonValue,
  canonicalCheckpointValue,
  checkpointChildPath,
  checkpointFieldsForSchema,
  checkpointIdentity,
  checkpointSha256,
  checkpointValidationFailure,
  createCheckpointCandidate,
  describeCheckpointValue,
  normalizeCheckpointState,
  requireCheckpointNonNegativeInteger,
  requireCheckpointObject,
  validateCheckpointOptions,
} from "./browser_boot_checkpoint_core.mjs";
import {
  SUPER_MONKEY_BALL_READY_CHECKPOINT,
  createSmbReadyCheckpointCandidate,
  validateSmbReadyCheckpointOptions,
} from "./browser_boot_checkpoint_v3.mjs";
import {
  GameplayTranscriptValidationError,
  validateSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import {
  TemporalXfbValidationError,
  projectSmbTemporalSelectedXfb,
} from "./browser_boot_temporal_xfb.mjs";

export {
  BROWSER_BOOT_CHECKPOINT_FIELDS,
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  CheckpointValidationError,
  SUPER_MONKEY_BALL_CHECKPOINT,
  canonicalStringify,
  checkpointSha256,
  createCheckpointCandidate,
  projectCheckpointReport,
  validateCheckpointReport,
} from "./browser_boot_checkpoint_core.mjs";

const MISSING = Symbol("missing checkpoint value");
const SMB_READY_CHECKPOINT_TITLE = "Super Monkey Ball (GMBE8P Rev.00)";

const RENDERER_MAXIMUM_METRICS = Object.freeze([
  Object.freeze({
    name: "wasmBridgeCalls",
    path: Object.freeze(["wasmBridge", "calls"]),
  }),
  Object.freeze({
    name: "wasmBridgeTypedArrayBytes",
    path: Object.freeze(["wasmBridge", "typedArrayBytes"]),
  }),
  Object.freeze({
    name: "queueSubmissions",
    path: Object.freeze(["queue", "submits"]),
  }),
  Object.freeze({
    name: "bindGroups",
    path: Object.freeze(["resources", "bindGroups"]),
  }),
  Object.freeze({
    name: "buffers",
    path: Object.freeze(["resources", "buffers"]),
  }),
  Object.freeze({
    name: "renderPipelines",
    path: Object.freeze(["resources", "renderPipelines"]),
  }),
  Object.freeze({
    name: "textures",
    path: Object.freeze(["resources", "textures"]),
  }),
]);

function rejectUnexpectedCheckpointFields(value, allowed, path) {
  const allowedFields = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      checkpointValidationFailure(
        checkpointChildPath(path, field),
        "unexpected checkpoint manifest field",
      );
    }
  }
}

function validateRendererPerformanceBudget(manifest) {
  if (!Object.hasOwn(manifest, "performance")) return null;
  const performance = requireCheckpointObject(
    manifest.performance,
    "$manifest.performance",
  );
  rejectUnexpectedCheckpointFields(
    performance,
    ["rendererMaximum"],
    "$manifest.performance",
  );
  const rendererMaximum = requireCheckpointObject(
    performance.rendererMaximum,
    "$manifest.performance.rendererMaximum",
  );
  rejectUnexpectedCheckpointFields(
    rendererMaximum,
    RENDERER_MAXIMUM_METRICS.map(metric => metric.name),
    "$manifest.performance.rendererMaximum",
  );
  for (const metric of RENDERER_MAXIMUM_METRICS) {
    requireCheckpointNonNegativeInteger(
      rendererMaximum[metric.name],
      `$manifest.performance.rendererMaximum.${metric.name}`,
    );
  }
  return rendererMaximum;
}

function rendererMetric(reportMetrics, path) {
  let value = reportMetrics;
  for (const field of path) value = value?.[field];
  return value;
}

function verifyRendererPerformanceBudget(report, manifest) {
  if (!Object.hasOwn(manifest, "performance")) return;
  const rendererMaximum = manifest.performance.rendererMaximum;
  const reportMetrics = requireCheckpointObject(
    report.rendering?.metrics,
    "$.rendering.metrics",
  );
  if (reportMetrics.scope !== "current-worker") {
    checkpointValidationFailure(
      "$.rendering.metrics.scope",
      `expected "current-worker", got ${describeCheckpointValue(reportMetrics.scope)}`,
    );
  }
  for (const group of ["wasmBridge", "queue", "resources"]) {
    requireCheckpointObject(
      reportMetrics[group],
      `$.rendering.metrics.${group}`,
    );
  }
  for (const metric of RENDERER_MAXIMUM_METRICS) {
    const path = `$.rendering.metrics.${metric.path.join(".")}`;
    const actual = requireCheckpointNonNegativeInteger(
      rendererMetric(reportMetrics, metric.path),
      path,
    );
    const maximum = rendererMaximum[metric.name];
    if (actual > maximum) {
      checkpointValidationFailure(
        path,
        `expected at most ${maximum}, got ${actual}`,
      );
    }
  }
}

function describeDifferenceValue(value) {
  return value === MISSING ? "<missing>" : describeCheckpointValue(value);
}

export class CheckpointMismatchError extends Error {
  constructor(path, expected, actual, expectedSha256, actualSha256) {
    super(
      `checkpoint mismatch at ${path}: expected ${describeDifferenceValue(expected)}, got ${describeDifferenceValue(actual)}`
      + ` (expected sha256 ${expectedSha256}, got ${actualSha256})`,
    );
    this.name = "CheckpointMismatchError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

function firstDifference(expected, actual, path = "$state") {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path, expected, actual };
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const expectedValue = index < expected.length ? expected[index] : MISSING;
      const actualValue = index < actual.length ? actual[index] : MISSING;
      const difference = firstDifference(
        expectedValue,
        actualValue,
        checkpointChildPath(path, index),
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  const expectedObject = expected !== null && typeof expected === "object";
  const actualObject = actual !== null && typeof actual === "object";
  if (!expectedObject || !actualObject) return { path, expected, actual };
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const expectedValue = Object.hasOwn(expected, key) ? expected[key] : MISSING;
    const actualValue = Object.hasOwn(actual, key) ? actual[key] : MISSING;
    const difference = firstDifference(
      expectedValue,
      actualValue,
      checkpointChildPath(path, key),
    );
    if (difference !== null) return difference;
  }
  return null;
}

function requireExactCheckpointValue(value, expected, path) {
  if (!Object.is(value, expected)) {
    checkpointValidationFailure(
      path,
      `expected ${describeCheckpointValue(expected)}, got ${describeCheckpointValue(value)}`,
    );
  }
  return value;
}

function rebaseEvidencePath(base, path) {
  if (path === "$" || path === "$." || typeof path !== "string") return base;
  if (path.startsWith("$.")) return `${base}${path.slice(1)}`;
  if (path.startsWith("$[")) return `${base}${path.slice(1)}`;
  return base;
}

function reprojectSmbReadyManifestState(state) {
  requireCheckpointObject(state, "$manifest.state");
  const normalized = normalizeCheckpointState(
    state,
    "$manifest.state",
    BROWSER_BOOT_CHECKPOINT_SCHEMA_V3,
  );
  requireExactCheckpointValue(normalized.status, "paused", "$manifest.state.status");
  requireExactCheckpointValue(
    normalized.stage,
    "scenario-complete",
    "$manifest.state.stage",
  );
  requireExactCheckpointValue(
    normalized.title,
    SMB_READY_CHECKPOINT_TITLE,
    "$manifest.state.title",
  );
  requireExactCheckpointValue(
    normalized.disc.identifier,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game.identifier,
    "$manifest.state.disc.identifier",
  );
  requireExactCheckpointValue(
    normalized.disc.revision,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.game.revision,
    "$manifest.state.disc.revision",
  );
  requireExactCheckpointValue(
    normalized.rendering.backend,
    SUPER_MONKEY_BALL_READY_CHECKPOINT.run.renderer,
    "$manifest.state.rendering.backend",
  );

  let gameplayTranscript;
  try {
    gameplayTranscript = validateSmbReadyPlayGameplayTranscript(
      normalized.gameplayTranscript,
    );
  } catch (error) {
    if (!(error instanceof GameplayTranscriptValidationError)) throw error;
    checkpointValidationFailure(
      rebaseEvidencePath("$manifest.state.gameplayTranscript", error.path),
      error.message,
    );
  }

  let temporalSelectedXfb;
  try {
    temporalSelectedXfb = projectSmbTemporalSelectedXfb(
      normalized.rendering.temporalSelectedXfb,
    );
  } catch (error) {
    if (!(error instanceof TemporalXfbValidationError)) throw error;
    checkpointValidationFailure(
      rebaseEvidencePath(
        "$manifest.state.rendering.temporalSelectedXfb",
        error.path,
      ),
      error.message,
    );
  }

  return {
    status: normalized.status,
    stage: normalized.stage,
    title: normalized.title,
    disc: {
      identifier: normalized.disc.identifier,
      revision: normalized.disc.revision,
    },
    gameplayTranscript: canonicalCheckpointValue(gameplayTranscript),
    rendering: {
      backend: normalized.rendering.backend,
      temporalSelectedXfb: canonicalCheckpointValue(temporalSelectedXfb),
    },
  };
}

function smbReadyManifestProfile(manifest) {
  return {
    schema: manifest.schema,
    id: manifest.id,
    game: {
      identifier: manifest.game.identifier,
      revision: manifest.game.revision,
      image: manifest.game.image,
    },
    run: manifest.run,
  };
}

function smbReadyCheckpointIdentity(expected, state) {
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
    },
    run: canonicalCheckpointValue(expected.run),
  };
}

export function createCheckpointManifest(
  reports,
  expected = SUPER_MONKEY_BALL_CHECKPOINT,
) {
  validateCheckpointOptions(expected);
  if (!Array.isArray(reports) || reports.length < expected.run.cleanRunsRequired) {
    checkpointValidationFailure(
      "$runs",
      `at least ${expected.run.cleanRunsRequired} clean reports are required to bless a golden`,
    );
  }
  const candidates = reports.map(report => createCheckpointCandidate(report, expected));
  const first = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    for (const field of ["game", "checkpoint", "run", "state"]) {
      const difference = firstDifference(
        first[field],
        candidates[index][field],
        `$runs[${index}].${field}`,
      );
      if (difference !== null) {
        throw new CheckpointMismatchError(
          difference.path,
          difference.expected,
          difference.actual,
          first.sha256,
          candidates[index].sha256,
        );
      }
    }
  }
  return {
    ...first,
    consensus: { cleanRuns: reports.length },
  };
}

function validateSmbReadyCheckpointManifest(manifest) {
  for (const field of ["game", "checkpoint", "run", "consensus"]) {
    requireCheckpointObject(manifest[field], `$manifest.${field}`);
  }
  rejectUnexpectedCheckpointFields(
    manifest.consensus,
    ["cleanRuns"],
    "$manifest.consensus",
  );
  const expected = smbReadyManifestProfile(manifest);
  validateSmbReadyCheckpointOptions(expected, "$manifest");
  const cleanRuns = requireCheckpointNonNegativeInteger(
    manifest.consensus.cleanRuns,
    "$manifest.consensus.cleanRuns",
  );
  if (cleanRuns < expected.run.cleanRunsRequired) {
    checkpointValidationFailure(
      "$manifest.consensus.cleanRuns",
      `at least ${expected.run.cleanRunsRequired} clean runs are required`,
    );
  }
  validateRendererPerformanceBudget(manifest);

  const normalizedState = reprojectSmbReadyManifestState(manifest.state);
  const stateShapeDifference = firstDifference(
    normalizedState,
    manifest.state,
    "$manifest.state",
  );
  if (stateShapeDifference !== null) {
    checkpointValidationFailure(
      stateShapeDifference.path,
      `unexpected checkpoint state field: expected ${describeDifferenceValue(stateShapeDifference.expected)}, got ${describeDifferenceValue(stateShapeDifference.actual)}`,
    );
  }

  const identity = smbReadyCheckpointIdentity(expected, normalizedState);
  for (const field of ["id", "game", "checkpoint", "run"]) {
    const difference = firstDifference(
      identity[field],
      manifest[field],
      `$manifest.${field}`,
    );
    if (difference !== null) {
      checkpointValidationFailure(
        difference.path,
        `expected ${describeDifferenceValue(difference.expected)}, got ${describeDifferenceValue(difference.actual)}`,
      );
    }
  }
  const stateSha256 = checkpointSha256(normalizedState);
  if (stateSha256 !== manifest.sha256) {
    checkpointValidationFailure(
      "$manifest.sha256",
      `manifest state hashes to ${stateSha256}, not ${manifest.sha256}`,
    );
  }
  return manifest;
}

export function validateCheckpointManifest(manifest) {
  requireCheckpointObject(manifest, "$manifest");
  assertCheckpointJsonValue(manifest, "$manifest");
  const checkpointFields = checkpointFieldsForSchema(manifest.schema, "$manifest.schema");
  if (manifest.algorithm !== "sha256") {
    checkpointValidationFailure(
      "$manifest.algorithm",
      `expected \"sha256\", got ${describeCheckpointValue(manifest.algorithm)}`,
    );
  }
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    checkpointValidationFailure("$manifest.sha256", "expected a lowercase SHA-256 digest");
  }
  const fieldsDifference = firstDifference(
    checkpointFields,
    manifest.fields,
    "$manifest.fields",
  );
  if (fieldsDifference !== null) {
    checkpointValidationFailure(
      fieldsDifference.path,
      `expected ${describeDifferenceValue(fieldsDifference.expected)}, got ${describeDifferenceValue(fieldsDifference.actual)}`,
    );
  }
  if (manifest.schema === BROWSER_BOOT_CHECKPOINT_SCHEMA_V3) {
    return validateSmbReadyCheckpointManifest(manifest);
  }
  for (const field of ["game", "checkpoint", "run", "consensus"]) {
    requireCheckpointObject(manifest[field], `$manifest.${field}`);
  }
  const expected = {
    id: manifest.id,
    game: {
      identifier: manifest.game.identifier,
      revision: manifest.game.revision,
      image: manifest.game.image,
    },
    run: manifest.run,
  };
  validateCheckpointOptions(expected, "$manifest");
  const cleanRuns = requireCheckpointNonNegativeInteger(
    manifest.consensus.cleanRuns,
    "$manifest.consensus.cleanRuns",
  );
  if (cleanRuns < manifest.run.cleanRunsRequired) {
    checkpointValidationFailure(
      "$manifest.consensus.cleanRuns",
      `at least ${manifest.run.cleanRunsRequired} clean runs are required`,
    );
  }
  validateRendererPerformanceBudget(manifest);
  requireCheckpointObject(manifest.state, "$manifest.state");
  const normalizedState = normalizeCheckpointState(
    manifest.state,
    "$manifest.state",
    manifest.schema,
  );
  const stateShapeDifference = firstDifference(
    normalizedState,
    manifest.state,
    "$manifest.state",
  );
  if (stateShapeDifference !== null) {
    checkpointValidationFailure(
      stateShapeDifference.path,
      `unexpected checkpoint state field: expected ${describeDifferenceValue(stateShapeDifference.expected)}, got ${describeDifferenceValue(stateShapeDifference.actual)}`,
    );
  }
  const identity = checkpointIdentity(expected, manifest.state);
  for (const field of ["id", "game", "checkpoint", "run"]) {
    const difference = firstDifference(
      identity[field],
      manifest[field],
      `$manifest.${field}`,
    );
    if (difference !== null) {
      checkpointValidationFailure(
        difference.path,
        `expected ${describeDifferenceValue(difference.expected)}, got ${describeDifferenceValue(difference.actual)}`,
      );
    }
  }
  const stateSha256 = checkpointSha256(manifest.state);
  if (stateSha256 !== manifest.sha256) {
    checkpointValidationFailure(
      "$manifest.sha256",
      `manifest state hashes to ${stateSha256}, not ${manifest.sha256}`,
    );
  }
  return manifest;
}

export function verifyCheckpointReport(report, manifest) {
  validateCheckpointManifest(manifest);
  let candidate;
  if (manifest.schema === BROWSER_BOOT_CHECKPOINT_SCHEMA_V3) {
    const expected = smbReadyManifestProfile(manifest);
    validateSmbReadyCheckpointOptions(expected, "$manifest");
    candidate = createSmbReadyCheckpointCandidate(report, expected);
  } else {
    const expected = {
      id: manifest.id,
      game: {
        identifier: manifest.game.identifier,
        revision: manifest.game.revision,
        image: manifest.game.image,
      },
      run: manifest.run,
    };
    candidate = createCheckpointCandidate(report, expected, manifest.schema);
  }
  for (const field of ["id", "game", "checkpoint", "run"]) {
    const difference = firstDifference(manifest[field], candidate[field], `$${field}`);
    if (difference !== null) {
      throw new CheckpointMismatchError(
        difference.path,
        difference.expected,
        difference.actual,
        manifest.sha256,
        candidate.sha256,
      );
    }
  }
  if (candidate.sha256 !== manifest.sha256) {
    const difference = firstDifference(manifest.state, candidate.state);
    if (difference === null) {
      checkpointValidationFailure(
        "$manifest.sha256",
        "equal canonical states produced different digests",
      );
    }
    throw new CheckpointMismatchError(
      difference.path,
      difference.expected,
      difference.actual,
      manifest.sha256,
      candidate.sha256,
    );
  }
  verifyRendererPerformanceBudget(report, manifest);
  return { sha256: candidate.sha256, state: candidate.state };
}

export async function readCheckpointManifest(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`could not read checkpoint manifest ${path}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`checkpoint manifest ${path} is not valid JSON: ${error.message}`);
  }
  return validateCheckpointManifest(manifest);
}

async function persistManifest(output, manifest) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}

async function main(argv) {
  const inputs = [];
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      index += 1;
      if (index >= argv.length) throw new Error("missing value after --output");
      output = argv[index];
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown argument ${argument}`);
    } else {
      inputs.push(argument);
    }
  }
  if (inputs.length < 3) {
    throw new Error(
      "usage: browser_boot_checkpoint.mjs <run-1.json> <run-2.json> <run-3.json>"
      + " [more-runs.json ...] [--output <manifest.json>]",
    );
  }
  const reports = await Promise.all(inputs.map(async input =>
    JSON.parse(await readFile(input, "utf8"))
  ));
  await persistManifest(output, createCheckpointManifest(reports));
}

const invokedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
