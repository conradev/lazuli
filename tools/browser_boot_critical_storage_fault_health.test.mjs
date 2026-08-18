#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated ${name}`);
}

const functions = [
  "classifyCriticalStorageFault",
  "criticalStorageFaultMatches",
  "resolveCriticalStorageFaultPending",
  "beginCriticalStorageFault",
  "observeCriticalStorageFaultHandlerReturn",
  "observeCriticalStorageFaultRetryProgress",
  "snapshotCriticalStorageFaultHealth",
];

function makeContext() {
  const buffer = new ArrayBuffer(0x1000);
  const context = {
    cpu: 0,
    cycles: 100,
    criticalStorageFaultClassifications: {
      "data-page-fault": 0,
      "data-protection-fault": 0,
      "instruction-page-fault": 0,
      "instruction-protection-fault": 0,
      unsupported: 0,
    },
    criticalStorageFaultHandlerReturns: 0,
    criticalStorageFaultLastResolved: null,
    criticalStorageFaultMaxHandlerCycles: 0,
    criticalStorageFaultMaxHandlerDispatches: 0,
    criticalStorageFaultNested: 0,
    criticalStorageFaultPending: null,
    criticalStorageFaultRaised: 0,
    criticalStorageFaultRecurrences: 0,
    criticalStorageFaultResolved: 0,
    criticalStorageFaultSchema: "lazuli-critical-storage-fault-health-v1",
    criticalStorageFaultSequence: 0,
    darOffset: 0x20,
    dispatches: 10,
    dsisrOffset: 0x24,
    hex32: value => "0x" + (value >>> 0).toString(16).padStart(8, "0"),
    lastDataStorageFault: null,
    lastUnmappedAccess: null,
    pcOffset: 0x28,
    view: new DataView(buffer),
  };
  vm.createContext(context);
  vm.runInContext(functions.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.critical-storage-fault-health.js",
  });
  return context;
}

function beginDataFault(context, {
  address = 0x7fc00000,
  cause = 0x42000000,
  pc = 0x80007384,
  resolverKind = "page-fault",
  stage = "translation",
} = {}) {
  context.lastDataStorageFault = { resolverKind, stage };
  context.view.setUint32(context.cpu + context.pcOffset, pc, true);
  context.view.setUint32(context.cpu + context.darOffset, address, true);
  context.view.setUint32(context.cpu + context.dsisrOffset, cause, true);
  context.beginCriticalStorageFault(0x0300, pc, 0);
}

function returnAndProgress(context, pc = 0x80007384) {
  context.cycles += 80;
  context.dispatches += 12;
  context.view.setUint32(context.cpu + context.pcOffset, pc, true);
  assert.equal(context.observeCriticalStorageFaultHandlerReturn(), true);
  assert.equal(context.observeCriticalStorageFaultRetryProgress(pc), true);
}

test("runtime wires precise storage exceptions, rfi return, retry, and report health", () => {
  assert.match(
    extractFunction("raiseException"),
    /beginCriticalStorageFault\(exception, oldPc, specialSrr1\)/,
  );
  assert.match(
    extractFunction("msrChanged"),
    /observeCriticalStorageFaultHandlerReturn\(\)/,
  );
  assert.match(
    source,
    /observeCriticalStorageFaultRetryProgress\(executedPc\);\s*updateStablePcWitness/,
  );
  assert.match(
    source,
    /criticalStorageFaults:\s*snapshotCriticalStorageFaultHealth\(\)/,
  );
  assert.match(
    source,
    /runnerSnapshotRequested[\s\S]*dspLastServiceCycle === cycles[\s\S]*criticalStorageFaultPending === null[\s\S]*publishRunnerSnapshot\(\)/,
  );
});

test("a demand DSI is healthy only after exact handler return and retry progress", () => {
  const context = makeContext();
  beginDataFault(context);
  let health = structuredClone(context.snapshotCriticalStorageFaultHealth());
  assert.equal(health.raised, 1);
  assert.equal(health.handlerReturns, 0);
  assert.equal(health.resolved, 0);
  assert.equal(health.pending.phase, "handler");
  assert.equal(health.pending.address, "0x7fc00000");

  returnAndProgress(context);
  health = structuredClone(context.snapshotCriticalStorageFaultHealth());
  assert.equal(health.raised, 1);
  assert.equal(health.handlerReturns, 1);
  assert.equal(health.resolved, 1);
  assert.equal(health.pending, null);
  assert.equal(health.recurrences, 0);
  assert.equal(health.nested, 0);
  assert.equal(health.classifications["data-page-fault"], 1);
  assert.equal(health.lastResolved.reason, "retry-dispatch-complete");
  assert.equal(health.lastResolved.pc, "0x80007384");
});

test("a distinct later fault proves the returned access progressed first", () => {
  const context = makeContext();
  beginDataFault(context);
  context.cycles += 40;
  context.dispatches += 6;
  context.view.setUint32(context.cpu + context.pcOffset, 0x80007384, true);
  assert.equal(context.observeCriticalStorageFaultHandlerReturn(), true);

  beginDataFault(context, { address: 0x7fc01000 });
  let health = structuredClone(context.snapshotCriticalStorageFaultHealth());
  assert.equal(health.raised, 2);
  assert.equal(health.resolved, 1);
  assert.equal(health.lastResolved.reason, "subsequent-distinct-fault");
  assert.equal(health.pending.address, "0x7fc01000");
  assert.equal(health.recurrences, 0);

  returnAndProgress(context);
  health = structuredClone(context.snapshotCriticalStorageFaultHealth());
  assert.equal(health.handlerReturns, 2);
  assert.equal(health.resolved, 2);
  assert.equal(health.pending, null);
});

test("same-fingerprint recurrence and nested handler faults remain fail-closed", () => {
  const recurrent = makeContext();
  beginDataFault(recurrent);
  recurrent.cycles += 10;
  recurrent.dispatches += 2;
  recurrent.view.setUint32(recurrent.cpu + recurrent.pcOffset, 0x80007384, true);
  assert.equal(recurrent.observeCriticalStorageFaultHandlerReturn(), true);
  beginDataFault(recurrent);
  assert.equal(recurrent.criticalStorageFaultRecurrences, 1);
  assert.equal(recurrent.criticalStorageFaultPending.attempts, 2);
  returnAndProgress(recurrent);
  assert.equal(recurrent.criticalStorageFaultRaised, 2);
  assert.equal(recurrent.criticalStorageFaultHandlerReturns, 2);
  assert.equal(recurrent.criticalStorageFaultResolved, 2);

  const nested = makeContext();
  beginDataFault(nested);
  beginDataFault(nested, { address: 0x7fc01000 });
  assert.equal(nested.criticalStorageFaultNested, 1);
  assert.equal(nested.criticalStorageFaultRaised, 2);
});

test("instruction and unsupported fault classifications are exact", () => {
  const context = makeContext();
  context.lastUnmappedAccess = { reason: "protection" };
  context.beginCriticalStorageFault(0x0400, 0x7fc0f7a4, 0x08000000);
  let health = structuredClone(context.snapshotCriticalStorageFaultHealth());
  assert.equal(health.classifications["instruction-protection-fault"], 1);
  assert.equal(health.pending.address, "0x7fc0f7a4");
  assert.equal(health.pending.cause, "0x08000000");

  const unsupported = makeContext();
  unsupported.lastDataStorageFault = {
    resolverKind: "mapped",
    stage: "physical",
  };
  unsupported.view.setUint32(unsupported.cpu + unsupported.darOffset, 0x04000000, true);
  unsupported.beginCriticalStorageFault(0x0300, 0x80001234, 0);
  health = structuredClone(unsupported.snapshotCriticalStorageFaultHealth());
  assert.equal(health.classifications.unsupported, 1);
});
