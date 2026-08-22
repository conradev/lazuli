use browser_machine::di_runtime::{BrowserDiCallResult, BrowserDiError, BrowserDiRuntime};
use browser_machine::disc_boot::{BrowserDiscBootState, BrowserDiscBootStatus};
use lazuli::Address;
use lazuli::disks::async_boot::{CISO_HEADER_BYTES, ReadRequest};
use lazuli::gekko::LoadStoreReservation;
use lazuli::system::di::{ERROR_READ, Interface, MAX_DISC_READ_CHUNK_BYTES, ResidentServiceState};
use lazuli_abi::HostCompletionStatus;

const GAMECUBE_MAGIC: u32 = 0xc233_9f3d;
const BOOT_OFFSET: usize = 0x3000;
const FST_OFFSET: usize = 0xf_0000;
const TEXT_FILE_OFFSET: usize = 0x100;
const TEXT_TARGET: u32 = 0x8001_0000;
const TEXT_BYTES: usize = 0x9_0005;

fn write_be_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn fixture_iso() -> Vec<u8> {
    let mut image = vec![0; 0x10_0000];
    image[..10].copy_from_slice(b"GZLE01\0\x02\0\x20");
    image[0x20..0x38].copy_from_slice(b"Rust Browser DI Slice\0\0\0");
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

fn committed_boot(source: &[u8], reverse: bool) -> BrowserDiscBootState {
    let mut state = BrowserDiscBootState::default();
    let mut mem1 = vec![0; 24 * 1024 * 1024];
    state.begin(source.len() as u64).unwrap();
    while state.status() != BrowserDiscBootStatus::Committed {
        let mut requests: Vec<_> = state.requests().collect();
        assert!(!requests.is_empty());
        if reverse {
            requests.reverse();
        }
        for request in requests {
            let start = request.container_offset as usize;
            let end = start + request.length as usize;
            state
                .staging_mut(request)
                .unwrap()
                .copy_from_slice(&source[start..end]);
            state.complete(request, request.length, &mut mem1).unwrap();
        }
    }
    assert!(state.committed_disc_reader().is_some());
    state
}

#[allow(clippy::too_many_arguments)]
fn program_read(
    disk: &mut Interface,
    disc_bytes: u64,
    mem1: &mut [u8],
    reservation: &mut LoadStoreReservation,
    disc_offset: u32,
    dma_address: u32,
    length: u32,
    cycle: u64,
) -> u64 {
    disk.configure_resident_disc(Some(disc_bytes)).unwrap();
    disk.write_resident_command_word(0, 0xa800_0000).unwrap();
    disk.write_resident_command_word(1, disc_offset / 4)
        .unwrap();
    disk.write_resident_command_word(2, length).unwrap();
    disk.write_resident_dma_address(dma_address).unwrap();
    disk.write_resident_dma_length(length).unwrap();
    disk.write_resident_control(3, cycle, mem1, reservation)
        .unwrap()
        .unwrap()
        .completion_cycle
}

fn drive_di_read(
    source: &[u8],
    boot: &mut BrowserDiscBootState,
    disk: &mut Interface,
    runtime: &mut BrowserDiRuntime,
) -> Vec<ReadRequest> {
    let reader = boot.committed_disc_reader_mut().unwrap();
    let mut requests = Vec::new();
    while let Some(request) = runtime.prepare(disk, reader).unwrap() {
        requests.push(request);
        let start = request.container_offset as usize;
        let end = start + request.length as usize;
        let fetched = source[start..end].to_vec();
        runtime
            .staging_mut(disk, reader, request)
            .unwrap()
            .copy_from_slice(&fetched);
        assert!(matches!(
            runtime
                .complete(
                    disk,
                    reader,
                    request,
                    request.length,
                    HostCompletionStatus::Ok as u32,
                )
                .unwrap(),
            BrowserDiCallResult::Accepted | BrowserDiCallResult::LogicalWindowReady
        ));
    }
    requests
}

#[test]
fn raw_and_ciso_post_boot_di_reads_commit_identical_bytes_at_the_exact_deadline() {
    let iso = fixture_iso();
    let ciso = fixture_ciso(&iso, 0x200);
    let mut outputs = Vec::new();
    for (source, reverse) in [(iso.as_slice(), false), (ciso.as_slice(), true)] {
        let mut boot = committed_boot(source, reverse);
        let logical_bytes = boot.committed_disc_reader().unwrap().logical_bytes();
        let mut disk = Interface::default();
        let mut runtime = BrowserDiRuntime::default();
        let mut mem1 = vec![0xcc; 24 * 1024 * 1024];
        let mut reservation = LoadStoreReservation::default();
        reservation.reserve(Address(0x2000));
        let completion = program_read(
            &mut disk,
            logical_bytes,
            &mut mem1,
            &mut reservation,
            0x400,
            0x2000,
            MAX_DISC_READ_CHUNK_BYTES + 0x20,
            10_000,
        );
        let requests = drive_di_read(source, &mut boot, &mut disk, &mut runtime);
        assert!(requests.iter().all(|request| request.length <= 256 * 1024));
        if reverse {
            assert!(
                requests
                    .iter()
                    .all(|request| request.container_offset >= u64::from(CISO_HEADER_BYTES))
            );
        } else {
            assert_eq!(requests.len(), 2, "raw DI uses two exact logical windows");
        }
        assert!(matches!(
            disk.service_resident(completion - 1, &mut mem1, &mut reservation)
                .command,
            ResidentServiceState::BeforeDeadline { .. }
        ));
        assert!(
            mem1[0x2000..0x2000 + MAX_DISC_READ_CHUNK_BYTES as usize + 0x20]
                .iter()
                .all(|byte| *byte == 0xcc)
        );
        let summary = disk.service_resident(completion, &mut mem1, &mut reservation);
        let ResidentServiceState::Completed(done) = summary.command else {
            panic!("ready DI payload must complete at its Rust deadline");
        };
        assert!(done.successful);
        assert_eq!(done.memory_write_bytes, MAX_DISC_READ_CHUNK_BYTES + 0x20);
        assert!(!reservation.is_valid());
        outputs.push(mem1[0x2000..0x2000 + MAX_DISC_READ_CHUNK_BYTES as usize + 0x20].to_vec());
    }
    assert_eq!(outputs[0], iso[0x400..0x4_0420]);
    assert_eq!(outputs[1], outputs[0]);
}

#[test]
fn identity_status_short_and_host_failures_never_publish_mem1_or_advance_dma() {
    let iso = fixture_iso();
    for outcome in ["short", "failure"] {
        let mut boot = committed_boot(&iso, false);
        let logical_bytes = boot.committed_disc_reader().unwrap().logical_bytes();
        let reader = boot.committed_disc_reader_mut().unwrap();
        let mut disk = Interface::default();
        let mut runtime = BrowserDiRuntime::default();
        let mut mem1 = vec![0xcc; 0x4000];
        let mut reservation = LoadStoreReservation::default();
        reservation.reserve(Address(0x800));
        let completion = program_read(
            &mut disk,
            logical_bytes,
            &mut mem1,
            &mut reservation,
            0x400,
            0x800,
            0x200,
            20_000,
        );
        let request = runtime.prepare(&mut disk, reader).unwrap().unwrap();
        let published = runtime.lifecycle_evidence().unwrap();
        assert_eq!(published.physical_host_requests_issued, 1);
        assert!(published.physical_host_request_pending);
        let malformed = ReadRequest {
            container_offset: request.container_offset + 1,
            ..request
        };
        assert_eq!(
            runtime
                .staging_mut(&mut disk, reader, malformed)
                .unwrap_err()
                .call_result(),
            BrowserDiCallResult::DescriptorMismatch
        );
        assert_eq!(runtime.prepare(&mut disk, reader), Ok(Some(request)));
        assert_eq!(
            runtime
                .lifecycle_evidence()
                .unwrap()
                .physical_host_requests_issued,
            1
        );
        assert!(matches!(
            runtime.complete(&mut disk, reader, request, request.length, u32::MAX),
            Err(BrowserDiError::InvalidHostStatus(u32::MAX))
        ));
        assert_eq!(runtime.prepare(&mut disk, reader), Ok(Some(request)));
        let rejected = runtime.lifecycle_evidence().unwrap();
        assert_eq!(rejected.physical_host_requests_issued, 1);
        assert_eq!(rejected.host_receipts_rejected, 1);
        assert!(rejected.physical_host_request_pending);

        let result = if outcome == "short" {
            runtime.complete(
                &mut disk,
                reader,
                request,
                request.length - 1,
                HostCompletionStatus::Ok as u32,
            )
        } else {
            runtime.complete(
                &mut disk,
                reader,
                request,
                0,
                HostCompletionStatus::IoError as u32,
            )
        };
        if outcome == "short" {
            assert!(matches!(
                result,
                Err(BrowserDiError::HostLengthMismatch { .. })
            ));
        } else {
            assert_eq!(result, Ok(BrowserDiCallResult::DeviceReadFailed));
        }
        let failed = runtime.lifecycle_evidence().unwrap();
        assert_eq!(failed.physical_host_requests_issued, 1);
        assert_eq!(failed.host_receipts_failed, 1);
        assert_eq!(failed.host_receipts_succeeded, 0);
        assert_eq!(failed.physical_host_requests_cancelled, 0);
        assert_eq!(failed.host_receipts_rejected, 1);
        assert_eq!(failed.logical_windows_failed, 1);
        assert!(!failed.physical_host_request_pending);
        let ResidentServiceState::Completed(done) = disk
            .service_resident(completion, &mut mem1, &mut reservation)
            .command
        else {
            panic!("failed DI host work must retire at its scheduled deadline");
        };
        assert!(!done.successful);
        assert_eq!(done.error_code, ERROR_READ);
        assert_eq!(done.memory_write_bytes, 0);
        assert_eq!(&mem1[0x800..0xa00], &[0xcc; 0x200]);
        assert_eq!(disk.dma_base, Address(0x800));
        assert_eq!(disk.dma_length, 0x200);
        assert!(reservation.is_valid());
    }
}

#[test]
fn duplicate_physical_completion_is_stale_and_cannot_reopen_a_ready_di_payload() {
    let iso = fixture_iso();
    let mut boot = committed_boot(&iso, false);
    let logical_bytes = boot.committed_disc_reader().unwrap().logical_bytes();
    let reader = boot.committed_disc_reader_mut().unwrap();
    let mut disk = Interface::default();
    let mut runtime = BrowserDiRuntime::default();
    let mut mem1 = vec![0xcc; 0x4000];
    let mut reservation = LoadStoreReservation::default();
    let completion = program_read(
        &mut disk,
        logical_bytes,
        &mut mem1,
        &mut reservation,
        0x400,
        0x800,
        0x200,
        30_000,
    );
    let request = runtime.prepare(&mut disk, reader).unwrap().unwrap();
    let start = request.container_offset as usize;
    runtime
        .staging_mut(&mut disk, reader, request)
        .unwrap()
        .copy_from_slice(&iso[start..start + request.length as usize]);
    assert_eq!(
        runtime.complete(
            &mut disk,
            reader,
            request,
            request.length,
            HostCompletionStatus::Ok as u32,
        ),
        Ok(BrowserDiCallResult::LogicalWindowReady)
    );
    let succeeded = runtime.lifecycle_evidence().unwrap();
    assert_eq!(succeeded.physical_host_requests_issued, 1);
    assert_eq!(succeeded.host_receipts_succeeded, 1);
    assert_eq!(succeeded.logical_windows_ready, 1);
    assert!(!succeeded.physical_host_request_pending);
    assert_eq!(
        runtime
            .complete(
                &mut disk,
                reader,
                request,
                request.length,
                HostCompletionStatus::Ok as u32,
            )
            .unwrap_err()
            .call_result(),
        BrowserDiCallResult::StaleRequest
    );
    let duplicate = runtime.lifecycle_evidence().unwrap();
    assert_eq!(duplicate.physical_host_requests_issued, 1);
    assert_eq!(duplicate.host_receipts_succeeded, 1);
    assert_eq!(duplicate.host_receipts_rejected, 1);
    assert!(!duplicate.physical_host_request_pending);
    assert_eq!(&mem1[0x800..0xa00], &[0xcc; 0x200]);
    let ResidentServiceState::Completed(done) = disk
        .service_resident(completion, &mut mem1, &mut reservation)
        .command
    else {
        panic!("ready DI transfer must complete");
    };
    assert!(done.successful);
    assert_eq!(&mem1[0x800..0xa00], &iso[0x400..0x600]);
}
