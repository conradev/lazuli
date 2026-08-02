// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("deployment serves static assets without a request handler", async () => {
  const wrangler = await readFile(new URL("../web/wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /^main\s*=/m);
  assert.match(wrangler, /^\[assets\]$/m);
  assert.match(wrangler, /^html_handling\s*=\s*"auto-trailing-slash"$/m);
  assert.match(wrangler, /^not_found_handling\s*=\s*"none"$/m);
});

test("deployment pins the verified Wrangler release", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^\s+wranglerVersion:\s*"4\.112\.0"$/m);
});

test("deployment retains the public WarioWare release gate", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /^\s+tools\/browser_public_warioware_smoke\.test\.mjs$/m,
  );
});

test("deployment retains the private seven-game compatibility gates", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /^\s+tools\/browser_game_compatibility_\*\.test\.mjs$/m,
  );
});

test("deployment retains the layered first-playable transcript gates", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /^\s+tools\/browser_game_first_playable_\*\.test\.mjs$/m,
  );
});

test("deployment retains the passive public SMB observer gates", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  for (const path of [
    "tools/browser_public_cdp.test.mjs",
    "tools/browser_public_smb_screencast.test.mjs",
    "tools/browser_public_smb_screencast_oracle.test.mjs",
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${path.replaceAll(".", "\\.")}$`, "m"));
  }
});

test("deployment retains the sustained public SMB release gate", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /^\s+tools\/browser_public_smb_sustained\.test\.mjs$/m,
  );
});

test("deployment builds pinned wasm-bindgen browser renderer assets before the frontend", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /cargo build --release --target wasm32-unknown-unknown -p browser-renderer/,
  );
  assert.match(workflow, /cargo test -p browser-renderer/);
  assert.ok(
    workflow.indexOf("cargo test -p browser-renderer")
      < workflow.indexOf("cargo build --release --target wasm32-unknown-unknown -p browser-renderer"),
    "native renderer tests must pass before the wasm build",
  );
  assert.match(
    workflow,
    /cargo install --locked --version 0\.2\.114 wasm-bindgen-cli/,
  );
  assert.match(workflow, /--out-name browser_renderer/);
  assert.match(
    workflow,
    /target\/wasm32-unknown-unknown\/release\/browser_renderer\.wasm/,
  );
  assert.ok(
    workflow.indexOf("wasm-bindgen\n") < workflow.indexOf("Generate generic frontend"),
    "renderer bindings must be generated before the frontend",
  );
});

test("deployment validates the raw shared-memory DSP module before frontend generation", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  const nativeTest = "cargo test -p browser-dsp";
  const build = "cargo build --release --target wasm32-unknown-unknown -p browser-dsp";
  const validate =
    "node tools/browser_dsp_wasm_contract.mjs target/wasm32-unknown-unknown/release/browser_dsp.wasm";
  const packageArgument = "--dsp target/wasm32-unknown-unknown/release/browser_dsp.wasm";
  assert.match(workflow, new RegExp(nativeTest.replaceAll("-", "\\-")));
  assert.match(workflow, new RegExp(build.replaceAll("-", "\\-")));
  assert.match(workflow, new RegExp(validate.replaceAll(".", "\\.")));
  assert.match(workflow, new RegExp(packageArgument.replaceAll(".", "\\.")));
  assert.ok(workflow.indexOf(nativeTest) < workflow.indexOf(build));
  assert.ok(workflow.indexOf(build) < workflow.indexOf(validate));
  assert.ok(workflow.indexOf(validate) < workflow.indexOf("Generate generic frontend"));
  assert.ok(workflow.indexOf(validate) < workflow.indexOf(packageArgument));
});
