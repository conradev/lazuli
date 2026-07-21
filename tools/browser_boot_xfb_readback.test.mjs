// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `missing ${name}`);
  const start = source.slice(functionStart - 6, functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function evaluate(names, values = {}) {
  const context = {
    Array,
    Error,
    Number,
    Object,
    Promise,
    Set,
    String,
    Uint8Array,
    crypto: webcrypto,
    ...values,
  };
  vm.createContext(context);
  vm.runInContext(names.map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.xfb-readback.js",
  });
  return context;
}

test("presented XFB color statistics classify exact RGB values", () => {
  const context = evaluate(["summarizePresentedXfbRgba"]);
  const pixels = new Uint8Array([
    0, 0, 0, 0,
    255, 255, 255, 255,
    1, 2, 3, 255,
    1, 2, 3, 0,
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.summarizePresentedXfbRgba(pixels, 2, 2))),
    { black: 1, white: 1, other: 2, unique: 3 },
  );
  assert.throws(
    () => context.summarizePresentedXfbRgba(pixels.subarray(0, 12), 2, 2),
    /invalid tight RGBA8 layout/,
  );
});

test("presented XFB SHA-256 covers alpha and every tight RGBA byte", async () => {
  const context = evaluate(["sha256Hex"]);
  const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(
    await context.sha256Hex(pixels),
    createHash("sha256").update(pixels).digest("hex"),
  );
  const alphaChanged = pixels.slice();
  alphaChanged[3] = 9;
  assert.notEqual(await context.sha256Hex(alphaChanged), await context.sha256Hex(pixels));
});

test("selected XFB capture waits behind renderer work and returns compact diagnostics", async () => {
  const calls = [];
  let releaseRenderer;
  const rendererOperationTail = new Promise(resolve => { releaseRenderer = resolve; });
  const rgba = new Uint8Array([
    0, 0, 0, 255,
    12, 34, 56, 255,
  ]);
  const context = evaluate(
    [
      "enqueueRendererOperation",
      "sha256Hex",
      "summarizePresentedXfbRgba",
      "captureSelectedXfb",
    ],
    {
      drainWebGpuRenderer() { calls.push("drain"); },
      rendererOperationTail,
      webGpuRenderer: {
        has_presented_xfb() { calls.push("has"); return true; },
        read_presented_xfb_rgba() {
          calls.push("read");
          return {
            address: 0x01200500,
            generation: 7,
            row: 1,
            format: "rgba8unorm",
            layout: "top-left-row-major-tight",
            sourceRow: 1,
            width: 2,
            height: 1,
            textureWidth: 2,
            textureHeight: 2,
            logicalWidth: 2,
            logicalHeight: 2,
            displayWidth: 640,
            displayHeight: 480,
            rgba,
          };
        },
      },
    },
  );

  const pending = context.captureSelectedXfb();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  releaseRenderer();
  const capture = await pending;
  assert.deepEqual(calls, ["drain", "has", "read"]);
  assert.equal(capture.address, "0x01200500");
  assert.equal(capture.rgbaByteLength, 8);
  assert.equal(capture.rgbaSha256, createHash("sha256").update(rgba).digest("hex"));
  assert.deepEqual(JSON.parse(JSON.stringify(capture.rgb)), {
    black: 1,
    white: 0,
    other: 1,
    unique: 2,
  });
  assert.equal("rgba" in capture, false);
});

test("selected XFB capture reports no image after a renderer reset", async () => {
  let reads = 0;
  const context = evaluate(
    [
      "enqueueRendererOperation",
      "sha256Hex",
      "summarizePresentedXfbRgba",
      "captureSelectedXfb",
    ],
    {
      drainWebGpuRenderer() {},
      rendererOperationTail: Promise.resolve(),
      webGpuRenderer: {
        has_presented_xfb() { return false; },
        read_presented_xfb_rgba() { reads += 1; },
      },
    },
  );
  assert.equal(await context.captureSelectedXfb(), null);
  assert.equal(reads, 0);
});
