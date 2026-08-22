use gekko::Exception;

use crate::system::System;
use crate::system::scheduler::{CPU_CYCLES_PER_TIME_BASE_TICK, SchedulerScheduleError};

#[derive(Debug, Default)]
pub struct Lazy {
    pub last_updated_tb: u64,
    pub last_updated_dec: u64,
}

impl System {
    pub fn update_time_base(&mut self) {
        let last_updated = self.lazy.last_updated_tb;
        let now = self.scheduler.elapsed_time_base();
        let delta = now - last_updated;

        let prev = self.cpu.supervisor.misc.tb;
        let new = prev.wrapping_add(delta);

        tracing::trace!(
            "updating time base - now {now}, last updated {last_updated}, since then {delta}. prev: {prev}, new: {new}"
        );

        self.lazy.last_updated_tb = now;
        self.cpu.supervisor.misc.tb = new;
    }

    pub fn update_decrementer(&mut self) {
        let last_updated = self.lazy.last_updated_dec;
        let now = self.scheduler.elapsed_time_base();
        let delta = now - last_updated;

        let prev = self.cpu.supervisor.misc.dec;
        let new = prev.wrapping_sub(delta as u32);

        tracing::trace!(
            "updating dec - now {now}, last updated {last_updated}, since then {delta}. prev: {prev}, new: {new}"
        );

        self.lazy.last_updated_dec = now;
        self.cpu.supervisor.misc.dec = new;
    }

    /// Publishes a guest DEC write and schedules its next nonnegative-to-negative transition.
    ///
    /// DEC changes on the same ticks as the time base. A write between ticks therefore reaches
    /// its first decrement at the next global 12-cycle boundary, rather than 12 cycles after the
    /// write. The exception transition is from zero to `0xffff_ffff`, so it occurs after
    /// `DEC + 1` ticks.
    pub fn decrementer_changed(&mut self) -> Result<(), SchedulerScheduleError> {
        let now = self.scheduler.elapsed();
        self.lazy.last_updated_dec = self.scheduler.elapsed_time_base();
        self.scheduler.cancel(System::decrementer_overflow);

        let ticks = u64::from(self.cpu.supervisor.misc.dec) + 1;
        let cycles_until_next_tick =
            CPU_CYCLES_PER_TIME_BASE_TICK - now % CPU_CYCLES_PER_TIME_BASE_TICK;
        let remaining_cycles = (ticks - 1)
            .checked_mul(CPU_CYCLES_PER_TIME_BASE_TICK)
            .ok_or(SchedulerScheduleError::CycleOverflow)?;
        let delay = cycles_until_next_tick
            .checked_add(remaining_cycles)
            .ok_or(SchedulerScheduleError::CycleOverflow)?;

        tracing::trace!(
            decrementer = self.cpu.supervisor.misc.dec,
            delay,
            "decrementer changed"
        );

        self.scheduler
            .try_schedule(delay, System::decrementer_overflow)
    }

    pub fn decrementer_overflow(&mut self) {
        self.update_decrementer();
        if self.cpu.supervisor.config.msr.interrupts() {
            self.cpu.raise_exception(Exception::Decrementer);
            self.decrementer_changed()
                .expect("decrementer rearm deadline overflowed scheduler time");
        } else {
            self.scheduler.schedule(32, System::decrementer_overflow);
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
    use crate::system::{Config, Modules};

    fn test_system() -> System {
        let mut system = System::new(
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
        );
        system.scheduler.cancel(crate::system::gx::cmd::process);
        system
    }

    #[test]
    fn decrementer_updates_once_per_twelve_cpu_cycles() {
        let mut system = test_system();
        system.cpu.supervisor.misc.dec = 3;
        system.decrementer_changed().unwrap();

        system.scheduler.advance(11);
        system.update_decrementer();
        assert_eq!(system.cpu.supervisor.misc.dec, 3);

        system.scheduler.advance(1);
        system.update_decrementer();
        assert_eq!(system.cpu.supervisor.misc.dec, 2);

        system.scheduler.advance(CPU_CYCLES_PER_TIME_BASE_TICK);
        system.update_decrementer();
        assert_eq!(system.cpu.supervisor.misc.dec, 1);
    }

    #[test]
    fn decrementer_deadline_is_phase_aligned_and_includes_zero_to_negative_tick() {
        for (elapsed, decrementer, expected_delay) in [
            (0, 0, 12),
            (1, 0, 11),
            (11, 0, 1),
            (12, 0, 12),
            (13, 2, 35),
            (23, 2, 25),
        ] {
            let mut system = test_system();
            system.scheduler.advance(elapsed);
            system.cpu.supervisor.misc.dec = decrementer;
            system.decrementer_changed().unwrap();

            assert_eq!(
                system.scheduler.until_next(),
                Some(expected_delay),
                "elapsed={elapsed}, decrementer={decrementer}"
            );
            assert_eq!(
                system.lazy.last_updated_dec,
                elapsed / CPU_CYCLES_PER_TIME_BASE_TICK
            );
        }
    }

    #[test]
    fn maximum_decrementer_waits_a_full_wrapping_period() {
        let mut system = test_system();
        system.scheduler.advance(7);
        system.cpu.supervisor.misc.dec = u32::MAX;
        system.decrementer_changed().unwrap();

        assert_eq!(
            system.scheduler.until_next(),
            Some(5 + u64::from(u32::MAX) * CPU_CYCLES_PER_TIME_BASE_TICK)
        );
    }

    #[test]
    fn disabled_interrupt_poll_delivers_once_then_rearms_next_transition() {
        let mut system = test_system();
        system.cpu.pc = gekko::Address(0x8000_1234);
        system.cpu.supervisor.exception.srr[0] = 0xdead_beef;
        system.cpu.supervisor.config.msr.set_exception_prefix(false);
        system.cpu.supervisor.misc.dec = 0;
        system.decrementer_changed().unwrap();

        system.scheduler.advance(12);
        system.process_events();
        assert_eq!(system.cpu.supervisor.misc.dec, u32::MAX);
        assert_eq!(system.cpu.pc, gekko::Address(0x8000_1234));
        assert_eq!(system.cpu.supervisor.exception.srr[0], 0xdead_beef);
        assert_eq!(system.scheduler.until_next(), Some(32));

        system.cpu.supervisor.config.msr.set_interrupts(true);
        system.scheduler.advance(32);
        system.process_events();
        assert_eq!(system.cpu.supervisor.misc.dec, 0xffff_fffd);
        assert_eq!(system.cpu.pc, gekko::Address(0x0000_0900));
        assert_eq!(system.cpu.supervisor.exception.srr[0], 0x8000_1234);
        assert!(!system.cpu.supervisor.config.msr.interrupts());
        assert_eq!(
            system.scheduler.until_next(),
            Some(4 + u64::from(0xffff_fffdu32) * CPU_CYCLES_PER_TIME_BASE_TICK)
        );

        system.cpu.pc = gekko::Address(0x8000_5678);
        system.cpu.supervisor.config.msr.set_interrupts(true);
        system.scheduler.advance(32);
        system.process_events();
        assert_eq!(system.cpu.pc, gekko::Address(0x8000_5678));
        assert_eq!(system.cpu.supervisor.exception.srr[0], 0x8000_1234);
        assert!(system.cpu.supervisor.config.msr.interrupts());
    }
}
