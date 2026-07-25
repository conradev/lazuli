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
  "writeExternalInterfaceParameter",
  "transitionExternalInterfaceChipSelect",
  "completeExternalInterfaceTransfer",
  "refreshExternalInterfaceInterruptLevel",
  "serviceExternalInterfaceInterrupt",
  "exiTransferModeName",
  "exiIplImageStatus",
  "recordExi0Transfer",
  "transferExi0IplImmediate",
  "serviceExi0",
  "serviceExternalInterface",
  "snapshotExternalInterface",
];

function syntheticIpl() {
  return new Uint8Array(2 * 1024 * 1024);
}

function makeContext(exiIplImage = syntheticIpl()) {
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
    deviceEvents: new Map(),
    exiIplImageBytes: 2 * 1024 * 1024,
    exiIplImage,
    exiIplSource: { kind: "synthetic-test" },
    exiTransferTraceLimit: 64,
    exiTransferTrace: [],
    exiTransferOutcomes: new Map(),
    exiTransferSequence: 0,
    exiTransferTraceDropped: 0,
    exi0IplChipSelectActive: false,
    exi0IplCommandWord: 0,
    exi0IplCommandBytes: 0,
    exi0IplCommandWrite: null,
    exi0IplCommandAddress: null,
    exi0IplCursor: 0,
    exi0IplAddressSequence: null,
    exi0IplDmaBytes: 0,
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

function writeIplAddress(context, sourceOffset, cycle = 1) {
  beginIplTransaction(context);
  immediateTransfer(context, {
    data: (sourceOffset * 64) >>> 0,
    length: 4,
    mode: 1,
    cycle,
  });
}

function readIplDma(context, dmaBase, dmaLength, cycle = 2, mode = 0) {
  selectIplDevice(context);
  context.view.setUint32(context.mmio + 0x6804, dmaBase, false);
  context.view.setUint32(context.mmio + 0x6808, dmaLength, false);
  // TSTART, DMA, caller-selected transfer mode.
  context.view.setUint32(
    context.mmio + 0x680c,
    1 | 2 | (mode << 2),
    false,
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
  readIplDma(targetOverflow, targetOverflow.ramSize - 16, 32);
  assert.equal(
    targetOverflow.exiTransferTrace.at(-1).reason,
    "ram-target-out-of-bounds",
  );

  const wrongMode = makeContext();
  writeIplAddress(wrongMode, 0x3000);
  readIplDma(wrongMode, 0x2000, 32, 2, 1);
  assert.equal(
    wrongMode.exiTransferTrace.at(-1).reason,
    "ipl-dma-requires-read",
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
    "ipl-dma-without-address-command",
  );

  const staleAddressAfterRtc = makeContext();
  writeIplAddress(staleAddressAfterRtc, 0x3000);
  beginIplTransaction(staleAddressAfterRtc);
  immediateTransfer(staleAddressAfterRtc, {
    data: 0x20000000,
    length: 4,
    mode: 1,
    cycle: 2,
  });
  assert.equal(staleAddressAfterRtc.exi0IplAddressSequence, null);
  readIplDma(staleAddressAfterRtc, 0x2000, 32, 3);
  assert.equal(
    staleAddressAfterRtc.exiTransferTrace.at(-1).reason,
    "ipl-dma-without-address-command",
  );

  for (const context of [
    sourceOverflow,
    targetOverflow,
    wrongMode,
    wrongImageSize,
    missingAddressCommand,
    staleAddressAfterRtc,
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
    0x80000000,
  );
  assert.equal(
    context.view.getUint32(context.mmio + 0x6834, false),
    0x40000000,
  );
  assert.equal(context.deviceEvents.get("exiChannel1"), 1);
  assert.equal(context.deviceEvents.get("exiChannel2"), 1);
  assert.equal(context.exiTransferSequence, 0);
});
