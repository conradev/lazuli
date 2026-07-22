#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { rename, writeFile } from "node:fs/promises";

import { validateRelease } from "../web/release.mjs";

import {
  readCheckpointManifest,
  verifyCheckpointReport,
} from "./browser_boot_checkpoint.mjs";
import {
  attachDiscAfterFreshNavigation,
  resolveDiscPath,
} from "./browser_boot_headless_disc.mjs";
import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";
import {
  DevToolsSession,
  observeHeadlessPage,
} from "./browser_boot_headless_cdp.mjs";
import {
  deriveSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import { verifySmbTemporalPresentedSurfaces } from "./browser_boot_temporal_surface.mjs";
import { verifySmbTemporalSelectedXfb } from "./browser_boot_temporal_xfb.mjs";

function parseArguments(argv) {
  const options = {
    endpoint: "http://127.0.0.1:9222",
    disc: null,
    expect: null,
    expectCommit: null,
    expectReleaseId: null,
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
      case "--disc":
        options.disc = value();
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
      case "--expect-commit":
        options.expectCommit = value();
        break;
      case "--expect-release-id":
        options.expectReleaseId = value();
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
  if (options.expectCommit !== null && !/^[0-9a-f]{40}$/.test(options.expectCommit)) {
    throw new Error("--expect-commit must be 40 lowercase hexadecimal characters");
  }
  if (options.expectReleaseId !== null && !/^[0-9a-f]{64}$/.test(options.expectReleaseId)) {
    throw new Error("--expect-release-id must be 64 lowercase hexadecimal characters");
  }
  if (options.url !== null && new URL(options.url).searchParams.has("scenario")) {
    throw new Error("select scenarios with --scenario, not the --url query");
  }
  if (options.reuse && options.disc !== null) {
    throw new Error("--disc cannot be combined with --reuse");
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
  if (options.disc !== null) options.disc = resolveDiscPath(options.disc);
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
  if (options.renderEvery !== null) {
    url.searchParams.set("renderEvery", String(options.renderEvery));
  }
  url.searchParams.set("headlessRun", headlessRunId);
  return url.href;
}

function isExpectedNavigation(state, runUrl, navigationLoaderId, frameLoaderId) {
  return state.url === runUrl && frameLoaderId === navigationLoaderId;
}

const ACTIVE_RELEASE_OBSERVATION = `(async () => {
  const controlled = typeof navigator.serviceWorker === "object"
    && navigator.serviceWorker.controller !== null;
  try {
    const response = await fetch("/.gekko/active-release", { cache: "no-store" });
    return {
      body: await response.text(),
      controlled,
      error: null,
      pathname: location.pathname,
      status: response.status,
    };
  } catch (error) {
    return {
      body: null,
      controlled,
      error: String(error),
      pathname: location.pathname,
      status: null,
    };
  }
})()`;

function compactReleaseAsset(asset) {
  return { url: asset.url, sha256: asset.sha256, bytes: asset.bytes };
}

function compactActiveRelease(release) {
  return {
    schema: release.schema,
    releaseId: release.releaseId,
    commit: release.source.commit,
    frontend: compactReleaseAsset(release.frontend),
    renderer: {
      javascript: compactReleaseAsset(release.renderer.javascript),
      wasm: compactReleaseAsset(release.renderer.wasm),
    },
    backend: {
      url: release.backend.url,
      sha256: release.backend.sha256,
      bytes: release.backend.bytes,
    },
  };
}

async function validateObservedActiveRelease(observation, options, expectedIdentity = null) {
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("active release observation is invalid");
  }
  if (!observation.controlled) {
    throw new Error("headless page has no service-worker controller");
  }
  if (observation.error !== null) {
    throw new Error(`active release observation failed: ${observation.error}`);
  }
  if (observation.status !== 200) {
    throw new Error(`active release observer returned HTTP ${observation.status}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(observation.body);
  } catch {
    throw new Error("active release observer returned invalid JSON");
  }
  await validateRelease(manifest);
  const identity = compactActiveRelease(manifest);
  if (observation.pathname !== identity.frontend.url) {
    throw new Error(
      `headless page is not the active immutable frontend: ${JSON.stringify({
        active: identity.frontend.url,
        loaded: observation.pathname,
      })}`,
    );
  }
  if (options.expectCommit !== null && identity.commit !== options.expectCommit) {
    throw new Error(
      `active release commit ${identity.commit} does not match --expect-commit ${options.expectCommit}`,
    );
  }
  if (options.expectReleaseId !== null && identity.releaseId !== options.expectReleaseId) {
    throw new Error(
      `active release ID ${identity.releaseId} does not match --expect-release-id ${options.expectReleaseId}`,
    );
  }
  if (
    expectedIdentity !== null
    && JSON.stringify(identity) !== JSON.stringify(expectedIdentity)
  ) {
    throw new Error(
      `active release changed during headless capture: ${JSON.stringify({
        before: expectedIdentity,
        terminal: identity,
      })}`,
    );
  }
  return identity;
}

async function observeActiveRelease(session, options, expectedIdentity = null) {
  const observation = await session.evaluate(ACTIVE_RELEASE_OBSERVATION);
  return validateObservedActiveRelease(observation, options, expectedIdentity);
}

function releasePinRequested(options) {
  return options.expectCommit !== null || options.expectReleaseId !== null;
}

async function observeActiveReleaseIfPinned(
  session,
  options,
  expectedIdentity = null,
) {
  if (!releasePinRequested(options)) return null;
  return observeActiveRelease(session, options, expectedIdentity);
}

async function observeActiveReleaseBeforeActivation(
  session,
  options,
  deadline,
  runUrl,
  navigationLoaderId,
) {
  if (!releasePinRequested(options)) return null;
  while (Date.now() < deadline) {
    const observation = await observeHeadlessPage(session, {
      deadline,
      includeFrameTree: runUrl !== null,
    }, { pageState });
    const state = observation.state;
    if (
      runUrl !== null
      && !isExpectedNavigation(state, runUrl, navigationLoaderId, observation.frameLoaderId)
    ) {
      await delay(options.pollMs);
      continue;
    }
    if (state.readyState !== "interactive" && state.readyState !== "complete") {
      await delay(options.pollMs);
      continue;
    }
    return observeActiveRelease(session, options);
  }
  throw new Error("headless page was not ready for active release observation");
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

function attachHeadlessCapture(
  session,
  state,
  report,
  details,
  release,
  discImage = null,
) {
  verifyPageOwnedRendering(report, state);
  report.headlessCapture = {
    dataset: state.dataset,
    devtoolsExceptions: session.exceptions,
    pageTitle: state.title,
    url: state.url,
    ...details,
  };
  if (release !== null) report.headlessCapture.release = release;
  if (discImage !== null) report.headlessCapture.discImage = discImage;
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

function attachScenarioGameplayTranscript(report, options) {
  if (options.scenario !== "smb-ready-play") return;
  report.gameplayTranscript = deriveSmbReadyPlayGameplayTranscript(report);
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
  verifySmbTemporalPresentedSurfaces(rendering.temporalSelectedXfb);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const discImage = options.disc === null
    ? null
    : await identifyLocalDiscImage(options.disc);
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
    let activeRelease;
    if (options.reuse) {
      activeRelease = await observeActiveReleaseBeforeActivation(
        session,
        options,
        deadline,
        null,
        null,
      );
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
      activeRelease = await observeActiveReleaseBeforeActivation(
        session,
        options,
        deadline,
        runUrl,
        navigationLoaderId,
      );
    }

    if (options.disc !== null) {
      await attachDiscAfterFreshNavigation(session, {
        deadline,
        discPath: options.disc,
        navigationLoaderId,
        pollMs: options.pollMs,
        runUrl,
      }, {
        delay,
        isExpectedNavigation,
        observePage: observeHeadlessPage,
        pageState,
      });
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
        const terminalRelease = await observeActiveReleaseIfPinned(
          session,
          options,
          activeRelease,
        );
        attachHeadlessCapture(session, state, report, {
          performance: {
            headlessRunToReportMs: reportDetectedAt - runStartedAt,
          },
          reuse: reuseCapture,
        }, terminalRelease, discImage);
        await persistTerminalReportFailure(options.output, report);
        let scenarioError = null;
        try {
          verifyScenarioReport(report, options);
          attachScenarioGameplayTranscript(report, options);
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
          const terminalRelease = await observeActiveReleaseIfPinned(
            session,
            options,
            activeRelease,
          );
          attachHeadlessCapture(session, state, report, {
            performance: {
              headlessRunToReportMs: reportDetectedAt - runStartedAt,
            },
            reuse: reuseCapture,
            timedOut: true,
          }, terminalRelease, discImage);
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
