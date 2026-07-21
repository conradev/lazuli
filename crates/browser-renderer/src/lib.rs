#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use std::ops::Range;
use std::sync::{Arc, Mutex};

pub(crate) mod tev;

pub(crate) const EFB_WIDTH: u32 = 640;
pub(crate) const EFB_HEIGHT: u32 = 528;
pub(crate) const WEBGPU_COPY_BYTES_PER_ROW_ALIGNMENT: u32 = 256;

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
}

impl RendererMetrics {
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

    // The VI framebuffer address can select a scanline within a retained GX
    // copy (BFBL commonly selects row one). Crop away preceding rows while
    // keeping the rectangle inside the cached copy's normalized bounds.
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
        EFB_HEIGHT, EFB_WIDTH, GxBlendFactor, GxBlendOperation, RendererFailureState,
        RendererMetrics, SelectedTexture, TextureAddressMode, XfbCopyMetadata, alpha_compare,
        alpha_test_passes, clipped_copy_extent, compact_xfb_readback_rows,
        decoded_texture_cache_hit, decoded_texture_is_available, gx_blend_state,
        gx_sampler_identity, merge_contiguous_draw_range, require_tev_texture, resolve_xfb_copy,
        select_texture, valid_rgba8_texture, xfb_copy_matches_selection, xfb_readback_layout,
        xfb_row_offset, xfb_source_rect,
    };

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
        assert_eq!(xfb_source_rect(SMB_HEIGHT - 1, SMB_HEIGHT), None);
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
    fn xfb_source_rect_starts_at_the_selected_vi_row() {
        let assert_rect = |actual: [f32; 4], expected: [f32; 4]| {
            for (actual, expected) in actual.into_iter().zip(expected) {
                assert!((actual - expected).abs() < f32::EPSILON);
            }
        };
        assert_rect(xfb_source_rect(0, 480).unwrap(), [0.0, 0.0, 1.0, 1.0]);

        let bottom = xfb_source_rect(1, 480).unwrap();
        assert_rect(bottom, [0.0, 1.0 / 480.0, 1.0, 479.0 / 480.0]);

        assert_eq!(xfb_source_rect(479, 480), None);
    }

    #[test]
    fn xfb_source_rect_rejects_rows_outside_the_copy() {
        assert_eq!(xfb_source_rect(0, 0), None);
        assert_eq!(xfb_source_rect(480, 480), None);
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
