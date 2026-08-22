//! Pull-driven, host-neutral GameCube disc boot planning.
//!
//! The browser owns asynchronous file and network APIs, but it does not own disc format or boot
//! policy. [`DiscBootReader`] issues exact physical byte ranges through [`ExactReadAt`], accepts
//! completions only once and only under their complete Rust-issued identity, expands sparse CISO
//! blocks into logical zeroes, and produces a validated [`BootLoadPlan`]. The plan deliberately
//! contains ranges instead of a whole DOL so a resident machine can stream sections into MEM1.
//! A ready reader can then be consumed by [`BootLoadExecutor`], which retains the format map and
//! exact-read identity space while applying the plan through a narrow Rust-owned MEM1 boundary.

use std::collections::BTreeMap;

mod executor;

pub use executor::{
    BootCommitRecord, BootLoadCompletionError, BootLoadError, BootLoadExecutor,
    BootLoadExecutorStage, BootLoadStartError, BootMem1, BootMem1Access, BootMem1Error,
    BootMem1Slice, CommittedBoot, CommittedDiscReadError, CommittedDiscReadProgress,
    CommittedDiscReader, LogicalReadIdentity, MAX_BOOT_LOAD_CHUNK_BYTES,
    MAX_COMMITTED_DISC_READ_BYTES,
};

/// Size of the fixed CISO header and allocation bitmap.
pub const CISO_HEADER_BYTES: u32 = 0x8000;
/// Maximum logical size of a retail GameCube optical disc.
pub const GAMECUBE_DISC_BYTES: u64 = 0x5705_8000;
/// Maximum accepted DOL span, matching the browser boot safety limit.
pub const MAX_DOL_BYTES: u32 = 32 * 1024 * 1024;

const CISO_MAP_OFFSET: usize = 8;
const CISO_MAP_ENTRIES: usize = CISO_HEADER_BYTES as usize - CISO_MAP_OFFSET;
const DISC_HEADER_BYTES: u32 = 0x440;
const BI2_DISC_OFFSET: u64 = 0x440;
const BI2_BYTES: u32 = 0x2000;
const DOL_HEADER_BYTES: u32 = 0x100;
const GAMECUBE_MAGIC: u32 = 0xc233_9f3d;
const MEM1_BASE: u32 = 0x8000_0000;
const MEM1_UNCACHED_BASE: u32 = 0xc000_0000;
const MEM1_BYTES: u32 = 24 * 1024 * 1024;
const MEM1_END: u32 = MEM1_BASE + MEM1_BYTES;
const BOOT_LOW_MEMORY_END: u32 = MEM1_BASE + 0x100;
const ABSENT_CISO_BLOCK: u16 = u16::MAX;

const _: () = assert!(CISO_MAP_ENTRIES < ABSENT_CISO_BLOCK as usize);

/// The complete identity of one host-visible read request.
///
/// `epoch` prevents an old browser completion from matching a later boot attempt. The Rust owner
/// of the state machine chooses a fresh epoch; the host must echo all four fields exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(C)]
pub struct ReadRequest {
    pub epoch: u64,
    pub id: u64,
    pub container_offset: u64,
    pub length: u32,
}

#[derive(Debug)]
struct StagedRead {
    request: ReadRequest,
    tag: u32,
    bytes: Vec<u8>,
}

/// A completed exact read, returned to the Rust consumer rather than interpreted by the host.
#[derive(Debug, PartialEq, Eq)]
pub struct CompletedRead {
    pub request: ReadRequest,
    pub tag: u32,
    pub bytes: Vec<u8>,
}

/// Request/completion protocol failures. Identity failures leave the live request untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadCompletionError {
    UnknownRequest {
        id: u64,
    },
    StaleRequest {
        id: u64,
    },
    DescriptorMismatch {
        expected: ReadRequest,
        received: ReadRequest,
    },
    ShortRead {
        request: ReadRequest,
        written: u32,
    },
}

/// A small reusable bridge between a Rust state machine and an asynchronous host `readAt` API.
///
/// Every request owns its staging allocation. A successful completion removes it before returning
/// its bytes, which makes duplicate completion impossible even if host promises settle twice.
#[derive(Debug)]
pub struct ExactReadAt {
    epoch: u64,
    next_id: u64,
    pending: BTreeMap<u64, StagedRead>,
}

impl ExactReadAt {
    pub fn new(epoch: u64) -> Self {
        Self {
            epoch,
            next_id: 1,
            pending: BTreeMap::new(),
        }
    }

    /// Issues one exact physical container range and allocates its Rust-owned staging bytes.
    pub fn issue(&mut self, container_offset: u64, length: u32, tag: u32) -> Option<ReadRequest> {
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1)?;
        let request = ReadRequest {
            epoch: self.epoch,
            id,
            container_offset,
            length,
        };
        let bytes = vec![0; length as usize];
        let previous = self.pending.insert(
            id,
            StagedRead {
                request,
                tag,
                bytes,
            },
        );
        debug_assert!(previous.is_none());
        Some(request)
    }

    pub fn requests(&self) -> impl ExactSizeIterator<Item = ReadRequest> + '_ {
        self.pending.values().map(|pending| pending.request)
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Returns the Rust-owned destination only when the full request identity matches.
    pub fn staging_mut(&mut self, request: ReadRequest) -> Result<&mut [u8], ReadCompletionError> {
        let pending = self.lookup(request)?;
        Ok(&mut pending.bytes)
    }

    /// Consumes a request exactly once. A short read is terminal for that request.
    pub fn complete(
        &mut self,
        request: ReadRequest,
        written: u32,
    ) -> Result<CompletedRead, ReadCompletionError> {
        self.validate(request)?;
        let pending = self
            .pending
            .remove(&request.id)
            .expect("a validated read request must still be pending");
        if written != request.length {
            return Err(ReadCompletionError::ShortRead { request, written });
        }
        Ok(CompletedRead {
            request,
            tag: pending.tag,
            bytes: pending.bytes,
        })
    }

    pub fn cancel_all(&mut self) {
        self.pending.clear();
    }

    /// Retires an idle staged-reader while preserving its never-reused request identity cursor.
    ///
    /// The committed-disc reader uses this when ownership of the authenticated image map moves
    /// out of the boot executor. Keeping the cursor prevents a late boot completion from ever
    /// matching a post-boot physical read under the same epoch.
    fn into_request_cursor(self) -> Option<(u64, u64)> {
        self.pending
            .is_empty()
            .then_some((self.epoch, self.next_id))
    }

    fn lookup(&mut self, request: ReadRequest) -> Result<&mut StagedRead, ReadCompletionError> {
        self.validate(request)?;
        Ok(self
            .pending
            .get_mut(&request.id)
            .expect("a validated read request must still be pending"))
    }

    fn validate(&self, request: ReadRequest) -> Result<(), ReadCompletionError> {
        let Some(pending) = self.pending.get(&request.id) else {
            return Err(if request.id < self.next_id {
                ReadCompletionError::StaleRequest { id: request.id }
            } else {
                ReadCompletionError::UnknownRequest { id: request.id }
            });
        };
        if pending.request != request {
            return Err(ReadCompletionError::DescriptorMismatch {
                expected: pending.request,
                received: request,
            });
        }
        Ok(())
    }
}

/// High-level stage of the pull-driven boot reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootReaderStage {
    ContainerHeader,
    DiscHeader,
    DolHeader,
    Ready,
    Failed,
}

/// Validated physical container format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscFormat {
    RawIso {
        logical_bytes: u64,
    },
    Ciso {
        logical_bytes: u64,
        block_bytes: u32,
        present_blocks: u32,
    },
}

impl DiscFormat {
    pub fn logical_bytes(self) -> u64 {
        match self {
            Self::RawIso { logical_bytes } | Self::Ciso { logical_bytes, .. } => logical_bytes,
        }
    }
}

/// Identity and boot flags parsed from the authenticated GameCube disc header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscIdentity {
    pub game_code: u32,
    pub identifier: [u8; 6],
    pub title: String,
    pub label: String,
    pub maker_code: u16,
    pub disc_id: u8,
    pub version: u8,
    pub audio_streaming: u8,
    pub stream_buffer_size: u8,
    pub tv_mode: u32,
}

/// Semantic purpose of one load-plan copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootCopyKind {
    Bi2,
    DolText(u8),
    DolData(u8),
    Fst,
}

/// One exact logical-disc copy or MEM1 clear owned by the Rust load plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootLoadOperation {
    Copy {
        kind: BootCopyKind,
        disc_offset: u64,
        mem1_target: u32,
        length: u32,
    },
    Zero {
        mem1_target: u32,
        length: u32,
    },
}

/// A fully validated, streaming boot plan. It never contains the complete disc or DOL body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootLoadPlan {
    pub format: DiscFormat,
    pub identity: DiscIdentity,
    pub dol_disc_offset: u64,
    pub dol_bytes: u32,
    pub entry: u32,
    pub canonical_entry: u32,
    pub bi2_address: u32,
    pub fst_address: u32,
    pub fst_bytes: u32,
    /// Raw maximum FST size written to low-memory boot metadata.
    pub fst_max_bytes: u32,
    /// Thirty-two-byte-aligned amount reserved at the top of MEM1.
    pub fst_reserved_bytes: u32,
    pub operations: Vec<BootLoadOperation>,
}

/// A structural or bounds failure found entirely by Rust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootError {
    ContainerTooSmall {
        required: u64,
        available: u64,
    },
    RequestIdExhausted,
    InvalidCisoBlockSize(u32),
    CisoPhysicalSizeOverflow,
    TruncatedCiso {
        required: u64,
        available: u64,
    },
    LogicalRangeOutsideImage {
        offset: u64,
        length: u32,
        logical_bytes: u64,
    },
    InvalidDiscMagic(u32),
    FstTooSmall(u32),
    FstExceedsMem1(u32),
    BootDataDoesNotFitMem1,
    DiscRangeOutsideImage {
        name: &'static str,
        offset: u64,
        length: u32,
        logical_bytes: u64,
    },
    DolSectionFileOffset {
        section: u8,
        offset: u32,
    },
    DolSectionFileRangeOverflow {
        section: u8,
    },
    DolExceedsBootLimit {
        section: u8,
        end: u32,
    },
    DolSectionOutsideMem1 {
        section: u8,
        target: u32,
        length: u32,
    },
    DolSectionFileOverlap {
        first: u8,
        second: u8,
    },
    DolSectionMemoryOverlap {
        first: u8,
        second: u8,
    },
    DolBssOutsideMem1 {
        target: u32,
        length: u32,
    },
    DolEntrypointOutsideMem1(u32),
    BootDataOverlapsDolSection {
        section: u8,
    },
    BootDataOverlapsDolBss,
    LowMemoryOverlapsDolSection {
        section: u8,
    },
    LowMemoryOverlapsDolBss,
    ShortRead {
        request: ReadRequest,
        written: u32,
    },
}

#[derive(Debug)]
enum ImageMap {
    Raw {
        logical_bytes: u64,
    },
    Ciso {
        logical_bytes: u64,
        block_bytes: u32,
        present_ordinals: Vec<u16>,
        present_blocks: u32,
    },
}

impl ImageMap {
    fn format(&self) -> DiscFormat {
        match self {
            Self::Raw { logical_bytes } => DiscFormat::RawIso {
                logical_bytes: *logical_bytes,
            },
            Self::Ciso {
                logical_bytes,
                block_bytes,
                present_blocks,
                ..
            } => DiscFormat::Ciso {
                logical_bytes: *logical_bytes,
                block_bytes: *block_bytes,
                present_blocks: *present_blocks,
            },
        }
    }

    fn logical_bytes(&self) -> u64 {
        self.format().logical_bytes()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadPurpose {
    Container,
    Disc,
    Dol,
}

#[derive(Debug)]
struct ActiveLogicalRead {
    purpose: ReadPurpose,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct PartialBoot {
    identity: DiscIdentity,
    boot_offset: u64,
    fst_offset: u64,
    fst_bytes: u32,
    fst_max_bytes: u32,
    fst_reserved_bytes: u32,
    bi2_address: u32,
    fst_address: u32,
}

#[derive(Debug, Clone, Copy)]
struct DolSection {
    index: u8,
    file_offset: u32,
    memory: MemoryRange,
    length: u32,
}

#[derive(Debug, Clone, Copy)]
struct MemoryRange {
    start: u32,
    end: u32,
}

impl MemoryRange {
    fn overlaps(self, other: Self) -> bool {
        self.start < other.end && other.start < self.end
    }
}

#[derive(Debug)]
struct DolLayout {
    sections: Vec<DolSection>,
    bss: Option<MemoryRange>,
    bss_length: u32,
    dol_bytes: u32,
    entry: u32,
    canonical_entry: u32,
}

/// Stateful Rust parser that emits physical reads and finishes with a streaming load plan.
#[derive(Debug)]
pub struct DiscBootReader {
    container_bytes: u64,
    stage: BootReaderStage,
    reads: ExactReadAt,
    active: Option<ActiveLogicalRead>,
    image: Option<ImageMap>,
    partial: Option<PartialBoot>,
    plan: Option<BootLoadPlan>,
    failure: Option<BootError>,
}

impl DiscBootReader {
    /// Starts a new boot parse. `request_epoch` must be minted by the Rust machine owner and changed
    /// before beginning another boot against the same host adapter.
    pub fn new(container_bytes: u64, request_epoch: u64) -> Result<Self, BootError> {
        if container_bytes < u64::from(CISO_HEADER_BYTES) {
            return Err(BootError::ContainerTooSmall {
                required: u64::from(CISO_HEADER_BYTES),
                available: container_bytes,
            });
        }
        let mut reader = Self {
            container_bytes,
            stage: BootReaderStage::ContainerHeader,
            reads: ExactReadAt::new(request_epoch),
            active: Some(ActiveLogicalRead {
                purpose: ReadPurpose::Container,
                bytes: vec![0; CISO_HEADER_BYTES as usize],
            }),
            image: None,
            partial: None,
            plan: None,
            failure: None,
        };
        reader.issue_physical(0, CISO_HEADER_BYTES, 0)?;
        Ok(reader)
    }

    pub fn stage(&self) -> BootReaderStage {
        self.stage
    }

    pub fn requests(&self) -> impl ExactSizeIterator<Item = ReadRequest> + '_ {
        self.reads.requests()
    }

    pub fn staging_mut(&mut self, request: ReadRequest) -> Result<&mut [u8], ReadCompletionError> {
        self.reads.staging_mut(request)
    }

    /// Completes a host range. Identity errors preserve the pending request; short reads consume it
    /// and permanently fail this boot attempt.
    pub fn complete(
        &mut self,
        request: ReadRequest,
        written: u32,
    ) -> Result<(), ReadCompletionError> {
        let completed = match self.reads.complete(request, written) {
            Ok(completed) => completed,
            Err(error @ ReadCompletionError::ShortRead { request, written }) => {
                self.fail(BootError::ShortRead { request, written });
                return Err(error);
            }
            Err(error) => return Err(error),
        };

        let Some(active) = self.active.as_mut() else {
            // All issued requests are cancelled on Ready/Failed. Reaching this branch would be an
            // internal state-machine bug, not a condition the host can produce.
            unreachable!("a completed boot read must have an active logical destination");
        };
        let start = completed.tag as usize;
        let end = start + completed.bytes.len();
        active.bytes[start..end].copy_from_slice(&completed.bytes);

        if self.reads.pending_count() == 0 {
            self.finish_active();
        }
        Ok(())
    }

    pub fn plan(&self) -> Option<&BootLoadPlan> {
        self.plan.as_ref()
    }

    pub fn failure(&self) -> Option<&BootError> {
        self.failure.as_ref()
    }

    fn finish_active(&mut self) {
        let active = self
            .active
            .take()
            .expect("finishing boot bytes requires an active logical read");
        let result = match active.purpose {
            ReadPurpose::Container => self.parse_container_header(&active.bytes),
            ReadPurpose::Disc => self.parse_disc_header(&active.bytes),
            ReadPurpose::Dol => self.parse_dol_header(&active.bytes),
        };
        if let Err(error) = result {
            self.fail(error);
        }
    }

    fn parse_container_header(&mut self, bytes: &[u8]) -> Result<(), BootError> {
        if bytes.starts_with(b"CISO") {
            self.image = Some(parse_ciso(bytes, self.container_bytes)?);
            self.stage = BootReaderStage::DiscHeader;
            self.start_logical(ReadPurpose::Disc, 0, DISC_HEADER_BYTES)
        } else {
            self.image = Some(ImageMap::Raw {
                logical_bytes: self.container_bytes,
            });
            // The format probe is already the first 32 KiB of a raw ISO; reuse it instead of
            // asking the asynchronous host for a duplicate 1,088-byte disc header.
            self.stage = BootReaderStage::DiscHeader;
            self.parse_disc_header(&bytes[..DISC_HEADER_BYTES as usize])
        }
    }

    fn parse_disc_header(&mut self, bytes: &[u8]) -> Result<(), BootError> {
        let magic = be_u32(bytes, 0x1c);
        if magic != GAMECUBE_MAGIC {
            return Err(BootError::InvalidDiscMagic(magic));
        }

        let boot_offset = u64::from(be_u32(bytes, 0x420));
        let fst_offset = u64::from(be_u32(bytes, 0x424));
        let fst_bytes = be_u32(bytes, 0x428);
        let fst_max_bytes = fst_bytes.max(be_u32(bytes, 0x42c));
        if fst_bytes < 12 {
            return Err(BootError::FstTooSmall(fst_bytes));
        }
        if fst_bytes > MEM1_BYTES || fst_max_bytes > MEM1_BYTES {
            return Err(BootError::FstExceedsMem1(fst_max_bytes));
        }
        let fst_reserved_bytes = fst_max_bytes
            .checked_add(31)
            .ok_or(BootError::BootDataDoesNotFitMem1)?
            & !31;
        let fst_address = MEM1_END
            .checked_sub(fst_reserved_bytes)
            .ok_or(BootError::BootDataDoesNotFitMem1)?;
        let bi2_address = fst_address
            .checked_sub(BI2_BYTES)
            .filter(|address| *address >= MEM1_BASE)
            .ok_or(BootError::BootDataDoesNotFitMem1)?;

        let logical_bytes = self
            .image
            .as_ref()
            .expect("a disc header is parsed only after its container")
            .logical_bytes();
        validate_disc_range("BI2", BI2_DISC_OFFSET, BI2_BYTES, logical_bytes)?;
        validate_disc_range("DOL header", boot_offset, DOL_HEADER_BYTES, logical_bytes)?;
        validate_disc_range("FST", fst_offset, fst_bytes, logical_bytes)?;

        let identifier: [u8; 6] = bytes[..6]
            .try_into()
            .expect("the fixed disc header always contains an identifier");
        let title_end = bytes[0x20..0x400]
            .iter()
            .position(|byte| *byte == 0)
            .map_or(0x400, |offset| 0x20 + offset);
        let title = String::from_utf8_lossy(&bytes[0x20..title_end])
            .trim()
            .to_owned();
        let version = bytes[7];
        let identifier_text = String::from_utf8_lossy(&identifier);
        let revision = format!("Rev.{version:02}");
        let label = if title.is_empty() {
            format!("{identifier_text} {revision}")
        } else {
            format!("{title} ({identifier_text} {revision})")
        };
        self.partial = Some(PartialBoot {
            identity: DiscIdentity {
                game_code: be_u32(bytes, 0),
                identifier,
                title,
                label,
                maker_code: be_u16(bytes, 4),
                disc_id: bytes[6],
                version,
                audio_streaming: bytes[8],
                stream_buffer_size: bytes[9],
                tv_mode: u32::from(bytes[3] == b'P'),
            },
            boot_offset,
            fst_offset,
            fst_bytes,
            fst_max_bytes,
            fst_reserved_bytes,
            bi2_address,
            fst_address,
        });

        self.stage = BootReaderStage::DolHeader;
        self.start_logical(ReadPurpose::Dol, boot_offset, DOL_HEADER_BYTES)
    }

    fn parse_dol_header(&mut self, bytes: &[u8]) -> Result<(), BootError> {
        let partial = self
            .partial
            .take()
            .expect("a DOL header is parsed only after the disc header");
        let layout = parse_dol_layout(bytes)?;
        let logical_bytes = self
            .image
            .as_ref()
            .expect("a DOL header is parsed only after its container")
            .logical_bytes();
        validate_disc_range("DOL", partial.boot_offset, layout.dol_bytes, logical_bytes)?;

        let boot_memory = MemoryRange {
            start: partial.bi2_address,
            end: MEM1_END,
        };
        let low_memory = MemoryRange {
            start: MEM1_BASE,
            end: BOOT_LOW_MEMORY_END,
        };
        for section in &layout.sections {
            if section.memory.overlaps(boot_memory) {
                return Err(BootError::BootDataOverlapsDolSection {
                    section: section.index,
                });
            }
            if section.memory.overlaps(low_memory) {
                return Err(BootError::LowMemoryOverlapsDolSection {
                    section: section.index,
                });
            }
        }
        if layout.bss.is_some_and(|bss| bss.overlaps(boot_memory)) {
            return Err(BootError::BootDataOverlapsDolBss);
        }
        if layout.bss.is_some_and(|bss| bss.overlaps(low_memory)) {
            return Err(BootError::LowMemoryOverlapsDolBss);
        }

        let mut operations = Vec::with_capacity(layout.sections.len() + 3);
        operations.push(BootLoadOperation::Copy {
            kind: BootCopyKind::Bi2,
            disc_offset: BI2_DISC_OFFSET,
            mem1_target: partial.bi2_address,
            length: BI2_BYTES,
        });
        operations.push(BootLoadOperation::Copy {
            kind: BootCopyKind::Fst,
            disc_offset: partial.fst_offset,
            mem1_target: partial.fst_address,
            length: partial.fst_bytes,
        });
        // Match the retail/native loader contract: clear BSS first, then let initialized text or
        // data sections overwrite any intentional overlap.
        if let Some(bss) = layout.bss {
            operations.push(BootLoadOperation::Zero {
                mem1_target: bss.start,
                length: layout.bss_length,
            });
        }
        for section in &layout.sections {
            let kind = if section.index < 7 {
                BootCopyKind::DolText(section.index)
            } else {
                BootCopyKind::DolData(section.index - 7)
            };
            operations.push(BootLoadOperation::Copy {
                kind,
                disc_offset: partial.boot_offset + u64::from(section.file_offset),
                mem1_target: section.memory.start,
                length: section.length,
            });
        }

        self.plan = Some(BootLoadPlan {
            format: self
                .image
                .as_ref()
                .expect("a ready plan retains its validated container")
                .format(),
            identity: partial.identity,
            dol_disc_offset: partial.boot_offset,
            dol_bytes: layout.dol_bytes,
            entry: layout.entry,
            canonical_entry: layout.canonical_entry,
            bi2_address: partial.bi2_address,
            fst_address: partial.fst_address,
            fst_bytes: partial.fst_bytes,
            fst_max_bytes: partial.fst_max_bytes,
            fst_reserved_bytes: partial.fst_reserved_bytes,
            operations,
        });
        self.stage = BootReaderStage::Ready;
        Ok(())
    }

    fn start_logical(
        &mut self,
        purpose: ReadPurpose,
        logical_offset: u64,
        length: u32,
    ) -> Result<(), BootError> {
        let image = self
            .image
            .as_ref()
            .expect("logical disc reads require a parsed image map");
        let logical_bytes = image.logical_bytes();
        if logical_offset > logical_bytes
            || u64::from(length) > logical_bytes.saturating_sub(logical_offset)
        {
            return Err(BootError::LogicalRangeOutsideImage {
                offset: logical_offset,
                length,
                logical_bytes,
            });
        }

        let runs = physical_runs(image, logical_offset, length);
        self.active = Some(ActiveLogicalRead {
            purpose,
            bytes: vec![0; length as usize],
        });
        for run in runs {
            self.issue_physical(run.container_offset, run.length, run.output_offset)?;
        }
        if self.reads.pending_count() == 0 {
            self.finish_active();
        }
        Ok(())
    }

    fn issue_physical(
        &mut self,
        container_offset: u64,
        length: u32,
        output_offset: u32,
    ) -> Result<(), BootError> {
        self.reads
            .issue(container_offset, length, output_offset)
            .ok_or(BootError::RequestIdExhausted)?;
        Ok(())
    }

    fn fail(&mut self, error: BootError) {
        self.reads.cancel_all();
        self.active = None;
        self.partial = None;
        self.plan = None;
        self.failure = Some(error);
        self.stage = BootReaderStage::Failed;
    }
}

#[derive(Debug, Clone, Copy)]
struct PhysicalRun {
    container_offset: u64,
    output_offset: u32,
    length: u32,
}

fn physical_runs(image: &ImageMap, logical_offset: u64, length: u32) -> Vec<PhysicalRun> {
    if length == 0 {
        return Vec::new();
    }
    if matches!(image, ImageMap::Raw { .. }) {
        return vec![PhysicalRun {
            container_offset: logical_offset,
            output_offset: 0,
            length,
        }];
    }

    let ImageMap::Ciso {
        block_bytes,
        present_ordinals,
        ..
    } = image
    else {
        unreachable!();
    };
    let block_bytes_u64 = u64::from(*block_bytes);
    let mut runs = Vec::new();
    let mut written = 0_u64;
    while written < u64::from(length) {
        let logical_position = logical_offset + written;
        let block = (logical_position / block_bytes_u64) as usize;
        let within = logical_position % block_bytes_u64;
        let first_length = (u64::from(length) - written).min(block_bytes_u64 - within);
        let present_ordinal = present_ordinals[block];
        if present_ordinal == ABSENT_CISO_BLOCK {
            written += first_length;
            continue;
        }
        let physical = ciso_physical_offset(present_ordinal, *block_bytes)
            .expect("validated CISO ordinals and block size have a physical offset");

        let mut run_length = first_length;
        let mut next_block = block + 1;
        while written + run_length < u64::from(length) && next_block < present_ordinals.len() {
            let expected_ordinal =
                u32::from(present_ordinal) + u32::try_from(next_block - block).unwrap();
            if u32::from(present_ordinals[next_block]) != expected_ordinal {
                break;
            }
            let next_length = (u64::from(length) - written - run_length).min(block_bytes_u64);
            run_length += next_length;
            if next_length < block_bytes_u64 {
                break;
            }
            next_block += 1;
        }
        runs.push(PhysicalRun {
            container_offset: physical + within,
            output_offset: written as u32,
            length: run_length as u32,
        });
        written += run_length;
    }
    runs
}

fn parse_ciso(header: &[u8], container_bytes: u64) -> Result<ImageMap, BootError> {
    let block_bytes = u32::from_le_bytes(
        header[4..8]
            .try_into()
            .expect("the fixed CISO header contains its block size"),
    );
    if block_bytes == 0 || block_bytes & 31 != 0 {
        return Err(BootError::InvalidCisoBlockSize(block_bytes));
    }

    let mut present_ordinals = Vec::with_capacity(CISO_MAP_ENTRIES);
    let mut present_blocks = 0_u32;
    for value in header[CISO_MAP_OFFSET..].iter().copied() {
        match value {
            0 => present_ordinals.push(ABSENT_CISO_BLOCK),
            _ => {
                let ordinal = u16::try_from(present_blocks)
                    .map_err(|_| BootError::CisoPhysicalSizeOverflow)?;
                present_ordinals.push(ordinal);
                present_blocks += 1;
            }
        }
    }
    let required_physical =
        checked_ciso_physical_offset(u64::from(present_blocks), u64::from(block_bytes))
            .ok_or(BootError::CisoPhysicalSizeOverflow)?;
    if required_physical > container_bytes {
        return Err(BootError::TruncatedCiso {
            required: required_physical,
            available: container_bytes,
        });
    }
    let logical_bytes = GAMECUBE_DISC_BYTES.min(
        u64::from(block_bytes)
            .checked_mul(CISO_MAP_ENTRIES as u64)
            .ok_or(BootError::CisoPhysicalSizeOverflow)?,
    );
    Ok(ImageMap::Ciso {
        logical_bytes,
        block_bytes,
        present_ordinals,
        present_blocks,
    })
}

fn ciso_physical_offset(present_ordinal: u16, block_bytes: u32) -> Option<u64> {
    (present_ordinal != ABSENT_CISO_BLOCK)
        .then_some(())
        .and_then(|()| {
            checked_ciso_physical_offset(u64::from(present_ordinal), u64::from(block_bytes))
        })
}

fn checked_ciso_physical_offset(present_ordinal: u64, block_bytes: u64) -> Option<u64> {
    present_ordinal
        .checked_mul(block_bytes)
        .and_then(|bytes| u64::from(CISO_HEADER_BYTES).checked_add(bytes))
}

fn validate_disc_range(
    name: &'static str,
    offset: u64,
    length: u32,
    logical_bytes: u64,
) -> Result<(), BootError> {
    if offset > logical_bytes || u64::from(length) > logical_bytes.saturating_sub(offset) {
        return Err(BootError::DiscRangeOutsideImage {
            name,
            offset,
            length,
            logical_bytes,
        });
    }
    Ok(())
}

fn parse_dol_layout(header: &[u8]) -> Result<DolLayout, BootError> {
    debug_assert_eq!(header.len(), DOL_HEADER_BYTES as usize);
    let mut sections = Vec::with_capacity(18);
    let mut dol_bytes = DOL_HEADER_BYTES;
    for index in 0..18_u8 {
        let index_usize = index as usize;
        let file_offset = be_u32(header, index_usize * 4);
        let target = be_u32(header, 0x48 + index_usize * 4);
        let length = be_u32(header, 0x90 + index_usize * 4);
        if length == 0 {
            continue;
        }
        if file_offset < DOL_HEADER_BYTES {
            return Err(BootError::DolSectionFileOffset {
                section: index,
                offset: file_offset,
            });
        }
        let file_end = file_offset
            .checked_add(length)
            .ok_or(BootError::DolSectionFileRangeOverflow { section: index })?;
        if file_end > MAX_DOL_BYTES {
            return Err(BootError::DolExceedsBootLimit {
                section: index,
                end: file_end,
            });
        }
        let memory =
            canonical_mem1_range(target, length).ok_or(BootError::DolSectionOutsideMem1 {
                section: index,
                target,
                length,
            })?;
        sections.push(DolSection {
            index,
            file_offset,
            memory,
            length,
        });
        dol_bytes = dol_bytes.max(file_end);
    }

    for (left_index, left) in sections.iter().enumerate() {
        for right in &sections[left_index + 1..] {
            let left_file_end = left.file_offset + left.length;
            let right_file_end = right.file_offset + right.length;
            if left.file_offset < right_file_end && right.file_offset < left_file_end {
                return Err(BootError::DolSectionFileOverlap {
                    first: left.index,
                    second: right.index,
                });
            }
            if left.memory.overlaps(right.memory) {
                return Err(BootError::DolSectionMemoryOverlap {
                    first: left.index,
                    second: right.index,
                });
            }
        }
    }

    let bss_target = be_u32(header, 0xd8);
    let bss_length = be_u32(header, 0xdc);
    let bss = if bss_length == 0 {
        None
    } else {
        let bss =
            canonical_mem1_range(bss_target, bss_length).ok_or(BootError::DolBssOutsideMem1 {
                target: bss_target,
                length: bss_length,
            })?;
        Some(bss)
    };

    let entry = be_u32(header, 0xe0);
    let canonical_entry = canonical_mem1_range(entry, 4)
        .ok_or(BootError::DolEntrypointOutsideMem1(entry))?
        .start;
    Ok(DolLayout {
        sections,
        bss,
        bss_length,
        dol_bytes,
        entry,
        canonical_entry,
    })
}

fn canonical_mem1_range(target: u32, length: u32) -> Option<MemoryRange> {
    let physical = if (MEM1_BASE..MEM1_END).contains(&target) {
        target - MEM1_BASE
    } else if (MEM1_UNCACHED_BASE..MEM1_UNCACHED_BASE + MEM1_BYTES).contains(&target) {
        target - MEM1_UNCACHED_BASE
    } else {
        return None;
    };
    if length > MEM1_BYTES - physical {
        return None;
    }
    let start = MEM1_BASE + physical;
    Some(MemoryRange {
        start,
        end: start + length,
    })
}

fn be_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("fixed-format read must remain in bounds"),
    )
}

fn be_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed-format read must remain in bounds"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_EPOCH: u64 = 0x1234_5678_9abc_def0;
    const TEST_BOOT_OFFSET: usize = 0x3000;
    const TEST_FST_OFFSET: usize = 0x6000;

    fn write_be_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
    }

    fn valid_iso() -> Vec<u8> {
        let mut image = vec![0; 0x1_0000];
        image[..10].copy_from_slice(b"GZLE01\0\x02\x00\x20");
        image[0x20..0x2b].copy_from_slice(b"Rusty Cube\0");
        write_be_u32(&mut image, 0x1c, GAMECUBE_MAGIC);
        write_be_u32(&mut image, 0x420, TEST_BOOT_OFFSET as u32);
        write_be_u32(&mut image, 0x424, TEST_FST_OFFSET as u32);
        write_be_u32(&mut image, 0x428, 12);
        write_be_u32(&mut image, 0x42c, 32);

        let dol = &mut image[TEST_BOOT_OFFSET..TEST_BOOT_OFFSET + DOL_HEADER_BYTES as usize];
        write_be_u32(dol, 0x00, 0x100);
        write_be_u32(dol, 0x1c, 0x120);
        write_be_u32(dol, 0x48, 0x8000_3100);
        write_be_u32(dol, 0x64, 0xc000_4000);
        write_be_u32(dol, 0x90, 0x20);
        write_be_u32(dol, 0xac, 0x10);
        write_be_u32(dol, 0xd8, 0x8000_5000);
        write_be_u32(dol, 0xdc, 0x20);
        write_be_u32(dol, 0xe0, 0x8000_3100);
        image[TEST_FST_OFFSET..TEST_FST_OFFSET + 12]
            .copy_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        image
    }

    fn ciso_from_sparse_logical(logical: &[u8], block_bytes: usize) -> Vec<u8> {
        assert_eq!(block_bytes & 31, 0);
        let mut header = vec![0; CISO_HEADER_BYTES as usize];
        header[..4].copy_from_slice(b"CISO");
        header[4..8].copy_from_slice(&(block_bytes as u32).to_le_bytes());
        let mut physical = Vec::new();
        for (index, block) in logical.chunks(block_bytes).enumerate() {
            if block.iter().any(|byte| *byte != 0) {
                header[CISO_MAP_OFFSET + index] = 1;
                let mut padded = vec![0; block_bytes];
                padded[..block.len()].copy_from_slice(block);
                physical.extend_from_slice(&padded);
            }
        }
        header.extend(physical);
        header
    }

    fn complete_request(reader: &mut DiscBootReader, source: &[u8], request: ReadRequest) {
        let start = request.container_offset as usize;
        let end = start + request.length as usize;
        reader
            .staging_mut(request)
            .expect("fixture request identity")
            .copy_from_slice(&source[start..end]);
        reader
            .complete(request, request.length)
            .expect("fixture exact completion");
    }

    fn drive_counted(
        mut reader: DiscBootReader,
        source: &[u8],
        reverse_each_wave: bool,
    ) -> (DiscBootReader, u64) {
        let mut physical_bytes = 0_u64;
        while !matches!(
            reader.stage(),
            BootReaderStage::Ready | BootReaderStage::Failed
        ) {
            let mut requests: Vec<_> = reader.requests().collect();
            assert!(!requests.is_empty(), "a waiting reader must expose work");
            if reverse_each_wave {
                requests.reverse();
            }
            for request in requests {
                physical_bytes += u64::from(request.length);
                complete_request(&mut reader, source, request);
            }
        }
        (reader, physical_bytes)
    }

    fn drive(reader: DiscBootReader, source: &[u8], reverse_each_wave: bool) -> DiscBootReader {
        drive_counted(reader, source, reverse_each_wave).0
    }

    fn drive_iso(image: &[u8]) -> DiscBootReader {
        drive(
            DiscBootReader::new(image.len() as u64, TEST_EPOCH).unwrap(),
            image,
            false,
        )
    }

    fn failed_with_dol_mutation(mutate: impl FnOnce(&mut [u8])) -> BootError {
        let mut image = valid_iso();
        mutate(&mut image[TEST_BOOT_OFFSET..TEST_BOOT_OFFSET + DOL_HEADER_BYTES as usize]);
        let reader = drive_iso(&image);
        assert_eq!(reader.stage(), BootReaderStage::Failed);
        reader.failure().unwrap().clone()
    }

    #[test]
    fn raw_iso_emits_streaming_rust_load_plan() {
        let image = valid_iso();
        let (reader, physical_bytes) = drive_counted(
            DiscBootReader::new(image.len() as u64, TEST_EPOCH).unwrap(),
            &image,
            false,
        );
        assert_eq!(reader.stage(), BootReaderStage::Ready);
        assert_eq!(
            physical_bytes,
            u64::from(CISO_HEADER_BYTES + DOL_HEADER_BYTES),
            "raw planning reuses the format probe and reads only the DOL header afterward"
        );
        let plan = reader.plan().unwrap();
        assert_eq!(
            plan.format,
            DiscFormat::RawIso {
                logical_bytes: image.len() as u64
            }
        );
        assert_eq!(plan.identity.identifier, *b"GZLE01");
        assert_eq!(plan.identity.title, "Rusty Cube");
        assert_eq!(plan.identity.label, "Rusty Cube (GZLE01 Rev.02)");
        assert_eq!(plan.dol_bytes, 0x130);
        assert_eq!(plan.entry, 0x8000_3100);
        assert_eq!(plan.canonical_entry, 0x8000_3100);
        assert_eq!(plan.fst_address, 0x817f_ffe0);
        assert_eq!(plan.bi2_address, 0x817f_dfe0);
        assert_eq!(plan.fst_max_bytes, 32);
        assert_eq!(plan.fst_reserved_bytes, 32);
        assert_eq!(
            plan.operations,
            vec![
                BootLoadOperation::Copy {
                    kind: BootCopyKind::Bi2,
                    disc_offset: BI2_DISC_OFFSET,
                    mem1_target: 0x817f_dfe0,
                    length: BI2_BYTES,
                },
                BootLoadOperation::Copy {
                    kind: BootCopyKind::Fst,
                    disc_offset: TEST_FST_OFFSET as u64,
                    mem1_target: 0x817f_ffe0,
                    length: 12,
                },
                BootLoadOperation::Zero {
                    mem1_target: 0x8000_5000,
                    length: 0x20,
                },
                BootLoadOperation::Copy {
                    kind: BootCopyKind::DolText(0),
                    disc_offset: TEST_BOOT_OFFSET as u64 + 0x100,
                    mem1_target: 0x8000_3100,
                    length: 0x20,
                },
                BootLoadOperation::Copy {
                    kind: BootCopyKind::DolData(0),
                    disc_offset: TEST_BOOT_OFFSET as u64 + 0x120,
                    mem1_target: 0x8000_4000,
                    length: 0x10,
                },
            ]
        );
        assert!(plan.dol_bytes < image.len() as u32);
    }

    #[test]
    fn fst_maximum_is_retained_while_mem1_reservation_is_aligned() {
        let mut image = valid_iso();
        write_be_u32(&mut image, 0x42c, 33);
        let reader = drive_iso(&image);
        let plan = reader.plan().unwrap();
        assert_eq!(plan.fst_max_bytes, 33);
        assert_eq!(plan.fst_reserved_bytes, 64);
        assert_eq!(plan.fst_address, MEM1_END - 64);
        assert_eq!(plan.bi2_address, MEM1_END - 64 - BI2_BYTES);
    }

    #[test]
    fn ciso_sparse_blocks_are_expanded_and_physical_completions_may_reorder() {
        let logical = valid_iso();
        let ciso = ciso_from_sparse_logical(&logical, 0x200);
        let mut reader = DiscBootReader::new(ciso.len() as u64, TEST_EPOCH).unwrap();
        let header_request = reader.requests().next().unwrap();
        complete_request(&mut reader, &ciso, header_request);
        assert_eq!(reader.stage(), BootReaderStage::DiscHeader);
        let disc_header_requests: Vec<_> = reader.requests().collect();
        assert!(disc_header_requests.len() >= 2);

        for request in disc_header_requests.into_iter().rev() {
            complete_request(&mut reader, &ciso, request);
        }
        reader = drive(reader, &ciso, true);
        let plan = reader.plan().unwrap();
        assert!(matches!(
            plan.format,
            DiscFormat::Ciso {
                block_bytes: 0x200,
                ..
            }
        ));
        assert_eq!(plan.identity.identifier, *b"GZLE01");
        assert_eq!(plan.entry, 0x8000_3100);
    }

    #[test]
    fn ciso_mid_block_read_coalesces_contiguous_physical_blocks_exactly() {
        let block_bytes = 32_u32;
        let physical_base = u64::from(CISO_HEADER_BYTES);
        let image = ImageMap::Ciso {
            logical_bytes: u64::from(block_bytes) * 3,
            block_bytes,
            present_ordinals: vec![0, 1, 2],
            present_blocks: 3,
        };
        // Seven bytes into block zero, then all of block one and eleven bytes of block two.
        let length = (block_bytes - 7) + block_bytes + 11;
        let runs = physical_runs(&image, 7, length);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].container_offset, physical_base + 7);
        assert_eq!(runs[0].output_offset, 0);
        assert_eq!(runs[0].length, length);
    }

    #[test]
    fn ciso_compact_ordinals_preserve_maximum_entry_sparse_sentinel_and_checked_offsets() {
        let block_bytes = 32_u32;
        let mut all_present = vec![0; CISO_HEADER_BYTES as usize];
        all_present[..4].copy_from_slice(b"CISO");
        all_present[4..8].copy_from_slice(&block_bytes.to_le_bytes());
        all_present[CISO_MAP_OFFSET..].fill(1);
        let required =
            checked_ciso_physical_offset(CISO_MAP_ENTRIES as u64, u64::from(block_bytes)).unwrap();
        let image = parse_ciso(&all_present, required).unwrap();
        let ImageMap::Ciso {
            present_ordinals,
            present_blocks,
            ..
        } = image
        else {
            unreachable!();
        };
        assert_eq!(present_blocks, CISO_MAP_ENTRIES as u32);
        assert_eq!(present_ordinals.len(), CISO_MAP_ENTRIES);
        assert_eq!(
            core::mem::size_of_val(present_ordinals.as_slice()),
            CISO_MAP_ENTRIES * core::mem::size_of::<u16>()
        );
        assert_eq!(present_ordinals[0], 0);
        assert_eq!(present_ordinals[CISO_MAP_ENTRIES - 1], 32_759);
        assert_ne!(present_ordinals[CISO_MAP_ENTRIES - 1], ABSENT_CISO_BLOCK);
        assert_eq!(
            ciso_physical_offset(32_759, block_bytes),
            Some(u64::from(CISO_HEADER_BYTES) + 32_759 * u64::from(block_bytes))
        );

        let mut sparse = all_present;
        sparse[CISO_MAP_OFFSET] = 0;
        let image = parse_ciso(&sparse, required - u64::from(block_bytes)).unwrap();
        let ImageMap::Ciso {
            present_ordinals, ..
        } = image
        else {
            unreachable!();
        };
        assert_eq!(present_ordinals[0], ABSENT_CISO_BLOCK);
        assert_eq!(present_ordinals[1], 0);
        assert_eq!(present_ordinals[CISO_MAP_ENTRIES - 1], 32_758);
        assert_eq!(ciso_physical_offset(ABSENT_CISO_BLOCK, block_bytes), None);
        assert_eq!(checked_ciso_physical_offset(u64::MAX, 2), None);
        assert_eq!(
            checked_ciso_physical_offset(u64::MAX, 1),
            None,
            "adding the CISO header must reject an otherwise non-overflowing product"
        );
    }

    #[test]
    fn ciso_physical_runs_exhaust_sparse_and_chunk_boundaries() {
        const BLOCK_BYTES: u32 = 32;
        const BLOCKS: usize = 5;
        let physical_base = CISO_HEADER_BYTES as usize;
        for present_mask in 0_u32..1 << BLOCKS {
            let mut present_ordinals = Vec::with_capacity(BLOCKS);
            let mut present_ordinal = 0_u16;
            let mut container = vec![0; physical_base];
            let mut logical = vec![0; BLOCK_BYTES as usize * BLOCKS];
            for block in 0..BLOCKS {
                if present_mask & (1 << block) == 0 {
                    present_ordinals.push(ABSENT_CISO_BLOCK);
                    continue;
                }
                present_ordinals.push(present_ordinal);
                present_ordinal += 1;
                for within in 0..BLOCK_BYTES as usize {
                    let value = 1 + block as u8 * BLOCK_BYTES as u8 + within as u8;
                    container.push(value);
                    logical[block * BLOCK_BYTES as usize + within] = value;
                }
            }
            let image = ImageMap::Ciso {
                logical_bytes: logical.len() as u64,
                block_bytes: BLOCK_BYTES,
                present_blocks: present_mask.count_ones(),
                present_ordinals,
            };
            for offset in 0..=logical.len() {
                for length in 0..=logical.len() - offset {
                    let runs = physical_runs(&image, offset as u64, length as u32);
                    let mut reconstructed = vec![0; length];
                    for run in runs {
                        assert_ne!(run.length, 0);
                        let source = run.container_offset as usize;
                        let destination = run.output_offset as usize;
                        reconstructed[destination..destination + run.length as usize]
                            .copy_from_slice(&container[source..source + run.length as usize]);
                    }
                    assert_eq!(
                        reconstructed,
                        logical[offset..offset + length],
                        "mask={present_mask:#07b}, offset={offset}, length={length}"
                    );
                }
            }
        }
    }

    #[test]
    fn completion_identity_is_exact_and_one_use() {
        let image = valid_iso();
        let mut reader = DiscBootReader::new(image.len() as u64, TEST_EPOCH).unwrap();
        let request = reader.requests().next().unwrap();
        let malformed = ReadRequest {
            container_offset: request.container_offset + 1,
            ..request
        };
        assert!(matches!(
            reader.staging_mut(malformed),
            Err(ReadCompletionError::DescriptorMismatch { .. })
        ));
        assert_eq!(reader.requests().next(), Some(request));

        complete_request(&mut reader, &image, request);
        assert!(matches!(
            reader.complete(request, request.length),
            Err(ReadCompletionError::StaleRequest { id }) if id == request.id
        ));
        assert_eq!(reader.stage(), BootReaderStage::DolHeader);
    }

    #[test]
    fn short_completion_is_consumed_and_fails_closed() {
        let image = valid_iso();
        let mut reader = DiscBootReader::new(image.len() as u64, TEST_EPOCH).unwrap();
        let request = reader.requests().next().unwrap();
        reader.staging_mut(request).unwrap()[..16].copy_from_slice(&image[..16]);
        assert_eq!(
            reader.complete(request, 16),
            Err(ReadCompletionError::ShortRead {
                request,
                written: 16,
            })
        );
        assert_eq!(reader.stage(), BootReaderStage::Failed);
        assert_eq!(
            reader.failure(),
            Some(&BootError::ShortRead {
                request,
                written: 16,
            })
        );
        assert_eq!(reader.requests().len(), 0);
        assert!(matches!(
            reader.complete(request, request.length),
            Err(ReadCompletionError::StaleRequest { .. })
        ));
    }

    #[test]
    fn ciso_metadata_validates_block_size_and_accepts_every_nonzero_presence_marker() {
        let mut malformed = vec![0; CISO_HEADER_BYTES as usize];
        malformed[..4].copy_from_slice(b"CISO");
        malformed[4..8].copy_from_slice(&17_u32.to_le_bytes());
        let reader = drive(
            DiscBootReader::new(malformed.len() as u64, TEST_EPOCH).unwrap(),
            &malformed,
            false,
        );
        assert_eq!(reader.failure(), Some(&BootError::InvalidCisoBlockSize(17)));

        let mut compatible = vec![0; CISO_HEADER_BYTES as usize + 64];
        compatible[..4].copy_from_slice(b"CISO");
        compatible[4..8].copy_from_slice(&32_u32.to_le_bytes());
        compatible[8] = 0x02;
        compatible[9] = 0xff;
        let image = parse_ciso(
            &compatible[..CISO_HEADER_BYTES as usize],
            compatible.len() as u64,
        )
        .expect("native CISO compatibility treats every nonzero marker as present");
        let ImageMap::Ciso {
            present_ordinals,
            present_blocks,
            ..
        } = image
        else {
            unreachable!();
        };
        assert_eq!(present_blocks, 2);
        assert_eq!(present_ordinals[0], 0);
        assert_eq!(present_ordinals[1], 1);
        assert_eq!(present_ordinals[2], ABSENT_CISO_BLOCK);
    }

    #[test]
    fn truncated_ciso_is_authenticated_from_bitmap_and_container_size() {
        let mut truncated = vec![0; CISO_HEADER_BYTES as usize];
        truncated[..4].copy_from_slice(b"CISO");
        truncated[4..8].copy_from_slice(&0x800_u32.to_le_bytes());
        truncated[8] = 1;
        let reader = drive(
            DiscBootReader::new(truncated.len() as u64, TEST_EPOCH).unwrap(),
            &truncated,
            false,
        );
        assert_eq!(
            reader.failure(),
            Some(&BootError::TruncatedCiso {
                required: u64::from(CISO_HEADER_BYTES) + 0x800,
                available: u64::from(CISO_HEADER_BYTES),
            })
        );
    }

    #[test]
    fn dol_span_is_limited_to_32_mib() {
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0x90, MAX_DOL_BYTES);
            }),
            BootError::DolExceedsBootLimit {
                section: 0,
                end: MAX_DOL_BYTES + 0x100,
            }
        );
    }

    #[test]
    fn dol_sections_must_reside_in_mem1_and_not_overlap() {
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0x48, 0x7000_0000);
            }),
            BootError::DolSectionOutsideMem1 {
                section: 0,
                target: 0x7000_0000,
                length: 0x20,
            }
        );
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0x04, 0x140);
                write_be_u32(dol, 0x4c, 0x8000_3110);
                write_be_u32(dol, 0x94, 0x20);
            }),
            BootError::DolSectionMemoryOverlap {
                first: 0,
                second: 1,
            }
        );
    }

    #[test]
    fn dol_bss_must_reside_in_mem1_and_is_cleared_before_overlapping_sections() {
        let mut image = valid_iso();
        write_be_u32(
            &mut image[TEST_BOOT_OFFSET..TEST_BOOT_OFFSET + DOL_HEADER_BYTES as usize],
            0xd8,
            0x8000_3110,
        );
        let reader = drive_iso(&image);
        let operations = &reader.plan().unwrap().operations;
        let zero = operations
            .iter()
            .position(|operation| matches!(operation, BootLoadOperation::Zero { .. }))
            .unwrap();
        let text = operations
            .iter()
            .position(|operation| {
                matches!(
                    operation,
                    BootLoadOperation::Copy {
                        kind: BootCopyKind::DolText(0),
                        ..
                    }
                )
            })
            .unwrap();
        assert!(zero < text);

        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0xd8, 0x817f_fff0);
                write_be_u32(dol, 0xdc, 0x20);
            }),
            BootError::DolBssOutsideMem1 {
                target: 0x817f_fff0,
                length: 0x20,
            }
        );
    }

    #[test]
    fn dol_entrypoint_must_be_a_complete_mem1_instruction() {
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0xe0, 0x817f_fffe);
            }),
            BootError::DolEntrypointOutsideMem1(0x817f_fffe)
        );
    }

    #[test]
    fn dol_and_bss_cannot_overwrite_reserved_boot_data() {
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0x48, 0x817f_dfe0);
            }),
            BootError::BootDataOverlapsDolSection { section: 0 }
        );
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0xd8, 0x817f_e000);
            }),
            BootError::BootDataOverlapsDolBss
        );
    }

    #[test]
    fn dol_and_bss_cannot_overlap_terminal_low_memory_publication() {
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0x48, 0x8000_0080);
            }),
            BootError::LowMemoryOverlapsDolSection { section: 0 }
        );
        assert_eq!(
            failed_with_dol_mutation(|dol| {
                write_be_u32(dol, 0xd8, 0xc000_00f0);
                write_be_u32(dol, 0xdc, 0x20);
            }),
            BootError::LowMemoryOverlapsDolBss
        );
    }
}
