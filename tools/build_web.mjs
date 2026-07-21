// SPDX-License-Identifier: GPL-3.0-only

import { readFile, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import {
  RELEASE_SCHEMA,
  WASM_CHUNK_SIZE,
  releaseIdentityPayload,
  sha256Hex,
} from "../web/release.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY = "https://github.com/conradev/lazuli";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RENDERER_JAVASCRIPT_NAME = "browser_renderer.js";
const RENDERER_WASM_NAME = "browser_renderer_bg.wasm";
const RENDERER_IMPORT_URL = `/${RENDERER_JAVASCRIPT_NAME}`;
const STATIC_FILES = [
  "index.html",
  "app.html",
  "app.webmanifest",
  "icon.svg",
  "release.mjs",
  "sw.js",
];
const DEBUG_UI_START = "<!-- LAZULI DEBUG UI START -->";
const DEBUG_UI_END = "<!-- LAZULI DEBUG UI END -->";
const DEBUG_ONLY_IDS = [
  "runner-controls",
  "pause-runner",
  "resume-runner",
  "diagnostics",
  "disc-url",
  "load-disc-url",
  "extend-cycles",
  "extend-dispatches",
  "extend-runner",
  "runner-rest-ms",
  "apply-throttle",
  "runner-render-every",
  "apply-presentation",
  "snapshot-runner",
  "stop-runner",
  "result",
];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function outputDirectory(path) {
  const output = resolve(path);
  const permittedParent = [PROJECT_ROOT, resolve(tmpdir())].some(parent => {
    const remainder = relative(parent, output);
    return remainder !== "" && !remainder.startsWith("..") && !remainder.startsWith("/");
  });
  check(
    basename(output) === "dist" && permittedParent,
    `refusing to replace output directory ${output}`,
  );
  return output;
}

async function contentAsset(directory, prefix, extension, bytes) {
  const sha256 = await sha256Hex(bytes);
  const name = `${prefix}-${sha256}.${extension}`;
  await writeFile(join(directory, name), bytes);
  return { url: `/assets/${name}`, sha256, bytes: bytes.byteLength };
}

function sourceMetadata(repository, commit) {
  return {
    repository,
    commit,
    tree: `${repository}/tree/${commit}`,
    archive: `${repository}/archive/${commit}.tar.gz`,
    license: {
      expression: "GPL-3.0-only",
      text: "/LICENSE.txt",
      source: `${repository}/blob/${commit}/licenses/GPL-3.0-only.txt`,
    },
  };
}

function withoutDebugUi(html) {
  let result = html;
  let sections = 0;
  while (result.includes(DEBUG_UI_START)) {
    const start = result.indexOf(DEBUG_UI_START);
    const end = result.indexOf(DEBUG_UI_END, start + DEBUG_UI_START.length);
    check(end !== -1, "generated frontend has an unterminated debug UI section");
    result = result.slice(0, start) + result.slice(end + DEBUG_UI_END.length);
    sections += 1;
  }
  check(sections > 0, "generated frontend has no debug UI sections");
  check(!result.includes(DEBUG_UI_END), "generated frontend has an unmatched debug UI boundary");
  const debugSurface = 'data-surface="debug"';
  check(result.includes(debugSurface), "generated frontend is not marked as a debug surface");
  result = result.replace(debugSurface, 'data-surface="release"');
  check(!result.includes(debugSurface), "generated frontend contains multiple debug surfaces");
  for (const id of DEBUG_ONLY_IDS) {
    check(!result.includes(`id="${id}"`), `public frontend still contains ${id}`);
  }
  return result;
}

function licensedFrontend(html, source, rendererJavascriptUrl) {
  html = withoutDebugUi(html);
  const sourceAnchor = '<a href="https://github.com/conradev/lazuli" target="_blank" rel="source noopener">Source</a>';
  check(html.includes(sourceAnchor), "generated frontend does not contain the expected source link");
  check(html.includes('new URL("/ppcwasmjit.wasm", location.href)'), "generated frontend has no browser compiler URL");
  check(html.includes(RENDERER_IMPORT_URL), "generated frontend has no browser renderer import");
  html = html.replaceAll(RENDERER_IMPORT_URL, rendererJavascriptUrl);
  check(!html.includes(RENDERER_IMPORT_URL), "generated frontend still imports the stable browser renderer URL");
  const links = [
    `<a href="${source.tree}" target="_blank" rel="source noopener">Source</a>`,
    '<a href="/LICENSE.txt" target="_blank" rel="license noopener">GPL-3.0-only</a>',
  ].join(" · ");
  const withLinks = html.replace(sourceAnchor, links);
  const marker = "<!-- SPDX-License-Identifier: GPL-3.0-only -->";
  return withLinks.startsWith("<!doctype html>")
    ? withLinks.replace("<!doctype html>", `<!doctype html>\n${marker}`)
    : `${marker}\n${withLinks}`;
}

function sourcePage(source) {
  return `<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-only -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="theme-color" content="#0b0c0f"><title>Gekko source</title>
<style>:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#0b0c0f;color:#f1f3f5}main{max-width:40rem;margin:10vh auto;padding:2rem}a{color:#c9d9ff}code{overflow-wrap:anywhere}</style>
</head><body><main><h1>Gekko source</h1><p>This release is GPL-3.0-only.</p><dl>
<dt>Commit</dt><dd><a href="${source.tree}"><code>${source.commit}</code></a></dd>
<dt>Archive</dt><dd><a href="${source.archive}">Download corresponding source</a></dd>
<dt>License</dt><dd><a href="/LICENSE.txt">GPL-3.0-only</a> · <a href="${source.license.source}">source copy</a></dd>
</dl></main></body></html>\n`;
}

function cloudflareHeaders() {
  return `# SPDX-License-Identifier: GPL-3.0-only
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' https: http:; img-src 'self' data: blob:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff

/
  Cache-Control: no-store

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-store

/app
  Cache-Control: no-store

/app.html
  Cache-Control: no-store

/release.json
  Cache-Control: no-store

/source.html
  Cache-Control: no-store

/sw.js
  Cache-Control: no-store
  Service-Worker-Allowed: /

/release.mjs
  Cache-Control: no-store

/app.webmanifest
  Cache-Control: no-cache
`;
}

export async function buildWeb(options) {
  const appPath = resolve(options.appPath);
  const wasmPath = resolve(options.wasmPath);
  const generatedDirectory = dirname(appPath);
  const rendererJavascriptPath = join(generatedDirectory, RENDERER_JAVASCRIPT_NAME);
  const rendererWasmPath = join(generatedDirectory, RENDERER_WASM_NAME);
  const output = outputDirectory(options.outputPath);
  const repository = (options.repository ?? DEFAULT_REPOSITORY).replace(/\/$/, "");
  const commit = options.commit;
  check(COMMIT_PATTERN.test(commit), "--commit must be a lowercase 40-character Git commit");
  check(repository === DEFAULT_REPOSITORY, `unsupported source repository ${repository}`);

  const source = sourceMetadata(repository, commit);
  const [generatedHtml, wasm, rendererJavascriptSource, rendererWasm] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(wasmPath),
    readFile(rendererJavascriptPath, "utf8"),
    readFile(rendererWasmPath),
  ]);
  check(wasm.byteLength > 0, "browser compiler is empty");
  check(rendererJavascriptSource.length > 0, "browser renderer JavaScript is empty");
  check(rendererWasm.byteLength > 0, "browser renderer wasm is empty");

  await rm(output, { recursive: true, force: true });
  const assetsDirectory = join(output, "assets");
  await mkdir(assetsDirectory, { recursive: true });

  const rendererWasmAsset = await contentAsset(
    assetsDirectory,
    "browser-renderer-wasm",
    "wasm",
    rendererWasm,
  );
  let rendererJavascript = rendererJavascriptSource;
  let rendererWasmReferences = 0;
  for (const reference of [`./${RENDERER_WASM_NAME}`, RENDERER_WASM_NAME]) {
    const count = rendererJavascript.split(reference).length - 1;
    if (count === 0) continue;
    rendererWasmReferences += count;
    rendererJavascript = rendererJavascript.replaceAll(reference, rendererWasmAsset.url);
  }
  check(rendererWasmReferences > 0, "browser renderer JavaScript has no relative wasm URL");
  check(
    !rendererJavascript.includes(RENDERER_WASM_NAME),
    "browser renderer JavaScript still contains the stable wasm filename",
  );
  const rendererJavascriptAsset = await contentAsset(
    assetsDirectory,
    "browser-renderer",
    "js",
    new TextEncoder().encode(rendererJavascript),
  );
  const renderer = {
    javascript: rendererJavascriptAsset,
    wasm: rendererWasmAsset,
  };

  const frontendBytes = new TextEncoder().encode(
    licensedFrontend(generatedHtml, source, renderer.javascript.url),
  );
  const frontend = await contentAsset(assetsDirectory, "frontend", "html", frontendBytes);
  const chunks = [];
  for (let offset = 0; offset < wasm.byteLength; offset += WASM_CHUNK_SIZE) {
    const bytes = wasm.subarray(offset, Math.min(offset + WASM_CHUNK_SIZE, wasm.byteLength));
    chunks.push(await contentAsset(assetsDirectory, "backend", "wasm.chunk", bytes));
  }

  const backend = {
    url: "/ppcwasmjit.wasm",
    sha256: await sha256Hex(wasm),
    bytes: wasm.byteLength,
    chunkSize: WASM_CHUNK_SIZE,
    chunks,
  };
  const release = { schema: RELEASE_SCHEMA, source, frontend, renderer, backend };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));

  const webDirectory = resolve(options.webDirectory ?? join(PROJECT_ROOT, "web"));
  await Promise.all(STATIC_FILES.map(file => copyFile(join(webDirectory, file), join(output, file))));
  await copyFile(join(PROJECT_ROOT, "licenses/GPL-3.0-only.txt"), join(output, "LICENSE.txt"));
  await Promise.all([
    writeFile(join(output, "release.json"), `${JSON.stringify(release, null, 2)}\n`),
    writeFile(join(output, "source.html"), sourcePage(source)),
    writeFile(join(output, "_headers"), cloudflareHeaders()),
  ]);
  return release;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    check(name?.startsWith("--") && value !== undefined, `invalid argument ${name ?? ""}`);
    const key = {
      "--app": "appPath",
      "--wasm": "wasmPath",
      "--output": "outputPath",
      "--commit": "commit",
      "--repository": "repository",
    }[name];
    check(key !== undefined, `unknown argument ${name}`);
    options[key] = value;
  }
  for (const key of ["appPath", "wasmPath", "outputPath", "commit"]) {
    check(typeof options[key] === "string", `missing required --${key.replace("Path", "")}`);
  }
  return options;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const release = await buildWeb(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${release.releaseId}\n`);
  } catch (error) {
    process.stderr.write(`build_web: ${error.message}\n`);
    process.exitCode = 1;
  }
}
