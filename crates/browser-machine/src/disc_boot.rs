//! Browser adapter boundary for Rust-owned asynchronous disc boot.
//!
//! Browser code is allowed to copy an exact [`ReadRequest`] out of this state machine, perform an
//! asynchronous range fetch, then reacquire that request's Rust-owned staging slice and complete
//! it synchronously. The browser never owns a staging allocation, a CISO map, a load plan, or a
//! boot commit. In particular, a staging pointer is deliberately not part of [`ReadRequest`], so
//! there is nothing pointer-shaped for an adapter to retain across an `await`.

use lazuli::disks::async_boot::{
    BootCommitRecord, BootError, BootLoadCompletionError, BootLoadError, BootLoadExecutor,
    BootLoadExecutorStage, BootLoadPlan, BootLoadStartError, BootMem1Slice, BootReaderStage,
    CommittedBoot, CommittedDiscReader, DiscBootReader, MAX_BOOT_LOAD_CHUNK_BYTES,
    ReadCompletionError, ReadRequest,
};
use lazuli::system::di::ResidentDiscConfigError;

/// Bytes atomically published to Dolphin OS low memory at the terminal boot handoff.
pub const BOOT_LOW_MEMORY_BYTES: usize = 0x100;

/// Host-visible lifecycle of the one Rust-owned boot attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum BrowserDiscBootStatus {
    Idle      = 0,
    Planning  = 1,
    Loading   = 2,
    Committed = 3,
    Failed    = 4,
    Cancelled = 5,
}

/// Stable, deliberately small terminal-fault vocabulary for the integer browser ABI.
///
/// Detailed errors remain available to Rust tests and diagnostics through
/// [`BrowserDiscBootState::fault`]. The host does not interpret disc structure or load policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum BrowserDiscBootFaultCode {
    None              = 0,
    EpochExhausted    = 1,
    Planning          = 2,
    PlanningShortRead = 3,
    LoadStart         = 4,
    Loading           = 5,
    LoadingShortRead  = 6,
}

/// Per-call result returned by mutating integer ABI operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum BrowserDiscBootCallResult {
    Rejected           = 0,
    Accepted           = 1,
    Committed          = 2,
    ActiveBoot         = 3,
    NoActiveBoot       = 4,
    EpochExhausted     = 5,
    UnknownRequest     = 6,
    StaleRequest       = 7,
    DescriptorMismatch = 8,
    ShortRead          = 9,
    PlanningFailed     = 10,
    LoadStartFailed    = 11,
    LoadingFailed      = 12,
    MachineBusy        = 13,
    DiscConfigurationFailed = 14,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserDiscBootFault {
    EpochExhausted,
    Planning(BootError),
    LoadStart(BootLoadStartError),
    Loading(BootLoadError),
}

impl BrowserDiscBootFault {
    pub fn code(&self) -> BrowserDiscBootFaultCode {
        match self {
            Self::EpochExhausted => BrowserDiscBootFaultCode::EpochExhausted,
            Self::Planning(BootError::ShortRead { .. }) => {
                BrowserDiscBootFaultCode::PlanningShortRead
            }
            Self::Planning(_) => BrowserDiscBootFaultCode::Planning,
            Self::LoadStart(_) => BrowserDiscBootFaultCode::LoadStart,
            Self::Loading(BootLoadError::ShortRead { .. }) => {
                BrowserDiscBootFaultCode::LoadingShortRead
            }
            Self::Loading(_) => BrowserDiscBootFaultCode::Loading,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserDiscBootError {
    MachineBusy,
    /// The loader sealed its commit, but BrowserMachine could not install every post-load owner.
    MachineHandoff,
    ActiveBoot,
    NoActiveBoot,
    EpochExhausted,
    Boot(BootError),
    Completion(ReadCompletionError),
    LoadStart(BootLoadStartError),
    LoadCompletion(BootLoadCompletionError),
    DiscConfiguration(ResidentDiscConfigError),
}

impl BrowserDiscBootError {
    pub fn call_result(&self) -> BrowserDiscBootCallResult {
        match self {
            Self::MachineBusy => BrowserDiscBootCallResult::MachineBusy,
            Self::MachineHandoff => BrowserDiscBootCallResult::Rejected,
            Self::ActiveBoot => BrowserDiscBootCallResult::ActiveBoot,
            Self::NoActiveBoot => BrowserDiscBootCallResult::NoActiveBoot,
            Self::EpochExhausted => BrowserDiscBootCallResult::EpochExhausted,
            Self::Boot(_) => BrowserDiscBootCallResult::PlanningFailed,
            Self::Completion(ReadCompletionError::UnknownRequest { .. }) => {
                BrowserDiscBootCallResult::UnknownRequest
            }
            Self::Completion(ReadCompletionError::StaleRequest { .. }) => {
                BrowserDiscBootCallResult::StaleRequest
            }
            Self::Completion(ReadCompletionError::DescriptorMismatch { .. }) => {
                BrowserDiscBootCallResult::DescriptorMismatch
            }
            Self::Completion(ReadCompletionError::ShortRead { .. }) => {
                BrowserDiscBootCallResult::ShortRead
            }
            Self::LoadStart(_) => BrowserDiscBootCallResult::LoadStartFailed,
            Self::LoadCompletion(BootLoadCompletionError::Read(
                ReadCompletionError::UnknownRequest { .. },
            )) => BrowserDiscBootCallResult::UnknownRequest,
            Self::LoadCompletion(BootLoadCompletionError::Read(
                ReadCompletionError::StaleRequest { .. },
            )) => BrowserDiscBootCallResult::StaleRequest,
            Self::LoadCompletion(BootLoadCompletionError::Read(
                ReadCompletionError::DescriptorMismatch { .. },
            )) => BrowserDiscBootCallResult::DescriptorMismatch,
            Self::LoadCompletion(BootLoadCompletionError::Read(
                ReadCompletionError::ShortRead { .. },
            )) => BrowserDiscBootCallResult::ShortRead,
            Self::LoadCompletion(BootLoadCompletionError::Load(_)) => {
                BrowserDiscBootCallResult::LoadingFailed
            }
            Self::DiscConfiguration(_) => BrowserDiscBootCallResult::DiscConfigurationFailed,
        }
    }
}

/// Result of one authentic completion. A commit record appears exactly once, after every planned
/// copy and local zero has completed successfully.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserDiscBootProgress {
    pub status: BrowserDiscBootStatus,
    pub commit: Option<BootCommitRecord>,
}

#[derive(Debug)]
enum ActiveBoot {
    Planning(DiscBootReader),
    Executing(BootLoadExecutor),
    Committed(CommittedBoot),
}

/// Owns boot-attempt epochs, exact reads, the retained image map, and the chunked load executor.
#[derive(Debug)]
pub struct BrowserDiscBootState {
    next_epoch: u64,
    current_epoch: Option<u64>,
    active: Option<ActiveBoot>,
    status: BrowserDiscBootStatus,
    fault: Option<BrowserDiscBootFault>,
}

impl Default for BrowserDiscBootState {
    fn default() -> Self {
        Self {
            next_epoch: 1,
            current_epoch: None,
            active: None,
            status: BrowserDiscBootStatus::Idle,
            fault: None,
        }
    }
}

impl BrowserDiscBootState {
    /// Begins one attempt and mints an epoch that the host cannot choose or reuse.
    pub fn begin(&mut self, container_bytes: u64) -> Result<u64, BrowserDiscBootError> {
        if self.current_epoch.is_some() {
            return Err(BrowserDiscBootError::ActiveBoot);
        }
        let epoch = self.next_epoch;
        let Some(next_epoch) = self.next_epoch.checked_add(1) else {
            self.status = BrowserDiscBootStatus::Failed;
            self.fault = Some(BrowserDiscBootFault::EpochExhausted);
            return Err(BrowserDiscBootError::EpochExhausted);
        };
        self.next_epoch = next_epoch;
        self.current_epoch = Some(epoch);
        self.fault = None;

        match DiscBootReader::new(container_bytes, epoch) {
            Ok(reader) => {
                self.active = Some(ActiveBoot::Planning(reader));
                self.status = BrowserDiscBootStatus::Planning;
                Ok(epoch)
            }
            Err(error) => {
                self.active = None;
                self.status = BrowserDiscBootStatus::Failed;
                self.fault = Some(BrowserDiscBootFault::Planning(error.clone()));
                Err(BrowserDiscBootError::Boot(error))
            }
        }
    }

    pub fn status(&self) -> BrowserDiscBootStatus {
        self.status
    }

    pub fn current_epoch(&self) -> Option<u64> {
        self.current_epoch
    }

    pub fn fault(&self) -> Option<&BrowserDiscBootFault> {
        self.fault.as_ref()
    }

    pub fn fault_code(&self) -> BrowserDiscBootFaultCode {
        self.fault
            .as_ref()
            .map_or(BrowserDiscBootFaultCode::None, BrowserDiscBootFault::code)
    }

    /// Transitional planner-stage visibility retained for focused Rust diagnostics.
    pub fn stage(&self) -> Option<BootReaderStage> {
        match self.active.as_ref() {
            Some(ActiveBoot::Planning(reader)) => Some(reader.stage()),
            _ => None,
        }
    }

    pub fn pending_count(&self) -> usize {
        match self.active.as_ref() {
            Some(ActiveBoot::Planning(reader)) => reader.requests().len(),
            Some(ActiveBoot::Executing(executor)) => executor.requests().len(),
            Some(ActiveBoot::Committed(_)) => 0,
            None => 0,
        }
    }

    /// Copies one pointer-free request identity for an asynchronous adapter.
    pub fn request(&self, index: usize) -> Option<ReadRequest> {
        match self.active.as_ref() {
            Some(ActiveBoot::Planning(reader)) => reader.requests().nth(index),
            Some(ActiveBoot::Executing(executor)) => executor.requests().nth(index),
            Some(ActiveBoot::Committed(_)) => None,
            None => None,
        }
    }

    /// Convenience iterator for native tests. Each item is an owned, pointer-free descriptor.
    pub fn requests(&self) -> impl ExactSizeIterator<Item = ReadRequest> + '_ {
        let count = self.pending_count();
        (0..count).map(|index| {
            self.request(index)
                .expect("the exact pending count must name every live request")
        })
    }

    /// Borrows the destination allocation for one exact, live request.
    ///
    /// Browser adapters must call this only after their asynchronous fetch has settled, copy the
    /// fetched bytes, and invoke [`Self::complete`] before yielding again.
    pub fn staging_mut(&mut self, request: ReadRequest) -> Result<&mut [u8], BrowserDiscBootError> {
        match self.active.as_mut() {
            Some(ActiveBoot::Planning(reader)) => reader
                .staging_mut(request)
                .map_err(BrowserDiscBootError::Completion),
            Some(ActiveBoot::Executing(executor)) => executor
                .staging_mut(request)
                .map_err(BrowserDiscBootError::Completion),
            Some(ActiveBoot::Committed(_)) => Err(BrowserDiscBootError::NoActiveBoot),
            None => Err(BrowserDiscBootError::NoActiveBoot),
        }
    }

    /// Authenticates one completion and advances planning/loading synchronously against MEM1.
    ///
    /// Wrong identities leave the authentic request live. Short reads and structural/load faults
    /// retire every request and leave an explicit terminal fault. The returned commit record is
    /// Rust-authored and appears only after the executor reaches `Committed`.
    pub fn complete(
        &mut self,
        request: ReadRequest,
        written: u32,
        mem1: &mut [u8],
    ) -> Result<BrowserDiscBootProgress, BrowserDiscBootError> {
        let Some(active) = self.active.take() else {
            return Err(BrowserDiscBootError::NoActiveBoot);
        };
        match active {
            ActiveBoot::Planning(mut reader) => {
                if let Err(error) = reader.complete(request, written) {
                    if let Some(failure) = reader.failure().cloned() {
                        self.status = BrowserDiscBootStatus::Failed;
                        self.fault = Some(BrowserDiscBootFault::Planning(failure));
                    }
                    self.active = Some(ActiveBoot::Planning(reader));
                    return Err(BrowserDiscBootError::Completion(error));
                }

                match reader.stage() {
                    BootReaderStage::Ready => self.start_executor(reader, mem1),
                    BootReaderStage::Failed => {
                        let failure = reader
                            .failure()
                            .cloned()
                            .expect("a failed disc reader retains its exact fault");
                        self.status = BrowserDiscBootStatus::Failed;
                        self.fault = Some(BrowserDiscBootFault::Planning(failure.clone()));
                        self.active = Some(ActiveBoot::Planning(reader));
                        Err(BrowserDiscBootError::Boot(failure))
                    }
                    _ => {
                        self.status = BrowserDiscBootStatus::Planning;
                        self.active = Some(ActiveBoot::Planning(reader));
                        Ok(BrowserDiscBootProgress {
                            status: self.status,
                            commit: None,
                        })
                    }
                }
            }
            ActiveBoot::Executing(mut executor) => {
                let mut memory = BootMem1Slice::new(mem1);
                if let Err(error) = executor.complete(request, written, &mut memory) {
                    if let Some(failure) = executor.failure().cloned() {
                        self.status = BrowserDiscBootStatus::Failed;
                        self.fault = Some(BrowserDiscBootFault::Loading(failure));
                    }
                    self.active = Some(ActiveBoot::Executing(executor));
                    return Err(BrowserDiscBootError::LoadCompletion(error));
                }
                Ok(self.finish_executor_step(executor))
            }
            ActiveBoot::Committed(committed) => {
                self.active = Some(ActiveBoot::Committed(committed));
                Err(BrowserDiscBootError::NoActiveBoot)
            }
        }
    }

    pub fn plan(&self) -> Option<&BootLoadPlan> {
        match self.active.as_ref() {
            Some(ActiveBoot::Planning(reader)) => reader.plan(),
            Some(ActiveBoot::Executing(executor)) => Some(executor.plan()),
            Some(ActiveBoot::Committed(committed)) => Some(&committed.plan),
            None => None,
        }
    }

    /// Compatibility accessor for planner failures. Executor failures are available via `fault`.
    pub fn failure(&self) -> Option<&BootError> {
        match self.active.as_ref() {
            Some(ActiveBoot::Planning(reader)) => reader.failure(),
            _ => None,
        }
    }

    pub fn commit(&self) -> Option<&BootCommitRecord> {
        match self.active.as_ref() {
            Some(ActiveBoot::Executing(executor)) => executor.commit(),
            Some(ActiveBoot::Committed(committed)) => Some(&committed.commit),
            _ => None,
        }
    }

    /// The unique post-boot logical-disc mapper moved out of the terminal executor.
    pub fn committed_disc_reader(&self) -> Option<&CommittedDiscReader> {
        match self.active.as_ref() {
            Some(ActiveBoot::Committed(committed)) => Some(&committed.reader),
            _ => None,
        }
    }

    /// Mutable access remains Rust-only so resident DI can authenticate and fill its private
    /// staging payload without exposing CISO placement policy to the browser.
    pub fn committed_disc_reader_mut(&mut self) -> Option<&mut CommittedDiscReader> {
        match self.active.as_mut() {
            Some(ActiveBoot::Committed(committed)) => Some(&mut committed.reader),
            _ => None,
        }
    }

    /// Explicitly retires the current epoch, retained CISO map, executor, and all requests.
    pub fn cancel(&mut self) -> bool {
        if self.current_epoch.is_none() && self.status != BrowserDiscBootStatus::Failed {
            return false;
        }
        if let Some(ActiveBoot::Executing(executor)) = self.active.as_mut() {
            let _ = executor.cancel();
        }
        self.active = None;
        self.current_epoch = None;
        self.fault = None;
        self.status = BrowserDiscBootStatus::Cancelled;
        true
    }

    fn start_executor(
        &mut self,
        reader: DiscBootReader,
        mem1: &mut [u8],
    ) -> Result<BrowserDiscBootProgress, BrowserDiscBootError> {
        let mut executor = match reader.into_load_executor(MAX_BOOT_LOAD_CHUNK_BYTES) {
            Ok(executor) => executor,
            Err(error) => {
                self.status = BrowserDiscBootStatus::Failed;
                self.fault = Some(BrowserDiscBootFault::LoadStart(error.clone()));
                return Err(BrowserDiscBootError::LoadStart(error));
            }
        };
        let mut memory = BootMem1Slice::new(mem1);
        if let Err(error) = executor.advance(&mut memory) {
            self.status = BrowserDiscBootStatus::Failed;
            self.fault = Some(BrowserDiscBootFault::Loading(error.clone()));
            self.active = Some(ActiveBoot::Executing(executor));
            return Err(BrowserDiscBootError::LoadCompletion(
                BootLoadCompletionError::Load(error),
            ));
        }
        Ok(self.finish_executor_step(executor))
    }

    fn finish_executor_step(&mut self, executor: BootLoadExecutor) -> BrowserDiscBootProgress {
        if executor.stage() == BootLoadExecutorStage::Committed {
            let committed = executor
                .into_committed_disc()
                .expect("a terminal boot executor must yield its authenticated disc mapper");
            let commit = Some(committed.commit.clone());
            self.status = BrowserDiscBootStatus::Committed;
            self.active = Some(ActiveBoot::Committed(committed));
            return BrowserDiscBootProgress {
                status: self.status,
                commit,
            };
        }

        self.status = match executor.stage() {
            BootLoadExecutorStage::Loading => BrowserDiscBootStatus::Loading,
            BootLoadExecutorStage::Failed => BrowserDiscBootStatus::Failed,
            BootLoadExecutorStage::Cancelled => BrowserDiscBootStatus::Cancelled,
            BootLoadExecutorStage::Committed => unreachable!("handled above"),
        };
        self.active = Some(ActiveBoot::Executing(executor));
        BrowserDiscBootProgress {
            status: self.status,
            commit: None,
        }
    }
}

/// Builds the exact low-memory handoff without mutating canonical MEM1.
///
/// The caller copies this complete image and sets PC in the same synchronous terminal section,
/// after observing a [`BootCommitRecord`]. Keeping construction side-effect-free makes it trivial
/// to prove that no parser or partial load can publish boot words.
pub fn committed_low_memory(
    previous: &[u8; BOOT_LOW_MEMORY_BYTES],
    commit: &BootCommitRecord,
) -> [u8; BOOT_LOW_MEMORY_BYTES] {
    let mut low = *previous;
    let identity = &commit.identity;
    write_be_u32(&mut low, 0x00, identity.game_code);
    write_be_u16(&mut low, 0x04, identity.maker_code);
    low[0x06] = identity.disc_id;
    low[0x07] = identity.version;
    low[0x08] = identity.audio_streaming;
    low[0x09] = identity.stream_buffer_size;
    write_be_u32(&mut low, 0x1c, 0xc233_9f3d);
    write_be_u32(&mut low, 0x20, 0x0d15_ea5e);
    write_be_u32(&mut low, 0x24, 1);
    write_be_u32(&mut low, 0x28, 0x0180_0000);
    write_be_u32(&mut low, 0x2c, 0x1000_0005);
    write_be_u32(&mut low, 0x30, 0);
    write_be_u32(&mut low, 0x34, commit.fst_address);
    write_be_u32(&mut low, 0x38, commit.fst_address);
    write_be_u32(&mut low, 0x3c, commit.fst_max_bytes);
    write_be_u32(&mut low, 0xcc, identity.tv_mode);
    write_be_u32(&mut low, 0xd0, 0x0100_0000);
    write_be_u32(&mut low, 0xf4, commit.bi2_address);
    write_be_u32(&mut low, 0xf8, 0x09a7_ec80);
    write_be_u32(&mut low, 0xfc, 0x1cf7_c580);
    low
}

fn write_be_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}

fn write_be_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}
