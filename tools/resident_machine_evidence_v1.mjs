#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MACHINE_EVIDENCE_V1_ABI_VERSION = 1;
export const MACHINE_EVIDENCE_V1_BYTES = 816;
export const MACHINE_EVIDENCE_V1_WORDS = 204;
export const MACHINE_EVIDENCE_V1_TAG = 0x4c5a_4d45;
export const MACHINE_EVIDENCE_V1_TAG_TEXT = "LZME";
export const MACHINE_EVIDENCE_V1_SUMMARY_SCHEMA =
  "lazuli-rust-machine-evidence-diagnostic-summary-v1";
export const WARIOWARE_MACHINE_EVIDENCE_BOOT = Object.freeze({
  identifier: "GZWE01",
  revision: 0,
  discNumber: 0,
  format: 1,
  logicalBytes: "1459978240",
});

const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const KNOWN_FLAGS = 0x1f;
const DSP_LLE_VALID = 1;
const TERMINAL_ERROR = 1 << 1;
const HAS_XFB_VI = 1 << 2;
const HAS_SI_PUBLICATION = 1 << 3;
const HAS_BOOT_IDENTITY = 1 << 4;
const XFB_VI_PAIR_COMPLETING = 1;
const RENDER_PENDING_CAPACITY = 8;
const SI_QUEUE_CAPACITY = 64;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const DI_STATE_NAMES = Object.freeze([
  "idle",
  "start-pending",
  "awaiting-deadline",
  "awaiting-host",
  "read-ready",
]);
const DI_KIND_NAMES = Object.freeze([
  "none",
  "inquiry",
  "read-sector",
  "read-disc-id",
  "seek",
  "request-error",
  "audio-stream",
  "audio-status",
  "stop-motor",
  "audio-config",
  "unsupported",
]);
const PRESENTATION_STATUS_NAMES = Object.freeze(["rejected", "staged", "presented"]);
const PRESENTATION_MODE_NAMES = Object.freeze(["progressive", "single-field", "interlaced"]);
const PARITY_NAMES = Object.freeze(["top", "bottom"]);

function fail(path, message) {
  throw new Error(`invalid Rust MachineEvidenceV1 at ${path}: ${message}`);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function exactKeys(value, fields, path) {
  const keys = Object.keys(object(value, path)).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(path, `expected exact keys ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`);
  }
}

function checkedAdd(...values) {
  let result = 0n;
  for (const value of values) {
    result += value;
    if (result > UINT64_MAX) return null;
  }
  return result;
}

function checkedU32Multiply(left, right) {
  const result = left * right;
  return result <= UINT32_MAX ? result : null;
}

function checkedU32Add(left, right) {
  const result = left + right;
  return result <= UINT32_MAX ? result : null;
}

function decimal(value) {
  return value.toString(10);
}

function hex32(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function decodeCanonicalBase64(value, path) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !CANONICAL_BASE64.test(value)
  ) {
    fail(path, "expected canonical padded base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(path, "base64 spelling is not canonical");
  if (bytes.byteLength !== MACHINE_EVIDENCE_V1_BYTES) {
    fail(path, `decoded to ${bytes.byteLength} bytes, expected ${MACHINE_EVIDENCE_V1_BYTES}`);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
}

function bytesFromEnvelope(value, path) {
  const envelope = object(value, path);
  exactKeys(envelope, ["available", "bytes", "encoding", "payload"], path);
  if (envelope.available !== true) fail(`${path}.available`, "expected true");
  if (envelope.bytes !== MACHINE_EVIDENCE_V1_BYTES) {
    fail(`${path}.bytes`, `expected ${MACHINE_EVIDENCE_V1_BYTES}`);
  }
  if (envelope.encoding !== "base64") fail(`${path}.encoding`, "expected base64");
  return decodeCanonicalBase64(envelope.payload, `${path}.payload`);
}

function wordsFromBytes(value, path) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else {
    fail(path, "expected bytes");
  }
  if (bytes.byteLength !== MACHINE_EVIDENCE_V1_BYTES) {
    fail(path, `expected exactly ${MACHINE_EVIDENCE_V1_BYTES} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.freeze(Array.from(
    { length: MACHINE_EVIDENCE_V1_WORDS },
    (_unused, index) => view.getUint32(index * 4, true),
  ));
}

function recordFromWords(words) {
  const u64 = index => BigInt(words[index]) | BigInt(words[index + 1]) << 32n;
  const pairs = (start, names) => Object.fromEntries(
    names.map((name, index) => [name, u64(start + index * 2)]),
  );
  return {
    words,
    abiVersion: words[0],
    byteLength: words[1],
    tag: words[2],
    flags: words[3],
    machineEpoch: u64(4),
    snapshotSerial: u64(6),
    boot: {
      bootEpoch: u64(8),
      logicalBytes: u64(10),
      identifierWords: [words[12], words[13]],
      status: words[14],
      fault: words[15],
      revision: words[16],
      discNumber: words[17],
      format: words[18],
    },
    scheduler: {
      ...pairs(19, [
        "canonicalCycle",
        "executedCycles",
        "executedInstructions",
        "addressSpaceGeneration",
        "retiredBlocks",
        "completedOuterSlices",
      ]),
      pc: words[31],
      machineFaultReason: words[32],
      machineFaultDetail: words[33],
    },
    device: {
      ...pairs(34, [
        "rawDiskReads",
        "viFields",
        "dspLleSteps",
        "diskDeviceErrors",
        "diskRequestErrors",
        "controllerQueueOverflows",
        "unknownSiOutputCommands",
        "unsupportedDtkRecords",
        "storageFaultsRaised",
        "storageFaultsReturned",
        "storageFaultsResolved",
        "storageFaultRecurrences",
        "storageFaultNested",
        "storageFaultUnrecoverable",
      ]),
      diLastError: words[62],
      storageFaultPending: words[63],
    },
    graphics: pairs(64, [
      "gxBytes",
      "gxDrains",
      "gxCommands",
      "gxPrimitives",
      "xfbCopies",
      "presentedFrames",
      "emergencyDrains",
      "decoderErrors",
      "fallbacks",
      "unsupportedRecords",
      "exactRejections",
      "textureErrors",
      "pendingBytes",
      "decoderCarryBytes",
    ]),
    renderer: {
      ...pairs(92, [
        "renderRequestsIssued",
        "renderCompletionsAuthenticated",
        "renderHostFailures",
        "renderRendererFailures",
        "textureCopyBarriersEntered",
        "textureCopyBarriersExited",
      ]),
      renderPending: words[104],
      renderHighWater: words[105],
    },
    xfbVi: {
      ...pairs(106, [
        "xfbCompletionCycle",
        "viSelectionCycle",
        "renderCompletionCycle",
        "renderSequence",
        "presentationSerial",
      ]),
      xfbGeneration: words[116],
      selectedRow: words[117],
      mode: words[118],
      parity: words[119],
      pairEpoch: words[120],
      xfbWidth: words[121],
      xfbHeight: words[122],
      xfbStride: words[123],
      outputWidth: words[124],
      outputHeight: words[125],
      fieldStrideBytes: words[126],
      fieldHeight: words[127],
      rowRepeat: words[128],
      presentationStatus: words[129],
      presentationWidth: words[130],
      presentationHeight: words[131],
      flags: words[132],
    },
    si: {
      ...pairs(133, [
        "pollIndex",
        "scheduledCycle",
        "observedCycle",
        "lastReceivedSequence",
        "appliedSequence",
        "periodicPolls",
        "directPolls",
        "backpressuredPolls",
      ]),
      packetWords: [words[149], words[150]],
      queueDepth: words[151],
      source: words[152],
    },
    semanticIdle: {
      cycles: u64(153),
      jumps: words[155],
    },
    di: {
      ...pairs(156, [
        "commandStarts",
        "commandCompletions",
        "commandCancellations",
        "commandStartRejections",
        "inquiryStarts",
        "inquiryCompletions",
        "inquiryCancellations",
        "inquiryStartRejections",
        "readStarts",
        "readSectorStarts",
        "readDiscIdStarts",
        "readCompletions",
        "readCancellations",
        "readStartRejections",
        "readDeviceFailures",
        "physicalHostRequestsIssued",
        "physicalHostRequestsCancelled",
        "hostReceiptsSucceeded",
        "hostReceiptsFailed",
        "hostReceiptsRejected",
        "logicalWindowsReady",
        "logicalWindowsFailed",
      ]),
      currentState: words[200],
      currentKind: words[201],
      physicalHostRequestPending: words[202],
      reserved: words[203],
    },
  };
}

function canonicalBoot(record) {
  const boot = record.boot;
  if (boot.status > 5 || boot.fault > 6) return false;
  const hasIdentity = (record.flags & HAS_BOOT_IDENTITY) !== 0;
  const lifecycle = boot.status === 0
    ? boot.bootEpoch === 0n && boot.fault === 0
    : boot.status === 1 || boot.status === 2
      ? boot.bootEpoch !== 0n && boot.fault === 0
      : boot.status === 3
        ? boot.bootEpoch !== 0n && boot.fault === 0 && hasIdentity
        : boot.status === 4
          ? boot.fault !== 0 && (boot.fault === 1 ? boot.bootEpoch === 0n : boot.bootEpoch !== 0n)
          : boot.bootEpoch === 0n && boot.fault === 0;
  const identity = hasIdentity
    ? boot.status === 3
      && boot.bootEpoch !== 0n
      && boot.logicalBytes !== 0n
      && boot.identifierWords[0] !== 0
      && (boot.identifierWords[1] & 0xffff) === 0
      && boot.revision <= 0xff
      && boot.discNumber <= 0xff
      && boot.format <= 1
    : boot.logicalBytes === 0n
      && boot.identifierWords[0] === 0
      && boot.identifierWords[1] === 0
      && boot.revision === 0
      && boot.discNumber === 0
      && boot.format === 0;
  return lifecycle && identity;
}

function canonicalRenderer(record) {
  const renderer = record.renderer;
  const completionsWithPending = checkedAdd(
    renderer.renderCompletionsAuthenticated,
    BigInt(renderer.renderPending),
  );
  const failures = checkedAdd(renderer.renderHostFailures, renderer.renderRendererFailures);
  return completionsWithPending === renderer.renderRequestsIssued
    && failures !== null
    && failures <= renderer.renderCompletionsAuthenticated
    && renderer.renderPending <= renderer.renderHighWater
    && renderer.renderHighWater <= RENDER_PENDING_CAPACITY
    && renderer.textureCopyBarriersExited <= renderer.textureCopyBarriersEntered;
}

function canonicalXfbVi(record) {
  const xfb = record.xfbVi;
  if (xfb.mode > 2 || xfb.parity > 1 || xfb.presentationStatus > 2) return false;
  if (xfb.flags & ~XFB_VI_PAIR_COMPLETING) return false;
  if (
    xfb.renderSequence === 0n
    || xfb.xfbGeneration === 0
    || xfb.pairEpoch === 0
    || xfb.xfbWidth === 0
    || xfb.xfbHeight === 0
    || xfb.xfbStride === 0
    || xfb.outputWidth !== xfb.xfbWidth
    || xfb.outputHeight === 0
    || xfb.fieldStrideBytes === 0
    || xfb.fieldStrideBytes % xfb.xfbStride !== 0
    || xfb.fieldHeight === 0
    || (xfb.rowRepeat !== 1 && xfb.rowRepeat !== 2)
  ) return false;
  const expectedHeight = checkedU32Multiply(xfb.fieldHeight, xfb.rowRepeat);
  const sourceRowStep = Math.floor(xfb.fieldStrideBytes / xfb.xfbStride);
  const sourceRowDistance = checkedU32Multiply(xfb.fieldHeight - 1, sourceRowStep);
  const lastSourceRow = sourceRowDistance === null
    ? null
    : checkedU32Add(xfb.selectedRow, sourceRowDistance);
  if (
    expectedHeight !== xfb.outputHeight
    || lastSourceRow === null
    || lastSourceRow >= xfb.xfbHeight
    || xfb.xfbCompletionCycle > xfb.viSelectionCycle
    || xfb.viSelectionCycle > xfb.renderCompletionCycle
  ) return false;
  const pairCompleting = (xfb.flags & XFB_VI_PAIR_COMPLETING) !== 0;
  if (xfb.presentationStatus === 0) {
    return xfb.presentationWidth === 0
      && xfb.presentationHeight === 0
      && xfb.presentationSerial === 0n;
  }
  if (xfb.presentationStatus === 1) {
    return xfb.mode === 2
      && !pairCompleting
      && xfb.presentationWidth === xfb.outputWidth
      && xfb.presentationHeight === xfb.outputHeight
      && xfb.presentationSerial === 0n;
  }
  return pairCompleting
    && xfb.presentationWidth === xfb.outputWidth
    && xfb.presentationHeight === xfb.outputHeight
    && xfb.presentationSerial !== 0n;
}

function canonicalSi(record) {
  const si = record.si;
  const pollTotal = checkedAdd(si.periodicPolls, si.directPolls);
  const common = si.queueDepth <= SI_QUEUE_CAPACITY
    && si.appliedSequence <= si.lastReceivedSequence
    && pollTotal === si.pollIndex;
  if (!common) return false;
  if (record.flags & HAS_SI_PUBLICATION) {
    return si.pollIndex !== 0n && si.scheduledCycle <= si.observedCycle && si.source <= 1;
  }
  return si.pollIndex === 0n
    && si.scheduledCycle === 0n
    && si.observedCycle === 0n
    && si.appliedSequence === 0n
    && si.packetWords[0] === 0
    && si.packetWords[1] === 0
    && si.source === 0;
}

function canonicalDi(record) {
  const di = record.di;
  if (di.currentState >= DI_STATE_NAMES.length || di.currentKind >= DI_KIND_NAMES.length) {
    return false;
  }
  const readKinds = checkedAdd(di.readSectorStarts, di.readDiscIdStarts);
  const classifiedStarts = checkedAdd(di.inquiryStarts, di.readStarts);
  const classifiedCompletions = checkedAdd(di.inquiryCompletions, di.readCompletions);
  const classifiedCancellations = checkedAdd(di.inquiryCancellations, di.readCancellations);
  const classifiedRejections = checkedAdd(di.inquiryStartRejections, di.readStartRejections);
  const retiredHostRequests = checkedAdd(
    di.hostReceiptsSucceeded,
    di.hostReceiptsFailed,
    di.physicalHostRequestsCancelled,
    BigInt(di.physicalHostRequestPending),
  );
  if (
    readKinds === null
    || classifiedStarts === null
    || classifiedCompletions === null
    || classifiedCancellations === null
    || classifiedRejections === null
    || retiredHostRequests === null
  ) return false;
  const isRead = di.currentKind === 2 || di.currentKind === 3;
  const liveAccepted = di.currentState >= 2 ? 1n : 0n;
  const liveInquiry = liveAccepted !== 0n && di.currentKind === 1 ? 1n : 0n;
  const liveRead = liveAccepted !== 0n && isRead ? 1n : 0n;
  const accountedCommands = checkedAdd(
    di.commandCompletions,
    di.commandCancellations,
    liveAccepted,
  );
  const accountedInquiries = checkedAdd(
    di.inquiryCompletions,
    di.inquiryCancellations,
    liveInquiry,
  );
  const accountedReads = checkedAdd(di.readCompletions, di.readCancellations, liveRead);
  const currentValid = di.currentState === 0
    ? di.currentKind === 0 && di.physicalHostRequestPending === 0
    : di.currentState === 1
      ? di.currentKind !== 0 && di.physicalHostRequestPending === 0
      : di.currentState === 2
        ? di.currentKind !== 0 && !isRead && di.physicalHostRequestPending === 0
        : di.currentState === 3
          ? isRead
          : isRead && di.physicalHostRequestPending === 0;
  return di.reserved === 0
    && di.physicalHostRequestPending <= 1
    && readKinds === di.readStarts
    && classifiedStarts <= di.commandStarts
    && accountedCommands === di.commandStarts
    && accountedInquiries === di.inquiryStarts
    && accountedReads === di.readStarts
    && classifiedCompletions <= di.commandCompletions
    && classifiedCancellations <= di.commandCancellations
    && di.inquiryStartRejections <= di.commandStartRejections
    && di.readStartRejections <= di.commandStartRejections
    && classifiedRejections <= di.commandStartRejections
    && di.readDeviceFailures <= di.readCompletions
    && di.logicalWindowsFailed <= di.readStarts
    && retiredHostRequests === di.physicalHostRequestsIssued
    && (di.physicalHostRequestPending === 0 || di.currentState === 3)
    && currentValid;
}

function canonicalRecord(record) {
  if (
    record.abiVersion !== MACHINE_EVIDENCE_V1_ABI_VERSION
    || record.byteLength !== MACHINE_EVIDENCE_V1_BYTES
    || record.tag !== MACHINE_EVIDENCE_V1_TAG
    || (record.flags & ~KNOWN_FLAGS) !== 0
    || record.machineEpoch === 0n
    || record.snapshotSerial === 0n
    || !canonicalBoot(record)
    || record.scheduler.executedCycles > record.scheduler.canonicalCycle
    || (record.scheduler.pc & 3) !== 0
  ) return false;
  const hasFault = (record.flags & TERMINAL_ERROR) !== 0;
  const machineFaultValid = hasFault
    ? (record.scheduler.machineFaultReason === 5 || record.scheduler.machineFaultReason === 6)
      && record.scheduler.machineFaultDetail !== 0
    : record.scheduler.machineFaultReason === 0 && record.scheduler.machineFaultDetail === 0;
  if (
    !machineFaultValid
    || record.device.storageFaultPending > 1
    || record.device.storageFaultsResolved > record.device.storageFaultsReturned
    || record.device.storageFaultsReturned > record.device.storageFaultsRaised
    || !canonicalRenderer(record)
  ) return false;
  const hasXfbVi = (record.flags & HAS_XFB_VI) !== 0;
  if (!hasXfbVi) {
    if (record.words.slice(106, 133).some(word => word !== 0)) return false;
  } else if (
    !canonicalXfbVi(record)
    || record.xfbVi.renderCompletionCycle > record.scheduler.canonicalCycle
    || record.xfbVi.renderSequence > record.renderer.renderCompletionsAuthenticated
    || record.graphics.xfbCopies === 0n
    || (record.xfbVi.presentationStatus === 2 && record.graphics.presentedFrames === 0n)
  ) return false;
  return canonicalSi(record)
    && ((record.flags & HAS_SI_PUBLICATION) === 0
      || record.si.observedCycle <= record.scheduler.canonicalCycle)
    && record.semanticIdle.cycles <= record.scheduler.executedCycles
    && ((record.semanticIdle.jumps === 0) === (record.semanticIdle.cycles === 0n))
    && canonicalDi(record);
}

function validateExpectedBoot(record, expectedValue, path) {
  if (expectedValue === undefined) return;
  const expected = object(expectedValue, `${path}.expectedBoot`);
  exactKeys(
    expected,
    ["identifier", "revision", "discNumber", "format", "logicalBytes"],
    `${path}.expectedBoot`,
  );
  if (typeof expected.identifier !== "string" || !/^[\x20-\x7e]{6}$/.test(expected.identifier)) {
    fail(`${path}.expectedBoot.identifier`, "expected exactly six printable ASCII bytes");
  }
  for (const field of ["revision", "discNumber", "format"]) {
    if (!Number.isInteger(expected[field]) || expected[field] < 0 || expected[field] > UINT32_MAX) {
      fail(`${path}.expectedBoot.${field}`, "expected uint32");
    }
  }
  if (typeof expected.logicalBytes !== "string" || !/^[1-9][0-9]*$/.test(expected.logicalBytes)) {
    fail(`${path}.expectedBoot.logicalBytes`, "expected a positive decimal u64 string");
  }
  const logicalBytes = BigInt(expected.logicalBytes);
  if (logicalBytes > UINT64_MAX) fail(`${path}.expectedBoot.logicalBytes`, "exceeded u64");
  const identifier = [
    record.boot.identifierWords[0] >>> 24,
    record.boot.identifierWords[0] >>> 16 & 0xff,
    record.boot.identifierWords[0] >>> 8 & 0xff,
    record.boot.identifierWords[0] & 0xff,
    record.boot.identifierWords[1] >>> 24,
    record.boot.identifierWords[1] >>> 16 & 0xff,
  ].map(value => String.fromCharCode(value)).join("");
  if ((record.flags & HAS_BOOT_IDENTITY) === 0) fail(path, "missing committed boot identity");
  if (identifier !== expected.identifier) fail(path, "committed boot identifier did not match");
  if (record.boot.revision !== expected.revision) fail(path, "committed boot revision did not match");
  if (record.boot.discNumber !== expected.discNumber) {
    fail(path, "committed boot disc number did not match");
  }
  if (record.boot.format !== expected.format) fail(path, "committed boot format did not match");
  if (record.boot.logicalBytes !== logicalBytes) fail(path, "committed boot logical bytes did not match");
}

function decodeRecord(bytes, path, expectedBoot) {
  const record = recordFromWords(wordsFromBytes(bytes, path));
  if (!canonicalRecord(record)) fail(path, "record failed Rust MachineEvidenceV1 canonical shape");
  validateExpectedBoot(record, expectedBoot, path);
  return record;
}

function u64Summary(source, names) {
  return Object.fromEntries(names.map(name => [name, decimal(source[name])]));
}

function diagnosticSummary(record) {
  const hasXfbVi = (record.flags & HAS_XFB_VI) !== 0;
  const di = record.di;
  const summary = {
    schema: MACHINE_EVIDENCE_V1_SUMMARY_SCHEMA,
    canonical: true,
    abiVersion: MACHINE_EVIDENCE_V1_ABI_VERSION,
    byteLength: MACHINE_EVIDENCE_V1_BYTES,
    wordLength: MACHINE_EVIDENCE_V1_WORDS,
    tag: MACHINE_EVIDENCE_V1_TAG_TEXT,
    scheduler: {
      ...u64Summary(record.scheduler, [
        "canonicalCycle",
        "executedCycles",
        "executedInstructions",
        "addressSpaceGeneration",
        "retiredBlocks",
        "completedOuterSlices",
      ]),
      pc: hex32(record.scheduler.pc),
      terminalFault: (record.flags & TERMINAL_ERROR) !== 0,
      machineFaultReason: record.scheduler.machineFaultReason,
      machineFaultDetail: record.scheduler.machineFaultDetail,
    },
    semanticIdle: {
      cycles: decimal(record.semanticIdle.cycles),
      jumps: record.semanticIdle.jumps,
    },
    device: {
      dspLleValid: (record.flags & DSP_LLE_VALID) !== 0,
      dspLleSteps: decimal(record.device.dspLleSteps),
      unsupportedDtkRecords: decimal(record.device.unsupportedDtkRecords),
      controllerQueueOverflows: decimal(record.device.controllerQueueOverflows),
      unknownSiOutputCommands: decimal(record.device.unknownSiOutputCommands),
    },
    di: {
      ...u64Summary(record.device, [
        "rawDiskReads",
        "diskDeviceErrors",
        "diskRequestErrors",
        "storageFaultsRaised",
        "storageFaultsReturned",
        "storageFaultsResolved",
        "storageFaultRecurrences",
        "storageFaultNested",
        "storageFaultUnrecoverable",
      ]),
      diLastError: record.device.diLastError,
      storageFaultPending: record.device.storageFaultPending,
      ...u64Summary(di, [
        "commandStarts",
        "commandCompletions",
        "commandCancellations",
        "commandStartRejections",
        "inquiryStarts",
        "inquiryCompletions",
        "inquiryCancellations",
        "inquiryStartRejections",
        "readStarts",
        "readSectorStarts",
        "readDiscIdStarts",
        "readCompletions",
        "readCancellations",
        "readStartRejections",
        "readDeviceFailures",
        "physicalHostRequestsIssued",
        "physicalHostRequestsCancelled",
        "hostReceiptsSucceeded",
        "hostReceiptsFailed",
        "hostReceiptsRejected",
        "logicalWindowsReady",
        "logicalWindowsFailed",
      ]),
      currentState: DI_STATE_NAMES[di.currentState],
      currentKind: DI_KIND_NAMES[di.currentKind],
      physicalHostRequestPending: di.physicalHostRequestPending,
    },
    gx: {
      ...u64Summary(record.graphics, [
        "gxBytes",
        "gxDrains",
        "gxCommands",
        "gxPrimitives",
        "xfbCopies",
        "presentedFrames",
        "emergencyDrains",
        "decoderErrors",
        "fallbacks",
        "unsupportedRecords",
        "exactRejections",
        "textureErrors",
        "pendingBytes",
        "decoderCarryBytes",
      ]),
      renderer: {
        ...u64Summary(record.renderer, [
          "renderRequestsIssued",
          "renderCompletionsAuthenticated",
          "renderHostFailures",
          "renderRendererFailures",
          "textureCopyBarriersEntered",
          "textureCopyBarriersExited",
        ]),
        renderPending: record.renderer.renderPending,
        renderHighWater: record.renderer.renderHighWater,
      },
    },
    vi: {
      viFields: decimal(record.device.viFields),
      hasAuthenticatedChronology: hasXfbVi,
      chronology: hasXfbVi
        ? {
            ...u64Summary(record.xfbVi, [
              "xfbCompletionCycle",
              "viSelectionCycle",
              "renderCompletionCycle",
              "renderSequence",
              "presentationSerial",
            ]),
            xfbGeneration: record.xfbVi.xfbGeneration,
            selectedRow: record.xfbVi.selectedRow,
            mode: PRESENTATION_MODE_NAMES[record.xfbVi.mode],
            parity: PARITY_NAMES[record.xfbVi.parity],
            pairEpoch: record.xfbVi.pairEpoch,
            xfbWidth: record.xfbVi.xfbWidth,
            xfbHeight: record.xfbVi.xfbHeight,
            xfbStride: record.xfbVi.xfbStride,
            outputWidth: record.xfbVi.outputWidth,
            outputHeight: record.xfbVi.outputHeight,
            fieldStrideBytes: record.xfbVi.fieldStrideBytes,
            fieldHeight: record.xfbVi.fieldHeight,
            rowRepeat: record.xfbVi.rowRepeat,
            presentationStatus: PRESENTATION_STATUS_NAMES[record.xfbVi.presentationStatus],
            presentationWidth: record.xfbVi.presentationWidth,
            presentationHeight: record.xfbVi.presentationHeight,
            pairCompleting: (record.xfbVi.flags & XFB_VI_PAIR_COMPLETING) !== 0,
          }
        : null,
    },
  };
  return deepFreeze(summary);
}

export function validateMachineEvidenceV1Bytes(
  value,
  { path = "$", expectedBoot } = {},
) {
  return diagnosticSummary(decodeRecord(value, path, expectedBoot));
}

export function validateMachineEvidenceV1Envelope(
  value,
  { path = "$", expectedBoot } = {},
) {
  return diagnosticSummary(decodeRecord(bytesFromEnvelope(value, path), path, expectedBoot));
}

export function validateMachineEvidenceV1PublicationEnvelope(
  value,
  { path = "$", expectedBoot } = {},
) {
  const record = decodeRecord(bytesFromEnvelope(value, path), path, expectedBoot);
  const zeroFields = [
    ["device.diskDeviceErrors", record.device.diskDeviceErrors],
    ["device.diskRequestErrors", record.device.diskRequestErrors],
    ["device.controllerQueueOverflows", record.device.controllerQueueOverflows],
    ["device.unknownSiOutputCommands", record.device.unknownSiOutputCommands],
    ["device.unsupportedDtkRecords", record.device.unsupportedDtkRecords],
    ["device.storageFaultsRaised", record.device.storageFaultsRaised],
    ["device.storageFaultsReturned", record.device.storageFaultsReturned],
    ["device.storageFaultsResolved", record.device.storageFaultsResolved],
    ["device.storageFaultRecurrences", record.device.storageFaultRecurrences],
    ["device.storageFaultNested", record.device.storageFaultNested],
    ["device.storageFaultUnrecoverable", record.device.storageFaultUnrecoverable],
    ["graphics.decoderErrors", record.graphics.decoderErrors],
    ["graphics.fallbacks", record.graphics.fallbacks],
    ["graphics.unsupportedRecords", record.graphics.unsupportedRecords],
    ["graphics.exactRejections", record.graphics.exactRejections],
    ["graphics.textureErrors", record.graphics.textureErrors],
    ["renderer.renderHostFailures", record.renderer.renderHostFailures],
    ["renderer.renderRendererFailures", record.renderer.renderRendererFailures],
    ["di.commandStartRejections", record.di.commandStartRejections],
    ["di.inquiryStartRejections", record.di.inquiryStartRejections],
    ["di.readStartRejections", record.di.readStartRejections],
    ["di.readDeviceFailures", record.di.readDeviceFailures],
    ["di.hostReceiptsFailed", record.di.hostReceiptsFailed],
    ["di.hostReceiptsRejected", record.di.hostReceiptsRejected],
    ["di.logicalWindowsFailed", record.di.logicalWindowsFailed],
  ];
  if ((record.flags & DSP_LLE_VALID) === 0) fail(path, "DSP LLE validity is not set");
  if ((record.flags & TERMINAL_ERROR) !== 0) fail(path, "terminal machine fault is set");
  if (record.device.diLastError !== 0) fail(path, "DI last error is not clear");
  if (record.device.storageFaultPending !== 0) fail(path, "storage fault remains pending");
  if (record.di.physicalHostRequestPending !== 0) {
    fail(path, "DI physical host request remains pending");
  }
  if (record.renderer.renderPending !== 0) fail(path, "renderer request remains pending");
  if (record.renderer.textureCopyBarriersEntered !== record.renderer.textureCopyBarriersExited) {
    fail(path, "texture-copy barrier accounting is not balanced");
  }
  for (const [field, counter] of zeroFields) {
    if (counter !== 0n) fail(path, `${field} must be zero for publication`);
  }
  for (const [field, counter] of [
    ["device.viFields", record.device.viFields],
    ["device.dspLleSteps", record.device.dspLleSteps],
    ["graphics.gxBytes", record.graphics.gxBytes],
    ["graphics.gxDrains", record.graphics.gxDrains],
    ["graphics.gxCommands", record.graphics.gxCommands],
    ["graphics.gxPrimitives", record.graphics.gxPrimitives],
    ["graphics.xfbCopies", record.graphics.xfbCopies],
    ["graphics.presentedFrames", record.graphics.presentedFrames],
    ["renderer.renderRequestsIssued", record.renderer.renderRequestsIssued],
    [
      "renderer.renderCompletionsAuthenticated",
      record.renderer.renderCompletionsAuthenticated,
    ],
  ]) {
    if (counter === 0n) fail(path, `${field} must be positive for publication`);
  }
  if (record.renderer.renderHighWater === 0) {
    fail(path, "renderer.renderHighWater must be positive for publication");
  }
  if ((record.flags & HAS_XFB_VI) === 0 || record.xfbVi.presentationStatus !== 2) {
    fail(path, "authenticated presented XFB/VI chronology is required for publication");
  }
  return diagnosticSummary(record);
}

export function validateMachineEvidenceV1Transition(
  beforeValue,
  afterValue,
  { beforePath = "$.before", afterPath = "$.after", expectedBoot } = {},
) {
  const before = decodeRecord(bytesFromEnvelope(beforeValue, beforePath), beforePath, expectedBoot);
  const after = decodeRecord(bytesFromEnvelope(afterValue, afterPath), afterPath, expectedBoot);
  if (after.machineEpoch !== before.machineEpoch) fail(afterPath, "machine epoch changed");
  if (after.snapshotSerial <= before.snapshotSerial) {
    fail(afterPath, "snapshot serial did not increase");
  }
  for (const field of [
    "canonicalCycle",
    "executedCycles",
    "executedInstructions",
    "retiredBlocks",
    "completedOuterSlices",
  ]) {
    if (after.scheduler[field] < before.scheduler[field]) {
      fail(afterPath, `scheduler ${field} regressed`);
    }
  }
  const cumulativeFamilies = [
    ["device", before.device, after.device, [
      "rawDiskReads",
      "viFields",
      "dspLleSteps",
      "diskDeviceErrors",
      "diskRequestErrors",
      "controllerQueueOverflows",
      "unknownSiOutputCommands",
      "unsupportedDtkRecords",
      "storageFaultsRaised",
      "storageFaultsReturned",
      "storageFaultsResolved",
      "storageFaultRecurrences",
      "storageFaultNested",
      "storageFaultUnrecoverable",
    ]],
    ["graphics", before.graphics, after.graphics, [
      "gxBytes",
      "gxDrains",
      "gxCommands",
      "gxPrimitives",
      "xfbCopies",
      "presentedFrames",
      "emergencyDrains",
      "decoderErrors",
      "fallbacks",
      "unsupportedRecords",
      "exactRejections",
      "textureErrors",
    ]],
    ["renderer", before.renderer, after.renderer, [
      "renderRequestsIssued",
      "renderCompletionsAuthenticated",
      "renderHostFailures",
      "renderRendererFailures",
      "textureCopyBarriersEntered",
      "textureCopyBarriersExited",
    ]],
    ["SI", before.si, after.si, [
      "pollIndex",
      "observedCycle",
      "lastReceivedSequence",
      "appliedSequence",
      "periodicPolls",
      "directPolls",
      "backpressuredPolls",
    ]],
    ["DI", before.di, after.di, [
      "commandStarts",
      "commandCompletions",
      "commandCancellations",
      "commandStartRejections",
      "inquiryStarts",
      "inquiryCompletions",
      "inquiryCancellations",
      "inquiryStartRejections",
      "readStarts",
      "readSectorStarts",
      "readDiscIdStarts",
      "readCompletions",
      "readCancellations",
      "readStartRejections",
      "readDeviceFailures",
      "physicalHostRequestsIssued",
      "physicalHostRequestsCancelled",
      "hostReceiptsSucceeded",
      "hostReceiptsFailed",
      "hostReceiptsRejected",
      "logicalWindowsReady",
      "logicalWindowsFailed",
    ]],
  ];
  for (const [family, earlier, later, fields] of cumulativeFamilies) {
    for (const field of fields) {
      if (later[field] < earlier[field]) fail(afterPath, `${family} ${field} regressed`);
    }
  }
  if (after.renderer.renderHighWater < before.renderer.renderHighWater) {
    fail(afterPath, "renderer renderHighWater regressed");
  }
  const persistentFlags = TERMINAL_ERROR | HAS_XFB_VI | HAS_SI_PUBLICATION | HAS_BOOT_IDENTITY;
  if ((before.flags & persistentFlags & ~(after.flags & persistentFlags)) !== 0) {
    fail(afterPath, "persistent authenticated flags regressed");
  }
  if ((before.flags & DSP_LLE_VALID) === 0 && (after.flags & DSP_LLE_VALID) !== 0) {
    fail(afterPath, "DSP LLE validity was re-enabled");
  }
  if (
    (before.flags & TERMINAL_ERROR) !== 0
    && (
      after.scheduler.machineFaultReason !== before.scheduler.machineFaultReason
      || after.scheduler.machineFaultDetail !== before.scheduler.machineFaultDetail
    )
  ) fail(afterPath, "sticky machine fault changed");
  if ((before.flags & HAS_BOOT_IDENTITY) !== 0) {
    const beforeBoot = before.words.slice(8, 19);
    const afterBoot = after.words.slice(8, 19);
    if (beforeBoot.some((word, index) => word !== afterBoot[index])) {
      fail(afterPath, "committed boot identity changed");
    }
  }
  if (after.semanticIdle.cycles < before.semanticIdle.cycles) {
    fail(afterPath, "semantic idle cycles regressed");
  }
  if (after.semanticIdle.jumps < before.semanticIdle.jumps) {
    fail(afterPath, "semantic idle jumps regressed");
  }
  return deepFreeze({
    before: diagnosticSummary(before),
    after: diagnosticSummary(after),
    deltas: {
      canonicalCycle: decimal(after.scheduler.canonicalCycle - before.scheduler.canonicalCycle),
      executedCycles: decimal(after.scheduler.executedCycles - before.scheduler.executedCycles),
      executedInstructions: decimal(
        after.scheduler.executedInstructions - before.scheduler.executedInstructions,
      ),
      completedOuterSlices: decimal(
        after.scheduler.completedOuterSlices - before.scheduler.completedOuterSlices,
      ),
      semanticIdleCycles: decimal(after.semanticIdle.cycles - before.semanticIdle.cycles),
      semanticIdleJumps: after.semanticIdle.jumps - before.semanticIdle.jumps,
    },
  });
}

export function terminalMachineEvidenceEnvelope(reportValue, { path = "$" } = {}) {
  const report = object(reportValue, path);
  if (report.status === "complete") {
    return report.game?.adapterDiagnostics?.final?.machineEvidence ?? null;
  }
  if (report.status === "failed") {
    return report.game?.lastAdapterDiagnostics?.machineEvidence ?? null;
  }
  return null;
}

async function cli() {
  if (process.argv.length !== 3) {
    throw new Error("usage: resident_machine_evidence_v1.mjs report-or-envelope.json");
  }
  const value = JSON.parse(await readFile(process.argv[2], "utf8"));
  const envelope = Object.hasOwn(value, "available")
    ? value
    : terminalMachineEvidenceEnvelope(value);
  const expectedBoot = value?.game?.game?.key === "warioware-usa"
    ? WARIOWARE_MACHINE_EVIDENCE_BOOT
    : undefined;
  if (envelope === null) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      publishable: false,
      reason: "canonical-machine-evidence-unavailable",
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    publishable: true,
    evidence: validateMachineEvidenceV1Envelope(envelope, { expectedBoot }),
  }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
