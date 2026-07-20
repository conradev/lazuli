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
    let mut last_color_destination = 3;
    let mut last_alpha_destination = 3;

    for stage in state
        .stages
        .iter()
        .copied()
        .take((state.stage_count as usize).min(MAX_TEV_STAGES))
    {
        let texture_base = if stage.texture_enabled() {
            inputs.textures[stage.texture_map()]
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
