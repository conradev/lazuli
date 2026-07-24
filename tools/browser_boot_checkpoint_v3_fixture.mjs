// SPDX-License-Identifier: GPL-3.0-only

import {
  gameplayReport,
  gameplayTranscript,
} from "./browser_boot_gameplay_transcript_fixture.mjs";
import {
  SMB_TEMPORAL_XFB_CAPACITY,
  TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2,
  deriveTemporalSelectedXfbOracle,
} from "./browser_boot_temporal_xfb.mjs";

function digest(index) {
  return index.toString(16).padStart(64, "0");
}

function temporalFrame(index) {
  const bottom = index % 2 === 1;
  const generation = 500 + index;
  const width = 640;
  const textureHeight = 448;
  const sourceRow = bottom ? 1 : 0;
  const height = 448;
  const pixels = width * height;
  const address = bottom ? "0x00307180" : "0x00306c80";
  const scanout = {
    scanoutPolicy: "bob",
    fieldStrideBytes: 0xa00,
    sourceRowStep: 2,
    fieldHeight: 224,
    rowRepeat: 2,
  };
  return {
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: index + 1,
    rendererSequence: 393 + index,
    presentation: {
      selected: true,
      field: bottom ? "bottom" : "top",
      address,
      copyIndex: generation,
      copyRow: sourceRow,
      width,
      height: textureHeight,
      pictureConfiguration: 0x2850,
      wordsPerLine: 40,
      standardWordsPerLine: 80,
      activeLines: 224,
      nonInterlaced: false,
      ...scanout,
    },
    selectedXfb: {
      address,
      generation,
      row: sourceRow,
      format: "rgba8unorm",
      layout: "top-left-row-major-tight",
      sourceRow,
      width,
      height,
      textureWidth: width,
      textureHeight,
      logicalWidth: width,
      logicalHeight: textureHeight,
      displayWidth: width,
      displayHeight: textureHeight,
      ...scanout,
      rgbaByteLength: pixels * 4,
      rgbaSha256: digest(index + 1),
      rgbSha256: digest(index + 17),
      rgb: { black: 0, white: 0, other: pixels, unique: 4 },
    },
  };
}

export function smbReadyPlayTemporalSelectedXfb() {
  const frames = Array.from(
    { length: SMB_TEMPORAL_XFB_CAPACITY },
    (_unused, index) => temporalFrame(index),
  );
  return {
    scanoutEvidenceVersion: TEMPORAL_XFB_SCANOUT_EVIDENCE_VERSION_V2,
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
