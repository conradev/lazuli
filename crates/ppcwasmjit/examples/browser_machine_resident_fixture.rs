//! Generates the deterministic assets used by the Rust browser-machine resident-loop contract.

use std::path::PathBuf;
use std::{env, fs};

use gekko::disasm::{Extensions, Ins};
use gekko::{GPR, MachineState, Reg, SPR};
use lazuli_abi::{ResidentBlockInstallIdentity, ResidentInstallStatus};
use ppcwasmjit::{
    DispatchReason, DispatcherConfig, DispatcherDependency, DispatcherEntry,
    DispatcherSlotIdentity, Jit, RegionBlock, build_resident_dispatcher, link_region,
};
use wasm_encoder::{
    BlockType, CodeSection, ExportKind, ExportSection, Function, FunctionSection, Instruction,
    Module, TypeSection, ValType,
};

const GENERATION: u64 = 1;
const SLOT_NONCE_A: u64 = 0xa11c_e001;
const SLOT_NONCE_B: u64 = 0xb10c_e002;
const INSTALL_TOKEN_A: u64 = 0x91a1_1000_0000_0001;
const INSTALL_TOKEN_B: u64 = 0x91b2_2000_0000_0002;
const BLOCK_COUNT: u32 = 257;
const INITIAL_PC: u32 = 0xfff0_0100;
const DEVICE_TEST_PC: u32 = 0x8000_1000;
// Outside the default 0x8/0xc data BATs so the resident slow hook must walk the hashed table.
const HASHED_EFFECTIVE: u32 = 0x4000_1000;
const HASHED_SEGMENT: u32 = 0x0000_0042;
const HASHED_PHYSICAL: u32 = 0x0000_5000;
const SI_COMM_CONTROL: u32 = 0x0c00_6434;

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

fn stw(rs: u8, ra: u8, displacement: i16) -> Ins {
    d_form(36, rs, ra, displacement)
}

fn branch(displacement: i32) -> Ins {
    instruction(18 << 26 | (displacement as u32 & 0x03ff_fffc))
}

fn page_table_vector(effective: u32, segment: u32, sdr1: u32) -> (u32, u32) {
    let vsid = segment & 0x00ff_ffff;
    let page_index = (effective >> 12) & 0xffff;
    let api = (effective >> 22) & 0x3f;
    let primary_hash = ((vsid & 0x7ffff) ^ page_index) & 0x7ffff;
    let table_base = sdr1 & 0xffff_0000;
    let table_mask = 0x3ff | ((sdr1 & 0x1ff) << 10);
    let primary_pteg = table_base | ((primary_hash & table_mask) << 6);
    let primary_pte0 = 0x8000_0000 | (vsid << 7) | api;
    (primary_pteg, primary_pte0)
}

fn output_directory() -> PathBuf {
    let path = env::args_os()
        .nth(1)
        .unwrap_or_else(|| panic!("usage: browser_machine_resident_fixture <output-directory>"));
    PathBuf::from(path)
}

fn install_identity(
    request_id: u32,
    table_slot: u32,
    slot_nonce: u64,
    install_token: u64,
) -> ResidentBlockInstallIdentity {
    ResidentBlockInstallIdentity {
        request_id,
        table_slot,
        slot_nonce_lo: slot_nonce as u32,
        slot_nonce_hi: (slot_nonce >> 32) as u32,
        address_space_generation_lo: GENERATION as u32,
        address_space_generation_hi: (GENERATION >> 32) as u32,
        install_token_lo: install_token as u32,
        install_token_hi: (install_token >> 32) as u32,
    }
}

fn emit_identity_match(body: &mut Function, identity: ResidentBlockInstallIdentity) {
    let words = [
        identity.request_id,
        identity.table_slot,
        identity.slot_nonce_lo,
        identity.slot_nonce_hi,
        identity.address_space_generation_lo,
        identity.address_space_generation_hi,
        identity.install_token_lo,
        identity.install_token_hi,
    ];
    for (index, word) in words.into_iter().enumerate() {
        body.instruction(&Instruction::LocalGet(index as u32));
        body.instruction(&Instruction::I32Const(word as i32));
        body.instruction(&Instruction::I32Eq);
        if index != 0 {
            body.instruction(&Instruction::I32And);
        }
    }
}

/// Rust-authored fixture authority. Production blocks bind these imports to browser-machine.
fn fixture_install_authority(
    first: ResidentBlockInstallIdentity,
    second: ResidentBlockInstallIdentity,
) -> Vec<u8> {
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32; 8], [ValType::I32]);
    let mut functions = FunctionSection::new();
    functions.function(0);
    functions.function(0);
    let mut exports = ExportSection::new();
    exports.export(
        ppcwasmjit::RESIDENT_INSTALL_BEGIN_IMPORT,
        ExportKind::Func,
        0,
    );
    exports.export(
        ppcwasmjit::RESIDENT_INSTALL_COMMIT_IMPORT,
        ExportKind::Func,
        1,
    );
    let mut code = CodeSection::new();
    for success in [
        ResidentInstallStatus::Authorized,
        ResidentInstallStatus::Committed,
    ] {
        let mut body = Function::new([]);
        emit_identity_match(&mut body, first);
        emit_identity_match(&mut body, second);
        body.instruction(&Instruction::I32Or);
        body.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
        body.instruction(&Instruction::I32Const(success as i32));
        body.instruction(&Instruction::Else);
        body.instruction(&Instruction::I32Const(
            ResidentInstallStatus::IdentityMismatch as i32,
        ));
        body.instruction(&Instruction::End);
        body.instruction(&Instruction::End);
        code.function(&body);
    }
    let mut module = Module::new();
    module.section(&types);
    module.section(&functions);
    module.section(&exports);
    module.section(&code);
    module.finish()
}

fn main() {
    let output = output_directory();
    fs::create_dir_all(&output).expect("failed to create resident fixture directory");

    // IPL reset PC: r3 += 1; branch to the adjacent block at PC + 8.
    let identity_a = install_identity(1, 0, SLOT_NONCE_A, INSTALL_TOKEN_A);
    let identity_b = install_identity(2, 1, SLOT_NONCE_B, INSTALL_TOKEN_B);
    let mut jit = Jit::new_resident();
    let block_a = jit
        .build_resident_installable(
            [instruction(0x3863_0001), instruction(0x4800_0004)],
            identity_a,
        )
        .expect("failed to lower resident block A");
    // Adjacent PC: r4 += 1; branch back to the IPL reset PC.
    let block_b = jit
        .build_resident_installable(
            [instruction(0x3884_0001), instruction(0x4bff_fff4)],
            identity_b,
        )
        .expect("failed to lower resident block B");

    let entries = [
        DispatcherEntry {
            pc: INITIAL_PC,
            address_space_generation: GENERATION,
            table_slot: 0,
            slot_nonce: SLOT_NONCE_A,
            maximum_executed: block_a.metadata().executed.pack(),
            dependency_count: 0,
            dependencies: [DispatcherDependency::default(); 2],
        },
        DispatcherEntry {
            pc: INITIAL_PC + 8,
            address_space_generation: GENERATION,
            table_slot: 1,
            slot_nonce: SLOT_NONCE_B,
            maximum_executed: block_b.metadata().executed.pack(),
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
    let mut config = DispatcherConfig::production();
    config.table_minimum = 2;
    config.initial_entries = entries.into();
    config.initial_slot_identities = identities.into();
    let dispatcher =
        build_resident_dispatcher(&config).expect("failed to build resident dispatcher");

    fs::write(output.join("dispatcher.wasm"), dispatcher).expect("failed to write dispatcher");
    fs::write(output.join("block-a.wasm"), block_a.wasm()).expect("failed to write block A");
    fs::write(output.join("block-b.wasm"), block_b.wasm()).expect("failed to write block B");
    fs::write(
        output.join("install-authority.wasm"),
        fixture_install_authority(identity_a, identity_b),
    )
    .expect("failed to write Rust install authority");

    // Two real slow-memory resident blocks used with the actual browser-machine hooks. Block A
    // stores through Rust's MMU/MMIO path; block B is an unmistakable next-block marker.
    let device_block_a = Jit::with_slow_memory_resident()
        .build([stw(4, 3, 0), branch(4)])
        .expect("failed to lower resident device block A");
    let device_block_b = Jit::with_slow_memory_resident()
        .build([instruction(0x38a5_0001), branch(-12)])
        .expect("failed to lower resident device block B");
    let device_region = link_region(&[
        RegionBlock {
            pc: DEVICE_TEST_PC,
            maximum_cycles: device_block_a.metadata().executed.cycles,
        },
        RegionBlock {
            pc: DEVICE_TEST_PC + 8,
            maximum_cycles: device_block_b.metadata().executed.cycles,
        },
    ])
    .expect("failed to link resident device region");
    fs::write(output.join("device-block-a.wasm"), device_block_a.wasm())
        .expect("failed to write resident device block A");
    fs::write(output.join("device-block-b.wasm"), device_block_b.wasm())
        .expect("failed to write resident device block B");
    fs::write(output.join("device-region.wasm"), device_region)
        .expect("failed to write resident device region");

    let mut translated_msr = MachineState::default();
    translated_msr.set_data_addr_translation(true);
    let (primary_pteg, primary_pte0) = page_table_vector(HASHED_EFFECTIVE, HASHED_SEGMENT, 0);

    let block_a_count = BLOCK_COUNT.div_ceil(2);
    let block_b_count = BLOCK_COUNT / 2;
    let expected_instructions = u64::from(block_a_count)
        * u64::from(block_a.metadata().executed.instructions)
        + u64::from(block_b_count) * u64::from(block_b.metadata().executed.instructions);
    let expected_cycles = u64::from(block_a_count) * u64::from(block_a.metadata().executed.cycles)
        + u64::from(block_b_count) * u64::from(block_b.metadata().executed.cycles);
    let manifest = format!(
        concat!(
            "{{\n",
            "  \"pcOffset\": {},\n",
            "  \"r3Offset\": {},\n",
            "  \"r4Offset\": {},\n",
            "  \"r5Offset\": {},\n",
            "  \"generation\": {},\n",
            "  \"initialPc\": {},\n",
            "  \"blockCount\": {},\n",
            "  \"expectedInstructions\": {},\n",
            "  \"expectedCycles\": {},\n",
            "  \"expectedR3\": {},\n",
            "  \"expectedR4\": {},\n",
            "  \"expectedPc\": {},\n",
            "  \"expectedReason\": {},\n",
            "  \"msrOffset\": {},\n",
            "  \"srOffset\": {},\n",
            "  \"sdr1Offset\": {},\n",
            "  \"translatedMsr\": {},\n",
            "  \"deviceTestPc\": {},\n",
            "  \"hashedEffective\": {},\n",
            "  \"hashedPhysical\": {},\n",
            "  \"hashedSegment\": {},\n",
            "  \"primaryPteg\": {},\n",
            "  \"primaryPte0\": {},\n",
            "  \"primaryPte1\": {},\n",
            "  \"siCommControl\": {},\n",
            "  \"deviceBlockAInstructions\": {},\n",
            "  \"deviceBlockACycles\": {},\n",
            "  \"deviceBlockBInstructions\": {},\n",
            "  \"deviceBlockBCycles\": {}\n",
            "}}\n"
        ),
        Reg::PC.offset(),
        GPR::R3.offset(),
        GPR::R4.offset(),
        GPR::R5.offset(),
        GENERATION,
        INITIAL_PC,
        BLOCK_COUNT,
        expected_instructions,
        expected_cycles,
        block_a_count,
        block_b_count,
        INITIAL_PC + 8,
        DispatchReason::BlockBudgetExhausted as u32,
        Reg::MSR.offset(),
        Reg::SR4.offset(),
        Reg::SPR(SPR::SDR1).offset(),
        translated_msr.to_bits(),
        DEVICE_TEST_PC,
        HASHED_EFFECTIVE,
        HASHED_PHYSICAL,
        HASHED_SEGMENT,
        primary_pteg,
        primary_pte0,
        HASHED_PHYSICAL | 2,
        SI_COMM_CONTROL,
        device_block_a.metadata().executed.instructions,
        device_block_a.metadata().executed.cycles,
        device_block_b.metadata().executed.instructions,
        device_block_b.metadata().executed.cycles,
    );
    fs::write(output.join("fixture.json"), manifest).expect("failed to write fixture manifest");
}
