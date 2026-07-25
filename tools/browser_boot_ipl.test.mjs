#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");
const imageBytes = 2 * 1024 * 1024;
const palHeader =
  "(C) 1999-2001 Nintendo.  All rights reserved."
  + "(C) 1999 ArtX Inc.  All rights reserved."
  + "PAL  Revision 1.0  ";

function extractFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  if (source.slice(start - 6, start) === "async ") start -= 6;
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated body for ${name}`);
}

function makeDecoderContext() {
  const context = {
    Blob,
    Object,
    RangeError,
    TypeError,
    Uint8Array,
    localIplImageBytes: imageBytes,
    palIplHeader: palHeader,
    selectedLocalIpl: null,
    activeDiscConfig: null,
    activeDiscLabel: null,
    workerStarts: [],
    startWorker(config, label) {
      context.workerStarts.push({ config, label });
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "hasPalIplHeader",
      "descrambleRetailIplRange",
      "decodeRetailIplImage",
      "readLocalIplFile",
      "activateLocalIpl",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.ipl-root.js" },
  );
  return context;
}

function makeWorkerBoundaryContext() {
  let listener = null;
  const context = {
    ArrayBuffer,
    Error,
    Object,
    RangeError,
    TypeError,
    Uint8Array,
    exiIplImageBytes: imageBytes,
    iplSourceConfig: { kind: "bundled-default" },
    addEventListener(type, receive) {
      assert.equal(type, "message");
      assert.equal(listener, null);
      listener = receive;
    },
    removeEventListener(type, receive) {
      assert.equal(type, "message");
      assert.equal(receive, listener);
      listener = null;
    },
    dispatch(message) {
      assert.notEqual(listener, null, "worker IPL listener was not installed");
      listener({ data: message });
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [
      "createBundledExiIplImage",
      "validateExiIplImage",
      "configuredExiIplImage",
    ].map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.ipl-worker.js" },
  );
  return context;
}

test("retail IPL decoding matches the Lazuli descrambler vector", () => {
  const context = makeDecoderContext();
  const input = new Uint8Array(imageBytes);
  const decoded = context.decodeRetailIplImage(input);

  assert.equal(decoded.region, "NTSC");
  assert.equal(decoded.decodedBytes, 0x15ee40 - 0x100);
  assert.deepEqual(
    Array.from(decoded.image.subarray(0x100, 0x120)),
    [
      0x89, 0x7e, 0x47, 0x7f, 0xf4, 0x42, 0x3f, 0xe2,
      0xa1, 0x44, 0x32, 0xa6, 0x30, 0x13, 0xbc, 0xd1,
      0xdc, 0x12, 0xe0, 0xcc, 0xa5, 0x65, 0x36, 0x8c,
      0xdf, 0x2a, 0xba, 0x9a, 0xef, 0x28, 0x83, 0xad,
    ],
  );
  assert.equal(input[0x100], 0, "decoder mutated the selected File bytes");
  assert.equal(decoded.image[0xff], 0);
  assert.equal(decoded.image[0x15ee40], 0);

  const roundtrip = context.decodeRetailIplImage(decoded.image);
  assert.deepEqual(
    Array.from(roundtrip.image.subarray(0x100, 0x120)),
    Array(32).fill(0),
  );
});

test("retail IPL decoding selects the PAL range from the exact C string", () => {
  const context = makeDecoderContext();
  const input = new Uint8Array(imageBytes);
  for (let index = 0; index < palHeader.length; index += 1) {
    input[index] = palHeader.charCodeAt(index);
  }
  input[palHeader.length] = 0;

  const decoded = context.decodeRetailIplImage(input);

  assert.equal(decoded.region, "PAL");
  assert.equal(decoded.decodedBytes, 0x1aeee8 - 0x100);
  assert.equal(decoded.image[0x1aeee8], 0);
});

test("retail IPL decoding rejects a header without a NUL terminator", () => {
  const context = makeDecoderContext();
  const input = new Uint8Array(imageBytes);
  input.fill(0xff);
  assert.throws(
    () => context.decodeRetailIplImage(input),
    /IPL header is not NUL-terminated/,
  );
});

test("local IPL reader rejects size before reading and never mutates selection", async () => {
  const context = makeDecoderContext();
  let read = false;
  class ObservedBlob extends Blob {
    async arrayBuffer() {
      read = true;
      return super.arrayBuffer();
    }
  }
  const invalid = new ObservedBlob([new Uint8Array(imageBytes - 1)]);

  await assert.rejects(
    context.readLocalIplFile(invalid),
    /IPL file must be exactly 2 MiB/,
  );
  assert.equal(read, false);
  assert.equal(context.selectedLocalIpl, null);
  assert.equal(context.workerStarts.length, 0);
});

test("local IPL selection persists before a disc and restarts the active disc", () => {
  const context = makeDecoderContext();
  const first = { image: new Uint8Array(imageBytes), region: "NTSC" };
  context.activateLocalIpl(first);

  assert.equal(context.selectedLocalIpl.image, first.image);
  assert.equal(context.selectedLocalIpl.region, "NTSC");
  assert.equal(context.workerStarts.length, 0);

  const discConfig = { kind: "file", file: { opaque: true } };
  context.activeDiscConfig = discConfig;
  context.activeDiscLabel = "local: game.ciso";
  const second = { image: new Uint8Array(imageBytes), region: "PAL" };
  context.activateLocalIpl(second);

  assert.equal(context.selectedLocalIpl.image, second.image);
  assert.equal(context.selectedLocalIpl.region, "PAL");
  assert.equal(context.workerStarts.length, 1);
  assert.equal(context.workerStarts[0].config, discConfig);
  assert.equal(context.workerStarts[0].label, "local: game.ciso");
});

test("worker IPL boundary accepts only an exact transferred image", async () => {
  const context = makeWorkerBoundaryContext();
  const pending = context.configuredExiIplImage({ kind: "file-message" });
  const buffer = new ArrayBuffer(imageBytes);
  context.dispatch({
    type: "ipl-source-image",
    image: buffer,
    region: "PAL",
  });
  const configured = await pending;

  assert.equal(configured.image.byteLength, imageBytes);
  assert.equal(configured.image.buffer, buffer);
  assert.deepEqual(
    JSON.parse(JSON.stringify(configured.source)),
    { kind: "local-file", region: "PAL" },
  );

  const invalidContext = makeWorkerBoundaryContext();
  const invalid = invalidContext.configuredExiIplImage({ kind: "file-message" });
  invalidContext.dispatch({
    type: "ipl-source-image",
    image: new ArrayBuffer(imageBytes - 1),
    region: "NTSC",
  });
  await assert.rejects(invalid, /must be exactly 2097152 bytes/);
});

test("bundled IPL font image is pinned, sparse, and route-free", () => {
  const japanese = readFileSync(
    new URL("../resources/ipl/font_japanese.bin", import.meta.url),
  );
  const western = readFileSync(
    new URL("../resources/ipl/font_western.bin", import.meta.url),
  );
  const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

  assert.equal(japanese.byteLength, 259_626);
  assert.equal(
    sha256(japanese),
    "38f9f59d505bc4e2d86b0196706195f33ad72b7fe9d029cf263072cde19d044f",
  );
  assert.equal(western.byteLength, 6_478);
  assert.equal(
    sha256(western),
    "4ad991be2b0aa305f09b90a79fc50f57833b30b008890b5ef1336cc3d9d0bae0",
  );
  assert.equal(japanese.subarray(0, 4).toString("ascii"), "Yay0");
  assert.equal(western.subarray(0, 4).toString("ascii"), "Yay0");

  assert.match(
    source,
    /const IPL_FONT_JAPANESE_OFFSET: usize = 0x1a_ff00;/,
  );
  assert.match(
    source,
    /const IPL_FONT_WESTERN_OFFSET: usize = 0x1f_cf00;/,
  );
  const bundledImage = extractFunction("createBundledExiIplImage");
  assert.match(bundledImage, /new Uint8Array\(exiIplImageBytes\)/);
  assert.match(bundledImage, /decode\("__IPL_FONT_JAPANESE__"\)/);
  assert.match(bundledImage, /decode\("__IPL_FONT_WESTERN__"\)/);
  assert.doesNotMatch(
    bundledImage,
    /\bfetch\b|new URL|localStorage|sessionStorage|\bcaches\b/,
  );
});

test("public root keeps the local-only IPL picker and transferable handoff", () => {
  const firstDebugMarker = source.indexOf("<!-- LAZULI DEBUG UI START -->");
  const picker = source.indexOf('id="ipl-file"');
  assert.notEqual(picker, -1);
  assert.ok(picker < firstDebugMarker, "IPL picker would be stripped from release UI");

  const reader = extractFunction("readLocalIplFile");
  assert.doesNotMatch(reader, /\bfetch\b|localStorage|sessionStorage|\bcaches\b/);
  assert.match(source, /globalThis\.iplSourceConfig =/);
  assert.match(source, /type:\s*"ipl-source-image"/);
  assert.match(source, /\}, \[workerImage\.buffer\]\);/);
  assert.match(
    source,
    /body:not\(\[data-status="waiting"\]\)[\s\S]*\.file-picker/,
  );
});
