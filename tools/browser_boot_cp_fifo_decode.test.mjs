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
  writeCpPair,
} from "./browser_boot_gx_transport_fixture.mjs";

test("the CP reader rejects an impossible distance before decoding", () => {
  const context = makeContext();
  configureCp(context, {
    base: 0x100,
    end: 0x120,
    pointer: 0x100,
    distance: 96,
    control: 0x01,
  });

  assert.throws(
    () => context.serviceCommandProcessorFifo(),
    /invalid CP FIFO read state/,
  );
  assert.equal(context.cpFifoState.readPointer, 0x100);
  assert.equal(context.cpFifoState.distance, 96);
  assert.equal(context.commandProcessorDistanceNormalizations, 0);
  assert.deepEqual(context.decodedChunks, []);
});

test("CP read enable recovers a signed GX FIFO-object ring distance", () => {
  const context = makeContext({ ramSize: 0x01000000 });
  const base = 0x00d63380;
  const end = 0x00e63360;
  const writePointer = 0x00d69000;
  const readPointer = 0x00e5a640;
  const rawDistance = 0x03f0e9c0;
  const normalizedDistance = 0x0000e9c0;

  // GX FIFO setup keeps CP reads disabled while publishing the FIFO object.
  // Its distance precedes both pointers, so normalization must wait until the
  // final read-enable write observes one coherent register set.
  writeCpPair(context, 0x20, base);
  writeCpPair(context, 0x24, end);
  writeCpPair(context, 0x30, rawDistance);
  writeCpPair(context, 0x34, writePointer);
  writeCpPair(context, 0x38, readPointer);

  assert.equal(context.cpFifoState.distance, rawDistance);
  assert.equal(context.commandProcessorDistanceNormalizations, 0);
  assert.equal(context.commandProcessorReadBytes, 0);

  assert.equal(
    context.writeCommandProcessorRegister(0x0c000002, 0x01, 2),
    true,
  );
  assert.equal(context.commandProcessorDistanceNormalizations, 1);
  assert.deepEqual(
    { ...context.commandProcessorLastDistanceNormalization },
    {
      rawDistance,
      normalizedDistance,
      base,
      end,
      writePointer,
      readPointer,
      control: 0x01,
    },
  );
  assert.equal(context.commandProcessorMaximumDistance, normalizedDistance);
  assert.equal(context.commandProcessorMaximumRawDistance, rawDistance);
  assert.equal(context.commandProcessorReadBytes, normalizedDistance);
  assert.equal(context.commandProcessorReadWraps, 1);
  assert.equal(context.cpFifoState.distance, 0);
  assert.equal(context.cpFifoState.readPointer, writePointer);
  assert.deepEqual(
    context.decodedChunks.map(chunk => chunk.length),
    [0x8d40, 0x5c80],
  );
});

test("CP distance normalization preserves explicit empty and full states", () => {
  const empty = makeContext();
  configureCp(empty, {
    base: 0x100,
    end: 0x120,
    pointer: 0x100,
    distance: 0,
    control: 0x01,
  });
  assert.equal(empty.serviceCommandProcessorFifo(), 0);
  assert.equal(empty.commandProcessorDistanceNormalizations, 0);

  const full = makeContext();
  configureCp(full, {
    base: 0x100,
    end: 0x120,
    pointer: 0x100,
    distance: 64,
    control: 0x01,
  });
  assert.equal(full.serviceCommandProcessorFifo(), 64);
  assert.equal(full.commandProcessorDistanceNormalizations, 0);
  assert.equal(full.cpFifoState.distance, 0);
  assert.equal(full.cpFifoState.readPointer, 0x100);
});

test("CP distance normalization is atomic for an out-of-RAM ring", () => {
  const context = makeContext();
  const initial = {
    base: 0x3800,
    end: 0x47e0,
    writePointer: 0x3900,
    readPointer: 0x4700,
    distance: 0x03fff200,
    control: 0x01,
  };
  Object.assign(context.cpFifoState, initial);

  assert.throws(
    () => context.serviceCommandProcessorFifo(),
    /invalid CP FIFO read state/,
  );
  assert.deepEqual(
    {
      base: context.cpFifoState.base,
      end: context.cpFifoState.end,
      writePointer: context.cpFifoState.writePointer,
      readPointer: context.cpFifoState.readPointer,
      distance: context.cpFifoState.distance,
      control: context.cpFifoState.control,
    },
    initial,
  );
  assert.equal(context.commandProcessorDistanceNormalizations, 0);
  assert.equal(context.commandProcessorLastDistanceNormalization, null);
  assert.equal(context.commandProcessorReadBytes, 0);
});

test("an in-RAM masked-distance mismatch remains invalid", () => {
  const context = makeContext();
  Object.assign(context.cpFifoState, {
    base: 0x100,
    end: 0x2e0,
    writePointer: 0x140,
    readPointer: 0x280,
    distance: 0x03fffee0,
    control: 0x01,
  });

  assert.throws(
    () => context.serviceCommandProcessorFifo(),
    /invalid CP FIFO read state/,
  );
  assert.equal(context.cpFifoState.distance, 0x03fffee0);
  assert.equal(context.commandProcessorDistanceNormalizations, 0);
  assert.equal(context.commandProcessorLastDistanceNormalization, null);
  assert.deepEqual(context.decodedChunks, []);
});

test("real decoder carry completes one GX command across a CP ring wrap", () => {
  const context = makeContext({ realDecoder: true });
  const atEnd = [
    ...new Array(30).fill(0x00),
    0x61,
    0x12,
  ];
  const atBase = [
    0x34,
    0x56,
    0x78,
    ...new Array(29).fill(0x00),
  ];
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
  assert.deepEqual(context.gxDecodeBuffer, []);
  assert.deepEqual(context.semanticEvents, [["bp", 0x12345678]]);
  assert.equal(context.gxDecodedCommands, 60);
  assert.equal(context.cpFifoState.readPointer, 0x120);
  assert.equal(context.cpFifoState.distance, 0);
});

test("unlinked PI writes build a display list consumed by one linked CALL_DL", () => {
  const context = makeContext({ realDecoder: true });
  configurePi(context, { base: 0, end: 0x04000000, current: 0x400 });
  configureCp(context);
  const displayList = [
    0x61,
    ...be32(0x89abcdef),
    ...new Array(27).fill(0x00),
  ];

  append(context, displayList);
  assert.equal(context.gxBpLoads, 0);
  assert.equal(context.gxDecodedCommands, 0);
  assert.deepEqual(Array.from(context.bytes.subarray(0x400, 0x420)), displayList);

  configurePi(context, { base: 0x100, end: 0x160, current: 0x100 });
  configureCp(context, { control: 0x11 });
  append(context, [
    0x40,
    ...be32(0x400),
    ...be32(32),
    ...new Array(23).fill(0x00),
  ]);

  assert.equal(context.gxDisplayLists, 1);
  assert.equal(context.gxDisplayListBytes, 32);
  assert.equal(context.gxDisplayListErrors, 0);
  assert.deepEqual(context.semanticEvents, [["bp", 0x89abcdef]]);
  assert.equal(context.cpFifoState.distance, 0);
});

