#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  append,
  configureCp,
  configurePi,
  makeContext,
  stageAndDrain,
} from "./browser_boot_gx_transport_fixture.mjs";

test("regular staging boundaries retain 31 bytes and drain on byte 32", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context);
  const line = Array.from({ length: 32 }, (_unused, index) => index);

  context.bytes.set(line.slice(0, 31), context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, 31, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 7, true);
  context.view.setUint32(context.gxFifoStagingMeta + 8, 2, true);

  assert.equal(context.drainGxFifoStagingAtCycle(100), false);
  assert.equal(context.cycles, 0);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 31);
  assert.equal(context.gxFifoStagingDrains, 0);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.gxWriteGatherBursts, 0);

  context.bytes[context.gxFifoStagingData + 31] = line[31];
  context.view.setUint32(context.gxFifoStagingMeta, 32, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 8, true);

  assert.equal(
    context.drainGxFifoStagingAtCycle(200),
    false,
    "an unlinked line drains without claiming a CP-visible burst",
  );
  assert.equal(context.cycles, 0);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.gxFifoStagingDrains, 1);
  assert.equal(context.gxFifoStagingBytes, 32);
  assert.equal(context.gxFifoStagingStores, 8);
  assert.equal(context.gxFifoStagingQuantizedStores, 2);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.gxWriteGatherBursts, 1);
  assert.deepEqual(Array.from(context.bytes.subarray(0x100, 0x120)), line);
});

test("regular staging accounts for existing carry before deferring or completing a burst", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context, { control: context.cpControlLinkEnable });
  const line = Array.from({ length: 32 }, (_unused, index) => index);

  append(context, line.slice(0, 20), 5, 1);
  assert.equal(context.gxWriteGatherPendingBytes, 20);

  context.bytes.set(line.slice(20, 31), context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, 11, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 3, true);
  assert.equal(context.drainGxFifoStagingAtCycle(100), false);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 11);
  assert.equal(context.gxWriteGatherPendingBytes, 20);
  assert.equal(context.gxFifoStagingDrains, 0);

  context.bytes.set(line.slice(20), context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, 12, true);
  assert.equal(context.drainGxFifoStagingAtCycle(200), true);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.gxWriteGatherBursts, 1);
  assert.equal(context.gxWriteGatherLinkedBursts, 1);
  assert.equal(context.cpFifoState.distance, 32);
  assert.equal(context.gxFifoStagingDrains, 1);
  assert.equal(context.gxFifoStagingBytes, 12);
  assert.deepEqual(Array.from(context.bytes.subarray(0x100, 0x120)), line);
});

test("write-gather owns partial bytes and commits only complete 32-byte lines", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context);
  const first = Array.from({ length: 31 }, (_unused, index) => index);

  append(context, first, 7, 2);
  assert.equal(context.gxWriteGatherPendingBytes, 31);
  assert.equal(context.gxWriteGatherBursts, 0);
  assert.equal(context.piFifoState.current, 0x100);
  assert.deepEqual(Array.from(context.bytes.subarray(0x100, 0x120)), new Array(32).fill(0));

  append(context, [31], 1);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.gxWriteGatherBursts, 1);
  assert.equal(context.gxWriteGatherUnlinkedBursts, 1);
  assert.equal(context.gxWriteGatherBytesCommitted, 32);
  assert.equal(context.piFifoState.current, 0x120);
  assert.deepEqual(
    Array.from(context.bytes.subarray(0x100, 0x120)),
    Array.from({ length: 32 }, (_unused, index) => index),
  );
  assert.equal(context.cpFifoState.distance, 0);
  assert.deepEqual(context.decodedChunks, []);
  assert.equal(context.gxFifoBytes, 32, "legacy input byte diagnostics are preserved");
  assert.equal(context.gxFifoStores, 8);
  assert.equal(context.gxFifoQuantizedStores, 2);
  assert.equal(context.gxFifoSample.length, 32);
});

test("separate Wasm staging drains share one hardware gather carry", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context);
  const first = Array.from({ length: 24 }, (_unused, index) => 0x10 + index);
  const second = Array.from({ length: 8 }, (_unused, index) => 0x80 + index);

  stageAndDrain(context, first, 6, 2);
  assert.equal(context.gxWriteGatherPendingBytes, 24);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 0);
  assert.equal(context.gxWriteGatherBursts, 0);
  stageAndDrain(context, second, 2, 1);

  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.gxWriteGatherBursts, 1);
  assert.deepEqual(
    Array.from(context.bytes.subarray(0x100, 0x120)),
    [...first, ...second],
  );
  assert.equal(context.gxFifoStagingDrains, 2);
  assert.equal(context.gxFifoStagingBytes, 32);
  assert.equal(context.gxFifoStagingStores, 8);
  assert.equal(context.gxFifoStagingQuantizedStores, 3);
  assert.equal(context.gxPreflightCalls, 0, "unlinked PI traffic bypasses the decoder");
});

test("transport result is invariant across staging-style input partitions", () => {
  const stream = Array.from({ length: 77 }, (_unused, index) => index ^ 0x5a);
  const run = chunks => {
    const context = makeContext();
    configurePi(context, { base: 0x100, end: 0x1e0, current: 0x100 });
    configureCp(context);
    for (const chunk of chunks) append(context, chunk);
    return {
      ram: Array.from(context.bytes.subarray(0x100, 0x140)),
      pending: Array.from(
        context.gxWriteGatherBuffer.subarray(0, context.gxWriteGatherPendingBytes),
      ),
      pendingBytes: context.gxWriteGatherPendingBytes,
      current: context.piFifoState.current,
      bursts: context.gxWriteGatherBursts,
      bytes: context.gxFifoBytes,
      hash: context.gxFifoHash,
      sample: [...context.gxFifoSample],
    };
  };
  const byteChunks = stream.map(value => [value]);
  assert.deepEqual(run([stream]), run([stream.slice(0, 5), stream.slice(5, 41), stream.slice(41)]));
  assert.deepEqual(run([stream]), run(byteChunks));
});
