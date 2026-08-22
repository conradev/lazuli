// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
} from "./resident_machine_fidelity_lock.mjs";
import {
  PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA,
  canonicalCaptureJson,
  closeDedicatedCaptureTarget,
  createDedicatedCaptureTarget,
  formatProductionFidelityCaptureFailure,
  navigationPublicationDue,
  orderCaptureInputs,
  parseCaptureArguments,
  preparePrivateCaptureDirectory,
  productionFidelityRunFragment,
  runDedicatedPageCapture,
  runGameCaptureLifecycle,
  runWithPreservedCleanup,
  selectRetainedPreWitnessMachineEvidence,
  selectCreatedCaptureTarget,
  sustainedWindowReached,
  validateCaptureUrl,
  validateCaptureJournal,
  validateLoopbackCdpEndpoint,
  validateNavigationFrame,
  writePrivateLeafAtomic,
} from "./resident_machine_production_fidelity_capture.mjs";
import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";
import {
  productionFidelityNavigationPolicy,
} from "./resident_machine_fidelity_navigation.mjs";

function sevenCorpus() {
  return {
    games: Array.from({ length: 7 }, (_value, index) => ({
      key: `game-${index + 1}`,
      priority: index + 1,
      disc: { identifier: `GAME0${index + 1}`, revision: 0 },
    })),
  };
}

function keyedLocks(corpus) {
  return new Map([...corpus.games].reverse().map(game => [game.key, {
    bytes: Buffer.from(`lock-${game.key}`),
    path: `/input/${game.key}.json`,
    lock: {
      run: { gameKey: game.key, runId: "10000000-0000-4000-8000-000000000001" },
      selectedGame: { key: game.key, priority: game.priority },
    },
  }]));
}

function keyedJournals(corpus) {
  return new Map([...corpus.games].reverse().map(game => [
    game.key,
    `/input/${game.key}.jsonl`,
  ]));
}

function keyedCaptureUrls(corpus) {
  return new Map([...corpus.games].reverse().map(game => [
    game.key,
    `http://127.0.0.1:${8100 + game.priority}/tools/resident_machine_first_frame.html?capture=fidelity&game=${game.key}`,
  ]));
}

function reference(name) {
  return { path: `games/01-game-1/${name}`, bytes: 1, sha256: "a".repeat(64) };
}

test("controller orders the exact seven inputs by corpus priority, never caller order", () => {
  const corpus = sevenCorpus();
  const ordered = orderCaptureInputs(
    corpus,
    keyedLocks(corpus),
    keyedJournals(corpus),
    keyedCaptureUrls(corpus),
  );
  assert.deepEqual(ordered.map(input => input.game.key), corpus.games.map(game => game.key));
  assert.deepEqual(ordered.map(input => input.game.priority), [1, 2, 3, 4, 5, 6, 7]);

  const missing = keyedLocks(corpus);
  missing.delete("game-4");
  assert.throws(
    () => orderCaptureInputs(corpus, missing, keyedJournals(corpus), keyedCaptureUrls(corpus)),
    /exact seven-game corpus/,
  );
});

test("CDP attachment creates one dedicated target and accepts only exact loopback capture URLs", () => {
  assert.equal(validateLoopbackCdpEndpoint("http://127.0.0.1:9222").href, "http://127.0.0.1:9222/");
  assert.equal(validateLoopbackCdpEndpoint("http://[::1]:9222/").hostname, "[::1]");
  assert.throws(() => validateLoopbackCdpEndpoint("https://127.0.0.1:9222"), /loopback HTTP/);
  assert.throws(() => validateLoopbackCdpEndpoint("http://192.0.2.10:9222"), /loopback HTTP/);

  const url = "http://127.0.0.1:8001/tools/resident_machine_first_frame.html?capture=fidelity&game=game-1";
  assert.equal(validateCaptureUrl(url, "game-1"), url);
  assert.throws(
    () => validateCaptureUrl(`${url}&extra=1`, "game-1"),
    /only capture=fidelity/,
  );
  assert.throws(
    () => validateCaptureUrl(
      "http://127.0.0.1:8001/tools/resident_machine_first_frame.html?game=game-1&capture=fidelity",
      "game-1",
    ),
    /only capture=fidelity/,
  );
  assert.throws(
    () => validateCaptureUrl(url, "game-2"),
    /only capture=fidelity/,
  );
  assert.throws(
    () => validateCaptureUrl(
      "http://192.0.2.1/tools/resident_machine_first_frame.html?capture=fidelity&game=game-1",
      "game-1",
    ),
    /loopback HTTP/,
  );

  const target = selectCreatedCaptureTarget([
    {
      id: "arbitrary-existing-tab",
      type: "page",
      url,
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/arbitrary",
    },
    {
      id: "created-target",
      type: "page",
      url: "about:blank",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/created",
    },
  ], "created-target");
  assert.equal(target.id, "created-target");
  assert.match(target.webSocketDebuggerUrl, /\/created$/);
  assert.throws(
    () => selectCreatedCaptureTarget([{
      id: "created-target",
      type: "page",
      webSocketDebuggerUrl: "ws://example.test/devtools/page/one",
    }], "created-target"),
    /not loopback/,
  );
});

test("dedicated page capture preserves capture failure before unload failure", async () => {
  const session = Object.freeze({});
  const input = Object.freeze({
    game: Object.freeze({ key: "game-1" }),
    captureUrl:
      "http://127.0.0.1:8101/tools/resident_machine_first_frame.html?capture=fidelity&game=game-1",
  });
  const options = Object.freeze({ requestTimeoutMs: 123 });
  const unloadFailure = new Error("page unload failed");

  const primaryFailure = new Error("capture failed");
  await assert.rejects(
    runDedicatedPageCapture(session, input, options, {
      navigate: async () => Object.freeze({ frameId: "frame", loaderId: "loader" }),
      capture: async () => { throw primaryFailure; },
      unload: async (actualSession, timeout) => {
        assert.strictEqual(actualSession, session);
        assert.equal(timeout, 123);
        throw unloadFailure;
      },
    }),
    error => error instanceof AggregateError
      && error.errors[0] === primaryFailure
      && error.errors[1] === unloadFailure,
  );
});

test("capture CLI failure formatting recursively preserves order, causes, and identity", () => {
  const primaryFailure = new Error("capture Runtime.evaluate connection closed");
  primaryFailure.stack = "PRIMARY_CAPTURE_FAILURE";
  const pageCleanupFailure = new Error("page unload connection closed");
  pageCleanupFailure.stack = "PAGE_CLEANUP_FAILURE";
  const targetCleanupFailure = new Error("Target.closeTarget connection closed");
  targetCleanupFailure.stack = "TARGET_CLEANUP_FAILURE";
  const rootCause = new Error("browser transport disconnected");
  rootCause.stack = "ROOT_CAUSE";
  const nested = new AggregateError(
    [primaryFailure, pageCleanupFailure],
    "capture and page cleanup failed",
    { cause: primaryFailure },
  );
  nested.stack = "NESTED_CAPTURE_AND_PAGE_CLEANUP";
  const outer = new AggregateError(
    [nested, targetCleanupFailure, pageCleanupFailure],
    "capture and target cleanup failed",
    { cause: rootCause },
  );
  outer.stack = "OUTER_CAPTURE_AND_TARGET_CLEANUP";

  assert.equal(formatProductionFidelityCaptureFailure(outer), [
    "failure:",
    "OUTER_CAPTURE_AND_TARGET_CLEANUP",
    "failure.errors[0]:",
    "NESTED_CAPTURE_AND_PAGE_CLEANUP",
    "failure.errors[0].errors[0]:",
    "PRIMARY_CAPTURE_FAILURE",
    "failure.errors[0].errors[1]:",
    "PAGE_CLEANUP_FAILURE",
    "failure.errors[0].cause: [same failure object as failure.errors[0].errors[0]]",
    "failure.errors[1]:",
    "TARGET_CLEANUP_FAILURE",
    "failure.errors[2]: [same failure object as failure.errors[0].errors[1]]",
    "failure.cause:",
    "ROOT_CAUSE",
  ].join("\n"));
});

test("capture CLI formatting exposes nested operation and cleanup failures", async () => {
  const primaryFailure = new Error("capture failed");
  primaryFailure.stack = "CAPTURE_FAILURE";
  const pageCleanupFailure = new Error("page unload failed");
  pageCleanupFailure.stack = "PAGE_UNLOAD_FAILURE";
  const targetCleanupFailure = new Error("target close failed");
  targetCleanupFailure.stack = "TARGET_CLOSE_FAILURE";

  let pageFailure;
  try {
    await runWithPreservedCleanup(
      async () => { throw primaryFailure; },
      async () => { throw pageCleanupFailure; },
      "capture and page unload failed",
    );
    assert.fail("capture and page cleanup must fail");
  } catch (error) {
    pageFailure = error;
  }
  pageFailure.stack = "CAPTURE_AND_PAGE_CLEANUP";

  let terminalFailure;
  try {
    await runWithPreservedCleanup(
      async () => { throw pageFailure; },
      async () => { throw targetCleanupFailure; },
      "capture and target cleanup failed",
    );
    assert.fail("capture and target cleanup must fail");
  } catch (error) {
    terminalFailure = error;
  }
  terminalFailure.stack = "CAPTURE_AND_TARGET_CLEANUP";

  assert.equal(formatProductionFidelityCaptureFailure(terminalFailure), [
    "failure:",
    "CAPTURE_AND_TARGET_CLEANUP",
    "failure.errors[0]:",
    "CAPTURE_AND_PAGE_CLEANUP",
    "failure.errors[0].errors[0]:",
    "CAPTURE_FAILURE",
    "failure.errors[0].errors[1]:",
    "PAGE_UNLOAD_FAILURE",
    "failure.errors[1]:",
    "TARGET_CLOSE_FAILURE",
  ].join("\n"));
});

test("dedicated page capture does not unload a navigation that never bound", async () => {
  const primaryFailure = new Error("navigate failed");
  let unloadCalls = 0;
  await assert.rejects(
    runDedicatedPageCapture(
      Object.freeze({}),
      Object.freeze({ game: Object.freeze({ key: "game-1" }), captureUrl: "capture" }),
      Object.freeze({ requestTimeoutMs: 123 }),
      {
        navigate: async () => { throw primaryFailure; },
        capture: async () => assert.fail("capture must not run after navigation failure"),
        unload: async () => { unloadCalls += 1; },
      },
    ),
    error => error === primaryFailure,
  );
  assert.equal(unloadCalls, 0);
});

test("dedicated page cleanup-only failure remains fatal", async () => {
  const unloadFailure = new Error("page unload failed");
  const result = Object.freeze({ captured: true });
  await assert.rejects(
    runDedicatedPageCapture(
      Object.freeze({}),
      Object.freeze({ game: Object.freeze({ key: "game-1" }), captureUrl: "capture" }),
      Object.freeze({ requestTimeoutMs: 123 }),
      {
        navigate: async () => Object.freeze({ frameId: "frame", loaderId: "loader" }),
        capture: async () => result,
        unload: async () => { throw unloadFailure; },
      },
    ),
    error => error === unloadFailure,
  );
});

test("primary page setup failure precedes target close failure and all sessions close", async () => {
  const primaryFailure = new Error("page setup failed");
  const closeFailure = new Error("CDP connection closed");
  const events = [];
  const pageSession = {
    close() {
      events.push("page-session-close");
    },
  };
  const dedicated = {
    target: { id: "dedicated-target" },
    browserSession: {
      async send(method, parameters, timeout) {
        events.push(`${method}:${parameters.targetId}:${timeout}`);
        throw closeFailure;
      },
      close() {
        events.push("browser-session-close");
      },
    },
  };
  await assert.rejects(
    runWithPreservedCleanup(
      async () => { throw primaryFailure; },
      () => closeDedicatedCaptureTarget(dedicated, pageSession, 456),
      "capture and cleanup failed",
    ),
    error => error instanceof AggregateError
      && error.errors[0] === primaryFailure
      && error.errors[1] === closeFailure,
  );
  assert.deepEqual(events, [
    "page-session-close",
    "Target.closeTarget:dedicated-target:456",
    "browser-session-close",
  ]);
});

test("dedicated target cleanup requires exact success true and always closes sessions", async () => {
  for (const response of [{ success: false }, { success: "true" }, {}, undefined]) {
    const events = [];
    const dedicated = {
      target: { id: "dedicated-target" },
      browserSession: {
        async send() {
          events.push("target-close");
          return response;
        },
        close() {
          events.push("browser-session-close");
        },
      },
    };
    await assert.rejects(
      closeDedicatedCaptureTarget(dedicated, {
        close() {
          events.push("page-session-close");
        },
      }, 456),
      /dedicated CDP target did not close/,
    );
    assert.deepEqual(events, [
      "page-session-close",
      "target-close",
      "browser-session-close",
    ]);
  }

  const successEvents = [];
  await closeDedicatedCaptureTarget({
    target: { id: "dedicated-target" },
    browserSession: {
      async send() {
        successEvents.push("target-close");
        return { success: true };
      },
      close() {
        successEvents.push("browser-session-close");
      },
    },
  }, {
    close() {
      successEvents.push("page-session-close");
    },
  }, 456);
  assert.deepEqual(successEvents, [
    "page-session-close",
    "target-close",
    "browser-session-close",
  ]);

  const pageCloseFailure = new Error("page session close failed");
  const targetCloseFailure = new Error("target close failed");
  const browserCloseFailure = new Error("browser session close failed");
  const failureEvents = [];
  await assert.rejects(
    closeDedicatedCaptureTarget({
      target: { id: "dedicated-target" },
      browserSession: {
        async send() {
          failureEvents.push("target-close");
          throw targetCloseFailure;
        },
        close() {
          failureEvents.push("browser-session-close");
          throw browserCloseFailure;
        },
      },
    }, {
      close() {
        failureEvents.push("page-session-close");
        throw pageCloseFailure;
      },
    }, 456),
    error => error instanceof AggregateError
      && error.errors[0] === pageCloseFailure
      && error.errors[1] === targetCloseFailure
      && error.errors[2] === browserCloseFailure,
  );
  assert.deepEqual(failureEvents, [
    "page-session-close",
    "target-close",
    "browser-session-close",
  ]);
});

test("target creation failure preserves close failure and closes the browser session", async () => {
  const setupFailure = new Error("target listing failed");
  const closeFailure = new Error("target close failed");
  const events = [];
  let fetchCount = 0;
  const browserSession = {
    async connect() {
      events.push("browser-session-connect");
    },
    async send(method) {
      events.push(method);
      if (method === "Target.createTarget") return { targetId: "dedicated-target" };
      throw closeFailure;
    },
    close() {
      events.push("browser-session-close");
    },
  };
  const fetchImpl = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return {
        ok: true,
        async json() {
          return { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/one" };
        },
      };
    }
    throw setupFailure;
  };
  await assert.rejects(
    createDedicatedCaptureTarget(
      new URL("http://127.0.0.1:9222/"),
      () => browserSession,
      fetchImpl,
      456,
    ),
    error => error instanceof AggregateError
      && error.errors[0] === setupFailure
      && error.errors[1] === closeFailure,
  );
  assert.deepEqual(events, [
    "browser-session-connect",
    "Target.createTarget",
    "Target.closeTarget",
    "browser-session-close",
  ]);
});

test("locked navigation publishes only after its canonical target and durable receipt", () => {
  const policy = productionFidelityNavigationPolicy("warioware-usa");
  assert.equal(policy.maximumPublications, PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP);
  const navigation = {
    scriptSha256: policy.scriptSha256,
    stepCount: policy.steps.length,
    durableSteps: 0,
    pendingPublication: null,
    nextTargetCanonicalCycle: "100",
  };
  assert.equal(navigationPublicationDue(policy, navigation, {
    operatorPublications: 0,
    canonicalCycle: "99",
  }), false);
  assert.equal(navigationPublicationDue(policy, navigation, {
    operatorPublications: 0,
    canonicalCycle: "100",
  }), true);
  assert.equal(navigationPublicationDue(policy, {
    ...navigation,
    pendingPublication: { stepIndex: 0 },
  }, {
    operatorPublications: 0,
    canonicalCycle: "100",
  }), false);
  assert.equal(navigationPublicationDue(policy, {
    ...navigation,
    durableSteps: policy.steps.length,
    nextTargetCanonicalCycle: null,
  }, {
    operatorPublications: policy.steps.length,
    canonicalCycle: "999",
  }), false);
  assert.throws(
    () => navigationPublicationDue({ ...policy, maximumPublications: 64 }, navigation, {
      operatorPublications: 0,
      canonicalCycle: "100",
    }),
    /policy authority changed/,
  );
  assert.throws(
    () => navigationPublicationDue(policy, navigation, {
      operatorPublications: 1,
      canonicalCycle: "100",
    }),
    /publication accounting changed/,
  );
  const spelling = canonicalCaptureJson(policy);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(canonicalCaptureJson(policy), spelling);
  }
});

test("witness authority selects the durable retained pre-publication ME, not fresh common state", () => {
  const fresh = Object.freeze({ payload: "fresh-post-publication" });
  const retained = Object.freeze({ payload: "durable-pre-publication" });
  assert.strictEqual(selectRetainedPreWitnessMachineEvidence({
    machineEvidence: fresh,
    artifacts: { preWitnessMachineEvidence: retained },
  }), retained);
  assert.notStrictEqual(
    selectRetainedPreWitnessMachineEvidence({
      machineEvidence: fresh,
      artifacts: { preWitnessMachineEvidence: retained },
    }),
    fresh,
  );
});

test("loader binding rejects URL, frame, and loader drift", () => {
  const binding = { frameId: "frame", loaderId: "loader", url: "http://127.0.0.1/capture" };
  assert.deepEqual(validateNavigationFrame(binding, {
    id: "frame", loaderId: "loader", url: binding.url,
  }), { id: "frame", loaderId: "loader", url: binding.url });
  for (const changed of [
    { id: "other", loaderId: "loader", url: binding.url },
    { id: "frame", loaderId: "other", url: binding.url },
    { id: "frame", loaderId: "loader", url: "about:blank" },
  ]) assert.throws(() => validateNavigationFrame(binding, changed), /drifted/);
});

test("per-game lifecycle arms before capture and disarms only after terminal work", async () => {
  const events = [];
  const context = Object.freeze({
    gameKey: "game-1",
    priority: 1,
    runId: "10000000-0000-4000-8000-000000000001",
    captureUrl:
      "http://127.0.0.1:8101/tools/resident_machine_first_frame.html?capture=fidelity&game=game-1",
  });
  const result = await runGameCaptureLifecycle(context, async () => {
    events.push("capture-terminal-validated");
    return "fragment";
  }, {
    beforeGameNavigation: async value => {
      events.push(`armed:${value.gameKey}`);
      return Object.freeze({ watchdog: "one" });
    },
    afterGameCapture: async value => {
      events.push(`disarmed:${value.outcome}:${value.lifecycleToken.watchdog}`);
      assert.equal(value.error, null);
    },
  });
  assert.equal(result, "fragment");
  assert.deepEqual(events, [
    "armed:game-1",
    "capture-terminal-validated",
    "disarmed:complete:one",
  ]);
});

test("per-game lifecycle reports capture failure and preserves cleanup failure", async () => {
  const captureFailure = new Error("capture failed");
  const cleanupFailure = new Error("watchdog failed");
  await assert.rejects(
    runGameCaptureLifecycle({ gameKey: "game-1" }, async () => {
      throw captureFailure;
    }, {
      afterGameCapture: async value => {
        assert.equal(value.outcome, "failed");
        assert.match(value.error, /capture failed/);
        throw cleanupFailure;
      },
    }),
    error => error instanceof AggregateError
      && error.errors[0] === captureFailure
      && error.errors[1] === cleanupFailure,
  );
});

test("offline sustained-window decision requires both +120 VI fields and +64 presentations", () => {
  const first = { vi: { viFields: "1000" }, gx: { presentedFrames: "400" } };
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "1120" }, gx: { presentedFrames: "464" },
  }), true);
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "1119" }, gx: { presentedFrames: "464" },
  }), false);
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "1120" }, gx: { presentedFrames: "463" },
  }), false);
  assert.equal(sustainedWindowReached(first, {
    vi: { viFields: "999" }, gx: { presentedFrames: "999" },
  }), false);
});

test("run fragment has only the agreed direct evidence refs and metadata frames", () => {
  const run = {
    key: "game-1",
    runId: "10000000-0000-4000-8000-000000000001",
    capturedAt: "2026-08-18T00:00:00.000Z",
    releaseId: "b".repeat(64),
    executionAssetsSha256: "c".repeat(64),
    evidenceLock: reference("evidence-lock.json"),
    checkpointJournal: reference("checkpoint-journal.jsonl"),
    firstFrameReport: reference("first-frame-report.json"),
    readyMachineEvidence: reference("ready-machine-evidence.json"),
    baselineGameFidelityRecord: reference("baseline-game-fidelity.json"),
    baselineMachineEvidence: reference("baseline-machine-evidence.json"),
    preWitnessMachineEvidence: reference("pre-witness-machine-evidence.json"),
    terminalMachineEvidence: reference("terminal-machine-evidence.json"),
    gameFidelityRecord: reference("terminal-game-fidelity.json"),
    navigationTranscript: reference("navigation-transcript.json"),
    operatorPublications: {
      algorithm: "locked-si-observed-not-before-publication-v1",
      scriptSha256: "d".repeat(64),
      count: 12,
    },
    frames: {
      firstVisible: reference("first-visible.rgba"),
      baseline: {
        metadata: reference("baseline-readback-metadata.json"),
        rgba: reference("baseline.rgba"),
      },
      later: {
        metadata: reference("accepted-readback-metadata.json"),
        rgba: reference("accepted.rgba"),
      },
    },
  };
  const fragment = productionFidelityRunFragment(run);
  assert.equal(fragment.schema, PRODUCTION_FIDELITY_RUN_FRAGMENT_SCHEMA);
  assert.strictEqual(fragment.run, run);
  assert.deepEqual(Object.keys(fragment), ["schema", "run"]);
  assert.deepEqual(Object.keys(fragment.run.frames.baseline).sort(), ["metadata", "rgba"]);
  assert.equal("presentation" in fragment.run.frames.baseline, false);
  assert.equal("captureLeaves" in fragment, false);
});

test("private atomic leaves are contained, exact, and mode 0600", async () => {
  const root = path.join(tmpdir(), `lazuli-production-capture-${process.pid}-${Date.now()}`);
  await mkdirForTest(root);
  try {
    const bytes = Buffer.from("owned evidence bytes");
    const ref = await writePrivateLeafAtomic(root, "games/01-game-1/leaf.bin", bytes);
    assert.deepEqual(ref, {
      path: "games/01-game-1/leaf.bin",
      bytes: bytes.byteLength,
      sha256: "108ffc7cace43edb617236c93748ef0e4e17d4022330af45a4e04cfa3297ea73",
    });
    assert.deepEqual(await readFile(path.join(root, ref.path)), bytes);
    assert.equal((await stat(path.join(root, ref.path))).mode & 0o777, 0o600);
    await assert.rejects(
      writePrivateLeafAtomic(root, "games/01-game-1/leaf.bin", Buffer.from("replacement")),
      /EEXIST/,
    );
    assert.deepEqual(await readFile(path.join(root, ref.path)), bytes);
    await assert.rejects(
      writePrivateLeafAtomic(root, "../escape.bin", bytes),
      /escaped the output directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle-owned empty capture directory needs explicit lifecycle authority", async () => {
  const root = path.join(
    await realpath(tmpdir()),
    `lazuli-capture-directory-${process.pid}-${Date.now()}`,
  );
  await mkdirForTest(root);
  try {
    const output = path.join(root, "capture");
    await mkdir(output, { mode: 0o700 });
    await assert.rejects(preparePrivateCaptureDirectory(output), /EEXIST/);
    assert.equal(
      await preparePrivateCaptureDirectory(output, { allowExistingEmpty: true }),
      output,
    );
    await writePrivateLeafAtomic(output, "substituted", Buffer.from("not empty"));
    await assert.rejects(
      preparePrivateCaptureDirectory(output, { allowExistingEmpty: true }),
      /must be empty/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller authenticates nested durable checkpoint payloads, never flat wrappers", () => {
  const flat = Buffer.from(`${JSON.stringify({
    runId: "10000000-0000-4000-8000-000000000001",
    gameKey: "game-1",
    kind: "fidelity-terminal",
  })}\n`);
  assert.throws(() => validateCaptureJournal(flat, {
    game: { key: "game-1" },
    lockBytes: Buffer.from("{}"),
    lock: {
      run: {
        runId: "10000000-0000-4000-8000-000000000001",
        gameKey: "game-1",
      },
    },
  }), /journal identity changed/);
});

async function mkdirForTest(directory) {
  await mkdir(directory, { mode: 0o700 });
}

test("CLI requires keyed lock and journal inputs and retains exact key association", () => {
  const corpus = sevenCorpus();
  const argv = [
    "--cdp-endpoint", "http://127.0.0.1:9222",
    "--release", "release.json",
    "--output-directory", "capture-output",
  ];
  for (const game of corpus.games) {
    argv.push("--evidence-lock", `${game.key}=locks/${game.key}.json`);
    argv.push("--checkpoint-journal", `${game.key}=journals/${game.key}.jsonl`);
    argv.push(
      "--capture-url",
      `${game.key}=http://127.0.0.1:${8100 + game.priority}/tools/resident_machine_first_frame.html?capture=fidelity&game=${game.key}`,
    );
  }
  const options = parseCaptureArguments(argv);
  assert.equal(options.evidenceLocks.size, 7);
  assert.equal(options.checkpointJournals.size, 7);
  assert.equal(options.captureUrls.size, 7);
  assert.match(options.evidenceLocks.get("game-7"), /locks\/game-7\.json$/);
  assert.throws(
    () => parseCaptureArguments([...argv, "--operator-sequence", "unbound.json"]),
    /unknown option/,
  );
});

test("controller source is title-blind, attaches only, and decodes machine evidence offline", async () => {
  const sourcePath = fileURLToPath(new URL(
    "./resident_machine_production_fidelity_capture.mjs",
    import.meta.url,
  ));
  const source = await readFile(sourcePath, "utf8");
  const corpus = await readGameCompatibilityCorpus();
  for (const game of corpus.games) assert.doesNotMatch(source, new RegExp(game.key, "g"));
  assert.doesNotMatch(source, /node:child_process|\bexecFile\b|\bspawn\s*\(/);
  assert.doesNotMatch(source, /document\.title|milestone\.id|selectedGame\.key\s*===/);
  assert.doesNotMatch(source, new RegExp(["attes", "tation"].join(""), "i"));
  assert.match(source, /new DevToolsSession\(url, sessionOptions\)/);
  assert.match(source, /Target\.createTarget/);
  assert.match(source, /Target\.closeTarget/);
  assert.match(source, /Page\.navigate/);
  assert.match(source, /validateMachineEvidenceV1Envelope/);
  assert.match(source, /lazuliProductionFidelityCapture/);
  assert.match(source, /lost Rust Baseline before witness publication/);
  assert.match(source, /"navigation",\s+undefined,/);
  assert.doesNotMatch(source, /"navigation",\s+controller,/);
  for (const method of ["snapshot", "step", "navigation", "publishWitness", "finish", "abort"]) {
    assert.match(source, new RegExp(`\\"${method}\\"`));
  }
});
