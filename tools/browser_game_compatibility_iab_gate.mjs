#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  sha256Hex,
  validateRelease,
} from "../web/release.mjs";
import {
  canonicalStringify,
} from "./browser_boot_checkpoint_core.mjs";
import {
  identifyLocalDiscImage,
} from "./browser_boot_disc_identity.mjs";
import {
  SUPER_MONKEY_BALL_READY_CHECKPOINT,
} from "./browser_boot_checkpoint_v3.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V4,
  verifySmbSustainedPlay,
} from "./browser_boot_smb_sustained_play.mjs";
import {
  GAME_FIRST_PLAYABLE_BUTTONS,
  GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
  deriveGameFirstPlayableTranscript,
} from "./browser_game_first_playable_transcript.mjs";
import {
  GAME_COMPATIBILITY_CORPUS_PATH,
  GAME_COMPATIBILITY_RENDERER,
  readGameCompatibilityCorpus,
  validateGameCompatibilityCorpus,
  verifyLocalGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  verifyGameFirstVisibleFrameCompatibility,
} from "./browser_game_compatibility_oracle.mjs";

export const BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA =
  "lazuli-browser-game-compatibility-iab-capture-v2";
export const BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA =
  "lazuli-browser-game-compatibility-iab-policy-v2";
export const BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA =
  "lazuli-browser-game-compatibility-iab-projection-v2";
export const BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA =
  "lazuli-browser-game-compatibility-iab-session-v2";

export const CANONICAL_SMB_COMPATIBILITY_GAME = Object.freeze({
  key: "super-monkey-ball-usa",
  image: SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image,
  disc: Object.freeze({
    identifier: SUPER_MONKEY_BALL_READY_CHECKPOINT.game.identifier,
    revision: SUPER_MONKEY_BALL_READY_CHECKPOINT.game.revision,
  }),
  scenario: "smb-sustained-play",
});

const SURFACE = "fresh-loopback-public-root-local-file";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_RUN_PATTERN = /^[1-9][0-9]*$/;

export class BrowserGameCompatibilityIabGateError extends Error {
  constructor(path, detail, options = undefined) {
    super(
      `invalid browser game compatibility IAB evidence at ${path}: ${detail}`,
      options,
    );
    this.name = "BrowserGameCompatibilityIabGateError";
    this.path = path;
  }
}

function fail(path, detail, options = undefined) {
  throw new BrowserGameCompatibilityIabGateError(path, detail, options);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function exactKeys(value, expected, path) {
  object(value, path);
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])
  ) {
    fail(
      `${path}.[keys]`,
      `expected exactly ${canonical.join(", ")}; got ${actual.join(", ")}`,
    );
  }
  return value;
}

function exact(value, expected, path) {
  if (!Object.is(value, expected)) {
    fail(path, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(path, "expected a non-negative safe integer");
  }
  return value;
}

function positiveInteger(value, path) {
  const result = nonNegativeInteger(value, path);
  if (result === 0) fail(path, "expected a positive safe integer");
  return result;
}

function uuid(value, path) {
  nonEmptyString(value, path);
  if (!UUID_PATTERN.test(value)) fail(path, "expected a UUID");
  return value;
}

function canonicalText(value, path) {
  try {
    return canonicalStringify(value);
  } catch (error) {
    fail(path, "expected canonical JSON data", { cause: error });
  }
}

function exactCanonical(value, expected, path, detail) {
  if (canonicalText(value, path) !== canonicalText(expected, path)) {
    fail(path, detail);
  }
  return value;
}

async function canonicalSha256(value, path) {
  return sha256Hex(canonicalText(value, path));
}

async function fullRelease(value, path) {
  try {
    await validateRelease(value);
  } catch (error) {
    fail(path, error.message, { cause: error });
  }
  return value;
}

async function exactCanonicalCorpus(value, path) {
  try {
    validateGameCompatibilityCorpus(value);
  } catch (error) {
    fail(path, error.message, { cause: error });
  }
  const canonical = await readGameCompatibilityCorpus();
  exactCanonical(
    value,
    canonical,
    path,
    "expected the exact repository seven-game compatibility corpus",
  );
  return value;
}

function loopbackRoot(value, path) {
  if (typeof value !== "string") fail(path, "expected an absolute URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(path, "expected an absolute URL");
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
    fail(path, "expected an exact queryless loopback HTTP root");
  }
  return url.href;
}

function expectedFrameUrl(pageUrl, release) {
  const frame = new URL(release.frontend.url, pageUrl);
  frame.search = "";
  frame.hash = "";
  return frame.href;
}

async function validateObservation(value, expectedRelease, path) {
  const observation = exactKeys(
    value,
    ["activeRelease", "documentId", "frameUrl", "pageUrl", "workerRunId"],
    path,
  );
  const activeRelease = await fullRelease(
    observation.activeRelease,
    `${path}.activeRelease`,
  );
  exactCanonical(
    activeRelease,
    expectedRelease,
    `${path}.activeRelease`,
    "observed active release does not match the expected schema-3 manifest",
  );
  const pageUrl = loopbackRoot(observation.pageUrl, `${path}.pageUrl`);
  exact(
    observation.frameUrl,
    expectedFrameUrl(pageUrl, expectedRelease),
    `${path}.frameUrl`,
  );
  uuid(observation.documentId, `${path}.documentId`);
  nonEmptyString(observation.workerRunId, `${path}.workerRunId`);
  if (!WORKER_RUN_PATTERN.test(observation.workerRunId)) {
    fail(`${path}.workerRunId`, "expected a positive decimal worker-run ID");
  }
  exact(
    observation.workerRunId,
    "1",
    `${path}.workerRunId`,
  );
  return observation;
}

async function validateObservedPair(value, expectedRelease, path) {
  const observed = exactKeys(value, ["after", "before"], path);
  const before = await validateObservation(
    observed.before,
    expectedRelease,
    `${path}.before`,
  );
  const after = await validateObservation(
    observed.after,
    expectedRelease,
    `${path}.after`,
  );
  for (const field of ["pageUrl", "frameUrl", "documentId", "workerRunId"]) {
    exact(after[field], before[field], `${path}.after.${field}`);
  }
  exactCanonical(
    after.activeRelease,
    before.activeRelease,
    `${path}.after.activeRelease`,
    "active release changed within the title run",
  );
  return before;
}

function validateSuiteIdentity(identity, state, path) {
  if (state.pageUrl === null) {
    state.pageUrl = identity.pageUrl;
    state.frameUrl = identity.frameUrl;
  } else {
    exact(identity.pageUrl, state.pageUrl, `${path}.pageUrl`);
    exact(identity.frameUrl, state.frameUrl, `${path}.frameUrl`);
  }
  if (state.documentIds.has(identity.documentId)) {
    fail(
      `${path}.documentId`,
      "expected a fresh immutable frontend document for every title",
    );
  }
  state.documentIds.add(identity.documentId);
}

function publicEnvironment(
  value,
  expectedImage,
  expectedStatus,
  identity,
  sessionId,
  path,
) {
  const environment = exactKeys(
    value,
    ["captureIdentity", "dataset", "devtoolsExceptions", "discImage", "surface"],
    path,
  );
  exact(environment.surface, "public-root", `${path}.surface`);
  const dataset = exactKeys(
    environment.dataset,
    ["renderer", "status"],
    `${path}.dataset`,
  );
  exact(dataset.renderer, GAME_COMPATIBILITY_RENDERER, `${path}.dataset.renderer`);
  exact(dataset.status, expectedStatus, `${path}.dataset.status`);
  if (!Array.isArray(environment.devtoolsExceptions)) {
    fail(`${path}.devtoolsExceptions`, "expected an array");
  }
  exact(environment.devtoolsExceptions.length, 0, `${path}.devtoolsExceptions.length`);
  const discImage = exactKeys(
    environment.discImage,
    ["algorithm", "format", "sha256"],
    `${path}.discImage`,
  );
  exact(discImage.algorithm, "sha256", `${path}.discImage.algorithm`);
  exact(discImage.format, expectedImage.format, `${path}.discImage.format`);
  exact(discImage.sha256, expectedImage.sha256, `${path}.discImage.sha256`);
  const captureIdentity = exactKeys(
    environment.captureIdentity,
    ["documentId", "sessionId", "workerRunId"],
    `${path}.captureIdentity`,
  );
  exact(
    captureIdentity.documentId,
    identity.documentId,
    `${path}.captureIdentity.documentId`,
  );
  exact(captureIdentity.sessionId, sessionId, `${path}.captureIdentity.sessionId`);
  exact(
    captureIdentity.workerRunId,
    identity.workerRunId,
    `${path}.captureIdentity.workerRunId`,
  );
  return environment;
}

function requirePublicSnapshots(snapshots, game, identity, sessionId, path) {
  if (!Array.isArray(snapshots)) fail(path, "expected an array");
  let previous = null;
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshotPath = `${path}[${index}]`;
    const snapshot = object(snapshots[index], snapshotPath);
    const report = object(snapshot.report, `${snapshotPath}.report`);
    if (Object.hasOwn(report, "headlessCapture")) {
      fail(
        `${snapshotPath}.report.headlessCapture`,
        "public-root evidence must not contain synthetic headless metadata",
      );
    }
    publicEnvironment(
      snapshot.environment,
      game.image,
      "running",
      identity,
      sessionId,
      `${snapshotPath}.environment`,
    );
    const progress = Object.fromEntries(
      ["cycles", "dispatches", "instructions"].map(name => [
        name,
        positiveInteger(report[name], `${snapshotPath}.report.${name}`),
      ]),
    );
    if (previous !== null) {
      for (const name of Object.keys(progress)) {
        if (progress[name] <= previous[name]) {
          fail(
            `${snapshotPath}.report.${name}`,
            `expected ordered strict progress beyond ${previous[name]}`,
          );
        }
      }
    }
    previous = progress;
    exact(
      report.disc?.source?.kind,
      "local-file",
      `${snapshotPath}.report.disc.source.kind`,
    );
  }
  return snapshots;
}

function firstPlayableSelection(value, snapshots, path) {
  const selection = exactKeys(value, ["button", "postIndex", "preIndex"], path);
  if (!Object.hasOwn(GAME_FIRST_PLAYABLE_BUTTONS, selection.button)) {
    fail(`${path}.button`, "expected a supported controller button name");
  }
  const preIndex = nonNegativeInteger(selection.preIndex, `${path}.preIndex`);
  const postIndex = nonNegativeInteger(selection.postIndex, `${path}.postIndex`);
  if (preIndex >= snapshots.length) {
    fail(`${path}.preIndex`, `expected an index below ${snapshots.length}`);
  }
  if (postIndex >= snapshots.length) {
    fail(`${path}.postIndex`, `expected an index below ${snapshots.length}`);
  }
  if (postIndex <= preIndex) {
    fail(`${path}.postIndex`, "expected an index after preIndex");
  }
  return { button: selection.button, postIndex, preIndex };
}

function canonicalGames(corpus) {
  return [...corpus.games].sort((left, right) => left.priority - right.priority);
}

function compatibilityPolicy(corpus, games, captures) {
  return {
    schema: BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA,
    transcript: GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
    renderer: GAME_COMPATIBILITY_RENDERER,
    fallbacks: false,
    publicGameRoutes: false,
    surface: SURFACE,
    suite: [CANONICAL_SMB_COMPATIBILITY_GAME.key, ...games.map(game => game.key)],
    smb: {
      scenario: CANONICAL_SMB_COMPATIBILITY_GAME.scenario,
      sustainedSchema: SMB_SUSTAINED_PLAY_SCHEMA_V4,
      temporalFlicker: "reject-black-white-monochrome-near-extreme",
    },
    thresholds: {
      sustainedViFields: corpus.evidence.sustainedViFields,
      viewportFrames: corpus.evidence.viewportFrames,
    },
    milestoneIds: games.map(game => ({
      gameKey: game.key,
      id: game.milestone.id,
    })),
    buttons: games.map((game, index) => ({
      gameKey: game.key,
      button: captures[index].firstPlayable.button,
    })),
  };
}

async function compactFirstPlayable(game, selection, transcript, path) {
  exact(
    transcript.game.milestone.id,
    game.milestone.id,
    `${path}.[transcript].game.milestone.id`,
  );
  exact(
    transcript.input.mode,
    "guest-consumed",
    `${path}.[transcript].input.mode`,
  );
  const guestConsumption = object(
    transcript.input.guestConsumption,
    `${path}.[transcript].input.guestConsumption`,
  );
  return Object.freeze({
    schema: transcript.schema,
    milestone: Object.freeze({ id: game.milestone.id }),
    input: Object.freeze({
      button: transcript.input.name,
      mask: transcript.input.mask,
      mode: transcript.input.mode,
      preIndex: selection.preIndex,
      postIndex: selection.postIndex,
      publication: Object.freeze({ ...transcript.input.publication }),
      guestConsumption: Object.freeze({
        kind: nonEmptyString(
          guestConsumption.kind,
          `${path}.[transcript].input.guestConsumption.kind`,
        ),
        cycle: nonNegativeInteger(
          guestConsumption.cycle,
          `${path}.[transcript].input.guestConsumption.cycle`,
        ),
        sha256: await canonicalSha256(
          guestConsumption,
          `${path}.[transcript].input.guestConsumption`,
        ),
      }),
      reports: Object.freeze({
        preSha256: transcript.reports.pre.sha256,
        postSha256: transcript.reports.post.sha256,
      }),
    }),
    change: Object.freeze({ ...transcript.change }),
  });
}

async function compactGameProjection(game, verified, selection, transcript, path) {
  return Object.freeze({
    key: game.key,
    priority: game.priority,
    image: Object.freeze({ format: game.image.format, sha256: verified.image }),
    disc: Object.freeze({
      identifier: game.disc.identifier,
      revision: game.disc.revision,
    }),
    samples: Object.freeze({
      observed: verified.observedSamples,
      sustained: verified.samples,
    }),
    firstVisible: Object.freeze({
      cycles: verified.firstVisible.cycles,
      index: verified.firstVisible.index,
      rgbSha256: verified.firstVisible.rgbSha256,
      viFields: verified.firstVisible.viFields,
      hostPresentations: verified.firstVisible.hostPresentations,
      presentationSerial: verified.firstVisible.presentationSerial,
    }),
    firstPlayable: await compactFirstPlayable(game, selection, transcript, path),
    delta: Object.freeze({ ...verified.delta }),
  });
}

async function verifySmbCapture(
  capture,
  expectedRelease,
  sessionId,
  suiteIdentity,
) {
  const path = "$.evidence.smb";
  const value = exactKeys(
    capture,
    ["gameKey", "observed", "snapshot"],
    path,
  );
  exact(value.gameKey, CANONICAL_SMB_COMPATIBILITY_GAME.key, `${path}.gameKey`);
  const identity = await validateObservedPair(
    value.observed,
    expectedRelease,
    `${path}.observed`,
  );
  validateSuiteIdentity(identity, suiteIdentity, `${path}.observed.before`);

  const snapshot = object(value.snapshot, `${path}.snapshot`);
  const report = object(snapshot.report, `${path}.snapshot.report`);
  if (Object.hasOwn(report, "headlessCapture")) {
    fail(
      `${path}.snapshot.report.headlessCapture`,
      "public-root evidence must not contain synthetic headless metadata",
    );
  }
  publicEnvironment(
    snapshot.environment,
    CANONICAL_SMB_COMPATIBILITY_GAME.image,
    "paused",
    identity,
    sessionId,
    `${path}.snapshot.environment`,
  );
  exact(report.disc?.identifier, "GMBE8P", `${path}.snapshot.report.disc.identifier`);
  exact(report.disc?.revision, 0, `${path}.snapshot.report.disc.revision`);
  exact(
    report.disc?.source?.kind,
    "local-file",
    `${path}.snapshot.report.disc.source.kind`,
  );
  exact(
    report.sustainedPlay?.schema,
    SMB_SUSTAINED_PLAY_SCHEMA_V4,
    `${path}.snapshot.report.sustainedPlay.schema`,
  );
  let oracle;
  try {
    oracle = verifySmbSustainedPlay(report);
  } catch (error) {
    fail(`${path}.snapshot.report`, error.message, { cause: error });
  }
  const surface = report.rendering.sustainedPresentedSurfaces;
  return Object.freeze({
    key: CANONICAL_SMB_COMPATIBILITY_GAME.key,
    image: Object.freeze({
      format: CANONICAL_SMB_COMPATIBILITY_GAME.image.format,
      sha256: CANONICAL_SMB_COMPATIBILITY_GAME.image.sha256,
    }),
    disc: CANONICAL_SMB_COMPATIBILITY_GAME.disc,
    scenario: CANONICAL_SMB_COMPATIBILITY_GAME.scenario,
    reportSha256: await canonicalSha256(report, `${path}.snapshot.report`),
    sustained: Object.freeze({
      schema: SMB_SUSTAINED_PLAY_SCHEMA_V4,
      received: oracle.received,
      drained: oracle.drained,
      presented: oracle.presented,
      rejected: oracle.rejected,
      completedPairEpochs: oracle.completedPairEpochs,
      complete: oracle.complete,
    }),
    temporal: Object.freeze({
      captured: surface.oracle.captured,
      distinctRgbHashes: surface.oracle.distinctRgbHashes,
      blackWhiteTransitions: surface.oracle.blackWhiteTransitionOrdinals.length,
      nearBlackWhiteTransitions:
        surface.oracle.nearBlackWhiteTransitionOrdinals.length,
      monochromeFrames: surface.oracle.monochromeOrdinals.length,
      nearBlackFrames: surface.oracle.nearBlackOrdinals.length,
      nearWhiteFrames: surface.oracle.nearWhiteOrdinals.length,
    }),
  });
}

export async function verifyBrowserGameCompatibilityIabEvidence({
  corpus,
  evidence,
  expectedSessionId = null,
  release,
}) {
  await exactCanonicalCorpus(corpus, "$.corpus");
  const expectedRelease = await fullRelease(release, "$.release");
  const envelope = exactKeys(
    evidence,
    ["captures", "schema", "sessionId", "smb"],
    "$.evidence",
  );
  exact(
    envelope.schema,
    BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
    "$.evidence.schema",
  );
  uuid(envelope.sessionId, "$.evidence.sessionId");
  if (expectedSessionId !== null) {
    exact(envelope.sessionId, expectedSessionId, "$.evidence.sessionId");
  }

  const suiteIdentity = { documentIds: new Set(), frameUrl: null, pageUrl: null };
  const smb = await verifySmbCapture(
    envelope.smb,
    expectedRelease,
    envelope.sessionId,
    suiteIdentity,
  );

  if (!Array.isArray(envelope.captures)) {
    fail("$.evidence.captures", "expected an array");
  }
  const games = canonicalGames(corpus);
  const gameByKey = new Map(games.map(game => [game.key, game]));
  const seen = new Set();
  for (let index = 0; index < envelope.captures.length; index += 1) {
    const path = `$.evidence.captures[${index}]`;
    const capture = exactKeys(
      envelope.captures[index],
      ["firstPlayable", "gameKey", "observed", "snapshots"],
      path,
    );
    if (typeof capture.gameKey !== "string" || !gameByKey.has(capture.gameKey)) {
      fail(`${path}.gameKey`, "expected an exact corpus game key");
    }
    if (seen.has(capture.gameKey)) {
      fail(`${path}.gameKey`, `duplicate capture for ${JSON.stringify(capture.gameKey)}`);
    }
    seen.add(capture.gameKey);
  }
  const missing = games.map(game => game.key).filter(key => !seen.has(key));
  if (missing.length !== 0 || envelope.captures.length !== games.length) {
    fail(
      "$.evidence.captures",
      `expected every corpus game exactly once; missing ${JSON.stringify(missing)}`,
    );
  }

  const projections = [];
  for (let index = 0; index < games.length; index += 1) {
    const game = games[index];
    const capture = envelope.captures[index];
    const capturePath = `$.evidence.captures[${index}]`;
    exact(capture.gameKey, game.key, `${capturePath}.gameKey`);
    const identity = await validateObservedPair(
      capture.observed,
      expectedRelease,
      `${capturePath}.observed`,
    );
    validateSuiteIdentity(identity, suiteIdentity, `${capturePath}.observed.before`);
    const snapshotsPath = `${capturePath}.snapshots`;
    requirePublicSnapshots(
      capture.snapshots,
      game,
      identity,
      envelope.sessionId,
      snapshotsPath,
    );
    const selection = firstPlayableSelection(
      capture.firstPlayable,
      capture.snapshots,
      `${capturePath}.firstPlayable`,
    );
    let verified;
    try {
      verified = verifyGameFirstVisibleFrameCompatibility({
        game,
        snapshots: capture.snapshots,
        sustainedViFields: corpus.evidence.sustainedViFields,
        viewportFrames: corpus.evidence.viewportFrames,
      });
    } catch (error) {
      fail(snapshotsPath, error.message, { cause: error });
    }
    exact(verified.surface, "public-root", `${snapshotsPath}.[surface]`);

    let transcript;
    try {
      transcript = deriveGameFirstPlayableTranscript({
        button: selection.button,
        corpus,
        gameKey: game.key,
        preSnapshot: capture.snapshots[selection.preIndex],
        postSnapshot: capture.snapshots[selection.postIndex],
      });
    } catch (error) {
      fail(`${capturePath}.firstPlayable`, error.message, { cause: error });
    }
    projections.push(await compactGameProjection(
      game,
      verified,
      selection,
      transcript,
      `${capturePath}.firstPlayable`,
    ));
  }

  const policy = compatibilityPolicy(corpus, games, envelope.captures);
  const [captureSha256, corpusSha256, policySha256] = await Promise.all([
    canonicalSha256(envelope, "$.evidence"),
    canonicalSha256(corpus, "$.corpus"),
    canonicalSha256(policy, "$.policy"),
  ]);
  return Object.freeze({
    schema: BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA,
    source: Object.freeze({ commit: expectedRelease.source.commit }),
    releaseId: expectedRelease.releaseId,
    captureSha256,
    corpus: Object.freeze({ schema: corpus.schema, sha256: corpusSha256 }),
    policy: Object.freeze({
      ...policy,
      sha256: policySha256,
      suite: Object.freeze([...policy.suite]),
      smb: Object.freeze({ ...policy.smb }),
      thresholds: Object.freeze({ ...policy.thresholds }),
      milestoneIds: Object.freeze(
        policy.milestoneIds.map(milestone => Object.freeze({ ...milestone })),
      ),
      buttons: Object.freeze(
        policy.buttons.map(button => Object.freeze({ ...button })),
      ),
    }),
    renderer: GAME_COMPATIBILITY_RENDERER,
    fallbacks: false,
    surface: SURFACE,
    smb,
    games: Object.freeze(projections),
  });
}

async function writeJsonAtomic(path, value, { compact = false, mode } = {}) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const serialized = compact
    ? `${JSON.stringify(value)}\n`
    : `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, serialized, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeBrowserGameCompatibilityIabProjection({
  corpus,
  evidence,
  expectedSessionId = null,
  outputPath,
  release,
}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("$.outputPath", "expected a non-empty path");
  }
  const projection = await verifyBrowserGameCompatibilityIabEvidence({
    corpus,
    evidence,
    expectedSessionId,
    release,
  });
  await writeJsonAtomic(outputPath, projection, { compact: true });
  return projection;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read ${label} ${path}: ${error.message ?? String(error)}`,
      { cause: error },
    );
  }
}

async function privateSessionExists(path, lstatFile) {
  let metadata;
  try {
    metadata = await lstatFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error(`could not inspect private IAB session ${path}`, { cause: error });
  }
  if (!metadata.isFile()) {
    throw new Error(`private IAB session must be a regular non-symlink file: ${path}`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`private IAB session must have mode 0600: ${path}`);
  }
  return true;
}

async function pathAliases(path) {
  const absolute = resolve(path);
  const aliases = new Set([absolute]);
  try {
    aliases.add(await realpath(absolute));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    aliases.add(join(await realpath(dirname(absolute)), basename(absolute)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return aliases;
}

async function protectOutputPath(outputPath, inputPaths, label) {
  const outputAliases = await pathAliases(outputPath);
  for (const inputPath of inputPaths) {
    const inputAliases = await pathAliases(inputPath);
    if ([...outputAliases].some(alias => inputAliases.has(alias))) {
      throw new Error(`${label} must not overwrite input ${resolve(inputPath)}`);
    }
  }
}

function canonicalGamePaths(corpus, gamesDirectory) {
  return corpus.games.map(game => join(gamesDirectory, game.file));
}

function compatibilityInputPaths(corpus, { gamesDirectory, releasePath, smbPath }) {
  return [
    GAME_COMPATIBILITY_CORPUS_PATH,
    releasePath,
    smbPath,
    ...canonicalGamePaths(corpus, gamesDirectory),
  ];
}

function resolvedInputPaths({ gamesDirectory, releasePath, sessionPath, smbPath }) {
  const paths = {
    gamesDirectory: resolve(gamesDirectory),
    releasePath: resolve(releasePath),
    sessionPath: resolve(sessionPath),
    smbPath: resolve(smbPath),
  };
  if (paths.sessionPath === paths.releasePath || paths.sessionPath === paths.smbPath) {
    throw new Error("--session must not overwrite --release or --smb");
  }
  return paths;
}

async function verifiedSmbInput(path, { identify, statFile }) {
  let metadata;
  try {
    metadata = await statFile(path);
  } catch (error) {
    throw new Error(`could not stat canonical SMB image ${path}`, { cause: error });
  }
  if (!metadata.isFile()) {
    throw new Error(`canonical SMB image is not a regular file: ${path}`);
  }
  const image = await identify(path);
  if (canonicalText(image, "$.smb.image") !== canonicalText(
    CANONICAL_SMB_COMPATIBILITY_GAME.image,
    "$.smb.image",
  )) {
    throw new Error(
      `canonical SMB image identity mismatch: expected ${JSON.stringify(
        CANONICAL_SMB_COMPATIBILITY_GAME.image,
      )}, got ${JSON.stringify(image)}`,
    );
  }
  return Object.freeze({
    bytes: metadata.size,
    disc: CANONICAL_SMB_COMPATIBILITY_GAME.disc,
    image,
    key: CANONICAL_SMB_COMPATIBILITY_GAME.key,
    path,
  });
}

export async function prepareBrowserGameCompatibilityIabSession(
  { gamesDirectory, releasePath, sessionPath, smbPath },
  {
    identify = identifyLocalDiscImage,
    lstatFile = lstat,
    makeSessionId = randomUUID,
    readCorpus = readGameCompatibilityCorpus,
    statFile = stat,
    verifyCorpus = verifyLocalGameCompatibilityCorpus,
  } = {},
) {
  const paths = resolvedInputPaths({
    gamesDirectory,
    releasePath,
    sessionPath,
    smbPath,
  });
  const [corpus, release] = await Promise.all([
    readCorpus(),
    readJson(paths.releasePath, "release manifest"),
  ]);
  await exactCanonicalCorpus(corpus, "$.corpus");
  await fullRelease(release, "$.release");
  const games = await verifyCorpus(corpus, {
    directory: paths.gamesDirectory,
    identify,
  });
  const smb = await verifiedSmbInput(paths.smbPath, { identify, statFile });
  await protectOutputPath(
    paths.sessionPath,
    compatibilityInputPaths(corpus, paths),
    "--session",
  );
  const inputs = {
    corpus: {
      path: GAME_COMPATIBILITY_CORPUS_PATH,
      sha256: await canonicalSha256(corpus, "$.corpus"),
      value: corpus,
    },
    games: { directory: paths.gamesDirectory, images: games },
    release: { path: paths.releasePath, value: release },
    smb,
  };

  const existing = await privateSessionExists(paths.sessionPath, lstatFile)
    ? await readJson(paths.sessionPath, "IAB compatibility session")
    : null;
  if (existing !== null) {
    exactKeys(existing, ["evidence", "id", "inputs", "schema"], "$.session");
    exact(
      existing.schema,
      BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
      "$.session.schema",
    );
    uuid(existing.id, "$.session.id");
    exactCanonical(
      existing.inputs,
      inputs,
      "$.session.inputs",
      "prepared inputs changed; refusing to replace resumable evidence",
    );
    return existing;
  }

  const id = makeSessionId();
  uuid(id, "$.session.id");
  const session = {
    schema: BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
    id,
    inputs,
    evidence: {
      schema: BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
      sessionId: id,
      smb: null,
      captures: [],
    },
  };
  await writeJsonAtomic(paths.sessionPath, session, { mode: 0o600 });
  await privateSessionExists(paths.sessionPath, lstatFile);
  return session;
}

async function validatePreparedSession(session) {
  exactKeys(session, ["evidence", "id", "inputs", "schema"], "$.session");
  exact(
    session.schema,
    BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
    "$.session.schema",
  );
  uuid(session.id, "$.session.id");
  const inputs = exactKeys(
    session.inputs,
    ["corpus", "games", "release", "smb"],
    "$.session.inputs",
  );
  const releaseInput = exactKeys(
    inputs.release,
    ["path", "value"],
    "$.session.inputs.release",
  );
  nonEmptyString(releaseInput.path, "$.session.inputs.release.path");
  await fullRelease(releaseInput.value, "$.session.inputs.release.value");
  const corpusInput = exactKeys(
    inputs.corpus,
    ["path", "sha256", "value"],
    "$.session.inputs.corpus",
  );
  exact(
    corpusInput.path,
    GAME_COMPATIBILITY_CORPUS_PATH,
    "$.session.inputs.corpus.path",
  );
  await exactCanonicalCorpus(corpusInput.value, "$.session.inputs.corpus.value");
  exact(
    corpusInput.sha256,
    await canonicalSha256(corpusInput.value, "$.session.inputs.corpus.value"),
    "$.session.inputs.corpus.sha256",
  );
  const games = exactKeys(
    inputs.games,
    ["directory", "images"],
    "$.session.inputs.games",
  );
  nonEmptyString(games.directory, "$.session.inputs.games.directory");
  if (!Array.isArray(games.images) || games.images.length !== 7) {
    fail("$.session.inputs.games.images", "expected seven verified local images");
  }
  const smb = exactKeys(
    inputs.smb,
    ["bytes", "disc", "image", "key", "path"],
    "$.session.inputs.smb",
  );
  positiveInteger(smb.bytes, "$.session.inputs.smb.bytes");
  nonEmptyString(smb.path, "$.session.inputs.smb.path");
  exact(smb.key, CANONICAL_SMB_COMPATIBILITY_GAME.key, "$.session.inputs.smb.key");
  exactCanonical(
    smb.image,
    CANONICAL_SMB_COMPATIBILITY_GAME.image,
    "$.session.inputs.smb.image",
    "canonical SMB image identity changed",
  );
  exactCanonical(
    smb.disc,
    CANONICAL_SMB_COMPATIBILITY_GAME.disc,
    "$.session.inputs.smb.disc",
    "canonical SMB disc identity changed",
  );
  object(session.evidence, "$.session.evidence");
  return { corpus: corpusInput.value, evidence: session.evidence, release: releaseInput.value };
}

async function revalidatePreparedInputs(
  session,
  prepared,
  { identify, statFile, verifyCorpus },
) {
  const currentRelease = await readJson(
    session.inputs.release.path,
    "release manifest",
  );
  await fullRelease(currentRelease, "$.current.release");
  exactCanonical(
    currentRelease,
    prepared.release,
    "$.current.release",
    "release manifest changed after session preparation",
  );

  const currentGames = await verifyCorpus(prepared.corpus, {
    directory: session.inputs.games.directory,
    identify,
  });
  exactCanonical(
    currentGames,
    session.inputs.games.images,
    "$.current.games",
    "local compatibility corpus changed after session preparation",
  );

  const currentSmb = await verifiedSmbInput(
    session.inputs.smb.path,
    { identify, statFile },
  );
  exactCanonical(
    currentSmb,
    session.inputs.smb,
    "$.current.smb",
    "canonical SMB image changed after session preparation",
  );
  return { ...prepared, release: currentRelease };
}

export async function finalizeBrowserGameCompatibilityIabSession(
  { outputPath, sessionPath },
  {
    identify = identifyLocalDiscImage,
    lstatFile = lstat,
    statFile = stat,
    verifyCorpus = verifyLocalGameCompatibilityCorpus,
  } = {},
) {
  const target = resolve(outputPath);
  const source = resolve(sessionPath);
  if (target === source) throw new Error("--output must not overwrite --session");
  await privateSessionExists(source, lstatFile);
  const session = await readJson(source, "IAB compatibility session");
  let prepared = await validatePreparedSession(session);
  await protectOutputPath(
    target,
    compatibilityInputPaths(prepared.corpus, {
      gamesDirectory: session.inputs.games.directory,
      releasePath: session.inputs.release.path,
      smbPath: session.inputs.smb.path,
    }),
    "--output",
  );
  prepared = await revalidatePreparedInputs(session, prepared, {
    identify,
    statFile,
    verifyCorpus,
  });
  return writeBrowserGameCompatibilityIabProjection({
    ...prepared,
    expectedSessionId: session.id,
    outputPath: target,
  });
}

function parseOptions(argv, names) {
  const values = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!names.includes(name)) throw new Error(`unknown argument ${name}`);
    if (seen.has(name)) throw new Error(`duplicate argument ${name}`);
    seen.add(name);
    index += 1;
    if (index >= argv.length) throw new Error(`missing value after ${name}`);
    values[name] = resolve(argv[index]);
  }
  for (const name of names) {
    if (values[name] === undefined) throw new Error(`${name} is required`);
  }
  return values;
}

export function parseBrowserGameCompatibilityIabGateArguments(argv) {
  const [command, ...arguments_] = argv;
  if (command === "prepare") {
    const values = parseOptions(
      arguments_,
      ["--release", "--games", "--smb", "--session"],
    );
    return {
      command,
      releasePath: values["--release"],
      gamesDirectory: values["--games"],
      smbPath: values["--smb"],
      sessionPath: values["--session"],
    };
  }
  if (command === "finalize") {
    const values = parseOptions(arguments_, ["--session", "--output"]);
    return {
      command,
      sessionPath: values["--session"],
      outputPath: values["--output"],
    };
  }
  throw new Error("expected prepare or finalize subcommand");
}

export async function runBrowserGameCompatibilityIabGateCli(argv) {
  const options = parseBrowserGameCompatibilityIabGateArguments(argv);
  if (options.command === "prepare") {
    const session = await prepareBrowserGameCompatibilityIabSession(options);
    process.stdout.write(`${JSON.stringify({ id: session.id })}\n`);
    return session;
  }
  const projection = await finalizeBrowserGameCompatibilityIabSession(options);
  process.stdout.write(`${options.outputPath}\n`);
  return projection;
}

if (
  process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runBrowserGameCompatibilityIabGateCli(process.argv.slice(2)).catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
