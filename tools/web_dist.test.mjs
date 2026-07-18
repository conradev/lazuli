#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated public artifact contains only the release surface", async () => {
  const directory = new URL("../web/dist/", import.meta.url);
  const release = JSON.parse(await readFile(new URL("release.json", directory), "utf8"));
  const frontend = await readFile(new URL(`.${release.frontend.url}`, directory), "utf8");

  assert.match(frontend, /data-surface="release"/);
  assert.doesNotMatch(frontend, /data-surface="debug"|LAZULI DEBUG UI/);
  for (const id of ["disc-file", "display", "controller-controls"]) {
    assert.match(frontend, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(
    frontend,
    /id="(?:runner-controls|pause-runner|resume-runner|diagnostics|disc-url|load-disc-url|extend-cycles|extend-dispatches|extend-runner|runner-rest-ms|apply-throttle|runner-render-every|apply-presentation|snapshot-runner|stop-runner|result)"/,
  );
  assert.match(frontend, /debugSurface \? location\.search : ""/);
});
