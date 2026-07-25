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
  "physicalOffset",
  "ramPointer",
  "hex32",
  "emptyDspUcodeUpload",
  "emptyDspZeldaRenderState",
  "emptyDspZeldaCommandState",
  "dspUcodeHashEctor",
  "classifyDspUcode",
  "traceDsp",
  "loadNextDspMail",
  "pushDspMail",
  "consumeDspMail",
  "resetDspMailbox",
  "captureDspRomParameter",
  "rejectDspUcodeBoot",
  "bootDspUcode",
  "rejectDspZeldaCommand",
  "handleDspZeldaMail",
  "handleDspCpuMail",
  "writeDspMailboxHigh",
  "writeDspMailboxLow",
];

const axHashFixture = Uint8Array.from([
  178, 0, 5, 1, 6, 4, 2, 5, 0, 0, 0, 0,
]);
const zeldaHashFixture = Uint8Array.from([
  30, 6, 0, 5, 7, 6, 3, 3, 7, 0, 0, 0,
]);
const luigiZeldaHashFixture = Uint8Array.from([
  172, 2, 1, 0, 2, 7, 5, 4, 4, 0, 0, 0,
]);
const uploadAddress = 0x80001000;

function dspContext(payload = axHashFixture) {
  const memory = new ArrayBuffer(0x30000);
  const context = {
    bytes: new Uint8Array(memory),
    cycles: 10_000,
    deviceEvents: new Map(),
    dspAxCommandListPending: false,
    dspCpuMailbox: 0,
    dspCurrentMail: null,
    dspMailQueue: [],
    dspMode: "rom",
    dspRomParameter: null,
    dspScheduledMail: null,
    dspTrace: [],
    dspUcodeBooted: false,
    dspUcodeHash: null,
    dspZeldaCommandState: null,
    mmio: 0x20000,
    pc: 0x80001000,
    ram: 0,
    ramSize: 0x18000,
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    dspFunctionNames.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-ucode.js" },
  );
  context.dspUcodeUpload = context.emptyDspUcodeUpload();
  context.dspZeldaCommandState = context.emptyDspZeldaCommandState();
  context.bytes.set(payload, 0x1000);
  return context;
}

function sendDspMail(context, mail) {
  const raw = mail >>> 0;
  context.writeDspMailboxHigh(raw >>> 16);
  context.writeDspMailboxLow(raw & 0xffff);
}

function sendUcodeUpload(
  context,
  {
    address = uploadAddress,
    length = axHashFixture.length,
    imemAddress = 0,
    dmemLength = 0,
    startPc = 0,
  } = {},
) {
  const pairs = [
    [0x80f3a001, address],
    [0x80f3c002, imemAddress],
    [0x80f3a002, length],
    [0x80f3b002, dmemLength],
    [0x80f3d001, startPc],
  ];
  for (const [parameter, value] of pairs) {
    sendDspMail(context, parameter);
    sendDspMail(context, value);
  }
}

function parameterTrace(context) {
  return context.dspTrace
    .filter(entry => entry.event === "ucode-parameter")
    .map(entry => [entry.parameter, entry.value]);
}

function producedMailTrace(context) {
  return context.dspTrace
    .filter(entry => entry.event === "mail-produced")
    .map(entry => [entry.mail, entry.interrupt, entry.source]);
}

test("Dolphin HashEctor fixtures pin the AX and Zelda ucode hashes", () => {
  const context = dspContext();
  assert.equal(context.dspUcodeHashEctor(axHashFixture), 0x4e8a8b21);
  assert.equal(context.dspUcodeHashEctor(zeldaHashFixture), 0x2fcdf1ec);
  assert.equal(
    context.dspUcodeHashEctor(luigiZeldaHashFixture),
    0x42f64ac4,
  );
  assert.equal(context.classifyDspUcode(0x4e8a8b21), "ax");
  assert.equal(context.classifyDspUcode(0x3ad3b7ac), "ax");
  assert.equal(context.classifyDspUcode(0x3daf59b9), "ax");
  assert.equal(context.classifyDspUcode(0x07f88145), "ax");
  assert.equal(context.classifyDspUcode(0xe2136399), "ax");
  assert.equal(context.classifyDspUcode(0x3389a79e), "ax");
  assert.equal(context.classifyDspUcode(0x2fcdf1ec), "zelda");
  assert.equal(context.classifyDspUcode(0x42f64ac4), "zelda");
  assert.equal(context.classifyDspUcode(0), null);
});

test("mailbox high data stays raw while ready status waits for the low write", () => {
  const context = dspContext();

  context.writeDspMailboxHigh(0x80f3);
  assert.equal(context.view.getUint16(context.mmio + 0x5000, false), 0x00f3);
  assert.equal(context.dspCpuMailbox >>> 16, 0x80f3);
  assert.equal(context.deviceEvents.get("dspCpuMail"), undefined);

  context.writeDspMailboxLow(0xa001);
  assert.equal(context.deviceEvents.get("dspCpuMail"), 1);
  assert.equal(context.dspRomParameter, 0x80f3a001);
  assert.equal(context.view.getUint16(context.mmio + 0x5000, false), 0x00f3);
});

test("AX upload hashes raw guest IRAM and emits only DSP_INIT", () => {
  const context = dspContext(axHashFixture);
  context.bytes[0x1000 + axHashFixture.length] = 0xff;
  sendUcodeUpload(context, { length: axHashFixture.length });

  assert.equal(context.dspMode, "ax");
  assert.equal(context.dspUcodeBooted, true);
  assert.equal(context.dspUcodeHash, 0x4e8a8b21);
  assert.equal(context.dspCurrentMail, 0xdcd10000);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.deviceEvents.get("dspCpuMail"), 10);
  assert.equal(context.deviceEvents.get("dspUcodeBoot"), 1);
  assert.equal(context.deviceEvents.get("dspUcodeBootRejected"), undefined);
  assert.equal(context.deviceEvents.get("dspMailProduced"), 1);
  assert.deepEqual(parameterTrace(context), [
    ["0x80f3a001", "0x80001000"],
    ["0x80f3c002", "0x00000000"],
    ["0x80f3a002", "0x0000000c"],
    ["0x80f3b002", "0x00000000"],
    ["0x80f3d001", "0x00000000"],
  ]);
  assert.deepEqual(producedMailTrace(context), [
    ["0xdcd10000", true, "ax-ucode"],
  ]);
});

test("physical, cached, and uncached RAM aliases classify the same ucode bytes", () => {
  for (const address of [0x00001000, 0x80001000, 0xc0001000]) {
    const context = dspContext(axHashFixture);
    sendUcodeUpload(context, {
      address,
      length: axHashFixture.length,
    });
    assert.equal(context.dspUcodeHash, 0x4e8a8b21);
    assert.equal(context.dspMode, "ax");
    assert.equal(context.dspUcodeBooted, true);
  }
});

test("Zelda upload emits DSP_INIT before its non-interrupt handshake", () => {
  const context = dspContext(zeldaHashFixture);
  sendUcodeUpload(context, { length: zeldaHashFixture.length });

  assert.equal(context.dspMode, "zelda");
  assert.equal(context.dspUcodeBooted, true);
  assert.equal(context.dspUcodeHash, 0x2fcdf1ec);
  assert.equal(context.dspCurrentMail, 0xdcd10000);
  assert.deepEqual(
    context.dspMailQueue.map(entry => [entry.mail, entry.interrupt]),
    [[0xf3551111, false]],
  );
  assert.equal(context.deviceEvents.get("dspCpuMail"), 10);
  assert.equal(context.deviceEvents.get("dspUcodeBoot"), 1);
  assert.equal(context.deviceEvents.get("dspMailProduced"), 2);
  assert.deepEqual(producedMailTrace(context), [
    ["0xdcd10000", true, "zelda-ucode"],
    ["0xf3551111", false, "zelda-ucode-handshake"],
  ]);

  context.consumeDspMail();
  assert.equal(context.dspCurrentMail, 0xf3551111);
  context.consumeDspMail();
  assert.equal(context.dspCurrentMail, null);

  sendDspMail(context, 0xbabe0180);
  sendDspMail(context, 0x00123460);
  assert.equal(context.dspAxCommandListPending, false);
  assert.equal(context.dspScheduledMail, null);
  assert.equal(context.deviceEvents.get("dspAxCommandList"), undefined);
});

test("Luigi Zelda upload emits its startup handshake and release diagnostics", () => {
  const context = dspContext(luigiZeldaHashFixture);
  sendUcodeUpload(context, { length: luigiZeldaHashFixture.length });

  assert.equal(context.dspMode, "zelda");
  assert.equal(context.dspUcodeBooted, true);
  assert.equal(context.dspUcodeHash, 0x42f64ac4);
  assert.equal(context.dspCurrentMail, 0xdcd10000);
  assert.deepEqual(
    context.dspMailQueue.map(entry => [entry.mail, entry.interrupt]),
    [[0xf3551111, false]],
  );
  assert.equal(context.deviceEvents.get("dspUcodeBoot"), 1);
  assert.equal(context.deviceEvents.get("dspUcodeBootRejected"), undefined);
  assert.deepEqual(producedMailTrace(context), [
    ["0xdcd10000", true, "zelda-ucode"],
    ["0xf3551111", false, "zelda-ucode-handshake"],
  ]);
  assert.deepEqual(
    { ...context.dspTrace.find(entry => entry.event === "ucode-boot") },
    {
      event: "ucode-boot",
      pc: "0x80001000",
      cycles: 10_000,
      hash: "0x42f64ac4",
      mode: "zelda",
      ramAddress: "0x80001000",
      length: luigiZeldaHashFixture.length,
      imemAddress: 0,
      dmemLength: 0,
      startPc: 0,
    },
  );
});

test("unknown ucode hash fails closed without a startup mail", () => {
  const unknownFixture = new Uint8Array(axHashFixture.length);
  const context = dspContext(unknownFixture);
  sendUcodeUpload(context, { length: unknownFixture.length });

  assert.equal(context.dspMode, "rom");
  assert.equal(context.dspUcodeBooted, false);
  assert.equal(context.dspUcodeHash, 0);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.deviceEvents.get("dspUcodeBoot"), undefined);
  assert.equal(context.deviceEvents.get("dspUcodeBootRejected"), 1);
  assert.equal(
    context.dspTrace.find(entry => entry.event === "ucode-boot-rejected")?.reason,
    "unknown-hash",
  );
});

test("missing and empty uploads fail before hashing", () => {
  const missing = dspContext();
  sendDspMail(missing, 0x80f3d001);
  sendDspMail(missing, 0);
  assert.equal(missing.dspUcodeBooted, false);
  assert.equal(missing.dspUcodeHash, null);
  assert.equal(missing.dspCurrentMail, null);
  assert.equal(missing.deviceEvents.get("dspUcodeBootRejected"), 1);
  assert.equal(
    missing.dspTrace.find(entry => entry.event === "ucode-boot-rejected")?.reason,
    "missing-parameters",
  );

  const empty = dspContext();
  sendUcodeUpload(empty, { length: 0 });
  assert.equal(empty.dspUcodeBooted, false);
  assert.equal(empty.dspUcodeHash, null);
  assert.equal(empty.dspCurrentMail, null);
  assert.equal(empty.deviceEvents.get("dspUcodeBootRejected"), 1);
  assert.equal(
    empty.dspTrace.find(entry => entry.event === "ucode-boot-rejected")?.reason,
    "empty-iram",
  );
});

test("upload pairing preserves the next mail as data and rejects an unbacked range", () => {
  const context = dspContext();
  const mails = [
    0x80f3a001,
    0x80f3c002,
    0x80f3c002,
    0,
    0x80f3a002,
    axHashFixture.length,
    0x80f3b002,
    0,
    0x80f3d001,
    0,
  ];
  for (const mail of mails) sendDspMail(context, mail);

  assert.equal(context.deviceEvents.get("dspCpuMail"), mails.length);
  assert.equal(context.dspUcodeBooted, false);
  assert.equal(context.dspUcodeHash, null);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.deviceEvents.get("dspUcodeBootRejected"), 1);
  assert.deepEqual(parameterTrace(context)[0], [
    "0x80f3a001",
    "0x80f3c002",
  ]);
  assert.equal(
    context.dspTrace.find(entry => entry.event === "ucode-boot-rejected")?.reason,
    "iram-out-of-bounds",
  );
});

test("a canonical upload whose source crosses RAM end fails closed", () => {
  const context = dspContext();
  sendUcodeUpload(context, {
    address: 0x80017ff8,
    length: axHashFixture.length,
  });

  assert.equal(context.dspUcodeBooted, false);
  assert.equal(context.dspUcodeHash, null);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.deviceEvents.get("dspUcodeBootRejected"), 1);
  assert.equal(
    context.dspTrace.find(entry => entry.event === "ucode-boot-rejected")?.reason,
    "iram-out-of-bounds",
  );
});

test("non-ROM mail keeps the existing FEEE echo behavior", () => {
  const context = dspContext();
  sendDspMail(context, 0x12345678);

  assert.equal(context.dspCurrentMail, 0xfeee5678);
  assert.equal(context.dspUcodeBooted, false);
  assert.equal(context.deviceEvents.get("dspUcodeBootRejected"), undefined);
});

test("DSP reset clears partial classification state before its ROM greeting", () => {
  const context = dspContext();
  context.dspUcodeUpload.ramAddress = uploadAddress;
  context.dspUcodeHash = 0x2fcdf1ec;
  context.dspMode = "zelda";
  context.dspUcodeBooted = true;
  context.dspAxCommandListPending = true;
  context.dspScheduledMail = { mail: 0xdcd10002, completionCycle: 12_500 };
  context.dspCurrentMail = 0xdcd10000;
  context.dspMailQueue.push({ mail: 0xf3551111, interrupt: false });

  context.resetDspMailbox();

  assert.equal(context.dspCpuMailbox, 0);
  assert.equal(context.dspRomParameter, null);
  assert.equal(context.dspUcodeUpload.ramAddress, null);
  assert.equal(context.dspUcodeHash, null);
  assert.equal(context.dspMode, "rom");
  assert.equal(context.dspUcodeBooted, false);
  assert.equal(context.dspAxCommandListPending, false);
  assert.equal(context.dspScheduledMail, null);
  assert.equal(context.dspCurrentMail, 0x8071feed);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.deviceEvents.get("dspReset"), 1);
});

test("release diagnostics retain the classified ucode hash", () => {
  assert.match(source, /dspMode,/);
  assert.match(
    source,
    /dspUcodeHash: dspUcodeHash === null \? null : hex32\(dspUcodeHash\)/,
  );
  assert.match(source, /dspTrace,/);
});
