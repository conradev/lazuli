#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { sha256Hex, validateRelease } from "../web/release.mjs";
import {
  canonicalStringify,
} from "./browser_boot_checkpoint_core.mjs";
import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";
import { DevToolsSession } from "./browser_boot_headless_cdp.mjs";
import {
  GAME_FIRST_PLAYABLE_BUTTONS,
  deriveGameFirstPlayableTranscript,
} from "./browser_game_first_playable_transcript.mjs";
import {
  BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
  BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
} from "./browser_game_compatibility_iab_gate.mjs";
import {
  readGameCompatibilityCorpus,
  validateGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  verifyGameCompatibilitySnapshot,
  verifyGameFirstVisibleFrameCompatibility,
} from "./browser_game_compatibility_oracle.mjs";
import {
  assignPublicDisc,
  clearPublicViewport,
  configurePublicViewport,
  expectedPublicFrameUrl,
  publicDelay,
  publicPageTarget,
  publicReleaseState,
  requestPublicSnapshot,
  waitForPublicRelease,
  waitForPublicRunner,
  waitForPublicSnapshot,
} from "./browser_public_cdp.mjs";

export const BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_DEFAULTS = Object.freeze({
  endpoint: "http://127.0.0.1:9222/",
  pollMs: 1_000,
  publicUrl: "http://127.0.0.1:8768/",
  timeoutMs: 60 * 60 * 1_000,
});

export const BROWSER_GAME_COMPATIBILITY_IAB_WITNESS_BUTTONS = Object.freeze({
  "warioware-usa": "a",
  "luigis-mansion-usa": "left",
  "wind-waker-usa": "left",
  "melee-usa-rev-2": "left",
  "f-zero-gx-usa": "left",
  "metroid-prime-usa-rev-2": "left",
  "rogue-leader-usa": "left",
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_RUN_PATTERN = /^[1-9][0-9]*$/;
const FULL_ACTIVE_RELEASE_OBSERVATION = `(async () => {
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

function fail(message) {
  throw new Error(`browser game compatibility IAB capture: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return value;
}

function exactCanonical(actual, expected, label) {
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    fail(`${label} changed from the prepared value`);
  }
  return actual;
}

function exactUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(`${label} must be a UUID`);
  }
  return value;
}

function gameOrder(corpus) {
  return [...corpus.games].sort((left, right) => left.priority - right.priority);
}

export function configuredBrowserGameCompatibilityIabUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("--url must be an absolute URL");
  }
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail("--url must be an exact queryless loopback HTTP root");
  }
  return url.href;
}

function configuredEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("--endpoint must be an absolute HTTP URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail("--endpoint must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return url.href;
}

async function requirePrivateSessionFile(path, lstatFile = lstat) {
  let metadata;
  try {
    metadata = await lstatFile(path);
  } catch (error) {
    fail(`could not inspect private session ${path}: ${error.message ?? String(error)}`);
  }
  if (!metadata.isFile()) fail(`private session is not a regular non-symlink file: ${path}`);
  if ((metadata.mode & 0o777) !== 0o600) {
    fail(`private session must have mode 0600: ${path}`);
  }
  return metadata;
}

async function readJson(path, label, read = readFile) {
  try {
    return JSON.parse(await read(path, "utf8"));
  } catch (error) {
    fail(`could not read ${label} ${path}: ${error.message ?? String(error)}`);
  }
}

function validatePartialEvidence(session, corpus) {
  const evidence = exactKeys(
    session.evidence,
    ["captures", "schema", "sessionId", "smb"],
    "session.evidence",
  );
  if (evidence.schema !== BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA) {
    fail(`session.evidence.schema must be ${BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA}`);
  }
  if (evidence.sessionId !== session.id) fail("session evidence ID does not match session ID");
  if (!Array.isArray(evidence.captures)) fail("session evidence captures must be an array");
  const priorities = new Map(corpus.games.map(game => [game.key, game.priority]));
  let previousPriority = 0;
  const seen = new Set();
  for (let index = 0; index < evidence.captures.length; index += 1) {
    const capture = object(evidence.captures[index], `session.evidence.captures[${index}]`);
    const priority = priorities.get(capture.gameKey);
    if (priority === undefined) fail(`capture ${index} has an unknown game key`);
    if (seen.has(capture.gameKey)) fail(`capture ${index} duplicates ${capture.gameKey}`);
    if (priority <= previousPriority) fail("session captures are not in corpus priority order");
    seen.add(capture.gameKey);
    previousPriority = priority;
  }
  return evidence;
}

export async function readBrowserGameCompatibilityIabCaptureSession(
  sessionPath,
  {
    lstatFile = lstat,
    read = readFile,
    readCorpus = readGameCompatibilityCorpus,
  } = {},
) {
  const path = resolve(sessionPath);
  await requirePrivateSessionFile(path, lstatFile);
  const session = exactKeys(
    await readJson(path, "IAB compatibility session", read),
    ["evidence", "id", "inputs", "schema"],
    "session",
  );
  if (session.schema !== BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA) {
    fail(`session.schema must be ${BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA}`);
  }
  exactUuid(session.id, "session.id");
  const inputs = exactKeys(
    session.inputs,
    ["corpus", "games", "release", "smb"],
    "session.inputs",
  );
  const corpusInput = exactKeys(
    inputs.corpus,
    ["path", "sha256", "value"],
    "session.inputs.corpus",
  );
  validateGameCompatibilityCorpus(corpusInput.value);
  const repositoryCorpus = await readCorpus();
  exactCanonical(corpusInput.value, repositoryCorpus, "prepared corpus");
  if (
    corpusInput.sha256
    !== await sha256Hex(canonicalStringify(repositoryCorpus))
  ) {
    fail("prepared corpus digest does not match its canonical value");
  }
  const releaseInput = exactKeys(
    inputs.release,
    ["path", "value"],
    "session.inputs.release",
  );
  await validateRelease(releaseInput.value);
  const gamesInput = exactKeys(
    inputs.games,
    ["directory", "images"],
    "session.inputs.games",
  );
  if (typeof gamesInput.directory !== "string" || gamesInput.directory.length === 0) {
    fail("session.inputs.games.directory must be a non-empty path");
  }
  if (!Array.isArray(gamesInput.images) || gamesInput.images.length !== repositoryCorpus.games.length) {
    fail("session.inputs.games.images must contain every corpus game");
  }
  validatePartialEvidence(session, repositoryCorpus);
  return { corpus: repositoryCorpus, path, session };
}

export function browserGameCompatibilityIabCaptureStatus(session, corpus) {
  validateGameCompatibilityCorpus(corpus);
  validatePartialEvidence(session, corpus);
  const ordered = gameOrder(corpus).map(game => game.key);
  const completed = session.evidence.captures.map(capture => capture.gameKey);
  const completeSet = new Set(completed);
  const pending = ordered.filter(key => !completeSet.has(key));
  return Object.freeze({
    schema: BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
    id: session.id,
    smb: session.evidence.smb === null ? "pending" : "captured",
    games: Object.freeze({
      captured: Object.freeze(completed),
      pending: Object.freeze(pending),
      next: pending[0] ?? null,
    }),
    captureComplete: pending.length === 0,
    suiteComplete: pending.length === 0 && session.evidence.smb !== null,
  });
}

export function mergeBrowserGameCompatibilityIabCapture(session, corpus, capture) {
  validateGameCompatibilityCorpus(corpus);
  validatePartialEvidence(session, corpus);
  object(capture, "capture");
  const priorities = new Map(corpus.games.map(game => [game.key, game.priority]));
  if (!priorities.has(capture.gameKey)) fail("capture has an unknown game key");
  const existing = session.evidence.captures.find(
    candidate => candidate.gameKey === capture.gameKey,
  );
  if (existing !== undefined) {
    if (canonicalStringify(existing) !== canonicalStringify(capture)) {
      fail(`refusing to replace different evidence for ${capture.gameKey}`);
    }
    return Object.freeze({ changed: false, session });
  }
  const updated = structuredClone(session);
  updated.evidence.captures.push(structuredClone(capture));
  updated.evidence.captures.sort(
    (left, right) => priorities.get(left.gameKey) - priorities.get(right.gameKey),
  );
  validatePartialEvidence(updated, corpus);
  return Object.freeze({ changed: true, session: updated });
}

export async function writePrivateIabSessionAtomic(
  path,
  value,
  {
    makeId = randomUUID,
    renameFile = rename,
    removeFile = rm,
    write = writeFile,
  } = {},
) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}-${makeId()}`;
  try {
    await write(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await renameFile(temporary, target);
  } catch (error) {
    await removeFile(temporary, { force: true });
    throw error;
  }
  await requirePrivateSessionFile(target);
}

export async function withPrivateIabSessionLock(
  sessionPath,
  callback,
  {
    delay = publicDelay,
    lockPollMs = 25,
    lockTimeoutMs = 30_000,
    openFile = open,
    removeFile = rm,
  } = {},
) {
  if (typeof callback !== "function") fail("session lock callback must be a function");
  if (!Number.isInteger(lockPollMs) || lockPollMs <= 0) {
    fail("session lock poll interval must be a positive integer");
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < lockPollMs) {
    fail("session lock timeout must be at least its poll interval");
  }
  const lockPath = `${resolve(sessionPath)}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  let handle = null;
  while (handle === null) {
    try {
      handle = await openFile(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        fail(`timed out waiting for private session lock ${lockPath}`);
      }
      await delay(lockPollMs);
    }
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      fail(`private session lock must be a regular mode-0600 file: ${lockPath}`);
    }
    return await callback({ lockPath });
  } finally {
    try {
      await handle.close();
    } finally {
      await removeFile(lockPath, { force: true });
    }
  }
}

async function validateCurrentInputs(prepared, game, {
  identify = identifyLocalDiscImage,
  statFile = stat,
} = {}) {
  const release = await readJson(
    prepared.session.inputs.release.path,
    "current release manifest",
  );
  await validateRelease(release);
  exactCanonical(release, prepared.session.inputs.release.value, "release manifest");
  const imageRecord = prepared.session.inputs.games.images.find(
    image => image.key === game.key,
  );
  if (imageRecord === undefined) fail(`prepared inputs have no image for ${game.key}`);
  const discPath = resolve(prepared.session.inputs.games.directory, game.file);
  const metadata = await statFile(discPath);
  if (!metadata.isFile() || metadata.size !== game.bytes) {
    fail(`local image size changed for ${game.key}`);
  }
  const identity = await identify(discPath);
  exactCanonical(identity, { algorithm: "sha256", ...game.image }, `${game.key} image`);
  exactCanonical(imageRecord.image, identity, `${game.key} prepared image`);
  return { discPath, identity, release };
}

export async function observeBrowserGameCompatibilityIabActiveRelease(
  session,
  { expectedRelease, publicUrl },
) {
  const observation = await session.evaluate(FULL_ACTIVE_RELEASE_OBSERVATION);
  object(observation, "active-release observation");
  if (observation.controlled !== true) fail("public page has no service-worker controller");
  if (observation.error !== null) fail(`active-release fetch failed: ${observation.error}`);
  if (observation.status !== 200) fail(`active-release fetch returned HTTP ${observation.status}`);
  if (observation.pathname !== new URL(publicUrl).pathname) {
    fail("active release was observed from the wrong public path");
  }
  let manifest;
  try {
    manifest = JSON.parse(observation.body);
  } catch {
    fail("active-release response was not JSON");
  }
  await validateRelease(manifest);
  exactCanonical(manifest, expectedRelease, "observed active release");
  return manifest;
}

function frontendIdentity(state, { activeRelease, publicUrl }) {
  if (state.topUrl !== publicUrl) fail("public top-level URL changed");
  const frameUrl = expectedPublicFrameUrl(publicUrl, activeRelease);
  if (state.frameUrl !== frameUrl) fail("immutable frontend URL changed");
  const documentId = state.dataset?.documentId;
  const workerRunId = state.dataset?.workerRunId;
  exactUuid(documentId, "frontend document ID");
  if (typeof workerRunId !== "string" || !WORKER_RUN_PATTERN.test(workerRunId)) {
    fail("frontend worker-run ID is invalid");
  }
  if (workerRunId !== "1") fail(`expected worker-run ID 1, got ${workerRunId}`);
  return { documentId, frameUrl, pageUrl: publicUrl, workerRunId };
}

async function verifyObservedIdentity(value, {
  expectedRelease,
  expectedIdentity = null,
  label,
}) {
  const identity = exactKeys(
    value,
    ["activeRelease", "documentId", "frameUrl", "pageUrl", "workerRunId"],
    label,
  );
  await validateRelease(identity.activeRelease);
  exactCanonical(identity.activeRelease, expectedRelease, `${label}.activeRelease`);
  const pageUrl = configuredBrowserGameCompatibilityIabUrl(identity.pageUrl);
  if (identity.frameUrl !== expectedPublicFrameUrl(pageUrl, expectedRelease)) {
    fail(`${label}.frameUrl does not name the immutable frontend`);
  }
  exactUuid(identity.documentId, `${label}.documentId`);
  if (identity.workerRunId !== "1") fail(`${label}.workerRunId must be 1`);
  if (expectedIdentity !== null) {
    exactCanonical(identity, expectedIdentity, label);
  }
  return identity;
}

export async function verifyBrowserGameCompatibilityIabGameCapture({
  capture,
  corpus,
  gameKey,
  release,
  sessionId,
}) {
  validateGameCompatibilityCorpus(corpus);
  await validateRelease(release);
  exactUuid(sessionId, "sessionId");
  const game = corpus.games.find(candidate => candidate.key === gameKey);
  if (game === undefined) fail(`unknown corpus game ${JSON.stringify(gameKey)}`);
  const value = exactKeys(
    capture,
    ["firstPlayable", "gameKey", "observed", "snapshots"],
    "capture",
  );
  if (value.gameKey !== game.key) fail(`capture.gameKey must be ${game.key}`);
  const observed = exactKeys(value.observed, ["after", "before"], "capture.observed");
  const before = await verifyObservedIdentity(observed.before, {
    expectedRelease: release,
    label: "capture.observed.before",
  });
  await verifyObservedIdentity(observed.after, {
    expectedIdentity: before,
    expectedRelease: release,
    label: "capture.observed.after",
  });
  if (!Array.isArray(value.snapshots) || value.snapshots.length < 2) {
    fail("capture.snapshots must contain at least two samples");
  }
  for (let index = 0; index < value.snapshots.length; index += 1) {
    const label = `capture.snapshots[${index}]`;
    const snapshot = exactKeys(
      value.snapshots[index],
      ["environment", "report"],
      label,
    );
    const environment = exactKeys(
      snapshot.environment,
      ["captureIdentity", "dataset", "devtoolsExceptions", "discImage", "surface"],
      `${label}.environment`,
    );
    if (environment.surface !== "public-root") {
      fail(`${label}.environment.surface must be public-root`);
    }
    exactCanonical(
      environment.dataset,
      { renderer: "wgpu-webgpu", status: "running" },
      `${label}.environment.dataset`,
    );
    if (
      !Array.isArray(environment.devtoolsExceptions)
      || environment.devtoolsExceptions.length !== 0
    ) {
      fail(`${label}.environment.devtoolsExceptions must be empty`);
    }
    exactCanonical(
      environment.discImage,
      { algorithm: "sha256", ...game.image },
      `${label}.environment.discImage`,
    );
    exactCanonical(
      environment.captureIdentity,
      {
        documentId: before.documentId,
        sessionId,
        workerRunId: before.workerRunId,
      },
      `${label}.environment.captureIdentity`,
    );
    if (Object.hasOwn(snapshot.report, "headlessCapture")) {
      fail(`${label}.report must not contain headlessCapture`);
    }
    if (snapshot.report.disc?.source?.kind !== "local-file") {
      fail(`${label}.report.disc.source.kind must be local-file`);
    }
  }
  const selection = exactKeys(
    value.firstPlayable,
    ["button", "postIndex", "preIndex"],
    "capture.firstPlayable",
  );
  controllerButton(selection.button);
  if (
    !Number.isSafeInteger(selection.preIndex)
    || selection.preIndex < 0
    || !Number.isSafeInteger(selection.postIndex)
    || selection.postIndex <= selection.preIndex
    || selection.postIndex >= value.snapshots.length
  ) {
    fail("capture.firstPlayable indexes must name an ordered snapshot pair");
  }
  const transcript = deriveGameFirstPlayableTranscript({
    button: selection.button,
    corpus,
    gameKey: game.key,
    postSnapshot: value.snapshots[selection.postIndex],
    preSnapshot: value.snapshots[selection.preIndex],
  });
  const window = verifyGameFirstVisibleFrameCompatibility({
    game,
    snapshots: value.snapshots,
    sustainedViFields: corpus.evidence.sustainedViFields,
    viewportFrames: corpus.evidence.viewportFrames,
  });
  return Object.freeze({ transcript, window });
}

async function observePinnedNavigation(
  session,
  { expectedFrameUrl, expectedNavigation = null, navigationLoaderId, publicUrl },
) {
  const tree = await session.send("Page.getFrameTree");
  const top = tree.frameTree?.frame;
  if (
    typeof top?.id !== "string"
    || top.id.length === 0
    || top.loaderId !== navigationLoaderId
    || top.url !== publicUrl
  ) {
    fail(`top-level navigation is not pinned: ${JSON.stringify(top)}`);
  }
  const frames = (tree.frameTree?.childFrames ?? [])
    .map(child => child?.frame)
    .filter(frame => frame?.url === expectedFrameUrl);
  if (
    frames.length !== 1
    || typeof frames[0]?.id !== "string"
    || frames[0].id.length === 0
    || typeof frames[0].loaderId !== "string"
    || frames[0].loaderId.length === 0
  ) {
    fail(`immutable frontend navigation is not uniquely pinned: ${JSON.stringify(frames)}`);
  }
  const identity = {
    top: { frameId: top.id, loaderId: top.loaderId, url: top.url },
    iframe: {
      frameId: frames[0].id,
      loaderId: frames[0].loaderId,
      url: frames[0].url,
    },
  };
  if (expectedNavigation !== null) {
    exactCanonical(identity, expectedNavigation, "pinned navigation");
  }
  return identity;
}

function usedDocumentIds(session) {
  const ids = new Set();
  if (session.evidence.smb?.observed?.before?.documentId !== undefined) {
    ids.add(session.evidence.smb.observed.before.documentId);
  }
  for (const capture of session.evidence.captures) {
    if (capture.observed?.before?.documentId !== undefined) {
      ids.add(capture.observed.before.documentId);
    }
  }
  return ids;
}

function controllerButton(value) {
  if (!Object.hasOwn(GAME_FIRST_PLAYABLE_BUTTONS, value)) {
    fail(`unsupported controller button ${JSON.stringify(value)}`);
  }
  return value;
}

export async function dispatchBrowserGameCompatibilityIabControllerClick(
  session,
  button,
  { holdMs = 80, delay = publicDelay } = {},
) {
  const name = controllerButton(button);
  const selector = `#controller-${name}`;
  const point = await session.evaluate(`(() => {
    const frame = document.querySelector("#app");
    const frameDocument = frame?.contentDocument ?? null;
    const frameWindow = frame?.contentWindow ?? null;
    const element = frameDocument?.querySelector(${JSON.stringify(selector)}) ?? null;
    if (!(element instanceof frameWindow?.HTMLButtonElement)) return null;
    const style = frameWindow.getComputedStyle(element);
    const frameRect = frame.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const localX = rect.left + rect.width / 2;
    const localY = rect.top + rect.height / 2;
    const hit = frameDocument.elementFromPoint(localX, localY);
    const x = frameRect.left + frame.clientLeft + localX;
    const y = frameRect.top + frame.clientTop + localY;
    return {
      disabled: element.disabled,
      height: rect.height,
      hit: hit === element || element.contains(hit),
      topHit: document.elementFromPoint(x, y) === frame,
      visibility: style.visibility,
      display: style.display,
      width: rect.width,
      x,
      y,
    };
  })()`);
  if (
    point === null
    || point.disabled !== false
    || point.hit !== true
    || point.topHit !== true
    || point.display === "none"
    || point.visibility !== "visible"
    || !Number.isFinite(point.width)
    || !Number.isFinite(point.height)
    || point.width <= 0
    || point.height <= 0
    || !Number.isFinite(point.x)
    || !Number.isFinite(point.y)
  ) {
    fail(`visible controller button ${name} is unavailable: ${JSON.stringify(point)}`);
  }
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await session.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: point.x,
    y: point.y,
  });
  await delay(holdMs);
  await session.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: point.x,
    y: point.y,
  });
  return Object.freeze({ button: name, x: point.x, y: point.y });
}

function publicSnapshot({ game, identity, report, session, sessionId, state }) {
  return {
    environment: {
      captureIdentity: {
        documentId: identity.documentId,
        sessionId,
        workerRunId: identity.workerRunId,
      },
      dataset: {
        renderer: state.dataset.renderer,
        status: state.dataset.status,
      },
      devtoolsExceptions: structuredClone(session.exceptions),
      discImage: { algorithm: "sha256", ...game.image },
      surface: "public-root",
    },
    report,
  };
}

async function captureHealthySnapshot(
  session,
  { deadline, game, identity, pollMs, sessionId },
) {
  const requestId = await requestPublicSnapshot(session);
  const { report, state } = await waitForPublicSnapshot(session, {
    deadline,
    pollMs,
    requestId,
  });
  const snapshot = publicSnapshot({ game, identity, report, session, sessionId, state });
  verifyGameCompatibilitySnapshot({ ...snapshot, game });
  return snapshot;
}

function snapshotProgress(snapshot) {
  const report = snapshot.report;
  const vi = report.mmioState.viInterruptModel;
  return Object.freeze({
    cycles: report.cycles,
    dispatches: report.dispatches,
    guestGame: report.guestGame === undefined
      ? null
      : Object.keys(report.guestGame).sort(),
    hostPresentations: vi.hostPresentationCount,
    instructions: report.instructions,
    pc: report.pc,
    presentationSerial: vi.lastHostPresentationSerial,
    rgbSha256: report.rendering.selectedXfb.rgbSha256,
    viFields: report.deviceEvents.viField,
  });
}

function strictlyAfter(candidate, previous) {
  return ["cycles", "dispatches", "instructions"].every(
    name => candidate.report[name] > previous.report[name],
  );
}

function compactWitnessSnapshots(pre, witness, distinct, latest) {
  const candidates = [pre, witness, distinct, latest].filter(Boolean);
  const byCycles = new Map(candidates.map(snapshot => [snapshot.report.cycles, snapshot]));
  return [...byCycles.values()].sort(
    (left, right) => left.report.cycles - right.report.cycles,
  );
}

async function captureWitness(
  session,
  {
    button,
    corpus,
    deadline,
    emit,
    game,
    identity,
    pollMs,
    sessionId,
  },
) {
  const pre = await captureHealthySnapshot(session, {
    deadline,
    game,
    identity,
    pollMs,
    sessionId,
  });
  emit({ event: "witness-pre", button, ...snapshotProgress(pre) });
  await dispatchBrowserGameCompatibilityIabControllerClick(session, button);
  let witness = null;
  let distinct = null;
  let latest = pre;
  let lastTranscriptError = null;
  let lastWindowError = null;
  while (Date.now() < deadline) {
    await publicDelay(pollMs);
    let candidate;
    try {
      candidate = await captureHealthySnapshot(session, {
        deadline,
        game,
        identity,
        pollMs,
        sessionId,
      });
    } catch (error) {
      emit({ event: "witness-sample-rejected", error: error.message ?? String(error) });
      continue;
    }
    if (!strictlyAfter(candidate, latest)) continue;
    latest = candidate;
    emit({ event: "witness-sample", ...snapshotProgress(candidate) });
    if (
      distinct === null
      && candidate.report.rendering.selectedXfb.rgbSha256
        !== pre.report.rendering.selectedXfb.rgbSha256
    ) {
      distinct = candidate;
    }
    if (witness === null) {
      try {
        deriveGameFirstPlayableTranscript({
          button,
          corpus,
          gameKey: game.key,
          postSnapshot: candidate,
          preSnapshot: pre,
        });
        witness = candidate;
        emit({ event: "guest-witness", ...snapshotProgress(candidate) });
      } catch (error) {
        lastTranscriptError = error;
      }
    }
    if (witness === null) continue;
    const snapshots = compactWitnessSnapshots(pre, witness, distinct, latest);
    const postIndex = snapshots.indexOf(witness);
    try {
      verifyGameFirstVisibleFrameCompatibility({
        game,
        snapshots,
        sustainedViFields: corpus.evidence.sustainedViFields,
        viewportFrames: corpus.evidence.viewportFrames,
      });
      deriveGameFirstPlayableTranscript({
        button,
        corpus,
        gameKey: game.key,
        postSnapshot: witness,
        preSnapshot: pre,
      });
      return {
        firstPlayable: { button, postIndex, preIndex: 0 },
        snapshots,
      };
    } catch (error) {
      lastWindowError = error;
    }
  }
  fail(
    `witness timed out for ${game.key}: ${JSON.stringify({
      transcript: lastTranscriptError?.message ?? null,
      window: lastWindowError?.message ?? null,
    })}`,
  );
}

function parseInteractiveCommand(line) {
  const fields = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (fields.length === 0) return { command: "empty" };
  const [command, ...arguments_] = fields;
  if (command === "abort" || command === "preview") {
    if (arguments_.length !== 0) fail(`${command} takes no arguments`);
    return { command };
  }
  if (command === "press" || command === "witness") {
    if (arguments_.length > 1) fail(`${command} takes at most one button`);
    return {
      command,
      button: arguments_[0] === undefined ? null : controllerButton(arguments_[0]),
    };
  }
  fail(`unknown interactive command ${JSON.stringify(command)}`);
}

export async function persistBrowserGameCompatibilityIabCapture(
  { capture, corpus, original, sessionPath },
  {
    lockOptions = {},
    readSession = readBrowserGameCompatibilityIabCaptureSession,
    writeSession = writePrivateIabSessionAtomic,
  } = {},
) {
  return withPrivateIabSessionLock(sessionPath, async () => {
    const current = await readSession(sessionPath);
    if (current.session.id !== original.id) fail("session ID changed during capture");
    exactCanonical(current.session.inputs, original.inputs, "session inputs");
    const existing = current.session.evidence.captures.find(
      candidate => candidate.gameKey === capture.gameKey,
    );
    if (canonicalStringify(current.session) !== canonicalStringify(original)) {
      if (
        existing !== undefined
        && canonicalStringify(existing) === canonicalStringify(capture)
      ) {
        return Object.freeze({ changed: false, session: current.session });
      }
      fail("session changed while the title capture was in progress");
    }
    const merged = mergeBrowserGameCompatibilityIabCapture(
      current.session,
      corpus,
      capture,
    );
    if (merged.changed) await writeSession(sessionPath, merged.session);
    return merged;
  }, lockOptions);
}

export async function captureBrowserGameCompatibilityIabGame(
  options,
  {
    Session = DevToolsSession,
    commands = null,
    emit = value => process.stderr.write(`${JSON.stringify(value)}\n`),
  } = {},
) {
  const prepared = await readBrowserGameCompatibilityIabCaptureSession(options.sessionPath);
  const game = prepared.corpus.games.find(candidate => candidate.key === options.gameKey);
  if (game === undefined) fail(`unknown corpus game ${JSON.stringify(options.gameKey)}`);
  const existing = prepared.session.evidence.captures.find(
    capture => capture.gameKey === game.key,
  );
  if (existing !== undefined) {
    return Object.freeze({ capture: existing, changed: false, status: "already-captured" });
  }
  const expectedButton = BROWSER_GAME_COMPATIBILITY_IAB_WITNESS_BUTTONS[game.key];
  if (expectedButton === undefined) fail(`no witness button is declared for ${game.key}`);
  const inputs = await validateCurrentInputs(prepared, game);
  const target = await publicPageTarget(options.endpoint);
  const session = new Session(target.webSocketDebuggerUrl);
  await session.connect();
  let viewportConfigured = false;
  let ownedCommands = null;
  const commandSource = commands ?? (ownedCommands = createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
  }));
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("DOM.enable");
    await configurePublicViewport(session);
    viewportConfigured = true;
    const navigation = await session.send("Page.navigate", { url: options.publicUrl });
    if (navigation.errorText !== undefined) fail(`Page.navigate failed: ${navigation.errorText}`);
    if (typeof navigation.loaderId !== "string" || navigation.loaderId.length === 0) {
      fail("Page.navigate did not create a top-level document loader");
    }
    const deadline = Date.now() + options.timeoutMs;
    await waitForPublicRelease(session, {
      deadline,
      pollMs: options.pollMs,
      publicUrl: options.publicUrl,
    });
    const activeRelease = await observeBrowserGameCompatibilityIabActiveRelease(
      session,
      { expectedRelease: inputs.release, publicUrl: options.publicUrl },
    );
    const frameUrl = expectedPublicFrameUrl(options.publicUrl, activeRelease);
    await waitForPublicRelease(session, {
      deadline,
      expectedFrameUrl: frameUrl,
      pollMs: options.pollMs,
      publicUrl: options.publicUrl,
    });
    const pinnedNavigation = await observePinnedNavigation(session, {
      expectedFrameUrl: frameUrl,
      navigationLoaderId: navigation.loaderId,
      publicUrl: options.publicUrl,
    });
    await assignPublicDisc(session, inputs.discPath, {
      deadline,
      label: `${game.key} CISO`,
      pollMs: options.pollMs,
    });
    await waitForPublicRunner(session, {
      deadline,
      pollMs: options.pollMs,
      stoppedLabel: game.key,
    });
    const initialState = await publicReleaseState(session);
    const baseIdentity = frontendIdentity(initialState, {
      activeRelease,
      publicUrl: options.publicUrl,
    });
    if (usedDocumentIds(prepared.session).has(baseIdentity.documentId)) {
      fail("fresh title navigation reused a prior evidence document ID");
    }
    const before = { activeRelease, ...baseIdentity };
    emit({
      event: "ready",
      gameKey: game.key,
      milestone: game.milestone,
      witnessButton: expectedButton,
      commands: ["press [button]", "preview", "witness [button]", "abort"],
    });
    let witnessResult = null;
    for await (const line of commandSource) {
      let command;
      try {
        command = parseInteractiveCommand(line);
        if (command.command === "empty") continue;
        if (command.command === "abort") {
          return Object.freeze({ capture: null, changed: false, status: "aborted" });
        }
        if (command.command === "press") {
          const button = command.button ?? expectedButton;
          const click = await dispatchBrowserGameCompatibilityIabControllerClick(
            session,
            button,
          );
          emit({ event: "pressed", ...click });
          continue;
        }
        if (command.command === "preview") {
          const snapshot = await captureHealthySnapshot(session, {
            deadline,
            game,
            identity: baseIdentity,
            pollMs: options.pollMs,
            sessionId: prepared.session.id,
          });
          emit({ event: "preview", ...snapshotProgress(snapshot) });
          continue;
        }
        const button = command.button ?? expectedButton;
        if (button !== expectedButton) {
          fail(`witness for ${game.key} must use ${expectedButton}, not ${button}`);
        }
        witnessResult = await captureWitness(session, {
          button,
          corpus: prepared.corpus,
          deadline,
          emit,
          game,
          identity: baseIdentity,
          pollMs: options.pollMs,
          sessionId: prepared.session.id,
        });
        break;
      } catch (error) {
        emit({ event: "command-error", error: error.message ?? String(error) });
      }
    }
    if (witnessResult === null) fail("interactive input ended before a witness was certified");
    const terminalRelease = await observeBrowserGameCompatibilityIabActiveRelease(
      session,
      { expectedRelease: activeRelease, publicUrl: options.publicUrl },
    );
    const terminalState = await publicReleaseState(session);
    const terminalIdentity = frontendIdentity(terminalState, {
      activeRelease: terminalRelease,
      publicUrl: options.publicUrl,
    });
    exactCanonical(terminalIdentity, baseIdentity, "terminal frontend identity");
    await observePinnedNavigation(session, {
      expectedFrameUrl: frameUrl,
      expectedNavigation: pinnedNavigation,
      navigationLoaderId: navigation.loaderId,
      publicUrl: options.publicUrl,
    });
    if (session.exceptions.length !== 0) fail("DevTools exceptions occurred during capture");
    const capture = {
      firstPlayable: witnessResult.firstPlayable,
      gameKey: game.key,
      observed: {
        after: { activeRelease: terminalRelease, ...terminalIdentity },
        before,
      },
      snapshots: witnessResult.snapshots,
    };
    await verifyBrowserGameCompatibilityIabGameCapture({
      capture,
      corpus: prepared.corpus,
      gameKey: game.key,
      release: activeRelease,
      sessionId: prepared.session.id,
    });
    const merged = await persistBrowserGameCompatibilityIabCapture({
      capture,
      corpus: prepared.corpus,
      original: prepared.session,
      sessionPath: options.sessionPath,
    });
    emit({
      event: "captured",
      gameKey: game.key,
      samples: capture.snapshots.length,
      sessionPath: options.sessionPath,
    });
    return Object.freeze({ capture, changed: merged.changed, status: "captured" });
  } finally {
    try {
      if (viewportConfigured) await clearPublicViewport(session).catch(() => {});
    } finally {
      ownedCommands?.close();
      session.close();
    }
  }
}

function parseNamedOptions(arguments_, allowed) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (!allowed.has(name)) fail(`unknown argument ${name}`);
    if (values.has(name)) fail(`duplicate argument ${name}`);
    index += 1;
    if (index >= arguments_.length) fail(`missing value after ${name}`);
    values.set(name, arguments_[index]);
  }
  return values;
}

export function parseBrowserGameCompatibilityIabCaptureArguments(argv) {
  const [command, ...arguments_] = argv;
  if (command === "status") {
    const values = parseNamedOptions(arguments_, new Set(["--session"]));
    if (!values.has("--session")) fail("--session is required");
    return { command, sessionPath: resolve(values.get("--session")) };
  }
  if (command !== "capture-game") fail("expected status or capture-game subcommand");
  const values = parseNamedOptions(arguments_, new Set([
    "--endpoint",
    "--game",
    "--poll-ms",
    "--session",
    "--timeout-ms",
    "--url",
  ]));
  for (const name of ["--game", "--session"]) {
    if (!values.has(name)) fail(`${name} is required`);
  }
  const pollMs = Number(
    values.get("--poll-ms") ?? BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_DEFAULTS.pollMs,
  );
  const timeoutMs = Number(
    values.get("--timeout-ms") ?? BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_DEFAULTS.timeoutMs,
  );
  if (!Number.isInteger(pollMs) || pollMs < 10) fail("--poll-ms must be an integer >= 10");
  if (!Number.isInteger(timeoutMs) || timeoutMs < pollMs) {
    fail("--timeout-ms must be an integer >= --poll-ms");
  }
  const gameKey = values.get("--game");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameKey)) {
    fail("--game must be a lowercase kebab-case key");
  }
  return {
    command,
    endpoint: configuredEndpoint(
      values.get("--endpoint")
        ?? BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_DEFAULTS.endpoint,
    ),
    gameKey,
    pollMs,
    publicUrl: configuredBrowserGameCompatibilityIabUrl(
      values.get("--url")
        ?? BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_DEFAULTS.publicUrl,
    ),
    sessionPath: resolve(values.get("--session")),
    timeoutMs,
  };
}

export async function runBrowserGameCompatibilityIabCaptureCli(argv) {
  const options = parseBrowserGameCompatibilityIabCaptureArguments(argv);
  if (options.command === "status") {
    const prepared = await readBrowserGameCompatibilityIabCaptureSession(
      options.sessionPath,
    );
    const status = browserGameCompatibilityIabCaptureStatus(
      prepared.session,
      prepared.corpus,
    );
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status;
  }
  const result = await captureBrowserGameCompatibilityIabGame(options);
  process.stdout.write(`${JSON.stringify({
    changed: result.changed,
    gameKey: options.gameKey,
    status: result.status,
  })}\n`);
  return result;
}

if (
  process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runBrowserGameCompatibilityIabCaptureCli(process.argv.slice(2)).catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
