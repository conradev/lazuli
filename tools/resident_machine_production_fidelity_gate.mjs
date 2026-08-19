#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  GAME_FIDELITY_V1_PROJECTORS,
  validateGameFidelityV1Envelope,
} from "./resident_machine_game_fidelity_v1.mjs";
import {
  validateMachineEvidenceV1PublicationEnvelope,
  validateMachineEvidenceV1Transition,
} from "./resident_machine_evidence_v1.mjs";
import { validateResidentCorpusEvidence } from "./resident_machine_corpus_report.mjs";
import { parseFidelityCheckpointJsonl } from "./resident_machine_fidelity_checkpoint_report.mjs";
import { validateCombinedResidentFidelityEvidence } from "./resident_machine_fidelity_combined_report.mjs";
import {
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  productionSourceAuthorityFromGit,
} from "./resident_machine_fidelity_lock.mjs";
import {
  RELEASE_SCHEMA,
  RESIDENT_RUNTIME_ABI,
  RESIDENT_RUNTIME_CHOICE,
  validateRelease,
} from "../web/release.mjs";

export const PRODUCTION_FIDELITY_ATTESTATION_SCHEMA =
  "lazuli-resident-production-fidelity-attestation-v1";

const EXPECTED_CORPUS_SHA256 =
  "43597e441ab8c38adb18beed8ac34895a8496cac8ac2112ef4cb27c7504f4fc6";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const GAMECUBE_LOGICAL_BYTES = "1459978240";
const MINIMUM_SUSTAINED_VI_FIELDS = 120n;
const MINIMUM_SUSTAINED_PRESENTATIONS = 64n;
const DEFAULT_REPOSITORY_PATH = fileURLToPath(new URL("../", import.meta.url));

function fail(location, message) {
  throw new Error(`invalid production fidelity attestation at ${location}: ${message}`);
}

function object(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(location, "expected an object");
  }
  return value;
}

function array(value, location) {
  if (!Array.isArray(value)) fail(location, "expected an array");
  return value;
}

function exactKeys(value, expected, location) {
  const actual = Object.keys(object(value, location)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(location, `expected exact keys ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
}

function exact(actual, expected, location) {
  if (actual !== expected) {
    const display = value => JSON.stringify(
      value,
      (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested,
    );
    fail(location, `expected ${display(expected)}, got ${display(actual)}`);
  }
}

function exactJson(actual, expected, location) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(location, "did not match the authenticated value");
  }
}

function sha256(value, location) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(location, "expected a lowercase SHA-256 digest");
  }
  return value;
}

function positiveInteger(value, location, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(location, `expected an integer from 1 through ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value, location, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(location, `expected an integer from 0 through ${maximum}`);
  }
  return value;
}

function positiveDecimal(value, location) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    fail(location, "expected an unsigned decimal string");
  }
  const parsed = BigInt(value);
  if (parsed === 0n) fail(location, "expected positive");
  return parsed;
}

function timestamp(value, location) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail(location, "expected a canonical UTC millisecond timestamp");
  return value;
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function withKeyOrder(value, orderedKeys) {
  const keys = [
    ...orderedKeys.filter(key => Object.hasOwn(value, key)),
    ...Object.keys(value).filter(key => !orderedKeys.includes(key)),
  ];
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function descriptor(asset) {
  return Object.freeze({ url: asset.url, bytes: asset.bytes, sha256: asset.sha256 });
}

function executionAssets(release) {
  return Object.freeze({
    core: descriptor(release.runtime.core),
    dispatcher: descriptor(release.runtime.dispatcher),
    coordinator: descriptor(release.runtime.coordinator),
    adapter: descriptor(release.runtime.adapter),
    worker: descriptor(release.runtime.worker),
    frontend: descriptor(release.frontend),
    rendererJavascript: descriptor(release.renderer.javascript),
    rendererWasm: descriptor(release.renderer.wasm),
  });
}

function releaseAuthority(release, releaseBytes) {
  return Object.freeze({
    schema: release.schema,
    releaseId: release.releaseId,
    manifestBytes: releaseBytes.byteLength,
    manifestSha256: hashBytes(releaseBytes),
    sourceCommit: release.source.commit,
    executionAssetsSha256: residentReleaseExecutionAssetsSha256(release),
    executionAssets: executionAssets(release),
  });
}

export function residentReleaseExecutionAssetsSha256(release) {
  return hashBytes(canonicalJson(executionAssets(release)));
}

function firstFrameArtifacts(release) {
  return Object.freeze({
    "browser_machine.wasm": Object.freeze({
      bytes: release.runtime.core.bytes,
      sha256: release.runtime.core.sha256,
    }),
    "resident_dispatcher.wasm": Object.freeze({
      bytes: release.runtime.dispatcher.bytes,
      sha256: release.runtime.dispatcher.sha256,
    }),
    "core_run_coordinator.wasm": Object.freeze({
      bytes: release.runtime.coordinator.bytes,
      sha256: release.runtime.coordinator.sha256,
    }),
    "browser_renderer.js": Object.freeze({
      bytes: release.renderer.javascript.bytes,
      sha256: release.renderer.javascript.sha256,
    }),
    "browser_renderer_bg.wasm": Object.freeze({
      bytes: release.renderer.wasm.bytes,
      sha256: release.renderer.wasm.sha256,
    }),
  });
}

function validateCorpus(value, bytes) {
  const digest = hashBytes(bytes);
  exact(digest, EXPECTED_CORPUS_SHA256, "$.corpus.sha256");
  const corpus = object(value, "$.corpus.document");
  exactKeys(corpus, [
    "schema", "renderer", "fallbacks", "publicGameRoutes", "evidence", "games",
  ], "$.corpus.document");
  exact(corpus.schema, "lazuli-game-compatibility-corpus-v1", "$.corpus.document.schema");
  exact(corpus.renderer, "wgpu-webgpu", "$.corpus.document.renderer");
  exact(corpus.fallbacks, false, "$.corpus.document.fallbacks");
  exact(corpus.publicGameRoutes, false, "$.corpus.document.publicGameRoutes");
  exactKeys(corpus.evidence, ["sustainedViFields", "viewportFrames"], "$.corpus.document.evidence");
  exact(corpus.evidence.sustainedViFields, 120, "$.corpus.document.evidence.sustainedViFields");
  exact(corpus.evidence.viewportFrames, 64, "$.corpus.document.evidence.viewportFrames");
  const games = array(corpus.games, "$.corpus.document.games");
  exact(games.length, GAME_FIDELITY_V1_PROJECTORS.length, "$.corpus.document.games.length");
  games.forEach((gameValue, index) => {
    const location = `$.corpus.document.games[${index}]`;
    const game = object(gameValue, location);
    exactKeys(game, ["key", "priority", "file", "bytes", "image", "disc", "milestone"], location);
    const expected = GAME_FIDELITY_V1_PROJECTORS[index];
    exact(game.key, expected.key, `${location}.key`);
    exact(game.priority, index + 1, `${location}.priority`);
    positiveInteger(game.bytes, `${location}.bytes`);
    exactKeys(game.image, ["format", "sha256"], `${location}.image`);
    exact(game.image.format, "ciso", `${location}.image.format`);
    sha256(game.image.sha256, `${location}.image.sha256`);
    exactKeys(game.disc, ["identifier", "revision"], `${location}.disc`);
    exact(game.disc.identifier, expected.identifier, `${location}.disc.identifier`);
    exact(game.disc.revision, expected.revision, `${location}.disc.revision`);
    exactKeys(game.milestone, ["id", "description", "inputWitness"], `${location}.milestone`);
  });
  return games;
}

function validateFileReference(value, location) {
  const reference = object(value, location);
  exactKeys(reference, ["path", "bytes", "sha256"], location);
  if (
    typeof reference.path !== "string"
    || !EVIDENCE_PATH_PATTERN.test(reference.path)
    || reference.path.split("/").some(part => part === "." || part === "..")
    || path.isAbsolute(reference.path)
    || reference.path.includes("\\")
  ) fail(`${location}.path`, "expected a contained portable relative path");
  positiveInteger(reference.bytes, `${location}.bytes`, 128 * 1024 * 1024);
  sha256(reference.sha256, `${location}.sha256`);
  return reference;
}

async function loadReference(baseDirectory, referenceValue, location) {
  const reference = validateFileReference(referenceValue, location);
  const [realBase, candidate] = await Promise.all([
    realpath(baseDirectory),
    realpath(path.resolve(baseDirectory, reference.path)),
  ]);
  const relative = path.relative(realBase, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${location}.path`, "escaped the attestation evidence directory");
  }
  const bytes = await readFile(candidate);
  exact(bytes.byteLength, reference.bytes, `${location}.bytes`);
  exact(hashBytes(bytes), reference.sha256, `${location}.sha256`);
  return Object.freeze({ reference, bytes, path: candidate });
}

function parseJson(bytes, location) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    fail(location, `is not valid JSON: ${error.message}`);
  }
}

function parseCanonicalJson(bytes, location) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(location, `is not valid UTF-8: ${error.message}`);
  }
  const value = parseJson(source, location);
  const canonical = Buffer.from(canonicalJson(value), "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    fail(location, "expected exact recursive-key canonical UTF-8 JSON bytes");
  }
  return value;
}

function decodeCanonicalEnvelope(value, expectedBytes, location) {
  const envelope = object(value, location);
  exactKeys(envelope, ["available", "bytes", "encoding", "payload"], location);
  exact(envelope.available, true, `${location}.available`);
  exact(envelope.bytes, expectedBytes, `${location}.bytes`);
  exact(envelope.encoding, "base64", `${location}.encoding`);
  if (
    typeof envelope.payload !== "string"
    || envelope.payload.length === 0
    || envelope.payload.length % 4 !== 0
    || !CANONICAL_BASE64_PATTERN.test(envelope.payload)
  ) fail(`${location}.payload`, "expected canonical padded base64");
  const decoded = Buffer.from(envelope.payload, "base64");
  if (decoded.toString("base64") !== envelope.payload) {
    fail(`${location}.payload`, "base64 spelling is not canonical");
  }
  exact(decoded.byteLength, expectedBytes, `${location}.payload.bytes`);
  return decoded;
}

async function loadCanonicalJsonReference(baseDirectory, reference, location) {
  const file = await loadReference(baseDirectory, reference, location);
  return Object.freeze({ ...file, value: parseCanonicalJson(file.bytes, location) });
}

async function loadCanonicalEnvelopeReference(
  baseDirectory,
  reference,
  expectedBytes,
  location,
) {
  const file = await loadCanonicalJsonReference(baseDirectory, reference, location);
  return Object.freeze({
    ...file,
    opaque: decodeCanonicalEnvelope(file.value, expectedBytes, location),
  });
}

function exactJournalArtifact(payload, prefix, file, opaque, location) {
  for (const [suffix, expected] of Object.entries({
    EnvelopeBytes: file.bytes.byteLength,
    EnvelopeSha256: hashBytes(file.bytes),
    OpaqueBytes: opaque.byteLength,
    OpaqueSha256: hashBytes(opaque),
  })) exact(payload[`${prefix}${suffix}`], expected, `${location}.${prefix}${suffix}`);
}

function exactJournalBinary(payload, bytesPrefix, shaPrefix, file, location) {
  exact(payload[bytesPrefix], file.bytes.byteLength, `${location}.${bytesPrefix}`);
  exact(payload[shaPrefix], hashBytes(file.bytes), `${location}.${shaPrefix}`);
}

function machineWords(envelope) {
  const bytes = Buffer.from(envelope.payload, "base64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = word => view.getUint32(word * 4, true);
  const u64 = word => view.getBigUint64(word * 4, true);
  const siPacket = Buffer.allocUnsafe(8);
  siPacket.writeUInt32BE(u32(149), 0);
  siPacket.writeUInt32BE(u32(150), 4);
  return Object.freeze({
    machineEpoch: u64(4),
    snapshotSerial: u64(6),
    canonicalCycle: u64(19),
    executedCycles: u64(21),
    executedInstructions: u64(23),
    rawDiskReads: u64(34),
    viFields: u64(36),
    dspLleSteps: u64(38),
    gxBytes: u64(64),
    gxDrains: u64(66),
    gxCommands: u64(68),
    gxPrimitives: u64(70),
    xfbCopies: u64(72),
    presentedFrames: u64(74),
    renderRequests: u64(92),
    renderCompletions: u64(94),
    xfb: Object.freeze({
      completionCycle: u64(106),
      selectionCycle: u64(108),
      renderCompletionCycle: u64(110),
      renderSequence: u64(112),
      presentationSerial: u64(114),
      xfbGeneration: u32(116),
      selectedRow: u32(117),
      mode: u32(118),
      parity: u32(119),
      pairEpoch: u32(120),
      outputWidth: u32(124),
      outputHeight: u32(125),
      presentationStatus: u32(129),
    }),
    si: Object.freeze({
      pollIndex: u64(133),
      scheduledCycle: u64(135),
      observedCycle: u64(137),
      lastReceivedSequence: u64(139),
      appliedSequence: u64(141),
      periodicPolls: u64(143),
      directPolls: u64(145),
      packet: siPacket,
      packetSha256: hashBytes(siPacket),
      source: u32(152) === 0 ? "periodic" : "direct",
    }),
  });
}

function expectedBoot(game) {
  return Object.freeze({
    identifier: game.disc.identifier,
    revision: game.disc.revision,
    discNumber: 0,
    format: 1,
    logicalBytes: GAMECUBE_LOGICAL_BYTES,
  });
}

function lockedGame(game) {
  return Object.freeze({
    key: game.key,
    priority: game.priority,
    bytes: game.bytes,
    image: Object.freeze({
      format: game.image.format,
      sha256: game.image.sha256,
    }),
    disc: Object.freeze({
      identifier: game.disc.identifier,
      revision: game.disc.revision,
    }),
  });
}

function reportGame(game) {
  return Object.freeze({
    key: game.key,
    priority: game.priority,
    bytes: game.bytes,
    sha256: game.image.sha256,
  });
}

function rendererField(value, parity, metadata, location) {
  const field = object(value, location);
  exactKeys(field, [
    "address",
    "generation",
    "row",
    "sourceRow",
    "textureWidth",
    "textureHeight",
    "logicalWidth",
    "logicalHeight",
    "displayHeight",
    "fieldStrideBytes",
    "sourceRowStep",
    "fieldHeight",
    "rowRepeat",
    "surfaceId",
    "scanoutPolicy",
  ], location);
  for (const name of ["address", "row", "sourceRow"]) {
    nonNegativeInteger(field[name], `${location}.${name}`, 0xffff_ffff);
  }
  positiveInteger(field.surfaceId, `${location}.surfaceId`);
  for (const name of [
    "generation",
    "textureWidth",
    "textureHeight",
    "logicalWidth",
    "logicalHeight",
    "displayHeight",
    "fieldStrideBytes",
    "sourceRowStep",
    "fieldHeight",
    "rowRepeat",
  ]) positiveInteger(field[name], `${location}.${name}`, 0xffff_ffff);
  if (!new Set(["direct", "bob"]).has(field.scanoutPolicy)) {
    fail(`${location}.scanoutPolicy`, "expected direct or bob");
  }
  if (field.row >= metadata.displayHeight) fail(`${location}.row`, "is outside display height");
  if (field.sourceRow >= field.textureHeight) {
    fail(`${location}.sourceRow`, "is outside texture height");
  }
  exact(field.displayHeight, metadata.displayHeight, `${location}.displayHeight`);
  return Object.freeze({ parity, ...field });
}

function presentationIdentityFromMetadata(value, receipt, location) {
  const metadata = object(value, location);
  exactKeys(metadata, [
    "format",
    "layout",
    "width",
    "height",
    "displayWidth",
    "displayHeight",
    "presentationSerial",
    "pairEpoch",
    "presentationMode",
    "scanoutPolicy",
    "fields",
  ], location);
  exact(metadata.format, "rgba8unorm", `${location}.format`);
  exact(metadata.layout, "top-left-row-major-tight", `${location}.layout`);
  for (const name of ["width", "height", "displayWidth", "displayHeight"]) {
    positiveInteger(metadata[name], `${location}.${name}`, 2_048);
  }
  exact(metadata.width, metadata.displayWidth, `${location}.width/displayWidth`);
  exact(metadata.height, metadata.displayHeight, `${location}.height/displayHeight`);
  positiveInteger(metadata.presentationSerial, `${location}.presentationSerial`);
  positiveInteger(metadata.pairEpoch, `${location}.pairEpoch`, 0xffff_ffff);
  const modes = ["progressive", "single-field", "interlaced"];
  if (!modes.includes(metadata.presentationMode)) {
    fail(`${location}.presentationMode`, "expected a known VI presentation mode");
  }
  exact(
    metadata.scanoutPolicy,
    metadata.presentationMode === "interlaced" ? "weave" : "direct",
    `${location}.scanoutPolicy`,
  );
  const fields = object(metadata.fields, `${location}.fields`);
  const fieldNames = Object.keys(fields).sort();
  if (metadata.presentationMode !== "interlaced") {
    if (fieldNames.length !== 1 || !new Set(["top", "bottom"]).has(fieldNames[0])) {
      fail(`${location}.fields`, "non-interlaced metadata must contain exactly one parity");
    }
  } else {
    exactJson(fieldNames, ["bottom", "top"], `${location}.fields`);
  }
  const decodedFields = fieldNames.map(parity => rendererField(
    fields[parity],
    parity,
    metadata,
    `${location}.fields.${parity}`,
  ));
  const active = decodedFields.length === 1
    ? decodedFields[0]
    : [...decodedFields].sort((left, right) => right.generation - left.generation)[0];
  if (
    decodedFields.length === 2
    && decodedFields[0].generation === decodedFields[1].generation
  ) fail(`${location}.fields`, "interlaced completing parity is ambiguous");
  const renderSequence = BigInt(receipt.sequenceLo) | BigInt(receipt.sequenceHi) << 32n;
  if (renderSequence === 0n) fail(`${location}.renderSequence`, "expected positive journal sequence");
  return Object.freeze({
    renderSequence,
    presentationSerial: BigInt(metadata.presentationSerial),
    xfbGeneration: active.generation,
    pairEpoch: metadata.pairEpoch,
    selectedRow: active.row,
    mode: metadata.presentationMode,
    modeCode: modes.indexOf(metadata.presentationMode),
    parity: active.parity,
    parityCode: active.parity === "top" ? 0 : 1,
    outputWidth: metadata.displayWidth,
    outputHeight: metadata.displayHeight,
  });
}

function exactPresentation(actual, expectedSummary, location) {
  const expected = {
    renderSequence: BigInt(expectedSummary.renderSequence),
    presentationSerial: BigInt(expectedSummary.presentationSerial),
    xfbGeneration: expectedSummary.xfbGeneration,
    pairEpoch: expectedSummary.pairEpoch,
    selectedRow: expectedSummary.selectedRow,
    mode: expectedSummary.mode,
    modeCode: expectedSummary.modeCode,
    parity: expectedSummary.parity,
    parityCode: expectedSummary.parityCode,
    outputWidth: expectedSummary.outputWidth,
    outputHeight: expectedSummary.outputHeight,
  };
  exactJson(
    {
      ...actual,
      renderSequence: actual.renderSequence.toString(),
      presentationSerial: actual.presentationSerial.toString(),
    },
    {
      ...expected,
      renderSequence: expected.renderSequence.toString(),
      presentationSerial: expected.presentationSerial.toString(),
    },
    location,
  );
}

function exactMachinePresentation(machine, expected, location) {
  const actual = {
    renderSequence: machine.renderSequence.toString(),
    presentationSerial: machine.presentationSerial.toString(),
    xfbGeneration: machine.xfbGeneration,
    pairEpoch: machine.pairEpoch,
    selectedRow: machine.selectedRow,
    modeCode: machine.mode,
    parityCode: machine.parity,
    outputWidth: machine.outputWidth,
    outputHeight: machine.outputHeight,
  };
  const wanted = {
    renderSequence: expected.renderSequence.toString(),
    presentationSerial: expected.presentationSerial.toString(),
    xfbGeneration: expected.xfbGeneration,
    pairEpoch: expected.pairEpoch,
    selectedRow: expected.selectedRow,
    modeCode: expected.modeCode,
    parityCode: expected.parityCode,
    outputWidth: expected.outputWidth,
    outputHeight: expected.outputHeight,
  };
  exactJson(actual, wanted, location);
  exact(machine.presentationStatus, 2, `${location}.status`);
}

function visibleRgba(bytes, width, height, location) {
  const expectedBytes = width * height * 4;
  exact(bytes.byteLength, expectedBytes, `${location}.bytes`);
  let black = 0;
  let white = 0;
  let other = 0;
  let nonOpaque = 0;
  let firstRgb = null;
  let hasDistinctRgb = false;
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const red = bytes[offset];
    const green = bytes[offset + 1];
    const blue = bytes[offset + 2];
    const alpha = bytes[offset + 3];
    const rgb = red << 16 | green << 8 | blue;
    firstRgb ??= rgb;
    hasDistinctRgb ||= rgb !== firstRgb;
    if (alpha !== 0xff) nonOpaque += 1;
    if (red === 0 && green === 0 && blue === 0) black += 1;
    else if (red === 0xff && green === 0xff && blue === 0xff) white += 1;
    else other += 1;
  }
  if (nonOpaque !== 0) fail(location, "RGBA readback contains non-opaque pixels");
  if (other === 0) fail(location, "RGBA readback has no non-black/non-white visible pixels");
  if (!hasDistinctRgb) fail(location, "RGBA readback has fewer than two RGB colors");
  return Object.freeze({ pixels: width * height, black, white, other, uniqueRgbAtLeast: 2 });
}

async function validateFrame(
  baseDirectory,
  value,
  ownerPayload,
  expectedPresentation,
  location,
) {
  const frame = object(value, location);
  exactKeys(frame, ["metadata", "rgba"], location);
  const [metadata, rgba] = await Promise.all([
    loadCanonicalJsonReference(baseDirectory, frame.metadata, `${location}.metadata`),
    loadReference(baseDirectory, frame.rgba, `${location}.rgba`),
  ]);
  exactJournalBinary(
    ownerPayload,
    "readbackMetadataBytes",
    "readbackMetadataSha256",
    metadata,
    `${location}.metadata`,
  );
  exactJournalBinary(ownerPayload, "rgbaBytes", "rgbaSha256", rgba, `${location}.rgba`);
  const presentation = presentationIdentityFromMetadata(
    metadata.value,
    ownerPayload,
    `${location}.metadata`,
  );
  exactPresentation(presentation, expectedPresentation, `${location}.derivedPresentation`);
  const visibility = visibleRgba(
    rgba.bytes,
    presentation.outputWidth,
    presentation.outputHeight,
    `${location}.rgba`,
  );
  return Object.freeze({ metadata, presentation, rgba, visibility });
}

function requireDelta(after, before, minimum, location) {
  if (after < before || after - before < minimum) {
    fail(location, `expected a monotone delta of at least ${minimum}`);
  }
}

function validateSustainedWindow(before, after, location) {
  requireDelta(after.viFields, before.viFields, MINIMUM_SUSTAINED_VI_FIELDS, `${location}.viFields`);
  requireDelta(
    after.presentedFrames,
    before.presentedFrames,
    MINIMUM_SUSTAINED_PRESENTATIONS,
    `${location}.presentedFrames`,
  );
  for (const field of [
    "dspLleSteps",
    "gxBytes",
    "gxDrains",
    "gxCommands",
    "gxPrimitives",
    "xfbCopies",
    "renderRequests",
    "renderCompletions",
  ]) requireDelta(after[field], before[field], 1n, `${location}.${field}`);
  if (after.si.pollIndex <= before.si.pollIndex) fail(`${location}.siPollIndex`, "did not advance");
  return Object.freeze({
    viFields: (after.viFields - before.viFields).toString(),
    presentedFrames: (after.presentedFrames - before.presentedFrames).toString(),
  });
}

const CAPTURE_KINDS = Object.freeze([
  "capture-machine-initialized",
  "first-frame-renderer-owned",
  "fidelity-baseline-owned",
  "first-frame-report-bound",
  "controller-witness-published",
  "fidelity-accepted-owned",
  "fidelity-terminal",
]);

const RECEIPT_JOIN_FIELDS = Object.freeze([
  "relayRequestId",
  "renderCallOrdinal",
  "requestFlags",
  "sequenceLo",
  "sequenceHi",
  "opaqueRequestBytes",
  "opaqueRequestSha256",
  "presentedBefore",
  "receiptBytes",
  "receiptSha256",
  "presentedAfterResolution",
]);

function captureRecords(records, location) {
  const capture = Object.create(null);
  for (const kind of CAPTURE_KINDS) {
    const matches = records
      .map((record, index) => ({ record, index }))
      .filter(entry => entry.record.payload.kind === kind);
    exact(matches.length, 1, `${location}.${kind}.cardinality`);
    capture[kind] = Object.freeze(matches[0]);
  }
  const initialization = capture["capture-machine-initialized"];
  exact(initialization.index, 0, `${location}.capture-machine-initialized.order`);
  const machineSessionId = initialization.record.payload.machineSessionId;
  for (const kind of CAPTURE_KINDS.slice(1)) {
    exact(
      capture[kind].record.payload.machineSessionId,
      machineSessionId,
      `${location}.${kind}.machineSessionId`,
    );
  }
  return Object.freeze(capture);
}

function exactReceiptJoin(records, annotationEntry, location) {
  const annotation = annotationEntry.record.payload;
  const receiptIndex = records.findIndex(
    record => record.recordSha256 === annotation.receiptRecordSha256,
  );
  if (receiptIndex < 0 || receiptIndex >= annotationEntry.index) {
    fail(`${location}.receiptRecordSha256`, "did not reference an earlier journal record");
  }
  const receiptRecord = records[receiptIndex];
  exact(receiptRecord.payload.kind, "receipt-resolved", `${location}.receipt.kind`);
  for (const field of RECEIPT_JOIN_FIELDS) {
    exact(annotation[field], receiptRecord.payload[field], `${location}.${field}`);
  }
  return Object.freeze({ record: receiptRecord, index: receiptIndex });
}

function controllerPacketCandidates(buttons, stickXyCxy, triggerLrab) {
  const stick = [0, 8, 16, 24].map(shift => stickXyCxy >>> shift & 0xff);
  const trigger = [0, 8, 16, 24].map(shift => triggerLrab >>> shift & 0xff);
  const encodedButtons = (buttons | 0x0080) & 0xffff;
  const prefix = [encodedButtons >>> 8, encodedButtons & 0xff, stick[0], stick[1]];
  const lowByMode = [
    [stick[2], stick[3], trigger[0] & 0xf0 | trigger[1] >>> 4, trigger[2] & 0xf0 | trigger[3] >>> 4],
    [stick[2] & 0xf0 | stick[3] >>> 4, trigger[0], trigger[1], trigger[2] & 0xf0 | trigger[3] >>> 4],
    [stick[2] & 0xf0 | stick[3] >>> 4, trigger[0] & 0xf0 | trigger[1] >>> 4, trigger[2], trigger[3]],
    [stick[2], stick[3], trigger[0], trigger[1]],
    [stick[2], stick[3], trigger[2], trigger[3]],
  ];
  return [
    Buffer.from([...prefix, ...lowByMode[0]]),
    Buffer.from([...prefix, ...lowByMode[1]]),
    Buffer.from([...prefix, ...lowByMode[2]]),
    Buffer.from([...prefix, ...lowByMode[3]]),
    Buffer.from([...prefix, ...lowByMode[4]]),
  ];
}

function exactPublishedControllerPacket(witness, terminalMachine, fidelity, location) {
  const sequence = BigInt(witness.sequenceLo) | BigInt(witness.sequenceHi) << 32n;
  exact(sequence.toString(), fidelity.input.publicationSequence, `${location}.sequence`);
  exact(witness.buttons, fidelity.input.buttons, `${location}.buttons`);
  if (!Number.isInteger(witness.status) || witness.status < 1 || witness.status > 3) {
    fail(`${location}.status`, "expected a known successful Rust publication status");
  }
  const packets = controllerPacketCandidates(
    witness.buttons,
    witness.stickXyCxy,
    witness.triggerLrab,
  );
  if (!packets.some(candidate => candidate.equals(terminalMachine.si.packet))) {
    fail(location, "packed witness words did not produce the authenticated SI packet");
  }
  exact(
    hashBytes(terminalMachine.si.packet),
    fidelity.hashes.publicationPacket,
    `${location}.publicationPacketSha256`,
  );
}

function gameFidelityWords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.freeze({
    u32: word => view.getUint32(word * 4, true),
    u64: word => view.getBigUint64(word * 4, true),
    bytes,
  });
}

function validateBaselineGameFidelity(baselineBytes, acceptedBytes, projector, location) {
  const baseline = gameFidelityWords(baselineBytes);
  const accepted = gameFidelityWords(acceptedBytes);
  for (const [word, expected, name] of [
    [0, 0x3150_4647, "magic"],
    [1, 1, "version"],
    [2, 384, "byteLength"],
    [3, 1, "phase"],
    [4, 0, "status"],
    [5, 0, "failure"],
    [6, projector.projector, "projector"],
    [7, 0, "reserved"],
  ]) exact(baseline.u32(word), expected, `${location}.${name}`);
  if (!baselineBytes.subarray(32, 40).equals(acceptedBytes.subarray(32, 40))) {
    fail(`${location}.identity`, "differed from the Accepted projector identity");
  }
  for (const [word, name] of [[10, "requiredPredicates"], [14, "failedPredicates"]]) {
    if (baseline.u64(word) !== accepted.u64(word)) {
      fail(`${location}.${name}`, "differed from the Accepted projector contract");
    }
  }
  exact(baseline.u64(12), 0x0fn, `${location}.passedPredicates`);
  if (baseline.u64(16) === 0n || baseline.u64(16) !== accepted.u64(16)) {
    fail(`${location}.machineEpoch`, "differed from the Accepted machine epoch");
  }
  if (
    baseline.u64(18) === 0n
    || baseline.u64(20) === 0n
    || baseline.u64(20) > baseline.u64(18)
  ) fail(`${location}.cycles`, "Baseline arm chronology is invalid");
  for (const [word, name] of [
    [18, "armCycle"],
    [20, "armPresentationCycle"],
    [32, "armAppliedSequence"],
    [38, "armPresentationSerial"],
  ]) {
    if (baseline.u64(word) !== accepted.u64(word)) {
      fail(`${location}.${name}`, "differed from the Accepted Baseline observation");
    }
  }
  exact(baseline.u32(42), accepted.u32(42), `${location}.armPollIndex`);
  for (const [word, name] of [[22, "publication"], [24, "observation"], [26, "receipt"], [28, "post"], [30, "laterPresentation"], [34, "publicationSequence"], [36, "receiptSequence"], [40, "laterPresentationSerial"]]) {
    exact(baseline.u64(word), 0n, `${location}.${name}`);
  }
  for (const [word, name] of [[43, "publicationPoll"], [44, "receiptPoll"], [45, "publicationSource"], [46, "publicationButtons"], [47, "guestWitness"]]) {
    exact(baseline.u32(word), 0, `${location}.${name}`);
  }
  if (!baselineBytes.subarray(48 * 4, 56 * 4).equals(acceptedBytes.subarray(48 * 4, 56 * 4))) {
    fail(`${location}.baselineHash`, "differed from the Accepted Baseline hash");
  }
  if (!baselineBytes.subarray(80 * 4, 88 * 4).equals(acceptedBytes.subarray(80 * 4, 88 * 4))) {
    fail(`${location}.presentation`, "differed from the Accepted Baseline presentation");
  }
  if (baseline.u64(38) !== accepted.u64(38)) {
    fail(`${location}.presentationSerial`, "differed from the Accepted Baseline serial");
  }
  for (const [start, end, name] of [[56, 80, "futureHashes"], [88, 96, "laterPresentation"]]) {
    if (baselineBytes.subarray(start * 4, end * 4).some(byte => byte !== 0)) {
      fail(`${location}.${name}`, "must be zero at Baseline");
    }
  }
  return Object.freeze({
    machineEpoch: baseline.u64(16),
    armCycle: baseline.u64(18),
    armAppliedSequence: baseline.u64(32),
    armPollIndex: baseline.u32(42),
  });
}

function nonNegativeDecimal(value, location) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    fail(location, "expected an unsigned decimal string");
  }
  return BigInt(value);
}

function validateCumulativeRunSummary(value, lock, terminalMachine, location) {
  const summary = object(value, location);
  exactKeys(summary, [
    "schema",
    "issuedRunCalls",
    "reportedExecutedCycles",
    "reportedExecutedInstructions",
    "reportedHostCalls",
    "reportedColdInstalls",
    "operatorPublications",
    "witnessPublications",
    "zeroProgressSlices",
    "consecutiveZeroProgressSlices",
    "maximumConsecutiveZeroProgressSlices",
    "elapsedWallMs",
    "wallTimeoutMs",
    "accepted",
  ], location);
  exact(summary.schema, "lazuli-resident-cumulative-run-summary-v1", `${location}.schema`);
  positiveInteger(summary.issuedRunCalls, `${location}.issuedRunCalls`);
  const reportedCycles = nonNegativeDecimal(
    summary.reportedExecutedCycles,
    `${location}.reportedExecutedCycles`,
  );
  const reportedInstructions = nonNegativeDecimal(
    summary.reportedExecutedInstructions,
    `${location}.reportedExecutedInstructions`,
  );
  const instructionCap = BigInt(lock.runPolicy.instructionUpperCap);
  const cycleCap = BigInt(lock.runPolicy.executedCycleUpperCap);
  if (reportedCycles > terminalMachine.executedCycles || reportedCycles > cycleCap) {
    fail(`${location}.reportedExecutedCycles`, "exceeded terminal MachineEvidence or the lock cap");
  }
  if (
    reportedInstructions > terminalMachine.executedInstructions
    || reportedInstructions > instructionCap
  ) {
    fail(
      `${location}.reportedExecutedInstructions`,
      "exceeded terminal MachineEvidence or the lock cap",
    );
  }
  if (terminalMachine.executedCycles > cycleCap) {
    fail(`${location}.terminalExecutedCycles`, "exceeded the immutable lock cap");
  }
  if (terminalMachine.executedInstructions > instructionCap) {
    fail(`${location}.terminalExecutedInstructions`, "exceeded the immutable lock cap");
  }
  nonNegativeInteger(
    summary.reportedHostCalls,
    `${location}.reportedHostCalls`,
    lock.runPolicy.totalHostCallCap,
  );
  nonNegativeInteger(
    summary.reportedColdInstalls,
    `${location}.reportedColdInstalls`,
    lock.runPolicy.totalColdInstallCap,
  );
  exact(
    lock.capturePolicy.genericOperatorPolicy.maximumPublications,
    PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
    `${location}.operatorPublicationCap`,
  );
  nonNegativeInteger(
    summary.operatorPublications,
    `${location}.operatorPublications`,
    PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  );
  exact(summary.witnessPublications, 1, `${location}.witnessPublications`);
  for (const field of [
    "zeroProgressSlices",
    "consecutiveZeroProgressSlices",
    "maximumConsecutiveZeroProgressSlices",
  ]) nonNegativeInteger(summary[field], `${location}.${field}`);
  if (
    summary.consecutiveZeroProgressSlices > summary.maximumConsecutiveZeroProgressSlices
    || summary.maximumConsecutiveZeroProgressSlices > summary.zeroProgressSlices
    || summary.maximumConsecutiveZeroProgressSlices >= lock.runPolicy.zeroProgressSliceCap
  ) fail(location, "zero-progress accounting or cap is invalid");
  nonNegativeInteger(summary.elapsedWallMs, `${location}.elapsedWallMs`);
  exact(
    summary.wallTimeoutMs,
    Math.min(lock.runPolicy.runTimeoutMs, lock.runPolicy.externalWallTimeoutMs),
    `${location}.wallTimeoutMs`,
  );
  if (summary.elapsedWallMs >= summary.wallTimeoutMs) {
    fail(`${location}.elapsedWallMs`, "exceeded the immutable wall timeout");
  }
  exact(summary.accepted, true, `${location}.accepted`);
  return Object.freeze({
    reportedCycles,
    reportedInstructions,
    operatorPublications: summary.operatorPublications,
  });
}

function exactReportArtifacts(report, expected, location) {
  exactJson(report?.artifacts?.artifacts, expected, location);
}

async function validatePerformance(
  baseDirectory,
  value,
  release,
  corpusGames,
  assetsSha256,
  authority,
  sourceAuthority,
) {
  const location = "$.controlledPerformance";
  const performance = object(value, location);
  exactKeys(performance, [
    "runId", "releaseId", "executionAssetsSha256", "runtimeAssets", "report", "lock",
  ], location);
  if (typeof performance.runId !== "string" || !UUID_PATTERN.test(performance.runId)) {
    fail(`${location}.runId`, "expected a UUID");
  }
  exact(performance.releaseId, release.releaseId, `${location}.releaseId`);
  exact(performance.executionAssetsSha256, assetsSha256, `${location}.executionAssetsSha256`);
  const expectedRuntimeAssets = executionAssets(release);
  exactKeys(performance.runtimeAssets, Object.keys(expectedRuntimeAssets), `${location}.runtimeAssets`);
  for (const [role, expected] of Object.entries(expectedRuntimeAssets)) {
    const runtimeFile = await loadReference(
      baseDirectory,
      performance.runtimeAssets[role],
      `${location}.runtimeAssets.${role}`,
    );
    exact(runtimeFile.reference.bytes, expected.bytes, `${location}.runtimeAssets.${role}.bytes`);
    exact(runtimeFile.reference.sha256, expected.sha256, `${location}.runtimeAssets.${role}.sha256`);
  }
  const [reportFile, lockFile] = await Promise.all([
    loadReference(baseDirectory, performance.report, `${location}.report`),
    loadReference(baseDirectory, performance.lock, `${location}.lock`),
  ]);
  const report = parseJson(reportFile.bytes, `${location}.report`);
  const lock = parseJson(lockFile.bytes, `${location}.lock`);
  const expectedArtifacts = firstFrameArtifacts(release);
  const expectedLockAuthority = {
    release: authority,
    run: {
      runId: performance.runId,
      selectedGameKeys: corpusGames.map(game => game.key),
    },
    sourceCorpusSha256: EXPECTED_CORPUS_SHA256,
    games: corpusGames.map(reportGame),
    artifacts: {
      schema: "lazuli-resident-corpus-artifacts-v1",
      artifacts: expectedArtifacts,
    },
    sources: sourceAuthority,
  };
  validateResidentCorpusEvidence(report, {
    requireComplete: true,
    requireAll: true,
    trustedLock: lock,
    expectedAuthority: expectedLockAuthority,
    evidenceLockSha256: lockFile.reference.sha256,
  });
  exactReportArtifacts(report, expectedArtifacts, `${location}.report.artifacts`);
  exactJson(lock.artifacts?.artifacts, expectedArtifacts, `${location}.lock.artifacts`);
  exact(
    report.corpus.sourceCorpusSha256,
    EXPECTED_CORPUS_SHA256,
    `${location}.report.corpus.sourceCorpusSha256`,
  );
  exactJson(
    report.corpus.selectedGameKeys,
    corpusGames.map(game => game.key),
    `${location}.report.corpus.selectedGameKeys`,
  );
  exact(report.policy.measurementMode, "fixed-instruction-progress", `${location}.measurementMode`);
  return Object.freeze({ report, lock });
}

async function validateGameRun(
  baseDirectory,
  value,
  index,
  game,
  release,
  assetsSha256,
  attestationCreatedAt,
  authority,
  corpusBytes,
  sourceAuthority,
) {
  const location = `$.games[${index}]`;
  const run = object(value, location);
  exactKeys(run, [
    "key",
    "runId",
    "capturedAt",
    "releaseId",
    "executionAssetsSha256",
    "operatorPublications",
    "evidenceLock",
    "checkpointJournal",
    "firstFrameReport",
    "readyMachineEvidence",
    "baselineGameFidelityRecord",
    "baselineMachineEvidence",
    "preWitnessMachineEvidence",
    "terminalMachineEvidence",
    "gameFidelityRecord",
    "frames",
  ], location);
  exact(run.key, game.key, `${location}.key`);
  if (typeof run.runId !== "string" || !UUID_PATTERN.test(run.runId)) {
    fail(`${location}.runId`, "expected a UUID");
  }
  timestamp(run.capturedAt, `${location}.capturedAt`);
  if (Date.parse(run.capturedAt) > Date.parse(attestationCreatedAt)) {
    fail(`${location}.capturedAt`, "is later than the attestation timestamp");
  }
  exact(run.releaseId, release.releaseId, `${location}.releaseId`);
  exact(run.executionAssetsSha256, assetsSha256, `${location}.executionAssetsSha256`);
  exactKeys(run.operatorPublications, ["algorithm", "count"], `${location}.operatorPublications`);
  exactKeys(run.frames, ["firstVisible", "baseline", "later"], `${location}.frames`);

  const [
    lockFile,
    journalFile,
    reportFile,
    readyFile,
    baselineFidelityFile,
    baselineMachineFile,
    preWitnessFile,
    terminalFile,
    fidelityFile,
    firstVisibleFile,
  ] = await Promise.all([
    loadReference(baseDirectory, run.evidenceLock, `${location}.evidenceLock`),
    loadReference(baseDirectory, run.checkpointJournal, `${location}.checkpointJournal`),
    loadCanonicalJsonReference(
      baseDirectory,
      run.firstFrameReport,
      `${location}.firstFrameReport`,
    ),
    loadCanonicalEnvelopeReference(
      baseDirectory,
      run.readyMachineEvidence,
      816,
      `${location}.readyMachineEvidence`,
    ),
    loadCanonicalEnvelopeReference(
      baseDirectory,
      run.baselineGameFidelityRecord,
      384,
      `${location}.baselineGameFidelityRecord`,
    ),
    loadCanonicalEnvelopeReference(
      baseDirectory,
      run.baselineMachineEvidence,
      816,
      `${location}.baselineMachineEvidence`,
    ),
    loadCanonicalEnvelopeReference(
      baseDirectory,
      run.preWitnessMachineEvidence,
      816,
      `${location}.preWitnessMachineEvidence`,
    ),
    loadCanonicalEnvelopeReference(
      baseDirectory,
      run.terminalMachineEvidence,
      816,
      `${location}.terminalMachineEvidence`,
    ),
    loadCanonicalEnvelopeReference(
      baseDirectory,
      run.gameFidelityRecord,
      384,
      `${location}.gameFidelityRecord`,
    ),
    loadReference(baseDirectory, run.frames.firstVisible, `${location}.frames.firstVisible`),
  ]);
  const lock = parseJson(lockFile.bytes, `${location}.evidenceLock`);
  const records = parseFidelityCheckpointJsonl(journalFile.bytes.toString("utf8"));
  const report = reportFile.value;
  const readyEnvelope = readyFile.value;
  const baselineFidelityEnvelope = baselineFidelityFile.value;
  const baselineMachineEnvelope = baselineMachineFile.value;
  const preWitnessEnvelope = preWitnessFile.value;
  const terminalEnvelope = terminalFile.value;
  const fidelityEnvelope = fidelityFile.value;
  const reportArtifacts = firstFrameArtifacts(release);
  const boot = expectedBoot(game);
  const expectedLockAuthority = {
    release: authority,
    run: { runId: run.runId, gameKey: game.key },
    corpus: {
      workspacePath: "tools/compatibility/games/corpus.json",
      bytes: corpusBytes.byteLength,
      sha256: EXPECTED_CORPUS_SHA256,
    },
    selectedGame: lockedGame(game),
    artifacts: reportArtifacts,
    sources: sourceAuthority,
  };
  const prefixKindOrder = [];
  for (const record of records.slice(0, report.game.fidelityCheckpoints.recordCount)) {
    if (!prefixKindOrder.includes(record.payload.kind)) prefixKindOrder.push(record.payload.kind);
  }
  const combinedReport = structuredClone(report);
  combinedReport.artifacts.artifacts = withKeyOrder(
    combinedReport.artifacts.artifacts,
    Object.keys(lock.artifacts),
  );
  combinedReport.game.game = withKeyOrder(
    combinedReport.game.game,
    ["key", "priority", "bytes", "sha256"],
  );
  combinedReport.game.fidelityCheckpoints.kindCounts = withKeyOrder(
    combinedReport.game.fidelityCheckpoints.kindCounts,
    prefixKindOrder,
  );
  const combined = validateCombinedResidentFidelityEvidence({
    report: combinedReport,
    reportBytes: reportFile.bytes,
    records,
    lock,
    evidenceLockSha256: lockFile.reference.sha256,
  }, {
    expectedArtifacts: reportArtifacts,
    expectedBoot: boot,
    expectedLockAuthority,
  });
  exact(combined.runId, run.runId, `${location}.checkpointJournal.runId`);
  exact(combined.gameKey, game.key, `${location}.checkpointJournal.gameKey`);
  exact(report.corpus.selectedGameKey, game.key, `${location}.firstFrameReport.corpus.selectedGameKey`);
  exact(report.game.game.bytes, game.bytes, `${location}.firstFrameReport.game.bytes`);
  exact(report.game.game.sha256, game.image.sha256, `${location}.firstFrameReport.game.sha256`);
  exact(
    report.game.fidelityCheckpoints.runId,
    run.runId,
    `${location}.firstFrameReport.fidelityCheckpoints.runId`,
  );
  exactReportArtifacts(report, reportArtifacts, `${location}.firstFrameReport.artifacts`);

  const capture = captureRecords(records, `${location}.checkpointJournal.capture`);
  const initialized = capture["capture-machine-initialized"];
  const firstOwned = capture["first-frame-renderer-owned"];
  const baselineOwned = capture["fidelity-baseline-owned"];
  const reportBound = capture["first-frame-report-bound"];
  const witness = capture["controller-witness-published"];
  const acceptedOwned = capture["fidelity-accepted-owned"];
  const terminal = capture["fidelity-terminal"];
  exactJson(
    initialized.record.payload.runPolicy,
    lock.runPolicy,
    `${location}.checkpointJournal.capture-machine-initialized.runPolicy`,
  );
  exactJson(
    initialized.record.payload.runSummary,
    {
      schema: "lazuli-resident-cumulative-run-summary-v1",
      issuedRunCalls: 0,
      reportedExecutedCycles: "0",
      reportedExecutedInstructions: "0",
      reportedHostCalls: 0,
      reportedColdInstalls: 0,
      zeroProgressSlices: 0,
      consecutiveZeroProgressSlices: 0,
      maximumConsecutiveZeroProgressSlices: 0,
      operatorPublications: 0,
      witnessPublications: 0,
      elapsedWallMs: 0,
      wallTimeoutMs: Math.min(lock.runPolicy.runTimeoutMs, lock.runPolicy.externalWallTimeoutMs),
      accepted: false,
    },
    `${location}.checkpointJournal.capture-machine-initialized.runSummary`,
  );
  const firstReceipt = exactReceiptJoin(
    records,
    firstOwned,
    `${location}.checkpointJournal.firstFrameReceipt`,
  );
  const baselineReceipt = exactReceiptJoin(
    records,
    baselineOwned,
    `${location}.checkpointJournal.baselineReceipt`,
  );
  exactReceiptJoin(
    records,
    acceptedOwned,
    `${location}.checkpointJournal.acceptedReceipt`,
  );
  exact(
    reportBound.record.payload.firstFrameRendererRecordSha256,
    firstOwned.record.recordSha256,
    `${location}.checkpointJournal.report.firstFrameRendererRecordSha256`,
  );
  exact(
    witness.record.payload.baselineRecordSha256,
    baselineOwned.record.recordSha256,
    `${location}.checkpointJournal.witness.baselineRecordSha256`,
  );
  exact(
    witness.record.payload.firstFrameReportRecordSha256,
    reportBound.record.recordSha256,
    `${location}.checkpointJournal.witness.firstFrameReportRecordSha256`,
  );
  exact(
    acceptedOwned.record.payload.witnessRecordSha256,
    witness.record.recordSha256,
    `${location}.checkpointJournal.accepted.witnessRecordSha256`,
  );
  exact(
    terminal.record.payload.baselineRecordSha256,
    baselineOwned.record.recordSha256,
    `${location}.checkpointJournal.terminal.baselineRecordSha256`,
  );
  exact(
    terminal.record.payload.acceptedRecordSha256,
    acceptedOwned.record.recordSha256,
    `${location}.checkpointJournal.terminal.acceptedRecordSha256`,
  );

  exactJournalArtifact(
    initialized.record.payload,
    "machineEvidence",
    readyFile,
    readyFile.opaque,
    `${location}.checkpointJournal.capture-machine-initialized`,
  );
  exactJournalArtifact(
    baselineOwned.record.payload,
    "gameFidelity",
    baselineFidelityFile,
    baselineFidelityFile.opaque,
    `${location}.checkpointJournal.fidelity-baseline-owned`,
  );
  exactJournalArtifact(
    baselineOwned.record.payload,
    "machineEvidence",
    baselineMachineFile,
    baselineMachineFile.opaque,
    `${location}.checkpointJournal.fidelity-baseline-owned`,
  );
  exactJournalArtifact(
    witness.record.payload,
    "machineEvidence",
    preWitnessFile,
    preWitnessFile.opaque,
    `${location}.checkpointJournal.controller-witness-published`,
  );
  for (const [entry, entryLocation] of [
    [acceptedOwned, "fidelity-accepted-owned"],
    [terminal, "fidelity-terminal"],
  ]) {
    exactJournalArtifact(
      entry.record.payload,
      "gameFidelity",
      fidelityFile,
      fidelityFile.opaque,
      `${location}.checkpointJournal.${entryLocation}`,
    );
    exactJournalArtifact(
      entry.record.payload,
      "machineEvidence",
      terminalFile,
      terminalFile.opaque,
      `${location}.checkpointJournal.${entryLocation}`,
    );
  }

  const reportEnvelope = report.game.adapterDiagnostics.final.machineEvidence;
  const reportMachine = machineWords(reportEnvelope);
  const terminalSummary = validateMachineEvidenceV1PublicationEnvelope(terminalEnvelope, {
    path: `${location}.terminalMachineEvidence`,
    expectedBoot: boot,
  });
  validateMachineEvidenceV1Transition(reportEnvelope, terminalEnvelope, {
    beforePath: `${location}.firstFrameReport.game.adapterDiagnostics.final.machineEvidence`,
    afterPath: `${location}.terminalMachineEvidence`,
    expectedBoot: boot,
  });
  const terminalMachine = machineWords(terminalEnvelope);

  const reportReadyEnvelope = report.game.adapterDiagnostics.ready.machineEvidence;
  const reportReadyBytes = Buffer.from(canonicalJson(reportReadyEnvelope), "utf8");
  if (!reportReadyBytes.equals(readyFile.bytes)) {
    fail(`${location}.readyMachineEvidence`, "differed from the report ready boundary");
  }
  const orderedIntermediate = [
    {
      index: reportBound.index,
      envelope: reportEnvelope,
      path: `${location}.firstFrameReport`,
    },
    {
      index: baselineOwned.index,
      envelope: baselineMachineEnvelope,
      path: `${location}.baselineMachineEvidence`,
    },
  ].sort((left, right) => left.index - right.index);
  let priorEnvelope = readyEnvelope;
  let priorPath = `${location}.readyMachineEvidence`;
  for (const observation of orderedIntermediate) {
    validateMachineEvidenceV1Transition(priorEnvelope, observation.envelope, {
      beforePath: priorPath,
      afterPath: observation.path,
      expectedBoot: boot,
    });
    priorEnvelope = observation.envelope;
    priorPath = observation.path;
  }
  validateMachineEvidenceV1Transition(priorEnvelope, preWitnessEnvelope, {
    beforePath: priorPath,
    afterPath: `${location}.preWitnessMachineEvidence`,
    expectedBoot: boot,
  });
  validateMachineEvidenceV1Transition(preWitnessEnvelope, terminalEnvelope, {
    beforePath: `${location}.preWitnessMachineEvidence`,
    afterPath: `${location}.terminalMachineEvidence`,
    expectedBoot: boot,
  });
  validateMachineEvidenceV1PublicationEnvelope(baselineMachineEnvelope, {
    path: `${location}.baselineMachineEvidence`,
    expectedBoot: boot,
  });
  validateMachineEvidenceV1PublicationEnvelope(preWitnessEnvelope, {
    path: `${location}.preWitnessMachineEvidence`,
    expectedBoot: boot,
  });
  const baselineMachine = machineWords(baselineMachineEnvelope);
  const preWitnessMachine = machineWords(preWitnessEnvelope);

  const fidelity = validateGameFidelityV1Envelope(fidelityEnvelope, {
    path: `${location}.gameFidelityRecord`,
    expectedGameKey: game.key,
  });
  exact(
    fidelity.machineEpoch,
    terminalMachine.machineEpoch.toString(),
    `${location}.gameFidelityRecord.machineEpoch`,
  );
  exact(
    terminalMachine.machineEpoch,
    reportMachine.machineEpoch,
    `${location}.terminalMachineEvidence.machineEpoch`,
  );
  if (terminalMachine.snapshotSerial <= reportMachine.snapshotSerial) {
    fail(`${location}.terminalMachineEvidence.snapshotSerial`, "did not advance first-frame evidence");
  }

  const readback = report.game.firstPresentedXfb.readback;
  const firstMetadata = readback.metadata;
  if (firstMetadata.width > 2_048 || firstMetadata.height > 2_048) {
    fail(`${location}.firstFrameReport.readback`, "production extent exceeded 2048");
  }
  exact(firstVisibleFile.bytes.byteLength, readback.rgbaBytes, `${location}.frames.firstVisible.bytes`);
  exact(hashBytes(firstVisibleFile.bytes), readback.rgbaSha256, `${location}.frames.firstVisible.sha256`);
  exactJournalBinary(
    firstOwned.record.payload,
    "readbackMetadataBytes",
    "readbackMetadataSha256",
    {
      bytes: Buffer.from(canonicalJson(firstMetadata), "utf8"),
    },
    `${location}.checkpointJournal.first-frame-renderer-owned.metadata`,
  );
  exactJournalBinary(
    firstOwned.record.payload,
    "rgbaBytes",
    "rgbaSha256",
    firstVisibleFile,
    `${location}.checkpointJournal.first-frame-renderer-owned.rgba`,
  );
  const firstPresentation = presentationIdentityFromMetadata(
    firstMetadata,
    firstOwned.record.payload,
    `${location}.firstFrameReport.readback.metadata`,
  );
  exactMachinePresentation(
    reportMachine.xfb,
    firstPresentation,
    `${location}.firstFrameReport.machineEvidence.xfb`,
  );
  const firstVisibility = visibleRgba(
    firstVisibleFile.bytes,
    firstMetadata.width,
    firstMetadata.height,
    `${location}.frames.firstVisible`,
  );
  exact(
    reportMachine.xfb.presentationSerial.toString(),
    String(firstMetadata.presentationSerial),
    `${location}.firstFrameReport.readback.presentationSerial`,
  );
  exact(reportMachine.xfb.pairEpoch, firstMetadata.pairEpoch, `${location}.firstFrameReport.readback.pairEpoch`);
  exact(reportMachine.xfb.outputWidth, firstMetadata.width, `${location}.firstFrameReport.readback.width`);
  exact(reportMachine.xfb.outputHeight, firstMetadata.height, `${location}.firstFrameReport.readback.height`);
  exact(
    ["progressive", "single-field", "interlaced"][reportMachine.xfb.mode],
    firstMetadata.presentationMode,
    `${location}.firstFrameReport.readback.presentationMode`,
  );
  const firstTrigger = report.game.firstPresentedXfb.trigger;
  const firstTriggerSequence = BigInt(firstTrigger.sequenceLo)
    | BigInt(firstTrigger.sequenceHi) << 32n;
  exact(
    reportMachine.xfb.renderSequence,
    firstTriggerSequence,
    `${location}.firstFrameReport.trigger.renderSequence`,
  );
  for (const field of [
    "relayRequestId",
    "renderCallOrdinal",
    "requestFlags",
    "sequenceLo",
    "sequenceHi",
    "opaqueRequestBytes",
    "opaqueRequestSha256",
  ]) {
    exact(
      firstOwned.record.payload[field],
      firstTrigger[field],
      `${location}.checkpointJournal.first-frame-renderer-owned.${field}`,
    );
  }
  exact(
    firstOwned.record.payload.receiptBytes,
    report.game.firstPresentedXfb.receipt.bytes,
    `${location}.checkpointJournal.first-frame-renderer-owned.receiptBytes`,
  );
  exact(
    firstOwned.record.payload.receiptSha256,
    report.game.firstPresentedXfb.receipt.sha256,
    `${location}.checkpointJournal.first-frame-renderer-owned.receiptSha256`,
  );
  const firstParity = reportMachine.xfb.parity === 0 ? "top" : "bottom";
  const firstField = object(
    firstMetadata.fields[firstParity],
    `${location}.firstFrameReport.readback.fields.${firstParity}`,
  );
  exact(
    firstField.generation,
    reportMachine.xfb.xfbGeneration,
    `${location}.firstFrameReport.readback.fields.${firstParity}.generation`,
  );

  const [baseline, later] = await Promise.all([
    validateFrame(
      baseDirectory,
      run.frames.baseline,
      baselineOwned.record.payload,
      fidelity.baselinePresentation,
      `${location}.frames.baseline`,
    ),
    validateFrame(
      baseDirectory,
      run.frames.later,
      acceptedOwned.record.payload,
      fidelity.laterPresentation,
      `${location}.frames.later`,
    ),
  ]);
  if (baseline.rgba.reference.sha256 === later.rgba.reference.sha256) {
    fail(`${location}.frames.later.rgba.sha256`, "did not change from the baseline presentation");
  }
  if (baselineReceipt.record.recordSha256 === firstReceipt.record.recordSha256) {
    const firstMetadataBytes = Buffer.from(canonicalJson(firstMetadata), "utf8");
    if (!baseline.metadata.bytes.equals(firstMetadataBytes)) {
      fail(`${location}.frames.baseline.metadata`, "same-receipt Baseline differed from first frame");
    }
    if (!baseline.rgba.bytes.equals(firstVisibleFile.bytes)) {
      fail(`${location}.frames.baseline.rgba`, "same-receipt Baseline differed from first frame");
    }
  }
  exactMachinePresentation(
    baselineMachine.xfb,
    baseline.presentation,
    `${location}.baselineMachineEvidence.xfb`,
  );
  exactMachinePresentation(
    terminalMachine.xfb,
    later.presentation,
    `${location}.terminalMachineEvidence.xfb`,
  );
  const cycles = Object.fromEntries(
    Object.entries(fidelity.cycles).map(([name, cycle]) => [name, BigInt(cycle)]),
  );
  const baselineRecord = validateBaselineGameFidelity(
    baselineFidelityFile.opaque,
    fidelityFile.opaque,
    GAME_FIDELITY_V1_PROJECTORS[index],
    `${location}.baselineGameFidelityRecord`,
  );
  exact(
    baselineRecord.machineEpoch,
    terminalMachine.machineEpoch,
    `${location}.baselineGameFidelityRecord.machineEpoch`,
  );
  if (baselineRecord.armCycle > baselineMachine.canonicalCycle) {
    fail(`${location}.baselineGameFidelityRecord.cycles.arm`, "followed its durable machine state");
  }
  exact(
    baselineMachine.si.appliedSequence,
    baselineRecord.armAppliedSequence,
    `${location}.baselineMachineEvidence.si.appliedSequence`,
  );
  if (baselineMachine.si.pollIndex < BigInt(baselineRecord.armPollIndex)) {
    fail(
      `${location}.baselineMachineEvidence.si.pollIndex`,
      "preceded the Baseline arm poll",
    );
  }
  exact(
    baselineMachine.xfb.renderCompletionCycle,
    cycles.armPresentation,
    `${location}.baselineMachineEvidence.xfb.renderCompletionCycle`,
  );
  if (baselineOwned.index > reportBound.index && cycles.arm <= reportMachine.canonicalCycle) {
    fail(
      `${location}.gameFidelityRecord.cycles.arm`,
      "did not follow report binding for a post-binding Baseline",
    );
  }
  for (const field of ["buttons", "stickXyCxy", "triggerLrab"]) {
    const baselineField = field === "buttons"
      ? "requestedButtons"
      : field === "stickXyCxy"
        ? "requestedStickXyCxy"
        : "requestedTriggerLrab";
    exact(
      witness.record.payload[field],
      baselineOwned.record.payload[baselineField],
      `${location}.checkpointJournal.controller-witness-published.${field}`,
    );
  }
  exactPublishedControllerPacket(
    witness.record.payload,
    terminalMachine,
    fidelity,
    `${location}.checkpointJournal.controller-witness-published`,
  );
  exact(
    terminalMachine.xfb.renderCompletionCycle,
    cycles.laterPresentation,
    `${location}.gameFidelityRecord.cycles.laterPresentation`,
  );
  if (cycles.laterPresentation > terminalMachine.canonicalCycle) {
    fail(`${location}.gameFidelityRecord.cycles.laterPresentation`, "is outside terminal XFB chronology");
  }
  const input = fidelity.input;
  const publicationPollIndex = BigInt(input.publicationPollIndex);
  const receiptPollIndex = BigInt(input.receiptPollIndex);
  const publicationSequence = BigInt(input.publicationSequence);
  const receiptAppliedSequence = BigInt(input.receiptAppliedSequence);
  if (terminalMachine.si.pollIndex < receiptPollIndex) {
    fail(
      `${location}.terminalMachineEvidence.si.pollIndex`,
      "precedes the GFP guest-receipt poll boundary",
    );
  }
  if (terminalMachine.si.observedCycle < cycles.publicationObserved) {
    fail(
      `${location}.terminalMachineEvidence.si`,
      "latest SI observation regressed from the GFP publication",
    );
  }
  if (terminalMachine.si.lastReceivedSequence < publicationSequence) {
    fail(`${location}.terminalMachineEvidence.si.lastReceivedSequence`, "regressed from GFP");
  }
  if (terminalMachine.si.appliedSequence < receiptAppliedSequence) {
    fail(`${location}.terminalMachineEvidence.si.appliedSequence`, "regressed from GFP receipt");
  }
  if (terminalMachine.si.pollIndex === publicationPollIndex) {
    exact(
      terminalMachine.si.scheduledCycle,
      cycles.publicationScheduled,
      `${location}.terminalMachineEvidence.si.scheduledCycle`,
    );
    exact(
      terminalMachine.si.observedCycle,
      cycles.publicationObserved,
      `${location}.terminalMachineEvidence.si.observedCycle`,
    );
    exact(terminalMachine.si.source, input.source, `${location}.terminalMachineEvidence.si.source`);
  }
  if (terminalMachine.si.appliedSequence === receiptAppliedSequence) {
    exact(
      terminalMachine.si.packetSha256,
      fidelity.hashes.publicationPacket,
      `${location}.terminalMachineEvidence.si.packetSha256`,
    );
  }
  const sustained = validateSustainedWindow(
    reportMachine,
    preWitnessMachine,
    `${location}.sustained`,
  );
  if (terminalMachine.rawDiskReads === 0n) {
    fail(`${location}.terminalMachineEvidence.rawDiskReads`, "expected positive retail disc reads");
  }
  exact(
    run.operatorPublications.algorithm,
    lock.capturePolicy.genericOperatorPolicy.algorithm,
    `${location}.operatorPublications.algorithm`,
  );
  nonNegativeInteger(
    run.operatorPublications.count,
    `${location}.operatorPublications.count`,
    PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  );
  const runSummary = validateCumulativeRunSummary(
    terminal.record.payload.runSummary,
    lock,
    terminalMachine,
    `${location}.checkpointJournal.fidelity-terminal.runSummary`,
  );
  exact(
    run.operatorPublications.count,
    runSummary.operatorPublications,
    `${location}.operatorPublications.count`,
  );
  const witnessSequence = BigInt(witness.record.payload.sequenceLo)
    | BigInt(witness.record.payload.sequenceHi) << 32n;
  exact(
    witnessSequence,
    BigInt(run.operatorPublications.count + 1),
    `${location}.checkpointJournal.controller-witness-published.sequence`,
  );
  if (
    preWitnessMachine.si.lastReceivedSequence >= witnessSequence
    || preWitnessMachine.si.appliedSequence >= witnessSequence
  ) {
    fail(
      `${location}.preWitnessMachineEvidence.si`,
      "included the witness publication instead of the durable pre-publication state",
    );
  }
  exact(report.game.inputSamples, 0, `${location}.firstFrameReport.game.inputSamples`);
  exact(
    report.capabilityBoundary.inputSamples,
    0,
    `${location}.firstFrameReport.capabilityBoundary.inputSamples`,
  );
  if (baselineOwned.index < reportBound.index) {
    exact(run.operatorPublications.count, 0, `${location}.operatorPublications.count`);
  }

  return Object.freeze({
    key: game.key,
    runId: run.runId,
    rgbaSha256: Object.freeze({
      firstVisible: firstVisibleFile.reference.sha256,
      baseline: baseline.rgba.reference.sha256,
      later: later.rgba.reference.sha256,
    }),
    visibility: Object.freeze({
      firstVisible: firstVisibility,
      baseline: baseline.visibility,
      later: later.visibility,
    }),
    sustained,
    oracle: fidelity.oracle,
    machineEvidence: terminalSummary,
  });
}

export async function validateProductionFidelityAttestationFiles({
  attestationPath,
  releaseManifestPath,
  corpusPath,
  repositoryPath = DEFAULT_REPOSITORY_PATH,
}) {
  const [realAttestation, releaseBytes, corpusBytes] = await Promise.all([
    realpath(attestationPath),
    readFile(releaseManifestPath),
    readFile(corpusPath),
  ]);
  const attestationBytes = await readFile(realAttestation);
  const attestation = parseJson(attestationBytes, "$.attestation");
  const release = parseJson(releaseBytes, "$.releaseManifest");
  const corpus = parseJson(corpusBytes, "$.corpus.document");
  await validateRelease(release);
  if (release.schema !== RELEASE_SCHEMA) fail("$.release.schema", "expected schema 4");
  exact(release.runtime.choice, RESIDENT_RUNTIME_CHOICE, "$.release.runtime.choice");
  exactJson(release.runtime.abi, RESIDENT_RUNTIME_ABI, "$.release.runtime.abi");
  const corpusGames = validateCorpus(corpus, corpusBytes);
  const sourceAuthority = await productionSourceAuthorityFromGit(
    repositoryPath,
    release.source.commit,
  );

  exactKeys(attestation, [
    "schema", "createdAt", "corpus", "release", "controlledPerformance", "games",
  ], "$" );
  exact(attestation.schema, PRODUCTION_FIDELITY_ATTESTATION_SCHEMA, "$.schema");
  timestamp(attestation.createdAt, "$.createdAt");
  exactKeys(attestation.corpus, ["sha256"], "$.corpus");
  exact(attestation.corpus.sha256, EXPECTED_CORPUS_SHA256, "$.corpus.sha256");
  exactKeys(attestation.release, [
    "schema", "releaseId", "manifestSha256", "sourceCommit",
  ], "$.release");
  exact(attestation.release.schema, RELEASE_SCHEMA, "$.release.schema");
  sha256(attestation.release.releaseId, "$.release.releaseId");
  exact(attestation.release.releaseId, release.releaseId, "$.release.releaseId");
  exact(
    attestation.release.manifestSha256,
    hashBytes(releaseBytes),
    "$.release.manifestSha256",
  );
  if (!COMMIT_PATTERN.test(attestation.release.sourceCommit)) {
    fail("$.release.sourceCommit", "expected a lowercase 40-hex commit");
  }
  exact(attestation.release.sourceCommit, release.source.commit, "$.release.sourceCommit");

  const baseDirectory = path.dirname(realAttestation);
  const assetsSha256 = residentReleaseExecutionAssetsSha256(release);
  const authority = releaseAuthority(release, releaseBytes);
  await validatePerformance(
    baseDirectory,
    attestation.controlledPerformance,
    release,
    corpusGames,
    assetsSha256,
    authority,
    sourceAuthority,
  );

  const games = array(attestation.games, "$.games");
  exact(games.length, corpusGames.length, "$.games.length");
  const results = [];
  for (let index = 0; index < corpusGames.length; index += 1) {
    results.push(await validateGameRun(
      baseDirectory,
      games[index],
      index,
      corpusGames[index],
      release,
      assetsSha256,
      attestation.createdAt,
      authority,
      corpusBytes,
      sourceAuthority,
    ));
  }
  if (new Set(results.map(result => result.runId)).size !== results.length) {
    fail("$.games", "run IDs must be unique");
  }
  return Object.freeze({
    ok: true,
    schema: PRODUCTION_FIDELITY_ATTESTATION_SCHEMA,
    attestationSha256: hashBytes(attestationBytes),
    releaseId: release.releaseId,
    releaseManifestSha256: hashBytes(releaseBytes),
    executionAssetsSha256: assetsSha256,
    corpusSha256: EXPECTED_CORPUS_SHA256,
    games: Object.freeze(results),
  });
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("expected unique --name value argument pairs");
    }
    const key = name.slice(2);
    if (parsed.has(key)) throw new Error(`duplicate --${key}`);
    parsed.set(key, value);
  }
  const known = new Set(["attestation", "release-manifest", "corpus", "repository"]);
  for (const key of parsed.keys()) if (!known.has(key)) throw new Error(`unknown --${key}`);
  for (const required of ["attestation", "release-manifest"]) {
    if (!parsed.has(required)) throw new Error(`missing --${required}`);
  }
  return parsed;
}

async function cli() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const defaultCorpus = fileURLToPath(
    new URL("./compatibility/games/corpus.json", import.meta.url),
  );
  const summary = await validateProductionFidelityAttestationFiles({
    attestationPath: arguments_.get("attestation"),
    releaseManifestPath: arguments_.get("release-manifest"),
    corpusPath: arguments_.get("corpus") ?? defaultCorpus,
    repositoryPath: arguments_.get("repository") ?? DEFAULT_REPOSITORY_PATH,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
