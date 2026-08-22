// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  GAME_FIDELITY_V1_BYTES,
  GAME_FIDELITY_V1_MAGIC,
  GAME_FIDELITY_V1_PROJECTORS,
  validateGameFidelityV1Envelope,
} from "./resident_machine_game_fidelity_v1.mjs";

function putU64(words, index, value) {
  const exact = BigInt(value);
  words[index] = Number(exact & 0xffff_ffffn);
  words[index + 1] = Number(exact >> 32n);
}

function putHash(bytes, word, seed) {
  for (let index = 0; index < 32; index += 1) bytes[word * 4 + index] = seed + index;
}

function putPresentation(words, index, {
  renderSequence,
  generation,
  pairEpoch,
  selectedRow,
  mode = 1,
  parity = 0,
  width = 640,
  height = 480,
}) {
  putU64(words, index, renderSequence);
  words[index + 2] = generation;
  words[index + 3] = pairEpoch;
  words[index + 4] = selectedRow;
  words[index + 5] = mode | parity << 8 | 2 << 16;
  words[index + 6] = width;
  words[index + 7] = height;
}

function witness(projector) {
  if (projector.projector === 1) return 0x0100;
  if (projector.projector === 2) return 0x0100_0001;
  if (projector.projector === 3) return 0x8000;
  if (projector.projector === 4) return 0x0004_0001;
  if (projector.projector === 5) {
    const bytes = Buffer.alloc(4);
    bytes.writeFloatLE(-1);
    return bytes.readUInt32LE();
  }
  if (projector.projector === 6) return 0x20;
  return 0x0001;
}

export function gameFidelityEnvelope(projector = GAME_FIDELITY_V1_PROJECTORS[0]) {
  const words = new Uint32Array(GAME_FIDELITY_V1_BYTES / 4);
  words[0] = GAME_FIDELITY_V1_MAGIC;
  words[1] = 1;
  words[2] = GAME_FIDELITY_V1_BYTES;
  words[3] = 5;
  words[4] = 1;
  words[5] = 0;
  words[6] = projector.projector;
  const identity = Buffer.alloc(8);
  identity.write(projector.identifier, 0, "ascii");
  identity[6] = projector.revision;
  words[8] = identity.readUInt32LE(0);
  words[9] = identity.readUInt32LE(4);
  putU64(words, 10, projector.requiredPredicates);
  putU64(words, 12, projector.requiredPredicates);
  putU64(words, 14, 0n);
  putU64(words, 16, 7n);
  putU64(words, 18, 100n);
  putU64(words, 20, 90n);
  putU64(words, 22, 110n);
  putU64(words, 24, 120n);
  putU64(words, 26, 130n);
  putU64(words, 28, 150n);
  putU64(words, 30, 160n);
  putU64(words, 32, 5n);
  putU64(words, 34, 6n);
  putU64(words, 36, 6n);
  putU64(words, 38, 20n);
  putU64(words, 40, 21n);
  words[42] = 10;
  words[43] = 11;
  words[44] = 11;
  words[45] = 1;
  words[46] = projector.buttons;
  words[47] = witness(projector);
  putPresentation(words, 80, {
    renderSequence: 10n,
    generation: 30,
    pairEpoch: 40,
    selectedRow: 0,
  });
  putPresentation(words, 88, {
    renderSequence: 11n,
    generation: 31,
    pairEpoch: 41,
    selectedRow: 1,
    parity: 1,
  });
  const bytes = Buffer.alloc(GAME_FIDELITY_V1_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  putHash(bytes, 48, 1);
  putHash(bytes, 56, 33);
  putHash(bytes, 64, 65);
  putHash(bytes, 72, 97);
  return {
    available: true,
    bytes: GAME_FIDELITY_V1_BYTES,
    encoding: "base64",
    payload: bytes.toString("base64"),
  };
}

function mutateWord(envelope, index, value) {
  const changed = structuredClone(envelope);
  const bytes = Buffer.from(changed.payload, "base64");
  bytes.writeUInt32LE(value >>> 0, index * 4);
  changed.payload = bytes.toString("base64");
  return changed;
}

function mutateByte(envelope, index, value) {
  const bytes = Buffer.from(envelope.payload, "base64");
  bytes[index] = value;
  return { ...envelope, payload: bytes.toString("base64") };
}

function zeroHash(envelope, index) {
  const changed = structuredClone(envelope);
  const bytes = Buffer.from(changed.payload, "base64");
  bytes.fill(0, index * 4, index * 4 + 32);
  changed.payload = bytes.toString("base64");
  return changed;
}

test("all seven accepted Rust records decode under their exact projector contracts", () => {
  for (const projector of GAME_FIDELITY_V1_PROJECTORS) {
    const summary = validateGameFidelityV1Envelope(gameFidelityEnvelope(projector), {
      expectedGameKey: projector.key,
    });
    assert.equal(summary.canonical, true);
    assert.equal(summary.gameKey, projector.key);
    assert.equal(summary.oracle, projector.oracle);
    assert.equal(summary.machineEpoch, "7");
    assert.equal(summary.input.publicationSequence, "6");
    assert.equal(summary.baselinePresentation.presentationSerial, "20");
    assert.equal(summary.laterPresentation.presentationSerial, "21");
  }
});

test("Wario preserves projector one, the common causal mask, and the Repellion v2 oracle", () => {
  const wario = GAME_FIDELITY_V1_PROJECTORS[0];
  assert.equal(wario.key, "warioware-usa");
  assert.equal(wario.projector, 1);
  assert.equal(wario.oracle, "warioware-repellion-a-v2");
  assert.equal(wario.requiredPredicates, 0x07ffn);
  assert.notEqual(wario.requiredPredicates & 1n << 9n, 0n);
  assert.equal(wario.requiredPredicates & 1n << 11n, 0n);
});

test("decoder rejects noncanonical envelopes and non-accepted records", () => {
  const fixture = gameFidelityEnvelope();
  for (const changed of [
    { ...fixture, extra: true },
    { ...fixture, available: false },
    { ...fixture, bytes: 383 },
    { ...fixture, payload: `${fixture.payload}=` },
    mutateWord(fixture, 0, 0),
    mutateWord(fixture, 3, 4),
    mutateWord(fixture, 4, 2),
    mutateWord(fixture, 5, 7),
    mutateWord(fixture, 7, 1),
  ]) assert.throws(() => validateGameFidelityV1Envelope(changed));
});

test("projector identity, predicate bitmap, input witness, and hashes fail closed", () => {
  const fixture = gameFidelityEnvelope();
  for (const [changed, pattern] of [
    [mutateWord(fixture, 6, 2), /identity/],
    [mutateByte(fixture, 32, "G".charCodeAt(0) | 0x80), /identity/],
    [mutateWord(fixture, 10, 0x0dff), /requiredPredicates/],
    [mutateWord(fixture, 12, 0), /passedPredicates/],
    [mutateWord(fixture, 14, 1), /failedPredicates/],
    [mutateWord(fixture, 16, 0), /machineEpoch/],
    [mutateWord(fixture, 46, 1), /publicationButtons/],
    [mutateWord(fixture, 47, 0), /guest A witness/],
    [zeroHash(fixture, 48), /hashes\.baseline/],
  ]) assert.throws(() => validateGameFidelityV1Envelope(changed), pattern);
  assert.throws(
    () => validateGameFidelityV1Envelope(fixture, { expectedGameKey: "luigis-mansion-usa" }),
    /does not match the expected game/,
  );
});

test("cycle, sequence, poll, and presentation regressions fail closed", () => {
  const fixture = gameFidelityEnvelope();
  for (const [changed, pattern] of [
    [mutateWord(fixture, 22, 99), /cycles/],
    [mutateWord(fixture, 26, 119), /cycles/],
    [mutateWord(fixture, 28, 130), /cycles/],
    [mutateWord(fixture, 34, 5), /sequences/],
    [mutateWord(fixture, 36, 7), /sequences/],
    [mutateWord(fixture, 43, 10), /pollIndexes/],
    [mutateWord(fixture, 45, 0), /publicationSource/],
    [mutateWord(fixture, 88, 10), /laterPresentation/],
    [mutateWord(fixture, 90, 30), /laterPresentation/],
    [mutateWord(fixture, 93, 0xff02_0001), /reserved bits/],
  ]) assert.throws(() => validateGameFidelityV1Envelope(changed), pattern);
});
