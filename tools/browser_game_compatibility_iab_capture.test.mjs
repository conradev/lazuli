// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
} from "../web/release.mjs";
import {
  BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_DEFAULTS,
  BROWSER_GAME_COMPATIBILITY_IAB_WITNESS_BUTTONS,
  browserGameCompatibilityIabCaptureStatus,
  configuredBrowserGameCompatibilityIabUrl,
  dispatchBrowserGameCompatibilityIabControllerClick,
  mergeBrowserGameCompatibilityIabCapture,
  observeBrowserGameCompatibilityIabActiveRelease,
  parseBrowserGameCompatibilityIabCaptureArguments,
  persistBrowserGameCompatibilityIabCapture,
  withPrivateIabSessionLock,
  writePrivateIabSessionAtomic,
} from "./browser_game_compatibility_iab_capture.mjs";
import {
  BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
  BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
} from "./browser_game_compatibility_iab_gate.mjs";
import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ASSET_HASH = "2".repeat(64);

function asset(prefix, extension, bytes, hash = ASSET_HASH) {
  return {
    url: `/assets/${prefix}-${hash}.${extension}`,
    sha256: hash,
    bytes,
  };
}

async function release(commit = "1".repeat(40)) {
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
    frontend: asset("frontend", "html", 1_234),
    renderer: {
      javascript: asset("renderer", "js", 2_345),
      wasm: asset("renderer-wasm", "wasm", 3_456),
    },
    dsp: asset("browser-dsp", "wasm", 4_000),
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: ASSET_HASH,
      bytes: WASM_CHUNK_SIZE,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [asset("ppcwasmjit-0000", "wasm", WASM_CHUNK_SIZE)],
    },
  };
  value.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(value)));
  return value;
}

function partialSession(captures = [], smb = null) {
  return {
    schema: BROWSER_GAME_COMPATIBILITY_IAB_SESSION_SCHEMA,
    id: SESSION_ID,
    inputs: {},
    evidence: {
      schema: BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_SCHEMA,
      sessionId: SESSION_ID,
      smb,
      captures,
    },
  };
}

function looseSessionReader(corpus) {
  return async path => ({
    corpus,
    path,
    session: JSON.parse(await readFile(path, "utf8")),
  });
}

test("capture CLI defaults to the isolated queryless loopback surface", () => {
  const sessionPath = resolve("session.private.json");
  assert.deepEqual(parseBrowserGameCompatibilityIabCaptureArguments([
    "capture-game",
    "--session", "session.private.json",
    "--game", "rogue-leader-usa",
  ]), {
    command: "capture-game",
    endpoint: BROWSER_GAME_COMPATIBILITY_IAB_CAPTURE_DEFAULTS.endpoint,
    gameKey: "rogue-leader-usa",
    pollMs: 1_000,
    publicUrl: "http://127.0.0.1:8768/",
    sessionPath,
    timeoutMs: 3_600_000,
  });
  assert.deepEqual(parseBrowserGameCompatibilityIabCaptureArguments([
    "status",
    "--session", "session.private.json",
  ]), { command: "status", sessionPath });
});

test("capture CLI rejects ambiguous public surfaces and malformed options", () => {
  for (const value of [
    "https://127.0.0.1:8768/",
    "http://192.0.2.1:8768/",
    "http://127.0.0.1:8768/game",
    "http://127.0.0.1:8768/?scenario=debug",
    "http://127.0.0.1:8768/#debug",
  ]) {
    assert.throws(
      () => configuredBrowserGameCompatibilityIabUrl(value),
      /queryless loopback HTTP root/,
    );
  }
  assert.throws(
    () => parseBrowserGameCompatibilityIabCaptureArguments([
      "capture-game",
      "--session", "session.json",
      "--game", "Rogue",
    ]),
    /lowercase kebab-case/,
  );
  assert.throws(
    () => parseBrowserGameCompatibilityIabCaptureArguments([
      "status",
      "--session", "one.json",
      "--session", "two.json",
    ]),
    /duplicate argument/,
  );
});

test("capture configures a reproducible viewport and clears it without masking results", async () => {
  const source = await readFile(
    new URL("./browser_game_compatibility_iab_capture.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /await configurePublicViewport\(session\);\s+viewportConfigured = true;/,
  );
  assert.match(
    source,
    /if \(viewportConfigured\) await clearPublicViewport\(session\)\.catch\(\(\) => \{\}\);/,
  );
});

test("status and merge preserve canonical corpus priority and resumability", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const first = { gameKey: "warioware-usa", marker: 1 };
  const last = { gameKey: "rogue-leader-usa", marker: 7 };
  const session = partialSession([last]);
  // Existing partial sessions must already be sorted, so insert the first game
  // into an otherwise valid high-priority-only session.
  const merged = mergeBrowserGameCompatibilityIabCapture(session, corpus, first);
  assert.equal(merged.changed, true);
  assert.deepEqual(
    merged.session.evidence.captures.map(capture => capture.gameKey),
    ["warioware-usa", "rogue-leader-usa"],
  );
  const repeated = mergeBrowserGameCompatibilityIabCapture(
    merged.session,
    corpus,
    structuredClone(first),
  );
  assert.equal(repeated.changed, false);
  assert.strictEqual(repeated.session, merged.session);
  assert.throws(
    () => mergeBrowserGameCompatibilityIabCapture(
      merged.session,
      corpus,
      { ...first, marker: 2 },
    ),
    /refusing to replace different evidence/,
  );
  const status = browserGameCompatibilityIabCaptureStatus(merged.session, corpus);
  assert.deepEqual(status.games.captured, ["warioware-usa", "rogue-leader-usa"]);
  assert.equal(status.games.next, "luigis-mansion-usa");
  assert.equal(status.captureComplete, false);
  assert.equal(status.suiteComplete, false);
});

test("every corpus game has the projector-required witness button", async () => {
  const corpus = await readGameCompatibilityCorpus();
  assert.deepEqual(
    Object.keys(BROWSER_GAME_COMPATIBILITY_IAB_WITNESS_BUTTONS).sort(),
    corpus.games.map(game => game.key).sort(),
  );
  assert.equal(BROWSER_GAME_COMPATIBILITY_IAB_WITNESS_BUTTONS["warioware-usa"], "a");
  for (const game of corpus.games.filter(game => game.key !== "warioware-usa")) {
    assert.equal(BROWSER_GAME_COMPATIBILITY_IAB_WITNESS_BUTTONS[game.key], "left");
  }
});

test("controller interaction dispatches a visible CDP pointer click", async () => {
  const calls = [];
  let expression = null;
  const session = {
    async evaluate(value) {
      expression = value;
      return {
        disabled: false,
        display: "block",
        height: 40,
        hit: true,
        topHit: true,
        visibility: "visible",
        width: 40,
        x: 123,
        y: 456,
      };
    },
    async send(method, params) {
      calls.push({ method, params });
      return {};
    },
  };
  const click = await dispatchBrowserGameCompatibilityIabControllerClick(
    session,
    "left",
    { delay: async () => {} },
  );
  assert.deepEqual(click, { button: "left", x: 123, y: 456 });
  assert.match(expression, /#controller-left/);
  assert.doesNotMatch(expression, /\.click\s*\(/);
  assert.doesNotMatch(expression, /lazuliController/);
  assert.deepEqual(calls.map(call => call.method), [
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
  ]);
  assert.deepEqual(calls.map(call => call.params.type), [
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);
});

test("full active-release observer validates and returns the exact manifest", async () => {
  const activeRelease = await release();
  const observations = [];
  const session = {
    async evaluate(expression) {
      observations.push(expression);
      return {
        body: JSON.stringify(activeRelease),
        controlled: true,
        error: null,
        pathname: "/",
        status: 200,
      };
    },
  };
  const observed = await observeBrowserGameCompatibilityIabActiveRelease(
    session,
    {
      expectedRelease: activeRelease,
      publicUrl: "http://127.0.0.1:8768/",
    },
  );
  assert.deepEqual(observed, activeRelease);
  assert.equal(observations.length, 1);
  assert.match(observations[0], /\.gekko\/active-release/);

  const stale = await release("3".repeat(40));
  session.evaluate = async () => ({
    body: JSON.stringify(stale),
    controlled: true,
    error: null,
    pathname: "/",
    status: 200,
  });
  await assert.rejects(
    () => observeBrowserGameCompatibilityIabActiveRelease(session, {
      expectedRelease: activeRelease,
      publicUrl: "http://127.0.0.1:8768/",
    }),
    /observed active release changed from the prepared value/,
  );
});

test("atomic session writes retain mode 0600 and leave no temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-capture-"));
  const path = join(directory, "session.private.json");
  try {
    await writePrivateIabSessionAtomic(path, { revision: 1 }, {
      makeId: () => "first",
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { revision: 1 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writePrivateIabSessionAtomic(path, { revision: 2 }, {
      makeId: () => "second",
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { revision: 2 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(() => readFile(`${path}.tmp-${process.pid}-second`), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("private session lock is exclusive, mode 0600, and removed after success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-lock-"));
  const sessionPath = join(directory, "session.private.json");
  const lockPath = `${sessionPath}.lock`;
  try {
    const observed = await withPrivateIabSessionLock(
      sessionPath,
      async lock => {
        assert.equal(lock.lockPath, lockPath);
        assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
        return "locked";
      },
    );
    assert.equal(observed, "locked");
    await assert.rejects(() => stat(lockPath), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("concurrent different-title writers cannot silently overwrite evidence", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-concurrent-"));
  const sessionPath = join(directory, "session.private.json");
  const original = partialSession();
  const readSession = looseSessionReader(corpus);
  try {
    await writePrivateIabSessionAtomic(sessionPath, original);
    const captures = [
      { gameKey: "warioware-usa", marker: 1 },
      { gameKey: "luigis-mansion-usa", marker: 2 },
    ];
    const results = await Promise.allSettled(captures.map(capture =>
      persistBrowserGameCompatibilityIabCapture({
        capture,
        corpus,
        original,
        sessionPath,
      }, { readSession })
    ));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.match(
      results.find(result => result.status === "rejected").reason.message,
      /session changed while the title capture was in progress/,
    );
    const persisted = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.equal(persisted.evidence.captures.length, 1);
    assert.ok(captures.some(
      capture => capture.gameKey === persisted.evidence.captures[0].gameKey,
    ));
    await assert.rejects(() => stat(`${sessionPath}.lock`), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("concurrent canonically identical same-game writers are idempotent", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-idempotent-"));
  const sessionPath = join(directory, "session.private.json");
  const original = partialSession();
  const capture = { gameKey: "rogue-leader-usa", marker: 7 };
  const readSession = looseSessionReader(corpus);
  try {
    await writePrivateIabSessionAtomic(sessionPath, original);
    const results = await Promise.all([
      persistBrowserGameCompatibilityIabCapture({
        capture,
        corpus,
        original,
        sessionPath,
      }, { readSession }),
      persistBrowserGameCompatibilityIabCapture({
        capture: structuredClone(capture),
        corpus,
        original,
        sessionPath,
      }, { readSession }),
    ]);
    assert.deepEqual(results.map(result => result.changed).sort(), [false, true]);
    const persisted = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.deepEqual(persisted.evidence.captures, [capture]);
    await assert.rejects(() => stat(`${sessionPath}.lock`), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("session drift is rejected under lock without replacing current evidence", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-drift-"));
  const sessionPath = join(directory, "session.private.json");
  const original = partialSession();
  const drifted = partialSession([{ gameKey: "warioware-usa", marker: 1 }]);
  try {
    await writePrivateIabSessionAtomic(sessionPath, drifted);
    await assert.rejects(
      () => persistBrowserGameCompatibilityIabCapture({
        capture: { gameKey: "luigis-mansion-usa", marker: 2 },
        corpus,
        original,
        sessionPath,
      }, { readSession: looseSessionReader(corpus) }),
      /session changed while the title capture was in progress/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(sessionPath, "utf8")),
      drifted,
    );
    await assert.rejects(() => stat(`${sessionPath}.lock`), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("an existing stale lock fails closed without being deleted", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-stale-lock-"));
  const sessionPath = join(directory, "session.private.json");
  const lockPath = `${sessionPath}.lock`;
  const original = partialSession();
  try {
    await writePrivateIabSessionAtomic(sessionPath, original);
    await writePrivateIabSessionAtomic(lockPath, { owner: "stale-or-live" });
    await assert.rejects(
      () => persistBrowserGameCompatibilityIabCapture({
        capture: { gameKey: "warioware-usa", marker: 1 },
        corpus,
        original,
        sessionPath,
      }, {
        lockOptions: { lockPollMs: 5, lockTimeoutMs: 15 },
        readSession: looseSessionReader(corpus),
      }),
      /timed out waiting for private session lock/,
    );
    assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(sessionPath, "utf8")), original);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("session lock is removed when reread or atomic write fails", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const directory = await mkdtemp(join(tmpdir(), "lazuli-iab-lock-failure-"));
  const sessionPath = join(directory, "session.private.json");
  const original = partialSession();
  const capture = { gameKey: "warioware-usa", marker: 1 };
  try {
    await writePrivateIabSessionAtomic(sessionPath, original);
    await assert.rejects(
      () => persistBrowserGameCompatibilityIabCapture({
        capture,
        corpus,
        original,
        sessionPath,
      }, {
        readSession: async () => { throw new Error("forced reread failure"); },
      }),
      /forced reread failure/,
    );
    await assert.rejects(() => stat(`${sessionPath}.lock`), /ENOENT/);

    await assert.rejects(
      () => persistBrowserGameCompatibilityIabCapture({
        capture,
        corpus,
        original,
        sessionPath,
      }, {
        readSession: looseSessionReader(corpus),
        writeSession: async () => { throw new Error("forced write failure"); },
      }),
      /forced write failure/,
    );
    await assert.rejects(() => stat(`${sessionPath}.lock`), /ENOENT/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
