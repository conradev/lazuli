use cranelift_codegen::ir::{self, InstructionData, Opcode};
use cranelift_codegen::isa::CallConv;
use cranelift_codegen::{settings, verify_function};
use gekko::disasm::{Extensions, Ins};

use crate::{CodegenSettings, ExitMode, TranslationConfig, TranslationExit, Translator};

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
