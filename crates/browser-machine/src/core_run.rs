//! Sealed Rust/Wasm run coordination for the resident PPC dispatcher.
//!
//! The browser-facing module is intentionally a third WebAssembly instance.  It imports the
//! shared memory, two sealed functions from the Rust browser machine, and the persistent
//! dispatcher's typed `run` export.  JavaScript may provide upper bounds and observe the final
//! [`RunOutcome`], but CPU/context/fast-memory pointers, PC layout, address-space generation, and
//! the effective budgets are loaded from a one-use plan authored by the Rust core.
//!
//! This device-free slice deliberately stops at an exact scheduler boundary. The device-service
//! layer must consume that due event before asking for another plan; repeated begins against the
//! same due deadline keep returning `EventBoundary` and never dispatch across it.

use core::mem::{offset_of, size_of};

use lazuli_abi::{ResidentBlockInstallIdentity, RunOutcome, RunReason, SharedPtr};
use ppcwasmjit::DispatchReason;
use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction, MemArg, MemoryType, Module, TypeSection, ValType,
};

pub const CORE_RUN_EXPORT: &str = "core_run";
pub const CORE_RUN_MEMORY_MODULE: &str = "lazuli";
pub const CORE_RUN_MEMORY_IMPORT: &str = "memory";
pub const CORE_RUN_CORE_MODULE: &str = "lazuli_core";
pub const CORE_RUN_DISPATCH_MODULE: &str = "lazuli_dispatch";
pub const CORE_BEGIN_SLICE_IMPORT: &str = "core_begin_slice";
pub const CORE_FINISH_SLICE_IMPORT: &str = "core_finish_slice";
pub const CORE_CURRENT_OUTCOME_IMPORT: &str = "core_current_run_outcome";
pub const CORE_DISPATCH_RUN_IMPORT: &str = "run";

/// `core_finish_slice` asks the tiny coordinator module to synchronously begin another segment.
pub const FINISH_RESUME: u32 = 1;

const RUN_PLAN_READY: u32 = 0x4c5a_5250;
const MAXIMUM_CYCLES: u64 = 8_000_000;
const MAXIMUM_BLOCKS: u32 = 131_072;

/// Private, one-use dispatcher arguments in Rust-owned linear memory.
///
/// This is deliberately not part of `lazuli-abi`: only the generated coordinator and this exact
/// browser-machine build consume it.  `record_bytes` and the ready marker make stale or mismatched
/// coordinator bytes fail closed before dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C, align(8))]
pub struct SealedRunPlan {
    ready: u32,
    record_bytes: u32,
    token: u64,
    context: u32,
    cpu: u32,
    fastmem: u32,
    pc_offset: u32,
    control: u32,
    reserved: u32,
    generation: u64,
    cycle_budget: u64,
    block_budget: u32,
    tail_reserved: u32,
}

impl Default for SealedRunPlan {
    fn default() -> Self {
        Self {
            ready: 0,
            record_bytes: size_of::<Self>() as u32,
            token: 0,
            context: 0,
            cpu: 0,
            fastmem: 0,
            pc_offset: 0,
            control: 0,
            reserved: 0,
            generation: 0,
            cycle_budget: 0,
            block_budget: 0,
            tail_reserved: 0,
        }
    }
}

impl SealedRunPlan {
    #[must_use]
    pub const fn token(&self) -> u64 {
        self.token
    }

    #[must_use]
    pub const fn cycle_budget(&self) -> u64 {
        self.cycle_budget
    }

    #[must_use]
    pub const fn block_budget(&self) -> u32 {
        self.block_budget
    }

    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub const fn context(&self) -> u32 {
        self.context
    }

    #[must_use]
    pub const fn cpu(&self) -> u32 {
        self.cpu
    }

    #[must_use]
    pub const fn fastmem(&self) -> u32 {
        self.fastmem
    }
}

const _: () = assert!(size_of::<SealedRunPlan>() == 64);

const PLAN_READY_OFFSET: u32 = offset_of!(SealedRunPlan, ready) as u32;
const PLAN_RECORD_BYTES_OFFSET: u32 = offset_of!(SealedRunPlan, record_bytes) as u32;
const PLAN_TOKEN_OFFSET: u32 = offset_of!(SealedRunPlan, token) as u32;
const PLAN_CONTEXT_OFFSET: u32 = offset_of!(SealedRunPlan, context) as u32;
const PLAN_CPU_OFFSET: u32 = offset_of!(SealedRunPlan, cpu) as u32;
const PLAN_FASTMEM_OFFSET: u32 = offset_of!(SealedRunPlan, fastmem) as u32;
const PLAN_PC_OFFSET_OFFSET: u32 = offset_of!(SealedRunPlan, pc_offset) as u32;
const PLAN_CONTROL_OFFSET: u32 = offset_of!(SealedRunPlan, control) as u32;
const PLAN_GENERATION_OFFSET: u32 = offset_of!(SealedRunPlan, generation) as u32;
const PLAN_CYCLE_BUDGET_OFFSET: u32 = offset_of!(SealedRunPlan, cycle_budget) as u32;
const PLAN_BLOCK_BUDGET_OFFSET: u32 = offset_of!(SealedRunPlan, block_budget) as u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlicePolicy {
    pub maximum_cycles: u64,
    pub maximum_blocks: u32,
}

impl Default for SlicePolicy {
    fn default() -> Self {
        Self {
            // ResidentControl publishes a u32 in-slice prefix.  A Rust-owned cap below that
            // representable limit prevents the dispatcher/hook clock from wrapping.
            maximum_cycles: MAXIMUM_CYCLES,
            maximum_blocks: MAXIMUM_BLOCKS,
        }
    }
}

impl SlicePolicy {
    #[must_use]
    pub const fn is_valid(self) -> bool {
        self.maximum_cycles != 0
            && self.maximum_cycles <= MAXIMUM_CYCLES
            && self.maximum_blocks != 0
            && self.maximum_blocks <= MAXIMUM_BLOCKS
    }
}

/// All semantic dispatcher arguments sampled from one Rust-owned BrowserMachine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SliceBindings {
    pub context: u32,
    pub cpu: u32,
    pub fastmem: u32,
    pub pc_offset: u32,
    pub control: u32,
    pub generation: u64,
    pub pc: u32,
    pub now: u64,
    pub next_deadline: Option<u64>,
    /// Exact Rust-cache identity for the currently installed block, when one exists.
    pub current_block: Option<CurrentBlockMetadata>,
}

impl SliceBindings {
    fn is_valid(self) -> bool {
        self.context != 0
            && self.cpu != 0
            && self.fastmem != 0
            && self.control != 0
            && self.generation != 0
            && self.pc.is_multiple_of(4)
            && self.pc_offset.is_multiple_of(4)
            && self
                .next_deadline
                .is_none_or(|deadline| deadline >= self.now)
            && self
                .current_block
                .is_none_or(|block| block.is_valid_for(self.generation, self.pc))
    }
}

/// Exact installed Rust cache identity sampled with one resident run plan.
///
/// The dispatcher still authenticates its separately published directory, page dependencies,
/// slot identity, and function-table occupant before execution. This private coordinator copy is
/// used only to reduce an authenticated semantic-idle plan to one block and to bind the resulting
/// stability observation back to the same installed cache entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurrentBlockMetadata {
    pub generation: u64,
    pub pc: u32,
    pub table_slot: u32,
    pub slot_nonce: u64,
    pub pattern: u32,
    pub maximum_cycles: u16,
}

impl CurrentBlockMetadata {
    #[must_use]
    const fn is_valid_for(self, generation: u64, pc: u32) -> bool {
        self.generation == generation
            && self.pc == pc
            && self.generation != 0
            && self.pc.is_multiple_of(4)
            && self.slot_nonce != 0
            && self.maximum_cycles != 0
    }

    #[must_use]
    const fn semantic_idle_identity(self) -> Option<IdleProbeIdentity> {
        if self.pattern == ppcwasmjit::Pattern::IdleBasic as u8 as u32
            || self.pattern == ppcwasmjit::Pattern::IdleVolatileRead as u8 as u32
        {
            Some(IdleProbeIdentity {
                generation: self.generation,
                pc: self.pc,
                table_slot: self.table_slot,
                slot_nonce: self.slot_nonce,
                pattern: self.pattern,
                maximum_cycles: self.maximum_cycles,
            })
        } else {
            None
        }
    }
}

/// Complete Rust-cache identity of one semantic-idle one-block observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdleProbeIdentity {
    pub generation: u64,
    pub pc: u32,
    pub table_slot: u32,
    pub slot_nonce: u64,
    pub pattern: u32,
    pub maximum_cycles: u16,
}

/// Rust-owned resolution of an authenticated one-block semantic-idle observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleResolution {
    /// The stability witness is not yet sufficient; continue the active logical slice.
    Resume,
    /// A machine deadline is already due at canonical time and must be serviced now.
    ServiceNow,
    /// Charge exactly the distance to the next Rust-selected machine deadline.
    AdvanceToEvent { cycles: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DispatchReport {
    pub instructions: u64,
    pub cycles: u64,
    pub blocks: u32,
    pub reason: DispatchReason,
}

impl DispatchReport {
    #[must_use]
    pub const fn from_raw(
        instructions: u64,
        cycles: u64,
        blocks: u32,
        reason: u32,
    ) -> Option<Self> {
        let reason = match reason {
            0 => DispatchReason::BlockBudgetExhausted,
            1 => DispatchReason::CycleBudgetExhausted,
            2 => DispatchReason::MetadataMiss,
            3 => DispatchReason::StaleGeneration,
            4 => DispatchReason::DependencyMismatch,
            5 => DispatchReason::TableSlotUnavailable,
            6 => DispatchReason::HookExit,
            7 => DispatchReason::InvalidState,
            _ => return None,
        };
        Some(Self {
            instructions,
            cycles,
            blocks,
            reason,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeginSlice {
    Dispatch,
    Outcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishSlice {
    PrepareCompile(DispatchReason),
    /// One Rust-authenticated semantic-idle block completed. BrowserMachine must re-authenticate
    /// the exact installed identity and resolve its Rust-owned stability witness before another
    /// dispatcher plan may begin.
    IdleProbe(IdleProbeIdentity),
    /// Canonical time reached/crossed a Rust scheduler boundary. Service it synchronously before
    /// the coordinator may authorize another PPC block in this logical host slice.
    ServiceEvents,
    Resume,
    Outcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunCoordinatorError {
    InvalidPolicy,
    InvalidBindings,
    Reentrant,
    NoActiveDispatch,
    StalePlan,
    InvalidAccounting,
    CounterOverflow,
    UnexpectedCompile,
    UnexpectedEventService,
    UnexpectedIdleProbe,
    IdleProbeIdentityMismatch,
    InvalidIdleAdvance,
    InstallIdentityMismatch,
}

/// Stable values carried in [`RunOutcome::detail`] for non-compile returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum RunOutcomeDetail {
    BlockBudget      = 0,
    CycleBudget      = 1,
    EventBoundary    = 2,
    HookExit         = 3,
    CompileFailed    = 4,
    CompileCancelled = 5,
    InvalidDispatcherResult = 6,
    Reentrant        = 7,
    DiscBootWait     = 8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Dispatching,
    PreparingCompile,
    AwaitingInstall,
    AwaitingIdleResolution,
    AwaitingEventService,
    ReadyAfterInstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActiveSlice {
    remaining_cycles: u64,
    remaining_blocks: u32,
    executed_instructions: u64,
    executed_cycles: u64,
    executed_blocks: u32,
}

/// Rust-owned policy and one-use authority for a logical machine slice.
pub struct CoreRunCoordinator {
    policy: SlicePolicy,
    phase: Phase,
    next_token: u64,
    active: Option<ActiveSlice>,
    plan: SealedRunPlan,
    plan_deadline_budget: Option<u64>,
    plan_deadline_cycle: Option<u64>,
    plan_deadline_strictly_limiting: bool,
    plan_forced_deadline_block: bool,
    plan_probe_without_metadata: bool,
    plan_idle_probe: Option<IdleProbeIdentity>,
    deadline_probe: Option<u64>,
    outcome: RunOutcome,
    pending_install: Option<ResidentBlockInstallIdentity>,
    pending_miss: Option<DispatchReason>,
    pending_idle_probe: Option<IdleProbeIdentity>,
}

impl Default for CoreRunCoordinator {
    fn default() -> Self {
        Self::new(SlicePolicy::default()).expect("default run policy is valid")
    }
}

impl CoreRunCoordinator {
    pub fn new(policy: SlicePolicy) -> Result<Self, RunCoordinatorError> {
        if !policy.is_valid() {
            return Err(RunCoordinatorError::InvalidPolicy);
        }
        Ok(Self {
            policy,
            phase: Phase::Idle,
            next_token: 1,
            active: None,
            plan: SealedRunPlan::default(),
            plan_deadline_budget: None,
            plan_deadline_cycle: None,
            plan_deadline_strictly_limiting: false,
            plan_forced_deadline_block: false,
            plan_probe_without_metadata: false,
            plan_idle_probe: None,
            deadline_probe: None,
            outcome: RunOutcome::new(RunReason::InvalidState),
            pending_install: None,
            pending_miss: None,
            pending_idle_probe: None,
        })
    }

    #[must_use]
    pub const fn plan(&self) -> &SealedRunPlan {
        &self.plan
    }

    #[must_use]
    pub const fn outcome(&self) -> &RunOutcome {
        &self.outcome
    }

    #[must_use]
    pub const fn is_awaiting_install(&self) -> bool {
        matches!(self.phase, Phase::AwaitingInstall)
    }

    /// True only when no logical slice, compile handoff, install, or due-event handoff remains.
    #[must_use]
    pub const fn is_quiescent(&self) -> bool {
        matches!(self.phase, Phase::Idle) && self.active.is_none()
    }

    /// Authenticates the exact in-slice cycle published by a resident semantic hook.
    ///
    /// The shared control words are meaningful only while the matching one-use plan is actively
    /// dispatching.  A hook may observe any monotonically reported instruction boundary within
    /// that sealed plan, but it cannot extend Rust's cycle authority.
    #[must_use]
    pub const fn authorizes_resident_hook_cycle(&self, cycle: u64) -> bool {
        matches!(self.phase, Phase::Dispatching)
            && self.plan.ready == RUN_PLAN_READY
            && self.plan.record_bytes == size_of::<SealedRunPlan>() as u32
            && cycle <= self.plan.cycle_budget
    }

    /// Begins or resumes one logical slice. Host values can only reduce Rust-owned limits.
    pub fn begin_slice(
        &mut self,
        bindings: SliceBindings,
        host_cycle_cap: u64,
        host_block_cap: u32,
    ) -> Result<BeginSlice, RunCoordinatorError> {
        if !bindings.is_valid() {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::InvalidBindings);
        }
        match self.phase {
            Phase::AwaitingInstall => return Ok(BeginSlice::Outcome),
            Phase::Dispatching
            | Phase::PreparingCompile
            | Phase::AwaitingIdleResolution
            | Phase::AwaitingEventService => {
                self.invalid_outcome(RunOutcomeDetail::Reentrant);
                return Err(RunCoordinatorError::Reentrant);
            }
            Phase::Idle => {
                self.active = Some(ActiveSlice {
                    remaining_cycles: host_cycle_cap.min(self.policy.maximum_cycles),
                    remaining_blocks: host_block_cap.min(self.policy.maximum_blocks),
                    executed_instructions: 0,
                    executed_cycles: 0,
                    executed_blocks: 0,
                });
            }
            Phase::ReadyAfterInstall => {
                let active = self
                    .active
                    .as_mut()
                    .ok_or(RunCoordinatorError::NoActiveDispatch)?;
                // A later host call cannot expand the outstanding Rust-issued slice.
                active.remaining_cycles = active.remaining_cycles.min(host_cycle_cap);
                active.remaining_blocks = active.remaining_blocks.min(host_block_cap);
            }
        }

        let active = self
            .active
            .as_ref()
            .ok_or(RunCoordinatorError::NoActiveDispatch)?;
        let deadline_budget = bindings
            .next_deadline
            .map_or(u64::MAX, |deadline| deadline.saturating_sub(bindings.now));
        let available_cycles = active
            .remaining_cycles
            .min(self.policy.maximum_cycles)
            .min(u64::MAX - bindings.now);
        let available_blocks = active.remaining_blocks.min(self.policy.maximum_blocks);
        let current_block_maximum_cycles = bindings.current_block.map(|block| block.maximum_cycles);
        let idle_probe = bindings
            .current_block
            .and_then(CurrentBlockMetadata::semantic_idle_identity);

        let matching_probe = self.deadline_probe.is_some()
            && self.deadline_probe == bindings.next_deadline
            && deadline_budget != 0
            && deadline_budget < available_cycles;
        if self.deadline_probe.is_some() && !matching_probe {
            self.deadline_probe = None;
        }
        let forced_deadline_block = matching_probe
            && available_blocks != 0
            && current_block_maximum_cycles.is_some_and(|maximum| {
                let maximum = u64::from(maximum);
                deadline_budget < maximum && maximum <= available_cycles
            });
        if matching_probe
            && current_block_maximum_cycles
                .is_some_and(|maximum| u64::from(maximum) > available_cycles)
        {
            // The host/policy budget cannot cover the complete declared block. Never promote a
            // device deadline into authority to violate that cap.
            self.complete_outcome(
                RunReason::BudgetExhausted,
                RunOutcomeDetail::CycleBudget as u32,
                SharedPtr::NULL,
            );
            return Ok(BeginSlice::Outcome);
        }
        if matching_probe
            && current_block_maximum_cycles
                .is_some_and(|maximum| u64::from(maximum) <= deadline_budget)
        {
            // The newly sampled current block now fits without overshoot (for example after a
            // conservative probe changed PC), so ordinary exact-deadline preflight is sufficient.
            self.deadline_probe = None;
        }
        let cycle_budget = if forced_deadline_block {
            let Some(maximum_cycles) = current_block_maximum_cycles else {
                self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                return Err(RunCoordinatorError::InvalidBindings);
            };
            u64::from(maximum_cycles)
        } else {
            available_cycles.min(deadline_budget)
        };
        let block_budget = if forced_deadline_block || idle_probe.is_some() {
            1
        } else {
            available_blocks
        };
        if cycle_budget == 0 || block_budget == 0 {
            let detail = if deadline_budget == 0 {
                RunOutcomeDetail::EventBoundary
            } else if cycle_budget == 0 {
                RunOutcomeDetail::CycleBudget
            } else {
                RunOutcomeDetail::BlockBudget
            };
            self.complete_outcome(RunReason::BudgetExhausted, detail as u32, SharedPtr::NULL);
            return Ok(BeginSlice::Outcome);
        }

        let token = self.next_token;
        self.next_token = self
            .next_token
            .checked_add(1)
            .filter(|next| *next != 0)
            .ok_or_else(|| {
                self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                RunCoordinatorError::CounterOverflow
            })?;
        self.plan = SealedRunPlan {
            ready: 0,
            record_bytes: size_of::<SealedRunPlan>() as u32,
            token,
            context: bindings.context,
            cpu: bindings.cpu,
            fastmem: bindings.fastmem,
            pc_offset: bindings.pc_offset,
            control: bindings.control,
            reserved: 0,
            generation: bindings.generation,
            cycle_budget,
            block_budget,
            tail_reserved: 0,
        };
        self.plan_deadline_budget = (deadline_budget != u64::MAX
            && (forced_deadline_block || cycle_budget == deadline_budget))
            .then_some(deadline_budget);
        self.plan_deadline_cycle = bindings.next_deadline;
        self.plan_deadline_strictly_limiting = deadline_budget < available_cycles;
        self.plan_forced_deadline_block = forced_deadline_block;
        self.plan_probe_without_metadata = matching_probe && current_block_maximum_cycles.is_none();
        self.plan_idle_probe = idle_probe;
        // The generated adapter checks both shape fields before reading semantic values.
        self.plan.ready = RUN_PLAN_READY;
        self.phase = Phase::Dispatching;
        Ok(BeginSlice::Dispatch)
    }

    pub fn finish_slice(
        &mut self,
        token: u64,
        report: DispatchReport,
    ) -> Result<FinishSlice, RunCoordinatorError> {
        if self.phase != Phase::Dispatching {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::NoActiveDispatch);
        }
        if self.plan.ready != RUN_PLAN_READY
            || self.plan.record_bytes != size_of::<SealedRunPlan>() as u32
            || token == 0
            || token != self.plan.token
        {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::StalePlan);
        }
        self.plan.ready = 0;
        let maximum_reported_per_block = u64::from(report.blocks)
            .checked_mul(u64::from(u16::MAX))
            .ok_or_else(|| {
                self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                RunCoordinatorError::CounterOverflow
            })?;
        if report.cycles > self.plan.cycle_budget
            || report.blocks > self.plan.block_budget
            || (report.blocks == 0 && (report.instructions != 0 || report.cycles != 0))
            || report.instructions > maximum_reported_per_block
            || report.cycles > maximum_reported_per_block
        {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::InvalidAccounting);
        }
        if report.reason == DispatchReason::BlockBudgetExhausted
            && report.blocks != self.plan.block_budget
        {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::InvalidAccounting);
        }
        if self.plan_idle_probe.is_some()
            && report.reason == DispatchReason::BlockBudgetExhausted
            && (report.blocks != 1 || report.instructions == 0 || report.cycles == 0)
        {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::InvalidAccounting);
        }

        let Some(active) = self.active.as_mut() else {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::NoActiveDispatch);
        };
        active.remaining_cycles -= report.cycles;
        active.remaining_blocks -= report.blocks;
        let Some(executed_instructions) = active
            .executed_instructions
            .checked_add(report.instructions)
        else {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::CounterOverflow);
        };
        let Some(executed_cycles) = active.executed_cycles.checked_add(report.cycles) else {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::CounterOverflow);
        };
        let Some(executed_blocks) = active.executed_blocks.checked_add(report.blocks) else {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::CounterOverflow);
        };
        active.executed_instructions = executed_instructions;
        active.executed_cycles = executed_cycles;
        active.executed_blocks = executed_blocks;

        let reached_deadline = self
            .plan_deadline_budget
            .is_some_and(|deadline_budget| report.cycles >= deadline_budget);
        let forced_deadline_block = self.plan_forced_deadline_block;
        let idle_probe = self.plan_idle_probe.take();

        match report.reason {
            DispatchReason::BlockBudgetExhausted => {
                if reached_deadline {
                    return Ok(self.await_event_service());
                }
                if let Some(identity) = idle_probe {
                    // The one-block cap was issued only from this exact Rust cache identity.
                    // Canonical time for the block is committed by BrowserMachine before it
                    // re-peeks the installed cache and resolves the full-CPU stability witness.
                    self.reset_plan_deadline_state();
                    self.pending_idle_probe = Some(identity);
                    self.phase = Phase::AwaitingIdleResolution;
                    return Ok(FinishSlice::IdleProbe(identity));
                }
                if forced_deadline_block {
                    // The one-block cap was internal scheduling authority, not the host's block
                    // cap. Preserve the authenticated logical slice and synchronously resample
                    // the next PC/deadline after canonical time advances by the actual cost.
                    self.reset_plan_deadline_state();
                    self.phase = Phase::ReadyAfterInstall;
                    return Ok(FinishSlice::Resume);
                }
                self.complete_outcome(
                    RunReason::BudgetExhausted,
                    RunOutcomeDetail::BlockBudget as u32,
                    SharedPtr::NULL,
                );
                Ok(FinishSlice::Outcome)
            }
            DispatchReason::CycleBudgetExhausted => {
                if forced_deadline_block {
                    // Rust's installed metadata proved the current block fit this plan. A
                    // zero-work preflight refusal therefore means shared metadata diverged from
                    // its authoritative cache identity and must fail closed, never spin.
                    self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                    return Err(RunCoordinatorError::InvalidAccounting);
                }
                if reached_deadline {
                    return Ok(self.await_event_service());
                }
                if self.plan_probe_without_metadata {
                    self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                    return Err(RunCoordinatorError::InvalidAccounting);
                }
                if self.plan_deadline_strictly_limiting {
                    // The dispatcher authentically refused a block at a short device boundary.
                    // Resample that now-current PC from Rust before granting one exact overshoot.
                    self.deadline_probe = self.plan_deadline_cycle;
                    self.reset_plan_deadline_state();
                    self.phase = Phase::ReadyAfterInstall;
                    return Ok(FinishSlice::Resume);
                }
                self.complete_outcome(
                    RunReason::BudgetExhausted,
                    RunOutcomeDetail::CycleBudget as u32,
                    SharedPtr::NULL,
                );
                Ok(FinishSlice::Outcome)
            }
            reason @ (DispatchReason::MetadataMiss
            | DispatchReason::StaleGeneration
            | DispatchReason::DependencyMismatch
            | DispatchReason::TableSlotUnavailable) => {
                self.phase = Phase::PreparingCompile;
                self.pending_miss = Some(reason);
                Ok(FinishSlice::PrepareCompile(reason))
            }
            DispatchReason::HookExit => {
                // A resident semantic hook deliberately ended this dispatcher segment so Rust
                // can resample PC, translation identity, fast-memory ownership, and deadlines.
                // Keep the authenticated logical host slice resident: `core_finish_slice`
                // commits this exact report to canonical time before the generated coordinator
                // synchronously asks Rust for a fresh one-use plan. Any resulting host request,
                // machine exit, or due-event backpressure is still selected by that begin seam.
                self.reset_plan_deadline_state();
                self.phase = Phase::ReadyAfterInstall;
                Ok(FinishSlice::Resume)
            }
            DispatchReason::InvalidState => {
                self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                Ok(FinishSlice::Outcome)
            }
        }
    }

    pub fn finish_slice_raw(
        &mut self,
        token: u64,
        instructions: u64,
        cycles: u64,
        blocks: u32,
        reason: u32,
    ) -> Result<FinishSlice, RunCoordinatorError> {
        let Some(report) = DispatchReport::from_raw(instructions, cycles, blocks, reason) else {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(RunCoordinatorError::InvalidAccounting);
        };
        self.finish_slice(token, report)
    }

    fn validate_idle_probe_identity(
        &self,
        identity: IdleProbeIdentity,
    ) -> Result<&ActiveSlice, RunCoordinatorError> {
        if self.phase != Phase::AwaitingIdleResolution {
            return Err(RunCoordinatorError::UnexpectedIdleProbe);
        }
        if self.pending_idle_probe != Some(identity) {
            return Err(RunCoordinatorError::IdleProbeIdentityMismatch);
        }
        self.active
            .as_ref()
            .ok_or(RunCoordinatorError::NoActiveDispatch)
    }

    /// Remaining Rust-owned cycle authority for this exact idle observation.
    #[must_use]
    pub fn idle_probe_remaining_cycles(&self, identity: IdleProbeIdentity) -> Option<u64> {
        self.validate_idle_probe_identity(identity)
            .ok()
            .map(|active| active.remaining_cycles)
    }

    /// Non-mutating preflight for an exact semantic jump.
    ///
    /// BrowserMachine uses this before proving that the canonical scheduler advance cannot fail;
    /// [`Self::resolve_idle_probe`] repeats the same checks immediately before charging the slice.
    pub fn validate_idle_advance(
        &self,
        identity: IdleProbeIdentity,
        cycles: u64,
    ) -> Result<(), RunCoordinatorError> {
        let active = self.validate_idle_probe_identity(identity)?;
        if cycles == 0
            || cycles > active.remaining_cycles
            || active.executed_cycles.checked_add(cycles).is_none()
        {
            return Err(RunCoordinatorError::InvalidIdleAdvance);
        }
        Ok(())
    }

    /// Resolves one exact one-block semantic-idle observation.
    ///
    /// Skipped cycles are charged to the active Rust/host cycle budget and to the final outcome;
    /// they never create instructions or retired blocks. An event resolution deliberately leaves
    /// the coordinator behind the event-service barrier so another dispatch cannot begin first.
    pub fn resolve_idle_probe(
        &mut self,
        identity: IdleProbeIdentity,
        resolution: IdleResolution,
    ) -> Result<FinishSlice, RunCoordinatorError> {
        if let Err(error) = self.validate_idle_probe_identity(identity) {
            self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
            return Err(error);
        }

        match resolution {
            IdleResolution::Resume => {
                self.pending_idle_probe = None;
                self.reset_plan_deadline_state();
                let active = self
                    .active
                    .as_ref()
                    .ok_or(RunCoordinatorError::NoActiveDispatch)?;
                if active.remaining_cycles == 0 {
                    self.complete_outcome(
                        RunReason::BudgetExhausted,
                        RunOutcomeDetail::CycleBudget as u32,
                        SharedPtr::NULL,
                    );
                    return Ok(FinishSlice::Outcome);
                }
                if active.remaining_blocks == 0 {
                    self.complete_outcome(
                        RunReason::BudgetExhausted,
                        RunOutcomeDetail::BlockBudget as u32,
                        SharedPtr::NULL,
                    );
                    return Ok(FinishSlice::Outcome);
                }
                self.phase = Phase::ReadyAfterInstall;
                Ok(FinishSlice::Resume)
            }
            IdleResolution::ServiceNow => {
                self.pending_idle_probe = None;
                Ok(self.await_event_service())
            }
            IdleResolution::AdvanceToEvent { cycles } => {
                if let Err(error) = self.validate_idle_advance(identity, cycles) {
                    self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                    return Err(error);
                }
                let Some(executed_cycles) = self
                    .active
                    .as_ref()
                    .and_then(|active| active.executed_cycles.checked_add(cycles))
                else {
                    self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                    return Err(RunCoordinatorError::CounterOverflow);
                };
                let Some(active) = self.active.as_mut() else {
                    self.invalid_outcome(RunOutcomeDetail::InvalidDispatcherResult);
                    return Err(RunCoordinatorError::NoActiveDispatch);
                };
                active.remaining_cycles -= cycles;
                active.executed_cycles = executed_cycles;
                self.pending_idle_probe = None;
                Ok(self.await_event_service())
            }
        }
    }

    /// Publishes an exact compile request after Rust completed cold preparation.
    pub fn compile_required(
        &mut self,
        identity: ResidentBlockInstallIdentity,
        request_ptr: SharedPtr,
    ) -> Result<(), RunCoordinatorError> {
        if self.phase != Phase::PreparingCompile || request_ptr.is_null() {
            return Err(RunCoordinatorError::UnexpectedCompile);
        }
        let miss = self
            .pending_miss
            .ok_or(RunCoordinatorError::UnexpectedCompile)?;
        self.pending_install = Some(identity);
        self.phase = Phase::AwaitingInstall;
        self.publish_outcome(RunReason::CompileRequired, miss as u32, request_ptr);
        Ok(())
    }

    pub fn compile_failed(&mut self, detail: u32) -> Result<(), RunCoordinatorError> {
        if self.phase != Phase::PreparingCompile {
            return Err(RunCoordinatorError::UnexpectedCompile);
        }
        self.complete_outcome(RunReason::Fault, detail, SharedPtr::NULL);
        Ok(())
    }

    /// Completes the internal scheduler seam after every event due at canonical `now` was
    /// consumed and republished by the Rust machine.
    pub fn events_serviced(&mut self) -> Result<(), RunCoordinatorError> {
        if self.phase != Phase::AwaitingEventService {
            return Err(RunCoordinatorError::UnexpectedEventService);
        }
        self.phase = Phase::ReadyAfterInstall;
        Ok(())
    }

    /// Ends the logical slice when the next due event still belongs to an unported service.
    pub fn events_deferred(&mut self) -> Result<(), RunCoordinatorError> {
        if self.phase != Phase::AwaitingEventService {
            return Err(RunCoordinatorError::UnexpectedEventService);
        }
        self.complete_outcome(
            RunReason::BudgetExhausted,
            RunOutcomeDetail::EventBoundary as u32,
            SharedPtr::NULL,
        );
        Ok(())
    }

    /// Accepts only the exact identity whose self-installer has committed in Rust.
    pub fn install_committed(
        &mut self,
        identity: ResidentBlockInstallIdentity,
    ) -> Result<(), RunCoordinatorError> {
        if self.phase != Phase::AwaitingInstall || self.pending_install != Some(identity) {
            return Err(RunCoordinatorError::InstallIdentityMismatch);
        }
        self.pending_install = None;
        self.pending_miss = None;
        // A successful install consumes the only authority carried by the prior compile request.
        // Keep the fixed outcome record readable, but never retain a pointer to a request whose
        // owner may now release or replace its backing copy.
        self.outcome.request_ptr = SharedPtr::NULL;
        self.reset_plan_deadline_state();
        self.phase = Phase::ReadyAfterInstall;
        Ok(())
    }

    /// Consumes an exact failed installation and ends its logical slice without allowing retry.
    pub fn install_cancelled(
        &mut self,
        identity: ResidentBlockInstallIdentity,
    ) -> Result<(), RunCoordinatorError> {
        if self.phase != Phase::AwaitingInstall || self.pending_install != Some(identity) {
            return Err(RunCoordinatorError::InstallIdentityMismatch);
        }
        self.pending_install = None;
        self.pending_miss = None;
        self.complete_outcome(
            RunReason::Fault,
            RunOutcomeDetail::CompileCancelled as u32,
            SharedPtr::NULL,
        );
        Ok(())
    }

    fn publish_outcome(&mut self, reason: RunReason, detail: u32, request_ptr: SharedPtr) {
        let (instructions, cycles) = self.active.map_or((0, 0), |active| {
            (active.executed_instructions, active.executed_cycles)
        });
        let mut outcome = RunOutcome::new(reason);
        outcome.detail = detail;
        outcome.executed_cycles_lo = cycles as u32;
        outcome.executed_cycles_hi = (cycles >> 32) as u32;
        outcome.executed_instructions_lo = instructions as u32;
        outcome.executed_instructions_hi = (instructions >> 32) as u32;
        outcome.request_ptr = request_ptr;
        self.outcome = outcome;
    }

    fn complete_outcome(&mut self, reason: RunReason, detail: u32, request_ptr: SharedPtr) {
        self.publish_outcome(reason, detail, request_ptr);
        self.phase = Phase::Idle;
        self.active = None;
        self.pending_install = None;
        self.pending_miss = None;
        self.pending_idle_probe = None;
        self.deadline_probe = None;
        self.reset_plan_deadline_state();
    }

    fn await_event_service(&mut self) -> FinishSlice {
        self.deadline_probe = None;
        self.reset_plan_deadline_state();
        self.phase = Phase::AwaitingEventService;
        FinishSlice::ServiceEvents
    }

    fn reset_plan_deadline_state(&mut self) {
        self.plan_deadline_budget = None;
        self.plan_deadline_cycle = None;
        self.plan_deadline_strictly_limiting = false;
        self.plan_forced_deadline_block = false;
        self.plan_probe_without_metadata = false;
        self.plan_idle_probe = None;
    }

    fn invalid_outcome(&mut self, detail: RunOutcomeDetail) {
        self.complete_outcome(RunReason::InvalidState, detail as u32, SharedPtr::NULL);
    }
}

fn memarg(offset: u32, align: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align,
        memory_index: 0,
    }
}

/// Builds the tiny third WebAssembly module that directly links core plans to dispatcher runs.
///
/// Its only browser-visible inputs are upper bounds. Every semantic argument is loaded from the
/// sealed plan before a direct Wasm-to-Wasm call; the adapter contains no imported JS policy hook.
#[must_use]
pub fn build_core_run_coordinator() -> Vec<u8> {
    let mut module = Module::new();

    let mut types = TypeSection::new();
    // 0: core_begin_slice(host cycle cap, host block cap) -> private plan pointer.
    types
        .ty()
        .function([ValType::I64, ValType::I32], [ValType::I32]);
    // 1: core_finish_slice(token, accounting...) -> outcome pointer or FINISH_RESUME.
    types.ty().function(
        [
            ValType::I64,
            ValType::I64,
            ValType::I64,
            ValType::I32,
            ValType::I32,
        ],
        [ValType::I32],
    );
    // 2: core_current_run_outcome() -> stable outcome pointer.
    types.ty().function([], [ValType::I32]);
    // 3: persistent dispatcher signature.
    types.ty().function(
        [
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I64,
            ValType::I32,
        ],
        [ValType::I64, ValType::I64, ValType::I32, ValType::I32],
    );
    module.section(&types);

    let mut imports = ImportSection::new();
    imports.import(
        CORE_RUN_MEMORY_MODULE,
        CORE_RUN_MEMORY_IMPORT,
        EntityType::Memory(MemoryType {
            minimum: lazuli_abi::memory::RESIDENT_MEMORY_INITIAL_PAGES as u64,
            maximum: Some(lazuli_abi::memory::RESIDENT_MEMORY_MAXIMUM_PAGES as u64),
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );
    imports.import(
        CORE_RUN_CORE_MODULE,
        CORE_BEGIN_SLICE_IMPORT,
        EntityType::Function(0),
    );
    imports.import(
        CORE_RUN_CORE_MODULE,
        CORE_FINISH_SLICE_IMPORT,
        EntityType::Function(1),
    );
    imports.import(
        CORE_RUN_CORE_MODULE,
        CORE_CURRENT_OUTCOME_IMPORT,
        EntityType::Function(2),
    );
    imports.import(
        CORE_RUN_DISPATCH_MODULE,
        CORE_DISPATCH_RUN_IMPORT,
        EntityType::Function(3),
    );
    module.section(&imports);

    let mut functions = FunctionSection::new();
    functions.function(0);
    module.section(&functions);

    let mut exports = ExportSection::new();
    // Four imported functions precede the sole defined function. Memory imports do not occupy
    // function indices.
    exports.export(CORE_RUN_EXPORT, ExportKind::Func, 4);
    module.section(&exports);

    // Params 0/1; locals: plan, token, instructions, cycles, blocks, reason, finish.
    const PLAN: u32 = 2;
    const TOKEN: u32 = 3;
    const INSTRUCTIONS: u32 = 4;
    const CYCLES: u32 = 5;
    const BLOCKS: u32 = 6;
    const REASON: u32 = 7;
    const FINISH: u32 = 8;
    let mut run = Function::new([(1, ValType::I32), (3, ValType::I64), (3, ValType::I32)]);
    run.instruction(&Instruction::Loop(BlockType::Empty));
    run.instruction(&Instruction::LocalGet(0));
    run.instruction(&Instruction::LocalGet(1));
    run.instruction(&Instruction::Call(0));
    run.instruction(&Instruction::LocalTee(PLAN));
    run.instruction(&Instruction::I32Eqz);
    run.instruction(&Instruction::If(BlockType::Empty));
    run.instruction(&Instruction::Call(2));
    run.instruction(&Instruction::Return);
    run.instruction(&Instruction::End);

    // Authenticate the private record shape before reading any dispatcher argument.
    run.instruction(&Instruction::LocalGet(PLAN));
    run.instruction(&Instruction::I32Load(memarg(PLAN_READY_OFFSET, 2)));
    run.instruction(&Instruction::I32Const(RUN_PLAN_READY as i32));
    run.instruction(&Instruction::I32Ne);
    run.instruction(&Instruction::If(BlockType::Empty));
    run.instruction(&Instruction::Call(2));
    run.instruction(&Instruction::Return);
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::LocalGet(PLAN));
    run.instruction(&Instruction::I32Load(memarg(PLAN_RECORD_BYTES_OFFSET, 2)));
    run.instruction(&Instruction::I32Const(size_of::<SealedRunPlan>() as i32));
    run.instruction(&Instruction::I32Ne);
    run.instruction(&Instruction::If(BlockType::Empty));
    run.instruction(&Instruction::Call(2));
    run.instruction(&Instruction::Return);
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(PLAN));
    run.instruction(&Instruction::I64Load(memarg(PLAN_TOKEN_OFFSET, 3)));
    run.instruction(&Instruction::LocalSet(TOKEN));
    for offset in [
        PLAN_CONTEXT_OFFSET,
        PLAN_CPU_OFFSET,
        PLAN_FASTMEM_OFFSET,
        PLAN_PC_OFFSET_OFFSET,
        PLAN_CONTROL_OFFSET,
    ] {
        run.instruction(&Instruction::LocalGet(PLAN));
        run.instruction(&Instruction::I32Load(memarg(offset, 2)));
    }
    run.instruction(&Instruction::LocalGet(PLAN));
    run.instruction(&Instruction::I32Load(memarg(PLAN_GENERATION_OFFSET, 2)));
    run.instruction(&Instruction::LocalGet(PLAN));
    run.instruction(&Instruction::I32Load(memarg(PLAN_GENERATION_OFFSET + 4, 2)));
    run.instruction(&Instruction::LocalGet(PLAN));
    run.instruction(&Instruction::I64Load(memarg(PLAN_CYCLE_BUDGET_OFFSET, 3)));
    run.instruction(&Instruction::LocalGet(PLAN));
    run.instruction(&Instruction::I32Load(memarg(PLAN_BLOCK_BUDGET_OFFSET, 2)));
    run.instruction(&Instruction::Call(3));
    // Multi-value results are assigned in reverse stack order.
    run.instruction(&Instruction::LocalSet(REASON));
    run.instruction(&Instruction::LocalSet(BLOCKS));
    run.instruction(&Instruction::LocalSet(CYCLES));
    run.instruction(&Instruction::LocalSet(INSTRUCTIONS));

    run.instruction(&Instruction::LocalGet(TOKEN));
    run.instruction(&Instruction::LocalGet(INSTRUCTIONS));
    run.instruction(&Instruction::LocalGet(CYCLES));
    run.instruction(&Instruction::LocalGet(BLOCKS));
    run.instruction(&Instruction::LocalGet(REASON));
    run.instruction(&Instruction::Call(1));
    run.instruction(&Instruction::LocalTee(FINISH));
    run.instruction(&Instruction::I32Const(FINISH_RESUME as i32));
    run.instruction(&Instruction::I32Eq);
    run.instruction(&Instruction::BrIf(0));
    run.instruction(&Instruction::LocalGet(FINISH));
    run.instruction(&Instruction::Return);
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::Unreachable);
    run.instruction(&Instruction::End);

    let mut code = CodeSection::new();
    code.function(&run);
    module.section(&code);
    module.finish()
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use lazuli_abi::{RecordHeader, RunReason};
    use wasm_encoder::{ConstExpr, DataSection};
    use wasmparser::{Parser, Payload, TypeRef, Validator};

    use super::*;

    fn bindings(deadline: Option<u64>) -> SliceBindings {
        SliceBindings {
            context: 0x1000,
            cpu: 0x2000,
            fastmem: 0x3000,
            pc_offset: 0x40,
            control: 0x1000,
            generation: 9,
            pc: 0x8000_1000,
            now: 100,
            next_deadline: deadline,
            current_block: None,
        }
    }

    fn current_block(pattern: ppcwasmjit::Pattern, maximum_cycles: u16) -> CurrentBlockMetadata {
        CurrentBlockMetadata {
            generation: 9,
            pc: 0x8000_1000,
            table_slot: 7,
            slot_nonce: 11,
            pattern: pattern as u8 as u32,
            maximum_cycles,
        }
    }

    fn identity(request_id: u32) -> ResidentBlockInstallIdentity {
        ResidentBlockInstallIdentity {
            request_id,
            table_slot: 7,
            slot_nonce_lo: 11,
            slot_nonce_hi: 0,
            address_space_generation_lo: 9,
            address_space_generation_hi: 0,
            install_token_lo: 13,
            install_token_hi: 0,
        }
    }

    #[test]
    fn default_policy_uses_the_release_batch_ceiling() {
        assert_eq!(
            SlicePolicy::default(),
            SlicePolicy {
                maximum_cycles: 8_000_000,
                maximum_blocks: 131_072,
            }
        );
    }

    #[test]
    fn policy_rejects_values_above_the_release_batch_ceiling() {
        assert_eq!(
            CoreRunCoordinator::new(SlicePolicy {
                maximum_cycles: 8_000_001,
                maximum_blocks: 131_072,
            })
            .err(),
            Some(RunCoordinatorError::InvalidPolicy)
        );
        assert_eq!(
            CoreRunCoordinator::new(SlicePolicy {
                maximum_cycles: 8_000_000,
                maximum_blocks: 131_073,
            })
            .err(),
            Some(RunCoordinatorError::InvalidPolicy)
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn linked_core_fixture() -> Vec<u8> {
        const PLAN_ADDRESS: u32 = 0x1000;
        const OUTCOME_ADDRESS: u32 = 0x2000;
        const BEGIN_LOG: u32 = 0x3000;
        const FINISH_LOG: u32 = 0x3020;

        let mut plan = vec![0; size_of::<SealedRunPlan>()];
        let put32 = |bytes: &mut [u8], offset: u32, value: u32| {
            bytes[offset as usize..offset as usize + 4].copy_from_slice(&value.to_le_bytes());
        };
        let put64 = |bytes: &mut [u8], offset: u32, value: u64| {
            bytes[offset as usize..offset as usize + 8].copy_from_slice(&value.to_le_bytes());
        };
        put32(&mut plan, PLAN_READY_OFFSET, RUN_PLAN_READY);
        put32(
            &mut plan,
            PLAN_RECORD_BYTES_OFFSET,
            size_of::<SealedRunPlan>() as u32,
        );
        put64(&mut plan, PLAN_TOKEN_OFFSET, 0x1122_3344_5566_7788);
        put32(&mut plan, PLAN_CONTEXT_OFFSET, 0x1111);
        put32(&mut plan, PLAN_CPU_OFFSET, 0x2222);
        put32(&mut plan, PLAN_FASTMEM_OFFSET, 0x3333);
        put32(&mut plan, PLAN_PC_OFFSET_OFFSET, 0x44);
        put32(&mut plan, PLAN_CONTROL_OFFSET, 0x5555);
        put64(&mut plan, PLAN_GENERATION_OFFSET, 0xaabb_ccdd_0102_0304);
        put64(&mut plan, PLAN_CYCLE_BUDGET_OFFSET, 40);
        put32(&mut plan, PLAN_BLOCK_BUDGET_OFFSET, 4);

        let mut types = TypeSection::new();
        types
            .ty()
            .function([ValType::I64, ValType::I32], [ValType::I32]);
        types.ty().function(
            [
                ValType::I64,
                ValType::I64,
                ValType::I64,
                ValType::I32,
                ValType::I32,
            ],
            [ValType::I32],
        );
        types.ty().function([], [ValType::I32]);
        let mut imports = ImportSection::new();
        imports.import(
            CORE_RUN_MEMORY_MODULE,
            CORE_RUN_MEMORY_IMPORT,
            EntityType::Memory(MemoryType {
                minimum: lazuli_abi::memory::RESIDENT_MEMORY_INITIAL_PAGES as u64,
                maximum: Some(lazuli_abi::memory::RESIDENT_MEMORY_MAXIMUM_PAGES as u64),
                memory64: false,
                shared: false,
                page_size_log2: None,
            }),
        );
        let mut functions = FunctionSection::new();
        functions.function(0);
        functions.function(1);
        functions.function(2);
        let mut exports = ExportSection::new();
        exports.export(CORE_BEGIN_SLICE_IMPORT, ExportKind::Func, 0);
        exports.export(CORE_FINISH_SLICE_IMPORT, ExportKind::Func, 1);
        exports.export(CORE_CURRENT_OUTCOME_IMPORT, ExportKind::Func, 2);

        let mut begin = Function::new([]);
        begin.instruction(&Instruction::I32Const(BEGIN_LOG as i32));
        begin.instruction(&Instruction::LocalGet(0));
        begin.instruction(&Instruction::I64Store(memarg(0, 3)));
        begin.instruction(&Instruction::I32Const(BEGIN_LOG as i32));
        begin.instruction(&Instruction::LocalGet(1));
        begin.instruction(&Instruction::I32Store(memarg(8, 2)));
        begin.instruction(&Instruction::I32Const(PLAN_ADDRESS as i32));
        begin.instruction(&Instruction::End);

        let mut finish = Function::new([]);
        for (local, offset, is_i64) in [
            (0, 0, true),
            (1, 8, true),
            (2, 16, true),
            (3, 24, false),
            (4, 28, false),
        ] {
            finish.instruction(&Instruction::I32Const(FINISH_LOG as i32));
            finish.instruction(&Instruction::LocalGet(local));
            if is_i64 {
                finish.instruction(&Instruction::I64Store(memarg(offset, 3)));
            } else {
                finish.instruction(&Instruction::I32Store(memarg(offset, 2)));
            }
        }
        finish.instruction(&Instruction::I32Const(OUTCOME_ADDRESS as i32));
        finish.instruction(&Instruction::End);

        let mut current = Function::new([]);
        current.instruction(&Instruction::I32Const(OUTCOME_ADDRESS as i32));
        current.instruction(&Instruction::End);
        let mut code = CodeSection::new();
        code.function(&begin);
        code.function(&finish);
        code.function(&current);
        let mut data = DataSection::new();
        data.active(0, &ConstExpr::i32_const(PLAN_ADDRESS as i32), plan);
        let mut module = Module::new();
        module.section(&types);
        module.section(&imports);
        module.section(&functions);
        module.section(&exports);
        module.section(&code);
        module.section(&data);
        module.finish()
    }

    fn linked_dispatch_fixture() -> Vec<u8> {
        const DISPATCH_LOG: u32 = 0x4000;
        let mut types = TypeSection::new();
        types.ty().function(
            [
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I64,
                ValType::I32,
            ],
            [ValType::I64, ValType::I64, ValType::I32, ValType::I32],
        );
        let mut imports = ImportSection::new();
        imports.import(
            CORE_RUN_MEMORY_MODULE,
            CORE_RUN_MEMORY_IMPORT,
            EntityType::Memory(MemoryType {
                minimum: lazuli_abi::memory::RESIDENT_MEMORY_INITIAL_PAGES as u64,
                maximum: Some(lazuli_abi::memory::RESIDENT_MEMORY_MAXIMUM_PAGES as u64),
                memory64: false,
                shared: false,
                page_size_log2: None,
            }),
        );
        let mut functions = FunctionSection::new();
        functions.function(0);
        let mut exports = ExportSection::new();
        exports.export(CORE_DISPATCH_RUN_IMPORT, ExportKind::Func, 0);
        let mut run = Function::new([]);
        for (local, offset, is_i64) in [
            (0, 0, false),
            (1, 4, false),
            (2, 8, false),
            (3, 12, false),
            (4, 16, false),
            (5, 20, false),
            (6, 24, false),
            (7, 32, true),
            (8, 40, false),
        ] {
            run.instruction(&Instruction::I32Const(DISPATCH_LOG as i32));
            run.instruction(&Instruction::LocalGet(local));
            if is_i64 {
                run.instruction(&Instruction::I64Store(memarg(offset, 3)));
            } else {
                run.instruction(&Instruction::I32Store(memarg(offset, 2)));
            }
        }
        run.instruction(&Instruction::I64Const(7));
        run.instruction(&Instruction::I64Const(11));
        run.instruction(&Instruction::I32Const(3));
        run.instruction(&Instruction::I32Const(DispatchReason::MetadataMiss as i32));
        run.instruction(&Instruction::End);
        let mut code = CodeSection::new();
        code.function(&run);
        let mut module = Module::new();
        module.section(&types);
        module.section(&imports);
        module.section(&functions);
        module.section(&exports);
        module.section(&code);
        module.finish()
    }

    #[test]
    fn rust_plan_owns_semantic_arguments_and_clamps_both_caps_to_deadline() {
        let mut coordinator = CoreRunCoordinator::new(SlicePolicy {
            maximum_cycles: 1_000,
            maximum_blocks: 100,
        })
        .unwrap();
        assert_eq!(
            coordinator.begin_slice(bindings(Some(140)), 9_999, 999),
            Ok(BeginSlice::Dispatch)
        );
        let plan = coordinator.plan();
        assert_eq!(plan.context(), 0x1000);
        assert_eq!(plan.cpu(), 0x2000);
        assert_eq!(plan.fastmem(), 0x3000);
        assert_eq!(plan.generation(), 9);
        assert_eq!(plan.cycle_budget(), 40);
        assert_eq!(plan.block_budget(), 100);
        assert_ne!(plan.token(), 0);
    }

    #[test]
    fn semantic_idle_metadata_reduces_only_the_internal_plan_to_one_block() {
        for pattern in [
            ppcwasmjit::Pattern::IdleBasic,
            ppcwasmjit::Pattern::IdleVolatileRead,
        ] {
            let mut coordinator = CoreRunCoordinator::default();
            let mut start = bindings(None);
            start.current_block = Some(current_block(pattern, 9));

            assert_eq!(
                coordinator.begin_slice(start, 100, 7),
                Ok(BeginSlice::Dispatch)
            );
            assert_eq!(coordinator.plan().cycle_budget(), 100);
            assert_eq!(coordinator.plan().block_budget(), 1);
            let identity = start
                .current_block
                .and_then(CurrentBlockMetadata::semantic_idle_identity)
                .unwrap();
            assert_eq!(
                coordinator
                    .finish_slice(
                        coordinator.plan().token(),
                        DispatchReport {
                            instructions: 3,
                            cycles: 5,
                            blocks: 1,
                            reason: DispatchReason::BlockBudgetExhausted,
                        },
                    )
                    .unwrap(),
                FinishSlice::IdleProbe(identity)
            );
            assert_eq!(coordinator.idle_probe_remaining_cycles(identity), Some(95));
            assert_eq!(
                coordinator
                    .resolve_idle_probe(identity, IdleResolution::Resume)
                    .unwrap(),
                FinishSlice::Resume
            );
            assert_eq!(
                coordinator.begin_slice(start, u64::MAX, u32::MAX),
                Ok(BeginSlice::Dispatch)
            );
            assert_eq!(coordinator.plan().cycle_budget(), 95);
            assert_eq!(coordinator.plan().block_budget(), 1);
            assert_eq!(coordinator.active.unwrap().remaining_blocks, 6);
        }

        let mut ordinary = CoreRunCoordinator::default();
        let mut start = bindings(None);
        start.current_block = Some(current_block(ppcwasmjit::Pattern::None, 9));
        ordinary.begin_slice(start, 100, 7).unwrap();
        assert_eq!(ordinary.plan().block_budget(), 7);
    }

    #[test]
    fn exact_idle_advance_charges_cycles_without_inventing_instructions_or_blocks() {
        let mut coordinator = CoreRunCoordinator::default();
        let mut start = bindings(None);
        start.current_block = Some(current_block(ppcwasmjit::Pattern::IdleVolatileRead, 8));
        coordinator.begin_slice(start, 50, 5).unwrap();
        let identity = start
            .current_block
            .and_then(CurrentBlockMetadata::semantic_idle_identity)
            .unwrap();
        assert_eq!(
            coordinator
                .finish_slice(
                    coordinator.plan().token(),
                    DispatchReport {
                        instructions: 3,
                        cycles: 2,
                        blocks: 1,
                        reason: DispatchReason::BlockBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::IdleProbe(identity)
        );
        assert_eq!(coordinator.validate_idle_advance(identity, 48), Ok(()));
        assert_eq!(
            coordinator
                .resolve_idle_probe(identity, IdleResolution::AdvanceToEvent { cycles: 48 })
                .unwrap(),
            FinishSlice::ServiceEvents
        );
        assert_eq!(
            coordinator.begin_slice(start, 50, 5),
            Err(RunCoordinatorError::Reentrant)
        );

        // Use a fresh copy for the terminal accounting check because the intentional reentrant
        // call above correctly poisoned its coordinator.
        let mut coordinator = CoreRunCoordinator::default();
        coordinator.begin_slice(start, 50, 5).unwrap();
        coordinator
            .finish_slice(
                coordinator.plan().token(),
                DispatchReport {
                    instructions: 3,
                    cycles: 2,
                    blocks: 1,
                    reason: DispatchReason::BlockBudgetExhausted,
                },
            )
            .unwrap();
        coordinator
            .resolve_idle_probe(identity, IdleResolution::AdvanceToEvent { cycles: 48 })
            .unwrap();
        assert_eq!(
            coordinator.active,
            Some(ActiveSlice {
                remaining_cycles: 0,
                remaining_blocks: 4,
                executed_instructions: 3,
                executed_cycles: 50,
                executed_blocks: 1,
            })
        );
        coordinator.events_serviced().unwrap();
        assert_eq!(
            coordinator.begin_slice(start, 50, 5),
            Ok(BeginSlice::Outcome)
        );
        assert_eq!(coordinator.outcome().executed_cycles(), 50);
        assert_eq!(coordinator.outcome().executed_instructions(), 3);
        assert_eq!(
            coordinator.outcome().detail,
            RunOutcomeDetail::CycleBudget as u32
        );
    }

    #[test]
    fn idle_resolution_requires_exact_identity_and_bounded_nonzero_delta() {
        fn awaiting_idle() -> (CoreRunCoordinator, IdleProbeIdentity) {
            let mut coordinator = CoreRunCoordinator::default();
            let mut start = bindings(None);
            start.current_block = Some(current_block(ppcwasmjit::Pattern::IdleVolatileRead, 8));
            coordinator.begin_slice(start, 20, 5).unwrap();
            let identity = start
                .current_block
                .and_then(CurrentBlockMetadata::semantic_idle_identity)
                .unwrap();
            coordinator
                .finish_slice(
                    coordinator.plan().token(),
                    DispatchReport {
                        instructions: 3,
                        cycles: 2,
                        blocks: 1,
                        reason: DispatchReason::BlockBudgetExhausted,
                    },
                )
                .unwrap();
            (coordinator, identity)
        }

        let (_, identity) = awaiting_idle();
        for changed in [
            IdleProbeIdentity {
                generation: identity.generation + 1,
                ..identity
            },
            IdleProbeIdentity {
                pc: identity.pc + 4,
                ..identity
            },
            IdleProbeIdentity {
                table_slot: identity.table_slot + 1,
                ..identity
            },
            IdleProbeIdentity {
                slot_nonce: identity.slot_nonce + 1,
                ..identity
            },
            IdleProbeIdentity {
                pattern: ppcwasmjit::Pattern::IdleBasic as u8 as u32,
                ..identity
            },
            IdleProbeIdentity {
                maximum_cycles: identity.maximum_cycles + 1,
                ..identity
            },
        ] {
            let (mut stale, _) = awaiting_idle();
            assert_eq!(
                stale.resolve_idle_probe(changed, IdleResolution::Resume),
                Err(RunCoordinatorError::IdleProbeIdentityMismatch)
            );
            assert_eq!(stale.outcome().reason(), Ok(RunReason::InvalidState));
        }

        for cycles in [0, 19] {
            let (mut invalid, identity) = awaiting_idle();
            assert_eq!(
                invalid.resolve_idle_probe(identity, IdleResolution::AdvanceToEvent { cycles }),
                Err(RunCoordinatorError::InvalidIdleAdvance)
            );
            assert_eq!(invalid.outcome().reason(), Ok(RunReason::InvalidState));
        }
    }

    #[test]
    fn exact_deadline_requires_internal_service_before_another_plan() {
        let mut coordinator = CoreRunCoordinator::default();
        coordinator
            .begin_slice(bindings(Some(140)), 1_000, 100)
            .unwrap();
        let token = coordinator.plan().token();
        assert_eq!(coordinator.plan().cycle_budget(), 40);
        assert_eq!(
            coordinator
                .finish_slice(
                    token,
                    DispatchReport {
                        instructions: 12,
                        cycles: 40,
                        blocks: 4,
                        reason: DispatchReason::CycleBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::ServiceEvents
        );
        coordinator.events_serviced().unwrap();

        let mut after = bindings(Some(180));
        after.now = 140;
        assert_eq!(
            coordinator.begin_slice(after, 1_000, 100),
            Ok(BeginSlice::Dispatch)
        );

        let mut due_coordinator = CoreRunCoordinator::default();
        let mut due = bindings(Some(140));
        due.now = 140;
        due.current_block = Some(current_block(ppcwasmjit::Pattern::None, 80));
        assert_eq!(
            due_coordinator.begin_slice(due, 1_000, 100),
            Ok(BeginSlice::Outcome)
        );
        assert_eq!(
            due_coordinator.outcome().detail,
            RunOutcomeDetail::EventBoundary as u32
        );
        assert_eq!(due_coordinator.plan().ready, 0);
    }

    #[test]
    fn hook_exit_retains_exact_slice_and_resamples_all_dispatch_bindings() {
        let mut coordinator = CoreRunCoordinator::new(SlicePolicy {
            maximum_cycles: 1_000,
            maximum_blocks: 100,
        })
        .unwrap();
        let start = bindings(None);
        assert_eq!(
            coordinator.begin_slice(start, 100, 10),
            Ok(BeginSlice::Dispatch)
        );
        let first_token = coordinator.plan().token();

        assert_eq!(
            coordinator
                .finish_slice(
                    first_token,
                    DispatchReport {
                        instructions: 7,
                        cycles: 11,
                        blocks: 2,
                        reason: DispatchReason::HookExit,
                    },
                )
                .unwrap(),
            FinishSlice::Resume
        );
        assert!(!coordinator.is_quiescent());
        assert!(!coordinator.authorizes_resident_hook_cycle(0));
        assert_eq!(coordinator.plan.ready, 0);
        assert_eq!(
            coordinator.active,
            Some(ActiveSlice {
                remaining_cycles: 89,
                remaining_blocks: 8,
                executed_instructions: 7,
                executed_cycles: 11,
                executed_blocks: 2,
            })
        );

        let mut changed = start;
        changed.context = 0x1100;
        changed.cpu = 0x2200;
        changed.fastmem = 0x3300;
        changed.control = 0x4400;
        changed.pc_offset = 0x48;
        changed.generation = 10;
        changed.now = 111;
        assert_eq!(
            coordinator.begin_slice(changed, u64::MAX, u32::MAX),
            Ok(BeginSlice::Dispatch)
        );
        let resumed = coordinator.plan();
        assert_ne!(resumed.token(), first_token);
        assert_eq!(resumed.context(), changed.context);
        assert_eq!(resumed.cpu(), changed.cpu);
        assert_eq!(resumed.fastmem(), changed.fastmem);
        assert_eq!(resumed.pc_offset, changed.pc_offset);
        assert_eq!(resumed.control, changed.control);
        assert_eq!(resumed.generation(), changed.generation);
        // A repeated outer call can reduce but never replenish the retained logical slice.
        assert_eq!(resumed.cycle_budget(), 89);
        assert_eq!(resumed.block_budget(), 8);
    }

    #[test]
    fn hook_exit_that_consumes_cycle_cap_finishes_on_internal_rebegin() {
        let mut coordinator = CoreRunCoordinator::default();
        let start = bindings(None);
        coordinator.begin_slice(start, 10, 5).unwrap();
        let token = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    token,
                    DispatchReport {
                        instructions: 3,
                        cycles: 10,
                        blocks: 1,
                        reason: DispatchReason::HookExit,
                    },
                )
                .unwrap(),
            FinishSlice::Resume
        );
        assert_eq!(
            coordinator.begin_slice(start, 100, 100),
            Ok(BeginSlice::Outcome)
        );
        assert_eq!(
            coordinator.outcome().reason(),
            Ok(RunReason::BudgetExhausted)
        );
        assert_eq!(
            coordinator.outcome().detail,
            RunOutcomeDetail::CycleBudget as u32
        );
        assert_eq!(coordinator.outcome().executed_cycles(), 10);
        assert_eq!(coordinator.outcome().executed_instructions(), 3);
        assert!(coordinator.is_quiescent());
    }

    #[test]
    fn deadline_probe_crosses_without_idle_advance_and_services_internally() {
        let mut coordinator = CoreRunCoordinator::new(SlicePolicy {
            maximum_cycles: 1_000,
            maximum_blocks: 100,
        })
        .unwrap();
        let mut start = bindings(Some(105));
        start.current_block = Some(current_block(ppcwasmjit::Pattern::None, 7));

        // The first plan remains exact. Only the dispatcher's authenticated zero-work refusal
        // arms the probe; Rust never guesses that the CPU was idle.
        assert_eq!(
            coordinator.begin_slice(start, 100, 100),
            Ok(BeginSlice::Dispatch)
        );
        assert_eq!(coordinator.plan().cycle_budget(), 5);
        let first_token = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    first_token,
                    DispatchReport {
                        instructions: 0,
                        cycles: 0,
                        blocks: 0,
                        reason: DispatchReason::CycleBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::Resume
        );

        assert_eq!(
            coordinator.begin_slice(start, 100, 100),
            Ok(BeginSlice::Dispatch)
        );
        assert_eq!(coordinator.plan().cycle_budget(), 7);
        assert_eq!(coordinator.plan().block_budget(), 1);
        let probe_token = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    probe_token,
                    DispatchReport {
                        instructions: 1,
                        cycles: 7,
                        blocks: 1,
                        reason: DispatchReason::BlockBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::ServiceEvents
        );
        coordinator.events_serviced().unwrap();

        let mut resumed = bindings(Some(873));
        resumed.now = 107;
        assert_eq!(
            coordinator.begin_slice(resumed, 100, 100),
            Ok(BeginSlice::Dispatch)
        );
        assert_eq!(coordinator.plan().cycle_budget(), 93);
        assert_eq!(coordinator.plan().block_budget(), 99);
    }

    #[test]
    fn conservative_probe_repeats_until_actual_work_crosses_deadline() {
        let mut coordinator = CoreRunCoordinator::default();
        let mut start = bindings(Some(105));
        start.current_block = Some(current_block(ppcwasmjit::Pattern::None, 7));
        coordinator.begin_slice(start, 100, 10).unwrap();
        let token = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    token,
                    DispatchReport {
                        instructions: 0,
                        cycles: 0,
                        blocks: 0,
                        reason: DispatchReason::CycleBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::Resume
        );

        coordinator.begin_slice(start, 100, 10).unwrap();
        let first_probe = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    first_probe,
                    DispatchReport {
                        instructions: 1,
                        cycles: 3,
                        blocks: 1,
                        reason: DispatchReason::BlockBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::Resume
        );

        let mut second = start;
        second.now = 103;
        coordinator.begin_slice(second, 100, 10).unwrap();
        assert_eq!(coordinator.plan().cycle_budget(), 7);
        let second_probe = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    second_probe,
                    DispatchReport {
                        instructions: 1,
                        cycles: 3,
                        blocks: 1,
                        reason: DispatchReason::BlockBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::ServiceEvents
        );
        assert_eq!(coordinator.active.unwrap().executed_cycles, 6);
    }

    #[test]
    fn deadline_never_authorizes_past_host_or_block_caps() {
        for host_cycles in [4, 5] {
            let mut coordinator = CoreRunCoordinator::default();
            let mut start = bindings(Some(105));
            start.current_block = Some(current_block(ppcwasmjit::Pattern::None, 7));
            coordinator.begin_slice(start, host_cycles, 10).unwrap();
            assert_eq!(coordinator.plan().cycle_budget(), host_cycles);
            let token = coordinator.plan().token();
            assert_eq!(
                coordinator
                    .finish_slice(
                        token,
                        DispatchReport {
                            instructions: 0,
                            cycles: 0,
                            blocks: 0,
                            reason: DispatchReason::CycleBudgetExhausted,
                        },
                    )
                    .unwrap(),
                FinishSlice::Outcome
            );
            assert_eq!(
                coordinator.outcome().detail,
                RunOutcomeDetail::CycleBudget as u32
            );
        }

        let mut no_blocks = CoreRunCoordinator::default();
        let mut start = bindings(Some(105));
        start.current_block = Some(current_block(ppcwasmjit::Pattern::None, 7));
        assert_eq!(
            no_blocks.begin_slice(start, 100, 0),
            Ok(BeginSlice::Outcome)
        );
        assert_eq!(
            no_blocks.outcome().detail,
            RunOutcomeDetail::BlockBudget as u32
        );

        let mut clock_end = CoreRunCoordinator::default();
        let mut ending = bindings(None);
        ending.now = u64::MAX - 3;
        clock_end.begin_slice(ending, 100, 10).unwrap();
        assert_eq!(clock_end.plan().cycle_budget(), 3);
    }

    #[test]
    fn cold_miss_retains_an_armed_deadline_probe_through_exact_install() {
        let mut coordinator = CoreRunCoordinator::default();
        let mut start = bindings(Some(105));
        start.current_block = Some(current_block(ppcwasmjit::Pattern::None, 7));
        coordinator.begin_slice(start, 100, 10).unwrap();
        let token = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    token,
                    DispatchReport {
                        instructions: 0,
                        cycles: 0,
                        blocks: 0,
                        reason: DispatchReason::CycleBudgetExhausted,
                    },
                )
                .unwrap(),
            FinishSlice::Resume
        );

        let mut missing = start;
        missing.current_block = None;
        coordinator.begin_slice(missing, 100, 10).unwrap();
        let missing_token = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    missing_token,
                    DispatchReport {
                        instructions: 0,
                        cycles: 0,
                        blocks: 0,
                        reason: DispatchReason::MetadataMiss,
                    },
                )
                .unwrap(),
            FinishSlice::PrepareCompile(DispatchReason::MetadataMiss)
        );
        coordinator
            .compile_required(identity(1), SharedPtr(0x4000))
            .unwrap();
        coordinator.install_committed(identity(1)).unwrap();

        coordinator.begin_slice(start, 100, 10).unwrap();
        assert_eq!(coordinator.plan().cycle_budget(), 7);
        assert_eq!(coordinator.plan().block_budget(), 1);
    }

    #[test]
    fn stale_plan_and_over_budget_accounting_fail_closed() {
        let mut stale = CoreRunCoordinator::default();
        stale.begin_slice(bindings(None), 100, 10).unwrap();
        let token = stale.plan().token();
        assert_eq!(
            stale.finish_slice(
                token + 1,
                DispatchReport {
                    instructions: 0,
                    cycles: 0,
                    blocks: 0,
                    reason: DispatchReason::MetadataMiss,
                }
            ),
            Err(RunCoordinatorError::StalePlan)
        );
        assert_eq!(stale.outcome().reason(), Ok(RunReason::InvalidState));

        let mut over = CoreRunCoordinator::default();
        over.begin_slice(bindings(None), 10, 2).unwrap();
        let token = over.plan().token();
        assert_eq!(
            over.finish_slice(
                token,
                DispatchReport {
                    instructions: 3,
                    cycles: 11,
                    blocks: 1,
                    reason: DispatchReason::CycleBudgetExhausted,
                }
            ),
            Err(RunCoordinatorError::InvalidAccounting)
        );
        assert_eq!(over.outcome().reason(), Ok(RunReason::InvalidState));
    }

    #[test]
    fn cold_miss_retains_slice_and_only_exact_install_resumes() {
        let mut coordinator = CoreRunCoordinator::default();
        coordinator.begin_slice(bindings(None), 100, 10).unwrap();
        let token = coordinator.plan().token();
        assert_eq!(
            coordinator
                .finish_slice(
                    token,
                    DispatchReport {
                        instructions: 6,
                        cycles: 8,
                        blocks: 2,
                        reason: DispatchReason::MetadataMiss,
                    }
                )
                .unwrap(),
            FinishSlice::PrepareCompile(DispatchReason::MetadataMiss)
        );
        coordinator
            .compile_required(identity(1), SharedPtr(0x4000))
            .unwrap();
        assert!(coordinator.is_awaiting_install());
        assert_eq!(
            coordinator.outcome().reason(),
            Ok(RunReason::CompileRequired)
        );
        assert_eq!(coordinator.outcome().executed_cycles(), 8);
        assert_eq!(coordinator.outcome().executed_instructions(), 6);
        assert_eq!(coordinator.outcome().request_ptr, SharedPtr(0x4000));
        assert_eq!(
            coordinator.install_committed(identity(2)),
            Err(RunCoordinatorError::InstallIdentityMismatch)
        );
        coordinator.install_committed(identity(1)).unwrap();
        assert!(coordinator.outcome().request_ptr.is_null());

        coordinator
            .begin_slice(bindings(None), u64::MAX, u32::MAX)
            .unwrap();
        assert_eq!(coordinator.plan().cycle_budget(), 92);
        assert_eq!(coordinator.plan().block_budget(), 8);
        let resumed_token = coordinator.plan().token();
        assert_ne!(resumed_token, token);
        coordinator
            .finish_slice(
                resumed_token,
                DispatchReport {
                    instructions: 9,
                    cycles: 12,
                    blocks: 8,
                    reason: DispatchReason::BlockBudgetExhausted,
                },
            )
            .unwrap();
        assert_eq!(
            coordinator.outcome().reason(),
            Ok(RunReason::BudgetExhausted)
        );
        assert_eq!(coordinator.outcome().executed_cycles(), 20);
        assert_eq!(coordinator.outcome().executed_instructions(), 15);
    }

    #[test]
    fn exact_cancel_consumes_once_and_rotates_the_next_plan_token() {
        let mut coordinator = CoreRunCoordinator::default();
        coordinator.begin_slice(bindings(None), 100, 10).unwrap();
        let first_token = coordinator.plan().token();
        coordinator
            .finish_slice(
                first_token,
                DispatchReport {
                    instructions: 0,
                    cycles: 0,
                    blocks: 0,
                    reason: DispatchReason::TableSlotUnavailable,
                },
            )
            .unwrap();
        coordinator
            .compile_required(identity(5), SharedPtr(0x5000))
            .unwrap();
        assert_eq!(
            coordinator.install_cancelled(identity(6)),
            Err(RunCoordinatorError::InstallIdentityMismatch)
        );
        coordinator.install_cancelled(identity(5)).unwrap();
        assert_eq!(coordinator.outcome().reason(), Ok(RunReason::Fault));
        assert_eq!(
            coordinator.outcome().detail,
            RunOutcomeDetail::CompileCancelled as u32
        );
        assert_eq!(
            coordinator.install_cancelled(identity(5)),
            Err(RunCoordinatorError::InstallIdentityMismatch)
        );
        coordinator.begin_slice(bindings(None), 100, 10).unwrap();
        assert!(coordinator.plan().token() > first_token);
    }

    #[test]
    fn coordinator_wasm_has_only_direct_linkage_and_upper_bound_public_inputs() {
        let bytes = build_core_run_coordinator();
        Validator::new().validate_all(&bytes).unwrap();
        let mut imports = Vec::new();
        let mut run_export = None;
        for payload in Parser::new(0).parse_all(&bytes) {
            match payload.unwrap() {
                Payload::ImportSection(section) => {
                    for import in section.into_imports() {
                        let import = import.unwrap();
                        imports.push((import.module.to_owned(), import.name.to_owned(), import.ty));
                    }
                }
                Payload::ExportSection(section) => {
                    for export in section {
                        let export = export.unwrap();
                        if export.name == CORE_RUN_EXPORT {
                            run_export = Some((export.kind, export.index));
                        }
                    }
                }
                _ => {}
            }
        }
        assert_eq!(imports.len(), 5);
        let TypeRef::Memory(memory) = imports[0].2 else {
            panic!("coordinator's first import is not resident memory");
        };
        assert_eq!(
            memory.initial,
            lazuli_abi::memory::RESIDENT_MEMORY_INITIAL_PAGES as u64
        );
        assert_eq!(
            memory.maximum,
            Some(lazuli_abi::memory::RESIDENT_MEMORY_MAXIMUM_PAGES as u64)
        );
        assert_eq!(
            imports
                .iter()
                .map(|(module, name, _)| (module.as_str(), name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (CORE_RUN_MEMORY_MODULE, CORE_RUN_MEMORY_IMPORT),
                (CORE_RUN_CORE_MODULE, CORE_BEGIN_SLICE_IMPORT),
                (CORE_RUN_CORE_MODULE, CORE_FINISH_SLICE_IMPORT),
                (CORE_RUN_CORE_MODULE, CORE_CURRENT_OUTCOME_IMPORT),
                (CORE_RUN_DISPATCH_MODULE, CORE_DISPATCH_RUN_IMPORT),
            ]
        );
        assert_eq!(run_export, Some((wasmparser::ExternalKind::Func, 4)));
        assert_eq!(size_of::<RunOutcome>(), 40);
        assert_eq!(RecordHeader::for_record::<RunOutcome>().byte_len, 40);
    }

    #[test]
    fn coordinator_runs_third_instance_with_only_direct_wasm_to_wasm_semantics() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping direct coordinator linkage test");
            return;
        }
        let core = hex(&linked_core_fixture());
        let dispatch = hex(&linked_dispatch_fixture());
        let coordinator = hex(&build_core_run_coordinator());
        let script = format!(
            "
const bytes = hex => Uint8Array.from(hex.match(/../g), value => parseInt(value, 16));
const memory = new WebAssembly.Memory({{ initial: 720, maximum: 2048 }});
const core = await WebAssembly.instantiate(bytes('{core}'), {{ lazuli: {{ memory }} }});
const dispatch = await WebAssembly.instantiate(bytes('{dispatch}'), {{ lazuli: {{ memory }} }});
const coordinator = await WebAssembly.instantiate(bytes('{coordinator}'), {{
  lazuli: {{ memory }},
  lazuli_core: core.instance.exports,
  lazuli_dispatch: dispatch.instance.exports,
}});
const outcome = coordinator.instance.exports.core_run(999n, 99);
const view = new DataView(memory.buffer);
const u32 = address => view.getUint32(address, true);
const u64 = address => view.getBigUint64(address, true);
if (outcome !== 0x2000) throw new Error(`wrong outcome ${{outcome}}`);
if (u64(0x3000) !== 999n || u32(0x3008) !== 99) throw new Error('host caps missed core');
const actual = [u32(0x4000), u32(0x4004), u32(0x4008), u32(0x400c), u32(0x4010)];
const expected = [0x1111, 0x2222, 0x3333, 0x44, 0x5555];
if (actual.some((value, index) => value !== expected[index])) throw new Error(`semantic args ${{actual}}`);
if (u32(0x4014) !== 0x01020304 || u32(0x4018) !== 0xaabbccdd) throw new Error('generation');
if (u64(0x4020) !== 40n || u32(0x4028) !== 4) throw new Error('sealed budgets');
if (u64(0x3020) !== 0x1122334455667788n) throw new Error('token');
if (u64(0x3028) !== 7n || u64(0x3030) !== 11n || u32(0x3038) !== 3 || u32(0x303c) !== 2) {{
  throw new Error('dispatcher result did not return directly to core');
}}
"
        );
        let output = Command::new("node")
            .args(["--input-type=module", "--eval", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn generated_coordinator_performs_hook_exit_redispatch_inside_one_outer_call() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping generated coordinator resume test");
            return;
        }
        let coordinator = hex(&build_core_run_coordinator());
        let script = format!(
            "
const bytes = hex => Uint8Array.from(hex.match(/../g), value => parseInt(value, 16));
const memory = new WebAssembly.Memory({{ initial: 720, maximum: 2048 }});
const view = new DataView(memory.buffer);
let begins = 0;
let finishes = 0;
let dispatches = 0;
const dispatchArguments = [];
const putPlan = (pointer, ordinal) => {{
  view.setUint32(pointer + 0, 0x4c5a5250, true);
  view.setUint32(pointer + 4, 64, true);
  view.setBigUint64(pointer + 8, 0x1000n + BigInt(ordinal), true);
  view.setUint32(pointer + 16, 0x1100 + ordinal, true);
  view.setUint32(pointer + 20, 0x2200 + ordinal, true);
  view.setUint32(pointer + 24, 0x3300 + ordinal, true);
  view.setUint32(pointer + 28, 0x40 + ordinal * 4, true);
  view.setUint32(pointer + 32, 0x4400 + ordinal, true);
  view.setBigUint64(pointer + 40, 9n + BigInt(ordinal), true);
  view.setBigUint64(pointer + 48, 100n - BigInt(ordinal * 7), true);
  view.setUint32(pointer + 56, 10 - ordinal, true);
}};
const instance = await WebAssembly.instantiate(bytes('{coordinator}'), {{
  lazuli: {{ memory }},
  lazuli_core: {{
    core_begin_slice(cycleCap, blockCap) {{
      if (cycleCap !== 100n || blockCap !== 10) throw new Error('outer caps changed');
      begins += 1;
      const pointer = 0x1000 + (begins - 1) * 0x100;
      putPlan(pointer, begins - 1);
      return pointer;
    }},
    core_finish_slice(token, instructions, cycles, blocks, reason) {{
      finishes += 1;
      if (finishes === 1) {{
        if (token !== 0x1000n || instructions !== 5n || cycles !== 7n || blocks !== 1 || reason !== 6)
          throw new Error('first HookExit report changed');
        return 1;
      }}
      if (token !== 0x1001n || instructions !== 11n || cycles !== 13n || blocks !== 2 || reason !== 0)
        throw new Error('second report changed');
      return 0x2000;
    }},
    core_current_run_outcome() {{ return 0x2000; }},
  }},
  lazuli_dispatch: {{
    run(...args) {{
      dispatches += 1;
      dispatchArguments.push(args);
      return dispatches === 1 ? [5n, 7n, 1, 6] : [11n, 13n, 2, 0];
    }},
  }},
}});
const outcome = instance.instance.exports.core_run(100n, 10);
if (outcome !== 0x2000 || begins !== 2 || dispatches !== 2 || finishes !== 2)
  throw new Error(`HookExit escaped the coordinator: ${{JSON.stringify({{outcome, begins, dispatches, finishes}})}}`);
if (dispatchArguments[0][0] !== 0x1100 || dispatchArguments[0][5] !== 9 ||
    dispatchArguments[1][0] !== 0x1101 || dispatchArguments[1][5] !== 10)
  throw new Error('resumed dispatch did not consume the fresh Rust plan');
"
        );
        let output = Command::new("node")
            .args(["--input-type=module", "--eval", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
