//! Authenticated asynchronous boundary between the resident GX machine and a renderer host.
//!
//! Rust owns every semantic input and commit destination. The host receives one copied
//! [`HostRequest`] containing an immutable opaque LZGX packet range and one exact response
//! staging range. After an `await`, callers must present the copied record again and reacquire the
//! staging slice; no Rust pointer or borrowed view crosses that suspension point.

use std::collections::VecDeque;

use lazuli_abi::{
    HostCompletion, HostCompletionStatus, HostRequest, HostRequestKind,
    RENDER_RECEIPT_HAS_EFB_VALUE, RENDER_RECEIPT_HAS_PRESENTATION, RENDER_REQUEST_VI_PRESENT,
    RecordHeader, RenderPresentationStatus, RenderReceipt, RenderReceiptKind, RenderReceiptStatus,
    SharedPtr, SharedSlice, ViFieldParity, ViPresentationMode, ViPresentationRequest,
};
use lzgx_packet::{EnvelopeInfo, PacketError, TerminalKind, TerminalState, inspect_envelope};
use sha2::{Digest, Sha256};

/// Maximum number of renderer operations that may own packet and receipt storage concurrently.
pub const MAX_PENDING_RENDER_REQUESTS: usize = 8;
/// Per-request opaque LZGX packet bound.
pub const MAX_RENDER_PACKET_BYTES: usize = 32 * 1024 * 1024;
/// Per-request materialized texture-copy payload bound, excluding the fixed receipt.
pub const MAX_RENDER_RECEIPT_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
/// Aggregate packet plus receipt storage retained by this boundary.
pub const MAX_PENDING_RENDER_BYTES: usize = 64 * 1024 * 1024;

const RETIRED_RENDER_IDENTITIES: usize = 16;

/// Which one-use identity counter could not advance without wrapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderCounter {
    RequestId,
    RequestNonce,
    Sequence,
}

/// A renderer request could not be constructed without weakening a bound or invariant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderSubmitError {
    Packet(PacketError),
    PacketTooLarge,
    ReceiptTooLarge,
    PendingQueueFull,
    PendingByteBudget,
    Allocation,
    InvalidCommitPlan,
    CommitKindMismatch,
    InvalidSharedRange,
    CounterOverflow(RenderCounter),
    InvalidNonceSeed,
    InternalAccounting,
    CommitInProgress,
}

/// Failure while authenticating a host-visible request or applying its one-use completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderCompletionError {
    NoPendingRequest,
    StaleRequest,
    DuplicateRequest,
    MutatedRequestRecord,
    ReorderedReceipt {
        expected_sequence: u64,
        observed_sequence: u64,
    },
    CompletionIdentityMismatch,
    MalformedCompletionRecord,
    UnknownHostStatus(u32),
    InvalidFilledLength,
    PacketMutated,
    MalformedReceipt,
    WrongSequence,
    WrongKind,
    WrongGeneration,
    WrongReceiptPayload,
    WrongReceiptOptionals,
    CommitInProgress,
}

/// Private metadata needed to scatter a compact texture-copy result later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextureCopyMaterialization {
    row_bytes: u32,
    row_count: u32,
    copy_format: u32,
    base_format: u32,
}

impl TextureCopyMaterialization {
    #[must_use]
    pub const fn new(
        row_bytes: u32,
        row_count: u32,
        copy_format: u32,
        base_format: u32,
    ) -> Option<Self> {
        if row_bytes == 0 || row_count == 0 {
            return None;
        }
        Some(Self {
            row_bytes,
            row_count,
            copy_format,
            base_format,
        })
    }

    #[must_use]
    pub const fn row_bytes(self) -> u32 {
        self.row_bytes
    }

    #[must_use]
    pub const fn row_count(self) -> u32 {
        self.row_count
    }

    #[must_use]
    pub const fn copy_format(self) -> u32 {
        self.copy_format
    }

    #[must_use]
    pub const fn base_format(self) -> u32 {
        self.base_format
    }

    fn payload_len(self) -> Option<u32> {
        self.row_bytes.checked_mul(self.row_count)
    }
}

/// Private semantic plan for one distinct VI field-selection operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViPresentationCommitPlan {
    selected_address: u32,
    expected_generation: u32,
    selected_row: u32,
    mode: ViPresentationMode,
    parity: ViFieldParity,
    pair_epoch: u32,
    output_width: u32,
    output_height: u32,
    field_stride_bytes: u32,
    field_height: u32,
    row_repeat: u32,
    pair_completing: bool,
}

impl ViPresentationCommitPlan {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        selected_address: u32,
        expected_generation: u32,
        selected_row: u32,
        mode: ViPresentationMode,
        parity: ViFieldParity,
        pair_epoch: u32,
        output_width: u32,
        output_height: u32,
        field_stride_bytes: u32,
        field_height: u32,
        row_repeat: u32,
        pair_completing: bool,
    ) -> Option<Self> {
        if expected_generation == 0
            || pair_epoch == 0
            || output_width == 0
            || output_height == 0
            || field_stride_bytes == 0
            || field_height == 0
            || row_repeat == 0
            || (!matches!(mode, ViPresentationMode::Interlaced) && !pair_completing)
        {
            return None;
        }
        Some(Self {
            selected_address,
            expected_generation,
            selected_row,
            mode,
            parity,
            pair_epoch,
            output_width,
            output_height,
            field_stride_bytes,
            field_height,
            row_repeat,
            pair_completing,
        })
    }

    #[must_use]
    pub const fn pair_epoch(self) -> u32 {
        self.pair_epoch
    }

    #[must_use]
    pub const fn selected_address(self) -> u32 {
        self.selected_address
    }

    #[must_use]
    pub const fn expected_generation(self) -> u32 {
        self.expected_generation
    }

    #[must_use]
    pub const fn selected_row(self) -> u32 {
        self.selected_row
    }

    #[must_use]
    pub const fn mode(self) -> ViPresentationMode {
        self.mode
    }

    #[must_use]
    pub const fn parity(self) -> ViFieldParity {
        self.parity
    }

    #[must_use]
    pub const fn output_width(self) -> u32 {
        self.output_width
    }

    #[must_use]
    pub const fn output_height(self) -> u32 {
        self.output_height
    }

    #[must_use]
    pub const fn field_stride_bytes(self) -> u32 {
        self.field_stride_bytes
    }

    #[must_use]
    pub const fn field_height(self) -> u32 {
        self.field_height
    }

    #[must_use]
    pub const fn row_repeat(self) -> u32 {
        self.row_repeat
    }

    #[must_use]
    pub const fn pair_completing(self) -> bool {
        self.pair_completing
    }

    fn request(self, sequence: u64) -> ViPresentationRequest {
        ViPresentationRequest::new(
            sequence,
            self.selected_address,
            self.expected_generation,
            self.selected_row,
            self.mode,
            self.parity,
            self.pair_epoch,
            self.output_width,
            self.output_height,
            self.field_stride_bytes,
            self.field_height,
            self.row_repeat,
            self.pair_completing,
        )
    }
}

/// Rust-only metadata supplement not redundantly represented by the LZGX envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderCommitSupplement {
    TextureCopy(Option<TextureCopyMaterialization>),
    XfbCopy,
    EfbPeek,
}

/// Complete private plan retained until an authenticated receipt is consumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderCommitPlan {
    TextureCopy {
        terminal: TerminalState,
        materialization: Option<TextureCopyMaterialization>,
    },
    XfbCopy {
        terminal: TerminalState,
    },
    EfbPeek {
        terminal: TerminalState,
    },
    ViPresent {
        presentation: ViPresentationCommitPlan,
    },
}

impl RenderCommitPlan {
    #[must_use]
    pub const fn terminal(&self) -> Option<TerminalState> {
        match self {
            Self::TextureCopy { terminal, .. }
            | Self::XfbCopy { terminal }
            | Self::EfbPeek { terminal } => Some(*terminal),
            Self::ViPresent { .. } => None,
        }
    }

    #[must_use]
    pub const fn kind(&self) -> RenderReceiptKind {
        match self {
            Self::TextureCopy { .. } => RenderReceiptKind::TextureCopy,
            Self::XfbCopy { .. } => RenderReceiptKind::XfbCopy,
            Self::EfbPeek { .. } => RenderReceiptKind::EfbPeek,
            Self::ViPresent { .. } => RenderReceiptKind::ViPresent,
        }
    }

    #[must_use]
    pub const fn texture_materialization(&self) -> Option<TextureCopyMaterialization> {
        match self {
            Self::TextureCopy {
                materialization, ..
            } => *materialization,
            _ => None,
        }
    }

    #[must_use]
    pub const fn vi_presentation(&self) -> Option<ViPresentationCommitPlan> {
        match self {
            Self::ViPresent { presentation } => Some(*presentation),
            _ => None,
        }
    }

    const fn generation(&self) -> u32 {
        match self {
            Self::TextureCopy { terminal, .. }
            | Self::XfbCopy { terminal }
            | Self::EfbPeek { terminal } => terminal.generation,
            Self::ViPresent { presentation } => presentation.expected_generation,
        }
    }

    fn expected_payload_len(&self) -> u32 {
        self.texture_materialization()
            .and_then(TextureCopyMaterialization::payload_len)
            .unwrap_or(0)
    }
}

/// Authenticated renderer presentation observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderPresentation {
    pub status: RenderPresentationStatus,
    pub epoch: u32,
    pub width: u32,
    pub height: u32,
    pub serial: u64,
}

/// Successful one-use completion. It retains the private plan until the machine applies it.
#[derive(Debug)]
pub struct CommittedRender<'runtime> {
    runtime: &'runtime mut RenderRuntime,
}

impl CommittedRender<'_> {
    #[must_use]
    pub fn sequence(&self) -> u64 {
        self.runtime
            .active_commit
            .as_ref()
            .map_or(0, |active| active.pending.sequence)
    }

    #[must_use]
    pub fn plan(&self) -> Option<&RenderCommitPlan> {
        self.runtime
            .active_commit
            .as_ref()
            .map(|active| &active.pending.plan)
    }

    #[must_use]
    pub fn texture_copy_bytes(&self) -> Option<&[u8]> {
        let pending = &self.runtime.active_commit.as_ref()?.pending;
        let materialization = pending.plan.texture_materialization()?;
        let payload_len = usize::try_from(materialization.payload_len()?).ok()?;
        pending
            .response
            .get(RenderReceipt::BYTE_LEN..RenderReceipt::BYTE_LEN + payload_len)
    }

    /// Bytes whose accounting remains charged until this commit lease is dropped.
    #[must_use]
    pub fn retained_bytes(&self) -> Option<usize> {
        self.runtime
            .active_commit
            .as_ref()?
            .pending
            .accounted_bytes()
    }

    #[must_use]
    pub fn efb_value(&self) -> Option<u32> {
        let active = self.runtime.active_commit.as_ref()?;
        match active.pending.plan {
            RenderCommitPlan::EfbPeek { .. } => Some(active.receipt.efb_value),
            _ => None,
        }
    }

    #[must_use]
    pub fn presentation(&self) -> Option<RenderPresentation> {
        let receipt = self.runtime.active_commit.as_ref()?.receipt;
        if receipt.flags & RENDER_RECEIPT_HAS_PRESENTATION == 0 {
            return None;
        }
        Some(RenderPresentation {
            status: match receipt.presentation_status() {
                Ok(status) => status,
                Err(_) => return None,
            },
            epoch: receipt.presentation_epoch,
            width: receipt.presentation_width,
            height: receipt.presentation_height,
            serial: receipt.presentation_serial(),
        })
    }
}

impl Drop for CommittedRender<'_> {
    fn drop(&mut self) {
        self.runtime.finish_active_commit();
    }
}

/// A known host/renderer failure consumes its exact request but carries no machine commit plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderFailure {
    Host(HostCompletionStatus),
    Renderer(RenderReceiptStatus),
}

/// Result of consuming one exact outstanding renderer request.
#[derive(Debug)]
pub enum RenderCompletion<'runtime> {
    Committed(CommittedRender<'runtime>),
    Failed {
        sequence: u64,
        failure: RenderFailure,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RenderIdentity {
    request_id: u32,
    nonce: u64,
}

impl RenderIdentity {
    const fn from_request(request: HostRequest) -> Self {
        Self {
            request_id: request.request_id,
            nonce: request.request_nonce(),
        }
    }
}

#[derive(Debug)]
struct PendingRender {
    packet: Vec<u8>,
    response: Vec<u8>,
    packet_sha256: [u8; 32],
    exact_request: HostRequest,
    sequence: u64,
    plan: RenderCommitPlan,
}

#[derive(Debug)]
struct ActiveRenderCommit {
    pending: PendingRender,
    receipt: RenderReceipt,
}

impl PendingRender {
    fn accounted_bytes(&self) -> Option<usize> {
        self.packet.capacity().checked_add(self.response.capacity())
    }
}

/// Bounded Rust owner of all outstanding renderer transactions.
#[derive(Debug)]
pub struct RenderRuntime {
    pending: VecDeque<PendingRender>,
    active_commit: Option<ActiveRenderCommit>,
    pending_bytes: usize,
    next_request_id: u32,
    next_nonce: u64,
    next_sequence: u64,
    retired: [Option<RenderIdentity>; RETIRED_RENDER_IDENTITIES],
    retired_cursor: usize,
    accounting_fault: bool,
}

impl RenderRuntime {
    /// Creates a runtime with a nonzero private nonce seed.
    pub fn new(first_nonce: u64) -> Result<Self, RenderSubmitError> {
        if first_nonce == 0 {
            return Err(RenderSubmitError::InvalidNonceSeed);
        }
        let mut pending = VecDeque::new();
        pending
            .try_reserve_exact(MAX_PENDING_RENDER_REQUESTS)
            .map_err(|_| RenderSubmitError::Allocation)?;
        Ok(Self {
            pending,
            active_commit: None,
            pending_bytes: 0,
            next_request_id: 1,
            next_nonce: first_nonce,
            next_sequence: 1,
            retired: [None; RETIRED_RENDER_IDENTITIES],
            retired_cursor: 0,
            accounting_fault: false,
        })
    }

    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.pending.len() + usize::from(self.active_commit.is_some())
    }

    #[must_use]
    pub const fn pending_bytes(&self) -> usize {
        self.pending_bytes
    }

    /// Returns a copy of one host request. No private plan or mutable pointer is exposed.
    #[must_use]
    pub fn request(&self, index: usize) -> Option<HostRequest> {
        self.pending.get(index).map(|pending| pending.exact_request)
    }

    /// Reauthenticates the copied request and lends its opaque packet only for synchronous use.
    pub fn packet_bytes(&self, observed: HostRequest) -> Result<&[u8], RenderCompletionError> {
        let index = self.authenticate_request(observed)?;
        Ok(&self.pending[index].packet)
    }

    /// Reauthenticates after any host suspension and lends the exact fixed response slice.
    pub fn receipt_staging_mut(
        &mut self,
        observed: HostRequest,
    ) -> Result<&mut [u8], RenderCompletionError> {
        let index = self.authenticate_request(observed)?;
        Ok(&mut self.pending[index].response)
    }

    /// Enqueues an opaque packet using its actual stable Wasm offsets.
    #[cfg(target_arch = "wasm32")]
    #[cfg_attr(test, allow(dead_code))]
    pub fn submit(
        &mut self,
        packet: Vec<u8>,
        supplement: RenderCommitSupplement,
    ) -> Result<HostRequest, RenderSubmitError> {
        self.submit_inner(packet, supplement, None)
    }

    /// Native/contract seam assigning modelled linear-memory offsets without truncating pointers.
    #[cfg(any(test, not(target_arch = "wasm32")))]
    pub fn submit_at(
        &mut self,
        packet: Vec<u8>,
        supplement: RenderCommitSupplement,
        packet_ptr: SharedPtr,
        receipt_ptr: SharedPtr,
    ) -> Result<HostRequest, RenderSubmitError> {
        self.submit_inner(packet, supplement, Some((packet_ptr, receipt_ptr)))
    }

    fn submit_inner(
        &mut self,
        packet: Vec<u8>,
        supplement: RenderCommitSupplement,
        modelled_offsets: Option<(SharedPtr, SharedPtr)>,
    ) -> Result<HostRequest, RenderSubmitError> {
        self.preflight_enqueue_state()?;
        let envelope = inspect_envelope(&packet).map_err(RenderSubmitError::Packet)?;
        let plan = private_commit_plan(envelope, supplement)?;
        self.enqueue(packet, plan, modelled_offsets)
    }

    /// Enqueues a separate Rust-authored VI presentation operation.
    #[cfg(target_arch = "wasm32")]
    #[cfg_attr(test, allow(dead_code))]
    pub fn submit_vi(
        &mut self,
        presentation: ViPresentationCommitPlan,
    ) -> Result<HostRequest, RenderSubmitError> {
        self.submit_vi_inner(presentation, None)
    }

    /// Native/contract seam for one modelled VI request and receipt pair.
    #[cfg(any(test, not(target_arch = "wasm32")))]
    pub fn submit_vi_at(
        &mut self,
        presentation: ViPresentationCommitPlan,
        request_ptr: SharedPtr,
        receipt_ptr: SharedPtr,
    ) -> Result<HostRequest, RenderSubmitError> {
        self.submit_vi_inner(presentation, Some((request_ptr, receipt_ptr)))
    }

    fn submit_vi_inner(
        &mut self,
        presentation: ViPresentationCommitPlan,
        modelled_offsets: Option<(SharedPtr, SharedPtr)>,
    ) -> Result<HostRequest, RenderSubmitError> {
        self.preflight_enqueue_state()?;
        let request_record = presentation.request(self.next_sequence);
        if !request_record.has_canonical_shape() {
            return Err(RenderSubmitError::InvalidCommitPlan);
        }
        let mut packet = Vec::new();
        packet
            .try_reserve_exact(ViPresentationRequest::BYTE_LEN)
            .map_err(|_| RenderSubmitError::Allocation)?;
        packet.resize(ViPresentationRequest::BYTE_LEN, 0);
        if !request_record.encode_le(&mut packet) {
            return Err(RenderSubmitError::InvalidCommitPlan);
        }
        self.enqueue(
            packet,
            RenderCommitPlan::ViPresent { presentation },
            modelled_offsets,
        )
    }

    fn enqueue(
        &mut self,
        packet: Vec<u8>,
        plan: RenderCommitPlan,
        modelled_offsets: Option<(SharedPtr, SharedPtr)>,
    ) -> Result<HostRequest, RenderSubmitError> {
        self.preflight_enqueue_state()?;
        if packet.len() > MAX_RENDER_PACKET_BYTES {
            return Err(RenderSubmitError::PacketTooLarge);
        }
        let payload_len = usize::try_from(plan.expected_payload_len())
            .map_err(|_| RenderSubmitError::ReceiptTooLarge)?;
        if payload_len > MAX_RENDER_RECEIPT_PAYLOAD_BYTES {
            return Err(RenderSubmitError::ReceiptTooLarge);
        }
        let response_len = RenderReceipt::BYTE_LEN
            .checked_add(payload_len)
            .ok_or(RenderSubmitError::ReceiptTooLarge)?;

        let following_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or(RenderSubmitError::CounterOverflow(RenderCounter::RequestId))?;
        let following_nonce =
            self.next_nonce
                .checked_add(1)
                .ok_or(RenderSubmitError::CounterOverflow(
                    RenderCounter::RequestNonce,
                ))?;
        let following_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(RenderSubmitError::CounterOverflow(RenderCounter::Sequence))?;

        let packet_len =
            u32::try_from(packet.len()).map_err(|_| RenderSubmitError::PacketTooLarge)?;
        let response_len_u32 =
            u32::try_from(response_len).map_err(|_| RenderSubmitError::ReceiptTooLarge)?;
        let mut response = Vec::new();
        response
            .try_reserve_exact(response_len)
            .map_err(|_| RenderSubmitError::Allocation)?;
        response.resize(response_len, 0);

        // Both vectors remain live until retirement (or until the authenticated commit lease is
        // dropped), so charge their allocator-retained capacities rather than their logical
        // lengths. Perform this check only after the response allocation reveals its actual
        // capacity and before publishing a request, advancing a counter, or mutating the queue.
        let accounted = packet
            .capacity()
            .checked_add(response.capacity())
            .ok_or(RenderSubmitError::PendingByteBudget)?;
        let pending_bytes = self
            .pending_bytes
            .checked_add(accounted)
            .ok_or(RenderSubmitError::PendingByteBudget)?;
        if pending_bytes > MAX_PENDING_RENDER_BYTES {
            return Err(RenderSubmitError::PendingByteBudget);
        }

        #[cfg(target_arch = "wasm32")]
        let actual_offsets = (
            SharedPtr(packet.as_ptr() as usize as u32),
            SharedPtr(response.as_ptr() as usize as u32),
        );
        #[cfg(not(target_arch = "wasm32"))]
        let actual_offsets = (SharedPtr::NULL, SharedPtr::NULL);
        let (packet_ptr, receipt_ptr) = modelled_offsets.unwrap_or(actual_offsets);
        if !valid_shared_range(packet_ptr, packet_len)
            || !valid_shared_range(receipt_ptr, response_len_u32)
            || shared_ranges_overlap(packet_ptr, packet_len, receipt_ptr, response_len_u32)
        {
            return Err(RenderSubmitError::InvalidSharedRange);
        }

        let request = HostRequest {
            header: RecordHeader::for_record::<HostRequest>(),
            request_id: self.next_request_id,
            request_nonce_lo: self.next_nonce as u32,
            request_nonce_hi: (self.next_nonce >> 32) as u32,
            kind_raw: HostRequestKind::RenderSubmit as u32,
            flags: if matches!(plan, RenderCommitPlan::ViPresent { .. }) {
                RENDER_REQUEST_VI_PRESENT
            } else {
                0
            },
            address: packet_ptr.0,
            length: packet_len,
            payload: SharedSlice {
                ptr: receipt_ptr,
                len: response_len_u32,
            },
            arg0: self.next_sequence as u32,
            arg1: (self.next_sequence >> 32) as u32,
        };
        let packet_sha256 = sha256(&packet);
        self.pending.push_back(PendingRender {
            packet,
            response,
            packet_sha256,
            exact_request: request,
            sequence: self.next_sequence,
            plan,
        });
        self.pending_bytes = pending_bytes;
        self.next_request_id = following_request_id;
        self.next_nonce = following_nonce;
        self.next_sequence = following_sequence;
        Ok(request)
    }

    fn preflight_enqueue_state(&self) -> Result<(), RenderSubmitError> {
        if self.accounting_fault {
            return Err(RenderSubmitError::InternalAccounting);
        }
        if self.active_commit.is_some() {
            return Err(RenderSubmitError::CommitInProgress);
        }
        if self.pending_count() >= MAX_PENDING_RENDER_REQUESTS {
            return Err(RenderSubmitError::PendingQueueFull);
        }
        Ok(())
    }

    /// Consumes an exact request once. Identity/reordering failures leave the queue untouched;
    /// after identity succeeds, any malformed host data retires the request without a commit.
    pub fn complete<'runtime>(
        &'runtime mut self,
        observed_request: HostRequest,
        completion: HostCompletion,
    ) -> Result<RenderCompletion<'runtime>, RenderCompletionError> {
        if self.active_commit.is_some() {
            return Err(RenderCompletionError::CommitInProgress);
        }
        let index = self.authenticate_request(observed_request)?;
        if index != 0 {
            return Err(RenderCompletionError::ReorderedReceipt {
                expected_sequence: self.pending[0].sequence,
                observed_sequence: self.pending[index].sequence,
            });
        }
        let exact_request = self.pending[0].exact_request;
        if completion.request_id != exact_request.request_id
            || completion.request_nonce_lo != exact_request.request_nonce_lo
            || completion.request_nonce_hi != exact_request.request_nonce_hi
        {
            return Err(RenderCompletionError::CompletionIdentityMismatch);
        }

        let disposition = validate_completion(&self.pending[0], completion);
        let Some(pending) = self.pending.pop_front() else {
            return Err(RenderCompletionError::NoPendingRequest);
        };
        let disposition = match disposition {
            Ok(disposition) => disposition,
            Err(error) => {
                self.finish_retirement(pending);
                return Err(error);
            }
        };
        match disposition {
            CompletionDisposition::HostFailed(status) => {
                let sequence = pending.sequence;
                self.finish_retirement(pending);
                Ok(RenderCompletion::Failed {
                    sequence,
                    failure: RenderFailure::Host(status),
                })
            }
            CompletionDisposition::RendererFailed(status) => {
                let sequence = pending.sequence;
                self.finish_retirement(pending);
                Ok(RenderCompletion::Failed {
                    sequence,
                    failure: RenderFailure::Renderer(status),
                })
            }
            CompletionDisposition::Committed(receipt) => {
                self.active_commit = Some(ActiveRenderCommit { pending, receipt });
                Ok(RenderCompletion::Committed(CommittedRender {
                    runtime: self,
                }))
            }
        }
    }

    fn authenticate_request(&self, observed: HostRequest) -> Result<usize, RenderCompletionError> {
        let identity = RenderIdentity::from_request(observed);
        let Some(index) = self
            .pending
            .iter()
            .position(|pending| RenderIdentity::from_request(pending.exact_request) == identity)
        else {
            return if self
                .retired
                .iter()
                .flatten()
                .any(|retired| *retired == identity)
            {
                Err(RenderCompletionError::DuplicateRequest)
            } else {
                Err(RenderCompletionError::StaleRequest)
            };
        };
        if observed != self.pending[index].exact_request {
            return Err(RenderCompletionError::MutatedRequestRecord);
        }
        Ok(index)
    }

    fn finish_retirement(&mut self, pending: PendingRender) {
        let Some(accounted) = pending.accounted_bytes() else {
            self.accounting_fault = true;
            return;
        };
        let Some(remaining) = self.pending_bytes.checked_sub(accounted) else {
            self.accounting_fault = true;
            return;
        };
        self.pending_bytes = remaining;
        self.retired[self.retired_cursor] =
            Some(RenderIdentity::from_request(pending.exact_request));
        self.retired_cursor = (self.retired_cursor + 1) % RETIRED_RENDER_IDENTITIES;
    }

    fn finish_active_commit(&mut self) {
        if let Some(active) = self.active_commit.take() {
            self.finish_retirement(active.pending);
        }
    }

    #[cfg(test)]
    pub fn set_counters_for_test(&mut self, request_id: u32, nonce: u64, sequence: u64) {
        self.next_request_id = request_id;
        self.next_nonce = nonce;
        self.next_sequence = sequence;
    }

    #[cfg(test)]
    pub fn packet_mut_for_test(
        &mut self,
        observed: HostRequest,
    ) -> Result<&mut [u8], RenderCompletionError> {
        let index = self.authenticate_request(observed)?;
        Ok(&mut self.pending[index].packet)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompletionDisposition {
    HostFailed(HostCompletionStatus),
    RendererFailed(RenderReceiptStatus),
    Committed(RenderReceipt),
}

fn validate_completion(
    pending: &PendingRender,
    completion: HostCompletion,
) -> Result<CompletionDisposition, RenderCompletionError> {
    if completion.header != RecordHeader::for_record::<HostCompletion>()
        || completion.reserved != 0
        || completion.value_lo != 0
        || completion.value_hi != 0
    {
        return Err(RenderCompletionError::MalformedCompletionRecord);
    }
    if sha256(&pending.packet) != pending.packet_sha256 {
        return Err(RenderCompletionError::PacketMutated);
    }
    let status = completion
        .status()
        .map_err(|_| RenderCompletionError::UnknownHostStatus(completion.status_raw))?;
    if status != HostCompletionStatus::Ok {
        if completion.filled_len != 0 || pending.response.iter().any(|byte| *byte != 0) {
            return Err(RenderCompletionError::InvalidFilledLength);
        }
        return Ok(CompletionDisposition::HostFailed(status));
    }

    let filled_len = usize::try_from(completion.filled_len)
        .map_err(|_| RenderCompletionError::InvalidFilledLength)?;
    if filled_len < RenderReceipt::BYTE_LEN || filled_len > pending.response.len() {
        return Err(RenderCompletionError::InvalidFilledLength);
    }
    let receipt = RenderReceipt::decode_le(&pending.response[..filled_len])
        .ok_or(RenderCompletionError::MalformedReceipt)?;
    if !receipt.has_canonical_shape() {
        return Err(RenderCompletionError::MalformedReceipt);
    }
    if receipt.sequence() != pending.sequence {
        return Err(RenderCompletionError::WrongSequence);
    }
    if receipt.kind() != Ok(pending.plan.kind()) {
        return Err(RenderCompletionError::WrongKind);
    }
    if receipt.generation != pending.plan.generation() {
        return Err(RenderCompletionError::WrongGeneration);
    }
    let receipt_status = receipt
        .status()
        .map_err(|_| RenderCompletionError::MalformedReceipt)?;
    if receipt_status != RenderReceiptStatus::Completed {
        if receipt.flags != 0
            || receipt.payload_len != 0
            || filled_len != RenderReceipt::BYTE_LEN
            || pending.response[filled_len..].iter().any(|byte| *byte != 0)
        {
            return Err(RenderCompletionError::WrongReceiptOptionals);
        }
        return Ok(CompletionDisposition::RendererFailed(receipt_status));
    }

    let declared_payload = usize::try_from(receipt.payload_len)
        .map_err(|_| RenderCompletionError::WrongReceiptPayload)?;
    let expected_payload = usize::try_from(pending.plan.expected_payload_len())
        .map_err(|_| RenderCompletionError::WrongReceiptPayload)?;
    if declared_payload != expected_payload
        || RenderReceipt::BYTE_LEN.checked_add(declared_payload) != Some(filled_len)
        || filled_len != pending.response.len()
    {
        return Err(RenderCompletionError::WrongReceiptPayload);
    }
    validate_receipt_optionals(&pending.plan, receipt)?;
    Ok(CompletionDisposition::Committed(receipt))
}

fn validate_receipt_optionals(
    plan: &RenderCommitPlan,
    receipt: RenderReceipt,
) -> Result<(), RenderCompletionError> {
    match plan {
        RenderCommitPlan::TextureCopy { .. } => {
            if receipt.flags != 0 {
                return Err(RenderCompletionError::WrongReceiptOptionals);
            }
        }
        RenderCommitPlan::XfbCopy { .. } => {
            if receipt.flags != 0 {
                return Err(RenderCompletionError::WrongReceiptOptionals);
            }
        }
        RenderCommitPlan::EfbPeek { .. } => {
            if receipt.flags != RENDER_RECEIPT_HAS_EFB_VALUE {
                return Err(RenderCompletionError::WrongReceiptOptionals);
            }
        }
        RenderCommitPlan::ViPresent { presentation } => {
            if receipt.flags != RENDER_RECEIPT_HAS_PRESENTATION
                || receipt.presentation_epoch != presentation.pair_epoch
            {
                return Err(RenderCompletionError::WrongReceiptOptionals);
            }
            let status = receipt
                .presentation_status()
                .map_err(|_| RenderCompletionError::WrongReceiptOptionals)?;
            match status {
                RenderPresentationStatus::Rejected
                    if receipt.presentation_width == 0
                        && receipt.presentation_height == 0
                        && receipt.presentation_serial() == 0 => {}
                RenderPresentationStatus::Staged
                    if presentation.mode == ViPresentationMode::Interlaced
                        && !presentation.pair_completing
                        && receipt.presentation_width == presentation.output_width
                        && receipt.presentation_height == presentation.output_height
                        && receipt.presentation_serial() == 0 => {}
                RenderPresentationStatus::Presented
                    if presentation.pair_completing
                        && receipt.presentation_width == presentation.output_width
                        && receipt.presentation_height == presentation.output_height
                        && receipt.presentation_serial() != 0 => {}
                _ => return Err(RenderCompletionError::WrongReceiptOptionals),
            }
        }
    }
    Ok(())
}

fn private_commit_plan(
    envelope: EnvelopeInfo,
    supplement: RenderCommitSupplement,
) -> Result<RenderCommitPlan, RenderSubmitError> {
    let terminal = envelope.terminal;
    if terminal.generation == 0 {
        return Err(RenderSubmitError::InvalidCommitPlan);
    }
    match (terminal.kind, supplement) {
        (TerminalKind::TextureCopy, RenderCommitSupplement::TextureCopy(materialization)) => {
            if terminal.texture_copy_layout_v1 != materialization.is_some() {
                return Err(RenderSubmitError::InvalidCommitPlan);
            }
            if let Some(materialization) = materialization {
                validate_texture_materialization(terminal, materialization)?;
            }
            Ok(RenderCommitPlan::TextureCopy {
                terminal,
                materialization,
            })
        }
        (TerminalKind::XfbCopy, RenderCommitSupplement::XfbCopy) => {
            Ok(RenderCommitPlan::XfbCopy { terminal })
        }
        (TerminalKind::EfbPeek, RenderCommitSupplement::EfbPeek) => {
            Ok(RenderCommitPlan::EfbPeek { terminal })
        }
        _ => Err(RenderSubmitError::CommitKindMismatch),
    }
}

fn validate_texture_materialization(
    terminal: TerminalState,
    materialization: TextureCopyMaterialization,
) -> Result<(), RenderSubmitError> {
    let payload_len = materialization
        .payload_len()
        .ok_or(RenderSubmitError::ReceiptTooLarge)?;
    if usize::try_from(payload_len)
        .ok()
        .is_none_or(|bytes| bytes > MAX_RENDER_RECEIPT_PAYLOAD_BYTES)
    {
        return Err(RenderSubmitError::ReceiptTooLarge);
    }
    let last_row = u64::from(materialization.row_count() - 1);
    let row_offset = last_row
        .checked_mul(u64::from(terminal.stride))
        .ok_or(RenderSubmitError::InvalidCommitPlan)?;
    let last_address = u64::from(terminal.destination)
        .checked_add(row_offset)
        .and_then(|address| address.checked_add(u64::from(materialization.row_bytes())))
        .ok_or(RenderSubmitError::InvalidCommitPlan)?;
    if last_address > u64::from(u32::MAX) + 1 {
        return Err(RenderSubmitError::InvalidCommitPlan);
    }
    Ok(())
}

fn valid_shared_range(pointer: SharedPtr, len: u32) -> bool {
    !pointer.is_null() && len != 0 && pointer.0.checked_add(len).is_some()
}

fn shared_ranges_overlap(
    first: SharedPtr,
    first_len: u32,
    second: SharedPtr,
    second_len: u32,
) -> bool {
    let first_start = u64::from(first.0);
    let first_end = first_start + u64::from(first_len);
    let second_start = u64::from(second.0);
    let second_end = second_start + u64::from(second_len);
    first_start < second_end && second_start < first_end
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
