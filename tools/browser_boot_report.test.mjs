#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

test("browser reports expose the CPU-state signature", () => {
  const cpuStateStart = source.indexOf("cpuState: {");
  const cpuStateEnd = source.indexOf("mmioState: {", cpuStateStart);

  assert.notEqual(cpuStateStart, -1, "missing cpuState report");
  assert.notEqual(cpuStateEnd, -1, "missing cpuState report boundary");
  assert.match(
    source.slice(cpuStateStart, cpuStateEnd),
    /signature: hex32\(cpuSignature\(\)\),/,
  );
});

test("snapshot console reports retain only a compact scalar summary", () => {
  const calls = [];
  const context = {
    console: {
      log(...args) { calls.push(args); },
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction("logBrowserBootReport"), context, {
    filename: "browser_boot.report-log.js",
  });
  const details = {
    stage: "snapshot",
    pc: "0x80001234",
    instructions: 123,
    cycles: 456,
    dispatches: 78,
    compiledBlocks: 9,
  };
  const report = { sentinel: { retained: true } };

  for (let index = 0; index < 128; index += 1) {
    context.logBrowserBootReport("progress", details, report);
  }

  assert.equal(calls.length, 128);
  for (const args of calls) {
    assert.deepEqual(args, [
      "BROWSER_BOOT_PROGRESS",
      "snapshot pc=0x80001234 instructions=123 cycles=456 dispatches=78 compiledBlocks=9",
    ]);
    assert.ok(args.every(value => typeof value === "string"));
    assert.ok(!args.includes(report));
  }

  context.logBrowserBootReport("progress", { stage: "operator-stop" }, report);
  assert.equal(calls.at(-1)[0], "BROWSER_BOOT_PROGRESS");
  assert.equal(calls.at(-1)[1], report);
});

test("finish keeps full report serialization but delegates console publication", () => {
  const finish = extractFunction("finish");
  assert.match(finish, /output\.textContent = JSON\.stringify\(report, null, 2\);/);
  assert.match(finish, /logBrowserBootReport\(status, details, report\);/);
  assert.doesNotMatch(finish, /console\.log/);
});

test("the optional public diagnostics control captures into the hidden report sink", () => {
  const snapshots = [];
  const button = {
    dataset: { captureState: "unavailable" },
    disabled: true,
    textContent: "Capture diagnostics",
  };
  const context = {
    captureDiagnosticsButton: button,
    captureDiagnosticsPendingRequestId: null,
    captureDiagnosticsRequestSequence: 0,
    globalThis: null,
    output: { textContent: "stale report" },
    worker: null,
  };
  context.globalThis = context;
  context.lazuliCycleRunner = {
    snapshot(requestId) { snapshots.push(requestId); },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction("resetCaptureDiagnosticsControl"),
      extractFunction("requestCaptureDiagnostics"),
      extractFunction("completeCaptureDiagnostics"),
      extractFunction("failCaptureDiagnostics"),
    ].join("\n"),
    context,
    { filename: "browser_boot.capture-diagnostics.js" },
  );

  context.resetCaptureDiagnosticsControl();
  assert.equal(button.disabled, true, "a button without a disc worker stays disabled");
  assert.equal(button.dataset.captureState, "unavailable");

  context.worker = {};
  context.resetCaptureDiagnosticsControl();
  assert.equal(button.disabled, false, "the worker-owned disc enables capture");
  assert.equal(button.dataset.captureState, "ready");
  assert.equal(context.requestCaptureDiagnostics(), 1);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Capturing…");
  assert.equal(button.dataset.captureState, "pending");
  assert.equal(button.dataset.requestId, "1");
  assert.equal(context.output.textContent, "", "a stale JSON report cannot satisfy capture");
  assert.deepEqual(snapshots, [1]);
  assert.equal(context.requestCaptureDiagnostics(), false, "a capture cannot overlap itself");

  assert.equal(
    context.completeCaptureDiagnostics({ stage: "scenario-complete", diagnosticsRequestId: 1 }),
    false,
    "the wrong stage cannot complete a request",
  );
  assert.equal(
    context.completeCaptureDiagnostics({ stage: "snapshot", diagnosticsRequestId: 9 }),
    false,
    "the wrong request ID cannot complete a request",
  );
  assert.equal(button.dataset.captureState, "pending");
  assert.equal(button.disabled, true);

  assert.equal(
    context.completeCaptureDiagnostics({ stage: "snapshot", diagnosticsRequestId: 1 }),
    true,
  );
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Capture diagnostics");
  assert.equal(button.dataset.captureState, "complete");
  assert.equal(button.dataset.completedRequestId, "1");

  assert.equal(context.requestCaptureDiagnostics(), 2);
  assert.equal(
    context.completeCaptureDiagnostics({ stage: "snapshot", diagnosticsRequestId: 1 }),
    false,
    "a stale publication cannot complete the next request",
  );
  assert.equal(button.dataset.captureState, "pending");
  assert.equal(button.dataset.requestId, "2");
  assert.equal(
    context.completeCaptureDiagnostics({ stage: "snapshot", diagnosticsRequestId: 2 }),
    true,
  );

  assert.equal(context.requestCaptureDiagnostics(), 3);
  assert.equal(context.failCaptureDiagnostics("renderer device lost"), true);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Diagnostics failed");
  assert.equal(button.dataset.captureState, "failed");
  assert.equal(button.dataset.failedRequestId, "3");
  assert.equal(button.dataset.failure, "renderer device lost");

  context.captureDiagnosticsButton = null;
  assert.equal(context.requestCaptureDiagnostics(), false, "the debug harness needs no public control");
});

test("disc ownership enables diagnostics and valid JSON publication completes it", () => {
  const startWorker = extractFunction("startWorker");
  assert.match(
    startWorker,
    /globalThis\.lazuliWorker = worker;[\s\S]*?resetCaptureDiagnosticsControl\(\);/,
  );

  const publish = extractFunction("publishWorkerTerminalReport");
  assert.match(
    publish,
    /report\.rendering = \{ \.\.\.capture, backend \};[\s\S]*?output\.textContent = JSON\.stringify\(report, null, 2\);[\s\S]*?completeCaptureDiagnostics\(report\);[\s\S]*?return true;/,
  );
  assert.doesNotMatch(
    extractFunction("requestCaptureDiagnostics"),
    /Blob|File|fetch|XMLHttpRequest|download|URL/,
  );
});
