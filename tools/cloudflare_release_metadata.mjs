#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

import {
  RELEASE_SCHEMA,
  ROLLBACK_RELEASE_SCHEMA,
  validateRelease,
} from "../web/release.mjs";

export const CLOUDFLARE_RELEASE_METADATA_SCHEMA = 1;

const RELEASE_ID = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const PREVIEW_PREFIX = /^[a-z0-9][a-z0-9-]*$/;
const RELEASE_SCHEMAS = new Set([ROLLBACK_RELEASE_SCHEMA, RELEASE_SCHEMA]);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  check(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys are not exact`);
}

function exactOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  check(
    url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.pathname === "/" && url.search === "" && url.hash === "",
    `${label} must be an exact HTTPS origin`,
  );
  return url;
}

export function requireProductionVersion(statusText, expectedVersionId) {
  check(VERSION_ID.test(expectedVersionId ?? ""), "expected production version ID is invalid");
  let status;
  try {
    status = JSON.parse(statusText);
  } catch (error) {
    throw new Error(`Cloudflare deployment status is not JSON: ${error.message}`);
  }
  check(status !== null && typeof status === "object" && !Array.isArray(status),
    "Cloudflare deployment status must be an object");
  check(Array.isArray(status.versions) && status.versions.length === 1,
    "production must have exactly one active Cloudflare version");
  const active = status.versions[0];
  exactKeys(active, ["percentage", "version_id"], "active Cloudflare version");
  check(active.percentage === 100, "production Cloudflare version is not at 100 percent");
  check(active.version_id === expectedVersionId,
    `production Cloudflare version ${active.version_id} does not match ${expectedVersionId}`);
  return expectedVersionId;
}

export function parseVersionUploadOutput(outputText, options) {
  const lines = outputText.split(/\r?\n/).filter(line => line.trim() !== "");
  check(lines.length === 1, "Wrangler output must contain exactly one record");
  let record;
  try {
    record = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`Wrangler output is not NDJSON: ${error.message}`);
  }
  const optional = new Set(["worker_tag", "wrangler_environment"]);
  const required = [
    "type",
    "version",
    "worker_name",
    "version_id",
    "preview_url",
    "preview_alias_url",
    "worker_name_overridden",
  ];
  check(record !== null && typeof record === "object" && !Array.isArray(record),
    "Wrangler version upload record must be an object");
  for (const name of required) check(Object.hasOwn(record, name), `Wrangler output omits ${name}`);
  for (const name of Object.keys(record)) {
    check(required.includes(name) || optional.has(name), `Wrangler output has unknown ${name}`);
  }
  check(record.type === "version-upload" && record.version === 1,
    "Wrangler output is not version-upload schema 1");
  check(WORKER_NAME.test(options.workerName ?? ""), "expected Worker name is invalid");
  check(record.worker_name === options.workerName, "Wrangler uploaded a different Worker");
  check(record.worker_name_overridden === false, "Wrangler overrode the configured Worker name");
  check(VERSION_ID.test(record.version_id ?? ""), "Wrangler version ID is invalid");

  const preview = exactOrigin(record.preview_url, "versioned preview URL");
  const alias = exactOrigin(record.preview_alias_url, "preview alias URL");
  const expectedAlias = exactOrigin(options.expectedPreviewAliasOrigin, "expected preview alias");
  check(alias.origin === expectedAlias.origin, "Wrangler preview alias does not match configuration");
  check(preview.origin !== alias.origin, "Wrangler returned the mutable alias as the versioned preview");
  const aliasPrefix = `resident-canary-${options.workerName}.`;
  check(alias.hostname.startsWith(aliasPrefix), "preview alias does not identify the expected Worker");
  const workersDevSuffix = alias.hostname.slice(aliasPrefix.length);
  const versionSuffix = `-${options.workerName}.${workersDevSuffix}`;
  check(preview.hostname.endsWith(versionSuffix), "versioned preview does not identify the expected Worker");
  const versionPrefix = preview.hostname.slice(0, -versionSuffix.length);
  check(PREVIEW_PREFIX.test(versionPrefix), "versioned preview prefix is invalid");

  return Object.freeze({
    versionId: record.version_id,
    previewOrigin: preview.origin,
    previewAliasOrigin: alias.origin,
  });
}

export async function createCloudflareReleaseMetadata(options) {
  await validateRelease(options.release);
  check(options.release.schema === RELEASE_SCHEMA, "Cloudflare candidate must be schema 4");
  check(VERSION_ID.test(options.rollbackVersionId ?? ""), "rollback Cloudflare version ID is invalid");
  check(RELEASE_SCHEMAS.has(options.predecessorSchema), "predecessor release schema is invalid");
  check(RELEASE_ID.test(options.predecessorReleaseId ?? ""), "predecessor release ID is invalid");
  check(VERSION_ID.test(options.predecessorVersionId ?? ""),
    "predecessor Cloudflare version ID is invalid");
  if (options.predecessorSchema === ROLLBACK_RELEASE_SCHEMA) {
    check(options.predecessorReleaseId === options.release.rollback.release.releaseId,
      "schema-3 predecessor is not the authenticated rollback release");
    check(options.predecessorVersionId === options.rollbackVersionId,
      "schema-3 predecessor is not the authenticated rollback version");
  }
  const upload = parseVersionUploadOutput(options.wranglerOutput, options);
  return Object.freeze({
    schema: CLOUDFLARE_RELEASE_METADATA_SCHEMA,
    worker: options.workerName,
    sourceCommit: options.release.source.commit,
    candidate: Object.freeze({
      releaseId: options.release.releaseId,
      versionId: upload.versionId,
      previewOrigin: upload.previewOrigin,
      previewAliasOrigin: upload.previewAliasOrigin,
    }),
    predecessor: Object.freeze({
      schema: options.predecessorSchema,
      releaseId: options.predecessorReleaseId,
      versionId: options.predecessorVersionId,
    }),
    rollback: Object.freeze({
      releaseId: options.release.rollback.release.releaseId,
      versionId: options.rollbackVersionId,
    }),
  });
}

export function validateCloudflareReleaseMetadata(metadata, expected = {}) {
  exactKeys(metadata, ["schema", "worker", "sourceCommit", "candidate", "predecessor", "rollback"],
    "Cloudflare release metadata");
  check(metadata.schema === CLOUDFLARE_RELEASE_METADATA_SCHEMA,
    "Cloudflare release metadata schema is unsupported");
  check(WORKER_NAME.test(metadata.worker ?? ""), "Cloudflare metadata Worker is invalid");
  check(COMMIT.test(metadata.sourceCommit ?? ""), "Cloudflare metadata source commit is invalid");
  exactKeys(metadata.candidate,
    ["releaseId", "versionId", "previewOrigin", "previewAliasOrigin"],
    "Cloudflare candidate metadata");
  exactKeys(metadata.predecessor, ["schema", "releaseId", "versionId"],
    "Cloudflare predecessor metadata");
  exactKeys(metadata.rollback, ["releaseId", "versionId"], "Cloudflare rollback metadata");
  check(RELEASE_ID.test(metadata.candidate.releaseId ?? ""), "candidate release ID is invalid");
  check(VERSION_ID.test(metadata.candidate.versionId ?? ""), "candidate version ID is invalid");
  check(RELEASE_SCHEMAS.has(metadata.predecessor.schema), "predecessor release schema is invalid");
  check(RELEASE_ID.test(metadata.predecessor.releaseId ?? ""), "predecessor release ID is invalid");
  check(VERSION_ID.test(metadata.predecessor.versionId ?? ""), "predecessor version ID is invalid");
  check(RELEASE_ID.test(metadata.rollback.releaseId ?? ""), "rollback release ID is invalid");
  check(VERSION_ID.test(metadata.rollback.versionId ?? ""), "rollback version ID is invalid");
  if (metadata.predecessor.schema === ROLLBACK_RELEASE_SCHEMA) {
    check(metadata.predecessor.releaseId === metadata.rollback.releaseId,
      "schema-3 predecessor release does not match rollback");
    check(metadata.predecessor.versionId === metadata.rollback.versionId,
      "schema-3 predecessor version does not match rollback");
  }
  const preview = exactOrigin(metadata.candidate.previewOrigin, "candidate preview origin");
  const alias = exactOrigin(metadata.candidate.previewAliasOrigin, "candidate preview alias origin");
  check(preview.origin !== alias.origin, "candidate preview origin is a mutable alias");
  for (const [actual, wanted, label] of [
    [metadata.worker, expected.workerName, "Worker"],
    [metadata.sourceCommit, expected.sourceCommit, "source commit"],
    [metadata.candidate.releaseId, expected.releaseId, "candidate release ID"],
    [metadata.rollback.releaseId, expected.rollbackReleaseId, "rollback release ID"],
  ]) {
    if (wanted !== undefined) check(actual === wanted, `Cloudflare metadata ${label} does not match`);
  }
  return metadata;
}

async function appendOutputs(path, metadata) {
  if (path === undefined) return;
  await appendFile(resolve(path), [
    `release_id=${metadata.candidate.releaseId}`,
    `version_id=${metadata.candidate.versionId}`,
    `preview_origin=${metadata.candidate.previewOrigin}`,
    `source_commit=${metadata.sourceCommit}`,
    `predecessor_schema=${metadata.predecessor.schema}`,
    `predecessor_release_id=${metadata.predecessor.releaseId}`,
    `predecessor_version_id=${metadata.predecessor.versionId}`,
    `rollback_release_id=${metadata.rollback.releaseId}`,
    `rollback_version_id=${metadata.rollback.versionId}`,
    "",
  ].join("\n"));
}

function parseArguments(arguments_) {
  const command = arguments_[0];
  check(["assert-production", "capture", "verify"].includes(command),
    "usage: cloudflare_release_metadata.mjs <assert-production|capture|verify> [options]");
  const options = {};
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    check(name?.startsWith("--") && value !== undefined, `invalid argument ${name ?? ""}`);
    const key = {
      "--status-env": "statusEnv",
      "--expect-version-id": "expectedVersionId",
      "--wrangler-output": "wranglerOutputPath",
      "--release-manifest": "releaseManifestPath",
      "--rollback-version-id": "rollbackVersionId",
      "--predecessor-schema": "predecessorSchema",
      "--predecessor-release-id": "predecessorReleaseId",
      "--predecessor-version-id": "predecessorVersionId",
      "--worker-name": "workerName",
      "--expect-preview-alias-origin": "expectedPreviewAliasOrigin",
      "--output": "outputPath",
      "--metadata": "metadataPath",
      "--expect-release-id": "expectedReleaseId",
      "--expect-rollback-release-id": "expectedRollbackReleaseId",
      "--expect-source-commit": "expectedSourceCommit",
      "--github-output": "githubOutputPath",
    }[name];
    check(key !== undefined && options[key] === undefined, `unknown or duplicate argument ${name}`);
    options[key] = value;
  }
  return { command, options };
}

async function main(arguments_) {
  const { command, options } = parseArguments(arguments_);
  if (command === "assert-production") {
    check(typeof options.statusEnv === "string" && typeof options.expectedVersionId === "string",
      "assert-production requires --status-env and --expect-version-id");
    check(Object.hasOwn(process.env, options.statusEnv), `missing environment ${options.statusEnv}`);
    requireProductionVersion(process.env[options.statusEnv], options.expectedVersionId);
    process.stdout.write(`${options.expectedVersionId}\n`);
    return;
  }
  if (command === "capture") {
    for (const key of [
      "wranglerOutputPath",
      "releaseManifestPath",
      "rollbackVersionId",
      "predecessorSchema",
      "predecessorReleaseId",
      "predecessorVersionId",
      "workerName",
      "expectedPreviewAliasOrigin",
      "outputPath",
    ]) check(typeof options[key] === "string", `capture is missing ${key}`);
    const metadata = await createCloudflareReleaseMetadata({
      wranglerOutput: await readFile(resolve(options.wranglerOutputPath), "utf8"),
      release: JSON.parse(await readFile(resolve(options.releaseManifestPath), "utf8")),
      rollbackVersionId: options.rollbackVersionId,
      predecessorSchema: Number(options.predecessorSchema),
      predecessorReleaseId: options.predecessorReleaseId,
      predecessorVersionId: options.predecessorVersionId,
      workerName: options.workerName,
      expectedPreviewAliasOrigin: options.expectedPreviewAliasOrigin,
    });
    await writeFile(resolve(options.outputPath), `${JSON.stringify(metadata, null, 2)}\n`);
    await appendOutputs(options.githubOutputPath, metadata);
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
    return;
  }
  for (const key of ["metadataPath", "workerName", "expectedRollbackReleaseId"]) {
    check(typeof options[key] === "string", `verify is missing ${key}`);
  }
  const metadata = JSON.parse(await readFile(resolve(options.metadataPath), "utf8"));
  validateCloudflareReleaseMetadata(metadata, {
    workerName: options.workerName,
    sourceCommit: options.expectedSourceCommit,
    releaseId: options.expectedReleaseId,
    rollbackReleaseId: options.expectedRollbackReleaseId,
  });
  if (options.releaseManifestPath !== undefined) {
    const release = JSON.parse(await readFile(resolve(options.releaseManifestPath), "utf8"));
    await validateRelease(release);
    check(release.schema === RELEASE_SCHEMA, "canary evidence release must be schema 4");
    check(release.releaseId === metadata.candidate.releaseId,
      "canary evidence release ID does not match Cloudflare metadata");
    check(release.source.commit === metadata.sourceCommit,
      "canary evidence source commit does not match Cloudflare metadata");
    check(release.rollback.release.releaseId === metadata.rollback.releaseId,
      "canary evidence rollback release does not match Cloudflare metadata");
  }
  await appendOutputs(options.githubOutputPath, metadata);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`cloudflare_release_metadata: ${error.message}\n`);
    process.exitCode = 1;
  }
}
