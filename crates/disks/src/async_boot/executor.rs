//! Bounded execution of a validated [`BootLoadPlan`](super::BootLoadPlan).
//!
//! The executor retains the reader's authenticated container map and exact-read identity space.
//! It reveals physical ranges to an asynchronous host, but CISO translation, sparse zeroes,
//! operation ordering, MEM1 addressing, and the terminal boot commit remain Rust-owned.

use super::{
    ABSENT_CISO_BLOCK, BootError, BootLoadOperation, BootLoadPlan, BootReaderStage, DiscBootReader,
    DiscFormat, DiscIdentity, ExactReadAt, ImageMap, MEM1_BASE, MEM1_BYTES, PhysicalRun,
    ReadCompletionError, ReadRequest, ciso_physical_offset, physical_runs,
};

/// Hard allocation and request bound for one load chunk.
pub const MAX_BOOT_LOAD_CHUNK_BYTES: u32 = 256 * 1024;

/// High-level state of a chunked load attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootLoadExecutorStage {
    Loading,
    Committed,
    Failed,
    Cancelled,
}

/// Why a ready reader could not be converted into a load executor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootLoadStartError {
    InvalidChunkBytes {
        requested: u32,
        maximum: u32,
    },
    ReaderNotReady {
        stage: BootReaderStage,
        failure: Option<BootError>,
    },
}

/// The only two kinds of mutation the boot executor may request from MEM1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootMem1Access {
    Write,
    Zero,
}

/// A narrow error vocabulary for a Rust-owned MEM1 implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootMem1Error {
    OutOfBounds {
        offset: u32,
        length: u32,
        available: u32,
    },
    Fault,
}

/// Narrow destination interface used by the boot executor.
///
/// Addresses have already been canonicalized and bounds-checked by the executor. Implementations
/// receive physical offsets from the start of MEM1, never guest virtual addresses.
pub trait BootMem1 {
    fn length(&self) -> u32;

    fn write_exact(&mut self, offset: u32, bytes: &[u8]) -> Result<(), BootMem1Error>;

    fn zero_exact(&mut self, offset: u32, length: u32) -> Result<(), BootMem1Error>;
}

/// Checked adapter for a Rust mutable slice containing MEM1 bytes.
#[derive(Debug)]
pub struct BootMem1Slice<'a> {
    bytes: &'a mut [u8],
}

impl<'a> BootMem1Slice<'a> {
    pub fn new(bytes: &'a mut [u8]) -> Self {
        Self { bytes }
    }

    pub fn as_slice(&self) -> &[u8] {
        self.bytes
    }
}

impl BootMem1 for BootMem1Slice<'_> {
    fn length(&self) -> u32 {
        u32::try_from(self.bytes.len()).unwrap_or(u32::MAX)
    }

    fn write_exact(&mut self, offset: u32, bytes: &[u8]) -> Result<(), BootMem1Error> {
        let length = u32::try_from(bytes.len()).map_err(|_| BootMem1Error::OutOfBounds {
            offset,
            length: u32::MAX,
            available: self.length(),
        })?;
        let destination = checked_slice_mut(self.bytes, offset, length)?;
        destination.copy_from_slice(bytes);
        Ok(())
    }

    fn zero_exact(&mut self, offset: u32, length: u32) -> Result<(), BootMem1Error> {
        checked_slice_mut(self.bytes, offset, length)?.fill(0);
        Ok(())
    }
}

fn checked_slice_mut(
    bytes: &mut [u8],
    offset: u32,
    length: u32,
) -> Result<&mut [u8], BootMem1Error> {
    let available = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
    let start = offset as usize;
    let length_usize = length as usize;
    let Some(end) = start.checked_add(length_usize) else {
        return Err(BootMem1Error::OutOfBounds {
            offset,
            length,
            available,
        });
    };
    bytes.get_mut(start..end).ok_or(BootMem1Error::OutOfBounds {
        offset,
        length,
        available,
    })
}

/// Terminal, Rust-authenticated handoff produced only after every plan operation succeeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootCommitRecord {
    pub format: DiscFormat,
    pub identity: DiscIdentity,
    pub dol_disc_offset: u64,
    pub dol_bytes: u32,
    pub entry: u32,
    pub canonical_entry: u32,
    pub bi2_address: u32,
    pub fst_address: u32,
    pub fst_bytes: u32,
    pub fst_max_bytes: u32,
    pub fst_reserved_bytes: u32,
}

impl From<&BootLoadPlan> for BootCommitRecord {
    fn from(plan: &BootLoadPlan) -> Self {
        Self {
            format: plan.format,
            identity: plan.identity.clone(),
            dol_disc_offset: plan.dol_disc_offset,
            dol_bytes: plan.dol_bytes,
            entry: plan.entry,
            canonical_entry: plan.canonical_entry,
            bi2_address: plan.bi2_address,
            fst_address: plan.fst_address,
            fst_bytes: plan.fst_bytes,
            fst_max_bytes: plan.fst_max_bytes,
            fst_reserved_bytes: plan.fst_reserved_bytes,
        }
    }
}

/// Maximum logical window accepted by the committed disc mapper.
///
/// This intentionally matches resident DI's one-window host boundary. The complete DI payload
/// may be as large as MEM1, but only one exact window is ever exposed to asynchronous storage.
pub const MAX_COMMITTED_DISC_READ_BYTES: u32 = MAX_BOOT_LOAD_CHUNK_BYTES;

/// Complete identity of one resident device's logical-disc window.
///
/// The mapper retains this identity while it emits one or more physical container reads. This
/// prevents a valid physical completion from an older DI window from being applied to a newer
/// Rust-private payload even if a browser promise settles late.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(C)]
pub struct LogicalReadIdentity {
    pub epoch: u64,
    pub id: u64,
    pub logical_offset: u64,
    pub length: u32,
}

/// Progress after beginning or completing a committed logical-disc read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommittedDiscReadProgress {
    /// A copied, pointer-free physical container request is ready for the asynchronous host.
    HostRead(ReadRequest),
    /// Every present physical run completed; sparse bytes were already synthesized as zeroes.
    Ready(LogicalReadIdentity),
}

/// Typed failures at the Rust-owned logical-to-physical disc boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommittedDiscReadError {
    Busy {
        active: LogicalReadIdentity,
    },
    NoActiveRead,
    LogicalIdentityMismatch {
        expected: LogicalReadIdentity,
        received: LogicalReadIdentity,
    },
    ZeroLength,
    WindowTooLarge {
        requested: u32,
        maximum: u32,
    },
    LogicalRangeOutsideImage {
        offset: u64,
        length: u32,
        logical_bytes: u64,
    },
    StagingLength {
        expected: u32,
        available: usize,
    },
    RequestIdExhausted,
    StaleRequest {
        id: u64,
    },
    UnknownRequest {
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
    InvalidReadPlacement {
        request: ReadRequest,
        output_offset: u32,
        logical_length: u32,
    },
}

#[derive(Debug, Clone, Copy)]
struct ActiveCommittedRead {
    identity: LogicalReadIdentity,
    /// Count of logical bytes already classified as sparse or assigned to physical requests.
    cursor: u32,
    request: ReadRequest,
    output_offset: u32,
}

/// Post-boot logical-disc mapper that owns the boot-authenticated raw/CISO image map.
///
/// No map is cloned when the boot executor commits. A logical window is zeroed in the resident
/// device's own private staging allocation, then present raw/CISO runs are exposed one at a time
/// as physical container reads. After the host awaits a read, Rust reauthenticates the complete
/// request and lends only the corresponding sub-slice of that same device staging allocation.
#[derive(Debug)]
pub struct CommittedDiscReader {
    image: ImageMap,
    request_epoch: u64,
    next_request_id: u64,
    active: Option<ActiveCommittedRead>,
}

/// Terminal boot state split into durable metadata and the unique committed disc mapper.
#[derive(Debug)]
pub struct CommittedBoot {
    pub plan: BootLoadPlan,
    pub commit: BootCommitRecord,
    pub reader: CommittedDiscReader,
}

impl CommittedDiscReader {
    #[must_use]
    pub fn format(&self) -> DiscFormat {
        self.image.format()
    }

    #[must_use]
    pub fn logical_bytes(&self) -> u64 {
        self.image.logical_bytes()
    }

    #[must_use]
    pub fn active_identity(&self) -> Option<LogicalReadIdentity> {
        self.active.map(|active| active.identity)
    }

    #[must_use]
    pub fn request(&self) -> Option<ReadRequest> {
        self.active.map(|active| active.request)
    }

    /// Starts one bounded logical window and initializes sparse output directly in device-owned
    /// staging. A fully sparse window returns `Ready` without involving the host.
    pub fn begin(
        &mut self,
        identity: LogicalReadIdentity,
        logical_staging: &mut [u8],
    ) -> Result<CommittedDiscReadProgress, CommittedDiscReadError> {
        if let Some(active) = self.active {
            return Err(CommittedDiscReadError::Busy {
                active: active.identity,
            });
        }
        if identity.length == 0 {
            return Err(CommittedDiscReadError::ZeroLength);
        }
        if identity.length > MAX_COMMITTED_DISC_READ_BYTES {
            return Err(CommittedDiscReadError::WindowTooLarge {
                requested: identity.length,
                maximum: MAX_COMMITTED_DISC_READ_BYTES,
            });
        }
        let logical_bytes = self.image.logical_bytes();
        if identity.logical_offset > logical_bytes
            || u64::from(identity.length) > logical_bytes.saturating_sub(identity.logical_offset)
        {
            return Err(CommittedDiscReadError::LogicalRangeOutsideImage {
                offset: identity.logical_offset,
                length: identity.length,
                logical_bytes,
            });
        }
        if logical_staging.len() != identity.length as usize {
            return Err(CommittedDiscReadError::StagingLength {
                expected: identity.length,
                available: logical_staging.len(),
            });
        }

        // Absent CISO blocks are architecturally zero. Present runs overwrite only their exact
        // authenticated subranges after the host has filled them.
        logical_staging.fill(0);
        self.issue_next(identity, 0)
    }

    /// Reacquires the exact physical run's destination after an async host fetch.
    pub fn staging_mut<'a>(
        &mut self,
        identity: LogicalReadIdentity,
        request: ReadRequest,
        logical_staging: &'a mut [u8],
    ) -> Result<&'a mut [u8], CommittedDiscReadError> {
        let active = self.validate(identity, request)?;
        if logical_staging.len() != identity.length as usize {
            return Err(CommittedDiscReadError::StagingLength {
                expected: identity.length,
                available: logical_staging.len(),
            });
        }
        let start = active.output_offset as usize;
        let Some(end) = start.checked_add(request.length as usize) else {
            return Err(CommittedDiscReadError::InvalidReadPlacement {
                request,
                output_offset: active.output_offset,
                logical_length: identity.length,
            });
        };
        logical_staging
            .get_mut(start..end)
            .ok_or(CommittedDiscReadError::InvalidReadPlacement {
                request,
                output_offset: active.output_offset,
                logical_length: identity.length,
            })
    }

    /// Consumes one exact physical completion and either publishes the next run or finishes the
    /// logical window. Identity failures leave the live request untouched. A short read retires
    /// the mapper window so its owner can fail the resident device transaction atomically.
    pub fn complete(
        &mut self,
        identity: LogicalReadIdentity,
        request: ReadRequest,
        written: u32,
    ) -> Result<CommittedDiscReadProgress, CommittedDiscReadError> {
        let active = self.validate(identity, request)?;
        if written != request.length {
            self.active = None;
            return Err(CommittedDiscReadError::ShortRead { request, written });
        }
        self.active = None;
        self.issue_next(identity, active.cursor)
    }

    /// Authenticates and retires one host-failed physical request.
    pub fn fail(
        &mut self,
        identity: LogicalReadIdentity,
        request: ReadRequest,
    ) -> Result<(), CommittedDiscReadError> {
        self.validate(identity, request)?;
        self.active = None;
        Ok(())
    }

    /// Cancels only a matching logical window, making its physical request stale.
    pub fn cancel(&mut self, identity: LogicalReadIdentity) -> bool {
        if self
            .active
            .is_some_and(|active| active.identity == identity)
        {
            self.active = None;
            true
        } else {
            false
        }
    }

    fn validate(
        &self,
        identity: LogicalReadIdentity,
        request: ReadRequest,
    ) -> Result<ActiveCommittedRead, CommittedDiscReadError> {
        let Some(active) = self.active else {
            return Err(if request.id < self.next_request_id {
                CommittedDiscReadError::StaleRequest { id: request.id }
            } else {
                CommittedDiscReadError::NoActiveRead
            });
        };
        if request.id < active.request.id {
            return Err(CommittedDiscReadError::StaleRequest { id: request.id });
        }
        if request.id > active.request.id {
            return Err(CommittedDiscReadError::UnknownRequest { id: request.id });
        }
        if request != active.request {
            return Err(CommittedDiscReadError::DescriptorMismatch {
                expected: active.request,
                received: request,
            });
        }
        if identity != active.identity {
            return Err(CommittedDiscReadError::LogicalIdentityMismatch {
                expected: active.identity,
                received: identity,
            });
        }
        Ok(active)
    }

    fn issue_next(
        &mut self,
        identity: LogicalReadIdentity,
        cursor: u32,
    ) -> Result<CommittedDiscReadProgress, CommittedDiscReadError> {
        let Some((run, next_cursor)) = next_physical_run(
            &self.image,
            identity.logical_offset,
            identity.length,
            cursor,
        ) else {
            return Ok(CommittedDiscReadProgress::Ready(identity));
        };
        let id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or(CommittedDiscReadError::RequestIdExhausted)?;
        let request = ReadRequest {
            epoch: self.request_epoch,
            id,
            container_offset: run.container_offset,
            length: run.length,
        };
        self.active = Some(ActiveCommittedRead {
            identity,
            cursor: next_cursor,
            request,
            output_offset: run.output_offset,
        });
        Ok(CommittedDiscReadProgress::HostRead(request))
    }
}

/// Returns the next coalesced present run after `cursor` without allocating a run table.
/// Sparse CISO blocks advance the logical cursor but remain zero in the caller's staging slice.
fn next_physical_run(
    image: &ImageMap,
    logical_offset: u64,
    length: u32,
    mut cursor: u32,
) -> Option<(PhysicalRun, u32)> {
    if cursor >= length {
        return None;
    }
    if matches!(image, ImageMap::Raw { .. }) {
        return Some((
            PhysicalRun {
                container_offset: logical_offset + u64::from(cursor),
                output_offset: cursor,
                length: length - cursor,
            },
            length,
        ));
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
    while cursor < length {
        let logical_position = logical_offset + u64::from(cursor);
        let block = usize::try_from(logical_position / block_bytes_u64).ok()?;
        let within = logical_position % block_bytes_u64;
        let first_length = u64::from(length - cursor).min(block_bytes_u64 - within) as u32;
        let present_ordinal = *present_ordinals.get(block)?;
        if present_ordinal == ABSENT_CISO_BLOCK {
            cursor += first_length;
            continue;
        }

        let output_offset = cursor;
        let container_offset = ciso_physical_offset(present_ordinal, *block_bytes)? + within;
        let mut run_length = first_length;
        let mut previous_ordinal = present_ordinal;
        cursor += first_length;

        // Once the first partial block ends, consecutive present ordinals are physically
        // adjacent in CISO and may be fetched as one range. Stop at the first sparse or reordered
        // block so the browser never learns or applies logical placement policy.
        while cursor < length {
            let next_position = logical_offset + u64::from(cursor);
            let next_block = usize::try_from(next_position / block_bytes_u64).ok()?;
            let next_within = next_position % block_bytes_u64;
            debug_assert_eq!(next_within, 0);
            let next_ordinal = *present_ordinals.get(next_block)?;
            if next_ordinal == ABSENT_CISO_BLOCK
                || u32::from(next_ordinal) != u32::from(previous_ordinal) + 1
            {
                break;
            }
            let next_length = u64::from(length - cursor).min(block_bytes_u64) as u32;
            run_length += next_length;
            cursor += next_length;
            previous_ordinal = next_ordinal;
        }

        return Some((
            PhysicalRun {
                container_offset,
                output_offset,
                length: run_length,
            },
            cursor,
        ));
    }
    None
}

/// Terminal load failures. Every variant retires all outstanding read requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootLoadError {
    RequestIdExhausted,
    PlanDiscRangeOutsideImage {
        operation: u32,
        offset: u64,
        length: u32,
        logical_bytes: u64,
    },
    PlanMem1RangeOutsideMemory {
        operation: u32,
        target: u32,
        length: u32,
        available: u32,
    },
    Mem1 {
        operation: u32,
        access: BootMem1Access,
        target: u32,
        length: u32,
        error: BootMem1Error,
    },
    ShortRead {
        request: ReadRequest,
        written: u32,
    },
    InvalidReadPlacement {
        request: ReadRequest,
        output_offset: u32,
    },
}

/// A completion can be rejected without disturbing the live request, or can expose a terminal
/// execution failure that occurred after consuming an authentic completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootLoadCompletionError {
    Read(ReadCompletionError),
    Load(BootLoadError),
}

#[derive(Debug)]
struct ActiveChunk {
    operation: u32,
    mem1_target: u32,
    bytes: Vec<u8>,
}

/// Pull-driven executor for one validated boot plan.
#[derive(Debug)]
pub struct BootLoadExecutor {
    image: ImageMap,
    reads: ExactReadAt,
    plan: BootLoadPlan,
    chunk_bytes: u32,
    operation: usize,
    operation_offset: u32,
    active: Option<ActiveChunk>,
    stage: BootLoadExecutorStage,
    failure: Option<BootLoadError>,
    commit: Option<BootCommitRecord>,
}

impl DiscBootReader {
    /// Consumes a ready planner while retaining its CISO map, epoch, and monotonically increasing
    /// read-request identifiers in the executor.
    pub fn into_load_executor(
        mut self,
        chunk_bytes: u32,
    ) -> Result<BootLoadExecutor, BootLoadStartError> {
        if chunk_bytes == 0 || chunk_bytes > MAX_BOOT_LOAD_CHUNK_BYTES {
            return Err(BootLoadStartError::InvalidChunkBytes {
                requested: chunk_bytes,
                maximum: MAX_BOOT_LOAD_CHUNK_BYTES,
            });
        }
        if self.stage != BootReaderStage::Ready {
            return Err(BootLoadStartError::ReaderNotReady {
                stage: self.stage,
                failure: self.failure.clone(),
            });
        }

        let image = self
            .image
            .take()
            .expect("a ready boot reader retains its container map");
        let plan = self
            .plan
            .take()
            .expect("a ready boot reader retains its load plan");
        Ok(BootLoadExecutor {
            image,
            reads: self.reads,
            plan,
            chunk_bytes,
            operation: 0,
            operation_offset: 0,
            active: None,
            stage: BootLoadExecutorStage::Loading,
            failure: None,
            commit: None,
        })
    }
}

impl BootLoadExecutor {
    pub fn stage(&self) -> BootLoadExecutorStage {
        self.stage
    }

    pub fn plan(&self) -> &BootLoadPlan {
        &self.plan
    }

    pub fn requests(&self) -> impl ExactSizeIterator<Item = ReadRequest> + '_ {
        self.reads.requests()
    }

    pub fn staging_mut(&mut self, request: ReadRequest) -> Result<&mut [u8], ReadCompletionError> {
        self.reads.staging_mut(request)
    }

    pub fn failure(&self) -> Option<&BootLoadError> {
        self.failure.as_ref()
    }

    pub fn commit(&self) -> Option<&BootCommitRecord> {
        self.commit.as_ref()
    }

    /// Consumes a terminal executor and moves its unique authenticated image map into the
    /// post-boot reader. Neither the CISO bitmap nor its ordinal table is cloned.
    ///
    /// The error deliberately returns the full executor so the caller retains the unique image
    /// map and pending-read authority rather than losing or cloning either one.
    #[allow(clippy::result_large_err)]
    pub fn into_committed_disc(self) -> Result<CommittedBoot, Self> {
        if self.stage != BootLoadExecutorStage::Committed
            || self.active.is_some()
            || self.commit.is_none()
            || self.reads.pending_count() != 0
        {
            return Err(self);
        }
        let Self {
            image,
            reads,
            plan,
            active: _,
            stage: _,
            failure: _,
            commit,
            chunk_bytes: _,
            operation: _,
            operation_offset: _,
        } = self;
        let commit = commit.expect("a validated committed executor retains its commit record");
        let (request_epoch, next_request_id) = reads
            .into_request_cursor()
            .expect("a validated committed executor has no pending physical requests");
        Ok(CommittedBoot {
            plan,
            commit,
            reader: CommittedDiscReader {
                image,
                request_epoch,
                next_request_id,
                active: None,
            },
        })
    }

    /// Starts or resumes local execution until an asynchronous physical read or terminal state.
    pub fn advance<M: BootMem1>(&mut self, mem1: &mut M) -> Result<(), BootLoadError> {
        if self.stage != BootLoadExecutorStage::Loading {
            return Ok(());
        }
        if let Err(error) = self.advance_inner(mem1) {
            self.fail(error.clone());
            return Err(error);
        }
        Ok(())
    }

    /// Authenticates and consumes exactly one host completion. Wrong identities leave the live
    /// request untouched; a short read or local write fault fails the whole attempt closed.
    pub fn complete<M: BootMem1>(
        &mut self,
        request: ReadRequest,
        written: u32,
        mem1: &mut M,
    ) -> Result<(), BootLoadCompletionError> {
        let completed = match self.reads.complete(request, written) {
            Ok(completed) => completed,
            Err(error @ ReadCompletionError::ShortRead { request, written }) => {
                self.fail(BootLoadError::ShortRead { request, written });
                return Err(BootLoadCompletionError::Read(error));
            }
            Err(error) => return Err(BootLoadCompletionError::Read(error)),
        };

        let Some(active) = self.active.as_mut() else {
            let error = BootLoadError::InvalidReadPlacement {
                request: completed.request,
                output_offset: completed.tag,
            };
            self.fail(error.clone());
            return Err(BootLoadCompletionError::Load(error));
        };
        let start = completed.tag as usize;
        let Some(end) = start.checked_add(completed.bytes.len()) else {
            let error = BootLoadError::InvalidReadPlacement {
                request: completed.request,
                output_offset: completed.tag,
            };
            self.fail(error.clone());
            return Err(BootLoadCompletionError::Load(error));
        };
        let Some(destination) = active.bytes.get_mut(start..end) else {
            let error = BootLoadError::InvalidReadPlacement {
                request: completed.request,
                output_offset: completed.tag,
            };
            self.fail(error.clone());
            return Err(BootLoadCompletionError::Load(error));
        };
        destination.copy_from_slice(&completed.bytes);
        // The next chunk may allocate both its Rust destination and one or more exact staging
        // buffers. Retire this consumed staging allocation before advancing so consecutive
        // 256 KiB chunks never overlap three semantic chunk buffers at the Wasm heap peak.
        drop(completed);

        if self.reads.pending_count() != 0 {
            return Ok(());
        }
        if let Err(error) = self
            .finish_active(mem1)
            .and_then(|()| self.advance_inner(mem1))
        {
            self.fail(error.clone());
            return Err(BootLoadCompletionError::Load(error));
        }
        Ok(())
    }

    /// Retires a live attempt and every request under its epoch. Cancellation is idempotent.
    pub fn cancel(&mut self) -> bool {
        if self.stage != BootLoadExecutorStage::Loading {
            return false;
        }
        self.reads.cancel_all();
        self.active = None;
        self.commit = None;
        self.stage = BootLoadExecutorStage::Cancelled;
        true
    }

    fn advance_inner<M: BootMem1>(&mut self, mem1: &mut M) -> Result<(), BootLoadError> {
        while self.stage == BootLoadExecutorStage::Loading && self.active.is_none() {
            let Some(operation) = self.plan.operations.get(self.operation).copied() else {
                self.commit = Some(BootCommitRecord::from(&self.plan));
                self.stage = BootLoadExecutorStage::Committed;
                return Ok(());
            };
            match operation {
                BootLoadOperation::Zero {
                    mem1_target,
                    length,
                } => {
                    if self.operation_offset == length {
                        self.finish_operation();
                        continue;
                    }
                    let chunk_length = (length - self.operation_offset).min(self.chunk_bytes);
                    let target = mem1_target.checked_add(self.operation_offset).ok_or(
                        BootLoadError::PlanMem1RangeOutsideMemory {
                            operation: self.operation as u32,
                            target: mem1_target,
                            length,
                            available: mem1.length(),
                        },
                    )?;
                    let offset = self.checked_mem1_offset(mem1, target, chunk_length)?;
                    mem1.zero_exact(offset, chunk_length)
                        .map_err(|error| BootLoadError::Mem1 {
                            operation: self.operation as u32,
                            access: BootMem1Access::Zero,
                            target,
                            length: chunk_length,
                            error,
                        })?;
                    self.operation_offset += chunk_length;
                }
                BootLoadOperation::Copy {
                    disc_offset,
                    mem1_target,
                    length,
                    ..
                } => {
                    if self.operation_offset == length {
                        self.finish_operation();
                        continue;
                    }
                    let chunk_length = (length - self.operation_offset).min(self.chunk_bytes);
                    let logical_offset = disc_offset + u64::from(self.operation_offset);
                    let logical_bytes = self.image.logical_bytes();
                    if logical_offset > logical_bytes
                        || u64::from(chunk_length) > logical_bytes.saturating_sub(logical_offset)
                    {
                        return Err(BootLoadError::PlanDiscRangeOutsideImage {
                            operation: self.operation as u32,
                            offset: logical_offset,
                            length: chunk_length,
                            logical_bytes,
                        });
                    }
                    let target = mem1_target.checked_add(self.operation_offset).ok_or(
                        BootLoadError::PlanMem1RangeOutsideMemory {
                            operation: self.operation as u32,
                            target: mem1_target,
                            length,
                            available: mem1.length(),
                        },
                    )?;
                    self.checked_mem1_offset(mem1, target, chunk_length)?;

                    let runs = physical_runs(&self.image, logical_offset, chunk_length);
                    self.active = Some(ActiveChunk {
                        operation: self.operation as u32,
                        mem1_target: target,
                        bytes: vec![0; chunk_length as usize],
                    });
                    for run in runs {
                        if self
                            .reads
                            .issue(run.container_offset, run.length, run.output_offset)
                            .is_none()
                        {
                            return Err(BootLoadError::RequestIdExhausted);
                        }
                    }
                    if self.reads.pending_count() == 0 {
                        self.finish_active(mem1)?;
                        continue;
                    }
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn finish_active<M: BootMem1>(&mut self, mem1: &mut M) -> Result<(), BootLoadError> {
        let active = self
            .active
            .take()
            .expect("finishing a load chunk requires an active Rust destination");
        let offset =
            self.checked_mem1_offset(mem1, active.mem1_target, active.bytes.len() as u32)?;
        mem1.write_exact(offset, &active.bytes)
            .map_err(|error| BootLoadError::Mem1 {
                operation: active.operation,
                access: BootMem1Access::Write,
                target: active.mem1_target,
                length: active.bytes.len() as u32,
                error,
            })?;
        self.operation_offset += active.bytes.len() as u32;
        Ok(())
    }

    fn checked_mem1_offset<M: BootMem1>(
        &self,
        mem1: &M,
        target: u32,
        length: u32,
    ) -> Result<u32, BootLoadError> {
        let operation = self.operation as u32;
        let Some(offset) = target.checked_sub(MEM1_BASE) else {
            return Err(BootLoadError::PlanMem1RangeOutsideMemory {
                operation,
                target,
                length,
                available: mem1.length(),
            });
        };
        let available = mem1.length().min(MEM1_BYTES);
        if offset > available || length > available.saturating_sub(offset) {
            return Err(BootLoadError::PlanMem1RangeOutsideMemory {
                operation,
                target,
                length,
                available,
            });
        }
        Ok(offset)
    }

    fn finish_operation(&mut self) {
        self.operation += 1;
        self.operation_offset = 0;
    }

    fn fail(&mut self, error: BootLoadError) {
        self.reads.cancel_all();
        self.active = None;
        self.commit = None;
        self.failure = Some(error);
        self.stage = BootLoadExecutorStage::Failed;
    }
}
