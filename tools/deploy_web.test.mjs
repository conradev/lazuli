// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("deployment serves static assets without a request handler", async () => {
  const wrangler = await readFile(new URL("../web/wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /^main\s*=/m);
  assert.match(wrangler, /^\[assets\]$/m);
  assert.match(wrangler, /^html_handling\s*=\s*"none"$/m);
});

test("deployment pins the verified Wrangler release", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-web.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^\s+wranglerVersion:\s*"4\.112\.0"$/m);
});
