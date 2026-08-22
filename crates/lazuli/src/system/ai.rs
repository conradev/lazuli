//! Audio interface (AI).
use bitos::integer::u15;
use bitos::{BitUtils, bitos};
use gekko::Address;
use zerocopy::{FromBytes, Immutable, IntoBytes};

use crate::system::scheduler::{HandlerCtx, MachineEventDeadlines, MachineEventKind};
use crate::system::{System, pi};

/// Measured AI/AID clocks used by the browser compatibility baseline.
pub const SAMPLE_RATE_48_KHZ: u32 = 48_043;
pub const SAMPLE_RATE_32_KHZ: u32 = 32_029;
/// AID asserts its initial block request this many CPU cycles after enable.
pub const DSP_AUDIO_DMA_ENABLE_INTERRUPT_LATENCY_CYCLES: u64 = 200;
/// A bounded service cannot be made to loop forever by an untrusted cycle jump.
pub const MAX_DSP_AUDIO_DMA_BLOCKS_PER_SERVICE: u64 = 1 << 20;

// The rates are coprime. Scaling absolute AI time by their product lets both rates preserve the
// browser's exact fractional `aiLastCycle` without floats, rounding, or a phase reset on a rate
// change.
const AI_TIME_TICKS_PER_CPU_CYCLE: u128 = SAMPLE_RATE_48_KHZ as u128 * SAMPLE_RATE_32_KHZ as u128;

#[inline]
const fn ceil_div_u128(numerator: u128, denominator: u128) -> u128 {
    numerator / denominator + (!numerator.is_multiple_of(denominator)) as u128
}

#[bitos(1)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleRate {
    KHz48 = 0,
    KHz32 = 1,
}

impl SampleRate {
    /// Exact hardware-compatible rate used by the resident timing model.
    pub const fn value(self) -> u32 {
        match self {
            Self::KHz48 => SAMPLE_RATE_48_KHZ,
            Self::KHz32 => SAMPLE_RATE_32_KHZ,
        }
    }

    pub fn cycles_per_frame(self) -> u64 {
        gekko::FREQUENCY / self.value() as u64
    }

    /// Browser-compatible fixed AID block period: `ceil(8 * 486 MHz / rate)`.
    pub fn cycles_per_block(self) -> u64 {
        (8 * gekko::FREQUENCY).div_ceil(self.value() as u64)
    }

    const fn ai_period_ticks(self) -> u128 {
        gekko::FREQUENCY as u128 * (AI_TIME_TICKS_PER_CPU_CYCLE / self.value() as u128)
    }
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Control {
    #[bits(0)]
    pub playing: bool,
    #[bits(1)]
    pub aux_sample_rate: SampleRate,
    #[bits(2)]
    pub interrupt_enabled: bool,
    #[bits(3)]
    pub interrupt: bool,
    #[bits(4)]
    pub interrupt_valid: bool,
    #[bits(5)]
    pub sample_counter_reset: bool,
    #[bits(6)]
    pub dsp_sample_rate: SampleRate,
}

impl Control {
    /// AISFR has the opposite polarity from AIDFR: one selects 48,043 Hz, zero 32,029 Hz.
    pub fn effective_aux_sample_rate(self) -> SampleRate {
        match self.aux_sample_rate() {
            SampleRate::KHz48 => SampleRate::KHz32,
            SampleRate::KHz32 => SampleRate::KHz48,
        }
    }
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default)]
pub struct DmaControl {
    #[bits(0..15)]
    pub length_by_32: u15,
    #[bits(15)]
    pub playing: bool,
}

/// Exact, host-neutral AI/AID service failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentAudioError {
    NonMonotonicCycle {
        observed_cycle: u64,
        last_observed_cycle: u64,
    },
    DeadlineOverflow,
    CounterOverflow,
    DspAudioDmaCatchUpLimit {
        due_blocks: u64,
        limit: u64,
    },
    InconsistentDspAudioDmaState {
        remaining_blocks: u16,
        next_block_cycle: Option<u64>,
    },
}

/// One AI sample-counter service, including wrap-safe interrupt evidence.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AiServiceSummary {
    pub samples: u64,
    pub interrupt_asserted: bool,
    pub interrupt_active: bool,
    pub last_sample_cycle_floor: u64,
}

/// One DSP AID service. Audio payload publication remains a synchronous Rust concern; this is
/// the timing/accounting result needed by the resident dispatcher and a thin future adapter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DspAudioDmaServiceSummary {
    pub initial_interrupts: u64,
    pub blocks: u64,
    pub completions: u64,
    pub interrupt_active: bool,
    pub last_block_cycle: Option<u64>,
}

/// Integer-only AI phase and evidence retained inside the machine.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResidentAiTiming {
    last_sample_ticks: u128,
    last_observed_cycle: u64,
    serviced_samples: u64,
    interrupt_assertions: u64,
}

impl ResidentAiTiming {
    #[must_use]
    pub const fn last_observed_cycle(&self) -> u64 {
        self.last_observed_cycle
    }

    #[must_use]
    pub const fn serviced_samples(&self) -> u64 {
        self.serviced_samples
    }

    #[must_use]
    pub const fn interrupt_assertions(&self) -> u64 {
        self.interrupt_assertions
    }

    #[must_use]
    pub fn last_sample_cycle_floor(&self) -> u64 {
        (self.last_sample_ticks / AI_TIME_TICKS_PER_CPU_CYCLE) as u64
    }

    fn observe(&mut self, observed_cycle: u64) -> Result<(), ResidentAudioError> {
        if observed_cycle < self.last_observed_cycle {
            return Err(ResidentAudioError::NonMonotonicCycle {
                observed_cycle,
                last_observed_cycle: self.last_observed_cycle,
            });
        }
        self.last_observed_cycle = observed_cycle;
        Ok(())
    }

    fn anchor(&mut self, observed_cycle: u64) {
        self.last_sample_ticks = u128::from(observed_cycle) * AI_TIME_TICKS_PER_CPU_CYCLE;
        self.last_observed_cycle = observed_cycle;
    }

    fn deadline_for_tick(tick: u128) -> Result<u64, ResidentAudioError> {
        u64::try_from(ceil_div_u128(tick, AI_TIME_TICKS_PER_CPU_CYCLE))
            .map_err(|_| ResidentAudioError::DeadlineOverflow)
    }
}

/// Fixed DSP AID recurrence and evidence retained inside the machine.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResidentDspAudioDmaTiming {
    remaining_blocks: u16,
    next_block_cycle: Option<u64>,
    next_interrupt_cycle: Option<u64>,
    starts: u64,
    stops: u64,
    serviced_blocks: u64,
    completions: u64,
    interrupt_assertions: u64,
    last_observed_cycle: u64,
}

impl ResidentDspAudioDmaTiming {
    #[must_use]
    pub const fn remaining_blocks(&self) -> u16 {
        self.remaining_blocks
    }

    #[must_use]
    pub const fn blocks_left(&self) -> u16 {
        self.remaining_blocks.saturating_sub(1)
    }

    #[must_use]
    pub const fn next_block_cycle(&self) -> Option<u64> {
        self.next_block_cycle
    }

    #[must_use]
    pub const fn next_interrupt_cycle(&self) -> Option<u64> {
        self.next_interrupt_cycle
    }

    #[must_use]
    pub const fn starts(&self) -> u64 {
        self.starts
    }

    #[must_use]
    pub const fn stops(&self) -> u64 {
        self.stops
    }

    #[must_use]
    pub const fn serviced_blocks(&self) -> u64 {
        self.serviced_blocks
    }

    #[must_use]
    pub const fn completions(&self) -> u64 {
        self.completions
    }

    #[must_use]
    pub const fn interrupt_assertions(&self) -> u64 {
        self.interrupt_assertions
    }

    #[must_use]
    pub const fn last_observed_cycle(&self) -> u64 {
        self.last_observed_cycle
    }

    fn observe(&mut self, observed_cycle: u64) -> Result<(), ResidentAudioError> {
        if observed_cycle < self.last_observed_cycle {
            return Err(ResidentAudioError::NonMonotonicCycle {
                observed_cycle,
                last_observed_cycle: self.last_observed_cycle,
            });
        }
        self.last_observed_cycle = observed_cycle;
        Ok(())
    }
}

pub struct Interface {
    pub control: Control,
    pub dma_base: Address,
    pub dma_control: DmaControl,
    pub current_dma_block: u16,
    pub sample_counter: u32,
    pub interrupt_sample: u32,
    pub resident_ai: ResidentAiTiming,
    pub resident_dsp_audio_dma: ResidentDspAudioDmaTiming,
}

impl Default for Interface {
    fn default() -> Self {
        Self {
            control: Control::default(),
            dma_base: Address(0),
            dma_control: DmaControl::default(),
            current_dma_block: 0,
            sample_counter: 0,
            interrupt_sample: 0,
            resident_ai: ResidentAiTiming::default(),
            resident_dsp_audio_dma: ResidentDspAudioDmaTiming::default(),
        }
    }
}

impl Interface {
    pub fn write_control(&mut self, value: Control) {
        self.control.set_playing(value.playing());
        self.control.set_aux_sample_rate(value.aux_sample_rate());
        self.control
            .set_interrupt_enabled(value.interrupt_enabled());
        self.control
            .set_interrupt(self.control.interrupt() & !value.interrupt());
        self.control.set_interrupt_valid(value.interrupt_valid());

        if value.sample_counter_reset() {
            self.sample_counter = 0;
        }

        self.control.set_dsp_sample_rate(value.dsp_sample_rate());
    }

    fn next_ai_sample_cycle(&self) -> Result<Option<u64>, ResidentAudioError> {
        if !self.control.playing() {
            return Ok(None);
        }
        let tick = self
            .resident_ai
            .last_sample_ticks
            .checked_add(self.control.effective_aux_sample_rate().ai_period_ticks())
            .ok_or(ResidentAudioError::DeadlineOverflow)?;
        ResidentAiTiming::deadline_for_tick(tick).map(Some)
    }

    fn next_ai_interrupt_cycle(&self) -> Result<Option<u64>, ResidentAudioError> {
        if !self.control.playing() || self.control.interrupt() {
            return Ok(None);
        }
        let mut samples = u64::from(self.interrupt_sample.wrapping_sub(self.sample_counter));
        if samples == 0 {
            samples = 1_u64 << 32;
        }
        let ticks = self
            .control
            .effective_aux_sample_rate()
            .ai_period_ticks()
            .checked_mul(u128::from(samples))
            .and_then(|ticks| self.resident_ai.last_sample_ticks.checked_add(ticks))
            .ok_or(ResidentAudioError::DeadlineOverflow)?;
        ResidentAiTiming::deadline_for_tick(ticks).map(Some)
    }

    pub fn next_dsp_audio_dma_completion_cycle(&self) -> Result<Option<u64>, ResidentAudioError> {
        let Some(next) = self.resident_dsp_audio_dma.next_block_cycle else {
            return Ok(None);
        };
        if self.resident_dsp_audio_dma.remaining_blocks == 0 {
            return Ok(None);
        }
        let remaining_after_next = u64::from(self.resident_dsp_audio_dma.remaining_blocks - 1);
        let tail = self
            .control
            .dsp_sample_rate()
            .cycles_per_block()
            .checked_mul(remaining_after_next)
            .ok_or(ResidentAudioError::DeadlineOverflow)?;
        next.checked_add(tail)
            .map(Some)
            .ok_or(ResidentAudioError::DeadlineOverflow)
    }

    /// Publishes exact transitions and idle-only projections into the fixed resident set.
    pub fn publish_resident_deadlines(
        &self,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<(), ResidentAudioError> {
        deadlines.set(MachineEventKind::AiSample, self.next_ai_sample_cycle()?);
        deadlines.set(
            MachineEventKind::AiInterrupt,
            self.next_ai_interrupt_cycle()?,
        );
        deadlines.set(
            MachineEventKind::DspAudioDmaInterrupt,
            self.resident_dsp_audio_dma.next_interrupt_cycle,
        );
        deadlines.set(
            MachineEventKind::DspAudioDmaBlock,
            self.resident_dsp_audio_dma.next_block_cycle,
        );
        deadlines.set(
            MachineEventKind::DspAudioDmaCompletion,
            self.next_dsp_audio_dma_completion_cycle()?,
        );
        Ok(())
    }

    /// Advances the AI counter through every sample due at `observed_cycle` in one exact batch.
    pub fn service_resident_ai(
        &mut self,
        observed_cycle: u64,
    ) -> Result<AiServiceSummary, ResidentAudioError> {
        self.resident_ai.observe(observed_cycle)?;
        if !self.control.playing() {
            return Ok(AiServiceSummary {
                interrupt_active: self.control.interrupt() && self.control.interrupt_enabled(),
                last_sample_cycle_floor: self.resident_ai.last_sample_cycle_floor(),
                ..AiServiceSummary::default()
            });
        }

        let observed_ticks = u128::from(observed_cycle) * AI_TIME_TICKS_PER_CPU_CYCLE;
        let elapsed_ticks = observed_ticks
            .checked_sub(self.resident_ai.last_sample_ticks)
            .ok_or(ResidentAudioError::NonMonotonicCycle {
                observed_cycle,
                last_observed_cycle: self.resident_ai.last_sample_cycle_floor(),
            })?;
        let period = self.control.effective_aux_sample_rate().ai_period_ticks();
        let samples = u64::try_from(elapsed_ticks / period)
            .map_err(|_| ResidentAudioError::CounterOverflow)?;
        if samples == 0 {
            return Ok(AiServiceSummary {
                interrupt_active: self.control.interrupt() && self.control.interrupt_enabled(),
                last_sample_cycle_floor: self.resident_ai.last_sample_cycle_floor(),
                ..AiServiceSummary::default()
            });
        }

        let serviced_samples = self
            .resident_ai
            .serviced_samples
            .checked_add(samples)
            .ok_or(ResidentAudioError::CounterOverflow)?;
        let old_counter = self.sample_counter;
        let new_counter = old_counter.wrapping_add(samples as u32);
        let first_new_sample = old_counter.wrapping_add(1);
        let interrupt_asserted = self.interrupt_sample.wrapping_sub(first_new_sample)
            <= new_counter.wrapping_sub(first_new_sample);
        let interrupt_assertions = self
            .resident_ai
            .interrupt_assertions
            .checked_add(u64::from(interrupt_asserted))
            .ok_or(ResidentAudioError::CounterOverflow)?;
        let advanced = period
            .checked_mul(u128::from(samples))
            .and_then(|ticks| self.resident_ai.last_sample_ticks.checked_add(ticks))
            .ok_or(ResidentAudioError::DeadlineOverflow)?;

        self.resident_ai.last_sample_ticks = advanced;
        self.resident_ai.serviced_samples = serviced_samples;
        self.resident_ai.interrupt_assertions = interrupt_assertions;
        self.sample_counter = new_counter;
        if interrupt_asserted {
            self.control.set_interrupt(true);
        }
        Ok(AiServiceSummary {
            samples,
            interrupt_asserted,
            interrupt_active: self.control.interrupt() && self.control.interrupt_enabled(),
            last_sample_cycle_floor: self.resident_ai.last_sample_cycle_floor(),
        })
    }

    /// Synchronizes AI before applying its W1C/reset/rate/play control write.
    pub fn write_control_at(
        &mut self,
        value: Control,
        observed_cycle: u64,
    ) -> Result<AiServiceSummary, ResidentAudioError> {
        self.write_control_masked_at(value, u32::MAX, observed_cycle)
    }

    /// Synchronizes AI before applying one potentially partial AISCR write.
    ///
    /// `written_mask` names the register bits covered by the scalar store. Interrupt status is
    /// W1C only in covered lanes, writable state outside those lanes is retained, and AISCNT
    /// reset remains a write action rather than stored state.
    pub fn write_control_masked_at(
        &mut self,
        value: Control,
        written_mask: u32,
        observed_cycle: u64,
    ) -> Result<AiServiceSummary, ResidentAudioError> {
        const INTERRUPT_STATUS: u32 = 0x0000_0008;
        const WRITABLE_STATE: u32 = 0x0000_0057;
        const SAMPLE_COUNTER_RESET: u32 = 0x0000_0020;

        let summary = self.service_resident_ai(observed_cycle)?;
        let was_playing = self.control.playing();
        let current = self.control.to_bits();
        let written = value.to_bits();
        let status = (current & INTERRUPT_STATUS) & !(written & written_mask & INTERRUPT_STATUS);
        let guest_control =
            (current & WRITABLE_STATE & !written_mask) | (written & WRITABLE_STATE & written_mask);
        self.control = Control::from_bits(guest_control | status);
        let reset = written & written_mask & SAMPLE_COUNTER_RESET != 0;
        if reset {
            self.sample_counter = 0;
        }
        if was_playing != self.control.playing() || reset {
            self.resident_ai.anchor(observed_cycle);
        }
        Ok(summary)
    }

    /// Direct AISCNT writes establish a new exact sample-phase anchor.
    pub fn write_sample_counter_at(
        &mut self,
        value: u32,
        observed_cycle: u64,
    ) -> Result<(), ResidentAudioError> {
        self.write_sample_counter_masked_at(value, u32::MAX, observed_cycle)
    }

    /// Synchronizes AI before merging one potentially partial AISCNT write and reanchoring its
    /// exact sample phase at the accepted instruction-start cycle.
    pub fn write_sample_counter_masked_at(
        &mut self,
        value: u32,
        written_mask: u32,
        observed_cycle: u64,
    ) -> Result<(), ResidentAudioError> {
        self.service_resident_ai(observed_cycle)?;
        self.sample_counter = (self.sample_counter & !written_mask) | (value & written_mask);
        self.resident_ai.anchor(observed_cycle);
        Ok(())
    }

    /// Synchronizes AI before merging one potentially partial AIIT write. Updating the target
    /// does not reset the running sample phase.
    pub fn write_interrupt_sample_masked_at(
        &mut self,
        value: u32,
        written_mask: u32,
        observed_cycle: u64,
    ) -> Result<(), ResidentAudioError> {
        self.service_resident_ai(observed_cycle)?;
        self.interrupt_sample = (self.interrupt_sample & !written_mask) | (value & written_mask);
        Ok(())
    }

    /// Applies the AID control edge without scheduling a legacy callback.
    pub fn write_dsp_audio_dma_control_at(
        &mut self,
        value: DmaControl,
        observed_cycle: u64,
    ) -> Result<(), ResidentAudioError> {
        self.write_dsp_audio_dma_control_masked_at(value, u16::MAX, observed_cycle)
    }

    /// Applies one potentially partial AID control edge without scheduling a legacy callback.
    pub fn write_dsp_audio_dma_control_masked_at(
        &mut self,
        value: DmaControl,
        written_mask: u16,
        observed_cycle: u64,
    ) -> Result<(), ResidentAudioError> {
        self.resident_dsp_audio_dma.observe(observed_cycle)?;
        let value = DmaControl::from_bits(
            (self.dma_control.to_bits() & !written_mask) | (value.to_bits() & written_mask),
        );
        let was_enabled = self.dma_control.playing();
        let enabled = value.playing();
        let remaining = value.length_by_32().value();

        let next_interrupt_cycle = (!was_enabled && enabled)
            .then(|| {
                observed_cycle
                    .checked_add(DSP_AUDIO_DMA_ENABLE_INTERRUPT_LATENCY_CYCLES)
                    .ok_or(ResidentAudioError::DeadlineOverflow)
            })
            .transpose()?;
        let next_block_cycle = (!was_enabled && enabled && remaining != 0)
            .then(|| {
                observed_cycle
                    .checked_add(self.control.dsp_sample_rate().cycles_per_block())
                    .ok_or(ResidentAudioError::DeadlineOverflow)
            })
            .transpose()?;

        let next_starts = self
            .resident_dsp_audio_dma
            .starts
            .checked_add(u64::from(!was_enabled && enabled))
            .ok_or(ResidentAudioError::CounterOverflow)?;
        let next_stops = self
            .resident_dsp_audio_dma
            .stops
            .checked_add(u64::from(was_enabled && !enabled))
            .ok_or(ResidentAudioError::CounterOverflow)?;
        self.dma_control = value;
        self.resident_dsp_audio_dma.starts = next_starts;
        self.resident_dsp_audio_dma.stops = next_stops;
        if !was_enabled && enabled {
            self.resident_dsp_audio_dma.remaining_blocks = remaining;
            self.resident_dsp_audio_dma.next_block_cycle = next_block_cycle;
            self.resident_dsp_audio_dma.next_interrupt_cycle = next_interrupt_cycle;
            self.current_dma_block = 0;
        } else if was_enabled && !enabled {
            self.resident_dsp_audio_dma.remaining_blocks = 0;
            self.resident_dsp_audio_dma.next_block_cycle = None;
            self.resident_dsp_audio_dma.next_interrupt_cycle = None;
            self.current_dma_block = 0;
        }
        Ok(())
    }

    /// Drains the browser-authenticated AID interrupt/block order at one observed cycle.
    pub fn service_resident_dsp_audio_dma(
        &mut self,
        observed_cycle: u64,
    ) -> Result<DspAudioDmaServiceSummary, ResidentAudioError> {
        self.resident_dsp_audio_dma.observe(observed_cycle)?;
        let initial_due = self
            .resident_dsp_audio_dma
            .next_interrupt_cycle
            .is_some_and(|deadline| deadline <= observed_cycle);
        let period = self.control.dsp_sample_rate().cycles_per_block();
        let scheduled_due_blocks = self
            .resident_dsp_audio_dma
            .next_block_cycle
            .filter(|deadline| *deadline <= observed_cycle)
            .map_or(0, |deadline| 1 + (observed_cycle - deadline) / period);
        // An enabled-to-enabled rewrite may set the next reload length to zero. In that case the
        // accepted in-flight buffer still completes, then recurrence stops; do not reject a huge
        // observed-cycle jump based on block events that can no longer occur.
        let due_blocks = if self.dma_control.length_by_32().value() == 0 {
            scheduled_due_blocks.min(u64::from(self.resident_dsp_audio_dma.remaining_blocks))
        } else {
            scheduled_due_blocks
        };
        if due_blocks > MAX_DSP_AUDIO_DMA_BLOCKS_PER_SERVICE {
            return Err(ResidentAudioError::DspAudioDmaCatchUpLimit {
                due_blocks,
                limit: MAX_DSP_AUDIO_DMA_BLOCKS_PER_SERVICE,
            });
        }

        let mut summary = DspAudioDmaServiceSummary::default();
        if initial_due {
            self.resident_dsp_audio_dma.next_interrupt_cycle = None;
            summary.initial_interrupts = 1;
        }

        while let Some(event_cycle) = self.resident_dsp_audio_dma.next_block_cycle {
            if event_cycle > observed_cycle {
                break;
            }
            if self.resident_dsp_audio_dma.remaining_blocks == 0 {
                return Err(ResidentAudioError::InconsistentDspAudioDmaState {
                    remaining_blocks: 0,
                    next_block_cycle: Some(event_cycle),
                });
            }
            self.resident_dsp_audio_dma.remaining_blocks -= 1;
            self.current_dma_block = self.current_dma_block.wrapping_add(1);
            summary.blocks = summary
                .blocks
                .checked_add(1)
                .ok_or(ResidentAudioError::CounterOverflow)?;
            summary.last_block_cycle = Some(event_cycle);

            if self.resident_dsp_audio_dma.remaining_blocks == 0 {
                summary.completions = summary
                    .completions
                    .checked_add(1)
                    .ok_or(ResidentAudioError::CounterOverflow)?;
                self.resident_dsp_audio_dma.remaining_blocks =
                    self.dma_control.length_by_32().value();
                self.current_dma_block = 0;
            }

            self.resident_dsp_audio_dma.next_block_cycle = if self.dma_control.playing()
                && self.resident_dsp_audio_dma.remaining_blocks != 0
            {
                Some(
                    event_cycle
                        .checked_add(period)
                        .ok_or(ResidentAudioError::DeadlineOverflow)?,
                )
            } else {
                None
            };
        }

        let assertions = summary
            .initial_interrupts
            .checked_add(summary.completions)
            .ok_or(ResidentAudioError::CounterOverflow)?;
        self.resident_dsp_audio_dma.interrupt_assertions = self
            .resident_dsp_audio_dma
            .interrupt_assertions
            .checked_add(assertions)
            .ok_or(ResidentAudioError::CounterOverflow)?;
        self.resident_dsp_audio_dma.serviced_blocks = self
            .resident_dsp_audio_dma
            .serviced_blocks
            .checked_add(summary.blocks)
            .ok_or(ResidentAudioError::CounterOverflow)?;
        self.resident_dsp_audio_dma.completions = self
            .resident_dsp_audio_dma
            .completions
            .checked_add(summary.completions)
            .ok_or(ResidentAudioError::CounterOverflow)?;
        summary.interrupt_active = assertions != 0;
        Ok(summary)
    }
}

impl System {
    /// Services the Rust-owned AI phase and republishes its exact deadlines.
    pub fn service_resident_audio_interface(
        &mut self,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<AiServiceSummary, ResidentAudioError> {
        let summary = self.audio.service_resident_ai(observed_cycle)?;
        self.audio.publish_resident_deadlines(deadlines)?;
        pi::check_interrupts(self);
        Ok(summary)
    }

    /// Services the Rust-owned DSP AID phase, latches AID status, and republishes deadlines.
    pub fn service_resident_dsp_audio_dma(
        &mut self,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<DspAudioDmaServiceSummary, ResidentAudioError> {
        let mut summary = self.audio.service_resident_dsp_audio_dma(observed_cycle)?;
        if summary.initial_interrupts != 0 || summary.completions != 0 {
            self.dsp.control.set_ai_dma_interrupt(true);
        }
        summary.interrupt_active = self.dsp.control.any_interrupt();
        self.audio.publish_resident_deadlines(deadlines)?;
        pi::check_interrupts(self);
        Ok(summary)
    }

    /// Publishes AI and AID deadlines without consulting a host clock or browser state.
    pub fn publish_resident_audio_deadlines(
        &self,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<(), ResidentAudioError> {
        self.audio.publish_resident_deadlines(deadlines)
    }
}

fn push_streaming_frame(sys: &mut System, ctx: HandlerCtx) {
    sys.audio.sample_counter += 1;
    if sys.audio.control.interrupt_valid() && sys.audio.sample_counter == sys.audio.interrupt_sample
    {
        println!("raising sample counter int");
        sys.audio.control.set_interrupt(true);
        pi::check_interrupts(sys);
    }

    sys.scheduler.schedule_full(
        sys.audio
            .control
            .effective_aux_sample_rate()
            .cycles_per_frame()
            - ctx.cycles_late.value(),
        self::push_streaming_frame,
    );
}

pub fn start_streaming(sys: &mut System) {
    if !sys.scheduler.contains_full(self::push_streaming_frame) {
        sys.scheduler.schedule_full(
            sys.audio
                .control
                .effective_aux_sample_rate()
                .cycles_per_frame(),
            self::push_streaming_frame,
        );
    }
}

pub fn stop_streaming(sys: &mut System) {
    sys.scheduler.cancel_full(self::push_streaming_frame);
}

#[derive(Debug, Clone, Copy, Default, IntoBytes, FromBytes, Immutable)]
#[repr(C)]
pub struct Frame {
    pub left: i16,
    pub right: i16,
}

fn push_data_dma_block(sys: &mut System, ctx: HandlerCtx) {
    let addr =
        Address(sys.audio.dma_base.0.with_bit(31, false)) + 32 * sys.audio.current_dma_block as u32;
    let frames: [Frame; 8] = std::array::from_fn(|i| Frame {
        left: sys.read_phys_slow::<i16>(addr + 4 * i as u32 + 2),
        right: sys.read_phys_slow::<i16>(addr + 4 * i as u32),
    });

    for frame in frames {
        sys.modules.audio.play(frame);
    }

    sys.audio.current_dma_block += 1;

    let total_blocks = sys.audio.dma_control.length_by_32().value();
    if sys.audio.current_dma_block >= total_blocks {
        sys.dsp.control.set_ai_dma_interrupt(true);
        sys.audio.current_dma_block = 0;
        pi::check_interrupts(sys);

        // NOTE: it's important to only check this at the end of transfers - if a transfer is
        // started, it must execute until completion! (breaks Mario Sunshine otherwise)
        if !sys.audio.dma_control.playing() {
            return;
        }
    }

    sys.scheduler.schedule_full(
        sys.audio.control.dsp_sample_rate().cycles_per_block() - ctx.cycles_late.value(),
        self::push_data_dma_block,
    );
}

pub fn start_data_dma(sys: &mut System) {
    sys.modules
        .audio
        .set_sample_rate(sys.audio.control.dsp_sample_rate());

    if !sys.scheduler.contains_full(self::push_data_dma_block) {
        sys.scheduler.schedule_full(
            sys.audio.control.dsp_sample_rate().cycles_per_block(),
            self::push_data_dma_block,
        );
    }
}

pub fn stop_data_dma(sys: &mut System) {
    sys.scheduler.cancel_full(self::push_data_dma_block);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system::scheduler::{MachineEventKind, RuntimeDeadlinePolicy};

    fn playing_ai(counter: u32, target: u32, cycle: u64) -> Interface {
        let mut audio = Interface::default();
        audio.write_sample_counter_at(counter, cycle).unwrap();
        audio.interrupt_sample = target;
        audio.control = Control::from_bits(0x0000_0007);
        audio
    }

    #[test]
    fn hardware_rates_and_aid_periods_match_browser_vectors() {
        assert_eq!(SampleRate::KHz48.value(), 48_043);
        assert_eq!(SampleRate::KHz32.value(), 32_029);
        assert_eq!(SampleRate::KHz48.cycles_per_block(), 80_928);
        assert_eq!(SampleRate::KHz32.cycles_per_block(), 121_390);
        let ratio = SampleRate::KHz32.cycles_per_block() as f64
            / SampleRate::KHz48.cycles_per_block() as f64;
        assert!((ratio - 1.5).abs() < 0.001);
    }

    #[test]
    fn ai_interrupt_projection_matches_stepwise_wraparound_exactly() {
        let mut stepwise = playing_ai(0xffff_fffd, 1, 1_000);
        let mut batched = playing_ai(0xffff_fffd, 1, 1_000);
        let interrupt_cycle = stepwise.next_ai_interrupt_cycle().unwrap().unwrap();
        let expected_ticks = u128::from(1_000_u64) * AI_TIME_TICKS_PER_CPU_CYCLE
            + 4 * SampleRate::KHz48.ai_period_ticks();
        assert_eq!(
            interrupt_cycle,
            ResidentAiTiming::deadline_for_tick(expected_ticks).unwrap()
        );

        while stepwise.next_ai_sample_cycle().unwrap().unwrap() <= interrupt_cycle {
            let cycle = stepwise.next_ai_sample_cycle().unwrap().unwrap();
            stepwise.service_resident_ai(cycle).unwrap();
        }
        let summary = batched.service_resident_ai(interrupt_cycle).unwrap();
        assert_eq!(summary.samples, 4);
        assert!(summary.interrupt_asserted);
        assert_eq!(batched.sample_counter, 1);
        assert!(batched.control.interrupt());
        assert_eq!(batched.next_ai_interrupt_cycle().unwrap(), None);
        assert_eq!(batched.resident_ai, stepwise.resident_ai);
        assert_eq!(batched.control.to_bits(), stepwise.control.to_bits());
    }

    #[test]
    fn ai_current_target_projects_one_complete_u32_wrap() {
        let audio = playing_ai(0x1234_5678, 0x1234_5678, 1_000);
        let expected_ticks = u128::from(1_000_u64) * AI_TIME_TICKS_PER_CPU_CYCLE
            + (1_u128 << 32) * SampleRate::KHz48.ai_period_ticks();
        assert_eq!(
            audio.next_ai_interrupt_cycle().unwrap(),
            Some(ResidentAiTiming::deadline_for_tick(expected_ticks).unwrap())
        );
    }

    #[test]
    fn ai_rational_phase_has_no_long_slice_integer_drift_at_either_rate() {
        const SAMPLES: u64 = 1_000_000;
        for (control, rate) in [
            (0x0000_0003, SampleRate::KHz48),
            (0x0000_0001, SampleRate::KHz32),
        ] {
            let anchor_cycle = 12_345;
            let mut audio = Interface::default();
            audio.write_sample_counter_at(7, anchor_cycle).unwrap();
            audio.control = Control::from_bits(control);
            let anchor_ticks = u128::from(anchor_cycle) * AI_TIME_TICKS_PER_CPU_CYCLE;
            let expected_ticks = anchor_ticks + u128::from(SAMPLES) * rate.ai_period_ticks();
            let observed = ResidentAiTiming::deadline_for_tick(expected_ticks).unwrap();
            let summary = audio.service_resident_ai(observed).unwrap();

            assert_eq!(summary.samples, SAMPLES);
            assert_eq!(audio.sample_counter, 7 + SAMPLES as u32);
            assert_eq!(audio.resident_ai.last_sample_ticks, expected_ticks);
            assert_eq!(
                audio.next_ai_sample_cycle().unwrap(),
                Some(
                    ResidentAiTiming::deadline_for_tick(expected_ticks + rate.ai_period_ticks(),)
                        .unwrap()
                )
            );
        }
    }

    #[test]
    fn ai_rate_change_preserves_fractional_phase_and_reset_reanchors() {
        let mut audio = playing_ai(0, 100, 1_000);
        let first = audio.next_ai_sample_cycle().unwrap().unwrap();
        audio.service_resident_ai(first).unwrap();
        let retained_tick = audio.resident_ai.last_sample_ticks;

        let changed = Control::from_bits(audio.control.to_bits() & !0x2);
        audio.write_control_at(changed, first).unwrap();
        assert_eq!(audio.resident_ai.last_sample_ticks, retained_tick);
        assert_eq!(
            audio.next_ai_sample_cycle().unwrap(),
            Some(
                ResidentAiTiming::deadline_for_tick(
                    retained_tick + SampleRate::KHz32.ai_period_ticks(),
                )
                .unwrap()
            )
        );

        let reset_cycle = first + 7;
        let reset = Control::from_bits(audio.control.to_bits() | 0x20);
        audio.write_control_at(reset, reset_cycle).unwrap();
        assert_eq!(audio.sample_counter, 0);
        assert_eq!(
            audio.resident_ai.last_sample_ticks,
            u128::from(reset_cycle) * AI_TIME_TICKS_PER_CPU_CYCLE
        );
    }

    #[test]
    fn ai_w1c_deadlines_and_nonmonotonic_calls_fail_closed() {
        let mut audio = playing_ai(0, 1, 100);
        let due = audio.next_ai_interrupt_cycle().unwrap().unwrap();
        audio.service_resident_ai(due).unwrap();
        assert!(audio.control.interrupt());

        let acknowledged = Control::from_bits(audio.control.to_bits() | 0x08);
        audio.write_control_at(acknowledged, due).unwrap();
        assert!(!audio.control.interrupt());
        assert!(matches!(
            audio.service_resident_ai(due - 1),
            Err(ResidentAudioError::NonMonotonicCycle { .. })
        ));

        let mut deadlines = MachineEventDeadlines::default();
        audio.publish_resident_deadlines(&mut deadlines).unwrap();
        assert!(deadlines.deadline(MachineEventKind::AiSample).is_some());
        assert!(deadlines.deadline(MachineEventKind::AiInterrupt).is_some());
    }

    #[test]
    fn partial_ai_register_writes_preserve_lanes_and_apply_w1c_reset_phase() {
        let mut audio = Interface::default();
        audio.write_sample_counter_at(0x1122_3344, 100).unwrap();
        audio.interrupt_sample = 0x5566_7788;
        audio.control = Control::from_bits(0x0000_005f);

        // An uncovered high-half write cannot acknowledge the low-byte interrupt status.
        audio
            .write_control_masked_at(Control::from_bits(0), 0xffff_0000, 100)
            .unwrap();
        assert_eq!(audio.control.to_bits(), 0x0000_005f);

        // A low byte is a complete store to that lane: status is W1C and the other low control
        // bits take the written zeroes. The phase reanchors because PLAY changed.
        audio
            .write_control_masked_at(Control::from_bits(0x08), 0x0000_00ff, 107)
            .unwrap();
        assert_eq!(audio.control.to_bits(), 0);
        assert_eq!(audio.sample_counter, 0x1122_3344);
        assert_eq!(audio.resident_ai.last_sample_cycle_floor(), 107);

        audio
            .write_sample_counter_masked_at(0xaabb_0000, 0xffff_0000, 111)
            .unwrap();
        assert_eq!(audio.sample_counter, 0xaabb_3344);
        assert_eq!(audio.resident_ai.last_sample_cycle_floor(), 111);
        audio
            .write_interrupt_sample_masked_at(0x0000_00aa, 0x0000_00ff, 112)
            .unwrap();
        assert_eq!(audio.interrupt_sample, 0x5566_77aa);
        assert_eq!(audio.resident_ai.last_sample_cycle_floor(), 111);

        audio.sample_counter = 9;
        audio
            .write_control_masked_at(Control::from_bits(0x21), 0x0000_00ff, 120)
            .unwrap();
        assert_eq!(audio.sample_counter, 0);
        assert_eq!(audio.control.to_bits(), 1);
        assert_eq!(audio.resident_ai.last_sample_cycle_floor(), 120);
    }

    #[test]
    fn partial_aid_control_write_only_edges_when_play_lane_is_covered() {
        let mut audio = Interface::default();
        audio
            .write_dsp_audio_dma_control_masked_at(DmaControl::from_bits(0x0003), 0x00ff, 1_000)
            .unwrap();
        assert_eq!(audio.dma_control.to_bits(), 3);
        assert_eq!(audio.resident_dsp_audio_dma.starts(), 0);

        audio
            .write_dsp_audio_dma_control_masked_at(DmaControl::from_bits(0x8000), 0xff00, 1_001)
            .unwrap();
        assert_eq!(audio.dma_control.to_bits(), 0x8003);
        assert_eq!(audio.resident_dsp_audio_dma.starts(), 1);
        assert_eq!(
            audio.resident_dsp_audio_dma.next_interrupt_cycle(),
            Some(1_201)
        );
        assert_eq!(audio.resident_dsp_audio_dma.remaining_blocks(), 3);

        audio
            .write_dsp_audio_dma_control_masked_at(DmaControl::from_bits(0), 0xff00, 1_002)
            .unwrap();
        assert_eq!(audio.dma_control.to_bits(), 3);
        assert_eq!(audio.resident_dsp_audio_dma.stops(), 1);
        assert_eq!(audio.resident_dsp_audio_dma.next_interrupt_cycle(), None);
        assert_eq!(audio.resident_dsp_audio_dma.next_block_cycle(), None);
    }

    #[test]
    fn dsp_audio_completion_projection_matches_stepwise_block_state() {
        let mut stepwise = Interface::default();
        let mut batched = Interface::default();
        for audio in [&mut stepwise, &mut batched] {
            audio
                .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x8003), 1_000)
                .unwrap();
        }
        let period = SampleRate::KHz48.cycles_per_block();
        let completion = stepwise
            .next_dsp_audio_dma_completion_cycle()
            .unwrap()
            .unwrap();
        assert_eq!(completion, 1_000 + 3 * period);

        stepwise.service_resident_dsp_audio_dma(1_200).unwrap();
        while stepwise
            .resident_dsp_audio_dma
            .next_block_cycle()
            .is_some_and(|cycle| cycle <= completion)
        {
            let cycle = stepwise.resident_dsp_audio_dma.next_block_cycle().unwrap();
            stepwise.service_resident_dsp_audio_dma(cycle).unwrap();
        }
        let summary = batched.service_resident_dsp_audio_dma(completion).unwrap();
        assert_eq!(summary.initial_interrupts, 1);
        assert_eq!(summary.blocks, 3);
        assert_eq!(summary.completions, 1);
        assert_eq!(
            batched.resident_dsp_audio_dma,
            stepwise.resident_dsp_audio_dma
        );
        assert_eq!(batched.resident_dsp_audio_dma.remaining_blocks(), 3);
        assert_eq!(batched.resident_dsp_audio_dma.blocks_left(), 2);
        assert_eq!(batched.resident_dsp_audio_dma.interrupt_assertions(), 2);
    }

    #[test]
    fn dsp_audio_initial_zero_length_stop_reload_and_deadlines_match_oracle() {
        let mut audio = Interface::default();
        audio
            .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x8000), 50)
            .unwrap();
        assert_eq!(audio.resident_dsp_audio_dma.next_block_cycle(), None);
        assert_eq!(
            audio.resident_dsp_audio_dma.next_interrupt_cycle(),
            Some(250)
        );

        // An enabled-to-enabled write changes the next reload length but cannot restart latency.
        audio
            .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x8002), 100)
            .unwrap();
        assert_eq!(
            audio.resident_dsp_audio_dma.next_interrupt_cycle(),
            Some(250)
        );
        let initial = audio.service_resident_dsp_audio_dma(250).unwrap();
        assert_eq!(initial.initial_interrupts, 1);
        assert_eq!(initial.blocks, 0);

        audio
            .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x0002), 251)
            .unwrap();
        assert_eq!(audio.resident_dsp_audio_dma.remaining_blocks(), 0);
        assert_eq!(audio.resident_dsp_audio_dma.next_interrupt_cycle(), None);
        assert_eq!(audio.resident_dsp_audio_dma.next_block_cycle(), None);
        assert_eq!(audio.resident_dsp_audio_dma.starts(), 1);
        assert_eq!(audio.resident_dsp_audio_dma.stops(), 1);

        let mut deadlines = MachineEventDeadlines::default();
        audio.publish_resident_deadlines(&mut deadlines).unwrap();
        assert_eq!(
            deadlines.deadline(MachineEventKind::DspAudioDmaInterrupt),
            None
        );
        assert_eq!(deadlines.deadline(MachineEventKind::DspAudioDmaBlock), None);
        assert_eq!(
            deadlines.deadline(MachineEventKind::DspAudioDmaCompletion),
            None
        );
    }

    #[test]
    fn dsp_audio_deadline_policy_selects_block_or_completion_projection() {
        let mut audio = Interface::default();
        audio
            .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x8003), 1_000)
            .unwrap();
        let mut deadlines = MachineEventDeadlines::default();
        audio.publish_resident_deadlines(&mut deadlines).unwrap();
        assert_eq!(
            deadlines
                .next_event_after(1_200, RuntimeDeadlinePolicy::EXACT)
                .unwrap()
                .kind,
            MachineEventKind::DspAudioDmaBlock
        );
        assert_eq!(
            deadlines
                .next_event_after(
                    1_200,
                    RuntimeDeadlinePolicy {
                        include_cycle_limit: false,
                        coalesce_idle_audio: true,
                    },
                )
                .unwrap()
                .kind,
            MachineEventKind::DspAudioDmaCompletion
        );
    }

    #[test]
    fn dsp_audio_rejects_unbounded_catchup_without_consuming_a_block() {
        let mut audio = Interface::default();
        audio
            .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x8001), 0)
            .unwrap();
        let first = audio.resident_dsp_audio_dma.next_block_cycle().unwrap();
        let observed =
            first + SampleRate::KHz48.cycles_per_block() * MAX_DSP_AUDIO_DMA_BLOCKS_PER_SERVICE;
        assert_eq!(
            audio.service_resident_dsp_audio_dma(observed),
            Err(ResidentAudioError::DspAudioDmaCatchUpLimit {
                due_blocks: MAX_DSP_AUDIO_DMA_BLOCKS_PER_SERVICE + 1,
                limit: MAX_DSP_AUDIO_DMA_BLOCKS_PER_SERVICE,
            })
        );
        assert_eq!(audio.resident_dsp_audio_dma.remaining_blocks(), 1);
        assert_eq!(audio.resident_dsp_audio_dma.next_block_cycle(), Some(first));

        let mut stopping = Interface::default();
        stopping
            .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x8001), 0)
            .unwrap();
        stopping
            .write_dsp_audio_dma_control_at(DmaControl::from_bits(0x8000), 1)
            .unwrap();
        let summary = stopping.service_resident_dsp_audio_dma(observed).unwrap();
        assert_eq!(summary.blocks, 1);
        assert_eq!(summary.completions, 1);
        assert_eq!(stopping.resident_dsp_audio_dma.next_block_cycle(), None);

        let mut inconsistent = Interface::default();
        inconsistent.resident_dsp_audio_dma.next_block_cycle = Some(10);
        assert_eq!(
            inconsistent.service_resident_dsp_audio_dma(10),
            Err(ResidentAudioError::InconsistentDspAudioDmaState {
                remaining_blocks: 0,
                next_block_cycle: Some(10),
            })
        );
    }
}
