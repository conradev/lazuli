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
