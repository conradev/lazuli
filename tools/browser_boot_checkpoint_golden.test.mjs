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
    "a2b8a34b7ae54b7b082dff62001aa12c9d48be0c04f507989ad33863c824b4eb",
  );
  assert.equal(manifest.consensus.cleanRuns, 3);
  assert.equal(manifest.run.renderer, "wgpu-webgpu");
  assert.equal(manifest.state.cpuState.signature, "0xcc536b5b");
  assert.equal(manifest.state.gxFifo.hash, "0x63f324ac");
  assert.equal(manifest.state.diskReads.hash, "0x691e18d1");
});
