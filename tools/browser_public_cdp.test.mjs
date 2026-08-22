// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
} from "../web/release.mjs";
import {
  PUBLIC_VIEWPORT,
  assignPublicDisc,
  clearPublicViewport,
  configurePublicCompatibilityDebug,
  configurePublicViewport,
  expectedPublicFrameUrl,
  requestPublicSnapshot,
  validateObservedPublicActiveRelease,
  waitForPublicRelease,
  waitForPublicRunner,
  waitForPublicSnapshot,
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
    schema: RELEASE_SCHEMA,
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
    dsp: asset("browser-dsp", "wasm", 4567),
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
    compatibilityDebugAvailable: true,
    compositorCaptureAvailable: false,
    dataset: { renderer: "wgpu-webgpu", status: "waiting" },
    diagnosticsCaptureAvailable: true,
    diagnosticsCaptureCompletedRequestId: null,
    diagnosticsCaptureDisabled: true,
    diagnosticsCaptureFailedRequestId: null,
    diagnosticsCaptureFailure: null,
    diagnosticsCaptureRequestId: null,
    diagnosticsCaptureState: "unavailable",
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
    viewportCaptureMode: null,
  };
}

test("public release pins the outer path and immutable iframe identity", async () => {
  const release = await activeRelease();
  const publicUrl = "https://gekko.free/";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  assert.equal(
    frameUrl,
    `${new URL(release.frontend.url, publicUrl).origin}${release.frontend.url}`,
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
  assert.deepEqual(identity.dsp, release.dsp);
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
  const publicUrl = "https://gekko.free/";
  const frameUrl = "https://gekko.free/assets/frontend-immutable.html";
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
  const publicUrl = "https://gekko.free/";
  const frameUrl = "https://gekko.free/assets/frontend.html";
  const state = {
    ...readyState(frameUrl, publicUrl),
    dataset: { renderer: "wgpu-webgpu", status: "running" },
    diagnosticsCaptureDisabled: false,
    diagnosticsCaptureState: "ready",
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

test("public snapshots exercise the visible diagnostics control", async () => {
  const expressions = [];
  const requestSession = {
    async evaluate(expression) {
      expressions.push(expression);
      return { disabled: true, requestId: 7, state: "pending" };
    },
  };
  assert.equal(await requestPublicSnapshot(requestSession), 7);
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /#capture-diagnostics/);
  assert.match(expressions[0], /HTMLButtonElement/);
  assert.match(expressions[0], /button\.disabled/);
  assert.match(expressions[0], /button\.click\(\)/);
  assert.match(expressions[0], /button\.dataset\.requestId/);
  assert.doesNotMatch(expressions[0], /lazuliCycleRunner|output\.textContent/);

  const states = [
    {
      diagnosticsCaptureDisabled: true,
      diagnosticsCaptureRequestId: "7",
      diagnosticsCaptureState: "pending",
      result: JSON.stringify({
        diagnosticsRequestId: 6,
        status: "running",
        stage: "snapshot",
      }),
    },
    {
      diagnosticsCaptureDisabled: true,
      diagnosticsCaptureRequestId: "7",
      diagnosticsCaptureState: "pending",
      result: JSON.stringify({
        diagnosticsRequestId: 7,
        status: "paused",
        stage: "scenario-complete",
      }),
    },
    {
      diagnosticsCaptureCompletedRequestId: "7",
      diagnosticsCaptureDisabled: false,
      diagnosticsCaptureRequestId: "7",
      diagnosticsCaptureState: "complete",
      result: JSON.stringify({
        diagnosticsRequestId: 7,
        status: "running",
        stage: "snapshot",
      }),
    },
  ];
  const waitSession = {
    async evaluate() { return states.shift() ?? states.at(-1); },
  };
  const captured = await waitForPublicSnapshot(waitSession, {
    deadline: Date.now() + 1_000,
    pollMs: 0,
    requestId: 7,
  });
  assert.equal(captured.report.stage, "snapshot");
  assert.equal(captured.report.diagnosticsRequestId, 7);
  assert.equal(captured.state.diagnosticsCaptureDisabled, false);
});

test("public snapshot failures reject immediately without accepting stale JSON", async () => {
  const failedState = {
    diagnosticsCaptureDisabled: true,
    diagnosticsCaptureFailedRequestId: "9",
    diagnosticsCaptureFailure: "WebGPU renderer failed: device lost",
    diagnosticsCaptureRequestId: "9",
    diagnosticsCaptureState: "failed",
    result: JSON.stringify({
      diagnosticsRequestId: 8,
      status: "running",
      stage: "snapshot",
    }),
  };
  let evaluations = 0;
  await assert.rejects(
    waitForPublicSnapshot({
      async evaluate() {
        evaluations += 1;
        return failedState;
      },
    }, {
      deadline: Date.now() + 10_000,
      pollMs: 1_000,
      requestId: 9,
    }),
    /request 9 failed: WebGPU renderer failed: device lost/,
  );
  assert.equal(evaluations, 1, "a DOM-visible capture failure must not poll until timeout");

  await assert.rejects(
    waitForPublicSnapshot({
      async evaluate() {
        return {
          diagnosticsCaptureRequestId: "10",
          diagnosticsCaptureState: "pending",
          result: JSON.stringify({ status: "stopped", stage: "worker", error: "disc read" }),
        };
      },
    }, {
      deadline: Date.now() + 10_000,
      pollMs: 1_000,
      requestId: 10,
    }),
    /request 10 stopped.*disc read/,
  );
});

test("compatibility scenarios use the explicit iframe debug control before disc activation", async () => {
  const expressions = [];
  const session = {
    async evaluate(expression) {
      expressions.push(expression);
      return { scenario: "smb-ready-play", viewportCaptureMode: "enabled" };
    },
  };
  assert.deepEqual(
    await configurePublicCompatibilityDebug(session, {
      scenario: "smb-ready-play",
      viewportCapture: true,
    }),
    { scenario: "smb-ready-play", viewportCaptureMode: "enabled" },
  );
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /lazuliCompatibilityDebug/);
  assert.match(expressions[0], /selectScenario\(request\.scenario\)/);
  assert.doesNotMatch(expressions[0], /location\.searchParams|history\.|location\.replace/);
  await assert.rejects(
    configurePublicCompatibilityDebug(session, { scenario: "other" }),
    /scenario is unsupported/,
  );
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
