#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  validatePublicWarioWareSmokeEvidence,
} from "./browser_public_warioware_smoke.mjs";

function validEvidence() {
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
    frameUrl: "https://gekko.free/app.html?scenario=smb-ready-play",
    publicUrl: "https://gekko.free/?scenario=smb-ready-play",
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
  };
}

test("public WarioWare smoke accepts a healthy release snapshot with stale SMB query", () => {
  const evidence = validEvidence();
  assert.strictEqual(validatePublicWarioWareSmokeEvidence(evidence), evidence);
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
