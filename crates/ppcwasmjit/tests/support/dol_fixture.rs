//! Deterministic, self-checking DOL used by the browser-JIT end-to-end test.
#![allow(dead_code)]
//!
//! The fixture executes 206 guest instructions. It combines a 32-iteration CTR loop with taken
//! and untaken branches, a linked call and `blr`, a conventional stack frame, and byte,
//! halfword, and word guest-memory operations. The continuation publishes four result words:
//!
//! ```text
//! result[0] = 32           // loop accumulator
//! result[1] = 31           // final byte loaded back from the stack
//! result[2] = 32           // final halfword loaded back from the stack
//! result[3] = 0x8000_3000  // restored stack pointer
//! ```

pub const HEADER_SIZE: usize = 0x100;

pub const ENTRY_POINT: u32 = 0x8000_1000;
pub const CONTINUATION_PC: u32 = ENTRY_POINT + 6 * 4;
pub const HALT_PC: u32 = ENTRY_POINT + 11 * 4;
pub const WORKER_PC: u32 = ENTRY_POINT + 16 * 4;
pub const LOOP_PC: u32 = WORKER_PC + 4;
pub const INPUT_ADDRESS: u32 = 0x8000_2000;
pub const RESULT_ADDRESS: u32 = 0x8000_2010;
pub const INITIAL_STACK_POINTER: u32 = 0x8000_3000;
pub const STACK_FRAME_ADDRESS: u32 = INITIAL_STACK_POINTER - 16;
pub const LOOP_COUNT: u16 = 32;
pub const EXPECTED_INSTRUCTIONS: u16 = 206;

/// Physical RAM offsets selected by Lazuli's default Dolphin OS BAT mapping.
pub const PHYSICAL_TEXT_OFFSET: usize = 0x1000;
pub const PHYSICAL_INPUT_OFFSET: usize = 0x2000;
pub const PHYSICAL_RESULT_OFFSET: usize = 0x2010;
pub const PHYSICAL_STACK_FRAME_OFFSET: usize = 0x2ff0;

pub const RESULT_WORDS: [u32; 4] = [
    LOOP_COUNT as u32,
    LOOP_COUNT as u32 - 1,
    LOOP_COUNT as u32,
    INITIAL_STACK_POINTER,
];

pub const PROGRAM: [u32; 25] = [
    0x3c60_8000, // lis   r3, 0x8000
    0x3823_3000, // addi  r1, r3, 0x3000
    0xa0a3_2000, // lhz   r5, 0x2000(r3)
    0x7ca9_03a6, // mtctr r5
    0x3880_0000, // li    r4, 0
    0x4800_002d, // bl    0x8000_1040
    0x9083_2010, // stw   r4, 0x2010(r3)
    0x90c3_2014, // stw   r6, 0x2014(r3)
    0x90e3_2018, // stw   r7, 0x2018(r3)
    0x9023_201c, // stw   r1, 0x201c(r3)
    0x4800_0004, // b     0x8000_102c
    0x4800_0000, // b     . (stable completion PC)
    0x6000_0000, // padding
    0x6000_0000, // padding
    0x6000_0000, // padding
    0x6000_0000, // padding
    0x9421_fff0, // stwu  r1, -16(r1)
    0x9881_0004, // stb   r4, 4(r1)
    0x88c1_0004, // lbz   r6, 4(r1)
    0x3884_0001, // addi  r4, r4, 1
    0xb081_0006, // sth   r4, 6(r1)
    0xa0e1_0006, // lhz   r7, 6(r1)
    0x4200_ffec, // bdnz  0x8000_1044
    0x8021_0000, // lwz   r1, 0(r1)
    0x4e80_0020, // blr
];

pub const TEXT_OFFSET: usize = HEADER_SIZE;
pub const TEXT_SIZE: usize = PROGRAM.len() * size_of::<u32>();
pub const DATA_OFFSET: usize = TEXT_OFFSET + TEXT_SIZE;
pub const DATA_SIZE: usize = size_of::<u32>();
pub const RESULT_SIZE: usize = RESULT_WORDS.len() * size_of::<u32>();
pub const FILE_SIZE: usize = DATA_OFFSET + DATA_SIZE;

/// Builds a complete big-endian DOL file accepted by `disks::dol::Dol::read`.
pub fn bytes() -> Vec<u8> {
    let mut dol = vec![0; FILE_SIZE];

    // Header array slots. All unused entries remain zero, which means "section absent".
    put_u32(&mut dol, 0x00, TEXT_OFFSET as u32); // text_offsets[0]
    put_u32(&mut dol, 0x1c, DATA_OFFSET as u32); // data_offsets[0]
    put_u32(&mut dol, 0x48, ENTRY_POINT); // text_targets[0]
    put_u32(&mut dol, 0x64, INPUT_ADDRESS); // data_targets[0]
    put_u32(&mut dol, 0x90, TEXT_SIZE as u32); // text_sizes[0]
    put_u32(&mut dol, 0xac, DATA_SIZE as u32); // data_sizes[0]
    put_u32(&mut dol, 0xd8, RESULT_ADDRESS); // bss_target
    put_u32(&mut dol, 0xdc, RESULT_SIZE as u32); // bss_size
    put_u32(&mut dol, 0xe0, ENTRY_POINT); // entry

    for (index, instruction) in PROGRAM.into_iter().enumerate() {
        put_u32(&mut dol, TEXT_OFFSET + index * 4, instruction);
    }
    put_u32(&mut dol, DATA_OFFSET, u32::from(LOOP_COUNT) << 16);

    dol
}

fn put_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}
