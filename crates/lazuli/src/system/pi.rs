//! Processor interface (PI).
use bitos::bitos;
use bitos::integer::u26;
use gekko::{Address, Exception};

use crate::Primitive;
use crate::system::mem::RAM_LEN;
use crate::system::{System, gx};

const FIFO_BURST_BYTES: usize = 32;
const FIFO_GATHER_CAPACITY: usize = FIFO_BURST_BYTES + size_of::<u64>() - 1;

#[bitos(14)]
#[derive(Default, Clone, Copy)]
pub struct InterruptSources {
    #[bits(0)]
    pub gp_error: bool,
    #[bits(1)]
    pub reset: bool,
    #[bits(2)]
    pub dvd_interface: bool,
    #[bits(3)]
    pub serial_interface: bool,
    #[bits(4)]
    pub external_interface: bool,
    #[bits(5)]
    pub audio_interface: bool,
    #[bits(6)]
    pub dsp_interface: bool,
    #[bits(7)]
    pub memory_interface: bool,
    #[bits(8)]
    pub video_interface: bool,
    #[bits(9)]
    pub pe_token: bool,
    #[bits(10)]
    pub pe_finish: bool,
    #[bits(11)]
    pub command_processor: bool,
    #[bits(12)]
    pub debug: bool,
    #[bits(13)]
    pub high_speed_port: bool,
}

impl std::fmt::Debug for InterruptSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut set = f.debug_set();
        macro_rules! debug {
            ($($ident:ident),*) => {
                $(
                    if self.$ident() {
                        set.entry(&stringify!($ident));
                    }
                )*
            };
        }

        debug! {
            gp_error,
            reset,
            dvd_interface,
            serial_interface,
            external_interface,
            audio_interface,
            dsp_interface,
            memory_interface,
            video_interface,
            pe_token,
            pe_finish,
            command_processor,
            debug,
            high_speed_port
        }

        set.finish_non_exhaustive()
    }
}

#[bitos(32)]
#[derive(Default, Debug, Clone, Copy)]
pub struct InterruptMask {
    #[bits(0..14)]
    pub sources: InterruptSources,
}

#[bitos(32)]
#[derive(Default, Debug, Clone, Copy)]
pub struct FifoCurrent {
    #[bits(0..26)]
    pub base: u26,
    #[bits(29)]
    pub wrapped: bool,
}

impl FifoCurrent {
    pub fn address(&self) -> Address {
        Address(self.base().value())
    }

    pub fn set_address(&mut self, value: Address) {
        self.set_base(u26::new(value.value()));
    }
}

pub struct Interface {
    // interrupts
    pub mask: InterruptMask,

    // fifo
    pub fifo_start: Address,
    pub fifo_end: Address,
    pub fifo_current: FifoCurrent,

    // A primitive may straddle a 32-byte publication boundary. Retain the largest possible carry
    // (31 bytes) plus one complete primitive so even an adversarial u8/u64 sequence cannot index
    // beyond the gather buffer.
    fifo_queue: [u8; FIFO_GATHER_CAPACITY],
    fifo_queue_index: usize,
}

impl Default for Interface {
    fn default() -> Self {
        Self {
            mask: Default::default(),
            fifo_start: Default::default(),
            fifo_end: Default::default(),
            fifo_current: Default::default(),

            fifo_queue: [0; FIFO_GATHER_CAPACITY],
            fifo_queue_index: 0,
        }
    }
}

/// Returns which interrupt sources are active (i.e. triggered but maybe masked).
pub fn get_active_interrupts(sys: &System) -> InterruptSources {
    let mut sources = InterruptSources::default();

    // VI
    let mut video = false;
    for i in &sys.video.interrupts {
        video |= i.enable() && i.status();
    }
    sources.set_video_interface(video);

    // PE
    sources.set_pe_token(sys.gpu.pix.interrupt.token() && sys.gpu.pix.interrupt.token_enabled());
    sources.set_pe_finish(sys.gpu.pix.interrupt.finish() && sys.gpu.pix.interrupt.finish_enabled());

    // CP
    sources.set_command_processor(sys.gpu.cmd.interrupt_active());

    // AI
    sources.set_audio_interface(
        sys.audio.control.interrupt() && sys.audio.control.interrupt_enabled(),
    );

    // DSP
    sources.set_dsp_interface(sys.dsp.control.any_interrupt());

    // DI
    sources.set_dvd_interface(sys.disk.status.any_interrupt());

    // SI
    sources.set_serial_interface(sys.serial.any_interrupt());

    // EXI
    sources.set_external_interface(sys.external.interrupt_active());

    sources
}

/// Returns which interrupt sources are raised (i.e. triggered and unmasked).
pub fn get_raised_interrupts(sys: &System) -> InterruptSources {
    let mut raised = InterruptSources::from_bits(
        self::get_active_interrupts(sys).to_bits() & sys.processor.mask.sources().to_bits(),
    );
    if sys.resident_pixel_engine_pi_delivery_enabled() {
        raised.set_pe_token(false);
        raised.set_pe_finish(false);
    }
    raised
}

/// Checks whether any of the currently raised interrutps can be taken and, if any, raises the
/// interrupt exception.
pub fn check_interrupts(sys: &mut System) {
    if !sys.cpu.supervisor.config.msr.interrupts() {
        return;
    }

    let raised = self::get_raised_interrupts(sys);
    if raised.to_bits().value() != 0 {
        tracing::debug!("raising interrupt exception for {raised:?}");
        sys.cpu.raise_exception(Exception::Interrupt);
    }
}

/// Samples every raised PI source except the Pixel Engine token and finish levels.
///
/// The browser-resident machine services CP before PE. PE owns its own level-delivery
/// bookkeeping in that later phase, so sampling PE here would raise the same architectural
/// interrupt without marking either resident PE source as delivered. Native callers that do not
/// split device service into phases should continue to use [`check_interrupts`].
pub fn check_interrupts_excluding_pixel_engine(sys: &mut System) {
    if !sys.cpu.supervisor.config.msr.interrupts() {
        return;
    }

    let mut raised = self::get_raised_interrupts(sys);
    raised.set_pe_token(false);
    raised.set_pe_finish(false);
    if raised.to_bits().value() != 0 {
        tracing::debug!("raising non-PE interrupt exception for {raised:?}");
        sys.cpu.raise_exception(Exception::Interrupt);
    }
}

/// Returns the number of bytes retained in the PI write-gather carry before its next 32-byte
/// publication to the FIFO.
pub const fn fifo_pending_bytes(sys: &System) -> usize {
    sys.processor.fifo_queue_index
}

/// Resets the PI write-gather carry and CP decoder/interrupt state without rewriting FIFO
/// pointers or the authoritative distance.
pub fn reset_fifo(sys: &mut System) {
    sys.processor.fifo_queue.fill(0);
    sys.processor.fifo_queue_index = 0;

    let cmd = &mut sys.gpu.cmd;
    cmd.record_resident_fifo_reset();
    cmd.reset_native_decode_fault();
    cmd.control = gx::cmd::Control::from_bits(0x0010);
    cmd.fifo.high_mark = 0x03ff_ffe0;
    cmd.fifo.low_mark = 0;
    cmd.status = Default::default();

    if !sys.scheduler.contains(self::check_interrupts) {
        sys.scheduler.schedule_now(self::check_interrupts);
    }
}

/// Pushes a value into the PI FIFO. Values are queued up until 32 bytes are available, then
/// written all at once.
pub fn fifo_push<P: Primitive>(sys: &mut System, value: P) {
    let Some(write_end) = sys
        .processor
        .fifo_queue_index
        .checked_add(size_of::<P>())
        .filter(|end| *end <= sys.processor.fifo_queue.len())
    else {
        tracing::warn!(
            pending = sys.processor.fifo_queue_index,
            incoming = size_of::<P>(),
            "discarding malformed PI write-gather state"
        );
        sys.processor.fifo_queue.fill(0);
        sys.processor.fifo_queue_index = 0;
        return;
    };
    value.write_be_bytes(&mut sys.processor.fifo_queue[sys.processor.fifo_queue_index..write_end]);
    sys.processor.fifo_queue_index = write_end;

    if sys.processor.fifo_queue_index < FIFO_BURST_BYTES {
        return;
    }

    let mut data = [0; FIFO_BURST_BYTES];
    data.copy_from_slice(&sys.processor.fifo_queue[..FIFO_BURST_BYTES]);

    sys.processor
        .fifo_queue
        .copy_within(FIFO_BURST_BYTES..sys.processor.fifo_queue_index, 0);
    sys.processor.fifo_queue_index -= FIFO_BURST_BYTES;

    let start = sys.processor.fifo_start;
    let end = sys.processor.fifo_end;
    let current = sys.processor.fifo_current.address();
    let redirect = end == 0x0400_0000;
    let linked = sys.gpu.cmd.control.linked_mode();
    let mut cp_service_window_used = false;
    let ram_len = RAM_LEN as u32;
    let ram_backed = if redirect {
        current
            .value()
            .checked_add(FIFO_BURST_BYTES as u32)
            .is_some_and(|end| end <= ram_len)
    } else {
        end.value()
            .checked_add(FIFO_BURST_BYTES as u32)
            .is_some_and(|end| end <= ram_len)
    };
    let valid = start.value().is_multiple_of(32)
        && end.value().is_multiple_of(32)
        && current.value().is_multiple_of(32)
        && ram_backed
        && start <= end
        && current >= start
        && if redirect {
            current < end
        } else {
            current <= end
        }
        // FifoCurrent exposes only 26 address bits, so the one-past redirect sentinel cannot be
        // represented. Fail closed before reaching it instead of wrapping into physical zero.
        && (!redirect
            || current
                .value()
                .checked_add(32)
                .is_some_and(|next| next < end.value()));
    if !valid {
        tracing::warn!(
            ?start,
            ?end,
            ?current,
            "dropping burst for malformed PI FIFO state"
        );
        return;
    }

    if linked {
        gx::cmd::sync_to_pi(sys);
        if !sys.gpu.cmd.fifo.can_append_burst() && sys.gpu.cmd.control.fifo_read_enable() {
            gx::cmd::consume(sys);
            cp_service_window_used = true;
            gx::cmd::sync_to_pi(sys);
        }
        if !sys.gpu.cmd.fifo.can_append_burst() {
            tracing::warn!(
                distance = sys.gpu.cmd.fifo.count(),
                start = ?sys.gpu.cmd.fifo.start,
                end = ?sys.gpu.cmd.fifo.end,
                "dropping linked PI burst that exceeds its CP FIFO span"
            );
            return;
        }
    }

    for (offset, byte) in data.into_iter().enumerate() {
        sys.write_phys_slow(current + offset as u32, byte);
    }

    if !redirect && current == end {
        sys.processor.fifo_current.set_wrapped(true);
        sys.processor.fifo_current.set_address(start);
    } else {
        sys.processor.fifo_current.set_address(current + 32);
    }

    if linked {
        gx::cmd::sync_to_pi(sys);
        if sys.gpu.cmd.fifo.append_burst() {
            // A full FIFO may already have synchronously consumed one complete service window to
            // admit this burst. That drain schedules its own continuation while unread bytes
            // remain; consuming again in the same guest hook would append a second window to the
            // resident handoff queue before the machine can accept the first one.
            if !cp_service_window_used {
                gx::cmd::consume(sys);
            }
        } else {
            tracing::warn!(
                distance = sys.gpu.cmd.fifo.count(),
                start = ?sys.gpu.cmd.fifo.start,
                end = ?sys.gpu.cmd.fifo.end,
                "dropping linked CP publication that exceeds its FIFO span"
            );
        }
    }
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
    use crate::system::gx::cmd::Control;
    use crate::system::scheduler::MachineEventDeadlines;
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
                ipl_lle: false,
                ipl: None,
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    fn restore_external_interrupts(system: &mut System, pc: u32) {
        system.cpu.pc = Address(pc);
        system.cpu.supervisor.config.msr.set_interrupts(true);
    }

    #[test]
    fn pending_fifo_bytes_track_partial_gather_and_reset() {
        let mut system = test_system();
        assert_eq!(fifo_pending_bytes(&system), 0);

        fifo_push(&mut system, 0x0102_0304_u32);
        assert_eq!(fifo_pending_bytes(&system), 4);

        fifo_push(&mut system, 0x0506_u16);
        assert_eq!(fifo_pending_bytes(&system), 6);

        reset_fifo(&mut system);
        assert_eq!(fifo_pending_bytes(&system), 0);
    }

    #[test]
    fn adversarial_primitive_crossing_gather_boundary_is_bounded() {
        let mut system = test_system();
        system.processor.fifo_start = Address(0x100);
        system.processor.fifo_end = Address(0x160);
        system.processor.fifo_current.set_address(Address(0x100));
        system.gpu.cmd.control = Control::from_bits(0);

        for byte in 0..31_u8 {
            fifo_push(&mut system, byte);
        }
        assert_eq!(fifo_pending_bytes(&system), 31);

        fifo_push(&mut system, 0x1122_3344_5566_7788_u64);
        assert_eq!(fifo_pending_bytes(&system), 7);
        assert_eq!(system.processor.fifo_current.address(), Address(0x120));
        for byte in 0..31_u8 {
            assert_eq!(
                system.read_phys_slow::<u8>(Address(0x100 + u32::from(byte))),
                byte
            );
        }
        assert_eq!(system.read_phys_slow::<u8>(Address(0x11f)), 0x11);
        assert_eq!(
            &system.processor.fifo_queue[..7],
            &[0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
        );
    }

    #[test]
    fn full_linked_fifo_publishes_one_burst_with_one_bounded_cp_window() {
        const FIFO_START: Address = Address(0x0000_1000);
        const FIFO_SPAN_BYTES: u32 = 0x000c_0000;
        const FIFO_END: Address = Address(FIFO_START.0 + FIFO_SPAN_BYTES - 32);
        const SERVICE_WINDOW_BYTES: usize = 256 * 1024;
        const BURST: [u32; 8] = [
            0x0102_0304,
            0x1112_1314,
            0x2122_2324,
            0x3132_3334,
            0x4142_4344,
            0x5152_5354,
            0x6162_6364,
            0x7172_7374,
        ];

        let mut system = test_system();
        system.processor.fifo_start = FIFO_START;
        system.processor.fifo_end = FIFO_END;
        system.processor.fifo_current.set_address(FIFO_START);

        // A full linked FIFO needs one synchronous drain to admit the new write-gather burst.
        // The breakpoint remains beyond that first window so the retained continuation, rather
        // than this guest hook, owns all later consumption.
        system.gpu.cmd.control = Control::from_bits(0x0017);
        system.gpu.cmd.fifo.start = FIFO_START;
        system.gpu.cmd.fifo.end = FIFO_END;
        system.gpu.cmd.fifo.high_mark = FIFO_SPAN_BYTES - 32;
        system.gpu.cmd.fifo.low_mark = 0;
        system.gpu.cmd.fifo.distance = FIFO_SPAN_BYTES;
        system.gpu.cmd.fifo.write_ptr = FIFO_START;
        system.gpu.cmd.fifo.read_ptr = FIFO_START;
        system.gpu.cmd.fifo.breakpoint = FIFO_START + 0x000a_0000;

        for word in BURST {
            fifo_push(&mut system, word);
        }

        assert_eq!(system.gpu.cmd.queue.len(), SERVICE_WINDOW_BYTES);
        assert_eq!(
            system.gpu.cmd.fifo.read_ptr,
            FIFO_START + SERVICE_WINDOW_BYTES as u32
        );
        assert_eq!(
            system.gpu.cmd.fifo.distance,
            FIFO_SPAN_BYTES - SERVICE_WINDOW_BYTES as u32 + 32
        );
        assert_eq!(system.processor.fifo_current.address(), FIFO_START + 32);
        assert_eq!(system.gpu.cmd.fifo.write_ptr, FIFO_START + 32);
        assert_eq!(system.gpu.cmd.fifo.breakpoint, FIFO_START + 0x000a_0000);
        assert!(system.gpu.cmd.status.fifo_overflow());
        assert!(!system.gpu.cmd.breakpoint_level());
        assert!(system.scheduler.contains(gx::cmd::consume));

        for (offset, expected) in BURST.into_iter().enumerate() {
            assert_eq!(
                system.read_phys_slow::<u32>(FIFO_START + (offset * 4) as u32),
                expected
            );
        }
    }

    #[test]
    fn cp_phase_excludes_pe_then_resident_pe_delivers_its_level_exactly_once() {
        const BP_PIXEL_TOKEN_INTERRUPT: u8 = 0x48;

        let mut system = test_system();
        let mut deadlines = MachineEventDeadlines::default();

        // Assert and enable a resident PE token level.
        system
            .gpu
            .pix
            .apply_resident_bp_load(BP_PIXEL_TOKEN_INTERRUPT, 0x1234, 10, &mut deadlines)
            .unwrap();
        system.write_resident_pixel_engine_control_masked(0x0001, u16::MAX);

        // Assert a simultaneous CP high-watermark level.
        system.gpu.cmd.control = Control::from_bits(0x0005);
        system.gpu.cmd.fifo.high_mark = 0x40;
        system.gpu.cmd.fifo.distance = 0x60;
        system.gpu.cmd.refresh_interrupt_latches();

        let mut mask = InterruptSources::default();
        mask.set_command_processor(true);
        mask.set_pe_token(true);
        system.processor.mask.set_sources(mask);
        system.cpu.supervisor.config.msr.set_exception_prefix(false);

        restore_external_interrupts(&mut system, 0x8000_1000);
        check_interrupts_excluding_pixel_engine(&mut system);
        assert_eq!(system.cpu.pc, Address(0x0000_0500));
        assert_eq!(system.cpu.supervisor.exception.srr[0], 0x8000_1000);
        assert!(!system.gpu.pix.resident.token_interrupt_delivered());

        // Repeated CP-phase sampling can deliver the still-active CP source, but it must not
        // consume or otherwise mutate PE's resident delivery state.
        restore_external_interrupts(&mut system, 0x8000_2000);
        check_interrupts_excluding_pixel_engine(&mut system);
        assert_eq!(system.cpu.pc, Address(0x0000_0500));
        assert_eq!(system.cpu.supervisor.exception.srr[0], 0x8000_2000);
        assert!(!system.gpu.pix.resident.token_interrupt_delivered());

        // With CP disabled, PE alone is invisible to the CP-phase sampler.
        system
            .gpu
            .cmd
            .control
            .set_fifo_overflow_interrupt_enable(false);
        assert!(!system.gpu.cmd.interrupt_active());
        restore_external_interrupts(&mut system, 0x8000_3000);
        check_interrupts_excluding_pixel_engine(&mut system);
        assert_eq!(system.cpu.pc, Address(0x8000_3000));
        assert!(!system.gpu.pix.resident.token_interrupt_delivered());

        let delivered = system
            .service_resident_pixel_engine(10, &mut deadlines)
            .unwrap();
        assert!(delivered.delivery.token);
        assert!(!delivered.delivery.finish);
        assert_eq!(system.cpu.pc, Address(0x0000_0500));
        assert!(system.gpu.pix.resident.token_interrupt_delivered());

        restore_external_interrupts(&mut system, 0x8000_4000);
        let repeated = system
            .service_resident_pixel_engine(11, &mut deadlines)
            .unwrap();
        assert!(!repeated.delivery.any());
        assert_eq!(system.cpu.pc, Address(0x8000_4000));
        assert!(system.gpu.pix.resident.token_interrupt_delivered());
    }

    #[test]
    fn generic_interrupt_sampling_continues_to_observe_pixel_engine_levels() {
        let mut system = test_system();
        assert!(!system.resident_pixel_engine_pi_delivery_enabled());
        system.gpu.pix.interrupt.set_token(true);
        system.gpu.pix.interrupt.set_token_enabled(true);
        let mut mask = InterruptSources::default();
        mask.set_pe_token(true);
        system.processor.mask.set_sources(mask);
        system.cpu.supervisor.config.msr.set_exception_prefix(false);
        restore_external_interrupts(&mut system, 0x8000_5000);

        check_interrupts(&mut system);

        assert_eq!(system.cpu.pc, Address(0x0000_0500));
        assert_eq!(system.cpu.supervisor.exception.srr[0], 0x8000_5000);
    }

    #[test]
    fn resident_pe_delivery_mode_blocks_cross_device_generic_resampling() {
        const BP_PIXEL_TOKEN_INTERRUPT: u8 = 0x48;

        let mut system = test_system();
        let mut deadlines = MachineEventDeadlines::default();
        system.set_resident_pixel_engine_pi_delivery(true);
        assert!(system.resident_pixel_engine_pi_delivery_enabled());

        system
            .gpu
            .pix
            .apply_resident_bp_load(BP_PIXEL_TOKEN_INTERRUPT, 0x5678, 10, &mut deadlines)
            .unwrap();
        system.write_resident_pixel_engine_control_masked(0x0001, u16::MAX);
        let mut mask = InterruptSources::default();
        mask.set_pe_token(true);
        system.processor.mask.set_sources(mask);
        system.cpu.supervisor.config.msr.set_exception_prefix(false);
        restore_external_interrupts(&mut system, 0x8000_6000);

        let first = system
            .service_resident_pixel_engine(10, &mut deadlines)
            .unwrap();
        assert!(first.delivery.token);
        assert_eq!(system.cpu.pc, Address(0x0000_0500));
        assert!(system.gpu.pix.resident.token_interrupt_delivered());
        assert!(get_active_interrupts(&system).pe_token());
        assert!(!get_raised_interrupts(&system).pe_token());

        // AI performs a generic PI sample internally. The already-delivered PE level remains
        // architecturally active, but resident mode keeps it from re-entering the handler.
        restore_external_interrupts(&mut system, 0x8000_7000);
        system
            .service_resident_audio_interface(11, &mut deadlines)
            .unwrap();
        assert_eq!(system.cpu.pc, Address(0x8000_7000));
        assert!(system.cpu.supervisor.config.msr.interrupts());
        assert!(system.gpu.pix.resident.token_interrupt_delivered());
        assert!(get_active_interrupts(&system).pe_token());

        // SI has another generic sampling path; it must obey the same machine-owned policy.
        crate::system::si::write_status(&mut system, crate::system::si::Status::default());
        assert_eq!(system.cpu.pc, Address(0x8000_7000));
        assert!(system.cpu.supervisor.config.msr.interrupts());
        assert!(system.gpu.pix.resident.token_interrupt_delivered());

        let repeated = system
            .service_resident_pixel_engine(12, &mut deadlines)
            .unwrap();
        assert!(!repeated.delivery.any());
        assert_eq!(system.cpu.pc, Address(0x8000_7000));

        // Delivery ownership is machine policy and therefore survives a PE hardware reset.
        system.reset_resident_pixel_engine(&mut deadlines);
        assert!(system.resident_pixel_engine_pi_delivery_enabled());
    }
}
