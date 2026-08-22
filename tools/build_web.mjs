// SPDX-License-Identifier: GPL-3.0-only

import { readFile, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import {
  RELEASE_SCHEMA,
  RELEASE_BOOTSTRAP_URLS,
  RESIDENT_RUNTIME_ABI,
  RESIDENT_RUNTIME_CHOICE,
  releaseIdentityPayload,
  releaseAssets,
  rollbackReleaseAssets,
  sha256Hex,
  validateRelease,
  validateRollbackRelease,
  verifyAssetBytes,
} from "../web/release.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPOSITORY = "https://github.com/conradev/lazuli";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RENDERER_JAVASCRIPT_NAME = "browser_renderer.js";
const RENDERER_WASM_NAME = "browser_renderer_bg.wasm";
const RENDERER_IMPORT_URL = `/${RENDERER_JAVASCRIPT_NAME}`;
const RESIDENT_RUNTIME_MARKER = "__LAZULI_RESIDENT_RELEASE_RUNTIME__";
const RESIDENT_ADAPTER_NAME = "resident-machine.mjs";
const RESIDENT_WORKER_NAME = "resident-machine-worker.mjs";
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
  "app.webmanifest",
  "icon.svg",
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

async function stableAsset(url, bytes) {
  return {
    url,
    sha256: await sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
}

function exactWasmBoundary(bytes, expectedImports, expectedExports, label) {
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid Wasm: ${error.message}`);
  }
  check(
    JSON.stringify(WebAssembly.Module.imports(module)) === JSON.stringify(expectedImports),
    `${label} imports crossed the resident boundary`,
  );
  check(
    JSON.stringify(WebAssembly.Module.exports(module)) === JSON.stringify(expectedExports),
    `${label} exports crossed the resident boundary`,
  );
  return module;
}

function requiredWasmFunction(exports, name, label) {
  const value = exports[name];
  check(typeof value === "function", `${label} is missing ${name}`);
  return value;
}

function exactAdapterConstant(source, name, expected) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)(?:n)?\\s*;`));
  check(match !== null, `resident adapter does not declare ${name}`);
  check(Number(match[1].replaceAll("_", "")) === expected, `resident adapter ${name} ABI changed`);
}

function adapterRequiredCoreFunctions(source) {
  const match = source.match(/const\s+REQUIRED_CORE_FUNCTIONS\s*=\s*\[([\s\S]*?)\];/);
  check(match !== null, "resident adapter does not declare REQUIRED_CORE_FUNCTIONS");
  const names = [...match[1].matchAll(/"([a-zA-Z0-9_]+)"/g)].map(item => item[1]);
  check(names.length > 0 && new Set(names).size === names.length,
    "resident adapter required-core list is empty or duplicated");
  return names;
}

export function requireUnselectedGameFidelitySnapshot(core, stage) {
  const pointer = requiredWasmFunction(
    core,
    "core_game_fidelity_snapshot",
    "resident core",
  )() >>> 0;
  check(
    pointer === 0,
    `resident core exposed a game-fidelity snapshot ${stage} authenticated title selection`,
  );
}

export function deriveResidentRuntimeAbi(coreBytes, dispatcherBytes, coordinatorBytes, adapterSource) {
  const coreModule = new WebAssembly.Module(coreBytes);
  check(
    JSON.stringify(WebAssembly.Module.imports(coreModule)) ===
      JSON.stringify([{ module: "lazuli", name: "memory", kind: "memory" }]),
    "resident core imports crossed the resident boundary",
  );
  const memory = new WebAssembly.Memory({
    initial: RESIDENT_RUNTIME_ABI.memoryInitialPages,
    maximum: RESIDENT_RUNTIME_ABI.memoryMaximumPages,
  });
  let core;
  try {
    core = new WebAssembly.Instance(coreModule, { lazuli: { memory } }).exports;
  } catch (error) {
    throw new Error(`resident core rejected the canonical memory ABI: ${error.message}`);
  }
  for (const name of adapterRequiredCoreFunctions(adapterSource)) {
    requiredWasmFunction(core, name, "resident core required by adapter");
  }
  for (const name of [
    "core_abi_version",
    "core_compile_request_bytes",
    "core_host_request_bytes",
    "core_machine_evidence_bytes",
    "core_machine_evidence_snapshot",
    "core_capture_authority_bytes",
    "core_capture_authority_snapshot",
    "core_game_fidelity_bytes",
    "core_game_fidelity_requested_buttons",
    "core_game_fidelity_requested_stick_xy_cxy",
    "core_game_fidelity_requested_trigger_lrab",
    "core_game_fidelity_phase",
    "core_game_fidelity_snapshot",
    "core_memory_initial_pages",
    "core_memory_maximum_pages",
    "core_dispatch_slot_capacity",
    "core_init",
    "core_begin_slice",
    "core_current_run_outcome",
    "core_finish_slice",
    "validate_instruction_page_dependency",
  ]) {
    requiredWasmFunction(core, name, "resident core");
  }
  for (const name of [
    "core_game_fidelity_bytes",
    "core_game_fidelity_requested_buttons",
    "core_game_fidelity_requested_stick_xy_cxy",
    "core_game_fidelity_requested_trigger_lrab",
    "core_game_fidelity_phase",
    "core_game_fidelity_snapshot",
    "core_capture_authority_bytes",
    "core_capture_authority_snapshot",
  ]) {
    check(core[name].length === 0, `resident core ${name} signature is not zero-argument`);
  }
  requireUnselectedGameFidelitySnapshot(core, "before");
  const captureAuthorityBytes = core.core_capture_authority_bytes() >>> 0;
  check(captureAuthorityBytes === 108, "resident core capture-authority ABI changed");
  const abi = {
    coreVersion: core.core_abi_version() >>> 0,
    compileRequestBytes: core.core_compile_request_bytes() >>> 0,
    hostRequestBytes: core.core_host_request_bytes() >>> 0,
    runOutcomeBytes: 0,
    machineEvidenceBytes: core.core_machine_evidence_bytes() >>> 0,
    gameFidelityBytes: core.core_game_fidelity_bytes() >>> 0,
    memoryInitialPages: core.core_memory_initial_pages() >>> 0,
    memoryMaximumPages: core.core_memory_maximum_pages() >>> 0,
  };
  check(core.core_init() === 1, "resident core did not initialize for ABI derivation");
  const machineEvidencePointer = core.core_machine_evidence_snapshot() >>> 0;
  check(
    machineEvidencePointer !== 0 && machineEvidencePointer % 8 === 0 &&
      machineEvidencePointer + abi.machineEvidenceBytes <= memory.buffer.byteLength,
    "resident core machine-evidence snapshot ABI is invalid",
  );
  requireUnselectedGameFidelitySnapshot(core, "after");
  check(core.core_begin_slice(0n, 0) === 0, "resident core accepted a zero-cap ABI probe");
  const outcomePointer = core.core_current_run_outcome() >>> 0;
  check(outcomePointer !== 0 && outcomePointer + 8 <= memory.buffer.byteLength,
    "resident core did not publish its zero-cap outcome ABI");
  const outcome = new DataView(memory.buffer, outcomePointer, 8);
  check(outcome.getUint32(0, true) === abi.coreVersion, "resident outcome ABI version changed");
  abi.runOutcomeBytes = outcome.getUint32(4, true);

  for (const [name, expected] of Object.entries(RESIDENT_RUNTIME_ABI)) {
    check(abi[name] === expected, `resident ABI ${name} is ${abi[name]}, expected ${expected}`);
  }
  exactAdapterConstant(adapterSource, "COMPILE_REQUEST_BYTES", abi.compileRequestBytes);
  exactAdapterConstant(adapterSource, "HOST_REQUEST_BYTES", abi.hostRequestBytes);
  exactAdapterConstant(adapterSource, "RUN_OUTCOME_BYTES", abi.runOutcomeBytes);
  exactAdapterConstant(adapterSource, "CAPTURE_AUTHORITY_RECORD_BYTES", captureAuthorityBytes);
  exactAdapterConstant(
    adapterSource,
    "RESIDENT_MEMORY_INITIAL_PAGES",
    abi.memoryInitialPages,
  );
  exactAdapterConstant(
    adapterSource,
    "RESIDENT_MEMORY_MAXIMUM_PAGES",
    abi.memoryMaximumPages,
  );

  const dispatcherModule = exactWasmBoundary(
    dispatcherBytes,
    [
      { module: "lazuli", name: "memory", kind: "memory" },
      {
        module: "lazuli",
        name: "validate_instruction_page_dependency",
        kind: "function",
      },
    ],
    [
      { name: "run", kind: "function" },
      { name: "blocks", kind: "table" },
    ],
    "resident dispatcher",
  );
  const dispatcher = new WebAssembly.Instance(dispatcherModule, {
    lazuli: {
      memory,
      validate_instruction_page_dependency: core.validate_instruction_page_dependency,
    },
  }).exports;
  const slotCapacity = core.core_dispatch_slot_capacity() >>> 0;
  check(slotCapacity > 0 && dispatcher.blocks instanceof WebAssembly.Table,
    "resident dispatcher table ABI is invalid");
  check(dispatcher.blocks.length <= slotCapacity, "resident dispatcher exceeds the core slot ABI");
  if (dispatcher.blocks.length < slotCapacity) {
    dispatcher.blocks.grow(slotCapacity - dispatcher.blocks.length);
  }

  const coordinatorModule = exactWasmBoundary(
    coordinatorBytes,
    [
      { module: "lazuli", name: "memory", kind: "memory" },
      { module: "lazuli_core", name: "core_begin_slice", kind: "function" },
      { module: "lazuli_core", name: "core_finish_slice", kind: "function" },
      { module: "lazuli_core", name: "core_current_run_outcome", kind: "function" },
      { module: "lazuli_dispatch", name: "run", kind: "function" },
    ],
    [{ name: "core_run", kind: "function" }],
    "resident coordinator",
  );
  let coordinator;
  try {
    coordinator = new WebAssembly.Instance(coordinatorModule, {
      lazuli: { memory },
      lazuli_core: {
        core_begin_slice: core.core_begin_slice,
        core_finish_slice: core.core_finish_slice,
        core_current_run_outcome: core.core_current_run_outcome,
      },
      lazuli_dispatch: { run: dispatcher.run },
    }).exports;
  } catch (error) {
    throw new Error(`resident coordinator rejected the linked core/dispatcher ABI: ${error.message}`);
  }
  requiredWasmFunction(coordinator, "core_run", "resident coordinator");
  return Object.freeze({ ...abi });
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

function licensedFrontend(html, source, rendererJavascriptUrl, runtime) {
  assertGenericFrontend(html);
  html = withoutDebugUi(html);
  const sourceAnchor = '<a href="https://github.com/conradev/lazuli" target="_blank" rel="source noopener">Source</a>';
  check(html.includes(sourceAnchor), "generated frontend does not contain the expected source link");
  check(!html.includes("/ppcwasmjit.wasm"), "generated frontend still contains the legacy compiler URL");
  check(!html.includes("/browser_dsp.wasm"), "generated frontend still contains the legacy DSP URL");
  check(html.includes(RENDERER_IMPORT_URL), "generated frontend has no browser renderer import");
  check(
    html.split(RESIDENT_RUNTIME_MARKER).length === 2,
    "generated frontend must contain exactly one resident runtime marker",
  );
  for (const field of ["worker", "core", "dispatcher", "coordinator"]) {
    check(
      html.includes(`residentReleaseRuntime.${field}.url`),
      `generated frontend does not consume residentReleaseRuntime.${field}.url`,
    );
  }
  html = html.replace(RESIDENT_RUNTIME_MARKER, JSON.stringify(runtime));
  check(!html.includes(RESIDENT_RUNTIME_MARKER), "generated frontend retained its runtime marker");
  html = html.replaceAll(RENDERER_IMPORT_URL, rendererJavascriptUrl);
  check(!html.includes(RENDERER_IMPORT_URL), "generated frontend still imports the stable browser renderer URL");
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

function cloudflareRedirects() {
  return `# SPDX-License-Identifier: GPL-3.0-only
/ /index.html 200
`;
}

async function loadRollback(options) {
  const release = options.rollbackRelease ?? JSON.parse(
    await readFile(resolve(options.rollbackReleasePath), "utf8"),
  );
  await validateRollbackRelease(release);
  const directory = resolve(
    options.rollbackDirectory ?? dirname(resolve(options.rollbackReleasePath)),
  );
  return { release, directory };
}

async function copyVerifiedRollbackAssets(rollback, output) {
  for (const asset of releaseAssets(rollback.release)) {
    const relativePath = asset.url.slice(1);
    const sourcePath = resolve(rollback.directory, relativePath);
    const sourceRemainder = relative(rollback.directory, sourcePath);
    check(
      sourceRemainder !== "" && !sourceRemainder.startsWith("..") && !sourceRemainder.startsWith("/"),
      `rollback asset escapes its directory: ${asset.url}`,
    );
    const bytes = await readFile(sourcePath);
    await verifyAssetBytes(asset, bytes);
    const destination = resolve(output, relativePath);
    const destinationRemainder = relative(output, destination);
    check(
      destinationRemainder !== "" && !destinationRemainder.startsWith("..") &&
        !destinationRemainder.startsWith("/"),
      `rollback asset escapes output: ${asset.url}`,
    );
    await mkdir(dirname(destination), { recursive: true });
    try {
      const existing = await readFile(destination);
      await verifyAssetBytes(asset, existing);
      check(existing.equals(bytes), `rollback asset collides with primary asset ${asset.url}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeFile(destination, bytes);
    }
  }
}

export async function buildWeb(options) {
  const appPath = resolve(options.appPath);
  const corePath = resolve(options.corePath);
  const dispatcherPath = resolve(options.dispatcherPath);
  const coordinatorPath = resolve(options.coordinatorPath);
  const generatedDirectory = dirname(appPath);
  const rendererJavascriptPath = join(generatedDirectory, RENDERER_JAVASCRIPT_NAME);
  const rendererWasmPath = join(generatedDirectory, RENDERER_WASM_NAME);
  const output = outputDirectory(options.outputPath);
  const webDirectory = resolve(options.webDirectory ?? join(PROJECT_ROOT, "web"));
  const repository = (options.repository ?? DEFAULT_REPOSITORY).replace(/\/$/, "");
  const commit = options.commit;
  check(COMMIT_PATTERN.test(commit), "--commit must be a lowercase 40-character Git commit");
  check(repository === DEFAULT_REPOSITORY, `unsupported source repository ${repository}`);

  const source = sourceMetadata(repository, commit);
  const rollback = await loadRollback(options);
  const [
    generatedHtml,
    rendererJavascriptSource,
    rendererWasm,
    coreWasm,
    dispatcherWasm,
    coordinatorWasm,
    adapterSource,
    workerSource,
    bootstrapDocumentBytes,
    bootstrapReleaseModuleBytes,
    bootstrapServiceWorkerBytes,
  ] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(rendererJavascriptPath, "utf8"),
    readFile(rendererWasmPath),
    readFile(corePath),
    readFile(dispatcherPath),
    readFile(coordinatorPath),
    readFile(join(webDirectory, RESIDENT_ADAPTER_NAME), "utf8"),
    readFile(join(webDirectory, RESIDENT_WORKER_NAME), "utf8"),
    readFile(join(webDirectory, RELEASE_BOOTSTRAP_URLS.document.slice(1))),
    readFile(join(webDirectory, RELEASE_BOOTSTRAP_URLS.releaseModule.slice(1))),
    readFile(join(webDirectory, RELEASE_BOOTSTRAP_URLS.serviceWorker.slice(1))),
  ]);
  check(rendererJavascriptSource.length > 0, "browser renderer JavaScript is empty");
  check(rendererWasm.byteLength > 0, "browser renderer wasm is empty");
  check(coreWasm.byteLength > 0, "resident core is empty");
  check(dispatcherWasm.byteLength > 0, "resident dispatcher is empty");
  check(coordinatorWasm.byteLength > 0, "resident coordinator is empty");
  check(adapterSource.length > 0, "resident adapter is empty");
  check(workerSource.length > 0, "resident worker is empty");
  const verifyRuntimeAbi = options.runtimeAbiVerifier ?? deriveResidentRuntimeAbi;
  const runtimeAbi = verifyRuntimeAbi(
    coreWasm,
    dispatcherWasm,
    coordinatorWasm,
    adapterSource,
  );

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

  const core = await contentAsset(assetsDirectory, "browser-machine", "wasm", coreWasm);
  const dispatcher = await contentAsset(
    assetsDirectory,
    "resident-dispatcher",
    "wasm",
    dispatcherWasm,
  );
  const coordinator = await contentAsset(
    assetsDirectory,
    "core-run-coordinator",
    "wasm",
    coordinatorWasm,
  );
  const adapter = await contentAsset(
    assetsDirectory,
    "resident-machine-adapter",
    "mjs",
    new TextEncoder().encode(adapterSource),
  );
  const adapterImport = `from "./${RESIDENT_ADAPTER_NAME}"`;
  check(
    workerSource.split(adapterImport).length === 2,
    "resident worker must contain exactly one canonical adapter import",
  );
  const packagedWorker = workerSource.replace(adapterImport, `from "${adapter.url}"`);
  check(!packagedWorker.includes(adapterImport), "resident worker retained its mutable adapter import");
  const worker = await contentAsset(
    assetsDirectory,
    "resident-machine-worker",
    "mjs",
    new TextEncoder().encode(packagedWorker),
  );
  const runtime = {
    choice: RESIDENT_RUNTIME_CHOICE,
    abi: { ...runtimeAbi },
    core,
    dispatcher,
    coordinator,
    adapter,
    worker,
  };

  const frontendBytes = new TextEncoder().encode(
    licensedFrontend(generatedHtml, source, renderer.javascript.url, runtime),
  );
  const frontend = await contentAsset(assetsDirectory, "frontend", "html", frontendBytes);
  const bootstrap = {
    document: await stableAsset(RELEASE_BOOTSTRAP_URLS.document, bootstrapDocumentBytes),
    releaseModule: await stableAsset(
      RELEASE_BOOTSTRAP_URLS.releaseModule,
      bootstrapReleaseModuleBytes,
    ),
    serviceWorker: await stableAsset(
      RELEASE_BOOTSTRAP_URLS.serviceWorker,
      bootstrapServiceWorkerBytes,
    ),
  };
  const release = {
    schema: RELEASE_SCHEMA,
    source,
    bootstrap,
    runtime,
    frontend,
    renderer,
    rollback: { release: rollback.release },
  };
  release.releaseId = await sha256Hex(JSON.stringify(releaseIdentityPayload(release)));
  await validateRelease(release);
  await copyVerifiedRollbackAssets(rollback, output);
  for (const asset of rollbackReleaseAssets(release)) {
    await verifyAssetBytes(asset, await readFile(join(output, asset.url.slice(1))));
  }

  await Promise.all([
    ...STATIC_FILES.map(file => copyFile(join(webDirectory, file), join(output, file))),
    ...Object.entries(bootstrap).map(([name, descriptor]) => {
      const bytes = {
        document: bootstrapDocumentBytes,
        releaseModule: bootstrapReleaseModuleBytes,
        serviceWorker: bootstrapServiceWorkerBytes,
      }[name];
      return writeFile(join(output, descriptor.url.slice(1)), bytes);
    }),
  ]);
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
    writeFile(join(output, "_redirects"), cloudflareRedirects()),
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
      "--core": "corePath",
      "--dispatcher": "dispatcherPath",
      "--coordinator": "coordinatorPath",
      "--rollback-release": "rollbackReleasePath",
      "--rollback-directory": "rollbackDirectory",
      "--output": "outputPath",
      "--commit": "commit",
      "--repository": "repository",
    }[name];
    check(key !== undefined, `unknown argument ${name}`);
    options[key] = value;
  }
  for (const key of [
    "appPath",
    "corePath",
    "dispatcherPath",
    "coordinatorPath",
    "rollbackReleasePath",
    "outputPath",
    "commit",
  ]) {
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
