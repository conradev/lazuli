#![feature(array_try_map)]

mod exec;

mod bus;

pub mod ins;

use std::ops::Range;

use bitos::integer::{u3, u4};
use bitos::{BitUtils, bitos};
pub use bus::{
    DspBus, DspBusFault, DspBusOperation, DspControl, DspDma, DspDmaControl, DspDmaDirection,
    DspDmaTarget, DspMailbox,
};
use strum::FromRepr;
use util::boxed_array;

use crate::ins::{ExtensionOpcode, Opcode};

#[rustfmt::skip]
pub use crate::ins::Ins;

const IRAM_LEN: usize = 0x1000;
const IROM_LEN: usize = 0x1000;
const DRAM_LEN: usize = 0x1000;
const COEF_LEN: usize = 0x0800;
const IFX_LEN: usize = 0x0100;
const ARAM_LEN: usize = 0x0100_0000;
const ARAM_ADDRESS_MASK: u32 = 0x00ff_ffff;
const ACCEL_START_END_ADDRESS_MASK: u32 = 0x3fff_ffff;
const ACCEL_CURRENT_ADDRESS_MASK: u32 = 0xbfff_ffff;
const STACK_DEPTH: usize = 0x20;
const STACK_MASK: u8 = 0x1f;

#[inline(always)]
fn read_be_u16(bytes: &[u8]) -> u16 {
    let mut value = [0; 2];
    let length = bytes.len().min(value.len());
    value[..length].copy_from_slice(&bytes[..length]);
    u16::from_be_bytes(value)
}

#[inline(always)]
fn write_be_u16(value: u16, bytes: &mut [u8]) {
    let value = value.to_be_bytes();
    let length = bytes.len().min(value.len());
    bytes[..length].copy_from_slice(&value[..length]);
}

fn main_ram_range(
    bus: &dyn DspBus,
    operation: DspBusOperation,
    address: u32,
    length: usize,
) -> Result<Range<usize>, DspBusFault> {
    let memory_length = bus.main_ram().len();
    let start = address as usize;
    let end = start.checked_add(length);
    if end.is_none_or(|end| end > memory_length) {
        return Err(DspBusFault {
            operation,
            address,
            length: u32::try_from(length).unwrap_or(u32::MAX),
            memory_length: u32::try_from(memory_length).unwrap_or(u32::MAX),
        });
    }
    Ok(start..end.unwrap())
}

#[cold]
fn aram_fault(
    operation: DspBusOperation,
    address: u32,
    length: u32,
    memory_length: usize,
) -> DspBusFault {
    DspBusFault {
        operation,
        address: address & ARAM_ADDRESS_MASK,
        length,
        memory_length: u32::try_from(memory_length).unwrap_or(u32::MAX),
    }
}

fn validate_aram(bus: &dyn DspBus) -> Result<(), DspBusFault> {
    let memory_length = bus.aram().len();
    if memory_length < ARAM_LEN {
        return Err(aram_fault(
            DspBusOperation::ValidateAram,
            0,
            ARAM_LEN as u32,
            memory_length,
        ));
    }
    Ok(())
}

#[inline(always)]
fn read_aram_u8(bus: &dyn DspBus, address: u32) -> Result<u8, DspBusFault> {
    let address = address & ARAM_ADDRESS_MASK;
    bus.aram()
        .get(address as usize)
        .copied()
        .ok_or_else(|| aram_fault(DspBusOperation::ReadAram, address, 1, bus.aram().len()))
}

#[inline(always)]
fn read_aram_be_u16(bus: &dyn DspBus, address: u32) -> Result<u16, DspBusFault> {
    let high = read_aram_u8(bus, address)?;
    let low = read_aram_u8(bus, address.wrapping_add(1))?;
    Ok(u16::from_be_bytes([high, low]))
}

#[inline(always)]
fn write_aram_be_u16(bus: &mut dyn DspBus, address: u32, value: u16) -> Result<(), DspBusFault> {
    let high_address = address & ARAM_ADDRESS_MASK;
    let low_address = address.wrapping_add(1) & ARAM_ADDRESS_MASK;
    let aram = bus.aram_mut();
    let memory_length = aram.len();
    if high_address as usize >= memory_length || low_address as usize >= memory_length {
        return Err(aram_fault(
            DspBusOperation::WriteAram,
            high_address,
            2,
            memory_length,
        ));
    }

    let [high, low] = value.to_be_bytes();
    aram[high_address as usize] = high;
    aram[low_address as usize] = low;
    Ok(())
}

pub struct Memory {
    pub iram: Box<[u16; IRAM_LEN]>,
    pub irom: Box<[u16; IROM_LEN]>,
    pub dram: Box<[u16; DRAM_LEN]>,
    pub coef: Box<[u16; COEF_LEN]>,
}

impl Default for Memory {
    fn default() -> Self {
        Self {
            iram: boxed_array(0),
            irom: boxed_array(0),
            dram: boxed_array(0),
            coef: boxed_array(0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interrupt {
    Reset                = 0,
    StackOverflow        = 1,
    Unknown0             = 2,
    AccelRawReadOverflow = 3,
    AccelRawWriteOverflow = 4,
    AccelSampleReadOverflow = 5,
    Unknown1             = 6,
    External             = 7,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Acc40 {
    pub low: u16,
    pub mid: u16,
    pub high: u8,
}

impl Acc40 {
    const MIN: i64 = (1 << 63) >> 24;

    #[inline(always)]
    pub fn from(value: i64) -> Self {
        Self {
            low: value.bits(0, 16) as u16,
            mid: value.bits(16, 32) as u16,
            high: value.bits(32, 40) as u8,
        }
    }

    #[inline(always)]
    pub fn get(&self) -> i64 {
        let bits = 0
            .with_bits(0, 16, self.low as i64)
            .with_bits(16, 32, self.mid as i64)
            .with_bits(32, 40, self.high as i64);

        (bits << 24) >> 24
    }

    #[inline(always)]
    pub fn set(&mut self, value: i64) -> i64 {
        *self = Self::from(value);
        self.get()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Product {
    pub low: u16,
    pub mid1: u16,
    pub mid2: u16,
    pub high: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProductView {
    pub value: i64,
    pub mid_carry: bool,
    pub carry: bool,
    pub overflow: bool,
}

impl Product {
    pub fn resolve(&self) -> ProductView {
        let mid = self.mid1 as u32 + self.mid2 as u32;
        let mid_carry = mid.bit(16);
        let high = self.high as u16 + mid_carry as u16;
        let carry = high.bit(8);
        let overflow = !self.high.bit(7) && high.bit(7);

        let bits = 0
            .with_bits(0, 16, self.low as i64)
            .with_bits(16, 32, mid as i64)
            .with_bits(32, 40, high as i64);

        let value = (bits << 24) >> 24;

        ProductView {
            value,
            mid_carry,
            carry,
            overflow,
        }
    }

    pub fn set(&mut self, value: i64) {
        self.low = value as u16;
        self.mid1 = 0;
        self.mid2 = (value >> 16) as u16;
        self.high = (value >> 32) as u8;
    }
}

#[bitos(16)]
#[derive(Debug, Clone, Copy)]
pub struct Status {
    #[bits(0)]
    pub carry: bool,
    #[bits(1)]
    pub overflow: bool,
    #[bits(2)]
    pub arithmetic_zero: bool,
    #[bits(3)]
    pub sign: bool,
    #[bits(4)]
    pub above_s32: bool,
    #[bits(5)]
    pub top_two_bits_eq: bool,
    #[bits(6)]
    pub logic_zero: bool,
    #[bits(7)]
    pub overflow_fused: bool,
    #[bits(9)]
    pub interrupt_enable: bool,
    #[bits(11)]
    pub external_interrupt_enable: bool,
    #[bits(13)]
    pub dont_double_result: bool,
    #[bits(14)]
    pub sign_extend_to_40: bool,
    #[bits(15)]
    pub unsigned_mul: bool,
}

impl Default for Status {
    fn default() -> Self {
        Self::from_bits(0)
            .with_interrupt_enable(true)
            .with_external_interrupt_enable(true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRepr)]
#[repr(u8)]
pub enum Reg {
    Addr0,
    Addr1,
    Addr2,
    Addr3,
    Index0,
    Index1,
    Index2,
    Index3,
    Wrap0,
    Wrap1,
    Wrap2,
    Wrap3,
    CallStack,
    DataStack,
    LoopStack,
    LoopCount,
    Acc40High0,
    Acc40High1,
    Config,
    Status,
    ProdLow,
    ProdMid1,
    ProdHigh,
    ProdMid2,
    Acc32Low0,
    Acc32Low1,
    Acc32High0,
    Acc32High1,
    Acc40Low0,
    Acc40Low1,
    Acc40Mid0,
    Acc40Mid1,
}

impl Reg {
    pub fn new(index: u8) -> Self {
        Self::from_repr(index).unwrap()
    }
}

/// One of the DSP's hardware register stacks.
///
/// The current entry is always readable. Pushes and pops wrap through the
/// fixed hardware storage instead of growing, becoming empty, or panicking.
#[derive(Debug, Clone)]
pub struct DspStack {
    current: u16,
    entries: [u16; STACK_DEPTH],
    cursor: u8,
}

impl Default for DspStack {
    fn default() -> Self {
        Self {
            current: 0,
            entries: [0; STACK_DEPTH],
            cursor: 0,
        }
    }
}

impl DspStack {
    #[inline(always)]
    pub fn peek(&self) -> u16 {
        self.current
    }

    #[inline(always)]
    fn peek_mut(&mut self) -> &mut u16 {
        &mut self.current
    }

    #[inline(always)]
    pub fn push(&mut self, value: u16) {
        self.cursor = self.cursor.wrapping_add(1) & STACK_MASK;
        self.entries[self.cursor as usize] = self.current;
        self.current = value;
    }

    #[inline(always)]
    pub fn pop(&mut self) -> u16 {
        let value = self.current;
        self.current = self.entries[self.cursor as usize];
        self.cursor = self.cursor.wrapping_sub(1) & STACK_MASK;
        value
    }
}

#[derive(Debug, Clone)]
pub struct Registers {
    pub addressing: [u16; 4],
    pub indexing: [u16; 4],
    pub wrapping: [u16; 4],
    pub call_stack: DspStack,
    pub data_stack: DspStack,
    pub loop_stack: DspStack,
    pub loop_count: DspStack,
    pub product: Product,
    pub acc40: [Acc40; 2],
    pub acc32: [i32; 2],
    pub config: u8,
    pub status: Status,
}

impl Default for Registers {
    fn default() -> Self {
        Self {
            addressing: Default::default(),
            indexing: Default::default(),
            wrapping: [0xFFFF; 4],
            call_stack: Default::default(),
            data_stack: Default::default(),
            loop_stack: Default::default(),
            loop_count: Default::default(),
            product: Default::default(),
            acc40: Default::default(),
            acc32: Default::default(),
            config: Default::default(),
            status: Default::default(),
        }
    }
}

impl Registers {
    pub fn get_pure(&self, reg: Reg) -> u16 {
        let acc_saturate = |i: usize| {
            let ml = self.acc40[i].get() as i32 as i64;
            let hml = self.acc40[i].get();

            if self.status.sign_extend_to_40() && ml != hml {
                if hml >= 0 { 0x7FFF } else { 0x8000 }
            } else {
                self.acc40[i].mid
            }
        };

        match reg {
            Reg::Addr0 => self.addressing[0],
            Reg::Addr1 => self.addressing[1],
            Reg::Addr2 => self.addressing[2],
            Reg::Addr3 => self.addressing[3],
            Reg::Index0 => self.indexing[0],
            Reg::Index1 => self.indexing[1],
            Reg::Index2 => self.indexing[2],
            Reg::Index3 => self.indexing[3],
            Reg::Wrap0 => self.wrapping[0],
            Reg::Wrap1 => self.wrapping[1],
            Reg::Wrap2 => self.wrapping[2],
            Reg::Wrap3 => self.wrapping[3],
            Reg::CallStack => self.call_stack.peek(),
            Reg::DataStack => self.data_stack.peek(),
            Reg::LoopStack => self.loop_stack.peek(),
            Reg::LoopCount => self.loop_count.peek(),
            Reg::Acc40High0 => self.acc40[0].high as i8 as i16 as u16,
            Reg::Acc40High1 => self.acc40[1].high as i8 as i16 as u16,
            Reg::Config => self.config as u16,
            Reg::Status => self.status.to_bits(),
            Reg::ProdLow => self.product.low,
            Reg::ProdMid1 => self.product.mid1,
            Reg::ProdHigh => self.product.high as u16,
            Reg::ProdMid2 => self.product.mid2,
            Reg::Acc32Low0 => self.acc32[0].bits(0, 16) as u16,
            Reg::Acc32Low1 => self.acc32[1].bits(0, 16) as u16,
            Reg::Acc32High0 => self.acc32[0].bits(16, 32) as u16,
            Reg::Acc32High1 => self.acc32[1].bits(16, 32) as u16,
            Reg::Acc40Low0 => self.acc40[0].low,
            Reg::Acc40Low1 => self.acc40[1].low,
            Reg::Acc40Mid0 => acc_saturate(0),
            Reg::Acc40Mid1 => acc_saturate(1),
        }
    }

    pub fn get(&mut self, reg: Reg) -> u16 {
        match reg {
            Reg::CallStack => self.call_stack.pop(),
            Reg::DataStack => self.data_stack.pop(),
            Reg::LoopStack => self.loop_stack.pop(),
            Reg::LoopCount => self.loop_count.pop(),
            _ => self.get_pure(reg),
        }
    }

    pub fn set(&mut self, reg: Reg, value: u16) {
        match reg {
            Reg::Addr0 => self.addressing[0] = value,
            Reg::Addr1 => self.addressing[1] = value,
            Reg::Addr2 => self.addressing[2] = value,
            Reg::Addr3 => self.addressing[3] = value,
            Reg::Index0 => self.indexing[0] = value,
            Reg::Index1 => self.indexing[1] = value,
            Reg::Index2 => self.indexing[2] = value,
            Reg::Index3 => self.indexing[3] = value,
            Reg::Wrap0 => self.wrapping[0] = value,
            Reg::Wrap1 => self.wrapping[1] = value,
            Reg::Wrap2 => self.wrapping[2] = value,
            Reg::Wrap3 => self.wrapping[3] = value,
            Reg::CallStack => self.call_stack.push(value),
            Reg::DataStack => self.data_stack.push(value),
            Reg::LoopStack => self.loop_stack.push(value),
            Reg::LoopCount => self.loop_count.push(value),
            Reg::Acc40High0 => self.acc40[0].high = value as u8,
            Reg::Acc40High1 => self.acc40[1].high = value as u8,
            Reg::Config => self.config = value as u8,
            Reg::Status => self.status = Status::from_bits(value.with_bit(8, false)),
            Reg::ProdLow => self.product.low = value,
            Reg::ProdMid1 => self.product.mid1 = value,
            Reg::ProdHigh => self.product.high = value as u8,
            Reg::ProdMid2 => self.product.mid2 = value,
            Reg::Acc32Low0 => self.acc32[0] = self.acc32[0].with_bits(0, 16, value as i32),
            Reg::Acc32Low1 => self.acc32[1] = self.acc32[1].with_bits(0, 16, value as i32),
            Reg::Acc32High0 => self.acc32[0] = self.acc32[0].with_bits(16, 32, value as i32),
            Reg::Acc32High1 => self.acc32[1] = self.acc32[1].with_bits(16, 32, value as i32),
            Reg::Acc40Low0 => self.acc40[0].low = value,
            Reg::Acc40Low1 => self.acc40[1].low = value,
            Reg::Acc40Mid0 => self.acc40[0].mid = value,
            Reg::Acc40Mid1 => self.acc40[1].mid = value,
        }
    }

    fn set_acc_saturate(&mut self, i: usize, value: u16) {
        if self.status.sign_extend_to_40() {
            self.acc40[i].low = 0;
            self.acc40[i].mid = value;
            self.acc40[i].high = if value.bit(15) { !0 } else { 0 };
        } else {
            self.acc40[i].mid = value;
        }
    }

    pub fn set_saturate(&mut self, reg: Reg, value: u16) {
        match reg {
            Reg::Acc40Mid0 => {
                std::hint::cold_path();
                self.set_acc_saturate(0, value)
            }
            Reg::Acc40Mid1 => {
                std::hint::cold_path();
                self.set_acc_saturate(1, value)
            }
            Reg::LoopStack => std::hint::cold_path(),
            _ => self.set(reg, value),
        }
    }
}

/// Register values observed in parallel by an extended opcode.
///
/// Hardware stacks are deliberately excluded: extended opcodes cannot address
/// them, and copying four 32-word stacks in the interpreter hot loop would be
/// needless work.
#[derive(Clone, Copy)]
pub(crate) struct ExtensionRegisters {
    addressing: [u16; 4],
    indexing: [u16; 4],
    wrapping: [u16; 4],
    acc40: [Acc40; 2],
    acc32: [i32; 2],
    status: Status,
}

impl ExtensionRegisters {
    #[inline(always)]
    fn capture(regs: &Registers) -> Self {
        Self {
            addressing: regs.addressing,
            indexing: regs.indexing,
            wrapping: regs.wrapping,
            acc40: regs.acc40,
            acc32: regs.acc32,
            status: regs.status,
        }
    }

    #[inline(always)]
    fn get_pure(&self, reg: Reg) -> u16 {
        let acc_saturate = |i: usize| {
            let ml = self.acc40[i].get() as i32 as i64;
            let hml = self.acc40[i].get();

            if self.status.sign_extend_to_40() && ml != hml {
                if hml >= 0 { 0x7fff } else { 0x8000 }
            } else {
                self.acc40[i].mid
            }
        };

        match reg {
            Reg::Acc32Low0 => self.acc32[0].bits(0, 16) as u16,
            Reg::Acc32Low1 => self.acc32[1].bits(0, 16) as u16,
            Reg::Acc32High0 => self.acc32[0].bits(16, 32) as u16,
            Reg::Acc32High1 => self.acc32[1].bits(16, 32) as u16,
            Reg::Acc40Low0 => self.acc40[0].low,
            Reg::Acc40Low1 => self.acc40[1].low,
            Reg::Acc40Mid0 => acc_saturate(0),
            Reg::Acc40Mid1 => acc_saturate(1),
            _ => unreachable!("extended opcode read unsupported register {reg:?}"),
        }
    }
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SampleSize {
    #[default]
    Nibble   = 0b00,
    Byte     = 0b01,
    Word     = 0b10,
    Reserved = 0b11,
}

impl SampleSize {
    pub fn size(self) -> u32 {
        match self {
            Self::Nibble => 1,
            Self::Byte => 2,
            Self::Word => 4,
            _ => panic!("reserved size"),
        }
    }
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, Default)]
pub enum SampleDecoding {
    #[default]
    AramAdpcm  = 0b00,
    AcinPcm    = 0b01,
    AramPcm    = 0b10,
    AcinPcmInc = 0b11,
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, Default)]
pub enum PcmDivisor {
    #[default]
    D2048    = 0b00,
    D1       = 0b01,
    D65536   = 0b10,
    Reserved = 0b11,
}

impl PcmDivisor {
    pub fn value(self) -> u32 {
        match self {
            Self::D2048 => 2048,
            Self::D1 => 1,
            Self::D65536 => 65536,
            _ => panic!("reserved divisor"),
        }
    }

    /// Applies rounding division.
    pub fn apply(self, value: i32) -> i32 {
        match self {
            Self::D2048 => (value + (1 << 10)) >> 11,
            Self::D1 => value,
            Self::D65536 => (value + (1 << 15)) >> 16,
            _ => panic!("reserved divisor"),
        }
    }
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default)]
pub struct AccelFormat {
    #[bits(0..2)]
    pub sample: SampleSize,
    #[bits(2..4)]
    pub decoding: SampleDecoding,
    #[bits(4..6)]
    pub divisor: PcmDivisor,
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default)]
pub struct AccelPredictor {
    #[bits(0..4)]
    pub scale_log2: u4,
    #[bits(4..7)]
    pub coefficients: u3,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AccelCoefficients {
    pub a: i16,
    pub b: i16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccelOverflow {
    #[default]
    None,
    RawRead,
    RawWrite,
    Sample,
}

#[derive(Default)]
pub struct Accelerator {
    pub coefficients: [AccelCoefficients; 8],
    pub format: AccelFormat,
    pub predictor: AccelPredictor,
    pub aram_start: u32,
    pub aram_end: u32,
    pub aram_curr: u32,
    pub gain: i16,
    pub input: i16,
    pub previous_samples: [i16; 2],
    pub reads_stopped: bool,
    /// Compatibility mirror of the raw AMDM register; IFX storage remains authoritative.
    pub dma_masked: bool,
    pub overflow: AccelOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRepr)]
#[repr(u8)]
pub enum Mmio {
    // Accelerator coefficients
    AccelCoeffA0       = 0xA0,
    AccelCoeffB0       = 0xA1,
    AccelCoeffA1       = 0xA2,
    AccelCoeffB1       = 0xA3,
    AccelCoeffA2       = 0xA4,
    AccelCoeffB2       = 0xA5,
    AccelCoeffA3       = 0xA6,
    AccelCoeffB3       = 0xA7,
    AccelCoeffA4       = 0xA8,
    AccelCoeffB4       = 0xA9,
    AccelCoeffA5       = 0xAA,
    AccelCoeffB5       = 0xAB,
    AccelCoeffA6       = 0xAC,
    AccelCoeffB6       = 0xAD,
    AccelCoeffA7       = 0xAE,
    AccelCoeffB7       = 0xAF,

    // DMA
    DmaControl         = 0xC9,
    DmaLength          = 0xCB,
    DmaDspAddr         = 0xCD,
    DmaRamAddrHigh     = 0xCE,
    DmaRamAddrLow      = 0xCF,

    // Accelerator
    AccelFormat        = 0xD1,
    AccelRaw           = 0xD3,
    AccelStartAddrHigh = 0xD4,
    AccelStartAddrLow  = 0xD5,
    AccelEndAddrHigh   = 0xD6,
    AccelEndAddrLow    = 0xD7,
    AccelCurrAddrHigh  = 0xD8,
    AccelCurrAddrLow   = 0xD9,
    AccelPredictor     = 0xDA,
    AccelPrevSample0   = 0xDB,
    AccelPrevSample1   = 0xDC,
    AccelSample        = 0xDD,
    AccelGain          = 0xDE,
    AccelInput         = 0xDF,

    // DMA mask
    DmaMasked          = 0xEF,

    // Interrupts
    InterruptRequest   = 0xFB,

    // Mailboxes
    DspMailboxHigh     = 0xFC,
    DspMailboxLow      = 0xFD,
    CpuMailboxHigh     = 0xFE,
    CpuMailboxLow      = 0xFF,
}

#[derive(Clone, Copy)]
struct CachedIns {
    ins: Ins,
    len: u16,
    main: OpcodeFn,
    extension: Option<ExtensionFn>,
}

pub struct Interpreter {
    pub pc: u16,
    pub regs: Registers,
    pub mem: Memory,
    pub accel: Accelerator,
    pub old_reset_high: bool,

    ifx_regs: [u16; IFX_LEN],
    cached: Box<[Option<CachedIns>; 1 << 16]>,
    pending_stop: Option<ExecStopReason>,
    pending_bus_fault: Option<DspBusFault>,
}

impl Default for Interpreter {
    fn default() -> Self {
        Self {
            pc: Default::default(),
            regs: Default::default(),
            mem: Default::default(),
            accel: Default::default(),
            old_reset_high: Default::default(),
            ifx_regs: [0; IFX_LEN],
            cached: util::boxed_array(None),
            pending_stop: None,
            pending_bus_fault: None,
        }
    }
}

/// Why an interpreter execution slice stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecStopReason {
    InstructionBudgetExhausted,
    Halted,
    DspMailboxFull,
    CpuMailboxEmpty,
    BusFault(DspBusFault),
}

/// Result of one bounded interpreter execution slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecOutcome {
    pub executed_instructions: u32,
    pub stop_reason: ExecStopReason,
}

type OpcodeFn = for<'a, 'b> fn(&'a mut Interpreter, &'b mut dyn DspBus, Ins);

static OPCODE_EXEC_LUT: [OpcodeFn; 1 << 8] = {
    fn nop(_: &mut Interpreter, _: &mut dyn DspBus, _: Ins) {}
    let mut lut = [nop as OpcodeFn; 1 << 8];

    lut[Opcode::Abs as usize] = Interpreter::abs as OpcodeFn;
    lut[Opcode::Add as usize] = Interpreter::add as OpcodeFn;
    lut[Opcode::Addarn as usize] = Interpreter::addarn as OpcodeFn;
    lut[Opcode::Addax as usize] = Interpreter::addax as OpcodeFn;
    lut[Opcode::Addaxl as usize] = Interpreter::addaxl as OpcodeFn;
    lut[Opcode::Addi as usize] = Interpreter::addi as OpcodeFn;
    lut[Opcode::Addis as usize] = Interpreter::addis as OpcodeFn;
    lut[Opcode::Addp as usize] = Interpreter::addp as OpcodeFn;
    lut[Opcode::Addpaxz as usize] = Interpreter::addpaxz as OpcodeFn;
    lut[Opcode::Addr as usize] = Interpreter::addr as OpcodeFn;
    lut[Opcode::Andc as usize] = Interpreter::andc as OpcodeFn;
    lut[Opcode::Andcf as usize] = Interpreter::andcf as OpcodeFn;
    lut[Opcode::Andf as usize] = Interpreter::andf as OpcodeFn;
    lut[Opcode::Andi as usize] = Interpreter::andi as OpcodeFn;
    lut[Opcode::Andr as usize] = Interpreter::andr as OpcodeFn;
    lut[Opcode::Asl as usize] = Interpreter::asl as OpcodeFn;
    lut[Opcode::Asr as usize] = Interpreter::asr as OpcodeFn;
    lut[Opcode::Asr16 as usize] = Interpreter::asr16 as OpcodeFn;
    lut[Opcode::Asrn as usize] = Interpreter::asrn as OpcodeFn;
    lut[Opcode::Asrnr as usize] = Interpreter::asrnr as OpcodeFn;
    lut[Opcode::Asrnrx as usize] = Interpreter::asrnrx as OpcodeFn;
    lut[Opcode::Bloop as usize] = Interpreter::bloop as OpcodeFn;
    lut[Opcode::Bloopi as usize] = Interpreter::bloopi as OpcodeFn;
    lut[Opcode::Call as usize] = Interpreter::call as OpcodeFn;
    lut[Opcode::Callr as usize] = Interpreter::callr as OpcodeFn;
    lut[Opcode::Clr as usize] = Interpreter::clr as OpcodeFn;
    lut[Opcode::Clr15 as usize] = Interpreter::clr15 as OpcodeFn;
    lut[Opcode::Clrl as usize] = Interpreter::clrl as OpcodeFn;
    lut[Opcode::Clrp as usize] = Interpreter::clrp as OpcodeFn;
    lut[Opcode::Cmp as usize] = Interpreter::cmp as OpcodeFn;
    lut[Opcode::Cmpaxh as usize] = Interpreter::cmpaxh as OpcodeFn;
    lut[Opcode::Cmpi as usize] = Interpreter::cmpi as OpcodeFn;
    lut[Opcode::Cmpis as usize] = Interpreter::cmpis as OpcodeFn;
    lut[Opcode::Dar as usize] = Interpreter::dar as OpcodeFn;
    lut[Opcode::Dec as usize] = Interpreter::dec as OpcodeFn;
    lut[Opcode::Decm as usize] = Interpreter::decm as OpcodeFn;
    lut[Opcode::Halt as usize] = Interpreter::halt as OpcodeFn;
    lut[Opcode::Iar as usize] = Interpreter::iar as OpcodeFn;
    lut[Opcode::If as usize] = Interpreter::ifcc as OpcodeFn;
    lut[Opcode::Ilrr as usize] = Interpreter::ilrr as OpcodeFn;
    lut[Opcode::Ilrrd as usize] = Interpreter::ilrrd as OpcodeFn;
    lut[Opcode::Ilrri as usize] = Interpreter::ilrri as OpcodeFn;
    lut[Opcode::Ilrrn as usize] = Interpreter::ilrrn as OpcodeFn;
    lut[Opcode::Inc as usize] = Interpreter::inc as OpcodeFn;
    lut[Opcode::Incm as usize] = Interpreter::incm as OpcodeFn;
    lut[Opcode::Jmp as usize] = Interpreter::jmp as OpcodeFn;
    lut[Opcode::Jr as usize] = Interpreter::jmpr as OpcodeFn;
    lut[Opcode::Loop as usize] = Interpreter::loop_ as OpcodeFn;
    lut[Opcode::Loopi as usize] = Interpreter::loopi as OpcodeFn;
    lut[Opcode::Lr as usize] = Interpreter::lr as OpcodeFn;
    lut[Opcode::Lri as usize] = Interpreter::lri as OpcodeFn;
    lut[Opcode::Lris as usize] = Interpreter::lris as OpcodeFn;
    lut[Opcode::Lrr as usize] = Interpreter::lrr as OpcodeFn;
    lut[Opcode::Lrrd as usize] = Interpreter::lrrd as OpcodeFn;
    lut[Opcode::Lrri as usize] = Interpreter::lrri as OpcodeFn;
    lut[Opcode::Lrrn as usize] = Interpreter::lrrn as OpcodeFn;
    lut[Opcode::Lrs as usize] = Interpreter::lrs as OpcodeFn;
    lut[Opcode::Lsl as usize] = Interpreter::lsl as OpcodeFn;
    lut[Opcode::Lsl16 as usize] = Interpreter::lsl16 as OpcodeFn;
    lut[Opcode::Lsr as usize] = Interpreter::lsr as OpcodeFn;
    lut[Opcode::Lsr16 as usize] = Interpreter::lsr16 as OpcodeFn;
    lut[Opcode::Lsrn as usize] = Interpreter::lsrn as OpcodeFn;
    lut[Opcode::Lsrnr as usize] = Interpreter::lsrnr as OpcodeFn;
    lut[Opcode::Lsrnrx as usize] = Interpreter::lsrnrx as OpcodeFn;
    lut[Opcode::M0 as usize] = Interpreter::m0 as OpcodeFn;
    lut[Opcode::M2 as usize] = Interpreter::m2 as OpcodeFn;
    lut[Opcode::Madd as usize] = Interpreter::madd as OpcodeFn;
    lut[Opcode::Maddc as usize] = Interpreter::maddc as OpcodeFn;
    lut[Opcode::Maddx as usize] = Interpreter::maddx as OpcodeFn;
    lut[Opcode::Mov as usize] = Interpreter::mov as OpcodeFn;
    lut[Opcode::Movax as usize] = Interpreter::movax as OpcodeFn;
    lut[Opcode::Movnp as usize] = Interpreter::movnp as OpcodeFn;
    lut[Opcode::Movp as usize] = Interpreter::movp as OpcodeFn;
    lut[Opcode::Movpz as usize] = Interpreter::movpz as OpcodeFn;
    lut[Opcode::Movr as usize] = Interpreter::movr as OpcodeFn;
    lut[Opcode::Mrr as usize] = Interpreter::mrr as OpcodeFn;
    lut[Opcode::Msub as usize] = Interpreter::msub as OpcodeFn;
    lut[Opcode::Msubc as usize] = Interpreter::msubc as OpcodeFn;
    lut[Opcode::Msubx as usize] = Interpreter::msubx as OpcodeFn;
    lut[Opcode::Mul as usize] = Interpreter::mul as OpcodeFn;
    lut[Opcode::Mulac as usize] = Interpreter::mulac as OpcodeFn;
    lut[Opcode::Mulaxh as usize] = Interpreter::mulaxh as OpcodeFn;
    lut[Opcode::Mulc as usize] = Interpreter::mulc as OpcodeFn;
    lut[Opcode::Mulcac as usize] = Interpreter::mulcac as OpcodeFn;
    lut[Opcode::Mulcmv as usize] = Interpreter::mulcmv as OpcodeFn;
    lut[Opcode::Mulcmvz as usize] = Interpreter::mulcmvz as OpcodeFn;
    lut[Opcode::Mulmv as usize] = Interpreter::mulmv as OpcodeFn;
    lut[Opcode::Mulmvz as usize] = Interpreter::mulmvz as OpcodeFn;
    lut[Opcode::Mulx as usize] = Interpreter::mulx as OpcodeFn;
    lut[Opcode::Mulxac as usize] = Interpreter::mulxac as OpcodeFn;
    lut[Opcode::Mulxmv as usize] = Interpreter::mulxmv as OpcodeFn;
    lut[Opcode::Mulxmvz as usize] = Interpreter::mulxmvz as OpcodeFn;
    lut[Opcode::Neg as usize] = Interpreter::neg as OpcodeFn;
    lut[Opcode::Not as usize] = Interpreter::not as OpcodeFn;
    lut[Opcode::Orc as usize] = Interpreter::orc as OpcodeFn;
    lut[Opcode::Ori as usize] = Interpreter::ori as OpcodeFn;
    lut[Opcode::Orr as usize] = Interpreter::orr as OpcodeFn;
    lut[Opcode::Ret as usize] = Interpreter::ret as OpcodeFn;
    lut[Opcode::Rti as usize] = Interpreter::rti as OpcodeFn;
    lut[Opcode::Sbclr as usize] = Interpreter::sbclr as OpcodeFn;
    lut[Opcode::Sbset as usize] = Interpreter::sbset as OpcodeFn;
    lut[Opcode::Set15 as usize] = Interpreter::set15 as OpcodeFn;
    lut[Opcode::Set16 as usize] = Interpreter::set16 as OpcodeFn;
    lut[Opcode::Set40 as usize] = Interpreter::set40 as OpcodeFn;
    lut[Opcode::Si as usize] = Interpreter::si as OpcodeFn;
    lut[Opcode::Sr as usize] = Interpreter::sr as OpcodeFn;
    lut[Opcode::Srr as usize] = Interpreter::srr as OpcodeFn;
    lut[Opcode::Srrd as usize] = Interpreter::srrd as OpcodeFn;
    lut[Opcode::Srri as usize] = Interpreter::srri as OpcodeFn;
    lut[Opcode::Srrn as usize] = Interpreter::srrn as OpcodeFn;
    lut[Opcode::Srs as usize] = Interpreter::srs as OpcodeFn;
    lut[Opcode::Srsh as usize] = Interpreter::srsh as OpcodeFn;
    lut[Opcode::Sub as usize] = Interpreter::sub as OpcodeFn;
    lut[Opcode::Subarn as usize] = Interpreter::subarn as OpcodeFn;
    lut[Opcode::Subax as usize] = Interpreter::subax as OpcodeFn;
    lut[Opcode::Subp as usize] = Interpreter::subp as OpcodeFn;
    lut[Opcode::Subr as usize] = Interpreter::subr as OpcodeFn;
    lut[Opcode::Tst as usize] = Interpreter::tst as OpcodeFn;
    lut[Opcode::Tstaxh as usize] = Interpreter::tstaxh as OpcodeFn;
    lut[Opcode::Tstprod as usize] = Interpreter::tstprod as OpcodeFn;
    lut[Opcode::Xorc as usize] = Interpreter::xorc as OpcodeFn;
    lut[Opcode::Xori as usize] = Interpreter::xori as OpcodeFn;
    lut[Opcode::Xorr as usize] = Interpreter::xorr as OpcodeFn;

    lut
};

type ExtensionFn =
    for<'a, 'b, 'c> fn(&'a mut Interpreter, &'b mut dyn DspBus, Ins, &'c ExtensionRegisters);

static EXTENSION_EXEC_LUT: [ExtensionFn; 1 << 8] = {
    fn nop(_: &mut Interpreter, _: &mut dyn DspBus, _: Ins, _: &ExtensionRegisters) {}
    let mut lut = [nop as ExtensionFn; 1 << 8];

    lut[ExtensionOpcode::Dr as usize] = Interpreter::ext_dr as ExtensionFn;
    lut[ExtensionOpcode::Ir as usize] = Interpreter::ext_ir as ExtensionFn;
    lut[ExtensionOpcode::L as usize] = Interpreter::ext_l as ExtensionFn;
    lut[ExtensionOpcode::Ld as usize] = Interpreter::ext_ld as ExtensionFn;
    lut[ExtensionOpcode::Ldm as usize] = Interpreter::ext_ldm as ExtensionFn;
    lut[ExtensionOpcode::Ldn as usize] = Interpreter::ext_ldn as ExtensionFn;
    lut[ExtensionOpcode::Ldnm as usize] = Interpreter::ext_ldnm as ExtensionFn;
    lut[ExtensionOpcode::Ln as usize] = Interpreter::ext_ln as ExtensionFn;
    lut[ExtensionOpcode::Ls as usize] = Interpreter::ext_ls as ExtensionFn;
    lut[ExtensionOpcode::Lsm as usize] = Interpreter::ext_lsm as ExtensionFn;
    lut[ExtensionOpcode::Lsn as usize] = Interpreter::ext_lsn as ExtensionFn;
    lut[ExtensionOpcode::Lsnm as usize] = Interpreter::ext_lsnm as ExtensionFn;
    lut[ExtensionOpcode::Mv as usize] = Interpreter::ext_mv as ExtensionFn;
    lut[ExtensionOpcode::Nr as usize] = Interpreter::ext_nr as ExtensionFn;
    lut[ExtensionOpcode::S as usize] = Interpreter::ext_s as ExtensionFn;
    lut[ExtensionOpcode::Sl as usize] = Interpreter::ext_sl as ExtensionFn;
    lut[ExtensionOpcode::Slm as usize] = Interpreter::ext_slm as ExtensionFn;
    lut[ExtensionOpcode::Sln as usize] = Interpreter::ext_sln as ExtensionFn;
    lut[ExtensionOpcode::Slnm as usize] = Interpreter::ext_slnm as ExtensionFn;
    lut[ExtensionOpcode::Sn as usize] = Interpreter::ext_sn as ExtensionFn;

    lut
};

impl Interpreter {
    fn raise_interrupt(&mut self, interrupt: Interrupt) {
        self.regs.call_stack.push(self.pc);
        self.regs.data_stack.push(self.regs.status.to_bits());
        self.pc = interrupt as u16 * 2;

        match interrupt {
            Interrupt::External => self.regs.status.set_external_interrupt_enable(false),
            _ => self.regs.status.set_interrupt_enable(false),
        };
    }

    #[inline(always)]
    pub fn check_interrupts(&mut self, bus: &mut dyn DspBus) {
        // external interrupt does not care about status interrupt enable
        let mut control = bus.dsp_control();
        if self.regs.status.external_interrupt_enable() && control.cpu_to_dsp_interrupt {
            std::hint::cold_path();
            tracing::warn!("DSP external interrupt raised");
            control.cpu_to_dsp_interrupt = false;
            bus.set_dsp_control(control);
            self.raise_interrupt(Interrupt::External);
            return;
        }

        if !self.regs.status.interrupt_enable() {
            return;
        }

        match std::mem::replace(&mut self.accel.overflow, AccelOverflow::None) {
            AccelOverflow::None => (),
            AccelOverflow::RawRead => self.raise_interrupt(Interrupt::AccelRawReadOverflow),
            AccelOverflow::RawWrite => self.raise_interrupt(Interrupt::AccelRawWriteOverflow),
            AccelOverflow::Sample => self.raise_interrupt(Interrupt::AccelSampleReadOverflow),
        }
    }

    #[inline(always)]
    fn check_loop(&mut self) {
        let loop_address = self.regs.loop_stack.peek();
        let loop_counter = self.regs.loop_count.peek();
        if loop_counter == 0 || loop_address != self.pc.wrapping_sub(1) {
            return;
        }

        std::hint::cold_path();
        let counter = self.regs.loop_count.peek_mut();
        *counter = counter.wrapping_sub(1);

        if *counter == 0 {
            std::hint::cold_path();
            self.regs.call_stack.pop();
            self.regs.loop_stack.pop();
            self.regs.loop_count.pop();
        } else {
            self.pc = self.regs.call_stack.peek();
        }
    }

    /// Soft resets the DSP.
    pub fn reset(&mut self, bus: &mut dyn DspBus) {
        self.regs = Default::default();

        self.cached.fill(None);
        self.pc = if bus.dsp_control().reset_high {
            tracing::debug!("resetting at IROM (0x8000)");
            0x8000
        } else {
            tracing::debug!("resetting at IRAM (0x0000)");
            0x0000
        };
    }

    /// Checks for reset.
    pub fn check_reset(&mut self, bus: &mut dyn DspBus) -> Result<(), DspBusFault> {
        let control = bus.dsp_control();
        if control.reset || (control.reset_high != self.old_reset_high) {
            std::hint::cold_path();

            // DMA from main memory if resetting at low
            if !control.reset_high {
                tracing::debug!("DSP DMA stub from main memory");
                let range = main_ram_range(bus, DspBusOperation::ReadMainRam, 0x0100_0000, 1024)?;
                let data = bus.main_ram()[range]
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]));

                for (word, data) in self.mem.iram[..512].iter_mut().zip(data) {
                    *word = data;
                }
            }

            tracing::debug!("DSP reset");
            self.reset(bus);
        }

        let mut control = bus.dsp_control();
        control.reset = false;
        self.old_reset_high = control.reset_high;
        bus.set_dsp_control(control);
        Ok(())
    }

    /// Performs the DSP DMA if the transfer is ongoing.
    pub fn do_dma(&mut self, bus: &mut dyn DspBus) -> Result<(), DspBusFault> {
        let dma = bus.dsp_dma();
        if dma.control.transfer_ongoing() {
            std::hint::cold_path();

            let ram_base = dma.ram_base.with_bits(26, 32, 0);
            let dsp_base = dma.dsp_base;
            let length = dma.length;
            let byte_length = usize::from(length / 2) * 2;

            let (target, direction) = (dma.control.dsp_target(), dma.control.direction());

            match (target, direction) {
                (DspDmaTarget::Dmem, DspDmaDirection::FromRamToDsp) => {
                    tracing::debug!(
                        "DSP DMA {length:04X} bytes from RAM {ram_base:08X} to DMEM {dsp_base:04X}",
                    );

                    let source =
                        main_ram_range(bus, DspBusOperation::ReadMainRam, ram_base, byte_length)?;
                    for word in 0..(length / 2) {
                        let offset = source.start + usize::from(word) * 2;
                        let data = read_be_u16(&bus.main_ram()[offset..offset + 2]);

                        self.write_dmem(bus, dsp_base + word, data);
                    }
                }
                (DspDmaTarget::Dmem, DspDmaDirection::FromDspToRam) => {
                    tracing::debug!(
                        "DSP DMA {length:04X} bytes from DMEM {dsp_base:04X} to RAM {ram_base:08X}"
                    );

                    let destination =
                        main_ram_range(bus, DspBusOperation::WriteMainRam, ram_base, byte_length)?;
                    for word in 0..(length / 2) {
                        let data = self.read_dmem(bus, dsp_base + word);
                        let offset = destination.start + usize::from(word) * 2;
                        write_be_u16(data, &mut bus.main_ram_mut()[offset..offset + 2]);
                    }
                    bus.main_ram_write_completed(ram_base, byte_length);
                }
                (DspDmaTarget::Imem, DspDmaDirection::FromRamToDsp) => {
                    std::hint::cold_path();

                    tracing::info!(
                        "DSP DMA {length:04X} bytes from RAM {ram_base:08X} to IMEM {dsp_base:04X} (ucode)"
                    );

                    let source =
                        main_ram_range(bus, DspBusOperation::ReadMainRam, ram_base, byte_length)?;
                    for word in 0..(length / 2) {
                        let offset = source.start + usize::from(word) * 2;
                        let data = read_be_u16(&bus.main_ram()[offset..offset + 2]);

                        self.write_imem(dsp_base + word, data);
                    }
                }
                (DspDmaTarget::Imem, DspDmaDirection::FromDspToRam) => {
                    tracing::warn!(
                        "DSP DMA {length:04X} bytes from IMEM {dsp_base:04X} to RAM \
                         {ram_base:08X} is unsupported by hardware, ignoring"
                    );
                }
            };

            // DMA targets include MMIO, so preserve any register side effects produced by the
            // transfer rather than writing back the stale pre-transfer snapshot.
            let mut live_dma = bus.dsp_dma();
            live_dma.length = 0;
            live_dma.control.set_transfer_ongoing(false);
            bus.set_dsp_dma(live_dma);
        }
        Ok(())
    }

    fn set_accel_current_address(&mut self, address: u32) {
        self.accel.aram_curr = address & ACCEL_CURRENT_ADDRESS_MASK;
    }

    fn read_accel_value(&self, bus: &dyn DspBus) -> Result<u16, DspBusFault> {
        let format = self.accel.format;
        let index = self.accel.aram_curr;
        let value = match format.sample() {
            SampleSize::Nibble => {
                let address = index / 2;
                let byte = read_aram_u8(bus, address)? as u16;
                if index.is_multiple_of(2) {
                    byte >> 4
                } else {
                    byte & 0xF
                }
            }
            SampleSize::Byte => read_aram_u8(bus, index)? as u16,
            SampleSize::Word => {
                let address = index.wrapping_mul(2);
                read_aram_be_u16(bus, address)?
            }
            // Hardware produces garbage for the reserved size. Dolphin models that as zero.
            SampleSize::Reserved => 0,
        };

        tracing::debug!(
            "accelerator reading 0x{value:04X} from ARAM 0x{:08X} (wraps at 0x{:08X}) [0x{:04X}]",
            self.accel.aram_curr,
            self.accel.aram_end,
            self.pc
        );

        Ok(value)
    }

    fn read_accel_raw(&mut self, bus: &dyn DspBus) -> Result<u16, DspBusFault> {
        let value = self.read_accel_value(bus)?;
        let mut next = if self.accel.format.sample() == SampleSize::Reserved {
            (self.accel.aram_curr & !3) | (self.accel.aram_curr.wrapping_add(1) & 3)
        } else {
            self.accel.aram_curr.wrapping_add(1)
        };

        // The normal hardware path only wraps after reading the exact end address. A current
        // address already beyond the end keeps advancing.
        if next.wrapping_sub(1) == self.accel.aram_end {
            next = self.accel.aram_start;
            self.accel.overflow = AccelOverflow::RawRead;
        }
        self.set_accel_current_address(next);
        Ok(value)
    }

    fn write_accel_raw(&mut self, bus: &mut dyn DspBus, value: u16) -> Result<(), DspBusFault> {
        // Hardware accepts raw writes only when the current-address high bit is set.
        if self.accel.aram_curr & (1 << 31) == 0 {
            tracing::debug!(
                "accelerator ignored raw write to 0x{:08X} without the write-enable bit",
                self.accel.aram_curr
            );
            return Ok(());
        }

        tracing::debug!(
            "accelerator writing 0x{value:04X} to ARAM 0x{:08X}",
            self.accel.aram_curr
        );

        // Raw writes are always 16-bit regardless of the configured sample size.
        let address = self.accel.aram_curr.wrapping_mul(2);
        write_aram_be_u16(bus, address, value)?;
        self.accel.aram_curr = self.accel.aram_curr.wrapping_add(1);
        self.accel.overflow = AccelOverflow::RawWrite;
        Ok(())
    }

    fn pcm_gain(&self, value: i32) -> i32 {
        value * self.accel.gain as i32
    }

    fn pcm_decode(&self, value: i32) -> i16 {
        let predictor = self.accel.predictor;
        let coeff_idx = predictor.coefficients().value();
        let coeffs = self.accel.coefficients[coeff_idx as usize];

        let acc = self.pcm_gain(value)
            + coeffs.a as i32 * self.accel.previous_samples[0] as i32
            + coeffs.b as i32 * self.accel.previous_samples[1] as i32;

        self.accel.format.divisor().apply(acc) as i16
    }

    fn adpcm_decode(&self, raw_sample: u16) -> i16 {
        let predictor = self.accel.predictor;
        let coeff_idx = predictor.coefficients().value();

        let coeffs = self.accel.coefficients[coeff_idx as usize];
        let scale = 1 << predictor.scale_log2().value();

        // ADPCM consumes the low nibble even when the configured access size is wider.
        let data = (((raw_sample & 0xf) as i8) << 4) >> 4;

        let value = scale * data as i32;
        let prediction = coeffs.a as i32 * self.accel.previous_samples[0] as i32
            + coeffs.b as i32 * self.accel.previous_samples[1] as i32;

        let result = PcmDivisor::D2048.apply(prediction) + value;
        result.clamp(i16::MIN as i32, i16::MAX as i32) as i16
    }

    fn read_accel_sample(&mut self, bus: &dyn DspBus) -> Result<i16, DspBusFault> {
        if self.accel.reads_stopped {
            return Ok(0);
        }

        let decoding = self.accel.format.decoding();
        let raw_sample = match decoding {
            SampleDecoding::AramAdpcm | SampleDecoding::AramPcm => self.read_accel_value(bus)?,
            SampleDecoding::AcinPcm | SampleDecoding::AcinPcmInc => self.accel.input as u16,
        };

        let value = match decoding {
            SampleDecoding::AramAdpcm => self.adpcm_decode(raw_sample),
            SampleDecoding::AcinPcm => self.pcm_decode(raw_sample as i16 as i32),
            SampleDecoding::AramPcm => self.pcm_decode(raw_sample as i16 as i32),
            SampleDecoding::AcinPcmInc => self.pcm_decode(raw_sample as i16 as i32),
        };

        let mut next = self.accel.aram_curr;
        let mut step_size = 2_u32;
        let mut next_predictor = None;
        match decoding {
            SampleDecoding::AramAdpcm => {
                next = next.wrapping_add(1);

                // These aligned endpoint cases bypass ACCOV and predictor loading on hardware.
                if self.accel.aram_end & 0xf == 0 && next == self.accel.aram_end {
                    next = self.accel.aram_start.wrapping_add(1);
                } else if self.accel.aram_end & 0xf == 1
                    && next == self.accel.aram_end.wrapping_sub(1)
                {
                    next = self.accel.aram_start;
                } else if next.is_multiple_of(16) {
                    next_predictor = Some(read_aram_u8(bus, (next & !15) >> 1)?);
                    next = next.wrapping_add(2);
                    step_size += 2;
                }
            }
            SampleDecoding::AcinPcm => (),
            SampleDecoding::AramPcm | SampleDecoding::AcinPcmInc => {
                next = next.wrapping_add(1);
            }
        }

        if let Some(predictor) = next_predictor {
            self.accel.predictor = AccelPredictor::from_bits(predictor as u16);
        }
        self.accel.previous_samples[1] = self.accel.previous_samples[0];
        self.accel.previous_samples[0] = value;

        if next == self.accel.aram_end.wrapping_add(step_size).wrapping_sub(1) {
            next = self.accel.aram_start;
            self.accel.reads_stopped = true;
            self.accel.overflow = AccelOverflow::Sample;
        }
        self.set_accel_current_address(next);

        Ok(value)
    }

    pub fn read_mmio(&mut self, bus: &mut dyn DspBus, offset: u8) -> u16 {
        let Some(mmio) = Mmio::from_repr(offset) else {
            return self.ifx_regs[offset as usize];
        };

        match mmio {
            // Coefficients
            _ if (0xA0..=0xAF).contains(&offset) => {
                let index = (offset as usize - 0xA0) / 2;
                if offset.is_multiple_of(2) {
                    self.accel.coefficients[index].a as u16
                } else {
                    self.accel.coefficients[index].b as u16
                }
            }

            // DMA
            Mmio::DmaControl => bus.dsp_dma().control.to_bits(),
            Mmio::DmaLength => bus.dsp_dma().length,
            Mmio::DmaDspAddr => bus.dsp_dma().dsp_base,
            Mmio::DmaRamAddrHigh => (bus.dsp_dma().ram_base >> 16) as u16,
            Mmio::DmaRamAddrLow => bus.dsp_dma().ram_base as u16,
            Mmio::DmaMasked => self.ifx_regs[offset as usize],

            // Interrupt request is a write-only action on hardware. Its generic IFX backing is
            // initialized to zero and therefore reads as zero.
            Mmio::InterruptRequest => self.ifx_regs[offset as usize],

            // Accelerator
            Mmio::AccelFormat => self.accel.format.to_bits(),
            Mmio::AccelRaw => match self.read_accel_raw(bus) {
                Ok(value) => value,
                Err(fault) => {
                    self.pending_bus_fault.get_or_insert(fault);
                    0
                }
            },
            Mmio::AccelStartAddrHigh => self.accel.aram_start.bits(16, 32) as u16,
            Mmio::AccelStartAddrLow => self.accel.aram_start.bits(0, 16) as u16,
            Mmio::AccelEndAddrHigh => self.accel.aram_end.bits(16, 32) as u16,
            Mmio::AccelEndAddrLow => self.accel.aram_end.bits(0, 16) as u16,
            Mmio::AccelCurrAddrHigh => self.accel.aram_curr.bits(16, 32) as u16,
            Mmio::AccelCurrAddrLow => self.accel.aram_curr.bits(0, 16) as u16,
            Mmio::AccelPredictor => self.accel.predictor.to_bits(),
            Mmio::AccelPrevSample0 => self.accel.previous_samples[0] as u16,
            Mmio::AccelPrevSample1 => self.accel.previous_samples[1] as u16,
            Mmio::AccelSample => match self.read_accel_sample(bus) {
                Ok(value) => value as u16,
                Err(fault) => {
                    self.pending_bus_fault.get_or_insert(fault);
                    0
                }
            },
            Mmio::AccelGain => self.accel.gain as u16,
            Mmio::AccelInput => self.accel.input as u16,

            // Mailboxes
            Mmio::DspMailboxHigh => {
                let mailbox = bus.dsp_mailbox();
                if mailbox.status() && self.is_waiting_for_dsp_mail() {
                    self.pending_stop = Some(ExecStopReason::DspMailboxFull);
                }

                mailbox.high_and_status()
            }
            Mmio::DspMailboxLow => {
                let mut mailbox = bus.dsp_mailbox();
                let low = mailbox.low();
                mailbox.set_status(false);
                bus.set_dsp_mailbox(mailbox);
                low
            }
            Mmio::CpuMailboxHigh => {
                let mailbox = bus.cpu_mailbox();
                if !mailbox.status() && self.is_waiting_for_cpu_mail() {
                    self.pending_stop = Some(ExecStopReason::CpuMailboxEmpty);
                }

                mailbox.high_and_status()
            }
            Mmio::CpuMailboxLow => {
                let mut mailbox = bus.cpu_mailbox();
                let low = mailbox.low();
                if mailbox.status() {
                    tracing::trace!("received from CPU mailbox: 0x{:08X}", mailbox.data());
                }
                mailbox.set_status(false);
                bus.set_cpu_mailbox(mailbox);
                low
            }
            _ => self.ifx_regs[offset as usize],
        }
    }

    pub fn write_mmio(&mut self, bus: &mut dyn DspBus, offset: u8, value: u16) {
        let Some(mmio) = Mmio::from_repr(offset) else {
            self.ifx_regs[offset as usize] = value;
            return;
        };

        match mmio {
            // Coefficients
            _ if (0xA0..=0xAF).contains(&offset) => {
                let index = (offset as usize - 0xA0) / 2;
                if offset.is_multiple_of(2) {
                    self.accel.coefficients[index].a = value as i16
                } else {
                    self.accel.coefficients[index].b = value as i16
                }
            }

            // DMA
            Mmio::DmaControl => {
                let mut dma = bus.dsp_dma();
                dma.control = DspDmaControl::from_bits(value);
                bus.set_dsp_dma(dma);
            }
            Mmio::DmaLength => {
                let mut dma = bus.dsp_dma();
                dma.length = value;
                if self.ifx_regs[Mmio::DmaMasked as usize] == 0 {
                    dma.control.set_transfer_ongoing(true);
                } else {
                    // Hardware consumes a masked request without performing the transfer.
                    dma.control.set_transfer_ongoing(false);
                    dma.length = 0;
                }
                bus.set_dsp_dma(dma);
            }
            Mmio::DmaDspAddr => {
                let mut dma = bus.dsp_dma();
                dma.dsp_base = value;
                bus.set_dsp_dma(dma);
            }
            Mmio::DmaRamAddrHigh => {
                let mut dma = bus.dsp_dma();
                dma.ram_base = dma.ram_base.with_bits(16, 32, value as u32);
                bus.set_dsp_dma(dma);
            }
            Mmio::DmaRamAddrLow => {
                let mut dma = bus.dsp_dma();
                dma.ram_base = dma.ram_base.with_bits(0, 16, value as u32);
                bus.set_dsp_dma(dma);
            }
            Mmio::DmaMasked => {
                self.ifx_regs[offset as usize] = value;
                self.accel.dma_masked = value != 0;
            }

            // Interrupt
            Mmio::InterruptRequest => {
                if value & 1 != 0 {
                    bus.request_cpu_interrupt();
                } else if value != 0 {
                    tracing::warn!("unknown DSP interrupt request 0x{value:04X}, ignoring")
                }
            }

            // Accelerator
            Mmio::AccelFormat => self.accel.format = AccelFormat::from_bits(value),
            Mmio::AccelRaw => {
                if let Err(fault) = self.write_accel_raw(bus, value) {
                    self.pending_bus_fault.get_or_insert(fault);
                }
            }
            Mmio::AccelStartAddrHigh => {
                self.accel.aram_start = self.accel.aram_start.with_bits(16, 32, value as u32)
                    & ACCEL_START_END_ADDRESS_MASK
            }
            Mmio::AccelStartAddrLow => {
                self.accel.aram_start = self.accel.aram_start.with_bits(0, 16, value as u32)
                    & ACCEL_START_END_ADDRESS_MASK
            }
            Mmio::AccelEndAddrHigh => {
                self.accel.aram_end = self.accel.aram_end.with_bits(16, 32, value as u32)
                    & ACCEL_START_END_ADDRESS_MASK
            }
            Mmio::AccelEndAddrLow => {
                self.accel.aram_end = self.accel.aram_end.with_bits(0, 16, value as u32)
                    & ACCEL_START_END_ADDRESS_MASK
            }
            Mmio::AccelCurrAddrHigh => {
                self.accel.aram_curr = self.accel.aram_curr.with_bits(16, 32, value as u32)
                    & ACCEL_CURRENT_ADDRESS_MASK
            }
            Mmio::AccelCurrAddrLow => {
                self.accel.aram_curr =
                    self.accel.aram_curr.with_bits(0, 16, value as u32) & ACCEL_CURRENT_ADDRESS_MASK
            }
            Mmio::AccelPredictor => {
                self.accel.predictor = AccelPredictor::from_bits(value & 0x007f)
            }
            Mmio::AccelPrevSample0 => {
                self.accel.previous_samples[0] = value as i16;
            }
            Mmio::AccelPrevSample1 => {
                self.accel.previous_samples[1] = value as i16;
                self.accel.reads_stopped = false;
            }
            Mmio::AccelSample => self.ifx_regs[offset as usize] = value,
            Mmio::AccelGain => self.accel.gain = value as i16,
            Mmio::AccelInput => self.accel.input = value as i16,

            // Mailboxes
            Mmio::DspMailboxHigh => {
                let mut mailbox = bus.dsp_mailbox();
                mailbox.set_high(value);
                bus.set_dsp_mailbox(mailbox);
            }
            Mmio::DspMailboxLow => {
                let mut mailbox = bus.dsp_mailbox();
                mailbox.set_low(value);
                mailbox.set_status(true);
                bus.set_dsp_mailbox(mailbox);
            }
            Mmio::CpuMailboxHigh => {
                let mut mailbox = bus.cpu_mailbox();
                mailbox.set_high(value);
                bus.set_cpu_mailbox(mailbox);
            }
            Mmio::CpuMailboxLow => {
                let mut mailbox = bus.cpu_mailbox();
                mailbox.set_low(value);
                mailbox.set_status(true);
                bus.set_cpu_mailbox(mailbox);
            }
            _ => self.ifx_regs[offset as usize] = value,
        }
    }

    /// Reads from data memory.
    pub fn read_dmem(&mut self, bus: &mut dyn DspBus, addr: u16) -> u16 {
        match addr >> 12 {
            0x0 => self.mem.dram[addr as usize & (DRAM_LEN - 1)],
            0x1 => self.mem.coef[addr as usize & (COEF_LEN - 1)],
            0xf => self.read_mmio(bus, addr as u8),
            _ => 0,
        }
    }

    /// Writes to data memory.
    pub fn write_dmem(&mut self, bus: &mut dyn DspBus, addr: u16, value: u16) {
        match addr >> 12 {
            0x0 => self.mem.dram[addr as usize & (DRAM_LEN - 1)] = value,
            0xf => self.write_mmio(bus, addr as u8, value),
            // Coefficient ROM and all unmapped regions ignore writes.
            _ => (),
        }
    }

    /// Reads from instruction memory.
    #[inline(always)]
    pub fn try_read_imem(&mut self, addr: u16) -> Option<u16> {
        match addr {
            0x0000..0x1000 => Some(self.mem.iram[addr as usize]),
            0x8000..0x9000 => {
                std::hint::cold_path();
                Some(self.mem.irom[addr as usize - 0x8000])
            }
            _ => None,
        }
    }

    /// Reads from instruction memory.
    #[inline(always)]
    pub fn read_imem(&mut self, addr: u16) -> u16 {
        self.try_read_imem(addr).unwrap_or(0)
    }

    /// Writes to instruction memory.
    #[inline(always)]
    pub fn write_imem(&mut self, addr: u16, value: u16) {
        match addr {
            0x0000..0x1000 => {
                self.mem.iram[addr as usize] = value;
                self.cached[addr as usize] = None;

                // A two-word instruction caches its immediate with the opcode, so changing only
                // the second word must invalidate the instruction that starts immediately before
                // it as well.
                let predecessor = addr.wrapping_sub(1) as usize;
                if self.cached[predecessor].is_some_and(|instruction| instruction.len == 2) {
                    self.cached[predecessor] = None;
                }
            }
            _ => panic!("out of range write to imem"),
        }
    }

    fn is_waiting_for_cpu_mail_inner(&mut self, offset: i16) -> bool {
        let start = self.pc.wrapping_add_signed(offset);
        let pattern_a = [
            // lrs   $ACM0, @cmbh
            0b0010_0110_1111_1110,
            // andcf $ACM0, #0x8000
            0b0000_0010_1100_0000,
            0x8000,
            // jlnz	 start
            0b0000_0010_1001_1100,
            start,
        ];

        let pattern_b = [
            // lrs   $ACM1, @cmbh
            0b0010_0111_1111_1110,
            // andcf $ACM1, #0x8000
            0b0000_0011_1100_0000,
            0x8000,
            // jlnz	 start
            0b0000_0010_1001_1100,
            start,
        ];

        let current = [
            self.try_read_imem(start),
            self.try_read_imem(start.wrapping_add(1)),
            self.try_read_imem(start.wrapping_add(2)),
            self.try_read_imem(start.wrapping_add(3)),
            self.try_read_imem(start.wrapping_add(4)),
        ];

        let Some(current) = current.try_map(|x| x) else {
            return false;
        };

        current == pattern_a || current == pattern_b
    }

    #[inline(always)]
    pub fn is_waiting_for_cpu_mail(&mut self) -> bool {
        self.is_waiting_for_cpu_mail_inner(0)
            || self.is_waiting_for_cpu_mail_inner(-1)
            || self.is_waiting_for_cpu_mail_inner(-3)
    }

    fn is_waiting_for_dsp_mail_inner(&mut self, offset: i16) -> bool {
        let start = self.pc.wrapping_add_signed(offset);
        let pattern_a = [
            // lrs   $ACM0, @dmbh
            0b0010_0110_1111_1100,
            // andcf $ACM0, #0x8000
            0b0000_0010_1100_0000,
            0x8000,
            // jlz	 start
            0b0000_0010_1001_1101,
            start,
        ];

        let pattern_b = [
            // lrs   $ACM1, @dmbh
            0b0010_0111_1111_1100,
            // andcf $ACM1, #0x8000
            0b0000_0011_1100_0000,
            0x8000,
            // jlz	 start
            0b0000_0010_1001_1101,
            start,
        ];

        let mut read_imem = |addr| self.try_read_imem(addr).unwrap_or(0);
        let current = [
            read_imem(start),
            read_imem(start.wrapping_add(1)),
            read_imem(start.wrapping_add(2)),
            read_imem(start.wrapping_add(3)),
            read_imem(start.wrapping_add(4)),
        ];

        current == pattern_a || current == pattern_b
    }

    #[inline(always)]
    pub fn is_waiting_for_dsp_mail(&mut self) -> bool {
        self.is_waiting_for_dsp_mail_inner(0)
            || self.is_waiting_for_dsp_mail_inner(-1)
            || self.is_waiting_for_dsp_mail_inner(-3)
    }

    fn fetch_decode_and_cache(&mut self, address: u16) -> CachedIns {
        // fetch
        let mut ins = Ins::new(self.read_imem(address));

        // decode
        let decoded = ins.decoded();
        let extra = decoded
            .needs_extra
            .then_some(self.read_imem(address.wrapping_add(1)));

        let len = if let Some(extra) = extra {
            ins.extra = extra;
            2
        } else {
            1
        };

        let main = OPCODE_EXEC_LUT[decoded.opcode as usize];
        let extension = decoded
            .extension
            .map(|extension| EXTENSION_EXEC_LUT[extension as usize]);

        // cache
        let cached = CachedIns {
            ins,
            len,
            main,
            extension,
        };
        self.cached[address as usize] = Some(cached);

        cached
    }

    #[inline(always)]
    fn cached_instruction_at(&mut self, address: u16) -> CachedIns {
        if let Some(cached) = self.cached[address as usize] {
            cached
        } else {
            std::hint::cold_path();
            self.fetch_decode_and_cache(address)
        }
    }

    #[inline(always)]
    fn skip_instruction(&mut self) {
        let instruction = self.cached_instruction_at(self.pc);
        self.pc = self.pc.wrapping_add(instruction.len);
    }

    pub fn exec(&mut self, bus: &mut dyn DspBus, instructions: u32) -> ExecOutcome {
        self.pending_stop = None;
        self.pending_bus_fault = None;

        // Validate the complete physical ARAM mapping once per execution slice. All accelerator
        // accesses below mask to this 16 MiB window, so a conforming host cannot fault midway
        // through an instruction and the hot loop needs no rollback snapshots.
        if let Err(fault) = validate_aram(bus) {
            std::hint::cold_path();
            return ExecOutcome {
                executed_instructions: 0,
                stop_reason: ExecStopReason::BusFault(fault),
            };
        }

        if let Err(fault) = self.check_reset(bus) {
            std::hint::cold_path();
            return ExecOutcome {
                executed_instructions: 0,
                stop_reason: ExecStopReason::BusFault(fault),
            };
        }

        let mut executed_instructions = 0;
        while executed_instructions < instructions {
            if bus.dsp_control().halted {
                std::hint::cold_path();
                return ExecOutcome {
                    executed_instructions,
                    stop_reason: ExecStopReason::Halted,
                };
            }

            if let Err(fault) = self.do_dma(bus) {
                std::hint::cold_path();
                return ExecOutcome {
                    executed_instructions,
                    stop_reason: ExecStopReason::BusFault(fault),
                };
            }
            if let Some(fault) = self.pending_bus_fault.take() {
                std::hint::cold_path();
                return ExecOutcome {
                    executed_instructions,
                    stop_reason: ExecStopReason::BusFault(fault),
                };
            }
            self.check_interrupts(bus);

            // Instruction handlers observe the post-fetch PC, like the hardware. This makes
            // branch targets and return addresses natural values instead of pre-adjusted ones.
            let ins = self.cached_instruction_at(self.pc);
            self.pc = self.pc.wrapping_add(ins.len);

            // execute
            if let Some(extension) = ins.extension {
                let regs_previous = ExtensionRegisters::capture(&self.regs);
                (ins.main)(self, bus, ins.ins);
                if let Some(fault) = self.pending_bus_fault.take() {
                    std::hint::cold_path();
                    return ExecOutcome {
                        executed_instructions,
                        stop_reason: ExecStopReason::BusFault(fault),
                    };
                }
                (extension)(self, bus, ins.ins, &regs_previous);
            } else {
                (ins.main)(self, bus, ins.ins);
            }

            if let Some(fault) = self.pending_bus_fault.take() {
                std::hint::cold_path();
                return ExecOutcome {
                    executed_instructions,
                    stop_reason: ExecStopReason::BusFault(fault),
                };
            }

            executed_instructions += 1;
            self.check_loop();

            // HALT retires, but hardware leaves the program counter on it.
            if bus.dsp_control().halted {
                std::hint::cold_path();
                return ExecOutcome {
                    executed_instructions,
                    stop_reason: ExecStopReason::Halted,
                };
            }

            if let Some(stop_reason) = self.pending_stop.take() {
                std::hint::cold_path();
                return ExecOutcome {
                    executed_instructions,
                    stop_reason,
                };
            }
        }

        ExecOutcome {
            executed_instructions,
            stop_reason: ExecStopReason::InstructionBudgetExhausted,
        }
    }

    pub fn step(&mut self, bus: &mut dyn DspBus) -> ExecOutcome {
        self.exec(bus, 1)
    }
}

#[cfg(test)]
mod tests {
    use super::{ExtensionRegisters, Product, Registers};

    #[test]
    fn extension_snapshot_excludes_hardware_stack_storage() {
        assert!(std::mem::size_of::<ExtensionRegisters>() * 2 < std::mem::size_of::<Registers>());
    }

    #[test]
    fn product_resolution_preserves_the_carry_save_middle_lane() {
        let no_carry = Product {
            low: 0x0002,
            mid1: 0x7FFE,
            mid2: 0,
            high: 0,
        }
        .resolve();
        let latent_carry = Product {
            low: 0x0002,
            mid1: 0xFFFF,
            mid2: 0x7FFF,
            high: 0xFF,
        }
        .resolve();

        assert_eq!(no_carry.value, 0x007F_FE00_02);
        assert_eq!(latent_carry.value, no_carry.value);
        assert!(!no_carry.mid_carry);
        assert!(!no_carry.carry);
        assert!(latent_carry.mid_carry);
        assert!(latent_carry.carry);
        assert!(!latent_carry.overflow);
    }

    #[test]
    fn product_resolution_reports_overflow_and_the_clrp_sentinel() {
        let overflow = Product {
            low: 0,
            mid1: 0xFFFF,
            mid2: 1,
            high: 0x7F,
        }
        .resolve();
        assert_eq!(overflow.value, -(1 << 39));
        assert!(overflow.mid_carry);
        assert!(!overflow.carry);
        assert!(overflow.overflow);

        let cleared = Product {
            low: 0,
            mid1: 0xFFF0,
            mid2: 0x0010,
            high: 0xFF,
        }
        .resolve();
        assert_eq!(cleared.value, 0);
        assert!(cleared.mid_carry);
        assert!(cleared.carry);
        assert!(!cleared.overflow);
    }
}
