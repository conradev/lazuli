// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildWeb } from "./build_web.mjs";
import {
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
  validateRelease,
} from "../web/release.mjs";

const temporaryDirectories = [];
after(async () => Promise.all(temporaryDirectories.map(path => rm(path, { recursive: true, force: true }))));

test("builds a deterministic GPL release from a generic generated frontend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazuli-web-build-"));
  temporaryDirectories.push(directory);
  const appPath = join(directory, "index.html");
  const wasmPath = join(directory, "ppcwasmjit.wasm");
  const outputPath = join(directory, "dist");
  const sourceAnchor = '<a href="https://github.com/conradev/lazuli" target="_blank" rel="source noopener">Source</a>';
  await writeFile(
    appPath,
    `<!doctype html><body>${sourceAnchor}<main class="shell" data-surface="debug">
<!-- LAZULI DEBUG UI START -->
<div id="runner-controls">
<button id="pause-runner">Pause</button>
<button id="resume-runner">Resume</button>
</div>
<!-- LAZULI DEBUG UI END -->
<main>Play</main>
<!-- LAZULI DEBUG UI START -->
<details id="diagnostics"><button id="stop-runner">Stop</button></details>
<!-- LAZULI DEBUG UI END -->
<script>new URL("/ppcwasmjit.wasm", location.href)</script></main></body>`,
  );
  const wasm = Buffer.alloc(WASM_CHUNK_SIZE * 2 + 17);
  for (let index = 0; index < wasm.length; index += 1) wasm[index] = index * 31 & 0xff;
  await writeFile(wasmPath, wasm);

  const commit = "0123456789abcdef0123456789abcdef01234567";
  const release = await buildWeb({ appPath, wasmPath, outputPath, commit });
  await validateRelease(release);
  assert.equal(release.backend.chunks.length, 3);
  assert.deepEqual(release.backend.chunks.map(chunk => chunk.bytes), [
    WASM_CHUNK_SIZE,
    WASM_CHUNK_SIZE,
    17,
  ]);
  assert.equal(
    release.releaseId,
    await sha256Hex(JSON.stringify(releaseIdentityPayload(release))),
  );

  const rebuilt = Buffer.concat(await Promise.all(release.backend.chunks.map(async chunk =>
    readFile(join(outputPath, chunk.url.slice(1)))
  )));
  assert.deepEqual(rebuilt, wasm);
  const frontend = await readFile(join(outputPath, release.frontend.url.slice(1)), "utf8");
  assert.match(frontend, /SPDX-License-Identifier: GPL-3\.0-only/);
  assert.match(frontend, new RegExp(`/tree/${commit}`));
  assert.match(frontend, /GPL-3\.0-only/);
  assert.doesNotMatch(frontend, /href="https:\/\/github\.com\/conradev\/lazuli"/);
  assert.doesNotMatch(frontend, /(?:Pause|Resume|Stop|Options and diagnostics)/);
  assert.doesNotMatch(frontend, /id="(?:runner-controls|pause-runner|resume-runner|diagnostics|stop-runner)"/);
  assert.match(frontend, /data-surface="release"/);
  assert.doesNotMatch(frontend, /data-surface="debug"/);
  assert.match(frontend, /<main>Play<\/main>/);

  const firstManifest = await readFile(join(outputPath, "release.json"), "utf8");
  const secondRelease = await buildWeb({ appPath, wasmPath, outputPath, commit });
  assert.equal(secondRelease.releaseId, release.releaseId);
  assert.equal(await readFile(join(outputPath, "release.json"), "utf8"), firstManifest);
  assert.match(await readFile(join(outputPath, "_headers"), "utf8"), /\/release\.json\n  Cache-Control: no-store/);
  assert.ok(!(await readdir(outputPath)).includes("ppcwasmjit.wasm"), "backend must remain chunk-only");
});

test("rejects a non-exact source revision", async () => {
  await assert.rejects(
    buildWeb({ appPath: "missing", wasmPath: "missing", outputPath: "dist", commit: "HEAD" }),
    /lowercase 40-character Git commit/,
  );
});

test("local harness retains controls removed from the public frontend", async () => {
  const harness = await readFile(
    new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
    "utf8",
  );
  assert.match(harness, /id="pause-runner"[^>]*>Pause<\/button>/);
  assert.match(harness, /id="resume-runner"[^>]*>Resume<\/button>/);
  assert.match(harness, /id="diagnostics"/);
  assert.match(harness, /id="stop-runner"[^>]*>Stop<\/button>/);
  assert.match(harness, /class="button primary disc-picker"/);
  assert.match(harness, /id="disc-file"[^>]*aria-label="Open ISO or CISO"/);
  assert.match(harness, /data-surface="debug"/);
  assert.equal(harness.match(/<!-- LAZULI DEBUG UI START -->/g)?.length, 2);
  assert.equal(harness.match(/<!-- LAZULI DEBUG UI END -->/g)?.length, 2);
});

test("public shell does not forward debug runner parameters", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /url\.search\s*=\s*location\.search/);
});

test("public shell keeps the upload surface at one stable URL", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(shell, /new URL\("\/app\.html", location\.href\)/);
  assert.doesNotMatch(shell, /new URL\(release\.frontend\.url/);
});

test("web app has no notification or push surface", async () => {
  const sources = await Promise.all([
    "../web/index.html",
    "../web/release.mjs",
    "../web/sw.js",
  ].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  assert.doesNotMatch(
    sources.join("\n"),
    /\b(?:Notification|PushManager|pushManager|PushSubscription|MessageChannel|BroadcastChannel|postMessage)\b|\.subscribe\s*\(/,
  );
});
