// SPDX-License-Identifier: GPL-3.0-only

export const RELEASE_SCHEMA = 4;
export const ROLLBACK_RELEASE_SCHEMA = 3;
export const PREVIOUS_RELEASE_SCHEMA = 2;
export const LEGACY_RELEASE_SCHEMA = 1;
export const WASM_CHUNK_SIZE = 1024 * 1024;
export const RESIDENT_RUNTIME_CHOICE = "rust-resident-v1";
export const RELEASE_BOOTSTRAP_URLS = Object.freeze({
  document: "/index.html",
  releaseModule: "/release.mjs",
  serviceWorker: "/sw.js",
});

export const RESIDENT_RUNTIME_ABI = Object.freeze({
  coreVersion: 1,
  compileRequestBytes: 84,
  hostRequestBytes: 52,
  runOutcomeBytes: 40,
  machineEvidenceBytes: 816,
  gameFidelityBytes: 384,
  memoryInitialPages: 720,
  memoryMaximumPages: 2048,
});

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ASSET_PATTERN = /^\/assets\/[a-z0-9][a-z0-9.-]*$/;

function check(condition, message) {
  if (!condition) throw new Error(`invalid release: ${message}`);
}

function object(value, label) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is missing`);
  return value;
}

function exactKeys(value, expected, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  check(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} keys are not exact (got ${actual.join(",")}; expected ${wanted.join(",")})`,
  );
}

function checkAsset(asset, label, extension = null, exact = false) {
  object(asset, label);
  if (exact) exactKeys(asset, ["url", "sha256", "bytes"], label);
  check(ASSET_PATTERN.test(asset.url), `${label} URL is not content-addressed`);
  check(HASH_PATTERN.test(asset.sha256), `${label} hash is invalid`);
  check(asset.url.includes(`-${asset.sha256}.`), `${label} URL does not contain its hash`);
  check(Number.isSafeInteger(asset.bytes) && asset.bytes > 0, `${label} size is invalid`);
  if (extension !== null) check(asset.url.endsWith(extension), `${label} URL is invalid`);
}

function checkStableAsset(asset, label, expectedUrl) {
  exactKeys(asset, ["url", "sha256", "bytes"], label);
  check(asset.url === expectedUrl, `${label} URL is not exact`);
  check(HASH_PATTERN.test(asset.sha256), `${label} hash is invalid`);
  check(Number.isSafeInteger(asset.bytes) && asset.bytes > 0, `${label} size is invalid`);
}

function checkBootstrap(bootstrap) {
  exactKeys(bootstrap, Object.keys(RELEASE_BOOTSTRAP_URLS), "release bootstrap");
  for (const [name, url] of Object.entries(RELEASE_BOOTSTRAP_URLS)) {
    checkStableAsset(bootstrap[name], `release bootstrap ${name}`, url);
  }
}

function checkSource(source, exact = false) {
  object(source, "source metadata");
  if (exact) {
    exactKeys(source, ["repository", "commit", "tree", "archive", "license"], "source metadata");
    exactKeys(source.license, ["expression", "text", "source"], "source license");
  }
  check(source.repository === "https://github.com/conradev/lazuli", "source repository is invalid");
  check(COMMIT_PATTERN.test(source.commit), "source commit is invalid");
  check(source.tree === `${source.repository}/tree/${source.commit}`, "source tree is not exact");
  check(
    source.archive === `${source.repository}/archive/${source.commit}.tar.gz`,
    "source archive is not exact",
  );
  check(source.license?.expression === "GPL-3.0-only", "license expression is invalid");
  check(source.license?.text === "/LICENSE.txt", "license text URL is invalid");
  check(
    source.license?.source ===
      `${source.repository}/blob/${source.commit}/licenses/GPL-3.0-only.txt`,
    "license source is not exact",
  );
}

function checkRenderer(renderer, exact = false) {
  object(renderer, "renderer");
  if (exact) exactKeys(renderer, ["javascript", "wasm"], "renderer");
  checkAsset(renderer.javascript, "renderer JavaScript", ".js", exact);
  checkAsset(renderer.wasm, "renderer wasm", ".wasm", exact);
  check(renderer.javascript.url !== renderer.wasm.url, "renderer assets are not distinct");
}

function checkBackend(backend, exact = false) {
  object(backend, "backend");
  if (exact) {
    exactKeys(backend, ["url", "sha256", "bytes", "chunkSize", "chunks"], "backend");
  }
  check(backend.url === "/ppcwasmjit.wasm", "backend URL is invalid");
  check(HASH_PATTERN.test(backend.sha256), "backend hash is invalid");
  check(Number.isSafeInteger(backend.bytes) && backend.bytes > 0, "backend size is invalid");
  check(backend.chunkSize === WASM_CHUNK_SIZE, "backend chunk size is invalid");
  check(Array.isArray(backend.chunks) && backend.chunks.length > 0, "backend has no chunks");

  let backendBytes = 0;
  backend.chunks.forEach((chunk, index) => {
    checkAsset(chunk, `backend chunk ${index}`, ".wasm.chunk", exact);
    const last = index === backend.chunks.length - 1;
    check(
      chunk.bytes === WASM_CHUNK_SIZE || (last && chunk.bytes <= WASM_CHUNK_SIZE),
      `backend chunk ${index} size is invalid`,
    );
    backendBytes += chunk.bytes;
  });
  check(backendBytes === backend.bytes, "backend chunk sizes do not add up");
}

function checkSchema3Shape(release, label) {
  exactKeys(
    release,
    ["schema", "releaseId", "source", "frontend", "renderer", "dsp", "backend"],
    label,
  );
  checkSource(release.source, true);
  checkAsset(release.frontend, `${label} frontend`, ".html", true);
  checkRenderer(release.renderer, true);
  checkAsset(release.dsp, `${label} DSP wasm`, ".wasm", true);
  checkBackend(release.backend, true);
}

function checkResidentRuntime(runtime) {
  exactKeys(
    runtime,
    ["choice", "abi", "core", "dispatcher", "coordinator", "adapter", "worker"],
    "resident runtime",
  );
  check(runtime.choice === RESIDENT_RUNTIME_CHOICE, "resident runtime choice is invalid");
  exactKeys(runtime.abi, Object.keys(RESIDENT_RUNTIME_ABI), "resident runtime ABI");
  for (const [name, expected] of Object.entries(RESIDENT_RUNTIME_ABI)) {
    check(runtime.abi[name] === expected, `resident runtime ABI ${name} is invalid`);
  }
  checkAsset(runtime.core, "resident core", ".wasm", true);
  checkAsset(runtime.dispatcher, "resident dispatcher", ".wasm", true);
  checkAsset(runtime.coordinator, "resident coordinator", ".wasm", true);
  checkAsset(runtime.adapter, "resident adapter", ".mjs", true);
  checkAsset(runtime.worker, "resident worker", ".mjs", true);
}

function checkDistinctAssets(assets, label) {
  const urls = new Set();
  for (const asset of assets) {
    check(!urls.has(asset.url), `${label} contains duplicate asset ${asset.url}`);
    urls.add(asset.url);
  }
}

export function releaseIdentityPayload(release) {
  const identity = {
    schema: release.schema,
    source: release.source,
    frontend: release.frontend,
    backend: release.backend,
  };
  if (release.schema < 2) return identity;
  const withRenderer = {
    schema: identity.schema,
    source: identity.source,
    frontend: identity.frontend,
    renderer: release.renderer,
    backend: identity.backend,
  };
  if (release.schema < 3) return withRenderer;
  const withDsp = {
    schema: withRenderer.schema,
    source: withRenderer.source,
    frontend: withRenderer.frontend,
    renderer: withRenderer.renderer,
    dsp: release.dsp,
    backend: withRenderer.backend,
  };
  if (release.schema < 4) return withDsp;
  return {
    schema: release.schema,
    source: release.source,
    bootstrap: release.bootstrap,
    runtime: release.runtime,
    frontend: release.frontend,
    renderer: release.renderer,
    rollback: release.rollback,
  };
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function validateReleaseSchema(release, schema) {
  object(release, "manifest");
  check(release.schema === schema, "unsupported schema");
  check(HASH_PATTERN.test(release.releaseId), "release ID is invalid");

  if (schema === RELEASE_SCHEMA) {
    exactKeys(
      release,
      [
        "schema",
        "releaseId",
        "source",
        "bootstrap",
        "runtime",
        "frontend",
        "renderer",
        "rollback",
      ],
      "schema-4 manifest",
    );
    checkSource(release.source, true);
    checkBootstrap(release.bootstrap);
    checkResidentRuntime(release.runtime);
    checkAsset(release.frontend, "frontend", ".html", true);
    checkRenderer(release.renderer, true);
    exactKeys(release.rollback, ["release"], "rollback metadata");
    checkSchema3Shape(release.rollback.release, "rollback schema-3 manifest");
    check(release.rollback.release.schema === ROLLBACK_RELEASE_SCHEMA, "rollback schema is invalid");
    await validateReleaseSchema(release.rollback.release, ROLLBACK_RELEASE_SCHEMA);
    checkDistinctAssets(releaseAssets(release), "schema-4 primary release");
  } else {
    checkSource(release.source);
    checkAsset(release.frontend, "frontend");
    if (schema >= 2) checkRenderer(release.renderer);
    if (schema >= 3) {
      checkAsset(release.dsp, "DSP wasm");
      check(release.dsp.url.endsWith(".wasm"), "DSP wasm URL is invalid");
      check(release.dsp.url !== release.renderer.wasm.url, "DSP and renderer wasm are not distinct");
    }
    checkBackend(release.backend);
  }

  const identity = JSON.stringify(releaseIdentityPayload(release));
  check(await sha256Hex(identity) === release.releaseId, "release ID does not match its contents");
  return release;
}

export function validateRelease(release) {
  return validateReleaseSchema(release, RELEASE_SCHEMA);
}

export function validateStoredRelease(release) {
  check(
    release?.schema === RELEASE_SCHEMA
      || release?.schema === ROLLBACK_RELEASE_SCHEMA
      || release?.schema === PREVIOUS_RELEASE_SCHEMA
      || release?.schema === LEGACY_RELEASE_SCHEMA,
    "unsupported stored schema",
  );
  return validateReleaseSchema(release, release.schema);
}

export function validateRollbackRelease(release) {
  object(release, "rollback manifest");
  check(release.schema === ROLLBACK_RELEASE_SCHEMA, "rollback schema is invalid");
  checkSchema3Shape(release, "rollback schema-3 manifest");
  return validateReleaseSchema(release, ROLLBACK_RELEASE_SCHEMA);
}

export function releaseAssets(release) {
  if (release.schema >= RELEASE_SCHEMA) {
    return [
      ...Object.values(release.bootstrap),
      release.frontend,
      release.renderer.javascript,
      release.renderer.wasm,
      release.runtime.core,
      release.runtime.dispatcher,
      release.runtime.coordinator,
      release.runtime.adapter,
      release.runtime.worker,
    ];
  }
  return [
    release.frontend,
    ...(release.schema >= 2 ? [release.renderer.javascript, release.renderer.wasm] : []),
    ...(release.schema >= 3 ? [release.dsp] : []),
    ...release.backend.chunks,
  ];
}

export function rollbackReleaseAssets(release) {
  check(release?.schema === RELEASE_SCHEMA, "schema-4 release is required for rollback assets");
  return releaseAssets(release.rollback.release);
}

export async function verifyAssetBytes(asset, bytes) {
  check(bytes.byteLength === asset.bytes, `${asset.url} size does not match`);
  check(await sha256Hex(bytes) === asset.sha256, `${asset.url} hash does not match`);
}
