use std::{env, fs};

use cranelift_codegen::ir;
use cranelift_codegen::isa::CallConv;
use gekko::disasm::{Extensions, Ins};
use ppcjit::{CodegenSettings, ExitMode, TranslationConfig, Translator};

fn read_be_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn main() {
    let mut args = env::args().skip(1);
    let path = args
        .next()
        .expect("usage: dump_clif <boot.dol> <pc> [count] [--disasm-only]");
    let pc = u32::from_str_radix(
        args.next()
            .expect("usage: dump_clif <boot.dol> <pc> [count] [--disasm-only]")
            .trim_start_matches("0x"),
        16,
    )
    .expect("invalid PC");
    let trailing: Vec<_> = args.collect();
    let count = trailing
        .iter()
        .find(|argument| !argument.starts_with("--"))
        .map_or(Ok(16), |argument| argument.parse::<usize>())
        .expect("invalid instruction count");
    let disasm_only = trailing.iter().any(|argument| argument == "--disasm-only");
    let dol = fs::read(path).expect("failed to read DOL");

    let mut file_offset = None;
    for index in 0..18 {
        let offset = read_be_u32(&dol, index * 4);
        let target = read_be_u32(&dol, 0x48 + index * 4);
        let size = read_be_u32(&dol, 0x90 + index * 4);
        if pc >= target && pc < target.saturating_add(size) {
            file_offset = Some(offset as usize + (pc - target) as usize);
            break;
        }
    }
    let file_offset = file_offset.expect("PC is not in a DOL section");
    let translation_count = count.max(64);
    let instructions: Vec<_> = (0..translation_count)
        .map(|index| {
            let offset = file_offset + index * 4;
            Ins::new(read_be_u32(&dol, offset), Extensions::gekko_broadway())
        })
        .collect();
    for (index, instruction) in instructions.iter().take(count).enumerate() {
        println!(
            "{:#010x}: {:#010x}  {}",
            pc + (index as u32 * 4),
            instruction.code,
            instruction.simplified(),
        );
    }
    println!();
    if disasm_only {
        return;
    }

    let mut translator = Translator::new(TranslationConfig::new(
        CodegenSettings::default(),
        ir::types::I32,
        CallConv::Fast,
        ExitMode::ReturnExecuted,
    ));
    let translated = translator
        .translate(instructions.into_iter())
        .expect("translation failed");
    println!("{}", translated.function.display());
}
