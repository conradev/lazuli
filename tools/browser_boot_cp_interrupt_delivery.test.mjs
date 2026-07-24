#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  browserBootSource as source,
  configureInterruptingCp,
  makeContext,
  readPiCause,
  writePiCauseStorage,
  writePiMask,
} from "./browser_boot_cp_interrupt_fixture.mjs";

test("PI mask and MSR EE gate delivery without consuming the CP level", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x60,
    control: 0x05,
    highWatermark: 0x40,
  });
  context.refreshCommandProcessorInterruptLevel("high-crossing");

  context.view.setUint32(context.cpu + context.msrOffset, 0x8000, true);
  assert.equal(context.serviceCommandProcessorInterrupt(100), false);
  assert.equal(context.raisedExceptions.length, 0);

  writePiMask(context, 0x800);
  context.view.setUint32(context.cpu + context.msrOffset, 0, true);
  assert.equal(context.serviceCommandProcessorInterrupt(101), false);
  assert.equal(context.raisedExceptions.length, 0);

  context.view.setUint32(context.cpu + context.msrOffset, 0x8000, true);
  assert.equal(context.serviceCommandProcessorInterrupt(102), true);
  assert.deepEqual(context.raisedExceptions[0], {
    registers: context.cpu,
    vector: 0x0500,
  });
  assert.equal(readPiCause(context) & 0x800, 0x800);
  assert.equal(
    context.view.getUint32(context.cpu + context.msrOffset, true) & 0x8000,
    0,
  );

  // An rfi-like EE restore must deliver the still-unresolved level again.
  context.view.setUint32(context.cpu + context.msrOffset, 0x8000, true);
  assert.equal(context.serviceCommandProcessorInterrupt(103), true);
  assert.equal(context.raisedExceptions.length, 2);
  assert.equal(context.commandProcessorExternalInterruptDeliveries, 2);
});

test("PI FIFO reset clears only CP pending state and its cause bit", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x60,
    control: 0x05,
    highWatermark: 0x40,
  });
  context.refreshCommandProcessorInterruptLevel("high-crossing");
  writePiCauseStorage(context, readPiCause(context) | 0x00010000);

  context.writeProcessorInterfaceFifoRegister(0x0c003018, 1, 4);
  assert.equal(context.commandProcessorHighInterruptPending, false);
  assert.equal(context.commandProcessorLowInterruptPending, false);
  assert.equal(context.cpFifoState.control, 0x10);
  assert.equal(readPiCause(context), 0x00010000);
  assert.equal(context.commandProcessorInterruptResets, 1);
  assert.equal(context.cpFifoState.distance, 0x60);
});

test("SMB signed distance recovery precedes the first enabled IRQ sample", () => {
  const context = makeContext({ ramSize: 0x01800000 });
  const base = 0x00d63380;
  const end = 0x00e63360;
  const writePointer = 0x00d69000;
  const readPointer = 0x00e5a640;
  const rawDistance = 0x03f0e9c0;
  configureInterruptingCp(context, {
    base,
    end,
    distance: rawDistance,
    control: 0,
    highWatermark: 0x0003c000,
    lowWatermark: 0x00020000,
    readPointer,
    writePointer,
  });

  assert.equal(
    context.writeCommandProcessorRegister(0x0c000002, 0x0015, 2),
    true,
  );
  assert.equal(context.commandProcessorDistanceNormalizations, 1);
  assert.equal(context.commandProcessorLastDistanceNormalization.rawDistance, rawDistance);
  assert.equal(
    context.commandProcessorLastDistanceNormalization.normalizedDistance,
    0x0000e9c0,
  );
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.cpFifoState.readPointer, writePointer);
  assert.equal(context.commandProcessorHighInterruptAssertions, 0);
  assert.equal(context.commandProcessorHighInterruptPending, false);
  assert.equal(context.commandProcessorLowInterruptPending, true);
  assert.equal(context.commandProcessorLowInterruptAssertions, 1);
  assert.equal(readPiCause(context) & 0x800, 0);
});

test("an invalid enabled FIFO cannot partially assert CP interrupt state", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x200,
    control: 0x05,
    highWatermark: 0x40,
  });
  writePiCauseStorage(context, 0x00010000);
  const before = { ...context.cpFifoState };

  assert.throws(
    () => context.serviceCommandProcessorFifo(),
    /invalid CP FIFO read state/,
  );
  assert.deepEqual({ ...context.cpFifoState }, before);
  assert.equal(context.commandProcessorHighInterruptPending, false);
  assert.equal(context.commandProcessorLowInterruptPending, false);
  assert.equal(readPiCause(context), 0x00010000);
});

test("interrupt transition diagnostics are bounded and retain full tuples", () => {
  const context = makeContext();
  configureInterruptingCp(context, {
    distance: 0x60,
    control: 0x05,
    highWatermark: 0x40,
  });

  for (let index = 0; index < 64; index += 1) {
    context.cycles = index;
    context.cpFifoState.distance = (index & 1) === 0 ? 0x60 : 0x20;
    context.refreshCommandProcessorInterruptLevel("toggle-" + index);
  }

  assert.equal(context.commandProcessorInterruptTrace.length, 48);
  const last = context.commandProcessorInterruptTrace.at(-1);
  assert.equal(last.cycle, 63);
  assert.equal(last.reason, "toggle-63");
  for (const field of [
    "control", "status", "qualifiedSources", "pending", "distance",
    "writePointer", "readPointer", "cause", "mask",
  ]) {
    assert.equal(typeof last[field], "string", field);
  }
});

test("runtime wiring routes PI W1C and services CP before other devices", () => {
  assert.match(
    source,
    /physical === 0x0c003000 && size === 4[\s\S]*?writeProcessorInterfaceInterruptCause\(value\)/,
  );

  const serviceStart = source.indexOf("function serviceMmio(");
  const fifoService = source.indexOf("serviceCommandProcessorFifo();", serviceStart);
  const cpInterrupt = source.indexOf(
    "serviceCommandProcessorInterrupt(observedCycles);",
    fifoService,
  );
  const videoSchedule = source.indexOf(
    "ensureViSchedule(observedCycles);",
    cpInterrupt,
  );
  assert.ok(fifoService !== -1 && fifoService < cpInterrupt);
  assert.ok(cpInterrupt < videoSchedule);

  const consumerStart = source.indexOf("function serviceCommandProcessorFifo(");
  const consumerEnd = source.indexOf(
    "function validateProcessorInterfaceFifoWriteState(",
    consumerStart,
  );
  const consumer = source.slice(consumerStart, consumerEnd);
  assert.ok(
    consumer.indexOf("normalizeCommandProcessorFifoDistance();")
      < consumer.indexOf('refreshCommandProcessorInterruptLevel("fifo-before-consume")'),
  );
  assert.ok(
    consumer.indexOf('refreshCommandProcessorInterruptLevel("fifo-before-consume")')
      < consumer.indexOf('refreshCommandProcessorInterruptLevel("fifo-after-consume")'),
  );
});
