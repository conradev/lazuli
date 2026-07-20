// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("deployment serves static assets without a request handler", async () => {
  const wrangler = await readFile(new URL("../web/wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /^main\s*=/m);
  assert.match(wrangler, /^\[assets\]$/m);
  assert.match(wrangler, /^html_handling\s*=\s*"auto-trailing-slash"$/m);
});

test("deployment pins the verified Wrangler release", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^\s+wranglerVersion:\s*"4\.112\.0"$/m);
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
