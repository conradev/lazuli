#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { rename, writeFile } from "node:fs/promises";

import {
  readCheckpointManifest,
  verifyCheckpointReport,
} from "./browser_boot_checkpoint.mjs";
import {
  DevToolsSession,
  observeHeadlessPage,
} from "./browser_boot_headless_cdp.mjs";
import { verifySmbTemporalSelectedXfb } from "./browser_boot_temporal_xfb.mjs";

function parseArguments(argv) {
  const options = {
    endpoint: "http://127.0.0.1:9222",
    expect: null,
    extendCycles: null,
    extendDispatches: undefined,
    pollMs: 250,
    pulseMs: 500,
    pulses: [],
    renderEvery: null,
    reuse: false,
    scenario: null,
    timeoutMs: 300_000,
    output: null,
    url: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value after ${argument}`);
      return argv[index];
    };
    switch (argument) {
      case "--endpoint":
        options.endpoint = value();
        break;
      case "--extend-cycles":
        options.extendCycles = Number(value());
        break;
      case "--extend-dispatches":
        options.extendDispatches = Number(value());
        break;
      case "--expect":
        options.expect = value();
        break;
      case "--output":
        options.output = value();
        break;
      case "--poll-ms":
        options.pollMs = Number(value());
        break;
      case "--pulse": {
        const [name, delayText] = value().split(":", 2);
        const delayMs = delayText === undefined ? 0 : Number(delayText);
        options.pulses.push({ delayMs, name });
        break;
      }
      case "--pulse-ms":
        options.pulseMs = Number(value());
        break;
      case "--reuse":
        options.reuse = true;
        break;
      case "--scenario":
        options.scenario = value();
        break;
      case "--render-every":
        options.renderEvery = Number(value());
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(value());
        break;
      case "--url":
        options.url = value();
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  if (!options.reuse && options.url === null) throw new Error("--url is required without --reuse");
  if (options.url !== null && new URL(options.url).searchParams.has("scenario")) {
    throw new Error("select scenarios with --scenario, not the --url query");
  }
  if (options.reuse && options.extendCycles === null) {
    throw new Error("--reuse requires --extend-cycles");
  }
  if (options.reuse && options.scenario !== null) {
    throw new Error("--scenario cannot start inside a reused worker");
  }
  if (options.scenario !== null && options.pulses.length !== 0) {
    throw new Error("--scenario cannot be combined with --pulse");
  }
  if (
    options.scenario !== null
    && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.scenario)
  ) {
    throw new Error("--scenario must be lowercase kebab-case");
  }
  if (
    options.extendCycles !== null
    && (!Number.isInteger(options.extendCycles) || options.extendCycles <= 0)
  ) {
    throw new Error("--extend-cycles must be a positive integer");
  }
  if (
    options.extendDispatches !== undefined
    && (!Number.isInteger(options.extendDispatches) || options.extendDispatches <= 0)
  ) {
    throw new Error("--extend-dispatches must be a positive integer");
  }
  if (!Number.isInteger(options.pulseMs) || options.pulseMs <= 0) {
    throw new Error("--pulse-ms must be a positive integer");
  }
  if (
    options.renderEvery !== null
    && (!Number.isInteger(options.renderEvery)
      || options.renderEvery < 1
      || options.renderEvery > 1000)
  ) {
    throw new Error("--render-every must be an integer from 1 through 1000");
  }
  const validPulses = new Set(["a", "b", "down", "left", "right", "start", "up"]);
  for (const pulse of options.pulses) {
    if (!validPulses.has(pulse.name)) {
      throw new Error(`unsupported controller pulse ${pulse.name}`);
    }
    if (!Number.isInteger(pulse.delayMs) || pulse.delayMs < 0) {
      throw new Error(`controller pulse delay must be a non-negative integer: ${pulse.delayMs}`);
    }
  }
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10) {
    throw new Error("--poll-ms must be an integer >= 10");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < options.pollMs) {
    throw new Error("--timeout-ms must be an integer >= --poll-ms");
  }
  return options;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function configuredRunUrl(options, headlessRunId) {
  const url = new URL(options.url);
  if (options.scenario !== null) url.searchParams.set("scenario", options.scenario);
  url.searchParams.set("headlessRun", headlessRunId);
  return url.href;
}

function isExpectedNavigation(state, runUrl, navigationLoaderId, frameLoaderId) {
  return state.url === runUrl && frameLoaderId === navigationLoaderId;
}

async function pageTarget(endpoint) {
  const response = await fetch(new URL("/json/list", endpoint));
  if (!response.ok) throw new Error(`Chrome target list returned HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
  if (page === undefined) throw new Error("Chrome exposes no debuggable page target");
  return page;
}

async function pageState(session) {
  return session.evaluate(`(() => {
    const result = document.querySelector("#result")?.textContent?.trim() ?? "";
    return {
      dataset: Object.fromEntries(Object.entries(document.body?.dataset ?? {})),
      readyState: document.readyState,
      result,
      runnerAvailable: typeof globalThis.lazuliCycleRunner === "object",
      runnerStatus: document.querySelector("#runner-status")?.textContent ?? "",
      title: document.title,
      url: location.href,
    };
  })()`);
}

async function waitForRunner(session, deadline, pollMs) {
  let state = null;
  while (Date.now() < deadline) {
    state = (await observeHeadlessPage(session, {
      deadline,
      includeFrameTree: false,
    }, { pageState })).state;
    if (state.runnerAvailable) return state;
    await delay(pollMs);
  }
  throw new Error(`existing page has no cycle runner: ${JSON.stringify(state)}`);
}

async function extendExistingRun(session, options, deadline) {
  const state = await waitForRunner(session, deadline, options.pollMs);
  const previous = parseReport(state.result);
  const action = {
    extendCycles: options.extendCycles,
    extendDispatches: options.extendDispatches,
    pulseMs: options.pulseMs,
    pulses: options.pulses,
    renderEvery: options.renderEvery,
  };
  await session.evaluate(`(() => {
    const action = ${JSON.stringify(action)};
    const method = {
      a: "pulseA",
      b: "pulseB",
      down: "pulseDown",
      left: "pulseLeft",
      right: "pulseRight",
      start: "pulseStart",
      up: "pulseUp",
    };
    const output = document.querySelector("#result");
    if (output !== null) output.textContent = "";
    if (action.renderEvery !== null) {
      globalThis.lazuliCycleRunner.setRenderEvery(action.renderEvery);
    }
    for (const pulse of action.pulses) {
      setTimeout(() => {
        globalThis.lazuliController[method[pulse.name]](action.pulseMs);
      }, pulse.delayMs);
    }
    globalThis.lazuliCycleRunner.extendCycles(
      action.extendCycles,
      action.extendDispatches,
    );
  })()`);
  return {
    action,
    previous: previous === null ? null : {
      cycles: previous.cycles,
      dispatches: previous.dispatches,
      instructions: previous.instructions,
      pc: previous.pc,
      stage: previous.stage,
      status: previous.status,
    },
    url: state.url,
  };
}

async function persist(output, report) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}

function parseReport(text) {
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function terminalReportFailure(report) {
  const rootError = report?.error ?? null;
  const rendererError = report?.rendering?.error ?? null;
  if (report?.status !== "stopped" && rootError === null && rendererError === null) {
    return null;
  }
  const detail = rootError ?? rendererError ?? `browser stopped at ${report?.stage ?? "unknown"}`;
  const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  error.name = "BrowserTerminalReportError";
  return error;
}

function verifyPageOwnedRendering(report, state) {
  const rendering = report?.rendering;
  const datasetBackend = state.dataset.renderer ?? null;
  const terminalFailure = terminalReportFailure(report);
  if (
    rendering === null
    || typeof rendering !== "object"
    || Array.isArray(rendering)
    || rendering.backend !== datasetBackend
    || (terminalFailure === null
      && (datasetBackend !== "wgpu-webgpu" || rendering.backend !== "wgpu-webgpu"))
  ) {
    throw new Error(`page-owned renderer evidence is invalid: ${JSON.stringify({
      datasetBackend,
      rendering: rendering ?? null,
    })}`);
  }
}

function attachHeadlessCapture(session, state, report, details) {
  verifyPageOwnedRendering(report, state);
  report.headlessCapture = {
    dataset: state.dataset,
    devtoolsExceptions: session.exceptions,
    pageTitle: state.title,
    url: state.url,
    ...details,
  };
}

async function persistTerminalReportFailure(output, report) {
  const failure = terminalReportFailure(report);
  if (failure === null) return false;
  await persist(output, report);
  throw failure;
}

function verifyExpectedCheckpoint(report, options, manifest) {
  if (manifest === null) return;
  const checkpoint = verifyCheckpointReport(report, manifest);
  report.headlessCapture.checkpoint = {
    expectedManifest: options.expect,
    sha256: checkpoint.sha256,
  };
}

function verifyScenarioReport(report, options) {
  if (options.scenario === null) return;
  const scenario = report.scenario;
  if (
    report.status !== "paused"
    || report.stage !== "scenario-complete"
    || scenario === null
    || typeof scenario !== "object"
    || scenario.id !== options.scenario
    || scenario.status !== "complete"
    || scenario.failure !== null
  ) {
    throw new Error(
      `controller scenario did not complete: ${JSON.stringify({
        expected: options.scenario,
        reportStatus: report.status ?? null,
        reportStage: report.stage ?? null,
        scenario: scenario ?? null,
      })}`
    );
  }
}

function verifyScenarioRendering(report, options) {
  if (options.scenario !== "smb-ready-play") return;
  const rendering = report.rendering;
  if (rendering?.backend !== "wgpu-webgpu") {
    throw new Error(
      `SMB temporal XFB requires wgpu-webgpu, got ${JSON.stringify(rendering?.backend ?? null)}`,
    );
  }
  verifySmbTemporalSelectedXfb(rendering.temporalSelectedXfb);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const expectedManifest = options.expect === null
    ? null
    : await readCheckpointManifest(options.expect);
  const target = await pageTarget(options.endpoint);
  const session = new DevToolsSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    const runStartedAt = Date.now();
    const deadline = runStartedAt + options.timeoutMs;
    let reuseCapture = null;
    let runUrl = null;
    let navigationLoaderId = null;
    if (options.reuse) {
      reuseCapture = await extendExistingRun(session, options, deadline);
    } else {
      runUrl = configuredRunUrl(options, `${process.pid}-${runStartedAt}`);
      const navigation = await session.send("Page.navigate", { url: runUrl });
      if (navigation.errorText !== undefined) {
        throw new Error(`Page.navigate failed: ${navigation.errorText}`);
      }
      if (typeof navigation.loaderId !== "string" || navigation.loaderId.length === 0) {
        throw new Error("Page.navigate did not create a fresh document loader");
      }
      navigationLoaderId = navigation.loaderId;
    }

    let state = null;
    while (Date.now() < deadline) {
      const observation = await observeHeadlessPage(session, {
        deadline,
        includeFrameTree: runUrl !== null,
      }, { pageState });
      state = observation.state;
      if (runUrl !== null) {
        if (!isExpectedNavigation(
          state,
          runUrl,
          navigationLoaderId,
          observation.frameLoaderId,
        )) {
          await delay(options.pollMs);
          continue;
        }
      }
      const report = parseReport(state.result);
      if (report !== null) {
        const reportDetectedAt = Date.now();
        attachHeadlessCapture(session, state, report, {
          performance: {
            headlessRunToReportMs: reportDetectedAt - runStartedAt,
          },
          reuse: reuseCapture,
        });
        await persistTerminalReportFailure(options.output, report);
        let scenarioError = null;
        try {
          verifyScenarioReport(report, options);
          verifyScenarioRendering(report, options);
        } catch (error) {
          scenarioError = error;
        }
        if (scenarioError === null) {
          verifyExpectedCheckpoint(report, options, expectedManifest);
        }
        await persist(options.output, report);
        if (scenarioError !== null) throw scenarioError;
        return;
      }
      await delay(options.pollMs);
    }

    state = (await observeHeadlessPage(session, {
      deadline,
      includeFrameTree: runUrl !== null,
    }, { pageState })).state;
    if (state.runnerAvailable) {
      await session.evaluate("globalThis.lazuliCycleRunner.snapshot()");
      const snapshotDeadline = Date.now() + 5_000;
      while (Date.now() < snapshotDeadline) {
        await delay(options.pollMs);
        state = (await observeHeadlessPage(session, {
          deadline: snapshotDeadline,
          includeFrameTree: runUrl !== null,
        }, { pageState })).state;
        const report = parseReport(state.result);
        if (report !== null) {
          const reportDetectedAt = Date.now();
          attachHeadlessCapture(session, state, report, {
            performance: {
              headlessRunToReportMs: reportDetectedAt - runStartedAt,
            },
            reuse: reuseCapture,
            timedOut: true,
          });
          await persistTerminalReportFailure(options.output, report);
          verifyExpectedCheckpoint(report, options, expectedManifest);
          await persist(options.output, report);
          process.exitCode = 124;
          return;
        }
      }
    }
    throw new Error(
      `browser boot timed out without a report: ${JSON.stringify(state)}`
    );
  } finally {
    session.close();
  }
}

main().catch(error => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
