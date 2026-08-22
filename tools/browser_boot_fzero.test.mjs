#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function makeContext(identifier = "GFZE01", version = 0) {
  const memory = new ArrayBuffer(0x1800000);
  const view = new DataView(memory);
  const context = {
    Math,
    Number,
    boot: { identifier, version },
    controllerAppliedSequence: 0,
    fzeroLastActiveGameplayInput: null,
    serialLastActiveHostPublication: null,
    view,
    ramPointer(address, length) {
      const physical = address & 0x1fffffff;
      return physical <= memory.byteLength - length ? physical : null;
    },
    inspectSuperMonkeyBallGameState() {
      return identifier === "GMBE8P" ? { game: "smb" } : null;
    },
    inspectLuigisMansionGameState() {
      return identifier === "GLME01" ? { game: "luigi" } : null;
    },
    inspectWindWakerGameState() {
      return identifier === "GZLE01" ? { game: "wind" } : null;
    },
    inspectMeleeGameState() {
      return identifier === "GALE01" ? { game: "melee" } : null;
    },
    inspectWarioWareGameState() {
      return identifier === "GZWE01" ? { game: "wario" } : null;
    },
    sampleLuigisMansionGameplayInput() {},
    sampleWindWakerGameplayInput() {},
    sampleMeleeGameplayInput() {},
    sampleWarioWareGameplayInput() {},
  };
  vm.createContext(context);
  vm.runInContext([
    "guestU32",
    "guestU8",
    "guestU16",
    "guestS32",
    "guestF32",
    "hex32",
    "fzeroMappedPointer",
    "inspectFzeroVector",
    "inspectFzeroGameState",
    "sampleFzeroGameplayInput",
    "inspectGuestGameState",
    "sampleGuestGameplayInput",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.fzero.js",
  });
  return context;
}

function writeU32(context, address, value) {
  context.view.setUint32(address & 0x1fffffff, value, false);
}

function writeS32(context, address, value) {
  context.view.setInt32(address & 0x1fffffff, value, false);
}

function writeU16(context, address, value) {
  context.view.setUint16(address & 0x1fffffff, value, false);
}

function writeU8(context, address, value) {
  context.view.setUint8(address & 0x1fffffff, value);
}

function writeF32(context, address, value) {
  context.view.setFloat32(address & 0x1fffffff, value, false);
}

function writeVector(context, address, values) {
  values.forEach((value, index) => writeF32(context, address + index * 4, value));
}

function seedRaceAllocation(context) {
  const reference = 0x80010000;
  const pointerAddress = reference + 0x227878;
  const racer = 0x80400000;
  writeU32(context, 0x800030c8, reference);
  writeU32(context, pointerAddress, racer);

  writeU32(context, racer, 0x12345678);
  writeU16(context, racer + 0x004, 0);
  writeU16(context, racer + 0x006, 5);
  writeVector(context, racer + 0x07c, [10, 20, 30]);
  writeVector(context, racer + 0x088, [9, 20, 30]);
  writeVector(context, racer + 0x094, [1, 0, 0]);
  writeVector(context, racer + 0x0b8, [0, 0, 1]);
  writeVector(context, racer + 0x0ec, [0, 0, 1]);
  writeF32(context, racer + 0x17c, 1234.5);
  writeF32(context, racer + 0x184, 500);
  writeU32(context, racer + 0x194, 0);
  writeVector(context, racer + 0x1bc, [0, 0, 1]);
  writeS32(context, racer + 0x1cc, 4);
  writeF32(context, racer + 0x1d0, 0.25);
  for (const offset of [0x1f4, 0x1f8, 0x1fc, 0x204, 0x20c]) {
    writeF32(context, racer + offset, 0);
  }
  writeF32(context, racer + 0x200, 1);
  writeU16(context, racer + 0x214, 0);
  writeU8(context, racer + 0x474, 0);
  writeU32(context, racer + 0x47c, 300);
  writeU8(context, racer + 0x4b3, 0);
  writeU8(context, racer + 0x58f, 0x80);
  writeU8(context, racer + 0x590, 1);
  writeU8(context, racer + 0x593, 0);
  writeU8(context, racer + 0x5d8, 0);
  writeU8(context, racer + 0x61c, 1);
  return { pointerAddress, racer, reference };
}

function applyConsumedLeft(context, fixture, steerX = -0.75) {
  writeF32(context, fixture.racer + 0x1f4, 0);
  writeF32(context, fixture.racer + 0x1f8, 0);
  writeF32(context, fixture.racer + 0x1fc, steerX);
  writeF32(context, fixture.racer + 0x20c, steerX);
}

function publishLeft(context, overrides = {}) {
  const {
    appliedSequence = 7,
    ...publicationOverrides
  } = overrides;
  context.controllerAppliedSequence = appliedSequence;
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 42,
    scheduledCycle: 100,
    observedCycle: 105,
    buttons: 0x0001,
    sequence: 7,
    ...publicationOverrides,
  };
}

test("F-Zero diagnostics expose the documented GFZE01 Rev 0 racer block", () => {
  const context = makeContext();
  const fixture = seedRaceAllocation(context);
  const state = JSON.parse(JSON.stringify(context.inspectFzeroGameState()));

  assert.deepEqual(state.reference, {
    pointerAddress: "0x800030c8",
    value: "0x80010000",
    rawValue: "0x80010000",
    mapped: true,
  });
  assert.deepEqual(state.racerLookup, {
    pointerOffset: "0x00227878",
    pointerAddress: "0x80237878",
    rawValue: "0x80400000",
    racer: "0x80400000",
    blockSize: 0x620,
  });
  assert.equal(state.raceAllocated, true);
  assert.equal(state.vehicle.address, "0x80400000");
  assert.equal(state.vehicle.size, 0x620);
  assert.equal(state.vehicle.generalStateAddress, "0x80400000");
  assert.equal(state.vehicle.generalState, 0x12345678);
  assert.equal(state.vehicle.entrantIdAddress, "0x80400004");
  assert.equal(state.vehicle.entrantId, 0);
  assert.equal(state.vehicle.machineIdAddress, "0x80400006");
  assert.equal(state.vehicle.machineId, 5);
  assert.equal(state.vehicle.positionAddress, "0x8040007c");
  assert.deepEqual(state.vehicle.position, { x: 10, y: 20, z: 30 });
  assert.deepEqual(state.vehicle.previousPosition, { x: 9, y: 20, z: 30 });
  assert.deepEqual(state.vehicle.worldVelocity, { x: 1, y: 0, z: 0 });
  assert.deepEqual(state.vehicle.localVelocity, { x: 0, y: 0, z: 1 });
  assert.deepEqual(state.vehicle.worldOrientation, { x: 0, y: 0, z: 1 });
  assert.equal(state.vehicle.speedKphAddress, "0x8040017c");
  assert.equal(state.vehicle.speedKph, 1234.5);
  assert.equal(state.vehicle.energyAddress, "0x80400184");
  assert.equal(state.vehicle.energy, 500);
  assert.deepEqual(state.vehicle.trackOrientation, { x: 0, y: 0, z: 1 });
  assert.equal(state.vehicle.checkpoint, 4);
  assert.equal(state.vehicle.checkpointFraction, 0.25);
  assert.deepEqual(state.vehicle.input, {
    steerYAddress: "0x804001f4",
    steerY: 0,
    strafeAddress: "0x804001f8",
    strafe: 0,
    steerXAddress: "0x804001fc",
    steerX: 0,
    acceleratorAddress: "0x80400200",
    accelerator: 1,
    brakeAddress: "0x80400204",
    brake: 0,
    duplicateSteerXAddress: "0x8040020c",
    duplicateSteerX: 0,
    duplicateSteerMatches: true,
    documentedRanges: true,
  });
  assert.deepEqual(state.vehicle.lifecycle, {
    restoreCountdownAddress: "0x80400214",
    restoreCountdown: 0,
    controllerSlotAddress: "0x80400474",
    controllerSlot: 0,
    frameCountSinceStartOrRestoreAddress: "0x8040047c",
    frameCountSinceStartOrRestore: 300,
    crashBitAddress: "0x804004b3",
    crashBit: 0,
    generalState2Address: "0x8040058f",
    generalState2: 0x80,
    restoreCompletionFlagAddress: "0x80400590",
    restoreCompletionFlag: 1,
    breakDownCountdownAddress: "0x80400593",
    breakDownCountdown: 0,
    postRestoreCountdownAddress: "0x804005d8",
    postRestoreCountdown: 0,
    groundAirFlagAddress: "0x8040061c",
    groundAirFlag: 1,
  });
  assert.equal(state.vehicle.valid, true);
  assert.equal(state.vehicleValid, true);
  assert.equal(state.activeRaceCandidate, true);
  assert.equal(state.livePlayerInputPath, true);
  assert.equal(state.defaultLivePlayerInputState, true);
  assert.equal(state.lastActiveGameplayInput, null);
  assert.equal(fixture.pointerAddress, 0x80237878);
});

test("F-Zero allocation and vehicle checks fail closed without inventing a phase", () => {
  assert.equal(makeContext("GFZE01", 1).inspectFzeroGameState(), null);
  assert.equal(makeContext("GFZJ01", 0).inspectFzeroGameState(), null);

  const noReference = makeContext();
  const noReferenceState = noReference.inspectFzeroGameState();
  assert.equal(noReferenceState.reference.mapped, false);
  assert.equal(noReferenceState.racerLookup.pointerAddress, null);
  assert.equal(noReferenceState.raceAllocated, false);
  assert.equal(noReferenceState.vehicleValid, false);
  assert.equal(noReferenceState.activeRaceCandidate, false);
  assert.equal(noReferenceState.livePlayerInputPath, false);
  assert.equal(noReferenceState.defaultLivePlayerInputState, false);

  const noRace = makeContext();
  const noRaceReference = 0x80010000;
  writeU32(noRace, 0x800030c8, noRaceReference);
  writeU32(noRace, noRaceReference + 0x227878, 0);
  const noRaceState = noRace.inspectFzeroGameState();
  assert.equal(noRaceState.reference.mapped, true);
  assert.equal(noRaceState.racerLookup.rawValue, "0x00000000");
  assert.equal(noRaceState.raceAllocated, false);
  assert.equal(noRaceState.vehicle.address, null);
  assert.equal(noRaceState.activeRaceCandidate, false);
  assert.equal(noRaceState.livePlayerInputPath, false);
  assert.equal(noRaceState.defaultLivePlayerInputState, false);

  const invalidRace = makeContext();
  const invalidReference = 0x80010000;
  writeU32(invalidRace, 0x800030c8, invalidReference);
  writeU32(invalidRace, invalidReference + 0x227878, 0x817ffa00);
  const invalidRaceState = invalidRace.inspectFzeroGameState();
  assert.equal(invalidRaceState.racerLookup.rawValue, "0x817ffa00");
  assert.equal(invalidRaceState.racerLookup.racer, null);
  assert.equal(invalidRaceState.raceAllocated, false);

  const arbitraryLifecycle = makeContext();
  const arbitraryFixture = seedRaceAllocation(arbitraryLifecycle);
  writeU32(arbitraryLifecycle, arbitraryFixture.racer + 0x47c, 0);
  writeU16(arbitraryLifecycle, arbitraryFixture.racer + 0x214, 0xffff);
  writeU8(arbitraryLifecycle, arbitraryFixture.racer + 0x593, 0xff);
  const arbitraryState = arbitraryLifecycle.inspectFzeroGameState();
  assert.equal(arbitraryState.vehicle.lifecycle.frameCountSinceStartOrRestore, 0);
  assert.equal(arbitraryState.vehicle.lifecycle.restoreCountdown, 0xffff);
  assert.equal(arbitraryState.vehicle.lifecycle.breakDownCountdown, 0xff);
  assert.equal(arbitraryState.vehicleValid, true);
  assert.equal(arbitraryState.activeRaceCandidate, true);
  assert.equal(arbitraryState.livePlayerInputPath, true);
  assert.equal(arbitraryState.defaultLivePlayerInputState, true);
});

test("F-Zero vehicle validity follows documented finite fields and input ranges", () => {
  for (const [mutate, label] of [
    [
      (context, fixture) =>
        writeF32(context, fixture.racer + 0x07c, Number.NaN),
      "non-finite position",
    ],
    [
      (context, fixture) => writeF32(context, fixture.racer + 0x17c, Infinity),
      "non-finite speed",
    ],
    [
      (context, fixture) => writeF32(context, fixture.racer + 0x1f4, 1.01),
      "steer Y outside documented range",
    ],
    [
      (context, fixture) => writeF32(context, fixture.racer + 0x1f8, -1.01),
      "strafe outside documented range",
    ],
    [
      (context, fixture) => writeF32(context, fixture.racer + 0x1fc, 1.01),
      "steer X outside documented range",
    ],
    [
      (context, fixture) => writeF32(context, fixture.racer + 0x20c, 0.25),
      "duplicate steer disagreement",
    ],
  ]) {
    const context = makeContext();
    const fixture = seedRaceAllocation(context);
    mutate(context, fixture);
    const state = context.inspectFzeroGameState();
    assert.equal(state.raceAllocated, true, label);
    assert.equal(state.vehicleValid, false, label);
    assert.equal(state.activeRaceCandidate, false, label);
  }
});

test("F-Zero latches the first exact-sequence guest-consumed host-left input", () => {
  const context = makeContext();
  const fixture = seedRaceAllocation(context);
  applyConsumedLeft(context, fixture);
  publishLeft(context);

  context.sampleGuestGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.inspectFzeroGameState().lastActiveGameplayInput,
    )),
    {
      cycle: 120,
      controllerAppliedSequence: 7,
      hostPublication: {
        source: "periodic",
        pollIndex: 42,
        scheduledCycle: 100,
        observedCycle: 105,
        buttons: 0x0001,
        sequence: 7,
      },
      reference: "0x80010000",
      racer: "0x80400000",
      entrantId: 0,
      machineId: 5,
      generalState: 0x12345678,
      controllerSlot: 0,
      frameCountSinceStartOrRestore: 300,
      position: { x: 10, y: 20, z: 30 },
      worldVelocity: { x: 1, y: 0, z: 0 },
      input: {
        steerY: 0,
        strafe: 0,
        steerX: -0.75,
        duplicateSteerX: -0.75,
        accelerator: 1,
        brake: 0,
      },
      lifecycle: {
        crashBit: 0,
        restoreCountdown: 0,
        crashToRestoreFrameCounter: 0,
        restoreCompletionFlag: 1,
        breakDownCountdown: 0,
        postRestoreCountdown: 0,
      },
    },
  );

  writeVector(context, fixture.racer + 0x07c, [99, 98, 97]);
  applyConsumedLeft(context, fixture, 1);
  publishLeft(context, { sequence: 8, appliedSequence: 8 });
  context.sampleFzeroGameplayInput(140);
  assert.equal(context.fzeroLastActiveGameplayInput.cycle, 120);
  assert.equal(context.fzeroLastActiveGameplayInput.hostPublication.sequence, 7);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.fzeroLastActiveGameplayInput.position)),
    { x: 10, y: 20, z: 30 },
  );
});

test("F-Zero input latch rejects unrelated publication and consumed state", () => {
  for (const [overrides, label] of [
    [{ buttons: 0x0003 }, "non-exact host left"],
    [{ sequence: 0, appliedSequence: 0 }, "nonpositive sequence"],
    [{ sequence: 8 }, "unapplied host sequence"],
    [{ scheduledCycle: 110, observedCycle: 105 }, "reversed publication"],
    [{ observedCycle: 121 }, "future observation"],
    [{ appliedSequence: 8 }, "applied sequence mismatch"],
  ]) {
    const context = makeContext();
    const fixture = seedRaceAllocation(context);
    applyConsumedLeft(context, fixture);
    publishLeft(context, overrides);
    context.sampleFzeroGameplayInput(120);
    assert.equal(context.fzeroLastActiveGameplayInput, null, label);
  }

  for (const [mutate, label] of [
    [
      (context, fixture) => applyConsumedLeft(context, fixture, -0.49),
      "steer below witness magnitude",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU32(context, fixture.racer, 0x00000080);
      },
      "general state disables racer input",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU32(context, fixture.racer, 0x04000000);
      },
      "AI or replay input path",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU8(context, fixture.racer + 0x474, 1);
      },
      "non-P1 controller slot",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU8(context, fixture.racer + 0x474, 0xff);
      },
      "disabled controller slot",
    ],
    [
      (context, fixture) => applyConsumedLeft(context, fixture, 0.75),
      "opposite steering direction",
    ],
    [
      (context, fixture) => applyConsumedLeft(context, fixture, 1.01),
      "steer above documented range",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeF32(context, fixture.racer + 0x20c, -0.5);
      },
      "duplicate consumed steer mismatch",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeF32(context, fixture.racer + 0x1f4, 0.01);
      },
      "non-neutral steer Y",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeF32(context, fixture.racer + 0x1f8, -0.01);
      },
      "non-neutral strafe",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU8(context, fixture.racer + 0x4b3, 1);
      },
      "crashed vehicle",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU16(context, fixture.racer + 0x214, 1);
      },
      "restore countdown",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU32(context, fixture.racer + 0x194, 1);
      },
      "crash-to-restore counter",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU8(context, fixture.racer + 0x590, 0);
      },
      "input-processing state zeroes copied controls",
    ],
    ...[2, 3, 4, 5].map(value => [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU8(context, fixture.racer + 0x590, value);
      },
      `non-default input-processing state ${value}`,
    ]),
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU8(context, fixture.racer + 0x593, 1);
      },
      "break-down countdown",
    ],
    [
      (context, fixture) => {
        applyConsumedLeft(context, fixture);
        writeU8(context, fixture.racer + 0x5d8, 1);
      },
      "post-restore countdown",
    ],
  ]) {
    const context = makeContext();
    const fixture = seedRaceAllocation(context);
    mutate(context, fixture);
    publishLeft(context);
    context.sampleFzeroGameplayInput(120);
    assert.equal(context.fzeroLastActiveGameplayInput, null, label);
  }

  const noRace = makeContext();
  const reference = 0x80010000;
  writeU32(noRace, 0x800030c8, reference);
  writeU32(noRace, reference + 0x227878, 0);
  publishLeft(noRace);
  noRace.sampleFzeroGameplayInput(120);
  assert.equal(noRace.fzeroLastActiveGameplayInput, null);
});

test("guest diagnostics dispatch F-Zero only through exact retail identity", () => {
  const fzero = makeContext();
  seedRaceAllocation(fzero);
  assert.equal(fzero.inspectGuestGameState().activeRaceCandidate, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GMBE8P", 0).inspectGuestGameState())),
    { game: "smb" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GLME01", 0).inspectGuestGameState())),
    { game: "luigi" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZLE01", 0).inspectGuestGameState())),
    { game: "wind" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GALE01", 2).inspectGuestGameState())),
    { game: "melee" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZWE01", 0).inspectGuestGameState())),
    { game: "wario" },
  );
  assert.equal(makeContext("GFZE01", 1).inspectGuestGameState(), null);
  assert.match(
    source,
    /function sampleGuestGameplayInput\(sampleCycle\) \{\s+sampleLuigisMansionGameplayInput\(sampleCycle\);\s+sampleWindWakerGameplayInput\(sampleCycle\);\s+sampleMeleeGameplayInput\(sampleCycle\);\s+sampleFzeroGameplayInput\(sampleCycle\);\s+sampleWarioWareGameplayInput\(sampleCycle\);/,
  );
});
