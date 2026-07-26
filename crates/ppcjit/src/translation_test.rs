use std::process::Command;

use clifwasm::ModuleConfig;
use cranelift_codegen::ir::{self, Endianness, ExternalName, InstructionData, Opcode};
use cranelift_codegen::isa::CallConv;
use cranelift_codegen::{settings, verify_function};
use gekko::disasm::{Extensions, Ins, Opcode as GuestOpcode};
use gekko::{Exception, FPR, GPR, ProgramExceptionCause, Reg, SPR};

use crate::builder::BuilderError;
use crate::hooks::HookKind;
use crate::{
    BuildError, CodegenSettings, ExitMode, TranslationConfig, TranslationExit, Translator,
};

const TEST_HOOK_CYCLE_OFFSET: i32 = 12;

fn instruction(word: u32) -> Ins {
    Ins::new(word, Extensions::gekko_broadway())
}

fn cycle_config(exit_mode: ExitMode) -> TranslationConfig {
    let mut config = TranslationConfig::new(
        CodegenSettings::default(),
        ir::types::I32,
        CallConv::Fast,
        exit_mode,
    );
    config.hook_cycle_offset = Some(TEST_HOOK_CYCLE_OFFSET);
    config
}

fn translate_with_cycle_publication(
    instructions: impl IntoIterator<Item = Ins>,
) -> crate::Translation {
    Translator::new(cycle_config(ExitMode::ReturnExecutedWithSlowMemory))
        .translate(instructions.into_iter())
        .unwrap()
}

fn hook_call_cycles(function: &ir::Function, offset: i32) -> Vec<(u32, u32, u32)> {
    let entry = function.layout.entry_block().unwrap();
    let context = function.dfg.block_params(entry)[0];
    let mut calls = Vec::new();

    for block in function.layout.blocks() {
        let instructions = function.layout.block_insts(block).collect::<Vec<_>>();
        for (index, &instruction) in instructions.iter().enumerate() {
            let InstructionData::Call { func_ref, .. } = function.dfg.insts[instruction] else {
                continue;
            };
            let external = &function.dfg.ext_funcs[func_ref];
            let ExternalName::User(name_ref) = &external.name else {
                panic!("semantic hook did not use a user external name");
            };
            let name = &function.params.user_named_funcs()[*name_ref];

            let publication = index
                .checked_sub(1)
                .and_then(|previous| instructions.get(previous))
                .copied()
                .expect("semantic hook call did not have a preceding instruction");
            let data = function.dfg.insts[publication];
            assert_eq!(data.opcode(), Opcode::Store);
            assert_eq!(data.load_store_offset(), Some(offset));
            assert_eq!(
                data.memflags().unwrap().explicit_endianness(),
                Some(Endianness::Little)
            );
            let arguments = function.dfg.inst_args(publication);
            assert_eq!(arguments[1], context);

            let cycle_definition = function.dfg.value_def(arguments[0]).unwrap_inst();
            let InstructionData::UnaryImm {
                opcode: Opcode::Iconst,
                imm,
            } = function.dfg.insts[cycle_definition]
            else {
                panic!("hook cycle publication was not a constant");
            };
            calls.push((name.namespace, name.index, imm.bits() as u32));
        }
    }

    calls.sort_unstable();
    calls
}

fn context_store_count(function: &ir::Function, offset: i32) -> usize {
    let entry = function.layout.entry_block().unwrap();
    let context = function.dfg.block_params(entry)[0];
    function
        .layout
        .blocks()
        .flat_map(|block| function.layout.block_insts(block))
        .filter(|&instruction| {
            let data = function.dfg.insts[instruction];
            data.opcode() == Opcode::Store
                && data.load_store_offset() == Some(offset)
                && function.dfg.inst_args(instruction)[1] == context
        })
        .count()
}

fn user_hook_call_count(function: &ir::Function, hook: HookKind) -> usize {
    function
        .layout
        .blocks()
        .flat_map(|block| function.layout.block_insts(block))
        .filter(|&instruction| {
            let InstructionData::Call { func_ref, .. } = function.dfg.insts[instruction] else {
                return false;
            };
            let ExternalName::User(name_ref) = &function.dfg.ext_funcs[func_ref].name else {
                return false;
            };
            let name = &function.params.user_named_funcs()[*name_ref];
            name.namespace == 0 && name.index == hook as u32
        })
        .count()
}

fn psq(opcode: u32, fr: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> Ins {
    let word = opcode << 26
        | u32::from(fr) << 21
        | u32::from(ra) << 16
        | u32::from(w) << 15
        | u32::from(gqr & 7) << 12
        | u32::from(displacement as u16 & 0x0fff);
    instruction(word)
}

fn psqx(opcode: u32, fr: u8, ra: u8, rb: u8, w: bool, gqr: u8) -> Ins {
    let word = opcode
        | u32::from(fr) << 21
        | u32::from(ra) << 16
        | u32::from(rb) << 11
        | u32::from(w) << 10
        | u32::from(gqr & 7) << 7;
    instruction(word)
}

fn mtspr(rs: u8, spr: u16) -> Ins {
    let encoded_spr = (u32::from(spr) & 0x1f) << 16 | (u32::from(spr) >> 5) << 11;
    instruction(31 << 26 | u32::from(rs) << 21 | encoded_spr | 467 << 1)
}

fn stwu(rs: u8, ra: u8, displacement: i16) -> Ins {
    instruction(
        37 << 26 | u32::from(rs) << 21 | u32::from(ra) << 16 | u32::from(displacement as u16),
    )
}

fn stwux(rs: u8, ra: u8, rb: u8) -> Ins {
    instruction(
        31 << 26 | u32::from(rs) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11 | 183 << 1,
    )
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

fn mtmsr(rs: u8) -> Ins {
    instruction(31 << 26 | u32::from(rs) << 21 | 146 << 1)
}

fn tw(to: u8, ra: u8, rb: u8) -> Ins {
    instruction(
        31 << 26 | u32::from(to & 0x1f) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11 | 4 << 1,
    )
}

fn twi(to: u8, ra: u8, immediate: i16) -> Ins {
    instruction(
        3 << 26 | u32::from(to & 0x1f) << 21 | u32::from(ra) << 16 | u32::from(immediate as u16),
    )
}

fn ps_abs(fd: u8, fb: u8, record: bool) -> Ins {
    instruction(0x1000_0210 | u32::from(fd) << 21 | u32::from(fb) << 11 | u32::from(record))
}

fn ps_nabs(fd: u8, fb: u8, record: bool) -> Ins {
    instruction(0x1000_0110 | u32::from(fd) << 21 | u32::from(fb) << 11 | u32::from(record))
}

fn mtfsfi(field: u8, immediate: u8, record: bool) -> Ins {
    instruction(
        0xfc00_010c
            | u32::from(field & 7) << 23
            | u32::from(immediate & 0xf) << 12
            | u32::from(record),
    )
}

fn tlbie(rb: u8) -> Ins {
    instruction(0x7c00_0264 | u32::from(rb) << 11)
}

fn tlbsync() -> Ins {
    instruction(0x7c00_046c)
}

fn mfsr(rd: u8, sr: u8) -> Ins {
    instruction(0x7c00_04a6 | u32::from(rd) << 21 | u32::from(sr & 0xf) << 16)
}

fn mtsr(rs: u8, sr: u8) -> Ins {
    instruction(0x7c00_01a4 | u32::from(rs) << 21 | u32::from(sr & 0xf) << 16)
}

fn mfsrin(rd: u8, rb: u8) -> Ins {
    instruction(0x7c00_0526 | u32::from(rd) << 21 | u32::from(rb) << 11)
}

fn mtsrin(rs: u8, rb: u8) -> Ins {
    instruction(0x7c00_01e4 | u32::from(rs) << 21 | u32::from(rb) << 11)
}

fn lower_portable(function: &ir::Function) -> Vec<u8> {
    clifwasm::function(
        function,
        &ModuleConfig::new("lazuli", "memory", "run")
            .with_function_import_module("lazuli_hooks")
            .with_stack_scratch(0, 32, 8),
    )
    .unwrap_or_else(|error| panic!("portable lowering failed: {error:?}\n{function}"))
}

#[test]
fn return_executed_uses_portable_signature_and_single_block() {
    // addi r3, r0, 7; oris r3, r3, 0x1234
    let instructions = [
        Ins::new(0x3860_0007, Extensions::gekko_broadway()),
        Ins::new(0x6463_1234, Extensions::gekko_broadway()),
    ];
    let mut translator = Translator::new(TranslationConfig::new(
        CodegenSettings::default(),
        ir::types::I32,
        CallConv::SystemV,
        ExitMode::ReturnExecuted,
    ));

    let translated = translator.translate(instructions.into_iter()).unwrap();
    let flags = settings::Flags::new(settings::builder());
    verify_function(&translated.function, &flags).unwrap();

    assert_eq!(translated.sequence.len(), 2);
    assert_eq!(translated.cycles, 3);
    assert_eq!(translated.exit, TranslationExit::Fallthrough);
    assert_eq!(translated.function.signature.params.len(), 3);
    assert!(
        translated
            .function
            .signature
            .params
            .iter()
            .all(|param| param.value_type == ir::types::I32)
    );
    assert_eq!(translated.function.signature.returns.len(), 1);
    assert_eq!(
        translated.function.signature.returns[0].value_type,
        ir::types::I32
    );
    assert_eq!(translated.function.signature.call_conv, CallConv::SystemV);
    assert_eq!(translated.function.layout.blocks().count(), 1);

    let clif = translated.function.display().to_string();
    assert!(clif.contains("iconst.i32 0x0003_0002"));
    assert!(!clif.contains("return_call_indirect"));
    assert!(!clif.contains("global_value"));
}

#[test]
fn portable_fastmem_uses_configured_pointer_width() {
    // lwz r4, 0(r3)
    let instruction = Ins::new(0x8083_0000, Extensions::gekko_broadway());
    let mut translator = Translator::new(TranslationConfig::new(
        CodegenSettings::default(),
        ir::types::I32,
        CallConv::Fast,
        ExitMode::ReturnExecuted,
    ));

    let translated = translator.translate([instruction].into_iter()).unwrap();
    let flags = settings::Flags::new(settings::builder());
    verify_function(&translated.function, &flags).unwrap();
    let strides = translated
        .function
        .layout
        .blocks()
        .flat_map(|block| translated.function.layout.block_insts(block))
        .filter_map(|inst| match translated.function.dfg.insts[inst] {
            InstructionData::BinaryImm64 {
                opcode: Opcode::ImulImm,
                imm,
                ..
            } => Some(imm.bits()),
            _ => None,
        })
        .collect::<Vec<_>>();

    assert_eq!(strides, [4]);
    assert_eq!(translated.function.layout.blocks().count(), 1);
    let clif = translated.function.display().to_string();
    assert!(!clif.contains(" call "));
    assert!(!clif.contains("brif"));
}

#[test]
fn illegal_instruction_raises_program_after_the_portable_exception_hook() {
    let illegal = instruction(0);
    assert_eq!(illegal.op, GuestOpcode::Illegal);

    let translated = translate_with_cycle_publication([illegal]);
    assert_eq!(translated.sequence.0, [illegal]);
    assert_eq!(translated.cycles, 2);
    assert_eq!(translated.exit, TranslationExit::Synchronous);
    assert_eq!(
        hook_call_cycles(&translated.function, TEST_HOOK_CYCLE_OFFSET),
        [(1, 0, 0)]
    );

    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let wasm = lower_portable(&translated.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let script = r#"
const [
  wasmHex,
  cycleOffset,
  pcOffset,
  srr1Offset,
  programException,
  illegalCause,
] = process.argv.slice(1).map((value, index) => index === 0 ? value : Number(value));

const context = 32;
const cpu = 128;
const fastmem = 0x10000;
const initialPc = 0x80001234;
const initialSrr1 = 0x7ffc1234;
const postHookSrr1 = 0x80010042;
const memory = new WebAssembly.Memory({ initial: 2 });
const view = new DataView(memory.buffer);
const events = [];
view.setUint32(cpu + pcOffset, initialPc, true);
view.setUint32(cpu + srr1Offset, initialSrr1, true);

const hooks = {
  user_1_0(registers, exception) {
    events.push([
      view.getUint32(context + cycleOffset, true),
      registers,
      exception,
      view.getUint32(registers + srr1Offset, true),
    ]);
    view.setUint32(registers + srr1Offset, postHookSrr1, true);
  },
};
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), {
  lazuli: { memory },
  lazuli_hooks: hooks,
});
const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
if (executed !== 0x00020001) {
  throw new Error(`illegal instruction returned 0x${executed.toString(16)}`);
}
const expectedEvents = [[0, cpu, programException, initialSrr1]];
if (JSON.stringify(events) !== JSON.stringify(expectedEvents)) {
  throw new Error(`exception hook observed ${JSON.stringify(events)}`);
}
if (view.getUint32(cpu + srr1Offset, true) !== (postHookSrr1 | illegalCause) >>> 0) {
  throw new Error(
    `illegal cause did not modify post-hook SRR1: 0x${view.getUint32(cpu + srr1Offset, true).toString(16)}`,
  );
}
if (view.getUint32(cpu + pcOffset, true) !== initialPc) {
  throw new Error("illegal instruction advanced PC");
}
"#;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &wasm,
            &TEST_HOOK_CYCLE_OFFSET.to_string(),
            &Reg::PC.offset().to_string(),
            &SPR::SRR1.offset().to_string(),
            &(Exception::Program as u16).to_string(),
            &ProgramExceptionCause::IllegalInstruction
                .srr1_bits()
                .to_string(),
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
fn portable_trap_word_predicates_preserve_the_exact_exception_boundary() {
    let prefix = instruction(14 << 26 | 6 << 21 | 6 << 16); // addi r6,r6,0
    let later = instruction(14 << 26 | 5 << 21 | 0x55aa); // addi r5,r0,0x55aa
    let traps = [
        ("tw_slt", tw(0x10, 3, 4)),
        ("tw_sgt", tw(0x08, 3, 4)),
        ("tw_eq", tw(0x04, 3, 4)),
        ("tw_ult", tw(0x02, 3, 4)),
        ("tw_ugt", tw(0x01, 3, 4)),
        ("tw_combined", tw(0x14, 3, 4)),
        ("tw_none", tw(0x00, 3, 4)),
        ("twi_sgt_neg1", twi(0x08, 3, -1)),
        ("twi_ult_neg1", twi(0x02, 3, -1)),
        ("twi_eq_min", twi(0x04, 3, i16::MIN)),
    ];
    for (name, trap) in traps {
        assert!(
            matches!(trap.op, GuestOpcode::Tw | GuestOpcode::Twi),
            "{name} decoded as {:?}",
            trap.op
        );
    }

    let modules = traps
        .into_iter()
        .map(|(name, trap)| {
            let translated = translate_with_cycle_publication([prefix, trap, later]);
            assert_eq!(translated.sequence.0, [prefix, trap, later]);
            assert_eq!(translated.cycles, 6);
            assert_eq!(translated.exit, TranslationExit::Fallthrough);
            assert_eq!(
                hook_call_cycles(&translated.function, TEST_HOOK_CYCLE_OFFSET),
                [(1, 0, 2)]
            );

            let wasm = lower_portable(&translated.function)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("{name}:{wasm}")
        })
        .collect::<Vec<_>>();

    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let script = r#"
const [
  cycleOffsetText,
  pcOffsetText,
  r3OffsetText,
  r4OffsetText,
  r5OffsetText,
  srr0OffsetText,
  srr1OffsetText,
  programExceptionText,
  trapCauseText,
  ...moduleSpecs
] = process.argv.slice(1);
const [
  cycleOffset,
  pcOffset,
  r3Offset,
  r4Offset,
  r5Offset,
  srr0Offset,
  srr1Offset,
  programException,
  trapCause,
] = [
  cycleOffsetText,
  pcOffsetText,
  r3OffsetText,
  r4OffsetText,
  r5OffsetText,
  srr0OffsetText,
  srr1OffsetText,
  programExceptionText,
  trapCauseText,
].map(Number);
const modules = new Map(moduleSpecs.map((spec) => {
  const separator = spec.indexOf(":");
  return [spec.slice(0, separator), spec.slice(separator + 1)];
}));

const context = 32;
const cpu = 128;
const fastmem = 0x10000;
const initialPc = 0x80003000;
const initialSrr0 = 0xaabbccdd;
const initialSrr1 = 0x13572468;
const postHookSrr1 = 0x80010042;
const exceptionVector = 0xfff00700;
const untouchedR5 = 0xdeadbeef;

async function execute(name, lhs, rhs, shouldTrap, label) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r3Offset, lhs, true);
  view.setUint32(cpu + r4Offset, rhs, true);
  view.setUint32(cpu + r5Offset, untouchedR5, true);
  view.setUint32(cpu + srr0Offset, initialSrr0, true);
  view.setUint32(cpu + srr1Offset, initialSrr1, true);

  const hooks = {
    user_1_0(registers, exception) {
      const trapPc = view.getUint32(registers + pcOffset, true);
      events.push([
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
        trapPc,
      ]);
      view.setUint32(registers + srr0Offset, trapPc, true);
      view.setUint32(registers + srr1Offset, postHookSrr1, true);
      view.setUint32(registers + pcOffset, exceptionVector, true);
    },
  };
  const hex = modules.get(name);
  if (hex === undefined) throw new Error(`missing module ${name}`);
  const { instance } = await WebAssembly.instantiate(Buffer.from(hex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;

  if (shouldTrap) {
    if (executed !== 0x00040002) {
      throw new Error(`${label} returned taken counters 0x${executed.toString(16)}`);
    }
    const expectedEvents = [[2, cpu, programException, initialPc + 4]];
    if (JSON.stringify(events) !== JSON.stringify(expectedEvents)) {
      throw new Error(`${label} observed ${JSON.stringify(events)}`);
    }
    if (view.getUint32(cpu + pcOffset, true) !== exceptionVector) {
      throw new Error(`${label} did not retain the Program vector`);
    }
    if (view.getUint32(cpu + srr0Offset, true) !== initialPc + 4) {
      throw new Error(`${label} did not retain the trapping PC in SRR0`);
    }
    if (view.getUint32(cpu + srr1Offset, true) !== (postHookSrr1 | trapCause) >>> 0) {
      throw new Error(`${label} did not retain the Trap cause`);
    }
    if (view.getUint32(cpu + r5Offset, true) !== untouchedR5) {
      throw new Error(`${label} executed beyond the taken trap`);
    }
  } else {
    if (executed !== 0x00060003) {
      throw new Error(`${label} returned untaken counters 0x${executed.toString(16)}`);
    }
    if (events.length !== 0) {
      throw new Error(`${label} raised an untaken trap`);
    }
    if (view.getUint32(cpu + pcOffset, true) !== initialPc + 12) {
      throw new Error(`${label} did not continue after an untaken trap`);
    }
    if (view.getUint32(cpu + srr0Offset, true) !== initialSrr0
        || view.getUint32(cpu + srr1Offset, true) !== initialSrr1) {
      throw new Error(`${label} changed exception state without trapping`);
    }
    if (view.getUint32(cpu + r5Offset, true) !== 0x55aa) {
      throw new Error(`${label} did not execute after an untaken trap`);
    }
  }
}

await execute("tw_slt", 0x80000000, 0x7fffffff, true, "signed LT taken");
await execute("tw_slt", 0x7fffffff, 0x80000000, false, "signed LT untaken");
await execute("tw_sgt", 0x7fffffff, 0x80000000, true, "signed GT taken");
await execute("tw_sgt", 0x80000000, 0x7fffffff, false, "signed GT untaken");
await execute("tw_eq", 0x80000000, 0x80000000, true, "EQ taken");
await execute("tw_eq", 1, 2, false, "EQ untaken");
await execute("tw_ult", 0, 0xffffffff, true, "unsigned LT taken");
await execute("tw_ult", 0xffffffff, 0, false, "unsigned LT untaken");
await execute("tw_ugt", 0xffffffff, 0, true, "unsigned GT taken");
await execute("tw_ugt", 0, 0xffffffff, false, "unsigned GT untaken");
await execute("tw_combined", 0x12345678, 0x12345678, true, "combined EQ taken");
await execute("tw_combined", 5, 4, false, "combined untaken");
await execute("tw_none", 0x12345678, 0x12345678, false, "empty TO");
await execute("twi_sgt_neg1", 0, 0, true, "twi signed sign extension");
await execute("twi_sgt_neg1", 0xffffffff, 0, false, "twi signed equality");
await execute("twi_ult_neg1", 0xfffffffe, 0, true, "twi unsigned sign extension");
await execute("twi_ult_neg1", 0xffffffff, 0, false, "twi unsigned equality");
await execute("twi_eq_min", 0xffff8000, 0, true, "twi minimum equality");
await execute("twi_eq_min", 0x00008000, 0, false, "twi minimum mismatch");
"#;
    let mut command = Command::new("node");
    command.args([
        "--input-type=module",
        "--eval",
        script,
        &TEST_HOOK_CYCLE_OFFSET.to_string(),
        &Reg::PC.offset().to_string(),
        &GPR::R3.offset().to_string(),
        &GPR::R4.offset().to_string(),
        &GPR::R5.offset().to_string(),
        &SPR::SRR0.offset().to_string(),
        &SPR::SRR1.offset().to_string(),
        &(Exception::Program as u16).to_string(),
        &ProgramExceptionCause::Trap.srr1_bits().to_string(),
    ]);
    command.args(&modules);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "node failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn portable_paired_sign_moves_and_mtfsfi_preserve_exact_bits() {
    let instructions = [
        ("ps_abs_rc0", ps_abs(2, 1, false), 2u16),
        ("ps_abs_rc1", ps_abs(2, 1, true), 2),
        ("ps_nabs_rc0", ps_nabs(2, 1, false), 2),
        ("ps_nabs_rc1", ps_nabs(2, 1, true), 2),
        ("mtfs_bf0_rc0", mtfsfi(0, 0xf, false), 1),
        ("mtfs_bf3_rc1", mtfsfi(3, 0x8, true), 1),
        ("mtfs_bf6_rc0", mtfsfi(6, 0x4, false), 1),
        ("mtfs_bf7_rc1", mtfsfi(7, 0x5, true), 1),
    ];
    let modules = instructions
        .into_iter()
        .map(|(name, instruction, cycles)| {
            assert!(
                matches!(
                    instruction.op,
                    GuestOpcode::PsAbs | GuestOpcode::PsNabs | GuestOpcode::Mtfsfi
                ),
                "{name} decoded as {:?}",
                instruction.op
            );
            let translated = translate_with_cycle_publication([instruction]);
            assert_eq!(translated.sequence.0, [instruction]);
            assert_eq!(translated.cycles, cycles);
            assert_eq!(translated.exit, TranslationExit::Fallthrough);
            assert_eq!(
                hook_call_cycles(&translated.function, TEST_HOOK_CYCLE_OFFSET),
                [(1, 0, 0)]
            );

            let wasm = lower_portable(&translated.function)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("{name}:{wasm}")
        })
        .collect::<Vec<_>>();

    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let script = r#"
const [
  cycleOffsetText,
  pcOffsetText,
  msrOffsetText,
  crOffsetText,
  fpscrOffsetText,
  f1OffsetText,
  f2OffsetText,
  srr0OffsetText,
  floatUnavailableText,
  ...moduleSpecs
] = process.argv.slice(1);
const [
  cycleOffset,
  pcOffset,
  msrOffset,
  crOffset,
  fpscrOffset,
  f1Offset,
  f2Offset,
  srr0Offset,
  floatUnavailable,
] = [
  cycleOffsetText,
  pcOffsetText,
  msrOffsetText,
  crOffsetText,
  fpscrOffsetText,
  f1OffsetText,
  f2OffsetText,
  srr0OffsetText,
  floatUnavailableText,
].map(Number);
const modules = new Map(moduleSpecs.map((spec) => {
  const separator = spec.indexOf(":");
  return [spec.slice(0, separator), spec.slice(separator + 1)];
}));

const context = 32;
const cpu = 128;
const initialPc = 0x80005000;
const initialCr = 0xa5ffffff;
const floatAvailable = 1 << 13;
const cr1Mask = 0x0f000000;
const derivedMask = 0x60000000;

function normalizeFpscr(raw) {
  let value = raw >>> 0;
  const invalid = value & 0x01f80700;
  value = invalid !== 0 ? (value | 0x20000000) >>> 0 : (value & ~0x20000000) >>> 0;
  const exceptions = value >>> 22;
  const enables = value & 0x000000f8;
  value = (exceptions & enables) !== 0
    ? (value | 0x40000000) >>> 0
    : (value & ~0x40000000) >>> 0;
  return value;
}

function expectedCr1(cr, fpscr) {
  return ((cr & ~cr1Mask) | ((fpscr >>> 4) & cr1Mask)) >>> 0;
}

async function instantiate(name, setup, hook) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  view.setUint32(cpu + pcOffset, initialPc, true);
  setup(view);
  const hex = modules.get(name);
  if (hex === undefined) throw new Error(`missing module ${name}`);
  const { instance } = await WebAssembly.instantiate(Buffer.from(hex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: { user_1_0: hook ?? (() => {
      throw new Error(`${name} raised an unexpected floating-point exception`);
    }) },
  });
  const executed = instance.exports.run(context, cpu, 0) >>> 0;
  return { view, executed };
}

async function executeSignMove(name, input, expected, record) {
  const initialFpscr = 0x90000000;
  const { view, executed } = await instantiate(name, (view) => {
    view.setUint32(cpu + msrOffset, floatAvailable, true);
    view.setUint32(cpu + crOffset, initialCr, true);
    view.setUint32(cpu + fpscrOffset, initialFpscr, true);
    view.setBigUint64(cpu + f1Offset, input[0], true);
    view.setBigUint64(cpu + f1Offset + 8, input[1], true);
  });
  if (executed !== 0x00020001) {
    throw new Error(`${name} returned 0x${executed.toString(16)}`);
  }
  const actual = [
    view.getBigUint64(cpu + f2Offset, true),
    view.getBigUint64(cpu + f2Offset + 8, true),
  ];
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    throw new Error(`${name} produced ${actual.map((bits) => bits.toString(16)).join(",")}`);
  }
  if (view.getUint32(cpu + fpscrOffset, true) !== initialFpscr) {
    throw new Error(`${name} changed FPSCR`);
  }
  const expectedCr = record ? expectedCr1(initialCr, initialFpscr) : initialCr;
  if (view.getUint32(cpu + crOffset, true) !== expectedCr) {
    throw new Error(`${name} produced CR 0x${view.getUint32(cpu + crOffset, true).toString(16)}`);
  }
  if (view.getUint32(cpu + pcOffset, true) !== initialPc + 4) {
    throw new Error(`${name} did not advance PC once`);
  }
}

const negativeZeroAndNan = [0x8000000000000000n, 0xfff8123456789abcn];
const absoluteZeroAndNan = [0x0000000000000000n, 0x7ff8123456789abcn];
const positiveInfinityAndNan = [0x7ff0000000000000n, 0x7ff8deadbeef0042n];
const negativeInfinityAndNan = [0xfff0000000000000n, 0xfff8deadbeef0042n];
await executeSignMove("ps_abs_rc0", negativeZeroAndNan, absoluteZeroAndNan, false);
await executeSignMove("ps_abs_rc1", negativeZeroAndNan, absoluteZeroAndNan, true);
await executeSignMove("ps_nabs_rc0", positiveInfinityAndNan, negativeInfinityAndNan, false);
await executeSignMove("ps_nabs_rc1", positiveInfinityAndNan, negativeInfinityAndNan, true);

async function executeMtfs(name, bf, immediate, record, initialFpscr) {
  const { view, executed } = await instantiate(name, (view) => {
    view.setUint32(cpu + msrOffset, floatAvailable, true);
    view.setUint32(cpu + crOffset, initialCr, true);
    view.setUint32(cpu + fpscrOffset, initialFpscr, true);
  });
  if (executed !== 0x00010001) {
    throw new Error(`${name} returned 0x${executed.toString(16)}`);
  }
  const shift = 28 - 4 * bf;
  const selectedMask = (0xf << shift) >>> 0;
  const direct = ((initialFpscr & ~selectedMask) | ((immediate << shift) & selectedMask)) >>> 0;
  const expected = normalizeFpscr(direct);
  const actual = view.getUint32(cpu + fpscrOffset, true);
  if (actual !== expected) {
    throw new Error(`${name} produced FPSCR 0x${actual.toString(16)}, expected 0x${expected.toString(16)}`);
  }
  const preservedMask = ~(selectedMask | derivedMask) >>> 0;
  if ((actual & preservedMask) !== (initialFpscr & preservedMask)) {
    throw new Error(`${name} changed a non-selected, non-derived FPSCR bit`);
  }
  const selectedNonDerived = selectedMask & ~derivedMask;
  if ((actual & selectedNonDerived) !== (direct & selectedNonDerived)) {
    throw new Error(`${name} did not replace the selected FPSCR nibble`);
  }
  if ((actual & derivedMask) !== (expected & derivedMask)) {
    throw new Error(`${name} did not normalize VX/FEX`);
  }
  const expectedCr = record ? expectedCr1(initialCr, expected) : initialCr;
  if (view.getUint32(cpu + crOffset, true) !== expectedCr) {
    throw new Error(`${name} produced CR 0x${view.getUint32(cpu + crOffset, true).toString(16)}`);
  }
}

await executeMtfs("mtfs_bf0_rc0", 0, 0xf, false, 0x00010004);
await executeMtfs("mtfs_bf3_rc1", 3, 0x8, true, 0x80000080);
await executeMtfs("mtfs_bf6_rc0", 6, 0x4, false, 0x10000000);
await executeMtfs("mtfs_bf7_rc1", 7, 0x5, true, 0x81a50780);

const disabledFpscr = 0x12345678;
const disabledCr = 0xa5ffffff;
const disabledEvents = [];
let disabledView;
const disabled = await instantiate("mtfs_bf3_rc1", (view) => {
  disabledView = view;
  view.setUint32(cpu + msrOffset, 0, true);
  view.setUint32(cpu + crOffset, disabledCr, true);
  view.setUint32(cpu + fpscrOffset, disabledFpscr, true);
  view.setUint32(cpu + srr0Offset, 0, true);
}, (registers, exception) => {
  const view = disabledView;
  const faultPc = view.getUint32(registers + pcOffset, true);
  disabledEvents.push([
    view.getUint32(context + cycleOffset, true),
    registers,
    exception,
    faultPc,
  ]);
  view.setUint32(registers + srr0Offset, faultPc, true);
  view.setUint32(registers + pcOffset, 0xfff00800, true);
});
if (disabled.executed !== 0x00020001) {
  throw new Error(`disabled mtfsfi returned 0x${disabled.executed.toString(16)}`);
}
const expectedDisabledEvents = [[0, cpu, floatUnavailable, initialPc]];
if (JSON.stringify(disabledEvents) !== JSON.stringify(expectedDisabledEvents)) {
  throw new Error(`disabled mtfsfi observed ${JSON.stringify(disabledEvents)}`);
}
if (disabledView.getUint32(cpu + pcOffset, true) !== 0xfff00800
    || disabledView.getUint32(cpu + srr0Offset, true) !== initialPc) {
  throw new Error("disabled mtfsfi lost its exception boundary");
}
if (disabledView.getUint32(cpu + fpscrOffset, true) !== disabledFpscr
    || disabledView.getUint32(cpu + crOffset, true) !== disabledCr) {
  throw new Error("disabled mtfsfi changed floating-point state");
}
"#;
    let mut command = Command::new("node");
    command.args([
        "--input-type=module",
        "--eval",
        script,
        &TEST_HOOK_CYCLE_OFFSET.to_string(),
        &Reg::PC.offset().to_string(),
        &Reg::MSR.offset().to_string(),
        &Reg::CR.offset().to_string(),
        &Reg::FPSCR.offset().to_string(),
        &FPR::R1.offset().to_string(),
        &FPR::R2.offset().to_string(),
        &SPR::SRR0.offset().to_string(),
        &(Exception::FloatUnavailable as u16).to_string(),
    ]);
    command.args(&modules);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "node failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn portable_indexed_quantized_forms_use_x_fields_and_update_the_base() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    // Indexed PSQ encodes W in bit 10 and I in bits 7..9. Choose rB values whose bits make the
    // D-form W/I accessors disagree, so this is also a regression proof for the field selection.
    let load = psqx(0x1000_000c, 2, 3, 5, true, 6);
    assert_eq!(load.op, GuestOpcode::PsqLx);
    assert_eq!((load.field_ps_w(), load.field_ps_i()), (0, 2));
    assert_eq!((load.field_ps_wx(), load.field_ps_ix()), (1, 6));

    let load_update = psqx(0x1000_004c, 3, 3, 17, false, 7);
    assert_eq!(load_update.op, GuestOpcode::PsqLux);
    assert_eq!((load_update.field_ps_w(), load_update.field_ps_i()), (1, 0));
    assert_eq!(
        (load_update.field_ps_wx(), load_update.field_ps_ix()),
        (0, 7)
    );

    let store = psqx(0x1000_000e, 4, 4, 5, true, 6);
    assert_eq!(store.op, GuestOpcode::PsqStx);
    assert_eq!((store.field_ps_w(), store.field_ps_i()), (0, 2));
    assert_eq!((store.field_ps_wx(), store.field_ps_ix()), (1, 6));

    let store_update = psqx(0x1000_004e, 5, 4, 17, false, 7);
    assert_eq!(store_update.op, GuestOpcode::PsqStux);
    assert_eq!(
        (store_update.field_ps_w(), store_update.field_ps_i()),
        (1, 0)
    );
    assert_eq!(
        (store_update.field_ps_wx(), store_update.field_ps_ix()),
        (0, 7)
    );

    let lower = |ins| {
        let mut config = TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I32,
            CallConv::Fast,
            ExitMode::ReturnExecutedWithSlowMemory,
        );
        config.settings.force_fpu = true;
        let translated = Translator::new(config)
            .translate([ins].into_iter())
            .unwrap();
        assert_eq!(translated.sequence.len(), 1);
        assert_eq!(translated.cycles, 2);
        assert_eq!(translated.exit, TranslationExit::Fallthrough);
        lower_portable(&translated.function)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };

    let load = lower(load);
    let load_update = lower(load_update);
    let store = lower(store);
    let store_update = lower(store_update);
    let script = r#"
const [
  loadHex,
  loadUpdateHex,
  storeHex,
  storeUpdateHex,
  pcOffset,
  r3Offset,
  r4Offset,
  r5Offset,
  r17Offset,
  f2Offset,
  f3Offset,
  f4Offset,
  f5Offset,
  gqr6Offset,
  gqr7Offset,
] = process.argv.slice(1).map((value, index) => index < 4 ? value : Number(value));

const cpu = 64;
const fastmem = 0x10000;
const page = 0x40000;
const initialPc = 0x80001000;
const initialBase = 0x80001000;
const mappedGuestPage = 0x80000000;

async function execute(hex, setup, verify) {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const view = new DataView(memory.buffer);
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(fastmem + (mappedGuestPage >>> 17) * 4, page, true);
  // GQR6 is unsigned-halfword load/store; GQR7 is signed-halfword load/store.
  view.setUint32(cpu + gqr6Offset, (5 << 16) | 5, true);
  view.setUint32(cpu + gqr7Offset, (7 << 16) | 7, true);
  setup(view);

  const hooks = new Proxy({}, {
    get(_target, name) {
      return () => { throw new Error("unexpected runtime hook: " + String(name)); };
    },
  });
  const { instance } = await WebAssembly.instantiate(Buffer.from(hex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(0, cpu, fastmem) >>> 0;
  if (executed !== 0x00020001) {
    throw new Error(`indexed PSQ returned 0x${executed.toString(16)}`);
  }
  if (view.getUint32(cpu + pcOffset, true) !== initialPc + 4) {
    throw new Error("indexed PSQ did not advance PC exactly once");
  }
  verify(view);
}

await execute(loadHex, (view) => {
  view.setUint32(cpu + r3Offset, initialBase, true);
  view.setUint32(cpu + r5Offset, 0x1000, true);
  new Uint8Array(view.buffer, page + 0x2000, 4).set([0x12, 0x34, 0xab, 0xcd]);
}, (view) => {
  const actual = [
    view.getFloat64(cpu + f2Offset, true),
    view.getFloat64(cpu + f2Offset + 8, true),
  ];
  if (actual[0] !== 0x1234 || actual[1] !== 1) {
    throw new Error("psq_lx used the wrong W/I fields or guest byte order: " + actual.join(","));
  }
  if (view.getUint32(cpu + r3Offset, true) !== initialBase) {
    throw new Error("psq_lx updated rA");
  }
});

await execute(loadUpdateHex, (view) => {
  view.setUint32(cpu + r3Offset, initialBase, true);
  view.setUint32(cpu + r17Offset, 0x1000, true);
  new Uint8Array(view.buffer, page + 0x2000, 4).set([0xff, 0xfe, 0x00, 0x03]);
}, (view) => {
  const actual = [
    view.getFloat64(cpu + f3Offset, true),
    view.getFloat64(cpu + f3Offset + 8, true),
  ];
  if (actual[0] !== -2 || actual[1] !== 3) {
    throw new Error("psq_lux used the wrong W/I fields or guest byte order: " + actual.join(","));
  }
  if (view.getUint32(cpu + r3Offset, true) !== 0x80002000) {
    throw new Error("psq_lux did not commit rA = rA + rB");
  }
});

await execute(storeHex, (view) => {
  view.setUint32(cpu + r4Offset, initialBase, true);
  view.setUint32(cpu + r5Offset, 0x1010, true);
  view.setFloat64(cpu + f4Offset, 0x1234, true);
  view.setFloat64(cpu + f4Offset + 8, 0x5678, true);
  new Uint8Array(view.buffer, page + 0x2010, 4).set([0xcc, 0xcc, 0xdd, 0xdd]);
}, (view) => {
  const actual = Array.from(new Uint8Array(view.buffer, page + 0x2010, 4));
  if (actual.join(",") !== "18,52,221,221") {
    throw new Error("psq_stx used the wrong W/I fields or guest byte order: " + actual.join(","));
  }
  if (view.getUint32(cpu + r4Offset, true) !== initialBase) {
    throw new Error("psq_stx updated rA");
  }
});

await execute(storeUpdateHex, (view) => {
  view.setUint32(cpu + r4Offset, initialBase, true);
  view.setUint32(cpu + r17Offset, 0x1014, true);
  view.setFloat64(cpu + f5Offset, -2, true);
  view.setFloat64(cpu + f5Offset + 8, 3, true);
}, (view) => {
  const actual = Array.from(new Uint8Array(view.buffer, page + 0x2014, 4));
  if (actual.join(",") !== "255,254,0,3") {
    throw new Error("psq_stux used the wrong W/I fields or guest byte order: " + actual.join(","));
  }
  if (view.getUint32(cpu + r4Offset, true) !== 0x80002014) {
    throw new Error("psq_stux did not commit rA = rA + rB");
  }
});
"#;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &load,
            &load_update,
            &store,
            &store_update,
            &Reg::PC.offset().to_string(),
            &GPR::R3.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &GPR::R5.offset().to_string(),
            &GPR::R17.offset().to_string(),
            &FPR::R2.offset().to_string(),
            &FPR::R3.offset().to_string(),
            &FPR::R4.offset().to_string(),
            &FPR::R5.offset().to_string(),
            &SPR::GQR[6].offset().to_string(),
            &SPR::GQR[7].offset().to_string(),
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
fn hook_cycle_publication_is_opt_in_and_rejects_native_exit_mode() {
    let default = TranslationConfig::new(
        CodegenSettings::default(),
        ir::types::I32,
        CallConv::Fast,
        ExitMode::ReturnExecutedWithSlowMemory,
    );
    assert_eq!(default.hook_cycle_offset, None);

    let fixture = [instruction(0x3860_1000), instruction(0x8083_0000)];
    let mut translator = Translator::new(default);
    let translated = translator.translate(fixture.into_iter()).unwrap();
    assert_eq!(
        context_store_count(&translated.function, TEST_HOOK_CYCLE_OFFSET),
        0
    );

    let mut translator = Translator::new(cycle_config(ExitMode::Native));
    let error = translator.translate(fixture.into_iter()).err().unwrap();
    assert!(matches!(
        error,
        BuildError::Builder {
            source: BuilderError::HookCycleOffsetRequiresPortableExit,
        }
    ));
}

#[test]
fn address_space_hook_ids_are_stable_and_append_only() {
    assert_eq!(HookKind::DecChanged as u32, 22);
    assert_eq!(HookKind::SrChanged as u32, 23);
    assert_eq!(HookKind::Sdr1Changed as u32, 24);
    assert_eq!(HookKind::Tlbie as u32, 25);
    assert_eq!(HookKind::Tlbsync as u32, 26);
    assert_eq!(HookKind::LoadReserve as u32, 27);
    assert_eq!(HookKind::StoreConditional as u32, 28);
}

#[test]
fn reservation_instructions_use_dedicated_hooks_at_stable_cycles() {
    let load = translate_with_cycle_publication([lwarx(4, 3, 5)]);
    let store = translate_with_cycle_publication([stwcx(6, 7, 8)]);

    for (translation, hook) in [
        (&load, HookKind::LoadReserve),
        (&store, HookKind::StoreConditional),
    ] {
        assert_eq!(translation.sequence.len(), 1);
        assert_eq!(translation.cycles, 2);
        assert_eq!(translation.exit, TranslationExit::Fallthrough);
        assert_eq!(user_hook_call_count(&translation.function, hook), 1);
        assert_eq!(
            hook_call_cycles(&translation.function, TEST_HOOK_CYCLE_OFFSET)
                .into_iter()
                .filter(|(namespace, _, _)| *namespace == 0)
                .collect::<Vec<_>>(),
            [(0, hook as u32, 0)]
        );
    }

    assert_eq!(user_hook_call_count(&load.function, HookKind::ReadI32), 0);
    assert_eq!(user_hook_call_count(&store.function, HookKind::WriteI32), 0);
}

#[test]
fn portable_reservations_observe_alignment_fault_and_completion_boundaries() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let load_indexed = translate_with_cycle_publication([lwarx(4, 3, 5)]);
    let load_zero_base = translate_with_cycle_publication([lwarx(4, 0, 5)]);
    let store = translate_with_cycle_publication([stwcx(6, 7, 8)]);
    for translation in [&load_indexed, &load_zero_base, &store] {
        assert_eq!(translation.sequence.len(), 1);
        assert_eq!(translation.cycles, 2);
        assert_eq!(translation.exit, TranslationExit::Fallthrough);
    }
    let load_indexed = lower_portable(&load_indexed.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let load_zero_base = lower_portable(&load_zero_base.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let store = lower_portable(&store.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let script = r#"
const [
  loadIndexedHex,
  loadZeroBaseHex,
  storeHex,
  cycleOffset,
  pcOffset,
  crOffset,
  r0Offset,
  r3Offset,
  r4Offset,
  r5Offset,
  r6Offset,
  r7Offset,
  r8Offset,
  xerOffset,
  darOffset,
  dsisrOffset,
  loadReserveHook,
  storeConditionalHook,
  dsiException,
  alignmentException,
] = process.argv.slice(1).map((value, index) => index < 3 ? value : Number(value));

const context = 32;
const cpu = 128;
const fastmem = 0x10000;
const initialPc = 0x80002000;
const executedOne = 0x00020001;

async function instantiate(hex, hooks) {
  return WebAssembly.instantiate(Buffer.from(hex, "hex"), {
    lazuli: { memory: hooks.memory },
    lazuli_hooks: hooks.imports,
  });
}

async function loadWithZeroBase() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r0Offset, 0xf0000000, true);
  view.setUint32(cpu + r4Offset, 0xdeadbeef, true);
  view.setUint32(cpu + r5Offset, 0x00001800, true);
  view.setUint32(cpu + darOffset, 0xaabbccdd, true);
  view.setUint32(cpu + dsisrOffset, 0x11223344, true);
  const imports = {
    [`user_0_${loadReserveHook}`](hookContext, address, output) {
      events.push(["load", view.getUint32(hookContext + cycleOffset, true), address >>> 0]);
      view.setUint32(output, 0x12345678, true);
      return 1;
    },
    user_1_0() {
      throw new Error("zero-base lwarx raised an exception");
    },
  };
  const { instance } = await instantiate(loadZeroBaseHex, { memory, imports });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== executedOne) throw new Error(`zero-base lwarx returned 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc + 4) {
    throw new Error("zero-base lwarx did not complete");
  }
  if (view.getUint32(cpu + r4Offset, true) !== 0x12345678) {
    throw new Error("zero-base lwarx did not commit its loaded value");
  }
  if (view.getUint32(cpu + darOffset, true) !== 0xaabbccdd
      || view.getUint32(cpu + dsisrOffset, true) !== 0x11223344) {
    throw new Error("successful lwarx changed exception state");
  }
  const expected = [["load", 0, 0x1800]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`zero-base lwarx observed ${JSON.stringify(events)}`);
  }
}

async function loadFault() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r3Offset, 0x2000, true);
  view.setUint32(cpu + r4Offset, 0xdeadbeef, true);
  view.setUint32(cpu + r5Offset, 0x20, true);
  const imports = {
    [`user_0_${loadReserveHook}`](hookContext, address) {
      events.push(["load", view.getUint32(hookContext + cycleOffset, true), address >>> 0]);
      view.setUint32(cpu + dsisrOffset, 0x40000000, true);
      return 0;
    },
    user_1_0(registers, exception) {
      events.push([
        "exception",
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
        view.getUint32(registers + darOffset, true),
        view.getUint32(registers + dsisrOffset, true),
      ]);
    },
  };
  const { instance } = await instantiate(loadIndexedHex, { memory, imports });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== executedOne) throw new Error(`faulting lwarx returned 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc) {
    throw new Error("faulting lwarx advanced PC");
  }
  if (view.getUint32(cpu + r4Offset, true) !== 0xdeadbeef) {
    throw new Error("faulting lwarx changed its destination");
  }
  const expected = [
    ["load", 0, 0x2020],
    ["exception", 0, cpu, dsiException, 0x2020, 0x40000000],
  ];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`faulting lwarx observed ${JSON.stringify(events)}`);
  }
}

async function loadAlignment() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r3Offset, 0x3000, true);
  view.setUint32(cpu + r4Offset, 0xdeadbeef, true);
  view.setUint32(cpu + r5Offset, 2, true);
  const imports = {
    [`user_0_${loadReserveHook}`]() {
      throw new Error("misaligned lwarx reached translation/reservation");
    },
    user_1_0(registers, exception) {
      events.push([
        "exception",
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
        view.getUint32(registers + darOffset, true),
        view.getUint32(registers + dsisrOffset, true),
      ]);
    },
  };
  const { instance } = await instantiate(loadIndexedHex, { memory, imports });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== executedOne) throw new Error(`misaligned lwarx returned 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc) {
    throw new Error("misaligned lwarx advanced PC");
  }
  if (view.getUint32(cpu + r4Offset, true) !== 0xdeadbeef) {
    throw new Error("misaligned lwarx changed its destination");
  }
  const expected = [["exception", 0, cpu, alignmentException, 0x3006, 0x00000083]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`misaligned lwarx observed ${JSON.stringify(events)}`);
  }
}

async function completedStore(status, expectedCr) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + crOffset, 0xafffffff, true);
  view.setUint32(cpu + xerOffset, 0x80000000, true);
  view.setUint32(cpu + r6Offset, 0x12345678, true);
  view.setUint32(cpu + r7Offset, 0x4000, true);
  view.setUint32(cpu + r8Offset, 0x40, true);
  view.setUint32(cpu + darOffset, 0xaabbccdd, true);
  view.setUint32(cpu + dsisrOffset, 0x11223344, true);
  const imports = {
    [`user_0_${storeConditionalHook}`](hookContext, address, value) {
      events.push([
        "store",
        view.getUint32(hookContext + cycleOffset, true),
        address >>> 0,
        value >>> 0,
        status,
      ]);
      return status;
    },
    user_1_0() {
      throw new Error("completed stwcx. raised an exception");
    },
  };
  const { instance } = await instantiate(storeHex, { memory, imports });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== executedOne) throw new Error(`completed stwcx. returned 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc + 4) {
    throw new Error("completed stwcx. did not advance PC");
  }
  if (view.getUint32(cpu + crOffset, true) !== expectedCr) {
    throw new Error(`completed stwcx. produced CR 0x${view.getUint32(cpu + crOffset, true).toString(16)}`);
  }
  if (view.getUint32(cpu + darOffset, true) !== 0xaabbccdd
      || view.getUint32(cpu + dsisrOffset, true) !== 0x11223344) {
    throw new Error("completed stwcx. changed exception state");
  }
  const expected = [["store", 0, 0x4040, 0x12345678, status]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`completed stwcx. observed ${JSON.stringify(events)}`);
  }
}

async function storeFault() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + crOffset, 0xafffffff, true);
  view.setUint32(cpu + xerOffset, 0x80000000, true);
  view.setUint32(cpu + r6Offset, 0x12345678, true);
  view.setUint32(cpu + r7Offset, 0x5000, true);
  view.setUint32(cpu + r8Offset, 0x20, true);
  const imports = {
    [`user_0_${storeConditionalHook}`](hookContext, address, value) {
      events.push([
        "store",
        view.getUint32(hookContext + cycleOffset, true),
        address >>> 0,
        value >>> 0,
      ]);
      view.setUint32(cpu + dsisrOffset, 0x42000000, true);
      return 0;
    },
    user_1_0(registers, exception) {
      events.push([
        "exception",
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
        view.getUint32(registers + darOffset, true),
        view.getUint32(registers + dsisrOffset, true),
      ]);
    },
  };
  const { instance } = await instantiate(storeHex, { memory, imports });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== executedOne) throw new Error(`faulting stwcx. returned 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc) {
    throw new Error("faulting stwcx. advanced PC");
  }
  if (view.getUint32(cpu + crOffset, true) !== 0xafffffff) {
    throw new Error("faulting stwcx. changed CR0");
  }
  const expected = [
    ["store", 0, 0x5020, 0x12345678],
    ["exception", 0, cpu, dsiException, 0x5020, 0x42000000],
  ];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`faulting stwcx. observed ${JSON.stringify(events)}`);
  }
}

async function storeAlignment() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + crOffset, 0xafffffff, true);
  view.setUint32(cpu + xerOffset, 0x80000000, true);
  view.setUint32(cpu + r6Offset, 0x12345678, true);
  view.setUint32(cpu + r7Offset, 0x6000, true);
  view.setUint32(cpu + r8Offset, 2, true);
  const imports = {
    [`user_0_${storeConditionalHook}`]() {
      throw new Error("misaligned stwcx. reached translation/reservation");
    },
    user_1_0(registers, exception) {
      events.push([
        "exception",
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
        view.getUint32(registers + darOffset, true),
        view.getUint32(registers + dsisrOffset, true),
      ]);
    },
  };
  const { instance } = await instantiate(storeHex, { memory, imports });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== executedOne) throw new Error(`misaligned stwcx. returned 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc) {
    throw new Error("misaligned stwcx. advanced PC");
  }
  if (view.getUint32(cpu + crOffset, true) !== 0xafffffff) {
    throw new Error("misaligned stwcx. changed CR0");
  }
  const expected = [["exception", 0, cpu, alignmentException, 0x6006, 0x000108c7]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`misaligned stwcx. observed ${JSON.stringify(events)}`);
  }
}

await loadWithZeroBase();
await loadFault();
await loadAlignment();
await completedStore(2, 0x3fffffff);
await completedStore(1, 0x1fffffff);
await storeFault();
await storeAlignment();
"#;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &load_indexed,
            &load_zero_base,
            &store,
            &TEST_HOOK_CYCLE_OFFSET.to_string(),
            &Reg::PC.offset().to_string(),
            &Reg::CR.offset().to_string(),
            &GPR::R0.offset().to_string(),
            &GPR::R3.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &GPR::R5.offset().to_string(),
            &GPR::R6.offset().to_string(),
            &GPR::R7.offset().to_string(),
            &GPR::R8.offset().to_string(),
            &SPR::XER.offset().to_string(),
            &SPR::DAR.offset().to_string(),
            &SPR::DSISR.offset().to_string(),
            &(HookKind::LoadReserve as u32).to_string(),
            &(HookKind::StoreConditional as u32).to_string(),
            &(Exception::DSI as u16).to_string(),
            &(Exception::Alignment as u16).to_string(),
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
fn tlb_maintenance_is_an_exact_cycle_synchronous_barrier() {
    let prefix = instruction(0x3860_1000); // addi r3,r0,0x1000
    let invalidate = tlbie(4);
    let synchronize = tlbsync();
    let later_load = instruction(0x80a3_0000); // lwz r5,0(r3)
    let later_store = instruction(0x90a3_0004); // stw r5,4(r3)

    for (barrier, hook, expected_cycles) in [
        (invalidate, HookKind::Tlbie, 5),
        (synchronize, HookKind::Tlbsync, 4),
    ] {
        let fixture = [prefix, barrier, later_load, later_store];
        let portable = translate_with_cycle_publication(fixture);
        assert_eq!(portable.sequence.0, fixture[..2]);
        assert_eq!(portable.cycles, expected_cycles);
        assert_eq!(portable.exit, TranslationExit::Synchronous);
        assert_eq!(
            hook_call_cycles(&portable.function, TEST_HOOK_CYCLE_OFFSET),
            [(0, hook as u32, 2)]
        );
        assert_eq!(
            user_hook_call_count(&portable.function, HookKind::Tlbie),
            if hook == HookKind::Tlbie { 1 } else { 0 }
        );
        assert_eq!(
            user_hook_call_count(&portable.function, HookKind::Tlbsync),
            if hook == HookKind::Tlbsync { 1 } else { 0 }
        );

        let mut native = Translator::new(TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I64,
            CallConv::SystemV,
            ExitMode::Native,
        ));
        let native = native.translate(fixture.into_iter()).unwrap();
        assert_eq!(native.sequence.0, fixture[..2]);
        assert_eq!(native.cycles, expected_cycles);
        assert_eq!(native.exit, TranslationExit::Synchronous);
        assert_eq!(user_hook_call_count(&native.function, hook), 1);
    }

    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let invalidate =
        translate_with_cycle_publication([prefix, invalidate, later_load, later_store]);
    let synchronize =
        translate_with_cycle_publication([prefix, synchronize, later_load, later_store]);
    let invalidate = lower_portable(&invalidate.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let synchronize = lower_portable(&synchronize.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let script = r#"
const [
  invalidateHex,
  synchronizeHex,
  cycleOffset,
  pcOffset,
  r4Offset,
  r5Offset,
  tlbieHook,
  tlbsyncHook,
] = process.argv.slice(1).map((value, index) => index < 2 ? value : Number(value));

const initialPc = 0x80001000;
const rawRb = 0xa1234567;
const untouchedR5 = 0xdeadbeef;

async function execute(hex, expectedCycles, hookName, expectedAddress) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const context = 32;
  const cpu = 128;
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r4Offset, rawRb, true);
  view.setUint32(cpu + r5Offset, untouchedR5, true);

  const hooks = {
    [hookName](hookContext, address) {
      events.push([
        view.getUint32(hookContext + cycleOffset, true),
        view.getUint32(cpu + pcOffset, true),
        address === undefined ? null : address >>> 0,
      ]);
    },
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(hex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, 0x10000) >>> 0;
  if (executed !== ((expectedCycles << 16) | 2)) {
    throw new Error(`${hookName} returned 0x${executed.toString(16)}`);
  }
  if (view.getUint32(cpu + pcOffset, true) !== initialPc + 8) {
    throw new Error(`${hookName} did not advance PC through exactly the barrier`);
  }
  if (view.getUint32(cpu + r5Offset, true) !== untouchedR5) {
    throw new Error(`${hookName} executed the later load`);
  }
  const expectedEvents = [[2, initialPc + 4, expectedAddress]];
  if (JSON.stringify(events) !== JSON.stringify(expectedEvents)) {
    throw new Error(`${hookName} observed ${JSON.stringify(events)}`);
  }
}

await execute(invalidateHex, 5, `user_0_${tlbieHook}`, rawRb);
await execute(synchronizeHex, 4, `user_0_${tlbsyncHook}`, null);
"#;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &invalidate,
            &synchronize,
            &TEST_HOOK_CYCLE_OFFSET.to_string(),
            &Reg::PC.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &GPR::R5.offset().to_string(),
            &(HookKind::Tlbie as u32).to_string(),
            &(HookKind::Tlbsync as u32).to_string(),
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
fn every_portable_semantic_hook_is_immediately_cycle_stamped() {
    // addi r3,r0,0x1000; lwz r4,0(r3); addi r4,r4,1; stw r4,4(r3)
    let fixture = [
        instruction(0x3860_1000),
        instruction(0x8083_0000),
        instruction(0x3884_0001),
        instruction(0x9083_0004),
    ];
    let translated = translate_with_cycle_publication(fixture);
    assert_eq!(translated.cycles, 8);
    assert_eq!(
        hook_call_cycles(&translated.function, TEST_HOOK_CYCLE_OFFSET),
        [
            (0, HookKind::ReadI32 as u32, 2),
            (0, HookKind::WriteI32 as u32, 6),
            (1, 0, 2),
            (1, 0, 6),
        ]
    );

    let mut config = cycle_config(ExitMode::ReturnExecutedWithSlowMemory);
    config.settings.force_fpu = true;
    let quantized = Translator::new(config)
        .translate([psq(56, 2, 3, 0, true, 0), psq(60, 2, 3, 8, true, 0)].into_iter())
        .unwrap();
    assert_eq!(
        hook_call_cycles(&quantized.function, TEST_HOOK_CYCLE_OFFSET),
        [
            (0, HookKind::ReadQuant as u32, 0),
            (0, HookKind::WriteQuant as u32, 2),
            (1, 0, 0),
            (1, 0, 2),
        ]
    );

    let generic = translate_with_cycle_publication([mtspr(3, SPR::DEC as u16)]);
    assert_eq!(
        hook_call_cycles(&generic.function, TEST_HOOK_CYCLE_OFFSET),
        [(0, HookKind::DecChanged as u32, 0)]
    );

    // BAT hooks run at their originating instruction and stop the translated block.
    let barrier = translate_with_cycle_publication([
        instruction(0x3860_1000),
        mtspr(3, SPR::DBAT0U as u16),
        instruction(0x3884_0001),
    ]);
    assert_eq!(
        hook_call_cycles(&barrier.function, TEST_HOOK_CYCLE_OFFSET),
        [(0, HookKind::DBatChanged as u32, 2)]
    );
    assert_eq!(barrier.sequence.len(), 2);
    assert_eq!(barrier.cycles, 3);
    assert_eq!(barrier.exit, TranslationExit::Synchronous);

    // icbi r0,r3; isync; sc
    for (word, expected) in [
        (0x7c00_1fac, (0, HookKind::InvICache as u32, 0)),
        (0x4c00_012c, (0, HookKind::ClearICache as u32, 0)),
        (0x4400_0002, (1, 0, 0)),
    ] {
        let translated = translate_with_cycle_publication([instruction(word)]);
        assert_eq!(
            hook_call_cycles(&translated.function, TEST_HOOK_CYCLE_OFFSET),
            [expected]
        );
    }
}

#[test]
fn address_space_writes_are_exact_cycle_translation_barriers() {
    let prefix = instruction(0x3860_1000); // addi r3,r0,0x1000
    let later_load = instruction(0x8083_0000); // lwz r4,0(r3)
    let later_store = instruction(0x9083_0004); // stw r4,4(r3)

    for (barrier, hook, cycles) in [
        (mtmsr(3), HookKind::MsrChanged, 3),
        (mtspr(3, SPR::SDR1 as u16), HookKind::Sdr1Changed, 3),
        (mtsr(3, 7), HookKind::SrChanged, 4),
        (mtsrin(3, 4), HookKind::SrChanged, 4),
        (mtspr(3, SPR::DBAT0U as u16), HookKind::DBatChanged, 3),
        (mtspr(3, SPR::IBAT0L as u16), HookKind::IBatChanged, 3),
    ] {
        let fixture = [prefix, barrier, later_load, later_store];
        let portable = translate_with_cycle_publication(fixture);

        assert_eq!(portable.sequence.0, fixture[..2]);
        assert_eq!(portable.cycles, cycles);
        assert_eq!(portable.exit, TranslationExit::Synchronous);
        assert_eq!(
            hook_call_cycles(&portable.function, TEST_HOOK_CYCLE_OFFSET),
            [(0, hook as u32, 2)]
        );

        let mut native = Translator::new(TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I64,
            CallConv::SystemV,
            ExitMode::Native,
        ));
        let native = native.translate(fixture.into_iter()).unwrap();
        assert_eq!(native.sequence.0, fixture[..2]);
        assert_eq!(native.cycles, portable.cycles);
        assert_eq!(native.exit, TranslationExit::Synchronous);
        assert_eq!(user_hook_call_count(&native.function, hook), 1);
    }
}

#[test]
fn portable_address_space_barriers_return_the_exact_executed_boundary() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    let prefix = instruction(0x3860_1000); // addi r3,r0,0x1000
    let later_load = instruction(0x8083_0000); // lwz r4,0(r3)
    let later_store = instruction(0x9083_0004); // stw r4,4(r3)
    let barriers = [
        (mtmsr(3), HookKind::MsrChanged, Reg::MSR.offset(), 3),
        (
            mtspr(3, SPR::SDR1 as u16),
            HookKind::Sdr1Changed,
            SPR::SDR1.offset(),
            3,
        ),
        (mtsr(3, 7), HookKind::SrChanged, Reg::SR[7].offset(), 4),
        (mtsrin(3, 4), HookKind::SrChanged, Reg::SR[0].offset(), 4),
        (
            mtspr(3, SPR::DBAT0U as u16),
            HookKind::DBatChanged,
            SPR::DBAT0U.offset(),
            3,
        ),
        (
            mtspr(3, SPR::IBAT0L as u16),
            HookKind::IBatChanged,
            SPR::IBAT0L.offset(),
            3,
        ),
    ];
    let mut modules = Vec::new();
    for (barrier, _, _, expected_cycles) in barriers {
        let translated =
            translate_with_cycle_publication([prefix, barrier, later_load, later_store]);
        assert_eq!(translated.sequence.len(), 2);
        assert_eq!(translated.cycles, expected_cycles);
        assert_eq!(translated.exit, TranslationExit::Synchronous);
        modules.push(
            lower_portable(&translated.function)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        );
    }

    let script = r#"
const args = process.argv.slice(1);
const moduleCount = Number(args[0]);
const modules = args.slice(1, 1 + moduleCount);
const [cycleOffset, pcOffset, ...barrierData] = args.slice(1 + moduleCount).map(Number);

for (let index = 0; index < modules.length; index += 1) {
  const hookKind = barrierData[index * 3];
  const registerOffset = barrierData[index * 3 + 1];
  const cycles = barrierData[index * 3 + 2];
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const context = 32;
  const cpu = 128;
  const fastmem = 0x10000;
  const events = [];
  view.setUint32(cpu + pcOffset, 0x80001000, true);

  const hooks = {
    [`user_0_${hookKind}`](hookContext) {
      events.push([
        view.getUint32(hookContext + cycleOffset, true),
        view.getUint32(cpu + registerOffset, true),
      ]);
    },
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(modules[index], "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== ((cycles << 16) | 2)) {
    throw new Error(`barrier ${index} returned 0x${executed.toString(16)}`);
  }
  if (view.getUint32(cpu + pcOffset, true) !== 0x80001008) {
    throw new Error(`barrier ${index} did not stop PC after two instructions`);
  }
  if (JSON.stringify(events) !== JSON.stringify([[2, 0x1000]])) {
    throw new Error(`barrier ${index} observed ${JSON.stringify(events)}`);
  }
  if (view.getUint32(cpu + registerOffset, true) !== 0x1000) {
    throw new Error(`barrier ${index} lost its register write after returning`);
  }
  const cycleBytes = Array.from(new Uint8Array(memory.buffer, context + cycleOffset, 4));
  if (cycleBytes.join(",") !== "2,0,0,0") {
    throw new Error(`barrier ${index} cycle offset was not LE: ${cycleBytes}`);
  }
}
"#;
    let mut command = Command::new("node");
    command.args(["--input-type=module", "--eval", script]);
    command.arg(modules.len().to_string());
    command.args(&modules);
    command.args([
        TEST_HOOK_CYCLE_OFFSET.to_string(),
        Reg::PC.offset().to_string(),
    ]);
    for (_, hook, register_offset, cycles) in barriers {
        command.args([
            (hook as u32).to_string(),
            register_offset.to_string(),
            cycles.to_string(),
        ]);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "node failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn portable_indirect_segment_access_uses_the_effective_address_high_nibble() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    // mfsrin r5,r4; addi r6,r0,7
    let read = translate_with_cycle_publication([mfsrin(5, 4), instruction(0x38c0_0007)]);
    assert_eq!(read.sequence.len(), 2);
    assert_eq!(read.cycles, 4);
    assert_eq!(read.exit, TranslationExit::Fallthrough);
    assert_eq!(user_hook_call_count(&read.function, HookKind::SrChanged), 0);

    // mfsr r6,sr10; mtsrin r3,r4; addi r7,r0,9
    let write =
        translate_with_cycle_publication([mfsr(6, 10), mtsrin(3, 4), instruction(0x38e0_0009)]);
    assert_eq!(write.sequence.len(), 2);
    assert_eq!(write.cycles, 4);
    assert_eq!(write.exit, TranslationExit::Synchronous);
    assert_eq!(
        hook_call_cycles(&write.function, TEST_HOOK_CYCLE_OFFSET),
        [(0, HookKind::SrChanged as u32, 2)]
    );

    let read = lower_portable(&read.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let write = lower_portable(&write.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let script = r#"
const [
  readHex,
  writeHex,
  cycleOffset,
  pcOffset,
  r3Offset,
  r4Offset,
  r5Offset,
  r6Offset,
  r7Offset,
  sr0Offset,
  sr5Offset,
  sr10Offset,
  srChangedHook,
] = process.argv.slice(1).map((value, index) => index < 2 ? value : Number(value));

const initialPc = 0x80001000;
const indirectAddress = 0xa0000005;
const oldSr10 = 0x11223344;
const oldSr5 = 0x55667788;
const oldSr0 = 0x99aabbcc;

async function executeRead() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const cpu = 128;
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r4Offset, indirectAddress, true);
  view.setUint32(cpu + sr10Offset, oldSr10, true);
  view.setUint32(cpu + sr5Offset, oldSr5, true);
  view.setUint32(cpu + sr0Offset, oldSr0, true);
  const { instance } = await WebAssembly.instantiate(Buffer.from(readHex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: new Proxy({}, {
      get(_target, name) {
        return () => { throw new Error(`mfsrin invoked unexpected hook ${String(name)}`); };
      },
    }),
  });
  const executed = instance.exports.run(32, cpu, 0x10000) >>> 0;
  if (executed !== 0x00040002) throw new Error(`bad mfsrin execution: 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc + 8) throw new Error("mfsrin did not continue");
  if (view.getUint32(cpu + r5Offset, true) !== oldSr10) throw new Error("mfsrin did not select SR10");
  if (view.getUint32(cpu + r6Offset, true) !== 7) throw new Error("instruction after mfsrin did not run");
}

async function executeWrite() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const context = 32;
  const cpu = 128;
  const newSr10 = 0xcafebabe;
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r3Offset, newSr10, true);
  view.setUint32(cpu + r4Offset, indirectAddress, true);
  view.setUint32(cpu + r7Offset, 0xdeadbeef, true);
  view.setUint32(cpu + sr10Offset, oldSr10, true);
  view.setUint32(cpu + sr5Offset, oldSr5, true);
  view.setUint32(cpu + sr0Offset, oldSr0, true);
  const hooks = {
    [`user_0_${srChangedHook}`](hookContext) {
      events.push([
        view.getUint32(hookContext + cycleOffset, true),
        view.getUint32(cpu + sr10Offset, true),
        view.getUint32(cpu + sr5Offset, true),
        view.getUint32(cpu + sr0Offset, true),
      ]);
    },
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(writeHex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, 0x10000) >>> 0;
  if (executed !== 0x00040002) throw new Error(`bad mtsrin execution: 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== initialPc + 8) throw new Error("mtsrin advanced PC incorrectly");
  if (view.getUint32(cpu + r6Offset, true) !== oldSr10) throw new Error("mfsr setup read the wrong SR");
  if (view.getUint32(cpu + r7Offset, true) !== 0xdeadbeef) throw new Error("instruction after mtsrin ran");
  if (view.getUint32(cpu + sr10Offset, true) !== newSr10) throw new Error("mtsrin write was lost");
  if (view.getUint32(cpu + sr5Offset, true) !== oldSr5) throw new Error("mtsrin used the low nibble");
  if (view.getUint32(cpu + sr0Offset, true) !== oldSr0) throw new Error("mtsrin aliased SR0");
  const expected = [[2, newSr10, oldSr5, oldSr0]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`SrChanged observed ${JSON.stringify(events)}`);
  }
}

await executeRead();
await executeWrite();
"#;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &read,
            &write,
            &TEST_HOOK_CYCLE_OFFSET.to_string(),
            &Reg::PC.offset().to_string(),
            &GPR::R3.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &GPR::R5.offset().to_string(),
            &GPR::R6.offset().to_string(),
            &GPR::R7.offset().to_string(),
            &Reg::SR[0].offset().to_string(),
            &Reg::SR[5].offset().to_string(),
            &Reg::SR[10].offset().to_string(),
            &(HookKind::SrChanged as u32).to_string(),
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
fn portable_hooks_observe_exact_instruction_start_cycles_and_dsi_state() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    // addi r5,r0,0x1234; mtspr DSISR,r5; addi r3,r0,0x1000; lwz r4,0(r3);
    // addi r4,r4,1; stw r4,4(r3)
    let fixture = [
        instruction(0x38a0_1234),
        mtspr(5, SPR::DSISR as u16),
        instruction(0x3860_1000),
        instruction(0x8083_0000),
        instruction(0x3884_0001),
        instruction(0x9083_0004),
    ];
    let success = translate_with_cycle_publication(fixture);
    let failure = translate_with_cycle_publication(fixture[..4].iter().copied());
    assert_eq!(success.cycles, 11);
    assert_eq!(failure.cycles, 7);

    let success = lower_portable(&success.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let failure = lower_portable(&failure.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let script = r#"
const [
  successHex,
  failureHex,
  cycleOffset,
  pcOffset,
  r4Offset,
  darOffset,
  dsisrOffset,
  readI32Hook,
  writeI32Hook,
  dsiException,
] = process.argv.slice(1).map((value, index) => index < 2 ? value : Number(value));

async function executeSuccess() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const context = 32;
  const cpu = 128;
  const fastmem = 0x10000;
  const events = [];
  view.setUint32(cpu + pcOffset, 0x80001000, true);
  const hooks = {
    [`user_0_${readI32Hook}`](hookContext, address, output) {
      events.push(["read", view.getUint32(hookContext + cycleOffset, true), address >>> 0]);
      view.setUint32(output, 0x11223344, true);
      return 1;
    },
    [`user_0_${writeI32Hook}`](hookContext, address, value) {
      events.push([
        "write",
        view.getUint32(hookContext + cycleOffset, true),
        address >>> 0,
        value >>> 0,
      ]);
      return 1;
    },
    user_1_0() {
      throw new Error("unexpected exception on successful slow-memory hooks");
    },
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(successHex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== 0x000b0006) throw new Error(`bad success execution: 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== 0x80001018) throw new Error("bad success PC");
  if (view.getUint32(cpu + r4Offset, true) !== 0x11223345) throw new Error("bad success r4");
  const expected = [["read", 5, 0x1000], ["write", 9, 0x1004, 0x11223345]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`bad success hook events: ${JSON.stringify(events)}`);
  }
  const cycleBytes = Array.from(new Uint8Array(memory.buffer, context + cycleOffset, 4));
  if (cycleBytes.join(",") !== "9,0,0,0") throw new Error(`cycle offset was not LE: ${cycleBytes}`);
}

async function executeFailure() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const context = 32;
  const cpu = 128;
  const fastmem = 0x10000;
  const events = [];
  view.setUint32(cpu + pcOffset, 0x80001000, true);
  const hooks = {
    [`user_0_${readI32Hook}`](hookContext, address) {
      events.push(["read", view.getUint32(hookContext + cycleOffset, true), address >>> 0]);
      view.setUint32(cpu + dsisrOffset, 0x4a01beef, true);
      return 0;
    },
    user_1_0(registers, exception) {
      events.push([
        "exception",
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
        view.getUint32(registers + dsisrOffset, true),
      ]);
    },
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(failureHex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== 0x00070004) throw new Error(`bad DSI execution: 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + darOffset, true) !== 0x1000) throw new Error("bad DSI DAR");
  if (view.getUint32(cpu + dsisrOffset, true) !== 0x4a01beef) {
    throw new Error("DSI hook syndrome was overwritten by the exception flush");
  }
  const expected = [
    ["read", 5, 0x1000],
    ["exception", 5, cpu, dsiException, 0x4a01beef],
  ];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`bad DSI hook events: ${JSON.stringify(events)}`);
  }
  const cycleBytes = Array.from(new Uint8Array(memory.buffer, context + cycleOffset, 4));
  if (cycleBytes.join(",") !== "5,0,0,0") throw new Error(`DSI cycle offset was not LE: ${cycleBytes}`);
}

await executeSuccess();
await executeFailure();
"#;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &success,
            &failure,
            &TEST_HOOK_CYCLE_OFFSET.to_string(),
            &Reg::PC.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &SPR::DAR.offset().to_string(),
            &SPR::DSISR.offset().to_string(),
            &(HookKind::ReadI32 as u32).to_string(),
            &(HookKind::WriteI32 as u32).to_string(),
            &(Exception::DSI as u16).to_string(),
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
fn portable_failed_store_update_preserves_base_register_at_fault_boundary() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    // stwu r4,4(r3); addi r5,r0,0x1234
    let immediate = translate_with_cycle_publication([stwu(4, 3, 4), instruction(0x38a0_1234)]);
    // stwux r4,r3,r6; addi r5,r0,0x1234
    let indexed = translate_with_cycle_publication([stwux(4, 3, 6), instruction(0x38a0_1234)]);
    assert_eq!(immediate.cycles, 4);
    assert_eq!(indexed.cycles, 4);

    let immediate = lower_portable(&immediate.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let indexed = lower_portable(&indexed.function)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let script = r#"
const [
  immediateHex,
  indexedHex,
  cycleOffset,
  pcOffset,
  r3Offset,
  r4Offset,
  r5Offset,
  r6Offset,
  darOffset,
  writeI32Hook,
  dsiException,
] = process.argv.slice(1).map((value, index) => index < 2 ? value : Number(value));

async function execute(hex, initialRa, rb, expectedAddress, label) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const view = new DataView(memory.buffer);
  const context = 32;
  const cpu = 128;
  const fastmem = 0x10000;
  const initialPc = 0x80002000;
  const storedValue = 0x11223344;
  const untouched = 0xdeadbeef;
  const events = [];
  view.setUint32(cpu + pcOffset, initialPc, true);
  view.setUint32(cpu + r3Offset, initialRa, true);
  view.setUint32(cpu + r4Offset, storedValue, true);
  view.setUint32(cpu + r5Offset, untouched, true);
  view.setUint32(cpu + r6Offset, rb, true);
  const hooks = {
    [`user_0_${writeI32Hook}`](hookContext, address, value) {
      events.push([
        "write",
        view.getUint32(hookContext + cycleOffset, true),
        address >>> 0,
        value >>> 0,
      ]);
      return 0;
    },
    user_1_0(registers, exception) {
      events.push([
        "exception",
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
        view.getUint32(registers + r3Offset, true),
        view.getUint32(registers + darOffset, true),
      ]);
    },
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(hex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== 0x00020001) {
    throw new Error(`${label} returned past the fault boundary: 0x${executed.toString(16)}`);
  }
  if (view.getUint32(cpu + pcOffset, true) !== initialPc) {
    throw new Error(`${label} advanced PC across the failed store`);
  }
  if (view.getUint32(cpu + r3Offset, true) !== initialRa) {
    throw new Error(`${label} committed RA before the store succeeded`);
  }
  if (view.getUint32(cpu + r5Offset, true) !== untouched) {
    throw new Error(`${label} executed the instruction after the failed store`);
  }
  if (view.getUint32(cpu + darOffset, true) !== expectedAddress) {
    throw new Error(`${label} recorded the wrong DAR`);
  }
  const expected = [
    ["write", 0, expectedAddress, storedValue],
    ["exception", 0, cpu, dsiException, initialRa, expectedAddress],
  ];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`${label} observed ${JSON.stringify(events)}`);
  }
  const cycleBytes = Array.from(new Uint8Array(memory.buffer, context + cycleOffset, 4));
  if (cycleBytes.join(",") !== "0,0,0,0") {
    throw new Error(`${label} fault cycle offset was not exact LE zero: ${cycleBytes}`);
  }
}

await execute(immediateHex, 0x2000, 0, 0x2004, "stwu");
await execute(indexedHex, 0x3000, 0x20, 0x3020, "stwux");
"#;
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &immediate,
            &indexed,
            &TEST_HOOK_CYCLE_OFFSET.to_string(),
            &Reg::PC.offset().to_string(),
            &GPR::R3.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &GPR::R5.offset().to_string(),
            &GPR::R6.offset().to_string(),
            &SPR::DAR.offset().to_string(),
            &(HookKind::WriteI32 as u32).to_string(),
            &(Exception::DSI as u16).to_string(),
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
