// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
  canonicalFidelityLockJson,
  productionFidelityCapturePolicy,
} from "./resident_machine_fidelity_lock.mjs";
import {
  productionFidelityNavigationPolicy,
} from "./resident_machine_fidelity_navigation.mjs";

const execFileAsync = promisify(execFile);
const GAME_KEY = "warioware-usa";

test("v3 capture policy freezes machine, navigation, leaves, and checkpoint order", () => {
  const policy = productionFidelityCapturePolicy(GAME_KEY);
  assert.equal(policy.workerGeneratedMachineSessionId, true);
  assert.equal(policy.captureMachineInitializedBeforeProgress, true);
  assert.equal(policy.cumulativeRunCapsAfterAuthenticatedReady, true);
  assert.equal(Object.hasOwn(policy, "cumulativeRunCapsFromBoot"), false);
  assert.equal(policy.sameReceiptBaselineReusesFirstFrameReadback, true);
  assert.equal(policy.navigationArmCheckpointAckBeforeProgress, true);
  assert.equal(policy.navigationReceiptCheckpointAckBeforeFurtherProgress, true);
  assert.equal(policy.lockedNavigationInputBeforeBaseline, true);
  assert.deepEqual(policy.cumulativeRunLedger, {
    schema: "lazuli-resident-cumulative-run-summary-v2",
    policySource: "locked-runPolicy",
    startsAt: "resident-ready",
    endsAt: "fidelity-accepted-owned",
    terminalSummaryRequired: true,
    operatorPublicationsBound: true,
    witnessPublicationsRequired: 1,
  });
  assert.equal(Object.hasOwn(policy, "genericOperatorPolicy"), false);
  assert.deepEqual(policy.lockedNavigationPolicy, {
    schema: "lazuli-resident-pre-baseline-navigation-v1",
    algorithm: "locked-si-observed-not-before-publication-v1",
    policySource: "locked-runPolicy.navigationPolicy",
    commandTimeControllerWords: 0,
    workerOwnedSequenceNumbers: true,
    armPhase: "phase-0",
    publicationPhase: 0,
    maximumPublications: PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
    completeScriptBeforeBaseline: true,
    terminalNeutralRequired: true,
    firstFrameCanonicalOriginBound: true,
    notBeforePriorAuthenticatedSiObservedCycle: true,
    maximumOvershootSource: "locked-runPolicy.sliceCycleUpperCap",
    exactQueuedStatusRequired: true,
    periodicSiReceiptRequired: true,
  });
  assert.equal(policy.requiredCheckpointCardinality["capture-machine-initialized"], 1);
  assert.equal(policy.requiredCheckpointCardinality["navigation-armed"], 1);
  assert.equal(
    policy.requiredCheckpointCardinality["navigation-step-received"],
    productionFidelityNavigationPolicy(GAME_KEY).steps.length,
  );
  assert.equal(policy.requiredCheckpointCardinality["navigation-step-received"], 34);
  assert.deepEqual(policy.requiredCheckpointOrder.slice(0, 3), [
    ["capture-machine-initialized", "first-frame-renderer-owned"],
    ["capture-machine-initialized", "fidelity-baseline-owned"],
    ["capture-machine-initialized", "first-frame-report-bound"],
  ]);
  assert.ok(policy.requiredCheckpointOrder.some(pair =>
    pair[0] === "navigation-armed" && pair[1] === "navigation-step-received"
  ));
  assert.ok(policy.requiredCheckpointOrder.some(pair =>
    pair[0] === "navigation-step-received" && pair[1] === "fidelity-baseline-owned"
  ));
  assert.deepEqual(policy.retainedLeafSchema, {
    controllerSource: "tools/resident_machine_production_fidelity_capture.mjs",
    report: "recursive-key-canonical-utf8",
    envelopes: "recursive-key-canonical-utf8",
    opaqueRecords: "decoded-canonical-padded-base64",
    metadata: "recursive-key-canonical-utf8",
    rgba: "raw-owned-bytes",
    navigationTranscript: "recursive-key-canonical-utf8",
  });
  assert.throws(() => productionFidelityCapturePolicy("Wario Ware"), /kebab-case/);
});

test("empty navigation still arms durably without forcing pre-Baseline order", () => {
  const policy = productionFidelityCapturePolicy("luigis-mansion-usa");
  assert.equal(policy.lockedNavigationInputBeforeBaseline, false);
  assert.equal(policy.lockedNavigationPolicy.armPhase, "phase-0-or-baseline");
  assert.equal(policy.requiredCheckpointCardinality["navigation-armed"], 1);
  assert.equal(policy.requiredCheckpointCardinality["navigation-step-received"], 0);
  assert.ok(policy.requiredCheckpointOrder.some(pair =>
    pair[0] === "first-frame-report-bound" && pair[1] === "navigation-armed"
  ));
  assert.ok(!policy.requiredCheckpointOrder.some(pair =>
    pair[0] === "navigation-armed" && pair[1] === "fidelity-baseline-owned"
  ));
  assert.ok(!policy.requiredCheckpointOrder.some(pair => pair.includes("navigation-step-received")));
});

test("JavaScript and Python prelaunch validators share byte-exact v3 capture policy", async () => {
  const toolsDirectory = fileURLToPath(new URL("./", import.meta.url));
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import json",
      "from resident_machine_fidelity_server import production_capture_policy",
      `print(json.dumps(production_capture_policy(${JSON.stringify(GAME_KEY)}), sort_keys=True, separators=(',', ':')))` ,
    ].join(";"),
  ], { cwd: toolsDirectory, encoding: "utf8" });
  assert.equal(
    stdout.trim(),
    canonicalFidelityLockJson(productionFidelityCapturePolicy(GAME_KEY)),
  );
});
