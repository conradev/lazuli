use dspint::{DspBus, DspControl, DspDma, DspDmaControl, DspMailbox, ExecStopReason, Interpreter};
use lazuli::Address;
use lazuli::cores::DspCore;
use lazuli::system::System;

use super::{DSP_COEF, DSP_ROM};

pub struct Core {
    interpreter: Interpreter,
}

struct SystemBus<'a>(&'a mut System);

impl DspBus for SystemBus<'_> {
    fn dsp_control(&self) -> DspControl {
        DspControl {
            reset: self.0.dsp.control.reset(),
            reset_high: self.0.dsp.control.reset_high(),
            halted: self.0.dsp.control.halt(),
            cpu_to_dsp_interrupt: self.0.dsp.control.cpu_to_dsp_interrupt(),
        }
    }

    fn set_dsp_control(&mut self, control: DspControl) {
        self.0.dsp.control.set_reset(control.reset);
        self.0.dsp.control.set_reset_high(control.reset_high);
        self.0.dsp.control.set_halt(control.halted);
        self.0
            .dsp
            .control
            .set_cpu_to_dsp_interrupt(control.cpu_to_dsp_interrupt);
    }

    fn dsp_dma(&self) -> DspDma {
        DspDma {
            ram_base: self.0.dsp.dsp_dma.ram_base,
            dsp_base: self.0.dsp.dsp_dma.dsp_base,
            length: self.0.dsp.dsp_dma.length,
            control: DspDmaControl::from_bits(self.0.dsp.dsp_dma.control.to_bits()),
        }
    }

    fn set_dsp_dma(&mut self, dma: DspDma) {
        self.0.dsp.dsp_dma.ram_base = dma.ram_base;
        self.0.dsp.dsp_dma.dsp_base = dma.dsp_base;
        self.0.dsp.dsp_dma.length = dma.length;
        self.0.dsp.dsp_dma.control =
            lazuli::system::dspi::DspDmaControl::from_bits(dma.control.to_bits());
    }

    fn dsp_mailbox(&self) -> DspMailbox {
        DspMailbox::from_bits(self.0.dsp.dsp_mailbox.to_bits())
    }

    fn set_dsp_mailbox(&mut self, mailbox: DspMailbox) {
        self.0.dsp.dsp_mailbox = lazuli::system::dspi::Mailbox::from_bits(mailbox.to_bits());
    }

    fn cpu_mailbox(&self) -> DspMailbox {
        DspMailbox::from_bits(self.0.dsp.cpu_mailbox.to_bits())
    }

    fn set_cpu_mailbox(&mut self, mailbox: DspMailbox) {
        self.0.dsp.cpu_mailbox = lazuli::system::dspi::Mailbox::from_bits(mailbox.to_bits());
    }

    fn main_ram(&self) -> &[u8] {
        self.0.mem.ram()
    }

    fn main_ram_mut(&mut self) -> &mut [u8] {
        self.0.mem.ram_mut()
    }

    fn main_ram_write_completed(&mut self, address: u32, length: usize) {
        self.0
            .cpu
            .reservation
            .invalidate_range(Address(address), length);
    }

    fn aram(&self) -> &[u8] {
        self.0.dsp.aram.as_slice()
    }

    fn aram_mut(&mut self) -> &mut [u8] {
        self.0.dsp.aram.as_mut_slice()
    }

    fn request_cpu_interrupt(&mut self) {
        self.0.dsp.control.set_dsp_to_cpu_interrupt(true);
        self.0
            .scheduler
            .schedule(0, lazuli::system::pi::check_interrupts);
    }
}

impl Default for Core {
    fn default() -> Self {
        let mut interpreter = Interpreter::default();
        interpreter.mem.irom.copy_from_slice(&DSP_ROM[..]);
        interpreter.mem.coef.copy_from_slice(&DSP_COEF[..]);

        Self { interpreter }
    }
}

impl DspCore for Core {
    fn exec(&mut self, sys: &mut System, instructions: u32) -> u32 {
        let mut bus = SystemBus(sys);
        let outcome = self.interpreter.exec(&mut bus, instructions);

        if let ExecStopReason::BusFault(fault) = outcome.stop_reason {
            panic!("DSP interpreter bus fault: {fault:?}");
        }
        outcome.executed_instructions
    }
}

#[cfg(test)]
mod tests {
    use lazuli::modules::audio::NopAudioModule;
    use lazuli::modules::debug::NopDebugModule;
    use lazuli::modules::disk::NopDiskModule;
    use lazuli::modules::input::NopInputModule;
    use lazuli::modules::render::NopRenderModule;
    use lazuli::modules::vertex::NopVertexModule;
    use lazuli::system::{Config, Modules};

    use super::*;

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

    #[test]
    fn dsp_ram_writes_invalidate_only_overlapping_cpu_reservations() {
        let mut sys = test_system();
        sys.cpu.reservation.reserve(Address(0x80));

        let mut bus = SystemBus(&mut sys);
        bus.main_ram_mut()[0x20..0x24].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        bus.main_ram_write_completed(0x20, 4);
        assert!(bus.0.cpu.reservation.is_valid());

        bus.0.cpu.reservation.reserve(Address(0x22));
        bus.main_ram_mut()[0x20..0x24].copy_from_slice(&[0x55, 0x66, 0x77, 0x88]);
        bus.main_ram_write_completed(0x20, 4);
        assert!(!bus.0.cpu.reservation.is_valid());
        assert_eq!(&bus.0.mem.ram()[0x20..0x24], &[0x55, 0x66, 0x77, 0x88]);
    }

    #[test]
    fn core_reports_zero_instructions_for_a_preexisting_halt() {
        let mut sys = test_system();
        sys.dsp.control.set_halt(true);
        let mut core = Core::default();

        assert_eq!(core.exec(&mut sys, 8), 0);
    }
}
