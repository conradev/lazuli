// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { ResidentMachineAdapter } from "../web/resident-machine.mjs";

const BYTES = 108;
const POINTER = 64;

function authorityFixture(overrides = {}) {
  const words = new Uint32Array(27);
  words.set([
    0x4c5a_4341, 2, BYTES,
    0x89ab_cdef, 0x0123_4567,
    4, 0,
    5, 0,
    6, 0,
    7, 0,
    8, 0,
    9, 0,
    0x7654_3210, 0xfedc_ba98,
    0x0180_1234, 0x5678_9abc,
    0, 3, 0x0100, 0x8080_8080, 0x00ff_0000,
    0,
  ]);
  for (const [index, value] of Object.entries(overrides)) words[Number(index)] = value;
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer, POINTER, BYTES).set(new Uint8Array(words.buffer));
  const adapter = new ResidentMachineAdapter({
    memory,
    core: { core_capture_authority_snapshot: () => POINTER },
    dispatcher: {},
    coordinator: {},
    captureAuthorityBytes: BYTES,
  });
  return { adapter, memory };
}

test("capture authority V2 is copied and decoded as one exact 108-byte record", () => {
  const { adapter, memory } = authorityFixture();
  const authority = adapter.captureAuthority();
  new Uint8Array(memory.buffer, POINTER, BYTES).fill(0);

  assert.deepEqual(authority, {
    scheduler: {
      canonicalCycle: 0x0123_4567_89ab_cdefn,
      executedCycles: 4n,
      executedInstructions: 5n,
      retiredBlocks: 6n,
    },
    si: {
      pollIndex: 7n,
      scheduledCycle: 8n,
      observedCycle: 9n,
      appliedSequenceLo: 0x7654_3210,
      appliedSequenceHi: 0xfedc_ba98,
      packetWord0: 0x0180_1234,
      packetWord1: 0x5678_9abc,
      source: 0,
      controllerMode: 3,
      buttons: 0x0100,
      stickXyCxy: 0x8080_8080,
      triggerLrab: 0x00ff_0000,
    },
  });
});

test("capture authority V2 rejects header, reserved, and dirty pristine-SI drift", () => {
  for (const [word, value, pattern] of [
    [0, 0, /magic changed/],
    [1, 1, /version changed/],
    [2, 104, /size changed/],
    [26, 1, /reserved word is nonzero/],
  ]) {
    assert.throws(() => authorityFixture({ [word]: value }).adapter.captureAuthority(), pattern);
  }
  const pristine = authorityFixture({
    11: 0,
    12: 0,
    13: 0,
    14: 0,
    15: 0,
    16: 0,
    17: 0,
    18: 0,
    19: 0,
    20: 0,
    21: 0,
    22: 0,
    23: 0,
    24: 0,
    25: 0,
  }).adapter.captureAuthority();
  assert.equal(pristine.si, null);
  assert.throws(
    () => authorityFixture({
      11: 0,
      12: 0,
      13: 0,
      14: 0,
      15: 0,
      16: 0,
      17: 0,
      18: 0,
      19: 0,
      20: 0,
      21: 0,
      22: 0,
      23: 0,
      24: 0x8080_8080,
      25: 0,
    }).adapter.captureAuthority(),
    /empty SI authority is not pristine/,
  );
});
