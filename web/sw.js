// SPDX-License-Identifier: GPL-3.0-only

import {
  RELEASE_SCHEMA,
  RESIDENT_RUNTIME_CHOICE,
  ROLLBACK_RELEASE_SCHEMA,
  releaseAssets,
  validateRelease,
  validateStoredRelease,
  verifyAssetBytes,
} from "./release.mjs";

export const BOOTSTRAP_CACHE = "gekko-bootstrap-v3";
export const META_CACHE = "gekko-meta-v1";
export const RELEASE_CACHE_PREFIX = "gekko-release-";
export const ACTIVE_RECORD_PATH = "/.gekko/active-release";
export const STAGE_RELEASE_PATH = "/.gekko/stage-release";
export const CANDIDATE_RECORD_PATH = "/.gekko/candidate-release";
export const STAGE_CANARY_PATH = "/.gekko/stage-canary";
export const PROMOTE_CANARY_PATH = "/.gekko/promote-canary";
export const WORKER_STATUS_PATH = "/.gekko/worker-status";
export const LEGAL_PAGE_PATH = "/source/";
export const LEGACY_LEGAL_PAGE_PATH = "/source.html";

export const BOOTSTRAP_ASSETS = [
  "/index.html",
  "/app.webmanifest",
  "/icon.svg",
  "/LICENSE.txt",
  LEGAL_PAGE_PATH,
  "/THIRD-PARTY-NOTICES.txt",
  "/release.mjs",
];

function absoluteUrl(path, origin) {
  return new URL(path, origin).href;
}

function metadataRecordUrl(path, origin) {
  return absoluteUrl(path, origin);
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validCacheRecord(record) {
  if (!exactKeys(record, ["release", "cacheName"])) return false;
  const expectedPrefix = `${RELEASE_CACHE_PREFIX}${record.release.releaseId}-`;
  return typeof record.cacheName === "string" && record.cacheName.startsWith(expectedPrefix);
}

async function readReleaseRecord(cacheStorage, origin, path) {
  const metadata = await cacheStorage.open(META_CACHE);
  const response = await metadata.match(metadataRecordUrl(path, origin));
  if (response === undefined) return null;
  try {
    const record = await response.json();
    const expectedKeys = record?.release?.schema === RELEASE_SCHEMA
      ? ["release", "cacheName", "rollback"]
      : ["release", "cacheName"];
    if (!exactKeys(record, expectedKeys)) return null;
    await validateStoredRelease(record.release);
    if (!validCacheRecord({ release: record.release, cacheName: record.cacheName })) return null;
    if (record.release.schema === RELEASE_SCHEMA) {
      if (!validCacheRecord(record.rollback)) return null;
      await validateStoredRelease(record.rollback.release);
      if (
        record.rollback.release.schema !== ROLLBACK_RELEASE_SCHEMA ||
        record.rollback.release.releaseId !== record.release.rollback.release.releaseId ||
        JSON.stringify(record.rollback.release) !== JSON.stringify(record.release.rollback.release)
      ) {
        return null;
      }
    }
    return record;
  } catch {
    return null;
  }
}

export function readActiveRelease(cacheStorage, origin) {
  return readReleaseRecord(cacheStorage, origin, ACTIVE_RECORD_PATH);
}

export function readCandidateRelease(cacheStorage, origin) {
  return readReleaseRecord(cacheStorage, origin, CANDIDATE_RECORD_PATH);
}

async function writeMetadataRecord(cacheStorage, origin, path, record) {
  const metadata = await cacheStorage.open(META_CACHE);
  await metadata.put(
    metadataRecordUrl(path, origin),
    new Response(JSON.stringify(record), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }),
  );
}

async function deleteMetadataRecord(cacheStorage, origin, path) {
  const metadata = await cacheStorage.open(META_CACHE);
  if (typeof metadata.delete === "function") {
    await metadata.delete(metadataRecordUrl(path, origin));
  }
}

async function releaseCacheIsComplete(record, cacheStorage, origin) {
  const cache = await cacheStorage.open(record.cacheName);
  const assets = releaseAssets(record.release);
  if (typeof cache.keys !== "function") return false;
  const expected = assets.map(asset => absoluteUrl(asset.url, origin)).sort();
  const observed = (await cache.keys()).map(request => keyUrl(request)).sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) return false;
  try {
    for (const asset of assets) {
      const response = await cache.match(absoluteUrl(asset.url, origin));
      if (response === undefined || !response.ok) return false;
      await verifyAssetBytes(asset, await response.arrayBuffer());
    }
  } catch {
    return false;
  }
  return true;
}

function keyUrl(request) {
  return typeof request === "string" ? request : request.url;
}

async function verifiedCachedResponse(asset, cache, url) {
  const response = await cache.match(url);
  if (response === undefined || !response.ok) return undefined;
  try {
    await verifyAssetBytes(asset, await response.clone().arrayBuffer());
    return response;
  } catch {
    if (typeof cache.delete === "function") await cache.delete(url);
    return undefined;
  }
}

async function putVerifiedAsset(asset, response, cache, origin) {
  const url = absoluteUrl(asset.url, origin);
  const bytes = await response.arrayBuffer();
  await verifyAssetBytes(asset, bytes);
  const headers = new Headers(response.headers);
  headers.set("Content-Length", String(asset.bytes));
  if (asset.url.endsWith(".html")) headers.set("Content-Type", "text/html; charset=utf-8");
  await cache.put(url, new Response(bytes, { status: 200, headers }));
}

async function fetchAndCacheAsset(
  asset,
  cache,
  reusableCaches,
  fetcher,
  origin,
) {
  const url = absoluteUrl(asset.url, origin);
  for (const reusableCache of reusableCaches) {
    const reusable = await reusableCache.match(url);
    if (reusable !== undefined) {
      await putVerifiedAsset(asset, reusable, cache, origin);
      return;
    }
  }
  const response = await fetcher(new Request(url, { cache: "no-store" }));
  if (!response.ok) throw new Error(`${asset.url} fetch failed: HTTP ${response.status}`);
  await putVerifiedAsset(asset, response, cache, origin);
}

async function fillReleaseCache(release, cache, reusableCaches, fetcher, origin) {
  const pending = [...releaseAssets(release)];
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length > 0) {
      const asset = pending.shift();
      await fetchAndCacheAsset(asset, cache, reusableCaches, fetcher, origin);
    }
  });
  await Promise.all(workers);
}

async function stageReleaseCache(release, options) {
  const cacheStorage = options.cacheStorage ?? caches;
  const fetcher = options.fetcher ?? fetch;
  const origin = options.origin ?? self.location.origin;
  for (const reusableRecord of options.reusableRecords ?? []) {
    if (
      reusableRecord?.release.releaseId === release.releaseId &&
      await releaseCacheIsComplete(reusableRecord, cacheStorage, origin)
    ) {
      return { record: reusableRecord, created: false };
    }
  }
  const suffix = options.cacheSuffix;
  const cacheName = `${RELEASE_CACHE_PREFIX}${release.releaseId}-${suffix}`;
  const releaseCache = await cacheStorage.open(cacheName);
  const reusableCaches = await Promise.all(
    (options.reusableRecords ?? []).map(record => cacheStorage.open(record.cacheName)),
  );
  try {
    await fillReleaseCache(release, releaseCache, reusableCaches, fetcher, origin);
  } catch (error) {
    await cacheStorage.delete(cacheName);
    throw error;
  }
  return { record: { release, cacheName }, created: true };
}

async function cleanupReleaseCaches(cacheStorage, retained) {
  try {
    for (const existing of await cacheStorage.keys()) {
      if (existing.startsWith(RELEASE_CACHE_PREFIX) && !retained.has(existing)) {
        await cacheStorage.delete(existing);
      }
    }
  } catch {}
}

export async function stageCanaryRelease(release, options = {}) {
  const cacheStorage = options.cacheStorage ?? caches;
  const fetcher = options.fetcher ?? fetch;
  const origin = options.origin ?? self.location.origin;
  await validateRelease(release);

  const [active, priorCandidate] = await Promise.all([
    readActiveRelease(cacheStorage, origin),
    readCandidateRelease(cacheStorage, origin),
  ]);
  if (
    priorCandidate?.release.releaseId === release.releaseId &&
    await releaseCacheIsComplete(priorCandidate, cacheStorage, origin) &&
    await releaseCacheIsComplete(priorCandidate.rollback, cacheStorage, origin)
  ) {
    return priorCandidate;
  }

  const suffix = options.cacheSuffix ?? crypto.randomUUID();
  const reusable = [active, active?.rollback, priorCandidate, priorCandidate?.rollback]
    .filter(record => record !== null && record !== undefined);
  const rollbackStage = await stageReleaseCache(release.rollback.release, {
    cacheStorage,
    fetcher,
    origin,
    cacheSuffix: `${suffix}-rollback`,
    reusableRecords: reusable,
  });
  let primaryStage;
  try {
    primaryStage = await stageReleaseCache(release, {
      cacheStorage,
      fetcher,
      origin,
      cacheSuffix: `${suffix}-candidate`,
      reusableRecords: [rollbackStage.record, ...reusable],
    });
  } catch (error) {
    if (rollbackStage.created) await cacheStorage.delete(rollbackStage.record.cacheName);
    throw error;
  }

  const record = {
    ...primaryStage.record,
    rollback: rollbackStage.record,
  };
  try {
    await writeMetadataRecord(cacheStorage, origin, CANDIDATE_RECORD_PATH, record);
  } catch (error) {
    if (primaryStage.created) await cacheStorage.delete(primaryStage.record.cacheName);
    if (rollbackStage.created) await cacheStorage.delete(rollbackStage.record.cacheName);
    throw error;
  }
  return record;
}

export async function promoteCanaryRelease(releaseId, options = {}) {
  const cacheStorage = options.cacheStorage ?? caches;
  const origin = options.origin ?? self.location.origin;
  if (!/^[0-9a-f]{64}$/.test(releaseId ?? "")) throw new Error("invalid candidate release ID");
  const [active, candidate] = await Promise.all([
    readActiveRelease(cacheStorage, origin),
    readCandidateRelease(cacheStorage, origin),
  ]);
  if (candidate === null || candidate.release.releaseId !== releaseId) {
    throw new Error("exact candidate release is not staged");
  }
  if (
    !await releaseCacheIsComplete(candidate, cacheStorage, origin) ||
    !await releaseCacheIsComplete(candidate.rollback, cacheStorage, origin)
  ) {
    throw new Error("candidate or rollback cache is incomplete");
  }
  await writeMetadataRecord(cacheStorage, origin, ACTIVE_RECORD_PATH, candidate);
  await deleteMetadataRecord(cacheStorage, origin, CANDIDATE_RECORD_PATH);
  await cleanupReleaseCaches(cacheStorage, new Set([
    candidate.cacheName,
    candidate.rollback.cacheName,
    active?.cacheName,
    active?.rollback?.cacheName,
  ].filter(Boolean)));
  return candidate;
}

export async function stageRelease(release, options = {}) {
  const record = await stageCanaryRelease(release, options);
  return promoteCanaryRelease(record.release.releaseId, options);
}

export async function backendResponse(
  record,
  cacheStorage = caches,
  origin = self.location.origin,
  fetcher = fetch,
) {
  if (record?.release?.schema !== ROLLBACK_RELEASE_SCHEMA) {
    throw new Error(
      `rollback release schema ${ROLLBACK_RELEASE_SCHEMA} is required to serve the browser compiler`,
    );
  }
  const cache = await cacheStorage.open(record.cacheName);
  const responses = [];
  for (const chunk of record.release.backend.chunks) {
    const url = absoluteUrl(chunk.url, origin);
    let response = await verifiedCachedResponse(chunk, cache, url);
    if (response === undefined) {
      await fetchAndCacheAsset(chunk, cache, [], fetcher, origin);
      response = await verifiedCachedResponse(chunk, cache, url);
    }
    if (response === undefined) throw new Error(`cached backend chunk is missing: ${chunk.url}`);
    responses.push(response);
  }
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const response of responses) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": String(record.release.backend.bytes),
      "Content-Type": "application/wasm",
      ETag: `"sha256-${record.release.backend.sha256}"`,
    },
  });
}

async function networkFirstBootstrap(request) {
  const cache = await caches.open(BOOTSTRAP_CACHE);
  const requested = new URL(request.url);
  const path = requested.pathname === "/" ? "/index.html" : requested.pathname;
  const canonical = absoluteUrl(path, self.location.origin);
  try {
    const response = await fetch(new Request(request, { cache: "no-store" }));
    if (!response.ok) throw new Error(`bootstrap fetch failed: HTTP ${response.status}`);
    try {
      await cache.put(canonical, response.clone());
    } catch {}
    return response;
  } catch (error) {
    const cached = await cache.match(canonical);
    if (cached !== undefined) return cached;
    throw error;
  }
}

function canonicalLegalPageRequest(request) {
  const requested = new URL(request.url);
  requested.pathname = LEGAL_PAGE_PATH;
  requested.search = "";
  requested.hash = "";
  return new Request(requested, request);
}

async function networkFirstRelease(request) {
  try {
    const response = await fetch(new Request(request, { cache: "no-store" }));
    if (!response.ok) throw new Error(`release fetch failed: HTTP ${response.status}`);
    return response;
  } catch (error) {
    const active = await readActiveRelease(caches, self.location.origin);
    if (active === null) throw error;
    return new Response(JSON.stringify(active.release), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Gekko-Offline": "1",
      },
    });
  }
}

export async function cachedReleaseAsset(
  request,
  cacheStorage = caches,
  origin = self.location.origin,
  fetcher = fetch,
) {
  const requested = new URL(request.url);
  const canonical = absoluteUrl(requested.pathname, origin);
  const active = await readActiveRelease(cacheStorage, origin);
  const unavailable = () => new Response("No compatible release asset is active.", {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
  if (
    active?.release?.schema !== RELEASE_SCHEMA &&
    active?.release?.schema !== ROLLBACK_RELEASE_SCHEMA
  ) return unavailable();
  const asset = releaseAssets(active.release)
    .find(candidate => absoluteUrl(candidate.url, origin) === canonical);
  if (asset === undefined) return unavailable();

  const cache = await cacheStorage.open(active.cacheName);
  let response = await verifiedCachedResponse(asset, cache, canonical);
  if (response !== undefined) return response;
  try {
    await fetchAndCacheAsset(asset, cache, [], fetcher, origin);
    response = await verifiedCachedResponse(asset, cache, canonical);
  } catch {
    return unavailable();
  }
  return response ?? unavailable();
}

async function stageReleaseRequest(request) {
  try {
    const record = await stageRelease(await request.json());
    return new Response(JSON.stringify({ ok: true, release: record.release }), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    const active = await readActiveRelease(caches, self.location.origin);
    const body = active === null
      ? { ok: false, error: String(error) }
      : { ok: false, release: active.release, error: String(error) };
    return new Response(JSON.stringify(body), {
      status: active === null ? 503 : 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
}

async function stageCanaryRequest(request) {
  try {
    const record = await stageCanaryRelease(await request.json());
    return new Response(JSON.stringify({ ok: true, active: false, release: record.release }), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
}

async function exactReleaseIdBody(request, label) {
  const body = await request.json();
  if (!exactKeys(body, ["releaseId"]) || !/^[0-9a-f]{64}$/.test(body.releaseId ?? "")) {
    throw new Error(`${label} requires exactly one lowercase releaseId`);
  }
  return body.releaseId;
}

async function promoteCanaryRequest(request) {
  try {
    const releaseId = await exactReleaseIdBody(request, "candidate promotion");
    const record = await promoteCanaryRelease(releaseId);
    return new Response(JSON.stringify({ ok: true, release: record.release }), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 409,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
}

export function workerStatusResponse() {
  return new Response(JSON.stringify({
    releaseSchema: RELEASE_SCHEMA,
    runtimeChoice: RESIDENT_RUNTIME_CHOICE,
  }), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function activeReleaseResponse(
  cacheStorage = caches,
  origin = self.location.origin,
) {
  const active = await readActiveRelease(cacheStorage, origin);
  if (active?.release?.schema !== RELEASE_SCHEMA) {
    return new Response("No compatible release is active.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return new Response(JSON.stringify(active.release), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function handleFetch(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return fetch(request);
  if (url.pathname === WORKER_STATUS_PATH && request.method === "GET") {
    return workerStatusResponse();
  }
  if (url.pathname === STAGE_RELEASE_PATH && request.method === "POST") {
    return stageReleaseRequest(request);
  }
  if (url.pathname === STAGE_CANARY_PATH && request.method === "POST") {
    return stageCanaryRequest(request);
  }
  if (url.pathname === PROMOTE_CANARY_PATH && request.method === "POST") {
    return promoteCanaryRequest(request);
  }
  if (url.pathname === ACTIVE_RECORD_PATH && request.method === "GET") {
    return activeReleaseResponse();
  }
  if (request.method !== "GET") return fetch(request);
  if (url.pathname === LEGACY_LEGAL_PAGE_PATH) {
    return networkFirstBootstrap(canonicalLegalPageRequest(request));
  }
  if (
    url.pathname === "/"
    || url.pathname === "/index.html"
    || BOOTSTRAP_ASSETS.includes(url.pathname)
  ) {
    return networkFirstBootstrap(request);
  }
  if (url.pathname === "/release.json") return networkFirstRelease(request);
  if (url.pathname === "/ppcwasmjit.wasm") {
    const active = await readActiveRelease(caches, self.location.origin);
    if (active !== null) {
      try {
        return await backendResponse(active);
      } catch {
        return new Response("The saved browser compiler is unavailable.", {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    return new Response("No browser compiler release is active.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname.startsWith("/assets/")) return cachedReleaseAsset(request);
  return fetch(request);
}

async function install() {
  const cache = await caches.open(BOOTSTRAP_CACHE);
  await Promise.allSettled(BOOTSTRAP_ASSETS.map(async path => {
    const response = await fetch(new Request(path, { cache: "no-store" }));
    if (response.ok) await cache.put(path, response);
  }));
  await self.skipWaiting();
}

async function activate() {
  await self.clients.claim();
}

if (typeof self !== "undefined" && "addEventListener" in self) {
  self.addEventListener("install", event => event.waitUntil(install()));
  self.addEventListener("activate", event => event.waitUntil(activate()));
  self.addEventListener("fetch", event => event.respondWith(handleFetch(event.request)));
}
