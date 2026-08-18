//! Rust-owned VI scanout selection and XFB presentation planning.
//!
//! This module is deliberately host-neutral. Authenticated XFB completions enter a bounded
//! registry, and exact VI field work leaves as a private renderer commit plan. The browser host
//! never selects an XFB generation, row, parity, or interlaced pair.

use lazuli::system::vi::{Field, ScanoutPolicy, ScanoutWork};
use lazuli_abi::{ViFieldParity, ViPresentationMode};
use lzgx_packet::{TerminalKind, TerminalState};

use crate::render_runtime::ViPresentationCommitPlan;

/// Maximum resident XFB history accepted by the browser renderer contract.
pub const MAX_RESIDENT_XFB_COPIES: usize = 16;

/// Adapter bounds. A smaller XFB history is useful for constrained embeddings and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViRenderLimits {
    pub maximum_xfb_copies: usize,
}

impl Default for ViRenderLimits {
    fn default() -> Self {
        Self {
            maximum_xfb_copies: MAX_RESIDENT_XFB_COPIES,
        }
    }
}

/// Invalid initial adapter state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViRenderConfigError {
    InvalidXfbCapacity,
    InvalidNextPairEpoch,
}

/// Exact retained metadata from one authenticated, completed XFB terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompletedXfb {
    destination: u32,
    generation: u32,
    output_width: u32,
    output_height: u32,
    stride: u32,
}

impl CompletedXfb {
    #[must_use]
    pub const fn destination(self) -> u32 {
        self.destination
    }

    #[must_use]
    pub const fn generation(self) -> u32 {
        self.generation
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
    pub const fn stride(self) -> u32 {
        self.stride
    }
}

/// Rejection while admitting authenticated XFB terminal metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum XfbRegistrationError {
    WrongTerminalKind,
    ZeroGeneration,
    StaleGeneration { observed: u32, newest: u32 },
    InvalidGeometry,
    AddressRangeOverflow,
    InternalAccounting,
}

/// Exact bounded-registry mutation caused by one admitted XFB completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XfbRegistration {
    pub recorded: CompletedXfb,
    pub replaced: Option<CompletedXfb>,
    pub evicted: Option<CompletedXfb>,
}

/// A VI presentation could become valid after a renderer completion arrives.
///
/// Returning this outcome does not mutate pairing, epochs, or accepted-cycle state. The caller
/// may retain its copied [`ScanoutWork`] and retry after an XFB completion, or deliberately drop
/// that work to consume an unavailable scanout without fabricating a renderer request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViScanoutDeferred {
    XfbNotCompleted {
        address: u32,
        cycles_late: u64,
        newest_generation: Option<u32>,
    },
}

/// A VI presentation cannot safely be represented by the current Rust/renderer contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViScanoutRejection {
    SubmissionInProgress,
    MissingAddress,
    InvalidTiming,
    InvalidDimensions,
    XfbWidthMismatch {
        scanout_width: u32,
        xfb_width: u32,
    },
    XfbStrideMismatch {
        field_stride_bytes: u32,
        xfb_stride: u32,
    },
    XfbRowsOutOfRange,
    StaleScanout {
        scheduled_cycle: u64,
        last_accepted_cycle: u64,
    },
    PairEpochExhausted,
    HandoffIdentityExhausted,
    InternalPlanInvariant,
}

/// Result of resolving one synchronous VI field against authenticated XFB state.
#[derive(Debug, PartialEq, Eq)]
pub enum ViScanoutOutcome {
    Ready(ViPresentationHandoff),
    Deferred(ViScanoutDeferred),
    Rejected(ViScanoutRejection),
}

/// Unforgeable identity for accepting or cancelling one prepared renderer submission.
#[derive(Debug, PartialEq, Eq)]
pub struct ViPresentationHandoffIdentity {
    serial: u64,
    pair_epoch: u32,
    scheduled_cycle: u64,
}

/// Non-cloneable ownership transfer for one exact VI presentation plan.
#[derive(Debug, PartialEq, Eq)]
pub struct ViPresentationHandoff {
    identity: ViPresentationHandoffIdentity,
    plan: ViPresentationCommitPlan,
}

impl ViPresentationHandoff {
    /// Inspect the immutable plan before transferring it into [`crate::render_runtime::RenderRuntime`].
    #[must_use]
    pub const fn plan(&self) -> ViPresentationCommitPlan {
        self.plan
    }

    /// Move the plan and its exact acceptance identity into the caller.
    #[must_use]
    pub fn into_parts(self) -> (ViPresentationHandoffIdentity, ViPresentationCommitPlan) {
        (self.identity, self.plan)
    }
}

/// Exact handoff authentication failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViHandoffError {
    NoPreparedHandoff,
    WrongHandoff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScanoutSignature {
    output_width: u32,
    output_height: u32,
    field_stride_bytes: u32,
    field_height: u32,
    row_repeat: u32,
    source_row_step: u32,
    xfb_width: u32,
    xfb_height: u32,
    xfb_stride: u32,
    picture_latch_serial: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingPair {
    epoch: u32,
    parity: ViFieldParity,
    signature: ScanoutSignature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PairState {
    next_epoch: u64,
    pending: Option<PendingPair>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PreparedTransition {
    serial: u64,
    pair_epoch: u32,
    scheduled_cycle: u64,
    state_after: PairState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PairProposal {
    mode: ViPresentationMode,
    epoch: u32,
    completing: bool,
    state_after: PairState,
}

/// Bounded Rust owner of completed XFB identity and VI field-pair provenance.
pub struct ViRenderAdapter {
    xfb_copies: [Option<CompletedXfb>; MAX_RESIDENT_XFB_COPIES],
    xfb_len: usize,
    xfb_capacity: usize,
    newest_xfb_generation: Option<u32>,
    pair_state: PairState,
    last_accepted_cycle: Option<u64>,
    next_handoff_serial: Option<u64>,
    prepared: Option<PreparedTransition>,
}

impl Default for ViRenderAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ViRenderAdapter {
    /// Construct the canonical max-16 adapter with pair epoch one.
    #[must_use]
    pub fn new() -> Self {
        Self::from_validated_limits(MAX_RESIDENT_XFB_COPIES, 1)
    }

    /// Construct an adapter with explicit bounded history and restored next pair epoch.
    pub fn try_new(
        limits: ViRenderLimits,
        next_pair_epoch: u32,
    ) -> Result<Self, ViRenderConfigError> {
        if limits.maximum_xfb_copies == 0 || limits.maximum_xfb_copies > MAX_RESIDENT_XFB_COPIES {
            return Err(ViRenderConfigError::InvalidXfbCapacity);
        }
        if next_pair_epoch == 0 {
            return Err(ViRenderConfigError::InvalidNextPairEpoch);
        }
        Ok(Self::from_validated_limits(
            limits.maximum_xfb_copies,
            next_pair_epoch,
        ))
    }

    fn from_validated_limits(xfb_capacity: usize, next_pair_epoch: u32) -> Self {
        Self {
            xfb_copies: [None; MAX_RESIDENT_XFB_COPIES],
            xfb_len: 0,
            xfb_capacity,
            newest_xfb_generation: None,
            pair_state: PairState {
                next_epoch: u64::from(next_pair_epoch),
                pending: None,
            },
            last_accepted_cycle: None,
            next_handoff_serial: Some(1),
            prepared: None,
        }
    }

    /// Number of exact completed XFBs retained for scanout selection.
    #[must_use]
    pub const fn resident_xfb_count(&self) -> usize {
        self.xfb_len
    }

    /// Newest globally ordered authenticated XFB generation.
    #[must_use]
    pub const fn newest_xfb_generation(&self) -> Option<u32> {
        self.newest_xfb_generation
    }

    /// Whether a renderer submission still needs exact acceptance or cancellation.
    #[must_use]
    pub const fn has_prepared_handoff(&self) -> bool {
        self.prepared.is_some()
    }

    /// Admit metadata only after `RenderRuntime` authenticates and commits an XFB receipt.
    pub fn record_authenticated_xfb_completion(
        &mut self,
        terminal: TerminalState,
    ) -> Result<XfbRegistration, XfbRegistrationError> {
        if terminal.kind != TerminalKind::XfbCopy {
            return Err(XfbRegistrationError::WrongTerminalKind);
        }
        if terminal.generation == 0 {
            return Err(XfbRegistrationError::ZeroGeneration);
        }
        if let Some(newest) = self.newest_xfb_generation
            && terminal.generation <= newest
        {
            return Err(XfbRegistrationError::StaleGeneration {
                observed: terminal.generation,
                newest,
            });
        }
        if terminal.output_width == 0 || terminal.output_height == 0 || terminal.stride == 0 {
            return Err(XfbRegistrationError::InvalidGeometry);
        }
        let last_row_offset = terminal
            .output_height
            .checked_sub(1)
            .and_then(|rows| rows.checked_mul(terminal.stride))
            .ok_or(XfbRegistrationError::AddressRangeOverflow)?;
        terminal
            .destination
            .checked_add(last_row_offset)
            .ok_or(XfbRegistrationError::AddressRangeOverflow)?;

        let recorded = CompletedXfb {
            destination: terminal.destination,
            generation: terminal.generation,
            output_width: terminal.output_width,
            output_height: terminal.output_height,
            stride: terminal.stride,
        };
        let replaced = if let Some(index) = self.index_of_destination(recorded.destination) {
            Some(
                self.remove_xfb(index)
                    .ok_or(XfbRegistrationError::InternalAccounting)?,
            )
        } else {
            None
        };
        let evicted = if self.xfb_len == self.xfb_capacity {
            Some(
                self.remove_xfb(0)
                    .ok_or(XfbRegistrationError::InternalAccounting)?,
            )
        } else {
            None
        };
        self.xfb_copies[self.xfb_len] = Some(recorded);
        self.xfb_len += 1;
        self.newest_xfb_generation = Some(recorded.generation);
        Ok(XfbRegistration {
            recorded,
            replaced,
            evicted,
        })
    }

    /// Resolve one VI field and prepare, but do not yet commit, its pair-state transition.
    ///
    /// Call [`Self::accept_handoff`] only after `RenderRuntime::submit_vi_at` succeeds. On
    /// backpressure call [`Self::cancel_handoff`], leaving the field eligible for an exact retry.
    /// A deferred result performs no state transition: retain the copied work to retry, or drop it
    /// when machine policy intentionally consumes an unavailable field.
    pub fn prepare_scanout(&mut self, work: ScanoutWork) -> ViScanoutOutcome {
        if self.prepared.is_some() {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::SubmissionInProgress);
        }
        if work.observed_cycle < work.scheduled_cycle
            || work.cycles_late != work.observed_cycle - work.scheduled_cycle
        {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::InvalidTiming);
        }
        if let Some(last_accepted_cycle) = self.last_accepted_cycle
            && work.scheduled_cycle <= last_accepted_cycle
        {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::StaleScanout {
                scheduled_cycle: work.scheduled_cycle,
                last_accepted_cycle,
            });
        }
        let Some(address) = work.address.map(|address| address.0) else {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::MissingAddress);
        };
        let Some((xfb, selected_row)) = self.resolve_xfb(address) else {
            return ViScanoutOutcome::Deferred(ViScanoutDeferred::XfbNotCompleted {
                address,
                cycles_late: work.cycles_late,
                newest_generation: self.newest_xfb_generation,
            });
        };
        let dimensions = work.dimensions;
        let output_width = u32::from(dimensions.width);
        let output_height = u32::from(dimensions.height);
        let field_height = u32::from(dimensions.field_height);
        let row_repeat = u32::from(dimensions.row_repeat);
        if output_width == 0
            || output_height == 0
            || field_height == 0
            || dimensions.field_stride_bytes == 0
            || !matches!(row_repeat, 1 | 2)
            || field_height.checked_mul(row_repeat) != Some(output_height)
            || matches!(dimensions.policy, ScanoutPolicy::Direct) != (row_repeat == 1)
        {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::InvalidDimensions);
        }
        if output_width != xfb.output_width {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::XfbWidthMismatch {
                scanout_width: output_width,
                xfb_width: xfb.output_width,
            });
        }
        if !dimensions.field_stride_bytes.is_multiple_of(xfb.stride) {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::XfbStrideMismatch {
                field_stride_bytes: dimensions.field_stride_bytes,
                xfb_stride: xfb.stride,
            });
        }
        let source_row_step = dimensions.field_stride_bytes / xfb.stride;
        if source_row_step == 0 {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::XfbStrideMismatch {
                field_stride_bytes: dimensions.field_stride_bytes,
                xfb_stride: xfb.stride,
            });
        }
        let Some(last_source_row) = field_height
            .checked_sub(1)
            .and_then(|rows| rows.checked_mul(source_row_step))
            .and_then(|rows| selected_row.checked_add(rows))
        else {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::XfbRowsOutOfRange);
        };
        if last_source_row >= xfb.output_height {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::XfbRowsOutOfRange);
        }

        let signature = ScanoutSignature {
            output_width,
            output_height,
            field_stride_bytes: dimensions.field_stride_bytes,
            field_height,
            row_repeat,
            source_row_step,
            xfb_width: xfb.output_width,
            xfb_height: xfb.output_height,
            xfb_stride: xfb.stride,
            picture_latch_serial: work
                .snapshot
                .picture
                .map_or(0, |picture| picture.latch_serial),
        };
        let parity = match work.field {
            Field::Top => ViFieldParity::Top,
            Field::Bottom => ViFieldParity::Bottom,
        };
        let proposal = match self.propose_pair(dimensions.policy, parity, signature) {
            Ok(proposal) => proposal,
            Err(rejection) => return ViScanoutOutcome::Rejected(rejection),
        };
        let Some(plan) = ViPresentationCommitPlan::new(
            address,
            xfb.generation,
            selected_row,
            proposal.mode,
            parity,
            proposal.epoch,
            output_width,
            output_height,
            dimensions.field_stride_bytes,
            field_height,
            row_repeat,
            proposal.completing,
        ) else {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::InternalPlanInvariant);
        };
        let Some(serial) = self.next_handoff_serial else {
            return ViScanoutOutcome::Rejected(ViScanoutRejection::HandoffIdentityExhausted);
        };
        self.next_handoff_serial = serial.checked_add(1);
        self.prepared = Some(PreparedTransition {
            serial,
            pair_epoch: proposal.epoch,
            scheduled_cycle: work.scheduled_cycle,
            state_after: proposal.state_after,
        });
        ViScanoutOutcome::Ready(ViPresentationHandoff {
            identity: ViPresentationHandoffIdentity {
                serial,
                pair_epoch: proposal.epoch,
                scheduled_cycle: work.scheduled_cycle,
            },
            plan,
        })
    }

    /// Commit the exact pair-state transition after renderer submission admission succeeds.
    pub fn accept_handoff(
        &mut self,
        identity: &ViPresentationHandoffIdentity,
    ) -> Result<(), ViHandoffError> {
        let prepared = self.prepared.ok_or(ViHandoffError::NoPreparedHandoff)?;
        if prepared.serial != identity.serial
            || prepared.pair_epoch != identity.pair_epoch
            || prepared.scheduled_cycle != identity.scheduled_cycle
        {
            return Err(ViHandoffError::WrongHandoff);
        }
        self.pair_state = prepared.state_after;
        self.last_accepted_cycle = Some(prepared.scheduled_cycle);
        self.prepared = None;
        Ok(())
    }

    /// Cancel the exact prepared transition after renderer admission rejects the request.
    pub fn cancel_handoff(
        &mut self,
        identity: &ViPresentationHandoffIdentity,
    ) -> Result<(), ViHandoffError> {
        let prepared = self.prepared.ok_or(ViHandoffError::NoPreparedHandoff)?;
        if prepared.serial != identity.serial
            || prepared.pair_epoch != identity.pair_epoch
            || prepared.scheduled_cycle != identity.scheduled_cycle
        {
            return Err(ViHandoffError::WrongHandoff);
        }
        self.prepared = None;
        Ok(())
    }

    fn propose_pair(
        &self,
        policy: ScanoutPolicy,
        parity: ViFieldParity,
        signature: ScanoutSignature,
    ) -> Result<PairProposal, ViScanoutRejection> {
        if policy == ScanoutPolicy::Bob {
            if let Some(pending) = self.pair_state.pending
                && pending.parity != parity
                && pending.signature == signature
            {
                let mut state_after = self.pair_state;
                state_after.pending = None;
                return Ok(PairProposal {
                    mode: ViPresentationMode::Interlaced,
                    epoch: pending.epoch,
                    completing: true,
                    state_after,
                });
            }
            let (epoch, next_epoch) = self.allocate_pair_epoch()?;
            Ok(PairProposal {
                mode: ViPresentationMode::Interlaced,
                epoch,
                completing: false,
                state_after: PairState {
                    next_epoch,
                    pending: Some(PendingPair {
                        epoch,
                        parity,
                        signature,
                    }),
                },
            })
        } else {
            let (epoch, next_epoch) = self.allocate_pair_epoch()?;
            Ok(PairProposal {
                mode: ViPresentationMode::SingleField,
                epoch,
                completing: true,
                state_after: PairState {
                    next_epoch,
                    pending: None,
                },
            })
        }
    }

    fn allocate_pair_epoch(&self) -> Result<(u32, u64), ViScanoutRejection> {
        let epoch = u32::try_from(self.pair_state.next_epoch)
            .ok()
            .filter(|epoch| *epoch != 0)
            .ok_or(ViScanoutRejection::PairEpochExhausted)?;
        Ok((epoch, self.pair_state.next_epoch + 1))
    }

    fn resolve_xfb(&self, address: u32) -> Option<(CompletedXfb, u32)> {
        for index in (0..self.xfb_len).rev() {
            let xfb = self.xfb_copies[index]?;
            if xfb.destination == address {
                return Some((xfb, 0));
            }
        }
        for index in (0..self.xfb_len).rev() {
            let xfb = self.xfb_copies[index]?;
            let Some(delta) = address.checked_sub(xfb.destination) else {
                continue;
            };
            if delta != 0 && delta.is_multiple_of(xfb.stride) {
                let row = delta / xfb.stride;
                if row <= 1 && row < xfb.output_height {
                    return Some((xfb, row));
                }
            }
        }
        None
    }

    fn index_of_destination(&self, destination: u32) -> Option<usize> {
        (0..self.xfb_len)
            .find(|index| self.xfb_copies[*index].is_some_and(|xfb| xfb.destination == destination))
    }

    fn remove_xfb(&mut self, index: usize) -> Option<CompletedXfb> {
        let removed = self.xfb_copies.get(index).copied().flatten()?;
        self.xfb_copies.copy_within(index + 1..self.xfb_len, index);
        self.xfb_len -= 1;
        self.xfb_copies[self.xfb_len] = None;
        Some(removed)
    }
}
