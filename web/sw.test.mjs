// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_PATH,
  META_CACHE,
  backendResponse,
  frontendResponse,
  readActiveRelease,
  stageRelease,
} from "./sw.js";
import {
  RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
  validateRelease,
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
    ...release.backend.chunks.map((chunk, index) => [chunk.url, chunks[index]]),
  ]);
  return { release, responses, backendBytes };
}

function fetchAssets(responses, failPath = null) {
  return async request => {
    const path = new URL(request.url).pathname;
    if (path === failPath) return new Response("failed", { status: 503 });
    const bytes = responses.get(path);
    return bytes === undefined ? new Response("missing", { status: 404 }) : new Response(bytes);
  };
}

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
