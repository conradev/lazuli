mod mmio;

use std::ops::Range;

use bitos::BitUtils;
use gekko::Address;
use zerocopy::IntoBytes;

use crate::Primitive;
use crate::system::mem::{FASTMEM_PAGE_BYTES, IPL_LEN, L2C_LEN, L2C_START, RAM_LEN};
use crate::system::mmu::{RangeTranslationFault, TranslationEffect, TranslationFault};
use crate::system::scheduler::MachineEventDeadlines;
use crate::system::{System, ai, di, dspi, exi, gx, pi, si, vi};

#[rustfmt::skip]
pub use mmio::Mmio;

fn range_overlap(a: Range<usize>, b: Range<usize>) -> bool {
    (a.start < b.end) && (b.start < a.end)
}

fn region_offset(address: u32, bytes: usize, start: u32, len: usize) -> Option<usize> {
    let offset = address.checked_sub(start)? as usize;
    offset.checked_add(bytes).filter(|end| *end <= len)?;
    Some(offset)
}

fn read_backing<P: Primitive>(backing: &[u8], offset: usize) -> Option<P> {
    let end = offset.checked_add(size_of::<P>())?;
    Some(P::read_be_bytes(backing.get(offset..end)?))
}

fn write_backing<P: Primitive>(backing: &mut [u8], offset: usize, value: P) -> bool {
    let Some(end) = offset.checked_add(size_of::<P>()) else {
        return false;
    };
    let Some(destination) = backing.get_mut(offset..end) else {
        return false;
    };
    value.write_be_bytes(destination);
    true
}

/// Returns `Some` only for an access overlapping the DI register window. Resident browser DI
/// authenticates the same scalar shapes as the frozen browser machine: status, cover, and the
/// seven command/DMA/immediate words are exact aligned words; configuration and every partial or
/// overlapping store are rejected before device synchronization.
fn resident_disk_write_shape(address: u32, bytes: usize) -> Option<bool> {
    const START: u32 = 0x0c00_6000;
    const END: u32 = 0x0c00_6028;
    let access_end = u64::from(address).checked_add(bytes as u64)?;
    if access_end <= u64::from(START) || address >= END {
        return None;
    }
    Some(
        bytes == size_of::<u32>()
            && matches!(
                address,
                0x0c00_6000
                    | 0x0c00_6004
                    | 0x0c00_6008
                    | 0x0c00_600c
                    | 0x0c00_6010
                    | 0x0c00_6014
                    | 0x0c00_6018
                    | 0x0c00_601c
                    | 0x0c00_6020
            ),
    )
}

/// Authenticates browser-resident DSP/AI scalar stores before any due device is serviced.
///
/// DSPCSR and ARAM/AID keep the frozen browser oracle's exact lane shapes. AI register state is
/// lane-addressable so partial writes can retain phase and W1C semantics in Rust. Writes to the
/// DSP-produced receive mailbox are architecturally rejected instead of reaching the legacy
/// panic arm.
fn resident_audio_dsp_write_shape(address: u32, bytes: usize) -> Option<bool> {
    let access_end = u64::from(address).checked_add(bytes as u64)?;
    let overlaps =
        |start: u32, end: u32| access_end > u64::from(start) && u64::from(address) < u64::from(end);

    if overlaps(0x0c00_5004, 0x0c00_5008) {
        return Some(false);
    }
    if overlaps(0x0c00_500a, 0x0c00_500c) {
        return Some(matches!(
            (address, bytes),
            (0x0c00_5008, 4) | (0x0c00_500a, 2 | 1) | (0x0c00_500b, 1)
        ));
    }
    if overlaps(0x0c00_5020, 0x0c00_502c) {
        return Some(matches!(
            (address, bytes),
            (0x0c00_5020 | 0x0c00_5024 | 0x0c00_5028, 4)
                | (
                    0x0c00_5020
                        | 0x0c00_5022
                        | 0x0c00_5024
                        | 0x0c00_5026
                        | 0x0c00_5028
                        | 0x0c00_502a,
                    2,
                )
        ));
    }
    if overlaps(0x0c00_5034, 0x0c00_5038) {
        return Some(matches!(
            (address, bytes),
            (0x0c00_5034, 4) | (0x0c00_5036, 2)
        ));
    }
    for (start, end) in [
        (0x0c00_6c00, 0x0c00_6c04),
        (0x0c00_6c08, 0x0c00_6c0c),
        (0x0c00_6c0c, 0x0c00_6c10),
    ] {
        if overlaps(start, end) {
            let contained = address >= start && access_end <= u64::from(end);
            let scalar = matches!(bytes, 1 | 2 | 4);
            let aligned = bytes == 1 || address.is_multiple_of(bytes as u32);
            return Some(contained && scalar && aligned);
        }
    }
    None
}

fn apply_resident_disk_register_write(
    result: Result<(), di::ResidentRegisterWriteError>,
) -> Result<(), ResidentMmioError> {
    match result {
        Ok(())
        | Err(
            di::ResidentRegisterWriteError::Busy { .. }
            | di::ResidentRegisterWriteError::StartPending,
        ) => Ok(()),
        Err(error @ di::ResidentRegisterWriteError::InvalidCommandWord(_)) => Err(error.into()),
    }
}

fn apply_resident_disk_control_write(
    result: Result<Option<di::ResidentCommandStart>, di::ResidentStartError>,
) -> Result<(), ResidentMmioError> {
    match result {
        Ok(_) => Ok(()),
        Err(
            di::ResidentStartError::Busy { .. }
            | di::ResidentStartError::StartPending
            | di::ResidentStartError::InvalidControlMode { .. }
            | di::ResidentStartError::UnsupportedDmaCommand { .. }
            | di::ResidentStartError::InvalidReadSubcommand(_)
            | di::ResidentStartError::InvalidInquiryLength(_)
            | di::ResidentStartError::ZeroRequestedLength
            | di::ResidentStartError::ZeroDmaLength
            | di::ResidentStartError::Mem1Range { .. }
            | di::ResidentStartError::DiscRangeUnknown
            | di::ResidentStartError::DiscRangeOverflow,
        ) => Ok(()),
        Err(
            error @ (di::ResidentStartError::CycleOverflow
            | di::ResidentStartError::RequestIdExhausted
            | di::ResidentStartError::PayloadAllocationFailed { .. }),
        ) => Err(error.into()),
    }
}

/// Architecturally backed target reached by one completed data translation.
///
/// The resident browser machine uses this classification to distinguish an ordinary slow RAM
/// path (for example a hashed-page miss) from an architected device access. The distinction is
/// derived from the exact translation used for the access; callers must not translate a second
/// time merely to decide whether the resident dispatcher may continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataAccessTarget {
    Memory,
    Mmio,
}

/// Result of one cycle-aware scalar slow read that may reach the asynchronous EFB aperture.
///
/// `EfbPeek` carries the physical address produced by the same architectural translation used
/// for the guest access.  The browser machine must retain that address across its cooperative
/// yield and must not translate the unchanged load again when the renderer receipt arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentDataRead<P> {
    Complete { value: P, target: DataAccessTarget },
    EfbPeek { physical: u32 },
}

/// Internal failure while applying a cycle-aware resident MMIO mutation.
///
/// These are emulator-policy failures, not guest DSI conditions. The browser machine converts
/// them into a sticky Rust machine exit instead of fabricating DAR/DSISR state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentMmioError {
    Video(vi::ResidentError),
    Audio(ai::ResidentAudioError),
    Dsp(dspi::ResidentDspServiceError),
    Aram(dspi::AramDmaError),
    Serial(si::SerialServiceError),
    Disk(ResidentDiskMmioError),
}

/// A resident DI register write was rejected before any guest-visible partial mutation could be
/// accepted. Keeping register-programming and command-start failures distinct makes the browser
/// machine's sticky exit useful without moving either policy decision into the host adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentDiskMmioError {
    Register(di::ResidentRegisterWriteError),
    Start(di::ResidentStartError),
    AudioSchedule(di::ResidentAudioScheduleError),
    Reset(di::ResidentResetError),
}

impl From<vi::ResidentError> for ResidentMmioError {
    fn from(error: vi::ResidentError) -> Self {
        Self::Video(error)
    }
}

impl From<ai::ResidentAudioError> for ResidentMmioError {
    fn from(error: ai::ResidentAudioError) -> Self {
        Self::Audio(error)
    }
}

impl From<dspi::ResidentDspServiceError> for ResidentMmioError {
    fn from(error: dspi::ResidentDspServiceError) -> Self {
        Self::Dsp(error)
    }
}

impl From<dspi::AramDmaError> for ResidentMmioError {
    fn from(error: dspi::AramDmaError) -> Self {
        Self::Aram(error)
    }
}

impl From<si::SerialServiceError> for ResidentMmioError {
    fn from(error: si::SerialServiceError) -> Self {
        Self::Serial(error)
    }
}

impl From<di::ResidentRegisterWriteError> for ResidentMmioError {
    fn from(error: di::ResidentRegisterWriteError) -> Self {
        Self::Disk(ResidentDiskMmioError::Register(error))
    }
}

impl From<di::ResidentStartError> for ResidentMmioError {
    fn from(error: di::ResidentStartError) -> Self {
        Self::Disk(ResidentDiskMmioError::Start(error))
    }
}

impl From<di::ResidentAudioScheduleError> for ResidentMmioError {
    fn from(error: di::ResidentAudioScheduleError) -> Self {
        Self::Disk(ResidentDiskMmioError::AudioSchedule(error))
    }
}

impl From<di::ResidentResetError> for ResidentMmioError {
    fn from(error: di::ResidentResetError) -> Self {
        Self::Disk(ResidentDiskMmioError::Reset(error))
    }
}

/// Exact outcome of a resident data write: either an architected guest access fault or an
/// internal cycle-aware device failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentDataAccessError {
    Access(DataAccessFault),
    Mmio(ResidentMmioError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResidentDevicePolicy {
    Allow,
    Reject,
    QuantizedStore,
}

fn physical_data_access_target(
    address: Address,
    bytes: usize,
    write: bool,
) -> Option<DataAccessTarget> {
    let address = address.value();
    if region_offset(address, bytes, 0x0c00_0000, 0x1_0000).is_some() {
        return Some(DataAccessTarget::Mmio);
    }
    if region_offset(address, bytes, 0, RAM_LEN).is_some()
        || region_offset(address, bytes, L2C_START, L2C_LEN).is_some()
        || (!write && region_offset(address, bytes, 0xfff0_0000, IPL_LEN / 2).is_some())
    {
        return Some(DataAccessTarget::Memory);
    }
    None
}

fn is_aligned_efb_peek_address(physical: u32, bytes: usize) -> bool {
    bytes == size_of::<u32>()
        && physical.is_multiple_of(size_of::<u32>() as u32)
        && (physical & 0xf800_0000) == 0x0800_0000
        && physical < 0x0c00_0000
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataReservationFault {
    Translation,
    Protection,
    Backing,
}

/// Failure of an ordinary architected data access.
///
/// The MMU retains the complete range failure so diagnostics can distinguish a translation
/// fault from a malformed/cross-mapping access. DSISR is derived here, in Rust, before the JIT
/// asks the generated block to enter the DSI vector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataAccessFault {
    Range(RangeTranslationFault),
    Backing { physical: u32, write: bool },
}

impl DataAccessFault {
    pub const fn dsisr(self) -> u32 {
        match self {
            Self::Range(RangeTranslationFault::Translation { fault, .. }) => {
                match fault.data_storage_cause() {
                    Some(cause) => cause,
                    None => 0,
                }
            }
            Self::Range(
                RangeTranslationFault::InvalidRange { access, .. }
                | RangeTranslationFault::NonContiguous { access, .. },
            ) => {
                if access.is_write() {
                    0x0200_0000
                } else {
                    0
                }
            }
            Self::Backing { write, .. } => {
                if write {
                    0x0200_0000
                } else {
                    0
                }
            }
        }
    }
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
    fn resident_serial_service_timing_at(&self, observed_cycle: u64) -> si::ViSerialTiming {
        let anchor_cycle = self
            .serial
            .next_poll_cycle()
            .filter(|scheduled| *scheduled <= observed_cycle)
            .unwrap_or(observed_cycle);
        self.video
            .serial_timing_at_cycle(anchor_cycle)
            .unwrap_or_else(|| si::ViSerialTiming::disabled_at(anchor_cycle))
    }

    /// Synchronizes migrated register-visible devices after one retained translation has proven
    /// that the access targets MMIO. Ordinary hashed/slow RAM never enters this path.
    fn synchronize_resident_mmio_at(
        &mut self,
        observed_cycle: u64,
    ) -> Result<(), ResidentMmioError> {
        let mut deadlines = MachineEventDeadlines::default();
        let prior_reschedules = self.video.resident_timing_reschedules();
        self.video
            .service_resident_due_events(observed_cycle)
            .map_err(ResidentMmioError::Video)?;
        self.video.publish_resident_deadlines(&mut deadlines);
        pi::check_interrupts(self);

        // Preserve the frozen browser service order: VI, AI, then the complete DSP phase
        // (AID -> ARAM -> LLE) before SI and DI. Each Rust-owned phase refreshes its level IRQ
        // only after all of that phase's sources have settled.
        self.service_resident_audio_interface(observed_cycle, &mut deadlines)
            .map_err(ResidentMmioError::Audio)?;
        self.service_resident_dsp(observed_cycle, &mut deadlines)
            .map_err(ResidentMmioError::Dsp)?;

        if self.video.resident_timing_reschedules() != prior_reschedules {
            if let Some(timing) = self.video.serial_timing_at_cycle(observed_cycle) {
                self.serial
                    .synchronize_poll_timing(timing, observed_cycle, &mut deadlines)
                    .map_err(|error| ResidentMmioError::Serial(error.into()))?;
            } else {
                self.serial.clear_poll_timing(&mut deadlines);
            }
        }
        let timing = self.resident_serial_service_timing_at(observed_cycle);
        si::service_due(self, timing, observed_cycle, &mut deadlines)
            .map_err(ResidentMmioError::Serial)?;
        let System { disk, mem, cpu, .. } = self;
        disk.service_resident(observed_cycle, mem.ram_mut(), &mut cpu.reservation);
        Ok(())
    }

    /// Reads instruction storage accepted by the browser machine.
    ///
    /// Instruction fetches may target MEM1 or locked cache. MMIO, IPL, and unbacked physical
    /// addresses are not converted into zero instructions.
    pub fn read_instruction_phys<P: Primitive>(&self, addr: Address) -> Option<P> {
        let address = addr.value();
        if let Some(offset) = region_offset(address, size_of::<P>(), 0, RAM_LEN) {
            return read_backing(self.mem.ram(), offset);
        }
        if let Some(offset) = region_offset(address, size_of::<P>(), L2C_START, L2C_LEN) {
            return read_backing(self.mem.l2c(), offset);
        }
        None
    }

    /// Resolves an architected load/store-reservation access through the machine-owned MMU.
    pub fn translate_data_reservation_addr(
        &mut self,
        addr: Address,
        write: bool,
    ) -> Result<Address, DataReservationFault> {
        match self.translate_data_mmu(addr, write, TranslationEffect::Architectural) {
            Ok(mapping) => Ok(Address(mapping.physical)),
            Err(TranslationFault::Protection { .. }) => Err(DataReservationFault::Protection),
            Err(TranslationFault::PageTableUnbacked { .. }) => Err(DataReservationFault::Backing),
            Err(TranslationFault::PageFault { .. } | TranslationFault::DirectStore { .. }) => {
                Err(DataReservationFault::Translation)
            }
            Err(TranslationFault::Guarded { .. } | TranslationFault::NoExecute { .. }) => {
                unreachable!("instruction-only fault returned for a data reservation")
            }
        }
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
            0x0000_0000, RAM_LEN => read_backing(self.mem.ram(), offset),
            0xFFF0_0000, IPL_LEN / 2 => read_backing(self.mem.ipl(), offset),
            @default => None
        }
    }

    /// Reads a primitive from the given physical address, but only if it can't possibly have a
    /// side effect.
    pub fn read_pure<P: Primitive>(&self, addr: Address) -> Option<P> {
        self.translate_data_addr(addr)
            .and_then(|addr| self.read_phys_pure(addr))
    }

    fn read_mmio_inner<P: Primitive>(&mut self, offset: u16, resident: bool) -> P {
        if size_of::<P>() == size_of::<u32>() && matches!(offset, 0x5034 | 0x5038) {
            // The browser accepts aligned word reads spanning the unmapped halfword beside AID
            // control/remaining. Lazuli does not retain the unused high lane, so it reads zero.
            let low = if offset == 0x5034 {
                self.audio.dma_control.to_bits()
            } else if resident {
                self.audio.resident_dsp_audio_dma.blocks_left()
            } else {
                self.audio
                    .dma_control
                    .length_by_32()
                    .value()
                    .saturating_sub(self.audio.current_dma_block)
            };
            let mut bytes = [0_u8; size_of::<u32>()];
            bytes[2..].copy_from_slice(&low.to_be_bytes());
            return P::read_be_bytes(&bytes);
        }

        let Some((reg, offset)) = Mmio::find(offset) else {
            tracing::error!(pc = ?self.cpu.pc, "reading from unknown mmio register ({offset:04X})");
            return P::default();
        };

        let register_size = reg.size() as usize;
        let Some(access_end) = offset.checked_add(size_of::<P>()) else {
            tracing::warn!(
                ?reg,
                offset,
                size = size_of::<P>(),
                "rejecting overflowing MMIO read"
            );
            return P::default();
        };
        if access_end > register_size {
            tracing::warn!(
                ?reg,
                offset,
                size = size_of::<P>(),
                register_size,
                "rejecting MMIO read wider than its register"
            );
            return P::default();
        }

        // convert the range to native endian
        let mmio_range = if cfg!(target_endian = "big") {
            offset..offset + size_of::<P>()
        } else {
            (register_size - access_end)..(register_size - offset)
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
                let status = self.gpu.cmd.read_status();
                ne!(status.as_bytes())
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
            Mmio::CpFifoBreakpointLow => {
                ne!(self.gpu.cmd.fifo.breakpoint.as_bytes()[0..2])
            }
            Mmio::CpFifoBreakpointHigh => {
                ne!(self.gpu.cmd.fifo.breakpoint.as_bytes()[2..4])
            }

            // === Pixel Engine ===
            Mmio::PixelAlphaRead => ne!(self.gpu.pix.alpha_read.as_bytes()),
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
                ne!((pi::get_active_interrupts(self).to_bits().value() as u32).as_bytes())
            }
            Mmio::ProcessorInterruptMask => ne!(self.processor.mask.as_bytes()),

            // FIFO
            Mmio::ProcessorFifoStart => ne!(self.processor.fifo_start.as_bytes()),
            Mmio::ProcessorFifoEnd => ne!(self.processor.fifo_end.as_bytes()),
            Mmio::ProcessorFifoCurrent => ne!(self.processor.fifo_current.as_bytes()),
            Mmio::ProcessorFifoReset => P::default(),

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
                let remaining = if resident {
                    self.audio.resident_dsp_audio_dma.blocks_left()
                } else {
                    32 * self
                        .audio
                        .dma_control
                        .length_by_32()
                        .value()
                        .saturating_sub(self.audio.current_dma_block)
                };
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

        // IN_HI/IN_LO are one-entry SI mailboxes. The browser parity path clears RDST only after
        // an exact full-register read; partial or crossing accesses keep the unread sample live.
        if offset == 0 && size_of::<P>() == size_of::<u32>() {
            let channel = match reg {
                Mmio::SerialInput0High | Mmio::SerialInput0Low => Some(0),
                Mmio::SerialInput1High | Mmio::SerialInput1Low => Some(1),
                Mmio::SerialInput2High | Mmio::SerialInput2Low => Some(2),
                Mmio::SerialInput3High | Mmio::SerialInput3Low => Some(3),
                _ => None,
            };
            if let Some(channel) = channel {
                self.serial.finish_input_read(channel);
            }
        }

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

    fn read_mmio<P: Primitive>(&mut self, offset: u16) -> P {
        self.read_mmio_inner(offset, false)
    }

    fn read_mmio_resident<P: Primitive>(&mut self, offset: u16) -> P {
        self.read_mmio_inner(offset, true)
    }

    /// Reads a primitive from the given physical address.
    pub fn read_phys_slow<P: Primitive>(&mut self, addr: Address) -> P {
        let offset: usize;
        map! {
            offset, addr;
            0x0C00_0000, 0xFFFF => self.read_mmio(addr.value() as u16),
            0x0000_0000, RAM_LEN => read_backing(self.mem.ram(), offset).unwrap_or_default(),
            0xE000_0000, L2C_LEN => read_backing(self.mem.l2c(), offset).unwrap_or_default(),
            0xFFF0_0000, IPL_LEN / 2 => read_backing(self.mem.ipl(), offset).unwrap_or_default(),
            @default => {
                std::hint::cold_path();
                tracing::error!(pc = ?self.cpu.pc, "reading from {addr} (unknown region)");
                P::default()
            },
        }
    }

    /// Reads a primitive from the given logical address and retains the precise fault.
    #[inline(always)]
    pub fn read_slow_result_classified<P: Primitive>(
        &mut self,
        addr: Address,
    ) -> Result<(P, DataAccessTarget), DataAccessFault> {
        let mapping = self
            .translate_data_range_mmu(
                addr,
                size_of::<P>() as u64,
                false,
                TranslationEffect::Architectural,
            )
            .map_err(DataAccessFault::Range)?;
        let Some(target) =
            physical_data_access_target(Address(mapping.physical), size_of::<P>(), false)
        else {
            return Err(DataAccessFault::Backing {
                physical: mapping.physical,
                write: false,
            });
        };
        Ok((self.read_phys_slow(Address(mapping.physical)), target))
    }

    /// Reads through one exact architectural translation and synchronizes migrated MMIO state at
    /// the authenticated instruction-start cycle only when that translation resolves to a device.
    #[inline(always)]
    fn read_slow_result_classified_at_with<P: Primitive>(
        &mut self,
        addr: Address,
        observed_cycle: u64,
        device_policy: ResidentDevicePolicy,
    ) -> Result<(P, DataAccessTarget), ResidentDataAccessError> {
        let mapping = self
            .translate_data_range_mmu(
                addr,
                size_of::<P>() as u64,
                false,
                TranslationEffect::Architectural,
            )
            .map_err(|fault| ResidentDataAccessError::Access(DataAccessFault::Range(fault)))?;
        let Some(target) =
            physical_data_access_target(Address(mapping.physical), size_of::<P>(), false)
        else {
            return Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                physical: mapping.physical,
                write: false,
            }));
        };
        if target == DataAccessTarget::Mmio {
            if device_policy == ResidentDevicePolicy::Reject {
                return Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                    physical: mapping.physical,
                    write: false,
                }));
            }
            self.synchronize_resident_mmio_at(observed_cycle)
                .map_err(ResidentDataAccessError::Mmio)?;
            return Ok((self.read_mmio_resident(mapping.physical as u16), target));
        }
        Ok((self.read_phys_slow(Address(mapping.physical)), target))
    }

    /// Performs one exact architectural slow translation while preserving an aligned word read
    /// from the physical EFB aperture as a deferred Rust-machine operation.
    ///
    /// No value is read and no guest fault state is authored for `EfbPeek`. All other shapes,
    /// including byte/halfword/doubleword or unaligned aperture reads, retain the ordinary
    /// unbacked-access fault path.
    #[inline(always)]
    fn read_slow_result_classified_at_deferred<P: Primitive>(
        &mut self,
        addr: Address,
        observed_cycle: u64,
    ) -> Result<ResidentDataRead<P>, ResidentDataAccessError> {
        let mapping = self
            .translate_data_range_mmu(
                addr,
                size_of::<P>() as u64,
                false,
                TranslationEffect::Architectural,
            )
            .map_err(|fault| ResidentDataAccessError::Access(DataAccessFault::Range(fault)))?;
        if is_aligned_efb_peek_address(mapping.physical, size_of::<P>()) {
            return Ok(ResidentDataRead::EfbPeek {
                physical: mapping.physical,
            });
        }
        let Some(target) =
            physical_data_access_target(Address(mapping.physical), size_of::<P>(), false)
        else {
            return Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                physical: mapping.physical,
                write: false,
            }));
        };
        if target == DataAccessTarget::Mmio {
            self.synchronize_resident_mmio_at(observed_cycle)
                .map_err(ResidentDataAccessError::Mmio)?;
            return Ok(ResidentDataRead::Complete {
                value: self.read_mmio_resident(mapping.physical as u16),
                target,
            });
        }
        Ok(ResidentDataRead::Complete {
            value: self.read_phys_slow(Address(mapping.physical)),
            target,
        })
    }

    /// Cycle-aware scalar slow read. Architected MMIO is allowed and reported as a device target.
    #[inline(always)]
    pub fn read_slow_result_classified_at<P: Primitive>(
        &mut self,
        addr: Address,
        observed_cycle: u64,
    ) -> Result<(P, DataAccessTarget), ResidentDataAccessError> {
        self.read_slow_result_classified_at_with(addr, observed_cycle, ResidentDevicePolicy::Allow)
    }

    /// Reads a primitive through the exact slow path while discarding only its target class.
    #[inline(always)]
    pub fn read_slow_result<P: Primitive>(&mut self, addr: Address) -> Result<P, DataAccessFault> {
        self.read_slow_result_classified(addr)
            .map(|(value, _)| value)
    }

    /// Reads through the exact slow path, discarding fault detail for legacy callers.
    #[inline(always)]
    pub fn read_slow<P: Primitive>(&mut self, addr: Address) -> Option<P> {
        self.read_slow_result(addr).ok()
    }

    /// Reads a primitive from the given logical address using fastmem, if possible.
    pub fn read_fast<P: Primitive>(&mut self, addr: Address) -> Option<P> {
        let lut = if self.cpu.supervisor.config.msr.data_addr_translation() {
            self.mem.data_fastmem_lut_logical_read()
        } else {
            self.mem.data_fastmem_lut_physical_read()
        };

        let page = addr.value() >> 17;
        let base = lut[page as usize];

        let offset = addr.value().bits(0, 17) as usize;
        if offset.checked_add(size_of::<P>())? > FASTMEM_PAGE_BYTES as usize {
            return None;
        }
        base.map(|base| {
            let ptr = unsafe { base.add(offset) };
            unsafe { ptr.cast::<P>().read_unaligned().to_be() }
        })
    }

    /// Reads a primitive from the given logical address, first by trying to use fastmem and then
    /// falling back to slowmem if not possible.
    #[inline(always)]
    pub fn read<P: Primitive>(&mut self, addr: Address) -> Option<P> {
        self.read_fast(addr).or_else(|| self.read_slow(addr))
    }

    /// Reads through fastmem when legal and otherwise returns the precise slow-path fault.
    #[inline(always)]
    pub fn read_result<P: Primitive>(&mut self, addr: Address) -> Result<P, DataAccessFault> {
        self.read_fast(addr)
            .map_or_else(|| self.read_slow_result(addr), Ok)
    }

    /// Reads through fastmem when legal and otherwise retains the exact completed target class.
    #[inline(always)]
    pub fn read_result_classified<P: Primitive>(
        &mut self,
        addr: Address,
    ) -> Result<(P, DataAccessTarget), DataAccessFault> {
        self.read_fast(addr).map_or_else(
            || self.read_slow_result_classified(addr),
            |value| Ok((value, DataAccessTarget::Memory)),
        )
    }

    /// Resident counterpart of [`Self::read_result_classified`]. Fast and slow RAM do no device
    /// work; only the single completed slow translation may enter the MMIO synchronizer.
    #[inline(always)]
    pub fn read_result_classified_at<P: Primitive>(
        &mut self,
        addr: Address,
        observed_cycle: u64,
    ) -> Result<(P, DataAccessTarget), ResidentDataAccessError> {
        self.read_fast(addr).map_or_else(
            || self.read_slow_result_classified_at(addr, observed_cycle),
            |value| Ok((value, DataAccessTarget::Memory)),
        )
    }

    /// Resident scalar read that preserves an EFB aperture result without a second translation.
    #[inline(always)]
    pub fn read_result_classified_at_deferred<P: Primitive>(
        &mut self,
        addr: Address,
        observed_cycle: u64,
    ) -> Result<ResidentDataRead<P>, ResidentDataAccessError> {
        self.read_fast(addr).map_or_else(
            || self.read_slow_result_classified_at_deferred(addr, observed_cycle),
            |value| {
                Ok(ResidentDataRead::Complete {
                    value,
                    target: DataAccessTarget::Memory,
                })
            },
        )
    }

    /// Cycle-aware quantized backing read. MMIO is rejected after the single translation and
    /// before any device synchronization or read side effect.
    #[inline(always)]
    pub fn read_memory_result_classified_at<P: Primitive>(
        &mut self,
        addr: Address,
        observed_cycle: u64,
    ) -> Result<(P, DataAccessTarget), ResidentDataAccessError> {
        self.read_fast(addr).map_or_else(
            || {
                self.read_slow_result_classified_at_with(
                    addr,
                    observed_cycle,
                    ResidentDevicePolicy::Reject,
                )
            },
            |value| Ok((value, DataAccessTarget::Memory)),
        )
    }

    fn write_mmio_inner<P: Primitive>(
        &mut self,
        offset: u16,
        value: P,
        resident_cycle: Option<u64>,
    ) -> Result<(), ResidentMmioError> {
        if offset == 0x5008 && size_of::<P>() == size_of::<u32>() {
            // Retail code can use one aligned word store whose low half lands on DSPCSR. The
            // high half occupies an unmapped register lane, matching the browser LLE contract.
            let mut bytes = [0; size_of::<u32>()];
            value.write_be_bytes(&mut bytes);
            let control = u16::from_be_bytes([bytes[2], bytes[3]]);
            dspi::write_control(self, dspi::Control::from_bits(control));
            if resident_cycle.is_some() {
                pi::check_interrupts(self);
            }
            return Ok(());
        }

        if offset == 0x5034 && size_of::<P>() == size_of::<u32>() {
            // Retail code also uses one word whose low half is AID control. The neighboring high
            // lane is not architected in Lazuli, but must not hide the control edge.
            let mut bytes = [0; size_of::<u32>()];
            value.write_be_bytes(&mut bytes);
            let written = ai::DmaControl::from_bits(u16::from_be_bytes([bytes[2], bytes[3]]));
            if let Some(cycle) = resident_cycle {
                self.audio
                    .write_dsp_audio_dma_control_at(written, cycle)
                    .map_err(ResidentMmioError::Audio)?;
            } else {
                let ongoing = self.audio.dma_control.playing();
                self.audio.dma_control = written;
                if !ongoing && self.audio.dma_control.playing() {
                    ai::start_data_dma(self);
                } else if !self.audio.dma_control.playing() {
                    ai::stop_data_dma(self);
                }
            }
            return Ok(());
        }

        let Some((reg, offset)) = Mmio::find(offset) else {
            tracing::error!("writing 0x{value:08X} to unknown mmio register ({offset:04X})");
            return Ok(());
        };

        let register_size = reg.size() as usize;
        let Some(access_end) = offset.checked_add(size_of::<P>()) else {
            tracing::warn!(
                ?reg,
                offset,
                size = size_of::<P>(),
                "rejecting overflowing MMIO write"
            );
            return Ok(());
        };
        if access_end > register_size {
            tracing::warn!(
                ?reg,
                offset,
                size = size_of::<P>(),
                register_size,
                "rejecting MMIO write wider than its register"
            );
            return Ok(());
        }

        // convert the range to native endian
        let mmio_range = if cfg!(target_endian = "big") {
            offset..offset + size_of::<P>()
        } else {
            let end = register_size - offset;
            let start = register_size - access_end;
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
            // CP status is read-only; source acknowledgement belongs to CP_CLEAR.
            Mmio::CpStatus => (),
            Mmio::CpControl => {
                let mut written = self.gpu.cmd.control.to_bits();
                ne!(written.as_mut_bytes());
                self.gpu.cmd.control = gx::cmd::Control::from_bits(written & 0x003f);
                gx::cmd::consume(self);
            }
            Mmio::CpClear => {
                let mut written = 0;
                ne!(written.as_mut_bytes());
                self.gpu.cmd.write_clear(written);
                self.scheduler.schedule_now(pi::check_interrupts);
            }
            Mmio::CpFifoStartLow => {
                ne!(self.gpu.cmd.fifo.start.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.start.0 &= 0x03ff_ffe0;
            }
            Mmio::CpFifoStartHigh => {
                ne!(self.gpu.cmd.fifo.start.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.start.0 &= 0x03ff_ffe0;
            }
            Mmio::CpFifoEndLow => {
                ne!(self.gpu.cmd.fifo.end.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.end.0 &= 0x03ff_ffe0;
            }
            Mmio::CpFifoEndHigh => {
                ne!(self.gpu.cmd.fifo.end.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.end.0 &= 0x03ff_ffe0;
            }
            Mmio::CpHighWatermarkLow => {
                ne!(self.gpu.cmd.fifo.high_mark.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.high_mark &= 0x03ff_ffe0;
            }
            Mmio::CpHighWatermarkHigh => {
                ne!(self.gpu.cmd.fifo.high_mark.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.high_mark &= 0x03ff_ffe0;
                gx::cmd::refresh_interrupts(self);
            }
            Mmio::CpLowWatermarkLow => {
                ne!(self.gpu.cmd.fifo.low_mark.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.low_mark &= 0x03ff_ffe0;
            }
            Mmio::CpLowWatermarkHigh => {
                ne!(self.gpu.cmd.fifo.low_mark.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.low_mark &= 0x03ff_ffe0;
                gx::cmd::refresh_interrupts(self);
            }
            Mmio::CpFifoCountLow => {
                ne!(self.gpu.cmd.fifo.distance.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.distance &= 0x03ff_ffe0;
            }
            Mmio::CpFifoCountHigh => {
                ne!(self.gpu.cmd.fifo.distance.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.distance &= 0x03ff_ffe0;
                gx::cmd::consume(self);
            }
            Mmio::CpFifoWritePtrLow => {
                ne!(self.gpu.cmd.fifo.write_ptr.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.write_ptr.0 &= 0x03ff_ffe0;
            }
            Mmio::CpFifoWritePtrHigh => {
                ne!(self.gpu.cmd.fifo.write_ptr.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.write_ptr.0 &= 0x03ff_ffe0;
            }
            Mmio::CpFifoReadPtrLow => {
                ne!(self.gpu.cmd.fifo.read_ptr.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.read_ptr.0 &= 0x03ff_ffe0;
            }
            Mmio::CpFifoReadPtrHigh => {
                ne!(self.gpu.cmd.fifo.read_ptr.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.read_ptr.0 &= 0x03ff_ffe0;
                gx::cmd::consume(self);
            }
            Mmio::CpFifoBreakpointLow => {
                ne!(self.gpu.cmd.fifo.breakpoint.as_mut_bytes()[0..2]);
                self.gpu.cmd.fifo.breakpoint.0 &= 0x03ff_ffe0;
            }
            Mmio::CpFifoBreakpointHigh => {
                ne!(self.gpu.cmd.fifo.breakpoint.as_mut_bytes()[2..4]);
                self.gpu.cmd.fifo.breakpoint.0 &= 0x03ff_ffe0;
                gx::cmd::consume(self);
            }

            // === Pixel Engine ===
            Mmio::PixelAlphaRead => {
                let mut written = self.gpu.pix.alpha_read;
                ne!(written.as_mut_bytes());
                self.gpu.pix.alpha_read = written & 3;
            }
            Mmio::PixelInterruptStatus => {
                let mut written = 0_u16;
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    let mut written_mask = 0_u16;
                    written_mask.as_mut_bytes()[mmio_range].fill(0xff);
                    self.write_resident_pixel_engine_control_masked(written, written_mask);
                } else {
                    self.gpu.pix.write_interrupt(written);
                }
            }

            // === Video Interface ===
            Mmio::VideoVerticalTiming => {
                let mut written = self.video.vertical_timing;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_vertical_timing_at(written, cycle)?;
                } else {
                    self.video.vertical_timing = written;
                }
            }
            Mmio::VideoDisplayConfig => {
                let mut written = self.video.display_config;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_display_config_at(written, cycle)?;
                } else {
                    self.video.display_config = written;
                    vi::update(self);
                }
            }
            Mmio::VideoHorizontalTiming => {
                let mut written = self.video.horizontal_timing;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_horizontal_timing_at(written, cycle)?;
                } else {
                    self.video.horizontal_timing = written;
                }
            }
            Mmio::VideoOddVerticalTiming => {
                let mut written = self.video.top_vertical_timing;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_top_vertical_timing_at(written, cycle)?;
                } else {
                    self.video.top_vertical_timing = written;
                }
            }
            Mmio::VideoEvenVerticalTiming => {
                let mut written = self.video.bottom_vertical_timing;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_bottom_vertical_timing_at(written, cycle)?;
                } else {
                    self.video.bottom_vertical_timing = written;
                }
            }
            Mmio::VideoTopBaseLeft => {
                let mut written = self.video.top_base_left;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_top_base_at(written, cycle)?;
                } else {
                    self.video.top_base_left = written;
                }
            }
            Mmio::VideoTopBaseRight => ne!(self.video.top_base_right.as_mut_bytes()),
            Mmio::VideoBottomBaseLeft => {
                let mut written = self.video.bottom_base_left;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_bottom_base_at(written, cycle)?;
                } else {
                    self.video.bottom_base_left = written;
                }
            }
            Mmio::VideoBottomBaseRight => ne!(self.video.bottom_base_right.as_mut_bytes()),

            // Interrupts
            Mmio::VideoDisplayInterrupt0 => {
                let mut written = self.video.interrupts[0];
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_interrupt_at::<0>(written, cycle)?;
                } else {
                    self.video.write_interrupt::<0>(written);
                }
            }
            Mmio::VideoDisplayInterrupt1 => {
                let mut written = self.video.interrupts[1];
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_interrupt_at::<1>(written, cycle)?;
                } else {
                    self.video.write_interrupt::<1>(written);
                }
            }
            Mmio::VideoDisplayInterrupt2 => {
                let mut written = self.video.interrupts[2];
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_interrupt_at::<2>(written, cycle)?;
                } else {
                    self.video.write_interrupt::<2>(written);
                }
            }
            Mmio::VideoDisplayInterrupt3 => {
                let mut written = self.video.interrupts[3];
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_interrupt_at::<3>(written, cycle)?;
                } else {
                    self.video.write_interrupt::<3>(written);
                }
            }

            Mmio::VideoExternalFramebufferWidth => {
                let mut written = self.video.xfb_width;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_xfb_width_at(written, cycle)?;
                } else {
                    self.video.xfb_width = written;
                }
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

            Mmio::VideoClock => {
                let mut written = self.video.clock;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    self.video.write_clock_at(written, cycle)?;
                } else {
                    self.video.clock = written;
                }
            }

            // === Processor Interface ===
            // Interrupts
            Mmio::ProcessorInterruptCause => {
                let mut written = 0u32;
                ne!(written.as_mut_bytes());
                // PI cause is W1C, but modeled sources own their level. Re-sampling CP makes a
                // live request reassert immediately while a resolved sticky request is retained.
                gx::cmd::refresh_interrupts(self);
            }
            Mmio::ProcessorInterruptMask => {
                ne!(self.processor.mask.as_mut_bytes());
                self.scheduler.schedule_now(pi::check_interrupts);
            }

            // FIFO
            Mmio::ProcessorFifoStart => {
                ne!(self.processor.fifo_start.as_mut_bytes());
                self.processor.fifo_start.0 &= 0x03ff_ffe0;
            }
            Mmio::ProcessorFifoEnd => {
                ne!(self.processor.fifo_end.as_mut_bytes());
                self.processor.fifo_end.0 &= 0x07ff_ffe0;
            }
            Mmio::ProcessorFifoCurrent => {
                ne!(self.processor.fifo_current.as_mut_bytes());
                let address = self.processor.fifo_current.address();
                self.processor
                    .fifo_current
                    .set_address(Address(address.value() & 0x03ff_ffe0));
            }
            Mmio::ProcessorFifoReset => {
                let mut written = 0u32;
                ne!(written.as_mut_bytes());
                if written.bit(0) {
                    pi::reset_fifo(self);
                }
            }
            Mmio::ProcessorDvdReset => {
                let mut value = 0u32;
                ne!(value.as_mut_bytes());
                di::reset(self, value)?;
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
            Mmio::DspRecvMailbox => {
                // Authenticated resident stores are rejected before synchronization. Keep this
                // private seam fail-closed too; a legacy caller is ignored instead of panicking.
            }
            Mmio::DspControl => {
                let mut written = self.dsp.control;
                ne!(written.as_mut_bytes());
                let mut written_mask = 0_u16;
                written_mask.as_mut_bytes()[mmio_range].fill(0xff);
                dspi::write_control_masked(self, written, written_mask);
                if resident_cycle.is_some() {
                    pi::check_interrupts(self);
                }
            }
            Mmio::DspAramSize => ne!(self.dsp.aram_len.as_mut_bytes()),
            Mmio::DspAramDmaRamBase => {
                let mut written = self.dsp.aram_dma.ram_base.value();
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    self.dsp.aram_dma.write_ram_base(written);
                } else {
                    self.dsp.aram_dma.ram_base = Address(written);
                }
            }
            Mmio::DspAramDmaAramBase => {
                let mut written = self.dsp.aram_dma.aram_base;
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    self.dsp.aram_dma.write_aram_base(written);
                } else {
                    self.dsp.aram_dma.aram_base = written;
                }
            }
            Mmio::DspAramDmaControl => {
                let mut written = self.dsp.aram_dma.control;
                ne!(written.as_mut_bytes());

                if let Some(cycle) = resident_cycle {
                    if range_overlap(mmio_range, 0..2) {
                        // A full-word or low-half store composes the complete register and
                        // triggers. Busy retriggers are authenticated guest no-ops.
                        let _ = self.start_resident_aram_dma(written.to_bits(), cycle)?;
                    } else {
                        self.dsp
                            .aram_dma
                            .write_count_without_start(written.to_bits());
                    }
                } else {
                    self.dsp.aram_dma.control = written;
                    if range_overlap(mmio_range, 0..2) {
                        self.dsp.control.set_aram_dma_ongoing(true);
                        self.scheduler.schedule(10000, dspi::aram_dma);
                    }
                }
            }
            Mmio::AudioDmaBase => ne!(self.audio.dma_base.as_mut_bytes()),
            Mmio::AudioDmaControl => {
                let mut written = self.audio.dma_control;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    let mut written_mask = 0_u16;
                    written_mask.as_mut_bytes()[mmio_range].fill(0xff);
                    self.audio
                        .write_dsp_audio_dma_control_masked_at(written, written_mask, cycle)
                        .map_err(ResidentMmioError::Audio)?;
                } else {
                    let ongoing = self.audio.dma_control.playing();
                    self.audio.dma_control = written;
                    if !ongoing && self.audio.dma_control.playing() {
                        ai::start_data_dma(self);
                    } else if !self.audio.dma_control.playing() {
                        ai::stop_data_dma(self);
                    }
                }
            }

            // === Disk Interface ===
            Mmio::DiskStatus => {
                let mut written = di::Status::from_bits(0);
                ne!(written.as_mut_bytes());
                self.disk.write_status(written);
                tracing::debug!(diskstatus = ?self.disk.status);
                if resident_cycle.is_none() {
                    self.scheduler.schedule_now(pi::check_interrupts);
                }
            }
            Mmio::DiskCover => {
                let mut written = di::Cover::from_bits(0);
                ne!(written.as_mut_bytes());
                self.disk.write_cover(written);
                self.disk.cover.set_open(false);
                tracing::debug!(diskcover = ?self.disk.cover);
                if resident_cycle.is_none() {
                    self.scheduler.schedule_now(pi::check_interrupts);
                }
            }
            Mmio::DiskCommand0 => {
                let mut written = self.disk.command_buffer[0];
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    apply_resident_disk_register_write(
                        self.disk.write_resident_command_word(0, written),
                    )?;
                } else {
                    self.disk.command_buffer[0] = written;
                }
            }
            Mmio::DiskCommand1 => {
                let mut written = self.disk.command_buffer[1];
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    apply_resident_disk_register_write(
                        self.disk.write_resident_command_word(1, written),
                    )?;
                } else {
                    self.disk.command_buffer[1] = written;
                }
            }
            Mmio::DiskCommand2 => {
                let mut written = self.disk.command_buffer[2];
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    apply_resident_disk_register_write(
                        self.disk.write_resident_command_word(2, written),
                    )?;
                } else {
                    self.disk.command_buffer[2] = written;
                }
            }
            Mmio::DiskDmaBase => {
                let mut written = self.disk.dma_base.value();
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    apply_resident_disk_register_write(
                        self.disk.write_resident_dma_address(written),
                    )?;
                } else {
                    self.disk.dma_base = Address(written);
                }
            }
            Mmio::DiskDmaLength => {
                let mut written = self.disk.dma_length;
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    apply_resident_disk_register_write(
                        self.disk.write_resident_dma_length(written),
                    )?;
                } else {
                    self.disk.dma_length = written;
                }
            }
            Mmio::DiskControl => {
                let mut written = di::Control::from_bits(0);
                ne!(written.as_mut_bytes());
                if let Some(observed_cycle) = resident_cycle {
                    let System { disk, mem, cpu, .. } = self;
                    apply_resident_disk_control_write(disk.write_resident_control(
                        written.to_bits(),
                        observed_cycle,
                        mem.ram_mut(),
                        &mut cpu.reservation,
                    ))?;
                } else {
                    di::write_control(self, written);
                }
            }
            Mmio::DiskImmediateData => {
                let mut written = self.disk.immediate;
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    apply_resident_disk_register_write(
                        self.disk.write_resident_immediate(written),
                    )?;
                } else {
                    self.disk.immediate = written;
                }
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
                if let Some(cycle) = resident_cycle {
                    self.serial.write_comm_control_at(written, cycle)?;
                } else {
                    si::write_comm_control(self, written);
                }
            }
            Mmio::SerialStatus => {
                let mut written = self.serial.status;
                ne!(written.as_mut_bytes());
                if resident_cycle.is_some() {
                    self.serial.write_status(written);
                } else {
                    si::write_status(self, written);
                }
            }
            Mmio::SerialBuffer => {
                value.write_be_bytes(&mut self.serial.buffer[offset..offset + size_of::<P>()])
            }

            // === External Interface ===
            Mmio::ExiChannel0Param => {
                let mut written = self.external.channel0.parameter;
                ne!(written.as_mut_bytes());
                let mut written_mask = 0_u32;
                written_mask.as_mut_bytes()[mmio_range.clone()].fill(0xff);
                exi::write_parameter_masked(self, 0, written, written_mask);
            }
            Mmio::ExiChannel0DmaBase => {
                ne!(self.external.channel0.dma_base.as_mut_bytes());
                self.external.channel0.dma_base.0 &= exi::DMA_REGISTER_MASK;
            }
            Mmio::ExiChannel0DmaLength => {
                ne!(self.external.channel0.dma_length.as_mut_bytes());
                self.external.channel0.dma_length &= exi::DMA_REGISTER_MASK;
            }
            Mmio::ExiChannel0Control => {
                ne!(self.external.channel0.control.as_mut_bytes());
                self.external.channel0.control = exi::Control::from_bits(
                    self.external.channel0.control.to_bits() & exi::CONTROL_REGISTER_MASK,
                );
                exi::update_at(
                    self,
                    resident_cycle.unwrap_or_else(|| self.scheduler.elapsed()),
                );
            }
            Mmio::ExiChannel0Immediate => ne!(self.external.channel0.immediate.as_mut_bytes()),
            Mmio::ExiChannel1Param => {
                let mut written = self.external.channel1.parameter;
                ne!(written.as_mut_bytes());
                let mut written_mask = 0_u32;
                written_mask.as_mut_bytes()[mmio_range.clone()].fill(0xff);
                exi::write_parameter_masked(self, 1, written, written_mask);
            }
            Mmio::ExiChannel1DmaBase => {
                ne!(self.external.channel1.dma_base.as_mut_bytes());
                self.external.channel1.dma_base.0 &= exi::DMA_REGISTER_MASK;
            }
            Mmio::ExiChannel1DmaLength => {
                ne!(self.external.channel1.dma_length.as_mut_bytes());
                self.external.channel1.dma_length &= exi::DMA_REGISTER_MASK;
            }
            Mmio::ExiChannel1Control => {
                ne!(self.external.channel1.control.as_mut_bytes());
                self.external.channel1.control = exi::Control::from_bits(
                    self.external.channel1.control.to_bits() & exi::CONTROL_REGISTER_MASK,
                );
                exi::update_at(
                    self,
                    resident_cycle.unwrap_or_else(|| self.scheduler.elapsed()),
                );
            }
            Mmio::ExiChannel1Immediate => ne!(self.external.channel1.immediate.as_mut_bytes()),
            Mmio::ExiChannel2Param => {
                let mut written = self.external.channel2.parameter;
                ne!(written.as_mut_bytes());
                let mut written_mask = 0_u32;
                written_mask.as_mut_bytes()[mmio_range.clone()].fill(0xff);
                exi::write_parameter_masked(self, 2, written, written_mask);
            }
            Mmio::ExiChannel2DmaBase => {
                ne!(self.external.channel2.dma_base.as_mut_bytes());
                self.external.channel2.dma_base.0 &= exi::DMA_REGISTER_MASK;
            }
            Mmio::ExiChannel2DmaLength => {
                ne!(self.external.channel2.dma_length.as_mut_bytes());
                self.external.channel2.dma_length &= exi::DMA_REGISTER_MASK;
            }
            Mmio::ExiChannel2Control => {
                ne!(self.external.channel2.control.as_mut_bytes());
                self.external.channel2.control = exi::Control::from_bits(
                    self.external.channel2.control.to_bits() & exi::CONTROL_REGISTER_MASK,
                );
                exi::update_at(
                    self,
                    resident_cycle.unwrap_or_else(|| self.scheduler.elapsed()),
                );
            }
            Mmio::ExiChannel2Immediate => ne!(self.external.channel2.immediate.as_mut_bytes()),

            // === Audio Interface ===
            Mmio::AudioControl => {
                let mut written = self.audio.control;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    let mut written_mask = 0_u32;
                    written_mask.as_mut_bytes()[mmio_range].fill(0xff);
                    self.audio
                        .write_control_masked_at(written, written_mask, cycle)
                        .map_err(ResidentMmioError::Audio)?;
                    self.disk.synchronize_resident_ai_state(
                        self.audio.control.playing(),
                        self.audio.control.effective_aux_sample_rate(),
                        cycle,
                    )?;
                    pi::check_interrupts(self);
                } else {
                    let already_playing = self.audio.control.playing();
                    self.audio.write_control(written);
                    if !already_playing && self.audio.control.playing() {
                        ai::start_streaming(self);
                    } else if !self.audio.control.playing() {
                        ai::stop_streaming(self);
                    }
                }
            }
            Mmio::AudioSampleCounter => {
                let mut written = self.audio.sample_counter;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    let mut written_mask = 0_u32;
                    written_mask.as_mut_bytes()[mmio_range].fill(0xff);
                    self.audio
                        .write_sample_counter_masked_at(written, written_mask, cycle)
                        .map_err(ResidentMmioError::Audio)?;
                    pi::check_interrupts(self);
                } else {
                    self.audio.sample_counter = written;
                }
            }
            Mmio::AudioInterruptSample => {
                let mut written = self.audio.interrupt_sample;
                ne!(written.as_mut_bytes());
                if let Some(cycle) = resident_cycle {
                    let mut written_mask = 0_u32;
                    written_mask.as_mut_bytes()[mmio_range].fill(0xff);
                    self.audio
                        .write_interrupt_sample_masked_at(written, written_mask, cycle)
                        .map_err(ResidentMmioError::Audio)?;
                    pi::check_interrupts(self);
                } else {
                    self.audio.interrupt_sample = written;
                }
            }

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
        Ok(())
    }

    fn write_mmio<P: Primitive>(&mut self, offset: u16, value: P) {
        self.write_mmio_inner(offset, value, None)
            .expect("legacy MMIO writes do not enter cycle-aware resident device paths");
    }

    fn write_mmio_resident<P: Primitive>(
        &mut self,
        offset: u16,
        value: P,
        observed_cycle: u64,
    ) -> Result<(), ResidentMmioError> {
        self.write_mmio_inner(offset, value, Some(observed_cycle))
    }

    /// Writes a primitive to the given physical address.
    pub fn write_phys_slow<P: Primitive>(&mut self, addr: Address, value: P) {
        let offset: usize;
        map! {
            offset, addr;
            0x0C00_0000, 0xFFFF => self.write_mmio(addr.value() as u16, value),
            0x0000_0000, RAM_LEN => { write_backing(self.mem.ram_mut(), offset, value); },
            0xE000_0000, L2C_LEN => { write_backing(self.mem.l2c_mut(), offset, value); },
            0xFFF0_0000, IPL_LEN / 2 => tracing::warn!("bus write to IPL"),
            @default => {
                std::hint::cold_path();
                tracing::error!(pc = ?self.cpu.pc, "writing 0x{value:08X} to {addr} (unknown region)");
            },
        }
    }

    /// Writes a primitive to the given logical address and retains the precise fault.
    #[inline(always)]
    pub fn write_slow_result_classified<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
    ) -> Result<DataAccessTarget, DataAccessFault> {
        let mapping = self
            .translate_data_range_mmu(
                addr,
                size_of::<P>() as u64,
                true,
                TranslationEffect::Architectural,
            )
            .map_err(DataAccessFault::Range)?;
        let Some(target) =
            physical_data_access_target(Address(mapping.physical), size_of::<P>(), true)
        else {
            return Err(DataAccessFault::Backing {
                physical: mapping.physical,
                write: true,
            });
        };
        self.write_phys_slow(Address(mapping.physical), value);
        Ok(target)
    }

    /// Writes through the exact architectural translation while routing MMIO mutations through
    /// the resident cycle-aware VI/SI entry points.
    ///
    /// The returned target is derived from this same translation. No second probe is performed to
    /// decide whether the dispatcher must cross a device boundary.
    #[inline(always)]
    fn write_slow_result_classified_at_with<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
        observed_cycle: u64,
        device_policy: ResidentDevicePolicy,
    ) -> Result<DataAccessTarget, ResidentDataAccessError> {
        let mapping = self
            .translate_data_range_mmu(
                addr,
                size_of::<P>() as u64,
                true,
                TranslationEffect::Architectural,
            )
            .map_err(|fault| ResidentDataAccessError::Access(DataAccessFault::Range(fault)))?;
        let Some(target) =
            physical_data_access_target(Address(mapping.physical), size_of::<P>(), true)
        else {
            return Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                physical: mapping.physical,
                write: true,
            }));
        };
        match target {
            DataAccessTarget::Memory => {
                self.write_phys_slow(Address(mapping.physical), value);
            }
            DataAccessTarget::Mmio => {
                let quantized_fifo = device_policy == ResidentDevicePolicy::QuantizedStore
                    && region_offset(mapping.physical, size_of::<P>(), 0x0c00_8000, 0x20).is_some();
                if device_policy == ResidentDevicePolicy::Reject
                    || (device_policy == ResidentDevicePolicy::QuantizedStore && !quantized_fifo)
                {
                    return Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                        physical: mapping.physical,
                        write: true,
                    }));
                }
                if device_policy == ResidentDevicePolicy::Allow
                    && (resident_disk_write_shape(mapping.physical, size_of::<P>()) == Some(false)
                        || resident_audio_dsp_write_shape(mapping.physical, size_of::<P>())
                            == Some(false))
                {
                    return Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                        physical: mapping.physical,
                        write: true,
                    }));
                }
                self.synchronize_resident_mmio_at(observed_cycle)
                    .map_err(ResidentDataAccessError::Mmio)?;
                self.write_mmio_resident(mapping.physical as u16, value, observed_cycle)
                    .map_err(ResidentDataAccessError::Mmio)?;
            }
        }
        Ok(target)
    }

    /// Cycle-aware scalar slow write. Architected MMIO is allowed and reported as a device target.
    #[inline(always)]
    pub fn write_slow_result_classified_at<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
        observed_cycle: u64,
    ) -> Result<DataAccessTarget, ResidentDataAccessError> {
        self.write_slow_result_classified_at_with(
            addr,
            value,
            observed_cycle,
            ResidentDevicePolicy::Allow,
        )
    }

    /// Writes through the exact slow path while discarding only its target class.
    #[inline(always)]
    pub fn write_slow_result<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
    ) -> Result<(), DataAccessFault> {
        self.write_slow_result_classified(addr, value).map(|_| ())
    }

    /// Writes through the exact slow path, discarding fault detail for legacy callers.
    #[inline(always)]
    pub fn write_slow<P: Primitive>(&mut self, addr: Address, value: P) -> bool {
        self.write_slow_result(addr, value).is_ok()
    }

    /// Writes a primitive to the given logical address using fastmem, if possible.
    pub fn write_fast<P: Primitive>(&mut self, addr: Address, value: P) -> bool {
        let lut = if self.cpu.supervisor.config.msr.data_addr_translation() {
            self.mem.data_fastmem_lut_logical_write()
        } else {
            self.mem.data_fastmem_lut_physical_write()
        };

        let page = addr.value() >> 17;
        let base = lut[page as usize];

        let offset = addr.value().bits(0, 17) as usize;
        if offset
            .checked_add(size_of::<P>())
            .is_none_or(|end| end > FASTMEM_PAGE_BYTES as usize)
        {
            return false;
        }
        if let Some(base) = base {
            let ptr = unsafe { base.add(offset) };
            unsafe { ptr.cast::<P>().write_unaligned(value.to_be()) }
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

    /// Writes through fastmem when legal and otherwise returns the precise slow-path fault.
    #[inline(always)]
    pub fn write_result<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
    ) -> Result<(), DataAccessFault> {
        if self.write_fast(addr, value) {
            Ok(())
        } else {
            self.write_slow_result(addr, value)
        }
    }

    /// Writes through fastmem when legal and otherwise retains the exact completed target class.
    #[inline(always)]
    pub fn write_result_classified<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
    ) -> Result<DataAccessTarget, DataAccessFault> {
        if self.write_fast(addr, value) {
            Ok(DataAccessTarget::Memory)
        } else {
            self.write_slow_result_classified(addr, value)
        }
    }

    /// Resident counterpart of [`Self::write_result_classified`]. Fast RAM remains entirely
    /// resident; only the slow path can resolve to an architected device.
    #[inline(always)]
    pub fn write_result_classified_at<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
        observed_cycle: u64,
    ) -> Result<DataAccessTarget, ResidentDataAccessError> {
        if self.write_fast(addr, value) {
            Ok(DataAccessTarget::Memory)
        } else {
            self.write_slow_result_classified_at(addr, value, observed_cycle)
        }
    }

    /// Cycle-aware quantized backing write. Ordinary MMIO is rejected before device
    /// synchronization or mutation; the architected write-gather pipe remains an accepted device
    /// target and appends the exact quantized bytes to PI/GX.
    #[inline(always)]
    pub fn write_memory_result_classified_at<P: Primitive>(
        &mut self,
        addr: Address,
        value: P,
        observed_cycle: u64,
    ) -> Result<DataAccessTarget, ResidentDataAccessError> {
        if self.write_fast(addr, value) {
            Ok(DataAccessTarget::Memory)
        } else {
            self.write_slow_result_classified_at_with(
                addr,
                value,
                observed_cycle,
                ResidentDevicePolicy::QuantizedStore,
            )
        }
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
    fn resident_word_read_preserves_one_translated_efb_aperture_address() {
        let mut direct = test_system();
        assert_eq!(
            direct.read_result_classified_at_deferred::<i32>(Address(0x0842_3454), 77),
            Ok(ResidentDataRead::EfbPeek {
                physical: 0x0842_3454,
            })
        );

        let mut translated = test_system();
        translated
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        translated.cpu.supervisor.memory.dbat[0] = bat(0x9000_0002, 0x0800_0002);
        assert_eq!(
            translated.read_result_classified_at_deferred::<i32>(Address(0x9001_7044), 91),
            Ok(ResidentDataRead::EfbPeek {
                physical: 0x0801_7044,
            })
        );
    }

    #[test]
    fn nonword_and_unaligned_efb_aperture_reads_remain_guest_faults() {
        let mut system = test_system();
        for result in [
            system
                .read_result_classified_at_deferred::<i8>(Address(0x0800_0100), 0)
                .map(|_| ()),
            system
                .read_result_classified_at_deferred::<i16>(Address(0x0800_0100), 0)
                .map(|_| ()),
            system
                .read_result_classified_at_deferred::<i64>(Address(0x0800_0100), 0)
                .map(|_| ()),
            system
                .read_result_classified_at_deferred::<i32>(Address(0x0800_0102), 0)
                .map(|_| ()),
        ] {
            assert!(matches!(
                result,
                Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                    write: false,
                    ..
                }))
            ));
        }
    }

    #[test]
    fn pixel_alpha_read_register_retains_raw_mode_and_exposes_canonical_mode() {
        let mut system = test_system();
        assert_eq!(
            system.write_slow_result_classified_at(Address(0x0c00_1008), 3_u16, 12),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(system.gpu.pix.alpha_read, 3);
        assert_eq!(system.gpu.pix.canonical_alpha_read_mode(), 0);
        assert_eq!(system.read_slow::<u16>(Address(0x0c00_1008)), Some(3));

        assert_eq!(
            system.write_slow_result_classified_at(Address(0x0c00_1008), 2_u16, 13),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(system.gpu.pix.canonical_alpha_read_mode(), 2);
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
    fn reservation_translation_uses_rust_hashed_mmu_and_commits_history() {
        let mut sys = test_system();
        let effective = Address(0x8123_4020);
        let physical_page = 0x0010_0000;
        let segment = 0x0001_2345;
        sys.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        sys.cpu.supervisor.memory.sr[8] = segment;
        sys.cpu.supervisor.memory.sdr1 = 0;

        let vector = crate::system::mmu::page_table_vector(effective.value(), segment, 0);
        sys.write_phys_slow(Address(vector.primary_pteg), vector.primary_pte0);
        sys.write_phys_slow(Address(vector.primary_pteg + 4), physical_page | 2u32);

        assert_eq!(
            sys.translate_data_reservation_addr(effective, false),
            Ok(Address(physical_page + 0x20))
        );
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(vector.primary_pteg + 4)),
            physical_page | 0x0100 | 2
        );

        assert_eq!(
            sys.translate_data_reservation_addr(effective, true),
            Ok(Address(physical_page + 0x20))
        );
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(vector.primary_pteg + 4)),
            physical_page | 0x0180 | 2
        );

        sys.write_phys_slow(Address(physical_page + 0x20), 0x1122_3344u32);
        assert_eq!(sys.read_slow::<u32>(effective), Some(0x1122_3344));
        assert!(sys.write_slow(effective, 0xaabb_ccddu32));
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(physical_page + 0x20)),
            0xaabb_ccdd
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

    #[test]
    fn ipl_is_fast_readable_but_never_fast_writable() {
        let mut sys = test_system();
        let address = Address(crate::system::mem::IPL_START + 0x100);
        let original = sys.read_fast::<u32>(address).expect("IPL fast read");

        assert!(!sys.write_fast(address, !original));
        assert!(!sys.write(address, !original));
        assert_eq!(sys.read_fast::<u32>(address), Some(original));
    }

    #[test]
    fn fastmem_never_crosses_a_page_or_partial_backing() {
        let mut sys = test_system();
        sys.mem.ram_mut()[1..5].copy_from_slice(&0x1122_3344u32.to_be_bytes());
        assert_eq!(sys.read_fast::<u32>(Address(1)), Some(0x1122_3344));

        let page_edge = Address(FASTMEM_PAGE_BYTES - 2);
        assert_eq!(sys.read_fast::<u32>(page_edge), None);
        assert!(!sys.write_fast(page_edge, 0x5566_7788u32));

        let locked_cache = Address(L2C_START);
        assert_eq!(sys.read_fast::<u32>(locked_cache), None);
        assert!(!sys.write_fast(locked_cache, 0x99aa_bbccu32));

        let ram_edge = Address(RAM_LEN as u32 - 2);
        assert_eq!(sys.read_slow::<u32>(ram_edge), None);
        assert!(!sys.write_slow(ram_edge, 0xddee_ff00u32));
    }

    #[test]
    fn translated_fastmem_defers_permissions_and_priority_to_mmu() {
        let mut sys = test_system();
        let effective = Address(0x9000_0020);
        sys.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        // First matching BAT is read-only. A later writable overlap must not win.
        sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0002, 0x0000_0001);
        sys.cpu.supervisor.memory.dbat[1] = bat(0x9000_0002, 0x0000_0002);
        let dbats = sys.cpu.supervisor.memory.dbat.clone();
        sys.mem.build_data_bat_lut(&dbats);
        sys.write_phys_slow(Address(0x20), 0x1234_5678u32);

        assert_eq!(sys.read_fast::<u32>(effective), None);
        assert!(!sys.write_fast(effective, 0xffff_ffffu32));
        assert_eq!(sys.read_slow::<u32>(effective), Some(0x1234_5678));
        assert!(!sys.write_slow(effective, 0xffff_ffffu32));
        assert_eq!(sys.read_phys_slow::<u32>(Address(0x20)), 0x1234_5678);
    }

    #[test]
    fn ordinary_access_faults_encode_exact_data_storage_causes() {
        use crate::system::mmu::{AccessKind, Translation, TranslationSource};

        let page = DataAccessFault::Range(RangeTranslationFault::Translation {
            effective_start: 0x8000_1000,
            len: 4,
            fault_effective: 0x8000_1000,
            fault: TranslationFault::PageFault {
                effective: 0x8000_1000,
                access: AccessKind::DataRead,
                primary_pteg: 0x1000,
                secondary_pteg: 0x2000,
            },
        });
        assert_eq!(page.dsisr(), 0x4000_0000);

        let protection = DataAccessFault::Range(RangeTranslationFault::Translation {
            effective_start: 0x8000_1000,
            len: 4,
            fault_effective: 0x8000_1000,
            fault: TranslationFault::Protection {
                mapping: Translation {
                    effective: 0x8000_1000,
                    physical: 0x1000,
                    access: AccessKind::DataWrite,
                    source: TranslationSource::Real,
                },
            },
        });
        assert_eq!(protection.dsisr(), 0x0a00_0000);
        assert_eq!(
            DataAccessFault::Backing {
                physical: 0xdead_0000,
                write: false,
            }
            .dsisr(),
            0
        );
        assert_eq!(
            DataAccessFault::Backing {
                physical: 0xdead_0000,
                write: true,
            }
            .dsisr(),
            0x0200_0000
        );
    }

    #[test]
    fn data_target_classification_covers_the_complete_mmio_window() {
        assert_eq!(
            physical_data_access_target(Address(0x0c00_ffff), 1, false),
            Some(DataAccessTarget::Mmio)
        );
        assert_eq!(
            physical_data_access_target(Address(0x0c00_ffff), 2, false),
            None
        );
        assert_eq!(
            physical_data_access_target(Address(0x0c01_0000), 1, false),
            None
        );
    }

    fn disk_register_snapshot(sys: &System) -> [u64; 11] {
        [
            u64::from(sys.disk.status.to_bits()),
            u64::from(sys.disk.cover.to_bits()),
            u64::from(sys.disk.command_buffer[0]),
            u64::from(sys.disk.command_buffer[1]),
            u64::from(sys.disk.command_buffer[2]),
            u64::from(sys.disk.dma_base.value()),
            u64::from(sys.disk.dma_length),
            u64::from(sys.disk.control.to_bits()),
            u64::from(sys.disk.immediate),
            u64::from(sys.disk.config),
            sys.disk.resident_deadlines().completion.unwrap_or(0),
        ]
    }

    fn is_resident_backing_rejection<T>(result: &Result<T, ResidentDataAccessError>) -> bool {
        matches!(
            result,
            Err(ResidentDataAccessError::Access(DataAccessFault::Backing {
                write: true,
                ..
            }))
        )
    }

    #[test]
    fn resident_disk_registers_accept_only_browser_authenticated_word_shapes() {
        let mut sys = test_system();
        sys.disk.status = di::Status::from_bits(0x54);
        sys.disk.cover = di::Cover::from_bits(0x07);
        sys.disk.command_buffer = [0x1122_3344, 0x5566_7788, 0x99aa_bbcc];
        sys.disk.dma_base = Address(0x1234_5600);
        sys.disk.dma_length = 0x1020;
        sys.disk.control = di::Control::from_bits(0x06);
        sys.disk.immediate = 0xdead_beef;
        sys.disk.config = 0xa5a5_5a5a;
        let before = disk_register_snapshot(&sys);

        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6000), 0xff_u8, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6000), 0xffff_u16, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6008), 0xffff_u16, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6009), 0xffff_ffff_u32, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(
                Address(0x0c00_6008),
                0xffff_ffff_ffff_ffff_u64,
                0,
            )
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6004), 0_u8, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6004), 0_u16, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6003), 0_u16, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6005), 0_u32, 0)
        ));
        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_6024), 0_u32, 0)
        ));
        assert_eq!(disk_register_snapshot(&sys), before);

        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6000), 0x3a_u32, 0),
            Ok(DataAccessTarget::Mmio)
        );
        // Exact status retains uncleared source bits, applies W1C to transfer, and replaces masks.
        assert_eq!(sys.disk.status.to_bits(), 0x6e);
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6020), 0x1020_3040_u32, 0),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.disk.immediate, 0x1020_3040);

        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6004), 0x06_u32, 0),
            Ok(DataAccessTarget::Mmio)
        );
        // Exact cover writes replace the mask, acknowledge the W1C source, and cannot open the
        // resident drive lid.
        assert!(!sys.disk.cover.open());
        assert!(sys.disk.cover.interrupt_mask());
        assert!(!sys.disk.cover.interrupt());
        assert_eq!(sys.disk.cover.to_bits(), 0x02);
    }

    #[test]
    fn resident_disk_busy_rewrites_are_authenticated_noops() {
        let mut sys = test_system();
        sys.disk.configure_resident_disc(Some(0x10_0000)).unwrap();
        for (address, value) in [
            (0x0c00_6008_u32, 0xa800_0000_u32),
            (0x0c00_600c, 0x100),
            (0x0c00_6010, 0x200),
            (0x0c00_6014, 0x800),
            (0x0c00_6018, 0x200),
            (0x0c00_601c, 3),
        ] {
            assert_eq!(
                sys.write_slow_result_classified_at(Address(address), value, 100),
                Ok(DataAccessTarget::Mmio)
            );
        }
        let request = sys.disk.resident_read_request().unwrap();
        let deadline = sys.disk.resident_deadlines().completion.unwrap();
        let before = disk_register_snapshot(&sys);

        for (address, value) in [
            (0x0c00_6008_u32, 0x1200_0000_u32),
            (0x0c00_600c, 0x200),
            (0x0c00_6010, 0x20),
            (0x0c00_6014, 0x1000),
            (0x0c00_6018, 0x20),
            (0x0c00_601c, 0),
            (0x0c00_6020, 0xcafe_babe),
        ] {
            assert_eq!(
                sys.write_slow_result_classified_at(Address(address), value, 100),
                Ok(DataAccessTarget::Mmio)
            );
        }
        assert_eq!(disk_register_snapshot(&sys), before);
        assert_eq!(sys.disk.resident_read_request(), Some(request));
        assert_eq!(sys.disk.resident_deadlines().completion, Some(deadline));
    }

    #[test]
    fn resident_disk_invalid_starts_restore_control_without_machine_fault() {
        let mut sys = test_system();
        sys.disk.configure_resident_disc(Some(0x10_0000)).unwrap();
        for (address, value) in [
            (0x0c00_6008_u32, 0xa800_0000_u32),
            (0x0c00_600c, 0x100),
            (0x0c00_6010, 0x200),
            (0x0c00_6014, 0x800),
            (0x0c00_6018, 0x200),
        ] {
            assert_eq!(
                sys.write_slow_result_classified_at(Address(address), value, 200),
                Ok(DataAccessTarget::Mmio)
            );
        }

        // DMA read without the DMA bit is a guest-programming rejection: TSTART is restored and
        // no deadline, request, status, DMA advance, or machine-policy error is published.
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_601c), 1_u32, 200),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.disk.control.to_bits(), 0);
        assert!(sys.disk.resident_read_request().is_none());
        assert_eq!(sys.disk.resident_deadlines().completion, None);
        assert_eq!(sys.disk.status.to_bits(), 0);
        assert_eq!(sys.disk.dma_base, Address(0x800));
        assert_eq!(sys.disk.dma_length, 0x200);

        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6014), RAM_LEN as u32 - 0x20, 200,),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6018), 0x40_u32, 200),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6010), 0x40_u32, 200),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_601c), 3_u32, 200),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.disk.control.to_bits(), 0);
        assert!(sys.disk.resident_read_request().is_none());
        assert_eq!(sys.disk.resident_deadlines().completion, None);
        assert_eq!(sys.disk.status.to_bits(), 0);
        assert_eq!(sys.disk.dma_base, Address(RAM_LEN as u32 - 0x20));
        assert_eq!(sys.disk.dma_length, 0x40);
    }

    #[test]
    fn resident_guest_dvd_reset_epoch_exhaustion_is_a_typed_mmio_fault() {
        let mut sys = test_system();
        sys.disk.command_buffer[0] = 0xa800_0000;
        sys.disk.set_resident_epoch_for_test(u64::MAX);

        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_3024), 1_u32 << 2, 100,),
            Err(ResidentDataAccessError::Mmio(ResidentMmioError::Disk(
                ResidentDiskMmioError::Reset(di::ResidentResetError::EpochExhausted)
            )))
        );
        assert_eq!(sys.disk.command_buffer[0], 0xa800_0000);
        assert_eq!(sys.disk.resident_reset_generation().value(), 0);
        assert!(!sys.disk.resident_reset_pending());
    }

    #[test]
    fn resident_dsp_receive_mailbox_write_rejects_before_service_without_panicking() {
        let mut sys = test_system();
        sys.dsp.dsp_mailbox = dspi::Mailbox::from_bits(0x9234_5678);
        let scheduler_len = sys.scheduler.len();

        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_5004), 0xdead_beef_u32, 100,)
        ));
        assert_eq!(sys.dsp.dsp_mailbox.to_bits(), 0x9234_5678);
        assert_eq!(sys.dsp.lle.last_service_cycle(), 0);
        assert_eq!(sys.scheduler.len(), scheduler_len);
    }

    #[test]
    fn resident_ai_partial_mmio_writes_keep_phase_w1c_and_target_lanes_in_rust() {
        let mut sys = test_system();
        sys.audio.control = ai::Control::from_bits(0x0000_005f);
        sys.audio.sample_counter = 0x1122_3344;
        sys.audio.interrupt_sample = 0x5566_7788;
        let scheduler_len = sys.scheduler.len();

        // An uncovered high-half control write cannot acknowledge low-byte AIINT.
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6c00), 0_u16, 10),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.audio.control.to_bits(), 0x0000_005f);

        // The low byte has lane-local W1C and control semantics, including a PLAY reanchor.
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6c03), 0x08_u8, 11),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.audio.control.to_bits(), 0);
        assert_eq!(sys.audio.resident_ai.last_sample_cycle_floor(), 11);

        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6c08), 0xaabb_u16, 12),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.audio.sample_counter, 0xaabb_3344);
        assert_eq!(sys.audio.resident_ai.last_sample_cycle_floor(), 12);
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6c0f), 0xaa_u8, 13),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.audio.interrupt_sample, 0x5566_77aa);
        assert_eq!(sys.audio.resident_ai.last_sample_cycle_floor(), 12);

        sys.audio.sample_counter = 9;
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_6c03), 0x21_u8, 14),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.audio.control.to_bits(), 1);
        assert_eq!(sys.audio.sample_counter, 0);
        assert_eq!(sys.audio.resident_ai.last_sample_cycle_floor(), 14);
        assert_eq!(sys.scheduler.len(), scheduler_len);
    }

    #[test]
    fn resident_ai_play_and_rate_edges_author_dtk_pause_resume_and_batch_width() {
        let mut sys = test_system();

        // Enable the DI audio buffer, retire that immediate command, then begin one DTK stream
        // while AI is still at its reset state (stopped, effective 32,029 Hz).
        let config = {
            let System { disk, mem, cpu, .. } = &mut sys;
            disk.write_resident_command_word(0, 0xe401_000a).unwrap();
            disk.write_resident_control(1, 0, mem.ram_mut(), &mut cpu.reservation)
                .unwrap()
                .unwrap()
        };
        {
            let System { disk, mem, cpu, .. } = &mut sys;
            disk.service_resident(config.completion_cycle, mem.ram_mut(), &mut cpu.reservation);
        }
        const STREAM_CYCLE: u64 = 200_000;
        {
            let System { disk, mem, cpu, .. } = &mut sys;
            disk.write_resident_command_word(0, 0xe100_0000).unwrap();
            disk.write_resident_command_word(1, 0x100).unwrap();
            disk.write_resident_command_word(2, 0x1000).unwrap();
            disk.write_resident_control(1, STREAM_CYCLE, mem.ram_mut(), &mut cpu.reservation)
                .unwrap()
                .unwrap();
        }
        assert_eq!(sys.disk.resident_deadlines().audio, None);

        // AISFR=1 means an effective 48,043 Hz auxiliary rate. Starting AI reanchors the first
        // DTK batch at the accepted write cycle and advances six 32-byte blocks.
        assert_eq!(
            sys.write_slow_result_classified_at(
                Address(0x0c00_6c00),
                0x0000_0003_u32,
                STREAM_CYCLE,
            ),
            Ok(DataAccessTarget::Mmio)
        );
        let first_batch = STREAM_CYCLE + di::AUDIO_BATCH_CYCLES;
        assert_eq!(sys.disk.resident_deadlines().audio, Some(first_batch));
        let first = {
            let System { disk, mem, cpu, .. } = &mut sys;
            disk.service_resident(first_batch, mem.ram_mut(), &mut cpu.reservation)
        };
        assert_eq!(
            first.audio,
            di::ResidentAudioService {
                batches: 1,
                blocks: 6
            }
        );

        // Pausing AI cancels DTK immediately; time passing cannot move its hardware position.
        let pause_cycle = first_batch + 100;
        assert_eq!(
            sys.write_slow_result_classified_at(
                Address(0x0c00_6c00),
                0x0000_0002_u32,
                pause_cycle,
            ),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.disk.resident_deadlines().audio, None);
        let paused = {
            let System { disk, mem, cpu, .. } = &mut sys;
            disk.service_resident(
                pause_cycle + di::AUDIO_BATCH_CYCLES * 2,
                mem.ram_mut(),
                &mut cpu.reservation,
            )
        };
        assert_eq!(paused.audio, di::ResidentAudioService::default());

        // Resume first authors a fresh 48 kHz phase. A subsequent effective-32 kHz edge replaces
        // it with a fresh phase of the same duration, and the next batch advances four blocks.
        let resume_cycle = pause_cycle + di::AUDIO_BATCH_CYCLES * 2 + 100;
        assert_eq!(
            sys.write_slow_result_classified_at(
                Address(0x0c00_6c00),
                0x0000_0003_u32,
                resume_cycle,
            ),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(
            sys.disk.resident_deadlines().audio,
            Some(resume_cycle + di::AUDIO_BATCH_CYCLES)
        );
        let rate_change_cycle = resume_cycle + 100;
        assert_eq!(
            sys.write_slow_result_classified_at(
                Address(0x0c00_6c00),
                0x0000_0001_u32,
                rate_change_cycle,
            ),
            Ok(DataAccessTarget::Mmio)
        );
        let second_batch = rate_change_cycle + di::AUDIO_BATCH_CYCLES;
        assert_eq!(sys.disk.resident_deadlines().audio, Some(second_batch));

        // Rewriting the same authoritative state does not perturb the authored DTK phase.
        assert_eq!(
            sys.write_slow_result_classified_at(
                Address(0x0c00_6c00),
                0x0000_0001_u32,
                rate_change_cycle + 1,
            ),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.disk.resident_deadlines().audio, Some(second_batch));
        let second = {
            let System { disk, mem, cpu, .. } = &mut sys;
            disk.service_resident(second_batch, mem.ram_mut(), &mut cpu.reservation)
        };
        assert_eq!(
            second.audio,
            di::ResidentAudioService {
                batches: 1,
                blocks: 4
            }
        );
    }

    #[test]
    fn resident_aid_word_and_halfword_mmio_use_exact_deadlines_without_callbacks() {
        let mut sys = test_system();
        let scheduler_len = sys.scheduler.len();

        assert!(is_resident_backing_rejection(
            &sys.write_slow_result_classified_at(Address(0x0c00_5036), 0x80_u8, 99)
        ));
        assert_eq!(sys.dsp.lle.last_service_cycle(), 0);
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_5034), 0xdead_8003_u32, 100,),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.audio.dma_control.to_bits(), 0x8003);
        assert_eq!(sys.audio.resident_dsp_audio_dma.starts(), 1);
        assert_eq!(
            sys.audio.resident_dsp_audio_dma.next_interrupt_cycle(),
            Some(300)
        );
        assert_eq!(
            sys.audio.resident_dsp_audio_dma.next_block_cycle(),
            Some(100 + ai::SampleRate::KHz48.cycles_per_block())
        );
        assert_eq!(
            sys.read_slow_result_classified_at::<u16>(Address(0x0c00_503a), 100),
            Ok((2, DataAccessTarget::Mmio))
        );
        assert_eq!(
            sys.read_slow_result_classified_at::<u32>(Address(0x0c00_5034), 100),
            Ok((0x0000_8003, DataAccessTarget::Mmio))
        );

        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_5036), 0_u16, 101),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.audio.resident_dsp_audio_dma.stops(), 1);
        assert_eq!(
            sys.audio.resident_dsp_audio_dma.next_interrupt_cycle(),
            None
        );
        assert_eq!(sys.audio.resident_dsp_audio_dma.next_block_cycle(), None);
        assert_eq!(sys.scheduler.len(), scheduler_len);
    }

    #[test]
    fn resident_aram_dma_halfword_programming_triggers_low_lane_and_w1c_completes() {
        let mut sys = test_system();
        for (index, byte) in sys.mem.ram_mut()[0x20..0x60].iter_mut().enumerate() {
            *byte = index as u8;
        }
        let scheduler_len = sys.scheduler.len();

        for (address, value) in [
            (0x0c00_5020, 0_u16),
            (0x0c00_5022, 0x20),
            (0x0c00_5024, 0),
            (0x0c00_5026, 0x40),
            (0x0c00_5028, 0),
        ] {
            assert_eq!(
                sys.write_slow_result_classified_at(Address(address), value, 100),
                Ok(DataAccessTarget::Mmio)
            );
        }
        assert_eq!(sys.dsp.aram_dma.starts(), 0);
        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_502a), 0x40_u16, 100),
            Ok(DataAccessTarget::Mmio)
        );
        assert_eq!(sys.dsp.aram_dma.starts(), 1);
        assert_eq!(sys.dsp.aram_dma.completion_cycle(), Some(592));
        assert_eq!(sys.dsp.aram_dma.ram_base, Address(0x60));
        assert_eq!(sys.dsp.aram_dma.aram_base, 0x80);
        assert_eq!(&sys.dsp.aram[0x40..0x80], &sys.mem.ram()[0x20..0x60]);
        assert!(sys.dsp.control.aram_dma_ongoing());
        assert_eq!(sys.scheduler.len(), scheduler_len);

        assert_eq!(
            sys.read_slow_result_classified_at::<u16>(Address(0x0c00_500a), 592),
            Ok((0x0820, DataAccessTarget::Mmio))
        );
        assert!(!sys.dsp.control.aram_dma_ongoing());
        assert!(sys.dsp.control.aram_dma_interrupt());
        assert_eq!(sys.dsp.aram_dma.completions(), 1);

        assert_eq!(
            sys.write_slow_result_classified_at(Address(0x0c00_500b), 0x20_u8, 593),
            Ok(DataAccessTarget::Mmio)
        );
        assert!(!sys.dsp.control.aram_dma_interrupt());
        assert_eq!(sys.scheduler.len(), scheduler_len);
    }

    #[test]
    fn exact_serial_input_register_read_consumes_the_one_entry_mailbox() {
        let mut sys = test_system();
        sys.serial.channel_input[0].high = 0x0080_8080;
        let mut channel = sys.serial.status.channel(0);
        channel.set_input_ready(true);
        sys.serial.status.set_channel(0, channel);
        sys.serial.comm_control.set_read_interrupt(true);
        sys.serial.comm_control.set_read_interrupt_mask(true);

        // A partial access is not the browser-authenticated consume operation.
        assert_eq!(sys.read_phys_slow::<u16>(Address(0x0c00_6404)), 0x0080);
        assert!(sys.serial.status.channel(0).input_ready());
        assert!(sys.serial.comm_control.read_interrupt());

        assert_eq!(sys.read_phys_slow::<u32>(Address(0x0c00_6404)), 0x0080_8080);
        assert!(!sys.serial.status.channel(0).input_ready());
        assert!(!sys.serial.comm_control.read_interrupt());
    }
}
