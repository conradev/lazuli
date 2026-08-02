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
const DSP_IMPORT_URL = "/browser_dsp.wasm";
const DSP_ATTRIBUTION_URL =
  "https://github.com/dolphin-emu/dolphin/blob/a5e2a0d97307ef146879a6f46a86d728a3ac2e97/docs/DSP/free_dsp_rom/dsp_rom_readme.txt";
const THIRD_PARTY_NOTICES_NAME = "THIRD-PARTY-NOTICES.txt";
const THIRD_PARTY_NOTICES_URL = `/${THIRD_PARTY_NOTICES_NAME}`;
const LEGAL_PAGE_DIRECTORY = "source";
const LEGAL_PAGE_URL = `/${LEGAL_PAGE_DIRECTORY}/`;
const FONT_LICENSE_SOURCE_PATH = "licenses/Dolphin-fonts-Apache-2.0.txt";
const GENERIC_DISC_SOURCE_CONFIG = `const defaultDiscSourceConfig = false
      ? {
          kind: "logical-range-endpoint",
          logicalSize: 0,
          url: new URL("/disc", location.href).href,
        }
      : false
        ? { kind: "boot-assets" }
        : null;`;
const STATIC_FILES = [
  "index.html",
  "app.webmanifest",
  "icon.svg",
  "release.mjs",
  "sw.js",
];
const DEBUG_UI_START = "<!-- LAZULI DEBUG UI START -->";
const DEBUG_UI_END = "<!-- LAZULI DEBUG UI END -->";
const TERMINAL_REPORT_SINK = '<pre id="result" data-testid="browser-boot-result" hidden aria-hidden="true"></pre>';
const CAPTURE_DIAGNOSTICS_CONTROL = '<button id="capture-diagnostics" type="button" aria-controls="result" data-capture-state="unavailable" disabled>Capture diagnostics</button>';
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

export function withoutDebugUi(html) {
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
  const shellEnd = result.lastIndexOf("</main>");
  check(shellEnd !== -1, "generated frontend has no closing shell");
  result = `${result.slice(0, shellEnd)}  ${TERMINAL_REPORT_SINK}\n${result.slice(shellEnd)}`;
  return result;
}

export function assertGenericFrontend(html) {
  check(
    html.includes(GENERIC_DISC_SOURCE_CONFIG),
    "generated frontend is disc-bound; regenerate it without boot or disc arguments",
  );
}

function licensedFrontend(html, source, rendererJavascriptUrl, dspUrl) {
  assertGenericFrontend(html);
  html = withoutDebugUi(html);
  const sourceAnchor = '<a href="https://github.com/conradev/lazuli" target="_blank" rel="source noopener">Source</a>';
  check(html.includes(sourceAnchor), "generated frontend does not contain the expected source link");
  check(html.includes('new URL("/ppcwasmjit.wasm", location.href)'), "generated frontend has no browser compiler URL");
  check(html.includes(`new URL("${DSP_IMPORT_URL}", location.href)`), "generated frontend has no browser DSP URL");
  check(html.includes(RENDERER_IMPORT_URL), "generated frontend has no browser renderer import");
  html = html.replaceAll(RENDERER_IMPORT_URL, rendererJavascriptUrl);
  check(!html.includes(RENDERER_IMPORT_URL), "generated frontend still imports the stable browser renderer URL");
  html = html.replaceAll(DSP_IMPORT_URL, dspUrl);
  check(!html.includes(DSP_IMPORT_URL), "generated frontend still imports the stable browser DSP URL");
  const links = [
    CAPTURE_DIAGNOSTICS_CONTROL,
    `<a href="${source.tree}" target="_blank" rel="source noopener">Source</a>`,
    `<a href="${LEGAL_PAGE_URL}" target="_blank" rel="license noopener">Legal</a>`,
  ].join(" · ");
  const withLinks = html.replace(sourceAnchor, links);
  const marker = "<!-- SPDX-License-Identifier: GPL-3.0-only AND Apache-2.0 -->";
  return withLinks.startsWith("<!doctype html>")
    ? withLinks.replace("<!doctype html>", `<!doctype html>\n${marker}`)
    : `${marker}\n${withLinks}`;
}

function sourcePage(source) {
  const fontLicenseSource =
    `${source.repository}/blob/${source.commit}/${FONT_LICENSE_SOURCE_PATH}`;
  const dspResourceSource = `${source.repository}/blob/${source.commit}/resources/README.md`;
  return `<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-only -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="theme-color" content="#0b0c0f"><title>Gekko source</title>
<style>:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#0b0c0f;color:#f1f3f5}main{max-width:40rem;margin:10vh auto;padding:2rem}a{color:#c9d9ff}code{overflow-wrap:anywhere}</style>
</head><body><main><h1>Gekko source</h1><p>Lazuli's code is GPL-3.0-only. This release also includes Apache-2.0 alternative IPL font data and Dolphin's free replacement DSP ROM images.</p>
<p>The IPL font alternatives were generated by Dolphin's <code>gc-font-tool</code> from Droid Sans, copyright 2006–2014 Google Corporation, and are distributed under the Apache License 2.0.</p><dl>
<dt>Commit</dt><dd><a href="${source.tree}"><code>${source.commit}</code></a></dd>
<dt>Archive</dt><dd><a href="${source.archive}">Download corresponding source</a></dd>
<dt>Project license</dt><dd><a href="/LICENSE.txt">GPL-3.0-only</a> · <a href="${source.license.source}">source copy</a></dd>
<dt>Bundled font notice</dt><dd><a href="${THIRD_PARTY_NOTICES_URL}">Apache-2.0 and attribution</a> · <a href="${fontLicenseSource}">source copy</a></dd>
<dt>DSP ROM attribution</dt><dd><a href="${dspResourceSource}">provenance and hashes</a> · <a href="${DSP_ATTRIBUTION_URL}">upstream source and contributor history</a></dd>
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

/release.json
  Cache-Control: no-store

${LEGAL_PAGE_URL}
  Cache-Control: no-store

${THIRD_PARTY_NOTICES_URL}
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
  const dspPath = resolve(options.dspPath);
  const generatedDirectory = dirname(appPath);
  const rendererJavascriptPath = join(generatedDirectory, RENDERER_JAVASCRIPT_NAME);
  const rendererWasmPath = join(generatedDirectory, RENDERER_WASM_NAME);
  const output = outputDirectory(options.outputPath);
  const repository = (options.repository ?? DEFAULT_REPOSITORY).replace(/\/$/, "");
  const commit = options.commit;
  check(COMMIT_PATTERN.test(commit), "--commit must be a lowercase 40-character Git commit");
  check(repository === DEFAULT_REPOSITORY, `unsupported source repository ${repository}`);

  const source = sourceMetadata(repository, commit);
  const [generatedHtml, wasm, dspWasm, rendererJavascriptSource, rendererWasm] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(wasmPath),
    readFile(dspPath),
    readFile(rendererJavascriptPath, "utf8"),
    readFile(rendererWasmPath),
  ]);
  check(wasm.byteLength > 0, "browser compiler is empty");
  check(dspWasm.byteLength > 0, "browser DSP is empty");
  check(rendererJavascriptSource.length > 0, "browser renderer JavaScript is empty");
  check(rendererWasm.byteLength > 0, "browser renderer wasm is empty");

  await rm(output, { recursive: true, force: true });
  const assetsDirectory = join(output, "assets");
  const legalDirectory = join(output, LEGAL_PAGE_DIRECTORY);
  await Promise.all([
    mkdir(assetsDirectory, { recursive: true }),
    mkdir(legalDirectory, { recursive: true }),
  ]);

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

  const dsp = await contentAsset(assetsDirectory, "browser-dsp", "wasm", dspWasm);

  const frontendBytes = new TextEncoder().encode(
    licensedFrontend(generatedHtml, source, renderer.javascript.url, dsp.url),
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
  const release = { schema: RELEASE_SCHEMA, source, frontend, renderer, dsp, backend };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));

  const webDirectory = resolve(options.webDirectory ?? join(PROJECT_ROOT, "web"));
  await Promise.all(STATIC_FILES.map(file => copyFile(join(webDirectory, file), join(output, file))));
  await Promise.all([
    copyFile(join(PROJECT_ROOT, "licenses/GPL-3.0-only.txt"), join(output, "LICENSE.txt")),
    copyFile(
      join(PROJECT_ROOT, FONT_LICENSE_SOURCE_PATH),
      join(output, THIRD_PARTY_NOTICES_NAME),
    ),
  ]);
  await Promise.all([
    writeFile(join(output, "release.json"), `${JSON.stringify(release, null, 2)}\n`),
    writeFile(join(legalDirectory, "index.html"), sourcePage(source)),
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
      "--dsp": "dspPath",
      "--output": "outputPath",
      "--commit": "commit",
      "--repository": "repository",
    }[name];
    check(key !== undefined, `unknown argument ${name}`);
    options[key] = value;
  }
  for (const key of ["appPath", "wasmPath", "dspPath", "outputPath", "commit"]) {
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
