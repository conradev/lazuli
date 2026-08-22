/// DSP control lines observed by the interpreter.
///
/// This intentionally excludes the rest of the console's DSP-interface control
/// register. A host only has to expose the lines that can affect DSP execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DspControl {
    pub reset: bool,
    pub reset_high: bool,
    pub halted: bool,
    pub cpu_to_dsp_interrupt: bool,
}

impl Default for DspControl {
    fn default() -> Self {
        Self {
            reset: false,
            reset_high: true,
            halted: false,
            cpu_to_dsp_interrupt: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum DspDmaDirection {
    #[default]
    FromRamToDsp = 0,
    FromDspToRam = 1,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum DspDmaTarget {
    #[default]
    Dmem = 0,
    Imem = 1,
}

/// Raw DSP-DMA control register with typed access to its defined bits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DspDmaControl(u16);

impl DspDmaControl {
    pub const fn from_bits(bits: u16) -> Self {
        Self(bits)
    }

    pub const fn to_bits(self) -> u16 {
        self.0
    }

    pub const fn direction(self) -> DspDmaDirection {
        if self.0 & 1 == 0 {
            DspDmaDirection::FromRamToDsp
        } else {
            DspDmaDirection::FromDspToRam
        }
    }

    pub const fn dsp_target(self) -> DspDmaTarget {
        if self.0 & 2 == 0 {
            DspDmaTarget::Dmem
        } else {
            DspDmaTarget::Imem
        }
    }

    pub const fn transfer_ongoing(self) -> bool {
        self.0 & 4 != 0
    }

    pub fn set_transfer_ongoing(&mut self, ongoing: bool) {
        if ongoing {
            self.0 |= 4;
        } else {
            self.0 &= !4;
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DspDma {
    pub ram_base: u32,
    pub dsp_base: u16,
    pub length: u16,
    pub control: DspDmaControl,
}

/// Raw DSP mailbox value, including the full/empty status bit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DspMailbox(u32);

impl DspMailbox {
    pub const fn from_bits(bits: u32) -> Self {
        Self(bits)
    }

    pub const fn to_bits(self) -> u32 {
        self.0
    }

    pub const fn status(self) -> bool {
        self.0 & (1 << 31) != 0
    }

    pub const fn data(self) -> u32 {
        self.0 & 0x7fff_ffff
    }

    pub const fn high_and_status(self) -> u16 {
        (self.0 >> 16) as u16
    }

    pub const fn low(self) -> u16 {
        self.0 as u16
    }

    pub fn set_high(&mut self, high: u16) {
        // Writing either mailbox's high half clears its full bit. Bit 15 of the written value is
        // the status position rather than mailbox data, so it cannot make the mailbox full again.
        self.0 = (self.0 & 0x0000_ffff) | ((high as u32 & 0x7fff) << 16);
    }

    pub fn set_low(&mut self, low: u16) {
        self.0 = (self.0 & 0xffff_0000) | low as u32;
    }

    pub fn set_status(&mut self, full: bool) {
        if full {
            self.0 |= 1 << 31;
        } else {
            self.0 &= !(1 << 31);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DspBusOperation {
    ReadMainRam,
    WriteMainRam,
    ValidateAram,
    ReadAram,
    WriteAram,
}

/// A checked host-memory access that the bus could not complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DspBusFault {
    pub operation: DspBusOperation,
    pub address: u32,
    pub length: u32,
    pub memory_length: u32,
}

/// External state required by the DSP interpreter.
///
/// All methods are required deliberately: a new host cannot accidentally run
/// with missing mailbox, DMA, interrupt, or memory behavior hidden behind
/// no-op defaults.
pub trait DspBus {
    fn dsp_control(&self) -> DspControl;
    fn set_dsp_control(&mut self, control: DspControl);

    fn dsp_dma(&self) -> DspDma;
    fn set_dsp_dma(&mut self, dma: DspDma);

    fn dsp_mailbox(&self) -> DspMailbox;
    fn set_dsp_mailbox(&mut self, mailbox: DspMailbox);
    fn cpu_mailbox(&self) -> DspMailbox;
    fn set_cpu_mailbox(&mut self, mailbox: DspMailbox);

    /// Returns the host's contiguous main-memory storage.
    ///
    /// The interpreter validates a complete DMA range before transferring its first word. The
    /// storage length must therefore remain stable during an interpreter call.
    fn main_ram(&self) -> &[u8];

    /// Returns the host's contiguous, writable main-memory storage.
    ///
    /// The interpreter calls [`DspBus::main_ram_write_completed`] exactly once after a successful
    /// DSP-to-main-memory DMA and never calls it for a failed or unsupported transfer.
    fn main_ram_mut(&mut self) -> &mut [u8];

    /// Applies host coherency after a completed DSP-to-main-memory DMA.
    ///
    /// Hosts with CPU reservations, translated-code caches, or write receipts must update them
    /// for exactly `address..address + length`. The range has already been validated and written.
    fn main_ram_write_completed(&mut self, address: u32, length: usize);

    /// Returns the host's ARAM storage. A browser host can expose its shared linear-memory view.
    ///
    /// The storage length must remain stable during an interpreter call. GameCube hardware has a
    /// 16 MiB ARAM whose byte addresses mirror through the low 24 bits; the interpreter validates
    /// that this complete physical address space is present before executing an instruction.
    fn aram(&self) -> &[u8];
    fn aram_mut(&mut self) -> &mut [u8];

    /// Raises the DSP-to-CPU interrupt and makes it visible to the host CPU.
    fn request_cpu_interrupt(&mut self);
}
