#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BROWSER_BOOT_CHECKPOINT_FIELDS,
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  CheckpointValidationError,
  SUPER_MONKEY_BALL_CHECKPOINT,
  assertCheckpointJsonValue,
  checkpointChildPath,
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

export function validateCheckpointManifest(manifest) {
  requireCheckpointObject(manifest, "$manifest");
  assertCheckpointJsonValue(manifest, "$manifest");
  if (manifest.schema !== BROWSER_BOOT_CHECKPOINT_SCHEMA) {
    checkpointValidationFailure(
      "$manifest.schema",
      `expected ${describeCheckpointValue(BROWSER_BOOT_CHECKPOINT_SCHEMA)}, got ${describeCheckpointValue(manifest.schema)}`,
    );
  }
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
    BROWSER_BOOT_CHECKPOINT_FIELDS,
    manifest.fields,
    "$manifest.fields",
  );
  if (fieldsDifference !== null) {
    checkpointValidationFailure(
      fieldsDifference.path,
      `expected ${describeDifferenceValue(fieldsDifference.expected)}, got ${describeDifferenceValue(fieldsDifference.actual)}`,
    );
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
  requireCheckpointObject(manifest.state, "$manifest.state");
  const normalizedState = normalizeCheckpointState(manifest.state);
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
  const expected = {
    id: manifest.id,
    game: {
      identifier: manifest.game.identifier,
      revision: manifest.game.revision,
      image: manifest.game.image,
    },
    run: manifest.run,
  };
  const candidate = createCheckpointCandidate(report, expected);
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
