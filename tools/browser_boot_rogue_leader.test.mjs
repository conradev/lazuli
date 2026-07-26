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
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

class EffectiveMemory {
  constructor() {
    this.bytes = new Map();
    this.mapped = new Set();
    this.probes = [];
  }

  map(address, size = 1) {
    for (let index = 0; index < size; index += 1) {
      this.mapped.add(address + index);
    }
  }

  has(address, size) {
    for (let index = 0; index < size; index += 1) {
      if (!this.mapped.has(address + index)) return false;
    }
    return true;
  }

  writeBytes(address, values) {
    values.forEach((value, index) => {
      this.bytes.set(address + index, value & 0xff);
      this.mapped.add(address + index);
    });
  }

  readBytes(address, size) {
    if (!this.has(address, size)) return null;
    return Array.from(
      { length: size },
      (_unused, index) => this.bytes.get(address + index) ?? 0,
    );
  }
}

function makeContext(identifier = "GSWE64", version = 0) {
  const memory = new EffectiveMemory();
  let directGuestReads = 0;
  const context = {
    Math,
    Number,
    boot: { identifier, version },
    controllerAppliedSequence: 0,
    controllerState: {
      buttons: 0,
      stickX: 0x80,
      stickY: 0x80,
    },
    rogueLeaderLastActiveGameplayInput: null,
    rogueLeaderNeutralControlBaseline: null,
    serialLastActiveHostPublication: null,
    memory,
    guestEffectivePointer(address, size) {
      memory.probes.push({ address, size });
      return memory.has(address, size) ? address : null;
    },
    inspectSuperMonkeyBallGameState() {
      return null;
    },
    inspectLuigisMansionGameState() {
      return null;
    },
    inspectWindWakerGameState() {
      return null;
    },
    inspectMeleeGameState() {
      return null;
    },
    inspectFzeroGameState() {
      return null;
    },
    inspectWarioWareGameState() {
      return null;
    },
    inspectMetroidPrimeGameState() {
      return null;
    },
    sampleLuigisMansionGameplayInput() {},
    sampleWindWakerGameplayInput() {},
    sampleMeleeGameplayInput() {},
    sampleFzeroGameplayInput() {},
    sampleWarioWareGameplayInput() {},
    sampleMetroidPrimeGameplayInput() {},
  };

  function readUnsigned(address, size) {
    const pointer = context.guestEffectivePointer(address, size);
    if (pointer === null) return null;
    return memory.readBytes(pointer, size).reduce(
      (value, byte) => value * 0x100 + byte,
      0,
    );
  }

  context.guestEffectiveU32 = address => readUnsigned(address, 4);
  context.guestEffectiveS32 = address => {
    const value = readUnsigned(address, 4);
    return value === null
      ? null
      : value >= 0x80000000 ? value - 0x100000000 : value;
  };
  context.guestEffectiveU16 = address => readUnsigned(address, 2);
  context.guestEffectiveU8 = address => readUnsigned(address, 1);
  context.guestEffectiveS8 = address => {
    const value = readUnsigned(address, 1);
    return value === null ? null : value >= 0x80 ? value - 0x100 : value;
  };
  context.guestEffectiveF32 = address => {
    const pointer = context.guestEffectivePointer(address, 4);
    if (pointer === null) return null;
    const values = memory.readBytes(pointer, 4);
    if (values === null) return null;
    const bytes = Uint8Array.from(values);
    return new DataView(bytes.buffer).getFloat32(0, false);
  };
  for (const name of [
    "guestU32",
    "guestS32",
    "guestU16",
    "guestU8",
    "guestS8",
    "guestF32",
  ]) {
    context[name] = () => {
      directGuestReads += 1;
      throw new Error(`${name} must not inspect Factor 5 effective aliases`);
    };
  }
  Object.defineProperty(context, "directGuestReads", {
    get() {
      return directGuestReads;
    },
  });

  vm.createContext(context);
  vm.runInContext([
    "hex32",
    "rogueLeaderMappedEffectiveAddress",
    "rogueLeaderFinitePadAxis",
    "rogueLeaderFiniteShapedAxis",
    "rogueLeaderShapedAxisDirectionCoherent",
    "inspectRogueLeaderVector",
    "rogueLeaderFiniteVector",
    "rogueLeaderDot",
    "inspectRogueLeaderGameState",
    "sampleRogueLeaderGameplayInput",
    "inspectGuestGameState",
    "sampleGuestGameplayInput",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.rogue_leader.js",
  });
  return context;
}

function writeU32(context, address, value) {
  const stored = value >>> 0;
  context.memory.writeBytes(address, [
    stored >>> 24,
    stored >>> 16,
    stored >>> 8,
    stored,
  ]);
}

function writeS32(context, address, value) {
  writeU32(context, address, value);
}

function writeU16(context, address, value) {
  context.memory.writeBytes(address, [value >>> 8, value]);
}

function writeU8(context, address, value) {
  context.memory.writeBytes(address, [value]);
}

function writeS8(context, address, value) {
  writeU8(context, address, value);
}

function writeF32(context, address, value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, false);
  context.memory.writeBytes(address, Array.from(new Uint8Array(buffer)));
}

function writeVector(context, address, values) {
  values.forEach((value, index) => writeF32(
    context,
    address + index * 4,
    value,
  ));
}

function seedActiveXWing(context, {
  rawStickX = -72,
  rawStickY = 0,
  stickX = -1,
  stickY = 0,
  controlStickX = stickX,
  controlStickY = stickY,
  response45c = 0,
  response460 = 0.25,
  response464 = -0.125,
} = {}) {
  const playerManager = 0x7fdefe14;
  const craft = 0x7fd80000;
  const craftConfig = 0x7fd90000;
  const craftControl = 0x7fdf0fa4;
  const simulation = 0x7fdb0000;
  const pad = 0x7fdee6e8;
  const normalizedPad = 0x7fdee718;
  const globalAxes = 0x7fde97e0;

  writeU32(context, 0x80000000, 0x47535745);
  writeU16(context, 0x80000004, 0x3634);
  writeU8(context, 0x80000006, 0);
  writeU8(context, 0x80000007, 0);

  writeU32(context, playerManager, craft);
  writeS32(context, playerManager + 4, 42);
  writeS32(context, playerManager + 8, 0);
  writeS32(context, playerManager + 0x0c, 3);

  context.memory.map(craft);
  writeU32(context, craft + 0x80, 0x7fdc75b8);
  writeU32(context, craft + 0x1a0, 0x7fdc760c);
  writeVector(context, craft + 0x84, [1, 0, 0]);
  writeVector(context, craft + 0x90, [0, 1, 0]);
  writeVector(context, craft + 0x9c, [0, 0, 1]);
  writeVector(context, craft + 0xa8, [10, 20, 30]);
  writeVector(context, craft + 0xb4, [1, 0, 0]);
  writeS32(context, craft + 0x370, 0);
  writeU32(context, craft + 0x37c, craftConfig);
  writeU32(context, craft + 0x380, craftControl);
  writeF32(context, craft + 0x45c, response45c);
  writeF32(context, craft + 0x460, response460);
  writeF32(context, craft + 0x464, response464);
  context.memory.map(craftConfig);

  context.memory.map(craftControl);
  writeU32(context, craftControl + 0x110, 0);
  writeU32(context, craftControl + 0x10c, 1);
  writeF32(context, craftControl + 8, controlStickX);
  writeF32(context, craftControl + 0x0c, controlStickY);

  writeU32(context, 0x80095dc8, simulation);
  context.memory.map(simulation);
  writeU8(context, simulation + 0xe04, 1);
  writeS32(context, simulation + 0xa7c, 1);

  writeU16(context, pad, 0);
  writeS8(context, pad + 2, rawStickX);
  writeS8(context, pad + 3, rawStickY);
  writeS8(context, pad + 0x0a, 0);
  writeF32(context, normalizedPad, stickX);
  writeF32(context, normalizedPad + 4, -stickY);
  writeF32(context, globalAxes, stickX);
  writeF32(context, globalAxes + 4, stickY);

  writeS32(context, 0x7fde822c, 0);
  writeS32(context, 0x7fde8230, 0);

  return {
    craft,
    craftConfig,
    craftControl,
    globalAxes,
    normalizedPad,
    pad,
    playerManager,
    simulation,
  };
}

function setXWingInput(context, fixture, {
  rawStickX,
  rawStickY,
  normalizedStickX,
  normalizedStickY,
  globalStickX = normalizedStickX,
  globalStickY = -normalizedStickY,
  controlStickX,
  controlStickY,
  response45c,
  response460,
  response464,
}) {
  writeS8(context, fixture.pad + 2, rawStickX);
  writeS8(context, fixture.pad + 3, rawStickY);
  writeF32(context, fixture.normalizedPad, normalizedStickX);
  writeF32(context, fixture.normalizedPad + 4, normalizedStickY);
  writeF32(context, fixture.globalAxes, globalStickX);
  writeF32(context, fixture.globalAxes + 4, globalStickY);
  writeF32(context, fixture.craftControl + 8, controlStickX);
  writeF32(context, fixture.craftControl + 0x0c, controlStickY);
  writeF32(context, fixture.craft + 0x45c, response45c);
  writeF32(context, fixture.craft + 0x460, response460);
  writeF32(context, fixture.craft + 0x464, response464);
}

function recordNeutralBaseline(context, fixture, {
  cycle = 80,
  sequence = 1,
  response45c = 0,
  response460 = 0,
  response464 = 0,
} = {}) {
  context.controllerState = {
    buttons: 0,
    stickX: 0x80,
    stickY: 0x80,
  };
  setXWingInput(context, fixture, {
    rawStickX: 0,
    rawStickY: 0,
    normalizedStickX: 0,
    normalizedStickY: 0,
    controlStickX: 0,
    controlStickY: 0,
    response45c,
    response460,
    response464,
  });
  context.controllerAppliedSequence = sequence;
  context.sampleRogueLeaderGameplayInput(cycle);
}

function applyHostLeft(context, fixture) {
  const normalizedStickX = Math.fround(-100 / 72);
  setXWingInput(context, fixture, {
    rawStickX: -100,
    rawStickY: 0,
    normalizedStickX,
    normalizedStickY: 0,
    controlStickX: -1,
    controlStickY: 0,
    response45c: 0,
    response460: 0.25,
    response464: -0.125,
  });
}

function publishLeft(context, overrides = {}) {
  const { appliedSequence = 7, ...publicationOverrides } = overrides;
  context.controllerAppliedSequence = appliedSequence;
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 42,
    scheduledCycle: 100,
    observedCycle: 105,
    buttons: 0x0001,
    sequence: 7,
    ...publicationOverrides,
  };
  context.controllerState = {
    buttons: context.serialLastActiveHostPublication.buttons,
    stickX: 0x01,
    stickY: 0x80,
  };
}

test("Rogue Leader diagnostics expose the exact live retail X-Wing control path", () => {
  const context = makeContext();
  const fixture = seedActiveXWing(context);
  const state = JSON.parse(JSON.stringify(context.inspectRogueLeaderGameState()));

  assert.deepEqual(state.identity, {
    headerAddress: "0x80000000",
    gameCode: "0x47535745",
    makerCode: 0x3634,
    discNumber: 0,
    revision: 0,
    exact: true,
  });
  assert.deepEqual(state.level, {
    indexAddress: "0x7fde822c",
    index: 0,
    sublevelIndexAddress: "0x7fde8230",
    sublevelIndex: 0,
  });
  assert.equal(state.playerManager.address, "0x7fdefe14");
  assert.equal(state.playerManager.activeCraftPointerAddress, "0x7fdefe14");
  assert.equal(state.playerManager.activeCraft, "0x7fd80000");
  assert.equal(state.playerManager.activeCraftHandleAddress, "0x7fdefe18");
  assert.equal(state.playerManager.activeCraftHandle, 42);
  assert.equal(state.playerManager.selectedCraftTypeAddress, "0x7fdefe1c");
  assert.equal(state.playerManager.selectedCraftType, 0);

  assert.equal(state.simulation.pointerAddress, "0x80095dc8");
  assert.equal(state.simulation.manager, "0x7fdb0000");
  assert.equal(state.simulation.auxiliaryEnabledAddress, "0x7fdb0e04");
  assert.equal(state.simulation.auxiliaryModeAddress, "0x7fdb0a7c");
  assert.equal(state.simulation.auxiliaryControlMode, true);

  assert.equal(state.input.port, 0);
  assert.equal(state.input.padAddress, "0x7fdee6e8");
  assert.equal(state.input.rawStickXAddress, "0x7fdee6ea");
  assert.equal(state.input.rawStickX, -72);
  assert.equal(state.input.rawStickY, 0);
  assert.equal(state.input.error, 0);
  assert.equal(state.input.normalizedStickXAddress, "0x7fdee718");
  assert.equal(state.input.normalizedStickX, -1);
  assert.equal(state.input.expectedNormalizedStickX, -1);
  assert.equal(state.input.normalizedStickY, 0);
  assert.equal(state.input.expectedNormalizedStickY, 0);
  assert.equal(state.input.globalStickXAddress, "0x7fde97e0");
  assert.equal(state.input.globalStickX, -1);
  assert.equal(state.input.globalStickY, 0);
  assert.equal(state.input.valuesValid, true);
  assert.equal(state.input.rawNormalizationCoherent, true);
  assert.equal(state.input.globalAxesCoherent, true);
  assert.equal(state.input.shapedControlCoherent, true);
  assert.equal(state.input.pipelineCoherent, true);
  assert.equal(state.input.hostLeftRetained, true);

  assert.equal(state.craft.address, "0x7fd80000");
  assert.deepEqual(state.craft.identity, {
    primaryVtableAddress: "0x7fd80080",
    primaryVtable: "0x7fdc75b8",
    interfaceVtableAddress: "0x7fd801a0",
    interfaceVtable: "0x7fdc760c",
    type: "x-wing",
    exact: true,
  });
  assert.equal(state.craft.config, "0x7fd90000");
  assert.equal(state.craft.control, "0x7fdf0fa4");
  assert.equal(state.craft.exactControl, true);
  assert.equal(state.craft.controlInput.stickXIndex, 0);
  assert.equal(state.craft.controlInput.stickXAddress, "0x7fdf0fac");
  assert.equal(state.craft.controlInput.stickX, -1);
  assert.equal(state.craft.controlInput.stickYIndex, 1);
  assert.equal(state.craft.controlInput.stickYAddress, "0x7fdf0fb0");
  assert.equal(state.craft.controlInput.stickY, 0);
  assert.equal(state.craft.controlInput.exactMapping, true);
  assert.equal(state.craft.controlInput.hostLeftRetained, true);
  assert.deepEqual(state.craft.transform.orientation0, { x: 1, y: 0, z: 0 });
  assert.deepEqual(state.craft.transform.orientation1, { x: 0, y: 1, z: 0 });
  assert.deepEqual(state.craft.transform.orientation2, { x: 0, y: 0, z: 1 });
  assert.deepEqual(state.craft.transform.position, { x: 10, y: 20, z: 30 });
  assert.deepEqual(state.craft.transform.velocity, { x: 1, y: 0, z: 0 });
  assert.equal(state.craft.transform.finite, true);
  assert.equal(state.craft.transform.orthonormal, true);
  assert.equal(state.craft.transform.determinant, 1);
  assert.equal(state.craft.transform.rightHanded, true);
  assert.equal(state.craft.response.field45c, 0);
  assert.equal(state.craft.response.field460, 0.25);
  assert.equal(state.craft.response.field464, -0.125);
  assert.equal(state.craft.response.xActive, true);
  assert.equal(state.craft.valid, true);
  assert.equal(state.controlsEnabled, true);
  assert.equal(state.liveXwingControlPath, true);
  assert.equal(state.normalCraftState, true);
  assert.equal(state.normalStateTransformValid, true);
  assert.equal(state.hostLeftCorrelated, true);
  assert.equal(state.activeFlight, false);
  assert.equal(state.guestConsumedHostLeft, false);
  assert.equal(state.neutralControlBaseline, null);
  assert.equal(context.directGuestReads, 0);

  assert.ok(
    context.memory.probes.some(
      probe => probe.address === fixture.playerManager && probe.size === 1,
    ),
  );
  assert.ok(
    context.memory.probes.some(
      probe => probe.address === fixture.craftControl + 0x110
        && probe.size === 4,
    ),
  );
  assert.ok(
    Math.max(...context.memory.probes.map(probe => probe.size)) <= 4,
    "the inspector must not require a multi-field effective range",
  );
});

test("Rogue Leader control path fails closed on identity, lifecycle, and controls", () => {
  assert.equal(makeContext("GSWP64", 0).inspectRogueLeaderGameState(), null);
  assert.equal(makeContext("GSWE64", 1).inspectRogueLeaderGameState(), null);

  const badHeader = makeContext();
  seedActiveXWing(badHeader);
  writeU8(badHeader, 0x80000007, 1);
  assert.equal(badHeader.inspectRogueLeaderGameState().identity.exact, false);
  assert.equal(
    badHeader.inspectRogueLeaderGameState().liveXwingControlPath,
    false,
  );

  const wrongType = makeContext();
  const wrongTypeFixture = seedActiveXWing(wrongType);
  writeS32(wrongType, wrongTypeFixture.playerManager + 8, 13);
  assert.equal(wrongType.inspectRogueLeaderGameState().craft.identity.exact, false);
  assert.equal(
    wrongType.inspectRogueLeaderGameState().liveXwingControlPath,
    false,
  );

  const baseVtable = makeContext();
  const baseFixture = seedActiveXWing(baseVtable);
  writeU32(baseVtable, baseFixture.craft + 0x80, 0x7fdbe500);
  assert.equal(baseVtable.inspectRogueLeaderGameState().craft.identity.exact, false);
  assert.equal(
    baseVtable.inspectRogueLeaderGameState().liveXwingControlPath,
    false,
  );

  const stoppedSimulation = makeContext();
  const stoppedFixture = seedActiveXWing(stoppedSimulation);
  writeS32(stoppedSimulation, stoppedFixture.simulation + 0xa7c, 0);
  assert.equal(
    stoppedSimulation.inspectRogueLeaderGameState()
      .simulation.auxiliaryControlMode,
    false,
  );
  assert.equal(
    stoppedSimulation.inspectRogueLeaderGameState().liveXwingControlPath,
    true,
  );
  assert.equal(
    stoppedSimulation.inspectRogueLeaderGameState().normalStateTransformValid,
    true,
  );
  assert.equal(stoppedSimulation.inspectRogueLeaderGameState().activeFlight, false);

  const impactState = makeContext();
  const impactFixture = seedActiveXWing(impactState);
  writeS32(impactState, impactFixture.craft + 0x370, 3);
  assert.equal(impactState.inspectRogueLeaderGameState().normalCraftState, false);
  assert.equal(
    impactState.inspectRogueLeaderGameState().normalStateTransformValid,
    false,
  );
  assert.equal(impactState.inspectRogueLeaderGameState().activeFlight, false);

  const invalidTransform = makeContext();
  const invalidTransformFixture = seedActiveXWing(invalidTransform);
  writeVector(invalidTransform, invalidTransformFixture.craft + 0x84, [2, 0, 0]);
  assert.equal(
    invalidTransform.inspectRogueLeaderGameState().craft.transform.orthonormal,
    false,
  );
  assert.equal(
    invalidTransform.inspectRogueLeaderGameState().normalStateTransformValid,
    false,
  );
  assert.equal(invalidTransform.inspectRogueLeaderGameState().activeFlight, false);

  const mirroredTransform = makeContext();
  const mirroredTransformFixture = seedActiveXWing(mirroredTransform);
  writeVector(
    mirroredTransform,
    mirroredTransformFixture.craft + 0x9c,
    [0, 0, -1],
  );
  assert.equal(
    mirroredTransform.inspectRogueLeaderGameState().craft.transform.orthonormal,
    true,
  );
  assert.equal(
    mirroredTransform.inspectRogueLeaderGameState().craft.transform.determinant,
    -1,
  );
  assert.equal(
    mirroredTransform.inspectRogueLeaderGameState().craft.transform.rightHanded,
    false,
  );
  assert.equal(
    mirroredTransform.inspectRogueLeaderGameState().normalStateTransformValid,
    false,
  );
  assert.equal(
    mirroredTransform.inspectRogueLeaderGameState().activeFlight,
    false,
  );

  const invalidIndex = makeContext();
  const invalidIndexFixture = seedActiveXWing(invalidIndex);
  writeU32(invalidIndex, invalidIndexFixture.craftControl + 0x110, 40);
  assert.equal(
    invalidIndex.inspectRogueLeaderGameState().craft.controlInput.valid,
    false,
  );
  assert.equal(
    invalidIndex.inspectRogueLeaderGameState().liveXwingControlPath,
    false,
  );

  const managerOnly = makeContext();
  seedActiveXWing(managerOnly, { controlStickX: 0 });
  const managerOnlyState = managerOnly.inspectRogueLeaderGameState();
  assert.equal(managerOnlyState.input.pipelineCoherent, false);
  assert.equal(managerOnlyState.craft.controlInput.hostLeftRetained, false);
  assert.equal(managerOnlyState.guestConsumedHostLeft, false);

  const noCraftResponse = makeContext();
  const noResponseFixture = seedActiveXWing(noCraftResponse);
  writeF32(noCraftResponse, noResponseFixture.craft + 0x460, 0);
  writeF32(noCraftResponse, noResponseFixture.craft + 0x464, 0);
  const noResponseState = noCraftResponse.inspectRogueLeaderGameState();
  assert.equal(noResponseState.craft.response.xActive, false);
  assert.equal(noResponseState.normalStateTransformValid, true);
  assert.equal(noResponseState.hostLeftCorrelated, false);
  assert.equal(noResponseState.activeFlight, false);
  assert.equal(noResponseState.guestConsumedHostLeft, false);

  const staleRightResponse = makeContext();
  const staleRightFixture = seedActiveXWing(staleRightResponse);
  writeF32(staleRightResponse, staleRightFixture.craft + 0x460, -0.25);
  writeF32(staleRightResponse, staleRightFixture.craft + 0x464, 0.125);
  const staleRightState = staleRightResponse.inspectRogueLeaderGameState();
  assert.equal(staleRightState.craft.response.xActive, true);
  assert.equal(staleRightState.hostLeftCorrelated, true);
  assert.equal(staleRightState.activeFlight, false);
  assert.equal(staleRightState.guestConsumedHostLeft, false);

  const impossibleNormalization = makeContext();
  seedActiveXWing(impossibleNormalization, {
    rawStickX: -96,
    stickX: -0.75,
  });
  const impossibleNormalizationState =
    impossibleNormalization.inspectRogueLeaderGameState();
  assert.equal(
    impossibleNormalizationState.input.rawNormalizationCoherent,
    false,
  );
  assert.equal(impossibleNormalizationState.input.pipelineCoherent, false);

  const shapedEndpoint = makeContext();
  seedActiveXWing(shapedEndpoint, {
    rawStickX: -127,
    stickX: Math.fround(-127 / 72),
    controlStickX: -1,
  });
  const shapedEndpointState = shapedEndpoint.inspectRogueLeaderGameState();
  assert.equal(shapedEndpointState.input.rawNormalizationCoherent, true);
  assert.equal(shapedEndpointState.input.globalAxesCoherent, true);
  assert.equal(shapedEndpointState.input.shapedControlCoherent, true);
  assert.equal(shapedEndpointState.input.pipelineCoherent, true);
  assert.equal(shapedEndpointState.hostLeftCorrelated, true);

  const negatedYEndpoint = makeContext();
  seedActiveXWing(negatedYEndpoint, {
    rawStickY: -128,
    stickY: Math.fround(128 / 72),
    controlStickY: 1,
  });
  const negatedYState = negatedYEndpoint.inspectRogueLeaderGameState();
  assert.equal(negatedYState.input.valuesValid, true);
  assert.equal(negatedYState.input.rawNormalizationCoherent, true);
  assert.equal(negatedYState.input.globalAxesCoherent, true);
  assert.equal(negatedYState.input.shapedControlCoherent, true);
});

test("Rogue Leader latches only the first exact applied host-left receipt", () => {
  const context = makeContext();
  const fixture = seedActiveXWing(context);
  recordNeutralBaseline(context, fixture);
  publishLeft(context);
  context.sampleRogueLeaderGameplayInput(106);
  assert.equal(
    context.inspectRogueLeaderGameState()
      .neutralControlBaseline.controllerAppliedSequence,
    1,
  );
  assert.equal(
    context.inspectRogueLeaderGameState().lastActiveGameplayInput,
    null,
  );
  applyHostLeft(context, fixture);
  context.sampleRogueLeaderGameplayInput(120);

  const witnessed = context.inspectRogueLeaderGameState();
  assert.equal(witnessed.activeFlight, true);
  assert.equal(witnessed.guestConsumedHostLeft, true);
  const receipt = JSON.parse(JSON.stringify(witnessed.lastActiveGameplayInput));
  assert.equal(receipt.cycle, 120);
  assert.equal(receipt.controllerAppliedSequence, 7);
  assert.equal(receipt.hostPublication.sequence, 7);
  assert.deepEqual(receipt.level, { index: 0, sublevelIndex: 0 });
  assert.deepEqual(receipt.craft, {
    address: "0x7fd80000",
    handle: 42,
    config: "0x7fd90000",
    control: "0x7fdf0fa4",
    primaryVtable: "0x7fdc75b8",
    interfaceVtable: "0x7fdc760c",
    type: "x-wing",
    state: 0,
  });
  assert.deepEqual(receipt.transform, {
    orientation0: { x: 1, y: 0, z: 0 },
    orientation1: { x: 0, y: 1, z: 0 },
    orientation2: { x: 0, y: 0, z: 1 },
    position: { x: 10, y: 20, z: 30 },
    velocity: { x: 1, y: 0, z: 0 },
  });
  assert.deepEqual(receipt.input, {
    port: 0,
    buttons: 0,
    rawStickX: -100,
    rawStickY: 0,
    normalizedStickX: Math.fround(-100 / 72),
    normalizedStickY: 0,
    globalStickX: Math.fround(-100 / 72),
    globalStickY: 0,
    stickX: -1,
    stickY: 0,
  });
  assert.deepEqual(receipt.response, {
    field45c: 0,
    field460: 0.25,
    field464: -0.125,
  });
  assert.deepEqual(receipt.neutralBaseline, {
    cycle: 80,
    controllerAppliedSequence: 1,
    response: {
      field45c: 0,
      field460: 0,
      field464: 0,
    },
  });
  assert.deepEqual(receipt.responseTransition, {
    field460Delta: 0.25,
    field464Delta: -0.125,
    xChanged: true,
  });

  publishLeft(context, {
    appliedSequence: 8,
    sequence: 8,
    observedCycle: 125,
  });
  context.sampleRogueLeaderGameplayInput(130);
  assert.equal(
    context.inspectRogueLeaderGameState().lastActiveGameplayInput.cycle,
    120,
  );
});

test("Rogue Leader receipt rejects unrelated, future, and unconsumed input", () => {
  for (const overrides of [
    { buttons: 0x0100 },
    { appliedSequence: 6 },
    { scheduledCycle: 110, observedCycle: 105 },
    { observedCycle: 121 },
    { pollIndex: 0 },
  ]) {
    const context = makeContext();
    const fixture = seedActiveXWing(context);
    recordNeutralBaseline(context, fixture);
    applyHostLeft(context, fixture);
    publishLeft(context, overrides);
    context.sampleRogueLeaderGameplayInput(120);
    assert.equal(
      context.inspectRogueLeaderGameState().lastActiveGameplayInput,
      null,
    );
  }

  const noBaseline = makeContext();
  seedActiveXWing(noBaseline);
  publishLeft(noBaseline);
  noBaseline.sampleRogueLeaderGameplayInput(120);
  assert.equal(
    noBaseline.inspectRogueLeaderGameState().lastActiveGameplayInput,
    null,
  );

  const staleResponse = makeContext();
  const staleResponseFixture = seedActiveXWing(staleResponse);
  recordNeutralBaseline(staleResponse, staleResponseFixture, {
    response460: 0.25,
    response464: -0.125,
  });
  applyHostLeft(staleResponse, staleResponseFixture);
  publishLeft(staleResponse);
  staleResponse.sampleRogueLeaderGameplayInput(120);
  assert.equal(
    staleResponse.inspectRogueLeaderGameState().lastActiveGameplayInput,
    null,
  );

  const modeDependentResponse = makeContext();
  const modeDependentFixture = seedActiveXWing(modeDependentResponse);
  recordNeutralBaseline(modeDependentResponse, modeDependentFixture);
  applyHostLeft(modeDependentResponse, modeDependentFixture);
  writeF32(modeDependentResponse, modeDependentFixture.craft + 0x460, -0.25);
  writeF32(modeDependentResponse, modeDependentFixture.craft + 0x464, 0.125);
  publishLeft(modeDependentResponse);
  modeDependentResponse.sampleRogueLeaderGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      modeDependentResponse.inspectRogueLeaderGameState()
        .lastActiveGameplayInput.responseTransition,
    )),
    {
      field460Delta: -0.25,
      field464Delta: 0.125,
      xChanged: true,
    },
  );

  const lateBaseline = makeContext();
  const lateBaselineFixture = seedActiveXWing(lateBaseline);
  recordNeutralBaseline(lateBaseline, lateBaselineFixture, { cycle: 105 });
  applyHostLeft(lateBaseline, lateBaselineFixture);
  publishLeft(lateBaseline);
  lateBaseline.sampleRogueLeaderGameplayInput(120);
  assert.equal(
    lateBaseline.inspectRogueLeaderGameState().lastActiveGameplayInput,
    null,
  );

  const observedCycleBaseline = makeContext();
  const observedCycleFixture = seedActiveXWing(observedCycleBaseline);
  recordNeutralBaseline(observedCycleBaseline, observedCycleFixture, {
    cycle: 103,
  });
  applyHostLeft(observedCycleBaseline, observedCycleFixture);
  publishLeft(observedCycleBaseline);
  observedCycleBaseline.sampleRogueLeaderGameplayInput(120);
  assert.equal(
    observedCycleBaseline.inspectRogueLeaderGameState()
      .lastActiveGameplayInput.cycle,
    120,
  );

  for (const mutateLifetime of [
    (context, fixture) => writeS32(context, fixture.playerManager + 4, 43),
    context => writeS32(context, 0x7fde822c, 1),
  ]) {
    const changedLifetime = makeContext();
    const changedLifetimeFixture = seedActiveXWing(changedLifetime);
    recordNeutralBaseline(changedLifetime, changedLifetimeFixture);
    applyHostLeft(changedLifetime, changedLifetimeFixture);
    publishLeft(changedLifetime);
    changedLifetime.sampleRogueLeaderGameplayInput(120);
    assert.equal(
      changedLifetime.inspectRogueLeaderGameState().receiptLifetimeMatches,
      true,
    );
    mutateLifetime(changedLifetime, changedLifetimeFixture);
    assert.equal(
      changedLifetime.inspectRogueLeaderGameState().receiptLifetimeMatches,
      false,
    );
    changedLifetime.sampleRogueLeaderGameplayInput(130);
    assert.equal(
      changedLifetime.inspectRogueLeaderGameState().lastActiveGameplayInput,
      null,
    );
  }

  const replacedVtable = makeContext();
  const replacedVtableFixture = seedActiveXWing(replacedVtable);
  recordNeutralBaseline(replacedVtable, replacedVtableFixture);
  applyHostLeft(replacedVtable, replacedVtableFixture);
  publishLeft(replacedVtable);
  replacedVtable.sampleRogueLeaderGameplayInput(120);
  writeU32(
    replacedVtable,
    replacedVtableFixture.craft + 0x80,
    0x7fdbe500,
  );
  assert.equal(
    replacedVtable.inspectRogueLeaderGameState().receiptLifetimeMatches,
    false,
  );
  replacedVtable.sampleRogueLeaderGameplayInput(130);
  writeU32(
    replacedVtable,
    replacedVtableFixture.craft + 0x80,
    0x7fdc75b8,
  );
  assert.equal(
    replacedVtable.inspectRogueLeaderGameState().lastActiveGameplayInput,
    null,
  );
  assert.equal(
    replacedVtable.inspectRogueLeaderGameState().guestConsumedHostLeft,
    false,
  );

  const neutralControl = makeContext();
  const neutralControlFixture = seedActiveXWing(neutralControl);
  recordNeutralBaseline(neutralControl, neutralControlFixture);
  applyHostLeft(neutralControl, neutralControlFixture);
  writeF32(neutralControl, neutralControlFixture.craftControl + 8, 0);
  publishLeft(neutralControl);
  neutralControl.sampleRogueLeaderGameplayInput(120);
  assert.equal(
    neutralControl.inspectRogueLeaderGameState().lastActiveGameplayInput,
    null,
  );
});

test("guest diagnostics dispatch Rogue Leader only through exact retail identity", () => {
  const context = makeContext();
  const fixture = seedActiveXWing(context);
  assert.equal(context.inspectGuestGameState().liveXwingControlPath, true);

  recordNeutralBaseline(context, fixture);
  applyHostLeft(context, fixture);
  publishLeft(context);
  context.sampleGuestGameplayInput(120);
  assert.equal(
    context.inspectRogueLeaderGameState().lastActiveGameplayInput.cycle,
    120,
  );

  const other = makeContext("GM8E01", 2);
  assert.equal(other.inspectGuestGameState(), null);
  other.sampleGuestGameplayInput(120);
  assert.equal(other.rogueLeaderLastActiveGameplayInput, null);
});
