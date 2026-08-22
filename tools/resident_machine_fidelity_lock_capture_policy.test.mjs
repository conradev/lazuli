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

const execFileAsync = promisify(execFile);
const GAME_KEY = "warioware-usa";

test("v3 capture policy freezes machine, ledger, operator, leaves, and checkpoint order", () => {
  const policy = productionFidelityCapturePolicy(GAME_KEY);
  assert.equal(policy.workerGeneratedMachineSessionId, true);
  assert.equal(policy.captureMachineInitializedBeforeProgress, true);
  assert.equal(policy.cumulativeRunCapsAfterAuthenticatedReady, true);
  assert.equal(Object.hasOwn(policy, "cumulativeRunCapsFromBoot"), false);
  assert.equal(policy.sameReceiptBaselineReusesFirstFrameReadback, true);
  assert.deepEqual(policy.cumulativeRunLedger, {
    schema: "lazuli-resident-cumulative-run-summary-v1",
    policySource: "locked-runPolicy",
    startsAt: "resident-ready",
    endsAt: "fidelity-accepted-owned",
    terminalSummaryRequired: true,
    operatorPublicationsBound: true,
    witnessPublicationsRequired: 1,
  });
  assert.deepEqual(policy.genericOperatorPolicy, {
    algorithm: "alternating-neutral-a-v1",
    runBoundaryOrigin: "post-first-frame-report-local-zero",
    runBoundaryInterval: 8,
    maximumPublications: PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
    startsWith: "neutral",
    neutral: { buttons: 0, stickXyCxy: 0x8080_8080, triggerLrab: 0 },
    a: { buttons: 0x0100, stickXyCxy: 0x8080_8080, triggerLrab: 0x00ff_0000 },
  });
  assert.equal(policy.requiredCheckpointCardinality["capture-machine-initialized"], 1);
  assert.deepEqual(policy.requiredCheckpointOrder.slice(0, 3), [
    ["capture-machine-initialized", "first-frame-renderer-owned"],
    ["capture-machine-initialized", "fidelity-baseline-owned"],
    ["capture-machine-initialized", "first-frame-report-bound"],
  ]);
  assert.deepEqual(policy.retainedLeafSchema, {
    controllerSource: "tools/resident_machine_production_fidelity_capture.mjs",
    report: "recursive-key-canonical-utf8",
    envelopes: "recursive-key-canonical-utf8",
    opaqueRecords: "decoded-canonical-padded-base64",
    metadata: "recursive-key-canonical-utf8",
    rgba: "raw-owned-bytes",
  });
  assert.throws(() => productionFidelityCapturePolicy("Wario Ware"), /kebab-case/);
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
