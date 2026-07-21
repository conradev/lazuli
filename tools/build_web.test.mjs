// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildWeb, withoutDebugUi } from "./build_web.mjs";
import {
  RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
  validateRelease,
} from "../web/release.mjs";

const temporaryDirectories = [];
after(async () => Promise.all(temporaryDirectories.map(path => rm(path, { recursive: true, force: true }))));

test("release markup retains one hidden terminal report sink", () => {
  const frontend = withoutDebugUi(`<!doctype html><body>
<main class="shell" data-surface="debug">
<!-- LAZULI DEBUG UI START -->
<details id="diagnostics"><pre id="result">RUNNING</pre></details>
<!-- LAZULI DEBUG UI END -->
<section>Play</section>
</main></body>`);
  assert.doesNotMatch(frontend, /id="diagnostics"|>RUNNING<\/pre>/);
  assert.equal(frontend.match(/id="result"/g)?.length, 1);
  assert.match(
    frontend,
    /<pre id="result" data-testid="browser-boot-result" hidden aria-hidden="true"><\/pre>\s*<\/main>/,
  );
});

test("builds a deterministic GPL release from a generic generated frontend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazuli-web-build-"));
  temporaryDirectories.push(directory);
  const appPath = join(directory, "index.html");
  const wasmPath = join(directory, "ppcwasmjit.wasm");
  const rendererJavascriptPath = join(directory, "browser_renderer.js");
  const rendererWasmPath = join(directory, "browser_renderer_bg.wasm");
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
<script type="module">import initRenderer from "/browser_renderer.js";
new URL("/ppcwasmjit.wasm", location.href)</script></main></body>`,
  );
  const wasm = Buffer.alloc(WASM_CHUNK_SIZE * 2 + 17);
  for (let index = 0; index < wasm.length; index += 1) wasm[index] = index * 31 & 0xff;
  await writeFile(wasmPath, wasm);
  const rendererWasm = Buffer.from("renderer wasm fixture");
  const rendererJavascript = [
    "let wasm;",
    "export default async function init(moduleOrPath) {",
    "  moduleOrPath ??= new URL('browser_renderer_bg.wasm', import.meta.url);",
    "  return WebAssembly.instantiateStreaming(fetch(moduleOrPath), {});",
    "}",
    "",
  ].join("\n");
  await Promise.all([
    writeFile(rendererJavascriptPath, rendererJavascript),
    writeFile(rendererWasmPath, rendererWasm),
  ]);

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
  const builtRendererWasm = await readFile(
    join(outputPath, release.renderer.wasm.url.slice(1)),
  );
  assert.deepEqual(builtRendererWasm, rendererWasm);
  const builtRendererJavascript = await readFile(
    join(outputPath, release.renderer.javascript.url.slice(1)),
    "utf8",
  );
  assert.ok(builtRendererJavascript.includes(release.renderer.wasm.url));
  assert.ok(!builtRendererJavascript.includes("browser_renderer_bg.wasm"));
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
  assert.ok(frontend.includes(release.renderer.javascript.url));
  assert.ok(!frontend.includes("/browser_renderer.js"));

  const firstManifest = await readFile(join(outputPath, "release.json"), "utf8");
  const secondRelease = await buildWeb({ appPath, wasmPath, outputPath, commit });
  assert.equal(secondRelease.releaseId, release.releaseId);
  assert.equal(await readFile(join(outputPath, "release.json"), "utf8"), firstManifest);
  assert.match(await readFile(join(outputPath, "_headers"), "utf8"), /\/release\.json\n  Cache-Control: no-store/);
  const rootFiles = await readdir(outputPath);
  assert.ok(!rootFiles.includes("ppcwasmjit.wasm"), "backend must remain chunk-only");
  assert.ok(!rootFiles.includes("browser_renderer.js"), "renderer JavaScript must be content-addressed");
  assert.ok(!rootFiles.includes("browser_renderer_bg.wasm"), "renderer wasm must be content-addressed");
});

test("release validation requires both renderer assets", async () => {
  const hash = "0".repeat(64);
  const commit = "0".repeat(40);
  const release = {
    schema: 2,
    releaseId: hash,
    source: {
      repository: "https://github.com/conradev/lazuli",
      commit,
      tree: `https://github.com/conradev/lazuli/tree/${commit}`,
      archive: `https://github.com/conradev/lazuli/archive/${commit}.tar.gz`,
      license: {
        expression: "GPL-3.0-only",
        text: "/LICENSE.txt",
        source: `https://github.com/conradev/lazuli/blob/${commit}/licenses/GPL-3.0-only.txt`,
      },
    },
    frontend: { url: `/assets/frontend-${hash}.html`, sha256: hash, bytes: 1 },
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: hash,
      bytes: 1,
      chunkSize: WASM_CHUNK_SIZE,
      chunks: [{ url: `/assets/backend-${hash}.wasm.chunk`, sha256: hash, bytes: 1 }],
    },
  };
  await assert.rejects(validateRelease(release), /renderer is missing/);
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
  assert.match(
    harness,
    /import initBrowserRenderer, \{ WebGpuRenderer \} from "\/browser_renderer\.js";/,
  );
  assert.match(harness, /wgpu-webgpu/);
  assert.doesNotMatch(harness, /getContext\("(?:2d|webgl2?)"\)/);
  assert.match(harness, /\.shell > \* \{ min-width: 0; \}/);
  assert.match(harness, /#result\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.equal(harness.match(/<!-- LAZULI DEBUG UI START -->/g)?.length, 2);
  assert.equal(harness.match(/<!-- LAZULI DEBUG UI END -->/g)?.length, 2);
});

test("public shell forwards only the SMB scenario", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /url\.search\s*=\s*location\.search/);
  assert.match(
    shell,
    /if \(scenario === "smb-ready-play"\) \{\s*url\.searchParams\.set\("scenario", scenario\);/,
  );
  assert.doesNotMatch(shell, /searchParams\.set\("(?:cycles|dispatches|rest|renderEvery|harness)"/);
});

test("public shell keeps the upload surface at one stable URL", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const fallback = await readFile(new URL("../web/app.html", import.meta.url), "utf8");
  assert.match(shell, /new URL\("\/app\.html", location\.href\)/);
  assert.doesNotMatch(shell, /new URL\(release\.frontend\.url/);
  assert.match(fallback, /location\.replace\("\/"\)/);
});

test("public shell requires a schema-2 worker and never launches a legacy release", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(
    shell,
    new RegExp(`const EXPECTED_RELEASE_SCHEMA = ${RELEASE_SCHEMA}`),
  );
  assert.doesNotMatch(shell, /import .*release\.mjs/);
  assert.match(shell, /fetch\("\/\.gekko\/worker-status"/);
  assert.match(shell, /worker\?\.releaseSchema === EXPECTED_RELEASE_SCHEMA/);
  assert.match(
    shell,
    /await navigator\.serviceWorker\.ready;\s*return waitForCompatibleController\(\);/,
  );
  assert.match(shell, /release\?\.schema !== EXPECTED_RELEASE_SCHEMA/);
  assert.match(shell, /requireCompatibleRelease\(await response\.json\(\)\)/);
  assert.match(shell, /result\.release = requireCompatibleRelease\(result\.release\)/);
  assert.match(shell, /mandatory WebGPU service worker did not take control/);
  assert.doesNotMatch(shell, /verified saved release while the network-dependent upgrade waits/);
});

test("service worker keeps bootstrap modules available across schema upgrades", async () => {
  const worker = await readFile(new URL("../web/sw.js", import.meta.url), "utf8");
  assert.match(worker, /BOOTSTRAP_CACHE = "gekko-bootstrap-v2"/);
  assert.match(worker, /BOOTSTRAP_ASSETS\.includes\(url\.pathname\)/);
  assert.match(worker, /validateStoredRelease\(record\.release\)/);
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
