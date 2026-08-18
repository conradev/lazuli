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
import { compactPublicActiveRelease } from "./browser_public_release_identity.mjs";

const DEFAULT_HASH = "2".repeat(64);
const DEFAULT_COMMIT = "1".repeat(40);

function source(commit) {
  const repository = "https://github.com/conradev/lazuli";
  return {
    repository,
    commit,
    tree: `${repository}/tree/${commit}`,
    archive: `${repository}/archive/${commit}.tar.gz`,
    license: {
      expression: "GPL-3.0-only",
      text: "/LICENSE.txt",
      source: `${repository}/blob/${commit}/licenses/GPL-3.0-only.txt`,
    },
  };
}

function asset(prefix, extension, bytes, hash) {
  return {
    url: `/assets/${prefix}-${hash}.${extension}`,
    sha256: hash,
    bytes,
  };
}

function stableAsset(url, bytes, hash) {
  return { url, sha256: hash, bytes };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function makeSchema4ReleaseFixture({
  assetHash = DEFAULT_HASH,
  commit = DEFAULT_COMMIT,
  rollbackCommit = "3".repeat(40),
} = {}) {
  const rollback = {
    schema: ROLLBACK_RELEASE_SCHEMA,
    source: source(rollbackCommit),
    frontend: asset("rollback-frontend", "html", 1_001, assetHash),
    renderer: {
      javascript: asset("rollback-renderer", "js", 1_002, assetHash),
      wasm: asset("rollback-renderer-wasm", "wasm", 1_003, assetHash),
    },
    dsp: asset("rollback-dsp", "wasm", 1_004, assetHash),
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: assetHash,
      bytes: WASM_CHUNK_SIZE,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [asset("rollback-backend-0000", "wasm.chunk", WASM_CHUNK_SIZE, assetHash)],
    },
  };
  rollback.releaseId = sha256Json(releaseIdentityPayload(rollback));

  const release = {
    schema: RELEASE_SCHEMA,
    source: source(commit),
    bootstrap: {
      document: stableAsset(RELEASE_BOOTSTRAP_URLS.document, 501, assetHash),
      releaseModule: stableAsset(RELEASE_BOOTSTRAP_URLS.releaseModule, 502, assetHash),
      serviceWorker: stableAsset(RELEASE_BOOTSTRAP_URLS.serviceWorker, 503, assetHash),
    },
    runtime: {
      choice: RESIDENT_RUNTIME_CHOICE,
      abi: { ...RESIDENT_RUNTIME_ABI },
      core: asset("browser-machine", "wasm", 2_001, assetHash),
      dispatcher: asset("resident-dispatcher", "wasm", 2_002, assetHash),
      coordinator: asset("core-run-coordinator", "wasm", 2_003, assetHash),
      adapter: asset("resident-machine-adapter", "mjs", 2_004, assetHash),
      worker: asset("resident-machine-worker", "mjs", 2_005, assetHash),
    },
    frontend: asset("frontend", "html", 3_001, assetHash),
    renderer: {
      javascript: asset("browser-renderer", "js", 3_002, assetHash),
      wasm: asset("browser-renderer-wasm", "wasm", 3_003, assetHash),
    },
    rollback: { release: rollback },
  };
  release.releaseId = sha256Json(releaseIdentityPayload(release));
  return release;
}

export async function schema4ReleaseFixture(options = {}) {
  return makeSchema4ReleaseFixture(options);
}

export function compactSchema4ReleaseIdentityFixture({
  assetHash = DEFAULT_HASH,
  commit = DEFAULT_COMMIT,
  rollbackCommit = "3".repeat(40),
} = {}) {
  return compactPublicActiveRelease(makeSchema4ReleaseFixture({
    assetHash,
    commit,
    rollbackCommit,
  }));
}
