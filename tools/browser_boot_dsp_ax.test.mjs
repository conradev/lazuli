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
  "emptyDspAxCommandState",
  "emptyDspZeldaRenderState",
  "emptyDspZeldaCommandState",
  "dspUcodeHashEctor",
  "classifyDspUcode",
  "traceDsp",
  "latchDspFirstUnsupported",
  "snapshotDspFirstUnsupported",
  "loadNextDspMail",
  "pushDspMail",
  "consumeDspMail",
  "resetDspMailbox",
  "rejectDspAxCommand",
  "dspAxCommandArity",
  "dspAxAddress",
  "dspAxParseFailure",
  "dspAxSilentWriteRange",
  "collectDspAxSilentWrites",
  "parseDspAxCommandLists",
  "applyDspAxSilentWrites",
  "beginDspAxCommandList",
  "executeDspAxCommandList",
  "handleDspAxMail",
  "handleDspCpuMail",
  "serviceDsp",
];

const axHashFixture = Uint8Array.from([
  178, 0, 5, 1, 6, 4, 2, 5, 0, 0, 0, 0,
]);

function dspContext() {
  const memory = new ArrayBuffer(0x30000);
  const ram = 0x1000;
  const ramSize = 0x18000;
  const invalidations = [];
  const context = {
    aiInterruptDelivered: false,
    aramTransfer: null,
    bytes: new Uint8Array(memory),
    cpu: 0x28000,
    cycles: 10_000,
    deviceEvents: new Map(),
    dspAudioDmaRemainingBlocks: 0,
    dspCpuMailbox: 0,
    dspCurrentMail: null,
    dspFirstUnsupported: null,
    dspMailQueue: [],
    dspMode: "ax",
    dspRomParameter: null,
    dspScheduledMail: null,
    dspTrace: [],
    dspUcodeBooted: true,
    dspUcodeHash: 0x4e8a8b21,
    invalidations,
    invalidateDataReservationForExternalWrite(physical, size) {
      invalidations.push([physical, size]);
    },
    mmio: 0x20000,
    msrOffset: 0,
    nextDspAudioDmaCycle: null,
    nextDspAudioDmaInterruptCycle: null,
    pc: 0x80001000,
    raiseException() {},
    ram,
    ramPointer(address, size) {
      const logical = address >>> 0;
      const physical = logical < ramSize
        ? logical
        : logical >= 0x80000000 && logical < 0x80000000 + ramSize
          ? logical - 0x80000000
          : logical >= 0xc0000000 && logical < 0xc0000000 + ramSize
            ? logical - 0xc0000000
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
    serviceAramDma() {},
    serviceDspAudioDma() {},
    view: new DataView(memory),
  };
  vm.createContext(context);
  vm.runInContext(
    dspFunctionNames.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.dsp-ax.js" },
  );
  context.dspUcodeUpload = context.emptyDspUcodeUpload();
  context.dspAxCommandState = context.emptyDspAxCommandState();
  context.dspZeldaCommandState = context.emptyDspZeldaCommandState();
  return context;
}

function splitAddress(address) {
  const value = address >>> 0;
  return [value >>> 16, value & 0xffff];
}

function writeWords(context, address, words) {
  const pointer = context.ramPointer(address, words.length * 2);
  assert.notEqual(pointer, null, "command fixture must map into guest RAM");
  for (let index = 0; index < words.length; index += 1) {
    context.view.setUint16(pointer + index * 2, words[index], false);
  }
}

function sendAxList(context, address, words) {
  writeWords(context, address, words);
  context.handleDspCpuMail((0xbabe0000 | words.length) >>> 0);
  context.handleDspCpuMail(address);
}

function ramBytes(context, address, size) {
  const pointer = context.ramPointer(address, size);
  assert.notEqual(pointer, null, "fixture range must map into guest RAM");
  return context.bytes.subarray(pointer, pointer + size);
}

function seedGuardedRange(context, address, size) {
  ramBytes(context, address, size).fill(0xa5);
  ramBytes(context, address - 1, 1)[0] = 0x7d;
  ramBytes(context, address + size, 1)[0] = 0x7e;
}

function assertClearedGuardedRange(context, address, size) {
  assert.ok(ramBytes(context, address, size).every(value => value === 0));
  assert.equal(ramBytes(context, address - 1, 1)[0], 0x7d);
  assert.equal(ramBytes(context, address + size, 1)[0], 0x7e);
}

function simpleEndList() {
  return [0x000f];
}

test("Monkey Ball's Dolphin fixture selects AX and pins every GC command arity", () => {
  const context = dspContext();
  assert.equal(context.dspUcodeHashEctor(axHashFixture), 0x4e8a8b21);
  assert.equal(context.classifyDspUcode(0x4e8a8b21), "ax");
  assert.deepEqual(
    Array.from({ length: 0x14 }, (_unused, command) =>
      context.dspAxCommandArity(command)),
    [2, 5, 2, 0, 4, 4, 2, 2, 10, 2, 0, 0, 0, 3, 4, 0, 4, 2, 4, 12],
  );
  assert.equal(context.dspAxCommandArity(0x14), null);

  const newerAx = dspContext();
  newerAx.dspUcodeHash = 0x3ad3b7ac;
  sendAxList(newerAx, 0x80000100, [
    0x0012,
    0x4000,
    0x0005,
    0x0000,
    0x3000,
    0x000f,
  ]);
  assert.equal(newerAx.dspAxCommandState.rejected, false);
  assert.equal(newerAx.dspAxCommandState.commandCount, 2);
});

test("AX validates a full silent list before bounded writeback and delayed yield", () => {
  const context = dspContext();
  const listAddress = 0x80000100;
  const ranges = [
    [0x00002000, 1920],
    [0x00003000, 1920],
    [0x00004000, 640],
    [0x00005000, 640],
    [0x00006000, 1280],
    [0x00007000, 1920],
    [0x00008000, 640],
  ];
  for (const [address, size] of ranges) {
    seedGuardedRange(context, address, size);
  }

  const words = [
    0x0004, ...splitAddress(ranges[0][0]), 0x0000, 0x9000,
    0x0006, ...splitAddress(ranges[1][0]),
    0x000e,
    ...splitAddress(ranges[2][0]),
    ...splitAddress(ranges[3][0]),
    0x0010,
    ...splitAddress(ranges[4][0]),
    0x0000, 0x9800,
    0x0013,
    ...splitAddress(ranges[5][0]),
    ...splitAddress(ranges[6][0]),
    0x0000, 0xa000,
    0x0000, 0xa400,
    0x0000, 0xa800,
    0x0000, 0xac00,
    0x000f,
  ];
  writeWords(context, listAddress, words);

  context.handleDspCpuMail((0xbabe0000 | words.length) >>> 0);
  assert.equal(context.dspAxCommandState.phase, "waiting-address");
  assert.equal(context.dspScheduledMail, null);
  assert.ok(ranges.every(([address, size]) =>
    ramBytes(context, address, size).every(value => value === 0xa5)));

  context.handleDspCpuMail(listAddress);
  assert.equal(context.dspAxCommandState.phase, "yield-pending");
  assert.deepEqual(
    { ...context.dspScheduledMail },
    { mail: 0xdcd10002, completionCycle: 12_500 },
  );
  assert.equal(context.dspAxCommandState.listCount, 1);
  assert.equal(context.dspAxCommandState.wordCount, words.length);
  assert.equal(context.dspAxCommandState.commandCount, 6);
  assert.equal(context.dspAxCommandState.writeCount, 7);
  assert.equal(context.dspAxCommandState.clearedBytes, 8960);
  assert.equal(context.deviceEvents.get("dspAxCommandList"), 1);
  assert.equal(context.deviceEvents.get("dspAxCommand"), 6);
  assert.equal(context.deviceEvents.get("dspAxSilentWrite"), 7);
  assert.equal(context.deviceEvents.get("dspAxSilentBytes"), 8960);
  assert.equal(context.invalidations.length, 7);
  assert.equal(context.dspFirstUnsupported, null);
  for (const [address, size] of ranges) {
    assertClearedGuardedRange(context, address, size);
  }

  context.serviceDsp(12_499);
  assert.equal(context.dspCurrentMail, null);
  context.serviceDsp(12_500);
  assert.equal(context.dspCurrentMail, 0xdcd10002);
  assert.equal(context.dspAxCommandState.phase, "yield-pending");
  assert.equal(context.dspScheduledMail, null);
  assert.equal(context.deviceEvents.get("dspScheduledReply"), 1);
  context.consumeDspMail();
  assert.equal(context.dspAxCommandState.phase, "task-wait");
  assert.equal(context.deviceEvents.get("dspAxYieldConsumed"), 1);
});

test("physical, cached, and uncached AX list/output aliases share exact RAM", () => {
  for (const alias of [0x00000000, 0x80000000, 0xc0000000]) {
    const context = dspContext();
    const listAddress = (alias + 0x0100) >>> 0;
    const surroundAddress = (alias + 0x3000) >>> 0;
    const lrAddress = (alias + 0x4000) >>> 0;
    seedGuardedRange(context, 0x3000, 640);
    seedGuardedRange(context, 0x4000, 640);
    const words = [
      0x000e,
      ...splitAddress(surroundAddress),
      ...splitAddress(lrAddress),
      0x000f,
    ];

    sendAxList(context, listAddress, words);
    assert.equal(context.dspAxCommandState.rejected, false);
    assertClearedGuardedRange(context, 0x3000, 640);
    assertClearedGuardedRange(context, 0x4000, 640);
    assert.deepEqual(
      context.invalidations,
      [[0x3000, 640], [0x4000, 640]],
    );
  }
});

test("CMD_MORE follows a bounded list chain and rejects physical alias cycles", () => {
  const context = dspContext();
  const firstAddress = 0x80000100;
  const secondAddress = 0xc0000200;
  const outputAddress = 0x80003000;
  const second = [0x0006, ...splitAddress(outputAddress), 0x000f];
  const first = [
    0x000d,
    ...splitAddress(secondAddress),
    second.length,
  ];
  seedGuardedRange(context, 0x3000, 1920);
  writeWords(context, firstAddress, first);
  writeWords(context, secondAddress, second);
  context.handleDspCpuMail((0xbabe0000 | first.length) >>> 0);
  context.handleDspCpuMail(firstAddress);

  assert.equal(context.dspAxCommandState.listCount, 2);
  assert.equal(context.dspAxCommandState.wordCount, first.length + second.length);
  assert.deepEqual(
    Array.from(context.dspAxCommandState.commandSample),
    [0x0d, 0x06, 0x0f],
  );
  assertClearedGuardedRange(context, 0x3000, 1920);

  const cycle = dspContext();
  writeWords(cycle, firstAddress, first);
  writeWords(cycle, secondAddress, [
    0x000d,
    ...splitAddress(0xc0000100),
    first.length,
  ]);
  cycle.handleDspCpuMail((0xbabe0000 | first.length) >>> 0);
  cycle.handleDspCpuMail(firstAddress);
  assert.equal(cycle.dspAxCommandState.phase, "halted");
  assert.equal(cycle.dspAxCommandState.reason, "list-cycle");
  assert.equal(cycle.dspScheduledMail, null);
  assert.equal(cycle.invalidations.length, 0);
});

test("CMD_MORE enforces both list-count and aggregate-word ceilings", () => {
  const listLimited = dspContext();
  const base = 0x1000;
  for (let index = 0; index < 33; index += 1) {
    const address = base + index * 0x20;
    const next = base + (index + 1) * 0x20;
    writeWords(listLimited, address, [
      0x000d,
      ...splitAddress(next),
      4,
    ]);
  }
  listLimited.handleDspCpuMail(0xbabe0004);
  listLimited.handleDspCpuMail(base);
  assert.equal(listLimited.dspAxCommandState.reason, "list-limit");
  assert.equal(listLimited.dspScheduledMail, null);

  const wordLimited = dspContext();
  const largeWords = 511;
  const stride = 0x400;
  for (let index = 0; index < 17; index += 1) {
    const address = 0x1000 + index * stride;
    const next = 0x1000 + (index + 1) * stride;
    const words = new Array(largeWords).fill(0x000a);
    words.splice(0, 4, 0x000d, ...splitAddress(next), largeWords);
    writeWords(wordLimited, address, words);
  }
  wordLimited.handleDspCpuMail((0xbabe0000 | largeWords) >>> 0);
  wordLimited.handleDspCpuMail(0x1000);
  assert.equal(wordLimited.dspAxCommandState.reason, "word-limit");
  assert.equal(wordLimited.dspScheduledMail, null);
});

test("malformed AX envelopes and lists fail closed without partial writes", () => {
  const missingEnvelope = dspContext();
  missingEnvelope.handleDspCpuMail(0x12345678);
  assert.equal(
    missingEnvelope.dspAxCommandState.reason,
    "expected-list-size",
  );
  assert.equal(missingEnvelope.dspScheduledMail, null);

  for (const size of [0, 512]) {
    const context = dspContext();
    context.handleDspCpuMail((0xbabe0000 | size) >>> 0);
    assert.equal(context.dspAxCommandState.reason, "invalid-list-size");
    assert.equal(context.dspScheduledMail, null);
  }

  const cases = [
    {
      name: "out of bounds",
      words: [0x000f],
      address: 0x80017fff,
      reason: "list-out-of-bounds",
    },
    {
      name: "truncated",
      words: [0x000e, 0x0000, 0x2000],
      reason: "truncated-command",
    },
    {
      name: "missing end",
      words: [0x000a],
      reason: "missing-end",
    },
    {
      name: "unknown command",
      words: [0x0014],
      reason: "unknown-command",
    },
    {
      name: "4e8 compressor",
      words: [0x0012, 0, 0, 0, 0, 0x000f],
      reason: "unsupported-command-for-ucode",
    },
    {
      name: "write out of bounds",
      words: [
        0x0006,
        ...splitAddress(0x80017f00),
        0x000f,
      ],
      reason: "write-out-of-bounds",
    },
  ];

  for (const fixture of cases) {
    const context = dspContext();
    const address = fixture.address ?? 0x80000100;
    if (fixture.name === "out of bounds") {
      context.handleDspCpuMail((0xbabe0000 | fixture.words.length) >>> 0);
      context.handleDspCpuMail(address);
    } else {
      sendAxList(context, address, fixture.words);
    }
    assert.equal(
      context.dspAxCommandState.reason,
      fixture.reason,
      fixture.name,
    );
    assert.equal(context.dspAxCommandState.phase, "halted", fixture.name);
    assert.equal(context.dspScheduledMail, null, fixture.name);
    assert.equal(context.invalidations.length, 0, fixture.name);
    const commandCode = fixture.reason === "unknown-command"
      ? 0x14
      : fixture.reason === "unsupported-command-for-ucode"
        ? 0x12
        : null;
    assert.deepEqual(
      { ...context.dspFirstUnsupported },
      {
        instructionCycle: 10_000,
        dispatchPc: 0x80001000,
        stage: commandCode === null ? "protocol" : "command",
        mode: "ax",
        reason: fixture.reason,
        ucodeHash: 0x4e8a8b21,
        code: commandCode,
      },
      fixture.name,
    );
  }

  const transactional = dspContext();
  const outputAddress = 0x3000;
  seedGuardedRange(transactional, outputAddress, 1920);
  sendAxList(transactional, 0x80000100, [
    0x0006,
    ...splitAddress(outputAddress),
    0x0014,
  ]);
  assert.equal(transactional.dspAxCommandState.reason, "unknown-command");
  assert.ok(
    ramBytes(transactional, outputAddress, 1920)
      .every(value => value === 0xa5),
  );
  assert.equal(transactional.invalidations.length, 0);
});

test("AX task cadence distinguishes continue, resume, reset, and deferred switching", () => {
  const continued = dspContext();
  sendAxList(continued, 0x80000100, simpleEndList());
  continued.serviceDsp(12_500);
  continued.consumeDspMail();
  continued.handleDspCpuMail(0xdead0003);
  assert.equal(continued.dspAxCommandState.phase, "waiting-size");
  assert.equal(continued.dspAxCommandState.lastTaskMail, 0xdead0003);
  assert.equal(continued.dspCurrentMail, null);
  assert.equal(continued.deviceEvents.get("dspAxTaskContinue"), 1);
  assert.equal(
    continued.dspTrace.find(entry => entry.event === "ax-task-continue")
      ?.canonicalMail,
    "0xcdd10003",
  );

  const resumed = dspContext();
  sendAxList(resumed, 0x80000100, simpleEndList());
  resumed.serviceDsp(12_500);
  resumed.consumeDspMail();
  resumed.handleDspCpuMail(0x00000000);
  assert.equal(resumed.dspAxCommandState.phase, "waiting-size");
  assert.equal(resumed.dspCurrentMail, 0xdcd10001);
  assert.equal(resumed.deviceEvents.get("dspAxTaskResume"), 1);
  assert.equal(
    resumed.dspTrace.find(entry => entry.source === "ax-task-resume")?.mail,
    "0xdcd10001",
  );

  const reset = dspContext();
  sendAxList(reset, 0x80000100, simpleEndList());
  reset.serviceDsp(12_500);
  reset.consumeDspMail();
  reset.handleDspCpuMail(0xbeef0002);
  assert.equal(reset.dspMode, "rom");
  assert.equal(reset.dspUcodeBooted, false);
  assert.equal(reset.dspAxCommandState.phase, "waiting-size");
  assert.equal(reset.dspCurrentMail, 0x8071feed);

  const switched = dspContext();
  sendAxList(switched, 0x80000100, simpleEndList());
  switched.serviceDsp(12_500);
  switched.consumeDspMail();
  switched.handleDspCpuMail(0x12340001);
  assert.equal(switched.dspAxCommandState.phase, "halted");
  assert.equal(switched.dspAxCommandState.reason, "unsupported-task-switch");
  assert.equal(switched.dspScheduledMail, null);
  assert.deepEqual(
    { ...switched.dspFirstUnsupported },
    {
      instructionCycle: 10_000,
      dispatchPc: 0x80001000,
      stage: "task",
      mode: "ax",
      reason: "unsupported-task-switch",
      ucodeHash: 0x4e8a8b21,
      code: 1,
    },
  );
  const firstUnsupported = { ...switched.dspFirstUnsupported };
  switched.cycles = 20_000;
  switched.pc = 0x80002000;
  switched.rejectDspAxCommand("later-protocol-rejection");
  switched.resetDspMailbox();
  assert.deepEqual(
    { ...switched.dspFirstUnsupported },
    firstUnsupported,
  );

  const unsupported = dspContext();
  sendAxList(unsupported, 0x80000100, simpleEndList());
  unsupported.serviceDsp(12_500);
  unsupported.consumeDspMail();
  unsupported.handleDspCpuMail(0x12340004);
  assert.deepEqual(
    { ...unsupported.dspFirstUnsupported },
    {
      instructionCycle: 10_000,
      dispatchPc: 0x80001000,
      stage: "task",
      mode: "ax",
      reason: "unsupported-task-mail",
      ucodeHash: 0x4e8a8b21,
      code: 4,
    },
  );
  assert.deepEqual(
    Object.keys(unsupported.dspFirstUnsupported),
    [
      "instructionCycle",
      "dispatchPc",
      "stage",
      "mode",
      "reason",
      "ucodeHash",
      "code",
    ],
  );
});

test("AX rejects task actions until the delayed yield has been consumed", () => {
  const beforeEmission = dspContext();
  sendAxList(beforeEmission, 0x80000100, simpleEndList());
  assert.equal(beforeEmission.dspAxCommandState.phase, "yield-pending");
  beforeEmission.handleDspCpuMail(0xcdd10003);
  assert.equal(beforeEmission.dspAxCommandState.phase, "halted");
  assert.equal(
    beforeEmission.dspAxCommandState.reason,
    "task-before-yield-consumed",
  );
  assert.equal(beforeEmission.dspScheduledMail, null);
  assert.deepEqual(
    { ...beforeEmission.dspFirstUnsupported },
    {
      instructionCycle: 10_000,
      dispatchPc: 0x80001000,
      stage: "protocol",
      mode: "ax",
      reason: "task-before-yield-consumed",
      ucodeHash: 0x4e8a8b21,
      code: null,
    },
  );
  beforeEmission.serviceDsp(20_000);
  assert.equal(beforeEmission.dspCurrentMail, null);

  const beforeConsumption = dspContext();
  sendAxList(beforeConsumption, 0x80000100, simpleEndList());
  beforeConsumption.serviceDsp(12_500);
  assert.equal(beforeConsumption.dspCurrentMail, 0xdcd10002);
  beforeConsumption.handleDspCpuMail(0xabcd0003);
  assert.equal(beforeConsumption.dspAxCommandState.phase, "halted");
  assert.equal(
    beforeConsumption.dspAxCommandState.reason,
    "task-before-yield-consumed",
  );
  beforeConsumption.consumeDspMail();
  assert.equal(beforeConsumption.dspAxCommandState.phase, "halted");
});

test("release diagnostics retain bounded AX command state", () => {
  assert.match(source, /dspAxCommand: \{/);
  assert.match(
    source,
    /dspFirstUnsupported: snapshotDspFirstUnsupported\(\)/,
  );
  for (const field of [
    "phase",
    "sizeWords",
    "listCount",
    "wordCount",
    "commandCount",
    "commandSample",
    "writeCount",
    "clearedBytes",
    "rejected",
    "reason",
    "lastTaskMail",
  ]) {
    assert.match(
      source,
      new RegExp(`${field}:\\s*dspAxCommandState\\.${field}`),
    );
  }
});
