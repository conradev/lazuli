#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import {
  PUBLIC_SMB_SUSTAINED_SCHEMA,
  configuredPublicSmbSustainedUrl,
  parsePublicSmbSustainedArguments,
  validatePublicSmbSustainedEnvelope,
  validatePublicSmbSustainedEvidence,
} from "./browser_public_smb_sustained.mjs";

const COMMIT = "1".repeat(40);
const RELEASE_ID = "2".repeat(64);
const FRONTEND_HASH = "3".repeat(64);
const TOP_LOADER = "top-loader";
const FRAME_URL =
  `https://gekko.free/assets/frontend-${FRONTEND_HASH}.html?scenario=smb-sustained-play`;

function releaseIdentity() {
  return {
    schema: 2,
    releaseId: RELEASE_ID,
    commit: COMMIT,
    frontend: {
      url: `/assets/frontend-${FRONTEND_HASH}.html`,
      sha256: FRONTEND_HASH,
      bytes: 1_000,
    },
    renderer: {
      javascript: { url: "/renderer.js", sha256: "4".repeat(64), bytes: 2_000 },
      wasm: { url: "/renderer.wasm", sha256: "5".repeat(64), bytes: 3_000 },
    },
    backend: { url: "/backend.wasm", sha256: "6".repeat(64), bytes: 4_000 },
  };
}

function navigationIdentity() {
  return {
    top: {
      frameId: "top-frame",
      loaderId: TOP_LOADER,
      url: "https://gekko.free/?scenario=smb-sustained-play",
    },
    iframe: {
      frameId: "release-frame",
      loaderId: "release-loader",
      url: FRAME_URL,
    },
  };
}

function validEnvelope() {
  const release = releaseIdentity();
  const navigation = navigationIdentity();
  return {
    schema: PUBLIC_SMB_SUSTAINED_SCHEMA,
    expected: { commit: COMMIT, releaseId: RELEASE_ID },
    publicUrl: "https://gekko.free/?scenario=smb-sustained-play",
    release,
    terminalRelease: structuredClone(release),
    navigation: {
      expectedTopLoaderId: TOP_LOADER,
      expectedFrameUrl: FRAME_URL,
      before: navigation,
      after: structuredClone(navigation),
    },
    discImage: structuredClone(SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image),
    discStatus: "local: Super Monkey Ball (USA).ciso",
    dataset: { renderer: "wgpu-webgpu", status: "paused" },
    frameUrl: FRAME_URL,
    surface: "release",
    devtoolsExceptions: [],
    report: {},
    oracle: {},
  };
}

test("public sustained route accepts only the exact production root", () => {
  assert.equal(
    configuredPublicSmbSustainedUrl("https://gekko.free/"),
    "https://gekko.free/?scenario=smb-sustained-play",
  );
  for (const value of [
    "http://gekko.free/",
    "https://localhost/",
    "https://user@gekko.free/",
    "https://gekko.free:8443/",
    "https://gekko.free/app.html",
    "https://gekko.free/?scenario=smb-ready-play",
  ]) {
    assert.throws(
      () => configuredPublicSmbSustainedUrl(value),
      /invalid public SMB sustained evidence at --url/,
      value,
    );
  }
});

test("public sustained CLI requires exact commit and release pins", () => {
  const options = parsePublicSmbSustainedArguments([
    "--disc", "Super Monkey Ball (USA).ciso",
    "--url", "https://gekko.free/",
    "--expect-commit", COMMIT,
    "--expect-release-id", RELEASE_ID,
    "--poll-ms", "25",
  ]);
  assert.equal(options.expectCommit, COMMIT);
  assert.equal(options.expectReleaseId, RELEASE_ID);
  assert.equal(options.pollMs, 25);
  assert.equal(options.publicUrl, "https://gekko.free/?scenario=smb-sustained-play");

  assert.throws(
    () => parsePublicSmbSustainedArguments([
      "--disc", "game.ciso",
      "--url", "https://gekko.free/",
      "--expect-commit", "deadbeef",
      "--expect-release-id", RELEASE_ID,
    ]),
    /--expect-commit is required/,
  );
});

test("public sustained envelope pins release, loaders, WebGPU, and canonical SMB", () => {
  const evidence = validEnvelope();
  assert.strictEqual(validatePublicSmbSustainedEnvelope(evidence), evidence);
});

test("public sustained envelope rejects release and navigation drift", () => {
  const cases = [
    [
      "expected commit",
      value => { value.release.commit = "f".repeat(40); },
      /\$\.release\.commit/,
    ],
    [
      "terminal release",
      value => { value.terminalRelease.frontend.bytes += 1; },
      /\$\.terminalRelease: active release changed/,
    ],
    [
      "top loader",
      value => { value.navigation.after.top.loaderId = "new-loader"; },
      /\$\.navigation\.after\.top/,
    ],
    [
      "iframe URL",
      value => { value.navigation.after.iframe.url = "https://gekko.free/app.html"; },
      /\$\.navigation\.after\.iframe/,
    ],
    [
      "active frontend",
      value => { value.frameUrl = "https://gekko.free/app.html"; },
      /\$\.frameUrl/,
    ],
  ];
  for (const [label, mutate, pattern] of cases) {
    const evidence = validEnvelope();
    mutate(evidence);
    assert.throws(
      () => validatePublicSmbSustainedEnvelope(evidence),
      pattern,
      label,
    );
  }
});

test("public sustained envelope rejects fallback, exceptions, and wrong discs", () => {
  const cases = [
    ["status", value => { value.dataset.status = "running"; }, /dataset\.status/],
    ["fallback", value => { value.dataset.renderer = "webgl"; }, /dataset\.renderer/],
    ["surface", value => { value.surface = "debug"; }, /\$\.surface/],
    [
      "exception",
      value => { value.devtoolsExceptions.push({ description: "boom" }); },
      /devtoolsExceptions\[0\]/,
    ],
    ["disc", value => { value.discImage.sha256 = "0".repeat(64); }, /\$\.discImage/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const evidence = validEnvelope();
    mutate(evidence);
    assert.throws(
      () => validatePublicSmbSustainedEnvelope(evidence),
      pattern,
      label,
    );
  }
});

test("public sustained evidence delegates the terminal report to the strict oracle", () => {
  const evidence = validEnvelope();
  evidence.report = {
    disc: {
      identifier: "GMBE8P",
      revision: 0,
      source: { kind: "local-file" },
    },
    rendering: { backend: "wgpu-webgpu", error: null },
  };
  assert.throws(
    () => validatePublicSmbSustainedEvidence(evidence),
    /SMB sustained PLAY invariant at \$\.status/,
  );
});

test("public sustained harness derives the transcript and does not mutate cadence", async () => {
  const source = await readFile(
    new URL("./browser_public_smb_sustained.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /deriveSmbReadyPlayGameplayTranscript/);
  assert.match(source, /verifySmbSustainedPlay\(report\)/);
  assert.match(source, /observePinnedNavigation/);
  assert.match(source, /observePublicActiveRelease\(session, options, release\)/);
  assert.doesNotMatch(source, /renderEvery|viewportCapture|startScreencast/);
});
