// SPDX-License-Identifier: GPL-3.0-only

import {
  gameplayReport,
  gameplayTranscript,
} from "./browser_boot_gameplay_transcript_fixture.mjs";
import {
  SMB_TEMPORAL_XFB_CAPACITY,
  TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3,
  deriveTemporalSelectedXfbOracle,
} from "./browser_boot_temporal_xfb.mjs";

function digest(index) {
  return index.toString(16).padStart(64, "0");
}

function temporalFrame(index) {
  const width = 640;
  const height = 448;
  const fieldHeight = 224;
  const pairEpoch = 1000 + index;
  const presentationSerial = 2000 + index;
  const scanout = {
    scanoutPolicy: "bob",
    fieldStrideBytes: 0xa00,
    sourceRowStep: 2,
    fieldHeight,
    rowRepeat: 2,
  };
  const presentationFields = {
    top: {
      field: "top",
      address: "0x00306c80",
      copyIndex: 500 + index * 2,
      copyRow: 0,
      width,
      height,
      ...scanout,
    },
    bottom: {
      field: "bottom",
      address: "0x00307180",
      copyIndex: 501 + index * 2,
      copyRow: 1,
      width,
      height,
      ...scanout,
    },
  };
  const evidenceField = (parity, digestBase) => {
    const expected = presentationFields[parity];
    const pixels = width * fieldHeight;
    return {
      address: expected.address,
      generation: expected.copyIndex,
      row: expected.copyRow,
      sourceRow: expected.copyRow,
      surfaceId: parity === "top" ? 1 : 2,
      textureWidth: width,
      textureHeight: height,
      logicalWidth: width,
      logicalHeight: height,
      ...scanout,
      width,
      height: fieldHeight,
      rgbaByteLength: pixels * 4,
      rgbaSha256: digest(digestBase),
      rgbSha256: digest(digestBase + 32),
      rgb: { black: 0, white: 0, other: pixels, unique: 4 },
    };
  };
  const compositePixels = width * height;
  const completion = presentationFields.bottom;
  const selectedFields = {
    top: evidenceField("top", 100 + index * 2),
    bottom: evidenceField("bottom", 101 + index * 2),
  };
  const legacy = selectedFields.bottom;
  return {
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: index + 1,
    rendererSequence: 386 + index * 2,
    presentation: {
      selected: true,
      status: "vi-interlaced-frame-ready",
      presentationMode: "interlaced",
      pairEpoch,
      presentationSerial,
      completionField: "bottom",
      compositionPolicy: "field-pair-weave",
      fields: presentationFields,
      field: "bottom",
      address: completion.address,
      copyIndex: completion.copyIndex,
      copyRow: completion.copyRow,
      width,
      height,
      pictureConfiguration: 0x2850,
      wordsPerLine: 40,
      standardWordsPerLine: 80,
      activeLines: 224,
      nonInterlaced: false,
      ...scanout,
    },
    selectedXfb: {
      pairEpoch,
      presentationMode: "interlaced",
      presentationSerial,
      compositionPolicy: "field-pair-weave",
      displayWidth: width,
      displayHeight: height,
      fields: selectedFields,
      address: legacy.address,
      generation: legacy.generation,
      row: legacy.row,
      sourceRow: legacy.sourceRow,
      textureWidth: legacy.textureWidth,
      textureHeight: legacy.textureHeight,
      logicalWidth: legacy.logicalWidth,
      logicalHeight: legacy.logicalHeight,
      scanoutPolicy: legacy.scanoutPolicy,
      fieldStrideBytes: legacy.fieldStrideBytes,
      sourceRowStep: legacy.sourceRowStep,
      fieldHeight: legacy.fieldHeight,
      rowRepeat: legacy.rowRepeat,
      format: "rgba8unorm",
      layout: "top-left-row-major-tight",
      width,
      height,
      rgbaByteLength: compositePixels * 4,
      rgbaSha256: digest(index + 1),
      rgbSha256: digest(index + 17),
      rgb: { black: 0, white: 0, other: compositePixels, unique: 4 },
    },
  };
}

export function smbReadyPlayTemporalSelectedXfb() {
  const frames = Array.from(
    { length: SMB_TEMPORAL_XFB_CAPACITY },
    (_unused, index) => temporalFrame(index),
  );
  return {
    scanoutEvidenceVersion: TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V3,
    capacity: SMB_TEMPORAL_XFB_CAPACITY,
    frames,
    oracle: deriveTemporalSelectedXfbOracle(frames),
  };
}

export function smbReadyPlayCheckpointReport() {
  const report = gameplayReport();
  const temporalSelectedXfb = smbReadyPlayTemporalSelectedXfb();
  const terminalFrame = temporalSelectedXfb.frames.at(-1);
  report.execution.scheduler.renderEvery = 1;
  report.execution.scheduler.rendererSync = {
    posted: 400,
    acknowledged: 400,
    failed: 0,
    inFlight: 0,
    highWater: 1,
    waits: 400,
    resultMisses: 0,
  };
  report.gxFifo = {
    decoder: {
      displayListErrors: 0,
      vertexDecodeErrors: 0,
      unknownOpcodes: 0,
      xfbCopyCount: 508,
      textures: { decodeErrors: 0, tlutErrors: 0 },
    },
  };
  report.diskCommands = { lastError: "0x00000000" };
  report.deviceEvents = {};
  report.serialInterface = { unknownOutputCommands: 0 };
  report.exceptions = {
    counts: { "0x0500": 2, "0x0800": 1, "0x0c00": 3 },
  };
  report.rendering = {
    backend: "wgpu-webgpu",
    metrics: {
      scope: "current-worker",
      operations: { enqueued: 400, pending: 0, highWater: 1 },
      webgpu: { checkHealthCalls: 400 },
    },
    selectedXfb: structuredClone(terminalFrame.selectedXfb),
    temporalSelectedXfb,
  };
  report.mmioState = {
    viInterruptModel: {
      presentationCount: 300,
      lastPresentationField: terminalFrame.presentation.field,
      lastPresentationAddress: terminalFrame.presentation.address,
      lastPresentationCopyIndex: terminalFrame.presentation.copyIndex,
      lastPresentationCopyRow: terminalFrame.presentation.copyRow,
    },
  };
  report.headlessCapture = {
    ...report.headlessCapture,
    dataset: { renderer: "wgpu-webgpu" },
    devtoolsExceptions: [],
    reuse: null,
    discImage: {
      algorithm: "sha256",
      format: "ciso",
      sha256: "441a0eadc85afb501e2a3db5af2ee81d4783b96a58f6a2df2605f5c33dcb6202",
    },
  };
  report.gameplayTranscript = gameplayTranscript();
  return report;
}
