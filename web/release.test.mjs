// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEGACY_RELEASE_SCHEMA,
  PREVIOUS_RELEASE_SCHEMA,
  RELEASE_BOOTSTRAP_URLS,
  RELEASE_SCHEMA,
  RESIDENT_RUNTIME_ABI,
  RESIDENT_RUNTIME_CHOICE,
  ROLLBACK_RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
  validateRelease,
  validateRollbackRelease,
  validateStoredRelease,
} from "./release.mjs";

const HASH = "0".repeat(64);
const COMMIT = "0".repeat(40);

function asset(prefix, extension, hash = HASH) {
  return { url: `/assets/${prefix}-${hash}.${extension}`, sha256: hash, bytes: 1 };
}

function stableAsset(url, hash = HASH) {
  return { url, sha256: hash, bytes: 1 };
}

function source() {
  const repository = "https://github.com/conradev/lazuli";
  return {
    repository,
    commit: COMMIT,
    tree: `${repository}/tree/${COMMIT}`,
    archive: `${repository}/archive/${COMMIT}.tar.gz`,
    license: {
      expression: "GPL-3.0-only",
      text: "/LICENSE.txt",
      source: `${repository}/blob/${COMMIT}/licenses/GPL-3.0-only.txt`,
    },
  };
}

async function schema3Release() {
  const release = {
    schema: ROLLBACK_RELEASE_SCHEMA,
    source: source(),
    frontend: asset("rollback-frontend", "html"),
    renderer: {
      javascript: asset("rollback-renderer", "js"),
      wasm: asset("rollback-renderer-wasm", "wasm"),
    },
    dsp: asset("rollback-dsp", "wasm"),
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: HASH,
      bytes: 1,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [asset("rollback-backend", "wasm.chunk")],
    },
  };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  return release;
}

async function schema4Release() {
  const rollback = await schema3Release();
  const release = {
    schema: RELEASE_SCHEMA,
    source: source(),
    bootstrap: {
      document: stableAsset(RELEASE_BOOTSTRAP_URLS.document),
      releaseModule: stableAsset(RELEASE_BOOTSTRAP_URLS.releaseModule),
      serviceWorker: stableAsset(RELEASE_BOOTSTRAP_URLS.serviceWorker),
    },
    runtime: {
      choice: RESIDENT_RUNTIME_CHOICE,
      abi: { ...RESIDENT_RUNTIME_ABI },
      core: asset("browser-machine", "wasm"),
      dispatcher: asset("resident-dispatcher", "wasm"),
      coordinator: asset("core-run-coordinator", "wasm"),
      adapter: asset("resident-machine-adapter", "mjs"),
      worker: asset("resident-machine-worker", "mjs"),
    },
    frontend: asset("resident-frontend", "html"),
    renderer: {
      javascript: asset("resident-renderer", "js"),
      wasm: asset("resident-renderer-wasm", "wasm"),
    },
    rollback: { release: rollback },
  };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  return release;
}

async function resign(release) {
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  return release;
}

test("schema 4 validates one exact resident runtime and authenticated rollback", async () => {
  const release = await schema4Release();
  assert.equal(await validateRelease(release), release);
  assert.equal(await validateRollbackRelease(release.rollback.release), release.rollback.release);
});

test("schema 4 rejects unknown keys at every authenticated nesting level", async () => {
  const mutations = [
    release => { release.unknown = true; },
    release => { release.source.unknown = true; },
    release => { release.source.license.unknown = true; },
    release => { release.bootstrap.unknown = true; },
    release => { release.bootstrap.document.unknown = true; },
    release => { release.runtime.unknown = true; },
    release => { release.runtime.abi.unknown = true; },
    release => { release.runtime.core.unknown = true; },
    release => { release.renderer.unknown = true; },
    release => { release.renderer.javascript.unknown = true; },
    release => { release.rollback.unknown = true; },
    release => { release.rollback.release.unknown = true; },
    release => { release.rollback.release.backend.unknown = true; },
    release => { release.rollback.release.backend.chunks[0].unknown = true; },
  ];
  for (const mutate of mutations) {
    const release = await schema4Release();
    mutate(release);
    await resign(release);
    await assert.rejects(validateRelease(release), /keys are not exact/);
  }
});

test("schema 4 binds every resident executable and ABI value into its identity", async () => {
  const baseline = await schema4Release();
  for (const path of ["core", "dispatcher", "coordinator", "adapter", "worker"]) {
    const changed = structuredClone(baseline);
    const hash = "1".repeat(64);
    changed.runtime[path].sha256 = hash;
    changed.runtime[path].url = changed.runtime[path].url.replace(HASH, hash);
    await resign(changed);
    assert.notEqual(changed.releaseId, baseline.releaseId, path);
    await validateRelease(changed);
  }
  for (const name of Object.keys(RESIDENT_RUNTIME_ABI)) {
    const changed = structuredClone(baseline);
    changed.runtime.abi[name] += 1;
    await resign(changed);
    await assert.rejects(validateRelease(changed), new RegExp(`ABI ${name}`));
  }
});

test("schema 4 binds every stable executable bootstrap byte descriptor into its identity", async () => {
  const baseline = await schema4Release();
  for (const name of Object.keys(RELEASE_BOOTSTRAP_URLS)) {
    const changed = structuredClone(baseline);
    changed.bootstrap[name].sha256 = "1".repeat(64);
    await resign(changed);
    assert.notEqual(changed.releaseId, baseline.releaseId, name);
    await validateRelease(changed);
  }
  const changedSize = structuredClone(baseline);
  changedSize.bootstrap.serviceWorker.bytes += 1;
  await resign(changedSize);
  assert.notEqual(changedSize.releaseId, baseline.releaseId);
  await validateRelease(changedSize);
  const wrongUrl = structuredClone(baseline);
  wrongUrl.bootstrap.document.url = "/";
  await resign(wrongUrl);
  await assert.rejects(validateRelease(wrongUrl), /bootstrap document URL is not exact/);
});

test("schema 4 rejects a default-off fidelity topology", async () => {
  const release = await schema4Release();
  delete release.runtime.abi.gameFidelityBytes;
  await resign(release);
  await assert.rejects(validateRelease(release), /resident runtime ABI keys are not exact/);
});

test("schema 4 rejects rollback identity and shape tampering", async () => {
  const changedBytes = await schema4Release();
  changedBytes.rollback.release.frontend.bytes += 1;
  await resign(changedBytes);
  await assert.rejects(validateRelease(changedBytes), /release ID does not match/);

  const extra = await schema4Release();
  extra.rollback.release.ignored = "not authenticated by schema 3";
  await resign(extra);
  await assert.rejects(validateRelease(extra), /keys are not exact/);
});

test("standalone schema 3 remains permissive while schema-4 rollback use is exact", async () => {
  const release = await schema3Release();
  release.historicalExtension = true;
  await validateStoredRelease(release);
  await assert.rejects(async () => validateRollbackRelease(release), /keys are not exact/);
});

test("historical schema 1, 2, and 3 identity bytes are unchanged", async () => {
  const rollback = await schema3Release();
  const common = {
    source: rollback.source,
    frontend: { url: `/assets/frontend-${HASH}.html`, sha256: HASH, bytes: 1 },
    renderer: {
      javascript: { url: `/assets/browser-renderer-${HASH}.js`, sha256: HASH, bytes: 1 },
      wasm: { url: `/assets/browser-renderer-wasm-${HASH}.wasm`, sha256: HASH, bytes: 1 },
    },
    dsp: { url: `/assets/browser-dsp-${HASH}.wasm`, sha256: HASH, bytes: 1 },
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: HASH,
      bytes: 1,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [{ url: `/assets/backend-${HASH}.wasm.chunk`, sha256: HASH, bytes: 1 }],
    },
  };
  const identities = await Promise.all([
    LEGACY_RELEASE_SCHEMA,
    PREVIOUS_RELEASE_SCHEMA,
    ROLLBACK_RELEASE_SCHEMA,
  ].map(schema => sha256Hex(JSON.stringify(releaseIdentityPayload({ schema, ...common })))));
  assert.deepEqual(identities, [
    "72e80c8a319bb827bed4e70498dc5a7f0b099fd4e9f6b8c7db567ec18db63b35",
    "1d07092a58d2990afe165cc35d49b209acd32c1c9d87bbb0a62484366cd42a36",
    "78b74472a6e9ea6a82b4f87592e2646251b1ff491c15a702a5366af7178de0cb",
  ]);
});
