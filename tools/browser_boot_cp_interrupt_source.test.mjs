#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  configureInterruptingCp,
  makeContext,
  readPiCause,
  writePiCauseStorage,
} from "./browser_boot_cp_interrupt_fixture.mjs";

test("CP status uses strict thresholds independently of interrupt enables", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x40,
    control: 0x01,
    highWatermark: 0x40,
    lowWatermark: 0x40,
  });

  assert.equal(context.readCommandProcessorStatus(), 0x00);
  context.cpFifoState.distance = 0x60;
  assert.equal(context.readCommandProcessorStatus(), 0x01);
  context.cpFifoState.distance = 0x20;
  assert.equal(context.readCommandProcessorStatus(), 0x02);
  context.cpFifoState.distance = 0;
  assert.equal(context.readCommandProcessorStatus(), 0x0e);

  context.cpFifoState.control = 0;
  context.cpFifoState.distance = 0x40;
  assert.equal(context.readCommandProcessorStatus(), 0x08);
  context.cpFifoState.control = 0x03;
  context.cpFifoState.breakpoint = context.cpFifoState.readPointer;
  assert.equal(context.readCommandProcessorStatus(), 0x18);
});

test("GP read and source enables jointly qualify high and low interrupts", () => {
  const cases = [
    { distance: 0x60, high: 0x40, low: 0, control: 0x04, cause: false, pending: false },
    { distance: 0x60, high: 0x40, low: 0, control: 0x01, cause: false, pending: true },
    { distance: 0x60, high: 0x40, low: 0, control: 0x05, cause: true, pending: true },
    { distance: 0x20, high: 0x100, low: 0x40, control: 0x08, cause: false, pending: false },
    { distance: 0x20, high: 0x100, low: 0x40, control: 0x01, cause: false, pending: true },
    { distance: 0x20, high: 0x100, low: 0x40, control: 0x09, cause: true, pending: true },
  ];

  for (const candidate of cases) {
    const context = makeContext();
    configureInterruptingCp(context, {
      distance: candidate.distance,
      control: candidate.control,
      highWatermark: candidate.high,
      lowWatermark: candidate.low,
    });
    context.refreshCommandProcessorInterruptLevel("truth-table");
    assert.equal(
      (readPiCause(context) & 0x800) !== 0,
      candidate.cause,
      JSON.stringify(candidate),
    );
    assert.equal(
      candidate.distance > candidate.high
        ? context.commandProcessorHighInterruptPending
        : context.commandProcessorLowInterruptPending,
      candidate.pending,
      JSON.stringify(candidate),
    );
  }
});

test("a resolved high-water crossing remains sticky until CP_CLEAR", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x60,
    control: 0x05,
    highWatermark: 0x40,
  });
  writePiCauseStorage(context, 0x00010000);

  context.refreshCommandProcessorInterruptLevel("high-crossing");
  assert.equal(context.commandProcessorHighInterruptPending, true);
  assert.equal(readPiCause(context), 0x00010800);

  context.cpFifoState.distance = 0x20;
  context.refreshCommandProcessorInterruptLevel("high-resolved");
  assert.equal(context.readCommandProcessorStatus() & 1, 0);
  assert.equal(context.commandProcessorHighInterruptPending, true);
  assert.equal(readPiCause(context), 0x00010800);

  assert.equal(
    context.writeCommandProcessorRegister(0x0c000004, 0x0001, 2),
    true,
  );
  assert.equal(context.commandProcessorHighInterruptPending, false);
  assert.equal(readPiCause(context), 0x00010000);
  assert.equal(context.commandProcessorInterruptClears, 1);
  assert.equal(context.commandProcessorPiDeassertions, 1);
  assert.equal(context.readCommandProcessorRegister(0x0c000004, 2), 0);

  context.writeCommandProcessorRegister(0x0c000004, 0x0004, 2);
  assert.equal(context.commandProcessorPerformanceMetricClears, 1);
});

test("active CP_CLEAR and PI W1C writes immediately reassert a live source", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x60,
    control: 0x05,
    highWatermark: 0x40,
  });
  writePiCauseStorage(context, 0x00010000);
  context.refreshCommandProcessorInterruptLevel("high-crossing");

  context.cpFifoState.control = 0x01;
  context.refreshCommandProcessorInterruptLevel("high-irq-disabled");
  context.writeCommandProcessorRegister(0x0c000004, 0x0001, 2);
  assert.equal(context.commandProcessorHighInterruptPending, true);
  assert.equal(context.commandProcessorActiveClearReassertions, 1);
  assert.equal(context.commandProcessorHighInterruptAssertions, 2);
  assert.equal(readPiCause(context), 0x00010000);

  context.cpFifoState.control = 0x05;
  context.refreshCommandProcessorInterruptLevel("high-irq-reenabled");
  assert.equal(readPiCause(context), 0x00010800);
  context.writeCommandProcessorRegister(0x0c000004, 0x0001, 2);
  assert.equal(context.commandProcessorHighInterruptPending, true);
  assert.equal(context.commandProcessorActiveClearReassertions, 2);
  assert.equal(readPiCause(context), 0x00010800);

  const assertionsBeforeW1c = context.commandProcessorPiAssertions;
  context.writeProcessorInterfaceInterruptCause(0x00000800);
  assert.equal(readPiCause(context), 0x00010800);
  assert.equal(context.commandProcessorPiAssertions, assertionsBeforeW1c + 1);

  context.writeProcessorInterfaceInterruptCause(0x00010000);
  assert.equal(readPiCause(context), 0x00000800);
});

test("bounded consumption latches low water only after crossing it", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x40,
    control: 0x09,
    highWatermark: 0x100,
    lowWatermark: 0x40,
  });
  context.bytes.fill(0, 0x100, 0x140);

  assert.equal(context.serviceCommandProcessorFifo(32), 32);
  assert.equal(context.cpFifoState.distance, 0x20);
  assert.equal(context.cpFifoState.readPointer, 0x120);
  assert.equal(context.commandProcessorLowInterruptPending, true);
  assert.equal(context.commandProcessorLowInterruptAssertions, 1);
  assert.equal(readPiCause(context) & 0x800, 0x800);
});

test("one synchronous drain can retain both watermark pendings", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x40,
    control: 0x0d,
    highWatermark: 0x20,
    lowWatermark: 0x20,
  });
  context.bytes.fill(0, 0x100, 0x140);

  assert.equal(context.serviceCommandProcessorFifo(64), 64);
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.commandProcessorHighInterruptPending, true);
  assert.equal(context.commandProcessorLowInterruptPending, true);
  assert.equal(readPiCause(context) & 0x800, 0x800);

  context.writeCommandProcessorRegister(0x0c000004, 0x0003, 2);
  assert.equal(context.commandProcessorHighInterruptPending, false);
  assert.equal(context.commandProcessorLowInterruptPending, true);
  assert.equal(context.commandProcessorActiveClearReassertions, 1);
  assert.equal(readPiCause(context) & 0x800, 0x800);
});

test("breakpoint interrupt is a non-sticky level and preserves the stall", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x40,
    control: 0x23,
    breakpoint: 0x120,
  });
  context.bytes.fill(0, 0x100, 0x140);

  assert.equal(context.serviceCommandProcessorFifo(64), 32);
  assert.equal(context.cpFifoState.distance, 0x20);
  assert.equal(context.cpFifoState.readPointer, 0x120);
  assert.equal(context.readCommandProcessorStatus(), 0x18);
  assert.equal(readPiCause(context) & 0x800, 0x800);

  context.cpFifoState.control = 0x03;
  context.refreshCommandProcessorInterruptLevel("breakpoint-irq-disabled");
  assert.equal(context.readCommandProcessorStatus(), 0x18);
  assert.equal(readPiCause(context) & 0x800, 0);

  context.cpFifoState.control = 0x01;
  assert.equal(context.serviceCommandProcessorFifo(64), 32);
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.readCommandProcessorStatus(), 0x0c);
});

test("source enable switching preserves a pending watermark until clear", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x60,
    control: 0x05,
    highWatermark: 0x40,
  });
  context.refreshCommandProcessorInterruptLevel("high-crossing");

  context.cpFifoState.distance = 0x20;
  context.cpFifoState.control = 0x01;
  context.refreshCommandProcessorInterruptLevel("high-disabled");
  assert.equal(context.commandProcessorHighInterruptPending, true);
  assert.equal(readPiCause(context) & 0x800, 0);

  context.cpFifoState.control = 0x05;
  context.refreshCommandProcessorInterruptLevel("high-reenabled");
  assert.equal(context.commandProcessorQualifiedInterruptSources, 0);
  assert.equal(readPiCause(context) & 0x800, 0x800);

  context.writeCommandProcessorRegister(0x0c000004, 1, 2);
  assert.equal(context.commandProcessorHighInterruptPending, false);
  assert.equal(readPiCause(context) & 0x800, 0);
});
