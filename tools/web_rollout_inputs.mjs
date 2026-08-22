#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const RELEASE_ID = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function checkOrigin(value, label) {
  const url = new URL(value);
  check(url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === "",
    `${label} must be an exact HTTPS origin`);
  check(url.username === "" && url.password === "", `${label} must not contain credentials`);
}

export function validateRolloutInputs(options) {
  const action = options.action;
  check(["canary", "promote", "rollback"].includes(action), "action must be canary, promote, or rollback");
  check(RELEASE_ID.test(options.expectedRollbackReleaseId ?? ""),
    "expected rollback release ID is required and must be lowercase SHA-256");
  checkOrigin(options.canaryOrigin, "canary origin");
  checkOrigin(options.productionOrigin, "production origin");
  if (action === "canary") {
    check(COMMIT.test(options.checkedOutCommit ?? ""), "checked-out canary commit is invalid");
    check(options.expectedReleaseId === "", "canary release ID is derived from the built manifest");
    check(options.canaryRunId === "", "canary must not accept a canary run ID");
    check(options.fidelityRunId === "", "canary must not accept a fidelity evidence run ID");
    const initialRollback = options.rollbackVersionId !== "";
    const inheritedRollback = options.rollbackMetadataRunId !== "";
    check(initialRollback !== inheritedRollback,
      "canary requires exactly one rollback version ID or prior rollback metadata run ID");
    if (initialRollback) {
      check(VERSION_ID.test(options.rollbackVersionId), "canary rollback Cloudflare version ID is invalid");
    } else {
      check(RUN_ID.test(options.rollbackMetadataRunId), "prior rollback metadata run ID is invalid");
    }
  } else if (action === "promote") {
    check(COMMIT.test(options.checkedOutCommit ?? ""), "checked-out promotion commit is invalid");
    check(RELEASE_ID.test(options.expectedReleaseId ?? ""), "promotion release ID is invalid");
    check(RUN_ID.test(options.canaryRunId ?? ""), "promotion canary run ID is invalid");
    check(RUN_ID.test(options.fidelityRunId ?? ""),
      "promotion fidelity evidence run ID is invalid");
    check(options.fidelityRunId !== options.canaryRunId,
      "promotion canary and fidelity evidence run IDs must be distinct");
    check(options.rollbackVersionId === "", "promotion must not accept a rollback version ID");
    check(options.rollbackMetadataRunId === "",
      "promotion rollback metadata must come from the canary run");
  } else {
    check(COMMIT.test(options.checkedOutCommit ?? ""), "checked-out rollback commit is invalid");
    check(RELEASE_ID.test(options.expectedReleaseId ?? ""), "current schema-4 release ID is invalid");
    check(RUN_ID.test(options.canaryRunId ?? ""), "rollback canary run ID is invalid");
    check(options.fidelityRunId === "",
      "rollback must not accept a fidelity evidence run ID");
    check(options.rollbackVersionId === "",
      "rollback version ID must come from authenticated canary metadata");
    check(options.rollbackMetadataRunId === "",
      "rollback metadata must come from the canary run");
  }
  return Object.freeze({ ...options });
}

export function validateFidelityCaptureDispatchInputs(options) {
  check(RUN_ID.test(options.canaryRunId ?? ""), "capture canary run ID is invalid");
  check(RELEASE_ID.test(options.expectedReleaseId ?? ""), "capture release ID is invalid");
  check(COMMIT.test(options.expectedSourceCommit ?? ""), "capture source commit is invalid");
  check(
    typeof options.gamesRoot === "string"
      && options.gamesRoot.startsWith("/")
      && options.gamesRoot !== "/",
    "capture games root must be an absolute configured path");
  check(
    typeof options.chromeBinary === "string"
      && options.chromeBinary.startsWith("/")
      && options.chromeBinary !== "/",
    "capture Chrome binary must be an absolute configured path",
  );
  return Object.freeze({ ...options });
}

function parseArguments(arguments_) {
  const options = {
    action: arguments_[0],
    canaryRunId: process.env.WEB_ROLLOUT_CANARY_RUN_ID ?? "",
    fidelityRunId: process.env.WEB_ROLLOUT_FIDELITY_RUN_ID ?? "",
    rollbackMetadataRunId: process.env.WEB_ROLLOUT_ROLLBACK_METADATA_RUN_ID ?? "",
    expectedReleaseId: process.env.WEB_ROLLOUT_EXPECTED_RELEASE_ID ?? "",
    expectedRollbackReleaseId: process.env.WEB_ROLLOUT_EXPECTED_ROLLBACK_RELEASE_ID ?? "",
    rollbackVersionId: process.env.WEB_ROLLOUT_ROLLBACK_VERSION_ID ?? "",
    checkedOutCommit: process.env.WEB_ROLLOUT_CHECKED_OUT_COMMIT ?? "",
    canaryOrigin: process.env.WEB_ROLLOUT_CANARY_ORIGIN ?? "",
    productionOrigin: process.env.WEB_ROLLOUT_PRODUCTION_ORIGIN ?? "",
  };
  check(arguments_.length === 1, "usage: web_rollout_inputs.mjs <canary|promote|rollback>");
  return options;
}

function parseCaptureArguments(arguments_) {
  check(arguments_.length === 1 && arguments_[0] === "capture", "usage: web_rollout_inputs.mjs capture");
  return {
    canaryRunId: process.env.WEB_FIDELITY_CANARY_RUN_ID ?? "",
    expectedReleaseId: process.env.WEB_FIDELITY_EXPECTED_RELEASE_ID ?? "",
    expectedSourceCommit: process.env.WEB_FIDELITY_EXPECTED_SOURCE_COMMIT ?? "",
    gamesRoot: process.env.LAZULI_GAMES_ROOT ?? "",
    chromeBinary: process.env.LAZULI_CHROME_BINARY ?? "",
  };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const arguments_ = process.argv.slice(2);
    const result = arguments_[0] === "capture"
      ? validateFidelityCaptureDispatchInputs(parseCaptureArguments(arguments_))
      : validateRolloutInputs(parseArguments(arguments_));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`web_rollout_inputs: ${error.message}\n`);
    process.exitCode = 1;
  }
}
