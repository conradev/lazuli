#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use std::ops::Range;
use std::sync::{Arc, Mutex};

pub(crate) mod packet;
pub(crate) mod tev;

pub(crate) const EFB_WIDTH: u32 = 640;
pub(crate) const EFB_HEIGHT: u32 = 528;
pub(crate) const GX_MAX_COPY_DIMENSION: u32 = 1024;
pub(crate) const WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT: u32 = 256;
pub(crate) const GX_DEPTH24_MAX: u32 = 0x00ff_ffff;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RendererMetrics {
    pub(crate) begin_segment_calls: u64,
    pub(crate) bind_groups_created: u64,
    pub(crate) buffers_created: u64,
    pub(crate) check_health_calls: u64,
    pub(crate) clear_efb_calls: u64,
    pub(crate) copy_texture_calls: u64,
    pub(crate) copy_xfb_calls: u64,
    pub(crate) decoded_texture_queries: u64,
    pub(crate) drain_calls: u64,
    pub(crate) expanded_vertex_bytes: u64,
    pub(crate) gx_frame_packet_bytes: u64,
    pub(crate) gx_frame_packet_payload_bytes: u64,
    pub(crate) present_xfb_calls: u64,
    pub(crate) push_tev_draw_calls: u64,
    pub(crate) queue_submissions: u64,
    pub(crate) render_pipelines_created: u64,
    pub(crate) source_vertex_bytes: u64,
    pub(crate) tev_state_bytes: u64,
    pub(crate) texture_metadata_bytes: u64,
    pub(crate) texture_pixel_bytes: u64,
    pub(crate) texture_upload_bytes: u64,
    pub(crate) texture_writes: u64,
    pub(crate) textures_created: u64,
    pub(crate) submit_gx_frame_calls: u64,
    pub(crate) wasm_bridge_calls: u64,
    pub(crate) wasm_bridge_typed_array_bytes: u64,
}

impl RendererMetrics {
    pub(crate) fn record_wasm_bridge_call(&mut self, typed_array_bytes: usize) {
        self.wasm_bridge_calls = self.wasm_bridge_calls.saturating_add(1);
        self.wasm_bridge_typed_array_bytes = self
            .wasm_bridge_typed_array_bytes
            .saturating_add(typed_array_bytes as u64);
    }

    pub(crate) fn record_draw_transport(
        &mut self,
        source_vertex_bytes: usize,
        tev_state_bytes: usize,
        texture_metadata_bytes: usize,
        texture_pixel_bytes: usize,
        expanded_vertex_bytes: usize,
    ) {
        self.push_tev_draw_calls = self.push_tev_draw_calls.saturating_add(1);
        self.source_vertex_bytes = self
            .source_vertex_bytes
            .saturating_add(source_vertex_bytes as u64);
        self.tev_state_bytes = self.tev_state_bytes.saturating_add(tev_state_bytes as u64);
        self.texture_metadata_bytes = self
            .texture_metadata_bytes
            .saturating_add(texture_metadata_bytes as u64);
        self.texture_pixel_bytes = self
            .texture_pixel_bytes
            .saturating_add(texture_pixel_bytes as u64);
        self.expanded_vertex_bytes = self
            .expanded_vertex_bytes
            .saturating_add(expanded_vertex_bytes as u64);
    }
}

#[derive(Clone, Default)]
pub(crate) struct RendererFailureState {
    failure: Arc<Mutex<Option<String>>>,
}

impl RendererFailureState {
    pub(crate) fn record(&self, failure: String) {
        let mut current = self
            .failure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if current.is_none() {
            *current = Some(failure);
        }
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum TextureBindingIdentity {
    White,
    Decoded(String),
    EfbCopy { address: u32, generation: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum TextureAddressMode {
    ClampToEdge,
    Repeat,
    MirrorRepeat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct SamplerIdentity {
    pub(crate) mag_filter: bool,
    pub(crate) min_filter: bool,
    pub(crate) address_u: TextureAddressMode,
    pub(crate) address_v: TextureAddressMode,
}

pub(crate) fn gx_sampler_identity(mode0: u32) -> SamplerIdentity {
    let address_mode = |value| match value & 3 {
        1 => TextureAddressMode::Repeat,
        2 => TextureAddressMode::MirrorRepeat,
        // GX treats the reserved wrap value three as clamp.
        _ => TextureAddressMode::ClampToEdge,
    };
    SamplerIdentity {
        mag_filter: mode0 & (1 << 4) != 0,
        min_filter: mode0 & (1 << 7) != 0,
        address_u: address_mode(mode0),
        address_v: address_mode(mode0 >> 2),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SelectedTexture {
    EfbCopy,
    Decoded,
    White,
}

pub(crate) fn select_texture(
    requested_generation: u32,
    cached_generation: Option<u32>,
    decoded_is_valid: bool,
) -> SelectedTexture {
    if requested_generation != 0 && cached_generation == Some(requested_generation) {
        SelectedTexture::EfbCopy
    } else if decoded_is_valid {
        SelectedTexture::Decoded
    } else {
        SelectedTexture::White
    }
}

pub(crate) fn require_tev_texture(
    map: usize,
    required: bool,
    selected: SelectedTexture,
) -> Result<SelectedTexture, String> {
    if required && selected == SelectedTexture::White {
        Err(format!(
            "TEV texture map {map} is enabled but has neither valid decoded pixels nor a matching EFB generation"
        ))
    } else {
        Ok(selected)
    }
}

pub(crate) fn rgba8_texture_byte_len(width: u32, height: u32) -> Option<usize> {
    let width = usize::try_from(width).ok()?;
    let height = usize::try_from(height).ok()?;
    width.checked_mul(height)?.checked_mul(4)
}

pub(crate) fn valid_rgba8_texture(width: u32, height: u32, byte_len: usize) -> bool {
    width != 0
        && height != 0
        && rgba8_texture_byte_len(width, height).is_some_and(|expected| expected == byte_len)
}

pub(crate) fn decoded_texture_cache_hit(
    width: u32,
    height: u32,
    cached_dimensions: Option<(u32, u32)>,
) -> bool {
    cached_dimensions == Some((width, height))
}

pub(crate) fn decoded_texture_is_available(
    width: u32,
    height: u32,
    byte_len: usize,
    cached_dimensions: Option<(u32, u32)>,
) -> Result<bool, String> {
    if let Some((cached_width, cached_height)) = cached_dimensions {
        if (cached_width, cached_height) != (width, height) {
            return Err(format!(
                "cached RGBA8 texture is {cached_width}x{cached_height}, but the draw requests {width}x{height}"
            ));
        }
        if byte_len == 0 || valid_rgba8_texture(width, height, byte_len) {
            return Ok(true);
        }
    } else if byte_len == 0 {
        return Ok(false);
    } else if valid_rgba8_texture(width, height, byte_len) {
        return Ok(true);
    }

    let expected = rgba8_texture_byte_len(width, height).map_or_else(
        || "an unrepresentable number of".to_owned(),
        |bytes| bytes.to_string(),
    );
    Err(format!(
        "invalid RGBA8 texture {width}x{height}: expected {expected} bytes, got {byte_len}"
    ))
}

pub(crate) fn clipped_copy_extent(
    source_x: u32,
    source_y: u32,
    width: u32,
    height: u32,
) -> Option<(u32, u32)> {
    let available_width = EFB_WIDTH.checked_sub(source_x)?;
    let available_height = EFB_HEIGHT.checked_sub(source_y)?;
    let width = width.min(available_width);
    let height = height.min(available_height);
    (width != 0 && height != 0).then_some((width, height))
}

#[cfg(any(test, not(target_arch = "wasm32")))]
pub(crate) const GX_COPY_FILTER_DIVISOR: u32 = 64;

// GX's seven vertical copy taps all address the current row when taps two,
// three, and four are used.  This is the canonical neutral filter used by the
// legacy public bridge, whose argument list predates transport of the raw BP
// copy-filter registers.
pub(crate) const GX_IDENTITY_COPY_FILTER: [u32; 2] = [(21 << 12) | (22 << 18), 21];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxCopyGamma {
    Gamma1_0,
    Gamma1_7,
    Gamma2_2,
}

impl GxCopyGamma {
    pub(crate) const fn from_copy_command(copy_command: u32) -> Self {
        match (copy_command >> 7) & 3 {
            0 => Self::Gamma1_0,
            1 => Self::Gamma1_7,
            // Hardware testing shows the reserved value three behaves as 2.2.
            _ => Self::Gamma2_2,
        }
    }

    pub(crate) fn reciprocal(self) -> f32 {
        match self {
            Self::Gamma1_0 => 1.0,
            Self::Gamma1_7 => 1.0 / 1.7,
            Self::Gamma2_2 => 1.0 / 2.2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxXfbCopyParameters {
    pub(crate) filter_taps: [u8; 7],
    pub(crate) filter_coefficients: [u32; 3],
    pub(crate) gamma: GxCopyGamma,
    pub(crate) clamp_top: bool,
    pub(crate) clamp_bottom: bool,
    pub(crate) scale_invert: bool,
    pub(crate) copy_scale: u32,
    pub(crate) source_format: GxEfbFormat,
}

impl GxXfbCopyParameters {
    pub(crate) const fn uses_linear_filter(self) -> bool {
        if self.scale_invert {
            self.copy_scale < 256
        } else {
            self.copy_scale > 256
        }
    }

    pub(crate) fn y_scale_reciprocal(self) -> f32 {
        if self.scale_invert {
            self.copy_scale.max(1) as f32 / 256.0
        } else {
            256.0 / self.copy_scale.max(1) as f32
        }
    }
}

pub(crate) fn gx_copy_filter_taps(copy_filter: [u32; 2]) -> [u8; 7] {
    let low = copy_filter[0];
    let high = copy_filter[1];
    [
        (low & 0x3f) as u8,
        ((low >> 6) & 0x3f) as u8,
        ((low >> 12) & 0x3f) as u8,
        ((low >> 18) & 0x3f) as u8,
        (high & 0x3f) as u8,
        ((high >> 6) & 0x3f) as u8,
        ((high >> 12) & 0x3f) as u8,
    ]
}

pub(crate) fn gx_copy_filter_coefficients(taps: [u8; 7]) -> [u32; 3] {
    // The seven programmed coefficients do not select seven distinct source
    // rows: GX applies taps 0/1 to the preceding row, 2/3/4 to the current
    // row, and 5/6 to the following row, then performs one fixed-point divide.
    // Combining within those groups is therefore algebraically lossless.
    [
        u32::from(taps[0]) + u32::from(taps[1]),
        u32::from(taps[2]) + u32::from(taps[3]) + u32::from(taps[4]),
        u32::from(taps[5]) + u32::from(taps[6]),
    ]
}

pub(crate) fn gx_xfb_copy_parameters(state: packet::GxCopyState) -> GxXfbCopyParameters {
    let filter_taps = gx_copy_filter_taps(state.copy_filter);
    GxXfbCopyParameters {
        filter_taps,
        filter_coefficients: gx_copy_filter_coefficients(filter_taps),
        gamma: GxCopyGamma::from_copy_command(state.copy_command),
        clamp_top: state.copy_command & 1 != 0,
        clamp_bottom: state.copy_command & 2 != 0,
        scale_invert: state.copy_command & (1 << 10) != 0,
        copy_scale: state.copy_scale,
        source_format: gx_efb_format(state.pixel_control),
    }
}

pub(crate) fn gx_xfb_output_height(
    source_height: u32,
    copy_command: u32,
    copy_scale: u32,
) -> Option<u32> {
    let source_intervals = u64::from(source_height.checked_sub(1)?);
    let scaled_intervals = if copy_command & (1 << 10) != 0 {
        source_intervals * 256 / u64::from(copy_scale.max(1))
    } else {
        source_intervals * u64::from(copy_scale) / 256
    };
    // BP scaling is a fixed-point ratio. Evaluate it as an exact integer
    // quotient so producer and consumer cannot disagree at a floating-point
    // operation-order boundary (for example H=148, inverse raw=49 is 769, not
    // 768). libogc's __GX_GetNumXfbLines also clamps the result to 1024. Keep
    // that GX/libogc protocol-safety bound for direct BP writes too, an
    // intentional extreme-scale divergence from Dolphin's current path.
    Some(
        u32::try_from(scaled_intervals.saturating_add(1))
            .unwrap_or(u32::MAX)
            .min(GX_MAX_COPY_DIMENSION),
    )
}

#[cfg(any(test, not(target_arch = "wasm32")))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MaterializedXfbRgba8 {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Vec<u8>,
}

#[cfg(any(test, not(target_arch = "wasm32")))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn materialize_xfb_rgba8_reference(
    efb_pixels: &[u8],
    efb_width: u32,
    efb_height: u32,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    output_width: u32,
    state: packet::GxCopyState,
) -> Option<MaterializedXfbRgba8> {
    if output_width == 0
        || output_width > GX_MAX_COPY_DIMENSION
        || source_width == 0
        || source_height == 0
        || source_x.checked_add(source_width)? > efb_width
        || source_y.checked_add(source_height)? > efb_height
        || rgba8_texture_byte_len(efb_width, efb_height)? != efb_pixels.len()
    {
        return None;
    }
    let output_height = gx_xfb_output_height(source_height, state.copy_command, state.copy_scale)?;
    let output_bytes = rgba8_texture_byte_len(output_width, output_height)?;
    let parameters = gx_xfb_copy_parameters(state);
    if !matches!(
        parameters.source_format,
        GxEfbFormat::Rgb8Z24 | GxEfbFormat::Rgba6Z24 | GxEfbFormat::Rgb565Z16
    ) {
        // A color-texture sample cannot stand in for the EFB depth plane. Keep
        // Z24 and untransported YUV/component formats fail-closed until the
        // WebGPU depth-copy pipeline is bound explicitly.
        return None;
    }
    let linear = parameters.uses_linear_filter();
    let mut pixels = Vec::with_capacity(output_bytes);
    let min_y = if parameters.clamp_top { source_y } else { 0 };
    let max_y = if parameters.clamp_bottom {
        source_y + source_height - 1
    } else {
        efb_height - 1
    };

    for output_y in 0..output_height {
        // GX applies the BP y-scale to the sample coordinate itself. The
        // rounded output height only bounds the destination rows; deriving a
        // second ratio from source_height/output_height produces a different
        // phase and spacing for every non-integral scale.
        let source_pixel_y = (f64::from(output_y) + 0.5 + f64::from(source_y))
            * f64::from(parameters.y_scale_reciprocal())
            - 0.5;
        for output_x in 0..output_width {
            let source_pixel_x = f64::from(source_x)
                + (f64::from(output_x) + 0.5) * f64::from(source_width) / f64::from(output_width)
                - 0.5;
            let sample = |row_offset: f64| {
                quantize_efb_sample_reference(
                    sample_rgba8_reference(
                        efb_pixels,
                        efb_width,
                        source_pixel_x,
                        source_pixel_y + row_offset,
                        min_y,
                        max_y,
                        linear,
                    ),
                    parameters.source_format,
                )
            };
            let previous = sample(-1.0);
            let current = sample(0.0);
            let next = sample(1.0);
            let mut rgba = [0_u8; 4];
            let coefficient_sum = parameters.filter_coefficients.iter().sum::<u32>();
            for channel in 0..3 {
                let combined = u32::from(previous[channel]) * parameters.filter_coefficients[0]
                    + u32::from(current[channel]) * parameters.filter_coefficients[1]
                    + u32::from(next[channel]) * parameters.filter_coefficients[2];
                let mut value = combined / GX_COPY_FILTER_DIVISOR;
                if coefficient_sum >= 128 {
                    value &= 0x1ff;
                }
                value = value.min(255);
                rgba[channel] = apply_copy_gamma(value as u8, parameters.gamma);
            }
            // A materialized XFB is RGB8 regardless of the EFB's native color
            // format. RGBA6 alpha participates in native conversion but never
            // survives into the final XFB surface.
            rgba[3] = 0xff;
            pixels.extend_from_slice(&rgba);
        }
    }

    Some(MaterializedXfbRgba8 {
        width: output_width,
        height: output_height,
        pixels,
    })
}

#[cfg(any(test, not(target_arch = "wasm32")))]
#[allow(clippy::too_many_arguments)]
fn sample_rgba8_reference(
    pixels: &[u8],
    width: u32,
    x: f64,
    y: f64,
    min_y: u32,
    max_y: u32,
    linear: bool,
) -> [f64; 4] {
    let x = x.clamp(0.0, f64::from(width - 1));
    let y = y.clamp(f64::from(min_y), f64::from(max_y));
    if !linear {
        return rgba8_texel(
            pixels,
            width,
            (x + 0.5).floor() as u32,
            (y + 0.5).floor() as u32,
        )
        .map(f64::from);
    }

    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = x0.saturating_add(1).min(width - 1);
    let y1 = y0.saturating_add(1).min(max_y);
    let x_weight = x - f64::from(x0);
    let y_weight = y - f64::from(y0);
    let rows = [
        rgba8_texel(pixels, width, x0, y0),
        rgba8_texel(pixels, width, x1, y0),
        rgba8_texel(pixels, width, x0, y1),
        rgba8_texel(pixels, width, x1, y1),
    ];
    std::array::from_fn(|channel| {
        let top =
            f64::from(rows[0][channel]) * (1.0 - x_weight) + f64::from(rows[1][channel]) * x_weight;
        let bottom =
            f64::from(rows[2][channel]) * (1.0 - x_weight) + f64::from(rows[3][channel]) * x_weight;
        top * (1.0 - y_weight) + bottom * y_weight
    })
}

#[cfg(any(test, not(target_arch = "wasm32")))]
fn quantize_efb_sample_reference(sample: [f64; 4], format: GxEfbFormat) -> [u8; 4] {
    let truncated = sample.map(|channel| channel.clamp(0.0, 255.0) as u8);
    let rounded = sample.map(round_ties_even_u8);
    match format {
        GxEfbFormat::Rgb8Z24 => [truncated[0], truncated[1], truncated[2], 0xff],
        GxEfbFormat::Rgba6Z24 => rounded.map(expand_6_to_8),
        GxEfbFormat::Rgb565Z16 => [
            expand_5_to_8(rounded[0]),
            expand_6_to_8(rounded[1]),
            expand_5_to_8(rounded[2]),
            0xff,
        ],
        GxEfbFormat::Z24 | GxEfbFormat::OtherNoAlpha => {
            unreachable!("unsupported XFB source format is rejected before sampling")
        }
    }
}

#[cfg(any(test, not(target_arch = "wasm32")))]
fn round_ties_even_u8(value: f64) -> u8 {
    let value = value.clamp(0.0, 255.0);
    let lower = value.floor();
    let fraction = value - lower;
    let exact_half = fraction.to_bits() == 0.5_f64.to_bits();
    let increment = fraction > 0.5 || (exact_half && lower as u8 & 1 != 0);
    lower as u8 + u8::from(increment)
}

#[cfg(any(test, not(target_arch = "wasm32")))]
fn rgba8_texel(pixels: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let start = ((y as usize * width as usize) + x as usize) * 4;
    pixels[start..start + 4]
        .try_into()
        .expect("validated tight RGBA8 reference image")
}

#[cfg(any(test, not(target_arch = "wasm32")))]
fn apply_copy_gamma(value: u8, gamma: GxCopyGamma) -> u8 {
    if gamma == GxCopyGamma::Gamma1_0 {
        return value;
    }
    ((f32::from(value) / 255.0).powf(gamma.reciprocal()) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxEfbFormat {
    Rgb8Z24,
    Rgba6Z24,
    Rgb565Z16,
    Z24,
    OtherNoAlpha,
}

impl GxEfbFormat {
    fn has_alpha(self) -> bool {
        matches!(self, Self::Rgba6Z24)
    }
}

pub(crate) fn gx_efb_format(pixel_control: u32) -> GxEfbFormat {
    match pixel_control & 7 {
        0 => GxEfbFormat::Rgb8Z24,
        1 => GxEfbFormat::Rgba6Z24,
        2 => GxEfbFormat::Rgb565Z16,
        3 => GxEfbFormat::Z24,
        // Raw format 4 multiplexes Y/U/V through PE CMode1, which LZGX does
        // not transport yet; raw 5 is YUV420 and 6/7 are reserved. Keep the
        // whole unmodeled tail explicitly conservative until that state is
        // available rather than pretending pixel_control can distinguish it.
        _ => GxEfbFormat::OtherNoAlpha,
    }
}

const fn expand_5_to_8(channel: u8) -> u8 {
    (channel & 0xf8) | (channel >> 5)
}

const fn expand_6_to_8(channel: u8) -> u8 {
    (channel & 0xfc) | (channel >> 6)
}

pub(crate) fn gx_copy_clear_rgba(pixel_control: u32, rgba: [u8; 4]) -> [u8; 4] {
    match gx_efb_format(pixel_control) {
        GxEfbFormat::Rgba6Z24 => rgba.map(expand_6_to_8),
        GxEfbFormat::Rgb565Z16 => [
            expand_5_to_8(rgba[0]),
            expand_6_to_8(rgba[1]),
            expand_5_to_8(rgba[2]),
            0xff,
        ],
        // This is the canonical no-alpha host representation. Component/YUV
        // conversion remains deliberately unmodeled until PE CMode1 arrives.
        _ => [rgba[0], rgba[1], rgba[2], 0xff],
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct GxCopyClearMask {
    pub(crate) color: bool,
    pub(crate) alpha: bool,
    pub(crate) depth: bool,
}

impl GxCopyClearMask {
    pub(crate) fn index(self) -> usize {
        usize::from(self.color) | (usize::from(self.alpha) << 1) | (usize::from(self.depth) << 2)
    }

    pub(crate) fn from_index(index: usize) -> Self {
        Self {
            color: index & 1 != 0,
            alpha: index & 2 != 0,
            depth: index & 4 != 0,
        }
    }

    pub(crate) fn writes_anything(self) -> bool {
        self.color || self.alpha || self.depth
    }
}

pub(crate) fn gx_copy_clear_mask(
    z_mode: u32,
    blend_mode: u32,
    pixel_control: u32,
) -> GxCopyClearMask {
    let color = blend_mode & (1 << 3) != 0;
    let depth = z_mode & (1 << 4) != 0;
    let alpha = if gx_efb_format(pixel_control).has_alpha() {
        blend_mode & (1 << 4) != 0
    } else {
        // Only RGBA6 has guest alpha. Whenever a real clear touches a no-alpha
        // pixel, keep the RGBA8 host representation canonically opaque.
        color || depth
    };
    GxCopyClearMask {
        color,
        alpha,
        depth,
    }
}

pub(crate) fn gx_depth24_to_float(depth: u32) -> f32 {
    (depth & GX_DEPTH24_MAX) as f32 / GX_DEPTH24_MAX as f32
}

pub(crate) fn gx_float_to_depth24(depth: f32) -> u32 {
    (depth.clamp(0.0, 1.0) * GX_DEPTH24_MAX as f32).round() as u32
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxBlendFactor {
    Zero,
    One,
    Source,
    OneMinusSource,
    SourceAlpha,
    OneMinusSourceAlpha,
    Destination,
    OneMinusDestination,
    DestinationAlpha,
    OneMinusDestinationAlpha,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxBlendOperation {
    Add,
    ReverseSubtract,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxBlendState {
    pub enabled: bool,
    pub source: GxBlendFactor,
    pub destination: GxBlendFactor,
    pub operation: GxBlendOperation,
    pub color_write: bool,
    pub alpha_write: bool,
}

pub(crate) fn gx_blend_state(blend_mode: u32) -> GxBlendState {
    let blend_enabled = blend_mode & 1 != 0;
    let logic_enabled = blend_mode & (1 << 1) != 0;
    let (source, destination, operation) = if logic_enabled {
        logic_blend_approx(((blend_mode >> 12) & 0xf) as u8)
    } else if !blend_enabled {
        (
            GxBlendFactor::One,
            GxBlendFactor::Zero,
            GxBlendOperation::Add,
        )
    } else if blend_mode & (1 << 11) != 0 {
        (
            GxBlendFactor::One,
            GxBlendFactor::One,
            GxBlendOperation::ReverseSubtract,
        )
    } else {
        (
            source_blend_factor(((blend_mode >> 8) & 7) as u8),
            destination_blend_factor(((blend_mode >> 5) & 7) as u8),
            GxBlendOperation::Add,
        )
    };

    GxBlendState {
        enabled: blend_enabled || logic_enabled,
        source,
        destination,
        operation,
        color_write: blend_mode & (1 << 3) != 0,
        alpha_write: blend_mode & (1 << 4) != 0,
    }
}

fn source_blend_factor(value: u8) -> GxBlendFactor {
    match value & 7 {
        0 => GxBlendFactor::Zero,
        1 => GxBlendFactor::One,
        2 => GxBlendFactor::Destination,
        3 => GxBlendFactor::OneMinusDestination,
        4 => GxBlendFactor::SourceAlpha,
        5 => GxBlendFactor::OneMinusSourceAlpha,
        6 => GxBlendFactor::DestinationAlpha,
        _ => GxBlendFactor::OneMinusDestinationAlpha,
    }
}

fn destination_blend_factor(value: u8) -> GxBlendFactor {
    match value & 7 {
        0 => GxBlendFactor::Zero,
        1 => GxBlendFactor::One,
        2 => GxBlendFactor::Source,
        3 => GxBlendFactor::OneMinusSource,
        4 => GxBlendFactor::SourceAlpha,
        5 => GxBlendFactor::OneMinusSourceAlpha,
        6 => GxBlendFactor::DestinationAlpha,
        _ => GxBlendFactor::OneMinusDestinationAlpha,
    }
}

fn logic_blend_approx(value: u8) -> (GxBlendFactor, GxBlendFactor, GxBlendOperation) {
    use {GxBlendFactor as Factor, GxBlendOperation as Operation};

    match value & 0xf {
        0x0 => (Factor::Zero, Factor::Zero, Operation::Add),
        0x1 => (Factor::Zero, Factor::Source, Operation::Add),
        0x2 => (Factor::OneMinusSource, Factor::Zero, Operation::Add),
        0x3 => (Factor::One, Factor::Zero, Operation::Add),
        0x4 => (Factor::Zero, Factor::OneMinusSource, Operation::Add),
        0x5 => (Factor::Zero, Factor::One, Operation::Add),
        0x6 => (
            Factor::OneMinusDestination,
            Factor::OneMinusSource,
            Operation::Add,
        ),
        0x7 => (Factor::One, Factor::OneMinusSource, Operation::Add),
        0x8 => (
            Factor::OneMinusSource,
            Factor::OneMinusDestination,
            Operation::Add,
        ),
        0x9 => (Factor::OneMinusSource, Factor::Source, Operation::Add),
        0xa => (
            Factor::OneMinusDestination,
            Factor::OneMinusDestination,
            Operation::Add,
        ),
        0xb => (Factor::One, Factor::OneMinusDestination, Operation::Add),
        0xc => (
            Factor::OneMinusSource,
            Factor::OneMinusSource,
            Operation::Add,
        ),
        0xd => (Factor::OneMinusSource, Factor::One, Operation::Add),
        0xe => (
            Factor::OneMinusDestination,
            Factor::OneMinusSource,
            Operation::Add,
        ),
        _ => (Factor::One, Factor::One, Operation::Add),
    }
}

pub(crate) fn merge_contiguous_draw_range<State: PartialEq>(
    previous_range: &mut Range<u32>,
    previous_state: &State,
    next_range: Range<u32>,
    next_state: &State,
) -> bool {
    if previous_state != next_state
        || previous_range.start >= previous_range.end
        || previous_range.end != next_range.start
        || next_range.start >= next_range.end
    {
        return false;
    }

    previous_range.end = next_range.end;
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct XfbCopyMetadata {
    pub destination: u32,
    pub stride: u32,
    pub height: u32,
    pub generation: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct XfbScanoutPlan {
    pub(crate) selected_row: u32,
    pub(crate) field_stride_bytes: u32,
    pub(crate) source_row_step: u32,
    pub(crate) field_height: u32,
    pub(crate) row_repeat: u32,
    pub(crate) display_height: u32,
}

// TFBL/BFBL may select adjacent scanlines of one retained XFB.  Larger
// address deltas can also look like rows of an unrelated double buffer; a
// texture-only presentation cannot represent those aliases safely.
const MAX_XFB_FIELD_ROW_OFFSET: u32 = 1;

pub(crate) fn xfb_row_offset(copy: XfbCopyMetadata, address: u32) -> Option<u32> {
    let delta = address.checked_sub(copy.destination)?;
    if copy.stride == 0 || delta % copy.stride != 0 {
        return (delta == 0).then_some(0);
    }

    let row = delta / copy.stride;
    (row < copy.height).then_some(row)
}

pub(crate) fn xfb_copy_matches_selection(
    copy: XfbCopyMetadata,
    address: u32,
    generation: u32,
    row: u32,
) -> bool {
    generation != 0
        && copy.generation == generation
        && row <= MAX_XFB_FIELD_ROW_OFFSET
        && xfb_row_offset(copy, address) == Some(row)
}

pub(crate) fn xfb_scanout_plan(
    copy: XfbCopyMetadata,
    selected_row: u32,
    field_stride_bytes: u32,
    field_height: u32,
    row_repeat: u32,
    display_height: u32,
) -> Option<XfbScanoutPlan> {
    if copy.stride == 0
        || field_stride_bytes == 0
        || field_stride_bytes % copy.stride != 0
        || field_height == 0
        || !matches!(row_repeat, 1 | 2)
        || display_height != field_height.checked_mul(row_repeat)?
    {
        return None;
    }
    let source_row_step = field_stride_bytes / copy.stride;
    if source_row_step == 0 {
        return None;
    }
    let last_source_row =
        selected_row.checked_add(field_height.checked_sub(1)?.checked_mul(source_row_step)?)?;
    if last_source_row >= copy.height {
        return None;
    }
    Some(XfbScanoutPlan {
        selected_row,
        field_stride_bytes,
        source_row_step,
        field_height,
        row_repeat,
        display_height,
    })
}

pub(crate) fn xfb_scanout_source_row(plan: XfbScanoutPlan, output_row: u32) -> Option<u32> {
    if output_row >= plan.display_height {
        return None;
    }
    plan.selected_row.checked_add(
        output_row
            .checked_div(plan.row_repeat)?
            .checked_mul(plan.source_row_step)?,
    )
}

pub(crate) const fn xfb_surface_extent_matches(
    cached_width: u32,
    cached_height: u32,
    width: u32,
    height: u32,
) -> bool {
    cached_width == width && cached_height == height
}

pub(crate) fn reusable_xfb_surface_index(
    surfaces: &[(u64, u32, u32)],
    protected_surface: Option<u64>,
    width: u32,
    height: u32,
) -> Option<usize> {
    surfaces
        .iter()
        .position(|(surface, cached_width, cached_height)| {
            Some(*surface) != protected_surface
                && xfb_surface_extent_matches(*cached_width, *cached_height, width, height)
        })
}

#[cfg(test)]
pub(crate) fn resolve_xfb_copy(copies: &[XfbCopyMetadata], address: u32) -> Option<(usize, u32)> {
    copies
        .iter()
        .enumerate()
        .filter(|(_, copy)| copy.destination == address)
        .max_by_key(|(_, copy)| copy.generation)
        .map(|(index, _)| (index, 0))
        .or_else(|| {
            copies
                .iter()
                .copied()
                .enumerate()
                .filter_map(|(index, copy)| {
                    xfb_row_offset(copy, address).map(|row| (index, row, copy.generation))
                })
                .filter(|(_, row, _)| *row <= MAX_XFB_FIELD_ROW_OFFSET)
                .max_by_key(|(_, _, generation)| *generation)
                .map(|(index, row, _)| (index, row))
        })
}

pub(crate) fn xfb_source_rect(row: u32, height: u32) -> Option<[f32; 4]> {
    if height == 0 || row > MAX_XFB_FIELD_ROW_OFFSET || row >= height {
        return None;
    }

    // Retained for the legacy WebGPU presenter until the exact integer VI
    // scanout plan is activated by the renderer layer.
    let start_y = row as f32 / height as f32;
    Some([0.0, start_y, 1.0, 1.0 - start_y])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct XfbReadbackLayout {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) source_row: u32,
    pub(crate) bytes_per_row: u32,
    pub(crate) padded_bytes_per_row: u32,
    pub(crate) buffer_bytes: u64,
}

pub(crate) fn xfb_readback_layout(
    width: u32,
    source_height: u32,
    logical_height: u32,
    selected_row: u32,
) -> Option<XfbReadbackLayout> {
    if width == 0 || source_height == 0 || logical_height == 0 || selected_row >= logical_height {
        return None;
    }
    let source_row = u32::try_from(
        u64::from(selected_row).checked_mul(u64::from(source_height))? / u64::from(logical_height),
    )
    .ok()?;
    let height = source_height.checked_sub(source_row)?;
    if height == 0 {
        return None;
    }
    let bytes_per_row = width.checked_mul(4)?;
    let padded_bytes_per_row = bytes_per_row
        .checked_add(WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT - 1)?
        .checked_div(WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT)?
        .checked_mul(WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT)?;
    let buffer_bytes = u64::from(padded_bytes_per_row).checked_mul(u64::from(height))?;
    Some(XfbReadbackLayout {
        width,
        height,
        source_row,
        bytes_per_row,
        padded_bytes_per_row,
        buffer_bytes,
    })
}

pub(crate) fn compact_xfb_readback_rows(
    mapped: &[u8],
    layout: XfbReadbackLayout,
) -> Option<Vec<u8>> {
    let padded_bytes_per_row = usize::try_from(layout.padded_bytes_per_row).ok()?;
    let bytes_per_row = usize::try_from(layout.bytes_per_row).ok()?;
    let height = usize::try_from(layout.height).ok()?;
    let required = padded_bytes_per_row.checked_mul(height)?;
    if mapped.len() < required {
        return None;
    }
    let output_bytes = bytes_per_row.checked_mul(height)?;
    let mut output = Vec::with_capacity(output_bytes);
    for row in 0..height {
        let start = row.checked_mul(padded_bytes_per_row)?;
        output.extend_from_slice(mapped.get(start..start.checked_add(bytes_per_row)?)?);
    }
    Some(output)
}

pub(crate) fn compact_xfb_scanout_rows(
    mapped: &[u8],
    layout: XfbReadbackLayout,
    logical_height: u32,
    plan: XfbScanoutPlan,
) -> Option<Vec<u8>> {
    if layout.source_row != 0
        || layout.height == 0
        || logical_height == 0
        || plan.display_height == 0
    {
        return None;
    }
    let padded_bytes_per_row = usize::try_from(layout.padded_bytes_per_row).ok()?;
    let bytes_per_row = usize::try_from(layout.bytes_per_row).ok()?;
    let required = padded_bytes_per_row.checked_mul(usize::try_from(layout.height).ok()?)?;
    if mapped.len() < required {
        return None;
    }
    let mut output =
        Vec::with_capacity(bytes_per_row.checked_mul(usize::try_from(plan.display_height).ok()?)?);
    for output_row in 0..plan.display_height {
        let logical_row = xfb_scanout_source_row(plan, output_row)?;
        if logical_row >= logical_height {
            return None;
        }
        let physical_row = u32::try_from(
            u64::from(logical_row).checked_mul(u64::from(layout.height))?
                / u64::from(logical_height),
        )
        .ok()?;
        let start = usize::try_from(physical_row)
            .ok()?
            .checked_mul(padded_bytes_per_row)?;
        output.extend_from_slice(mapped.get(start..start.checked_add(bytes_per_row)?)?);
    }
    Some(output)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SurfacePixelOrder {
    Rgba8,
    Bgra8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SurfaceReadbackRequestError {
    FormatUnsupported,
    InvalidDimensions,
}

pub(crate) fn requested_surface_readback_layout(
    requested: bool,
    pixel_order: Option<SurfacePixelOrder>,
    width: u32,
    height: u32,
) -> Result<Option<(XfbReadbackLayout, SurfacePixelOrder)>, SurfaceReadbackRequestError> {
    // Surface readback is a bounded observer. Ordinary presentation still
    // must not allocate a staging buffer.
    if !requested {
        return Ok(None);
    }
    let pixel_order = pixel_order.ok_or(SurfaceReadbackRequestError::FormatUnsupported)?;
    let layout = xfb_readback_layout(width, height, height, 0)
        .ok_or(SurfaceReadbackRequestError::InvalidDimensions)?;
    Ok(Some((layout, pixel_order)))
}

pub(crate) fn compact_surface_readback_rows(
    mapped: &[u8],
    layout: XfbReadbackLayout,
    pixel_order: SurfacePixelOrder,
) -> Option<Vec<u8>> {
    let mut rgba = compact_xfb_readback_rows(mapped, layout)?;
    if pixel_order == SurfacePixelOrder::Bgra8 {
        for pixel in rgba.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
    }
    Some(rgba)
}

#[cfg(test)]
pub(crate) fn alpha_compare(value: u8, reference: u8, comparison: u8) -> bool {
    match comparison & 7 {
        0 => false,
        1 => value < reference,
        2 => value == reference,
        3 => value <= reference,
        4 => value > reference,
        5 => value != reference,
        6 => value >= reference,
        _ => true,
    }
}

#[cfg(test)]
pub(crate) fn alpha_test_passes(test: u32, value: u8) -> bool {
    let first = alpha_compare(value, test as u8, (test >> 16) as u8);
    let second = alpha_compare(value, (test >> 8) as u8, (test >> 19) as u8);
    match (test >> 22) & 3 {
        0 => first && second,
        1 => first || second,
        2 => first != second,
        _ => first == second,
    }
}

#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
pub use web::WebGpuRenderer;

#[cfg(test)]
mod tests {
    use super::{
        EFB_HEIGHT, EFB_WIDTH, GX_COPY_FILTER_DIVISOR, GX_DEPTH24_MAX, GxBlendFactor,
        GxBlendOperation, GxCopyClearMask, GxCopyGamma, GxEfbFormat, RendererFailureState,
        RendererMetrics, SelectedTexture, SurfacePixelOrder, SurfaceReadbackRequestError,
        TextureAddressMode, XfbCopyMetadata, alpha_compare, alpha_test_passes, clipped_copy_extent,
        compact_surface_readback_rows, compact_xfb_readback_rows, compact_xfb_scanout_rows,
        decoded_texture_cache_hit, decoded_texture_is_available, expand_5_to_8, expand_6_to_8,
        gx_blend_state, gx_copy_clear_mask, gx_copy_clear_rgba, gx_copy_filter_coefficients,
        gx_copy_filter_taps, gx_depth24_to_float, gx_efb_format, gx_float_to_depth24,
        gx_sampler_identity, gx_xfb_copy_parameters, gx_xfb_output_height,
        materialize_xfb_rgba8_reference, merge_contiguous_draw_range,
        requested_surface_readback_layout, require_tev_texture, resolve_xfb_copy,
        reusable_xfb_surface_index, select_texture, valid_rgba8_texture,
        xfb_copy_matches_selection, xfb_readback_layout, xfb_row_offset, xfb_scanout_plan,
        xfb_scanout_source_row, xfb_surface_extent_matches,
    };
    use crate::packet::GxCopyState;

    const BASE: u32 = 0x0120_0000;
    const STRIDE: u32 = 0x500;

    fn copy(destination: u32, generation: u32) -> XfbCopyMetadata {
        XfbCopyMetadata {
            destination,
            stride: STRIDE,
            height: 480,
            generation,
        }
    }

    fn copy_state(command_bits: u32, copy_scale: u32, filter_taps: [u8; 7]) -> GxCopyState {
        let filter0 = u32::from(filter_taps[0])
            | (u32::from(filter_taps[1]) << 6)
            | (u32::from(filter_taps[2]) << 12)
            | (u32::from(filter_taps[3]) << 18);
        let filter1 = u32::from(filter_taps[4])
            | (u32::from(filter_taps[5]) << 6)
            | (u32::from(filter_taps[6]) << 12);
        GxCopyState {
            z_mode: 0,
            blend_mode: 0,
            pixel_control: 0,
            copy_command: 0x4000 | command_bits,
            clear_rgba: [0; 4],
            clear_depth: 0,
            copy_scale,
            copy_filter: [filter0, filter1],
        }
    }

    fn rgba_rows(values: &[[u8; 4]]) -> Vec<u8> {
        values.iter().flatten().copied().collect()
    }

    fn fnv1a64(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    }

    #[test]
    fn smb_copy_filter_decodes_to_exact_three_row_fixed_point_weights() {
        let state = copy_state(3, 256, [8, 8, 10, 12, 10, 8, 8]);
        let parameters = gx_xfb_copy_parameters(state);

        assert_eq!(
            gx_copy_filter_taps(state.copy_filter),
            [8, 8, 10, 12, 10, 8, 8]
        );
        assert_eq!(parameters.filter_taps, [8, 8, 10, 12, 10, 8, 8]);
        assert_eq!(parameters.filter_coefficients, [16, 32, 16]);
        assert_eq!(
            gx_copy_filter_coefficients(parameters.filter_taps),
            [16, 32, 16]
        );
        assert_eq!(
            parameters.filter_coefficients.iter().sum::<u32>(),
            GX_COPY_FILTER_DIVISOR
        );
        assert_eq!(parameters.gamma, GxCopyGamma::Gamma1_0);
        assert!(parameters.clamp_top);
        assert!(parameters.clamp_bottom);
        assert!(!parameters.scale_invert);
        assert_eq!(
            gx_xfb_output_height(448, state.copy_command, state.copy_scale),
            Some(448)
        );
    }

    #[test]
    fn smb_seven_tap_reference_matches_the_vertical_impulse_oracle() {
        let efb = rgba_rows(&[
            [0, 0, 0, 1],
            [0, 0, 0, 2],
            [255, 128, 64, 3],
            [0, 0, 0, 4],
            [0, 0, 0, 5],
        ]);
        let output = materialize_xfb_rgba8_reference(
            &efb,
            1,
            5,
            0,
            1,
            1,
            3,
            1,
            copy_state(3, 256, [8, 8, 10, 12, 10, 8, 8]),
        )
        .unwrap();

        assert_eq!(output.width, 1);
        assert_eq!(output.height, 3);
        assert_eq!(
            output.pixels,
            rgba_rows(&[[63, 32, 16, 255], [127, 64, 32, 255], [63, 32, 16, 255],])
        );
    }

    #[test]
    fn every_programmed_filter_tap_maps_losslessly_to_its_hardware_source_row() {
        let efb = rgba_rows(&[[200, 200, 200, 1], [100, 100, 100, 2], [50, 50, 50, 3]]);
        for (tap, expected) in [100, 100, 50, 50, 50, 25, 25].into_iter().enumerate() {
            let mut taps = [0_u8; 7];
            taps[tap] = 32;
            let output = materialize_xfb_rgba8_reference(
                &efb,
                1,
                3,
                0,
                1,
                1,
                1,
                1,
                copy_state(0, 256, taps),
            )
            .unwrap();
            assert_eq!(
                output.pixels,
                [expected, expected, expected, 255],
                "tap {tap}"
            );
        }

        let asymmetric = materialize_xfb_rgba8_reference(
            &efb,
            1,
            3,
            0,
            1,
            1,
            1,
            1,
            copy_state(0, 256, [1, 2, 3, 4, 5, 6, 7]),
        )
        .unwrap();
        // (200 * (1 + 2) + 100 * (3 + 4 + 5) + 50 * (6 + 7)) / 64.
        assert_eq!(asymmetric.pixels, [38, 38, 38, 255]);
    }

    #[test]
    fn copy_filter_clamps_only_the_programmed_top_and_bottom_boundaries() {
        let efb = rgba_rows(&[
            [9, 0, 0, 1],
            [30, 0, 0, 2],
            [60, 0, 0, 3],
            [90, 0, 0, 4],
            [201, 0, 0, 5],
        ]);
        let render_red = |state| {
            materialize_xfb_rgba8_reference(&efb, 1, 5, 0, 1, 1, 3, 1, state)
                .unwrap()
                .pixels
                .chunks_exact(4)
                .map(|pixel| pixel[0])
                .collect::<Vec<_>>()
        };

        let preceding_row = [63, 1, 0, 0, 0, 0, 0];
        assert_eq!(render_red(copy_state(1, 256, preceding_row)), [30, 30, 60]);
        assert_eq!(render_red(copy_state(0, 256, preceding_row)), [9, 30, 60]);

        let following_row = [0, 0, 0, 0, 0, 63, 1];
        assert_eq!(render_red(copy_state(2, 256, following_row)), [60, 90, 90]);
        assert_eq!(render_red(copy_state(0, 256, following_row)), [60, 90, 201]);
    }

    #[test]
    fn xfb_y_scale_matches_transported_rounding_in_both_register_modes() {
        for (raw, expected) in [(0, 1), (255, 3), (256, 4), (384, 5), (512, 7)] {
            assert_eq!(gx_xfb_output_height(4, 0x4000, raw), Some(expected));
        }
        for (raw, expected) in [(0, 769), (128, 7), (256, 4), (384, 3), (512, 2)] {
            assert_eq!(
                gx_xfb_output_height(4, 0x4000 | (1 << 10), raw),
                Some(expected)
            );
        }
        assert_eq!(gx_xfb_output_height(0, 0x4000, 256), None);
        assert_eq!(gx_xfb_output_height(1024, 0x4000, 0), Some(1));
        assert_eq!(gx_xfb_output_height(1024, 0x4000, u32::MAX), Some(1024));
        assert_eq!(
            gx_xfb_output_height(1024, 0x4000 | (1 << 10), u32::MAX),
            Some(1)
        );
        // Exact fixed-point evaluation must not lose one line to floating-point
        // operation order: 147 * 256 / 49 is exactly 768 intervals.
        assert_eq!(gx_xfb_output_height(148, 0x4000 | (1 << 10), 49), Some(769));
        assert_eq!(
            gx_xfb_output_height(1024, 0x4000 | (1 << 10), 256),
            Some(1024)
        );
        assert_eq!(
            gx_xfb_output_height(1024, 0x4000 | (1 << 10), 1),
            Some(1024),
            "legitimate extreme scales saturate at the GX/libogc line bound"
        );

        assert!(!gx_xfb_copy_parameters(copy_state(0, 255, [0; 7])).uses_linear_filter());
        assert!(!gx_xfb_copy_parameters(copy_state(0, 256, [0; 7])).uses_linear_filter());
        assert!(gx_xfb_copy_parameters(copy_state(0, 257, [0; 7])).uses_linear_filter());
        assert!(gx_xfb_copy_parameters(copy_state(1 << 10, 255, [0; 7])).uses_linear_filter());
        assert!(gx_xfb_copy_parameters(copy_state(1 << 10, 0, [0; 7])).uses_linear_filter());
        assert!(!gx_xfb_copy_parameters(copy_state(1 << 10, 256, [0; 7])).uses_linear_filter());
    }

    #[test]
    fn inverse_y_scale_uses_bp_sample_spacing_instead_of_rounded_output_ratio() {
        let efb = rgba_rows(&[
            [0, 0, 0, 1],
            [64, 64, 64, 2],
            [128, 128, 128, 3],
            [192, 192, 192, 4],
        ]);
        let output = materialize_xfb_rgba8_reference(
            &efb,
            1,
            4,
            0,
            0,
            1,
            4,
            1,
            copy_state(3 | (1 << 10), 128, [0, 0, 21, 22, 21, 0, 0]),
        )
        .unwrap();

        assert_eq!(output.height, 7);
        assert_eq!(
            output
                .pixels
                .chunks_exact(4)
                .map(|pixel| pixel[0])
                .collect::<Vec<_>>(),
            [0, 16, 48, 80, 112, 144, 176]
        );
    }

    #[test]
    fn native_efb_color_quantization_precedes_filter_and_xfb_is_always_opaque() {
        let efb = rgba_rows(&[[127, 127, 127, 37]]);
        let render = |pixel_control, filter_taps| {
            let mut state = copy_state(0, 256, filter_taps);
            state.pixel_control = pixel_control;
            materialize_xfb_rgba8_reference(&efb, 1, 1, 0, 0, 1, 1, 1, state)
                .map(|output| output.pixels)
        };
        let identity = [0, 0, 21, 22, 21, 0, 0];
        let half_brightness = [0, 0, 10, 12, 10, 0, 0];

        assert_eq!(render(0, identity).unwrap(), [127, 127, 127, 255]);
        assert_eq!(render(1, identity).unwrap(), [125, 125, 125, 255]);
        assert_eq!(render(2, identity).unwrap(), [123, 125, 123, 255]);
        assert_eq!(render(1, half_brightness).unwrap(), [62, 62, 62, 255]);
        assert_eq!(render(2, half_brightness).unwrap(), [61, 62, 61, 255]);
        for unsupported in 3..=7 {
            assert_eq!(
                render(unsupported, identity),
                None,
                "raw EFB format {unsupported}"
            );
        }
    }

    #[test]
    fn native_efb_quantization_rounds_linear_half_ties_to_even() {
        let efb = rgba_rows(&[[63, 63, 63, 1], [64, 64, 64, 2]]);
        let render = |pixel_control| {
            let mut state = copy_state(3, 512, [0, 0, 21, 22, 21, 0, 0]);
            state.pixel_control = pixel_control;
            materialize_xfb_rgba8_reference(&efb, 2, 1, 0, 0, 2, 1, 1, state)
                .unwrap()
                .pixels
        };

        // Linear sampling produces 63.5. RGB8 truncates, while the native
        // reduced-color paths use round-to-even before bit replication.
        assert_eq!(render(0), [63, 63, 63, 255]);
        assert_eq!(render(1), [65, 65, 65, 255]);
        assert_eq!(render(2), [66, 65, 66, 255]);
    }

    #[test]
    fn gamma_variants_and_native_efb_format_change_only_the_documented_channels() {
        let efb = rgba_rows(&[[64, 128, 192, 37]]);
        let render = |command_bits, pixel_control| {
            let mut state = copy_state(command_bits, 256, [0, 0, 21, 22, 21, 0, 0]);
            state.pixel_control = pixel_control;
            materialize_xfb_rgba8_reference(&efb, 1, 1, 0, 0, 1, 1, 1, state)
                .unwrap()
                .pixels
        };

        assert_eq!(render(0, 0), [64, 128, 192, 255]);
        assert_eq!(render(1 << 7, 0), [113, 170, 216, 255]);
        assert_eq!(render(2 << 7, 0), [136, 186, 224, 255]);
        assert_eq!(render(3 << 7, 0), [136, 186, 224, 255]);
        assert_eq!(render(0, 1), [65, 130, 195, 255]);
    }

    #[test]
    fn filter_scale_clamp_and_gamma_each_change_materialized_xfb_evidence() {
        let efb = rgba_rows(&[
            [220, 30, 80, 1],
            [32, 64, 96, 2],
            [128, 160, 192, 3],
            [16, 48, 80, 4],
            [240, 200, 160, 5],
        ]);
        let smb = copy_state(3, 256, [8, 8, 10, 12, 10, 8, 8]);
        let identity = copy_state(3, 256, [0, 0, 21, 22, 21, 0, 0]);
        let unclamped = copy_state(0, 256, [8, 8, 10, 12, 10, 8, 8]);
        let gamma_2_2 = copy_state(3 | (2 << 7), 256, [8, 8, 10, 12, 10, 8, 8]);
        let scaled = copy_state(3, 512, [8, 8, 10, 12, 10, 8, 8]);
        let render =
            |state| materialize_xfb_rgba8_reference(&efb, 1, 5, 0, 1, 1, 3, 1, state).unwrap();

        let baseline = render(smb);
        let variants = [
            render(identity),
            render(unclamped),
            render(gamma_2_2),
            render(scaled),
        ];
        let baseline_hash = fnv1a64(&baseline.pixels);
        for variant in variants {
            assert_ne!(fnv1a64(&variant.pixels), baseline_hash);
        }
        assert_eq!(baseline.height, 3);
        assert_eq!(render(scaled).height, 5);
        assert_eq!(
            gx_xfb_copy_parameters(gamma_2_2).gamma,
            GxCopyGamma::Gamma2_2
        );
    }

    #[test]
    fn renderer_metrics_accumulate_exact_draw_transport_bytes() {
        let mut metrics = RendererMetrics::default();
        metrics.record_draw_transport(576, 464, 160, 4096, 864);
        metrics.record_draw_transport(288, 464, 160, 0, 432);

        assert_eq!(metrics.push_tev_draw_calls, 2);
        assert_eq!(metrics.source_vertex_bytes, 864);
        assert_eq!(metrics.tev_state_bytes, 928);
        assert_eq!(metrics.texture_metadata_bytes, 320);
        assert_eq!(metrics.texture_pixel_bytes, 4096);
        assert_eq!(metrics.expanded_vertex_bytes, 1296);
    }

    #[test]
    fn renderer_metrics_count_actual_bridge_calls_and_packet_bytes_separately() {
        let mut metrics = RendererMetrics::default();
        metrics.record_wasm_bridge_call(1920);
        metrics.record_wasm_bridge_call(0);
        metrics.record_wasm_bridge_call(0);

        assert_eq!(metrics.wasm_bridge_calls, 3);
        assert_eq!(metrics.wasm_bridge_typed_array_bytes, 1920);
        assert_eq!(metrics.push_tev_draw_calls, 0);
        assert_eq!(metrics.texture_pixel_bytes, 0);
    }

    #[test]
    fn xfb_rows_resolve_top_and_bottom_field_addresses() {
        let metadata = copy(BASE, 7);
        assert_eq!(xfb_row_offset(metadata, BASE), Some(0));
        assert_eq!(xfb_row_offset(metadata, BASE + STRIDE), Some(1));
        assert_eq!(
            xfb_row_offset(metadata, BASE + STRIDE * metadata.height),
            None
        );
    }

    #[test]
    fn exact_xfb_destination_wins_over_an_older_copy_alias() {
        let copies = [copy(BASE, 9), copy(BASE + STRIDE, 3)];
        assert_eq!(resolve_xfb_copy(&copies, BASE + STRIDE), Some((1, 0)));
    }

    #[test]
    fn vi_can_switch_between_retained_double_buffers() {
        let second = BASE + STRIDE * 480;
        let copies = [copy(BASE, 10), copy(second, 11)];
        assert_eq!(resolve_xfb_copy(&copies, BASE), Some((0, 0)));
        assert_eq!(resolve_xfb_copy(&copies, BASE + STRIDE), Some((0, 1)));
        assert_eq!(resolve_xfb_copy(&copies, second), Some((1, 0)));
        assert_eq!(resolve_xfb_copy(&copies, second + STRIDE), Some((1, 1)));
    }

    #[test]
    fn vi_rejects_deep_row_aliases_between_retained_double_buffers() {
        const SMB_HEIGHT: u32 = 448;
        let copies = [XfbCopyMetadata {
            destination: 0x0030_7180,
            stride: STRIDE,
            height: SMB_HEIGHT,
            generation: 12,
        }];

        assert_eq!(0x0039_2c80 - 0x0030_7180, (SMB_HEIGHT - 1) * STRIDE);
        assert_eq!(resolve_xfb_copy(&copies, 0x0039_2c80), None);
    }

    #[test]
    fn xfb_presentation_requires_the_worker_selected_generation_and_field_row() {
        let copy = copy(BASE, 12);
        assert!(xfb_copy_matches_selection(copy, BASE, 12, 0));
        assert!(xfb_copy_matches_selection(copy, BASE + STRIDE, 12, 1));
        assert!(!xfb_copy_matches_selection(copy, BASE, 11, 0));
        assert!(!xfb_copy_matches_selection(copy, BASE, 0, 0));
        assert!(!xfb_copy_matches_selection(copy, BASE + STRIDE, 12, 0));
        assert!(!xfb_copy_matches_selection(copy, BASE + STRIDE * 2, 12, 2));
    }

    #[test]
    fn xfb_surface_reuse_requires_an_exact_copy_extent() {
        assert!(xfb_surface_extent_matches(640, 448, 640, 448));
        assert!(!xfb_surface_extent_matches(640, 448, 608, 448));
        assert!(!xfb_surface_extent_matches(640, 448, 640, 480));
    }

    #[test]
    fn xfb_surface_reuse_preserves_the_last_presented_surface() {
        let surfaces = [(41, 640, 448), (42, 640, 448)];
        assert_eq!(
            reusable_xfb_surface_index(&surfaces, Some(41), 640, 448),
            Some(1)
        );
        assert_eq!(
            reusable_xfb_surface_index(&surfaces, Some(42), 640, 448),
            Some(0)
        );
        assert_eq!(
            reusable_xfb_surface_index(&surfaces, None, 640, 448),
            Some(0)
        );
        assert_eq!(
            reusable_xfb_surface_index(&surfaces, Some(41), 608, 448),
            None
        );
        let mismatched_spare = [(41, 640, 448), (42, 608, 448)];
        assert_eq!(
            reusable_xfb_surface_index(&mismatched_spare, Some(41), 640, 448),
            None
        );
        assert_eq!(
            reusable_xfb_surface_index(&mismatched_spare, Some(41), 608, 448),
            Some(1)
        );
    }

    #[test]
    fn vi_bob_scanout_selects_and_repeats_exact_integer_field_rows() {
        let metadata = XfbCopyMetadata {
            destination: BASE,
            stride: STRIDE,
            height: 4,
            generation: 1,
        };
        let top = xfb_scanout_plan(metadata, 0, STRIDE * 2, 2, 2, 4).unwrap();
        let bottom = xfb_scanout_plan(metadata, 1, STRIDE * 2, 2, 2, 4).unwrap();
        assert_eq!(top.source_row_step, 2);
        assert_eq!(bottom.source_row_step, 2);
        assert_eq!(
            (0..4)
                .map(|row| xfb_scanout_source_row(top, row).unwrap())
                .collect::<Vec<_>>(),
            [0, 0, 2, 2]
        );
        assert_eq!(
            (0..4)
                .map(|row| xfb_scanout_source_row(bottom, row).unwrap())
                .collect::<Vec<_>>(),
            [1, 1, 3, 3]
        );
        assert_eq!(xfb_scanout_source_row(top, 4), None);
    }

    #[test]
    fn smb_vi_bob_plan_covers_each_field_without_cropping_or_stretching() {
        let metadata = XfbCopyMetadata {
            destination: 0x0030_6c80,
            stride: STRIDE,
            height: 448,
            generation: 1,
        };
        let top = xfb_scanout_plan(metadata, 0, 0x0a00, 224, 2, 448).unwrap();
        let bottom = xfb_scanout_plan(metadata, 1, 0x0a00, 224, 2, 448).unwrap();
        assert_eq!(xfb_scanout_source_row(top, 447), Some(446));
        assert_eq!(xfb_scanout_source_row(bottom, 447), Some(447));

        assert_eq!(xfb_scanout_plan(metadata, 1, STRIDE, 448, 1, 448), None);
        assert_eq!(xfb_scanout_plan(metadata, 0, 0x0a00, 224, 1, 448), None);
        assert_eq!(xfb_scanout_plan(metadata, 0, 0x0a01, 224, 2, 448), None);
    }

    #[test]
    fn progressive_vi_scanout_uses_each_source_row_once() {
        let metadata = XfbCopyMetadata {
            destination: BASE,
            stride: STRIDE,
            height: 4,
            generation: 1,
        };
        let plan = xfb_scanout_plan(metadata, 0, STRIDE, 4, 1, 4).unwrap();
        assert_eq!(
            (0..4)
                .map(|row| xfb_scanout_source_row(plan, row).unwrap())
                .collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
    }

    #[test]
    fn xfb_scanout_readback_obeys_the_four_row_bob_oracle() {
        let metadata = XfbCopyMetadata {
            destination: BASE,
            stride: STRIDE,
            height: 4,
            generation: 1,
        };
        let layout = xfb_readback_layout(1, 4, 4, 0).unwrap();
        let mut mapped = vec![0xcc; usize::try_from(layout.buffer_bytes).unwrap()];
        for row in 0..4_usize {
            let offset = row * usize::try_from(layout.padded_bytes_per_row).unwrap();
            mapped[offset..offset + 4].copy_from_slice(&[row as u8, 0, 0, 255]);
        }
        let top = xfb_scanout_plan(metadata, 0, STRIDE * 2, 2, 2, 4).unwrap();
        let bottom = xfb_scanout_plan(metadata, 1, STRIDE * 2, 2, 2, 4).unwrap();
        assert_eq!(
            compact_xfb_scanout_rows(&mapped, layout, 4, top).unwrap(),
            rgba_rows(&[
                [0, 0, 0, 255],
                [0, 0, 0, 255],
                [2, 0, 0, 255],
                [2, 0, 0, 255],
            ])
        );
        assert_eq!(
            compact_xfb_scanout_rows(&mapped, layout, 4, bottom).unwrap(),
            rgba_rows(&[
                [1, 0, 0, 255],
                [1, 0, 0, 255],
                [3, 0, 0, 255],
                [3, 0, 0, 255],
            ])
        );
    }

    #[test]
    fn xfb_readback_layout_crops_the_selected_field_row_and_aligns_webgpu_copies() {
        let aligned = xfb_readback_layout(640, 480, 480, 1).unwrap();
        assert_eq!(aligned.width, 640);
        assert_eq!(aligned.height, 479);
        assert_eq!(aligned.source_row, 1);
        assert_eq!(aligned.bytes_per_row, 2560);
        assert_eq!(aligned.padded_bytes_per_row, 2560);
        assert_eq!(aligned.buffer_bytes, 1_226_240);

        let padded = xfb_readback_layout(641, 2, 2, 0).unwrap();
        assert_eq!(padded.bytes_per_row, 2564);
        assert_eq!(padded.padded_bytes_per_row, 2816);
        assert_eq!(padded.buffer_bytes, 5632);
        assert_eq!(xfb_readback_layout(0, 480, 480, 0), None);
        assert_eq!(xfb_readback_layout(640, 480, 480, 480), None);
        assert_eq!(xfb_readback_layout(u32::MAX, 1, 1, 0), None);
    }

    #[test]
    fn xfb_readback_maps_logical_field_rows_into_scaled_physical_copies() {
        let layout = xfb_readback_layout(640, 264, 528, 1).unwrap();
        assert_eq!(layout.source_row, 0);
        assert_eq!(layout.height, 264);

        let layout = xfb_readback_layout(640, 960, 480, 1).unwrap();
        assert_eq!(layout.source_row, 2);
        assert_eq!(layout.height, 958);
    }

    #[test]
    fn xfb_readback_compacts_webgpu_row_padding_without_changing_pixels() {
        let layout = xfb_readback_layout(2, 2, 2, 0).unwrap();
        let mut mapped = vec![0xcc; usize::try_from(layout.buffer_bytes).unwrap()];
        mapped[0..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let second = usize::try_from(layout.padded_bytes_per_row).unwrap();
        mapped[second..second + 8].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);
        assert_eq!(
            compact_xfb_readback_rows(&mapped, layout).unwrap(),
            (1_u8..=16).collect::<Vec<_>>()
        );
        assert_eq!(compact_xfb_readback_rows(&mapped[..second], layout), None);
    }

    #[test]
    fn surface_readback_is_opt_in_and_validates_requested_captures() {
        assert_eq!(
            requested_surface_readback_layout(false, None, 0, 0),
            Ok(None),
        );
        assert_eq!(
            requested_surface_readback_layout(true, None, 640, 480),
            Err(SurfaceReadbackRequestError::FormatUnsupported),
        );
        assert_eq!(
            requested_surface_readback_layout(true, Some(SurfacePixelOrder::Rgba8), 0, 480,),
            Err(SurfaceReadbackRequestError::InvalidDimensions),
        );

        let (layout, order) =
            requested_surface_readback_layout(true, Some(SurfacePixelOrder::Bgra8), 641, 2)
                .unwrap()
                .unwrap();
        assert_eq!(order, SurfacePixelOrder::Bgra8);
        assert_eq!(layout.bytes_per_row, 2564);
        assert_eq!(layout.padded_bytes_per_row, 2816);
    }

    #[test]
    fn surface_readback_compacts_rows_and_canonicalizes_bgra_to_rgba() {
        let (layout, _) =
            requested_surface_readback_layout(true, Some(SurfacePixelOrder::Rgba8), 2, 2)
                .unwrap()
                .unwrap();
        let mut mapped = vec![0xcc; usize::try_from(layout.buffer_bytes).unwrap()];
        mapped[0..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let second = usize::try_from(layout.padded_bytes_per_row).unwrap();
        mapped[second..second + 8].copy_from_slice(&[9, 10, 11, 12, 13, 14, 15, 16]);

        assert_eq!(
            compact_surface_readback_rows(&mapped, layout, SurfacePixelOrder::Rgba8).unwrap(),
            (1_u8..=16).collect::<Vec<_>>(),
        );
        assert_eq!(
            compact_surface_readback_rows(&mapped, layout, SurfacePixelOrder::Bgra8).unwrap(),
            vec![3, 2, 1, 4, 7, 6, 5, 8, 11, 10, 9, 12, 15, 14, 13, 16],
        );
        assert_eq!(
            compact_surface_readback_rows(&mapped[..second], layout, SurfacePixelOrder::Rgba8,),
            None,
        );
    }

    #[test]
    fn gx_alpha_comparisons_match_the_eight_hardware_operations() {
        let cases = [false, false, true, true, false, false, true, true];
        for (comparison, expected) in cases.into_iter().enumerate() {
            assert_eq!(
                alpha_compare(12, 12, comparison as u8),
                expected,
                "comparison {comparison}"
            );
        }
        assert!(alpha_compare(11, 12, 1));
        assert!(alpha_compare(13, 12, 4));
        assert!(alpha_compare(13, 12, 5));
    }

    #[test]
    fn gx_alpha_test_combines_comparisons_with_each_logic_operation() {
        let encode = |first: u8, second: u8, logic: u8| {
            u32::from(first) << 16 | u32::from(second) << 19 | u32::from(logic) << 22
        };
        assert!(!alpha_test_passes(encode(7, 0, 0), 255));
        assert!(alpha_test_passes(encode(7, 0, 1), 255));
        assert!(alpha_test_passes(encode(7, 0, 2), 255));
        assert!(!alpha_test_passes(encode(7, 0, 3), 255));
    }

    #[test]
    fn required_tev_textures_never_silently_fall_back_to_white() {
        let failure = require_tev_texture(5, true, SelectedTexture::White).unwrap_err();
        assert!(failure.contains("TEV texture map 5 is enabled"));
        assert!(failure.contains("matching EFB generation"));
        assert_eq!(
            require_tev_texture(5, false, SelectedTexture::White),
            Ok(SelectedTexture::White)
        );
        assert_eq!(
            require_tev_texture(5, true, SelectedTexture::Decoded),
            Ok(SelectedTexture::Decoded)
        );
        assert_eq!(
            require_tev_texture(5, true, SelectedTexture::EfbCopy),
            Ok(SelectedTexture::EfbCopy)
        );
    }

    #[test]
    fn consecutive_draw_ranges_merge_only_when_state_and_boundaries_match() {
        let state = (7_u8, 12_u8);
        let mut range = 0..6;
        assert!(merge_contiguous_draw_range(
            &mut range,
            &state,
            6..12,
            &state
        ));
        assert_eq!(range, 0..12);

        assert!(!merge_contiguous_draw_range(
            &mut range,
            &state,
            15..18,
            &state
        ));
        assert!(!merge_contiguous_draw_range(
            &mut range,
            &state,
            12..18,
            &(7, 13)
        ));
        assert_eq!(range, 0..12);
    }

    #[test]
    fn efb_generation_miss_prefers_valid_decoded_pixels_over_white() {
        assert_eq!(select_texture(8, Some(7), true), SelectedTexture::Decoded);
        assert_eq!(select_texture(8, None, true), SelectedTexture::Decoded);
        assert_eq!(select_texture(8, None, false), SelectedTexture::White);
        assert_eq!(select_texture(8, Some(8), true), SelectedTexture::EfbCopy);
    }

    #[test]
    fn decoded_rgba8_pixels_must_exactly_cover_a_nonempty_texture() {
        assert!(valid_rgba8_texture(4, 3, 48));
        assert!(!valid_rgba8_texture(4, 3, 47));
        assert!(!valid_rgba8_texture(4, 3, 49));
        assert!(!valid_rgba8_texture(0, 3, 0));
        assert!(!valid_rgba8_texture(4, 0, 0));
    }

    #[test]
    fn decoded_texture_cache_hits_can_omit_the_rgba8_payload() {
        assert_eq!(
            decoded_texture_is_available(4, 3, 0, Some((4, 3))),
            Ok(true)
        );
        assert_eq!(decoded_texture_is_available(4, 3, 0, None), Ok(false));
        assert_eq!(decoded_texture_is_available(4, 3, 48, None), Ok(true));
    }

    #[test]
    fn decoded_texture_cache_queries_match_both_dimensions() {
        assert!(decoded_texture_cache_hit(4, 3, Some((4, 3))));
        assert!(!decoded_texture_cache_hit(4, 3, Some((3, 4))));
        assert!(!decoded_texture_cache_hit(4, 3, None));
    }

    #[test]
    fn decoded_texture_cache_keys_have_immutable_dimensions() {
        let failure = decoded_texture_is_available(4, 3, 0, Some((3, 4))).unwrap_err();
        assert!(failure.contains("cached RGBA8 texture is 3x4"));
        assert!(failure.contains("draw requests 4x3"));
    }

    #[test]
    fn gx_sampler_state_preserves_filter_and_both_wrap_modes() {
        let sampler = gx_sampler_identity(1 | (2 << 2) | (1 << 4) | (1 << 7));
        assert!(sampler.mag_filter);
        assert!(sampler.min_filter);
        assert_eq!(sampler.address_u, TextureAddressMode::Repeat);
        assert_eq!(sampler.address_v, TextureAddressMode::MirrorRepeat);

        let reserved = gx_sampler_identity(3 | (3 << 2));
        assert!(!reserved.mag_filter);
        assert!(!reserved.min_filter);
        assert_eq!(reserved.address_u, TextureAddressMode::ClampToEdge);
        assert_eq!(reserved.address_v, TextureAddressMode::ClampToEdge);
    }

    #[test]
    fn malformed_redundant_texture_payloads_are_rejected() {
        let failure = decoded_texture_is_available(4, 3, 47, Some((4, 3))).unwrap_err();
        assert!(failure.contains("expected 48 bytes, got 47"));
    }

    #[test]
    fn efb_copy_extent_clips_at_edges_and_rejects_empty_or_invalid_origins() {
        assert_eq!(clipped_copy_extent(639, 527, 8, 8), Some((1, 1)));
        assert_eq!(
            clipped_copy_extent(0, 0, EFB_WIDTH, EFB_HEIGHT),
            Some((640, 528))
        );
        assert_eq!(clipped_copy_extent(EFB_WIDTH, 0, 1, 1), None);
        assert_eq!(clipped_copy_extent(0, EFB_HEIGHT, 1, 1), None);
        assert_eq!(clipped_copy_extent(EFB_WIDTH + 1, 0, 1, 1), None);
        assert_eq!(clipped_copy_extent(0, EFB_HEIGHT + 1, 1, 1), None);
        assert_eq!(clipped_copy_extent(0, 0, 0, 1), None);
        assert_eq!(clipped_copy_extent(0, 0, 1, 0), None);
    }

    #[test]
    fn gx_copy_clear_masks_decode_independent_color_alpha_and_depth_updates() {
        for index in 0..8 {
            let expected = GxCopyClearMask::from_index(index);
            let z_mode = u32::from(expected.depth) << 4;
            let blend_mode = (u32::from(expected.color) << 3) | (u32::from(expected.alpha) << 4);
            let actual = gx_copy_clear_mask(z_mode, blend_mode, 1);
            assert_eq!(actual, expected);
            assert_eq!(actual.index(), index);
            assert_eq!(actual.writes_anything(), index != 0);
        }

        assert_eq!(
            gx_copy_clear_mask(1 << 4, 0, 1),
            GxCopyClearMask {
                color: false,
                alpha: false,
                depth: true,
            },
            "depth updates must not depend on the depth-test enable bit",
        );
    }

    #[test]
    fn no_alpha_efb_clears_ignore_alpha_only_work_and_canonicalize_real_work() {
        for pixel_control in [0, 2, 3, 4, 5, 6, 7] {
            assert_eq!(
                gx_copy_clear_mask(0, 1 << 4, pixel_control),
                GxCopyClearMask {
                    color: false,
                    alpha: false,
                    depth: false,
                },
                "format {pixel_control} alpha-only clear must remain a no-op",
            );
            assert_eq!(
                gx_copy_clear_mask(0, 1 << 3, pixel_control),
                GxCopyClearMask {
                    color: true,
                    alpha: true,
                    depth: false,
                },
                "format {pixel_control} color clear must restore opaque host alpha",
            );
            assert_eq!(
                gx_copy_clear_mask(1 << 4, 0, pixel_control),
                GxCopyClearMask {
                    color: false,
                    alpha: true,
                    depth: true,
                },
                "format {pixel_control} depth clear must restore opaque host alpha",
            );
        }
    }

    #[test]
    fn transported_pixel_control_classifies_only_observable_efb_formats() {
        let expected = [
            GxEfbFormat::Rgb8Z24,
            GxEfbFormat::Rgba6Z24,
            GxEfbFormat::Rgb565Z16,
            GxEfbFormat::Z24,
            GxEfbFormat::OtherNoAlpha,
            GxEfbFormat::OtherNoAlpha,
            GxEfbFormat::OtherNoAlpha,
            GxEfbFormat::OtherNoAlpha,
        ];
        for (raw, expected) in expected.into_iter().enumerate() {
            assert_eq!(gx_efb_format(raw as u32), expected);
            assert_eq!(gx_efb_format(0x00ff_ff00 | raw as u32), expected);
        }
    }

    #[test]
    fn copy_clear_quantizes_rgba6_and_rgb565_color_without_changing_depth() {
        let rgba = [0x81, 0x92, 0xa3, 0xd4];
        assert_eq!(gx_copy_clear_rgba(0, rgba), [0x81, 0x92, 0xa3, 0xff]);
        assert_eq!(gx_copy_clear_rgba(1, rgba), [0x82, 0x92, 0xa2, 0xd7]);
        assert_eq!(gx_copy_clear_rgba(2, rgba), [0x84, 0x92, 0xa5, 0xff]);
        assert_eq!(gx_copy_clear_rgba(3, rgba), [0x81, 0x92, 0xa3, 0xff]);
        for format in 4..=7 {
            assert_eq!(gx_copy_clear_rgba(format, rgba)[3], 0xff);
        }

        for channel in 0..=u8::MAX {
            let five = expand_5_to_8(channel);
            let six = expand_6_to_8(channel);
            assert_eq!(five >> 3, channel >> 3);
            assert_eq!(five & 7, five >> 5);
            assert_eq!(six >> 2, channel >> 2);
            assert_eq!(six & 3, six >> 6);
        }
    }

    #[test]
    fn gx_depth_uses_the_full_unsigned_twenty_four_bit_range() {
        assert_eq!(gx_depth24_to_float(0), 0.0);
        assert_eq!(gx_depth24_to_float(GX_DEPTH24_MAX), 1.0);
        assert_eq!(gx_float_to_depth24(1.0), GX_DEPTH24_MAX);
        for depth in [0, 1, 0x12_3456, 0x44_5566, 0xab_cdef, 0xff_fffe, 0xff_ffff] {
            assert_eq!(gx_float_to_depth24(gx_depth24_to_float(depth)), depth);
        }
    }

    #[test]
    fn logic_op_without_ordinary_blending_still_enables_its_approximation() {
        let state = gx_blend_state((1 << 1) | (0x6 << 12) | (1 << 3) | (1 << 4));
        assert!(state.enabled);
        assert_eq!(state.source, GxBlendFactor::OneMinusDestination);
        assert_eq!(state.destination, GxBlendFactor::OneMinusSource);
        assert_eq!(state.operation, GxBlendOperation::Add);
        assert!(state.color_write);
        assert!(state.alpha_write);
    }

    #[test]
    fn every_logic_approximation_uses_a_webgpu_legal_add_operation() {
        for logic_operation in 0..=0xf {
            let state = gx_blend_state((1 << 1) | (logic_operation << 12));
            assert!(state.enabled, "logic operation {logic_operation:#x}");
            assert_eq!(
                state.operation,
                GxBlendOperation::Add,
                "logic operation {logic_operation:#x}"
            );
        }
    }

    #[test]
    fn renderer_failure_state_preserves_the_first_device_error() {
        let state = RendererFailureState::default();
        let callback = state.clone();
        callback.record("WebGPU device lost: adapter reset".to_owned());
        state.record("uncaptured WebGPU validation error".to_owned());

        assert_eq!(
            state.failure().as_deref(),
            Some("WebGPU device lost: adapter reset")
        );
    }
}
