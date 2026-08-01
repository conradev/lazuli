//! Pixel engine (PE).
use bitos::integer::{u4, u10, u11};
use bitos::{BitUtils, Bits, bitos};
use color::Abgr8;
use gekko::Address;

use crate::system::gx::tex;

#[bitos(3)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BufferFormat {
    #[default]
    RGB8Z24   = 0x0,
    RGBA6Z24  = 0x1,
    RGB565Z16 = 0x2,
    Z24       = 0x3,
    Y8        = 0x4,
    U8        = 0x5,
    V8        = 0x6,
    YUV420    = 0x7,
}

impl BufferFormat {
    pub fn has_alpha(self) -> bool {
        self == Self::RGBA6Z24
    }

    pub fn is_depth(self) -> bool {
        self == Self::Z24
    }
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DepthCompression {
    #[default]
    Linear = 0b00,
    Near   = 0b01,
    Mid    = 0b10,
    Far    = 0b11,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Control {
    #[bits(0..3)]
    pub format: BufferFormat,
    #[bits(3..5)]
    pub depth_compression: DepthCompression,
    #[bits(6)]
    pub depth_compress_before_tex: bool,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConstantAlpha {
    #[bits(0..8)]
    pub value: u8,
    #[bits(8)]
    pub enabled: bool,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CopySrc {
    #[bits(0..10)]
    pub x: u10,
    #[bits(10..20)]
    pub y: u10,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CopyDims {
    #[bits(0..10)]
    pub width_minus_one: u10,
    #[bits(10..20)]
    pub height_minus_one: u10,
}

impl CopyDims {
    pub fn width(&self) -> u16 {
        self.width_minus_one().value() + 1
    }

    pub fn height(&self) -> u16 {
        self.height_minus_one().value() + 1
    }
}

#[bitos(4)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DepthCopyFormat {
    #[default]
    Z4        = 0x0,
    Z8        = 0x1,
    Reserved0 = 0x2,
    Z16C      = 0x3,
    Reserved1 = 0x4,
    Reserved2 = 0x5,
    Z24X8     = 0x6,
    Reserved3 = 0x7,
    Z8H       = 0x8,
    Z8M       = 0x9,
    Z8L       = 0xA,
    Z16R      = 0xB,
    Z16L      = 0xC,
    Reserved4 = 0xD,
    Reserved5 = 0xE,
    Reserved6 = 0xF,
}

impl DepthCopyFormat {
    pub fn texture_format(&self) -> tex::Format {
        use tex::Format::*;
        match self {
            Self::Z4 => I4,
            Self::Z8 => I8,
            Self::Z16C => IA8,
            Self::Z24X8 => RGBA8,
            Self::Z8H => I8,
            Self::Z8M => I8,
            Self::Z8L => I8,
            Self::Z16R => IA8,
            Self::Z16L => IA8,
            _ => panic!("reserved copy format {self:?}"),
        }
    }

    // Keep the old names available until the texture encoder is migrated to
    // the hardware names. Raw format 0xB selects the high and middle depth
    // bytes (Z16R); raw format 0xC selects the middle and low bytes (Z16L).
    #[allow(non_upper_case_globals)]
    pub const Z16A: Self = Self::Z16R;
    #[allow(non_upper_case_globals)]
    pub const Z16B: Self = Self::Z16L;
}

#[bitos(4)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorCopyFormat {
    #[default]
    R4        = 0x0,
    R8_0x1    = 0x1,
    RA4       = 0x2,
    RA8       = 0x3,
    RGB565    = 0x4,
    RGB5A3    = 0x5,
    RGBA8     = 0x6,
    A8        = 0x7,
    R8        = 0x8,
    G8        = 0x9,
    B8        = 0xA,
    RG8       = 0xB,
    GB8       = 0xC,
    Reserved0 = 0xD,
    Reserved1 = 0xE,
    Reserved2 = 0xF,
}

impl ColorCopyFormat {
    pub fn texture_format(&self) -> tex::Format {
        use tex::Format::*;
        match self {
            Self::R4 => I4,
            Self::R8_0x1 => I8,
            Self::RA4 => IA4,
            Self::RA8 => IA8,
            Self::RGB565 => RGB565,
            Self::RGB5A3 => RGB5A3,
            Self::RGBA8 => RGBA8,
            Self::A8 => I8,
            Self::R8 => I8,
            Self::G8 => I8,
            Self::B8 => I8,
            Self::RG8 => IA8,
            Self::GB8 => IA8,
            _ => panic!("reserved copy format {self:?}"),
        }
    }

    // Intensity conversion is controlled by two independent BP52 bits. The
    // raw 0x1 tile-encoder mode is not intrinsically a luma format.
    #[allow(non_upper_case_globals)]
    pub const Y8: Self = Self::R8_0x1;
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CopyGamma {
    #[default]
    Gamma1_0         = 0b00,
    Gamma1_7         = 0b01,
    Gamma2_2         = 0b10,
    Gamma2_2Reserved = 0b11,
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FrameToField {
    #[default]
    Progressive    = 0b00,
    Reserved       = 0b01,
    InterlacedEven = 0b10,
    InterlacedOdd  = 0b11,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CopyCmd {
    #[bits(0)]
    pub clamp_top: bool,
    #[bits(1)]
    pub clamp_bottom: bool,
    #[bits(2)]
    pub unknown_bit: bool,
    #[bits(3..7)]
    pub target_format: u4,
    #[bits(7..9)]
    pub gamma: CopyGamma,
    #[bits(9)]
    pub half: bool,
    #[bits(10)]
    pub scale_invert: bool,
    #[bits(11)]
    pub clear: bool,
    #[bits(12..14)]
    pub frame_to_field: FrameToField,
    #[bits(14)]
    pub to_xfb: bool,
    #[bits(15)]
    pub intensity_format: bool,
    #[bits(16)]
    pub auto_convert: bool,
}

impl CopyCmd {
    /// Returns the tile-encoder format after BP52's four format bits are
    /// rotated right by one position.
    pub fn raw_format(&self) -> u4 {
        let encoded = self.target_format().value();
        u4::new((encoded >> 1) | ((encoded & 1) << 3))
    }

    pub fn color_format(&self) -> ColorCopyFormat {
        ColorCopyFormat::from_bits(self.raw_format())
    }

    pub fn depth_format(&self) -> DepthCopyFormat {
        DepthCopyFormat::from_bits(self.raw_format())
    }

    /// Luma/intensity conversion is enabled only when both BP52 controls are
    /// set. Neither bit changes the raw tile-encoder format by itself.
    pub fn intensity(&self) -> bool {
        self.intensity_format() && self.auto_convert()
    }
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default)]
pub struct InterruptStatus {
    #[bits(0)]
    pub token_enabled: bool,
    #[bits(1)]
    pub finish_enabled: bool,
    #[bits(2)]
    pub token: bool,
    #[bits(3)]
    pub finish: bool,
}

#[bitos(3)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompareMode {
    #[default]
    Never          = 0x0,
    Less           = 0x1,
    Equal          = 0x2,
    LessOrEqual    = 0x3,
    Greater        = 0x4,
    NotEqual       = 0x5,
    GreaterOrEqual = 0x6,
    Always         = 0x7,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DepthMode {
    #[bits(0)]
    pub enable: bool,
    #[bits(1..4)]
    pub compare: CompareMode,
    #[bits(4)]
    pub update: bool,
}

#[bitos(3)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SrcBlendFactor {
    #[default]
    Zero            = 0x0,
    One             = 0x1,
    DstColor        = 0x2,
    InverseDstColor = 0x3,
    SrcAlpha        = 0x4,
    InverseSrcAlpha = 0x5,
    DstAlpha        = 0x6,
    InverseDstAlpha = 0x7,
}

#[bitos(3)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DstBlendFactor {
    #[default]
    Zero            = 0x0,
    One             = 0x1,
    SrcColor        = 0x2,
    InverseSrcColor = 0x3,
    SrcAlpha        = 0x4,
    InverseSrcAlpha = 0x5,
    DstAlpha        = 0x6,
    InverseDstAlpha = 0x7,
}

#[bitos(4)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BlendLogicOp {
    #[default]
    Clear       = 0x0,
    And         = 0x1,
    ReverseAnd  = 0x2,
    Copy        = 0x3,
    InverseAnd  = 0x4,
    Noop        = 0x5,
    Xor         = 0x6,
    Or          = 0x7,
    Nor         = 0x8,
    Equiv       = 0x9,
    Inverse     = 0xA,
    ReverseOr   = 0xB,
    InverseCopy = 0xC,
    InverseOr   = 0xD,
    Nand        = 0xE,
    Set         = 0xF,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BlendMode {
    #[bits(0)]
    pub enable: bool,
    #[bits(1)]
    pub logic_op_enable: bool,
    #[bits(2)]
    pub dither_enable: bool,
    #[bits(3)]
    pub color_mask: bool,
    #[bits(4)]
    pub alpha_mask: bool,
    #[bits(5..8)]
    pub dst_factor: DstBlendFactor,
    #[bits(8..11)]
    pub src_factor: SrcBlendFactor,
    #[bits(11)]
    pub blend_subtract: bool,
    #[bits(12..16)]
    pub logic_op: BlendLogicOp,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScissorCorner {
    #[bits(0..11)]
    pub y_plus_342: u11,
    #[bits(12..23)]
    pub x_plus_342: u11,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScissorOffset {
    #[bits(0..10)]
    pub x_plus_342_div_2: u10,
    #[bits(10..20)]
    pub y_plus_342_div_2: u10,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Scissor {
    pub top_left: ScissorCorner,
    pub bottom_right: ScissorCorner,
    pub offset: ScissorOffset,
}

impl Scissor {
    pub fn top_left(&self) -> (u32, u32) {
        let base_x = self.top_left.x_plus_342().value() as u32;
        let base_y = self.top_left.y_plus_342().value() as u32;
        let x = base_x.saturating_sub(342);
        let y = base_y.saturating_sub(342);
        (x, y)
    }

    pub fn bottom_right(&self) -> (u32, u32) {
        let base_x = self.bottom_right.x_plus_342().value() as u32 + 1;
        let base_y = self.bottom_right.y_plus_342().value() as u32 + 1;
        let x = base_x.saturating_sub(342);
        let y = base_y.saturating_sub(342);
        (x, y)
    }

    pub fn dimensions(&self) -> (u32, u32) {
        let width = self
            .bottom_right
            .x_plus_342()
            .value()
            .saturating_sub(self.top_left.x_plus_342().value())
            + 1;

        let height = self
            .bottom_right
            .y_plus_342()
            .value()
            .saturating_sub(self.top_left.y_plus_342().value())
            + 1;

        (width as u32, height as u32)
    }

    pub fn offset(&self) -> (i32, i32) {
        let base_x = self.offset.x_plus_342_div_2().value() as u32 * 2;
        let base_y = self.offset.y_plus_342_div_2().value() as u32 * 2;
        let x = base_x as i32 - 342;
        let y = base_y as i32 - 342;
        (x, y)
    }
}

#[derive(Debug, Default)]
pub struct FramebufferCopy {
    pub src: CopySrc,
    pub dst: Address,
    pub dims: CopyDims,
    pub stride: u32,
    pub scale: u32,
    pub command: CopyCmd,
    pub filter: [u32; 2],
    pub clear_color: Abgr8,
    pub clear_depth: u32,
}

#[derive(Debug, Default)]
pub struct Interface {
    pub control: Control,
    pub interrupt: InterruptStatus,
    pub constant_alpha: ConstantAlpha,
    pub depth_mode: DepthMode,
    pub blend_mode: BlendMode,
    pub scissor: Scissor,
    pub copy: FramebufferCopy,
    pub token: u32,
}

impl Interface {
    pub fn write_interrupt(&mut self, status: u16) {
        self.interrupt.set_token_enabled(status.bit(0));
        self.interrupt.set_finish_enabled(status.bit(1));
        self.interrupt
            .set_token(self.interrupt.token() & !status.bit(2));
        self.interrupt
            .set_finish(self.interrupt.finish() & !status.bit(3));
    }
}

#[cfg(test)]
mod tests {
    use bitos::TryBits;

    use super::*;

    fn encoded_target_format(raw_format: u8) -> u8 {
        ((raw_format << 1) & 0xF) | (raw_format >> 3)
    }

    #[test]
    fn copy_command_decodes_every_rotated_target_format() {
        for encoded in 0..16 {
            let command = CopyCmd::from_bits(encoded << 3);
            let expected = (encoded >> 1) | ((encoded & 1) << 3);

            assert_eq!(command.target_format().value(), encoded as u8);
            assert_eq!(command.raw_format().value(), expected as u8);
            assert_eq!(command.color_format().to_bits().value(), expected as u8);
            assert_eq!(command.depth_format().to_bits().value(), expected as u8);
        }
    }

    #[test]
    fn copy_command_exposes_every_architected_field() {
        let bits = (1 << 0)
            | (1 << 1)
            | (1 << 2)
            | (encoded_target_format(5) as u32) << 3
            | (0b11 << 7)
            | (1 << 9)
            | (1 << 10)
            | (1 << 11)
            | (0b11 << 12)
            | (1 << 14)
            | (1 << 15)
            | (1 << 16);
        let command = CopyCmd::from_bits(bits);

        assert!(command.clamp_top());
        assert!(command.clamp_bottom());
        assert!(command.unknown_bit());
        assert_eq!(command.color_format(), ColorCopyFormat::RGB5A3);
        assert_eq!(command.gamma(), CopyGamma::Gamma2_2Reserved);
        assert!(command.half());
        assert!(command.scale_invert());
        assert!(command.clear());
        assert_eq!(command.frame_to_field(), FrameToField::InterlacedOdd);
        assert!(command.to_xfb());
        assert!(command.intensity_format());
        assert!(command.auto_convert());
        assert!(command.intensity());
    }

    #[test]
    fn copy_command_requires_both_intensity_controls() {
        for intensity_format in [false, true] {
            for auto_convert in [false, true] {
                let bits = ((intensity_format as u32) << 15) | ((auto_convert as u32) << 16);
                let command = CopyCmd::from_bits(bits);
                assert_eq!(command.intensity(), intensity_format && auto_convert);
            }
        }
    }

    #[test]
    fn copy_formats_preserve_exact_base_texture_semantics() {
        let rgb5a3 = CopyCmd::from_bits((encoded_target_format(5) as u32) << 3);
        assert_eq!(rgb5a3.color_format(), ColorCopyFormat::RGB5A3);
        assert_eq!(rgb5a3.color_format().texture_format(), tex::Format::RGB5A3);

        let z16r = CopyCmd::from_bits((encoded_target_format(0xB) as u32) << 3);
        assert_eq!(z16r.depth_format(), DepthCopyFormat::Z16R);
        assert_eq!(z16r.depth_format().texture_format(), tex::Format::IA8);

        let z16l = CopyCmd::from_bits((encoded_target_format(0xC) as u32) << 3);
        assert_eq!(z16l.depth_format(), DepthCopyFormat::Z16L);
        assert_eq!(z16l.depth_format().texture_format(), tex::Format::IA8);
    }
}
