// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  attachDiscAfterFreshNavigation,
  resolveDiscPath,
} from "./browser_boot_headless_disc.mjs";
import { observeHeadlessPage } from "./browser_boot_headless_cdp.mjs";

const runnerPath = fileURLToPath(new URL("./browser_boot_headless.mjs", import.meta.url));
const runnerSource = readFileSync(runnerPath, "utf8");

function exactNavigation(state, runUrl, navigationLoaderId, frameLoaderId) {
  return state.url === runUrl && frameLoaderId === navigationLoaderId;
}

function mockSession({
  activation = {
    discStatus: "local: smb.ciso",
    dispatched: true,
    fileCount: 1,
    status: "loading",
  },
  activations = null,
  activationError = null,
  getDocumentErrors = null,
  frameLoaderIds = [],
  inputNodeId = 23,
  inputNodeIds = null,
  rootNodeId = 17,
  rootNodeIds = null,
  querySelectorErrors = null,
  setFileError = null,
  setFileErrors = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params });
      switch (method) {
        case "Page.getFrameTree":
          return {
            frameTree: {
              frame: { loaderId: frameLoaderIds.shift() ?? null },
            },
          };
        case "DOM.enable":
          return {};
        case "DOM.getDocument": {
          const error = getDocumentErrors?.shift() ?? null;
          if (error !== null) throw error;
          return { root: { nodeId: rootNodeIds?.shift() ?? rootNodeId } };
        }
        case "DOM.querySelector": {
          const error = querySelectorErrors?.shift() ?? null;
          if (error !== null) throw error;
          return { nodeId: inputNodeIds?.shift() ?? inputNodeId };
        }
        case "DOM.setFileInputFiles": {
          const error = setFileErrors?.shift() ?? setFileError;
          if (error !== null) throw error;
          return {};
        }
        case "Runtime.evaluate":
          if (activationError !== null) throw activationError;
          return { result: { value: activations?.shift() ?? activation } };
        default:
          throw new Error(`unexpected DevTools method ${method}`);
      }
    },
  };
}

function hooks(states, overrides = {}) {
  return {
    async delay() {},
    isExpectedNavigation: exactNavigation,
    now: () => 0,
    observePage: observeHeadlessPage,
    async pageState() {
      assert.notEqual(states.length, 0, "unexpected page-state poll");
      return states.shift();
    },
    ...overrides,
  };
}

test("disc paths resolve once before Chrome receives them", () => {
  assert.equal(
    resolveDiscPath("games/smb.ciso", "/tmp/lazuli"),
    "/tmp/lazuli/games/smb.ciso",
  );
  assert.equal(
    resolveDiscPath("/var/tmp/warioware.ciso", "/tmp/lazuli"),
    "/var/tmp/warioware.ciso",
  );
  assert.throws(() => resolveDiscPath("", "/tmp/lazuli"), /--disc must name/);
});

test("disc assignment waits for the exact fresh URL and loader", async () => {
  const runUrl = "http://127.0.0.1:8766/?scenario=smb-ready-play&headlessRun=fresh";
  const discPath = "/tmp/lazuli/games/smb.ciso";
  const session = mockSession({
    frameLoaderIds: ["loader-fresh", "loader-stale", "loader-fresh"],
  });
  const state = await attachDiscAfterFreshNavigation(session, {
    deadline: 1,
    discPath,
    navigationLoaderId: "loader-fresh",
    pollMs: 25,
    runUrl,
  }, hooks([
    { readyState: "complete", url: runUrl.replace("fresh", "stale") },
    { readyState: "complete", url: runUrl },
    { readyState: "complete", url: runUrl },
  ]));

  assert.equal(state.url, runUrl);
  assert.deepEqual(
    session.calls.map(call => call.method),
    [
      "Page.getFrameTree",
      "Page.getFrameTree",
      "Page.getFrameTree",
      "DOM.enable",
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.setFileInputFiles",
      "Runtime.evaluate",
    ],
  );
  assert.deepEqual(session.calls[4].params, { depth: 0, pierce: true });
  assert.deepEqual(session.calls[5].params, {
    nodeId: 17,
    selector: "#disc-file",
  });
  assert.deepEqual(session.calls[6].params, {
    files: [discPath],
    nodeId: 23,
  });
  assert.equal(session.calls[7].params.awaitPromise, true);
  assert.equal(session.calls[7].params.returnByValue, true);
  assert.match(session.calls[7].params.expression, /dispatchEvent\(new Event\("change"/);
  assert.equal(
    session.calls.filter(call => call.method === "DOM.setFileInputFiles").length,
    1,
  );
});

test("disc assignment accepts a change event already handled by Chrome", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const session = mockSession({
    activation: {
      discStatus: "local: smb.ciso",
      dispatched: false,
      fileCount: 1,
      status: "loading",
    },
    frameLoaderIds: ["loader-fresh"],
  });
  await assert.doesNotReject(attachDiscAfterFreshNavigation(session, {
    deadline: 1,
    discPath: "/tmp/lazuli/smb.ciso",
    navigationLoaderId: "loader-fresh",
    pollMs: 1,
    runUrl,
  }, hooks([{ readyState: "complete", url: runUrl }])));
});

test("disc assignment reacquires a replaced document after a stale node error", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const discPath = "/tmp/lazuli/smb.ciso";
  const session = mockSession({
    frameLoaderIds: ["loader-fresh", "loader-fresh"],
    inputNodeIds: [23, 29],
    rootNodeIds: [17, 19],
    setFileErrors: [new Error("Could not find node with given id"), null],
  });
  let clock = 0;
  await assert.doesNotReject(attachDiscAfterFreshNavigation(session, {
    deadline: 10,
    discPath,
    navigationLoaderId: "loader-fresh",
    pollMs: 1,
    runUrl,
  }, hooks([
    { readyState: "complete", url: runUrl },
    { readyState: "complete", url: runUrl },
  ], {
    async delay(milliseconds) { clock += milliseconds; },
    now: () => clock,
  })));

  assert.equal(
    session.calls.filter(call => call.method === "Page.getFrameTree").length,
    2,
  );
  assert.deepEqual(
    session.calls
      .filter(call => call.method === "DOM.querySelector")
      .map(call => call.params.nodeId),
    [17, 19],
  );
  assert.deepEqual(
    session.calls
      .filter(call => call.method === "DOM.setFileInputFiles")
      .map(call => call.params.nodeId),
    [23, 29],
  );
});

test("disc assignment retries stale document acquisition from a fresh observation", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const cases = [
    {
      errors: { getDocumentErrors: [new Error("Document was updated"), null] },
      expectedGetDocument: 2,
      expectedQuerySelector: 1,
    },
    {
      errors: {
        querySelectorErrors: [new Error("DOM.querySelector: Could not find node with given id"), null],
      },
      expectedGetDocument: 2,
      expectedQuerySelector: 2,
    },
  ];
  for (const testCase of cases) {
    const session = mockSession({
      frameLoaderIds: ["loader-fresh", "loader-fresh"],
      ...testCase.errors,
    });
    let clock = 0;
    await assert.doesNotReject(attachDiscAfterFreshNavigation(session, {
      deadline: 10,
      discPath: "/tmp/lazuli/smb.ciso",
      navigationLoaderId: "loader-fresh",
      pollMs: 1,
      runUrl,
    }, hooks([
      { readyState: "complete", url: runUrl },
      { readyState: "complete", url: runUrl },
    ], {
      async delay(milliseconds) { clock += milliseconds; },
      now: () => clock,
    })));
    assert.equal(
      session.calls.filter(call => call.method === "Page.getFrameTree").length,
      2,
    );
    assert.equal(
      session.calls.filter(call => call.method === "DOM.getDocument").length,
      testCase.expectedGetDocument,
    );
    assert.equal(
      session.calls.filter(call => call.method === "DOM.querySelector").length,
      testCase.expectedQuerySelector,
    );
    assert.equal(
      session.calls.filter(call => call.method === "DOM.setFileInputFiles").length,
      1,
    );
    assert.equal(
      session.calls.filter(call => call.method === "Runtime.evaluate").length,
      1,
    );
  }
});

test("disc assignment waits for asynchronous production-shell startup", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const session = mockSession({
    activations: [
      {
        discStatus: "ready",
        dispatched: false,
        fileCount: 1,
        status: null,
      },
      {
        discStatus: "local: smb.ciso",
        dispatched: false,
        fileCount: 1,
        status: "running",
      },
    ],
    frameLoaderIds: ["loader-fresh"],
  });
  let clock = 0;
  await assert.doesNotReject(attachDiscAfterFreshNavigation(session, {
    deadline: 10,
    discPath: "/tmp/lazuli/smb.ciso",
    navigationLoaderId: "loader-fresh",
    pollMs: 1,
    runUrl,
  }, hooks([{ readyState: "complete", url: runUrl }], {
    async delay(milliseconds) { clock += milliseconds; },
    now: () => clock,
  })));
  assert.equal(
    session.calls.filter(call => call.method === "Runtime.evaluate").length,
    2,
  );
});

test("disc assignment fails when the selected file never starts the page", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const session = mockSession({
    activation: {
      discStatus: "open a disc",
      dispatched: true,
      fileCount: 1,
      status: "waiting",
    },
    frameLoaderIds: ["loader-fresh"],
  });
  let clock = 0;
  await assert.rejects(
    attachDiscAfterFreshNavigation(session, {
      deadline: 1,
      discPath: "/tmp/lazuli/smb.ciso",
      navigationLoaderId: "loader-fresh",
      pollMs: 1,
      runUrl,
    }, hooks([{ readyState: "complete", url: runUrl }], {
      async delay(milliseconds) { clock += milliseconds; },
      now: () => clock,
    })),
    /assigned --disc did not start the fresh document/,
  );
});

test("disc assignment never replays an ambiguous activation error", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const session = mockSession({
    activationError: new Error("Could not find node with given id"),
    frameLoaderIds: ["loader-fresh", "loader-fresh"],
  });
  await assert.rejects(
    attachDiscAfterFreshNavigation(session, {
      deadline: 1,
      discPath: "/tmp/lazuli/smb.ciso",
      navigationLoaderId: "loader-fresh",
      pollMs: 1,
      runUrl,
    }, hooks([{ readyState: "complete", url: runUrl }])),
    /could not activate --disc .*Could not find node with given id/,
  );
  assert.equal(
    session.calls.filter(call => call.method === "DOM.setFileInputFiles").length,
    1,
  );
  assert.equal(
    session.calls.filter(call => call.method === "Runtime.evaluate").length,
    1,
  );
  assert.equal(
    session.calls.filter(call => call.method === "Page.getFrameTree").length,
    1,
  );
});

test("disc assignment reports an unconfirmed fresh navigation", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const session = mockSession({ frameLoaderIds: ["loader-old", "loader-old"] });
  let clock = 0;
  await assert.rejects(
    attachDiscAfterFreshNavigation(session, {
      deadline: 2,
      discPath: "/tmp/lazuli/game.ciso",
      navigationLoaderId: "loader-fresh",
      pollMs: 1,
      runUrl,
    }, hooks([
      { readyState: "complete", url: runUrl },
      { readyState: "complete", url: runUrl },
    ], {
      async delay(milliseconds) { clock += milliseconds; },
      now: () => clock,
    })),
    /fresh navigation was not confirmed.*expectedLoaderId.*loader-fresh/,
  );
  assert.equal(
    session.calls.some(call => call.method.startsWith("DOM.")),
    false,
  );
});

test("disc assignment reports a missing file input without assigning", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const session = mockSession({
    frameLoaderIds: ["loader-fresh"],
    inputNodeId: 0,
  });
  await assert.rejects(
    attachDiscAfterFreshNavigation(session, {
      deadline: 1,
      discPath: "/tmp/lazuli/game.ciso",
      navigationLoaderId: "loader-fresh",
      pollMs: 1,
      runUrl,
    }, hooks([{ readyState: "complete", url: runUrl }])),
    /fresh document .* does not contain #disc-file/,
  );
  assert.equal(
    session.calls.some(call => call.method === "DOM.setFileInputFiles"),
    false,
  );
});

test("disc assignment preserves a clear DevTools file error", async () => {
  const runUrl = "http://127.0.0.1:8766/?headlessRun=fresh";
  const session = mockSession({
    frameLoaderIds: ["loader-fresh"],
    setFileError: new Error("Chrome refused the file"),
  });
  await assert.rejects(
    attachDiscAfterFreshNavigation(session, {
      deadline: 1,
      discPath: "/tmp/lazuli/game.ciso",
      navigationLoaderId: "loader-fresh",
      pollMs: 1,
      runUrl,
    }, hooks([{ readyState: "interactive", url: runUrl }])),
    /could not assign --disc \/tmp\/lazuli\/game\.ciso to #disc-file: Chrome refused the file/,
  );
  assert.equal(
    session.calls.filter(call => call.method === "Page.getFrameTree").length,
    1,
  );
});

test("the headless runner wires --disc before its report wait and rejects reuse", () => {
  assert.match(runnerSource, /case "--disc":/);
  assert.match(runnerSource, /options\.disc = resolveDiscPath\(options\.disc\)/);
  assert.match(
    runnerSource,
    /await attachDiscAfterFreshNavigation\([\s\S]*?\n    let state = null;\n    while \(Date\.now\(\) < deadline\)/,
  );

  const result = spawnSync(process.execPath, [
    runnerPath,
    "--reuse",
    "--extend-cycles",
    "1",
    "--disc",
    "game.ciso",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--disc cannot be combined with --reuse/);
});
