//! Command processor (CP).
pub mod attributes;

use attributes::{ColorFormat, CoordsFormat, VertexAttributeTable};
use bitos::integer::u3;
use bitos::{BitUtils, bitos};
use gekko::Address;
use strum::FromRepr;
use zerocopy::IntoBytes;

use crate::Primitive;
use crate::stream::{BinRingBuffer, BinaryStream};
use crate::system::gx::cmd::attributes::{AttributeDescriptor, AttributeMode};
use crate::system::gx::{self, Gpu, Reg as GxReg, Topology};
use crate::system::mem::RAM_LEN;
use crate::system::{System, pi};

/// A command processor register.
#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRepr)]
#[repr(u8)]
pub enum Reg {
    Unknown00       = 0x00,
    Unknown10       = 0x10,
    Unknown20       = 0x20,

    MatIndexLow     = 0x30,
    MatIndexHigh    = 0x40,

    // VCD
    VcdLow          = 0x50,
    VcdHigh         = 0x60,

    // VAT
    Vat0A           = 0x70,
    Vat1A           = 0x71,
    Vat2A           = 0x72,
    Vat3A           = 0x73,
    Vat4A           = 0x74,
    Vat5A           = 0x75,
    Vat6A           = 0x76,
    Vat7A           = 0x77,

    Vat0B           = 0x80,
    Vat1B           = 0x81,
    Vat2B           = 0x82,
    Vat3B           = 0x83,
    Vat4B           = 0x84,
    Vat5B           = 0x85,
    Vat6B           = 0x86,
    Vat7B           = 0x87,

    Vat0C           = 0x90,
    Vat1C           = 0x91,
    Vat2C           = 0x92,
    Vat3C           = 0x93,
    Vat4C           = 0x94,
    Vat5C           = 0x95,
    Vat6C           = 0x96,
    Vat7C           = 0x97,

    // Array Base
    PositionPtr     = 0xA0,
    NormalPtr       = 0xA1,
    Chan0Ptr        = 0xA2,
    Chan1Ptr        = 0xA3,
    Tex0CoordPtr    = 0xA4,
    Tex1CoordPtr    = 0xA5,
    Tex2CoordPtr    = 0xA6,
    Tex3CoordPtr    = 0xA7,
    Tex4CoordPtr    = 0xA8,
    Tex5CoordPtr    = 0xA9,
    Tex6CoordPtr    = 0xAA,
    Tex7CoordPtr    = 0xAB,
    GpArr0Ptr       = 0xAC,
    GpArr1Ptr       = 0xAD,
    GpArr2Ptr       = 0xAE,
    GpArr3Ptr       = 0xAF,

    // Array Stride
    PositionStride  = 0xB0,
    NormalStride    = 0xB1,
    Chan0Stride     = 0xB2,
    Chan1Stride     = 0xB3,
    Tex0CoordStride = 0xB4,
    Tex1CoordStride = 0xB5,
    Tex2CoordStride = 0xB6,
    Tex3CoordStride = 0xB7,
    Tex4CoordStride = 0xB8,
    Tex5CoordStride = 0xB9,
    Tex6CoordStride = 0xBA,
    Tex7CoordStride = 0xBB,
    GpArr0Stride    = 0xBC,
    GpArr1Stride    = 0xBD,
    GpArr2Stride    = 0xBE,
    GpArr3Stride    = 0xBF,
}

impl Reg {
    pub fn is_matrices_index(self) -> bool {
        matches!(self, Self::MatIndexLow | Self::MatIndexHigh)
    }
}

#[bitos(5)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Operation {
    #[default]
    NOP               = 0b0_0000,
    SetCP             = 0b0_0001,
    SetXF             = 0b0_0010,
    IndexedSetXFA     = 0b0_0100,
    IndexedSetXFB     = 0b0_0101,
    IndexedSetXFC     = 0b0_0110,
    IndexedSetXFD     = 0b0_0111,
    Call              = 0b0_1000,
    InvalidateVertexCache = 0b0_1001,
    SetBP             = 0b0_1100,
    DrawQuadList      = 0b1_0000,
    DrawTriangleList  = 0b1_0010,
    DrawTriangleStrip = 0b1_0011,
    DrawTriangleFan   = 0b1_0100,
    DrawLineList      = 0b1_0101,
    DrawLineStrip     = 0b1_0110,
    DrawPointList     = 0b1_0111,
}

#[bitos(8)]
#[derive(Debug)]
pub struct Opcode {
    #[bits(0..3)]
    pub vat_index: u3,
    #[bits(3..8)]
    pub operation: Option<Operation>,
}

#[derive(Debug)]
pub enum Command {
    Nop,
    InvalidateVertexCache,
    Call {
        address: Address,
        length: u32,
    },
    SetCP {
        register: Reg,
        value: u32,
    },
    SetBP {
        register: GxReg,
        value: u32,
    },
    SetXF {
        start: u16,
        values: Vec<u32>,
    },
    IndexedSetXFA {
        base: u16,
        length: u8,
        index: u16,
    },
    IndexedSetXFB {
        base: u16,
        length: u8,
        index: u16,
    },
    IndexedSetXFC {
        base: u16,
        length: u8,
        index: u16,
    },
    IndexedSetXFD {
        base: u16,
        length: u8,
        index: u16,
    },
    Draw {
        topology: Topology,
        vertex_attributes: VertexAttributeStream,
    },
}

/// CP status register
#[bitos(16)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Status {
    #[bits(0)]
    pub fifo_overflow: bool,
    #[bits(1)]
    pub fifo_underflow: bool,
    #[bits(2)]
    pub read_idle: bool,
    #[bits(3)]
    pub write_idle: bool,
    #[bits(4)]
    pub breakpoint_interrupt: bool,
}

/// CP control register
#[bitos(16)]
#[derive(Debug, Clone, Copy)]
pub struct Control {
    #[bits(0)]
    pub fifo_read_enable: bool,
    #[bits(1)]
    pub fifo_breakpoint_enable: bool,
    #[bits(2)]
    pub fifo_overflow_interrupt_enable: bool,
    #[bits(3)]
    pub fifo_underflow_interrupt_enable: bool,
    #[bits(4)]
    pub linked_mode: bool,
    #[bits(5)]
    pub fifo_breakpoint_interrupt_enable: bool,
}

impl Default for Control {
    fn default() -> Self {
        Self::from_bits(0).with_linked_mode(true)
    }
}

const FIFO_BURST_BYTES: u32 = 32;
const FIFO_SERVICE_BUDGET_BYTES: u32 = 256 * 1024;

#[derive(Debug, Clone, Default)]
pub struct Fifo {
    pub start: Address,
    pub end: Address,
    pub high_mark: u32,
    pub low_mark: u32,
    /// Guest-visible FIFO distance. Pointer equality cannot distinguish an empty FIFO from a full
    /// one, so this register is authoritative rather than derived from the pointers.
    pub distance: u32,
    pub write_ptr: Address,
    pub read_ptr: Address,
    pub breakpoint: Address,
}

impl Fifo {
    /// The FIFO count.
    pub fn count(&self) -> u32 {
        self.distance
    }

    pub fn set_count(&mut self, count: u32) {
        self.distance = count;
    }

    fn span_bytes(&self) -> Option<u32> {
        self.end
            .value()
            .checked_sub(self.start.value())?
            .checked_add(FIFO_BURST_BYTES)
    }

    /// Returns the FIFO span only when every burst is backed by physical MEM1.
    fn ram_backed_span_bytes(&self) -> Option<u32> {
        let span = self.span_bytes()?;
        self.start
            .value()
            .checked_add(span)
            .is_some_and(|end| end <= RAM_LEN as u32)
            .then_some(span)
    }

    fn service_state_valid(&self) -> bool {
        let Some(span) = self.ram_backed_span_bytes() else {
            return false;
        };
        self.start.value().is_multiple_of(FIFO_BURST_BYTES)
            && self.end.value().is_multiple_of(FIFO_BURST_BYTES)
            && self.write_ptr.value().is_multiple_of(FIFO_BURST_BYTES)
            && self.read_ptr.value().is_multiple_of(FIFO_BURST_BYTES)
            && self.write_ptr >= self.start
            && self.write_ptr <= self.end
            && self.read_ptr >= self.start
            && self.read_ptr <= self.end
            && self.distance.is_multiple_of(FIFO_BURST_BYTES)
            && self.distance <= span
    }

    /// Recovers the exact signed `write - read` artifact published by some GX FIFO objects.
    ///
    /// Every predicate is provenance: an arbitrary oversized guest distance must remain invalid.
    fn normalize_signed_distance(&mut self) -> bool {
        let raw_distance = self.distance;
        let Some(span) = self.ram_backed_span_bytes() else {
            return false;
        };
        if span == 0
            || raw_distance <= span
            || !span.is_multiple_of(FIFO_BURST_BYTES)
            || !raw_distance.is_multiple_of(FIFO_BURST_BYTES)
            || self.write_ptr < self.start
            || self.write_ptr > self.end
            || self.read_ptr < self.start
            || self.read_ptr > self.end
            || self.write_ptr >= self.read_ptr
        {
            return false;
        }

        let masked_pointer_delta =
            self.write_ptr.value().wrapping_sub(self.read_ptr.value()) & 0x03ff_ffe0;
        if raw_distance != masked_pointer_delta {
            return false;
        }

        let pointer_distance = self.read_ptr.value() - self.write_ptr.value();
        let Some(normalized_distance) = span.checked_sub(pointer_distance) else {
            return false;
        };
        if normalized_distance > span || !normalized_distance.is_multiple_of(FIFO_BURST_BYTES) {
            return false;
        }

        self.distance = normalized_distance;
        true
    }

    pub(crate) fn can_append_burst(&self) -> bool {
        let Some(span) = self.ram_backed_span_bytes() else {
            return false;
        };
        let Some(distance) = self.distance.checked_add(FIFO_BURST_BYTES) else {
            return false;
        };
        self.start.value().is_multiple_of(FIFO_BURST_BYTES)
            && self.end.value().is_multiple_of(FIFO_BURST_BYTES)
            && self.write_ptr.value().is_multiple_of(FIFO_BURST_BYTES)
            && self.write_ptr >= self.start
            && self.write_ptr <= self.end
            && self.distance.is_multiple_of(FIFO_BURST_BYTES)
            && distance <= span
    }

    pub(crate) fn append_burst(&mut self) -> bool {
        if !self.can_append_burst() {
            return false;
        }
        let distance = self.distance + FIFO_BURST_BYTES;
        self.distance = distance;
        true
    }
}

/// Describes which attributes are present in the vertices of primitives and how they are present.
#[bitos(64)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct VertexDescriptor {
    /// Whether the position/normal matrix index is present.
    #[bits(0)]
    pub pos_mtx_index: bool,
    /// Whether the texture coordinate matrix N index is present.
    #[bits(1..9)]
    pub tex_coord_mtx_index: [bool; 8],
    /// Whether the position attribute is present.
    #[bits(9..11)]
    pub position: AttributeMode,
    /// Whether the normal attribute is present.
    #[bits(11..13)]
    pub normal: AttributeMode,
    /// Whether the color channel 0 attribute is present.
    #[bits(13..15)]
    pub chan0: AttributeMode,
    /// Whether the color channel 1 attribute is present.
    #[bits(15..17)]
    pub chan1: AttributeMode,
    /// Whether the texture coordinate N attribute is present.
    #[bits(32..48)]
    pub tex_coord: [AttributeMode; 8],
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ArrayDescriptor {
    pub address: Address,
    pub stride: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Arrays {
    pub position: ArrayDescriptor,
    pub normal: ArrayDescriptor,
    pub chan0: ArrayDescriptor,
    pub chan1: ArrayDescriptor,
    pub tex_coords: [ArrayDescriptor; 8],
    pub general_purpose: [ArrayDescriptor; 4],
}

#[derive(Debug, Clone, Default)]
pub struct Internal {
    pub vertex_descriptor: VertexDescriptor,
    pub vertex_attr_tables: [VertexAttributeTable; 8],
    pub arrays: Arrays,
}

impl Internal {
    fn vertex_formats_valid(&self, vat: u8) -> bool {
        fn coords_valid(format: CoordsFormat) -> bool {
            matches!(
                format,
                CoordsFormat::U8
                    | CoordsFormat::I8
                    | CoordsFormat::U16
                    | CoordsFormat::I16
                    | CoordsFormat::F32
            )
        }

        fn color_valid(format: ColorFormat) -> bool {
            matches!(
                format,
                ColorFormat::Rgb565
                    | ColorFormat::Rgb888
                    | ColorFormat::Rgb888x
                    | ColorFormat::Rgba4444
                    | ColorFormat::Rgba6666
                    | ColorFormat::Rgba8888
            )
        }

        let Some(table) = self.vertex_attr_tables.get(vat as usize) else {
            return false;
        };
        let descriptor = self.vertex_descriptor;
        if descriptor.position().is_present() && !coords_valid(table.a.position().format()) {
            return false;
        }
        if descriptor.normal().is_present() && !coords_valid(table.a.normal().format()) {
            return false;
        }
        if descriptor.chan0().is_present() && !color_valid(table.a.chan0().format()) {
            return false;
        }
        if descriptor.chan1().is_present() && !color_valid(table.a.chan1().format()) {
            return false;
        }

        for index in 0..8 {
            let Some(mode) = descriptor.tex_coord_at(index) else {
                return false;
            };
            let Some(texture) = table.tex(index) else {
                return false;
            };
            if mode.is_present() && !coords_valid(texture.format()) {
                return false;
            }
        }

        true
    }

    /// Computes a native decoder stride only for a fully supported VAT.
    pub fn checked_vertex_size(&self, vat: u8) -> Option<u32> {
        self.vertex_formats_valid(vat)
            .then(|| self.vertex_size(vat))
    }

    pub fn vertex_size(&self, vat: u8) -> u32 {
        let vat = vat as usize;

        let mut size = 0;
        if self.vertex_descriptor.pos_mtx_index() {
            size += 1;
        }

        for i in 0..8 {
            if self.vertex_descriptor.tex_coord_mtx_index_at(i).unwrap() {
                size += 1;
            }
        }

        size += self
            .vertex_descriptor
            .position()
            .size()
            .unwrap_or_else(|| self.vertex_attr_tables[vat].a.position().size());

        size += self
            .vertex_descriptor
            .normal()
            .size()
            .unwrap_or_else(|| self.vertex_attr_tables[vat].a.normal().size());

        size += self
            .vertex_descriptor
            .chan0()
            .size()
            .unwrap_or_else(|| self.vertex_attr_tables[vat].a.chan0().size());

        size += self
            .vertex_descriptor
            .chan1()
            .size()
            .unwrap_or_else(|| self.vertex_attr_tables[vat].a.chan1().size());

        for i in 0..8 {
            size += self
                .vertex_descriptor
                .tex_coord_at(i)
                .unwrap()
                .size()
                .unwrap_or_else(|| self.vertex_attr_tables[vat].tex(i).unwrap().size());
        }

        size
    }
}

#[derive(Debug, Clone)]
pub struct VertexAttributeStream {
    table: u8,
    count: u16,
    data: Vec<u8>,
}

impl VertexAttributeStream {
    pub fn table_index(&self) -> usize {
        self.table as usize
    }

    pub fn count(&self) -> u16 {
        self.count
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    pub fn stride(&self) -> usize {
        self.data.len() / self.count as usize
    }
}

/// Identity of the most recent guest PI FIFO reset observed by the CP interface.
///
/// The value is diagnostic only and may wrap. Consumers that must not miss a reset should use
/// [`Interface::take_resident_fifo_reset`] instead of comparing generations: its independent
/// pending latch remains asserted across generation wrap and deliberately coalesces repeated,
/// idempotent resets until they are taken.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FifoResetGeneration(u64);

impl FifoResetGeneration {
    pub const fn value(self) -> u64 {
        self.0
    }
}

/// CP interface
#[derive(Debug, Default)]
pub struct Interface {
    pub status: Status,
    pub control: Control,
    pub fifo: Fifo,
    pub internal: Internal,
    pub queue: BinRingBuffer,
    resident_fifo_reset_generation: FifoResetGeneration,
    resident_fifo_reset_pending: bool,
    native_decode_faulted: bool,
}

impl Interface {
    /// Returns the diagnostic generation of the most recent guest PI FIFO reset.
    pub const fn resident_fifo_reset_generation(&self) -> FifoResetGeneration {
        self.resident_fifo_reset_generation
    }

    /// Whether a resident semantic decoder still needs to observe a guest PI FIFO reset.
    pub const fn resident_fifo_reset_pending(&self) -> bool {
        self.resident_fifo_reset_pending
    }

    /// Takes the reset notification for a resident semantic decoder, if one is pending.
    ///
    /// Multiple resets before a take coalesce because resetting the decoder is idempotent. The
    /// independent pending latch makes delivery fail closed even when the diagnostic generation
    /// wraps back to a value a consumer has seen before.
    pub fn take_resident_fifo_reset(&mut self) -> Option<FifoResetGeneration> {
        if !std::mem::take(&mut self.resident_fifo_reset_pending) {
            return None;
        }

        Some(self.resident_fifo_reset_generation)
    }

    pub(crate) fn record_resident_fifo_reset(&mut self) {
        self.resident_fifo_reset_generation.0 =
            self.resident_fifo_reset_generation.0.wrapping_add(1);
        self.resident_fifo_reset_pending = true;
    }

    /// Whether the legacy native decoder rejected malformed guest FIFO bytes.
    ///
    /// The browser-resident path owns a separate bounded semantic decoder. This latch prevents a
    /// native fallback from repeatedly interpreting bytes after it has lost command framing.
    pub const fn native_decode_faulted(&self) -> bool {
        self.native_decode_faulted
    }

    fn record_native_decode_fault(&mut self) {
        self.queue = BinRingBuffer::default();
        self.native_decode_faulted = true;
    }

    pub(crate) fn reset_native_decode_fault(&mut self) {
        self.queue = BinRingBuffer::default();
        self.native_decode_faulted = false;
    }

    pub fn breakpoint_level(&self) -> bool {
        self.control.fifo_breakpoint_enable() && self.fifo.read_ptr == self.fifo.breakpoint
    }

    /// Whether a resident service pass can move at least one architected 32-byte FIFO burst.
    /// Disabled reads, an asserted breakpoint, and malformed producer state are stable CP states,
    /// not renderer work that may indefinitely fence an EFB aperture load.
    pub fn resident_fifo_drainable(&self) -> bool {
        if self.native_decode_faulted
            || self.fifo.distance == 0
            || !self.control.fifo_read_enable()
            || self.breakpoint_level()
        {
            return false;
        }
        let mut fifo = self.fifo.clone();
        fifo.normalize_signed_distance();
        fifo.service_state_valid() && fifo.distance >= FIFO_BURST_BYTES
    }

    /// Returns the live CP status without sticky interrupt-source state.
    pub fn raw_status(&self) -> Status {
        let empty = self.fifo.distance == 0;
        let breakpoint = self.breakpoint_level();
        let read_enabled = self.control.fifo_read_enable();

        Status::default()
            .with_fifo_overflow(self.fifo.distance > self.fifo.high_mark)
            .with_fifo_underflow(self.fifo.distance < self.fifo.low_mark)
            .with_read_idle(empty)
            .with_write_idle(empty || !read_enabled || breakpoint)
            .with_breakpoint_interrupt(breakpoint)
    }

    /// Returns guest-visible CP status, including retained high/low interrupt sources.
    pub fn read_status(&self) -> Status {
        let raw = self.raw_status();
        raw.with_fifo_overflow(raw.fifo_overflow() || self.status.fifo_overflow())
            .with_fifo_underflow(raw.fifo_underflow() || self.status.fifo_underflow())
    }

    /// Returns the currently qualified raw interrupt sources.
    pub fn qualified_sources(&self) -> Status {
        if !self.control.fifo_read_enable() {
            return Status::default();
        }

        let raw = self.raw_status();
        Status::default()
            .with_fifo_overflow(raw.fifo_overflow())
            .with_fifo_underflow(raw.fifo_underflow())
            .with_breakpoint_interrupt(raw.breakpoint_interrupt())
    }

    /// Samples raw watermark levels into their sticky source latches.
    pub fn refresh_interrupt_latches(&mut self) {
        let qualified = self.qualified_sources();
        if qualified.fifo_overflow() {
            self.status.set_fifo_overflow(true);
        }
        if qualified.fifo_underflow() {
            self.status.set_fifo_underflow(true);
        }
    }

    /// Whether CP is currently requesting its PI interrupt source.
    pub fn interrupt_active(&self) -> bool {
        self.control.fifo_read_enable()
            && ((self.control.fifo_overflow_interrupt_enable() && self.status.fifo_overflow())
                || (self.control.fifo_underflow_interrupt_enable() && self.status.fifo_underflow())
                || (self.control.fifo_breakpoint_interrupt_enable() && self.breakpoint_level()))
    }

    /// Write a value to the clear register.
    pub fn write_clear(&mut self, value: u16) {
        if value.bit(0) {
            self.status.set_fifo_overflow(false);
        }

        if value.bit(1) {
            self.status.set_fifo_underflow(false);
        }

        // A still-live raw level immediately reasserts its source after acknowledgement.
        self.refresh_interrupt_latches();
    }
}

impl Gpu {
    /// Reads a command from the command queue.
    pub fn read_command(&mut self) -> Option<Command> {
        let mut reader = self.cmd.queue.reader();

        let opcode = Opcode::from_bits(reader.read_be()?);
        let Some(operation) = opcode.operation() else {
            tracing::warn!(opcode = opcode.0, "rejecting unknown native GX opcode");
            reader.finish();
            self.cmd.record_native_decode_fault();
            return None;
        };

        let command = match operation {
            Operation::NOP => Command::Nop,
            Operation::SetCP => {
                let register = reader.read_be::<u8>()?;
                let value = reader.read_be::<u32>()?;

                let Some(register) = Reg::from_repr(register) else {
                    tracing::warn!(register, "rejecting unknown native CP register");
                    reader.finish();
                    self.cmd.record_native_decode_fault();
                    return None;
                };

                Command::SetCP { register, value }
            }
            Operation::SetXF => {
                let length = reader.read_be::<u16>()? as u32 + 1;
                if reader.remaining() < 4 * length as usize {
                    return None;
                }

                let start = reader.read_be::<u16>()?;
                let mut values = Vec::with_capacity(length as usize);
                for _ in 0..length {
                    values.push(reader.read_be::<u32>()?);
                }

                Command::SetXF { start, values }
            }
            Operation::IndexedSetXFA => {
                let config = reader.read_be::<u32>()?;
                let base = config.bits(0, 12) as u16;
                let length = config.bits(12, 16) as u8 + 1;
                let index = config.bits(16, 32) as u16;

                Command::IndexedSetXFA {
                    base,
                    length,
                    index,
                }
            }
            Operation::IndexedSetXFB => {
                let config = reader.read_be::<u32>()?;
                let base = config.bits(0, 12) as u16;
                let length = config.bits(12, 16) as u8 + 1;
                let index = config.bits(16, 32) as u16;

                Command::IndexedSetXFB {
                    base,
                    length,
                    index,
                }
            }
            Operation::IndexedSetXFC => {
                let config = reader.read_be::<u32>()?;
                let base = config.bits(0, 12) as u16;
                let length = config.bits(12, 16) as u8 + 1;
                let index = config.bits(16, 32) as u16;

                Command::IndexedSetXFC {
                    base,
                    length,
                    index,
                }
            }
            Operation::IndexedSetXFD => {
                let config = reader.read_be::<u32>()?;
                let base = config.bits(0, 12) as u16;
                let length = config.bits(12, 16) as u8 + 1;
                let index = config.bits(16, 32) as u16;

                Command::IndexedSetXFD {
                    base,
                    length,
                    index,
                }
            }
            Operation::Call => {
                let address = Address(reader.read_be::<u32>()?);
                let length = reader.read_be::<u32>()?;

                Command::Call { address, length }
            }
            Operation::InvalidateVertexCache => Command::InvalidateVertexCache,
            Operation::SetBP => {
                let register = reader.read_be::<u8>()?;
                let value = u32::from_be_bytes([
                    0,
                    reader.read_be::<u8>()?,
                    reader.read_be::<u8>()?,
                    reader.read_be::<u8>()?,
                ]);

                let Some(register) = GxReg::from_repr(register) else {
                    tracing::warn!(register, "rejecting unknown native BP register");
                    reader.finish();
                    self.cmd.record_native_decode_fault();
                    return None;
                };

                Command::SetBP { register, value }
            }
            Operation::DrawQuadList
            | Operation::DrawTriangleList
            | Operation::DrawTriangleStrip
            | Operation::DrawTriangleFan
            | Operation::DrawLineList
            | Operation::DrawLineStrip
            | Operation::DrawPointList => {
                let vertex_count = reader.read_be::<u16>()?;
                let Some(vertex_size) = self
                    .cmd
                    .internal
                    .checked_vertex_size(opcode.vat_index().value())
                else {
                    tracing::warn!(
                        vat = opcode.vat_index().value(),
                        "rejecting reserved native GX vertex format"
                    );
                    reader.finish();
                    self.cmd.record_native_decode_fault();
                    return None;
                };

                let Some(attribute_stream_size) =
                    (vertex_count as usize).checked_mul(vertex_size as usize)
                else {
                    tracing::warn!("rejecting overflowing native GX vertex stream");
                    reader.finish();
                    self.cmd.record_native_decode_fault();
                    return None;
                };
                if reader.remaining() < attribute_stream_size {
                    return None;
                }

                let vertex_attributes = reader.read_bytes(attribute_stream_size)?;
                let vertex_attributes = VertexAttributeStream {
                    table: opcode.vat_index().value(),
                    count: vertex_count,
                    data: vertex_attributes,
                };

                let topology = match operation {
                    Operation::DrawQuadList => Topology::QuadList,
                    Operation::DrawTriangleList => Topology::TriangleList,
                    Operation::DrawTriangleStrip => Topology::TriangleStrip,
                    Operation::DrawTriangleFan => Topology::TriangleFan,
                    Operation::DrawLineList => Topology::LineList,
                    Operation::DrawLineStrip => Topology::LineStrip,
                    Operation::DrawPointList => Topology::PointList,
                    _ => unreachable!(),
                };

                Command::Draw {
                    topology,
                    vertex_attributes,
                }
            }
        };

        reader.finish();
        Some(command)
    }
}

/// Sets the value of an internal command processor register.
pub fn set_register(sys: &mut System, reg: Reg, value: u32) {
    let cp = &mut sys.gpu.cmd.internal;
    let xf = &mut sys.gpu.xform.internal;

    match reg {
        Reg::MatIndexLow => value.write_ne_bytes(&mut xf.default_matrices.as_mut_bytes()[0..4]),
        Reg::MatIndexHigh => value.write_ne_bytes(&mut xf.default_matrices.as_mut_bytes()[4..8]),

        Reg::VcdLow => value.write_ne_bytes(&mut cp.vertex_descriptor.as_mut_bytes()[0..4]),
        Reg::VcdHigh => value.write_ne_bytes(&mut cp.vertex_descriptor.as_mut_bytes()[4..8]),

        Reg::Vat0A => value.write_ne_bytes(cp.vertex_attr_tables[0].a.as_mut_bytes()),
        Reg::Vat1A => value.write_ne_bytes(cp.vertex_attr_tables[1].a.as_mut_bytes()),
        Reg::Vat2A => value.write_ne_bytes(cp.vertex_attr_tables[2].a.as_mut_bytes()),
        Reg::Vat3A => value.write_ne_bytes(cp.vertex_attr_tables[3].a.as_mut_bytes()),
        Reg::Vat4A => value.write_ne_bytes(cp.vertex_attr_tables[4].a.as_mut_bytes()),
        Reg::Vat5A => value.write_ne_bytes(cp.vertex_attr_tables[5].a.as_mut_bytes()),
        Reg::Vat6A => value.write_ne_bytes(cp.vertex_attr_tables[6].a.as_mut_bytes()),
        Reg::Vat7A => value.write_ne_bytes(cp.vertex_attr_tables[7].a.as_mut_bytes()),

        Reg::Vat0B => value.write_ne_bytes(cp.vertex_attr_tables[0].b.as_mut_bytes()),
        Reg::Vat1B => value.write_ne_bytes(cp.vertex_attr_tables[1].b.as_mut_bytes()),
        Reg::Vat2B => value.write_ne_bytes(cp.vertex_attr_tables[2].b.as_mut_bytes()),
        Reg::Vat3B => value.write_ne_bytes(cp.vertex_attr_tables[3].b.as_mut_bytes()),
        Reg::Vat4B => value.write_ne_bytes(cp.vertex_attr_tables[4].b.as_mut_bytes()),
        Reg::Vat5B => value.write_ne_bytes(cp.vertex_attr_tables[5].b.as_mut_bytes()),
        Reg::Vat6B => value.write_ne_bytes(cp.vertex_attr_tables[6].b.as_mut_bytes()),
        Reg::Vat7B => value.write_ne_bytes(cp.vertex_attr_tables[7].b.as_mut_bytes()),

        Reg::Vat0C => value.write_ne_bytes(cp.vertex_attr_tables[0].c.as_mut_bytes()),
        Reg::Vat1C => value.write_ne_bytes(cp.vertex_attr_tables[1].c.as_mut_bytes()),
        Reg::Vat2C => value.write_ne_bytes(cp.vertex_attr_tables[2].c.as_mut_bytes()),
        Reg::Vat3C => value.write_ne_bytes(cp.vertex_attr_tables[3].c.as_mut_bytes()),
        Reg::Vat4C => value.write_ne_bytes(cp.vertex_attr_tables[4].c.as_mut_bytes()),
        Reg::Vat5C => value.write_ne_bytes(cp.vertex_attr_tables[5].c.as_mut_bytes()),
        Reg::Vat6C => value.write_ne_bytes(cp.vertex_attr_tables[6].c.as_mut_bytes()),
        Reg::Vat7C => value.write_ne_bytes(cp.vertex_attr_tables[7].c.as_mut_bytes()),

        Reg::PositionPtr => value.write_ne_bytes(cp.arrays.position.address.as_mut_bytes()),
        Reg::NormalPtr => value.write_ne_bytes(cp.arrays.normal.address.as_mut_bytes()),
        Reg::Chan0Ptr => value.write_ne_bytes(cp.arrays.chan0.address.as_mut_bytes()),
        Reg::Chan1Ptr => value.write_ne_bytes(cp.arrays.chan1.address.as_mut_bytes()),

        Reg::Tex0CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[0].address.as_mut_bytes()),
        Reg::Tex1CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[1].address.as_mut_bytes()),
        Reg::Tex2CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[2].address.as_mut_bytes()),
        Reg::Tex3CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[3].address.as_mut_bytes()),
        Reg::Tex4CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[4].address.as_mut_bytes()),
        Reg::Tex5CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[5].address.as_mut_bytes()),
        Reg::Tex6CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[6].address.as_mut_bytes()),
        Reg::Tex7CoordPtr => value.write_ne_bytes(cp.arrays.tex_coords[7].address.as_mut_bytes()),

        Reg::GpArr0Ptr => value.write_ne_bytes(cp.arrays.general_purpose[0].address.as_mut_bytes()),
        Reg::GpArr1Ptr => value.write_ne_bytes(cp.arrays.general_purpose[1].address.as_mut_bytes()),
        Reg::GpArr2Ptr => value.write_ne_bytes(cp.arrays.general_purpose[2].address.as_mut_bytes()),
        Reg::GpArr3Ptr => value.write_ne_bytes(cp.arrays.general_purpose[3].address.as_mut_bytes()),

        Reg::PositionStride => value.write_ne_bytes(cp.arrays.position.stride.as_mut_bytes()),
        Reg::NormalStride => value.write_ne_bytes(cp.arrays.normal.stride.as_mut_bytes()),
        Reg::Chan0Stride => value.write_ne_bytes(cp.arrays.chan0.stride.as_mut_bytes()),
        Reg::Chan1Stride => value.write_ne_bytes(cp.arrays.chan1.stride.as_mut_bytes()),

        Reg::Tex0CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[0].stride.as_mut_bytes()),
        Reg::Tex1CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[1].stride.as_mut_bytes()),
        Reg::Tex2CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[2].stride.as_mut_bytes()),
        Reg::Tex3CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[3].stride.as_mut_bytes()),
        Reg::Tex4CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[4].stride.as_mut_bytes()),
        Reg::Tex5CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[5].stride.as_mut_bytes()),
        Reg::Tex6CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[6].stride.as_mut_bytes()),
        Reg::Tex7CoordStride => value.write_ne_bytes(cp.arrays.tex_coords[7].stride.as_mut_bytes()),

        Reg::GpArr0Stride => {
            value.write_ne_bytes(cp.arrays.general_purpose[0].stride.as_mut_bytes())
        }
        Reg::GpArr1Stride => {
            value.write_ne_bytes(cp.arrays.general_purpose[1].stride.as_mut_bytes())
        }
        Reg::GpArr2Stride => {
            value.write_ne_bytes(cp.arrays.general_purpose[2].stride.as_mut_bytes())
        }
        Reg::GpArr3Stride => {
            value.write_ne_bytes(cp.arrays.general_purpose[3].stride.as_mut_bytes())
        }

        _ => tracing::warn!("unimplemented write to internal CP register {reg:?}"),
    }
}

fn schedule_interrupt_check(sys: &mut System) {
    if !sys.scheduler.contains(pi::check_interrupts) {
        sys.scheduler.schedule_now(pi::check_interrupts);
    }
}

/// Samples the CP source and schedules PI delivery against the resulting level.
pub fn refresh_interrupts(sys: &mut System) {
    sys.gpu.cmd.refresh_interrupt_latches();
    self::schedule_interrupt_check(sys);
}

/// Pops one 32-byte write-gather burst from the CP FIFO in memory.
fn fifo_pop_burst(sys: &mut System) -> Option<[u8; FIFO_BURST_BYTES as usize]> {
    if sys.gpu.cmd.fifo.distance < FIFO_BURST_BYTES || !sys.gpu.cmd.fifo.service_state_valid() {
        return None;
    }

    let read_ptr = sys.gpu.cmd.fifo.read_ptr;
    let mut data = [0; FIFO_BURST_BYTES as usize];
    for (offset, byte) in data.iter_mut().enumerate() {
        *byte = sys.read_phys_slow::<u8>(read_ptr + offset as u32);
    }

    let fifo = &mut sys.gpu.cmd.fifo;
    fifo.read_ptr = if read_ptr == fifo.end {
        fifo.start
    } else {
        read_ptr + FIFO_BURST_BYTES
    };
    fifo.distance -= FIFO_BURST_BYTES;
    Some(data)
}

/// Consumes commands available in the CP FIFO.
pub fn consume(sys: &mut System) {
    if sys.gpu.cmd.native_decode_faulted()
        || sys.gpu.cmd.fifo.distance == 0
        || !sys.gpu.cmd.control.fifo_read_enable()
    {
        self::refresh_interrupts(sys);
        return;
    }

    // The GX FIFO object computes write - read as a signed value. Its masked 26-bit register image
    // is recoverable only after the complete state has been published and GP reads become enabled;
    // do this before sampling a potentially false high-water source.
    sys.gpu.cmd.fifo.normalize_signed_distance();

    if !sys.gpu.cmd.fifo.service_state_valid() {
        tracing::warn!(
            start = ?sys.gpu.cmd.fifo.start,
            end = ?sys.gpu.cmd.fifo.end,
            read = ?sys.gpu.cmd.fifo.read_ptr,
            distance = sys.gpu.cmd.fifo.distance,
            "refusing to service malformed CP FIFO state"
        );
        self::schedule_interrupt_check(sys);
        return;
    }

    // Sample producer-side high water before synchronous consumption can resolve it.
    sys.gpu.cmd.refresh_interrupt_latches();

    let mut budget = FIFO_SERVICE_BUDGET_BYTES;
    let mut consumed = false;
    while sys.gpu.cmd.fifo.distance != 0 && budget >= FIFO_BURST_BYTES {
        // Breakpoint is a non-sticky level. In particular, a service call made while already at
        // the breakpoint must deliver its interrupt without consuming or spinning.
        if sys.gpu.cmd.breakpoint_level() {
            break;
        }

        let Some(data) = self::fifo_pop_burst(sys) else {
            break;
        };
        for byte in data {
            sys.gpu.cmd.queue.push_be(byte);
        }
        consumed = true;
        budget -= FIFO_BURST_BYTES;
    }

    // Sample consumer-side low water after movement. One drain can therefore retain both latches.
    sys.gpu.cmd.refresh_interrupt_latches();
    self::schedule_interrupt_check(sys);

    if consumed
        && sys.gpu.cmd.fifo.distance != 0
        && !sys.gpu.cmd.breakpoint_level()
        && !sys.scheduler.contains(self::consume)
    {
        sys.scheduler.schedule_now(self::consume);
    }
}

/// Process consumed CP commands until the queue is either empty or incomplete.
pub fn process(sys: &mut System) {
    let current_token = sys.gpu.pix.token;
    loop {
        let draw_done = sys.gpu.pix.interrupt.finish();
        if draw_done {
            break;
        }

        if current_token != sys.gpu.pix.token {
            break;
        }

        if sys.gpu.cmd.queue.is_empty() {
            break;
        }

        let Some(cmd) = sys.gpu.read_command() else {
            break;
        };

        if !matches!(cmd, Command::Nop | Command::InvalidateVertexCache) {
            tracing::debug!("processing {:02X?}", cmd);
        }

        match cmd {
            Command::Nop => (),
            Command::InvalidateVertexCache => (),
            Command::Call { address, length } => gx::call(sys, address, length),
            Command::SetCP { register, value } => self::set_register(sys, register, value),
            Command::SetBP { register, value } => gx::set_register(sys, register, value),
            Command::SetXF { start, values } => {
                for (offset, value) in values.into_iter().enumerate() {
                    gx::xform::write(sys, start + offset as u16, value);
                }
            }
            Command::IndexedSetXFA {
                base,
                length,
                index,
            } => {
                let array = sys.gpu.cmd.internal.arrays.general_purpose[0];
                gx::xform::write_indexed(sys, array, base, length, index);
            }
            Command::IndexedSetXFB {
                base,
                length,
                index,
            } => {
                let array = sys.gpu.cmd.internal.arrays.general_purpose[1];
                gx::xform::write_indexed(sys, array, base, length, index);
            }
            Command::IndexedSetXFC {
                base,
                length,
                index,
            } => {
                let array = sys.gpu.cmd.internal.arrays.general_purpose[2];
                gx::xform::write_indexed(sys, array, base, length, index);
            }
            Command::IndexedSetXFD {
                base,
                length,
                index,
            } => {
                let array = sys.gpu.cmd.internal.arrays.general_purpose[3];
                gx::xform::write_indexed(sys, array, base, length, index);
            }
            Command::Draw {
                topology,
                vertex_attributes,
            } => {
                gx::draw(sys, topology, &vertex_attributes);
            }
        }
    }

    sys.scheduler.schedule(1 << 16, self::process);
}

/// Synchronizes the CP fifo to the PI fifo.
pub fn sync_to_pi(sys: &mut System) {
    sys.gpu.cmd.fifo.start = sys.processor.fifo_start;
    sys.gpu.cmd.fifo.end = sys.processor.fifo_end;
    sys.gpu.cmd.fifo.write_ptr = sys.processor.fifo_current.address();
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
    use crate::system::{Config, Modules};

    fn bits(status: Status) -> u16 {
        status.to_bits()
    }

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
    fn resident_fifo_reset_signal_is_one_shot_and_wrap_safe() {
        let mut cmd = Interface {
            resident_fifo_reset_generation: FifoResetGeneration(u64::MAX - 1),
            ..Interface::default()
        };

        // Repeated resets may coalesce into one decoder reset, but their generation still
        // advances. Wrapping to zero must not resemble the default, already-observed state:
        // delivery is guarded by the independent pending latch.
        cmd.record_resident_fifo_reset();
        cmd.record_resident_fifo_reset();
        assert_eq!(cmd.resident_fifo_reset_generation().value(), 0);
        assert!(cmd.resident_fifo_reset_pending());
        assert_eq!(cmd.take_resident_fifo_reset(), Some(FifoResetGeneration(0)));
        assert!(!cmd.resident_fifo_reset_pending());
        assert_eq!(cmd.take_resident_fifo_reset(), None);

        cmd.record_resident_fifo_reset();
        assert_eq!(cmd.take_resident_fifo_reset(), Some(FifoResetGeneration(1)));
        assert_eq!(cmd.take_resident_fifo_reset(), None);
    }

    #[test]
    fn browser_oracle_status_uses_strict_live_thresholds() {
        let mut cmd = Interface::default();
        cmd.control = Control::from_bits(0x0001);
        cmd.fifo.high_mark = 0x40;
        cmd.fifo.low_mark = 0x40;

        for (distance, expected) in [
            (0x40, 0x0000),
            (0x60, 0x0001),
            (0x20, 0x0002),
            (0x00, 0x000e),
        ] {
            cmd.fifo.distance = distance;
            assert_eq!(bits(cmd.raw_status()), expected, "distance {distance:#x}");
        }

        cmd.control = Control::from_bits(0);
        cmd.fifo.distance = 0x40;
        assert_eq!(bits(cmd.raw_status()), 0x0008);

        cmd.control = Control::from_bits(0x0003);
        cmd.fifo.breakpoint = cmd.fifo.read_ptr;
        assert_eq!(bits(cmd.raw_status()), 0x0018);
    }

    #[test]
    fn browser_oracle_retains_resolved_watermarks_until_clear() {
        let mut high = Interface::default();
        high.control = Control::from_bits(0x0005);
        high.fifo.high_mark = 0x40;
        high.fifo.distance = 0x60;
        high.refresh_interrupt_latches();
        assert_eq!(bits(high.raw_status()), 0x0001);
        assert!(high.interrupt_active());

        high.fifo.distance = 0x20;
        high.refresh_interrupt_latches();
        assert_eq!(bits(high.raw_status()), 0x0000);
        assert_eq!(bits(high.read_status()), 0x0001);
        assert!(high.interrupt_active());
        high.write_clear(0x0001);
        assert_eq!(bits(high.read_status()), 0x0000);
        assert!(!high.interrupt_active());

        let mut low = Interface::default();
        low.control = Control::from_bits(0x0009);
        low.fifo.high_mark = 0x100;
        low.fifo.low_mark = 0x40;
        low.fifo.distance = 0x20;
        low.refresh_interrupt_latches();
        low.fifo.distance = 0x60;
        low.refresh_interrupt_latches();
        assert_eq!(bits(low.raw_status()), 0x0000);
        assert_eq!(bits(low.read_status()), 0x0002);
        assert!(low.interrupt_active());
        low.write_clear(0x0002);
        assert_eq!(bits(low.read_status()), 0x0000);
        assert!(!low.interrupt_active());
    }

    #[test]
    fn browser_oracle_active_clear_reasserts_only_a_live_source() {
        let mut cmd = Interface::default();
        cmd.control = Control::from_bits(0x0001);
        cmd.fifo.high_mark = 0x40;
        cmd.fifo.distance = 0x60;
        cmd.refresh_interrupt_latches();

        cmd.write_clear(0x0001);
        assert!(cmd.status.fifo_overflow());
        assert!(!cmd.interrupt_active());

        cmd.control = Control::from_bits(0x0005);
        assert!(cmd.interrupt_active());
        cmd.write_clear(0x0001);
        assert!(cmd.status.fifo_overflow());
        assert!(cmd.interrupt_active());

        cmd.fifo.distance = 0x20;
        cmd.write_clear(0x0001);
        assert!(!cmd.status.fifo_overflow());
        assert!(!cmd.interrupt_active());
    }

    #[test]
    fn browser_oracle_rogue_001b_c020_uses_raw_not_sticky_status() {
        let mut cmd = Interface::default();
        cmd.control = Control::from_bits(0x001b);
        cmd.fifo.high_mark = 0xc000;
        cmd.fifo.low_mark = 0x8000;
        cmd.fifo.read_ptr = Address(0x100);
        cmd.fifo.breakpoint = Address(0x100);

        cmd.fifo.distance = 0x7fe0;
        cmd.refresh_interrupt_latches();
        assert_eq!(bits(cmd.raw_status()), 0x001a);
        assert_eq!(bits(cmd.read_status()), 0x001a);
        assert_eq!(bits(cmd.qualified_sources()), 0x0012);
        assert_eq!(bits(cmd.status) & 3, 2);
        assert!(cmd.interrupt_active());

        cmd.fifo.distance = 0xc020;
        cmd.refresh_interrupt_latches();
        assert_eq!(bits(cmd.raw_status()), 0x0019);
        assert_eq!(bits(cmd.read_status()), 0x001b);
        assert_eq!(bits(cmd.qualified_sources()), 0x0011);
        assert_eq!(bits(cmd.status) & 3, 3);
        assert!(cmd.interrupt_active());

        cmd.write_clear(0x0002);
        assert_eq!(bits(cmd.raw_status()), 0x0019);
        assert_eq!(bits(cmd.read_status()), 0x0019);
        assert_eq!(bits(cmd.status) & 3, 1);
        assert!(!cmd.interrupt_active());
    }

    #[test]
    fn browser_oracle_breakpoint_short_circuits_fifo_service() {
        let mut sys = test_system();
        sys.gpu.cmd.control = Control::from_bits(0x0023);
        sys.gpu.cmd.fifo.start = Address(0x100);
        sys.gpu.cmd.fifo.end = Address(0x160);
        sys.gpu.cmd.fifo.high_mark = 0x100;
        sys.gpu.cmd.fifo.distance = 0x40;
        sys.gpu.cmd.fifo.read_ptr = Address(0x100);
        sys.gpu.cmd.fifo.write_ptr = Address(0x140);
        sys.gpu.cmd.fifo.breakpoint = Address(0x120);
        for offset in 0..0x40 {
            sys.write_phys_slow(Address(0x100 + offset), offset as u8);
        }

        consume(&mut sys);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0x20);
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0x120));
        assert_eq!(sys.gpu.cmd.queue.len(), 32);
        assert_eq!(bits(sys.gpu.cmd.read_status()), 0x0018);
        assert!(pi::get_active_interrupts(&sys).command_processor());

        consume(&mut sys);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0x20);
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0x120));
        assert_eq!(sys.gpu.cmd.queue.len(), 32);

        sys.gpu.cmd.control = Control::from_bits(0x0001);
        consume(&mut sys);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0);
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0x140));
        assert_eq!(sys.gpu.cmd.queue.len(), 64);
        assert_eq!(bits(sys.gpu.cmd.read_status()), 0x000c);
        assert!(!pi::get_active_interrupts(&sys).command_processor());
    }

    #[test]
    fn browser_oracle_one_drain_retains_both_watermark_latches() {
        let mut sys = test_system();
        sys.gpu.cmd.control = Control::from_bits(0x000d);
        sys.gpu.cmd.fifo.start = Address(0x100);
        sys.gpu.cmd.fifo.end = Address(0x160);
        sys.gpu.cmd.fifo.high_mark = 0x20;
        sys.gpu.cmd.fifo.low_mark = 0x20;
        sys.gpu.cmd.fifo.distance = 0x40;
        sys.gpu.cmd.fifo.read_ptr = Address(0x100);
        sys.gpu.cmd.fifo.write_ptr = Address(0x140);

        consume(&mut sys);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0);
        assert_eq!(bits(sys.gpu.cmd.raw_status()), 0x000e);
        assert_eq!(bits(sys.gpu.cmd.read_status()), 0x000f);
        assert_eq!(bits(sys.gpu.cmd.status) & 3, 3);
        assert!(sys.gpu.cmd.interrupt_active());

        sys.gpu.cmd.write_clear(0x0003);
        assert_eq!(bits(sys.gpu.cmd.status) & 3, 2);
        assert_eq!(bits(sys.gpu.cmd.read_status()), 0x000e);
        assert!(sys.gpu.cmd.interrupt_active());
    }

    #[test]
    fn command_processor_level_reaches_unmasked_pi_cause_and_masked_delivery() {
        let mut sys = test_system();
        sys.gpu.cmd.control = Control::from_bits(0x0005);
        sys.gpu.cmd.fifo.high_mark = 0x40;
        sys.gpu.cmd.fifo.distance = 0x60;
        sys.gpu.cmd.refresh_interrupt_latches();

        assert!(pi::get_active_interrupts(&sys).command_processor());
        assert!(!pi::get_raised_interrupts(&sys).command_processor());
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(0x0c00_3000)) & 0x0000_0800,
            0x0000_0800
        );

        let mut mask = pi::InterruptSources::default();
        mask.set_command_processor(true);
        sys.processor.mask.set_sources(mask);
        assert!(pi::get_raised_interrupts(&sys).command_processor());

        sys.cpu.pc = Address(0x8000_1000);
        sys.cpu.supervisor.config.msr.set_exception_prefix(false);
        sys.cpu.supervisor.config.msr.set_interrupts(true);
        pi::check_interrupts(&mut sys);
        assert_eq!(sys.cpu.pc, Address(0x0000_0500));
        assert!(sys.gpu.cmd.interrupt_active());
    }

    #[test]
    fn linked_pi_burst_publishes_distance_before_interrupt_sampling() {
        let mut sys = test_system();
        sys.processor.fifo_start = Address(0x100);
        sys.processor.fifo_end = Address(0x160);
        sys.processor.fifo_current.set_address(Address(0x100));
        sys.gpu.cmd.control = Control::from_bits(0x0010);
        sys.gpu.cmd.fifo.high_mark = 0;
        sys.gpu.cmd.fifo.read_ptr = Address(0x100);

        for value in 0..8u32 {
            pi::fifo_push(&mut sys, 0x1020_3000 | value);
        }
        assert_eq!(sys.processor.fifo_current.address(), Address(0x120));
        assert_eq!(sys.gpu.cmd.fifo.write_ptr, Address(0x120));
        assert_eq!(sys.gpu.cmd.fifo.distance, 32);
        assert_eq!(sys.gpu.cmd.queue.len(), 0);
        assert!(!sys.gpu.cmd.status.fifo_overflow());

        sys.gpu.cmd.control = Control::from_bits(0x0015);
        consume(&mut sys);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0);
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0x120));
        assert_eq!(sys.gpu.cmd.queue.len(), 32);
        assert!(sys.gpu.cmd.status.fifo_overflow());
        assert!(sys.gpu.cmd.interrupt_active());
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(0x0c00_3000)) & 0x0000_0800,
            0x0000_0800
        );
    }

    fn smb_signed_fifo() -> Fifo {
        Fifo {
            start: Address(0x00d6_3380),
            end: Address(0x00e6_3360),
            high_mark: 0x0003_c000,
            low_mark: 0x0002_0000,
            distance: 0x03f0_e9c0,
            write_ptr: Address(0x00d6_9000),
            read_ptr: Address(0x00e5_a640),
            breakpoint: Address(0),
        }
    }

    #[test]
    fn browser_oracle_signed_distance_normalization_authenticates_exact_origin() {
        let mut exact = smb_signed_fifo();
        assert!(exact.normalize_signed_distance());
        assert_eq!(exact.distance, 0x0000_e9c0);

        let mut invalid = Vec::new();

        let mut raw_with_no_signed_origin = smb_signed_fifo();
        raw_with_no_signed_origin.distance ^= 0x20;
        invalid.push(("masked pointer delta", raw_with_no_signed_origin));

        let mut non_oversized = smb_signed_fifo();
        non_oversized.distance = 0x20;
        invalid.push(("oversized distance", non_oversized));

        let mut unaligned_distance = smb_signed_fifo();
        unaligned_distance.distance |= 1;
        invalid.push(("distance alignment", unaligned_distance));

        let mut unaligned_span = smb_signed_fifo();
        unaligned_span.end += 1;
        invalid.push(("span alignment", unaligned_span));

        let mut unordered_pointers = smb_signed_fifo();
        unordered_pointers.write_ptr = unordered_pointers.read_ptr;
        invalid.push(("pointer ordering", unordered_pointers));

        let mut outside_fifo = smb_signed_fifo();
        outside_fifo.write_ptr = outside_fifo.start - 0x20;
        invalid.push(("pointer bounds", outside_fifo));

        let mut outside_ram = smb_signed_fifo();
        outside_ram.start += RAM_LEN as u32;
        outside_ram.end += RAM_LEN as u32;
        outside_ram.write_ptr += RAM_LEN as u32;
        outside_ram.read_ptr += RAM_LEN as u32;
        invalid.push(("physical RAM backing", outside_ram));

        for (gate, mut fifo) in invalid {
            let raw = fifo.distance;
            assert!(!fifo.normalize_signed_distance(), "missing {gate} gate");
            assert_eq!(fifo.distance, raw, "{gate} changed invalid state");
        }
    }

    #[test]
    fn browser_oracle_smb_normalizes_before_first_enabled_irq_sample() {
        fn write_pair(sys: &mut System, offset: u32, value: u32) {
            sys.write_phys_slow(Address(0x0c00_0000 + offset), value as u16);
            sys.write_phys_slow(Address(0x0c00_0002 + offset), (value >> 16) as u16);
        }

        let mut sys = test_system();
        let fifo = smb_signed_fifo();
        write_pair(&mut sys, 0x20, fifo.start.value());
        write_pair(&mut sys, 0x24, fifo.end.value());
        write_pair(&mut sys, 0x28, fifo.high_mark);
        write_pair(&mut sys, 0x2c, fifo.low_mark);
        write_pair(&mut sys, 0x30, fifo.distance);
        write_pair(&mut sys, 0x34, fifo.write_ptr.value());
        write_pair(&mut sys, 0x38, fifo.read_ptr.value());

        assert_eq!(sys.gpu.cmd.fifo.distance, 0x03f0_e9c0);
        assert_eq!(bits(sys.gpu.cmd.status) & 3, 0);

        sys.write_phys_slow(Address(0x0c00_0002), 0x0015u16);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0);
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, fifo.write_ptr);
        assert_eq!(sys.gpu.cmd.queue.len(), 0x0000_e9c0);
        assert!(!sys.gpu.cmd.status.fifo_overflow());
        assert!(sys.gpu.cmd.status.fifo_underflow());
        assert!(!sys.gpu.cmd.interrupt_active());
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(0x0c00_3000)) & 0x0000_0800,
            0
        );
    }

    #[test]
    fn browser_oracle_pi_fifo_reset_preserves_pointers_and_distance() {
        let mut sys = test_system();
        assert_eq!(sys.gpu.cmd.resident_fifo_reset_generation().value(), 0);
        assert!(!sys.gpu.cmd.resident_fifo_reset_pending());
        assert_eq!(sys.gpu.cmd.take_resident_fifo_reset(), None);
        sys.processor.fifo_start = Address(0x200);
        sys.processor.fifo_end = Address(0x260);
        sys.processor.fifo_current.set_address(Address(0x220));
        sys.gpu.cmd.control = Control::from_bits(0x003f);
        sys.gpu.cmd.fifo.start = Address(0x100);
        sys.gpu.cmd.fifo.end = Address(0x160);
        sys.gpu.cmd.fifo.high_mark = 0x20;
        sys.gpu.cmd.fifo.low_mark = 0x80;
        sys.gpu.cmd.fifo.distance = 0x40;
        sys.gpu.cmd.fifo.write_ptr = Address(0x120);
        sys.gpu.cmd.fifo.read_ptr = Address(0x100);
        sys.gpu.cmd.refresh_interrupt_latches();
        sys.gpu.cmd.queue.push_be(0x61u8);
        for value in 1..=7u8 {
            pi::fifo_push(&mut sys, value);
        }
        assert!(sys.gpu.cmd.interrupt_active());

        sys.write_phys_slow(Address(0x0c00_3018), 1u32);
        assert_eq!(sys.read_phys_slow::<u32>(Address(0x0c00_3018)), 0);
        assert_eq!(sys.gpu.cmd.control.to_bits(), 0x0010);
        assert_eq!(sys.gpu.cmd.fifo.high_mark, 0x03ff_ffe0);
        assert_eq!(sys.gpu.cmd.fifo.low_mark, 0);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0x40);
        assert_eq!(sys.gpu.cmd.fifo.write_ptr, Address(0x120));
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0x100));
        assert_eq!(bits(sys.gpu.cmd.status) & 3, 0);
        assert!(sys.gpu.cmd.queue.is_empty());
        assert!(!sys.gpu.cmd.interrupt_active());
        assert_eq!(sys.processor.fifo_start, Address(0x200));
        assert_eq!(sys.processor.fifo_end, Address(0x260));
        assert_eq!(sys.processor.fifo_current.address(), Address(0x220));
        assert_eq!(sys.gpu.cmd.resident_fifo_reset_generation().value(), 1);
        assert!(sys.gpu.cmd.resident_fifo_reset_pending());
        assert_eq!(
            sys.gpu.cmd.take_resident_fifo_reset(),
            Some(FifoResetGeneration(1))
        );
        assert!(!sys.gpu.cmd.resident_fifo_reset_pending());
        assert_eq!(sys.gpu.cmd.take_resident_fifo_reset(), None);

        // The seven pre-reset gather bytes were discarded, so 25 new bytes cannot publish a burst.
        for value in 0..25u8 {
            pi::fifo_push(&mut sys, value);
        }
        assert_eq!(sys.processor.fifo_current.address(), Address(0x220));
        assert_eq!(sys.gpu.cmd.fifo.distance, 0x40);

        // Reset is idempotent, so multiple unobserved requests coalesce without losing the
        // fail-closed pending state. The generation preserves their ordering for diagnostics.
        pi::reset_fifo(&mut sys);
        pi::reset_fifo(&mut sys);
        assert_eq!(sys.gpu.cmd.resident_fifo_reset_generation().value(), 3);
        assert_eq!(
            sys.gpu.cmd.take_resident_fifo_reset(),
            Some(FifoResetGeneration(3))
        );
        assert_eq!(sys.gpu.cmd.take_resident_fifo_reset(), None);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0x40);
        assert_eq!(sys.gpu.cmd.fifo.write_ptr, Address(0x120));
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0x100));
    }

    #[test]
    fn browser_oracle_rogue_sequence_matches_through_cp_and_pi_mmio() {
        fn write_pair(sys: &mut System, offset: u32, value: u32) {
            sys.write_phys_slow(Address(0x0c00_0000 + offset), value as u16);
            sys.write_phys_slow(Address(0x0c00_0002 + offset), (value >> 16) as u16);
        }

        fn read_pair(sys: &mut System, offset: u32) -> u32 {
            let low = sys.read_phys_slow::<u16>(Address(0x0c00_0000 + offset));
            let high = sys.read_phys_slow::<u16>(Address(0x0c00_0002 + offset));
            u32::from(low) | (u32::from(high) << 16)
        }

        let mut sys = test_system();
        write_pair(&mut sys, 0x20, 0x0000_0100);
        write_pair(&mut sys, 0x24, 0x0001_0000);
        write_pair(&mut sys, 0x28, 0x0000_c000);
        write_pair(&mut sys, 0x2c, 0x0000_8000);
        write_pair(&mut sys, 0x30, 0x0000_7fe0);
        write_pair(&mut sys, 0x34, 0x0000_0100);
        write_pair(&mut sys, 0x38, 0x0000_0100);
        write_pair(&mut sys, 0x3c, 0x0000_0100);

        // Reserved control bits are ignored; the exact Rogue value remains 0x001b.
        sys.write_phys_slow(Address(0x0c00_0002), 0xffdbu16);
        assert_eq!(sys.read_phys_slow::<u16>(Address(0x0c00_0002)), 0x001b);
        assert_eq!(sys.read_phys_slow::<u16>(Address(0x0c00_0000)), 0x001a);
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(0x0c00_3000)) & 0x0000_0800,
            0x0000_0800
        );

        write_pair(&mut sys, 0x30, 0x0000_c020);
        assert_eq!(read_pair(&mut sys, 0x30), 0x0000_c020);
        assert_eq!(read_pair(&mut sys, 0x3c), 0x0000_0100);
        assert_eq!(sys.read_phys_slow::<u16>(Address(0x0c00_0000)), 0x001b);

        sys.write_phys_slow(Address(0x0c00_0004), 0x0002u16);
        assert_eq!(sys.read_phys_slow::<u16>(Address(0x0c00_0000)), 0x0019);
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(0x0c00_3000)) & 0x0000_0800,
            0
        );

        // CP_STATUS itself is not an acknowledgement path.
        sys.write_phys_slow(Address(0x0c00_0000), 0xffffu16);
        assert_eq!(sys.read_phys_slow::<u16>(Address(0x0c00_0000)), 0x0019);
    }

    #[test]
    fn native_decoder_poison_is_panic_free_and_resettable() {
        fn append(sys: &mut System, bytes: &[u8]) {
            for byte in bytes {
                sys.gpu.cmd.queue.push_be(*byte);
            }
        }

        let malformed = [
            // Unknown operation 0x03.
            vec![0x18],
            // SET_CP followed by an unassigned CP register.
            vec![0x08, 0xff, 0, 0, 0, 0],
            // SET_BP followed by an unassigned BP register.
            vec![0x61, 0xff, 0, 0, 0],
        ];
        for command in malformed {
            let mut sys = test_system();
            append(&mut sys, &command);
            append(&mut sys, &[0x61, 0, 0, 0]);
            assert!(sys.gpu.read_command().is_none());
            assert!(sys.gpu.cmd.native_decode_faulted());
            assert!(sys.gpu.cmd.queue.is_empty());

            pi::reset_fifo(&mut sys);
            assert!(!sys.gpu.cmd.native_decode_faulted());
            assert!(sys.gpu.cmd.queue.is_empty());
        }

        let mut reserved_vat = test_system();
        reserved_vat.gpu.cmd.internal.vertex_descriptor = reserved_vat
            .gpu
            .cmd
            .internal
            .vertex_descriptor
            .with_position(AttributeMode::Direct);
        let position = reserved_vat.gpu.cmd.internal.vertex_attr_tables[0]
            .a
            .position()
            .with_format(CoordsFormat::Reserved0);
        reserved_vat.gpu.cmd.internal.vertex_attr_tables[0]
            .a
            .set_position(position);
        // Draw quad list, one vertex. The reserved direct format is rejected before sizing or
        // parsing the attacker-controlled payload.
        append(&mut reserved_vat, &[0x80, 0, 1, 0xaa, 0xbb]);
        assert!(reserved_vat.gpu.read_command().is_none());
        assert!(reserved_vat.gpu.cmd.native_decode_faulted());
        assert!(reserved_vat.gpu.cmd.queue.is_empty());
    }

    #[test]
    fn wide_command_processor_mmio_is_rejected_without_panicking() {
        let mut sys = test_system();
        let before_control = sys.gpu.cmd.control;
        let before_status = sys.gpu.cmd.status;

        assert_eq!(
            sys.read_phys_slow::<u64>(Address(0x0c00_0000)),
            u64::default()
        );
        sys.write_phys_slow(Address(0x0c00_0000), u64::MAX);

        assert_eq!(sys.gpu.cmd.control.to_bits(), before_control.to_bits());
        assert_eq!(sys.gpu.cmd.status.to_bits(), before_status.to_bits());
    }

    #[test]
    fn malformed_guest_fifo_state_fails_closed_without_panicking() {
        let mut sys = test_system();
        sys.gpu.cmd.control = Control::from_bits(0x0001);
        sys.gpu.cmd.fifo.start = Address(0x200);
        sys.gpu.cmd.fifo.end = Address(0x100);
        sys.gpu.cmd.fifo.distance = 0x03ff_ffe0;
        sys.gpu.cmd.fifo.read_ptr = Address(0xffff_ffe0);

        consume(&mut sys);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0x03ff_ffe0);
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0xffff_ffe0));
        assert!(sys.gpu.cmd.queue.is_empty());

        // A superficially ordered 64-MiB FIFO must not turn unmapped reads into an effectively
        // unbounded native command queue. Only complete MEM1-backed spans are serviceable.
        sys.gpu.cmd.fifo.start = Address(0);
        sys.gpu.cmd.fifo.end = Address(0x03ff_ffe0);
        sys.gpu.cmd.fifo.distance = 0x20;
        sys.gpu.cmd.fifo.write_ptr = Address(0x20);
        sys.gpu.cmd.fifo.read_ptr = Address(0);
        consume(&mut sys);
        assert_eq!(sys.gpu.cmd.fifo.distance, 0x20);
        assert_eq!(sys.gpu.cmd.fifo.read_ptr, Address(0));
        assert!(sys.gpu.cmd.queue.is_empty());
    }
}
