// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
} from "../web/release.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V5,
} from "./browser_boot_smb_sustained_play.mjs";
import {
  smbSustainedPlayReport,
} from "./browser_boot_smb_sustained_play_test_fixture.mjs";
import {
  deriveSmbSustainedPresentedSurfaceHistoryOracle,
} from "./browser_boot_smb_sustained_surface_history.mjs";
import {
  canonicalStringify,
} from "./browser_boot_checkpoint_core.mjs";
import {
  GAME_COMPATIBILITY_CORPUS_PATH,
  readGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
  BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA,
  BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA,
  BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
  CANONICAL_SMB_COMPATIBILITY_GAME,
  finalizeBrowserGameCompatibilityIabSession,
  parseBrowserGameCompatibilityIabGateArguments,
  prepareBrowserGameCompatibilityIabSession,
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
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

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

async function release({ assetHash = ASSET_HASH, commit = COMMIT } = {}) {
  const repository = "https://github.com/conradev/lazuli";
  const value = {
    schema: 3,
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
    dsp: asset("browser-dsp", "wasm", 4_000, assetHash),
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: assetHash,
      bytes: WASM_CHUNK_SIZE,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [asset("ppcwasmjit-0000", "wasm", WASM_CHUNK_SIZE, assetHash)],
    },
  };
  value.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(value)));
  return value;
}

function documentId(ordinal) {
  return `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
}

function observed(activeRelease, ordinal) {
  const frameUrl = new URL(activeRelease.frontend.url, PAGE_URL).href;
  const identity = {
    activeRelease: structuredClone(activeRelease),
    pageUrl: PAGE_URL,
    frameUrl,
    documentId: documentId(ordinal),
    workerRunId: "1",
  };
  return { before: identity, after: structuredClone(identity) };
}

function snapshotCaptureIdentity(observedPair, sessionId) {
  return {
    documentId: observedPair.before.documentId,
    sessionId,
    workerRunId: observedPair.before.workerRunId,
  };
}

function publicSnapshot(game, report, captureIdentity) {
  const headless = report.headlessCapture;
  delete report.headlessCapture;
  report.disc.source = { kind: "local-file" };
  const dsp = report.audioCompatibility?.dspLle;
  if (dsp !== undefined) {
    dsp.lastExecutionCycle = report.cycles;
    dsp.nextExecutionCycle = report.cycles + 768 - dsp.pendingCpuCycles;
  }
  return {
    environment: {
      captureIdentity: structuredClone(captureIdentity),
      surface: "public-root",
      dataset: structuredClone(headless.dataset),
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

function capture(game, activeRelease, ordinal, sessionId) {
  const fixture = FIRST_PLAYABLE_FIXTURES[game.key];
  assert.ok(fixture, `missing fixture for ${game.key}`);
  const { postReport, preReport } = fixture.pair(game);
  const observedPair = observed(activeRelease, ordinal);
  const captureIdentity = snapshotCaptureIdentity(observedPair, sessionId);
  return {
    gameKey: game.key,
    observed: observedPair,
    firstPlayable: { button: fixture.button, preIndex: 0, postIndex: 1 },
    snapshots: [
      publicSnapshot(game, preReport, captureIdentity),
      publicSnapshot(game, postReport, captureIdentity),
      publicSnapshot(
        game,
        makeGameFirstPlayableReport(game, 2),
        captureIdentity,
      ),
    ],
  };
}

function smbCapture(activeRelease, sessionId) {
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V5);
  delete report.headlessCapture;
  report.disc.source = { kind: "local-file" };
  const observedPair = observed(activeRelease, 1);
  return {
    gameKey: CANONICAL_SMB_COMPATIBILITY_GAME.key,
    observed: observedPair,
    snapshot: {
      environment: {
        captureIdentity: snapshotCaptureIdentity(observedPair, sessionId),
        surface: "public-root",
        dataset: { renderer: "wgpu-webgpu", status: "paused" },
        devtoolsExceptions: [],
        discImage: structuredClone(CANONICAL_SMB_COMPATIBILITY_GAME.image),
      },
      report,
    },
  };
}

function evidence(corpus, activeRelease, sessionId = SESSION_ID) {
  return {
    schema: BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
    sessionId,
    smb: smbCapture(activeRelease, sessionId),
    captures: [...corpus.games]
      .sort((left, right) => left.priority - right.priority)
      .map((game, index) => capture(game, activeRelease, index + 2, sessionId)),
  };
}

function verify(corpus, value, expectedRelease, expectedSessionId = null) {
  return verifyBrowserGameCompatibilityIabEvidence({
    corpus,
    evidence: value,
    expectedSessionId,
    release: expectedRelease,
  });
}

function syncSurfacePopulations(surface) {
  const fields = [surface.fields.top, surface.fields.bottom];
  for (const name of ["black", "white", "other"]) {
    surface.rgb[name] = fields.reduce((sum, field) => sum + field.rgb[name], 0);
  }
  for (const [target, source] of [["dark", "dark"], ["light", "light"], ["other", "other"]]) {
    surface.visualRgb[target] = fields.reduce(
      (sum, field) => sum + field.visualRgb[source],
      0,
    );
  }
}

function makeSurfaceExtreme(surface, white) {
  for (const field of Object.values(surface.fields)) {
    const pixels = field.width * field.height;
    field.rgb = {
      black: white ? 0 : pixels,
      white: white ? pixels : 0,
      other: 0,
      unique: 1,
    };
    field.visualRgb = {
      dark: white ? 0 : pixels,
      light: white ? pixels : 0,
      other: 0,
    };
  }
  surface.rgb.unique = 1;
  syncSurfacePopulations(surface);
}

test("v2 gate certifies canonical SMB plus the exact seven-game corpus", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const value = evidence(corpus, activeRelease);
  const first = await verify(corpus, value, activeRelease, SESSION_ID);
  const second = await verify(corpus, structuredClone(value), activeRelease);

  assert.deepEqual(first, second);
  assert.equal(first.schema, BROWSER_GAME_COMPATIBILITY_IAB_PROJECTION_SCHEMA);
  assert.equal(first.games.length, 7);
  assert.equal(first.smb.key, "super-monkey-ball-usa");
  assert.equal(first.smb.disc.identifier, "GMBE8P");
  assert.equal(first.smb.disc.revision, 0);
  assert.equal(first.smb.image.sha256, CANONICAL_SMB_COMPATIBILITY_GAME.image.sha256);
  assert.equal(first.smb.sustained.schema, SMB_SUSTAINED_PLAY_SCHEMA_V5);
  assert.equal(first.smb.sustained.complete, true);
  assert.deepEqual(first.smb.temporal, {
    captured: 60,
    distinctRgbHashes: 60,
    blackWhiteTransitions: 0,
    nearBlackWhiteTransitions: 0,
    monochromeFrames: 0,
    nearBlackFrames: 0,
    nearWhiteFrames: 0,
  });
  assert.deepEqual(
    first.games.map(game => game.key),
    corpus.games.map(game => game.key),
  );
  assert.equal(first.renderer, "wgpu-webgpu");
  assert.equal(first.fallbacks, false);
  assert.equal(first.surface, "fresh-loopback-public-root-local-file");
  assert.equal(first.source.commit, COMMIT);
  assert.equal(first.releaseId, activeRelease.releaseId);
  assert.match(first.captureSha256, /^[0-9a-f]{64}$/);
  assert.match(first.corpus.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.policy.schema, BROWSER_GAME_COMPATIBILITY_IAB_POLICY_SCHEMA);
  assert.deepEqual(first.policy.suite, [
    "super-monkey-ball-usa",
    ...corpus.games.map(game => game.key),
  ]);
  assert.equal(first.policy.smb.temporalFlicker,
    "reject-black-white-monochrome-near-extreme");
  assert.deepEqual(
    first.games.map(game => game.firstPlayable.input.button),
    ["a", "left", "left", "left", "left", "left", "left"],
  );
  assert.equal(JSON.stringify(value).includes("headlessCapture"), false);
  assert.equal(JSON.stringify(value).includes("frameId"), false);
  assert.equal(JSON.stringify(value).includes("loaderId"), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.games), true);
});

test("v2 gate fails closed for missing or wrong canonical SMB", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const base = evidence(corpus, activeRelease);
  const cases = [
    [value => { value.smb = null; }, /evidence\.smb.*expected an object/],
    [
      value => { value.smb.gameKey = "super-monkey-ball-japan"; },
      /smb\.gameKey.*super-monkey-ball-usa/,
    ],
    [
      value => { value.smb.snapshot.environment.discImage.sha256 = "f".repeat(64); },
      /smb\.snapshot\.environment\.discImage\.sha256/,
    ],
    [
      value => { value.smb.snapshot.report.disc.identifier = "GMBJ8P"; },
      /smb\.snapshot\.report\.disc\.identifier/,
    ],
    [
      value => { value.smb.snapshot.report.sustainedPlay.schema = "lazuli-smb-sustained-play-v3"; },
      /sustainedPlay\.schema.*v5/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const value = structuredClone(base);
    mutate(value);
    await assert.rejects(() => verify(corpus, value, activeRelease), pattern);
  }
});

test("v2 gate rejects partial, duplicate, unknown, and misordered corpus suites", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const base = evidence(corpus, activeRelease);
  const cases = [
    [value => { value.captures.pop(); }, /every corpus game exactly once; missing/],
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
    const value = structuredClone(base);
    mutate(value);
    await assert.rejects(() => verify(corpus, value, activeRelease), pattern);
  }
});

test("v2 observations use only fresh IAB-readable root/document/run identities", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const staleRelease = await release({ assetHash: "4".repeat(64), commit: "3".repeat(40) });
  const base = evidence(corpus, activeRelease);
  const cases = [
    [
      value => { value.captures[0].observed.before.pageUrl =
        "http://127.0.0.1:8768/warioware"; },
      /queryless loopback HTTP root/,
    ],
    [
      value => { value.captures[0].observed.before.frameUrl += "?stale=1"; },
      /frameUrl.*expected/,
    ],
    [
      value => { value.captures[0].observed.before.activeRelease = staleRelease; },
      /activeRelease.*does not match/,
    ],
    [
      value => { value.captures[0].observed.after.documentId = documentId(99); },
      /observed\.after\.documentId/,
    ],
    [
      value => { value.captures[0].observed.after.workerRunId = "2"; },
      /observed\.after\.workerRunId/,
    ],
    [
      value => { value.captures[1].observed.before.documentId =
        value.captures[0].observed.before.documentId;
        value.captures[1].observed.after.documentId =
          value.captures[0].observed.before.documentId; },
      /fresh immutable frontend document/,
    ],
    [
      value => { value.captures[0].observed.before.navigation = {}; },
      /observed\.before\.\[keys\]/,
    ],
    [
      value => { value.sessionId = documentId(200); },
      /evidence\.sessionId/,
      SESSION_ID,
    ],
  ];
  for (const [mutate, pattern, expectedSessionId = null] of cases) {
    const value = structuredClone(base);
    mutate(value);
    await assert.rejects(
      () => verify(corpus, value, activeRelease, expectedSessionId),
      pattern,
    );
  }
});

test("v2 public snapshots bind an exact capture identity to their title and session", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const base = evidence(corpus, activeRelease);
  const cases = [
    [
      value => { delete value.smb.snapshot.environment.captureIdentity; },
      /smb\.snapshot\.environment\.\[keys\].*captureIdentity/,
    ],
    [
      value => { value.captures[0].snapshots[0].environment.provenance = {}; },
      /captures\[0\]\.snapshots\[0\]\.environment\.\[keys\]/,
    ],
    [
      value => {
        value.captures[0].snapshots[0].environment.captureIdentity.frameId = "stale";
      },
      /captureIdentity\.\[keys\]/,
    ],
    [
      value => {
        value.smb.snapshot.environment.captureIdentity.documentId = documentId(99);
      },
      /smb\.snapshot\.environment\.captureIdentity\.documentId/,
    ],
    [
      value => {
        value.captures[0].snapshots[1].environment.captureIdentity.workerRunId = "2";
      },
      /captures\[0\]\.snapshots\[1\]\.environment\.captureIdentity\.workerRunId/,
    ],
    [
      value => {
        value.captures[6].snapshots[2].environment.captureIdentity.sessionId =
          documentId(200);
      },
      /captures\[6\]\.snapshots\[2\]\.environment\.captureIdentity\.sessionId/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const value = structuredClone(base);
    mutate(value);
    await assert.rejects(() => verify(corpus, value, activeRelease), pattern);
  }
});

test("v2 gate rejects WebGPU fallback and temporal black/white SMB flicker", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const base = evidence(corpus, activeRelease);
  const fallbackCases = [
    value => { value.smb.snapshot.environment.dataset.renderer = "canvas-2d"; },
    value => { value.smb.snapshot.report.rendering.backend = "canvas-2d"; },
    value => { value.captures[0].snapshots[0].environment.dataset.renderer = "canvas-2d"; },
    value => { value.captures[0].snapshots[0].report.rendering.backend = "canvas-2d"; },
  ];
  for (const mutate of fallbackCases) {
    const value = structuredClone(base);
    mutate(value);
    await assert.rejects(() => verify(corpus, value, activeRelease), /wgpu-webgpu/);
  }

  const flicker = structuredClone(base);
  const history = flicker.smb.snapshot.report.rendering.sustainedPresentedSurfaces;
  makeSurfaceExtreme(history.frames[10].presentedSurface, false);
  makeSurfaceExtreme(history.frames[11].presentedSurface, true);
  history.oracle = deriveSmbSustainedPresentedSurfaceHistoryOracle(
    history.frames,
    history.schema,
  );
  await assert.rejects(
    () => verify(corpus, flicker, activeRelease),
    /monochromeOrdinals|blackWhiteTransitionOrdinals|nearBlackWhite/,
  );
});

test("v2 gate requires the repository's exact canonical seven-game corpus", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const changed = structuredClone(corpus);
  changed.games[0].milestone.description += " Changed.";
  await assert.rejects(
    () => verify(changed, evidence(corpus, activeRelease), activeRelease),
    /exact repository seven-game compatibility corpus/,
  );
});

function localGameImages(corpus) {
  return [...corpus.games]
    .sort((left, right) => left.priority - right.priority)
    .map(game => ({
      bytes: game.bytes,
      disc: game.disc,
      file: game.file,
      image: { algorithm: "sha256", ...game.image },
      key: game.key,
      milestone: game.milestone.id,
      priority: game.priority,
    }));
}

function prepareDependencies(
  corpus,
  smbPath,
  { wrongGame = null, wrongSmb = false } = {},
) {
  const identified = [];
  const calls = { readCorpus: 0, statFile: 0, verifyCorpus: 0 };
  return {
    calls,
    identified,
    dependencies: {
      makeSessionId: () => SESSION_ID,
      readCorpus: async () => {
        calls.readCorpus += 1;
        return structuredClone(corpus);
      },
      statFile: async path => {
        calls.statFile += 1;
        return {
          isFile: () => path === smbPath,
          size: 123_456,
        };
      },
      identify: async path => {
        identified.push(path);
        if (path === smbPath) {
          return {
            ...CANONICAL_SMB_COMPATIBILITY_GAME.image,
            ...(wrongSmb ? { sha256: "f".repeat(64) } : {}),
          };
        }
        const game = corpus.games.find(candidate => path.endsWith(candidate.file));
        assert.ok(game, path);
        return {
          algorithm: "sha256",
          ...game.image,
          ...(wrongGame === game.key ? { sha256: "e".repeat(64) } : {}),
        };
      },
      verifyCorpus: async (supplied, { directory, identify }) => {
        calls.verifyCorpus += 1;
        assert.deepEqual(supplied, corpus);
        for (const game of corpus.games) {
          const actual = await identify(join(directory, game.file));
          if (
            canonicalStringify(actual)
            !== canonicalStringify({ algorithm: "sha256", ...game.image })
          ) {
            throw new Error(`local game image identity mismatch for ${game.key}`);
          }
        }
        return localGameImages(corpus);
      },
    },
  };
}

async function completeSessionFixture(directory, corpus, activeRelease) {
  const releasePath = join(directory, "release.json");
  const gamesDirectory = join(directory, "games-private");
  const smbPath = join(directory, "Super Monkey Ball.ciso");
  const sessionPath = join(directory, "session.private.json");
  const outputPath = join(directory, "certificate.json");
  await writeFile(releasePath, JSON.stringify(activeRelease), "utf8");
  const harness = prepareDependencies(corpus, smbPath);
  const session = await prepareBrowserGameCompatibilityIabSession({
    gamesDirectory,
    releasePath,
    sessionPath,
    smbPath,
  }, harness.dependencies);
  session.evidence = evidence(corpus, activeRelease);
  await writeFile(sessionPath, `${JSON.stringify(session)}\n`, "utf8");
  return {
    gamesDirectory,
    harness,
    outputPath,
    releasePath,
    session,
    sessionPath,
    smbPath,
  };
}

test("prepare verifies all eight images and resumes without clearing evidence", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-session-"));
  const releasePath = join(directory, "release.json");
  const gamesDirectory = join(directory, "games-private");
  const smbPath = join(directory, "Super Monkey Ball.ciso");
  const sessionPath = join(directory, "session.private.json");
  await writeFile(releasePath, JSON.stringify(activeRelease), "utf8");
  const harness = prepareDependencies(corpus, smbPath);
  try {
    const prepared = await prepareBrowserGameCompatibilityIabSession({
      gamesDirectory,
      releasePath,
      sessionPath,
      smbPath,
    }, harness.dependencies);
    assert.equal(prepared.schema, BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA);
    assert.equal(prepared.id, SESSION_ID);
    assert.deepEqual(prepared.evidence, {
      schema: BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
      sessionId: SESSION_ID,
      smb: null,
      captures: [],
    });
    assert.equal(harness.identified.length, 8);
    assert.equal(harness.identified.at(-1), smbPath);
    assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);

    prepared.evidence = evidence(corpus, activeRelease);
    const persisted = JSON.parse(JSON.stringify(prepared));
    await writeFile(sessionPath, `${JSON.stringify(persisted)}\n`, "utf8");
    const resumed = await prepareBrowserGameCompatibilityIabSession({
      gamesDirectory,
      releasePath,
      sessionPath,
      smbPath,
    }, harness.dependencies);
    assert.deepEqual(resumed.evidence, persisted.evidence);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("prepare rejects missing and wrong SMB without creating a session", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-smb-"));
  const releasePath = join(directory, "release.json");
  const gamesDirectory = join(directory, "games-private");
  const smbPath = join(directory, "Super Monkey Ball.ciso");
  const sessionPath = join(directory, "session.private.json");
  await writeFile(releasePath, JSON.stringify(activeRelease), "utf8");
  try {
    const missing = prepareDependencies(corpus, smbPath);
    missing.dependencies.statFile = async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    };
    await assert.rejects(
      () => prepareBrowserGameCompatibilityIabSession({
        gamesDirectory,
        releasePath,
        sessionPath,
        smbPath,
      }, missing.dependencies),
      /could not stat canonical SMB image/,
    );
    await assert.rejects(() => readFile(sessionPath), /ENOENT/);

    const wrong = prepareDependencies(corpus, smbPath, { wrongSmb: true });
    await assert.rejects(
      () => prepareBrowserGameCompatibilityIabSession({
        gamesDirectory,
        releasePath,
        sessionPath,
        smbPath,
      }, wrong.dependencies),
      /canonical SMB image identity mismatch/,
    );
    await assert.rejects(() => readFile(sessionPath), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("resume requires a private regular 0600 session file", async t => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();

  await t.test("rejects a permissive mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-resume-mode-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      await chmod(fixture.sessionPath, 0o644);
      await assert.rejects(
        () => prepareBrowserGameCompatibilityIabSession({
          gamesDirectory: fixture.gamesDirectory,
          releasePath: fixture.releasePath,
          sessionPath: fixture.sessionPath,
          smbPath: fixture.smbPath,
        }, fixture.harness.dependencies),
        /session.*(?:private|mode|0600)|0600.*session/i,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await t.test("rejects a symbolic link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-resume-link-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      const linkedSessionPath = join(directory, "session-link.json");
      await symlink(fixture.sessionPath, linkedSessionPath);
      await assert.rejects(
        () => prepareBrowserGameCompatibilityIabSession({
          gamesDirectory: fixture.gamesDirectory,
          releasePath: fixture.releasePath,
          sessionPath: linkedSessionPath,
          smbPath: fixture.smbPath,
        }, fixture.harness.dependencies),
        /symbolic link|symlink|regular.*session/i,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("finalize requires a private regular 0600 session file", async t => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();

  await t.test("rejects a permissive mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-final-mode-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      await chmod(fixture.sessionPath, 0o644);
      await assert.rejects(
        () => finalizeBrowserGameCompatibilityIabSession({
          outputPath: fixture.outputPath,
          sessionPath: fixture.sessionPath,
        }, fixture.harness.dependencies),
        /session.*(?:private|mode|0600)|0600.*session/i,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await t.test("rejects a symbolic link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-final-link-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      const linkedSessionPath = join(directory, "session-link.json");
      await symlink(fixture.sessionPath, linkedSessionPath);
      await assert.rejects(
        () => finalizeBrowserGameCompatibilityIabSession({
          outputPath: fixture.outputPath,
          sessionPath: linkedSessionPath,
        }, fixture.harness.dependencies),
        /symbolic link|symlink|regular.*session/i,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("finalize revalidates release, the seven-game corpus, and SMB", async t => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();

  await t.test("rejects a release manifest changed after prepare", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-mutate-release-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      const changedRelease = await release({
        assetHash: "4".repeat(64),
        commit: "3".repeat(40),
      });
      await writeFile(fixture.releasePath, JSON.stringify(changedRelease), "utf8");
      await assert.rejects(
        () => finalizeBrowserGameCompatibilityIabSession({
          outputPath: fixture.outputPath,
          sessionPath: fixture.sessionPath,
        }, fixture.harness.dependencies),
        /release.*(?:changed|mismatch)|prepared inputs changed/i,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await t.test("rejects a changed local corpus image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-mutate-game-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      const changed = prepareDependencies(corpus, fixture.smbPath, {
        wrongGame: corpus.games[0].key,
      });
      await assert.rejects(
        () => finalizeBrowserGameCompatibilityIabSession({
          outputPath: fixture.outputPath,
          sessionPath: fixture.sessionPath,
        }, changed.dependencies),
        /local game image identity mismatch|games.*changed|prepared inputs changed/i,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await t.test("rejects a changed SMB image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-mutate-smb-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      const changed = prepareDependencies(corpus, fixture.smbPath, {
        wrongSmb: true,
      });
      await assert.rejects(
        () => finalizeBrowserGameCompatibilityIabSession({
          outputPath: fixture.outputPath,
          sessionPath: fixture.sessionPath,
        }, changed.dependencies),
        /SMB image identity mismatch|smb.*changed|prepared inputs changed/i,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("session and output paths cannot clobber the corpus or canonical games", async t => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();

  await t.test("prepare rejects a canonical game path as its session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-session-game-"));
    const releasePath = join(directory, "release.json");
    const gamesDirectory = join(directory, "games-private");
    const smbPath = join(directory, "Super Monkey Ball.ciso");
    const sessionPath = join(gamesDirectory, corpus.games[0].file);
    await writeFile(releasePath, JSON.stringify(activeRelease), "utf8");
    const harness = prepareDependencies(corpus, smbPath);
    try {
      await assert.rejects(
        () => prepareBrowserGameCompatibilityIabSession({
          gamesDirectory,
          releasePath,
          sessionPath,
          smbPath,
        }, harness.dependencies),
        /--session must not overwrite input/,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await t.test("prepare rejects the repository corpus path as its session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-session-corpus-"));
    const releasePath = join(directory, "release.json");
    const gamesDirectory = join(directory, "games-private");
    const smbPath = join(directory, "Super Monkey Ball.ciso");
    await writeFile(releasePath, JSON.stringify(activeRelease), "utf8");
    const harness = prepareDependencies(corpus, smbPath);
    try {
      await assert.rejects(
        () => prepareBrowserGameCompatibilityIabSession({
          gamesDirectory,
          releasePath,
          sessionPath: GAME_COMPATIBILITY_CORPUS_PATH,
          smbPath,
        }, harness.dependencies),
        /--session must not overwrite input/,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await t.test("finalize rejects a canonical game path as output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-output-game-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      const outputPath = join(fixture.gamesDirectory, corpus.games[0].file);
      await assert.rejects(
        () => finalizeBrowserGameCompatibilityIabSession({
          outputPath,
          sessionPath: fixture.sessionPath,
        }, fixture.harness.dependencies),
        /--output must not overwrite input/,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  await t.test("finalize rejects the repository corpus path as output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-output-corpus-"));
    try {
      const fixture = await completeSessionFixture(directory, corpus, activeRelease);
      fixture.session.evidence = {};
      await writeFile(
        fixture.sessionPath,
        `${JSON.stringify(fixture.session)}\n`,
        "utf8",
      );
      await assert.rejects(
        () => finalizeBrowserGameCompatibilityIabSession({
          outputPath: GAME_COMPATIBILITY_CORPUS_PATH,
          sessionPath: fixture.sessionPath,
        }, fixture.harness.dependencies),
        /--output must not overwrite input/,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("finalize emits only a compact path-free certificate", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const activeRelease = await release();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-finalize-"));
  const releasePath = join(directory, "release.json");
  const gamesDirectory = join(directory, "games-private");
  const smbPath = join(directory, "Super Monkey Ball.ciso");
  const sessionPath = join(directory, "session.private.json");
  const outputPath = join(directory, "certificate.json");
  await writeFile(releasePath, JSON.stringify(activeRelease), "utf8");
  const harness = prepareDependencies(corpus, smbPath);
  try {
    const session = await prepareBrowserGameCompatibilityIabSession({
      gamesDirectory,
      releasePath,
      sessionPath,
      smbPath,
    }, harness.dependencies);
    session.evidence = evidence(corpus, activeRelease);
    await writeFile(sessionPath, `${JSON.stringify(session)}\n`, "utf8");
    const projection = await finalizeBrowserGameCompatibilityIabSession({
      outputPath,
      sessionPath,
    }, harness.dependencies);
    assert.equal(harness.calls.readCorpus, 1);
    assert.equal(harness.calls.verifyCorpus, 2);
    assert.equal(harness.identified.length, 16);
    const serialized = await readFile(outputPath, "utf8");
    assert.deepEqual(JSON.parse(serialized), projection);
    assert.equal(serialized.includes('\n  "'), false);
    assert.ok(serialized.length < 25_000, serialized.length);
    for (const forbidden of [
      directory,
      ".ciso",
      "sessionId",
      SESSION_ID,
      "pageUrl",
      "frameUrl",
      "documentId",
      "workerRunId",
      "headlessCapture",
      "snapshots",
      "activeRelease",
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }

    const secondOutput = join(directory, "certificate-direct.json");
    const direct = await writeBrowserGameCompatibilityIabProjection({
      corpus,
      evidence: session.evidence,
      expectedSessionId: SESSION_ID,
      outputPath: secondOutput,
      release: activeRelease,
    });
    assert.equal(
      await sha256Hex(canonicalStringify(direct)),
      await sha256Hex(canonicalStringify(projection)),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("prepare/finalize CLI parsing is exact and path-safe", () => {
  const prepared = parseBrowserGameCompatibilityIabGateArguments([
    "prepare",
    "--release", "release.json",
    "--games", "games",
    "--smb", "smb.ciso",
    "--session", "session.json",
  ]);
  assert.deepEqual(prepared, {
    command: "prepare",
    releasePath: resolve("release.json"),
    gamesDirectory: resolve("games"),
    smbPath: resolve("smb.ciso"),
    sessionPath: resolve("session.json"),
  });
  assert.deepEqual(
    parseBrowserGameCompatibilityIabGateArguments([
      "finalize", "--session", "session.json", "--output", "out.json",
    ]),
    {
      command: "finalize",
      sessionPath: resolve("session.json"),
      outputPath: resolve("out.json"),
    },
  );
  for (const argv of [
    [],
    ["prepare", "--release", "release.json"],
    ["prepare", "--release", "a", "--release", "b"],
    ["finalize", "--session", "s", "--output"],
    ["finalize", "--session", "s", "--output", "o", "--games", "g"],
  ]) {
    assert.throws(
      () => parseBrowserGameCompatibilityIabGateArguments(argv),
      /expected prepare|is required|duplicate argument|missing value|unknown argument/,
    );
  }
});
