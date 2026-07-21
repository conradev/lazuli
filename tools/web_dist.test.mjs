#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("generated public artifact contains only the release surface", async () => {
  const directory = new URL("../web/dist/", import.meta.url);
  const release = JSON.parse(await readFile(new URL("release.json", directory), "utf8"));
  const appFallback = await readFile(new URL("app.html", directory), "utf8");
  const frontend = await readFile(new URL(`.${release.frontend.url}`, directory), "utf8");
  const rendererJavascript = await readFile(
    new URL(`.${release.renderer.javascript.url}`, directory),
    "utf8",
  );

  assert.match(frontend, /data-surface="release"/);
  assert.doesNotMatch(frontend, /data-surface="debug"|LAZULI DEBUG UI/);
  for (const id of ["disc-file", "display", "controller-controls"]) {
    assert.match(frontend, new RegExp(`id="${id}"`));
  }
  assert.match(
    frontend,
    /\.shell\[data-surface="release"\]\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s,
  );
  assert.match(
    frontend,
    /\.shell\[data-surface="release"\] #controller-controls\s*\{[^}]*display:\s*grid;/s,
  );
  assert.match(
    frontend,
    /body\[data-status="waiting"\] \.shell\[data-surface="release"\] header/,
  );
  assert.doesNotMatch(
    frontend,
    /id="(?:runner-controls|pause-runner|resume-runner|diagnostics|disc-url|load-disc-url|extend-cycles|extend-dispatches|extend-runner|runner-rest-ms|apply-throttle|runner-render-every|apply-presentation|snapshot-runner|stop-runner|result)"/,
  );
  assert.match(frontend, /runnerSearchForSurface\(debugSurface, location\.search\)/);
  assert.match(frontend, /scenario === "smb-ready-play"/);
  assert.ok(frontend.includes(release.renderer.javascript.url));
  assert.ok(!frontend.includes("/browser_renderer.js"));
  assert.ok(rendererJavascript.includes(release.renderer.wasm.url));
  assert.ok(!rendererJavascript.includes("browser_renderer_bg.wasm"));
  assert.match(appFallback, /location\.replace\("\/"\)/);
  const rootFiles = await readdir(directory);
  assert.ok(!rootFiles.includes("browser_renderer.js"));
  assert.ok(!rootFiles.includes("browser_renderer_bg.wasm"));
});
