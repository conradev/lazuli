mod mmio;

use std::ops::Range;

use bitos::BitUtils;
use gekko::Address;
use zerocopy::IntoBytes;

use crate::Primitive;
use crate::system::mem::{IPL_LEN, L2C_LEN, L2C_START, RAM_LEN};
use crate::system::{System, ai, di, dspi, exi, gx, pi, si, vi};

#[rustfmt::skip]
pub use mmio::Mmio;

fn range_overlap(a: Range<usize>, b: Range<usize>) -> bool {
    (a.start < b.end) && (b.start < a.end)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataReservationFault {
    Translation,
    Protection,
    Backing,
}

impl DataReservationFault {
    pub const fn dsisr(self, write: bool) -> u32 {
        let store = if write { 0x0200_0000 } else { 0 };
        store
            | match self {
                Self::Translation => 0x4000_0000,
                Self::Protection => 0x0800_0000,
                Self::Backing => 0,
            }
    }
}

enum DataReservationBacking {
    Ram(usize),
    LockedCache(usize),
}

fn data_reservation_backing(address: Address) -> Option<DataReservationBacking> {
    const WORD_SIZE: usize = size_of::<i32>();

    let physical = address.value();
    let ram_offset = physical as usize;
    if ram_offset
        .checked_add(WORD_SIZE)
        .is_some_and(|end| end <= RAM_LEN)
    {
        return Some(DataReservationBacking::Ram(ram_offset));
    }

    let cache_offset = physical.checked_sub(L2C_START)? as usize;
    cache_offset
        .checked_add(WORD_SIZE)
        .is_some_and(|end| end <= L2C_LEN)
        .then_some(DataReservationBacking::LockedCache(cache_offset))
}

/// Allows the usage of const values in patterns. It's a neat trick!
struct ConstTrick<const N: u32>;
impl<const N: u32> ConstTrick<N> {
    const OUTPUT: u32 = N;
}

macro_rules! map {
    ($offset:ident, $match_addr:expr; $($addr:expr, $size:expr => $block:expr,)* @default => $default:expr $(,)?) => {
        match $match_addr.value() {
            $(
                $addr..=ConstTrick::<{ ($addr + ($size - 1)) as u32 }>::OUTPUT => {
                    #[allow(unused_assignments)]
                    {
                        $offset = ($match_addr.value() - $addr) as usize;
                    }
                    $block
                }
            )*
            _ => $default
        }
    };
}

// WARN: Do not change CPU state in the bus methods, specially if they change the PC! These are
// called from within the JIT.

impl System {
    /// Resolves an architected load/store-reservation access through the currently active DBATs.
    ///
    /// Hashed page translation is intentionally not modeled by the native runtime yet, so a DBAT
    /// miss while data translation is enabled is reported as a translation fault.
    pub fn translate_data_reservation_addr(
        &self,
        addr: Address,
        write: bool,
    ) -> Result<Address, DataReservationFault> {
        let msr = &self.cpu.supervisor.config.msr;
        if !msr.data_addr_translation() {
            return Ok(addr);
        }

        let user_mode = msr.user_mode();
        for bat in &self.cpu.supervisor.memory.dbat {
            let valid = if user_mode {
                bat.user_mode()
            } else {
                bat.supervisor_mode()
            };
            if !valid || !bat.contains(addr) {
                continue;
            }

            let protection = bat.protection().value();
            let permitted = if write {
                protection == 2
            } else {
                protection != 0
            };
            if !permitted {
                return Err(DataReservationFault::Protection);
            }
            return Ok(bat.translate(addr));
        }

        Err(DataReservationFault::Translation)
    }

    /// Reads a reservation word only from architected RAM or locked-cache backing.
    pub fn read_data_reservation_phys(&self, addr: Address) -> Option<i32> {
        let bytes = match data_reservation_backing(addr)? {
            DataReservationBacking::Ram(offset) => &self.mem.ram()[offset..],
            DataReservationBacking::LockedCache(offset) => &self.mem.l2c()[offset..],
        };
        Some(i32::read_be_bytes(bytes))
    }

    /// Writes a reservation word only to architected RAM or locked-cache backing.
    pub fn write_data_reservation_phys(&mut self, addr: Address, value: i32) -> bool {
        let bytes = match data_reservation_backing(addr) {
            Some(DataReservationBacking::Ram(offset)) => &mut self.mem.ram_mut()[offset..],
            Some(DataReservationBacking::LockedCache(offset)) => &mut self.mem.l2c_mut()[offset..],
            None => return false,
        };
        value.write_be_bytes(bytes);
        true
    }

    /// Translates a data logical address into a physical address.
    #[inline(always)]
    pub fn translate_data_addr(&self, addr: Address) -> Option<Address> {
        if !self.cpu.supervisor.config.msr.data_addr_translation() {
            return Some(addr);
        }

        self.mem.translate_data_addr(addr)
    }

    /// Translates an instruction logical address into a physical address.
    #[inline(always)]
    pub fn translate_inst_addr(&self, addr: Address) -> Option<Address> {
        if !self.cpu.supervisor.config.msr.instr_addr_translation() {
            return Some(addr);
        }

        self.mem.translate_inst_addr(addr)
    }

    /// Reads a primitive from the given physical address, but only if it can't possibly have a
    /// side effect.
    pub fn read_phys_pure<P: Primitive>(&self, addr: Address) -> Option<P> {
        let offset: usize;
        map! {
            offset, addr;
            0x0000_0000, RAM_LEN => Some(P::read_be_bytes(&self.mem.ram()[offset..])),
            0xFFF0_0000, IPL_LEN / 2 => Some(P::read_be_bytes(&self.mem.ipl()[offset..])),
            @default => None
        }
    }

    /// Reads a primitive from the given physical address, but only if it can't possibly have a
    /// side effect.
    pub fn read_pure<P: Primitive>(&self, addr: Address) -> Option<P> {
        self.translate_data_addr(addr)
            .and_then(|addr| self.read_phys_pure(addr))
    }

    fn read_mmio<P: Primitive>(&mut self, offset: u16) -> P {
        let Some((reg, offset)) = Mmio::find(offset) else {
            tracing::error!(pc = ?self.cpu.pc, "reading from unknown mmio register ({offset:04X})");
            return P::default();
        };

        // convert the range to native endian
        let mmio_range = if cfg!(target_endian = "big") {
            offset..offset + size_of::<P>()
        } else {
            let size = reg.size();
            (size as usize - offset - size_of::<P>())..(size as usize - offset)
        };

        // read from native endian bytes
        macro_rules! ne {
            ($bytes:expr) => {
                P::read_ne_bytes(&$bytes[mmio_range.clone()])
            };
        }

        let value = match reg {
            // === Command Processor ===
            Mmio::CpStatus => {
                ne!(self.gpu.cmd.status.as_bytes())
            }
            Mmio::CpControl => ne!(self.gpu.cmd.control.as_bytes()),
            Mmio::CpClear => ne!(&[0, 0]),
            Mmio::CpFifoStartLow => ne!(self.gpu.cmd.fifo.start.as_bytes()[0..2]),
            Mmio::CpFifoStartHigh => ne!(self.gpu.cmd.fifo.start.as_bytes()[2..4]),
            Mmio::CpFifoEndLow => ne!(self.gpu.cmd.fifo.end.as_bytes()[0..2]),
            Mmio::CpFifoEndHigh => ne!(self.gpu.cmd.fifo.end.as_bytes()[2..4]),
            Mmio::CpHighWatermarkLow => ne!(self.gpu.cmd.fifo.high_mark.as_bytes()[0..2]),
            Mmio::CpHighWatermarkHigh => ne!(self.gpu.cmd.fifo.high_mark.as_bytes()[2..4]),
            Mmio::CpLowWatermarkLow => ne!(self.gpu.cmd.fifo.low_mark.as_bytes()[0..2]),
            Mmio::CpLowWatermarkHigh => ne!(self.gpu.cmd.fifo.low_mark.as_bytes()[2..4]),
            Mmio::CpFifoCountLow => ne!(self.gpu.cmd.fifo.count().as_bytes()[0..2]),
            Mmio::CpFifoCountHigh => ne!(self.gpu.cmd.fifo.count().as_bytes()[2..4]),
            Mmio::CpFifoWritePtrLow => ne!(self.gpu.cmd.fifo.write_ptr.as_bytes()[0..2]),
            Mmio::CpFifoWritePtrHigh => ne!(self.gpu.cmd.fifo.write_ptr.as_bytes()[2..4]),
            Mmio::CpFifoReadPtrLow => ne!(self.gpu.cmd.fifo.read_ptr.as_bytes()[0..2]),
            Mmio::CpFifoReadPtrHigh => ne!(self.gpu.cmd.fifo.read_ptr.as_bytes()[2..4]),

            // === Pixel Engine ===
            Mmio::PixelInterruptStatus => {
                // NOTE: the interrupt bits always read back as zero!
                let to_read = self.gpu.pix.interrupt.with_token(false).with_finish(false);
                ne!(to_read.as_bytes())
            }
            Mmio::PixelToken => ne!((self.gpu.pix.token as u16).as_bytes()),

            // === Video Interface ===
            Mmio::VideoVerticalTiming => ne!(self.video.vertical_timing.as_bytes()),
            Mmio::VideoDisplayConfig => ne!(self.video.display_config.as_bytes()),
            Mmio::VideoHorizontalTiming => ne!(self.video.horizontal_timing.as_bytes()),
            Mmio::VideoOddVerticalTiming => ne!(self.video.top_vertical_timing.as_bytes()),
            Mmio::VideoEvenVerticalTiming => {
                ne!(self.video.bottom_vertical_timing.as_bytes())
            }
            Mmio::VideoTopBaseLeft => ne!(self.video.top_base_left.as_bytes()),
            Mmio::VideoTopBaseRight => ne!(self.video.top_base_right.as_bytes()),
            Mmio::VideoBottomBaseLeft => ne!(self.video.bottom_base_left.as_bytes()),
            Mmio::VideoBottomBaseRight => ne!(self.video.bottom_base_right.as_bytes()),
            Mmio::VideoVerticalCount => ne!(self.video.vertical_count.as_bytes()),
            Mmio::VideoHorizontalCount => ne!(self.video.horizontal_count.as_bytes()),

            // Interrupts
            Mmio::VideoDisplayInterrupt0 => ne!(self.video.interrupts[0].as_bytes()),
            Mmio::VideoDisplayInterrupt1 => ne!(self.video.interrupts[1].as_bytes()),
            Mmio::VideoDisplayInterrupt2 => ne!(self.video.interrupts[2].as_bytes()),
            Mmio::VideoDisplayInterrupt3 => ne!(self.video.interrupts[3].as_bytes()),

            Mmio::VideoExternalFramebufferWidth => ne!(self.video.xfb_width.as_bytes()),
            Mmio::VideoHorizontalScaling => ne!(self.video.horizontal_scaling.as_bytes()),

            // Filter Coefficient Table
            Mmio::VideoFilterCoeff0
            | Mmio::VideoFilterCoeff1
            | Mmio::VideoFilterCoeff2
            | Mmio::VideoFilterCoeff3
            | Mmio::VideoFilterCoeff4
            | Mmio::VideoFilterCoeff5
            | Mmio::VideoFilterCoeff6 => P::default(), // NOTE: stubbed

            Mmio::VideoClock => ne!(self.video.clock.as_bytes()),

            // === Processor Interface ===
            // Interrupts
            Mmio::ProcessorInterruptCause => {
                ne!((pi::get_raised_interrupts(self).to_bits().value() as u32).as_bytes())
            }
            Mmio::ProcessorInterruptMask => ne!(self.processor.mask.as_bytes()),

            // FIFO
            Mmio::ProcessorFifoStart => ne!(self.processor.fifo_start.as_bytes()),
            Mmio::ProcessorFifoEnd => ne!(self.processor.fifo_end.as_bytes()),
            Mmio::ProcessorFifoCurrent => ne!(self.processor.fifo_current.as_bytes()),

            // === DSP Interface ===
            Mmio::DspSendMailbox => ne!(self.dsp.cpu_mailbox.as_bytes()),
            Mmio::DspRecvMailbox => {
                let data = ne!(self.dsp.dsp_mailbox.as_bytes());
                if range_overlap(mmio_range.clone(), 0..2) {
                    tracing::debug!(
                        "received from DSP mailbox: 0x{:08X}",
                        self.dsp.dsp_mailbox.to_bits()
                    );

                    self.dsp.dsp_mailbox.set_status(false);
                }

                data
            }
            Mmio::DspControl => ne!(self.dsp.control.as_bytes()),
            Mmio::DspAramSize => ne!(self.dsp.aram_len.as_bytes()),
            Mmio::DspAramMode => ne!((!0u64).as_mut_bytes()), // TODO: figure out this register
            Mmio::DspAramDmaRamBase => ne!(self.dsp.aram_dma.ram_base.as_bytes()),
            Mmio::DspAramDmaAramBase => ne!(self.dsp.aram_dma.aram_base.as_bytes()),
            Mmio::DspAramDmaControl => ne!(self.dsp.aram_dma.control.as_bytes()),
            Mmio::AudioDmaBase => ne!(self.audio.dma_base.as_bytes()),
            Mmio::AudioDmaControl => ne!(self.audio.dma_control.as_bytes()),
            Mmio::AudioDmaRemaining => {
                let remaining = 32
                    * (self.audio.dma_control.length_by_32().value()
                        - self.audio.current_dma_block);
                ne!(remaining.as_bytes())
            }

            // === Disk Interface ===
            Mmio::DiskStatus => ne!(self.disk.status.as_bytes()),
            Mmio::DiskCover => ne!(self.disk.cover.as_bytes()),
            Mmio::DiskDmaBase => ne!(self.disk.dma_base.as_bytes()),
            Mmio::DiskDmaLength => ne!(self.disk.dma_length.as_bytes()),
            Mmio::DiskControl => ne!(self.disk.control.as_bytes()),
            Mmio::DiskImmediateData => ne!(self.disk.immediate.as_bytes()),
            Mmio::DiskConfiguration => ne!(self.disk.config.as_bytes()),

            // === Serial Interface ===
            Mmio::SerialOutputBuf0 => ne!(self.serial.channel_output[0].data.as_bytes()),
            Mmio::SerialInput0High => ne!(self.serial.channel_input[0].high.as_bytes()),
            Mmio::SerialInput0Low => ne!(self.serial.channel_input[0].low.as_bytes()),
            Mmio::SerialOutputBuf1 => ne!(self.serial.channel_output[1].data.as_bytes()),
            Mmio::SerialInput1High => ne!(self.serial.channel_input[1].high.as_bytes()),
            Mmio::SerialInput1Low => ne!(self.serial.channel_input[1].low.as_bytes()),
            Mmio::SerialOutputBuf2 => ne!(self.serial.channel_output[2].data.as_bytes()),
            Mmio::SerialInput2High => ne!(self.serial.channel_input[2].high.as_bytes()),
            Mmio::SerialInput2Low => ne!(self.serial.channel_input[2].low.as_bytes()),
            Mmio::SerialOutputBuf3 => ne!(self.serial.channel_output[3].data.as_bytes()),
            Mmio::SerialInput3High => ne!(self.serial.channel_input[3].high.as_bytes()),
            Mmio::SerialInput3Low => ne!(self.serial.channel_input[3].low.as_bytes()),
            Mmio::SerialPoll => ne!(self.serial.poll.as_bytes()),
            Mmio::SerialCommControl => ne!(self.serial.comm_control.as_bytes()),
            Mmio::SerialStatus => ne!(self.serial.status.as_bytes()),
            Mmio::SerialBuffer => {
                P::read_be_bytes(&self.serial.buffer[offset..offset + size_of::<P>()])
            }

            // === External Interface ===
            Mmio::ExiChannel0Param => ne!(self.external.channel0.parameter.as_bytes()),
            Mmio::ExiChannel0DmaBase => ne!(self.external.channel0.dma_base.as_bytes()),
            Mmio::ExiChannel0DmaLength => ne!(self.external.channel0.dma_length.as_bytes()),
            Mmio::ExiChannel0Control => ne!(self.external.channel0.control.as_bytes()),
            Mmio::ExiChannel0Immediate => ne!(self.external.channel0.immediate.as_bytes()),

            Mmio::ExiChannel1Param => ne!(self.external.channel1.parameter.as_bytes()),
            Mmio::ExiChannel1DmaBase => ne!(self.external.channel1.dma_base.as_bytes()),
            Mmio::ExiChannel1DmaLength => ne!(self.external.channel1.dma_length.as_bytes()),
            Mmio::ExiChannel1Control => ne!(self.external.channel1.control.as_bytes()),
            Mmio::ExiChannel1Immediate => ne!(self.external.channel1.immediate.as_bytes()),

            Mmio::ExiChannel2Param => ne!(self.external.channel2.parameter.as_bytes()),
            Mmio::ExiChannel2DmaBase => ne!(self.external.channel2.dma_base.as_bytes()),
            Mmio::ExiChannel2DmaLength => ne!(self.external.channel2.dma_length.as_bytes()),
            Mmio::ExiChannel2Control => ne!(self.external.channel2.control.as_bytes()),
            Mmio::ExiChannel2Immediate => ne!(self.external.channel2.immediate.as_bytes()),

            // === Audio Interface ===
            Mmio::AudioControl => ne!(self.audio.control.as_bytes()),
            Mmio::AudioSampleCounter => ne!(self.audio.sample_counter.as_bytes()),
            Mmio::AudioInterruptSample => ne!(self.audio.interrupt_sample.as_bytes()),

            _ => {
                tracing::warn!(pc = ?self.cpu.pc, "unimplemented read from known mmio register ({reg:?})");
                P::default()
            }
        };

        if reg.log_reads() {
            tracing::debug!(
                pc = ?self.cpu.pc,
                "reading from {:?}[{:?}]: {:08X}",
                reg,
                mmio_range,
                value
            );
        }

        value
    }

    /// Reads a primitive from the given physical address.
    pub fn read_phys_slow<P: Primitive>(&mut self, addr: Address) -> P {
        let offset: usize;
        map! {
            offset, addr;
            0x0C00_0000, 0xFFFF => self.read_mmio(addr.value() as u16),
            0x0000_0000, RAM_LEN => P::read_be_bytes(&self.mem.ram()[offset..]),
            0xE000_0000, L2C_LEN => P::read_be_bytes(&self.mem.l2c()[offset..]),
            0xFFF0_0000, IPL_LEN / 2 => P::read_be_bytes(&self.mem.ipl()[offset..]),
            @default => {
                std::hint::cold_path();
                tracing::error!(pc = ?self.cpu.pc, "reading from {addr} (unknown region)");
                P::default()
            },
        }
    }

    /// Reads a primitive from the given logical address.
    #[inline(always)]
    pub fn read_slow<P: Primitive>(&mut self, addr: Address) -> Option<P> {
        let addr = self.translate_data_addr(addr)?;
        Some(self.read_phys_slow(addr))
    }

    /// Reads a primitive from the given logical address using fastmem, if possible.
    pub fn read_fast<P: Primitive>(&mut self, addr: Address) -> Option<P> {
        let lut = if self.cpu.supervisor.config.msr.data_addr_translation() {
            self.mem.data_fastmem_lut_logical()
        } else {
            self.mem.data_fastmem_lut_physical()
        };

        let page = addr.value() >> 17;
        let base = lut[page as usize];

        base.map(|base| {
            let offset = addr.value().bits(0, 17) as usize;
            let ptr = unsafe { base.add(offset) };
            unsafe { ptr.cast::<P>().read().to_be() }
        })
    }

    /// Reads a primitive from the given logical address, first by trying to use fastmem and then
    /// falling back to slowmem if not possible.
    #[inline(always)]
    pub fn read<P: Primitive>(&mut self, addr: Address) -> Option<P> {
        self.read_fast(addr).or_else(|| self.read_slow(addr))
    }

    fn write_mmio<P: Primitive>(&mut self, offset: u16, value: P) {
        let Some((reg, offset)) = Mmio::find(offset) else {
            tracing::error!("writing 0x{value:08X} to unknown mmio register ({offset:04X})");
            return;
        };

        // convert the range to native endian
        let mmio_range = if cfg!(target_endian = "big") {
            offset..offset + size_of::<P>()
        } else {
            let size = reg.size() as usize;
            let end = size.saturating_sub(offset);
            let start = end.saturating_sub(size_of::<P>());
            start..end
        };

        if !matches!(reg, Mmio::FakeStdout | Mmio::ProcessorFifo) {
            tracing::debug!(
                pc = ?self.cpu.pc,
                "writing 0x{:08X} to {:?}[{:?}]",
                value,
                reg,
                mmio_range,
            );
        }

        // write to native endian bytes
        macro_rules! ne {
            ($bytes:expr) => {
                value.write_ne_bytes(&mut $bytes[mmio_range.clone()])
            };
        }

        match reg {
            // === Command Processor ===
            Mmio::CpStatus => ne!(self.gpu.cmd.status.as_mut_bytes()),
            Mmio::CpControl => {
                ne!(self.gpu.cmd.control.as_mut_bytes());
                if self.gpu.cmd.control.linked_mode() {
                    gx::cmd::sync_to_pi(self);
                }
            }
            Mmio::CpClear => {
                let mut written = 0;
                ne!(written.as_mut_bytes());
                self.gpu.cmd.write_clear(written);
            }
            Mmio::CpFifoStartLow => {
                ne!(self.gpu.cmd.fifo.start.as_mut_bytes()[0..2]);
                gx::cmd::consume(self);
            }
            Mmio::CpFifoStartHigh => {
                ne!(self.gpu.cmd.fifo.start.as_mut_bytes()[2..4]);
                gx::cmd::consume(self);
            }
            Mmio::CpFifoEndLow => {
                ne!(self.gpu.cmd.fifo.end.as_mut_bytes()[0..2]);
                gx::cmd::consume(self);
            }
            Mmio::CpFifoEndHigh => {
                ne!(self.gpu.cmd.fifo.end.as_mut_bytes()[2..4]);
                gx::cmd::consume(self);
            }
            Mmio::CpHighWatermarkLow => {
                ne!(self.gpu.cmd.fifo.high_mark.as_mut_bytes()[0..2]);
                gx::cmd::consume(self);
            }
            Mmio::CpHighWatermarkHigh => {
                ne!(self.gpu.cmd.fifo.high_mark.as_mut_bytes()[2..4]);
                gx::cmd::consume(self);
            }
            Mmio::CpLowWatermarkLow => {
                ne!(self.gpu.cmd.fifo.low_mark.as_mut_bytes()[0..2]);
                gx::cmd::consume(self);
            }
            Mmio::CpLowWatermarkHigh => {
                ne!(self.gpu.cmd.fifo.low_mark.as_mut_bytes()[2..4]);
                gx::cmd::consume(self);
            }
            // Mmio::CpFifoCountLow => ne!(self.gpu.command.fifo.count().as_mut_bytes()[0..2]),
            // Mmio::CpFifoCountHigh => ne!(self.gpu.command.fifo.count().as_mut_bytes()[2..4]),
            Mmio::CpFifoWritePtrLow => {
                ne!(self.gpu.cmd.fifo.write_ptr.as_mut_bytes()[0..2]);
                gx::cmd::consume(self);
            }
            Mmio::CpFifoWritePtrHigh => {
                ne!(self.gpu.cmd.fifo.write_ptr.as_mut_bytes()[2..4]);
                gx::cmd::consume(self);
            }
            Mmio::CpFifoReadPtrLow => {
                ne!(self.gpu.cmd.fifo.read_ptr.as_mut_bytes()[0..2]);
                gx::cmd::consume(self);
            }
            Mmio::CpFifoReadPtrHigh => {
                ne!(self.gpu.cmd.fifo.read_ptr.as_mut_bytes()[2..4]);
                gx::cmd::consume(self);
            }

            // === Pixel Engine ===
            Mmio::PixelInterruptStatus => {
                let mut written = 0;
                ne!(written.as_mut_bytes());
                self.gpu.pix.write_interrupt(written);
            }

            // === Video Interface ===
            Mmio::VideoVerticalTiming => ne!(self.video.vertical_timing.as_mut_bytes()),
            Mmio::VideoDisplayConfig => {
                ne!(self.video.display_config.as_mut_bytes());
                vi::update(self);
            }
            Mmio::VideoHorizontalTiming => {
                ne!(self.video.horizontal_timing.as_mut_bytes())
            }
            Mmio::VideoOddVerticalTiming => {
                ne!(self.video.top_vertical_timing.as_mut_bytes())
            }
            Mmio::VideoEvenVerticalTiming => {
                ne!(self.video.bottom_vertical_timing.as_mut_bytes())
            }
            Mmio::VideoTopBaseLeft => ne!(self.video.top_base_left.as_mut_bytes()),
            Mmio::VideoTopBaseRight => ne!(self.video.top_base_right.as_mut_bytes()),
            Mmio::VideoBottomBaseLeft => ne!(self.video.bottom_base_left.as_mut_bytes()),
            Mmio::VideoBottomBaseRight => ne!(self.video.bottom_base_right.as_mut_bytes()),

            // Interrupts
            Mmio::VideoDisplayInterrupt0 => {
                let mut written = self.video.interrupts[0];
                ne!(written.as_mut_bytes());
                self.video.write_interrupt::<0>(written);
            }
            Mmio::VideoDisplayInterrupt1 => {
                let mut written = self.video.interrupts[1];
                ne!(written.as_mut_bytes());
                self.video.write_interrupt::<1>(written);
            }
            Mmio::VideoDisplayInterrupt2 => {
                let mut written = self.video.interrupts[2];
                ne!(written.as_mut_bytes());
                self.video.write_interrupt::<2>(written);
            }
            Mmio::VideoDisplayInterrupt3 => {
                let mut written = self.video.interrupts[3];
                ne!(written.as_mut_bytes());
                self.video.write_interrupt::<3>(written);
            }

            Mmio::VideoExternalFramebufferWidth => {
                ne!(self.video.xfb_width.as_mut_bytes())
            }
            Mmio::VideoHorizontalScaling => {
                ne!(self.video.horizontal_scaling.as_mut_bytes())
            }

            // Filter Coefficient Table
            Mmio::VideoFilterCoeff0
            | Mmio::VideoFilterCoeff1
            | Mmio::VideoFilterCoeff2
            | Mmio::VideoFilterCoeff3
            | Mmio::VideoFilterCoeff4
            | Mmio::VideoFilterCoeff5
            | Mmio::VideoFilterCoeff6 => (), // NOTE: stubbed

            Mmio::VideoClock => ne!(self.video.clock.as_mut_bytes()),

            // === Processor Interface ===
            // Interrupts
            Mmio::ProcessorInterruptMask => {
                ne!(self.processor.mask.as_mut_bytes());
                self.scheduler.schedule_now(pi::check_interrupts);
            }

            // FIFO
            Mmio::ProcessorFifoStart => ne!(self.processor.fifo_start.as_mut_bytes()),
            Mmio::ProcessorFifoEnd => {
                ne!(self.processor.fifo_end.as_mut_bytes());
                self.processor.fifo_end += 4;
            }
            Mmio::ProcessorFifoCurrent => ne!(self.processor.fifo_current.as_mut_bytes()),
            Mmio::ProcessorDvdReset => {
                let mut value = 0u32;
                ne!(value.as_mut_bytes());
                di::reset(self, value);
            }

            // === DSP Interface ===
            Mmio::DspSendMailbox => {
                let status = self.dsp.cpu_mailbox.status();
                ne!(self.dsp.cpu_mailbox.as_mut_bytes());

                if range_overlap(mmio_range, 0..2) {
                    self.dsp.cpu_mailbox.set_status(true);
                } else {
                    self.dsp.cpu_mailbox.set_status(status);
                }
            }
            Mmio::DspRecvMailbox => panic!("shouldnt be writing to recv mailbox"),
            Mmio::DspControl => {
                let mut written = self.dsp.control;
                ne!(written.as_mut_bytes());
                dspi::write_control(self, written);
            }
            Mmio::DspAramSize => ne!(self.dsp.aram_len.as_mut_bytes()),
            Mmio::DspAramDmaRamBase => ne!(self.dsp.aram_dma.ram_base.as_mut_bytes()),
            Mmio::DspAramDmaAramBase => ne!(self.dsp.aram_dma.aram_base.as_mut_bytes()),
            Mmio::DspAramDmaControl => {
                ne!(self.dsp.aram_dma.control.as_mut_bytes());

                if range_overlap(mmio_range, 0..2) {
                    self.dsp.control.set_aram_dma_ongoing(true);
                    self.scheduler.schedule(10000, dspi::aram_dma);
                }
            }
            Mmio::AudioDmaBase => ne!(self.audio.dma_base.as_mut_bytes()),
            Mmio::AudioDmaControl => {
                let ongoing = self.audio.dma_control.playing();
                ne!(self.audio.dma_control.as_mut_bytes());
                if !ongoing && self.audio.dma_control.playing() {
                    ai::start_data_dma(self);
                } else if !self.audio.dma_control.playing() {
                    ai::stop_data_dma(self);
                }
            }

            // === Disk Interface ===
            Mmio::DiskStatus => {
                let mut written = di::Status::from_bits(0);
                ne!(written.as_mut_bytes());
                self.disk.write_status(written);
                tracing::debug!(diskstatus = ?self.disk.status);
                self.scheduler.schedule_now(pi::check_interrupts);
            }
            Mmio::DiskCover => {
                let mut written = di::Cover::from_bits(0);
                ne!(written.as_mut_bytes());
                self.disk.write_cover(written);
                self.disk.cover.set_open(false);
                tracing::debug!(diskcover = ?self.disk.cover);
                self.scheduler.schedule_now(pi::check_interrupts);
            }
            Mmio::DiskCommand0 => ne!(self.disk.command_buffer[0].as_mut_bytes()),
            Mmio::DiskCommand1 => ne!(self.disk.command_buffer[1].as_mut_bytes()),
            Mmio::DiskCommand2 => ne!(self.disk.command_buffer[2].as_mut_bytes()),
            Mmio::DiskDmaBase => ne!(self.disk.dma_base.as_mut_bytes()),
            Mmio::DiskDmaLength => ne!(self.disk.dma_length.as_mut_bytes()),
            Mmio::DiskControl => {
                let mut written = di::Control::from_bits(0);
                ne!(written.as_mut_bytes());
                di::write_control(self, written);
            }
            Mmio::DiskConfiguration => {
                ne!(self.disk.config.as_mut_bytes());
            }

            // === Serial Interface ===
            Mmio::SerialOutputBuf0 => {
                ne!(self.serial.channel_output[0].data.as_mut_bytes());
                self.serial.channel_output[0].dirty = true;
            }
            Mmio::SerialOutputBuf1 => {
                ne!(self.serial.channel_output[1].data.as_mut_bytes());
                self.serial.channel_output[1].dirty = true;
            }
            Mmio::SerialOutputBuf2 => {
                ne!(self.serial.channel_output[2].data.as_mut_bytes());
                self.serial.channel_output[2].dirty = true;
            }
            Mmio::SerialOutputBuf3 => {
                ne!(self.serial.channel_output[3].data.as_mut_bytes());
                self.serial.channel_output[3].dirty = true;
            }
            Mmio::SerialPoll => {
                ne!(self.serial.poll.as_mut_bytes());
                tracing::debug!("SI poll: {:?}", self.serial.poll);
            }
            Mmio::SerialCommControl => {
                let mut written = self.serial.comm_control;
                ne!(written.as_mut_bytes());
                si::write_comm_control(self, written);
            }
            Mmio::SerialStatus => {
                let mut written = self.serial.status;
                ne!(written.as_mut_bytes());
                si::write_status(self, written);
            }
            Mmio::SerialBuffer => {
                value.write_be_bytes(&mut self.serial.buffer[offset..offset + size_of::<P>()])
            }

            // === External Interface ===
            Mmio::ExiChannel0Param => {
                let mut written = exi::Parameter::from_bits(0);
                ne!(written.as_mut_bytes());
                self.external.channel0.parameter.write(written);

                // TODO: move this to exi
                if self.external.channel0.parameter.device_select().value() == 0 {
                    self.external.channel0.ipl_state = exi::IplChipState::Idle;
                }
            }
            Mmio::ExiChannel0DmaBase => ne!(self.external.channel0.dma_base.as_mut_bytes()),
            Mmio::ExiChannel0DmaLength => ne!(self.external.channel0.dma_length.as_mut_bytes()),
            Mmio::ExiChannel0Control => {
                ne!(self.external.channel0.control.as_mut_bytes());
                exi::update(self);
            }
            Mmio::ExiChannel0Immediate => ne!(self.external.channel0.immediate.as_mut_bytes()),
            Mmio::ExiChannel1Param => {
                let mut written = exi::Parameter::from_bits(0);
                ne!(written.as_mut_bytes());
                self.external.channel1.parameter.write(written);
            }
            Mmio::ExiChannel1DmaBase => ne!(self.external.channel1.dma_base.as_mut_bytes()),
            Mmio::ExiChannel1DmaLength => ne!(self.external.channel1.dma_length.as_mut_bytes()),
            Mmio::ExiChannel1Control => {
                ne!(self.external.channel1.control.as_mut_bytes());
                exi::update(self);
            }
            Mmio::ExiChannel1Immediate => ne!(self.external.channel1.immediate.as_mut_bytes()),
            Mmio::ExiChannel2Param => {
                let mut written = exi::Parameter::from_bits(0);
                ne!(written.as_mut_bytes());
                self.external.channel2.parameter.write(written);
            }
            Mmio::ExiChannel2DmaBase => ne!(self.external.channel2.dma_base.as_mut_bytes()),
            Mmio::ExiChannel2DmaLength => ne!(self.external.channel2.dma_length.as_mut_bytes()),
            Mmio::ExiChannel2Control => {
                ne!(self.external.channel2.control.as_mut_bytes());
                exi::update(self);
            }
            Mmio::ExiChannel2Immediate => ne!(self.external.channel2.immediate.as_mut_bytes()),

            // === Audio Interface ===
            Mmio::AudioControl => {
                let already_playing = self.audio.control.playing();
                let mut written = self.audio.control;
                ne!(written.as_mut_bytes());
                self.audio.write_control(written);

                if !already_playing && self.audio.control.playing() {
                    ai::start_streaming(self);
                } else if !self.audio.control.playing() {
                    ai::stop_streaming(self);
                }
            }
            Mmio::AudioInterruptSample => ne!(self.audio.interrupt_sample.as_mut_bytes()),

            // === Fake STDOUT ===
            Mmio::FakeStdout => {
                let mut written = 0u8;
                ne!(written.as_mut_bytes());
                print!("{}", written as char);
            }

            // === PI FIFO ===
            Mmio::ProcessorFifo => pi::fifo_push(self, value),
            _ => tracing::warn!("unimplemented write to known mmio register ({reg:?})"),
        }
    }

    /// Writes a primitive to the given physical address.
    pub fn write_phys_slow<P: Primitive>(&mut self, addr: Address, value: P) {
        let offset: usize;
        map! {
            offset, addr;
            0x0C00_0000, 0xFFFF => self.write_mmio(addr.value() as u16, value),
            0x0000_0000, RAM_LEN => value.write_be_bytes(&mut self.mem.ram_mut()[offset..]),
            0xE000_0000, L2C_LEN => value.write_be_bytes(&mut self.mem.l2c_mut()[offset..]),
            0xFFF0_0000, IPL_LEN / 2 => tracing::warn!("bus write to IPL"),
            @default => {
                std::hint::cold_path();
                tracing::error!(pc = ?self.cpu.pc, "writing 0x{value:08X} to {addr} (unknown region)");
            },
        }
    }

    /// Writes a primitive to the given logical address.
    #[inline(always)]
    pub fn write_slow<P: Primitive>(&mut self, addr: Address, value: P) -> bool {
        if let Some(addr) = self.translate_data_addr(addr) {
            self.write_phys_slow(addr, value);
            true
        } else {
            false
        }
    }

    /// Writes a primitive to the given logical address using fastmem, if possible.
    pub fn write_fast<P: Primitive>(&mut self, addr: Address, value: P) -> bool {
        let lut = if self.cpu.supervisor.config.msr.data_addr_translation() {
            self.mem.data_fastmem_lut_logical()
        } else {
            self.mem.data_fastmem_lut_physical()
        };

        let page = addr.value() >> 17;
        let base = lut[page as usize];

        if let Some(base) = base {
            let offset = addr.value().bits(0, 17) as usize;
            let ptr = unsafe { base.add(offset) };
            unsafe { ptr.cast::<P>().write(value.to_be()) }
            true
        } else {
            false
        }
    }

    /// Writes a primitive to the given logical address, first by trying to use fastmem and then
    /// falling back to slowmem if not possible.
    #[inline(always)]
    pub fn write<P: Primitive>(&mut self, addr: Address, value: P) -> bool {
        self.write_fast(addr, value) || self.write_slow(addr, value)
    }
}

#[cfg(test)]
mod tests {
    use gekko::Bat;

    use super::*;
    use crate::modules::audio::NopAudioModule;
    use crate::modules::debug::NopDebugModule;
    use crate::modules::disk::NopDiskModule;
    use crate::modules::input::NopInputModule;
    use crate::modules::render::NopRenderModule;
    use crate::modules::vertex::NopVertexModule;
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

    fn bat(upper: u32, lower: u32) -> Bat {
        Bat::from_bits(u64::from(upper) << 32 | u64::from(lower))
    }

    #[test]
    fn reservation_translation_uses_current_pr_validity_and_bat_protection() {
        let mut sys = test_system();
        let effective = Address(0x9000_0020);
        let physical = Address(0x0000_0020);
        sys.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        sys.cpu.supervisor.config.msr.set_user_mode(true);

        // User-valid, read-only. A matching protected BAT has precedence over later entries.
        sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0001, 0x0000_0001);
        sys.cpu.supervisor.memory.dbat[1] = bat(0x9000_0001, 0x0000_0002);
        assert_eq!(
            sys.translate_data_reservation_addr(effective, false),
            Ok(physical)
        );
        assert_eq!(
            sys.translate_data_reservation_addr(effective, true),
            Err(DataReservationFault::Protection)
        );

        // The same BAT is invalid when PR selects supervisor validity.
        sys.cpu.supervisor.config.msr.set_user_mode(false);
        assert_eq!(
            sys.translate_data_reservation_addr(effective, false),
            Err(DataReservationFault::Translation)
        );

        // A supervisor-valid PP=2 mapping permits both read and write.
        sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0002, 0x0000_0002);
        assert_eq!(
            sys.translate_data_reservation_addr(effective, false),
            Ok(physical)
        );
        assert_eq!(
            sys.translate_data_reservation_addr(effective, true),
            Ok(physical)
        );

        sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0002, 0x0000_0000);
        assert_eq!(
            sys.translate_data_reservation_addr(effective, false),
            Err(DataReservationFault::Protection)
        );
    }

    #[test]
    fn reservation_faults_encode_precise_data_storage_causes() {
        assert_eq!(DataReservationFault::Translation.dsisr(false), 0x4000_0000);
        assert_eq!(DataReservationFault::Translation.dsisr(true), 0x4200_0000);
        assert_eq!(DataReservationFault::Protection.dsisr(false), 0x0800_0000);
        assert_eq!(DataReservationFault::Protection.dsisr(true), 0x0a00_0000);
        assert_eq!(DataReservationFault::Backing.dsisr(false), 0);
        assert_eq!(DataReservationFault::Backing.dsisr(true), 0x0200_0000);
    }

    #[test]
    fn reservation_backing_accepts_only_complete_ram_and_locked_cache_words() {
        let mut sys = test_system();

        assert!(sys.write_data_reservation_phys(Address(0x20), 0x1122_3344));
        assert_eq!(
            sys.read_data_reservation_phys(Address(0x20)),
            Some(0x1122_3344)
        );

        let locked_cache = Address(L2C_START + 0x20);
        assert!(sys.write_data_reservation_phys(locked_cache, 0x5566_7788));
        assert_eq!(
            sys.read_data_reservation_phys(locked_cache),
            Some(0x5566_7788)
        );

        for unbacked in [
            Address(RAM_LEN as u32 - 2),
            Address(0x0c00_0100),
            Address(0x1000_0000),
            Address(0xfff0_0100),
        ] {
            assert_eq!(sys.read_data_reservation_phys(unbacked), None);
            assert!(!sys.write_data_reservation_phys(unbacked, 0x7f00_00ff));
        }
    }
}
