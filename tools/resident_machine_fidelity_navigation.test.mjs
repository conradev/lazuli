// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
} from "./resident_machine_fidelity_checkpoints.mjs";
import {
  PRODUCTION_FIDELITY_GAME_KEYS,
  PRODUCTION_FIDELITY_MAXIMUM_SI_RECEIPT_LATENCY_CYCLES,
  PRODUCTION_FIDELITY_NAVIGATION_ALGORITHM,
  PRODUCTION_FIDELITY_SI_FIELD_CYCLES,
  WARIO_AUTHENTICATED_REPELLION_CANONICAL_CYCLE_UPPER_BOUND,
  WARIO_CANONICAL_CYCLE_CAP_MARGIN,
  productionFidelityNavigationPolicy,
  validateFidelityNavigationPolicy,
} from "./resident_machine_fidelity_navigation.mjs";

const FIELD = 8_108_100n;
const A = 0x0100;
const UP = 0x0008;
const START = 0x1000;
const CENTERED = 0x8080_8080;

test("production navigation freezes the 32B/16B caps and authenticated Wario margin", () => {
  assert.equal(PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP, "32000000000");
  assert.equal(PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP, "32000000000");
  assert.equal(PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP, "16000000000");
  assert.equal(WARIO_AUTHENTICATED_REPELLION_CANONICAL_CYCLE_UPPER_BOUND, "27000000000");
  assert.equal(WARIO_CANONICAL_CYCLE_CAP_MARGIN, "5000000000");
  assert.equal(
    BigInt(WARIO_AUTHENTICATED_REPELLION_CANONICAL_CYCLE_UPPER_BOUND)
      + BigInt(WARIO_CANONICAL_CYCLE_CAP_MARGIN),
    BigInt(PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP),
  );
});

test("Wario navigation is 17 alternating actions with guest-cycle hold minima", () => {
  const policy = productionFidelityNavigationPolicy("warioware-usa");
  assert.equal(policy.algorithm, PRODUCTION_FIDELITY_NAVIGATION_ALGORITHM);
  assert.equal(policy.targetAnchor, "prior-si-observed-cycle");
  assert.equal(policy.receiptSource, "periodic");
  assert.equal(policy.periodicSiCycles, PRODUCTION_FIDELITY_SI_FIELD_CYCLES);
  assert.equal(PRODUCTION_FIDELITY_SI_FIELD_CYCLES, FIELD.toString());
  assert.equal(PRODUCTION_FIDELITY_MAXIMUM_SI_RECEIPT_LATENCY_CYCLES, "16108100");
  assert.equal(policy.steps.length, 34);
  assert.deepEqual(
    policy.steps.filter((_, index) => index % 2 === 0).map(step => step.buttons),
    [A, UP, A, START, START, A, A, A, A, A, A, A, A, A, A, A, A],
  );
  for (let index = 0; index < policy.steps.length; index += 2) {
    const pressed = policy.steps[index];
    const released = policy.steps[index + 1];
    assert.notEqual(pressed.buttons, 0);
    assert.deepEqual(
      released,
      {
        minimumCanonicalDelay: (3n * FIELD).toString(),
        buttons: 0,
        stickXyCxy: CENTERED,
        triggerLrab: 0,
      },
    );
  }
  assert.equal(
    policy.steps.reduce((sum, step) => sum + BigInt(step.minimumCanonicalDelay), 0n),
    13_397_287_900n,
  );
  assert.equal(
    validateFidelityNavigationPolicy(policy, "warioware-usa").scriptSha256,
    "84abad2615ea1c94e9389fde3fa1d25e65a91653df85cc140a9fd49bff9a0d9e",
  );
});

test("every retained title has a bounded script and exact terminal neutral state", () => {
  for (const gameKey of PRODUCTION_FIDELITY_GAME_KEYS) {
    const policy = validateFidelityNavigationPolicy(
      productionFidelityNavigationPolicy(gameKey),
      gameKey,
    );
    assert.ok(policy.steps.length <= policy.maximumPublications);
    if (policy.steps.length !== 0) {
      assert.deepEqual(policy.steps.at(-1), {
        minimumCanonicalDelay: (3n * FIELD).toString(),
        buttons: 0,
        stickXyCxy: CENTERED,
        triggerLrab: 0,
      });
    }
  }
});
