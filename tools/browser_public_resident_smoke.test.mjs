// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  PUBLIC_RESIDENT_POLICY,
  compactPublicActiveRelease,
  expectedPublicFrameUrl,
} from "./browser_public_cdp.mjs";
import {
  PUBLIC_RESIDENT_SMOKE_DEFAULT_TIMEOUT_MS,
  PUBLIC_RESIDENT_SMOKE_SCHEMA,
  capturePublicResidentSmoke,
  configuredPublicResidentUrl,
  parsePublicResidentSmokeArguments,
  validatePublicResidentSmokeEvidence,
} from "./browser_public_resident_smoke.mjs";
import { schema4ReleaseFixture } from "./browser_public_release_identity.test_fixture.mjs";

const source = await readFile(new URL("./browser_public_resident_smoke.mjs", import.meta.url), "utf8");

function binding(publicUrl, frameUrl) {
  return {
    frameDocumentTimeOrigin: 2_000,
    frameSource: frameUrl,
    frameUrl,
    topDocumentTimeOrigin: 1_000,
    topUrl: publicUrl,
  };
}

function report(release) {
  return {
    schema: "lazuli-resident-frontend-diagnostics-v1",
    status: "running",
    policy: structuredClone(PUBLIC_RESIDENT_POLICY),
    runtime: structuredClone(release.runtime),
    session: {
      state: "running",
      label: "local: disc.ciso",
      boot: { status: 3, reads: 5 },
      totals: {
        rustSlices: 3,
        hostCallCapBoundaries: 0,
        coldInstallCapBoundaries: 0,
        hostCalls: 2,
        coldInstalls: 1,
        executedCycles: "2000000",
        executedInstructions: "99",
        zeroProgressSlices: 0,
        maximumConsecutiveZeroProgressSlices: 0,
        consecutiveZeroProgressSlices: 0,
        outcomeDetails: { 0: 3 },
      },
      diagnostics: {
        booted: true,
        memoryPages: release.runtime.abi.memoryInitialPages,
        totalBootReads: 5,
        totalDiReads: 6,
        totalRenderCalls: 1,
        totalColdInstalls: 1,
        pendingControllerSample: false,
        totalControllerRetries: 0,
        tableSlots: 65_536,
        machineEvidence: {
          available: true,
          bytes: release.runtime.abi.machineEvidenceBytes,
          encoding: "base64",
          payload: "A".repeat(Math.ceil(release.runtime.abi.machineEvidenceBytes / 3) * 4),
        },
      },
      failure: null,
    },
    renderer: {
      diagnostics: { presentXfbCalls: 1 },
      hasPresentedXfb: true,
      hostDiagnostics: {},
    },
    capabilityBoundary: {
      rawDiscBytesOnly: true,
      opaqueRendererRequestsAndReceipts: true,
      opaqueMachineEvidence: true,
      javascriptDispatchTableSets: 0,
      javascriptGuestMemoryReads: 0,
    },
  };
}

async function evidenceFixture() {
  const manifest = await schema4ReleaseFixture();
  const release = compactPublicActiveRelease(manifest);
  const publicUrl = "https://preview.example/";
  const frameUrl = expectedPublicFrameUrl(publicUrl, release);
  const documentBinding = binding(publicUrl, frameUrl);
  const navigation = {
    top: { frameId: "top", loaderId: "top-loader", url: publicUrl },
    frame: { frameId: "resident", loaderId: "frame-loader", url: frameUrl },
  };
  return {
    manifest,
    value: {
      schema: PUBLIC_RESIDENT_SMOKE_SCHEMA,
      expected: {
        commit: release.commit,
        releaseId: release.releaseId,
      },
      publicUrl,
      discImage: {
        algorithm: "sha256",
        format: "ciso",
        sha256: "9".repeat(64),
      },
      release,
      terminalRelease: structuredClone(release),
      navigation: {
        expectedTopLoaderId: "top-loader",
        expectedFrameUrl: frameUrl,
        before: structuredClone(navigation),
        after: structuredClone(navigation),
      },
      document: {
        ready: structuredClone(documentBinding),
        diagnostics: structuredClone(documentBinding),
        resultMatched: true,
      },
      diagnostics: report(release),
      devtoolsExceptions: [],
    },
  };
}

test("generic resident CLI accepts only exact release, disc, URL, and timing arguments", () => {
  const args = [
    "--disc", "disc.ciso",
    "--url", "https://preview.example/",
    "--expect-commit", "1".repeat(40),
    "--expect-release-id", "2".repeat(64),
    "--endpoint", "http://127.0.0.1:9222/",
    "--output", "evidence.json",
    "--poll-ms", "100",
    "--timeout-ms", "1000",
  ];
  const parsed = parsePublicResidentSmokeArguments(args);
  assert.equal(parsed.disc, resolve("disc.ciso"));
  assert.equal(parsed.output, resolve("evidence.json"));
  assert.equal(parsed.publicUrl, "https://preview.example/");
  assert.equal(parsed.endpoint, "http://127.0.0.1:9222/");
  assert.equal(parsed.pollMs, 100);
  assert.equal(parsed.timeoutMs, 1_000);
  assert.equal(PUBLIC_RESIDENT_SMOKE_DEFAULT_TIMEOUT_MS, 15 * 60 * 1_000);
  assert.equal(configuredPublicResidentUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/");

  for (const extra of ["--game", "--scenario", "--checkpoint", "--expect-title"]) {
    assert.throws(() => parsePublicResidentSmokeArguments([...args, extra, "value"]), /unknown argument/);
  }
  assert.throws(
    () => parsePublicResidentSmokeArguments(args.with(3, "https://preview.example/path")),
    /exact queryless HTTPS origin root/,
  );
  assert.throws(
    () => parsePublicResidentSmokeArguments(args.with(3, "http://preview.example/")),
    /exact queryless HTTPS origin root/,
  );
  assert.throws(
    () => parsePublicResidentSmokeArguments(args.with(9, "https://remote.example/")),
    /exact loopback HTTP origin root/,
  );
});

test("resident evidence authenticates all release hashes and generic milestones", async () => {
  const { value } = await evidenceFixture();
  assert.strictEqual(validatePublicResidentSmokeEvidence(value), value);
  assert.equal(value.release.schema, 4);
  assert.equal(value.release.runtime.abi.machineEvidenceBytes, 816);
  assert.equal(value.discImage.sha256, "9".repeat(64));

  const cases = [
    ["disc hash", changed => { changed.discImage.sha256 = "x".repeat(64); }, /SHA-256 digest/],
    ["terminal release", changed => {
      changed.terminalRelease.runtime.worker.bytes += 1;
    }, /active schema-4 identity changed/],
    ["top loader", changed => {
      changed.navigation.after.top.loaderId = "other";
    }, /pinned navigation loader|document loaders changed/],
    ["frame loader", changed => {
      changed.navigation.after.frame.loaderId = "other";
    }, /document loaders changed/],
    ["document", changed => {
      changed.document.diagnostics.frameDocumentTimeOrigin += 1;
    }, /document identity changed/],
    ["result", changed => { changed.document.resultMatched = false; }, /visible result/],
    ["evidence length", changed => {
      changed.diagnostics.session.diagnostics.machineEvidence.payload = "A".repeat(4);
    }, /length or alphabet changed/],
    ["presentation", changed => {
      changed.diagnostics.renderer.hasPresentedXfb = false;
    }, /no XFB has been presented/],
    ["exception", changed => { changed.devtoolsExceptions.push({ text: "boom" }); }, /no exceptions/],
    ["guest field", changed => { changed.diagnostics.session.diagnostics.pc = 0x8000_0000; }, /keys must be/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => validatePublicResidentSmokeEvidence(changed), pattern, label);
  }
});

test("resident capture pins loaders and release identity before and after the generic milestone", async () => {
  const { manifest, value } = await evidenceFixture();
  const expectedCapture = {
    binding: value.document.ready,
    report: value.diagnostics,
    resultMatched: true,
  };
  const state = {
    binding: value.document.ready,
    dataset: { renderer: "wgpu-webgpu", status: "waiting" },
    discStatus: "open a disc",
    frameHidden: false,
    frameReadyState: "complete",
    hasDiscInput: true,
    hasResult: true,
    result: JSON.stringify({ status: "waiting" }),
    runnerAvailable: true,
    statusHidden: true,
    surface: "release",
    topReadyState: "complete",
  };
  const calls = [];
  const session = {
    exceptions: [{ old: true }],
    async evaluate(expression) {
      calls.push({ expression, method: "evaluate" });
      if (expression.includes("/.gekko/active-release")) {
        return {
          body: JSON.stringify(manifest),
          controlled: true,
          error: null,
          pathname: "/",
          status: 200,
        };
      }
      if (expression.includes("await runner.snapshot()")) return expectedCapture;
      if (expression.includes("assigned public resident disc count")) {
        return {
          activated: true,
          binding: value.document.ready,
          dispatched: true,
          fileCount: 1,
        };
      }
      if (expression.includes("runnerAvailable")) return state;
      assert.fail(`unexpected resident evaluation: ${expression}`);
    },
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Page.navigate") return { loaderId: "top-loader" };
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "top", loaderId: "top-loader", url: value.publicUrl },
            childFrames: [{
              frame: {
                id: "resident",
                loaderId: "frame-loader",
                url: value.navigation.expectedFrameUrl,
              },
            }],
          },
        };
      }
      if (method === "Runtime.evaluate") return { result: { objectId: "disc-input" } };
      return {};
    },
  };
  const options = {
    disc: "/private/tmp/disc.ciso",
    endpoint: "http://127.0.0.1:9222/",
    expectCommit: value.expected.commit,
    expectReleaseId: value.expected.releaseId,
    output: null,
    pollMs: 0,
    publicUrl: value.publicUrl,
    timeoutMs: 1_000,
    url: value.publicUrl,
  };
  const captured = await capturePublicResidentSmoke(session, options, value.discImage);
  assert.deepEqual(captured, value);
  assert.deepEqual(session.exceptions, [], "pre-navigation exceptions were not fenced");
  assert.equal(calls.filter(call => call.method === "Page.getFrameTree").length, 2);
  assert.equal(calls.filter(call => call.method === "DOM.setFileInputFiles").length, 1);
  assert.equal(calls.filter(call => call.method === "Page.navigate").length, 1);
  assert.equal(calls.filter(call => call.method === "Page.bringToFront").length, 1);
});

test("generic resident smoke attaches to CDP without executable, semantic, or readback controls", () => {
  assert.match(source, /new DevToolsSession\(target\.webSocketDebuggerUrl\)/);
  assert.match(source, /DOM\.setFileInputFiles|assignPublicResidentDisc/);
  assert.match(source, /discImage/);
  assert.match(source, /terminalRelease/);
  assert.doesNotMatch(
    source,
    /child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b|lazuliCompatibilityDebug|selectScenario|read_presented_|\.payload\s*(?:\)|,).*Buffer|\batob\b/i,
  );
  assert.doesNotMatch(source, /mario|warioware|monkey ball|checkpoint|program counter|guest memory/i);
});
