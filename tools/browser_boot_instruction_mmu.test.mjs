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
  assert.notEqual(start, -1, `missing ${name} in browser_boot.rs`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);

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
  assert.fail(`unterminated body for ${name}`);
}

const instructionFunctions = [
  "check",
  "batAllowsAccess",
  "translateBatAddress",
  "resolveInstructionEffectiveAddress",
  "readSegmentRegisters",
  "resetTranslationLookasideBuffer",
  "initializeTranslationLookasideBuffers",
  "instructionTlbSetIndex",
  "lookupInstructionTlb",
  "fillInstructionTlb",
  "resolveInstructionTlbEntry",
  "resolveInstructionPageAddress",
  "resolveInstructionTranslation",
  "translateInstructionEffectiveAddress",
  "translateInstructionEffectiveRange",
  "readInstructionBats",
  "translateInstructionAddress",
  "translateInstructionRange",
  "normalizePhysicalMemoryAddress",
  "physicalRamPointer",
  "physicalLockedCachePointer",
  "instructionRamPointer",
  "resolveInstructionFetch",
  "fetchInstructionWord",
  "instructionDiagnostic",
  "currentInstructionTranslationSignature",
  "instructionTranslationKey",
  "instructionBlockKey",
  "instructionRegionKey",
  "compiledBlock",
  "compiledRegion",
  "resetInstructionLinkingState",
  "invalidateAllCompiledCode",
  "synchronizeInstructionAddressSpace",
  "initializePageTableRegisters",
  "interruptDeliveryPendingAtCycle",
  "msrChanged",
  "instructionBatChanged",
  "segmentRegisterChanged",
  "sdr1Changed",
  "fetchWord",
  "regionHookCanContinue",
  "withScopedCycles",
  "withPublishedHookCycles",
  "invokeJitHook",
  "raiseException",
];

function makeContext() {
  const buffer = new ArrayBuffer(1024 * 1024);
  const context = {
    accelerations: new Map(),
    blocks: new Map(),
    bytes: new Uint8Array(buffer),
    cpu: 0,
    ctrOffset: 0x90,
    cycles: 1_000,
    darOffset: 0x88,
    dataFastmemRebuilds: 0,
    dataFastmemMsrSignature: null,
    dispatches: 7,
    exceptionCounts: new Map(),
    exceptionFirstByVector: {},
    exceptionFirstTrace: [],
    exceptionTrace: [],
    firstDsi: null,
    gprOffsets: Array.from({ length: 32 }, (_unused, index) => 0xa0 + index * 4),
    gxFifoStagingMeta: 0x320,
    hookCalls: new Map(),
    hookCycleOffset: 8,
    instructionAddressSpaceGeneration: 0,
    instructionAddressSpaceKey: null,
    instructionAddressSpaceSignature: null,
    instructionDependencyFreeLinkedRegions: new WeakSet(),
    instructionBatOffsets: [
      [0x40, 0x44],
      [0x48, 0x4c],
      [0x50, 0x54],
      [0x58, 0x5c],
    ],
    instructionTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    dataTlbSets: Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 }),
    ),
    instructionTranslationSignature: null,
    instructionTranslationMsrSignature: null,
    lastCpuSignature: 1,
    lastUnmappedAccess: null,
    lastPc: 0x80001000,
    lrOffset: 0x8c,
    lockedCache: 0xc0000,
    lockedCacheSize: 0x4000,
    mmio: 0x80000,
    mmioSize: 0x20000,
    msrOffset: 0x20,
    pcOffset: 0x24,
    physicalMmioBase: 0x0c000000,
    ram: 0x40000,
    ramSize: 0x40000,
    recentPcs: [0x80001000, 0x80001004],
    regionCandidateHits: new Map([["candidate", 3]]),
    regionContinuableHookCalls: 0,
    regionControl: 0x300,
    regionCyclePrefixOffset: 0,
    regionExitRequestOffset: 4,
    regionFusionHits: new Map([["fusion", 2]]),
    regionRunning: false,
    regionsByPc: new Map(),
    samePcCount: 9,
    sdr1Offset: 0x1c0,
    segmentRegisterOffsets: Array.from(
      { length: 16 },
      (_unused, index) => 0x180 + index * 4,
    ),
    srr0Offset: 0x80,
    srr1Offset: 0x84,
    view: new DataView(buffer),
    beginCriticalStorageFault() {},
    observeCriticalStorageFaultHandlerReturn() {},
  };
  context.decrementerPending = false;
  context.runtimeEventDueAtOrBefore = () => false;
  context.rebuildDataFastmem = () => {
    const signature = context.view.getUint32(
      context.cpu + context.msrOffset,
      true,
    ) & 0x4010;
    const changed = context.dataFastmemMsrSignature !== signature;
    context.dataFastmemMsrSignature = signature;
    context.dataFastmemRebuilds += 1;
    return changed;
  };
  context.drainGxFifoStaging = () => {
    context.view.setUint32(context.gxFifoStagingMeta, 0, true);
  };
  context.hex32 = value => "0x" + (value >>> 0).toString(16).padStart(8, "0");
  vm.createContext(context);
  vm.runInContext(
    instructionFunctions.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.instruction-mmu.js" },
  );
  return context;
}

function writeInstructionBat(context, index, upper, lower) {
  const [lowerOffset, upperOffset] = context.instructionBatOffsets[index];
  context.view.setUint32(context.cpu + upperOffset, upper >>> 0, true);
  context.view.setUint32(context.cpu + lowerOffset, lower >>> 0, true);
}

test("browser memory-management layout derives and initializes SR and SDR1 registers", () => {
  assert.match(
    source,
    /let segment_register_offsets = Reg::SR\s*\.map\(\|register\| register\.offset\(\)\.to_string\(\)\)/,
  );
  assert.match(
    source,
    /\.replace\("__SR_OFFSETS__", &segment_register_offsets\)/,
  );
  assert.match(
    source,
    /\.replace\("__SDR1_OFFSET__", &SPR::SDR1\.offset\(\)\.to_string\(\)\)/,
  );
  assert.match(source, /const segmentRegisterOffsets = \[__SR_OFFSETS__\];/);
  assert.match(source, /const sdr1Offset = __SDR1_OFFSET__;/);
  assert.match(
    source,
    /initializePageTableRegisters\(\);\s*initializeMemoryManagement\(\);/,
  );

  const context = makeContext();
  for (const [index, offset] of context.segmentRegisterOffsets.entries()) {
    context.view.setUint32(context.cpu + offset, 0x10000000 + index, true);
  }
  context.view.setUint32(context.cpu + context.sdr1Offset, 0xdeadbeef, true);

  context.initializePageTableRegisters();

  assert.deepEqual(
    context.segmentRegisterOffsets.map(offset =>
      context.view.getUint32(context.cpu + offset, true)
    ),
    Array(16).fill(0),
  );
  assert.equal(
    context.view.getUint32(context.cpu + context.sdr1Offset, true),
    0,
  );
});

test("instruction signatures order MSR, IBATs, SR0..15, and SDR1", () => {
  const context = makeContext();
  const bats = [
    [0x80001fff, 0x00000002],
    [0x90000003, 0x00020001],
    [0xa0000001, 0x00040003],
    [0xfff0001f, 0xfff00001],
  ];
  const segmentRegisters = Array.from(
    { length: 16 },
    (_unused, index) => (0x10000000 + index) >>> 0,
  );
  bats.forEach(([upper, lower], index) => {
    writeInstructionBat(context, index, upper, lower);
  });
  segmentRegisters.forEach((value, index) => {
    context.view.setUint32(
      context.cpu + context.segmentRegisterOffsets[index],
      value,
      true,
    );
  });
  context.view.setUint32(context.cpu + context.sdr1Offset, 0xdeadbeef, true);
  context.view.setUint32(context.cpu + context.msrOffset, 0xffffffff, true);

  assert.deepEqual(
    Array.from(context.currentInstructionTranslationSignature()),
    [0x4020, ...bats.flat(), ...segmentRegisters, 0xdeadbeef],
  );
});

test("instruction BAT translation honors IR, privilege validity, and read protection", () => {
  const context = makeContext();
  const supervisor = [0x90000002, 0x00020001];
  const user = [0x90000001, 0x00020002];
  const both = [0x90000003, 0x00020003];

  assert.equal(
    context.translateInstructionEffectiveAddress(0x90001234, 0, []),
    0x90001234,
    "IR-off instruction addresses are physical identities",
  );
  assert.equal(
    context.translateInstructionEffectiveAddress(0x90001234, 0x20, [supervisor]),
    0x00021234,
  );
  assert.equal(
    context.translateInstructionEffectiveAddress(0x90001234, 0x4020, [supervisor]),
    null,
  );
  assert.equal(
    context.translateInstructionEffectiveAddress(0x90001234, 0x20, [user]),
    null,
  );
  assert.equal(
    context.translateInstructionEffectiveAddress(0x90001234, 0x4020, [user]),
    0x00021234,
  );
  assert.equal(
    context.translateInstructionEffectiveAddress(0x90001234, 0x20, [both]),
    0x00021234,
  );
  assert.equal(
    context.translateInstructionEffectiveAddress(0x90001234, 0x4020, [both]),
    0x00021234,
  );

  for (const protection of [0, 1, 2, 3]) {
    assert.equal(
      context.translateInstructionEffectiveAddress(
        0x90001234,
        0x20,
        [[0x90000003, 0x00020000 | protection]],
      ),
      protection === 0 ? null : 0x00021234,
      `instruction PP=${protection}`,
    );
  }
});

test("instruction ranges preserve one contiguous physical mapping", () => {
  const context = makeContext();
  const contiguous = [
    [0x90000002, 0x00000001],
    [0x90020002, 0x00020001],
  ];
  const discontiguous = [
    contiguous[0],
    [0x90020002, 0x00040001],
  ];

  assert.equal(
    context.translateInstructionEffectiveRange(0x9001fff0, 0x40, 0x20, contiguous),
    0x0001fff0,
  );
  assert.equal(
    context.translateInstructionEffectiveRange(
      0x9001fff0,
      0x40,
      0x20,
      discontiguous,
    ),
    null,
  );
  assert.equal(
    context.translateInstructionEffectiveRange(0xfffffff0, 0x20, 0, []),
    null,
  );
  assert.equal(
    context.translateInstructionEffectiveRange(0x1000, 0, 0, []),
    null,
  );
});

test("IBAT register reads retain architectural upper/lower ordering", () => {
  const context = makeContext();
  const bats = [
    [0x80001fff, 0x00000002],
    [0x90000003, 0x00020001],
    [0xa0000001, 0x00040003],
    [0xfff0001f, 0xfff00001],
  ];
  bats.forEach(([upper, lower], index) => {
    writeInstructionBat(context, index, upper, lower);
  });

  assert.deepEqual(
    Array.from(context.readInstructionBats(), bat => Array.from(bat)),
    bats,
  );
});

test("fetches follow translated physical RAM instead of legacy RAM aliases", () => {
  const context = makeContext();
  writeInstructionBat(context, 0, 0x80000003, 0x00020002);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(context, index, 0, 0);
  }
  context.view.setUint32(context.cpu + context.msrOffset, 0x20, true);

  const effective = 0x80001234;
  const physical = 0x00021234;
  context.view.setUint32(context.ram + 0x1234, 0x11111111, false);
  context.view.setUint32(context.ram + physical, 0x22222222, false);

  assert.equal(context.translateInstructionAddress(effective), physical);
  assert.equal(context.translateInstructionRange(effective, 4), physical);
  assert.equal(
    context.instructionRamPointer(effective, 4),
    context.ram + physical,
  );
  assert.equal(context.fetchWord(effective), 0x22222222);

  context.view.setUint32(context.cpu + context.msrOffset, 0, true);
  assert.equal(context.translateInstructionAddress(physical), physical);
  assert.equal(context.fetchWord(physical), 0x22222222);
  assert.equal(context.instructionRamPointer(effective, 4), null);
});

test("stable instruction namespaces isolate IR, PR, and IBAT mappings", () => {
  const context = makeContext();
  writeInstructionBat(context, 0, 0x80001fff, 0x00000002);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(context, index, 0, 0);
  }
  context.view.setUint32(context.cpu + context.msrOffset, 0x30, true);

  assert.equal(context.synchronizeInstructionAddressSpace("initialize"), true);
  assert.equal(context.instructionAddressSpaceGeneration, 1);
  const supervisorKey = context.instructionBlockKey(0x80001000);
  const supervisorRegionKey = context.instructionRegionKey(0x80001000);
  const supervisorRegion = { pcs: [0x80001000] };
  context.blocks.set(supervisorKey, { mapping: "supervisor" });
  context.regionsByPc.set(supervisorRegionKey, supervisorRegion);
  context.instructionDependencyFreeLinkedRegions.add(supervisorRegion);

  assert.equal(context.blocks.get(supervisorKey).mapping, "supervisor");
  assert.equal(context.regionsByPc.has(supervisorRegionKey), true);
  assert.equal(context.regionCandidateHits.size, 0);
  assert.equal(context.regionFusionHits.size, 0);
  assert.deepEqual(Array.from(context.recentPcs), []);

  context.view.setUint32(context.cpu + context.msrOffset, 0x8030, true);
  assert.equal(context.synchronizeInstructionAddressSpace("ee-only"), false);
  assert.equal(context.instructionAddressSpaceGeneration, 1);
  assert.equal(context.blocks.size, 1, "EE-only changes retain compiled code");
  assert.equal(context.instructionBlockKey(0x80001000), supervisorKey);

  context.view.setUint32(context.cpu + context.msrOffset, 0x8010, true);
  assert.equal(context.synchronizeInstructionAddressSpace("ir-off"), true);
  const physicalKey = context.instructionBlockKey(0x80001000);
  assert.notEqual(physicalKey, supervisorKey);
  assert.equal(context.blocks.has(physicalKey), false);
  assert.equal(context.blocks.has(supervisorKey), true);

  context.view.setUint32(context.cpu + context.msrOffset, 0xc030, true);
  assert.equal(context.synchronizeInstructionAddressSpace("user"), true);
  const userKey = context.instructionBlockKey(0x80001000);
  assert.notEqual(userKey, supervisorKey);
  assert.notEqual(userKey, physicalKey);
  const generationAfterIrAndPr = context.instructionAddressSpaceGeneration;
  assert.equal(generationAfterIrAndPr, 3);

  context.view.setUint32(context.cpu + context.msrOffset, 0x8030, true);
  assert.equal(context.synchronizeInstructionAddressSpace("supervisor-again"), true);
  assert.equal(
    context.instructionBlockKey(0x80001000),
    supervisorKey,
    "returning to an identical mapping reuses its stable namespace",
  );
  assert.equal(context.blocks.get(supervisorKey).mapping, "supervisor");

  writeInstructionBat(context, 0, 0x90000003, 0x00020002);
  assert.equal(context.synchronizeInstructionAddressSpace("ibat", true), true);
  assert.equal(
    context.instructionAddressSpaceGeneration,
    generationAfterIrAndPr + 2,
  );
  assert.equal(context.blocks.size, 0);
  assert.equal(context.regionsByPc.size, 0);
  assert.equal(
    context.instructionDependencyFreeLinkedRegions.has(supervisorRegion),
    false,
  );
  assert.notEqual(context.instructionBlockKey(0x80001000), supervisorKey);
});

test("SR and SDR1 barriers switch stable namespaces without clearing compiled code", () => {
  const context = makeContext();
  const pc = 0x80001000;
  writeInstructionBat(context, 0, 0x80001fff, 0x00000002);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(context, index, 0, 0);
  }
  context.initializePageTableRegisters();
  context.view.setUint32(context.cpu + context.msrOffset, 0x30, true);

  assert.equal(context.synchronizeInstructionAddressSpace("initial"), true);
  const initialKey = context.instructionAddressSpaceKey;
  const initialBlock = { mapping: "initial" };
  const initialRegion = { mapping: "initial", pcs: [pc] };
  context.blocks.set(context.instructionBlockKey(pc), initialBlock);
  context.regionsByPc.set(context.instructionRegionKey(pc), initialRegion);

  context.view.setUint32(
    context.cpu + context.segmentRegisterOffsets[7],
    0x12345678,
    true,
  );
  context.segmentRegisterChanged();
  const segmentKey = context.instructionAddressSpaceKey;
  assert.notEqual(segmentKey, initialKey);
  assert.equal(context.blocks.size, 1);
  assert.equal(context.regionsByPc.size, 1);
  assert.equal(context.compiledBlock(pc), undefined);
  const segmentBlock = { mapping: "segment" };
  context.blocks.set(context.instructionBlockKey(pc), segmentBlock);

  context.view.setUint32(context.cpu + context.sdr1Offset, 0x00010000, true);
  context.sdr1Changed();
  assert.notEqual(context.instructionAddressSpaceKey, segmentKey);
  assert.equal(context.blocks.size, 2);
  assert.equal(context.regionsByPc.size, 1);

  context.view.setUint32(context.cpu + context.sdr1Offset, 0, true);
  context.sdr1Changed();
  assert.equal(context.instructionAddressSpaceKey, segmentKey);
  assert.equal(context.compiledBlock(pc), segmentBlock);

  context.view.setUint32(
    context.cpu + context.segmentRegisterOffsets[7],
    0,
    true,
  );
  context.segmentRegisterChanged();
  assert.equal(context.instructionAddressSpaceKey, initialKey);
  assert.equal(context.compiledBlock(pc), initialBlock);
  assert.equal(context.compiledRegion(pc), initialRegion);
  assert.equal(context.blocks.size, 2, "namespace switches must not globally clear blocks");
  assert.equal(context.regionsByPc.size, 1);

  for (const name of ["segmentRegisterChanged", "sdr1Changed"]) {
    assert.doesNotMatch(extractFunction(name), /invalidateAllCompiledCode/);
  }
});

test("exception entry switches namespaces before vector lookup and reuses the prior namespace on return", () => {
  const context = makeContext();
  const oldPc = 0x80001000;
  const vector = 0x00000500;
  const oldMsr = 0x00008030;
  writeInstructionBat(context, 0, 0x80001fff, 0x00000002);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(context, index, 0, 0);
  }
  context.view.setUint32(context.ram + 0x1000, 0x60000000, false);
  context.view.setUint32(context.ram + vector, 0x4c000064, false);

  context.view.setUint32(context.cpu + context.msrOffset, oldMsr, true);
  context.view.setUint32(context.cpu + context.pcOffset, oldPc, true);
  assert.equal(context.synchronizeInstructionAddressSpace("supervisor"), true);
  const supervisorKey = context.instructionAddressSpaceKey;
  const resumeBlock = { mapping: "translated-resume" };
  const supervisorVectorBlock = { mapping: "translated-vector" };
  context.blocks.set(context.instructionBlockKey(oldPc), resumeBlock);
  context.blocks.set(context.instructionBlockKey(vector), supervisorVectorBlock);

  context.view.setUint32(context.cpu + context.msrOffset, 0, true);
  assert.equal(context.synchronizeInstructionAddressSpace("exception-seed"), true);
  const exceptionKey = context.instructionAddressSpaceKey;
  const exceptionVectorBlock = { mapping: "physical-vector" };
  context.blocks.set(context.instructionBlockKey(vector), exceptionVectorBlock);

  context.view.setUint32(context.cpu + context.msrOffset, oldMsr, true);
  assert.equal(context.synchronizeInstructionAddressSpace("supervisor-again"), true);
  assert.equal(context.instructionAddressSpaceKey, supervisorKey);

  const transitions = [];
  const synchronize = context.synchronizeInstructionAddressSpace;
  context.synchronizeInstructionAddressSpace = (...arguments_) => {
    const transition = {
      pcBefore: context.view.getUint32(context.cpu + context.pcOffset, true),
      msrBefore: context.view.getUint32(context.cpu + context.msrOffset, true),
      reason: arguments_[0],
    };
    const changed = synchronize(...arguments_);
    transition.keyAfter = context.instructionAddressSpaceKey;
    transitions.push(transition);
    return changed;
  };

  context.raiseException(context.cpu, vector);
  assert.deepEqual(transitions, [{
    pcBefore: oldPc,
    msrBefore: 0,
    reason: "exception",
    keyAfter: exceptionKey,
  }]);
  assert.equal(context.view.getUint32(context.cpu + context.pcOffset, true), vector);
  assert.equal(context.compiledBlock(vector), exceptionVectorBlock);
  assert.notEqual(context.compiledBlock(vector), supervisorVectorBlock);

  context.view.setUint32(context.cpu + context.msrOffset, oldMsr, true);
  context.msrChanged();
  assert.equal(
    context.instructionAddressSpaceKey,
    supervisorKey,
    "an rfi-like return to the same MSR and IBAT state must reuse its namespace",
  );
  assert.equal(context.compiledBlock(oldPc), resumeBlock);
});

test("EE-only MSR hooks skip both translation signature builders", () => {
  const context = makeContext();
  context.view.setUint32(context.cpu + context.msrOffset, 0x00008030, true);
  context.rebuildDataFastmem();
  context.synchronizeInstructionAddressSpace("seed");

  let dataSynchronizations = 0;
  let instructionSynchronizations = 0;
  let handlerReturnObservations = 0;
  const rebuildDataFastmem = context.rebuildDataFastmem;
  const synchronizeInstructionAddressSpace =
    context.synchronizeInstructionAddressSpace;
  context.rebuildDataFastmem = () => {
    dataSynchronizations += 1;
    return rebuildDataFastmem();
  };
  context.synchronizeInstructionAddressSpace = (...arguments_) => {
    instructionSynchronizations += 1;
    return synchronizeInstructionAddressSpace(...arguments_);
  };
  context.observeCriticalStorageFaultHandlerReturn = () => {
    handlerReturnObservations += 1;
  };

  context.view.setUint32(context.cpu + context.msrOffset, 0x00000030, true);
  assert.equal(context.msrChanged(), 1, "EE disable may remain linked");
  assert.deepEqual(
    { dataSynchronizations, instructionSynchronizations },
    { dataSynchronizations: 0, instructionSynchronizations: 0 },
  );
  assert.equal(handlerReturnObservations, 1);

  context.view.setUint32(context.cpu + context.msrOffset, 0x00008030, true);
  context.runtimeEventDueAtOrBefore = () => true;
  assert.equal(
    context.msrChanged(),
    0,
    "EE enable still exits when an event is due",
  );
  assert.deepEqual(
    { dataSynchronizations, instructionSynchronizations },
    { dataSynchronizations: 0, instructionSynchronizations: 0 },
    "interrupt-only hooks must not rebuild translation arrays",
  );
  assert.equal(
    handlerReturnObservations,
    2,
    "fault-return health remains observable on the fast path",
  );
});

test("MSR translation masks rebuild exactly the affected address spaces", () => {
  const cases = [
    {
      label: "first call",
      seed: false,
      target: 0x00008030,
      dataSynchronizations: 1,
      instructionSynchronizations: 1,
    },
    {
      label: "DR only",
      seed: true,
      target: 0x00008020,
      dataSynchronizations: 1,
      instructionSynchronizations: 0,
    },
    {
      label: "IR only",
      seed: true,
      target: 0x00008010,
      dataSynchronizations: 0,
      instructionSynchronizations: 1,
    },
    {
      label: "PR",
      seed: true,
      target: 0x0000c030,
      dataSynchronizations: 1,
      instructionSynchronizations: 1,
    },
  ];

  for (const expected of cases) {
    const context = makeContext();
    context.view.setUint32(context.cpu + context.msrOffset, 0x00008030, true);
    if (expected.seed) {
      context.rebuildDataFastmem();
      context.synchronizeInstructionAddressSpace("seed");
    }
    let dataSynchronizations = 0;
    let instructionSynchronizations = 0;
    const rebuildDataFastmem = context.rebuildDataFastmem;
    const synchronizeInstructionAddressSpace =
      context.synchronizeInstructionAddressSpace;
    context.rebuildDataFastmem = () => {
      dataSynchronizations += 1;
      return rebuildDataFastmem();
    };
    context.synchronizeInstructionAddressSpace = (...arguments_) => {
      instructionSynchronizations += 1;
      return synchronizeInstructionAddressSpace(...arguments_);
    };

    context.view.setUint32(
      context.cpu + context.msrOffset,
      expected.target,
      true,
    );
    assert.equal(context.msrChanged(), 0, `${expected.label} must exit`);
    assert.deepEqual(
      { dataSynchronizations, instructionSynchronizations },
      {
        dataSynchronizations: expected.dataSynchronizations,
        instructionSynchronizations: expected.instructionSynchronizations,
      },
      expected.label,
    );
  }
});

test("MSR changes continue only across translation-stable interrupt boundaries", () => {
  const context = makeContext();
  context.view.setUint32(context.cpu + context.msrOffset, 0x00008032, true);
  context.rebuildDataFastmem();
  context.synchronizeInstructionAddressSpace("seed");

  context.view.setUint32(context.cpu + context.msrOffset, 0x00000032, true);
  assert.equal(
    context.msrChanged(),
    1,
    "disabling EE without changing IR/DR may remain inside the linked region",
  );

  context.view.setUint32(context.cpu + context.msrOffset, 0x00008032, true);
  assert.equal(
    context.msrChanged(),
    1,
    "enabling EE without an asserted interrupt or due event may remain linked",
  );

  context.view.setUint32(context.mmio + 0x3000, 0x00000040, false);
  context.view.setUint32(context.mmio + 0x3004, 0x00000040, false);
  assert.equal(
    context.msrChanged(),
    0,
    "a deliverable PI interrupt must exit at the EE-enable boundary",
  );

  context.view.setUint32(context.mmio + 0x3004, 0x00000004, false);
  assert.equal(
    context.msrChanged(),
    1,
    "an asserted but masked PI cause must not become deliverable",
  );

  context.decrementerPending = true;
  assert.equal(
    context.msrChanged(),
    0,
    "a pending decrementer must exit at the EE-enable boundary",
  );
  context.decrementerPending = false;

  context.runtimeEventDueAtOrBefore = observedCycles => observedCycles === 1_000;
  assert.equal(
    context.msrChanged(),
    0,
    "a device event due at the current cycle must reach the post-block pass",
  );
  context.runtimeEventDueAtOrBefore = () => false;

  context.view.setUint32(context.cpu + context.msrOffset, 0x00000022, true);
  assert.equal(
    context.msrChanged(),
    0,
    "a data translation change must leave the linked region",
  );

  context.view.setUint32(context.cpu + context.msrOffset, 0x00000002, true);
  assert.equal(
    context.msrChanged(),
    0,
    "an instruction translation change must leave the linked region",
  );
});

test("EE-enable hooks decide continuation at the linked region's exact published cycle", () => {
  const context = makeContext();
  context.view.setUint32(context.cpu + context.msrOffset, 0x00008032, true);
  context.rebuildDataFastmem();
  context.synchronizeInstructionAddressSpace("seed");
  context.regionRunning = true;
  context.view.setUint32(
    context.regionControl + context.regionCyclePrefixOffset,
    40,
    true,
  );
  context.view.setUint32(
    context.regionControl + context.hookCycleOffset,
    7,
    true,
  );

  const observedCycles = [];
  let eventDue = false;
  context.runtimeEventDueAtOrBefore = cycle => {
    observedCycles.push(cycle);
    return eventDue;
  };
  const target = { user_0_16: () => context.msrChanged() };

  assert.equal(context.invokeJitHook(target, "user_0_16", []), 1);
  assert.deepEqual(observedCycles, [1_047]);
  assert.equal(
    context.view.getUint32(
      context.regionControl + context.regionExitRequestOffset,
      true,
    ),
    0,
    "a future event must not break the linked region",
  );
  assert.equal(context.cycles, 1_000, "the outer scheduler cycle must be restored");

  eventDue = true;
  context.view.setUint32(
    context.regionControl + context.regionExitRequestOffset,
    0,
    true,
  );
  assert.equal(context.invokeJitHook(target, "user_0_16", []), 0);
  assert.deepEqual(observedCycles, [1_047, 1_047]);
  assert.equal(
    context.view.getUint32(
      context.regionControl + context.regionExitRequestOffset,
      true,
    ),
    1,
    "a due event must exit at the exact EE-enable hook cycle",
  );
  assert.equal(context.cycles, 1_000);
});

test("MSR and IBAT hooks synchronously request linked-region exits before the next namespace lookup", () => {
  assert.match(source, /user_0_16:\s*\(\) => msrChanged\(\)/);
  assert.match(source, /user_0_17:\s*\(\) => instructionBatChanged\(\)/);

  const pc = 0x80001000;
  const msrContext = makeContext();
  writeInstructionBat(msrContext, 0, 0x80001fff, 0x00000002);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(msrContext, index, 0, 0);
  }
  msrContext.view.setUint32(msrContext.cpu + msrContext.msrOffset, 0x30, true);
  msrContext.synchronizeInstructionAddressSpace("translated");
  const translatedRegion = { mapping: "translated", pcs: [pc] };
  msrContext.regionsByPc.set(msrContext.instructionRegionKey(pc), translatedRegion);

  msrContext.view.setUint32(msrContext.cpu + msrContext.msrOffset, 0x10, true);
  msrContext.synchronizeInstructionAddressSpace("physical-seed");
  const physicalKey = msrContext.instructionAddressSpaceKey;
  const physicalRegion = { mapping: "physical", pcs: [pc] };
  msrContext.regionsByPc.set(msrContext.instructionRegionKey(pc), physicalRegion);

  msrContext.view.setUint32(msrContext.cpu + msrContext.msrOffset, 0x30, true);
  msrContext.synchronizeInstructionAddressSpace("translated-again");
  assert.equal(msrContext.compiledRegion(pc), translatedRegion);
  msrContext.regionRunning = true;
  msrContext.view.setUint32(
    msrContext.regionControl + msrContext.regionExitRequestOffset,
    0,
    true,
  );
  msrContext.view.setUint32(msrContext.cpu + msrContext.msrOffset, 0x10, true);
  let msrHookKey = null;
  msrContext.invokeJitHook({
    user_0_16() {
      const result = msrContext.msrChanged();
      msrHookKey = msrContext.instructionAddressSpaceKey;
      assert.equal(
        msrContext.view.getUint32(
          msrContext.regionControl + msrContext.regionExitRequestOffset,
          true,
        ),
        0,
        "the hook target runs synchronously before its exit request is published",
      );
      return result;
    },
  }, "user_0_16", []);
  assert.equal(msrHookKey, physicalKey);
  assert.equal(
    msrContext.view.getUint32(
      msrContext.regionControl + msrContext.regionExitRequestOffset,
      true,
    ),
    1,
  );
  assert.equal(msrContext.compiledRegion(pc), physicalRegion);

  const ibatContext = makeContext();
  writeInstructionBat(ibatContext, 0, 0x80001fff, 0x00000002);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(ibatContext, index, 0, 0);
  }
  ibatContext.view.setUint32(ibatContext.cpu + ibatContext.msrOffset, 0x30, true);
  ibatContext.synchronizeInstructionAddressSpace("ibat-a");
  const oldIbatKey = ibatContext.instructionAddressSpaceKey;
  ibatContext.blocks.set(ibatContext.instructionBlockKey(pc), { mapping: "ibat-a" });
  ibatContext.regionsByPc.set(ibatContext.instructionRegionKey(pc), {
    mapping: "ibat-a",
    pcs: [pc],
  });
  ibatContext.regionRunning = true;
  ibatContext.view.setUint32(
    ibatContext.regionControl + ibatContext.regionExitRequestOffset,
    0,
    true,
  );
  writeInstructionBat(ibatContext, 0, 0x80001fff, 0x00020002);
  let ibatHookKey = null;
  ibatContext.invokeJitHook({
    user_0_17() {
      ibatContext.instructionBatChanged();
      ibatHookKey = ibatContext.instructionAddressSpaceKey;
      assert.equal(ibatContext.blocks.size, 0);
      assert.equal(ibatContext.regionsByPc.size, 0);
      assert.equal(
        ibatContext.view.getUint32(
          ibatContext.regionControl + ibatContext.regionExitRequestOffset,
          true,
        ),
        0,
      );
    },
  }, "user_0_17", []);
  assert.notEqual(ibatHookKey, oldIbatKey);
  assert.equal(
    ibatContext.view.getUint32(
      ibatContext.regionControl + ibatContext.regionExitRequestOffset,
      true,
    ),
    1,
  );
  assert.equal(ibatContext.compiledRegion(pc), undefined);
});

test("SR and SDR1 hooks publish namespace changes before requesting a linked-region exit", () => {
  assert.match(source, /user_0_23:\s*\(\) => segmentRegisterChanged\(\)/);
  assert.match(source, /user_0_24:\s*\(\) => sdr1Changed\(\)/);
  assert.match(
    extractFunction("segmentRegisterChanged"),
    /synchronizeInstructionAddressSpace\("sr"\)/,
  );
  assert.match(
    extractFunction("sdr1Changed"),
    /synchronizeInstructionAddressSpace\("sdr1"\)/,
  );

  const context = makeContext();
  writeInstructionBat(context, 0, 0x80001fff, 0x00000002);
  for (let index = 1; index < 4; index += 1) {
    writeInstructionBat(context, index, 0, 0);
  }
  context.initializePageTableRegisters();
  context.view.setUint32(context.cpu + context.msrOffset, 0x30, true);
  context.synchronizeInstructionAddressSpace("initial");
  context.regionRunning = true;

  const barriers = [
    {
      hook: "user_0_23",
      mutate() {
        context.view.setUint32(
          context.cpu + context.segmentRegisterOffsets[3],
          0x456,
          true,
        );
      },
      synchronize: () => context.segmentRegisterChanged(),
    },
    {
      hook: "user_0_24",
      mutate() {
        context.view.setUint32(context.cpu + context.sdr1Offset, 0x10000, true);
      },
      synchronize: () => context.sdr1Changed(),
    },
  ];

  for (const barrier of barriers) {
    const oldKey = context.instructionAddressSpaceKey;
    barrier.mutate();
    context.view.setUint32(
      context.regionControl + context.regionExitRequestOffset,
      0,
      true,
    );
    let callbackKey = null;
    context.invokeJitHook({
      [barrier.hook]() {
        barrier.synchronize();
        callbackKey = context.instructionAddressSpaceKey;
        assert.equal(
          context.view.getUint32(
            context.regionControl + context.regionExitRequestOffset,
            true,
          ),
          0,
          "the barrier callback runs before the proxy publishes its exit request",
        );
      },
    }, barrier.hook, []);
    assert.notEqual(callbackKey, oldKey);
    assert.equal(
      context.view.getUint32(
        context.regionControl + context.regionExitRequestOffset,
        true,
      ),
      1,
    );
  }
});

test("IBAT and MSR hooks synchronize fetch mappings before another block", () => {
  assert.match(source, /user_0_17:\s*\(\) => instructionBatChanged\(\)/);
  assert.match(
    extractFunction("instructionBatChanged"),
    /synchronizeInstructionAddressSpace\("ibat", true\)/,
  );
  assert.match(
    extractFunction("msrChanged"),
    /synchronizeInstructionAddressSpace\("msr"\)/,
  );
  assert.match(extractFunction("msrChanged"), /rebuildDataFastmem\(\)/);

  const fetchWord = extractFunction("fetchWord");
  assert.match(fetchWord, /instructionRamPointer\(pc, 4\)/);
  assert.doesNotMatch(fetchWord, /\bramPointer\(/);

  const signature = extractFunction("currentInstructionTranslationSignature");
  assert.match(signature, /&\s*0x4020/);
  assert.match(signature, /readInstructionBats\(\)/);

  const invalidate = extractFunction("invalidateAllCompiledCode");
  for (const collection of ["blocks", "regionsByPc"]) {
    assert.match(invalidate, new RegExp(`${collection}\\.clear\\(\\)`));
  }
  assert.match(invalidate, /resetInstructionLinkingState\(\)/);
  const resetLinking = extractFunction("resetInstructionLinkingState");
  for (const collection of ["regionCandidateHits", "regionFusionHits"]) {
    assert.match(resetLinking, new RegExp(`${collection}\\.clear\\(\\)`));
  }
  assert.match(resetLinking, /recentPcs\.length\s*=\s*0/);

  assert.match(extractFunction("instructionBlockKey"), /instructionAddressSpaceKey/);
  assert.match(extractFunction("instructionRegionKey"), /instructionBlockKey\(effectivePc\)/);
  assert.match(
    extractFunction("compiledBlock"),
    /blocks\.get\(instructionBlockKey\(effectivePc\)\)/,
    "block lookup must include the current instruction namespace",
  );
  assert.match(source, /let block = compiledBlock\(pc\)/);
  assert.match(
    source,
    /blocks\.set\(instructionBlockKey\(pc\), block\)/,
    "compiled blocks must be stored in the current instruction namespace",
  );
  assert.match(
    extractFunction("compiledRegion"),
    /regionsByPc\.get\(instructionRegionKey\(effectivePc\)\)/,
    "linked regions must include the current instruction namespace",
  );
  assert.match(source, /const retainedRegion = compiledRegion\(pc\)/);
  assert.match(
    source,
    /const region = retainedRegion !== undefined\s*&& warioWareNextMicrogameOverrideRegionSafe\(\s*retainedRegion,\s*wariowareNextMicrogameOverride,\s*wariowareActiveMicrogameId\s*\)\s*&& luigisMansionGxLoadTexMtxImmProbeRegionSafe\(retainedRegion\)\s*&& compiledRegionIsExecutable\(retainedRegion\)/,
    "a retained region must pass translation-dependency validation before execution",
  );
});
