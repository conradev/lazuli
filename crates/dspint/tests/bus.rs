use dspint::{
    AccelOverflow, DspBus, DspBusFault, DspBusOperation, DspControl, DspDma, DspDmaControl,
    DspMailbox, ExecStopReason, Interpreter, Mmio, Reg, Registers,
};

const GC_ARAM_LEN: usize = 0x0100_0000;

struct RecordingBus {
    control: DspControl,
    dma: DspDma,
    dsp_mailbox: DspMailbox,
    cpu_mailbox: DspMailbox,
    main_ram: Vec<u8>,
    aram: Vec<u8>,
    writes: Vec<(u32, usize)>,
    cpu_interrupts: u32,
}

impl RecordingBus {
    fn new(main_ram_length: usize) -> Self {
        Self {
            control: DspControl {
                reset_high: false,
                ..DspControl::default()
            },
            dma: DspDma::default(),
            dsp_mailbox: DspMailbox::default(),
            cpu_mailbox: DspMailbox::default(),
            main_ram: vec![0; main_ram_length],
            aram: vec![0; GC_ARAM_LEN],
            writes: vec![],
            cpu_interrupts: 0,
        }
    }
}

impl DspBus for RecordingBus {
    fn dsp_control(&self) -> DspControl {
        self.control
    }

    fn set_dsp_control(&mut self, control: DspControl) {
        self.control = control;
    }

    fn dsp_dma(&self) -> DspDma {
        self.dma
    }

    fn set_dsp_dma(&mut self, dma: DspDma) {
        self.dma = dma;
    }

    fn dsp_mailbox(&self) -> DspMailbox {
        self.dsp_mailbox
    }

    fn set_dsp_mailbox(&mut self, mailbox: DspMailbox) {
        self.dsp_mailbox = mailbox;
    }

    fn cpu_mailbox(&self) -> DspMailbox {
        self.cpu_mailbox
    }

    fn set_cpu_mailbox(&mut self, mailbox: DspMailbox) {
        self.cpu_mailbox = mailbox;
    }

    fn main_ram(&self) -> &[u8] {
        &self.main_ram
    }

    fn main_ram_mut(&mut self) -> &mut [u8] {
        &mut self.main_ram
    }

    fn main_ram_write_completed(&mut self, address: u32, length: usize) {
        self.writes.push((address, length));
    }

    fn aram(&self) -> &[u8] {
        &self.aram
    }

    fn aram_mut(&mut self) -> &mut [u8] {
        &mut self.aram
    }

    fn request_cpu_interrupt(&mut self) {
        self.cpu_interrupts += 1;
    }
}

#[test]
fn dsp_control_default_starts_at_the_high_reset_vector() {
    assert!(DspControl::default().reset_high);
}

#[test]
fn data_memory_mirrors_coefficients_and_all_ifx_pages() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    interpreter.mem.dram[0x321] = 0x1234;
    assert_eq!(interpreter.read_dmem(&mut bus, 0x0321), 0x1234);

    interpreter.mem.coef[0] = 0x5678;
    interpreter.mem.coef[0x7ff] = 0x9abc;
    assert_eq!(interpreter.read_dmem(&mut bus, 0x1000), 0x5678);
    assert_eq!(interpreter.read_dmem(&mut bus, 0x1800), 0x5678);
    assert_eq!(interpreter.read_dmem(&mut bus, 0x17ff), 0x9abc);
    assert_eq!(interpreter.read_dmem(&mut bus, 0x1fff), 0x9abc);
    interpreter.write_dmem(&mut bus, 0x1800, 0xffff);
    assert_eq!(interpreter.mem.coef[0], 0x5678);

    interpreter.write_dmem(&mut bus, 0xf042, 0xbeef);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xf142), 0xbeef);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xff42), 0xbeef);

    interpreter.write_dmem(&mut bus, 0x2042, 0xaaaa);
    assert_eq!(interpreter.read_dmem(&mut bus, 0x2042), 0);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xe042), 0);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xff42), 0xbeef);
}

#[test]
fn ifx_backing_and_special_registers_preserve_raw_hardware_semantics() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    interpreter.write_mmio(&mut bus, 0xd2, 0x1234);
    assert_eq!(interpreter.read_mmio(&mut bus, 0xd2), 0x1234);

    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 0xabda);
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::AccelFormat as u8),
        0xabda
    );

    interpreter.write_mmio(&mut bus, Mmio::AccelPredictor as u8, 0xffff);
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::AccelPredictor as u8),
        0x007f
    );

    interpreter.accel.reads_stopped = true;
    interpreter.write_mmio(&mut bus, Mmio::AccelSample as u8, 0xcafe);
    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelSample as u8), 0);
}

#[test]
fn ifx_coefficients_are_single_source_for_accelerator_decode() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    // MMIO PCM without address increment, divisor 1, coefficient set 0.
    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 0x0014);
    interpreter.write_dmem(&mut bus, 0xf0a0, 4);
    interpreter.write_dmem(&mut bus, 0xf7a1, 5);
    interpreter.accel.previous_samples = [2, 3];

    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelSample as u8), 23);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xffa0), 4);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xffa1), 5);
}

#[test]
fn mailbox_ports_clear_and_set_full_for_both_directions() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    bus.dsp_mailbox = DspMailbox::from_bits(0x8000_1234);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xf0fc), 0x8000);
    assert_eq!(bus.dsp_mailbox, DspMailbox::from_bits(0x8000_1234));
    interpreter.write_dmem(&mut bus, 0xf0fc, 0xbeef);
    assert_eq!(bus.dsp_mailbox, DspMailbox::from_bits(0x3eef_1234));
    interpreter.write_dmem(&mut bus, 0xf1fd, 0x5678);
    assert_eq!(bus.dsp_mailbox, DspMailbox::from_bits(0xbeef_5678));
    assert_eq!(interpreter.read_dmem(&mut bus, 0xf2fd), 0x5678);
    assert_eq!(bus.dsp_mailbox, DspMailbox::from_bits(0x3eef_5678));

    bus.cpu_mailbox = DspMailbox::from_bits(0x8000_abcd);
    assert_eq!(interpreter.read_dmem(&mut bus, 0xf3fe), 0x8000);
    assert_eq!(bus.cpu_mailbox, DspMailbox::from_bits(0x8000_abcd));
    interpreter.write_dmem(&mut bus, 0xf3fe, 0xffff);
    assert_eq!(bus.cpu_mailbox, DspMailbox::from_bits(0x7fff_abcd));
    interpreter.write_dmem(&mut bus, 0xf4ff, 0x0123);
    assert_eq!(bus.cpu_mailbox, DspMailbox::from_bits(0xffff_0123));
    assert_eq!(interpreter.read_dmem(&mut bus, 0xf5ff), 0x0123);
    assert_eq!(bus.cpu_mailbox, DspMailbox::from_bits(0x7fff_0123));
}

#[test]
fn dma_mask_consumes_requests_without_transferring_or_rearming() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    interpreter.write_mmio(&mut bus, Mmio::DmaMasked as u8, 0xa5a5);
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::DmaMasked as u8),
        0xa5a5
    );
    assert!(interpreter.accel.dma_masked);
    // The raw IFX register is authoritative even if legacy host code mutates its typed mirror.
    interpreter.accel.dma_masked = false;
    interpreter.write_mmio(&mut bus, Mmio::DmaLength as u8, 4);
    assert_eq!(bus.dma.length, 0);
    assert!(!bus.dma.control.transfer_ongoing());

    interpreter.write_mmio(&mut bus, Mmio::DmaMasked as u8, 0);
    assert!(!interpreter.accel.dma_masked);
    assert_eq!(bus.dma.length, 0);
    assert!(!bus.dma.control.transfer_ongoing());
    interpreter.write_mmio(&mut bus, Mmio::DmaLength as u8, 4);
    assert_eq!(bus.dma.length, 4);
    assert!(bus.dma.control.transfer_ongoing());
}

#[test]
fn interrupt_request_uses_only_bit_zero_and_reads_as_zero() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    interpreter.write_mmio(&mut bus, Mmio::InterruptRequest as u8, 2);
    assert_eq!(bus.cpu_interrupts, 0);
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::InterruptRequest as u8),
        0
    );

    interpreter.write_mmio(&mut bus, Mmio::InterruptRequest as u8, 1);
    interpreter.write_mmio(&mut bus, Mmio::InterruptRequest as u8, 3);
    assert_eq!(bus.cpu_interrupts, 2);
}

#[test]
fn soft_reset_preserves_mailboxes_and_ifx_backing() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    bus.control.reset = true;
    bus.control.reset_high = true;
    bus.dsp_mailbox = DspMailbox::from_bits(0x9234_5678);
    bus.cpu_mailbox = DspMailbox::from_bits(0x8abc_def0);
    interpreter.write_mmio(&mut bus, 0x42, 0xbeef);
    interpreter.write_mmio(&mut bus, Mmio::DmaMasked as u8, 0x1234);
    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 0xabda);

    let outcome = interpreter.exec(&mut bus, 0);

    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(interpreter.pc, 0x8000);
    assert_eq!(bus.dsp_mailbox, DspMailbox::from_bits(0x9234_5678));
    assert_eq!(bus.cpu_mailbox, DspMailbox::from_bits(0x8abc_def0));
    assert_eq!(interpreter.read_mmio(&mut bus, 0x42), 0xbeef);
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::DmaMasked as u8),
        0x1234
    );
    assert!(interpreter.accel.dma_masked);
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::AccelFormat as u8),
        0xabda
    );
}

#[test]
fn low_reset_bootstrap_loads_iram_before_execution() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x0100_0400);
    let bootstrap = &mut bus.main_ram[0x0100_0000..0x0100_0400];
    for (word, bytes) in bootstrap.chunks_exact_mut(2).enumerate() {
        bytes.copy_from_slice(&(word as u16 ^ 0xa55a).to_be_bytes());
    }
    bus.control.reset = true;

    let outcome = interpreter.exec(&mut bus, 0);

    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(interpreter.mem.iram[0], 0xa55a);
    assert_eq!(interpreter.mem.iram[511], 511 ^ 0xa55a);
    assert_eq!(interpreter.pc, 0);
    assert!(!bus.control.reset);
}

#[test]
fn halt_counts_and_holds_pc() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.pc = 7;
    interpreter.mem.iram[7] = 0x0021;

    let outcome = interpreter.exec(&mut bus, 8);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(outcome.stop_reason, ExecStopReason::Halted);
    assert_eq!(interpreter.pc, 7);
}

#[test]
fn preexisting_halt_executes_nothing() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    bus.control.halted = true;

    let outcome = interpreter.exec(&mut bus, 8);

    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(outcome.stop_reason, ExecStopReason::Halted);
    assert_eq!(interpreter.pc, 0);
}

#[test]
fn budget_outcome_reports_exact_instructions() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    let outcome = interpreter.exec(&mut bus, 3);

    assert_eq!(outcome.executed_instructions, 3);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert_eq!(interpreter.pc, 3);
}

#[test]
fn empty_cpu_mailbox_poll_counts_and_advances() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.regs.config = 0xff;
    interpreter.mem.iram[..5].copy_from_slice(&[
        0b0010_0110_1111_1110, // lrs   $ACM0, @cmbh
        0b0000_0010_1100_0000, // andcf $ACM0, #0x8000
        0x8000,
        0b0000_0010_1001_1100, // jlnz  0
        0,
    ]);

    let outcome = interpreter.exec(&mut bus, 8);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(outcome.stop_reason, ExecStopReason::CpuMailboxEmpty);
    assert_eq!(interpreter.pc, 1);
}

#[test]
fn full_dsp_mailbox_poll_counts_and_advances() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.regs.config = 0xff;
    interpreter.mem.iram[..5].copy_from_slice(&[
        0b0010_0110_1111_1100, // lrs   $ACM0, @dmbh
        0b0000_0010_1100_0000, // andcf $ACM0, #0x8000
        0x8000,
        0b0000_0010_1001_1101, // jlz   0
        0,
    ]);
    bus.dsp_mailbox.set_status(true);

    let outcome = interpreter.exec(&mut bus, 8);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(outcome.stop_reason, ExecStopReason::DspMailboxFull);
    assert_eq!(interpreter.pc, 1);
}

#[test]
fn dsp_to_ram_dma_reports_one_exact_write_range() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.mem.dram[3] = 0x1122;
    interpreter.mem.dram[4] = 0x3344;
    bus.dma = DspDma {
        ram_base: 0x20,
        dsp_base: 3,
        length: 4,
        // direction=FromDspToRam, target=Dmem, transfer_ongoing=true
        control: DspDmaControl::from_bits(0b101),
    };

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert_eq!(bus.writes, vec![(0x20, 4)]);
    assert_eq!(&bus.main_ram[0x20..0x24], &[0x11, 0x22, 0x33, 0x44]);
    assert!(!bus.dma.control.transfer_ongoing());
    assert_eq!(bus.dma.length, 0);
}

#[test]
fn ram_to_dmem_dma_transfers_words_without_a_write_receipt() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    bus.main_ram[0x20..0x24].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
    bus.dma = DspDma {
        ram_base: 0x20,
        dsp_base: 3,
        length: 4,
        // direction=FromRamToDsp, target=Dmem, transfer_ongoing=true
        control: DspDmaControl::from_bits(0b100),
    };

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert_eq!(interpreter.mem.dram[3..5], [0x1122, 0x3344]);
    assert!(bus.writes.is_empty());
    assert!(!bus.dma.control.transfer_ongoing());
    assert_eq!(bus.dma.length, 0);
}

#[test]
fn dma_completion_preserves_live_mmio_register_side_effects() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    bus.main_ram[0x20..0x22].copy_from_slice(&0x1234_u16.to_be_bytes());
    bus.dma = DspDma {
        ram_base: 0x20,
        dsp_base: 0xffcf, // DMA RAM address low MMIO
        length: 2,
        control: DspDmaControl::from_bits(0b100),
    };

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert_eq!(bus.dma.ram_base, 0x1234);
    assert_eq!(bus.dma.length, 0);
    assert!(!bus.dma.control.transfer_ongoing());
}

#[test]
fn imem_to_ram_dma_is_a_completed_noop() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.mem.iram[3] = 0x1122;
    interpreter.mem.iram[4] = 0x3344;
    bus.dma = DspDma {
        ram_base: 0x20,
        dsp_base: 3,
        length: 4,
        // direction=FromDspToRam, target=Imem, transfer_ongoing=true
        control: DspDmaControl::from_bits(0b111),
    };

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert!(bus.writes.is_empty());
    assert_eq!(&bus.main_ram[0x20..0x24], &[0, 0, 0, 0]);
    assert!(!bus.dma.control.transfer_ongoing());
    assert_eq!(bus.dma.length, 0);
}

#[test]
fn dma_bounds_fault_stops_before_instruction() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x20);
    bus.dma = DspDma {
        ram_base: 0x1f,
        dsp_base: 0,
        length: 4,
        control: DspDmaControl::from_bits(0b101),
    };

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::BusFault(DspBusFault {
            operation: DspBusOperation::WriteMainRam,
            address: 0x1f,
            length: 4,
            memory_length: 0x20,
        })
    );
    assert_eq!(interpreter.pc, 0);
    assert!(bus.writes.is_empty());
    assert!(bus.dma.control.transfer_ongoing());
}

#[test]
fn ram_to_dsp_bounds_fault_stops_before_mutation_or_instruction() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x20);
    interpreter.mem.dram[..2].copy_from_slice(&[0xaaaa, 0xbbbb]);
    bus.dma = DspDma {
        ram_base: 0x1f,
        dsp_base: 0,
        length: 4,
        control: DspDmaControl::from_bits(0b100),
    };

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::BusFault(DspBusFault {
            operation: DspBusOperation::ReadMainRam,
            address: 0x1f,
            length: 4,
            memory_length: 0x20,
        })
    );
    assert_eq!(interpreter.mem.dram[..2], [0xaaaa, 0xbbbb]);
    assert_eq!(interpreter.pc, 0);
    assert!(bus.dma.control.transfer_ongoing());
}

#[test]
fn dsp_to_ram_preflights_destination_before_mailbox_read_side_effect() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x20);
    bus.cpu_mailbox = DspMailbox::from_bits(0x8000_1234);
    bus.dma = DspDma {
        ram_base: 0x1f,
        dsp_base: 0xffff, // CPU mailbox low MMIO consumes a full mailbox.
        length: 2,
        control: DspDmaControl::from_bits(0b101),
    };

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::BusFault(DspBusFault {
            operation: DspBusOperation::WriteMainRam,
            address: 0x1f,
            length: 2,
            memory_length: 0x20,
        })
    );
    assert_eq!(bus.cpu_mailbox, DspMailbox::from_bits(0x8000_1234));
    assert!(bus.writes.is_empty());
    assert!(bus.dma.control.transfer_ongoing());
}

#[test]
fn low_reset_bootstrap_fault_is_an_exec_outcome() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    bus.control.reset = true;
    bus.control.reset_high = false;

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::BusFault(DspBusFault {
            operation: DspBusOperation::ReadMainRam,
            address: 0x0100_0000,
            length: 1024,
            memory_length: 0x100,
        })
    );
    assert_eq!(interpreter.pc, 0);
    assert!(bus.control.reset);
}

#[test]
fn short_aram_backing_faults_before_any_state_changes() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    bus.aram.truncate(0x1000);
    bus.aram[0x20] = 0xa5;
    bus.control.reset = true;

    interpreter.pc = 7;
    interpreter.mem.iram[7] = 0x26d3; // lrs $ACM0, @acdraw
    interpreter.regs.config = 0xff;
    interpreter.regs.acc40[0].mid = 0xbeef;
    interpreter.accel.aram_start = 0x1234;
    interpreter.accel.aram_end = 0x5678;
    interpreter.accel.aram_curr = 0x8000_0020;
    interpreter.accel.previous_samples = [0x1111, 0x2222];
    interpreter.accel.reads_stopped = true;
    interpreter.accel.overflow = AccelOverflow::RawWrite;

    let aram_before = bus.aram.clone();
    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 0);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::BusFault(DspBusFault {
            operation: DspBusOperation::ValidateAram,
            address: 0,
            length: GC_ARAM_LEN as u32,
            memory_length: 0x1000,
        })
    );
    assert_eq!(interpreter.pc, 7);
    assert_eq!(interpreter.regs.config, 0xff);
    assert_eq!(interpreter.regs.acc40[0].mid, 0xbeef);
    assert_eq!(interpreter.accel.aram_start, 0x1234);
    assert_eq!(interpreter.accel.aram_end, 0x5678);
    assert_eq!(interpreter.accel.aram_curr, 0x8000_0020);
    assert_eq!(interpreter.accel.previous_samples, [0x1111, 0x2222]);
    assert!(interpreter.accel.reads_stopped);
    assert_eq!(interpreter.accel.overflow, AccelOverflow::RawWrite);
    assert_eq!(bus.aram, aram_before);
    assert!(bus.control.reset);
}

#[test]
fn accelerator_address_registers_apply_hardware_masks() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);

    interpreter.write_mmio(&mut bus, Mmio::AccelStartAddrHigh as u8, 0xffff);
    interpreter.write_mmio(&mut bus, Mmio::AccelStartAddrLow as u8, 0xffff);
    interpreter.write_mmio(&mut bus, Mmio::AccelEndAddrHigh as u8, 0xffff);
    interpreter.write_mmio(&mut bus, Mmio::AccelEndAddrLow as u8, 0xffff);
    interpreter.write_mmio(&mut bus, Mmio::AccelCurrAddrHigh as u8, 0xffff);
    interpreter.write_mmio(&mut bus, Mmio::AccelCurrAddrLow as u8, 0xffff);

    assert_eq!(interpreter.accel.aram_start, 0x3fff_ffff);
    assert_eq!(interpreter.accel.aram_end, 0x3fff_ffff);
    assert_eq!(interpreter.accel.aram_curr, 0xbfff_ffff);
}

#[test]
fn raw_reads_use_nibble_byte_and_word_address_units() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.accel.aram_end = 0x3fff_ffff;
    bus.aram[2..4].copy_from_slice(&[0xab, 0xcd]);

    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 0);
    interpreter.accel.aram_curr = 4;
    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8), 0xa);
    interpreter.accel.aram_curr = 5;
    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8), 0xb);

    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 1);
    interpreter.accel.aram_curr = 2;
    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8), 0xab);

    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 2);
    interpreter.accel.aram_curr = 1;
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8),
        0xabcd
    );

    // A word whose logical byte address is 16 MiB mirrors back to physical byte zero.
    bus.aram[0..2].copy_from_slice(&[0x12, 0x34]);
    interpreter.accel.aram_curr = 0x0080_0000;
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8),
        0x1234
    );
}

#[test]
fn reserved_raw_size_returns_zero_and_cycles_the_low_address_bits() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 3);
    interpreter.accel.aram_end = 0x3fff_ffff;
    interpreter.accel.aram_curr = 0x1234_567b;

    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8), 0);
    assert_eq!(interpreter.accel.aram_curr, 0x1234_5678);
    assert_eq!(interpreter.accel.overflow, AccelOverflow::None);
}

#[test]
fn raw_read_wraps_only_after_the_exact_end_address() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 1);
    interpreter.accel.aram_start = 2;
    interpreter.accel.aram_end = 5;
    bus.aram[5] = 0x55;
    bus.aram[6] = 0x66;

    interpreter.accel.aram_curr = 5;
    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8), 0x55);
    assert_eq!(interpreter.accel.aram_curr, 2);
    assert_eq!(interpreter.accel.overflow, AccelOverflow::RawRead);

    interpreter.accel.overflow = AccelOverflow::None;
    interpreter.accel.aram_curr = 6;
    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelRaw as u8), 0x66);
    assert_eq!(interpreter.accel.aram_curr, 7);
    assert_eq!(interpreter.accel.overflow, AccelOverflow::None);
}

#[test]
fn raw_writes_require_bit_31_and_write_big_endian_words() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    bus.aram[4..6].copy_from_slice(&[0x11, 0x22]);

    interpreter.accel.aram_curr = 2;
    interpreter.write_mmio(&mut bus, Mmio::AccelRaw as u8, 0xaabb);
    assert_eq!(&bus.aram[4..6], &[0x11, 0x22]);
    assert_eq!(interpreter.accel.aram_curr, 2);
    assert_eq!(interpreter.accel.overflow, AccelOverflow::None);

    interpreter.accel.aram_curr = 0x8000_0002;
    interpreter.write_mmio(&mut bus, Mmio::AccelRaw as u8, 0xaabb);
    assert_eq!(&bus.aram[4..6], &[0xaa, 0xbb]);
    assert_eq!(interpreter.accel.aram_curr, 0x8000_0003);
    assert_eq!(interpreter.accel.overflow, AccelOverflow::RawWrite);

    // 0x8080_0000 * 2 is logical byte address 0x0100_0000, mirrored to zero.
    interpreter.accel.aram_curr = 0x8080_0000;
    interpreter.write_mmio(&mut bus, Mmio::AccelRaw as u8, 0x1234);
    assert_eq!(&bus.aram[0..2], &[0x12, 0x34]);
    assert_eq!(interpreter.accel.aram_curr, 0x8080_0001);
}

#[test]
fn full_aram_backing_executes_a_mirrored_raw_read_without_trapping() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.regs.config = 0xff;
    interpreter.mem.iram[0] = 0x26d3; // lrs $ACM0, @acdraw
    interpreter.accel.format = dspint::AccelFormat::from_bits(1);
    interpreter.accel.aram_curr = 0x0100_0002;
    interpreter.accel.aram_end = 0x3fff_ffff;
    bus.aram[2] = 0x7a;

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert_eq!(interpreter.pc, 1);
    assert_eq!(interpreter.regs.acc40[0].mid, 0x7a);
    assert_eq!(interpreter.accel.aram_curr, 0x0100_0003);
}

#[test]
fn sample_endpoint_stops_reads_until_yn2_is_written() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    // 16-bit ARAM PCM with gain divisor 1.
    interpreter.write_mmio(&mut bus, Mmio::AccelFormat as u8, 0x1a);
    interpreter.write_mmio(&mut bus, Mmio::AccelGain as u8, 1);
    interpreter.accel.aram_start = 0;
    interpreter.accel.aram_end = 0;
    interpreter.accel.aram_curr = 0;
    bus.aram[0..2].copy_from_slice(&0x1234_u16.to_be_bytes());

    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::AccelSample as u8),
        0x1234
    );
    assert_eq!(interpreter.accel.aram_curr, 0);
    assert!(interpreter.accel.reads_stopped);
    assert_eq!(interpreter.accel.overflow, AccelOverflow::Sample);
    let samples_after_endpoint = interpreter.accel.previous_samples;

    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelSample as u8), 0);
    assert_eq!(interpreter.accel.aram_curr, 0);
    assert_eq!(interpreter.accel.previous_samples, samples_after_endpoint);

    interpreter.write_mmio(&mut bus, Mmio::AccelPrevSample1 as u8, 0);
    assert!(!interpreter.accel.reads_stopped);
    assert_eq!(
        interpreter.read_mmio(&mut bus, Mmio::AccelSample as u8),
        0x1234
    );
    assert!(interpreter.accel.reads_stopped);
}

#[test]
fn adpcm_sample_reads_skip_the_next_frame_header() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.accel.aram_start = 0;
    interpreter.accel.aram_end = 0x1000;
    interpreter.accel.aram_curr = 0;
    bus.aram[8] = 0x21;

    for expected_current in 1..=15 {
        assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelSample as u8), 0);
        assert_eq!(interpreter.accel.aram_curr, expected_current);
    }

    assert_eq!(interpreter.read_mmio(&mut bus, Mmio::AccelSample as u8), 0);
    assert_eq!(interpreter.accel.aram_curr, 0x12);
    assert_eq!(interpreter.accel.predictor.to_bits(), 0x21);
}

#[test]
fn hardware_stacks_underflow_and_wrap_past_the_previous_depth_limits() {
    let stack_registers = [
        Reg::CallStack,
        Reg::DataStack,
        Reg::LoopStack,
        Reg::LoopCount,
    ];

    for stack_register in stack_registers {
        let mut registers = Registers::default();
        assert_eq!(registers.get_pure(stack_register), 0);
        assert_eq!(registers.get(stack_register), 0);

        let mut registers = Registers::default();
        for value in 1_u16..=40 {
            registers.set(stack_register, value);
        }
        assert_eq!(registers.get_pure(stack_register), 40);

        for expected in (9_u16..=40).rev() {
            assert_eq!(registers.get(stack_register), expected);
        }
        // There is no empty state: another pop continues around the hardware ring.
        assert_eq!(registers.get(stack_register), 8);
    }
}

#[test]
fn false_if_skips_a_two_word_instruction() {
    // Zayd's legacy if_cc corpus has stale cases that expect immediate words to execute;
    // hardware and Dolphin skip the complete decoded instruction instead.
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.mem.iram[..4].copy_from_slice(&[
        0x0275, // ifz (false with the default status)
        0x0080, // lri $AR0, #0xbeef
        0xbeef, 0x0021, // halt
    ]);

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(
        outcome.stop_reason,
        ExecStopReason::InstructionBudgetExhausted
    );
    assert_eq!(interpreter.pc, 3);
    assert_eq!(interpreter.regs.addressing[0], 0);
}

#[test]
fn zero_single_instruction_loops_skip_a_two_word_instruction() {
    for loop_opcode in [
        0x0040, // loop $AR0 (zero by default)
        0x1000, // loopi #0
    ] {
        let mut interpreter = Interpreter::default();
        let mut bus = RecordingBus::new(0x100);
        interpreter.mem.iram[..4].copy_from_slice(&[
            loop_opcode,
            0x0080, // lri $AR0, #0xbeef
            0xbeef,
            0x0021, // halt
        ]);

        let outcome = interpreter.exec(&mut bus, 1);

        assert_eq!(outcome.executed_instructions, 1);
        assert_eq!(
            outcome.stop_reason,
            ExecStopReason::InstructionBudgetExhausted
        );
        assert_eq!(interpreter.pc, 3);
        assert_eq!(interpreter.regs.addressing[0], 0);
    }
}

#[test]
fn zero_block_loops_skip_the_inclusive_two_word_end_instruction() {
    for block_loop_opcode in [
        0x0060, // bloop $AR0, 4 (zero by default)
        0x1100, // bloopi #0, 4
    ] {
        let mut interpreter = Interpreter::default();
        let mut bus = RecordingBus::new(0x100);
        interpreter.mem.iram[..7].copy_from_slice(&[
            block_loop_opcode,
            4,
            0,
            0,
            0x0080, // lri $AR0, #0xbeef is the inclusive block end
            0xbeef,
            0x0021, // halt
        ]);

        let outcome = interpreter.exec(&mut bus, 1);

        assert_eq!(outcome.executed_instructions, 1);
        assert_eq!(
            outcome.stop_reason,
            ExecStopReason::InstructionBudgetExhausted
        );
        assert_eq!(interpreter.pc, 6);
        assert_eq!(interpreter.regs.addressing[0], 0);
    }
}

#[test]
fn direct_branches_accept_the_wrapping_zero_target() {
    for opcode in [
        0x029f, // jmp always, 0
        0x02bf, // call always, 0
    ] {
        let mut interpreter = Interpreter::default();
        let mut bus = RecordingBus::new(0x100);
        interpreter.pc = 10;
        interpreter.mem.iram[10..12].copy_from_slice(&[opcode, 0]);

        let outcome = interpreter.exec(&mut bus, 1);

        assert_eq!(outcome.executed_instructions, 1);
        assert_eq!(interpreter.pc, 0);
        if opcode == 0x02bf {
            assert_eq!(interpreter.regs.call_stack.peek(), 12);
        }
    }
}

#[test]
fn register_branches_and_returns_accept_the_wrapping_zero_target() {
    for opcode in [
        0x170f, // jr $AR0, always
        0x171f, // callr $AR0, always
        0x02df, // ret always from the initial zero stack entry
        0x02ff, // rti always from the initial zero stack entries
    ] {
        let mut interpreter = Interpreter::default();
        let mut bus = RecordingBus::new(0x100);
        interpreter.pc = 10;
        interpreter.mem.iram[10] = opcode;

        let outcome = interpreter.exec(&mut bus, 1);

        assert_eq!(outcome.executed_instructions, 1);
        assert_eq!(interpreter.pc, 0);
        if opcode == 0x171f {
            assert_eq!(interpreter.regs.call_stack.peek(), 11);
        }
    }
}

#[test]
fn loop_completion_is_visible_in_the_retiring_step() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.pc = 5;
    interpreter.mem.iram[5] = 0;
    interpreter.regs.call_stack.push(2);
    interpreter.regs.loop_stack.push(5);
    interpreter.regs.loop_count.push(2);

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.pc, 2);
    assert_eq!(interpreter.regs.loop_count.peek(), 1);

    let mut interpreter = Interpreter::default();
    interpreter.pc = 5;
    interpreter.mem.iram[5] = 0;
    interpreter.regs.call_stack.push(2);
    interpreter.regs.loop_stack.push(5);
    interpreter.regs.loop_count.push(1);

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.pc, 6);
    assert_eq!(interpreter.regs.call_stack.peek(), 0);
    assert_eq!(interpreter.regs.loop_stack.peek(), 0);
    assert_eq!(interpreter.regs.loop_count.peek(), 0);
}

#[test]
fn loop_ending_at_zero_redirects_after_the_instruction_retires() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.pc = 0;
    interpreter.mem.iram[0] = 0;
    interpreter.regs.call_stack.push(7);
    interpreter.regs.loop_stack.push(0);
    interpreter.regs.loop_count.push(2);

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.pc, 7);
    assert_eq!(interpreter.regs.loop_count.peek(), 1);
}

#[test]
fn invalid_instruction_fetches_are_zero_nops_and_wrap_the_pc() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.pc = 0x2000;

    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.pc, 0x2001);

    interpreter.pc = 0xffff;
    let outcome = interpreter.exec(&mut bus, 1);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.pc, 0);
}

#[test]
fn write_imem_invalidates_the_cached_instruction_at_that_address() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.write_imem(0, 0);

    let outcome = interpreter.exec(&mut bus, 1);
    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.pc, 1);

    interpreter.pc = 0;
    interpreter.write_imem(0, 0x0021);
    let outcome = interpreter.exec(&mut bus, 8);

    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(outcome.stop_reason, ExecStopReason::Halted);
    assert_eq!(interpreter.pc, 0);
}

#[test]
fn write_imem_invalidates_a_cached_two_word_predecessor() {
    let mut interpreter = Interpreter::default();
    let mut bus = RecordingBus::new(0x100);
    interpreter.write_imem(0, 0x0080); // lri $AR0, immediate
    interpreter.write_imem(1, 0x1111);

    let outcome = interpreter.exec(&mut bus, 1);
    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.regs.addressing[0], 0x1111);

    interpreter.pc = 0;
    interpreter.regs.addressing[0] = 0;
    interpreter.write_imem(1, 0x2222);

    let outcome = interpreter.exec(&mut bus, 1);
    assert_eq!(outcome.executed_instructions, 1);
    assert_eq!(interpreter.regs.addressing[0], 0x2222);
}
