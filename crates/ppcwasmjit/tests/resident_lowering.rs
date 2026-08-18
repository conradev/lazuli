use std::collections::BTreeSet;
use std::process::Command;

use gekko::disasm::{Extensions, Ins};
use gekko::{Exception, GPR, Reg};
use lazuli_abi::memory::{RESIDENT_MEMORY_INITIAL_PAGES, RESIDENT_MEMORY_MAXIMUM_PAGES};
use ppcjit::hooks::HookKind;
use ppcwasmjit::{IMPORT_MODULE, Jit, MEMORY_IMPORT, RESIDENT_HOOK_IMPORT_MODULE};
use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction, MemArg, MemoryType, Module, TypeSection, ValType,
};
use wasmparser::{Parser, Payload, TypeRef, Validator};

fn instruction(word: u32) -> Ins {
    Ins::new(word, Extensions::gekko_broadway())
}

fn d_form(opcode: u32, rt_or_rs: u8, ra: u8, immediate: i16) -> Ins {
    instruction(
        opcode << 26
            | u32::from(rt_or_rs) << 21
            | u32::from(ra) << 16
            | u32::from(immediate as u16),
    )
}

fn lwz(rd: u8, ra: u8, displacement: i16) -> Ins {
    d_form(32, rd, ra, displacement)
}

fn addi(rd: u8, ra: u8, immediate: i16) -> Ins {
    d_form(14, rd, ra, immediate)
}

fn stw(rs: u8, ra: u8, displacement: i16) -> Ins {
    d_form(36, rs, ra, displacement)
}

fn lwarx(rd: u8, ra: u8, rb: u8) -> Ins {
    instruction(
        31 << 26 | u32::from(rd) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11 | 20 << 1,
    )
}

fn stwcx(rs: u8, ra: u8, rb: u8) -> Ins {
    instruction(
        31 << 26 | u32::from(rs) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11 | 150 << 1 | 1,
    )
}

fn psq(opcode: u32, fr: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> Ins {
    instruction(
        opcode << 26
            | u32::from(fr) << 21
            | u32::from(ra) << 16
            | u32::from(w) << 15
            | u32::from(gqr & 7) << 12
            | u32::from(displacement as u16 & 0x0fff),
    )
}

fn mtmsr(rs: u8) -> Ins {
    instruction(31 << 26 | u32::from(rs) << 21 | 146 << 1)
}

fn tlbie(rb: u8) -> Ins {
    instruction(0x7c00_0264 | u32::from(rb) << 11)
}

fn icbi(ra: u8, rb: u8) -> Ins {
    instruction(31 << 26 | u32::from(ra) << 16 | u32::from(rb) << 11 | 982 << 1)
}

fn hook_field(kind: HookKind) -> String {
    format!("user_0_{}", kind as u32)
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum ImportKind {
    Memory,
    Function,
}

fn imports(wasm: &[u8]) -> BTreeSet<(String, String, ImportKind)> {
    let mut imports = BTreeSet::new();
    for payload in Parser::new(0).parse_all(wasm) {
        let Payload::ImportSection(section) = payload.unwrap() else {
            continue;
        };
        for import in section.into_imports() {
            let import = import.unwrap();
            let kind = match import.ty {
                TypeRef::Memory(memory) => {
                    assert_eq!(memory.initial, RESIDENT_MEMORY_INITIAL_PAGES as u64);
                    assert_eq!(memory.maximum, Some(RESIDENT_MEMORY_MAXIMUM_PAGES as u64));
                    assert!(!memory.memory64);
                    assert!(!memory.shared);
                    ImportKind::Memory
                }
                TypeRef::Func(_) => ImportKind::Function,
                other => panic!("unexpected resident import kind {other:?}"),
            };
            assert!(
                imports.insert((import.module.to_owned(), import.name.to_owned(), kind)),
                "duplicate import {}.{}",
                import.module,
                import.name,
            );
        }
    }
    imports
}

fn assert_resident_imports(sequence: &[Ins], expected_hooks: &[HookKind]) {
    let block = Jit::with_slow_memory_resident()
        .build(sequence.iter().copied())
        .unwrap();
    Validator::new().validate_all(block.wasm()).unwrap();

    let imports = imports(block.wasm());
    assert!(imports.contains(&(
        IMPORT_MODULE.to_owned(),
        MEMORY_IMPORT.to_owned(),
        ImportKind::Memory,
    )));
    assert!(
        imports.iter().all(|(module, _, _)| module == IMPORT_MODULE),
        "resident block escaped the Rust/Wasm namespace: {imports:?}",
    );
    assert!(
        !imports
            .iter()
            .any(|(module, _, _)| module == "lazuli_hooks")
    );

    for hook in expected_hooks {
        assert!(
            imports.contains(&(
                RESIDENT_HOOK_IMPORT_MODULE.to_owned(),
                hook_field(*hook),
                ImportKind::Function,
            )),
            "missing {:?} from {imports:?}",
            hook,
        );
    }

    for (_, field, kind) in &imports {
        if kind == &ImportKind::Function {
            assert!(
                field == "user_1_0"
                    || field
                        .strip_prefix("user_0_")
                        .is_some_and(|suffix| suffix.parse::<u32>().is_ok()),
                "resident hook field {field:?} is outside the shared PPC hook ABI",
            );
        }
    }
}

#[test]
fn representative_blocks_import_only_rust_wasm_machine_hooks() {
    assert_resident_imports(
        &[lwz(4, 3, 0), stw(4, 3, 4)],
        &[HookKind::ReadI32, HookKind::WriteI32],
    );
    assert_resident_imports(
        &[lwarx(4, 0, 3), stwcx(4, 0, 3)],
        &[HookKind::LoadReserve, HookKind::StoreConditional],
    );
    assert_resident_imports(
        &[psq(56, 2, 3, 0, true, 0), psq(60, 2, 3, 8, true, 0)],
        &[HookKind::ReadQuant, HookKind::WriteQuant],
    );
    assert_resident_imports(&[mtmsr(3)], &[HookKind::MsrChanged]);
    assert_resident_imports(&[tlbie(3)], &[HookKind::Tlbie]);
    assert_resident_imports(&[icbi(0, 3)], &[HookKind::InvICache]);
}

const READ_CALLS: u32 = 0x4000;
const WRITE_CALLS: u32 = 0x4004;
const WRITE_ADDRESS: u32 = 0x4008;
const WRITE_VALUE: u32 = 0x400c;
const READ_MODE: u32 = 0x4010;
const EXCEPTION_CALLS: u32 = 0x4014;
const EXCEPTION_CODE: u32 = 0x4018;
const READ_VALUE: u32 = 0x1122_3344;

fn memarg(offset: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: 0,
    }
}

fn increment_word(body: &mut Function, address: u32) {
    body.instruction(&Instruction::I32Const(address as i32));
    body.instruction(&Instruction::I32Const(address as i32));
    body.instruction(&Instruction::I32Load(memarg(0)));
    body.instruction(&Instruction::I32Const(1));
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::I32Store(memarg(0)));
}

/// A Rust-authored Wasm stand-in for the browser-machine export surface.
///
/// It shares the block's memory, completes one read/write path, and can return an architectural
/// data fault based on a memory-owned mode word. JavaScript only links modules and checks results;
/// it does not implement a guest semantic callback.
fn rust_hook_module() -> Vec<u8> {
    let mut types = TypeSection::new();
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], [ValType::I32]);
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], [ValType::I32]);
    types.ty().function([ValType::I32, ValType::I32], []);

    let mut imports = ImportSection::new();
    imports.import(
        IMPORT_MODULE,
        MEMORY_IMPORT,
        EntityType::Memory(MemoryType {
            minimum: RESIDENT_MEMORY_INITIAL_PAGES as u64,
            maximum: Some(RESIDENT_MEMORY_MAXIMUM_PAGES as u64),
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );

    let mut functions = FunctionSection::new();
    functions.function(0);
    functions.function(1);
    functions.function(2);

    let read_name = hook_field(HookKind::ReadI32);
    let write_name = hook_field(HookKind::WriteI32);
    let mut exports = ExportSection::new();
    exports.export(&read_name, ExportKind::Func, 0);
    exports.export(&write_name, ExportKind::Func, 1);
    exports.export("user_1_0", ExportKind::Func, 2);

    let mut code = CodeSection::new();

    // read_i32(ctx, effective, output) -> HookOutcome
    let mut read = Function::new([]);
    increment_word(&mut read, READ_CALLS);
    read.instruction(&Instruction::I32Const(READ_MODE as i32));
    read.instruction(&Instruction::I32Load(memarg(0)));
    read.instruction(&Instruction::I32Const(2));
    read.instruction(&Instruction::I32Eq);
    read.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    read.instruction(&Instruction::I32Const(2));
    read.instruction(&Instruction::Else);
    read.instruction(&Instruction::I32Const(READ_MODE as i32));
    read.instruction(&Instruction::I32Load(memarg(0)));
    read.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    read.instruction(&Instruction::I32Const(0));
    read.instruction(&Instruction::Else);
    read.instruction(&Instruction::LocalGet(2));
    read.instruction(&Instruction::I32Const(READ_VALUE as i32));
    read.instruction(&Instruction::I32Store(memarg(0)));
    read.instruction(&Instruction::I32Const(1));
    read.instruction(&Instruction::End);
    read.instruction(&Instruction::End);
    read.instruction(&Instruction::End);
    code.function(&read);

    // write_i32(ctx, effective, value) -> complete
    let mut write = Function::new([]);
    increment_word(&mut write, WRITE_CALLS);
    write.instruction(&Instruction::I32Const(WRITE_ADDRESS as i32));
    write.instruction(&Instruction::LocalGet(1));
    write.instruction(&Instruction::I32Store(memarg(0)));
    write.instruction(&Instruction::I32Const(WRITE_VALUE as i32));
    write.instruction(&Instruction::LocalGet(2));
    write.instruction(&Instruction::I32Store(memarg(0)));
    write.instruction(&Instruction::I32Const(1));
    write.instruction(&Instruction::End);
    code.function(&write);

    // raise_exception(cpu, exception)
    let mut raise = Function::new([]);
    increment_word(&mut raise, EXCEPTION_CALLS);
    raise.instruction(&Instruction::I32Const(EXCEPTION_CODE as i32));
    raise.instruction(&Instruction::LocalGet(1));
    raise.instruction(&Instruction::I32Store(memarg(0)));
    raise.instruction(&Instruction::End);
    code.function(&raise);

    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.section(&functions);
    module.section(&exports);
    module.section(&code);
    module.finish()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn resident_block_executes_complete_and_fault_paths_without_js_semantics() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let block = Jit::with_slow_memory_resident()
        .build([lwz(4, 3, 0), stw(4, 3, 4)])
        .unwrap();
    let hooks = rust_hook_module();
    Validator::new().validate_all(block.wasm()).unwrap();
    Validator::new().validate_all(&hooks).unwrap();

    let script = r#"
const args = process.argv.slice(1);
const blockHex = args[0];
const hooksHex = args[1];
const pcOffset = Number(args[2]);
const r3Offset = Number(args[3]);
const r4Offset = Number(args[4]);
const expectedExecuted = Number(args[5]);
const readHook = args[6];
const writeHook = args[7];
const [
  readCalls,
  writeCalls,
  writeAddress,
  writeValue,
  readMode,
  exceptionCalls,
  exceptionCode,
  readValue,
  dsi,
] = args.slice(8).map(Number);

const cpu = 0x10000;
const fastmem = 0x20000;
const startPc = 0x80001000;
const guestAddress = 0xcc001000;
const memory = new WebAssembly.Memory({
  initial: Number(args[17]),
  maximum: Number(args[18]),
});
const view = new DataView(memory.buffer);

const hookModule = new WebAssembly.Module(Buffer.from(hooksHex, "hex"));
const hookInstance = new WebAssembly.Instance(hookModule, { lazuli: { memory } });
const resident = {
  memory,
  [readHook]: hookInstance.exports[readHook],
  [writeHook]: hookInstance.exports[writeHook],
  user_1_0: hookInstance.exports.user_1_0,
};
const blockModule = new WebAssembly.Module(Buffer.from(blockHex, "hex"));
const block = new WebAssembly.Instance(blockModule, { lazuli: resident });

function reset() {
  view.setUint32(cpu + pcOffset, startPc, true);
  view.setUint32(cpu + r3Offset, guestAddress, true);
  view.setUint32(cpu + r4Offset, 0xdeadbeef, true);
}

reset();
const completed = block.exports.run(0, cpu, fastmem) >>> 0;
if (completed !== (expectedExecuted >>> 0)) {
  throw new Error(`complete path returned 0x${completed.toString(16)}`);
}
if (view.getUint32(readCalls, true) !== 1 || view.getUint32(writeCalls, true) !== 1) {
  throw new Error("Rust/Wasm complete hooks did not run exactly once");
}
if (view.getUint32(cpu + r4Offset, true) !== (readValue >>> 0) ||
    view.getUint32(writeAddress, true) !== ((guestAddress + 4) >>> 0) ||
    view.getUint32(writeValue, true) !== (readValue >>> 0)) {
  throw new Error("Rust/Wasm hook values did not cross the resident ABI exactly");
}
if (view.getUint32(cpu + pcOffset, true) !== ((startPc + 8) >>> 0) ||
    view.getUint32(exceptionCalls, true) !== 0) {
  throw new Error("complete path changed exception state or advanced PC incorrectly");
}

reset();
view.setUint32(readMode, 1, true);
const storesBeforeFault = view.getUint32(writeCalls, true);
block.exports.run(0, cpu, fastmem);
if (view.getUint32(readCalls, true) !== 2 ||
    view.getUint32(writeCalls, true) !== storesBeforeFault) {
  throw new Error("faulting read did not stop before the following store");
}
if (view.getUint32(exceptionCalls, true) !== 1 ||
    view.getUint32(exceptionCode, true) !== dsi) {
  throw new Error("faulting Rust/Wasm read did not raise exact DSI");
}
if (view.getUint32(cpu + pcOffset, true) !== startPc ||
    view.getUint32(cpu + r4Offset, true) !== 0xdeadbeef) {
  throw new Error("faulting read committed architectural state");
}
"#;

    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &hex(block.wasm()),
            &hex(&hooks),
            &Reg::PC.offset().to_string(),
            &GPR::R3.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &block.metadata().executed.pack().to_string(),
            &hook_field(HookKind::ReadI32),
            &hook_field(HookKind::WriteI32),
            &READ_CALLS.to_string(),
            &WRITE_CALLS.to_string(),
            &WRITE_ADDRESS.to_string(),
            &WRITE_VALUE.to_string(),
            &READ_MODE.to_string(),
            &EXCEPTION_CALLS.to_string(),
            &EXCEPTION_CODE.to_string(),
            &READ_VALUE.to_string(),
            &(Exception::DSI as u16).to_string(),
            &RESIDENT_MEMORY_INITIAL_PAGES.to_string(),
            &RESIDENT_MEMORY_MAXIMUM_PAGES.to_string(),
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

#[test]
fn resident_wasm_read_yield_retires_only_prefix_and_retries_unchanged_load_once() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let prefix = Jit::with_slow_memory_resident()
        .build([addi(5, 5, 1), lwz(4, 3, 0)])
        .unwrap();
    let retry = Jit::with_slow_memory_resident()
        .build([lwz(4, 3, 0)])
        .unwrap();
    let hooks = rust_hook_module();
    Validator::new().validate_all(prefix.wasm()).unwrap();
    Validator::new().validate_all(retry.wasm()).unwrap();

    let script = r#"
const args = process.argv.slice(1);
const [prefixHex, retryHex, hooksHex] = args;
const [pcOffset, r3Offset, r4Offset, r5Offset, readCalls, readMode, readValue,
       initialPages, maximumPages, retryExecuted] = args.slice(3).map(Number);
const cpu = 0x10000;
const fastmem = 0x20000;
const startPc = 0x80004000;
const guestAddress = 0xcc001000;
const memory = new WebAssembly.Memory({ initial: initialPages, maximum: maximumPages });
const view = new DataView(memory.buffer);
const hooks = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(hooksHex, "hex")),
  { lazuli: { memory } },
).exports;
const imports = { lazuli: { memory, ...hooks } };
const prefix = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(prefixHex, "hex")), imports,
).exports;
const retry = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(retryHex, "hex")), imports,
).exports;

view.setUint32(cpu + pcOffset, startPc, true);
view.setUint32(cpu + r3Offset, guestAddress, true);
view.setUint32(cpu + r4Offset, 0xdeadbeef, true);
view.setUint32(cpu + r5Offset, 9, true);
view.setUint32(readMode, 2, true);
const yielded = prefix.run(0, cpu, fastmem) >>> 0;
if (yielded !== 0x00020001) {
  throw new Error(`yield did not report the one-instruction/two-cycle prefix: 0x${yielded.toString(16)}`);
}
if (view.getUint32(cpu + pcOffset, true) !== startPc + 4 ||
    view.getUint32(cpu + r4Offset, true) !== 0xdeadbeef ||
    view.getUint32(cpu + r5Offset, true) !== 10) {
  throw new Error("yield changed the load destination/PC or failed to retain its prefix");
}
if (view.getUint32(readCalls, true) !== 1) {
  throw new Error("yielding load did not call Rust exactly once");
}

view.setUint32(readMode, 0, true);
const completed = retry.run(0, cpu, fastmem) >>> 0;
if (completed !== (retryExecuted >>> 0) ||
    view.getUint32(cpu + pcOffset, true) !== startPc + 8 ||
    view.getUint32(cpu + r4Offset, true) !== (readValue >>> 0) ||
    view.getUint32(cpu + r5Offset, true) !== 10 ||
    view.getUint32(readCalls, true) !== 2) {
  throw new Error("unchanged load retry did not consume exactly once");
}
"#;

    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &hex(prefix.wasm()),
            &hex(retry.wasm()),
            &hex(&hooks),
            &Reg::PC.offset().to_string(),
            &GPR::R3.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &GPR::R5.offset().to_string(),
            &READ_CALLS.to_string(),
            &READ_MODE.to_string(),
            &READ_VALUE.to_string(),
            &RESIDENT_MEMORY_INITIAL_PAGES.to_string(),
            &RESIDENT_MEMORY_MAXIMUM_PAGES.to_string(),
            &retry.metadata().executed.pack().to_string(),
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
