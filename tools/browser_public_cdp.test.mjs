// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
} from "../web/release.mjs";
import {
  PUBLIC_VIEWPORT,
  assignPublicDisc,
  clearPublicViewport,
  configurePublicViewport,
  expectedPublicFrameUrl,
  validateObservedPublicActiveRelease,
  waitForPublicRelease,
  waitForPublicRunner,
} from "./browser_public_cdp.mjs";

async function activeRelease() {
  const commit = "1".repeat(40);
  const hash = "2".repeat(64);
  const asset = (prefix, extension, bytes) => ({
    url: `/assets/${prefix}-${hash}.${extension}`,
    sha256: hash,
    bytes,
  });
  const release = {
    schema: 2,
    releaseId: "0".repeat(64),
    source: {
      repository: "https://github.com/conradev/lazuli",
      commit,
      tree: `https://github.com/conradev/lazuli/tree/${commit}`,
      archive: `https://github.com/conradev/lazuli/archive/${commit}.tar.gz`,
      license: {
        expression: "GPL-3.0-only",
        text: "/LICENSE.txt",
        source: `https://github.com/conradev/lazuli/blob/${commit}/licenses/GPL-3.0-only.txt`,
      },
    },
    frontend: asset("frontend", "html", 1234),
    renderer: {
      javascript: asset("renderer", "js", 2345),
      wasm: asset("renderer-wasm", "wasm", 3456),
    },
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: hash,
      bytes: WASM_CHUNK_SIZE,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [asset("ppcwasmjit-0000", "wasm", WASM_CHUNK_SIZE)],
    },
  };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  return release;
}

function readyState(frameUrl, publicUrl) {
  return {
    compositorCaptureAvailable: false,
    dataset: { renderer: "wgpu-webgpu", status: "waiting" },
    discStatus: "open a disc",
    frameHidden: false,
    frameReadyState: "complete",
    frameUrl,
    hasDiscInput: true,
    result: "",
    runnerAvailable: false,
    statusHidden: true,
    surface: "release",
    topReadyState: "complete",
    topUrl: publicUrl,
    viewportCaptureMode: "enabled",
  };
}

test("public release pins the outer path and immutable iframe identity", async () => {
  const release = await activeRelease();
  const publicUrl = "https://gekko.free/?scenario=smb-ready-play&viewportCapture=1&headlessRun=run-1";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  assert.equal(
    frameUrl,
    `${new URL(release.frontend.url, publicUrl).origin}${release.frontend.url}`
      + "?scenario=smb-ready-play&viewportCapture=1&headlessRun=run-1",
  );

  const options = {
    expectCommit: release.source.commit,
    expectReleaseId: release.releaseId,
    publicUrl,
  };
  const identity = await validateObservedPublicActiveRelease({
    body: JSON.stringify(release),
    controlled: true,
    error: null,
    pathname: "/",
    status: 200,
  }, options);
  assert.equal(identity.frontend.url, release.frontend.url);
  assert.equal(identity.commit, release.source.commit);
  assert.equal(identity.releaseId, release.releaseId);

  await assert.rejects(
    validateObservedPublicActiveRelease({
      body: JSON.stringify(release),
      controlled: true,
      error: null,
      pathname: release.frontend.url,
      status: 200,
    }, options),
    /wrong top-level path/,
  );
  await assert.rejects(
    validateObservedPublicActiveRelease({
      body: JSON.stringify(release),
      controlled: true,
      error: null,
      pathname: "/",
      status: 200,
    }, options, { ...identity, releaseId: "3".repeat(64) }),
    /changed during observation/,
  );
});

test("public readiness requires the exact top-level and immutable frame URLs", async () => {
  const publicUrl = "https://gekko.free/?scenario=smb-ready-play";
  const frameUrl = "https://gekko.free/assets/frontend-immutable.html?scenario=smb-ready-play";
  const state = readyState(frameUrl, publicUrl);
  const session = { async evaluate() { return state; } };
  assert.strictEqual(await waitForPublicRelease(session, {
    deadline: Date.now() + 1_000,
    expectedFrameUrl: frameUrl,
    pollMs: 10,
    publicUrl,
  }), state);
});

test("shared public disc assignment and runner observation stay iframe-owned", async () => {
  const calls = [];
  const publicUrl = "https://gekko.free/?scenario=smb-ready-play";
  const frameUrl = "https://gekko.free/assets/frontend.html?scenario=smb-ready-play";
  const state = {
    ...readyState(frameUrl, publicUrl),
    dataset: { renderer: "wgpu-webgpu", status: "running" },
    discStatus: "local: game.ciso",
    runnerAvailable: true,
  };
  const session = {
    async evaluate(expression) {
      calls.push({ expression, method: "evaluate" });
      if (expression.includes("fileCount")) return { dispatched: true, fileCount: 1 };
      return state;
    },
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { objectId: "disc-input" } };
      return {};
    },
  };
  assert.deepEqual(await assignPublicDisc(session, "/tmp/game.ciso", {
    deadline: Date.now() + 1_000,
    label: "test CISO",
    pollMs: 10,
  }), { dispatched: true, fileCount: 1 });
  assert.strictEqual(await waitForPublicRunner(session, {
    deadline: Date.now() + 1_000,
    pollMs: 10,
    stoppedLabel: "test",
  }), state);
  assert.ok(calls.some(call => call.method === "DOM.setFileInputFiles"));
  assert.ok(calls.some(call => call.method === "Runtime.releaseObject"));
});

test("public viewport commands are fixed, reversible, and independent of renderer pacing", async () => {
  const calls = [];
  const session = {
    async send(method, params = {}) { calls.push({ method, params }); },
  };
  await configurePublicViewport(session);
  await clearPublicViewport(session);
  assert.deepEqual(calls, [
    { method: "Page.bringToFront", params: {} },
    { method: "Emulation.setDeviceMetricsOverride", params: PUBLIC_VIEWPORT },
    { method: "Emulation.clearDeviceMetricsOverride", params: {} },
  ]);
  assert.equal(calls.some(call => call.method.includes("Runtime")), false);
});
