//! Raw DSP interpreter bridge for the browser runtime.
//!
//! The browser owns one WebAssembly memory. This module imports that memory and maps the existing
//! MEM1 and DSP-interface windows plus one in-memory ARAM window without copying them. The host
//! must instantiate at [`LEGACY_MEMORY_INITIAL_PAGES`], initialize once, grow to
//! [`LEGACY_MEMORY_MAXIMUM_PAGES`], and only then execute or create persistent JavaScript views.
//!
//! This standalone bridge is transitional. It owns the allocator range beginning at
//! [`RUNTIME_BASE`] and therefore must not coexist with another Rust module importing the same
//! memory and global base. The unified browser machine must fold `dspint` into its own runtime.

#[cfg(any(target_arch = "wasm32", test))]
use dspint::Interpreter;
use dspint::{DspBus, DspControl, DspDma, DspMailbox};
pub use lazuli_abi::ABI_VERSION;
pub use lazuli_abi::memory::{
    ARAM_BYTES, ARAM_OFFSET, IPL_BYTES, IPL_OFFSET, L2C_BYTES, L2C_OFFSET, LEGACY_MEMORY_BYTES,
    LEGACY_MEMORY_INITIAL_PAGES, LEGACY_MEMORY_MAXIMUM_PAGES, LEGACY_RUNTIME_END,
    MACHINE_RESERVED_END, MAIN_RAM_BYTES, MAIN_RAM_OFFSET, MMIO_BYTES, MMIO_OFFSET, RUNTIME_BASE,
    WASM_PAGE_BYTES,
};

const CPU_MAILBOX_OFFSET: usize = 0x5000;
const DSP_MAILBOX_OFFSET: usize = 0x5004;
const DSP_CONTROL_OFFSET: usize = 0x500a;

const CONTROL_RESET: u16 = 1 << 0;
const CONTROL_CPU_TO_DSP_INTERRUPT: u16 = 1 << 1;
const CONTROL_HALT: u16 = 1 << 2;
const CONTROL_DSP_TO_CPU_INTERRUPT: u16 = 1 << 7;
const CONTROL_RESET_HIGH: u16 = 1 << 11;
const INTERPRETER_CONTROL_MASK: u16 =
    CONTROL_RESET | CONTROL_CPU_TO_DSP_INTERRUPT | CONTROL_HALT | CONTROL_RESET_HIGH;

#[cfg(any(target_arch = "wasm32", test))]
const DSP_ROM_BYTES: &[u8; 8192] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/dsp_rom.bin"
));
#[cfg(any(target_arch = "wasm32", test))]
const DSP_COEF_BYTES: &[u8; 4096] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/dsp_coef.bin"
));

const _: () = assert!(MMIO_OFFSET + MMIO_BYTES <= L2C_OFFSET);
const _: () = assert!(L2C_OFFSET + L2C_BYTES <= MACHINE_RESERVED_END);
const _: () = assert!(MACHINE_RESERVED_END == IPL_OFFSET);
const _: () = assert!(IPL_OFFSET + IPL_BYTES == ARAM_OFFSET);
const _: () = assert!(ARAM_OFFSET + ARAM_BYTES == RUNTIME_BASE);
const _: () = assert!(RUNTIME_BASE < LEGACY_MEMORY_INITIAL_PAGES * WASM_PAGE_BYTES);
const _: () = assert!(LEGACY_MEMORY_INITIAL_PAGES < LEGACY_MEMORY_MAXIMUM_PAGES);

/// Observes a completed DSP-to-MEM1 transfer after all bytes are visible.
pub trait MainRamWriteObserver {
    fn completed(&mut self, address: u32, length: usize);
}

/// Direct browser-memory implementation of [`DspBus`].
///
/// The three byte slices must be disjoint. `dma` is DSP-internal IFX state and is deliberately
/// separate from the CPU-facing ARAM DMA registers in the MMIO slice.
pub struct BrowserBus<'a> {
    main_ram: &'a mut [u8],
    mmio: &'a mut [u8],
    aram: &'a mut [u8],
    dma: &'a mut DspDma,
    write_observer: &'a mut dyn MainRamWriteObserver,
}

impl<'a> BrowserBus<'a> {
    pub fn new(
        main_ram: &'a mut [u8],
        mmio: &'a mut [u8],
        aram: &'a mut [u8],
        dma: &'a mut DspDma,
        write_observer: &'a mut dyn MainRamWriteObserver,
    ) -> Option<Self> {
        if main_ram.len() != MAIN_RAM_BYTES || mmio.len() != MMIO_BYTES || aram.len() != ARAM_BYTES
        {
            return None;
        }
        Some(Self {
            main_ram,
            mmio,
            aram,
            dma,
            write_observer,
        })
    }

    fn read_u16(&self, offset: usize) -> u16 {
        u16::from_be_bytes(self.mmio[offset..offset + 2].try_into().unwrap())
    }

    fn write_u16(&mut self, offset: usize, value: u16) {
        self.mmio[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
    }

    fn read_mailbox(&self, offset: usize) -> DspMailbox {
        let high = u32::from(self.read_u16(offset));
        let low = u32::from(self.read_u16(offset + 2));
        DspMailbox::from_bits((high << 16) | low)
    }

    fn write_mailbox(&mut self, offset: usize, mailbox: DspMailbox) {
        let bits = mailbox.to_bits();
        self.write_u16(offset, (bits >> 16) as u16);
        self.write_u16(offset + 2, bits as u16);
    }
}

impl DspBus for BrowserBus<'_> {
    fn dsp_control(&self) -> DspControl {
        let control = self.read_u16(DSP_CONTROL_OFFSET);
        DspControl {
            reset: control & CONTROL_RESET != 0,
            reset_high: control & CONTROL_RESET_HIGH != 0,
            halted: control & CONTROL_HALT != 0,
            cpu_to_dsp_interrupt: control & CONTROL_CPU_TO_DSP_INTERRUPT != 0,
        }
    }

    fn set_dsp_control(&mut self, control: DspControl) {
        let owned = (if control.reset { CONTROL_RESET } else { 0 })
            | (if control.cpu_to_dsp_interrupt {
                CONTROL_CPU_TO_DSP_INTERRUPT
            } else {
                0
            })
            | (if control.halted { CONTROL_HALT } else { 0 })
            | (if control.reset_high {
                CONTROL_RESET_HIGH
            } else {
                0
            });
        let current = self.read_u16(DSP_CONTROL_OFFSET);
        self.write_u16(
            DSP_CONTROL_OFFSET,
            (current & !INTERPRETER_CONTROL_MASK) | owned,
        );
    }

    fn dsp_dma(&self) -> DspDma {
        *self.dma
    }

    fn set_dsp_dma(&mut self, dma: DspDma) {
        *self.dma = dma;
    }

    fn dsp_mailbox(&self) -> DspMailbox {
        self.read_mailbox(DSP_MAILBOX_OFFSET)
    }

    fn set_dsp_mailbox(&mut self, mailbox: DspMailbox) {
        self.write_mailbox(DSP_MAILBOX_OFFSET, mailbox);
    }

    fn cpu_mailbox(&self) -> DspMailbox {
        self.read_mailbox(CPU_MAILBOX_OFFSET)
    }

    fn set_cpu_mailbox(&mut self, mailbox: DspMailbox) {
        self.write_mailbox(CPU_MAILBOX_OFFSET, mailbox);
    }

    fn main_ram(&self) -> &[u8] {
        self.main_ram
    }

    fn main_ram_mut(&mut self) -> &mut [u8] {
        self.main_ram
    }

    fn main_ram_write_completed(&mut self, address: u32, length: usize) {
        self.write_observer.completed(address, length);
    }

    fn aram(&self) -> &[u8] {
        self.aram
    }

    fn aram_mut(&mut self) -> &mut [u8] {
        self.aram
    }

    fn request_cpu_interrupt(&mut self) {
        let control = self.read_u16(DSP_CONTROL_OFFSET);
        self.write_u16(DSP_CONTROL_OFFSET, control | CONTROL_DSP_TO_CPU_INTERRUPT);
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn initialized_interpreter() -> Interpreter {
    let mut interpreter = Interpreter::default();
    for (word, bytes) in interpreter
        .mem
        .irom
        .iter_mut()
        .zip(DSP_ROM_BYTES.chunks_exact(2))
    {
        *word = u16::from_be_bytes(bytes.try_into().unwrap());
    }
    for (word, bytes) in interpreter
        .mem
        .coef
        .iter_mut()
        .zip(DSP_COEF_BYTES.chunks_exact(2))
    {
        *word = u16::from_be_bytes(bytes.try_into().unwrap());
    }
    interpreter
}

#[cfg(target_arch = "wasm32")]
mod wasm_abi {
    use core::arch::wasm32::memory_size;
    use std::cell::RefCell;
    use std::slice;

    use dspint::{DspBusFault, DspBusOperation, DspDma, ExecOutcome, ExecStopReason};

    use super::{
        ABI_VERSION, ARAM_BYTES, ARAM_OFFSET, BrowserBus, IPL_BYTES, IPL_OFFSET, L2C_BYTES,
        L2C_OFFSET, LEGACY_MEMORY_BYTES, LEGACY_MEMORY_INITIAL_PAGES, LEGACY_MEMORY_MAXIMUM_PAGES,
        LEGACY_RUNTIME_END, MAIN_RAM_BYTES, MAIN_RAM_OFFSET, MMIO_BYTES, MMIO_OFFSET,
        MainRamWriteObserver, RUNTIME_BASE, initialized_interpreter,
    };

    const STOP_INSTRUCTION_BUDGET: u32 = 0;
    const STOP_HALTED: u32 = 1;
    const STOP_DSP_MAILBOX_FULL: u32 = 2;
    const STOP_CPU_MAILBOX_EMPTY: u32 = 3;
    const STOP_BUS_FAULT: u32 = 4;
    const STOP_NOT_INITIALIZED: u32 = 5;
    const STOP_MEMORY_NOT_SEALED: u32 = 6;

    const INIT_ALREADY_INITIALIZED: u32 = 0;
    const INIT_OK: u32 = 1;
    const INIT_WRONG_MEMORY_SIZE: u32 = 2;

    // Host import contract: this callback may update reservation metadata only. It must not
    // mutate or grow the imported memory and must not re-enter any browser DSP export.
    #[link(wasm_import_module = "lazuli_dsp")]
    unsafe extern "C" {
        fn main_ram_write_completed(address: u32, length: u32);
    }

    struct HostWriteObserver;

    impl MainRamWriteObserver for HostWriteObserver {
        fn completed(&mut self, address: u32, length: usize) {
            let length = u32::try_from(length).expect("DSP write length exceeds the browser ABI");
            // SAFETY: The browser import is synchronous and may only invalidate host CPU
            // reservation metadata. It must not call back into this module or mutate/grow memory.
            unsafe { main_ram_write_completed(address, length) };
        }
    }

    struct Runtime {
        interpreter: dspint::Interpreter,
        dma: DspDma,
        last_outcome: ExecOutcome,
        memory_not_sealed: bool,
    }

    impl Runtime {
        fn new() -> Self {
            Self {
                interpreter: initialized_interpreter(),
                dma: DspDma::default(),
                last_outcome: ExecOutcome {
                    executed_instructions: 0,
                    stop_reason: ExecStopReason::InstructionBudgetExhausted,
                },
                memory_not_sealed: false,
            }
        }

        fn exec(&mut self, budget: u32) -> u32 {
            // SAFETY: The imported-memory minimum puts all three ranges in-bounds and they are
            // pairwise disjoint from each other and the module runtime. The browser seals memory
            // at its 48 MiB maximum before execution; the synchronous callback is forbidden from
            // growing memory or re-entering this module while these mutable slices are live.
            let (main_ram, mmio, aram) = unsafe {
                (
                    slice::from_raw_parts_mut(MAIN_RAM_OFFSET as *mut u8, MAIN_RAM_BYTES),
                    slice::from_raw_parts_mut(MMIO_OFFSET as *mut u8, MMIO_BYTES),
                    slice::from_raw_parts_mut(ARAM_OFFSET as *mut u8, ARAM_BYTES),
                )
            };
            let mut observer = HostWriteObserver;
            let mut bus = BrowserBus::new(main_ram, mmio, aram, &mut self.dma, &mut observer)
                .expect("fixed browser DSP memory layout is invalid");
            self.last_outcome = self.interpreter.exec(&mut bus, budget);
            self.last_outcome.executed_instructions
        }
    }

    thread_local! {
        static RUNTIME: RefCell<Option<Runtime>> = const { RefCell::new(None) };
    }

    fn stop_reason_code(reason: ExecStopReason) -> u32 {
        match reason {
            ExecStopReason::InstructionBudgetExhausted => STOP_INSTRUCTION_BUDGET,
            ExecStopReason::Halted => STOP_HALTED,
            ExecStopReason::DspMailboxFull => STOP_DSP_MAILBOX_FULL,
            ExecStopReason::CpuMailboxEmpty => STOP_CPU_MAILBOX_EMPTY,
            ExecStopReason::BusFault(_) => STOP_BUS_FAULT,
        }
    }

    fn last_fault(runtime: &Runtime) -> Option<DspBusFault> {
        if runtime.memory_not_sealed {
            return None;
        }
        match runtime.last_outcome.stop_reason {
            ExecStopReason::BusFault(fault) => Some(fault),
            _ => None,
        }
    }

    fn fault_operation_code(operation: DspBusOperation) -> u32 {
        match operation {
            DspBusOperation::ReadMainRam => 1,
            DspBusOperation::WriteMainRam => 2,
            DspBusOperation::ValidateAram => 3,
            DspBusOperation::ReadAram => 4,
            DspBusOperation::WriteAram => 5,
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_abi_version() -> u32 {
        ABI_VERSION
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_memory_initial_pages() -> u32 {
        LEGACY_MEMORY_INITIAL_PAGES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_memory_maximum_pages() -> u32 {
        LEGACY_MEMORY_MAXIMUM_PAGES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_memory_bytes() -> u32 {
        LEGACY_MEMORY_BYTES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_main_ram_offset() -> u32 {
        MAIN_RAM_OFFSET as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_main_ram_bytes() -> u32 {
        MAIN_RAM_BYTES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_mmio_offset() -> u32 {
        MMIO_OFFSET as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_mmio_bytes() -> u32 {
        MMIO_BYTES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_l2c_offset() -> u32 {
        L2C_OFFSET as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_l2c_bytes() -> u32 {
        L2C_BYTES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_ipl_offset() -> u32 {
        IPL_OFFSET as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_ipl_bytes() -> u32 {
        IPL_BYTES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_aram_offset() -> u32 {
        ARAM_OFFSET as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_aram_bytes() -> u32 {
        ARAM_BYTES as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_runtime_base() -> u32 {
        RUNTIME_BASE as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_runtime_end() -> u32 {
        LEGACY_RUNTIME_END as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_init() -> u32 {
        RUNTIME.with_borrow_mut(|runtime| {
            if runtime.is_some() {
                return INIT_ALREADY_INITIALIZED;
            }
            if memory_size::<0>() != LEGACY_MEMORY_INITIAL_PAGES {
                return INIT_WRONG_MEMORY_SIZE;
            }
            *runtime = Some(Runtime::new());
            INIT_OK
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_exec(budget: u32) -> u32 {
        RUNTIME.with_borrow_mut(|runtime| {
            let Some(runtime) = runtime.as_mut() else {
                return 0;
            };
            if memory_size::<0>() != LEGACY_MEMORY_MAXIMUM_PAGES {
                runtime.memory_not_sealed = true;
                return 0;
            }
            runtime.memory_not_sealed = false;
            runtime.exec(budget)
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_stop_reason() -> u32 {
        RUNTIME.with_borrow(|runtime| {
            runtime.as_ref().map_or(STOP_NOT_INITIALIZED, |runtime| {
                if runtime.memory_not_sealed {
                    STOP_MEMORY_NOT_SEALED
                } else {
                    stop_reason_code(runtime.last_outcome.stop_reason)
                }
            })
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_pc() -> u32 {
        RUNTIME.with_borrow(|runtime| {
            runtime
                .as_ref()
                .map_or(0, |runtime| u32::from(runtime.interpreter.pc))
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_fault_operation() -> u32 {
        RUNTIME.with_borrow(|runtime| {
            runtime
                .as_ref()
                .and_then(last_fault)
                .map_or(0, |fault| fault_operation_code(fault.operation))
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_fault_address() -> u32 {
        RUNTIME.with_borrow(|runtime| {
            runtime
                .as_ref()
                .and_then(last_fault)
                .map_or(0, |fault| fault.address)
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_fault_length() -> u32 {
        RUNTIME.with_borrow(|runtime| {
            runtime
                .as_ref()
                .and_then(last_fault)
                .map_or(0, |fault| fault.length)
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn browser_dsp_fault_memory_length() -> u32 {
        RUNTIME.with_borrow(|runtime| {
            runtime
                .as_ref()
                .and_then(last_fault)
                .map_or(0, |fault| fault.memory_length)
        })
    }
}

#[cfg(test)]
mod tests {
    use dspint::{DspBus, DspDmaControl, DspMailbox, Interpreter};

    use super::*;

    #[derive(Default)]
    struct RecordingObserver(Vec<(u32, usize)>);

    impl MainRamWriteObserver for RecordingObserver {
        fn completed(&mut self, address: u32, length: usize) {
            self.0.push((address, length));
        }
    }

    fn memory() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        (
            vec![0; MAIN_RAM_BYTES],
            vec![0; MMIO_BYTES],
            vec![0; ARAM_BYTES],
        )
    }

    #[test]
    fn fixed_layout_has_disjoint_mem1_ipl_and_aram() {
        let (
            memory_initial_bytes,
            memory_bytes,
            main_ram_end,
            mmio_end,
            machine_reserved_end,
            ipl_offset,
            ipl_end,
            aram_offset,
            aram_end,
            runtime_base,
            runtime_end,
        ) = std::hint::black_box((
            LEGACY_MEMORY_INITIAL_PAGES * WASM_PAGE_BYTES,
            LEGACY_MEMORY_BYTES,
            MAIN_RAM_OFFSET + MAIN_RAM_BYTES,
            MMIO_OFFSET + MMIO_BYTES,
            MACHINE_RESERVED_END,
            IPL_OFFSET,
            IPL_OFFSET + IPL_BYTES,
            ARAM_OFFSET,
            ARAM_OFFSET + ARAM_BYTES,
            RUNTIME_BASE,
            LEGACY_RUNTIME_END,
        ));
        assert_eq!(memory_initial_bytes, 0x02d0_0000);
        assert_eq!(memory_bytes, 0x0300_0000);
        assert_eq!(main_ram_end, MMIO_OFFSET);
        assert!(mmio_end <= machine_reserved_end);
        assert_eq!(machine_reserved_end, ipl_offset);
        assert_eq!(ipl_end, aram_offset);
        assert_eq!(aram_end, runtime_base);
        assert_eq!(runtime_end - runtime_base, 4 * 1024 * 1024);
    }

    #[test]
    fn rejects_any_host_slice_that_does_not_match_the_fixed_layout() {
        let (mut main_ram, mut mmio, mut aram) = memory();
        let mut dma = DspDma::default();
        let mut observer = RecordingObserver::default();
        assert!(
            BrowserBus::new(
                &mut main_ram[..MAIN_RAM_BYTES - 1],
                &mut mmio,
                &mut aram,
                &mut dma,
                &mut observer,
            )
            .is_none()
        );
    }

    #[test]
    fn maps_control_and_mailboxes_as_big_endian_shared_mmio() {
        let (mut main_ram, mut mmio, mut aram) = memory();
        mmio[DSP_CONTROL_OFFSET..DSP_CONTROL_OFFSET + 2].copy_from_slice(&0x03e8_u16.to_be_bytes());
        let mut dma = DspDma::default();
        let mut observer = RecordingObserver::default();
        let mut bus =
            BrowserBus::new(&mut main_ram, &mut mmio, &mut aram, &mut dma, &mut observer).unwrap();

        bus.set_dsp_control(DspControl {
            reset: true,
            reset_high: true,
            halted: true,
            cpu_to_dsp_interrupt: true,
        });
        assert_eq!(bus.read_u16(DSP_CONTROL_OFFSET), 0x0bef);
        assert_eq!(
            bus.dsp_control(),
            DspControl {
                reset: true,
                reset_high: true,
                halted: true,
                cpu_to_dsp_interrupt: true,
            }
        );

        bus.set_cpu_mailbox(DspMailbox::from_bits(0x8123_4567));
        bus.set_dsp_mailbox(DspMailbox::from_bits(0x89ab_cdef));
        assert_eq!(bus.cpu_mailbox().to_bits(), 0x8123_4567);
        assert_eq!(bus.dsp_mailbox().to_bits(), 0x89ab_cdef);
        assert_eq!(
            &bus.mmio[CPU_MAILBOX_OFFSET..CPU_MAILBOX_OFFSET + 4],
            &[0x81, 0x23, 0x45, 0x67]
        );
        assert_eq!(
            &bus.mmio[DSP_MAILBOX_OFFSET..DSP_MAILBOX_OFFSET + 4],
            &[0x89, 0xab, 0xcd, 0xef]
        );

        bus.request_cpu_interrupt();
        assert_ne!(
            bus.read_u16(DSP_CONTROL_OFFSET) & CONTROL_DSP_TO_CPU_INTERRUPT,
            0
        );
    }

    #[test]
    fn dsp_to_mem1_dma_is_zero_copy_and_reports_the_exact_written_range() {
        let (mut main_ram, mut mmio, mut aram) = memory();
        let mut dma = DspDma {
            ram_base: 0x40,
            dsp_base: 0,
            length: 2,
            control: DspDmaControl::from_bits(0b101),
        };
        let mut observer = RecordingObserver::default();
        let mut interpreter = Interpreter::default();
        interpreter.mem.dram[0] = 0x1234;
        {
            let mut bus =
                BrowserBus::new(&mut main_ram, &mut mmio, &mut aram, &mut dma, &mut observer)
                    .unwrap();
            let outcome = interpreter.exec(&mut bus, 1);
            assert_eq!(outcome.executed_instructions, 1);
        }

        assert_eq!(&main_ram[0x40..0x42], &[0x12, 0x34]);
        assert_eq!(observer.0, vec![(0x40, 2)]);
        assert_eq!(dma.length, 0);
        assert!(!dma.control.transfer_ongoing());
    }

    #[test]
    fn initialization_loads_the_console_rom_and_coefficients() {
        let mut interpreter = initialized_interpreter();
        assert_eq!(
            interpreter.read_imem(0x8000),
            u16::from_be_bytes(DSP_ROM_BYTES[..2].try_into().unwrap())
        );
        assert_eq!(
            interpreter.mem.coef[0],
            u16::from_be_bytes(DSP_COEF_BYTES[..2].try_into().unwrap())
        );
        assert_ne!(interpreter.read_imem(0x8000), 0);
    }
}
