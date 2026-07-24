#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";
import {
  deriveSmbReadyPlayGameplayTranscript,
} from "./browser_boot_gameplay_transcript.mjs";
import { DevToolsSession } from "./browser_boot_headless_cdp.mjs";
import { verifySmbSustainedPlay } from "./browser_boot_smb_sustained_play.mjs";
import {
  assignPublicDisc,
  expectedPublicFrameUrl,
  observePublicActiveRelease,
  parsePublicReport,
  publicDelay,
  publicPageTarget,
  publicReleaseState,
  waitForPublicRelease,
  waitForPublicRunner,
} from "./browser_public_cdp.mjs";

export const PUBLIC_SMB_SUSTAINED_SCHEMA = "lazuli-public-smb-sustained-v1";
export const PUBLIC_SMB_SUSTAINED_SCENARIO = "smb-sustained-play";

const IMMUTABLE_FRONTEND_PATH = /^\/assets\/frontend-[0-9a-f]{64}\.html$/;
const PRODUCTION_ORIGIN = "https://gekko.free";

function evidenceFailure(path, detail) {
  const error = new Error(`invalid public SMB sustained evidence at ${path}: ${detail}`);
  error.name = "PublicSmbSustainedEvidenceError";
  throw error;
}

function requiredObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    evidenceFailure(path, "expected an object");
  }
  return value;
}

function requiredUrl(value, path) {
  try {
    return new URL(value);
  } catch {
    evidenceFailure(path, "expected an absolute URL");
  }
}

function productionUrl(value, path) {
  const url = requiredUrl(value, path);
  if (
    url.origin !== PRODUCTION_ORIGIN
    || url.username !== ""
    || url.password !== ""
  ) {
    evidenceFailure(path, `expected exact production origin ${PRODUCTION_ORIGIN}`);
  }
  return url;
}

function exactJson(actual, expected, path, detail) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    evidenceFailure(path, detail);
  }
}

function validateReleaseIdentity(release, expected, path) {
  requiredObject(release, path);
  if (release.commit !== expected.commit) {
    evidenceFailure(`${path}.commit`, `expected ${expected.commit}`);
  }
  if (release.releaseId !== expected.releaseId) {
    evidenceFailure(`${path}.releaseId`, `expected ${expected.releaseId}`);
  }
  const frontend = requiredObject(release.frontend, `${path}.frontend`);
  if (
    typeof frontend.url !== "string"
    || !IMMUTABLE_FRONTEND_PATH.test(frontend.url)
  ) {
    evidenceFailure(`${path}.frontend.url`, "expected a content-addressed frontend path");
  }
  return release;
}

function validateDiscImage(value, path) {
  requiredObject(value, path);
  const expected = SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image;
  if (
    value.algorithm !== expected.algorithm
    || value.format !== expected.format
    || value.sha256 !== expected.sha256
  ) {
    evidenceFailure(path, `expected canonical SMB CISO ${expected.sha256}`);
  }
  return value;
}

function compactFrameIdentity(frame) {
  return {
    frameId: frame.id,
    loaderId: frame.loaderId,
    url: frame.url,
  };
}

function validateNavigationIdentity(value, {
  expectedFrameUrl,
  expectedTopLoaderId,
  publicUrl,
}, path) {
  requiredObject(value, path);
  const top = requiredObject(value.top, `${path}.top`);
  const iframe = requiredObject(value.iframe, `${path}.iframe`);
  if (
    top.loaderId !== expectedTopLoaderId
    || top.url !== publicUrl
    || typeof top.frameId !== "string"
    || top.frameId.length === 0
  ) {
    evidenceFailure(`${path}.top`, "top-level navigation loader is not pinned");
  }
  if (
    iframe.url !== expectedFrameUrl
    || typeof iframe.frameId !== "string"
    || iframe.frameId.length === 0
    || typeof iframe.loaderId !== "string"
    || iframe.loaderId.length === 0
  ) {
    evidenceFailure(`${path}.iframe`, "immutable frontend loader is not pinned");
  }
  return value;
}

export function configuredPublicSmbSustainedUrl(value) {
  const url = productionUrl(value, "--url");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    evidenceFailure("--url", "expected the exact production root without query or fragment");
  }
  url.searchParams.set("scenario", PUBLIC_SMB_SUSTAINED_SCENARIO);
  return url.href;
}

export function validatePublicSmbSustainedEnvelope(evidence) {
  requiredObject(evidence, "$");
  if (evidence.schema !== PUBLIC_SMB_SUSTAINED_SCHEMA) {
    evidenceFailure("$.schema", `expected ${PUBLIC_SMB_SUSTAINED_SCHEMA}`);
  }
  const expected = requiredObject(evidence.expected, "$.expected");
  if (!/^[0-9a-f]{40}$/.test(expected.commit ?? "")) {
    evidenceFailure("$.expected.commit", "expected a lowercase commit ID");
  }
  if (!/^[0-9a-f]{64}$/.test(expected.releaseId ?? "")) {
    evidenceFailure("$.expected.releaseId", "expected a lowercase release digest");
  }

  const publicUrl = productionUrl(evidence.publicUrl, "$.publicUrl");
  if (
    publicUrl.pathname !== "/"
    || publicUrl.hash !== ""
    || publicUrl.searchParams.size !== 1
    || publicUrl.searchParams.get("scenario") !== PUBLIC_SMB_SUSTAINED_SCENARIO
  ) {
    evidenceFailure("$.publicUrl", `expected exact ${PUBLIC_SMB_SUSTAINED_SCENARIO} route`);
  }
  const release = validateReleaseIdentity(evidence.release, expected, "$.release");
  const terminalRelease = validateReleaseIdentity(
    evidence.terminalRelease,
    expected,
    "$.terminalRelease",
  );
  exactJson(
    terminalRelease,
    release,
    "$.terminalRelease",
    "active release changed during sustained play",
  );

  const frameUrl = expectedPublicFrameUrl(publicUrl.href, release);
  const navigation = requiredObject(evidence.navigation, "$.navigation");
  if (navigation.expectedFrameUrl !== frameUrl) {
    evidenceFailure("$.navigation.expectedFrameUrl", "does not match the active release");
  }
  if (
    typeof navigation.expectedTopLoaderId !== "string"
    || navigation.expectedTopLoaderId.length === 0
  ) {
    evidenceFailure("$.navigation.expectedTopLoaderId", "expected a pinned loader ID");
  }
  const navigationExpectations = {
    expectedFrameUrl: frameUrl,
    expectedTopLoaderId: navigation.expectedTopLoaderId,
    publicUrl: publicUrl.href,
  };
  validateNavigationIdentity(navigation.before, navigationExpectations, "$.navigation.before");
  validateNavigationIdentity(navigation.after, navigationExpectations, "$.navigation.after");
  exactJson(
    navigation.after,
    navigation.before,
    "$.navigation.after",
    "top-level or immutable frontend loader changed during sustained play",
  );

  validateDiscImage(evidence.discImage, "$.discImage");
  if (!Array.isArray(evidence.devtoolsExceptions)) {
    evidenceFailure("$.devtoolsExceptions", "expected an array");
  }
  if (evidence.devtoolsExceptions.length !== 0) {
    evidenceFailure("$.devtoolsExceptions[0]", "expected no DevTools exceptions");
  }
  if (evidence.surface !== "release") {
    evidenceFailure("$.surface", "expected release");
  }
  if (evidence.frameUrl !== frameUrl) {
    evidenceFailure("$.frameUrl", "expected the active immutable frontend URL");
  }
  const dataset = requiredObject(evidence.dataset, "$.dataset");
  if (dataset.status !== "paused") {
    evidenceFailure("$.dataset.status", "expected paused scenario completion");
  }
  if (dataset.renderer !== "wgpu-webgpu") {
    evidenceFailure("$.dataset.renderer", "expected wgpu-webgpu");
  }
  return evidence;
}

export function validatePublicSmbSustainedEvidence(evidence) {
  validatePublicSmbSustainedEnvelope(evidence);
  const report = requiredObject(evidence.report, "$.report");
  const disc = requiredObject(report.disc, "$.report.disc");
  if (
    disc.identifier !== "GMBE8P"
    || disc.revision !== 0
    || disc.source?.kind !== "local-file"
  ) {
    evidenceFailure("$.report.disc", "expected local Super Monkey Ball USA Rev.00");
  }
  if (report.rendering?.backend !== "wgpu-webgpu") {
    evidenceFailure("$.report.rendering.backend", "expected wgpu-webgpu");
  }
  if (report.rendering?.error !== undefined && report.rendering.error !== null) {
    evidenceFailure("$.report.rendering.error", "expected no renderer error");
  }
  const derived = verifySmbSustainedPlay(report);
  exactJson(
    evidence.oracle,
    derived,
    "$.oracle",
    "does not match the independently derived sustained-play oracle",
  );
  return evidence;
}

export function parsePublicSmbSustainedArguments(argv) {
  const options = {
    disc: null,
    endpoint: "http://127.0.0.1:9222",
    expectCommit: null,
    expectReleaseId: null,
    output: null,
    pollMs: 100,
    timeoutMs: 3_600_000,
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
      case "--disc": options.disc = value(); break;
      case "--endpoint": options.endpoint = value(); break;
      case "--expect-commit": options.expectCommit = value(); break;
      case "--expect-release-id": options.expectReleaseId = value(); break;
      case "--output": options.output = value(); break;
      case "--poll-ms": options.pollMs = Number(value()); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--url": options.url = value(); break;
      default: throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.disc === null) throw new Error("--disc must name the local SMB CISO");
  if (options.url === null) throw new Error("--url must name the public Gekko root");
  if (!/^[0-9a-f]{40}$/.test(options.expectCommit ?? "")) {
    throw new Error("--expect-commit is required and must be a lowercase commit ID");
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectReleaseId ?? "")) {
    throw new Error("--expect-release-id is required and must be a lowercase SHA-256 digest");
  }
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10) {
    throw new Error("--poll-ms must be an integer >= 10");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < options.pollMs) {
    throw new Error("--timeout-ms must be an integer >= --poll-ms");
  }
  options.disc = resolve(options.disc);
  options.publicUrl = configuredPublicSmbSustainedUrl(options.url);
  return options;
}

async function observePinnedNavigation(
  session,
  navigationLoaderId,
  publicUrl,
  expectedFrameUrl,
) {
  const tree = await session.send("Page.getFrameTree");
  const top = tree.frameTree?.frame;
  if (
    typeof top?.id !== "string"
    || top.id.length === 0
    || top.loaderId !== navigationLoaderId
    || top.url !== publicUrl
  ) {
    throw new Error(`top-level sustained navigation loader is not pinned: ${JSON.stringify(top)}`);
  }
  const matchingFrames = (tree.frameTree?.childFrames ?? [])
    .map(child => child?.frame)
    .filter(frame => frame?.url === expectedFrameUrl);
  if (
    matchingFrames.length !== 1
    || typeof matchingFrames[0]?.id !== "string"
    || matchingFrames[0].id.length === 0
    || typeof matchingFrames[0].loaderId !== "string"
    || matchingFrames[0].loaderId.length === 0
  ) {
    throw new Error(
      `immutable sustained frontend loader is not uniquely pinned: ${JSON.stringify(matchingFrames)}`,
    );
  }
  return {
    top: compactFrameIdentity(top),
    iframe: compactFrameIdentity(matchingFrames[0]),
  };
}

async function waitForPublicSmbSustainedTerminal(
  session,
  { deadline, expectedFrameUrl, pollMs, publicUrl },
) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    const report = parsePublicReport(state.result);
    if (
      state.topUrl !== publicUrl
      || state.frameUrl !== expectedFrameUrl
      || state.surface !== "release"
      || state.dataset.renderer !== "wgpu-webgpu"
    ) {
      throw new Error(`public SMB sustained surface drifted: ${JSON.stringify(state)}`);
    }
    if (
      state.dataset.status === "stopped"
      || report?.status === "stopped"
      || report?.stage === "scenario-failed"
      || (report?.error !== undefined && report.error !== null)
      || (report?.scenario?.failure !== undefined && report.scenario.failure !== null)
    ) {
      throw new Error(`public SMB sustained scenario stopped: ${JSON.stringify(report)}`);
    }
    if (report?.status === "paused" && report.stage === "scenario-complete") {
      if (state.dataset.status !== "paused") {
        throw new Error("public SMB sustained terminal report disagrees with page status");
      }
      report.gameplayTranscript = deriveSmbReadyPlayGameplayTranscript(
        report.sustainedPlay?.readyPlayAnchor,
      );
      const oracle = verifySmbSustainedPlay(report);
      return { oracle, report, state };
    }
    await publicDelay(pollMs);
  }
  throw new Error(`public SMB sustained scenario timed out: ${JSON.stringify(state)}`);
}

async function persistEvidence(output, evidence) {
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}

export async function runPublicSmbSustained(options) {
  const discImage = await identifyLocalDiscImage(options.disc);
  validateDiscImage(discImage, "$.discImage");
  const target = await publicPageTarget(options.endpoint);
  const session = new DevToolsSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("DOM.enable");
    const navigation = await session.send("Page.navigate", { url: options.publicUrl });
    if (navigation.errorText !== undefined) {
      throw new Error(`Page.navigate failed: ${navigation.errorText}`);
    }
    if (typeof navigation.loaderId !== "string" || navigation.loaderId.length === 0) {
      throw new Error("Page.navigate did not create a top-level document loader");
    }
    const deadline = Date.now() + options.timeoutMs;
    await waitForPublicRelease(session, {
      deadline,
      pollMs: options.pollMs,
      publicUrl: options.publicUrl,
    });
    const release = await observePublicActiveRelease(session, options);
    const frameUrl = expectedPublicFrameUrl(options.publicUrl, release);
    const initialState = await waitForPublicRelease(session, {
      deadline,
      expectedFrameUrl: frameUrl,
      pollMs: options.pollMs,
      publicUrl: options.publicUrl,
    });
    const navigationBefore = await observePinnedNavigation(
      session,
      navigation.loaderId,
      options.publicUrl,
      frameUrl,
    );
    await assignPublicDisc(session, options.disc, {
      deadline,
      label: "Super Monkey Ball CISO",
      pollMs: options.pollMs,
    });
    await waitForPublicRunner(session, {
      deadline,
      pollMs: options.pollMs,
      stoppedLabel: "Super Monkey Ball sustained",
    });
    const terminal = await waitForPublicSmbSustainedTerminal(session, {
      deadline,
      expectedFrameUrl: frameUrl,
      pollMs: options.pollMs,
      publicUrl: options.publicUrl,
    });
    const terminalRelease = await observePublicActiveRelease(session, options, release);
    const navigationAfter = await observePinnedNavigation(
      session,
      navigation.loaderId,
      options.publicUrl,
      frameUrl,
    );
    const evidence = validatePublicSmbSustainedEvidence({
      schema: PUBLIC_SMB_SUSTAINED_SCHEMA,
      expected: {
        commit: options.expectCommit,
        releaseId: options.expectReleaseId,
      },
      publicUrl: options.publicUrl,
      release,
      terminalRelease,
      navigation: {
        expectedTopLoaderId: navigation.loaderId,
        expectedFrameUrl: frameUrl,
        before: navigationBefore,
        after: navigationAfter,
      },
      discImage,
      discStatus: terminal.state.discStatus ?? initialState.discStatus,
      dataset: terminal.state.dataset,
      frameUrl: terminal.state.frameUrl,
      surface: terminal.state.surface,
      devtoolsExceptions: session.exceptions,
      report: terminal.report,
      oracle: terminal.oracle,
    });
    await persistEvidence(options.output, evidence);
    return evidence;
  } finally {
    session.close();
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parsePublicSmbSustainedArguments(process.argv.slice(2));
  runPublicSmbSustained(options).catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
