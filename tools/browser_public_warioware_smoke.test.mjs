#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredPublicWarioWareUrl,
  validatePublicWarioWareSmokeEvidence,
} from "./browser_public_warioware_smoke.mjs";

function activeRelease() {
  return {
    schema: 2,
    releaseId: "1".repeat(64),
    commit: "2".repeat(40),
    frontend: {
      url: `/assets/frontend-${"b".repeat(64)}.html`,
      sha256: "b".repeat(64),
      bytes: 1_000,
    },
  };
}

function validEvidence() {
  const release = activeRelease();
  return {
    schema: "lazuli-public-warioware-smoke-v1",
    dataset: { renderer: "wgpu-webgpu", status: "running" },
    devtoolsExceptions: [],
    discImage: {
      algorithm: "sha256",
      format: "ciso",
      sha256: "a".repeat(64),
    },
    discStatus: "local: WarioWare, Inc. - Mega Party Game$! (USA).ciso",
    frameUrl: `https://gekko.free/assets/frontend-${"b".repeat(64)}.html?scenario=smb-ready-play`,
    publicUrl: "https://gekko.free/?scenario=smb-ready-play",
    release,
    report: {
      status: "running",
      stage: "snapshot",
      cycles: 12_000_000,
      dispatches: 40_000,
      instructions: 9_000_000,
      disc: {
        identifier: "GZWE01",
        revision: 0,
        source: { kind: "local-file" },
      },
      rendering: { backend: "wgpu-webgpu" },
      scenario: null,
    },
    surface: "release",
    terminalRelease: structuredClone(release),
  };
}

test("public WarioWare smoke accepts a healthy release snapshot with stale SMB query", () => {
  const evidence = validEvidence();
  assert.strictEqual(validatePublicWarioWareSmokeEvidence(evidence), evidence);
});

test("public WarioWare runtime accepts only the exact production root", () => {
  assert.equal(
    configuredPublicWarioWareUrl("https://gekko.free/"),
    "https://gekko.free/?scenario=smb-ready-play",
  );
  for (const publicRoot of [
    "http://gekko.free/",
    "https://localhost/",
    "https://user@gekko.free/",
    "https://gekko.free:8443/",
  ]) {
    assert.throws(
      () => configuredPublicWarioWareUrl(publicRoot),
      /exact production origin https:\/\/gekko\.free/,
      publicRoot,
    );
  }
});

test("public WarioWare smoke rejects the mutable app path with the exact scenario query", () => {
  const evidence = validEvidence();
  evidence.frameUrl = "https://gekko.free/app.html?scenario=smb-ready-play";
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(evidence),
    /\$\.frameUrl: expected a content-addressed immutable frontend path/,
  );
});

test("public WarioWare smoke binds its same-origin iframe to the active release", () => {
  const crossOrigin = validEvidence();
  crossOrigin.frameUrl =
    `https://example.com/assets/frontend-${"b".repeat(64)}.html?scenario=smb-ready-play`;
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(crossOrigin),
    /\$\.frameUrl: expected exact production origin https:\/\/gekko\.free/,
  );

  const wrongAsset = validEvidence();
  wrongAsset.frameUrl =
    `https://gekko.free/assets/frontend-${"c".repeat(64)}.html?scenario=smb-ready-play`;
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(wrongAsset),
    /\$\.frameUrl: does not match the active release frontend identity/,
  );

  const changedRelease = validEvidence();
  changedRelease.terminalRelease.releaseId = "f".repeat(64);
  assert.throws(
    () => validatePublicWarioWareSmokeEvidence(changedRelease),
    /\$\.terminalRelease: active release changed/,
  );
});

test("public WarioWare smoke rejects scenario leakage and unhealthy evidence", () => {
  const cases = [
    ["top query", value => { value.publicUrl = "https://gekko.free/"; }, /\$\.publicUrl/],
    ["frame query", value => { value.frameUrl = "https://gekko.free/app.html"; }, /\$\.frameUrl/],
    ["surface", value => { value.surface = "debug"; }, /\$\.surface/],
    ["dataset status", value => { value.dataset.status = "stopped"; }, /\$\.dataset\.status/],
    ["dataset renderer", value => { value.dataset.renderer = "fallback"; }, /\$\.dataset\.renderer/],
    ["DevTools", value => { value.devtoolsExceptions.push({ text: "boom" }); }, /devtoolsExceptions\[0\]/],
    ["disc format", value => { value.discImage.format = "iso"; }, /\$\.discImage/],
    ["report status", value => { value.report.status = "stopped"; }, /\$\.report:/],
    ["report stage", value => { value.report.stage = "scenario-failed"; }, /\$\.report:/],
    ["terminal error", value => { value.report.error = "boom"; }, /\$\.report\.error/],
    ["scenario", value => { value.report.scenario = { id: "smb-ready-play" }; }, /\$\.report\.scenario/],
    ["disc", value => { value.report.disc.identifier = "GMBE8P"; }, /disc\.identifier/],
    ["disc revision", value => { value.report.disc.revision = 1; }, /disc\.revision/],
    ["disc source", value => { value.report.disc.source.kind = "http-range"; }, /disc\.source\.kind/],
    ["renderer", value => { value.report.rendering.backend = "fallback"; }, /rendering\.backend/],
    ["renderer error", value => { value.report.rendering.error = "lost"; }, /rendering\.error/],
    ["progress", value => { value.report.instructions = 0; }, /report\.instructions/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.throws(
      () => validatePublicWarioWareSmokeEvidence(evidence),
      pattern,
      label,
    );
  }
});

test("public WarioWare smoke reuses the shared iframe transport", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./browser_public_warioware_smoke.mjs", import.meta.url), "utf8"));
  assert.match(source, /from "\.\/browser_public_cdp\.mjs"/);
  assert.doesNotMatch(source, /createUncompressedDevToolsSocket|class DevToolsSession/);
});
