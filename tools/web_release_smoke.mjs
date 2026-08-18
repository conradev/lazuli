#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

import {
  RELEASE_SCHEMA,
  RESIDENT_RUNTIME_CHOICE,
  ROLLBACK_RELEASE_SCHEMA,
  releaseAssets,
  rollbackReleaseAssets,
  sha256Hex,
  validateRelease,
  validateRollbackRelease,
  verifyAssetBytes,
} from "../web/release.mjs";

const RELEASE_ID_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function exactOrigin(value) {
  const origin = new URL(value);
  check(origin.protocol === "https:", "smoke origin must use HTTPS");
  check(origin.username === "" && origin.password === "", "smoke origin must not contain credentials");
  check(origin.pathname === "/" && origin.search === "" && origin.hash === "",
    "smoke origin must be an exact origin URL");
  return origin.origin;
}

async function fetchOk(fetchImpl, url, label) {
  const response = await fetchImpl(url, { cache: "no-store", redirect: "error" });
  check(response.ok, `${label} fetch failed: HTTP ${response.status}`);
  return response;
}

function requireNoStore(response, label) {
  check(/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("Cache-Control") ?? ""),
    `${label} is not no-store`);
}

async function fetchVerifiedAssets(fetchImpl, origin, assets) {
  const fetched = new Map();
  const descriptors = new Map();
  for (const asset of assets) {
    const existing = descriptors.get(asset.url);
    if (existing !== undefined) {
      check(JSON.stringify(existing) === JSON.stringify(asset),
        `asset ${asset.url} has conflicting authenticated descriptors`);
      continue;
    }
    descriptors.set(asset.url, asset);
    const response = await fetchOk(fetchImpl, `${origin}${asset.url}`, asset.url);
    if (asset.url.startsWith("/assets/")) {
      check(/(?:^|,)\s*(?:public\s*,\s*)?max-age=31536000\s*,\s*immutable(?:,|$)/i.test(
        response.headers.get("Cache-Control") ?? "",
      ), `${asset.url} is not immutable`);
    } else {
      requireNoStore(response, asset.url);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyAssetBytes(asset, bytes);
    fetched.set(asset.url, bytes);
  }
  return fetched;
}

function textAsset(fetched, asset, label) {
  const bytes = fetched.get(asset.url);
  check(bytes !== undefined, `${label} was not fetched`);
  return new TextDecoder().decode(bytes);
}

async function verifyBootstrap(fetchImpl, origin, release, fetched) {
  const schema = release.schema;
  let rootSource;
  let releaseSource;
  let workerSource;
  if (schema === RELEASE_SCHEMA) {
    const root = await fetchOk(fetchImpl, `${origin}/`, "root shell");
    requireNoStore(root, "root shell");
    const rootBytes = new Uint8Array(await root.arrayBuffer());
    await verifyAssetBytes(release.bootstrap.document, rootBytes);
    rootSource = new TextDecoder().decode(rootBytes);
    releaseSource = textAsset(fetched, release.bootstrap.releaseModule, "release module");
    workerSource = textAsset(fetched, release.bootstrap.serviceWorker, "service worker");
  } else {
    const [root, releaseModule, worker] = await Promise.all([
      fetchOk(fetchImpl, `${origin}/`, "root shell"),
      fetchOk(fetchImpl, `${origin}/release.mjs`, "release module"),
      fetchOk(fetchImpl, `${origin}/sw.js`, "service worker"),
    ]);
    requireNoStore(root, "root shell");
    requireNoStore(releaseModule, "release module");
    requireNoStore(worker, "service worker");
    [rootSource, releaseSource, workerSource] = await Promise.all([
      root.text(),
      releaseModule.text(),
      worker.text(),
    ]);
  }
  check(rootSource.includes(`const EXPECTED_RELEASE_SCHEMA = ${schema};`),
    "root shell schema does not match the release");
  check(releaseSource.includes(`export const RELEASE_SCHEMA = ${schema};`),
    "release validator schema does not match the release");
  check(workerSource.includes("validateRelease"), "service worker omits release validation");
  if (schema === RELEASE_SCHEMA) {
    check(rootSource.includes(`const EXPECTED_RUNTIME_CHOICE = "${RESIDENT_RUNTIME_CHOICE}";`),
      "root shell runtime choice does not match the release");
    for (const path of ["/.gekko/stage-canary", "/.gekko/promote-canary"]) {
      check(workerSource.includes(path), `service worker omits ${path}`);
    }
  }
}

export async function smokeWebRelease(options) {
  const origin = exactOrigin(options.origin);
  const expectedSchema = Number(options.expectedSchema ?? RELEASE_SCHEMA);
  check(
    expectedSchema === RELEASE_SCHEMA || expectedSchema === ROLLBACK_RELEASE_SCHEMA,
    "expected schema must be 3 or 4",
  );
  check(RELEASE_ID_PATTERN.test(options.expectedReleaseId ?? ""), "expected release ID is invalid");
  if (options.expectedSourceCommit !== undefined) {
    check(COMMIT_PATTERN.test(options.expectedSourceCommit), "expected source commit is invalid");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  check(typeof fetchImpl === "function", "fetch is unavailable");

  const manifestResponse = await fetchOk(fetchImpl, `${origin}/release.json`, "release manifest");
  requireNoStore(manifestResponse, "release manifest");
  const release = await manifestResponse.json();
  if (expectedSchema === RELEASE_SCHEMA) await validateRelease(release);
  else await validateRollbackRelease(release);
  check(release.schema === expectedSchema, `release schema ${release.schema} does not match ${expectedSchema}`);
  check(
    release.releaseId === options.expectedReleaseId,
    `release ${release.releaseId} does not match pinned ${options.expectedReleaseId}`,
  );
  if (options.expectedSourceCommit !== undefined) {
    check(
      release.source.commit === options.expectedSourceCommit,
      `source commit ${release.source.commit} does not match ${options.expectedSourceCommit}`,
    );
  }

  const assets = expectedSchema === RELEASE_SCHEMA
    ? [...releaseAssets(release), ...rollbackReleaseAssets(release)]
    : releaseAssets(release);
  const fetched = await fetchVerifiedAssets(fetchImpl, origin, assets);
  if (expectedSchema === RELEASE_SCHEMA) {
    check(
      RELEASE_ID_PATTERN.test(options.expectedRollbackReleaseId ?? ""),
      "expected rollback release ID is invalid",
    );
    check(
      release.rollback.release.releaseId === options.expectedRollbackReleaseId,
      `rollback release ${release.rollback.release.releaseId} does not match ` +
        `${options.expectedRollbackReleaseId}`,
    );
    const frontend = textAsset(fetched, release.frontend, "resident frontend");
    check(!frontend.includes("__LAZULI_RESIDENT_RELEASE_RUNTIME__"),
      "resident frontend retained its build marker");
    check(!frontend.includes("/ppcwasmjit.wasm") && !frontend.includes("/browser_dsp.wasm"),
      "resident frontend retained a legacy runtime URL");
    for (const artifact of [
      release.runtime.worker,
      release.runtime.core,
      release.runtime.dispatcher,
      release.runtime.coordinator,
    ]) {
      check(frontend.includes(artifact.url), `resident frontend omits ${artifact.url}`);
    }
    const worker = textAsset(fetched, release.runtime.worker, "resident worker");
    check(worker.includes(`from "${release.runtime.adapter.url}"`),
      "resident worker does not import its authenticated adapter");
    check(!worker.includes('from "./resident-machine.mjs"'),
      "resident worker retained its mutable adapter import");
  } else {
    const backend = new Uint8Array(release.backend.bytes);
    let offset = 0;
    for (const chunk of release.backend.chunks) {
      const bytes = fetched.get(chunk.url);
      backend.set(bytes, offset);
      offset += bytes.byteLength;
    }
    check(await sha256Hex(backend) === release.backend.sha256,
      "schema-3 rollback backend chunks do not match the aggregate hash");
  }
  await verifyBootstrap(fetchImpl, origin, release, fetched);
  return Object.freeze({
    ok: true,
    origin,
    schema: release.schema,
    releaseId: release.releaseId,
    sourceCommit: release.source.commit,
    rollbackReleaseId: release.schema === RELEASE_SCHEMA
      ? release.rollback.release.releaseId
      : null,
    verifiedAssets: new Set(assets.map(asset => asset.url)).size,
  });
}

function parseArguments(arguments_) {
  const options = { attempts: 1, retryMs: 0 };
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    check(name?.startsWith("--") && value !== undefined, `invalid argument ${name ?? ""}`);
    const key = {
      "--origin": "origin",
      "--expect-schema": "expectedSchema",
      "--expect-release-id": "expectedReleaseId",
      "--expect-source-commit": "expectedSourceCommit",
      "--expect-rollback-release-id": "expectedRollbackReleaseId",
      "--attempts": "attempts",
      "--retry-ms": "retryMs",
    }[name];
    check(key !== undefined, `unknown argument ${name}`);
    options[key] = value;
  }
  for (const key of ["origin", "expectedReleaseId"]) {
    check(typeof options[key] === "string", `missing required ${key}`);
  }
  options.attempts = Number(options.attempts);
  options.retryMs = Number(options.retryMs);
  check(Number.isInteger(options.attempts) && options.attempts >= 1 && options.attempts <= 60,
    "attempts must be an integer from 1 through 60");
  check(Number.isInteger(options.retryMs) && options.retryMs >= 0 && options.retryMs <= 5000,
    "retry-ms must be an integer from 0 through 5000");
  return options;
}

async function smokeWithRetry(options) {
  let lastError;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await smokeWebRelease(options);
    } catch (error) {
      lastError = error;
      if (attempt < options.attempts && options.retryMs > 0) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, options.retryMs));
      }
    }
  }
  throw lastError;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await smokeWithRetry(
      parseArguments(process.argv.slice(2)),
    ))}\n`);
  } catch (error) {
    process.stderr.write(`web_release_smoke: ${error.message}\n`);
    process.exitCode = 1;
  }
}
