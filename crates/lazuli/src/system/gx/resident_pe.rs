//! Rust-owned Pixel Engine (PE) timing and interrupt state.
//!
//! The resident GX decoder has already applied the 24-bit BP register mask when it emits a
//! [`SemanticRecord::BpLoad`]. PE still observes BP mask loads because BP47 and BP48 target one
//! shared 16-bit token even though the BP register file stores them separately. Replaying the
//! public semantic records therefore preserves partial writes without reaching into the decoder.
//!
//! Browser-machine integration has four synchronous seams:
//!
//! 1. pass every decoded semantic record to
//!    [`System::apply_resident_pixel_engine_record`] at that command's observed cycle;
//! 2. route PE control MMIO stores through
//!    [`System::write_resident_pixel_engine_control_masked`];
//! 3. publish [`MachineEventKind::PeFinish`] with
//!    [`System::publish_resident_pixel_engine_deadline`]; and
//! 4. call [`System::service_resident_pixel_engine`] unconditionally in every PixelEngine service
//!    phase after replaying the CP batch. BP48 is a level edge with no scalar deadline; only BP45
//!    publishes [`MachineEventKind::PeFinish`].
//!
//! None of these seams schedules a Rust callback or calls JavaScript. BP45 is represented only by
//! the fixed resident deadline set; token and finish remain level sources owned by `pix::Interface`.

use gekko::Exception;

use super::pix::{Interface, InterruptStatus};
use super::resident_fifo::SemanticRecord;
use crate::system::System;
use crate::system::scheduler::{MachineEventDeadlines, MachineEventKind};

/// Browser-oracle delay between an accepted BP45 draw-done command and FINISH assertion.
pub const PE_FINISH_LATENCY_CYCLES: u64 = 200;

const BP_PIXEL_DONE: u8 = 0x45;
const BP_PIXEL_TOKEN: u8 = 0x47;
const BP_PIXEL_TOKEN_INTERRUPT: u8 = 0x48;
const BP_WRITE_MASK: u8 = 0xfe;
const BP_VALUE_MASK: u32 = 0x00ff_ffff;
const BP_TOKEN_MASK: u32 = 0x0000_ffff;

/// Timing and delivery bookkeeping which is not directly visible in PE MMIO.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResidentPixelEngine {
    bp_write_mask: u32,
    finish_cycle: Option<u64>,
    last_observed_cycle: Option<u64>,
    token_interrupt_delivered: bool,
    finish_interrupt_delivered: bool,
    pi_delivery_enabled: bool,
}

impl Default for ResidentPixelEngine {
    fn default() -> Self {
        Self {
            bp_write_mask: BP_VALUE_MASK,
            finish_cycle: None,
            last_observed_cycle: None,
            token_interrupt_delivered: false,
            finish_interrupt_delivered: false,
            pi_delivery_enabled: false,
        }
    }
}

impl ResidentPixelEngine {
    #[must_use]
    pub const fn bp_write_mask(&self) -> u32 {
        self.bp_write_mask
    }

    #[must_use]
    pub const fn finish_cycle(&self) -> Option<u64> {
        self.finish_cycle
    }

    #[must_use]
    pub const fn last_observed_cycle(&self) -> Option<u64> {
        self.last_observed_cycle
    }

    #[must_use]
    pub const fn token_interrupt_delivered(&self) -> bool {
        self.token_interrupt_delivered
    }

    #[must_use]
    pub const fn finish_interrupt_delivered(&self) -> bool {
        self.finish_interrupt_delivered
    }

    #[must_use]
    pub const fn pi_delivery_enabled(&self) -> bool {
        self.pi_delivery_enabled
    }

    fn validate_cycle(&self, observed_cycle: u64) -> Result<(), ResidentPeError> {
        if let Some(last_observed_cycle) = self.last_observed_cycle
            && observed_cycle < last_observed_cycle
        {
            return Err(ResidentPeError::NonMonotonicCycle {
                observed_cycle,
                last_observed_cycle,
            });
        }
        Ok(())
    }
}

/// A guest-driven PE transition could not be represented without corrupting resident state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentPeError {
    BpValueOutOfRange {
        register: u8,
        value: u32,
    },
    NonMonotonicCycle {
        observed_cycle: u64,
        last_observed_cycle: u64,
    },
    FinishDeadlineOverflow {
        observed_cycle: u64,
    },
}

/// Result of replaying one resident GX semantic record into PE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeRecordOutcome {
    Ignored,
    TerminalObserved,
    BpMaskUpdated {
        mask: u32,
    },
    OtherBp {
        register: u8,
    },
    FinishCommand {
        triggered: bool,
        new_deadline: Option<u64>,
    },
    TokenCommand {
        interrupt_command: bool,
        token: u16,
        signal_asserted: bool,
    },
}

/// PE interrupt qualification supplied by the Processor Interface and CPU.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PeInterruptGate {
    pub token_pi_unmasked: bool,
    pub finish_pi_unmasked: bool,
    pub external_interrupts_enabled: bool,
}

/// PE sources delivered by one external-interrupt exception.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PeInterruptDelivery {
    pub token: bool,
    pub finish: bool,
}

impl PeInterruptDelivery {
    #[must_use]
    pub const fn any(self) -> bool {
        self.token || self.finish
    }
}

/// Result of one synchronous PE service pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeServiceSummary {
    pub observed_cycle: u64,
    pub completed_finish_cycle: Option<u64>,
    pub next_finish_cycle: Option<u64>,
    pub token_active: bool,
    pub finish_active: bool,
    pub delivery: PeInterruptDelivery,
}

/// Result of applying a potentially partial PE control-register store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeControlWrite {
    pub token_enabled: bool,
    pub finish_enabled: bool,
    pub token_acknowledged: bool,
    pub finish_acknowledged: bool,
}

impl Interface {
    /// Replays the PE-relevant part of one public resident GX record.
    pub fn apply_resident_record(
        &mut self,
        record: &SemanticRecord,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<PeRecordOutcome, ResidentPeError> {
        match record {
            SemanticRecord::BpLoad { register, value } => {
                self.apply_resident_bp_load(*register, *value, observed_cycle, deadlines)
            }
            SemanticRecord::Terminal(_) => Ok(PeRecordOutcome::TerminalObserved),
            SemanticRecord::CpLoad { .. }
            | SemanticRecord::XfLoad { .. }
            | SemanticRecord::IndexedXfLoad { .. }
            | SemanticRecord::DisplayListCall { .. }
            | SemanticRecord::InvalidateVertexCache
            | SemanticRecord::Draw { .. }
            | SemanticRecord::UnsupportedOpcode { .. } => Ok(PeRecordOutcome::Ignored),
        }
    }

    /// Applies one already-decoded BP load without consulting decoder-private state.
    pub fn apply_resident_bp_load(
        &mut self,
        register: u8,
        value: u32,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<PeRecordOutcome, ResidentPeError> {
        if value & !BP_VALUE_MASK != 0 {
            return Err(ResidentPeError::BpValueOutOfRange { register, value });
        }
        self.resident.validate_cycle(observed_cycle)?;

        let new_finish_deadline = if register == BP_PIXEL_DONE
            && value & 2 != 0
            && self.resident.finish_cycle.is_none()
            && !self.interrupt.finish()
        {
            Some(
                observed_cycle
                    .checked_add(PE_FINISH_LATENCY_CYCLES)
                    .ok_or(ResidentPeError::FinishDeadlineOverflow { observed_cycle })?,
            )
        } else {
            None
        };

        self.resident.last_observed_cycle = Some(observed_cycle);
        if register == BP_WRITE_MASK {
            self.resident.bp_write_mask = value;
            self.publish_resident_deadline(deadlines);
            return Ok(PeRecordOutcome::BpMaskUpdated { mask: value });
        }

        let active_mask = self.resident.bp_write_mask;
        self.resident.bp_write_mask = BP_VALUE_MASK;
        let outcome = match register {
            BP_PIXEL_DONE => {
                if let Some(cycle) = new_finish_deadline {
                    self.resident.finish_cycle = Some(cycle);
                }
                PeRecordOutcome::FinishCommand {
                    triggered: value & 2 != 0,
                    new_deadline: new_finish_deadline,
                }
            }
            BP_PIXEL_TOKEN | BP_PIXEL_TOKEN_INTERRUPT => {
                let token_mask = active_mask & BP_TOKEN_MASK;
                let token = (self.token & !token_mask) | (value & token_mask);
                self.token = token & BP_TOKEN_MASK;
                let interrupt_command = register == BP_PIXEL_TOKEN_INTERRUPT;
                let signal_asserted = interrupt_command && !self.interrupt.token();
                if signal_asserted {
                    self.interrupt.set_token(true);
                    self.resident.token_interrupt_delivered = false;
                }
                PeRecordOutcome::TokenCommand {
                    interrupt_command,
                    token: self.token as u16,
                    signal_asserted,
                }
            }
            _ => PeRecordOutcome::OtherBp { register },
        };
        self.publish_resident_deadline(deadlines);
        Ok(outcome)
    }

    /// Applies PE enable bits and W1C acknowledgements covered by one scalar MMIO store.
    pub fn write_resident_control_masked(
        &mut self,
        written: u16,
        written_mask: u16,
    ) -> PeControlWrite {
        const ENABLE_BITS: u16 = 0x0003;
        const TOKEN_ACKNOWLEDGE: u16 = 0x0004;
        const FINISH_ACKNOWLEDGE: u16 = 0x0008;

        let current = self.interrupt.to_bits();
        let enables =
            (current & ENABLE_BITS & !written_mask) | (written & ENABLE_BITS & written_mask);
        let token_acknowledged = written & written_mask & TOKEN_ACKNOWLEDGE != 0;
        let finish_acknowledged = written & written_mask & FINISH_ACKNOWLEDGE != 0;

        self.interrupt.set_token_enabled(enables & 1 != 0);
        self.interrupt.set_finish_enabled(enables & 2 != 0);
        if token_acknowledged {
            self.interrupt.set_token(false);
            self.resident.token_interrupt_delivered = false;
        }
        if finish_acknowledged {
            self.interrupt.set_finish(false);
            self.resident.finish_interrupt_delivered = false;
        }

        PeControlWrite {
            token_enabled: self.interrupt.token_enabled(),
            finish_enabled: self.interrupt.finish_enabled(),
            token_acknowledged,
            finish_acknowledged,
        }
    }

    /// Services an optional overdue FINISH edge, updates PE levels, and books one PI delivery.
    pub fn service_resident(
        &mut self,
        observed_cycle: u64,
        gate: PeInterruptGate,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<PeServiceSummary, ResidentPeError> {
        self.resident.validate_cycle(observed_cycle)?;
        self.resident.last_observed_cycle = Some(observed_cycle);

        let completed_finish_cycle = self
            .resident
            .finish_cycle
            .filter(|cycle| *cycle <= observed_cycle);
        if completed_finish_cycle.is_some() {
            self.resident.finish_cycle = None;
            self.interrupt.set_finish(true);
            self.resident.finish_interrupt_delivered = false;
        }

        let token_active = self.interrupt.token() && self.interrupt.token_enabled();
        let finish_active = self.interrupt.finish() && self.interrupt.finish_enabled();
        let token_pending =
            token_active && gate.token_pi_unmasked && !self.resident.token_interrupt_delivered;
        let finish_pending =
            finish_active && gate.finish_pi_unmasked && !self.resident.finish_interrupt_delivered;
        let delivery = if gate.external_interrupts_enabled {
            PeInterruptDelivery {
                token: token_pending,
                finish: finish_pending,
            }
        } else {
            PeInterruptDelivery::default()
        };
        if delivery.token {
            self.resident.token_interrupt_delivered = true;
        }
        if delivery.finish {
            self.resident.finish_interrupt_delivered = true;
        }
        if !token_active {
            self.resident.token_interrupt_delivered = false;
        }
        if !finish_active {
            self.resident.finish_interrupt_delivered = false;
        }

        self.publish_resident_deadline(deadlines);
        Ok(PeServiceSummary {
            observed_cycle,
            completed_finish_cycle,
            next_finish_cycle: self.resident.finish_cycle,
            token_active,
            finish_active,
            delivery,
        })
    }

    /// Copies the exact PE deadline into the fixed resident selector.
    pub fn publish_resident_deadline(&self, deadlines: &mut MachineEventDeadlines) {
        deadlines.set(MachineEventKind::PeFinish, self.resident.finish_cycle);
    }

    /// Restores power-on PE state and removes any stale resident deadline.
    pub fn reset_resident(&mut self, deadlines: &mut MachineEventDeadlines) {
        let pi_delivery_enabled = self.resident.pi_delivery_enabled;
        self.interrupt = InterruptStatus::default();
        self.token = 0;
        self.resident = ResidentPixelEngine {
            pi_delivery_enabled,
            ..ResidentPixelEngine::default()
        };
        deadlines.clear(MachineEventKind::PeFinish);
    }
}

impl System {
    /// Selects the resident PE phase as the sole PI delivery owner for token and finish sources.
    ///
    /// This is browser-machine policy rather than guest-visible hardware state. It defaults off,
    /// preserving native PI sampling, and survives a resident PE reset once enabled.
    pub fn set_resident_pixel_engine_pi_delivery(&mut self, enabled: bool) {
        self.gpu.pix.resident.pi_delivery_enabled = enabled;
    }

    /// Whether generic PI sampling currently defers PE token and finish delivery to the resident
    /// PE service phase.
    #[must_use]
    pub const fn resident_pixel_engine_pi_delivery_enabled(&self) -> bool {
        self.gpu.pix.resident.pi_delivery_enabled()
    }

    /// System-level record seam used by the resident GX FIFO loop.
    pub fn apply_resident_pixel_engine_record(
        &mut self,
        record: &SemanticRecord,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<PeRecordOutcome, ResidentPeError> {
        self.gpu
            .pix
            .apply_resident_record(record, observed_cycle, deadlines)
    }

    /// System-level PE control MMIO seam. PI is sampled by the subsequent PE service phase.
    pub fn write_resident_pixel_engine_control_masked(
        &mut self,
        written: u16,
        written_mask: u16,
    ) -> PeControlWrite {
        self.gpu
            .pix
            .write_resident_control_masked(written, written_mask)
    }

    /// Services PE in browser order and raises at most one external exception for both sources.
    pub fn service_resident_pixel_engine(
        &mut self,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<PeServiceSummary, ResidentPeError> {
        let mask = self.processor.mask.sources();
        let gate = PeInterruptGate {
            token_pi_unmasked: mask.pe_token(),
            finish_pi_unmasked: mask.pe_finish(),
            external_interrupts_enabled: self.cpu.supervisor.config.msr.interrupts(),
        };
        let summary = self
            .gpu
            .pix
            .service_resident(observed_cycle, gate, deadlines)?;
        if summary.delivery.any() {
            self.cpu.raise_exception(Exception::Interrupt);
        }
        Ok(summary)
    }

    pub fn publish_resident_pixel_engine_deadline(&self, deadlines: &mut MachineEventDeadlines) {
        self.gpu.pix.publish_resident_deadline(deadlines);
    }

    pub fn reset_resident_pixel_engine(&mut self, deadlines: &mut MachineEventDeadlines) {
        self.gpu.pix.reset_resident(deadlines);
    }
}

#[cfg(test)]
mod tests {
    use gekko::Address;

    use super::*;
    use crate::modules::audio::NopAudioModule;
    use crate::modules::debug::NopDebugModule;
    use crate::modules::disk::NopDiskModule;
    use crate::modules::input::NopInputModule;
    use crate::modules::render::NopRenderModule;
    use crate::modules::vertex::NopVertexModule;
    use crate::system::bus::DataAccessTarget;
    use crate::system::gx::resident_fifo::{
        DecoderLimits, GxMemory, MemoryError, ResidentGxDecoder,
    };
    use crate::system::{Config, Modules, pi};

    struct NoMemory;

    impl GxMemory for NoMemory {
        fn read_exact(
            &mut self,
            _address: u32,
            _destination: &mut [u8],
        ) -> Result<(), MemoryError> {
            Err(MemoryError::Rejected)
        }
    }

    fn bp(register: u8, value: u32) -> Vec<u8> {
        let mut command = vec![0x61];
        command
            .extend_from_slice(&(u32::from(register) << 24 | value & BP_VALUE_MASK).to_be_bytes());
        command
    }

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
                ipl_lle: false,
                ipl: None,
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    fn enable_pe_sources(system: &mut System, token: bool, finish: bool) {
        system.write_resident_pixel_engine_control_masked(
            u16::from(token) | (u16::from(finish) << 1),
            u16::MAX,
        );
    }

    fn unmask_pi_sources(system: &mut System, token: bool, finish: bool) {
        let mut sources = system.processor.mask.sources();
        sources.set_pe_token(token);
        sources.set_pe_finish(finish);
        system.processor.mask.set_sources(sources);
    }

    #[test]
    fn decoded_partial_bp_writes_preserve_the_shared_token_oracle() {
        let mut stream = bp(BP_PIXEL_TOKEN, 0xaaaa);
        stream.extend(bp(BP_WRITE_MASK, 0x0000_00ff));
        stream.extend(bp(BP_PIXEL_TOKEN, 0x0055));
        stream.extend(bp(BP_WRITE_MASK, 0x0000_0f00));
        stream.extend(bp(BP_PIXEL_TOKEN_INTERRUPT, 0x0500));

        let mut decoder = ResidentGxDecoder::try_new(DecoderLimits::default()).unwrap();
        let mut memory = NoMemory;
        let batch = decoder.append(&stream, &mut memory).unwrap();
        let mut pixel = Interface::default();
        let mut deadlines = MachineEventDeadlines::default();
        for record in batch.records() {
            pixel
                .apply_resident_record(record, 10, &mut deadlines)
                .unwrap();
        }

        assert_eq!(pixel.token, 0xa555);
        assert!(pixel.interrupt.token());
        assert_eq!(pixel.resident.bp_write_mask(), BP_VALUE_MASK);
        assert_eq!(decoder.bp_registers()[usize::from(BP_PIXEL_TOKEN)], 0xaa55);
        assert_eq!(
            decoder.bp_registers()[usize::from(BP_PIXEL_TOKEN_INTERRUPT)],
            0x0500
        );
    }

    #[test]
    fn token_write_never_asserts_but_token_interrupt_is_level_triggered_once() {
        let mut pixel = Interface::default();
        let mut deadlines = MachineEventDeadlines::default();
        let plain = pixel
            .apply_resident_bp_load(BP_PIXEL_TOKEN, 0x1234, 1, &mut deadlines)
            .unwrap();
        assert_eq!(
            plain,
            PeRecordOutcome::TokenCommand {
                interrupt_command: false,
                token: 0x1234,
                signal_asserted: false,
            }
        );
        assert!(!pixel.interrupt.token());

        let first = pixel
            .apply_resident_bp_load(BP_PIXEL_TOKEN_INTERRUPT, 0x5678, 2, &mut deadlines)
            .unwrap();
        assert!(matches!(
            first,
            PeRecordOutcome::TokenCommand {
                signal_asserted: true,
                ..
            }
        ));
        let duplicate = pixel
            .apply_resident_bp_load(BP_PIXEL_TOKEN_INTERRUPT, 0x9abc, 3, &mut deadlines)
            .unwrap();
        assert!(matches!(
            duplicate,
            PeRecordOutcome::TokenCommand {
                token: 0x9abc,
                signal_asserted: false,
                ..
            }
        ));
        assert!(pixel.interrupt.token());
    }

    #[test]
    fn finish_deadline_is_exact_and_requires_ack_before_retrigger() {
        let mut pixel = Interface::default();
        let mut deadlines = MachineEventDeadlines::default();
        let scheduled = pixel
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, 100, &mut deadlines)
            .unwrap();
        assert_eq!(
            scheduled,
            PeRecordOutcome::FinishCommand {
                triggered: true,
                new_deadline: Some(300),
            }
        );
        assert_eq!(deadlines.deadline(MachineEventKind::PeFinish), Some(300));

        let duplicate = pixel
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, 150, &mut deadlines)
            .unwrap();
        assert_eq!(
            duplicate,
            PeRecordOutcome::FinishCommand {
                triggered: true,
                new_deadline: None,
            }
        );
        assert_eq!(pixel.resident.finish_cycle(), Some(300));
        assert_eq!(
            pixel
                .service_resident(299, PeInterruptGate::default(), &mut deadlines)
                .unwrap()
                .completed_finish_cycle,
            None
        );
        assert_eq!(
            pixel
                .service_resident(350, PeInterruptGate::default(), &mut deadlines)
                .unwrap()
                .completed_finish_cycle,
            Some(300)
        );
        assert!(pixel.interrupt.finish());
        assert_eq!(deadlines.deadline(MachineEventKind::PeFinish), None);

        let signalled_duplicate = pixel
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, 351, &mut deadlines)
            .unwrap();
        assert!(matches!(
            signalled_duplicate,
            PeRecordOutcome::FinishCommand {
                new_deadline: None,
                ..
            }
        ));
        pixel.write_resident_control_masked(0x0008, u16::MAX);
        assert!(!pixel.interrupt.finish());
        pixel
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, 400, &mut deadlines)
            .unwrap();
        assert_eq!(pixel.resident.finish_cycle(), Some(600));
    }

    #[test]
    fn pe_control_merges_enables_and_acknowledges_only_covered_status_bits() {
        let mut pixel = Interface::default();
        pixel.interrupt.set_token(true);
        pixel.interrupt.set_finish(true);
        pixel.resident.token_interrupt_delivered = true;
        pixel.resident.finish_interrupt_delivered = true;

        let low_byte = pixel.write_resident_control_masked(0x0005, 0x00ff);
        assert_eq!(
            low_byte,
            PeControlWrite {
                token_enabled: true,
                finish_enabled: false,
                token_acknowledged: true,
                finish_acknowledged: false,
            }
        );
        assert!(!pixel.interrupt.token());
        assert!(pixel.interrupt.finish());
        assert!(!pixel.resident.token_interrupt_delivered());
        assert!(pixel.resident.finish_interrupt_delivered());

        let uncovered = pixel.write_resident_control_masked(0x0008, 0xff00);
        assert!(!uncovered.finish_acknowledged);
        assert!(pixel.interrupt.finish());
        let covered = pixel.write_resident_control_masked(0x000a, 0x00ff);
        assert!(covered.finish_acknowledged);
        assert!(covered.finish_enabled);
        assert!(!pixel.interrupt.finish());
    }

    #[test]
    fn resident_pe_mmio_byte_and_halfword_writes_preserve_exact_lane_ownership() {
        let mut system = test_system();
        system.set_resident_pixel_engine_pi_delivery(true);
        system.gpu.pix.interrupt = InterruptStatus::from_bits(0x000f);
        system.gpu.pix.resident.token_interrupt_delivered = true;
        system.gpu.pix.resident.finish_interrupt_delivered = true;

        // The high byte covers none of the low-byte enables or W1C sources. It must not route
        // through the legacy full-register replacement path.
        assert_eq!(
            system.write_slow_result_classified_at(Address(0x0c00_100a), 0xa5_u8, 10),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(system.gpu.pix.interrupt.to_bits(), 0x000f);
        assert!(system.gpu.pix.resident.token_interrupt_delivered());
        assert!(system.gpu.pix.resident.finish_interrupt_delivered());

        // The low byte owns both enables and acknowledgements. Only TOKEN is acknowledged here;
        // FINISH remains asserted and its resident one-use delivery bookkeeping survives.
        assert_eq!(
            system.write_slow_result_classified_at(Address(0x0c00_100b), 0x05_u8, 11),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(system.gpu.pix.interrupt.to_bits(), 0x0009);
        assert!(!system.gpu.pix.resident.token_interrupt_delivered());
        assert!(system.gpu.pix.resident.finish_interrupt_delivered());

        // A full architected halfword still replaces both enables and acknowledges covered
        // sources through the same resident path.
        assert_eq!(
            system.write_slow_result_classified_at(Address(0x0c00_100a), 0x000a_u16, 12),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(system.gpu.pix.interrupt.to_bits(), 0x0002);
        assert!(!system.gpu.pix.resident.finish_interrupt_delivered());
    }

    #[test]
    fn pi_mask_and_ee_gate_delivery_without_hiding_level_sources() {
        let mut system = test_system();
        let mut deadlines = MachineEventDeadlines::default();
        let scheduler_entries = system.scheduler.len();
        system
            .gpu
            .pix
            .apply_resident_bp_load(BP_PIXEL_TOKEN_INTERRUPT, 0x0042, 10, &mut deadlines)
            .unwrap();
        assert_eq!(deadlines.deadline(MachineEventKind::PeFinish), None);
        enable_pe_sources(&mut system, true, false);
        system.cpu.supervisor.config.msr.set_interrupts(true);

        let masked = system
            .service_resident_pixel_engine(10, &mut deadlines)
            .unwrap();
        assert!(masked.token_active);
        assert!(!masked.delivery.any());
        assert!(pi::get_active_interrupts(&system).pe_token());
        assert!(!pi::get_raised_interrupts(&system).pe_token());

        unmask_pi_sources(&mut system, true, false);
        system.cpu.supervisor.config.msr.set_interrupts(false);
        assert!(
            !system
                .service_resident_pixel_engine(11, &mut deadlines)
                .unwrap()
                .delivery
                .any()
        );
        assert!(pi::get_raised_interrupts(&system).pe_token());

        system.cpu.supervisor.config.msr.set_interrupts(true);
        let delivered = system
            .service_resident_pixel_engine(12, &mut deadlines)
            .unwrap();
        assert_eq!(
            delivered.delivery,
            PeInterruptDelivery {
                token: true,
                finish: false,
            }
        );
        assert_eq!(system.cpu.pc.value() & 0x0000_ffff, 0x0500);
        assert!(system.gpu.pix.resident.token_interrupt_delivered());

        system.cpu.pc = Address(0x1234);
        system.cpu.supervisor.config.msr.set_interrupts(true);
        assert!(
            !system
                .service_resident_pixel_engine(13, &mut deadlines)
                .unwrap()
                .delivery
                .any()
        );
        assert_eq!(system.cpu.pc, Address(0x1234));
        assert_eq!(system.scheduler.len(), scheduler_entries);
    }

    #[test]
    fn simultaneous_token_and_overdue_finish_share_one_external_exception() {
        let mut system = test_system();
        let mut deadlines = MachineEventDeadlines::default();
        system
            .gpu
            .pix
            .apply_resident_bp_load(BP_PIXEL_TOKEN_INTERRUPT, 7, 0, &mut deadlines)
            .unwrap();
        system
            .gpu
            .pix
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, 0, &mut deadlines)
            .unwrap();
        enable_pe_sources(&mut system, true, true);
        unmask_pi_sources(&mut system, true, true);
        system.cpu.supervisor.config.msr.set_interrupts(true);

        let summary = system
            .service_resident_pixel_engine(275, &mut deadlines)
            .unwrap();
        assert_eq!(summary.completed_finish_cycle, Some(200));
        assert_eq!(
            summary.delivery,
            PeInterruptDelivery {
                token: true,
                finish: true,
            }
        );
        assert_eq!(system.cpu.pc.value() & 0x0000_ffff, 0x0500);
        assert!(pi::get_active_interrupts(&system).pe_token());
        assert!(pi::get_active_interrupts(&system).pe_finish());
        assert!(system.gpu.pix.resident.token_interrupt_delivered());
        assert!(system.gpu.pix.resident.finish_interrupt_delivered());
    }

    #[test]
    fn disabling_an_active_source_rearms_delivery_after_service() {
        let mut pixel = Interface::default();
        let mut deadlines = MachineEventDeadlines::default();
        pixel
            .apply_resident_bp_load(BP_PIXEL_TOKEN_INTERRUPT, 1, 0, &mut deadlines)
            .unwrap();
        pixel.write_resident_control_masked(1, u16::MAX);
        let gate = PeInterruptGate {
            token_pi_unmasked: true,
            finish_pi_unmasked: false,
            external_interrupts_enabled: true,
        };
        assert!(
            pixel
                .service_resident(0, gate, &mut deadlines)
                .unwrap()
                .delivery
                .token
        );
        pixel.write_resident_control_masked(0, u16::MAX);
        assert!(
            !pixel
                .service_resident(1, gate, &mut deadlines)
                .unwrap()
                .token_active
        );
        assert!(!pixel.resident.token_interrupt_delivered());
        pixel.write_resident_control_masked(1, u16::MAX);
        assert!(
            pixel
                .service_resident(2, gate, &mut deadlines)
                .unwrap()
                .delivery
                .token
        );
    }

    #[test]
    fn reset_duplicate_overflow_and_nonmonotonic_inputs_fail_closed() {
        let mut pixel = Interface::default();
        let mut deadlines = MachineEventDeadlines::default();
        assert_eq!(
            pixel.apply_resident_bp_load(
                BP_PIXEL_DONE,
                2,
                u64::MAX - PE_FINISH_LATENCY_CYCLES + 1,
                &mut deadlines,
            ),
            Err(ResidentPeError::FinishDeadlineOverflow {
                observed_cycle: u64::MAX - PE_FINISH_LATENCY_CYCLES + 1,
            })
        );
        assert_eq!(pixel.resident.last_observed_cycle(), None);
        assert_eq!(deadlines.deadline(MachineEventKind::PeFinish), None);

        let last_start = u64::MAX - PE_FINISH_LATENCY_CYCLES;
        pixel
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, last_start, &mut deadlines)
            .unwrap();
        assert_eq!(pixel.resident.finish_cycle(), Some(u64::MAX));
        pixel
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, u64::MAX, &mut deadlines)
            .unwrap();
        assert_eq!(pixel.resident.finish_cycle(), Some(u64::MAX));
        pixel
            .service_resident(u64::MAX, PeInterruptGate::default(), &mut deadlines)
            .unwrap();
        assert!(pixel.interrupt.finish());
        pixel
            .apply_resident_bp_load(BP_PIXEL_DONE, 2, u64::MAX, &mut deadlines)
            .unwrap();
        pixel.write_resident_control_masked(0x0008, u16::MAX);
        assert_eq!(
            pixel.apply_resident_bp_load(BP_PIXEL_DONE, 2, u64::MAX, &mut deadlines),
            Err(ResidentPeError::FinishDeadlineOverflow {
                observed_cycle: u64::MAX,
            })
        );
        assert!(!pixel.interrupt.finish());

        assert_eq!(
            pixel.apply_resident_bp_load(BP_PIXEL_TOKEN, 0x0100_0000, u64::MAX, &mut deadlines),
            Err(ResidentPeError::BpValueOutOfRange {
                register: BP_PIXEL_TOKEN,
                value: 0x0100_0000,
            })
        );
        assert_eq!(
            pixel.service_resident(u64::MAX - 1, PeInterruptGate::default(), &mut deadlines,),
            Err(ResidentPeError::NonMonotonicCycle {
                observed_cycle: u64::MAX - 1,
                last_observed_cycle: u64::MAX,
            })
        );

        pixel.reset_resident(&mut deadlines);
        assert_eq!(pixel.token, 0);
        assert_eq!(pixel.interrupt.to_bits(), 0);
        assert_eq!(pixel.resident, ResidentPixelEngine::default());
        assert_eq!(deadlines.deadline(MachineEventKind::PeFinish), None);
    }
}
