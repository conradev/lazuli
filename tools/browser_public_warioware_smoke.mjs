#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";
import { DevToolsSession } from "./browser_boot_headless_cdp.mjs";
import {
  PUBLIC_SCENARIO,
  assignPublicDisc,
  expectedPublicFrameUrl,
  observePublicActiveRelease,
  publicDelay,
  publicPageTarget,
  requestPublicSnapshot,
  waitForPublicRelease,
  waitForPublicRunner,
  waitForPublicSnapshot,
} from "./browser_public_cdp.mjs";

const EVIDENCE_SCHEMA = "lazuli-public-warioware-smoke-v1";
const IMMUTABLE_FRONTEND_PATH = /^\/assets\/frontend-[0-9a-f]{64}\.html$/;
const PRODUCTION_ORIGIN = "https://gekko.free";
const WARIOWARE_DISC_IDENTIFIER = "GZWE01";

function evidenceFailure(path, message) {
  throw new Error(`invalid public WarioWare smoke evidence at ${path}: ${message}`);
}

function requiredObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    evidenceFailure(path, "expected an object");
  }
  return value;
}

function evidenceUrl(value, path) {
  try {
    return new URL(value);
  } catch {
    evidenceFailure(path, "expected an absolute URL");
  }
}

function requireProductionOrigin(url, path) {
  if (
    url.origin !== PRODUCTION_ORIGIN
    || url.username !== ""
    || url.password !== ""
  ) {
    evidenceFailure(path, `expected exact production origin ${PRODUCTION_ORIGIN}`);
  }
  return url;
}

export function configuredPublicWarioWareUrl(value) {
  const url = requireProductionOrigin(evidenceUrl(value, "--url"), "--url");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    evidenceFailure("--url", "expected the exact production root without query or fragment");
  }
  url.searchParams.set("scenario", PUBLIC_SCENARIO);
  return url.href;
}

export function validatePublicWarioWareSmokeEvidence(evidence) {
  requiredObject(evidence, "$");
  if (evidence.schema !== EVIDENCE_SCHEMA) {
    evidenceFailure("$.schema", `expected ${EVIDENCE_SCHEMA}`);
  }
  const publicUrl = requireProductionOrigin(
    evidenceUrl(evidence.publicUrl, "$.publicUrl"),
    "$.publicUrl",
  );
  if (
    publicUrl.pathname !== "/"
    || publicUrl.hash !== ""
    || publicUrl.searchParams.size !== 1
    || publicUrl.searchParams.get("scenario") !== PUBLIC_SCENARIO
  ) {
    evidenceFailure("$.publicUrl", `expected stale ${PUBLIC_SCENARIO} scenario`);
  }
  const frameUrl = requireProductionOrigin(
    evidenceUrl(evidence.frameUrl, "$.frameUrl"),
    "$.frameUrl",
  );
  if (frameUrl.search !== publicUrl.search || frameUrl.hash !== "") {
    evidenceFailure("$.frameUrl", `expected forwarded ${PUBLIC_SCENARIO} scenario`);
  }
  if (!IMMUTABLE_FRONTEND_PATH.test(frameUrl.pathname)) {
    evidenceFailure("$.frameUrl", "expected a content-addressed immutable frontend path");
  }
  const release = requiredObject(evidence.release, "$.release");
  const terminalRelease = requiredObject(evidence.terminalRelease, "$.terminalRelease");
  if (JSON.stringify(release) !== JSON.stringify(terminalRelease)) {
    evidenceFailure("$.terminalRelease", "active release changed during the smoke run");
  }
  const frontend = requiredObject(release.frontend, "$.release.frontend");
  if (typeof frontend.url !== "string" || !IMMUTABLE_FRONTEND_PATH.test(frontend.url)) {
    evidenceFailure("$.release.frontend.url", "expected an immutable frontend asset path");
  }
  if (frameUrl.href !== expectedPublicFrameUrl(publicUrl.href, release)) {
    evidenceFailure("$.frameUrl", "does not match the active release frontend identity");
  }
  if (evidence.surface !== "release") {
    evidenceFailure("$.surface", "expected release");
  }
  const dataset = requiredObject(evidence.dataset, "$.dataset");
  if (dataset.status !== "running") {
    evidenceFailure("$.dataset.status", "expected running");
  }
  if (dataset.renderer !== "wgpu-webgpu") {
    evidenceFailure("$.dataset.renderer", "expected wgpu-webgpu");
  }
  if (!Array.isArray(evidence.devtoolsExceptions)) {
    evidenceFailure("$.devtoolsExceptions", "expected an array");
  }
  if (evidence.devtoolsExceptions.length !== 0) {
    evidenceFailure("$.devtoolsExceptions[0]", "expected no DevTools exceptions");
  }
  const discImage = requiredObject(evidence.discImage, "$.discImage");
  if (
    discImage.algorithm !== "sha256"
    || discImage.format !== "ciso"
    || !/^[0-9a-f]{64}$/.test(discImage.sha256)
  ) {
    evidenceFailure("$.discImage", "expected an identified local CISO");
  }

  const report = requiredObject(evidence.report, "$.report");
  if (report.status !== "running" || report.stage !== "snapshot") {
    evidenceFailure("$.report", "expected running snapshot evidence");
  }
  if (report.error !== undefined && report.error !== null) {
    evidenceFailure("$.report.error", "expected no terminal error");
  }
  if (report.scenario !== null) {
    evidenceFailure("$.report.scenario", "expected the stale SMB scenario to be discarded");
  }
  const disc = requiredObject(report.disc, "$.report.disc");
  if (disc.identifier !== WARIOWARE_DISC_IDENTIFIER) {
    evidenceFailure("$.report.disc.identifier", `expected ${WARIOWARE_DISC_IDENTIFIER}`);
  }
  if (disc.revision !== 0) {
    evidenceFailure("$.report.disc.revision", "expected USA revision 0");
  }
  if (disc.source?.kind !== "local-file") {
    evidenceFailure("$.report.disc.source.kind", "expected local-file");
  }
  const rendering = requiredObject(report.rendering, "$.report.rendering");
  if (rendering.backend !== "wgpu-webgpu") {
    evidenceFailure("$.report.rendering.backend", "expected wgpu-webgpu");
  }
  if (rendering.error !== undefined && rendering.error !== null) {
    evidenceFailure("$.report.rendering.error", "expected no renderer error");
  }
  for (const name of ["cycles", "dispatches", "instructions"]) {
    if (!Number.isSafeInteger(report[name]) || report[name] <= 0) {
      evidenceFailure(`$.report.${name}`, "expected positive execution progress");
    }
  }
  return evidence;
}


function parseArguments(argv) {
  const options = {
    disc: null,
    endpoint: "http://127.0.0.1:9222",
    output: null,
    pollMs: 250,
    settleMs: 5_000,
    timeoutMs: 120_000,
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
      case "--output": options.output = value(); break;
      case "--poll-ms": options.pollMs = Number(value()); break;
      case "--settle-ms": options.settleMs = Number(value()); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--url": options.url = value(); break;
      default: throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.disc === null) throw new Error("--disc must name the local WarioWare CISO");
  if (options.url === null) throw new Error("--url must name the public Gekko surface");
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10) {
    throw new Error("--poll-ms must be an integer >= 10");
  }
  if (!Number.isInteger(options.settleMs) || options.settleMs < 0) {
    throw new Error("--settle-ms must be a non-negative integer");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < options.pollMs) {
    throw new Error("--timeout-ms must be an integer >= --poll-ms");
  }
  options.disc = resolve(options.disc);
  options.publicUrl = configuredPublicWarioWareUrl(options.url);
  return options;
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const discImage = await identifyLocalDiscImage(options.disc);
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
    const deadline = Date.now() + options.timeoutMs;
    await waitForPublicRelease(session, {
      deadline,
      pollMs: options.pollMs,
      publicUrl: options.publicUrl,
    });
    const release = await observePublicActiveRelease(session, options);
    const expectedFrameUrl = expectedPublicFrameUrl(options.publicUrl, release);
    await waitForPublicRelease(session, {
      deadline,
      expectedFrameUrl,
      pollMs: options.pollMs,
      publicUrl: options.publicUrl,
    });
    await assignPublicDisc(session, options.disc, {
      deadline,
      label: "WarioWare CISO",
      pollMs: options.pollMs,
    });
    await waitForPublicRunner(session, {
      deadline,
      pollMs: options.pollMs,
      stoppedLabel: "WarioWare",
    });
    if (Date.now() + options.settleMs >= deadline) {
      throw new Error("public WarioWare smoke deadline expired before its settle interval");
    }
    await publicDelay(options.settleMs);
    if (await requestPublicSnapshot(session) !== true) {
      throw new Error("public WarioWare cycle runner cannot publish a snapshot");
    }
    const { report, state } = await waitForPublicSnapshot(session, {
      deadline,
      pollMs: options.pollMs,
    });
    const terminalRelease = await observePublicActiveRelease(session, options, release);
    const evidence = validatePublicWarioWareSmokeEvidence({
      schema: EVIDENCE_SCHEMA,
      dataset: state.dataset,
      devtoolsExceptions: session.exceptions,
      discImage,
      discStatus: state.discStatus,
      frameUrl: state.frameUrl,
      publicUrl: options.publicUrl,
      release,
      report,
      surface: state.surface,
      terminalRelease,
    });
    await persistEvidence(options.output, evidence);
  } finally {
    session.close();
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
