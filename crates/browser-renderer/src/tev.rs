#![allow(dead_code)]

//! Pure GX texture-environment (TEV) state and evaluation.
//!
//! The browser worker can populate [`TevDrawState`] directly from BP state,
//! while the WebGPU renderer uploads the same value as a uniform.  All GPU
//! visible records are 16-byte aligned and contain only scalar/array fields so
//! they can be copied without a platform-specific representation layer.

use std::array;

pub(crate) const MAX_TEV_STAGES: usize = 16;
pub(crate) const MAX_TEV_TEXTURES: usize = 8;
pub(crate) const MAX_TEV_RASTER_CHANNELS: usize = 8;
pub(crate) const MAX_INDIRECT_TEV_STAGES: usize = 4;
pub(crate) const INDIRECT_TEV_MATRIX_COUNT: usize = 3;
pub(crate) const INDIRECT_TEV_COMMAND_MASK: u32 = 0x001f_ffff;
pub(crate) const TEV_VERTEX_FLOATS: usize = 36;
pub(crate) const TEV_DRAW_STATE_BYTES: usize = 464;
pub(crate) const TEV_TEXTURE_METADATA_WORDS: usize = MAX_TEV_TEXTURES * 5;
// One exact managed texture-coordinate sidecar record contains three inv-W
// endpoint words followed by S/W, T/W, and Q/W endpoint triples for all eight
// GX coordinates. The final word pads each per-primitive record to vec4<u32>
// storage alignment without changing the 144-byte vertex transport.
pub(crate) const MANAGED_TEX_COORD_SIDECAR_WORDS: usize = 76;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TevPipelineLayoutKind {
    Legacy,
    ManagedTexCoordSidecar,
}

impl TevPipelineLayoutKind {
    pub(crate) const fn required_bind_group_count(self) -> u32 {
        match self {
            Self::Legacy => 2,
            Self::ManagedTexCoordSidecar => 3,
        }
    }

    pub(crate) const fn requires_managed_tex_coord_sidecar(self) -> bool {
        matches!(self, Self::ManagedTexCoordSidecar)
    }
}

pub(crate) const fn tev_pipeline_layout_kind(
    managed_tex_coord_sidecar: bool,
) -> TevPipelineLayoutKind {
    if managed_tex_coord_sidecar {
        TevPipelineLayoutKind::ManagedTexCoordSidecar
    } else {
        TevPipelineLayoutKind::Legacy
    }
}

pub(crate) type TevColor = [i32; 4];

const ZERO: TevColor = [0; 4];
const WHITE: TevColor = [255; 4];
const IDENTITY_SWAP: [u32; 4] = [0, 1, 2, 3];

pub(crate) fn validate_draw_transport(
    vertex_floats: usize,
    state_bytes: usize,
    texture_keys: usize,
    texture_metadata_words: usize,
    texture_pixel_arrays: usize,
) -> Result<usize, String> {
    if !vertex_floats.is_multiple_of(TEV_VERTEX_FLOATS) {
        return Err(format!(
            "TEV vertex array is not {TEV_VERTEX_FLOATS}-float aligned"
        ));
    }
    if state_bytes != TEV_DRAW_STATE_BYTES {
        return Err(format!(
            "TEV draw state must be exactly {TEV_DRAW_STATE_BYTES} bytes, got {state_bytes}"
        ));
    }
    if texture_keys != MAX_TEV_TEXTURES {
        return Err(format!(
            "TEV texture key array must contain exactly {MAX_TEV_TEXTURES} slots, got {texture_keys}"
        ));
    }
    if texture_metadata_words != TEV_TEXTURE_METADATA_WORDS {
        return Err(format!(
            "TEV texture metadata must contain exactly {TEV_TEXTURE_METADATA_WORDS} words, got {texture_metadata_words}"
        ));
    }
    if texture_pixel_arrays != MAX_TEV_TEXTURES {
        return Err(format!(
            "TEV texture pixel array must contain exactly {MAX_TEV_TEXTURES} slots, got {texture_pixel_arrays}"
        ));
    }
    Ok(vertex_floats / TEV_VERTEX_FLOATS)
}

pub(crate) fn required_texture_maps(state: &[u8]) -> Result<[bool; MAX_TEV_TEXTURES], String> {
    if state.len() != TEV_DRAW_STATE_BYTES {
        return Err(format!(
            "TEV draw state must be exactly {TEV_DRAW_STATE_BYTES} bytes, got {}",
            state.len()
        ));
    }

    let stage_count = u32::from_le_bytes(
        state[448..452]
            .try_into()
            .expect("fixed TEV stage-count field"),
    ) as usize;
    let mut required = [false; MAX_TEV_TEXTURES];
    for stage in 0..stage_count.min(MAX_TEV_STAGES) {
        let refs_offset = stage * 16 + 8;
        let refs = u32::from_le_bytes(
            state[refs_offset..refs_offset + 4]
                .try_into()
                .expect("fixed TEV stage reference field"),
        );
        if refs & (1 << 6) != 0 {
            required[(refs & 7) as usize] = true;
        }
    }
    Ok(required)
}

pub(crate) fn required_texture_coords(state: &[u8]) -> Result<[bool; MAX_TEV_TEXTURES], String> {
    if state.len() != TEV_DRAW_STATE_BYTES {
        return Err(format!(
            "TEV draw state must be exactly {TEV_DRAW_STATE_BYTES} bytes, got {}",
            state.len()
        ));
    }

    let stage_count = u32::from_le_bytes(
        state[448..452]
            .try_into()
            .expect("fixed TEV stage-count field"),
    ) as usize;
    let mut required = [false; MAX_TEV_TEXTURES];
    for stage in 0..stage_count.min(MAX_TEV_STAGES) {
        let refs_offset = stage * 16 + 8;
        let refs = u32::from_le_bytes(
            state[refs_offset..refs_offset + 4]
                .try_into()
                .expect("fixed TEV stage reference field"),
        );
        if refs & (1 << 6) != 0 {
            required[((refs >> 3) & 7) as usize] = true;
        }
    }
    Ok(required)
}

/// The precision selected by a BP indirect-stage command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IndirectTevFormat {
    Bits8,
    Bits5,
    Bits4,
    Bits3,
}

impl IndirectTevFormat {
    const fn from_bits(bits: u32) -> Self {
        match bits & 3 {
            0 => Self::Bits8,
            1 => Self::Bits5,
            2 => Self::Bits4,
            _ => Self::Bits3,
        }
    }

    const fn coordinate_shift(self) -> u32 {
        match self {
            Self::Bits8 => 0,
            Self::Bits5 => 3,
            Self::Bits4 => 4,
            Self::Bits3 => 5,
        }
    }

    const fn selected_bias(self) -> i32 {
        match self {
            Self::Bits8 => -128,
            Self::Bits5 | Self::Bits4 | Self::Bits3 => 1,
        }
    }

    const fn bump_shift(self) -> u32 {
        match self {
            Self::Bits8 => 0,
            Self::Bits5 => 5,
            Self::Bits4 => 4,
            Self::Bits3 => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IndirectTevBumpAlpha {
    Off,
    S,
    T,
    U,
}

impl IndirectTevBumpAlpha {
    const fn from_bits(bits: u32) -> Self {
        match bits & 3 {
            0 => Self::Off,
            1 => Self::S,
            2 => Self::T,
            _ => Self::U,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IndirectTevMatrixId {
    Static,
    DynamicS,
    DynamicT,
    Invalid,
}

impl IndirectTevMatrixId {
    const fn from_bits(bits: u32) -> Self {
        match bits & 3 {
            0 => Self::Static,
            1 => Self::DynamicS,
            2 => Self::DynamicT,
            _ => Self::Invalid,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IndirectTevWrap {
    Off,
    Wrap256,
    Wrap128,
    Wrap64,
    Wrap32,
    Wrap16,
    Zero,
    Invalid,
}

impl IndirectTevWrap {
    const fn from_bits(bits: u32) -> Self {
        match bits & 7 {
            0 => Self::Off,
            1 => Self::Wrap256,
            2 => Self::Wrap128,
            3 => Self::Wrap64,
            4 => Self::Wrap32,
            5 => Self::Wrap16,
            6 => Self::Zero,
            _ => Self::Invalid,
        }
    }
}

/// Decoded low 21 bits of one BP IND_CMD register.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IndirectTevCommand {
    pub(crate) raw: u32,
    pub(crate) indirect_stage: usize,
    pub(crate) format: IndirectTevFormat,
    pub(crate) bias: [bool; 3],
    pub(crate) bump_alpha: IndirectTevBumpAlpha,
    pub(crate) matrix_index: Option<usize>,
    pub(crate) matrix_id: IndirectTevMatrixId,
    pub(crate) wrap_s: IndirectTevWrap,
    pub(crate) wrap_t: IndirectTevWrap,
    pub(crate) use_unmodified_lod: bool,
    pub(crate) add_previous: bool,
}

impl IndirectTevCommand {
    pub(crate) const fn decode(raw: u32) -> Self {
        let raw = raw & INDIRECT_TEV_COMMAND_MASK;
        let encoded_matrix = ((raw >> 9) & 3) as usize;
        Self {
            raw,
            indirect_stage: (raw & 3) as usize,
            format: IndirectTevFormat::from_bits(raw >> 2),
            bias: [
                raw & (1 << 4) != 0,
                raw & (1 << 5) != 0,
                raw & (1 << 6) != 0,
            ],
            bump_alpha: IndirectTevBumpAlpha::from_bits(raw >> 7),
            matrix_index: if encoded_matrix == 0 {
                None
            } else {
                Some(encoded_matrix - 1)
            },
            matrix_id: IndirectTevMatrixId::from_bits(raw >> 11),
            wrap_s: IndirectTevWrap::from_bits(raw >> 13),
            wrap_t: IndirectTevWrap::from_bits(raw >> 16),
            use_unmodified_lod: raw & (1 << 19) != 0,
            add_previous: raw & (1 << 20) != 0,
        }
    }

    pub(crate) const fn uses_indirect_sample(self, num_indirect_stages: usize) -> bool {
        (self.bump_alpha as u32 != IndirectTevBumpAlpha::Off as u32 || self.matrix_index.is_some())
            && self.indirect_stage < num_indirect_stages
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IndirectTevMatrix {
    pub(crate) rows: [[i32; 3]; 2],
    pub(crate) exponent: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IndirectTevReference {
    pub(crate) texture_map: usize,
    pub(crate) tex_coord: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IndirectTevScale {
    pub(crate) s_shift: u32,
    pub(crate) t_shift: u32,
}

/// The raw BP state needed by the CPU indirect-coordinate reference model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IndirectTevState {
    pub(crate) gen_mode: u32,
    pub(crate) matrices: [u32; INDIRECT_TEV_MATRIX_COUNT * 3],
    pub(crate) imask: u32,
    pub(crate) commands: [u32; MAX_TEV_STAGES],
    pub(crate) tex_scales: [u32; 2],
    pub(crate) iref: u32,
}

impl IndirectTevState {
    pub(crate) fn from_bp(
        gen_mode: u32,
        matrices: [u32; INDIRECT_TEV_MATRIX_COUNT * 3],
        imask: u32,
        commands: [u32; MAX_TEV_STAGES],
        tex_scales: [u32; 2],
        iref: u32,
    ) -> Self {
        Self {
            gen_mode: gen_mode & 0x00ff_ffff,
            matrices: matrices.map(|word| word & 0x00ff_ffff),
            imask: imask & 0x00ff_ffff,
            commands: commands.map(|word| word & 0x00ff_ffff),
            tex_scales: tex_scales.map(|word| word & 0x00ff_ffff),
            iref: iref & 0x00ff_ffff,
        }
    }

    pub(crate) const fn num_tex_gens(self) -> usize {
        (self.gen_mode & 0xf) as usize
    }

    pub(crate) const fn direct_stage_count(self) -> usize {
        (((self.gen_mode >> 10) & 0xf) + 1) as usize
    }

    pub(crate) const fn num_indirect_stages(self) -> usize {
        ((self.gen_mode >> 16) & 7) as usize
    }

    pub(crate) const fn effective_tex_coord(self, requested: usize) -> usize {
        if requested < self.num_tex_gens() {
            requested
        } else {
            0
        }
    }

    pub(crate) const fn command(self, direct_stage: usize) -> IndirectTevCommand {
        IndirectTevCommand::decode(self.commands[direct_stage])
    }

    pub(crate) const fn reference(self, indirect_stage: usize) -> IndirectTevReference {
        let shift = indirect_stage * 6;
        IndirectTevReference {
            texture_map: ((self.iref >> shift) & 7) as usize,
            tex_coord: ((self.iref >> (shift + 3)) & 7) as usize,
        }
    }

    pub(crate) const fn scale(self, indirect_stage: usize) -> IndirectTevScale {
        let word = self.tex_scales[indirect_stage / 2];
        let shift = (indirect_stage % 2) * 8;
        IndirectTevScale {
            s_shift: (word >> shift) & 0xf,
            t_shift: (word >> (shift + 4)) & 0xf,
        }
    }

    pub(crate) fn matrix(self, matrix_index: usize) -> IndirectTevMatrix {
        let words = &self.matrices[matrix_index * 3..matrix_index * 3 + 3];
        let encoded_exponent =
            ((words[0] >> 22) & 3) | (((words[1] >> 22) & 3) << 2) | (((words[2] >> 22) & 1) << 4);
        IndirectTevMatrix {
            rows: [
                [
                    decode_signed_11(words[0]),
                    decode_signed_11(words[1]),
                    decode_signed_11(words[2]),
                ],
                [
                    decode_signed_11(words[0] >> 11),
                    decode_signed_11(words[1] >> 11),
                    decode_signed_11(words[2] >> 11),
                ],
            ],
            exponent: encoded_exponent as i32 - 17,
        }
    }

    pub(crate) fn sampled_indirect_stages(self, direct_stage_count: usize) -> [bool; 4] {
        let num_indirect_stages = self.num_indirect_stages().min(MAX_INDIRECT_TEV_STAGES);
        let mut sampled = [false; MAX_INDIRECT_TEV_STAGES];
        for stage in 0..direct_stage_count.min(MAX_TEV_STAGES) {
            let command = self.command(stage);
            if command.uses_indirect_sample(num_indirect_stages) {
                sampled[command.indirect_stage] = true;
            }
        }
        sampled
    }
}

const fn decode_signed_11(value: u32) -> i32 {
    ((value << 21) as i32) >> 21
}

fn checked_tev_stage_count(state: &[u8]) -> Result<usize, String> {
    if state.len() != TEV_DRAW_STATE_BYTES {
        return Err(format!(
            "TEV draw state must be exactly {TEV_DRAW_STATE_BYTES} bytes, got {}",
            state.len()
        ));
    }
    Ok(u32::from_le_bytes(
        state[448..452]
            .try_into()
            .expect("fixed TEV stage-count field"),
    ) as usize)
}

fn tev_state_stage_refs(state: &[u8], stage: usize) -> u32 {
    let refs_offset = stage * 16 + 8;
    u32::from_le_bytes(
        state[refs_offset..refs_offset + 4]
            .try_into()
            .expect("fixed TEV stage reference field"),
    )
}

/// Whether ordinary direct TEV sampling needs GEN_MODE to resolve its base
/// coordinate. With zero generators GX supplies a fixed zero coordinate and
/// leaves the direct texture input black; an out-of-range coordinate request
/// falls back to generator zero when at least one generator is active.
pub(crate) fn direct_texture_requires_gen_mode(
    direct_state: &[u8],
    num_tex_gens: usize,
) -> Result<bool, String> {
    let direct_stage_count = checked_tev_stage_count(direct_state)?;
    if num_tex_gens == 0 {
        // GX exposes fixed black TEXC/TEXA to every live TEV stage when no
        // texture generators exist, including stages whose TEV-order texture
        // enable bit is clear. The renderer therefore needs raw GEN_MODE even
        // when there is no ordinary direct texture lookup.
        return Ok(true);
    }
    for stage in 0..direct_stage_count.min(MAX_TEV_STAGES) {
        let refs = tev_state_stage_refs(direct_state, stage);
        if refs & (1 << 6) != 0 {
            let requested = ((refs >> 3) & 7) as usize;
            if requested >= num_tex_gens {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Texture maps consumed by indirect samples, excluding ordinary direct TEV
/// samples. IREF value zero is deliberately treated as map zero, not absent.
pub(crate) fn required_indirect_texture_maps(
    direct_state: &[u8],
    indirect: &IndirectTevState,
) -> Result<[bool; MAX_TEV_TEXTURES], String> {
    let direct_stage_count = checked_tev_stage_count(direct_state)?;
    let sampled = indirect.sampled_indirect_stages(direct_stage_count);
    let mut required = [false; MAX_TEV_TEXTURES];
    for (indirect_stage, is_sampled) in sampled.into_iter().enumerate() {
        if is_sampled {
            required[indirect.reference(indirect_stage).texture_map] = true;
        }
    }
    Ok(required)
}

/// Texture coordinates consumed by indirect samples, excluding the base
/// coordinates used by direct TEV stages. Out-of-range IREF coordinates use
/// GX's GEN_MODE coordinate-zero fallback.
pub(crate) fn required_indirect_texture_coords(
    direct_state: &[u8],
    indirect: &IndirectTevState,
) -> Result<[bool; MAX_TEV_TEXTURES], String> {
    let direct_stage_count = checked_tev_stage_count(direct_state)?;
    if indirect.num_tex_gens() == 0 {
        return Ok([false; MAX_TEV_TEXTURES]);
    }
    let sampled = indirect.sampled_indirect_stages(direct_stage_count);
    let mut required = [false; MAX_TEV_TEXTURES];
    for (indirect_stage, is_sampled) in sampled.into_iter().enumerate() {
        if is_sampled {
            let reference = indirect.reference(indirect_stage);
            required[indirect.effective_tex_coord(reference.tex_coord)] = true;
        }
    }
    Ok(required)
}

/// Full texture-map dataflow for direct and indirect sampling.
pub(crate) fn required_texture_maps_with_indirect(
    direct_state: &[u8],
    indirect: &IndirectTevState,
) -> Result<[bool; MAX_TEV_TEXTURES], String> {
    let mut required = if indirect.num_tex_gens() == 0 {
        // With no texture generators GX leaves ordinary direct texture input
        // black and performs no direct lookup. Indirect stages may still
        // sample a map at the synthesized fixed coordinate (0, 0).
        checked_tev_stage_count(direct_state)?;
        [false; MAX_TEV_TEXTURES]
    } else {
        required_texture_maps(direct_state)?
    };
    for (slot, is_required) in required
        .iter_mut()
        .zip(required_indirect_texture_maps(direct_state, indirect)?)
    {
        *slot |= is_required;
    }
    Ok(required)
}

/// Full coordinate dataflow. Every live stage updates the persistent indirect
/// coordinate, including a texture-disabled raw-zero command that resets the
/// value consumed by a later add-previous stage. NUMTEXGENS zero synthesizes a
/// fixed zero coordinate and therefore requires no vertex coordinate slot.
pub(crate) fn required_texture_coords_with_indirect(
    direct_state: &[u8],
    indirect: &IndirectTevState,
) -> Result<[bool; MAX_TEV_TEXTURES], String> {
    let direct_stage_count = checked_tev_stage_count(direct_state)?;
    let mut required = [false; MAX_TEV_TEXTURES];
    if indirect.num_tex_gens() != 0 {
        for stage in 0..direct_stage_count.min(MAX_TEV_STAGES) {
            let refs = tev_state_stage_refs(direct_state, stage);
            let requested = ((refs >> 3) & 7) as usize;
            required[indirect.effective_tex_coord(requested)] = true;
        }
    }
    for (slot, is_required) in required
        .iter_mut()
        .zip(required_indirect_texture_coords(direct_state, indirect)?)
    {
        *slot |= is_required;
    }
    Ok(required)
}

pub(crate) fn managed_tex_coord_sidecar_record(
    source_vertices: &[f32],
    indices: [usize; 3],
    required_coords: [bool; MAX_TEV_TEXTURES],
) -> Option<[u32; MANAGED_TEX_COORD_SIDECAR_WORDS]> {
    let vertex_count = source_vertices.len() / TEV_VERTEX_FLOATS;
    if !source_vertices.len().is_multiple_of(TEV_VERTEX_FLOATS)
        || indices.into_iter().any(|index| index >= vertex_count)
    {
        return None;
    }
    let mut record = [0_u32; MANAGED_TEX_COORD_SIDECAR_WORDS];
    let mut wrote_inv_w = false;
    for (texture_coord, required) in required_coords.into_iter().enumerate() {
        if !required {
            continue;
        }
        for (endpoint, index) in indices.into_iter().enumerate() {
            let offset = index * TEV_VERTEX_FLOATS;
            let inv_w = 1.0 / source_vertices[offset + 3];
            if !inv_w.is_finite() {
                return None;
            }
            if !wrote_inv_w {
                record[endpoint] = inv_w.to_bits();
            } else if record[endpoint] != inv_w.to_bits() {
                return None;
            }
            let source = offset + 12 + texture_coord * 3;
            let base = 3 + texture_coord * 9;
            for component in 0..3 {
                let over_w = source_vertices[source + component] * inv_w;
                if !over_w.is_finite() {
                    return None;
                }
                record[base + component * 3 + endpoint] = over_w.to_bits();
            }
        }
        wrote_inv_w = true;
    }
    wrote_inv_w.then_some(record)
}

pub(crate) fn managed_tex_coord_sidecar_fits(
    resident_words: usize,
    candidate: Option<&[u32]>,
    max_storage_bytes: usize,
) -> bool {
    let Some(candidate) = candidate else {
        return true;
    };
    if !candidate
        .len()
        .is_multiple_of(MANAGED_TEX_COORD_SIDECAR_WORDS)
    {
        return false;
    }
    let Some(total_words) = resident_words.checked_add(candidate.len()) else {
        return false;
    };
    let Some(total_bytes) = total_words.checked_mul(size_of::<u32>()) else {
        return false;
    };
    total_bytes <= max_storage_bytes
        && u32::try_from(total_words / MANAGED_TEX_COORD_SIDECAR_WORDS).is_ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedSidecarCapacityOutcome {
    Managed,
    NativeFallback,
    RejectManagedPayload,
}

pub(crate) fn managed_sidecar_capacity_outcome(
    required_exact: bool,
    resident_words: usize,
    candidate: Option<&[u32]>,
    max_storage_bytes: usize,
) -> ManagedSidecarCapacityOutcome {
    if managed_tex_coord_sidecar_fits(resident_words, candidate, max_storage_bytes) {
        ManagedSidecarCapacityOutcome::Managed
    } else if required_exact {
        ManagedSidecarCapacityOutcome::RejectManagedPayload
    } else {
        ManagedSidecarCapacityOutcome::NativeFallback
    }
}

pub(crate) fn managed_tex_coord_sidecar_record_base(
    resident_words: usize,
    triangle_count: usize,
) -> Option<u32> {
    if !resident_words.is_multiple_of(MANAGED_TEX_COORD_SIDECAR_WORDS) {
        return None;
    }
    let base = u32::try_from(resident_words / MANAGED_TEX_COORD_SIDECAR_WORDS).ok()?;
    base.checked_add(u32::try_from(triangle_count).ok()?)?;
    Some(base)
}

/// One TEV stage in the exact layout consumed by [`TEV_WGSL`].
///
/// `refs` uses the low ten bits of a BP TEV-order half: texture map in bits
/// 0..3, texture-coordinate index in bits 3..6, texture enable in bit 6, and
/// raster channel in bits 7..10.  `konst_selectors` stores the five-bit color
/// selector at bit zero and the five-bit alpha selector at bit five.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub(crate) struct TevStage {
    pub(crate) color_combiner: u32,
    pub(crate) alpha_combiner: u32,
    pub(crate) refs: u32,
    pub(crate) konst_selectors: u32,
}

impl TevStage {
    pub(crate) const fn from_bp(
        color_combiner: u32,
        alpha_combiner: u32,
        refs: u32,
        konst_color_selector: u8,
        konst_alpha_selector: u8,
    ) -> Self {
        Self {
            color_combiner: color_combiner & 0x00ff_ffff,
            alpha_combiner: alpha_combiner & 0x00ff_ffff,
            refs: refs & 0x3ff,
            konst_selectors: (konst_color_selector & 0x1f) as u32
                | (((konst_alpha_selector & 0x1f) as u32) << 5),
        }
    }

    pub(crate) const fn texture_map(self) -> usize {
        (self.refs & 7) as usize
    }

    pub(crate) const fn tex_coord(self) -> usize {
        ((self.refs >> 3) & 7) as usize
    }

    pub(crate) const fn texture_enabled(self) -> bool {
        self.refs & (1 << 6) != 0
    }

    pub(crate) const fn raster_channel(self) -> usize {
        ((self.refs >> 7) & 7) as usize
    }

    pub(crate) const fn raster_swap(self) -> usize {
        (self.alpha_combiner & 3) as usize
    }

    pub(crate) const fn texture_swap(self) -> usize {
        ((self.alpha_combiner >> 2) & 3) as usize
    }

    pub(crate) const fn konst_color_selector(self) -> u8 {
        (self.konst_selectors & 0x1f) as u8
    }

    pub(crate) const fn konst_alpha_selector(self) -> u8 {
        ((self.konst_selectors >> 5) & 0x1f) as u8
    }
}

/// Complete per-draw TEV state. Its 464-byte representation mirrors the WGSL
/// uniform declaration in [`TEV_WGSL`].
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub(crate) struct TevDrawState {
    pub(crate) stages: [TevStage; MAX_TEV_STAGES],
    /// Signed 11-bit GX values, indexed as R0, R1, R2, R3.
    pub(crate) color_registers: [TevColor; 4],
    /// Signed values are accepted; konst reads saturate them to eight bits.
    pub(crate) konst_registers: [TevColor; 4],
    /// Four RGBA channel maps. Each component is masked to two bits on read.
    pub(crate) swap_tables: [[u32; 4]; 4],
    pub(crate) stage_count: u32,
    _padding: [u32; 3],
}

impl Default for TevDrawState {
    fn default() -> Self {
        Self {
            stages: [TevStage::default(); MAX_TEV_STAGES],
            color_registers: [ZERO; 4],
            konst_registers: [ZERO; 4],
            swap_tables: [IDENTITY_SWAP; 4],
            stage_count: 0,
            _padding: [0; 3],
        }
    }
}

impl TevDrawState {
    pub(crate) fn set_stages(&mut self, stages: &[TevStage]) {
        let count = stages.len().min(MAX_TEV_STAGES);
        self.stages[..count].copy_from_slice(&stages[..count]);
        self.stages[count..].fill(TevStage::default());
        self.stage_count = count as u32;
    }

    pub(crate) fn set_swap_table(&mut self, index: usize, rg: u32, ba: u32) -> bool {
        let Some(table) = self.swap_tables.get_mut(index) else {
            return false;
        };
        *table = decode_swap_table(rg, ba);
        true
    }
}

/// Fixed-point S17.7 coordinates and already-fetched indirect texels for the
/// pure CPU coordinate reference model. Indirect samples use RGBA channel
/// order here and are converted to GX's A/B/G order during evaluation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IndirectTevInputs {
    pub(crate) tex_coords: [[i32; 2]; MAX_TEV_TEXTURES],
    pub(crate) samples: [TevColor; MAX_INDIRECT_TEV_STAGES],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IndirectTevLookup {
    pub(crate) required: bool,
    pub(crate) texture_map: usize,
    pub(crate) tex_coord: usize,
    pub(crate) sample_coord: [i32; 2],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IndirectTevStageCoordinates {
    pub(crate) base_coord: [i32; 2],
    pub(crate) sample_coord: [i32; 2],
    pub(crate) lod_coord: [i32; 2],
    pub(crate) alpha_bump: i32,
}

impl IndirectTevStageCoordinates {
    pub(crate) const fn normalized_alpha_bump(self) -> i32 {
        self.alpha_bump | (self.alpha_bump >> 5)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IndirectTevCoordinateEvaluation {
    pub(crate) stages: [IndirectTevStageCoordinates; MAX_TEV_STAGES],
    pub(crate) stage_count: usize,
    pub(crate) indirect_lookups: [IndirectTevLookup; MAX_INDIRECT_TEV_STAGES],
    pub(crate) final_coord: [i32; 2],
    pub(crate) alpha_bump: i32,
}

fn selected_texture_coord(
    indirect: &IndirectTevState,
    inputs: &IndirectTevInputs,
    requested: usize,
) -> [i32; 2] {
    if indirect.num_tex_gens() == 0 {
        [0; 2]
    } else {
        inputs.tex_coords[indirect.effective_tex_coord(requested)]
    }
}

const fn indirect_sample_abg(sample: TevColor) -> [i32; 3] {
    [sample[3], sample[2], sample[1]]
}

fn formatted_indirect_sample(
    sample_abg: [i32; 3],
    format: IndirectTevFormat,
    bias: [bool; 3],
) -> [i32; 3] {
    array::from_fn(|component| {
        (sample_abg[component] >> format.coordinate_shift())
            + if bias[component] {
                format.selected_bias()
            } else {
                0
            }
    })
}

const fn indirect_bump_alpha(
    sample_abg: [i32; 3],
    bump_alpha: IndirectTevBumpAlpha,
    format: IndirectTevFormat,
) -> Option<i32> {
    let component = match bump_alpha {
        IndirectTevBumpAlpha::Off => return None,
        IndirectTevBumpAlpha::S => sample_abg[0],
        IndirectTevBumpAlpha::T => sample_abg[1],
        IndirectTevBumpAlpha::U => sample_abg[2],
    };
    Some((component << format.bump_shift()) & 0xf8)
}

fn apply_indirect_exponent(value: i64, exponent: i32) -> i32 {
    let scaled = if exponent >= 0 {
        value << exponent
    } else {
        value >> -exponent
    };
    scaled as i32
}

fn indirect_matrix_transform(
    matrix: IndirectTevMatrix,
    matrix_id: IndirectTevMatrixId,
    formatted_sample: [i32; 3],
    base_coord: [i32; 2],
) -> [i32; 2] {
    match matrix_id {
        IndirectTevMatrixId::Static => array::from_fn(|row| {
            let dot = matrix.rows[row]
                .into_iter()
                .zip(formatted_sample)
                .map(|(coefficient, component)| coefficient as i64 * component as i64)
                .sum::<i64>();
            apply_indirect_exponent(dot >> 3, matrix.exponent)
        }),
        IndirectTevMatrixId::DynamicS | IndirectTevMatrixId::DynamicT => {
            let component = formatted_sample[match matrix_id {
                IndirectTevMatrixId::DynamicS => 0,
                IndirectTevMatrixId::DynamicT => 1,
                _ => unreachable!(),
            }];
            array::from_fn(|axis| {
                apply_indirect_exponent(
                    (base_coord[axis] as i64 * component as i64) >> 8,
                    matrix.exponent,
                )
            })
        }
        IndirectTevMatrixId::Invalid => [0; 2],
    }
}

const fn wrap_indirect_coord(coord: i32, wrap: IndirectTevWrap) -> i32 {
    let texels = match wrap {
        IndirectTevWrap::Off => return coord,
        IndirectTevWrap::Wrap256 => 256,
        IndirectTevWrap::Wrap128 => 128,
        IndirectTevWrap::Wrap64 => 64,
        IndirectTevWrap::Wrap32 => 32,
        IndirectTevWrap::Wrap16 => 16,
        IndirectTevWrap::Zero | IndirectTevWrap::Invalid => return 0,
    };
    coord & ((texels << 7) - 1)
}

const fn signed_24(value: i32) -> i32 {
    ((value as u32) << 8) as i32 >> 8
}

/// Evaluate the GameCube indirect-TEV coordinate pipeline without sampling or
/// combining color. This intentionally leaves the existing direct evaluator's
/// API and behavior unchanged.
pub(crate) fn evaluate_indirect_coordinates(
    direct: &TevDrawState,
    indirect: &IndirectTevState,
    inputs: &IndirectTevInputs,
) -> IndirectTevCoordinateEvaluation {
    let stage_count = (direct.stage_count as usize).min(MAX_TEV_STAGES);
    let num_indirect_stages = indirect.num_indirect_stages().min(MAX_INDIRECT_TEV_STAGES);
    let sampled_indirect_stages = indirect.sampled_indirect_stages(stage_count);
    let mut indirect_lookups = [IndirectTevLookup::default(); MAX_INDIRECT_TEV_STAGES];
    for indirect_stage in 0..MAX_INDIRECT_TEV_STAGES {
        let reference = indirect.reference(indirect_stage);
        let tex_coord = indirect.effective_tex_coord(reference.tex_coord);
        let unscaled = selected_texture_coord(indirect, inputs, reference.tex_coord);
        let scale = indirect.scale(indirect_stage);
        indirect_lookups[indirect_stage] = IndirectTevLookup {
            required: sampled_indirect_stages[indirect_stage],
            texture_map: reference.texture_map,
            tex_coord,
            sample_coord: [unscaled[0] >> scale.s_shift, unscaled[1] >> scale.t_shift],
        };
    }

    let mut stages = [IndirectTevStageCoordinates::default(); MAX_TEV_STAGES];
    let mut previous_coord = [0; 2];
    let mut alpha_bump = 0;
    for (stage_index, direct_stage) in direct.stages.iter().copied().take(stage_count).enumerate() {
        let base_coord = selected_texture_coord(indirect, inputs, direct_stage.tex_coord());
        let command = indirect.command(stage_index);
        if command.raw == 0 {
            previous_coord = base_coord;
            stages[stage_index] = IndirectTevStageCoordinates {
                base_coord,
                sample_coord: base_coord,
                lod_coord: base_coord,
                alpha_bump,
            };
            continue;
        }

        let mut transform = [0; 2];
        if command.indirect_stage < num_indirect_stages {
            let sample_abg = indirect_sample_abg(inputs.samples[command.indirect_stage]);
            if let Some(next_alpha_bump) =
                indirect_bump_alpha(sample_abg, command.bump_alpha, command.format)
            {
                alpha_bump = next_alpha_bump;
            }
            if let Some(matrix_index) = command.matrix_index {
                transform = indirect_matrix_transform(
                    indirect.matrix(matrix_index),
                    command.matrix_id,
                    formatted_indirect_sample(sample_abg, command.format, command.bias),
                    base_coord,
                );
            }
        }

        let wrapped = [
            wrap_indirect_coord(base_coord[0], command.wrap_s),
            wrap_indirect_coord(base_coord[1], command.wrap_t),
        ];
        let sample_coord = array::from_fn(|axis| {
            let with_transform = wrapped[axis].wrapping_add(transform[axis]);
            let with_previous = if command.add_previous {
                with_transform.wrapping_add(previous_coord[axis])
            } else {
                with_transform
            };
            signed_24(with_previous)
        });
        previous_coord = sample_coord;
        stages[stage_index] = IndirectTevStageCoordinates {
            base_coord,
            sample_coord,
            lod_coord: if command.use_unmodified_lod {
                base_coord
            } else {
                sample_coord
            },
            alpha_bump,
        };
    }

    IndirectTevCoordinateEvaluation {
        stages,
        stage_count,
        indirect_lookups,
        final_coord: previous_coord,
        alpha_bump,
    }
}

/// Already-interpolated inputs for the CPU reference evaluator.
///
/// Texture entries are sampled texels. Raster entries let the caller provide
/// channel 0/1 and, when indirect texturing is implemented, alpha-bump channels
/// 5/6. Raster channel 7 is always forced to zero by TEV.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(target_arch = "wasm32", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub(crate) struct TevFragmentInputs {
    pub(crate) textures: [TevColor; MAX_TEV_TEXTURES],
    pub(crate) rasters: [TevColor; MAX_TEV_RASTER_CHANNELS],
}

impl Default for TevFragmentInputs {
    fn default() -> Self {
        Self {
            textures: [WHITE; MAX_TEV_TEXTURES],
            rasters: [ZERO; MAX_TEV_RASTER_CHANNELS],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TevEvaluation {
    /// Signed final TEV values before render-target saturation.
    pub(crate) raw: TevColor,
    /// Final color as written to an RGBA8 render target.
    pub(crate) rgba8: [u8; 4],
    /// Unswizzled sample from the last texture-enabled stage, or zero.
    pub(crate) last_texture: TevColor,
    pub(crate) registers: [TevColor; 4],
    pub(crate) last_color_destination: usize,
    pub(crate) last_alpha_destination: usize,
}

pub(crate) const fn decode_swap_table(rg: u32, ba: u32) -> [u32; 4] {
    [rg & 3, (rg >> 2) & 3, ba & 3, (ba >> 2) & 3]
}

pub(crate) const fn register_index(encoded: u32) -> usize {
    if encoded & 3 == 0 {
        3
    } else {
        ((encoded & 3) - 1) as usize
    }
}

fn swizzle(color: TevColor, table: [u32; 4]) -> TevColor {
    array::from_fn(|channel| color[(table[channel] & 3) as usize])
}

fn konst_color(selector: u8, registers: &[TevColor; 4]) -> [i32; 3] {
    const FRACTIONS: [i32; 8] = [255, 223, 191, 159, 128, 96, 64, 32];
    match selector {
        0..=7 => [FRACTIONS[selector as usize]; 3],
        12..=15 => {
            let value = registers[(selector - 12) as usize];
            array::from_fn(|channel| value[channel].clamp(0, 255))
        }
        16..=31 => {
            let register = ((selector - 16) & 3) as usize;
            let channel = ((selector - 16) >> 2) as usize;
            [registers[register][channel].clamp(0, 255); 3]
        }
        _ => [0; 3],
    }
}

fn konst_alpha(selector: u8, registers: &[TevColor; 4]) -> i32 {
    const FRACTIONS: [i32; 8] = [255, 223, 191, 159, 128, 96, 64, 32];
    match selector {
        0..=7 => FRACTIONS[selector as usize],
        16..=31 => {
            let register = ((selector - 16) & 3) as usize;
            let channel = ((selector - 16) >> 2) as usize;
            registers[register][channel].clamp(0, 255)
        }
        _ => 0,
    }
}

fn color_argument(
    argument: u32,
    channel: usize,
    registers: &[TevColor; 4],
    texture: TevColor,
    raster: TevColor,
    konst: [i32; 3],
) -> i32 {
    let argument = argument & 0xf;
    if argument <= 7 {
        let register = register_index(argument >> 1);
        return registers[register][if argument & 1 == 0 { channel } else { 3 }];
    }
    match argument {
        8 => texture[channel],
        9 => texture[3],
        10 => raster[channel],
        11 => raster[3],
        12 => 255,
        13 => 128,
        14 => konst[channel],
        _ => 0,
    }
}

fn color_input(
    argument: u32,
    registers: &[TevColor; 4],
    texture: TevColor,
    raster: TevColor,
    konst: [i32; 3],
) -> [i32; 3] {
    array::from_fn(|channel| color_argument(argument, channel, registers, texture, raster, konst))
}

fn alpha_argument(
    argument: u32,
    registers: &[TevColor; 4],
    texture: TevColor,
    raster: TevColor,
    konst: i32,
) -> i32 {
    let argument = argument & 7;
    if argument <= 3 {
        return registers[register_index(argument)][3];
    }
    match argument {
        4 => texture[3],
        5 => raster[3],
        6 => konst,
        _ => 0,
    }
}

fn clamp_result(value: i32, combiner: u32) -> i32 {
    if combiner & (1 << 19) != 0 {
        value.clamp(0, 255)
    } else {
        value.clamp(-1024, 1023)
    }
}

/// Canonical signed GX add/subtract combiner in byte units.
pub(crate) fn evaluate_regular(a: i32, b: i32, c: i32, d: i32, combiner: u32) -> i32 {
    // A/B/C read through unsigned eight-bit lanes. D preserves the signed
    // eleven-bit register range across stages.
    let a = a & 0xff;
    let b = b & 0xff;
    let mut c = c & 0xff;
    // Flipper expands C from 0..255 to 0..256 and keeps the interpolation in
    // fixed point. Scaling before the arithmetic shift preserves extra bits.
    c += c >> 7;
    let mut d = d;
    match (combiner >> 16) & 3 {
        1 => d += 128,
        2 => d -= 128,
        _ => {}
    }
    let subtract = combiner & (1 << 18) != 0;
    let scale = (combiner >> 20) & 3;
    let mut mixed = (a << 8) + (b - a) * c;
    if scale != 3 {
        mixed <<= scale;
        d <<= scale;
        mixed += if subtract { 127 } else { 128 };
    }
    mixed >>= 8;
    let mut result = if subtract { d - mixed } else { d + mixed };
    // Divide-by-two is the one scale mode without a rounding bias.
    if scale == 3 {
        result >>= 1;
    }
    clamp_result(result, combiner)
}

fn comparison(a: u32, b: u32, combiner: u32) -> bool {
    if combiner & (1 << 18) != 0 {
        a == b
    } else {
        a > b
    }
}

fn packed_color(color: [i32; 3], target: u32) -> u32 {
    let mut value = (color[0] & 0xff) as u32;
    if target >= 1 {
        value |= ((color[1] & 0xff) as u32) << 8;
    }
    if target >= 2 {
        value |= ((color[2] & 0xff) as u32) << 16;
    }
    value
}

pub(crate) fn evaluate_color_combiner(
    a: [i32; 3],
    b: [i32; 3],
    c: [i32; 3],
    d: [i32; 3],
    combiner: u32,
) -> [i32; 3] {
    if (combiner >> 16) & 3 != 3 {
        return array::from_fn(|channel| {
            evaluate_regular(a[channel], b[channel], c[channel], d[channel], combiner)
        });
    }

    let target = (combiner >> 20) & 3;
    if target == 3 {
        return array::from_fn(|channel| {
            let selected = comparison(
                (a[channel] & 0xff) as u32,
                (b[channel] & 0xff) as u32,
                combiner,
            );
            clamp_result(
                d[channel] + if selected { c[channel] & 0xff } else { 0 },
                combiner,
            )
        });
    }

    let selected = comparison(packed_color(a, target), packed_color(b, target), combiner);
    array::from_fn(|channel| {
        clamp_result(
            d[channel] + if selected { c[channel] & 0xff } else { 0 },
            combiner,
        )
    })
}

pub(crate) fn evaluate_alpha_combiner(
    color_a: [i32; 3],
    color_b: [i32; 3],
    a: i32,
    b: i32,
    c: i32,
    d: i32,
    combiner: u32,
) -> i32 {
    if (combiner >> 16) & 3 != 3 {
        return evaluate_regular(a, b, c, d, combiner);
    }

    let target = (combiner >> 20) & 3;
    // R8/GR16/BGR24 alpha comparisons use the color combiner's A/B sources;
    // only A8 (target 3) compares the alpha combiner's A/B sources.
    let compare_a = if target == 3 {
        (a & 0xff) as u32
    } else {
        packed_color(color_a, target)
    };
    let compare_b = if target == 3 {
        (b & 0xff) as u32
    } else {
        packed_color(color_b, target)
    };
    clamp_result(
        d + if comparison(compare_a, compare_b, combiner) {
            c & 0xff
        } else {
            0
        },
        combiner,
    )
}

pub(crate) fn evaluate(state: &TevDrawState, inputs: &TevFragmentInputs) -> TevEvaluation {
    let mut registers = state.color_registers;
    let mut last_texture = ZERO;
    let mut last_color_destination = 3;
    let mut last_alpha_destination = 3;

    for stage in state
        .stages
        .iter()
        .copied()
        .take((state.stage_count as usize).min(MAX_TEV_STAGES))
    {
        let texture_base = if stage.texture_enabled() {
            let texture = inputs.textures[stage.texture_map()];
            last_texture = texture;
            texture
        } else {
            WHITE
        };
        let texture = swizzle(texture_base, state.swap_tables[stage.texture_swap()]);
        let raster_base = if stage.raster_channel() == 7 {
            ZERO
        } else {
            inputs.rasters[stage.raster_channel()]
        };
        let raster = swizzle(raster_base, state.swap_tables[stage.raster_swap()]);
        let color_konst = konst_color(stage.konst_color_selector(), &state.konst_registers);
        let alpha_konst = konst_alpha(stage.konst_alpha_selector(), &state.konst_registers);

        let color_combiner = stage.color_combiner;
        let color_argument_index = |shift: u32| (color_combiner >> shift) & 0xf;
        let color_a = color_input(
            color_argument_index(12),
            &registers,
            texture,
            raster,
            color_konst,
        );
        let color_b = color_input(
            color_argument_index(8),
            &registers,
            texture,
            raster,
            color_konst,
        );
        let color_c = color_input(
            color_argument_index(4),
            &registers,
            texture,
            raster,
            color_konst,
        );
        let color_d = color_input(
            color_argument_index(0),
            &registers,
            texture,
            raster,
            color_konst,
        );
        let color_result =
            evaluate_color_combiner(color_a, color_b, color_c, color_d, color_combiner);

        let alpha_combiner = stage.alpha_combiner;
        let alpha_argument_index = |shift: u32| (alpha_combiner >> shift) & 7;
        let alpha_a = alpha_argument(
            alpha_argument_index(13),
            &registers,
            texture,
            raster,
            alpha_konst,
        );
        let alpha_b = alpha_argument(
            alpha_argument_index(10),
            &registers,
            texture,
            raster,
            alpha_konst,
        );
        let alpha_c = alpha_argument(
            alpha_argument_index(7),
            &registers,
            texture,
            raster,
            alpha_konst,
        );
        let alpha_d = alpha_argument(
            alpha_argument_index(4),
            &registers,
            texture,
            raster,
            alpha_konst,
        );
        let alpha_result = evaluate_alpha_combiner(
            color_a,
            color_b,
            alpha_a,
            alpha_b,
            alpha_c,
            alpha_d,
            alpha_combiner,
        );

        let color_destination = register_index((color_combiner >> 22) & 3);
        let alpha_destination = register_index((alpha_combiner >> 22) & 3);
        registers[color_destination][..3].copy_from_slice(&color_result);
        registers[alpha_destination][3] = alpha_result;
        last_color_destination = color_destination;
        last_alpha_destination = alpha_destination;
    }

    let raw = [
        registers[last_color_destination][0],
        registers[last_color_destination][1],
        registers[last_color_destination][2],
        registers[last_alpha_destination][3],
    ];
    TevEvaluation {
        raw,
        rgba8: raw.map(|value| value.clamp(0, 255) as u8),
        last_texture,
        registers,
        last_color_destination,
        last_alpha_destination,
    }
}

// Keep these assertions next to the uniform contract. A layout change must be
// reflected in the WGSL declaration before it can compile.
const _: () = {
    assert!(size_of::<TevStage>() == 16);
    assert!(align_of::<TevStage>() == 16);
    assert!(size_of::<TevDrawState>() == 464);
    assert!(align_of::<TevDrawState>() == 16);
    assert!(size_of::<TevFragmentInputs>() == 256);
    assert!(align_of::<TevFragmentInputs>() == 16);
};

/// WGSL implementation of the CPU evaluator.
///
/// Integration contract:
/// - bind this block at group 1;
/// - upload one [`TevDrawState`] at binding 0;
/// - bind texture maps 0..7 at bindings 1..8 and their samplers at 9..16;
/// - upload the 128-byte indirect/GEN_MODE side uniform at binding 17;
/// - call `tev_evaluate(raster_colors, managed_raster_bytes, tex_coords,
///   managed_exact_sampler)` from a fragment entry point;
/// - provide GX-scaled, texel-space STQ coordinates; sampling performs `st / q`
///   in the fragment stage so interpolation remains projective, then only the
///   native hardware-sampler path normalizes by the selected map dimensions.
pub(crate) const TEV_VERTEX_WGSL: &str = "enable dual_source_blending;

struct DrawState {
    alpha_test: u32,
    destination_alpha: u32,
    fragment_flags: u32,
    z_texture: u32,
    fog_control: vec4<u32>,
    fog_range0: vec4<u32>,
    fog_range1: vec4<u32>,
    fog_parameters0: vec4<u32>,
    fog_parameters1: vec4<u32>,
    sampler_mode0_lo: vec4<u32>,
    sampler_mode0_hi: vec4<u32>,
    sampler_mode1_lo: vec4<u32>,
    sampler_mode1_hi: vec4<u32>,
};

struct TevVertexInput {
    @location(0) position: vec4<f32>,
    @location(1) raster0: vec4<f32>,
    @location(2) raster1: vec4<f32>,
    @location(3) stq0: vec3<f32>,
    @location(4) stq1: vec3<f32>,
    @location(5) stq2: vec3<f32>,
    @location(6) stq3: vec3<f32>,
    @location(7) stq4: vec3<f32>,
    @location(8) stq5: vec3<f32>,
    @location(9) stq6: vec3<f32>,
    @location(10) stq7: vec3<f32>,
};

struct TevVertexOutput {
    @invariant @builtin(position) position: vec4<f32>,
    @location(0) raster0: vec4<f32>,
    @location(1) raster1: vec4<f32>,
    @location(2) stq0: vec3<f32>,
    @location(3) stq1: vec3<f32>,
    @location(4) stq2: vec3<f32>,
    @location(5) stq3: vec3<f32>,
    @location(6) stq4: vec3<f32>,
    @location(7) stq5: vec3<f32>,
    @location(8) stq6: vec3<f32>,
    @location(9) stq7: vec3<f32>,
    @location(10) @interpolate(linear) depth24: f32,
};

struct ManagedCoverageVertexInput {
    @location(0) position: vec4<f32>,
    @location(1) raster0_endpoints: vec4<u32>,
    @location(2) raster1_endpoints: vec4<u32>,
    @location(3) source_x_bits: vec3<u32>,
    @location(4) source_y_bits: vec3<u32>,
    @location(5) stq2: vec3<f32>,
    @location(6) stq3: vec3<f32>,
    @location(7) stq4: vec3<f32>,
    @location(8) stq5: vec3<f32>,
    @location(11) packed_xy28_4_depth0: vec4<i32>,
    @location(12) depth12: vec2<i32>,
};

struct ManagedCoverageVertexOutput {
    @invariant @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) raster0_endpoints: vec4<u32>,
    @location(1) @interpolate(flat) raster1_endpoints: vec3<u32>,
    @location(2) @interpolate(flat) source_x_bits: vec3<u32>,
    @location(3) @interpolate(flat) source_y_bits: vec3<u32>,
    @location(4) @interpolate(flat) stq2: vec3<f32>,
    @location(5) @interpolate(flat) stq3: vec3<f32>,
    @location(6) @interpolate(flat) stq4: vec3<f32>,
    @location(7) @interpolate(flat) stq5: vec3<f32>,
    @location(10) @interpolate(flat) source_depth24: vec3<f32>,
    @location(11) @interpolate(flat) packed_xy28_4: vec3<i32>,
};

struct CanonicalDepthOutput {
    @builtin(frag_depth) depth: f32,
};

@group(0) @binding(2) var<uniform> draw_state: DrawState;
@group(2) @binding(0) var<storage, read>
    managed_tex_coord_sidecar: array<vec4<u32>>;

fn gx_raster_depth24(depth24: f32) -> u32 {
    if !(depth24 > 0.0) {
        return 0u;
    }
    if depth24 >= 16777215.0 {
        return 0x00ffffffu;
    }
    return u32(depth24);
}

fn gx_depth24_to_attachment(depth: u32) -> f32 {
    return f32(depth & 0x00ffffffu) / 16777215.0;
}

fn gx_z16_leading_ones(depth: u32) -> u32 {
    var leading_ones = 0u;
    for (var index = 0u; index < 24u; index += 1u) {
        if (depth & (1u << (23u - index))) == 0u {
            break;
        }
        leading_ones += 1u;
    }
    return leading_ones;
}

fn gx_compress_z16(depth: u32, encoding: u32) -> u32 {
    let source = depth & 0x00ffffffu;
    if encoding == 1u {
        return source >> 8u;
    }

    var exponent_bits = 2u;
    var maximum_exponent = 3u;
    if encoding == 3u {
        exponent_bits = 3u;
        maximum_exponent = 7u;
    } else if encoding == 4u {
        exponent_bits = 4u;
        maximum_exponent = 12u;
    }
    let source_leading_ones = gx_z16_leading_ones(source);
    let exponent = min(source_leading_ones, maximum_exponent);
    let exponent_is_clamped = source_leading_ones >= maximum_exponent;
    let mantissa_bits = 16u - exponent_bits;
    var mantissa_top = max(24u - exponent, mantissa_bits);
    if !exponent_is_clamped {
        mantissa_top -= 1u;
    }
    let bottom = mantissa_top - mantissa_bits;
    let mask = (1u << mantissa_bits) - 1u;
    return (exponent << mantissa_bits) | ((source >> bottom) & mask);
}

fn gx_efb_depth_to_attachment(depth: u32, encoding: u32) -> f32 {
    if encoding == 0u {
        return gx_depth24_to_attachment(depth);
    }
    return f32(gx_compress_z16(depth, encoding)) / 65535.0;
}

@vertex
fn vs_main(input: TevVertexInput) -> TevVertexOutput {
    var output: TevVertexOutput;
    output.position = vec4<f32>(
        (input.position.x / 320.0 - 1.0) * input.position.w,
        (1.0 - input.position.y / 264.0) * input.position.w,
        (input.position.z / 16777215.0) * input.position.w,
        input.position.w,
    );
    output.raster0 = input.raster0;
    output.raster1 = input.raster1;
    output.stq0 = input.stq0;
    output.stq1 = input.stq1;
    output.stq2 = input.stq2;
    output.stq3 = input.stq3;
    output.stq4 = input.stq4;
    output.stq5 = input.stq5;
    output.stq6 = input.stq6;
    output.stq7 = input.stq7;
    output.depth24 = input.position.z;
    return output;
}

@vertex
fn vs_managed_coverage(
    input: ManagedCoverageVertexInput,
) -> ManagedCoverageVertexOutput {
    var output: ManagedCoverageVertexOutput;
    output.position = vec4<f32>(
        (input.position.x / 320.0 - 1.0) * input.position.w,
        (1.0 - input.position.y / 264.0) * input.position.w,
        (input.position.z / 16777215.0) * input.position.w,
        input.position.w,
    );
    output.raster0_endpoints = input.raster0_endpoints;
    output.raster1_endpoints = input.raster1_endpoints.xyz;
    output.source_x_bits = input.source_x_bits;
    output.source_y_bits = input.source_y_bits;
    output.stq2 = input.stq2;
    output.stq3 = input.stq3;
    output.stq4 = input.stq4;
    output.stq5 = input.stq5;
    output.source_depth24 = vec3<f32>(
        bitcast<f32>(u32(input.packed_xy28_4_depth0.w)),
        bitcast<f32>(u32(input.depth12.x)),
        bitcast<f32>(u32(input.depth12.y)),
    );
    output.packed_xy28_4 = input.packed_xy28_4_depth0.xyz;
    return output;
}

const SF32_SIGN_MASK = 0x80000000u;
const SF32_EXPONENT_MASK = 0x7f800000u;
const SF32_FRACTION_MASK = 0x007fffffu;
const SF32_INFINITY = 0x7f800000u;
const SF32_CANONICAL_NAN = 0x7fc00000u;

struct Sf32Parts {
    sign: u32,
    exponent: i32,
    significand: u32,
};

struct Sf32U64 {
    high: u32,
    low: u32,
};

fn sf32_is_nan(bits: u32) -> bool {
    return (bits & SF32_EXPONENT_MASK) == SF32_EXPONENT_MASK
        && (bits & SF32_FRACTION_MASK) != 0u;
}

fn sf32_is_infinite(bits: u32) -> bool {
    return (bits & 0x7fffffffu) == SF32_INFINITY;
}

fn sf32_is_zero(bits: u32) -> bool {
    return (bits & 0x7fffffffu) == 0u;
}

fn sf32_decode_finite_nonzero(bits: u32) -> Sf32Parts {
    let exponent_field = (bits >> 23u) & 0xffu;
    var exponent = i32(exponent_field) - 127;
    var significand = bits & SF32_FRACTION_MASK;
    if exponent_field == 0u {
        let shift = countLeadingZeros(significand) - 8u;
        significand <<= shift;
        exponent = -126 - i32(shift);
    } else {
        significand |= 0x00800000u;
    }
    var parts: Sf32Parts;
    parts.sign = bits & SF32_SIGN_MASK;
    parts.exponent = exponent;
    parts.significand = significand;
    return parts;
}

fn sf32_shift_right_jam(value: u32, distance: u32) -> u32 {
    if distance == 0u {
        return value;
    }
    if distance < 32u {
        let shifted = value >> distance;
        let discarded = (value << (32u - distance)) != 0u;
        return shifted | select(0u, 1u, discarded);
    }
    return select(0u, 1u, value != 0u);
}

fn sf32_round_pack(sign: u32, initial_exponent: i32, initial_significand: u32) -> u32 {
    var exponent = initial_exponent;
    var significand = initial_significand;
    if significand == 0u {
        return sign;
    }
    if significand >= 0x08000000u {
        significand = sf32_shift_right_jam(significand, 1u);
        exponent += 1;
    }
    loop {
        if significand >= 0x04000000u {
            break;
        }
        significand <<= 1u;
        exponent -= 1;
    }
    if exponent < -126 {
        significand = sf32_shift_right_jam(significand, u32(-126 - exponent));
        exponent = -126;
    }
    let round_bits = significand & 7u;
    var rounded = significand >> 3u;
    if round_bits > 4u || (round_bits == 4u && (rounded & 1u) != 0u) {
        rounded += 1u;
    }
    if rounded >= 0x01000000u {
        rounded >>= 1u;
        exponent += 1;
    }
    if exponent > 127 {
        return sign | SF32_INFINITY;
    }
    if rounded == 0u {
        return sign;
    }
    var exponent_field = 0u;
    if exponent != -126 || rounded >= 0x00800000u {
        exponent_field = u32(exponent + 127);
    }
    return sign | (exponent_field << 23u) | (rounded & SF32_FRACTION_MASK);
}

fn sf32_add(left_bits: u32, right_bits: u32) -> u32 {
    if sf32_is_nan(left_bits) || sf32_is_nan(right_bits) {
        return SF32_CANONICAL_NAN;
    }
    let left_infinite = sf32_is_infinite(left_bits);
    let right_infinite = sf32_is_infinite(right_bits);
    if left_infinite || right_infinite {
        if left_infinite && right_infinite
            && ((left_bits ^ right_bits) & SF32_SIGN_MASK) != 0u {
            return SF32_CANONICAL_NAN;
        }
        return select(right_bits, left_bits, left_infinite);
    }
    let left_zero = sf32_is_zero(left_bits);
    let right_zero = sf32_is_zero(right_bits);
    if left_zero && right_zero {
        return (left_bits & right_bits) & SF32_SIGN_MASK;
    }
    if left_zero {
        return right_bits;
    }
    if right_zero {
        return left_bits;
    }

    var large_bits = left_bits;
    var small_bits = right_bits;
    if (large_bits & 0x7fffffffu) < (small_bits & 0x7fffffffu) {
        let swap = large_bits;
        large_bits = small_bits;
        small_bits = swap;
    }
    if (large_bits & 0x7fffffffu) == (small_bits & 0x7fffffffu)
        && ((large_bits ^ small_bits) & SF32_SIGN_MASK) != 0u {
        return 0u;
    }

    let large = sf32_decode_finite_nonzero(large_bits);
    let small = sf32_decode_finite_nonzero(small_bits);
    let exponent_distance = u32(large.exponent - small.exponent);
    let large_significand = large.significand << 3u;
    let small_significand =
        sf32_shift_right_jam(small.significand << 3u, exponent_distance);
    var result_significand: u32;
    if ((large_bits ^ small_bits) & SF32_SIGN_MASK) == 0u {
        result_significand = large_significand + small_significand;
    } else {
        result_significand = large_significand - small_significand;
    }
    return sf32_round_pack(large.sign, large.exponent, result_significand);
}

fn sf32_sub(left_bits: u32, right_bits: u32) -> u32 {
    return sf32_add(left_bits, right_bits ^ SF32_SIGN_MASK);
}

fn sf32_mul_u24(left: u32, right: u32) -> Sf32U64 {
    let left_low = left & 0xffffu;
    let left_high = left >> 16u;
    let right_low = right & 0xffffu;
    let right_high = right >> 16u;
    let low_product = left_low * right_low;
    let cross0 = left_low * right_high;
    let cross1 = left_high * right_low;
    var low = low_product;
    var high = left_high * right_high;
    var added = low + (cross0 << 16u);
    high += (cross0 >> 16u) + select(0u, 1u, added < low);
    low = added;
    added = low + (cross1 << 16u);
    high += (cross1 >> 16u) + select(0u, 1u, added < low);
    low = added;
    var product: Sf32U64;
    product.high = high;
    product.low = low;
    return product;
}

fn sf32_u64_shift_right_jam(value: Sf32U64, distance: u32) -> u32 {
    // The 24x24 product path calls this with 20 or 21. Keeping the bounded
    // range explicit avoids backend-dependent shifts by the word width.
    let shifted = (value.low >> distance) | (value.high << (32u - distance));
    let discarded = (value.low << (32u - distance)) != 0u;
    return shifted | select(0u, 1u, discarded);
}

fn sf32_mul(left_bits: u32, right_bits: u32) -> u32 {
    if sf32_is_nan(left_bits) || sf32_is_nan(right_bits) {
        return SF32_CANONICAL_NAN;
    }
    let sign = (left_bits ^ right_bits) & SF32_SIGN_MASK;
    let left_infinite = sf32_is_infinite(left_bits);
    let right_infinite = sf32_is_infinite(right_bits);
    let left_zero = sf32_is_zero(left_bits);
    let right_zero = sf32_is_zero(right_bits);
    if (left_infinite && right_zero) || (right_infinite && left_zero) {
        return SF32_CANONICAL_NAN;
    }
    if left_infinite || right_infinite {
        return sign | SF32_INFINITY;
    }
    if left_zero || right_zero {
        return sign;
    }
    let left = sf32_decode_finite_nonzero(left_bits);
    let right = sf32_decode_finite_nonzero(right_bits);
    let product = sf32_mul_u24(left.significand, right.significand);
    let leading_bit_47 = (product.high & 0x00008000u) != 0u;
    let distance = select(20u, 21u, leading_bit_47);
    let exponent = left.exponent + right.exponent + select(0, 1, leading_bit_47);
    let significand = sf32_u64_shift_right_jam(product, distance);
    return sf32_round_pack(sign, exponent, significand);
}

fn sf32_div(numerator_bits: u32, denominator_bits: u32) -> u32 {
    if sf32_is_nan(numerator_bits) || sf32_is_nan(denominator_bits) {
        return SF32_CANONICAL_NAN;
    }
    let sign = (numerator_bits ^ denominator_bits) & SF32_SIGN_MASK;
    let numerator_infinite = sf32_is_infinite(numerator_bits);
    let denominator_infinite = sf32_is_infinite(denominator_bits);
    let numerator_zero = sf32_is_zero(numerator_bits);
    let denominator_zero = sf32_is_zero(denominator_bits);
    if (numerator_infinite && denominator_infinite) || (numerator_zero && denominator_zero) {
        return SF32_CANONICAL_NAN;
    }
    if numerator_infinite || denominator_zero {
        return sign | SF32_INFINITY;
    }
    if numerator_zero || denominator_infinite {
        return sign;
    }
    let numerator = sf32_decode_finite_nonzero(numerator_bits);
    let denominator = sf32_decode_finite_nonzero(denominator_bits);
    var exponent = numerator.exponent - denominator.exponent;
    var remainder = numerator.significand;
    if remainder < denominator.significand {
        remainder <<= 1u;
        exponent -= 1;
    }
    remainder -= denominator.significand;
    var quotient = 1u;
    for (var bit = 0u; bit < 26u; bit += 1u) {
        remainder <<= 1u;
        quotient <<= 1u;
        if remainder >= denominator.significand {
            remainder -= denominator.significand;
            quotient |= 1u;
        }
    }
    if remainder != 0u {
        quotient |= 1u;
    }
    return sf32_round_pack(sign, exponent, quotient);
}

fn sf32_from_u32(value: u32) -> u32 {
    if value == 0u {
        return 0u;
    }
    var highest_bit = 31u - countLeadingZeros(value);
    var significand: u32;
    if highest_bit <= 23u {
        significand = value << (23u - highest_bit);
    } else {
        let distance = highest_bit - 23u;
        significand = value >> distance;
        let discarded_mask = (1u << distance) - 1u;
        let discarded = value & discarded_mask;
        let halfway = 1u << (distance - 1u);
        if discarded > halfway || (discarded == halfway && (significand & 1u) != 0u) {
            significand += 1u;
        }
        if significand == 0x01000000u {
            significand >>= 1u;
            highest_bit += 1u;
        }
    }
    return ((highest_bit + 127u) << 23u) | (significand & SF32_FRACTION_MASK);
}

fn sf32_to_gx_u8(bits: u32) -> u32 {
    if (bits & SF32_SIGN_MASK) != 0u || sf32_is_nan(bits) || sf32_is_zero(bits) {
        return 0u;
    }
    if sf32_is_infinite(bits) || bits >= 0x437f0000u {
        return 255u;
    }
    let exponent_field = (bits >> 23u) & 0xffu;
    if exponent_field < 127u {
        return 0u;
    }
    let exponent = exponent_field - 127u;
    let significand = (bits & SF32_FRACTION_MASK) | 0x00800000u;
    return significand >> (23u - exponent);
}

fn gx_managed_unpack_rgba8(packed: u32) -> vec4<u32> {
    return vec4<u32>(
        packed & 0xffu,
        (packed >> 8u) & 0xffu,
        (packed >> 16u) & 0xffu,
        packed >> 24u,
    );
}

fn gx_managed_soft_attribute_at_sample(
    source_x_bits: vec3<u32>,
    source_y_bits: vec3<u32>,
    attribute_bits: vec3<u32>,
    sample_x_bits: u32,
    sample_y_bits: u32,
) -> u32 {
    let dx10 = sf32_sub(source_x_bits.y, source_x_bits.x);
    let dx20 = sf32_sub(source_x_bits.z, source_x_bits.x);
    let dy10 = sf32_sub(source_y_bits.y, source_y_bits.x);
    let dy20 = sf32_sub(source_y_bits.z, source_y_bits.x);
    let delta20 = sf32_sub(attribute_bits.z, attribute_bits.x);
    let delta10 = sf32_sub(attribute_bits.y, attribute_bits.x);
    let a_left = sf32_mul(delta20, dy10);
    let a_right = sf32_mul(delta10, dy20);
    let a = sf32_sub(a_left, a_right);
    let b_left = sf32_mul(dx20, delta10);
    let b_right = sf32_mul(dx10, delta20);
    let b = sf32_sub(b_left, b_right);
    let c_left = sf32_mul(dx20, dy10);
    let c_right = sf32_mul(dx10, dy20);
    let c = sf32_sub(c_left, c_right);
    let dfdx = sf32_div(a, c);
    let dfdy = sf32_div(b, c);
    let sample_dx = sf32_sub(sample_x_bits, source_x_bits.x);
    let sample_dy = sf32_sub(sample_y_bits, source_y_bits.x);
    let x_term = sf32_mul(dfdx, sample_dx);
    let y_term = sf32_mul(dfdy, sample_dy);
    let x_value = sf32_add(attribute_bits.x, x_term);
    return sf32_add(x_value, y_term);
}

fn gx_managed_raster_color_bytes_at_sample(
    source_x_bits: vec3<u32>,
    source_y_bits: vec3<u32>,
    packed_endpoints: vec3<u32>,
    sample_x_bits: u32,
    sample_y_bits: u32,
) -> vec4<i32> {
    let endpoint0 = gx_managed_unpack_rgba8(packed_endpoints.x);
    let endpoint1 = gx_managed_unpack_rgba8(packed_endpoints.y);
    let endpoint2 = gx_managed_unpack_rgba8(packed_endpoints.z);
    let bytes = vec4<i32>(
        i32(sf32_to_gx_u8(gx_managed_soft_attribute_at_sample(
            source_x_bits, source_y_bits,
            vec3<u32>(
                sf32_from_u32(endpoint0.r),
                sf32_from_u32(endpoint1.r),
                sf32_from_u32(endpoint2.r),
            ),
            sample_x_bits, sample_y_bits,
        ))),
        i32(sf32_to_gx_u8(gx_managed_soft_attribute_at_sample(
            source_x_bits, source_y_bits,
            vec3<u32>(
                sf32_from_u32(endpoint0.g),
                sf32_from_u32(endpoint1.g),
                sf32_from_u32(endpoint2.g),
            ),
            sample_x_bits, sample_y_bits,
        ))),
        i32(sf32_to_gx_u8(gx_managed_soft_attribute_at_sample(
            source_x_bits, source_y_bits,
            vec3<u32>(
                sf32_from_u32(endpoint0.b),
                sf32_from_u32(endpoint1.b),
                sf32_from_u32(endpoint2.b),
            ),
            sample_x_bits, sample_y_bits,
        ))),
        i32(sf32_to_gx_u8(gx_managed_soft_attribute_at_sample(
            source_x_bits, source_y_bits,
            vec3<u32>(
                sf32_from_u32(endpoint0.a),
                sf32_from_u32(endpoint1.a),
                sf32_from_u32(endpoint2.a),
            ),
            sample_x_bits, sample_y_bits,
        ))),
    );
    return bytes;
}

fn gx_managed_raster_colors(input: ManagedCoverageVertexOutput) -> array<vec4<i32>, 8> {
    let pixel_x = u32(floor(input.position.x));
    let pixel_y = u32(floor(input.position.y));
    let sample_x_bits = sf32_div(sf32_from_u32(pixel_x * 12u + 7u), 0x41400000u);
    let sample_y_bits = sf32_div(sf32_from_u32(pixel_y * 12u + 7u), 0x41400000u);
    return array<vec4<i32>, 8>(
        gx_managed_raster_color_bytes_at_sample(
            input.source_x_bits, input.source_y_bits, input.raster0_endpoints.xyz,
            sample_x_bits, sample_y_bits,
        ),
        gx_managed_raster_color_bytes_at_sample(
            input.source_x_bits, input.source_y_bits, input.raster1_endpoints,
            sample_x_bits, sample_y_bits,
        ),
        vec4<i32>(0), vec4<i32>(0), vec4<i32>(0),
        vec4<i32>(0), vec4<i32>(0), vec4<i32>(0),
    );
}

fn gx_managed_reconstructed_stq(
    source_x: vec3<f32>,
    source_y: vec3<f32>,
    inv_w_endpoints: vec3<f32>,
    s_over_w_endpoints: vec3<f32>,
    t_over_w_endpoints: vec3<f32>,
    q_over_w_endpoints: vec3<f32>,
    sample_x: f32,
    sample_y: f32,
) -> vec3<f32> {
    let inv_w = gx_managed_attribute_at_sample(
        source_x, source_y, inv_w_endpoints, sample_x, sample_y,
    );
    let s_over_w = gx_managed_attribute_at_sample(
        source_x, source_y, s_over_w_endpoints, sample_x, sample_y,
    );
    let t_over_w = gx_managed_attribute_at_sample(
        source_x, source_y, t_over_w_endpoints, sample_x, sample_y,
    );
    let q_over_w = gx_managed_attribute_at_sample(
        source_x, source_y, q_over_w_endpoints, sample_x, sample_y,
    );
    // Match Dolphin's software rasterizer operation-for-operation: recover W,
    // recover Q with that once-rounded W, divide W by Q, and only then project
    // S/W and T/W. The algebraically equivalent (S/W)/(Q/W) changes f32 bits.
    let w = 1.0 / inv_w;
    let q = q_over_w * w;
    var projection = w;
    if q != 0.0 {
        projection = w / q;
    }
    return vec3<f32>(
        s_over_w * projection,
        t_over_w * projection,
        1.0,
    );
}

fn managed_coverage_tev_input(input: ManagedCoverageVertexOutput) -> TevVertexOutput {
    let sample_x_numerator = floor(input.position.x) * 12.0 + 7.0;
    let sample_y_numerator = floor(input.position.y) * 12.0 + 7.0;
    let sample_x = sample_x_numerator / 12.0;
    let sample_y = sample_y_numerator / 12.0;
    let source_x = bitcast<vec3<f32>>(input.source_x_bits);
    let source_y = bitcast<vec3<f32>>(input.source_y_bits);
    let reconstructed_stq = gx_managed_reconstructed_stq(
        source_x, source_y,
        input.stq2, input.stq3, input.stq4, input.stq5,
        sample_x, sample_y,
    );

    var output: TevVertexOutput;
    output.position = input.position;
    // Managed raster colors bypass normalized-f32 TEV conversion. Their exact
    // software-f32 byte vectors are passed separately to tev_fragment_values.
    output.raster0 = vec4<f32>(0.0);
    output.raster1 = vec4<f32>(0.0);
    output.stq0 = reconstructed_stq;
    output.stq1 = reconstructed_stq;
    output.stq2 = reconstructed_stq;
    output.stq3 = reconstructed_stq;
    output.stq4 = reconstructed_stq;
    output.stq5 = reconstructed_stq;
    output.stq6 = reconstructed_stq;
    output.stq7 = reconstructed_stq;
    output.depth24 = gx_managed_attribute_at_sample(
        source_x, source_y, input.source_depth24, sample_x, sample_y,
    );
    return output;
}

fn gx_managed_tex_coord_sidecar_word(record: u32, word: u32) -> u32 {
    let packed = managed_tex_coord_sidecar[record * 19u + word / 4u];
    return packed[word & 3u];
}

fn gx_managed_sidecar_stq(
    input: ManagedCoverageVertexOutput,
    texture_coord: u32,
) -> vec3<f32> {
    let record = input.raster0_endpoints.w;
    let source_x = bitcast<vec3<f32>>(input.source_x_bits);
    let source_y = bitcast<vec3<f32>>(input.source_y_bits);
    let inv_w = vec3<f32>(
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, 0u)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, 1u)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, 2u)),
    );
    let base = 3u + texture_coord * 9u;
    let s_over_w = vec3<f32>(
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 1u)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 2u)),
    );
    let t_over_w = vec3<f32>(
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 3u)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 4u)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 5u)),
    );
    let q_over_w = vec3<f32>(
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 6u)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 7u)),
        bitcast<f32>(gx_managed_tex_coord_sidecar_word(record, base + 8u)),
    );
    let sample_x = (floor(input.position.x) * 12.0 + 7.0) / 12.0;
    let sample_y = (floor(input.position.y) * 12.0 + 7.0) / 12.0;
    return gx_managed_reconstructed_stq(
        source_x, source_y, inv_w, s_over_w, t_over_w, q_over_w,
        sample_x, sample_y,
    );
}

fn gx_managed_required_tex_coord_mask() -> u32 {
    // The CPU dataflow pass includes indirect IREF coordinates, direct-stage
    // GEN_MODE fallbacks, and texture-disabled stages that still update the
    // persistent indirect coordinate. Re-scanning only enabled direct stages
    // here would omit all three cases.
    return indirect_tev_state.matrix_rows[1].w & 0xffu;
}

fn managed_multi_coord_tev_input(
    input: ManagedCoverageVertexOutput,
) -> TevVertexOutput {
    let required_coord_mask = gx_managed_required_tex_coord_mask();
    var output: TevVertexOutput;
    output.position = input.position;
    output.raster0 = vec4<f32>(0.0);
    output.raster1 = vec4<f32>(0.0);
    output.stq0 = vec3<f32>(0.0);
    output.stq1 = vec3<f32>(0.0);
    output.stq2 = vec3<f32>(0.0);
    output.stq3 = vec3<f32>(0.0);
    output.stq4 = vec3<f32>(0.0);
    output.stq5 = vec3<f32>(0.0);
    output.stq6 = vec3<f32>(0.0);
    output.stq7 = vec3<f32>(0.0);
    if (required_coord_mask & (1u << 0u)) != 0u {
        output.stq0 = gx_managed_sidecar_stq(input, 0u);
    }
    if (required_coord_mask & (1u << 1u)) != 0u {
        output.stq1 = gx_managed_sidecar_stq(input, 1u);
    }
    if (required_coord_mask & (1u << 2u)) != 0u {
        output.stq2 = gx_managed_sidecar_stq(input, 2u);
    }
    if (required_coord_mask & (1u << 3u)) != 0u {
        output.stq3 = gx_managed_sidecar_stq(input, 3u);
    }
    if (required_coord_mask & (1u << 4u)) != 0u {
        output.stq4 = gx_managed_sidecar_stq(input, 4u);
    }
    if (required_coord_mask & (1u << 5u)) != 0u {
        output.stq5 = gx_managed_sidecar_stq(input, 5u);
    }
    if (required_coord_mask & (1u << 6u)) != 0u {
        output.stq6 = gx_managed_sidecar_stq(input, 6u);
    }
    if (required_coord_mask & (1u << 7u)) != 0u {
        output.stq7 = gx_managed_sidecar_stq(input, 7u);
    }
    let sample_x = (floor(input.position.x) * 12.0 + 7.0) / 12.0;
    let sample_y = (floor(input.position.y) * 12.0 + 7.0) / 12.0;
    output.depth24 = gx_managed_attribute_at_sample(
        bitcast<vec3<f32>>(input.source_x_bits),
        bitcast<vec3<f32>>(input.source_y_bits),
        input.source_depth24,
        sample_x,
        sample_y,
    );
    return output;
}

fn gx_managed_attribute_at_sample(
    source_x: vec3<f32>,
    source_y: vec3<f32>,
    attributes: vec3<f32>,
    sample_x: f32,
    sample_y: f32,
) -> f32 {
    let dx10 = source_x.y - source_x.x;
    let dx20 = source_x.z - source_x.x;
    let dy10 = source_y.y - source_y.x;
    let dy20 = source_y.z - source_y.x;
    let delta20 = attributes.z - attributes.x;
    let delta10 = attributes.y - attributes.x;
    let a_left = delta20 * dy10;
    let a_right = delta10 * dy20;
    let a = a_left - a_right;
    let b_left = dx20 * delta10;
    let b_right = dx10 * delta20;
    let b = b_left - b_right;
    let c_left = dx20 * dy10;
    let c_right = dx10 * dy20;
    let c = c_left - c_right;
    let dfdx = a / c;
    let dfdy = b / c;
    let sample_dx = sample_x - source_x.x;
    let sample_dy = sample_y - source_y.x;
    let x_term = dfdx * sample_dx;
    let y_term = dfdy * sample_dy;
    let x_value = attributes.x + x_term;
    return x_value + y_term;
}

fn gx_managed_edge_covers(
    a: vec2<i32>,
    b: vec2<i32>,
    sample_x_48: i32,
    sample_y_48: i32,
) -> bool {
    // Match the CPU 28.4 model exactly. A GX 7/12 sample is 28/3 in
    // 28.4 units, so E3 multiplies the complete edge equation by three.
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    let constant = dy * a.x - dx * a.y;
    let edge_3 = 3 * constant + dx * sample_y_48 - dy * sample_x_48;
    let inclusive = dy < 0 || (dy == 0 && dx > 0);
    return edge_3 > 0 || (inclusive && edge_3 == 0);
}

fn gx_managed_coverage_passes(input: ManagedCoverageVertexOutput) -> bool {
    let pixel_x = i32(floor(input.position.x));
    let pixel_y = i32(floor(input.position.y));
    let sample_x_48 = pixel_x * 48 + 28;
    let sample_y_48 = pixel_y * 48 + 28;
    let packed0 = u32(input.packed_xy28_4.x);
    let packed1 = u32(input.packed_xy28_4.y);
    let packed2 = u32(input.packed_xy28_4.z);
    let point0 = vec2<i32>(i32(packed0 & 0xffffu), i32(packed0 >> 16u));
    let point1 = vec2<i32>(i32(packed1 & 0xffffu), i32(packed1 >> 16u));
    let point2 = vec2<i32>(i32(packed2 & 0xffffu), i32(packed2 >> 16u));
    return gx_managed_edge_covers(point0, point1, sample_x_48, sample_y_48)
        && gx_managed_edge_covers(point1, point2, sample_x_48, sample_y_48)
        && gx_managed_edge_covers(point2, point0, sample_x_48, sample_y_48);
}

// Browser WebGPU cannot force early fragment tests. Early GX depth commits use
// binding-free fragment entries in a paired pipeline. They emit the same
// canonical attachment depth as the color attempt, while an empty color write
// mask preserves the EFB color.
fn gx_early_depth_commit(
    input: TevVertexOutput,
    encoding: u32,
) -> CanonicalDepthOutput {
    var output: CanonicalDepthOutput;
    output.depth =
        gx_efb_depth_to_attachment(gx_raster_depth24(input.depth24), encoding);
    return output;
}

@fragment
fn fs_early_depth_commit_z24(input: TevVertexOutput) -> CanonicalDepthOutput {
    return gx_early_depth_commit(input, 0u);
}

@fragment
fn fs_early_depth_commit_z16_linear(input: TevVertexOutput) -> CanonicalDepthOutput {
    return gx_early_depth_commit(input, 1u);
}

@fragment
fn fs_early_depth_commit_z16_near(input: TevVertexOutput) -> CanonicalDepthOutput {
    return gx_early_depth_commit(input, 2u);
}

@fragment
fn fs_early_depth_commit_z16_mid(input: TevVertexOutput) -> CanonicalDepthOutput {
    return gx_early_depth_commit(input, 3u);
}

@fragment
fn fs_early_depth_commit_z16_far(input: TevVertexOutput) -> CanonicalDepthOutput {
    return gx_early_depth_commit(input, 4u);
}

fn alpha_compare(value: u32, reference: u32, operation: u32) -> bool {
    if operation == 0u { return false; }
    if operation == 1u { return value < reference; }
    if operation == 2u { return value == reference; }
    if operation == 3u { return value <= reference; }
    if operation == 4u { return value > reference; }
    if operation == 5u { return value != reference; }
    if operation == 6u { return value >= reference; }
    return true;
}

fn alpha_test_passes(value: u32, test: u32) -> bool {
    let first = alpha_compare(value, test & 0xffu, (test >> 16u) & 7u);
    let second = alpha_compare(value, (test >> 8u) & 0xffu, (test >> 19u) & 7u);
    let logic = (test >> 22u) & 3u;
    if logic == 0u { return first && second; }
    if logic == 1u { return first || second; }
    if logic == 2u { return first != second; }
    return first == second;
}
";

pub(crate) const TEV_WGSL: &str = "
const TEV_MAX_STAGES: u32 = 16u;
const TEV_INDIRECT_MAX_STAGES: u32 = 4u;
const TEV_INDIRECT_COMMAND_MASK: u32 = 0x001fffffu;
const TEV_KONST_FRACTIONS = array<i32, 8>(255, 223, 191, 159, 128, 96, 64, 32);

struct TevStageState {
    color_combiner: u32,
    alpha_combiner: u32,
    refs: u32,
    konst_selectors: u32,
};

struct TevDrawState {
    stages: array<TevStageState, 16>,
    color_registers: array<vec4<i32>, 4>,
    konst_registers: array<vec4<i32>, 4>,
    swap_tables: array<vec4<u32>, 4>,
    stage_count_and_padding: vec4<u32>,
};

struct IndirectTevDrawState {
    control: vec4<u32>,
    matrix_rows: array<vec4<u32>, 3>,
    commands: array<vec4<u32>, 4>,
};

@group(1) @binding(0) var<uniform> tev_state: TevDrawState;
@group(1) @binding(1) var tev_texture0: texture_2d<f32>;
@group(1) @binding(2) var tev_texture1: texture_2d<f32>;
@group(1) @binding(3) var tev_texture2: texture_2d<f32>;
@group(1) @binding(4) var tev_texture3: texture_2d<f32>;
@group(1) @binding(5) var tev_texture4: texture_2d<f32>;
@group(1) @binding(6) var tev_texture5: texture_2d<f32>;
@group(1) @binding(7) var tev_texture6: texture_2d<f32>;
@group(1) @binding(8) var tev_texture7: texture_2d<f32>;
@group(1) @binding(9) var tev_sampler0: sampler;
@group(1) @binding(10) var tev_sampler1: sampler;
@group(1) @binding(11) var tev_sampler2: sampler;
@group(1) @binding(12) var tev_sampler3: sampler;
@group(1) @binding(13) var tev_sampler4: sampler;
@group(1) @binding(14) var tev_sampler5: sampler;
@group(1) @binding(15) var tev_sampler6: sampler;
@group(1) @binding(16) var tev_sampler7: sampler;
@group(1) @binding(17) var<uniform> indirect_tev_state: IndirectTevDrawState;

fn tev_register_index(encoded: u32) -> u32 {
    if (encoded & 3u) == 0u { return 3u; }
    return (encoded & 3u) - 1u;
}

fn tev_to_bytes(value: vec4<f32>) -> vec4<i32> {
    return vec4<i32>(round(clamp(value, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0));
}

fn gx_native_normalized_uv(texture: texture_2d<f32>, texel_uv: vec2<f32>) -> vec2<f32> {
    return texel_uv / vec2<f32>(textureDimensions(texture, 0));
}

fn gx_projective_uv(stq: vec3<f32>) -> vec2<f32> {
    // GX keeps ST unchanged when Q is zero rather than producing infinities.
    if stq.z == 0.0 {
        return stq.xy;
    }
    return stq.xy / stq.z;
}

fn gx_sampler_mode0(map: u32) -> u32 {
    switch map & 7u {
        case 0u: { return draw_state.sampler_mode0_lo.x; }
        case 1u: { return draw_state.sampler_mode0_lo.y; }
        case 2u: { return draw_state.sampler_mode0_lo.z; }
        case 3u: { return draw_state.sampler_mode0_lo.w; }
        case 4u: { return draw_state.sampler_mode0_hi.x; }
        case 5u: { return draw_state.sampler_mode0_hi.y; }
        case 6u: { return draw_state.sampler_mode0_hi.z; }
        default: { return draw_state.sampler_mode0_hi.w; }
    }
}

fn gx_sampler_mode1(map: u32) -> u32 {
    switch map & 7u {
        case 0u: { return draw_state.sampler_mode1_lo.x; }
        case 1u: { return draw_state.sampler_mode1_lo.y; }
        case 2u: { return draw_state.sampler_mode1_lo.z; }
        case 3u: { return draw_state.sampler_mode1_lo.w; }
        case 4u: { return draw_state.sampler_mode1_hi.x; }
        case 5u: { return draw_state.sampler_mode1_hi.y; }
        case 6u: { return draw_state.sampler_mode1_hi.z; }
        default: { return draw_state.sampler_mode1_hi.w; }
    }
}

fn gx_managed_wrap_coord(coord: i32, wrap_mode: u32, image_size: i32) -> i32 {
    let mask = image_size - 1;
    switch wrap_mode & 3u {
        case 1u: {
            return coord & mask;
        }
        case 2u: {
            var mirrored = coord;
            if (mirrored & image_size) != 0 {
                mirrored = ~mirrored;
            }
            return mirrored & mask;
        }
        default: {
            // GX's reserved wrap value three follows the clamp path.
            return clamp(coord, 0, mask);
        }
    }
}

fn gx_managed_texture_load_bytes(
    texture: texture_2d<f32>,
    coord: vec2<i32>,
    mip_level: u32,
) -> vec4<u32> {
    return vec4<u32>(tev_to_bytes(textureLoad(texture, coord, i32(mip_level))));
}

fn gx_manual_sample_level(
    texture: texture_2d<f32>,
    mode0: u32,
    s17_7: vec2<i32>,
    mip_level: u32,
    linear: bool,
) -> vec4<u32> {
    let image_size = vec2<i32>(textureDimensions(texture, mip_level));
    let wrap_s = mode0 & 3u;
    let wrap_t = (mode0 >> 2u) & 3u;
    let level_s = s17_7.x >> mip_level;
    let level_t = s17_7.y >> mip_level;

    if !linear {
        let image_s = gx_managed_wrap_coord(level_s >> 7u, wrap_s, image_size.x);
        let image_t = gx_managed_wrap_coord(level_t >> 7u, wrap_t, image_size.y);
        return gx_managed_texture_load_bytes(
            texture, vec2<i32>(image_s, image_t), mip_level,
        );
    }

    // GX centers its 7-bit bilinear kernel half a texel before choosing the
    // integer base coordinates and weights.
    let s = level_s - 64;
    let t = level_t - 64;
    let image_s0 = s >> 7;
    let image_t0 = t >> 7;
    let image_s1 = image_s0 + 1;
    let image_t1 = image_t0 + 1;
    let fract_s = u32(s & 0x7f);
    let fract_t = u32(t & 0x7f);
    let inverse_s = 128u - fract_s;
    let inverse_t = 128u - fract_t;
    let weight00 = inverse_s * inverse_t;
    let weight10 = fract_s * inverse_t;
    let weight01 = inverse_s * fract_t;
    let weight11 = fract_s * fract_t;

    let s0 = gx_managed_wrap_coord(image_s0, wrap_s, image_size.x);
    let s1 = gx_managed_wrap_coord(image_s1, wrap_s, image_size.x);
    let t0 = gx_managed_wrap_coord(image_t0, wrap_t, image_size.y);
    let t1 = gx_managed_wrap_coord(image_t1, wrap_t, image_size.y);
    let texel00 =
        gx_managed_texture_load_bytes(texture, vec2<i32>(s0, t0), mip_level);
    let texel10 =
        gx_managed_texture_load_bytes(texture, vec2<i32>(s1, t0), mip_level);
    let texel01 =
        gx_managed_texture_load_bytes(texture, vec2<i32>(s0, t1), mip_level);
    let texel11 =
        gx_managed_texture_load_bytes(texture, vec2<i32>(s1, t1), mip_level);
    let filtered =
        texel00 * vec4<u32>(weight00) +
        texel10 * vec4<u32>(weight10) +
        texel01 * vec4<u32>(weight01) +
        texel11 * vec4<u32>(weight11);
    return filtered >> vec4<u32>(14u);
}

fn gx_manual_sample_texture(
    texture: texture_2d<f32>,
    mode0: u32,
    mode1: u32,
    uv: vec2<f32>,
) -> vec4<i32> {
    // This is the explicit Dolphin-compatible reference model, not a claim
    // that WebGPU's implementation-dependent implicit LOD matches GX.
    let s17_7 = vec2<i32>(uv * 128.0);
    let mip_mode = (mode0 >> 5u) & 3u;
    let full_lod_state = (mode0 & 0x80000000u) != 0u;
    if !full_lod_state && mip_mode == 0u {
        let linear = (mode0 & (1u << 4u)) != 0u;
        return vec4<i32>(gx_manual_sample_level(texture, mode0, s17_7, 0u, linear));
    }

    // Quantize before taking coarse derivatives, matching Dolphin's manual
    // sampler. Edge LOD uses the componentwise maximum; diagonal LOD sums the
    // two edge derivatives. The resulting LOD is fixed at 1/16 precision.
    let uv_delta_x = abs(dpdxCoarse(vec2<f32>(s17_7)));
    let uv_delta_y = abs(dpdyCoarse(vec2<f32>(s17_7)));
    var uv_delta = max(uv_delta_x, uv_delta_y);
    if (mode0 & (1u << 8u)) != 0u {
        uv_delta = uv_delta_x + uv_delta_y;
    }
    let rho = max(uv_delta.x, uv_delta.y) / 128.0;
    let max_lod = i32((mode1 >> 8u) & 0xffu);
    let min_lod = min(i32(mode1 & 0xffu), max_lod);
    let raw_bias = i32((mode0 >> 9u) & 0xffu);
    let signed_bias = select(raw_bias, raw_bias - 256, raw_bias >= 128);
    let bias_sixteenths = select(0, signed_bias >> 1u, mip_mode != 0u);
    var lod = min_lod;
    if rho != 0.0 {
        lod = i32(floor(log2(rho) * 16.0)) + bias_sixteenths;
    }
    // GX chooses the magnification/minification texel filter before applying
    // MODE1's LOD clamps.
    let linear = select(
        (mode0 & (1u << 4u)) != 0u,
        (mode0 & (1u << 7u)) != 0u,
        lod > 0,
    );
    if mip_mode == 0u {
        return vec4<i32>(gx_manual_sample_level(texture, mode0, s17_7, 0u, linear));
    }
    lod = clamp(lod, min_lod, max_lod);
    var base_lod = u32(lod >> 4u);
    let fractional_lod = u32(lod & 15);
    if mip_mode == 1u && fractional_lod >= 8u {
        base_lod += 1u;
    }

    var result = gx_manual_sample_level(texture, mode0, s17_7, base_lod, linear);
    if mip_mode == 2u && fractional_lod != 0u {
        let next =
            gx_manual_sample_level(texture, mode0, s17_7, base_lod + 1u, linear);
        result =
            (result * vec4<u32>(16u - fractional_lod) +
             next * vec4<u32>(fractional_lod)) >> vec4<u32>(4u);
    }
    return vec4<i32>(result);
}

fn gx_manual_sample_texture_with_lod(
    texture: texture_2d<f32>,
    mode0: u32,
    mode1: u32,
    sample_uv: vec2<f32>,
    lod_uv: vec2<f32>,
) -> vec4<i32> {
    let sample_s17_7 = vec2<i32>(sample_uv * 128.0);
    let lod_s17_7 = vec2<i32>(lod_uv * 128.0);
    let mip_mode = (mode0 >> 5u) & 3u;
    let full_lod_state = (mode0 & 0x80000000u) != 0u;
    if !full_lod_state && mip_mode == 0u {
        let linear = (mode0 & (1u << 4u)) != 0u;
        return vec4<i32>(
            gx_manual_sample_level(texture, mode0, sample_s17_7, 0u, linear)
        );
    }

    // UTCLOD selects the unmodified base coordinate only for derivative
    // calculation. Texture addressing always uses the post-indirect result.
    let uv_delta_x = abs(dpdxCoarse(vec2<f32>(lod_s17_7)));
    let uv_delta_y = abs(dpdyCoarse(vec2<f32>(lod_s17_7)));
    var uv_delta = max(uv_delta_x, uv_delta_y);
    if (mode0 & (1u << 8u)) != 0u {
        uv_delta = uv_delta_x + uv_delta_y;
    }
    let rho = max(uv_delta.x, uv_delta.y) / 128.0;
    let max_lod = i32((mode1 >> 8u) & 0xffu);
    let min_lod = min(i32(mode1 & 0xffu), max_lod);
    let raw_bias = i32((mode0 >> 9u) & 0xffu);
    let signed_bias = select(raw_bias, raw_bias - 256, raw_bias >= 128);
    let bias_sixteenths = select(0, signed_bias >> 1u, mip_mode != 0u);
    var lod = min_lod;
    if rho != 0.0 {
        lod = i32(floor(log2(rho) * 16.0)) + bias_sixteenths;
    }
    let linear = select(
        (mode0 & (1u << 4u)) != 0u,
        (mode0 & (1u << 7u)) != 0u,
        lod > 0,
    );
    if mip_mode == 0u {
        return vec4<i32>(
            gx_manual_sample_level(texture, mode0, sample_s17_7, 0u, linear)
        );
    }
    lod = clamp(lod, min_lod, max_lod);
    var base_lod = u32(lod >> 4u);
    let fractional_lod = u32(lod & 15);
    if mip_mode == 1u && fractional_lod >= 8u {
        base_lod += 1u;
    }

    var result =
        gx_manual_sample_level(texture, mode0, sample_s17_7, base_lod, linear);
    if mip_mode == 2u && fractional_lod != 0u {
        let next = gx_manual_sample_level(
            texture, mode0, sample_s17_7, base_lod + 1u, linear,
        );
        result =
            (result * vec4<u32>(16u - fractional_lod) +
             next * vec4<u32>(fractional_lod)) >> vec4<u32>(4u);
    }
    return vec4<i32>(result);
}

fn gx_native_sample_texture(
    texture: texture_2d<f32>,
    texture_sampler: sampler,
    mode0: u32,
    mode1: u32,
    uv: vec2<f32>,
) -> vec4<i32> {
    if (mode0 & 0x80000000u) != 0u {
        return gx_manual_sample_texture(texture, mode0, mode1, uv);
    }
    let raw_bias = i32((mode0 >> 9u) & 0xffu);
    let signed_bias = select(raw_bias, raw_bias - 256, raw_bias >= 128);
    return tev_to_bytes(textureSampleBias(
        texture, texture_sampler, gx_native_normalized_uv(texture, uv),
        f32(signed_bias) / 32.0,
    ));
}

fn gx_native_sample_texture_with_lod(
    texture: texture_2d<f32>,
    texture_sampler: sampler,
    mode0: u32,
    mode1: u32,
    sample_uv: vec2<f32>,
    lod_uv: vec2<f32>,
) -> vec4<i32> {
    if (mode0 & 0x80000000u) != 0u {
        return gx_manual_sample_texture_with_lod(
            texture, mode0, mode1, sample_uv, lod_uv,
        );
    }
    let dimensions = vec2<f32>(textureDimensions(texture, 0));
    let normalized_sample = sample_uv / dimensions;
    let normalized_lod = lod_uv / dimensions;
    let raw_bias = i32((mode0 >> 9u) & 0xffu);
    let signed_bias = select(raw_bias, raw_bias - 256, raw_bias >= 128);
    let lod_scale = exp2(f32(signed_bias) / 32.0);
    return tev_to_bytes(textureSampleGrad(
        texture, texture_sampler, normalized_sample,
        dpdxCoarse(normalized_lod) * lod_scale,
        dpdyCoarse(normalized_lod) * lod_scale,
    ));
}

fn tev_sample_texture_native(map: u32, stq: vec3<f32>) -> vec4<i32> {
    // Q remains part of the interpolant until the fragment stage.
    let uv = gx_projective_uv(stq);
    let mode0 = gx_sampler_mode0(map);
    let mode1 = gx_sampler_mode1(map);
    switch map & 7u {
        case 0u: {
            return gx_native_sample_texture(
                tev_texture0, tev_sampler0, mode0, mode1, uv,
            );
        }
        case 1u: {
            return gx_native_sample_texture(
                tev_texture1, tev_sampler1, mode0, mode1, uv,
            );
        }
        case 2u: {
            return gx_native_sample_texture(
                tev_texture2, tev_sampler2, mode0, mode1, uv,
            );
        }
        case 3u: {
            return gx_native_sample_texture(
                tev_texture3, tev_sampler3, mode0, mode1, uv,
            );
        }
        case 4u: {
            return gx_native_sample_texture(
                tev_texture4, tev_sampler4, mode0, mode1, uv,
            );
        }
        case 5u: {
            return gx_native_sample_texture(
                tev_texture5, tev_sampler5, mode0, mode1, uv,
            );
        }
        case 6u: {
            return gx_native_sample_texture(
                tev_texture6, tev_sampler6, mode0, mode1, uv,
            );
        }
        default: {
            return gx_native_sample_texture(
                tev_texture7, tev_sampler7, mode0, mode1, uv,
            );
        }
    }
}

fn gx_managed_sample_texture(
    texture: texture_2d<f32>,
    texture_sampler: sampler,
    mode0: u32,
    mode1: u32,
    uv: vec2<f32>,
) -> vec4<i32> {
    if ((mode0 >> 19u) & 3u) != 0u {
        return gx_native_sample_texture(texture, texture_sampler, mode0, mode1, uv);
    }
    return gx_manual_sample_texture(texture, mode0, mode1, uv);
}

fn tev_sample_texture_managed(map: u32, uv: vec2<f32>) -> vec4<i32> {
    let mode0 = gx_sampler_mode0(map);
    let mode1 = gx_sampler_mode1(map);
    switch map & 7u {
        case 0u: {
            return gx_managed_sample_texture(
                tev_texture0, tev_sampler0, mode0, mode1, uv,
            );
        }
        case 1u: {
            return gx_managed_sample_texture(
                tev_texture1, tev_sampler1, mode0, mode1, uv,
            );
        }
        case 2u: {
            return gx_managed_sample_texture(
                tev_texture2, tev_sampler2, mode0, mode1, uv,
            );
        }
        case 3u: {
            return gx_managed_sample_texture(
                tev_texture3, tev_sampler3, mode0, mode1, uv,
            );
        }
        case 4u: {
            return gx_managed_sample_texture(
                tev_texture4, tev_sampler4, mode0, mode1, uv,
            );
        }
        case 5u: {
            return gx_managed_sample_texture(
                tev_texture5, tev_sampler5, mode0, mode1, uv,
            );
        }
        case 6u: {
            return gx_managed_sample_texture(
                tev_texture6, tev_sampler6, mode0, mode1, uv,
            );
        }
        default: {
            return gx_managed_sample_texture(
                tev_texture7, tev_sampler7, mode0, mode1, uv,
            );
        }
    }
}

fn gx_sample_texture_coordinates(
    texture: texture_2d<f32>,
    texture_sampler: sampler,
    mode0: u32,
    mode1: u32,
    sample_uv: vec2<f32>,
    lod_uv: vec2<f32>,
    use_unmodified_lod: bool,
    managed_exact_sampler: bool,
) -> vec4<i32> {
    if managed_exact_sampler && ((mode0 >> 19u) & 3u) == 0u {
        return gx_manual_sample_texture_with_lod(
            texture, mode0, mode1, sample_uv, lod_uv,
        );
    }
    if use_unmodified_lod {
        return gx_native_sample_texture_with_lod(
            texture, texture_sampler, mode0, mode1, sample_uv, lod_uv,
        );
    }
    // Preserve the implicit native-WebGPU sampler for commands whose sample
    // and LOD coordinates are the same. In particular, presence=0 never
    // reaches this helper and keeps the original legacy call graph exactly.
    return gx_native_sample_texture(
        texture, texture_sampler, mode0, mode1, sample_uv,
    );
}

fn tev_sample_texture_coordinates(
    map: u32,
    sample_uv: vec2<f32>,
    lod_uv: vec2<f32>,
    use_unmodified_lod: bool,
    managed_exact_sampler: bool,
) -> vec4<i32> {
    let mode0 = gx_sampler_mode0(map);
    let mode1 = gx_sampler_mode1(map);
    switch map & 7u {
        case 0u: {
            return gx_sample_texture_coordinates(
                tev_texture0, tev_sampler0, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
        case 1u: {
            return gx_sample_texture_coordinates(
                tev_texture1, tev_sampler1, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
        case 2u: {
            return gx_sample_texture_coordinates(
                tev_texture2, tev_sampler2, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
        case 3u: {
            return gx_sample_texture_coordinates(
                tev_texture3, tev_sampler3, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
        case 4u: {
            return gx_sample_texture_coordinates(
                tev_texture4, tev_sampler4, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
        case 5u: {
            return gx_sample_texture_coordinates(
                tev_texture5, tev_sampler5, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
        case 6u: {
            return gx_sample_texture_coordinates(
                tev_texture6, tev_sampler6, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
        default: {
            return gx_sample_texture_coordinates(
                tev_texture7, tev_sampler7, mode0, mode1, sample_uv, lod_uv,
                use_unmodified_lod, managed_exact_sampler,
            );
        }
    }
}

fn gx_indirect_present() -> bool {
    return indirect_tev_state.matrix_rows[2].w != 0u;
}

fn gx_indirect_num_tex_gens() -> u32 {
    return indirect_tev_state.control.x & 0xfu;
}

fn gx_indirect_num_stages() -> u32 {
    return min((indirect_tev_state.control.x >> 16u) & 7u, TEV_INDIRECT_MAX_STAGES);
}

fn gx_indirect_command(stage: u32) -> u32 {
    return indirect_tev_state.commands[stage >> 2u][stage & 3u]
        & TEV_INDIRECT_COMMAND_MASK;
}

fn gx_indirect_effective_tex_coord(requested: u32) -> u32 {
    let num_tex_gens = gx_indirect_num_tex_gens();
    if num_tex_gens != 0u && requested < num_tex_gens {
        return requested;
    }
    return 0u;
}

fn gx_indirect_projected_s17_7(stq: vec3<f32>) -> vec2<i32> {
    return vec2<i32>(gx_projective_uv(stq) * 128.0);
}

fn gx_indirect_selected_coord(
    tex_coords: array<vec3<f32>, 8>,
    requested: u32,
) -> vec2<i32> {
    if gx_indirect_num_tex_gens() == 0u {
        return vec2<i32>(0);
    }
    return gx_indirect_projected_s17_7(
        tex_coords[gx_indirect_effective_tex_coord(requested)]
    );
}

fn gx_indirect_reference(stage: u32) -> vec2<u32> {
    let shift = stage * 6u;
    let iref = indirect_tev_state.control.y;
    return vec2<u32>((iref >> shift) & 7u, (iref >> (shift + 3u)) & 7u);
}

fn gx_indirect_scale(stage: u32) -> vec2<u32> {
    let word = select(
        indirect_tev_state.control.z,
        indirect_tev_state.control.w,
        stage >= 2u,
    );
    let shift = (stage & 1u) * 8u;
    return vec2<u32>((word >> shift) & 0xfu, (word >> (shift + 4u)) & 0xfu);
}

fn gx_indirect_sampled_stage_mask(stage_count: u32) -> u32 {
    let num_indirect_stages = gx_indirect_num_stages();
    var mask = 0u;
    for (var stage = 0u; stage < min(stage_count, TEV_MAX_STAGES); stage += 1u) {
        let command = gx_indirect_command(stage);
        let indirect_stage = command & 3u;
        let bump_alpha = (command >> 7u) & 3u;
        let encoded_matrix = (command >> 9u) & 3u;
        if indirect_stage < num_indirect_stages
            && (bump_alpha != 0u || encoded_matrix != 0u) {
            mask |= 1u << indirect_stage;
        }
    }
    return mask;
}

fn gx_indirect_prefetch_samples(
    tex_coords: array<vec3<f32>, 8>,
    stage_count: u32,
    managed_exact_sampler: bool,
) -> array<vec4<i32>, 4> {
    var samples = array<vec4<i32>, 4>(
        vec4<i32>(0), vec4<i32>(0), vec4<i32>(0), vec4<i32>(0),
    );
    if !gx_indirect_present() {
        return samples;
    }
    let sampled_mask = gx_indirect_sampled_stage_mask(stage_count);
    for (var indirect_stage = 0u;
         indirect_stage < TEV_INDIRECT_MAX_STAGES;
         indirect_stage += 1u) {
        if (sampled_mask & (1u << indirect_stage)) == 0u {
            continue;
        }
        let reference = gx_indirect_reference(indirect_stage);
        let scale = gx_indirect_scale(indirect_stage);
        let unscaled = gx_indirect_selected_coord(tex_coords, reference.y);
        let sample_s17_7 = vec2<i32>(
            unscaled.x >> scale.x,
            unscaled.y >> scale.y,
        );
        let sample_uv = vec2<f32>(sample_s17_7) / 128.0;
        samples[indirect_stage] = tev_sample_texture_coordinates(
            reference.x, sample_uv, sample_uv, false, managed_exact_sampler,
        );
    }
    return samples;
}

fn gx_indirect_sample_abg(sample: vec4<i32>) -> vec3<i32> {
    return vec3<i32>(sample.a, sample.b, sample.g);
}

fn gx_indirect_format_shift(format: u32) -> u32 {
    if format == 1u { return 3u; }
    if format == 2u { return 4u; }
    if format == 3u { return 5u; }
    return 0u;
}

fn gx_indirect_bump_shift(format: u32) -> u32 {
    if format == 1u { return 5u; }
    if format == 2u { return 4u; }
    if format == 3u { return 3u; }
    return 0u;
}

fn gx_indirect_formatted_sample(command: u32, sample_abg: vec3<i32>) -> vec3<i32> {
    let format = (command >> 2u) & 3u;
    let shift = gx_indirect_format_shift(format);
    let bias = select(1, -128, format == 0u);
    var formatted = vec3<i32>(
        sample_abg.x >> shift,
        sample_abg.y >> shift,
        sample_abg.z >> shift,
    );
    if (command & (1u << 4u)) != 0u { formatted.x += bias; }
    if (command & (1u << 5u)) != 0u { formatted.y += bias; }
    if (command & (1u << 6u)) != 0u { formatted.z += bias; }
    return formatted;
}

fn gx_indirect_bump_alpha(command: u32, sample_abg: vec3<i32>) -> i32 {
    let bump_alpha = (command >> 7u) & 3u;
    var component = sample_abg.z;
    if bump_alpha == 1u { component = sample_abg.x; }
    if bump_alpha == 2u { component = sample_abg.y; }
    let format = (command >> 2u) & 3u;
    return (component << gx_indirect_bump_shift(format)) & 0xf8;
}

fn gx_indirect_signed_11(value: u32) -> i32 {
    return i32(value << 21u) >> 21u;
}

fn gx_indirect_apply_exponent(value: i32, exponent: i32) -> i32 {
    if exponent >= 0 {
        return bitcast<i32>(bitcast<u32>(value) << u32(exponent));
    }
    return value >> u32(-exponent);
}

fn gx_indirect_dynamic_product(base: i32, component: i32) -> i32 {
    // Exact signed (i64(base) * i64(component)) >> 8 without shader-i64.
    // The formatted component is at most eight bits, so both terms fit i32.
    let high = base >> 8u;
    let low = base & 0xff;
    return high * component + ((low * component) >> 8u);
}

fn gx_indirect_matrix_transform(
    command: u32,
    sample_abg: vec3<i32>,
    base_coord: vec2<i32>,
) -> vec2<i32> {
    let encoded_matrix = (command >> 9u) & 3u;
    if encoded_matrix == 0u {
        return vec2<i32>(0);
    }
    let words = indirect_tev_state.matrix_rows[encoded_matrix - 1u].xyz;
    let exponent_bits =
        ((words.x >> 22u) & 3u) |
        (((words.y >> 22u) & 3u) << 2u) |
        (((words.z >> 22u) & 1u) << 4u);
    let exponent = i32(exponent_bits) - 17;
    let matrix_id = (command >> 11u) & 3u;
    let formatted = gx_indirect_formatted_sample(command, sample_abg);
    if matrix_id == 0u {
        let row0 = vec3<i32>(
            gx_indirect_signed_11(words.x),
            gx_indirect_signed_11(words.y),
            gx_indirect_signed_11(words.z),
        );
        let row1 = vec3<i32>(
            gx_indirect_signed_11(words.x >> 11u),
            gx_indirect_signed_11(words.y >> 11u),
            gx_indirect_signed_11(words.z >> 11u),
        );
        let dot0 = (
            row0.x * formatted.x + row0.y * formatted.y + row0.z * formatted.z
        ) >> 3u;
        let dot1 = (
            row1.x * formatted.x + row1.y * formatted.y + row1.z * formatted.z
        ) >> 3u;
        return vec2<i32>(
            gx_indirect_apply_exponent(dot0, exponent),
            gx_indirect_apply_exponent(dot1, exponent),
        );
    }
    if matrix_id == 1u || matrix_id == 2u {
        let component = select(formatted.x, formatted.y, matrix_id == 2u);
        return vec2<i32>(
            gx_indirect_apply_exponent(
                gx_indirect_dynamic_product(base_coord.x, component), exponent,
            ),
            gx_indirect_apply_exponent(
                gx_indirect_dynamic_product(base_coord.y, component), exponent,
            ),
        );
    }
    return vec2<i32>(0);
}

fn gx_indirect_wrap_coord(coord: i32, wrap: u32) -> i32 {
    if wrap == 0u { return coord; }
    if wrap >= 6u { return 0; }
    let texels = 512u >> wrap;
    return coord & i32((texels << 7u) - 1u);
}

fn gx_indirect_wrapping_add(left: i32, right: i32) -> i32 {
    return bitcast<i32>(bitcast<u32>(left) + bitcast<u32>(right));
}

fn gx_indirect_signed_24(value: i32) -> i32 {
    return i32(bitcast<u32>(value) << 8u) >> 8u;
}

fn tev_swizzle(color: vec4<i32>, table_index: u32) -> vec4<i32> {
    let table = tev_state.swap_tables[table_index & 3u];
    return vec4<i32>(
        color[table.x & 3u], color[table.y & 3u],
        color[table.z & 3u], color[table.w & 3u],
    );
}

fn tev_konst_color(selector: u32) -> vec3<i32> {
    if selector < 8u { return vec3<i32>(TEV_KONST_FRACTIONS[selector]); }
    if selector >= 12u && selector <= 15u {
        return clamp(
            tev_state.konst_registers[selector - 12u].rgb,
            vec3<i32>(0), vec3<i32>(255),
        );
    }
    if selector >= 16u {
        let register_id = (selector - 16u) & 3u;
        let channel = (selector - 16u) >> 2u;
        let value = clamp(tev_state.konst_registers[register_id][channel], 0, 255);
        return vec3<i32>(value);
    }
    return vec3<i32>(0);
}

fn tev_konst_alpha(selector: u32) -> i32 {
    if selector < 8u { return TEV_KONST_FRACTIONS[selector]; }
    if selector >= 16u {
        let register_id = (selector - 16u) & 3u;
        let channel = (selector - 16u) >> 2u;
        return clamp(tev_state.konst_registers[register_id][channel], 0, 255);
    }
    return 0;
}

fn tev_color_argument(
    argument: u32, channel: u32,
    registers: array<vec4<i32>, 4>, texture: vec4<i32>, raster: vec4<i32>,
    konst: vec3<i32>,
) -> i32 {
    let source = argument & 15u;
    if source <= 7u {
        let register_id = tev_register_index(source >> 1u);
        if (source & 1u) == 0u { return registers[register_id][channel]; }
        return registers[register_id].a;
    }
    if source == 8u { return texture[channel]; }
    if source == 9u { return texture.a; }
    if source == 10u { return raster[channel]; }
    if source == 11u { return raster.a; }
    if source == 12u { return 255; }
    if source == 13u { return 128; }
    if source == 14u { return konst[channel]; }
    return 0;
}

fn tev_color_input(
    argument: u32, registers: array<vec4<i32>, 4>,
    texture: vec4<i32>, raster: vec4<i32>, konst: vec3<i32>,
) -> vec3<i32> {
    return vec3<i32>(
        tev_color_argument(argument, 0u, registers, texture, raster, konst),
        tev_color_argument(argument, 1u, registers, texture, raster, konst),
        tev_color_argument(argument, 2u, registers, texture, raster, konst),
    );
}

fn tev_alpha_argument(
    argument: u32, registers: array<vec4<i32>, 4>,
    texture: vec4<i32>, raster: vec4<i32>, konst: i32,
) -> i32 {
    let source = argument & 7u;
    if source <= 3u { return registers[tev_register_index(source)].a; }
    if source == 4u { return texture.a; }
    if source == 5u { return raster.a; }
    if source == 6u { return konst; }
    return 0;
}

fn tev_clamp_result(value: i32, combiner: u32) -> i32 {
    if (combiner & (1u << 19u)) != 0u { return clamp(value, 0, 255); }
    return clamp(value, -1024, 1023);
}

fn tev_regular(a_raw: i32, b_raw: i32, c_raw: i32, d: i32, combiner: u32) -> i32 {
    let a = a_raw & 255;
    let b = b_raw & 255;
    var c = c_raw & 255;
    c += c >> 7u;
    var biased_d = d;
    let bias = (combiner >> 16u) & 3u;
    if bias == 1u { biased_d += 128; }
    if bias == 2u { biased_d -= 128; }
    let subtract = (combiner & (1u << 18u)) != 0u;
    let scale = (combiner >> 20u) & 3u;
    var mixed = (a << 8u) + (b - a) * c;
    if scale != 3u {
        mixed <<= scale;
        biased_d <<= scale;
        mixed += select(128, 127, subtract);
    }
    mixed >>= 8u;
    var result = select(biased_d + mixed, biased_d - mixed, subtract);
    if scale == 3u { result >>= 1u; }
    return tev_clamp_result(result, combiner);
}

fn tev_comparison(a: u32, b: u32, combiner: u32) -> bool {
    if (combiner & (1u << 18u)) != 0u { return a == b; }
    return a > b;
}

fn tev_packed_color(color: vec3<i32>, compare_target: u32) -> u32 {
    var value = u32(color.r & 255);
    if compare_target >= 1u { value |= u32(color.g & 255) << 8u; }
    if compare_target >= 2u { value |= u32(color.b & 255) << 16u; }
    return value;
}

fn tev_color_combiner(
    a: vec3<i32>, b: vec3<i32>, c: vec3<i32>, d: vec3<i32>, combiner: u32,
) -> vec3<i32> {
    if ((combiner >> 16u) & 3u) != 3u {
        return vec3<i32>(
            tev_regular(a.r, b.r, c.r, d.r, combiner),
            tev_regular(a.g, b.g, c.g, d.g, combiner),
            tev_regular(a.b, b.b, c.b, d.b, combiner),
        );
    }
    let compare_target = (combiner >> 20u) & 3u;
    if compare_target == 3u {
        return vec3<i32>(
            tev_clamp_result(d.r + select(0, c.r & 255, tev_comparison(u32(a.r & 255), u32(b.r & 255), combiner)), combiner),
            tev_clamp_result(d.g + select(0, c.g & 255, tev_comparison(u32(a.g & 255), u32(b.g & 255), combiner)), combiner),
            tev_clamp_result(d.b + select(0, c.b & 255, tev_comparison(u32(a.b & 255), u32(b.b & 255), combiner)), combiner),
        );
    }
    let selected = tev_comparison(tev_packed_color(a, compare_target), tev_packed_color(b, compare_target), combiner);
    return vec3<i32>(
        tev_clamp_result(d.r + select(0, c.r & 255, selected), combiner),
        tev_clamp_result(d.g + select(0, c.g & 255, selected), combiner),
        tev_clamp_result(d.b + select(0, c.b & 255, selected), combiner),
    );
}

fn tev_alpha_combiner(
    color_a: vec3<i32>, color_b: vec3<i32>,
    a: i32, b: i32, c: i32, d: i32, combiner: u32,
) -> i32 {
    if ((combiner >> 16u) & 3u) != 3u { return tev_regular(a, b, c, d, combiner); }
    let compare_target = (combiner >> 20u) & 3u;
    var compare_a = tev_packed_color(color_a, compare_target);
    var compare_b = tev_packed_color(color_b, compare_target);
    if compare_target == 3u {
        compare_a = u32(a & 255);
        compare_b = u32(b & 255);
    }
    let selected = tev_comparison(compare_a, compare_b, combiner);
    return tev_clamp_result(d + select(0, c & 255, selected), combiner);
}

struct TevEvaluation {
    source: vec4<f32>,
    raw_texture: vec4<u32>,
};

fn tev_evaluate(
    raster_colors: array<vec4<f32>, 8>,
    managed_raster_bytes: array<vec4<i32>, 8>,
    tex_coords: array<vec3<f32>, 8>,
    managed_exact_sampler: bool,
) -> TevEvaluation {
    var registers = tev_state.color_registers;
    var raw_texture = vec4<i32>(0);
    var last_color_destination = 3u;
    var last_alpha_destination = 3u;
    let stage_count = min(tev_state.stage_count_and_padding.x, TEV_MAX_STAGES);
    let indirect_present = gx_indirect_present();
    let num_indirect_stages = gx_indirect_num_stages();
    let indirect_samples = gx_indirect_prefetch_samples(
        tex_coords, stage_count, managed_exact_sampler,
    );
    var previous_coord = vec2<i32>(0);
    var alpha_bump = 0;
    var stage_index = 0u;
    loop {
        if stage_index >= stage_count { break; }
        let stage = tev_state.stages[stage_index];
        let texture_map = stage.refs & 7u;
        let tex_coord = (stage.refs >> 3u) & 7u;
        var sample_coord = vec2<i32>(0);
        var lod_coord = vec2<i32>(0);
        var use_unmodified_lod = false;
        if indirect_present {
            let base_coord = gx_indirect_selected_coord(tex_coords, tex_coord);
            let command = gx_indirect_command(stage_index);
            if command == 0u {
                // A semantic raw-zero command resets the persistent coordinate
                // even when this direct stage has texturing disabled.
                previous_coord = base_coord;
                sample_coord = base_coord;
                lod_coord = base_coord;
            } else {
                var transform = vec2<i32>(0);
                let indirect_stage = command & 3u;
                if indirect_stage < num_indirect_stages {
                    let sample_abg =
                        gx_indirect_sample_abg(indirect_samples[indirect_stage]);
                    if ((command >> 7u) & 3u) != 0u {
                        alpha_bump = gx_indirect_bump_alpha(command, sample_abg);
                    }
                    if ((command >> 9u) & 3u) != 0u {
                        transform = gx_indirect_matrix_transform(
                            command, sample_abg, base_coord,
                        );
                    }
                }
                let wrapped = vec2<i32>(
                    gx_indirect_wrap_coord(base_coord.x, (command >> 13u) & 7u),
                    gx_indirect_wrap_coord(base_coord.y, (command >> 16u) & 7u),
                );
                var next_coord = vec2<i32>(
                    gx_indirect_wrapping_add(wrapped.x, transform.x),
                    gx_indirect_wrapping_add(wrapped.y, transform.y),
                );
                if (command & (1u << 20u)) != 0u {
                    next_coord = vec2<i32>(
                        gx_indirect_wrapping_add(next_coord.x, previous_coord.x),
                        gx_indirect_wrapping_add(next_coord.y, previous_coord.y),
                    );
                }
                sample_coord = vec2<i32>(
                    gx_indirect_signed_24(next_coord.x),
                    gx_indirect_signed_24(next_coord.y),
                );
                previous_coord = sample_coord;
                use_unmodified_lod = (command & (1u << 19u)) != 0u;
                lod_coord = select(sample_coord, base_coord, use_unmodified_lod);
            }
        }
        let no_texture_generators =
            indirect_present && gx_indirect_num_tex_gens() == 0u;
        // With a transported zero NUMTEXGENS, GX exposes black texture input
        // to every stage, including stages whose direct texture-enable bit is
        // clear. raw_texture remains last-sample state and is updated below
        // only for texture-enabled stages.
        var texture_base = select(
            vec4<i32>(255), vec4<i32>(0), no_texture_generators,
        );
        if (stage.refs & (1u << 6u)) != 0u {
            if indirect_present {
                if !no_texture_generators {
                    texture_base = tev_sample_texture_coordinates(
                        texture_map,
                        vec2<f32>(sample_coord) / 128.0,
                        vec2<f32>(lod_coord) / 128.0,
                        use_unmodified_lod,
                        managed_exact_sampler,
                    );
                }
            } else {
                // This branch is intentionally the original direct-only path.
                // An absent tail must not change interpolation, implicit LOD,
                // or the managed sampler's operation order.
                if managed_exact_sampler {
                    texture_base =
                        tev_sample_texture_managed(texture_map, tex_coords[tex_coord].xy);
                } else {
                    texture_base =
                        tev_sample_texture_native(texture_map, tex_coords[tex_coord]);
                }
            }
            raw_texture = texture_base;
        }
        let texture = tev_swizzle(texture_base, (stage.alpha_combiner >> 2u) & 3u);
        let raster_channel = (stage.refs >> 7u) & 7u;
        var raster_base = vec4<i32>(0);
        if indirect_present && raster_channel == 5u {
            raster_base = vec4<i32>(alpha_bump);
        } else if indirect_present && raster_channel == 6u {
            raster_base = vec4<i32>(alpha_bump | (alpha_bump >> 5u));
        } else if raster_channel != 7u {
            if managed_exact_sampler {
                raster_base = managed_raster_bytes[raster_channel];
            } else {
                raster_base = tev_to_bytes(raster_colors[raster_channel]);
            }
        }
        let raster = tev_swizzle(raster_base, stage.alpha_combiner & 3u);
        let color_konst = tev_konst_color(stage.konst_selectors & 31u);
        let alpha_konst = tev_konst_alpha((stage.konst_selectors >> 5u) & 31u);

        let color_a = tev_color_input((stage.color_combiner >> 12u) & 15u, registers, texture, raster, color_konst);
        let color_b = tev_color_input((stage.color_combiner >> 8u) & 15u, registers, texture, raster, color_konst);
        let color_c = tev_color_input((stage.color_combiner >> 4u) & 15u, registers, texture, raster, color_konst);
        let color_d = tev_color_input(stage.color_combiner & 15u, registers, texture, raster, color_konst);
        let color_result = tev_color_combiner(color_a, color_b, color_c, color_d, stage.color_combiner);

        let alpha_a = tev_alpha_argument((stage.alpha_combiner >> 13u) & 7u, registers, texture, raster, alpha_konst);
        let alpha_b = tev_alpha_argument((stage.alpha_combiner >> 10u) & 7u, registers, texture, raster, alpha_konst);
        let alpha_c = tev_alpha_argument((stage.alpha_combiner >> 7u) & 7u, registers, texture, raster, alpha_konst);
        let alpha_d = tev_alpha_argument((stage.alpha_combiner >> 4u) & 7u, registers, texture, raster, alpha_konst);
        let alpha_result = tev_alpha_combiner(color_a, color_b, alpha_a, alpha_b, alpha_c, alpha_d, stage.alpha_combiner);

        let color_destination = tev_register_index((stage.color_combiner >> 22u) & 3u);
        let alpha_destination = tev_register_index((stage.alpha_combiner >> 22u) & 3u);
        registers[color_destination] = vec4<i32>(color_result, registers[color_destination].a);
        registers[alpha_destination] = vec4<i32>(registers[alpha_destination].rgb, alpha_result);
        last_color_destination = color_destination;
        last_alpha_destination = alpha_destination;
        stage_index += 1u;
    }
    let raw = vec4<i32>(registers[last_color_destination].rgb, registers[last_alpha_destination].a);
    var evaluation: TevEvaluation;
    evaluation.source =
        clamp(vec4<f32>(raw) / 255.0, vec4<f32>(0.0), vec4<f32>(1.0));
    evaluation.raw_texture = vec4<u32>(clamp(raw_texture, vec4<i32>(0), vec4<i32>(255)));
    return evaluation;
}
";

pub(crate) const TEV_FRAGMENT_WGSL: &str = "
struct TevFragmentOutput {
    @location(0) @blend_src(0) primary: vec4<f32>,
    @location(0) @blend_src(1) secondary: vec4<f32>,
};

struct TevFragmentDepthOutput {
    @location(0) @blend_src(0) primary: vec4<f32>,
    @location(0) @blend_src(1) secondary: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

struct TevFragmentValues {
    primary: vec4<f32>,
    secondary: vec4<f32>,
    buffer_depth: u32,
};

fn gx_z_texture_depth(reference_depth: u32, raw_texture: vec4<u32>) -> u32 {
    let format = (draw_state.z_texture >> 24u) & 3u;
    let operation = (draw_state.z_texture >> 26u) & 3u;
    if operation == 0u {
        return reference_depth;
    }
    var source = raw_texture.a;
    if format == 1u {
        source = (raw_texture.a << 8u) | raw_texture.r;
    } else if format == 2u {
        source = (raw_texture.r << 16u) | (raw_texture.g << 8u) | raw_texture.b;
    }
    let reference = select(0u, reference_depth, operation == 1u);
    return ((draw_state.z_texture & 0x00ffffffu) + source + reference) & 0x00ffffffu;
}

fn gx_fog_parameter(index: u32) -> u32 {
    if index < 4u {
        return draw_state.fog_parameters0[index];
    }
    return draw_state.fog_parameters1.x;
}

fn gx_fog_float(word: u32) -> f32 {
    let bits =
        ((word & 0x00080000u) << 12u) |
        (((word >> 11u) & 0xffu) << 23u) |
        ((word & 0x7ffu) << 12u);
    return bitcast<f32>(bits);
}

fn gx_fog_a_and_c() -> vec2<f32> {
    let a_word = gx_fog_parameter(0u);
    let c_word = gx_fog_parameter(3u);
    return vec2<f32>(gx_fog_float(a_word), gx_fog_float(c_word));
}

fn gx_fog_range_coefficient(index: u32) -> f32 {
    let word_index = index >> 1u;
    var word = draw_state.fog_range1.x;
    if word_index < 4u {
        word = draw_state.fog_range0[word_index];
    }
    var raw = word & 0xfffu;
    if (index & 1u) != 0u {
        raw = (word >> 12u) & 0xfffu;
    }
    return f32(raw) / 256.0;
}

fn gx_fog_range_adjustment(position_x: f32) -> f32 {
    let center = i32(draw_state.fog_control.x & 0x3ffu) - 342;
    let sample = clamp(abs(position_x - f32(center)) / 32.0, 0.0, 10.0);
    if sample == 0.0 {
        return 1.0;
    }
    if sample >= 10.0 {
        return gx_fog_range_coefficient(9u);
    }
    let interval = u32(floor(sample));
    let fraction = sample - f32(interval);
    var lower = 1.0;
    if interval != 0u {
        lower = gx_fog_range_coefficient(interval - 1u);
    }
    let upper = gx_fog_range_coefficient(interval);
    return lower + (upper - lower) * fraction;
}

fn gx_fog_color(source: vec4<u32>, position_x: f32, depth: u32) -> vec4<u32> {
    let control = gx_fog_parameter(3u);
    let fog_type = (control >> 21u) & 7u;
    if fog_type == 0u {
        return source;
    }

    let a_word = gx_fog_parameter(0u);
    let c_word = gx_fog_parameter(3u);
    var factor: f32;
    if ((a_word >> 11u) & 0xffu) == 0xffu &&
       ((c_word >> 11u) & 0xffu) == 0xffu {
        let both_positive =
            (a_word & 0x00080000u) == 0u &&
            (c_word & 0x00080000u) == 0u;
        factor = select(0.0, 1.0, both_positive);
    } else {
        let a_and_c = gx_fog_a_and_c();
        var eye_depth: f32;
        if (control & (1u << 20u)) == 0u {
            let shifted = depth >> (gx_fog_parameter(2u) & 31u);
            let denominator = i32(gx_fog_parameter(1u) & 0x00ffffffu) - i32(shifted);
            eye_depth = (a_and_c.x * 16777216.0) / f32(denominator);
        } else {
            eye_depth = a_and_c.x * f32(depth) / 16777216.0;
        }
        if (draw_state.fog_control.x & (1u << 10u)) != 0u {
            eye_depth *= gx_fog_range_adjustment(position_x);
        }
        factor = clamp(eye_depth - a_and_c.y, 0.0, 1.0);
    }

    if fog_type == 4u {
        factor = 1.0 - exp2(-8.0 * factor);
    } else if fog_type == 5u {
        factor = 1.0 - exp2(-8.0 * factor * factor);
    } else if fog_type == 6u {
        factor = exp2(-8.0 * (1.0 - factor));
    } else if fog_type == 7u {
        let backward = 1.0 - factor;
        factor = exp2(-8.0 * backward * backward);
    }

    let fog_factor = min(u32(floor(factor * 256.0 + 0.5)), 256u);
    let inverse = 256u - fog_factor;
    let color_word = gx_fog_parameter(4u);
    let fog_color = vec3<u32>(
        (color_word >> 16u) & 0xffu,
        (color_word >> 8u) & 0xffu,
        color_word & 0xffu,
    );
    let rgb = (source.rgb * inverse + fog_color * fog_factor) >> vec3<u32>(8u);
    return vec4<u32>(rgb, source.a);
}

fn tev_fragment_values(
    input: TevVertexOutput,
    managed_raster_bytes: array<vec4<i32>, 8>,
    needs_fragment_depth: bool,
    managed_exact_sampler: bool,
) -> TevFragmentValues {
    let raster_colors = array<vec4<f32>, 8>(
        input.raster0, input.raster1,
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0),
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0),
    );
    let tex_coords = array<vec3<f32>, 8>(
        input.stq0, input.stq1, input.stq2, input.stq3,
        input.stq4, input.stq5, input.stq6, input.stq7,
    );
    let evaluation =
        tev_evaluate(raster_colors, managed_raster_bytes, tex_coords, managed_exact_sampler);
    let source = evaluation.source;
    let tev_alpha = u32(round(clamp(source.a, 0.0, 1.0) * 255.0));
    if !alpha_test_passes(tev_alpha, draw_state.alpha_test) {
        discard;
    }

    let fog_enabled = (draw_state.fragment_flags & 2u) != 0u;
    var buffer_depth = 0u;
    var normalized_source = source;
    if needs_fragment_depth || fog_enabled {
        let raster_depth = gx_raster_depth24(input.depth24);
        let operation_depth = gx_z_texture_depth(raster_depth, evaluation.raw_texture);
        if needs_fragment_depth {
            let late_z_texture = (draw_state.fragment_flags & (1u << 5u)) != 0u;
            buffer_depth = select(raster_depth, operation_depth, late_z_texture);
        }
        if fog_enabled {
            let unorm_source = vec4<u32>(
                round(clamp(source, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0)
            );
            normalized_source =
                vec4<f32>(gx_fog_color(unorm_source, input.position.x, operation_depth)) / 255.0;
        }
    }

    var selected_alpha = tev_alpha;
    if (draw_state.destination_alpha & 0x100u) == 0x100u {
        selected_alpha = draw_state.destination_alpha & 0xffu;
    }
    var primary_alpha = normalized_source.a;
    if (draw_state.fragment_flags & 1u) != 0u {
        primary_alpha = f32(selected_alpha >> 2u) / 63.0;
    }

    var values: TevFragmentValues;
    values.primary = vec4<f32>(normalized_source.rgb, primary_alpha);
    values.secondary = normalized_source;
    values.buffer_depth = buffer_depth;
    return values;
}

@fragment
fn fs_main(input: TevVertexOutput) -> TevFragmentOutput {
    let values = tev_fragment_values(
        input,
        array<vec4<i32>, 8>(
            vec4<i32>(0), vec4<i32>(0), vec4<i32>(0), vec4<i32>(0),
            vec4<i32>(0), vec4<i32>(0), vec4<i32>(0), vec4<i32>(0),
        ),
        false,
        false,
    );
    var output: TevFragmentOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    return output;
}

@fragment
fn fs_depth_main(input: TevVertexOutput) -> TevFragmentDepthOutput {
    let values = tev_fragment_values(
        input,
        array<vec4<i32>, 8>(
            vec4<i32>(0), vec4<i32>(0), vec4<i32>(0), vec4<i32>(0),
            vec4<i32>(0), vec4<i32>(0), vec4<i32>(0), vec4<i32>(0),
        ),
        true,
        false,
    );
    var output: TevFragmentDepthOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    let depth_encoding = (draw_state.fragment_flags >> 2u) & 7u;
    output.depth = gx_efb_depth_to_attachment(values.buffer_depth, depth_encoding);
    return output;
}

@fragment
fn fs_managed_coverage_main(input: ManagedCoverageVertexOutput) -> TevFragmentOutput {
    let values = tev_fragment_values(
        managed_coverage_tev_input(input),
        gx_managed_raster_colors(input),
        false,
        true,
    );
    // Keep the manual sampler's coarse derivatives in uniform control flow.
    // Coverage remains authoritative because no output escapes this discard.
    if !gx_managed_coverage_passes(input) {
        discard;
    }
    var output: TevFragmentOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    return output;
}

@fragment
fn fs_managed_coverage_depth_main(
    input: ManagedCoverageVertexOutput,
) -> TevFragmentDepthOutput {
    let values = tev_fragment_values(
        managed_coverage_tev_input(input),
        gx_managed_raster_colors(input),
        true,
        true,
    );
    if !gx_managed_coverage_passes(input) {
        discard;
    }
    var output: TevFragmentDepthOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    let depth_encoding = (draw_state.fragment_flags >> 2u) & 7u;
    output.depth = gx_efb_depth_to_attachment(values.buffer_depth, depth_encoding);
    return output;
}

@fragment
fn fs_managed_multi_coord_main(
    input: ManagedCoverageVertexOutput,
) -> TevFragmentOutput {
    let values = tev_fragment_values(
        managed_multi_coord_tev_input(input),
        gx_managed_raster_colors(input),
        false,
        true,
    );
    if !gx_managed_coverage_passes(input) {
        discard;
    }
    var output: TevFragmentOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    return output;
}

@fragment
fn fs_managed_multi_coord_depth_main(
    input: ManagedCoverageVertexOutput,
) -> TevFragmentDepthOutput {
    let values = tev_fragment_values(
        managed_multi_coord_tev_input(input),
        gx_managed_raster_colors(input),
        true,
        true,
    );
    if !gx_managed_coverage_passes(input) {
        discard;
    }
    var output: TevFragmentDepthOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    let depth_encoding = (draw_state.fragment_flags >> 2u) & 7u;
    output.depth = gx_efb_depth_to_attachment(values.buffer_depth, depth_encoding);
    return output;
}
";

pub(crate) fn shader_source() -> String {
    [TEV_VERTEX_WGSL, TEV_WGSL, TEV_FRAGMENT_WGSL].concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::{
        GxRasterAttributePlaneF32, GxRasterPoint28_4, GxRasterScissor, GxRasterSetup,
        GxRasterTriangle28_4, GxRasterWinding, gx_raster_channel_u8,
    };

    fn refs(texture: u32, coord: u32, enabled: bool, raster: u32) -> u32 {
        texture | coord << 3 | u32::from(enabled) << 6 | raster << 7
    }

    #[derive(Clone, Copy, Debug, Default)]
    struct IndirectCommandFields {
        indirect_stage: u32,
        format: u32,
        bias: u32,
        bump_alpha: u32,
        matrix: u32,
        matrix_id: u32,
        wrap_s: u32,
        wrap_t: u32,
        use_unmodified_lod: bool,
        add_previous: bool,
    }

    fn indirect_command(fields: IndirectCommandFields) -> u32 {
        (fields.indirect_stage & 3)
            | (fields.format & 3) << 2
            | (fields.bias & 7) << 4
            | (fields.bump_alpha & 3) << 7
            | (fields.matrix & 3) << 9
            | (fields.matrix_id & 3) << 11
            | (fields.wrap_s & 7) << 13
            | (fields.wrap_t & 7) << 16
            | u32::from(fields.use_unmodified_lod) << 19
            | u32::from(fields.add_previous) << 20
    }

    fn indirect_gen_mode(tex_gens: u32, direct_stages: u32, indirect_stages: u32) -> u32 {
        (tex_gens & 0xf)
            | (direct_stages.saturating_sub(1) & 0xf) << 10
            | (indirect_stages & 7) << 16
    }

    fn indirect_matrix_words(rows: [[i32; 3]; 2], exponent: i32) -> [u32; 3] {
        let encoded_exponent = (exponent + 17) as u32 & 0x1f;
        array::from_fn(|column| {
            (rows[0][column] as u32 & 0x7ff)
                | (rows[1][column] as u32 & 0x7ff) << 11
                | match column {
                    0 => (encoded_exponent & 3) << 22,
                    1 => ((encoded_exponent >> 2) & 3) << 22,
                    _ => ((encoded_exponent >> 4) & 1) << 22,
                }
        })
    }

    fn direct_state_from_refs(stage_refs: &[u32]) -> TevDrawState {
        let mut state = TevDrawState::default();
        let stages: Vec<_> = stage_refs
            .iter()
            .copied()
            .map(|refs| TevStage {
                refs,
                ..TevStage::default()
            })
            .collect();
        state.set_stages(&stages);
        state
    }

    fn direct_state_bytes(stage_refs: &[u32]) -> Vec<u8> {
        let mut bytes = vec![0_u8; TEV_DRAW_STATE_BYTES];
        for (stage, refs) in stage_refs.iter().copied().enumerate() {
            let offset = stage * 16 + 8;
            bytes[offset..offset + 4].copy_from_slice(&refs.to_le_bytes());
        }
        bytes[448..452].copy_from_slice(&(stage_refs.len() as u32).to_le_bytes());
        bytes
    }

    fn color_combiner(arguments: [u32; 4], operation: u32, destination: u32) -> u32 {
        arguments[0] << 12
            | arguments[1] << 8
            | arguments[2] << 4
            | arguments[3]
            | (operation & 1) << 18
            | 1 << 19
            | ((operation >> 1) & 3) << 20
            | destination << 22
            | if operation >= 8 { 3 << 16 } else { 0 }
    }

    fn alpha_combiner(arguments: [u32; 4], operation: u32, destination: u32) -> u32 {
        arguments[0] << 13
            | arguments[1] << 10
            | arguments[2] << 7
            | arguments[3] << 4
            | (operation & 1) << 18
            | 1 << 19
            | ((operation >> 1) & 3) << 20
            | destination << 22
            | if operation >= 8 { 3 << 16 } else { 0 }
    }

    fn dolphin_regular_reference(
        a: i32,
        b: i32,
        c: i32,
        d: i32,
        bias: u32,
        subtract: bool,
        scale: u32,
        clamp: bool,
    ) -> i32 {
        let a = a & 0xff;
        let b = b & 0xff;
        let c = (c & 0xff) + ((c & 0xff) >> 7);
        let biased_d = d + [0, 128, -128][bias as usize];
        let interpolation = (a << 8) + (b - a) * c;
        let result = if scale == 3 {
            let mixed = interpolation >> 8;
            (if subtract {
                biased_d - mixed
            } else {
                biased_d + mixed
            }) >> 1
        } else {
            let mixed = ((interpolation << scale) + if subtract { 127 } else { 128 }) >> 8;
            let scaled_d = biased_d << scale;
            if subtract {
                scaled_d - mixed
            } else {
                scaled_d + mixed
            }
        };
        if clamp {
            result.clamp(0, 255)
        } else {
            result.clamp(-1024, 1023)
        }
    }

    #[test]
    fn gpu_records_have_the_documented_pod_layout() {
        assert_eq!(size_of::<TevStage>(), 16);
        assert_eq!(align_of::<TevStage>(), 16);
        assert_eq!(size_of::<TevDrawState>(), 464);
        assert_eq!(align_of::<TevDrawState>(), 16);
        assert_eq!(size_of::<TevFragmentInputs>(), 256);
        assert_eq!(align_of::<TevFragmentInputs>(), 16);
    }

    #[test]
    fn stage_packing_masks_bp_fields_and_decodes_every_reference() {
        let stage = TevStage::from_bp(
            0xffff_ffff,
            0xffff_ffff,
            refs(5, 6, true, 2) | !0x3ff,
            0xff,
            0xfe,
        );
        assert_eq!(stage.color_combiner, 0x00ff_ffff);
        assert_eq!(stage.alpha_combiner, 0x00ff_ffff);
        assert_eq!(stage.texture_map(), 5);
        assert_eq!(stage.tex_coord(), 6);
        assert!(stage.texture_enabled());
        assert_eq!(stage.raster_channel(), 2);
        assert_eq!(stage.raster_swap(), 3);
        assert_eq!(stage.texture_swap(), 3);
        assert_eq!(stage.konst_color_selector(), 31);
        assert_eq!(stage.konst_alpha_selector(), 30);
    }

    #[test]
    fn register_encoding_is_r3_then_r0_r1_r2() {
        assert_eq!(
            array::from_fn::<_, 4, _>(|index| register_index(index as u32)),
            [3, 0, 1, 2]
        );
    }

    #[test]
    fn swap_tables_decode_and_swizzle_all_channels() {
        let table = decode_swap_table(0b00_10, 0b01_11);
        assert_eq!(table, [2, 0, 3, 1]);
        assert_eq!(swizzle([10, 20, 30, 40], table), [30, 10, 40, 20]);

        let mut state = TevDrawState::default();
        assert!(state.set_swap_table(3, 0b11_01, 0b00_10));
        assert_eq!(state.swap_tables[3], [1, 3, 2, 0]);
        assert!(!state.set_swap_table(4, 0, 0));
    }

    #[test]
    fn every_color_and_alpha_argument_maps_to_its_gx_source() {
        let registers = [
            [10, 11, 12, 13],
            [20, 21, 22, 23],
            [30, 31, 32, 33],
            [40, 41, 42, 43],
        ];
        let texture = [50, 51, 52, 53];
        let raster = [60, 61, 62, 63];
        let konst = [70, 71, 72];
        let expected_color = [
            [40, 41, 42],
            [43; 3],
            [10, 11, 12],
            [13; 3],
            [20, 21, 22],
            [23; 3],
            [30, 31, 32],
            [33; 3],
            [50, 51, 52],
            [53; 3],
            [60, 61, 62],
            [63; 3],
            [255; 3],
            [128; 3],
            [70, 71, 72],
            [0; 3],
        ];
        for (argument, expected) in expected_color.into_iter().enumerate() {
            assert_eq!(
                color_input(argument as u32, &registers, texture, raster, konst),
                expected,
                "color argument {argument}",
            );
        }

        let expected_alpha = [43, 13, 23, 33, 53, 63, 70, 0];
        for (argument, expected) in expected_alpha.into_iter().enumerate() {
            assert_eq!(
                alpha_argument(argument as u32, &registers, texture, raster, 70),
                expected,
                "alpha argument {argument}",
            );
        }
    }

    #[test]
    fn all_konst_selectors_match_fractions_registers_and_components() {
        let registers = [
            [-1, 11, 12, 313],
            [20, 21, 22, 23],
            [30, 31, 32, 33],
            [40, 41, 42, 43],
        ];
        let fractions = [255, 223, 191, 159, 128, 96, 64, 32];
        for selector in 0..32_u8 {
            let color = konst_color(selector, &registers);
            let alpha = konst_alpha(selector, &registers);
            match selector {
                0..=7 => {
                    assert_eq!(color, [fractions[selector as usize]; 3]);
                    assert_eq!(alpha, fractions[selector as usize]);
                }
                12..=15 => {
                    let expected =
                        registers[(selector - 12) as usize].map(|value| value.clamp(0, 255));
                    assert_eq!(color, expected[..3]);
                    assert_eq!(alpha, 0);
                }
                16..=31 => {
                    let register = ((selector - 16) & 3) as usize;
                    let channel = ((selector - 16) >> 2) as usize;
                    let expected = registers[register][channel].clamp(0, 255);
                    assert_eq!(color, [expected; 3]);
                    assert_eq!(alpha, expected);
                }
                _ => {
                    assert_eq!(color, [0; 3]);
                    assert_eq!(alpha, 0);
                }
            }
        }
    }

    #[test]
    fn regular_combiner_exhausts_operation_control_fields_and_signed_boundaries() {
        let lanes = [-1024, -1, 0, 1, 127, 128, 255, 1023];
        for bias in 0..3_u32 {
            for subtract in [false, true] {
                for scale in 0..4_u32 {
                    for clamp in [false, true] {
                        let combiner = bias << 16
                            | u32::from(subtract) << 18
                            | u32::from(clamp) << 19
                            | scale << 20;
                        for index in 0..lanes.len() {
                            let a = lanes[index];
                            let b = lanes[(index + 3) % lanes.len()];
                            let c = lanes[(index + 5) % lanes.len()];
                            let d = lanes[(index + 7) % lanes.len()];
                            let expected =
                                dolphin_regular_reference(a, b, c, d, bias, subtract, scale, clamp);
                            assert_eq!(evaluate_regular(a, b, c, d, combiner), expected);
                        }
                    }
                }
            }
        }

        let edge_cases = [
            ((0, 0, 0, 0, 0, false, 1, false), 0),
            ((0, 128, 179, -90, 0, false, 1, false), 0),
            ((0, 128, 182, 91, 0, true, 0, false), 0),
            ((0, 1, 128, 0, 0, false, 3, false), 0),
            ((0, 0, 0, -1, 0, false, 3, false), -1),
            ((0, 0, 0, -1, 1, false, 1, false), 254),
            ((-1, 0, 0, 0, 0, false, 0, true), 255),
        ];
        for ((a, b, c, d, bias, subtract, scale, clamp), expected) in edge_cases {
            let combiner =
                bias << 16 | u32::from(subtract) << 18 | u32::from(clamp) << 19 | scale << 20;
            assert_eq!(
                evaluate_regular(a, b, c, d, combiner),
                expected,
                "{a}, {b}, {c}, {d}, bias {bias}, subtract {subtract}, scale {scale}, clamp {clamp}",
            );
        }
    }

    #[test]
    fn all_color_comparative_operations_select_and_reject_c() {
        let c = [7, -1, 10];
        let d = [-5, 10, 250];
        let cases = [
            ([-1, 0, 0], [0, 255, 255]),
            ([9, 1, 2], [9, 3, 4]),
            ([0, 2, 0], [255, 1, 255]),
            ([7, 8, 1], [7, 8, 2]),
            ([0, 0, 2], [255, 255, 1]),
            ([1, 2, 3], [1, 2, 3]),
            ([2, 2, 2], [1, 3, 2]),
            ([2, 2, 2], [1, 3, 2]),
        ];
        let selected = [2, 255, 255];
        for (offset, (a, b)) in cases.into_iter().enumerate() {
            let operation = 8 + offset as u32;
            let combiner = color_combiner([15; 4], operation, 0);
            let expected = if operation == 14 {
                [2, 10, 250]
            } else if operation == 15 {
                [0, 10, 255]
            } else {
                selected
            };
            assert_eq!(
                evaluate_color_combiner(a, b, c, d, combiner),
                expected,
                "operation {operation}"
            );

            if operation < 14 {
                let target = ((operation >> 1) & 3) as usize;
                let (rejected_a, mut rejected_b) = if operation & 1 == 0 { (b, a) } else { (a, b) };
                if operation & 1 != 0 {
                    rejected_b[target] = (rejected_b[target] + 1) & 0xff;
                }
                assert_eq!(
                    evaluate_color_combiner(rejected_a, rejected_b, c, d, combiner),
                    [0, 10, 250],
                    "operation {operation} rejects"
                );
            }
        }
    }

    #[test]
    fn alpha_comparisons_use_color_for_packed_targets_and_alpha_for_a8() {
        let cases = [
            ([-1, 0, 0], [0, 255, 255], 0, 255),
            ([9, 1, 2], [9, 3, 4], 0, 255),
            ([0, 2, 0], [255, 1, 255], 0, 255),
            ([7, 8, 1], [7, 8, 2], 0, 255),
            ([0, 0, 2], [255, 255, 1], 0, 255),
            ([1, 2, 3], [1, 2, 3], 0, 255),
            ([0, 0, 0], [255, 255, 255], -1, 0),
            ([0, 0, 0], [255, 255, 255], -1, 255),
        ];
        for (offset, (color_a, color_b, a, b)) in cases.into_iter().enumerate() {
            let operation = 8 + offset as u32;
            let combiner = alpha_combiner([7; 4], operation, 0);
            assert_eq!(
                evaluate_alpha_combiner(color_a, color_b, a, b, -1, 10, combiner),
                255,
                "operation {operation}",
            );
        }
    }

    #[test]
    fn full_evaluator_runs_texture_raster_konst_swaps_and_distinct_destinations() {
        // R0.rgb = texture.bgr; R1.a = raster.r after swaps.
        let stage = TevStage::from_bp(
            color_combiner([15, 15, 15, 8], 0, 1),
            alpha_combiner([7, 7, 7, 5], 0, 2) | 1 | (2 << 2),
            refs(3, 6, true, 1),
            0,
            0,
        );
        let mut state = TevDrawState::default();
        state.set_stages(&[stage]);
        state.swap_tables[1] = [1, 2, 3, 0];
        state.swap_tables[2] = [2, 1, 0, 3];
        let mut inputs = TevFragmentInputs::default();
        inputs.textures[3] = [10, 20, 30, 40];
        inputs.rasters[1] = [50, 60, 70, 80];

        let evaluated = evaluate(&state, &inputs);
        assert_eq!(evaluated.raw, [30, 20, 10, 50]);
        assert_eq!(evaluated.last_texture, [10, 20, 30, 40]);
        assert_eq!(evaluated.registers[0][..3], [30, 20, 10]);
        assert_eq!(evaluated.registers[1][3], 50);
        assert_eq!(evaluated.last_color_destination, 0);
        assert_eq!(evaluated.last_alpha_destination, 1);
    }

    #[test]
    fn multi_stage_evaluation_preserves_signed_registers_and_caps_at_sixteen() {
        let pass_raster = TevStage::from_bp(
            color_combiner([15, 15, 15, 10], 0, 1),
            alpha_combiner([7, 7, 7, 5], 0, 1),
            refs(0, 0, false, 0),
            0,
            0,
        );
        let add_r0_to_r3 = TevStage::from_bp(
            // D=R0, A=one, C=zero: R3 = R0 + 255.
            color_combiner([12, 15, 15, 2], 0, 0),
            alpha_combiner([7, 7, 7, 1], 0, 0),
            refs(0, 0, false, 7),
            0,
            0,
        );
        let mut state = TevDrawState::default();
        state.set_stages(&[pass_raster, add_r0_to_r3]);
        // Exercise unclamped signed propagation in stage zero.
        state.stages[0].color_combiner &= !(1 << 19);
        state.stages[1].color_combiner &= !(1 << 19);
        let mut inputs = TevFragmentInputs::default();
        inputs.rasters[0] = [-1, 1, 300, -1];
        let evaluated = evaluate(&state, &inputs);
        assert_eq!(evaluated.raw, [254, 256, 555, 0]);
        assert_eq!(evaluated.rgba8, [254, 255, 255, 0]);

        let ignored = TevStage::from_bp(
            color_combiner([15, 15, 15, 12], 0, 0),
            alpha_combiner([7, 7, 7, 7], 0, 0),
            0,
            0,
            0,
        );
        state.stages = [ignored; MAX_TEV_STAGES];
        state.stages[15] = pass_raster;
        state.stage_count = 99;
        assert_eq!(evaluate(&state, &inputs).raw[..3], [0, 1, 255]);
    }

    #[test]
    fn disabled_texture_is_white_and_zero_stage_draw_returns_r3() {
        let mut state = TevDrawState::default();
        state.color_registers[3] = [-5, 10, 260, 300];
        let empty = evaluate(&state, &TevFragmentInputs::default());
        assert_eq!(empty.raw, [-5, 10, 260, 300]);
        assert_eq!(empty.rgba8, [0, 10, 255, 255]);
        assert_eq!(empty.last_texture, ZERO);

        let pass_texture = TevStage::from_bp(
            color_combiner([15, 15, 15, 8], 0, 0),
            alpha_combiner([7, 7, 7, 4], 0, 0),
            refs(4, 3, false, 7),
            0,
            0,
        );
        state.set_stages(&[pass_texture]);
        let mut inputs = TevFragmentInputs::default();
        inputs.textures[4] = [1, 2, 3, 4];
        let evaluated = evaluate(&state, &inputs);
        assert_eq!(evaluated.raw, WHITE);
        assert_eq!(evaluated.last_texture, ZERO);
    }

    #[test]
    fn last_texture_is_unswizzled_and_survives_later_texture_disabled_stages() {
        let sample = TevStage::from_bp(
            color_combiner([15, 15, 15, 8], 0, 0),
            alpha_combiner([7, 7, 7, 4], 0, 0) | (1 << 2),
            refs(2, 0, true, 7),
            0,
            0,
        );
        let disabled = TevStage::from_bp(
            color_combiner([15, 15, 15, 8], 0, 0),
            alpha_combiner([7, 7, 7, 4], 0, 0),
            refs(7, 0, false, 7),
            0,
            0,
        );
        let mut state = TevDrawState::default();
        state.set_stages(&[sample, disabled]);
        state.swap_tables[1] = [3, 2, 1, 0];
        let mut inputs = TevFragmentInputs::default();
        inputs.textures[2] = [11, 22, 33, 44];
        inputs.textures[7] = [55, 66, 77, 88];
        assert_eq!(evaluate(&state, &inputs).last_texture, [11, 22, 33, 44]);
    }

    #[test]
    fn mkdd_four_stage_thp_yuv_conversion_matches_integer_goldens() {
        // Exact THPGXYuv2RgbSetup state from MKDD's THPDraw.c.
        let stages = [
            TevStage::from_bp(0x00f8_e2, 0x04f3_10, refs(1, 1, true, 7), 12, 28),
            TevStage::from_bp(0x10f8_e0, 0x04f3_00, refs(2, 1, true, 7), 13, 29),
            TevStage::from_bp(0x08f8_c0, 0x089f_80, refs(0, 0, true, 7), 0, 0),
            TevStage::from_bp(0x0810_ef, 0x08ff_f0, refs(0, 0, false, 7), 14, 0),
        ];
        let mut state = TevDrawState::default();
        state.set_stages(&stages);
        state.color_registers[0] = [-90, 0, -114, 135];
        state.konst_registers[0] = [0, 0, 226, 88];
        state.konst_registers[1] = [179, 0, 0, 182];
        state.konst_registers[2] = [255, 0, 255, 128];

        let goldens = [
            ((0, 128, 128), [0, 0, 0, 0]),
            ((16, 128, 128), [16, 16, 16, 0]),
            ((255, 128, 128), [255, 255, 255, 0]),
            ((76, 84, 255), [255, 0, 0, 0]),
            ((149, 43, 21), [0, 254, 0, 0]),
            ((29, 255, 107), [0, 0, 253, 0]),
        ];
        for ((y, u, v), expected) in goldens {
            let mut inputs = TevFragmentInputs::default();
            inputs.textures[0] = [y; 4];
            inputs.textures[1] = [u; 4];
            inputs.textures[2] = [v; 4];
            assert_eq!(
                evaluate(&state, &inputs).raw,
                expected,
                "THP YUV ({y}, {u}, {v})",
            );
        }
    }

    #[test]
    fn wgsl_contract_has_fixed_bindings_projective_sampling_and_full_stage_loop() {
        assert!(TEV_WGSL.contains("@group(1) @binding(0) var<uniform> tev_state"));
        assert!(TEV_WGSL.contains(
            "@group(1) @binding(17) var<uniform> indirect_tev_state: IndirectTevDrawState"
        ));
        for map in 0..MAX_TEV_TEXTURES {
            assert!(TEV_WGSL.contains(&format!("var tev_texture{map}: texture_2d<f32>")));
            assert!(TEV_WGSL.contains(&format!("var tev_sampler{map}: sampler")));
        }
        assert!(TEV_WGSL.contains("let uv = gx_projective_uv(stq)"));
        assert!(TEV_WGSL.contains("TEV_MAX_STAGES: u32 = 16u"));
        assert!(TEV_WGSL.contains("fn tev_color_combiner"));
        assert!(TEV_WGSL.contains("fn tev_alpha_combiner"));
        assert!(TEV_WGSL.contains("fn tev_evaluate"));
        let regular_start = TEV_WGSL
            .find("fn tev_regular(")
            .expect("WGSL regular TEV combiner");
        let regular_end = TEV_WGSL[regular_start..]
            .find("\nfn tev_comparison(")
            .expect("WGSL comparison after regular combiner")
            + regular_start;
        let regular = &TEV_WGSL[regular_start..regular_end];
        assert!(regular.contains("var c = c_raw & 255;\n    c += c >> 7u;"));
        assert!(regular.contains("mixed <<= scale;\n        biased_d <<= scale;"));
        assert!(regular.contains("mixed += select(128, 127, subtract);"));
        assert!(regular.contains("mixed >>= 8u;"));
        assert!(regular.contains("if scale == 3u { result >>= 1u; }"));
        assert!(!regular.contains("f32"));
        assert!(!regular.contains("floor"));
        assert!(!regular.contains("/ 255"));
        assert!(TEV_VERTEX_WGSL.contains("input.position.z / 16777215.0"));
        assert!(!TEV_VERTEX_WGSL.contains("input.position.z / 16777216.0"));
    }

    #[test]
    fn wgsl_projective_q_zero_keeps_st_for_legacy_and_indirect_coordinates() {
        let shader = shader_source();
        let projection_start = shader.find("fn gx_projective_uv(").unwrap();
        let projection_end = shader[projection_start..]
            .find("\n}\n\nfn gx_sampler_mode0")
            .unwrap()
            + projection_start;
        let projection = &shader[projection_start..projection_end];
        assert!(projection.contains("if stq.z == 0.0"));
        assert!(projection.contains("return stq.xy"));
        assert!(projection.contains("return stq.xy / stq.z"));
        assert!(shader.contains("let uv = gx_projective_uv(stq)"));
        assert!(shader.contains("return vec2<i32>(gx_projective_uv(stq) * 128.0)"));
        assert!(!shader.contains("let uv = stq.xy / stq.z"));
        assert!(!shader.contains("(stq.xy / stq.z) * 128.0"));

        let project = |stq: [f32; 3]| {
            if stq[2] == 0.0 {
                [stq[0], stq[1]]
            } else {
                [stq[0] / stq[2], stq[1] / stq[2]]
            }
        };
        assert_eq!(project([320.0, -96.0, 0.0]), [320.0, -96.0]);
        assert_eq!(project([320.0, -96.0, 2.0]), [160.0, -48.0]);
    }

    #[test]
    fn wgsl_indirect_tev_contract_covers_stateful_coordinates_lod_and_bump_rasters() {
        let shader = shader_source();
        assert!(shader.contains(
            "struct IndirectTevDrawState {\n    control: vec4<u32>,\n    matrix_rows: array<vec4<u32>, 3>,\n    commands: array<vec4<u32>, 4>,\n};"
        ));
        assert!(shader.contains("const TEV_INDIRECT_COMMAND_MASK: u32 = 0x001fffffu"));
        assert!(shader.contains(
            "return indirect_tev_state.commands[stage >> 2u][stage & 3u]\n        & TEV_INDIRECT_COMMAND_MASK"
        ));
        assert!(shader.contains("return indirect_tev_state.matrix_rows[2].w != 0u"));
        assert!(shader.contains("return indirect_tev_state.matrix_rows[1].w & 0xffu"));

        let evaluate_start = shader.find("fn tev_evaluate(").unwrap();
        let evaluate_end = shader[evaluate_start..]
            .find("\n}\n\nstruct TevFragmentOutput")
            .unwrap()
            + evaluate_start;
        let evaluate = &shader[evaluate_start..evaluate_end];
        let coordinate_update = evaluate.find("if indirect_present {").unwrap();
        let texture_sample = evaluate.find("let no_texture_generators =").unwrap();
        let raster_select = evaluate.find("let raster_channel =").unwrap();
        assert!(coordinate_update < texture_sample && texture_sample < raster_select);
        assert!(evaluate.contains("if command == 0u"));
        assert!(evaluate.contains("previous_coord = base_coord"));
        assert!(evaluate.contains("gx_indirect_signed_24(next_coord.x)"));
        assert!(evaluate.contains("gx_indirect_wrapping_add(next_coord.x, previous_coord.x)"));
        assert!(
            evaluate.contains("lod_coord = select(sample_coord, base_coord, use_unmodified_lod)")
        );
        assert!(evaluate.contains("indirect_present && gx_indirect_num_tex_gens() == 0u"));
        assert!(evaluate.contains("vec4<i32>(255), vec4<i32>(0), no_texture_generators"));
        assert!(evaluate.contains("if !no_texture_generators"));
        let texture_enable = evaluate.find("if (stage.refs & (1u << 6u)) != 0u").unwrap();
        let raw_texture_update = evaluate.find("raw_texture = texture_base").unwrap();
        assert!(texture_sample < texture_enable && texture_enable < raw_texture_update);
        assert!(evaluate.contains("raster_channel == 5u"));
        assert!(evaluate.contains("raster_channel == 6u"));
        assert!(evaluate.contains("alpha_bump | (alpha_bump >> 5u)"));

        assert!(shader.contains("return vec3<i32>(sample.a, sample.b, sample.g)"));
        assert!(shader.contains("let bias = select(1, -128, format == 0u)"));
        assert!(shader.contains("return (component << gx_indirect_bump_shift(format)) & 0xf8"));
        assert!(shader.contains("fn gx_indirect_matrix_transform("));
        assert!(shader.contains("let exponent = i32(exponent_bits) - 17"));
        assert!(shader.contains("fn gx_indirect_dynamic_product("));
        assert!(shader.contains("return coord & i32((texels << 7u) - 1u)"));

        assert!(shader.contains("fn gx_manual_sample_texture_with_lod("));
        assert!(shader.contains("dpdxCoarse(vec2<f32>(lod_s17_7))"));
        assert!(shader.contains("fn gx_native_sample_texture_with_lod("));
        assert!(shader.contains("textureSampleGrad("));
        assert!(shader.contains("dpdxCoarse(normalized_lod) * lod_scale"));
        assert!(shader.contains("dpdyCoarse(normalized_lod) * lod_scale"));
    }

    #[test]
    fn wgsl_fragment_contract_is_strict_dual_source_webgpu() {
        let shader = shader_source();
        assert!(shader.starts_with("enable dual_source_blending;\n"));
        assert_eq!(shader.matches("enable dual_source_blending;").count(), 1);
        assert!(shader.contains(
            "struct DrawState {\n    alpha_test: u32,\n    destination_alpha: u32,\n    fragment_flags: u32,\n    z_texture: u32,\n    fog_control: vec4<u32>,"
        ));
        assert!(shader.contains("sampler_mode0_lo: vec4<u32>"));
        assert!(shader.contains("sampler_mode0_hi: vec4<u32>"));
        assert!(shader.contains("sampler_mode1_lo: vec4<u32>"));
        assert!(shader.contains("sampler_mode1_hi: vec4<u32>"));
        assert!(shader.contains(
            "struct TevFragmentOutput {\n    @location(0) @blend_src(0) primary: vec4<f32>,\n    @location(0) @blend_src(1) secondary: vec4<f32>,\n};"
        ));
        assert!(shader.contains("fn fs_main(input: TevVertexOutput) -> TevFragmentOutput"));
        assert!(
            shader.contains("fn fs_depth_main(input: TevVertexOutput) -> TevFragmentDepthOutput")
        );
        assert!(shader.contains("@builtin(frag_depth) depth: f32"));
        assert!(
            shader.contains("values.primary = vec4<f32>(normalized_source.rgb, primary_alpha)")
        );
        assert!(shader.contains("values.secondary = normalized_source"));
    }

    #[test]
    fn complete_wgsl_parses_and_validates_with_derivative_uniformity_enabled() {
        let shader = shader_source();
        let module = naga::front::wgsl::parse_str(&shader)
            .unwrap_or_else(|error| panic!("browser TEV WGSL parse failed: {error}"));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap_or_else(|error| panic!("browser TEV WGSL validation failed: {error}"));
    }

    #[test]
    fn wgsl_native_texture_path_preserves_bias_for_webgpu_anisotropy() {
        let shader = shader_source();
        let native_start = shader.find("fn gx_native_normalized_uv(").unwrap();
        let native_end = shader.find("fn tev_sample_texture_managed(").unwrap();
        let native = &shader[native_start..native_end];
        assert!(native.contains("let uv = gx_projective_uv(stq)"));
        assert!(native.contains("if stq.z == 0.0"));
        assert!(native.contains("return texel_uv / vec2<f32>(textureDimensions(texture, 0))"));
        assert!(native.contains("if (mode0 & 0x80000000u) != 0u"));
        assert!(native.contains("return gx_manual_sample_texture(texture, mode0, mode1, uv)"));
        for map in 0..MAX_TEV_TEXTURES {
            assert!(native.contains(&format!(
                "tev_texture{map}, tev_sampler{map}, mode0, mode1, uv"
            )));
        }
        assert_eq!(native.matches("textureSampleBias(").count(), 1);
        assert!(native.contains("f32(signed_bias) / 32.0"));
        assert!(native.contains("let lod_scale = exp2(f32(signed_bias) / 32.0)"));
        assert!(native.contains("textureLoad(texture, coord, i32(mip_level))"));
        assert!(!native.contains("textureSampleLevel("));
    }

    #[test]
    fn wgsl_manual_texture_path_carries_full_gx_lod_reference_state() {
        let shader = shader_source();
        let managed_start = shader.find("fn gx_managed_wrap_coord(").unwrap();
        let managed_end = shader[managed_start..].find("fn tev_swizzle(").unwrap() + managed_start;
        let managed = &shader[managed_start..managed_end];
        assert!(managed.contains("let s17_7 = vec2<i32>(uv * 128.0)"));
        assert!(!managed.contains("uv / vec2<f32>"));
        assert!(managed.contains("textureLoad(texture, coord, i32(mip_level))"));
        assert!(managed.contains("return coord & mask"));
        assert!(managed.contains("if (mirrored & image_size) != 0"));
        assert!(managed.contains("mirrored = ~mirrored"));
        assert!(managed.contains("return clamp(coord, 0, mask)"));
        assert!(managed.contains("let s = level_s - 64"));
        assert!(managed.contains("let t = level_t - 64"));
        assert!(managed.contains("let fract_s = u32(s & 0x7f)"));
        assert!(managed.contains("let fract_t = u32(t & 0x7f)"));
        assert!(managed.contains("filtered >> vec4<u32>(14u)"));
        assert!(managed.contains("let uv_delta_x = abs(dpdxCoarse(vec2<f32>(s17_7)))"));
        assert!(managed.contains("let uv_delta_y = abs(dpdyCoarse(vec2<f32>(s17_7)))"));
        assert!(managed.contains("uv_delta = uv_delta_x + uv_delta_y"));
        assert!(managed.contains("i32(floor(log2(rho) * 16.0)) + bias_sixteenths"));
        assert!(managed.contains("let max_lod = i32((mode1 >> 8u) & 0xffu)"));
        assert!(managed.contains("let min_lod = min(i32(mode1 & 0xffu), max_lod)"));
        assert!(managed.contains("lod > 0"));
        assert!(managed.contains("fractional_lod >= 8u"));
        assert!(managed.contains("next * vec4<u32>(fractional_lod)"));
        let manual_start = managed.find("fn gx_manual_sample_texture(").unwrap();
        let manual_end = managed.find("fn gx_native_sample_texture(").unwrap();
        let manual = &managed[manual_start..manual_end];
        let filter_selection = manual.find("let linear = select(").unwrap();
        let lod_clamp = manual.find("lod = clamp(lod, min_lod, max_lod)").unwrap();
        assert!(filter_selection < lod_clamp);
        assert!(!manual.contains("textureSample("));
        assert!(!manual.contains("textureSampleBias("));
        assert!(!manual.contains("textureSampleLevel("));
        for map in 0..MAX_TEV_TEXTURES {
            assert!(managed.contains(&format!(
                "tev_texture{map}, tev_sampler{map}, mode0, mode1, uv"
            )));
        }
        for field in [
            "sampler_mode0_lo.x",
            "sampler_mode0_lo.y",
            "sampler_mode0_lo.z",
            "sampler_mode0_lo.w",
            "sampler_mode0_hi.x",
            "sampler_mode0_hi.y",
            "sampler_mode0_hi.z",
            "sampler_mode0_hi.w",
            "sampler_mode1_lo.x",
            "sampler_mode1_lo.y",
            "sampler_mode1_lo.z",
            "sampler_mode1_lo.w",
            "sampler_mode1_hi.x",
            "sampler_mode1_hi.y",
            "sampler_mode1_hi.z",
            "sampler_mode1_hi.w",
        ] {
            assert!(
                shader.contains(field),
                "missing DrawState field access {field}"
            );
        }
        assert!(managed.contains("if ((mode0 >> 19u) & 3u) != 0u"));
        assert!(managed.contains("textureSampleBias("));
        assert!(managed.contains("textureSampleGrad("));
        assert!(!managed.contains("textureSampleLevel("));
    }

    #[test]
    fn wgsl_managed_coverage_uses_exact_e3_and_leaves_native_entries_untouched() {
        let shader = shader_source();
        let native_interfaces_start = shader.find("struct TevVertexInput").unwrap();
        let managed_interfaces_start = shader.find("struct ManagedCoverageVertexInput").unwrap();
        let native_interfaces = &shader[native_interfaces_start..managed_interfaces_start];
        assert!(!native_interfaces.contains("packed_xy28_4"));
        assert!(!native_interfaces.contains("raster0_endpoints"));
        assert!(shader.contains("@location(1) raster0_endpoints: vec4<u32>"));
        assert!(shader.contains("@location(2) raster1_endpoints: vec4<u32>"));
        assert!(shader.contains("@location(0) @interpolate(flat) raster0_endpoints: vec4<u32>"));
        assert!(shader.contains("@location(1) @interpolate(flat) raster1_endpoints: vec3<u32>"));
        assert!(shader.contains("@location(3) source_x_bits: vec3<u32>"));
        assert!(shader.contains("@location(4) source_y_bits: vec3<u32>"));
        assert!(shader.contains("@location(2) @interpolate(flat) source_x_bits: vec3<u32>"));
        assert!(shader.contains("@location(3) @interpolate(flat) source_y_bits: vec3<u32>"));
        assert!(shader.contains("@location(11) packed_xy28_4_depth0: vec4<i32>"));
        assert!(shader.contains("@location(12) depth12: vec2<i32>"));
        assert!(shader.contains("@location(10) @interpolate(flat) source_depth24: vec3<f32>"));
        assert!(shader.contains("@location(11) @interpolate(flat) packed_xy28_4: vec3<i32>"));
        assert!(shader.contains("input: ManagedCoverageVertexInput,"));
        assert!(shader.contains(") -> ManagedCoverageVertexOutput"));
        for location in 0..=7 {
            assert!(shader.contains(&format!("@location({location}) @interpolate(flat)")));
        }
        assert!(shader.contains("bitcast<f32>(u32(input.packed_xy28_4_depth0.w))"));
        assert!(shader.contains("bitcast<f32>(u32(input.depth12.x))"));
        assert!(shader.contains("bitcast<f32>(u32(input.depth12.y))"));
        assert!(shader.contains("source_x, source_y, input.source_depth24, sample_x, sample_y,"));
        for coord in 0..MAX_TEV_TEXTURES {
            assert!(shader.contains(&format!("output.stq{coord} = reconstructed_stq")));
        }
        assert!(shader.contains("let sample_x_numerator = floor(input.position.x) * 12.0 + 7.0"));
        assert!(shader.contains("let sample_y_numerator = floor(input.position.y) * 12.0 + 7.0"));
        assert!(shader.contains("let sample_x = sample_x_numerator / 12.0"));
        assert!(shader.contains("let sample_y = sample_y_numerator / 12.0"));
        assert!(!shader.contains("floor(input.position.x) + 7.0 / 12.0"));
        assert!(!shader.contains("floor(input.position.y) + 7.0 / 12.0"));
        assert!(shader.contains("fn gx_managed_attribute_at_sample("));
        assert!(shader.contains("let x_value = attributes.x + x_term"));
        assert!(shader.contains("return x_value + y_term"));
        assert!(shader.contains("let w = 1.0 / inv_w"));
        assert!(shader.contains("let q = q_over_w * w"));
        assert!(shader.contains("var projection = w"));
        assert!(shader.contains("projection = w / q"));
        assert!(shader.contains("s_over_w * projection"));
        assert!(shader.contains("t_over_w * projection"));
        assert!(!shader.contains("vec3<f32>(s_over_w, t_over_w, q_over_w) / inv_w"));

        let native_vertex_start = shader
            .find("@vertex\nfn vs_main(input: TevVertexInput)")
            .unwrap();
        let managed_vertex_start = shader[native_vertex_start..]
            .find("@vertex\nfn vs_managed_coverage(")
            .unwrap()
            + native_vertex_start;
        let native_vertex = &shader[native_vertex_start..managed_vertex_start];
        assert!(
            !native_vertex.contains("packed_xy28_4")
                && !native_vertex.contains("raster0_endpoints")
                && !native_vertex.contains("source_x_bits"),
            "the native vertex entry must retain its original interface",
        );
        assert!(native_vertex.contains("output.raster0 = input.raster0"));
        assert!(native_vertex.contains("output.raster1 = input.raster1"));
        assert!(native_vertex.contains("output.stq0 = input.stq0"));
        assert!(native_vertex.contains("output.stq1 = input.stq1"));
        let managed_vertex_end = shader[managed_vertex_start..]
            .find("const SF32_SIGN_MASK")
            .unwrap()
            + managed_vertex_start;
        let managed_vertex = &shader[managed_vertex_start..managed_vertex_end];
        assert!(managed_vertex.contains("output.source_x_bits = input.source_x_bits"));
        assert!(managed_vertex.contains("output.source_y_bits = input.source_y_bits"));
        assert!(!managed_vertex.contains("output.stq0 = input.stq0"));

        let managed_attribute_start = shader.find("const SF32_SIGN_MASK").unwrap();
        let managed_attribute_end = shader
            .find("fn gx_managed_edge_covers(")
            .expect("managed raster helpers precede coverage");
        let managed_attributes = &shader[managed_attribute_start..managed_attribute_end];
        assert!(managed_attributes.contains("input.raster0_endpoints"));
        assert!(managed_attributes.contains("input.raster1_endpoints"));
        assert!(managed_attributes.contains("fn sf32_add("));
        assert!(managed_attributes.contains("fn sf32_sub("));
        assert!(managed_attributes.contains("fn sf32_mul("));
        assert!(managed_attributes.contains("fn sf32_div("));
        assert!(managed_attributes.contains("fn sf32_from_u32("));
        assert!(managed_attributes.contains("fn sf32_to_gx_u8("));
        assert!(managed_attributes.contains("fn gx_managed_soft_attribute_at_sample("));
        assert!(managed_attributes.contains("let x_value = sf32_add(attribute_bits.x, x_term)"));
        assert!(managed_attributes.contains("return sf32_add(x_value, y_term)"));
        assert!(managed_attributes.contains("input.source_x_bits"));
        assert!(managed_attributes.contains("input.source_y_bits"));
        assert!(managed_attributes.contains("0x41400000u"));
        assert!(managed_attributes.contains("-> array<vec4<i32>, 8>"));
        assert!(
            !managed_attributes.contains("gx_managed_attribute_at_sample(\n            source_x")
        );

        let edge_start = shader.find("fn gx_managed_edge_covers(").unwrap();
        let edge_end = shader[edge_start..]
            .find("// Browser WebGPU cannot force early fragment tests.")
            .unwrap()
            + edge_start;
        let coverage = &shader[edge_start..edge_end];
        assert!(coverage.contains("let sample_x_48 = pixel_x * 48 + 28"));
        assert!(coverage.contains("let sample_y_48 = pixel_y * 48 + 28"));
        assert!(
            coverage.contains("let edge_3 = 3 * constant + dx * sample_y_48 - dy * sample_x_48")
        );
        assert!(coverage.contains("let inclusive = dy < 0 || (dy == 0 && dx > 0)"));
        assert!(coverage.contains("return edge_3 > 0 || (inclusive && edge_3 == 0)"));
        assert!(!coverage.contains("0.583"));
        assert!(!coverage.contains("0.5625"));

        let native_start = shader
            .find("@fragment\nfn fs_main(input: TevVertexOutput)")
            .unwrap();
        let managed_start = shader
            .find("@fragment\nfn fs_managed_coverage_main(input: ManagedCoverageVertexOutput)")
            .unwrap();
        let native = &shader[native_start..managed_start];
        assert!(!native.contains("gx_managed_coverage_passes"));

        let managed = &shader[managed_start..];
        let depth_start = managed.find("fn fs_managed_coverage_depth_main").unwrap();
        let color_entry = &managed[..depth_start];
        let depth_entry = &managed[depth_start..];
        for entry in [color_entry, depth_entry] {
            let tev = entry.find("gx_managed_raster_colors(input)").unwrap();
            let coverage_test = entry.find("if !gx_managed_coverage_passes(input)").unwrap();
            assert!(tev < coverage_test);
        }
        assert!(managed.contains("fn fs_managed_coverage_depth_main"));
        let multi_start = managed
            .find("@fragment\nfn fs_managed_multi_coord_main")
            .unwrap();
        assert_eq!(
            managed[..multi_start]
                .matches("gx_managed_raster_colors(input)")
                .count(),
            2
        );
        assert!(shader.contains("raster_base = managed_raster_bytes[raster_channel]"));
        assert!(shader.contains("raster_base = tev_to_bytes(raster_colors[raster_channel])"));
    }

    #[test]
    fn wgsl_managed_multi_coord_sidecar_selects_only_live_stage_coordinates() {
        let shader = shader_source();
        assert!(shader.contains(
            "@group(2) @binding(0) var<storage, read>\n    managed_tex_coord_sidecar: array<vec4<u32>>"
        ));
        assert!(shader.contains("let record = input.raster0_endpoints.w"));
        assert!(shader.contains("managed_tex_coord_sidecar[record * 19u + word / 4u]"));
        assert!(shader.contains("let base = 3u + texture_coord * 9u"));
        assert!(shader.contains("fn gx_managed_required_tex_coord_mask() -> u32"));
        assert!(shader.contains("return indirect_tev_state.matrix_rows[1].w & 0xffu"));
        assert!(!shader.contains("mask |= 1u << ((refs >> 3u) & 7u)"));

        let start = shader.find("fn managed_multi_coord_tev_input(").unwrap();
        let end = shader[start..]
            .find("fn gx_managed_attribute_at_sample(")
            .unwrap()
            + start;
        let multi = &shader[start..end];
        for coord in 0..8 {
            assert!(multi.contains(&format!(
                "if (required_coord_mask & (1u << {coord}u)) != 0u"
            )));
            assert!(multi.contains(&format!(
                "output.stq{coord} = gx_managed_sidecar_stq(input, {coord}u)"
            )));
            assert_eq!(
                multi
                    .matches(&format!("gx_managed_sidecar_stq(input, {coord}u)"))
                    .count(),
                1,
                "coordinate {coord} must be reconstructed only behind its uniform live bit",
            );
        }
        assert!(!multi.contains("output.stq0 = reconstructed_stq"));
        assert!(!multi.contains("managed_coverage_tev_input(input)"));

        for entry in [
            "fs_managed_multi_coord_main",
            "fs_managed_multi_coord_depth_main",
        ] {
            let start = shader.find(&format!("fn {entry}(")).unwrap();
            let tail = &shader[start..];
            let end = tail.find("\n}\n").unwrap() + 3;
            let entry = &tail[..end];
            let tev = entry.find("managed_multi_coord_tev_input(input)").unwrap();
            let coverage = entry.find("if !gx_managed_coverage_passes(input)").unwrap();
            assert!(
                tev < coverage,
                "manual-sampler derivatives stay in uniform control flow",
            );
        }
        assert!(
            shader.contains("tev_sample_texture_managed(texture_map, tex_coords[tex_coord].xy)")
        );
    }

    #[test]
    fn managed_softfloat_pins_a_fused_and_reassociated_byte_counterexample() {
        let positions = [
            [f32::from_bits(0x4388_70cb), f32::from_bits(0x4225_ed00)],
            [f32::from_bits(0x4387_6b4d), f32::from_bits(0x421f_fc34)],
            [f32::from_bits(0x4386_9331), f32::from_bits(0x422a_6c9b)],
        ];
        let plane =
            GxRasterAttributePlaneF32::from_screen_triangle(positions, [242.0, 190.0, 65.0])
                .unwrap();
        let sample = plane.sample_non_aa(270, 40).unwrap();
        assert_eq!(sample.to_bits(), 0x4326_ffff);
        assert_eq!(gx_raster_channel_u8(sample), 166);
        let points = [
            GxRasterPoint28_4::from_raw(4366, 664),
            GxRasterPoint28_4::from_raw(4333, 640),
            GxRasterPoint28_4::from_raw(4306, 682),
        ];
        let GxRasterSetup::Triangle(triangle) = GxRasterTriangle28_4::setup_post_cull(
            points,
            GxRasterWinding::Negative,
            GxRasterScissor::full_efb(),
        ) else {
            panic!("counterexample must remain a live exact triangle");
        };
        assert!(triangle.covers_pixel(270, 40));

        // A backend-fused setup produces 0x4327_0001 and Y-first accumulation
        // produces 0x4327_0000 for this covered sample: both truncate to 167.
        // Pin the shader to raw input words and the same separately rounded,
        // X-then-Y operation graph as raster.rs.
        let managed = shader_source();
        let start = managed
            .find("fn gx_managed_soft_attribute_at_sample(")
            .unwrap();
        let end = managed[start..]
            .find("fn gx_managed_raster_color_bytes_at_sample(")
            .unwrap()
            + start;
        let plane_shader = &managed[start..end];
        for operation in [
            "let a_left = sf32_mul(delta20, dy10)",
            "let a_right = sf32_mul(delta10, dy20)",
            "let a = sf32_sub(a_left, a_right)",
            "let dfdx = sf32_div(a, c)",
            "let x_term = sf32_mul(dfdx, sample_dx)",
            "let y_term = sf32_mul(dfdy, sample_dy)",
            "let x_value = sf32_add(attribute_bits.x, x_term)",
            "return sf32_add(x_value, y_term)",
        ] {
            assert!(plane_shader.contains(operation), "missing {operation}");
        }
        assert!(!plane_shader.contains("fma("));
        assert!(!plane_shader.contains("bitcast<f32>"));
    }

    #[test]
    fn wgsl_early_depth_commit_is_binding_free_and_writes_only_canonical_depth() {
        let shader = shader_source();
        assert!(shader.contains("@invariant @builtin(position) position: vec4<f32>"));
        let start = shader.find("fn gx_early_depth_commit(").unwrap();
        let end = shader[start..].find("fn alpha_compare").unwrap() + start;
        let commit = &shader[start..end];
        assert!(!commit.contains("discard"));
        assert!(!commit.contains("tev_evaluate"));
        assert!(!commit.contains("textureSample"));
        assert!(!commit.contains("fog"));
        assert!(!commit.contains("destination_alpha"));
        assert!(!commit.contains("@group"));
        assert!(commit.contains("output.depth ="));
        for entry in [
            "fs_early_depth_commit_z24",
            "fs_early_depth_commit_z16_linear",
            "fs_early_depth_commit_z16_near",
            "fs_early_depth_commit_z16_mid",
            "fs_early_depth_commit_z16_far",
        ] {
            assert!(commit.contains(entry));
        }
    }

    #[test]
    fn wgsl_fragment_alpha_order_and_rgba6_quantization_are_exact() {
        let shader = shader_source();
        let evaluate = shader
            .find("tev_evaluate(raster_colors, managed_raster_bytes, tex_coords, managed_exact_sampler)")
            .unwrap();
        let source = shader.find("let source = evaluation.source").unwrap();
        let tev_alpha = shader
            .find("let tev_alpha = u32(round(clamp(source.a, 0.0, 1.0) * 255.0))")
            .unwrap();
        let alpha_test = shader
            .find("if !alpha_test_passes(tev_alpha, draw_state.alpha_test)")
            .unwrap();
        let fog_gate = shader
            .find("if needs_fragment_depth || fog_enabled")
            .unwrap();
        let z_texture = shader
            .find("let operation_depth = gx_z_texture_depth(raster_depth, evaluation.raw_texture)")
            .unwrap();
        let unorm_source = shader.find("let unorm_source = vec4<u32>(").unwrap();
        let fog = shader
            .find("gx_fog_color(unorm_source, input.position.x, operation_depth)")
            .unwrap();
        let destination_alpha = shader
            .find("if (draw_state.destination_alpha & 0x100u) == 0x100u")
            .unwrap();
        let rgba6 = shader
            .find("if (draw_state.fragment_flags & 1u) != 0u")
            .unwrap();
        let quantize = shader
            .find("primary_alpha = f32(selected_alpha >> 2u) / 63.0")
            .unwrap();
        let primary = shader
            .find("values.primary = vec4<f32>(normalized_source.rgb, primary_alpha)")
            .unwrap();
        let secondary = shader.find("values.secondary = normalized_source").unwrap();

        assert!(
            evaluate < source
                && source < tev_alpha
                && tev_alpha < alpha_test
                && alpha_test < fog_gate
                && fog_gate < z_texture
                && z_texture < unorm_source
                && unorm_source < fog
                && fog < destination_alpha
                && alpha_test < destination_alpha
                && destination_alpha < rgba6
                && rgba6 < quantize
                && quantize < primary
                && primary < secondary
        );
        assert!(shader.contains("var selected_alpha = tev_alpha"));
        assert!(shader.contains("selected_alpha = draw_state.destination_alpha & 0xffu"));
        assert!(shader.contains("var primary_alpha = normalized_source.a"));
        assert!(!shader.contains("alpha_test_passes(selected_alpha"));
    }

    #[test]
    fn wgsl_z_texture_uses_last_unswizzled_sample_and_current_depth_encoding() {
        let shader = shader_source();
        let initialize = shader.find("var raw_texture = vec4<i32>(0)").unwrap();
        let managed_sample = shader
            .find("tev_sample_texture_managed(texture_map, tex_coords[tex_coord].xy)")
            .unwrap();
        let native_sample = shader
            .find("tev_sample_texture_native(texture_map, tex_coords[tex_coord])")
            .unwrap();
        let sample = managed_sample.min(native_sample);
        let retain = shader.find("raw_texture = texture_base").unwrap();
        let swizzle = shader
            .find("let texture = tev_swizzle(texture_base")
            .unwrap();
        assert!(initialize < sample && sample < retain && retain < swizzle);
        assert!(shader.contains("source = raw_texture.a"));
        assert!(shader.contains("source = (raw_texture.a << 8u) | raw_texture.r"));
        assert!(
            shader.contains(
                "source = (raw_texture.r << 16u) | (raw_texture.g << 8u) | raw_texture.b"
            )
        );
        assert!(shader.contains("@location(10) @interpolate(linear) depth24: f32"));
        assert!(shader.contains("output.depth24 = input.position.z"));
        assert!(shader.contains("let raster_depth = gx_raster_depth24(input.depth24)"));
        assert!(shader.contains("return u32(depth24)"));
        assert!(!shader.contains("u32(round(clamp(input.position.z, 0.0, 1.0) * 16777215.0))"));
        assert!(shader.contains("fn fs_main(input: TevVertexOutput)"));
        assert!(shader.contains("fn fs_depth_main(input: TevVertexOutput)"));
        assert!(shader.contains("textureSampleBias("));
        assert!(!shader.contains("textureSampleLevel("));
        assert!(
            shader.contains(
                "((draw_state.z_texture & 0x00ffffffu) + source + reference) & 0x00ffffffu"
            )
        );
        assert!(shader.contains("if operation == 0u {\n        return reference_depth;"));
        assert!(shader.contains(
            "output.depth = gx_efb_depth_to_attachment(values.buffer_depth, depth_encoding)"
        ));
        assert!(
            shader.contains("buffer_depth = select(raster_depth, operation_depth, late_z_texture)")
        );
        assert!(shader.contains("eye_depth = (a_and_c.x * 16777216.0)"));
    }

    #[test]
    fn wgsl_fog_uses_post_ztexture_depth_signed_math_and_native_range_lut() {
        let shader = shader_source();
        assert!(shader.contains("fn gx_fog_color("));
        assert!(
            shader.contains(
                "let denominator = i32(gx_fog_parameter(1u) & 0x00ffffffu) - i32(shifted)"
            )
        );
        assert!(shader.contains("a_and_c.x * f32(depth) / 16777216.0"));
        assert!(shader.contains("raw = word & 0xfffu"));
        assert!(shader.contains("raw = (word >> 12u) & 0xfffu"));
        assert!(shader.contains("return f32(raw) / 256.0"));
        assert!(shader.contains("abs(position_x - f32(center)) / 32.0"));
        assert!(!shader.contains("sqrt("));
        assert!(shader.contains("u32(floor(factor * 256.0 + 0.5))"));
        assert!(shader.contains("return vec4<u32>(rgb, source.a)"));

        let alpha_test = shader
            .find("if !alpha_test_passes(tev_alpha, draw_state.alpha_test)")
            .unwrap();
        let gate = shader
            .find("if needs_fragment_depth || fog_enabled")
            .unwrap();
        let z_texture = shader
            .find("let operation_depth = gx_z_texture_depth(raster_depth, evaluation.raw_texture)")
            .unwrap();
        let fog = shader
            .find("gx_fog_color(unorm_source, input.position.x, operation_depth)")
            .unwrap();
        assert!(alpha_test < gate && gate < z_texture && z_texture < fog);
    }

    #[test]
    fn browser_transport_requires_the_exact_pod_and_eight_texture_slots() {
        assert_eq!(
            validate_draw_transport(
                TEV_VERTEX_FLOATS * 3,
                TEV_DRAW_STATE_BYTES,
                MAX_TEV_TEXTURES,
                TEV_TEXTURE_METADATA_WORDS,
                MAX_TEV_TEXTURES,
            ),
            Ok(3),
        );
        assert!(
            validate_draw_transport(
                TEV_VERTEX_FLOATS * 3 - 1,
                TEV_DRAW_STATE_BYTES,
                MAX_TEV_TEXTURES,
                TEV_TEXTURE_METADATA_WORDS,
                MAX_TEV_TEXTURES,
            )
            .unwrap_err()
            .contains("36-float aligned")
        );
        assert!(
            validate_draw_transport(
                0,
                TEV_DRAW_STATE_BYTES - 1,
                MAX_TEV_TEXTURES,
                TEV_TEXTURE_METADATA_WORDS,
                MAX_TEV_TEXTURES,
            )
            .unwrap_err()
            .contains("exactly 464 bytes")
        );
        assert!(
            validate_draw_transport(
                0,
                TEV_DRAW_STATE_BYTES,
                MAX_TEV_TEXTURES - 1,
                TEV_TEXTURE_METADATA_WORDS,
                MAX_TEV_TEXTURES,
            )
            .unwrap_err()
            .contains("exactly 8 slots")
        );
    }

    #[test]
    fn required_texture_maps_follow_only_enabled_live_stages() {
        let mut bytes = vec![0_u8; TEV_DRAW_STATE_BYTES];
        bytes[8..12].copy_from_slice(&refs(3, 0, true, 0).to_le_bytes());
        bytes[24..28].copy_from_slice(&refs(6, 0, true, 0).to_le_bytes());
        bytes[448..452].copy_from_slice(&1_u32.to_le_bytes());
        assert_eq!(
            required_texture_maps(&bytes).unwrap(),
            [false, false, false, true, false, false, false, false]
        );

        bytes[448..452].copy_from_slice(&2_u32.to_le_bytes());
        assert_eq!(
            required_texture_maps(&bytes).unwrap(),
            [false, false, false, true, false, false, true, false]
        );
        assert!(required_texture_maps(&bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn required_texture_coords_follow_enabled_live_stages_and_deduplicate() {
        let mut bytes = vec![0_u8; TEV_DRAW_STATE_BYTES];
        bytes[8..12].copy_from_slice(&refs(3, 7, true, 0).to_le_bytes());
        bytes[24..28].copy_from_slice(&refs(6, 7, true, 0).to_le_bytes());
        bytes[40..44].copy_from_slice(&refs(1, 2, false, 0).to_le_bytes());
        bytes[56..60].copy_from_slice(&refs(0, 2, true, 0).to_le_bytes());

        bytes[448..452].copy_from_slice(&1_u32.to_le_bytes());
        assert_eq!(
            required_texture_coords(&bytes).unwrap(),
            [false, false, false, false, false, false, false, true],
        );

        bytes[448..452].copy_from_slice(&3_u32.to_le_bytes());
        assert_eq!(
            required_texture_coords(&bytes).unwrap(),
            [false, false, false, false, false, false, false, true],
            "disabled stages do not make their coordinate live",
        );

        bytes[448..452].copy_from_slice(&4_u32.to_le_bytes());
        assert_eq!(
            required_texture_coords(&bytes).unwrap(),
            [false, false, true, false, false, false, false, true],
        );
        assert!(required_texture_coords(&bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn indirect_command_decode_covers_every_field_encoding() {
        for indirect_stage in 0..4 {
            assert_eq!(
                IndirectTevCommand::decode(indirect_stage).indirect_stage,
                indirect_stage as usize
            );
        }
        for (format, expected) in [
            IndirectTevFormat::Bits8,
            IndirectTevFormat::Bits5,
            IndirectTevFormat::Bits4,
            IndirectTevFormat::Bits3,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                IndirectTevCommand::decode((format as u32) << 2).format,
                expected
            );
        }
        for bias in 0_u32..8 {
            assert_eq!(
                IndirectTevCommand::decode(bias << 4).bias,
                [bias & 1 != 0, bias & 2 != 0, bias & 4 != 0]
            );
        }
        for (bump_alpha, expected) in [
            IndirectTevBumpAlpha::Off,
            IndirectTevBumpAlpha::S,
            IndirectTevBumpAlpha::T,
            IndirectTevBumpAlpha::U,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                IndirectTevCommand::decode((bump_alpha as u32) << 7).bump_alpha,
                expected
            );
        }
        for matrix in 0_u32..4 {
            assert_eq!(
                IndirectTevCommand::decode(matrix << 9).matrix_index,
                if matrix == 0 {
                    None
                } else {
                    Some(matrix as usize - 1)
                }
            );
        }
        for (matrix_id, expected) in [
            IndirectTevMatrixId::Static,
            IndirectTevMatrixId::DynamicS,
            IndirectTevMatrixId::DynamicT,
            IndirectTevMatrixId::Invalid,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                IndirectTevCommand::decode((matrix_id as u32) << 11).matrix_id,
                expected
            );
        }
        let wraps = [
            IndirectTevWrap::Off,
            IndirectTevWrap::Wrap256,
            IndirectTevWrap::Wrap128,
            IndirectTevWrap::Wrap64,
            IndirectTevWrap::Wrap32,
            IndirectTevWrap::Wrap16,
            IndirectTevWrap::Zero,
            IndirectTevWrap::Invalid,
        ];
        for (wrap, expected) in wraps.into_iter().enumerate() {
            assert_eq!(
                IndirectTevCommand::decode((wrap as u32) << 13).wrap_s,
                expected
            );
            assert_eq!(
                IndirectTevCommand::decode((wrap as u32) << 16).wrap_t,
                expected
            );
        }

        let all = IndirectTevCommand::decode(0xfff8_ffff);
        assert_eq!(
            all.raw, 0x0018_ffff,
            "IND_CMD semantics are limited to 21 bits"
        );
        assert!(all.use_unmodified_lod);
        assert!(all.add_previous);
        assert_eq!(
            IndirectTevCommand::decode(0x00e0_0000).raw,
            0,
            "reserved BP bits cannot activate indirect coordinate behavior"
        );
    }

    #[test]
    fn indirect_matrix_decode_preserves_signed_rows_and_full_exponent_range() {
        let rows = [[-1024, -1, 1023], [1023, 0, -1024]];
        for exponent in -17..=14 {
            let mut words = indirect_matrix_words(rows, exponent);
            words[2] |= 1 << 23;
            let mut raw_matrices = [0_u32; INDIRECT_TEV_MATRIX_COUNT * 3];
            raw_matrices[..3].copy_from_slice(&words);
            let state = IndirectTevState::from_bp(
                0xff00_0000,
                raw_matrices,
                0xff00_0000,
                [0xff00_0001; MAX_TEV_STAGES],
                [0xff00_0000; 2],
                0xff00_0000,
            );
            assert_eq!(
                state.matrix(0),
                IndirectTevMatrix { rows, exponent },
                "matrix C bit 23 is not part of the five-bit exponent"
            );
            assert_eq!(state.commands[0], 1);
            assert_eq!(state.gen_mode, 0);
            assert_eq!(state.imask, 0);
        }
    }

    #[test]
    fn indirect_iref_and_texscale_decode_all_four_stages_including_zero() {
        let maps = [0_usize, 1, 7, 3];
        let coords = [0_usize, 6, 2, 7];
        let mut iref = 0_u32;
        let mut tex_scales = [0_u32; 2];
        for stage in 0..MAX_INDIRECT_TEV_STAGES {
            iref |= (maps[stage] as u32 | (coords[stage] as u32) << 3) << (stage * 6);
            let scale_shift = (stage % 2) * 8;
            tex_scales[stage / 2] |=
                ((stage + 1) as u32 | ((stage + 5) as u32) << 4) << scale_shift;
        }
        let state = IndirectTevState {
            iref,
            tex_scales,
            ..IndirectTevState::default()
        };
        for stage in 0..MAX_INDIRECT_TEV_STAGES {
            assert_eq!(
                state.reference(stage),
                IndirectTevReference {
                    texture_map: maps[stage],
                    tex_coord: coords[stage]
                }
            );
            assert_eq!(
                state.scale(stage),
                IndirectTevScale {
                    s_shift: (stage + 1) as u32,
                    t_shift: (stage + 5) as u32
                }
            );
        }
        assert_eq!(
            IndirectTevState::default().reference(0),
            IndirectTevReference {
                texture_map: 0,
                tex_coord: 0
            },
            "IREF zero is a valid map-zero/coord-zero reference"
        );
    }

    #[test]
    fn indirect_resource_helpers_separate_samples_from_complete_dataflow() {
        let mut bytes = direct_state_bytes(&[
            refs(0, 2, false, 0),
            refs(0, 1, false, 0),
            refs(0, 2, false, 0),
            refs(6, 7, true, 0),
            refs(5, 5, true, 0),
        ]);
        bytes[448..452].copy_from_slice(&4_u32.to_le_bytes());
        let mut indirect = IndirectTevState {
            gen_mode: indirect_gen_mode(3, 4, 1),
            iref: 2 | 7 << 3,
            ..IndirectTevState::default()
        };
        indirect.commands[0] = indirect_command(IndirectCommandFields {
            matrix: 1,
            ..IndirectCommandFields::default()
        });
        indirect.commands[2] = indirect_command(IndirectCommandFields {
            indirect_stage: 1,
            bump_alpha: 1,
            add_previous: true,
            ..IndirectCommandFields::default()
        });
        indirect.commands[4] = indirect_command(IndirectCommandFields {
            matrix: 1,
            ..IndirectCommandFields::default()
        });

        assert_eq!(
            required_indirect_texture_maps(&bytes, &indirect).unwrap(),
            [false, false, true, false, false, false, false, false]
        );
        assert_eq!(
            required_indirect_texture_coords(&bytes, &indirect).unwrap(),
            [true, false, false, false, false, false, false, false],
            "IREF coord 7 falls back to coord 0 with three texgens"
        );
        assert_eq!(
            required_texture_maps_with_indirect(&bytes, &indirect).unwrap(),
            [false, false, true, false, false, false, true, false]
        );
        assert_eq!(
            required_texture_coords_with_indirect(&bytes, &indirect).unwrap(),
            [true, true, true, false, false, false, false, false],
            "disabled raw-zero reset stages remain in persistent-coordinate dataflow"
        );

        let zero_iref_bytes = direct_state_bytes(&[refs(4, 7, true, 0)]);
        assert!(direct_texture_requires_gen_mode(&zero_iref_bytes, 0).unwrap());
        assert!(direct_texture_requires_gen_mode(&zero_iref_bytes, 1).unwrap());
        assert!(!direct_texture_requires_gen_mode(&zero_iref_bytes, 8).unwrap());
        assert!(
            direct_texture_requires_gen_mode(&direct_state_bytes(&[refs(4, 7, false, 0)]), 0,)
                .unwrap(),
            "zero texgens transports black TEXC/TEXA even with disabled texture order"
        );
        assert!(
            !direct_texture_requires_gen_mode(&direct_state_bytes(&[refs(4, 7, false, 0)]), 1,)
                .unwrap(),
            "disabled texture order needs no coordinate fallback when a generator exists"
        );
        let zero_iref = IndirectTevState {
            gen_mode: indirect_gen_mode(1, 1, 1),
            commands: [indirect_command(IndirectCommandFields {
                matrix: 1,
                ..IndirectCommandFields::default()
            }); MAX_TEV_STAGES],
            ..IndirectTevState::default()
        };
        assert_eq!(
            required_indirect_texture_maps(&zero_iref_bytes, &zero_iref).unwrap(),
            [true, false, false, false, false, false, false, false]
        );
        assert_eq!(
            required_indirect_texture_coords(&zero_iref_bytes, &zero_iref).unwrap(),
            [true, false, false, false, false, false, false, false]
        );

        let no_texgens = IndirectTevState {
            gen_mode: indirect_gen_mode(0, 1, 1),
            ..zero_iref
        };
        assert_eq!(
            required_texture_maps_with_indirect(&zero_iref_bytes, &no_texgens).unwrap(),
            [true, false, false, false, false, false, false, false],
            "zero texgens disables direct map 4 but retains indirect IREF map 0"
        );
        assert_eq!(
            required_texture_coords_with_indirect(&zero_iref_bytes, &no_texgens).unwrap(),
            [false; MAX_TEV_TEXTURES],
            "NUMTEXGENS zero needs no vertex sidecar coordinate"
        );

        assert!(required_indirect_texture_maps(&bytes[..bytes.len() - 1], &indirect).is_err());
        assert!(
            required_texture_coords_with_indirect(&bytes[..bytes.len() - 1], &indirect).is_err()
        );
        assert!(direct_texture_requires_gen_mode(&bytes[..bytes.len() - 1], 1).is_err());
    }

    #[test]
    fn indirect_formats_biases_and_bump_channels_match_gx_bit_rules() {
        let sample_abg = indirect_sample_abg([0x11, 0x22, 0x33, 0x44]);
        assert_eq!(sample_abg, [0x44, 0x33, 0x22], "GX samples indirect A/B/G");
        let formats = [
            (IndirectTevFormat::Bits8, 0, -128, 0),
            (IndirectTevFormat::Bits5, 3, 1, 5),
            (IndirectTevFormat::Bits4, 4, 1, 4),
            (IndirectTevFormat::Bits3, 5, 1, 3),
        ];
        for (format, coordinate_shift, selected_bias, bump_shift) in formats {
            for bias in 0_u32..8 {
                let selected = [bias & 1 != 0, bias & 2 != 0, bias & 4 != 0];
                assert_eq!(
                    formatted_indirect_sample(sample_abg, format, selected),
                    array::from_fn(|component| {
                        (sample_abg[component] >> coordinate_shift)
                            + if selected[component] {
                                selected_bias
                            } else {
                                0
                            }
                    })
                );
            }
            assert_eq!(
                indirect_bump_alpha(sample_abg, IndirectTevBumpAlpha::Off, format),
                None
            );
            for (selection, component) in [
                (IndirectTevBumpAlpha::S, 0),
                (IndirectTevBumpAlpha::T, 1),
                (IndirectTevBumpAlpha::U, 2),
            ] {
                assert_eq!(
                    indirect_bump_alpha(sample_abg, selection, format),
                    Some((sample_abg[component] << bump_shift) & 0xf8)
                );
            }
        }
    }

    #[test]
    fn indirect_evaluator_covers_static_dynamic_and_invalid_matrices_and_utclod() {
        let direct = direct_state_from_refs(&[
            refs(0, 0, false, 0),
            refs(0, 0, false, 0),
            refs(0, 0, false, 0),
            refs(0, 0, false, 0),
        ]);
        let mut indirect = IndirectTevState {
            gen_mode: indirect_gen_mode(1, 4, 1),
            ..IndirectTevState::default()
        };
        indirect.matrices[..3]
            .copy_from_slice(&indirect_matrix_words([[512, 0, 0], [0, -512, 0]], 0));
        indirect.commands[0] = indirect_command(IndirectCommandFields {
            matrix: 1,
            use_unmodified_lod: true,
            ..IndirectCommandFields::default()
        });
        indirect.commands[1] = indirect_command(IndirectCommandFields {
            matrix: 1,
            matrix_id: 1,
            ..IndirectCommandFields::default()
        });
        indirect.commands[2] = indirect_command(IndirectCommandFields {
            matrix: 1,
            matrix_id: 2,
            ..IndirectCommandFields::default()
        });
        indirect.commands[3] = indirect_command(IndirectCommandFields {
            matrix: 1,
            matrix_id: 3,
            ..IndirectCommandFields::default()
        });
        let mut inputs = IndirectTevInputs::default();
        inputs.tex_coords[0] = [1280, 2560];
        inputs.samples[0] = [10, 20, 32, 64];

        let evaluated = evaluate_indirect_coordinates(&direct, &indirect, &inputs);
        assert_eq!(evaluated.stage_count, 4);
        assert_eq!(evaluated.stages[0].sample_coord, [5376, 512]);
        assert_eq!(evaluated.stages[0].lod_coord, [1280, 2560]);
        assert_ne!(
            evaluated.stages[0].sample_coord, evaluated.stages[0].lod_coord,
            "utcLOD keeps the unmodified coordinate only for LOD"
        );
        assert_eq!(evaluated.stages[1].sample_coord, [1600, 3200]);
        assert_eq!(evaluated.stages[1].lod_coord, [1600, 3200]);
        assert_eq!(evaluated.stages[2].sample_coord, [1440, 2880]);
        assert_eq!(evaluated.stages[3].sample_coord, [1280, 2560]);
        assert_eq!(evaluated.final_coord, [1280, 2560]);
        assert!(evaluated.indirect_lookups[0].required);
    }

    #[test]
    fn indirect_evaluator_applies_matrix_exponent_extremes() {
        let direct = direct_state_from_refs(&[refs(0, 0, false, 0), refs(0, 0, false, 0)]);
        let mut indirect = IndirectTevState {
            gen_mode: indirect_gen_mode(1, 2, 1),
            ..IndirectTevState::default()
        };
        indirect.matrices[..3].copy_from_slice(&indirect_matrix_words([[8, 0, 0], [0, 8, 0]], 14));
        indirect.matrices[3..6]
            .copy_from_slice(&indirect_matrix_words([[8, 0, 0], [0, 8, 0]], -17));
        indirect.commands[0] = indirect_command(IndirectCommandFields {
            matrix: 1,
            ..IndirectCommandFields::default()
        });
        indirect.commands[1] = indirect_command(IndirectCommandFields {
            matrix: 2,
            ..IndirectCommandFields::default()
        });
        let mut inputs = IndirectTevInputs::default();
        inputs.samples[0] = [0, 0, 1, 1];

        let evaluated = evaluate_indirect_coordinates(&direct, &indirect, &inputs);
        assert_eq!(evaluated.stages[0].sample_coord, [16_384, 16_384]);
        assert_eq!(evaluated.stages[1].sample_coord, [0, 0]);
    }

    #[test]
    fn indirect_wrap_s24_count_zero_and_raw_reset_are_stateful() {
        let wraps = [
            (IndirectTevWrap::Off, -1),
            (IndirectTevWrap::Wrap256, 32_767),
            (IndirectTevWrap::Wrap128, 16_383),
            (IndirectTevWrap::Wrap64, 8_191),
            (IndirectTevWrap::Wrap32, 4_095),
            (IndirectTevWrap::Wrap16, 2_047),
            (IndirectTevWrap::Zero, 0),
            (IndirectTevWrap::Invalid, 0),
        ];
        for (wrap, expected) in wraps {
            assert_eq!(wrap_indirect_coord(-1, wrap), expected);
        }
        assert_eq!(signed_24(0x007f_ffff), 0x007f_ffff);
        assert_eq!(signed_24(0x0080_0000), -0x0080_0000);
        assert_eq!(signed_24(0x00ff_ffff), -1);
        assert_eq!(signed_24(0x0100_0001), 1);

        let direct = direct_state_from_refs(&[
            refs(0, 0, false, 0),
            refs(0, 1, false, 0),
            refs(0, 2, false, 0),
            refs(0, 3, false, 0),
        ]);
        let mut indirect = IndirectTevState {
            gen_mode: indirect_gen_mode(4, 4, 0),
            ..IndirectTevState::default()
        };
        indirect.commands[0] = indirect_command(IndirectCommandFields {
            wrap_s: 5,
            wrap_t: 5,
            ..IndirectCommandFields::default()
        });
        indirect.commands[1] = 0x00e0_0000;
        indirect.commands[2] = indirect_command(IndirectCommandFields {
            bump_alpha: 1,
            matrix: 1,
            add_previous: true,
            ..IndirectCommandFields::default()
        });
        indirect.commands[3] = 0;
        let mut inputs = IndirectTevInputs::default();
        inputs.tex_coords[0] = [3000, -1];
        inputs.tex_coords[1] = [100, 200];
        inputs.tex_coords[2] = [0x007f_ffff, 1];
        inputs.tex_coords[3] = [-40, 50];
        inputs.samples[0] = [255; 4];

        let evaluated = evaluate_indirect_coordinates(&direct, &indirect, &inputs);
        assert_eq!(evaluated.stages[0].sample_coord, [952, 2047]);
        assert_eq!(evaluated.stages[1].sample_coord, [100, 200]);
        assert_eq!(
            evaluated.stages[2].sample_coord,
            [signed_24(0x007f_ffff + 100), 201],
            "count-zero skips sample/matrix/bump but still applies ADDPREV after reserved-only reset"
        );
        assert_eq!(evaluated.stages[2].alpha_bump, 0);
        assert_eq!(evaluated.stages[3].sample_coord, [-40, 50]);
        assert_eq!(evaluated.final_coord, [-40, 50]);
    }

    #[test]
    fn indirect_out_of_range_bt_keeps_wrap_but_skips_sample_matrix_and_bump() {
        let direct = direct_state_from_refs(&[refs(0, 0, false, 0)]);
        let mut indirect = IndirectTevState {
            gen_mode: indirect_gen_mode(1, 1, 1),
            ..IndirectTevState::default()
        };
        indirect.commands[0] = indirect_command(IndirectCommandFields {
            indirect_stage: 1,
            bump_alpha: 2,
            matrix: 1,
            wrap_s: 5,
            wrap_t: 5,
            ..IndirectCommandFields::default()
        });
        indirect.matrices[..3]
            .copy_from_slice(&indirect_matrix_words([[512, 0, 0], [0, 512, 0]], 0));
        let mut inputs = IndirectTevInputs::default();
        inputs.tex_coords[0] = [3000, -1];
        inputs.samples[1] = [255; 4];

        let evaluated = evaluate_indirect_coordinates(&direct, &indirect, &inputs);
        assert_eq!(evaluated.stages[0].sample_coord, [952, 2047]);
        assert_eq!(evaluated.alpha_bump, 0);
        assert!(
            evaluated
                .indirect_lookups
                .iter()
                .all(|lookup| !lookup.required)
        );
    }

    #[test]
    fn indirect_alpha_bump_persists_normalizes_and_updates_only_on_valid_samples() {
        let direct = direct_state_from_refs(&[
            refs(0, 0, false, 0),
            refs(0, 0, false, 0),
            refs(0, 0, false, 0),
            refs(0, 0, false, 0),
        ]);
        let mut indirect = IndirectTevState {
            gen_mode: indirect_gen_mode(1, 4, 1),
            ..IndirectTevState::default()
        };
        indirect.commands[0] = indirect_command(IndirectCommandFields {
            bump_alpha: 1,
            ..IndirectCommandFields::default()
        });
        indirect.commands[1] = indirect_command(IndirectCommandFields {
            wrap_s: 6,
            ..IndirectCommandFields::default()
        });
        indirect.commands[2] = indirect_command(IndirectCommandFields {
            indirect_stage: 1,
            bump_alpha: 2,
            ..IndirectCommandFields::default()
        });
        indirect.commands[3] = indirect_command(IndirectCommandFields {
            format: 3,
            bump_alpha: 3,
            ..IndirectCommandFields::default()
        });
        let mut inputs = IndirectTevInputs::default();
        inputs.samples[0] = [0x11, 0x22, 0x33, 0x44];

        let evaluated = evaluate_indirect_coordinates(&direct, &indirect, &inputs);
        assert_eq!(evaluated.stages[0].alpha_bump, 64);
        assert_eq!(evaluated.stages[0].normalized_alpha_bump(), 66);
        assert_eq!(evaluated.stages[1].alpha_bump, 64);
        assert_eq!(evaluated.stages[2].alpha_bump, 64);
        assert_eq!(evaluated.stages[3].alpha_bump, 16);
        assert_eq!(evaluated.alpha_bump, 16);
    }

    #[test]
    fn indirect_lookup_scales_fallback_and_numtexgens_zero_synthesis() {
        let direct = direct_state_from_refs(&[refs(0, 7, false, 0)]);
        let mut indirect = IndirectTevState {
            gen_mode: indirect_gen_mode(2, 1, 1),
            iref: 7 << 3,
            tex_scales: [1 | 2 << 4, 0],
            ..IndirectTevState::default()
        };
        indirect.commands[0] = indirect_command(IndirectCommandFields {
            matrix: 1,
            matrix_id: 3,
            ..IndirectCommandFields::default()
        });
        let mut inputs = IndirectTevInputs::default();
        inputs.tex_coords[0] = [-9, 20];

        let evaluated = evaluate_indirect_coordinates(&direct, &indirect, &inputs);
        assert_eq!(
            evaluated.indirect_lookups[0],
            IndirectTevLookup {
                required: true,
                texture_map: 0,
                tex_coord: 0,
                sample_coord: [-5, 5]
            }
        );
        assert_eq!(evaluated.stages[0].base_coord, [-9, 20]);

        indirect.gen_mode = indirect_gen_mode(0, 1, 1);
        let synthesized = evaluate_indirect_coordinates(&direct, &indirect, &inputs);
        assert_eq!(synthesized.indirect_lookups[0].texture_map, 0);
        assert_eq!(synthesized.indirect_lookups[0].tex_coord, 0);
        assert_eq!(synthesized.indirect_lookups[0].sample_coord, [0, 0]);
        assert_eq!(synthesized.stages[0].base_coord, [0, 0]);
        assert_eq!(synthesized.stages[0].sample_coord, [0, 0]);
    }

    fn sidecar_source(vertex_count: usize) -> Vec<f32> {
        let mut source = vec![0.0; vertex_count * TEV_VERTEX_FLOATS];
        for vertex in 0..vertex_count {
            let offset = vertex * TEV_VERTEX_FLOATS;
            source[offset + 3] = [1.0_f32, 2.0, 4.0, 8.0][vertex];
            for coord in 0..MAX_TEV_TEXTURES {
                let stq = offset + 12 + coord * 3;
                source[stq] = coord as f32 + vertex as f32 * 0.125 + 0.25;
                source[stq + 1] = coord as f32 * 0.5 + vertex as f32 * 0.25 + 0.5;
                source[stq + 2] = 1.0 + coord as f32 * 0.0625;
            }
        }
        source
    }

    #[test]
    fn managed_sidecar_packs_all_eight_exact_planes_and_zeros_inactive_slots() {
        let source = sidecar_source(3);
        let record =
            managed_tex_coord_sidecar_record(&source, [0, 1, 2], [true; MAX_TEV_TEXTURES]).unwrap();
        assert_eq!(record[..3], [1.0_f32, 0.5, 0.25].map(f32::to_bits),);
        for coord in 0..MAX_TEV_TEXTURES {
            let base = 3 + coord * 9;
            for component in 0..3 {
                for endpoint in 0..3 {
                    let offset = endpoint * TEV_VERTEX_FLOATS;
                    let expected =
                        source[offset + 12 + coord * 3 + component] * (1.0 / source[offset + 3]);
                    assert_eq!(
                        record[base + component * 3 + endpoint],
                        expected.to_bits(),
                        "coord {coord} component {component} endpoint {endpoint}",
                    );
                }
            }
        }
        assert_eq!(record[MANAGED_TEX_COORD_SIDECAR_WORDS - 1], 0);

        let mut required = [false; MAX_TEV_TEXTURES];
        required[2] = true;
        required[7] = true;
        let sparse = managed_tex_coord_sidecar_record(&source, [0, 1, 2], required).unwrap();
        for coord in 0..MAX_TEV_TEXTURES {
            let words = &sparse[3 + coord * 9..3 + (coord + 1) * 9];
            if coord == 2 || coord == 7 {
                assert!(words.iter().any(|word| *word != 0));
            } else {
                assert_eq!(words, [0; 9]);
            }
        }
    }

    #[test]
    fn managed_sidecar_keep021_order_bases_limits_and_reset_are_exact() {
        let source = sidecar_source(4);
        let mut required = [false; MAX_TEV_TEXTURES];
        required[2] = true;
        required[7] = true;
        let first = managed_tex_coord_sidecar_record(&source, [0, 2, 1], required).unwrap();
        let second = managed_tex_coord_sidecar_record(&source, [0, 3, 2], required).unwrap();
        let coord2 = 3 + 2 * 9;
        let source_s = |vertex: usize| {
            let offset = vertex * TEV_VERTEX_FLOATS;
            (source[offset + 12 + 2 * 3] / source[offset + 3]).to_bits()
        };
        assert_eq!(
            first[coord2..coord2 + 3],
            [source_s(0), source_s(2), source_s(1)],
        );
        assert_eq!(
            second[coord2..coord2 + 3],
            [source_s(0), source_s(3), source_s(2)],
        );

        assert_eq!(managed_tex_coord_sidecar_record_base(0, 2), Some(0));
        assert_eq!(
            managed_tex_coord_sidecar_record_base(2 * MANAGED_TEX_COORD_SIDECAR_WORDS, 2),
            Some(2),
        );
        assert_eq!(
            managed_tex_coord_sidecar_record_base(0, 1),
            Some(0),
            "clearing the segment sidecar resets the first global record ID",
        );
        assert_eq!(managed_tex_coord_sidecar_record_base(1, 1), None);

        let bytes = MANAGED_TEX_COORD_SIDECAR_WORDS * size_of::<u32>();
        assert!(managed_tex_coord_sidecar_fits(0, Some(&[]), 0));
        assert!(managed_tex_coord_sidecar_fits(0, Some(&first), bytes));
        assert!(!managed_tex_coord_sidecar_fits(0, Some(&first), bytes - 1));
        assert_eq!(
            managed_sidecar_capacity_outcome(false, 0, Some(&first), bytes - 1),
            ManagedSidecarCapacityOutcome::NativeFallback,
        );
        assert_eq!(
            managed_sidecar_capacity_outcome(true, 0, Some(&first), bytes - 1),
            ManagedSidecarCapacityOutcome::RejectManagedPayload,
        );
        assert_eq!(
            managed_sidecar_capacity_outcome(true, 0, Some(&first), bytes),
            ManagedSidecarCapacityOutcome::Managed,
        );
    }

    #[test]
    fn legacy_only_segment_requires_only_draw_and_texture_bind_groups() {
        let segment = [false, false, false].map(tev_pipeline_layout_kind);

        assert_eq!(segment, [TevPipelineLayoutKind::Legacy; 3]);
        assert_eq!(
            segment.map(TevPipelineLayoutKind::required_bind_group_count),
            [2; 3],
        );
        assert!(
            segment
                .iter()
                .all(|kind| !kind.requires_managed_tex_coord_sidecar()),
        );
    }

    #[test]
    fn mixed_segment_switches_legacy_sidecar_legacy_binding_requirements() {
        let segment = [false, true, false].map(tev_pipeline_layout_kind);

        assert_eq!(
            segment,
            [
                TevPipelineLayoutKind::Legacy,
                TevPipelineLayoutKind::ManagedTexCoordSidecar,
                TevPipelineLayoutKind::Legacy,
            ],
        );
        assert_eq!(
            segment.map(TevPipelineLayoutKind::required_bind_group_count),
            [2, 3, 2],
        );
        assert_eq!(
            segment.map(TevPipelineLayoutKind::requires_managed_tex_coord_sidecar),
            [false, true, false],
        );
    }

    #[test]
    fn complete_shader_contract_carries_two_rasters_and_eight_projective_coordinates() {
        let shader = shader_source();
        assert!(shader.contains("@group(0) @binding(2) var<uniform> draw_state"));
        assert!(shader.contains("@group(1) @binding(0) var<uniform> tev_state"));
        assert!(shader.contains("@location(1) raster0: vec4<f32>"));
        assert!(shader.contains("@location(2) raster1: vec4<f32>"));
        for coord in 0..MAX_TEV_TEXTURES {
            assert!(shader.contains(&format!("stq{coord}: vec3<f32>")));
            assert!(shader.contains(&format!("input.stq{coord}")));
        }
        assert!(shader.contains("let uv = gx_projective_uv(stq)"));
        assert!(shader.contains("if stq.z == 0.0"));
        assert!(shader.contains(
            "tev_evaluate(raster_colors, managed_raster_bytes, tex_coords, managed_exact_sampler)"
        ));
        assert!(shader.contains("let source = evaluation.source"));
        assert!(shader.contains("let unorm_source = vec4<u32>("));
        assert!(shader.contains("if !alpha_test_passes(tev_alpha, draw_state.alpha_test)"));
    }
}
