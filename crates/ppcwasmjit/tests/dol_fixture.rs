mod support;

use support::dol_fixture::{
    CONTINUATION_PC, DATA_OFFSET, DATA_SIZE, ENTRY_POINT, EXPECTED_INSTRUCTIONS, FILE_SIZE,
    HALT_PC, HEADER_SIZE, INITIAL_STACK_POINTER, INPUT_ADDRESS, LOOP_COUNT, LOOP_PC,
    PHYSICAL_INPUT_OFFSET, PHYSICAL_RESULT_OFFSET, PHYSICAL_STACK_FRAME_OFFSET,
    PHYSICAL_TEXT_OFFSET, PROGRAM, RESULT_ADDRESS, RESULT_SIZE, RESULT_WORDS, TEXT_OFFSET,
    TEXT_SIZE, WORKER_PC, bytes,
};

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[test]
fn generated_dol_matches_lazulis_loader_contract() {
    let dol = bytes();

    assert_eq!(dol.len(), FILE_SIZE);
    assert_eq!(read_u32(&dol, 0x00), TEXT_OFFSET as u32);
    assert_eq!(read_u32(&dol, 0x1c), DATA_OFFSET as u32);
    assert_eq!(read_u32(&dol, 0x48), ENTRY_POINT);
    assert_eq!(read_u32(&dol, 0x64), INPUT_ADDRESS);
    assert_eq!(read_u32(&dol, 0x90), TEXT_SIZE as u32);
    assert_eq!(read_u32(&dol, 0xac), DATA_SIZE as u32);
    assert_eq!(read_u32(&dol, 0xd8), RESULT_ADDRESS);
    assert_eq!(read_u32(&dol, 0xdc), RESULT_SIZE as u32);
    assert_eq!(read_u32(&dol, 0xe0), ENTRY_POINT);

    // Header::size() takes the maximum section end. That must cover exactly this file.
    assert_eq!(
        (read_u32(&dol, 0x00) + read_u32(&dol, 0x90)) as usize,
        DATA_OFFSET
    );
    assert_eq!(
        (read_u32(&dol, 0x1c) + read_u32(&dol, 0xac)) as usize,
        FILE_SIZE
    );

    // Unused section slots and DOL header padding stay zero.
    assert!(dol[0x04..0x1c].iter().all(|byte| *byte == 0));
    assert!(dol[0x20..0x48].iter().all(|byte| *byte == 0));
    assert!(dol[0xe4..HEADER_SIZE].iter().all(|byte| *byte == 0));
}

#[test]
fn generated_dol_contains_big_endian_program_and_input() {
    let dol = bytes();
    let words = dol[TEXT_OFFSET..DATA_OFFSET]
        .chunks_exact(4)
        .map(|word| u32::from_be_bytes(word.try_into().unwrap()))
        .collect::<Vec<_>>();

    assert_eq!(words, PROGRAM);
    assert_eq!(read_u32(&dol, DATA_OFFSET), u32::from(LOOP_COUNT) << 16);
}

#[test]
fn fixture_has_one_unambiguous_completion_state() {
    assert_eq!(RESULT_WORDS, [32, 31, 32, INITIAL_STACK_POINTER]);
    assert!(EXPECTED_INSTRUCTIONS > 100);
    assert_eq!(CONTINUATION_PC, 0x8000_1018);
    assert_eq!(HALT_PC, 0x8000_102c);
    assert_eq!(WORKER_PC, 0x8000_1040);
    assert_eq!(LOOP_PC, 0x8000_1044);
    assert_eq!(PROGRAM[5], 0x4800_002d);
    assert_eq!(PROGRAM[22], 0x4200_ffec);
    assert_eq!(PROGRAM.last(), Some(&0x4e80_0020));
    assert_eq!(ENTRY_POINT as usize - 0x8000_0000, PHYSICAL_TEXT_OFFSET);
    assert_eq!(INPUT_ADDRESS as usize - 0x8000_0000, PHYSICAL_INPUT_OFFSET);
    assert_eq!(
        RESULT_ADDRESS as usize - 0x8000_0000,
        PHYSICAL_RESULT_OFFSET
    );
    assert_eq!(
        INITIAL_STACK_POINTER as usize - 0x8000_0000 - 16,
        PHYSICAL_STACK_FRAME_OFFSET
    );
}
