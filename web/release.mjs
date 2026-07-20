// SPDX-License-Identifier: GPL-3.0-only

export const RELEASE_SCHEMA = 2;
export const LEGACY_RELEASE_SCHEMA = 1;
export const WASM_CHUNK_SIZE = 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ASSET_PATTERN = /^\/assets\/[a-z0-9][a-z0-9.-]*$/;

function check(condition, message) {
  if (!condition) throw new Error(`invalid release: ${message}`);
}

function checkAsset(asset, label) {
  check(asset !== null && typeof asset === "object", `${label} is missing`);
  check(ASSET_PATTERN.test(asset.url), `${label} URL is not content-addressed`);
  check(HASH_PATTERN.test(asset.sha256), `${label} hash is invalid`);
  check(asset.url.includes(`-${asset.sha256}.`), `${label} URL does not contain its hash`);
  check(Number.isSafeInteger(asset.bytes) && asset.bytes > 0, `${label} size is invalid`);
}

export function releaseIdentityPayload(release) {
  const identity = {
    schema: release.schema,
    source: release.source,
    frontend: release.frontend,
    backend: release.backend,
  };
  if (release.schema < 2) return identity;
  return {
    schema: identity.schema,
    source: identity.source,
    frontend: identity.frontend,
    renderer: release.renderer,
    backend: identity.backend,
  };
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function validateReleaseSchema(release, schema) {
  check(release !== null && typeof release === "object", "manifest is not an object");
  check(release.schema === schema, "unsupported schema");
  check(HASH_PATTERN.test(release.releaseId), "release ID is invalid");

  const source = release.source;
  check(source !== null && typeof source === "object", "source metadata is missing");
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

  checkAsset(release.frontend, "frontend");
  if (schema >= 2) {
    check(release.renderer !== null && typeof release.renderer === "object", "renderer is missing");
    checkAsset(release.renderer.javascript, "renderer JavaScript");
    check(release.renderer.javascript.url.endsWith(".js"), "renderer JavaScript URL is invalid");
    checkAsset(release.renderer.wasm, "renderer wasm");
    check(release.renderer.wasm.url.endsWith(".wasm"), "renderer wasm URL is invalid");
    check(
      release.renderer.javascript.url !== release.renderer.wasm.url,
      "renderer assets are not distinct",
    );
  }
  check(release.backend !== null && typeof release.backend === "object", "backend is missing");
  check(release.backend.url === "/ppcwasmjit.wasm", "backend URL is invalid");
  check(HASH_PATTERN.test(release.backend.sha256), "backend hash is invalid");
  check(
    Number.isSafeInteger(release.backend.bytes) && release.backend.bytes > 0,
    "backend size is invalid",
  );
  check(release.backend.chunkSize === WASM_CHUNK_SIZE, "backend chunk size is invalid");
  check(Array.isArray(release.backend.chunks) && release.backend.chunks.length > 0, "backend has no chunks");

  let backendBytes = 0;
  release.backend.chunks.forEach((chunk, index) => {
    checkAsset(chunk, `backend chunk ${index}`);
    const last = index === release.backend.chunks.length - 1;
    check(
      chunk.bytes === WASM_CHUNK_SIZE || (last && chunk.bytes <= WASM_CHUNK_SIZE),
      `backend chunk ${index} size is invalid`,
    );
    backendBytes += chunk.bytes;
  });
  check(backendBytes === release.backend.bytes, "backend chunk sizes do not add up");

  const identity = JSON.stringify(releaseIdentityPayload(release));
  check(await sha256Hex(identity) === release.releaseId, "release ID does not match its contents");
  return release;
}

export function validateRelease(release) {
  return validateReleaseSchema(release, RELEASE_SCHEMA);
}

export function validateStoredRelease(release) {
  check(
    release?.schema === RELEASE_SCHEMA || release?.schema === LEGACY_RELEASE_SCHEMA,
    "unsupported stored schema",
  );
  return validateReleaseSchema(release, release.schema);
}

export function releaseAssets(release) {
  return [
    release.frontend,
    ...(release.schema >= 2 ? [release.renderer.javascript, release.renderer.wasm] : []),
    ...release.backend.chunks,
  ];
}

export async function verifyAssetBytes(asset, bytes) {
  check(bytes.byteLength === asset.bytes, `${asset.url} size does not match`);
  check(await sha256Hex(bytes) === asset.sha256, `${asset.url} hash does not match`);
}
