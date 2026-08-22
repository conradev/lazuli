//! Integer-only asynchronous storage boundary for resident Rust DI.
//!
//! DI owns command decoding, timing, DMA state, the complete private atomic payload, and its
//! sequential logical windows. The committed disc reader owns raw/CISO logical placement. This
//! adapter only binds those two Rust state machines and reveals copied physical container ranges
//! to the browser. A staging pointer is deliberately absent from every copied request: after an
//! async fetch settles, the caller must reauthenticate the descriptor and reacquire the exact
//! sub-slice of DI's private payload before copying bytes synchronously.

use lazuli::disks::async_boot::{
    CommittedDiscReadError, CommittedDiscReadProgress, CommittedDiscReader, LogicalReadIdentity,
    ReadRequest,
};
use lazuli::system::di::{DiscReadCompletionError, DiscReadRequest, Interface};
use lazuli_abi::HostCompletionStatus;

/// Stable result vocabulary for the browser's integer-only completion call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum BrowserDiCallResult {
    Rejected           = 0,
    Accepted           = 1,
    LogicalWindowReady = 2,
    DeviceReadFailed   = 3,
    NoPendingRead      = 4,
    StaleRequest       = 5,
    UnknownRequest     = 6,
    DescriptorMismatch = 7,
    LogicalIdentityMismatch = 8,
    InvalidHostStatus  = 9,
    HostLengthMismatch = 10,
    MapperFailure      = 11,
    DeviceProtocolFailure = 12,
}

/// Detailed Rust-side integration failures. The browser only needs [`Self::call_result`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserDiError {
    NoCommittedDisc,
    NoPendingRead,
    ActiveLogicalReadChanged {
        expected: DiscReadRequest,
        observed: Option<DiscReadRequest>,
    },
    InvalidHostStatus(u32),
    HostLengthMismatch {
        expected: u32,
        written: u32,
    },
    Mapper(CommittedDiscReadError),
    Device(DiscReadCompletionError),
}

/// Copy-only accounting authored by the Rust browser/committed-image boundary.
///
/// A request is counted exactly once when its physical identity is first published. Repeated Wasm
/// scalar accessors for that descriptor do not change these totals.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BrowserDiLifecycleEvidence {
    pub physical_host_requests_issued: u64,
    pub physical_host_requests_cancelled: u64,
    pub host_receipts_succeeded: u64,
    pub host_receipts_failed: u64,
    pub host_receipts_rejected: u64,
    pub logical_windows_ready: u64,
    pub logical_windows_failed: u64,
    pub physical_host_request_pending: bool,
}

#[derive(Debug)]
struct BrowserDiEvidenceOwner {
    counters: BrowserDiLifecycleEvidence,
    healthy: bool,
}

impl Default for BrowserDiEvidenceOwner {
    fn default() -> Self {
        Self {
            counters: BrowserDiLifecycleEvidence::default(),
            healthy: true,
        }
    }
}

impl BrowserDiEvidenceOwner {
    fn add(&mut self, select: impl FnOnce(&mut BrowserDiLifecycleEvidence) -> &mut u64) {
        if !self.healthy {
            return;
        }
        let counter = select(&mut self.counters);
        let Some(next) = counter.checked_add(1) else {
            self.healthy = false;
            return;
        };
        *counter = next;
    }

    fn publish(&mut self) {
        self.add(|counters| &mut counters.physical_host_requests_issued);
        self.counters.physical_host_request_pending = true;
    }

    fn retire_succeeded(&mut self) {
        self.add(|counters| &mut counters.host_receipts_succeeded);
        self.counters.physical_host_request_pending = false;
    }

    fn retire_failed(&mut self) {
        self.add(|counters| &mut counters.host_receipts_failed);
        self.counters.physical_host_request_pending = false;
    }

    fn retire_cancelled(&mut self) {
        self.add(|counters| &mut counters.physical_host_requests_cancelled);
        self.counters.physical_host_request_pending = false;
    }

    fn reject_receipt(&mut self) {
        self.add(|counters| &mut counters.host_receipts_rejected);
    }

    fn logical_ready(&mut self) {
        self.add(|counters| &mut counters.logical_windows_ready);
    }

    fn logical_failed(&mut self) {
        self.add(|counters| &mut counters.logical_windows_failed);
    }

    fn fail_closed(&mut self) {
        self.healthy = false;
    }

    fn snapshot(&self) -> Option<BrowserDiLifecycleEvidence> {
        self.healthy.then_some(self.counters)
    }
}

impl BrowserDiError {
    #[must_use]
    pub fn call_result(self) -> BrowserDiCallResult {
        match self {
            Self::NoCommittedDisc | Self::NoPendingRead => BrowserDiCallResult::NoPendingRead,
            Self::InvalidHostStatus(_) => BrowserDiCallResult::InvalidHostStatus,
            Self::HostLengthMismatch { .. } => BrowserDiCallResult::HostLengthMismatch,
            Self::ActiveLogicalReadChanged { .. } => BrowserDiCallResult::LogicalIdentityMismatch,
            Self::Mapper(CommittedDiscReadError::StaleRequest { .. }) => {
                BrowserDiCallResult::StaleRequest
            }
            Self::Mapper(CommittedDiscReadError::ShortRead { .. }) => {
                BrowserDiCallResult::HostLengthMismatch
            }
            Self::Mapper(
                CommittedDiscReadError::UnknownRequest { .. }
                | CommittedDiscReadError::NoActiveRead,
            ) => BrowserDiCallResult::UnknownRequest,
            Self::Mapper(CommittedDiscReadError::DescriptorMismatch { .. }) => {
                BrowserDiCallResult::DescriptorMismatch
            }
            Self::Mapper(
                CommittedDiscReadError::LogicalIdentityMismatch { .. }
                | CommittedDiscReadError::Busy { .. },
            ) => BrowserDiCallResult::LogicalIdentityMismatch,
            Self::Mapper(_) => BrowserDiCallResult::MapperFailure,
            Self::Device(DiscReadCompletionError::StaleRequest { .. }) => {
                BrowserDiCallResult::StaleRequest
            }
            Self::Device(DiscReadCompletionError::UnknownRequest { .. }) => {
                BrowserDiCallResult::UnknownRequest
            }
            Self::Device(
                DiscReadCompletionError::DescriptorMismatch { .. }
                | DiscReadCompletionError::OutOfOrderRequest { .. },
            ) => BrowserDiCallResult::DescriptorMismatch,
            Self::Device(_) => BrowserDiCallResult::DeviceProtocolFailure,
        }
    }
}

/// The small piece of adapter protocol state not owned by DI or the committed image mapper.
#[derive(Debug, Default)]
pub struct BrowserDiRuntime {
    active_logical: Option<DiscReadRequest>,
    published_physical: Option<ReadRequest>,
    evidence: BrowserDiEvidenceOwner,
}

impl BrowserDiRuntime {
    #[must_use]
    pub fn active_logical_request(&self) -> Option<DiscReadRequest> {
        self.active_logical
    }

    #[must_use]
    pub fn lifecycle_evidence(&self) -> Option<BrowserDiLifecycleEvidence> {
        self.evidence.snapshot()
    }

    fn publish_physical_request(&mut self, request: ReadRequest) -> ReadRequest {
        match self.published_physical {
            Some(published) if published == request => {}
            Some(_) => self.evidence.fail_closed(),
            None => {
                self.published_physical = Some(request);
                self.evidence.publish();
            }
        }
        request
    }

    fn retire_published_succeeded(&mut self, request: ReadRequest) {
        if self.published_physical == Some(request) {
            self.published_physical = None;
            self.evidence.retire_succeeded();
        } else {
            self.evidence.fail_closed();
        }
    }

    fn retire_published_failed(&mut self, request: ReadRequest) {
        if self.published_physical == Some(request) {
            self.published_physical = None;
            self.evidence.retire_failed();
        } else {
            self.evidence.fail_closed();
        }
    }

    /// Prepares the next physical host range, completing fully sparse logical windows locally.
    ///
    /// A legal maximum DI transfer can contain 96 logical windows. This bounded loop avoids a
    /// browser round trip for any number of consecutive fully sparse CISO windows while retaining
    /// only DI's one full private payload allocation.
    pub fn prepare(
        &mut self,
        disk: &mut Interface,
        reader: &mut CommittedDiscReader,
    ) -> Result<Option<ReadRequest>, BrowserDiError> {
        loop {
            let Some(logical) = disk.resident_read_request() else {
                if let Some(expected) = self.active_logical {
                    return Err(BrowserDiError::ActiveLogicalReadChanged {
                        expected,
                        observed: None,
                    });
                }
                if self.published_physical.is_some() {
                    self.evidence.fail_closed();
                }
                return Ok(None);
            };
            if let Some(expected) = self.active_logical {
                if expected != logical {
                    return Err(BrowserDiError::ActiveLogicalReadChanged {
                        expected,
                        observed: Some(logical),
                    });
                }
                let request = reader.request();
                if request.is_none() {
                    self.evidence.fail_closed();
                }
                return Ok(request.map(|request| self.publish_physical_request(request)));
            }

            let identity = logical_identity(logical);
            let progress = {
                let staging = disk
                    .resident_read_staging_mut(logical)
                    .map_err(BrowserDiError::Device)?;
                reader
                    .begin(identity, staging)
                    .map_err(BrowserDiError::Mapper)?
            };
            match progress {
                CommittedDiscReadProgress::HostRead(request) => {
                    self.active_logical = Some(logical);
                    return Ok(Some(self.publish_physical_request(request)));
                }
                CommittedDiscReadProgress::Ready(ready) => {
                    debug_assert_eq!(ready, identity);
                    if let Err(error) = disk.complete_resident_disc_read(logical, logical.length) {
                        self.evidence.fail_closed();
                        return Err(BrowserDiError::Device(error));
                    }
                    self.evidence.logical_ready();
                    // DI may publish the next <=256 KiB window from the same atomic payload.
                }
            }
        }
    }

    /// Reauthenticates a copied physical descriptor and lends its exact DI payload sub-slice.
    /// The returned borrow must be filled and completed synchronously before browser code yields.
    pub fn staging_mut<'a>(
        &mut self,
        disk: &'a mut Interface,
        reader: &mut CommittedDiscReader,
        request: ReadRequest,
    ) -> Result<&'a mut [u8], BrowserDiError> {
        let logical = self.live_logical_request(disk)?;
        let staging = disk
            .resident_read_staging_mut(logical)
            .map_err(BrowserDiError::Device)?;
        reader
            .staging_mut(logical_identity(logical), request, staging)
            .map_err(BrowserDiError::Mapper)
    }

    /// Applies one host receipt. Only `Ok` consumes initialized bytes; every known failure status
    /// authenticates and retires the physical request, then marks DI's private payload failed.
    /// Unknown status values and identity mismatches leave the authentic request live.
    pub fn complete(
        &mut self,
        disk: &mut Interface,
        reader: &mut CommittedDiscReader,
        request: ReadRequest,
        written: u32,
        status_raw: u32,
    ) -> Result<BrowserDiCallResult, BrowserDiError> {
        let Ok(status) = HostCompletionStatus::try_from(status_raw) else {
            self.evidence.reject_receipt();
            return Err(BrowserDiError::InvalidHostStatus(status_raw));
        };
        let Some(logical) = self.active_logical else {
            // Ask the mapper to classify a duplicate/late physical identity without touching DI.
            let retired = LogicalReadIdentity {
                epoch: 0,
                id: 0,
                logical_offset: 0,
                length: 0,
            };
            let result = reader
                .fail(retired, request)
                .map(|()| BrowserDiCallResult::Rejected)
                .map_err(BrowserDiError::Mapper);
            self.evidence.reject_receipt();
            return result;
        };
        let observed = disk.resident_read_request();
        if observed != Some(logical) {
            self.evidence.reject_receipt();
            return Err(BrowserDiError::ActiveLogicalReadChanged {
                expected: logical,
                observed,
            });
        }
        let identity = logical_identity(logical);

        if status != HostCompletionStatus::Ok {
            if let Err(error) = reader.fail(identity, request) {
                self.evidence.reject_receipt();
                return Err(BrowserDiError::Mapper(error));
            }
            self.retire_published_failed(request);
            if let Err(error) = disk.fail_resident_disc_read(logical) {
                self.evidence.fail_closed();
                return Err(BrowserDiError::Device(error));
            }
            self.evidence.logical_failed();
            self.active_logical = None;
            return Ok(BrowserDiCallResult::DeviceReadFailed);
        }
        if written != request.length {
            if let Err(error) = reader.fail(identity, request) {
                self.evidence.reject_receipt();
                return Err(BrowserDiError::Mapper(error));
            }
            self.retire_published_failed(request);
            if let Err(error) = disk.fail_resident_disc_read(logical) {
                self.evidence.fail_closed();
                return Err(BrowserDiError::Device(error));
            }
            self.evidence.logical_failed();
            self.active_logical = None;
            return Err(BrowserDiError::HostLengthMismatch {
                expected: request.length,
                written,
            });
        }

        let progress = match reader.complete(identity, request, written) {
            Ok(progress) => progress,
            Err(error) => {
                self.evidence.reject_receipt();
                return Err(BrowserDiError::Mapper(error));
            }
        };
        self.retire_published_succeeded(request);
        match progress {
            CommittedDiscReadProgress::HostRead(_) => Ok(BrowserDiCallResult::Accepted),
            CommittedDiscReadProgress::Ready(ready) => {
                debug_assert_eq!(ready, identity);
                if let Err(error) = disk.complete_resident_disc_read(logical, logical.length) {
                    self.evidence.fail_closed();
                    return Err(BrowserDiError::Device(error));
                }
                self.evidence.logical_ready();
                self.active_logical = None;
                Ok(BrowserDiCallResult::LogicalWindowReady)
            }
        }
    }

    /// Retires the adapter side of one reset/eject before the committed image mapper is dropped.
    pub fn cancel(&mut self, reader: &mut CommittedDiscReader) -> bool {
        let Some(logical) = self.active_logical.take() else {
            return false;
        };
        let cancelled = reader.cancel(logical_identity(logical));
        match (self.published_physical.take(), cancelled) {
            (Some(_), true) => {
                self.evidence.retire_cancelled();
            }
            (Some(_), false) | (None, _) => {
                self.evidence.fail_closed();
            }
        }
        cancelled
    }

    /// Clears adapter bookkeeping when the committed image itself has already been dropped.
    pub fn abandon(&mut self) -> bool {
        let abandoned = self.active_logical.take().is_some();
        match (abandoned, self.published_physical.take()) {
            (true, Some(_)) => self.evidence.retire_cancelled(),
            (false, None) => {}
            (false, Some(_)) => {
                self.evidence.retire_cancelled();
                self.evidence.fail_closed();
            }
            (true, None) => self.evidence.fail_closed(),
        }
        abandoned
    }

    fn live_logical_request(&self, disk: &Interface) -> Result<DiscReadRequest, BrowserDiError> {
        let Some(expected) = self.active_logical else {
            return Err(BrowserDiError::NoPendingRead);
        };
        let observed = disk.resident_read_request();
        if observed != Some(expected) {
            return Err(BrowserDiError::ActiveLogicalReadChanged { expected, observed });
        }
        Ok(expected)
    }
}

#[inline(always)]
fn logical_identity(request: DiscReadRequest) -> LogicalReadIdentity {
    LogicalReadIdentity {
        epoch: request.epoch,
        id: request.id,
        logical_offset: request.disc_offset,
        length: request.length,
    }
}
