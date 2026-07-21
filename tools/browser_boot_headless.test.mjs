// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./browser_boot_headless.mjs", import.meta.url),
  "utf8",
);

test("headless capture exposes --expect and verifies before persistence", () => {
  assert.match(source, /case "--expect":/);
  assert.match(source, /readCheckpointManifest\(options\.expect\)/);
  assert.equal(
    source.match(/verifyExpectedCheckpoint\(report, options, expectedManifest\)/g)?.length,
    2,
  );
  assert.match(
    source,
    /verifyExpectedCheckpoint\(report, options, expectedManifest\);\s*await persist/,
  );
});
