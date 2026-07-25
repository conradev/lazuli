#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
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

function makeContext(identifier = "GZWE01") {
  const memory = new ArrayBuffer(0x1800000);
  const view = new DataView(memory);
  const context = {
    Number,
    boot: { identifier },
    controllerAppliedSequence: 0,
    serialLastActiveHostPublication: null,
    wariowareLastActiveGameplayInput: null,
    view,
    ramPointer(address, length) {
      const physical = address & 0x1fffffff;
      return physical <= memory.byteLength - length ? physical : null;
    },
    inspectSuperMonkeyBallGameState() {
      return identifier === "GMBE8P" ? { game: "smb" } : null;
    },
  };
  vm.createContext(context);
  vm.runInContext([
    "guestU32",
    "guestU16",
    "guestS32",
    "hex32",
    "inspectWarioWareGameState",
    "sampleWarioWareGameplayInput",
    "inspectGuestGameState",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.warioware.js",
  });
  return context;
}

test("WarioWare snapshots expose the exact live Repellion state", () => {
  const context = makeContext();
  const { view } = context;
  const runtime = 0x802ab420;
  const playerObject = 0x802a9000;
  for (const address of [0x80295ed0, 0x80295ed4, 0x80295ed8, 0x80295edc]) {
    view.setUint32(address & 0x1fffffff, 0x63, false);
  }
  view.setUint32(0x002f6860, runtime, false);
  view.setUint16(0x002f6580, 0x0100, false);
  view.setUint32(0x002f6598, playerObject, false);
  view.setUint32(0x002f6818, 2, false);
  view.setUint32((playerObject + 0x1230) & 0x1fffffff, 3, false);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.inspectWarioWareGameState())),
    {
      activeGameSlots: [
        { address: "0x80295ed0", id: 0x63 },
        { address: "0x80295ed4", id: 0x63 },
        { address: "0x80295ed8", id: 0x63 },
        { address: "0x80295edc", id: 0x63 },
      ],
      activeMicrogameId: 0x63,
      player0RepellionActive: true,
      repellionActive: true,
      cardDialogStateAddress: "0x802958ac",
      cardDialogState: 0,
      cardDialogChoiceAddress: "0x802958b4",
      cardDialogChoice: 0,
      noMemoryCardDialog: false,
      noCardFlowActive: false,
      runtimePointerAddress: "0x802f6860",
      runtime: "0x802ab420",
      gameplayButtonsAddress: "0x802f6580",
      gameplayButtons: 0x0100,
      aActive: true,
      playerObjectPointerAddress: "0x802f6598",
      playerObject: "0x802a9000",
      playerResultAddress: "0x802f6818",
      playerResult: 2,
      playerObjectResultAddress: "0x802aa230",
      playerObjectResult: 3,
      lastActiveGameplayInput: null,
    },
  );
});

test("WarioWare diagnostics fail closed on absent runtime pointers", () => {
  const snapshot = JSON.parse(JSON.stringify(
    makeContext().inspectWarioWareGameState(),
  ));
  assert.equal(snapshot.runtime, null);
  assert.equal(snapshot.gameplayButtonsAddress, null);
  assert.equal(snapshot.gameplayButtons, null);
  assert.equal(snapshot.aActive, null);
  assert.equal(snapshot.playerObject, null);
  assert.equal(snapshot.playerResult, null);
  assert.equal(snapshot.playerObjectResult, null);
});

test("WarioWare exposes the exact no-Memory-Card dialog state", () => {
  const context = makeContext();
  context.view.setInt32(0x002958ac, 11, false);
  context.view.setInt32(0x002958b4, 1, false);

  const snapshot = context.inspectWarioWareGameState();
  assert.equal(snapshot.cardDialogState, 11);
  assert.equal(snapshot.cardDialogChoice, 1);
  assert.equal(snapshot.noMemoryCardDialog, true);
  assert.equal(snapshot.noCardFlowActive, true);
  assert.equal(snapshot.repellionActive, false);

  context.view.setInt32(0x002958ac, 0x21, false);
  const confirmation = context.inspectWarioWareGameState();
  assert.equal(confirmation.noMemoryCardDialog, false);
  assert.equal(confirmation.noCardFlowActive, true);
});

test("WarioWare keeps game zero and signed result sentinels meaningful", () => {
  const context = makeContext();
  const { view } = context;
  const runtime = 0x802ab420;
  view.setUint32(0x00295ed0, 0, false);
  view.setUint32(0x00295ed4, 0x63, false);
  view.setUint32(0x002f6860, runtime, false);
  view.setUint32(0x002f6818, 0xffffffff, false);

  const snapshot = context.inspectWarioWareGameState();
  assert.equal(snapshot.activeMicrogameId, 0);
  assert.equal(snapshot.player0RepellionActive, false);
  assert.equal(snapshot.repellionActive, true);
  assert.equal(snapshot.playerResult, -1);
});

test("WarioWare retains the first same-sequence guest-consumed A receipt", () => {
  const context = makeContext();
  const { view } = context;
  const runtime = 0x802ab420;
  const playerObject = 0x802a9000;
  view.setUint32(0x00295ed0, 0x63, false);
  view.setUint32(0x002f6860, runtime, false);
  view.setUint16(0x002f6580, 0x0100, false);
  view.setUint32(0x002f6598, playerObject, false);
  view.setInt32((playerObject + 0x1230) & 0x1fffffff, -1, false);
  context.controllerAppliedSequence = 7;
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 42,
    scheduledCycle: 100,
    observedCycle: 105,
    buttons: 0x0100,
    sequence: 7,
  };

  context.sampleWarioWareGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.inspectWarioWareGameState().lastActiveGameplayInput,
    )),
    {
      cycle: 120,
      buttons: 0x0100,
      controllerAppliedSequence: 7,
      hostPublication: {
        source: "periodic",
        pollIndex: 42,
        scheduledCycle: 100,
        observedCycle: 105,
        buttons: 0x0100,
        sequence: 7,
      },
      playerObject: "0x802a9000",
      playerObjectResult: -1,
    },
  );

  context.sampleWarioWareGameplayInput(130);
  assert.equal(
    context.inspectWarioWareGameState().lastActiveGameplayInput.cycle,
    120,
  );

  context.controllerAppliedSequence = 8;
  context.sampleWarioWareGameplayInput(140);
  assert.equal(
    context.inspectWarioWareGameState().lastActiveGameplayInput.cycle,
    120,
  );
  assert.equal(
    context.inspectWarioWareGameState()
      .lastActiveGameplayInput.controllerAppliedSequence,
    7,
  );

  view.setUint16(0x002f6580, 0, false);
  context.sampleWarioWareGameplayInput(150);
  assert.equal(
    context.inspectWarioWareGameState().lastActiveGameplayInput.cycle,
    120,
  );
});

test("WarioWare guest input latch requires live Repellion and a matching host A", () => {
  const context = makeContext();
  const runtime = 0x802ab420;
  context.view.setUint32(0x002f6860, runtime, false);
  context.view.setUint16(0x002f6580, 0x0100, false);
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 1,
    scheduledCycle: 10,
    observedCycle: 10,
    buttons: 0x0100,
    sequence: 1,
  };

  context.sampleWarioWareGameplayInput(20);
  assert.equal(context.wariowareLastActiveGameplayInput, null);
  context.view.setUint32(0x00295ed0, 0x63, false);
  context.serialLastActiveHostPublication.buttons = 0x1000;
  context.sampleWarioWareGameplayInput(20);
  assert.equal(context.wariowareLastActiveGameplayInput, null);
  assert.match(
    source,
    /if \(scanoutDue\) \{\s+sampleWarioWareGameplayInput\(scheduledCycle\);/,
  );
});

test("guest game diagnostics dispatch by exact retail identity", () => {
  assert.equal(makeContext("GZLE01").inspectGuestGameState(), null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GMBE8P").inspectGuestGameState())),
    { game: "smb" },
  );
  assert.notEqual(makeContext("GZWE01").inspectGuestGameState(), null);
  assert.match(source, /guestGame: inspectGuestGameState\(\)/);
});
