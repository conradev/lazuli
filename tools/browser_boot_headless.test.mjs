// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("./browser_boot_headless.mjs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name}`);
  const start = source.slice(functionStart - 6, functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

test("headless capture exposes --expect and verifies before persistence", () => {
  assert.match(source, /case "--expect":/);
  assert.match(source, /readCheckpointManifest\(options\.expect\)/);
  assert.equal(
    source.match(/verifyExpectedCheckpoint\(report, options, expectedManifest\)/g)?.length,
    2,
  );
  assert.match(
    source,
    /verifyExpectedCheckpoint\(report, options, expectedManifest\);[\s\S]*?await persist/,
  );
  assert.equal(
    source.match(/^\s+attachHeadlessCapture\(/gm)?.length,
    2,
  );
  assert.match(
    source,
    /verifyPageOwnedRendering\(report, state\);\s*report\.headlessCapture =/,
  );
  assert.doesNotMatch(source, /lazuliRendererDiagnostics/);
  assert.doesNotMatch(source, /captureRendering/);
  assert.equal(
    source.match(/headlessRunToReportMs: reportDetectedAt - runStartedAt/g)?.length,
    2,
  );
});

test("headless capture pins the validated active deployed release twice", async () => {
  assert.match(
    source,
    /import \{ validateRelease \} from "\.\.\/web\/release\.mjs"/,
  );
  assert.match(source, /case "--expect-commit":/);
  assert.match(source, /case "--expect-release-id":/);
  assert.doesNotMatch(source, /fetch\("\/release\.json"/);
  assert.equal(
    source.match(/await observeActiveReleaseIfPinned\(/g)?.length,
    2,
  );
  const observer = source.indexOf("await observeActiveReleaseBeforeActivation(");
  const activation = source.indexOf("await attachDiscAfterFreshNavigation(session");
  assert.notEqual(observer, -1);
  assert.ok(observer < activation);

  const argumentContext = vm.createContext({ Error, Number, Set, URL });
  vm.runInContext(extractFunction("parseArguments"), argumentContext);
  const parsed = argumentContext.parseArguments([
    "--url",
    "https://gekko.free/assets/frontend.html",
    "--expect-commit",
    "1".repeat(40),
    "--expect-release-id",
    "2".repeat(64),
  ]);
  assert.equal(parsed.expectCommit, "1".repeat(40));
  assert.equal(parsed.expectReleaseId, "2".repeat(64));
  assert.throws(
    () => argumentContext.parseArguments([
      "--url",
      "https://gekko.free/assets/frontend.html",
      "--expect-commit",
      "A".repeat(40),
    ]),
    /--expect-commit must be 40 lowercase hexadecimal characters/,
  );
  assert.throws(
    () => argumentContext.parseArguments([
      "--url",
      "https://gekko.free/assets/frontend.html",
      "--expect-release-id",
      "2".repeat(63),
    ]),
    /--expect-release-id must be 64 lowercase hexadecimal characters/,
  );

  let observerCalls = 0;
  const optInContext = vm.createContext({
    async observeActiveRelease(_session, options, expectedIdentity) {
      observerCalls += 1;
      return { options, expectedIdentity };
    },
  });
  vm.runInContext([
    extractFunction("releasePinRequested"),
    extractFunction("observeActiveReleaseIfPinned"),
  ].join("\n\n"), optInContext);
  assert.equal(await optInContext.observeActiveReleaseIfPinned({}, {
    expectCommit: null,
    expectReleaseId: null,
  }), null);
  assert.equal(observerCalls, 0);
  const pinnedIdentity = { releaseId: "2".repeat(64) };
  const pinnedObservation = await optInContext.observeActiveReleaseIfPinned({}, {
    expectCommit: null,
    expectReleaseId: "2".repeat(64),
  }, pinnedIdentity);
  assert.equal(observerCalls, 1);
  assert.strictEqual(pinnedObservation.expectedIdentity, pinnedIdentity);

  const context = vm.createContext({
    Array,
    Error,
    JSON,
    async validateRelease(release) {
      assert.equal(release.schema, 2);
      assert.equal(Object.hasOwn(release, "cacheName"), false);
      return release;
    },
  });
  vm.runInContext([
    extractFunction("compactReleaseAsset"),
    extractFunction("compactActiveRelease"),
    extractFunction("validateObservedActiveRelease"),
  ].join("\n\n"), context);
  const release = {
    schema: 2,
    releaseId: "a".repeat(64),
    source: { commit: "b".repeat(40) },
    frontend: { url: `/assets/frontend-${"c".repeat(64)}.html`, sha256: "c".repeat(64), bytes: 10 },
    renderer: {
      javascript: { url: `/assets/renderer-${"d".repeat(64)}.js`, sha256: "d".repeat(64), bytes: 20 },
      wasm: { url: `/assets/renderer-${"e".repeat(64)}.wasm`, sha256: "e".repeat(64), bytes: 30 },
    },
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: "f".repeat(64),
      bytes: 40,
      chunks: [{ ignored: "compact evidence omits chunks" }],
    },
  };
  const options = {
    expectCommit: release.source.commit,
    expectReleaseId: release.releaseId,
  };
  const observation = {
    body: JSON.stringify(release),
    controlled: true,
    error: null,
    pathname: release.frontend.url,
    status: 200,
  };
  const identity = await context.validateObservedActiveRelease(observation, options);
  assert.deepEqual(Object.keys(identity), [
    "schema",
    "releaseId",
    "commit",
    "frontend",
    "renderer",
    "backend",
  ]);
  assert.equal(Object.hasOwn(identity.backend, "chunks"), false);
  await assert.doesNotReject(
    context.validateObservedActiveRelease(observation, options, identity),
  );

  await assert.rejects(
    context.validateObservedActiveRelease(
      { ...observation, controlled: false },
      options,
    ),
    /no service-worker controller/,
  );
  await assert.rejects(
    context.validateObservedActiveRelease(
      { ...observation, pathname: "/app.html" },
      options,
    ),
    /not the active immutable frontend/,
  );
  await assert.rejects(
    context.validateObservedActiveRelease(observation, {
      ...options,
      expectCommit: "0".repeat(40),
    }),
    /does not match --expect-commit/,
  );
  await assert.rejects(
    context.validateObservedActiveRelease(observation, {
      ...options,
      expectReleaseId: "0".repeat(64),
    }),
    /does not match --expect-release-id/,
  );
  await assert.rejects(
    context.validateObservedActiveRelease(observation, options, {
      ...identity,
      releaseId: "0".repeat(64),
    }),
    /changed during headless capture/,
  );
});

test("local disc identity is complete before navigation and joins every capture", () => {
  assert.match(
    source,
    /import \{ identifyLocalDiscImage \} from "\.\/browser_boot_disc_identity\.mjs"/,
  );
  const identity = source.indexOf("await identifyLocalDiscImage(options.disc)");
  const navigation = source.indexOf('session.send("Page.navigate"');
  const upload = source.indexOf("await attachDiscAfterFreshNavigation(session");
  assert.notEqual(identity, -1);
  assert.ok(identity < navigation);
  assert.ok(identity < upload);
  assert.equal(
    source.match(/^\s+attachHeadlessCapture\(/gm)?.length,
    2,
  );
  assert.equal(
    source.match(/terminalRelease,\s*discImage,\s*\);/g)?.length,
    2,
  );

  const context = vm.createContext({ Array, Error, JSON });
  vm.runInContext([
    extractFunction("terminalReportFailure"),
    extractFunction("verifyPageOwnedRendering"),
    extractFunction("attachHeadlessCapture"),
  ].join("\n\n"), context);
  const discImage = Object.freeze({
    algorithm: "sha256",
    format: "ciso",
    sha256: "a".repeat(64),
  });
  const report = { rendering: { backend: "wgpu-webgpu" } };
  context.attachHeadlessCapture(
    { exceptions: [] },
    {
      dataset: { renderer: "wgpu-webgpu" },
      title: "Lazuli debug harness",
      url: "http://127.0.0.1:8766/",
    },
    report,
    { reuse: null },
    { releaseId: "a".repeat(64) },
    discImage,
  );
  assert.strictEqual(report.headlessCapture.discImage, discImage);
  assert.deepEqual(Object.keys(report.headlessCapture.discImage), [
    "algorithm",
    "format",
    "sha256",
  ]);

  const reportWithoutDisc = { rendering: { backend: "wgpu-webgpu" } };
  context.attachHeadlessCapture(
    { exceptions: [] },
    {
      dataset: { renderer: "wgpu-webgpu" },
      title: "Lazuli debug harness",
      url: "http://127.0.0.1:8766/",
    },
    reportWithoutDisc,
    { reuse: null },
    { releaseId: "a".repeat(64) },
  );
  assert.equal(Object.hasOwn(reportWithoutDisc.headlessCapture, "discImage"), false);

  const unpinnedReport = { rendering: { backend: "wgpu-webgpu" } };
  context.attachHeadlessCapture(
    { exceptions: [] },
    {
      dataset: { renderer: "wgpu-webgpu" },
      title: "Local debug harness",
      url: "http://127.0.0.1:8766/",
    },
    unpinnedReport,
    { reuse: null },
    null,
  );
  assert.equal(Object.hasOwn(unpinnedReport.headlessCapture, "release"), false);
});

test("headless capture cross-checks the page-owned renderer evidence", () => {
  const context = vm.createContext({ Array, Error, JSON });
  vm.runInContext([
    extractFunction("terminalReportFailure"),
    extractFunction("verifyPageOwnedRendering"),
    extractFunction("attachHeadlessCapture"),
  ].join("\n\n"), context);
  const state = {
    dataset: { renderer: "wgpu-webgpu" },
    title: "Lazuli debug harness",
    url: "http://127.0.0.1:8766/",
  };
  const rendering = {
    backend: "wgpu-webgpu",
    metrics: { scope: "current-worker" },
    selectedXfb: null,
    temporalSelectedXfb: { capacity: 8, frames: [] },
  };
  const report = {
    rendering,
  };
  assert.doesNotThrow(() => context.verifyPageOwnedRendering(report, state));
  context.attachHeadlessCapture(
    { exceptions: [] },
    state,
    report,
    { reuse: null },
    { releaseId: "a".repeat(64) },
  );
  assert.strictEqual(report.rendering, rendering);
  assert.throws(
    () => context.verifyPageOwnedRendering({
      rendering: { ...report.rendering, backend: "unavailable" },
    }, state),
    /page-owned renderer evidence is invalid/,
  );
  assert.throws(
    () => context.verifyPageOwnedRendering({ rendering: null }, state),
    /page-owned renderer evidence is invalid/,
  );
  for (const backend of [null, "unavailable"]) {
    const backendState = {
      ...state,
      dataset: backend === null ? {} : { renderer: backend },
    };
    assert.throws(
      () => context.verifyPageOwnedRendering({
        rendering: { backend },
      }, backendState),
      /page-owned renderer evidence is invalid/,
    );
  }

  const workerFailure = {
    status: "stopped",
    stage: "worker",
    error: "disc read failed",
    rendering: { backend: null, error: "secondary renderer detail" },
  };
  const unavailableState = { ...state, dataset: {} };
  assert.doesNotThrow(() => context.verifyPageOwnedRendering(workerFailure, unavailableState));
  context.attachHeadlessCapture(
    { exceptions: [] },
    unavailableState,
    workerFailure,
    { reuse: null },
    { releaseId: "a".repeat(64) },
  );
  assert.equal(context.terminalReportFailure(workerFailure).message, "disc read failed");
  assert.equal("metrics" in workerFailure.rendering, false);
  assert.equal("temporalSelectedXfb" in workerFailure.rendering, false);

  const rendererFailure = {
    status: "paused",
    rendering: { backend: "unavailable", error: "device lost" },
  };
  const rendererFailureState = { ...state, dataset: { renderer: "unavailable" } };
  assert.doesNotThrow(() => context.verifyPageOwnedRendering(
    rendererFailure,
    rendererFailureState,
  ));
  assert.equal(context.terminalReportFailure(rendererFailure).message, "device lost");

  assert.equal(context.terminalReportFailure({
    status: "stopped",
    stage: "worker",
    rendering: { backend: null },
  }).message, "browser stopped at worker");
  assert.equal(context.terminalReportFailure({
    status: "paused",
    error: "top-level failure",
    rendering: { backend: "wgpu-webgpu" },
  }).message, "top-level failure");
});

test("terminal worker and renderer failures persist before becoming nonzero", async () => {
  const persisted = [];
  const context = vm.createContext({
    Error,
    JSON,
    async persist(output, report) {
      persisted.push({ output, report });
    },
  });
  vm.runInContext([
    extractFunction("terminalReportFailure"),
    extractFunction("persistTerminalReportFailure"),
  ].join("\n\n"), context);
  const failures = [
    {
      status: "stopped",
      stage: "worker",
      error: "guest worker crashed",
      rendering: { backend: null, error: "secondary detail" },
      expected: "guest worker crashed",
    },
    {
      status: "paused",
      stage: "scenario-complete",
      rendering: { backend: "wgpu-webgpu", error: "readback device lost" },
      expected: "readback device lost",
    },
  ];
  for (const failure of failures) {
    const { expected, ...report } = failure;
    await assert.rejects(
      context.persistTerminalReportFailure("capture.json", report),
      error => error.name === "BrowserTerminalReportError" && error.message === expected,
    );
    assert.strictEqual(persisted.at(-1).report, report);
  }
  assert.equal(persisted.length, 2);
  assert.equal(
    source.match(/await persistTerminalReportFailure\(options\.output, report\)/g)?.length,
    2,
  );
  const terminalCheck = source.indexOf(
    "await persistTerminalReportFailure(options.output, report)",
  );
  assert.ok(
    terminalCheck < source.indexOf("verifyCompletedRunEvidence(report, options)", terminalCheck),
  );
  assert.match(
    source,
    /main\(\)\.catch\(error => \{[\s\S]*process\.exitCode = 1;/,
  );
});

test("headless scenarios are selected before a fresh worker starts", () => {
  assert.match(source, /case "--scenario":/);
  assert.match(source, /--scenario cannot start inside a reused worker/);
  assert.match(source, /--scenario cannot be combined with --pulse/);
  assert.match(source, /select scenarios with --scenario, not the --url query/);
  assert.match(
    source,
    /url\.searchParams\.set\("scenario", options\.scenario\)/,
  );
  assert.match(source, /url\.searchParams\.set\("headlessRun", headlessRunId\)/);
  assert.match(
    source,
    /Page\.navigate", \{ url: runUrl \}/,
  );
  assert.match(source, /Page\.navigate did not create a fresh document loader/);
  const completed = extractFunction("verifyCompletedRunEvidence");
  assert.match(completed, /verifyScenarioReport\(report, options\)/);
  assert.match(completed, /attachScenarioGameplayTranscript\(report, options\)/);
  assert.match(completed, /verifyScenarioRenderingBackend\(report, options\)/);
  assert.match(completed, /verifyScenarioSelectedXfb\(report, options\)/);
  assert.match(completed, /verifyScenarioPresentedSurfaces\(report, options\)/);
  assert.match(completed, /verifyCompositorCaptureReport\(report, options\)/);
  assert.match(
    source,
    /await persist\(options\.output, report\);\s*if \(scenarioError !== null\) throw scenarioError/,
  );
});

test("completed-run evidence validators fail independently and aggregate", () => {
  const calls = [];
  const context = vm.createContext({
    AggregateError,
    Error,
    aggregateVerificationFailure: undefined,
    attachScenarioGameplayTranscript() { calls.push("transcript"); },
    verifyCompositorCaptureReport(report) {
      calls.push("compositor");
      report.headlessCapture.compositor.oracle = { derived: true };
      throw new Error("compositor failed");
    },
    verifyScenarioPresentedSurfaces() {
      calls.push("surface");
      throw new Error("surface failed");
    },
    verifyScenarioRenderingBackend() {
      calls.push("backend");
      throw new Error("backend failed");
    },
    verifyScenarioReport() { calls.push("scenario"); },
    verifyScenarioSelectedXfb() {
      calls.push("selected");
      throw new Error("selected failed");
    },
    verifyScenarioSustainedPlay() { calls.push("sustained"); },
  });
  vm.runInContext([
    extractFunction("collectVerificationFailures"),
    extractFunction("aggregateVerificationFailure"),
    extractFunction("verifyCompletedRunEvidence"),
  ].join("\n\n"), context);
  const report = { headlessCapture: { compositor: { oracle: null } } };
  const failure = context.verifyCompletedRunEvidence(report, {
    compositorCapture: true,
    scenario: "smb-ready-play",
  });
  assert.equal(failure.name, "BrowserEvidenceValidationError");
  assert.equal(failure.errors.length, 4);
  assert.deepEqual(calls, [
    "scenario",
    "transcript",
    "backend",
    "selected",
    "surface",
    "sustained",
    "compositor",
  ]);
  assert.deepEqual(report.headlessCapture.compositor.oracle, { derived: true });
});

test("fresh headless runs carry the requested render cadence into worker startup", () => {
  assert.match(
    source,
    /if \(options\.renderEvery !== null\) \{\s*url\.searchParams\.set\("renderEvery", String\(options\.renderEvery\)\);\s*\}/,
  );
  assert.match(
    source,
    /runUrl = configuredRunUrl\(options,[\s\S]*?Page\.navigate/,
  );
});

test("SMB compositor capture is strict opt-in on a fresh pinned disc run", () => {
  assert.match(
    source,
    /from "\.\/browser_boot_headless_compositor\.mjs"/,
  );
  assert.match(source, /from "\.\/browser_boot_headless_compositor_oracle\.mjs"/);
  assert.doesNotMatch(source, /browser_boot_compositor_png\.mjs/);
  assert.match(source, /case "--capture-compositor":/);
  assert.match(source, /--capture-compositor cannot be combined with --reuse/);
  assert.match(source, /--capture-compositor requires --scenario smb-ready-play/);
  assert.match(
    source,
    /--capture-compositor requires both --expect-commit and --expect-release-id/,
  );
  assert.match(
    source,
    /url\.searchParams\.set\("compositorCapture", "1"\)/,
  );
  assert.match(
    source,
    /select compositor capture with --capture-compositor, not the --url query/,
  );
  const main = extractFunction("main");
  assert.ok(
    main.indexOf("await prepareCompositorCapture(session")
      < main.indexOf("await attachDiscAfterFreshNavigation(session"),
  );
  assert.ok(
    main.indexOf("state.compositorPending !== null")
      < main.indexOf("const report = parseReport(state.result)"),
  );
  assert.doesNotMatch(source, /headlessCapture\.checkpoint\.compositor/);

  const context = vm.createContext({
    COMPOSITOR_CAPTURE_MAX_POLL_MS: 1_000,
    Error,
    Number,
    Set,
    URL,
    resolveDiscPath(path) {
      return `/resolved/${path}`;
    },
  });
  vm.runInContext([
    extractFunction("parseArguments"),
    extractFunction("configuredRunUrl"),
  ].join("\n\n"), context);
  const options = context.parseArguments([
    "--url",
    "https://gekko.free/assets/frontend.html",
    "--capture-compositor",
    "--disc",
    "smb.ciso",
    "--scenario",
    "smb-ready-play",
    "--expect-commit",
    "1".repeat(40),
    "--expect-release-id",
    "2".repeat(64),
    "--poll-ms",
    "60000",
  ]);
  assert.equal(options.compositorCapture, true);
  assert.equal(options.pollMs, 1_000);
  assert.equal(options.disc, "/resolved/smb.ciso");
  const runUrl = new URL(context.configuredRunUrl(options, "run-1"));
  assert.equal(runUrl.searchParams.get("compositorCapture"), "1");
  assert.equal(runUrl.searchParams.get("scenario"), "smb-ready-play");
  assert.equal(runUrl.searchParams.get("headlessRun"), "run-1");

  assert.throws(
    () => context.parseArguments([
      "--url",
      "https://gekko.free/assets/frontend.html",
      "--capture-compositor",
      "--disc",
      "smb.ciso",
      "--scenario",
      "smb-ready-play",
      "--expect-commit",
      "1".repeat(40),
    ]),
    /requires both --expect-commit and --expect-release-id/,
  );
  assert.throws(
    () => context.parseArguments([
      "--url",
      "https://gekko.free/assets/frontend.html?compositorCapture=1",
    ]),
    /not the --url query/,
  );
});

test("compositor viewport commands bracket fresh navigation", () => {
  const main = extractFunction("main");
  const configure = main.indexOf("await configureCompositorViewport(session)");
  const navigate = main.indexOf('session.send("Page.navigate"');
  assert.notEqual(configure, -1);
  assert.ok(configure < navigate);
  assert.match(
    main,
    /finally \{[\s\S]*clearCompositorViewport\(session\)[\s\S]*session\.close\(\)/,
  );
  const snapshot = main.indexOf('session.evaluate("globalThis.lazuliCycleRunner.snapshot()")');
  const timeoutCapture = main.lastIndexOf("await capturePendingCompositorFrame(", snapshot);
  assert.notEqual(timeoutCapture, -1);
  assert.ok(timeoutCapture < snapshot);
  assert.equal(main.match(/await capturePendingCompositorFrame\(/g)?.length, 2);
});

test("headless report capture rejects a stale document and loader", () => {
  const context = vm.createContext({});
  vm.runInContext(extractFunction("isExpectedNavigation"), context);
  const state = { url: "http://127.0.0.1:8766/?headlessRun=new" };
  assert.equal(context.isExpectedNavigation(
    state,
    state.url,
    "loader-new",
    "loader-new",
  ), true);
  assert.equal(context.isExpectedNavigation(
    { url: "http://127.0.0.1:8766/?headlessRun=old" },
    state.url,
    "loader-new",
    "loader-new",
  ), false);
  assert.equal(context.isExpectedNavigation(
    state,
    state.url,
    "loader-new",
    "loader-old",
  ), false);
});

test("headless scenario captures accept only their matching terminal report", () => {
  const context = vm.createContext({ Error, JSON });
  vm.runInContext(extractFunction("verifyScenarioReport"), context);
  const options = { scenario: "smb-ready-play" };
  const complete = {
    status: "paused",
    stage: "scenario-complete",
    scenario: {
      id: "smb-ready-play",
      status: "complete",
      failure: null,
    },
  };
  assert.doesNotThrow(() => context.verifyScenarioReport(complete, options));
  assert.throws(
    () => context.verifyScenarioReport({
      ...complete,
      status: "stopped",
      stage: "scenario-failed",
      scenario: {
        ...complete.scenario,
        status: "failed",
        failure: { reason: "missed title gate" },
      },
    }, options),
    /controller scenario did not complete/,
  );
  assert.throws(
    () => context.verifyScenarioReport({ ...complete, scenario: null }, options),
    /controller scenario did not complete/,
  );
});

test("SMB headless captures delegate temporal XFB verification", () => {
  assert.match(
    source,
    /import \{ verifySmbTemporalSelectedXfb \} from "\.\/browser_boot_temporal_xfb\.mjs"/,
  );
  assert.match(
    source,
    /import \{ verifySmbTemporalPresentedSurfaces \} from "\.\/browser_boot_temporal_surface\.mjs"/,
  );
  assert.match(
    source,
    /import \{ verifySmbSustainedPlay \} from "\.\/browser_boot_smb_sustained_play\.mjs"/,
  );
  assert.match(
    source,
    /verifySmbTemporalSelectedXfb\(rendering\.temporalSelectedXfb\)/,
  );
  assert.match(
    source,
    /verifySmbTemporalPresentedSurfaces\(rendering\.temporalSelectedXfb\)/,
  );
  const completed = extractFunction("verifyCompletedRunEvidence");
  assert.match(completed, /verifyScenarioSelectedXfb\(report, options\)/);
  assert.match(completed, /verifyScenarioPresentedSurfaces\(report, options\)/);
  assert.match(completed, /verifyScenarioSustainedPlay\(report, options\)/);
  assert.doesNotMatch(source, /distinctGenerations >= 2/);
  assert.doesNotMatch(source, /selected\.rgb\.unique > 1/);
  assert.doesNotMatch(source, /selected\.rgb\.other > 0/);
});

test("SMB headless captures attach the canonical ready-play gameplay transcript", () => {
  assert.match(
    source,
    /import \{\s*deriveSmbReadyPlayGameplayTranscript,?\s*\} from "\.\/browser_boot_gameplay_transcript\.mjs"/,
  );
  const marker = Symbol("gameplay-transcript");
  const sources = [];
  const context = vm.createContext({
    deriveSmbReadyPlayGameplayTranscript(report) {
      assert.equal(report.status, "paused");
      sources.push(report);
      return marker;
    },
  });
  vm.runInContext(extractFunction("attachScenarioGameplayTranscript"), context);
  const unrelated = { status: "paused" };
  context.attachScenarioGameplayTranscript(unrelated, { scenario: "warioware-ready" });
  assert.equal(Object.hasOwn(unrelated, "gameplayTranscript"), false);

  const ready = { status: "paused" };
  context.attachScenarioGameplayTranscript(ready, { scenario: "smb-ready-play" });
  assert.strictEqual(ready.gameplayTranscript, marker);
  assert.strictEqual(sources.at(-1), ready);

  const anchor = { status: "paused" };
  const sustained = { status: "paused", sustainedPlay: { readyPlayAnchor: anchor } };
  context.attachScenarioGameplayTranscript(sustained, {
    scenario: "smb-sustained-play",
  });
  assert.strictEqual(sustained.gameplayTranscript, marker);
  assert.strictEqual(sources.at(-1), anchor);
});
