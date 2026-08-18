// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  ACTIVE_RECORD_PATH,
  BOOTSTRAP_ASSETS,
  BOOTSTRAP_CACHE,
  CANDIDATE_RECORD_PATH,
  LEGAL_PAGE_PATH,
  LEGACY_LEGAL_PAGE_PATH,
  META_CACHE,
  PROMOTE_CANARY_PATH,
  RELEASE_CACHE_PREFIX,
  STAGE_CANARY_PATH,
  WORKER_STATUS_PATH,
  activeReleaseResponse,
  cachedReleaseAsset,
  handleFetch,
  promoteCanaryRelease,
  readActiveRelease,
  readCandidateRelease,
  stageCanaryRelease,
  stageRelease,
  workerStatusResponse,
} from "./sw.js";
import {
  LEGACY_RELEASE_SCHEMA,
  PREVIOUS_RELEASE_SCHEMA,
  RELEASE_BOOTSTRAP_URLS,
  RELEASE_SCHEMA,
  RESIDENT_RUNTIME_ABI,
  RESIDENT_RUNTIME_CHOICE,
  ROLLBACK_RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseAssets,
  releaseIdentityPayload,
  sha256Hex,
  validateRelease,
  validateStoredRelease,
} from "./release.mjs";

const ORIGIN = "https://gekko.free";

function key(request) {
  return typeof request === "string" ? request : request.url;
}

class MemoryCache {
  constructor(name, log) {
    this.name = name;
    this.log = log;
    this.entries = new Map();
  }

  async match(request) {
    return this.entries.get(key(request))?.clone();
  }

  async put(request, response) {
    this.log.push(`put:${this.name}:${new URL(key(request)).pathname}`);
    this.entries.set(key(request), response.clone());
  }

  async delete(request) {
    this.log.push(`delete-entry:${this.name}:${new URL(key(request)).pathname}`);
    return this.entries.delete(key(request));
  }

  async keys() {
    return [...this.entries.keys()].map(url => new Request(url));
  }
}

class MemoryCacheStorage {
  constructor() {
    this.caches = new Map();
    this.log = [];
  }

  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MemoryCache(name, this.log));
    return this.caches.get(name);
  }

  async keys() {
    return [...this.caches.keys()];
  }

  async delete(name) {
    this.log.push(`delete:${name}`);
    return this.caches.delete(name);
  }
}

async function asset(bytes, prefix, extension) {
  const sha256 = await sha256Hex(bytes);
  return { url: `/assets/${prefix}-${sha256}.${extension}`, sha256, bytes: bytes.byteLength };
}

function source(seed) {
  const repository = "https://github.com/conradev/lazuli";
  const commit = seed.repeat(40);
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

async function assetWithResponse(responses, bytes, prefix, extension) {
  const descriptor = await asset(bytes, prefix, extension);
  responses.set(descriptor.url, bytes);
  return descriptor;
}

async function stableAssetWithResponse(responses, bytes, url) {
  const descriptor = { url, sha256: await sha256Hex(bytes), bytes: bytes.byteLength };
  responses.set(url, bytes);
  return descriptor;
}

async function makeRelease(seed = "1") {
  const responses = new Map();
  const bytes = label => new TextEncoder().encode(`${label}-${seed}`);
  const backendBytes = new Uint8Array(WASM_CHUNK_SIZE + 3).fill(seed.charCodeAt(0));
  const backendChunks = [
    backendBytes.slice(0, WASM_CHUNK_SIZE),
    backendBytes.slice(WASM_CHUNK_SIZE),
  ];
  const rollback = {
    schema: ROLLBACK_RELEASE_SCHEMA,
    source: source(seed),
    frontend: await assetWithResponse(responses, bytes("rollback frontend"), "rollback-frontend", "html"),
    renderer: {
      javascript: await assetWithResponse(responses, bytes("rollback renderer js"), "rollback-renderer", "js"),
      wasm: await assetWithResponse(responses, bytes("rollback renderer wasm"), "rollback-renderer-wasm", "wasm"),
    },
    dsp: await assetWithResponse(responses, bytes("rollback dsp"), "rollback-dsp", "wasm"),
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: await sha256Hex(backendBytes),
      bytes: backendBytes.byteLength,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: await Promise.all(backendChunks.map((chunk, index) =>
        assetWithResponse(responses, chunk, `rollback-backend-${index}`, "wasm.chunk")
      )),
    },
  };
  rollback.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(rollback)));

  const runtime = {
    choice: RESIDENT_RUNTIME_CHOICE,
    abi: { ...RESIDENT_RUNTIME_ABI },
    core: await assetWithResponse(responses, bytes("core"), "browser-machine", "wasm"),
    dispatcher: await assetWithResponse(responses, bytes("dispatcher"), "resident-dispatcher", "wasm"),
    coordinator: await assetWithResponse(responses, bytes("coordinator"), "core-run-coordinator", "wasm"),
    adapter: await assetWithResponse(responses, bytes("adapter"), "resident-machine-adapter", "mjs"),
    worker: await assetWithResponse(responses, bytes("worker"), "resident-machine-worker", "mjs"),
  };
  const release = {
    schema: RELEASE_SCHEMA,
    source: source(seed),
    bootstrap: {
      document: await stableAssetWithResponse(
        responses,
        bytes("const EXPECTED_RELEASE_SCHEMA = 4;"),
        RELEASE_BOOTSTRAP_URLS.document,
      ),
      releaseModule: await stableAssetWithResponse(
        responses,
        bytes("export const RELEASE_SCHEMA = 4;"),
        RELEASE_BOOTSTRAP_URLS.releaseModule,
      ),
      serviceWorker: await stableAssetWithResponse(
        responses,
        bytes("validateRelease /.gekko/stage-canary /.gekko/promote-canary"),
        RELEASE_BOOTSTRAP_URLS.serviceWorker,
      ),
    },
    runtime,
    frontend: await assetWithResponse(responses, bytes("resident frontend"), "resident-frontend", "html"),
    renderer: {
      javascript: await assetWithResponse(responses, bytes("resident renderer js"), "resident-renderer", "js"),
      wasm: await assetWithResponse(responses, bytes("resident renderer wasm"), "resident-renderer-wasm", "wasm"),
    },
    rollback: { release: rollback },
  };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  await validateRelease(release);
  return { release, rollback, responses, backendBytes };
}

function fetchAssets(responses, failPath = null, requests = []) {
  return async request => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === failPath) return new Response("failed", { status: 503 });
    const value = responses.get(path);
    return value === undefined ? new Response("missing", { status: 404 }) : new Response(value);
  };
}

async function seedActiveRollback(storage, fixture, suffix = "rollback-active") {
  const cacheName = `${RELEASE_CACHE_PREFIX}${fixture.rollback.releaseId}-${suffix}`;
  const cache = await storage.open(cacheName);
  for (const descriptor of releaseAssets(fixture.rollback)) {
    await cache.put(`${ORIGIN}${descriptor.url}`, new Response(fixture.responses.get(descriptor.url)));
  }
  const record = { release: fixture.rollback, cacheName };
  const metadata = await storage.open(META_CACHE);
  await metadata.put(
    `${ORIGIN}${ACTIVE_RECORD_PATH}`,
    new Response(JSON.stringify(record)),
  );
  return record;
}

async function withWorkerGlobals(cacheStorage, fetcher, callback) {
  const replacements = {
    caches: cacheStorage,
    fetch: fetcher,
    self: { location: { origin: ORIGIN } },
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    return await callback();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

test("bootstrap keeps legal assets offline and identifies schema-4 resident worker", async () => {
  const storage = new MemoryCacheStorage();
  const cache = await storage.open(BOOTSTRAP_CACHE);
  await cache.put(`${ORIGIN}${LEGAL_PAGE_PATH}`, new Response("legal"));
  assert.ok(BOOTSTRAP_ASSETS.includes(LEGAL_PAGE_PATH));
  await withWorkerGlobals(storage, async () => { throw new Error("offline"); }, async () => {
    assert.equal(await (await handleFetch(new Request(`${ORIGIN}${LEGAL_PAGE_PATH}`))).text(), "legal");
    assert.equal(
      await (await handleFetch(new Request(`${ORIGIN}${LEGACY_LEGAL_PAGE_PATH}`))).text(),
      "legal",
    );
  });
  assert.equal(WORKER_STATUS_PATH, "/.gekko/worker-status");
  assert.deepEqual(await workerStatusResponse().json(), {
    releaseSchema: RELEASE_SCHEMA,
    runtimeChoice: RESIDENT_RUNTIME_CHOICE,
  });
});

test("schema 1, 2, and 3 stored records remain readable but not current-active", async () => {
  const fixture = await makeRelease();
  for (const schema of [LEGACY_RELEASE_SCHEMA, PREVIOUS_RELEASE_SCHEMA, ROLLBACK_RELEASE_SCHEMA]) {
    const historical = structuredClone(fixture.rollback);
    historical.schema = schema;
    if (schema < 3) delete historical.dsp;
    if (schema < 2) delete historical.renderer;
    historical.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(historical)));
    await validateStoredRelease(historical);
  }
  const storage = new MemoryCacheStorage();
  await seedActiveRollback(storage, fixture);
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.schema, ROLLBACK_RELEASE_SCHEMA);
  assert.equal((await activeReleaseResponse(storage, ORIGIN)).status, 503);
});

test("canary staging is inactive until exact-ID promotion", async () => {
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  const rollback = await seedActiveRollback(storage, fixture);
  const candidate = await stageCanaryRelease(fixture.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(fixture.responses),
    origin: ORIGIN,
    cacheSuffix: "canary",
  });
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.releaseId, rollback.release.releaseId);
  assert.equal((await readCandidateRelease(storage, ORIGIN)).release.releaseId, fixture.release.releaseId);
  await assert.rejects(
    promoteCanaryRelease("f".repeat(64), { cacheStorage: storage, origin: ORIGIN }),
    /exact candidate release is not staged/,
  );
  const promoted = await promoteCanaryRelease(fixture.release.releaseId, {
    cacheStorage: storage,
    origin: ORIGIN,
  });
  assert.equal(promoted.release.releaseId, fixture.release.releaseId);
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.releaseId, fixture.release.releaseId);
  assert.equal(await readCandidateRelease(storage, ORIGIN), null);
  assert.equal(candidate.rollback.release.releaseId, fixture.rollback.releaseId);
});

test("promotion rehashes every primary byte and rejects post-stage mutation", async () => {
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  const rollback = await seedActiveRollback(storage, fixture);
  const candidate = await stageCanaryRelease(fixture.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(fixture.responses),
    origin: ORIGIN,
    cacheSuffix: "mutated-primary",
  });
  const cache = storage.caches.get(candidate.cacheName);
  await cache.put(`${ORIGIN}${fixture.release.runtime.core.url}`, new Response("corrupt"));
  await assert.rejects(
    promoteCanaryRelease(fixture.release.releaseId, { cacheStorage: storage, origin: ORIGIN }),
    /candidate or rollback cache is incomplete/,
  );
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.releaseId, rollback.release.releaseId);
});

test("promotion rehashes every authenticated rollback byte", async () => {
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  const rollback = await seedActiveRollback(storage, fixture);
  const candidate = await stageCanaryRelease(fixture.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(fixture.responses),
    origin: ORIGIN,
    cacheSuffix: "mutated-rollback",
  });
  await storage.caches.get(candidate.rollback.cacheName).put(
    `${ORIGIN}${fixture.rollback.frontend.url}`,
    new Response("corrupt"),
  );
  await assert.rejects(
    promoteCanaryRelease(fixture.release.releaseId, { cacheStorage: storage, origin: ORIGIN }),
    /candidate or rollback cache is incomplete/,
  );
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.releaseId, rollback.release.releaseId);
});

test("promotion rejects unexpected cache entries", async () => {
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  await seedActiveRollback(storage, fixture);
  const candidate = await stageCanaryRelease(fixture.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(fixture.responses),
    origin: ORIGIN,
    cacheSuffix: "extra-entry",
  });
  await storage.caches.get(candidate.cacheName).put(`${ORIGIN}/assets/unexpected`, new Response("x"));
  await assert.rejects(
    promoteCanaryRelease(fixture.release.releaseId, { cacheStorage: storage, origin: ORIGIN }),
    /candidate or rollback cache is incomplete/,
  );
});

test("serving rehashes an active cached executable and repairs only from verified network bytes", async () => {
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  const active = await stageRelease(fixture.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(fixture.responses),
    origin: ORIGIN,
    cacheSuffix: "serve-mutation",
  });
  const asset = fixture.release.runtime.worker;
  await storage.caches.get(active.cacheName).put(`${ORIGIN}${asset.url}`, new Response("corrupt"));
  const requests = [];
  const response = await cachedReleaseAsset(
    new Request(`${ORIGIN}${asset.url}`),
    storage,
    ORIGIN,
    fetchAssets(fixture.responses, null, requests),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), fixture.responses.get(asset.url));
  assert.deepEqual(requests, [asset.url]);

  await storage.caches.get(active.cacheName).put(`${ORIGIN}${asset.url}`, new Response("corrupt again"));
  const unavailable = await cachedReleaseAsset(
    new Request(`${ORIGIN}${asset.url}`),
    storage,
    ORIGIN,
    fetchAssets(new Map()),
  );
  assert.equal(unavailable.status, 503);
});

test("failed canary fetch preserves active and cleans newly created caches", async () => {
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  const rollback = await seedActiveRollback(storage, fixture);
  const failing = fixture.release.runtime.coordinator.url;
  await assert.rejects(
    stageCanaryRelease(fixture.release, {
      cacheStorage: storage,
      fetcher: fetchAssets(fixture.responses, failing),
      origin: ORIGIN,
      cacheSuffix: "failed",
    }),
    /HTTP 503/,
  );
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.releaseId, rollback.release.releaseId);
  assert.equal(await readCandidateRelease(storage, ORIGIN), null);
  assert.ok([...storage.caches.keys()].every(name => !name.includes("failed-candidate")));
});

test("HTTP canary and promotion controls require exact request bodies", async () => {
  assert.equal(STAGE_CANARY_PATH, "/.gekko/stage-canary");
  assert.equal(PROMOTE_CANARY_PATH, "/.gekko/promote-canary");
  assert.equal(CANDIDATE_RECORD_PATH, "/.gekko/candidate-release");
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  await seedActiveRollback(storage, fixture);
  await withWorkerGlobals(storage, fetchAssets(fixture.responses), async () => {
    const staged = await handleFetch(new Request(`${ORIGIN}${STAGE_CANARY_PATH}`, {
      method: "POST",
      body: JSON.stringify(fixture.release),
    }));
    assert.deepEqual(await staged.json(), { ok: true, active: false, release: fixture.release });
    const invalid = await handleFetch(new Request(`${ORIGIN}${PROMOTE_CANARY_PATH}`, {
      method: "POST",
      body: JSON.stringify({ releaseId: fixture.release.releaseId, extra: true }),
    }));
    assert.equal(invalid.status, 409);
    const promoted = await handleFetch(new Request(`${ORIGIN}${PROMOTE_CANARY_PATH}`, {
      method: "POST",
      body: JSON.stringify({ releaseId: fixture.release.releaseId }),
    }));
    assert.equal(promoted.status, 200);
  });
});

test("service worker exposes no misleading mixed-schema rollback endpoint", async () => {
  const worker = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /\/\.gekko\/rollback-release|rollbackActiveRelease/);
});

test("active endpoint exposes schema 4 only and immutable routes never escape active identity", async () => {
  const fixture = await makeRelease();
  const storage = new MemoryCacheStorage();
  await stageRelease(fixture.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(fixture.responses),
    origin: ORIGIN,
    cacheSuffix: "observer",
  });
  const response = await activeReleaseResponse(storage, ORIGIN);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), fixture.release);
  const unknown = await cachedReleaseAsset(
    new Request(`${ORIGIN}/assets/not-in-release.wasm`),
    storage,
    ORIGIN,
    async () => { throw new Error("must not use network"); },
  );
  assert.equal(unknown.status, 503);
});
