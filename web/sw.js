// SPDX-License-Identifier: GPL-3.0-only

import {
  RELEASE_SCHEMA,
  releaseAssets,
  validateRelease,
  validateStoredRelease,
  verifyAssetBytes,
} from "./release.mjs";

export const BOOTSTRAP_CACHE = "gekko-bootstrap-v2";
export const META_CACHE = "gekko-meta-v1";
export const RELEASE_CACHE_PREFIX = "gekko-release-";
export const ACTIVE_RECORD_PATH = "/.gekko/active-release";
export const STAGE_RELEASE_PATH = "/.gekko/stage-release";
export const WORKER_STATUS_PATH = "/.gekko/worker-status";
export const APP_PATH = "/app.html";

const BOOTSTRAP_ASSETS = [
  "/index.html",
  "/app.webmanifest",
  "/icon.svg",
  "/LICENSE.txt",
  "/release.mjs",
];

function absoluteUrl(path, origin) {
  return new URL(path, origin).href;
}

function activeRecordUrl(origin) {
  return absoluteUrl(ACTIVE_RECORD_PATH, origin);
}

export async function readActiveRelease(cacheStorage, origin) {
  const metadata = await cacheStorage.open(META_CACHE);
  const response = await metadata.match(activeRecordUrl(origin));
  if (response === undefined) return null;
  try {
    const record = await response.json();
    await validateStoredRelease(record.release);
    const expectedPrefix = `${RELEASE_CACHE_PREFIX}${record.release.releaseId}-`;
    if (typeof record.cacheName !== "string" || !record.cacheName.startsWith(expectedPrefix)) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function releaseCacheIsComplete(record, cacheStorage, origin) {
  const cache = await cacheStorage.open(record.cacheName);
  for (const asset of releaseAssets(record.release)) {
    if ((await cache.match(absoluteUrl(asset.url, origin))) === undefined) return false;
  }
  return true;
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
  reusableCache,
  fetcher,
  origin,
) {
  const url = absoluteUrl(asset.url, origin);
  const reusable = reusableCache === null ? undefined : await reusableCache.match(url);
  if (reusable !== undefined) {
    await putVerifiedAsset(asset, reusable, cache, origin);
    return;
  }
  const response = await fetcher(new Request(url, { cache: "no-store" }));
  if (!response.ok) throw new Error(`${asset.url} fetch failed: HTTP ${response.status}`);
  await putVerifiedAsset(asset, response, cache, origin);
}

async function fillReleaseCache(release, cache, reusableCache, fetcher, origin) {
  const pending = [...releaseAssets(release)];
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length > 0) {
      const asset = pending.shift();
      await fetchAndCacheAsset(asset, cache, reusableCache, fetcher, origin);
    }
  });
  await Promise.all(workers);
}

export async function stageRelease(release, options = {}) {
  const cacheStorage = options.cacheStorage ?? caches;
  const fetcher = options.fetcher ?? fetch;
  const origin = options.origin ?? self.location.origin;
  await validateRelease(release);

  const active = await readActiveRelease(cacheStorage, origin);
  if (
    active?.release.releaseId === release.releaseId &&
    await releaseCacheIsComplete(active, cacheStorage, origin)
  ) {
    return active;
  }

  const suffix = options.cacheSuffix ?? crypto.randomUUID();
  const cacheName = `${RELEASE_CACHE_PREFIX}${release.releaseId}-${suffix}`;
  const releaseCache = await cacheStorage.open(cacheName);
  const reusableCache = active === null ? null : await cacheStorage.open(active.cacheName);
  try {
    await fillReleaseCache(release, releaseCache, reusableCache, fetcher, origin);
  } catch (error) {
    await cacheStorage.delete(cacheName);
    throw error;
  }

  const record = { release, cacheName };
  try {
    const metadata = await cacheStorage.open(META_CACHE);
    await metadata.put(
      activeRecordUrl(origin),
      new Response(JSON.stringify(record), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    );
  } catch (error) {
    await cacheStorage.delete(cacheName);
    throw error;
  }

  // Cleanup is deliberately best-effort and happens after the only commit point.
  // A quota or eviction error here must not invalidate the newly active release.
  try {
    for (const existing of await cacheStorage.keys()) {
      if (
        existing.startsWith(RELEASE_CACHE_PREFIX) &&
        existing !== cacheName &&
        existing !== active?.cacheName
      ) {
        await cacheStorage.delete(existing);
      }
    }
  } catch {}
  return record;
}

export async function backendResponse(
  record,
  cacheStorage = caches,
  origin = self.location.origin,
  fetcher = fetch,
) {
  if (record?.release?.schema !== RELEASE_SCHEMA) {
    throw new Error(`release schema ${RELEASE_SCHEMA} is required to serve the browser compiler`);
  }
  const cache = await cacheStorage.open(record.cacheName);
  const responses = [];
  for (const chunk of record.release.backend.chunks) {
    let response = await cache.match(absoluteUrl(chunk.url, origin));
    if (response === undefined) {
      await fetchAndCacheAsset(chunk, cache, null, fetcher, origin);
      response = await cache.match(absoluteUrl(chunk.url, origin));
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

export async function frontendResponse(
  record,
  cacheStorage = caches,
  origin = self.location.origin,
  fetcher = fetch,
) {
  if (record?.release?.schema !== RELEASE_SCHEMA) {
    throw new Error(`release schema ${RELEASE_SCHEMA} is required to serve the frontend`);
  }
  const asset = record.release.frontend;
  const cache = await cacheStorage.open(record.cacheName);
  const url = absoluteUrl(asset.url, origin);
  let response = await cache.match(url);
  if (response === undefined) {
    await fetchAndCacheAsset(asset, cache, null, fetcher, origin);
    response = await cache.match(url);
  }
  if (response === undefined) throw new Error(`cached frontend is missing: ${asset.url}`);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
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
  if (active?.release?.schema !== RELEASE_SCHEMA) return unavailable();
  const asset = releaseAssets(active.release)
    .find(candidate => absoluteUrl(candidate.url, origin) === canonical);
  if (asset === undefined) return unavailable();

  const cache = await cacheStorage.open(active.cacheName);
  let response = await cache.match(canonical);
  if (response !== undefined) return response;
  try {
    await fetchAndCacheAsset(asset, cache, null, fetcher, origin);
    response = await cache.match(canonical);
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

export function workerStatusResponse() {
  return new Response(JSON.stringify({ releaseSchema: RELEASE_SCHEMA }), {
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
  if (request.method !== "GET") return fetch(request);
  if (
    url.pathname === "/"
    || url.pathname === "/index.html"
    || BOOTSTRAP_ASSETS.includes(url.pathname)
  ) {
    return networkFirstBootstrap(request);
  }
  if (url.pathname === "/release.json") return networkFirstRelease(request);
  if (url.pathname === APP_PATH) {
    const active = await readActiveRelease(caches, self.location.origin);
    if (active !== null) {
      try {
        return await frontendResponse(active);
      } catch {
        return new Response("The saved frontend is unavailable.", {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    return new Response("No frontend release is active.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
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
