//! Strict parser for the versioned worker-to-WebGPU GX frame packet.
//!
//! LZGX packets deliberately use only fixed-width little-endian fields and
//! byte sections.  Keeping parsing here, rather than in the JavaScript bridge,
//! gives malformed worker messages one checked boundary before they reach
//! WebGPU while leaving the format native-testable.

use std::collections::HashSet;
use std::fmt;

use crate::tev::{MAX_TEV_STAGES, MAX_TEV_TEXTURES, required_texture_maps};

pub(crate) const GX_PACKET_MAGIC: [u8; 4] = *b"LZGX";
pub(crate) const GX_PACKET_VERSION: u16 = 3;
pub(crate) const GX_PACKET_HEADER_BYTES: u16 = 160;
pub(crate) const GX_DRAW_RECORD_BYTES: u16 = 176;
pub(crate) const GX_TEXTURE_RECORD_BYTES: u16 = 64;
pub(crate) const GX_TEV_STATE_BYTES: u32 = 464;
pub(crate) const GX_VERTEX_BYTES: u32 = 144;
pub(crate) const GX_TEXTURE_REFERENCE_ABSENT: u32 = u32::MAX;

const GX_PACKET_VERSION_V2: u16 = 2;
const GX_DRAW_RECORD_BYTES_V2: u16 = 128;
const PACKET_ALIGNMENT: u32 = 16;
const COPY_FLAG_CLEAR: u32 = 1;
const TEXTURE_FLAG_PAYLOAD: u32 = 1;
const SAMPLER_BITS_MASK: u32 = 0xff;
const GX_MAX_TEXTURE_DIMENSION: u32 = 1024;
const FOG_RANGE_ADJUSTMENT_ENABLE: u32 = 1 << 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxCopyKind {
    Texture,
    Xfb,
}

impl GxCopyKind {
    fn parse(value: u32) -> Result<Self, GxPacketError> {
        match value {
            1 => Ok(Self::Texture),
            2 => Ok(Self::Xfb),
            _ => Err(GxPacketError::InvalidField {
                field: "copy kind",
                value: u64::from(value),
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxCopyState {
    pub(crate) z_mode: u32,
    pub(crate) blend_mode: u32,
    pub(crate) pixel_control: u32,
    pub(crate) copy_command: u32,
    pub(crate) clear_rgba: [u8; 4],
    pub(crate) clear_depth: u32,
    pub(crate) copy_scale: u32,
    pub(crate) copy_filter: [u32; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxPacketHeader {
    pub(crate) packet_bytes: u32,
    pub(crate) copy_kind: GxCopyKind,
    pub(crate) draw_count: u32,
    pub(crate) texture_count: u32,
    pub(crate) draw_table_offset: u32,
    pub(crate) texture_table_offset: u32,
    pub(crate) tev_offset: u32,
    pub(crate) vertex_offset: u32,
    pub(crate) key_offset: u32,
    pub(crate) pixel_offset: u32,
    pub(crate) draw_table_bytes: u32,
    pub(crate) texture_table_bytes: u32,
    pub(crate) tev_bytes: u32,
    pub(crate) vertex_bytes: u32,
    pub(crate) key_bytes: u32,
    pub(crate) pixel_bytes: u32,
    pub(crate) source_x: u32,
    pub(crate) source_y: u32,
    pub(crate) source_width: u32,
    pub(crate) source_height: u32,
    pub(crate) output_width: u32,
    pub(crate) output_height: u32,
    pub(crate) destination: u32,
    pub(crate) stride: u32,
    pub(crate) generation: u32,
    pub(crate) clear: bool,
    pub(crate) copy_state: GxCopyState,
    pub(crate) total_vertex_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxTextureSlot {
    pub(crate) texture: Option<u32>,
    pub(crate) sampler_bits: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct GxFragmentTailState {
    pub(crate) pixel_control: u32,
    pub(crate) constant_alpha: u32,
    pub(crate) z_texture_bias: u32,
    pub(crate) z_texture_mode: u32,
    pub(crate) fog_range_base: u32,
    pub(crate) fog_range_k: [u32; 5],
    pub(crate) fog_words: [u32; 5],
    pub(crate) viewport_half_width_bits: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GxDrawRecord {
    pub(crate) topology: u8,
    pub(crate) cull_mode: u8,
    pub(crate) vertex_count: u32,
    pub(crate) vertex_relative_offset: u32,
    pub(crate) tev_relative_offset: u32,
    pub(crate) z_mode: u32,
    pub(crate) blend_mode: u32,
    pub(crate) alpha_test: u32,
    pub(crate) scissor_x: u32,
    pub(crate) scissor_y: u32,
    pub(crate) scissor_width: u32,
    pub(crate) scissor_height: u32,
    pub(crate) textures: [GxTextureSlot; MAX_TEV_TEXTURES],
    pub(crate) fragment_tail: GxFragmentTailState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GxTextureRecord {
    pub(crate) key_relative_offset: u32,
    pub(crate) key_len: u32,
    pub(crate) pixel_relative_offset: u32,
    pub(crate) pixel_len: u32,
    pub(crate) address: u32,
    pub(crate) generation: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) has_payload: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct GxDraw<'a> {
    pub(crate) record: &'a GxDrawRecord,
    pub(crate) tev_state: &'a [u8],
    pub(crate) vertex_bytes: &'a [u8],
}

impl GxDraw<'_> {
    pub(crate) fn vertex_floats(&self) -> impl ExactSizeIterator<Item = f32> + '_ {
        self.vertex_bytes
            .chunks_exact(size_of::<f32>())
            .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("four-byte GX vertex field")))
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct GxTexture<'a> {
    pub(crate) record: &'a GxTextureRecord,
    pub(crate) key: &'a str,
    pub(crate) pixels: &'a [u8],
}

#[derive(Clone, Debug)]
pub(crate) struct GxFramePacket<'a> {
    bytes: &'a [u8],
    header: GxPacketHeader,
    draws: Vec<GxDrawRecord>,
    textures: Vec<GxTextureRecord>,
}

impl<'a> GxFramePacket<'a> {
    pub(crate) fn parse(bytes: &'a [u8]) -> Result<Self, GxPacketError> {
        if bytes.len() < usize::from(GX_PACKET_HEADER_BYTES) {
            return Err(GxPacketError::TooShort {
                minimum: usize::from(GX_PACKET_HEADER_BYTES),
                actual: bytes.len(),
            });
        }
        if bytes[0..4] != GX_PACKET_MAGIC {
            return Err(GxPacketError::InvalidMagic(
                bytes[0..4].try_into().expect("checked packet magic"),
            ));
        }

        let version = read_u16(bytes, 0x04);
        let draw_record_bytes = match version {
            GX_PACKET_VERSION_V2 => GX_DRAW_RECORD_BYTES_V2,
            GX_PACKET_VERSION => GX_DRAW_RECORD_BYTES,
            _ => return Err(GxPacketError::UnsupportedVersion(version)),
        };
        expect_u16(
            "header bytes",
            read_u16(bytes, 0x06),
            GX_PACKET_HEADER_BYTES,
        )?;
        let packet_bytes = read_u32(bytes, 0x08);
        if u64::from(packet_bytes) != bytes.len() as u64 {
            return Err(GxPacketError::LengthMismatch {
                declared: packet_bytes,
                actual: bytes.len(),
            });
        }
        expect_u32("packet flags", read_u32(bytes, 0x0c), 0)?;
        let copy_kind = GxCopyKind::parse(read_u32(bytes, 0x10))?;
        let draw_count = read_u32(bytes, 0x14);
        let texture_count = read_u32(bytes, 0x18);
        let draw_table_offset = read_u32(bytes, 0x1c);
        let texture_table_offset = read_u32(bytes, 0x20);
        let tev_offset = read_u32(bytes, 0x24);
        let vertex_offset = read_u32(bytes, 0x28);
        let key_offset = read_u32(bytes, 0x2c);
        let pixel_offset = read_u32(bytes, 0x30);
        let draw_table_bytes = read_u32(bytes, 0x34);
        let texture_table_bytes = read_u32(bytes, 0x38);
        let tev_bytes = read_u32(bytes, 0x3c);
        let vertex_bytes = read_u32(bytes, 0x40);
        let key_bytes = read_u32(bytes, 0x44);
        let pixel_bytes = read_u32(bytes, 0x48);
        let source_x = read_u32(bytes, 0x4c);
        let source_y = read_u32(bytes, 0x50);
        let source_width = read_u32(bytes, 0x54);
        let source_height = read_u32(bytes, 0x58);
        let output_width = read_u32(bytes, 0x5c);
        let output_height = read_u32(bytes, 0x60);
        let destination = read_u32(bytes, 0x64);
        let stride = read_u32(bytes, 0x68);
        let generation = read_u32(bytes, 0x6c);
        let copy_flags = read_u32(bytes, 0x70);
        if copy_flags & !COPY_FLAG_CLEAR != 0 {
            return Err(GxPacketError::InvalidField {
                field: "copy flags",
                value: u64::from(copy_flags),
            });
        }
        let clear_rgba = bytes[0x74..0x78]
            .try_into()
            .expect("fixed clear-color field");
        expect_u16(
            "draw record bytes",
            read_u16(bytes, 0x78),
            draw_record_bytes,
        )?;
        expect_u16(
            "texture record bytes",
            read_u16(bytes, 0x7a),
            GX_TEXTURE_RECORD_BYTES,
        )?;
        let total_vertex_count = read_u32(bytes, 0x7c);
        let terminal_z_mode = read_bp_word(bytes, 0x80, "terminal Z mode")?;
        let terminal_blend_mode = read_bp_word(bytes, 0x84, "terminal blend mode")?;
        let pixel_control = read_bp_word(bytes, 0x88, "pixel control")?;
        let copy_command = read_bp_word(bytes, 0x8c, "copy command")?;
        let clear_depth = read_bp_word(bytes, 0x90, "clear depth")?;
        let copy_scale = read_bp_word(bytes, 0x94, "copy scale")?;
        let copy_filter = [
            read_bp_word(bytes, 0x98, "copy filter 0")?,
            read_bp_word(bytes, 0x9c, "copy filter 1")?,
        ];

        if (copy_flags & COPY_FLAG_CLEAR != 0) != (copy_command & 0x0800 != 0) {
            return Err(GxPacketError::NonCanonical(
                "copy clear flag must match the raw copy command",
            ));
        }
        if (copy_kind == GxCopyKind::Xfb) != (copy_command & 0x4000 != 0) {
            return Err(GxPacketError::NonCanonical(
                "copy kind must match the raw copy command",
            ));
        }

        if source_width == 0 || source_height == 0 {
            return Err(GxPacketError::InvalidField {
                field: "source extent",
                value: 0,
            });
        }
        match copy_kind {
            GxCopyKind::Texture => {
                if output_width != 0 || output_height != 0 || stride != 0 {
                    return Err(GxPacketError::NonCanonical(
                        "texture copies must have zero output width, output height, and stride",
                    ));
                }
            }
            GxCopyKind::Xfb => {
                if output_width == 0 || output_height == 0 || stride == 0 {
                    return Err(GxPacketError::InvalidField {
                        field: "XFB output extent/stride",
                        value: 0,
                    });
                }
                let maximum_output_dimension = output_width.max(output_height);
                if maximum_output_dimension > GX_MAX_TEXTURE_DIMENSION {
                    return Err(GxPacketError::InvalidField {
                        field: "XFB output extent",
                        value: u64::from(maximum_output_dimension),
                    });
                }
            }
        }

        let expected_draw_bytes =
            checked_mul(draw_count, u32::from(draw_record_bytes), "draw table size")?;
        let expected_texture_bytes = checked_mul(
            texture_count,
            u32::from(GX_TEXTURE_RECORD_BYTES),
            "texture table size",
        )?;
        let expected_tev_bytes = checked_mul(draw_count, GX_TEV_STATE_BYTES, "TEV section size")?;
        let expected_vertex_bytes =
            checked_mul(total_vertex_count, GX_VERTEX_BYTES, "vertex section size")?;
        expect_u32("draw table bytes", draw_table_bytes, expected_draw_bytes)?;
        expect_u32(
            "texture table bytes",
            texture_table_bytes,
            expected_texture_bytes,
        )?;
        expect_u32("TEV bytes", tev_bytes, expected_tev_bytes)?;
        expect_u32("vertex bytes", vertex_bytes, expected_vertex_bytes)?;

        let expected_draw_offset = u32::from(GX_PACKET_HEADER_BYTES);
        let expected_texture_offset = checked_add(
            expected_draw_offset,
            expected_draw_bytes,
            "texture table offset",
        )?;
        let expected_tev_offset = checked_add(
            expected_texture_offset,
            expected_texture_bytes,
            "TEV section offset",
        )?;
        let expected_vertex_offset = checked_add(
            expected_tev_offset,
            expected_tev_bytes,
            "vertex section offset",
        )?;
        let expected_key_offset = checked_add(
            expected_vertex_offset,
            expected_vertex_bytes,
            "key section offset",
        )?;
        let key_end = checked_add(expected_key_offset, key_bytes, "key section end")?;
        let expected_pixel_offset = align_packet(key_end, "pixel section offset")?;
        let expected_packet_bytes =
            checked_add(expected_pixel_offset, pixel_bytes, "packet byte length")?;
        for (field, actual, expected) in [
            ("draw table offset", draw_table_offset, expected_draw_offset),
            (
                "texture table offset",
                texture_table_offset,
                expected_texture_offset,
            ),
            ("TEV section offset", tev_offset, expected_tev_offset),
            (
                "vertex section offset",
                vertex_offset,
                expected_vertex_offset,
            ),
            ("key section offset", key_offset, expected_key_offset),
            ("pixel section offset", pixel_offset, expected_pixel_offset),
            ("packet bytes", packet_bytes, expected_packet_bytes),
        ] {
            expect_u32(field, actual, expected)?;
        }
        if !pixel_bytes.is_multiple_of(PACKET_ALIGNMENT) {
            return Err(GxPacketError::NonCanonical(
                "pixel section byte length must be 16-byte aligned",
            ));
        }
        require_zero(bytes, to_usize(key_end), to_usize(expected_pixel_offset))?;

        let header = GxPacketHeader {
            packet_bytes,
            copy_kind,
            draw_count,
            texture_count,
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
            source_x,
            source_y,
            source_width,
            source_height,
            output_width,
            output_height,
            destination,
            stride,
            generation,
            clear: copy_flags & COPY_FLAG_CLEAR != 0,
            copy_state: GxCopyState {
                z_mode: terminal_z_mode,
                blend_mode: terminal_blend_mode,
                pixel_control,
                copy_command,
                clear_rgba,
                clear_depth,
                copy_scale,
                copy_filter,
            },
            total_vertex_count,
        };

        let texture_count_usize = to_usize(texture_count);
        let mut seen_textures = vec![false; texture_count_usize];
        let mut next_first_texture = 0usize;
        let mut draws = Vec::with_capacity(to_usize(draw_count));
        let mut next_vertex_relative_offset = 0u32;
        let mut counted_vertices = 0u32;
        for draw_index in 0..to_usize(draw_count) {
            let record_offset =
                to_usize(draw_table_offset) + draw_index * usize::from(draw_record_bytes);
            let record = &bytes[record_offset..record_offset + usize::from(draw_record_bytes)];
            let topology = record[0x00];
            let cull_mode = record[0x01];
            expect_u16("draw flags", read_u16(record, 0x02), 0)?;
            if topology > 7 {
                return Err(GxPacketError::InvalidField {
                    field: "draw topology",
                    value: u64::from(topology),
                });
            }
            if cull_mode > 3 {
                return Err(GxPacketError::InvalidField {
                    field: "draw cull mode",
                    value: u64::from(cull_mode),
                });
            }
            let vertex_count = read_u32(record, 0x04);
            let vertex_relative_offset = read_u32(record, 0x08);
            let tev_relative_offset = read_u32(record, 0x0c);
            expect_u32(
                "draw vertex relative offset",
                vertex_relative_offset,
                next_vertex_relative_offset,
            )?;
            let expected_tev_relative_offset = checked_mul(
                u32::try_from(draw_index).expect("draw count originated as u32"),
                GX_TEV_STATE_BYTES,
                "draw TEV relative offset",
            )?;
            expect_u32(
                "draw TEV relative offset",
                tev_relative_offset,
                expected_tev_relative_offset,
            )?;
            let this_vertex_bytes =
                checked_mul(vertex_count, GX_VERTEX_BYTES, "draw vertex byte length")?;
            next_vertex_relative_offset = checked_add(
                next_vertex_relative_offset,
                this_vertex_bytes,
                "draw vertex end",
            )?;
            counted_vertices = checked_add(counted_vertices, vertex_count, "total draw vertices")?;

            let vertex_start =
                checked_add(vertex_offset, vertex_relative_offset, "draw vertex start")?;
            let vertex_end = checked_add(vertex_start, this_vertex_bytes, "draw vertex end")?;
            for component in bytes[to_usize(vertex_start)..to_usize(vertex_end)].chunks_exact(4) {
                let bits = u32::from_le_bytes(
                    component.try_into().expect("four-byte GX vertex component"),
                );
                if f32::from_bits(bits).is_nan() && bits != 0x7fc0_0000 {
                    return Err(GxPacketError::NonCanonical(
                        "vertex NaNs must use the canonical quiet-NaN encoding",
                    ));
                }
            }

            expect_u32("draw reserved word", read_u32(record, 0x2c), 0)?;
            let fragment_tail = if version == GX_PACKET_VERSION_V2 {
                require_zero(record, 0x70, usize::from(GX_DRAW_RECORD_BYTES_V2))?;
                GxFragmentTailState::default()
            } else {
                let fragment_tail = GxFragmentTailState {
                    pixel_control: read_bp_word(record, 0x70, "draw fragment pixel control")?,
                    constant_alpha: read_bp_word(record, 0x74, "draw fragment constant alpha")?,
                    z_texture_bias: read_bp_word(record, 0x78, "draw fragment Z-texture bias")?,
                    z_texture_mode: read_bp_word(record, 0x7c, "draw fragment Z-texture mode")?,
                    fog_range_base: read_bp_word(record, 0x80, "draw fragment fog range base")?,
                    fog_range_k: [
                        read_bp_word(record, 0x84, "draw fragment fog range coefficient")?,
                        read_bp_word(record, 0x88, "draw fragment fog range coefficient")?,
                        read_bp_word(record, 0x8c, "draw fragment fog range coefficient")?,
                        read_bp_word(record, 0x90, "draw fragment fog range coefficient")?,
                        read_bp_word(record, 0x94, "draw fragment fog range coefficient")?,
                    ],
                    fog_words: [
                        read_bp_word(record, 0x98, "draw fragment fog parameter")?,
                        read_bp_word(record, 0x9c, "draw fragment fog parameter")?,
                        read_bp_word(record, 0xa0, "draw fragment fog parameter")?,
                        read_bp_word(record, 0xa4, "draw fragment fog parameter")?,
                        read_bp_word(record, 0xa8, "draw fragment fog parameter")?,
                    ],
                    viewport_half_width_bits: read_u32(record, 0xac),
                };
                if fragment_tail.fog_range_base & FOG_RANGE_ADJUSTMENT_ENABLE != 0 {
                    let viewport_half_width =
                        f32::from_bits(fragment_tail.viewport_half_width_bits);
                    if !viewport_half_width.is_finite() || viewport_half_width == 0.0 {
                        return Err(GxPacketError::InvalidField {
                            field: "draw fragment viewport half width",
                            value: u64::from(fragment_tail.viewport_half_width_bits),
                        });
                    }
                }
                fragment_tail
            };
            let tev_start = checked_add(tev_offset, tev_relative_offset, "draw TEV start")?;
            let tev_end = checked_add(tev_start, GX_TEV_STATE_BYTES, "draw TEV end")?;
            let tev_state = &bytes[to_usize(tev_start)..to_usize(tev_end)];
            require_zero(tev_state, 452, to_usize(GX_TEV_STATE_BYTES))?;
            let stage_count = read_u32(tev_state, 448);
            if stage_count > MAX_TEV_STAGES as u32 {
                return Err(GxPacketError::InvalidField {
                    field: "TEV stage count",
                    value: u64::from(stage_count),
                });
            }
            for stage in 0..MAX_TEV_STAGES {
                let offset = stage * 16;
                if stage >= stage_count as usize {
                    require_zero(tev_state, offset, offset + 16)?;
                    continue;
                }
                for (field_offset, mask) in
                    [(0, 0x00ff_ffff), (4, 0x00ff_ffff), (8, 0x3ff), (12, 0x3ff)]
                {
                    let value = read_u32(tev_state, offset + field_offset);
                    if value & !mask != 0 {
                        return Err(GxPacketError::InvalidField {
                            field: "TEV stage encoding",
                            value: u64::from(value),
                        });
                    }
                }
            }
            for offset in (384..448).step_by(4) {
                let value = read_u32(tev_state, offset);
                if value > 3 {
                    return Err(GxPacketError::InvalidField {
                        field: "TEV swap-table channel",
                        value: u64::from(value),
                    });
                }
            }
            let required_maps =
                required_texture_maps(tev_state).map_err(|_| GxPacketError::InvalidField {
                    field: "TEV state",
                    value: 0,
                })?;
            let mut texture_slots = [GxTextureSlot {
                texture: None,
                sampler_bits: 0,
            }; MAX_TEV_TEXTURES];
            for map in 0..MAX_TEV_TEXTURES {
                let slot_offset = 0x30 + map * 8;
                let reference = read_u32(record, slot_offset);
                let sampler_bits = read_u32(record, slot_offset + 4);
                if sampler_bits & !SAMPLER_BITS_MASK != 0 {
                    return Err(GxPacketError::InvalidSampler {
                        draw: draw_index,
                        map,
                        sampler_bits,
                    });
                }
                if !required_maps[map] {
                    if reference != GX_TEXTURE_REFERENCE_ABSENT || sampler_bits != 0 {
                        return Err(GxPacketError::UnexpectedTextureReference {
                            draw: draw_index,
                            map,
                        });
                    }
                    continue;
                }
                if reference == GX_TEXTURE_REFERENCE_ABSENT {
                    return Err(GxPacketError::MissingTextureReference {
                        draw: draw_index,
                        map,
                    });
                }
                let reference_usize = to_usize(reference);
                if reference_usize >= texture_count_usize {
                    return Err(GxPacketError::InvalidTextureReference {
                        draw: draw_index,
                        map,
                        reference,
                        texture_count,
                    });
                }
                if !seen_textures[reference_usize] {
                    if reference_usize != next_first_texture {
                        return Err(GxPacketError::NonCanonicalTextureFirstUse {
                            draw: draw_index,
                            map,
                            expected: u32::try_from(next_first_texture)
                                .expect("texture count originated as u32"),
                            actual: reference,
                        });
                    }
                    seen_textures[reference_usize] = true;
                    next_first_texture += 1;
                }
                texture_slots[map] = GxTextureSlot {
                    texture: Some(reference),
                    sampler_bits,
                };
            }

            draws.push(GxDrawRecord {
                topology,
                cull_mode,
                vertex_count,
                vertex_relative_offset,
                tev_relative_offset,
                z_mode: read_bp_word(record, 0x10, "draw Z mode")?,
                blend_mode: read_bp_word(record, 0x14, "draw blend mode")?,
                alpha_test: read_bp_word(record, 0x18, "draw alpha test")?,
                scissor_x: read_u32(record, 0x1c),
                scissor_y: read_u32(record, 0x20),
                scissor_width: read_u32(record, 0x24),
                scissor_height: read_u32(record, 0x28),
                textures: texture_slots,
                fragment_tail,
            });
        }
        expect_u32("summed draw vertices", counted_vertices, total_vertex_count)?;
        expect_u32(
            "summed draw vertex bytes",
            next_vertex_relative_offset,
            vertex_bytes,
        )?;
        if next_first_texture != texture_count_usize {
            return Err(GxPacketError::UnusedTextureRecord {
                texture: u32::try_from(next_first_texture)
                    .expect("texture count originated as u32"),
            });
        }

        let mut textures = Vec::with_capacity(texture_count_usize);
        let mut texture_keys = HashSet::with_capacity(texture_count_usize);
        let mut next_key_relative_offset = 0u32;
        let mut next_pixel_relative_offset = 0u32;
        for texture_index in 0..texture_count_usize {
            let record_offset = to_usize(texture_table_offset)
                + texture_index * usize::from(GX_TEXTURE_RECORD_BYTES);
            let record =
                &bytes[record_offset..record_offset + usize::from(GX_TEXTURE_RECORD_BYTES)];
            let key_relative_offset = read_u32(record, 0x00);
            let key_len = read_u32(record, 0x04);
            let pixel_relative_offset = read_u32(record, 0x08);
            let pixel_len = read_u32(record, 0x0c);
            let address = read_u32(record, 0x10);
            let texture_generation = read_u32(record, 0x14);
            let width = read_u32(record, 0x18);
            let height = read_u32(record, 0x1c);
            let flags = read_u32(record, 0x20);
            if flags & !TEXTURE_FLAG_PAYLOAD != 0 {
                return Err(GxPacketError::InvalidField {
                    field: "texture flags",
                    value: u64::from(flags),
                });
            }
            require_zero(record, 0x24, 0x40)?;
            expect_u32(
                "texture key relative offset",
                key_relative_offset,
                next_key_relative_offset,
            )?;
            next_key_relative_offset = checked_add(
                next_key_relative_offset,
                key_len,
                "texture key section length",
            )?;
            if next_key_relative_offset > key_bytes {
                return Err(GxPacketError::SectionOutOfBounds("texture key"));
            }
            let key_start = checked_add(key_offset, key_relative_offset, "texture key start")?;
            let key_end = checked_add(key_start, key_len, "texture key end")?;
            let key = std::str::from_utf8(&bytes[to_usize(key_start)..to_usize(key_end)]).map_err(
                |_| GxPacketError::InvalidUtf8 {
                    texture: texture_index,
                },
            )?;
            if key.is_empty() {
                return Err(GxPacketError::NonCanonical(
                    "texture keys must not be empty",
                ));
            }
            if !texture_keys.insert(key) {
                return Err(GxPacketError::NonCanonical(
                    "texture keys must be unique within a packet",
                ));
            }

            if width == 0
                || height == 0
                || width > GX_MAX_TEXTURE_DIMENSION
                || height > GX_MAX_TEXTURE_DIMENSION
            {
                return Err(GxPacketError::InvalidTextureSize {
                    texture: texture_index,
                    width,
                    height,
                    expected: None,
                    actual: pixel_len,
                });
            }
            let expected_pixel_len = checked_mul(
                checked_mul(width, height, "texture texel count")?,
                4,
                "RGBA8 texture byte length",
            )?;
            let has_payload = flags & TEXTURE_FLAG_PAYLOAD != 0;
            if has_payload {
                expect_u32(
                    "texture pixel relative offset",
                    pixel_relative_offset,
                    next_pixel_relative_offset,
                )?;
                if pixel_len != expected_pixel_len {
                    return Err(GxPacketError::InvalidTextureSize {
                        texture: texture_index,
                        width,
                        height,
                        expected: Some(expected_pixel_len),
                        actual: pixel_len,
                    });
                }
                let pixel_end = checked_add(
                    pixel_relative_offset,
                    pixel_len,
                    "texture pixel payload end",
                )?;
                let aligned_pixel_end = align_packet(pixel_end, "texture pixel payload padding")?;
                if aligned_pixel_end > pixel_bytes {
                    return Err(GxPacketError::SectionOutOfBounds("texture pixels"));
                }
                let absolute_pixel_end = checked_add(
                    pixel_offset,
                    pixel_end,
                    "absolute texture pixel payload end",
                )?;
                let absolute_aligned_pixel_end = checked_add(
                    pixel_offset,
                    aligned_pixel_end,
                    "absolute texture pixel padding end",
                )?;
                require_zero(
                    bytes,
                    to_usize(absolute_pixel_end),
                    to_usize(absolute_aligned_pixel_end),
                )?;
                next_pixel_relative_offset = aligned_pixel_end;
            } else if pixel_relative_offset != 0 || pixel_len != 0 {
                return Err(GxPacketError::NonCanonical(
                    "textures without a payload must have zero pixel offset and length",
                ));
            }

            textures.push(GxTextureRecord {
                key_relative_offset,
                key_len,
                pixel_relative_offset,
                pixel_len,
                address,
                generation: texture_generation,
                width,
                height,
                has_payload,
            });
        }
        expect_u32(
            "concatenated texture key bytes",
            next_key_relative_offset,
            key_bytes,
        )?;
        expect_u32(
            "canonical texture pixel bytes",
            next_pixel_relative_offset,
            pixel_bytes,
        )?;

        Ok(Self {
            bytes,
            header,
            draws,
            textures,
        })
    }

    pub(crate) fn header(&self) -> &GxPacketHeader {
        &self.header
    }

    pub(crate) fn draw(&self, index: usize) -> Option<GxDraw<'_>> {
        let record = self.draws.get(index)?;
        let tev_start = to_usize(self.header.tev_offset + record.tev_relative_offset);
        let vertex_start = to_usize(self.header.vertex_offset + record.vertex_relative_offset);
        let vertex_len = to_usize(record.vertex_count * GX_VERTEX_BYTES);
        Some(GxDraw {
            record,
            tev_state: &self.bytes[tev_start..tev_start + to_usize(GX_TEV_STATE_BYTES)],
            vertex_bytes: &self.bytes[vertex_start..vertex_start + vertex_len],
        })
    }

    pub(crate) fn draws(&self) -> impl ExactSizeIterator<Item = GxDraw<'_>> + '_ {
        (0..self.draws.len()).map(|index| self.draw(index).expect("validated GX draw index"))
    }

    pub(crate) fn texture(&self, index: usize) -> Option<GxTexture<'_>> {
        let record = self.textures.get(index)?;
        let key_start = to_usize(self.header.key_offset + record.key_relative_offset);
        let key_end = key_start + to_usize(record.key_len);
        let key = std::str::from_utf8(&self.bytes[key_start..key_end])
            .expect("validated UTF-8 GX texture key");
        let pixels = if record.has_payload {
            let start = to_usize(self.header.pixel_offset + record.pixel_relative_offset);
            &self.bytes[start..start + to_usize(record.pixel_len)]
        } else {
            &[]
        };
        Some(GxTexture {
            record,
            key,
            pixels,
        })
    }

    pub(crate) fn textures(&self) -> impl ExactSizeIterator<Item = GxTexture<'_>> + '_ {
        (0..self.textures.len())
            .map(|index| self.texture(index).expect("validated GX texture index"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GxPacketError {
    TooShort {
        minimum: usize,
        actual: usize,
    },
    InvalidMagic([u8; 4]),
    UnsupportedVersion(u16),
    LengthMismatch {
        declared: u32,
        actual: usize,
    },
    InvalidField {
        field: &'static str,
        value: u64,
    },
    FieldMismatch {
        field: &'static str,
        expected: u64,
        actual: u64,
    },
    IntegerOverflow(&'static str),
    NonCanonical(&'static str),
    NonZeroPadding {
        offset: usize,
    },
    SectionOutOfBounds(&'static str),
    InvalidUtf8 {
        texture: usize,
    },
    InvalidSampler {
        draw: usize,
        map: usize,
        sampler_bits: u32,
    },
    MissingTextureReference {
        draw: usize,
        map: usize,
    },
    UnexpectedTextureReference {
        draw: usize,
        map: usize,
    },
    InvalidTextureReference {
        draw: usize,
        map: usize,
        reference: u32,
        texture_count: u32,
    },
    NonCanonicalTextureFirstUse {
        draw: usize,
        map: usize,
        expected: u32,
        actual: u32,
    },
    UnusedTextureRecord {
        texture: u32,
    },
    InvalidTextureSize {
        texture: usize,
        width: u32,
        height: u32,
        expected: Option<u32>,
        actual: u32,
    },
}

impl fmt::Display for GxPacketError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort { minimum, actual } => {
                write!(
                    formatter,
                    "LZGX packet needs at least {minimum} bytes, got {actual}"
                )
            }
            Self::InvalidMagic(magic) => {
                write!(formatter, "invalid LZGX packet magic {:02x?}", magic)
            }
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported LZGX packet version {version}")
            }
            Self::LengthMismatch { declared, actual } => write!(
                formatter,
                "LZGX packet declares {declared} bytes, got {actual}"
            ),
            Self::InvalidField { field, value } => {
                write!(formatter, "invalid LZGX {field}: {value}")
            }
            Self::FieldMismatch {
                field,
                expected,
                actual,
            } => write!(
                formatter,
                "non-canonical LZGX {field}: expected {expected}, got {actual}"
            ),
            Self::IntegerOverflow(field) => {
                write!(formatter, "LZGX {field} overflows the 32-bit packet format")
            }
            Self::NonCanonical(detail) => write!(formatter, "non-canonical LZGX packet: {detail}"),
            Self::NonZeroPadding { offset } => {
                write!(
                    formatter,
                    "non-zero LZGX padding byte at offset {offset:#x}"
                )
            }
            Self::SectionOutOfBounds(section) => {
                write!(formatter, "LZGX {section} section is out of bounds")
            }
            Self::InvalidUtf8 { texture } => {
                write!(formatter, "LZGX texture {texture} key is not UTF-8")
            }
            Self::InvalidSampler {
                draw,
                map,
                sampler_bits,
            } => write!(
                formatter,
                "LZGX draw {draw} texture map {map} has invalid sampler bits {sampler_bits:#x}"
            ),
            Self::MissingTextureReference { draw, map } => write!(
                formatter,
                "LZGX draw {draw} required texture map {map} is absent"
            ),
            Self::UnexpectedTextureReference { draw, map } => write!(
                formatter,
                "LZGX draw {draw} unused texture map {map} is not canonical absent/zero"
            ),
            Self::InvalidTextureReference {
                draw,
                map,
                reference,
                texture_count,
            } => write!(
                formatter,
                "LZGX draw {draw} texture map {map} references texture {reference}, but the table has {texture_count} records"
            ),
            Self::NonCanonicalTextureFirstUse {
                draw,
                map,
                expected,
                actual,
            } => write!(
                formatter,
                "LZGX draw {draw} texture map {map} first uses texture {actual}, expected {expected}"
            ),
            Self::UnusedTextureRecord { texture } => {
                write!(
                    formatter,
                    "LZGX texture record {texture} is never referenced"
                )
            }
            Self::InvalidTextureSize {
                texture,
                width,
                height,
                expected,
                actual,
            } => match expected {
                Some(expected) => write!(
                    formatter,
                    "LZGX texture {texture} is {width}x{height}: expected {expected} RGBA8 bytes, got {actual}"
                ),
                None => write!(
                    formatter,
                    "LZGX texture {texture} has invalid zero extent {width}x{height}"
                ),
            },
        }
    }
}

impl std::error::Error for GxPacketError {}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + size_of::<u16>()]
            .try_into()
            .expect("validated fixed-width LZGX field"),
    )
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + size_of::<u32>()]
            .try_into()
            .expect("validated fixed-width LZGX field"),
    )
}

fn read_bp_word(bytes: &[u8], offset: usize, field: &'static str) -> Result<u32, GxPacketError> {
    let value = read_u32(bytes, offset);
    if value & !0x00ff_ffff != 0 {
        return Err(GxPacketError::InvalidField {
            field,
            value: u64::from(value),
        });
    }
    Ok(value)
}

fn expect_u16(field: &'static str, actual: u16, expected: u16) -> Result<(), GxPacketError> {
    if actual != expected {
        return Err(GxPacketError::FieldMismatch {
            field,
            expected: u64::from(expected),
            actual: u64::from(actual),
        });
    }
    Ok(())
}

fn expect_u32(field: &'static str, actual: u32, expected: u32) -> Result<(), GxPacketError> {
    if actual != expected {
        return Err(GxPacketError::FieldMismatch {
            field,
            expected: u64::from(expected),
            actual: u64::from(actual),
        });
    }
    Ok(())
}

fn checked_add(left: u32, right: u32, field: &'static str) -> Result<u32, GxPacketError> {
    left.checked_add(right)
        .ok_or(GxPacketError::IntegerOverflow(field))
}

fn checked_mul(left: u32, right: u32, field: &'static str) -> Result<u32, GxPacketError> {
    left.checked_mul(right)
        .ok_or(GxPacketError::IntegerOverflow(field))
}

fn align_packet(value: u32, field: &'static str) -> Result<u32, GxPacketError> {
    checked_add(value, PACKET_ALIGNMENT - 1, field).map(|value| value & !(PACKET_ALIGNMENT - 1))
}

fn to_usize(value: u32) -> usize {
    usize::try_from(value).expect("u32 LZGX offset fits target usize")
}

fn require_zero(bytes: &[u8], start: usize, end: usize) -> Result<(), GxPacketError> {
    if let Some(relative) = bytes[start..end].iter().position(|byte| *byte != 0) {
        return Err(GxPacketError::NonZeroPadding {
            offset: start + relative,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const V3_PACKET_BYTES: usize = 2048;
    const V3_DRAW_OFFSET: usize = 160;
    const V3_TEXTURE_OFFSET: usize = 512;
    const V3_TEV_OFFSET: usize = 640;
    const V3_VERTEX_OFFSET: usize = 1568;
    const V3_KEY_OFFSET: usize = 2000;
    const V3_PIXEL_OFFSET: usize = 2016;

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn empty_texture_copy() -> Vec<u8> {
        let mut bytes = vec![0; 160];
        bytes[0..4].copy_from_slice(b"LZGX");
        put_u16(&mut bytes, 0x04, GX_PACKET_VERSION_V2);
        put_u16(&mut bytes, 0x06, 160);
        put_u32(&mut bytes, 0x08, 160);
        put_u32(&mut bytes, 0x10, 1);
        for offset in [0x1c, 0x20, 0x24, 0x28, 0x2c, 0x30] {
            put_u32(&mut bytes, offset, 160);
        }
        put_u32(&mut bytes, 0x4c, 1);
        put_u32(&mut bytes, 0x50, 2);
        put_u32(&mut bytes, 0x54, 3);
        put_u32(&mut bytes, 0x58, 4);
        put_u32(&mut bytes, 0x64, 0x0010_0000);
        put_u32(&mut bytes, 0x6c, 7);
        put_u32(&mut bytes, 0x70, 1);
        bytes[0x74..0x78].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        put_u16(&mut bytes, 0x78, GX_DRAW_RECORD_BYTES_V2);
        put_u16(&mut bytes, 0x7a, 64);
        put_u32(&mut bytes, 0x80, 0x0001_0203);
        put_u32(&mut bytes, 0x84, 0x0004_0506);
        put_u32(&mut bytes, 0x88, 0x0007_0809);
        put_u32(&mut bytes, 0x8c, 0x0000_0800);
        put_u32(&mut bytes, 0x90, 0x000a_0b0c);
        put_u32(&mut bytes, 0x94, 0x000d_0e0f);
        put_u32(&mut bytes, 0x98, 0x0010_1112);
        put_u32(&mut bytes, 0x9c, 0x0013_1415);
        bytes
    }

    fn single_draw_v2_texture_copy() -> Vec<u8> {
        const PACKET_BYTES: usize = 752;
        const DRAW_OFFSET: usize = 160;
        const TEXTURE_AND_TEV_OFFSET: usize = 288;
        const TRAILING_OFFSET: usize = 752;

        let mut bytes = empty_texture_copy();
        bytes.resize(PACKET_BYTES, 0);
        put_u32(&mut bytes, 0x08, PACKET_BYTES as u32);
        put_u32(&mut bytes, 0x14, 1);
        put_u32(&mut bytes, 0x1c, DRAW_OFFSET as u32);
        put_u32(&mut bytes, 0x20, TEXTURE_AND_TEV_OFFSET as u32);
        put_u32(&mut bytes, 0x24, TEXTURE_AND_TEV_OFFSET as u32);
        for offset in [0x28, 0x2c, 0x30] {
            put_u32(&mut bytes, offset, TRAILING_OFFSET as u32);
        }
        put_u32(&mut bytes, 0x34, u32::from(GX_DRAW_RECORD_BYTES_V2));
        put_u32(&mut bytes, 0x3c, GX_TEV_STATE_BYTES);
        for map in 0..MAX_TEV_TEXTURES {
            put_u32(
                &mut bytes,
                DRAW_OFFSET + 0x30 + map * 8,
                GX_TEXTURE_REFERENCE_ABSENT,
            );
        }
        bytes
    }

    fn textured_xfb_copy() -> Vec<u8> {
        let mut bytes = vec![0; V3_PACKET_BYTES];
        bytes[0..4].copy_from_slice(b"LZGX");
        put_u16(&mut bytes, 0x04, GX_PACKET_VERSION);
        put_u16(&mut bytes, 0x06, 160);
        put_u32(&mut bytes, 0x08, V3_PACKET_BYTES as u32);
        put_u32(&mut bytes, 0x10, 2);
        put_u32(&mut bytes, 0x14, 2);
        put_u32(&mut bytes, 0x18, 2);
        put_u32(&mut bytes, 0x1c, V3_DRAW_OFFSET as u32);
        put_u32(&mut bytes, 0x20, V3_TEXTURE_OFFSET as u32);
        put_u32(&mut bytes, 0x24, V3_TEV_OFFSET as u32);
        put_u32(&mut bytes, 0x28, V3_VERTEX_OFFSET as u32);
        put_u32(&mut bytes, 0x2c, V3_KEY_OFFSET as u32);
        put_u32(&mut bytes, 0x30, V3_PIXEL_OFFSET as u32);
        put_u32(&mut bytes, 0x34, 352);
        put_u32(&mut bytes, 0x38, 128);
        put_u32(&mut bytes, 0x3c, 928);
        put_u32(&mut bytes, 0x40, 432);
        put_u32(&mut bytes, 0x44, 7);
        put_u32(&mut bytes, 0x48, 32);
        put_u32(&mut bytes, 0x4c, 3);
        put_u32(&mut bytes, 0x50, 5);
        put_u32(&mut bytes, 0x54, 320);
        put_u32(&mut bytes, 0x58, 240);
        put_u32(&mut bytes, 0x5c, 320);
        put_u32(&mut bytes, 0x60, 448);
        put_u32(&mut bytes, 0x64, 0x0012_3400);
        put_u32(&mut bytes, 0x68, 1280);
        put_u32(&mut bytes, 0x6c, 0x1122_3344);
        put_u32(&mut bytes, 0x70, 1);
        bytes[0x74..0x78].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        put_u16(&mut bytes, 0x78, GX_DRAW_RECORD_BYTES);
        put_u16(&mut bytes, 0x7a, 64);
        put_u32(&mut bytes, 0x7c, 3);
        put_u32(&mut bytes, 0x80, 0x0001_0203);
        put_u32(&mut bytes, 0x84, 0x0004_0506);
        put_u32(&mut bytes, 0x88, 0x0007_0809);
        put_u32(&mut bytes, 0x8c, 0x0000_4800);
        put_u32(&mut bytes, 0x90, 0x000a_0b0c);
        put_u32(&mut bytes, 0x94, 0x000d_0e0f);
        put_u32(&mut bytes, 0x98, 0x0010_1112);
        put_u32(&mut bytes, 0x9c, 0x0013_1415);

        let first_draw = V3_DRAW_OFFSET;
        bytes[first_draw] = 2;
        bytes[first_draw + 1] = 2;
        put_u32(&mut bytes, first_draw + 0x04, 2);
        put_u32(&mut bytes, first_draw + 0x10, 0x0001_0203);
        put_u32(&mut bytes, first_draw + 0x14, 0x0004_0506);
        put_u32(&mut bytes, first_draw + 0x18, 0x0007_0809);
        put_u32(&mut bytes, first_draw + 0x1c, 11);
        put_u32(&mut bytes, first_draw + 0x20, 12);
        put_u32(&mut bytes, first_draw + 0x24, 313);
        put_u32(&mut bytes, first_draw + 0x28, 227);
        for map in 1..MAX_TEV_TEXTURES {
            put_u32(&mut bytes, first_draw + 0x30 + map * 8, u32::MAX);
        }
        put_u32(&mut bytes, first_draw + 0x30, 0);
        put_u32(&mut bytes, first_draw + 0x34, 0xb9);
        put_u32(&mut bytes, first_draw + 0x40, 1);
        put_u32(&mut bytes, first_draw + 0x44, 0xe3);
        put_u32(&mut bytes, first_draw + 0x70, 0x0011_1213);
        put_u32(&mut bytes, first_draw + 0x74, 0x0014_1516);
        put_u32(&mut bytes, first_draw + 0x78, 0x0017_1819);
        put_u32(&mut bytes, first_draw + 0x7c, 0x001a_1b1c);
        put_u32(&mut bytes, first_draw + 0x80, 0x001d_1e1f);
        for (index, value) in [
            0x0021_2223,
            0x0024_2526,
            0x0027_2829,
            0x002a_2b2c,
            0x002d_2e2f,
        ]
        .into_iter()
        .enumerate()
        {
            put_u32(&mut bytes, first_draw + 0x84 + index * 4, value);
        }
        for (index, value) in [
            0x0031_3233,
            0x0034_3536,
            0x0037_3839,
            0x003a_3b3c,
            0x003d_3e3f,
        ]
        .into_iter()
        .enumerate()
        {
            put_u32(&mut bytes, first_draw + 0x98 + index * 4, value);
        }
        put_u32(&mut bytes, first_draw + 0xac, 0x43a0_0000);

        let second_draw = first_draw + usize::from(GX_DRAW_RECORD_BYTES);
        bytes[second_draw] = 5;
        bytes[second_draw + 1] = 1;
        put_u32(&mut bytes, second_draw + 0x04, 1);
        put_u32(&mut bytes, second_draw + 0x08, 288);
        put_u32(&mut bytes, second_draw + 0x0c, 464);
        put_u32(&mut bytes, second_draw + 0x10, 0x0011_1213);
        put_u32(&mut bytes, second_draw + 0x14, 0x0014_1516);
        put_u32(&mut bytes, second_draw + 0x18, 0x0017_1819);
        put_u32(&mut bytes, second_draw + 0x1c, 21);
        put_u32(&mut bytes, second_draw + 0x20, 22);
        put_u32(&mut bytes, second_draw + 0x24, 299);
        put_u32(&mut bytes, second_draw + 0x28, 218);
        for map in 0..MAX_TEV_TEXTURES {
            put_u32(&mut bytes, second_draw + 0x30 + map * 8, u32::MAX);
        }
        put_u32(&mut bytes, second_draw + 0x38, 0);
        put_u32(&mut bytes, second_draw + 0x3c, 0x2e);
        put_u32(&mut bytes, second_draw + 0x70, 0x0041_4243);
        put_u32(&mut bytes, second_draw + 0x74, 0x0044_4546);
        put_u32(&mut bytes, second_draw + 0x78, 0x0047_4849);
        put_u32(&mut bytes, second_draw + 0x7c, 0x004a_4b4c);
        put_u32(&mut bytes, second_draw + 0x80, 0x004d_4e4f);
        for (index, value) in [
            0x0051_5253,
            0x0054_5556,
            0x0057_5859,
            0x005a_5b5c,
            0x005d_5e5f,
        ]
        .into_iter()
        .enumerate()
        {
            put_u32(&mut bytes, second_draw + 0x84 + index * 4, value);
        }
        for (index, value) in [
            0x0061_6263,
            0x0064_6566,
            0x0067_6869,
            0x006a_6b6c,
            0x006d_6e6f,
        ]
        .into_iter()
        .enumerate()
        {
            put_u32(&mut bytes, second_draw + 0x98 + index * 4, value);
        }
        put_u32(&mut bytes, second_draw + 0xac, 0x43b4_0000);

        let first_texture = V3_TEXTURE_OFFSET;
        put_u32(&mut bytes, first_texture + 0x04, 5);
        put_u32(&mut bytes, first_texture + 0x0c, 8);
        put_u32(&mut bytes, first_texture + 0x10, 0x1020_3040);
        put_u32(&mut bytes, first_texture + 0x14, 9);
        put_u32(&mut bytes, first_texture + 0x18, 2);
        put_u32(&mut bytes, first_texture + 0x1c, 1);
        put_u32(&mut bytes, first_texture + 0x20, 1);
        let second_texture = first_texture + usize::from(GX_TEXTURE_RECORD_BYTES);
        put_u32(&mut bytes, second_texture, 5);
        put_u32(&mut bytes, second_texture + 0x04, 2);
        put_u32(&mut bytes, second_texture + 0x08, 16);
        put_u32(&mut bytes, second_texture + 0x0c, 4);
        put_u32(&mut bytes, second_texture + 0x10, 0x5060_7080);
        put_u32(&mut bytes, second_texture + 0x14, 10);
        put_u32(&mut bytes, second_texture + 0x18, 1);
        put_u32(&mut bytes, second_texture + 0x1c, 1);
        put_u32(&mut bytes, second_texture + 0x20, 1);

        let first_tev = V3_TEV_OFFSET;
        put_u32(&mut bytes, first_tev, 3);
        put_u32(&mut bytes, first_tev + 0x04, 9);
        put_u32(&mut bytes, first_tev + 0x08, 1 << 6);
        put_u32(&mut bytes, first_tev + 0x10, 4);
        put_u32(&mut bytes, first_tev + 0x14, 10);
        put_u32(&mut bytes, first_tev + 0x18, (1 << 6) | 2);
        put_u32(&mut bytes, first_tev + 0x1c, 1);
        put_u32(&mut bytes, first_tev + 448, 2);
        let second_tev = first_tev + GX_TEV_STATE_BYTES as usize;
        put_u32(&mut bytes, second_tev, 0xf0);
        put_u32(&mut bytes, second_tev + 0x04, 0x2d0);
        put_u32(&mut bytes, second_tev + 0x08, (1 << 6) | 1);
        put_u32(&mut bytes, second_tev + 448, 1);

        for component in 0..72 {
            let start = V3_VERTEX_OFFSET + component * 4;
            bytes[start..start + 4]
                .copy_from_slice(&(((component as f32) - 17.0) / 8.0).to_le_bytes());
        }
        for component in 0..36 {
            let start = V3_VERTEX_OFFSET + 288 + component * 4;
            bytes[start..start + 4]
                .copy_from_slice(&(32.0 - (component as f32) * 0.25).to_le_bytes());
        }
        bytes[V3_KEY_OFFSET..V3_KEY_OFFSET + 7].copy_from_slice("alphaβ".as_bytes());
        bytes[V3_PIXEL_OFFSET..V3_PIXEL_OFFSET + 8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        bytes[V3_PIXEL_OFFSET + 16..V3_PIXEL_OFFSET + 20]
            .copy_from_slice(&[0xfa, 0xfb, 0xfc, 0xfd]);
        bytes
    }

    fn textured_xfb_copy_v2() -> Vec<u8> {
        const PACKET_BYTES: usize = 1952;
        const DRAW_OFFSET: usize = 160;
        const TEXTURE_OFFSET: usize = 416;
        const TEV_OFFSET: usize = 544;
        const VERTEX_OFFSET: usize = 1472;
        const KEY_OFFSET: usize = 1904;
        const PIXEL_OFFSET: usize = 1920;

        let v3 = textured_xfb_copy();
        let mut bytes = vec![0; PACKET_BYTES];
        bytes[..GX_PACKET_HEADER_BYTES as usize]
            .copy_from_slice(&v3[..GX_PACKET_HEADER_BYTES as usize]);
        put_u16(&mut bytes, 0x04, GX_PACKET_VERSION_V2);
        put_u32(&mut bytes, 0x08, PACKET_BYTES as u32);
        put_u32(&mut bytes, 0x20, TEXTURE_OFFSET as u32);
        put_u32(&mut bytes, 0x24, TEV_OFFSET as u32);
        put_u32(&mut bytes, 0x28, VERTEX_OFFSET as u32);
        put_u32(&mut bytes, 0x2c, KEY_OFFSET as u32);
        put_u32(&mut bytes, 0x30, PIXEL_OFFSET as u32);
        put_u32(&mut bytes, 0x34, 2 * u32::from(GX_DRAW_RECORD_BYTES_V2));
        put_u16(&mut bytes, 0x78, GX_DRAW_RECORD_BYTES_V2);

        for draw in 0..2 {
            let v3_start = V3_DRAW_OFFSET + draw * usize::from(GX_DRAW_RECORD_BYTES);
            let v2_start = DRAW_OFFSET + draw * usize::from(GX_DRAW_RECORD_BYTES_V2);
            bytes[v2_start..v2_start + usize::from(GX_DRAW_RECORD_BYTES_V2)]
                .copy_from_slice(&v3[v3_start..v3_start + usize::from(GX_DRAW_RECORD_BYTES_V2)]);
            bytes[v2_start + 0x70..v2_start + usize::from(GX_DRAW_RECORD_BYTES_V2)].fill(0);
        }
        bytes[TEXTURE_OFFSET..TEV_OFFSET].copy_from_slice(&v3[V3_TEXTURE_OFFSET..V3_TEV_OFFSET]);
        bytes[TEV_OFFSET..VERTEX_OFFSET].copy_from_slice(&v3[V3_TEV_OFFSET..V3_VERTEX_OFFSET]);
        bytes[VERTEX_OFFSET..KEY_OFFSET].copy_from_slice(&v3[V3_VERTEX_OFFSET..V3_KEY_OFFSET]);
        bytes[KEY_OFFSET..KEY_OFFSET + 7].copy_from_slice(&v3[V3_KEY_OFFSET..V3_KEY_OFFSET + 7]);
        bytes[PIXEL_OFFSET..PACKET_BYTES].copy_from_slice(&v3[V3_PIXEL_OFFSET..V3_PACKET_BYTES]);
        bytes
    }

    fn fnv1a64(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    }

    #[test]
    fn parses_empty_texture_copy_golden() {
        let bytes = empty_texture_copy();
        assert_eq!(fnv1a64(&bytes), 0x15e4_67b0_9783_0cca);
        let packet = GxFramePacket::parse(&bytes).unwrap();
        assert_eq!(packet.header().copy_kind, GxCopyKind::Texture);
        assert!(packet.header().clear);
        assert_eq!(
            packet.header().copy_state,
            GxCopyState {
                z_mode: 0x0001_0203,
                blend_mode: 0x0004_0506,
                pixel_control: 0x0007_0809,
                copy_command: 0x0000_0800,
                clear_rgba: [0x11, 0x22, 0x33, 0x44],
                clear_depth: 0x000a_0b0c,
                copy_scale: 0x000d_0e0f,
                copy_filter: [0x0010_1112, 0x0013_1415],
            }
        );
        assert_eq!(packet.draws().len(), 0);
        assert_eq!(packet.textures().len(), 0);
    }

    #[test]
    fn parses_v2_draw_with_default_fragment_tail() {
        let bytes = single_draw_v2_texture_copy();
        let packet = GxFramePacket::parse(&bytes).unwrap();
        assert_eq!(
            packet.draw(0).unwrap().record.fragment_tail,
            GxFragmentTailState::default()
        );
    }

    #[test]
    fn parses_v2_two_draw_stride_golden() {
        let bytes = textured_xfb_copy_v2();
        assert_eq!(fnv1a64(&bytes), 0xf87e_8c67_ef5c_cdeb);
        let packet = GxFramePacket::parse(&bytes).unwrap();
        let second_draw = packet.draw(1).unwrap();
        assert_eq!(second_draw.record.topology, 5);
        assert_eq!(second_draw.record.vertex_relative_offset, 288);
        assert_eq!(second_draw.vertex_floats().next(), Some(32.0));
        assert_eq!(
            second_draw.record.fragment_tail,
            GxFragmentTailState::default()
        );
        assert_eq!(packet.texture(1).unwrap().key, "β");
        assert_eq!(packet.texture(1).unwrap().pixels, [0xfa, 0xfb, 0xfc, 0xfd]);
    }

    #[test]
    fn rejects_nonzero_v2_fragment_tail_padding() {
        let mut bytes = single_draw_v2_texture_copy();
        bytes[V3_DRAW_OFFSET + 0x70] = 1;
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::NonZeroPadding { offset: 0x70 }
        );
    }

    #[test]
    fn parses_textured_xfb_copy_golden() {
        let bytes = textured_xfb_copy();
        assert_eq!(fnv1a64(&bytes), 0x4f27_c6cd_506d_fd4b);
        let packet = GxFramePacket::parse(&bytes).unwrap();
        assert_eq!(packet.header().copy_kind, GxCopyKind::Xfb);
        assert_eq!(packet.header().generation, 0x1122_3344);
        assert_eq!(packet.header().copy_state.copy_command, 0x0000_4800);
        let draw = packet.draw(0).unwrap();
        assert_eq!(draw.record.topology, 2);
        assert_eq!(draw.record.z_mode, 0x0001_0203);
        assert_eq!(draw.record.blend_mode, 0x0004_0506);
        assert_eq!(draw.record.alpha_test, 0x0007_0809);
        assert_eq!(draw.vertex_floats().len(), 72);
        assert_eq!(draw.vertex_floats().nth(71), Some(6.75));
        assert_eq!(draw.record.textures[0].texture, Some(0));
        assert_eq!(
            draw.record.fragment_tail,
            GxFragmentTailState {
                pixel_control: 0x0011_1213,
                constant_alpha: 0x0014_1516,
                z_texture_bias: 0x0017_1819,
                z_texture_mode: 0x001a_1b1c,
                fog_range_base: 0x001d_1e1f,
                fog_range_k: [
                    0x0021_2223,
                    0x0024_2526,
                    0x0027_2829,
                    0x002a_2b2c,
                    0x002d_2e2f,
                ],
                fog_words: [
                    0x0031_3233,
                    0x0034_3536,
                    0x0037_3839,
                    0x003a_3b3c,
                    0x003d_3e3f,
                ],
                viewport_half_width_bits: 0x43a0_0000,
            }
        );
        assert_eq!(
            packet
                .draw(1)
                .unwrap()
                .record
                .fragment_tail
                .viewport_half_width_bits,
            0x43b4_0000
        );
        let texture = packet.texture(0).unwrap();
        assert_eq!(texture.key, "alpha");
        assert_eq!(texture.pixels, [1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn xfb_output_extent_accepts_1024_and_rejects_1025() {
        let mut exact_limit = textured_xfb_copy();
        put_u32(&mut exact_limit, 0x5c, GX_MAX_TEXTURE_DIMENSION);
        put_u32(&mut exact_limit, 0x60, GX_MAX_TEXTURE_DIMENSION);
        let packet = GxFramePacket::parse(&exact_limit).unwrap();
        assert_eq!(packet.header().output_width, GX_MAX_TEXTURE_DIMENSION);
        assert_eq!(packet.header().output_height, GX_MAX_TEXTURE_DIMENSION);

        for offset in [0x5c, 0x60] {
            let mut oversized = exact_limit.clone();
            put_u32(&mut oversized, offset, GX_MAX_TEXTURE_DIMENSION + 1);
            assert_eq!(
                GxFramePacket::parse(&oversized).unwrap_err(),
                GxPacketError::InvalidField {
                    field: "XFB output extent",
                    value: u64::from(GX_MAX_TEXTURE_DIMENSION + 1),
                }
            );
        }
    }

    #[test]
    fn rejects_noncanonical_v3_draw_reserved_fields() {
        let mut flags = textured_xfb_copy();
        put_u16(&mut flags, V3_DRAW_OFFSET + 0x02, 1);
        assert_eq!(
            GxFramePacket::parse(&flags).unwrap_err(),
            GxPacketError::FieldMismatch {
                field: "draw flags",
                expected: 0,
                actual: 1,
            }
        );

        let mut reserved = textured_xfb_copy();
        put_u32(&mut reserved, V3_DRAW_OFFSET + 0x2c, 1);
        assert_eq!(
            GxFramePacket::parse(&reserved).unwrap_err(),
            GxPacketError::FieldMismatch {
                field: "draw reserved word",
                expected: 0,
                actual: 1,
            }
        );
    }

    #[test]
    fn rejects_reserved_bits_in_every_v3_draw_bp_word() {
        for field_offset in [0x10, 0x14, 0x18]
            .into_iter()
            .chain((0x70..=0xa8).step_by(4))
        {
            let mut bytes = textured_xfb_copy();
            put_u32(&mut bytes, V3_DRAW_OFFSET + field_offset, 0x0100_0000);
            assert!(matches!(
                GxFramePacket::parse(&bytes),
                Err(GxPacketError::InvalidField {
                    value: 0x0100_0000,
                    ..
                })
            ));
        }
    }

    #[test]
    fn range_adjustment_requires_finite_nonzero_viewport_half_width() {
        for bits in [
            0.0_f32.to_bits(),
            (-0.0_f32).to_bits(),
            f32::INFINITY.to_bits(),
            f32::NEG_INFINITY.to_bits(),
            f32::NAN.to_bits(),
            0x7fa0_0001,
        ] {
            let mut bytes = textured_xfb_copy();
            put_u32(&mut bytes, V3_DRAW_OFFSET + 0xac, bits);
            assert_eq!(
                GxFramePacket::parse(&bytes).unwrap_err(),
                GxPacketError::InvalidField {
                    field: "draw fragment viewport half width",
                    value: u64::from(bits),
                }
            );
        }

        let mut negative = textured_xfb_copy();
        put_u32(&mut negative, V3_DRAW_OFFSET + 0xac, (-160.0_f32).to_bits());
        assert_eq!(
            GxFramePacket::parse(&negative)
                .unwrap()
                .draw(0)
                .unwrap()
                .record
                .fragment_tail
                .viewport_half_width_bits,
            (-160.0_f32).to_bits()
        );
    }

    #[test]
    fn disabled_range_adjustment_preserves_arbitrary_viewport_bits() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, V3_DRAW_OFFSET + 0x80, 0);
        put_u32(&mut bytes, V3_DRAW_OFFSET + 0xac, 0xffff_ffff);
        assert_eq!(
            GxFramePacket::parse(&bytes)
                .unwrap()
                .draw(0)
                .unwrap()
                .record
                .fragment_tail
                .viewport_half_width_bits,
            0xffff_ffff
        );
    }

    #[test]
    fn version_selects_the_canonical_draw_record_size() {
        let mut v2_with_v3_record_size = single_draw_v2_texture_copy();
        put_u16(&mut v2_with_v3_record_size, 0x78, GX_DRAW_RECORD_BYTES);
        assert_eq!(
            GxFramePacket::parse(&v2_with_v3_record_size).unwrap_err(),
            GxPacketError::FieldMismatch {
                field: "draw record bytes",
                expected: u64::from(GX_DRAW_RECORD_BYTES_V2),
                actual: u64::from(GX_DRAW_RECORD_BYTES),
            }
        );

        let mut v3_with_v2_record_size = textured_xfb_copy();
        put_u16(&mut v3_with_v2_record_size, 0x78, GX_DRAW_RECORD_BYTES_V2);
        assert_eq!(
            GxFramePacket::parse(&v3_with_v2_record_size).unwrap_err(),
            GxPacketError::FieldMismatch {
                field: "draw record bytes",
                expected: u64::from(GX_DRAW_RECORD_BYTES),
                actual: u64::from(GX_DRAW_RECORD_BYTES_V2),
            }
        );
    }

    #[test]
    fn rejects_unknown_packet_version() {
        let mut bytes = textured_xfb_copy();
        put_u16(&mut bytes, 0x04, GX_PACKET_VERSION + 1);
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::UnsupportedVersion(GX_PACKET_VERSION + 1)
        );
    }

    #[test]
    fn rejects_noncanonical_section_offset() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, 0x28, 800);
        assert!(matches!(
            GxFramePacket::parse(&bytes),
            Err(GxPacketError::FieldMismatch {
                field: "vertex section offset",
                ..
            })
        ));
    }

    #[test]
    fn rejects_noncanonical_terminal_copy_state() {
        let mut oversized = empty_texture_copy();
        put_u32(&mut oversized, 0x80, 0x0100_0000);
        assert_eq!(
            GxFramePacket::parse(&oversized).unwrap_err(),
            GxPacketError::InvalidField {
                field: "terminal Z mode",
                value: 0x0100_0000,
            }
        );

        let mut clear_conflict = empty_texture_copy();
        put_u32(&mut clear_conflict, 0x8c, 0);
        assert_eq!(
            GxFramePacket::parse(&clear_conflict).unwrap_err(),
            GxPacketError::NonCanonical("copy clear flag must match the raw copy command")
        );

        let mut kind_conflict = empty_texture_copy();
        put_u32(&mut kind_conflict, 0x8c, 0x4800);
        assert_eq!(
            GxFramePacket::parse(&kind_conflict).unwrap_err(),
            GxPacketError::NonCanonical("copy kind must match the raw copy command")
        );
    }

    #[test]
    fn rejects_count_arithmetic_overflow() {
        let mut bytes = empty_texture_copy();
        put_u32(&mut bytes, 0x14, u32::MAX);
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::IntegerOverflow("draw table size")
        );
    }

    #[test]
    fn rejects_out_of_range_texture_reference() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, 160 + 0x30, 2);
        assert!(matches!(
            GxFramePacket::parse(&bytes),
            Err(GxPacketError::InvalidTextureReference {
                draw: 0,
                map: 0,
                reference: 2,
                texture_count: 2,
            })
        ));
    }

    #[test]
    fn rejects_noncanonical_first_use_reference() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, 160 + 0x30, 1);
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::NonCanonicalTextureFirstUse {
                draw: 0,
                map: 0,
                expected: 0,
                actual: 1,
            }
        );
    }

    #[test]
    fn rejects_rgba_payload_size_mismatch() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, V3_TEXTURE_OFFSET + 0x0c, 4);
        assert!(matches!(
            GxFramePacket::parse(&bytes),
            Err(GxPacketError::InvalidTextureSize {
                texture: 0,
                expected: Some(8),
                actual: 4,
                ..
            })
        ));
    }

    #[test]
    fn rejects_extreme_texture_dimensions_before_size_arithmetic() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, V3_TEXTURE_OFFSET + 0x18, u32::MAX);
        put_u32(&mut bytes, V3_TEXTURE_OFFSET + 0x1c, u32::MAX);
        assert!(matches!(
            GxFramePacket::parse(&bytes),
            Err(GxPacketError::InvalidTextureSize {
                texture: 0,
                width: u32::MAX,
                height: u32::MAX,
                ..
            })
        ));
    }

    #[test]
    fn rejects_texture_dimensions_beyond_gx_limits() {
        let mut bytes = textured_xfb_copy();
        put_u32(
            &mut bytes,
            V3_TEXTURE_OFFSET + 0x18,
            GX_MAX_TEXTURE_DIMENSION + 1,
        );
        assert!(matches!(
            GxFramePacket::parse(&bytes),
            Err(GxPacketError::InvalidTextureSize {
                texture: 0,
                width: 1025,
                ..
            })
        ));
    }

    #[test]
    fn rejects_nonzero_alignment_padding() {
        let mut bytes = textured_xfb_copy();
        bytes[V3_KEY_OFFSET + 7] = 1;
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::NonZeroPadding {
                offset: V3_KEY_OFFSET + 7
            }
        );
    }

    #[test]
    fn rejects_nonzero_tev_padding() {
        let mut bytes = textured_xfb_copy();
        bytes[V3_TEV_OFFSET + 452] = 1;
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::NonZeroPadding { offset: 452 }
        );
    }

    #[test]
    fn rejects_noncanonical_tev_fields() {
        let mut inactive = textured_xfb_copy();
        inactive[V3_TEV_OFFSET + 32] = 1;
        assert_eq!(
            GxFramePacket::parse(&inactive).unwrap_err(),
            GxPacketError::NonZeroPadding { offset: 32 }
        );

        let mut stage = textured_xfb_copy();
        put_u32(&mut stage, V3_TEV_OFFSET + 8, (1 << 6) | (1 << 10));
        assert_eq!(
            GxFramePacket::parse(&stage).unwrap_err(),
            GxPacketError::InvalidField {
                field: "TEV stage encoding",
                value: (1 << 6) | (1 << 10),
            }
        );

        let mut swap = textured_xfb_copy();
        put_u32(&mut swap, V3_TEV_OFFSET + 384, 4);
        assert_eq!(
            GxFramePacket::parse(&swap).unwrap_err(),
            GxPacketError::InvalidField {
                field: "TEV swap-table channel",
                value: 4,
            }
        );
    }

    #[test]
    fn rejects_noncanonical_vertex_nan() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, V3_VERTEX_OFFSET, 0x7fa0_0001);
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::NonCanonical("vertex NaNs must use the canonical quiet-NaN encoding")
        );
    }

    #[test]
    fn rejects_empty_and_duplicate_texture_keys() {
        let mut empty = textured_xfb_copy();
        put_u32(&mut empty, V3_TEXTURE_OFFSET + 0x04, 0);
        assert_eq!(
            GxFramePacket::parse(&empty).unwrap_err(),
            GxPacketError::NonCanonical("texture keys must not be empty")
        );

        let mut duplicate = textured_xfb_copy();
        put_u32(&mut duplicate, 0x44, 10);
        put_u32(&mut duplicate, V3_TEXTURE_OFFSET + 64 + 0x04, 5);
        duplicate[V3_KEY_OFFSET..V3_KEY_OFFSET + 10].copy_from_slice(b"alphaalpha");
        assert_eq!(
            GxFramePacket::parse(&duplicate).unwrap_err(),
            GxPacketError::NonCanonical("texture keys must be unique within a packet")
        );
    }

    #[test]
    fn rejects_nonrequired_texture_slot() {
        let mut bytes = textured_xfb_copy();
        put_u32(&mut bytes, 160 + 0x38, 0);
        assert_eq!(
            GxFramePacket::parse(&bytes).unwrap_err(),
            GxPacketError::UnexpectedTextureReference { draw: 0, map: 1 }
        );
    }
}
