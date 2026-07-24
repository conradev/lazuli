use std::process::Command;

use clifwasm::ModuleConfig;
use cranelift_codegen::ir::{self, Endianness, ExternalName, InstructionData, Opcode};
use cranelift_codegen::isa::CallConv;
use cranelift_codegen::{settings, verify_function};
use gekko::disasm::{Extensions, Ins};
use gekko::{Exception, GPR, Reg, SPR};

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

fn psq(opcode: u32, fr: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> Ins {
    let word = opcode << 26
        | u32::from(fr) << 21
        | u32::from(ra) << 16
        | u32::from(w) << 15
        | u32::from(gqr & 7) << 12
        | u32::from(displacement as u16 & 0x0fff);
    instruction(word)
}

fn mtspr(rs: u8, spr: u16) -> Ins {
    let encoded_spr = (u32::from(spr) & 0x1f) << 16 | (u32::from(spr) >> 5) << 11;
    instruction(31 << 26 | u32::from(rs) << 21 | encoded_spr | 467 << 1)
}

fn lower_portable(function: &ir::Function) -> Vec<u8> {
    clifwasm::function(
        function,
        &ModuleConfig::new("lazuli", "memory", "run")
            .with_function_import_module("lazuli_hooks")
            .with_stack_scratch(0, 32, 8),
    )
    .unwrap()
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

    // Deferred BAT hooks retain the most recent originating instruction's start cycle.
    let deferred = translate_with_cycle_publication([
        instruction(0x3860_1000),
        mtspr(3, SPR::DBAT0U as u16),
        instruction(0x3884_0001),
    ]);
    assert_eq!(
        hook_call_cycles(&deferred.function, TEST_HOOK_CYCLE_OFFSET),
        [(0, HookKind::DBatChanged as u32, 2)]
    );

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
fn portable_hooks_observe_exact_instruction_start_cycles_and_dsi_state() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
        return;
    }

    // addi r3,r0,0x1000; lwz r4,0(r3); addi r4,r4,1; stw r4,4(r3)
    let fixture = [
        instruction(0x3860_1000),
        instruction(0x8083_0000),
        instruction(0x3884_0001),
        instruction(0x9083_0004),
    ];
    let success = translate_with_cycle_publication(fixture);
    let failure = translate_with_cycle_publication(fixture[..2].iter().copied());
    assert_eq!(success.cycles, 8);
    assert_eq!(failure.cycles, 4);

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
  if (executed !== 0x00080004) throw new Error(`bad success execution: 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + pcOffset, true) !== 0x80001010) throw new Error("bad success PC");
  if (view.getUint32(cpu + r4Offset, true) !== 0x11223345) throw new Error("bad success r4");
  const expected = [["read", 2, 0x1000], ["write", 6, 0x1004, 0x11223345]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`bad success hook events: ${JSON.stringify(events)}`);
  }
  const cycleBytes = Array.from(new Uint8Array(memory.buffer, context + cycleOffset, 4));
  if (cycleBytes.join(",") !== "6,0,0,0") throw new Error(`cycle offset was not LE: ${cycleBytes}`);
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
      return 0;
    },
    user_1_0(registers, exception) {
      events.push([
        "exception",
        view.getUint32(context + cycleOffset, true),
        registers,
        exception,
      ]);
    },
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(failureHex, "hex"), {
    lazuli: { memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(context, cpu, fastmem) >>> 0;
  if (executed !== 0x00040002) throw new Error(`bad DSI execution: 0x${executed.toString(16)}`);
  if (view.getUint32(cpu + darOffset, true) !== 0x1000) throw new Error("bad DSI DAR");
  const expected = [["read", 2, 0x1000], ["exception", 2, cpu, dsiException]];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`bad DSI hook events: ${JSON.stringify(events)}`);
  }
  const cycleBytes = Array.from(new Uint8Array(memory.buffer, context + cycleOffset, 4));
  if (cycleBytes.join(",") !== "2,0,0,0") throw new Error(`DSI cycle offset was not LE: ${cycleBytes}`);
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
