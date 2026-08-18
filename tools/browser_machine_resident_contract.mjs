import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const RESIDENT_MEMORY_INITIAL_PAGES = 720;
const RESIDENT_MEMORY_MAXIMUM_PAGES = 2048;

const [corePath, fixtureDirectory] = process.argv.slice(2);
if (!corePath || !fixtureDirectory) {
  process.stderr.write(
    "usage: browser_machine_resident_contract.mjs <browser_machine.wasm> <fixture-directory>\n",
  );
  process.exit(2);
}

const directory = resolve(fixtureDirectory);
const [
  coreBytes,
  dispatcherBytes,
  blockABytes,
  blockBBytes,
  authorityBytes,
  deviceBlockABytes,
  deviceBlockBBytes,
  deviceRegionBytes,
  fixture,
] = await Promise.all([
  readFile(corePath),
  readFile(resolve(directory, "dispatcher.wasm")),
  readFile(resolve(directory, "block-a.wasm")),
  readFile(resolve(directory, "block-b.wasm")),
  readFile(resolve(directory, "install-authority.wasm")),
  readFile(resolve(directory, "device-block-a.wasm")),
  readFile(resolve(directory, "device-block-b.wasm")),
  readFile(resolve(directory, "device-region.wasm")),
  readFile(resolve(directory, "fixture.json"), "utf8").then(JSON.parse),
]);

const memory = new WebAssembly.Memory({
  initial: RESIDENT_MEMORY_INITIAL_PAGES,
  maximum: RESIDENT_MEMORY_MAXIMUM_PAGES,
});
const coreModule = new WebAssembly.Module(coreBytes);
const core = new WebAssembly.Instance(coreModule, { lazuli: { memory } }).exports;
if (core.core_init() !== 1) throw new Error("Rust browser machine failed to initialize");

const dispatcherModule = new WebAssembly.Module(dispatcherBytes);
const dispatcherImports = WebAssembly.Module.imports(dispatcherModule);
const expectedDispatcherImports = [
  { module: "lazuli", name: "memory", kind: "memory" },
  {
    module: "lazuli",
    name: "validate_instruction_page_dependency",
    kind: "function",
  },
];
if (JSON.stringify(dispatcherImports) !== JSON.stringify(expectedDispatcherImports)) {
  throw new Error(`resident dispatcher imports escaped Rust: ${JSON.stringify(dispatcherImports)}`);
}
const dispatcher = new WebAssembly.Instance(dispatcherModule, {
  lazuli: {
    memory,
    validate_instruction_page_dependency: core.validate_instruction_page_dependency,
  },
}).exports;

const authorityModule = new WebAssembly.Module(authorityBytes);
if (WebAssembly.Module.imports(authorityModule).length !== 0) {
  throw new Error("Rust fixture install authority unexpectedly imports host behavior");
}
const authority = new WebAssembly.Instance(authorityModule, {}).exports;

function instantiateRegisterBlock(bytes) {
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const expected = [
    { module: "lazuli", name: "memory", kind: "memory" },
    { module: "lazuli", name: "begin_resident_block_install", kind: "function" },
    { module: "lazuli", name: "commit_resident_block_install", kind: "function" },
    { module: "lazuli", name: "blocks", kind: "table" },
  ];
  if (JSON.stringify(imports) !== JSON.stringify(expected)) {
    throw new Error(`register-only resident block has semantic host imports: ${JSON.stringify(imports)}`);
  }
  return new WebAssembly.Instance(module, {
    lazuli: {
      memory,
      begin_resident_block_install: authority.begin_resident_block_install,
      commit_resident_block_install: authority.commit_resident_block_install,
      blocks: dispatcher.blocks,
    },
  }).exports;
}

const blockA = instantiateRegisterBlock(blockABytes);
const blockB = instantiateRegisterBlock(blockBBytes);
if (blockA.install() !== 0x4c5a434d || blockB.install() !== 0x4c5a434d) {
  throw new Error("Rust-authored resident blocks did not self-install exactly once");
}

const context = core.core_context_ptr();
const cpu = core.core_cpu_ptr();
const fastmem = core.core_fastmem_ptr();
if (!context || !cpu || !fastmem) throw new Error("Rust machine did not expose resident pointers");
const view = new DataView(memory.buffer);
if (view.getUint32(cpu + fixture.pcOffset, true) !== fixture.initialPc) {
  throw new Error("resident fixture does not start at the Rust machine's real IPL reset PC");
}

const result = dispatcher.run(
  context,
  cpu,
  fastmem,
  fixture.pcOffset,
  context,
  fixture.generation >>> 0,
  0,
  BigInt(fixture.expectedCycles),
  fixture.blockCount,
);
const [instructions, cycles, blocks, reason] = result;
if (instructions !== BigInt(fixture.expectedInstructions) ||
    cycles !== BigInt(fixture.expectedCycles) ||
    blocks !== fixture.blockCount ||
    reason !== fixture.expectedReason) {
  throw new Error(`resident run mismatch: ${JSON.stringify({
    instructions: instructions.toString(),
    cycles: cycles.toString(),
    blocks,
    reason,
  })}`);
}

const observed = {
  pc: view.getUint32(cpu + fixture.pcOffset, true),
  r3: view.getUint32(cpu + fixture.r3Offset, true),
  r4: view.getUint32(cpu + fixture.r4Offset, true),
};
if (observed.pc !== fixture.expectedPc ||
    observed.r3 !== fixture.expectedR3 ||
    observed.r4 !== fixture.expectedR4) {
  throw new Error(`resident blocks did not update the Rust-owned CPU exactly: ${JSON.stringify(observed)}`);
}

function instantiateMachineBlock(bytes) {
  const module = new WebAssembly.Module(bytes);
  const namespace = { memory };
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.module !== "lazuli") {
      throw new Error(`resident device block escaped Rust/Wasm: ${item.module}.${item.name}`);
    }
    if (item.kind === "function") {
      const imported = core[item.name];
      if (typeof imported !== "function") {
        throw new Error(`browser-machine is missing resident hook ${item.name}`);
      }
      namespace[item.name] = imported;
    }
  }
  return new WebAssembly.Instance(module, { lazuli: namespace }).exports;
}

const deviceBlockA = instantiateMachineBlock(deviceBlockABytes);
const deviceBlockB = instantiateMachineBlock(deviceBlockBBytes);
const deviceRegionModule = new WebAssembly.Module(deviceRegionBytes);
const deviceRegion = new WebAssembly.Instance(deviceRegionModule, {
  lazuli: { memory },
  lazuli_blocks: { b0: deviceBlockA.run, b1: deviceBlockB.run },
}).exports;

function readPlan(pointer) {
  if (!pointer || view.getUint32(pointer, true) !== 0x4c5a5250 ||
      view.getUint32(pointer + 4, true) !== 64) {
    throw new Error(`Rust did not publish a sealed run plan at 0x${pointer.toString(16)}`);
  }
  return {
    pointer,
    token: view.getBigUint64(pointer + 8, true),
    context: view.getUint32(pointer + 16, true),
    cpu: view.getUint32(pointer + 20, true),
    fastmem: view.getUint32(pointer + 24, true),
    pcOffset: view.getUint32(pointer + 28, true),
    control: view.getUint32(pointer + 32, true),
    cycleBudget: Number(view.getBigUint64(pointer + 48, true)),
    blockBudget: view.getUint32(pointer + 56, true),
  };
}

function beginDeviceSlice(cycleCap, blockCap) {
  return readPlan(core.core_begin_slice(BigInt(cycleCap), blockCap));
}

function runDeviceRegion(plan) {
  return deviceRegion.run(
    plan.context,
    plan.cpu,
    plan.fastmem,
    plan.pcOffset,
    plan.control,
    plan.cycleBudget,
    plan.blockBudget,
  );
}

const mainRam = core.core_main_ram_offset();
const hashedStoreValue = 0xa1b2c3d4;
view.setUint32(cpu + fixture.pcOffset, fixture.deviceTestPc, true);
view.setUint32(cpu + fixture.r3Offset, fixture.hashedEffective, true);
view.setUint32(cpu + fixture.r4Offset, hashedStoreValue, true);
view.setUint32(cpu + fixture.r5Offset, 0, true);
view.setUint32(cpu + fixture.msrOffset, fixture.translatedMsr, true);
view.setUint32(cpu + fixture.srOffset, fixture.hashedSegment, true);
view.setUint32(cpu + fixture.sdr1Offset, 0, true);
view.setUint32(mainRam + fixture.primaryPteg, fixture.primaryPte0, false);
view.setUint32(mainRam + fixture.primaryPteg + 4, fixture.primaryPte1, false);

const hashedPlan = beginDeviceSlice(500, 2);
const hashedResult = runDeviceRegion(hashedPlan);
const expectedHashed = [
  fixture.deviceBlockAInstructions + fixture.deviceBlockBInstructions,
  fixture.deviceBlockACycles + fixture.deviceBlockBCycles,
  2,
];
if (JSON.stringify(hashedResult) !== JSON.stringify(expectedHashed) ||
    view.getUint32(cpu + fixture.r5Offset, true) !== 1 ||
    view.getUint32(mainRam + fixture.hashedPhysical, false) !== hashedStoreValue) {
  throw new Error(`hashed slow RAM did not stay resident across block two: ${JSON.stringify({
    result: hashedResult,
    marker: view.getUint32(cpu + fixture.r5Offset, true),
    stored: view.getUint32(mainRam + fixture.hashedPhysical, false),
  })}`);
}
core.core_finish_slice(
  hashedPlan.token,
  BigInt(expectedHashed[0]),
  BigInt(expectedHashed[1]),
  expectedHashed[2],
  0,
);

view.setUint32(cpu + fixture.pcOffset, fixture.deviceTestPc, true);
view.setUint32(cpu + fixture.r3Offset, fixture.siCommControl, true);
view.setUint32(cpu + fixture.r4Offset, 1, true);
view.setUint32(cpu + fixture.r5Offset, 0, true);
view.setUint32(cpu + fixture.msrOffset, 0, true);
const devicePlan = beginDeviceSlice(500, 2);
const deviceResult = runDeviceRegion(devicePlan);
const expectedDevice = [fixture.deviceBlockAInstructions, fixture.deviceBlockACycles, 1];
if (JSON.stringify(deviceResult) !== JSON.stringify(expectedDevice) ||
    view.getUint32(cpu + fixture.r5Offset, true) !== 0 ||
    view.getUint32(cpu + fixture.pcOffset, true) !== fixture.deviceTestPc + 8) {
  throw new Error(`MMIO did not exit before block two: ${JSON.stringify({
    result: deviceResult,
    marker: view.getUint32(cpu + fixture.r5Offset, true),
    pc: view.getUint32(cpu + fixture.pcOffset, true),
  })}`);
}
core.core_finish_slice(
  devicePlan.token,
  BigInt(expectedDevice[0]),
  BigInt(expectedDevice[1]),
  expectedDevice[2],
  6,
);

const deadlinePlan = beginDeviceSlice(1_000, 10);
const expectedSiBudget = 200 - fixture.deviceBlockACycles;
if (deadlinePlan.cycleBudget !== expectedSiBudget) {
  throw new Error(
    `SI transfer did not publish its newly earlier Rust deadline: ` +
      `${deadlinePlan.cycleBudget} vs ${expectedSiBudget}`,
  );
}

process.stdout.write(`${JSON.stringify({
  imports: dispatcherImports,
  instructions: instructions.toString(),
  cycles: cycles.toString(),
  blocks,
  reason,
  cpu: observed,
  hostCalls: 1,
  temporaryHostTableSets: 0,
  residentDevices: {
    hashedSlowRamBlocks: hashedResult[2],
    mmioBlocks: deviceResult[2],
    siDeadlineBudget: deadlinePlan.cycleBudget,
  },
})}\n`);
