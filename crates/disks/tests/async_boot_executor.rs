use disks::async_boot::{
    BootLoadCompletionError, BootLoadError, BootLoadExecutor, BootLoadExecutorStage,
    BootLoadStartError, BootMem1, BootMem1Access, BootMem1Error, BootMem1Slice, BootReaderStage,
    CISO_HEADER_BYTES, CommittedDiscReadError, CommittedDiscReadProgress, CommittedDiscReader,
    DiscBootReader, LogicalReadIdentity, MAX_BOOT_LOAD_CHUNK_BYTES, ReadCompletionError,
    ReadRequest,
};

const EPOCH: u64 = 0x4558_4543_5554_4f52;
const GAMECUBE_MAGIC: u32 = 0xc233_9f3d;
const MEM1_BASE: u32 = 0x8000_0000;
const MEM1_BYTES: usize = 24 * 1024 * 1024;
const BOOT_OFFSET: usize = 0x3000;
const FST_OFFSET: usize = 0x7000;
const TEXT_FILE_OFFSET: usize = 0x100;
const TEXT_TARGET: u32 = 0x8000_3100;
const TEXT_BYTES: usize = 0x305;
const DATA_FILE_OFFSET: usize = 0x500;
const DATA_TARGET: u32 = 0x8000_4000;
const DATA_BYTES: usize = 0x113;
const BSS_TARGET: u32 = 0x8000_5000;
const BSS_BYTES: usize = 0x81;

fn write_be_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn valid_iso() -> Vec<u8> {
    let mut image = vec![0; 0x1_0000];
    image[..10].copy_from_slice(b"GZLE01\0\x02\0\x20");
    image[0x20..0x34].copy_from_slice(b"Chunked Rust Loader\0");
    write_be_u32(&mut image, 0x1c, GAMECUBE_MAGIC);
    write_be_u32(&mut image, 0x420, BOOT_OFFSET as u32);
    write_be_u32(&mut image, 0x424, FST_OFFSET as u32);
    write_be_u32(&mut image, 0x428, 13);
    write_be_u32(&mut image, 0x42c, 47);

    // Leave complete 512-byte holes in BI2 so a CISO fixture must synthesize them.
    image[0x440..0x600].fill(0x41);
    image[0x800..0xa00].fill(0x82);
    image[0xc00..0xe00].fill(0xc3);

    let dol = &mut image[BOOT_OFFSET..BOOT_OFFSET + 0x100];
    write_be_u32(dol, 0x00, TEXT_FILE_OFFSET as u32);
    write_be_u32(dol, 0x1c, DATA_FILE_OFFSET as u32);
    write_be_u32(dol, 0x48, TEXT_TARGET);
    write_be_u32(dol, 0x64, DATA_TARGET);
    write_be_u32(dol, 0x90, TEXT_BYTES as u32);
    write_be_u32(dol, 0xac, DATA_BYTES as u32);
    write_be_u32(dol, 0xd8, BSS_TARGET);
    write_be_u32(dol, 0xdc, BSS_BYTES as u32);
    write_be_u32(dol, 0xe0, TEXT_TARGET);

    for (index, byte) in image
        [BOOT_OFFSET + TEXT_FILE_OFFSET..BOOT_OFFSET + TEXT_FILE_OFFSET + TEXT_BYTES]
        .iter_mut()
        .enumerate()
    {
        *byte = 0x10 | (index as u8 & 0x0f);
    }
    for (index, byte) in image
        [BOOT_OFFSET + DATA_FILE_OFFSET..BOOT_OFFSET + DATA_FILE_OFFSET + DATA_BYTES]
        .iter_mut()
        .enumerate()
    {
        *byte = 0xa0 | (index as u8 & 0x0f);
    }
    image[FST_OFFSET..FST_OFFSET + 13].copy_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    image
}

fn ciso_from_sparse_logical(logical: &[u8], block_bytes: usize) -> Vec<u8> {
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

fn complete_reader(reader: &mut DiscBootReader, source: &[u8], request: ReadRequest) {
    let start = request.container_offset as usize;
    let end = start + request.length as usize;
    reader
        .staging_mut(request)
        .unwrap()
        .copy_from_slice(&source[start..end]);
    reader.complete(request, request.length).unwrap();
}

fn ready_reader(source: &[u8], reverse: bool) -> DiscBootReader {
    let mut reader = DiscBootReader::new(source.len() as u64, EPOCH).unwrap();
    while reader.stage() != BootReaderStage::Ready {
        let mut requests: Vec<_> = reader.requests().collect();
        assert!(!requests.is_empty());
        if reverse {
            requests.reverse();
        }
        for request in requests {
            complete_reader(&mut reader, source, request);
        }
        assert_ne!(
            reader.stage(),
            BootReaderStage::Failed,
            "{:?}",
            reader.failure()
        );
    }
    reader
}

fn complete_executor(
    executor: &mut BootLoadExecutor,
    source: &[u8],
    mem1: &mut impl BootMem1,
    reverse: bool,
) -> (Vec<ReadRequest>, usize) {
    let mut issued = Vec::new();
    let mut maximum_wave = 0;
    executor.advance(mem1).unwrap();
    while executor.stage() == BootLoadExecutorStage::Loading {
        let mut requests: Vec<_> = executor.requests().collect();
        assert!(
            !requests.is_empty(),
            "a live executor must expose physical work"
        );
        maximum_wave = maximum_wave.max(requests.len());
        issued.extend_from_slice(&requests);
        if reverse {
            requests.reverse();
        }
        for request in requests {
            let start = request.container_offset as usize;
            let end = start + request.length as usize;
            executor
                .staging_mut(request)
                .unwrap()
                .copy_from_slice(&source[start..end]);
            executor.complete(request, request.length, mem1).unwrap();
        }
    }
    (issued, maximum_wave)
}

fn committed_reader(source: &[u8], reverse: bool) -> CommittedDiscReader {
    let mut executor = ready_reader(source, reverse)
        .into_load_executor(MAX_BOOT_LOAD_CHUNK_BYTES)
        .unwrap();
    let mut bytes = vec![0x5a; MEM1_BYTES];
    let mut mem1 = BootMem1Slice::new(&mut bytes);
    complete_executor(&mut executor, source, &mut mem1, reverse);
    executor.into_committed_disc().unwrap().reader
}

fn read_committed_window(
    reader: &mut CommittedDiscReader,
    source: &[u8],
    identity: LogicalReadIdentity,
) -> (Vec<u8>, Vec<ReadRequest>) {
    let mut staging = vec![0xcc; identity.length as usize];
    let mut progress = reader.begin(identity, &mut staging).unwrap();
    let mut requests = Vec::new();
    loop {
        progress = match progress {
            CommittedDiscReadProgress::HostRead(request) => {
                requests.push(request);
                let start = request.container_offset as usize;
                let end = start + request.length as usize;
                reader
                    .staging_mut(identity, request, &mut staging)
                    .unwrap()
                    .copy_from_slice(&source[start..end]);
                reader.complete(identity, request, request.length).unwrap()
            }
            CommittedDiscReadProgress::Ready(ready) => {
                assert_eq!(ready, identity);
                break;
            }
        };
    }
    (staging, requests)
}

fn mem1_range<'a>(memory: &'a BootMem1Slice<'_>, target: u32, length: usize) -> &'a [u8] {
    let offset = (target - MEM1_BASE) as usize;
    &memory.as_slice()[offset..offset + length]
}

#[test]
fn raw_plan_streams_bounded_chunks_and_commits_authenticated_metadata() {
    let iso = valid_iso();
    let mut executor = ready_reader(&iso, false).into_load_executor(0x181).unwrap();
    let plan = executor.plan().clone();
    let mut bytes = vec![0x5a; MEM1_BYTES];
    let mut mem1 = BootMem1Slice::new(&mut bytes);
    let (requests, _) = complete_executor(&mut executor, &iso, &mut mem1, false);

    assert_eq!(executor.stage(), BootLoadExecutorStage::Committed);
    assert_eq!(requests.first().unwrap().epoch, EPOCH);
    assert!(
        requests.first().unwrap().id > 2,
        "executor request IDs must continue after the planner's two raw-image reads"
    );
    assert!(
        requests.windows(2).all(|pair| pair[0].id < pair[1].id),
        "the retained exact-read owner must never reuse an ID"
    );
    assert!(requests.iter().all(|request| request.length <= 0x181));
    assert!(requests.len() > plan.operations.len());
    assert_eq!(
        mem1_range(&mem1, plan.bi2_address, 0x2000),
        &iso[0x440..0x2440]
    );
    assert_eq!(
        mem1_range(&mem1, plan.fst_address, plan.fst_bytes as usize),
        &iso[FST_OFFSET..FST_OFFSET + 13]
    );
    assert_eq!(
        mem1_range(&mem1, TEXT_TARGET, TEXT_BYTES),
        &iso[BOOT_OFFSET + TEXT_FILE_OFFSET..BOOT_OFFSET + TEXT_FILE_OFFSET + TEXT_BYTES]
    );
    assert_eq!(
        mem1_range(&mem1, DATA_TARGET, DATA_BYTES),
        &iso[BOOT_OFFSET + DATA_FILE_OFFSET..BOOT_OFFSET + DATA_FILE_OFFSET + DATA_BYTES]
    );
    assert_eq!(mem1_range(&mem1, BSS_TARGET, BSS_BYTES), vec![0; BSS_BYTES]);

    let commit = executor.commit().unwrap();
    assert_eq!(commit.identity.identifier, *b"GZLE01");
    assert_eq!(commit.entry, TEXT_TARGET);
    assert_eq!(commit.canonical_entry, TEXT_TARGET);
    assert_eq!(commit.fst_address, plan.fst_address);
    assert_eq!(commit.fst_bytes, 13);
    assert_eq!(commit.fst_max_bytes, 47);
    assert_eq!(commit.fst_reserved_bytes, 64);
}

#[test]
fn ciso_map_survives_planning_and_sparse_chunks_accept_reordered_completions() {
    let iso = valid_iso();
    let ciso = ciso_from_sparse_logical(&iso, 0x200);
    let mut executor = ready_reader(&ciso, true).into_load_executor(0x600).unwrap();
    let plan = executor.plan().clone();
    let mut bytes = vec![0x5a; MEM1_BYTES];
    let mut mem1 = BootMem1Slice::new(&mut bytes);
    let (requests, maximum_wave) = complete_executor(&mut executor, &ciso, &mut mem1, true);

    assert_eq!(executor.stage(), BootLoadExecutorStage::Committed);
    assert!(requests.iter().all(|request| request.length <= 0x600));
    assert!(
        maximum_wave >= 2,
        "the fixture must reverse genuinely concurrent physical CISO runs"
    );
    assert!(
        requests
            .iter()
            .all(|request| request.container_offset >= u64::from(CISO_HEADER_BYTES))
    );
    assert_eq!(
        mem1_range(&mem1, plan.bi2_address, 0x2000),
        &iso[0x440..0x2440]
    );
    assert_eq!(
        mem1_range(&mem1, TEXT_TARGET, TEXT_BYTES),
        &iso[BOOT_OFFSET + TEXT_FILE_OFFSET..BOOT_OFFSET + TEXT_FILE_OFFSET + TEXT_BYTES]
    );
    assert_eq!(mem1_range(&mem1, BSS_TARGET, BSS_BYTES), vec![0; BSS_BYTES]);
}

#[test]
fn committed_raw_and_ciso_readers_produce_identical_logical_bytes_without_map_cloning() {
    let iso = valid_iso();
    let ciso = ciso_from_sparse_logical(&iso, 0x200);
    let identity = LogicalReadIdentity {
        epoch: 0x4449,
        id: 7,
        logical_offset: 0x3f0,
        length: 0x2410,
    };
    let mut raw = committed_reader(&iso, false);
    let mut sparse = committed_reader(&ciso, true);
    let (raw_bytes, raw_requests) = read_committed_window(&mut raw, &iso, identity);
    let (ciso_bytes, ciso_requests) = read_committed_window(&mut sparse, &ciso, identity);

    assert_eq!(raw_bytes, iso[0x3f0..0x2800]);
    assert_eq!(ciso_bytes, raw_bytes);
    assert_eq!(raw_requests.len(), 1);
    assert_eq!(raw_requests[0].container_offset, identity.logical_offset);
    assert!(
        ciso_requests.len() > 1,
        "fixture must cross sparse CISO runs"
    );
    assert!(ciso_requests.iter().all(|request| {
        request.container_offset >= u64::from(CISO_HEADER_BYTES)
            && request.length <= MAX_BOOT_LOAD_CHUNK_BYTES
    }));
    assert!(ciso_requests.windows(2).all(|pair| pair[0].id < pair[1].id));
    assert!(
        raw_requests[0].id > 1,
        "post-boot IDs continue the boot cursor"
    );
}

#[test]
fn committed_reader_reauthenticates_direct_staging_and_retires_short_or_duplicate_receipts() {
    let iso = valid_iso();
    let mut reader = committed_reader(&iso, false);
    let identity = LogicalReadIdentity {
        epoch: 0x4449,
        id: 9,
        logical_offset: 0x440,
        length: 0x200,
    };
    let mut staging = vec![0xcc; identity.length as usize];
    let CommittedDiscReadProgress::HostRead(request) =
        reader.begin(identity, &mut staging).unwrap()
    else {
        panic!("raw read must issue one host request");
    };
    let malformed = ReadRequest {
        container_offset: request.container_offset + 1,
        ..request
    };
    assert!(matches!(
        reader.staging_mut(identity, malformed, &mut staging),
        Err(CommittedDiscReadError::DescriptorMismatch { .. })
    ));
    assert_eq!(reader.request(), Some(request));

    let start = request.container_offset as usize;
    reader
        .staging_mut(identity, request, &mut staging)
        .unwrap()
        .copy_from_slice(&iso[start..start + request.length as usize]);
    assert_eq!(
        reader.complete(identity, request, request.length),
        Ok(CommittedDiscReadProgress::Ready(identity))
    );
    assert!(matches!(
        reader.complete(identity, request, request.length),
        Err(CommittedDiscReadError::StaleRequest { .. })
    ));

    let next_identity = LogicalReadIdentity { id: 10, ..identity };
    let CommittedDiscReadProgress::HostRead(next) =
        reader.begin(next_identity, &mut staging).unwrap()
    else {
        panic!("raw read must issue one host request");
    };
    assert_eq!(
        reader.complete(next_identity, next, next.length - 1),
        Err(CommittedDiscReadError::ShortRead {
            request: next,
            written: next.length - 1,
        })
    );
    assert!(reader.active_identity().is_none());
}

#[test]
fn committed_reader_synthesizes_fully_sparse_ciso_windows_without_host_work() {
    let iso = valid_iso();
    let ciso = ciso_from_sparse_logical(&iso, 0x200);
    let mut reader = committed_reader(&ciso, true);
    let identity = LogicalReadIdentity {
        epoch: 0x4449,
        id: 11,
        logical_offset: 0x2600,
        length: 0x800,
    };
    assert!(iso[0x2600..0x2e00].iter().all(|byte| *byte == 0));
    let mut staging = vec![0xcc; identity.length as usize];
    assert_eq!(
        reader.begin(identity, &mut staging),
        Ok(CommittedDiscReadProgress::Ready(identity))
    );
    assert!(staging.iter().all(|byte| *byte == 0));
    assert!(reader.request().is_none());
}

#[test]
fn completion_identity_duplicate_and_short_read_are_fail_closed() {
    let iso = valid_iso();
    let mut executor = ready_reader(&iso, false).into_load_executor(0x200).unwrap();
    let mut bytes = vec![0x5a; MEM1_BYTES];
    let mut mem1 = BootMem1Slice::new(&mut bytes);
    executor.advance(&mut mem1).unwrap();
    let request = executor.requests().next().unwrap();
    let wrong_epoch = ReadRequest {
        epoch: request.epoch + 1,
        ..request
    };
    assert!(matches!(
        executor.complete(wrong_epoch, wrong_epoch.length, &mut mem1),
        Err(BootLoadCompletionError::Read(
            ReadCompletionError::DescriptorMismatch { .. }
        ))
    ));
    let wrong = ReadRequest {
        container_offset: request.container_offset + 1,
        ..request
    };
    assert!(matches!(
        executor.staging_mut(wrong),
        Err(ReadCompletionError::DescriptorMismatch { .. })
    ));
    assert!(matches!(
        executor.complete(wrong, wrong.length, &mut mem1),
        Err(BootLoadCompletionError::Read(
            ReadCompletionError::DescriptorMismatch { .. }
        ))
    ));
    assert_eq!(executor.requests().next(), Some(request));

    let start = request.container_offset as usize;
    executor
        .staging_mut(request)
        .unwrap()
        .copy_from_slice(&iso[start..start + request.length as usize]);
    executor
        .complete(request, request.length, &mut mem1)
        .unwrap();
    assert!(matches!(
        executor.complete(request, request.length, &mut mem1),
        Err(BootLoadCompletionError::Read(
            ReadCompletionError::StaleRequest { .. }
        ))
    ));

    let short = executor.requests().next().unwrap();
    assert_eq!(
        executor.complete(short, short.length - 1, &mut mem1),
        Err(BootLoadCompletionError::Read(
            ReadCompletionError::ShortRead {
                request: short,
                written: short.length - 1,
            }
        ))
    );
    assert_eq!(executor.stage(), BootLoadExecutorStage::Failed);
    assert_eq!(
        executor.failure(),
        Some(&BootLoadError::ShortRead {
            request: short,
            written: short.length - 1,
        })
    );
    assert!(executor.commit().is_none());
    assert_eq!(executor.requests().len(), 0);
    assert!(matches!(
        executor.complete(short, short.length, &mut mem1),
        Err(BootLoadCompletionError::Read(
            ReadCompletionError::StaleRequest { .. }
        ))
    ));
}

#[test]
fn cancellation_retires_pending_requests_without_writing_mem1() {
    let iso = valid_iso();
    let mut executor = ready_reader(&iso, false).into_load_executor(0x400).unwrap();
    let mut bytes = vec![0x5a; MEM1_BYTES];
    let mut mem1 = BootMem1Slice::new(&mut bytes);
    executor.advance(&mut mem1).unwrap();
    let request = executor.requests().next().unwrap();
    assert!(executor.cancel());
    assert!(!executor.cancel());
    assert_eq!(executor.stage(), BootLoadExecutorStage::Cancelled);
    assert_eq!(executor.requests().len(), 0);
    assert!(matches!(
        executor.complete(request, request.length, &mut mem1),
        Err(BootLoadCompletionError::Read(
            ReadCompletionError::StaleRequest { .. }
        ))
    ));
    assert!(mem1.as_slice().iter().all(|byte| *byte == 0x5a));
}

#[derive(Debug)]
struct FaultingMem1 {
    bytes: Vec<u8>,
    fail_writes: bool,
}

impl BootMem1 for FaultingMem1 {
    fn length(&self) -> u32 {
        self.bytes.len() as u32
    }

    fn write_exact(&mut self, offset: u32, bytes: &[u8]) -> Result<(), BootMem1Error> {
        if self.fail_writes {
            return Err(BootMem1Error::Fault);
        }
        let start = offset as usize;
        self.bytes[start..start + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }

    fn zero_exact(&mut self, offset: u32, length: u32) -> Result<(), BootMem1Error> {
        let start = offset as usize;
        self.bytes[start..start + length as usize].fill(0);
        Ok(())
    }
}

#[test]
fn mem1_bounds_and_faults_are_terminal_before_boot_commit() {
    let iso = valid_iso();
    let mut too_small = ready_reader(&iso, false).into_load_executor(0x400).unwrap();
    let mut short_bytes = [0; 128];
    let mut short_mem1 = BootMem1Slice::new(&mut short_bytes);
    let error = too_small.advance(&mut short_mem1).unwrap_err();
    assert!(matches!(
        error,
        BootLoadError::PlanMem1RangeOutsideMemory { operation: 0, .. }
    ));
    assert_eq!(too_small.stage(), BootLoadExecutorStage::Failed);
    assert_eq!(too_small.requests().len(), 0);

    let mut executor = ready_reader(&iso, false).into_load_executor(0x400).unwrap();
    let mut memory = FaultingMem1 {
        bytes: vec![0x5a; MEM1_BYTES],
        fail_writes: true,
    };
    executor.advance(&mut memory).unwrap();
    let request = executor.requests().next().unwrap();
    let start = request.container_offset as usize;
    executor
        .staging_mut(request)
        .unwrap()
        .copy_from_slice(&iso[start..start + request.length as usize]);
    let error = executor
        .complete(request, request.length, &mut memory)
        .unwrap_err();
    assert_eq!(
        error,
        BootLoadCompletionError::Load(BootLoadError::Mem1 {
            operation: 0,
            access: BootMem1Access::Write,
            target: executor.plan().bi2_address,
            length: 0x400,
            error: BootMem1Error::Fault,
        })
    );
    assert_eq!(executor.stage(), BootLoadExecutorStage::Failed);
    assert!(executor.commit().is_none());
}

#[test]
fn overlapping_bss_is_zeroed_before_section_copy_in_plan_order() {
    let mut iso = valid_iso();
    let dol = &mut iso[BOOT_OFFSET..BOOT_OFFSET + 0x100];
    write_be_u32(dol, 0xd8, TEXT_TARGET + 0x100);
    write_be_u32(dol, 0xdc, 0x300);
    let mut executor = ready_reader(&iso, false).into_load_executor(0x80).unwrap();
    let mut bytes = vec![0x5a; MEM1_BYTES];
    let mut mem1 = BootMem1Slice::new(&mut bytes);
    let _ = complete_executor(&mut executor, &iso, &mut mem1, false);

    assert_eq!(
        mem1_range(&mem1, TEXT_TARGET, TEXT_BYTES),
        &iso[BOOT_OFFSET + TEXT_FILE_OFFSET..BOOT_OFFSET + TEXT_FILE_OFFSET + TEXT_BYTES],
        "the later section copy must win over the earlier overlapping BSS clear"
    );
    assert_eq!(
        mem1_range(&mem1, TEXT_TARGET + TEXT_BYTES as u32, 0xfb),
        vec![0; 0xfb],
        "the BSS tail outside the initialized section must remain zero"
    );
}

#[test]
fn invalid_chunk_bound_and_non_ready_reader_are_rejected_in_rust() {
    let iso = valid_iso();
    assert_eq!(
        ready_reader(&iso, false).into_load_executor(0).unwrap_err(),
        BootLoadStartError::InvalidChunkBytes {
            requested: 0,
            maximum: MAX_BOOT_LOAD_CHUNK_BYTES,
        }
    );
    assert_eq!(
        ready_reader(&iso, false)
            .into_load_executor(MAX_BOOT_LOAD_CHUNK_BYTES + 1)
            .unwrap_err(),
        BootLoadStartError::InvalidChunkBytes {
            requested: MAX_BOOT_LOAD_CHUNK_BYTES + 1,
            maximum: MAX_BOOT_LOAD_CHUNK_BYTES,
        }
    );
    let reader = DiscBootReader::new(iso.len() as u64, EPOCH).unwrap();
    assert_eq!(
        reader.into_load_executor(0x1000).unwrap_err(),
        BootLoadStartError::ReaderNotReady {
            stage: BootReaderStage::ContainerHeader,
            failure: None,
        }
    );
}
