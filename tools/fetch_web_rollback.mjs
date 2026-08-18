#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  RELEASE_SCHEMA,
  ROLLBACK_RELEASE_SCHEMA,
  releaseAssets,
  validateRelease,
  validateRollbackRelease,
  verifyAssetBytes,
} from "../web/release.mjs";

const RELEASE_ID_PATTERN = /^[0-9a-f]{64}$/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function exactOrigin(value) {
  const origin = new URL(value);
  check(origin.protocol === "https:", "rollback origin must use HTTPS");
  check(origin.username === "" && origin.password === "", "rollback origin must not contain credentials");
  check(origin.pathname === "/" && origin.search === "" && origin.hash === "",
    "rollback origin must be an exact origin URL");
  return origin.origin;
}

function outputDirectory(path) {
  const output = resolve(path);
  check(basename(output) !== "" && output !== resolve("/"), "rollback output is unsafe");
  return output;
}

async function requireEmptyDirectory(output) {
  await mkdir(output, { recursive: true });
  check((await readdir(output)).length === 0, `rollback output directory is not empty: ${output}`);
}

function outputAssetPath(output, asset) {
  const path = resolve(output, asset.url.slice(1));
  const remainder = relative(output, path);
  check(remainder !== "" && !remainder.startsWith("..") && !remainder.startsWith("/"),
    `rollback asset escapes output: ${asset.url}`);
  return path;
}

async function fetchOk(fetchImpl, url, label) {
  const response = await fetchImpl(url, { cache: "no-store" });
  check(response.ok, `${label} fetch failed: HTTP ${response.status}`);
  return response;
}

export async function fetchRollbackRelease(options) {
  const origin = exactOrigin(options.origin);
  const expectedReleaseId = options.expectedReleaseId;
  check(RELEASE_ID_PATTERN.test(expectedReleaseId ?? ""), "expected rollback release ID is invalid");
  const output = outputDirectory(options.outputPath);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  check(typeof fetchImpl === "function", "fetch is unavailable");

  const manifestResponse = await fetchOk(fetchImpl, `${origin}/release.json`, "rollback manifest");
  const liveRelease = await manifestResponse.json();
  let release;
  if (liveRelease.schema === ROLLBACK_RELEASE_SCHEMA) {
    await validateRollbackRelease(liveRelease);
    release = liveRelease;
  } else if (liveRelease.schema === RELEASE_SCHEMA) {
    await validateRelease(liveRelease);
    release = liveRelease.rollback.release;
  } else {
    throw new Error(`live release schema ${liveRelease.schema} cannot supply a schema-3 rollback`);
  }
  check(
    release.releaseId === expectedReleaseId,
    `live rollback release ${release.releaseId} does not match pinned ${expectedReleaseId}`,
  );

  await requireEmptyDirectory(output);
  for (const asset of releaseAssets(release)) {
    const response = await fetchOk(fetchImpl, `${origin}${asset.url}`, asset.url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyAssetBytes(asset, bytes);
    const path = outputAssetPath(output, asset);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(join(output, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    check(name?.startsWith("--") && value !== undefined, `invalid argument ${name ?? ""}`);
    const key = {
      "--origin": "origin",
      "--expect-release-id": "expectedReleaseId",
      "--output": "outputPath",
    }[name];
    check(key !== undefined, `unknown argument ${name}`);
    options[key] = value;
  }
  for (const key of ["origin", "expectedReleaseId", "outputPath"]) {
    check(typeof options[key] === "string", `missing required ${key}`);
  }
  return options;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const release = await fetchRollbackRelease(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${release.releaseId}\n`);
  } catch (error) {
    process.stderr.write(`fetch_web_rollback: ${error.message}\n`);
    process.exitCode = 1;
  }
}
