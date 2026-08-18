// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fetchRollbackRelease } from "./fetch_web_rollback.mjs";
import { smokeWebRelease } from "./web_release_smoke.mjs";
import {
  CLOUDFLARE_RELEASE_METADATA_SCHEMA,
  createCloudflareReleaseMetadata,
  ensureWorkerPreviewSettings,
  parseVersionUploadOutput,
  requireProductionVersion,
  validateCloudflareReleaseMetadata,
} from "./cloudflare_release_metadata.mjs";
import {
  RELEASE_SCHEMA,
  RELEASE_BOOTSTRAP_URLS,
  RESIDENT_RUNTIME_ABI,
  RESIDENT_RUNTIME_CHOICE,
  ROLLBACK_RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseAssets,
  releaseIdentityPayload,
  sha256Hex,
} from "../web/release.mjs";

const ORIGIN = "https://canary.example";
const CLOUDFLARE_ACCOUNT_ID = "d".repeat(32);
const CLOUDFLARE_API_TOKEN = "test-cloudflare-api-token";
const WORKER_NAME = "gekko-free";
const CANDIDATE_VERSION_ID = "12345678-1234-4123-8123-123456789abc";
const PREVIEW_ALIAS_ORIGIN =
  "https://resident-canary-gekko-free.example.workers.dev";
const PREVIEW_ORIGIN = "https://12345678-gekko-free.example.workers.dev";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const temporaryDirectories = [];
after(async () => Promise.all(temporaryDirectories.map(path => rm(path, { recursive: true, force: true }))));

function previewSettingsEnvelope(result) {
  return { success: true, errors: [], messages: [], result };
}

function redirectResponse(status, location, cacheControl = IMMUTABLE_CACHE_CONTROL) {
  return {
    ok: status >= 200 && status <= 299,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "location") return location ?? null;
        if (name.toLowerCase() === "cache-control") return cacheControl;
        return null;
      },
    },
  };
}

function wranglerSession(overrides = {}) {
  return {
    type: "wrangler-session",
    version: 1,
    wrangler_version: "4.112.0",
    command_line_args: ["versions", "upload", "--preview-alias", "resident-canary"],
    log_file_path: "/home/runner/.config/.wrangler/logs/wrangler.log",
    timestamp: "2026-08-18T17:00:00.000Z",
    ...overrides,
  };
}

function versionUpload(overrides = {}) {
  return {
    type: "version-upload",
    version: 1,
    worker_name: WORKER_NAME,
    worker_tag: "worker-service-tag",
    version_id: CANDIDATE_VERSION_ID,
    preview_url: PREVIEW_ORIGIN,
    preview_alias_url: PREVIEW_ALIAS_ORIGIN,
    worker_name_overridden: false,
    timestamp: "2026-08-18T17:00:01.000Z",
    ...overrides,
  };
}

function wranglerOutput(records) {
  return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

function withoutKey(record, key) {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

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

async function putAsset(responses, label, prefix, extension) {
  const bytes = new TextEncoder().encode(label);
  const sha256 = await sha256Hex(bytes);
  const asset = { url: `/assets/${prefix}-${sha256}.${extension}`, sha256, bytes: bytes.byteLength };
  responses.set(asset.url, { bytes, cacheControl: IMMUTABLE_CACHE_CONTROL });
  return asset;
}

async function putStableAsset(responses, bytes, url) {
  const sha256 = await sha256Hex(bytes);
  const asset = { url, sha256, bytes: bytes.byteLength };
  responses.set(url, { bytes, cacheControl: "no-store" });
  return asset;
}

async function fixture() {
  const responses = new Map();
  const rollbackCommit = "a".repeat(40);
  const backendBytes = new TextEncoder().encode("rollback aggregate backend");
  const backendSha = await sha256Hex(backendBytes);
  const backendChunk = await putAsset(
    responses,
    "rollback aggregate backend",
    "rollback-backend",
    "wasm.chunk",
  );
  const rollback = {
    schema: ROLLBACK_RELEASE_SCHEMA,
    source: source(rollbackCommit),
    frontend: await putAsset(responses, "rollback frontend", "rollback-frontend", "html"),
    renderer: {
      javascript: await putAsset(responses, "rollback renderer js", "rollback-renderer", "js"),
      wasm: await putAsset(responses, "rollback renderer wasm", "rollback-renderer-wasm", "wasm"),
    },
    dsp: await putAsset(responses, "rollback dsp", "rollback-dsp", "wasm"),
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: backendSha,
      bytes: backendBytes.byteLength,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [backendChunk],
    },
  };
  rollback.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(rollback)));

  const adapter = await putAsset(responses, "resident adapter", "resident-adapter", "mjs");
  const worker = await putAsset(
    responses,
    `import { ResidentMachineAdapter } from "${adapter.url}";`,
    "resident-worker",
    "mjs",
  );
  const core = await putAsset(responses, "feature core", "browser-machine", "wasm");
  const dispatcher = await putAsset(responses, "dispatcher", "resident-dispatcher", "wasm");
  const coordinator = await putAsset(responses, "coordinator", "core-run-coordinator", "wasm");
  const runtime = {
    choice: RESIDENT_RUNTIME_CHOICE,
    abi: { ...RESIDENT_RUNTIME_ABI },
    core,
    dispatcher,
    coordinator,
    adapter,
    worker,
  };
  const bootstrapDocumentBytes = new TextEncoder().encode(
    `const EXPECTED_RELEASE_SCHEMA = 4;\n` +
      `const EXPECTED_RUNTIME_CHOICE = "${RESIDENT_RUNTIME_CHOICE}";`,
  );
  const bootstrapReleaseModuleBytes = new TextEncoder().encode(
    "export const RELEASE_SCHEMA = 4;",
  );
  const bootstrapServiceWorkerBytes = new TextEncoder().encode(
    "validateRelease /.gekko/stage-canary /.gekko/promote-canary",
  );
  const frontend = await putAsset(
    responses,
    `<script>const residentReleaseRuntime=${JSON.stringify(runtime)};` +
      `new Worker("${worker.url}");` +
      `${core.url}${dispatcher.url}${coordinator.url}</script>`,
    "resident-frontend",
    "html",
  );
  const release = {
    schema: RELEASE_SCHEMA,
    source: source("b".repeat(40)),
    bootstrap: {
      document: await putStableAsset(
        responses,
        bootstrapDocumentBytes,
        RELEASE_BOOTSTRAP_URLS.document,
      ),
      releaseModule: await putStableAsset(
        responses,
        bootstrapReleaseModuleBytes,
        RELEASE_BOOTSTRAP_URLS.releaseModule,
      ),
      serviceWorker: await putStableAsset(
        responses,
        bootstrapServiceWorkerBytes,
        RELEASE_BOOTSTRAP_URLS.serviceWorker,
      ),
    },
    runtime,
    frontend,
    renderer: {
      javascript: await putAsset(responses, "resident renderer js", "resident-renderer", "js"),
      wasm: await putAsset(responses, "resident renderer wasm", "resident-renderer-wasm", "wasm"),
    },
    rollback: { release: rollback },
  };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  responses.set("/release.json", {
    json: release,
    cacheControl: "no-store",
  });
  responses.set("/", {
    bytes: bootstrapDocumentBytes,
    cacheControl: "no-store",
  });
  return { release, rollback, responses };
}

function responseFrom(value) {
  const headers = { "Cache-Control": value.cacheControl };
  if (value.json !== undefined) {
    return new Response(JSON.stringify(value.json), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  return new Response(value.bytes ?? value.text, { headers });
}

function fetchFrom(responses, requests = []) {
  return async input => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requests.push(url.pathname);
    const value = responses.get(url.pathname);
    if (value === undefined) return new Response("missing", { status: 404 });
    return responseFrom(value);
  };
}

function schema3Responses(value) {
  const responses = new Map(value.responses);
  responses.set("/release.json", { json: value.rollback, cacheControl: "no-store" });
  responses.set("/", {
    text: "const EXPECTED_RELEASE_SCHEMA = 3;",
    cacheControl: "no-store",
  });
  responses.set("/release.mjs", {
    text: "export const RELEASE_SCHEMA = 3;",
    cacheControl: "no-store",
  });
  responses.set("/sw.js", { text: "validateRelease", cacheControl: "no-store" });
  return responses;
}

function fetchWithOverrides(responses, override, requests = []) {
  const fallback = fetchFrom(responses);
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requests.push({ url: url.href, cache: init.cache, redirect: init.redirect });
    const overridden = override === undefined ? undefined : await override(url, init);
    return overridden === undefined ? fallback(input, init) : overridden;
  };
}

function smokeSchema3(value, fetchImpl) {
  return smokeWebRelease({
    origin: ORIGIN,
    expectedSchema: ROLLBACK_RELEASE_SCHEMA,
    expectedReleaseId: value.rollback.releaseId,
    fetchImpl,
  });
}

test("fetches only an exact pinned schema-3 rollback and verifies every byte", async () => {
  const value = await fixture();
  const rollbackResponses = new Map(value.responses);
  rollbackResponses.set("/release.json", {
    json: value.rollback,
    cacheControl: "no-store",
  });
  const directory = await mkdtemp(join(tmpdir(), "lazuli-rollback-fetch-"));
  temporaryDirectories.push(directory);
  const fetched = await fetchRollbackRelease({
    origin: ORIGIN,
    expectedReleaseId: value.rollback.releaseId,
    outputPath: directory,
    fetchImpl: fetchFrom(rollbackResponses),
  });
  assert.equal(fetched.releaseId, value.rollback.releaseId);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "release.json"), "utf8")),
    value.rollback,
  );
  for (const asset of releaseAssets(value.rollback)) {
    assert.equal((await readFile(join(directory, asset.url.slice(1)))).byteLength, asset.bytes);
  }
});

test("rollback fetch rejects a live release ID different from the operator pin before assets", async () => {
  const value = await fixture();
  const rollbackResponses = new Map(value.responses);
  rollbackResponses.set("/release.json", { json: value.rollback, cacheControl: "no-store" });
  const requests = [];
  const directory = await mkdtemp(join(tmpdir(), "lazuli-rollback-mismatch-"));
  temporaryDirectories.push(directory);
  await assert.rejects(fetchRollbackRelease({
    origin: ORIGIN,
    expectedReleaseId: "f".repeat(64),
    outputPath: directory,
    fetchImpl: fetchFrom(rollbackResponses, requests),
  }), /does not match pinned/);
  assert.deepEqual(requests, ["/release.json"]);
});

test("rollback fetch extracts the exact authenticated schema-3 fallback from live schema 4", async () => {
  const value = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-rollback-nested-"));
  temporaryDirectories.push(directory);
  const fetched = await fetchRollbackRelease({
    origin: ORIGIN,
    expectedReleaseId: value.rollback.releaseId,
    outputPath: directory,
    fetchImpl: fetchFrom(value.responses),
  });
  assert.equal(fetched.releaseId, value.rollback.releaseId);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "release.json"), "utf8")), value.rollback);
});

test("Cloudflare preview settings no-op only on the exact safe final state", async () => {
  const requests = [];
  const settings = await ensureWorkerPreviewSettings({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    token: CLOUDFLARE_API_TOKEN,
    workerName: WORKER_NAME,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(previewSettingsEnvelope({
        enabled: false,
        previews_enabled: true,
      })));
    },
  });
  assert.deepEqual(settings, { enabled: false, previews_enabled: true });
  assert.ok(Object.isFrozen(settings));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}` +
      `/workers/scripts/${WORKER_NAME}/subdomain`);
  assert.deepEqual(requests[0].init, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      "Cloudflare-Workers-Script-Api-Date": "2025-08-01",
    },
    redirect: "error",
  });
});

test("Cloudflare preview settings update with the exact request and final state", async () => {
  const requests = [];
  const responses = [
    previewSettingsEnvelope({ enabled: false, previews_enabled: false }),
    previewSettingsEnvelope({ enabled: false, previews_enabled: true }),
  ];
  const settings = await ensureWorkerPreviewSettings({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    token: CLOUDFLARE_API_TOKEN,
    workerName: WORKER_NAME,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(responses.shift()));
    },
  });
  assert.deepEqual(settings, { enabled: false, previews_enabled: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(requests[1].init.headers, requests[0].init.headers);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    enabled: false,
    previews_enabled: true,
  });
});

test("Cloudflare preview settings reject non-2xx GET and POST responses", async () => {
  for (const failedMethod of ["GET", "POST"]) {
    const responses = failedMethod === "GET"
      ? [new Response("denied", { status: 403 })]
      : [
          new Response(JSON.stringify(previewSettingsEnvelope({
            enabled: false,
            previews_enabled: false,
          }))),
          new Response("failed", { status: 500 }),
        ];
    await assert.rejects(ensureWorkerPreviewSettings({
      accountId: CLOUDFLARE_ACCOUNT_ID,
      token: CLOUDFLARE_API_TOKEN,
      workerName: WORKER_NAME,
      fetchImpl: async () => responses.shift(),
    }), new RegExp(`${failedMethod} failed: HTTP ${failedMethod === "GET" ? 403 : 500}`));
  }
});

test("Cloudflare preview settings reject malformed API envelopes and results", async () => {
  const vectors = [
    [new Response("not json"), /response is not JSON/],
    [new Response(JSON.stringify({
      ...previewSettingsEnvelope({ enabled: false, previews_enabled: true }),
      unexpected: true,
    })), /response keys are not exact/],
    [new Response(JSON.stringify(previewSettingsEnvelope({
      enabled: false,
      previews_enabled: true,
      unexpected: true,
    }))), /result keys are not exact/],
    [new Response(JSON.stringify({
      ...previewSettingsEnvelope({ enabled: false, previews_enabled: true }),
      errors: [{ code: 1000 }],
    })), /response errors are not empty/],
  ];
  for (const [response, expected] of vectors) {
    await assert.rejects(ensureWorkerPreviewSettings({
      accountId: CLOUDFLARE_ACCOUNT_ID,
      token: CLOUDFLARE_API_TOKEN,
      workerName: WORKER_NAME,
      fetchImpl: async () => response,
    }), expected);
  }
});

test("Cloudflare preview settings reject the wrong POST final state", async () => {
  const responses = [
    previewSettingsEnvelope({ enabled: true, previews_enabled: false }),
    previewSettingsEnvelope({ enabled: false, previews_enabled: false }),
  ];
  await assert.rejects(ensureWorkerPreviewSettings({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    token: CLOUDFLARE_API_TOKEN,
    workerName: WORKER_NAME,
    fetchImpl: async () => new Response(JSON.stringify(responses.shift())),
  }), /wrong final state/);
});

test("Cloudflare metadata binds exact immutable candidate and rollback version IDs", async () => {
  const value = await fixture();
  const rollbackVersionId = "abcdef01-2345-4678-9abc-def012345678";
  const metadata = await createCloudflareReleaseMetadata({
    release: value.release,
    rollbackVersionId,
    predecessorSchema: ROLLBACK_RELEASE_SCHEMA,
    predecessorReleaseId: value.rollback.releaseId,
    predecessorVersionId: rollbackVersionId,
    workerName: WORKER_NAME,
    expectedPreviewAliasOrigin: PREVIEW_ALIAS_ORIGIN,
    wranglerOutput: wranglerOutput([wranglerSession(), versionUpload()]),
  });
  assert.equal(metadata.schema, CLOUDFLARE_RELEASE_METADATA_SCHEMA);
  assert.equal(metadata.candidate.releaseId, value.release.releaseId);
  assert.equal(metadata.candidate.versionId, CANDIDATE_VERSION_ID);
  assert.deepEqual(metadata.predecessor, {
    schema: ROLLBACK_RELEASE_SCHEMA,
    releaseId: value.rollback.releaseId,
    versionId: rollbackVersionId,
  });
  assert.equal(metadata.rollback.releaseId, value.rollback.releaseId);
  assert.equal(metadata.rollback.versionId, rollbackVersionId);
  assert.equal(validateCloudflareReleaseMetadata(metadata, {
    workerName: WORKER_NAME,
    sourceCommit: value.release.source.commit,
    releaseId: value.release.releaseId,
    rollbackReleaseId: value.rollback.releaseId,
  }), metadata);
  assert.throws(() => validateCloudflareReleaseMetadata({
    ...metadata,
    unexpected: true,
  }), /keys are not exact/);
  assert.throws(() => validateCloudflareReleaseMetadata({
    ...metadata,
    rollback: { ...metadata.rollback, versionId: CANDIDATE_VERSION_ID },
  }), /predecessor version does not match rollback/);
  assert.throws(() => validateCloudflareReleaseMetadata(metadata, {
    rollbackReleaseId: "f".repeat(64),
  }), /rollback release ID does not match/);
});

test("Wrangler upload parsing rejects incomplete, unknown, duplicate, or unpinned records", () => {
  const options = {
    workerName: WORKER_NAME,
    expectedPreviewAliasOrigin: PREVIEW_ALIAS_ORIGIN,
  };
  for (const missing of ["preview_url", "preview_alias_url"]) {
    assert.throws(() => parseVersionUploadOutput(wranglerOutput([
      wranglerSession(),
      withoutKey(versionUpload(), missing),
    ]), options), new RegExp(`omits ${missing}`));
  }
  assert.throws(() => parseVersionUploadOutput(wranglerOutput([
    wranglerSession(),
    { type: "future-wrangler-record", version: 1 },
    versionUpload(),
  ]), options), /unknown record type future-wrangler-record/);
  assert.throws(() => parseVersionUploadOutput(wranglerOutput([
    wranglerSession(),
    versionUpload({ unexpected: true }),
  ]), options), /unknown unexpected/);
  assert.throws(() => parseVersionUploadOutput(wranglerOutput([
    wranglerSession(),
    wranglerSession(),
    versionUpload(),
  ]), options), /duplicate wrangler-session/);
  assert.throws(() => parseVersionUploadOutput(wranglerOutput([
    wranglerSession(),
    versionUpload(),
    versionUpload(),
  ]), options), /duplicate version-upload/);
  assert.throws(() => parseVersionUploadOutput(wranglerOutput([
    wranglerSession({ wrangler_version: "4.111.0" }),
    versionUpload(),
  ]), options), /session version is not pinned 4\.112\.0/);
  assert.throws(() => parseVersionUploadOutput(wranglerOutput([
    wranglerSession(),
    versionUpload({ preview_url: "https://a1b2c3d4-gekko-free.example.workers.dev" }),
  ]), options), /preview does not identify the uploaded version ID/);

  const legacy = parseVersionUploadOutput(wranglerOutput([versionUpload()]), options);
  assert.equal(legacy.versionId, CANDIDATE_VERSION_ID);
  assert.equal(legacy.previewOrigin, PREVIEW_ORIGIN);
});

test("production version proof requires one exact UUID at 100 percent", () => {
  const versionId = "12345678-1234-4123-8123-123456789abc";
  const status = JSON.stringify({
    id: "deployment",
    versions: [{ version_id: versionId, percentage: 100 }],
  });
  assert.equal(requireProductionVersion(status, versionId), versionId);
  assert.throws(() => requireProductionVersion(JSON.stringify({
    versions: [{ version_id: versionId, percentage: 90 }],
  }), versionId), /not at 100 percent/);
  assert.throws(() => requireProductionVersion(JSON.stringify({
    versions: [{ version_id: "abcdef01-2345-4678-9abc-def012345678", percentage: 100 }],
  }), versionId), /does not match/);
  assert.throws(() => requireProductionVersion(JSON.stringify({
    versions: [
      { version_id: versionId, percentage: 50 },
      { version_id: "abcdef01-2345-4678-9abc-def012345678", percentage: 50 },
    ],
  }), versionId), /exactly one/);
});

test("schema-3 smoke accepts a direct authenticated frontend 200 without following redirects", async () => {
  const value = await fixture();
  const responses = schema3Responses(value);
  const requests = [];
  const report = await smokeSchema3(
    value,
    fetchWithOverrides(responses, undefined, requests),
  );
  assert.equal(report.ok, true);
  assert.equal(report.schema, ROLLBACK_RELEASE_SCHEMA);
  assert.equal(report.releaseId, value.rollback.releaseId);
  assert.deepEqual(
    requests.filter(request => new URL(request.url).pathname === value.rollback.frontend.url),
    [{
      url: `${ORIGIN}${value.rollback.frontend.url}`,
      cache: "no-store",
      redirect: "manual",
    }],
  );
  assert.ok(requests
    .filter(request => new URL(request.url).pathname !== value.rollback.frontend.url)
    .every(request => request.redirect === "error"));
});

test("schema-3 smoke accepts only the historical same-origin terminal-html 307", async () => {
  const value = await fixture();
  const responses = schema3Responses(value);
  const frontend = value.rollback.frontend.url;
  const extensionless = frontend.slice(0, -".html".length);
  const requests = [];
  const report = await smokeSchema3(value, fetchWithOverrides(
    responses,
    url => {
      if (url.pathname === frontend) {
        return redirectResponse(307, extensionless);
      }
      if (url.pathname === extensionless) return responseFrom(responses.get(frontend));
      return undefined;
    },
    requests,
  ));
  assert.equal(report.ok, true);
  assert.deepEqual(
    requests.filter(request => [frontend, extensionless].includes(new URL(request.url).pathname)),
    [
      { url: `${ORIGIN}${frontend}`, cache: "no-store", redirect: "manual" },
      { url: `${ORIGIN}${extensionless}`, cache: "no-store", redirect: "error" },
    ],
  );
});

test("schema-3 historical frontend 307 is itself immutable", async t => {
  const value = await fixture();
  const responses = schema3Responses(value);
  const frontend = value.rollback.frontend.url;
  const extensionless = frontend.slice(0, -".html".length);
  for (const [name, cacheControl] of [
    ["missing cache control", null],
    ["wrong cache control", "no-store"],
  ]) {
    await t.test(name, async () => {
      const fetchImpl = fetchWithOverrides(responses, url => {
        if (url.pathname !== frontend) return undefined;
        return redirectResponse(307, extensionless, cacheControl);
      });
      await assert.rejects(smokeSchema3(value, fetchImpl), /is not immutable/);
    });
  }
});

test("schema-3 frontend redirect rejects every broader redirect shape", async t => {
  const value = await fixture();
  const responses = schema3Responses(value);
  const frontend = value.rollback.frontend.url;
  const extensionless = frontend.slice(0, -".html".length);
  const vectors = [
    ["301", 301, extensionless, /HTTP 301/],
    ["302", 302, extensionless, /HTTP 302/],
    ["303", 303, extensionless, /HTTP 303/],
    ["308", 308, extensionless, /HTTP 308/],
    ["direct non-200", 204, undefined, /HTTP 204/],
    ["missing Location", 307, undefined, /omits Location/],
    ["invalid Location", 307, "https://[", /Location is not exact terminal \.html removal/],
    ["credentials", 307, `https://user:pass@canary.example${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["empty userinfo", 307, `https://@canary.example${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["cross-origin host", 307, `https://other.example${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["host case variant", 307, `https://CANARY.EXAMPLE${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["scheme change", 307, `http://canary.example${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["port change", 307, `https://canary.example:444${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["explicit default port", 307, `https://canary.example:443${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["absolute expected URL", 307, `${ORIGIN}${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["query", 307, `${extensionless}?unexpected=1`,
      /Location is not exact terminal \.html removal/],
    ["fragment", 307, `${extensionless}#unexpected`,
      /Location is not exact terminal \.html removal/],
    ["empty query delimiter", 307, `${extensionless}?`,
      /Location is not exact terminal \.html removal/],
    ["empty fragment delimiter", 307, `${extensionless}#`,
      /Location is not exact terminal \.html removal/],
    ["literal dot segment", 307, extensionless.replace("/assets/", "/assets/./"),
      /Location is not exact terminal \.html removal/],
    ["literal dot-dot segment", 307, extensionless.replace("/assets/", "/assets/ignored/../"),
      /Location is not exact terminal \.html removal/],
    ["encoded dot-dot segment", 307, extensionless.replace("/assets/", "/assets/ignored/%2e%2e/"),
      /Location is not exact terminal \.html removal/],
    ["encoded dot-dot case variant", 307,
      extensionless.replace("/assets/", "/assets/ignored/%2E%2E/"),
      /Location is not exact terminal \.html removal/],
    ["backslash spelling", 307, extensionless.replaceAll("/", "\\"),
      /Location is not exact terminal \.html removal/],
    ["leading whitespace", 307, ` ${extensionless}`,
      /Location is not exact terminal \.html removal/],
    ["trailing whitespace", 307, `${extensionless} `,
      /Location is not exact terminal \.html removal/],
    ["percent-encoded path spelling", 307, extensionless.replace("/assets/r", "/assets/%72"),
      /Location is not exact terminal \.html removal/],
    ["path case variant", 307, extensionless.replace("/assets/", "/ASSETS/"),
      /Location is not exact terminal \.html removal/],
    ["extra path", 307, `${extensionless}/extra`,
      /Location is not exact terminal \.html removal/],
    ["different extension", 307, frontend.slice(0, -1),
      /Location is not exact terminal \.html removal/],
  ];
  for (const [name, status, location, expected] of vectors) {
    await t.test(name, async () => {
      const fetchImpl = fetchWithOverrides(responses, url => {
        if (url.pathname !== frontend) return undefined;
        return redirectResponse(status, location);
      });
      await assert.rejects(smokeSchema3(value, fetchImpl), expected);
    });
  }
});

test("schema-3 redirected frontend keeps strict final response validation", async t => {
  const value = await fixture();
  const responses = schema3Responses(value);
  const frontend = value.rollback.frontend.url;
  const extensionless = frontend.slice(0, -".html".length);
  const vectors = [
    [
      "second redirect",
      () => redirectResponse(307, `${extensionless}-again`),
      /HTTP 307/,
    ],
    [
      "non-immutable final response",
      () => new Response(responses.get(frontend).bytes, { headers: { "Cache-Control": "no-store" } }),
      /is not immutable/,
    ],
    [
      "wrong final bytes",
      () => new Response("corrupt", {
        headers: { "Cache-Control": IMMUTABLE_CACHE_CONTROL },
      }),
      /size does not match|hash does not match/,
    ],
  ];
  for (const [name, finalResponse, expected] of vectors) {
    await t.test(name, async () => {
      const requests = [];
      const fetchImpl = fetchWithOverrides(responses, url => {
        if (url.pathname === frontend) {
          return redirectResponse(307, extensionless);
        }
        if (url.pathname === extensionless) return finalResponse();
        return undefined;
      }, requests);
      await assert.rejects(smokeSchema3(value, fetchImpl), expected);
      assert.equal(
        requests.find(request => new URL(request.url).pathname === extensionless)?.redirect,
        "error",
      );
    });
  }
});

test("non-frontend and schema-4 redirects remain forbidden", async t => {
  const value = await fixture();
  await t.test("schema-3 non-frontend", async () => {
    const responses = schema3Responses(value);
    const asset = value.rollback.renderer.javascript;
    const requests = [];
    await assert.rejects(smokeSchema3(value, fetchWithOverrides(responses, url => {
      if (url.pathname !== asset.url) return undefined;
      return redirectResponse(307, `${asset.url}-moved`);
    }, requests)), /HTTP 307/);
    assert.equal(
      requests.find(request => new URL(request.url).pathname === asset.url)?.redirect,
      "error",
    );
  });
  await t.test("schema-4 frontend", async () => {
    const frontend = value.release.frontend.url;
    const requests = [];
    await assert.rejects(smokeWebRelease({
      origin: ORIGIN,
      expectedSchema: RELEASE_SCHEMA,
      expectedReleaseId: value.release.releaseId,
      expectedRollbackReleaseId: value.rollback.releaseId,
      fetchImpl: fetchWithOverrides(value.responses, url => {
        if (url.pathname !== frontend) return undefined;
        return redirectResponse(307, frontend.slice(0, -".html".length));
      }, requests),
    }), /HTTP 307/);
    assert.equal(
      requests.find(request => new URL(request.url).pathname === frontend)?.redirect,
      "error",
    );
  });
});

test("schema-4 smoke authenticates resident and nested rollback artifacts", async () => {
  const value = await fixture();
  const report = await smokeWebRelease({
    origin: ORIGIN,
    expectedSchema: RELEASE_SCHEMA,
    expectedReleaseId: value.release.releaseId,
    expectedRollbackReleaseId: value.rollback.releaseId,
    expectedSourceCommit: value.release.source.commit,
    fetchImpl: fetchFrom(value.responses),
  });
  assert.equal(report.ok, true);
  assert.equal(report.releaseId, value.release.releaseId);
  assert.equal(report.rollbackReleaseId, value.rollback.releaseId);
});

test("schema-4 smoke fails on one corrupt immutable executable", async () => {
  const value = await fixture();
  const changed = new Map(value.responses);
  changed.set(value.release.runtime.worker.url, {
    bytes: new TextEncoder().encode("corrupt"),
    cacheControl: "public, max-age=31536000, immutable",
  });
  await assert.rejects(smokeWebRelease({
    origin: ORIGIN,
    expectedReleaseId: value.release.releaseId,
    expectedRollbackReleaseId: value.rollback.releaseId,
    fetchImpl: fetchFrom(changed),
  }), /size does not match|hash does not match/);
});

test("schema-4 smoke byte-verifies stable bootstraps even when required substrings survive", async () => {
  const value = await fixture();
  for (const descriptor of Object.values(value.release.bootstrap)) {
    const changed = new Map(value.responses);
    const original = value.responses.get(descriptor.url);
    const mutated = new Uint8Array(original.bytes.byteLength + 1);
    mutated.set(original.bytes);
    mutated[mutated.byteLength - 1] = 32;
    changed.set(descriptor.url, { ...original, bytes: mutated });
    if (descriptor.url === RELEASE_BOOTSTRAP_URLS.document) {
      changed.set("/", { ...value.responses.get("/"), bytes: mutated });
    }
    await assert.rejects(smokeWebRelease({
      origin: ORIGIN,
      expectedReleaseId: value.release.releaseId,
      expectedRollbackReleaseId: value.rollback.releaseId,
      fetchImpl: fetchFrom(changed),
    }), new RegExp(`${descriptor.url.replaceAll("/", "\\/")} (?:size|hash) does not match`));
  }
});

test("schema-4 smoke rejects an unpinned rollback identity", async () => {
  const value = await fixture();
  await assert.rejects(smokeWebRelease({
    origin: ORIGIN,
    expectedReleaseId: value.release.releaseId,
    expectedRollbackReleaseId: "f".repeat(64),
    fetchImpl: fetchFrom(value.responses),
  }), /rollback release .* does not match/);
});
