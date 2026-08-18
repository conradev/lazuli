#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { deriveResidentRuntimeAbi } from "./build_web.mjs";
import { RESIDENT_RUNTIME_ABI } from "../web/release.mjs";

const [featureCorePath, defaultCorePath, dispatcherPath, coordinatorPath] = process.argv.slice(2);
if (!featureCorePath || !defaultCorePath || !dispatcherPath || !coordinatorPath) {
  process.stderr.write(
    "usage: build_web_resident_abi_contract.mjs " +
      "<feature-core.wasm> <default-core.wasm> <dispatcher.wasm> <coordinator.wasm>\n",
  );
  process.exit(2);
}

try {
  const [featureCore, defaultCore, dispatcher, coordinator, adapter] = await Promise.all([
    readFile(resolve(featureCorePath)),
    readFile(resolve(defaultCorePath)),
    readFile(resolve(dispatcherPath)),
    readFile(resolve(coordinatorPath)),
    readFile(new URL("../web/resident-machine.mjs", import.meta.url), "utf8"),
  ]);
  const abi = deriveResidentRuntimeAbi(featureCore, dispatcher, coordinator, adapter);
  assert.deepEqual(abi, RESIDENT_RUNTIME_ABI);
  assert.throws(
    () => deriveResidentRuntimeAbi(defaultCore, dispatcher, coordinator, adapter),
    /missing core_game_fidelity_(?:bytes|requested_buttons|requested_stick_xy_cxy|requested_trigger_lrab|phase|snapshot)/,
    "default-off core was accepted for a schema-4 production release",
  );
  process.stdout.write(`${JSON.stringify({ ok: true, abi })}\n`);
} catch (error) {
  process.stderr.write(`build_web_resident_abi_contract: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
