// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointValidationError,
  canonicalStringify,
  checkpointSha256,
  createCheckpointCandidate,
  projectCheckpointReport,
  validateCheckpointReport,
} from "./browser_boot_checkpoint_core.mjs";
import {
  checkpointReport,
} from "./browser_boot_checkpoint_fixture.mjs";

test("canonical JSON and checkpoint hashes ignore object insertion order", () => {
  assert.equal(canonicalStringify({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(
    checkpointSha256({ z: 1, a: { y: 2, x: 3 } }),
    checkpointSha256({ a: { x: 3, y: 2 }, z: 1 }),
  );
});

test("projection reacts to guest, device, VI, and selected-XFB visual state", () => {
  const report = checkpointReport();
  const digest = createCheckpointCandidate(report).sha256;
  const mutations = [
    candidate => { candidate.cpuState.signature = "0x12345678"; },
    candidate => { candidate.cpuState.gpr.r1 = "0x81234564"; },
    candidate => { candidate.gxFifo.hash = "0x12345678"; },
    candidate => { candidate.diskReads.hash = "0x12345678"; },
    candidate => { candidate.guestGame.submodeTimer -= 1; },
    candidate => { candidate.controller.guestPad.pressed.buttons = 0x0100; },
    candidate => { candidate.mmioState.viInterruptModel.lastPresentationField = "bottom"; },
    candidate => { candidate.rendering.selectedXfb.rgbaSha256 = "1".repeat(64); },
    candidate => {
      candidate.rendering.selectedXfb.rgb.other -= 1;
      candidate.rendering.selectedXfb.rgb.black += 1;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.notEqual(createCheckpointCandidate(changed).sha256, digest);
  }
});

test("checkpoint hard gates fail at the actionable report path", () => {
  const cases = [
    ["status", report => { report.status = "running"; }, "$.status"],
    ["stage", report => { report.stage = "snapshot"; }, "$.stage"],
    ["cycle floor", report => { report.limits.cycles = 1_499_999_999; }, "$.limits.cycles"],
    ["game", report => { report.disc.identifier = "GZLE01"; }, "$.disc.identifier"],
    ["render cadence", report => { report.execution.scheduler.renderEvery = 2; }, "$.execution.scheduler.renderEvery"],
    ["renderer backend", report => { report.headlessCapture.dataset.renderer = "fallback"; }, "$.headlessCapture.dataset.renderer"],
    ["renderer progress", report => {
      report.execution.scheduler.rendererSync.posted = 0;
      report.execution.scheduler.rendererSync.acknowledged = 0;
    }, "$.execution.scheduler.rendererSync.posted"],
    ["renderer failure", report => { report.execution.scheduler.rendererSync.failed = 1; }, "$.execution.scheduler.rendererSync.failed"],
    ["renderer in flight", report => { report.execution.scheduler.rendererSync.inFlight = 1; }, "$.execution.scheduler.rendererSync.inFlight"],
    ["renderer result miss", report => { report.execution.scheduler.rendererSync.resultMisses = 1; }, "$.execution.scheduler.rendererSync.resultMisses"],
    ["renderer acknowledgement", report => { report.execution.scheduler.rendererSync.acknowledged -= 1; }, "$.execution.scheduler.rendererSync.acknowledged"],
    ["renderer high water", report => { report.execution.scheduler.rendererSync.highWater = 2; }, "$.execution.scheduler.rendererSync.highWater"],
    ["XFB progress", report => { report.gxFifo.decoder.xfbCopyCount = 0; }, "$.gxFifo.decoder.xfbCopyCount"],
    ["VI progress", report => { report.mmioState.viInterruptModel.presentationCount = 0; }, "$.mmioState.viInterruptModel.presentationCount"],
    ["visual backend", report => { report.rendering.backend = "fallback"; }, "$.rendering.backend"],
    ["visual address", report => { report.rendering.selectedXfb.address = "0x00307180"; }, "$.rendering.selectedXfb.address"],
    ["visual generation", report => { report.rendering.selectedXfb.generation -= 1; }, "$.rendering.selectedXfb.generation"],
    ["visual row", report => { report.rendering.selectedXfb.row = 1; }, "$.rendering.selectedXfb.row"],
    ["visual layout", report => { report.rendering.selectedXfb.layout = "padded"; }, "$.rendering.selectedXfb.layout"],
    ["visual byte count", report => { report.rendering.selectedXfb.rgbaByteLength -= 4; }, "$.rendering.selectedXfb.rgbaByteLength"],
    ["visual digest", report => { report.rendering.selectedXfb.rgbaSha256 = "invalid"; }, "$.rendering.selectedXfb.rgbaSha256"],
    ["visual color partition", report => { report.rendering.selectedXfb.rgb.black -= 1; }, "$.rendering.selectedXfb.rgb"],
    ["uniform visual", report => {
      const selected = report.rendering.selectedXfb;
      selected.rgb.black = selected.width * selected.height;
      selected.rgb.white = 0;
      selected.rgb.other = 0;
      selected.rgb.unique = 1;
    }, "$.rendering.selectedXfb.rgb.other"],
    ["GX opcode", report => { report.gxFifo.decoder.unknownOpcodes = 1; }, "$.gxFifo.decoder.unknownOpcodes"],
    ["display list", report => { report.gxFifo.decoder.displayListErrors = 1; }, "$.gxFifo.decoder.displayListErrors"],
    ["vertex decode", report => { report.gxFifo.decoder.vertexDecodeErrors = 1; }, "$.gxFifo.decoder.vertexDecodeErrors"],
    ["texture decode", report => { report.gxFifo.decoder.textures.decodeErrors = 1; }, "$.gxFifo.decoder.textures.decodeErrors"],
    ["TLUT", report => { report.gxFifo.decoder.textures.tlutErrors = 1; }, "$.gxFifo.decoder.textures.tlutErrors"],
    ["controller overflow", report => { report.controller.queueOverflows = 1; }, "$.controller.queueOverflows"],
    ["serial output", report => { report.serialInterface.unknownOutputCommands = 1; }, "$.serialInterface.unknownOutputCommands"],
    ["disk register", report => { report.diskCommands.lastError = "0x00000001"; }, "$.diskCommands.lastError"],
    ["disk device", report => { report.deviceEvents.diskDeviceError = 1; }, "$.deviceEvents.diskDeviceError"],
    ["forbidden exception", report => { report.exceptions.counts["0x0600"] = 1; }, '$.exceptions.counts["0x0600"]'],
    ["DevTools exception", report => { report.headlessCapture.devtoolsExceptions.push({ text: "boom" }); }, "$.headlessCapture.devtoolsExceptions[0]"],
  ];

  for (const [name, mutate, path] of cases) {
    const report = checkpointReport();
    mutate(report);
    assert.throws(
      () => validateCheckpointReport(report),
      error => {
        assert.ok(error instanceof CheckpointValidationError, name);
        assert.equal(error.path, path, name);
        return true;
      },
    );
  }
});

test("projected fixture contains exactly the declared stable leaves", () => {
  const state = projectCheckpointReport(checkpointReport());
  const candidate = createCheckpointCandidate(checkpointReport());
  assert.equal(candidate.sha256, checkpointSha256(state));
  assert.equal(state.cpuState.signature, "0xcc536b5b");
  assert.equal(state.cpuState.msr, "0x00009032");
  assert.equal(state.cpuState.gpr.r1, "0x81234560");
  assert.equal(state.instructions, 456_789);
  assert.equal(state.dispatches, 123_456);
  assert.equal(state.gxFifo.decoder.xfbCopyCount, 143);
  assert.equal(state.mmioState.viInterruptModel.presentationCount, 185);
  assert.equal(state.mmioState.viInterruptModel.lastPresentationCopyIndex, 142);
  assert.equal(state.rendering.backend, "wgpu-webgpu");
  assert.equal(
    state.rendering.selectedXfb.rgbaSha256,
    "5fd0f5382bec2c974f7b6559b3c648a6db307d92eb37440d1f23dfa4be9d974e",
  );
  assert.equal(state.rendering.selectedXfb.rgb.unique, 423);
});
