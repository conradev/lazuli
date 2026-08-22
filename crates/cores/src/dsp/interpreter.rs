use lazuli::cores::DspCore;
use lazuli::system::System;
use lazuli::system::dspi::DspLleStopReason;

/// Legacy trait adapter over the interpreter now owned by [`System::dsp`].
#[derive(Debug, Default)]
pub struct Core;

impl DspCore for Core {
    fn exec(&mut self, sys: &mut System, instructions: u32) -> u32 {
        let outcome = sys.execute_dsp_instructions(instructions);

        if let DspLleStopReason::BusFault(fault) = outcome.stop_reason {
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
    fn core_reports_zero_instructions_for_a_preexisting_halt() {
        let mut sys = test_system();
        sys.dsp.control.set_halt(true);
        let mut core = Core::default();

        assert_eq!(core.exec(&mut sys, 8), 0);
    }
}
