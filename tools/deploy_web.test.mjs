// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  validateFidelityCaptureDispatchInputs,
  validateRolloutInputs,
} from "./web_rollout_inputs.mjs";

const COMMIT = "b".repeat(40);
const RELEASE_ID = "a".repeat(64);
const ROLLBACK_RELEASE_ID = "c".repeat(64);
const VERSION_ID = "12345678-1234-4123-8123-123456789abc";

async function readWorkflow() {
  return readFile(new URL("../.github/workflows/deploy-web.yml", import.meta.url), "utf8");
}

async function readCaptureWorkflow() {
  return readFile(
    new URL("../.github/workflows/capture-web-fidelity.yml", import.meta.url),
    "utf8",
  );
}

function after(text, needle, offset = 0) {
  const index = text.indexOf(needle, offset);
  assert.notEqual(index, -1, `missing workflow fragment: ${needle}`);
  return index;
}

test("deployment serves static assets with version preview URLs and no request handler", async () => {
  const wrangler = await readFile(new URL("../web/wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /^main\s*=/m);
  assert.match(wrangler, /^preview_urls\s*=\s*true$/m);
  assert.match(wrangler, /^\[assets\]$/m);
  assert.match(wrangler, /^html_handling\s*=\s*"auto-trailing-slash"$/m);
  assert.match(wrangler, /^not_found_handling\s*=\s*"none"$/m);
});

test("release workflow is dispatch-only and every mutating job is production-gated", async () => {
  const workflow = await readWorkflow();
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /^\s+action:\n\s+description:.*\n\s+required: true\n\s+type: choice$/m);
  assert.match(workflow, /^\s+canary_run_id:$/m);
  assert.match(workflow, /^\s+fidelity_run_id:$/m);
  assert.match(workflow, /^\s+expected_rollback_release_id:$/m);
  assert.match(workflow, /^\s+rollback_metadata_run_id:$/m);
  assert.match(workflow, /^\s+rollback_version_id:$/m);
  assert.equal([...workflow.matchAll(/^\s+environment: production$/gm)].length, 3);
  assert.match(workflow, /^\s+actions: read$/m);
  assert.match(workflow, /^\s+group: release-gekko-free$/m);
  assert.match(workflow, /^\s+cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /release-gekko-free-\$\{\{/);
});

test("canary breaks the source-commit circularity and promotion consumes untracked evidence", async () => {
  const workflow = await readWorkflow();
  assert.doesNotMatch(workflow, /tools\/resident_machine_production_fidelity_attestation\.json/);

  const canary = after(workflow, "  canary:");
  const release = after(workflow, "Build immutable schema-4 release", canary);
  const upload = after(workflow, "Upload inactive Cloudflare version", canary);
  const artifact = after(workflow, "Persist full immutable candidate", upload);
  assert.ok(release < upload && upload < artifact);
  assert.doesNotMatch(workflow.slice(canary, after(workflow, "  promote:")), /--attestation/);
  assert.match(workflow.slice(artifact), /name: schema4-canary-candidate/);
  assert.match(workflow.slice(artifact), /^\s+web\/dist$/m);

  const promotion = after(workflow, "  promote:");
  const provenance = after(
    workflow,
    "Authenticate exact successful candidate and fidelity workflow runs",
    promotion,
  );
  const promotionDownload = after(workflow, "Download exact successful canary evidence", promotion);
  const fidelityDownload = after(
    workflow,
    "Download exact successful all-seven fidelity evidence",
    promotionDownload,
  );
  const promotionValidation = after(workflow, "Revalidate all-seven production fidelity attestation", promotion);
  const deploy = after(workflow, "versions deploy", promotion);
  assert.ok(provenance < promotionDownload && promotionDownload < fidelityDownload &&
    fidelityDownload < promotionValidation);
  assert.ok(promotionValidation < deploy);
  assert.match(workflow.slice(fidelityDownload, promotionValidation), /run-id: \$\{\{ inputs\.fidelity_run_id \}\}/);
});

test("promotion revalidates fidelity against the downloaded authenticated manifest", async () => {
  const workflow = await readWorkflow();
  const promotion = after(workflow, "  promote:");
  const download = after(workflow, "Download exact successful canary evidence", promotion);
  const metadata = after(
    workflow,
    "Verify authenticated candidate and rollback version mapping",
    download,
  );
  const smoke = after(workflow, "Re-smoke exact immutable canary version", metadata);
  const fidelity = after(
    workflow,
    "Revalidate all-seven production fidelity attestation",
    smoke,
  );
  const nextStep = after(workflow, "Prove production still matches authenticated predecessor", fidelity);
  assert.ok(download < metadata && metadata < smoke && smoke < fidelity && fidelity < nextStep);

  const fidelityStep = workflow.slice(fidelity, nextStep);
  const validator = after(
    fidelityStep,
    "node tools/resident_machine_production_fidelity_gate.mjs",
  );
  const attestation = after(
    fidelityStep,
    "--attestation target/fidelity/attestation.json",
    validator,
  );
  const manifest = after(
    fidelityStep,
    "--release-manifest target/canary/web/dist/release.json",
    attestation,
  );
  assert.ok(validator < attestation && attestation < manifest);
  assert.doesNotMatch(fidelityStep, /--release-origin|--expect-release-id/);
});

test("canary packages the exact feature-on resident runtime and rejects default-off cores", async () => {
  const workflow = await readWorkflow();
  const defaultOff = after(workflow, "Build default-off resident core rejection vector");
  const featureOn = after(workflow, "Build feature-on resident core");
  const contracts = after(workflow, "Validate exact resident Wasm and adapter contracts");
  const frontend = after(workflow, "Generate resident production frontend");
  const release = after(workflow, "Build immutable schema-4 release");
  assert.ok(defaultOff < featureOn && featureOn < contracts && contracts < frontend && frontend < release);
  assert.match(workflow, /cargo \+1\.95\.0 test --locked[\s\S]*-p lazuli[\s\S]*--features browser-machine\/game-fidelity-probes/);
  assert.match(workflow, /cargo \+1\.95\.0 fmt --all -- --check/);
  assert.match(workflow, /cargo \+1\.95\.0 clippy --locked[\s\S]*-p browser-renderer[\s\S]*-D warnings/);
  assert.match(workflow, /RUSTC_BOOTSTRAP: "1"/);
  assert.match(workflow, /rustup toolchain install 1\.95\.0/);
  assert.doesNotMatch(workflow, /Swatinem\/rust-cache|nightly-2026/);
  for (const invocation of workflow.match(/^\s*cargo .*$/gm) ?? []) {
    assert.match(invocation, /cargo \+1\.95\.0/);
    if (!invocation.includes(" fmt ")) assert.match(invocation, /--locked/);
  }
  assert.match(workflow, /--target-dir target\/schema4-default-off/);
  assert.match(workflow, /--target-dir target\/schema4-feature-on/);
  assert.match(workflow, /--target-dir target\/schema4-renderer/);
  assert.match(workflow, /--features game-fidelity-probes/);
  assert.match(workflow, /game_fidelity_wasm_contract -- enabled/);
  assert.match(workflow, /game_fidelity_wasm_contract -- disabled/);
  assert.match(workflow, /tools\/resident_machine_adapter_contract\.mjs/);
  assert.match(workflow, /tools\/build_web_resident_abi_contract\.mjs/);
  assert.match(workflow, /--resident-release/);
  const frontendGate = after(workflow, "tools/browser_resident_frontend.test.mjs");
  const upload = after(workflow, "Upload inactive Cloudflare version");
  assert.ok(frontend < release && release < frontendGate && frontendGate < upload);
  for (const argument of ["--core", "--dispatcher", "--coordinator", "--rollback-release", "--rollback-directory"]) {
    assert.match(workflow, new RegExp(`(?:^|\\s)${argument}(?:\\s|$)`, "m"));
  }
  assert.doesNotMatch(workflow, /browser-dsp|browser_dsp/);
  assert.doesNotMatch(workflow, /(?:^|\s)--(?:dsp|wasm)(?:\s|$)/m);
});

test("canary authenticates a pinned production predecessor and every rollback byte before building", async () => {
  const workflow = await readWorkflow();
  const statusBefore = after(workflow, "Read production predecessor version before authentication");
  const predecessorSmoke = after(workflow, "Authenticate production predecessor shell and executable bytes");
  const fetch = after(workflow, "node tools/fetch_web_rollback.mjs");
  const statusAfter = after(workflow, "Re-read production predecessor version after authentication");
  const build = after(workflow, "node tools/build_web.mjs");
  assert.ok(statusBefore < predecessorSmoke && predecessorSmoke < fetch && fetch < statusAfter && statusAfter < build);
  assert.equal([...workflow.matchAll(/command: deployments status --json/g)].length, 6);
  assert.match(workflow, /--expect-version-id "\$\{\{ steps\.predecessor\.outputs\.version_id \}\}"/);
  assert.match(workflow, /--expect-release-id "\$WEB_ROLLOUT_EXPECTED_ROLLBACK_RELEASE_ID"/);
  assert.match(workflow, /--rollback-release target\/rollback-web\/release\.json/);
  assert.match(workflow, /--rollback-directory target\/rollback-web/);
  assert.match(workflow, /run-id: \$\{\{ inputs\.rollback_metadata_run_id \}\}/);
  assert.match(workflow, /--metadata target\/prior-canary\/target\/cloudflare-version\.json/);
});

test("Cloudflare cutover captures immutable UUID evidence and never promotes a mutable alias or tag", async () => {
  const workflow = await readWorkflow();
  assert.equal([...workflow.matchAll(/uses: cloudflare\/wrangler-action@v3/g)].length, 9);
  assert.equal([...workflow.matchAll(/^\s+wranglerVersion: "4\.112\.0"$/gm)].length, 9);
  assert.match(workflow, /WRANGLER_OUTPUT_FILE_PATH: \$\{\{ github\.workspace \}\}\/target\/wrangler-version-upload\.ndjson/);
  assert.match(workflow, /command: versions upload --preview-alias resident-canary/);
  assert.match(workflow, /cloudflare_release_metadata\.mjs capture/);
  assert.match(workflow, /--output target\/cloudflare-version\.json/);
  assert.match(workflow, /--origin "\$\{\{ steps\.cloudflare_version\.outputs\.preview_origin \}\}"/);
  assert.match(workflow, /command: versions deploy \$\{\{ steps\.cloudflare_version\.outputs\.version_id \}\}@100% --message promote-\$\{\{ inputs\.expected_release_id \}\} -y/);
  assert.match(workflow, /command: rollback \$\{\{ steps\.cloudflare_version\.outputs\.rollback_version_id \}\} --message rollback-to-\$\{\{ inputs\.expected_rollback_release_id \}\}/);
  assert.match(workflow, /name: schema4-canary-candidate/);
  assert.match(workflow, /retention-days: 90/);
  assert.doesNotMatch(workflow, /version_tag|version-tag/);
  assert.doesNotMatch(workflow, /^\s+command: deploy(?:\s|$)/m);
});

test("promotion and rollback smoke exact identities on both sides of each mutation", async () => {
  const workflow = await readWorkflow();
  const promotion = after(workflow, "  promote:");
  const metadata = after(workflow, "Verify authenticated candidate and rollback version mapping", promotion);
  const canarySmoke = after(workflow, "Re-smoke exact immutable canary version", promotion);
  const rollbackProof = after(workflow, "Prove production still matches authenticated predecessor", promotion);
  const predecessorPin = after(workflow, "Pin production to exact predecessor before promotion", promotion);
  const promoteCommand = after(workflow, "command: versions deploy", promotion);
  const promotedVersion = after(workflow, "Prove exact candidate version is live after promotion", promotion);
  const postPromote = after(workflow, "Post-promote production smoke", promotion);
  assert.ok(metadata < canarySmoke && canarySmoke < rollbackProof && rollbackProof < predecessorPin &&
    predecessorPin < promoteCommand && promoteCommand < promotedVersion && promotedVersion < postPromote);
  assert.match(workflow.slice(canarySmoke, rollbackProof), /--expect-source-commit "\$GITHUB_SHA"/);
  assert.match(workflow.slice(rollbackProof, promoteCommand), /predecessor_schema/);
  assert.match(workflow.slice(rollbackProof, promoteCommand), /predecessor_version_id/);
  assert.match(workflow.slice(promotedVersion, postPromote), /outputs\.version_id/);
  assert.match(workflow.slice(postPromote), /--expect-schema 4/);

  const rollback = after(workflow, "  rollback:");
  const rollbackMetadata = after(workflow, "Verify authenticated candidate and rollback version mapping", rollback);
  const currentProof = after(workflow, "Confirm exact schema-4 release before rollback", rollback);
  const candidatePin = after(workflow, "Pin production to exact candidate before rollback", rollback);
  const rollbackCommand = after(workflow, "command: rollback", rollback);
  const rolledBackVersion = after(workflow, "Prove exact rollback version is live after rollback", rollback);
  const postRollback = after(workflow, "Prove schema-3 shell, worker, and assets are live", rollback);
  assert.ok(rollbackMetadata < currentProof && currentProof < candidatePin &&
    candidatePin < rollbackCommand && rollbackCommand < rolledBackVersion &&
    rolledBackVersion < postRollback);
  assert.match(workflow.slice(currentProof, rollbackCommand), /--expect-schema 4/);
  assert.match(workflow.slice(currentProof, rollbackCommand), /outputs\.version_id/);
  assert.match(workflow.slice(rolledBackVersion, postRollback), /outputs\.rollback_version_id/);
  assert.match(workflow.slice(postRollback), /--expect-schema 3/);
});

function validOptions(action) {
  return {
    action,
    canaryRunId: action === "canary" ? "" : "123456789",
    fidelityRunId: action === "promote" ? "987654321" : "",
    rollbackMetadataRunId: "",
    expectedReleaseId: action === "canary" ? "" : RELEASE_ID,
    expectedRollbackReleaseId: ROLLBACK_RELEASE_ID,
    rollbackVersionId: action === "canary" ? VERSION_ID : "",
    checkedOutCommit: COMMIT,
    canaryOrigin: "https://resident-canary.example",
    productionOrigin: "https://gekko.example",
  };
}

test("rollout input validator pins commit, release, rollback, version, and origins per action", () => {
  for (const action of ["canary", "promote", "rollback"]) {
    assert.ok(Object.isFrozen(validateRolloutInputs(validOptions(action))));
  }
  assert.throws(() => validateRolloutInputs({
    ...validOptions("canary"),
    expectedReleaseId: RELEASE_ID,
  }), /release ID is derived/);
  assert.throws(() => validateRolloutInputs({
    ...validOptions("rollback"),
    rollbackVersionId: "latest",
  }), /must come from authenticated canary metadata/);
  assert.throws(() => validateRolloutInputs({
    ...validOptions("canary"),
    rollbackMetadataRunId: "1234",
  }), /exactly one/);
  assert.ok(validateRolloutInputs({
    ...validOptions("canary"),
    rollbackVersionId: "",
    rollbackMetadataRunId: "1234",
  }));
  assert.throws(() => validateRolloutInputs({
    ...validOptions("promote"),
    canaryRunId: "latest",
  }), /canary run ID is invalid/);
  assert.throws(() => validateRolloutInputs({
    ...validOptions("promote"),
    fidelityRunId: "latest",
  }), /fidelity evidence run ID is invalid/);
  assert.throws(() => validateRolloutInputs({
    ...validOptions("promote"),
    fidelityRunId: validOptions("promote").canaryRunId,
  }), /must be distinct/);
  assert.throws(() => validateRolloutInputs({
    ...validOptions("promote"),
    expectedRollbackReleaseId: "",
  }), /rollback release ID is required/);
  assert.throws(() => validateRolloutInputs({
    ...validOptions("promote"),
    canaryOrigin: "https://resident-canary.example/path",
  }), /exact HTTPS origin/);
});

test("self-hosted capture uses a contained plan and gates immutable evidence before upload", async () => {
  const workflow = await readCaptureWorkflow();
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.match(workflow, /^\s+runs-on: \[self-hosted, macOS, lazuli-production-fidelity\]$/m);
  assert.match(workflow, /^\s+LAZULI_CAPTURE_ROOT: \$\{\{ vars\.LAZULI_CAPTURE_ROOT \}\}$/m);
  assert.match(workflow, /^\s+ref: \$\{\{ inputs\.expected_source_commit \}\}$/m);
  assert.match(workflow, /^\s+fetch-depth: 0$/m);
  assert.match(workflow, /name: schema4-canary-candidate/);
  assert.match(workflow, /run-id: \$\{\{ inputs\.canary_run_id \}\}/);
  assert.match(workflow, /run\.conclusion !== "success"/);
  assert.match(workflow, /run\.head_sha !== process\.env\.AUTHENTICATED_SOURCE_COMMIT/);
  assert.match(workflow, /--capture-root "\$LAZULI_CAPTURE_ROOT"/);
  assert.match(workflow, /--plan "\$WEB_FIDELITY_CAPTURE_PLAN"/);
  assert.doesNotMatch(workflow, /tools\/resident_machine_production_fidelity_attestation\.json/);
  assert.doesNotMatch(workflow, /cloudflare\/wrangler-action|versions deploy|command: rollback/);
  const capture = after(workflow, "Run all-seven continuous capture");
  const gate = after(workflow, "Independently re-run fail-closed production fidelity gate", capture);
  const upload = after(workflow, "Upload immutable all-seven fidelity evidence", gate);
  assert.ok(capture < gate && gate < upload);
  assert.match(workflow.slice(gate, upload), /--attestation .*evidence\/attestation\.json/);
  assert.match(workflow.slice(upload), /name: schema4-production-fidelity-evidence/);
});

test("capture dispatch validator rejects unpinned identities and path escape", () => {
  const valid = {
    canaryRunId: "123456789",
    expectedReleaseId: RELEASE_ID,
    expectedSourceCommit: COMMIT,
    captureRoot: "/srv/lazuli-capture",
    capturePlan: "candidate-a/plan.json",
  };
  assert.ok(Object.isFrozen(validateFidelityCaptureDispatchInputs(valid)));
  assert.throws(() => validateFidelityCaptureDispatchInputs({
    ...valid,
    capturePlan: "../plan.json",
  }), /portable relative path/);
  assert.throws(() => validateFidelityCaptureDispatchInputs({
    ...valid,
    captureRoot: "relative/capture",
  }), /absolute configured path/);
  assert.throws(() => validateFidelityCaptureDispatchInputs({
    ...valid,
    captureRoot: "/",
  }), /absolute configured path/);
  assert.throws(() => validateFidelityCaptureDispatchInputs({
    ...valid,
    expectedSourceCommit: "main",
  }), /source commit is invalid/);
});
