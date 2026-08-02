// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { withoutDebugUi } from "./build_web.mjs";

const [browserHarness, publicShell] = await Promise.all([
  readFile(
    new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../web/index.html", import.meta.url), "utf8"),
]);

function sourceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
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

test("each browser document publishes one fresh read-only capture identity", () => {
  for (const [name, source] of [
    ["public shell", publicShell],
    ["immutable frontend", browserHarness],
  ]) {
    assert.equal(
      source.match(/const documentId = crypto\.randomUUID\(\);/g)?.length,
      1,
      `${name} must generate its identity exactly once`,
    );
    assert.equal(
      source.match(/document\.body\.dataset\.documentId = documentId;/g)?.length,
      1,
      `${name} must publish its identity exactly once`,
    );
    assert.doesNotMatch(source, /documentId\s*\?\?|randomUUID\?\./);
  }
});

test("debug and release frontends retain stable IAB action locators", () => {
  const locators = [
    ["disc-file", "disc-upload"],
    ["controller-left", "controller-left"],
    ["controller-up", "controller-up"],
    ["controller-down", "controller-down"],
    ["controller-right", "controller-right"],
    ["controller-a", "controller-a"],
    ["controller-b", "controller-b"],
    ["controller-start", "controller-start"],
  ];
  for (const [id, testId] of locators) {
    assert.match(
      browserHarness,
      new RegExp(`id="${id}" data-testid="${testId}"`),
    );
  }
  assert.match(
    browserHarness,
    /id="snapshot-runner" data-testid="diagnostics-capture"/,
  );

  const releaseFrontend = withoutDebugUi(browserHarness);
  for (const [id, testId] of locators) {
    assert.match(
      releaseFrontend,
      new RegExp(`id="${id}" data-testid="${testId}"`),
    );
  }
  assert.doesNotMatch(releaseFrontend, /id="snapshot-runner"/);
  assert.match(
    releaseFrontend,
    /captureDiagnosticsButton\.dataset\.testid = "diagnostics-capture";/,
  );
  assert.ok(
    releaseFrontend.indexOf("captureDiagnosticsButton.dataset.testid")
      < releaseFrontend.indexOf("await initBrowserRenderer()"),
    "the diagnostics locator must exist even when WebGPU initialization fails",
  );
});

test("worker-run identity advances only after a worker is established", () => {
  assert.equal(browserHarness.match(/let workerRunSequence = 0;/g)?.length, 1);
  assert.equal(
    browserHarness.match(/document\.body\.dataset\.workerRunId =/g)?.length,
    1,
  );

  const startWorker = sourceFunction(browserHarness, "startWorker");
  const workerCreated = startWorker.indexOf("worker = new Worker(");
  const identityAdvanced = startWorker.indexOf("workerRunSequence += 1;");
  const identityPublished = startWorker.indexOf(
    "document.body.dataset.workerRunId = String(workerRunSequence);",
  );
  assert.ok(workerCreated >= 0);
  assert.ok(identityAdvanced > workerCreated);
  assert.ok(identityPublished > identityAdvanced);
});

test("public shell exposes the exact selected immutable release", () => {
  const exposeSource = sourceFunction(publicShell, "exposeSelectedRelease");
  const document = { body: { dataset: {} } };
  const exposeSelectedRelease = Function(
    "document",
    `"use strict"; ${exposeSource}; return exposeSelectedRelease;`,
  )(document);
  const release = {
    releaseId: "release-identity",
    source: { commit: "0123456789abcdef0123456789abcdef01234567" },
  };
  const frontendUrl = new URL(
    "https://gekko.free/assets/frontend-immutable.html",
  );
  exposeSelectedRelease(release, frontendUrl);
  assert.deepEqual(document.body.dataset, {
    releaseId: release.releaseId,
    sourceCommit: release.source.commit,
    frontendUrl: frontendUrl.href,
  });

  const launch = sourceFunction(publicShell, "launch");
  const selected = launch.indexOf("const release = selected.release;");
  const strippedHash = launch.indexOf('url.hash = "";');
  const exposed = launch.indexOf("exposeSelectedRelease(release, url);");
  const launched = launch.indexOf("app.src = url.href;");
  assert.ok(selected >= 0);
  assert.ok(strippedHash > selected);
  assert.ok(exposed > strippedHash);
  assert.ok(launched > exposed);
});
