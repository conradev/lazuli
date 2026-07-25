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
  const parametersStart = source.indexOf("(", start);
  let parametersDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === "(") parametersDepth += 1;
    if (source[index] !== ")") continue;
    parametersDepth -= 1;
    if (parametersDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `unterminated parameters for ${name}`);
  const bodyStart = source.indexOf("{", parametersEnd);
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

const dspFunctionNames = [
  "hex32",
  "emptyDspUcodeUpload",
  "emptyDspZeldaCommandState",
  "traceDsp",
  "loadNextDspMail",
  "pushDspMail",
  "consumeDspMail",
  "resetDspMailbox",
  "rejectDspZeldaCommand",
  "handleDspZeldaMail",
  "handleDspCpuMail",
  "writeDspMailboxHigh",
  "writeDspMailboxLow",
];

const command01Words = Object.freeze([
  0x81000040,
  0x80002000,
  0x80003000,
  0x80004000,
  0x80005000,
]);

function dspContext(mode = "zelda") {
  const memory = new ArrayBuffer(0x8000);
  const context = {
    cycles: 10_000,
    deviceEvents: new Map(),
    dspAxCommandListPending: false,
    dspCpuMailbox: 0,
    dspCurrentMail: null,
    dspMailQueue: [],
    dspMode: mode,
    dspRomParameter: null,
    dspScheduledMail: null,
    dspTrace: [],
    dspUcodeBooted: true,
    dspUcodeHash: mode === "zelda" ? 0x2fcdf1ec : 0x4e8a8b21,
    mmio: 0,
    pc: 0x80001000,
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    dspFunctionNames.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-zelda.js" },
  );
  context.dspUcodeUpload = context.emptyDspUcodeUpload();
  context.dspZeldaCommandState = context.emptyDspZeldaCommandState();
  return context;
}

function sendDspMail(context, mail) {
  const raw = mail >>> 0;
  context.writeDspMailboxHigh(raw >>> 16);
  context.writeDspMailboxLow(raw & 0xffff);
}

function sendCommand01(context) {
  sendDspMail(context, 5);
  for (const word of command01Words) sendDspMail(context, word);
}

function producedMails(context) {
  return context.dspTrace
    .filter(entry => entry.event === "mail-produced")
    .map(entry => [entry.mail, entry.interrupt]);
}

function consumedMails(context) {
  return context.dspTrace
    .filter(entry => entry.event === "mail-consumed")
    .map(entry => entry.mail);
}

test("Zelda command 01 waits for all five words and returns its ordered standard ACK", () => {
  const context = dspContext();

  sendDspMail(context, 5);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.deviceEvents.get("dspZeldaCommand"), undefined);
  assert.equal(context.dspZeldaCommandState.phase, "writing");
  assert.equal(context.dspZeldaCommandState.expectedWords, 5);

  for (const [index, word] of command01Words.slice(0, -1).entries()) {
    sendDspMail(context, word);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(context.deviceEvents.get("dspMailProduced"), undefined);
    assert.equal(context.dspZeldaCommandState.expectedWords, 4 - index);
  }

  sendDspMail(context, command01Words.at(-1));
  assert.equal(context.dspCurrentMail, 0xdcd10004);
  assert.deepEqual(
    context.dspMailQueue.map(entry => [entry.mail, entry.interrupt]),
    [[0xf3558100, false]],
  );
  assert.equal(context.view.getUint16(context.mmio + 0x500a, false) & 0x80, 0x80);
  assert.equal(context.deviceEvents.get("dspZeldaCommand"), 1);
  assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), undefined);
  assert.equal(context.deviceEvents.get("dspMailProduced"), 2);
  assert.equal(context.dspZeldaCommandState.phase, "waiting");
  assert.equal(context.dspZeldaCommandState.expectedWords, 0);
  assert.equal(context.dspZeldaCommandState.words.length, 0);
  assert.equal(context.dspZeldaCommandState.lastCommand, command01Words[0]);
  assert.equal(context.dspZeldaCommandState.lastSync, 0x8100);
  assert.deepEqual(
    context.dspTrace
      .filter(entry => entry.event === "mail-produced")
      .map(entry => entry.source),
    ["zelda-command-sync", "zelda-command-ack"],
  );
  assert.deepEqual(producedMails(context), [
    ["0xdcd10004", true],
    ["0xf3558100", false],
  ]);

  context.consumeDspMail();
  assert.equal(context.dspCurrentMail, 0xf3558100);
  assert.equal(context.dspMailQueue.length, 0);
  context.consumeDspMail();
  assert.equal(context.dspCurrentMail, null);
  assert.deepEqual(consumedMails(context), [
    "0xdcd10004",
    "0xf3558100",
  ]);
});

test("Zelda command parsing is isolated from AX mail handling", () => {
  const context = dspContext("ax");
  sendCommand01(context);

  assert.equal(context.dspMode, "ax");
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.dspScheduledMail, null);
  assert.equal(context.dspAxCommandListPending, false);
  assert.equal(context.deviceEvents.get("dspZeldaCommand"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), undefined);
  assert.deepEqual(producedMails(context), []);
});

test("malformed Zelda command counts fail closed without an ACK", () => {
  for (const count of [0, 1, 4, 6, 64, 65, 0x00010005, 0x80000005]) {
    const context = dspContext();
    sendDspMail(context, count);
    if (count === 4) {
      for (const word of command01Words.slice(0, 4)) {
        sendDspMail(context, word);
      }
    }

    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(context.deviceEvents.get("dspZeldaCommand"), undefined);
    assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
    assert.equal(context.dspZeldaCommandState.phase, "halted");
    assert.equal(context.dspZeldaCommandState.reason, "unsupported-count");
    assert.deepEqual(producedMails(context), []);
    assert.equal(
      context.dspTrace.find(entry => entry.event === "zelda-command-rejected")?.reason,
      "unsupported-count",
    );
  }
});

test("malformed and unknown complete Zelda commands fail closed without an ACK", () => {
  for (const [commandMail, reason] of [
    [0x01000040, "malformed-command"],
    [0x82000040, "unsupported-command"],
  ]) {
    const context = dspContext();
    sendDspMail(context, 5);
    sendDspMail(context, commandMail);
    for (const word of command01Words.slice(1)) sendDspMail(context, word);

    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(context.deviceEvents.get("dspZeldaCommand"), undefined);
    assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
    assert.equal(context.dspZeldaCommandState.phase, "halted");
    assert.equal(context.dspZeldaCommandState.reason, reason);
    assert.deepEqual(producedMails(context), []);
    assert.equal(
      context.dspTrace.find(entry => entry.event === "zelda-command-rejected")?.reason,
      reason,
    );
  }
});

test("DSP reset discards a partial Zelda command before producing its ROM greeting", () => {
  const context = dspContext();
  sendDspMail(context, 5);
  sendDspMail(context, command01Words[0]);
  sendDspMail(context, command01Words[1]);
  assert.equal(context.dspCurrentMail, null);

  context.resetDspMailbox();

  assert.equal(context.dspMode, "rom");
  assert.equal(context.dspUcodeBooted, false);
  assert.equal(context.dspCurrentMail, 0x8071feed);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.dspZeldaCommandState.phase, "waiting");
  assert.equal(context.dspZeldaCommandState.expectedWords, 0);
  assert.equal(context.dspZeldaCommandState.words.length, 0);
  assert.equal(context.deviceEvents.get("dspZeldaCommand"), undefined);
  assert.equal(context.deviceEvents.get("dspReset"), 1);
  assert.deepEqual(producedMails(context), [["0x8071feed", false]]);

  context.consumeDspMail();
  for (const staleWord of command01Words.slice(2)) {
    sendDspMail(context, staleWord);
  }
  assert.equal(context.deviceEvents.get("dspZeldaCommand"), undefined);
  assert.equal(
    producedMails(context).some(
      ([mail]) => mail === "0xdcd10004" || mail === "0xf3558100",
    ),
    false,
  );
});

test("release diagnostics retain Zelda command telemetry and state", () => {
  assert.match(source, /deviceEvents: Object\.fromEntries\(deviceEvents\)/);
  assert.match(
    source,
    /dspZeldaCommand:\s*\{\s*phase: dspZeldaCommandState\.phase,\s*expectedWords:/,
  );
});
