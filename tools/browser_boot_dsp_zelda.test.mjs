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
  "emptyDspZeldaRenderState",
  "emptyDspZeldaCommandState",
  "traceDsp",
  "loadNextDspMail",
  "pushDspMail",
  "consumeDspMail",
  "resetDspMailbox",
  "validateDspZeldaOutputRange",
  "clearDspZeldaSilentFrame",
  "finishDspZeldaRenderFrame",
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

const outputLeftAddress = 0x80001000;
const outputRightAddress = 0x80001800;
const renderFrames = 7;
const bytesPerChannelFrame = 0xa0;

function dspContext(mode = "zelda") {
  const memory = new ArrayBuffer(0x8000);
  const bytes = new Uint8Array(memory);
  const ram = 0x1000;
  const ramSize = 0x6000;
  const context = {
    bytes,
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
    invalidateDataReservationForExternalWrite() {},
    mmio: 0,
    pc: 0x80001000,
    ram,
    ramPointer(address, size) {
      const logical = address >>> 0;
      const physical = logical < ramSize
        ? logical
        : logical >= 0x80000000 && logical < 0x80000000 + ramSize
          ? logical - 0x80000000
          : null;
      if (
        physical === null
        || !Number.isSafeInteger(size)
        || size < 0
        || physical + size > ramSize
      ) {
        return null;
      }
      return ram + physical;
    },
    ramSize,
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

function sendCommand02(
  context,
  {
    frames = renderFrames,
    volume = 0x4000,
    leftAddress = outputLeftAddress,
    rightAddress = outputRightAddress,
  } = {},
) {
  sendDspMail(context, 3);
  sendDspMail(
    context,
    (0x82000000 | ((frames & 0xff) << 16) | (volume & 0xffff)) >>> 0,
  );
  sendDspMail(context, leftAddress);
  sendDspMail(context, rightAddress);
}

function consumeAllDspMails(context) {
  while (context.dspCurrentMail !== null) context.consumeDspMail();
}

function prepareZeldaRender(context, options) {
  sendCommand01(context);
  consumeAllDspMails(context);
  context.dspTrace.length = 0;
  context.deviceEvents.clear();
  sendCommand02(context, options);
}

function ramBytes(context, address, length) {
  const start = context.ramPointer(address, length);
  assert.notEqual(start, null, "fixture address must map into guest RAM");
  return context.bytes.subarray(start, start + length);
}

function sendRenderGroup(context, group, activeMap = 0xffff) {
  sendDspMail(context, 0);
  sendDspMail(
    context,
    (((group & 0xffff) << 16) | (activeMap & 0xffff)) >>> 0,
  );
}

function completeOneZeldaFrame(context) {
  prepareZeldaRender(context, { frames: 1 });
  for (let group = 0; group < 4; group += 1) {
    sendRenderGroup(context, group);
  }
  assert.equal(context.dspZeldaCommandState.phase, "task-wait");
  assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, true);
  consumeAllDspMails(context);
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
  assert.equal(context.dspZeldaCommandState.setup.voicesPerFrame, 0x40);
  assert.equal(
    context.dspZeldaCommandState.setup.vpbBaseAddress,
    command01Words[1],
  );
  assert.equal(
    context.dspZeldaCommandState.setup.coefficientAddress,
    command01Words[2],
  );
  assert.equal(
    context.dspZeldaCommandState.setup.afcCoeffAddress,
    command01Words[3],
  );
  assert.equal(
    context.dspZeldaCommandState.setup.reverbPbBaseAddress,
    command01Words[4],
  );
  assert.equal(context.dspZeldaCommandState.render.active, false);
  assert.equal(context.deviceEvents.get("dspZeldaSetup"), 1);
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

test("Zelda command 02 retains setup and collects exactly three words without an early ACK", () => {
  const context = dspContext();
  sendCommand01(context);
  consumeAllDspMails(context);
  context.dspTrace.length = 0;
  context.deviceEvents.clear();

  const commandMail = 0x82074000;
  for (const [mail, expectedWords] of [
    [3, 3],
    [commandMail, 2],
    [outputLeftAddress, 1],
  ]) {
    sendDspMail(context, mail);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.deepEqual(producedMails(context), []);
    assert.equal(context.dspZeldaCommandState.expectedWords, expectedWords);
  }

  sendDspMail(context, outputRightAddress);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.deepEqual(producedMails(context), []);
  assert.equal(context.dspZeldaCommandState.phase, "waiting");
  assert.equal(context.dspZeldaCommandState.expectedWords, 0);
  assert.equal(context.dspZeldaCommandState.commandWordCount, 0);
  assert.equal(context.dspZeldaCommandState.words.length, 0);
  assert.equal(context.dspZeldaCommandState.lastCommand, commandMail);
  assert.equal(context.dspZeldaCommandState.setup.voicesPerFrame, 0x40);
  assert.equal(context.dspZeldaCommandState.render.active, true);
  assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, false);
  assert.equal(context.dspZeldaCommandState.render.requestedFrames, renderFrames);
  assert.equal(context.dspZeldaCommandState.render.currentFrame, 0);
  assert.equal(context.dspZeldaCommandState.render.currentVoice, 0);
  assert.equal(context.dspZeldaCommandState.render.outputVolume, 0x4000);
  assert.equal(
    context.dspZeldaCommandState.render.outputLeftAddress,
    outputLeftAddress,
  );
  assert.equal(
    context.dspZeldaCommandState.render.outputRightAddress,
    outputRightAddress,
  );
  assert.equal(context.dspZeldaCommandState.render.clearedBytes, 0);
  assert.equal(context.deviceEvents.get("dspZeldaCommand"), 1);
  assert.equal(context.deviceEvents.get("dspZeldaRenderCommand"), 1);
  assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), undefined);
});

test("MKDD Zelda render follows seven frames of four sync groups and exact frame mail ordering", () => {
  const context = dspContext();
  const channelBytes = renderFrames * bytesPerChannelFrame;
  const left = ramBytes(context, outputLeftAddress, channelBytes);
  const right = ramBytes(context, outputRightAddress, channelBytes);
  left.fill(0x5a);
  right.fill(0xa5);
  const leftStart = context.ramPointer(outputLeftAddress, channelBytes);
  const rightStart = context.ramPointer(outputRightAddress, channelBytes);
  context.bytes[leftStart - 1] = 0x31;
  context.bytes[leftStart + channelBytes] = 0x32;
  context.bytes[rightStart - 1] = 0x41;
  context.bytes[rightStart + channelBytes] = 0x42;

  prepareZeldaRender(context);
  const observedFrameMails = [];
  assert.deepEqual(producedMails(context), []);
  assert.equal(left.every(value => value === 0x5a), true);
  assert.equal(right.every(value => value === 0xa5), true);

  for (let frame = 0; frame < renderFrames; frame += 1) {
    for (let group = 0; group < 4; group += 1) {
      const producedBefore = producedMails(context).length;
      sendDspMail(context, 0);
      assert.equal(context.dspZeldaCommandState.phase, "rendering");
      assert.equal(context.dspZeldaCommandState.render.currentFrame, frame);
      assert.equal(context.dspZeldaCommandState.render.currentVoice, group * 16);
      assert.equal(producedMails(context).length, producedBefore);

      sendDspMail(
        context,
        ((group << 16) | (0xf00f ^ (frame << group))) >>> 0,
      );
      assert.equal(
        context.deviceEvents.get("dspZeldaRenderSync"),
        frame * 4 + group + 1,
      );
      if (group < 3) {
        assert.equal(context.dspZeldaCommandState.phase, "waiting");
        assert.equal(
          context.dspZeldaCommandState.render.currentVoice,
          (group + 1) * 16,
        );
        assert.equal(producedMails(context).length, producedBefore);
      }
    }

    const token = (0xf355ff00 | frame) >>> 0;
    assert.equal(context.dspCurrentMail, 0xdcd10004);
    assert.deepEqual(
      context.dspMailQueue.map(entry => [entry.mail, entry.interrupt]),
      frame === renderFrames - 1
        ? [[token, false], [0xdcd10005, true]]
        : [[token, false]],
    );
    assert.equal(context.dspZeldaCommandState.render.currentFrame, frame + 1);
    assert.equal(context.dspZeldaCommandState.render.currentVoice, 0);
    assert.equal(
      context.dspZeldaCommandState.render.clearedBytes,
      (frame + 1) * bytesPerChannelFrame * 2,
    );
    assert.equal(
      left
        .subarray(0, (frame + 1) * bytesPerChannelFrame)
        .every(value => value === 0),
      true,
    );
    assert.equal(
      right
        .subarray(0, (frame + 1) * bytesPerChannelFrame)
        .every(value => value === 0),
      true,
    );
    assert.equal(
      left
        .subarray((frame + 1) * bytesPerChannelFrame)
        .every(value => value === 0x5a),
      true,
    );
    assert.equal(
      right
        .subarray((frame + 1) * bytesPerChannelFrame)
        .every(value => value === 0xa5),
      true,
    );

    context.consumeDspMail();
    observedFrameMails.push(["0xdcd10004", true]);
    assert.equal(context.dspCurrentMail, token);
    context.consumeDspMail();
    observedFrameMails.push([
      "0x" + token.toString(16).padStart(8, "0"),
      false,
    ]);
    if (frame === renderFrames - 1) {
      assert.equal(context.dspCurrentMail, 0xdcd10005);
      assert.equal(context.dspZeldaCommandState.phase, "task-wait");
      assert.equal(context.dspZeldaCommandState.render.active, false);
      assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, true);
      context.consumeDspMail();
      observedFrameMails.push(["0xdcd10005", true]);
    } else {
      assert.equal(context.dspCurrentMail, null);
      assert.equal(context.dspZeldaCommandState.phase, "waiting");
      assert.equal(context.dspZeldaCommandState.render.active, true);
    }
  }

  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.bytes[leftStart - 1], 0x31);
  assert.equal(context.bytes[leftStart + channelBytes], 0x32);
  assert.equal(context.bytes[rightStart - 1], 0x41);
  assert.equal(context.bytes[rightStart + channelBytes], 0x42);
  assert.equal(context.deviceEvents.get("dspZeldaRenderCommand"), 1);
  assert.equal(context.deviceEvents.get("dspZeldaRenderSync"), 28);
  assert.equal(context.deviceEvents.get("dspZeldaRenderFrame"), renderFrames);
  assert.equal(context.deviceEvents.get("dspZeldaSilentFrame"), renderFrames);
  assert.equal(context.deviceEvents.get("dspZeldaRenderComplete"), 1);
  assert.deepEqual(
    observedFrameMails,
    Array.from({ length: renderFrames }, (_, frame) => [
      ["0xdcd10004", true],
      [
        "0x"
          + ((0xf355ff00 | frame) >>> 0).toString(16).padStart(8, "0"),
        false,
      ],
    ]).flat().concat([["0xdcd10005", true]]),
  );

  sendDspMail(context, 0xcdd10003);
  assert.equal(context.dspZeldaCommandState.phase, "waiting");
  assert.equal(context.dspZeldaCommandState.render.active, false);
  assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, false);
  assert.equal(context.deviceEvents.get("dspZeldaTaskContinue"), 1);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(
    producedMails(context).some(([mail]) => mail === "0xdcd10001"),
    false,
  );
});

test("Zelda command parsing is isolated from AX mail handling", () => {
  const context = dspContext("ax");
  sendCommand01(context);
  sendCommand02(context);
  for (let group = 0; group < 4; group += 1) {
    sendRenderGroup(context, group);
  }

  assert.equal(context.dspMode, "ax");
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.dspScheduledMail, null);
  assert.equal(context.dspAxCommandListPending, false);
  assert.equal(context.deviceEvents.get("dspZeldaCommand"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaRenderCommand"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaRenderSync"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), undefined);
  assert.equal(context.dspZeldaCommandState.setup, null);
  assert.equal(context.dspZeldaCommandState.render.active, false);
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
  for (const [count, words, reason] of [
    [
      5,
      [0x01000040, ...command01Words.slice(1)],
      "malformed-command",
    ],
    [
      5,
      [0x82000040, ...command01Words.slice(1)],
      "malformed-command-envelope",
    ],
    [
      3,
      [0x81000040, command01Words[1], command01Words[2]],
      "malformed-command-envelope",
    ],
    [
      5,
      [0x83000040, ...command01Words.slice(1)],
      "unsupported-command",
    ],
  ]) {
    const context = dspContext();
    sendDspMail(context, count);
    for (const word of words) sendDspMail(context, word);

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

test("Zelda render rejects missing setup, empty frames, and output ranges before writing silence", () => {
  {
    const context = dspContext();
    sendCommand02(context);
    assert.equal(context.dspZeldaCommandState.phase, "halted");
    assert.equal(context.dspZeldaCommandState.reason, "render-before-setup");
    assert.equal(context.dspZeldaCommandState.render.active, false);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(context.deviceEvents.get("dspZeldaRenderCommand"), undefined);
    assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
    assert.deepEqual(producedMails(context), []);
  }

  {
    const context = dspContext();
    sendCommand01(context);
    consumeAllDspMails(context);
    context.dspTrace.length = 0;
    context.deviceEvents.clear();
    sendCommand02(context, { frames: 0 });
    assert.equal(context.dspZeldaCommandState.phase, "halted");
    assert.equal(context.dspZeldaCommandState.reason, "empty-render");
    assert.equal(context.dspZeldaCommandState.render.active, false);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(context.deviceEvents.get("dspZeldaRenderCommand"), undefined);
    assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
    assert.deepEqual(producedMails(context), []);
  }

  {
    const context = dspContext();
    const left = ramBytes(
      context,
      outputLeftAddress,
      renderFrames * bytesPerChannelFrame,
    );
    left.fill(0x6d);
    sendCommand01(context);
    consumeAllDspMails(context);
    context.dspTrace.length = 0;
    context.deviceEvents.clear();
    sendCommand02(context, { rightAddress: 0x80005c00 });
    assert.equal(context.dspZeldaCommandState.phase, "halted");
    assert.equal(context.dspZeldaCommandState.reason, "output-out-of-bounds");
    assert.equal(context.dspZeldaCommandState.render.active, false);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(left.every(value => value === 0x6d), true);
    assert.equal(context.deviceEvents.get("dspZeldaSilentFrame"), undefined);
    assert.equal(context.deviceEvents.get("dspZeldaRenderCommand"), undefined);
    assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
    assert.deepEqual(producedMails(context), []);
  }
});

test("Zelda render rejects an out-of-order voice group without a frame ACK", () => {
  const context = dspContext();
  const left = ramBytes(context, outputLeftAddress, bytesPerChannelFrame);
  const right = ramBytes(context, outputRightAddress, bytesPerChannelFrame);
  left.fill(0x71);
  right.fill(0x72);
  prepareZeldaRender(context);

  sendDspMail(context, 0);
  assert.equal(context.dspZeldaCommandState.phase, "rendering");
  sendDspMail(context, 0x0001ffff);

  assert.equal(context.dspZeldaCommandState.phase, "halted");
  assert.equal(context.dspZeldaCommandState.reason, "unsupported-render-sync");
  assert.equal(context.dspZeldaCommandState.render.active, false);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.deviceEvents.get("dspZeldaRenderSync"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaSilentFrame"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaRenderComplete"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
  assert.equal(left.every(value => value === 0x71), true);
  assert.equal(right.every(value => value === 0x72), true);
  assert.deepEqual(producedMails(context), []);
});

test("Zelda render rejects a new command count while its voice syncs are active", () => {
  const context = dspContext();
  prepareZeldaRender(context);

  sendDspMail(context, 5);

  assert.equal(context.dspZeldaCommandState.phase, "halted");
  assert.equal(context.dspZeldaCommandState.reason, "command-during-render");
  assert.equal(context.dspZeldaCommandState.render.active, false);
  assert.equal(context.dspCurrentMail, null);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.deviceEvents.get("dspZeldaRenderSync"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaSilentFrame"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
  assert.deepEqual(producedMails(context), []);
});

test("Zelda frame-end task state fails closed on malformed and unsupported actions", () => {
  for (const [mail, reason] of [
    [5, "expected-task-mail"],
    [0xcdd10001, "unsupported-task-switch"],
    [0xcdd10004, "unsupported-task-mail"],
  ]) {
    const context = dspContext();
    completeOneZeldaFrame(context);
    const producedBefore = context.deviceEvents.get("dspMailProduced");

    sendDspMail(context, mail);

    assert.equal(context.dspZeldaCommandState.phase, "halted");
    assert.equal(context.dspZeldaCommandState.reason, reason);
    assert.equal(context.dspZeldaCommandState.render.active, false);
    assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, true);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(context.deviceEvents.get("dspMailProduced"), producedBefore);
    assert.equal(context.deviceEvents.get("dspZeldaCommandRejected"), 1);
  }
});

test("Zelda task actions distinguish halt, continue, and reset without fake resume mail", () => {
  {
    const context = dspContext();
    completeOneZeldaFrame(context);
    sendDspMail(context, 0xcdd10000);
    assert.equal(context.dspZeldaCommandState.phase, "halted");
    assert.equal(context.dspZeldaCommandState.rejected, false);
    assert.equal(context.dspZeldaCommandState.render.active, false);
    assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, false);
    assert.equal(context.deviceEvents.get("dspZeldaTaskHalt"), 1);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
  }

  {
    const context = dspContext();
    completeOneZeldaFrame(context);
    sendDspMail(context, 0xcdd10003);
    assert.equal(context.dspZeldaCommandState.phase, "waiting");
    assert.equal(context.dspZeldaCommandState.render.active, false);
    assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, false);
    assert.equal(context.deviceEvents.get("dspZeldaTaskContinue"), 1);
    assert.equal(context.dspCurrentMail, null);
    assert.equal(context.dspMailQueue.length, 0);
  }

  {
    const context = dspContext();
    completeOneZeldaFrame(context);
    sendDspMail(context, 0xcdd10002);
    assert.equal(context.dspMode, "rom");
    assert.equal(context.dspUcodeBooted, false);
    assert.equal(context.dspZeldaCommandState.phase, "waiting");
    assert.equal(context.dspZeldaCommandState.setup, null);
    assert.equal(context.dspZeldaCommandState.render.active, false);
    assert.equal(context.dspCurrentMail, 0x8071feed);
    assert.equal(context.dspMailQueue.length, 0);
    assert.equal(context.deviceEvents.get("dspReset"), 1);
  }
});

test("DSP reset discards Zelda setup and active render progress", () => {
  const context = dspContext();
  prepareZeldaRender(context);
  sendRenderGroup(context, 0);
  assert.equal(context.dspZeldaCommandState.render.currentVoice, 16);
  assert.equal(context.deviceEvents.get("dspZeldaRenderSync"), 1);
  assert.equal(context.dspCurrentMail, null);

  context.resetDspMailbox();

  assert.equal(context.dspMode, "rom");
  assert.equal(context.dspUcodeBooted, false);
  assert.equal(context.dspCurrentMail, 0x8071feed);
  assert.equal(context.dspMailQueue.length, 0);
  assert.equal(context.dspZeldaCommandState.phase, "waiting");
  assert.equal(context.dspZeldaCommandState.setup, null);
  assert.equal(context.dspZeldaCommandState.render.active, false);
  assert.equal(context.dspZeldaCommandState.render.awaitingTaskMail, false);
  assert.equal(context.dspZeldaCommandState.render.requestedFrames, 0);
  assert.equal(context.dspZeldaCommandState.render.currentFrame, 0);
  assert.equal(context.dspZeldaCommandState.render.currentVoice, 0);
  assert.equal(context.dspZeldaCommandState.render.clearedBytes, 0);
  assert.equal(context.deviceEvents.get("dspZeldaSilentFrame"), undefined);
  assert.equal(context.deviceEvents.get("dspZeldaRenderComplete"), undefined);
  assert.equal(context.deviceEvents.get("dspReset"), 1);
  assert.deepEqual(producedMails(context), [["0x8071feed", false]]);
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
  assert.match(
    source,
    /setup:\s*dspZeldaCommandState\.setup === null[\s\S]*voicesPerFrame:/,
  );
  assert.match(
    source,
    /render:\s*\{\s*active: dspZeldaCommandState\.render\.active,\s*awaitingTaskMail:/,
  );
  for (const event of [
    "dspZeldaSetup",
    "dspZeldaRenderCommand",
    "dspZeldaRenderSync",
    "dspZeldaSilentFrame",
    "dspZeldaRenderComplete",
    "dspZeldaTaskContinue",
  ]) {
    assert.match(source, new RegExp(`deviceEvents\\.set\\(\\s*"${event}"`));
  }
});
