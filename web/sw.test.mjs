// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_PATH,
  META_CACHE,
  WORKER_STATUS_PATH,
  backendResponse,
  cachedReleaseAsset,
  frontendResponse,
  handleFetch,
  readActiveRelease,
  stageRelease,
  workerStatusResponse,
} from "./sw.js";
import {
  LEGACY_RELEASE_SCHEMA,
  RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
  validateRelease,
  validateStoredRelease,
} from "./release.mjs";

const ORIGIN = "https://gekko.free";

test("worker status identifies the release schema during upgrades", async () => {
  assert.equal(WORKER_STATUS_PATH, "/.gekko/worker-status");
  const response = workerStatusResponse();
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { releaseSchema: RELEASE_SCHEMA });
});

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

async function makeRelease(seed) {
  const frontendBytes = new TextEncoder().encode(`<p>release ${seed}</p>`);
  const rendererJavascriptBytes = new TextEncoder().encode("export default function init() {}\n");
  const rendererWasmBytes = new TextEncoder().encode("shared renderer wasm");
  const backendBytes = new Uint8Array(WASM_CHUNK_SIZE + 3);
  backendBytes.fill(seed);
  const chunks = [
    backendBytes.slice(0, WASM_CHUNK_SIZE),
    backendBytes.slice(WASM_CHUNK_SIZE),
  ];
  const source = {
    repository: "https://github.com/conradev/lazuli",
    commit: String(seed).repeat(40),
    tree: `https://github.com/conradev/lazuli/tree/${String(seed).repeat(40)}`,
    archive: `https://github.com/conradev/lazuli/archive/${String(seed).repeat(40)}.tar.gz`,
    license: {
      expression: "GPL-3.0-only",
      text: "/LICENSE.txt",
      source: `https://github.com/conradev/lazuli/blob/${String(seed).repeat(40)}/licenses/GPL-3.0-only.txt`,
    },
  };
  const release = {
    schema: RELEASE_SCHEMA,
    source,
    frontend: await asset(frontendBytes, "frontend", "html"),
    renderer: {
      javascript: await asset(rendererJavascriptBytes, "browser-renderer", "js"),
      wasm: await asset(rendererWasmBytes, "browser-renderer-wasm", "wasm"),
    },
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: await sha256Hex(backendBytes),
      bytes: backendBytes.byteLength,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: await Promise.all(chunks.map(bytes => asset(bytes, "backend", "wasm.chunk"))),
    },
  };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  const responses = new Map([
    [release.frontend.url, frontendBytes],
    [release.renderer.javascript.url, rendererJavascriptBytes],
    [release.renderer.wasm.url, rendererWasmBytes],
    ...release.backend.chunks.map((chunk, index) => [chunk.url, chunks[index]]),
  ]);
  return { release, responses, backendBytes };
}

async function legacyRelease(release) {
  const legacy = structuredClone(release);
  legacy.schema = LEGACY_RELEASE_SCHEMA;
  delete legacy.renderer;
  legacy.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(legacy)));
  return legacy;
}

function fetchAssets(responses, failPath = null) {
  return async request => {
    const path = new URL(request.url).pathname;
    if (path === failPath) return new Response("failed", { status: 503 });
    const bytes = responses.get(path);
    return bytes === undefined ? new Response("missing", { status: 404 }) : new Response(bytes);
  };
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

test("keeps a verified schema-1 release readable until schema 2 commits", async () => {
  const candidate = await makeRelease(6);
  const legacy = await legacyRelease(candidate.release);
  await validateStoredRelease(legacy);
  await assert.rejects(validateRelease(legacy), /unsupported schema/);

  const storage = new MemoryCacheStorage();
  const cacheName = `gekko-release-${legacy.releaseId}-legacy`;
  const metadata = await storage.open(META_CACHE);
  await metadata.put(
    `${ORIGIN}/.gekko/active-release`,
    new Response(JSON.stringify({ release: legacy, cacheName })),
  );
  const active = await readActiveRelease(storage, ORIGIN);
  assert.equal(active.release.releaseId, legacy.releaseId);
  assert.equal(active.release.schema, LEGACY_RELEASE_SCHEMA);

  const legacyCache = await storage.open(cacheName);
  for (const releaseAsset of [legacy.frontend, ...legacy.backend.chunks]) {
    await legacyCache.put(
      `${ORIGIN}${releaseAsset.url}`,
      new Response(candidate.responses.get(releaseAsset.url)),
    );
  }
  const inactiveCache = await storage.open(
    `gekko-release-${candidate.release.releaseId}-inactive-current`,
  );
  for (const rendererAsset of Object.values(candidate.release.renderer)) {
    await inactiveCache.put(
      `${ORIGIN}${rendererAsset.url}`,
      new Response(candidate.responses.get(rendererAsset.url)),
    );
  }
  await assert.rejects(
    frontendResponse(active, storage, ORIGIN),
    /release schema 2 is required/,
  );
  await assert.rejects(
    backendResponse(active, storage, ORIGIN),
    /release schema 2 is required/,
  );
  const legacyAssetRequests = [];
  const legacyAsset = await cachedReleaseAsset(
    new Request(`${ORIGIN}${legacy.frontend.url}`),
    storage,
    ORIGIN,
    recordingFetch(new Map(), legacyAssetRequests),
  );
  assert.equal(legacyAsset.status, 503);
  assert.deepEqual(legacyAssetRequests, []);

  const networkRequests = [];
  await withWorkerGlobals(
    storage,
    async request => {
      networkRequests.push(new URL(request.url).pathname);
      return new Response("unexpected network response");
    },
    async () => {
      const blockedPaths = [
        APP_PATH,
        legacy.backend.url,
        legacy.frontend.url,
        ...legacy.backend.chunks.map(chunk => chunk.url),
        ...Object.values(candidate.release.renderer).map(asset => asset.url),
      ];
      for (const path of blockedPaths) {
        const response = await handleFetch(new Request(`${ORIGIN}${path}`));
        assert.equal(response.status, 503, `${path} must fail closed during schema-1 migration`);
      }
    },
  );
  assert.deepEqual(networkRequests, []);

  await assert.rejects(
    stageRelease(candidate.release, {
      cacheStorage: storage,
      fetcher: fetchAssets(candidate.responses, candidate.release.renderer.wasm.url),
      origin: ORIGIN,
      cacheSuffix: "failed-upgrade",
    }),
    /fetch failed/,
  );
  const preserved = await readActiveRelease(storage, ORIGIN);
  assert.equal(preserved.release.releaseId, legacy.releaseId);
});

function recordingFetch(responses, requests) {
  return async request => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    const bytes = responses.get(path);
    return bytes === undefined ? new Response("missing", { status: 404 }) : new Response(bytes);
  };
}

test("commits a verified release only after every asset is cached", async () => {
  const storage = new MemoryCacheStorage();
  const first = await makeRelease(1);
  const record = await stageRelease(first.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(first.responses),
    origin: ORIGIN,
    cacheSuffix: "test",
  });
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.releaseId, first.release.releaseId);
  const metadataWrite = storage.log.findIndex(entry => entry.startsWith(`put:${META_CACHE}:`));
  const assetWrites = storage.log
    .map((entry, index) => entry.includes(`put:${record.cacheName}:`) ? index : -1)
    .filter(index => index >= 0);
  assert.ok(metadataWrite > Math.max(...assetWrites), "active pointer must be the final write");
  const releaseCache = storage.caches.get(record.cacheName);
  for (const rendererAsset of Object.values(first.release.renderer)) {
    assert.ok(
      releaseCache.entries.has(`${ORIGIN}${rendererAsset.url}`),
      `${rendererAsset.url} must be cached before commit`,
    );
  }

  const response = await backendResponse(record, storage, ORIGIN);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), first.backendBytes);

  const missing = first.release.backend.chunks[0];
  storage.caches.get(record.cacheName).entries.delete(`${ORIGIN}${missing.url}`);
  const requests = [];
  const recovered = await backendResponse(
    record,
    storage,
    ORIGIN,
    recordingFetch(first.responses, requests),
  );
  assert.deepEqual(requests, [missing.url]);
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), first.backendBytes);
});

test("a failed stage preserves the last known good release", async () => {
  const storage = new MemoryCacheStorage();
  const first = await makeRelease(1);
  await stageRelease(first.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(first.responses),
    origin: ORIGIN,
    cacheSuffix: "first",
  });
  const second = await makeRelease(2);
  await assert.rejects(
    stageRelease(second.release, {
      cacheStorage: storage,
      fetcher: fetchAssets(second.responses, second.release.backend.chunks[1].url),
      origin: ORIGIN,
      cacheSuffix: "second",
    }),
    /HTTP 503/,
  );
  const active = await readActiveRelease(storage, ORIGIN);
  assert.equal(active.release.releaseId, first.release.releaseId);
  assert.ok(storage.caches.has(active.cacheName));
  assert.ok(!storage.caches.has(`${active.cacheName.replace("first", "second")}`));
});

test("reuses unchanged content-addressed backend chunks across releases", async () => {
  const storage = new MemoryCacheStorage();
  const first = await makeRelease(1);
  const firstRecord = await stageRelease(first.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(first.responses),
    origin: ORIGIN,
    cacheSuffix: "first",
  });
  const second = await makeRelease(2);
  second.release.backend = structuredClone(first.release.backend);
  second.release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(second.release)));
  for (const [path, bytes] of first.responses) {
    if (path !== first.release.frontend.url) second.responses.set(path, bytes);
  }
  const requests = [];
  const secondRecord = await stageRelease(second.release, {
    cacheStorage: storage,
    fetcher: recordingFetch(second.responses, requests),
    origin: ORIGIN,
    cacheSuffix: "second",
  });
  assert.deepEqual(requests, [second.release.frontend.url]);
  assert.ok(storage.caches.has(firstRecord.cacheName), "the immediately previous release is retained");
  assert.ok(storage.caches.has(secondRecord.cacheName));
});

test("serves changing frontend releases from one stable app URL", async () => {
  assert.equal(APP_PATH, "/app.html");
  const storage = new MemoryCacheStorage();
  const first = await makeRelease(1);
  const firstRecord = await stageRelease(first.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(first.responses),
    origin: ORIGIN,
    cacheSuffix: "first",
  });
  assert.equal(
    await (await frontendResponse(firstRecord, storage, ORIGIN)).text(),
    "<p>release 1</p>",
  );

  const second = await makeRelease(2);
  const secondRecord = await stageRelease(second.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(second.responses),
    origin: ORIGIN,
    cacheSuffix: "second",
  });
  const response = await frontendResponse(secondRecord, storage, ORIGIN);
  assert.equal(await response.text(), "<p>release 2</p>");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
});

test("serves only the active schema-2 browser code through public routes", async () => {
  const storage = new MemoryCacheStorage();
  const candidate = await makeRelease(7);
  await stageRelease(candidate.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(candidate.responses),
    origin: ORIGIN,
    cacheSuffix: "active-current",
  });
  const networkRequests = [];
  await withWorkerGlobals(
    storage,
    async request => {
      networkRequests.push(new URL(request.url).pathname);
      return new Response("unexpected network response");
    },
    async () => {
      const frontend = await handleFetch(new Request(`${ORIGIN}${APP_PATH}`));
      assert.equal(frontend.status, 200);
      assert.equal(await frontend.text(), "<p>release 7</p>");

      const backend = await handleFetch(new Request(`${ORIGIN}${candidate.release.backend.url}`));
      assert.equal(backend.status, 200);
      assert.deepEqual(new Uint8Array(await backend.arrayBuffer()), candidate.backendBytes);

      for (const rendererAsset of Object.values(candidate.release.renderer)) {
        const response = await handleFetch(new Request(`${ORIGIN}${rendererAsset.url}`));
        assert.equal(response.status, 200, `${rendererAsset.url} must be served`);
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          candidate.responses.get(rendererAsset.url),
        );
      }
    },
  );
  assert.deepEqual(networkRequests, []);
});

test("post-commit cleanup failure cannot invalidate the active release", async () => {
  const storage = new MemoryCacheStorage();
  storage.keys = async () => { throw new Error("quota bookkeeping failed"); };
  const candidate = await makeRelease(3);
  const record = await stageRelease(candidate.release, {
    cacheStorage: storage,
    fetcher: fetchAssets(candidate.responses),
    origin: ORIGIN,
    cacheSuffix: "cleanup-fails",
  });
  assert.equal((await readActiveRelease(storage, ORIGIN)).release.releaseId, candidate.release.releaseId);
  assert.ok(storage.caches.has(record.cacheName));
});

test("rejects mutable release asset paths before fetching them", async () => {
  const candidate = await makeRelease(4);
  candidate.release.frontend.url = "/assets/frontend.html";
  candidate.release.releaseId = await sha256Hex(
    JSON.stringify(releaseIdentityPayload(candidate.release)),
  );
  await assert.rejects(validateRelease(candidate.release), /content-addressed|contain its hash/);
});

test("rejects a release without its renderer pair", async () => {
  const candidate = await makeRelease(5);
  delete candidate.release.renderer.wasm;
  candidate.release.releaseId = await sha256Hex(
    JSON.stringify(releaseIdentityPayload(candidate.release)),
  );
  await assert.rejects(validateRelease(candidate.release), /renderer wasm is missing/);
});
