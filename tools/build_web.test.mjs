// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  assertGenericFrontend,
  buildWeb,
  withoutDebugUi,
} from "./build_web.mjs";
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

const genericDiscSourceConfig = `const defaultDiscSourceConfig = false
      ? {
          kind: "logical-range-endpoint",
          url: new URL("/disc", location.href).href,
        }
      : false
        ? { kind: "boot-assets" }
        : null;`;

test("release builder accepts only a generic generated frontend", () => {
  assert.doesNotThrow(() => assertGenericFrontend(genericDiscSourceConfig));
  assert.throws(
    () => assertGenericFrontend(
      genericDiscSourceConfig.replace(
        "const defaultDiscSourceConfig = false",
        "const defaultDiscSourceConfig = true",
      ),
    ),
    /generated frontend is disc-bound/,
  );
  assert.throws(
    () => assertGenericFrontend(
      genericDiscSourceConfig.replace(
        ": false\n        ? { kind: \"boot-assets\" }",
        ": true\n        ? { kind: \"boot-assets\" }",
      ),
    ),
    /generated frontend is disc-bound/,
  );
});

test("builds a deterministic licensed release from a generic generated frontend", async () => {
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
new URL("/ppcwasmjit.wasm", location.href);
${genericDiscSourceConfig}
</script></main></body>`,
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
  assert.match(
    frontend,
    /SPDX-License-Identifier: GPL-3\.0-only AND Apache-2\.0/,
  );
  assert.match(frontend, new RegExp(`/tree/${commit}`));
  assert.match(
    frontend,
    /href="\/source\/"[^>]*>Legal<\/a>/,
  );
  assert.doesNotMatch(frontend, />GPL-3\.0-only<|>Apache-2\.0 font notice</);
  assert.doesNotMatch(frontend, /href="https:\/\/github\.com\/conradev\/lazuli"/);
  assert.doesNotMatch(frontend, /(?:Pause|Resume|Stop|Options and diagnostics)/);
  assert.doesNotMatch(frontend, /id="(?:runner-controls|pause-runner|resume-runner|diagnostics|stop-runner)"/);
  assert.match(frontend, /data-surface="release"/);
  assert.doesNotMatch(frontend, /data-surface="debug"/);
  assert.match(frontend, /<main>Play<\/main>/);
  assert.ok(frontend.includes(release.renderer.javascript.url));
  assert.ok(!frontend.includes("/browser_renderer.js"));

  const [sourcePage, thirdPartyNotices, vendoredFontLicense] = await Promise.all([
    readFile(join(outputPath, "source", "index.html"), "utf8"),
    readFile(join(outputPath, "THIRD-PARTY-NOTICES.txt")),
    readFile(
      new URL("../licenses/Dolphin-fonts-Apache-2.0.txt", import.meta.url),
    ),
  ]);
  assert.deepEqual(thirdPartyNotices, vendoredFontLicense);
  assert.equal(
    await sha256Hex(thirdPartyNotices),
    "5cf813ce581cbd1e8dc7d024f7190754842900d66300488bca6f1531fc1be86e",
  );
  assert.match(
    thirdPartyNotices.toString("utf8"),
    /Both fonts are based on Droid Sans[\s\S]*Copyright 2006-2014, Google Corporation[\s\S]*Apache License\s+Version 2\.0/,
  );
  assert.match(
    sourcePage,
    /Lazuli's code is GPL-3\.0-only\. This release also includes Apache-2\.0 alternative IPL font data\./,
  );
  assert.match(
    sourcePage,
    /generated by Dolphin's <code>gc-font-tool<\/code> from Droid Sans, copyright 2006–2014 Google Corporation, and are distributed under the Apache License 2\.0\./,
  );
  assert.match(
    sourcePage,
    /href="\/THIRD-PARTY-NOTICES\.txt">Apache-2\.0 and attribution<\/a>/,
  );
  assert.match(
    sourcePage,
    new RegExp(
      `/blob/${commit}/licenses/Dolphin-fonts-Apache-2\\.0\\.txt`,
    ),
  );
  assert.doesNotMatch(sourcePage, /This release is GPL-3\.0-only\./);

  const firstManifest = await readFile(join(outputPath, "release.json"), "utf8");
  const secondRelease = await buildWeb({ appPath, wasmPath, outputPath, commit });
  assert.equal(secondRelease.releaseId, release.releaseId);
  assert.equal(await readFile(join(outputPath, "release.json"), "utf8"), firstManifest);
  const headers = await readFile(join(outputPath, "_headers"), "utf8");
  assert.match(headers, /\/release\.json\n  Cache-Control: no-store/);
  assert.match(headers, /\/source\/\n  Cache-Control: no-store/);
  assert.match(
    headers,
    /\/THIRD-PARTY-NOTICES\.txt\n  Cache-Control: no-store/,
  );
  assert.doesNotMatch(headers, /^\/app(?:\.html)?$/m);
  const rootFiles = await readdir(outputPath);
  assert.ok(rootFiles.includes("THIRD-PARTY-NOTICES.txt"));
  assert.ok(rootFiles.includes("source"));
  assert.ok(!rootFiles.includes("source.html"));
  assert.ok(!rootFiles.includes("app.html"), "legacy app alias must not be deployed");
  assert.ok(!rootFiles.includes("font_japanese.bin"), "font data must not gain a public route");
  assert.ok(!rootFiles.includes("font_western.bin"), "font data must not gain a public route");
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
  assert.match(harness, /class="button primary file-picker disc-picker"/);
  assert.match(harness, /id="disc-file"[^>]*aria-label="Open ISO or CISO"/);
  assert.match(harness, /class="button file-picker ipl-picker"/);
  assert.match(harness, /id="ipl-file"[^>]*aria-label="Use local IPL"/);
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

test("public shell never forwards query state to the immutable frontend", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /publicFrontendSearch|scenarioValues|viewportCapture|headlessRun/);
  assert.match(shell, /url\.search = "";\s*url\.hash = "";/);
  assert.doesNotMatch(shell, /url\.search\s*=\s*location\.search/);
});

test("public shell keeps attribution behind a compact canonical Legal link", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(shell, /href="\/source\/"[^>]*>Legal<\/a>/);
  assert.match(
    shell,
    /href="https:\/\/github\.com\/conradev\/lazuli"[^>]*>Source<\/a>\s*·\s*<a/,
  );
  assert.doesNotMatch(shell, />GPL-3\.0-only</);
});

test("public shell accepts only an exact root location", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const start = shell.indexOf("function hasExactRootLocation(");
  assert.notEqual(start, -1);
  const bodyStart = shell.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < shell.length; index += 1) {
    if (shell[index] === "{") depth += 1;
    if (shell[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.notEqual(end, -1);
  const hasExactRootLocation = Function(
    `"use strict"; return (${shell.slice(start, end)});`,
  )();
  assert.equal(hasExactRootLocation(new URL("https://gekko.free/")), true);
  for (const value of [
    "https://gekko.free/index.html",
    "https://gekko.free/?scenario=smb-ready-play",
    "https://gekko.free/#compatibility",
  ]) {
    assert.equal(hasExactRootLocation(new URL(value)), false, value);
  }
  assert.match(shell, /location\.replace\(new URL\("\/", location\.origin\)\.href\)/);
});

test("public shell binds the iframe to the staged immutable frontend", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(shell, /new URL\(release\.frontend\.url, location\.href\)/);
  assert.doesNotMatch(shell, /app\.html/);
  await assert.rejects(
    readFile(new URL("../web/app.html", import.meta.url), "utf8"),
    error => error?.code === "ENOENT",
  );
});

test("public shell never launches an older saved release after an online stage failure", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const start = shell.indexOf("function selectStagedRelease(");
  assert.notEqual(start, -1);
  const bodyStart = shell.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < shell.length; index += 1) {
    if (shell[index] === "{") depth += 1;
    if (shell[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.notEqual(end, -1);
  const selectStagedRelease = Function(
    `"use strict"; return (${shell.slice(start, end)});`,
  )();
  const current = { releaseId: "current" };
  const saved = { releaseId: "saved" };
  assert.deepEqual(
    selectStagedRelease(
      { offline: false, release: current },
      { ok: true, release: current },
    ),
    { release: current, saved: false },
  );
  assert.throws(
    () => selectStagedRelease(
      { offline: false, release: current },
      { ok: false, release: saved, error: "asset hash mismatch" },
    ),
    /latest release could not be activated: asset hash mismatch/,
  );
  assert.deepEqual(
    selectStagedRelease(
      { offline: true, release: saved },
      { ok: false, release: saved, error: "offline" },
    ),
    { release: saved, saved: true },
  );
});

test("public shell exposes no compatibility route parameters", async () => {
  const shell = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(
    shell,
    /smb-ready-play|smb-sustained-play|scenario|viewportCapture|headlessRun/,
  );
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
  assert.match(shell, /selectStagedRelease\(latest, staged\)/);
  assert.doesNotMatch(shell, /saved\s*\|\|=/);
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
