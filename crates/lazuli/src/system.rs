//! State of the system (i.e. GameCube and emulator).

pub mod bus;
pub mod eabi;
pub mod executable;
pub mod ipl;
pub mod lazy;
pub mod mmu;
pub mod os;
pub mod scheduler;

pub mod ai;
pub mod di;
pub mod dspi;
pub mod exi;
pub mod gx;
pub mod mem;
pub mod pi;
pub mod si;
pub mod vi;

use std::io::{Cursor, SeekFrom};

use disks::binrw::BinRead;
use disks::{apploader, dol, iso};
use easyerr::{Error, ResultExt};
use gekko::{Address, Cpu, Cycles};

use crate::modules::audio::AudioModule;
use crate::modules::debug::DebugModule;
use crate::modules::disk::DiskModule;
use crate::modules::input::InputModule;
use crate::modules::render::RenderModule;
use crate::modules::vertex::VertexModule;
use crate::system::dspi::{ARAM_LEN, Dsp};
use crate::system::executable::Executable;
use crate::system::gx::Gpu;
use crate::system::ipl::Ipl;
use crate::system::lazy::Lazy;
use crate::system::mem::{MappedMemoryBacking, Memory};
use crate::system::mmu::{
    Mpc750Mmu, RangeTranslation, RangeTranslationFault, TlbInvalidation, Translation,
    TranslationEffect, TranslationFault, TranslationRegisters,
};
use crate::system::scheduler::{HandlerCtx, Scheduler};

/// System configuration.
pub struct Config {
    pub ipl_lle: bool,
    pub ipl: Option<Vec<u8>>,
    pub sideload: Option<Executable>,
    pub perform_efb_copies: bool,
    pub uart_escape: bool,
}

/// System modules.
pub struct Modules {
    pub audio: Box<dyn AudioModule>,
    pub debug: Box<dyn DebugModule>,
    pub disk: Box<dyn DiskModule>,
    pub input: Box<dyn InputModule>,
    pub render: Box<dyn RenderModule>,
    pub vertex: Box<dyn VertexModule>,
}

/// System state.
pub struct System {
    /// System configuration.
    pub config: Config,
    /// System modules.
    pub modules: Modules,
    /// Scheduler for events.
    pub scheduler: Scheduler,
    /// The CPU state.
    pub cpu: Cpu,
    /// The GPU state.
    pub gpu: Gpu,
    /// The DSP state.
    pub dsp: Dsp,
    /// System memory.
    pub mem: Memory,
    /// Architected MPC750 instruction/data translation state.
    ///
    /// This is deliberately part of the machine rather than a JIT/browser cache: TLB residency,
    /// replacement, and PTE R/C updates are guest-visible CPU behavior.
    pub mmu: Mpc750Mmu,
    /// State of mechanisms that update lazily (e.g. time related registers).
    pub lazy: Lazy,
    /// The video interface.
    pub video: vi::Interface,
    /// The processor interface.
    pub processor: pi::Interface,
    /// The external interface.
    pub external: exi::Interface,
    /// The audio interface.
    pub audio: ai::Interface,
    /// The disk interface.
    pub disk: di::Interface,
    /// The serial interface.
    pub serial: si::Interface,
}

/// Fixed external memory windows used by a browser-resident [`System`].
pub struct MappedSystemBacking {
    memory: MappedMemoryBacking,
    aram: &'static mut [u8; ARAM_LEN],
}

impl MappedSystemBacking {
    #[must_use]
    pub fn new(memory: MappedMemoryBacking, aram: &'static mut [u8; ARAM_LEN]) -> Self {
        Self { memory, aram }
    }
}

#[derive(Debug, Error)]
pub enum LoadApploaderError {
    #[error(transparent)]
    Io { source: std::io::Error },
    #[error(transparent)]
    Apploader { source: disks::binrw::Error },
}

impl System {
    /// Publishes the retail/apploader HLE launch translation state for a loaded executable.
    ///
    /// The browser boot planner writes the executable through physical MEM1 before calling this
    /// seam.  Keeping the launch transition here prevents a browser adapter from choosing BAT,
    /// page-table, or MSR policy and matches the established browser/native HLE contract:
    /// default Dolphin OS BATs, empty hashed-page registers, IR/DR enabled, low exception vectors,
    /// and no stale resident TLB entries.
    pub fn launch_hle_executable(&mut self, entry: Address) {
        self.cpu.supervisor.memory.sr.fill(0);
        self.cpu.supervisor.memory.sdr1 = 0;
        self.cpu.supervisor.memory.setup_default_bats();
        self.mem.build_bat_lut(&self.cpu.supervisor.memory);
        self.mmu.reset();

        let msr = &mut self.cpu.supervisor.config.msr;
        *msr = Default::default();
        msr.set_exception_prefix(false);
        msr.set_instr_addr_translation(true);
        msr.set_data_addr_translation(true);
        self.cpu.pc = entry;
    }

    /// Resolves one data access through the machine-owned MPC750 MMU.
    pub fn translate_data_mmu(
        &mut self,
        effective: Address,
        write: bool,
        effect: TranslationEffect,
    ) -> Result<Translation, TranslationFault> {
        let registers = TranslationRegisters::from_cpu(&self.cpu);
        self.mmu
            .translate_data(&mut self.mem, &registers, effective.value(), write, effect)
    }

    /// Resolves one instruction fetch through the machine-owned MPC750 MMU.
    pub fn translate_instruction_mmu(
        &mut self,
        effective: Address,
        effect: TranslationEffect,
    ) -> Result<Translation, TranslationFault> {
        let registers = TranslationRegisters::from_cpu(&self.cpu);
        self.mmu
            .translate_instruction(&mut self.mem, &registers, effective.value(), effect)
    }

    /// Atomically resolves a contiguous data access through the machine-owned MMU.
    pub fn translate_data_range_mmu(
        &mut self,
        effective: Address,
        len: u64,
        write: bool,
        effect: TranslationEffect,
    ) -> Result<RangeTranslation, RangeTranslationFault> {
        let registers = TranslationRegisters::from_cpu(&self.cpu);
        self.mmu.translate_data_range(
            &mut self.mem,
            &registers,
            effective.value(),
            len,
            write,
            effect,
        )
    }

    /// Resolves a contiguous instruction span through the machine-owned MMU.
    pub fn translate_instruction_range_mmu(
        &mut self,
        effective: Address,
        len: u64,
        effect: TranslationEffect,
    ) -> Result<RangeTranslation, RangeTranslationFault> {
        let registers = TranslationRegisters::from_cpu(&self.cpu);
        self.mmu.translate_instruction_range(
            &mut self.mem,
            &registers,
            effective.value(),
            len,
            effect,
        )
    }

    /// Invalidates the architecturally selected ITLB/DTLB set.
    pub fn invalidate_translation(&mut self, effective: Address) -> TlbInvalidation {
        self.mmu.tlbie(effective.value())
    }

    fn load_apploader(&mut self) -> Result<Address, LoadApploaderError> {
        self.modules
            .disk
            .seek(SeekFrom::Start(0x2440))
            .context(LoadApploaderCtx::Io)?;

        let apploader = apploader::Apploader::read(&mut self.modules.disk)
            .context(LoadApploaderCtx::Apploader)?;

        let size = apploader.header.size;
        self.mem.ram_mut()[0x0120_0000..][..size as usize].copy_from_slice(&apploader.body);

        Ok(Address(apploader.header.entrypoint))
    }

    fn load_executable(&mut self) {
        let Some(exec) = self.config.sideload.take() else {
            return;
        };

        match &exec {
            Executable::Dol(dol) => {
                self.launch_hle_executable(Address(dol.entrypoint()));

                // zero bss first, let other sections overwrite it if it occurs
                for offset in 0..dol.header.bss_size {
                    self.write(Address(dol.header.bss_target + offset), 0u8);
                }

                for section in dol.text_sections() {
                    for (offset, byte) in section.content.iter().copied().enumerate() {
                        self.write(Address(section.target) + offset as u32, byte);
                    }
                }

                for section in dol.data_sections() {
                    for (offset, byte) in section.content.iter().copied().enumerate() {
                        self.write(Address(section.target) + offset as u32, byte);
                    }
                }
            }
        }

        self.config.sideload = Some(exec);
        tracing::debug!("finished loading executable");
    }

    fn load_ipl_hle(&mut self) {
        self.cpu.supervisor.memory.setup_default_bats();
        self.mem.build_bat_lut(&self.cpu.supervisor.memory);

        self.modules
            .disk
            .seek(SeekFrom::Start(0))
            .context(LoadApploaderCtx::Io)
            .unwrap();

        let header = iso::Header::read(&mut self.modules.disk)
            .context(LoadApploaderCtx::Apploader)
            .unwrap();

        tracing::info!(
            game_code = header.meta.game_code(),
            maker_code = header.meta.maker_code,
            disk_id = header.meta.disk_id,
            version = header.meta.version,
            audio_streaming = header.meta.audio_streaming,
            stream_buffer_size = header.meta.stream_buffer_size,
            "loading '{}' ({}) using IPL HLE",
            header.meta.game_name,
            header
                .meta
                .game_code_str()
                .as_deref()
                .unwrap_or("<unknown>")
        );

        // load apploader
        let entry = self.load_apploader().unwrap();

        // load ipl-hle
        let mut cursor = Cursor::new(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../local/ipl-hle.dol"
        )));
        let ipl = dol::Dol::read(&mut cursor).unwrap();
        self.config.sideload = Some(Executable::Dol(ipl));
        self.load_executable();

        // setup apploader entrypoint for ipl-hle
        self.cpu.user.gpr[3] = entry.value();

        // load dolphin-os globals
        self.write_phys_slow::<u32>(Address(0x00), header.meta.game_code());
        self.write_phys_slow::<u16>(Address(0x04), header.meta.maker_code);
        self.write_phys_slow::<u8>(Address(0x06), header.meta.disk_id);
        self.write_phys_slow::<u8>(Address(0x07), header.meta.version);
        self.write_phys_slow::<u8>(Address(0x08), header.meta.audio_streaming);
        self.write_phys_slow::<u8>(Address(0x09), header.meta.stream_buffer_size);

        self.write_phys_slow::<u32>(Address(0x1C), 0xC233_9F3D); // DVD Magic Word
        self.write_phys_slow::<u32>(Address(0x20), 0x0D15_EA5E); // Boot kind
        self.write_phys_slow::<u32>(Address(0x24), 0x0000_0001); // Version
        self.write_phys_slow::<u32>(Address(0x28), 0x0180_0000); // Physical Memory Size
        self.write_phys_slow::<u32>(Address(0x2C), 0x1000_0005); // Console Type
        self.write_phys_slow::<u32>(Address(0x30), 0x8042_E260); // Arena Low
        self.write_phys_slow::<u32>(Address(0x34), 0x817F_E8C0); // Arena High
        self.write_phys_slow::<u32>(Address(0x38), 0x817F_E8C0); // FST address
        self.write_phys_slow::<u32>(Address(0x3C), 0x0000_0024); // FST max length
        // TODO: deal with TV mode, games hang if it is wrong...
        self.write_phys_slow::<u32>(Address(0xCC), 0x0000_0000); // TV Mode
        self.write_phys_slow::<u32>(Address(0xD0), 0x0100_0000); // ARAM size
        self.write_phys_slow::<u32>(Address(0xF8), 0x09A7_EC80); // Bus clock
        self.write_phys_slow::<u32>(Address(0xFC), 0x1CF7_C580); // CPU clock

        self.video
            .display_config
            .set_video_format(vi::VideoFormat::Pal50);

        // setup MSR
        self.cpu.supervisor.config.msr.set_exception_prefix(false);

        // done :)
    }

    fn load_ipl(&mut self) {
        self.cpu.supervisor.config.msr.set_exception_prefix(true);
        self.cpu.pc = Address(0xFFF0_0100);
    }

    pub fn new(modules: Modules, mut config: Config) -> Self {
        let ipl = match config.ipl.take() {
            Some(source) => Ipl::new(source),
            None => Ipl::bundled_default(),
        };
        let memory = Memory::new(&ipl);
        Self::with_backings(modules, config, memory, Dsp::new())
    }

    /// Constructs a complete system over fixed browser linear-memory windows.
    ///
    /// An owned raw IPL is decoded directly into its mapped window. With no owned source, a
    /// nonzero host-decoded image remains authoritative and an empty window receives the bundled
    /// sparse replacement-font image. No architected RAM, IPL, or ARAM storage is copied into or
    /// allocated from the Rust/Wasm runtime heap.
    pub fn new_mapped(
        modules: Modules,
        mut config: Config,
        mut backing: MappedSystemBacking,
    ) -> Self {
        let mapped_ipl = backing.memory.ipl_mut();
        if let Some(mut source) = config.ipl.take() {
            // Owned configuration bytes retain the native API's raw-retail contract.
            ipl::prepare(&mut source);
            mapped_ipl.copy_from_slice(&source);
        } else if mapped_ipl.iter().all(|byte| *byte == 0) {
            // A newly allocated resident core has no host image. Install the same decoded sparse
            // replacement-font image as the previous browser path.
            ipl::install_bundled_default(mapped_ipl);
        }
        // Mapped `None` is the decoded host-authority contract. A nonzero image (including a
        // client-only retail IPL already decoded by the frontend) is preserved byte-for-byte.

        let MappedSystemBacking { memory, aram } = backing;
        Self::with_backings(
            modules,
            config,
            Memory::new_mapped(memory),
            Dsp::new_mapped(aram),
        )
    }

    fn with_backings(modules: Modules, config: Config, memory: Memory, dsp: Dsp) -> Self {
        let mut scheduler = Scheduler::default();
        scheduler.schedule(1 << 16, gx::cmd::process);

        let mut system = System {
            scheduler,
            cpu: Cpu::default(),
            gpu: Gpu::default(),
            dsp,
            mem: memory,
            mmu: Mpc750Mmu::new(),
            lazy: Lazy::default(),
            video: vi::Interface::default(),
            processor: pi::Interface::default(),
            external: exi::Interface::new(),
            audio: ai::Interface::default(),
            disk: di::Interface::default(),
            serial: si::Interface::default(),

            config,
            modules,
        };

        if system.config.ipl_lle {
            system.load_ipl();
        } else if system.config.sideload.is_some() {
            system.load_executable();
        } else if system.modules.disk.has_disk() {
            system.load_ipl_hle();
        } else {
            system.load_ipl();
        }

        system
    }

    /// Processes scheduled events.
    #[inline(always)]
    pub fn process_events(&mut self) {
        while let Some(event) = self.scheduler.pop() {
            let cycles_late = self.scheduler.elapsed() - event.cycle;
            let ctx = HandlerCtx {
                cycles_late: Cycles(cycles_late),
            };

            event.handler.call(self, ctx);
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

    fn nop_modules() -> Modules {
        Modules {
            audio: Box::new(NopAudioModule),
            debug: Box::new(NopDebugModule),
            disk: Box::new(NopDiskModule),
            input: Box::new(NopInputModule),
            render: Box::new(NopRenderModule),
            vertex: Box::new(NopVertexModule),
        }
    }

    #[test]
    fn hle_executable_launch_authors_the_complete_translation_transition() {
        let mut system = System::new(
            nop_modules(),
            Config {
                ipl_lle: false,
                ipl: Some(vec![0; mem::IPL_LEN]),
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        );
        system.cpu.supervisor.memory.sr.fill(u32::MAX);
        system.cpu.supervisor.memory.sdr1 = u32::MAX;
        system.cpu.supervisor.config.msr.set_interrupts(true);

        system.launch_hle_executable(Address(0x8000_1000));

        assert_eq!(system.cpu.pc, Address(0x8000_1000));
        assert_eq!(system.cpu.supervisor.config.msr.to_bits(), 0x30);
        assert_eq!(system.cpu.supervisor.memory.sr, [0; 16]);
        assert_eq!(system.cpu.supervisor.memory.sdr1, 0);
        assert_eq!(
            system
                .translate_instruction_mmu(Address(0x8000_1000), TranslationEffect::Probe)
                .unwrap()
                .physical,
            0x1000
        );
        assert_eq!(
            system
                .translate_data_mmu(Address(0x8000_1000), false, TranslationEffect::Probe)
                .unwrap()
                .physical,
            0x1000
        );
    }

    #[test]
    fn mapped_system_uses_every_external_architected_window() {
        let ram = Box::into_raw(util::boxed_array::<u8, { mem::RAM_LEN }>(0));
        let l2c = Box::into_raw(util::boxed_array::<u8, { mem::L2C_LEN }>(0));
        let ipl = Box::into_raw(util::boxed_array::<u8, { mem::IPL_LEN }>(0));
        let aram = Box::into_raw(util::boxed_array::<u8, ARAM_LEN>(0));
        // A browser host may preload IPL bytes directly into the fixed window and pass no owned
        // Vec. Bytes outside the encrypted payload must survive construction unchanged.
        unsafe { (*ipl)[0x20] = 0xa5 };
        let memory = MappedMemoryBacking::new(
            // SAFETY: All four disjoint boxes remain allocated until after `system` is dropped,
            // and no other references are used while the mapped system owns them.
            unsafe { &mut *ram },
            unsafe { &mut *l2c },
            unsafe { &mut *ipl },
        );
        let backing = MappedSystemBacking::new(memory, unsafe { &mut *aram });
        let mut system = System::new_mapped(
            nop_modules(),
            Config {
                ipl_lle: false,
                ipl: None,
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
            backing,
        );

        assert_eq!(system.mem.ram().as_ptr(), ram.cast::<u8>());
        assert_eq!(system.mem.l2c().as_ptr(), l2c.cast::<u8>());
        assert_eq!(system.mem.ipl().as_ptr(), ipl.cast::<u8>());
        assert_eq!(system.dsp.aram.as_ptr(), aram.cast::<u8>());
        system.mem.ram_mut()[0x40] = 0x12;
        system.mem.l2c_mut()[0x80] = 0x34;
        system.dsp.aram[0xc0] = 0x56;
        drop(system);

        let ram = unsafe { Box::from_raw(ram) };
        let l2c = unsafe { Box::from_raw(l2c) };
        let ipl = unsafe { Box::from_raw(ipl) };
        let aram = unsafe { Box::from_raw(aram) };
        assert_eq!(ram[0x40], 0x12);
        assert_eq!(l2c[0x80], 0x34);
        assert_eq!(aram[0xc0], 0x56);
        assert_eq!(ipl[0x20], 0xa5);
        assert_eq!(ipl[0x100..0x110], [0; 16]);
    }

    #[test]
    fn empty_mapped_ipl_installs_the_decoded_bundled_font_image() {
        let ram = Box::into_raw(util::boxed_array::<u8, { mem::RAM_LEN }>(0));
        let l2c = Box::into_raw(util::boxed_array::<u8, { mem::L2C_LEN }>(0));
        let ipl = Box::into_raw(util::boxed_array::<u8, { mem::IPL_LEN }>(0));
        let aram = Box::into_raw(util::boxed_array::<u8, ARAM_LEN>(0));
        let memory = MappedMemoryBacking::new(
            // SAFETY: The disjoint boxes remain allocated until after the mapped System drops.
            unsafe { &mut *ram },
            unsafe { &mut *l2c },
            unsafe { &mut *ipl },
        );
        let backing = MappedSystemBacking::new(memory, unsafe { &mut *aram });
        let system = System::new_mapped(
            nop_modules(),
            Config {
                ipl_lle: true,
                ipl: None,
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
            backing,
        );

        assert_ne!(
            &system.mem.ipl()[ipl::BUNDLED_FONT_JAPANESE_OFFSET..][..16],
            &[0; 16]
        );
        assert_ne!(
            &system.mem.ipl()[ipl::BUNDLED_FONT_WESTERN_OFFSET..][..16],
            &[0; 16]
        );
        drop(system);

        // SAFETY: System has released every reference to these original allocations.
        unsafe {
            drop(Box::from_raw(ram));
            drop(Box::from_raw(l2c));
            drop(Box::from_raw(ipl));
            drop(Box::from_raw(aram));
        }
    }

    #[test]
    fn owned_mapped_ipl_is_treated_as_raw_and_decoded_into_the_window() {
        let ram = Box::into_raw(util::boxed_array::<u8, { mem::RAM_LEN }>(0));
        let l2c = Box::into_raw(util::boxed_array::<u8, { mem::L2C_LEN }>(0));
        let ipl = Box::into_raw(util::boxed_array::<u8, { mem::IPL_LEN }>(0xa5));
        let aram = Box::into_raw(util::boxed_array::<u8, ARAM_LEN>(0));
        let memory = MappedMemoryBacking::new(
            // SAFETY: The disjoint boxes remain allocated until after the mapped System drops.
            unsafe { &mut *ram },
            unsafe { &mut *l2c },
            unsafe { &mut *ipl },
        );
        let backing = MappedSystemBacking::new(memory, unsafe { &mut *aram });
        let system = System::new_mapped(
            nop_modules(),
            Config {
                ipl_lle: true,
                // A raw all-zero NTSC image has a NUL header and a known first descrambled byte.
                ipl: Some(vec![0; mem::IPL_LEN]),
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
            backing,
        );

        assert_eq!(system.mem.ipl()[0x20], 0);
        assert_eq!(system.mem.ipl()[0x100], 0x89);
        assert_ne!(system.mem.ipl()[0x100], 0);
        drop(system);

        // SAFETY: System has released every reference to these original allocations.
        unsafe {
            drop(Box::from_raw(ram));
            drop(Box::from_raw(l2c));
            drop(Box::from_raw(ipl));
            drop(Box::from_raw(aram));
        }
    }
}
