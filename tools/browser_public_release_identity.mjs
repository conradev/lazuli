// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";

import {
  RELEASE_BOOTSTRAP_URLS,
  RELEASE_SCHEMA,
  RESIDENT_RUNTIME_ABI,
  RESIDENT_RUNTIME_CHOICE,
  ROLLBACK_RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
} from "../web/release.mjs";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ASSET_PATTERN = /^\/assets\/[a-z0-9][a-z0-9.-]*$/;

export class PublicActiveReleaseIdentityError extends Error {
  constructor(path, detail) {
    super(`invalid compact public active-release identity at ${path}: ${detail}`);
    this.name = "PublicActiveReleaseIdentityError";
    this.path = path;
    this.detail = detail;
  }
}

function fail(path, detail) {
  throw new PublicActiveReleaseIdentityError(path, detail);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(object(value, path)).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    fail(path, `keys must be ${canonical.join(", ")}; got ${actual.join(", ")}`);
  }
  return value;
}

function hash(value, path, pattern = HASH_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(path, pattern === COMMIT_PATTERN
      ? "expected a lowercase 160-bit commit digest"
      : "expected a lowercase 256-bit digest");
  }
  return value;
}

function asset(value, path, { extension = null, url = null } = {}) {
  exactKeys(value, ["bytes", "sha256", "url"], path);
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    fail(`${path}.bytes`, "expected a positive safe integer");
  }
  const digest = hash(value.sha256, `${path}.sha256`);
  if (typeof value.url !== "string") fail(`${path}.url`, "expected a URL string");
  if (url !== null) {
    if (value.url !== url) fail(`${path}.url`, `expected exact stable URL ${url}`);
  } else if (
    !ASSET_PATTERN.test(value.url)
    || !value.url.includes(`-${digest}.`)
    || (extension !== null && !value.url.endsWith(extension))
  ) {
    fail(`${path}.url`, "expected a content-addressed release asset URL");
  }
  return value;
}

function compactAsset(value) {
  return { url: value.url, sha256: value.sha256, bytes: value.bytes };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceMetadata(value, path) {
  exactKeys(value, ["archive", "commit", "license", "repository", "tree"], path);
  if (value.repository !== "https://github.com/conradev/lazuli") {
    fail(`${path}.repository`, "expected the canonical Lazuli repository");
  }
  hash(value.commit, `${path}.commit`, COMMIT_PATTERN);
  if (value.tree !== `${value.repository}/tree/${value.commit}`) {
    fail(`${path}.tree`, "expected the exact source tree URL");
  }
  if (value.archive !== `${value.repository}/archive/${value.commit}.tar.gz`) {
    fail(`${path}.archive`, "expected the exact source archive URL");
  }
  exactKeys(value.license, ["expression", "source", "text"], `${path}.license`);
  if (value.license.expression !== "GPL-3.0-only") {
    fail(`${path}.license.expression`, "expected GPL-3.0-only");
  }
  if (value.license.text !== "/LICENSE.txt") {
    fail(`${path}.license.text`, "expected /LICENSE.txt");
  }
  if (
    value.license.source
    !== `${value.repository}/blob/${value.commit}/licenses/GPL-3.0-only.txt`
  ) {
    fail(`${path}.license.source`, "expected the exact license source URL");
  }
}

function renderer(value, path) {
  exactKeys(value, ["javascript", "wasm"], path);
  asset(value.javascript, `${path}.javascript`, { extension: ".js" });
  asset(value.wasm, `${path}.wasm`, { extension: ".wasm" });
  if (value.javascript.url === value.wasm.url) {
    fail(path, "renderer assets must be distinct");
  }
}

function rollbackRelease(value, path) {
  exactKeys(value, [
    "backend",
    "dsp",
    "frontend",
    "releaseId",
    "renderer",
    "schema",
    "source",
  ], path);
  if (value.schema !== ROLLBACK_RELEASE_SCHEMA) {
    fail(`${path}.schema`, `expected rollback schema ${ROLLBACK_RELEASE_SCHEMA}`);
  }
  sourceMetadata(value.source, `${path}.source`);
  asset(value.frontend, `${path}.frontend`, { extension: ".html" });
  renderer(value.renderer, `${path}.renderer`);
  asset(value.dsp, `${path}.dsp`, { extension: ".wasm" });
  exactKeys(
    value.backend,
    ["bytes", "chunkSize", "chunks", "sha256", "url"],
    `${path}.backend`,
  );
  if (value.backend.url !== "/ppcwasmjit.wasm") {
    fail(`${path}.backend.url`, "expected /ppcwasmjit.wasm");
  }
  hash(value.backend.sha256, `${path}.backend.sha256`);
  if (!Number.isSafeInteger(value.backend.bytes) || value.backend.bytes <= 0) {
    fail(`${path}.backend.bytes`, "expected a positive safe integer");
  }
  if (value.backend.chunkSize !== WASM_CHUNK_SIZE) {
    fail(`${path}.backend.chunkSize`, `expected ${WASM_CHUNK_SIZE}`);
  }
  if (!Array.isArray(value.backend.chunks) || value.backend.chunks.length === 0) {
    fail(`${path}.backend.chunks`, "expected at least one backend chunk");
  }
  let bytes = 0;
  value.backend.chunks.forEach((chunk, index) => {
    asset(chunk, `${path}.backend.chunks[${index}]`, { extension: ".wasm.chunk" });
    if (
      chunk.bytes !== WASM_CHUNK_SIZE
      && !(index === value.backend.chunks.length - 1 && chunk.bytes <= WASM_CHUNK_SIZE)
    ) {
      fail(`${path}.backend.chunks[${index}].bytes`, "invalid backend chunk size");
    }
    bytes += chunk.bytes;
  });
  if (bytes !== value.backend.bytes) {
    fail(`${path}.backend.bytes`, "backend chunk sizes do not add up");
  }
  hash(value.releaseId, `${path}.releaseId`);
  if (sha256Json(releaseIdentityPayload(value)) !== value.releaseId) {
    fail(`${path}.releaseId`, "does not authenticate the nested rollback manifest");
  }
}

export function compactPublicActiveRelease(release) {
  const rollback = release.rollback.release;
  return {
    schema: release.schema,
    releaseId: release.releaseId,
    commit: release.source.commit,
    source: clone(release.source),
    bootstrap: {
      document: compactAsset(release.bootstrap.document),
      releaseModule: compactAsset(release.bootstrap.releaseModule),
      serviceWorker: compactAsset(release.bootstrap.serviceWorker),
    },
    runtime: {
      choice: release.runtime.choice,
      abi: { ...release.runtime.abi },
      core: compactAsset(release.runtime.core),
      dispatcher: compactAsset(release.runtime.dispatcher),
      coordinator: compactAsset(release.runtime.coordinator),
      adapter: compactAsset(release.runtime.adapter),
      worker: compactAsset(release.runtime.worker),
    },
    frontend: compactAsset(release.frontend),
    renderer: {
      javascript: compactAsset(release.renderer.javascript),
      wasm: compactAsset(release.renderer.wasm),
    },
    rollback: { release: clone(rollback) },
  };
}

export function validateCompactPublicActiveRelease(
  value,
  { expectedCommit = null, expectedReleaseId = null, path = "$" } = {},
) {
  exactKeys(value, [
    "bootstrap",
    "commit",
    "frontend",
    "releaseId",
    "renderer",
    "rollback",
    "runtime",
    "schema",
    "source",
  ], path);
  if (value.schema !== RELEASE_SCHEMA) {
    fail(`${path}.schema`, `expected release schema ${RELEASE_SCHEMA}`);
  }
  hash(value.commit, `${path}.commit`, COMMIT_PATTERN);
  hash(value.releaseId, `${path}.releaseId`);
  sourceMetadata(value.source, `${path}.source`);
  if (value.commit !== value.source.commit) {
    fail(`${path}.commit`, "does not match source.commit");
  }
  if (expectedCommit !== null && value.commit !== expectedCommit) {
    fail(`${path}.commit`, `expected ${expectedCommit}`);
  }
  if (expectedReleaseId !== null && value.releaseId !== expectedReleaseId) {
    fail(`${path}.releaseId`, `expected ${expectedReleaseId}`);
  }

  exactKeys(value.bootstrap, Object.keys(RELEASE_BOOTSTRAP_URLS), `${path}.bootstrap`);
  for (const [name, url] of Object.entries(RELEASE_BOOTSTRAP_URLS)) {
    asset(value.bootstrap[name], `${path}.bootstrap.${name}`, { url });
  }

  exactKeys(value.runtime, [
    "abi",
    "adapter",
    "choice",
    "coordinator",
    "core",
    "dispatcher",
    "worker",
  ], `${path}.runtime`);
  if (value.runtime.choice !== RESIDENT_RUNTIME_CHOICE) {
    fail(`${path}.runtime.choice`, `expected ${RESIDENT_RUNTIME_CHOICE}`);
  }
  exactKeys(value.runtime.abi, Object.keys(RESIDENT_RUNTIME_ABI), `${path}.runtime.abi`);
  for (const [name, expected] of Object.entries(RESIDENT_RUNTIME_ABI)) {
    if (value.runtime.abi[name] !== expected) {
      fail(`${path}.runtime.abi.${name}`, `expected ${expected}`);
    }
  }
  for (const name of ["core", "dispatcher", "coordinator"]) {
    asset(value.runtime[name], `${path}.runtime.${name}`, { extension: ".wasm" });
  }
  for (const name of ["adapter", "worker"]) {
    asset(value.runtime[name], `${path}.runtime.${name}`, { extension: ".mjs" });
  }

  asset(value.frontend, `${path}.frontend`, { extension: ".html" });
  renderer(value.renderer, `${path}.renderer`);

  exactKeys(value.rollback, ["release"], `${path}.rollback`);
  rollbackRelease(value.rollback.release, `${path}.rollback.release`);

  const urls = [
    ...Object.values(value.bootstrap),
    value.frontend,
    value.renderer.javascript,
    value.renderer.wasm,
    value.runtime.core,
    value.runtime.dispatcher,
    value.runtime.coordinator,
    value.runtime.adapter,
    value.runtime.worker,
  ].map(descriptor => descriptor.url);
  if (new Set(urls).size !== urls.length) {
    fail(path, "contains duplicate primary release asset URLs");
  }
  if (sha256Json(releaseIdentityPayload(value)) !== value.releaseId) {
    fail(`${path}.releaseId`, "does not authenticate the compact schema-4 identity");
  }
  return value;
}
