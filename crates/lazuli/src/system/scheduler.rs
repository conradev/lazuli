use std::collections::VecDeque;

use gekko::Cycles;

use crate::system::System;

pub struct HandlerCtx {
    pub cycles_late: Cycles,
}

pub type BasicHandler = fn(&mut System);
pub type FullHandler = fn(&mut System, HandlerCtx);

#[derive(Clone, Copy)]
pub enum Handler {
    Basic(BasicHandler),
    Full(FullHandler),
}

impl PartialEq for Handler {
    #[inline(always)]
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Basic(f), Self::Basic(g)) => std::ptr::fn_addr_eq(*f, *g),
            (Self::Full(f), Self::Full(g)) => std::ptr::fn_addr_eq(*f, *g),
            _ => false,
        }
    }
}

impl Eq for Handler {}

impl Handler {
    #[inline(always)]
    pub fn call(&self, sys: &mut System, ctx: HandlerCtx) {
        match self {
            Self::Basic(f) => f(sys),
            Self::Full(f) => f(sys, ctx),
        }
    }
}

pub struct ScheduledEvent {
    pub cycle: u64,
    pub handler: Handler,
}

pub struct Scheduler {
    elapsed: u64,
    observation_offset: Option<u64>,
    uncommitted_observation_offset: Option<u64>,
    soonest: u64,
    scheduled: VecDeque<ScheduledEvent>,
}

/// One non-nestable, temporary view of machine time used by a resident runtime hook.
///
/// The token is deliberately neither `Copy` nor `Clone`: the caller must return the exact scope
/// to [`Scheduler::end_observation`] on every normal hook exit. While it is live, canonical time
/// does not move; reads and newly scheduled events observe `canonical + offset` instead.
#[derive(Debug, PartialEq, Eq)]
#[must_use = "a scheduler observation must be ended after the resident hook returns"]
pub struct SchedulerObservation {
    offset: u64,
    prior_soonest: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerObservationEffect {
    Unchanged,
    EarlierDeadline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerObservationError {
    AlreadyObserving,
    NotObserving,
    MismatchedScope,
    NonMonotonicObservation,
    CycleOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerAdvanceError {
    ObservationActive,
    AdvancePrecedesObservation,
    CycleOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerScheduleError {
    UncommittedObservation,
    CycleOverflow,
}

impl std::fmt::Debug for Scheduler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Scheduler")
            .field("elapsed", &self.elapsed)
            .field("observation_offset", &self.observation_offset)
            .field(
                "uncommitted_observation_offset",
                &self.uncommitted_observation_offset,
            )
            .field("scheduled", &self.scheduled.len())
            .finish()
    }
}

impl Default for Scheduler {
    fn default() -> Self {
        Self {
            elapsed: 0,
            observation_offset: None,
            uncommitted_observation_offset: None,
            soonest: u64::MAX,
            scheduled: VecDeque::with_capacity(16),
        }
    }
}

impl Scheduler {
    #[inline(always)]
    fn soonest(&self) -> u64 {
        self.scheduled.front().map_or(u64::MAX, |e| e.cycle)
    }

    #[inline(always)]
    fn observed_elapsed(&self) -> u64 {
        self.elapsed
            .checked_add(self.observation_offset.unwrap_or(0))
            .expect("an authenticated scheduler observation cannot overflow")
    }

    #[inline(always)]
    fn schedule_cycle(&self, after: u64) -> Result<u64, SchedulerScheduleError> {
        if self.observation_offset.is_none() && self.uncommitted_observation_offset.is_some() {
            return Err(SchedulerScheduleError::UncommittedObservation);
        }
        self.observed_elapsed()
            .checked_add(after)
            .ok_or(SchedulerScheduleError::CycleOverflow)
    }

    #[inline(always)]
    fn insert_scheduled(&mut self, cycle: u64, handler: Handler) {
        self.soonest = self.soonest.min(cycle);
        let index = self.scheduled.partition_point(|e| e.cycle <= cycle);
        self.scheduled
            .insert(index, ScheduledEvent { cycle, handler });
    }

    /// Begins one temporary observation at `canonical elapsed + offset`.
    ///
    /// Observations cannot nest. The canonical clock remains unchanged until the returned token
    /// is passed to [`Self::end_observation`].
    pub fn begin_observation(
        &mut self,
        offset: u64,
    ) -> Result<SchedulerObservation, SchedulerObservationError> {
        if self.observation_offset.is_some() {
            return Err(SchedulerObservationError::AlreadyObserving);
        }
        if self
            .uncommitted_observation_offset
            .is_some_and(|observed| offset < observed)
        {
            return Err(SchedulerObservationError::NonMonotonicObservation);
        }
        self.elapsed
            .checked_add(offset)
            .ok_or(SchedulerObservationError::CycleOverflow)?;
        self.observation_offset = Some(offset);
        self.uncommitted_observation_offset = Some(offset);
        Ok(SchedulerObservation {
            offset,
            prior_soonest: self.soonest,
        })
    }

    /// Ends the exact temporary observation issued by [`Self::begin_observation`].
    pub fn end_observation(
        &mut self,
        observation: SchedulerObservation,
    ) -> Result<SchedulerObservationEffect, SchedulerObservationError> {
        let Some(offset) = self.observation_offset else {
            return Err(SchedulerObservationError::NotObserving);
        };
        if offset != observation.offset {
            return Err(SchedulerObservationError::MismatchedScope);
        }
        self.observation_offset = None;
        Ok(if self.soonest < observation.prior_soonest {
            SchedulerObservationEffect::EarlierDeadline
        } else {
            SchedulerObservationEffect::Unchanged
        })
    }

    #[must_use]
    #[inline(always)]
    pub const fn is_observing(&self) -> bool {
        self.observation_offset.is_some()
    }

    /// How many CPU cycles have canonically committed at an outer machine boundary.
    #[must_use]
    #[inline(always)]
    pub const fn canonical_elapsed(&self) -> u64 {
        self.elapsed
    }

    #[inline(always)]
    pub fn schedule(&mut self, after: u64, handler: BasicHandler) {
        self.try_schedule(after, handler)
            .expect("legacy scheduler event violated its observation contract");
    }

    /// Schedules a callback relative to the active observed time, without panicking on an
    /// uncommitted scope or an unrepresentable absolute cycle.
    pub fn try_schedule(
        &mut self,
        after: u64,
        handler: BasicHandler,
    ) -> Result<(), SchedulerScheduleError> {
        let cycle = self.schedule_cycle(after)?;
        self.insert_scheduled(cycle, Handler::Basic(handler));
        Ok(())
    }

    #[inline(always)]
    pub fn schedule_now(&mut self, handler: BasicHandler) {
        self.schedule(0, handler)
    }

    #[inline(always)]
    pub fn schedule_full(&mut self, after: u64, handler: FullHandler) {
        self.try_schedule_full(after, handler)
            .expect("legacy scheduler event violated its observation contract");
    }

    pub fn try_schedule_full(
        &mut self,
        after: u64,
        handler: FullHandler,
    ) -> Result<(), SchedulerScheduleError> {
        let cycle = self.schedule_cycle(after)?;
        self.insert_scheduled(cycle, Handler::Full(handler));
        Ok(())
    }

    #[inline(always)]
    pub fn cancel(&mut self, handler: BasicHandler) {
        let handler = Handler::Basic(handler);
        self.scheduled.retain(|e| e.handler != handler);
        self.soonest = self.soonest();
    }

    #[inline(always)]
    pub fn cancel_full(&mut self, handler: FullHandler) {
        let handler = Handler::Full(handler);
        self.scheduled.retain(|e| e.handler != handler);
        self.soonest = self.soonest();
    }

    #[inline(always)]
    pub fn len(&self) -> usize {
        self.scheduled.len()
    }

    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline(always)]
    pub fn advance(&mut self, count: u64) {
        self.try_advance(count)
            .expect("canonical scheduler advance violated its observation contract");
    }

    /// Proves that an exact canonical advance can commit without changing scheduler state.
    ///
    /// The returned value is the resulting canonical cycle. Callers that coordinate the same
    /// delta with another Rust-owned budget can validate both sides before mutating either one.
    pub fn validate_advance(&self, count: u64) -> Result<u64, SchedulerAdvanceError> {
        if self.observation_offset.is_some() {
            return Err(SchedulerAdvanceError::ObservationActive);
        }
        if self
            .uncommitted_observation_offset
            .is_some_and(|observed| count < observed)
        {
            return Err(SchedulerAdvanceError::AdvancePrecedesObservation);
        }
        self.elapsed
            .checked_add(count)
            .ok_or(SchedulerAdvanceError::CycleOverflow)
    }

    /// Commits one authenticated dispatcher report to canonical machine time.
    ///
    /// Failure leaves both canonical time and the uncommitted observation high-water unchanged.
    pub fn try_advance(&mut self, count: u64) -> Result<(), SchedulerAdvanceError> {
        let elapsed = self.validate_advance(count)?;
        self.elapsed = elapsed;
        self.uncommitted_observation_offset = None;
        Ok(())
    }

    #[inline(always)]
    pub fn until_next(&self) -> Option<u64> {
        self.scheduled
            .front()
            .map(|e| e.cycle.saturating_sub(self.observed_elapsed()))
    }

    #[inline(always)]
    pub fn has_pending(&self) -> bool {
        self.soonest <= self.observed_elapsed()
    }

    #[inline(always)]
    pub fn pop(&mut self) -> Option<ScheduledEvent> {
        assert!(
            self.observation_offset.is_none() && self.uncommitted_observation_offset.is_none(),
            "scheduled events cannot be serviced before observed hook time commits"
        );
        self.scheduled
            .pop_front_if(|e| e.cycle <= self.elapsed)
            .inspect(|_| self.soonest = self.soonest())
    }

    #[inline(always)]
    pub fn contains(&self, handler: BasicHandler) -> bool {
        let handler = Handler::Basic(handler);
        self.scheduled.iter().any(|e| e.handler == handler)
    }

    #[inline(always)]
    pub fn contains_full(&self, handler: FullHandler) -> bool {
        let handler = Handler::Full(handler);
        self.scheduled.iter().any(|e| e.handler == handler)
    }

    /// How many CPU cycles have elapsed.
    #[inline(always)]
    pub fn elapsed(&self) -> u64 {
        self.observed_elapsed()
    }

    /// How many time base cycles have elapsed.
    #[inline(always)]
    pub fn elapsed_time_base(&self) -> u64 {
        self.observed_elapsed() / 12
    }
}

#[cfg(test)]
mod scheduler_observation_tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use super::*;

    fn basic_handler(_: &mut System) {}

    fn full_handler(_: &mut System, _: HandlerCtx) {}

    #[test]
    fn observation_changes_reads_and_schedule_base_without_committing_time() {
        let mut scheduler = Scheduler::default();
        scheduler.advance(120);

        let observation = scheduler.begin_observation(25).unwrap();
        assert!(scheduler.is_observing());
        assert_eq!(scheduler.canonical_elapsed(), 120);
        assert_eq!(scheduler.elapsed(), 145);
        assert_eq!(scheduler.elapsed_time_base(), 12);
        scheduler.schedule(5, basic_handler);
        scheduler.schedule_full(2, full_handler);
        assert_eq!(scheduler.until_next(), Some(2));
        assert!(!scheduler.has_pending());
        assert_eq!(
            scheduler.begin_observation(1),
            Err(SchedulerObservationError::AlreadyObserving)
        );

        assert_eq!(
            scheduler.end_observation(observation),
            Ok(SchedulerObservationEffect::EarlierDeadline)
        );
        assert!(!scheduler.is_observing());
        assert_eq!(scheduler.elapsed(), 120);
        assert_eq!(scheduler.canonical_elapsed(), 120);
        assert_eq!(scheduler.until_next(), Some(27));

        scheduler.advance(27);
        let event = scheduler.pop().unwrap();
        assert_eq!(event.cycle, 147);
        assert!(matches!(event.handler, Handler::Full(_)));
        assert_eq!(scheduler.until_next(), Some(3));
    }

    #[test]
    fn observation_rejects_canonical_advance_and_event_service_until_closed() {
        let mut scheduler = Scheduler::default();
        scheduler.advance(100);
        scheduler.schedule(1, basic_handler);
        let observation = scheduler.begin_observation(1).unwrap();
        assert!(scheduler.has_pending());

        assert_eq!(
            scheduler.try_advance(1),
            Err(SchedulerAdvanceError::ObservationActive)
        );
        assert_eq!(scheduler.canonical_elapsed(), 100);
        assert_eq!(scheduler.elapsed(), 101);

        let service = catch_unwind(AssertUnwindSafe(|| scheduler.pop()));
        assert!(service.is_err());
        assert!(scheduler.has_pending());

        scheduler.end_observation(observation).unwrap();
        assert!(!scheduler.has_pending());
        let premature_service = catch_unwind(AssertUnwindSafe(|| scheduler.pop()));
        assert!(premature_service.is_err());
        assert_eq!(scheduler.canonical_elapsed(), 100);
        scheduler.advance(1);
        assert_eq!(scheduler.pop().map(|event| event.cycle), Some(101));
    }

    #[test]
    fn observation_cycle_overflow_fails_without_opening_a_scope() {
        let mut scheduler = Scheduler::default();
        scheduler.advance(u64::MAX - 1);
        assert_eq!(
            scheduler.begin_observation(2),
            Err(SchedulerObservationError::CycleOverflow)
        );
        assert!(!scheduler.is_observing());
        assert_eq!(scheduler.elapsed(), u64::MAX - 1);
    }

    #[test]
    fn observations_are_monotonic_until_the_authenticated_advance_commits() {
        let mut scheduler = Scheduler::default();
        scheduler.advance(100);

        let first = scheduler.begin_observation(25).unwrap();
        scheduler.end_observation(first).unwrap();
        assert_eq!(
            scheduler.begin_observation(24),
            Err(SchedulerObservationError::NonMonotonicObservation)
        );
        assert!(!scheduler.is_observing());
        assert_eq!(scheduler.elapsed(), 100);

        assert_eq!(
            scheduler.try_advance(24),
            Err(SchedulerAdvanceError::AdvancePrecedesObservation)
        );
        assert_eq!(scheduler.canonical_elapsed(), 100);

        let repeated = scheduler.begin_observation(25).unwrap();
        scheduler.end_observation(repeated).unwrap();
        scheduler.advance(25);
        assert_eq!(scheduler.elapsed(), 125);

        // A committed dispatcher report starts a new monotonic observation segment.
        let next_segment = scheduler.begin_observation(1).unwrap();
        assert_eq!(scheduler.elapsed(), 126);
        scheduler.end_observation(next_segment).unwrap();
        scheduler.advance(1);
        assert_eq!(scheduler.canonical_elapsed(), 126);
    }

    #[test]
    fn advance_validation_matches_commit_rejections_without_mutating_state() {
        let mut active = Scheduler::default();
        let observation = active.begin_observation(2).unwrap();
        assert_eq!(
            active.validate_advance(2),
            Err(SchedulerAdvanceError::ObservationActive)
        );
        assert_eq!(
            active.try_advance(2),
            Err(SchedulerAdvanceError::ObservationActive)
        );
        assert_eq!(active.canonical_elapsed(), 0);
        assert_eq!(active.elapsed(), 2);
        assert!(active.is_observing());

        active.end_observation(observation).unwrap();
        assert_eq!(
            active.validate_advance(1),
            Err(SchedulerAdvanceError::AdvancePrecedesObservation)
        );
        assert_eq!(
            active.try_advance(1),
            Err(SchedulerAdvanceError::AdvancePrecedesObservation)
        );
        assert_eq!(active.canonical_elapsed(), 0);
        assert_eq!(active.elapsed(), 0);
        assert!(!active.is_observing());
        assert_eq!(active.validate_advance(2), Ok(2));
        assert_eq!(active.try_advance(2), Ok(()));
        assert_eq!(active.canonical_elapsed(), 2);

        let mut overflow = Scheduler::default();
        overflow.try_advance(u64::MAX).unwrap();
        assert_eq!(
            overflow.validate_advance(1),
            Err(SchedulerAdvanceError::CycleOverflow)
        );
        assert_eq!(
            overflow.try_advance(1),
            Err(SchedulerAdvanceError::CycleOverflow)
        );
        assert_eq!(overflow.canonical_elapsed(), u64::MAX);
        assert_eq!(overflow.elapsed(), u64::MAX);
    }

    #[test]
    fn checked_scheduling_rejects_uncommitted_or_unrepresentable_time() {
        let mut scheduler = Scheduler::default();
        scheduler.advance(100);
        let observation = scheduler.begin_observation(25).unwrap();
        assert_eq!(
            scheduler.end_observation(observation),
            Ok(SchedulerObservationEffect::Unchanged)
        );

        assert_eq!(
            scheduler.try_schedule(1, basic_handler),
            Err(SchedulerScheduleError::UncommittedObservation)
        );
        let legacy_schedule = catch_unwind(AssertUnwindSafe(|| {
            scheduler.schedule_now(basic_handler);
        }));
        assert!(legacy_schedule.is_err());
        assert!(scheduler.is_empty());

        let reopened = scheduler.begin_observation(25).unwrap();
        scheduler.schedule_now(basic_handler);
        assert_eq!(
            scheduler.end_observation(reopened),
            Ok(SchedulerObservationEffect::EarlierDeadline)
        );
        scheduler.try_advance(25).unwrap();
        assert_eq!(scheduler.pop().map(|event| event.cycle), Some(125));

        let mut near_limit = Scheduler::default();
        near_limit.advance(u64::MAX - 1);
        assert_eq!(
            near_limit.try_schedule(2, basic_handler),
            Err(SchedulerScheduleError::CycleOverflow)
        );
        assert_eq!(
            near_limit.try_schedule_full(2, full_handler),
            Err(SchedulerScheduleError::CycleOverflow)
        );
        assert!(near_limit.is_empty());
    }
}

/// Number of independently selectable deadlines in the browser-resident machine policy.
pub const MACHINE_EVENT_KIND_COUNT: usize = 18;

/// Number of ordered service phases in the browser machine's synchronous device pass.
pub const MACHINE_SERVICE_PHASE_COUNT: usize = 13;

/// Synchronous service phases extracted from `serviceMmio`.
///
/// Not every phase has a scalar deadline. In particular, command-processor and EXI work is
/// condition/level driven. Keeping those phases in the order prevents a later device port from
/// accidentally delivering a same-cycle interrupt in a different priority than the proven
/// browser machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum MachineServicePhase {
    CommandProcessorFifo,
    CommandProcessorInterrupt,
    ViScheduleRefresh,
    ViDueEvents,
    ExternalInterface,
    AudioInterface,
    Dsp,
    Serial,
    PixelEngine,
    VideoPresentation,
    VideoInterrupt,
    Disk,
    Decrementer,
}

impl MachineServicePhase {
    /// Complete top-level browser service order, including phases without scalar deadlines.
    pub const BROWSER_ORDER: [Self; MACHINE_SERVICE_PHASE_COUNT] = [
        Self::CommandProcessorFifo,
        Self::CommandProcessorInterrupt,
        Self::ViScheduleRefresh,
        Self::ViDueEvents,
        Self::ExternalInterface,
        Self::AudioInterface,
        Self::Dsp,
        Self::Serial,
        Self::PixelEngine,
        Self::VideoPresentation,
        Self::VideoInterrupt,
        Self::Disk,
        Self::Decrementer,
    ];
}

const _: () = assert!(MachineServicePhase::Decrementer as usize + 1 == MACHINE_SERVICE_PHASE_COUNT);

/// A timed transition owned by the emulated machine.
///
/// This is the Rust counterpart of the scalar candidates formerly selected by
/// `nextRuntimeEventCycle` in the browser harness. The enum includes the projected DSP/AI
/// completion deadlines used only while accelerating an authenticated basic idle loop. It also
/// includes the runner cycle limit so the boundary selector can reproduce the complete browser
/// contract without treating that debugging boundary as a device event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum MachineEventKind {
    ViComparator,
    ViPresentation,
    ViScanoutBoundary,
    ViTimingBoundary,
    SiPoll,
    Decrementer,
    DiskCompletion,
    DiskAudio,
    SiTransferCompletion,
    PeFinish,
    DspExecution,
    DspAudioDmaInterrupt,
    DspAudioDmaBlock,
    DspAudioDmaCompletion,
    AramDmaCompletion,
    AiSample,
    AiInterrupt,
    CycleLimit,
}

const _: () = assert!(MachineEventKind::CycleLimit as usize + 1 == MACHINE_EVENT_KIND_COUNT);
const _: () = assert!(MACHINE_EVENT_KIND_COUNT <= u32::BITS as usize);

impl MachineEventKind {
    /// Candidate order extracted from `runtimeEventCycleCandidates`.
    ///
    /// Minimum selection is intentionally independent of this order. Keeping the source order
    /// explicit makes ports and differential fixtures auditable.
    pub const BROWSER_CANDIDATE_ORDER: [Self; MACHINE_EVENT_KIND_COUNT] = [
        Self::ViComparator,
        Self::ViPresentation,
        Self::ViScanoutBoundary,
        Self::ViTimingBoundary,
        Self::SiPoll,
        Self::Decrementer,
        Self::DiskCompletion,
        Self::DiskAudio,
        Self::SiTransferCompletion,
        Self::PeFinish,
        Self::DspExecution,
        Self::DspAudioDmaInterrupt,
        Self::DspAudioDmaBlock,
        Self::DspAudioDmaCompletion,
        Self::AramDmaCompletion,
        Self::AiSample,
        Self::AiInterrupt,
        Self::CycleLimit,
    ];

    /// Same-cycle order extracted from `serviceMmio` and its nested device services.
    ///
    /// The browser's unconditional command-processor and external-interface passes have no
    /// deadline in this set. A resident machine services those passes at the documented seams:
    /// command processor before `ViComparator`, EXI between `ViScanoutBoundary` and `AiSample`,
    /// DSP interrupt-level refresh after `DspExecution`, and VI interrupt-level refresh after
    /// `ViPresentation`.
    pub const BROWSER_SERVICE_ORDER: [Self; MACHINE_EVENT_KIND_COUNT] = [
        // serviceViDueEvents: comparator observes the old raster, then timing is promoted, then
        // scanout captures the promoted geometry.
        Self::ViComparator,
        Self::ViTimingBoundary,
        Self::ViScanoutBoundary,
        // serviceAudioInterface updates the counter before delivering its level interrupt.
        Self::AiSample,
        Self::AiInterrupt,
        // serviceDsp: AID status, AID blocks, ARAM completion, interpreter quantum.
        Self::DspAudioDmaInterrupt,
        Self::DspAudioDmaBlock,
        Self::DspAudioDmaCompletion,
        Self::AramDmaCompletion,
        Self::DspExecution,
        // serviceSerial polls controllers before completing a direct transfer.
        Self::SiPoll,
        Self::SiTransferCompletion,
        Self::PeFinish,
        Self::ViPresentation,
        // serviceDisk advances DTK before completing the DI command.
        Self::DiskAudio,
        Self::DiskCompletion,
        // The decrementer is the final timed service in serviceMmio.
        Self::Decrementer,
        // A cycle limit stops the runner and is never delivered to a device.
        Self::CycleLimit,
    ];

    #[inline(always)]
    const fn index(self) -> usize {
        self as usize
    }

    #[inline(always)]
    const fn is_vi(self) -> bool {
        matches!(
            self,
            Self::ViComparator
                | Self::ViPresentation
                | Self::ViScanoutBoundary
                | Self::ViTimingBoundary
        )
    }

    /// Synchronous phase that consumes this deadline, or `None` for a runner-only boundary.
    #[must_use]
    pub const fn service_phase(self) -> Option<MachineServicePhase> {
        match self {
            Self::ViComparator | Self::ViScanoutBoundary | Self::ViTimingBoundary => {
                Some(MachineServicePhase::ViDueEvents)
            }
            Self::ViPresentation => Some(MachineServicePhase::VideoPresentation),
            Self::SiPoll | Self::SiTransferCompletion => Some(MachineServicePhase::Serial),
            Self::Decrementer => Some(MachineServicePhase::Decrementer),
            Self::DiskCompletion | Self::DiskAudio => Some(MachineServicePhase::Disk),
            Self::PeFinish => Some(MachineServicePhase::PixelEngine),
            Self::DspExecution
            | Self::DspAudioDmaInterrupt
            | Self::DspAudioDmaBlock
            | Self::DspAudioDmaCompletion
            | Self::AramDmaCompletion => Some(MachineServicePhase::Dsp),
            Self::AiSample | Self::AiInterrupt => Some(MachineServicePhase::AudioInterface),
            Self::CycleLimit => None,
        }
    }
}

/// Controls the two optional projections supported by the browser deadline selector.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuntimeDeadlinePolicy {
    /// Whether a finite runner limit participates in future-boundary selection.
    pub include_cycle_limit: bool,
    /// Whether an authenticated basic idle may skip non-interrupting DSP/AI transitions.
    pub coalesce_idle_audio: bool,
}

impl RuntimeDeadlinePolicy {
    /// Exact device scheduling: no runner boundary and no idle projection.
    pub const EXACT: Self = Self {
        include_cycle_limit: false,
        coalesce_idle_audio: false,
    };
}

/// One selected machine deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MachineEvent {
    pub kind: MachineEventKind,
    pub cycle: u64,
}

/// Allocation-free deadlines for the Wasm-resident machine loop.
///
/// The older native [`Scheduler`] is a dynamically sized callback queue. It gives equal-cycle
/// callbacks FIFO insertion order, but does not encode VI visibility, idle audio projection, or
/// the browser's architectural device-service order. This fixed state is the migration seam for
/// those policies. Device implementations still own recurrence and catch-up; after servicing an
/// event they update their scalar deadline here.
///
/// # Device-port mapping
///
/// - VI owns comparator, presentation, scanout-boundary, and timing-boundary deadlines. All four
///   are ignored while display timing is disabled.
/// - SI owns its periodic poll and direct-transfer completion deadlines.
/// - DI owns command completion; DTK owns `DiskAudio` and is serviced first on a tie. Browser
///   storage readiness gates delivery at the DI deadline and must not change emulated time.
/// - DSP owns its interpreter quantum, initial audio-DMA interrupt, audio-DMA block/completion,
///   and ARAM-DMA completion. The completion entry is an idle-only projection of the block stream.
/// - AI owns its next sample and projected next interrupt. The latter is also idle-only.
/// - PE finish and DEC underflow retain their current browser ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MachineEventDeadlines {
    deadlines: [Option<u64>; MACHINE_EVENT_KIND_COUNT],
    vi_display_enabled: bool,
}

impl Default for MachineEventDeadlines {
    fn default() -> Self {
        Self {
            deadlines: [None; MACHINE_EVENT_KIND_COUNT],
            vi_display_enabled: false,
        }
    }
}

impl MachineEventDeadlines {
    #[inline(always)]
    pub fn set_vi_display_enabled(&mut self, enabled: bool) {
        self.vi_display_enabled = enabled;
    }

    #[must_use]
    #[inline(always)]
    pub fn vi_display_enabled(&self) -> bool {
        self.vi_display_enabled
    }

    #[inline(always)]
    pub fn set(&mut self, kind: MachineEventKind, cycle: Option<u64>) {
        self.deadlines[kind.index()] = cycle;
    }

    #[inline(always)]
    pub fn schedule(&mut self, kind: MachineEventKind, cycle: u64) {
        self.set(kind, Some(cycle));
    }

    #[inline(always)]
    pub fn clear(&mut self, kind: MachineEventKind) {
        self.set(kind, None);
    }

    #[must_use]
    #[inline(always)]
    pub fn deadline(&self, kind: MachineEventKind) -> Option<u64> {
        self.deadlines[kind.index()]
    }

    #[inline(always)]
    fn enabled(&self, kind: MachineEventKind, policy: RuntimeDeadlinePolicy) -> bool {
        if kind.is_vi() && !self.vi_display_enabled {
            return false;
        }
        match kind {
            MachineEventKind::DspAudioDmaBlock => !policy.coalesce_idle_audio,
            MachineEventKind::DspAudioDmaCompletion => policy.coalesce_idle_audio,
            MachineEventKind::AiSample => !policy.coalesce_idle_audio,
            MachineEventKind::AiInterrupt => policy.coalesce_idle_audio,
            MachineEventKind::CycleLimit => policy.include_cycle_limit,
            _ => true,
        }
    }

    /// Selects the first future deadline, breaking an exact-cycle tie in browser service order.
    ///
    /// A deadline equal to `now` is already due and is deliberately excluded, matching
    /// `nextRuntimeEventCycle`.
    #[must_use]
    #[inline(always)]
    pub fn next_event_after(
        &self,
        now: u64,
        policy: RuntimeDeadlinePolicy,
    ) -> Option<MachineEvent> {
        let mut selected: Option<MachineEvent> = None;
        for kind in MachineEventKind::BROWSER_SERVICE_ORDER {
            if !self.enabled(kind, policy) {
                continue;
            }
            let Some(cycle) = self.deadline(kind) else {
                continue;
            };
            if cycle <= now {
                continue;
            }
            if selected.is_none_or(|selected| cycle < selected.cycle) {
                selected = Some(MachineEvent { kind, cycle });
            }
        }
        selected
    }

    /// Returns only the cycle selected by [`Self::next_event_after`].
    #[must_use]
    #[inline(always)]
    pub fn next_cycle_after(&self, now: u64, policy: RuntimeDeadlinePolicy) -> Option<u64> {
        self.next_event_after(now, policy).map(|event| event.cycle)
    }

    /// Matches the browser's raw `runtimeEventDueAtOrBefore` predicate.
    ///
    /// Cycle limits are not device delivery boundaries and idle audio projection is never used
    /// while checking whether an architectural transition is already due.
    #[must_use]
    pub fn runtime_event_due_at_or_before(&self, observed_cycle: u64) -> bool {
        self.deadlines_due_at_or_before(observed_cycle, RuntimeDeadlinePolicy::EXACT)
            .next()
            .is_some()
    }

    /// Returns the first due transition in browser service order.
    ///
    /// This is the preferred resident-loop primitive: service the result, update its device's
    /// deadline, then call again. That preserves periodic catch-up before a later service phase.
    #[must_use]
    #[inline(always)]
    pub fn next_due_event_at_or_before(
        &self,
        observed_cycle: u64,
        policy: RuntimeDeadlinePolicy,
    ) -> Option<MachineEvent> {
        self.deadlines_due_at_or_before(observed_cycle, policy)
            .next()
    }

    /// Iterates a snapshot of due deadlines in browser service-phase order.
    ///
    /// Within `ViDueEvents`, the earliest scheduled raster transition wins and comparator,
    /// timing, then scanout breaks an exact-cycle tie. Other phases retain their nested browser
    /// order even when multiple kinds are overdue. The iterator stores only a bit mask and
    /// borrows this fixed array. `CycleLimit` is never yielded because it is a runner boundary,
    /// not a machine transition.
    #[must_use]
    #[inline(always)]
    pub fn deadlines_due_at_or_before(
        &self,
        observed_cycle: u64,
        policy: RuntimeDeadlinePolicy,
    ) -> DueMachineEvents<'_> {
        DueMachineEvents {
            deadlines: self,
            observed_cycle,
            policy,
            yielded: 0,
        }
    }
}

/// Allocation-free iterator returned by [`MachineEventDeadlines::deadlines_due_at_or_before`].
pub struct DueMachineEvents<'a> {
    deadlines: &'a MachineEventDeadlines,
    observed_cycle: u64,
    policy: RuntimeDeadlinePolicy,
    yielded: u32,
}

impl Iterator for DueMachineEvents<'_> {
    type Item = MachineEvent;

    #[inline(always)]
    fn next(&mut self) -> Option<Self::Item> {
        for phase in MachineServicePhase::BROWSER_ORDER {
            let mut selected: Option<MachineEvent> = None;
            for kind in MachineEventKind::BROWSER_SERVICE_ORDER {
                let bit = 1_u32 << kind.index();
                if self.yielded & bit != 0
                    || kind.service_phase() != Some(phase)
                    || !self.deadlines.enabled(kind, self.policy)
                {
                    continue;
                }
                let Some(cycle) = self.deadlines.deadline(kind) else {
                    continue;
                };
                if cycle > self.observed_cycle {
                    continue;
                }
                // Only VI due events are drained in scheduled-cycle order. Every other browser
                // subsystem owns an explicit nested order and catches up before the next phase.
                if selected.is_none()
                    || (phase == MachineServicePhase::ViDueEvents
                        && selected.is_some_and(|selected| cycle < selected.cycle))
                {
                    selected = Some(MachineEvent { kind, cycle });
                }
            }
            if let Some(selected) = selected {
                self.yielded |= 1_u32 << selected.kind.index();
                return Some(selected);
            }
        }
        None
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (0, Some(MACHINE_EVENT_KIND_COUNT))
    }
}

impl std::iter::FusedIterator for DueMachineEvents<'_> {}

#[cfg(test)]
mod machine_deadline_tests {
    use super::*;

    fn exact_fixture() -> MachineEventDeadlines {
        let mut deadlines = MachineEventDeadlines::default();
        deadlines.set_vi_display_enabled(true);
        deadlines.schedule(MachineEventKind::ViComparator, 140);
        deadlines.schedule(MachineEventKind::ViPresentation, 150);
        deadlines.schedule(MachineEventKind::ViScanoutBoundary, 150);
        deadlines.schedule(MachineEventKind::ViTimingBoundary, 150);
        deadlines.schedule(MachineEventKind::SiPoll, 130);
        deadlines.schedule(MachineEventKind::Decrementer, 190);
        deadlines.schedule(MachineEventKind::DiskCompletion, 180);
        deadlines.schedule(MachineEventKind::DiskAudio, 170);
        deadlines.schedule(MachineEventKind::SiTransferCompletion, 160);
        deadlines.schedule(MachineEventKind::PeFinish, 155);
        deadlines.schedule(MachineEventKind::DspExecution, 108);
        deadlines.schedule(MachineEventKind::DspAudioDmaInterrupt, 120);
        deadlines.schedule(MachineEventKind::DspAudioDmaBlock, 110);
        deadlines.schedule(MachineEventKind::DspAudioDmaCompletion, 160);
        deadlines.schedule(MachineEventKind::AramDmaCompletion, 145);
        deadlines.schedule(MachineEventKind::AiSample, 105);
        deadlines.schedule(MachineEventKind::AiInterrupt, 170);
        deadlines.schedule(MachineEventKind::CycleLimit, 101);
        deadlines
    }

    fn reference_next_cycle(
        deadlines: &MachineEventDeadlines,
        now: u64,
        policy: RuntimeDeadlinePolicy,
    ) -> Option<u64> {
        // Literal transcription of runtimeEventCycleCandidates. Keep this oracle separate from
        // the production selector so randomized changes catch a missing or incorrectly gated
        // candidate.
        let candidate = |kind| deadlines.deadline(kind);
        let vi = deadlines.vi_display_enabled();
        let values = [
            vi.then(|| candidate(MachineEventKind::ViComparator))
                .flatten(),
            vi.then(|| candidate(MachineEventKind::ViPresentation))
                .flatten(),
            vi.then(|| candidate(MachineEventKind::ViScanoutBoundary))
                .flatten(),
            vi.then(|| candidate(MachineEventKind::ViTimingBoundary))
                .flatten(),
            candidate(MachineEventKind::SiPoll),
            candidate(MachineEventKind::Decrementer),
            candidate(MachineEventKind::DiskCompletion),
            candidate(MachineEventKind::DiskAudio),
            candidate(MachineEventKind::SiTransferCompletion),
            candidate(MachineEventKind::PeFinish),
            candidate(MachineEventKind::DspExecution),
            candidate(MachineEventKind::DspAudioDmaInterrupt),
            candidate(if policy.coalesce_idle_audio {
                MachineEventKind::DspAudioDmaCompletion
            } else {
                MachineEventKind::DspAudioDmaBlock
            }),
            candidate(MachineEventKind::AramDmaCompletion),
            candidate(if policy.coalesce_idle_audio {
                MachineEventKind::AiInterrupt
            } else {
                MachineEventKind::AiSample
            }),
            policy
                .include_cycle_limit
                .then(|| candidate(MachineEventKind::CycleLimit))
                .flatten(),
        ];
        values
            .into_iter()
            .flatten()
            .filter(|cycle| *cycle > now)
            .min()
    }

    fn reference_due(deadlines: &MachineEventDeadlines, observed_cycle: u64) -> bool {
        let policy = RuntimeDeadlinePolicy::EXACT;
        reference_candidates(deadlines, policy)
            .into_iter()
            .flatten()
            .any(|cycle| cycle <= observed_cycle)
    }

    fn reference_candidates(
        deadlines: &MachineEventDeadlines,
        policy: RuntimeDeadlinePolicy,
    ) -> [Option<u64>; 15] {
        let candidate = |kind| deadlines.deadline(kind);
        let vi = deadlines.vi_display_enabled();
        [
            vi.then(|| candidate(MachineEventKind::ViComparator))
                .flatten(),
            vi.then(|| candidate(MachineEventKind::ViPresentation))
                .flatten(),
            vi.then(|| candidate(MachineEventKind::ViScanoutBoundary))
                .flatten(),
            vi.then(|| candidate(MachineEventKind::ViTimingBoundary))
                .flatten(),
            candidate(MachineEventKind::SiPoll),
            candidate(MachineEventKind::Decrementer),
            candidate(MachineEventKind::DiskCompletion),
            candidate(MachineEventKind::DiskAudio),
            candidate(MachineEventKind::SiTransferCompletion),
            candidate(MachineEventKind::PeFinish),
            candidate(MachineEventKind::DspExecution),
            candidate(MachineEventKind::DspAudioDmaInterrupt),
            candidate(if policy.coalesce_idle_audio {
                MachineEventKind::DspAudioDmaCompletion
            } else {
                MachineEventKind::DspAudioDmaBlock
            }),
            candidate(MachineEventKind::AramDmaCompletion),
            candidate(if policy.coalesce_idle_audio {
                MachineEventKind::AiInterrupt
            } else {
                MachineEventKind::AiSample
            }),
        ]
    }

    #[test]
    fn browser_deadline_fixtures_keep_exact_and_idle_audio_boundaries() {
        let deadlines = exact_fixture();
        assert_eq!(
            deadlines.next_cycle_after(100, RuntimeDeadlinePolicy::EXACT),
            Some(105)
        );
        assert_eq!(
            deadlines.next_cycle_after(
                100,
                RuntimeDeadlinePolicy {
                    include_cycle_limit: false,
                    coalesce_idle_audio: true,
                },
            ),
            Some(108)
        );
        assert_eq!(
            deadlines.next_cycle_after(
                100,
                RuntimeDeadlinePolicy {
                    include_cycle_limit: true,
                    coalesce_idle_audio: true,
                },
            ),
            Some(101)
        );
    }

    #[test]
    fn due_and_future_boundaries_are_disjoint_and_cycle_limit_is_not_a_device() {
        let mut deadlines = MachineEventDeadlines::default();
        deadlines.schedule(MachineEventKind::AramDmaCompletion, 101);
        deadlines.schedule(MachineEventKind::CycleLimit, 90);
        assert!(!deadlines.runtime_event_due_at_or_before(100));
        assert_eq!(
            deadlines.next_cycle_after(100, RuntimeDeadlinePolicy::EXACT),
            Some(101)
        );

        deadlines.schedule(MachineEventKind::AramDmaCompletion, 100);
        assert!(deadlines.runtime_event_due_at_or_before(100));
        assert_eq!(
            deadlines.next_cycle_after(100, RuntimeDeadlinePolicy::EXACT),
            None
        );
        assert!(
            deadlines
                .deadlines_due_at_or_before(
                    100,
                    RuntimeDeadlinePolicy {
                        include_cycle_limit: true,
                        coalesce_idle_audio: false,
                    },
                )
                .all(|event| event.kind != MachineEventKind::CycleLimit)
        );
    }

    #[test]
    fn same_cycle_delivery_uses_browser_service_order() {
        let mut deadlines = MachineEventDeadlines::default();
        deadlines.set_vi_display_enabled(true);
        for kind in MachineEventKind::BROWSER_CANDIDATE_ORDER {
            deadlines.schedule(kind, 500);
        }

        let exact: Vec<_> = deadlines
            .deadlines_due_at_or_before(500, RuntimeDeadlinePolicy::EXACT)
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            exact,
            vec![
                MachineEventKind::ViComparator,
                MachineEventKind::ViTimingBoundary,
                MachineEventKind::ViScanoutBoundary,
                MachineEventKind::AiSample,
                MachineEventKind::DspAudioDmaInterrupt,
                MachineEventKind::DspAudioDmaBlock,
                MachineEventKind::AramDmaCompletion,
                MachineEventKind::DspExecution,
                MachineEventKind::SiPoll,
                MachineEventKind::SiTransferCompletion,
                MachineEventKind::PeFinish,
                MachineEventKind::ViPresentation,
                MachineEventKind::DiskAudio,
                MachineEventKind::DiskCompletion,
                MachineEventKind::Decrementer,
            ]
        );

        let projected: Vec<_> = deadlines
            .deadlines_due_at_or_before(
                500,
                RuntimeDeadlinePolicy {
                    include_cycle_limit: true,
                    coalesce_idle_audio: true,
                },
            )
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            projected,
            vec![
                MachineEventKind::ViComparator,
                MachineEventKind::ViTimingBoundary,
                MachineEventKind::ViScanoutBoundary,
                MachineEventKind::AiInterrupt,
                MachineEventKind::DspAudioDmaInterrupt,
                MachineEventKind::DspAudioDmaCompletion,
                MachineEventKind::AramDmaCompletion,
                MachineEventKind::DspExecution,
                MachineEventKind::SiPoll,
                MachineEventKind::SiTransferCompletion,
                MachineEventKind::PeFinish,
                MachineEventKind::ViPresentation,
                MachineEventKind::DiskAudio,
                MachineEventKind::DiskCompletion,
                MachineEventKind::Decrementer,
            ]
        );
        assert_eq!(
            deadlines.next_event_after(499, RuntimeDeadlinePolicy::EXACT),
            Some(MachineEvent {
                kind: MachineEventKind::ViComparator,
                cycle: 500,
            })
        );
    }

    #[test]
    fn overdue_delivery_keeps_service_phases_and_vi_chronology() {
        let mut deadlines = MachineEventDeadlines::default();
        deadlines.set_vi_display_enabled(true);
        // JS enters the VI phase before AI even though the AI timestamp is older. Within VI it
        // drains the earlier timing boundary first, then uses comparator-before-scanout on a tie.
        deadlines.schedule(MachineEventKind::AiSample, 90);
        deadlines.schedule(MachineEventKind::ViTimingBoundary, 100);
        deadlines.schedule(MachineEventKind::ViComparator, 110);
        deadlines.schedule(MachineEventKind::ViScanoutBoundary, 110);
        // Nested subsystem ordering is also phase-defined, not global timestamp order.
        deadlines.schedule(MachineEventKind::DspExecution, 80);
        deadlines.schedule(MachineEventKind::AramDmaCompletion, 95);
        deadlines.schedule(MachineEventKind::SiTransferCompletion, 75);
        deadlines.schedule(MachineEventKind::SiPoll, 105);
        deadlines.schedule(MachineEventKind::DiskCompletion, 70);
        deadlines.schedule(MachineEventKind::DiskAudio, 115);

        let due: Vec<_> = deadlines
            .deadlines_due_at_or_before(120, RuntimeDeadlinePolicy::EXACT)
            .map(|event| event.kind)
            .collect();
        assert_eq!(
            due,
            vec![
                MachineEventKind::ViTimingBoundary,
                MachineEventKind::ViComparator,
                MachineEventKind::ViScanoutBoundary,
                MachineEventKind::AiSample,
                MachineEventKind::AramDmaCompletion,
                MachineEventKind::DspExecution,
                MachineEventKind::SiPoll,
                MachineEventKind::SiTransferCompletion,
                MachineEventKind::DiskAudio,
                MachineEventKind::DiskCompletion,
            ]
        );
    }

    #[test]
    fn disabled_vi_deadlines_are_retained_but_not_selected() {
        let mut deadlines = MachineEventDeadlines::default();
        deadlines.schedule(MachineEventKind::ViComparator, 101);
        deadlines.schedule(MachineEventKind::SiPoll, 102);
        assert_eq!(
            deadlines.next_cycle_after(100, RuntimeDeadlinePolicy::EXACT),
            Some(102)
        );
        deadlines.set_vi_display_enabled(true);
        assert_eq!(
            deadlines.next_cycle_after(100, RuntimeDeadlinePolicy::EXACT),
            Some(101)
        );
    }

    #[test]
    fn randomized_selector_matches_literal_browser_candidate_oracle() {
        let mut random_state = 0x6d2b_79f5_u64;
        let mut random = || {
            random_state ^= random_state >> 12;
            random_state ^= random_state << 25;
            random_state ^= random_state >> 27;
            random_state.wrapping_mul(0x2545_f491_4f6c_dd1d)
        };

        for _ in 0..5_000 {
            let now = 1_000 + random() % 100_000;
            let mut deadlines = MachineEventDeadlines::default();
            deadlines.set_vi_display_enabled(random() & 1 != 0);
            for kind in MachineEventKind::BROWSER_CANDIDATE_ORDER {
                let cycle = match random() % 5 {
                    0 => None,
                    1 => Some(now - 1 - random() % 1_000),
                    2 => Some(now),
                    3 => Some(now + 1 + random() % 1_000),
                    _ => Some(u64::MAX),
                };
                deadlines.set(kind, cycle);
            }

            for include_cycle_limit in [false, true] {
                for coalesce_idle_audio in [false, true] {
                    let policy = RuntimeDeadlinePolicy {
                        include_cycle_limit,
                        coalesce_idle_audio,
                    };
                    assert_eq!(
                        deadlines.next_cycle_after(now, policy),
                        reference_next_cycle(&deadlines, now, policy)
                    );
                }
            }
            let observed_cycle = 1_000 + random() % 100_000;
            assert_eq!(
                deadlines.runtime_event_due_at_or_before(observed_cycle),
                reference_due(&deadlines, observed_cycle)
            );
        }
    }
}
