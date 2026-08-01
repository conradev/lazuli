// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
} from "../web/release.mjs";
import {
  canonicalStringify,
} from "./browser_boot_checkpoint_core.mjs";
import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";
import {
  BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
  BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA,
  BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA,
  verifyBrowserGameCompatibilityIabEvidence,
  writeBrowserGameCompatibilityIabProjection,
} from "./browser_game_compatibility_iab_gate.mjs";
import {
  makeFzeroFirstPlayableReportPair,
} from "./browser_game_first_playable_fzero_test_fixture.mjs";
import {
  makeLuigisMansionFirstPlayableReportPair,
} from "./browser_game_first_playable_luigi_test_fixture.mjs";
import {
  makeMeleeFirstPlayableReportPair,
} from "./browser_game_first_playable_melee_test_fixture.mjs";
import {
  makeMetroidPrimeFirstPlayableReportPair,
} from "./browser_game_first_playable_metroid_prime_test_fixture.mjs";
import {
  makeRogueLeaderFirstPlayableReportPair,
} from "./browser_game_first_playable_rogue_leader_test_fixture.mjs";
import {
  makeGameFirstPlayableReport,
} from "./browser_game_first_playable_test_fixture.mjs";
import {
  makeWarioWareFirstPlayableReportPair,
} from "./browser_game_first_playable_warioware_test_fixture.mjs";
import {
  makeWindWakerFirstPlayableReportPair,
} from "./browser_game_first_playable_wind_waker_test_fixture.mjs";

const COMMIT = "1".repeat(40);
const ASSET_HASH = "2".repeat(64);
const PAGE_URL = "http://127.0.0.1:8768/";

const FIRST_PLAYABLE_FIXTURES = Object.freeze({
  "warioware-usa": Object.freeze({
    button: "a",
    pair: makeWarioWareFirstPlayableReportPair,
  }),
  "luigis-mansion-usa": Object.freeze({
    button: "left",
    pair: makeLuigisMansionFirstPlayableReportPair,
  }),
  "wind-waker-usa": Object.freeze({
    button: "left",
    pair: makeWindWakerFirstPlayableReportPair,
  }),
  "melee-usa-rev-2": Object.freeze({
    button: "left",
    pair: makeMeleeFirstPlayableReportPair,
  }),
  "f-zero-gx-usa": Object.freeze({
    button: "left",
    pair: makeFzeroFirstPlayableReportPair,
  }),
  "metroid-prime-usa-rev-2": Object.freeze({
    button: "left",
    pair: makeMetroidPrimeFirstPlayableReportPair,
  }),
  "rogue-leader-usa": Object.freeze({
    button: "left",
    pair: makeRogueLeaderFirstPlayableReportPair,
  }),
});

function asset(prefix, extension, bytes, hash = ASSET_HASH) {
  return {
    url: `/assets/${prefix}-${hash}.${extension}`,
    sha256: hash,
    bytes,
  };
}

async function release({
  assetHash = ASSET_HASH,
  commit = COMMIT,
} = {}) {
  const repository = "https://github.com/conradev/lazuli";
  const value = {
    schema: 2,
    releaseId: "0".repeat(64),
    source: {
      repository,
      commit,
      tree: `${repository}/tree/${commit}`,
      archive: `${repository}/archive/${commit}.tar.gz`,
      license: {
        expression: "GPL-3.0-only",
        text: "/LICENSE.txt",
        source: `${repository}/blob/${commit}/licenses/GPL-3.0-only.txt`,
      },
    },
    frontend: asset("frontend", "html", 1_234, assetHash),
    renderer: {
      javascript: asset("renderer", "js", 2_345, assetHash),
      wasm: asset("renderer-wasm", "wasm", 3_456, assetHash),
    },
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: assetHash,
      bytes: WASM_CHUNK_SIZE,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [
        asset("ppcwasmjit-0000", "wasm", WASM_CHUNK_SIZE, assetHash),
      ],
    },
  };
  value.releaseId = await sha256Hex(
    JSON.stringify(releaseIdentityPayload(value)),
  );
  return value;
}

function navigation(pageUrl, frameUrl) {
  return {
    top: {
      frameId: "top-frame",
      loaderId: "top-loader",
      url: pageUrl,
    },
    iframe: {
      frameId: "release-frame",
      loaderId: "release-loader",
      url: frameUrl,
    },
  };
}

function snapshot(game, report) {
  report.disc.source = { kind: "local-file" };
  return {
    environment: {
      surface: "public-root",
      dataset: {
        renderer: "wgpu-webgpu",
        status: "running",
      },
      devtoolsExceptions: [],
      discImage: {
        algorithm: "sha256",
        format: game.image.format,
        sha256: game.image.sha256,
      },
    },
    report,
  };
}

function capture(game) {
  const fixture = FIRST_PLAYABLE_FIXTURES[game.key];
  assert.ok(fixture, `missing fixture for ${game.key}`);
  const { postReport, preReport } = fixture.pair(game);
  return {
    gameKey: game.key,
    firstPlayable: {
      button: fixture.button,
      preIndex: 0,
      postIndex: 1,
    },
    snapshots: [
      snapshot(game, preReport),
      snapshot(game, postReport),
      snapshot(game, makeGameFirstPlayableReport(game, 2)),
    ],
  };
}

function evidence(corpus, activeRelease) {
  const frameUrl = new URL(activeRelease.frontend.url, PAGE_URL).href;
  const identity = navigation(PAGE_URL, frameUrl);
  return {
    schema: BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
    pageUrl: PAGE_URL,
    frameUrl,
    observed: {
      before: {
        activeRelease: structuredClone(activeRelease),
        navigation: identity,
      },
      after: {
        activeRelease: structuredClone(activeRelease),
        navigation: structuredClone(identity),
      },
    },
    captures: [...corpus.games]
      .sort((left, right) => left.priority - right.priority)
      .map(capture),
  };
}

function verify(corpus, value, expectedRelease) {
  return verifyBrowserGameCompatibilityIabEvidence({
    corpus,
    evidence: value,
    release: expectedRelease,
  });
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).reverse().map(key => [key, reverseObjectKeys(value[key])]),
    );
  }
  return value;
}

test("IAB gate certifies all seven fixture pairs in deterministic priority order", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const value = evidence(corpus, activeRelease);
  const first = await verify(corpus, value, activeRelease);
  const second = await verify(corpus, structuredClone(value), activeRelease);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.games.map(game => game.key), [
    ...corpus.games,
  ].sort((left, right) => left.priority - right.priority).map(game => game.key));
  assert.equal(first.games.length, 7);
  assert.equal(Object.keys(FIRST_PLAYABLE_FIXTURES).length, 7);
  assert.equal(first.renderer, "wgpu-webgpu");
  assert.equal(first.fallbacks, false);
  assert.equal(first.surface, "loopback-public-root-local-file");
  assert.equal(first.source.commit, COMMIT);
  assert.equal(first.releaseId, activeRelease.releaseId);
  assert.match(first.corpus.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.policy.schema, BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA);
  assert.match(first.policy.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.policy.thresholds, corpus.evidence);
  assert.deepEqual(
    first.policy.milestoneIds,
    corpus.games.map(game => ({ gameKey: game.key, id: game.milestone.id })),
  );
  assert.deepEqual(
    first.policy.buttons,
    corpus.games.map(game => ({
      gameKey: game.key,
      button: FIRST_PLAYABLE_FIXTURES[game.key].button,
    })),
  );
  assert.deepEqual(
    first.games.map(game => game.firstPlayable.input.button),
    ["a", "left", "left", "left", "left", "left", "left"],
  );
  for (const game of first.games) {
    assert.equal(game.firstVisible.index, 0);
    assert.equal(game.firstPlayable.input.mode, "guest-consumed");
    assert.equal(game.firstPlayable.change.kind, "visual");
    assert.notEqual(
      game.firstPlayable.change.before,
      game.firstPlayable.change.after,
    );
    assert.match(
      game.firstPlayable.input.guestConsumption.sha256,
      /^[0-9a-f]{64}$/,
    );
  }
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.games), true);
  assert.equal(Object.isFrozen(first.games[0].firstPlayable.input), true);
});

test("IAB gate fails closed for missing, duplicate, unknown, and misordered games", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const cases = [
    [
      value => { value.captures.pop(); },
      /every corpus game exactly once; missing/,
    ],
    [
      value => { value.captures[1].gameKey = value.captures[0].gameKey; },
      /duplicate capture/,
    ],
    [
      value => { value.captures[0].gameKey = "super-monkey-ball-usa"; },
      /exact corpus game key/,
    ],
    [
      value => { [value.captures[0], value.captures[1]] = [
        value.captures[1],
        value.captures[0],
      ]; },
      /captures\[0\]\.gameKey.*warioware-usa/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const value = evidence(corpus, activeRelease);
    mutate(value);
    await assert.rejects(() => verify(corpus, value, activeRelease), pattern);
  }
});

test("IAB gate accepts only the queryless loopback public root and local-file discs", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  for (const pageUrl of [
    "http://127.0.0.1:8768/warioware",
    "http://127.0.0.1:8768/?game=warioware",
    "https://127.0.0.1:8768/",
    "https://gekko.free/",
  ]) {
    const value = evidence(corpus, activeRelease);
    value.pageUrl = pageUrl;
    await assert.rejects(
      () => verify(corpus, value, activeRelease),
      /queryless loopback HTTP root/,
    );
  }

  const remoteDisc = evidence(corpus, activeRelease);
  remoteDisc.captures[0].snapshots[0].report.disc.source = {
    kind: "logical-range-endpoint",
    url: "http://127.0.0.1:8768/disc",
  };
  await assert.rejects(
    () => verify(corpus, remoteDisc, activeRelease),
    /disc\.source\.kind.*local-file/,
  );

  const wrongSurface = evidence(corpus, activeRelease);
  wrongSurface.captures[0].snapshots[0].environment.surface = "local-debug";
  await assert.rejects(
    () => verify(corpus, wrongSurface, activeRelease),
    /environment\.surface.*public-root/,
  );

  const unordered = evidence(corpus, activeRelease);
  [
    unordered.captures[0].snapshots[0],
    unordered.captures[0].snapshots[1],
  ] = [
    unordered.captures[0].snapshots[1],
    unordered.captures[0].snapshots[0],
  ];
  await assert.rejects(
    () => verify(corpus, unordered, activeRelease),
    /report\.cycles.*ordered strict progress/,
  );
});

test("IAB gate requires a valid full schema-2 release manifest", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();

  const schemaOne = structuredClone(activeRelease);
  schemaOne.schema = 1;
  await assert.rejects(
    () => verify(corpus, evidence(corpus, activeRelease), schemaOne),
    /\$\.release.*unsupported schema/,
  );

  const badSource = structuredClone(activeRelease);
  badSource.source.commit = "3".repeat(40);
  await assert.rejects(
    () => verify(corpus, evidence(corpus, activeRelease), badSource),
    /\$\.release.*source tree is not exact/,
  );

  const badDigest = structuredClone(activeRelease);
  badDigest.releaseId = "4".repeat(64);
  await assert.rejects(
    () => verify(corpus, evidence(corpus, activeRelease), badDigest),
    /\$\.release.*release ID does not match/,
  );
});

test("IAB gate rejects stale active-release relabels and immutable-frame drift", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const staleRelease = await release({
    assetHash: "4".repeat(64),
    commit: "3".repeat(40),
  });

  const staleRelabel = evidence(corpus, activeRelease);
  staleRelabel.observed.before.activeRelease = structuredClone(staleRelease);
  staleRelabel.observed.after.activeRelease = structuredClone(staleRelease);
  await assert.rejects(
    () => verify(corpus, staleRelabel, activeRelease),
    /observed\.before\.activeRelease.*does not match/,
  );

  const terminalReleaseDrift = evidence(corpus, activeRelease);
  terminalReleaseDrift.observed.after.activeRelease =
    structuredClone(staleRelease);
  await assert.rejects(
    () => verify(corpus, terminalReleaseDrift, activeRelease),
    /observed\.after\.activeRelease.*does not match/,
  );

  const frameQuery = evidence(corpus, activeRelease);
  frameQuery.frameUrl += "?stale=1";
  await assert.rejects(
    () => verify(corpus, frameQuery, activeRelease),
    /evidence\.frameUrl.*expected/,
  );

  const staleFrame = evidence(corpus, activeRelease);
  staleFrame.observed.after.navigation.iframe.url =
    new URL(staleRelease.frontend.url, PAGE_URL).href;
  await assert.rejects(
    () => verify(corpus, staleFrame, activeRelease),
    /observed\.after\.navigation\.iframe\.url.*expected/,
  );

  const loaderDrift = evidence(corpus, activeRelease);
  loaderDrift.observed.after.navigation.iframe.loaderId = "replacement-loader";
  await assert.rejects(
    () => verify(corpus, loaderDrift, activeRelease),
    /observed\.after\.navigation.*changed during the corpus run/,
  );
});

test("IAB gate requires exact indexed first-playable selections", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();

  const missing = evidence(corpus, activeRelease);
  delete missing.captures[0].firstPlayable;
  await assert.rejects(
    () => verify(corpus, missing, activeRelease),
    /captures\[0\]\.\[keys\].*firstPlayable/,
  );

  const extended = evidence(corpus, activeRelease);
  extended.captures[0].firstPlayable.milestone = "live-microgame";
  await assert.rejects(
    () => verify(corpus, extended, activeRelease),
    /firstPlayable\.\[keys\]/,
  );

  for (const [mutate, pattern] of [
    [value => { value.preIndex = -1; }, /preIndex.*non-negative/],
    [value => { value.postIndex = 3; }, /postIndex.*below 3/],
    [value => { value.postIndex = 0; }, /postIndex.*after preIndex/],
    [value => { value.preIndex = 1; }, /postIndex.*after preIndex/],
  ]) {
    const value = evidence(corpus, activeRelease);
    mutate(value.captures[0].firstPlayable);
    await assert.rejects(() => verify(corpus, value, activeRelease), pattern);
  }
});

test("IAB gate rejects wrong input, milestone state, and missing guest consumption", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();

  const wrongButton = evidence(corpus, activeRelease);
  wrongButton.captures[0].firstPlayable.button = "left";
  await assert.rejects(
    () => verify(corpus, wrongButton, activeRelease),
    /firstPlayable.*pulses\[0\]\.name.*expected "left", got "a"/,
  );

  const wrongMilestone = evidence(corpus, activeRelease);
  wrongMilestone.captures[0].snapshots[0]
    .report.guestGame.activeMicrogameId = 0x62;
  await assert.rejects(
    () => verify(corpus, wrongMilestone, activeRelease),
    /firstPlayable.*activeMicrogameId/,
  );

  const missingConsumption = evidence(corpus, activeRelease);
  missingConsumption.captures[0].snapshots[1]
    .report.guestGame.lastActiveGameplayInput = null;
  await assert.rejects(
    () => verify(corpus, missingConsumption, activeRelease),
    /firstPlayable.*lastActiveGameplayInput/,
  );

  const noVisualChange = evidence(corpus, activeRelease);
  noVisualChange.captures[0].snapshots[1]
    .report.rendering.selectedXfb.rgbSha256 =
      noVisualChange.captures[0].snapshots[0]
        .report.rendering.selectedXfb.rgbSha256;
  await assert.rejects(
    () => verify(corpus, noVisualChange, activeRelease),
    /firstPlayable.*distinct selected-XFB RGB hashes/,
  );
});

test("IAB gate propagates direct-renderer and runtime fault rejection", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const cases = [
    [
      value => {
        value.captures[0].snapshots[0].environment.dataset.renderer =
          "canvas-2d";
      },
      /dataset\.renderer.*wgpu-webgpu/,
    ],
    [
      value => {
        value.captures[0].snapshots[0].report.rendering.backend = "canvas-2d";
      },
      /rendering\.backend.*wgpu-webgpu/,
    ],
    [
      value => {
        value.captures[0].snapshots[0].report.deviceEvents.diskRequestError = 1;
      },
      /diskRequestError.*expected zero/,
    ],
    [
      value => {
        value.captures[0].snapshots[0]
          .report.gxFifo.decoder.unsupported.totalEvents = 1;
      },
      /unsupported\.totalEvents.*expected 0/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const value = evidence(corpus, activeRelease);
    mutate(value);
    await assert.rejects(() => verify(corpus, value, activeRelease), pattern);
  }
});

test("canonical corpus and policy digests ignore key order and change with policy", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const baseline = await verify(
    corpus,
    evidence(corpus, activeRelease),
    activeRelease,
  );
  assert.equal(
    baseline.corpus.sha256,
    await sha256Hex(canonicalStringify(corpus)),
  );
  const { sha256: policySha256, ...policyIdentity } = baseline.policy;
  assert.equal(
    policySha256,
    await sha256Hex(canonicalStringify(policyIdentity)),
  );

  const reordered = reverseObjectKeys(corpus);
  const reorderedProjection = await verify(
    reordered,
    evidence(reordered, activeRelease),
    activeRelease,
  );
  assert.equal(reorderedProjection.corpus.sha256, baseline.corpus.sha256);
  assert.equal(reorderedProjection.policy.sha256, baseline.policy.sha256);

  const changedMilestone = structuredClone(corpus);
  changedMilestone.games[0].milestone.description += " Certified.";
  const changedProjection = await verify(
    changedMilestone,
    evidence(changedMilestone, activeRelease),
    activeRelease,
  );
  assert.notEqual(changedProjection.corpus.sha256, baseline.corpus.sha256);
  assert.equal(changedProjection.policy.sha256, baseline.policy.sha256);

  const changedMilestoneId = structuredClone(corpus);
  changedMilestoneId.games[0].milestone.id = "live-microgame-certified";
  const milestoneIdProjection = await verify(
    changedMilestoneId,
    evidence(changedMilestoneId, activeRelease),
    activeRelease,
  );
  assert.notEqual(milestoneIdProjection.corpus.sha256, baseline.corpus.sha256);
  assert.notEqual(milestoneIdProjection.policy.sha256, baseline.policy.sha256);

  const changedThreshold = structuredClone(corpus);
  changedThreshold.evidence.sustainedViFields += 1;
  const thresholdProjection = await verify(
    changedThreshold,
    evidence(changedThreshold, activeRelease),
    activeRelease,
  );
  assert.notEqual(thresholdProjection.corpus.sha256, baseline.corpus.sha256);
  assert.notEqual(thresholdProjection.policy.sha256, baseline.policy.sha256);
});

test("IAB gate rejects envelope extensions and persists only the compact projection", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const extended = evidence(corpus, activeRelease);
  extended.romPath = "/Users/example/games/game.ciso";
  await assert.rejects(
    () => verify(corpus, extended, activeRelease),
    /evidence\.\[keys\]/,
  );

  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-gate-"));
  const outputPath = join(directory, "compatibility.json");
  try {
    const value = evidence(corpus, activeRelease);
    const projection = await writeBrowserGameCompatibilityIabProjection({
      corpus,
      evidence: value,
      outputPath,
      release: activeRelease,
    });
    const serialized = await readFile(outputPath, "utf8");
    assert.deepEqual(JSON.parse(serialized), projection);
    assert.deepEqual(Object.keys(projection).sort(), [
      "corpus",
      "fallbacks",
      "games",
      "policy",
      "releaseId",
      "renderer",
      "schema",
      "source",
      "surface",
    ]);
    assert.equal(projection.schema, BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA);
    assert.deepEqual(Object.keys(projection.games[0]).sort(), [
      "delta",
      "disc",
      "firstPlayable",
      "firstVisible",
      "image",
      "key",
      "priority",
      "samples",
    ]);
    assert.deepEqual(Object.keys(projection.games[0].firstPlayable).sort(), [
      "change",
      "input",
      "milestone",
      "schema",
    ]);
    for (const forbidden of [
      ".ciso",
      "/Users/",
      "pageUrl",
      "frameUrl",
      "snapshots",
      "activeRelease",
      "activeMicrogameId",
      "logical-range-endpoint",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.ok(serialized.length < 20_000, serialized.length);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
