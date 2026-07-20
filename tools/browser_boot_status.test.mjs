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

function createHarness() {
  const document = { body: { dataset: { status: "running" } } };
  const discStatus = { textContent: "ready" };
  const output = { textContent: "RUNNING" };
  const runnerStatus = { textContent: "running" };
  const context = { document, discStatus, output, runnerStatus };
  vm.createContext(context);
  vm.runInContext(extractFunction("handleWorkerError"), context, {
    filename: "browser_boot.status.js",
  });
  return context;
}

test("worker errors remain visible when release diagnostics are stripped", () => {
  const context = createHarness();

  context.handleWorkerError({ message: "disc read failed" });

  assert.equal(context.document.body.dataset.status, "stopped");
  assert.equal(context.runnerStatus.textContent, "worker error");
  assert.equal(context.discStatus.textContent, "disc read failed");
  assert.deepEqual(JSON.parse(context.output.textContent), {
    status: "stopped",
    stage: "worker",
    error: "disc read failed",
  });
});

test("worker errors have a visible message when the browser omits one", () => {
  const context = createHarness();

  context.handleWorkerError({});

  assert.equal(context.runnerStatus.textContent, "worker error");
  assert.equal(context.discStatus.textContent, "unknown worker error");
  assert.equal(JSON.parse(context.output.textContent).error, "unknown worker error");
});
