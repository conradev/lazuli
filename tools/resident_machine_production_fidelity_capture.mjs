#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateRelease } from "../web/release.mjs";
import { DevToolsSession } from "./browser_boot_headless_cdp.mjs";
import {
  GAME_COMPATIBILITY_CORPUS_PATH,
  readGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA,
  canonicalFidelityLockJson,
  expectedFidelityHostIdentitySha256,
  validateResidentProductionFidelityEvidenceLock,
} from "./resident_machine_fidelity_lock.mjs";
import {
  parseFidelityCheckpointJsonl,
  validateFidelityCheckpointJournal,
} from "./resident_machine_fidelity_checkpoint_report.mjs";
import { validateMachineEvidenceV1Envelope } from "./resident_machine_evidence_v1.mjs";

export const PRODUCTION_FIDELITY_CAPTURE_STATE_SCHEMA =
  "lazuli-production-fidelity-capture-state-v1";
export const PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA =
  "lazuli-resident-production-fidelity-run-fragment-v1";

const CAPTURE_PAGE_PATH = "/tools/resident_machine_first_frame.html";
const MACHINE_EVIDENCE_BYTES = 816;
const GAME_FIDELITY_BYTES = 384;
const DEFAULT_STEP_CAP = 65_535;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPTURE_API_EXPRESSION = "globalThis.lazuliProductionFidelityCapture";
const DEFAULT_CORPUS_PATH = GAME_COMPATIBILITY_CORPUS_PATH;

function fail(message) {
  throw new Error(`production fidelity capture: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has keys ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalCaptureJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail("canonical JSON contains an unsupported value");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCaptureJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalCaptureJson(value[key])}`
  ).join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.from(canonicalCaptureJson(value), "utf8");
}

function bytesFromCanonicalBase64(value, label, expectedBytes = null) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) fail(`${label} must be canonical padded base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(`${label} is not canonically spelled`);
  if (expectedBytes !== null && bytes.byteLength !== expectedBytes) {
    fail(`${label} decoded to ${bytes.byteLength} bytes, expected ${expectedBytes}`);
  }
  return bytes;
}

function expectedBoot(game) {
  return Object.freeze({
    identifier: game.disc.identifier,
    revision: game.disc.revision,
    discNumber: 0,
    format: 1,
    logicalBytes: "1459978240",
  });
}

function decodeMachineEvidence(envelope, game, label) {
  return validateMachineEvidenceV1Envelope(envelope, {
    path: label,
    expectedBoot: expectedBoot(game),
  });
}

function counter(summary, family, field, label) {
  const value = summary?.[family]?.[field];
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail(`${label}.${family}.${field} is not an unsigned decimal counter`);
  }
  return BigInt(value);
}

export function sustainedWindowReached(
  firstSummary,
  currentSummary,
  { minimumViFields = 120, minimumPresentations = 64 } = {},
) {
  positiveInteger(minimumViFields, "minimum VI fields");
  positiveInteger(minimumPresentations, "minimum presentations");
  const firstVi = counter(firstSummary, "vi", "viFields", "first machine evidence");
  const currentVi = counter(currentSummary, "vi", "viFields", "current machine evidence");
  const firstPresentations = counter(
    firstSummary,
    "gx",
    "presentedFrames",
    "first machine evidence",
  );
  const currentPresentations = counter(
    currentSummary,
    "gx",
    "presentedFrames",
    "current machine evidence",
  );
  return currentVi >= firstVi
    && currentPresentations >= firstPresentations
    && currentVi - firstVi >= BigInt(minimumViFields)
    && currentPresentations - firstPresentations >= BigInt(minimumPresentations);
}

function loopbackHostname(hostname) {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

export function validateLoopbackCdpEndpoint(value, label = "CDP endpoint") {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail(`${label} is not a URL`);
  }
  if (
    endpoint.protocol !== "http:"
    || endpoint.username !== ""
    || endpoint.password !== ""
    || (endpoint.pathname !== "" && endpoint.pathname !== "/")
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || !loopbackHostname(endpoint.hostname)
  ) fail(`${label} must be an unauthenticated loopback HTTP URL`);
  endpoint.pathname = "/";
  return endpoint;
}

function validateLoopbackSocket(value) {
  let socket;
  try {
    socket = new URL(value);
  } catch {
    fail("CDP page target socket is not a URL");
  }
  if (
    socket.protocol !== "ws:"
    || socket.username !== ""
    || socket.password !== ""
    || !loopbackHostname(socket.hostname)
  ) fail("CDP page target socket is not loopback WebSocket transport");
  return socket.href;
}

function capturePageGame(targetUrl) {
  let page;
  try {
    page = new URL(targetUrl);
  } catch {
    return null;
  }
  if (
    page.protocol !== "http:"
    || page.username !== ""
    || page.password !== ""
    || !loopbackHostname(page.hostname)
    || page.pathname !== CAPTURE_PAGE_PATH
    || page.hash !== ""
  ) return null;
  const entries = [...page.searchParams.entries()];
  const expectedSearch = `?capture=fidelity&game=${encodeURIComponent(
    page.searchParams.get("game") ?? "",
  )}`;
  if (
    entries.length !== 2
    || page.search !== expectedSearch
    || page.searchParams.getAll("capture").length !== 1
    || page.searchParams.get("capture") !== "fidelity"
    || page.searchParams.getAll("game").length !== 1
  ) return null;
  const key = page.searchParams.get("game");
  return KEY_PATTERN.test(key ?? "") ? key : null;
}

export function validateCaptureUrl(value, expectedGameKey) {
  const gameKey = capturePageGame(value);
  if (gameKey === null || gameKey !== expectedGameKey) {
    fail(`capture URL for ${expectedGameKey} must be loopback HTTP with only capture=fidelity and game=${expectedGameKey}`);
  }
  return new URL(value).href;
}

function parseKeyedPath(value, label) {
  const separator = value.indexOf("=");
  const key = separator < 0 ? "" : value.slice(0, separator);
  const pathname = separator < 0 ? "" : value.slice(separator + 1);
  if (!KEY_PATTERN.test(key) || pathname.length === 0) {
    fail(`${label} must be GAME-KEY=PATH`);
  }
  return [key, pathname];
}

export function parseCaptureArguments(argv) {
  const scalarNames = new Set([
    "cdp-endpoint",
    "corpus",
    "output-directory",
    "release",
    "request-timeout-ms",
    "step-cap",
  ]);
  const repeatedNames = new Set(["checkpoint-journal", "evidence-lock"]);
  repeatedNames.add("capture-url");
  const scalar = new Map();
  const repeated = new Map([...repeatedNames].map(name => [name, new Map()]));
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (typeof option !== "string" || !option.startsWith("--") || value === undefined) {
      fail("arguments must be --NAME VALUE pairs");
    }
    const name = option.slice(2);
    if (scalarNames.has(name)) {
      if (scalar.has(name)) fail(`${option} was supplied more than once`);
      scalar.set(name, value);
      continue;
    }
    if (repeatedNames.has(name)) {
      const [key, rawValue] = parseKeyedPath(value, option);
      if (repeated.get(name).has(key)) fail(`${option} repeats ${key}`);
      repeated.get(name).set(key, name === "capture-url" ? rawValue : path.resolve(rawValue));
      continue;
    }
    fail(`unknown option ${option}`);
  }
  for (const name of [
    "cdp-endpoint",
    "output-directory",
    "release",
  ]) {
    if (!scalar.has(name)) fail(`--${name} is required`);
  }
  const integerOption = (name, fallback) => {
    if (!scalar.has(name)) return fallback;
    if (!/^[1-9][0-9]*$/.test(scalar.get(name))) fail(`--${name} must be a positive integer`);
    return positiveInteger(Number(scalar.get(name)), `--${name}`);
  };
  return Object.freeze({
    cdpEndpoint: validateLoopbackCdpEndpoint(scalar.get("cdp-endpoint")).href,
    captureUrls: repeated.get("capture-url"),
    corpusPath: path.resolve(scalar.get("corpus") ?? DEFAULT_CORPUS_PATH),
    outputDirectory: path.resolve(scalar.get("output-directory")),
    releasePath: path.resolve(scalar.get("release")),
    requestTimeoutMs: integerOption("request-timeout-ms", DEFAULT_REQUEST_TIMEOUT_MS),
    stepCap: integerOption("step-cap", DEFAULT_STEP_CAP),
    checkpointJournals: repeated.get("checkpoint-journal"),
    evidenceLocks: repeated.get("evidence-lock"),
  });
}

function releaseExecutionAssets(release) {
  const descriptor = value => ({ url: value.url, bytes: value.bytes, sha256: value.sha256 });
  return {
    core: descriptor(release.runtime.core),
    dispatcher: descriptor(release.runtime.dispatcher),
    coordinator: descriptor(release.runtime.coordinator),
    adapter: descriptor(release.runtime.adapter),
    worker: descriptor(release.runtime.worker),
    frontend: descriptor(release.frontend),
    rendererJavascript: descriptor(release.renderer.javascript),
    rendererWasm: descriptor(release.renderer.wasm),
  };
}

function lockSelfAuthority(lock) {
  return {
    release: lock.release,
    run: lock.run,
    corpus: lock.corpus,
    selectedGame: lock.selectedGame,
    artifacts: lock.artifacts,
    sources: lock.sources,
  };
}

export function orderCaptureInputs(corpus, lockInputs, journalPaths, captureUrls) {
  if (!Array.isArray(corpus?.games) || corpus.games.length !== 7) {
    fail("the compatibility corpus must contain exactly seven games");
  }
  const games = [...corpus.games].sort((left, right) => left.priority - right.priority);
  const expectedKeys = games.map(game => game.key);
  if (new Set(expectedKeys).size !== 7) fail("the compatibility corpus repeats a game key");
  for (let index = 0; index < games.length; index += 1) {
    if (games[index].priority !== index + 1) fail("corpus priorities are not exactly 1 through 7");
  }
  const suppliedLockKeys = [...lockInputs.keys()].sort();
  const suppliedJournalKeys = [...journalPaths.keys()].sort();
  const suppliedCaptureUrlKeys = [...captureUrls.keys()].sort();
  const sortedExpected = [...expectedKeys].sort();
  if (JSON.stringify(suppliedLockKeys) !== JSON.stringify(sortedExpected)) {
    fail("evidence-lock arguments do not cover the exact seven-game corpus");
  }
  if (JSON.stringify(suppliedJournalKeys) !== JSON.stringify(sortedExpected)) {
    fail("checkpoint-journal arguments do not cover the exact seven-game corpus");
  }
  if (JSON.stringify(suppliedCaptureUrlKeys) !== JSON.stringify(sortedExpected)) {
    fail("capture-url arguments do not cover the exact seven-game corpus");
  }
  return games.map(game => {
    const input = lockInputs.get(game.key);
    if (input.lock.run.gameKey !== game.key || input.lock.selectedGame.key !== game.key) {
      fail(`evidence lock identity does not match ${game.key}`);
    }
    if (input.lock.selectedGame.priority !== game.priority) {
      fail(`evidence lock priority does not match ${game.key}`);
    }
    return Object.freeze({
      game,
      lock: input.lock,
      lockBytes: input.bytes,
      lockPath: input.path,
      journalPath: journalPaths.get(game.key),
      captureUrl: validateCaptureUrl(captureUrls.get(game.key), game.key),
    });
  });
}

export function operatorPublicationDue(policy, runBoundary, publicationCount) {
  if (!Number.isSafeInteger(runBoundary) || runBoundary < 0) {
    fail("operator run boundary index must be a safe non-negative integer");
  }
  if (!Number.isSafeInteger(publicationCount) || publicationCount < 0) {
    fail("operator publication count must be a safe non-negative integer");
  }
  if (policy.runBoundaryOrigin !== "post-first-frame-report-local-zero") {
    fail("operator run boundary origin changed");
  }
  return runBoundary % policy.runBoundaryInterval === 0
    && publicationCount < policy.maximumPublications;
}

export function selectRetainedPreWitnessMachineEvidence(captureState) {
  return object(captureState, "publishWitness state").artifacts
    ? object(captureState.artifacts, "publishWitness state artifacts").preWitnessMachineEvidence
    : fail("publishWitness state omitted retained artifacts");
}

async function loadInputs(options) {
  const [releaseBytes, corpus] = await Promise.all([
    readFile(options.releasePath),
    readGameCompatibilityCorpus(options.corpusPath),
  ]);
  const release = await validateRelease(JSON.parse(releaseBytes));
  const lockEntries = await Promise.all([...options.evidenceLocks].map(async ([key, lockPath]) => {
    const bytes = await readFile(lockPath);
    const lock = JSON.parse(bytes);
    if (lock.schema !== PRODUCTION_FIDELITY_EVIDENCE_LOCK_SCHEMA) {
      fail(`evidence lock for ${key} is not production schema v3`);
    }
    validateResidentProductionFidelityEvidenceLock(lock, lockSelfAuthority(lock));
    return [key, { bytes, lock, path: lockPath }];
  }));
  const ordered = orderCaptureInputs(
    corpus,
    new Map(lockEntries),
    options.checkpointJournals,
    options.captureUrls,
  );
  const releaseRecord = {
    schema: release.schema,
    releaseId: release.releaseId,
    manifestBytes: releaseBytes.byteLength,
    manifestSha256: hashBytes(releaseBytes),
    sourceCommit: release.source.commit,
    executionAssetsSha256: hashBytes(Buffer.from(
      canonicalCaptureJson(releaseExecutionAssets(release)),
      "utf8",
    )),
    executionAssets: releaseExecutionAssets(release),
  };
  for (const input of ordered) {
    if (canonicalFidelityLockJson(input.lock.release) !== canonicalFidelityLockJson(releaseRecord)) {
      fail(`schema-4 release does not match the evidence lock for ${input.game.key}`);
    }
  }
  return Object.freeze({
    release,
    ordered,
  });
}

async function fetchCdpJson(endpoint, relative, fetchImpl) {
  const response = await fetchImpl(new URL(relative, endpoint));
  if (!response.ok) fail(`CDP ${relative} returned HTTP ${response.status}`);
  return response.json();
}

export function selectCreatedCaptureTarget(targets, targetId) {
  if (!Array.isArray(targets)) fail("CDP target list is not an array");
  const matching = targets.filter(target => target?.id === targetId);
  if (matching.length !== 1) fail("the dedicated CDP target is not uniquely exposed");
  const target = matching[0];
  if (target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") {
    fail("the dedicated CDP target is not a debuggable page");
  }
  return Object.freeze({
    id: targetId,
    webSocketDebuggerUrl: validateLoopbackSocket(target.webSocketDebuggerUrl),
  });
}

async function createDedicatedCaptureTarget(endpoint, createSession, fetchImpl, requestTimeoutMs) {
  const version = await fetchCdpJson(endpoint, "json/version", fetchImpl);
  const browserSocket = validateLoopbackSocket(version.webSocketDebuggerUrl);
  const browserSession = createSession(browserSocket, { requestTimeoutMs });
  await browserSession.connect();
  let targetId = null;
  try {
    const created = await browserSession.send(
      "Target.createTarget",
      { url: "about:blank" },
      requestTimeoutMs,
    );
    if (typeof created.targetId !== "string" || created.targetId.length === 0) {
      fail("Target.createTarget omitted its target ID");
    }
    targetId = created.targetId;
    const deadline = Date.now() + requestTimeoutMs;
    let target = null;
    while (target === null) {
      const targets = await fetchCdpJson(endpoint, "json/list", fetchImpl);
      const matching = targets.filter(candidate => candidate?.id === targetId);
      if (matching.length === 1 && typeof matching[0].webSocketDebuggerUrl === "string") {
        target = selectCreatedCaptureTarget(targets, targetId);
        break;
      }
      if (Date.now() >= deadline) fail("dedicated CDP target did not become debuggable");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return Object.freeze({ browserSession, target });
  } catch (error) {
    if (targetId !== null) {
      await browserSession.send("Target.closeTarget", { targetId }, requestTimeoutMs).catch(() => {});
    }
    browserSession.close();
    throw error;
  }
}

function rootFrame(frameTree) {
  const frame = frameTree?.frameTree?.frame;
  if (
    frame === null
    || typeof frame !== "object"
    || typeof frame.id !== "string"
    || typeof frame.loaderId !== "string"
    || typeof frame.url !== "string"
  ) fail("CDP root frame identity is incomplete");
  return frame;
}

async function assertNavigationBinding(session, binding, requestTimeoutMs) {
  const frame = rootFrame(await session.send("Page.getFrameTree", {}, requestTimeoutMs));
  validateNavigationFrame(binding, frame);
}

export function validateNavigationFrame(binding, frame) {
  if (
    frame.id !== binding.frameId
    || frame.loaderId !== binding.loaderId
    || frame.url !== binding.url
  ) fail("dedicated capture page loader or URL drifted");
  return frame;
}

async function navigateDedicatedPage(session, captureUrl, requestTimeoutMs) {
  const navigation = await session.send("Page.navigate", { url: captureUrl }, requestTimeoutMs);
  if (
    typeof navigation.frameId !== "string"
    || typeof navigation.loaderId !== "string"
    || (typeof navigation.errorText === "string" && navigation.errorText.length !== 0)
  ) fail(`dedicated capture navigation failed: ${String(navigation.errorText ?? "missing loader")}`);
  const binding = Object.freeze({
    frameId: navigation.frameId,
    loaderId: navigation.loaderId,
    url: captureUrl,
  });
  const deadline = Date.now() + requestTimeoutMs;
  while (true) {
    const frame = rootFrame(await session.send("Page.getFrameTree", {}, requestTimeoutMs));
    if (frame.id === binding.frameId && frame.loaderId === binding.loaderId && frame.url === captureUrl) {
      const ready = await session.evaluate(`(() => ({
        href: location.href,
        ready: typeof ${CAPTURE_API_EXPRESSION} === "object"
          && ${CAPTURE_API_EXPRESSION} !== null
          && typeof ${CAPTURE_API_EXPRESSION}.snapshot === "function"
      }))()`, requestTimeoutMs).catch(() => null);
      if (ready?.href === captureUrl && ready.ready === true) return binding;
    }
    if (Date.now() >= deadline) fail("dedicated capture page did not expose its exact API before deadline");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function unloadDedicatedPage(session, requestTimeoutMs) {
  const navigation = await session.send("Page.navigate", { url: "about:blank" }, requestTimeoutMs);
  if (typeof navigation.frameId !== "string" || typeof navigation.loaderId !== "string") {
    fail("dedicated capture target did not unload");
  }
  const deadline = Date.now() + requestTimeoutMs;
  while (true) {
    const frame = rootFrame(await session.send("Page.getFrameTree", {}, requestTimeoutMs));
    if (
      frame.id === navigation.frameId
      && frame.loaderId === navigation.loaderId
      && frame.url === "about:blank"
    ) return;
    if (Date.now() >= deadline) fail("dedicated capture target unload drifted");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function captureCall(method, argument) {
  const suffix = argument === undefined ? "" : canonicalCaptureJson(argument);
  return `(() => {
    const capture = ${CAPTURE_API_EXPRESSION};
    if (capture === null || typeof capture !== "object" || typeof capture.${method} !== "function") {
      throw new Error("production fidelity capture API is unavailable");
    }
    return capture.${method}(${suffix});
  })()`;
}

function validateCaptureState(value, game, label) {
  exactKeys(value, [
    "schema",
    "gameKey",
    "phase",
    "machineSessionId",
    "runSummary",
    "machineEvidence",
    "gameFidelity",
    "artifacts",
  ], label);
  if (value.schema !== PRODUCTION_FIDELITY_CAPTURE_STATE_SCHEMA) fail(`${label}.schema changed`);
  if (value.gameKey !== game.key) fail(`${label}.gameKey changed`);
  if (!Number.isSafeInteger(value.phase) || !new Set([0, 1, 5, 6]).has(value.phase)) {
    fail(`${label}.phase is not a known Rust fidelity phase`);
  }
  if (typeof value.machineSessionId !== "string" || !UUID_PATTERN.test(value.machineSessionId)) {
    fail(`${label}.machineSessionId is not a UUID`);
  }
  object(value.runSummary, `${label}.runSummary`);
  object(value.artifacts, `${label}.artifacts`);
  const summary = decodeMachineEvidence(value.machineEvidence, game, `${label}.machineEvidence`);
  return Object.freeze({ state: value, summary });
}

async function evaluateCapture(
  session,
  method,
  argument,
  game,
  requestTimeoutMs,
  navigationBinding,
) {
  await assertNavigationBinding(session, navigationBinding, requestTimeoutMs);
  const value = await session.evaluate(captureCall(method, argument), requestTimeoutMs);
  await assertNavigationBinding(session, navigationBinding, requestTimeoutMs);
  return validateCaptureState(value, game, `${game.key}.${method}`);
}

function exactEnvelope(value, label, expectedBytes) {
  exactKeys(value, ["available", "bytes", "encoding", "payload"], label);
  if (value.available !== true || value.bytes !== expectedBytes || value.encoding !== "base64") {
    fail(`${label} is not the exact ${expectedBytes}-byte opaque envelope`);
  }
  bytesFromCanonicalBase64(value.payload, `${label}.payload`, expectedBytes);
  return value;
}

function exactMetadata(value, label) {
  const metadata = object(value, label);
  positiveInteger(metadata.width, `${label}.width`, 2_048);
  positiveInteger(metadata.height, `${label}.height`, 2_048);
  return metadata;
}

function exactArtifacts(value, game) {
  exactKeys(value, [
    "readyMachineEvidence",
    "firstFrameReportJson",
    "firstVisibleRgbaBase64",
    "baselineGameFidelityRecord",
    "baselineMachineEvidence",
    "baselineMetadata",
    "baselineRgbaBase64",
    "preWitnessMachineEvidence",
    "terminalGameFidelityRecord",
    "terminalMachineEvidence",
    "acceptedMetadata",
    "acceptedRgbaBase64",
  ], `${game.key}.artifacts`);
  const ready = exactEnvelope(
    value.readyMachineEvidence,
    `${game.key}.artifacts.readyMachineEvidence`,
    MACHINE_EVIDENCE_BYTES,
  );
  decodeMachineEvidence(ready, game, `${game.key}.artifacts.readyMachineEvidence`);
  if (typeof value.firstFrameReportJson !== "string" || value.firstFrameReportJson.length === 0) {
    fail(`${game.key}.artifacts.firstFrameReportJson is not a canonical JSON string`);
  }
  let firstFrameReport;
  try {
    firstFrameReport = JSON.parse(value.firstFrameReportJson);
  } catch (error) {
    fail(`${game.key}.artifacts.firstFrameReportJson is invalid: ${error.message}`);
  }
  if (canonicalCaptureJson(firstFrameReport) !== value.firstFrameReportJson) {
    fail(`${game.key}.artifacts.firstFrameReportJson is not recursive-key canonical JSON`);
  }
  if (firstFrameReport?.corpus?.selectedGameKey !== game.key) {
    fail(`${game.key}.artifacts.firstFrameReportJson changed the selected game`);
  }
  const firstVisibleRgba = bytesFromCanonicalBase64(
    value.firstVisibleRgbaBase64,
    `${game.key}.artifacts.firstVisibleRgbaBase64`,
  );
  const firstMetadata = exactMetadata(
    firstFrameReport?.game?.firstPresentedXfb?.readback?.metadata,
    `${game.key}.artifacts.firstFrameReportJson.firstPresentedXfb.readback.metadata`,
  );
  if (firstVisibleRgba.byteLength !== firstMetadata.width * firstMetadata.height * 4) {
    fail(`${game.key}.artifacts.firstVisibleRgbaBase64 does not match report extent`);
  }
  if (
    firstFrameReport.game.firstPresentedXfb.readback.rgbaBytes !== firstVisibleRgba.byteLength
    || firstFrameReport.game.firstPresentedXfb.readback.rgbaSha256 !== hashBytes(firstVisibleRgba)
  ) fail(`${game.key}.artifacts.firstVisibleRgbaBase64 does not match the frozen report`);
  const baselineGameFidelity = exactEnvelope(
    value.baselineGameFidelityRecord,
    `${game.key}.artifacts.baselineGameFidelityRecord`,
    GAME_FIDELITY_BYTES,
  );
  const baselineMachineEvidence = exactEnvelope(
    value.baselineMachineEvidence,
    `${game.key}.artifacts.baselineMachineEvidence`,
    MACHINE_EVIDENCE_BYTES,
  );
  decodeMachineEvidence(
    baselineMachineEvidence,
    game,
    `${game.key}.artifacts.baselineMachineEvidence`,
  );
  const baselineMetadata = exactMetadata(
    value.baselineMetadata,
    `${game.key}.artifacts.baselineMetadata`,
  );
  const baselineRgba = bytesFromCanonicalBase64(
    value.baselineRgbaBase64,
    `${game.key}.artifacts.baselineRgbaBase64`,
    baselineMetadata.width * baselineMetadata.height * 4,
  );
  const preWitness = exactEnvelope(
    value.preWitnessMachineEvidence,
    `${game.key}.artifacts.preWitnessMachineEvidence`,
    MACHINE_EVIDENCE_BYTES,
  );
  decodeMachineEvidence(preWitness, game, `${game.key}.artifacts.preWitnessMachineEvidence`);
  const terminalGameFidelity = exactEnvelope(
    value.terminalGameFidelityRecord,
    `${game.key}.artifacts.terminalGameFidelityRecord`,
    GAME_FIDELITY_BYTES,
  );
  const terminalMachineEvidence = exactEnvelope(
    value.terminalMachineEvidence,
    `${game.key}.artifacts.terminalMachineEvidence`,
    MACHINE_EVIDENCE_BYTES,
  );
  decodeMachineEvidence(
    terminalMachineEvidence,
    game,
    `${game.key}.artifacts.terminalMachineEvidence`,
  );
  const acceptedMetadata = exactMetadata(
    value.acceptedMetadata,
    `${game.key}.artifacts.acceptedMetadata`,
  );
  const acceptedRgba = bytesFromCanonicalBase64(
    value.acceptedRgbaBase64,
    `${game.key}.artifacts.acceptedRgbaBase64`,
    acceptedMetadata.width * acceptedMetadata.height * 4,
  );
  return Object.freeze({
    ready,
    firstFrameReport,
    firstFrameReportBytes: Buffer.from(value.firstFrameReportJson, "utf8"),
    firstVisibleRgba,
    baselineGameFidelity,
    baselineMachineEvidence,
    baselineMetadata,
    baselineRgba,
    preWitness,
    terminalGameFidelity,
    terminalMachineEvidence,
    acceptedMetadata,
    acceptedRgba,
  });
}

export function validateCaptureJournal(bytes, input) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) fail(`checkpoint journal for ${input.game.key} is not newline terminated`);
  const records = parseFidelityCheckpointJsonl(text);
  if (records.length === 0) fail(`checkpoint journal for ${input.game.key} is empty`);
  for (const record of records) {
    if (
      record.payload?.runId !== input.lock.run.runId
      || record.payload?.gameKey !== input.game.key
    ) {
      fail(`checkpoint journal identity changed for ${input.game.key}`);
    }
  }
  if (records.at(-1)?.payload?.kind !== "fidelity-terminal") {
    fail(`checkpoint journal for ${input.game.key} does not end at fidelity-terminal`);
  }
  const evidenceLockSha256 = hashBytes(input.lockBytes);
  const summary = validateFidelityCheckpointJournal(records, {
    requireResolved: true,
    probeEventCap: input.lock.checkpointPolicy.probeEventRunCap,
    evidenceLockSha256,
    expectedHostIdentitySha256: expectedFidelityHostIdentitySha256(
      input.lock,
      evidenceLockSha256,
      lockSelfAuthority(input.lock),
    ),
    probeEventPolicy: "forbidden",
    capturePolicy: "required",
  });
  if (
    summary.runId !== input.lock.run.runId
    || summary.gameKey !== input.game.key
    || typeof summary.capture?.machineSessionId !== "string"
  ) fail(`checkpoint journal authority changed for ${input.game.key}`);
  return records;
}

function containedRelative(root, pathname) {
  const relative = path.relative(root, pathname);
  if (
    relative === ""
    || relative.startsWith(`..${path.sep}`)
    || relative === ".."
    || path.isAbsolute(relative)
  ) fail("evidence leaf escaped the output directory");
  return relative.split(path.sep).join("/");
}

export async function writePrivateLeafAtomic(root, relativePath, bytesValue) {
  const bytes = Buffer.isBuffer(bytesValue) ? bytesValue : Buffer.from(bytesValue);
  if (bytes.byteLength <= 0) fail(`${relativePath} is empty`);
  const destination = path.resolve(root, relativePath);
  containedRelative(path.resolve(root), destination);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const directory = await open(path.dirname(destination), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const metadata = await stat(destination);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    fail(`${relativePath} is not a regular mode-0600 file`);
  }
  return Object.freeze({
    path: containedRelative(path.resolve(root), destination),
    bytes: bytes.byteLength,
    sha256: hashBytes(bytes),
  });
}

export function productionFidelityRunFragment(runValue) {
  exactKeys(runValue, [
    "key",
    "runId",
    "capturedAt",
    "releaseId",
    "executionAssetsSha256",
    "evidenceLock",
    "checkpointJournal",
    "firstFrameReport",
    "readyMachineEvidence",
    "baselineGameFidelityRecord",
    "baselineMachineEvidence",
    "preWitnessMachineEvidence",
    "terminalMachineEvidence",
    "gameFidelityRecord",
    "operatorPublications",
    "frames",
  ], "run fragment run");
  exactKeys(runValue.frames, ["firstVisible", "baseline", "later"], "run fragment frames");
  exactKeys(runValue.frames.baseline, ["metadata", "rgba"], "run fragment baseline frame");
  exactKeys(runValue.frames.later, ["metadata", "rgba"], "run fragment later frame");
  return Object.freeze({
    schema: PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA,
    run: runValue,
  });
}

async function writeGameLeaves(
  root,
  input,
  artifacts,
  journalBytes,
  capturedAt,
  operatorPublicationCount,
) {
  const prefix = `games/${String(input.game.priority).padStart(2, "0")}-${input.game.key}`;
  const leaf = (name, bytes) => writePrivateLeafAtomic(root, `${prefix}/${name}`, bytes);
  const [
    evidenceLock,
    checkpointJournal,
    firstFrameReport,
    readyMachineEvidence,
    baselineGameFidelityRecord,
    baselineMachineEvidence,
    baselineMetadata,
    baselineRgba,
    preWitnessMachineEvidence,
    terminalMachineEvidence,
    gameFidelityRecord,
    acceptedMetadata,
    acceptedRgba,
    firstVisible,
  ] = await Promise.all([
    leaf("evidence-lock.json", input.lockBytes),
    leaf("checkpoint-journal.jsonl", journalBytes),
    leaf("first-frame-report.json", artifacts.firstFrameReportBytes),
    leaf("ready-machine-evidence.json", canonicalBytes(artifacts.ready)),
    leaf("baseline-game-fidelity.json", canonicalBytes(artifacts.baselineGameFidelity)),
    leaf("baseline-machine-evidence.json", canonicalBytes(artifacts.baselineMachineEvidence)),
    leaf("baseline-readback-metadata.json", canonicalBytes(artifacts.baselineMetadata)),
    leaf("baseline.rgba", artifacts.baselineRgba),
    leaf("pre-witness-machine-evidence.json", canonicalBytes(artifacts.preWitness)),
    leaf("terminal-machine-evidence.json", canonicalBytes(artifacts.terminalMachineEvidence)),
    leaf("terminal-game-fidelity.json", canonicalBytes(artifacts.terminalGameFidelity)),
    leaf("accepted-readback-metadata.json", canonicalBytes(artifacts.acceptedMetadata)),
    leaf("accepted.rgba", artifacts.acceptedRgba),
    leaf("first-visible.rgba", artifacts.firstVisibleRgba),
  ]);
  const run = Object.freeze({
    key: input.game.key,
    runId: input.lock.run.runId,
    capturedAt,
    releaseId: input.lock.release.releaseId,
    executionAssetsSha256: input.lock.release.executionAssetsSha256,
    evidenceLock,
    checkpointJournal,
    firstFrameReport,
    readyMachineEvidence,
    baselineGameFidelityRecord,
    baselineMachineEvidence,
    preWitnessMachineEvidence,
    terminalMachineEvidence,
    gameFidelityRecord,
    operatorPublications: Object.freeze({
      algorithm: input.lock.capturePolicy.genericOperatorPolicy.algorithm,
      count: operatorPublicationCount,
    }),
    frames: Object.freeze({
      firstVisible,
      baseline: Object.freeze({ metadata: baselineMetadata, rgba: baselineRgba }),
      later: Object.freeze({ metadata: acceptedMetadata, rgba: acceptedRgba }),
    }),
  });
  const fragment = productionFidelityRunFragment(run);
  await leaf("run-fragment.json", canonicalBytes(fragment));
  return fragment;
}

async function captureOne(session, input, options, navigationBinding) {
  let finished = false;
  try {
    let current = await evaluateCapture(
      session,
      "snapshot",
      undefined,
      input.game,
      options.requestTimeoutMs,
      navigationBinding,
    );
    if (current.state.phase !== 0 && current.state.phase !== 1) {
      fail(`${input.game.key} initial snapshot was neither phase 0 nor Baseline`);
    }
    const sessionId = current.state.machineSessionId;
    let operatorPublications = 0;

    const initialArtifacts = object(current.state.artifacts, `${input.game.key}.initialArtifacts`);
    if (typeof initialArtifacts.firstFrameReportJson !== "string") {
      fail(`${input.game.key} did not freeze its first-frame report before stepping`);
    }
    let report;
    try {
      report = JSON.parse(initialArtifacts.firstFrameReportJson);
    } catch (error) {
      fail(`${input.game.key} first-frame report is invalid: ${error.message}`);
    }
    const firstEnvelope = report?.game?.adapterDiagnostics?.final?.machineEvidence;
    const firstSummary = decodeMachineEvidence(
      firstEnvelope,
      input.game,
      `${input.game.key}.firstFrameReport.machineEvidence`,
    );

    let steps = 0;
    let baselineObserved = current.state.phase === 1;
    while (
      current.state.phase !== 1
      || !sustainedWindowReached(firstSummary, current.summary, {
        minimumViFields: input.lock.capturePolicy.minimumViFieldDeltaFromFirstFrame,
        minimumPresentations:
          input.lock.capturePolicy.minimumPresentationDeltaFromFirstFrame,
      })
    ) {
      if (current.state.phase === 5 || current.state.phase === 6) {
        fail(`${input.game.key} crossed the witness boundary before publication`);
      }
      if (baselineObserved && current.state.phase !== 1) {
        fail(`${input.game.key} lost Rust Baseline before witness publication`);
      }
      if (current.state.phase === 1) baselineObserved = true;
      if (steps >= options.stepCap) fail(`${input.game.key} exhausted the controller step cap`);
      if (current.state.phase === 0) {
        const publishOperator = operatorPublicationDue(
          input.lock.capturePolicy.genericOperatorPolicy,
          steps,
          operatorPublications,
        );
        if (publishOperator) {
          current = await evaluateCapture(
            session,
            "operator",
            undefined,
            input.game,
            options.requestTimeoutMs,
            navigationBinding,
          );
          operatorPublications += 1;
          if (current.state.phase !== 0) {
            fail(`${input.game.key} left phase 0 during generic operator publication`);
          }
        }
      }
      current = await evaluateCapture(
        session,
        "step",
        undefined,
        input.game,
        options.requestTimeoutMs,
        navigationBinding,
      );
      steps += 1;
      if (current.state.machineSessionId !== sessionId) fail(`${input.game.key} changed machine session`);
    }

    current = await evaluateCapture(
      session,
      "publishWitness",
      undefined,
      input.game,
      options.requestTimeoutMs,
      navigationBinding,
    );
    if (current.state.phase !== 1) fail(`${input.game.key} witness publication was not phase 1`);
    if (current.state.machineSessionId !== sessionId) fail(`${input.game.key} changed machine session`);
    const retainedPreWitness = exactEnvelope(
      selectRetainedPreWitnessMachineEvidence(current.state),
      `${input.game.key}.publishWitness.artifacts.preWitnessMachineEvidence`,
      MACHINE_EVIDENCE_BYTES,
    );
    decodeMachineEvidence(
      retainedPreWitness,
      input.game,
      `${input.game.key}.publishWitness.artifacts.preWitnessMachineEvidence`,
    );
    const preWitnessMachineEvidence = canonicalCaptureJson(retainedPreWitness);
    while (current.state.phase !== 5) {
      if (current.state.phase === 6) fail(`${input.game.key} entered failed fidelity phase`);
      if (steps >= options.stepCap) fail(`${input.game.key} exhausted the controller step cap`);
      current = await evaluateCapture(
        session,
        "step",
        undefined,
        input.game,
        options.requestTimeoutMs,
        navigationBinding,
      );
      steps += 1;
      if (current.state.machineSessionId !== sessionId) fail(`${input.game.key} changed machine session`);
    }
    const acceptedMachineEvidence = canonicalCaptureJson(current.state.machineEvidence);
    const acceptedGameFidelity = canonicalCaptureJson(current.state.gameFidelity);
    const terminal = await evaluateCapture(
      session,
      "finish",
      undefined,
      input.game,
      options.requestTimeoutMs,
      navigationBinding,
    );
    finished = true;
    if (terminal.state.phase !== 5) fail(`${input.game.key} terminal query changed Accepted phase`);
    if (terminal.state.machineSessionId !== sessionId) fail(`${input.game.key} changed machine session`);
    if (
      !Number.isSafeInteger(terminal.state.runSummary.operatorPublications)
      || terminal.state.runSummary.operatorPublications < 0
      || terminal.state.runSummary.operatorPublications !== operatorPublications
    ) fail(`${input.game.key} terminal operator publication count changed`);
    if (canonicalCaptureJson(terminal.state.machineEvidence) !== acceptedMachineEvidence) {
      fail(`${input.game.key} terminal MachineEvidence changed from Accepted`);
    }
    const artifacts = exactArtifacts(terminal.state.artifacts, input.game);
    if (canonicalCaptureJson(artifacts.preWitness) !== preWitnessMachineEvidence) {
      fail(`${input.game.key} pre-witness artifact does not equal the witness checkpoint state`);
    }
    if (
      canonicalCaptureJson(artifacts.terminalMachineEvidence)
      !== canonicalCaptureJson(terminal.state.machineEvidence)
    ) fail(`${input.game.key} terminal artifact does not equal the terminal query`);
    if (
      canonicalCaptureJson(artifacts.terminalGameFidelity)
      !== canonicalCaptureJson(terminal.state.gameFidelity)
      || canonicalCaptureJson(artifacts.terminalGameFidelity) !== acceptedGameFidelity
    ) fail(`${input.game.key} terminal GameFidelity changed from Accepted`);
    const reportInputSamples = artifacts.firstFrameReport?.game?.inputSamples;
    if (reportInputSamples !== 0) {
      fail(`${input.game.key} first-frame report must precede every operator publication`);
    }
    return Object.freeze({ artifacts, operatorPublications });
  } finally {
    if (!finished) {
      await session.evaluate(captureCall("abort"), options.requestTimeoutMs).catch(() => {});
    }
  }
}

export async function runProductionFidelityCapture(options, {
  createSession = (url, sessionOptions) => new DevToolsSession(url, sessionOptions),
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const inputs = await loadInputs(options);
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const dedicated = await createDedicatedCaptureTarget(
    options.cdpEndpoint,
    createSession,
    fetchImpl,
    options.requestTimeoutMs,
  );
  const fragments = [];
  let pageSession = null;
  try {
    pageSession = createSession(dedicated.target.webSocketDebuggerUrl, {
      requestTimeoutMs: options.requestTimeoutMs,
    });
    await pageSession.connect();
    await pageSession.send("Runtime.enable", {}, options.requestTimeoutMs);
    await pageSession.send("Page.enable", {}, options.requestTimeoutMs);
    await pageSession.send("Page.bringToFront", {}, options.requestTimeoutMs);
    for (const input of inputs.ordered) {
      let navigated = false;
      let captured;
      try {
        const binding = await navigateDedicatedPage(
          pageSession,
          input.captureUrl,
          options.requestTimeoutMs,
        );
        navigated = true;
        captured = await captureOne(pageSession, input, options, binding);
      } finally {
        if (navigated) await unloadDedicatedPage(pageSession, options.requestTimeoutMs);
      }
      const journalBytes = await readFile(input.journalPath);
      validateCaptureJournal(journalBytes, input);
      fragments.push(await writeGameLeaves(
        options.outputDirectory,
        input,
        captured.artifacts,
        journalBytes,
        now().toISOString(),
        captured.operatorPublications,
      ));
    }
  } finally {
    pageSession?.close();
    let closed;
    try {
      closed = await dedicated.browserSession.send(
        "Target.closeTarget",
        { targetId: dedicated.target.id },
        options.requestTimeoutMs,
      );
    } finally {
      dedicated.browserSession.close();
    }
    if (closed.success !== true) fail("dedicated CDP target did not close");
  }
  return Object.freeze(fragments);
}

async function main() {
  const options = parseCaptureArguments(process.argv.slice(2));
  const fragments = await runProductionFidelityCapture(options);
  process.stdout.write(`${canonicalCaptureJson(fragments)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
