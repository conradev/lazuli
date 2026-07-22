#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  append,
  be32,
  configureCp,
  configurePi,
  makeContext,
  stageAndDrain,
} from "./browser_boot_gx_transport_fixture.mjs";

test("a full linked CP ring rejects a staged burst without mutation", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context, {
    base: 0x100,
    end: 0x120,
    pointer: 0x100,
    distance: 64,
    control: 0x10,
  });
  const staged = Array.from({ length: 32 }, (_unused, index) => 0x60 + index);
  context.bytes.set(staged, context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 8, true);
  context.view.setUint32(context.gxFifoStagingMeta + 8, 3, true);
  const before = {
    cp: { ...context.cpFifoState },
    gather: Array.from(context.gxWriteGatherBuffer),
    legacyBytes: context.gxFifoBytes,
    meta: [0, 4, 8].map(offset =>
      context.view.getUint32(context.gxFifoStagingMeta + offset, true)),
    pi: { ...context.piFifoState },
    ram: Array.from(context.bytes.subarray(0x100, 0x120)),
  };

  assert.throws(() => context.drainGxFifoStaging(), /CP FIFO append overflow/);
  assert.deepEqual({
    cp: { ...context.cpFifoState },
    gather: Array.from(context.gxWriteGatherBuffer),
    legacyBytes: context.gxFifoBytes,
    meta: [0, 4, 8].map(offset =>
      context.view.getUint32(context.gxFifoStagingMeta + offset, true)),
    pi: { ...context.piFifoState },
    ram: Array.from(context.bytes.subarray(0x100, 0x120)),
  }, before);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
});

test("a late staged overflow preflights atomically and retries without duplication", () => {
  const context = makeContext();
  configurePi(context, { base: 0x100, end: 0x120, current: 0x120 });
  configureCp(context, {
    base: 0x100,
    end: 0x120,
    pointer: 0x120,
    distance: 32,
    control: 0x10,
  });
  context.cpFifoState.readPointer = 0x100;
  const first = Array.from({ length: 32 }, (_unused, index) => 0x20 + index);
  const second = Array.from({ length: 32 }, (_unused, index) => 0x80 + index);
  const staged = [...first, ...second];
  context.bytes.set(staged, context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, staged.length, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 16, true);
  context.view.setUint32(context.gxFifoStagingMeta + 8, 4, true);
  const before = {
    cp: { ...context.cpFifoState },
    gather: Array.from(context.gxWriteGatherBuffer),
    meta: [0, 4, 8].map(offset =>
      context.view.getUint32(context.gxFifoStagingMeta + offset, true)),
    pi: { ...context.piFifoState },
    ram: Array.from(context.bytes.subarray(0x100, 0x140)),
  };

  assert.throws(
    () => context.drainGxFifoStaging(),
    /CP FIFO append overflow/,
  );
  assert.deepEqual({
    cp: { ...context.cpFifoState },
    gather: Array.from(context.gxWriteGatherBuffer),
    meta: [0, 4, 8].map(offset =>
      context.view.getUint32(context.gxFifoStagingMeta + offset, true)),
    pi: { ...context.piFifoState },
    ram: Array.from(context.bytes.subarray(0x100, 0x140)),
  }, before, "the first would-be line is not committed before the late failure");

  assert.equal(context.writeCommandProcessorRegister(0x0c000002, 0x11, 2), true);
  assert.equal(context.cpFifoState.distance, 0);
  context.drainGxFifoStaging();

  assert.equal(context.gxWriteGatherBursts, 2);
  assert.equal(context.gxWriteGatherBytesCommitted, 64);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.deepEqual(Array.from(context.bytes.subarray(0x120, 0x140)), first);
  assert.deepEqual(Array.from(context.bytes.subarray(0x100, 0x120)), second);
  assert.equal(context.cpFifoState.distance, 0);
  assert.deepEqual(context.decodedChunks.slice(-2), [first, second]);
});

test("a linked decoder failure keeps the accepted staging record consumed", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context, { control: 0x11 });
  const line = Array.from({ length: 32 }, (_unused, index) => 0x40 + index);
  context.bytes.set(line, context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, line.length, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 8, true);
  const appendCommandBytes = context.appendGxCommandBytes;
  context.appendGxCommandBytes = () => {
    throw new Error("synthetic decoder failure");
  };

  assert.throws(() => context.drainGxFifoStaging(), /synthetic decoder failure/);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.gxFifoStagingDrains, 1);
  assert.equal(context.gxWriteGatherBursts, 1);
  assert.equal(context.cpFifoState.distance, 32);
  assert.deepEqual(Array.from(context.bytes.subarray(0x100, 0x120)), line);

  context.drainGxFifoStaging();
  assert.equal(context.gxWriteGatherBursts, 1, "an accepted line is never replayed");
  context.appendGxCommandBytes = appendCommandBytes;
  assert.equal(context.serviceCommandProcessorFifo(), 32);
  assert.equal(context.cpFifoState.distance, 0);
  assert.deepEqual(context.decodedChunks, [line]);
});

test("linked production queues while reads are disabled and drains on enable", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context, { control: 0x10 });
  const line = Array.from({ length: 32 }, (_unused, index) => 0x40 + index);

  append(context, line);
  assert.equal(context.piFifoState.current, 0x120);
  assert.equal(context.cpFifoState.writePointer, 0x120);
  assert.equal(context.cpFifoState.readPointer, 0x100);
  assert.equal(context.cpFifoState.distance, 32);
  assert.deepEqual(context.decodedChunks, []);

  assert.equal(context.writeCommandProcessorRegister(0x0c000002, 0x11, 2), true);
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.cpFifoState.readPointer, 0x120);
  assert.equal(context.commandProcessorReadBursts, 1);
  assert.deepEqual(context.decodedChunks, [line]);
});

test("one full minimum-size staging drain fits a 64 KiB CP ring", () => {
  const ringBytes = 64 * 1024;
  const base = 0x100;
  const end = base + ringBytes - 32;
  const context = makeContext({
    ramSize: 0x20000,
    stagingCapacity: ringBytes,
  });
  configurePi(context, { base, end, current: base });
  configureCp(context, {
    base,
    end,
    pointer: base,
    control: 0x11,
  });
  const staged = Array.from(
    { length: ringBytes },
    (_unused, index) => index & 0xff,
  );

  stageAndDrain(context, staged, ringBytes / 4);

  assert.equal(context.gxWriteGatherBursts, ringBytes / 32);
  assert.equal(context.gxWriteGatherLinkedBursts, ringBytes / 32);
  assert.equal(context.commandProcessorReadBytes, ringBytes);
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.cpFifoState.writePointer, base);
  assert.equal(context.cpFifoState.readPointer, base);
  assert.equal(context.piFifoState.current, base);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.decodedChunks.length, 1);
  assert.deepEqual(context.decodedChunks[0], staged);
});

test("batched CP reader wraps the RAM ring and honors a breakpoint boundary", () => {
  const context = makeContext();
  const atEnd = Array.from({ length: 32 }, (_unused, index) => 0x20 + index);
  const atBase = Array.from({ length: 32 }, (_unused, index) => 0x80 + index);
  context.bytes.set(atEnd, 0x120);
  context.bytes.set(atBase, 0x100);
  configureCp(context, {
    base: 0x100,
    end: 0x120,
    pointer: 0x120,
    distance: 64,
    control: 0x01,
  });

  assert.equal(context.serviceCommandProcessorFifo(64), 64);
  assert.deepEqual(context.decodedChunks, [atEnd, atBase]);
  assert.equal(context.cpFifoState.readPointer, 0x120);
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.commandProcessorReadWraps, 1);

  context.decodedChunks.length = 0;
  context.cpFifoState.readPointer = 0x100;
  context.cpFifoState.distance = 64;
  context.cpFifoState.breakpoint = 0x120;
  context.cpFifoState.control = 0x03;
  assert.equal(context.serviceCommandProcessorFifo(64), 32);
  assert.deepEqual(context.decodedChunks, [atBase]);
  assert.equal(context.cpFifoState.readPointer, 0x120);
  assert.equal(context.cpFifoState.distance, 32);
  assert.equal(context.commandProcessorBreakpointStops > 0, true);
});

test("CP read enable consumes a programmed multi-buffer FIFO without link", () => {
  const context = makeContext({ realDecoder: true });
  const line = [
    0x61,
    ...be32(0x10203040),
    ...new Array(27).fill(0x00),
  ];
  context.bytes.set(line, 0x100);
  configureCp(context, {
    base: 0x100,
    end: 0x160,
    pointer: 0x100,
    distance: 32,
    control: 0x01,
  });

  assert.equal(context.serviceCommandProcessorFifo(), 32);
  assert.deepEqual(context.semanticEvents, [["bp", 0x10203040]]);
  assert.equal(context.cpFifoState.readPointer, 0x120);
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.gxWriteGatherBursts, 0);
});
