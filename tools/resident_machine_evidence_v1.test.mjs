// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  MACHINE_EVIDENCE_V1_BYTES,
  MACHINE_EVIDENCE_V1_TAG,
  WARIOWARE_MACHINE_EVIDENCE_BOOT,
  validateMachineEvidenceV1Envelope,
  validateMachineEvidenceV1PublicationEnvelope,
  validateMachineEvidenceV1Transition,
} from "./resident_machine_evidence_v1.mjs";

function setU64(words, index, value) {
  const exact = BigInt(value);
  words[index] = Number(exact & 0xffff_ffffn);
  words[index + 1] = Number(exact >> 32n);
}

export function machineEvidenceEnvelope({
  snapshotSerial = 1n,
  executedCycles = 0n,
  executedInstructions = 0n,
  completedOuterSlices = 0n,
  semanticIdleCycles = 0n,
  semanticIdleJumps = 0,
  presented = false,
  diReadComplete = false,
} = {}) {
  const words = new Uint32Array(MACHINE_EVIDENCE_V1_BYTES / 4);
  words[0] = 1;
  words[1] = MACHINE_EVIDENCE_V1_BYTES;
  words[2] = MACHINE_EVIDENCE_V1_TAG;
  words[3] = 1 | 16 | (presented ? 4 : 0);
  setU64(words, 4, 1n);
  setU64(words, 6, snapshotSerial);
  setU64(words, 8, 1n);
  setU64(words, 10, 1_459_978_240n);
  words[12] = 0x475a_5745;
  words[13] = 0x3031_0000;
  words[14] = 3;
  words[15] = 0;
  words[16] = 0;
  words[17] = 0;
  words[18] = 1;
  setU64(words, 19, executedCycles);
  setU64(words, 21, executedCycles);
  setU64(words, 23, executedInstructions);
  setU64(words, 25, executedInstructions === 0n ? 0n : 2n);
  setU64(words, 27, executedInstructions);
  setU64(words, 29, completedOuterSlices);
  words[31] = 0x8000_3100;
  setU64(words, 34, diReadComplete ? 1n : 0n);
  setU64(words, 36, presented ? 1n : 0n);
  setU64(words, 38, presented ? 1n : 0n);
  if (presented) {
    setU64(words, 64, 1024n);
    setU64(words, 66, 1n);
    setU64(words, 68, 4n);
    setU64(words, 70, 1n);
    setU64(words, 72, 1n);
    setU64(words, 74, 1n);
    setU64(words, 92, 1n);
    setU64(words, 94, 1n);
    words[105] = 1;
    setU64(words, 106, 1_500n);
    setU64(words, 108, 1_600n);
    setU64(words, 110, 1_700n);
    setU64(words, 112, 1n);
    setU64(words, 114, 1n);
    words[116] = 1;
    words[117] = 0;
    words[118] = 0;
    words[119] = 0;
    words[120] = 1;
    words[121] = 2;
    words[122] = 2;
    words[123] = 4;
    words[124] = 2;
    words[125] = 2;
    words[126] = 4;
    words[127] = 2;
    words[128] = 1;
    words[129] = 2;
    words[130] = 2;
    words[131] = 2;
    words[132] = 1;
  }
  setU64(words, 153, semanticIdleCycles);
  words[155] = semanticIdleJumps;
  if (diReadComplete) {
    for (const index of [156, 158, 172, 174, 178, 186, 190, 196]) setU64(words, index, 1n);
  }
  words[200] = 0;
  words[201] = 0;
  const bytes = Buffer.alloc(MACHINE_EVIDENCE_V1_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  return {
    available: true,
    bytes: MACHINE_EVIDENCE_V1_BYTES,
    encoding: "base64",
    payload: bytes.toString("base64"),
  };
}

function mutateWord(envelope, index, value) {
  return mutateWords(envelope, [[index, value]]);
}

function mutateWords(envelope, changes) {
  const changed = structuredClone(envelope);
  const bytes = Buffer.from(changed.payload, "base64");
  for (const [index, value] of changes) bytes.writeUInt32LE(value >>> 0, index * 4);
  changed.payload = bytes.toString("base64");
  return changed;
}

test("offline decoder accepts the exact 816-byte canonical Rust shape", () => {
  const summary = validateMachineEvidenceV1Envelope(machineEvidenceEnvelope({
    snapshotSerial: 2n,
    executedCycles: 2_000n,
    executedInstructions: 1_000n,
    completedOuterSlices: 2n,
    semanticIdleCycles: 1_000n,
    semanticIdleJumps: 1,
    presented: true,
    diReadComplete: true,
  }));
  assert.equal(summary.canonical, true);
  assert.equal(summary.byteLength, 816);
  assert.equal(summary.wordLength, 204);
  assert.equal(summary.scheduler.executedInstructions, "1000");
  assert.equal(summary.semanticIdle.cycles, "1000");
  assert.equal(summary.di.readStarts, "1");
  assert.equal(summary.di.physicalHostRequestsIssued, "1");
  assert.equal(summary.gx.gxPrimitives, "1");
  assert.equal(summary.vi.chronology.presentationStatus, "presented");
  assert.equal(Object.hasOwn(summary, "boot"), false);
  assert.equal(Object.hasOwn(summary, "si"), false);
  assert.equal(JSON.stringify(summary).includes("GZLE01"), false);
});

test("Wario publication binding keeps logical disc identity private and rejects splices", () => {
  const fixture = machineEvidenceEnvelope();
  const summary = validateMachineEvidenceV1Envelope(fixture, {
    expectedBoot: WARIOWARE_MACHINE_EVIDENCE_BOOT,
  });
  assert.equal(JSON.stringify(summary).includes("GZWE01"), false);
  assert.equal(JSON.stringify(summary).includes("1459978240"), false);
  for (const [changed, pattern] of [
    [mutateWord(fixture, 12, 0x475a_4c45), /identifier did not match/],
    [mutateWord(fixture, 16, 1), /revision did not match/],
    [mutateWord(fixture, 18, 0), /format did not match/],
    [mutateWords(fixture, [[10, 889_225_792], [11, 0]]), /logical bytes did not match/],
  ]) {
    assert.throws(
      () => validateMachineEvidenceV1Envelope(changed, {
        expectedBoot: WARIOWARE_MACHINE_EVIDENCE_BOOT,
      }),
      pattern,
    );
  }
});

test("u64 evidence remains exact above Number.MAX_SAFE_INTEGER", () => {
  const value = 9_007_199_254_740_999n;
  const summary = validateMachineEvidenceV1Envelope(machineEvidenceEnvelope({
    executedCycles: value,
    executedInstructions: value,
  }));
  assert.equal(summary.scheduler.executedCycles, value.toString());
  assert.equal(summary.scheduler.executedInstructions, value.toString());
});

test("transition validator binds machine epoch and monotone snapshot chronology", () => {
  const before = machineEvidenceEnvelope({ snapshotSerial: 1n });
  const after = machineEvidenceEnvelope({
    snapshotSerial: 2n,
    executedCycles: 2_000n,
    executedInstructions: 1_000n,
    completedOuterSlices: 2n,
  });
  const transition = validateMachineEvidenceV1Transition(before, after);
  assert.deepEqual(transition.deltas, {
    canonicalCycle: "2000",
    executedCycles: "2000",
    executedInstructions: "1000",
    completedOuterSlices: "2",
    semanticIdleCycles: "0",
    semanticIdleJumps: 0,
  });
  assert.throws(
    () => validateMachineEvidenceV1Transition(after, before),
    /snapshot serial did not increase|regressed/,
  );
  assert.throws(
    () => validateMachineEvidenceV1Transition(before, mutateWord(after, 4, 2)),
    /machine epoch changed/,
  );

  const generationTwo = mutateWord(before, 25, 2);
  const generationOne = mutateWord(
    machineEvidenceEnvelope({ snapshotSerial: 2n }),
    25,
    1,
  );
  assert.doesNotThrow(
    () => validateMachineEvidenceV1Transition(generationTwo, generationOne),
    "A(gen1)->B(gen2)->A(gen1) namespace reuse must remain valid evidence",
  );

  const dspStopped = mutateWords(
    machineEvidenceEnvelope({ snapshotSerial: 2n }),
    [[3, 16 | 2], [32, 5], [33, 1]],
  );
  assert.doesNotThrow(
    () => validateMachineEvidenceV1Transition(before, dspStopped),
    "DSP LLE validity is allowed to clear when Rust records a terminal stop",
  );
  const dspInvalidBefore = mutateWord(before, 3, 16);
  assert.throws(
    () => validateMachineEvidenceV1Transition(
      dspInvalidBefore,
      machineEvidenceEnvelope({ snapshotSerial: 2n }),
    ),
    /DSP LLE validity was re-enabled/,
  );

  const stickyFaultBefore = mutateWords(
    machineEvidenceEnvelope({ snapshotSerial: 2n }),
    [[3, 16 | 2], [32, 5], [33, 1]],
  );
  const changedStickyFault = mutateWords(
    machineEvidenceEnvelope({ snapshotSerial: 3n }),
    [[3, 16 | 2], [32, 6], [33, 2]],
  );
  assert.throws(
    () => validateMachineEvidenceV1Transition(stickyFaultBefore, changedStickyFault),
    /sticky machine fault changed/,
  );

  const siBefore = mutateWords(machineEvidenceEnvelope({ snapshotSerial: 2n }), [
    [3, 1 | 16 | 8], [19, 300], [133, 2], [135, 200], [137, 300], [139, 2], [141, 2],
    [143, 2],
  ]);
  const siAfter = mutateWords(machineEvidenceEnvelope({ snapshotSerial: 3n }), [
    [3, 1 | 16 | 8], [19, 400], [133, 3], [135, 100], [137, 400], [139, 3], [141, 3],
    [143, 3],
  ]);
  assert.doesNotThrow(
    () => validateMachineEvidenceV1Transition(siBefore, siAfter),
    "SI scheduled cycle is a current chronology value, not a cumulative counter",
  );
});

test("transition rejects regression in every cumulative evidence family", () => {
  const before = machineEvidenceEnvelope({
    snapshotSerial: 2n,
    executedCycles: 2_000n,
    executedInstructions: 1_000n,
    completedOuterSlices: 2n,
    presented: true,
    diReadComplete: true,
  });
  const after = machineEvidenceEnvelope({
    snapshotSerial: 3n,
    executedCycles: 2_000n,
    executedInstructions: 1_000n,
    completedOuterSlices: 2n,
    presented: true,
    diReadComplete: true,
  });
  assert.throws(
    () => validateMachineEvidenceV1Transition(before, mutateWord(after, 34, 0)),
    /device rawDiskReads regressed/,
  );
  assert.throws(
    () => validateMachineEvidenceV1Transition(before, mutateWord(after, 64, 0)),
    /graphics gxBytes regressed/,
  );

  const rendererBefore = mutateWords(machineEvidenceEnvelope({ snapshotSerial: 2n }), [
    [92, 1], [94, 1], [105, 1],
  ]);
  assert.throws(
    () => validateMachineEvidenceV1Transition(
      rendererBefore,
      machineEvidenceEnvelope({ snapshotSerial: 3n }),
    ),
    /renderer renderRequestsIssued regressed/,
  );

  const clearedDi = mutateWords(after, [
    [156, 0], [158, 0], [172, 0], [174, 0], [178, 0], [186, 0], [190, 0], [196, 0],
  ]);
  assert.throws(
    () => validateMachineEvidenceV1Transition(before, clearedDi),
    /DI commandStarts regressed/,
  );

  const highWaterAfter = mutateWords(
    machineEvidenceEnvelope({ snapshotSerial: 3n }),
    [[92, 1], [94, 1]],
  );
  assert.throws(
    () => validateMachineEvidenceV1Transition(rendererBefore, highWaterAfter),
    /renderer renderHighWater regressed/,
  );

  const siBefore = mutateWords(
    machineEvidenceEnvelope({ snapshotSerial: 2n, executedCycles: 2_000n }),
    [[3, 1 | 8 | 16], [133, 1], [135, 100], [137, 200], [139, 2], [141, 1], [143, 1]],
  );
  const siAfter = mutateWords(
    machineEvidenceEnvelope({ snapshotSerial: 3n, executedCycles: 2_000n }),
    [[3, 1 | 8 | 16], [133, 1], [135, 100], [137, 200], [139, 1], [141, 1], [143, 1]],
  );
  assert.throws(
    () => validateMachineEvidenceV1Transition(siBefore, siAfter),
    /SI lastReceivedSequence regressed/,
  );

  const idleBefore = machineEvidenceEnvelope({
    snapshotSerial: 2n,
    executedCycles: 2_000n,
    semanticIdleCycles: 1_000n,
    semanticIdleJumps: 2,
  });
  const idleAfter = machineEvidenceEnvelope({
    snapshotSerial: 3n,
    executedCycles: 2_000n,
    semanticIdleCycles: 500n,
    semanticIdleJumps: 1,
  });
  assert.throws(
    () => validateMachineEvidenceV1Transition(idleBefore, idleAfter),
    /semantic idle cycles regressed/,
  );
});

test("envelope rejects unavailable, extra-key, noncanonical base64, and wrong byte length", () => {
  const fixture = machineEvidenceEnvelope();
  for (const changed of [
    { ...fixture, available: false, payload: null },
    { ...fixture, extra: 1 },
    { ...fixture, bytes: 815 },
    { ...fixture, payload: `${fixture.payload}=` },
    { ...fixture, payload: Buffer.alloc(812).toString("base64") },
  ]) {
    assert.throws(() => validateMachineEvidenceV1Envelope(changed));
  }
});

test("decoder rejects header, flag, scheduler, idle, DI, host, and XFB shape faults", () => {
  const plain = machineEvidenceEnvelope();
  const running = machineEvidenceEnvelope({
    snapshotSerial: 2n,
    executedCycles: 2_000n,
    executedInstructions: 1_000n,
    completedOuterSlices: 2n,
    semanticIdleCycles: 1_000n,
    semanticIdleJumps: 1,
    presented: true,
    diReadComplete: true,
  });
  const mutations = [
    mutateWord(plain, 0, 2),
    mutateWord(plain, 1, 812),
    mutateWord(plain, 2, 0),
    mutateWord(plain, 3, 0x8000_0000),
    mutateWord(plain, 31, 0x8000_3102),
    mutateWord(running, 155, 0),
    mutateWord(running, 158, 0),
    mutateWord(running, 190, 0),
    mutateWord(running, 108, 1_400),
  ];
  for (const changed of mutations) {
    assert.throws(
      () => validateMachineEvidenceV1Envelope(changed),
      /canonical shape|expected/,
    );
  }
});

test("staged interlaced VI requires no pair completion, exact dimensions, and zero serial", () => {
  const presented = machineEvidenceEnvelope({
    snapshotSerial: 2n,
    executedCycles: 2_000n,
    executedInstructions: 1_000n,
    completedOuterSlices: 2n,
    presented: true,
  });
  const staged = mutateWords(presented, [[114, 0], [118, 2], [129, 1], [132, 0]]);
  assert.doesNotThrow(() => validateMachineEvidenceV1Envelope(staged));
  for (const changed of [
    mutateWord(staged, 132, 1),
    mutateWord(staged, 130, 1),
    mutateWord(staged, 131, 1),
    mutateWord(staged, 114, 1),
  ]) {
    assert.throws(
      () => validateMachineEvidenceV1Envelope(changed),
      /canonical shape/,
    );
  }
});

test("publication gate requires healthy positive device/GX/VI and balanced renderer evidence", () => {
  const fixture = machineEvidenceEnvelope({
    snapshotSerial: 2n,
    executedCycles: 2_000n,
    executedInstructions: 1_000n,
    completedOuterSlices: 2n,
    presented: true,
    diReadComplete: true,
  });
  assert.doesNotThrow(() => validateMachineEvidenceV1PublicationEnvelope(fixture, {
    expectedBoot: WARIOWARE_MACHINE_EVIDENCE_BOOT,
  }));
  for (const [changed, pattern] of [
    [mutateWord(fixture, 38, 0), /dspLleSteps must be positive/],
    [mutateWord(fixture, 70, 0), /gxPrimitives must be positive/],
    [mutateWord(fixture, 78, 1), /decoderErrors must be zero/],
    [mutateWord(fixture, 62, 1), /DI last error is not clear/],
    [mutateWords(fixture, [
      [156, 2], [172, 2], [174, 2], [186, 2], [200, 3], [201, 2], [202, 1],
    ]), /DI physical host request remains pending/],
    [mutateWord(fixture, 100, 1), /barrier accounting is not balanced/],
    [mutateWords(fixture, [[3, 1 | 2 | 4 | 16], [32, 5], [33, 1]]), /terminal machine fault/],
  ]) {
    assert.throws(
      () => validateMachineEvidenceV1PublicationEnvelope(changed, {
        expectedBoot: WARIOWARE_MACHINE_EVIDENCE_BOOT,
      }),
      pattern,
    );
  }
});
