#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const GAME_FIDELITY_V1_VERSION = 1;
export const GAME_FIDELITY_V1_BYTES = 384;
export const GAME_FIDELITY_V1_MAGIC = 0x3150_4647;
export const GAME_FIDELITY_V1_SUMMARY_SCHEMA =
  "lazuli-rust-game-fidelity-evidence-summary-v1";

const ACCEPTED_PHASE = 5;
const ACCEPTED_STATUS = 1;
const COMMON_REQUIRED_PREDICATES = 0x07ffn;
const WARIO_REQUIRED_PREDICATES = 0x0dffn;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const GAME_FIDELITY_V1_PROJECTORS = Object.freeze([
  Object.freeze({
    key: "warioware-usa",
    projector: 1,
    oracle: "warioware-repellion-a-v1",
    identifier: "GZWE01",
    revision: 0,
    buttons: 0x0100,
    requiredPredicates: WARIO_REQUIRED_PREDICATES,
  }),
  Object.freeze({
    key: "luigis-mansion-usa",
    projector: 2,
    oracle: "luigis-mansion-foyer-left-v1",
    identifier: "GLME01",
    revision: 0,
    buttons: 0x0001,
    requiredPredicates: COMMON_REQUIRED_PREDICATES,
  }),
  Object.freeze({
    key: "wind-waker-usa",
    projector: 3,
    oracle: "wind-waker-outset-left-v1",
    identifier: "GZLE01",
    revision: 0,
    buttons: 0x0001,
    requiredPredicates: COMMON_REQUIRED_PREDICATES,
  }),
  Object.freeze({
    key: "melee-usa-rev-2",
    projector: 4,
    oracle: "melee-active-match-left-v1",
    identifier: "GALE01",
    revision: 2,
    buttons: 0x0001,
    requiredPredicates: COMMON_REQUIRED_PREDICATES,
  }),
  Object.freeze({
    key: "f-zero-gx-usa",
    projector: 5,
    oracle: "fzero-gx-active-race-steer-v1",
    identifier: "GFZE01",
    revision: 0,
    buttons: 0x0001,
    requiredPredicates: COMMON_REQUIRED_PREDICATES,
  }),
  Object.freeze({
    key: "metroid-prime-usa-rev-2",
    projector: 6,
    oracle: "metroid-prime-frigate-left-turn-v1",
    identifier: "GM8E01",
    revision: 2,
    buttons: 0x0001,
    requiredPredicates: COMMON_REQUIRED_PREDICATES,
  }),
  Object.freeze({
    key: "rogue-leader-usa",
    projector: 7,
    oracle: "rogue-leader-xwing-left-control-response-v1",
    identifier: "GSWE64",
    revision: 0,
    buttons: 0x0001,
    requiredPredicates: COMMON_REQUIRED_PREDICATES,
  }),
]);

const PROJECTOR_BY_NUMBER = new Map(
  GAME_FIDELITY_V1_PROJECTORS.map(projector => [projector.projector, projector]),
);
const PROJECTOR_BY_KEY = new Map(
  GAME_FIDELITY_V1_PROJECTORS.map(projector => [projector.key, projector]),
);

function fail(path, message) {
  throw new Error(`invalid Rust GameFidelityRecordV1 at ${path}: ${message}`);
}

function exactKeys(value, expected, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(path, `expected exact keys ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
}

function decodeEnvelope(value, path) {
  exactKeys(value, ["available", "bytes", "encoding", "payload"], path);
  if (value.available !== true) fail(`${path}.available`, "expected true");
  if (value.bytes !== GAME_FIDELITY_V1_BYTES) {
    fail(`${path}.bytes`, `expected ${GAME_FIDELITY_V1_BYTES}`);
  }
  if (value.encoding !== "base64") fail(`${path}.encoding`, "expected base64");
  if (
    typeof value.payload !== "string"
    || value.payload.length === 0
    || value.payload.length % 4 !== 0
    || !CANONICAL_BASE64.test(value.payload)
  ) fail(`${path}.payload`, "expected canonical padded base64");
  const bytes = Buffer.from(value.payload, "base64");
  if (bytes.toString("base64") !== value.payload) {
    fail(`${path}.payload`, "base64 spelling is not canonical");
  }
  if (bytes.byteLength !== GAME_FIDELITY_V1_BYTES) {
    fail(`${path}.payload`, `decoded to ${bytes.byteLength} bytes`);
  }
  return bytes;
}

function u64(view, word) {
  return view.getBigUint64(word * 4, true);
}

function digest(bytes, word) {
  return bytes.subarray(word * 4, word * 4 + 32).toString("hex");
}

function presentation(view, word, serial, path) {
  const packed = view.getUint32((word + 5) * 4, true);
  const mode = packed & 0xff;
  const parity = packed >>> 8 & 0xff;
  const status = packed >>> 16 & 0xff;
  if ((packed & 0xff00_0000) !== 0) fail(`${path}.packed`, "reserved bits are not zero");
  if (mode > 2) fail(`${path}.mode`, "expected a known VI presentation mode");
  if (parity > 1) fail(`${path}.parity`, "expected a known VI field parity");
  if (status !== 2) fail(`${path}.status`, "expected Presented");
  const result = {
    renderSequence: u64(view, word),
    presentationSerial: serial,
    xfbGeneration: view.getUint32((word + 2) * 4, true),
    pairEpoch: view.getUint32((word + 3) * 4, true),
    selectedRow: view.getUint32((word + 4) * 4, true),
    mode,
    parity,
    status,
    outputWidth: view.getUint32((word + 6) * 4, true),
    outputHeight: view.getUint32((word + 7) * 4, true),
  };
  for (const field of [
    "renderSequence",
    "presentationSerial",
    "xfbGeneration",
    "pairEpoch",
    "outputWidth",
    "outputHeight",
  ]) {
    if (result[field] === 0 || result[field] === 0n) fail(`${path}.${field}`, "expected positive");
  }
  if (result.outputWidth > 2_048 || result.outputHeight > 2_048) {
    fail(path, "presentation extent exceeded 2048");
  }
  if (result.selectedRow >= result.outputHeight) {
    fail(`${path}.selectedRow`, "must be inside the output height");
  }
  return result;
}

function decimal(value) {
  return value.toString(10);
}

function presentationSummary(value) {
  return Object.freeze({
    renderSequence: decimal(value.renderSequence),
    presentationSerial: decimal(value.presentationSerial),
    xfbGeneration: value.xfbGeneration,
    pairEpoch: value.pairEpoch,
    selectedRow: value.selectedRow,
    mode: ["progressive", "single-field", "interlaced"][value.mode],
    modeCode: value.mode,
    parity: ["top", "bottom"][value.parity],
    parityCode: value.parity,
    status: "presented",
    statusCode: value.status,
    outputWidth: value.outputWidth,
    outputHeight: value.outputHeight,
  });
}

function validateWitness(projector, witness, path) {
  if (projector.projector === 1 && (witness & 0x0100) === 0) {
    fail(path, "Wario guest A witness is absent");
  }
  if (projector.projector === 2 && witness !== 0x0100_0001) {
    fail(path, "Luigi guest held witness is not exact");
  }
  if (projector.projector === 3 && witness !== 0x8000) {
    fail(path, "Wind Waker guest hold witness is not exact");
  }
  if (projector.projector === 4 && witness !== 0x0004_0001) {
    fail(path, "Melee guest pad witness is not exact");
  }
  if (projector.projector === 5) {
    const buffer = new ArrayBuffer(4);
    const witnessView = new DataView(buffer);
    witnessView.setUint32(0, witness, true);
    const steer = witnessView.getFloat32(0, true);
    if (!Number.isFinite(steer) || steer < -1 || steer > -0.5) {
      fail(path, "F-Zero guest steer witness is outside [-1, -0.5]");
    }
  }
  if (projector.projector === 6 && witness !== 0x20) {
    fail(path, "Metroid guest buttons2 witness is not exact");
  }
  if (projector.projector === 7 && witness !== 0x0001) {
    fail(path, "Rogue Leader guest pad witness is not exact");
  }
}

export function validateGameFidelityV1Envelope(
  value,
  { path = "$", expectedGameKey } = {},
) {
  const bytes = decodeEnvelope(value, path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = index => view.getUint32(index * 4, true);
  if (word(0) !== GAME_FIDELITY_V1_MAGIC) fail(`${path}.magic`, "expected GFP1");
  if (word(1) !== GAME_FIDELITY_V1_VERSION) fail(`${path}.version`, "expected version 1");
  if (word(2) !== GAME_FIDELITY_V1_BYTES) fail(`${path}.byteLength`, "expected 384");
  if (word(3) !== ACCEPTED_PHASE) fail(`${path}.phase`, "expected Accepted");
  if (word(4) !== ACCEPTED_STATUS) fail(`${path}.status`, "expected accepted status");
  if (word(5) !== 0) fail(`${path}.failure`, "expected no failure");
  const projector = PROJECTOR_BY_NUMBER.get(word(6));
  if (!projector) fail(`${path}.projector`, "unknown projector");
  if (word(7) !== 0) fail(`${path}.reserved`, "expected zero");
  const identifier = bytes.subarray(32, 38).toString("ascii");
  const revision = bytes[38];
  if (bytes[39] !== 0) fail(`${path}.identity.reserved`, "expected zero");
  if (identifier !== projector.identifier || revision !== projector.revision) {
    fail(`${path}.identity`, "does not match the selected projector");
  }
  if (expectedGameKey !== undefined) {
    const expected = PROJECTOR_BY_KEY.get(expectedGameKey);
    if (!expected) fail(`${path}.expectedGameKey`, "is outside the seven-title corpus");
    if (expected !== projector) fail(`${path}.projector`, "does not match the expected game");
  }

  const required = u64(view, 10);
  const passed = u64(view, 12);
  const failed = u64(view, 14);
  if (required !== projector.requiredPredicates) {
    fail(`${path}.requiredPredicates`, "does not match the frozen projector contract");
  }
  if (passed !== required) fail(`${path}.passedPredicates`, "must equal every required bit");
  if (failed !== 0n) fail(`${path}.failedPredicates`, "must be zero");
  const machineEpoch = u64(view, 16);
  if (machineEpoch === 0n) fail(`${path}.machineEpoch`, "expected positive");

  const cycles = {
    arm: u64(view, 18),
    armPresentation: u64(view, 20),
    publicationScheduled: u64(view, 22),
    publicationObserved: u64(view, 24),
    receipt: u64(view, 26),
    post: u64(view, 28),
    laterPresentation: u64(view, 30),
  };
  if (
    cycles.arm === 0n
    || cycles.armPresentation === 0n
    || cycles.armPresentation > cycles.arm
    || cycles.arm > cycles.publicationScheduled
    || cycles.publicationScheduled > cycles.publicationObserved
    || cycles.publicationObserved > cycles.receipt
    || cycles.receipt >= cycles.post
    || cycles.post >= cycles.laterPresentation
  ) fail(`${path}.cycles`, "arm/publication/receipt/post/presentation chronology is invalid");

  const armAppliedSequence = u64(view, 32);
  const publicationSequence = u64(view, 34);
  const receiptAppliedSequence = u64(view, 36);
  const armPresentationSerial = u64(view, 38);
  const laterPresentationSerial = u64(view, 40);
  if (
    publicationSequence === 0n
    || publicationSequence <= armAppliedSequence
    || receiptAppliedSequence !== publicationSequence
  ) fail(`${path}.sequences`, "host publication and guest receipt sequence do not match");
  const armPollIndex = word(42);
  const publicationPollIndex = word(43);
  const receiptPollIndex = word(44);
  if (
    publicationPollIndex === 0
    || publicationPollIndex <= armPollIndex
    || receiptPollIndex < publicationPollIndex
  ) fail(`${path}.pollIndexes`, "host publication and guest receipt poll chronology is invalid");
  if (word(45) !== 1 && word(45) !== 2) {
    fail(`${path}.publicationSource`, "expected periodic or direct");
  }
  if (word(46) !== projector.buttons) {
    fail(`${path}.publicationButtons`, "does not match the projector witness");
  }
  validateWitness(projector, word(47), `${path}.guestInputWitness`);

  const hashes = {
    baseline: digest(bytes, 48),
    receipt: digest(bytes, 56),
    post: digest(bytes, 64),
    publicationPacket: digest(bytes, 72),
  };
  for (const [name, hash] of Object.entries(hashes)) {
    if (/^0{64}$/.test(hash)) fail(`${path}.hashes.${name}`, "must be nonzero");
  }
  if (hashes.baseline === hashes.receipt) {
    fail(`${path}.hashes.receipt`, "must differ from the neutral baseline");
  }

  const baselinePresentation = presentation(
    view,
    80,
    armPresentationSerial,
    `${path}.baselinePresentation`,
  );
  const laterPresentation = presentation(
    view,
    88,
    laterPresentationSerial,
    `${path}.laterPresentation`,
  );
  if (
    laterPresentation.renderSequence <= baselinePresentation.renderSequence
    || laterPresentation.presentationSerial <= baselinePresentation.presentationSerial
    || laterPresentation.xfbGeneration <= baselinePresentation.xfbGeneration
    || laterPresentation.pairEpoch <= baselinePresentation.pairEpoch
    || laterPresentation.outputWidth !== baselinePresentation.outputWidth
    || laterPresentation.outputHeight !== baselinePresentation.outputHeight
    || laterPresentation.mode !== baselinePresentation.mode
  ) fail(`${path}.laterPresentation`, "did not strictly advance the baseline presentation");

  return Object.freeze({
    schema: GAME_FIDELITY_V1_SUMMARY_SCHEMA,
    canonical: true,
    version: GAME_FIDELITY_V1_VERSION,
    byteLength: GAME_FIDELITY_V1_BYTES,
    phase: "accepted",
    gameKey: projector.key,
    projector: projector.projector,
    oracle: projector.oracle,
    identifier: projector.identifier,
    revision: projector.revision,
    requiredPredicates: `0x${required.toString(16).padStart(16, "0")}`,
    machineEpoch: decimal(machineEpoch),
    cycles: Object.freeze(Object.fromEntries(
      Object.entries(cycles).map(([name, cycle]) => [name, decimal(cycle)]),
    )),
    input: Object.freeze({
      source: word(45) === 1 ? "periodic" : "direct",
      buttons: word(46),
      guestWitness: word(47),
      armPollIndex,
      publicationPollIndex,
      receiptPollIndex,
      armAppliedSequence: decimal(armAppliedSequence),
      publicationSequence: decimal(publicationSequence),
      receiptAppliedSequence: decimal(receiptAppliedSequence),
    }),
    hashes: Object.freeze(hashes),
    baselinePresentation: presentationSummary(baselinePresentation),
    laterPresentation: presentationSummary(laterPresentation),
  });
}

async function cli() {
  const values = process.argv.slice(2);
  if (values.length !== 1) {
    throw new Error("usage: resident_machine_game_fidelity_v1.mjs envelope.json");
  }
  const envelope = JSON.parse(await readFile(values[0], "utf8"));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidence: validateGameFidelityV1Envelope(envelope),
  }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
