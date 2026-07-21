#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Worker } from "node:worker_threads";

const browserBootSource = readFileSync(new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
), "utf8");
const discRuntimeUrl = new URL(
  "../crates/ppcwasmjit/examples/browser_disc_source.mjs",
  import.meta.url,
).href;
const cisoHeaderSize = 0x8000;

function extractFunction(name) {
  const start = browserBootSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const bodyStart = browserBootSource.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  for (let index = bodyStart; index < browserBootSource.length; index += 1) {
    if (browserBootSource[index] === "{") depth += 1;
    if (browserBootSource[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return browserBootSource.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function writeAscii(bytes, offset, value) {
  bytes.set(new TextEncoder().encode(value), offset);
}

function makeBootableCiso() {
  const blockSize = 0x8000;
  const logicalBlocks = Array.from(
    { length: 5 },
    () => new Uint8Array(blockSize),
  );
  const logical = new Uint8Array(logicalBlocks.length * blockSize);
  const view = new DataView(logical.buffer);
  const bootOffset = 0x10000;
  const fstOffset = 0x22000;

  writeAscii(logical, 0, "GZLE01");
  logical[6] = 1;
  logical[7] = 2;
  writeAscii(logical, 0x20, "Delayed worker fixture");
  view.setUint32(0x1c, 0xc2339f3d, false);
  view.setUint32(0x420, bootOffset, false);
  view.setUint32(0x424, fstOffset, false);
  view.setUint32(0x428, 0x40, false);
  view.setUint32(0x42c, 0x80, false);

  const dol = new DataView(logical.buffer, bootOffset, 0x120);
  dol.setUint32(0x00, 0x100, false);
  dol.setUint32(0x48, 0x80004000, false);
  dol.setUint32(0x90, 0x20, false);
  dol.setUint32(0xd8, 0x80005000, false);
  dol.setUint32(0xdc, 0x40, false);
  dol.setUint32(0xe0, 0x80004000, false);
  logical.fill(0x5a, bootOffset + 0x100, bootOffset + 0x120);
  logical.fill(0x46, fstOffset, fstOffset + 0x40);

  for (let index = 0; index < logicalBlocks.length; index += 1) {
    logicalBlocks[index].set(logical.subarray(index * blockSize, (index + 1) * blockSize));
  }
  const present = [true, false, true, false, true];
  const header = new Uint8Array(cisoHeaderSize);
  writeAscii(header, 0, "CISO");
  new DataView(header.buffer).setUint32(4, blockSize, true);
  for (let index = 0; index < present.length; index += 1) {
    header[index + 8] = present[index] ? 1 : 0;
  }
  return new File(
    [header, ...logicalBlocks.filter((_block, index) => present[index])],
    "WarioWare, Inc. - Mega Party Game$! (USA).ciso",
    { type: "application/octet-stream" },
  );
}

const workerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const messageWrappers = new Map();
  globalThis.discSourceConfig = { kind: "file-message" };
  globalThis.addEventListener = (type, listener) => {
    const wrapped = data => listener({ data });
    messageWrappers.set(listener, wrapped);
    parentPort.on(type, wrapped);
  };
  globalThis.removeEventListener = (type, listener) => {
    const wrapped = messageWrappers.get(listener);
    if (wrapped === undefined) return;
    messageWrappers.delete(listener);
    parentPort.off(type, wrapped);
  };

  (async () => {
    const started = performance.now();
    await new Promise(resolve => setTimeout(resolve, workerData.startupDelayMs));
    const configuredDiscSource = eval("(" + workerData.configuredDiscSource + ")");
    const config = await configuredDiscSource();
    const { openDiscSource, readDiscBoot } = await import(workerData.discRuntimeUrl);
    const source = await openDiscSource(config);
    const boot = await readDiscBoot(source);
    parentPort.postMessage({
      boot: {
        identifier: boot.identifier,
        label: boot.label,
        version: boot.version,
      },
      fileIsBlob: config.file instanceof Blob,
      fileSize: config.file.size,
      listenerDelayMs: performance.now() - started,
      source: source.describe(),
    });
  })().catch(error => {
    parentPort.postMessage({ error: error.stack || String(error) });
  });
`;

test("a selected File survives delayed worker startup and reaches CISO boot parsing", async (t) => {
  assert.match(
    browserBootSource,
    /workerUrl = URL\.createObjectURL\(new Blob\(\[bootstrap, "\\n", source\]/,
  );
  assert.match(
    browserBootSource,
    /worker\.postMessage\(\{ type: "disc-source-file", file: discConfig\.file \}\)/,
  );

  const file = makeBootableCiso();
  const startupDelayMs = 40;
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      configuredDiscSource: extractFunction("configuredDiscSource"),
      discRuntimeUrl,
      startupDelayMs,
    },
  });
  t.after(() => worker.terminate());

  const resultPromise = new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", resolve);
  });
  // Match the public page: post the browser File immediately, before the
  // module worker has installed its disc-source listener.
  worker.postMessage({ type: "disc-source-file", file });

  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("delayed File handoff timed out")),
      2_000,
    );
  });
  const result = await Promise.race([resultPromise, timeoutPromise])
    .finally(() => clearTimeout(timeout));
  assert.equal(result.error, undefined);
  assert.equal(result.listenerDelayMs >= startupDelayMs - 5, true);
  assert.equal(result.fileIsBlob, true);
  assert.equal(result.fileSize, file.size);
  assert.deepEqual(result.boot, {
    identifier: "GZLE01",
    label: "Delayed worker fixture (GZLE01 Rev.02)",
    version: 2,
  });
  assert.equal(result.source.kind, "local-file");
  assert.equal(result.source.format, "ciso");
  assert.equal(result.source.blockSize, 0x8000);
});
