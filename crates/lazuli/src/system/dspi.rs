//! DSP interface (DSPI).
use std::ops::{Deref, DerefMut};

use bitos::integer::{u15, u31};
use bitos::{BitUtils, bitos};
use dspint::{
    DspBus, DspControl as InterpreterControl, DspDma as InterpreterDma,
    DspDmaControl as InterpreterDmaControl, DspMailbox as InterpreterMailbox, ExecStopReason,
    Interpreter,
};
pub use dspint::{DspBusFault, DspBusOperation};
use gekko::{Address, LoadStoreReservation};
use util::boxed_array;

use crate::system::mem::Memory;
use crate::system::scheduler::{MachineEventDeadlines, MachineEventKind, Scheduler};
use crate::system::{System, pi};

pub const ARAM_LEN: usize = lazuli_abi::memory::ARAM_BYTES;
pub const ARAM_DMA_APERTURE_BYTES: u32 = 0x0400_0000;
pub const ARAM_DMA_ADDRESS_MASK: u32 = ARAM_DMA_APERTURE_BYTES - 32;
pub const ARAM_DMA_LENGTH_MASK: u32 = ARAM_DMA_ADDRESS_MASK;
pub const ARAM_DMA_DIRECTION_TO_MEM1: u32 = 0x8000_0000;
pub const ARAM_DMA_GRANULE_BYTES: u32 = 32;
pub const ARAM_DMA_CYCLES_PER_GRANULE: u64 = 246;

/// Browser-proven underclocked DSP ratio used by Lazuli's current compatibility baseline.
pub const DSP_CPU_CYCLES_PER_INSTRUCTION: u64 = 12;
/// Minimum number of DSP instructions in one timed LLE service.
pub const DSP_MINIMUM_EXECUTION_INSTRUCTIONS: u32 = 64;
/// Exact CPU-cycle floor between timed DSP services.
pub const DSP_EXECUTION_QUANTUM_CPU_CYCLES: u64 =
    DSP_CPU_CYCLES_PER_INSTRUCTION * DSP_MINIMUM_EXECUTION_INSTRUCTIONS as u64;

const DSP_ROM_BYTES: &[u8; 8192] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/dsp_rom.bin"
));
const DSP_COEF_BYTES: &[u8; 4096] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/dsp_coef.bin"
));

fn initialized_interpreter() -> Interpreter {
    let mut interpreter = Interpreter::default();
    for (word, bytes) in interpreter
        .mem
        .irom
        .iter_mut()
        .zip(DSP_ROM_BYTES.chunks_exact(2))
    {
        *word = u16::from_be_bytes(bytes.try_into().expect("DSP ROM word"));
    }
    for (word, bytes) in interpreter
        .mem
        .coef
        .iter_mut()
        .zip(DSP_COEF_BYTES.chunks_exact(2))
    {
        *word = u16::from_be_bytes(bytes.try_into().expect("DSP coefficient word"));
    }
    interpreter
}

/// Stable Rust-side classification of one bounded DSP interpreter stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspLleStopReason {
    InstructionBudgetExhausted,
    Halted,
    DspMailboxFull,
    CpuMailboxEmpty,
    BusFault(DspBusFault),
}

impl DspLleStopReason {
    /// Numeric contract shared with the proven standalone browser DSP bridge.
    #[must_use]
    pub const fn code(self) -> u32 {
        match self {
            Self::InstructionBudgetExhausted => 0,
            Self::Halted => 1,
            Self::DspMailboxFull => 2,
            Self::CpuMailboxEmpty => 3,
            Self::BusFault(_) => 4,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::InstructionBudgetExhausted => "instruction-budget",
            Self::Halted => "halted",
            Self::DspMailboxFull => "dsp-mailbox-full",
            Self::CpuMailboxEmpty => "cpu-mailbox-empty",
            Self::BusFault(_) => "bus-fault",
        }
    }
}

impl From<ExecStopReason> for DspLleStopReason {
    fn from(reason: ExecStopReason) -> Self {
        match reason {
            ExecStopReason::InstructionBudgetExhausted => Self::InstructionBudgetExhausted,
            ExecStopReason::Halted => Self::Halted,
            ExecStopReason::DspMailboxFull => Self::DspMailboxFull,
            ExecStopReason::CpuMailboxEmpty => Self::CpuMailboxEmpty,
            ExecStopReason::BusFault(fault) => Self::BusFault(fault),
        }
    }
}

/// Synchronous state transitions observed while executing one DSP slice.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DspLleTransitions {
    pub cpu_mailbox_consumed: bool,
    pub dsp_mailbox_produced: bool,
    pub cpu_interrupt_asserted: bool,
    pub dsp_dma_started: u32,
    pub dsp_dma_completed: u32,
    pub main_ram_write_count: u32,
    pub last_main_ram_write: Option<(u32, usize)>,
}

/// Result of a real DSP interpreter invocation, independent of timed cadence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DspExecutionOutcome {
    pub executed_instructions: u32,
    pub stop_reason: DspLleStopReason,
    pub pc: u16,
    pub transitions: DspLleTransitions,
}

/// One due 768-cycle-or-larger timed DSP service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DspLleSlice {
    pub observed_cycle: u64,
    pub budgeted_instructions: u32,
    pub executed_instructions: u32,
    pub stop_reason: DspLleStopReason,
    pub pc: u16,
    pub next_execution_cycle: u64,
    pub transitions: DspLleTransitions,
}

/// Result of asking the Rust machine to service its DSP at an observed CPU cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspLleServiceOutcome {
    NotDue { next_execution_cycle: u64 },
    Executed(DspLleSlice),
}

impl DspLleServiceOutcome {
    #[must_use]
    pub const fn next_execution_cycle(self) -> u64 {
        match self {
            Self::NotDue {
                next_execution_cycle,
            } => next_execution_cycle,
            Self::Executed(slice) => slice.next_execution_cycle,
        }
    }

    /// Publishes the exact next quantum into the resident machine's fixed deadline set.
    pub fn publish_deadline(self, deadlines: &mut MachineEventDeadlines) {
        deadlines.schedule(MachineEventKind::DspExecution, self.next_execution_cycle());
    }
}

/// A timed DSP request could not preserve the browser's exact accounting contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspLleServiceError {
    NonMonotonicCycle {
        observed_cycle: u64,
        last_service_cycle: u64,
    },
    CycleOverflow,
    InstructionBudgetOverflow(u64),
    CounterOverflow,
    InconsistentOutcome(DspLleSlice),
    FatalStop(DspLleSlice),
}

/// Integer-only timing and evidence state for Rust-owned DSP LLE execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DspLleState {
    last_service_cycle: u64,
    pending_cpu_cycles: u64,
    next_execution_cycle: u64,
    execution_slices: u64,
    budgeted_instructions: u64,
    executed_instructions: u64,
    last_execution_cycle: Option<u64>,
    last_stop_reason: DspLleStopReason,
    last_pc: u16,
    stop_reason_counts: [u64; 5],
}

impl Default for DspLleState {
    fn default() -> Self {
        Self {
            last_service_cycle: 0,
            pending_cpu_cycles: 0,
            next_execution_cycle: DSP_EXECUTION_QUANTUM_CPU_CYCLES,
            execution_slices: 0,
            budgeted_instructions: 0,
            executed_instructions: 0,
            last_execution_cycle: None,
            last_stop_reason: DspLleStopReason::InstructionBudgetExhausted,
            last_pc: 0,
            stop_reason_counts: [0; 5],
        }
    }
}

impl DspLleState {
    #[must_use]
    pub const fn last_service_cycle(&self) -> u64 {
        self.last_service_cycle
    }

    #[must_use]
    pub const fn pending_cpu_cycles(&self) -> u64 {
        self.pending_cpu_cycles
    }

    #[must_use]
    pub const fn next_execution_cycle(&self) -> u64 {
        self.next_execution_cycle
    }

    #[must_use]
    pub const fn execution_slices(&self) -> u64 {
        self.execution_slices
    }

    #[must_use]
    pub const fn budgeted_instructions(&self) -> u64 {
        self.budgeted_instructions
    }

    #[must_use]
    pub const fn executed_instructions(&self) -> u64 {
        self.executed_instructions
    }

    #[must_use]
    pub const fn last_execution_cycle(&self) -> Option<u64> {
        self.last_execution_cycle
    }

    #[must_use]
    pub const fn last_stop_reason(&self) -> DspLleStopReason {
        self.last_stop_reason
    }

    #[must_use]
    pub const fn last_pc(&self) -> u16 {
        self.last_pc
    }

    #[must_use]
    pub const fn stop_reason_count(&self, reason: DspLleStopReason) -> u64 {
        self.stop_reason_counts[reason.code() as usize]
    }

    pub fn publish_deadline(&self, deadlines: &mut MachineEventDeadlines) {
        deadlines.schedule(MachineEventKind::DspExecution, self.next_execution_cycle);
    }

    fn account_until(&mut self, observed_cycle: u64) -> Result<Option<u32>, DspLleServiceError> {
        let Some(elapsed) = observed_cycle.checked_sub(self.last_service_cycle) else {
            return Err(DspLleServiceError::NonMonotonicCycle {
                observed_cycle,
                last_service_cycle: self.last_service_cycle,
            });
        };
        let pending = self
            .pending_cpu_cycles
            .checked_add(elapsed)
            .ok_or(DspLleServiceError::CycleOverflow)?;
        let next = |remainder: u64| {
            observed_cycle
                .checked_add(DSP_EXECUTION_QUANTUM_CPU_CYCLES - remainder)
                .ok_or(DspLleServiceError::CycleOverflow)
        };

        self.last_service_cycle = observed_cycle;
        if pending < DSP_EXECUTION_QUANTUM_CPU_CYCLES {
            self.pending_cpu_cycles = pending;
            self.next_execution_cycle = next(pending)?;
            return Ok(None);
        }

        let budget = pending / DSP_CPU_CYCLES_PER_INSTRUCTION;
        if budget < u64::from(DSP_MINIMUM_EXECUTION_INSTRUCTIONS) || budget > u64::from(u32::MAX) {
            return Err(DspLleServiceError::InstructionBudgetOverflow(budget));
        }
        let remainder = pending - budget * DSP_CPU_CYCLES_PER_INSTRUCTION;
        debug_assert!(remainder < DSP_CPU_CYCLES_PER_INSTRUCTION);
        self.pending_cpu_cycles = remainder;
        self.next_execution_cycle = next(remainder)?;
        Ok(Some(budget as u32))
    }

    fn record_slice(
        &mut self,
        observed_cycle: u64,
        budget: u32,
        execution: DspExecutionOutcome,
    ) -> Result<DspLleSlice, DspLleServiceError> {
        self.execution_slices = self
            .execution_slices
            .checked_add(1)
            .ok_or(DspLleServiceError::CounterOverflow)?;
        self.budgeted_instructions = self
            .budgeted_instructions
            .checked_add(u64::from(budget))
            .ok_or(DspLleServiceError::CounterOverflow)?;
        self.executed_instructions = self
            .executed_instructions
            .checked_add(u64::from(execution.executed_instructions))
            .ok_or(DspLleServiceError::CounterOverflow)?;
        self.last_execution_cycle = Some(observed_cycle);
        self.last_stop_reason = execution.stop_reason;
        self.last_pc = execution.pc;
        let count = &mut self.stop_reason_counts[execution.stop_reason.code() as usize];
        *count = count
            .checked_add(1)
            .ok_or(DspLleServiceError::CounterOverflow)?;

        let slice = DspLleSlice {
            observed_cycle,
            budgeted_instructions: budget,
            executed_instructions: execution.executed_instructions,
            stop_reason: execution.stop_reason,
            pc: execution.pc,
            next_execution_cycle: self.next_execution_cycle,
            transitions: execution.transitions,
        };
        if execution.executed_instructions > budget
            || (execution.stop_reason == DspLleStopReason::InstructionBudgetExhausted
                && execution.executed_instructions != budget)
        {
            return Err(DspLleServiceError::InconsistentOutcome(slice));
        }
        if matches!(execution.stop_reason, DspLleStopReason::BusFault(_)) {
            return Err(DspLleServiceError::FatalStop(slice));
        }
        Ok(slice)
    }
}

#[bitos(32)]
#[derive(Debug, Default)]
pub struct Mailbox {
    #[bits(0..16)]
    pub low: u16,
    #[bits(16..31)]
    pub high: u15,
    #[bits(16..32)]
    pub high_and_status: u16,

    #[bits(0..31)]
    pub data: u31,
    #[bits(31)]
    pub status: bool,
}

#[bitos(16)]
#[derive(Debug, Clone, Copy)]
pub struct Control {
    /// Reset the DSP.
    #[bits(0)]
    pub reset: bool,
    /// The CPU->DSP interrupt (external interrupt exception in the DSP), raised by the CPU to
    /// interrupt the DSP.
    #[bits(1)]
    pub cpu_to_dsp_interrupt: bool,
    /// Halts the DSP (i.e. stops execution of further instructions).
    #[bits(2)]
    pub halt: bool,
    /// The AI DMA interrupt, raised when a new block of audio data is requested.
    #[bits(3)]
    pub ai_dma_interrupt: bool,
    #[bits(4)]
    pub ai_dma_interrupt_mask: bool,
    /// The ARAM DMA interrupt, raised when the DMA finishes.
    #[bits(5)]
    pub aram_dma_interrupt: bool,
    #[bits(6)]
    pub aram_dma_interrupt_mask: bool,
    /// The DSP->CPU interrupt, raised by the DSP to interrupt the CPU.
    #[bits(7)]
    pub dsp_to_cpu_interrupt: bool,
    #[bits(8)]
    pub dsp_to_cpu_interrupt_mask: bool,
    /// Whether the ARAM DMA is in progress.
    #[bits(9)]
    pub aram_dma_ongoing: bool,
    #[bits(10)]
    pub unknown: bool,
    /// Alternative reset bit, controls whether reset happens in the low vector or the high vector.
    #[bits(11)]
    pub reset_high: bool,
}

impl Default for Control {
    fn default() -> Self {
        Self::from_bits(0).with_reset_high(true)
    }
}

impl Control {
    pub fn any_interrupt(&self) -> bool {
        let ai = self.ai_dma_interrupt() && self.ai_dma_interrupt_mask();
        let aram = self.aram_dma_interrupt() && self.aram_dma_interrupt_mask();
        let dsp = self.dsp_to_cpu_interrupt() && self.dsp_to_cpu_interrupt_mask();
        ai || aram || dsp
    }
}

#[bitos(1)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AramDmaDirection {
    FromRamToAram = 0,
    FromAramToRam = 1,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct AramDmaControl {
    #[bits(0..31)]
    pub length: u31,
    #[bits(31)]
    pub direction: AramDmaDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AramDmaEffect {
    ZeroLength,
    InternalAram,
    ExpansionNoOp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AramDmaMem1Write {
    pub address: Address,
    pub length: u32,
}

/// Immutable evidence for one accepted ARAM DMA. Data and post-incremented registers commit at
/// `trigger_cycle`; only BUSY completion and ARINT wait for `completion_cycle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AramDmaTransfer {
    pub direction: AramDmaDirection,
    pub ram_address: Address,
    pub aram_address: u32,
    pub length: u32,
    pub trigger_cycle: u64,
    pub completion_cycle: u64,
    pub effect: AramDmaEffect,
    pub valid_mem1_bytes: u32,
    pub zero_source_bytes: u32,
    pub ignored_destination_bytes: u32,
    pub expansion_no_op_bytes: u32,
    pub mem1_write: Option<AramDmaMem1Write>,
    pub reservation_invalidated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AramDmaBusyRejection {
    pub cycle: u64,
    pub written_count_and_direction: u32,
    pub preserved_completion_cycle: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AramDmaStartOutcome {
    Started(AramDmaTransfer),
    Busy(AramDmaBusyRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AramDmaServiceOutcome {
    Idle,
    BeforeDeadline {
        completion_cycle: u64,
    },
    Completed {
        completion_cycle: u64,
        serviced_at_cycle: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AramDmaError {
    NonMonotonicCycle {
        observed_cycle: u64,
        last_observed_cycle: u64,
    },
    UnalignedLength(u32),
    DeadlineOverflow,
    CounterOverflow,
}

/// Complete browser-ordered Rust DSP phase at one observed CPU cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResidentDspServiceSummary {
    pub audio_dma: crate::system::ai::DspAudioDmaServiceSummary,
    pub aram_dma: AramDmaServiceOutcome,
    pub interpreter: DspLleServiceOutcome,
    pub interrupt_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentDspServiceError {
    Audio(crate::system::ai::ResidentAudioError),
    Aram(AramDmaError),
    Interpreter(DspLleServiceError),
}

impl From<crate::system::ai::ResidentAudioError> for ResidentDspServiceError {
    fn from(error: crate::system::ai::ResidentAudioError) -> Self {
        Self::Audio(error)
    }
}

impl From<AramDmaError> for ResidentDspServiceError {
    fn from(error: AramDmaError) -> Self {
        Self::Aram(error)
    }
}

impl From<DspLleServiceError> for ResidentDspServiceError {
    fn from(error: DspLleServiceError) -> Self {
        Self::Interpreter(error)
    }
}

#[derive(Default)]
pub struct AramDma {
    pub ram_base: Address,
    pub aram_base: u32,
    pub control: AramDmaControl,
    pending: Option<AramDmaTransfer>,
    last_transfer: Option<AramDmaTransfer>,
    last_rejection: Option<AramDmaBusyRejection>,
    starts: u64,
    completions: u64,
    busy_retrigger_rejections: u64,
    interrupt_assertions: u64,
    last_observed_cycle: u64,
}

impl AramDma {
    #[must_use]
    pub const fn pending(&self) -> Option<AramDmaTransfer> {
        self.pending
    }

    #[must_use]
    pub const fn last_transfer(&self) -> Option<AramDmaTransfer> {
        self.last_transfer
    }

    #[must_use]
    pub const fn last_rejection(&self) -> Option<AramDmaBusyRejection> {
        self.last_rejection
    }

    #[must_use]
    pub const fn starts(&self) -> u64 {
        self.starts
    }

    #[must_use]
    pub const fn completions(&self) -> u64 {
        self.completions
    }

    #[must_use]
    pub const fn busy_retrigger_rejections(&self) -> u64 {
        self.busy_retrigger_rejections
    }

    #[must_use]
    pub const fn interrupt_assertions(&self) -> u64 {
        self.interrupt_assertions
    }

    #[must_use]
    pub const fn last_observed_cycle(&self) -> u64 {
        self.last_observed_cycle
    }

    #[must_use]
    pub const fn completion_cycle(&self) -> Option<u64> {
        match self.pending {
            Some(transfer) => Some(transfer.completion_cycle),
            None => None,
        }
    }

    pub fn publish_deadline(&self, deadlines: &mut MachineEventDeadlines) {
        deadlines.set(MachineEventKind::AramDmaCompletion, self.completion_cycle());
    }

    fn observe(&mut self, observed_cycle: u64) -> Result<(), AramDmaError> {
        if observed_cycle < self.last_observed_cycle {
            return Err(AramDmaError::NonMonotonicCycle {
                observed_cycle,
                last_observed_cycle: self.last_observed_cycle,
            });
        }
        self.last_observed_cycle = observed_cycle;
        Ok(())
    }
}

#[bitos(1)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspDmaDirection {
    FromRamToDsp = 0,
    FromDspToRam = 1,
}

#[bitos(1)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspDmaTarget {
    Dmem = 0,
    Imem = 1,
}

#[bitos(16)]
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DspDmaControl {
    #[bits(0)]
    pub direction: DspDmaDirection,
    #[bits(1)]
    pub dsp_target: DspDmaTarget,
    #[bits(2)]
    pub transfer_ongoing: bool,
}

#[derive(Default)]
pub struct DspDma {
    pub ram_base: u32,
    pub dsp_base: u16,
    pub length: u16,
    pub control: DspDmaControl,
}

pub struct Dsp {
    /// The sole low-level DSP interpreter owned by this machine.
    interpreter: Box<Interpreter>,
    /// Integer-only cadence state shared by native and browser-resident runners.
    pub lle: DspLleState,
    pub control: Control,
    /// Data from DSP to CPU
    pub dsp_mailbox: Mailbox,
    /// Data from CPU to DSP
    pub cpu_mailbox: Mailbox,
    pub dsp_dma: DspDma,
    pub aram_dma: AramDma,
    pub aram_len: u32,
    pub aram: Aram,
}

/// Owned native or externally mapped browser ARAM.
pub enum Aram {
    Owned(Box<[u8; ARAM_LEN]>),
    Mapped(&'static mut [u8; ARAM_LEN]),
}

impl Aram {
    #[inline(always)]
    pub fn as_slice(&self) -> &[u8] {
        self
    }

    #[inline(always)]
    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        self
    }
}

impl Deref for Aram {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        match self {
            Self::Owned(bytes) => bytes.as_slice(),
            Self::Mapped(bytes) => bytes.as_slice(),
        }
    }
}

impl DerefMut for Aram {
    fn deref_mut(&mut self) -> &mut Self::Target {
        match self {
            Self::Owned(bytes) => bytes.as_mut_slice(),
            Self::Mapped(bytes) => bytes.as_mut_slice(),
        }
    }
}

impl Dsp {
    pub fn new() -> Self {
        Self::with_aram(Aram::Owned(boxed_array(0)))
    }

    /// Constructs the DSP over the browser's fixed externally owned ARAM window.
    pub fn new_mapped(aram: &'static mut [u8; ARAM_LEN]) -> Self {
        Self::with_aram(Aram::Mapped(aram))
    }

    fn with_aram(aram: Aram) -> Self {
        Self {
            interpreter: Box::new(initialized_interpreter()),
            lle: DspLleState::default(),
            control: Default::default(),
            dsp_mailbox: Default::default(),
            cpu_mailbox: Default::default(),
            dsp_dma: Default::default(),
            aram_dma: Default::default(),
            aram_len: 0,
            aram,
        }
    }
}

struct SystemDspBus<'a> {
    control: &'a mut Control,
    dsp_mailbox: &'a mut Mailbox,
    cpu_mailbox: &'a mut Mailbox,
    dsp_dma: &'a mut DspDma,
    aram: &'a mut Aram,
    memory: &'a mut Memory,
    reservation: &'a mut LoadStoreReservation,
    scheduler: &'a mut Scheduler,
    transitions: DspLleTransitions,
}

impl DspBus for SystemDspBus<'_> {
    fn dsp_control(&self) -> InterpreterControl {
        InterpreterControl {
            reset: self.control.reset(),
            reset_high: self.control.reset_high(),
            halted: self.control.halt(),
            cpu_to_dsp_interrupt: self.control.cpu_to_dsp_interrupt(),
        }
    }

    fn set_dsp_control(&mut self, control: InterpreterControl) {
        self.control.set_reset(control.reset);
        self.control.set_reset_high(control.reset_high);
        self.control.set_halt(control.halted);
        self.control
            .set_cpu_to_dsp_interrupt(control.cpu_to_dsp_interrupt);
    }

    fn dsp_dma(&self) -> InterpreterDma {
        InterpreterDma {
            ram_base: self.dsp_dma.ram_base,
            dsp_base: self.dsp_dma.dsp_base,
            length: self.dsp_dma.length,
            control: InterpreterDmaControl::from_bits(self.dsp_dma.control.to_bits()),
        }
    }

    fn set_dsp_dma(&mut self, dma: InterpreterDma) {
        let was_ongoing = self.dsp_dma.control.transfer_ongoing();
        let is_ongoing = dma.control.transfer_ongoing();
        if !was_ongoing && is_ongoing {
            self.transitions.dsp_dma_started = self.transitions.dsp_dma_started.saturating_add(1);
        } else if was_ongoing && !is_ongoing {
            self.transitions.dsp_dma_completed =
                self.transitions.dsp_dma_completed.saturating_add(1);
        }
        self.dsp_dma.ram_base = dma.ram_base;
        self.dsp_dma.dsp_base = dma.dsp_base;
        self.dsp_dma.length = dma.length;
        self.dsp_dma.control = DspDmaControl::from_bits(dma.control.to_bits());
    }

    fn dsp_mailbox(&self) -> InterpreterMailbox {
        InterpreterMailbox::from_bits(self.dsp_mailbox.to_bits())
    }

    fn set_dsp_mailbox(&mut self, mailbox: InterpreterMailbox) {
        *self.dsp_mailbox = Mailbox::from_bits(mailbox.to_bits());
    }

    fn cpu_mailbox(&self) -> InterpreterMailbox {
        InterpreterMailbox::from_bits(self.cpu_mailbox.to_bits())
    }

    fn set_cpu_mailbox(&mut self, mailbox: InterpreterMailbox) {
        *self.cpu_mailbox = Mailbox::from_bits(mailbox.to_bits());
    }

    fn main_ram(&self) -> &[u8] {
        self.memory.ram()
    }

    fn main_ram_mut(&mut self) -> &mut [u8] {
        self.memory.ram_mut()
    }

    fn main_ram_write_completed(&mut self, address: u32, length: usize) {
        self.reservation.invalidate_range(Address(address), length);
        self.transitions.main_ram_write_count =
            self.transitions.main_ram_write_count.saturating_add(1);
        self.transitions.last_main_ram_write = Some((address, length));
    }

    fn aram(&self) -> &[u8] {
        self.aram.as_slice()
    }

    fn aram_mut(&mut self) -> &mut [u8] {
        self.aram.as_mut_slice()
    }

    fn request_cpu_interrupt(&mut self) {
        if !self.control.dsp_to_cpu_interrupt() {
            self.transitions.cpu_interrupt_asserted = true;
        }
        self.control.set_dsp_to_cpu_interrupt(true);
        self.scheduler.schedule_now(pi::check_interrupts);
    }
}

impl System {
    /// Executes one explicit DSP instruction budget through the machine-owned LLE interpreter.
    ///
    /// Timed runners should normally call [`Self::service_dsp_lle`]. This lower-level entry point
    /// remains for Lazuli's legacy [`crate::cores::DspCore`] adapter while that trait is retired.
    pub fn execute_dsp_instructions(&mut self, budget: u32) -> DspExecutionOutcome {
        let cpu_mailbox_full_before = self.dsp.cpu_mailbox.status();
        let dsp_mailbox_full_before = self.dsp.dsp_mailbox.status();

        let (outcome, pc, mut transitions) = {
            let System {
                cpu,
                dsp,
                mem,
                scheduler,
                ..
            } = self;
            let Dsp {
                interpreter,
                control,
                dsp_mailbox,
                cpu_mailbox,
                dsp_dma,
                aram,
                ..
            } = dsp;
            let mut bus = SystemDspBus {
                control,
                dsp_mailbox,
                cpu_mailbox,
                dsp_dma,
                aram,
                memory: mem,
                reservation: &mut cpu.reservation,
                scheduler,
                transitions: DspLleTransitions::default(),
            };
            let outcome = interpreter.exec(&mut bus, budget);
            (outcome, interpreter.pc, bus.transitions)
        };

        transitions.cpu_mailbox_consumed =
            cpu_mailbox_full_before && !self.dsp.cpu_mailbox.status();
        transitions.dsp_mailbox_produced =
            !dsp_mailbox_full_before && self.dsp.dsp_mailbox.status();
        DspExecutionOutcome {
            executed_instructions: outcome.executed_instructions,
            stop_reason: outcome.stop_reason.into(),
            pc,
            transitions,
        }
    }

    /// Services the machine-owned DSP at an absolute CPU cycle.
    ///
    /// The first execution cannot occur before cycle 768. Overshoot budgets every complete DSP
    /// instruction, and the entire supplied budget is consumed even if the interpreter stops
    /// early on halt or a mailbox. Only a sub-instruction 0..11 CPU-cycle remainder survives.
    pub fn service_dsp_lle(
        &mut self,
        observed_cycle: u64,
    ) -> Result<DspLleServiceOutcome, DspLleServiceError> {
        let Some(budget) = self.dsp.lle.account_until(observed_cycle)? else {
            return Ok(DspLleServiceOutcome::NotDue {
                next_execution_cycle: self.dsp.lle.next_execution_cycle,
            });
        };

        let execution = self.execute_dsp_instructions(budget);
        let slice = self
            .dsp
            .lle
            .record_slice(observed_cycle, budget, execution)?;
        Ok(DspLleServiceOutcome::Executed(slice))
    }

    /// Publishes the next DSP execution quantum into a resident deadline set.
    pub fn publish_dsp_lle_deadline(&self, deadlines: &mut MachineEventDeadlines) {
        self.dsp.lle.publish_deadline(deadlines);
    }
}

#[must_use]
pub const fn normalize_aram_dma_address(value: u32) -> u32 {
    value & ARAM_DMA_ADDRESS_MASK
}

#[must_use]
pub const fn normalize_aram_dma_count(value: u32) -> u32 {
    (value & ARAM_DMA_DIRECTION_TO_MEM1) | (value & ARAM_DMA_LENGTH_MASK)
}

pub fn aram_dma_completion_cycles(length: u32) -> Result<u64, AramDmaError> {
    if !length.is_multiple_of(ARAM_DMA_GRANULE_BYTES) {
        return Err(AramDmaError::UnalignedLength(length));
    }
    Ok((length / ARAM_DMA_GRANULE_BYTES) as u64 * ARAM_DMA_CYCLES_PER_GRANULE)
}

impl AramDma {
    pub fn write_ram_base(&mut self, value: u32) {
        self.ram_base = Address(normalize_aram_dma_address(value));
    }

    pub fn write_aram_base(&mut self, value: u32) {
        self.aram_base = normalize_aram_dma_address(value);
    }

    /// Programs count/direction without triggering. The low-lane/full-word MMIO seam calls the
    /// `System` start method below with its composed value instead.
    pub fn write_count_without_start(&mut self, value: u32) {
        self.control = AramDmaControl::from_bits(normalize_aram_dma_count(value));
    }
}

impl System {
    /// Starts a bounded ARAM DMA using the complete composed count/direction register value.
    ///
    /// This is the frozen browser oracle policy: valid data and post-incremented registers commit
    /// synchronously; BUSY/ARINT timing remains in Rust until the exact completion deadline.
    pub fn start_resident_aram_dma(
        &mut self,
        written_count_and_direction: u32,
        observed_cycle: u64,
    ) -> Result<AramDmaStartOutcome, AramDmaError> {
        let written_count_and_direction = normalize_aram_dma_count(written_count_and_direction);
        let System { cpu, dsp, mem, .. } = self;
        let Dsp {
            control,
            aram_dma,
            aram,
            ..
        } = dsp;
        aram_dma.observe(observed_cycle)?;

        if aram_dma.pending.is_some() || control.aram_dma_ongoing() {
            let rejection = AramDmaBusyRejection {
                cycle: observed_cycle,
                written_count_and_direction,
                preserved_completion_cycle: aram_dma.completion_cycle(),
            };
            aram_dma.busy_retrigger_rejections = aram_dma
                .busy_retrigger_rejections
                .checked_add(1)
                .ok_or(AramDmaError::CounterOverflow)?;
            aram_dma.last_rejection = Some(rejection);
            return Ok(AramDmaStartOutcome::Busy(rejection));
        }

        let direction = AramDmaControl::from_bits(written_count_and_direction).direction();
        let length = written_count_and_direction & ARAM_DMA_LENGTH_MASK;
        let ram_address = Address(normalize_aram_dma_address(aram_dma.ram_base.value()));
        let aram_address = normalize_aram_dma_address(aram_dma.aram_base);
        let completion_cycle = observed_cycle
            .checked_add(aram_dma_completion_cycles(length)?)
            .ok_or(AramDmaError::DeadlineOverflow)?;
        let starts = aram_dma
            .starts
            .checked_add(1)
            .ok_or(AramDmaError::CounterOverflow)?;
        let internal_start = aram_address < ARAM_LEN as u32;
        let ram_start = ram_address.value() as usize;
        let transfer_length = length as usize;
        let valid_mem1_bytes = if internal_start && ram_start < mem.ram().len() {
            transfer_length.min(mem.ram().len() - ram_start)
        } else {
            0
        };

        let mut reservation_invalidated = false;
        if internal_start && transfer_length != 0 {
            match direction {
                AramDmaDirection::FromRamToAram => {
                    let ram = mem.ram();
                    let mut copied = 0;
                    while copied < transfer_length {
                        let target = (aram_address as usize + copied) & (ARAM_LEN - 1);
                        let chunk = (transfer_length - copied).min(ARAM_LEN - target);
                        let source = ram_start + copied;
                        let valid = if source < ram.len() {
                            chunk.min(ram.len() - source)
                        } else {
                            0
                        };
                        if valid != 0 {
                            aram[target..target + valid]
                                .copy_from_slice(&ram[source..source + valid]);
                        }
                        if valid != chunk {
                            aram[target + valid..target + chunk].fill(0);
                        }
                        copied += chunk;
                    }
                }
                AramDmaDirection::FromAramToRam => {
                    let ram = mem.ram_mut();
                    let mut copied = 0;
                    while copied < valid_mem1_bytes {
                        let source = (aram_address as usize + copied) & (ARAM_LEN - 1);
                        let chunk = (valid_mem1_bytes - copied).min(ARAM_LEN - source);
                        ram[ram_start + copied..ram_start + copied + chunk]
                            .copy_from_slice(&aram[source..source + chunk]);
                        copied += chunk;
                    }
                    reservation_invalidated = cpu
                        .reservation
                        .invalidate_range(ram_address, valid_mem1_bytes);
                }
            }
        }

        let effect = if length == 0 {
            AramDmaEffect::ZeroLength
        } else if internal_start {
            AramDmaEffect::InternalAram
        } else {
            AramDmaEffect::ExpansionNoOp
        };
        let valid_mem1_bytes = valid_mem1_bytes as u32;
        let transfer = AramDmaTransfer {
            direction,
            ram_address,
            aram_address,
            length,
            trigger_cycle: observed_cycle,
            completion_cycle,
            effect,
            valid_mem1_bytes,
            zero_source_bytes: if internal_start && direction == AramDmaDirection::FromRamToAram {
                length - valid_mem1_bytes
            } else {
                0
            },
            ignored_destination_bytes: if internal_start
                && direction == AramDmaDirection::FromAramToRam
            {
                length - valid_mem1_bytes
            } else {
                0
            },
            expansion_no_op_bytes: if internal_start { 0 } else { length },
            mem1_write: (internal_start
                && direction == AramDmaDirection::FromAramToRam
                && valid_mem1_bytes != 0)
                .then_some(AramDmaMem1Write {
                    address: ram_address,
                    length: valid_mem1_bytes,
                }),
            reservation_invalidated,
        };

        aram_dma.ram_base = Address(normalize_aram_dma_address(
            ram_address.value().wrapping_add(length),
        ));
        aram_dma.aram_base = normalize_aram_dma_address(aram_address.wrapping_add(length));
        aram_dma.control = AramDmaControl::from_bits(match direction {
            AramDmaDirection::FromRamToAram => 0,
            AramDmaDirection::FromAramToRam => ARAM_DMA_DIRECTION_TO_MEM1,
        });
        aram_dma.pending = Some(transfer);
        aram_dma.last_transfer = Some(transfer);
        aram_dma.last_rejection = None;
        aram_dma.starts = starts;
        control.set_aram_dma_ongoing(true);
        Ok(AramDmaStartOutcome::Started(transfer))
    }

    fn service_resident_aram_dma_state(
        &mut self,
        observed_cycle: u64,
    ) -> Result<AramDmaServiceOutcome, AramDmaError> {
        self.dsp.aram_dma.observe(observed_cycle)?;
        let Some(transfer) = self.dsp.aram_dma.pending else {
            return Ok(AramDmaServiceOutcome::Idle);
        };
        if observed_cycle < transfer.completion_cycle {
            return Ok(AramDmaServiceOutcome::BeforeDeadline {
                completion_cycle: transfer.completion_cycle,
            });
        }

        let completions = self
            .dsp
            .aram_dma
            .completions
            .checked_add(1)
            .ok_or(AramDmaError::CounterOverflow)?;
        let assertions = self
            .dsp
            .aram_dma
            .interrupt_assertions
            .checked_add(1)
            .ok_or(AramDmaError::CounterOverflow)?;
        self.dsp.aram_dma.pending = None;
        self.dsp.aram_dma.completions = completions;
        self.dsp.aram_dma.interrupt_assertions = assertions;
        self.dsp.control.set_aram_dma_ongoing(false);
        self.dsp.control.set_aram_dma_interrupt(true);
        Ok(AramDmaServiceOutcome::Completed {
            completion_cycle: transfer.completion_cycle,
            serviced_at_cycle: observed_cycle,
        })
    }

    /// Completes BUSY and asserts level-sensitive ARINT at the accepted transfer's deadline.
    pub fn service_resident_aram_dma(
        &mut self,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<AramDmaServiceOutcome, AramDmaError> {
        let outcome = self.service_resident_aram_dma_state(observed_cycle)?;
        self.dsp.aram_dma.publish_deadline(deadlines);
        pi::check_interrupts(self);
        Ok(outcome)
    }

    pub fn publish_resident_aram_dma_deadline(&self, deadlines: &mut MachineEventDeadlines) {
        self.dsp.aram_dma.publish_deadline(deadlines);
    }

    /// Drains the complete DSP phase in browser service order and samples PI only afterward:
    /// AID initial status/blocks/completion, ARAM completion, then the LLE instruction quantum.
    pub fn service_resident_dsp(
        &mut self,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<ResidentDspServiceSummary, ResidentDspServiceError> {
        let audio_dma = self.audio.service_resident_dsp_audio_dma(observed_cycle)?;
        if audio_dma.initial_interrupts != 0 || audio_dma.completions != 0 {
            self.dsp.control.set_ai_dma_interrupt(true);
        }
        let aram_dma = self.service_resident_aram_dma_state(observed_cycle)?;
        let interpreter = self.service_dsp_lle(observed_cycle)?;

        self.audio.publish_resident_deadlines(deadlines)?;
        self.dsp.aram_dma.publish_deadline(deadlines);
        interpreter.publish_deadline(deadlines);
        let interrupt_active = self.dsp.control.any_interrupt();
        pi::check_interrupts(self);
        Ok(ResidentDspServiceSummary {
            audio_dma,
            aram_dma,
            interpreter,
            interrupt_active,
        })
    }

    pub fn publish_resident_dsp_deadlines(
        &self,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<(), crate::system::ai::ResidentAudioError> {
        self.audio.publish_resident_deadlines(deadlines)?;
        self.dsp.aram_dma.publish_deadline(deadlines);
        self.dsp.lle.publish_deadline(deadlines);
        Ok(())
    }
}

pub fn write_control(sys: &mut System, value: Control) {
    write_control_masked(sys, value, u16::MAX);
}

/// Applies one potentially partial DSPCSR write with per-lane W1C semantics.
pub fn write_control_masked(sys: &mut System, value: Control, written_mask: u16) {
    const INTERRUPT_STATUSES: u16 = 0x00a8;
    const DMA_STATE: u16 = 0x0200;
    const WRITABLE: u16 = 0x0d57;

    let current = sys.dsp.control.to_bits();
    let written = value.to_bits();
    let status = (current & INTERRUPT_STATUSES) & !(written & written_mask & INTERRUPT_STATUSES);
    let guest_control = (current & WRITABLE & !written_mask) | (written & WRITABLE & written_mask);
    sys.dsp.control = Control::from_bits(guest_control | status | (current & DMA_STATE));
}

/// Performs the ARAM DMA if length is not zero.
pub fn aram_dma(sys: &mut System) {
    let ram_base = sys.dsp.aram_dma.ram_base.value().with_bits(26, 32, 0);
    let aram_base = sys.dsp.aram_dma.aram_base as usize;

    if aram_base >= ARAM_LEN {
        // software will try to DMA from out-of-bounds ARAM regions to test for ARAM expansion. in
        // this case, just ignore it
        sys.dsp.aram_dma.control.set_length(u31::new(0));
        sys.dsp.control.set_aram_dma_interrupt(true);
        sys.dsp.control.set_aram_dma_ongoing(false);
        return;
    }

    let max_length = ARAM_LEN - aram_base;
    let length = sys.dsp.aram_dma.control.length().value() as usize;
    let effective_length = length.min(max_length);

    match sys.dsp.aram_dma.control.direction() {
        AramDmaDirection::FromRamToAram => {
            tracing::debug!(
                "ARAM DMA {effective_length} bytes from RAM {} to ARAM {aram_base:08X}",
                Address(ram_base)
            );

            let aram = &mut sys.dsp.aram[aram_base..][..effective_length];
            aram.copy_from_slice(&sys.mem.ram()[ram_base as usize..][..effective_length]);
        }
        AramDmaDirection::FromAramToRam => {
            tracing::debug!(
                "ARAM DMA {effective_length} bytes from ARAM {aram_base:08X} to RAM {}",
                Address(ram_base)
            );

            sys.mem.ram_mut()[ram_base as usize..][..effective_length]
                .copy_from_slice(&sys.dsp.aram[aram_base..][..effective_length]);
            sys.cpu
                .reservation
                .invalidate_range(Address(ram_base), effective_length);
        }
    }

    sys.dsp.aram_dma.control.set_length(u31::new(0));
    sys.dsp.control.set_aram_dma_interrupt(true);
    sys.dsp.control.set_aram_dma_ongoing(false);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::audio::NopAudioModule;
    use crate::modules::debug::NopDebugModule;
    use crate::modules::disk::NopDiskModule;
    use crate::modules::input::NopInputModule;
    use crate::modules::render::NopRenderModule;
    use crate::modules::vertex::NopVertexModule;
    use crate::system::scheduler::RuntimeDeadlinePolicy;
    use crate::system::{Config, Modules};

    fn test_system() -> System {
        System::new(
            Modules {
                audio: Box::new(NopAudioModule),
                debug: Box::new(NopDebugModule),
                disk: Box::new(NopDiskModule),
                input: Box::new(NopInputModule),
                render: Box::new(NopRenderModule),
                vertex: Box::new(NopVertexModule),
            },
            Config {
                ipl_lle: true,
                ipl: Some(vec![0; lazuli_abi::memory::IPL_BYTES]),
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    fn write_ucode(system: &mut System, words: &[u16]) {
        const BOOTSTRAP: u32 = 0x0100_0000;
        system.mem.ram_mut()[BOOTSTRAP as usize..BOOTSTRAP as usize + 1024].fill(0);
        for (index, word) in words.iter().copied().enumerate() {
            system.write_phys_slow(Address(BOOTSTRAP + index as u32 * 2), word);
        }
        system.dsp.control.set_reset(true);
        system.dsp.control.set_reset_high(false);
        system.dsp.control.set_halt(false);
    }

    fn execution(executed_instructions: u32, stop_reason: DspLleStopReason) -> DspExecutionOutcome {
        DspExecutionOutcome {
            executed_instructions,
            stop_reason,
            pc: 0x42,
            transitions: DspLleTransitions::default(),
        }
    }

    #[test]
    fn mapped_aram_is_exactly_visible_and_not_freed_on_drop() {
        let aram = Box::into_raw(boxed_array::<u8, ARAM_LEN>(0));
        unsafe {
            (*aram)[0x40] = 0x12;
        }

        let mut dsp = Dsp::new_mapped(
            // SAFETY: This box remains allocated until after `dsp` is dropped below, and no other
            // references are used while the DSP owns the mapped reference.
            unsafe { &mut *aram },
        );
        assert_eq!(dsp.aram.as_ptr(), aram.cast::<u8>());
        assert_eq!(dsp.aram[0x40], 0x12);
        dsp.aram[0x41] = 0xab;
        drop(dsp);

        let aram = unsafe { Box::from_raw(aram) };
        assert_eq!(aram[0x41], 0xab);
    }

    #[test]
    fn cadence_matches_browser_threshold_overshoot_and_early_stop_vectors() {
        let mut exact = DspLleState::default();
        assert_eq!(exact.account_until(767), Ok(None));
        assert_eq!(exact.pending_cpu_cycles(), 767);
        assert_eq!(exact.next_execution_cycle(), 768);

        let budget = exact.account_until(768).unwrap().unwrap();
        assert_eq!(budget, 64);
        let slice = exact
            .record_slice(
                768,
                budget,
                execution(64, DspLleStopReason::InstructionBudgetExhausted),
            )
            .unwrap();
        assert_eq!(slice.next_execution_cycle, 1_536);
        assert_eq!(exact.pending_cpu_cycles(), 0);
        assert_eq!(exact.account_until(768), Ok(None));
        assert_eq!(exact.execution_slices(), 1);
        assert_eq!(exact.budgeted_instructions(), 64);
        assert_eq!(exact.executed_instructions(), 64);

        let mut overshoot = DspLleState::default();
        let budget = overshoot.account_until(1_000).unwrap().unwrap();
        assert_eq!(budget, 83);
        let slice = overshoot
            .record_slice(1_000, budget, execution(7, DspLleStopReason::Halted))
            .unwrap();
        assert_eq!(slice.executed_instructions, 7);
        assert_eq!(slice.next_execution_cycle, 1_764);
        assert_eq!(overshoot.pending_cpu_cycles(), 4);
        assert_eq!(overshoot.last_execution_cycle(), Some(1_000));
        assert_eq!(overshoot.last_stop_reason(), DspLleStopReason::Halted);
        assert_eq!(overshoot.stop_reason_count(DspLleStopReason::Halted), 1);
        assert_eq!(overshoot.account_until(1_000), Ok(None));
        assert_eq!(overshoot.budgeted_instructions(), 83);
        assert_eq!(overshoot.executed_instructions(), 7);
    }

    #[test]
    fn cadence_rejects_nonmonotonic_inconsistent_and_faulting_slices() {
        let mut nonmonotonic = DspLleState::default();
        assert_eq!(nonmonotonic.account_until(100), Ok(None));
        assert_eq!(
            nonmonotonic.account_until(99),
            Err(DspLleServiceError::NonMonotonicCycle {
                observed_cycle: 99,
                last_service_cycle: 100,
            })
        );

        let mut inconsistent = DspLleState::default();
        let budget = inconsistent.account_until(768).unwrap().unwrap();
        let error = inconsistent
            .record_slice(
                768,
                budget,
                execution(63, DspLleStopReason::InstructionBudgetExhausted),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            DspLleServiceError::InconsistentOutcome(DspLleSlice {
                budgeted_instructions: 64,
                executed_instructions: 63,
                ..
            })
        ));

        let fault = DspBusFault {
            operation: DspBusOperation::WriteMainRam,
            address: 0x017f_ffff,
            length: 4,
            memory_length: lazuli_abi::memory::MAIN_RAM_BYTES as u32,
        };
        let mut fatal = DspLleState::default();
        let budget = fatal.account_until(768).unwrap().unwrap();
        assert!(matches!(
            fatal.record_slice(
                768,
                budget,
                execution(1, DspLleStopReason::BusFault(fault)),
            ),
            Err(DspLleServiceError::FatalStop(DspLleSlice {
                stop_reason: DspLleStopReason::BusFault(actual),
                ..
            })) if actual == fault
        ));
    }

    #[test]
    fn service_deadline_round_trips_through_machine_event_deadlines() {
        let mut system = test_system();
        let mut deadlines = MachineEventDeadlines::default();
        system.publish_dsp_lle_deadline(&mut deadlines);
        assert_eq!(
            deadlines.deadline(MachineEventKind::DspExecution),
            Some(768)
        );
        assert_eq!(
            deadlines
                .next_event_after(0, RuntimeDeadlinePolicy::EXACT)
                .unwrap()
                .kind,
            MachineEventKind::DspExecution
        );

        let not_due = system.service_dsp_lle(767).unwrap();
        assert_eq!(not_due.next_execution_cycle(), 768);
        let executed = system.service_dsp_lle(768).unwrap();
        assert!(matches!(executed, DspLleServiceOutcome::Executed(_)));
        executed.publish_deadline(&mut deadlines);
        assert_eq!(
            deadlines.deadline(MachineEventKind::DspExecution),
            Some(1_536)
        );
    }

    #[test]
    fn real_irom_reset_greeting_and_cpu_mailbox_wake_match_browser_contract() {
        let mut system = test_system();
        system.dsp.cpu_mailbox = Mailbox::from_bits(0);
        system.dsp.dsp_mailbox = Mailbox::from_bits(0);
        system.dsp.control = Control::from_bits(0x0800);

        let greeting = system.execute_dsp_instructions(64);
        assert!(greeting.executed_instructions > 0 && greeting.executed_instructions <= 64);
        assert_eq!(greeting.stop_reason, DspLleStopReason::CpuMailboxEmpty);
        assert_eq!(system.dsp.dsp_mailbox.to_bits(), 0x8071_feed);
        assert!((0x8000..0x9000).contains(&greeting.pc));
        assert!(greeting.transitions.dsp_mailbox_produced);

        system.write_phys_slow(Address(0x0c00_5000), 0x1234_5678_u32);
        assert!(system.dsp.cpu_mailbox.status());
        let resumed = system.execute_dsp_instructions(64);
        assert!(resumed.executed_instructions > 0);
        assert!(resumed.transitions.cpu_mailbox_consumed);
        assert!(!system.dsp.cpu_mailbox.status());
    }

    #[test]
    fn long_low_reset_program_preserves_budget_and_mailbox_publication_timing() {
        let mut system = test_system();
        let mut words = vec![0x0000; 130];
        words.extend_from_slice(&[
            0x16fc, 0x1234, // si @dmbh, payload high and clear stale FULL
            0x16fd, 0x5678, // si @dmbl, payload low and set FULL
            0x0021, // halt after publishing the mailbox
        ]);
        system.dsp.dsp_mailbox = Mailbox::from_bits(0);
        write_ucode(&mut system, &words);

        for _ in 0..2 {
            let outcome = system.execute_dsp_instructions(64);
            assert_eq!(outcome.executed_instructions, 64);
            assert_eq!(
                outcome.stop_reason,
                DspLleStopReason::InstructionBudgetExhausted
            );
            assert!(!system.dsp.dsp_mailbox.status());
        }
        let tail = system.execute_dsp_instructions(64);
        assert!(tail.executed_instructions > 0);
        assert_eq!(tail.stop_reason, DspLleStopReason::Halted);
        assert_eq!(system.dsp.dsp_mailbox.to_bits(), 0x9234_5678);
        assert!(tail.transitions.dsp_mailbox_produced);
    }

    #[test]
    fn mapped_aram_and_dsp_dma_vectors_preserve_bytes_and_cpu_reservations() {
        let mut system = test_system();
        let program = [
            0x16d1, 0x0002, // si @acfmt, 16-bit raw words
            0x16d8, 0x8000, // si @accah, raw-write flag
            0x16d9, 0x0002, // si @accal, word address 2
            0x16d3, 0xaabb, // si @acdraw, sentinel
            0x0080, 0x1122, // lri $AR0, sentinel
            0x00e0, 0x0003, // sr $AR0, DMEM word 3
            0x16c9, 0x0001, // si @dmac, DSP-to-RAM DMEM DMA
            0x16cd, 0x0003, // si @dspa, DMEM word 3
            0x16ce, 0x0000, // si @dsmah, MEM1 address high
            0x16cf, 0x0040, // si @dsmal, MEM1 address low
            0x16cb, 0x0002, // si @dsm, start two-byte DMA
            0x0021,
        ];
        write_ucode(&mut system, &program);
        system.cpu.reservation.reserve(Address(0x80));
        let outcome = system.execute_dsp_instructions(64);
        assert_eq!(outcome.stop_reason, DspLleStopReason::Halted);
        assert_eq!(&system.dsp.aram[4..6], &[0xaa, 0xbb]);
        assert_eq!(&system.mem.ram()[0x40..0x42], &[0x11, 0x22]);
        assert!(system.cpu.reservation.is_valid());
        assert_eq!(outcome.transitions.dsp_dma_started, 1);
        assert_eq!(outcome.transitions.dsp_dma_completed, 1);
        assert_eq!(outcome.transitions.main_ram_write_count, 1);
        assert_eq!(outcome.transitions.last_main_ram_write, Some((0x40, 2)));

        write_ucode(&mut system, &program);
        system.cpu.reservation.reserve(Address(0x40));
        let outcome = system.execute_dsp_instructions(64);
        assert_eq!(outcome.stop_reason, DspLleStopReason::Halted);
        assert!(!system.cpu.reservation.is_valid());
    }

    #[test]
    fn mapped_aram_read_and_checked_dma_fault_match_browser_vectors() {
        let mut system = test_system();
        system.dsp.aram[2] = 0x7a;
        system.dsp.dsp_mailbox = Mailbox::from_bits(0);
        write_ucode(
            &mut system,
            &[
                0x0092, 0x00ff, // lri $CR, 0xff for short IFX addressing
                0x16d1, 0x0001, // si @acfmt, raw bytes
                0x16d8, 0x0000, // si @accah, address high
                0x16d9, 0x0002, // si @accal, byte address 2
                0x16fc, 0x0000, // si @dmbh, clear previous mailbox status
                0x26d3, // lrs $ACM0, @acdraw
                0x2efd, // srs @dmbl, $ACM0 and mark mailbox full
                0x0021,
            ],
        );
        let read = system.execute_dsp_instructions(64);
        assert_eq!(read.stop_reason, DspLleStopReason::Halted);
        assert_eq!(system.dsp.dsp_mailbox.to_bits(), 0x8000_007a);

        write_ucode(
            &mut system,
            &[
                0x16c9, 0x0001, // si @dmac, DSP-to-RAM DMEM DMA
                0x16cd, 0x0003, // si @dspa, DMEM word 3
                0x16ce, 0x017f, // si @dsmah, last MEM1 byte
                0x16cf, 0xffff, // si @dsmal, last MEM1 byte
                0x16cb, 0x0004, // si @dsm, start out-of-range DMA
                0x0021,
            ],
        );
        let fault = system.execute_dsp_instructions(64);
        assert_eq!(fault.executed_instructions, 5);
        assert_eq!(fault.transitions.main_ram_write_count, 0);
        assert!(matches!(
            fault.stop_reason,
            DspLleStopReason::BusFault(DspBusFault {
                operation: DspBusOperation::WriteMainRam,
                address: 0x017f_ffff,
                length: 4,
                memory_length,
            }) if memory_length == lazuli_abi::memory::MAIN_RAM_BYTES as u32
        ));
    }

    #[test]
    fn control_writes_preserve_dma_state_reset_and_per_lane_w1c() {
        let mut system = test_system();
        system.dsp.control = Control::from_bits(0x02a8);
        system.write_phys_slow(Address(0x0c00_500a), 0xffff_u16);
        assert_eq!(system.dsp.control.to_bits(), 0x0f57);

        system.dsp.control = Control::from_bits(0x02a8);
        system.write_phys_slow(Address(0x0c00_5008), 0xdead_ffff_u32);
        assert_eq!(system.dsp.control.to_bits(), 0x0f57);

        system.dsp.control = Control::from_bits(0x0aa8);
        system.write_phys_slow(Address(0x0c00_500a), 0x0801_u16);
        assert_eq!(system.dsp.control.to_bits(), 0x0aa9);

        system.dsp.control = Control::from_bits(0x0aa8);
        system.write_phys_slow(Address(0x0c00_500a), 0x00_u8);
        assert_eq!(system.dsp.control.to_bits(), 0x02a8);

        system.dsp.control = Control::from_bits(0x0aa8);
        system.write_phys_slow(Address(0x0c00_500b), 0x01_u8);
        assert_eq!(system.dsp.control.to_bits(), 0x0aa9);

        system.dsp.control = Control::from_bits(0x0aa8);
        system.write_phys_slow(Address(0x0c00_500b), 0xa9_u8);
        assert_eq!(system.dsp.control.to_bits(), 0x0a01);
    }

    fn pattern(length: usize, seed: u8) -> Vec<u8> {
        (0..length)
            .map(|index| seed.wrapping_add((index as u8).wrapping_mul(17)))
            .collect()
    }

    #[test]
    fn resident_aram_dma_masks_registers_and_commits_both_directions_immediately() {
        assert_eq!(ARAM_DMA_GRANULE_BYTES, 32);
        assert_eq!(ARAM_DMA_APERTURE_BYTES, 0x0400_0000);
        assert_eq!(normalize_aram_dma_address(u32::MAX), 0x03ff_ffe0);
        assert_eq!(normalize_aram_dma_count(u32::MAX), 0x83ff_ffe0);
        assert_eq!(aram_dma_completion_cycles(0x40), Ok(492));
        assert_eq!(
            aram_dma_completion_cycles(31),
            Err(AramDmaError::UnalignedLength(31))
        );

        let source = pattern(0x40, 0x31);
        let mut to_aram = test_system();
        to_aram.dsp.aram_dma.write_ram_base(0x13f);
        to_aram.dsp.aram_dma.write_aram_base(0x0400_023f);
        assert_eq!(to_aram.dsp.aram_dma.ram_base, Address(0x120));
        assert_eq!(to_aram.dsp.aram_dma.aram_base, 0x220);
        to_aram.dsp.aram_dma.write_ram_base(0x100);
        to_aram.dsp.aram_dma.write_aram_base(0x200);
        to_aram.mem.ram_mut()[0x100..0x140].copy_from_slice(&source);
        let transfer = match to_aram.start_resident_aram_dma(0x40, 1_000).unwrap() {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        assert_eq!(transfer.direction, AramDmaDirection::FromRamToAram);
        assert_eq!(transfer.effect, AramDmaEffect::InternalAram);
        assert_eq!(transfer.completion_cycle, 1_492);
        assert_eq!(&to_aram.dsp.aram[0x200..0x240], source.as_slice());
        assert_eq!(to_aram.dsp.aram_dma.ram_base, Address(0x140));
        assert_eq!(to_aram.dsp.aram_dma.aram_base, 0x240);
        assert_eq!(to_aram.dsp.aram_dma.control.to_bits(), 0);
        assert!(to_aram.dsp.control.aram_dma_ongoing());
        to_aram.mem.ram_mut()[0x100..0x140].fill(0xee);
        assert_eq!(
            to_aram
                .service_resident_aram_dma(1_491, &mut MachineEventDeadlines::default())
                .unwrap(),
            AramDmaServiceOutcome::BeforeDeadline {
                completion_cycle: 1_492
            }
        );
        assert_eq!(&to_aram.dsp.aram[0x200..0x240], source.as_slice());

        let mut to_mem1 = test_system();
        to_mem1.dsp.aram_dma.write_ram_base(0x100);
        to_mem1.dsp.aram_dma.write_aram_base(0x200);
        to_mem1.dsp.aram[0x200..0x240].copy_from_slice(&source);
        let transfer = match to_mem1
            .start_resident_aram_dma(ARAM_DMA_DIRECTION_TO_MEM1 | 0x40, 1_000)
            .unwrap()
        {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        assert_eq!(transfer.direction, AramDmaDirection::FromAramToRam);
        assert_eq!(&to_mem1.mem.ram()[0x100..0x140], source.as_slice());
        assert_eq!(
            to_mem1.dsp.aram_dma.control.to_bits(),
            ARAM_DMA_DIRECTION_TO_MEM1
        );
        to_mem1.dsp.aram[0x200..0x240].fill(0xdd);
        assert_eq!(&to_mem1.mem.ram()[0x100..0x140], source.as_slice());
    }

    #[test]
    fn resident_aram_dma_wraps_internal_aram_and_ignores_expansion_starts() {
        let source = pattern(0x40, 0x73);
        let mut wrapped = test_system();
        wrapped.dsp.aram_dma.write_ram_base(0x100);
        wrapped.dsp.aram_dma.write_aram_base(0x00ff_ffe0);
        wrapped.mem.ram_mut()[0x100..0x140].copy_from_slice(&source);
        wrapped.start_resident_aram_dma(0x40, 0).unwrap();
        assert_eq!(&wrapped.dsp.aram[0x00ff_ffe0..], &source[..0x20]);
        assert_eq!(&wrapped.dsp.aram[..0x20], &source[0x20..]);
        assert_eq!(wrapped.dsp.aram_dma.aram_base, 0x0100_0020);

        let mut reverse = test_system();
        reverse.dsp.aram_dma.write_ram_base(0x200);
        reverse.dsp.aram_dma.write_aram_base(0x00ff_ffe0);
        reverse.dsp.aram[0x00ff_ffe0..].copy_from_slice(&source[..0x20]);
        reverse.dsp.aram[..0x20].copy_from_slice(&source[0x20..]);
        reverse
            .start_resident_aram_dma(ARAM_DMA_DIRECTION_TO_MEM1 | 0x40, 0)
            .unwrap();
        assert_eq!(&reverse.mem.ram()[0x200..0x240], source.as_slice());

        let ram_sentinel = pattern(0x20, 0x94);
        let aram_sentinel = pattern(0x20, 0xa5);
        for direction in [0, ARAM_DMA_DIRECTION_TO_MEM1] {
            let mut expansion = test_system();
            expansion.dsp.aram_dma.write_ram_base(0x100);
            expansion.dsp.aram_dma.write_aram_base(0x0100_0000);
            expansion.mem.ram_mut()[0x100..0x120].copy_from_slice(&ram_sentinel);
            expansion.dsp.aram[..0x20].copy_from_slice(&aram_sentinel);
            expansion.cpu.reservation.reserve(Address(0x100));
            let transfer = match expansion
                .start_resident_aram_dma(direction | 0x20, 10)
                .unwrap()
            {
                AramDmaStartOutcome::Started(transfer) => transfer,
                AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
            };
            assert_eq!(transfer.effect, AramDmaEffect::ExpansionNoOp);
            assert_eq!(transfer.expansion_no_op_bytes, 0x20);
            assert_eq!(&expansion.mem.ram()[0x100..0x120], ram_sentinel.as_slice());
            assert_eq!(&expansion.dsp.aram[..0x20], aram_sentinel.as_slice());
            assert!(expansion.cpu.reservation.is_valid());
        }

        let mut aperture_wrap = test_system();
        aperture_wrap.dsp.aram_dma.write_aram_base(0x0400_0000);
        assert_eq!(aperture_wrap.dsp.aram_dma.aram_base, 0);
    }

    #[test]
    fn resident_aram_dma_zero_length_and_busy_retrigger_are_exact() {
        let mut zero = test_system();
        zero.dsp.aram_dma.write_ram_base(0x120);
        zero.dsp.aram_dma.write_aram_base(0x220);
        zero.cpu.reservation.reserve(Address(0x120));
        let transfer = match zero.start_resident_aram_dma(0, 1_000).unwrap() {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        assert_eq!(transfer.effect, AramDmaEffect::ZeroLength);
        assert_eq!(transfer.completion_cycle, 1_000);
        assert!(zero.dsp.control.aram_dma_ongoing());
        assert!(zero.cpu.reservation.is_valid());
        let mut deadlines = MachineEventDeadlines::default();
        zero.publish_resident_aram_dma_deadline(&mut deadlines);
        assert_eq!(
            deadlines.deadline(MachineEventKind::AramDmaCompletion),
            Some(1_000)
        );
        assert!(matches!(
            zero.service_resident_aram_dma(1_000, &mut deadlines),
            Ok(AramDmaServiceOutcome::Completed { .. })
        ));
        assert!(!zero.dsp.control.aram_dma_ongoing());
        assert!(zero.dsp.control.aram_dma_interrupt());
        assert_eq!(zero.dsp.aram_dma.completions(), 1);
        assert_eq!(zero.dsp.aram_dma.interrupt_assertions(), 1);

        let mut busy = test_system();
        busy.dsp.aram_dma.write_ram_base(0x100);
        busy.dsp.aram_dma.write_aram_base(0x200);
        let accepted = match busy.start_resident_aram_dma(0x20, 1_000).unwrap() {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        let registers = (
            busy.dsp.aram_dma.ram_base,
            busy.dsp.aram_dma.aram_base,
            busy.dsp.aram_dma.control.to_bits(),
        );
        let rejection = match busy
            .start_resident_aram_dma(ARAM_DMA_DIRECTION_TO_MEM1 | 0x20, 1_010)
            .unwrap()
        {
            AramDmaStartOutcome::Started(_) => panic!("busy ARAM DMA retriggered"),
            AramDmaStartOutcome::Busy(rejection) => rejection,
        };
        assert_eq!(rejection.preserved_completion_cycle, Some(1_246));
        assert_eq!(busy.dsp.aram_dma.pending(), Some(accepted));
        assert_eq!(
            (
                busy.dsp.aram_dma.ram_base,
                busy.dsp.aram_dma.aram_base,
                busy.dsp.aram_dma.control.to_bits(),
            ),
            registers
        );
        assert_eq!(busy.dsp.aram_dma.busy_retrigger_rejections(), 1);
    }

    #[test]
    fn resident_aram_dma_mem1_prefix_and_reservation_effects_match_oracle() {
        let ram_end = lazuli_abi::memory::MAIN_RAM_BYTES;
        let ram_start = ram_end - 0x20;
        let valid = pattern(0x20, 0x1c);
        let mut to_aram = test_system();
        to_aram.dsp.aram_dma.write_ram_base(ram_start as u32);
        to_aram.dsp.aram_dma.write_aram_base(0x200);
        to_aram.mem.ram_mut()[ram_start..ram_end].copy_from_slice(&valid);
        to_aram.dsp.aram[0x200..0x240].fill(0xff);
        let transfer = match to_aram.start_resident_aram_dma(0x40, 0).unwrap() {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        assert_eq!(&to_aram.dsp.aram[0x200..0x220], valid.as_slice());
        assert_eq!(&to_aram.dsp.aram[0x220..0x240], &[0; 0x20]);
        assert_eq!(transfer.valid_mem1_bytes, 0x20);
        assert_eq!(transfer.zero_source_bytes, 0x20);

        let source = pattern(0x40, 0x2d);
        let mut to_mem1 = test_system();
        to_mem1.dsp.aram_dma.write_ram_base(ram_start as u32);
        to_mem1.dsp.aram_dma.write_aram_base(0x300);
        to_mem1.dsp.aram[0x300..0x340].copy_from_slice(&source);
        to_mem1.cpu.reservation.reserve(Address(ram_start as u32));
        let transfer = match to_mem1
            .start_resident_aram_dma(ARAM_DMA_DIRECTION_TO_MEM1 | 0x40, 0)
            .unwrap()
        {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        assert_eq!(&to_mem1.mem.ram()[ram_start..ram_end], &source[..0x20]);
        assert_eq!(transfer.ignored_destination_bytes, 0x20);
        assert_eq!(
            transfer.mem1_write,
            Some(AramDmaMem1Write {
                address: Address(ram_start as u32),
                length: 0x20,
            })
        );
        assert!(transfer.reservation_invalidated);
        assert!(!to_mem1.cpu.reservation.is_valid());

        let mut adjacent = test_system();
        adjacent.dsp.aram_dma.write_ram_base(0x120);
        adjacent.dsp.aram_dma.write_aram_base(0x200);
        adjacent.cpu.reservation.reserve(Address(0x140));
        let transfer = match adjacent
            .start_resident_aram_dma(ARAM_DMA_DIRECTION_TO_MEM1 | 0x20, 0)
            .unwrap()
        {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        assert!(!transfer.reservation_invalidated);
        assert!(adjacent.cpu.reservation.is_valid());
    }

    #[test]
    fn resident_aram_dma_deadline_arint_mask_and_w1c_are_level_exact() {
        let mut system = test_system();
        system.dsp.aram_dma.write_ram_base(0x100);
        system.dsp.aram_dma.write_aram_base(0x200);
        system.start_resident_aram_dma(0x20, 1_000).unwrap();
        let mut deadlines = MachineEventDeadlines::default();
        system.publish_resident_aram_dma_deadline(&mut deadlines);
        assert_eq!(
            deadlines.deadline(MachineEventKind::AramDmaCompletion),
            Some(1_246)
        );
        assert_eq!(
            system
                .service_resident_aram_dma(1_245, &mut deadlines)
                .unwrap(),
            AramDmaServiceOutcome::BeforeDeadline {
                completion_cycle: 1_246
            }
        );
        assert!(system.dsp.control.aram_dma_ongoing());
        assert!(!system.dsp.control.aram_dma_interrupt());
        assert!(!system.dsp.control.any_interrupt());

        assert!(matches!(
            system.service_resident_aram_dma(1_246, &mut deadlines),
            Ok(AramDmaServiceOutcome::Completed { .. })
        ));
        assert!(!system.dsp.control.aram_dma_ongoing());
        assert!(system.dsp.control.aram_dma_interrupt());
        assert!(!system.dsp.control.any_interrupt());
        assert_eq!(
            deadlines.deadline(MachineEventKind::AramDmaCompletion),
            None
        );

        write_control_masked(&mut system, Control::from_bits(0x0040), u16::MAX);
        assert_eq!(system.dsp.control.to_bits() & 0x0060, 0x0060);
        assert!(system.dsp.control.any_interrupt());
        write_control_masked(&mut system, Control::from_bits(0x0060), u16::MAX);
        assert_eq!(system.dsp.control.to_bits() & 0x0060, 0x0040);
        assert!(!system.dsp.control.any_interrupt());

        assert!(matches!(
            system.service_resident_aram_dma(1_245, &mut deadlines),
            Err(AramDmaError::NonMonotonicCycle { .. })
        ));
    }

    #[test]
    fn resident_aram_dma_deadline_overflow_is_rejected_before_guest_mutation() {
        let mut system = test_system();
        system.dsp.aram_dma.write_ram_base(0x100);
        system.dsp.aram_dma.write_aram_base(0x200);
        system.mem.ram_mut()[0x100..0x120].fill(0xaa);
        system.dsp.aram[0x200..0x220].fill(0x55);
        assert_eq!(
            system.start_resident_aram_dma(0x20, u64::MAX),
            Err(AramDmaError::DeadlineOverflow)
        );
        assert_eq!(&system.dsp.aram[0x200..0x220], &[0x55; 0x20]);
        assert_eq!(system.dsp.aram_dma.ram_base, Address(0x100));
        assert_eq!(system.dsp.aram_dma.aram_base, 0x200);
        assert!(!system.dsp.control.aram_dma_ongoing());
        assert_eq!(system.dsp.aram_dma.pending(), None);
    }

    #[test]
    fn resident_aram_dma_maximum_aperture_is_allocation_free_and_bounded() {
        let mut system = test_system();
        system.dsp.aram_dma.write_ram_base(0x0200_0000);
        system.dsp.aram_dma.write_aram_base(0);
        system.dsp.aram.fill(0xa5);
        let transfer = match system
            .start_resident_aram_dma(ARAM_DMA_LENGTH_MASK, 0)
            .unwrap()
        {
            AramDmaStartOutcome::Started(transfer) => transfer,
            AramDmaStartOutcome::Busy(_) => panic!("new ARAM DMA was busy"),
        };
        assert_eq!(transfer.length, ARAM_DMA_LENGTH_MASK);
        assert_eq!(transfer.valid_mem1_bytes, 0);
        assert_eq!(transfer.zero_source_bytes, ARAM_DMA_LENGTH_MASK);
        assert_eq!(
            transfer.completion_cycle,
            aram_dma_completion_cycles(ARAM_DMA_LENGTH_MASK).unwrap()
        );
        assert!(system.dsp.aram.iter().all(|byte| *byte == 0));
        assert_eq!(system.dsp.aram_dma.starts(), 1);
        assert_eq!(system.dsp.aram_dma.pending(), Some(transfer));
    }

    #[test]
    fn resident_dsp_phase_services_aid_aram_then_lle_and_publishes_all_deadlines() {
        let mut system = test_system();
        system
            .audio
            .write_dsp_audio_dma_control_at(crate::system::ai::DmaControl::from_bits(0x8000), 568)
            .unwrap();
        system.dsp.aram_dma.write_ram_base(0x100);
        system.dsp.aram_dma.write_aram_base(0x200);
        system.start_resident_aram_dma(0, 768).unwrap();

        let mut deadlines = MachineEventDeadlines::default();
        let summary = system.service_resident_dsp(768, &mut deadlines).unwrap();
        assert_eq!(summary.audio_dma.initial_interrupts, 1);
        assert_eq!(summary.audio_dma.blocks, 0);
        assert!(matches!(
            summary.aram_dma,
            AramDmaServiceOutcome::Completed {
                completion_cycle: 768,
                serviced_at_cycle: 768,
            }
        ));
        assert!(matches!(
            summary.interpreter,
            DspLleServiceOutcome::Executed(DspLleSlice {
                observed_cycle: 768,
                ..
            })
        ));
        assert!(system.dsp.control.ai_dma_interrupt());
        assert!(system.dsp.control.aram_dma_interrupt());
        assert_eq!(
            deadlines.deadline(MachineEventKind::DspAudioDmaInterrupt),
            None
        );
        assert_eq!(
            deadlines.deadline(MachineEventKind::AramDmaCompletion),
            None
        );
        assert_eq!(
            deadlines.deadline(MachineEventKind::DspExecution),
            Some(1_536)
        );
    }
}
