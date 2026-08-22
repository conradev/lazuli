#![no_std]

//! Canonical LZGX packet layout and checked Rust encoder.
//!
//! This crate deliberately has no browser or renderer dependency. A resident
//! emulator can serialize a frame in Wasm, while the WebGPU renderer can reuse
//! the exact same constants and structural validation at its byte boundary.

extern crate alloc;

use alloc::vec;
use alloc::vec::Vec;
use core::fmt;

pub const MAGIC: [u8; 4] = *b"LZGX";
pub const VERSION_V2: u16 = 2;
pub const VERSION_V3: u16 = 3;
pub const VERSION_V4: u16 = 4;
pub const VERSION_V5: u16 = 5;
pub const VERSION_V6: u16 = 6;
pub const VERSION_V7: u16 = 7;
pub const HEADER_BYTES: u16 = 160;
pub const DRAW_RECORD_BYTES_V2: u16 = 128;
pub const DRAW_RECORD_BYTES: u16 = 176;
pub const TEXTURE_RECORD_BYTES: u16 = 64;
pub const TEV_STATE_BYTES: u32 = 464;
pub const VERTEX_BYTES: u32 = 144;
pub const TEXTURE_REFERENCE_ABSENT: u32 = u32::MAX;
pub const PACKET_ALIGNMENT: u32 = 16;
pub const MAX_TEXTURES: usize = 8;
pub const MAX_TEV_STAGES: usize = 16;
pub const PACKET_FLAG_TEXTURE_COPY_LAYOUT_V1: u32 = 1;
pub const PACKET_FLAG_INDIRECT_TEV_STATE_V1: u32 = 1 << 1;
pub const DRAW_FLAG_POST_CULL_IN_CLIP_F32_V1_COMPLETE: u16 = 1;
pub const DRAW_FLAG_EXACT_CLIP_INPUT_F32_V1_COMPLETE: u16 = 1 << 1;
pub const DRAW_FLAG_EXACT_CLIP_REQUIRED: u16 = 1 << 2;
pub const EXACT_CLIP_INPUT_ENCODING_F32_V1: u32 = 1;
pub const EXACT_CLIP_STATE_BYTES: u32 = 48;
pub const EXACT_CLIP_VERTEX_BYTES: u32 = 16;
pub const TEXTURE_FLAG_PAYLOAD: u32 = 1;
pub const MODE1_TAIL_BYTES_PER_DRAW: u32 = (MAX_TEXTURES as u32) * 4;
pub const INDIRECT_TEV_TAIL_BYTES_PER_DRAW: u32 = 128;
pub const INDIRECT_TEV_STATE_ENCODING_BP_WORDS_V1: u32 = 1;
pub const INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2: u32 = 2;
pub const SAMPLER_MODE0_MASK_V4: u32 = 0x0018_00ff;
pub const SAMPLER_MODE0_MASK_V7: u32 = 0x0039_ffff;
pub const SAMPLER_MODE1_MASK_V7: u32 = 0x0000_ffff;
pub const COPY_FLAG_CLEAR: u32 = 1;
pub const MAX_TEXTURE_DIMENSION: u32 = 1024;

const BP_WORD_MASK: u32 = 0x00ff_ffff;
const CANONICAL_QUIET_NAN_BITS: u32 = 0x7fc0_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum PacketVersion {
    V4 = VERSION_V4,
    V5 = VERSION_V5,
    V6 = VERSION_V6,
    V7 = VERSION_V7,
}

impl PacketVersion {
    pub const fn code(self) -> u16 {
        self as u16
    }

    pub const fn parse(value: u16) -> Option<Self> {
        match value {
            VERSION_V4 => Some(Self::V4),
            VERSION_V5 => Some(Self::V5),
            VERSION_V6 => Some(Self::V6),
            VERSION_V7 => Some(Self::V7),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum TerminalKind {
    TextureCopy = 1,
    XfbCopy     = 2,
    EfbPeek     = 3,
}

impl TerminalKind {
    pub const fn code(self) -> u32 {
        self as u32
    }

    pub const fn parse(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::TextureCopy),
            2 => Some(Self::XfbCopy),
            3 => Some(Self::EfbPeek),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CopyState {
    pub z_mode: u32,
    pub blend_mode: u32,
    pub pixel_control: u32,
    pub copy_command: u32,
    pub clear_rgba: [u8; 4],
    pub clear_depth: u32,
    pub copy_scale: u32,
    pub copy_filter: [u32; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalState {
    pub kind: TerminalKind,
    pub texture_copy_layout_v1: bool,
    pub source_x: u32,
    pub source_y: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub destination: u32,
    pub stride: u32,
    pub generation: u32,
    pub clear: bool,
    pub copy: CopyState,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FragmentState {
    pub pixel_control: u32,
    pub constant_alpha: u32,
    pub z_texture_bias: u32,
    pub z_texture_mode: u32,
    pub fog_range_base: u32,
    pub fog_range_k: [u32; 5],
    pub fog_words: [u32; 5],
    pub viewport_half_width_bits: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextureBinding {
    pub texture: Option<u32>,
    pub mode0: u32,
    pub mode1: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExactClipInput<'a> {
    pub bp_gen_mode: u32,
    pub bp_scissor_top_left: u32,
    pub bp_scissor_bottom_right: u32,
    pub bp_scissor_offset: u32,
    pub xf_clip_disable: u32,
    /// Exact little-endian f32 bit patterns, in GX viewport order.
    pub viewport_bits: [u32; 6],
    /// Four exact little-endian f32 bit patterns per source vertex.
    pub position_bits: &'a [u32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawEvidence<'a> {
    None,
    PostCull(&'a [u8]),
    Exact {
        required: bool,
        input: ExactClipInput<'a>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndirectTevState {
    pub encoding: u32,
    pub gen_mode: u32,
    pub matrices: [u32; 9],
    pub imask: u32,
    pub commands: [u32; 16],
    pub tex_scales: [u32; 2],
    pub iref: u32,
    pub xf_num_tex_gens: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct DrawInput<'a> {
    pub topology: u8,
    pub cull_mode: u8,
    /// Fixed-width vertex records. Length must be a multiple of [`VERTEX_BYTES`].
    pub vertices: &'a [u8],
    pub tev_state: &'a [u8; TEV_STATE_BYTES as usize],
    pub z_mode: u32,
    pub blend_mode: u32,
    pub alpha_test: u32,
    pub scissor_x: u32,
    pub scissor_y: u32,
    pub scissor_width: u32,
    pub scissor_height: u32,
    pub textures: [TextureBinding; MAX_TEXTURES],
    pub fragment: FragmentState,
    pub evidence: DrawEvidence<'a>,
    pub indirect_tev: Option<IndirectTevState>,
}

#[derive(Clone, Copy, Debug)]
pub struct TextureInput<'a> {
    pub key: &'a str,
    /// `None` means the renderer already owns the exact keyed payload.
    pub pixels: Option<&'a [u8]>,
    pub address: u32,
    pub generation: u32,
    pub width: u32,
    pub height: u32,
    pub mip_level_count: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct PacketInput<'a> {
    pub version: PacketVersion,
    pub terminal: TerminalState,
    pub draws: &'a [DrawInput<'a>],
    pub textures: &'a [TextureInput<'a>],
}

/// Checked immutable metadata for a canonical LZGX packet envelope.
///
/// Consumers that only schedule or route a packet can use this descriptor
/// without duplicating fixed header offsets. Renderer-specific draw and GX
/// semantics intentionally remain at the renderer boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvelopeInfo {
    pub version: PacketVersion,
    pub packet_bytes: u32,
    pub flags: u32,
    pub draw_count: u32,
    pub texture_count: u32,
    pub total_vertex_count: u32,
    pub terminal: TerminalState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BaseLayout {
    pub draw_table_offset: u32,
    pub texture_table_offset: u32,
    pub tev_offset: u32,
    pub vertex_offset: u32,
    pub key_offset: u32,
    pub pixel_offset: u32,
    pub draw_table_bytes: u32,
    pub texture_table_bytes: u32,
    pub tev_bytes: u32,
    pub vertex_bytes: u32,
    pub key_bytes: u32,
    pub pixel_bytes: u32,
    pub packet_base_bytes: u32,
}

impl BaseLayout {
    pub fn new(
        draw_count: u32,
        texture_count: u32,
        total_vertex_count: u32,
        key_bytes: u32,
        pixel_bytes: u32,
    ) -> Result<Self, PacketError> {
        if !pixel_bytes.is_multiple_of(PACKET_ALIGNMENT) {
            return Err(PacketError::NonCanonical(
                "pixel section byte length must be 16-byte aligned",
            ));
        }
        let draw_table_bytes =
            checked_mul(draw_count, u32::from(DRAW_RECORD_BYTES), "draw table bytes")?;
        let texture_table_bytes = checked_mul(
            texture_count,
            u32::from(TEXTURE_RECORD_BYTES),
            "texture table bytes",
        )?;
        let tev_bytes = checked_mul(draw_count, TEV_STATE_BYTES, "TEV bytes")?;
        let vertex_bytes = checked_mul(total_vertex_count, VERTEX_BYTES, "vertex bytes")?;
        let draw_table_offset = u32::from(HEADER_BYTES);
        let texture_table_offset =
            checked_add(draw_table_offset, draw_table_bytes, "texture table offset")?;
        let tev_offset = checked_add(texture_table_offset, texture_table_bytes, "TEV offset")?;
        let vertex_offset = checked_add(tev_offset, tev_bytes, "vertex offset")?;
        let key_offset = checked_add(vertex_offset, vertex_bytes, "key offset")?;
        let key_end = checked_add(key_offset, key_bytes, "key end")?;
        let pixel_offset = align_packet(key_end, "pixel offset")?;
        let packet_base_bytes = checked_add(pixel_offset, pixel_bytes, "base packet bytes")?;
        Ok(Self {
            draw_table_offset,
            texture_table_offset,
            tev_offset,
            vertex_offset,
            key_offset,
            pixel_offset,
            draw_table_bytes,
            texture_table_bytes,
            tev_bytes,
            vertex_bytes,
            key_bytes,
            pixel_bytes,
            packet_base_bytes,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TailLayout {
    pub evidence_offset: u32,
    pub evidence_end: u32,
    pub exact_clip_offset: u32,
    pub exact_clip_end: u32,
    pub mode1_offset: u32,
    pub version_tail_end: u32,
    pub indirect_tev_offset: u32,
    pub packet_bytes: u32,
}

impl TailLayout {
    pub fn new(
        version: PacketVersion,
        packet_base_bytes: u32,
        evidence_bytes: u32,
        exact_clip_bytes: u32,
        draw_count: u32,
        indirect_tev: bool,
    ) -> Result<Self, PacketError> {
        let evidence_offset = packet_base_bytes;
        let evidence_end = checked_add(evidence_offset, evidence_bytes, "evidence end")?;
        let exact_clip_offset = align_packet(evidence_end, "exact clip offset")?;
        let exact_clip_end = checked_add(exact_clip_offset, exact_clip_bytes, "exact clip end")?;
        let mode1_offset = exact_clip_end;
        let version_tail_end = match version {
            PacketVersion::V4 => exact_clip_offset,
            PacketVersion::V5 | PacketVersion::V6 => exact_clip_end,
            PacketVersion::V7 => checked_add(
                mode1_offset,
                checked_mul(draw_count, MODE1_TAIL_BYTES_PER_DRAW, "MODE1 tail bytes")?,
                "MODE1 tail end",
            )?,
        };
        let indirect_tev_offset = version_tail_end;
        let packet_bytes = if indirect_tev {
            checked_add(
                indirect_tev_offset,
                checked_mul(
                    draw_count,
                    INDIRECT_TEV_TAIL_BYTES_PER_DRAW,
                    "indirect TEV tail bytes",
                )?,
                "packet bytes",
            )?
        } else {
            indirect_tev_offset
        };
        Ok(Self {
            evidence_offset,
            evidence_end,
            exact_clip_offset,
            exact_clip_end,
            mode1_offset,
            version_tail_end,
            indirect_tev_offset,
            packet_bytes,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PacketError {
    TooShort,
    InvalidMagic,
    UnsupportedVersion(u16),
    LengthMismatch,
    Overflow(&'static str),
    InvalidField(&'static str),
    NonCanonical(&'static str),
    Allocation,
}

impl fmt::Display for PacketError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort => formatter.write_str("LZGX packet is too short"),
            Self::InvalidMagic => formatter.write_str("invalid LZGX packet magic"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported LZGX packet version {version}")
            }
            Self::LengthMismatch => formatter.write_str("LZGX packet length mismatch"),
            Self::Overflow(field) => write!(formatter, "LZGX {field} overflows u32"),
            Self::InvalidField(field) => write!(formatter, "invalid LZGX {field}"),
            Self::NonCanonical(field) => write!(formatter, "non-canonical LZGX {field}"),
            Self::Allocation => formatter.write_str("could not allocate LZGX packet"),
        }
    }
}

/// Encode a complete canonical packet without consulting JavaScript.
///
/// All sizes and guest-derived values are checked before allocation. The
/// encoder derives offsets, counts, record sizes, payload flags, and padding;
/// callers cannot supply those redundant wire fields.
pub fn encode(input: &PacketInput<'_>) -> Result<Vec<u8>, PacketError> {
    validate_terminal(&input.terminal)?;
    let draw_count = u32_len(input.draws.len(), "draw count")?;
    let texture_count = u32_len(input.textures.len(), "texture count")?;

    let indirect_tev = input.draws.iter().any(|draw| draw.indirect_tev.is_some());
    if indirect_tev && input.draws.iter().any(|draw| draw.indirect_tev.is_none()) {
        return Err(PacketError::NonCanonical(
            "indirect TEV packets require state for every draw",
        ));
    }

    let mut total_vertex_count = 0u32;
    let mut key_bytes = 0u32;
    let mut pixel_bytes = 0u32;
    let mut evidence_bytes = 0u32;
    let mut exact_clip_bytes = 0u32;
    let mut exact_count = 0u32;
    let mut required_exact_count = 0u32;
    let mut has_genuine_mip_binding = false;
    let mut has_semantic_indirect_tev = false;

    for (index, texture) in input.textures.iter().enumerate() {
        validate_texture(input.version, texture, index)?;
        if input.textures[..index]
            .iter()
            .any(|prior| prior.key == texture.key)
        {
            return Err(PacketError::NonCanonical("duplicate texture key"));
        }
        key_bytes = checked_add(
            key_bytes,
            u32_len(texture.key.len(), "texture key bytes")?,
            "key bytes",
        )?;
        if let Some(pixels) = texture.pixels {
            pixel_bytes = align_packet(pixel_bytes, "texture pixel offset")?;
            pixel_bytes = checked_add(
                pixel_bytes,
                u32_len(pixels.len(), "texture pixel bytes")?,
                "pixel bytes",
            )?;
        }
    }
    pixel_bytes = align_packet(pixel_bytes, "pixel bytes")?;

    let mut seen_textures = vec![false; input.textures.len()];
    let mut next_first_texture = 0usize;
    for draw in input.draws {
        let vertex_count = validate_draw(input.version, draw)?;
        total_vertex_count = checked_add(total_vertex_count, vertex_count, "total vertex count")?;
        match draw.evidence {
            DrawEvidence::None => {}
            DrawEvidence::PostCull(bytes) => {
                evidence_bytes = checked_add(
                    evidence_bytes,
                    u32_len(bytes.len(), "post-cull evidence bytes")?,
                    "post-cull evidence bytes",
                )?;
            }
            DrawEvidence::Exact { required, .. } => {
                exact_count = checked_add(exact_count, 1, "exact clip count")?;
                if required {
                    required_exact_count =
                        checked_add(required_exact_count, 1, "required exact clip count")?;
                }
                exact_clip_bytes = checked_add(
                    exact_clip_bytes,
                    checked_add(
                        EXACT_CLIP_STATE_BYTES,
                        checked_mul(vertex_count, EXACT_CLIP_VERTEX_BYTES, "exact positions")?,
                        "exact clip chunk",
                    )?,
                    "exact clip bytes",
                )?;
            }
        }
        if let Some(indirect) = draw.indirect_tev {
            validate_indirect_tev(&indirect)?;
            let tev_stage_count = tev_stage_count(draw.tev_state);
            if ((indirect.gen_mode >> 10) & 0xf) + 1 != tev_stage_count {
                return Err(PacketError::NonCanonical(
                    "indirect TEV generation stage count",
                ));
            }
            if (indirect.gen_mode >> 14) & 3 != u32::from(draw.cull_mode) {
                return Err(PacketError::NonCanonical(
                    "indirect TEV generation cull mode",
                ));
            }
            if let DrawEvidence::Exact { input, .. } = draw.evidence
                && input.bp_gen_mode != indirect.gen_mode
            {
                return Err(PacketError::NonCanonical(
                    "indirect TEV exact-clip generation mode",
                ));
            }
            let num_tex_gens = indirect_num_tex_gens(&indirect);
            let direct_requires_gen_mode = num_tex_gens == 0
                || (0..tev_stage_count.min(MAX_TEV_STAGES as u32)).any(|stage| {
                    let references = tev_stage_references(draw.tev_state, stage as usize);
                    references & (1 << 6) != 0 && ((references >> 3) & 7) >= num_tex_gens
                });
            has_semantic_indirect_tev |= ((indirect.gen_mode >> 16) & 7) != 0
                || direct_requires_gen_mode
                || indirect.commands[..tev_stage_count.min(MAX_TEV_STAGES as u32) as usize]
                    .iter()
                    .any(|command| *command & 0x001f_ffff != 0);
        }

        let required_texture_maps =
            required_texture_maps(draw.tev_state, draw.indirect_tev.as_ref())?;
        for (map, binding) in draw.textures.into_iter().enumerate() {
            validate_binding(input.version, binding)?;
            if required_texture_maps[map] != binding.texture.is_some() {
                return Err(PacketError::NonCanonical(
                    "TEV texture binding does not match live dataflow",
                ));
            }
            let Some(texture_index) = binding.texture else {
                continue;
            };
            let texture_index = usize::try_from(texture_index)
                .map_err(|_| PacketError::InvalidField("texture reference"))?;
            let texture = input
                .textures
                .get(texture_index)
                .ok_or(PacketError::InvalidField("texture reference"))?;
            if !seen_textures[texture_index] {
                if texture_index != next_first_texture {
                    return Err(PacketError::NonCanonical("texture first-use order"));
                }
                seen_textures[texture_index] = true;
                next_first_texture += 1;
            }
            if input.version == PacketVersion::V7 {
                let derived = texture_binding_mip_level_count(
                    texture.width,
                    texture.height,
                    binding.mode0,
                    binding.mode1,
                )?;
                if derived != texture.mip_level_count {
                    return Err(PacketError::NonCanonical(
                        "texture mip count conflicts with sampler",
                    ));
                }
                has_genuine_mip_binding |= derived > 1;
            }
        }
    }
    if next_first_texture != input.textures.len() {
        return Err(PacketError::NonCanonical("unreferenced texture record"));
    }
    if indirect_tev && !has_semantic_indirect_tev {
        return Err(PacketError::NonCanonical("inert indirect TEV feature"));
    }

    match input.version {
        PacketVersion::V4 if exact_count != 0 => {
            return Err(PacketError::NonCanonical("v4 exact clip input"));
        }
        PacketVersion::V5 if exact_count == 0 || required_exact_count != 0 => {
            return Err(PacketError::NonCanonical("v5 exact clip contract"));
        }
        PacketVersion::V6 if required_exact_count == 0 => {
            return Err(PacketError::NonCanonical("v6 required exact clip contract"));
        }
        PacketVersion::V7 if !has_genuine_mip_binding => {
            return Err(PacketError::NonCanonical(
                "v7 requires a referenced mip chain",
            ));
        }
        _ => {}
    }

    let base = BaseLayout::new(
        draw_count,
        texture_count,
        total_vertex_count,
        key_bytes,
        pixel_bytes,
    )?;
    let tail = TailLayout::new(
        input.version,
        base.packet_base_bytes,
        evidence_bytes,
        exact_clip_bytes,
        draw_count,
        indirect_tev,
    )?;
    let packet_len =
        usize::try_from(tail.packet_bytes).map_err(|_| PacketError::Overflow("packet bytes"))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(packet_len)
        .map_err(|_| PacketError::Allocation)?;
    bytes.resize(packet_len, 0);

    encode_header(
        &mut bytes,
        input,
        &base,
        tail.packet_bytes,
        total_vertex_count,
        indirect_tev,
    );

    let mut vertex_relative_offset = 0u32;
    let mut evidence_offset = tail.evidence_offset;
    let mut exact_offset = tail.exact_clip_offset;
    for (draw_index, draw) in input.draws.iter().enumerate() {
        let draw_index_u32 = u32_len(draw_index, "draw index")?;
        let record_offset = checked_add(
            base.draw_table_offset,
            checked_mul(
                draw_index_u32,
                u32::from(DRAW_RECORD_BYTES),
                "draw record offset",
            )?,
            "draw record offset",
        )?;
        let vertex_count = u32_len(
            draw.vertices.len() / VERTEX_BYTES as usize,
            "draw vertex count",
        )?;
        let draw_flags = match draw.evidence {
            DrawEvidence::None => 0,
            DrawEvidence::PostCull(_) => DRAW_FLAG_POST_CULL_IN_CLIP_F32_V1_COMPLETE,
            DrawEvidence::Exact {
                required: false, ..
            } => DRAW_FLAG_EXACT_CLIP_INPUT_F32_V1_COMPLETE,
            DrawEvidence::Exact { required: true, .. } => {
                DRAW_FLAG_EXACT_CLIP_INPUT_F32_V1_COMPLETE | DRAW_FLAG_EXACT_CLIP_REQUIRED
            }
        };
        encode_draw_record(
            &mut bytes,
            record_offset,
            draw,
            draw_flags,
            vertex_count,
            vertex_relative_offset,
            checked_mul(draw_index_u32, TEV_STATE_BYTES, "draw TEV offset")?,
        );

        let tev_destination = checked_add(
            base.tev_offset,
            checked_mul(draw_index_u32, TEV_STATE_BYTES, "draw TEV offset")?,
            "draw TEV destination",
        )?;
        copy_at(&mut bytes, tev_destination, draw.tev_state)?;
        let vertex_destination = checked_add(
            base.vertex_offset,
            vertex_relative_offset,
            "draw vertex destination",
        )?;
        copy_at(&mut bytes, vertex_destination, draw.vertices)?;
        vertex_relative_offset = checked_add(
            vertex_relative_offset,
            u32_len(draw.vertices.len(), "draw vertex bytes")?,
            "vertex offset",
        )?;

        match draw.evidence {
            DrawEvidence::None => {}
            DrawEvidence::PostCull(evidence) => {
                copy_at(&mut bytes, evidence_offset, evidence)?;
                evidence_offset = checked_add(
                    evidence_offset,
                    u32_len(evidence.len(), "evidence bytes")?,
                    "evidence offset",
                )?;
            }
            DrawEvidence::Exact { input, .. } => {
                encode_exact_clip(&mut bytes, exact_offset, input)?;
                exact_offset = checked_add(
                    exact_offset,
                    checked_add(
                        EXACT_CLIP_STATE_BYTES,
                        checked_mul(vertex_count, EXACT_CLIP_VERTEX_BYTES, "exact clip bytes")?,
                        "exact clip bytes",
                    )?,
                    "exact clip offset",
                )?;
            }
        }

        if input.version == PacketVersion::V7 {
            let mode1_offset = checked_add(
                tail.mode1_offset,
                checked_mul(
                    draw_index_u32,
                    MODE1_TAIL_BYTES_PER_DRAW,
                    "MODE1 draw offset",
                )?,
                "MODE1 draw offset",
            )?;
            for (map, binding) in draw.textures.iter().enumerate() {
                put_u32(
                    &mut bytes,
                    checked_add(
                        mode1_offset,
                        checked_mul(u32_len(map, "texture map")?, 4, "MODE1 map offset")?,
                        "MODE1 map offset",
                    )?,
                    binding.mode1,
                )?;
            }
        }
        if let Some(indirect) = draw.indirect_tev {
            let indirect_offset = checked_add(
                tail.indirect_tev_offset,
                checked_mul(
                    draw_index_u32,
                    INDIRECT_TEV_TAIL_BYTES_PER_DRAW,
                    "indirect draw offset",
                )?,
                "indirect draw offset",
            )?;
            encode_indirect_tev(&mut bytes, indirect_offset, indirect)?;
        }
    }

    let mut key_offset = base.key_offset;
    let mut pixel_offset = 0u32;
    for (texture_index, texture) in input.textures.iter().enumerate() {
        let texture_index_u32 = u32_len(texture_index, "texture index")?;
        let record_offset = checked_add(
            base.texture_table_offset,
            checked_mul(
                texture_index_u32,
                u32::from(TEXTURE_RECORD_BYTES),
                "texture record offset",
            )?,
            "texture record offset",
        )?;
        let key_len = u32_len(texture.key.len(), "texture key bytes")?;
        let key_relative_offset = key_offset
            .checked_sub(base.key_offset)
            .ok_or(PacketError::Overflow("texture key offset"))?;
        let (pixel_relative_offset, pixel_len, flags) = if let Some(pixels) = texture.pixels {
            pixel_offset = align_packet(pixel_offset, "texture pixel offset")?;
            let len = u32_len(pixels.len(), "texture pixel bytes")?;
            copy_at(
                &mut bytes,
                checked_add(base.pixel_offset, pixel_offset, "texture pixels")?,
                pixels,
            )?;
            let relative = pixel_offset;
            pixel_offset = checked_add(pixel_offset, len, "texture pixel end")?;
            (relative, len, TEXTURE_FLAG_PAYLOAD)
        } else {
            (0, 0, 0)
        };
        put_u32(&mut bytes, record_offset, key_relative_offset)?;
        put_u32(&mut bytes, record_offset + 0x04, key_len)?;
        put_u32(&mut bytes, record_offset + 0x08, pixel_relative_offset)?;
        put_u32(&mut bytes, record_offset + 0x0c, pixel_len)?;
        put_u32(&mut bytes, record_offset + 0x10, texture.address)?;
        put_u32(&mut bytes, record_offset + 0x14, texture.generation)?;
        put_u32(&mut bytes, record_offset + 0x18, texture.width)?;
        put_u32(&mut bytes, record_offset + 0x1c, texture.height)?;
        put_u32(&mut bytes, record_offset + 0x20, flags)?;
        if input.version == PacketVersion::V7 {
            put_u32(&mut bytes, record_offset + 0x24, texture.mip_level_count)?;
        }
        copy_at(&mut bytes, key_offset, texture.key.as_bytes())?;
        key_offset = checked_add(key_offset, key_len, "texture key end")?;
    }

    validate_envelope(&bytes)?;
    Ok(bytes)
}

/// Validate the versioned fixed-width envelope and all canonical offsets.
/// Renderer-specific GX semantic validation intentionally remains downstream.
pub fn validate_envelope(bytes: &[u8]) -> Result<(), PacketError> {
    inspect_envelope(bytes).map(|_| ())
}

/// Inspect a canonical fixed-width envelope without duplicating wire offsets.
///
/// This performs the same validation as [`validate_envelope`] and returns only
/// immutable routing/presentation metadata. It does not replace the renderer's
/// deeper per-draw and texture validation.
pub fn inspect_envelope(bytes: &[u8]) -> Result<EnvelopeInfo, PacketError> {
    if bytes.len() < usize::from(HEADER_BYTES) {
        return Err(PacketError::TooShort);
    }
    if bytes.get(0..4) != Some(MAGIC.as_slice()) {
        return Err(PacketError::InvalidMagic);
    }
    let version_code = read_u16(bytes, 0x04)?;
    let version =
        PacketVersion::parse(version_code).ok_or(PacketError::UnsupportedVersion(version_code))?;
    if read_u16(bytes, 0x06)? != HEADER_BYTES {
        return Err(PacketError::NonCanonical("header byte length"));
    }
    let packet_bytes = read_u32(bytes, 0x08)?;
    if usize::try_from(packet_bytes).ok() != Some(bytes.len()) {
        return Err(PacketError::LengthMismatch);
    }
    let flags = read_u32(bytes, 0x0c)?;
    if flags & !(PACKET_FLAG_TEXTURE_COPY_LAYOUT_V1 | PACKET_FLAG_INDIRECT_TEV_STATE_V1) != 0 {
        return Err(PacketError::InvalidField("packet flags"));
    }
    let terminal_kind = TerminalKind::parse(read_u32(bytes, 0x10)?)
        .ok_or(PacketError::InvalidField("terminal kind"))?;
    let copy_flags = read_u32(bytes, 0x70)?;
    if copy_flags & !COPY_FLAG_CLEAR != 0 {
        return Err(PacketError::InvalidField("copy flags"));
    }
    let terminal = TerminalState {
        kind: terminal_kind,
        texture_copy_layout_v1: flags & PACKET_FLAG_TEXTURE_COPY_LAYOUT_V1 != 0,
        source_x: read_u32(bytes, 0x4c)?,
        source_y: read_u32(bytes, 0x50)?,
        source_width: read_u32(bytes, 0x54)?,
        source_height: read_u32(bytes, 0x58)?,
        output_width: read_u32(bytes, 0x5c)?,
        output_height: read_u32(bytes, 0x60)?,
        destination: read_u32(bytes, 0x64)?,
        stride: read_u32(bytes, 0x68)?,
        generation: read_u32(bytes, 0x6c)?,
        clear: copy_flags & COPY_FLAG_CLEAR != 0,
        copy: CopyState {
            z_mode: read_u32(bytes, 0x80)?,
            blend_mode: read_u32(bytes, 0x84)?,
            pixel_control: read_u32(bytes, 0x88)?,
            copy_command: read_u32(bytes, 0x8c)?,
            clear_rgba: [
                read_u8(bytes, 0x74)?,
                read_u8(bytes, 0x75)?,
                read_u8(bytes, 0x76)?,
                read_u8(bytes, 0x77)?,
            ],
            clear_depth: read_u32(bytes, 0x90)?,
            copy_scale: read_u32(bytes, 0x94)?,
            copy_filter: [read_u32(bytes, 0x98)?, read_u32(bytes, 0x9c)?],
        },
    };
    validate_terminal(&terminal)?;
    if read_u16(bytes, 0x78)? != DRAW_RECORD_BYTES || read_u16(bytes, 0x7a)? != TEXTURE_RECORD_BYTES
    {
        return Err(PacketError::NonCanonical("record byte length"));
    }
    let draw_count = read_u32(bytes, 0x14)?;
    let texture_count = read_u32(bytes, 0x18)?;
    let total_vertex_count = read_u32(bytes, 0x7c)?;
    let key_bytes = read_u32(bytes, 0x44)?;
    let pixel_bytes = read_u32(bytes, 0x48)?;
    let base = BaseLayout::new(
        draw_count,
        texture_count,
        total_vertex_count,
        key_bytes,
        pixel_bytes,
    )?;
    for (offset, expected) in [
        (0x1c, base.draw_table_offset),
        (0x20, base.texture_table_offset),
        (0x24, base.tev_offset),
        (0x28, base.vertex_offset),
        (0x2c, base.key_offset),
        (0x30, base.pixel_offset),
        (0x34, base.draw_table_bytes),
        (0x38, base.texture_table_bytes),
        (0x3c, base.tev_bytes),
        (0x40, base.vertex_bytes),
    ] {
        if read_u32(bytes, offset)? != expected {
            return Err(PacketError::NonCanonical("section layout"));
        }
    }
    let key_end = checked_add(base.key_offset, base.key_bytes, "key end")?;
    require_zero(bytes, key_end, base.pixel_offset)?;
    if base.packet_base_bytes > packet_bytes {
        return Err(PacketError::LengthMismatch);
    }

    let mut evidence_bytes = 0u32;
    let mut exact_clip_bytes = 0u32;
    let mut exact_count = 0u32;
    let mut required_exact_count = 0u32;
    for draw_index in 0..draw_count {
        let record_offset = checked_add(
            base.draw_table_offset,
            checked_mul(
                draw_index,
                u32::from(DRAW_RECORD_BYTES),
                "draw record offset",
            )?,
            "draw record offset",
        )?;
        let topology = read_u8(bytes, record_offset)?;
        let flags = read_u16_at(bytes, checked_add(record_offset, 2, "draw flags")?)?;
        let vertex_count = read_u32_at(bytes, checked_add(record_offset, 4, "vertex count")?)?;
        match flags {
            0 => {}
            DRAW_FLAG_POST_CULL_IN_CLIP_F32_V1_COMPLETE => {
                let triangles = source_triangle_count(topology, vertex_count)?;
                if triangles == 0 {
                    return Err(PacketError::NonCanonical("empty post-cull evidence"));
                }
                evidence_bytes = checked_add(
                    evidence_bytes,
                    triangle_action_bytes(triangles),
                    "evidence bytes",
                )?;
            }
            value
                if value == DRAW_FLAG_EXACT_CLIP_INPUT_F32_V1_COMPLETE
                    || value
                        == (DRAW_FLAG_EXACT_CLIP_INPUT_F32_V1_COMPLETE
                            | DRAW_FLAG_EXACT_CLIP_REQUIRED) =>
            {
                if source_triangle_count(topology, vertex_count)? == 0 {
                    return Err(PacketError::NonCanonical("empty exact clip input"));
                }
                exact_count = checked_add(exact_count, 1, "exact count")?;
                if flags & DRAW_FLAG_EXACT_CLIP_REQUIRED != 0 {
                    required_exact_count =
                        checked_add(required_exact_count, 1, "required exact count")?;
                }
                exact_clip_bytes = checked_add(
                    exact_clip_bytes,
                    checked_add(
                        EXACT_CLIP_STATE_BYTES,
                        checked_mul(vertex_count, EXACT_CLIP_VERTEX_BYTES, "exact positions")?,
                        "exact chunk",
                    )?,
                    "exact bytes",
                )?;
            }
            _ => return Err(PacketError::InvalidField("draw flags")),
        }
    }
    match version {
        PacketVersion::V4 if exact_count != 0 => {
            return Err(PacketError::NonCanonical("v4 exact clip input"));
        }
        PacketVersion::V5 if exact_count == 0 || required_exact_count != 0 => {
            return Err(PacketError::NonCanonical("v5 exact clip contract"));
        }
        PacketVersion::V6 if required_exact_count == 0 => {
            return Err(PacketError::NonCanonical("v6 exact clip contract"));
        }
        _ => {}
    }
    let tail = TailLayout::new(
        version,
        base.packet_base_bytes,
        evidence_bytes,
        exact_clip_bytes,
        draw_count,
        flags & PACKET_FLAG_INDIRECT_TEV_STATE_V1 != 0,
    )?;
    if tail.packet_bytes != packet_bytes {
        return Err(PacketError::LengthMismatch);
    }
    require_zero(bytes, tail.evidence_end, tail.exact_clip_offset)?;
    Ok(EnvelopeInfo {
        version,
        packet_bytes,
        flags,
        draw_count,
        texture_count,
        total_vertex_count,
        terminal,
    })
}

/// Return the exact texture-map dataflow claimed by a fixed TEV state.
///
/// This is host-neutral packet semantics: ordinary direct stages contribute
/// enabled maps, while active indirect commands contribute their IREF maps.
/// XF `NUMTEXGENS=0` suppresses direct texture lookup exactly as GX does.
pub fn required_texture_maps(
    state: &[u8; TEV_STATE_BYTES as usize],
    indirect: Option<&IndirectTevState>,
) -> Result<[bool; MAX_TEXTURES], PacketError> {
    let stage_count = tev_stage_count(state);
    if stage_count > MAX_TEV_STAGES as u32 {
        return Err(PacketError::InvalidField("TEV stage count"));
    }
    let mut required = [false; MAX_TEXTURES];
    if indirect.is_none_or(|state| indirect_num_tex_gens(state) != 0) {
        for stage in 0..stage_count as usize {
            let references = tev_stage_references(state, stage);
            if references & (1 << 6) != 0 {
                required[(references & 7) as usize] = true;
            }
        }
    }
    if let Some(indirect) = indirect {
        let indirect_stage_count = ((indirect.gen_mode >> 16) & 7).min(4) as usize;
        let mut sampled = [false; 4];
        for command in indirect.commands[..stage_count as usize].iter().copied() {
            let command = command & 0x001f_ffff;
            let indirect_stage = (command & 3) as usize;
            let bump_alpha = (command >> 7) & 3;
            // Bits 9..=10 are the encoded indirect-matrix index. Bits
            // 11..=12 select the matrix component and do not make an
            // otherwise inert command sample a texture.
            let matrix = (command >> 9) & 3;
            if indirect_stage < indirect_stage_count && (bump_alpha != 0 || matrix != 0) {
                sampled[indirect_stage] = true;
            }
        }
        for (indirect_stage, sampled) in sampled.into_iter().enumerate() {
            if sampled {
                required[((indirect.iref >> (indirect_stage * 6)) & 7) as usize] = true;
            }
        }
    }
    Ok(required)
}

fn validate_terminal(terminal: &TerminalState) -> Result<(), PacketError> {
    if terminal.source_width == 0 || terminal.source_height == 0 {
        return Err(PacketError::InvalidField("source extent"));
    }
    for word in [
        terminal.copy.z_mode,
        terminal.copy.blend_mode,
        terminal.copy.pixel_control,
        terminal.copy.copy_command,
        terminal.copy.clear_depth,
        terminal.copy.copy_scale,
        terminal.copy.copy_filter[0],
        terminal.copy.copy_filter[1],
    ] {
        require_bp_word(word)?;
    }
    if terminal.clear != (terminal.copy.copy_command & 0x0800 != 0) {
        return Err(PacketError::NonCanonical("clear flag and copy command"));
    }
    match terminal.kind {
        TerminalKind::TextureCopy if terminal.copy.copy_command & 0x4000 != 0 => {
            return Err(PacketError::NonCanonical("texture copy command kind"));
        }
        TerminalKind::XfbCopy if terminal.copy.copy_command & 0x4000 == 0 => {
            return Err(PacketError::NonCanonical("XFB copy command kind"));
        }
        TerminalKind::EfbPeek
            if terminal.copy.copy_command != 0
                || terminal.clear
                || terminal.texture_copy_layout_v1 =>
        {
            return Err(PacketError::NonCanonical("EFB peek copy state"));
        }
        TerminalKind::XfbCopy if terminal.texture_copy_layout_v1 => {
            return Err(PacketError::NonCanonical("XFB texture-copy layout flag"));
        }
        _ => {}
    }
    match terminal.kind {
        TerminalKind::TextureCopy if terminal.texture_copy_layout_v1 => {
            if terminal.output_width == 0
                || terminal.output_height == 0
                || !terminal.stride.is_multiple_of(32)
                || terminal.stride > 0x1fff_ffe0
            {
                return Err(PacketError::InvalidField("texture-copy layout"));
            }
        }
        TerminalKind::TextureCopy => {
            if terminal.output_width != 0 || terminal.output_height != 0 || terminal.stride != 0 {
                return Err(PacketError::NonCanonical("legacy texture-copy layout"));
            }
        }
        TerminalKind::XfbCopy => {
            if terminal.output_width == 0
                || terminal.output_height == 0
                || terminal.stride == 0
                || terminal.output_width.max(terminal.output_height) > 1024
            {
                return Err(PacketError::InvalidField("XFB layout"));
            }
        }
        TerminalKind::EfbPeek => {
            if terminal.source_x >= 640
                || terminal.source_y >= 528
                || terminal.source_width != 1
                || terminal.source_height != 1
                || terminal.output_width != 0
                || terminal.output_height != 0
                || terminal.destination > 1
                || terminal.stride > 2
                || terminal.generation == 0
                || terminal.copy.z_mode != 0
                || terminal.copy.blend_mode != 0
                || terminal.copy.clear_rgba != [0; 4]
                || terminal.copy.clear_depth != 0
                || terminal.copy.copy_scale != 0
                || terminal.copy.copy_filter != [0; 2]
            {
                return Err(PacketError::NonCanonical("EFB peek terminal"));
            }
        }
    }
    Ok(())
}

fn validate_texture(
    version: PacketVersion,
    texture: &TextureInput<'_>,
    _index: usize,
) -> Result<(), PacketError> {
    if texture.key.is_empty() {
        return Err(PacketError::NonCanonical("empty texture key"));
    }
    if texture.width == 0
        || texture.height == 0
        || texture.width > MAX_TEXTURE_DIMENSION
        || texture.height > MAX_TEXTURE_DIMENSION
    {
        return Err(PacketError::InvalidField("texture dimensions"));
    }
    let theoretical = theoretical_mip_level_count(texture.width, texture.height);
    if texture.mip_level_count == 0 || texture.mip_level_count > theoretical {
        return Err(PacketError::InvalidField("texture mip level count"));
    }
    if version != PacketVersion::V7 && texture.mip_level_count != 1 {
        return Err(PacketError::NonCanonical("legacy texture mip count"));
    }
    if let Some(pixels) = texture.pixels {
        let expected =
            texture_mip_payload_bytes(texture.width, texture.height, texture.mip_level_count)?;
        if u32_len(pixels.len(), "texture pixel bytes")? != expected {
            return Err(PacketError::NonCanonical("texture pixel byte length"));
        }
    }
    Ok(())
}

fn validate_draw(version: PacketVersion, draw: &DrawInput<'_>) -> Result<u32, PacketError> {
    if draw.topology > 7 || draw.cull_mode > 3 {
        return Err(PacketError::InvalidField("draw topology or cull mode"));
    }
    if !draw.vertices.len().is_multiple_of(VERTEX_BYTES as usize) {
        return Err(PacketError::NonCanonical("vertex record byte length"));
    }
    let vertex_count = u32_len(draw.vertices.len() / VERTEX_BYTES as usize, "vertex count")?;
    validate_tev_state(draw.tev_state)?;
    for word in [
        draw.z_mode,
        draw.blend_mode,
        draw.alpha_test,
        draw.fragment.pixel_control,
        draw.fragment.constant_alpha,
        draw.fragment.z_texture_bias,
        draw.fragment.z_texture_mode,
        draw.fragment.fog_range_base,
    ]
    .into_iter()
    .chain(draw.fragment.fog_range_k)
    .chain(draw.fragment.fog_words)
    {
        require_bp_word(word)?;
    }
    if draw.fragment.fog_range_base & (1 << 10) != 0 {
        let viewport_half_width = f32::from_bits(draw.fragment.viewport_half_width_bits);
        if !viewport_half_width.is_finite() || viewport_half_width == 0.0 {
            return Err(PacketError::InvalidField("fog viewport half width"));
        }
    }
    for component in draw.vertices.chunks_exact(4) {
        let bits = u32::from_le_bytes([component[0], component[1], component[2], component[3]]);
        let value = f32::from_bits(bits);
        if value.is_nan() && bits != CANONICAL_QUIET_NAN_BITS {
            return Err(PacketError::NonCanonical("vertex NaN encoding"));
        }
        if matches!(draw.evidence, DrawEvidence::Exact { .. }) && !value.is_finite() {
            return Err(PacketError::InvalidField("exact source vertex component"));
        }
    }
    match draw.evidence {
        DrawEvidence::None => {}
        DrawEvidence::PostCull(evidence) => {
            if version == PacketVersion::V5 {
                // V5 permits either representation per draw; retained here.
            }
            let triangles = source_triangle_count(draw.topology, vertex_count)?;
            if triangles == 0 {
                return Err(PacketError::NonCanonical("empty post-cull evidence"));
            }
            let expected = triangle_action_bytes(triangles);
            if u32_len(evidence.len(), "post-cull evidence")? != expected {
                return Err(PacketError::NonCanonical("post-cull evidence byte length"));
            }
            let trailing = triangles % 4;
            if trailing != 0 {
                let last = evidence
                    .last()
                    .copied()
                    .ok_or(PacketError::NonCanonical("empty post-cull evidence"))?;
                if last >> (trailing * 2) != 0 {
                    return Err(PacketError::NonCanonical("post-cull padding bits"));
                }
            }
            for triangle in 0..triangles {
                let triangle_usize = usize::try_from(triangle)
                    .map_err(|_| PacketError::Overflow("triangle index"))?;
                let action = (evidence[triangle_usize / 4] >> ((triangle_usize % 4) * 2)) & 3;
                let permitted = match draw.cull_mode {
                    0 => action >= 2,
                    1 => action == 0 || action == 3,
                    2 => action == 1 || action == 2,
                    _ => action <= 1,
                };
                if !permitted {
                    return Err(PacketError::NonCanonical("post-cull action"));
                }
            }
        }
        DrawEvidence::Exact { required, input } => {
            if version == PacketVersion::V4 || (version == PacketVersion::V5 && required) {
                return Err(PacketError::NonCanonical("exact clip version"));
            }
            let triangles = source_triangle_count(draw.topology, vertex_count)?;
            if triangles == 0 {
                return Err(PacketError::NonCanonical("empty exact clip input"));
            }
            if input.bp_gen_mode >> 14 & 3 != u32::from(draw.cull_mode) {
                return Err(PacketError::NonCanonical("exact clip cull mode"));
            }
            for word in [
                input.bp_gen_mode,
                input.bp_scissor_top_left,
                input.bp_scissor_bottom_right,
                input.bp_scissor_offset,
            ] {
                require_bp_word(word)?;
            }
            if input.xf_clip_disable > 7 {
                return Err(PacketError::InvalidField("XF clip disable"));
            }
            let expected_components = checked_mul(vertex_count, 4, "exact position components")?;
            if u32_len(input.position_bits.len(), "exact position components")?
                != expected_components
            {
                return Err(PacketError::NonCanonical("exact position count"));
            }
            for bits in input
                .viewport_bits
                .into_iter()
                .chain(input.position_bits.iter().copied())
            {
                if !f32::from_bits(bits).is_finite() {
                    return Err(PacketError::InvalidField("exact clip f32"));
                }
            }
            if f32::from_bits(input.viewport_bits[0]) == 0.0
                || f32::from_bits(input.viewport_bits[1]) == 0.0
                || input.viewport_bits[0] != draw.fragment.viewport_half_width_bits
            {
                return Err(PacketError::NonCanonical("exact clip viewport"));
            }
        }
    }
    Ok(vertex_count)
}

fn validate_tev_state(state: &[u8; TEV_STATE_BYTES as usize]) -> Result<(), PacketError> {
    let stage_count = tev_stage_count(state);
    if stage_count > MAX_TEV_STAGES as u32 {
        return Err(PacketError::InvalidField("TEV stage count"));
    }
    if state[452..].iter().any(|byte| *byte != 0) {
        return Err(PacketError::NonCanonical("TEV padding"));
    }
    for stage in 0..MAX_TEV_STAGES {
        let offset = stage * 16;
        if stage >= stage_count as usize {
            if state[offset..offset + 16].iter().any(|byte| *byte != 0) {
                return Err(PacketError::NonCanonical("inactive TEV stage"));
            }
            continue;
        }
        for (field_offset, mask) in [
            (0, BP_WORD_MASK),
            (4, BP_WORD_MASK),
            (8, 0x3ff),
            (12, 0x3ff),
        ] {
            let start = offset + field_offset;
            let value = u32::from_le_bytes([
                state[start],
                state[start + 1],
                state[start + 2],
                state[start + 3],
            ]);
            if value & !mask != 0 {
                return Err(PacketError::NonCanonical("TEV stage field"));
            }
        }
    }
    for offset in (384..448).step_by(4) {
        let value = u32::from_le_bytes([
            state[offset],
            state[offset + 1],
            state[offset + 2],
            state[offset + 3],
        ]);
        if value > 3 {
            return Err(PacketError::InvalidField("TEV swap channel"));
        }
    }
    Ok(())
}

fn tev_stage_count(state: &[u8; TEV_STATE_BYTES as usize]) -> u32 {
    u32::from_le_bytes([state[448], state[449], state[450], state[451]])
}

fn tev_stage_references(state: &[u8; TEV_STATE_BYTES as usize], stage: usize) -> u32 {
    let offset = stage * 16 + 8;
    u32::from_le_bytes([
        state[offset],
        state[offset + 1],
        state[offset + 2],
        state[offset + 3],
    ])
}

fn indirect_num_tex_gens(state: &IndirectTevState) -> u32 {
    if state.encoding == INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2 {
        state.xf_num_tex_gens
    } else {
        state.gen_mode & 0xf
    }
}

fn validate_binding(version: PacketVersion, binding: TextureBinding) -> Result<(), PacketError> {
    if binding.texture.is_none() && (binding.mode0 != 0 || binding.mode1 != 0) {
        return Err(PacketError::NonCanonical("absent texture sampler"));
    }
    let mode0_mask = if version == PacketVersion::V7 {
        SAMPLER_MODE0_MASK_V7
    } else {
        SAMPLER_MODE0_MASK_V4
    };
    if binding.mode0 & !mode0_mask != 0 {
        return Err(PacketError::InvalidField("sampler MODE0"));
    }
    if version == PacketVersion::V7 {
        if binding.mode1 & !SAMPLER_MODE1_MASK_V7 != 0 || (binding.mode0 >> 5) & 3 == 3 {
            return Err(PacketError::InvalidField("sampler MODE1 or mip mode"));
        }
    } else if binding.mode1 != 0 {
        return Err(PacketError::NonCanonical("legacy MODE1"));
    }
    Ok(())
}

fn validate_indirect_tev(state: &IndirectTevState) -> Result<(), PacketError> {
    if !matches!(
        state.encoding,
        INDIRECT_TEV_STATE_ENCODING_BP_WORDS_V1 | INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2
    ) {
        return Err(PacketError::InvalidField("indirect TEV encoding"));
    }
    if state.encoding == INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2
        && state.xf_num_tex_gens > MAX_TEXTURES as u32
    {
        return Err(PacketError::InvalidField(
            "indirect XF texture generator count",
        ));
    }
    for word in [state.gen_mode, state.imask, state.iref]
        .into_iter()
        .chain(state.matrices)
        .chain(state.commands)
        .chain(state.tex_scales)
    {
        require_bp_word(word)?;
    }
    Ok(())
}

fn encode_header(
    bytes: &mut [u8],
    input: &PacketInput<'_>,
    base: &BaseLayout,
    packet_bytes: u32,
    total_vertex_count: u32,
    indirect_tev: bool,
) {
    bytes[0..4].copy_from_slice(&MAGIC);
    put_u16_unchecked(bytes, 0x04, input.version.code());
    put_u16_unchecked(bytes, 0x06, HEADER_BYTES);
    put_u32_unchecked(bytes, 0x08, packet_bytes);
    let flags = (u32::from(input.terminal.texture_copy_layout_v1)
        * PACKET_FLAG_TEXTURE_COPY_LAYOUT_V1)
        | (u32::from(indirect_tev) * PACKET_FLAG_INDIRECT_TEV_STATE_V1);
    put_u32_unchecked(bytes, 0x0c, flags);
    put_u32_unchecked(bytes, 0x10, input.terminal.kind.code());
    put_u32_unchecked(bytes, 0x14, input.draws.len() as u32);
    put_u32_unchecked(bytes, 0x18, input.textures.len() as u32);
    for (offset, value) in [
        (0x1c, base.draw_table_offset),
        (0x20, base.texture_table_offset),
        (0x24, base.tev_offset),
        (0x28, base.vertex_offset),
        (0x2c, base.key_offset),
        (0x30, base.pixel_offset),
        (0x34, base.draw_table_bytes),
        (0x38, base.texture_table_bytes),
        (0x3c, base.tev_bytes),
        (0x40, base.vertex_bytes),
        (0x44, base.key_bytes),
        (0x48, base.pixel_bytes),
        (0x4c, input.terminal.source_x),
        (0x50, input.terminal.source_y),
        (0x54, input.terminal.source_width),
        (0x58, input.terminal.source_height),
        (0x5c, input.terminal.output_width),
        (0x60, input.terminal.output_height),
        (0x64, input.terminal.destination),
        (0x68, input.terminal.stride),
        (0x6c, input.terminal.generation),
        (0x70, u32::from(input.terminal.clear) * COPY_FLAG_CLEAR),
    ] {
        put_u32_unchecked(bytes, offset, value);
    }
    bytes[0x74..0x78].copy_from_slice(&input.terminal.copy.clear_rgba);
    put_u16_unchecked(bytes, 0x78, DRAW_RECORD_BYTES);
    put_u16_unchecked(bytes, 0x7a, TEXTURE_RECORD_BYTES);
    for (offset, value) in [
        (0x7c, total_vertex_count),
        (0x80, input.terminal.copy.z_mode),
        (0x84, input.terminal.copy.blend_mode),
        (0x88, input.terminal.copy.pixel_control),
        (0x8c, input.terminal.copy.copy_command),
        (0x90, input.terminal.copy.clear_depth),
        (0x94, input.terminal.copy.copy_scale),
        (0x98, input.terminal.copy.copy_filter[0]),
        (0x9c, input.terminal.copy.copy_filter[1]),
    ] {
        put_u32_unchecked(bytes, offset, value);
    }
}

fn encode_draw_record(
    bytes: &mut [u8],
    offset: u32,
    draw: &DrawInput<'_>,
    flags: u16,
    vertex_count: u32,
    vertex_relative_offset: u32,
    tev_relative_offset: u32,
) {
    let offset = offset as usize;
    bytes[offset] = draw.topology;
    bytes[offset + 1] = draw.cull_mode;
    put_u16_unchecked(bytes, offset + 0x02, flags);
    for (relative, value) in [
        (0x04, vertex_count),
        (0x08, vertex_relative_offset),
        (0x0c, tev_relative_offset),
        (0x10, draw.z_mode),
        (0x14, draw.blend_mode),
        (0x18, draw.alpha_test),
        (0x1c, draw.scissor_x),
        (0x20, draw.scissor_y),
        (0x24, draw.scissor_width),
        (0x28, draw.scissor_height),
    ] {
        put_u32_unchecked(bytes, offset + relative, value);
    }
    for (map, binding) in draw.textures.iter().enumerate() {
        let slot = offset + 0x30 + map * 8;
        put_u32_unchecked(
            bytes,
            slot,
            binding.texture.unwrap_or(TEXTURE_REFERENCE_ABSENT),
        );
        put_u32_unchecked(bytes, slot + 4, binding.mode0);
    }
    let mut writer = offset + 0x70;
    for value in [
        draw.fragment.pixel_control,
        draw.fragment.constant_alpha,
        draw.fragment.z_texture_bias,
        draw.fragment.z_texture_mode,
        draw.fragment.fog_range_base,
    ]
    .into_iter()
    .chain(draw.fragment.fog_range_k)
    .chain(draw.fragment.fog_words)
    .chain(core::iter::once(draw.fragment.viewport_half_width_bits))
    {
        put_u32_unchecked(bytes, writer, value);
        writer += 4;
    }
}

fn encode_exact_clip(
    bytes: &mut [u8],
    offset: u32,
    input: ExactClipInput<'_>,
) -> Result<(), PacketError> {
    for (relative, value) in [
        (0x00, EXACT_CLIP_INPUT_ENCODING_F32_V1),
        (0x04, input.bp_gen_mode),
        (0x08, input.bp_scissor_top_left),
        (0x0c, input.bp_scissor_bottom_right),
        (0x10, input.bp_scissor_offset),
        (0x14, input.xf_clip_disable),
    ] {
        put_u32(
            bytes,
            checked_add(offset, relative, "exact clip field")?,
            value,
        )?;
    }
    let mut writer = checked_add(offset, 0x18, "exact viewport")?;
    for bits in input
        .viewport_bits
        .into_iter()
        .chain(input.position_bits.iter().copied())
    {
        put_u32(bytes, writer, bits)?;
        writer = checked_add(writer, 4, "exact clip component")?;
    }
    Ok(())
}

fn encode_indirect_tev(
    bytes: &mut [u8],
    offset: u32,
    state: IndirectTevState,
) -> Result<(), PacketError> {
    put_u32(bytes, offset, state.encoding)?;
    put_u32(bytes, offset + 0x04, state.gen_mode)?;
    for (index, word) in state.matrices.into_iter().enumerate() {
        put_u32(bytes, offset + 0x08 + u32_len(index, "matrix")? * 4, word)?;
    }
    put_u32(bytes, offset + 0x2c, state.imask)?;
    for (index, word) in state.commands.into_iter().enumerate() {
        put_u32(bytes, offset + 0x30 + u32_len(index, "command")? * 4, word)?;
    }
    put_u32(bytes, offset + 0x70, state.tex_scales[0])?;
    put_u32(bytes, offset + 0x74, state.tex_scales[1])?;
    put_u32(bytes, offset + 0x78, state.iref)?;
    put_u32(
        bytes,
        offset + 0x7c,
        if state.encoding == INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2 {
            state.xf_num_tex_gens
        } else {
            0
        },
    )?;
    Ok(())
}

fn texture_binding_mip_level_count(
    width: u32,
    height: u32,
    mode0: u32,
    mode1: u32,
) -> Result<u32, PacketError> {
    let mip_mode = (mode0 >> 5) & 3;
    if mip_mode == 3 {
        return Err(PacketError::InvalidField("reserved mip mode"));
    }
    if mip_mode == 0 {
        return Ok(1);
    }
    let theoretical = theoretical_mip_level_count(width, height);
    let requested = checked_add((mode1 >> 8 & 0xff).div_ceil(16), 1, "requested mips")?;
    Ok(theoretical.min(requested))
}

fn theoretical_mip_level_count(width: u32, height: u32) -> u32 {
    u32::BITS - width.max(height).leading_zeros()
}

fn texture_mip_payload_bytes(width: u32, height: u32, levels: u32) -> Result<u32, PacketError> {
    let mut width = width;
    let mut height = height;
    let mut bytes = 0u32;
    for _ in 0..levels {
        bytes = checked_add(
            bytes,
            checked_mul(checked_mul(width, height, "mip pixels")?, 4, "mip bytes")?,
            "mip payload bytes",
        )?;
        width = (width / 2).max(1);
        height = (height / 2).max(1);
    }
    Ok(bytes)
}

fn source_triangle_count(topology: u8, vertices: u32) -> Result<u32, PacketError> {
    match topology {
        0 | 1 => Ok(vertices / 4 * 2 + u32::from(vertices % 4 == 3)),
        2 => Ok(vertices / 3),
        3 => Ok(vertices.saturating_sub(2)),
        4 => Ok(vertices.saturating_sub(2)),
        5..=7 => Ok(0),
        _ => Err(PacketError::InvalidField("draw topology")),
    }
}

fn triangle_action_bytes(triangles: u32) -> u32 {
    triangles.div_ceil(4)
}

fn require_bp_word(value: u32) -> Result<(), PacketError> {
    if value & !BP_WORD_MASK != 0 {
        Err(PacketError::InvalidField("BP word"))
    } else {
        Ok(())
    }
}

fn checked_add(left: u32, right: u32, field: &'static str) -> Result<u32, PacketError> {
    left.checked_add(right).ok_or(PacketError::Overflow(field))
}

fn checked_mul(left: u32, right: u32, field: &'static str) -> Result<u32, PacketError> {
    left.checked_mul(right).ok_or(PacketError::Overflow(field))
}

fn align_packet(value: u32, field: &'static str) -> Result<u32, PacketError> {
    checked_add(value, PACKET_ALIGNMENT - 1, field).map(|value| value & !(PACKET_ALIGNMENT - 1))
}

fn u32_len(value: usize, field: &'static str) -> Result<u32, PacketError> {
    u32::try_from(value).map_err(|_| PacketError::Overflow(field))
}

fn copy_at(bytes: &mut [u8], offset: u32, source: &[u8]) -> Result<(), PacketError> {
    let start = usize::try_from(offset).map_err(|_| PacketError::Overflow("byte offset"))?;
    let end = start
        .checked_add(source.len())
        .ok_or(PacketError::Overflow("byte range"))?;
    let destination = bytes
        .get_mut(start..end)
        .ok_or(PacketError::LengthMismatch)?;
    destination.copy_from_slice(source);
    Ok(())
}

fn put_u32(bytes: &mut [u8], offset: u32, value: u32) -> Result<(), PacketError> {
    copy_at(bytes, offset, &value.to_le_bytes())
}

fn put_u16_unchecked(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32_unchecked(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn read_u8(bytes: &[u8], offset: u32) -> Result<u8, PacketError> {
    let offset = usize::try_from(offset).map_err(|_| PacketError::Overflow("byte offset"))?;
    bytes.get(offset).copied().ok_or(PacketError::TooShort)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, PacketError> {
    let end = offset.checked_add(2).ok_or(PacketError::TooShort)?;
    let value = bytes.get(offset..end).ok_or(PacketError::TooShort)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u16_at(bytes: &[u8], offset: u32) -> Result<u16, PacketError> {
    let offset = usize::try_from(offset).map_err(|_| PacketError::Overflow("byte offset"))?;
    read_u16(bytes, offset)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, PacketError> {
    let end = offset.checked_add(4).ok_or(PacketError::TooShort)?;
    let value = bytes.get(offset..end).ok_or(PacketError::TooShort)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_u32_at(bytes: &[u8], offset: u32) -> Result<u32, PacketError> {
    let offset = usize::try_from(offset).map_err(|_| PacketError::Overflow("byte offset"))?;
    read_u32(bytes, offset)
}

fn require_zero(bytes: &[u8], start: u32, end: u32) -> Result<(), PacketError> {
    let start = usize::try_from(start).map_err(|_| PacketError::Overflow("padding"))?;
    let end = usize::try_from(end).map_err(|_| PacketError::Overflow("padding"))?;
    let padding = bytes.get(start..end).ok_or(PacketError::TooShort)?;
    if padding.iter().any(|byte| *byte != 0) {
        Err(PacketError::NonCanonical("padding"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
