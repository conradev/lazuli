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
pub(crate) const TEV_VERTEX_FLOATS: usize = 36;
pub(crate) const TEV_DRAW_STATE_BYTES: usize = 464;
pub(crate) const TEV_TEXTURE_METADATA_WORDS: usize = MAX_TEV_TEXTURES * 5;

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
    let a = f64::from(a & 0xff);
    let b = f64::from(b & 0xff);
    let c = f64::from(c & 0xff);
    let mixed = ((255.0 - c) * a + c * b + 127.0) / 255.0;
    let mut result = if combiner & (1 << 18) != 0 {
        f64::from(d) - mixed
    } else {
        f64::from(d) + mixed
    };
    match (combiner >> 16) & 3 {
        1 => result += 128.0,
        2 => result -= 128.0,
        _ => {}
    }
    match (combiner >> 20) & 3 {
        1 => result *= 2.0,
        2 => result *= 4.0,
        3 => result *= 0.5,
        _ => {}
    }

    // JavaScript Math.round, used by the boot harness reference, rounds a tie
    // toward positive infinity (including negative ties).
    clamp_result((result + 0.5).floor() as i32, combiner)
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
/// - call `tev_evaluate(raster_colors, tex_coords)` from a fragment entry point;
/// - provide post-texture-matrix STQ coordinates; sampling performs `st / q` in
///   the fragment stage so interpolation remains projective.
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
    @location(1) raster0: vec4<f32>,
    @location(2) raster1: vec4<f32>,
    @location(3) stq0: vec3<f32>,
    @location(4) stq1: vec3<f32>,
    @location(5) stq2: vec3<f32>,
    @location(6) stq3: vec3<f32>,
    @location(7) stq4: vec3<f32>,
    @location(8) stq5: vec3<f32>,
    @location(11) coverage_xy01_28_4: vec4<i32>,
    @location(12) coverage_xy2_28_4: vec2<i32>,
};

struct ManagedCoverageVertexOutput {
    @invariant @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) raster0: vec4<f32>,
    @location(1) @interpolate(flat) raster1: vec4<f32>,
    @location(2) @interpolate(flat) stq0: vec3<f32>,
    @location(3) @interpolate(flat) stq1: vec3<f32>,
    @location(4) @interpolate(flat) stq2: vec3<f32>,
    @location(5) @interpolate(flat) stq3: vec3<f32>,
    @location(6) @interpolate(flat) stq4: vec3<f32>,
    @location(7) @interpolate(flat) stq5: vec3<f32>,
    @location(10) @interpolate(flat) depth24: f32,
    @location(11) @interpolate(flat) coverage_xy01_28_4: vec4<i32>,
    @location(12) @interpolate(flat) coverage_xy2_28_4: vec2<i32>,
};

struct CanonicalDepthOutput {
    @builtin(frag_depth) depth: f32,
};

@group(0) @binding(2) var<uniform> draw_state: DrawState;

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
    output.raster0 = input.raster0;
    output.raster1 = input.raster1;
    output.stq0 = input.stq0;
    output.stq1 = input.stq1;
    output.stq2 = input.stq2;
    output.stq3 = input.stq3;
    output.stq4 = input.stq4;
    output.stq5 = input.stq5;
    output.depth24 = input.position.z;
    output.coverage_xy01_28_4 = input.coverage_xy01_28_4;
    output.coverage_xy2_28_4 = input.coverage_xy2_28_4;
    return output;
}

fn managed_coverage_tev_input(input: ManagedCoverageVertexOutput) -> TevVertexOutput {
    let sample_x_numerator = floor(input.position.x) * 12.0 + 7.0;
    let sample_y_numerator = floor(input.position.y) * 12.0 + 7.0;
    let sample_x = sample_x_numerator / 12.0;
    let sample_y = sample_y_numerator / 12.0;
    let source_x = input.stq0;
    let source_y = input.stq1;
    let inv_w = gx_managed_attribute_at_sample(
        source_x, source_y, input.stq2, sample_x, sample_y,
    );
    let s_over_w = gx_managed_attribute_at_sample(
        source_x, source_y, input.stq3, sample_x, sample_y,
    );
    let t_over_w = gx_managed_attribute_at_sample(
        source_x, source_y, input.stq4, sample_x, sample_y,
    );
    let q_over_w = gx_managed_attribute_at_sample(
        source_x, source_y, input.stq5, sample_x, sample_y,
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
    let reconstructed_stq = vec3<f32>(
        s_over_w * projection,
        t_over_w * projection,
        1.0,
    );

    var output: TevVertexOutput;
    output.position = input.position;
    output.raster0 = input.raster0;
    output.raster1 = input.raster1;
    output.stq0 = reconstructed_stq;
    output.stq1 = reconstructed_stq;
    output.stq2 = reconstructed_stq;
    output.stq3 = reconstructed_stq;
    output.stq4 = reconstructed_stq;
    output.stq5 = reconstructed_stq;
    output.stq6 = reconstructed_stq;
    output.stq7 = reconstructed_stq;
    output.depth24 = input.depth24;
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
    let point0 = input.coverage_xy01_28_4.xy;
    let point1 = input.coverage_xy01_28_4.zw;
    let point2 = input.coverage_xy2_28_4;
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

fn tev_sample_texture(map: u32, stq: vec3<f32>) -> vec4<i32> {
    // Q remains part of the interpolant until the fragment stage.
    let uv = stq.xy / stq.z;
    var sampled = vec4<f32>(1.0);
    switch map & 7u {
        case 0u: {
            sampled = textureSample(
                tev_texture0, tev_sampler0, gx_native_normalized_uv(tev_texture0, uv),
            );
        }
        case 1u: {
            sampled = textureSample(
                tev_texture1, tev_sampler1, gx_native_normalized_uv(tev_texture1, uv),
            );
        }
        case 2u: {
            sampled = textureSample(
                tev_texture2, tev_sampler2, gx_native_normalized_uv(tev_texture2, uv),
            );
        }
        case 3u: {
            sampled = textureSample(
                tev_texture3, tev_sampler3, gx_native_normalized_uv(tev_texture3, uv),
            );
        }
        case 4u: {
            sampled = textureSample(
                tev_texture4, tev_sampler4, gx_native_normalized_uv(tev_texture4, uv),
            );
        }
        case 5u: {
            sampled = textureSample(
                tev_texture5, tev_sampler5, gx_native_normalized_uv(tev_texture5, uv),
            );
        }
        case 6u: {
            sampled = textureSample(
                tev_texture6, tev_sampler6, gx_native_normalized_uv(tev_texture6, uv),
            );
        }
        case 7u: {
            sampled = textureSample(
                tev_texture7, tev_sampler7, gx_native_normalized_uv(tev_texture7, uv),
            );
        }
        default: {}
    }
    return tev_to_bytes(sampled);
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
    let a = f32(a_raw & 255);
    let b = f32(b_raw & 255);
    let c = f32(c_raw & 255);
    let mixed = ((255.0 - c) * a + c * b + 127.0) / 255.0;
    var result = f32(d);
    if (combiner & (1u << 18u)) != 0u { result -= mixed; } else { result += mixed; }
    let bias = (combiner >> 16u) & 3u;
    if bias == 1u { result += 128.0; }
    if bias == 2u { result -= 128.0; }
    let scale = (combiner >> 20u) & 3u;
    if scale == 1u { result *= 2.0; }
    if scale == 2u { result *= 4.0; }
    if scale == 3u { result *= 0.5; }
    // floor(x + .5) matches the boot harness's Math.round for negative ties.
    return tev_clamp_result(i32(floor(result + 0.5)), combiner);
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
    tex_coords: array<vec3<f32>, 8>,
) -> TevEvaluation {
    var registers = tev_state.color_registers;
    var raw_texture = vec4<i32>(0);
    var last_color_destination = 3u;
    var last_alpha_destination = 3u;
    var stage_index = 0u;
    loop {
        if stage_index >= min(tev_state.stage_count_and_padding.x, TEV_MAX_STAGES) { break; }
        let stage = tev_state.stages[stage_index];
        let texture_map = stage.refs & 7u;
        let tex_coord = (stage.refs >> 3u) & 7u;
        var texture_base = vec4<i32>(255);
        if (stage.refs & (1u << 6u)) != 0u {
            texture_base = tev_sample_texture(texture_map, tex_coords[tex_coord]);
            raw_texture = texture_base;
        }
        let texture = tev_swizzle(texture_base, (stage.alpha_combiner >> 2u) & 3u);
        let raster_channel = (stage.refs >> 7u) & 7u;
        var raster_base = vec4<i32>(0);
        if raster_channel != 7u { raster_base = tev_to_bytes(raster_colors[raster_channel]); }
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

fn tev_fragment_values(input: TevVertexOutput, needs_fragment_depth: bool) -> TevFragmentValues {
    let raster_colors = array<vec4<f32>, 8>(
        input.raster0, input.raster1,
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0),
        vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0),
    );
    let tex_coords = array<vec3<f32>, 8>(
        input.stq0, input.stq1, input.stq2, input.stq3,
        input.stq4, input.stq5, input.stq6, input.stq7,
    );
    let evaluation = tev_evaluate(raster_colors, tex_coords);
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
    let values = tev_fragment_values(input, false);
    var output: TevFragmentOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    return output;
}

@fragment
fn fs_depth_main(input: TevVertexOutput) -> TevFragmentDepthOutput {
    let values = tev_fragment_values(input, true);
    var output: TevFragmentDepthOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    let depth_encoding = (draw_state.fragment_flags >> 2u) & 7u;
    output.depth = gx_efb_depth_to_attachment(values.buffer_depth, depth_encoding);
    return output;
}

@fragment
fn fs_managed_coverage_main(input: ManagedCoverageVertexOutput) -> TevFragmentOutput {
    if !gx_managed_coverage_passes(input) {
        discard;
    }
    let values = tev_fragment_values(managed_coverage_tev_input(input), false);
    var output: TevFragmentOutput;
    output.primary = values.primary;
    output.secondary = values.secondary;
    return output;
}

@fragment
fn fs_managed_coverage_depth_main(
    input: ManagedCoverageVertexOutput,
) -> TevFragmentDepthOutput {
    if !gx_managed_coverage_passes(input) {
        discard;
    }
    let values = tev_fragment_values(managed_coverage_tev_input(input), true);
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

    fn refs(texture: u32, coord: u32, enabled: bool, raster: u32) -> u32 {
        texture | coord << 3 | u32::from(enabled) << 6 | raster << 7
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
            for negate in 0..2_u32 {
                for scale in 0..4_u32 {
                    for clamp in 0..2_u32 {
                        let combiner = bias << 16 | negate << 18 | clamp << 19 | scale << 20;
                        for index in 0..lanes.len() {
                            let a = lanes[index];
                            let b = lanes[(index + 3) % lanes.len()];
                            let c = lanes[(index + 5) % lanes.len()];
                            let d = lanes[(index + 7) % lanes.len()];
                            let a8 = f64::from(a & 255);
                            let b8 = f64::from(b & 255);
                            let c8 = f64::from(c & 255);
                            let mixed = ((255.0 - c8) * a8 + c8 * b8 + 127.0) / 255.0;
                            let sign = if negate == 0 { 1.0 } else { -1.0 };
                            let bias_value = [0.0, 128.0, -128.0][bias as usize];
                            let scale_value = [1.0, 2.0, 4.0, 0.5][scale as usize];
                            let rounded = ((f64::from(d) + sign * mixed + bias_value) * scale_value
                                + 0.5)
                                .floor() as i32;
                            let expected = if clamp == 0 {
                                rounded.clamp(-1024, 1023)
                            } else {
                                rounded.clamp(0, 255)
                            };
                            assert_eq!(evaluate_regular(a, b, c, d, combiner), expected);
                        }
                    }
                }
            }
        }
        assert_eq!(evaluate_regular(-1, 0, 0, 0, 1 << 19), 255);
        assert_eq!(evaluate_regular(0, 0, 0, -1, 0), -1);
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
    fn wgsl_contract_has_fixed_bindings_projective_sampling_and_full_stage_loop() {
        assert!(TEV_WGSL.contains("@group(1) @binding(0) var<uniform> tev_state"));
        for map in 0..MAX_TEV_TEXTURES {
            assert!(TEV_WGSL.contains(&format!("var tev_texture{map}: texture_2d<f32>")));
            assert!(TEV_WGSL.contains(&format!("var tev_sampler{map}: sampler")));
        }
        assert!(TEV_WGSL.contains("let uv = stq.xy / stq.z"));
        assert!(TEV_WGSL.contains("TEV_MAX_STAGES: u32 = 16u"));
        assert!(TEV_WGSL.contains("fn tev_color_combiner"));
        assert!(TEV_WGSL.contains("fn tev_alpha_combiner"));
        assert!(TEV_WGSL.contains("fn tev_evaluate"));
        assert!(TEV_VERTEX_WGSL.contains("input.position.z / 16777215.0"));
        assert!(!TEV_VERTEX_WGSL.contains("input.position.z / 16777216.0"));
    }

    #[test]
    fn wgsl_fragment_contract_is_strict_dual_source_webgpu() {
        let shader = shader_source();
        assert!(shader.starts_with("enable dual_source_blending;\n"));
        assert_eq!(shader.matches("enable dual_source_blending;").count(), 1);
        assert!(shader.contains(
            "struct DrawState {\n    alpha_test: u32,\n    destination_alpha: u32,\n    fragment_flags: u32,\n    z_texture: u32,\n    fog_control: vec4<u32>,"
        ));
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
    fn wgsl_native_texture_path_normalizes_texel_space_per_map() {
        let shader = shader_source();
        let native_start = shader.find("fn gx_native_normalized_uv(").unwrap();
        let native_end = shader
            .find("fn gx_managed_wrap_coord(")
            .or_else(|| shader.find("fn tev_swizzle("))
            .unwrap();
        let native = &shader[native_start..native_end];
        assert!(native.contains("let uv = stq.xy / stq.z"));
        assert!(native.contains("return texel_uv / vec2<f32>(textureDimensions(texture, 0))"));
        for map in 0..MAX_TEV_TEXTURES {
            assert!(native.contains(&format!(
                "tev_texture{map}, tev_sampler{map}, gx_native_normalized_uv(tev_texture{map}, uv)"
            )));
        }
        assert_eq!(native.matches("textureSample(").count(), MAX_TEV_TEXTURES);
        assert!(!native.contains("textureSampleLevel("));
        assert!(!native.contains("textureLoad("));
    }

    #[test]
    fn wgsl_managed_coverage_uses_exact_e3_and_leaves_native_entries_untouched() {
        let shader = shader_source();
        let native_interfaces_start = shader.find("struct TevVertexInput").unwrap();
        let managed_interfaces_start = shader.find("struct ManagedCoverageVertexInput").unwrap();
        let native_interfaces = &shader[native_interfaces_start..managed_interfaces_start];
        assert!(!native_interfaces.contains("coverage_xy"));
        assert!(shader.contains("@location(11) coverage_xy01_28_4: vec4<i32>"));
        assert!(shader.contains("@location(12) coverage_xy2_28_4: vec2<i32>"));
        assert!(shader.contains("@location(11) @interpolate(flat) coverage_xy01_28_4: vec4<i32>"));
        assert!(shader.contains("@location(12) @interpolate(flat) coverage_xy2_28_4: vec2<i32>"));
        assert!(shader.contains("input: ManagedCoverageVertexInput,"));
        assert!(shader.contains(") -> ManagedCoverageVertexOutput"));
        for location in 0..=7 {
            assert!(shader.contains(&format!("@location({location}) @interpolate(flat)")));
        }
        assert!(shader.contains("@location(10) @interpolate(flat) depth24: f32"));
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
        assert!(
            !shader[native_vertex_start..managed_vertex_start].contains("coverage_xy"),
            "the native vertex entry must retain its original interface",
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
        let coverage_test = managed
            .find("if !gx_managed_coverage_passes(input)")
            .unwrap();
        let tev = managed
            .find("let values = tev_fragment_values(managed_coverage_tev_input(input), false)")
            .unwrap();
        assert!(coverage_test < tev);
        assert!(managed.contains("fn fs_managed_coverage_depth_main"));
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
            .find("let evaluation = tev_evaluate(raster_colors, tex_coords)")
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
        let sample = shader
            .find("texture_base = tev_sample_texture(texture_map, tex_coords[tex_coord])")
            .unwrap();
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
        assert!(shader.contains("let values = tev_fragment_values(input, false)"));
        assert!(shader.contains("let values = tev_fragment_values(input, true)"));
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
        assert!(shader.contains("let uv = stq.xy / stq.z"));
        assert!(shader.contains("let evaluation = tev_evaluate(raster_colors, tex_coords)"));
        assert!(shader.contains("let source = evaluation.source"));
        assert!(shader.contains("let unorm_source = vec4<u32>("));
        assert!(shader.contains("if !alpha_test_passes(tev_alpha, draw_state.alpha_test)"));
    }
}
