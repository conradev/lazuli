use browser_machine::disc_boot::{
    BOOT_LOW_MEMORY_BYTES, BrowserDiscBootError, BrowserDiscBootFaultCode, BrowserDiscBootProgress,
    BrowserDiscBootStatus,
};
use browser_machine::{BrowserMachine, IPL_BYTES};
use lazuli::Address;
use lazuli::disks::async_boot::{
    BootError, CISO_HEADER_BYTES, MAX_BOOT_LOAD_CHUNK_BYTES, ReadCompletionError, ReadRequest,
};
use lazuli::modules::audio::NopAudioModule;
use lazuli::modules::debug::NopDebugModule;
use lazuli::modules::disk::NopDiskModule;
use lazuli::modules::input::NopInputModule;
use lazuli::modules::render::NopRenderModule;
use lazuli::modules::vertex::NopVertexModule;
use lazuli::system::mmu::{TranslationEffect, TranslationSource};
use lazuli::system::{Config, Modules, System};

const GAMECUBE_MAGIC: u32 = 0xc233_9f3d;
const BOOT_OFFSET: usize = 0x3000;
const FST_OFFSET: usize = 0xf_0000;
const TEXT_FILE_OFFSET: usize = 0x100;
const TEXT_TARGET: u32 = 0x8001_0000;
const TEXT_BYTES: usize = 0x9_0005;
const BSS_TARGET: u32 = 0x800c_0000;
const BSS_BYTES: usize = 0x201;
const ORIGINAL_PC: u32 = 0xdead_beec;

fn test_system() -> System {
    System::new(
        Modules {
            audio: Box::new(NopAudioModule),
            debug: Box::new(NopDebugModule),
            disk: Box::new(NopDiskModule),
            input: Box::new(NopInputModule),
            render: Box::new(NopRenderModule),
            vertex: Box::new(NopVertexModule),
        },
        Config {
            ipl_lle: true,
            ipl: Some(vec![0; IPL_BYTES]),
            sideload: None,
            perform_efb_copies: false,
            uart_escape: false,
        },
    )
}

fn write_be_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn fixture_iso() -> Vec<u8> {
    let mut image = vec![0; 0x10_0000];
    image[..10].copy_from_slice(b"GZLE01\0\x02\0\x20");
    image[0x20..0x38].copy_from_slice(b"Rust Browser Boot Slice\0");
    write_be_u32(&mut image, 0x1c, GAMECUBE_MAGIC);
    write_be_u32(&mut image, 0x420, BOOT_OFFSET as u32);
    write_be_u32(&mut image, 0x424, FST_OFFSET as u32);
    write_be_u32(&mut image, 0x428, 13);
    write_be_u32(&mut image, 0x42c, 47);

    image[0x440..0x600].fill(0x41);
    image[0x800..0xa00].fill(0x82);
    image[0xc00..0xe00].fill(0xc3);

    let dol = &mut image[BOOT_OFFSET..BOOT_OFFSET + 0x100];
    write_be_u32(dol, 0x00, TEXT_FILE_OFFSET as u32);
    write_be_u32(dol, 0x48, TEXT_TARGET);
    write_be_u32(dol, 0x90, TEXT_BYTES as u32);
    write_be_u32(dol, 0xd8, BSS_TARGET);
    write_be_u32(dol, 0xdc, BSS_BYTES as u32);
    write_be_u32(dol, 0xe0, TEXT_TARGET);

    for (index, byte) in image
        [BOOT_OFFSET + TEXT_FILE_OFFSET..BOOT_OFFSET + TEXT_FILE_OFFSET + TEXT_BYTES]
        .iter_mut()
        .enumerate()
    {
        *byte = 1 + (index as u8 % 251);
    }
    image[FST_OFFSET..FST_OFFSET + 13].copy_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    image
}

fn fixture_ciso(logical: &[u8], block_bytes: usize) -> Vec<u8> {
    let mut header = vec![0; CISO_HEADER_BYTES as usize];
    header[..4].copy_from_slice(b"CISO");
    header[4..8].copy_from_slice(&(block_bytes as u32).to_le_bytes());
    let mut physical = Vec::new();
    for (index, block) in logical.chunks(block_bytes).enumerate() {
        if block.iter().any(|byte| *byte != 0) {
            header[8 + index] = 1;
            let mut padded = vec![0; block_bytes];
            padded[..block.len()].copy_from_slice(block);
            physical.extend_from_slice(&padded);
        }
    }
    header.extend(physical);
    header
}

fn fetched_range(source: &[u8], request: ReadRequest) -> Vec<u8> {
    let start = request.container_offset as usize;
    let end = start + request.length as usize;
    source[start..end].to_vec()
}

fn drive_boot(
    machine: &mut BrowserMachine,
    source: &[u8],
    reverse_completions: bool,
) -> (BrowserDiscBootProgress, Vec<ReadRequest>) {
    machine.begin_disc_boot(source.len() as u64).unwrap();
    let original_low = machine.system().mem.ram()[..BOOT_LOW_MEMORY_BYTES].to_vec();
    let mut issued = Vec::new();
    loop {
        let mut requests: Vec<_> = machine.disc_boot().requests().collect();
        assert!(
            !requests.is_empty(),
            "a live boot must expose exact host work"
        );
        if reverse_completions {
            requests.reverse();
        }
        for request in requests {
            assert!(request.length <= MAX_BOOT_LOAD_CHUNK_BYTES);
            issued.push(request);

            // This owned descriptor and browser-side fetched bytes are the only values that cross
            // the simulated await. A Rust staging pointer is acquired only after the fetch.
            let fetched = fetched_range(source, request);
            let staging = machine.disc_boot_staging_mut(request).unwrap();
            assert_eq!(staging.len(), fetched.len());
            staging.copy_from_slice(&fetched);
            let progress = machine.complete_disc_boot(request, request.length).unwrap();
            if progress.status == BrowserDiscBootStatus::Committed {
                return (progress, issued);
            }
            assert_eq!(machine.system().cpu.pc, Address(ORIGINAL_PC));
            assert_eq!(
                &machine.system().mem.ram()[..BOOT_LOW_MEMORY_BYTES],
                original_low,
                "low-memory handoff must remain atomic until terminal commit"
            );
        }
    }
}

fn assert_committed_machine(machine: &mut BrowserMachine, iso: &[u8]) {
    {
        let commit = machine.disc_boot().commit().unwrap();
        let ram = machine.system().mem.ram();
        assert_eq!(machine.system().cpu.pc, Address(TEXT_TARGET));
        assert_eq!(&ram[..6], b"GZLE01");
        assert_eq!(&ram[6..10], &[0, 2, 0, 0x20]);
        let word = |offset: usize| u32::from_be_bytes(ram[offset..offset + 4].try_into().unwrap());
        assert_eq!(word(0x1c), GAMECUBE_MAGIC);
        assert_eq!(word(0x20), 0x0d15_ea5e);
        assert_eq!(word(0x24), 1);
        assert_eq!(word(0x28), 0x0180_0000);
        assert_eq!(word(0x2c), 0x1000_0005);
        assert_eq!(word(0x30), 0);
        assert_eq!(word(0x34), commit.fst_address);
        assert_eq!(word(0x38), commit.fst_address);
        assert_eq!(word(0x3c), 47);
        assert_eq!(word(0xcc), 0);
        assert_eq!(word(0xd0), 0x0100_0000);
        assert_eq!(word(0xf4), commit.bi2_address);
        assert_eq!(word(0xf8), 0x09a7_ec80);
        assert_eq!(word(0xfc), 0x1cf7_c580);
        assert_eq!(
            &ram[(TEXT_TARGET - 0x8000_0000) as usize
                ..(TEXT_TARGET - 0x8000_0000) as usize + TEXT_BYTES],
            &iso[BOOT_OFFSET + TEXT_FILE_OFFSET..BOOT_OFFSET + TEXT_FILE_OFFSET + TEXT_BYTES]
        );
        assert_eq!(
            &ram[(BSS_TARGET - 0x8000_0000) as usize
                ..(BSS_TARGET - 0x8000_0000) as usize + BSS_BYTES],
            vec![0; BSS_BYTES]
        );
    }

    let system = machine.system_mut();
    assert_eq!(system.cpu.supervisor.config.msr.to_bits(), 0x30);
    assert_eq!(system.cpu.supervisor.memory.sr, [0; 16]);
    assert_eq!(system.cpu.supervisor.memory.sdr1, 0);
    assert_eq!(
        system
            .cpu
            .supervisor
            .memory
            .ibat
            .clone()
            .map(|bat| bat.to_bits()),
        [0x8000_1fff_0000_0002, 0, 0, 0xfff0_001f_fff0_0001,]
    );
    assert_eq!(
        system
            .cpu
            .supervisor
            .memory
            .dbat
            .clone()
            .map(|bat| bat.to_bits()),
        [
            0x8000_1fff_0000_0002,
            0xc000_1fff_0000_002a,
            0,
            0xfff0_001f_fff0_0001,
        ]
    );
    let instruction = system
        .translate_instruction_mmu(Address(TEXT_TARGET), TranslationEffect::Probe)
        .unwrap();
    assert_eq!(instruction.physical, TEXT_TARGET - 0x8000_0000);
    assert!(matches!(instruction.source, TranslationSource::Bat { .. }));
}

#[test]
fn raw_iso_executes_in_bounded_chunks_then_atomically_commits_low_memory_and_pc() {
    let iso = fixture_iso();
    let mut machine = BrowserMachine::from_system(test_system()).unwrap();
    machine.system_mut().mem.ram_mut()[..BOOT_LOW_MEMORY_BYTES].fill(0xa5);
    machine.system_mut().cpu.pc = Address(ORIGINAL_PC);
    let (progress, requests) = drive_boot(&mut machine, &iso, false);

    assert!(progress.commit.is_some());
    assert!(requests.windows(2).any(|pair| {
        pair.iter()
            .all(|request| request.length == MAX_BOOT_LOAD_CHUNK_BYTES)
    }));
    assert_committed_machine(&mut machine, &iso);
}

#[test]
fn ciso_retains_sparse_mapping_through_reordered_chunk_completions_and_commit() {
    let iso = fixture_iso();
    let ciso = fixture_ciso(&iso, 0x200);
    let mut machine = BrowserMachine::from_system(test_system()).unwrap();
    machine.system_mut().mem.ram_mut()[..BOOT_LOW_MEMORY_BYTES].fill(0x5a);
    machine.system_mut().cpu.pc = Address(ORIGINAL_PC);
    let (progress, requests) = drive_boot(&mut machine, &ciso, true);

    assert!(progress.commit.is_some());
    assert!(
        requests
            .iter()
            .all(|request| { request.length <= MAX_BOOT_LOAD_CHUNK_BYTES })
    );
    assert!(requests.windows(2).any(|pair| {
        pair.iter()
            .all(|request| request.length == MAX_BOOT_LOAD_CHUNK_BYTES)
    }));
    assert!(
        requests
            .iter()
            .any(|request| { request.container_offset >= u64::from(CISO_HEADER_BYTES) })
    );
    assert_committed_machine(&mut machine, &iso);
}

#[test]
fn cancelled_epoch_rejects_stale_staging_identity_after_rotation() {
    let iso = fixture_iso();
    let mut machine = BrowserMachine::from_system(test_system()).unwrap();
    machine.begin_disc_boot(iso.len() as u64).unwrap();
    let stale = machine.disc_boot_request(0).unwrap();

    assert!(machine.cancel_disc_boot());
    machine.begin_disc_boot(iso.len() as u64).unwrap();
    let current = machine.disc_boot_request(0).unwrap();
    assert_ne!(stale.epoch, current.epoch);
    assert!(machine.disc_boot_staging_mut(stale).is_err());
    assert_eq!(machine.disc_boot_request(0), Some(current));
}

#[test]
fn duplicate_short_and_malformed_completions_fail_closed_before_handoff() {
    let iso = fixture_iso();
    let mut machine = BrowserMachine::from_system(test_system()).unwrap();
    machine.system_mut().mem.ram_mut()[..BOOT_LOW_MEMORY_BYTES].fill(0x77);
    machine.system_mut().cpu.pc = Address(ORIGINAL_PC);
    machine.begin_disc_boot(iso.len() as u64).unwrap();

    let first = machine.disc_boot_request(0).unwrap();
    machine
        .disc_boot_staging_mut(first)
        .unwrap()
        .copy_from_slice(&fetched_range(&iso, first));
    machine.complete_disc_boot(first, first.length).unwrap();
    let dol_header = machine.disc_boot_request(0).unwrap();
    assert!(matches!(
        machine.complete_disc_boot(first, first.length),
        Err(BrowserDiscBootError::Completion(
            ReadCompletionError::StaleRequest { id }
        )) if id == first.id
    ));
    assert_eq!(machine.disc_boot_request(0), Some(dol_header));

    assert!(matches!(
        machine.complete_disc_boot(dol_header, dol_header.length - 1),
        Err(BrowserDiscBootError::Completion(
            ReadCompletionError::ShortRead { request, written }
        )) if request == dol_header && written == dol_header.length - 1
    ));
    assert_eq!(machine.disc_boot().status(), BrowserDiscBootStatus::Failed);
    assert_eq!(
        machine.disc_boot().fault_code(),
        BrowserDiscBootFaultCode::PlanningShortRead
    );
    assert_eq!(machine.disc_boot().pending_count(), 0);
    assert_eq!(machine.system().cpu.pc, Address(ORIGINAL_PC));
    assert!(
        machine.system().mem.ram()[..BOOT_LOW_MEMORY_BYTES]
            .iter()
            .all(|byte| *byte == 0x77)
    );

    let mut malformed = BrowserMachine::from_system(test_system()).unwrap();
    malformed.system_mut().cpu.pc = Address(ORIGINAL_PC);
    malformed
        .begin_disc_boot(u64::from(CISO_HEADER_BYTES))
        .unwrap();
    let request = malformed.disc_boot_request(0).unwrap();
    malformed.disc_boot_staging_mut(request).unwrap().fill(0);
    assert_eq!(
        malformed.complete_disc_boot(request, request.length),
        Err(BrowserDiscBootError::Boot(BootError::InvalidDiscMagic(0)))
    );
    assert_eq!(
        malformed.disc_boot().fault_code(),
        BrowserDiscBootFaultCode::Planning
    );
    assert_eq!(malformed.system().cpu.pc, Address(ORIGINAL_PC));
}
