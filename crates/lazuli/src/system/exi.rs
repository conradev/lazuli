//! External interface (EXI).

use bitos::bitos;
use bitos::integer::{u2, u3};
use gekko::Address;

use crate::Primitive;
use crate::system::{System, mem, pi};

pub const SRAM_LEN: usize = 64;
pub const DMA_REGISTER_MASK: u32 = 0x03ff_ffe0;
pub const CONTROL_REGISTER_MASK: u32 = 0x0000_003f;
pub const RTC_CYCLES_PER_SECOND: u64 = 486_000_000;

const IPL_RTC_BASE: u32 = 0x0080_0000;
const IPL_SRAM_BASE: u32 = IPL_RTC_BASE + 4;
const IPL_SRAM_END: u32 = IPL_SRAM_BASE + SRAM_LEN as u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device0 {
    MemoryCardA,
    IplRtcSram,
    SerialPort1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device1 {
    MemoryCardB,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device2 {
    AD16,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Parameter {
    #[bits(0)]
    pub device_interrupt_mask: bool,
    #[bits(1)]
    pub device_interrupt: bool,
    #[bits(2)]
    pub transfer_interrupt_mask: bool,
    #[bits(3)]
    pub transfer_interrupt: bool,
    #[bits(4..7)]
    pub clock_multiplier: u3,
    #[bits(7..10)]
    pub device_select: u3,
    #[bits(10)]
    pub attach_interrupt_mask: bool,
    #[bits(11)]
    pub attach_interrupt: bool,
    #[bits(12)]
    pub device_connected: bool,
    #[bits(13)]
    pub rom_disable: bool,
}

impl Parameter {
    /// Applies a complete channel-zero CSR write.
    ///
    /// MMIO uses [`write_parameter_masked`] so partial writes acknowledge only status lanes the
    /// guest actually wrote.
    pub fn write(&mut self, value: Parameter) {
        self.write_masked(value, u32::MAX, 0);
    }

    fn write_masked(&mut self, value: Parameter, written_mask: u32, channel: usize) {
        const DEVICE_STATUS: u32 = 1 << 1;
        const TRANSFER_STATUS: u32 = 1 << 3;
        const ATTACH_STATUS: u32 = 1 << 11;
        const DEVICE_CONNECTED: u32 = 1 << 12;
        const ROM_DISABLE: u32 = 1 << 13;
        const DEVICE_MASK: u32 = 1;
        const TRANSFER_MASK: u32 = 1 << 2;
        const CLOCK_MASK: u32 = 0x70;
        const SELECT_MASK: u32 = 0x380;
        const ATTACH_MASK: u32 = 1 << 10;

        let current = self.to_bits();
        let written = value.to_bits();
        let status_mask =
            DEVICE_STATUS | TRANSFER_STATUS | if channel < 2 { ATTACH_STATUS } else { 0 };
        let writable_mask = DEVICE_MASK
            | TRANSFER_MASK
            | CLOCK_MASK
            | SELECT_MASK
            | if channel < 2 { ATTACH_MASK } else { 0 }
            | if channel == 0 { ROM_DISABLE } else { 0 };
        let statuses = (current & status_mask) & !(written & written_mask & status_mask);
        let retained_configuration = current & writable_mask & !written_mask;
        let written_configuration = written & writable_mask & written_mask;
        let read_only = if channel < 2 {
            current & DEVICE_CONNECTED
        } else {
            0
        };

        *self =
            Self::from_bits(statuses | retained_configuration | written_configuration | read_only);
    }

    pub fn device0(&self) -> Option<Device0> {
        Some(match self.device_select().value() {
            0b001 => Device0::MemoryCardA,
            0b010 => Device0::IplRtcSram,
            0b100 => Device0::SerialPort1,
            _ => return None,
        })
    }

    pub fn device1(&self) -> Option<Device1> {
        Some(match self.device_select().value() {
            0b001 => Device1::MemoryCardB,
            _ => return None,
        })
    }

    pub fn device2(&self) -> Option<Device2> {
        Some(match self.device_select().value() {
            0b001 => Device2::AD16,
            _ => return None,
        })
    }

    fn interrupt_active(self, include_attach: bool) -> bool {
        (self.device_interrupt_mask() && self.device_interrupt())
            || (self.transfer_interrupt_mask() && self.transfer_interrupt())
            || (include_attach && self.attach_interrupt_mask() && self.attach_interrupt())
    }
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferMode {
    Read      = 0b00,
    Write     = 0b01,
    ReadWrite = 0b10,
    Reserved  = 0b11,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Control {
    #[bits(0)]
    pub transfer_ongoing: bool,
    #[bits(1)]
    pub dma: bool,
    #[bits(2..4)]
    pub transfer_mode: TransferMode,
    #[bits(4..6)]
    pub imm_length_minus_one: u2,
}

impl Control {
    pub fn imm_length(&self) -> u32 {
        self.imm_length_minus_one().value() as u32 + 1
    }
}

#[derive(Debug, Clone, Default)]
pub enum IplChipState {
    #[default]
    Idle,
    SramWrite(u8),
    UartWrite,
}

#[derive(Debug, Clone, Default)]
pub struct Channel0 {
    /// RTC snapshot in seconds since the GameCube epoch.
    pub rtc: u32,
    /// Compatibility mirror of the current decoded IPL cursor.
    pub ipl_base: u32,
    pub ipl_state: IplChipState,
    pub ipl_command_word: u32,
    pub ipl_command_bytes: u8,
    pub ipl_command_write: Option<bool>,
    pub ipl_command_address: u32,
    pub ipl_cursor: u32,

    pub parameter: Parameter,
    pub control: Control,
    pub dma_base: Address,
    pub dma_length: u32,
    pub immediate: u32,
}

impl Channel0 {
    fn reset_ipl_framing(&mut self) {
        self.ipl_base = 0;
        self.ipl_state = IplChipState::Idle;
        self.ipl_command_word = 0;
        self.ipl_command_bytes = 0;
        self.ipl_command_write = None;
        self.ipl_command_address = 0;
        self.ipl_cursor = 0;
    }

    fn latch_ipl_command_byte(&mut self, byte: u8, observed_cycle: u64) {
        if self.ipl_command_bytes >= 4 {
            return;
        }
        self.ipl_command_word = (self.ipl_command_word << 8) | u32::from(byte);
        self.ipl_command_bytes += 1;
        if self.ipl_command_bytes == 4 {
            self.ipl_command_write = Some(self.ipl_command_word & 0x8000_0000 != 0);
            self.ipl_command_address = (self.ipl_command_word >> 6) & 0x01ff_ffff;
            self.ipl_cursor = self.ipl_command_address;
            self.ipl_base = self.ipl_cursor;
            // Previous browser fidelity starts from the GameCube epoch and derives RTC solely
            // from canonical emulated core cycles. The value freezes at this fourth byte.
            self.rtc = (observed_cycle / RTC_CYCLES_PER_SECOND) as u32;
        }
    }

    fn advance_ipl_cursor(&mut self) {
        self.ipl_cursor = self.ipl_cursor.wrapping_add(1);
        self.ipl_base = self.ipl_cursor;
    }
}

#[derive(Default, Debug, Clone)]
pub struct Channel1 {
    pub parameter: Parameter,
    pub control: Control,
    pub dma_base: Address,
    pub dma_length: u32,
    pub immediate: u32,
}

#[derive(Default, Debug, Clone)]
pub struct Channel2 {
    pub parameter: Parameter,
    pub control: Control,
    pub dma_base: Address,
    pub dma_length: u32,
    pub immediate: u32,
}

pub struct Interface {
    /// Sixty-four settings bytes. The four-byte RTC immediately precedes these on the EXI wire.
    pub sram: Box<[u8; SRAM_LEN]>,
    pub channel0: Channel0,
    // These deliberately retain the original common channel shape. Public register fields remain
    // stable while channel-specific transfer behavior is selected by the service function.
    pub channel1: Channel0,
    pub channel2: Channel0,
}

impl Interface {
    pub fn new() -> Self {
        Self {
            sram: Box::new(default_sram()),
            channel0: Default::default(),
            channel1: Default::default(),
            channel2: Default::default(),
        }
    }

    /// Returns the level presented to PI by every modeled EXI source.
    pub fn interrupt_active(&self) -> bool {
        self.channel0.parameter.interrupt_active(true)
            || self.channel1.parameter.interrupt_active(true)
            || self.channel2.parameter.interrupt_active(false)
    }
}

impl Default for Interface {
    fn default() -> Self {
        Self::new()
    }
}

fn update_sram_checksum(sram: &mut [u8; SRAM_LEN]) {
    let mut checksum = 0_u16;
    let mut checksum_inverse = 0_u16;
    // The checksum spans rtc_bias through flags: four big-endian words at settings offsets
    // 0x0c..0x13 (aggregate RTC+SRAM offsets 0x10..0x17).
    for offset in (0x0c..0x14).step_by(2) {
        let word = u16::read_be_bytes(&sram[offset..]);
        checksum = checksum.wrapping_add(word);
        checksum_inverse = checksum_inverse.wrapping_add(word ^ u16::MAX);
    }
    checksum.write_be_bytes(&mut sram[0..2]);
    checksum_inverse.write_be_bytes(&mut sram[2..4]);
}

fn default_sram() -> [u8; SRAM_LEN] {
    let mut sram = [0; SRAM_LEN];
    // Dolphin's deterministic public template, matching the prior browser implementation:
    // English, stereo, initial setup complete, and stable placeholder card identifiers.
    sram[0x13] = 0x2c;
    sram[0x14..0x20].copy_from_slice(b"DOLPHINSLOTA");
    sram[0x20..0x2c].copy_from_slice(b"DOLPHINSLOTB");
    sram[0x3a] = 0x6e;
    sram[0x3b] = 0x6d;
    update_sram_checksum(&mut sram);
    sram
}

fn channel_mut(external: &mut Interface, channel: usize) -> Option<&mut Channel0> {
    match channel {
        0 => Some(&mut external.channel0),
        1 => Some(&mut external.channel1),
        2 => Some(&mut external.channel2),
        _ => None,
    }
}

fn schedule_interrupt_sample(sys: &mut System) {
    if !sys.scheduler.contains(pi::check_interrupts) {
        sys.scheduler.schedule_now(pi::check_interrupts);
    }
}

/// Applies one lane-masked CSR write, including status W1C and the IPL chip-select framing edge.
pub fn write_parameter_masked(
    sys: &mut System,
    channel_index: usize,
    written: Parameter,
    written_mask: u32,
) {
    let Some(channel) = channel_mut(&mut sys.external, channel_index) else {
        return;
    };
    let previous_select = channel.parameter.device_select().value();
    channel
        .parameter
        .write_masked(written, written_mask, channel_index);
    let next_select = channel.parameter.device_select().value();

    if channel_index == 0
        && previous_select != next_select
        && previous_select ^ next_select == 0b010
        && next_select != 0
    {
        channel.reset_ipl_framing();
    }
    schedule_interrupt_sample(sys);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IplReadRegion {
    Rom,
    Rtc,
    Sram,
}

fn ipl_read_region(address: u32) -> Option<IplReadRegion> {
    if address < mem::IPL_LEN as u32 {
        Some(IplReadRegion::Rom)
    } else if (IPL_RTC_BASE..IPL_SRAM_BASE).contains(&address) {
        Some(IplReadRegion::Rtc)
    } else if (IPL_SRAM_BASE..IPL_SRAM_END).contains(&address) {
        Some(IplReadRegion::Sram)
    } else {
        None
    }
}

fn immediate_read_out_of_bounds(channel: &Channel0, length: u32) -> bool {
    if channel.ipl_command_bytes < 4 || channel.ipl_command_write != Some(false) {
        return false;
    }
    let Some(end) = channel.ipl_cursor.checked_add(length) else {
        return true;
    };
    match ipl_read_region(channel.ipl_command_address) {
        Some(IplReadRegion::Rtc) => channel.ipl_cursor < IPL_RTC_BASE || end > IPL_SRAM_BASE,
        Some(IplReadRegion::Sram) => channel.ipl_cursor < IPL_SRAM_BASE || end > IPL_SRAM_END,
        _ => false,
    }
}

fn transfer_ipl_byte(sys: &mut System, input: u8, observed_cycle: u64) -> u8 {
    if sys.external.channel0.ipl_command_bytes < 4 {
        sys.external
            .channel0
            .latch_ipl_command_byte(input, observed_cycle);
        // IPL drives all ones while the four command bytes are clocked.
        return 0xff;
    }
    if sys.external.channel0.ipl_command_write != Some(false) {
        return input;
    }

    match ipl_read_region(sys.external.channel0.ipl_command_address) {
        Some(IplReadRegion::Rom) => {
            let source = sys.external.channel0.ipl_cursor as usize % mem::IPL_LEN;
            let output = sys.mem.ipl()[source];
            sys.external.channel0.advance_ipl_cursor();
            output
        }
        Some(IplReadRegion::Rtc)
            if (IPL_RTC_BASE..IPL_SRAM_BASE).contains(&sys.external.channel0.ipl_cursor) =>
        {
            let source = (sys.external.channel0.ipl_cursor - IPL_RTC_BASE) as usize;
            let output = sys.external.channel0.rtc.to_be_bytes()[source];
            sys.external.channel0.advance_ipl_cursor();
            output
        }
        Some(IplReadRegion::Sram)
            if (IPL_SRAM_BASE..IPL_SRAM_END).contains(&sys.external.channel0.ipl_cursor) =>
        {
            let source = (sys.external.channel0.ipl_cursor - IPL_SRAM_BASE) as usize;
            let output = sys.external.sram[source];
            sys.external.channel0.advance_ipl_cursor();
            output
        }
        // Unhandled addresses and writes leave the byte on the wire untouched.
        _ => input,
    }
}

fn transfer_ipl_immediate(sys: &mut System, observed_cycle: u64) {
    let mode = sys.external.channel0.control.transfer_mode();
    let length = sys.external.channel0.control.imm_length();
    let immediate_before = sys.external.channel0.immediate;

    match mode {
        TransferMode::Read => {
            if immediate_read_out_of_bounds(&sys.external.channel0, length) {
                return;
            }
            let mut immediate_after = 0_u32;
            for index in 0..length {
                let output = transfer_ipl_byte(sys, 0, observed_cycle);
                immediate_after |= u32::from(output) << (24 - index * 8);
            }
            sys.external.channel0.immediate = immediate_after;
        }
        TransferMode::Write => {
            for index in 0..length {
                let byte = (immediate_before >> (24 - index * 8)) as u8;
                let _ = transfer_ipl_byte(sys, byte, observed_cycle);
            }
        }
        // Dolphin's IPL device does not override immediate read-write. Reserved is rejected by
        // the device model. Both still complete at the common EXI boundary below.
        TransferMode::ReadWrite | TransferMode::Reserved => {}
    }
}

fn transfer_ipl_dma(sys: &mut System) {
    let channel = &sys.external.channel0;
    if channel.control.transfer_mode() != TransferMode::Read
        || channel.ipl_command_bytes != 4
        || channel.ipl_command_write != Some(false)
    {
        return;
    }

    let length = channel.dma_length as usize;
    if length == 0 {
        return;
    }
    let target = channel.dma_base.value() as usize;
    let Some(target_end) = target.checked_add(length) else {
        return;
    };
    if target_end > sys.mem.ram().len() {
        return;
    }

    let cursor = channel.ipl_cursor;
    let Some(source_end) = cursor.checked_add(channel.dma_length) else {
        return;
    };
    match ipl_read_region(channel.ipl_command_address) {
        Some(IplReadRegion::Rom) if source_end <= mem::IPL_LEN as u32 => {
            let source = cursor as usize;
            let regions = sys.mem.regions();
            regions.ram[target..target_end].copy_from_slice(&regions.ipl[source..source + length]);
        }
        Some(IplReadRegion::Sram) if cursor >= IPL_SRAM_BASE && source_end <= IPL_SRAM_END => {
            let source = (cursor - IPL_SRAM_BASE) as usize;
            let payload = &sys.external.sram[source..source + length];
            sys.mem.ram_mut()[target..target_end].copy_from_slice(payload);
        }
        // RTC is immediate-only. Invalid or unsupported source ranges fail closed.
        _ => return,
    }

    sys.external.channel0.ipl_cursor = source_end;
    sys.external.channel0.ipl_base = source_end;
    sys.cpu
        .reservation
        .invalidate_range(Address(target as u32), length);
}

fn service_channel0(sys: &mut System, observed_cycle: u64) {
    let selected = sys.external.channel0.parameter.device_select().value();
    // Only the one-hot IPL selection is modeled. Missing, multiple, memory-card, and serial-port
    // selections intentionally perform no payload mutation but share hardware completion below.
    if selected == 0b010 {
        if sys.external.channel0.control.dma() {
            transfer_ipl_dma(sys);
        } else {
            transfer_ipl_immediate(sys, observed_cycle);
        }
    }
}

fn complete_channel(channel: &mut Channel0) -> bool {
    if !channel.control.transfer_ongoing() {
        return false;
    }
    channel.control.set_transfer_ongoing(false);
    channel.parameter.set_transfer_interrupt(true);
    true
}

/// Services every started EXI transfer and retires each one through the shared completion path.
///
/// Guest-controlled device selectors, modes, addresses, and lengths cannot panic this function.
/// Unsupported or malformed operations leave payload/register state untouched except for the
/// architected TSTART-clear and sticky TCINT completion.
pub fn update_at(sys: &mut System, observed_cycle: u64) {
    let mut completed = false;
    if sys.external.channel0.control.transfer_ongoing() {
        service_channel0(sys, observed_cycle);
        completed |= complete_channel(&mut sys.external.channel0);
    }
    completed |= complete_channel(&mut sys.external.channel1);
    completed |= complete_channel(&mut sys.external.channel2);
    if completed {
        schedule_interrupt_sample(sys);
    }
}

/// Native scheduler-time counterpart retained for existing non-resident callers.
pub fn update(sys: &mut System) {
    let observed_cycle = sys.scheduler.elapsed();
    update_at(sys, observed_cycle);
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use sha2::{Digest, Sha256};

    use super::*;
    use crate::modules::audio::NopAudioModule;
    use crate::modules::debug::NopDebugModule;
    use crate::modules::disk::NopDiskModule;
    use crate::modules::input::NopInputModule;
    use crate::modules::render::NopRenderModule;
    use crate::modules::vertex::NopVertexModule;
    use crate::system::{Config, Modules};

    fn system() -> System {
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
                ipl_lle: true,
                ipl: None,
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    fn select(sys: &mut System, value: u32) {
        write_parameter_masked(sys, 0, Parameter::from_bits(value << 7), u32::MAX);
    }

    fn transfer(sys: &mut System, value: u32, length: u32, mode: TransferMode, cycle: u64) {
        sys.external.channel0.immediate = value;
        sys.external.channel0.control =
            Control::from_bits(1 | (mode as u32) << 2 | (length.saturating_sub(1) & 3) << 4);
        update_at(sys, cycle);
    }

    fn write_ipl_command(sys: &mut System, command: u32, cycle: u64) {
        transfer(sys, command, 4, TransferMode::Write, cycle);
    }

    #[test]
    fn deterministic_sram_template_is_exact_and_checksum_valid() {
        let sys = system();
        let expected: [u8; SRAM_LEN] = [
            0x00, 0x2c, 0xff, 0xd0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x44, 0x4f, 0x4c, 0x50, 0x48, 0x49, 0x4e, 0x53,
            0x4c, 0x4f, 0x54, 0x41, 0x44, 0x4f, 0x4c, 0x50, 0x48, 0x49, 0x4e, 0x53, 0x4c, 0x4f,
            0x54, 0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x6e, 0x6d, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(&*sys.external.sram, &expected);
        assert_eq!(
            format!("{:x}", Sha256::digest(sys.external.sram.as_slice())),
            "09e038130b2ccb3767b9000f1e6d465b2aced4907a6c26b1cea5d86207aaf029"
        );

        let mut recomputed = *sys.external.sram;
        update_sram_checksum(&mut recomputed);
        assert_eq!(recomputed, expected);
    }

    #[test]
    fn rtc_snapshots_only_on_the_fourth_command_byte_and_uses_canonical_cycle() {
        let mut sys = system();
        select(&mut sys, 2);

        transfer(
            &mut sys,
            0x2000_0000,
            3,
            TransferMode::Write,
            RTC_CYCLES_PER_SECOND,
        );
        assert_eq!(sys.external.channel0.ipl_command_bytes, 3);
        assert_eq!(sys.external.channel0.rtc, 0);
        transfer(
            &mut sys,
            0,
            1,
            TransferMode::Write,
            RTC_CYCLES_PER_SECOND * 2 + 123,
        );
        assert_eq!(sys.external.channel0.ipl_command_address, IPL_RTC_BASE);
        assert_eq!(sys.external.channel0.rtc, 2);

        transfer(
            &mut sys,
            0xdead_beef,
            4,
            TransferMode::Read,
            RTC_CYCLES_PER_SECOND * 9,
        );
        assert_eq!(sys.external.channel0.immediate, 2);
        assert_eq!(sys.external.channel0.rtc, 2);
        assert_eq!(sys.external.channel0.ipl_cursor, IPL_SRAM_BASE);
    }

    #[test]
    fn write_transfer_clocks_payload_bytes_after_completing_the_command_frame() {
        let mut sys = system();
        select(&mut sys, 2);
        let source = crate::system::ipl::BUNDLED_FONT_WESTERN_OFFSET as u32;
        let command = source << 6;

        // Leave only the low command byte outstanding, then issue four write clocks. The first
        // completes the command and the remaining three clock readable ROM bytes just as the
        // legacy full-duplex transfer did, even though write mode discards their returned values.
        transfer(&mut sys, command, 3, TransferMode::Write, 10);
        assert_eq!(sys.external.channel0.ipl_command_bytes, 3);
        assert_eq!(sys.external.channel0.ipl_cursor, 0);
        let completion_and_payload = (command & 0xff) << 24 | 0x00aa_bbcc;
        transfer(&mut sys, completion_and_payload, 4, TransferMode::Write, 20);

        assert_eq!(sys.external.channel0.ipl_command_bytes, 4);
        assert_eq!(sys.external.channel0.ipl_command_address, source);
        assert_eq!(sys.external.channel0.ipl_cursor, source + 3);
        assert_eq!(sys.external.channel0.immediate, completion_and_payload);
    }

    #[test]
    fn absent_multiple_and_unsupported_devices_always_complete_without_payload_mutation() {
        for selected in [0, 1, 3, 4, 5, 6, 7] {
            let mut sys = system();
            select(&mut sys, selected);
            sys.mem.ram_mut()[0x1000..0x1040].fill(0xa5);
            sys.external.channel0.immediate = 0x89ab_cdef;
            sys.external.channel0.dma_base = Address(0x1000);
            sys.external.channel0.dma_length = 0x40;
            sys.external.channel0.control = Control::from_bits(0x03);

            let result = catch_unwind(AssertUnwindSafe(|| update_at(&mut sys, 123)));
            assert!(result.is_ok(), "selection {selected} panicked");
            assert!(!sys.external.channel0.control.transfer_ongoing());
            assert!(sys.external.channel0.parameter.transfer_interrupt());
            assert_eq!(sys.external.channel0.immediate, 0x89ab_cdef);
            assert_eq!(&sys.mem.ram()[0x1000..0x1040], &[0xa5; 0x40]);
            assert_eq!(sys.external.channel0.ipl_command_bytes, 0);
        }
    }

    #[test]
    fn chip_select_framing_edges_match_the_legacy_xor_callback() {
        // Legacy routes only the changed selector bit to a device callback. IPL therefore resets
        // exactly when bit 1 alone toggles and the complete new selector is nonzero.
        for (previous, next, resets) in [
            (0b000, 0b010, true),
            (0b010, 0b000, false),
            (0b001, 0b011, true),
            (0b011, 0b001, true),
            (0b010, 0b011, false),
            (0b011, 0b010, false),
            (0b010, 0b010, false),
        ] {
            let mut sys = system();
            sys.external
                .channel0
                .parameter
                .set_device_select(u3::new(previous));
            sys.external.channel0.ipl_command_word = 0x1234_5678;
            sys.external.channel0.ipl_command_bytes = 4;
            sys.external.channel0.ipl_command_write = Some(false);
            sys.external.channel0.ipl_command_address = 0x0012_3456;
            sys.external.channel0.ipl_cursor = 0x0012_3460;
            sys.external.channel0.ipl_base = 0x0012_3460;

            let mut parameter = sys.external.channel0.parameter;
            parameter.set_device_select(u3::new(next));
            write_parameter_masked(&mut sys, 0, parameter, u32::MAX);

            assert_eq!(
                sys.external.channel0.ipl_command_bytes,
                if resets { 0 } else { 4 },
                "{previous:03b}->{next:03b}",
            );
            assert_eq!(
                sys.external.channel0.ipl_cursor,
                if resets { 0 } else { 0x0012_3460 },
                "{previous:03b}->{next:03b}",
            );
        }
    }

    #[test]
    fn malformed_dma_vectors_are_atomic_and_panic_free() {
        let mut sys = system();
        select(&mut sys, 2);
        sys.mem.ram_mut()[0x1000..0x1040].fill(0x5a);
        let baseline = sys.mem.ram()[0x1000..0x1040].to_vec();

        let vectors = [
            // No readable address command.
            (
                0_u32,
                false,
                0_u32,
                0x1000_u32,
                0x20_u32,
                TransferMode::Read,
            ),
            // Every non-read DMA mode is rejected before touching a valid target.
            (0, true, 0, 0x1000, 0x20, TransferMode::Write),
            (0, true, 0, 0x1000, 0x20, TransferMode::ReadWrite),
            (0, true, 0, 0x1000, 0x20, TransferMode::Reserved),
            // Zero-byte reads complete without consulting an otherwise invalid RAM target.
            (0, true, 0, u32::MAX, 0, TransferMode::Read),
            // RTC is immediate-only for nonempty DMA.
            (
                IPL_RTC_BASE,
                true,
                IPL_RTC_BASE,
                0x1000,
                4,
                TransferMode::Read,
            ),
            // ROM source out of bounds.
            (
                mem::IPL_LEN as u32 - 0x10,
                true,
                0_u32,
                0x1000,
                0x20,
                TransferMode::Read,
            ),
            // SRAM source out of bounds.
            (
                IPL_SRAM_END - 0x10,
                true,
                IPL_SRAM_BASE,
                0x1000,
                0x20,
                TransferMode::Read,
            ),
            // RAM target out of bounds.
            (
                0,
                true,
                0,
                mem::RAM_LEN as u32 - 0x10,
                0x20,
                TransferMode::Read,
            ),
            // Addition overflow before any indexing.
            (u32::MAX - 0x0f, true, 0, 0x1000, 0x20, TransferMode::Read),
        ];

        for (cursor, command_ready, command_address, target, length, mode) in vectors {
            sys.external.channel0.ipl_command_bytes = if command_ready { 4 } else { 0 };
            sys.external.channel0.ipl_command_write = command_ready.then_some(false);
            sys.external.channel0.ipl_command_address = command_address;
            sys.external.channel0.ipl_cursor = cursor;
            sys.external.channel0.dma_base = Address(target);
            sys.external.channel0.dma_length = length;
            sys.external.channel0.control = Control::from_bits(0x03 | (mode as u32) << 2);
            sys.external
                .channel0
                .parameter
                .set_transfer_interrupt(false);

            let result = catch_unwind(AssertUnwindSafe(|| update_at(&mut sys, 999)));
            assert!(result.is_ok());
            assert!(!sys.external.channel0.control.transfer_ongoing());
            assert!(sys.external.channel0.parameter.transfer_interrupt());
            assert_eq!(sys.external.channel0.ipl_cursor, cursor);
            assert_eq!(&sys.mem.ram()[0x1000..0x1040], baseline);
        }
    }

    #[test]
    fn valid_default_font_dma_copies_exact_bytes_and_advances_once() {
        let mut sys = system();
        select(&mut sys, 2);
        let source = crate::system::ipl::BUNDLED_FONT_WESTERN_OFFSET as u32;
        write_ipl_command(&mut sys, source << 6, 10);
        let expected = sys.mem.ipl()[source as usize..source as usize + 32].to_vec();
        sys.external.channel0.dma_base = Address(0x2000);
        sys.external.channel0.dma_length = 32;
        sys.external.channel0.control = Control::from_bits(0x03);
        update_at(&mut sys, 11);

        assert_eq!(&sys.mem.ram()[0x2000..0x2020], expected);
        assert_eq!(sys.external.channel0.ipl_cursor, source + 32);
        assert!(!sys.external.channel0.control.transfer_ongoing());
        assert!(sys.external.channel0.parameter.transfer_interrupt());
    }

    #[test]
    fn transfer_interrupt_is_sticky_w1c_and_drives_pi_only_while_masked() {
        let mut sys = system();
        let mut parameter = Parameter::from_bits(0);
        parameter.set_transfer_interrupt_mask(true);
        parameter.set_device_select(u3::new(2));
        write_parameter_masked(&mut sys, 0, parameter, u32::MAX);
        write_ipl_command(&mut sys, 0, 10);

        assert!(sys.external.channel0.parameter.transfer_interrupt());
        assert!(sys.external.interrupt_active());
        assert!(pi::get_active_interrupts(&sys).external_interface());
        assert!(!pi::get_raised_interrupts(&sys).external_interface());

        sys.cpu.pc = Address(0x8000_1000);
        sys.cpu.supervisor.config.msr.set_exception_prefix(false);
        sys.cpu.supervisor.config.msr.set_interrupts(true);
        pi::check_interrupts(&mut sys);
        assert_eq!(sys.cpu.pc, Address(0x8000_1000));

        let mut sources = pi::InterruptSources::default();
        sources.set_external_interface(true);
        sys.processor.mask.set_sources(sources);
        assert!(pi::get_raised_interrupts(&sys).external_interface());
        pi::check_interrupts(&mut sys);
        assert_eq!(sys.cpu.pc, Address(0x0000_0500));
        assert_eq!(sys.cpu.supervisor.exception.srr[0], 0x8000_1000);
        assert!(sys.external.channel0.parameter.transfer_interrupt());

        // A live EXI level is not consumed by delivery and therefore re-enters after rfi restores
        // EE (represented here by restoring the architectural gate and interrupted PC).
        sys.cpu.pc = Address(0x8000_2000);
        sys.cpu.supervisor.config.msr.set_interrupts(true);
        pi::check_interrupts(&mut sys);
        assert_eq!(sys.cpu.pc, Address(0x0000_0500));
        assert_eq!(sys.cpu.supervisor.exception.srr[0], 0x8000_2000);

        // PI cause is a sampled level. Its W1C register cannot consume the live EXI source.
        sys.write_phys_slow(Address(0x0c00_3000), 1_u32 << 4);
        assert!(pi::get_active_interrupts(&sys).external_interface());

        let mut acknowledge = sys.external.channel0.parameter;
        acknowledge.set_transfer_interrupt(true);
        write_parameter_masked(&mut sys, 0, acknowledge, u32::MAX);
        assert!(!sys.external.channel0.parameter.transfer_interrupt());
        assert!(!sys.external.interrupt_active());
        assert!(!pi::get_active_interrupts(&sys).external_interface());
    }

    #[test]
    fn all_channels_complete_before_one_aggregate_level_and_clear_independently() {
        let mut sys = system();
        for channel in 0..3 {
            let mut parameter = Parameter::from_bits(0);
            parameter.set_transfer_interrupt_mask(true);
            write_parameter_masked(&mut sys, channel, parameter, u32::MAX);
            let selected = channel_mut(&mut sys.external, channel).unwrap();
            selected.control = Control::from_bits(1);
        }

        update_at(&mut sys, 100);
        for channel in 0..3 {
            let completed = channel_mut(&mut sys.external, channel).unwrap();
            assert!(!completed.control.transfer_ongoing());
            assert!(completed.parameter.transfer_interrupt());
        }
        assert!(sys.external.interrupt_active());
        assert!(pi::get_active_interrupts(&sys).external_interface());

        for channel in 0..3 {
            let mut acknowledge = channel_mut(&mut sys.external, channel).unwrap().parameter;
            acknowledge.set_transfer_interrupt(true);
            write_parameter_masked(&mut sys, channel, acknowledge, u32::MAX);
            assert_eq!(sys.external.interrupt_active(), channel != 2);
            assert_eq!(
                pi::get_active_interrupts(&sys).external_interface(),
                channel != 2
            );
        }
    }

    #[test]
    fn partial_csr_write_acknowledges_only_the_written_lane() {
        let mut sys = system();
        sys.external.channel0.parameter =
            Parameter::from_bits((1 << 1) | (1 << 3) | (1 << 11) | (1 << 12) | (1 << 13));

        // Guest byte +3 is the low CSR lane: acknowledge TCINT and set its mask, leaving the
        // upper attach/EXT/ROMDIS lane untouched.
        sys.write_phys_slow(Address(0x0c00_6803), 0x0c_u8);
        let after_low = sys.external.channel0.parameter;
        assert!(after_low.device_interrupt());
        assert!(!after_low.transfer_interrupt());
        assert!(after_low.transfer_interrupt_mask());
        assert!(after_low.attach_interrupt());
        assert!(after_low.device_connected());
        assert!(after_low.rom_disable());

        // Guest byte +2 owns bits 8..15. A zero partial write clears only writable config in that
        // lane; read-only EXT and unacknowledged attach status survive.
        sys.write_phys_slow(Address(0x0c00_6802), 0_u8);
        let after_high = sys.external.channel0.parameter;
        assert!(after_high.device_interrupt());
        assert!(after_high.attach_interrupt());
        assert!(after_high.device_connected());
        assert!(!after_high.rom_disable());
        assert!(after_high.transfer_interrupt_mask());
    }
}
