// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { schema4ReleaseFixture } from "./browser_public_release_identity.test_fixture.mjs";
import { gameFidelityEnvelope } from "./resident_machine_game_fidelity_v1.test.mjs";
import {
  GAME_FIDELITY_V1_PROJECTORS,
  validateGameFidelityV1Envelope,
} from "./resident_machine_game_fidelity_v1.mjs";
import { residentFirstFrameReportFixture } from "./resident_machine_first_frame_report.test.mjs";
import { PRODUCTION_FIRST_FRAME_CAPTURE_ORDER } from "./resident_machine_first_frame_report.mjs";
import { canonicalFidelityJson } from "./resident_machine_fidelity_checkpoint_report.mjs";
import {
  PRODUCTION_SOURCE_PATHS,
  expectedFidelityHostIdentitySha256,
  productionFidelityCapturePolicy,
  productionFidelityLockAuthorityFromFiles,
  verifyResidentProductionFidelityEvidenceLockFiles,
} from "./resident_machine_fidelity_lock.mjs";
import {
  PRODUCTION_FIDELITY_ATTESTATION_SCHEMA,
  residentReleaseExecutionAssetsSha256,
  validateProductionFidelityAttestationFiles,
} from "./resident_machine_production_fidelity_gate.mjs";
import { releaseIdentityPayload, sha256Hex } from "../web/release.mjs";

const CORPUS_PATH = new URL("./compatibility/games/corpus.json", import.meta.url);
const CORPUS_SHA = "43597e441ab8c38adb18beed8ac34895a8496cac8ac2112ef4cb27c7504f4fc6";
const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalHash(value) {
  return sha256(canonicalFidelityJson(value));
}

function unsignedLeb(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function wasmString(value) {
  const bytes = [...Buffer.from(value)];
  return [...unsignedLeb(bytes.length), ...bytes];
}

function defaultOffRendererModule() {
  const typePayload = [1, 0x60, 0, 0];
  const importPayload = [...unsignedLeb(329)];
  for (let index = 0; index < 329; index += 1) {
    importPayload.push(
      ...wasmString("./browser_renderer_bg.js"),
      ...wasmString(`__wbg_runtime_${index}`),
      0,
      0,
    );
  }
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, ...unsignedLeb(typePayload.length), ...typePayload,
    2, ...unsignedLeb(importPayload.length), ...importPayload,
  ]);
}

function asset(prefix, extension, record) {
  return {
    url: `/assets/${prefix}-${record.sha256}.${extension}`,
    bytes: record.bytes,
    sha256: record.sha256,
  };
}

function reportArtifacts(release) {
  return {
    "browser_machine.wasm": {
      bytes: release.runtime.core.bytes,
      sha256: release.runtime.core.sha256,
    },
    "resident_dispatcher.wasm": {
      bytes: release.runtime.dispatcher.bytes,
      sha256: release.runtime.dispatcher.sha256,
    },
    "core_run_coordinator.wasm": {
      bytes: release.runtime.coordinator.bytes,
      sha256: release.runtime.coordinator.sha256,
    },
    "browser_renderer.js": {
      bytes: release.renderer.javascript.bytes,
      sha256: release.renderer.javascript.sha256,
    },
    "browser_renderer_bg.wasm": {
      bytes: release.renderer.wasm.bytes,
      sha256: release.renderer.wasm.sha256,
    },
  };
}

async function releaseFixture(artifacts, runtimeRecords, sourceCommit) {
  const release = await schema4ReleaseFixture();
  release.runtime.core = asset("browser-machine", "wasm", artifacts["browser_machine.wasm"]);
  release.runtime.dispatcher = asset(
    "resident-dispatcher",
    "wasm",
    artifacts["resident_dispatcher.wasm"],
  );
  release.runtime.coordinator = asset(
    "core-run-coordinator",
    "wasm",
    artifacts["core_run_coordinator.wasm"],
  );
  release.renderer.javascript = asset(
    "browser-renderer",
    "js",
    artifacts["browser_renderer.js"],
  );
  release.renderer.wasm = asset(
    "browser-renderer-wasm",
    "wasm",
    artifacts["browser_renderer_bg.wasm"],
  );
  release.runtime.adapter = asset("resident-machine-adapter", "mjs", runtimeRecords.adapter);
  release.runtime.worker = asset("resident-machine-worker", "mjs", runtimeRecords.worker);
  release.frontend = asset("frontend", "html", runtimeRecords.frontend);
  release.source.commit = sourceCommit;
  release.source.tree = `${release.source.repository}/tree/${sourceCommit}`;
  release.source.archive = `${release.source.repository}/archive/${sourceCommit}.tar.gz`;
  release.source.license.source =
    `${release.source.repository}/blob/${sourceCommit}/licenses/GPL-3.0-only.txt`;
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  return release;
}

function setMachineBoot(envelope, projector) {
  const bytes = Buffer.from(envelope.payload, "base64");
  bytes.writeUInt32LE(Buffer.from(projector.identifier.slice(0, 4)).readUInt32BE(), 12 * 4);
  const suffix = Buffer.from(projector.identifier.slice(4, 6));
  bytes.writeUInt32LE(suffix[0] << 24 | suffix[1] << 16, 13 * 4);
  bytes.writeUInt32LE(projector.revision, 16 * 4);
  envelope.payload = bytes.toString("base64");
}

function putU64(words, index, value) {
  const exact = BigInt(value);
  words[index] = Number(exact & 0xffff_ffffn);
  words[index + 1] = Number(exact >> 32n);
}

function requestedController(projector) {
  return projector.projector === 1
    ? { buttons: 0x0100, stickXyCxy: 0x8080_8080, triggerLrab: 0x00ff_0000 }
    : { buttons: 0x0001, stickXyCxy: 0x8080_8001, triggerLrab: 0 };
}

function controllerPacket(controller) {
  const stick = [0, 8, 16, 24].map(shift => controller.stickXyCxy >>> shift & 0xff);
  const trigger = [0, 8, 16, 24].map(shift => controller.triggerLrab >>> shift & 0xff);
  const buttons = (controller.buttons | 0x0080) & 0xffff;
  return Buffer.from([
    buttons >>> 8,
    buttons & 0xff,
    stick[0],
    stick[1],
    stick[2],
    stick[3],
    trigger[2],
    trigger[3],
  ]);
}

function terminalMachineEnvelope(projector, controller, presentation, {
  snapshotSerial = 7,
  canonicalCycle = 3_000,
  executedInstructions = 2_000,
  viFields = 122,
  presentedFrames = 66,
  lastReceivedSequence = 10,
  appliedSequence = 10,
  renderCompletionCycle = 2_160,
  pollIndex = 13,
} = {}) {
  const words = new Uint32Array(204);
  words[0] = 1;
  words[1] = 816;
  words[2] = 0x4c5a_4d45;
  words[3] = 1 | 4 | 8 | 16;
  putU64(words, 4, 1);
  putU64(words, 6, snapshotSerial);
  putU64(words, 8, 1);
  putU64(words, 10, 1_459_978_240);
  words[12] = Buffer.from(projector.identifier.slice(0, 4)).readUInt32BE();
  const suffix = Buffer.from(projector.identifier.slice(4, 6));
  words[13] = suffix[0] << 24 | suffix[1] << 16;
  words[14] = 3;
  words[16] = projector.revision;
  words[18] = 1;
  putU64(words, 19, canonicalCycle);
  putU64(words, 21, canonicalCycle);
  putU64(words, 23, executedInstructions);
  putU64(words, 25, 2);
  putU64(words, 27, executedInstructions);
  putU64(words, 29, 3);
  words[31] = 0x8000_3200;
  putU64(words, 34, 6);
  putU64(words, 36, viFields);
  putU64(words, 38, 2);
  for (const [index, value] of [
    [64, 2048], [66, 2], [68, 8], [70, 2],
    [72, presentedFrames], [74, presentedFrames],
    [92, presentedFrames], [94, presentedFrames],
  ]) putU64(words, index, value);
  words[105] = 1;
  putU64(words, 106, Math.min(renderCompletionCycle, 2_040));
  putU64(words, 108, Math.min(renderCompletionCycle, 2_045));
  putU64(words, 110, renderCompletionCycle);
  putU64(words, 112, presentation.renderSequence);
  putU64(words, 114, presentation.presentationSerial);
  words[116] = presentation.xfbGeneration;
  words[117] = presentation.selectedRow;
  words[118] = presentation.modeCode;
  words[119] = presentation.parityCode;
  words[120] = presentation.pairEpoch;
  words[121] = 2;
  words[122] = 3;
  words[123] = 4;
  words[124] = presentation.outputWidth;
  words[125] = presentation.outputHeight;
  words[126] = 4;
  words[127] = 2;
  words[128] = 1;
  words[129] = 2;
  words[130] = 2;
  words[131] = 2;
  words[132] = 1;
  putU64(words, 133, pollIndex);
  putU64(words, 135, 2_110);
  putU64(words, 137, 2_120);
  putU64(words, 139, lastReceivedSequence);
  putU64(words, 141, appliedSequence);
  putU64(words, 143, pollIndex);
  const packet = controllerPacket(controller);
  words[149] = packet.readUInt32BE(0);
  words[150] = packet.readUInt32BE(4);
  words[152] = 0;
  for (const index of [156, 158, 172, 174, 178, 186, 190, 196]) putU64(words, index, 1);
  const bytes = Buffer.alloc(816);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  return { available: true, bytes: 816, encoding: "base64", payload: bytes.toString("base64") };
}

function preReportBaselineMachineEnvelope(reportEnvelope, presentation, {
  snapshotSerial = 3,
  renderCompletionCycle = 1_700,
} = {}) {
  const envelope = structuredClone(reportEnvelope);
  const bytes = Buffer.from(envelope.payload, "base64");
  const completion = BigInt(renderCompletionCycle);
  bytes.writeBigUInt64LE(BigInt(snapshotSerial), 6 * 4);
  for (const word of [106, 108, 110]) bytes.writeBigUInt64LE(completion, word * 4);
  bytes.writeBigUInt64LE(BigInt(presentation.renderSequence), 112 * 4);
  bytes.writeBigUInt64LE(BigInt(presentation.presentationSerial), 114 * 4);
  bytes.writeUInt32LE(presentation.xfbGeneration, 116 * 4);
  bytes.writeUInt32LE(presentation.selectedRow, 117 * 4);
  bytes.writeUInt32LE(presentation.modeCode, 118 * 4);
  bytes.writeUInt32LE(presentation.parityCode, 119 * 4);
  bytes.writeUInt32LE(presentation.pairEpoch, 120 * 4);
  bytes.writeUInt32LE(presentation.outputWidth, 124 * 4);
  bytes.writeUInt32LE(presentation.outputHeight, 125 * 4);
  envelope.payload = bytes.toString("base64");
  return envelope;
}

function setMachineSiPublication(envelope, controller, {
  pollIndex = 11,
  scheduledCycle,
  observedCycle,
  lastReceivedSequence = 0,
  appliedSequence = 0,
} = {}) {
  const bytes = Buffer.from(envelope.payload, "base64");
  bytes.writeUInt32LE(bytes.readUInt32LE(3 * 4) | 8, 3 * 4);
  bytes.writeBigUInt64LE(BigInt(pollIndex), 133 * 4);
  bytes.writeBigUInt64LE(BigInt(scheduledCycle), 135 * 4);
  bytes.writeBigUInt64LE(BigInt(observedCycle), 137 * 4);
  bytes.writeBigUInt64LE(BigInt(lastReceivedSequence), 139 * 4);
  bytes.writeBigUInt64LE(BigInt(appliedSequence), 141 * 4);
  bytes.writeBigUInt64LE(BigInt(pollIndex), 143 * 4);
  bytes.writeBigUInt64LE(0n, 145 * 4);
  bytes.writeBigUInt64LE(0n, 147 * 4);
  const packet = controllerPacket(controller);
  bytes.writeUInt32LE(packet.readUInt32BE(0), 149 * 4);
  bytes.writeUInt32LE(packet.readUInt32BE(4), 150 * 4);
  bytes.writeUInt32LE(0, 151 * 4);
  bytes.writeUInt32LE(0, 152 * 4);
  envelope.payload = bytes.toString("base64");
}

function setPresentation(bytes, word, summary) {
  bytes.writeBigUInt64LE(BigInt(summary.renderSequence), word * 4);
  bytes.writeUInt32LE(summary.xfbGeneration, (word + 2) * 4);
  bytes.writeUInt32LE(summary.pairEpoch, (word + 3) * 4);
  bytes.writeUInt32LE(summary.selectedRow, (word + 4) * 4);
  bytes.writeUInt32LE(
    summary.modeCode | summary.parityCode << 8 | 2 << 16,
    (word + 5) * 4,
  );
  bytes.writeUInt32LE(summary.outputWidth, (word + 6) * 4);
  bytes.writeUInt32LE(summary.outputHeight, (word + 7) * 4);
}

function acceptedFidelityEnvelope(projector, controller, baselinePresentation, laterPresentation, {
  armCycle = 2_100,
  armAppliedSequence = 0,
  publicationSequence = 1,
} = {}) {
  const envelope = gameFidelityEnvelope(projector);
  const bytes = Buffer.from(envelope.payload, "base64");
  const put = (word, value) => bytes.writeBigUInt64LE(BigInt(value), word * 4);
  put(16, 1);
  put(18, armCycle);
  put(20, Math.min(armCycle, 2_050));
  put(22, 2_110);
  put(24, 2_120);
  put(26, 2_130);
  put(28, 2_150);
  put(30, 2_160);
  put(32, armAppliedSequence);
  put(34, publicationSequence);
  put(36, publicationSequence);
  put(38, baselinePresentation.presentationSerial);
  put(40, laterPresentation.presentationSerial);
  bytes.writeUInt32LE(9, 42 * 4);
  bytes.writeUInt32LE(10, 43 * 4);
  bytes.writeUInt32LE(10, 44 * 4);
  bytes.writeUInt32LE(1, 45 * 4);
  bytes.writeUInt32LE(controller.buttons, 46 * 4);
  sha256(controllerPacket(controller)).match(/../g).forEach((byte, index) => {
    bytes[72 * 4 + index] = Number.parseInt(byte, 16);
  });
  setPresentation(bytes, 80, baselinePresentation);
  setPresentation(bytes, 88, laterPresentation);
  envelope.payload = bytes.toString("base64");
  return envelope;
}

function baselineFidelityEnvelope(acceptedEnvelope) {
  const envelope = structuredClone(acceptedEnvelope);
  const bytes = Buffer.from(envelope.payload, "base64");
  bytes.writeUInt32LE(1, 3 * 4);
  bytes.writeUInt32LE(0, 4 * 4);
  bytes.writeBigUInt64LE(0x0fn, 12 * 4);
  for (const [start, end] of [
    [22, 32],
    [34, 38],
    [40, 42],
    [43, 48],
    [56, 80],
    [88, 96],
  ]) {
    bytes.fill(0, start * 4, end * 4);
  }
  envelope.payload = bytes.toString("base64");
  return envelope;
}

function rendererMetadata(summary) {
  const parity = summary.parity;
  const metadataSalt = summary.metadataSalt ?? 0;
  const field = {
    address: 0x0010_0000 + summary.xfbGeneration * 32 + metadataSalt * 0x1_0000,
    generation: summary.xfbGeneration,
    row: summary.selectedRow,
    sourceRow: summary.selectedRow,
    textureWidth: summary.outputWidth,
    textureHeight: summary.outputHeight,
    logicalWidth: summary.outputWidth,
    logicalHeight: summary.outputHeight,
    displayHeight: summary.outputHeight,
    fieldStrideBytes: summary.outputWidth * 2,
    sourceRowStep: 1,
    fieldHeight: summary.outputHeight,
    rowRepeat: 1,
    surfaceId: summary.xfbGeneration + metadataSalt * 100,
    scanoutPolicy: "direct",
  };
  return {
    format: "rgba8unorm",
    layout: "top-left-row-major-tight",
    width: summary.outputWidth,
    height: summary.outputHeight,
    displayWidth: summary.outputWidth,
    displayHeight: summary.outputHeight,
    presentationSerial: Number(summary.presentationSerial),
    pairEpoch: summary.pairEpoch,
    presentationMode: summary.mode,
    scanoutPolicy: summary.mode === "interlaced" ? "weave" : "direct",
    fields: { [parity]: field },
  };
}

function rgba(red, green, blue) {
  return Buffer.from([
    0, 0, 0, 255,
    red, green, blue, 255,
    255, 255, 255, 255,
    red, green, blue, 255,
  ]);
}

async function writeEvidence(directory, name, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(join(directory, name), bytes);
  return { path: name, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function writeCanonicalEvidence(directory, name, value) {
  const bytes = Buffer.from(canonicalFidelityJson(value), "utf8");
  await writeFile(join(directory, name), bytes);
  return { path: name, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function executionDescriptors(release) {
  const descriptor = value => ({ url: value.url, bytes: value.bytes, sha256: value.sha256 });
  return {
    core: descriptor(release.runtime.core),
    dispatcher: descriptor(release.runtime.dispatcher),
    coordinator: descriptor(release.runtime.coordinator),
    adapter: descriptor(release.runtime.adapter),
    worker: descriptor(release.runtime.worker),
    frontend: descriptor(release.frontend),
    rendererJavascript: descriptor(release.renderer.javascript),
    rendererWasm: descriptor(release.renderer.wasm),
  };
}

function releaseAuthority(release, releaseBytes) {
  return {
    schema: 4,
    releaseId: release.releaseId,
    manifestBytes: releaseBytes.byteLength,
    manifestSha256: sha256(releaseBytes),
    sourceCommit: release.source.commit,
    executionAssetsSha256: residentReleaseExecutionAssetsSha256(release),
    executionAssets: executionDescriptors(release),
  };
}

function firstFrameRunPolicy(workerUrl) {
  return {
    instructionUpperCap: "100000000",
    executedCycleUpperCap: "250000000",
    sliceCycleUpperCap: "1000000",
    blockUpperCap: 16_384,
    totalHostCallCap: 65_535,
    totalColdInstallCap: 65_535,
    maxBootReads: 8_192,
    bootTimeoutMs: 180_000,
    sliceTimeoutMs: 180_000,
    runTimeoutMs: 600_000,
    externalWallTimeoutMs: 600_000,
    zeroProgressSliceCap: 4_096,
    workerUrl,
  };
}

function checkpointPolicy() {
  return {
    checkpointTimeoutMs: 10_000,
    checkpointRecordCap: 65_535,
    probeEventRunCap: 32_768,
    probeEventPerSubmissionCap: 402,
    opaqueProbeWords: 6,
    fsyncEveryRecord: true,
  };
}

function hostPolicy() {
  return {
    transport: "immutable-http-range",
    maxRangeBytes: 64 * 1024 * 1024,
    semanticArguments: 0,
    checkpointBodyCap: 4_096,
  };
}

function machineEvidencePolicy() {
  return {
    abiVersion: 1,
    byteLength: 816,
    wordLength: 204,
    tag: "LZME",
    encoding: "base64",
    browserWordInterpretations: 0,
  };
}

function fidelityLock(
  authority,
  runId,
  projector,
  corpusGame,
  artifacts,
  corpusBytes,
  sources,
) {
  return {
    schema: "lazuli-resident-renderer-fidelity-evidence-lock-v3",
    evidenceMode:
      "continuous-resident-game-fidelity-v1-with-durable-renderer-and-rust-ownership",
    release: structuredClone(authority),
    run: { runId, gameKey: projector.key },
    corpus: {
      workspacePath: "tools/compatibility/games/corpus.json",
      bytes: corpusBytes,
      sha256: CORPUS_SHA,
    },
    selectedGame: {
      key: projector.key,
      priority: corpusGame.priority,
      bytes: corpusGame.bytes,
      image: structuredClone(corpusGame.image),
      disc: structuredClone(corpusGame.disc),
    },
    artifacts: structuredClone(artifacts),
    sources: structuredClone(sources),
    hostPolicy: hostPolicy(),
    runPolicy: firstFrameRunPolicy(authority.executionAssets.worker.url),
    checkpointPolicy: checkpointPolicy(),
    capturePolicy: structuredClone(productionFidelityCapturePolicy(projector.key)),
    rendererProbe: {
      feature: "resident-render-probe",
      featureDefaultOff: true,
      hook: "globalThis.__lazuliResidentRenderProbe",
      defaultHookImports: 0,
      checkpointProbeEvents: 0,
      javascriptWordInterpretations: 0,
    },
    machineEvidence: machineEvidencePolicy(),
  };
}

function durableRecords(payloads, evidenceLockSha256, hostIdentitySha256) {
  let previousRecordSha256 = null;
  return payloads.map((payload, index) => {
    const core = {
      schema: "lazuli-resident-renderer-fidelity-durable-record-v1",
      serverSequence: index + 1,
      receivedAtUnixMs: 1_800_000_000_000 + index,
      hostIdentitySha256,
      evidenceLockSha256,
      previousRecordSha256,
      payloadSha256: canonicalHash(payload),
      payload,
    };
    const record = { ...core, recordSha256: canonicalHash(core) };
    previousRecordSha256 = record.recordSha256;
    return record;
  });
}

function checkpointPayload(runId, gameKey, clientSequence, kind, fields) {
  return {
    schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
    runId,
    gameKey,
    clientSequence,
    kind,
    ...fields,
  };
}

function envelopeArtifactFields(prefix, envelope) {
  const envelopeBytes = Buffer.from(canonicalFidelityJson(envelope), "utf8");
  const opaqueBytes = Buffer.from(envelope.payload, "base64");
  return {
    [`${prefix}EnvelopeBytes`]: envelopeBytes.byteLength,
    [`${prefix}EnvelopeSha256`]: sha256(envelopeBytes),
    [`${prefix}OpaqueBytes`]: opaqueBytes.byteLength,
    [`${prefix}OpaqueSha256`]: sha256(opaqueBytes),
  };
}

function receiptAnnotation(identity, receipt) {
  return {
    ...identity,
    receiptBytes: receipt.payload.receiptBytes,
    receiptSha256: receipt.payload.receiptSha256,
    presentedAfterResolution: receipt.payload.presentedAfterResolution,
    receiptRecordSha256: receipt.recordSha256,
  };
}

function cumulativeRunSummary(operatorPublications = 0) {
  return {
    schema: "lazuli-resident-cumulative-run-summary-v1",
    issuedRunCalls: 4,
    reportedExecutedCycles: "2500",
    reportedExecutedInstructions: "1500",
    reportedHostCalls: 8,
    reportedColdInstalls: 2,
    operatorPublications,
    witnessPublications: 1,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    elapsedWallMs: 10_000,
    wallTimeoutMs: 600_000,
    accepted: true,
  };
}

function pristineRunSummary() {
  return {
    schema: "lazuli-resident-cumulative-run-summary-v1",
    issuedRunCalls: 0,
    reportedExecutedCycles: "0",
    reportedExecutedInstructions: "0",
    reportedHostCalls: 0,
    reportedColdInstalls: 0,
    operatorPublications: 0,
    witnessPublications: 0,
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    elapsedWallMs: 0,
    wallTimeoutMs: 600_000,
    accepted: false,
  };
}

async function createSourceRepository(directory) {
  const repository = join(directory, "source-repository");
  await mkdir(repository);
  await execFileAsync("git", ["init", "--quiet", repository]);
  const records = {};
  for (const source of PRODUCTION_SOURCE_PATHS) {
    const bytes = Buffer.from(`production gate source fixture: ${source}\n`);
    const destination = join(repository, source);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    records[source] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  await execFileAsync("git", ["-C", repository, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Lazuli Production Gate Test",
    "-c",
    "user.email=lazuli-production-gate@example.invalid",
    "commit",
    "--quiet",
    "--message",
    "production source authority fixture",
  ]);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repository, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  return { repository, commit: stdout.trim(), records };
}

async function buildAttestationFixture(t, {
  baselineModes = [],
  armCycles = [],
  baselineSnapshotSerials = [],
  preWitnessViDeltas = [],
  preWitnessPresentationDeltas = [],
  sameReceiptRgbaMismatchIndex = -1,
  sameReceiptMetadataMismatchIndex = -1,
  laterMetadataIdentityMismatchIndex = -1,
  laterMetadataMutators = [],
  laterRgbaInvisibleIndex = -1,
  postWitnessPreWitnessIndex = -1,
  terminalMachineMutators = [],
  fidelityMutators = [],
  baselineFidelityMutators = [],
  operatorPublicationCounts = [],
  reportInputSampleCounts = [],
  witnessSequenceOverrides = [],
  witnessStatusOverrides = [],
  acceptedSequenceOverrides = [],
  readyArtifactMutators = [],
  readySnapshotSerials = [],
  baselineArtifactMutators = [],
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lazuli-production-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRepository = await createSourceRepository(directory);
  const rendererWasm = defaultOffRendererModule();
  const rendererWasmUrl = `/assets/browser-renderer-wasm-${sha256(rendererWasm)}.wasm`;
  const runtimeBytes = {
    core: Buffer.from("synthetic exact feature-on resident core"),
    dispatcher: Buffer.from("synthetic exact resident dispatcher"),
    coordinator: Buffer.from("synthetic exact resident coordinator"),
    adapter: Buffer.from("synthetic exact thin resident adapter"),
    worker: Buffer.from("synthetic exact thin resident worker"),
    frontend: Buffer.from("synthetic exact production frontend"),
    rendererJavascript: Buffer.from(
      `const wasm = new URL('${rendererWasmUrl}', import.meta.url);\n`
        + "export default function init() { return wasm; }\n",
    ),
    rendererWasm,
  };
  const runtimeRecords = Object.fromEntries(Object.entries(runtimeBytes).map(([role, bytes]) => [
    role,
    { bytes: bytes.byteLength, sha256: sha256(bytes) },
  ]));
  const artifacts = {
    "browser_machine.wasm": runtimeRecords.core,
    "resident_dispatcher.wasm": runtimeRecords.dispatcher,
    "core_run_coordinator.wasm": runtimeRecords.coordinator,
    "browser_renderer.js": runtimeRecords.rendererJavascript,
    "browser_renderer_bg.wasm": runtimeRecords.rendererWasm,
  };
  const release = await releaseFixture(artifacts, runtimeRecords, sourceRepository.commit);
  const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
  const releasePath = join(directory, "release.json");
  await writeFile(releasePath, releaseBytes);

  const [performanceReport, corpusBytes] = await Promise.all([
    readFile(
      new URL("./resident_machine_corpus_full_report_legacy_fixture.json", import.meta.url),
      "utf8",
    )
      .then(JSON.parse),
    readFile(CORPUS_PATH),
  ]);
  const corpus = JSON.parse(corpusBytes);
  Object.assign(performanceReport.policy, {
    warmupInstructionTarget: "1000000",
    measurementInstructionTarget: "5000000",
    bootTimeoutMs: 120_000,
    sliceTimeoutMs: 120_000,
    windowTimeoutMs: 120_000,
  });
  for (const game of performanceReport.games) {
    game.boot.wallMs = Math.min(game.boot.wallMs, 119_000);
    for (const [name, target] of [["warmup", "1000000"], ["measurement", "5000000"]]) {
      const window = game[name];
      window.wallMs = Math.min(window.wallMs, 119_000);
      window.targetInstructions = target;
      window.executedInstructions = target;
      window.instructionOvershoot = "0";
      window.cyclesPerSecond = Number(window.executedCycles) / (window.wallMs / 1_000);
      window.instructionsPerSecond = Number(target) / (window.wallMs / 1_000);
    }
  }
  const authority = releaseAuthority(release, releaseBytes);
  const performanceRunId = "99999999-0000-4000-8000-999999999999";
  performanceReport.artifacts.artifacts = structuredClone(reportArtifacts(release));
  const performanceLock = {
    schema: "lazuli-resident-corpus-evidence-lock-v2",
    release: structuredClone(authority),
    run: {
      runId: performanceRunId,
      selectedGameKeys: corpus.games.map(game => game.key),
    },
    sourceCorpusSha256: CORPUS_SHA,
    games: corpus.games.map(game => ({
      key: game.key,
      priority: game.priority,
      bytes: game.bytes,
      sha256: game.image.sha256,
    })),
    artifacts: {
      schema: "lazuli-resident-corpus-artifacts-v1",
      artifacts: structuredClone(reportArtifacts(release)),
    },
    sources: structuredClone(sourceRepository.records),
    runPolicy: {
      ...structuredClone(performanceReport.policy),
      workerUrl: authority.executionAssets.worker.url,
    },
  };
  const performanceLockBytes = Buffer.from(`${JSON.stringify(performanceLock, null, 2)}\n`);
  performanceReport.evidenceLock = {
    schema: performanceLock.schema,
    sha256: sha256(performanceLockBytes),
    runId: performanceRunId,
  };
  const performanceReportRef = await writeEvidence(
    directory,
    "controlled-performance-report.json",
    performanceReport,
  );
  const performanceLockRef = await writeEvidence(
    directory,
    "controlled-performance-lock.json",
    performanceLockBytes,
  );

  const executionAssetsSha256 = residentReleaseExecutionAssetsSha256(release);
  const runtimeAssets = Object.fromEntries(await Promise.all(
    Object.entries(runtimeBytes).map(async ([role, bytes]) => [
      role,
      await writeEvidence(directory, `runtime-${role}.bin`, bytes),
    ]),
  ));
  const games = [];
  for (let index = 0; index < GAME_FIDELITY_V1_PROJECTORS.length; index += 1) {
    const projector = GAME_FIDELITY_V1_PROJECTORS[index];
    const corpusGame = corpus.games[index];
    const runId = `${String(index + 1).padStart(8, "0")}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const baselineMode = baselineModes[index] ?? "same-pre";
    const armCycle = armCycles[index] ?? (baselineMode === "distinct-post" ? 2_100 : 1_700);
    const armPresentationCycle = Math.min(armCycle, 2_050);
    const operatorPublicationCount = operatorPublicationCounts[index] ?? 0;
    const witnessSequence = operatorPublicationCount + 1;
    if (!new Set(["same-pre", "distinct-pre", "distinct-post"]).has(baselineMode)) {
      throw new Error(`unsupported Baseline mode ${baselineMode}`);
    }
    const report = residentFirstFrameReportFixture();
    report.game.firstPresentedXfb.captureOrder = [...PRODUCTION_FIRST_FRAME_CAPTURE_ORDER];
    report.captureOrderContract = [...PRODUCTION_FIRST_FRAME_CAPTURE_ORDER];
    report.game.inputSamples = reportInputSampleCounts[index] ?? 0;
    report.capabilityBoundary.inputSamples = reportInputSampleCounts[index] ?? 0;
    report.artifacts = {
      schema: "lazuli-resident-corpus-artifacts-v1",
      artifacts: structuredClone(reportArtifacts(release)),
    };
    report.corpus.selectedGameKey = projector.key;
    Object.assign(report.game.game, {
      key: projector.key,
      priority: index + 1,
      bytes: corpusGame.bytes,
      sha256: corpusGame.image.sha256,
    });
    report.game.transport.before.gameKey = projector.key;
    report.game.transport.after.gameKey = projector.key;
    report.game.fidelityCheckpoints.gameKey = projector.key;
    report.game.fidelityCheckpoints.runId = runId;
    setMachineBoot(report.game.adapterDiagnostics.ready.machineEvidence, projector);
    setMachineBoot(report.game.adapterDiagnostics.final.machineEvidence, projector);
    const controller = requestedController(projector);
    const firstPresentation = {
      renderSequence: "1",
      presentationSerial: "1",
      xfbGeneration: 1,
      pairEpoch: 1,
      selectedRow: 0,
      mode: "progressive",
      modeCode: 0,
      parity: "top",
      parityCode: 0,
      outputWidth: 2,
      outputHeight: 2,
      metadataSalt: index,
    };
    const baselinePresentation = baselineMode === "same-pre"
      ? structuredClone(firstPresentation)
      : {
          ...structuredClone(firstPresentation),
          renderSequence: "2",
          presentationSerial: "20",
          xfbGeneration: 30,
          pairEpoch: 40,
        };
    const laterPresentation = {
      ...structuredClone(firstPresentation),
      renderSequence: "3",
      presentationSerial: "21",
      xfbGeneration: 31,
      pairEpoch: 41,
      selectedRow: 1,
    };
    if (baselineMode === "distinct-pre") {
      report.game.renderer.calls = 2;
      report.game.adapterDiagnostics.final.totalRenderCalls = 2;
      report.game.residentTotals.renderCalls = 2;
      report.game.run.servicedHostCalls = 3;
      report.capabilityBoundary.rendererOwnedRgbaReadbacks = 2;
      const finalMachine = Buffer.from(
        report.game.adapterDiagnostics.final.machineEvidence.payload,
        "base64",
      );
      finalMachine.writeBigUInt64LE(2n, 92 * 4);
      finalMachine.writeBigUInt64LE(2n, 94 * 4);
      report.game.adapterDiagnostics.final.machineEvidence.payload = finalMachine.toString("base64");
    }
    if (baselineMode !== "distinct-post") {
      const observedCycle = Math.min(armPresentationCycle, 1_990);
      setMachineSiPublication(
        report.game.adapterDiagnostics.final.machineEvidence,
        controller,
        {
          scheduledCycle: Math.max(0, observedCycle - 10),
          observedCycle,
          lastReceivedSequence: operatorPublicationCount,
          appliedSequence: operatorPublicationCount,
        },
      );
    }
    report.game.firstPresentedXfb.readback.metadata = rendererMetadata(firstPresentation);
    const firstRgba = rgba(255, index + 1, 0);
    report.game.firstPresentedXfb.readback.rgbaSha256 = sha256(firstRgba);
    let baselineRgba = baselineMode === "same-pre"
      ? firstRgba
      : rgba(index + 1, 0, 255);
    if (baselineMode === "same-pre" && index === sameReceiptRgbaMismatchIndex) {
      baselineRgba = Buffer.from(firstRgba);
      baselineRgba[1] ^= 1;
    }
    const laterRgba = index === laterRgbaInvisibleIndex
      ? Buffer.from([
          0, 0, 0, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
          0, 0, 0, 255,
        ])
      : rgba(0, 255, index + 1);
    const fidelityEnvelope = acceptedFidelityEnvelope(
      projector,
      controller,
      baselinePresentation,
      laterPresentation,
      {
        armCycle,
        armAppliedSequence: operatorPublicationCount,
        publicationSequence: witnessSequence,
      },
    );
    if (fidelityMutators[index]) {
      const bytes = Buffer.from(fidelityEnvelope.payload, "base64");
      fidelityMutators[index](bytes);
      fidelityEnvelope.payload = bytes.toString("base64");
    }
    const baselineFidelity = baselineFidelityEnvelope(fidelityEnvelope);
    if (baselineFidelityMutators[index]) {
      const bytes = Buffer.from(baselineFidelity.payload, "base64");
      baselineFidelityMutators[index](bytes);
      baselineFidelity.payload = bytes.toString("base64");
    }
    const fidelity = validateGameFidelityV1Envelope(fidelityEnvelope, {
      expectedGameKey: projector.key,
    });
    const baselineMachine = baselineMode === "distinct-post"
      ? terminalMachineEnvelope(
          projector,
          controller,
          baselinePresentation,
          {
            snapshotSerial: baselineSnapshotSerials[index] ?? 5,
            canonicalCycle: 2_200,
            executedInstructions: 1_400,
            viFields: 2,
            presentedFrames: 2,
            lastReceivedSequence: operatorPublicationCount,
            appliedSequence: operatorPublicationCount,
            renderCompletionCycle: armPresentationCycle,
            pollIndex: 11,
          },
        )
      : preReportBaselineMachineEnvelope(
          report.game.adapterDiagnostics.final.machineEvidence,
          baselinePresentation,
          {
            snapshotSerial: baselineSnapshotSerials[index] ?? 3,
            renderCompletionCycle: armPresentationCycle,
          },
        );
    const preWitnessMachine = terminalMachineEnvelope(
      projector,
      controller,
      baselinePresentation,
      {
        snapshotSerial: 6,
        canonicalCycle: 2_500,
        executedInstructions: 1_500,
        viFields: 1 + (preWitnessViDeltas[index] ?? 120),
        presentedFrames: 1 + (preWitnessPresentationDeltas[index] ?? 64),
        lastReceivedSequence: operatorPublicationCount,
        appliedSequence: operatorPublicationCount,
        renderCompletionCycle: armPresentationCycle,
        pollIndex: 12,
      },
    );
    const terminalMachine = terminalMachineEnvelope(
      projector,
      controller,
      laterPresentation,
      {
        lastReceivedSequence: witnessSequence,
        appliedSequence: witnessSequence,
      },
    );
    if (terminalMachineMutators[index]) {
      const bytes = Buffer.from(terminalMachine.payload, "base64");
      terminalMachineMutators[index](bytes);
      terminalMachine.payload = bytes.toString("base64");
    }
    let retainedPreWitnessMachine = preWitnessMachine;
    if (index === postWitnessPreWitnessIndex) {
      retainedPreWitnessMachine = structuredClone(terminalMachine);
      const terminalBytes = Buffer.from(terminalMachine.payload, "base64");
      terminalBytes.writeBigUInt64LE(8n, 6 * 4);
      terminalMachine.payload = terminalBytes.toString("base64");
    }
    const readyMachine = structuredClone(report.game.adapterDiagnostics.ready.machineEvidence);
    if (readySnapshotSerials[index] !== undefined) {
      const readyBytes = Buffer.from(readyMachine.payload, "base64");
      readyBytes.writeBigUInt64LE(BigInt(readySnapshotSerials[index]), 6 * 4);
      readyMachine.payload = readyBytes.toString("base64");
    }
    const baselineMetadata = rendererMetadata(baselinePresentation);
    if (baselineMode === "same-pre" && index === sameReceiptMetadataMismatchIndex) {
      baselineMetadata.fields.top.surfaceId += 1;
    }
    const laterMetadata = rendererMetadata(laterPresentation);
    if (index === laterMetadataIdentityMismatchIndex) laterMetadata.pairEpoch += 1;
    laterMetadataMutators[index]?.(laterMetadata);
    const prefix = `${index + 1}-${projector.key}`;
    const lock = fidelityLock(
      authority,
      runId,
      projector,
      corpusGame,
      reportArtifacts(release),
      corpusBytes.byteLength,
      sourceRepository.records,
    );
    const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
    const lockRef = await writeEvidence(directory, `${prefix}-evidence-lock.json`, lockBytes);
    const expectedLockAuthority = {
      release: structuredClone(authority),
      run: { runId, gameKey: projector.key },
      corpus: structuredClone(lock.corpus),
      selectedGame: structuredClone(lock.selectedGame),
      artifacts: structuredClone(lock.artifacts),
      sources: structuredClone(lock.sources),
    };
    const hostIdentitySha256 = expectedFidelityHostIdentitySha256(
      lock,
      lockRef.sha256,
      expectedLockAuthority,
    );
    const trigger = report.game.firstPresentedXfb.trigger;
    const firstIdentity = {
      relayRequestId: trigger.relayRequestId,
      renderCallOrdinal: trigger.renderCallOrdinal,
      requestFlags: trigger.requestFlags,
      sequenceLo: trigger.sequenceLo,
      sequenceHi: trigger.sequenceHi,
      opaqueRequestBytes: trigger.opaqueRequestBytes,
      opaqueRequestSha256: trigger.opaqueRequestSha256,
      presentedBefore: false,
    };
    const records = [];
    let previousRecordSha256 = null;
    const add = (kind, fields) => {
      const payload = checkpointPayload(
        runId,
        projector.key,
        records.length + 1,
        kind,
        fields,
      );
      const core = {
        schema: "lazuli-resident-renderer-fidelity-durable-record-v1",
        serverSequence: records.length + 1,
        receivedAtUnixMs: 1_800_000_000_000 + records.length,
        hostIdentitySha256,
        evidenceLockSha256: lockRef.sha256,
        previousRecordSha256,
        payloadSha256: canonicalHash(payload),
        payload,
      };
      const record = { ...core, recordSha256: canonicalHash(core) };
      records.push(record);
      previousRecordSha256 = record.recordSha256;
      return record;
    };
    const readyArtifactFields = envelopeArtifactFields("machineEvidence", readyMachine);
    readyArtifactMutators[index]?.(readyArtifactFields);
    add("capture-machine-initialized", {
      machineSessionId: runId,
      bootStatus: 3,
      bootReads: 5,
      ...readyArtifactFields,
      runPolicy: firstFrameRunPolicy(authority.executionAssets.worker.url),
      runSummary: pristineRunSummary(),
    });
    add("pre-submit", firstIdentity);
    add("submit-returned", {
      ...firstIdentity,
      returnedPromise: true,
      presentedAfterReturn: report.game.firstPresentedXfb.transition.afterReturn,
    });
    const firstReceipt = add("receipt-resolved", {
      ...firstIdentity,
      receiptBytes: report.game.firstPresentedXfb.receipt.bytes,
      receiptSha256: report.game.firstPresentedXfb.receipt.sha256,
      presentedAfterResolution: true,
    });
    const firstMetadataBytes = Buffer.from(canonicalFidelityJson(
      report.game.firstPresentedXfb.readback.metadata,
    ), "utf8");
    const firstOwned = add("first-frame-renderer-owned", {
      ...receiptAnnotation(firstIdentity, firstReceipt),
      machineSessionId: runId,
      readbackMetadataBytes: firstMetadataBytes.byteLength,
      readbackMetadataSha256: sha256(firstMetadataBytes),
      rgbaBytes: firstRgba.byteLength,
      rgbaSha256: sha256(firstRgba),
    });

    let baselineIdentity = firstIdentity;
    let baselineReceipt = firstReceipt;
    let baselineOwned = null;
    const addBaseline = () => {
      const metadataBytes = Buffer.from(canonicalFidelityJson(baselineMetadata), "utf8");
      const baselineArtifactFields = {
        ...envelopeArtifactFields("gameFidelity", baselineFidelity),
        ...envelopeArtifactFields("machineEvidence", baselineMachine),
      };
      baselineArtifactMutators[index]?.(baselineArtifactFields);
      baselineOwned = add("fidelity-baseline-owned", {
        ...receiptAnnotation(baselineIdentity, baselineReceipt),
        machineSessionId: runId,
        phase: 1,
        ...baselineArtifactFields,
        readbackMetadataBytes: metadataBytes.byteLength,
        readbackMetadataSha256: sha256(metadataBytes),
        rgbaBytes: baselineRgba.byteLength,
        rgbaSha256: sha256(baselineRgba),
        requestedButtons: controller.buttons,
        requestedStickXyCxy: controller.stickXyCxy,
        requestedTriggerLrab: controller.triggerLrab,
      });
    };
    const addDistinctBaseline = () => {
      baselineIdentity = {
        ...firstIdentity,
        relayRequestId: 2,
        renderCallOrdinal: 2,
        sequenceLo: 2,
      };
      add("pre-submit", baselineIdentity);
      add("submit-returned", {
        ...baselineIdentity,
        returnedPromise: true,
        presentedAfterReturn: true,
      });
      baselineReceipt = add("receipt-resolved", {
        ...baselineIdentity,
        receiptBytes: 80,
        receiptSha256: sha256(Buffer.from("baseline receipt")),
        presentedAfterResolution: true,
      });
      addBaseline();
    };
    if (baselineMode === "same-pre") addBaseline();
    if (baselineMode === "distinct-pre") addDistinctBaseline();
    report.evidenceLock = { schema: lock.schema, sha256: lockRef.sha256 };
    report.capabilityBoundary.rendererProbeEventsExpected = 0;
    const prefixCount = records.length;
    Object.assign(report.game.fidelityCheckpoints, {
      evidenceLockSha256: lockRef.sha256,
      recordCount: prefixCount,
      probeEventCount: 0,
      maximumProbeEventsPerSubmission: 0,
      kindCounts: Object.fromEntries([...new Set(records.map(record => record.payload.kind))]
        .map(kind => [kind, records.filter(record => record.payload.kind === kind).length])),
      firstRecordSha256: records[0].recordSha256,
      lastRecordSha256: records.at(-1).recordSha256,
      lastServerSequence: prefixCount,
    });
    const reportBytes = Buffer.from(canonicalFidelityJson(report), "utf8");
    const reportBound = add("first-frame-report-bound", {
      machineSessionId: runId,
      reportBytes: reportBytes.byteLength,
      reportSha256: sha256(reportBytes),
      ...envelopeArtifactFields(
        "machineEvidence",
        report.game.adapterDiagnostics.final.machineEvidence,
      ),
      firstFrameRendererRecordSha256: firstOwned.recordSha256,
      baselineRecordSha256: baselineOwned?.recordSha256 ?? null,
    });
    if (baselineMode === "distinct-post") addDistinctBaseline();
    const witness = add("controller-witness-published", {
      machineSessionId: runId,
      baselineRecordSha256: baselineOwned.recordSha256,
      firstFrameReportRecordSha256: reportBound.recordSha256,
      sequenceLo: witnessSequenceOverrides[index] ?? witnessSequence,
      sequenceHi: 0,
      buttons: controller.buttons,
      stickXyCxy: controller.stickXyCxy,
      triggerLrab: controller.triggerLrab,
      status: witnessStatusOverrides[index] ?? 1,
      ...envelopeArtifactFields("machineEvidence", retainedPreWitnessMachine),
    });
    const acceptedIdentity = {
      ...firstIdentity,
      relayRequestId: 3,
      renderCallOrdinal: 3,
      sequenceLo: acceptedSequenceOverrides[index] ?? 3,
    };
    add("pre-submit", acceptedIdentity);
    add("submit-returned", {
      ...acceptedIdentity,
      returnedPromise: true,
      presentedAfterReturn: true,
    });
    const acceptedReceipt = add("receipt-resolved", {
      ...acceptedIdentity,
      receiptBytes: 80,
      receiptSha256: sha256(Buffer.from("accepted receipt")),
      presentedAfterResolution: true,
    });
    const laterMetadataBytes = Buffer.from(canonicalFidelityJson(laterMetadata), "utf8");
    const accepted = add("fidelity-accepted-owned", {
      ...receiptAnnotation(acceptedIdentity, acceptedReceipt),
      machineSessionId: runId,
      phase: 5,
      ...envelopeArtifactFields("gameFidelity", fidelityEnvelope),
      ...envelopeArtifactFields("machineEvidence", terminalMachine),
      readbackMetadataBytes: laterMetadataBytes.byteLength,
      readbackMetadataSha256: sha256(laterMetadataBytes),
      rgbaBytes: laterRgba.byteLength,
      rgbaSha256: sha256(laterRgba),
      witnessRecordSha256: witness.recordSha256,
    });
    add("fidelity-terminal", {
      machineSessionId: runId,
      phase: 5,
      baselineRecordSha256: baselineOwned.recordSha256,
      acceptedRecordSha256: accepted.recordSha256,
      ...envelopeArtifactFields("gameFidelity", fidelityEnvelope),
      ...envelopeArtifactFields("machineEvidence", terminalMachine),
      runSummary: cumulativeRunSummary(operatorPublicationCount),
    });
    const journalBytes = Buffer.from(`${records.map(record => JSON.stringify(record)).join("\n")}\n`);
    const [
      journalRef,
      firstRef,
      baselineRef,
      laterRef,
      reportRef,
      readyRef,
      baselineFidelityRef,
      baselineMachineRef,
      preWitnessRef,
      terminalRef,
      fidelityRef,
      baselineMetadataRef,
      laterMetadataRef,
    ] = await Promise.all([
      writeEvidence(directory, `${prefix}-checkpoint-journal.jsonl`, journalBytes),
      writeEvidence(directory, `${prefix}-first.rgba`, firstRgba),
      writeEvidence(directory, `${prefix}-baseline.rgba`, baselineRgba),
      writeEvidence(directory, `${prefix}-later.rgba`, laterRgba),
      writeCanonicalEvidence(directory, `${prefix}-first-frame.json`, report),
      writeCanonicalEvidence(directory, `${prefix}-ready-machine.json`, readyMachine),
      writeCanonicalEvidence(directory, `${prefix}-baseline-fidelity.json`, baselineFidelity),
      writeCanonicalEvidence(directory, `${prefix}-baseline-machine.json`, baselineMachine),
      writeCanonicalEvidence(
        directory,
        `${prefix}-pre-witness-machine.json`,
        retainedPreWitnessMachine,
      ),
      writeCanonicalEvidence(directory, `${prefix}-terminal-machine.json`, terminalMachine),
      writeCanonicalEvidence(directory, `${prefix}-game-fidelity.json`, fidelityEnvelope),
      writeCanonicalEvidence(directory, `${prefix}-baseline-metadata.json`, baselineMetadata),
      writeCanonicalEvidence(directory, `${prefix}-later-metadata.json`, laterMetadata),
    ]);
    games.push({
      key: projector.key,
      runId,
      capturedAt: `2026-08-18T0${index}:00:00.000Z`,
      releaseId: release.releaseId,
      executionAssetsSha256,
      operatorPublications: {
        algorithm: "alternating-neutral-a-v1",
        count: operatorPublicationCount,
      },
      evidenceLock: lockRef,
      checkpointJournal: journalRef,
      firstFrameReport: reportRef,
      readyMachineEvidence: readyRef,
      baselineGameFidelityRecord: baselineFidelityRef,
      baselineMachineEvidence: baselineMachineRef,
      preWitnessMachineEvidence: preWitnessRef,
      terminalMachineEvidence: terminalRef,
      gameFidelityRecord: fidelityRef,
      frames: {
        firstVisible: firstRef,
        baseline: {
          metadata: baselineMetadataRef,
          rgba: baselineRef,
        },
        later: {
          metadata: laterMetadataRef,
          rgba: laterRef,
        },
      },
    });
  }
  const attestation = {
    schema: PRODUCTION_FIDELITY_ATTESTATION_SCHEMA,
    createdAt: "2026-08-18T08:00:00.000Z",
    corpus: { sha256: CORPUS_SHA },
    release: {
      schema: 4,
      releaseId: release.releaseId,
      manifestSha256: sha256(releaseBytes),
      sourceCommit: release.source.commit,
    },
    controlledPerformance: {
      runId: performanceRunId,
      releaseId: release.releaseId,
      executionAssetsSha256,
      runtimeAssets,
      report: performanceReportRef,
      lock: performanceLockRef,
    },
    games,
  };
  const attestationPath = join(directory, "attestation.json");
  await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
  return {
    directory,
    attestation,
    attestationPath,
    release,
    releasePath,
    repositoryPath: sourceRepository.repository,
  };
}

test("exact seven-title evidence passes the fail-closed production gate", async t => {
  const fixture = await buildAttestationFixture(t);
  const summary = await validateProductionFidelityAttestationFiles({
    attestationPath: fixture.attestationPath,
    releaseManifestPath: fixture.releasePath,
    corpusPath: CORPUS_PATH,
    repositoryPath: fixture.repositoryPath,
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.releaseId, fixture.release.releaseId);
  assert.equal(summary.games.length, 7);
  assert.deepEqual(summary.games.map(game => game.key), GAME_FIDELITY_V1_PROJECTORS.map(game => game.key));
  assert.ok(summary.games.every(game => game.sustained.viFields === "120"));
  assert.ok(summary.games.every(game => game.sustained.presentedFrames === "64"));
});

test("same receipt and distinct pre/post-report Baselines preserve exact causal joins", async t => {
  const fixture = await buildAttestationFixture(t, {
    baselineModes: ["same-pre", "distinct-pre", "distinct-post"],
    armCycles: [1_700, 1_900, 2_100],
    operatorPublicationCounts: [0, 0, 2],
  });
  const summary = await validateProductionFidelityAttestationFiles({
    attestationPath: fixture.attestationPath,
    releaseManifestPath: fixture.releasePath,
    corpusPath: CORPUS_PATH,
    repositoryPath: fixture.repositoryPath,
  });
  assert.equal(summary.ok, true);
});

test("report-final MachineEvidence is ordered at its durable report binding", async t => {
  const fixture = await buildAttestationFixture(t, {
    baselineSnapshotSerials: [5],
  });
  await assert.rejects(
    validateFixture(fixture),
    /games\[0\]\.firstFrameReport: snapshot serial did not increase/,
  );
});

test("retained ready MachineEvidence exactly reuses the report-ready envelope", async t => {
  const fixture = await buildAttestationFixture(t, {
    readySnapshotSerials: [2],
  });
  await assert.rejects(
    validateFixture(fixture),
    /readyMachineEvidence: differed from the report ready boundary/,
  );
});

test("same-receipt Baseline metadata and RGBA must be byte-identical to first ownership", async t => {
  for (const options of [
    { sameReceiptRgbaMismatchIndex: 0 },
    { sameReceiptMetadataMismatchIndex: 0 },
  ]) {
    const fixture = await buildAttestationFixture(t, options);
    await assert.rejects(
      validateProductionFidelityAttestationFiles({
        attestationPath: fixture.attestationPath,
        releaseManifestPath: fixture.releasePath,
        corpusPath: CORPUS_PATH,
        repositoryPath: fixture.repositoryPath,
      }),
      /same-receipt Baseline (?:differed from first frame|did not reuse first-frame renderer ownership)/,
    );
  }
});

test("the sustained threshold is owned by pre-witness evidence, not terminal advancement", async t => {
  for (const options of [
    { preWitnessViDeltas: [119] },
    { preWitnessPresentationDeltas: [63] },
  ]) {
    const fixture = await buildAttestationFixture(t, options);
    await assert.rejects(
      validateProductionFidelityAttestationFiles({
        attestationPath: fixture.attestationPath,
        releaseManifestPath: fixture.releasePath,
        corpusPath: CORPUS_PATH,
        repositoryPath: fixture.repositoryPath,
      }),
      /sustained\.(?:viFields|presentedFrames)/,
    );
  }
});

test("the retained pre-witness leaf cannot be replaced by fresh post-publication evidence", async t => {
  const fixture = await buildAttestationFixture(t, { postWitnessPreWitnessIndex: 0 });
  await assert.rejects(
    validateProductionFidelityAttestationFiles({
      attestationPath: fixture.attestationPath,
      releaseManifestPath: fixture.releasePath,
      corpusPath: CORPUS_PATH,
      repositoryPath: fixture.repositoryPath,
    }),
    /durable pre-publication state/,
  );
});

test("renderer metadata identities are derived and must match Rust GFP exactly", async t => {
  const mutations = [
    metadata => { metadata.presentationSerial += 1; },
    metadata => { metadata.pairEpoch += 1; },
    metadata => { metadata.fields.top.generation += 1; },
    metadata => { metadata.fields.top.row = 0; },
    metadata => { metadata.presentationMode = "single-field"; },
    metadata => { metadata.fields = { bottom: metadata.fields.top }; },
    metadata => { metadata.width += 1; metadata.displayWidth += 1; },
  ];
  for (const mutate of mutations) {
    const fixture = await buildAttestationFixture(t, { laterMetadataMutators: [mutate] });
    await assert.rejects(
      validateFixture(fixture),
      /frames\.later\.(?:derivedPresentation|metadata\.fields)/,
    );
  }
  const sequence = await buildAttestationFixture(t, { acceptedSequenceOverrides: [4] });
  await assert.rejects(validateFixture(sequence), /frames\.later\.derivedPresentation/);
});

test("v3 prelaunch verifier freezes raw authority, harness, and all packaged bytes", async t => {
  const fixture = await buildAttestationFixture(t);
  const workspace = join(fixture.directory, "prelaunch-workspace");
  for (const relative of PRODUCTION_SOURCE_PATHS) {
    const destination = join(workspace, relative);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, await readFile(join(fixture.repositoryPath, relative)));
  }
  const corpusBytes = await readFile(CORPUS_PATH);
  const isolatedCorpusPath = join(workspace, "tools/compatibility/games/corpus.json");
  await mkdir(join(isolatedCorpusPath, ".."), { recursive: true });
  await writeFile(isolatedCorpusPath, corpusBytes);
  const assetPath = role => join(
    fixture.directory,
    fixture.attestation.controlledPerformance.runtimeAssets[role].path,
  );
  const artifactPaths = {
    "browser_machine.wasm": assetPath("core"),
    "resident_dispatcher.wasm": assetPath("dispatcher"),
    "core_run_coordinator.wasm": assetPath("coordinator"),
    "browser_renderer.js": assetPath("rendererJavascript"),
    "browser_renderer_bg.wasm": assetPath("rendererWasm"),
  };
  const executionAssetPaths = Object.fromEntries(
    Object.keys(fixture.attestation.controlledPerformance.runtimeAssets).map(role => [
      role,
      assetPath(role),
    ]),
  );
  const runId = "88888888-0000-4000-8000-888888888888";
  const projector = GAME_FIDELITY_V1_PROJECTORS[0];
  const game = JSON.parse(corpusBytes).games[0];
  const authority = await productionFidelityLockAuthorityFromFiles({
    releaseManifestPath: fixture.releasePath,
    corpusPath: isolatedCorpusPath,
    artifactPaths,
    runId,
    gameKey: game.key,
    repository: fixture.repositoryPath,
  });
  const lock = fidelityLock(
    authority.release,
    runId,
    projector,
    game,
    authority.artifacts,
    corpusBytes.byteLength,
    authority.sources,
  );
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  const evidenceLockSha256 = sha256(lockBytes);
  const options = {
    evidenceLockSha256,
    workspace,
    artifactPaths,
    executionAssetPaths,
    releaseManifestPath: fixture.releasePath,
    expectedAuthority: authority,
  };
  assert.equal(
    await verifyResidentProductionFidelityEvidenceLockFiles(lockBytes, options),
    PRODUCTION_SOURCE_PATHS.length + 16,
  );
  await assert.rejects(
    verifyResidentProductionFidelityEvidenceLockFiles(lockBytes, {
      ...options,
      evidenceLockSha256: "f".repeat(64),
    }),
    /raw production evidence lock SHA-256/,
  );

  for (const relative of PRODUCTION_SOURCE_PATHS) {
    const source = join(workspace, relative);
    const original = await readFile(source);
    await writeFile(source, Buffer.from("substituted locked harness source\n"));
    await assert.rejects(
      verifyResidentProductionFidelityEvidenceLockFiles(lockBytes, options),
      /does not match the immutable production evidence lock/,
    );
    await writeFile(source, original);
  }
  for (const role of ["adapter", "worker"]) {
    const source = executionAssetPaths[role];
    const original = await readFile(source);
    await writeFile(source, Buffer.from(`substituted packaged ${role}\n`));
    await assert.rejects(
      verifyResidentProductionFidelityEvidenceLockFiles(lockBytes, options),
      new RegExp(`packaged execution asset ${role}`),
    );
    await writeFile(source, original);
  }
});

test("release, performance, seven-title coverage, and raw evidence mutations fail closed", async t => {
  const mutations = [
    [attestation => { attestation.games.pop(); }, /games\.length/],
    [attestation => { attestation.games[1].key = attestation.games[0].key; }, /games\[1\]\.key/],
    [attestation => { attestation.release.releaseId = "f".repeat(64); }, /release\.releaseId/],
    [attestation => { attestation.controlledPerformance.executionAssetsSha256 = "f".repeat(64); }, /controlledPerformance\.executionAssetsSha256/],
    [attestation => { attestation.games[0].frames.later.rgba.sha256 = "f".repeat(64); }, /frames\.later\.rgba\.sha256/],
    [attestation => { attestation.games[0].frames.later.rgba = attestation.games[0].frames.baseline.rgba; }, /frames\.later\.rgba/],
    [attestation => { attestation.games[0].frames.later.metadata.sha256 = "f".repeat(64); }, /frames\.later\.metadata\.sha256/],
    [attestation => { attestation.games[0].capturedAt = "2026-08-19T00:00:00.000Z"; }, /later than the attestation/],
    [attestation => { attestation.controlledPerformance.runtimeAssets.worker.sha256 = "f".repeat(64); }, /runtimeAssets\.worker\.sha256/],
    [attestation => { attestation.games[0].games = []; }, /expected exact keys/],
  ];
  for (const [mutate, pattern] of mutations) {
    const fixture = await buildAttestationFixture(t);
    mutate(fixture.attestation);
    await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
    await assert.rejects(
      validateProductionFidelityAttestationFiles({
        attestationPath: fixture.attestationPath,
        releaseManifestPath: fixture.releasePath,
        corpusPath: CORPUS_PATH,
        repositoryPath: fixture.repositoryPath,
      }),
      pattern,
    );
  }
});

test("v3 per-run lock and resolved zero-probe journal authority cannot be relabeled", async t => {
  for (const field of ["evidenceLock", "checkpointJournal"]) {
    const fixture = await buildAttestationFixture(t);
    fixture.attestation.games[0][field] = structuredClone(fixture.attestation.games[1][field]);
    await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
    await assert.rejects(
      validateProductionFidelityAttestationFiles({
        attestationPath: fixture.attestationPath,
        releaseManifestPath: fixture.releasePath,
        corpusPath: CORPUS_PATH,
        repositoryPath: fixture.repositoryPath,
      }),
      /production authority|evidence lock|journal|runId|gameKey/,
    );
  }

  for (const role of ["adapter", "worker", "frontend"]) {
    const fixture = await buildAttestationFixture(t);
    await mutateReferencedJson(
      fixture,
      fixture.attestation.games[0].evidenceLock,
      lock => {
        lock.release.executionAssets[role].sha256 = "f".repeat(64);
        lock.release.executionAssetsSha256 = canonicalHash(lock.release.executionAssets);
      },
    );
    await assert.rejects(
      validateProductionFidelityAttestationFiles({
        attestationPath: fixture.attestationPath,
        releaseManifestPath: fixture.releasePath,
        corpusPath: CORPUS_PATH,
        repositoryPath: fixture.repositoryPath,
      }),
      /production authority/,
    );
  }

  const imageRelabel = await buildAttestationFixture(t);
  await mutateReferencedJson(
    imageRelabel,
    imageRelabel.attestation.games[0].evidenceLock,
    lock => { lock.selectedGame.image.sha256 = "f".repeat(64); },
  );
  await assert.rejects(
    validateProductionFidelityAttestationFiles({
      attestationPath: imageRelabel.attestationPath,
      releaseManifestPath: imageRelabel.releasePath,
      corpusPath: CORPUS_PATH,
      repositoryPath: imageRelabel.repositoryPath,
    }),
    /production authority/,
  );

  const unresolved = await buildAttestationFixture(t);
  await replaceCheckpointJournal(unresolved, 0, payloads => payloads.slice(0, 2));
  await assert.rejects(
    validateProductionFidelityAttestationFiles({
      attestationPath: unresolved.attestationPath,
      releaseManifestPath: unresolved.releasePath,
      corpusPath: CORPUS_PATH,
      repositoryPath: unresolved.repositoryPath,
    }),
    /fully resolved renderer receipt/,
  );

  const injectedProbe = await buildAttestationFixture(t);
  await replaceCheckpointJournal(injectedProbe, 0, payloads => [
    payloads[0],
    payloads[1],
    checkpointPayload(payloads[0].runId, payloads[0].gameKey, 3, "renderer-probe-event", {
      relayRequestId: payloads[1].relayRequestId,
      renderCallOrdinal: payloads[1].renderCallOrdinal,
      words: [1, 2, 3, 4, 5, 6],
    }),
    payloads[2],
    payloads[3],
  ].map((payload, index) => ({ ...payload, clientSequence: index + 1 })));
  await assert.rejects(
    validateProductionFidelityAttestationFiles({
      attestationPath: injectedProbe.attestationPath,
      releaseManifestPath: injectedProbe.releasePath,
      corpusPath: CORPUS_PATH,
      repositoryPath: injectedProbe.repositoryPath,
    }),
    /forbidden by the production default-off renderer lock/,
  );
});

test("controlled-performance packaged adapter and Worker substitutions fail closed", async t => {
  for (const role of ["adapter", "worker"]) {
    const fixture = await buildAttestationFixture(t);
    const reference = fixture.attestation.controlledPerformance.runtimeAssets[role];
    const substituted = Buffer.from(`substituted packaged ${role}\n`);
    await writeFile(join(fixture.directory, reference.path), substituted);
    Object.assign(reference, {
      bytes: substituted.byteLength,
      sha256: sha256(substituted),
    });
    await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
    await assert.rejects(
      validateProductionFidelityAttestationFiles({
        attestationPath: fixture.attestationPath,
        releaseManifestPath: fixture.releasePath,
        corpusPath: CORPUS_PATH,
        repositoryPath: fixture.repositoryPath,
      }),
      new RegExp(`runtimeAssets\\.${role}`),
    );
  }
});

test("controlled-performance sources remain bound to the release commit", async t => {
  const fixture = await buildAttestationFixture(t);
  const performance = fixture.attestation.controlledPerformance;
  await mutateReferencedJson(fixture, performance.lock, lock => {
    const [firstSource] = PRODUCTION_SOURCE_PATHS;
    lock.sources[firstSource].sha256 = "f".repeat(64);
  });
  const changedLockSha256 = performance.lock.sha256;
  await mutateReferencedJson(fixture, performance.report, report => {
    report.evidenceLock.sha256 = changedLockSha256;
  });
  await assert.rejects(validateFixture(fixture), /trustedLock\.sources/);
});

async function mutateReferencedJson(fixture, reference, mutate) {
  const file = join(fixture.directory, reference.path);
  const value = JSON.parse(await readFile(file, "utf8"));
  mutate(value);
  const changed = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(file, changed);
  Object.assign(reference, { bytes: changed.byteLength, sha256: sha256(changed) });
  await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
}

async function replaceReferencedBytes(fixture, reference, bytesValue) {
  const bytes = Buffer.from(bytesValue);
  await writeFile(join(fixture.directory, reference.path), bytes);
  Object.assign(reference, { bytes: bytes.byteLength, sha256: sha256(bytes) });
  await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
}

async function replaceCheckpointJournal(fixture, gameIndex, transformPayloads) {
  const reference = fixture.attestation.games[gameIndex].checkpointJournal;
  const file = join(fixture.directory, reference.path);
  const current = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  const payloads = transformPayloads(current.map(record => structuredClone(record.payload)));
  const records = durableRecords(
    payloads,
    current[0].evidenceLockSha256,
    current[0].hostIdentitySha256,
  );
  const changed = Buffer.from(`${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  await writeFile(file, changed);
  Object.assign(reference, { bytes: changed.byteLength, sha256: sha256(changed) });
  await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
}

async function persistAttestation(fixture) {
  await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
}

function validateFixture(fixture) {
  return validateProductionFidelityAttestationFiles({
    attestationPath: fixture.attestationPath,
    releaseManifestPath: fixture.releasePath,
    corpusPath: CORPUS_PATH,
    repositoryPath: fixture.repositoryPath,
  });
}

async function replaceCanonicalReferencedJson(fixture, reference, mutate) {
  const value = JSON.parse(await readFile(join(fixture.directory, reference.path), "utf8"));
  mutate(value);
  await replaceReferencedBytes(
    fixture,
    reference,
    Buffer.from(canonicalFidelityJson(value), "utf8"),
  );
}

test("every production run reference is rehashed before any retained leaf is trusted", async t => {
  const fixture = await buildAttestationFixture(t);
  const run = fixture.attestation.games[0];
  const references = [
    ["evidenceLock", run.evidenceLock],
    ["checkpointJournal", run.checkpointJournal],
    ["firstFrameReport", run.firstFrameReport],
    ["readyMachineEvidence", run.readyMachineEvidence],
    ["baselineGameFidelityRecord", run.baselineGameFidelityRecord],
    ["baselineMachineEvidence", run.baselineMachineEvidence],
    ["preWitnessMachineEvidence", run.preWitnessMachineEvidence],
    ["terminalMachineEvidence", run.terminalMachineEvidence],
    ["gameFidelityRecord", run.gameFidelityRecord],
    ["frames.firstVisible", run.frames.firstVisible],
    ["frames.baseline.metadata", run.frames.baseline.metadata],
    ["frames.baseline.rgba", run.frames.baseline.rgba],
    ["frames.later.metadata", run.frames.later.metadata],
    ["frames.later.rgba", run.frames.later.rgba],
  ];
  for (const [name, reference] of references) {
    const original = reference.sha256;
    reference.sha256 = original === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    await persistAttestation(fixture);
    await assert.rejects(validateFixture(fixture), new RegExp(name.replaceAll(".", "\\.")));
    reference.sha256 = original;
  }
  await persistAttestation(fixture);
  assert.equal((await validateFixture(fixture)).ok, true);
});

test("canonical JSON, base64 spelling, decoded opaque digests, and raw RGBA are recomputed", async t => {
  {
    const fixture = await buildAttestationFixture(t);
    const reference = fixture.attestation.games[0].readyMachineEvidence;
    const value = JSON.parse(await readFile(join(fixture.directory, reference.path), "utf8"));
    await replaceReferencedBytes(
      fixture,
      reference,
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    );
    await assert.rejects(validateFixture(fixture), /recursive-key canonical UTF-8 JSON bytes/);
  }
  for (const [field, mutate, pattern] of [
    ["readyMachineEvidence", envelope => { envelope.payload += "=="; }, /canonical padded base64/],
    ["readyMachineEvidence", envelope => { envelope.encoding = "Base64"; }, /encoding/],
    ["readyMachineEvidence", envelope => {
      const opaque = Buffer.from(envelope.payload, "base64");
      opaque[100] ^= 1;
      envelope.payload = opaque.toString("base64");
    }, /machineEvidenceEnvelopeSha256/],
    ["baselineGameFidelityRecord", envelope => {
      const opaque = Buffer.from(envelope.payload, "base64");
      opaque[100] ^= 1;
      envelope.payload = opaque.toString("base64");
    }, /gameFidelityEnvelopeSha256/],
  ]) {
    const fixture = await buildAttestationFixture(t);
    const reference = fixture.attestation.games[0][field];
    await replaceCanonicalReferencedJson(fixture, reference, mutate);
    await assert.rejects(validateFixture(fixture), pattern);
  }
  for (const [options, pattern] of [
    [{
      readyArtifactMutators: [fields => {
        fields.machineEvidenceOpaqueSha256 = "f".repeat(64);
      }],
    }, /machineEvidenceOpaqueSha256/],
    [{
      baselineArtifactMutators: [fields => {
        fields.gameFidelityOpaqueSha256 = "f".repeat(64);
      }],
    }, /gameFidelityOpaqueSha256/],
  ]) {
    const fixture = await buildAttestationFixture(t, options);
    await assert.rejects(validateFixture(fixture), pattern);
  }
  for (const referenceAt of [
    run => run.frames.firstVisible,
    run => run.frames.baseline.rgba,
    run => run.frames.later.rgba,
  ]) {
    const fixture = await buildAttestationFixture(t);
    const reference = referenceAt(fixture.attestation.games[0]);
    const bytes = Buffer.from(await readFile(join(fixture.directory, reference.path)));
    bytes[1] ^= 1;
    await replaceReferencedBytes(fixture, reference, bytes);
    await assert.rejects(validateFixture(fixture), /rgbaSha256|frames\.firstVisible\.sha256/);
  }
});

test("cross-run retained-leaf splices fail every durable ownership join", async t => {
  const fixture = await buildAttestationFixture(t);
  const first = fixture.attestation.games[0];
  const second = fixture.attestation.games[1];
  const referencePairs = [
    ["firstFrameReport", () => first.firstFrameReport, () => second.firstFrameReport],
    ["readyMachineEvidence", () => first.readyMachineEvidence, () => second.readyMachineEvidence],
    ["baselineGameFidelityRecord", () => first.baselineGameFidelityRecord, () => second.baselineGameFidelityRecord],
    ["baselineMachineEvidence", () => first.baselineMachineEvidence, () => second.baselineMachineEvidence],
    ["preWitnessMachineEvidence", () => first.preWitnessMachineEvidence, () => second.preWitnessMachineEvidence],
    ["terminalMachineEvidence", () => first.terminalMachineEvidence, () => second.terminalMachineEvidence],
    ["gameFidelityRecord", () => first.gameFidelityRecord, () => second.gameFidelityRecord],
    ["frames.firstVisible", () => first.frames.firstVisible, () => second.frames.firstVisible],
    ["frames.baseline.metadata", () => first.frames.baseline.metadata, () => second.frames.baseline.metadata],
    ["frames.baseline.rgba", () => first.frames.baseline.rgba, () => second.frames.baseline.rgba],
    ["frames.later.metadata", () => first.frames.later.metadata, () => second.frames.later.metadata],
    ["frames.later.rgba", () => first.frames.later.rgba, () => second.frames.later.rgba],
  ];
  for (const [name, getFirst, getSecond] of referencePairs) {
    const original = structuredClone(getFirst());
    Object.assign(getFirst(), structuredClone(getSecond()));
    await persistAttestation(fixture);
    await assert.rejects(validateFixture(fixture), /games\[0\]|report|MachineEvidence|GameFidelity/);
    Object.assign(getFirst(), original);
  }
  await persistAttestation(fixture);
  assert.equal((await validateFixture(fixture)).ok, true);
});

test("durable journal receipt, session, order, sequence, status, words, and SHA joins fail closed", async t => {
  for (const [mutate, pattern] of [
    [payloads => {
      payloads.find(payload => payload.kind === "fidelity-terminal").machineSessionId =
        "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
    }, /machine session/],
    [payloads => {
      payloads.find(payload => payload.kind === "fidelity-terminal").baselineRecordSha256 =
        "f".repeat(64);
    }, /terminal fidelity authority join|baselineRecordSha256/],
    [payloads => {
      payloads.find(payload => payload.kind === "fidelity-accepted-owned").receiptSha256 =
        "f".repeat(64);
    }, /resolved receipt changed|receiptSha256/],
    [payloads => {
      payloads.find(payload => payload.kind === "controller-witness-published").buttons ^= 1;
    }, /durable Rust Baseline request|requestedButtons/],
    [payloads => {
      payloads.find(payload => payload.kind === "fidelity-terminal").clientSequence -= 1;
    }, /clientSequence/],
    [payloads => {
      payloads.find(payload => payload.kind === "fidelity-terminal")
        .gameFidelityOpaqueSha256 = "f".repeat(64);
    }, /hard Accepted boundary|gameFidelityOpaqueSha256/],
  ]) {
    const fixture = await buildAttestationFixture(t);
    await replaceCheckpointJournal(fixture, 0, payloads => {
      mutate(payloads);
      return payloads;
    });
    await assert.rejects(validateFixture(fixture), pattern);
  }
  for (const [options, pattern] of [
    [{ witnessSequenceOverrides: [2] }, /controller-witness-published.*sequence|publicationSequence/],
    [{ witnessStatusOverrides: [4] }, /known successful Rust publication status/],
  ]) {
    const fixture = await buildAttestationFixture(t, options);
    await assert.rejects(validateFixture(fixture), pattern);
  }
});

test("Baseline GFP is recomputed as the exact durable phase-one Rust record", async t => {
  const mutations = [
    bytes => { bytes[39] = 1; },
    bytes => { bytes.writeBigUInt64LE(0n, 10 * 4); },
    bytes => { bytes.writeBigUInt64LE(0n, 12 * 4); },
    bytes => { bytes.writeBigUInt64LE(2_099n, 18 * 4); },
    bytes => { bytes.writeBigUInt64LE(1n, 32 * 4); },
    bytes => { bytes.writeUInt32LE(8, 42 * 4); },
    bytes => { bytes[48 * 4] ^= 1; },
    bytes => { bytes.writeUInt32LE(2, 82 * 4); },
    bytes => { bytes[56 * 4] = 1; },
  ];
  for (const mutate of mutations) {
    const fixture = await buildAttestationFixture(t, {
      baselineFidelityMutators: [mutate],
    });
    await assert.rejects(validateFixture(fixture), /baselineGameFidelityRecord/);
  }
});

test("operator provenance and the cumulative run ledger are exact and cap-bound", async t => {
  for (const mutate of [
    run => { run.operatorPublications.algorithm = "caller-authored-v1"; },
    run => { run.operatorPublications.count = 65; },
    run => { run.operatorPublications.states = ["neutral", "a"]; },
  ]) {
    const fixture = await buildAttestationFixture(t);
    mutate(fixture.attestation.games[0]);
    await persistAttestation(fixture);
    await assert.rejects(validateFixture(fixture), /operatorPublications/);
  }

  const preBindingOperator = await buildAttestationFixture(t, {
    operatorPublicationCounts: [1],
  });
  await assert.rejects(validateFixture(preBindingOperator), /operatorPublications\.count/);

  const postBindingArm = await buildAttestationFixture(t, {
    baselineModes: ["distinct-post"],
    armCycles: [1_900],
  });
  await assert.rejects(validateFixture(postBindingArm), /did not follow report binding/);

  const reportPrefix = await buildAttestationFixture(t, { reportInputSampleCounts: [1] });
  await assert.rejects(validateFixture(reportPrefix), /inputSamples/);

  const summaryMutations = [
    summary => { summary.accepted = false; },
    summary => { summary.issuedRunCalls = 0; },
    summary => { summary.reportedExecutedCycles = "3001"; },
    summary => { summary.reportedExecutedInstructions = "2001"; },
    summary => { summary.reportedHostCalls = 65_536; },
    summary => { summary.reportedColdInstalls = 65_536; },
    summary => { summary.consecutiveZeroProgressSlices = 2; summary.maximumConsecutiveZeroProgressSlices = 1; },
    summary => { summary.zeroProgressSlices = 0; summary.maximumConsecutiveZeroProgressSlices = 1; },
    summary => { summary.zeroProgressSlices = 4_096; summary.maximumConsecutiveZeroProgressSlices = 4_096; },
    summary => { summary.elapsedWallMs = 600_000; },
    summary => { summary.wallTimeoutMs = 599_999; },
    summary => { summary.witnessPublications = 0; },
    summary => { summary.operatorPublications = 1; },
  ];
  for (const mutate of summaryMutations) {
    const fixture = await buildAttestationFixture(t);
    await replaceCheckpointJournal(fixture, 0, payloads => {
      mutate(payloads.find(payload => payload.kind === "fidelity-terminal").runSummary);
      return payloads;
    });
    await assert.rejects(validateFixture(fixture), /runSummary|operatorPublications/);
  }
});

test("authenticated terminal chronology and sustained bounds reject internally rehashed mutations", async t => {
  for (const [mutate, pattern] of [
    [bytes => bytes.writeUInt32LE(30, 116 * 4), /terminalMachineEvidence\.xfb/],
    [bytes => bytes.writeBigUInt64LE(120n, 36 * 4), /terminalMachineEvidence/],
    [bytes => {
      bytes.writeBigUInt64LE(0n, 139 * 4);
      bytes.writeBigUInt64LE(0n, 141 * 4);
    }, /terminalMachineEvidence/],
    [bytes => bytes.writeUInt32LE(0x1122_3344, 149 * 4), /packed witness words|si\.packetSha256/],
    [bytes => bytes.writeUInt32LE(2, 152 * 4), /terminalMachineEvidence/],
  ]) {
    const fixture = await buildAttestationFixture(t, {
      terminalMachineMutators: [mutate],
    });
    await assert.rejects(
      validateProductionFidelityAttestationFiles({
        attestationPath: fixture.attestationPath,
        releaseManifestPath: fixture.releasePath,
        corpusPath: CORPUS_PATH,
        repositoryPath: fixture.repositoryPath,
      }),
      pattern,
    );
  }
});

test("terminal SI may advance beyond receipt while scheduledCycle remains non-monotonic", async t => {
  const fixture = await buildAttestationFixture(t);
  const summary = await validateProductionFidelityAttestationFiles({
    attestationPath: fixture.attestationPath,
    releaseManifestPath: fixture.releasePath,
    corpusPath: CORPUS_PATH,
    repositoryPath: fixture.repositoryPath,
  });
  assert.equal(summary.ok, true);

  const tooEarly = await buildAttestationFixture(t, {
    fidelityMutators: [bytes => bytes.writeUInt32LE(14, 44 * 4)],
  });
  await assert.rejects(
    validateProductionFidelityAttestationFiles({
      attestationPath: tooEarly.attestationPath,
      releaseManifestPath: tooEarly.releasePath,
      corpusPath: CORPUS_PATH,
      repositoryPath: tooEarly.repositoryPath,
    }),
    /precedes the GFP guest-receipt poll boundary/,
  );
});

test("raw RGBA visibility is recomputed after the byte digest is authenticated", async t => {
  const fixture = await buildAttestationFixture(t, { laterRgbaInvisibleIndex: 0 });
  await assert.rejects(
    validateProductionFidelityAttestationFiles({
      attestationPath: fixture.attestationPath,
      releaseManifestPath: fixture.releasePath,
      corpusPath: CORPUS_PATH,
      repositoryPath: fixture.repositoryPath,
    }),
    /no non-black\/non-white visible pixels|fewer than two RGB colors/,
  );
});

test("evidence references cannot escape the attestation directory", async t => {
  const fixture = await buildAttestationFixture(t);
  fixture.attestation.games[0].gameFidelityRecord = {
    path: "../outside.json",
    bytes: 1,
    sha256: "f".repeat(64),
  };
  await writeFile(fixture.attestationPath, `${JSON.stringify(fixture.attestation, null, 2)}\n`);
  await assert.rejects(
    validateProductionFidelityAttestationFiles({
      attestationPath: fixture.attestationPath,
      releaseManifestPath: fixture.releasePath,
      corpusPath: CORPUS_PATH,
      repositoryPath: fixture.repositoryPath,
    }),
    /contained portable relative path/,
  );
});
