#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  SMB_SUSTAINED_PLAY_SCHEMA_V3,
} from "./browser_boot_smb_sustained_play.mjs";
import {
  SMB_SUSTAINED_PRESENTED_SURFACE_DARK_CHANNEL_MAXIMUM,
  SMB_SUSTAINED_PRESENTED_SURFACE_EXTREME_PPM,
  SMB_SUSTAINED_PRESENTED_SURFACE_LIGHT_CHANNEL_MINIMUM,
  deriveSmbSustainedPresentedSurfaceHistoryOracle,
} from "./browser_boot_smb_sustained_surface_history.mjs";
import {
  smbSustainedPlayReport,
} from "./browser_boot_smb_sustained_play_test_fixture.mjs";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
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

test("browser and independent model derive identical sustained surface oracles", () => {
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V3);
  const frames = report.rendering.sustainedPresentedSurfaces.frames;
  const context = {
    smbSustainedPresentedSurfaceCapacity: 60,
    smbSustainedPresentedSurfaceExtremePpm:
      SMB_SUSTAINED_PRESENTED_SURFACE_EXTREME_PPM,
    smbSustainedPresentedSurfaceDarkChannelMaximum:
      SMB_SUSTAINED_PRESENTED_SURFACE_DARK_CHANNEL_MAXIMUM,
    smbSustainedPresentedSurfaceLightChannelMinimum:
      SMB_SUSTAINED_PRESENTED_SURFACE_LIGHT_CHANNEL_MINIMUM,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction("smbSustainedPresentedSurfaceNearExtreme"),
      extractFunction("summarizeSmbSustainedPresentedSurfaces"),
    ].join("\n\n"),
    context,
    { filename: "browser_boot.smb-sustained-surface-history.js" },
  );
  const browser = context.summarizeSmbSustainedPresentedSurfaces(
    structuredClone(frames),
  );
  const independent =
    deriveSmbSustainedPresentedSurfaceHistoryOracle(structuredClone(frames));
  assert.deepEqual(
    JSON.parse(JSON.stringify(browser)),
    independent,
  );
});

test("browser visual-extreme populations include almost black and white pixels", () => {
  const context = { Uint8Array };
  vm.createContext(context);
  vm.runInContext(
    extractFunction("summarizePresentedXfbVisualExtremes"),
    context,
    { filename: "browser_boot.smb-visual-extremes.js" },
  );
  const rgba = new Uint8Array([
    1, 1, 1, 255,
    8, 8, 8, 255,
    8, 8, 9, 255,
    246, 246, 246, 255,
    247, 247, 247, 255,
    254, 254, 254, 255,
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.summarizePresentedXfbVisualExtremes(rgba, 6, 1),
    )),
    { dark: 2, light: 2, other: 2 },
  );
});

test("terminal history capture drains once and never persists raw RGBA", () => {
  const reader = extractFunction("readSmbSustainedPresentedSurfaceHistory");
  assert.match(
    reader,
    /drain_sustained_presented_surface_history_rgba\(\)/,
  );
  assert.match(reader, /captures\[index\] = null/);
  assert.match(
    reader,
    /summarizePresentedSurfaceCapture\(\s*capture,[\s\S]*?false\s*\)/,
  );
  assert.doesNotMatch(reader, /presentedSurface:\s*\{[\s\S]*?\brgba\b/);

  const summarizer = extractFunction("summarizePresentedSurfaceCapture");
  assert.doesNotMatch(
    summarizer.slice(summarizer.indexOf("return {")),
    /\n {8}rgba,\n/,
  );
});
