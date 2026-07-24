#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredPublicWarioWareUrl,
  waitForCoherentPublicWarioWareSnapshot,
  validatePublicWarioWareSmokeEvidence,
} from "./browser_public_warioware_smoke.mjs";

function activeRelease() {
  return {
    schema: 2,
    releaseId: "1".repeat(64),
    commit: "2".repeat(40),
    frontend: {
      url: `/assets/frontend-${"b".repeat(64)}.html`,
      sha256: "b".repeat(64),
      bytes: 1_000,
    },
  };
}

function validEvidence() {
  const release = activeRelease();
  return {
    schema: "lazuli-public-warioware-smoke-v1",
    dataset: { renderer: "wgpu-webgpu", status: "running" },
    devtoolsExceptions: [],
    discImage: {
      algorithm: "sha256",
      format: "ciso",
      sha256: "a".repeat(64),
    },
    discStatus: "local: WarioWare, Inc. - Mega Party Game$! (USA).ciso",
    frameUrl: `https://gekko.free/assets/frontend-${"b".repeat(64)}.html?scenario=smb-ready-play`,
    publicUrl: "https://gekko.free/?scenario=smb-ready-play",
    release,
    report: {
      status: "running",
      stage: "snapshot",
      cycles: 12_000_000,
      dispatches: 40_000,
      instructions: 9_000_000,
      disc: {
        identifier: "GZWE01",
        revision: 0,
        source: { kind: "local-file" },
      },
      gxFifo: {
        bytes: 3_320,
        staging: {
          drains: 282,
          bytes: 3_320,
          emergencyDrains: 0,
          pendingBytes: 0,
        },
        decoder: {
          commands: 553,
          bufferedBytes: 0,
          capacityWatermarkBytes: 4_096,
          maximumBufferedBytes: 16 * 1024 * 1024,
          retryAtBufferedBytes: 1,
          preDecodeHighWaterBytes: 64,
          unknownOpcodes: 0,
          displayListErrors: 0,
          vertexDecodeErrors: 0,
          xfbCopyCount: 3,
          framesPresented: 11,
          textures: {
            draws: 2,
            decodes: 1,
            decodeErrors: 0,
            tlutErrors: 0,
          },
        },
      },
      rendering: {
        backend: "wgpu-webgpu",
        metrics: {
          scope: "current-worker",
          workerMessages: { gxFrames: 3, drawCalls: 2 },
          operations: { pending: 0 },
          webgpu: { copyXfbCalls: 3, presentXfbCalls: 11 },
        },
        selectedXfb: {
          address: "0x0041c980",
          generation: 3,
          row: 0,
          width: 640,
          height: 448,
          format: "rgba8unorm",
          layout: "top-left-row-major-tight",
          rgbaByteLength: 640 * 448 * 4,
          rgbaSha256: "c".repeat(64),
          rgbSha256: "d".repeat(64),
          rgb: { black: 275_074, white: 0, other: 11_646, unique: 2 },
        },
      },
      mmioState: {
        viInterruptModel: {
          presentationCount: 11,
          lastPresentationAddress: "0x0041c980",
          lastPresentationCopyIndex: 3,
          lastPresentationCopyRow: 0,
        },
      },
      scenario: null,
    },
    surface: "release",
    terminalRelease: structuredClone(release),
  };
}

test("public WarioWare smoke accepts a healthy release snapshot with stale SMB query", () => {
  const evidence = validEvidence();
  assert.strictEqual(validatePublicWarioWareSmokeEvidence(evidence), evidence);
});

test("public WarioWare runtime accepts only the exact production root", () => {
  assert.equal(
    configuredPublicWarioWareUrl("https://gekko.free/"),
    "https://gekko.free/?scenario=smb-ready-play",
  );
  for (const publicRoot of [
    "http://gekko.free/",
    "https://localhost/",
    "https://user@gekko.free/",
    "https://gekko.free:8443/",
  ]) {
    assert.throws(
      () => configuredPublicWarioWareUrl(publicRoot),
      /exact production origin https:\/\/gekko\.free/,
      publicRoot,
    );
  }
});

test("public WarioWare smoke rejects the mutable app path with the exact scenario query", () => {
  const evidence = validEvidence();
  evidence.frameUrl = "https://gekko.free/app.html?scenario=smb-ready-play";
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(evidence),
    /\$\.frameUrl: expected a content-addressed immutable frontend path/,
  );
});

test("public WarioWare smoke binds its same-origin iframe to the active release", () => {
  const crossOrigin = validEvidence();
  crossOrigin.frameUrl =
    `https://example.com/assets/frontend-${"b".repeat(64)}.html?scenario=smb-ready-play`;
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(crossOrigin),
    /\$\.frameUrl: expected exact production origin https:\/\/gekko\.free/,
  );

  const wrongAsset = validEvidence();
  wrongAsset.frameUrl =
    `https://gekko.free/assets/frontend-${"c".repeat(64)}.html?scenario=smb-ready-play`;
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(wrongAsset),
    /\$\.frameUrl: does not match the active release frontend identity/,
  );

  const changedRelease = validEvidence();
  changedRelease.terminalRelease.releaseId = "f".repeat(64);
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(changedRelease),
    /\$\.terminalRelease: active release changed/,
  );
});

test("public WarioWare smoke rejects scenario leakage and unhealthy evidence", () => {
  const cases = [
    ["top query", value => { value.publicUrl = "https://gekko.free/"; }, /\$\.publicUrl/],
    ["frame query", value => { value.frameUrl = "https://gekko.free/app.html"; }, /\$\.frameUrl/],
    ["surface", value => { value.surface = "debug"; }, /\$\.surface/],
    ["dataset status", value => { value.dataset.status = "stopped"; }, /\$\.dataset\.status/],
    ["dataset renderer", value => { value.dataset.renderer = "fallback"; }, /\$\.dataset\.renderer/],
    ["DevTools", value => { value.devtoolsExceptions.push({ text: "boom" }); }, /devtoolsExceptions\[0\]/],
    ["disc format", value => { value.discImage.format = "iso"; }, /\$\.discImage/],
    ["report status", value => { value.report.status = "stopped"; }, /\$\.report:/],
    ["report stage", value => { value.report.stage = "scenario-failed"; }, /\$\.report:/],
    ["terminal error", value => { value.report.error = "boom"; }, /\$\.report\.error/],
    ["scenario", value => { value.report.scenario = { id: "smb-ready-play" }; }, /\$\.report\.scenario/],
    ["disc", value => { value.report.disc.identifier = "GMBE8P"; }, /disc\.identifier/],
    ["disc revision", value => { value.report.disc.revision = 1; }, /disc\.revision/],
    ["disc source", value => { value.report.disc.source.kind = "http-range"; }, /disc\.source\.kind/],
    ["renderer", value => { value.report.rendering.backend = "fallback"; }, /rendering\.backend/],
    ["renderer error", value => { value.report.rendering.error = "lost"; }, /rendering\.error/],
    ["VI presentation count", value => {
      value.report.mmioState.viInterruptModel.presentationCount = 0;
    }, /viInterruptModel\.presentationCount/],
    ["VI presentation row", value => {
      value.report.mmioState.viInterruptModel.lastPresentationCopyRow = -1;
    }, /viInterruptModel\.lastPresentationCopyRow/],
    ["selected XFB row", value => {
      value.report.rendering.selectedXfb.row = -1;
    }, /selectedXfb\.row/],
    ["mismatched XFB row", value => {
      value.report.rendering.selectedXfb.row = 1;
    }, /selectedXfb\.row: expected last VI presentation row 0, got 1/],
    ["equal out-of-range XFB rows", value => {
      value.report.mmioState.viInterruptModel.lastPresentationCopyRow = 2;
      value.report.rendering.selectedXfb.row = 2;
    }, /viInterruptModel\.lastPresentationCopyRow: expected field row 0 or 1/],
    ["progress", value => { value.report.instructions = 0; }, /report\.instructions/],
    ["FIFO progress", value => { value.report.gxFifo.decoder.commands = 0; }, /decoder\.commands/],
    ["FIFO tail bound", value => { value.report.gxFifo.decoder.bufferedBytes = -1; }, /decoder\.bufferedBytes/],
    ["FIFO configured bound", value => {
      value.report.gxFifo.decoder.maximumBufferedBytes += 1;
    }, /decoder\.maximumBufferedBytes/],
    ["FIFO missing configured bound", value => {
      delete value.report.gxFifo.decoder.maximumBufferedBytes;
    }, /decoder\.maximumBufferedBytes/],
    ["FIFO capacity watermark", value => {
      value.report.gxFifo.decoder.capacityWatermarkBytes = 32 * 1024 * 1024;
    }, /decoder\.capacityWatermarkBytes/],
    ["FIFO pre-decode high water", value => {
      value.report.gxFifo.decoder.preDecodeHighWaterBytes = 8_192;
    }, /decoder\.preDecodeHighWaterBytes/],
    ["FIFO tail above pre-decode high water", value => {
      value.report.gxFifo.decoder.bufferedBytes = 100;
      value.report.gxFifo.decoder.retryAtBufferedBytes = 101;
    }, /decoder\.preDecodeHighWaterBytes/],
    ["FIFO tail requirement", value => {
      value.report.gxFifo.decoder.bufferedBytes = 4;
      value.report.gxFifo.decoder.retryAtBufferedBytes = 4;
    }, /decoder\.retryAtBufferedBytes/],
    ["FIFO missing retry requirement", value => {
      delete value.report.gxFifo.decoder.retryAtBufferedBytes;
    }, /decoder\.retryAtBufferedBytes/],
    ["FIFO retry above bound", value => {
      value.report.gxFifo.decoder.retryAtBufferedBytes = 32 * 1024 * 1024;
    }, /decoder\.retryAtBufferedBytes/],
    ["FIFO opcode", value => { value.report.gxFifo.decoder.unknownOpcodes = 1; }, /unknownOpcodes/],
    ["display list", value => { value.report.gxFifo.decoder.displayListErrors = 1; }, /displayListErrors/],
    ["vertex decode", value => { value.report.gxFifo.decoder.vertexDecodeErrors = 1; }, /vertexDecodeErrors/],
    ["texture decode", value => { value.report.gxFifo.decoder.textures.decodeErrors = 1; }, /textures\.decodeErrors/],
    ["XFB copies", value => { value.report.gxFifo.decoder.xfbCopyCount = 0; }, /xfbCopyCount/],
    ["WebGPU copy", value => { value.report.rendering.metrics.webgpu.copyXfbCalls = 0; }, /copyXfbCalls/],
    ["renderer pending", value => { value.report.rendering.metrics.operations.pending = 1; }, /operations\.pending/],
    ["selected XFB", value => { value.report.rendering.selectedXfb.width = 320; }, /selectedXfb/],
    ["visible RGB", value => { value.report.rendering.selectedXfb.rgb.other = 0; }, /selectedXfb\.rgb/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.throws(
      () => validatePublicWarioWareSmokeEvidence(evidence),
      pattern,
      label,
    );
  }
});

test("public WarioWare smoke accepts a bounded incomplete command tail", () => {
  const evidence = validEvidence();
  evidence.report.gxFifo.decoder.bufferedBytes = 4;
  evidence.report.gxFifo.decoder.retryAtBufferedBytes = 5;
  assert.equal(validatePublicWarioWareSmokeEvidence(evidence), evidence);
});

test("public WarioWare snapshot wait retries early null then accepts generation 3", async () => {
  const early = structuredClone(validEvidence().report);
  early.mmioState.viInterruptModel.presentationCount = 0;
  early.mmioState.viInterruptModel.lastPresentationAddress = "0x00000000";
  early.mmioState.viInterruptModel.lastPresentationCopyIndex = 0;
  early.mmioState.viInterruptModel.lastPresentationCopyRow = 0;
  early.rendering.selectedXfb = null;
  const ready = structuredClone(validEvidence().report);
  const snapshots = [
    { report: early, state: { attempt: "early-null" } },
    { report: ready, state: { attempt: "generation-3" } },
  ];
  const delays = [];
  const result = await waitForCoherentPublicWarioWareSnapshot(null, {
    captureSnapshot: async () => snapshots.shift(),
    deadline: 10,
    delay: async milliseconds => { delays.push(milliseconds); },
    now: () => 0,
    pollMs: 2,
  });
  assert.equal(result.report.rendering.selectedXfb.generation, 3);
  assert.deepEqual(result.state, { attempt: "generation-3" });
  assert.deepEqual(delays, [2]);
});

test("public WarioWare snapshot wait hard-fails mismatched presentation provenance", async () => {
  for (const [mutate, pattern] of [
    [
      report => { report.rendering.selectedXfb.generation = 2; },
      /selectedXfb\.generation: expected last VI presentation copy 3, got 2/,
    ],
    [
      report => { report.rendering.selectedXfb.address = "0x0041ce80"; },
      /selectedXfb\.address: expected last VI presentation address 0x0041c980/,
    ],
  ]) {
    const report = structuredClone(validEvidence().report);
    mutate(report);
    await assert.rejects(
      waitForCoherentPublicWarioWareSnapshot(null, {
        captureSnapshot: async () => ({ report, state: { attempt: "mismatch" } }),
        deadline: 10,
        delay: async () => {},
        now: () => 0,
        pollMs: 2,
      }),
      pattern,
    );
  }
});

test("public WarioWare snapshot wait does not retry terminal snapshot errors", async () => {
  const report = structuredClone(validEvidence().report);
  report.mmioState.viInterruptModel.presentationCount = 4;
  report.mmioState.viInterruptModel.lastPresentationAddress = "0x00000000";
  report.mmioState.viInterruptModel.lastPresentationCopyIndex = 0;
  report.mmioState.viInterruptModel.lastPresentationCopyRow = 0;
  report.rendering.selectedXfb = null;
  report.error = "terminal renderer failure";
  let captures = 0;
  await assert.rejects(
    waitForCoherentPublicWarioWareSnapshot(null, {
      captureSnapshot: async () => {
        captures += 1;
        return { report, state: { attempt: "terminal-error" } };
      },
      deadline: 10,
      delay: async () => {},
      now: () => 0,
      pollMs: 2,
    }),
    /\$\.report\.error: expected no terminal error/,
  );
  assert.equal(captures, 1);
});

test("public WarioWare snapshot wait hard-fails renderer fallback and backend errors", async () => {
  for (const [mutate, pattern] of [
    [
      report => { report.rendering.backend = "fallback"; },
      /\$\.report\.rendering\.backend: expected wgpu-webgpu/,
    ],
    [
      report => { report.rendering.error = "device lost"; },
      /\$\.report\.rendering\.error: expected no renderer error/,
    ],
  ]) {
    const report = structuredClone(validEvidence().report);
    report.mmioState.viInterruptModel.presentationCount = 4;
    report.mmioState.viInterruptModel.lastPresentationAddress = "0x00000000";
    report.mmioState.viInterruptModel.lastPresentationCopyIndex = 0;
    report.mmioState.viInterruptModel.lastPresentationCopyRow = 0;
    report.rendering.selectedXfb = null;
    mutate(report);
    let captures = 0;
    await assert.rejects(
      waitForCoherentPublicWarioWareSnapshot(null, {
        captureSnapshot: async () => {
          captures += 1;
          return { report, state: { attempt: "renderer-failure" } };
        },
        deadline: 10,
        delay: async () => {},
        now: () => 0,
        pollMs: 2,
      }),
      pattern,
    );
    assert.equal(captures, 1);
  }
});

test("public WarioWare snapshot wait reports its last state at the deadline", async () => {
  const report = structuredClone(validEvidence().report);
  report.mmioState.viInterruptModel.presentationCount = 4;
  report.mmioState.viInterruptModel.lastPresentationAddress = "0x00000000";
  report.mmioState.viInterruptModel.lastPresentationCopyIndex = 0;
  report.mmioState.viInterruptModel.lastPresentationCopyRow = 0;
  report.rendering.selectedXfb = null;
  let clockReads = 0;
  await assert.rejects(
    waitForCoherentPublicWarioWareSnapshot(null, {
      captureSnapshot: async () => ({
        report,
        state: { attempt: "deadline-last-state" },
      }),
      deadline: 1,
      delay: async () => {},
      now: () => clockReads++ === 0 ? 0 : 1,
      pollMs: 1,
    }),
    error => {
      assert.match(error.message, /did not present a coherent XFB before the deadline/);
      assert.match(error.message, /"attempt":"deadline-last-state"/);
      return true;
    },
  );
});

test("public WarioWare snapshot wait preserves a production-shaped retry on inner timeout", async () => {
  const report = structuredClone(validEvidence().report);
  report.mmioState.viInterruptModel.presentationCount = 4;
  report.mmioState.viInterruptModel.lastPresentationAddress = "0x00000000";
  report.mmioState.viInterruptModel.lastPresentationCopyIndex = 0;
  report.mmioState.viInterruptModel.lastPresentationCopyRow = 0;
  report.rendering.selectedXfb = null;
  const state = {
    dataset: { renderer: "wgpu-webgpu", status: "running" },
    discStatus: "local: WarioWare, Inc. - Mega Party Game$! (USA).ciso",
    frameUrl: `https://gekko.free/assets/frontend-${"b".repeat(64)}.html?scenario=smb-ready-play`,
    result: JSON.stringify(report),
    surface: "release",
  };
  let captures = 0;
  const innerError = new Error(
    "public snapshot did not arrive: "
    + JSON.stringify({ dataset: state.dataset, frameUrl: state.frameUrl }),
  );
  await assert.rejects(
    waitForCoherentPublicWarioWareSnapshot(null, {
      captureSnapshot: async () => {
        captures += 1;
        if (captures === 1) return { report, state };
        throw innerError;
      },
      deadline: 10,
      delay: async () => {},
      now: () => 0,
      pollMs: 2,
    }),
    error => {
      assert.match(error.message, /failed after the last retryable snapshot/);
      assert.match(error.message, /"lastPresentationCopyIndex":0/);
      assert.match(error.message, /"discStatus":"local: WarioWare/);
      assert.match(error.message, /public snapshot did not arrive/);
      assert.strictEqual(error.cause, innerError);
      return true;
    },
  );
  assert.equal(captures, 2);
});

test("public WarioWare smoke reuses the shared iframe transport", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./browser_public_warioware_smoke.mjs", import.meta.url), "utf8"));
  assert.match(source, /from "\.\/browser_public_cdp\.mjs"/);
  assert.doesNotMatch(source, /createUncompressedDevToolsSocket|class DevToolsSession/);
});
