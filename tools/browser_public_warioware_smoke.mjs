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

function requirePositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    evidenceFailure(path, "expected a positive integer");
  }
  return value;
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    evidenceFailure(path, "expected a non-negative integer");
  }
  return value;
}

function requireFieldRow(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1) {
    evidenceFailure(path, "expected field row 0 or 1");
  }
  return value;
}

function requireZero(value, path) {
  if (value !== 0) evidenceFailure(path, "expected zero");
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

export function publicWarioWareSnapshotHasCoherentXfb(report) {
  requiredObject(report, "$.report");
  if (report.status !== "running") {
    evidenceFailure("$.report.status", "expected running");
  }
  if (report.stage !== "snapshot") {
    evidenceFailure("$.report.stage", "expected snapshot");
  }
  if (report.error !== undefined && report.error !== null) {
    evidenceFailure("$.report.error", "expected no terminal error");
  }
  const mmioState = requiredObject(report.mmioState, "$.report.mmioState");
  const vi = requiredObject(
    mmioState.viInterruptModel,
    "$.report.mmioState.viInterruptModel",
  );
  const presentationCount = requireNonNegativeInteger(
    vi.presentationCount,
    "$.report.mmioState.viInterruptModel.presentationCount",
  );
  const rendering = requiredObject(report.rendering, "$.report.rendering");
  if (rendering.backend !== "wgpu-webgpu") {
    evidenceFailure("$.report.rendering.backend", "expected wgpu-webgpu");
  }
  if (rendering.error !== undefined && rendering.error !== null) {
    evidenceFailure("$.report.rendering.error", "expected no renderer error");
  }
  const selectedXfb = rendering.selectedXfb;
  const copyIndex = vi.lastPresentationCopyIndex;
  if (selectedXfb === null && copyIndex === 0) return false;
  if (selectedXfb === null) {
    evidenceFailure(
      "$.report.rendering.selectedXfb",
      `expected selected copy ${String(copyIndex)} after VI presentation`,
    );
  }
  requiredObject(selectedXfb, "$.report.rendering.selectedXfb");
  requirePositiveInteger(
    presentationCount,
    "$.report.mmioState.viInterruptModel.presentationCount",
  );
  const address = vi.lastPresentationAddress;
  if (typeof address !== "string" || !/^0x[0-9a-f]{8}$/.test(address)) {
    evidenceFailure(
      "$.report.mmioState.viInterruptModel.lastPresentationAddress",
      "expected a lowercase 32-bit hexadecimal address",
    );
  }
  requirePositiveInteger(
    copyIndex,
    "$.report.mmioState.viInterruptModel.lastPresentationCopyIndex",
  );
  if (
    typeof selectedXfb.address !== "string"
    || !/^0x[0-9a-f]{8}$/.test(selectedXfb.address)
  ) {
    evidenceFailure(
      "$.report.rendering.selectedXfb.address",
      "expected a lowercase 32-bit hexadecimal address",
    );
  }
  if (selectedXfb.address !== address) {
    evidenceFailure(
      "$.report.rendering.selectedXfb.address",
      `expected last VI presentation address ${address}, got ${selectedXfb.address}`,
    );
  }
  requirePositiveInteger(
    selectedXfb.generation,
    "$.report.rendering.selectedXfb.generation",
  );
  if (selectedXfb.generation !== copyIndex) {
    evidenceFailure(
      "$.report.rendering.selectedXfb.generation",
      `expected last VI presentation copy ${copyIndex}, got ${selectedXfb.generation}`,
    );
  }
  const copyRow = requireFieldRow(
    vi.lastPresentationCopyRow,
    "$.report.mmioState.viInterruptModel.lastPresentationCopyRow",
  );
  const selectedRow = requireFieldRow(
    selectedXfb.row,
    "$.report.rendering.selectedXfb.row",
  );
  if (selectedRow !== copyRow) {
    evidenceFailure(
      "$.report.rendering.selectedXfb.row",
      `expected last VI presentation row ${copyRow}, got ${selectedRow}`,
    );
  }
  return true;
}

async function capturePublicWarioWareSnapshot(session, { deadline, pollMs }) {
  if (await requestPublicSnapshot(session) !== true) {
    throw new Error("public WarioWare cycle runner cannot publish a snapshot");
  }
  return waitForPublicSnapshot(session, { deadline, pollMs });
}

export async function waitForCoherentPublicWarioWareSnapshot(
  session,
  {
    captureSnapshot = capturePublicWarioWareSnapshot,
    deadline,
    delay = publicDelay,
    now = Date.now,
    pollMs,
  },
) {
  let lastSnapshot = null;
  while (now() < deadline) {
    try {
      lastSnapshot = await captureSnapshot(session, { deadline, pollMs });
    } catch (error) {
      if (lastSnapshot === null) throw error;
      throw new Error(
        "public WarioWare snapshot capture failed after the last retryable snapshot: "
        + `${JSON.stringify(lastSnapshot)}; capture error: ${error?.message ?? String(error)}`,
        { cause: error },
      );
    }
    if (publicWarioWareSnapshotHasCoherentXfb(lastSnapshot.report)) {
      return lastSnapshot;
    }
    const remainingMs = deadline - now();
    if (remainingMs > 0) await delay(Math.min(pollMs, remainingMs));
  }
  throw new Error(
    "public WarioWare snapshot did not present a coherent XFB before the deadline; "
    + `last snapshot: ${JSON.stringify(lastSnapshot)}`,
  );
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
  if (!publicWarioWareSnapshotHasCoherentXfb(report)) {
    evidenceFailure(
      "$.report.rendering.selectedXfb",
      "expected a selected XFB with matching VI presentation provenance",
    );
  }
  for (const name of ["cycles", "dispatches", "instructions"]) {
    requirePositiveInteger(report[name], `$.report.${name}`);
  }

  const gxFifo = requiredObject(report.gxFifo, "$.report.gxFifo");
  requirePositiveInteger(gxFifo.bytes, "$.report.gxFifo.bytes");
  const staging = requiredObject(gxFifo.staging, "$.report.gxFifo.staging");
  requirePositiveInteger(staging.drains, "$.report.gxFifo.staging.drains");
  requirePositiveInteger(staging.bytes, "$.report.gxFifo.staging.bytes");
  requireZero(staging.emergencyDrains, "$.report.gxFifo.staging.emergencyDrains");
  requireZero(staging.pendingBytes, "$.report.gxFifo.staging.pendingBytes");

  const decoder = requiredObject(gxFifo.decoder, "$.report.gxFifo.decoder");
  for (const name of ["commands", "xfbCopyCount", "framesPresented"]) {
    requirePositiveInteger(decoder[name], `$.report.gxFifo.decoder.${name}`);
  }
  const maximumBufferedBytes = requirePositiveInteger(
    decoder.maximumBufferedBytes,
    "$.report.gxFifo.decoder.maximumBufferedBytes",
  );
  if (maximumBufferedBytes !== 16 * 1024 * 1024) {
    evidenceFailure(
      "$.report.gxFifo.decoder.maximumBufferedBytes",
      "expected the deployed 16 MiB decoder carry bound",
    );
  }
  const capacityWatermarkBytes = requirePositiveInteger(
    decoder.capacityWatermarkBytes,
    "$.report.gxFifo.decoder.capacityWatermarkBytes",
  );
  const retryAtBufferedBytes = requirePositiveInteger(
    decoder.retryAtBufferedBytes,
    "$.report.gxFifo.decoder.retryAtBufferedBytes",
  );
  const preDecodeHighWaterBytes = requirePositiveInteger(
    decoder.preDecodeHighWaterBytes,
    "$.report.gxFifo.decoder.preDecodeHighWaterBytes",
  );
  if (
    !Number.isSafeInteger(decoder.bufferedBytes)
    || decoder.bufferedBytes < 0
    || decoder.bufferedBytes > maximumBufferedBytes
  ) {
    evidenceFailure(
      "$.report.gxFifo.decoder.bufferedBytes",
      "expected a bounded non-negative decoder tail",
    );
  }
  if (
    capacityWatermarkBytes < decoder.bufferedBytes
    || capacityWatermarkBytes > maximumBufferedBytes
  ) {
    evidenceFailure(
      "$.report.gxFifo.decoder.capacityWatermarkBytes",
      "expected a bounded watermark covering the decoder tail",
    );
  }
  if (
    preDecodeHighWaterBytes < decoder.bufferedBytes
    || preDecodeHighWaterBytes > capacityWatermarkBytes
  ) {
    evidenceFailure(
      "$.report.gxFifo.decoder.preDecodeHighWaterBytes",
      "expected a pre-decode high-water mark covering the tail within capacity",
    );
  }
  if (retryAtBufferedBytes > maximumBufferedBytes) {
    evidenceFailure(
      "$.report.gxFifo.decoder.retryAtBufferedBytes",
      "expected a retry requirement within the decoder carry bound",
    );
  }
  if (decoder.bufferedBytes > 0) {
    if (
      retryAtBufferedBytes <= decoder.bufferedBytes
    ) {
      evidenceFailure(
        "$.report.gxFifo.decoder.retryAtBufferedBytes",
        "expected an unmet bounded command requirement for the decoder tail",
      );
    }
  }
  for (const name of [
    "unknownOpcodes",
    "displayListErrors",
    "vertexDecodeErrors",
  ]) {
    requireZero(decoder[name], `$.report.gxFifo.decoder.${name}`);
  }
  const textures = requiredObject(decoder.textures, "$.report.gxFifo.decoder.textures");
  requirePositiveInteger(textures.draws, "$.report.gxFifo.decoder.textures.draws");
  requirePositiveInteger(textures.decodes, "$.report.gxFifo.decoder.textures.decodes");
  requireZero(textures.decodeErrors, "$.report.gxFifo.decoder.textures.decodeErrors");
  requireZero(textures.tlutErrors, "$.report.gxFifo.decoder.textures.tlutErrors");

  const metrics = requiredObject(rendering.metrics, "$.report.rendering.metrics");
  if (metrics.scope !== "current-worker") {
    evidenceFailure("$.report.rendering.metrics.scope", "expected current-worker");
  }
  const workerMessages = requiredObject(
    metrics.workerMessages,
    "$.report.rendering.metrics.workerMessages",
  );
  requirePositiveInteger(
    workerMessages.gxFrames,
    "$.report.rendering.metrics.workerMessages.gxFrames",
  );
  requirePositiveInteger(
    workerMessages.drawCalls,
    "$.report.rendering.metrics.workerMessages.drawCalls",
  );
  const operations = requiredObject(
    metrics.operations,
    "$.report.rendering.metrics.operations",
  );
  requireZero(operations.pending, "$.report.rendering.metrics.operations.pending");
  const webgpu = requiredObject(metrics.webgpu, "$.report.rendering.metrics.webgpu");
  requirePositiveInteger(
    webgpu.copyXfbCalls,
    "$.report.rendering.metrics.webgpu.copyXfbCalls",
  );
  requirePositiveInteger(
    webgpu.presentXfbCalls,
    "$.report.rendering.metrics.webgpu.presentXfbCalls",
  );

  const selectedXfb = requiredObject(
    rendering.selectedXfb,
    "$.report.rendering.selectedXfb",
  );
  if (
    selectedXfb.width !== 640
    || selectedXfb.height !== 448
    || selectedXfb.format !== "rgba8unorm"
    || selectedXfb.layout !== "top-left-row-major-tight"
    || selectedXfb.rgbaByteLength !== 640 * 448 * 4
  ) {
    evidenceFailure("$.report.rendering.selectedXfb", "expected a complete 640x448 RGBA8 XFB");
  }
  for (const [name, value] of [
    ["rgbaSha256", selectedXfb.rgbaSha256],
    ["rgbSha256", selectedXfb.rgbSha256],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value ?? "")) {
      evidenceFailure(`$.report.rendering.selectedXfb.${name}`, "expected a SHA-256 digest");
    }
  }
  const rgb = requiredObject(selectedXfb.rgb, "$.report.rendering.selectedXfb.rgb");
  if (
    !Number.isSafeInteger(rgb.other)
    || rgb.other <= 0
    || !Number.isSafeInteger(rgb.unique)
    || rgb.unique < 2
  ) {
    evidenceFailure(
      "$.report.rendering.selectedXfb.rgb",
      "expected visible non-black content with at least two RGB values",
    );
  }
  return evidence;
}


function parseArguments(argv) {
  const options = {
    disc: null,
    endpoint: "http://127.0.0.1:9222",
    output: null,
    pollMs: 250,
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
    const { report, state } = await waitForCoherentPublicWarioWareSnapshot(session, {
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
