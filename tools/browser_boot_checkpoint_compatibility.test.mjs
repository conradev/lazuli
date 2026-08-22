// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BROWSER_BOOT_CHECKPOINT_SCHEMA,
  createCheckpointCandidate,
  createCheckpointManifest,
} from "./browser_boot_checkpoint.mjs";
import {
  BROWSER_BOOT_CHECKPOINT_SCHEMA_V1,
  checkpointSha256,
} from "./browser_boot_checkpoint_core.mjs";
import { reportsForConsensus } from "./browser_boot_checkpoint_fixture.mjs";

const LEGACY_CHECKPOINT_DIGESTS = Object.freeze({
  stateV1: "1122c179bd0e259c3170082bd8e24b39145f57b3bff1cf725084d2877918198f",
  stateV2: "4b0bbb7796319d5a87072aaa9ca8e38ad938947a6d7a20e6cbed2e3260f9d0b1",
  candidateV1: "38ade5335cbaae44247a5cadd1281356eecde69f23a1ae93fcd118035411a198",
  candidateV2: "020f58272f0ac36628e7143c21dbc648268342121827518dec9110dd58251d8b",
  manifestV2: "24a7dcb057d5890bcce2b11d1c068f82dc0e3564f7e626542a5ba9fa83ad3762",
  goldenBytesV2: "4bb0e2cb3f19365ed49ca143ba22f5725fd2c30e7102fcc42d233049e971de15",
  goldenStateV2: "26d7c2e52b6803ed431de91910846dd893cd40930acb215c6dd620c995f184c3",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("schema-v3 work cannot rewrite the established v1 and v2 checkpoint bytes", async () => {
  const reports = reportsForConsensus();
  const candidateV1 = createCheckpointCandidate(
    reports[0],
    undefined,
    BROWSER_BOOT_CHECKPOINT_SCHEMA_V1,
  );
  const candidateV2 = createCheckpointCandidate(reports[0]);
  const manifestV2 = createCheckpointManifest(reports);
  const goldenBytes = await readFile(new URL(
    "./compatibility/smb-usa/memory-card.json",
    import.meta.url,
  ));
  const golden = JSON.parse(goldenBytes);

  assert.equal(BROWSER_BOOT_CHECKPOINT_SCHEMA, "lazuli-browser-boot-checkpoint-v2");
  assert.equal(candidateV2.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA);
  assert.equal(manifestV2.schema, BROWSER_BOOT_CHECKPOINT_SCHEMA);
  assert.deepEqual({
    stateV1: checkpointSha256(candidateV1.state),
    stateV2: checkpointSha256(candidateV2.state),
    candidateV1: sha256(prettyJson(candidateV1)),
    candidateV2: sha256(prettyJson(candidateV2)),
    manifestV2: sha256(prettyJson(manifestV2)),
    goldenBytesV2: sha256(goldenBytes),
    goldenStateV2: checkpointSha256(golden.state),
  }, LEGACY_CHECKPOINT_DIGESTS);
});
