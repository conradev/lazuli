#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  sha256Hex,
  validateRelease,
} from "../web/release.mjs";
import {
  canonicalStringify,
} from "./browser_boot_checkpoint_core.mjs";
import {
  GAME_FIRST_PLAYABLE_BUTTONS,
  GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
  deriveGameFirstPlayableTranscript,
} from "./browser_game_first_playable_transcript.mjs";
import {
  GAME_COMPATIBILITY_RENDERER,
  validateGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  verifyGameFirstVisibleFrameCompatibility,
} from "./browser_game_compatibility_oracle.mjs";

export const BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA =
  "lazuli-browser-game-compatibility-iab-capture-v1";
export const BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA =
  "lazuli-browser-game-compatibility-iab-policy-v1";
export const BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA =
  "lazuli-browser-game-compatibility-iab-projection-v1";

const SURFACE = "loopback-public-root-local-file";

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

function frameIdentity(value, expectedUrl, path) {
  const identity = exactKeys(value, ["frameId", "loaderId", "url"], path);
  nonEmptyString(identity.frameId, `${path}.frameId`);
  nonEmptyString(identity.loaderId, `${path}.loaderId`);
  exact(identity.url, expectedUrl, `${path}.url`);
  return identity;
}

function navigationIdentity(value, { frameUrl, pageUrl }, path) {
  const navigation = exactKeys(value, ["iframe", "top"], path);
  frameIdentity(navigation.top, pageUrl, `${path}.top`);
  frameIdentity(navigation.iframe, frameUrl, `${path}.iframe`);
  return navigation;
}

async function validateObservation(
  value,
  { expectedRelease, frameUrl, pageUrl },
  path,
) {
  const observation = exactKeys(value, ["activeRelease", "navigation"], path);
  const activeRelease = await fullRelease(
    observation.activeRelease,
    `${path}.activeRelease`,
  );
  exactCanonical(
    activeRelease,
    expectedRelease,
    `${path}.activeRelease`,
    "observed active release does not match the expected schema-2 manifest",
  );
  navigationIdentity(
    observation.navigation,
    { frameUrl, pageUrl },
    `${path}.navigation`,
  );
  return observation;
}

function requireLocalFileSnapshots(snapshots, path) {
  if (!Array.isArray(snapshots)) fail(path, "expected an array");
  let previous = null;
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshotPath = `${path}[${index}]`;
    const snapshot = object(snapshots[index], snapshotPath);
    const environment = object(
      snapshot.environment,
      `${snapshotPath}.environment`,
    );
    exact(
      environment.surface,
      "public-root",
      `${snapshotPath}.environment.surface`,
    );
    const report = object(snapshot.report, `${snapshotPath}.report`);
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
    const disc = object(report.disc, `${snapshotPath}.report.disc`);
    const source = object(disc.source, `${snapshotPath}.report.disc.source`);
    exact(
      source.kind,
      "local-file",
      `${snapshotPath}.report.disc.source.kind`,
    );
  }
  return snapshots;
}

function firstPlayableSelection(value, snapshots, path) {
  const selection = exactKeys(
    value,
    ["button", "postIndex", "preIndex"],
    path,
  );
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
  return [...corpus.games].sort(
    (left, right) => left.priority - right.priority,
  );
}

function compatibilityPolicy(corpus, games, captures) {
  return {
    schema: BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA,
    transcript: GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
    renderer: GAME_COMPATIBILITY_RENDERER,
    fallbacks: false,
    publicGameRoutes: false,
    surface: SURFACE,
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
  const guestConsumptionSha256 = await canonicalSha256(
    guestConsumption,
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
        sha256: guestConsumptionSha256,
      }),
      reports: Object.freeze({
        preSha256: transcript.reports.pre.sha256,
        postSha256: transcript.reports.post.sha256,
      }),
    }),
    change: Object.freeze({ ...transcript.change }),
  });
}

async function compactGameProjection(
  game,
  verified,
  selection,
  transcript,
  path,
) {
  return Object.freeze({
    key: game.key,
    priority: game.priority,
    image: Object.freeze({
      format: game.image.format,
      sha256: verified.image,
    }),
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
    firstPlayable: await compactFirstPlayable(
      game,
      selection,
      transcript,
      path,
    ),
    delta: Object.freeze({ ...verified.delta }),
  });
}

export async function verifyBrowserGameCompatibilityIabEvidence({
  corpus,
  evidence,
  release,
}) {
  validateGameCompatibilityCorpus(corpus);
  const expectedRelease = await fullRelease(release, "$.release");
  const envelope = exactKeys(
    evidence,
    ["captures", "frameUrl", "observed", "pageUrl", "schema"],
    "$.evidence",
  );
  exact(
    envelope.schema,
    BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
    "$.evidence.schema",
  );
  const pageUrl = loopbackRoot(envelope.pageUrl, "$.evidence.pageUrl");
  const frameUrl = expectedFrameUrl(pageUrl, expectedRelease);
  exact(envelope.frameUrl, frameUrl, "$.evidence.frameUrl");

  const observed = exactKeys(
    envelope.observed,
    ["after", "before"],
    "$.evidence.observed",
  );
  const before = await validateObservation(
    observed.before,
    { expectedRelease, frameUrl, pageUrl },
    "$.evidence.observed.before",
  );
  const after = await validateObservation(
    observed.after,
    { expectedRelease, frameUrl, pageUrl },
    "$.evidence.observed.after",
  );
  exactCanonical(
    after.activeRelease,
    before.activeRelease,
    "$.evidence.observed.after.activeRelease",
    "active release changed during the corpus run",
  );
  exactCanonical(
    after.navigation,
    before.navigation,
    "$.evidence.observed.after.navigation",
    "top-level or immutable frontend navigation changed during the corpus run",
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
      ["firstPlayable", "gameKey", "snapshots"],
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
  const missing = games
    .map(game => game.key)
    .filter(key => !seen.has(key));
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
    const snapshotsPath = `${capturePath}.snapshots`;
    requireLocalFileSnapshots(capture.snapshots, snapshotsPath);
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
        preReport: capture.snapshots[selection.preIndex].report,
        postReport: capture.snapshots[selection.postIndex].report,
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
  const [corpusSha256, policySha256] = await Promise.all([
    canonicalSha256(corpus, "$.corpus"),
    canonicalSha256(policy, "$.policy"),
  ]);
  return Object.freeze({
    schema: BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA,
    source: Object.freeze({ commit: expectedRelease.source.commit }),
    releaseId: expectedRelease.releaseId,
    corpus: Object.freeze({
      schema: corpus.schema,
      sha256: corpusSha256,
    }),
    policy: Object.freeze({
      ...policy,
      sha256: policySha256,
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
    games: Object.freeze(projections),
  });
}

export async function writeBrowserGameCompatibilityIabProjection({
  corpus,
  evidence,
  outputPath,
  release,
}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("$.outputPath", "expected a non-empty path");
  }
  const projection = await verifyBrowserGameCompatibilityIabEvidence({
    corpus,
    evidence,
    release,
  });
  const target = resolve(outputPath);
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(projection, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return projection;
}
