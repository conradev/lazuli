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
const STATIC_FILES = ["index.html", "app.webmanifest", "icon.svg", "release.mjs", "sw.js"];

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

function licensedFrontend(html, source) {
  const sourceAnchor = '<a href="https://github.com/conradev/lazuli" target="_blank" rel="source noopener">Source</a>';
  check(html.includes(sourceAnchor), "generated frontend does not contain the expected source link");
  check(html.includes('new URL("/ppcwasmjit.wasm", location.href)'), "generated frontend has no browser compiler URL");
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
  const output = outputDirectory(options.outputPath);
  const repository = (options.repository ?? DEFAULT_REPOSITORY).replace(/\/$/, "");
  const commit = options.commit;
  check(COMMIT_PATTERN.test(commit), "--commit must be a lowercase 40-character Git commit");
  check(repository === DEFAULT_REPOSITORY, `unsupported source repository ${repository}`);

  const source = sourceMetadata(repository, commit);
  const [generatedHtml, wasm] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(wasmPath),
  ]);
  check(wasm.byteLength > 0, "browser compiler is empty");

  await rm(output, { recursive: true, force: true });
  const assetsDirectory = join(output, "assets");
  await mkdir(assetsDirectory, { recursive: true });

  const frontendBytes = new TextEncoder().encode(licensedFrontend(generatedHtml, source));
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
  const release = { schema: RELEASE_SCHEMA, source, frontend, backend };
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
