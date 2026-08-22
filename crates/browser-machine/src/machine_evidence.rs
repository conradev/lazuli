//! Rust-only aggregation for the generic resident-machine evidence ABI.
//!
//! Browser code never authors these counters or chronology records. Future `BrowserMachine`
//! wiring must call the acceptance methods only after the named Rust owner has committed the
//! corresponding scheduler, device, GX, SI, or renderer transition. Any contradiction poisons
//! this accumulator permanently; a poisoned accumulator cannot issue an evidence snapshot.

use lazuli_abi::{
    EvidenceU64, MACHINE_EVIDENCE_DSP_LLE_VALID, MACHINE_EVIDENCE_HAS_BOOT_IDENTITY,
    MACHINE_EVIDENCE_HAS_SI_PUBLICATION, MACHINE_EVIDENCE_HAS_XFB_VI,
    MACHINE_EVIDENCE_TERMINAL_ERROR, MACHINE_RENDER_PENDING_CAPACITY, MACHINE_SI_QUEUE_CAPACITY,
    MACHINE_XFB_VI_PAIR_COMPLETING, MachineBootEvidenceV1, MachineBootFault, MachineBootStatus,
    MachineDeviceEvidenceV1, MachineDiCommandKind, MachineDiEvidenceV1, MachineDiLifecycleState,
    MachineDiscFormat, MachineEvidenceV1, MachineGraphicsEvidenceV1, MachineRenderEvidenceV1,
    MachineSchedulerEvidenceV1, MachineSiEvidenceV1, MachineSiPollSource, MachineXfbViEvidenceV1,
    RenderPresentationStatus, RunReason, ViFieldParity, ViPresentationMode,
};

const AUTHENTICATED_XFB_HISTORY: usize = 16;

/// Sticky reason that generic evidence can no longer be issued for this machine epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MachineEvidenceFault {
    InvalidMachineEpoch,
    Poisoned,
    SchedulerRegression,
    SchedulerInvariant,
    BootRegression,
    BootInvariant,
    DeviceRegression,
    DeviceInvariant,
    DiRegression,
    DiInvariant,
    GraphicsRegression,
    RenderRegression,
    RenderInvariant,
    EventAfterCanonicalCycle,
    XfbGenerationRegression,
    InvalidXfbCompletion,
    UnknownXfbGeneration,
    PendingViSelection,
    MissingViSelection,
    InvalidViSelection,
    ViCompletionMismatch,
    InvalidViCompletion,
    SiChronologyRegression,
    InvalidSiPublication,
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    SnapshotSerialOverflow,
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    SnapshotInvariant,
}

/// Absolute totals sampled after the resident coordinator accepts one dispatcher report.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SchedulerCounters {
    pub canonical_cycle: u64,
    pub executed_cycles: u64,
    pub executed_instructions: u64,
    pub address_space_generation: u64,
    pub retired_blocks: u64,
    pub completed_outer_slices: u64,
    pub semantic_idle_cycles: u64,
    pub semantic_idle_jumps: u64,
    pub pc: u32,
    pub machine_fault: Option<MachineFault>,
}

/// Exact sticky machine fault retained from the Rust-authored [`lazuli_abi::RunOutcome`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MachineFault {
    pub reason: RunReason,
    pub detail: u32,
}

/// Immutable identity produced by the terminal Rust disc-boot commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AuthenticatedBootIdentity {
    pub identifier: [u8; 6],
    pub revision: u8,
    pub disc_number: u8,
    pub format: MachineDiscFormat,
    pub logical_bytes: u64,
}

/// Current Rust-owned boot lifecycle and optional committed identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AuthenticatedBootState {
    pub boot_epoch: u64,
    pub status: MachineBootStatus,
    pub fault: MachineBootFault,
    pub identity: Option<AuthenticatedBootIdentity>,
}

impl Default for AuthenticatedBootState {
    fn default() -> Self {
        Self {
            boot_epoch: 0,
            status: MachineBootStatus::Idle,
            fault: MachineBootFault::None,
            identity: None,
        }
    }
}

/// Absolute device totals sampled at a canonical Rust scheduler acceptance point.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DeviceCounters {
    pub raw_disk_reads: u64,
    pub vi_fields: u64,
    pub dsp_lle_steps: u64,
    pub disk_device_errors: u64,
    pub disk_request_errors: u64,
    pub controller_queue_overflows: u64,
    pub unknown_si_output_commands: u64,
    pub unsupported_dtk_records: u64,
    pub storage_faults_raised: u64,
    pub storage_faults_returned: u64,
    pub storage_faults_resolved: u64,
    pub storage_fault_recurrences: u64,
    pub storage_fault_nested: u64,
    pub storage_fault_unrecoverable: u64,
    pub di_last_error: u32,
    pub storage_fault_pending: bool,
    pub dsp_lle_valid: bool,
}

/// Absolute DI lifecycle totals and current typed state sampled from the two Rust owners.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DiCounters {
    pub command_starts: u64,
    pub command_completions: u64,
    pub command_cancellations: u64,
    pub command_start_rejections: u64,
    pub inquiry_starts: u64,
    pub inquiry_completions: u64,
    pub inquiry_cancellations: u64,
    pub inquiry_start_rejections: u64,
    pub read_starts: u64,
    pub read_sector_starts: u64,
    pub read_disc_id_starts: u64,
    pub read_completions: u64,
    pub read_cancellations: u64,
    pub read_start_rejections: u64,
    pub read_device_failures: u64,
    pub physical_host_requests_issued: u64,
    pub physical_host_requests_cancelled: u64,
    pub host_receipts_succeeded: u64,
    pub host_receipts_failed: u64,
    pub host_receipts_rejected: u64,
    pub logical_windows_ready: u64,
    pub logical_windows_failed: u64,
    pub current_state: MachineDiLifecycleState,
    pub current_kind: MachineDiCommandKind,
    pub physical_host_request_pending: bool,
}

impl Default for DiCounters {
    fn default() -> Self {
        Self {
            command_starts: 0,
            command_completions: 0,
            command_cancellations: 0,
            command_start_rejections: 0,
            inquiry_starts: 0,
            inquiry_completions: 0,
            inquiry_cancellations: 0,
            inquiry_start_rejections: 0,
            read_starts: 0,
            read_sector_starts: 0,
            read_disc_id_starts: 0,
            read_completions: 0,
            read_cancellations: 0,
            read_start_rejections: 0,
            read_device_failures: 0,
            physical_host_requests_issued: 0,
            physical_host_requests_cancelled: 0,
            host_receipts_succeeded: 0,
            host_receipts_failed: 0,
            host_receipts_rejected: 0,
            logical_windows_ready: 0,
            logical_windows_failed: 0,
            current_state: MachineDiLifecycleState::Idle,
            current_kind: MachineDiCommandKind::None,
            physical_host_request_pending: false,
        }
    }
}

/// Absolute GX/VI totals plus current Rust-owned bounded-buffer gauges.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GraphicsCounters {
    pub gx_bytes: u64,
    pub gx_drains: u64,
    pub gx_commands: u64,
    pub gx_primitives: u64,
    pub xfb_copies: u64,
    pub presented_frames: u64,
    pub emergency_drains: u64,
    pub decoder_errors: u64,
    pub fallbacks: u64,
    pub unsupported_records: u64,
    pub exact_rejections: u64,
    pub texture_errors: u64,
    pub pending_bytes: u64,
    pub decoder_carry_bytes: u64,
}

/// Absolute accounting from the Rust-owned renderer request boundary.
///
/// `render_completions_authenticated` counts every exact request identity consumed, including
/// the two failure subsets. It never claims that WebGPU executed any particular work.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RenderCounters {
    pub render_requests_issued: u64,
    pub render_completions_authenticated: u64,
    pub render_host_failures: u64,
    pub render_renderer_failures: u64,
    pub texture_copy_barriers_entered: u64,
    pub texture_copy_barriers_exited: u64,
    pub render_pending: u32,
    pub render_high_water: u32,
}

/// Metadata accepted only after `RenderRuntime` authenticates an XFB receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AuthenticatedXfbCompletion {
    pub completion_cycle: u64,
    pub generation: u32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
}

/// Address-free VI selection metadata accepted after `ViRenderAdapter` and `RenderRuntime` commit
/// the exact request. The private adapter remains the sole owner of the selected XFB address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AuthenticatedViSelection {
    pub selection_cycle: u64,
    pub render_sequence: u64,
    pub xfb_generation: u32,
    pub selected_row: u32,
    pub mode: ViPresentationMode,
    pub parity: ViFieldParity,
    pub pair_epoch: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub field_stride_bytes: u32,
    pub field_height: u32,
    pub row_repeat: u32,
    pub pair_completing: bool,
}

/// Presentation fields accepted from one already-authenticated canonical render receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AuthenticatedViCompletion {
    pub completion_cycle: u64,
    pub render_sequence: u64,
    pub presentation_status: RenderPresentationStatus,
    pub presentation_epoch: u32,
    pub presentation_width: u32,
    pub presentation_height: u32,
    pub presentation_serial: u64,
}

/// Rust SI publication chronology. It contains semantic controller state, never guest memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AuthenticatedSiPublication {
    pub source: MachineSiPollSource,
    pub poll_index: u64,
    pub scheduled_cycle: u64,
    pub observed_cycle: u64,
    pub applied_sequence: u64,
    pub packet: [u8; 8],
}

/// Complete SI counter/gauge sample at one canonical Rust acceptance point.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SiCounters {
    pub queue_depth: u32,
    pub last_received_sequence: u64,
    /// Successful guest-visible periodic publications, not periodic service attempts.
    pub periodic_polls: u64,
    /// Successful guest-visible direct publications, not direct-transfer attempts.
    pub direct_polls: u64,
    /// Periodic service attempts whose guest-visible buffer was still backpressured.
    pub backpressured_polls: u64,
    pub publication: Option<AuthenticatedSiPublication>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct XfbStamp {
    completion_cycle: u64,
    generation: u32,
    width: u32,
    height: u32,
    stride: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingViSelection {
    xfb: XfbStamp,
    selection: AuthenticatedViSelection,
}

/// Fail-closed owner of one epoch's generic machine evidence.
pub(crate) struct MachineEvidence {
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    machine_epoch: u64,
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    snapshot_serial: u64,
    boot: AuthenticatedBootState,
    scheduler: SchedulerCounters,
    device: DeviceCounters,
    device_accepted: bool,
    di: DiCounters,
    di_accepted: bool,
    graphics: GraphicsCounters,
    renderer: RenderCounters,
    xfb_history: [Option<XfbStamp>; AUTHENTICATED_XFB_HISTORY],
    xfb_history_cursor: usize,
    newest_xfb_generation: Option<u32>,
    pending_vi: Option<PendingViSelection>,
    last_xfb_vi: Option<MachineXfbViEvidenceV1>,
    si: MachineSiEvidenceV1,
    fault: Option<MachineEvidenceFault>,
}

impl MachineEvidence {
    pub(crate) fn try_new(machine_epoch: u64) -> Result<Self, MachineEvidenceFault> {
        if machine_epoch == 0 {
            return Err(MachineEvidenceFault::InvalidMachineEpoch);
        }
        Ok(Self {
            machine_epoch,
            snapshot_serial: 0,
            boot: AuthenticatedBootState::default(),
            scheduler: SchedulerCounters::default(),
            device: DeviceCounters::default(),
            device_accepted: false,
            di: DiCounters::default(),
            di_accepted: false,
            graphics: GraphicsCounters::default(),
            renderer: RenderCounters::default(),
            xfb_history: [None; AUTHENTICATED_XFB_HISTORY],
            xfb_history_cursor: 0,
            newest_xfb_generation: None,
            pending_vi: None,
            last_xfb_vi: None,
            si: MachineSiEvidenceV1::default(),
            fault: None,
        })
    }

    #[must_use]
    pub(crate) const fn fault(&self) -> Option<MachineEvidenceFault> {
        self.fault
    }

    fn ensure_healthy(&self) -> Result<(), MachineEvidenceFault> {
        if self.fault.is_some() {
            Err(MachineEvidenceFault::Poisoned)
        } else {
            Ok(())
        }
    }

    fn fail<T>(&mut self, fault: MachineEvidenceFault) -> Result<T, MachineEvidenceFault> {
        if self.fault.is_none() {
            self.fault = Some(fault);
        }
        Err(fault)
    }

    /// Accept the current Rust boot lifecycle and its immutable terminal identity.
    pub(crate) fn accept_boot_state(
        &mut self,
        next: AuthenticatedBootState,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        let next_record = boot_record(next);
        if !next_record.has_canonical_shape(next.identity.is_some()) {
            return self.fail(MachineEvidenceFault::BootInvariant);
        }
        let prior = self.boot;
        if prior.boot_epoch != 0 && next.boot_epoch != 0 && next.boot_epoch < prior.boot_epoch
            || prior.identity.is_some() && next.boot_epoch == prior.boot_epoch && next != prior
        {
            return self.fail(MachineEvidenceFault::BootRegression);
        }
        self.boot = next;
        Ok(())
    }

    /// Accept absolute scheduler totals only after the resident coordinator commits its report.
    pub(crate) fn accept_scheduler_commit(
        &mut self,
        next: SchedulerCounters,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        if next.canonical_cycle < self.scheduler.canonical_cycle
            || next.executed_cycles < self.scheduler.executed_cycles
            || next.executed_instructions < self.scheduler.executed_instructions
            || next.retired_blocks < self.scheduler.retired_blocks
            || next.completed_outer_slices < self.scheduler.completed_outer_slices
            || next.semantic_idle_cycles < self.scheduler.semantic_idle_cycles
            || next.semantic_idle_jumps < self.scheduler.semantic_idle_jumps
            || self.scheduler.machine_fault.is_some()
                && next.machine_fault != self.scheduler.machine_fault
        {
            return self.fail(MachineEvidenceFault::SchedulerRegression);
        }
        if next.executed_cycles > next.canonical_cycle
            || next.address_space_generation == 0
            || next.pc & 3 != 0
            || next.semantic_idle_cycles > next.executed_cycles
            || u32::try_from(next.semantic_idle_jumps).is_err()
            || (next.semantic_idle_jumps == 0) != (next.semantic_idle_cycles == 0)
            || next.machine_fault.is_some_and(|fault| {
                !matches!(fault.reason, RunReason::Fault | RunReason::InvalidState)
                    || fault.detail == 0
            })
        {
            return self.fail(MachineEvidenceFault::SchedulerInvariant);
        }
        self.scheduler = next;
        Ok(())
    }

    /// Accept cumulative DI totals and the current typed state from Rust device/adapter owners.
    pub(crate) fn accept_di_counters(
        &mut self,
        next: DiCounters,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        let prior = self.di;
        if self.di_accepted
            && (next.command_starts < prior.command_starts
                || next.command_completions < prior.command_completions
                || next.command_cancellations < prior.command_cancellations
                || next.command_start_rejections < prior.command_start_rejections
                || next.inquiry_starts < prior.inquiry_starts
                || next.inquiry_completions < prior.inquiry_completions
                || next.inquiry_cancellations < prior.inquiry_cancellations
                || next.inquiry_start_rejections < prior.inquiry_start_rejections
                || next.read_starts < prior.read_starts
                || next.read_sector_starts < prior.read_sector_starts
                || next.read_disc_id_starts < prior.read_disc_id_starts
                || next.read_completions < prior.read_completions
                || next.read_cancellations < prior.read_cancellations
                || next.read_start_rejections < prior.read_start_rejections
                || next.read_device_failures < prior.read_device_failures
                || next.physical_host_requests_issued < prior.physical_host_requests_issued
                || next.physical_host_requests_cancelled < prior.physical_host_requests_cancelled
                || next.host_receipts_succeeded < prior.host_receipts_succeeded
                || next.host_receipts_failed < prior.host_receipts_failed
                || next.host_receipts_rejected < prior.host_receipts_rejected
                || next.logical_windows_ready < prior.logical_windows_ready
                || next.logical_windows_failed < prior.logical_windows_failed)
        {
            return self.fail(MachineEvidenceFault::DiRegression);
        }
        if !di_record(next).has_canonical_shape() {
            return self.fail(MachineEvidenceFault::DiInvariant);
        }
        self.di = next;
        self.di_accepted = true;
        Ok(())
    }

    /// Accept absolute device counters sampled after all due Rust device services are committed.
    pub(crate) fn accept_device_counters(
        &mut self,
        next: DeviceCounters,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        let prior = self.device;
        if next.raw_disk_reads < prior.raw_disk_reads
            || next.vi_fields < prior.vi_fields
            || next.dsp_lle_steps < prior.dsp_lle_steps
            || next.disk_device_errors < prior.disk_device_errors
            || next.disk_request_errors < prior.disk_request_errors
            || next.controller_queue_overflows < prior.controller_queue_overflows
            || next.unknown_si_output_commands < prior.unknown_si_output_commands
            || next.unsupported_dtk_records < prior.unsupported_dtk_records
            || next.storage_faults_raised < prior.storage_faults_raised
            || next.storage_faults_returned < prior.storage_faults_returned
            || next.storage_faults_resolved < prior.storage_faults_resolved
            || next.storage_fault_recurrences < prior.storage_fault_recurrences
            || next.storage_fault_nested < prior.storage_fault_nested
            || next.storage_fault_unrecoverable < prior.storage_fault_unrecoverable
            || self.device_accepted && !prior.dsp_lle_valid && next.dsp_lle_valid
        {
            return self.fail(MachineEvidenceFault::DeviceRegression);
        }
        if next.storage_faults_resolved > next.storage_faults_returned
            || next.storage_faults_returned > next.storage_faults_raised
        {
            return self.fail(MachineEvidenceFault::DeviceInvariant);
        }
        self.device = next;
        self.device_accepted = true;
        Ok(())
    }

    /// Accept absolute GX/VI totals and current bounded-buffer gauges from their Rust owners.
    pub(crate) fn accept_graphics_counters(
        &mut self,
        next: GraphicsCounters,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        let prior = self.graphics;
        if next.gx_bytes < prior.gx_bytes
            || next.gx_drains < prior.gx_drains
            || next.gx_commands < prior.gx_commands
            || next.gx_primitives < prior.gx_primitives
            || next.xfb_copies < prior.xfb_copies
            || next.presented_frames < prior.presented_frames
            || next.emergency_drains < prior.emergency_drains
            || next.decoder_errors < prior.decoder_errors
            || next.fallbacks < prior.fallbacks
            || next.unsupported_records < prior.unsupported_records
            || next.exact_rejections < prior.exact_rejections
            || next.texture_errors < prior.texture_errors
        {
            return self.fail(MachineEvidenceFault::GraphicsRegression);
        }
        self.graphics = next;
        Ok(())
    }

    /// Accept absolute Rust request-boundary accounting, including observable failure subsets.
    pub(crate) fn accept_renderer_counters(
        &mut self,
        next: RenderCounters,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        let prior = self.renderer;
        if next.render_requests_issued < prior.render_requests_issued
            || next.render_completions_authenticated < prior.render_completions_authenticated
            || next.render_host_failures < prior.render_host_failures
            || next.render_renderer_failures < prior.render_renderer_failures
            || next.texture_copy_barriers_entered < prior.texture_copy_barriers_entered
            || next.texture_copy_barriers_exited < prior.texture_copy_barriers_exited
            || next.render_high_water < prior.render_high_water
        {
            return self.fail(MachineEvidenceFault::RenderRegression);
        }
        let Some(completed_or_pending) = next
            .render_completions_authenticated
            .checked_add(u64::from(next.render_pending))
        else {
            return self.fail(MachineEvidenceFault::RenderInvariant);
        };
        let Some(failures) = next
            .render_host_failures
            .checked_add(next.render_renderer_failures)
        else {
            return self.fail(MachineEvidenceFault::RenderInvariant);
        };
        if completed_or_pending != next.render_requests_issued
            || failures > next.render_completions_authenticated
            || next.render_pending > next.render_high_water
            || next.render_high_water > MACHINE_RENDER_PENDING_CAPACITY
            || next.texture_copy_barriers_exited > next.texture_copy_barriers_entered
        {
            return self.fail(MachineEvidenceFault::RenderInvariant);
        }
        self.renderer = next;
        Ok(())
    }

    /// Retain one address-free XFB stamp after its exact renderer receipt is authenticated.
    pub(crate) fn accept_authenticated_xfb(
        &mut self,
        completion: AuthenticatedXfbCompletion,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        if completion.completion_cycle > self.scheduler.canonical_cycle {
            return self.fail(MachineEvidenceFault::EventAfterCanonicalCycle);
        }
        if completion.generation == 0
            || completion.width == 0
            || completion.height == 0
            || completion.stride == 0
            || self.renderer.render_completions_authenticated == 0
            || self.graphics.xfb_copies == 0
        {
            return self.fail(MachineEvidenceFault::InvalidXfbCompletion);
        }
        if self
            .newest_xfb_generation
            .is_some_and(|newest| completion.generation <= newest)
        {
            return self.fail(MachineEvidenceFault::XfbGenerationRegression);
        }
        let stamp = XfbStamp {
            completion_cycle: completion.completion_cycle,
            generation: completion.generation,
            width: completion.width,
            height: completion.height,
            stride: completion.stride,
        };
        self.xfb_history[self.xfb_history_cursor] = Some(stamp);
        self.xfb_history_cursor = (self.xfb_history_cursor + 1) % AUTHENTICATED_XFB_HISTORY;
        self.newest_xfb_generation = Some(completion.generation);
        Ok(())
    }

    /// Retain an address-free selection only after both VI handoff and render request acceptance.
    pub(crate) fn accept_vi_selection(
        &mut self,
        selection: AuthenticatedViSelection,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        if self.pending_vi.is_some() {
            return self.fail(MachineEvidenceFault::PendingViSelection);
        }
        if selection.selection_cycle > self.scheduler.canonical_cycle {
            return self.fail(MachineEvidenceFault::EventAfterCanonicalCycle);
        }
        let Some(xfb) = self
            .xfb_history
            .iter()
            .flatten()
            .copied()
            .find(|xfb| xfb.generation == selection.xfb_generation)
        else {
            return self.fail(MachineEvidenceFault::UnknownXfbGeneration);
        };
        let source_row_step = selection.field_stride_bytes.checked_div(xfb.stride);
        let last_source_row = source_row_step.and_then(|step| {
            selection
                .field_height
                .checked_sub(1)
                .and_then(|rows| rows.checked_mul(step))
                .and_then(|rows| selection.selected_row.checked_add(rows))
        });
        let last_render_sequence = self
            .last_xfb_vi
            .map_or(0, |chronology| chronology.render_sequence.get());
        if selection.render_sequence == 0
            || selection.render_sequence <= last_render_sequence
            || selection.render_sequence > self.renderer.render_requests_issued
            || self.renderer.render_pending == 0
            || selection.xfb_generation == 0
            || selection.pair_epoch == 0
            || selection.selection_cycle < xfb.completion_cycle
            || selection.output_width != xfb.width
            || selection.output_height == 0
            || selection.field_stride_bytes == 0
            || !selection.field_stride_bytes.is_multiple_of(xfb.stride)
            || selection.field_height == 0
            || !matches!(selection.row_repeat, 1 | 2)
            || selection.field_height.checked_mul(selection.row_repeat)
                != Some(selection.output_height)
            || last_source_row.is_none_or(|row| row >= xfb.height)
            || selection.mode != ViPresentationMode::Interlaced && !selection.pair_completing
        {
            return self.fail(MachineEvidenceFault::InvalidViSelection);
        }
        self.pending_vi = Some(PendingViSelection { xfb, selection });
        Ok(())
    }

    /// Complete the pending VI chronology only from an authenticated canonical render receipt.
    pub(crate) fn accept_vi_completion(
        &mut self,
        completion: AuthenticatedViCompletion,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        let Some(pending) = self.pending_vi else {
            return self.fail(MachineEvidenceFault::MissingViSelection);
        };
        let selection = pending.selection;
        if completion.render_sequence != selection.render_sequence
            || completion.presentation_epoch != selection.pair_epoch
        {
            return self.fail(MachineEvidenceFault::ViCompletionMismatch);
        }
        if completion.completion_cycle > self.scheduler.canonical_cycle {
            return self.fail(MachineEvidenceFault::EventAfterCanonicalCycle);
        }
        let presentation_is_valid = match completion.presentation_status {
            RenderPresentationStatus::Rejected => {
                completion.presentation_width == 0
                    && completion.presentation_height == 0
                    && completion.presentation_serial == 0
            }
            RenderPresentationStatus::Staged => {
                selection.mode == ViPresentationMode::Interlaced
                    && !selection.pair_completing
                    && completion.presentation_width == selection.output_width
                    && completion.presentation_height == selection.output_height
                    && completion.presentation_serial == 0
            }
            RenderPresentationStatus::Presented => {
                selection.pair_completing
                    && completion.presentation_width == selection.output_width
                    && completion.presentation_height == selection.output_height
                    && completion.presentation_serial != 0
            }
        };
        if completion.completion_cycle < selection.selection_cycle
            || completion.render_sequence > self.renderer.render_completions_authenticated
            || matches!(
                completion.presentation_status,
                RenderPresentationStatus::Presented
            ) && self.graphics.presented_frames == 0
            || !presentation_is_valid
        {
            return self.fail(MachineEvidenceFault::InvalidViCompletion);
        }
        let chronology = MachineXfbViEvidenceV1 {
            xfb_completion_cycle: EvidenceU64::new(pending.xfb.completion_cycle),
            vi_selection_cycle: EvidenceU64::new(selection.selection_cycle),
            render_completion_cycle: EvidenceU64::new(completion.completion_cycle),
            render_sequence: EvidenceU64::new(completion.render_sequence),
            presentation_serial: EvidenceU64::new(completion.presentation_serial),
            xfb_generation: pending.xfb.generation,
            selected_row: selection.selected_row,
            mode_raw: selection.mode as u32,
            parity_raw: selection.parity as u32,
            pair_epoch: selection.pair_epoch,
            xfb_width: pending.xfb.width,
            xfb_height: pending.xfb.height,
            xfb_stride: pending.xfb.stride,
            output_width: selection.output_width,
            output_height: selection.output_height,
            field_stride_bytes: selection.field_stride_bytes,
            field_height: selection.field_height,
            row_repeat: selection.row_repeat,
            presentation_status_raw: completion.presentation_status as u32,
            presentation_width: completion.presentation_width,
            presentation_height: completion.presentation_height,
            flags: if selection.pair_completing {
                MACHINE_XFB_VI_PAIR_COMPLETING
            } else {
                0
            },
        };
        if !chronology.has_canonical_shape() {
            return self.fail(MachineEvidenceFault::InvalidViCompletion);
        }
        self.pending_vi = None;
        self.last_xfb_vi = Some(chronology);
        Ok(())
    }

    /// Retain SI counters, gauges, and optionally the newest exact guest-visible publication.
    pub(crate) fn accept_si_counters(
        &mut self,
        next: SiCounters,
    ) -> Result<(), MachineEvidenceFault> {
        self.ensure_healthy()?;
        let prior = self.si;
        if next.queue_depth > MACHINE_SI_QUEUE_CAPACITY
            || next.last_received_sequence < prior.last_received_sequence.get()
            || next.periodic_polls < prior.periodic_polls.get()
            || next.direct_polls < prior.direct_polls.get()
            || next.backpressured_polls < prior.backpressured_polls.get()
        {
            return self.fail(MachineEvidenceFault::SiChronologyRegression);
        }
        let Some(poll_total) = next.periodic_polls.checked_add(next.direct_polls) else {
            return self.fail(MachineEvidenceFault::InvalidSiPublication);
        };
        let chronology = if let Some(publication) = next.publication {
            if publication.observed_cycle > self.scheduler.canonical_cycle {
                return self.fail(MachineEvidenceFault::EventAfterCanonicalCycle);
            }
            let expected_poll = prior.poll_index.get().checked_add(1);
            let periodic_delta = next.periodic_polls - prior.periodic_polls.get();
            let direct_delta = next.direct_polls - prior.direct_polls.get();
            let source_matches = match publication.source {
                MachineSiPollSource::Periodic => periodic_delta == 1 && direct_delta == 0,
                MachineSiPollSource::Direct => periodic_delta == 0 && direct_delta == 1,
            };
            if expected_poll != Some(publication.poll_index)
                || poll_total != publication.poll_index
                || !source_matches
                || publication.scheduled_cycle > publication.observed_cycle
                || publication.observed_cycle < prior.observed_cycle.get()
                || publication.applied_sequence < prior.applied_sequence.get()
                || publication.applied_sequence > next.last_received_sequence
            {
                return self.fail(MachineEvidenceFault::InvalidSiPublication);
            }
            MachineSiEvidenceV1 {
                poll_index: EvidenceU64::new(publication.poll_index),
                scheduled_cycle: EvidenceU64::new(publication.scheduled_cycle),
                observed_cycle: EvidenceU64::new(publication.observed_cycle),
                last_received_sequence: EvidenceU64::new(next.last_received_sequence),
                applied_sequence: EvidenceU64::new(publication.applied_sequence),
                periodic_polls: EvidenceU64::new(next.periodic_polls),
                direct_polls: EvidenceU64::new(next.direct_polls),
                backpressured_polls: EvidenceU64::new(next.backpressured_polls),
                packet_be_words: [
                    u32::from_be_bytes([
                        publication.packet[0],
                        publication.packet[1],
                        publication.packet[2],
                        publication.packet[3],
                    ]),
                    u32::from_be_bytes([
                        publication.packet[4],
                        publication.packet[5],
                        publication.packet[6],
                        publication.packet[7],
                    ]),
                ],
                queue_depth: next.queue_depth,
                source_raw: publication.source as u32,
            }
        } else {
            if poll_total != prior.poll_index.get() {
                return self.fail(MachineEvidenceFault::InvalidSiPublication);
            }
            MachineSiEvidenceV1 {
                last_received_sequence: EvidenceU64::new(next.last_received_sequence),
                periodic_polls: EvidenceU64::new(next.periodic_polls),
                direct_polls: EvidenceU64::new(next.direct_polls),
                backpressured_polls: EvidenceU64::new(next.backpressured_polls),
                queue_depth: next.queue_depth,
                ..prior
            }
        };
        if !chronology.has_canonical_shape(chronology.poll_index.get() != 0) {
            return self.fail(MachineEvidenceFault::InvalidSiPublication);
        }
        self.si = chronology;
        Ok(())
    }

    /// Latest address-free XFB/VI chronology after the complete selection and receipt were
    /// authenticated. The optional title-fidelity projector consumes this typed record directly;
    /// it never observes renderer inputs or an XFB address.
    #[cfg(feature = "game-fidelity-probes")]
    pub(crate) const fn last_authenticated_xfb_vi(&self) -> Option<MachineXfbViEvidenceV1> {
        self.last_xfb_vi
    }

    /// Issue one immutable canonical ABI snapshot and advance its one-use serial.
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    pub(crate) fn snapshot(&mut self) -> Result<MachineEvidenceV1, MachineEvidenceFault> {
        self.ensure_healthy()?;
        let Some(snapshot_serial) = self.snapshot_serial.checked_add(1) else {
            return self.fail(MachineEvidenceFault::SnapshotSerialOverflow);
        };
        let mut record = MachineEvidenceV1::new(self.machine_epoch, snapshot_serial);
        if self.device.dsp_lle_valid {
            record.flags |= MACHINE_EVIDENCE_DSP_LLE_VALID;
        }
        if self.scheduler.machine_fault.is_some() {
            record.flags |= MACHINE_EVIDENCE_TERMINAL_ERROR;
        }
        record.boot = boot_record(self.boot);
        if self.boot.identity.is_some() {
            record.flags |= MACHINE_EVIDENCE_HAS_BOOT_IDENTITY;
        }
        record.scheduler = MachineSchedulerEvidenceV1 {
            canonical_cycle: EvidenceU64::new(self.scheduler.canonical_cycle),
            executed_cycles: EvidenceU64::new(self.scheduler.executed_cycles),
            executed_instructions: EvidenceU64::new(self.scheduler.executed_instructions),
            address_space_generation: EvidenceU64::new(self.scheduler.address_space_generation),
            retired_blocks: EvidenceU64::new(self.scheduler.retired_blocks),
            completed_outer_slices: EvidenceU64::new(self.scheduler.completed_outer_slices),
            pc: self.scheduler.pc,
            machine_fault_reason_raw: self
                .scheduler
                .machine_fault
                .map_or(0, |fault| fault.reason as u32),
            machine_fault_detail: self.scheduler.machine_fault.map_or(0, |fault| fault.detail),
        };
        record.semantic_idle_cycles = EvidenceU64::new(self.scheduler.semantic_idle_cycles);
        let Ok(semantic_idle_jumps) = u32::try_from(self.scheduler.semantic_idle_jumps) else {
            return self.fail(MachineEvidenceFault::SchedulerInvariant);
        };
        record.semantic_idle_jumps = semantic_idle_jumps;
        record.device = device_record(self.device);
        record.di = di_record(self.di);
        record.graphics = graphics_record(self.graphics);
        record.renderer = renderer_record(self.renderer);
        if let Some(xfb_vi) = self.last_xfb_vi {
            record.flags |= MACHINE_EVIDENCE_HAS_XFB_VI;
            record.xfb_vi = xfb_vi;
        }
        record.si = self.si;
        if self.si.poll_index.get() != 0 {
            record.flags |= MACHINE_EVIDENCE_HAS_SI_PUBLICATION;
        }
        if !record.has_canonical_shape() {
            return self.fail(MachineEvidenceFault::SnapshotInvariant);
        }
        self.snapshot_serial = snapshot_serial;
        Ok(record)
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn set_snapshot_serial_for_test(&mut self, serial: u64) {
        self.snapshot_serial = serial;
    }
}

fn boot_record(state: AuthenticatedBootState) -> MachineBootEvidenceV1 {
    let (logical_bytes, identifier_be_words, revision, disc_number, format_raw) =
        state.identity.map_or((0, [0; 2], 0, 0, 0), |identity| {
            (
                identity.logical_bytes,
                [
                    u32::from_be_bytes([
                        identity.identifier[0],
                        identity.identifier[1],
                        identity.identifier[2],
                        identity.identifier[3],
                    ]),
                    u32::from_be_bytes([identity.identifier[4], identity.identifier[5], 0, 0]),
                ],
                u32::from(identity.revision),
                u32::from(identity.disc_number),
                identity.format as u32,
            )
        });
    MachineBootEvidenceV1 {
        boot_epoch: EvidenceU64::new(state.boot_epoch),
        logical_bytes: EvidenceU64::new(logical_bytes),
        identifier_be_words,
        status_raw: state.status as u32,
        fault_raw: state.fault as u32,
        revision,
        disc_number,
        format_raw,
    }
}

#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
fn device_record(counters: DeviceCounters) -> MachineDeviceEvidenceV1 {
    MachineDeviceEvidenceV1 {
        raw_disk_reads: EvidenceU64::new(counters.raw_disk_reads),
        vi_fields: EvidenceU64::new(counters.vi_fields),
        dsp_lle_steps: EvidenceU64::new(counters.dsp_lle_steps),
        disk_device_errors: EvidenceU64::new(counters.disk_device_errors),
        disk_request_errors: EvidenceU64::new(counters.disk_request_errors),
        controller_queue_overflows: EvidenceU64::new(counters.controller_queue_overflows),
        unknown_si_output_commands: EvidenceU64::new(counters.unknown_si_output_commands),
        unsupported_dtk_records: EvidenceU64::new(counters.unsupported_dtk_records),
        storage_faults_raised: EvidenceU64::new(counters.storage_faults_raised),
        storage_faults_returned: EvidenceU64::new(counters.storage_faults_returned),
        storage_faults_resolved: EvidenceU64::new(counters.storage_faults_resolved),
        storage_fault_recurrences: EvidenceU64::new(counters.storage_fault_recurrences),
        storage_fault_nested: EvidenceU64::new(counters.storage_fault_nested),
        storage_fault_unrecoverable: EvidenceU64::new(counters.storage_fault_unrecoverable),
        di_last_error: counters.di_last_error,
        storage_fault_pending: u32::from(counters.storage_fault_pending),
    }
}

#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
fn di_record(counters: DiCounters) -> MachineDiEvidenceV1 {
    MachineDiEvidenceV1 {
        command_starts: EvidenceU64::new(counters.command_starts),
        command_completions: EvidenceU64::new(counters.command_completions),
        command_cancellations: EvidenceU64::new(counters.command_cancellations),
        command_start_rejections: EvidenceU64::new(counters.command_start_rejections),
        inquiry_starts: EvidenceU64::new(counters.inquiry_starts),
        inquiry_completions: EvidenceU64::new(counters.inquiry_completions),
        inquiry_cancellations: EvidenceU64::new(counters.inquiry_cancellations),
        inquiry_start_rejections: EvidenceU64::new(counters.inquiry_start_rejections),
        read_starts: EvidenceU64::new(counters.read_starts),
        read_sector_starts: EvidenceU64::new(counters.read_sector_starts),
        read_disc_id_starts: EvidenceU64::new(counters.read_disc_id_starts),
        read_completions: EvidenceU64::new(counters.read_completions),
        read_cancellations: EvidenceU64::new(counters.read_cancellations),
        read_start_rejections: EvidenceU64::new(counters.read_start_rejections),
        read_device_failures: EvidenceU64::new(counters.read_device_failures),
        physical_host_requests_issued: EvidenceU64::new(counters.physical_host_requests_issued),
        physical_host_requests_cancelled: EvidenceU64::new(
            counters.physical_host_requests_cancelled,
        ),
        host_receipts_succeeded: EvidenceU64::new(counters.host_receipts_succeeded),
        host_receipts_failed: EvidenceU64::new(counters.host_receipts_failed),
        host_receipts_rejected: EvidenceU64::new(counters.host_receipts_rejected),
        logical_windows_ready: EvidenceU64::new(counters.logical_windows_ready),
        logical_windows_failed: EvidenceU64::new(counters.logical_windows_failed),
        current_state_raw: counters.current_state as u32,
        current_kind_raw: counters.current_kind as u32,
        physical_host_request_pending: u32::from(counters.physical_host_request_pending),
        reserved: 0,
    }
}

#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
fn graphics_record(counters: GraphicsCounters) -> MachineGraphicsEvidenceV1 {
    MachineGraphicsEvidenceV1 {
        gx_bytes: EvidenceU64::new(counters.gx_bytes),
        gx_drains: EvidenceU64::new(counters.gx_drains),
        gx_commands: EvidenceU64::new(counters.gx_commands),
        gx_primitives: EvidenceU64::new(counters.gx_primitives),
        xfb_copies: EvidenceU64::new(counters.xfb_copies),
        presented_frames: EvidenceU64::new(counters.presented_frames),
        emergency_drains: EvidenceU64::new(counters.emergency_drains),
        decoder_errors: EvidenceU64::new(counters.decoder_errors),
        fallbacks: EvidenceU64::new(counters.fallbacks),
        unsupported_records: EvidenceU64::new(counters.unsupported_records),
        exact_rejections: EvidenceU64::new(counters.exact_rejections),
        texture_errors: EvidenceU64::new(counters.texture_errors),
        pending_bytes: EvidenceU64::new(counters.pending_bytes),
        decoder_carry_bytes: EvidenceU64::new(counters.decoder_carry_bytes),
    }
}

#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
fn renderer_record(counters: RenderCounters) -> MachineRenderEvidenceV1 {
    MachineRenderEvidenceV1 {
        render_requests_issued: EvidenceU64::new(counters.render_requests_issued),
        render_completions_authenticated: EvidenceU64::new(
            counters.render_completions_authenticated,
        ),
        render_host_failures: EvidenceU64::new(counters.render_host_failures),
        render_renderer_failures: EvidenceU64::new(counters.render_renderer_failures),
        texture_copy_barriers_entered: EvidenceU64::new(counters.texture_copy_barriers_entered),
        texture_copy_barriers_exited: EvidenceU64::new(counters.texture_copy_barriers_exited),
        render_pending: counters.render_pending,
        render_high_water: counters.render_high_water,
    }
}
