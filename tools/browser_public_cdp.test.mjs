// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_RESIDENT_POLICY,
  PUBLIC_VIEWPORT,
  assertNoPublicResidentExceptions,
  assignPublicDisc,
  assignPublicResidentDisc,
  capturePublicResidentDiagnostics,
  clearPublicViewport,
  compactPublicActiveRelease,
  configurePublicCompatibilityDebug,
  configurePublicViewport,
  expectedPublicFrameUrl,
  observePublicResidentNavigation,
  requestPublicSnapshot,
  validateCompactPublicActiveRelease,
  validateObservedPublicActiveRelease,
  validatePublicResidentDiagnosticCapture,
  waitForPublicResidentFirstXfb,
  waitForPublicResidentRelease,
  waitForPublicRelease,
  waitForPublicRunner,
  waitForPublicSnapshot,
} from "./browser_public_cdp.mjs";
import { schema4ReleaseFixture } from "./browser_public_release_identity.test_fixture.mjs";

async function activeRelease() {
  return schema4ReleaseFixture();
}

function residentBinding(publicUrl, frameUrl, offset = 0) {
  return {
    frameDocumentTimeOrigin: 2_000 + offset,
    frameSource: frameUrl,
    frameUrl,
    topDocumentTimeOrigin: 1_000 + offset,
    topUrl: publicUrl,
  };
}

function residentCapture(release, binding) {
  return {
    binding: structuredClone(binding),
    resultMatched: true,
    report: {
      schema: "lazuli-resident-frontend-diagnostics-v1",
      status: "running",
      policy: structuredClone(PUBLIC_RESIDENT_POLICY),
      runtime: structuredClone(release.runtime),
      session: {
        state: "running",
        label: "local: disc.ciso",
        boot: { status: 3, reads: 7 },
        totals: {
          rustSlices: 2,
          hostCallCapBoundaries: 1,
          coldInstallCapBoundaries: 1,
          hostCalls: 64,
          coldInstalls: 64,
          executedCycles: "1000000",
          executedInstructions: "42",
          zeroProgressSlices: 0,
          maximumConsecutiveZeroProgressSlices: 0,
          consecutiveZeroProgressSlices: 0,
          outcomeDetails: { 0: 2 },
        },
        diagnostics: {
          booted: true,
          memoryPages: release.runtime.abi.memoryInitialPages,
          totalBootReads: 7,
          totalDiReads: 8,
          totalRenderCalls: 1,
          totalColdInstalls: 64,
          pendingControllerSample: false,
          totalControllerRetries: 0,
          tableSlots: 65_536,
          machineEvidence: {
            available: true,
            bytes: release.runtime.abi.machineEvidenceBytes,
            encoding: "base64",
            payload: "A".repeat(
              Math.ceil(release.runtime.abi.machineEvidenceBytes / 3) * 4,
            ),
          },
        },
        failure: null,
      },
      renderer: {
        diagnostics: { presentXfbCalls: 1 },
        hasPresentedXfb: true,
        hostDiagnostics: {},
      },
      capabilityBoundary: {
        rawDiscBytesOnly: true,
        opaqueRendererRequestsAndReceipts: true,
        opaqueMachineEvidence: true,
        javascriptDispatchTableSets: 0,
        javascriptGuestMemoryReads: 0,
      },
    },
  };
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
  assert.equal(identity.runtime.choice, release.runtime.choice);
  assert.deepEqual(identity.runtime.abi, release.runtime.abi);
  assert.deepEqual(identity.bootstrap.document, release.bootstrap.document);
  assert.equal(identity.rollback.release.releaseId, release.rollback.release.releaseId);
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

test("compact public identity fails closed on resident, bootstrap, and rollback drift", async () => {
  const release = await activeRelease();
  const identity = await validateObservedPublicActiveRelease({
    body: JSON.stringify(release),
    controlled: true,
    error: null,
    pathname: "/",
    status: 200,
  }, {
    expectCommit: release.source.commit,
    expectReleaseId: release.releaseId,
    publicUrl: "https://gekko.free/",
  });
  const cases = [
    ["runtime", value => { delete value.runtime.coordinator; }, /runtime.*coordinator/],
    ["runtime ABI", value => { value.runtime.abi.machineEvidenceBytes += 1; }, /machineEvidenceBytes/],
    [
      "runtime artifact substitution",
      value => {
        value.runtime.core.sha256 = "6".repeat(64);
        value.runtime.core.url = `/assets/browser-machine-${"6".repeat(64)}.wasm`;
      },
      /releaseId.*authenticate the compact schema-4 identity/,
    ],
    ["bootstrap", value => { value.bootstrap.document.url = "/"; }, /bootstrap\.document\.url/],
    [
      "bootstrap digest substitution",
      value => { value.bootstrap.document.sha256 = "7".repeat(64); },
      /releaseId.*authenticate the compact schema-4 identity/,
    ],
    ["rollback", value => { delete value.rollback.release.releaseId; }, /rollback\.release.*releaseId/],
    [
      "nested rollback bytes",
      value => { value.rollback.release.frontend.bytes += 1; },
      /rollback\.release\.releaseId.*authenticate the nested rollback manifest/,
    ],
    ["rollback schema", value => { value.rollback.release.schema = 4; }, /rollback\.release\.schema/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const changed = structuredClone(identity);
    mutate(changed);
    assert.throws(
      () => validateCompactPublicActiveRelease(changed),
      pattern,
      label,
    );
  }
});

test("resident readiness binds the same-origin document without legacy controls", async () => {
  const manifest = await activeRelease();
  const release = compactPublicActiveRelease(manifest);
  const publicUrl = "https://gekko.free/";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  const binding = residentBinding(publicUrl, frameUrl);
  const state = {
    binding,
    dataset: { renderer: "wgpu-webgpu", status: "waiting" },
    discStatus: "open a disc",
    frameHidden: false,
    frameReadyState: "complete",
    hasDiscInput: true,
    hasResult: true,
    result: JSON.stringify({ status: "waiting" }),
    runnerAvailable: true,
    statusHidden: true,
    surface: "release",
    topReadyState: "complete",
  };
  const expressions = [];
  const session = {
    exceptions: [],
    async evaluate(expression) {
      expressions.push(expression);
      return state;
    },
  };
  assert.strictEqual(await waitForPublicResidentRelease(session, {
    deadline: Date.now() + 1_000,
    expectedFrameUrl: frameUrl,
    pollMs: 0,
    publicUrl,
  }), state);
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /lazuliCycleRunner\?\.snapshot/);
  assert.match(expressions[0], /body\?\.dataset/);
  assert.match(expressions[0], /#disc-file/);
  assert.match(expressions[0], /#result/);
  assert.doesNotMatch(
    expressions[0],
    /lazuliCompatibilityDebug|selectScenario|capture-diagnostics|requestId|read_presented_xfb|\bpc\b/i,
  );

  await assert.rejects(
    waitForPublicResidentRelease({ ...session, async evaluate() {
      return { ...state, binding: residentBinding(publicUrl, frameUrl, 1) };
    } }, {
      deadline: Date.now() + 1_000,
      expectedBinding: binding,
      expectedFrameUrl: frameUrl,
      pollMs: 0,
      publicUrl,
    }),
    /resident document identity changed/,
  );
});

test("resident disc assignment remains bound to the ready document", async () => {
  const release = compactPublicActiveRelease(await activeRelease());
  const publicUrl = "https://gekko.free/";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  const binding = residentBinding(publicUrl, frameUrl);
  const calls = [];
  const session = {
    exceptions: [],
    async evaluate(expression) {
      calls.push({ expression, method: "evaluate" });
      return { activated: true, binding, dispatched: true, fileCount: 1 };
    },
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { objectId: "resident-disc-input" } };
      return {};
    },
  };
  assert.deepEqual(await assignPublicResidentDisc(session, "/tmp/disc.ciso", {
    deadline: Date.now() + 1_000,
    expectedBinding: binding,
    expectedFrameUrl: frameUrl,
    pollMs: 0,
    publicUrl,
  }), { activated: true, binding, dispatched: true, fileCount: 1 });
  assert.ok(calls.some(call => call.method === "DOM.setFileInputFiles"));
  assert.ok(calls.some(call => call.method === "Runtime.releaseObject"));
  const residentExpressions = calls
    .filter(call => typeof call.params?.expression === "string" || typeof call.expression === "string")
    .map(call => call.params?.expression ?? call.expression);
  assert.equal(residentExpressions.length, 2);
  for (const expression of residentExpressions) {
    assert.match(expression, /expectedBinding/);
    assert.match(expression, /#disc-file/);
    assert.doesNotMatch(expression, /lazuliCompatibilityDebug|selectScenario|capture-diagnostics/);
  }
});

test("resident diagnostics bind runner return to the same frame and result JSON", async () => {
  const release = compactPublicActiveRelease(await activeRelease());
  const publicUrl = "https://gekko.free/";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  const binding = residentBinding(publicUrl, frameUrl);
  const capture = residentCapture(release, binding);
  const expressions = [];
  const session = {
    exceptions: [],
    async evaluate(expression) {
      expressions.push(expression);
      return capture;
    },
  };
  assert.strictEqual(await capturePublicResidentDiagnostics(session, {
    expectedBinding: binding,
    expectedFrameUrl: frameUrl,
    publicUrl,
    release,
  }), capture);
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /await runner\.snapshot\(\)/);
  assert.match(expressions[0], /frame\.contentDocument !== frameDocument/);
  assert.match(expressions[0], /frameDocument\.querySelector\("#result"\) !== result/);
  assert.match(expressions[0], /JSON\.stringify\(published\) !== JSON\.stringify\(report\)/);
  assert.doesNotMatch(
    expressions[0],
    /lazuliCompatibilityDebug|selectScenario|capture-diagnostics|read_presented_xfb|read_presented_surface|\bpc\b/i,
  );
});

test("resident milestone rejects malformed boot, progress, evidence, presentation, and drift", async () => {
  const release = compactPublicActiveRelease(await activeRelease());
  const publicUrl = "https://gekko.free/";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  const binding = residentBinding(publicUrl, frameUrl);
  const options = { expectedBinding: binding, expectedFrameUrl: frameUrl, publicUrl, release };
  const cases = [
    ["boot", value => { value.report.session.boot.status = 2; }, /boot\.status.*did not commit/],
    ["no Rust slice", value => {
      value.report.session.totals.rustSlices = 0;
      value.report.session.totals.executedCycles = "0";
      value.report.session.totals.executedInstructions = "0";
      value.report.session.totals.outcomeDetails = {};
    }, /no Rust slice/],
    ["noncanonical cycles", value => {
      value.report.session.totals.executedCycles = "01";
    }, /canonical unsigned decimal/],
    ["zero progress", value => {
      value.report.session.totals.executedCycles = "0";
      value.report.session.totals.executedInstructions = "0";
    }, /positive progress/],
    ["impossible progress", value => {
      value.report.session.totals.executedCycles = "0";
    }, /positive instructions cannot accompany zero executed cycles/],
    ["unaccounted Rust slice", value => {
      value.report.session.totals.outcomeDetails[0] = 1;
    }, /account for every Rust slice/],
    ["evidence bytes", value => {
      value.report.session.diagnostics.machineEvidence.bytes -= 1;
    }, /authenticated ABI length/],
    ["evidence alphabet", value => {
      value.report.session.diagnostics.machineEvidence.payload = "!".repeat(1_088);
    }, /length or alphabet changed/],
    ["evidence unavailable", value => {
      value.report.session.diagnostics.machineEvidence.available = false;
      value.report.session.diagnostics.machineEvidence.payload = null;
    }, /opaque evidence is unavailable/],
    ["no first presentation", value => {
      value.report.renderer.hasPresentedXfb = false;
    }, /no XFB has been presented/],
    ["no presentation call", value => {
      value.report.renderer.diagnostics.presentXfbCalls = 0;
    }, /no presentation call/],
    ["no machine render", value => {
      value.report.session.diagnostics.totalRenderCalls = 0;
    }, /no machine render call/],
    ["runtime drift", value => { value.report.runtime.worker.bytes += 1; }, /frozen resident contract/],
    ["result mismatch", value => { value.resultMatched = false; }, /same result element JSON/],
    ["document drift", value => { value.binding.frameDocumentTimeOrigin += 1; }, /identity changed/],
    ["capability drift", value => {
      value.report.capabilityBoundary.javascriptGuestMemoryReads = 1;
    }, /frozen resident contract/],
    ["failure", value => { value.report.session.failure = "worker stopped"; }, /session failed/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const value = structuredClone(residentCapture(release, binding));
    mutate(value);
    assert.throws(
      () => validatePublicResidentDiagnosticCapture(value, options),
      pattern,
      label,
    );
  }
  assert.doesNotThrow(() => assertNoPublicResidentExceptions([]));
  assert.throws(() => assertNoPublicResidentExceptions([{ text: "boom" }]), /expected no exceptions/);
  await assert.rejects(
    capturePublicResidentDiagnostics({
      exceptions: [{ text: "boom" }],
      async evaluate() { assert.fail("capture ran after a DevTools exception"); },
    }, options),
    /expected no exceptions/,
  );
});

test("resident first-XFB wait retries only a well-formed pending milestone", async () => {
  const release = compactPublicActiveRelease(await activeRelease());
  const publicUrl = "https://gekko.free/";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  const binding = residentBinding(publicUrl, frameUrl);
  const pending = residentCapture(release, binding);
  pending.report.renderer.hasPresentedXfb = false;
  const ready = residentCapture(release, binding);
  const captures = [pending, ready];
  const session = {
    exceptions: [],
    async evaluate() { return captures.shift() ?? ready; },
  };
  assert.strictEqual(await waitForPublicResidentFirstXfb(session, {
    deadline: Date.now() + 1_000,
    expectedBinding: binding,
    expectedFrameUrl: frameUrl,
    pollMs: 0,
    publicUrl,
    release,
  }), ready);
});

test("resident navigation pins one immutable iframe loader", async () => {
  const publicUrl = "https://gekko.free/";
  const frameUrl = "https://gekko.free/assets/frontend-immutable.html";
  const session = {
    exceptions: [],
    async send(method) {
      assert.equal(method, "Page.getFrameTree");
      return {
        frameTree: {
          frame: { id: "top", loaderId: "top-loader", url: publicUrl },
          childFrames: [{
            frame: { id: "resident", loaderId: "resident-loader", url: frameUrl },
          }],
        },
      };
    },
  };
  assert.deepEqual(await observePublicResidentNavigation(session, {
    expectedFrameUrl: frameUrl,
    expectedTopLoaderId: "top-loader",
    publicUrl,
  }), {
    top: { frameId: "top", loaderId: "top-loader", url: publicUrl },
    frame: { frameId: "resident", loaderId: "resident-loader", url: frameUrl },
  });
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
