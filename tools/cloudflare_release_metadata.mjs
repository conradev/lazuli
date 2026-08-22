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

const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/;
const RELEASE_ID = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const PREVIEW_PREFIX = /^[a-z0-9][a-z0-9-]*$/;
const RELEASE_SCHEMAS = new Set([ROLLBACK_RELEASE_SCHEMA, RELEASE_SCHEMA]);
const PINNED_WRANGLER_VERSION = "4.112.0";
const WORKERS_SCRIPT_API_DATE = "2025-08-01";
const PREVIEW_SETTINGS = Object.freeze({ enabled: false, previews_enabled: true });
const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]*$/;

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

async function readPreviewSettingsResponse(response, label) {
  check(response !== null && typeof response === "object" &&
    typeof response.ok === "boolean" && typeof response.status === "number" &&
    typeof response.json === "function", `${label} response is invalid`);
  check(response.ok, `${label} failed: HTTP ${response.status}`);
  let envelope;
  try {
    envelope = await response.json();
  } catch (error) {
    throw new Error(`${label} response is not JSON: ${error.message}`);
  }
  exactKeys(envelope, ["errors", "messages", "result", "success"], `${label} response`);
  check(envelope.success === true, `${label} response was not successful`);
  check(Array.isArray(envelope.errors) && envelope.errors.length === 0,
    `${label} response errors are not empty`);
  check(Array.isArray(envelope.messages) && envelope.messages.length === 0,
    `${label} response messages are not empty`);
  exactKeys(envelope.result, ["enabled", "previews_enabled"], `${label} result`);
  check(typeof envelope.result.enabled === "boolean" &&
    typeof envelope.result.previews_enabled === "boolean", `${label} result is invalid`);
  return Object.freeze({ ...envelope.result });
}

export async function ensureWorkerPreviewSettings(options) {
  check(CLOUDFLARE_ACCOUNT_ID.test(options.accountId ?? ""),
    "Cloudflare account ID is invalid");
  check(WORKER_NAME.test(options.workerName ?? ""), "Worker name is invalid");
  check(typeof options.token === "string" && options.token.length > 0 &&
    options.token.trim() === options.token, "Cloudflare API token is invalid");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  check(typeof fetchImpl === "function", "fetch is unavailable");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}` +
    `/workers/scripts/${options.workerName}/subdomain`;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    "Cloudflare-Workers-Script-Api-Date": WORKERS_SCRIPT_API_DATE,
  };
  const current = await readPreviewSettingsResponse(await fetchImpl(endpoint, {
    method: "GET",
    headers,
    redirect: "error",
  }), "Cloudflare Worker preview settings GET");
  if (current.enabled === PREVIEW_SETTINGS.enabled &&
      current.previews_enabled === PREVIEW_SETTINGS.previews_enabled) return current;

  const final = await readPreviewSettingsResponse(await fetchImpl(endpoint, {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify(PREVIEW_SETTINGS),
  }), "Cloudflare Worker preview settings POST");
  check(final.enabled === PREVIEW_SETTINGS.enabled &&
    final.previews_enabled === PREVIEW_SETTINGS.previews_enabled,
  "Cloudflare Worker preview settings POST returned the wrong final state");
  return final;
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
  let session;
  let record;
  const versionOptional = new Set(["timestamp", "worker_tag", "wrangler_environment"]);
  const versionRequired = [
    "type",
    "version",
    "worker_name",
    "version_id",
    "preview_url",
    "preview_alias_url",
    "worker_name_overridden",
  ];
  const sessionRequired = [
    "type",
    "version",
    "wrangler_version",
    "command_line_args",
    "log_file_path",
  ];
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Wrangler output record ${index + 1} is not NDJSON: ${error.message}`);
    }
    check(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
      `Wrangler output record ${index + 1} must be an object`);
    if (parsed.type === "wrangler-session") {
      check(session === undefined, "Wrangler output contains duplicate wrangler-session records");
      for (const name of sessionRequired) {
        check(Object.hasOwn(parsed, name), `Wrangler session omits ${name}`);
      }
      for (const name of Object.keys(parsed)) {
        check(sessionRequired.includes(name) || name === "timestamp",
          `Wrangler session has unknown ${name}`);
      }
      check(parsed.version === 1, "Wrangler output is not wrangler-session schema 1");
      check(parsed.wrangler_version === PINNED_WRANGLER_VERSION,
        `Wrangler session version is not pinned ${PINNED_WRANGLER_VERSION}`);
      check(Array.isArray(parsed.command_line_args) &&
        parsed.command_line_args.every(value => typeof value === "string"),
        "Wrangler session command line arguments are invalid");
      check(typeof parsed.log_file_path === "string" && parsed.log_file_path.length > 0,
        "Wrangler session log file path is invalid");
      if (Object.hasOwn(parsed, "timestamp")) {
        check(typeof parsed.timestamp === "string" && parsed.timestamp.length > 0,
          "Wrangler session timestamp is invalid");
      }
      session = parsed;
      continue;
    }
    check(parsed.type === "version-upload",
      `Wrangler output has unknown record type ${String(parsed.type)}`);
    check(record === undefined, "Wrangler output contains duplicate version-upload records");
    for (const name of versionRequired) {
      check(Object.hasOwn(parsed, name), `Wrangler output omits ${name}`);
    }
    for (const name of Object.keys(parsed)) {
      check(versionRequired.includes(name) || versionOptional.has(name),
        `Wrangler output has unknown ${name}`);
    }
    if (Object.hasOwn(parsed, "timestamp")) {
      check(typeof parsed.timestamp === "string" && parsed.timestamp.length > 0,
        "Wrangler output timestamp is invalid");
    }
    record = parsed;
  }
  check(record !== undefined, "Wrangler output must contain exactly one version-upload record");
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
  check(versionPrefix === record.version_id.slice(0, 8),
    "versioned preview does not identify the uploaded version ID");

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
  check(["assert-production", "capture", "ensure-preview", "verify"].includes(command),
    "usage: cloudflare_release_metadata.mjs " +
      "<assert-production|capture|ensure-preview|verify> [options]");
  const options = {};
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    check(name?.startsWith("--") && value !== undefined, `invalid argument ${name ?? ""}`);
    const key = {
      "--status-env": "statusEnv",
      "--account-id-env": "accountIdEnv",
      "--token-env": "tokenEnv",
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
  if (command === "ensure-preview") {
    for (const key of ["accountIdEnv", "tokenEnv", "workerName"]) {
      check(typeof options[key] === "string", `ensure-preview is missing ${key}`);
    }
    check(ENVIRONMENT_VARIABLE.test(options.accountIdEnv),
      "ensure-preview account ID environment name is invalid");
    check(ENVIRONMENT_VARIABLE.test(options.tokenEnv),
      "ensure-preview token environment name is invalid");
    check(Object.hasOwn(process.env, options.accountIdEnv),
      "missing Cloudflare account ID environment");
    check(Object.hasOwn(process.env, options.tokenEnv),
      "missing Cloudflare API token environment");
    const settings = await ensureWorkerPreviewSettings({
      accountId: process.env[options.accountIdEnv],
      token: process.env[options.tokenEnv],
      workerName: options.workerName,
    });
    process.stdout.write(`${JSON.stringify(settings)}\n`);
    return;
  }
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
