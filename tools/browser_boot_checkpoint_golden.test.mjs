// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { readCheckpointManifest } from "./browser_boot_checkpoint.mjs";

test("the SMB memory-card checkpoint is a valid three-run WebGPU golden", async () => {
  const manifest = await readCheckpointManifest(
    new URL("./compatibility/smb-usa/memory-card.json", import.meta.url),
  );

  assert.equal(manifest.id, "smb-usa/no-input/cycles-1500000000/render-every-1");
  assert.equal(
    manifest.sha256,
    "26d7c2e52b6803ed431de91910846dd893cd40930acb215c6dd620c995f184c3",
  );
  assert.equal(manifest.schema, "lazuli-browser-boot-checkpoint-v2");
  assert.equal(manifest.consensus.cleanRuns, 3);
  assert.equal(manifest.run.renderer, "wgpu-webgpu");
  assert.deepEqual(manifest.performance, {
    rendererMaximum: {
      wasmBridgeCalls: 984,
      wasmBridgeTypedArrayBytes: 11_222_288,
      queueSubmissions: 468,
      bindGroups: 700,
      buffers: 839,
      renderPipelines: 3,
      textures: 8,
    },
  });
  assert.equal(manifest.state.cpuState.signature, "0xcc536b5b");
  assert.equal(manifest.state.gxFifo.hash, "0x63f324ac");
  assert.equal(manifest.state.diskReads.hash, "0x691e18d1");
  assert.equal(
    manifest.state.rendering.selectedXfb.rgbaSha256,
    "5fd0f5382bec2c974f7b6559b3c648a6db307d92eb37440d1f23dfa4be9d974e",
  );
  assert.deepEqual(manifest.state.rendering.selectedXfb.rgb, {
    black: 278_435,
    white: 2_786,
    other: 5_499,
    unique: 423,
  });
});

test("the SMB ready-to-PLAY checkpoint is a stable full-color WebGPU golden", async () => {
  const manifest = await readCheckpointManifest(
    new URL("./compatibility/smb-usa/ready-play.json", import.meta.url),
  );

  assert.equal(
    manifest.id,
    "smb-usa/smb-ready-play/render-every-1/temporal-xfb-8",
  );
  assert.equal(
    manifest.sha256,
    "cfed69a03d57a9cdbbe04446d88c911a0b35ad1296bb90651c6554d1dc8a8aed",
  );
  assert.equal(manifest.schema, "lazuli-browser-boot-checkpoint-v3");
  assert.equal(manifest.consensus.cleanRuns, 3);
  assert.equal(manifest.game.identifier, "GMBE8P");
  assert.equal(
    manifest.game.image.sha256,
    "441a0eadc85afb501e2a3db5af2ee81d4783b96a58f6a2df2605f5c33dcb6202",
  );
  assert.equal(manifest.run.renderer, "wgpu-webgpu");
  assert.equal(manifest.run.scenario, "smb-ready-play");

  const oracle = manifest.state.rendering.temporalSelectedXfb.oracle;
  assert.deepEqual({
    blackWhiteAlternating: oracle.blackWhiteAlternating,
    captured: oracle.captured,
    complete: oracle.complete,
    distinctRgbHashes: oracle.distinctRgbHashes,
  }, {
    blackWhiteAlternating: false,
    captured: 8,
    complete: true,
    distinctRgbHashes: 8,
  });

  const encoded = JSON.stringify(manifest);
  for (const hostEvidence of [
    "headlessRun",
    "127.0.0.1",
    "HeadlessChrome",
    "headlessRunToReportMs",
  ]) {
    assert.equal(encoded.includes(hostEvidence), false);
  }
});
