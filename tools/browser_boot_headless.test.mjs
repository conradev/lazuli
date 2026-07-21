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
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
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
    source.match(/await attachHeadlessCapture\(session, state, report,/g)?.length,
    2,
  );
  assert.match(
    source,
    /report\.rendering = await captureRendering\(session, state\);[\s\S]*?report\.headlessCapture =/,
  );
  assert.match(
    source,
    /typeof diagnostics\?\.captureTerminal !== "function"[\s\S]*?return await diagnostics\.captureTerminal\(\);/,
  );
  assert.equal(
    source.match(/headlessRunToReportMs: reportDetectedAt - runStartedAt/g)?.length,
    2,
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
  assert.match(
    source,
    /await persist\(options\.output, report\);\s*if \(scenarioError !== null\) throw scenarioError/,
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
