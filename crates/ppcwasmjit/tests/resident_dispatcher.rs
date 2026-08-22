use std::process::Command;
use std::{env, fs};

use gekko::disasm::{Extensions, Ins};
use gekko::{GPR, Reg};
use lazuli_abi::memory as shared_memory;
use ppcwasmjit::{
    DISPATCH_CACHE_WAYS, DISPATCH_DEPENDENCY_VALIDATOR_IMPORT,
    DISPATCH_ENTRY_DEPENDENCY_COUNT_OFFSET, DISPATCH_ENTRY_SIZE, DISPATCH_ENTRY_TABLE_SLOT_OFFSET,
    DispatchReason, DispatcherConfig, DispatcherDependency, DispatcherEntry, DispatcherError,
    DispatcherSlotIdentity, Jit, build_resident_dispatcher, resident_dispatcher_set_index,
};
use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction, MemArg, MemoryType, Module, TypeSection, ValType,
};
use wasmparser::{Parser, Payload, TypeRef, Validator};

fn d_form(opcode: u32, rt_or_rs: u8, ra: u8, immediate: u16) -> Ins {
    let code =
        opcode << 26 | u32::from(rt_or_rs) << 21 | u32::from(ra) << 16 | u32::from(immediate);
    Ins::new(code, Extensions::gekko_broadway())
}

fn addi(rd: u8, ra: u8, immediate: i16) -> Ins {
    d_form(14, rd, ra, immediate as u16)
}

fn branch(displacement: i32) -> Ins {
    let code = 18 << 26 | (displacement as u32 & 0x03ff_fffc);
    Ins::new(code, Extensions::gekko_broadway())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

const DEPENDENCY_A0: DispatcherDependency = DispatcherDependency {
    effective_page: 0x8000_1000,
    physical_page: 0x0000_1000,
};
const DEPENDENCY_A1: DispatcherDependency = DispatcherDependency {
    effective_page: 0x8000_2000,
    physical_page: 0x0000_2000,
};
const DEPENDENCY_B0: DispatcherDependency = DispatcherDependency {
    effective_page: 0x8000_3000,
    physical_page: 0x0000_3000,
};
const VALIDATOR_CALL_COUNT: u32 = 0x1800;
const VALIDATOR_TRIGGER_CALL: u32 = 0x1804;
const VALIDATOR_TRIGGER_MAPPING_INDEX: u32 = 0x1808;
const VALIDATOR_TRIGGER_NEW_PHYSICAL: u32 = 0x180c;
const VALIDATOR_MAPPING_BASE: u32 = 0x1820;
const VALIDATOR_LOG_BASE: u32 = 0x2000;

/// Rust-generated stand-in for the future Lazuli core export. It owns a small effective-to-
/// physical map in shared memory, records every call, and can mutate one mapping after a chosen
/// call so the dispatcher test can create drift without executing JavaScript inside `run`.
fn dependency_validator(mapping_count: u32) -> Vec<u8> {
    fn memarg(offset: u32) -> MemArg {
        MemArg {
            offset: u64::from(offset),
            align: 2,
            memory_index: 0,
        }
    }

    let mut types = TypeSection::new();
    types
        .ty()
        .function([ValType::I32, ValType::I32], [ValType::I32]);
    let mut imports = ImportSection::new();
    imports.import(
        "lazuli",
        "memory",
        EntityType::Memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );
    let mut functions = FunctionSection::new();
    functions.function(0);
    let mut exports = ExportSection::new();
    exports.export(DISPATCH_DEPENDENCY_VALIDATOR_IMPORT, ExportKind::Func, 0);

    // Parameters 0..=1 are effective/physical. Locals 2..=5 are the zero-based call index,
    // mapping index, mapping-record pointer, and result.
    const CALL_INDEX: u32 = 2;
    const MAPPING_INDEX: u32 = 3;
    const MAPPING_RECORD: u32 = 4;
    const RESULT: u32 = 5;
    let mut body = Function::new([(4, ValType::I32)]);

    body.instruction(&Instruction::I32Const(VALIDATOR_CALL_COUNT as i32));
    body.instruction(&Instruction::I32Load(memarg(0)));
    body.instruction(&Instruction::LocalSet(CALL_INDEX));

    // Append (effective, expected physical) to the validator's observable side-effect log.
    body.instruction(&Instruction::I32Const(VALIDATOR_LOG_BASE as i32));
    body.instruction(&Instruction::LocalGet(CALL_INDEX));
    body.instruction(&Instruction::I32Const(3));
    body.instruction(&Instruction::I32Shl);
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalGet(0));
    body.instruction(&Instruction::I32Store(memarg(0)));
    body.instruction(&Instruction::I32Const(VALIDATOR_LOG_BASE as i32));
    body.instruction(&Instruction::LocalGet(CALL_INDEX));
    body.instruction(&Instruction::I32Const(3));
    body.instruction(&Instruction::I32Shl);
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalGet(1));
    body.instruction(&Instruction::I32Store(memarg(4)));
    body.instruction(&Instruction::I32Const(VALIDATOR_CALL_COUNT as i32));
    body.instruction(&Instruction::LocalGet(CALL_INDEX));
    body.instruction(&Instruction::I32Const(1));
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::I32Store(memarg(0)));

    // Probe the tiny core-owned page map. Unknown pages return false.
    body.instruction(&Instruction::Block(BlockType::Empty));
    body.instruction(&Instruction::Loop(BlockType::Empty));
    body.instruction(&Instruction::LocalGet(MAPPING_INDEX));
    body.instruction(&Instruction::I32Const(mapping_count as i32));
    body.instruction(&Instruction::I32GeU);
    body.instruction(&Instruction::BrIf(1));
    body.instruction(&Instruction::I32Const(VALIDATOR_MAPPING_BASE as i32));
    body.instruction(&Instruction::LocalGet(MAPPING_INDEX));
    body.instruction(&Instruction::I32Const(3));
    body.instruction(&Instruction::I32Shl);
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalTee(MAPPING_RECORD));
    body.instruction(&Instruction::I32Load(memarg(0)));
    body.instruction(&Instruction::LocalGet(0));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::If(BlockType::Empty));
    body.instruction(&Instruction::LocalGet(MAPPING_RECORD));
    body.instruction(&Instruction::I32Load(memarg(4)));
    body.instruction(&Instruction::LocalGet(1));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::LocalSet(RESULT));
    body.instruction(&Instruction::Br(2));
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::LocalGet(MAPPING_INDEX));
    body.instruction(&Instruction::I32Const(1));
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalSet(MAPPING_INDEX));
    body.instruction(&Instruction::Br(0));
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::End);

    // The mutation is a core-Wasm side effect, not a JavaScript callback. It occurs after this
    // call's comparison, allowing a B-boundary validation to invalidate the following A block.
    body.instruction(&Instruction::LocalGet(CALL_INDEX));
    body.instruction(&Instruction::I32Const(VALIDATOR_TRIGGER_CALL as i32));
    body.instruction(&Instruction::I32Load(memarg(0)));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::If(BlockType::Empty));
    body.instruction(&Instruction::I32Const(VALIDATOR_MAPPING_BASE as i32));
    body.instruction(&Instruction::I32Const(
        VALIDATOR_TRIGGER_MAPPING_INDEX as i32,
    ));
    body.instruction(&Instruction::I32Load(memarg(0)));
    body.instruction(&Instruction::I32Const(3));
    body.instruction(&Instruction::I32Shl);
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::I32Const(
        VALIDATOR_TRIGGER_NEW_PHYSICAL as i32,
    ));
    body.instruction(&Instruction::I32Load(memarg(0)));
    body.instruction(&Instruction::I32Store(memarg(4)));
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::LocalGet(RESULT));
    body.instruction(&Instruction::End);

    let mut code = CodeSection::new();
    code.function(&body);
    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.section(&functions);
    module.section(&exports);
    module.section(&code);
    module.finish()
}

/// Rust-generated same-signature block used only to prove a synchronous hook exit after a call.
/// The alternating execution path below uses actual lowered PPC blocks.
fn hook_exit_block(control: u32, packed_executed: u32) -> Vec<u8> {
    let mut types = TypeSection::new();
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], [ValType::I32]);
    let mut imports = ImportSection::new();
    imports.import(
        "lazuli",
        "memory",
        EntityType::Memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );
    let mut functions = FunctionSection::new();
    functions.function(0);
    let mut exports = ExportSection::new();
    exports.export("run", ExportKind::Func, 0);
    let mut body = Function::new([]);
    body.instruction(&Instruction::I32Const(control as i32));
    body.instruction(&Instruction::I32Const(1));
    body.instruction(&Instruction::I32Store(MemArg {
        offset: 4,
        align: 2,
        memory_index: 0,
    }));
    body.instruction(&Instruction::I32Const(packed_executed as i32));
    body.instruction(&Instruction::End);
    let mut code = CodeSection::new();
    code.function(&body);
    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.section(&functions);
    module.section(&exports);
    module.section(&code);
    module.finish()
}

#[test]
fn rejects_an_initial_image_that_overfills_one_four_way_set() {
    let initial_entries = (0..5)
        .map(|index| DispatcherEntry {
            pc: 0x8000_1000 + index * 8,
            address_space_generation: 7,
            table_slot: index,
            slot_nonce: u64::from(index + 1),
            maximum_executed: 0x0001_0001,
            dependency_count: 0,
            dependencies: [DispatcherDependency::default(); 2],
        })
        .collect();
    let error = build_resident_dispatcher(&DispatcherConfig {
        memory_minimum_pages: 1,
        memory_maximum_pages: None,
        metadata_base: 0x4000,
        metadata_capacity: DISPATCH_CACHE_WAYS * 2,
        slot_identity_base: 0x5000,
        slot_capacity: 8,
        table_minimum: 1,
        table_maximum: Some(8),
        initial_entries,
        initial_slot_identities: Vec::new(),
    })
    .unwrap_err();
    assert!(matches!(error, DispatcherError::InitialSetOverflow { .. }));
}

#[test]
fn production_config_uses_the_canonical_shared_memory_reservations() {
    let config = DispatcherConfig::production();
    assert_eq!(
        config.memory_minimum_pages,
        shared_memory::RESIDENT_MEMORY_INITIAL_PAGES as u64
    );
    assert_eq!(
        config.memory_maximum_pages,
        Some(shared_memory::RESIDENT_MEMORY_MAXIMUM_PAGES as u64)
    );
    assert_eq!(
        config.metadata_base,
        shared_memory::DISPATCH_METADATA_OFFSET as u32
    );
    assert_eq!(
        config.metadata_capacity,
        shared_memory::DISPATCH_ENTRY_CAPACITY as u32
    );
    assert_eq!(
        config.slot_identity_base,
        shared_memory::DISPATCH_SLOT_IDENTITY_OFFSET as u32
    );
    assert_eq!(
        config.slot_capacity,
        shared_memory::DISPATCH_SLOT_CAPACITY as u32
    );
    assert_eq!(
        config.table_maximum,
        Some(shared_memory::DISPATCH_SLOT_CAPACITY as u32)
    );
    let module = build_resident_dispatcher(&config).unwrap();
    Validator::new().validate_all(&module).unwrap();
    let memory_import = Parser::new(0)
        .parse_all(&module)
        .filter_map(Result::ok)
        .find_map(|payload| {
            let Payload::ImportSection(section) = payload else {
                return None;
            };
            section
                .into_imports()
                .filter_map(Result::ok)
                .find_map(|import| {
                    let TypeRef::Memory(memory) = import.ty else {
                        return None;
                    };
                    Some((import.module.to_owned(), import.name.to_owned(), memory))
                })
        })
        .expect("production dispatcher imports its resident memory");
    assert_eq!(memory_import.0, "lazuli");
    assert_eq!(memory_import.1, "memory");
    assert_eq!(memory_import.2.initial, 720);
    assert_eq!(memory_import.2.maximum, Some(2048));
}

#[test]
fn production_artifact_satisfies_the_node_boundary_contract() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping resident-dispatcher artifact contract");
        return;
    }

    let module = build_resident_dispatcher(&DispatcherConfig::production()).unwrap();
    let artifact = env::temp_dir().join(format!(
        "lazuli-resident-dispatcher-contract-{}.wasm",
        std::process::id()
    ));
    fs::write(&artifact, module).unwrap();
    let contract = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/resident_dispatcher_wasm_contract.mjs");
    let output = Command::new("node")
        .arg(contract)
        .arg(&artifact)
        .output()
        .unwrap();
    fs::remove_file(&artifact).unwrap();
    assert!(
        output.status.success(),
        "node artifact contract failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn resident_dispatches_real_alternating_ppc_blocks_in_one_host_call() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping resident-dispatcher WebAssembly test");
        return;
    }

    const PC_A: u32 = 0x8000_1000;
    const PC_B: u32 = 0x8000_1008;
    const PC_NULL_SLOT: u32 = 0x8000_1010;
    const PC_DEPENDENT: u32 = 0x8000_1014;
    const PC_HOOK_EXIT: u32 = 0x8000_1018;
    const GENERATION: u64 = 0x0123_4567_89ab_cdef;
    const METADATA_BASE: u32 = 0x4000;
    const SLOT_IDENTITY_BASE: u32 = 0x5000;
    const CONTROL: u32 = 0x1000;
    const HOOK_MAXIMUM: u32 = 0x0001_0001;

    // The branch instruction is the second word, so its displacement is relative to PC + 4.
    let block_a = Jit::new().build([addi(3, 3, 1), branch(4)]).unwrap();
    let block_b = Jit::new().build([addi(4, 4, 1), branch(-12)]).unwrap();
    Validator::new().validate_all(block_a.wasm()).unwrap();
    Validator::new().validate_all(block_b.wasm()).unwrap();

    let maximum_a = block_a.metadata().executed.pack();
    let maximum_b = block_b.metadata().executed.pack();
    let entries = [
        DispatcherEntry {
            pc: PC_A,
            address_space_generation: GENERATION,
            table_slot: 0,
            slot_nonce: 0xa001,
            maximum_executed: maximum_a,
            dependency_count: 2,
            dependencies: [DEPENDENCY_A0, DEPENDENCY_A1],
        },
        DispatcherEntry {
            pc: PC_B,
            address_space_generation: GENERATION,
            table_slot: 1,
            slot_nonce: 0xb002,
            maximum_executed: maximum_b,
            dependency_count: 1,
            dependencies: [DEPENDENCY_B0, DispatcherDependency::default()],
        },
        DispatcherEntry {
            pc: PC_NULL_SLOT,
            address_space_generation: GENERATION,
            table_slot: 2,
            slot_nonce: 0xc003,
            maximum_executed: maximum_a,
            dependency_count: 0,
            dependencies: [DispatcherDependency::default(); 2],
        },
        DispatcherEntry {
            pc: PC_DEPENDENT,
            address_space_generation: GENERATION,
            table_slot: 3,
            slot_nonce: 0xd004,
            maximum_executed: maximum_a,
            dependency_count: 1,
            dependencies: [
                DispatcherDependency {
                    effective_page: DEPENDENCY_A0.effective_page,
                    physical_page: 0x00ff_0000,
                },
                DispatcherDependency::default(),
            ],
        },
        DispatcherEntry {
            pc: PC_HOOK_EXIT,
            address_space_generation: GENERATION,
            table_slot: 4,
            slot_nonce: 0xe005,
            maximum_executed: HOOK_MAXIMUM,
            dependency_count: 0,
            dependencies: [DispatcherDependency::default(); 2],
        },
    ];
    let identities = entries.map(|entry| DispatcherSlotIdentity {
        table_slot: entry.table_slot,
        pc: entry.pc,
        address_space_generation: entry.address_space_generation,
        slot_nonce: entry.slot_nonce,
    });
    let dispatcher = build_resident_dispatcher(&DispatcherConfig {
        memory_minimum_pages: 1,
        memory_maximum_pages: None,
        metadata_base: METADATA_BASE,
        metadata_capacity: 32,
        slot_identity_base: SLOT_IDENTITY_BASE,
        slot_capacity: 8,
        table_minimum: 5,
        table_maximum: Some(8),
        initial_entries: entries.to_vec(),
        initial_slot_identities: identities.to_vec(),
    })
    .unwrap();
    Validator::new().validate_all(&dispatcher).unwrap();
    let validator = dependency_validator(3);
    Validator::new().validate_all(&validator).unwrap();
    let hook_block = hook_exit_block(CONTROL, HOOK_MAXIMUM);
    Validator::new().validate_all(&hook_block).unwrap();

    let script = r#"
const [dispatcherHex, validatorHex, blockAHex, blockBHex, hookBlockHex, validatorName,
  pcOffsetText, r3OffsetText, r4OffsetText,
  maximumAText, maximumBText, generationLoText, generationHiText, entryAAddressText,
  entrySlotOffsetText, entryDependencyCountOffsetText,
  pcAText, pcBText, pcNullSlotText, pcDependentText, pcHookExitText,
  validatorCallCountText, validatorTriggerCallText, validatorTriggerIndexText,
  validatorTriggerPhysicalText, validatorMappingBaseText, validatorLogBaseText,
  dependencyA0EffectiveText, dependencyA0PhysicalText, dependencyA1EffectiveText,
  dependencyA1PhysicalText, dependencyB0EffectiveText, dependencyB0PhysicalText,
  reasonBlockText, reasonCycleText, reasonMissText, reasonStaleText, reasonDependenciesText,
  reasonSlotText, reasonHookText] = process.argv.slice(1);

const bytes = text => Buffer.from(text, "hex");
const dispatcherModule = new WebAssembly.Module(bytes(dispatcherHex));
const imports = WebAssembly.Module.imports(dispatcherModule);
const expectedDispatcherImports = [
  { module: "lazuli", name: "memory", kind: "memory" },
  { module: "lazuli", name: validatorName, kind: "function" },
];
if (JSON.stringify(imports) !== JSON.stringify(expectedDispatcherImports)) {
  throw new Error(`dispatcher crossed an unaudited import boundary: ${JSON.stringify(imports)}`);
}
const exports = WebAssembly.Module.exports(dispatcherModule);
if (!exports.some(item => item.name === "run" && item.kind === "function") ||
    !exports.some(item => item.name === "blocks" && item.kind === "table")) {
  throw new Error(`dispatcher exports are incomplete: ${JSON.stringify(exports)}`);
}

const validatorModule = new WebAssembly.Module(bytes(validatorHex));
const validatorImports = WebAssembly.Module.imports(validatorModule);
if (JSON.stringify(validatorImports) !== JSON.stringify([{ module: "lazuli", name: "memory", kind: "memory" }])) {
  throw new Error(`validator crossed an unaudited import boundary: ${JSON.stringify(validatorImports)}`);
}
const validatorExports = WebAssembly.Module.exports(validatorModule);
if (JSON.stringify(validatorExports) !== JSON.stringify([{ name: validatorName, kind: "function" }])) {
  throw new Error(`validator exports are unexpected: ${JSON.stringify(validatorExports)}`);
}

const blockAModule = new WebAssembly.Module(bytes(blockAHex));
const blockBModule = new WebAssembly.Module(bytes(blockBHex));
const hookBlockModule = new WebAssembly.Module(bytes(hookBlockHex));
for (const [name, module] of [["A", blockAModule], ["B", blockBModule]]) {
  const blockImports = WebAssembly.Module.imports(module);
  if (JSON.stringify(blockImports) !== JSON.stringify([{ module: "lazuli", name: "memory", kind: "memory" }])) {
    throw new Error(`lowered block ${name} crossed an unaudited import boundary: ${JSON.stringify(blockImports)}`);
  }
}

const memory = new WebAssembly.Memory({ initial: 1 });
const blockA = new WebAssembly.Instance(blockAModule, { lazuli: { memory } });
const blockB = new WebAssembly.Instance(blockBModule, { lazuli: { memory } });
const hookBlock = new WebAssembly.Instance(hookBlockModule, { lazuli: { memory } });
const validator = new WebAssembly.Instance(validatorModule, { lazuli: { memory } });
const dispatcher = new WebAssembly.Instance(dispatcherModule, {
  lazuli: { memory, [validatorName]: validator.exports[validatorName] },
});
const table = dispatcher.exports.blocks;
// The browser adapter's only cache operation is installing Rust-requested functions.
table.set(0, blockA.exports.run);
table.set(1, blockB.exports.run);
table.set(3, blockA.exports.run);
table.set(4, hookBlock.exports.run);

const view = new DataView(memory.buffer);
const cpu = 0x100;
const control = 0x1000;
const pcOffset = Number(pcOffsetText);
const r3Offset = Number(r3OffsetText);
const r4Offset = Number(r4OffsetText);
const maximumA = Number(maximumAText) >>> 0;
const maximumB = Number(maximumBText) >>> 0;
const generationLo = Number(generationLoText) >>> 0;
const generationHi = Number(generationHiText) >>> 0;
const entryAAddress = Number(entryAAddressText);
const entrySlotOffset = Number(entrySlotOffsetText);
const entryDependencyCountOffset = Number(entryDependencyCountOffsetText);
const pcA = Number(pcAText) >>> 0;
const pcB = Number(pcBText) >>> 0;
const pcNullSlot = Number(pcNullSlotText) >>> 0;
const pcDependent = Number(pcDependentText) >>> 0;
const pcHookExit = Number(pcHookExitText) >>> 0;
const validatorCallCount = Number(validatorCallCountText);
const validatorTriggerCall = Number(validatorTriggerCallText);
const validatorTriggerIndex = Number(validatorTriggerIndexText);
const validatorTriggerPhysical = Number(validatorTriggerPhysicalText);
const validatorMappingBase = Number(validatorMappingBaseText);
const validatorLogBase = Number(validatorLogBaseText);
const dependencies = [
  [Number(dependencyA0EffectiveText) >>> 0, Number(dependencyA0PhysicalText) >>> 0],
  [Number(dependencyA1EffectiveText) >>> 0, Number(dependencyA1PhysicalText) >>> 0],
  [Number(dependencyB0EffectiveText) >>> 0, Number(dependencyB0PhysicalText) >>> 0],
];
const reason = {
  block: Number(reasonBlockText), cycle: Number(reasonCycleText), miss: Number(reasonMissText),
  stale: Number(reasonStaleText), dependencies: Number(reasonDependenciesText),
  slot: Number(reasonSlotText), hook: Number(reasonHookText),
};
const maxInstructions = packed => packed & 0xffff;
const maxCycles = packed => packed >>> 16;

function resetValidator(triggerCall = 0xffffffff, triggerIndex = 0, newPhysical = 0) {
  view.setUint32(validatorCallCount, 0, true);
  view.setUint32(validatorTriggerCall, triggerCall, true);
  view.setUint32(validatorTriggerIndex, triggerIndex, true);
  view.setUint32(validatorTriggerPhysical, newPhysical, true);
  for (let index = 0; index < dependencies.length; index++) {
    view.setUint32(validatorMappingBase + index * 8, dependencies[index][0], true);
    view.setUint32(validatorMappingBase + index * 8 + 4, dependencies[index][1], true);
  }
}
function validatorLog() {
  const count = view.getUint32(validatorCallCount, true);
  return Array.from({ length: count }, (_, index) => [
    view.getUint32(validatorLogBase + index * 8, true),
    view.getUint32(validatorLogBase + index * 8 + 4, true),
  ]);
}

function reset(pc, hookExit = 0) {
  view.setUint32(cpu + pcOffset, pc, true);
  view.setUint32(cpu + r3Offset, 0, true);
  view.setUint32(cpu + r4Offset, 0, true);
  view.setUint32(control, 0, true);
  view.setUint32(control + 4, hookExit, true);
  view.setUint32(control + 8, 0xfeedbeef, true);
}
function run(cycleBudget, blockBudget, generationLow = generationLo, generationHigh = generationHi) {
  return dispatcher.exports.run(
    0, cpu, 0, pcOffset, control, generationLow, generationHigh, BigInt(cycleBudget), blockBudget,
  );
}
function expect(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: got [${actual}], expected [${expected}]`);
  }
}

// One browser-to-Wasm call executes hundreds of real lowered PPC blocks while alternating PCs.
resetValidator();
const manyBlocks = 257;
const countA = Math.ceil(manyBlocks / 2);
const countB = Math.floor(manyBlocks / 2);
const expectedInstructions = BigInt(countA * maxInstructions(maximumA) + countB * maxInstructions(maximumB));
const expectedCycles = BigInt(countA * maxCycles(maximumA) + countB * maxCycles(maximumB));
reset(pcA);
expect(run(expectedCycles, manyBlocks), [expectedInstructions, expectedCycles, manyBlocks, reason.block], "resident alternating run");
if (view.getUint32(cpu + pcOffset, true) !== pcB ||
    view.getUint32(cpu + r3Offset, true) !== countA ||
    view.getUint32(cpu + r4Offset, true) !== countB) {
  throw new Error("alternating blocks did not preserve PPC state/PC progression");
}

reset(pcA);
expect(run(maxCycles(maximumA) - 1, 10), [0n, 0n, 0, reason.cycle], "cycle preflight");

reset(pcA);
const twoCycles = maxCycles(maximumA) + maxCycles(maximumB);
expect(
  run(twoCycles, 10),
  [BigInt(maxInstructions(maximumA) + maxInstructions(maximumB)), BigInt(twoCycles), 2, reason.cycle],
  "cycle boundary",
);

reset(0x90000000);
expect(run(100, 10), [0n, 0n, 0, reason.miss], "metadata miss");

reset(pcA);
expect(run(100, 10, generationLo, (generationHi + 1) >>> 0), [0n, 0n, 0, reason.stale], "stale 64-bit generation");

reset(pcNullSlot);
expect(run(100, 10), [0n, 0n, 0, reason.slot], "null table slot");

// A count outside the two-record ABI fails before the core validator sees any arguments.
resetValidator();
view.setUint32(entryAAddress + entryDependencyCountOffset, 3, true);
reset(pcA);
expect(run(100, 10), [0n, 0n, 0, reason.dependencies], "unknown dependency count");
if (view.getUint32(validatorCallCount, true) !== 0) {
  throw new Error("unknown dependency count reached the validator");
}
view.setUint32(entryAAddress + entryDependencyCountOffset, 2, true);

// A retained physical page that no longer matches fails before its table slot is called.
resetValidator();
reset(pcDependent);
expect(run(100, 10), [0n, 0n, 0, reason.dependencies], "dependency mapping mismatch");
const mismatchLog = validatorLog();
const expectedMismatchLog = [[dependencies[0][0], 0x00ff0000]];
if (JSON.stringify(mismatchLog) !== JSON.stringify(expectedMismatchLog)) {
  throw new Error(`mismatch arguments/order were wrong: ${JSON.stringify(mismatchLog)}`);
}

// Even though slot 1 contains a valid same-signature block, its Rust-issued identity belongs to
// PC B. Corrupting A's slot selector must return without calling B.
view.setUint32(entryAAddress + entrySlotOffset, 1, true);
reset(pcA);
expect(run(100, 10), [0n, 0n, 0, reason.slot], "wrong populated table slot");
if (view.getUint32(cpu + r3Offset, true) !== 0 || view.getUint32(cpu + r4Offset, true) !== 0) {
  throw new Error("wrong-slot validation executed guest code");
}
view.setUint32(entryAAddress + entrySlotOffset, 0, true);

// The validator mutates A's mapping after validating B. The same outer Wasm call must revalidate
// A at the next boundary, stop before a third guest block, and preserve exact retained call order.
const driftedPhysical = 0x00004000;
resetValidator(2, 0, driftedPhysical);
reset(pcA);
expect(
  run(100, 10),
  [BigInt(maxInstructions(maximumA) + maxInstructions(maximumB)), BigInt(twoCycles), 2, reason.dependencies],
  "mapping drift between alternating blocks",
);
const expectedDriftLog = [dependencies[0], dependencies[1], dependencies[2], dependencies[0]];
const actualDriftLog = validatorLog();
if (JSON.stringify(actualDriftLog) !== JSON.stringify(expectedDriftLog)) {
  throw new Error(`dependency side-effect order was wrong: ${JSON.stringify(actualDriftLog)}`);
}
if (view.getUint32(validatorMappingBase + 4, true) !== driftedPhysical ||
    view.getUint32(cpu + r3Offset, true) !== 1 || view.getUint32(cpu + r4Offset, true) !== 1) {
  throw new Error("mapping drift did not stop precisely before the third guest block");
}

reset(pcA, 1);
expect(run(100, 10), [0n, 0n, 0, reason.hook], "preexisting hook exit");

// A Rust-generated same-signature block models a synchronous runtime hook setting control + 4.
// The resident loop accounts for that block and exits before any subsequent lookup/call.
reset(pcHookExit);
expect(run(100, 10), [1n, 1n, 1, reason.hook], "post-block hook exit");
"#;

    let entry_a_index =
        resident_dispatcher_set_index(32, GENERATION, PC_A).unwrap() * DISPATCH_CACHE_WAYS;
    let entry_a_address = METADATA_BASE + entry_a_index * DISPATCH_ENTRY_SIZE;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &hex(&dispatcher),
            &hex(&validator),
            &hex(block_a.wasm()),
            &hex(block_b.wasm()),
            &hex(&hook_block),
            DISPATCH_DEPENDENCY_VALIDATOR_IMPORT,
            &Reg::PC.offset().to_string(),
            &GPR::R3.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &maximum_a.to_string(),
            &maximum_b.to_string(),
            &(GENERATION as u32).to_string(),
            &((GENERATION >> 32) as u32).to_string(),
            &entry_a_address.to_string(),
            &DISPATCH_ENTRY_TABLE_SLOT_OFFSET.to_string(),
            &DISPATCH_ENTRY_DEPENDENCY_COUNT_OFFSET.to_string(),
            &PC_A.to_string(),
            &PC_B.to_string(),
            &PC_NULL_SLOT.to_string(),
            &PC_DEPENDENT.to_string(),
            &PC_HOOK_EXIT.to_string(),
            &VALIDATOR_CALL_COUNT.to_string(),
            &VALIDATOR_TRIGGER_CALL.to_string(),
            &VALIDATOR_TRIGGER_MAPPING_INDEX.to_string(),
            &VALIDATOR_TRIGGER_NEW_PHYSICAL.to_string(),
            &VALIDATOR_MAPPING_BASE.to_string(),
            &VALIDATOR_LOG_BASE.to_string(),
            &DEPENDENCY_A0.effective_page.to_string(),
            &DEPENDENCY_A0.physical_page.to_string(),
            &DEPENDENCY_A1.effective_page.to_string(),
            &DEPENDENCY_A1.physical_page.to_string(),
            &DEPENDENCY_B0.effective_page.to_string(),
            &DEPENDENCY_B0.physical_page.to_string(),
            &(DispatchReason::BlockBudgetExhausted as u32).to_string(),
            &(DispatchReason::CycleBudgetExhausted as u32).to_string(),
            &(DispatchReason::MetadataMiss as u32).to_string(),
            &(DispatchReason::StaleGeneration as u32).to_string(),
            &(DispatchReason::DependencyMismatch as u32).to_string(),
            &(DispatchReason::TableSlotUnavailable as u32).to_string(),
            &(DispatchReason::HookExit as u32).to_string(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "node failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
