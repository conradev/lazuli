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
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
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
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
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
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

const exiFunctions = [
  "hex32",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "writeProcessorInterfaceInterruptCause",
  "readExternalInterfaceTransferRegister",
  "writeExternalInterfaceTransferRegister",
  "writeExternalInterfaceParameter",
  "transitionExternalInterfaceChipSelect",
  "completeExternalInterfaceTransfer",
  "refreshExternalInterfaceInterruptLevel",
  "serviceExternalInterfaceInterrupt",
  "exiTransferModeName",
  "exiIplImageStatus",
  "updateExiSramChecksums",
  "createDefaultExiSram",
  "readExiRtcSeconds",
  "exiRtcSecondsAtCycle",
  "refreshExiRtc",
  "exiIplReadRegion",
  "recordExi0Transfer",
  "transferExi0IplImmediate",
  "serviceExi0",
  "serviceExternalInterface",
  "snapshotExternalInterface",
];

function syntheticIpl() {
  return new Uint8Array(2 * 1024 * 1024);
}

function makeContext(
  exiIplImage = syntheticIpl(),
  {
    rtcStartSeconds = 0,
    rtcCyclesPerSecond = 486_000_000,
  } = {},
) {
  const memory = new ArrayBuffer(0x24000);
  const raisedExceptions = [];
  const context = {
    Array,
    ArrayBuffer,
    Math,
    Number,
    Object,
    String,
    Uint8Array,
    bytes: new Uint8Array(memory),
    view: new DataView(memory),
    ram: 0x1000,
    ramSize: 0x10000,
    mmio: 0x12000,
    mmioSize: 0x10000,
    cpu: 0x23000,
    msrOffset: 0,
    physicalMmioBase: 0x0c000000,
    piExternalInterfaceInterruptCause: 0x00000010,
    exiDeviceInterruptMask: 0x00000001,
    exiDeviceInterrupt: 0x00000002,
    exiTransferInterruptMask: 0x00000004,
    exiTransferInterrupt: 0x00000008,
    exiClockMask: 0x00000070,
    exiDeviceSelectMask: 0x00000380,
    exiAttachInterruptMask: 0x00000400,
    exiAttachInterrupt: 0x00000800,
    exiDeviceConnected: 0x00001000,
    exiRomDisable: 0x00002000,
    exiDmaRegisterMask: 0x03ffffe0,
    exiTransferControlMask: 0x0000003f,
    exiSramBase: 0x00800000,
    exiSramBytes: 0x44,
    exiSramSettingsBase: 0x00800004,
    exiRtcStartSeconds: rtcStartSeconds >>> 0,
    exiRtcCyclesPerSecond: rtcCyclesPerSecond,
    deviceEvents: new Map(),
    exiIplImageBytes: 2 * 1024 * 1024,
    exiIplImage,
    exiIplSource: { kind: "synthetic-test" },
    exiSram: null,
    exiTransferTraceLimit: 64,
    exiTransferTrace: [],
    exiTransferOutcomes: new Map(),
    exiDmaOutcomes: new Map(),
    exiDmaReasons: new Map(),
    exiTransferSequence: 0,
    exiTransferTraceDropped: 0,
    exiDmaAttempts: 0,
    exiDmaCompletions: 0,
    exiDmaZeroLengthCompletions: 0,
    exiLastDma: null,
    exi0IplChipSelectActive: false,
    exi0IplCommandWord: 0,
    exi0IplCommandBytes: 0,
    exi0IplCommandWrite: null,
    exi0IplCommandAddress: null,
    exi0IplCursor: 0,
    exi0IplAddressSequence: null,
    exi0IplDmaBytes: 0,
    exi0RtcRefreshCount: 0,
    exi0RtcLastRefreshCycle: null,
    exi0RtcImmediateReadBytes: 0,
    exi0SramImmediateReadBytes: 0,
    exi0SramDmaReads: 0,
    exi0SramDmaBytes: 0,
    exiTransferCompletions: 0,
    exiTransferInterruptAcknowledgements: 0,
    exiInterruptLevelActive: false,
    exiInterruptLevelChanges: 0,
    exiInterruptLevelReason: null,
    exiPiAssertions: 0,
    exiPiDeassertions: 0,
    exiExternalInterruptDeliveries: 0,
    reservationInvalidations: [],
    invalidateDataReservationForExternalWrite(address, length) {
      context.reservationInvalidations.push({ address, length });
    },
    raiseException(registers, vector) {
      raisedExceptions.push({ registers, vector });
      const msr = context.view.getUint32(registers + context.msrOffset, true);
      context.view.setUint32(
        registers + context.msrOffset,
        msr & ~0x00008000,
        true,
      );
    },
    refreshCommandProcessorInterruptLevel() { return false; },
  };
  vm.createContext(context);
  vm.runInContext(
    exiFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.exi.js" },
  );
  context.exiSram = context.createDefaultExiSram();
  context.raisedExceptions = raisedExceptions;
  return context;
}

const exiParameterOffsets = [0x6800, 0x6814, 0x6828];
const exiControlOffsets = [0x680c, 0x6820, 0x6834];

function selectExi0Device(context, deviceSelect) {
  const parameterOffset = context.mmio + exiParameterOffsets[0];
  const parameter = context.view.getUint32(parameterOffset, false);
  const configurationMask = (
    context.exiDeviceInterruptMask
    | context.exiTransferInterruptMask
    | context.exiClockMask
    | context.exiDeviceSelectMask
    | context.exiAttachInterruptMask
    | context.exiRomDisable
  ) >>> 0;
  return context.writeExternalInterfaceParameter(
    0,
    (
      (parameter & configurationMask & ~context.exiDeviceSelectMask)
      | ((deviceSelect & 7) << 7)
    ) >>> 0,
  );
}

function selectIplDevice(context) {
  return selectExi0Device(context, 2);
}

function beginIplTransaction(context) {
  selectExi0Device(context, 0);
  selectIplDevice(context);
}

function immediateTransfer(
  context,
  {
    data,
    length,
    mode,
    cycle,
  },
) {
  assert.ok(length >= 1 && length <= 4);
  context.view.setUint32(context.mmio + 0x6810, data >>> 0, false);
  context.view.setUint32(
    context.mmio + 0x680c,
    (
      1
      | ((mode & 3) << 2)
      | ((length - 1) << 4)
    ) >>> 0,
    false,
  );
  assert.equal(context.serviceExi0(cycle), true);
  return context.view.getUint32(context.mmio + 0x6810, false);
}

function writeIplCommand(context, commandWord, cycle = 1) {
  beginIplTransaction(context);
  immediateTransfer(context, {
    data: commandWord >>> 0,
    length: 4,
    mode: 1,
    cycle,
  });
}

function writeIplAddress(context, sourceOffset, cycle = 1) {
  writeIplCommand(context, sourceOffset * 64, cycle);
}

function readIplDma(context, dmaBase, dmaLength, cycle = 2, mode = 0) {
  selectIplDevice(context);
  context.writeExternalInterfaceTransferRegister(0, 4, dmaBase);
  context.writeExternalInterfaceTransferRegister(0, 8, dmaLength);
  // TSTART, DMA, caller-selected transfer mode.
  context.writeExternalInterfaceTransferRegister(
    0,
    12,
    1 | 2 | (mode << 2),
  );
  assert.equal(context.serviceExi0(cycle), true);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("EXI transfer completion clears TSTART and leaves TCINT sticky until W1C", () => {
  const context = makeContext();

  for (let channel = 0; channel < 3; channel += 1) {
    const parameterOffset = context.mmio + exiParameterOffsets[channel];
    const controlOffset = context.mmio + exiControlOffsets[channel];
    const configuration = (
      context.exiTransferInterruptMask
      | ((channel + 1) << 7)
    ) >>> 0;
    context.view.setUint32(parameterOffset, configuration, false);
    context.view.setUint32(controlOffset, 0x35, false);

    assert.equal(context.completeExternalInterfaceTransfer(channel), true);
    assert.equal(context.view.getUint32(controlOffset, false), 0x34);
    assert.equal(
      context.view.getUint32(parameterOffset, false),
      configuration | context.exiTransferInterrupt,
    );

    assert.equal(context.completeExternalInterfaceTransfer(channel), false);
    assert.equal(
      context.view.getUint32(parameterOffset, false),
      configuration | context.exiTransferInterrupt,
    );

    context.view.setUint32(controlOffset, 0x03, false);
    assert.equal(context.completeExternalInterfaceTransfer(channel), true);
    assert.equal(context.view.getUint32(controlOffset, false), 0x02);
    assert.equal(
      context.view.getUint32(parameterOffset, false),
      configuration | context.exiTransferInterrupt,
    );

    assert.equal(
      context.writeExternalInterfaceParameter(
        channel,
        configuration | context.exiTransferInterrupt,
      ),
      configuration,
    );
    assert.equal(
      context.view.getUint32(parameterOffset, false),
      configuration,
    );
  }

  context.view.setUint32(
    context.mmio + exiParameterOffsets[0],
    0,
    false,
  );
  context.view.setUint32(
    context.mmio + exiControlOffsets[0],
    1,
    false,
  );
  assert.equal(context.completeExternalInterfaceTransfer(0), true);
  assert.equal(
    context.view.getUint32(
      context.mmio + exiParameterOffsets[0],
      false,
    ),
    context.exiTransferInterrupt,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false)
      & context.piExternalInterfaceInterruptCause,
    0,
  );

  assert.equal(context.exiTransferCompletions, 7);
  assert.equal(context.exiTransferInterruptAcknowledgements, 3);
  assert.throws(
    () => context.completeExternalInterfaceTransfer(3),
    /EXI channel must be 0, 1, or 2/,
  );
});

test("EXI CSR writes preserve read-only EXT and apply masks, config, and status W1C", () => {
  const context = makeContext();
  const parameterOffset = context.mmio + exiParameterOffsets[0];
  const status = (
    context.exiDeviceInterrupt
    | context.exiTransferInterrupt
    | context.exiAttachInterrupt
    | context.exiDeviceConnected
  ) >>> 0;
  context.view.setUint32(parameterOffset, status, false);

  const configuration = (
    context.exiDeviceInterruptMask
    | context.exiTransferInterruptMask
    | context.exiAttachInterruptMask
    | (5 << 4)
    | (3 << 7)
    | context.exiRomDisable
  ) >>> 0;
  const afterTransferAcknowledge = context.writeExternalInterfaceParameter(
    0,
    configuration | context.exiTransferInterrupt | 0xf0000000,
  );
  assert.equal(
    afterTransferAcknowledge,
    configuration
      | context.exiDeviceInterrupt
      | context.exiAttachInterrupt
      | context.exiDeviceConnected,
  );
  assert.equal(context.exiTransferInterruptAcknowledgements, 1);

  const afterRemainingAcknowledgements =
    context.writeExternalInterfaceParameter(
      0,
      configuration
        | context.exiDeviceInterrupt
        | context.exiAttachInterrupt,
    );
  assert.equal(
    afterRemainingAcknowledgements,
    configuration | context.exiDeviceConnected,
  );

  // EXT is a live read-only input: software cannot clear a present device or
  // synthesize one on a channel whose input is low.
  assert.equal(
    context.writeExternalInterfaceParameter(0, configuration),
    configuration | context.exiDeviceConnected,
  );
  assert.equal(
    context.writeExternalInterfaceParameter(
      1,
      context.exiDeviceConnected | context.exiRomDisable,
    ),
    0,
  );

  // Channel two has no attach interrupt or EXT input, and ROMDIS belongs only
  // to channel zero.
  context.view.setUint32(
    context.mmio + exiParameterOffsets[2],
    context.exiAttachInterrupt | context.exiDeviceConnected,
    false,
  );
  assert.equal(
    context.writeExternalInterfaceParameter(
      2,
      context.exiAttachInterruptMask | context.exiRomDisable,
    ),
    0,
  );
  assert.throws(
    () => context.writeExternalInterfaceParameter(-1, 0),
    /EXI channel must be 0, 1, or 2/,
  );
});

test("EXI0 immediate writes consume every TLEN MSB-first and bounded-complete", () => {
  const immediate = 0x11223344;
  for (let length = 1; length <= 4; length += 1) {
    const context = makeContext();
    beginIplTransaction(context);

    assert.equal(
      immediateTransfer(context, {
        data: immediate,
        length,
        mode: 1,
        cycle: 10 + length,
      }),
      immediate,
    );

    const expectedCommandWord = length === 4
      ? immediate
      : immediate >>> ((4 - length) * 8);
    assert.equal(context.exi0IplCommandWord, expectedCommandWord);
    assert.equal(context.exi0IplCommandBytes, length);
    assert.equal(
      context.view.getUint32(context.mmio + 0x680c, false) & 1,
      0,
    );
    assert.equal(
      context.view.getUint32(context.mmio + 0x6800, false)
        & context.exiTransferInterrupt,
      context.exiTransferInterrupt,
    );
    assert.equal(context.exiTransferCompletions, 1);

    const transfer = context.exiTransferTrace.at(-1);
    assert.equal(transfer.immediateLength, length);
    assert.equal(transfer.immediate, "0x11223344");
    assert.equal(transfer.immediateAfter, "0x11223344");
    assert.equal(transfer.commandBytesBefore, 0);
    assert.equal(transfer.commandBytesAfter, length);
    assert.equal(
      transfer.commandWordAfter,
      "0x" + expectedCommandWord.toString(16).padStart(8, "0"),
    );
    if (length < 4) {
      assert.equal(transfer.operation, "ipl-command-frame");
      assert.equal(transfer.outcome, "pending");
      assert.equal(transfer.reason, "ipl-command-incomplete");
    }
  }
});

test("EXI0 immediate reads fill high bytes, zero low bytes, and advance IPL cursor", () => {
  const image = syntheticIpl();
  const sourceOffset = 0x240;
  const payload = Uint8Array.from(
    { length: 16 },
    (_unused, index) => 0x40 + index,
  );
  image.set(payload, sourceOffset);
  const context = makeContext(image);
  writeIplAddress(context, sourceOffset, 1);

  let payloadOffset = 0;
  for (let length = 1; length <= 4; length += 1) {
    let expected = 0;
    for (let index = 0; index < length; index += 1) {
      expected |= payload[payloadOffset + index] << (24 - index * 8);
    }
    expected >>>= 0;

    assert.equal(
      immediateTransfer(context, {
        data: 0xdeadbeef,
        length,
        mode: 0,
        cycle: 20 + length,
      }),
      expected,
    );
    const transfer = context.exiTransferTrace.at(-1);
    assert.equal(transfer.transferMode, "read");
    assert.equal(transfer.immediateLength, length);
    assert.equal(
      transfer.immediateAfter,
      "0x" + expected.toString(16).padStart(8, "0"),
    );
    assert.equal(transfer.operation, "ipl-rom-read");
    assert.equal(transfer.outcome, "complete");
    assert.equal(transfer.reason, null);
    payloadOffset += length;
  }

  assert.equal(payloadOffset, 10);
  assert.equal(context.exi0IplCommandBytes, 4);
  assert.equal(context.exi0IplCommandAddress, sourceOffset);
  assert.equal(context.exi0IplCursor, sourceOffset + payloadOffset);
  assert.equal(context.exiTransferCompletions, 5);
});

test("EXI0 reads clock zero command bytes and return all ones during command framing", () => {
  const image = syntheticIpl();
  image[0] = 0x5a;
  const context = makeContext(image);
  beginIplTransaction(context);

  assert.equal(
    immediateTransfer(context, {
      data: 0xa5a5a5a5,
      length: 1,
      mode: 0,
      cycle: 1,
    }),
    0xff000000,
  );
  assert.equal(context.exi0IplCommandWord, 0);
  assert.equal(context.exi0IplCommandBytes, 1);
  assert.equal(context.exiTransferTrace.at(-1).reason, "ipl-command-incomplete");

  assert.equal(
    immediateTransfer(context, {
      data: 0x5a5a5a5a,
      length: 3,
      mode: 0,
      cycle: 2,
    }),
    0xffffff00,
  );
  assert.equal(context.exi0IplCommandWord, 0);
  assert.equal(context.exi0IplCommandBytes, 4);
  assert.equal(context.exi0IplCommandWrite, false);
  assert.equal(context.exi0IplCommandAddress, 0);
  assert.equal(context.exi0IplCursor, 0);
  assert.equal(context.exiTransferTrace.at(-1).operation, "ipl-address");

  assert.equal(
    immediateTransfer(context, {
      data: 0xffffffff,
      length: 1,
      mode: 0,
      cycle: 3,
    }),
    0x5a000000,
  );
  assert.equal(context.exi0IplCursor, 1);
});

test("EXI0 read-write is Dolphin's no-op and reserved mode preserves framing", () => {
  const context = makeContext();
  beginIplTransaction(context);
  immediateTransfer(context, {
    data: 0x12340000,
    length: 2,
    mode: 1,
    cycle: 1,
  });
  const framing = {
    commandWord: context.exi0IplCommandWord,
    commandBytes: context.exi0IplCommandBytes,
    commandAddress: context.exi0IplCommandAddress,
    cursor: context.exi0IplCursor,
  };

  assert.equal(
    immediateTransfer(context, {
      data: 0xaabbccdd,
      length: 3,
      mode: 2,
      cycle: 2,
    }),
    0xaabbccdd,
  );
  assert.deepEqual(
    {
      commandWord: context.exi0IplCommandWord,
      commandBytes: context.exi0IplCommandBytes,
      commandAddress: context.exi0IplCommandAddress,
      cursor: context.exi0IplCursor,
    },
    framing,
  );
  assert.equal(context.exiTransferTrace.at(-1).operation, "ipl-immediate-read-write");
  assert.equal(context.exiTransferTrace.at(-1).outcome, "ignored");
  assert.equal(context.exiTransferTrace.at(-1).reason, "ipl-read-write-no-op");

  assert.equal(
    immediateTransfer(context, {
      data: 0x55667788,
      length: 4,
      mode: 3,
      cycle: 3,
    }),
    0x55667788,
  );
  assert.deepEqual(
    {
      commandWord: context.exi0IplCommandWord,
      commandBytes: context.exi0IplCommandBytes,
      commandAddress: context.exi0IplCommandAddress,
      cursor: context.exi0IplCursor,
    },
    framing,
  );
  assert.equal(context.exiTransferTrace.at(-1).operation, "ipl-immediate-reserved");
  assert.equal(context.exiTransferTrace.at(-1).outcome, "rejected");
  assert.equal(context.exiTransferTrace.at(-1).reason, "reserved-transfer-mode");
  assert.equal(context.exiTransferCompletions, 3);
});

test("EXI0 chip-select edges reproduce Dolphin callback framing boundaries", () => {
  const context = makeContext();
  beginIplTransaction(context);
  immediateTransfer(context, {
    data: 0x12340000,
    length: 2,
    mode: 1,
    cycle: 1,
  });
  assert.equal(context.exi0IplChipSelectActive, true);
  assert.equal(context.exi0IplCommandWord, 0x1234);
  assert.equal(context.exi0IplCommandBytes, 2);

  // Same-CS writes have no edge and direct 2<->1 switches change two select
  // bits. Dolphin therefore sends neither transition to IPL's SetCS callback,
  // preserving the partial command even while dispatch becomes unsupported.
  selectIplDevice(context);
  assert.equal(context.exi0IplCommandWord, 0x1234);
  assert.equal(context.exi0IplCommandBytes, 2);
  selectExi0Device(context, 1);
  assert.equal(context.exi0IplChipSelectActive, false);
  assert.equal(context.exi0IplCommandWord, 0x1234);
  assert.equal(context.exi0IplCommandBytes, 2);
  selectIplDevice(context);
  assert.equal(context.exi0IplChipSelectActive, true);
  assert.equal(context.exi0IplCommandWord, 0x1234);
  assert.equal(context.exi0IplCommandBytes, 2);

  // A normal 2->0 deassert reaches IPL but does not reset its framing. The
  // following 0->2 assert invokes SetCS(2), which resets command and cursor.
  selectExi0Device(context, 0);
  assert.equal(context.exi0IplChipSelectActive, false);
  assert.equal(context.exi0IplCommandWord, 0x1234);
  assert.equal(context.exi0IplCommandBytes, 2);
  selectIplDevice(context);
  assert.equal(context.exi0IplChipSelectActive, true);
  assert.equal(context.exi0IplCommandWord, 0);
  assert.equal(context.exi0IplCommandBytes, 0);
  assert.equal(context.exi0IplCommandWrite, null);
  assert.equal(context.exi0IplCommandAddress, null);
  assert.equal(context.exi0IplCursor, 0);
  assert.equal(context.exi0IplAddressSequence, null);

  // The callback is selected by changed bits, not by either complete selector.
  // Thus 2->3 preserves IPL framing (changed=1), while 3->1 resets it through
  // IPL SetCS(1) (changed=2), even though neither endpoint selects IPL alone.
  const changedBits = makeContext();
  beginIplTransaction(changedBits);
  immediateTransfer(changedBits, {
    data: 0xab000000,
    length: 1,
    mode: 1,
    cycle: 2,
  });
  selectExi0Device(changedBits, 3);
  assert.equal(changedBits.exi0IplCommandWord, 0xab);
  assert.equal(changedBits.exi0IplCommandBytes, 1);
  selectExi0Device(changedBits, 1);
  assert.equal(changedBits.exi0IplChipSelectActive, false);
  assert.equal(changedBits.exi0IplCommandWord, 0);
  assert.equal(changedBits.exi0IplCommandBytes, 0);
});

test("EXI0 invalid or unsupported selections fail closed but still complete", () => {
  const selections = [
    { select: 0, reason: "no-device-selected" },
    { select: 1, reason: "unsupported-device-select" },
    { select: 4, reason: "unsupported-device-select" },
    { select: 3, reason: "multiple-device-select" },
    { select: 5, reason: "multiple-device-select" },
    { select: 6, reason: "multiple-device-select" },
    { select: 7, reason: "multiple-device-select" },
  ];
  for (const { select, reason } of selections) {
    const context = makeContext();
    selectExi0Device(context, select);
    assert.equal(
      immediateTransfer(context, {
        data: 0x89abcdef,
        length: 4,
        mode: 1,
        cycle: 100 + select,
      }),
      0x89abcdef,
    );

    const transfer = context.exiTransferTrace.at(-1);
    assert.equal(transfer.deviceSelect, select);
    assert.equal(transfer.operation, "unhandled");
    assert.equal(transfer.outcome, "rejected");
    assert.equal(transfer.reason, reason);
    assert.equal(transfer.commandBytesBefore, 0);
    assert.equal(transfer.commandBytesAfter, 0);
    assert.equal(context.exi0IplCommandWord, 0);
    assert.equal(context.exi0IplCommandBytes, 0);
    assert.equal(
      context.view.getUint32(context.mmio + 0x680c, false) & 1,
      0,
    );
    assert.equal(
      context.view.getUint32(context.mmio + 0x6800, false)
        & context.exiTransferInterrupt,
      context.exiTransferInterrupt,
    );
    assert.equal(context.exiTransferCompletions, 1);
  }
});

test("EXI interrupt aggregation covers all channels and preserves unrelated PI causes", () => {
  const context = makeContext();
  const unrelatedCause = 0x00010840;
  context.view.setUint32(context.mmio + 0x3000, unrelatedCause, false);

  const vectors = [
    context.exiDeviceInterruptMask | context.exiDeviceInterrupt,
    context.exiAttachInterruptMask | context.exiAttachInterrupt,
    context.exiTransferInterruptMask | context.exiTransferInterrupt,
  ];
  for (let channel = 0; channel < vectors.length; channel += 1) {
    for (let clear = 0; clear < 3; clear += 1) {
      context.view.setUint32(
        context.mmio + exiParameterOffsets[clear],
        clear === channel ? vectors[channel] : 0,
        false,
      );
    }
    assert.equal(
      context.refreshExternalInterfaceInterruptLevel("channel-" + channel),
      true,
    );
    assert.equal(
      context.view.getUint32(context.mmio + 0x3000, false),
      unrelatedCause | context.piExternalInterfaceInterruptCause,
    );

    context.view.setUint32(
      context.mmio + exiParameterOffsets[channel],
      vectors[channel] & ~(
        context.exiDeviceInterruptMask
        | context.exiTransferInterruptMask
        | context.exiAttachInterruptMask
      ),
      false,
    );
    assert.equal(
      context.refreshExternalInterfaceInterruptLevel(
        "channel-" + channel + "-unmasked",
      ),
      false,
    );
    assert.equal(
      context.view.getUint32(context.mmio + 0x3000, false),
      unrelatedCause,
    );
  }

  context.view.setUint32(
    context.mmio + exiParameterOffsets[2],
    context.exiAttachInterruptMask | context.exiAttachInterrupt,
    false,
  );
  assert.equal(
    context.refreshExternalInterfaceInterruptLevel("channel-2-no-attach"),
    false,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false),
    unrelatedCause,
  );
  assert.equal(context.exiPiAssertions, 3);
  assert.equal(context.exiPiDeassertions, 3);
  assert.equal(context.exiInterruptLevelChanges, 6);
});

test("EXI aggregation remains asserted until the last simultaneous source clears", () => {
  const context = makeContext();
  const unrelatedCause = 0x00010040;
  const vectors = [
    context.exiDeviceInterruptMask | context.exiDeviceInterrupt,
    context.exiAttachInterruptMask | context.exiAttachInterrupt,
    context.exiTransferInterruptMask | context.exiTransferInterrupt,
  ];
  context.view.setUint32(context.mmio + 0x3000, unrelatedCause, false);
  for (let channel = 0; channel < 3; channel += 1) {
    context.view.setUint32(
      context.mmio + exiParameterOffsets[channel],
      vectors[channel],
      false,
    );
  }
  assert.equal(context.refreshExternalInterfaceInterruptLevel("all-live"), true);

  for (let channel = 0; channel < 3; channel += 1) {
    context.writeExternalInterfaceParameter(channel, vectors[channel]);
    const final = channel === 2;
    assert.equal(context.exiInterruptLevelActive, !final);
    assert.equal(
      context.view.getUint32(context.mmio + 0x3000, false),
      unrelatedCause
        | (final ? 0 : context.piExternalInterfaceInterruptCause),
    );
  }
  assert.equal(context.exiPiAssertions, 1);
  assert.equal(context.exiPiDeassertions, 1);
  assert.equal(context.exiInterruptLevelChanges, 2);
});

test("EXI delivery requires its PI mask and MSR EE without consuming the level", () => {
  const context = makeContext();
  context.view.setUint32(
    context.mmio + exiParameterOffsets[0],
    context.exiTransferInterruptMask | context.exiTransferInterrupt,
    false,
  );
  context.view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);

  assert.equal(context.serviceExternalInterfaceInterrupt(100), false);
  assert.equal(context.raisedExceptions.length, 0);
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false)
      & context.piExternalInterfaceInterruptCause,
    context.piExternalInterfaceInterruptCause,
  );

  context.view.setUint32(
    context.mmio + 0x3004,
    context.piExternalInterfaceInterruptCause | 0x00000800,
    false,
  );
  context.view.setUint32(context.cpu + context.msrOffset, 0, true);
  assert.equal(context.serviceExternalInterfaceInterrupt(101), false);
  assert.equal(context.raisedExceptions.length, 0);

  context.view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);
  assert.equal(context.serviceExternalInterfaceInterrupt(102), true);
  assert.deepEqual(context.raisedExceptions[0], {
    registers: context.cpu,
    vector: 0x0500,
  });
  assert.equal(
    context.view.getUint32(context.cpu + context.msrOffset, true)
      & 0x00008000,
    0,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false)
      & context.piExternalInterfaceInterruptCause,
    context.piExternalInterfaceInterruptCause,
  );

  context.view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);
  assert.equal(context.serviceExternalInterfaceInterrupt(103), true);
  assert.equal(context.raisedExceptions.length, 2);
  assert.equal(context.exiExternalInterruptDeliveries, 2);
  assert.equal(context.deviceEvents.get("exiExternalInterrupt"), 2);
  assert.equal(context.deviceEvents.get("externalInterrupt"), 2);
});

test("EXI services all three completions before one aggregate delivery", () => {
  const context = makeContext();
  const deliverySnapshots = [];
  for (let channel = 0; channel < 3; channel += 1) {
    context.view.setUint32(
      context.mmio + exiParameterOffsets[channel],
      context.exiTransferInterruptMask,
      false,
    );
    context.view.setUint32(
      context.mmio + exiControlOffsets[channel],
      1,
      false,
    );
  }
  context.view.setUint32(
    context.mmio + 0x3004,
    context.piExternalInterfaceInterruptCause,
    false,
  );
  context.view.setUint32(context.cpu + context.msrOffset, 0x00008000, true);
  context.raiseException = (registers, vector) => {
    deliverySnapshots.push({
      registers,
      vector,
      controls: exiControlOffsets.map(offset =>
        context.view.getUint32(context.mmio + offset, false)
      ),
      parameters: exiParameterOffsets.map(offset =>
        context.view.getUint32(context.mmio + offset, false)
      ),
    });
    const msr = context.view.getUint32(registers + context.msrOffset, true);
    context.view.setUint32(
      registers + context.msrOffset,
      msr & ~0x00008000,
      true,
    );
  };

  context.serviceExternalInterface(200);

  assert.deepEqual(deliverySnapshots, [{
    registers: context.cpu,
    vector: 0x0500,
    controls: [0, 0, 0],
    parameters: [0x0c, 0x0c, 0x0c],
  }]);
  assert.equal(context.exiTransferCompletions, 3);
  assert.equal(context.deviceEvents.get("exiChannel0"), 1);
  assert.equal(context.deviceEvents.get("exiChannel1"), 1);
  assert.equal(context.deviceEvents.get("exiChannel2"), 1);
  assert.equal(context.deviceEvents.get("exiExternalInterrupt"), 1);
});

test("PI W1C composes live CP and EXI reassertion without touching other causes", () => {
  const context = makeContext();
  const unrelatedCause = 0x00010040;
  const commandProcessorCause = 0x00000800;
  let commandProcessorRefreshes = 0;
  context.refreshCommandProcessorInterruptLevel = reason => {
    assert.equal(reason, "pi-cause-w1c");
    commandProcessorRefreshes += 1;
    context.view.setUint32(
      context.mmio + 0x3000,
      context.view.getUint32(context.mmio + 0x3000, false)
        | commandProcessorCause,
      false,
    );
    return true;
  };
  const transferPair = (
    context.exiTransferInterruptMask | context.exiTransferInterrupt
  );
  context.view.setUint32(
    context.mmio + exiParameterOffsets[1],
    transferPair,
    false,
  );
  context.view.setUint32(
    context.mmio + 0x3000,
    unrelatedCause | commandProcessorCause,
    false,
  );
  assert.equal(context.refreshExternalInterfaceInterruptLevel("seed"), true);

  context.writeProcessorInterfaceInterruptCause(
    commandProcessorCause | context.piExternalInterfaceInterruptCause,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false),
    unrelatedCause
      | commandProcessorCause
      | context.piExternalInterfaceInterruptCause,
  );
  assert.equal(commandProcessorRefreshes, 1);
  assert.equal(context.exiInterruptLevelReason, "pi-cause-w1c");

  context.writeExternalInterfaceParameter(1, transferPair);
  assert.equal(context.exiInterruptLevelActive, false);
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false),
    unrelatedCause | commandProcessorCause,
  );
  context.writeProcessorInterfaceInterruptCause(
    context.piExternalInterfaceInterruptCause,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x3000, false),
    unrelatedCause | commandProcessorCause,
  );
  assert.equal(commandProcessorRefreshes, 2);
});

test("EXI CSR writes and service order cannot bypass completion or level refresh", () => {
  const writeInteger = extractFunction("writeInteger");
  assert.match(
    writeInteger,
    /const parameter = 0x0c006800 \+ channel \* 0x14;[\s\S]*?writeExternalInterfaceParameter\(channel, value\);[\s\S]*?return 1;/,
  );

  const writeParameter = extractFunction("writeExternalInterfaceParameter");
  const storeParameter = writeParameter.indexOf(
    "view.setUint32(mmio + parameterOffset, next, false);",
  );
  const transitionChipSelect = writeParameter.indexOf(
    "transitionExternalInterfaceChipSelect(",
    storeParameter,
  );
  const refreshAfterWrite = writeParameter.indexOf(
    "refreshExternalInterfaceInterruptLevel(",
    transitionChipSelect,
  );
  assert.ok(
    storeParameter !== -1
      && storeParameter < transitionChipSelect
      && transitionChipSelect < refreshAfterWrite,
  );

  const completion = extractFunction("completeExternalInterfaceTransfer");
  const clearStart = completion.indexOf(
    "view.setUint32(mmio + controlOffset, (control & ~1) >>> 0, false);",
  );
  const setTransferInterrupt = completion.indexOf(
    "| exiTransferInterrupt",
    clearStart,
  );
  const refreshLevel = completion.indexOf(
    "refreshExternalInterfaceInterruptLevel(",
    setTransferInterrupt,
  );
  assert.ok(
    clearStart !== -1
      && clearStart < setTransferInterrupt
      && setTransferInterrupt < refreshLevel,
  );

  const piWrite = extractFunction("writeProcessorInterfaceInterruptCause");
  const clearPiCause = piWrite.indexOf("view.setUint32(mmio + 0x3000");
  const refreshCp = piWrite.indexOf(
    'refreshCommandProcessorInterruptLevel("pi-cause-w1c")',
    clearPiCause,
  );
  const refreshExi = piWrite.indexOf(
    'refreshExternalInterfaceInterruptLevel("pi-cause-w1c")',
    clearPiCause,
  );
  assert.ok(
    clearPiCause !== -1
      && clearPiCause < refreshCp
      && clearPiCause < refreshExi,
  );

  const exi0 = extractFunction("serviceExi0");
  const frameImmediate = exi0.indexOf("transferExi0IplImmediate(");
  const publishImmediate = exi0.indexOf(
    "view.setUint32(mmio + 0x6810, immediateAfter, false);",
    frameImmediate,
  );
  const recordTransfer = exi0.indexOf(
    "recordExi0Transfer(",
    publishImmediate,
  );
  const completeTransfer = exi0.indexOf(
    "completeExternalInterfaceTransfer(0);",
    recordTransfer,
  );
  assert.ok(
    frameImmediate !== -1
      && frameImmediate < publishImmediate
      && publishImmediate < recordTransfer
      && recordTransfer < completeTransfer,
  );

  const service = extractFunction("serviceExternalInterface");
  const serviceExi0 = service.indexOf("serviceExi0(observedCycles);");
  const completeOtherChannels = service.indexOf(
    "completeExternalInterfaceTransfer(channel)",
    serviceExi0,
  );
  const deliver = service.indexOf(
    "serviceExternalInterfaceInterrupt(observedCycles);",
    completeOtherChannels,
  );
  assert.ok(
    serviceExi0 !== -1
      && serviceExi0 < completeOtherChannels
      && completeOtherChannels < deliver,
  );

  const mmioService = extractFunction("serviceMmio");
  assert.ok(
    mmioService.indexOf("serviceExternalInterface(observedCycles);")
      < mmioService.indexOf("serviceAudioInterface(observedCycles);"),
  );
});

test("EXI0 IPL address command orders and completes a bounded DMA read", () => {
  const image = syntheticIpl();
  // Exercise the Windows-1252 font window near the top of the 2 MiB IPL.
  // This proves command address bits 6..30 are retained instead of truncating
  // the protocol to the low 512 KiB.
  const sourceOffset = 0x1fcf00;
  const payload = Uint8Array.from(
    { length: 64 },
    (_unused, index) => (index * 17 + 3) & 0xff,
  );
  image.set(payload, sourceOffset);
  const context = makeContext(image);

  writeIplAddress(context, sourceOffset, 100);
  assert.equal(context.exi0IplCommandAddress, sourceOffset);
  assert.equal(context.exi0IplCursor, sourceOffset);
  assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);

  const dmaBase = 0x2400;
  readIplDma(context, dmaBase, payload.length, 120);

  assert.deepEqual(
    Array.from(
      context.bytes.subarray(
        context.ram + dmaBase,
        context.ram + dmaBase + payload.length,
      ),
    ),
    Array.from(payload),
  );
  assert.deepEqual(
    context.reservationInvalidations,
    [{ address: dmaBase, length: payload.length }],
  );
  assert.equal(context.exi0IplDmaBytes, payload.length);
  assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);

  const [address, dma] = context.exiTransferTrace;
  assert.equal(address.sequence, 1);
  assert.equal(address.operation, "ipl-address");
  assert.equal(address.outcome, "accepted");
  assert.equal(address.immediate, "0x07f3c000");
  assert.equal(address.commandDirection, "read");
  assert.equal(address.commandAddress, "0x001fcf00");
  assert.equal(address.iplCommandAddressAfter, "0x001fcf00");
  assert.equal(address.iplCursorAfter, "0x001fcf00");
  assert.equal(dma.sequence, 2);
  assert.equal(dma.operation, "ipl-dma-read");
  assert.equal(dma.outcome, "complete");
  assert.equal(dma.addressSequence, address.sequence);
  assert.equal(dma.iplCommandAddressBefore, "0x001fcf00");
  assert.equal(dma.iplCursorBefore, "0x001fcf00");
  assert.equal(dma.iplCursorAfter, "0x001fcf40");
  assert.equal(dma.dmaBase, "0x00002400");
  assert.equal(dma.dmaLength, payload.length);

  const snapshot = plain(context.snapshotExternalInterface());
  assert.deepEqual(snapshot.ipl, {
    configured: true,
    valid: true,
    byteLength: 2 * 1024 * 1024,
    expectedBytes: 2 * 1024 * 1024,
    source: { kind: "synthetic-test" },
    chipSelectActive: true,
    commandWord: "0x07f3c000",
    commandBytes: 4,
    commandDirection: "read",
    commandAddress: "0x001fcf00",
    cursor: "0x001fcf40",
    addressSequence: 1,
    dmaBytes: payload.length,
  });
  assert.deepEqual(snapshot.transfers.outcomes, {
    accepted: 1,
    complete: 1,
  });
});

test("EXI SRAM uses a deterministic checksum-valid settings template", () => {
  const context = makeContext();

  assert.equal(context.exiSram.byteLength, 0x44);
  assert.equal(
    Array.from(context.exiSram)
      .map(value => value.toString(16).padStart(2, "0"))
      .join(" "),
    "00 00 00 00 00 2c ff d0 00 00 00 00 00 00 00 00 "
      + "00 00 00 00 00 00 00 2c 44 4f 4c 50 48 49 4e 53 "
      + "4c 4f 54 41 44 4f 4c 50 48 49 4e 53 4c 4f 54 42 "
      + "00 00 00 00 00 00 00 00 00 00 00 00 00 00 6e 6d "
      + "00 00 00 00",
  );
  assert.equal(context.exiSram[0x17], 0x2c);
  assert.equal(
    String.fromCharCode(...context.exiSram.subarray(0x18, 0x24)),
    "DOLPHINSLOTA",
  );
  assert.equal(
    String.fromCharCode(...context.exiSram.subarray(0x24, 0x30)),
    "DOLPHINSLOTB",
  );
  assert.deepEqual(
    Array.from(context.exiSram.subarray(0x3e, 0x40)),
    [0x6e, 0x6d],
  );

  context.exiSram[0x17] = 0x6c;
  assert.deepEqual(
    plain(context.updateExiSramChecksums(context.exiSram)),
    { checksum: 0x006c, checksumInverse: 0xff90 },
  );
  assert.deepEqual(
    Array.from(context.exiSram.subarray(4, 8)),
    [0, 0x6c, 0xff, 0x90],
  );
});

test("EXI0 RTC follows libogc immediate reads and freezes at command latch", () => {
  const cyclesPerSecond = 486_000_000;
  const startSeconds = 0x01020304;
  const context = makeContext(null, { rtcStartSeconds: startSeconds });
  const settingsBefore = Array.from(context.exiSram.subarray(4));

  writeIplCommand(context, 0x20000000, cyclesPerSecond);
  const firstAddress = context.exiTransferTrace.at(-1);
  assert.equal(context.exi0IplCommandAddress, 0x00800000);
  assert.equal(context.exi0IplCursor, 0x00800000);
  assert.equal(context.exi0IplAddressSequence, firstAddress.sequence);
  assert.equal(firstAddress.operation, "rtc-address");
  assert.equal(firstAddress.outcome, "accepted");
  assert.equal(firstAddress.commandRegion, "rtc");
  assert.equal(firstAddress.sourceKind, "rtc");
  assert.equal(firstAddress.sourceConfigured, true);
  assert.equal(firstAddress.rtcRefreshed, true);
  assert.equal(firstAddress.rtcSeconds, 0x01020305);

  // The data transfer can happen several emulated seconds later; Dolphin
  // exposes the RTC snapshot taken when the fourth command byte latched.
  assert.equal(
    immediateTransfer(context, {
      data: 0xdeadbeef,
      length: 4,
      mode: 0,
      cycle: cyclesPerSecond * 3,
    }),
    0x01020305,
  );
  assert.equal(context.exi0IplCursor, 0x00800004);
  assert.equal(context.exi0RtcImmediateReadBytes, 4);
  const firstRead = context.exiTransferTrace.at(-1);
  assert.equal(firstRead.operation, "rtc-read");
  assert.equal(firstRead.outcome, "complete");
  assert.equal(firstRead.commandRegion, "rtc");
  assert.equal(firstRead.sourceKind, "rtc");
  assert.equal(firstRead.sourceConfigured, true);
  assert.equal(firstRead.rtcRefreshed, false);
  assert.equal(firstRead.rtcSeconds, null);

  // Two commands latched within one emulated second return the same value.
  writeIplCommand(context, 0x20000000, cyclesPerSecond + 123);
  assert.equal(
    immediateTransfer(context, {
      data: 0,
      length: 4,
      mode: 0,
      cycle: cyclesPerSecond * 4,
    }),
    0x01020305,
  );

  assert.deepEqual(Array.from(context.exiSram.subarray(4)), settingsBefore);
  const snapshot = plain(context.snapshotExternalInterface());
  assert.deepEqual(
    {
      rtcModeled: snapshot.sram.rtcModeled,
      rtcStartSeconds: snapshot.sram.rtcStartSeconds,
      rtcCurrentSeconds: snapshot.sram.rtcCurrentSeconds,
      rtcCyclesPerSecond: snapshot.sram.rtcCyclesPerSecond,
      rtcRefreshCount: snapshot.sram.rtcRefreshCount,
      rtcLastRefreshCycle: snapshot.sram.rtcLastRefreshCycle,
      rtcImmediateReadBytes: snapshot.sram.rtcImmediateReadBytes,
    },
    {
      rtcModeled: true,
      rtcStartSeconds: 0x01020304,
      rtcCurrentSeconds: 0x01020305,
      rtcCyclesPerSecond: cyclesPerSecond,
      rtcRefreshCount: 2,
      rtcLastRefreshCycle: cyclesPerSecond + 123,
      rtcImmediateReadBytes: 8,
    },
  );
});

test("EXI0 RTC uses exact emulated-second boundaries and wraps u32", () => {
  const cyclesPerSecond = 486_000_000;
  const context = makeContext(null, { rtcStartSeconds: 0x01020304 });

  writeIplCommand(context, 0x20000000, cyclesPerSecond - 1);
  assert.equal(context.readExiRtcSeconds(), 0x01020304);
  writeIplCommand(context, 0x20000000, cyclesPerSecond);
  assert.equal(context.readExiRtcSeconds(), 0x01020305);
  writeIplCommand(context, 0x20000000, cyclesPerSecond * 2 + 123);
  assert.equal(context.readExiRtcSeconds(), 0x01020306);
  assert.deepEqual(Array.from(context.exiSram.subarray(0, 4)), [1, 2, 3, 6]);

  const wrapped = makeContext(null, { rtcStartSeconds: 0xffffffff });
  writeIplCommand(wrapped, 0x20000000, cyclesPerSecond);
  assert.equal(wrapped.readExiRtcSeconds(), 0);

  const split = makeContext(null, { rtcStartSeconds: 0x01020304 });
  beginIplTransaction(split);
  immediateTransfer(split, {
    data: 0x20000000,
    length: 3,
    mode: 1,
    cycle: cyclesPerSecond - 1,
  });
  assert.equal(split.exi0RtcRefreshCount, 0);
  immediateTransfer(split, {
    data: 0,
    length: 1,
    mode: 1,
    cycle: cyclesPerSecond,
  });
  assert.equal(split.readExiRtcSeconds(), 0x01020305);
  assert.equal(split.exi0RtcRefreshCount, 1);
  assert.equal(split.exi0RtcLastRefreshCycle, cyclesPerSecond);

  assert.throws(
    () => split.exiRtcSecondsAtCycle(-1),
    /non-negative safe integer/,
  );
  assert.throws(
    () => split.exiRtcSecondsAtCycle(1.5),
    /non-negative safe integer/,
  );
});

test("EXI0 refreshes RTC for every complete command but never for partial framing", () => {
  const context = makeContext();
  const settingsBefore = Array.from(context.exiSram.subarray(4));

  writeIplAddress(context, 0x100, 1);
  writeIplCommand(context, 0x20000100, 2);
  writeIplCommand(context, 0xa0010000, 3);
  assert.equal(context.exi0RtcRefreshCount, 3);
  assert.equal(context.exi0RtcLastRefreshCycle, 3);
  assert.deepEqual(
    context.exiTransferTrace.map(entry => entry.rtcRefreshed),
    [true, true, true],
  );
  assert.deepEqual(
    context.exiTransferTrace.map(entry => entry.rtcSeconds),
    [0, 0, 0],
  );
  assert.deepEqual(Array.from(context.exiSram.subarray(4)), settingsBefore);

  beginIplTransaction(context);
  immediateTransfer(context, {
    data: 0x20000000,
    length: 3,
    mode: 1,
    cycle: 4,
  });
  assert.equal(context.exi0RtcRefreshCount, 3);
  assert.equal(context.exiTransferTrace.at(-1).rtcRefreshed, false);
  const rtcBeforeReset = context.readExiRtcSeconds();

  // A new CS assertion discards the partial command but leaves RTC state.
  beginIplTransaction(context);
  assert.equal(context.exi0IplCommandBytes, 0);
  assert.equal(context.exi0RtcRefreshCount, 3);
  assert.equal(context.readExiRtcSeconds(), rtcBeforeReset);
});

test("EXI0 RTC bounds and immediate-only DMA policy are atomic", () => {
  const startSeconds = 0x010203a7;
  const lastByte = makeContext(null, { rtcStartSeconds: startSeconds });
  writeIplCommand(lastByte, 0x200000c0, 0);
  assert.equal(lastByte.exi0IplCommandAddress, 0x00800003);
  assert.equal(
    immediateTransfer(lastByte, {
      data: 0,
      length: 1,
      mode: 0,
      cycle: 1,
    }),
    0xa7000000,
  );
  assert.equal(lastByte.exi0IplCursor, 0x00800004);
  assert.equal(lastByte.exi0RtcImmediateReadBytes, 1);

  const immediateOverflow = makeContext(
    null,
    { rtcStartSeconds: startSeconds },
  );
  writeIplCommand(immediateOverflow, 0x200000c0, 0);
  assert.equal(
    immediateTransfer(immediateOverflow, {
      data: 0x12345678,
      length: 2,
      mode: 0,
      cycle: 1,
    }),
    0x12345678,
  );
  assert.equal(immediateOverflow.exi0IplCursor, 0x00800003);
  assert.equal(immediateOverflow.exi0RtcImmediateReadBytes, 0);
  assert.equal(
    immediateOverflow.exiTransferTrace.at(-1).reason,
    "rtc-source-out-of-bounds",
  );

  const dma = makeContext(null, { rtcStartSeconds: startSeconds });
  const dmaBase = 0x2400;
  dma.bytes.fill(0x5a, dma.ram + dmaBase, dma.ram + dmaBase + 32);
  writeIplCommand(dma, 0x20000000, 0);
  const dmaCursor = dma.exi0IplCursor;
  readIplDma(dma, dmaBase, 32, 1);
  assert.equal(dma.exiTransferTrace.at(-1).operation, "rtc-dma-read");
  assert.equal(dma.exiTransferTrace.at(-1).outcome, "rejected");
  assert.equal(dma.exiTransferTrace.at(-1).reason, "rtc-immediate-only");
  assert.equal(dma.exiTransferTrace.at(-1).sourceKind, "rtc");
  assert.equal(dma.exiTransferTrace.at(-1).sourceConfigured, true);
  assert.equal(dma.exi0IplCursor, dmaCursor);
  assert.deepEqual(
    Array.from(dma.bytes.subarray(dma.ram + dmaBase, dma.ram + dmaBase + 32)),
    Array(32).fill(0x5a),
  );
  assert.deepEqual(dma.reservationInvalidations, []);

  const zero = makeContext(null, { rtcStartSeconds: startSeconds });
  writeIplCommand(zero, 0x20000000, 0);
  const zeroCursor = zero.exi0IplCursor;
  readIplDma(zero, 0xffffffff, 31, 1);
  assert.equal(zero.exiTransferTrace.at(-1).operation, "rtc-dma-read");
  assert.equal(zero.exiTransferTrace.at(-1).outcome, "complete");
  assert.equal(zero.exiTransferTrace.at(-1).reason, null);
  assert.equal(zero.exiTransferTrace.at(-1).dmaLength, 0);
  assert.equal(zero.exi0IplCursor, zeroCursor);
  assert.deepEqual(zero.reservationInvalidations, []);
});

test("EXI0 SRAM settings command completes WarioWare's exact DMA read", () => {
  const context = makeContext(null);
  const dmaBase = 0x2400;
  context.bytes.fill(
    0xa5,
    context.ram + dmaBase - 1,
    context.ram + dmaBase + 65,
  );

  writeIplCommand(context, 0x20000100, 100);
  assert.equal(context.exi0IplCommandAddress, 0x00800004);
  assert.equal(context.exi0IplCursor, 0x00800004);
  assert.equal(context.exi0IplAddressSequence, 1);

  readIplDma(context, dmaBase, 64, 120);

  assert.equal(context.bytes[context.ram + dmaBase - 1], 0xa5);
  assert.equal(context.bytes[context.ram + dmaBase + 64], 0xa5);
  assert.deepEqual(
    Array.from(
      context.bytes.subarray(
        context.ram + dmaBase,
        context.ram + dmaBase + 64,
      ),
    ),
    Array.from(context.exiSram.subarray(4)),
  );
  assert.deepEqual(
    context.reservationInvalidations,
    [{ address: dmaBase, length: 64 }],
  );
  assert.equal(context.exi0IplCursor, 0x00800044);
  assert.equal(context.exi0SramDmaReads, 1);
  assert.equal(context.exi0SramDmaBytes, 64);
  assert.equal(context.exi0IplDmaBytes, 0);

  const [address, dma] = context.exiTransferTrace;
  assert.equal(address.operation, "sram-address");
  assert.equal(address.outcome, "accepted");
  assert.equal(address.commandRegion, "sram");
  assert.equal(address.sourceKind, "sram");
  assert.equal(address.sourceConfigured, true);
  assert.equal(address.commandAddress, "0x00800004");
  assert.equal(dma.operation, "sram-dma-read");
  assert.equal(dma.outcome, "complete");
  assert.equal(dma.commandRegion, "sram");
  assert.equal(dma.sourceKind, "sram");
  assert.equal(dma.sourceConfigured, true);
  assert.equal(dma.addressSequence, address.sequence);
  assert.equal(dma.iplCursorBefore, "0x00800004");
  assert.equal(dma.iplCursorAfter, "0x00800044");

  const snapshot = plain(context.snapshotExternalInterface());
  assert.deepEqual(snapshot.sram, {
    base: "0x00800000",
    byteLength: 68,
    rtcModeled: true,
    rtcStartSeconds: 0,
    rtcCurrentSeconds: 0,
    rtcCyclesPerSecond: 486_000_000,
    rtcRefreshCount: 1,
    rtcLastRefreshCycle: 100,
    rtcImmediateReadBytes: 0,
    settingsBase: "0x00800004",
    settingsByteLength: 64,
    checksum: 0x002c,
    checksumInverse: 0xffd0,
    flags: 0x2c,
    immediateReadBytes: 0,
    dmaReads: 1,
    dmaBytes: 64,
  });
  assert.equal(snapshot.transfers.dma.attempts, 1);
  assert.equal(snapshot.transfers.dma.completions, 1);
  assert.equal(snapshot.transfers.dma.last.operation, "sram-dma-read");
});

test("EXI0 SRAM and RTC reads keep separate bounded regions", () => {
  const immediate = makeContext();
  writeIplCommand(immediate, 0x20000100, 1);
  assert.equal(
    immediateTransfer(immediate, {
      data: 0,
      length: 4,
      mode: 0,
      cycle: 2,
    }),
    0x002cffd0,
  );
  assert.equal(immediate.exi0SramImmediateReadBytes, 4);
  assert.equal(immediate.exiTransferTrace.at(-1).operation, "sram-read");

  const lastByte = makeContext();
  lastByte.exiSram[0x43] = 0xa7;
  writeIplCommand(lastByte, 0x200010c0, 1);
  assert.equal(
    immediateTransfer(lastByte, {
      data: 0,
      length: 1,
      mode: 0,
      cycle: 2,
    }),
    0xa7000000,
  );
  assert.equal(lastByte.exi0IplCursor, 0x00800044);

  const immediateOverflow = makeContext();
  immediateOverflow.exiSram[0x43] = 0xa7;
  writeIplCommand(immediateOverflow, 0x200010c0, 1);
  assert.equal(
    immediateTransfer(immediateOverflow, {
      data: 0x12345678,
      length: 2,
      mode: 0,
      cycle: 2,
    }),
    0x12345678,
  );
  assert.equal(immediateOverflow.exi0IplCursor, 0x00800043);
  assert.equal(immediateOverflow.exi0SramImmediateReadBytes, 0);
  assert.equal(
    immediateOverflow.exiTransferTrace.at(-1).reason,
    "sram-source-out-of-bounds",
  );

  const rtc = makeContext();
  writeIplCommand(rtc, 0x20000000, 1);
  assert.equal(rtc.exi0IplCommandAddress, 0x00800000);
  assert.equal(rtc.exi0IplAddressSequence, 1);
  assert.equal(rtc.exiTransferTrace.at(-1).operation, "rtc-address");
  assert.equal(rtc.exiTransferTrace.at(-1).outcome, "accepted");
  assert.equal(rtc.exiTransferTrace.at(-1).reason, null);
  assert.equal(
    immediateTransfer(rtc, {
      data: 0xffffffff,
      length: 4,
      mode: 0,
      cycle: 2,
    }),
    0,
  );
  assert.equal(rtc.exi0RtcImmediateReadBytes, 4);

  const exactEnd = makeContext();
  writeIplCommand(exactEnd, 0x20001100, 1);
  assert.equal(exactEnd.exi0IplCommandAddress, 0x00800044);
  assert.equal(exactEnd.exi0IplAddressSequence, null);
  assert.equal(exactEnd.exiTransferTrace.at(-1).operation, "unhandled");
  readIplDma(exactEnd, 0x2800, 32, 2);
  assert.equal(
    exactEnd.exiTransferTrace.at(-1).reason,
    "exi-dma-without-readable-address-command",
  );

  const offset32 = makeContext(null);
  writeIplCommand(offset32, 0x20000900, 1);
  readIplDma(offset32, 0x2c00, 32, 2);
  assert.deepEqual(
    Array.from(
      offset32.bytes.subarray(
        offset32.ram + 0x2c00,
        offset32.ram + 0x2c20,
      ),
    ),
    Array.from(offset32.exiSram.subarray(0x24)),
  );
  assert.equal(offset32.exi0IplCursor, 0x00800044);

  const overflow = makeContext();
  const dmaBase = 0x3000;
  overflow.bytes.fill(
    0x5a,
    overflow.ram + dmaBase,
    overflow.ram + dmaBase + 64,
  );
  // Address 0x800005 leaves only 63 modeled settings bytes.
  writeIplCommand(overflow, 0x20000140, 1);
  readIplDma(overflow, dmaBase, 64, 2);
  assert.equal(
    overflow.exiTransferTrace.at(-1).reason,
    "sram-source-out-of-bounds",
  );
  assert.deepEqual(
    Array.from(
      overflow.bytes.subarray(
        overflow.ram + dmaBase,
        overflow.ram + dmaBase + 64,
      ),
    ),
    Array(64).fill(0x5a),
  );
  assert.deepEqual(overflow.reservationInvalidations, []);
  assert.equal(overflow.exi0IplCursor, 0x00800005);
  assert.equal(overflow.exi0IplAddressSequence, 1);
  assert.equal(overflow.exi0SramDmaReads, 0);
  assert.equal(overflow.exi0SramDmaBytes, 0);
});

test("EXI0 SRAM immediate and DMA reads share one bounded cursor", () => {
  const context = makeContext(null);
  writeIplCommand(context, 0x20000100, 10);

  assert.equal(
    immediateTransfer(context, {
      data: 0,
      length: 4,
      mode: 0,
      cycle: 20,
    }),
    0x002cffd0,
  );
  readIplDma(context, 0x3400, 32, 30);

  assert.deepEqual(
    Array.from(
      context.bytes.subarray(
        context.ram + 0x3400,
        context.ram + 0x3420,
      ),
    ),
    Array.from(context.exiSram.subarray(8, 40)),
  );
  assert.equal(context.exi0IplCursor, 0x00800028);
  assert.equal(context.exi0SramImmediateReadBytes, 4);
  assert.equal(context.exi0SramDmaReads, 1);
  assert.equal(context.exi0SramDmaBytes, 32);
});

test("EXI0 SRAM zero DMA and writes preserve source state", () => {
  const zero = makeContext(null);
  writeIplCommand(zero, 0x20000100, 10);
  const cursor = zero.exi0IplCursor;
  readIplDma(zero, 0xffffffff, 31, 20);
  assert.equal(zero.exiTransferTrace.at(-1).outcome, "complete");
  assert.equal(zero.exiTransferTrace.at(-1).dmaLength, 0);
  assert.equal(zero.exi0IplCursor, cursor);
  assert.equal(zero.exi0SramDmaReads, 0);
  assert.equal(zero.exi0SramDmaBytes, 0);
  assert.deepEqual(zero.reservationInvalidations, []);
  assert.equal(
    plain(zero.snapshotExternalInterface()).transfers.dma
      .zeroLengthCompletions,
    1,
  );

  const write = makeContext(null);
  const before = Array.from(write.exiSram);
  writeIplCommand(write, 0xa0000100, 10);
  immediateTransfer(write, {
    data: 0x12345678,
    length: 4,
    mode: 1,
    cycle: 20,
  });
  assert.equal(write.exiTransferTrace[0].operation, "unhandled");
  assert.equal(write.exiTransferTrace[1].operation, "unhandled");
  assert.equal(write.exi0IplAddressSequence, null);
  assert.deepEqual(Array.from(write.exiSram), before);
});

test("EXI transfer registers expose only hardware bits on every channel", () => {
  const context = makeContext();

  for (let channel = 0; channel < 3; channel += 1) {
    for (const registerOffset of [4, 8]) {
      assert.equal(
        context.writeExternalInterfaceTransferRegister(
          channel,
          registerOffset,
          0xffffffff,
        ),
        context.exiDmaRegisterMask,
      );
      assert.equal(
        context.view.getUint32(
          context.mmio + 0x6800 + channel * 0x14 + registerOffset,
          false,
        ),
        context.exiDmaRegisterMask,
      );
      assert.equal(
        context.readExternalInterfaceTransferRegister(
          channel,
          registerOffset,
        ),
        context.exiDmaRegisterMask,
      );
    }
    assert.equal(
      context.writeExternalInterfaceTransferRegister(
        channel,
        12,
        0xffffffff,
      ),
      context.exiTransferControlMask,
    );
    assert.equal(
      context.view.getUint32(
        context.mmio + 0x680c + channel * 0x14,
        false,
      ),
      context.exiTransferControlMask,
    );
    assert.equal(
      context.readExternalInterfaceTransferRegister(channel, 12),
      context.exiTransferControlMask,
    );
  }

  assert.throws(
    () => context.writeExternalInterfaceTransferRegister(3, 4, 0),
    /EXI channel must be 0, 1, or 2/,
  );
  assert.throws(
    () => context.writeExternalInterfaceTransferRegister(0, 16, 0),
    /EXI transfer register offset must be 4, 8, or 12/,
  );
  assert.throws(
    () => context.readExternalInterfaceTransferRegister(-1, 4),
    /EXI channel must be 0, 1, or 2/,
  );

  const writeInteger = extractFunction("writeInteger");
  assert.match(
    writeInteger,
    /writeExternalInterfaceTransferRegister\(\s*channel,\s*registerOffset,\s*value\s*\)/,
  );
  assert.match(
    writeInteger,
    /external-interface-transfer-register-rejected/,
  );
  const readInteger = extractFunction("readInteger");
  assert.match(
    readInteger,
    /readExternalInterfaceTransferRegister\(\s*channel,\s*registerOffset\s*\)/,
  );
  assert.match(
    readInteger,
    /external-interface-transfer-register-rejected/,
  );
});

test("EXI0 DMA aligns registers and completes a zero-byte read", () => {
  const image = syntheticIpl();
  const sourceOffset = 0x1aff00;
  image.set(
    Uint8Array.from({ length: 64 }, (_unused, index) => index + 1),
    sourceOffset,
  );
  const context = makeContext(image);

  writeIplAddress(context, sourceOffset, 10);
  readIplDma(context, 0xfc00241f, 63, 20);

  assert.equal(
    context.view.getUint32(context.mmio + 0x6804, false),
    0x2400,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6808, false),
    32,
  );
  assert.deepEqual(
    Array.from(
      context.bytes.subarray(context.ram + 0x2400, context.ram + 0x2420),
    ),
    Array.from(image.subarray(sourceOffset, sourceOffset + 32)),
  );
  assert.equal(context.exi0IplCursor, sourceOffset + 32);

  readIplDma(context, 0xffffffff, 31, 30);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6804, false),
    context.exiDmaRegisterMask,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6808, false),
    0,
  );
  assert.equal(context.exiTransferTrace.at(-1).outcome, "complete");
  assert.equal(context.exi0IplCursor, sourceOffset + 32);
  assert.equal(context.exi0IplDmaBytes, 32);
  assert.deepEqual(
    context.reservationInvalidations,
    [{ address: 0x2400, length: 32 }],
  );
  assert.equal(context.view.getUint32(context.mmio + 0x680c, false), 2);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6800, false)
      & context.exiTransferInterrupt,
    context.exiTransferInterrupt,
  );
  const dma = plain(context.snapshotExternalInterface()).transfers.dma;
  assert.equal(dma.attempts, 2);
  assert.equal(dma.completions, 2);
  assert.equal(dma.zeroLengthCompletions, 1);
  assert.deepEqual(dma.outcomes, { complete: 2 });
  assert.deepEqual(dma.reasons, {});
  assert.equal(dma.last.dmaBase, "0x03ffffe0");
  assert.equal(dma.last.dmaLength, 0);
  assert.equal(dma.last.outcome, "complete");
});

test("EXI0 IPL cursor advances across consecutive DMA reads", () => {
  const image = syntheticIpl();
  const sourceOffset = 0x1aff00;
  image.set(
    Uint8Array.from(
      { length: 64 },
      (_unused, index) => (index + 0x40) & 0xff,
    ),
    sourceOffset,
  );
  const context = makeContext(image);

  writeIplAddress(context, sourceOffset, 10);
  readIplDma(context, 0x2000, 32, 20);
  readIplDma(context, 0x2040, 32, 30);

  assert.deepEqual(
    Array.from(
      context.bytes.subarray(context.ram + 0x2000, context.ram + 0x2020),
    ),
    Array.from(image.subarray(sourceOffset, sourceOffset + 32)),
  );
  assert.deepEqual(
    Array.from(
      context.bytes.subarray(context.ram + 0x2040, context.ram + 0x2060),
    ),
    Array.from(image.subarray(sourceOffset + 32, sourceOffset + 64)),
  );
  const firstDma = context.exiTransferTrace[1];
  const secondDma = context.exiTransferTrace[2];
  assert.equal(firstDma.addressSequence, 1);
  assert.equal(secondDma.addressSequence, 1);
  assert.equal(firstDma.iplCursorBefore, "0x001aff00");
  assert.equal(firstDma.iplCursorAfter, "0x001aff20");
  assert.equal(secondDma.iplCursorBefore, "0x001aff20");
  assert.equal(secondDma.iplCursorAfter, "0x001aff40");
  assert.equal(context.exi0IplCommandAddress, sourceOffset);
  assert.equal(context.exi0IplCursor, sourceOffset + 64);
  assert.equal(context.exi0IplDmaBytes, 64);
});

test("EXI0 DMA honors exact bounds and rejects overflows atomically", () => {
  const image = syntheticIpl();
  const exactSource = image.byteLength - 64;
  const exactTarget = 0x10000 - 64;
  const payload = Uint8Array.from(
    { length: 64 },
    (_unused, index) => (index * 29 + 7) & 0xff,
  );
  image.set(payload, exactSource);
  const exact = makeContext(image);

  writeIplAddress(exact, exactSource);
  readIplDma(exact, exactTarget, 64);
  assert.deepEqual(
    Array.from(
      exact.bytes.subarray(
        exact.ram + exactTarget,
        exact.ram + exactTarget + payload.length,
      ),
    ),
    Array.from(payload),
  );
  assert.equal(exact.exi0IplCursor, image.byteLength);
  assert.equal(exact.exi0IplDmaBytes, 64);
  assert.deepEqual(
    exact.reservationInvalidations,
    [{ address: exactTarget, length: 64 }],
  );

  const sourceOverflow = makeContext(image);
  const guardedTarget = 0x2000;
  sourceOverflow.bytes.fill(
    0xa5,
    sourceOverflow.ram + guardedTarget,
    sourceOverflow.ram + guardedTarget + 96,
  );
  writeIplAddress(sourceOverflow, exactSource);
  const sourceAddressSequence = sourceOverflow.exi0IplAddressSequence;
  readIplDma(sourceOverflow, guardedTarget, 96);
  assert.equal(
    sourceOverflow.exiTransferTrace.at(-1).reason,
    "ipl-source-out-of-bounds",
  );
  assert.deepEqual(
    Array.from(
      sourceOverflow.bytes.subarray(
        sourceOverflow.ram + guardedTarget,
        sourceOverflow.ram + guardedTarget + 96,
      ),
    ),
    Array(96).fill(0xa5),
  );
  assert.equal(sourceOverflow.exi0IplCursor, exactSource);
  assert.equal(
    sourceOverflow.exi0IplAddressSequence,
    sourceAddressSequence,
  );
  assert.equal(sourceOverflow.exi0IplDmaBytes, 0);
  assert.deepEqual(sourceOverflow.reservationInvalidations, []);

  const targetOverflow = makeContext(image);
  const targetStart = targetOverflow.ramSize - 32;
  targetOverflow.bytes.fill(
    0x5a,
    targetOverflow.ram + targetStart,
    targetOverflow.ram + targetStart + 64,
  );
  writeIplAddress(targetOverflow, 0x3000);
  const targetAddressSequence = targetOverflow.exi0IplAddressSequence;
  readIplDma(targetOverflow, targetStart, 64);
  assert.equal(
    targetOverflow.exiTransferTrace.at(-1).reason,
    "ram-target-out-of-bounds",
  );
  assert.deepEqual(
    Array.from(
      targetOverflow.bytes.subarray(
        targetOverflow.ram + targetStart,
        targetOverflow.ram + targetStart + 64,
      ),
    ),
    Array(64).fill(0x5a),
  );
  assert.equal(targetOverflow.exi0IplCursor, 0x3000);
  assert.equal(
    targetOverflow.exi0IplAddressSequence,
    targetAddressSequence,
  );
  assert.equal(targetOverflow.exi0IplDmaBytes, 0);
  assert.deepEqual(targetOverflow.reservationInvalidations, []);
});

test("EXI0 IPL DMA reports an absent local image without mutating RAM", () => {
  const context = makeContext(null);
  writeIplAddress(context, 0x1aff00);
  const dmaBase = 0x3000;
  context.bytes.fill(0xa5, context.ram + dmaBase, context.ram + dmaBase + 32);

  readIplDma(context, dmaBase, 32);

  assert.deepEqual(
    Array.from(
      context.bytes.subarray(
        context.ram + dmaBase,
        context.ram + dmaBase + 32,
      ),
    ),
    Array(32).fill(0xa5),
  );
  assert.equal(context.exiTransferTrace.at(-1).outcome, "unavailable");
  assert.equal(
    context.exiTransferTrace.at(-1).reason,
    "ipl-image-not-configured",
  );
  assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);
  assert.equal(
    context.view.getUint32(context.mmio + 0x6800, false)
      & context.exiTransferInterrupt,
    context.exiTransferInterrupt,
  );
});

test("EXI0 IPL DMA rejects wrong modes and source or RAM range overflow", () => {
  const sourceOverflow = makeContext();
  writeIplAddress(sourceOverflow, sourceOverflow.exiIplImageBytes - 16);
  readIplDma(sourceOverflow, 0x2000, 32);
  assert.equal(
    sourceOverflow.exiTransferTrace.at(-1).reason,
    "ipl-source-out-of-bounds",
  );

  const targetOverflow = makeContext();
  writeIplAddress(targetOverflow, 0x3000);
  readIplDma(targetOverflow, targetOverflow.ramSize, 32);
  assert.equal(
    targetOverflow.exiTransferTrace.at(-1).reason,
    "ram-target-out-of-bounds",
  );

  const wrongMode = makeContext();
  writeIplAddress(wrongMode, 0x3000);
  readIplDma(wrongMode, 0x2000, 32, 2, 1);
  assert.equal(
    wrongMode.exiTransferTrace.at(-1).reason,
    "exi-dma-requires-read",
  );

  const wrongImageSize = makeContext(new Uint8Array(128));
  writeIplAddress(wrongImageSize, 0);
  readIplDma(wrongImageSize, 0x2000, 32);
  assert.equal(
    wrongImageSize.exiTransferTrace.at(-1).reason,
    "invalid-ipl-image",
  );

  const missingAddressCommand = makeContext();
  readIplDma(missingAddressCommand, 0x2000, 32);
  assert.equal(
    missingAddressCommand.exiTransferTrace.at(-1).reason,
    "exi-dma-without-readable-address-command",
  );

  const rtcDma = makeContext();
  writeIplAddress(rtcDma, 0x3000);
  beginIplTransaction(rtcDma);
  immediateTransfer(rtcDma, {
    data: 0x20000000,
    length: 4,
    mode: 1,
    cycle: 2,
  });
  assert.equal(rtcDma.exi0IplAddressSequence, 2);
  readIplDma(rtcDma, 0x2000, 32, 3);
  assert.equal(
    rtcDma.exiTransferTrace.at(-1).reason,
    "rtc-immediate-only",
  );

  for (const context of [
    sourceOverflow,
    targetOverflow,
    wrongMode,
    wrongImageSize,
    missingAddressCommand,
    rtcDma,
  ]) {
    assert.equal(context.exiTransferTrace.at(-1).outcome, "rejected");
    assert.equal(context.reservationInvalidations.length, 0);
    assert.equal(context.exi0IplDmaBytes, 0);
    assert.equal(context.view.getUint32(context.mmio + 0x680c, false) & 1, 0);
    assert.equal(
      context.view.getUint32(context.mmio + 0x6800, false)
        & context.exiTransferInterrupt,
      context.exiTransferInterrupt,
    );
  }
});

test("EXI0 transfer diagnostics retain only the newest bounded window", () => {
  const context = makeContext();
  for (let index = 0; index < 70; index += 1) {
    writeIplAddress(context, index, index);
  }

  assert.equal(context.exiTransferSequence, 70);
  assert.equal(context.exiTransferTrace.length, 64);
  assert.equal(context.exiTransferTraceDropped, 6);
  assert.equal(context.exiTransferTrace[0].sequence, 7);
  assert.equal(context.exiTransferTrace.at(-1).sequence, 70);
  assert.equal(context.exiTransferOutcomes.get("accepted"), 70);
  assert.equal(context.deviceEvents.get("exiChannel0"), 70);
});

test("EXI1 and EXI2 retain the previous bounded no-device completion", () => {
  const context = makeContext();
  context.view.setUint32(context.mmio + 0x6820, 0x80000001, false);
  context.view.setUint32(context.mmio + 0x6834, 0x40000001, false);

  context.serviceExternalInterface(10);

  assert.equal(
    context.view.getUint32(context.mmio + 0x6820, false),
    0,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6834, false),
    0,
  );
  assert.equal(context.deviceEvents.get("exiChannel1"), 1);
  assert.equal(context.deviceEvents.get("exiChannel2"), 1);
  assert.equal(context.exiTransferSequence, 0);
});
