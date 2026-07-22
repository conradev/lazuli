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
    /verifyExpectedCheckpoint\(report, options, expectedManifest\);\s*await persist/,
  );
  assert.equal(
    source.match(/^\s+attachHeadlessCapture\(session, state, report,/gm)?.length,
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
    source.match(/^\s+attachHeadlessCapture\(session, state, report,/gm)?.length,
    2,
  );
  assert.equal(source.match(/\}, discImage\);/g)?.length, 2);

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
  );
  assert.equal(Object.hasOwn(reportWithoutDisc.headlessCapture, "discImage"), false);
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
  context.attachHeadlessCapture({ exceptions: [] }, state, report, { reuse: null });
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
  assert.ok(terminalCheck < source.indexOf("verifyScenarioReport(report, options)", terminalCheck));
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
  assert.equal(source.match(/verifyScenarioReport\(report, options\);/g)?.length, 1);
  assert.equal(
    source.match(/attachScenarioGameplayTranscript\(report, options\);/g)?.length,
    1,
  );
  assert.equal(source.match(/verifyScenarioRendering\(report, options\);/g)?.length, 1);
  assert.match(
    source,
    /verifyScenarioReport\(report, options\);\s*attachScenarioGameplayTranscript\(report, options\);\s*verifyScenarioRendering\(report, options\);/,
  );
  assert.match(
    source,
    /await persist\(options\.output, report\);\s*if \(scenarioError !== null\) throw scenarioError/,
  );
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
    /verifySmbTemporalSelectedXfb\(rendering\.temporalSelectedXfb\)/,
  );
  assert.match(
    source,
    /verifySmbTemporalSelectedXfb\(rendering\.temporalSelectedXfb\);\s*verifySmbTemporalPresentedSurfaces\(rendering\.temporalSelectedXfb\)/,
  );
  assert.doesNotMatch(source, /distinctGenerations >= 2/);
  assert.doesNotMatch(source, /selected\.rgb\.unique > 1/);
  assert.doesNotMatch(source, /selected\.rgb\.other > 0/);
});

test("SMB headless captures attach a canonical gameplay transcript", () => {
  assert.match(
    source,
    /import \{\s*deriveSmbReadyPlayGameplayTranscript,?\s*\} from "\.\/browser_boot_gameplay_transcript\.mjs"/,
  );
  const marker = Symbol("gameplay-transcript");
  const context = vm.createContext({
    deriveSmbReadyPlayGameplayTranscript(report) {
      assert.equal(report.status, "paused");
      return marker;
    },
  });
  vm.runInContext(extractFunction("attachScenarioGameplayTranscript"), context);
  const report = { status: "paused" };
  context.attachScenarioGameplayTranscript(report, { scenario: "warioware-ready" });
  assert.equal(Object.hasOwn(report, "gameplayTranscript"), false);
  context.attachScenarioGameplayTranscript(report, { scenario: "smb-ready-play" });
  assert.strictEqual(report.gameplayTranscript, marker);
});
