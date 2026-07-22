#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  append,
  configureCp,
  configurePi,
  makeContext,
} from "./browser_boot_gx_transport_fixture.mjs";

test("carry crosses PI redirects and routing is selected at burst time", () => {
  const context = makeContext();
  configurePi(context);
  configureCp(context, { control: 0x10 });
  append(context, Array.from({ length: 8 }, (_unused, index) => 0xa0 + index));

  context.cpFifoState.control = 0;
  context.writeProcessorInterfaceFifoRegister(0x0c00300c, 0, 4);
  context.writeProcessorInterfaceFifoRegister(0x0c003010, 0x04000000, 4);
  context.writeProcessorInterfaceFifoRegister(0x0c003014, 0x400, 4);
  append(context, Array.from({ length: 24 }, (_unused, index) => 0xb0 + index));

  assert.deepEqual(
    Array.from(context.bytes.subarray(0x400, 0x420)),
    [
      ...Array.from({ length: 8 }, (_unused, index) => 0xa0 + index),
      ...Array.from({ length: 24 }, (_unused, index) => 0xb0 + index),
    ],
  );
  assert.equal(context.piFifoState.current, 0x420);
  assert.equal(context.piFifoState.wrap, false);
  assert.equal(context.gxWriteGatherUnlinkedBursts, 1);
  assert.equal(context.gxWriteGatherLinkedBursts, 0);
  assert.equal(context.cpFifoState.distance, 0);
  assert.deepEqual(context.decodedChunks, []);
});

test("PI and CP pointers use inclusive ends and PI wrap is sticky", () => {
  const context = makeContext();
  configurePi(context, { base: 0x100, end: 0x120, current: 0x120 });
  configureCp(context);

  append(context, new Array(32).fill(0x11));
  assert.equal(context.piFifoState.current, 0x100);
  assert.equal(context.piFifoState.wrap, true);
  append(context, new Array(32).fill(0x22));
  assert.equal(context.piFifoState.current, 0x120);
  assert.equal(context.piFifoState.wrap, true);
  assert.equal(context.gxWriteGatherWraps, 1);

  context.writeProcessorInterfaceFifoRegister(0x0c003014, 0x120, 4);
  assert.equal(context.piFifoState.wrap, false, "a WPTR write clears absent wrap bit");
  context.writeProcessorInterfaceFifoRegister(0x0c00300c, 0, 4);
  context.writeProcessorInterfaceFifoRegister(0x0c003010, 0x04000000, 4);
  context.writeProcessorInterfaceFifoRegister(0x0c003014, 0x200, 4);
  append(context, new Array(32).fill(0x33));
  assert.equal(context.piFifoState.current, 0x220);
  assert.equal(context.piFifoState.wrap, false);
});

test("the PI redirect sentinel never normalizes its one-past pointer to zero", () => {
  const context = makeContext({ ramSize: 0x04000100 });
  configurePi(context, {
    base: 0,
    end: 0x04000000,
    current: 0x03ffffe0,
  });
  configureCp(context);
  const finalLine = new Array(32).fill(0x5a);

  append(context, finalLine);
  assert.deepEqual(
    Array.from(context.bytes.subarray(0x03ffffe0, 0x04000000)),
    finalLine,
  );
  assert.equal(context.piFifoState.current, 0x04000000);
  assert.equal(context.piFifoState.wrap, false);
  assert.equal(context.gxWriteGatherWraps, 0);
  assert.deepEqual(Array.from(context.bytes.subarray(0, 32)), new Array(32).fill(0));

  assert.throws(
    () => append(context, new Array(32).fill(0xa5)),
    /invalid PI FIFO write state/,
  );
  assert.equal(context.piFifoState.current, 0x04000000);
  assert.equal(context.gxWriteGatherBursts, 1);
  assert.deepEqual(Array.from(context.bytes.subarray(0, 32)), new Array(32).fill(0));
});

test("a redirect run crossing the sentinel fails atomically before its first burst", () => {
  const context = makeContext({ ramSize: 0x04000100 });
  configurePi(context, {
    base: 0,
    end: 0x04000000,
    current: 0x03ffffe0,
  });
  configureCp(context);
  const staged = Array.from({ length: 64 }, (_unused, index) => index + 1);
  context.bytes.set(staged, context.gxFifoStagingData);
  context.view.setUint32(context.gxFifoStagingMeta, staged.length, true);
  context.view.setUint32(context.gxFifoStagingMeta + 4, 16, true);

  assert.throws(
    () => context.drainGxFifoStaging(),
    /PI FIFO redirect run is outside main RAM/,
  );
  assert.equal(context.piFifoState.current, 0x03ffffe0);
  assert.equal(context.piFifoState.wrap, false);
  assert.equal(context.gxWriteGatherBursts, 0);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.view.getUint32(context.gxFifoStagingMeta, true), 64);
  assert.deepEqual(
    Array.from(context.bytes.subarray(0x03ffffe0, 0x04000000)),
    new Array(32).fill(0),
  );
  assert.deepEqual(Array.from(context.bytes.subarray(0, 32)), new Array(32).fill(0));
});

test("PI FIFO reset discards transport carry without rewriting FIFO pointers", () => {
  const context = makeContext();
  configurePi(context, { base: 0x200, end: 0x260, current: 0x220 });
  configureCp(context, {
    base: 0x100,
    end: 0x160,
    pointer: 0x120,
    distance: 32,
    control: 0x3f,
  });
  context.cpFifoState.readPointer = 0x100;
  context.cpFifoState.highWatermark = 0x80;
  context.cpFifoState.lowWatermark = 0x20;
  append(context, [1, 2, 3, 4, 5, 6, 7]);
  context.gxDecodeBuffer.push(0x61, 0x12);
  context.gxDecodeRetryAtBufferedBytes = 5;

  context.writeProcessorInterfaceFifoRegister(0x0c003018, 1, 4);
  assert.equal(context.gxWriteGatherPendingBytes, 0);
  assert.equal(context.gxWriteGatherDiscardedBytes, 7);
  assert.deepEqual(context.gxDecodeBuffer, []);
  assert.equal(context.commandProcessorDecoderDiscardedBytes, 2);
  assert.equal(context.gxDecodeRetryAtBufferedBytes, 1);
  assert.equal(context.cpFifoState.control, 0x10);
  assert.equal(context.cpFifoState.highWatermark, 0x03ffffe0);
  assert.equal(context.cpFifoState.lowWatermark, 0);
  assert.equal(context.cpFifoState.writePointer, 0x120);
  assert.equal(context.cpFifoState.readPointer, 0x100);
  assert.equal(context.cpFifoState.distance, 32);
  assert.deepEqual({ ...context.piFifoState }, {
    base: 0x200,
    end: 0x260,
    current: 0x220,
    wrap: false,
  });
});

